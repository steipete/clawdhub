import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { action, internalAction, internalMutation, internalQuery } from "./functions";
import { reusableAigAnalysis } from "./lib/aigAnalysis";
import { manualPackageRecovery } from "./lib/packagePublishRecovery";
import { finalizeSkillPublishAttempt } from "./lib/skillPublish";
import { requestPublishAttemptDispatch } from "./publishAttemptDispatch";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const CHECK_CLAIM_LEASE_MS = 30 * 60 * 1000;
const CHECK_RETRY_BACKOFF_MS = 5 * 60 * 1000;
const MAX_CONSECUTIVE_SCANNER_FAILURES = 3;
const FINALIZATION_CLAIM_LEASE_MS = 10 * 60 * 1000;
const MISSING_AIG_EVIDENCE_ERROR = "A.I.G evidence is required before a skill can be published.";
const ACTIVE_CLAIM_OUTCOME = { outcome: "active_claim" as const };
const PUBLISH_ATTEMPT_STATUSES = [
  "pending_checks",
  "ready_to_finalize",
  "finalizing",
  "finalized",
  "blocked",
  "failed",
  "expired",
] as const;
export const ACTIVE_PUBLISH_ATTEMPT_STATUSES = PUBLISH_ATTEMPT_STATUSES.slice(0, 3);

const publishResultValidator = v.object({
  skillId: v.id("skills"),
  versionId: v.id("skillVersions"),
  embeddingId: v.optional(v.id("skillEmbeddings")),
  status: v.optional(v.union(v.literal("pending"), v.literal("published"))),
  slug: v.optional(v.string()),
  version: v.optional(v.string()),
  publicationStatus: v.optional(v.union(v.literal("pending"), v.literal("published"))),
  attemptId: v.optional(v.id("publishAttempts")),
});

const packagePublishResultValidator = v.object({
  ok: v.boolean(),
  packageId: v.id("packages"),
  releaseId: v.id("packageReleases"),
});

const workerCheckResultValidator = v.object({
  status: v.union(v.literal("clean"), v.literal("blocked"), v.literal("failed")),
  summary: v.optional(v.string()),
  redactedFindings: v.optional(v.array(v.string())),
});

const workerLlmAnalysisValidator = v.object({
  status: v.string(),
  verdict: v.optional(v.string()),
  confidence: v.optional(v.string()),
  summary: v.optional(v.string()),
  dimensions: v.optional(
    v.array(
      v.object({
        name: v.string(),
        label: v.string(),
        rating: v.string(),
        detail: v.string(),
      }),
    ),
  ),
  guidance: v.optional(v.string()),
  findings: v.optional(v.string()),
  model: v.optional(v.string()),
  checkedAt: v.number(),
});

const workerAigAnalysisValidator = v.object({
  status: v.string(),
  issueCount: v.number(),
  findings: v.array(
    v.object({
      ruleId: v.string(),
      level: v.string(),
      message: v.string(),
      title: v.optional(v.string()),
      description: v.optional(v.string()),
      file: v.optional(v.string()),
      startLine: v.optional(v.number()),
      endLine: v.optional(v.number()),
      remediation: v.optional(v.string()),
    }),
  ),
  scannerVersion: v.optional(v.string()),
  summary: v.optional(v.string()),
  error: v.optional(v.string()),
  checkedAt: v.number(),
});

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function withoutUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as Partial<T>;
}

function withClawscanAnalysis(insertArgs: unknown, clawscanAnalysis: unknown) {
  if (!clawscanAnalysis) return insertArgs;
  return {
    ...asRecord(insertArgs),
    llmAnalysis: clawscanAnalysis,
  };
}

function withAigAnalysis(insertArgs: unknown, aigAnalysis: unknown) {
  if (!aigAnalysis) return insertArgs;
  return {
    ...asRecord(insertArgs),
    aigAnalysis,
  };
}

function reusableClawscanAnalysis(value: unknown) {
  const analysis = asRecord(value);
  const status = typeof analysis.status === "string" ? analysis.status.trim().toLowerCase() : "";
  const verdict = typeof analysis.verdict === "string" ? analysis.verdict.trim().toLowerCase() : "";
  const completed = new Set(["benign", "clean", "suspicious", "malicious"]);
  if (typeof analysis.checkedAt !== "number") return undefined;
  if (!completed.has(status) && !completed.has(verdict)) return undefined;
  return value;
}

async function resolveSkillAigAnalysis(
  ctx: Pick<MutationCtx, "db">,
  attempt: Doc<"publishAttempts">,
) {
  if (!attempt.skillVersionId) return undefined;

  // Retained evidence is reusable only when the staged version is still the exact scanned artifact.
  const version = await ctx.db.get(attempt.skillVersionId);
  if (version?.fingerprint !== attempt.artifactFingerprint) return undefined;
  return reusableAigAnalysis(version.aigAnalysis);
}

function scannerFailureSummary(args: {
  trufflehog: { status: string; summary?: string };
  clawscan: { status: string; summary?: string };
}) {
  if (args.trufflehog.status === "failed" && args.trufflehog.summary) {
    return args.trufflehog.summary;
  }
  if (args.clawscan.status === "failed" && args.clawscan.summary) {
    return args.clawscan.summary;
  }
  return "Pre-publication scanner failed before returning a verdict.";
}

function previousScannerFailureCount(attempt: Doc<"publishAttempts">) {
  if (attempt.checkFailureCount !== undefined) return attempt.checkFailureCount;
  return attempt.checks.trufflehog.status === "failed" ||
    attempt.checks.clawscan.status === "failed"
    ? 1
    : 0;
}

function isTerminalFinalizationConflict(error: string | undefined) {
  return (
    typeof error === "string" &&
    (/Version .+ already exists\. Increment the version number and try again\./.test(error) ||
      error.includes("Slug is used by multiple publishers. Use an owner-qualified skill URL.") ||
      error.includes("Slug redirects to an existing skill. Choose a different slug.") ||
      error.includes("Upstream skill not found") ||
      error.includes("Pending skill version not found.") ||
      error.includes("Pending package release not found") ||
      error.includes("Staged OpenClaw publish authorization token is missing") ||
      error.includes("Staged OpenClaw publish authorization no longer matches the release") ||
      error.includes(
        "Trusted publish authorization no longer matches the current trusted publisher",
      ) ||
      error.includes("OpenClaw release parent terminal state") ||
      error.includes("Recovered package publication authorization"))
  );
}

export function failedPublishAttemptPatch(
  status: Doc<"publishAttempts">["status"],
  error: string | undefined,
  now: number,
) {
  return {
    status: "failed" as const,
    checkClaimId: undefined,
    checkClaimedAt: undefined,
    checkClaimExpiresAt: undefined,
    checkClaimLastError: status === "pending_checks" ? error : undefined,
    checkFailureCount: undefined,
    finalizationClaimId: undefined,
    finalizationClaimedAt: undefined,
    finalizationClaimExpiresAt: undefined,
    finalizationLastError: status === "pending_checks" ? undefined : error,
    failedAt: now,
    updatedAt: now,
  };
}

function releaseFinalizationClaimPatch(error: string | undefined, now: number) {
  if (!isTerminalFinalizationConflict(error)) {
    return {
      status: "ready_to_finalize" as const,
      finalizationClaimId: undefined,
      finalizationClaimedAt: undefined,
      finalizationClaimExpiresAt: undefined,
      finalizationLastError: error,
      updatedAt: now,
    };
  }
  return failedPublishAttemptPatch("finalizing", error, now);
}

