/// <reference types="vite/client" />
/* @vitest-environment edge-runtime */
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { buildPackageInventoryDigest } from "./lib/skills";
import { hashToken } from "./lib/tokens";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const bearer = "local-recovery-fixture";
const reason = "Recover the exact staged artifact after failed release publication";

afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  vi.stubEnv("CLAWHUB_DISABLE_CRONS", "1");
  vi.stubEnv("SECURITY_SCAN_EVENT_DISPATCH_ENABLED", "0");
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const owner = await ctx.db.insert("users", { handle: "original-owner" });
    const actor = await ctx.db.insert("users", {
      handle: "recovery-publisher",
      githubCreatedAt: 1,
    });
    const publisher = await ctx.db.insert("publishers", {
      kind: "org",
      handle: "openclaw",
      displayName: "OpenClaw",
      createdAt: now,
      updatedAt: now,
    });
    const membership = await ctx.db.insert("publisherMembers", {
      publisherId: publisher,
      userId: actor,
      role: "publisher",
      createdAt: now,
      updatedAt: now,
    });
    const apiToken = await ctx.db.insert("apiTokens", {
      userId: actor,
      label: "local fixture",
      prefix: "local",
      tokenHash: await hashToken(bearer),
      createdAt: now,
    });
    const packageId = await ctx.db.insert("packages", {
      name: "@openclaw/recovery-fixture",
      normalizedName: "@openclaw/recovery-fixture",
      displayName: "Recovery fixture",
      ownerUserId: owner,
      ownerPublisherId: publisher,
      family: "code-plugin",
      channel: "official",
      isOfficial: true,
      tags: {},
      stats: { downloads: 0, installs: 0, stars: 0, versions: 0 },
      createdAt: now,
      updatedAt: now,
    });
    const storageId = await ctx.storage.store(new Blob(["fixture artifact"]));
    const files = [
      { path: "index.js", size: 16, storageId, sha256: await hashToken("fixture artifact") },
    ];
    const archive = new Blob(["exact tarball fixture"]);
    const archiveId = await ctx.storage.store(archive);
    const archiveFields = {
      clawpackStorageId: archiveId,
      clawpackSha256: await hashToken("exact tarball fixture"),
      clawpackSize: archive.size,
      artifactKind: "npm-pack" as const,
    };
    const inventoryDigest = await buildPackageInventoryDigest(files);
    const trusted = {
      packageId,
      provider: "github-actions" as const,
      repository: "openclaw/openclaw",
      repositoryId: "1",
      repositoryOwner: "openclaw",
      repositoryOwnerId: "2",
      workflowFilename: "plugin-clawhub-release.yml",
    };
    await ctx.db.insert("packageTrustedPublishers", {
      ...trusted,
      createdByUserId: owner,
      updatedByUserId: owner,
      createdAt: now,
      updatedAt: now,
    });
    const originalToken = await ctx.db.insert("packagePublishTokens", {
      ...trusted,
      version: "2026.9.2",
      prefix: "original",
      tokenHash: "original-consumed-fixture",
      runId: "100",
      runAttempt: "1",
      sha: "a".repeat(40),
      ref: "refs/tags/v2026.9.2",
      scope: "publish",
      inventoryDigest,
      authorizationVersion: 2,
      authorizationRoute: "automated-awaited",
      authorizationArtifactId: "123",
      authorizationArtifactDigest: `sha256:${"b".repeat(64)}`,
      candidateRepository: "openclaw/openclaw",
      candidateSha: "a".repeat(40),
      parentRepository: "openclaw/openclaw",
      parentWorkflow: ".github/workflows/openclaw-release-publish.yml",
      parentRunId: "99",
      parentRunAttempt: "2",
      consumedAt: now - 1000,
      expiresAt: now - 1,
      createdAt: now - 2000,
    });
    const authorization = {
      trustedPublishTokenId: originalToken,
      trustedPublishInventoryDigest: inventoryDigest,
      trustedPublishAuthorizationVersion: 2,
    };
    const releaseId = await ctx.db.insert("packageReleases", {
      packageId,
      version: "2026.9.2",
      publicationStatus: "pending",
      pendingPublication: {
        ...authorization,
        ownerUserId: owner,
        ownerPublisherId: publisher,
        family: "code-plugin",
        tags: ["latest"],
      },
      ...archiveFields,
      changelog: "Original immutable notes",
      distTags: ["latest"],
      files,
      integritySha256: "c".repeat(64),
      createdBy: owner,
      createdAt: now - 1000,
      publishActor: {
        kind: "github-actions",
        repository: "openclaw/openclaw",
        workflow: "plugin-clawhub-release.yml",
        runId: "100",
        runAttempt: "1",
        sha: "a".repeat(40),
      },
    });
    const attemptId = await ctx.db.insert("publishAttempts", {
      kind: "package",
      status: "failed",
      userId: owner,
      ownerUserId: owner,
      ownerPublisherId: publisher,
      packageId,
      packageReleaseId: releaseId,
      slug: "@openclaw/recovery-fixture",
      displayName: "Recovery fixture",
      version: "2026.9.2",
      idempotencyKey: "original",
      artifactFingerprint: "c".repeat(64),
      clawpackStorageId: archiveId,
      files,
      checks: {
        trufflehog: { status: "clean", summary: "Original clean check" },
        clawscan: { status: "clean", summary: "Original clean scan" },
      },
      packageFollowup: {
        ...authorization,
        packageName: "@openclaw/recovery-fixture",
        version: "2026.9.2",
        githubActionsAudit: { repository: "openclaw/openclaw" },
      },
      finalizationLastError:
        "OpenClaw release parent terminal state completed/failure is not authorized by automated-awaited",
      failedAt: now - 10,
      createdAt: now - 1000,
      updatedAt: now - 10,
      expiresAt: now + 100000,
    });
    await ctx.db.patch(releaseId, { publishAttemptId: attemptId });
    return {
      owner,
      actor,
      publisher,
      membership,
      apiToken,
      packageId,
      releaseId,
      attemptId,
      originalToken,
      storageId,
      archiveId,
    };
  });
  const recover = (body: unknown = { manualOverrideReason: reason }, token = bearer) =>
    t.fetch(`/api/v1/publish/attempts/${ids.attemptId}/recover`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { t, ids, recover };
}

