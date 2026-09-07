import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { action, internalMutation, internalQuery } from "./functions";
import {
  hasSettledSkillCardInputs,
  MAX_SKILL_CARD_FILE_BYTES,
  normalizeSkillCardSecurityStatus,
  replaceGeneratedSkillCardFile,
  SKILL_CARD_FILE_PATH,
  sourceSkillVersionFiles,
} from "./lib/skillCards";
import { redactWorkerPublicText } from "./lib/workerTextRedaction";

const DEFAULT_LEASE_MS = 60 * 60 * 1000;
const DEFAULT_SKILL_CARD_CLAIM_LIMIT = 6;
const MAX_PARALLEL_SKILL_CARD_JOBS = 64;
const MAX_ATTEMPTS = 3;

const jobSourceValidator = v.union(v.literal("publish"), v.literal("scan"), v.literal("manual"));

type SkillCardJob = Doc<"skillCardGenerationJobs">;
type SkillVersionFile = Doc<"skillVersions">["files"][number];

function sanitizeWorkerErrorDetail(error: string, maxChars = 2000) {
  return redactWorkerPublicText(error).slice(0, maxChars);
}

type SkillCardTarget = {
  job: SkillCardJob;
  skill?: Doc<"skills">;
  version?: Doc<"skillVersions">;
  owner?: Doc<"users"> | null;
  publisher?: Doc<"publishers"> | null;
  missing?: true;
};

const internalRefs = internal as unknown as {
  skillCards: {
    claimQueuedJobsInternal: unknown;
    getJobTargetInternal: unknown;
    failJobInternal: unknown;
    attachCardAndSucceedJobInternal: unknown;
    enqueueForVersionInternal: unknown;
  };
};

async function runQueryRef<T>(
  ctx: { runQuery: (ref: never, args: never) => Promise<unknown> },
  ref: unknown,
  args: unknown,
): Promise<T> {
  return (await ctx.runQuery(ref as never, args as never)) as T;
}

async function runMutationRef<T>(
  ctx: { runMutation: (ref: never, args: never) => Promise<unknown> },
  ref: unknown,
  args: unknown,
): Promise<T> {
  return (await ctx.runMutation(ref as never, args as never)) as T;
}

function assertWorkerToken(token: string) {
  // Shared Convex worker credential used by security and Skill Card workers.
  const expected = process.env.SECURITY_SCAN_WORKER_TOKEN;
  if (!expected || token !== expected) throw new ConvexError("Unauthorized");
}

function normalizeLimit(limit: number | undefined) {
  return Math.max(
    1,
    Math.min(Math.floor(limit ?? DEFAULT_SKILL_CARD_CLAIM_LIMIT), MAX_PARALLEL_SKILL_CARD_JOBS),
  );
}

function generatedBundleFingerprints(
  entries: Array<{ fingerprint: string; kind?: "source" | "generated-bundle" }>,
) {
  return entries
    .filter((entry) => entry.kind === "generated-bundle")
    .map((entry) => entry.fingerprint);
}

function clawScanRiskFindings(version: Doc<"skillVersions">) {
  return (version.llmAnalysis?.agenticRiskFindings ?? []).map((finding) => ({
    category: finding.categoryLabel,
    status: finding.status,
    severity: finding.severity,
    confidence: finding.confidence,
    userImpact: finding.userImpact,
    recommendation: finding.recommendation,
  }));
}

function versionClawScanVerdict(version: Doc<"skillVersions">) {
  const status = normalizeSkillCardSecurityStatus(
    version.llmAnalysis?.verdict ?? version.llmAnalysis?.status,
  );
  return status === "pending" ? null : status;
}

async function enqueueSkillCardJob(
  ctx: MutationCtx,
  args: {
    versionId: Id<"skillVersions">;
    source: "publish" | "scan" | "manual";
    priority?: number;
    requireMissingCard?: boolean;
  },
) {
  const version = await ctx.db.get(args.versionId);
  if (!version || version.softDeletedAt) return { ok: true as const, skipped: "missing" as const };
  if (!hasSettledSkillCardInputs(version)) {
    return { ok: true as const, skipped: "scan-not-settled" as const };
  }
  if (
    args.requireMissingCard &&
    version.files.some((file) => file.path.trim().toLowerCase() === SKILL_CARD_FILE_PATH)
  ) {
    return { ok: true as const, skipped: "already-has-card" as const };
  }

  const now = Date.now();
  const queuedJobs = await ctx.db
    .query("skillCardGenerationJobs")
    .withIndex("by_skill_version_status", (q) =>
      q.eq("skillVersionId", args.versionId).eq("status", "queued"),
    )
    .take(1);
  const queued = queuedJobs[0];
  if (queued) {
    await ctx.db.patch(queued._id, {
      source: args.source,
      priority: Math.max(queued.priority, args.priority ?? 0),
      nextRunAt: Math.min(queued.nextRunAt, now),
      updatedAt: now,
    });
    return { ok: true as const, jobId: queued._id, alreadyQueued: true as const };
  }

  const jobId = await ctx.db.insert("skillCardGenerationJobs", {
    skillId: version.skillId,
    skillVersionId: args.versionId,
    status: "queued",
    source: args.source,
    priority: args.priority ?? 0,
    nextRunAt: now,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  });
  return { ok: true as const, jobId, alreadyQueued: false as const };
}

