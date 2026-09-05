import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { resolvePackageReleaseScanStatus } from "./packageSecurity";
import { assertCanManageOwnedResource, isPublisherActive } from "./publishers";
import { buildPackageInventoryDigest } from "./skills";
import { matchesStorageSha256 } from "./storageDigests";

type DbCtx = Pick<QueryCtx | MutationCtx, "db">;
export type ManualPackageRecovery = {
  kind: "manual-package-recovery";
  fromAttemptId: Id<"publishAttempts">;
  originalTokenId: Id<"packagePublishTokens">;
  actorUserId: Id<"users">;
  apiTokenId: Id<"apiTokens">;
  reason: string;
  ownerUserId: Id<"users">;
  ownerPublisherId?: Id<"publishers">;
  inventoryDigest: string;
  artifactFingerprint: string;
};

export function manualPackageRecovery(value: unknown): ManualPackageRecovery | undefined {
  if (!value || typeof value !== "object") return undefined;
  const recovery = (value as Record<string, unknown>).manualRecovery;
  if (recovery === undefined) return undefined;
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) {
    throw new ConvexError("Recovered package publication authorization is malformed");
  }
  const record = recovery as Record<string, unknown>;
  if (
    record.kind !== "manual-package-recovery" ||
    [
      "fromAttemptId",
      "originalTokenId",
      "actorUserId",
      "apiTokenId",
      "reason",
      "ownerUserId",
      "inventoryDigest",
      "artifactFingerprint",
    ].some((key) => typeof record[key] !== "string" || !record[key]) ||
    (record.ownerPublisherId !== undefined && typeof record.ownerPublisherId !== "string")
  )
    throw new ConvexError("Recovered package publication authorization is malformed");
  return recovery as ManualPackageRecovery;
}

export function recoveryReason(value: string) {
  const reason = value.trim();
  if (!reason || reason.length > 500)
    throw new ConvexError("manualOverrideReason must contain 1–500 characters");
  return reason;
}

export async function assertManualPackagePublisher(
  ctx: DbCtx,
  pkg: Doc<"packages">,
  actorUserId: Id<"users">,
  apiTokenId: Id<"apiTokens">,
) {
  const [actor, token, owner, publisher] = await Promise.all([
    ctx.db.get(actorUserId),
    ctx.db.get(apiTokenId),
    ctx.db.get(pkg.ownerUserId),
    pkg.ownerPublisherId ? ctx.db.get(pkg.ownerPublisherId) : null,
  ]);
  if (
    !actor ||
    actor.deletedAt ||
    actor.deactivatedAt ||
    !token ||
    token.userId !== actor._id ||
    token.revokedAt
  ) {
    throw new ConvexError("Recovered package publication authorization is revoked or unavailable");
  }
  if (
    pkg.softDeletedAt ||
    !owner ||
    owner.deletedAt ||
    owner.deactivatedAt ||
    (pkg.ownerPublisherId && !isPublisherActive(publisher))
  ) {
    throw new ConvexError("Recovered package publication authorization owner is unavailable");
  }
  // Match ordinary manual publication: a platform role is not publisher membership.
  try {
    await assertCanManageOwnedResource(ctx, {
      actor,
      ownerUserId: pkg.ownerUserId,
      ownerPublisherId: pkg.ownerPublisherId,
      allowedPublisherRoles: ["publisher"],
      allowPlatformAdmin: false,
    });
  } catch (error) {
    if (!(error instanceof ConvexError)) throw error;
    // The finalizer must terminalize a lost grant, not repeatedly retry it.
    throw new ConvexError(
      "Recovered package publication authorization publisher access was revoked",
    );
  }
  return actor;
}