it("recovers a failed staged plugin through fresh publisher authority without replacing its bytes or history", async () => {
  const { t, ids, recover } = await fixture();
  const before = await t.run(async (ctx) => ({
    attempt: await ctx.db.get(ids.attemptId),
    release: await ctx.db.get(ids.releaseId),
    token: await ctx.db.get(ids.originalToken),
  }));
  const response = await recover();
  expect(response.status, await response.clone().text()).toBe(202);
  const result = await response.json();
  expect(result).toMatchObject({
    recoveredFromAttemptId: ids.attemptId,
    releaseId: ids.releaseId,
    status: "pending_checks",
    publicationStatus: "pending",
    reused: false,
  });
  expect(result.attemptId).not.toBe(ids.attemptId);
  const after = await t.run(async (ctx) => ({
    attempt: await ctx.db.get(ids.attemptId),
    release: await ctx.db.get(ids.releaseId),
    token: await ctx.db.get(ids.originalToken),
    successor: await ctx.db.get(result.attemptId as Id<"publishAttempts">),
  }));
  expect(after.attempt).toEqual(before.attempt);
  expect(after.token).toEqual(before.token);
  expect(after.release?.files).toEqual(before.release?.files);
  expect(after.release?.integritySha256).toBe(before.release?.integritySha256);
  expect(after.successor).toMatchObject({
    userId: ids.actor,
    status: "pending_checks",
    checks: { trufflehog: { status: "pending" }, clawscan: { status: "pending" } },
  });
});

it("replays exactly once and preserves the original attempt's private status", async () => {
  const { t, ids, recover } = await fixture();
  const first = await (await recover()).json();
  const replay = await recover();
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ attemptId: first.attemptId, reused: true });
  expect((await recover({ manualOverrideReason: "different reason" })).status).toBe(409);
  const oldStatus = await t.fetch(`/api/v1/publish/attempts/${ids.attemptId}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  expect(oldStatus.status).toBe(404);
  const newStatus = await t.fetch(`/api/v1/publish/attempts/${first.attemptId}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  expect(newStatus.status).toBe(200);
});

it("recovers a retained failed attempt whose legacy release has no backlink", async () => {
  const { t, ids, recover } = await fixture();
  await t.run((ctx) => ctx.db.patch(ids.releaseId, { publishAttemptId: undefined }));
  expect((await recover()).status).toBe(202);
});

it("does not recover a legacy missing backlink over another active attempt", async () => {
  const { t, ids, recover } = await fixture();
  await t.run(async (ctx) => {
    await ctx.db.patch(ids.releaseId, { publishAttemptId: undefined });
    const original = await ctx.db.get(ids.attemptId);
    if (!original) throw new Error("Missing fixture attempt");
    const { _id, _creationTime, ...copy } = original;
    await ctx.db.insert("publishAttempts", {
      ...copy,
      status: "pending_checks",
      idempotencyKey: "active-other",
    });
  });
  expect((await recover()).status).toBe(409);
});