export const enqueueForVersionInternal = internalMutation({
  args: {
    versionId: v.id("skillVersions"),
    source: jobSourceValidator,
    priority: v.optional(v.number()),
    requireMissingCard: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => enqueueSkillCardJob(ctx, args),
});

export const claimQueuedJobsInternal = internalMutation({
  args: {
    workerId: v.string(),
    limit: v.number(),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const limit = normalizeLimit(args.limit);
    const leaseMs = Math.max(60_000, Math.min(args.leaseMs ?? DEFAULT_LEASE_MS, 60 * 60 * 1000));

    const running = await ctx.db
      .query("skillCardGenerationJobs")
      .withIndex("by_status_and_lease_expires_at", (q) => q.eq("status", "running"))
      .take(MAX_PARALLEL_SKILL_CARD_JOBS * 4);
    for (const job of running) {
      if ((job.leaseExpiresAt ?? 0) <= now) {
        await ctx.db.patch(job._id, {
          status: "queued",
          leaseToken: undefined,
          leaseExpiresAt: undefined,
          workerId: undefined,
          nextRunAt: now,
          updatedAt: now,
        });
      }
    }
    const activeRunningJobs = running.filter((job) => (job.leaseExpiresAt ?? 0) > now);
    const activeRunning = activeRunningJobs.length;
    const activeVersionIds = new Set(activeRunningJobs.map((job) => job.skillVersionId));
    const capacity = Math.max(0, Math.min(limit, MAX_PARALLEL_SKILL_CARD_JOBS - activeRunning));
    if (capacity === 0) return [];

    const queued = await ctx.db
      .query("skillCardGenerationJobs")
      .withIndex("by_status_and_next_run_at", (q) => q.eq("status", "queued").lte("nextRunAt", now))
      .order("asc")
      .take(capacity * 4);
    const ready = queued
      .filter((job) => job.nextRunAt <= now && !activeVersionIds.has(job.skillVersionId))
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
      .slice(0, capacity);

    const claimed = [];
    for (const job of ready) {
      if (activeVersionIds.has(job.skillVersionId)) continue;
      const leaseToken = crypto.randomUUID();
      await ctx.db.patch(job._id, {
        status: "running",
        attempts: job.attempts + 1,
        leaseToken,
        leaseExpiresAt: now + leaseMs,
        workerId: args.workerId,
        lastError: undefined,
        updatedAt: now,
      });
      claimed.push({
        ...job,
        status: "running" as const,
        attempts: job.attempts + 1,
        leaseToken,
        leaseExpiresAt: now + leaseMs,
        workerId: args.workerId,
      });
      activeVersionIds.add(job.skillVersionId);
    }
    return claimed;
  },
});

export const getJobTargetInternal = internalQuery({
  args: {
    jobId: v.id("skillCardGenerationJobs"),
  },
  handler: async (ctx, args): Promise<SkillCardTarget | null> => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    const version = await ctx.db.get(job.skillVersionId);
    if (!version || version.softDeletedAt) return { job, missing: true as const };
    const skill = await ctx.db.get(version.skillId);
    if (!skill || skill.softDeletedAt) return { job, missing: true as const };
    const [owner, publisher] = await Promise.all([
      ctx.db.get(skill.ownerUserId),
      skill.ownerPublisherId ? ctx.db.get(skill.ownerPublisherId) : Promise.resolve(null),
    ]);
    return { job, skill, version, owner, publisher };
  },
});

