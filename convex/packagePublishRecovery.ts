import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { internalAction, internalMutation, internalQuery } from "./functions";
import { requireGitHubAccountAge } from "./lib/githubAccount";
import {
  assertManualPackagePublisher,
  assertRecoveryArtifact,
  manualPackageRecovery,
  recoveryReason,
  type ManualPackageRecovery,
} from "./lib/packagePublishRecovery";
import { hashToken } from "./lib/tokens";
import { requestPublishAttemptDispatch } from "./publishAttemptDispatch";

type AuthorityArgs = { attemptId: string; actorUserId: Id<"users">; apiTokenId: Id<"apiTokens"> };
const contextRef = makeFunctionReference<
  "query",
  AuthorityArgs,
  Awaited<ReturnType<typeof context>>
>("packagePublishRecovery:contextInternal");
const commitRef = makeFunctionReference<
  "mutation",
  AuthorityArgs & { manualOverrideReason: string },
  RecoveryResult
>("packagePublishRecovery:commitInternal");
const authorityArgs = {
  attemptId: v.string(),
  actorUserId: v.id("users"),
  apiTokenId: v.id("apiTokens"),
};

async function context(
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  args: { attemptId: string; actorUserId: Id<"users">; apiTokenId: Id<"apiTokens"> },
) {
  const id = ctx.db.normalizeId("publishAttempts", args.attemptId);
  const attempt = id ? await ctx.db.get(id) : null;
  const pkg = attempt?.packageId ? await ctx.db.get(attempt.packageId) : null;
  if (!attempt || attempt.kind !== "package" || !pkg || !attempt.packageReleaseId)
    throw new ConvexError("Publish attempt not found");
  try {
    await assertManualPackagePublisher(ctx, pkg, args.actorUserId, args.apiTokenId);
  } catch {
    throw new ConvexError("Publish attempt not found");
  }
  const release = await ctx.db.get(attempt.packageReleaseId);
  return { attempt, pkg, release };
}

export const contextInternal = internalQuery({ args: authorityArgs, handler: context });

export const recoverInternal = internalAction({
  args: { ...authorityArgs, manualOverrideReason: v.string() },
  handler: async (ctx, args): Promise<RecoveryResult> => {
    recoveryReason(args.manualOverrideReason);
    await ctx.runQuery(contextRef, argsWithoutReason(args));
    await requireGitHubAccountAge(ctx, args.actorUserId);
    return await ctx.runMutation(commitRef, args);
  },
});

function argsWithoutReason(args: {
  attemptId: string;
  actorUserId: Id<"users">;
  apiTokenId: Id<"apiTokens">;
}) {
  return { attemptId: args.attemptId, actorUserId: args.actorUserId, apiTokenId: args.apiTokenId };
}

export type RecoveryResult = {
  ok: true;
  attemptId: Id<"publishAttempts">;
  recoveredFromAttemptId: Id<"publishAttempts">;
  packageId: Id<"packages">;
  releaseId: Id<"packageReleases">;
  name: string;
  version: string;
  status: Doc<"publishAttempts">["status"];
  publicationStatus: "pending" | "published" | "blocked" | "failed" | "expired";
  reused: boolean;
};
function result(
  attempt: Doc<"publishAttempts">,
  from: Id<"publishAttempts">,
  reused: boolean,
): RecoveryResult {
  const status = attempt.status;
  return {
    ok: true,
    attemptId: attempt._id,
    recoveredFromAttemptId: from,
    packageId: attempt.packageId!,
    releaseId: attempt.packageReleaseId!,
    name: attempt.slug,
    version: attempt.version,
    status,
    publicationStatus:
      status === "finalized"
        ? "published"
        : status === "failed" || status === "blocked" || status === "expired"
          ? status
          : "pending",
    reused,
  };
}