it("binds a newly created package attempt before scanner execution", async () => {
  const { t, ids } = await fixture();
  const original = await t.run(async (ctx) => {
    const attempt = await ctx.db.get(ids.attemptId);
    if (!attempt) throw new Error("Missing fixture attempt");
    await ctx.db.delete(ids.attemptId);
    await ctx.db.patch(ids.releaseId, { publishAttemptId: undefined });
    return attempt;
  });
  const created = await t.mutation(internal.publishAttempts.createPackagePublishAttemptInternal, {
    userId: ids.owner,
    ownerUserId: ids.owner,
    ownerPublisherId: ids.publisher,
    packageId: ids.packageId,
    packageReleaseId: ids.releaseId,
    name: original.slug,
    displayName: original.displayName,
    version: original.version,
    idempotencyKey: "new-producer",
    artifactFingerprint: original.artifactFingerprint,
    files: original.files,
    clawpackStorageId: original.clawpackStorageId,
    packageFollowup: original.packageFollowup,
  });
  expect(await t.run((ctx) => ctx.db.get(ids.releaseId))).toMatchObject({
    publishAttemptId: created.attemptId,
  });
});

it("terminalizes full-action finalization after publisher membership is lost", async () => {
  const { t, ids, recover } = await fixture();
  const recovered = await (await recover()).json();
  const attemptId = recovered.attemptId as Id<"publishAttempts">;
  await t.mutation(internal.publishAttempts.claimPendingPublishAttemptChecksInternal, {
    attemptId,
    claimId: "scanner",
  });
  await t.mutation(internal.publishAttempts.completePendingPublishAttemptChecksInternal, {
    attemptId,
    claimId: "scanner",
    artifactFingerprint: "c".repeat(64),
    trufflehog: { status: "clean" },
    clawscan: { status: "clean" },
  });
  await t.run((ctx) => ctx.db.delete(ids.membership));
  await expect(
    t.action(internal.packages.finalizePackagePublishAttemptInternal, { attemptId }),
  ).rejects.toThrow();
  expect(await t.run((ctx) => ctx.db.get(attemptId))).toMatchObject({ status: "failed" });
  expect(await t.run((ctx) => ctx.db.get(ids.releaseId))).toMatchObject({
    publicationStatus: "pending",
  });
});

it.each(["trufflehog", "clawscan"] as const)(
  "replays the terminal result after %s blocks the successor",
  async (scanner) => {
    const { t, recover } = await fixture();
    const first = await (await recover()).json();
    const attemptId = first.attemptId as Id<"publishAttempts">;
    await t.mutation(internal.publishAttempts.claimPendingPublishAttemptChecksInternal, {
      attemptId,
      claimId: "scanner",
    });
    await t.mutation(internal.publishAttempts.completePendingPublishAttemptChecksInternal, {
      attemptId,
      claimId: "scanner",
      artifactFingerprint: "c".repeat(64),
      trufflehog: { status: scanner === "trufflehog" ? "blocked" : "clean" },
      clawscan: { status: scanner === "clawscan" ? "blocked" : "clean" },
    });
    const replay = await recover();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      attemptId,
      reused: true,
      publicationStatus: "blocked",
    });
  },
);

it("finalizes a second successor through the complete action and replays its result", async () => {
  const { t, ids, recover } = await fixture();
  const first = await (await recover()).json();
  const firstId = first.attemptId as Id<"publishAttempts">;
  await t.run((ctx) => ctx.db.patch(firstId, { status: "failed", failedAt: Date.now() }));
  const request = () =>
    t.fetch(`/api/v1/publish/attempts/${firstId}/recover`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ manualOverrideReason: reason }),
    });
  const second = await (await request()).json();
  const attemptId = second.attemptId as Id<"publishAttempts">;
  expect(attemptId).not.toBe(firstId);
  await t.mutation(internal.publishAttempts.claimPendingPublishAttemptChecksInternal, {
    attemptId,
    claimId: "scanner",
  });
  await t.mutation(internal.publishAttempts.completePendingPublishAttemptChecksInternal, {
    attemptId,
    claimId: "scanner",
    artifactFingerprint: "c".repeat(64),
    trufflehog: { status: "clean" },
    clawscan: { status: "clean" },
  });
  await expect(
    t.action(internal.packages.finalizePackagePublishAttemptInternal, { attemptId }),
  ).resolves.toMatchObject({ ok: true, releaseId: ids.releaseId });
  expect(await t.run((ctx) => ctx.db.get(attemptId))).toMatchObject({ status: "finalized" });
  const replay = await request();
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({
    attemptId,
    reused: true,
    publicationStatus: "published",
  });
  expect(await t.run((ctx) => ctx.db.get(ids.attemptId))).toMatchObject({ status: "failed" });
  expect(await t.run((ctx) => ctx.db.get(firstId))).toMatchObject({ status: "failed" });
});