async function unavailableStagedTargetError(
  ctx: Pick<MutationCtx, "db">,
  attempt: Doc<"publishAttempts">,
) {
  if (attempt.kind === "skill" && attempt.skillVersionId) {
    const version = await ctx.db.get(attempt.skillVersionId);
    if (!version || version.softDeletedAt) return "Pending skill version not found.";
  }
  if (attempt.kind === "package" && attempt.packageReleaseId) {
    const release = await ctx.db.get(attempt.packageReleaseId);
    if (!release || release.softDeletedAt) return "Pending package release not found";
  }
  return null;
}

async function terminalizeUnavailableStagedTarget(
  ctx: Pick<MutationCtx, "db">,
  attempt: Doc<"publishAttempts">,
  now: number,
) {
  const error = await unavailableStagedTargetError(ctx, attempt);
  if (!error) return false;
  await ctx.db.patch(attempt._id, failedPublishAttemptPatch(attempt.status, error, now));
  return true;
}

export const createSkillPublishAttemptInternal = internalMutation({
  args: {
    userId: v.id("users"),
    ownerPublisherId: v.optional(v.id("publishers")),
    sourceOwnerPublisherId: v.optional(v.id("publishers")),
    skillId: v.id("skills"),
    skillVersionId: v.id("skillVersions"),
    createdNewParent: v.optional(v.boolean()),
    slug: v.string(),
    displayName: v.string(),
    version: v.string(),
    idempotencyKey: v.string(),
    artifactFingerprint: v.string(),
    files: v.array(
      v.object({
        path: v.string(),
        size: v.number(),
        storageId: v.id("_storage"),
        sha256: v.string(),
        contentType: v.optional(v.string()),
      }),
    ),
    scanContext: v.optional(v.any()),
    followup: v.object({
      skipWebhook: v.optional(v.boolean()),
      ownerHandle: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const existing = await findReusablePublishAttemptByIdempotencyKey(ctx, args.idempotencyKey);
    if (existing) {
      if (existing.status === "pending_checks") {
        await requestPublishAttemptDispatch(ctx, existing._id);
      }
      return {
        attemptId: existing._id,
        status: existing.status,
        result: existing.result,
      };
    }

    const now = Date.now();
    const attemptId = await ctx.db.insert("publishAttempts", {
      kind: "skill",
      status: "pending_checks",
      userId: args.userId,
      ownerPublisherId: args.ownerPublisherId,
      sourceOwnerPublisherId: args.sourceOwnerPublisherId,
      skillId: args.skillId,
      skillVersionId: args.skillVersionId,
      createdNewParent: args.createdNewParent,
      slug: args.slug,
      displayName: args.displayName,
      version: args.version,
      idempotencyKey: args.idempotencyKey,
      artifactFingerprint: args.artifactFingerprint,
      files: args.files,
      checks: {
        trufflehog: { status: "pending" },
        clawscan: { status: "pending" },
      },
      scanContext: args.scanContext,
      followup: args.followup,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + THIRTY_DAYS_MS,
    });
    await requestPublishAttemptDispatch(ctx, attemptId);

    return { attemptId, status: "pending_checks" as const, result: undefined };
  },
});

async function findReusablePublishAttemptByIdempotencyKey(
  ctx: MutationCtx,
  idempotencyKey: string,
) {
  const attempts = await ctx.db
    .query("publishAttempts")
    .withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", idempotencyKey))
    .order("desc")
    .take(10);
  return attempts.find((attempt) => !isTerminalRetriableAttemptStatus(attempt.status)) ?? null;
}

function isTerminalRetriableAttemptStatus(status: string) {
  return status === "blocked" || status === "failed" || status === "expired";
}

async function isOrphanedPackagePublishAttempt(
  ctx: Pick<QueryCtx, "db">,
  attempt: Doc<"publishAttempts">,
) {
  if (attempt.kind !== "package" || !attempt.packageId || !attempt.packageReleaseId) {
    return false;
  }
  const [pkg, release] = await Promise.all([
    ctx.db.get(attempt.packageId),
    ctx.db.get(attempt.packageReleaseId),
  ]);
  return !pkg || !release;
}

export const findExistingPublishAttemptForArtifactInternal = internalQuery({
  args: {
    kind: v.union(v.literal("skill"), v.literal("package")),
    slug: v.string(),
    version: v.string(),
    userId: v.optional(v.id("users")),
    ownerUserId: v.optional(v.id("users")),
    ownerPublisherId: v.optional(v.id("publishers")),
    artifactFingerprint: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    for (const status of PUBLISH_ATTEMPT_STATUSES) {
      const attempts = await ctx.db
        .query("publishAttempts")
        .withIndex("by_kind_status_slug_version_created", (q) =>
          q
            .eq("kind", args.kind)
            .eq("status", status)
            .eq("slug", args.slug)
            .eq("version", args.version),
        )
        .order("desc")
        .take(25);
      for (const match of attempts) {
        let matchesLookup: boolean;
        if (args.kind === "package") {
          if (args.artifactFingerprint === undefined) {
            matchesLookup = true;
          } else if (match.artifactFingerprint !== args.artifactFingerprint) {
            matchesLookup = false;
          } else if (args.ownerPublisherId !== undefined) {
            matchesLookup =
              match.ownerPublisherId === args.ownerPublisherId &&
              match.userId === args.userId &&
              match.ownerUserId === args.ownerUserId;
          } else {
            matchesLookup =
              match.ownerPublisherId === undefined &&
              match.userId === args.userId &&
              match.ownerUserId === args.ownerUserId;
          }
        } else if (args.ownerPublisherId !== undefined) {
          matchesLookup = match.ownerPublisherId === args.ownerPublisherId;
        } else {
          matchesLookup = match.ownerPublisherId === undefined && match.userId === args.userId;
        }

        if (!matchesLookup) continue;
        // Hard deletion removes the package and release but intentionally retains audit attempts.
        // Those audit rows must not reserve the deleted package version forever.
        if (await isOrphanedPackagePublishAttempt(ctx, match)) continue;
        return {
          attemptId: match._id,
          status: match.status,
          kind: match.kind,
          slug: match.slug,
          version: match.version,
          reusable: !isTerminalRetriableAttemptStatus(match.status),
          packageId: match.packageId,
          releaseId: match.packageReleaseId,
          artifactFingerprint: match.artifactFingerprint,
          result: match.result,
        };
      }
    }
    return null;
  },
});

export const createPackagePublishAttemptInternal = internalMutation({
  args: {
    userId: v.id("users"),
    ownerUserId: v.id("users"),
    ownerPublisherId: v.optional(v.id("publishers")),
    packageId: v.id("packages"),
    packageReleaseId: v.id("packageReleases"),
    createdNewParent: v.optional(v.boolean()),
    name: v.string(),
    displayName: v.string(),
    version: v.string(),
    idempotencyKey: v.string(),
    artifactFingerprint: v.string(),
    files: v.array(
      v.object({
        path: v.string(),
        size: v.number(),
        storageId: v.id("_storage"),
        sha256: v.string(),
        contentType: v.optional(v.string()),
      }),
    ),
    clawpackStorageId: v.optional(v.id("_storage")),
    scanContext: v.optional(v.any()),
    packageInsertArgs: v.optional(v.any()),
    packageFollowup: v.any(),
  },
  handler: async (ctx, args) => {
    const existing = await findReusablePublishAttemptByIdempotencyKey(ctx, args.idempotencyKey);
    if (existing) {
      if (existing.status === "pending_checks") {
        await requestPublishAttemptDispatch(ctx, existing._id);
      }
      return {
        attemptId: existing._id,
        status: existing.status,
        result: existing.result,
      };
    }

    const release = await ctx.db.get(args.packageReleaseId);
    if (
      !release ||
      release.packageId !== args.packageId ||
      release.version !== args.version ||
      release.publicationStatus !== "pending" ||
      release.publishAttemptId !== undefined
    )
      throw new Error(
        "Pending package release is unavailable or already bound to a publish attempt",
      );
    const now = Date.now();
    const attemptId = await ctx.db.insert("publishAttempts", {
      kind: "package",
      status: "pending_checks",
      userId: args.userId,
      ownerUserId: args.ownerUserId,
      ownerPublisherId: args.ownerPublisherId,
      packageId: args.packageId,
      packageReleaseId: args.packageReleaseId,
      createdNewParent: args.createdNewParent,
      slug: args.name,
      displayName: args.displayName,
      version: args.version,
      idempotencyKey: args.idempotencyKey,
      artifactFingerprint: args.artifactFingerprint,
      files: args.files,
      checks: {
        trufflehog: { status: "pending" },
        clawscan: { status: "pending" },
      },
      clawpackStorageId: args.clawpackStorageId,
      scanContext: args.scanContext,
      packageInsertArgs: args.packageInsertArgs,
      packageFollowup: args.packageFollowup,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + THIRTY_DAYS_MS,
    });
    // Bind the owning attempt before a scanner can fail or claim the release.
    await ctx.db.patch(release._id, { publishAttemptId: attemptId });
    await requestPublishAttemptDispatch(ctx, attemptId);

    return { attemptId, status: "pending_checks" as const, result: undefined };
  },
});

export const getPendingPublishAttemptDispatchTargetInternal = internalQuery({
  args: {
    attemptId: v.id("publishAttempts"),
  },
  handler: async (ctx, args) => {
    const attempt = await ctx.db.get(args.attemptId);
    if (!attempt || attempt.status !== "pending_checks") return null;
    return {
      attemptId: attempt._id,
      kind: attempt.kind,
      slug: attempt.slug,
      version: attempt.version,
    };
  },
});

export const getPackagePublishAttemptStatusInternal = internalQuery({
  args: {
    attemptId: v.string(),
  },
  handler: async (ctx, args) => {
    const attemptId = ctx.db.normalizeId("publishAttempts", args.attemptId);
    if (!attemptId) return null;
    const attempt = await ctx.db.get(attemptId);
    if (!attempt || attempt.kind !== "package" || !attempt.packageId || !attempt.packageReleaseId) {
      return null;
    }
    const release = await ctx.db.get(attempt.packageReleaseId);
    return {
      attemptId: attempt._id,
      userId: attempt.userId,
      packageId: attempt.packageId,
      releaseId: attempt.packageReleaseId,
      ...(release?.clawpackSha256 ? { artifactSha256: release.clawpackSha256 } : {}),
      name: attempt.slug,
      version: attempt.version,
      status: attempt.status,
      checks: {
        trufflehog: compactPublishAttemptCheck(attempt.checks.trufflehog),
        clawscan: compactPublishAttemptCheck(attempt.checks.clawscan),
      },
      error: publishAttemptStatusError(attempt),
    };
  },
});

function compactPublishAttemptCheck(check: {
  status: "pending" | "clean" | "blocked" | "failed";
  summary?: string;
}) {
  return {
    status: check.status,
    ...(check.summary ? { summary: check.summary } : {}),
  };
}

function publishAttemptStatusError(attempt: Doc<"publishAttempts">) {
  if (attempt.finalizationLastError) return attempt.finalizationLastError;
  if (attempt.checkClaimLastError) return attempt.checkClaimLastError;
  if (
    attempt.checks.trufflehog.status === "blocked" ||
    attempt.checks.trufflehog.status === "failed"
  )
    return attempt.checks.trufflehog.summary;
  if (attempt.checks.clawscan.status === "blocked" || attempt.checks.clawscan.status === "failed")
    return attempt.checks.clawscan.summary;
  return undefined;
}

function getSecretBlockedStorageIds(attempt: {
  files: Array<{ storageId: Id<"_storage"> }>;
  clawpackStorageId?: Id<"_storage">;
  packageInsertArgs?: unknown;
}) {
  const storageIds = new Set<Id<"_storage">>(attempt.files.map((file) => file.storageId));
  if (attempt.clawpackStorageId) storageIds.add(attempt.clawpackStorageId);
  const packageInsertArgs = attempt.packageInsertArgs;
  if (packageInsertArgs && typeof packageInsertArgs === "object") {
    const clawpackStorageId = (packageInsertArgs as { clawpackStorageId?: unknown })
      .clawpackStorageId;
    if (typeof clawpackStorageId === "string") {
      storageIds.add(clawpackStorageId as Id<"_storage">);
    }
  }
  return [...storageIds];
}

function buildSkillAttemptScanContext(attempt: {
  scanContext?: unknown;
  skillInsertArgs?: unknown;
}) {
  if (attempt.scanContext) return attempt.scanContext;
  const skillInsertArgs = asRecord(attempt.skillInsertArgs);
  const parsed = asRecord(skillInsertArgs.parsed);
  return withoutUndefined({
    version: withoutUndefined({
      staticScan: skillInsertArgs.staticScan,
      parsed: withoutUndefined({
        metadata: parsed.metadata,
        clawdis: parsed.clawdis,
        license: parsed.license,
      }),
      qualityAssessment: skillInsertArgs.qualityAssessment,
      sourceProvenance: skillInsertArgs.sourceProvenance,
    }),
  });
}

function buildPackageAttemptScanContext(attempt: {
  scanContext?: unknown;
  packageInsertArgs?: unknown;
}) {
  if (attempt.scanContext) return attempt.scanContext;
  const packageInsertArgs = asRecord(attempt.packageInsertArgs);
  const verification = asRecord(packageInsertArgs.verification);
  return withoutUndefined({
    trustedOpenClawPlugin: verification.trustedOpenClawPlugin === true ? true : undefined,
    release: withoutUndefined({
      staticScan: packageInsertArgs.staticScan,
      pluginManifestSummary: packageInsertArgs.pluginManifestSummary,
      verification: packageInsertArgs.verification,
      artifactKind: packageInsertArgs.artifactKind,
      npmIntegrity: packageInsertArgs.npmIntegrity,
      npmShasum: packageInsertArgs.npmShasum,
      npmTarballName: packageInsertArgs.npmTarballName,
      source: packageInsertArgs.source,
    }),
  });
}

function publishAttemptClawpackStorageId(attempt: {
  clawpackStorageId?: Id<"_storage">;
  packageInsertArgs?: unknown;
}) {
  if (attempt.clawpackStorageId) return attempt.clawpackStorageId;
  const clawpackStorageId = asRecord(attempt.packageInsertArgs).clawpackStorageId;
  return typeof clawpackStorageId === "string" ? (clawpackStorageId as Id<"_storage">) : undefined;
}

async function deleteSecretBlockedPendingSkillArtifact(
  ctx: MutationCtx,
  attempt: {
    skillId?: Id<"skills">;
    skillVersionId?: Id<"skillVersions">;
    createdNewParent?: boolean;
  },
) {
  if (!attempt.skillVersionId) return;

  const fingerprints = await ctx.db
    .query("skillVersionFingerprints")
    .withIndex("by_version", (q) => q.eq("versionId", attempt.skillVersionId!))
    .take(100);
  for (const fingerprint of fingerprints) {
    await ctx.db.delete(fingerprint._id);
  }
  await ctx.db.delete(attempt.skillVersionId);

  if (!attempt.createdNewParent || !attempt.skillId) return;
  const skill = await ctx.db.get(attempt.skillId);
  if (!skill || skill.latestVersionId) return;
  const remainingVersions = await ctx.db
    .query("skillVersions")
    .withIndex("by_skill", (q) => q.eq("skillId", attempt.skillId!))
    .take(1);
  if (remainingVersions.length === 0) {
    await ctx.db.delete(attempt.skillId);
  }
}

async function deleteSecretBlockedPendingPackageArtifact(
  ctx: MutationCtx,
  attempt: {
    packageId?: Id<"packages">;
    packageReleaseId?: Id<"packageReleases">;
    createdNewParent?: boolean;
  },
) {
  if (!attempt.packageReleaseId) return;

  await ctx.db.delete(attempt.packageReleaseId);

  if (!attempt.createdNewParent || !attempt.packageId) return;
  const pkg = await ctx.db.get(attempt.packageId);
  if (!pkg || pkg.latestReleaseId) return;
  const remainingReleases = await ctx.db
    .query("packageReleases")
    .withIndex("by_package", (q) => q.eq("packageId", attempt.packageId!))
    .take(1);
  if (remainingReleases.length === 0) {
    await ctx.db.delete(attempt.packageId);
  }
}

export const recordSkillPublishAttemptChecksPassedInternal = internalMutation({
  args: {
    attemptId: v.id("publishAttempts"),
    trufflehogSummary: v.optional(v.string()),
    clawscanSummary: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const attempt = await requireSkillPublishAttempt(ctx, args.attemptId);
    if (attempt.status === "finalized") {
      return { attemptId: attempt._id, status: attempt.status, result: attempt.result };
    }
    if (attempt.status !== "pending_checks" && attempt.status !== "ready_to_finalize") {
      throw new ConvexError(`Publish attempt is ${attempt.status}, not pending checks.`);
    }

    const now = Date.now();
    await ctx.db.patch(attempt._id, {
      status: "ready_to_finalize",
      checks: {
        trufflehog: {
          status: "clean",
          checkedAt: now,
          summary: args.trufflehogSummary,
        },
        clawscan: {
          status: "clean",
          checkedAt: now,
          summary: args.clawscanSummary,
        },
      },
      updatedAt: now,
    });

    return { attemptId: attempt._id, status: "ready_to_finalize" as const, result: undefined };
  },
});

export const completePendingPublishAttemptChecksInternal = internalMutation({
  args: {
    attemptId: v.id("publishAttempts"),
    claimId: v.string(),
    artifactFingerprint: v.string(),
    trufflehog: workerCheckResultValidator,
    clawscan: workerCheckResultValidator,
    clawscanAnalysis: v.optional(workerLlmAnalysisValidator),
    aigAnalysis: v.optional(workerAigAnalysisValidator),
  },
  handler: async (ctx, args) => {
    const attempt = await ctx.db.get(args.attemptId);
    if (!attempt) throw new ConvexError("Publish attempt not found.");
    if (attempt.artifactFingerprint !== args.artifactFingerprint) {
      throw new ConvexError("Publish attempt artifact fingerprint does not match scanned input.");
    }
    if (
      attempt.status === "finalizing" &&
      (attempt.finalizationClaimExpiresAt ?? 0) <= Date.now()
    ) {
      return { attemptId: attempt._id, kind: attempt.kind, status: "ready_to_finalize" as const };
    }
    if (attempt.status !== "pending_checks") {
      return { attemptId: attempt._id, kind: attempt.kind, status: attempt.status };
    }
    if (attempt.checkClaimId !== args.claimId || (attempt.checkClaimExpiresAt ?? 0) <= Date.now()) {
      throw new ConvexError("Publish attempt check claim is not active.");
    }

    const now = Date.now();
    const checks = {
      trufflehog: {
        status: args.trufflehog.status,
        checkedAt: now,
        summary: args.trufflehog.summary,
        redactedFindings: args.trufflehog.redactedFindings,
      },
      clawscan: {
        status: args.clawscan.status,
        checkedAt: now,
        summary: args.clawscan.summary,
        redactedFindings: args.clawscan.redactedFindings,
      },
    };

    if (args.trufflehog.status === "blocked") {
      await Promise.all(
        getSecretBlockedStorageIds(attempt).map((storageId) => ctx.storage.delete(storageId)),
      );
      if (attempt.kind === "skill") {
        await deleteSecretBlockedPendingSkillArtifact(ctx, attempt);
      } else if (attempt.kind === "package") {
        await deleteSecretBlockedPendingPackageArtifact(ctx, attempt);
      }
      await ctx.db.patch(attempt._id, {
        status: "blocked",
        checks,
        files: [],
        skillInsertArgs: undefined,
        packageInsertArgs: undefined,
        followup: undefined,
        packageFollowup: undefined,
        checkClaimId: undefined,
        checkClaimedAt: undefined,
        checkClaimExpiresAt: undefined,
        checkClaimLastError: undefined,
        checkFailureCount: undefined,
        blockedAt: now,
        updatedAt: now,
      });
      await scheduleSecretPublishBlockedEmail(ctx, attempt);
      return { attemptId: attempt._id, kind: attempt.kind, status: "blocked" as const };
    }

    if (args.clawscan.status === "blocked") {
      if (attempt.kind === "skill" && attempt.skillVersionId) {
        await ctx.db.patch(attempt.skillVersionId, {
          publicationStatus: "blocked",
          llmAnalysis: args.clawscanAnalysis,
          ...(args.aigAnalysis ? { aigAnalysis: args.aigAnalysis } : {}),
          publishAttemptId: attempt._id,
        });
      }
      if (attempt.kind === "package" && attempt.packageReleaseId) {
        const release = await ctx.db.get(attempt.packageReleaseId);
        const verification = release?.verification
          ? { ...release.verification, scanStatus: "malicious" as const }
          : release?.verification;
        await ctx.db.patch(attempt.packageReleaseId, {
          publicationStatus: "blocked",
          verification,
          llmAnalysis: args.clawscanAnalysis,
          ...(args.aigAnalysis ? { aigAnalysis: args.aigAnalysis } : {}),
          publishAttemptId: attempt._id,
        });
      }
      await ctx.db.patch(attempt._id, {
        status: "blocked",
        checks,
        skillInsertArgs:
          attempt.kind === "skill"
            ? withAigAnalysis(
                withClawscanAnalysis(attempt.skillInsertArgs, args.clawscanAnalysis),
                args.aigAnalysis,
              )
            : attempt.skillInsertArgs,
        packageInsertArgs:
          attempt.kind === "package"
            ? withAigAnalysis(
                withClawscanAnalysis(attempt.packageInsertArgs, args.clawscanAnalysis),
                args.aigAnalysis,
              )
            : attempt.packageInsertArgs,
        checkClaimId: undefined,
        checkClaimedAt: undefined,
        checkClaimExpiresAt: undefined,
        checkClaimLastError: undefined,
        checkFailureCount: undefined,
        blockedAt: now,
        updatedAt: now,
      });
      return { attemptId: attempt._id, kind: attempt.kind, status: "blocked" as const };
    }

    if (await terminalizeUnavailableStagedTarget(ctx, attempt, now)) {
      return { attemptId: attempt._id, kind: attempt.kind, status: "failed" as const };
    }

    if (args.trufflehog.status === "failed" || args.clawscan.status === "failed") {
      const checkFailureCount = previousScannerFailureCount(attempt) + 1;
      const terminal = checkFailureCount >= MAX_CONSECUTIVE_SCANNER_FAILURES;
      await ctx.db.patch(attempt._id, {
        status: terminal ? "failed" : "pending_checks",
        checks,
        checkClaimId: undefined,
        checkClaimedAt: undefined,
        checkClaimExpiresAt: terminal ? undefined : now + CHECK_RETRY_BACKOFF_MS,
        checkClaimLastError: scannerFailureSummary(args),
        checkFailureCount,
        failedAt: terminal ? now : undefined,
        updatedAt: now,
      });
      return {
        attemptId: attempt._id,
        kind: attempt.kind,
        status: terminal ? ("failed" as const) : ("pending_checks" as const),
      };
    }

    const submittedAigAnalysis = reusableAigAnalysis(args.aigAnalysis);
    const effectiveAigAnalysis =
      attempt.kind === "skill"
        ? (submittedAigAnalysis ?? (await resolveSkillAigAnalysis(ctx, attempt)))
        : args.aigAnalysis;
    // A.I.G is required supporting evidence, but ClawScan remains the sole publication authority.
    // Preserve suspicious or malicious A.I.G findings for audit display instead of blocking here.
    if (attempt.kind === "skill" && !effectiveAigAnalysis) {
      const checkFailureCount = previousScannerFailureCount(attempt) + 1;
      const terminal = checkFailureCount >= MAX_CONSECUTIVE_SCANNER_FAILURES;
      await ctx.db.patch(attempt._id, {
        status: terminal ? "failed" : "pending_checks",
        checks,
        checkClaimId: undefined,
        checkClaimedAt: undefined,
        checkClaimExpiresAt: terminal ? undefined : now + CHECK_RETRY_BACKOFF_MS,
        checkClaimLastError: MISSING_AIG_EVIDENCE_ERROR,
        checkFailureCount,
        failedAt: terminal ? now : undefined,
        updatedAt: now,
      });
      return {
        attemptId: attempt._id,
        kind: attempt.kind,
        status: terminal ? ("failed" as const) : ("pending_checks" as const),
      };
    }

    if (
      attempt.kind === "skill" &&
      attempt.skillVersionId &&
      (args.clawscanAnalysis || submittedAigAnalysis)
    ) {
      await ctx.db.patch(attempt.skillVersionId, {
        ...(args.clawscanAnalysis ? { llmAnalysis: args.clawscanAnalysis } : {}),
        ...(submittedAigAnalysis ? { aigAnalysis: submittedAigAnalysis } : {}),
        publishAttemptId: attempt._id,
      });
    }
    if (attempt.kind === "package" && attempt.packageReleaseId && args.clawscanAnalysis) {
      await ctx.db.patch(attempt.packageReleaseId, {
        llmAnalysis: args.clawscanAnalysis,
        ...(args.aigAnalysis ? { aigAnalysis: args.aigAnalysis } : {}),
        publishAttemptId: attempt._id,
      });
    }

    await ctx.db.patch(attempt._id, {
      status: "ready_to_finalize",
      checks,
      skillInsertArgs:
        attempt.kind === "skill"
          ? withAigAnalysis(
              withClawscanAnalysis(attempt.skillInsertArgs, args.clawscanAnalysis),
              effectiveAigAnalysis,
            )
          : attempt.skillInsertArgs,
      packageInsertArgs:
        attempt.kind === "package"
          ? withAigAnalysis(
              withClawscanAnalysis(attempt.packageInsertArgs, args.clawscanAnalysis),
              args.aigAnalysis,
            )
          : attempt.packageInsertArgs,
      checkClaimId: undefined,
      checkClaimedAt: undefined,
      checkClaimExpiresAt: undefined,
      checkClaimLastError: undefined,
      checkFailureCount: undefined,
      updatedAt: now,
    });
    return { attemptId: attempt._id, kind: attempt.kind, status: "ready_to_finalize" as const };
  },
});

export const claimPendingPublishAttemptChecksInternal = internalMutation({
  args: {
    claimId: v.string(),
    attemptId: v.optional(v.id("publishAttempts")),
    kind: v.optional(v.union(v.literal("skill"), v.literal("package"))),
    retryOnly: v.optional(v.boolean()),
    slug: v.optional(v.string()),
    version: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const targetedAttempt = args.attemptId ? await ctx.db.get(args.attemptId) : null;
    let candidates: Doc<"publishAttempts">[];
    if (args.attemptId) {
      candidates = targetedAttempt ? [targetedAttempt] : [];
    } else if (args.retryOnly) {
      candidates = await ctx.db
        .query("publishAttempts")
        .withIndex("by_status_check_claim_expires_at_created", (q) =>
          q
            .eq("status", "pending_checks")
            .gte("checkClaimExpiresAt", 0)
            .lte("checkClaimExpiresAt", now),
        )
        .order("asc")
        .take(25);
    } else {
      candidates = await ctx.db
        .query("publishAttempts")
        .withIndex("by_status_check_claim_expires_at_created", (q) =>
          q.eq("status", "pending_checks"),
        )
        .order("asc")
        .take(25);
    }

    for (const attempt of candidates) {
      if (attempt.status !== "pending_checks") {
        if (args.attemptId && attempt.status === "failed") return null;
        if (args.attemptId) {
          throw new ConvexError(`Publish attempt is ${attempt.status}, not pending checks.`);
        }
        continue;
      }
      if (args.kind && attempt.kind !== args.kind) {
        if (args.attemptId) {
          throw new ConvexError("Publish attempt kind does not match worker claim.");
        }
        continue;
      }
      if (args.slug && attempt.slug !== args.slug) {
        if (args.attemptId) {
          throw new ConvexError("Publish attempt slug does not match worker claim.");
        }
        continue;
      }
      if (args.version && attempt.version !== args.version) {
        if (args.attemptId) {
          throw new ConvexError("Publish attempt version does not match worker claim.");
        }
        continue;
      }
      if ((attempt.checkClaimExpiresAt ?? 0) > now && attempt.checkClaimId !== args.claimId) {
        if (args.attemptId) return ACTIVE_CLAIM_OUTCOME;
        continue;
      }
      if (await terminalizeUnavailableStagedTarget(ctx, attempt, now)) continue;

      const checkClaimExpiresAt = now + CHECK_CLAIM_LEASE_MS;
      await ctx.db.patch(attempt._id, {
        checkClaimId: args.claimId,
        checkClaimedAt: now,
        checkClaimExpiresAt,
        checkClaimLastError: undefined,
        updatedAt: now,
      });

      let existingClawscanAnalysis: unknown;
      let existingAigAnalysis: unknown;
      if (attempt.kind === "skill" && attempt.skillVersionId) {
        const version = await ctx.db.get(attempt.skillVersionId);
        if (version?.fingerprint === attempt.artifactFingerprint) {
          existingClawscanAnalysis = reusableClawscanAnalysis(version.llmAnalysis);
          existingAigAnalysis = reusableAigAnalysis(version.aigAnalysis);
        }
      } else if (
        attempt.kind === "package" &&
        attempt.packageReleaseId &&
        !manualPackageRecovery(attempt.packageFollowup)
      ) {
        // Recovery runs current checks anew; prior attempt results remain audit evidence.
        const release = await ctx.db.get(attempt.packageReleaseId);
        const releaseFingerprint = release?.clawManifestSummary
          ? release.clawpackSha256
          : release?.integritySha256;
        if (release && releaseFingerprint === attempt.artifactFingerprint) {
          existingClawscanAnalysis = reusableClawscanAnalysis(release.llmAnalysis);
          existingAigAnalysis = reusableAigAnalysis(release.aigAnalysis);
        }
      }

      return {
        attemptId: attempt._id,
        status: attempt.status,
        claimId: args.claimId,
        kind: attempt.kind,
        userId: attempt.userId,
        ownerUserId: attempt.ownerUserId,
        ownerPublisherId: attempt.ownerPublisherId,
        sourceOwnerPublisherId: attempt.sourceOwnerPublisherId,
        skillId: attempt.skillId,
        versionId: attempt.skillVersionId,
        packageId: attempt.packageId,
        releaseId: attempt.packageReleaseId,
        slug: attempt.slug,
        displayName: attempt.displayName,
        version: attempt.version,
        artifactFingerprint: attempt.artifactFingerprint,
        files: attempt.files,
        ...(attempt.kind === "skill"
          ? {
              scanContext: buildSkillAttemptScanContext(attempt),
            }
          : {
              clawpackStorageId: publishAttemptClawpackStorageId(attempt),
              scanContext: buildPackageAttemptScanContext(attempt),
            }),
        ...(existingClawscanAnalysis ? { existingClawscanAnalysis } : {}),
        ...(existingAigAnalysis ? { existingAigAnalysis } : {}),
        checkClaimExpiresAt,
        createdAt: attempt.createdAt,
      };
    }
    return null;
  },
});

export const claimReadyPublishAttemptFinalizationRetryInternal = internalMutation({
  args: {
    claimId: v.string(),
    attemptId: v.optional(v.id("publishAttempts")),
    kind: v.optional(v.union(v.literal("skill"), v.literal("package"))),
    slug: v.optional(v.string()),
    version: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const targetedAttempt = args.attemptId ? await ctx.db.get(args.attemptId) : null;
    const candidates = args.attemptId
      ? targetedAttempt
        ? [targetedAttempt]
        : []
      : await ctx.db
          .query("publishAttempts")
          .withIndex("by_status_and_created", (q) => q.eq("status", "ready_to_finalize"))
          .order("asc")
          .take(25);

    for (const attempt of candidates) {
      if (attempt.status !== "ready_to_finalize") {
        if (args.attemptId) return null;
        continue;
      }
      if (args.kind && attempt.kind !== args.kind) {
        if (args.attemptId) {
          throw new ConvexError("Publish attempt kind does not match worker claim.");
        }
        continue;
      }
      if (args.slug && attempt.slug !== args.slug) {
        if (args.attemptId) {
          throw new ConvexError("Publish attempt slug does not match worker claim.");
        }
        continue;
      }
      if (args.version && attempt.version !== args.version) {
        if (args.attemptId) {
          throw new ConvexError("Publish attempt version does not match worker claim.");
        }
        continue;
      }
      if ((attempt.checkClaimExpiresAt ?? 0) > now && attempt.checkClaimId !== args.claimId) {
        if (args.attemptId) return ACTIVE_CLAIM_OUTCOME;
        continue;
      }
      if (await terminalizeUnavailableStagedTarget(ctx, attempt, now)) continue;

      await ctx.db.patch(attempt._id, {
        checkClaimId: args.claimId,
        checkClaimedAt: now,
        checkClaimExpiresAt: now + CHECK_CLAIM_LEASE_MS,
        checkClaimLastError: undefined,
        updatedAt: now,
      });

      return {
        attemptId: attempt._id,
        status: attempt.status,
        claimId: args.claimId,
        kind: attempt.kind,
        userId: attempt.userId,
        ownerUserId: attempt.ownerUserId,
        ownerPublisherId: attempt.ownerPublisherId,
        sourceOwnerPublisherId: attempt.sourceOwnerPublisherId,
        skillId: attempt.skillId,
        versionId: attempt.skillVersionId,
        packageId: attempt.packageId,
        releaseId: attempt.packageReleaseId,
        slug: attempt.slug,
        displayName: attempt.displayName,
        version: attempt.version,
        artifactFingerprint: attempt.artifactFingerprint,
        files: [],
        checkClaimExpiresAt: now + CHECK_CLAIM_LEASE_MS,
        createdAt: attempt.createdAt,
      };
    }
    return null;
  },
});

export const claimSkillPublishAttemptForFinalizationInternal = internalMutation({
  args: {
    attemptId: v.id("publishAttempts"),
    claimId: v.string(),
  },
  handler: async (ctx, args) => {
    const attempt = await requireSkillPublishAttempt(ctx, args.attemptId);
    const now = Date.now();
    if (attempt.status === "finalized" && attempt.result) {
      return {
        status: "finalized" as const,
        attemptId: attempt._id,
        result: attempt.result,
        followup: buildSkillPublishFollowup(attempt),
      };
    }
    if (attempt.status === "finalizing" && (attempt.finalizationClaimExpiresAt ?? 0) > now) {
      throw new ConvexError("Publish attempt is already finalizing.");
    }
    if (attempt.status !== "ready_to_finalize" && attempt.status !== "finalizing") {
      throw new ConvexError(`Publish attempt is ${attempt.status}, not ready to finalize.`);
    }

    await ctx.db.patch(attempt._id, {
      status: "finalizing",
      finalizationClaimId: args.claimId,
      finalizationClaimedAt: now,
      finalizationClaimExpiresAt: now + FINALIZATION_CLAIM_LEASE_MS,
      finalizationLastError: undefined,
      updatedAt: now,
    });

    return {
      status: "claimed" as const,
      attemptId: attempt._id,
      createdAt: attempt.createdAt,
      skillId: attempt.skillId,
      versionId: attempt.skillVersionId,
      skillInsertArgs: attempt.skillInsertArgs,
      followup: buildSkillPublishFollowup(attempt),
    };
  },
});

export const claimPackagePublishAttemptForFinalizationInternal = internalMutation({
  args: {
    attemptId: v.id("publishAttempts"),
    claimId: v.string(),
  },
  handler: async (ctx, args) => {
    const attempt = await requirePackagePublishAttempt(ctx, args.attemptId);
    const now = Date.now();
    if (attempt.status === "finalized" && attempt.result) {
      return {
        status: "finalized" as const,
        attemptId: attempt._id,
        result: attempt.result,
        packageFollowup: attempt.packageFollowup,
      };
    }
    if (attempt.status === "finalizing" && (attempt.finalizationClaimExpiresAt ?? 0) > now) {
      throw new ConvexError("Publish attempt is already finalizing.");
    }
    if (attempt.status !== "ready_to_finalize" && attempt.status !== "finalizing") {
      throw new ConvexError(`Publish attempt is ${attempt.status}, not ready to finalize.`);
    }

    await ctx.db.patch(attempt._id, {
      status: "finalizing",
      finalizationClaimId: args.claimId,
      finalizationClaimedAt: now,
      finalizationClaimExpiresAt: now + FINALIZATION_CLAIM_LEASE_MS,
      finalizationLastError: undefined,
      updatedAt: now,
    });

    return {
      status: "claimed" as const,
      attemptId: attempt._id,
      packageId: attempt.packageId,
      releaseId: attempt.packageReleaseId,
      packageInsertArgs: attempt.packageInsertArgs,
      packageFollowup: attempt.packageFollowup,
    };
  },
});

export const releaseSkillPublishAttemptFinalizationClaimInternal = internalMutation({
  args: {
    attemptId: v.id("publishAttempts"),
    claimId: v.string(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const attempt = await requireSkillPublishAttempt(ctx, args.attemptId);
    if (attempt.status !== "finalizing" || attempt.finalizationClaimId !== args.claimId) {
      return { attemptId: attempt._id, status: attempt.status };
    }

    const patch = releaseFinalizationClaimPatch(args.error, Date.now());
    await ctx.db.patch(attempt._id, patch);
    return { attemptId: attempt._id, status: patch.status };
  },
});

export const releasePackagePublishAttemptFinalizationClaimInternal = internalMutation({
  args: {
    attemptId: v.id("publishAttempts"),
    claimId: v.string(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const attempt = await requirePackagePublishAttempt(ctx, args.attemptId);
    if (attempt.status !== "finalizing" || attempt.finalizationClaimId !== args.claimId) {
      return { attemptId: attempt._id, status: attempt.status };
    }

    const patch = releaseFinalizationClaimPatch(args.error, Date.now());
    await ctx.db.patch(attempt._id, patch);
    return { attemptId: attempt._id, status: patch.status };
  },
});

export const recordSkillPublishAttemptFinalizedInternal = internalMutation({
  args: {
    attemptId: v.id("publishAttempts"),
    claimId: v.string(),
    result: publishResultValidator,
  },
  handler: async (ctx, args) => {
    const attempt = await requireSkillPublishAttempt(ctx, args.attemptId);
    if (attempt.status === "finalized" && attempt.result) {
      return { attemptId: attempt._id, status: attempt.status, result: attempt.result };
    }
    const now = Date.now();
    if (
      attempt.status !== "finalizing" ||
      attempt.finalizationClaimId !== args.claimId ||
      (attempt.finalizationClaimExpiresAt ?? 0) <= now
    ) {
      throw new ConvexError("Publish attempt finalization claim is not active.");
    }

    await ctx.db.patch(attempt._id, {
      status: "finalized",
      finalizationClaimId: undefined,
      finalizationClaimedAt: undefined,
      finalizationClaimExpiresAt: undefined,
      finalizationLastError: undefined,
      result: args.result,
      finalizedAt: now,
      updatedAt: now,
    });
    if (attempt.skillVersionId && attempt.skillVersionId === args.result.versionId) {
      await ctx.db.patch(attempt.skillVersionId, {
        pendingPublication: undefined,
      });
    }

    return { attemptId: attempt._id, status: "finalized" as const, result: args.result };
  },
});

export const recordPackagePublishAttemptFinalizedInternal = internalMutation({
  args: {
    attemptId: v.id("publishAttempts"),
    claimId: v.string(),
    result: packagePublishResultValidator,
  },
  handler: async (ctx, args) => {
    const attempt = await requirePackagePublishAttempt(ctx, args.attemptId);
    if (attempt.status === "finalized" && attempt.result) {
      return { attemptId: attempt._id, status: attempt.status, result: attempt.result };
    }
    const now = Date.now();
    if (
      attempt.status !== "finalizing" ||
      attempt.finalizationClaimId !== args.claimId ||
      (attempt.finalizationClaimExpiresAt ?? 0) <= now
    ) {
      throw new ConvexError("Publish attempt finalization claim is not active.");
    }

    await ctx.db.patch(attempt._id, {
      status: "finalized",
      finalizationClaimId: undefined,
      finalizationClaimedAt: undefined,
      finalizationClaimExpiresAt: undefined,
      finalizationLastError: undefined,
      result: args.result,
      finalizedAt: now,
      updatedAt: now,
    });

    return { attemptId: attempt._id, status: "finalized" as const, result: args.result };
  },
});

export const findSkillPublishAttemptPublicResultInternal = internalQuery({
  args: {
    attemptId: v.id("publishAttempts"),
  },
  handler: async (ctx, args) => {
    const attempt = await requireSkillPublishAttempt(ctx, args.attemptId);
    let ownerPublisherId = attempt.ownerPublisherId;
    if (!ownerPublisherId) {
      const personalPublishers = await ctx.db
        .query("publishers")
        .withIndex("by_linked_user", (q) => q.eq("linkedUserId", attempt.userId))
        .take(5);
      ownerPublisherId = personalPublishers.find(
        (publisher) =>
          publisher.kind === "user" && !publisher.deletedAt && !publisher.deactivatedAt,
      )?._id;
    }

    const skill = ownerPublisherId
      ? await ctx.db
          .query("skills")
          .withIndex("by_owner_publisher_slug", (q) =>
            q.eq("ownerPublisherId", ownerPublisherId).eq("slug", attempt.slug),
          )
          .unique()
      : await ctx.db
          .query("skills")
          .withIndex("by_owner_slug", (q) =>
            q.eq("ownerUserId", attempt.userId).eq("slug", attempt.slug),
          )
          .unique();
    if (!skill) return null;

    const version = await ctx.db
      .query("skillVersions")
      .withIndex("by_skill_version", (q) =>
        q.eq("skillId", skill._id).eq("version", attempt.version),
      )
      .unique();
    if (!version || version.softDeletedAt || version.fingerprint !== attempt.artifactFingerprint) {
      return null;
    }

    const embedding = await ctx.db
      .query("skillEmbeddings")
      .withIndex("by_version", (q) => q.eq("versionId", version._id))
      .unique();
    if (!embedding) return null;

    return {
      skillId: skill._id,
      versionId: version._id,
      embeddingId: embedding._id,
      publicationStatus: "published" as const,
    };
  },
});

export const finalizeSkillPublishAttemptInternal = internalAction({
  args: {
    attemptId: v.id("publishAttempts"),
  },
  handler: async (ctx, args) => {
    return await finalizeSkillPublishAttempt(ctx, args.attemptId);
  },
});

export const claimPrePublicationChecks: ReturnType<typeof action> = action({
  args: {
    token: v.string(),
    attemptId: v.optional(v.id("publishAttempts")),
    kind: v.optional(v.union(v.literal("skill"), v.literal("package"))),
    preferRetry: v.optional(v.boolean()),
    slug: v.optional(v.string()),
    version: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<unknown> => {
    assertWorkerToken(args.token);
    const claimId = buildCheckClaimId();
    const claimArgs = {
      claimId,
      attemptId: args.attemptId,
      kind: args.kind,
      slug: args.slug,
      version: args.version,
    };
    const reservedRetry =
      args.preferRetry && !args.attemptId
        ? await ctx.runMutation(internal.publishAttempts.claimPendingPublishAttemptChecksInternal, {
            ...claimArgs,
            retryOnly: true,
          })
        : null;
    const claimed = (reservedRetry ??
      (await ctx.runMutation(
        internal.publishAttempts.claimReadyPublishAttemptFinalizationRetryInternal,
        claimArgs,
      )) ??
      (await ctx.runMutation(
        internal.publishAttempts.claimPendingPublishAttemptChecksInternal,
        claimArgs,
      ))) as
      | null
      | typeof ACTIVE_CLAIM_OUTCOME
      | {
          attemptId: Id<"publishAttempts">;
          status: "pending_checks" | "ready_to_finalize";
          claimId: string;
          kind: "skill" | "package";
          userId: Id<"users">;
          ownerUserId?: Id<"users">;
          ownerPublisherId?: Id<"publishers">;
          sourceOwnerPublisherId?: Id<"publishers">;
          skillId?: Id<"skills">;
          versionId?: Id<"skillVersions">;
          packageId?: Id<"packages">;
          releaseId?: Id<"packageReleases">;
          slug: string;
          displayName: string;
          version: string;
          artifactFingerprint: string;
          files: Array<{
            path: string;
            size: number;
            storageId: Id<"_storage">;
            sha256: string;
            contentType?: string;
          }>;
          clawpackStorageId?: Id<"_storage">;
          scanContext?: Record<string, unknown>;
          checkClaimExpiresAt: number;
          createdAt: number;
        };
    if (!claimed || "outcome" in claimed) return null;

    const files = await Promise.all(
      claimed.files.map(async (file) => ({
        ...file,
        url: await ctx.storage.getUrl(file.storageId),
      })),
    );
    const clawpackUrl = claimed.clawpackStorageId
      ? await ctx.storage.getUrl(claimed.clawpackStorageId)
      : undefined;
    return withoutUndefined({
      ...claimed,
      files,
      clawpackStorageId: undefined,
      clawpackUrl,
    });
  },
});

export const completePrePublicationChecks: ReturnType<typeof action> = action({
  args: {
    token: v.string(),
    attemptId: v.id("publishAttempts"),
    claimId: v.string(),
    artifactFingerprint: v.string(),
    trufflehog: workerCheckResultValidator,
    clawscan: workerCheckResultValidator,
    clawscanAnalysis: v.optional(workerLlmAnalysisValidator),
    aigAnalysis: v.optional(workerAigAnalysisValidator),
  },
  handler: async (ctx, args): Promise<unknown> => {
    assertWorkerToken(args.token);
    const completed = (await ctx.runMutation(
      internal.publishAttempts.completePendingPublishAttemptChecksInternal,
      {
        attemptId: args.attemptId,
        claimId: args.claimId,
        artifactFingerprint: args.artifactFingerprint,
        trufflehog: args.trufflehog,
        clawscan: args.clawscan,
        clawscanAnalysis: args.clawscanAnalysis,
        aigAnalysis: args.aigAnalysis,
      },
    )) as {
      attemptId: Id<"publishAttempts">;
      kind: "skill" | "package";
      status: "blocked" | "failed" | "pending_checks" | "ready_to_finalize";
    };

    if (completed.status !== "ready_to_finalize") return completed;
    if (completed.kind === "skill") {
      const result = await finalizeSkillPublishAttempt(ctx, completed.attemptId);
      return { ...completed, status: "finalized" as const, result };
    }

    const result: unknown = await ctx.runAction(
      internal.packages.finalizePackagePublishAttemptInternal,
      {
        attemptId: completed.attemptId,
      },
    );
    return { ...completed, status: "finalized" as const, result };
  },
});

function assertWorkerToken(token: string) {
  const expected = process.env.SECURITY_SCAN_WORKER_TOKEN;
  if (!expected || token !== expected) throw new ConvexError("Unauthorized");
}

function buildCheckClaimId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

async function scheduleSecretPublishBlockedEmail(
  ctx: MutationCtx,
  attempt: {
    _id: Id<"publishAttempts">;
    userId: Id<"users">;
    kind: "skill" | "package";
    slug: string;
    version: string;
  },
) {
  const user = await ctx.db.get(attempt.userId);
  if (!user?.email) return;
  await ctx.scheduler.runAfter(
    0,
    internal.emailsNode.sendSecretPublishBlockedNotificationInternal,
    {
      attemptId: attempt._id,
      userId: attempt.userId,
      to: user.email,
      handle: user.handle,
      artifact: {
        kind: attempt.kind === "skill" ? "skill" : "plugin",
        name: attempt.slug,
      },
      version: attempt.version,
    },
  );
}

async function requireSkillPublishAttempt(
  ctx: { db: { get: (id: Id<"publishAttempts">) => Promise<unknown> } },
  attemptId: Id<"publishAttempts">,
) {
  const attempt = await ctx.db.get(attemptId);
  if (!attempt || typeof attempt !== "object") {
    throw new ConvexError("Publish attempt not found.");
  }
  const typed = attempt as {
    _id: Id<"publishAttempts">;
    kind: "skill" | "package";
    status:
      | "pending_checks"
      | "ready_to_finalize"
      | "finalizing"
      | "finalized"
      | "blocked"
      | "failed"
      | "expired";
    skillInsertArgs: unknown;
    followup: { skipWebhook?: boolean; ownerHandle?: string };
    userId: Id<"users">;
    ownerPublisherId?: Id<"publishers">;
    slug: string;
    version: string;
    displayName: string;
    artifactFingerprint: string;
    createdAt: number;
    finalizationClaimId?: string;
    finalizationClaimExpiresAt?: number;
    result?: {
      skillId: Id<"skills">;
      versionId: Id<"skillVersions">;
      embeddingId?: Id<"skillEmbeddings">;
      status?: "pending" | "published";
      slug?: string;
      version?: string;
      publicationStatus?: "pending" | "published";
      attemptId?: Id<"publishAttempts">;
    };
    skillId?: Id<"skills">;
    skillVersionId?: Id<"skillVersions">;
  };
  if (
    typed.kind !== "skill" ||
    !typed.followup ||
    (!typed.skillVersionId && !typed.skillInsertArgs)
  ) {
    throw new ConvexError("Skill publish attempt not found.");
  }
  return typed as typeof typed & {
    kind: "skill";
    skillId?: Id<"skills">;
    skillVersionId?: Id<"skillVersions">;
    skillInsertArgs?: unknown;
    followup: { skipWebhook?: boolean; ownerHandle?: string };
  };
}

async function requirePackagePublishAttempt(
  ctx: { db: { get: (id: Id<"publishAttempts">) => Promise<unknown> } },
  attemptId: Id<"publishAttempts">,
) {
  const attempt = await ctx.db.get(attemptId);
  if (!attempt || typeof attempt !== "object") {
    throw new ConvexError("Publish attempt not found.");
  }
  const typed = attempt as {
    _id: Id<"publishAttempts">;
    kind: "skill" | "package";
    status:
      | "pending_checks"
      | "ready_to_finalize"
      | "finalizing"
      | "finalized"
      | "blocked"
      | "failed"
      | "expired";
    packageInsertArgs?: unknown;
    packageFollowup?: unknown;
    packageId?: Id<"packages">;
    packageReleaseId?: Id<"packageReleases">;
    finalizationClaimId?: string;
    finalizationClaimExpiresAt?: number;
    result?: {
      ok: true;
      packageId: Id<"packages">;
      releaseId: Id<"packageReleases">;
    };
  };
  if (typed.kind !== "package" || (!typed.packageReleaseId && !typed.packageInsertArgs)) {
    throw new ConvexError("Package publish attempt not found.");
  }
  return typed;
}

function buildSkillPublishFollowup(attempt: {
  followup: { skipWebhook?: boolean; ownerHandle?: string };
  slug: string;
  version: string;
  displayName: string;
}) {
  return {
    ...attempt.followup,
    slug: attempt.slug,
    version: attempt.version,
    displayName: attempt.displayName,
  };
}