export async function assertRecoveryArtifact(
  ctx: DbCtx,
  pkg: Doc<"packages">,
  release: Doc<"packageReleases">,
  attempt: Doc<"publishAttempts">,
  originalTokenId: Id<"packagePublishTokens">,
) {
  // The consumed grant records provenance only; fresh manual authority is checked separately.
  const token = await ctx.db.get(originalTokenId);
  const fingerprint = release.integritySha256;
  if (
    (pkg.family !== "code-plugin" && pkg.family !== "bundle-plugin") ||
    release.packageId !== pkg._id ||
    attempt.packageId !== pkg._id ||
    attempt.packageReleaseId !== release._id ||
    attempt.status !== "failed" ||
    attempt.slug !== pkg.name ||
    attempt.version !== release.version ||
    attempt.ownerUserId !== pkg.ownerUserId ||
    attempt.ownerPublisherId !== pkg.ownerPublisherId ||
    attempt.artifactFingerprint !== fingerprint ||
    JSON.stringify(attempt.files) !== JSON.stringify(release.files) ||
    attempt.clawpackStorageId !== release.clawpackStorageId ||
    !token ||
    token.repository !== "openclaw/openclaw" ||
    token.authorizationVersion !== 2 ||
    !token.consumedAt ||
    (token.scope ?? "publish") !== "publish" ||
    token.packageId !== pkg._id ||
    token.version !== release.version ||
    !token.inventoryDigest ||
    token.inventoryDigest !== (await buildPackageInventoryDigest(release.files))
  )
    throw new ConvexError(
      "Recovered package publication authorization does not match the original artifact",
    );
  if (
    release.softDeletedAt ||
    release.ownerDeletedAt ||
    release.manualModeration?.state === "quarantined" ||
    release.manualModeration?.state === "revoked" ||
    resolvePackageReleaseScanStatus(release) === "malicious" ||
    attempt.checks.trufflehog.status === "blocked" ||
    attempt.checks.clawscan.status === "blocked"
  ) {
    throw new ConvexError("Recovered package publication authorization is blocked by moderation");
  }
  // Storage IDs bind immutable bytes; the original IDs and digests matched above.
  for (const file of release.files) {
    const stored = await ctx.db.system.get(file.storageId);
    if (!stored || stored.size !== file.size || !matchesStorageSha256(stored.sha256, file.sha256))
      throw new ConvexError("Recovered package publication authorization artifact storage changed");
  }
  if (release.clawpackStorageId) {
    const stored = await ctx.db.system.get(release.clawpackStorageId);
    if (
      !stored ||
      stored.size !== release.clawpackSize ||
      !release.clawpackSha256 ||
      !matchesStorageSha256(stored.sha256, release.clawpackSha256)
    )
      throw new ConvexError("Recovered package publication authorization archive storage changed");
  }
  return token;
}

export async function assertManualRecoveryFinalization(
  ctx: DbCtx,
  pkg: Doc<"packages">,
  release: Doc<"packageReleases">,
  attemptId: Id<"publishAttempts"> | undefined,
  claimId: string | undefined,
) {
  const recovery = manualPackageRecovery(release.pendingPublication);
  if (!recovery || !attemptId || !claimId || release.publishAttemptId !== attemptId)
    throw new ConvexError("Recovered package publication authorization binding changed");
  const [attempt, predecessor] = await Promise.all([
    ctx.db.get(attemptId),
    ctx.db.get(recovery.fromAttemptId),
  ]);
  if (
    !attempt ||
    !predecessor ||
    JSON.stringify(manualPackageRecovery(attempt.packageFollowup)) !== JSON.stringify(recovery) ||
    attempt.status !== "finalizing" ||
    attempt.finalizationClaimId !== claimId ||
    (attempt.finalizationClaimExpiresAt ?? 0) <= Date.now() ||
    attempt.checks.trufflehog.status !== "clean" ||
    attempt.checks.clawscan.status !== "clean"
  )
    throw new ConvexError("Recovered package publication authorization claim or checks changed");
  await assertManualPackagePublisher(ctx, pkg, recovery.actorUserId, recovery.apiTokenId);
  if (
    pkg.ownerUserId !== recovery.ownerUserId ||
    pkg.ownerPublisherId !== recovery.ownerPublisherId
  )
    throw new ConvexError("Recovered package publication authorization owner changed");
  await assertRecoveryArtifact(ctx, pkg, release, predecessor, recovery.originalTokenId);
  return recovery;
}