it.each(["ready_to_finalize", "pending_checks", "finalized", "blocked", "expired"] as const)(
  "does not reset an attempt in %s",
  async (status) => {
    const { t, ids, recover } = await fixture();
    await t.run((ctx) => ctx.db.patch(ids.attemptId, { status }));
    expect((await recover()).status).toBe(409);
    expect(await t.run((ctx) => ctx.db.get(ids.attemptId))).toMatchObject({ status });
  },
);

it.each([
  { manualOverrideReason: " " },
  { manualOverrideReason: "x".repeat(501) },
  { manualOverrideReason: reason, actorUserId: "other" },
  { manualOverrideReason: reason, trustedToolingIdentity: {} },
  { manualOverrideReason: reason, files: [] },
])("rejects malformed or extra authority inputs %#", async (body) => {
  const { recover } = await fixture();
  expect((await recover(body)).status).toBe(400);
});

it("does not let a platform administrator bypass publisher membership", async () => {
  const { t, ids, recover } = await fixture();
  await t.run(async (ctx) => {
    await ctx.db.patch(ids.actor, { role: "admin" });
    await ctx.db.delete(ids.membership);
  });
  expect((await recover()).status).toBe(404);
});

it.each(["token", "owner", "actor", "publisher"] as const)(
  "rejects revoked/deactivated %s without a successor",
  async (subject) => {
    const { t, ids, recover } = await fixture();
    await t.run(async (ctx) => {
      if (subject === "token") await ctx.db.patch(ids.apiToken, { revokedAt: Date.now() });
      else await ctx.db.patch(ids[subject], { deactivatedAt: Date.now() });
    });
    expect([401, 404]).toContain((await recover()).status);
    expect(await t.run((ctx) => ctx.db.get(ids.releaseId))).toMatchObject({
      publishAttemptId: ids.attemptId,
    });
  },
);

it.each([
  "original-scope",
  "inventory",
  "fingerprint",
  "files",
  "storage",
  "archive",
  "archive-digest",
  "moderation",
  "scan-block",
  "active-claim",
] as const)("rejects changed %s", async (change) => {
  const { t, ids, recover } = await fixture();
  await t.run(async (ctx) => {
    if (change === "original-scope") await ctx.db.patch(ids.originalToken, { scope: "upload" });
    if (change === "inventory")
      await ctx.db.patch(ids.originalToken, { inventoryDigest: "f".repeat(64) });
    if (change === "fingerprint")
      await ctx.db.patch(ids.releaseId, { integritySha256: "f".repeat(64) });
    if (change === "files") await ctx.db.patch(ids.releaseId, { files: [] });
    if (change === "storage") await ctx.storage.delete(ids.storageId);
    if (change === "archive") await ctx.storage.delete(ids.archiveId);
    if (change === "archive-digest")
      await ctx.db.patch(ids.releaseId, { clawpackSha256: "f".repeat(64) });
    if (change === "moderation")
      await ctx.db.patch(ids.releaseId, {
        manualModeration: {
          state: "quarantined",
          reason: "hold",
          reviewerUserId: ids.actor,
          updatedAt: Date.now(),
        },
      });
    if (change === "scan-block")
      await ctx.db.patch(ids.attemptId, {
        checks: { trufflehog: { status: "clean" }, clawscan: { status: "blocked" } },
      });
    if (change === "active-claim")
      await ctx.db.patch(ids.attemptId, {
        finalizationClaimId: "active",
        finalizationClaimExpiresAt: Date.now() + 60000,
      });
  });
  expect((await recover()).status).toBe(409);
  expect(await t.run((ctx) => ctx.db.get(ids.releaseId))).toMatchObject({
    publishAttemptId: ids.attemptId,
  });
});

it("fences expired predecessor claims by using a distinct attempt", async () => {
  const { t, ids, recover } = await fixture();
  await t.run((ctx) =>
    ctx.db.patch(ids.attemptId, {
      finalizationClaimId: "expired",
      finalizationClaimExpiresAt: Date.now() - 1,
    }),
  );
  const response = await recover();
  expect(response.status).toBe(202);
  expect(await t.run((ctx) => ctx.db.get(ids.attemptId))).toMatchObject({
    status: "failed",
    finalizationClaimId: "expired",
  });
});