function buildEvidencePacket(
  target: Required<Omit<SkillCardTarget, "missing">>,
  sourceFileInputs: SkillVersionFile[],
) {
  const { skill, version, owner, publisher } = target;
  const publisherHandle = publisher?.handle ?? owner?.handle ?? null;
  const metadata =
    version.parsed.metadata &&
    typeof version.parsed.metadata === "object" &&
    !Array.isArray(version.parsed.metadata)
      ? { ...(version.parsed.metadata as Record<string, unknown>) }
      : (version.parsed.metadata ?? null);
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    delete (metadata as Record<string, unknown>).source;
  }
  return {
    schemaVersion: 1,
    generatedBy: "clawhub.skill-card.v1",
    generatedAt: Date.now(),
    publisher: {
      handle: publisher?.handle ?? owner?.handle ?? null,
      displayName: publisher?.displayName ?? owner?.displayName ?? owner?.name ?? null,
      kind: publisher?.kind ?? "user",
      source: "server-resolved-owner",
    },
    provenance: version.sourceProvenance
      ? {
          ...version.sourceProvenance,
          source: "server-resolved-github-import",
        }
      : {
          source: "unavailable",
          reason: "No server-resolved GitHub import provenance is stored for this version.",
        },
    skill: {
      slug: skill.slug,
      displayName: skill.displayName,
      summary: skill.summary ?? null,
      badges: skill.badges ?? null,
      pageUrl: publisherHandle
        ? `https://clawhub.ai/${publisherHandle}/skills/${skill.slug}`
        : `https://clawhub.ai/api/v1/skills/${skill.slug}`,
    },
    release: {
      version: version.version,
      createdAt: version.createdAt,
      changelog: version.changelog,
      changelogSource: version.changelogSource ?? null,
      sourceFingerprint: version.fingerprint ?? null,
      sha256hash: version.sha256hash ?? null,
    },
    license: version.parsed.license ?? null,
    parsed: {
      clawdis: version.parsed.clawdis ?? null,
      metadata,
    },
    fileHashes: sourceFileInputs.map((file) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256,
      contentType: file.contentType ?? null,
    })),
    security: {
      source: "clawscan",
      verdict: versionClawScanVerdict(version),
      summary: version.llmAnalysis?.summary ?? null,
      guidance: version.llmAnalysis?.guidance ?? null,
      riskFindings: clawScanRiskFindings(version),
    },
  };
}

export const claimSkillCardJobs = action({
  args: {
    token: v.string(),
    workerId: v.string(),
    limit: v.optional(v.number()),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertWorkerToken(args.token);
    const jobs = await runMutationRef<Array<SkillCardJob & { leaseToken: string }>>(
      ctx,
      internalRefs.skillCards.claimQueuedJobsInternal,
      {
        workerId: args.workerId,
        limit: normalizeLimit(args.limit),
        leaseMs: args.leaseMs,
      },
    );

    const hydrated = [];
    for (const job of jobs) {
      const target = await runQueryRef<SkillCardTarget | null>(
        ctx,
        internalRefs.skillCards.getJobTargetInternal,
        { jobId: job._id },
      );
      if (!target || target.missing || !target.skill || !target.version) {
        await runMutationRef(ctx, internalRefs.skillCards.failJobInternal, {
          jobId: job._id,
          leaseToken: job.leaseToken,
          error: "Skill version missing",
        });
        continue;
      }

      const fingerprintEntries = (await runQueryRef<
        Array<{ fingerprint: string; kind?: "source" | "generated-bundle" }>
      >(ctx, internal.skills.listVersionFingerprintsInternal, {
        skillVersionId: target.version._id,
      })) as Array<{ fingerprint: string; kind?: "source" | "generated-bundle" }>;
      const files = sourceSkillVersionFiles(target.version.files, {
        generatedBundleFingerprints: generatedBundleFingerprints(fingerprintEntries),
      });
      const fileUrls = [];
      let missingStoragePath: string | null = null;
      for (const file of files) {
        const url = await ctx.storage.getUrl(file.storageId);
        if (!url) {
          missingStoragePath = file.path;
          break;
        }
        fileUrls.push({
          path: file.path,
          size: file.size,
          sha256: file.sha256,
          contentType: file.contentType,
          url,
        });
      }
      if (missingStoragePath) {
        await runMutationRef(ctx, internalRefs.skillCards.failJobInternal, {
          jobId: job._id,
          leaseToken: job.leaseToken,
          error: `Artifact file unavailable: ${missingStoragePath}`,
        });
        continue;
      }

      hydrated.push({
        job,
        target: {
          skill: target.skill,
          version: target.version,
          evidence: buildEvidencePacket(
            {
              job,
              skill: target.skill,
              version: target.version,
              owner: target.owner ?? null,
              publisher: target.publisher ?? null,
            },
            files,
          ),
          files: fileUrls,
        },
      });
    }
    return hydrated;
  },
});