export const commitInternal = internalMutation({
  args: { ...authorityArgs, manualOverrideReason: v.string() },
  handler: async (ctx, args): Promise<RecoveryResult> => {
    const reason = recoveryReason(args.manualOverrideReason);
    const { attempt, pkg, release } = await context(ctx, args);
    const idempotencyKey = `manual-recovery:${attempt._id}:${args.apiTokenId}:${await hashToken(reason)}`;
    const existing = await ctx.db
      .query("publishAttempts")
      .withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", idempotencyKey))
      .unique();
    if (existing) {
      if (
        existing.kind !== "package" ||
        existing.userId !== args.actorUserId ||
        existing.packageId !== pkg._id ||
        existing.packageReleaseId !== attempt.packageReleaseId
      ) {
        throw new ConvexError("Recovery replay binding changed");
      }
      // A blocked secret scan deletes its release and files. Replay reports the
      // already-recorded outcome under current publisher authority; it never republishes.
      return result(existing, attempt._id, true);
    }
    if (!release) throw new ConvexError("Publish attempt not found");
    if (
      attempt.status !== "failed" ||
      release.publicationStatus !== "pending" ||
      (release.publishAttemptId !== undefined && release.publishAttemptId !== attempt._id)
    )
      throw new ConvexError("Only the current failed staged publish attempt can be recovered");
    const now = Date.now();
    if (release.publishAttemptId === undefined) {
      // Older staged attempts acquired the backlink only after successful scans.
      // Validate that no live or finalized sibling owns this exact release first.
      for (const status of [
        "pending_checks",
        "ready_to_finalize",
        "finalizing",
        "finalized",
      ] as const) {
        const other = await ctx.db
          .query("publishAttempts")
          .withIndex("by_kind_status_slug_version_created", (q) =>
            q
              .eq("kind", "package")
              .eq("status", status)
              .eq("slug", pkg.name)
              .eq("version", release.version),
          )
          .filter((q) => q.eq(q.field("packageReleaseId"), release._id))
          .first();
        if (other) throw new ConvexError("Another publish attempt owns this staged release");
      }
    }
    if ((attempt.checkClaimExpiresAt ?? 0) > now || (attempt.finalizationClaimExpiresAt ?? 0) > now)
      throw new ConvexError("Publish attempt still has an active claim");
    const followup = attempt.packageFollowup as Record<string, unknown> | undefined;
    const pending = release.pendingPublication as Record<string, unknown> | undefined;
    const priorRecovery = manualPackageRecovery(followup);
    if (
      priorRecovery &&
      JSON.stringify(manualPackageRecovery(pending)) !== JSON.stringify(priorRecovery)
    )
      throw new ConvexError("Original manual recovery binding changed");
    const originalTokenId = priorRecovery?.originalTokenId ?? followup?.trustedPublishTokenId;
    if (typeof originalTokenId !== "string")
      throw new ConvexError("Original OpenClaw authorization is missing");
    const tokenId = ctx.db.normalizeId("packagePublishTokens", originalTokenId);
    if (!tokenId || !followup || !pending)
      throw new ConvexError("Original OpenClaw authorization is missing");
    const originalToken = await assertRecoveryArtifact(ctx, pkg, release, attempt, tokenId);
    if (
      !priorRecovery &&
      (followup.trustedPublishAuthorizationVersion !== 2 ||
        pending.trustedPublishTokenId !== tokenId ||
        pending.trustedPublishAuthorizationVersion !== 2 ||
        followup.trustedPublishInventoryDigest !== originalToken.inventoryDigest ||
        pending.trustedPublishInventoryDigest !== originalToken.inventoryDigest)
    )
      throw new ConvexError("Original OpenClaw authorization binding changed");
    const recovery: ManualPackageRecovery = {
      kind: "manual-package-recovery",
      fromAttemptId: attempt._id,
      originalTokenId: tokenId,
      actorUserId: args.actorUserId,
      apiTokenId: args.apiTokenId,
      reason,
      ownerUserId: pkg.ownerUserId,
      ...(pkg.ownerPublisherId ? { ownerPublisherId: pkg.ownerPublisherId } : {}),
      inventoryDigest: originalToken.inventoryDigest!,
      artifactFingerprint: attempt.artifactFingerprint,
    };
    // A new manual attempt supersedes authorization, never the failed history or artifact.
    const {
      trustedPublishTokenId: _token,
      trustedPublishAuthorizationVersion: _version,
      trustedPublishInventoryDigest: _inventory,
      githubActionsAudit: _github,
      manualOverrideAudit: _override,
      ...manualFollowup
    } = followup;
    const successorId = await ctx.db.insert("publishAttempts", {
      kind: "package",
      status: "pending_checks",
      userId: args.actorUserId,
      ownerUserId: attempt.ownerUserId,
      ownerPublisherId: attempt.ownerPublisherId,
      packageId: pkg._id,
      packageReleaseId: release._id,
      createdNewParent: attempt.createdNewParent,
      slug: attempt.slug,
      displayName: attempt.displayName,
      version: attempt.version,
      idempotencyKey,
      artifactFingerprint: attempt.artifactFingerprint,
      files: attempt.files,
      clawpackStorageId: attempt.clawpackStorageId,
      scanContext: attempt.scanContext,
      packageInsertArgs: attempt.packageInsertArgs,
      packageFollowup: { ...manualFollowup, manualRecovery: recovery },
      checks: { trufflehog: { status: "pending" }, clawscan: { status: "pending" } },
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 30 * 24 * 60 * 60 * 1000,
    });
    const {
      trustedPublishTokenId: _pendingToken,
      trustedPublishAuthorizationVersion: _pendingVersion,
      trustedPublishInventoryDigest: _pendingInventory,
      ...manualPending
    } = pending;
    await ctx.db.patch(release._id, {
      publishAttemptId: successorId,
      pendingPublication: { ...manualPending, manualRecovery: recovery },
    });
    await ctx.db.insert("auditLogs", {
      actorUserId: args.actorUserId,
      action: "package.publish.recover",
      targetType: "package",
      targetId: pkg._id,
      metadata: {
        fromAttemptId: attempt._id,
        attemptId: successorId,
        releaseId: release._id,
        originalTokenId: tokenId,
        reason,
        inventoryDigest: recovery.inventoryDigest,
      },
      createdAt: now,
    });
    await requestPublishAttemptDispatch(ctx, successorId);
    const successor = await ctx.db.get(successorId);
    if (!successor) throw new ConvexError("Recovery attempt could not be created");
    return result(successor, attempt._id, false);
  },
});