it("requires fresh scanner checks and rejects stale finalization claims", async () => {
  const { t, ids, recover } = await fixture();
  const result = await (await recover()).json();
  const successorId = result.attemptId as Id<"publishAttempts">;
  await expect(
    t.mutation(internal.packages.publishPendingReleaseInternal, {
      releaseId: ids.releaseId,
      manualRecoveryAttemptId: successorId,
      manualRecoveryClaimId: "unclaimed",
    }),
  ).rejects.toThrow(/claim or checks changed/);
  await t.run((ctx) =>
    ctx.db.patch(successorId, {
      status: "ready_to_finalize",
      checks: { trufflehog: { status: "clean" }, clawscan: { status: "clean" } },
    }),
  );
  await t.mutation(internal.publishAttempts.claimPackagePublishAttemptForFinalizationInternal, {
    attemptId: successorId,
    claimId: "current",
  });
  await expect(
    t.mutation(internal.packages.publishPendingReleaseInternal, {
      releaseId: ids.releaseId,
      manualRecoveryAttemptId: successorId,
      manualRecoveryClaimId: "stale",
    }),
  ).rejects.toThrow(/claim or checks changed/);
  await t.run((ctx) => ctx.db.patch(ids.apiToken, { revokedAt: Date.now() }));
  await expect(
    t.mutation(internal.packages.publishPendingReleaseInternal, {
      releaseId: ids.releaseId,
      manualRecoveryAttemptId: successorId,
      manualRecoveryClaimId: "current",
    }),
  ).rejects.toThrow(/revoked/);
  expect(await t.run((ctx) => ctx.db.get(ids.releaseId))).toMatchObject({
    publicationStatus: "pending",
  });
});

it("uses fresh manual authority independently of an expired and revoked original grant", async () => {
  const { t, ids, recover } = await fixture();
  await t.run((ctx) => ctx.db.patch(ids.originalToken, { revokedAt: Date.now() }));
  const original = await t.run((ctx) => ctx.db.get(ids.originalToken));
  expect(
    (await recover({ manualOverrideReason: reason }, "original-consumed-fixture")).status,
  ).toBe(401);
  expect((await recover()).status).toBe(202);
  expect(await t.run((ctx) => ctx.db.get(ids.originalToken))).toEqual(original);
});

it.each(["none", "membership", "token", "archive-digest"] as const)(
  "commits only a currently authorized recovery after fresh claimed scans: %s",
  async (revocation) => {
    const { t, ids, recover } = await fixture();
    const recovered = await (await recover()).json();
    const attemptId = recovered.attemptId as Id<"publishAttempts">;
    await t.mutation(internal.publishAttempts.claimPendingPublishAttemptChecksInternal, {
      attemptId,
      claimId: "fresh-scanner",
    });
    await t.mutation(internal.publishAttempts.completePendingPublishAttemptChecksInternal, {
      attemptId,
      claimId: "fresh-scanner",
      artifactFingerprint: "c".repeat(64),
      trufflehog: { status: "clean", summary: "Fresh secret scan" },
      clawscan: { status: "clean", summary: "Fresh policy scan" },
    });
    await t.mutation(internal.publishAttempts.claimPackagePublishAttemptForFinalizationInternal, {
      attemptId,
      claimId: "fresh-finalizer",
    });
    if (revocation === "membership") await t.run((ctx) => ctx.db.delete(ids.membership));
    if (revocation === "token")
      await t.run((ctx) => ctx.db.patch(ids.apiToken, { revokedAt: Date.now() }));
    if (revocation === "archive-digest")
      await t.run((ctx) => ctx.db.patch(ids.releaseId, { clawpackSha256: "f".repeat(64) }));
    const commit = t.mutation(internal.packages.publishPendingReleaseInternal, {
      releaseId: ids.releaseId,
      manualRecoveryAttemptId: attemptId,
      manualRecoveryClaimId: "fresh-finalizer",
    });
    if (revocation !== "none") {
      await expect(commit).rejects.toThrow();
      expect(await t.run((ctx) => ctx.db.get(ids.releaseId))).toMatchObject({
        publicationStatus: "pending",
      });
    } else {
      await expect(commit).resolves.toMatchObject({ ok: true, releaseId: ids.releaseId });
      expect(await t.run((ctx) => ctx.db.get(ids.releaseId))).toMatchObject({
        publicationStatus: "published",
        publishActor: { kind: "user", userId: ids.actor },
      });
    }
    expect(await t.run((ctx) => ctx.db.get(ids.attemptId))).toMatchObject({ status: "failed" });
  },
);