export const failJobInternal = internalMutation({
  args: {
    jobId: v.id("skillCardGenerationJobs"),
    leaseToken: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.leaseToken !== args.leaseToken) throw new ConvexError("Lease mismatch");
    const now = Date.now();
    const retry = job.attempts < MAX_ATTEMPTS;
    const error = sanitizeWorkerErrorDetail(args.error);
    await ctx.db.patch(args.jobId, {
      status: retry ? "queued" : "failed",
      lastError: error,
      nextRunAt: retry ? now + Math.min(30 * 60 * 1000, 2 ** job.attempts * 60_000) : job.nextRunAt,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      workerId: undefined,
      updatedAt: now,
    });
    return { ok: true as const, retry };
  },
});

export const attachCardAndSucceedJobInternal = internalMutation({
  args: {
    jobId: v.id("skillCardGenerationJobs"),
    leaseToken: v.string(),
    runId: v.optional(v.string()),
    cardFile: v.object({
      path: v.string(),
      size: v.number(),
      storageId: v.id("_storage"),
      sha256: v.string(),
      contentType: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.leaseToken !== args.leaseToken) throw new ConvexError("Lease mismatch");
    const version = await ctx.db.get(job.skillVersionId);
    if (!version || version.softDeletedAt) throw new ConvexError("Skill version not found");

    const now = Date.now();
    const { files, bundleFingerprint } = await replaceGeneratedSkillCardFile(version.files, {
      ...args.cardFile,
      path: SKILL_CARD_FILE_PATH,
      contentType: args.cardFile.contentType ?? "text/markdown; charset=utf-8",
    });
    await ctx.db.patch(version._id, { files });

    const existingBundleFingerprints = await ctx.db
      .query("skillVersionFingerprints")
      .withIndex("by_version_kind", (q) =>
        q.eq("versionId", version._id).eq("kind", "generated-bundle"),
      )
      .collect();
    const hasCurrentBundleFingerprint = existingBundleFingerprints.some(
      (entry) => entry.fingerprint === bundleFingerprint,
    );
    // Preserve historical generated bundle fingerprints so installs that
    // include an older generated skill-card.md still resolve as this version.
    if (!hasCurrentBundleFingerprint) {
      await ctx.db.insert("skillVersionFingerprints", {
        skillId: version.skillId,
        versionId: version._id,
        fingerprint: bundleFingerprint,
        kind: "generated-bundle",
        createdAt: now,
      });
    }

    await ctx.db.patch(args.jobId, {
      status: "succeeded",
      runId: args.runId,
      completedAt: now,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      workerId: undefined,
      updatedAt: now,
    });
    return { ok: true as const, bundleFingerprint };
  },
});

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export const completeSkillCardJob = action({
  args: {
    token: v.string(),
    jobId: v.id("skillCardGenerationJobs"),
    leaseToken: v.string(),
    markdown: v.string(),
    runId: v.optional(v.string()),
  },
  handler: async (ctx: ActionCtx, args) => {
    assertWorkerToken(args.token);
    const trimmed = args.markdown.trim();
    if (!trimmed) throw new ConvexError("Generated skill-card.md is empty");
    const encoded = new TextEncoder().encode(args.markdown);
    if (encoded.byteLength > MAX_SKILL_CARD_FILE_BYTES) {
      throw new ConvexError("Generated skill-card.md exceeds 200KB limit");
    }
    const sha256 = await sha256Hex(args.markdown);
    const storageId = await ctx.storage.store(
      new Blob([args.markdown], { type: "text/markdown; charset=utf-8" }),
    );
    try {
      return await runMutationRef(ctx, internalRefs.skillCards.attachCardAndSucceedJobInternal, {
        jobId: args.jobId,
        leaseToken: args.leaseToken,
        runId: args.runId,
        cardFile: {
          path: SKILL_CARD_FILE_PATH,
          size: encoded.byteLength,
          storageId,
          sha256,
          contentType: "text/markdown; charset=utf-8",
        },
      });
    } catch (error) {
      await ctx.storage.delete(storageId).catch(() => undefined);
      throw error;
    }
  },
});

export const failSkillCardJob = action({
  args: {
    token: v.string(),
    jobId: v.id("skillCardGenerationJobs"),
    leaseToken: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    assertWorkerToken(args.token);
    return await runMutationRef(ctx, internalRefs.skillCards.failJobInternal, {
      jobId: args.jobId,
      leaseToken: args.leaseToken,
      error: args.error,
    });
  },
});
