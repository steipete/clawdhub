/* @vitest-environment node */

import { getAuthUserId } from "@convex-dev/auth/server";
import { type FunctionReference, getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "./lib/clawpack";
import { verifyOpenClawPublishAuthorization } from "./lib/openClawPublishAuthorization";
import { MAX_PUBLISH_FILE_BYTES } from "./lib/publishLimits";
import {
  computeRecommendationScore,
  RECOMMENDATION_SCORE_VERSION,
} from "./lib/recommendationScore";
import { buildPackageInventoryDigest } from "./lib/skills";
import { buildDeterministicPackageZip } from "./lib/skillZip";
import {
  backfillLatestPackageScanStatusInternal,
  backfillPackageReleaseScansInternal,
  normalizeOfficialPublisherPackagesInternal,
  getPackageReleaseScanBackfillBatchInternal,
  getByName,
  list,
  publishRelease,
  publishPackageForTrustedPublisherInternal,
  publishPackageForUserInternal,
  generateChangelogPreview,
  assertCanGenerateChangelogPreviewInternal,
  listPackageReportsInternal,
  getPackageModerationStatusForUserInternal,
  getManageContext,
  canDeleteVersions,
  getPackageInspectorValidationSummaryPublic,
  listPackageInspectorWarningsForManager,
  listPackageInspectorFindingsPublic,
  insertPackageInspectorWarningsInternal,
  ingestPackageInspectorScanResultsInternal,
  claimPackageInspectorScanBatchInternal,
  acknowledgePackageInspectorScanBatchInternal,
  previewPackageInspectorScanBatchInternal,
  getPackageInspectorEmailContextInternal,
  markPackageInspectorFindingsEmailedInternal,
  reportPackageForUserInternal,
  triagePackageReportForUserInternal,
  submitPackageAppealForUserInternal,
  listPackageAppealsInternal,
  listOfficialPluginMigrationsInternal,
  resolvePackageAppealForUserInternal,
  upsertOfficialPluginMigrationForUserInternal,
  getVersionByName,
  getVersionByNameForViewerInternal,
  getVersionSecurityByNameForViewerInternal,
  insertReleaseInternal,
  cleanupReassignedPackageReleaseTagsInternal,
  publishPendingReleaseInternal,
  finalizePackagePublishAttemptInternal,
  findPackagePublishResultInternal,
  listPackageModerationQueueInternal,
  listPluginExportPageInternal,
  listPluginValidationReportPageInternal,
  reservePackageNameInternal,
  listPublicPage,
  listPublicNewPluginsPage,
  listPageForViewerInternal,
  listVersions,
  listVersionsForViewerInternal,
  listVersionsForManager,
  updateReleaseLlmAnalysisInternal,
  updateReleaseStaticScanInternal,
  applyAccountDeletionToOwnedPackagesBatchInternal,
  applyPublisherDeletionToOwnedPackagesBatchInternal,
  applyBanToOwnedPackagesBatchInternal,
  revokePackagePublishTokensForPackageBatchInternal,
  restoreOwnedPackagesForUnbanBatchInternal,
  softDeletePackageInternal,
  restorePackageInternal,
  transferPackageOwnerForUserInternal,
  transferPackageOwnerInternal,
  repairPackageIdentityInternal,
  searchForViewerInternal,
  searchPublic,
} from "./packages";
import { runStaticPublishScanInternal } from "./staticPublishScanNode";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  authTables: {},
}));

vi.mock("./lib/openClawPublishAuthorization", () => ({
  verifyOpenClawPublishAuthorization: vi.fn(),
}));

type WrappedHandler<TArgs, TResult> = {
  _handler: (ctx: unknown, args: TArgs) => Promise<TResult>;
};
type TestPackageInspectorAuthorRemediation = {
  summary: string;
  docsUrl?: string;
};

const getByNameHandler = (
  getByName as unknown as WrappedHandler<
    { name: string },
    {
      package: { name: string; latestVersion: string | null };
      latestRelease: { version: string } | null;
    } | null
  >
)._handler;
const listHandler = (
  list as unknown as WrappedHandler<
    {
      ownerUserId?: string;
      ownerPublisherId?: string;
      limit?: number;
    },
    Array<{
      name: string;
      pendingReview?: boolean;
      scanStatus?: string;
      latestRelease: {
        vtStatus: string | null;
        staticScanStatus: string | null;
      } | null;
    }>
  >
)._handler;
const applyPublisherDeletionToOwnedPackagesBatchInternalHandler = (
  applyPublisherDeletionToOwnedPackagesBatchInternal as unknown as WrappedHandler<
    {
      ownerPublisherId: string;
      actorUserId: string;
      deletedAt: number;
      cursor?: string;
    },
    {
      deletedCount: number;
      revokedTokenCount: number;
      scheduled: boolean;
      stale?: true;
    }
  >
)._handler;
const getVersionByNameHandler = (
  getVersionByName as unknown as WrappedHandler<
    { name: string; version: string },
    { package: { name: string; scanStatus?: string }; version: { version: string } } | null
  >
)._handler;
const getVersionByNameForViewerInternalHandler = (
  getVersionByNameForViewerInternal as unknown as WrappedHandler<
    { name: string; version: string; viewerUserId?: string },
    { package: { name: string }; version: { version: string; clawpackStorageId?: string } } | null
  >
)._handler;
const getVersionSecurityByNameForViewerInternalHandler = (
  getVersionSecurityByNameForViewerInternal as unknown as WrappedHandler<
    { name: string; version: string; viewerUserId?: string },
    { package: { name: string }; version: { version: string } } | null
  >
)._handler;
const listPublicPageHandler = (
  listPublicPage as unknown as WrappedHandler<
    {
      family?: "skill" | "code-plugin" | "bundle-plugin";
      channel?: "official" | "community" | "private";
      isOfficial?: boolean;
      executesCode?: boolean;
      capabilityTag?: string;
      category?: string;
      topic?: string;
      officialFirst?: boolean;
      highlightedOnly?: boolean;
      excludedScanStatuses?: Array<"clean" | "suspicious" | "malicious" | "pending" | "not-run">;
      sort?: "updated" | "downloads" | "recommended" | "installs";
      paginationOpts: { cursor: string | null; numItems: number };
    },
    {
      page: Array<{ name: string; featuredAt?: number }>;
      isDone: boolean;
      continueCursor: string;
    }
  >
)._handler;
const listPublicNewPluginsPageHandler = (
  listPublicNewPluginsPage as unknown as WrappedHandler<
    {
      category?: string;
      createdAfter: number;
      paginationOpts: { cursor: string | null; numItems: number };
    },
    {
      page: Array<{ name: string; createdAt: number }>;
      isDone: boolean;
      continueCursor: string;
    }
  >
)._handler;
const listPageForViewerInternalHandler = (
  listPageForViewerInternal as unknown as WrappedHandler<
    {
      family?: "skill" | "code-plugin" | "bundle-plugin";
      families?: Array<"skill" | "code-plugin" | "bundle-plugin">;
      channel?: "official" | "community" | "private";
      isOfficial?: boolean;
      executesCode?: boolean;
      capabilityTag?: string;
      category?: string;
      topic?: string;
      officialFirst?: boolean;
      highlightedOnly?: boolean;
      excludedScanStatuses?: Array<"clean" | "suspicious" | "malicious" | "pending" | "not-run">;
      sort?: "updated" | "downloads" | "recommended" | "installs";
      viewerUserId?: string;
      paginationOpts: { cursor: string | null; numItems: number };
    },
    {
      page: Array<{ name: string; featuredAt?: number }>;
      isDone: boolean;
      continueCursor: string;
    }
  >
)._handler;
const listPluginExportPageInternalHandler = (
  listPluginExportPageInternal as unknown as WrappedHandler<
    {
      startDate: number;
      endDate: number;
      cursor?: string;
      numItems?: number;
      family?: "code-plugin" | "bundle-plugin";
    },
    {
      page: Array<{ name: string; family: "code-plugin" | "bundle-plugin" }>;
      nextCursor: string | null;
      hasMore: boolean;
    }
  >
)._handler;
const listPluginValidationReportPageInternalHandler = (
  listPluginValidationReportPageInternal as unknown as WrappedHandler<
    { cursor?: string; numItems?: number },
    {
      items: Array<{
        package: { id: string; name: string; displayName: string };
        scan: { status: string; scannedAt: number | null };
        findings: Array<{ severity: string; code: string; message: string }>;
      }>;
      nextCursor: string | null;
      done: boolean;
    }
  >
)._handler;
const listVersionsHandler = (
  listVersions as unknown as WrappedHandler<
    {
      name: string;
      paginationOpts: { cursor: string | null; numItems: number };
    },
    {
      page: Array<{ version: string }>;
      isDone: boolean;
      continueCursor: string;
    }
  >
)._handler;
const listVersionsForViewerInternalHandler = (
  listVersionsForViewerInternal as unknown as WrappedHandler<
    {
      name: string;
      viewerUserId?: string;
      paginationOpts: { cursor: string | null; numItems: number };
    },
    {
      page: Array<{ version: string; clawpackStorageId?: string }>;
      isDone: boolean;
      continueCursor: string;
    }
  >
)._handler;
const listVersionsForManagerHandler = (
  listVersionsForManager as unknown as WrappedHandler<
    {
      name: string;
      paginationOpts: { cursor: string | null; numItems: number };
    },
    {
      page: Array<{ version: string; softDeletedAt?: number; ownerDeletedAt?: number }>;
      isDone: boolean;
      continueCursor: string;
    }
  >
)._handler;
const insertReleaseInternalHandler = (
  insertReleaseInternal as unknown as WrappedHandler<
    {
      actorUserId: string;
      ownerUserId: string;
      ownerPublisherId?: string;
      publishActor?:
        | { kind: "user"; userId: string }
        | {
            kind: "github-actions";
            repository: string;
            workflow: string;
            runId: string;
            runAttempt: string;
            sha: string;
          };
      name: string;
      displayName: string;
      family: "skill" | "code-plugin" | "bundle-plugin" | "claw";
      version: string;
      publicationStatus?: "pending" | "published";
      changelog: string;
      icon?: string;
      tags: string[];
      summary: string;
      categories?: string[];
      topics?: string[];
      files: Array<{
        path: string;
        size: number;
        storageId: string;
        sha256: string;
        contentType?: string;
      }>;
      integritySha256: string;
      sha256hash?: string;
      sourceRepo?: string;
      runtimeId?: string;
      channel?: "official" | "community" | "private";
      compatibility?: unknown;
      capabilities?: unknown;
      verification?: unknown;
      staticScan?: unknown;
      llmAnalysis?: unknown;
      artifactKind?: "legacy-zip" | "npm-pack";
      clawpackStorageId?: string;
      clawpackSha256?: string;
      clawpackSize?: number;
      clawpackFormat?: "tgz";
      npmIntegrity?: string;
      npmShasum?: string;
      npmTarballName?: string;
      npmUnpackedSize?: number;
      npmFileCount?: number;
      allowExistingRelease?: boolean;
      extractedPackageJson?: unknown;
      extractedPluginManifest?: unknown;
      normalizedBundleManifest?: unknown;
      trustedPublishTokenId?: string;
      trustedPublishInventoryDigest?: string;
      source?: unknown;
    },
    unknown
  >
)._handler;
const findPackagePublishResultInternalHandler = (
  findPackagePublishResultInternal as unknown as WrappedHandler<
    {
      name: string;
      version: string;
      integritySha256: string;
      clawpackSha256?: string;
      ownerUserId: string;
      ownerPublisherId?: string;
    },
    { ok: true; packageId: string; releaseId: string } | null
  >
)._handler;
const publishPendingReleaseInternalHandler = (
  publishPendingReleaseInternal as unknown as WrappedHandler<
    {
      releaseId: string;
      trustedPublishTokenId?: string;
      trustedPublishInventoryDigest?: string;
      trustedPublishAuthorizationVersion?: 2;
    },
    unknown
  >
)._handler;
const cleanupReassignedPackageReleaseTagsInternalHandler = (
  cleanupReassignedPackageReleaseTagsInternal as unknown as WrappedHandler<
    {
      packageId: string;
      assignments: Array<{ releaseId: string; tags: string[] }>;
      offset?: number;
    },
    unknown
  >
)._handler;
const finalizePackagePublishAttemptInternalHandler = (
  finalizePackagePublishAttemptInternal as unknown as WrappedHandler<
    {
      attemptId: string;
    },
    unknown
  >
)._handler;
const reservePackageNameInternalHandler = (
  reservePackageNameInternal as unknown as WrappedHandler<
    {
      actorUserId: string;
      ownerUserId: string;
      ownerPublisherId?: string;
      name: string;
      displayName?: string;
      summary?: string;
      family?: "skill" | "code-plugin" | "bundle-plugin";
      reason?: string;
    },
    { ok: true; action: string; packageId: string; name: string }
  >
)._handler;
const searchPublicHandler = (
  searchPublic as unknown as WrappedHandler<
    {
      query: string;
      limit?: number;
      family?: "skill" | "code-plugin" | "bundle-plugin";
      channel?: "official" | "community" | "private";
      isOfficial?: boolean;
      executesCode?: boolean;
      capabilityTag?: string;
      category?: string;
      topic?: string;
      createdAfter?: number;
      excludedScanStatuses?: Array<"clean" | "suspicious" | "malicious" | "pending" | "not-run">;
    },
    Array<{ package: { name: string } }>
  >
)._handler;
const searchForViewerInternalHandler = (
  searchForViewerInternal as unknown as WrappedHandler<
    {
      query: string;
      limit?: number;
      family?: "skill" | "code-plugin" | "bundle-plugin";
      channel?: "official" | "community" | "private";
      isOfficial?: boolean;
      executesCode?: boolean;
      capabilityTag?: string;
      category?: string;
      topic?: string;
      createdAfter?: number;
      excludedScanStatuses?: Array<"clean" | "suspicious" | "malicious" | "pending" | "not-run">;
      viewerUserId?: string;
    },
    Array<{ package: { name: string } }>
  >
)._handler;
const publishPackageForUserInternalHandler = (
  publishPackageForUserInternal as unknown as WrappedHandler<
    {
      actorUserId: string;
      payload: unknown;
    },
    unknown
  >
)._handler;
const publishReleaseHandler = (
  publishRelease as unknown as WrappedHandler<{ payload: unknown }, unknown>
)._handler;
const publishPackageForTrustedPublisherInternalHandler = (
  publishPackageForTrustedPublisherInternal as unknown as WrappedHandler<
    {
      publishTokenId: string;
      payload: unknown;
    },
    unknown
  >
)._handler;
const generateChangelogPreviewHandler = (
  generateChangelogPreview as unknown as WrappedHandler<
    {
      name: string;
      family: "code-plugin" | "bundle-plugin";
      version: string;
      readmeText: string;
      filePaths?: string[];
    },
    { changelog: string }
  >
)._handler;
const assertCanGenerateChangelogPreviewInternalHandler = (
  assertCanGenerateChangelogPreviewInternal as unknown as WrappedHandler<
    {
      actorUserId: string;
      name: string;
    },
    { ok: true }
  >
)._handler;

const packageManifestFile = {
  path: "openclaw.plugin.json",
  size: 32,
  storageId: "storage:manifest",
  sha256: "manifest",
  contentType: "application/json",
};

function makePackageManifestStorage() {
  return {
    get: vi.fn(async (id: string) =>
      id === "storage:manifest" ? new Blob([JSON.stringify({ id: "demo.plugin" })]) : null,
    ),
    store: vi.fn(async () => "storage:legacy-zip"),
  };
}

type PublishScanStorage = { storage: { get: (storageId: string) => Promise<Blob | null> } };

// Convex rejects action arguments whose object keys start with `$` (package.json
// `$schema` is the production case); mirror that rule so the mock fails the way
// the real boundary would.
function assertConvexValueKeys(value: unknown, path = "args"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertConvexValueKeys(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (key.startsWith("$")) {
        throw new Error(`Field name ${key} at ${path} starts with a '$', which is reserved.`);
      }
      assertConvexValueKeys(nested, `${path}.${key}`);
    }
  }
}

type StaticScanHandler = (ctx: unknown, args: unknown) => Promise<unknown>;

// Publish actions hop to the Node runtime for the moderation scan; run the real
// action handler against the calling ctx's storage (`ctx.runAction(...)` binds
// `this`) so scan verdicts stay observable, and answer every other action (the
// package inspector) with the supplied result.
function makePublishRunActionMock(
  inspectorResult: () => unknown = makeCleanPackageInspectorResult,
) {
  return vi.fn(async function (this: PublishScanStorage, ref: unknown, args: unknown) {
    const name = getFunctionName(ref as FunctionReference<"action">);
    if (name === "staticPublishScanNode:runStaticPublishScanInternal") {
      assertConvexValueKeys(args);
      const handler = (runStaticPublishScanInternal as unknown as { _handler: StaticScanHandler })
        ._handler;
      return await handler(this, args);
    }
    return inspectorResult();
  });
}

function makeCleanPackageInspectorResult() {
  return {
    status: "pass",
    summary: {
      breakageCount: 0,
      warningCount: 0,
      deprecationWarningCount: 0,
      issueCount: 0,
    },
    warnings: [],
    breakages: [],
  };
}

function makeEmptyPackageInspectorWarningsQuery() {
  return {
    withIndex: vi.fn(() => ({
      take: vi.fn().mockResolvedValue([]),
      collect: vi.fn().mockResolvedValue([]),
      unique: vi.fn().mockResolvedValue(null),
      order: vi.fn(() => ({
        take: vi.fn().mockResolvedValue([]),
        paginate: vi.fn().mockResolvedValue({ page: [], isDone: true, continueCursor: "" }),
      })),
    })),
  };
}

const reportPackageForUserInternalHandler = (
  reportPackageForUserInternal as unknown as WrappedHandler<
    {
      actorUserId: string;
      name: string;
      version?: string;
      reason: string;
    },
    {
      ok: true;
      reported: boolean;
      alreadyReported: boolean;
      packageId: string;
      releaseId: string | null;
      reportCount: number;
    }
  >
)._handler;
const listPackageReportsInternalHandler = (
  listPackageReportsInternal as unknown as WrappedHandler<
    {
      actorUserId: string;
      cursor?: string | null;
      limit?: number;
      status?: "open" | "confirmed" | "dismissed" | "all";
    },
    {
      items: Array<{ reportId: string; name: string; status: string; reason?: string | null }>;
      nextCursor: string | null;
      done: boolean;
    }
  >
)._handler;
const triagePackageReportForUserInternalHandler = (
  triagePackageReportForUserInternal as unknown as WrappedHandler<
    {
      actorUserId: string;
      reportId: string;
      status: "open" | "confirmed" | "dismissed";
      note?: string;
      finalAction?: "none" | "quarantine" | "revoke";
    },
    {
      ok: true;
      reportId: string;
      packageId: string;
      status: string;
      reportCount: number;
      actionTaken?: string;
    }
  >
)._handler;
const getPackageModerationStatusForUserInternalHandler = (
  getPackageModerationStatusForUserInternal as unknown as WrappedHandler<
    {
      actorUserId: string;
      name: string;
    },
    {
      package: { name: string; reportCount: number };
      latestRelease: { version: string; scanStatus: string; blockedFromDownload: boolean } | null;
    }
  >
)._handler;
const getManageContextHandler = (
  getManageContext as unknown as WrappedHandler<
    { name: string; candidateNames?: string[] },
    {
      package: { _id: string; name: string; displayName: string };
      latestRelease: { _id: string; version: string };
    } | null
  >
)._handler;
const canDeleteVersionsHandler = (
  canDeleteVersions as unknown as WrappedHandler<
    { name: string; candidateNames?: string[] },
    boolean
  >
)._handler;
const listPackageInspectorWarningsForManagerHandler = (
  listPackageInspectorWarningsForManager as unknown as WrappedHandler<
    { name: string; limit?: number },
    Array<{
      packageName: string;
      version: string;
      code: string;
      issueClass?: string;
      message: string;
    }>
  >
)._handler;
const listPackageInspectorFindingsPublicHandler = (
  listPackageInspectorFindingsPublic as unknown as WrappedHandler<
    { name: string; limit?: number },
    Array<{
      packageName: string;
      version: string;
      findingKind: "warning" | "error";
      code: string;
      issueClass?: string;
      message: string;
      inspectorVersion?: string;
      targetOpenClawVersion?: string;
      scanSource?: "publish" | "nightly";
    }>
  >
)._handler;
const getPackageInspectorValidationSummaryPublicHandler = (
  getPackageInspectorValidationSummaryPublic as unknown as WrappedHandler<
    { name: string },
    {
      findingCount: number;
      errorCount: number;
      warningCount: number;
      incompatibleAfterOpenClawVersion: string | null;
    }
  >
)._handler;
const insertPackageInspectorWarningsInternalHandler = (
  insertPackageInspectorWarningsInternal as unknown as WrappedHandler<
    {
      packageId: string;
      releaseId: string;
      ownerUserId: string;
      ownerPublisherId?: string;
      packageName: string;
      version: string;
      scanSource?: "publish" | "nightly";
      inspectorVersion?: string;
      targetOpenClawVersion?: string;
      notifyOwners?: boolean;
      findings?: Array<{
        id?: string;
        code: string;
        message: string;
        level?: string;
        issueClass?: string;
        evidence?: string[];
        fixture?: string;
        authorRemediation?: TestPackageInspectorAuthorRemediation;
      }>;
      warnings?: Array<{
        id?: string;
        code: string;
        message: string;
        issueClass?: string;
        evidence?: string[];
        fixture?: string;
        authorRemediation?: TestPackageInspectorAuthorRemediation;
      }>;
    },
    { ok: true; inserted: number; shouldEmailOwner: boolean }
  >
)._handler;
const ingestPackageInspectorScanResultsInternalHandler = (
  ingestPackageInspectorScanResultsInternal as unknown as WrappedHandler<
    {
      packageId: string;
      releaseId: string;
      inspectorVersion?: string;
      targetOpenClawVersion?: string;
      notifyOwners?: boolean;
      findings: Array<{
        id?: string;
        code: string;
        message: string;
        level?: string;
        authorRemediation?: TestPackageInspectorAuthorRemediation;
      }>;
    },
    { ok: true; inserted: number; shouldEmailOwner: boolean }
  >
)._handler;
const claimPackageInspectorScanBatchInternalHandler = (
  claimPackageInspectorScanBatchInternal as unknown as WrappedHandler<
    {
      batchSize?: number;
      leaseMs?: number;
      cursor?: string | null;
      runId?: string;
      inspectorVersion?: string;
      targetOpenClawVersion?: string;
      notifyOwners?: boolean;
    },
    {
      ok: true;
      leased: boolean;
      nextCursor: string | null;
      items: Array<{
        packageId: string;
        releaseId: string;
        packageName: string;
        version: string;
        artifactKind: "legacy-zip" | "npm-pack";
      }>;
    }
  >
)._handler;
const acknowledgePackageInspectorScanBatchInternalHandler = (
  acknowledgePackageInspectorScanBatchInternal as unknown as WrappedHandler<
    {
      runId: string;
      cursor: string | null;
      leaseMs?: number;
    },
    { ok: true; cursor: string | null; completed: boolean }
  >
)._handler;
const previewPackageInspectorScanBatchInternalHandler = (
  previewPackageInspectorScanBatchInternal as unknown as WrappedHandler<
    {
      batchSize?: number;
      cursor?: string | null;
      inspectorVersion?: string;
      targetOpenClawVersion?: string;
      notifyOwners?: boolean;
    },
    {
      ok: true;
      leased: false;
      nextCursor: string | null;
      skippedUnchanged: number;
      items: Array<{
        packageId: string;
        releaseId: string;
        ownerUserId: string;
        ownerPublisherId?: string;
        packageName: string;
        version: string;
        artifactKind: "legacy-zip" | "npm-pack";
      }>;
    }
  >
)._handler;
const getPackageInspectorEmailContextInternalHandler = (
  getPackageInspectorEmailContextInternal as unknown as WrappedHandler<
    {
      packageId: string;
      releaseId: string;
      inspectorVersion?: string;
      targetOpenClawVersion?: string;
    },
    {
      packageName: string;
      version: string;
      findings: Array<{
        code: string;
        authorRemediation?: TestPackageInspectorAuthorRemediation;
      }>;
    } | null
  >
)._handler;
const markPackageInspectorFindingsEmailedInternalHandler = (
  markPackageInspectorFindingsEmailedInternal as unknown as WrappedHandler<
    {
      packageId: string;
      releaseId: string;
      ownerUserId: string;
      ownerPublisherId?: string;
      packageName: string;
      version: string;
      findingCount: number;
      email: string;
      inspectorVersion?: string;
      targetOpenClawVersion?: string;
    },
    { ok: true; created: boolean }
  >
)._handler;
const submitPackageAppealForUserInternalHandler = (
  submitPackageAppealForUserInternal as unknown as WrappedHandler<
    {
      actorUserId: string;
      name: string;
      version: string;
      message: string;
    },
    {
      ok: true;
      submitted: boolean;
      alreadyOpen: boolean;
      appealId: string;
      packageId: string;
      releaseId: string;
      status: string;
    }
  >
)._handler;
const listPackageAppealsInternalHandler = (
  listPackageAppealsInternal as unknown as WrappedHandler<
    {
      actorUserId: string;
      cursor?: string | null;
      limit?: number;
      status?: "open" | "accepted" | "rejected" | "all";
    },
    {
      items: Array<{ appealId: string; name: string; status: string; message: string }>;
      nextCursor: string | null;
      done: boolean;
    }
  >
)._handler;
const resolvePackageAppealForUserInternalHandler = (
  resolvePackageAppealForUserInternal as unknown as WrappedHandler<
    {
      actorUserId: string;
      appealId: string;
      status: "open" | "accepted" | "rejected";
      note?: string;
      finalAction?: "none" | "approve";
    },
    {
      ok: true;
      appealId: string;
      packageId: string;
      releaseId: string;
      status: string;
      actionTaken?: string;
    }
  >
)._handler;
const getPackageReleaseScanBackfillBatchInternalHandler = (
  getPackageReleaseScanBackfillBatchInternal as unknown as WrappedHandler<
    {
      cursor?: number;
      batchSize?: number;
      prioritizeRecent?: boolean;
    },
    {
      releases: Array<{
        releaseId: string;
        packageId: string;
        needsVt: boolean;
        needsLlm: boolean;
        needsStatic: boolean;
      }>;
      nextCursor: number;
      done: boolean;
    }
  >
)._handler;
const backfillLatestPackageScanStatusInternalHandler = (
  backfillLatestPackageScanStatusInternal as unknown as WrappedHandler<
    {
      cursor?: string | null;
      batchSize?: number;
    },
    {
      patched: number;
      isDone: boolean;
      scanned: number;
    }
  >
)._handler;
const backfillPackageReleaseScansInternalHandler = (
  backfillPackageReleaseScansInternal as unknown as WrappedHandler<
    {
      cursor?: number;
      batchSize?: number;
      scheduled?: number;
    },
    { scheduled: number; nextCursor: number; done: boolean }
  >
)._handler;
const normalizeOfficialPublisherPackagesInternalHandler = (
  normalizeOfficialPublisherPackagesInternal as unknown as WrappedHandler<
    {
      family?: "code-plugin" | "bundle-plugin";
      cursor?: string | null;
      batchSize?: number;
      dryRun?: boolean;
    },
    {
      family: "code-plugin" | "bundle-plugin";
      cursor: string;
      isDone: boolean;
      scanned: number;
      matched: number;
      patched: number;
      skippedPrivate: number;
      dryRun: boolean;
    }
  >
)._handler;
const listOfficialPluginMigrationsInternalHandler = (
  listOfficialPluginMigrationsInternal as unknown as WrappedHandler<
    {
      actorUserId: string;
      cursor?: string | null;
      limit?: number;
      phase?: "planned" | "blocked" | "ready-for-openclaw" | "all";
    },
    {
      items: Array<{ bundledPluginId: string; packageName: string; phase: string }>;
      nextCursor: string | null;
      done: boolean;
    }
  >
)._handler;
const upsertOfficialPluginMigrationForUserInternalHandler = (
  upsertOfficialPluginMigrationForUserInternal as unknown as WrappedHandler<
    {
      actorUserId: string;
      bundledPluginId: string;
      packageName: string;
      owner?: string;
      sourceRepo?: string;
      sourcePath?: string;
      sourceCommit?: string;
      phase?: "planned" | "blocked" | "ready-for-openclaw";
      blockers?: string[];
      hostTargetsComplete?: boolean;
      scanClean?: boolean;
      moderationApproved?: boolean;
      runtimeBundlesReady?: boolean;
      notes?: string;
    },
    {
      ok: true;
      migration: { bundledPluginId: string; packageName: string; phase: string };
    }
  >
)._handler;
const listPackageModerationQueueInternalHandler = (
  listPackageModerationQueueInternal as unknown as WrappedHandler<
    {
      actorUserId: string;
      cursor?: string | null;
      limit?: number;
      status?: "open" | "blocked" | "manual" | "all";
    },
    {
      items: Array<{
        packageId: string;
        releaseId: string;
        name: string;
        version: string;
        scanStatus: string;
        moderationState?: string | null;
        reasons: string[];
      }>;
      nextCursor: string | null;
      done: boolean;
    }
  >
)._handler;
const updateReleaseStaticScanInternalHandler = (
  updateReleaseStaticScanInternal as unknown as WrappedHandler<
    {
      releaseId: string;
      staticScan: {
        status: "clean" | "suspicious" | "malicious";
        reasonCodes: string[];
        findings: Array<{
          code: string;
          severity: string;
          file: string;
          line: number;
          message: string;
          evidence: string;
        }>;
        summary: string;
        engineVersion: string;
        checkedAt: number;
      };
    },
    unknown
  >
)._handler;
const updateReleaseLlmAnalysisInternalHandler = (
  updateReleaseLlmAnalysisInternal as unknown as WrappedHandler<
    {
      releaseId: string;
      llmAnalysis: {
        status: string;
        verdict?: string;
        confidence?: string;
        summary?: string;
        guidance?: string;
        findings?: string;
        checkedAt: number;
      };
    },
    unknown
  >
)._handler;
const softDeletePackageInternalHandler = (
  softDeletePackageInternal as unknown as WrappedHandler<
    { userId: string; name: string },
    {
      ok: true;
      packageId: string;
      releaseCount: number;
      alreadyDeleted: boolean;
    }
  >
)._handler;
const applyBanToOwnedPackagesBatchInternalHandler = (
  applyBanToOwnedPackagesBatchInternal as unknown as WrappedHandler<
    {
      ownerUserId: string;
      bannedAt: number;
      deletedBy: string;
      deletedByRole: "admin" | "moderator" | "user";
      cursor?: string;
      scope?: "ownerUserId" | "personalPublisher";
    },
    { deletedCount: number; revokedTokenCount: number; scheduled: boolean }
  >
)._handler;
const revokePackagePublishTokensForPackageBatchInternalHandler = (
  revokePackagePublishTokensForPackageBatchInternal as unknown as WrappedHandler<
    { packageId: string; revokedAt: number },
    { ok: true; revokedCount: number; scheduled: boolean }
  >
)._handler;
const restoreOwnedPackagesForUnbanBatchInternalHandler = (
  restoreOwnedPackagesForUnbanBatchInternal as unknown as WrappedHandler<
    {
      actorUserId?: string;
      ownerUserId: string;
      bannedAt: number;
      cursor?: string;
      scope?: "ownerUserId" | "personalPublisher";
    },
    { restoredCount: number; scheduled: boolean; stale?: true }
  >
)._handler;
const applyAccountDeletionToOwnedPackagesBatchInternalHandler = (
  applyAccountDeletionToOwnedPackagesBatchInternal as unknown as WrappedHandler<
    {
      ownerUserId: string;
      deletedAt: number;
      cursor?: string;
      scope?: "ownerUserId" | "personalPublisher";
    },
    { deletedCount: number; revokedTokenCount: number; scheduled: boolean }
  >
)._handler;
const restorePackageInternalHandler = (
  restorePackageInternal as unknown as WrappedHandler<
    { userId: string; name: string },
    {
      ok: true;
      packageId: string;
      releaseCount: number;
      alreadyRestored: boolean;
    }
  >
)._handler;
const transferPackageOwnerInternalHandler = (
  transferPackageOwnerInternal as unknown as WrappedHandler<
    {
      actorUserId: string;
      name: string;
      ownerUserId: string;
      ownerPublisherId?: string;
      channel?: "official" | "community" | "private";
      reason?: string;
    },
    { ok: true; packageId: string; ownerPublisherId?: string; channel: string }
  >
)._handler;
const transferPackageOwnerForUserInternalHandler = (
  transferPackageOwnerForUserInternal as unknown as WrappedHandler<
    {
      actorUserId: string;
      name: string;
      toOwner: string;
      reason?: string;
    },
    { ok: true; packageId: string; ownerPublisherId?: string; channel: string }
  >
)._handler;
const repairPackageIdentityInternalHandler = (
  repairPackageIdentityInternal as unknown as WrappedHandler<
    {
      actorUserId: string;
      name: string;
      nextName?: string;
      nextRuntimeId?: string;
      reason: string;
    },
    { ok: true; packageId: string; name: string; runtimeId?: string }
  >
)._handler;

beforeEach(() => {
  process.env.CLAWHUB_EXPERIMENTAL_CLAWS = "1";
  vi.mocked(verifyOpenClawPublishAuthorization).mockReset();
});

afterEach(() => {
  vi.mocked(getAuthUserId).mockReset();
  vi.mocked(getAuthUserId).mockResolvedValue(null);
});

function makeDigest(
  name: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    _id: `packageSearchDigest:${name}`,
    packageId: `packages:${name}`,
    name,
    normalizedName: name,
    displayName: name,
    family: "code-plugin",
    runtimeId: null,
    channel: "community",
    isOfficial: false,
    summary: `${name} summary`,
    ownerUserId: "users:owner",
    ownerPublisherId: undefined,
    ownerHandle: "owner",
    createdAt: 1,
    updatedAt: 1,
    latestVersion: "1.0.0",
    capabilityTags: [],
    pluginCategoryTags: [],
    executesCode: false,
    verificationTier: null,
    softDeletedAt: undefined,
    ...overrides,
  };
}

function makePackageDoc(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    _id: "packages:demo",
    name: "demo-plugin",
    normalizedName: "demo-plugin",
    displayName: "Demo Plugin",
    family: "code-plugin",
    channel: "community",
    isOfficial: false,
    ownerUserId: "users:owner",
    ownerPublisherId: undefined,
    tags: {},
    latestReleaseId: "packageReleases:demo-1",
    latestVersionSummary: { version: "1.0.0" },
    compatibility: null,
    capabilities: null,
    verification: null,
    scanStatus: "clean",
    stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
    createdAt: 1,
    updatedAt: 1,
    softDeletedAt: undefined,
    ...overrides,
  };
}

function makeCanDeleteVersionsCtx(options: {
  viewerId: string;
  viewerRole?: "user" | "admin" | "moderator";
  ownerUserId: string;
  ownerPublisherId?: string;
  membershipRole?: "owner" | "admin" | "publisher";
  packageLookupNames?: string[];
  packageMatchName?: string | null;
  packageOverrides?: Partial<Record<string, unknown>>;
}) {
  const pkg = makePackageDoc({
    ownerUserId: options.ownerUserId,
    ownerPublisherId: options.ownerPublisherId,
    ...options.packageOverrides,
  });
  const publisher = options.ownerPublisherId
    ? {
        _id: options.ownerPublisherId,
        kind: "org",
        handle: "demo-org",
        displayName: "Demo Org",
      }
    : null;

  return {
    db: {
      get: vi.fn(async (id: string) => {
        if (id === options.viewerId) {
          return { _id: id, role: options.viewerRole ?? "user" };
        }
        if (id === options.ownerPublisherId) return publisher;
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "users") {
          return {
            withIndex: vi.fn(() => ({
              unique: vi.fn().mockResolvedValue(null),
            })),
          };
        }
        if (table === "packages") {
          return {
            withIndex: vi.fn(
              (
                _indexName: string,
                builder?: (q: { eq: (field: string, value: string) => unknown }) => unknown,
              ) => {
                let normalizedName = "";
                const queryBuilder = {
                  eq: (field: string, value: string) => {
                    if (field === "normalizedName") normalizedName = value;
                    return queryBuilder;
                  },
                };
                builder?.(queryBuilder);
                options.packageLookupNames?.push(normalizedName);
                return {
                  unique: vi
                    .fn()
                    .mockResolvedValue(
                      options.packageMatchName === undefined ||
                        normalizedName === options.packageMatchName
                        ? pkg
                        : null,
                    ),
                };
              },
            ),
          };
        }
        if (table === "publisherMembers") {
          return {
            withIndex: vi.fn(
              (
                _indexName: string,
                builder?: (q: { eq: (field: string, value: string) => unknown }) => unknown,
              ) => {
                let publisherId = "";
                let userId = "";
                const queryBuilder = {
                  eq: (field: string, value: string) => {
                    if (field === "publisherId") publisherId = value;
                    if (field === "userId") userId = value;
                    return queryBuilder;
                  },
                };
                builder?.(queryBuilder);
                return {
                  unique: vi.fn().mockResolvedValue(
                    options.membershipRole &&
                      publisherId === options.ownerPublisherId &&
                      userId === options.viewerId
                      ? {
                          _id: "publisherMembers:viewer",
                          publisherId,
                          userId,
                          role: options.membershipRole,
                        }
                      : null,
                  ),
                };
              },
            ),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    },
  };
}

function readTestField(row: Record<string, unknown>, field: string): unknown {
  return field.split(".").reduce<unknown>((current, key) => {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, row);
}

function makeReleaseDoc(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    _id: "packageReleases:demo-1",
    packageId: "packages:demo",
    version: "1.0.0",
    createdAt: 1,
    softDeletedAt: undefined,
    createdBy: "users:owner",
    publishActor: { kind: "user", userId: "users:owner" },
    ...overrides,
  };
}

function makeDigestCtx(options: {
  pages?: Array<{
    page: Array<Record<string, unknown>>;
    isDone: boolean;
    continueCursor: string;
  }>;
  capabilityPages?: Array<{
    page: Array<Record<string, unknown>>;
    isDone: boolean;
    continueCursor: string;
  }>;
  topicPages?: Array<{
    page: Array<Record<string, unknown>>;
    isDone: boolean;
    continueCursor: string;
  }>;
  topicPagesByFamily?: Partial<
    Record<
      "skill" | "code-plugin" | "bundle-plugin",
      Array<{
        page: Array<Record<string, unknown>>;
        isDone: boolean;
        continueCursor: string;
      }>
    >
  >;
  categoryPages?: Array<{
    page: Array<Record<string, unknown>>;
    isDone: boolean;
    continueCursor: string;
  }>;
  categoryRows?: Array<Record<string, unknown>>;
  packagePages?: Array<{
    page: Array<Record<string, unknown>>;
    isDone: boolean;
    continueCursor: string;
  }>;
  exactPackages?: Array<Record<string, unknown>>;
  exactDigests?: Array<Record<string, unknown>>;
  officialDigests?: Array<Record<string, unknown>>;
  publisherDocs?: Record<string, Record<string, unknown>>;
  publisherMemberships?: Record<string, "owner" | "admin" | "publisher">;
  highlightedBadges?: Array<Record<string, unknown>>;
}) {
  const pageByTable = new Map<
    string,
    Map<
      string | null,
      {
        page: Array<Record<string, unknown>>;
        isDone: boolean;
        continueCursor: string;
      }
    >
  >();
  const rowsByTable = new Map<string, Array<Record<string, unknown>>>();
  const familyPagesByTable = new Map<
    string,
    Map<
      string,
      Map<
        string | null,
        {
          page: Array<Record<string, unknown>>;
          isDone: boolean;
          continueCursor: string;
        }
      >
    >
  >();
  const indexNames: string[] = [];
  const indexFilters: Array<{
    indexName: string;
    filters: Array<{ field: string; value: unknown }>;
  }> = [];
  const searchIndexNames: string[] = [];
  const tableNames: string[] = [];

  const setPages = (
    table: string,
    pages: Array<{
      page: Array<Record<string, unknown>>;
      isDone: boolean;
      continueCursor: string;
    }>,
  ) => {
    const pageByCursor = new Map<
      string | null,
      {
        page: Array<Record<string, unknown>>;
        isDone: boolean;
        continueCursor: string;
      }
    >();
    let cursor: string | null = null;
    for (const page of pages) {
      pageByCursor.set(cursor, page);
      cursor = page.continueCursor || null;
    }
    pageByTable.set(table, pageByCursor);
    rowsByTable.set(
      table,
      pages.flatMap((page) => page.page),
    );
  };

  setPages("packageSearchDigest", options.pages ?? []);
  setPages("packageCapabilitySearchDigest", options.capabilityPages ?? []);
  setPages("packageTopicSearchDigest", options.topicPages ?? []);
  if (options.topicPagesByFamily) {
    const pagesByFamily = new Map<
      string,
      Map<
        string | null,
        {
          page: Array<Record<string, unknown>>;
          isDone: boolean;
          continueCursor: string;
        }
      >
    >();
    for (const [family, pages] of Object.entries(options.topicPagesByFamily)) {
      const pagesByCursor = new Map<
        string | null,
        {
          page: Array<Record<string, unknown>>;
          isDone: boolean;
          continueCursor: string;
        }
      >();
      let cursor: string | null = null;
      for (const page of pages ?? []) {
        pagesByCursor.set(cursor, page);
        cursor = page.continueCursor || null;
      }
      pagesByFamily.set(family, pagesByCursor);
    }
    familyPagesByTable.set("packageTopicSearchDigest", pagesByFamily);
  }
  setPages("packagePluginCategorySearchDigest", options.categoryPages ?? []);
  if (options.categoryRows) {
    rowsByTable.set("packagePluginCategorySearchDigest", options.categoryRows);
  }
  setPages("packages", options.packagePages ?? []);

  const paginate = vi.fn();
  const take = vi.fn();
  const paginateForTable = (table: string, family?: string) =>
    vi.fn(async (args: { cursor: string | null }) => {
      paginate(args);
      return (
        familyPagesByTable
          .get(table)
          ?.get(family ?? "")
          ?.get(args.cursor ?? null) ??
        pageByTable.get(table)?.get(args.cursor ?? null) ?? {
          page: [],
          isDone: true,
          continueCursor: "",
        }
      );
    });
  const paginateByTable = new Map<string, ReturnType<typeof vi.fn>>();
  const getPaginate = (table: string, family?: string) => {
    const key = `${table}:${family ?? ""}`;
    const existing = paginateByTable.get(key);
    if (existing) return existing;
    const next = paginateForTable(table, family);
    paginateByTable.set(key, next);
    return next;
  };
  const takeForTable = (table: string) =>
    vi.fn(async (limit: number) => {
      take(limit);
      return (rowsByTable.get(table) ?? []).slice(0, limit);
    });
  const takeByTable = new Map<string, ReturnType<typeof vi.fn>>();
  const getTake = (table: string) => {
    const existing = takeByTable.get(table);
    if (existing) return existing;
    const next = takeForTable(table);
    takeByTable.set(table, next);
    return next;
  };
  const searchTake = vi.fn();
  const stringifySearchValue = (value: unknown) =>
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
      ? String(value)
      : "";
  const makeSearchQuery = (table: string, searchField: string, query: string) => ({
    take: vi.fn(async (limit: number) => {
      searchTake(limit);
      const queryTokens: string[] = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      if (queryTokens.length === 0) return [];
      return [...(options.exactDigests ?? []), ...(rowsByTable.get(table) ?? [])]
        .filter((row, index, rows) => {
          const rowId = stringifySearchValue(row._id ?? row.packageId) || String(index);
          return (
            rows.findIndex(
              (candidate) => stringifySearchValue(candidate._id ?? candidate.packageId) === rowId,
            ) === index
          );
        })
        .filter((row) => {
          const text = stringifySearchValue(readTestField(row, searchField)).toLowerCase();
          const textTokens: string[] = text.match(/[a-z0-9]+/g) ?? [];
          return queryTokens.some((queryToken) => textTokens.includes(queryToken));
        })
        .slice(0, limit);
    }),
  });

  const withIndex = vi.fn((table: string, indexName: string) => {
    indexNames.push(indexName);
    let ordered = false;
    return {
      first: vi.fn(async () => null),
      order: vi.fn(() => {
        if (ordered) throw new Error("query builder reused after iteration");
        ordered = true;
        return {
          paginate: getPaginate(table),
          take: getTake(table),
        };
      }),
    };
  });

  return {
    indexNames,
    indexFilters,
    searchIndexNames,
    tableNames,
    paginate,
    take,
    searchTake,
    ctx: {
      db: {
        get: vi.fn(async (id: string) => {
          const exactPackage = (options.exactPackages ?? []).find((pkg) => pkg._id === id);
          if (exactPackage) return exactPackage;
          if (options.publisherDocs?.[id]) return options.publisherDocs[id];
          if (options.publisherMemberships?.[id]) return { _id: id, kind: "org" };
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table === "packageBadges") {
            return {
              withIndex: vi.fn(() => ({
                order: vi.fn(() => ({
                  take: vi.fn().mockResolvedValue(options.highlightedBadges ?? []),
                })),
              })),
            };
          }
          if (table === "packages") {
            return {
              withIndex: vi.fn(
                (
                  indexName: string,
                  builder?: (q: {
                    eq: (field: string, value: unknown) => unknown;
                    gte: (field: string, value: string) => unknown;
                    lt: (field: string, value: string) => unknown;
                  }) => unknown,
                ) => {
                  let matchedValue = "";
                  let lowerBound = "";
                  let upperBound = "";
                  const filters: Array<{ field: string; value: unknown }> = [];
                  const rangeFilters: Array<{ field: string; value: number }> = [];
                  const queryBuilder = {
                    eq: (field: string, value: unknown) => {
                      filters.push({ field, value });
                      matchedValue = typeof value === "string" ? value : "";
                      return queryBuilder;
                    },
                    gte: (_field: string, value: string) => {
                      lowerBound = value;
                      return queryBuilder;
                    },
                    lt: (field: string, value: string | number) => {
                      upperBound = typeof value === "string" ? value : "";
                      if (typeof value === "number") {
                        rangeFilters.push({ field, value });
                      }
                      return queryBuilder;
                    },
                  };
                  builder?.(queryBuilder);
                  if (
                    indexName === "by_active_downloads" ||
                    indexName === "by_active_family_downloads" ||
                    indexName === "by_active_family_official_downloads" ||
                    indexName === "by_active_installs" ||
                    indexName === "by_active_family_installs" ||
                    indexName === "by_active_family_official_installs" ||
                    indexName === "by_active_recommended_rank" ||
                    indexName === "by_active_family_recommended_rank" ||
                    indexName === "by_active_recommended_score" ||
                    indexName === "by_active_family_recommended_score" ||
                    indexName === "by_active_recommended_score_version" ||
                    indexName === "by_active_family_recommended_score_version"
                  ) {
                    indexFilters.push({ indexName, filters });
                    const indexedQuery = withIndex(table, indexName);
                    return {
                      ...indexedQuery,
                      first: vi.fn().mockResolvedValue(
                        (rowsByTable.get(table) ?? []).find(
                          (row) =>
                            filters.every(
                              ({ field, value }) => readTestField(row, field) === value,
                            ) &&
                            rangeFilters.every(({ field, value }) => {
                              const current = readTestField(row, field);
                              return typeof current === "number" && current < value;
                            }),
                        ) ?? null,
                      ),
                    };
                  }
                  if (indexName !== "by_name" && indexName !== "by_runtime_id") {
                    throw new Error(`Unexpected packages index ${indexName}`);
                  }
                  const matches = (options.exactPackages ?? []).filter((pkg) =>
                    indexName === "by_name"
                      ? matchedValue
                        ? String(pkg.normalizedName) === matchedValue
                        : String(pkg.normalizedName) >= lowerBound &&
                          String(pkg.normalizedName) < upperBound
                      : matchedValue
                        ? String(pkg.runtimeId) === matchedValue
                        : String(pkg.runtimeId) >= lowerBound && String(pkg.runtimeId) < upperBound,
                  );
                  return {
                    unique: vi.fn().mockResolvedValue(matches[0] ?? null),
                    take: vi.fn().mockResolvedValue(matches),
                  };
                },
              ),
            };
          }
          if (table === "publisherMembers") {
            return {
              withIndex: vi.fn(
                (
                  _indexName: string,
                  builder?: (q: { eq: (field: string, value: string) => unknown }) => unknown,
                ) => {
                  let publisherId = "";
                  const queryBuilder = {
                    eq: (field: string, value: string) => {
                      if (field === "publisherId") publisherId = value;
                      return queryBuilder;
                    },
                  };
                  builder?.(queryBuilder);
                  const role = options.publisherMemberships?.[publisherId];
                  return {
                    unique: vi.fn().mockResolvedValue(
                      role
                        ? {
                            _id: `publisherMembers:${publisherId}`,
                            publisherId,
                            userId: "users:member",
                            role,
                          }
                        : null,
                    ),
                  };
                },
              ),
            };
          }
          if (table === "packageSearchDigest") {
            tableNames.push(table);
            return {
              withIndex: (
                indexName: string,
                builder?: (q: {
                  eq: (field: string, value: string | undefined) => unknown;
                  gte: (field: string, value: string) => unknown;
                  lt: (field: string, value: string) => unknown;
                }) => unknown,
              ) => {
                if (indexName === "by_package") {
                  let packageId = "";
                  const queryBuilder = {
                    eq: (field: string, value: string | undefined) => {
                      if (field === "packageId") packageId = value ?? "";
                      return queryBuilder;
                    },
                    gte: () => queryBuilder,
                    lt: () => queryBuilder,
                  };
                  builder?.(queryBuilder);
                  const match = (options.exactDigests ?? []).find(
                    (digest) => digest.packageId === packageId,
                  );
                  return {
                    unique: vi.fn().mockResolvedValue(match ?? null),
                  };
                }
                if (
                  indexName === "by_active_normalized_name" ||
                  indexName === "by_active_runtime_id" ||
                  indexName === "by_active_owner_handle"
                ) {
                  let lowerBound = "";
                  let upperBound = "";
                  const queryBuilder = {
                    eq: () => queryBuilder,
                    gte: (_field: string, value: string) => {
                      lowerBound = value;
                      return queryBuilder;
                    },
                    lt: (_field: string, value: string) => {
                      upperBound = value;
                      return queryBuilder;
                    },
                  };
                  builder?.(queryBuilder);
                  const matches = (options.exactDigests ?? []).filter((digest) =>
                    indexName === "by_active_normalized_name"
                      ? String(digest.normalizedName) >= lowerBound &&
                        String(digest.normalizedName) < upperBound
                      : indexName === "by_active_runtime_id"
                        ? String(digest.runtimeId) >= lowerBound &&
                          String(digest.runtimeId) < upperBound
                        : String(digest.ownerHandle) >= lowerBound &&
                          String(digest.ownerHandle) < upperBound,
                  );
                  return {
                    take: vi.fn().mockResolvedValue(matches),
                  };
                }
                if (options.officialDigests !== undefined && indexName.includes("_official_")) {
                  let family = "";
                  const queryBuilder = {
                    eq: (field: string, value: string | undefined) => {
                      if (field === "family") family = value ?? "";
                      return queryBuilder;
                    },
                    gte: () => queryBuilder,
                    lt: () => queryBuilder,
                  };
                  builder?.(queryBuilder);
                  const matches = (options.officialDigests ?? []).filter(
                    (digest) => !family || digest.family === family,
                  );
                  return {
                    take: vi.fn(async (limit: number) => matches.slice(0, limit)),
                    order: vi.fn(() => ({
                      paginate: getPaginate(table),
                      take: vi.fn(async (limit: number) => matches.slice(0, limit)),
                    })),
                  };
                }
                if (indexName.includes("_family_")) {
                  indexNames.push(indexName);
                  let family = "";
                  let lowerField = "";
                  let lowerBound = "";
                  let upperBound = "";
                  const queryBuilder = {
                    eq: (field: string, value: string | undefined) => {
                      if (field === "family") family = value ?? "";
                      return queryBuilder;
                    },
                    gte: (field: string, value: string) => {
                      lowerField = field;
                      lowerBound = value;
                      return queryBuilder;
                    },
                    lt: (_field: string, value: string) => {
                      upperBound = value;
                      return queryBuilder;
                    },
                  };
                  builder?.(queryBuilder);
                  const takeFamilyRows = async (limit: number) => {
                    take(limit);
                    return (rowsByTable.get(table) ?? [])
                      .filter((row) => row.family === family)
                      .filter((row) => {
                        if (!lowerField) return true;
                        const value = readTestField(row, lowerField);
                        return (
                          typeof value === "string" &&
                          value >= lowerBound &&
                          (!upperBound || value < upperBound)
                        );
                      })
                      .slice(0, limit);
                  };
                  return {
                    take: vi.fn(takeFamilyRows),
                    order: vi.fn(() => ({
                      paginate: getPaginate(table),
                      take: vi.fn(takeFamilyRows),
                    })),
                  };
                }
                return withIndex(table, indexName);
              },
              withSearchIndex: (
                indexName: string,
                builder?: (q: {
                  search: (
                    field: string,
                    query: string,
                  ) => {
                    eq: (field: string, value: string | undefined) => unknown;
                  };
                }) => unknown,
              ) => {
                searchIndexNames.push(indexName);
                let searchField = "";
                let query = "";
                const queryBuilder = {
                  eq: () => queryBuilder,
                  search: (field: string, value: string) => {
                    searchField = field;
                    query = value;
                    return queryBuilder;
                  },
                };
                builder?.(queryBuilder);
                return makeSearchQuery(table, searchField, query);
              },
            };
          }
          if (
            table !== "packageCapabilitySearchDigest" &&
            table !== "packageTopicSearchDigest" &&
            table !== "packagePluginCategorySearchDigest"
          ) {
            throw new Error(`Unexpected table ${table}`);
          }
          tableNames.push(table);
          return {
            withIndex: (
              indexName: string,
              builder?: (q: {
                eq: (field: string, value: unknown) => unknown;
                gte: (field: string, value: string) => unknown;
                lt: (field: string, value: string) => unknown;
              }) => unknown,
            ) => {
              if (indexName.includes("_family_")) {
                indexNames.push(indexName);
                let family = "";
                let exactTopic = "";
                let exactCategory = "";
                let lowerTopic = "";
                let upperTopic = "";
                const queryBuilder = {
                  eq: (field: string, value: unknown) => {
                    if (field === "family" && typeof value === "string") family = value;
                    if (field === "topic" && typeof value === "string") exactTopic = value;
                    if (field === "pluginCategory" && typeof value === "string") {
                      exactCategory = value;
                    }
                    return queryBuilder;
                  },
                  gte: (field: string, value: string) => {
                    if (field === "topic") lowerTopic = value;
                    return queryBuilder;
                  },
                  lt: (field: string, value: string) => {
                    if (field === "topic") upperTopic = value;
                    return queryBuilder;
                  },
                };
                builder?.(queryBuilder);
                const takeFamilyRows = async (limit: number) => {
                  take(limit);
                  return (rowsByTable.get(table) ?? [])
                    .filter((row) => row.family === family)
                    .filter((row) => !exactTopic || row.topic === exactTopic)
                    .filter((row) => !exactCategory || row.pluginCategory === exactCategory)
                    .filter((row) => {
                      if (!lowerTopic && !upperTopic) return true;
                      const topic = typeof row.topic === "string" ? row.topic : "";
                      return topic >= lowerTopic && topic < upperTopic;
                    })
                    .slice(0, limit);
                };
                return {
                  order: vi.fn(() => ({
                    paginate: getPaginate(table, family),
                    take: vi.fn(takeFamilyRows),
                  })),
                };
              }
              if (table !== "packageTopicSearchDigest" || indexName !== "by_active_topic_updated") {
                return withIndex(table, indexName);
              }
              let exactTopic = "";
              let lowerBound = "";
              let upperBound = "";
              const queryBuilder = {
                eq: (field: string, value: unknown) => {
                  if (field === "topic" && typeof value === "string") exactTopic = value;
                  return queryBuilder;
                },
                gte: (field: string, value: string) => {
                  if (field === "topic") lowerBound = value;
                  return queryBuilder;
                },
                lt: (field: string, value: string) => {
                  if (field === "topic") upperBound = value;
                  return queryBuilder;
                },
              };
              builder?.(queryBuilder);
              const baseQuery = withIndex(table, indexName);
              return {
                ...baseQuery,
                order: () => {
                  const ordered = baseQuery.order();
                  return {
                    ...ordered,
                    take: async (limit: number) => {
                      take(limit);
                      const rows = rowsByTable.get(table) ?? [];
                      return rows
                        .filter((row) => {
                          const rowTopic = typeof row.topic === "string" ? row.topic : "";
                          if (exactTopic) return rowTopic === exactTopic;
                          return rowTopic >= lowerBound && rowTopic < upperBound;
                        })
                        .slice(0, limit);
                    },
                  };
                },
              };
            },
          };
        }),
      },
    },
  };
}

function makePluginExportDigest(
  name: string,
  family: "code-plugin" | "bundle-plugin",
  updatedAt: number,
) {
  return makeDigest(name, {
    _id: `packageSearchDigest:${name}`,
    packageId: `packages:${name}`,
    family,
    scanStatus: "clean",
    updatedAt,
    _creationTime: updatedAt,
  });
}

function readIndexField(row: Record<string, unknown>, field: string) {
  return field.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[segment];
  }, row);
}

function makePluginExportIndexKey(row: Record<string, unknown>, field = "updatedAt") {
  return [row.softDeletedAt, row.family, row[field], row._creationTime, row._id] as unknown[];
}

function makePluginExportCtx(
  digests: Array<Record<string, unknown>>,
  options?: { recommendationScoresMissing?: () => boolean },
) {
  const packagesById = new Map(
    digests.map((digest) => [
      String(digest.packageId),
      makePackageDoc({
        _id: digest.packageId,
        name: digest.name,
        normalizedName: digest.normalizedName,
        displayName: digest.displayName,
        family: digest.family,
        ownerUserId: digest.ownerUserId,
        ownerPublisherId: digest.ownerPublisherId,
        latestReleaseId: `packageReleases:${String(digest.name)}-1`,
        latestVersionSummary: { version: digest.latestVersion },
        stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
        scanStatus: "clean",
        createdAt: digest.createdAt,
        updatedAt: digest.updatedAt,
      }),
    ]),
  );

  return {
    db: {
      get: vi.fn(async (id: string) => packagesById.get(id) ?? null),
      query: vi.fn((table: string) => {
        if (table === "packages") {
          return {
            withIndex: vi.fn(() => ({
              first: vi.fn(async () =>
                options?.recommendationScoresMissing?.() ? { _id: "packages:missing-score" } : null,
              ),
            })),
          };
        }
        if (table !== "packageSearchDigest") throw new Error(`Unexpected table ${table}`);
        return {
          withIndex: vi.fn(
            (
              indexName: string,
              builder?: (q: {
                eq: (field: string, value: unknown) => unknown;
                gt: (field: string, value: unknown) => unknown;
                gte: (field: string, value: unknown) => unknown;
                lt: (field: string, value: unknown) => unknown;
                lte: (field: string, value: unknown) => unknown;
              }) => unknown,
            ) => {
              if (
                indexName !== "by_active_family_updated" &&
                indexName !== "by_active_family_created"
              ) {
                throw new Error(`Unexpected packageSearchDigest index ${indexName}`);
              }
              const filters: Array<{
                op: "eq" | "gt" | "gte" | "lt" | "lte";
                field: string;
                value: unknown;
              }> = [];
              const queryBuilder = {
                eq: (field: string, value: unknown) => {
                  filters.push({ op: "eq", field, value });
                  return queryBuilder;
                },
                gt: (field: string, value: unknown) => {
                  filters.push({ op: "gt", field, value });
                  return queryBuilder;
                },
                gte: (field: string, value: unknown) => {
                  filters.push({ op: "gte", field, value });
                  return queryBuilder;
                },
                lt: (field: string, value: unknown) => {
                  filters.push({ op: "lt", field, value });
                  return queryBuilder;
                },
                lte: (field: string, value: unknown) => {
                  filters.push({ op: "lte", field, value });
                  return queryBuilder;
                },
              };
              builder?.(queryBuilder);
              return {
                order: vi.fn((order: "asc" | "desc") => {
                  const matches = digests
                    .filter((row) =>
                      filters.every(({ op, field, value }) => {
                        const current = readIndexField(row, field);
                        if (op === "eq") return current === value;
                        if (op === "gt") return (current as number) > (value as number);
                        if (op === "gte") return (current as number) >= (value as number);
                        if (op === "lt") return (current as number) < (value as number);
                        return (current as number) <= (value as number);
                      }),
                    )
                    .sort((a, b) => {
                      const sortField =
                        indexName === "by_active_family_created" ? "createdAt" : "updatedAt";
                      const metricDiff = Number(a[sortField]) - Number(b[sortField]);
                      if (metricDiff !== 0) return order === "desc" ? -metricDiff : metricDiff;
                      const idDiff = String(a._id).localeCompare(String(b._id));
                      return order === "desc" ? -idDiff : idDiff;
                    });
                  return {
                    async *[Symbol.asyncIterator]() {
                      for (const row of matches) {
                        yield row;
                      }
                    },
                    async *iterWithKeys() {
                      for (const row of matches) {
                        yield [
                          row,
                          makePluginExportIndexKey(
                            row,
                            indexName === "by_active_family_created" ? "createdAt" : "updatedAt",
                          ),
                        ];
                      }
                    },
                  };
                }),
              };
            },
          ),
        };
      }),
    },
  };
}

function makePluginValidationReportCtx(
  digests: Array<Record<string, unknown>>,
  options: {
    statesByRelease?: Record<string, Array<Record<string, unknown>>>;
    findingsByRelease?: Record<string, Array<Record<string, unknown>>>;
  } = {},
) {
  const base = makePluginExportCtx(digests);
  const releasesById = new Map(
    digests.map((digest) => {
      const name = String(digest.name);
      const packageId = String(digest.packageId);
      return [
        `packageReleases:${name}-1`,
        {
          _id: `packageReleases:${name}-1`,
          packageId,
          version: typeof digest.latestVersion === "string" ? digest.latestVersion : "1.0.0",
          createdAt: Number(digest.createdAt),
        },
      ];
    }),
  );
  return {
    db: {
      get: vi.fn(async (id: string) => (await base.db.get(id)) ?? releasesById.get(id) ?? null),
      query: vi.fn((table: string) => {
        if (table === "packageSearchDigest" || table === "packages") {
          return base.db.query(table);
        }
        if (table === "packageInspectorScanStates") {
          let releaseId = "";
          return {
            withIndex: vi.fn(
              (
                _indexName: string,
                builder: (q: { eq: (field: string, value: unknown) => unknown }) => unknown,
              ) => {
                const queryBuilder = {
                  eq: (field: string, value: unknown) => {
                    if (field === "releaseId") releaseId = String(value);
                    return queryBuilder;
                  },
                };
                builder(queryBuilder);
                return {
                  order: vi.fn(() => ({
                    first: vi.fn(
                      async () =>
                        [...(options.statesByRelease?.[releaseId] ?? [])].sort(
                          (a, b) => Number(b.completedAt) - Number(a.completedAt),
                        )[0] ?? null,
                    ),
                  })),
                };
              },
            ),
          };
        }
        if (table === "packageInspectorWarnings") {
          let releaseId = "";
          return {
            withIndex: vi.fn(
              (
                _indexName: string,
                builder: (q: { eq: (field: string, value: unknown) => unknown }) => unknown,
              ) => {
                const queryBuilder = {
                  eq: (field: string, value: unknown) => {
                    if (field === "releaseId") releaseId = String(value);
                    return queryBuilder;
                  },
                };
                builder(queryBuilder);
                return {
                  order: vi.fn(() => ({
                    collect: vi.fn(async () => options.findingsByRelease?.[releaseId] ?? []),
                  })),
                };
              },
            ),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    },
  };
}

function makeInsertReleaseCtx(
  existing: Record<string, unknown> | null,
  priorReleases: Array<Record<string, unknown>> = [],
  recordsById: Record<string, Record<string, unknown>> = {},
  runtimePackages: Array<Record<string, unknown>> = [],
  finalPublisherMembershipRole?: "owner" | "admin" | "publisher" | null,
  packageReleaseReadLimitBytes?: number,
) {
  let insertedPackage: Record<string, unknown> | null = null;
  const patch = vi.fn(async (id: string, value: Record<string, unknown>) => {
    const target =
      recordsById[id] ??
      priorReleases.find((release) => release._id === id) ??
      (existing?._id === id ? existing : null) ??
      (insertedPackage?._id === id ? insertedPackage : null);
    if (target) Object.assign(target, value);
  });
  const scheduler = {
    runAfter: vi.fn(),
  };
  let packageReleaseBytesRead = 0;
  const readPackageRelease = (record: Record<string, unknown> | null) => {
    if (!record || packageReleaseReadLimitBytes === undefined) return record;
    packageReleaseBytesRead += JSON.stringify(record).length;
    if (packageReleaseBytesRead > packageReleaseReadLimitBytes) {
      throw new Error(
        `Too many bytes read in a single function execution (limit: ${packageReleaseReadLimitBytes} bytes).`,
      );
    }
    return record;
  };
  const insert = vi.fn(async (table: string, doc: Record<string, unknown>) => {
    if (table === "packages") {
      insertedPackage = makePackageDoc({
        ...doc,
        _id: "packages:new",
        tags: {},
        latestReleaseId: undefined,
        latestVersionSummary: undefined,
        stats: { downloads: 0, installs: 0, stars: 0, versions: 0 },
      });
      return "packages:new";
    }
    if (table === "packageReleases") return "packageReleases:new";
    return `${table}:new`;
  });
  return {
    patch,
    insert,
    scheduler,
    resetPackageReleaseReadBudget: () => {
      packageReleaseBytesRead = 0;
    },
    db: {
      get: vi.fn(async (id: string) => {
        if (id in recordsById) {
          return id.startsWith("packageReleases:")
            ? readPackageRelease(recordsById[id])
            : recordsById[id];
        }
        if (id === "packages:new") return insertedPackage;
        if (existing?._id === id) return existing;
        if (id === "users:owner") return { _id: id, role: "user", trustedPublisher: false };
        const priorRelease = priorReleases.find((release) => release._id === id);
        if (priorRelease) return readPackageRelease(priorRelease);
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "packages") {
          return {
            withIndex: vi.fn(
              (
                indexName: string,
                buildQuery?: (q: { eq: (field: string, value: unknown) => unknown }) => unknown,
              ) => {
                const filters = new Map<string, unknown>();
                const query = {
                  eq(field: string, value: unknown) {
                    filters.set(field, value);
                    return query;
                  },
                };
                buildQuery?.(query);
                if (
                  indexName === "by_ownerUserId_ownerPublisherId_runtimeId_softDeletedAt" ||
                  indexName === "by_ownerPublisherId_runtimeId_softDeletedAt"
                ) {
                  const matches = runtimePackages.filter((pkg) =>
                    [...filters].every(([field, value]) => pkg[field] === value),
                  );
                  return {
                    async *[Symbol.asyncIterator]() {
                      yield* matches;
                    },
                    collect: vi.fn().mockResolvedValue(matches),
                    unique: vi.fn().mockResolvedValue(matches[0] ?? null),
                  };
                }
                return {
                  unique: vi.fn().mockResolvedValue(existing),
                };
              },
            ),
          };
        }
        if (table === "packageReleases") {
          return {
            withIndex: vi.fn(
              (
                indexName: string,
                buildQuery?: (q: { eq: (field: string, value: unknown) => unknown }) => unknown,
              ) => {
                if (indexName === "by_package") {
                  return {
                    collect: vi.fn(async () => {
                      if (
                        packageReleaseReadLimitBytes !== undefined &&
                        JSON.stringify(priorReleases).length > packageReleaseReadLimitBytes
                      ) {
                        throw new Error(
                          `Too many bytes read in a single function execution (limit: ${packageReleaseReadLimitBytes} bytes).`,
                        );
                      }
                      return priorReleases;
                    }),
                  };
                }
                if (indexName === "by_package_version") {
                  const filters = new Map<string, unknown>();
                  const query = {
                    eq(field: string, value: unknown) {
                      filters.set(field, value);
                      return query;
                    },
                  };
                  buildQuery?.(query);
                  return {
                    unique: vi
                      .fn()
                      .mockResolvedValue(
                        priorReleases.find(
                          (release) =>
                            release.packageId === filters.get("packageId") &&
                            release.version === filters.get("version"),
                        ) ?? null,
                      ),
                  };
                }
                return {
                  unique: vi.fn().mockResolvedValue(null),
                };
              },
            ),
          };
        }
        if (table === "publisherMembers") {
          return {
            withIndex: vi.fn(
              (
                _indexName: string,
                buildQuery?: (q: { eq: (field: string, value: unknown) => unknown }) => unknown,
              ) => {
                const filters = new Map<string, unknown>();
                const query = {
                  eq(field: string, value: unknown) {
                    filters.set(field, value);
                    return query;
                  },
                };
                buildQuery?.(query);
                const membership =
                  finalPublisherMembershipRole &&
                  filters.get("publisherId") === "publishers:org" &&
                  filters.get("userId") === "users:member"
                    ? {
                        _id: "publisherMembers:org-member",
                        publisherId: "publishers:org",
                        userId: "users:member",
                        role: finalPublisherMembershipRole,
                      }
                    : null;
                return {
                  unique: vi.fn().mockResolvedValue(membership),
                };
              },
            ),
          };
        }
        if (table === "officialPublishers") {
          return {
            withIndex: vi.fn(
              (
                _indexName: string,
                buildQuery?: (q: { eq: (field: string, value: unknown) => unknown }) => unknown,
              ) => {
                const filters = new Map<string, unknown>();
                const query = {
                  eq(field: string, value: unknown) {
                    filters.set(field, value);
                    return query;
                  },
                };
                buildQuery?.(query);
                const rawPublisherId = filters.get("publisherId");
                const publisherId = typeof rawPublisherId === "string" ? rawPublisherId : "";
                const publisher = recordsById[publisherId];
                return {
                  unique: vi
                    .fn()
                    .mockResolvedValue(
                      publisher?.handle === "openclaw"
                        ? { _id: "officialPublishers:openclaw", publisherId }
                        : null,
                    ),
                };
              },
            ),
          };
        }
        if (table === "packageTrustedPublishers") {
          return {
            withIndex: vi.fn(
              (
                _indexName: string,
                buildQuery?: (q: { eq: (field: string, value: unknown) => unknown }) => unknown,
              ) => {
                const filters = new Map<string, unknown>();
                const query = {
                  eq(field: string, value: unknown) {
                    filters.set(field, value);
                    return query;
                  },
                };
                buildQuery?.(query);
                const trustedPublisher =
                  Object.values(recordsById).find(
                    (record) =>
                      String(record._id).startsWith("packageTrustedPublishers:") &&
                      record.packageId === filters.get("packageId"),
                  ) ?? null;
                return {
                  unique: vi.fn().mockResolvedValue(trustedPublisher),
                };
              },
            ),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      }),
      insert,
      patch,
      replace: vi.fn(),
      delete: vi.fn(),
      normalizeId: vi.fn(),
    },
  };
}

async function flushScheduledPackageReleaseTagCleanup(
  ctx: ReturnType<typeof makeInsertReleaseCtx>,
) {
  for (let callIndex = 0; callIndex < ctx.scheduler.runAfter.mock.calls.length; callIndex += 1) {
    const [, , args] = ctx.scheduler.runAfter.mock.calls[callIndex] as [
      number,
      unknown,
      {
        packageId: string;
        assignments: Array<{ releaseId: string; tags: string[] }>;
        offset?: number;
      },
    ];
    ctx.resetPackageReleaseReadBudget();
    await cleanupReassignedPackageReleaseTagsInternalHandler(ctx, args);
  }
}

function makeReservePackageNameCtx(options?: {
  existing?: Record<string, unknown> | null;
  actor?: Record<string, unknown> | null;
  owner?: Record<string, unknown> | null;
  ownerPublisher?: Record<string, unknown> | null;
}) {
  const insert = vi
    .fn()
    .mockResolvedValueOnce("packages:reserved")
    .mockResolvedValueOnce("auditLogs:reserved");
  return {
    insert,
    ctx: {
      db: {
        get: vi.fn(async (id: string) => {
          if (id === "users:admin") {
            return options?.actor ?? { _id: id, role: "admin" };
          }
          if (id === "users:openclaw") {
            return options?.owner ?? { _id: id, role: "user" };
          }
          if (id === "publishers:openclaw") {
            return (
              options?.ownerPublisher ?? {
                _id: id,
                kind: "org",
                handle: "openclaw",
                displayName: "OpenClaw",
                trustedPublisher: true,
              }
            );
          }
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table !== "packages") throw new Error(`Unexpected table ${table}`);
          return {
            withIndex: vi.fn(() => ({
              unique: vi.fn().mockResolvedValue(options?.existing ?? null),
            })),
          };
        }),
        insert,
        patch: vi.fn(),
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn(),
      },
    },
  };
}

function makeTransferPackageOwnerCtx(options?: {
  pkg?: Record<string, unknown> | null;
  actor?: Record<string, unknown> | null;
  owner?: Record<string, unknown> | null;
  ownerPublisher?: Record<string, unknown> | null;
}) {
  const pkg = options?.pkg ?? makePackageDoc();
  const packageSearchDigest = { _id: "packageSearchDigest:demo", packageId: pkg?._id };
  const patch = vi.fn();
  const insert = vi.fn();
  return {
    insert,
    patch,
    ctx: {
      db: {
        get: vi.fn(async (id: string) => {
          if (id === "users:admin") {
            return options?.actor ?? { _id: id, role: "admin" };
          }
          if (id === "users:openclaw") {
            return options?.owner ?? { _id: id, role: "user" };
          }
          if (id === "publishers:openclaw") {
            return (
              options?.ownerPublisher ?? {
                _id: id,
                kind: "org",
                handle: "openclaw",
                displayName: "OpenClaw",
                trustedPublisher: true,
              }
            );
          }
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table === "packages") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(pkg),
                collect: vi.fn().mockResolvedValue(pkg ? [pkg] : []),
                async *[Symbol.asyncIterator]() {
                  if (pkg) yield pkg;
                },
              })),
            };
          }
          if (table === "packageSearchDigest") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(packageSearchDigest),
              })),
            };
          }
          if (table === "officialPublishers") {
            return {
              withIndex: vi.fn((_indexName: string, builder: (q: unknown) => unknown) => {
                const terms: Record<string, unknown> = {};
                builder({
                  eq: (field: string, value: unknown) => {
                    terms[field] = value;
                    return {};
                  },
                });
                const ownerPublisher =
                  terms.publisherId === "publishers:openclaw"
                    ? (options?.ownerPublisher ?? {
                        _id: "publishers:openclaw",
                        kind: "org",
                        handle: "openclaw",
                        displayName: "OpenClaw",
                        trustedPublisher: true,
                      })
                    : null;
                return {
                  unique: vi
                    .fn()
                    .mockResolvedValue(
                      ownerPublisher?.handle === "openclaw"
                        ? { _id: "officialPublishers:openclaw", publisherId: terms.publisherId }
                        : null,
                    ),
                };
              }),
            };
          }
          if (
            table === "packageCapabilitySearchDigest" ||
            table === "packageTopicSearchDigest" ||
            table === "packagePluginCategorySearchDigest"
          ) {
            return {
              withIndex: vi.fn(() => ({
                collect: vi.fn().mockResolvedValue([]),
              })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
        insert,
        patch,
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn(),
      },
    },
  };
}

function makeUserTransferPackageOwnerCtx(options?: {
  pkg?: Record<string, unknown> | null;
  actor?: Record<string, unknown> | null;
  sourcePublisher?: Record<string, unknown> | null;
  destinationPublisher?: Record<string, unknown> | null;
  sourceMembershipRole?: "owner" | "admin" | "publisher" | null;
  destinationMembershipRole?: "owner" | "admin" | "publisher" | null;
  trustedPublisher?: Record<string, unknown> | null;
}) {
  const pkg =
    options?.pkg ??
    makePackageDoc({
      _id: "packages:opik",
      name: "@opik/opik-openclaw",
      normalizedName: "@opik/opik-openclaw",
      ownerUserId: "users:vincent",
      ownerPublisherId: "publishers:vincent",
      stats: { downloads: 42, installs: 7, stars: 3, versions: 1 },
    });
  const actor = options?.actor ?? { _id: "users:vincent", role: "user" };
  const destinationPublisher =
    options?.destinationPublisher === undefined
      ? {
          _id: "publishers:opik",
          kind: "org",
          handle: "opik",
          displayName: "Opik",
          trustedPublisher: false,
        }
      : options.destinationPublisher;
  const patch = vi.fn();
  const insert = vi.fn();
  const packageSearchDigest = { _id: "packageSearchDigest:opik", packageId: pkg?._id };
  return {
    insert,
    patch,
    pkg,
    ctx: {
      db: {
        get: vi.fn(async (id: string) => {
          if (id === "users:vincent") return actor;
          if (id === "publishers:vincent") {
            if (options?.sourcePublisher !== undefined) return options.sourcePublisher;
            return {
              _id: id,
              kind: "user",
              handle: "vincentkoc",
              linkedUserId: "users:vincent",
            };
          }
          if (id === "publishers:opik") return destinationPublisher;
          if (id === "packageTrustedPublishers:opik") return options?.trustedPublisher ?? null;
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table === "packages") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(pkg),
              })),
            };
          }
          if (table === "packageSearchDigest") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(packageSearchDigest),
              })),
            };
          }
          if (
            table === "packageCapabilitySearchDigest" ||
            table === "packageTopicSearchDigest" ||
            table === "packagePluginCategorySearchDigest"
          ) {
            return {
              withIndex: vi.fn(() => ({
                collect: vi.fn().mockResolvedValue([]),
              })),
            };
          }
          if (table === "publishers") {
            return {
              withIndex: vi.fn((_indexName: string, builder: (q: unknown) => unknown) => {
                const terms: Record<string, unknown> = {};
                builder({
                  eq: (field: string, value: unknown) => {
                    terms[field] = value;
                    return {};
                  },
                });
                return {
                  unique: vi
                    .fn()
                    .mockResolvedValue(terms.handle === "opik" ? destinationPublisher : null),
                };
              }),
            };
          }
          if (table === "publisherMembers") {
            return {
              withIndex: vi.fn((_indexName: string, builder: (q: unknown) => unknown) => {
                const terms: Record<string, unknown> = {};
                builder({
                  eq: (field: string, value: unknown) => {
                    terms[field] = value;
                    return {
                      eq: (nextField: string, nextValue: unknown) => {
                        terms[nextField] = nextValue;
                        return {};
                      },
                    };
                  },
                });
                const publisherId = typeof terms.publisherId === "string" ? terms.publisherId : "";
                const role =
                  publisherId === "publishers:vincent"
                    ? options?.sourceMembershipRole
                    : publisherId === "publishers:opik"
                      ? options?.destinationMembershipRole
                      : null;
                return {
                  unique: vi
                    .fn()
                    .mockResolvedValue(
                      role ? { _id: `publisherMembers:${publisherId}`, publisherId, role } : null,
                    ),
                };
              }),
            };
          }
          if (table === "officialPublishers") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(null),
              })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
        insert,
        patch,
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn(),
      },
    },
  };
}

function makePackageCtx(options: {
  pkg?: Record<string, unknown> | null;
  latestRelease?: Record<string, unknown> | null;
  versionRelease?: Record<string, unknown> | null;
  versionsPage?: {
    page: Array<Record<string, unknown>>;
    isDone: boolean;
    continueCursor: string;
  };
  ownerPublisher?: Record<string, unknown> | null;
  viewerMembershipRole?: "owner" | "admin" | "publisher" | null;
}) {
  const pkg = options.pkg ?? makePackageDoc();
  const latestRelease = options.latestRelease ?? makeReleaseDoc();
  const versionRelease = options.versionRelease ?? latestRelease;
  const ownerPublisher = options.ownerPublisher ?? null;
  const versionsPage = options.versionsPage ?? {
    page: [latestRelease].filter(Boolean),
    isDone: true,
    continueCursor: "",
  };

  const releaseIndexNames: string[] = [];
  return {
    releaseIndexNames,
    ctx: {
      db: {
        get: vi.fn(async (id: string) => {
          if (typeof id === "string" && id.startsWith("users:")) {
            return { _id: id, handle: id.split(":").pop() ?? "user" };
          }
          if (ownerPublisher && pkg && id === pkg.ownerPublisherId) return ownerPublisher;
          if (pkg && id === pkg.latestReleaseId) return latestRelease;
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table === "packages") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(pkg),
              })),
            };
          }
          if (table === "packageReleases") {
            const filteredVersionsPage = {
              ...versionsPage,
              page: versionsPage.page.filter((release) => release.softDeletedAt === undefined),
            };
            return {
              withIndex: vi.fn((indexName: string) => {
                releaseIndexNames.push(indexName);
                if (indexName === "by_package_active_created") {
                  return {
                    order: vi.fn(() => ({
                      paginate: vi.fn().mockResolvedValue(filteredVersionsPage),
                    })),
                  };
                }
                return {
                  unique: vi.fn().mockResolvedValue(versionRelease),
                  filter: vi.fn(() => ({
                    order: vi.fn(() => ({
                      paginate: vi.fn().mockResolvedValue(filteredVersionsPage),
                    })),
                  })),
                  order: vi.fn(() => ({
                    paginate: vi.fn().mockResolvedValue(versionsPage),
                  })),
                };
              }),
            };
          }
          if (table === "publisherMembers") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(
                  options.viewerMembershipRole
                    ? {
                        _id: "publisherMembers:1",
                        publisherId: pkg?.ownerPublisherId,
                        userId: "users:member",
                        role: options.viewerMembershipRole,
                      }
                    : null,
                ),
              })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      },
    },
  };
}

function makeSoftDeletePackageCtx(options?: {
  pkg?: Record<string, unknown> | null;
  releases?: Array<Record<string, unknown>>;
  user?: Record<string, unknown> | null;
  membership?: Record<string, unknown> | null;
  packageSearchDigest?: Record<string, unknown> | null;
  capabilityDigests?: Array<Record<string, unknown>>;
}) {
  const pkg = options?.pkg ?? makePackageDoc();
  const releases = options?.releases ?? [makeReleaseDoc()];
  const user = options?.user ?? { _id: "users:owner", role: "user" };
  const membership = options?.membership ?? null;
  const packageSearchDigest =
    options?.packageSearchDigest === undefined
      ? { _id: "packageSearchDigest:demo", packageId: pkg?._id }
      : options.packageSearchDigest;
  const capabilityDigests = options?.capabilityDigests ?? [];
  const patch = vi.fn();
  const insert = vi.fn();
  return {
    patch,
    insert,
    ctx: {
      db: {
        get: vi.fn(async (id: string) => {
          if (id === "users:owner" || id === "users:moderator") return user;
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table === "packages") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(pkg),
              })),
            };
          }
          if (table === "packageReleases") {
            return {
              withIndex: vi.fn(() => ({
                collect: vi.fn().mockResolvedValue(releases),
              })),
            };
          }
          if (table === "publisherMembers") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(membership),
              })),
            };
          }
          if (table === "packageSearchDigest") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(packageSearchDigest),
              })),
            };
          }
          if (
            table === "packageCapabilitySearchDigest" ||
            table === "packageTopicSearchDigest" ||
            table === "packagePluginCategorySearchDigest"
          ) {
            return {
              withIndex: vi.fn(() => ({
                collect: vi.fn().mockResolvedValue(capabilityDigests),
              })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
        patch,
        insert,
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn(),
      },
    },
  };
}

function makePackagePreviewAccessCtx(options: {
  actorUserId: string;
  actorRole?: "user" | "admin" | "moderator";
  pkg: ReturnType<typeof makePackageDoc> | null;
  membershipRole?: "owner" | "admin" | "publisher";
}) {
  const publisher = options.pkg?.ownerPublisherId
    ? {
        _id: options.pkg.ownerPublisherId,
        kind: "org",
        handle: "owner-org",
        displayName: "Owner Org",
      }
    : null;

  return {
    db: {
      get: vi.fn(async (id: string) => {
        if (id === options.actorUserId) return { _id: id, role: options.actorRole ?? "user" };
        if (publisher && id === publisher._id) return publisher;
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "packages") {
          return {
            withIndex: vi.fn(() => ({
              unique: vi.fn().mockResolvedValue(options.pkg),
            })),
          };
        }
        if (table === "publisherMembers") {
          return {
            withIndex: vi.fn(() => ({
              unique: vi.fn().mockResolvedValue(
                options.membershipRole && publisher
                  ? {
                      _id: "publisherMembers:preview",
                      publisherId: publisher._id,
                      userId: options.actorUserId,
                      role: options.membershipRole,
                    }
                  : null,
              ),
            })),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    },
  };
}

describe("packages public queries", () => {
  it("generates a package changelog preview from prior release history", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue("users:preview" as never);
    const previousKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const runQuery = vi
        .fn()
        .mockResolvedValueOnce({
          _id: "users:preview",
          role: "user",
        })
        .mockResolvedValueOnce({ ok: true, latestReleaseId: "packageReleases:demo-1" })
        .mockResolvedValueOnce({
          _id: "packageReleases:demo-1",
          files: [{ path: "README.md", storageId: "storage:readme", sha256: "old" }],
        });
      const storageGet = vi.fn(async () => new Blob(["# Demo\n\nOld README"]));

      const result = await generateChangelogPreviewHandler(
        {
          runQuery,
          storage: { get: storageGet },
        } as never,
        {
          name: "demo-plugin",
          family: "code-plugin",
          version: "1.2.0",
          readmeText: "# Demo\n\nNew README",
          filePaths: ["README.md", "src/index.ts"],
        },
      );

      expect(result.changelog).toContain("Updated README and package contents");
      expect(runQuery).toHaveBeenCalledTimes(3);
      expect(storageGet).toHaveBeenCalledWith("storage:readme");
    } finally {
      if (previousKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousKey;
      }
    }
  });

  it("blocks package changelog previews before reading release storage when access is denied", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue("users:preview" as never);
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce({
        _id: "users:preview",
        role: "user",
      })
      .mockRejectedValueOnce(new Error("Forbidden"));
    const storageGet = vi.fn();

    await expect(
      generateChangelogPreviewHandler(
        {
          runQuery,
          storage: { get: storageGet },
        } as never,
        {
          name: "demo-plugin",
          family: "code-plugin",
          version: "1.2.0",
          readmeText: "# Demo\n\nNew README",
          filePaths: ["README.md"],
        },
      ),
    ).rejects.toThrow("Forbidden");

    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(storageGet).not.toHaveBeenCalled();
  });

  it("rejects non-owner package changelog previews for existing packages", async () => {
    const pkg = makePackageDoc({
      ownerUserId: "users:owner",
      ownerPublisherId: "publishers:owner-org",
    });

    await expect(
      assertCanGenerateChangelogPreviewInternalHandler(
        makePackagePreviewAccessCtx({
          actorUserId: "users:viewer",
          pkg,
        }) as never,
        { actorUserId: "users:viewer", name: "demo-plugin" },
      ),
    ).rejects.toThrow("Forbidden");
  });

  it("allows direct owners to generate package changelog previews", async () => {
    await expect(
      assertCanGenerateChangelogPreviewInternalHandler(
        makePackagePreviewAccessCtx({
          actorUserId: "users:owner",
          pkg: makePackageDoc({ ownerUserId: "users:owner" }),
        }) as never,
        { actorUserId: "users:owner", name: "demo-plugin" },
      ),
    ).resolves.toMatchObject({ ok: true, latestReleaseId: expect.anything() });
  });

  it.each(["owner", "admin", "publisher"] as const)(
    "allows org %s members to generate package changelog previews",
    async (membershipRole) => {
      const pkg = makePackageDoc({
        ownerUserId: "users:creator",
        ownerPublisherId: "publishers:owner-org",
      });

      await expect(
        assertCanGenerateChangelogPreviewInternalHandler(
          makePackagePreviewAccessCtx({
            actorUserId: "users:publisher-member",
            pkg,
            membershipRole,
          }) as never,
          { actorUserId: "users:publisher-member", name: "demo-plugin" },
        ),
      ).resolves.toMatchObject({ ok: true, latestReleaseId: expect.anything() });
    },
  );

  it.each(["admin", "moderator"] as const)(
    "allows platform %s users to generate package changelog previews",
    async (actorRole) => {
      await expect(
        assertCanGenerateChangelogPreviewInternalHandler(
          makePackagePreviewAccessCtx({
            actorUserId: "users:staff",
            actorRole,
            pkg: makePackageDoc({ ownerUserId: "users:owner" }),
          }) as never,
          { actorUserId: "users:staff", name: "demo-plugin" },
        ),
      ).resolves.toMatchObject({ ok: true, latestReleaseId: expect.anything() });
    },
  );

  it("pages eligible plugins by immutable creation time without scanning the catalog client-side", async () => {
    const ctx = makePluginExportCtx([
      makeDigest("updated-old", {
        family: "code-plugin",
        createdAt: 50,
        updatedAt: 500,
        _creationTime: 1,
      }),
      makeDigest("newest-bundle", {
        family: "bundle-plugin",
        createdAt: 300,
        updatedAt: 300,
        _creationTime: 2,
      }),
      makeDigest("newer-code", {
        family: "code-plugin",
        createdAt: 200,
        updatedAt: 200,
        _creationTime: 3,
      }),
      makeDigest("native-skill", {
        family: "skill",
        createdAt: 400,
        updatedAt: 400,
        _creationTime: 4,
      }),
    ]);

    const first = await listPublicNewPluginsPageHandler(ctx, {
      createdAfter: 100,
      paginationOpts: { cursor: null, numItems: 1 },
    });
    const second = await listPublicNewPluginsPageHandler(ctx, {
      createdAfter: 100,
      paginationOpts: { cursor: first.continueCursor, numItems: 1 },
    });

    expect(first.page.map((entry) => entry.name)).toEqual(["newest-bundle"]);
    expect(first.isDone).toBe(false);
    expect(second.page.map((entry) => entry.name)).toEqual(["newer-code"]);
    expect(second.isDone).toBe(true);
  });

  it("keeps partially consumed plugin export family pages active", async () => {
    const ctx = makePluginExportCtx([
      makePluginExportDigest("newer-code", "code-plugin", 300),
      makePluginExportDigest("older-bundle-a", "bundle-plugin", 200),
      makePluginExportDigest("older-bundle-b", "bundle-plugin", 100),
    ]);

    const first = await listPluginExportPageInternalHandler(ctx, {
      startDate: 0,
      endDate: 1_000,
      numItems: 1,
    });
    const second = await listPluginExportPageInternalHandler(ctx, {
      startDate: 0,
      endDate: 1_000,
      cursor: first.nextCursor ?? undefined,
      numItems: 1,
    });
    const third = await listPluginExportPageInternalHandler(ctx, {
      startDate: 0,
      endDate: 1_000,
      cursor: second.nextCursor ?? undefined,
      numItems: 1,
    });

    expect(first.page.map((entry) => entry.name)).toEqual(["newer-code"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    expect(second.page.map((entry) => entry.name)).toEqual(["older-bundle-a"]);
    expect(second.hasMore).toBe(true);
    expect(second.nextCursor).toBeTruthy();
    expect(third.page.map((entry) => entry.name)).toEqual(["older-bundle-b"]);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();
  });

  it("exports the latest scan state and normalized current findings", async () => {
    const digest = makePluginExportDigest("demo", "code-plugin", 300);
    const releaseId = "packageReleases:demo-1";
    const ctx = makePluginValidationReportCtx([digest], {
      statesByRelease: {
        [releaseId]: [
          {
            releaseId,
            inspectorVersion: "0.3.18",
            targetOpenClawVersion: "2026.7.29-beta.1",
            completedAt: 100,
          },
          {
            releaseId,
            inspectorVersion: "0.3.19",
            targetOpenClawVersion: "2026.7.30-beta.1",
            completedAt: 200,
          },
        ],
      },
      findingsByRelease: {
        [releaseId]: [
          {
            scanSource: "nightly",
            inspectorVersion: "0.3.18",
            targetOpenClawVersion: "2026.7.29-beta.1",
            findingKind: "error",
            code: "stale-missing-api",
            message: "Old target API is unavailable",
          },
          {
            scanSource: "publish",
            findingKind: "warning",
            code: "deprecated-api",
            message: "API is deprecated",
          },
          {
            scanSource: "nightly",
            inspectorVersion: "0.3.19",
            targetOpenClawVersion: "2026.7.30-beta.1",
            findingKind: "error",
            code: "missing-api",
            message: "Required API is unavailable",
          },
        ],
      },
    });

    const result = await listPluginValidationReportPageInternalHandler(ctx, { numItems: 20 });

    expect(result).toEqual({
      items: [
        expect.objectContaining({
          package: { id: "packages:demo", name: "demo", displayName: "demo" },
          scan: expect.objectContaining({
            status: "error",
            scannedAt: 200,
            target: { channel: "beta", version: "2026.7.30-beta.1" },
            inspectorVersion: "0.3.19",
          }),
          findings: [
            { severity: "warning", code: "deprecated-api", message: "API is deprecated" },
            { severity: "error", code: "missing-api", message: "Required API is unavailable" },
          ],
        }),
      ],
      nextCursor: null,
      done: true,
    });
  });

  it("represents missing scans and preserves plugin pagination continuity", async () => {
    const ctx = makePluginValidationReportCtx(
      [
        makePluginExportDigest("newer-code", "code-plugin", 300),
        makePluginExportDigest("older-bundle", "bundle-plugin", 200),
      ],
      {
        findingsByRelease: {
          "packageReleases:newer-code-1": [
            {
              scanSource: "publish",
              findingKind: "error",
              code: "publish-error",
              message: "Publish-time validation failed",
            },
          ],
        },
      },
    );

    const first = await listPluginValidationReportPageInternalHandler(ctx, { numItems: 1 });
    const second = await listPluginValidationReportPageInternalHandler(ctx, {
      cursor: first.nextCursor ?? undefined,
      numItems: 1,
    });

    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      package: { name: "newer-code" },
      scan: { status: "error", scannedAt: null },
      findings: [{ severity: "error", code: "publish-error" }],
    });
    expect(first.done).toBe(false);
    expect(first.nextCursor).toBeTruthy();
    expect(second.items).toHaveLength(1);
    expect(second.items[0]).toMatchObject({
      package: { name: "older-bundle" },
      scan: { status: "not-scanned", scannedAt: null },
      findings: [],
    });
    expect(second.done).toBe(true);
    expect(second.nextCursor).toBeNull();
  });

  it("keeps buffered cursor items aligned across paginated public pages", async () => {
    const { ctx, paginate } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("alpha"),
            makeDigest("bravo"),
            makeDigest("charlie"),
            makeDigest("delta"),
          ],
          isDone: false,
          continueCursor: "cursor:1",
        },
        {
          page: [makeDigest("echo")],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const first = await listPublicPageHandler(ctx, {
      paginationOpts: { cursor: null, numItems: 2 },
    });
    const second = await listPublicPageHandler(ctx, {
      paginationOpts: { cursor: first.continueCursor, numItems: 2 },
    });
    const third = await listPublicPageHandler(ctx, {
      paginationOpts: { cursor: second.continueCursor, numItems: 2 },
    });

    expect(first.page.map((entry) => entry.name)).toEqual(["alpha", "bravo"]);
    expect(second.page.map((entry) => entry.name)).toEqual(["charlie", "delta"]);
    expect(third.page.map((entry) => entry.name)).toEqual(["echo"]);
    expect(paginate).toHaveBeenCalledTimes(3);
  });

  it("returns the buffered final-page tail even when the stored cursor is done", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: Array.from({ length: 26 }, (_, index) => makeDigest(`pkg-${index + 1}`)),
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const first = await listPublicPageHandler(ctx, {
      paginationOpts: { cursor: null, numItems: 25 },
    });
    const second = await listPublicPageHandler(ctx, {
      paginationOpts: { cursor: first.continueCursor, numItems: 25 },
    });

    expect(first.page).toHaveLength(25);
    expect(second.page.map((entry) => entry.name)).toEqual(["pkg-26"]);
    expect(second.isDone).toBe(true);
    expect(second.continueCursor).toBe("");
  });

  it("keeps package page cursors compact even with large summaries", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("alpha", { summary: "a".repeat(8_000) }),
            makeDigest("bravo", { summary: "b".repeat(8_000) }),
            makeDigest("charlie", { summary: "c".repeat(8_000) }),
          ],
          isDone: false,
          continueCursor: "cursor:1",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      paginationOpts: { cursor: null, numItems: 1 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["alpha"]);
    expect(result.continueCursor.length).toBeLessThan(512);
    expect(result.continueCursor).not.toContain("aaaaaaaa");
    expect(result.continueCursor).not.toContain("bravo summary");
  });

  it("includes package stats on public list items", async () => {
    const stats = { downloads: 43, installs: 3, stars: 1, versions: 2 };
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [makeDigest("stats-demo", { stats })],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect((result.page[0] as { stats?: unknown }).stats).toEqual(stats);
  });

  it("fills filtered pages without pending or suspicious packages", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("pending", { scanStatus: "pending", updatedAt: 40 }),
            makeDigest("suspicious", { scanStatus: "suspicious", updatedAt: 30 }),
            makeDigest("clean", { scanStatus: "clean", updatedAt: 20 }),
            makeDigest("not-run", { scanStatus: "not-run", updatedAt: 10 }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      sort: "updated",
      excludedScanStatuses: ["pending", "suspicious"],
      paginationOpts: { cursor: null, numItems: 2 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["clean", "not-run"]);
    expect(result.isDone).toBe(true);
  });

  it("uses current package stats when digest stats are stale", async () => {
    const currentStats = { downloads: 99, installs: 7, stars: 2, versions: 3 };
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("stats-demo", {
              stats: { downloads: 1, installs: 0, stars: 0, versions: 1 },
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
      exactPackages: [
        makePackageDoc({
          _id: "packages:stats-demo",
          name: "stats-demo",
          normalizedName: "stats-demo",
          displayName: "stats-demo",
          stats: currentStats,
        }),
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect((result.page[0] as { stats?: unknown }).stats).toEqual(currentStats);
  });

  it("uses a family-scoped downloads index for download-sorted family pages", async () => {
    const { ctx, indexFilters, indexNames, paginate } = makeDigestCtx({
      packagePages: [
        {
          page: [
            makePackageDoc({
              _id: "packages:code-plugin-a",
              name: "code-plugin-a",
              normalizedName: "code-plugin-a",
              displayName: "Code Plugin A",
              family: "code-plugin",
              stats: { downloads: 200, installs: 0, stars: 0, versions: 1 },
            }),
            makePackageDoc({
              _id: "packages:code-plugin-b",
              name: "code-plugin-b",
              normalizedName: "code-plugin-b",
              displayName: "Code Plugin B",
              family: "code-plugin",
              stats: { downloads: 100, installs: 0, stars: 0, versions: 1 },
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      family: "code-plugin",
      sort: "downloads",
      paginationOpts: { cursor: null, numItems: 1 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["code-plugin-a"]);
    expect(result.isDone).toBe(false);
    expect(result.continueCursor.startsWith("pkgpage:")).toBe(true);
    expect(indexNames).toEqual(["by_active_family_downloads"]);
    expect(indexFilters).toEqual([
      {
        indexName: "by_active_family_downloads",
        filters: [
          { field: "softDeletedAt", value: undefined },
          { field: "family", value: "code-plugin" },
        ],
      },
    ]);
    expect(paginate).toHaveBeenCalledTimes(1);
    expect(paginate).toHaveBeenCalledWith({ cursor: null, numItems: 50 });
  });

  it("uses a family-scoped installs index for install-sorted family pages", async () => {
    const { ctx, indexFilters, indexNames, paginate } = makeDigestCtx({
      packagePages: [
        {
          page: [
            makePackageDoc({
              _id: "packages:code-plugin-a",
              name: "code-plugin-a",
              normalizedName: "code-plugin-a",
              displayName: "Code Plugin A",
              family: "code-plugin",
              stats: { downloads: 100, installs: 200, stars: 0, versions: 1 },
            }),
            makePackageDoc({
              _id: "packages:code-plugin-b",
              name: "code-plugin-b",
              normalizedName: "code-plugin-b",
              displayName: "Code Plugin B",
              family: "code-plugin",
              stats: { downloads: 500, installs: 100, stars: 0, versions: 1 },
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      family: "code-plugin",
      sort: "installs",
      paginationOpts: { cursor: null, numItems: 1 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["code-plugin-a"]);
    expect(result.isDone).toBe(false);
    expect(result.continueCursor.startsWith("pkgpage:")).toBe(true);
    expect(indexNames).toEqual(["by_active_family_installs"]);
    expect(indexFilters).toEqual([
      {
        indexName: "by_active_family_installs",
        filters: [
          { field: "softDeletedAt", value: undefined },
          { field: "family", value: "code-plugin" },
        ],
      },
    ]);
    expect(paginate).toHaveBeenCalledTimes(1);
    expect(paginate).toHaveBeenCalledWith({ cursor: null, numItems: 50 });
  });

  it("uses a family-and-official installs index for official plugin pages", async () => {
    const { ctx, indexFilters, indexNames, paginate } = makeDigestCtx({
      packagePages: [
        {
          page: [
            makePackageDoc({
              _id: "packages:official-code-plugin",
              name: "official-code-plugin",
              normalizedName: "official-code-plugin",
              displayName: "Official Code Plugin",
              family: "code-plugin",
              isOfficial: true,
              channel: "official",
              stats: { downloads: 100, installs: 200, stars: 0, versions: 1 },
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPageForViewerInternalHandler(ctx, {
      family: "code-plugin",
      isOfficial: true,
      sort: "installs",
      paginationOpts: { cursor: null, numItems: 24 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["official-code-plugin"]);
    expect(result.isDone).toBe(true);
    expect(indexNames).toEqual(["by_active_family_official_installs"]);
    expect(indexFilters).toEqual([
      {
        indexName: "by_active_family_official_installs",
        filters: [
          { field: "softDeletedAt", value: undefined },
          { field: "family", value: "code-plugin" },
          { field: "isOfficial", value: true },
        ],
      },
    ]);
    expect(paginate).toHaveBeenCalledTimes(1);
    expect(paginate).toHaveBeenCalledWith({ cursor: null, numItems: 120 });
  });

  it("returns a cursor instead of paginating twice when sorted package filters skip rows", async () => {
    const firstOfficialChannel = makePackageDoc({
      _id: "packages:official-channel-1",
      name: "official-channel-1",
      normalizedName: "official-channel-1",
      displayName: "Official Channel 1",
      family: "bundle-plugin",
      channel: "official",
      stats: { downloads: 100, installs: 0, stars: 0, versions: 1 },
    });
    const community = makePackageDoc({
      _id: "packages:community",
      name: "community",
      normalizedName: "community",
      displayName: "Community",
      family: "bundle-plugin",
      channel: "community",
      stats: { downloads: 90, installs: 0, stars: 0, versions: 1 },
    });
    const secondOfficialChannel = makePackageDoc({
      _id: "packages:official-channel-2",
      name: "official-channel-2",
      normalizedName: "official-channel-2",
      displayName: "Official Channel 2",
      family: "bundle-plugin",
      channel: "official",
      stats: { downloads: 80, installs: 0, stars: 0, versions: 1 },
    });
    const { ctx, paginate } = makeDigestCtx({
      packagePages: [
        { page: [firstOfficialChannel, community], isDone: false, continueCursor: "next-page" },
        { page: [secondOfficialChannel], isDone: true, continueCursor: "" },
      ],
    });

    const first = await listPageForViewerInternalHandler(ctx, {
      family: "bundle-plugin",
      channel: "official",
      sort: "downloads",
      paginationOpts: { cursor: null, numItems: 2 },
    });

    expect(first.page.map((entry) => entry.name)).toEqual(["official-channel-1"]);
    expect(first.isDone).toBe(false);
    expect(first.continueCursor).toMatch(/^pkgpage:/);
    expect(paginate).toHaveBeenCalledTimes(1);

    const second = await listPageForViewerInternalHandler(ctx, {
      family: "bundle-plugin",
      channel: "official",
      sort: "downloads",
      paginationOpts: { cursor: first.continueCursor, numItems: 2 },
    });

    expect(second.page.map((entry) => entry.name)).toEqual(["official-channel-2"]);
    expect(second.isDone).toBe(true);
    expect(paginate).toHaveBeenCalledTimes(2);
  });

  it("returns a cursor instead of paginating twice when digest scan filters skip rows", async () => {
    const firstClean = makeDigest("clean-1", {
      scanStatus: "clean",
      updatedAt: 100,
    });
    const suspicious = makeDigest("suspicious", {
      scanStatus: "suspicious",
      updatedAt: 90,
    });
    const secondClean = makeDigest("clean-2", {
      scanStatus: "clean",
      updatedAt: 80,
    });
    const thirdClean = makeDigest("clean-3", {
      scanStatus: "clean",
      updatedAt: 70,
    });
    const { ctx, paginate } = makeDigestCtx({
      pages: [
        { page: [firstClean, suspicious, secondClean], isDone: false, continueCursor: "next-page" },
        { page: [thirdClean], isDone: true, continueCursor: "" },
      ],
    });

    const first = await listPageForViewerInternalHandler(ctx, {
      family: "code-plugin",
      sort: "updated",
      excludedScanStatuses: ["suspicious"],
      paginationOpts: { cursor: null, numItems: 3 },
    });

    expect(first.page.map((entry) => entry.name)).toEqual(["clean-1", "clean-2"]);
    expect(first.isDone).toBe(false);
    expect(first.continueCursor).toMatch(/^pkgpage:/);
    expect(paginate).toHaveBeenCalledTimes(1);

    const second = await listPageForViewerInternalHandler(ctx, {
      family: "code-plugin",
      sort: "updated",
      excludedScanStatuses: ["suspicious"],
      paginationOpts: { cursor: first.continueCursor, numItems: 3 },
    });

    expect(second.page.map((entry) => entry.name)).toEqual(["clean-3"]);
    expect(second.isDone).toBe(true);
    expect(paginate).toHaveBeenCalledTimes(2);
  });

  it("uses a family-and-official downloads index for official plugin pages", async () => {
    const { ctx, indexFilters, indexNames, paginate } = makeDigestCtx({
      packagePages: [
        {
          page: [
            makePackageDoc({
              _id: "packages:official-code-plugin",
              name: "official-code-plugin",
              normalizedName: "official-code-plugin",
              displayName: "Official Code Plugin",
              family: "code-plugin",
              isOfficial: true,
              channel: "official",
              stats: { downloads: 200, installs: 100, stars: 0, versions: 1 },
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPageForViewerInternalHandler(ctx, {
      family: "code-plugin",
      isOfficial: true,
      sort: "downloads",
      paginationOpts: { cursor: null, numItems: 24 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["official-code-plugin"]);
    expect(result.isDone).toBe(true);
    expect(indexNames).toEqual(["by_active_family_official_downloads"]);
    expect(indexFilters).toEqual([
      {
        indexName: "by_active_family_official_downloads",
        filters: [
          { field: "softDeletedAt", value: undefined },
          { field: "family", value: "code-plugin" },
          { field: "isOfficial", value: true },
        ],
      },
    ]);
    expect(paginate).toHaveBeenCalledTimes(1);
    expect(paginate).toHaveBeenCalledWith({ cursor: null, numItems: 120 });
  });

  it("keeps new official downloads cursors on the family-and-official index", async () => {
    const { ctx, indexNames } = makeDigestCtx({
      packagePages: [
        {
          page: [
            makePackageDoc({
              _id: "packages:official-code-plugin-1",
              name: "official-code-plugin-1",
              normalizedName: "official-code-plugin-1",
              displayName: "Official Code Plugin 1",
              family: "code-plugin",
              isOfficial: true,
              channel: "official",
            }),
          ],
          isDone: false,
          continueCursor: "official-downloads-next",
        },
        {
          page: [
            makePackageDoc({
              _id: "packages:official-code-plugin-2",
              name: "official-code-plugin-2",
              normalizedName: "official-code-plugin-2",
              displayName: "Official Code Plugin 2",
              family: "code-plugin",
              isOfficial: true,
              channel: "official",
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const first = await listPageForViewerInternalHandler(ctx, {
      family: "code-plugin",
      isOfficial: true,
      sort: "downloads",
      paginationOpts: { cursor: null, numItems: 1 },
    });
    const second = await listPageForViewerInternalHandler(ctx, {
      family: "code-plugin",
      isOfficial: true,
      sort: "downloads",
      paginationOpts: { cursor: first.continueCursor, numItems: 1 },
    });

    expect(first.page.map((entry) => entry.name)).toEqual(["official-code-plugin-1"]);
    expect(second.page.map((entry) => entry.name)).toEqual(["official-code-plugin-2"]);
    expect(indexNames).toEqual([
      "by_active_family_official_downloads",
      "by_active_family_official_downloads",
    ]);
  });

  it("keeps legacy official downloads cursors on the family downloads index", async () => {
    const legacyCursor = `pkgpage:${JSON.stringify({
      cursor: "legacy-official-downloads-next",
      offset: 0,
      pageSize: 50,
      done: false,
      mode: "packages",
    })}`;
    const { ctx, indexNames } = makeDigestCtx({
      packagePages: [
        {
          page: [],
          isDone: false,
          continueCursor: "legacy-official-downloads-next",
        },
        {
          page: [
            makePackageDoc({
              _id: "packages:official-code-plugin",
              name: "official-code-plugin",
              normalizedName: "official-code-plugin",
              displayName: "Official Code Plugin",
              family: "code-plugin",
              isOfficial: true,
              channel: "official",
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPageForViewerInternalHandler(ctx, {
      family: "code-plugin",
      isOfficial: true,
      sort: "downloads",
      paginationOpts: { cursor: legacyCursor, numItems: 1 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["official-code-plugin"]);
    expect(indexNames).toEqual(["by_active_family_downloads"]);
  });

  it("normalizes public plugins from official publishers for official browse", async () => {
    const officialPublisher = {
      _id: "publishers:openclaw",
      handle: "openclaw",
      kind: "org",
      deletedAt: undefined,
      deactivatedAt: undefined,
    };
    const staleOfficialPlugin = makePackageDoc({
      _id: "packages:memory",
      name: "@openclaw/memory-lancedb",
      normalizedName: "@openclaw/memory-lancedb",
      displayName: "Memory LanceDB",
      ownerPublisherId: officialPublisher._id,
      channel: "community",
      isOfficial: false,
      capabilityTags: ["memory"],
    });
    const privateOfficialPlugin = makePackageDoc({
      _id: "packages:private",
      name: "@openclaw/private-plugin",
      normalizedName: "@openclaw/private-plugin",
      displayName: "Private Plugin",
      ownerPublisherId: officialPublisher._id,
      channel: "private",
      isOfficial: false,
    });
    const communityPlugin = makePackageDoc({
      _id: "packages:community",
      name: "community-plugin",
      normalizedName: "community-plugin",
      displayName: "Community Plugin",
      ownerPublisherId: "publishers:community",
      channel: "community",
      isOfficial: false,
    });
    const patch = vi.fn();
    const insert = vi.fn();
    const packageIndex = vi.fn();
    const paginatePackages = vi.fn().mockResolvedValue({
      page: [staleOfficialPlugin, privateOfficialPlugin, communityPlugin],
      continueCursor: "",
      isDone: true,
    });
    const ctx = {
      db: {
        get: vi.fn(async (id: string) => {
          if (id === officialPublisher._id) return officialPublisher;
          if (id === "publishers:community") {
            return {
              _id: id,
              handle: "community",
              kind: "org",
              deletedAt: undefined,
              deactivatedAt: undefined,
            };
          }
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table === "packages") {
            return {
              withIndex: packageIndex.mockImplementation((_indexName, builder) => {
                builder?.({
                  eq: (_field: string, _value: string) => ({}),
                });
                return { paginate: paginatePackages };
              }),
            };
          }
          if (table === "officialPublishers") {
            return {
              withIndex: vi.fn((_indexName, builder) => {
                let publisherId: string | undefined;
                builder?.({
                  eq: (_field: string, value: string) => {
                    publisherId = value;
                    return {};
                  },
                });
                return {
                  unique: vi
                    .fn()
                    .mockResolvedValue(
                      publisherId === officialPublisher._id
                        ? { _id: "officialPublishers:openclaw", publisherId }
                        : null,
                    ),
                };
              }),
            };
          }
          if (table === "packageSearchDigest") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue({
                  _id: "packageSearchDigest:memory",
                  packageId: staleOfficialPlugin._id,
                  channel: "community",
                  isOfficial: false,
                }),
              })),
            };
          }
          if (
            table === "packageCapabilitySearchDigest" ||
            table === "packagePluginCategorySearchDigest" ||
            table === "packageTopicSearchDigest"
          ) {
            return {
              withIndex: vi.fn(() => ({
                collect: vi.fn().mockResolvedValue([]),
              })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
        patch,
        insert,
        delete: vi.fn(),
        normalizeId: vi.fn(),
      },
    };

    const result = await normalizeOfficialPublisherPackagesInternalHandler(ctx as never, {
      family: "code-plugin",
      dryRun: false,
      batchSize: 10,
    });

    expect(result).toMatchObject({
      family: "code-plugin",
      scanned: 3,
      matched: 1,
      patched: 1,
      skippedPrivate: 1,
      dryRun: false,
    });
    expect(packageIndex).toHaveBeenCalledWith("by_family_updated", expect.any(Function));
    expect(paginatePackages).toHaveBeenCalledWith({ cursor: null, numItems: 10 });
    expect(patch).toHaveBeenCalledWith("packages:memory", {
      channel: "official",
      isOfficial: true,
    });
    expect(patch).not.toHaveBeenCalledWith(
      "packages:private",
      expect.objectContaining({ channel: "official" }),
    );
    expect(patch).toHaveBeenCalledWith(
      "packageSearchDigest:memory",
      expect.objectContaining({
        channel: "official",
        isOfficial: true,
        ownerHandle: "openclaw",
        ownerKind: "org",
      }),
    );
  });

  it("includes current inferred taxonomy on install-sorted package pages", async () => {
    const { ctx } = makeDigestCtx({
      packagePages: [
        {
          page: [
            makePackageDoc({
              categories: undefined,
              topics: undefined,
              inferredCategories: ["memory", "tools"],
              inferredTopics: ["Agent Memory", "Retrieval"],
              inferredFromReleaseId: "packageReleases:demo-1",
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      family: "code-plugin",
      sort: "installs",
      paginationOpts: { cursor: null, numItems: 1 },
    });

    expect(result.page[0]).toMatchObject({
      categories: ["memory", "tools"],
      topics: ["Agent Memory", "Retrieval"],
    });
  });

  it("preserves stored skill taxonomy on install-sorted package pages", async () => {
    const { ctx } = makeDigestCtx({
      packagePages: [
        {
          page: [
            makePackageDoc({
              family: "skill",
              categories: ["developer-tools"],
              topics: ["Automation"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      family: "skill",
      sort: "installs",
      paginationOpts: { cursor: null, numItems: 1 },
    });

    expect(result.page[0]).toMatchObject({
      categories: ["developer-tools"],
      topics: ["Automation"],
    });
  });

  it("uses a family-scoped weighted recommended score index after backfill", async () => {
    const { ctx, indexFilters, indexNames, paginate } = makeDigestCtx({
      packagePages: [
        {
          page: [
            makePackageDoc({
              _id: "packages:code-plugin-downloaded",
              name: "code-plugin-downloaded",
              normalizedName: "code-plugin-downloaded",
              displayName: "Code Plugin Downloaded",
              family: "code-plugin",
              stats: { downloads: 43_080, installs: 2, stars: 0, versions: 1 },
              recommendedScore: computeRecommendationScore({
                downloads: 43_080,
                installs: 2,
                stars: 0,
              }),
              recommendedScoreVersion: RECOMMENDATION_SCORE_VERSION,
            }),
            makePackageDoc({
              _id: "packages:code-plugin-installed",
              name: "code-plugin-installed",
              normalizedName: "code-plugin-installed",
              displayName: "Code Plugin Installed",
              family: "code-plugin",
              stats: { downloads: 393, installs: 74, stars: 0, versions: 1 },
              recommendedScore: computeRecommendationScore({
                downloads: 393,
                installs: 74,
                stars: 0,
              }),
              recommendedScoreVersion: RECOMMENDATION_SCORE_VERSION,
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      family: "code-plugin",
      sort: "recommended",
      paginationOpts: { cursor: null, numItems: 1 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["code-plugin-downloaded"]);
    expect(result.isDone).toBe(false);
    expect(result.continueCursor.startsWith("pkgpage:")).toBe(true);
    expect(indexNames).toEqual([
      "by_active_family_recommended_score",
      "by_active_family_recommended_score_version",
      "by_active_family_recommended_score_version",
      "by_active_family_recommended_score",
    ]);
    expect(indexFilters).toEqual([
      {
        indexName: "by_active_family_recommended_score",
        filters: [
          { field: "softDeletedAt", value: undefined },
          { field: "family", value: "code-plugin" },
          { field: "recommendedScore", value: undefined },
        ],
      },
      {
        indexName: "by_active_family_recommended_score_version",
        filters: [
          { field: "softDeletedAt", value: undefined },
          { field: "family", value: "code-plugin" },
          { field: "recommendedScoreVersion", value: undefined },
        ],
      },
      {
        indexName: "by_active_family_recommended_score_version",
        filters: [
          { field: "softDeletedAt", value: undefined },
          { field: "family", value: "code-plugin" },
        ],
      },
      {
        indexName: "by_active_family_recommended_score",
        filters: [
          { field: "softDeletedAt", value: undefined },
          { field: "family", value: "code-plugin" },
        ],
      },
    ]);
    expect(paginate).toHaveBeenCalledTimes(1);
    expect(paginate).toHaveBeenCalledWith({ cursor: null, numItems: 50 });
  });

  it("falls back to updated family digests while recommendation scores are missing", async () => {
    const { ctx, indexFilters, indexNames } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("code-plugin-downloaded", {
              packageId: "packages:code-plugin-downloaded",
              displayName: "Code Plugin Downloaded",
              family: "code-plugin",
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
      packagePages: [
        {
          page: [
            makePackageDoc({
              _id: "packages:code-plugin-downloaded",
              name: "code-plugin-downloaded",
              normalizedName: "code-plugin-downloaded",
              displayName: "Code Plugin Downloaded",
              family: "code-plugin",
              stats: { downloads: 43_080, installs: 2, stars: 0, versions: 1 },
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    await listPublicPageHandler(ctx, {
      family: "code-plugin",
      sort: "recommended",
      paginationOpts: { cursor: null, numItems: 1 },
    });

    expect(indexNames).toEqual(["by_active_family_recommended_score", "by_active_family_updated"]);
    expect(indexFilters).toEqual([
      {
        indexName: "by_active_family_recommended_score",
        filters: [
          { field: "softDeletedAt", value: undefined },
          { field: "family", value: "code-plugin" },
          { field: "recommendedScore", value: undefined },
        ],
      },
    ]);
  });

  it("falls back to updated family digests while recommendation score versions are missing", async () => {
    const { ctx, indexFilters, indexNames } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("code-plugin-updated", {
              packageId: "packages:code-plugin-updated",
              displayName: "Code Plugin Updated",
              family: "code-plugin",
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
      packagePages: [
        {
          page: [
            makePackageDoc({
              _id: "packages:code-plugin-stale-score",
              name: "code-plugin-stale-score",
              normalizedName: "code-plugin-stale-score",
              displayName: "Code Plugin Stale Score",
              family: "code-plugin",
              stats: { downloads: 43_080, installs: 2, stars: 0, versions: 1 },
              recommendedScore: computeRecommendationScore({
                downloads: 43_080,
                installs: 2,
                stars: 0,
              }),
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    await listPublicPageHandler(ctx, {
      family: "code-plugin",
      sort: "recommended",
      paginationOpts: { cursor: null, numItems: 1 },
    });

    expect(indexNames).toEqual([
      "by_active_family_recommended_score",
      "by_active_family_recommended_score_version",
      "by_active_family_updated",
    ]);
    expect(indexFilters).toEqual([
      {
        indexName: "by_active_family_recommended_score",
        filters: [
          { field: "softDeletedAt", value: undefined },
          { field: "family", value: "code-plugin" },
          { field: "recommendedScore", value: undefined },
        ],
      },
      {
        indexName: "by_active_family_recommended_score_version",
        filters: [
          { field: "softDeletedAt", value: undefined },
          { field: "family", value: "code-plugin" },
          { field: "recommendedScoreVersion", value: undefined },
        ],
      },
    ]);
  });

  it("keeps legacy recommended package cursors on the recommended score index", async () => {
    const legacyCursor = `pkgpage:${JSON.stringify({
      cursor: "legacy-recommended-next",
      offset: 0,
      pageSize: 50,
      done: false,
    })}`;
    const { ctx, indexFilters, indexNames } = makeDigestCtx({
      packagePages: [
        {
          page: [],
          isDone: false,
          continueCursor: "legacy-recommended-next",
        },
        {
          page: [
            makePackageDoc({
              _id: "packages:code-plugin-next",
              name: "code-plugin-next",
              normalizedName: "code-plugin-next",
              displayName: "Code Plugin Next",
              family: "code-plugin",
              stats: { downloads: 10, installs: 1, stars: 0, versions: 1 },
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      family: "code-plugin",
      sort: "recommended",
      paginationOpts: { cursor: legacyCursor, numItems: 1 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["code-plugin-next"]);
    expect(indexNames).toEqual(["by_active_family_recommended_score"]);
    expect(indexFilters).toEqual([
      {
        indexName: "by_active_family_recommended_score",
        filters: [
          { field: "softDeletedAt", value: undefined },
          { field: "family", value: "code-plugin" },
        ],
      },
    ]);
  });

  it("keeps recommended digest fallback cursors on the digest path after backfill", async () => {
    const fallbackCursor = `pkgpage:${JSON.stringify({
      cursor: "digest-next",
      offset: 0,
      pageSize: 50,
      done: false,
      mode: "digest",
    })}`;
    const { ctx, indexFilters, indexNames } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("code-plugin-first", {
              packageId: "packages:code-plugin-first",
              displayName: "Code Plugin First",
              family: "code-plugin",
            }),
          ],
          isDone: false,
          continueCursor: "digest-next",
        },
        {
          page: [
            makeDigest("code-plugin-second", {
              packageId: "packages:code-plugin-second",
              displayName: "Code Plugin Second",
              family: "code-plugin",
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
      packagePages: [
        {
          page: [
            makePackageDoc({
              _id: "packages:code-plugin-second",
              name: "code-plugin-second",
              normalizedName: "code-plugin-second",
              displayName: "Code Plugin Second",
              family: "code-plugin",
              stats: { downloads: 1, installs: 1, stars: 0, versions: 1 },
              recommendedScore: computeRecommendationScore({
                downloads: 1,
                installs: 1,
                stars: 0,
              }),
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      family: "code-plugin",
      sort: "recommended",
      paginationOpts: { cursor: fallbackCursor, numItems: 1 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["code-plugin-second"]);
    expect(indexNames).toEqual(["by_active_family_updated"]);
    expect(indexFilters).toEqual([]);
  });

  it("uses global download-sorted pages without retired capability filters", async () => {
    const { ctx, indexNames, paginate } = makeDigestCtx({
      packagePages: [
        {
          page: [
            makePackageDoc({
              _id: "packages:bundle-plugin",
              name: "bundle-plugin",
              normalizedName: "bundle-plugin",
              displayName: "Bundle Plugin",
              family: "bundle-plugin",
              stats: { downloads: 500, installs: 0, stars: 0, versions: 1 },
            }),
          ],
          isDone: false,
          continueCursor: "cursor:next",
        },
        {
          page: [
            makePackageDoc({
              _id: "packages:code-plugin",
              name: "code-plugin",
              normalizedName: "code-plugin",
              displayName: "Code Plugin",
              family: "code-plugin",
              stats: { downloads: 200, installs: 0, stars: 0, versions: 1 },
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      sort: "downloads",
      paginationOpts: { cursor: null, numItems: 1 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["bundle-plugin"]);
    expect(result.isDone).toBe(false);
    expect(indexNames).toEqual(["by_active_downloads"]);
    expect(paginate).toHaveBeenCalledTimes(1);
  });

  it("excludes private packages from public list pages", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [makeDigest("secret-plugin", { channel: "private" }), makeDigest("public-plugin")],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["public-plugin"]);
  });

  it("allows owners to list their private packages", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("secret-plugin", {
              channel: "private",
              ownerUserId: "users:owner",
            }),
            makeDigest("public-plugin"),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPageForViewerInternalHandler(ctx, {
      paginationOpts: { cursor: null, numItems: 10 },
      viewerUserId: "users:owner",
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["secret-plugin", "public-plugin"]);
  });

  it("keeps highlighted package pages in newest-featured order", async () => {
    const newestFeatured = makeDigest("newest-featured", {
      updatedAt: 20,
      stats: { downloads: 100, installs: 5, stars: 0, versions: 1 },
    });
    const olderFeatured = makeDigest("older-featured", {
      updatedAt: 10,
      stats: { downloads: 1, installs: 50, stars: 0, versions: 1 },
    });
    const newerSkill = makeDigest("newer-skill", {
      family: "skill",
      updatedAt: 30,
    });
    const { ctx } = makeDigestCtx({
      highlightedBadges: [
        { packageId: newerSkill.packageId, at: 300 },
        { packageId: newestFeatured.packageId, at: 200 },
        { packageId: olderFeatured.packageId, at: 100 },
      ],
      exactDigests: [newerSkill, newestFeatured, olderFeatured],
    });

    const result = await listPageForViewerInternalHandler(ctx, {
      families: ["code-plugin", "bundle-plugin"],
      highlightedOnly: true,
      sort: "installs",
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["newest-featured", "older-featured"]);
    expect(result.page.map((entry) => entry.featuredAt)).toEqual([200, 100]);
  });

  it("keeps official packages first without re-ranking featured recency within each group", async () => {
    const newestCommunity = makeDigest("newest-community", {
      isOfficial: false,
      updatedAt: 30,
    });
    const newestOfficial = makeDigest("newest-official", {
      isOfficial: true,
      updatedAt: 20,
    });
    const olderOfficial = makeDigest("older-official", {
      isOfficial: true,
      updatedAt: 10,
    });
    const { ctx } = makeDigestCtx({
      highlightedBadges: [
        { packageId: newestCommunity.packageId, at: 300 },
        { packageId: newestOfficial.packageId, at: 200 },
        { packageId: olderOfficial.packageId, at: 100 },
      ],
      exactDigests: [newestCommunity, newestOfficial, olderOfficial],
    });

    const result = await listPageForViewerInternalHandler(ctx, {
      highlightedOnly: true,
      officialFirst: true,
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual([
      "newest-official",
      "older-official",
      "newest-community",
    ]);
  });

  it("does not let stale personal ownerUserId expose private package digests", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("stale-personal-secret", {
              channel: "private",
              ownerKind: "user",
              ownerUserId: "users:viewer",
              ownerPublisherId: "publishers:other-personal",
            }),
            makeDigest("public-plugin"),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPageForViewerInternalHandler(ctx, {
      paginationOpts: { cursor: null, numItems: 10 },
      viewerUserId: "users:viewer",
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["public-plugin"]);
  });

  it("lets legacy no-link personal package owners list private package digests", async () => {
    const { ctx } = makeDigestCtx({
      publisherDocs: {
        "publishers:legacy-personal": {
          _id: "publishers:legacy-personal",
          kind: "user",
          handle: "viewer",
          linkedUserId: undefined,
        },
      },
      pages: [
        {
          page: [
            makeDigest("legacy-personal-secret", {
              channel: "private",
              ownerKind: "user",
              ownerUserId: "users:viewer",
              ownerPublisherId: "publishers:legacy-personal",
            }),
            makeDigest("public-plugin"),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPageForViewerInternalHandler(ctx, {
      paginationOpts: { cursor: null, numItems: 10 },
      viewerUserId: "users:viewer",
    });

    expect(result.page.map((entry) => entry.name)).toEqual([
      "legacy-personal-secret",
      "public-plugin",
    ]);
  });

  it("does not let inactive no-link personal publishers expose private package digests", async () => {
    const { ctx } = makeDigestCtx({
      publisherDocs: {
        "publishers:legacy-personal": {
          _id: "publishers:legacy-personal",
          kind: "user",
          handle: "viewer",
          linkedUserId: undefined,
          deactivatedAt: 123,
        },
      },
      pages: [
        {
          page: [
            makeDigest("legacy-personal-secret", {
              channel: "private",
              ownerKind: "user",
              ownerUserId: "users:viewer",
              ownerPublisherId: "publishers:legacy-personal",
            }),
            makeDigest("public-plugin"),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPageForViewerInternalHandler(ctx, {
      paginationOpts: { cursor: null, numItems: 10 },
      viewerUserId: "users:viewer",
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["public-plugin"]);
  });

  it("does not reuse legacy no-link personal access across package owners", async () => {
    const { ctx } = makeDigestCtx({
      publisherDocs: {
        "publishers:legacy-personal": {
          _id: "publishers:legacy-personal",
          kind: "user",
          handle: "viewer",
          linkedUserId: undefined,
        },
      },
      pages: [
        {
          page: [
            makeDigest("own-legacy-secret", {
              channel: "private",
              ownerKind: "user",
              ownerUserId: "users:viewer",
              ownerPublisherId: "publishers:legacy-personal",
            }),
            makeDigest("stale-legacy-secret", {
              channel: "private",
              ownerKind: "user",
              ownerUserId: "users:other",
              ownerPublisherId: "publishers:legacy-personal",
            }),
            makeDigest("public-plugin"),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPageForViewerInternalHandler(ctx, {
      paginationOpts: { cursor: null, numItems: 10 },
      viewerUserId: "users:viewer",
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["own-legacy-secret", "public-plugin"]);
  });

  it("allows owners to filter to only their private packages", async () => {
    const { ctx, indexNames } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("secret-plugin", {
              channel: "private",
              ownerUserId: "users:owner",
            }),
            makeDigest("other-secret", {
              channel: "private",
              ownerUserId: "users:other",
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPageForViewerInternalHandler(ctx, {
      channel: "private",
      paginationOpts: { cursor: null, numItems: 10 },
      viewerUserId: "users:owner",
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["secret-plugin"]);
    expect(indexNames).toEqual(["by_active_channel_updated"]);
  });

  it("allows org collaborators to list their private packages", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("secret-plugin", {
              channel: "private",
              ownerUserId: "users:owner",
              ownerPublisherId: "publishers:org",
            }),
            makeDigest("public-plugin"),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
      publisherMemberships: {
        "publishers:org": "publisher",
      },
    });

    const result = await listPageForViewerInternalHandler(ctx, {
      paginationOpts: { cursor: null, numItems: 10 },
      viewerUserId: "users:member",
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["secret-plugin", "public-plugin"]);
  });

  it("applies isOfficial filtering even with family and channel set", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("official-demo", {
              family: "code-plugin",
              channel: "community",
              isOfficial: true,
            }),
            makeDigest("community-demo", {
              family: "code-plugin",
              channel: "community",
              isOfficial: false,
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      family: "code-plugin",
      channel: "community",
      isOfficial: true,
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["official-demo"]);
  });

  it("uses the official index for official-only listings without a family filter", async () => {
    const { ctx, indexNames, paginate } = makeDigestCtx({
      pages: [
        {
          page: [makeDigest("official-late", { isOfficial: true })],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      isOfficial: true,
      paginationOpts: { cursor: null, numItems: 1 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["official-late"]);
    expect(indexNames).toEqual(["by_active_official_updated"]);
    expect(paginate).toHaveBeenCalledTimes(1);
  });

  it("filters private packages in public search", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("secret-tools", {
              channel: "private",
            }),
            makeDigest("tools-demo"),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "demo",
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["tools-demo"]);
  });

  it("excludes selected scan statuses from package search", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("pending-demo", { scanStatus: "pending" }),
            makeDigest("suspicious-demo", { scanStatus: "suspicious" }),
            makeDigest("clean-demo", { scanStatus: "clean" }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "demo",
      limit: 10,
      excludedScanStatuses: ["pending", "suspicious"],
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["clean-demo"]);
  });

  it("does not let a fresh exact-name package headline over adopted matches at limit 1", async () => {
    // Regression for #3054: the untrusted exact hit fills the direct-match
    // slot, but it must not satisfy the collection quota, or the fallback
    // scan never gathers the adopted alternative it is ranked against.
    const { ctx } = makeDigestCtx({
      exactDigests: [makeDigest("youtube")],
      pages: [
        {
          page: [
            makeDigest("youtube-transcript", {
              stats: { downloads: 4200, installs: 800, stars: 12, versions: 3 },
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, { query: "youtube", limit: 1 });

    expect(result.map((entry) => entry.package.name)).toEqual(["youtube-transcript"]);
  });

  it("keeps trusted exact-name matches on top at limit 1", async () => {
    const { ctx } = makeDigestCtx({
      exactDigests: [makeDigest("youtube", { isOfficial: true })],
      pages: [
        {
          page: [
            makeDigest("youtube-transcript", {
              stats: { downloads: 4200, installs: 800, stars: 12, versions: 3 },
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, { query: "youtube", limit: 1 });

    expect(result.map((entry) => entry.package.name)).toEqual(["youtube"]);
  });

  it("allows owners to search their private packages", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("secret-tools", {
              channel: "private",
              ownerUserId: "users:owner",
            }),
            makeDigest("other-secret-tools", {
              channel: "private",
              ownerUserId: "users:other",
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchForViewerInternalHandler(ctx, {
      query: "secret",
      channel: "private",
      limit: 10,
      viewerUserId: "users:owner",
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["secret-tools"]);
  });

  it("uses bounded topic and fallback digest takes for search", async () => {
    const { ctx, paginate, take } = makeDigestCtx({
      pages: [
        {
          page: [makeDigest("first-page-miss")],
          isDone: false,
          continueCursor: "next",
        },
        {
          page: [makeDigest("needle-plugin")],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchForViewerInternalHandler(ctx, {
      query: "needle",
      family: "code-plugin",
      limit: 2,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["needle-plugin"]);
    expect(paginate).not.toHaveBeenCalled();
    expect(take.mock.calls.length).toBeLessThanOrEqual(8);
    expect(take).toHaveBeenCalledWith(20);
    expect(take).toHaveBeenCalledWith(50);
  });

  it("recalls plugins whose category matches the query", async () => {
    const { ctx, tableNames } = makeDigestCtx({
      categoryPages: [
        {
          page: [
            makeDigest("focused-helper", {
              displayName: "Focused Helper",
              summary: "Keeps projects tidy.",
              pluginCategory: "runtime",
              pluginCategoryTags: ["runtime"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "runtime",
      family: "code-plugin",
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["focused-helper"]);
    expect(tableNames).toContain("packagePluginCategorySearchDigest");
  });

  it("does not use the fallback other category as search evidence", async () => {
    const { ctx, tableNames } = makeDigestCtx({
      categoryPages: [
        {
          page: [
            makeDigest("focused-helper", {
              displayName: "Focused Helper",
              summary: "Keeps projects tidy.",
              pluginCategory: "other",
              pluginCategoryTags: ["other"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "other",
      family: "code-plugin",
      limit: 10,
    });

    expect(result).toEqual([]);
    expect(tableNames).not.toContain("packagePluginCategorySearchDigest");
  });

  it("uses partial author topics as plugin search evidence", async () => {
    const { ctx } = makeDigestCtx({
      topicPages: [
        {
          page: [
            makeDigest("focused-helper", {
              displayName: "Focused Helper",
              summary: "Keeps projects tidy.",
              topic: "gpu-development",
              topics: ["GPU development"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "gpu",
      family: "code-plugin",
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["focused-helper"]);
  });

  it("prioritizes exact plugin topics ahead of bounded prefix recall", async () => {
    const prefixTopics = Array.from({ length: 100 }, (_, index) =>
      makeDigest(`react-prefix-${index}`, {
        topic: `react-${index}`,
        topics: [`React ${index}`],
      }),
    );
    const exactTopic = makeDigest("react-exact", {
      topic: "react",
      topics: ["React"],
    });
    const { ctx } = makeDigestCtx({
      topicPages: [
        {
          page: [...prefixTopics, exactTopic],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "react",
      family: "code-plugin",
      limit: 1,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["react-exact"]);
  });

  it("does not let official or featured status make unrelated packages eligible for search", async () => {
    const featured = makeDigest("featured-nostr", {
      displayName: "Featured Nostr",
      summary: "Protocol integration.",
    });
    const { ctx } = makeDigestCtx({
      highlightedBadges: [{ packageId: featured.packageId, at: 100 }],
      exactDigests: [featured],
      pages: [
        {
          page: [
            makeDigest("openclaw-nostr", {
              displayName: "OpenClaw Nostr",
              isOfficial: true,
              summary: "Protocol integration.",
            }),
            featured,
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "zzzznonexistentquery123",
      limit: 10,
    });

    expect(result).toEqual([]);
  });

  it("does not treat punctuation-only queries as package matches", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("openclaw-nostr", {
              isOfficial: true,
              runtimeId: "openclaw.nostr",
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: ".",
      limit: 10,
    });

    expect(result).toEqual([]);
  });

  it("does not match short queries through arbitrary summary substrings", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("local-tools", {
              summary: "Available helper tools.",
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "ai",
      limit: 10,
    });

    expect(result).toEqual([]);
  });

  it("does not drop short tokens from exploratory package matches", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("database-tools", {
              summary: "Postgres database helper.",
              capabilityTags: ["postgres"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "ai postgres",
      limit: 10,
    });

    expect(result).toEqual([]);
  });

  it("orders matching official packages before stronger community matches", async () => {
    const community = makeDigest("email", {
      displayName: "Email",
      summary: "Mailbox tools.",
    });
    const agentMail = makeDigest("agentmail", {
      displayName: "AgentMail",
      isOfficial: true,
      summary: "Official email plugin and email channel for OpenClaw.",
      topics: ["email", "inbox"],
    });
    const { ctx } = makeDigestCtx({
      officialDigests: [agentMail],
      pages: [
        {
          page: [community],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "email",
      limit: 2,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["agentmail", "email"]);
    expect(result[0]).not.toHaveProperty("rankTier");
    expect(result[0]).not.toHaveProperty("matchReason");
  });

  it("orders matching featured packages before stronger community matches", async () => {
    const community = makeDigest("email", {
      displayName: "Email",
      summary: "Mailbox tools.",
    });
    const featured = makeDigest("agentmail", {
      displayName: "AgentMail",
      summary: "Email inboxes for agents.",
    });
    const { ctx } = makeDigestCtx({
      highlightedBadges: [{ packageId: featured.packageId, at: 100 }],
      exactDigests: [community, featured],
      pages: [
        {
          page: [community, featured],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "email",
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["agentmail", "email"]);
  });

  it("allows org collaborators to search their private packages", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("secret-tools", {
              channel: "private",
              ownerUserId: "users:owner",
              ownerPublisherId: "publishers:org",
            }),
            makeDigest("other-secret-tools", {
              channel: "private",
              ownerUserId: "users:other",
              ownerPublisherId: "publishers:other",
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
      publisherMemberships: {
        "publishers:org": "publisher",
      },
    });

    const result = await searchForViewerInternalHandler(ctx, {
      query: "secret",
      channel: "private",
      limit: 10,
      viewerUserId: "users:member",
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["secret-tools"]);
  });

  it("uses the active updated index for public listings", async () => {
    const { ctx, indexNames, tableNames } = makeDigestCtx({
      pages: [
        {
          page: [makeDigest("demo")],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["demo"]);
    expect(tableNames).toEqual(["packageSearchDigest"]);
    expect(indexNames).toEqual(["by_active_updated"]);
  });

  it("ignores retired capability filters for package search", async () => {
    const { ctx, indexNames, tableNames } = makeDigestCtx({
      pages: [
        {
          page: [makeDigest("tools-demo")],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "tools",
      capabilityTag: "tools",
      executesCode: true,
      limit: 10,
    } as Parameters<typeof searchPublicHandler>[1] & {
      capabilityTag?: string;
      executesCode?: boolean;
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["tools-demo"]);
    expect(new Set(tableNames)).toEqual(
      new Set([
        "packageSearchDigest",
        "packageTopicSearchDigest",
        "packagePluginCategorySearchDigest",
      ]),
    );
    expect(new Set(indexNames)).toEqual(
      new Set([
        "by_active_topic_updated",
        "by_active_category_updated",
        "by_active_official_updated",
        "by_active_updated",
      ]),
    );
  });

  it("uses plugin category digests for category-filtered listings", async () => {
    const { ctx, indexNames, tableNames } = makeDigestCtx({
      categoryPages: [
        {
          page: [
            makeDigest("api-demo", {
              pluginCategory: "tools",
              pluginCategoryTags: ["tools"],
              executesCode: true,
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      category: "tools",
      sort: "recommended",
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["api-demo"]);
    expect(tableNames).toEqual(["packagePluginCategorySearchDigest"]);
    expect(indexNames).toEqual([
      "by_active_recommended_score",
      "by_active_recommended_score_version",
      "by_active_recommended_score_version",
      "by_active_category_recommended_score",
    ]);
  });

  it("uses plugin category digest sort indexes for filtered listings", async () => {
    const { ctx, indexNames } = makeDigestCtx({
      categoryPages: [
        {
          page: [
            makeDigest("api-demo", {
              pluginCategory: "tools",
              pluginCategoryTags: ["tools"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    await listPublicPageHandler(ctx, {
      category: "tools",
      sort: "installs",
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(indexNames).toEqual(["by_active_category_installs"]);
  });

  it("uses family-aware plugin category sort indexes for plugin browse sources", async () => {
    const { ctx, indexNames } = makeDigestCtx({
      categoryPages: [
        {
          page: [
            makeDigest("api-demo", {
              family: "code-plugin",
              pluginCategory: "tools",
              pluginCategoryTags: ["tools"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    await listPageForViewerInternalHandler(ctx, {
      family: "code-plugin",
      category: "tools",
      sort: "installs",
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(indexNames).toEqual(["by_active_family_category_installs"]);
  });

  it("uses channel-aware plugin category download indexes", async () => {
    const { ctx, indexNames } = makeDigestCtx({
      categoryPages: [
        {
          page: [
            makeDigest("community-tools", {
              channel: "community",
              pluginCategory: "tools",
              pluginCategoryTags: ["tools"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    await listPublicPageHandler(ctx, {
      channel: "community",
      category: "tools",
      sort: "downloads",
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(indexNames).toEqual(["by_active_channel_category_downloads"]);
  });

  it("uses family-aware official category sort indexes for official-first sources", async () => {
    const { ctx, indexNames } = makeDigestCtx({
      categoryPages: [
        {
          page: [
            makeDigest("api-demo", {
              family: "code-plugin",
              isOfficial: true,
              pluginCategory: "tools",
              pluginCategoryTags: ["tools"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    await listPageForViewerInternalHandler(ctx, {
      family: "code-plugin",
      isOfficial: true,
      category: "tools",
      sort: "installs",
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(indexNames).toEqual(["by_active_family_official_category_installs"]);
  });

  it("resumes legacy category digest cursors on the updated index", async () => {
    const legacyCursor = `pkgpage:${JSON.stringify({
      cursor: "category:next",
      offset: 0,
      pageSize: 50,
      done: false,
      mode: "digest",
    })}`;
    const { ctx, indexNames } = makeDigestCtx({
      categoryPages: [
        {
          page: [
            makeDigest("api-demo", {
              pluginCategory: "tools",
              pluginCategoryTags: ["tools"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    await listPublicPageHandler(ctx, {
      category: "tools",
      sort: "installs",
      paginationOpts: { cursor: legacyCursor, numItems: 10 },
    });

    expect(indexNames).toEqual(["by_active_category_updated"]);
  });

  it("preserves family filters on sorted category digest pages", async () => {
    const { ctx } = makeDigestCtx({
      categoryPages: [
        {
          page: [
            makeDigest("bundle-tools", {
              family: "bundle-plugin",
              pluginCategory: "tools",
              pluginCategoryTags: ["tools"],
            }),
            makeDigest("code-tools", {
              family: "code-plugin",
              pluginCategory: "tools",
              pluginCategoryTags: ["tools"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      family: "code-plugin",
      category: "tools",
      sort: "downloads",
      paginationOpts: { cursor: null, numItems: 1 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["code-tools"]);
  });

  it("uses topic digests so topic-filtered listings do not skip later matches", async () => {
    const { ctx, indexNames, tableNames } = makeDigestCtx({
      pages: [
        {
          page: [makeDigest("newer-noise", { topics: ["notes"] })],
          isDone: false,
          continueCursor: "later",
        },
        {
          page: [makeDigest("calendar-demo", { topics: ["calendar"] })],
          isDone: true,
          continueCursor: "",
        },
      ],
      topicPages: [
        {
          page: [
            makeDigest("calendar-demo", {
              topic: "calendar",
              topics: ["calendar", "Official"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      topic: " Calendar ",
      sort: "recommended",
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["calendar-demo"]);
    expect(tableNames).toEqual(["packageTopicSearchDigest"]);
    expect(indexNames).toEqual([
      "by_active_recommended_score",
      "by_active_recommended_score_version",
      "by_active_recommended_score_version",
      "by_active_topic_recommended_score",
    ]);
  });

  it("uses family-aware topic digest sort indexes for filtered listings", async () => {
    const { ctx, indexNames } = makeDigestCtx({
      topicPages: [
        {
          page: [makeDigest("calendar-demo", { topic: "calendar", topics: ["calendar"] })],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    await listPublicPageHandler(ctx, {
      family: "code-plugin",
      topic: "calendar",
      sort: "downloads",
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(indexNames).toEqual(["by_active_family_topic_downloads"]);
  });

  it("keeps metadata recommendation fallback cursors on the updated digest index", async () => {
    const { ctx, indexNames } = makeDigestCtx({
      packagePages: [
        {
          page: [makePackageDoc({ recommendedScore: undefined })],
          isDone: true,
          continueCursor: "",
        },
      ],
      topicPages: [
        {
          page: [makeDigest("calendar-first", { topic: "calendar", topics: ["calendar"] })],
          isDone: false,
          continueCursor: "topic:next",
        },
        {
          page: [makeDigest("calendar-second", { topic: "calendar", topics: ["calendar"] })],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const first = await listPublicPageHandler(ctx, {
      topic: "calendar",
      sort: "recommended",
      paginationOpts: { cursor: null, numItems: 1 },
    });
    const second = await listPublicPageHandler(ctx, {
      topic: "calendar",
      sort: "recommended",
      paginationOpts: { cursor: first.continueCursor, numItems: 1 },
    });

    expect(first.page.map((entry) => entry.name)).toEqual(["calendar-first"]);
    expect(second.page.map((entry) => entry.name)).toEqual(["calendar-second"]);
    expect(indexNames).toEqual([
      "by_active_recommended_score",
      "by_active_topic_updated",
      "by_active_topic_updated",
    ]);
  });

  it("does not revive retired capability filters for topic-filtered listings", async () => {
    const { ctx, indexNames } = makeDigestCtx({
      topicPages: [
        {
          page: [makeDigest("calendar-demo", { topic: "calendar", topics: ["calendar"] })],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      topic: "calendar",
      capabilityTag: "tools",
      executesCode: true,
      paginationOpts: { cursor: null, numItems: 10 },
    } as Parameters<typeof listPublicPageHandler>[1] & {
      capabilityTag?: string;
      executesCode?: boolean;
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["calendar-demo"]);
    expect(indexNames).toEqual(["by_active_topic_updated"]);
  });

  it("continues topic digest scans after filtering private packages", async () => {
    const { ctx, paginate } = makeDigestCtx({
      topicPages: [
        {
          page: [
            makeDigest("calendar-private", {
              channel: "private",
              topic: "calendar",
              topics: ["calendar"],
            }),
          ],
          isDone: false,
          continueCursor: "topic:public",
        },
        {
          page: [makeDigest("calendar-public", { topic: "calendar", topics: ["calendar"] })],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const first = await listPublicPageHandler(ctx, {
      topic: "calendar",
      paginationOpts: { cursor: null, numItems: 1 },
    });

    expect(first.page).toEqual([]);
    expect(first.isDone).toBe(false);
    expect(first.continueCursor).toMatch(/^pkgpage:/);
    expect(paginate).toHaveBeenCalledTimes(1);

    const second = await listPublicPageHandler(ctx, {
      topic: "calendar",
      paginationOpts: { cursor: first.continueCursor, numItems: 1 },
    });

    expect(second.page.map((entry) => entry.name)).toEqual(["calendar-public"]);
    expect(second.isDone).toBe(true);
    expect(paginate).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid topic filters instead of returning an unfiltered listing", async () => {
    const { ctx, tableNames } = makeDigestCtx({
      pages: [
        {
          page: [makeDigest("unfiltered-plugin")],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      topic: "!!!",
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(result).toEqual({ page: [], isDone: true, continueCursor: "" });
    expect(tableNames).toEqual([]);
  });

  it("scans topic digest pages until a combined category match is found", async () => {
    const { ctx, indexNames, tableNames, paginate } = makeDigestCtx({
      topicPages: [
        {
          page: [
            makeDigest("calendar-chat", {
              topic: "calendar",
              topics: ["calendar"],
              pluginCategoryTags: ["channels"],
            }),
          ],
          isDone: false,
          continueCursor: "later",
        },
        {
          page: [
            makeDigest("calendar-api", {
              topic: "calendar",
              topics: ["calendar"],
              pluginCategoryTags: ["tools"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const first = await listPublicPageHandler(ctx, {
      topic: "calendar",
      category: "tools",
      paginationOpts: { cursor: null, numItems: 1 },
    });

    expect(first.page).toEqual([]);
    expect(first.isDone).toBe(false);
    expect(first.continueCursor).toMatch(/^pkgpage:/);
    expect(tableNames).toEqual(["packageTopicSearchDigest"]);
    expect(indexNames).toEqual(["by_active_topic_updated"]);
    expect(paginate).toHaveBeenCalledTimes(1);

    const second = await listPublicPageHandler(ctx, {
      topic: "calendar",
      category: "tools",
      paginationOpts: { cursor: first.continueCursor, numItems: 1 },
    });

    expect(second.page.map((entry) => entry.name)).toEqual(["calendar-api"]);
    expect(tableNames).toEqual(["packageTopicSearchDigest", "packageTopicSearchDigest"]);
    expect(indexNames).toEqual(["by_active_topic_updated", "by_active_topic_updated"]);
    expect(paginate).toHaveBeenCalledTimes(2);
  });

  it("bounds sparse combined-filter scans and resumes from the returned cursor", async () => {
    const topicPages = Array.from({ length: 7 }, (_, index) => ({
      page: [
        makeDigest(index === 6 ? "calendar-api" : `calendar-noise-${index}`, {
          topic: "calendar",
          topics: ["calendar"],
          pluginCategoryTags: [index === 6 ? "tools" : "channels"],
        }),
      ],
      isDone: index === 6,
      continueCursor: index === 6 ? "" : `topic:${index + 1}`,
    }));
    const { ctx, paginate } = makeDigestCtx({ topicPages });

    let cursor: string | null = null;
    for (let index = 0; index < 6; index += 1) {
      const result = await listPublicPageHandler(ctx, {
        topic: "calendar",
        category: "tools",
        paginationOpts: { cursor, numItems: 1 },
      });
      expect(result.page).toEqual([]);
      expect(result.isDone).toBe(false);
      expect(result.continueCursor.startsWith("pkgpage:")).toBe(true);
      cursor = result.continueCursor;
    }

    const final = await listPublicPageHandler(ctx, {
      topic: "calendar",
      category: "tools",
      paginationOpts: { cursor, numItems: 1 },
    });

    expect(final.page.map((entry) => entry.name)).toEqual(["calendar-api"]);
    expect(final.isDone).toBe(true);
    expect(paginate).toHaveBeenCalledTimes(7);
  });

  it("paginates official category plugins before community fallback", async () => {
    const { ctx } = makeDigestCtx({
      categoryPages: [
        {
          page: [
            makeDigest("community-security", {
              isOfficial: false,
              pluginCategory: "security",
              pluginCategoryTags: ["security"],
            }),
            makeDigest("official-security", {
              isOfficial: true,
              pluginCategory: "security",
              pluginCategoryTags: ["security"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const first = await listPublicPageHandler(ctx, {
      category: "security",
      officialFirst: true,
      paginationOpts: { cursor: null, numItems: 1 },
    });
    expect(first.page.map((entry) => entry.name)).toEqual(["official-security"]);
    expect(first.isDone).toBe(false);

    const second = await listPublicPageHandler(ctx, {
      category: "security",
      officialFirst: true,
      paginationOpts: { cursor: first.continueCursor, numItems: 1 },
    });
    expect(second.page.map((entry) => entry.name)).toEqual(["community-security"]);
    expect(second.isDone).toBe(false);

    const third = await listPublicPageHandler(ctx, {
      category: "security",
      officialFirst: true,
      paginationOpts: { cursor: second.continueCursor, numItems: 1 },
    });
    expect(third.page).toEqual([]);
    expect(third.isDone).toBe(true);
  });

  it("does not advertise an empty community page after a full official category page", async () => {
    const { ctx } = makeDigestCtx({
      categoryPages: [
        {
          page: [
            makeDigest("official-security", {
              isOfficial: true,
              pluginCategory: "security",
              pluginCategoryTags: ["security"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await listPublicPageHandler(ctx, {
      category: "security",
      officialFirst: true,
      paginationOpts: { cursor: null, numItems: 1 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["official-security"]);
    expect(result.isDone).toBe(true);
    expect(result.continueCursor).toBe("");
  });

  it("keeps community continuation when the bounded probe is saturated by excluded rows", async () => {
    const officialDigest = makeDigest("official-security", {
      isOfficial: true,
      pluginCategory: "security",
      pluginCategoryTags: ["security"],
    });
    const excludedCommunityDigests = Array.from({ length: 200 }, (_, index) =>
      makeDigest(`pending-community-security-${index}`, {
        scanStatus: "pending",
        pluginCategory: "security",
        pluginCategoryTags: ["security"],
      }),
    );
    const { ctx, paginate, take } = makeDigestCtx({
      categoryPages: [
        {
          page: [officialDigest],
          isDone: true,
          continueCursor: "",
        },
      ],
      categoryRows: excludedCommunityDigests,
    });

    const result = await listPublicPageHandler(ctx, {
      category: "security",
      officialFirst: true,
      excludedScanStatuses: ["pending"],
      paginationOpts: { cursor: null, numItems: 1 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["official-security"]);
    expect(result.isDone).toBe(false);
    expect(result.continueCursor).toMatch(/^pkgofficialfirst:/);
    expect(paginate).toHaveBeenCalledTimes(1);
    expect(take).toHaveBeenCalledWith(200);
  });

  it("fills under-limit official-first category pages with community digests", async () => {
    const officialDigest = makeDigest("official-security", {
      isOfficial: true,
      pluginCategory: "security",
      pluginCategoryTags: ["security"],
    });
    const firstCommunityDigest = makeDigest("community-security-one", {
      isOfficial: false,
      pluginCategory: "security",
      pluginCategoryTags: ["security"],
    });
    const secondCommunityDigest = makeDigest("community-security-two", {
      isOfficial: false,
      pluginCategory: "security",
      pluginCategoryTags: ["security"],
    });
    const { ctx, paginate, take } = makeDigestCtx({
      categoryPages: [
        {
          page: [officialDigest],
          isDone: true,
          continueCursor: "",
        },
      ],
      categoryRows: [officialDigest, firstCommunityDigest, secondCommunityDigest],
    });

    const result = await listPublicPageHandler(ctx, {
      category: "security",
      officialFirst: true,
      paginationOpts: { cursor: null, numItems: 3 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual([
      "official-security",
      "community-security-one",
      "community-security-two",
    ]);
    expect(result.isDone).toBe(true);
    expect(result.continueCursor).toBe("");
    expect(paginate).toHaveBeenCalledTimes(1);
    expect(take).toHaveBeenCalledTimes(1);
  });

  it("keeps highlighted-only filtering while filling official-first category pages", async () => {
    const officialHighlighted = makeDigest("official-highlighted-security", {
      isOfficial: true,
      pluginCategory: "security",
      pluginCategoryTags: ["security"],
    });
    const communityHighlighted = makeDigest("community-highlighted-security", {
      isOfficial: false,
      pluginCategory: "security",
      pluginCategoryTags: ["security"],
    });
    const communityUnhighlighted = makeDigest("community-unhighlighted-security", {
      isOfficial: false,
      pluginCategory: "security",
      pluginCategoryTags: ["security"],
    });
    const { ctx } = makeDigestCtx({
      highlightedBadges: [
        { packageId: officialHighlighted.packageId },
        { packageId: communityHighlighted.packageId },
      ],
      exactDigests: [officialHighlighted, communityHighlighted],
      categoryRows: [communityUnhighlighted],
    });

    const result = await listPublicPageHandler(ctx, {
      category: "security",
      officialFirst: true,
      highlightedOnly: true,
      paginationOpts: { cursor: null, numItems: 3 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual([
      "official-highlighted-security",
      "community-highlighted-security",
    ]);
    expect(result.isDone).toBe(true);
    expect(result.continueCursor).toBe("");
  });

  it("does not advertise unhighlighted community rows after a full highlighted official page", async () => {
    const officialHighlighted = makeDigest("official-highlighted-security", {
      isOfficial: true,
      pluginCategory: "security",
      pluginCategoryTags: ["security"],
    });
    const communityUnhighlighted = makeDigest("community-unhighlighted-security", {
      isOfficial: false,
      pluginCategory: "security",
      pluginCategoryTags: ["security"],
    });
    const { ctx } = makeDigestCtx({
      highlightedBadges: [{ packageId: officialHighlighted.packageId }],
      exactDigests: [officialHighlighted],
      categoryRows: [communityUnhighlighted],
    });

    const result = await listPublicPageHandler(ctx, {
      category: "security",
      officialFirst: true,
      highlightedOnly: true,
      paginationOpts: { cursor: null, numItems: 1 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["official-highlighted-security"]);
    expect(result.isDone).toBe(true);
    expect(result.continueCursor).toBe("");
  });

  it("checks official-first category community availability without a second paginate", async () => {
    const officialDigest = makeDigest("official-security", {
      isOfficial: true,
      pluginCategory: "security",
      pluginCategoryTags: ["security"],
    });
    const communityDigest = makeDigest("community-security", {
      isOfficial: false,
      pluginCategory: "security",
      pluginCategoryTags: ["security"],
    });
    const { ctx, paginate, take } = makeDigestCtx({
      categoryPages: [
        {
          page: [officialDigest],
          isDone: true,
          continueCursor: "",
        },
      ],
      categoryRows: [officialDigest, communityDigest],
    });

    const result = await listPublicPageHandler(ctx, {
      category: "security",
      officialFirst: true,
      paginationOpts: { cursor: null, numItems: 1 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["official-security"]);
    expect(result.isDone).toBe(false);
    expect(result.continueCursor).toMatch(/^pkgofficialfirst:/);
    expect(paginate).toHaveBeenCalledTimes(1);
    expect(take).toHaveBeenCalledTimes(1);
  });

  it("uses plugin category digests for category-filtered search", async () => {
    const { ctx, indexNames, tableNames } = makeDigestCtx({
      categoryPages: [
        {
          page: [
            makeDigest("api-demo", {
              pluginCategory: "tools",
              pluginCategoryTags: ["tools"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "api",
      category: "tools",
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["api-demo"]);
    expect(tableNames).toEqual([
      "packagePluginCategorySearchDigest",
      "packagePluginCategorySearchDigest",
    ]);
    expect(indexNames).toEqual([
      "by_active_official_category_updated",
      "by_active_category_updated",
    ]);
  });

  it("uses topic digests for topic-filtered search", async () => {
    const { ctx, indexNames, tableNames } = makeDigestCtx({
      topicPages: [
        {
          page: [
            makeDigest("calendar-demo", {
              topic: "calendar",
              topics: ["calendar"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "calendar",
      topic: "calendar",
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["calendar-demo"]);
    expect(tableNames).toContain("packageTopicSearchDigest");
    expect(indexNames).toContain("by_active_topic_updated");
  });

  it("includes exact package-name matches in topic-filtered search", async () => {
    const exactPkg = makePackageDoc({
      _id: "packages:exact",
      name: "demo-plugin",
      normalizedName: "demo-plugin",
    });
    const exactDigest = makeDigest("demo-plugin", {
      packageId: "packages:exact",
      topics: ["calendar"],
    });
    const { ctx } = makeDigestCtx({
      topicPages: [{ page: [], isDone: true, continueCursor: "" }],
      exactPackages: [exactPkg],
      exactDigests: [exactDigest],
    });

    const result = await searchPublicHandler(ctx, {
      query: "demo-plugin",
      topic: "calendar",
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["demo-plugin"]);
  });

  it("scans topic digest pages until a combined category search match is found", async () => {
    const { ctx, paginate } = makeDigestCtx({
      topicPages: [
        {
          page: Array.from({ length: 50 }, (_, index) =>
            makeDigest(`calendar-chat-${index}`, {
              topic: "calendar",
              topics: ["calendar"],
              pluginCategoryTags: ["channels"],
            }),
          ),
          isDone: false,
          continueCursor: "later",
        },
        {
          page: [
            makeDigest("calendar-api", {
              topic: "calendar",
              topics: ["calendar"],
              pluginCategoryTags: ["tools"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "calendar",
      topic: "calendar",
      category: "tools",
      limit: 1,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["calendar-api"]);
    expect(paginate).toHaveBeenCalledTimes(2);
  });

  it("ranks bounded candidates from every stable family before applying the search limit", async () => {
    const previous = process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("skill-helper", {
              family: "skill",
              summary: "Calendar integration",
            }),
            makeDigest("official-plugin", {
              family: "code-plugin",
              isOfficial: true,
              summary: "Calendar integration",
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    try {
      const result = await searchPublicHandler(ctx, { query: "calendar", limit: 1 });
      expect(result.map((entry) => entry.package.name)).toEqual(["official-plugin"]);
    } finally {
      if (previous === undefined) delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
      else process.env.CLAWHUB_EXPERIMENTAL_CLAWS = previous;
    }
  });

  it("gives every stable family a fair combined-filter scan budget", async () => {
    const previous = process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    const noisePage = (family: "skill" | "code-plugin" | "bundle-plugin", page: number) =>
      Array.from({ length: 50 }, (_, index) =>
        makeDigest(`${family}-noise-${page}-${index}`, {
          family,
          topic: "calendar",
          topics: ["calendar"],
          pluginCategoryTags: ["channels"],
        }),
      );
    const { ctx } = makeDigestCtx({
      topicPagesByFamily: {
        skill: [
          { page: noisePage("skill", 1), isDone: false, continueCursor: "skill:2" },
          { page: noisePage("skill", 2), isDone: false, continueCursor: "skill:3" },
          { page: noisePage("skill", 3), isDone: true, continueCursor: "" },
        ],
        "code-plugin": [
          {
            page: noisePage("code-plugin", 1),
            isDone: false,
            continueCursor: "code:2",
          },
          {
            page: noisePage("code-plugin", 2),
            isDone: false,
            continueCursor: "code:3",
          },
          { page: noisePage("code-plugin", 3), isDone: true, continueCursor: "" },
        ],
        "bundle-plugin": [
          {
            page: noisePage("bundle-plugin", 1),
            isDone: false,
            continueCursor: "bundle:2",
          },
          {
            page: noisePage("bundle-plugin", 2),
            isDone: false,
            continueCursor: "bundle:3",
          },
          {
            page: [
              makeDigest("calendar-bundle-api", {
                family: "bundle-plugin",
                topic: "calendar",
                topics: ["calendar"],
                pluginCategoryTags: ["tools"],
              }),
            ],
            isDone: true,
            continueCursor: "",
          },
        ],
      },
    });

    try {
      const result = await searchPublicHandler(ctx, {
        query: "calendar",
        topic: "calendar",
        category: "tools",
        limit: 1,
      });
      expect(result.map((entry) => entry.package.name)).toEqual(["calendar-bundle-api"]);
    } finally {
      if (previous === undefined) delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
      else process.env.CLAWHUB_EXPERIMENTAL_CLAWS = previous;
    }
  });

  it("scans each stable family past the first combined-filter window while Claws are disabled", async () => {
    const previous = process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    const { ctx, paginate } = makeDigestCtx({
      topicPages: [
        {
          page: Array.from({ length: 50 }, (_, index) =>
            makeDigest(`calendar-skill-noise-${index}`, {
              family: "skill",
              topic: "calendar",
              topics: ["calendar"],
              pluginCategoryTags: ["channels"],
            }),
          ),
          isDone: false,
          continueCursor: "later",
        },
        {
          page: [
            makeDigest("calendar-skill-api", {
              family: "skill",
              topic: "calendar",
              topics: ["calendar"],
              pluginCategoryTags: ["tools"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    try {
      const result = await searchPublicHandler(ctx, {
        query: "calendar",
        topic: "calendar",
        category: "tools",
        limit: 1,
      });

      expect(result.map((entry) => entry.package.name)).toEqual(["calendar-skill-api"]);
      expect(paginate).toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
      else process.env.CLAWHUB_EXPERIMENTAL_CLAWS = previous;
    }
  });

  it("bounds sparse combined-filter search scans", async () => {
    const topicPages = Array.from({ length: 7 }, (_page, pageIndex) => ({
      page: Array.from({ length: 50 }, (_digest, digestIndex) =>
        makeDigest(`calendar-noise-${pageIndex}-${digestIndex}`, {
          topic: "calendar",
          topics: ["calendar"],
          pluginCategoryTags: ["channels"],
        }),
      ),
      isDone: pageIndex === 6,
      continueCursor: pageIndex === 6 ? "" : `topic:${pageIndex + 1}`,
    }));
    const { ctx, paginate, take } = makeDigestCtx({ topicPages });

    const result = await searchPublicHandler(ctx, {
      query: "calendar",
      topic: "calendar",
      category: "tools",
      limit: 1,
    });

    expect(result).toEqual([]);
    expect(paginate).toHaveBeenCalledTimes(6);
    expect(take).toHaveBeenCalledTimes(2);
    expect(take).toHaveBeenCalledWith(20);
    expect(take).toHaveBeenCalledWith(200);
  });

  it("recalls exact author topics without an explicit topic filter", async () => {
    const { ctx, indexNames, tableNames } = makeDigestCtx({
      topicPages: [
        {
          page: [
            makeDigest("accelerated-helper", {
              topic: "gpu-development",
              topics: ["GPU development"],
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "GPU development",
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["accelerated-helper"]);
    expect(tableNames).toContain("packageTopicSearchDigest");
    expect(indexNames).toContain("by_active_topic_updated");
  });

  it("rejects invalid topic filters instead of returning unfiltered search results", async () => {
    const { ctx, tableNames } = makeDigestCtx({
      pages: [
        {
          page: [makeDigest("unfiltered-plugin")],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "plugin",
      topic: "!!!",
      limit: 10,
    });

    expect(result).toEqual([]);
    expect(tableNames).toEqual([]);
  });

  it("bounds fallback search to the first digest take window", async () => {
    const olderMatch = makeDigest("old-package", {
      displayName: "Old Package",
      summary: "legacy helper",
      updatedAt: 10,
    });
    const { ctx, paginate, take } = makeDigestCtx({
      pages: [
        {
          page: Array.from({ length: 200 }, (_, index) =>
            makeDigest(`noise-${index}`, { updatedAt: 5_000 - index }),
          ),
          isDone: false,
          continueCursor: "cursor:1",
        },
        {
          page: [olderMatch],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "legacy",
      limit: 10,
    });

    expect(result).toEqual([]);
    expect(paginate).not.toHaveBeenCalled();
    expect(take).toHaveBeenCalledTimes(4);
    expect(take).toHaveBeenCalledWith(20);
    expect(take).toHaveBeenCalledWith(50);
  });

  it("includes exact package-name matches before digest scanning", async () => {
    const exactPkg = makePackageDoc({
      _id: "packages:exact",
      name: "demo-plugin",
      normalizedName: "demo-plugin",
    });
    const exactDigest = makeDigest("demo-plugin", {
      packageId: "packages:exact",
    });
    const { ctx, take } = makeDigestCtx({
      pages: [],
      exactPackages: [exactPkg],
      exactDigests: [exactDigest],
    });

    const result = await searchPublicHandler(ctx, {
      query: "demo-plugin",
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["demo-plugin"]);
    expect(take).toHaveBeenCalledTimes(4);
    expect(ctx.db.query).toHaveBeenCalledWith("packageSearchDigest");
  });

  it("includes exact runtime-id matches before digest scanning", async () => {
    const exactPkg = makePackageDoc({
      _id: "packages:runtime",
      name: "runtime-demo",
      normalizedName: "runtime-demo",
      runtimeId: "demo.plugin",
    });
    const exactDigest = makeDigest("runtime-demo", {
      packageId: "packages:runtime",
      runtimeId: "demo.plugin",
    });
    const { ctx, take } = makeDigestCtx({
      pages: [],
      exactPackages: [exactPkg],
      exactDigests: [exactDigest],
    });

    const result = await searchPublicHandler(ctx, {
      query: "demo.plugin",
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["runtime-demo"]);
    expect(take).toHaveBeenCalledTimes(4);
    expect(ctx.db.query).toHaveBeenCalledWith("packageSearchDigest");
  });

  it("includes display-name matches before digest scanning", async () => {
    const displayDigest = makeDigest("vpai-plugin", {
      packageId: "packages:vpai-plugin",
      displayName: "Vibe Prospecting",
      ownerHandle: "vibeprospecting",
    });
    const { ctx, searchIndexNames } = makeDigestCtx({
      pages: [],
      exactDigests: [displayDigest],
    });

    const result = await searchPublicHandler(ctx, {
      query: "vibe prospecting",
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["vpai-plugin"]);
    expect(searchIndexNames).toContain("search_by_display_name");
  });

  it("includes creator handle matches before digest scanning", async () => {
    const ownerDigest = makeDigest("vpai-plugin", {
      packageId: "packages:vpai-plugin",
      displayName: "Vibe Prospecting",
      ownerHandle: "vibeprospecting",
    });
    const { ctx } = makeDigestCtx({
      pages: [],
      exactDigests: [ownerDigest],
    });

    const result = await searchPublicHandler(ctx, {
      query: "@vibeprospecting",
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["vpai-plugin"]);
  });

  it("includes prefix package-name matches before digest scanning", async () => {
    const prefixPkg = makePackageDoc({
      _id: "packages:prefix",
      name: "demo-prefix",
      normalizedName: "demo-prefix",
    });
    const prefixDigest = makeDigest("demo-prefix", {
      packageId: "packages:prefix",
    });
    const { ctx, take } = makeDigestCtx({
      pages: [],
      exactPackages: [prefixPkg],
      exactDigests: [prefixDigest],
    });

    const result = await searchPublicHandler(ctx, {
      query: "demo",
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["demo-prefix"]);
    expect(take).toHaveBeenCalledTimes(4);
    expect(ctx.db.query).toHaveBeenCalledWith("packageSearchDigest");
  });

  it("keeps direct package-name matches scoped to the requested family", async () => {
    const exactPkg = makePackageDoc({
      _id: "packages:code",
      name: "demo-plugin",
      normalizedName: "demo-plugin",
      family: "code-plugin",
    });
    const exactDigest = makeDigest("demo-plugin", {
      packageId: "packages:code",
      family: "code-plugin",
    });
    const { ctx } = makeDigestCtx({
      pages: [],
      exactPackages: [exactPkg],
      exactDigests: [exactDigest],
    });

    const result = await searchPublicHandler(ctx, {
      query: "demo-plugin",
      family: "bundle-plugin",
      limit: 1,
    });

    expect(result).toEqual([]);
  });

  it("stops fallback scanning after enough package search matches", async () => {
    const { ctx, take } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("alpha", { displayName: "Alpha", summary: "useful demo", updatedAt: 20 }),
            makeDigest("beta", { displayName: "Beta", summary: "useful demo", updatedAt: 10 }),
          ],
          isDone: false,
          continueCursor: "cursor:1",
        },
        {
          page: [makeDigest("gamma", { displayName: "Gamma", summary: "useful demo" })],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "useful",
      limit: 2,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["alpha", "beta"]);
    expect(take).toHaveBeenCalledTimes(4);
    expect(take).toHaveBeenCalledWith(20);
    expect(take).toHaveBeenCalledWith(50);
  });

  it("keeps spaced queries on the scan path without throwing", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("demo-plugin", {
              displayName: "Demo Plugin",
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "demo plugin",
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["demo-plugin"]);
  });

  it("skips publisher membership lookups for public search rows", async () => {
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("demo-plugin", {
              ownerPublisherId: "publishers:org",
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
      publisherMemberships: {
        "publishers:org": "publisher",
      },
    });

    const result = await searchForViewerInternalHandler(ctx, {
      query: "demo",
      limit: 10,
      viewerUserId: "users:member",
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["demo-plugin"]);
    expect(ctx.db.query).not.toHaveBeenCalledWith("publisherMembers");
  });

  it("keeps public list pages to one paginated query per invocation", async () => {
    const { ctx, paginate } = makeDigestCtx({
      pages: Array.from({ length: 120 }, (_, index) => ({
        page: [makeDigest(`noise-${index}`)],
        isDone: false,
        continueCursor: `cursor:${index + 1}`,
      })),
    });

    const result = await listPublicPageHandler(ctx, {
      paginationOpts: { cursor: null, numItems: 100 },
    });

    expect(result.page.map((entry) => entry.name)).toEqual(["noise-0"]);
    expect(result.isDone).toBe(false);
    expect(result.continueCursor).toBeTruthy();
    expect(paginate).toHaveBeenCalledTimes(1);
    expect(paginate).toHaveBeenCalledWith({ cursor: null, numItems: 100 });
  });

  it("caps public search scans below the Convex read limit budget", async () => {
    const { ctx, paginate, take } = makeDigestCtx({
      pages: Array.from({ length: 170 }, (_, index) => ({
        page: [
          makeDigest(`noise-${index}`, {
            executesCode: false,
            updatedAt: 10_000 - index,
          }),
        ],
        isDone: false,
        continueCursor: `cursor:${index + 1}`,
      })),
    });

    const result = await searchPublicHandler(ctx, {
      query: "demo",
      executesCode: true,
      limit: 100,
    });

    expect(result).toEqual([]);
    expect(paginate).not.toHaveBeenCalled();
    expect(take).toHaveBeenCalledTimes(4);
    expect(take).toHaveBeenCalledWith(20);
    expect(take).toHaveBeenCalledWith(200);
  });

  it("uses the official index for no-family official search filters", async () => {
    const { ctx, indexNames } = makeDigestCtx({
      pages: [
        {
          page: [makeDigest("official-demo", { isOfficial: true })],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "official",
      isOfficial: true,
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["official-demo"]);
    expect(indexNames).toEqual([
      "by_active_topic_updated",
      "by_active_topic_updated",
      "by_active_official_updated",
    ]);
  });

  it("uses the channel index for no-family channel search filters", async () => {
    const { ctx, indexNames } = makeDigestCtx({
      pages: [
        {
          page: [makeDigest("community-demo", { channel: "community" })],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "community",
      channel: "community",
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["community-demo"]);
    expect(indexNames).toEqual([
      "by_active_topic_updated",
      "by_active_topic_updated",
      "by_active_channel_updated",
    ]);
  });

  it("uses the combined channel and official index when both filters are set", async () => {
    const { ctx, indexNames } = makeDigestCtx({
      pages: [
        {
          page: [
            makeDigest("official-community-demo", {
              channel: "community",
              isOfficial: true,
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "official-community",
      channel: "community",
      isOfficial: true,
      limit: 10,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["official-community-demo"]);
    expect(indexNames).toEqual([
      "by_active_topic_updated",
      "by_active_topic_updated",
      "by_active_channel_official_updated",
    ]);
  });

  it("blocks anonymous reads of private packages", async () => {
    const { ctx } = makePackageCtx({
      pkg: makePackageDoc({ channel: "private" }),
    });

    await expect(
      getByNameHandler(ctx, {
        name: "demo-plugin",
        viewerUserId: "users:owner",
      } as never),
    ).resolves.toBeNull();
    await expect(
      listVersionsHandler(ctx, {
        name: "demo-plugin",
        viewerUserId: "users:owner",
        paginationOpts: { cursor: null, numItems: 10 },
      } as never),
    ).resolves.toEqual({
      page: [],
      isDone: true,
      continueCursor: "",
    });
    await expect(
      getVersionByNameHandler(ctx, {
        name: "demo-plugin",
        version: "1.0.0",
        viewerUserId: "users:owner",
      } as never),
    ).resolves.toBeNull();
    await expect(
      getVersionSecurityByNameForViewerInternalHandler(ctx, {
        name: "demo-plugin",
        version: "1.0.0",
      }),
    ).resolves.toBeNull();
  });

  it("allows anonymous exact security reads for blocked public packages", async () => {
    const { ctx } = makePackageCtx({
      pkg: makePackageDoc({ channel: "community", scanStatus: "malicious" }),
    });

    await expect(
      getByNameHandler(ctx, {
        name: "demo-plugin",
      }),
    ).resolves.toBeNull();
    await expect(
      getVersionSecurityByNameForViewerInternalHandler(ctx, {
        name: "demo-plugin",
        version: "1.0.0",
      }),
    ).resolves.toMatchObject({
      package: { name: "demo-plugin", publicDownloadBlocked: true },
      version: { version: "1.0.0" },
    });
  });

  it("normalizes legacy static-only package blocks through latest ClawScan state", async () => {
    const verification = {
      tier: "source-linked",
      scope: "artifact-only",
      scanStatus: "malicious",
    };
    const latestRelease = makeReleaseDoc({
      sha256hash: "a".repeat(64),
      verification,
      staticScan: {
        status: "malicious",
        reasonCodes: ["malicious.static_fixture"],
        findings: [],
        summary: "Static fixture only.",
        engineVersion: "test",
        checkedAt: 1,
      },
      llmAnalysis: {
        status: "clean",
        verdict: "clean",
        checkedAt: 2,
      },
    });
    const { ctx } = makePackageCtx({
      pkg: makePackageDoc({
        channel: "community",
        scanStatus: "malicious",
        verification,
        latestVersionSummary: {
          version: "1.0.0",
          verification,
        },
      }),
      latestRelease,
    });

    await expect(
      getByNameHandler(ctx, {
        name: "demo-plugin",
      }),
    ).resolves.toMatchObject({
      package: {
        name: "demo-plugin",
        scanStatus: "clean",
        verification: { scanStatus: "clean" },
      },
    });
    await expect(
      getVersionByNameHandler(ctx, {
        name: "demo-plugin",
        version: "1.0.0",
      }),
    ).resolves.toMatchObject({
      package: {
        name: "demo-plugin",
        scanStatus: "clean",
      },
      version: { version: "1.0.0" },
    });
    await expect(
      getVersionSecurityByNameForViewerInternalHandler(ctx, {
        name: "demo-plugin",
        version: "1.0.0",
      }),
    ).resolves.toMatchObject({
      package: {
        name: "demo-plugin",
        scanStatus: "clean",
        publicDownloadBlocked: false,
      },
      version: { version: "1.0.0" },
    });
  });

  it("derives missing public verification source paths from legacy release provenance", async () => {
    const verification = {
      tier: "source-linked",
      scope: "artifact-only",
      sourceRepo: "OpenViking/OpenViking",
      sourceCommit: "abcdef0123456789abcdef0123456789abcdef01",
      scanStatus: "clean",
    };
    const latestRelease = makeReleaseDoc({
      verification,
      capabilities: { capabilityTags: ["legacy"], executesCode: true },
      source: {
        kind: "github",
        repo: "OpenViking/OpenViking",
        path: "openclaw-plugin",
      },
    });
    const { ctx } = makePackageCtx({
      pkg: makePackageDoc({
        name: "@openviking/openclaw-plugin",
        normalizedName: "@openviking/openclaw-plugin",
        verification,
        latestVersionSummary: {
          version: "1.0.0",
          verification,
        },
      }),
      latestRelease,
    });

    const detail = await getByNameHandler(ctx, {
      name: "@openviking/openclaw-plugin",
    });
    expect(detail).toMatchObject({
      package: {
        verification: { sourcePath: "openclaw-plugin" },
      },
      latestRelease: {
        verification: { sourcePath: "openclaw-plugin" },
      },
    });
    expect(detail?.latestRelease).not.toHaveProperty("capabilities");

    const version = await getVersionByNameHandler(ctx, {
      name: "@openviking/openclaw-plugin",
      version: "1.0.0",
    });
    expect(version).toMatchObject({
      package: {
        verification: { sourcePath: "openclaw-plugin" },
      },
      version: {
        verification: { sourcePath: "openclaw-plugin" },
      },
    });
    expect(version?.version).not.toHaveProperty("capabilities");
  });

  it("does not mark owner-readable blocked public packages as public download blocked", async () => {
    const { ctx } = makePackageCtx({
      pkg: makePackageDoc({
        channel: "community",
        scanStatus: "malicious",
        ownerUserId: "users:owner",
      }),
    });

    await expect(
      getVersionSecurityByNameForViewerInternalHandler(ctx, {
        name: "demo-plugin",
        version: "1.0.0",
        viewerUserId: "users:owner",
      }),
    ).resolves.toMatchObject({
      package: { name: "demo-plugin", publicDownloadBlocked: false },
      version: { version: "1.0.0" },
    });
  });

  it("allows owners to read their private packages", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue("users:owner" as never);
    const { ctx } = makePackageCtx({
      pkg: makePackageDoc({ channel: "private" }),
    });

    const detail = await getByNameHandler(ctx, {
      name: "demo-plugin",
    });
    const version = await getVersionByNameHandler(ctx, {
      name: "demo-plugin",
      version: "1.0.0",
    });

    expect(detail?.package.name).toBe("demo-plugin");
    expect(version?.version.version).toBe("1.0.0");
  });

  it("allows org collaborators to read org-owned private packages", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue("users:member" as never);
    const { ctx } = makePackageCtx({
      pkg: makePackageDoc({
        channel: "private",
        ownerUserId: "users:owner",
        ownerPublisherId: "publishers:org",
      }),
      ownerPublisher: {
        _id: "publishers:org",
        _creationTime: 1,
        kind: "org",
        handle: "acme",
        displayName: "Acme",
        linkedUserId: undefined,
      },
      viewerMembershipRole: "publisher",
    });

    const detail = await getByNameHandler(ctx, {
      name: "demo-plugin",
    });

    expect(detail?.package.name).toBe("demo-plugin");
  });

  it("treats auth resolution failures as anonymous for public package detail", async () => {
    vi.mocked(getAuthUserId).mockRejectedValue(new Error("stale session"));
    const { ctx } = makePackageCtx({
      pkg: makePackageDoc({ channel: "community" }),
    });

    const detail = await getByNameHandler(ctx, {
      name: "demo-plugin",
    });

    expect(detail?.package.name).toBe("demo-plugin");
  });

  it("treats invalid auth user lookups as anonymous for public package detail", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue("users:broken" as never);
    const { ctx } = makePackageCtx({
      pkg: makePackageDoc({ channel: "community" }),
    });
    const get = ctx.db.get as ReturnType<typeof vi.fn>;
    get.mockImplementation(async (id: string) => {
      if (id === "users:broken") throw new Error("Table mismatch");
      if (id === "users:owner") return { _id: id, handle: "owner" };
      if (id === "packageReleases:demo-1") return makeReleaseDoc();
      return null;
    });

    const detail = await getByNameHandler(ctx, {
      name: "demo-plugin",
    });

    expect(detail?.package.name).toBe("demo-plugin");
  });

  it("does not expose a soft-deleted latest release as latestVersion", async () => {
    const { ctx } = makePackageCtx({
      latestRelease: makeReleaseDoc({ softDeletedAt: 10 }),
    });

    const result = await getByNameHandler(ctx, {
      name: "demo-plugin",
    });

    expect(result?.package.latestVersion).toBeNull();
    expect(result?.latestRelease).toBeNull();
  });

  it("hides package shells that only have pending unpublished releases", async () => {
    const { ctx } = makePackageCtx({
      pkg: makePackageDoc({
        latestReleaseId: undefined,
        latestVersionSummary: undefined,
        stats: { downloads: 0, installs: 0, stars: 0, versions: 0 },
      }),
      latestRelease: null,
    });

    await expect(
      getByNameHandler(ctx, {
        name: "demo-plugin",
      }),
    ).resolves.toBeNull();
  });

  it("keeps published non-latest packages visible without latest pointers", async () => {
    const { ctx } = makePackageCtx({
      pkg: makePackageDoc({
        latestReleaseId: undefined,
        latestVersionSummary: undefined,
        stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
      }),
      latestRelease: null,
    });

    await expect(
      getByNameHandler(ctx, {
        name: "demo-plugin",
      }),
    ).resolves.toMatchObject({
      package: { name: "demo-plugin", latestVersion: null },
      latestRelease: null,
    });
  });

  it("hides soft-deleted releases from public version lists", async () => {
    const { ctx, releaseIndexNames } = makePackageCtx({
      versionsPage: {
        page: [
          makeReleaseDoc({ version: "1.1.0", softDeletedAt: 10 }),
          makeReleaseDoc({
            _id: "packageReleases:demo-2",
            version: "1.0.0",
            capabilities: { capabilityTags: ["legacy"], executesCode: true },
          }),
        ],
        isDone: true,
        continueCursor: "",
      },
    });

    const result = await listVersionsHandler(ctx, {
      name: "demo-plugin",
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(result.page.map((entry) => entry.version)).toEqual(["1.0.0"]);
    expect(result.page[0]).not.toHaveProperty("capabilities");
    expect(releaseIndexNames).toContain("by_package_active_created");
  });

  it("keeps ClawPack storage ids on internal downloadable version projections", async () => {
    const release = makeReleaseDoc({
      files: [],
      artifactKind: "npm-pack",
      clawpackStorageId: "storage:clawpack",
      clawpackSha256: "a".repeat(64),
    });
    const { ctx } = makePackageCtx({
      pkg: makePackageDoc({ family: "claw" }),
      latestRelease: release,
      versionRelease: release,
      versionsPage: {
        page: [
          release,
          makeReleaseDoc({
            _id: "packageReleases:legacy",
            version: "0.9.0",
            files: [],
          }),
        ],
        isDone: true,
        continueCursor: "",
      },
    });

    const listed = await listVersionsForViewerInternalHandler(ctx, {
      name: "demo-plugin",
      paginationOpts: { cursor: null, numItems: 10 },
    });
    const exact = await getVersionByNameForViewerInternalHandler(ctx, {
      name: "demo-plugin",
      version: "1.0.0",
    });

    expect(listed.page[0]).toMatchObject({
      version: "1.0.0",
      clawpackStorageId: "storage:clawpack",
    });
    expect(exact?.version).toMatchObject({
      version: "1.0.0",
      clawpackStorageId: "storage:clawpack",
    });
    expect(listed.page[1]).not.toHaveProperty("clawpackStorageId");
  });

  it("fills public package version pages after skipping pending releases", async () => {
    const releases = [
      makeReleaseDoc({
        _id: "packageReleases:pending",
        version: "2.0.0",
        publicationStatus: "pending",
      }),
      makeReleaseDoc({
        _id: "packageReleases:published",
        version: "1.0.0",
      }),
    ];
    const paginate = vi.fn(
      async ({ cursor, numItems }: { cursor: string | null; numItems: number }) => {
        const start = cursor ? Number(cursor) : 0;
        const page = releases.slice(start, start + numItems);
        const next = start + page.length;
        return {
          page,
          isDone: next >= releases.length,
          continueCursor: next >= releases.length ? "" : String(next),
        };
      },
    );
    const releaseIndexNames: string[] = [];
    const ctx = {
      db: {
        get: vi.fn(async (id: string) =>
          typeof id === "string" && id.startsWith("users:")
            ? { _id: id, handle: id.split(":").pop() ?? "user" }
            : null,
        ),
        query: vi.fn((table: string) => {
          if (table === "packages") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(makePackageDoc()),
              })),
            };
          }
          if (table === "packageReleases") {
            return {
              withIndex: vi.fn((indexName: string) => {
                releaseIndexNames.push(indexName);
                return {
                  order: vi.fn(() => ({
                    paginate,
                  })),
                };
              }),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      },
    };

    const result = await listVersionsHandler(ctx as never, {
      name: "demo-plugin",
      paginationOpts: { cursor: null, numItems: 1 },
    });

    expect(result).toMatchObject({
      page: [{ version: "1.0.0" }],
      isDone: true,
      continueCursor: "",
    });
    expect(paginate).toHaveBeenNthCalledWith(1, { cursor: null, numItems: 1 });
    expect(paginate).toHaveBeenNthCalledWith(2, { cursor: "1", numItems: 1 });
    expect(releaseIndexNames).toEqual(["by_package_active_created", "by_package_active_created"]);
  });

  it("soft-deletes packages and active releases for the owner", async () => {
    const { ctx, insert, patch } = makeSoftDeletePackageCtx({
      releases: [
        makeReleaseDoc(),
        makeReleaseDoc({
          _id: "packageReleases:demo-2",
          version: "1.1.0",
          softDeletedAt: 123,
        }),
      ],
    });

    const result = await softDeletePackageInternalHandler(ctx, {
      userId: "users:owner",
      name: "demo-plugin",
    });

    expect(result).toEqual({
      ok: true,
      packageId: "packages:demo",
      releaseCount: 1,
      alreadyDeleted: false,
    });
    expect(patch).toHaveBeenCalledWith("packageReleases:demo-1", {
      softDeletedAt: expect.any(Number),
    });
    expect(patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        softDeletedAt: expect.any(Number),
        updatedAt: expect.any(Number),
      }),
    );
    expect(patch).toHaveBeenCalledWith(
      "packageSearchDigest:demo",
      expect.objectContaining({
        packageId: "packages:demo",
        softDeletedAt: expect.any(Number),
        updatedAt: expect.any(Number),
      }),
    );
    const digestPatch = patch.mock.calls.find(([id]) => id === "packageSearchDigest:demo")?.[1];
    expect(digestPatch).not.toHaveProperty("softDeletedBy");
    expect(digestPatch).not.toHaveProperty("softDeletedByRole");
    expect(insert).toHaveBeenCalledWith(
      "auditLogs",
      expect.objectContaining({
        actorUserId: "users:owner",
        action: "package.delete",
        targetType: "package",
        targetId: "packages:demo",
        metadata: expect.objectContaining({
          name: "demo-plugin",
          normalizedName: "demo-plugin",
          ownerUserId: "users:owner",
          ownerPublisherId: undefined,
          releaseCount: 1,
          releaseIds: ["packageReleases:demo-1"],
          source: "cli",
        }),
        createdAt: expect.any(Number),
      }),
    );
  });

  it("rejects non-owner package soft deletes without moderator access", async () => {
    const { ctx } = makeSoftDeletePackageCtx({
      pkg: makePackageDoc({ ownerUserId: "users:someone-else" }),
      user: { _id: "users:owner", role: "user" },
    });

    await expect(
      softDeletePackageInternalHandler(ctx, {
        userId: "users:owner",
        name: "demo-plugin",
      }),
    ).rejects.toThrow("Forbidden");
  });

  it("allows moderators to soft-delete packages without ownership", async () => {
    const { ctx, patch } = makeSoftDeletePackageCtx({
      pkg: makePackageDoc({ ownerUserId: "users:someone-else" }),
      user: { _id: "users:moderator", role: "moderator" },
    });

    await expect(
      softDeletePackageInternalHandler(ctx, {
        userId: "users:moderator",
        name: "demo-plugin",
      }),
    ).resolves.toMatchObject({ ok: true, alreadyDeleted: false });
    expect(patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        softDeletedAt: expect.any(Number),
        softDeletedBy: "users:moderator",
        softDeletedByRole: "moderator",
      }),
    );
  });

  it("allows org publisher admins to soft-delete packages", async () => {
    const { ctx, patch } = makeSoftDeletePackageCtx({
      pkg: makePackageDoc({
        ownerUserId: "users:org-linked",
        ownerPublisherId: "publishers:org",
      }),
      user: { _id: "users:owner", role: "user" },
      membership: { _id: "publisherMembers:1", role: "admin" },
    });

    const result = await softDeletePackageInternalHandler(ctx, {
      userId: "users:owner",
      name: "demo-plugin",
    });

    expect(result).toEqual({
      ok: true,
      packageId: "packages:demo",
      releaseCount: 1,
      alreadyDeleted: false,
    });
    expect(patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        softDeletedAt: expect.any(Number),
      }),
    );
  });

  it("allows org publisher admins to restore packages and releases", async () => {
    const { ctx, patch, insert } = makeSoftDeletePackageCtx({
      pkg: makePackageDoc({
        ownerUserId: "users:org-linked",
        ownerPublisherId: "publishers:org",
        softDeletedAt: 123,
        softDeletedBy: "users:owner",
        softDeletedByRole: "user",
        latestReleaseId: undefined,
        latestVersionSummary: undefined,
        tags: {},
      }),
      releases: [
        makeReleaseDoc({
          softDeletedAt: 123,
          distTags: [],
          summary: "restored release",
          capabilities: { capabilityTags: ["tools"], executesCode: true },
          compatibility: { pluginApi: ">=1.0.0" },
          verification: { scanStatus: "clean" },
          artifactKind: "legacy-zip",
          integritySha256: "a".repeat(64),
          scanStatus: "clean",
        }),
        makeReleaseDoc({
          _id: "packageReleases:demo-2",
          version: "1.1.0",
          softDeletedAt: 123,
          distTags: ["beta"],
          createdAt: 2,
          artifactKind: "legacy-zip",
          integritySha256: "b".repeat(64),
        }),
      ],
      user: { _id: "users:owner", role: "user" },
      membership: { _id: "publisherMembers:1", role: "admin" },
    });

    const result = await restorePackageInternalHandler(ctx, {
      userId: "users:owner",
      name: "demo-plugin",
    });

    expect(result).toEqual({
      ok: true,
      packageId: "packages:demo",
      releaseCount: 2,
      alreadyRestored: false,
    });
    expect(patch).toHaveBeenCalledWith("packageReleases:demo-1", {
      softDeletedAt: undefined,
    });
    expect(patch).toHaveBeenCalledWith("packageReleases:demo-2", {
      softDeletedAt: undefined,
    });
    expect(patch).toHaveBeenCalledWith("packageReleases:demo-2", {
      distTags: ["beta", "latest"],
    });
    expect(patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        softDeletedAt: undefined,
        softDeletedBy: undefined,
        softDeletedByRole: undefined,
        latestReleaseId: "packageReleases:demo-2",
        latestVersionSummary: expect.objectContaining({ version: "1.1.0" }),
        tags: {
          beta: "packageReleases:demo-2",
          latest: "packageReleases:demo-2",
        },
        updatedAt: expect.any(Number),
      }),
    );
    const digestPatch = patch.mock.calls.find(([id]) => id === "packageSearchDigest:demo")?.[1];
    expect(digestPatch).not.toHaveProperty("softDeletedBy");
    expect(digestPatch).not.toHaveProperty("softDeletedByRole");
    expect(insert).toHaveBeenCalledWith(
      "auditLogs",
      expect.objectContaining({
        actorUserId: "users:owner",
        action: "package.undelete",
        targetId: "packages:demo",
        metadata: expect.objectContaining({
          ownerPublisherId: "publishers:org",
          releaseIds: ["packageReleases:demo-1", "packageReleases:demo-2"],
        }),
      }),
    );
  });

  it("does not restore owner-deleted releases with the whole package", async () => {
    const { ctx, patch } = makeSoftDeletePackageCtx({
      pkg: makePackageDoc({
        softDeletedAt: 123,
        softDeletedBy: "users:owner",
        softDeletedByRole: "user",
        latestReleaseId: undefined,
        latestVersionSummary: undefined,
        tags: {},
      }),
      releases: [
        makeReleaseDoc({
          _id: "packageReleases:ownerDeleted",
          version: "2.0.0",
          softDeletedAt: 100,
          ownerDeletedAt: 100,
          ownerDeletedBy: "users:owner",
          distTags: ["latest"],
          createdAt: 20,
        }),
        makeReleaseDoc({
          _id: "packageReleases:restorable",
          version: "1.0.0",
          softDeletedAt: 123,
          distTags: ["stable"],
          createdAt: 10,
        }),
      ],
    });

    const result = await restorePackageInternalHandler(ctx, {
      userId: "users:owner",
      name: "demo-plugin",
    });

    expect(result).toMatchObject({ ok: true, releaseCount: 1, alreadyRestored: false });
    expect(patch).not.toHaveBeenCalledWith("packageReleases:ownerDeleted", {
      softDeletedAt: undefined,
    });
    expect(patch).toHaveBeenCalledWith("packageReleases:restorable", {
      softDeletedAt: undefined,
    });
    expect(patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        latestReleaseId: "packageReleases:restorable",
        latestVersionSummary: expect.objectContaining({ version: "1.0.0" }),
      }),
    );
  });

  it("rejects owner restore for moderator-deleted packages", async () => {
    const { ctx, patch } = makeSoftDeletePackageCtx({
      pkg: makePackageDoc({
        ownerUserId: "users:org-linked",
        ownerPublisherId: "publishers:org",
        softDeletedAt: 123,
        softDeletedBy: "users:moderator",
        softDeletedByRole: "moderator",
      }),
      user: { _id: "users:owner", role: "user" },
      membership: { _id: "publisherMembers:1", role: "admin" },
    });

    await expect(
      restorePackageInternalHandler(ctx, {
        userId: "users:owner",
        name: "demo-plugin",
      }),
    ).rejects.toThrow(/^Forbidden:/i);

    expect(patch).not.toHaveBeenCalled();
  });

  it("rejects owner restore for packages with unknown delete provenance", async () => {
    const { ctx, patch } = makeSoftDeletePackageCtx({
      pkg: makePackageDoc({
        ownerUserId: "users:org-linked",
        ownerPublisherId: "publishers:org",
        softDeletedAt: 123,
        softDeletedBy: undefined,
        softDeletedByRole: undefined,
      }),
      user: { _id: "users:owner", role: "user" },
      membership: { _id: "publisherMembers:1", role: "admin" },
    });

    await expect(
      restorePackageInternalHandler(ctx, {
        userId: "users:owner",
        name: "demo-plugin",
      }),
    ).rejects.toThrow(/^Forbidden:/i);

    expect(patch).not.toHaveBeenCalled();
  });

  it("lets moderators restamp already-deleted package provenance", async () => {
    const { ctx, patch } = makeSoftDeletePackageCtx({
      pkg: makePackageDoc({
        ownerUserId: "users:owner",
        softDeletedAt: 123,
        softDeletedBy: "users:owner",
        softDeletedByRole: "user",
      }),
      user: { _id: "users:moderator", role: "moderator" },
    });

    await expect(
      softDeletePackageInternalHandler(ctx, {
        userId: "users:moderator",
        name: "demo-plugin",
      }),
    ).resolves.toMatchObject({ ok: true, alreadyDeleted: true });

    expect(patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        softDeletedBy: "users:moderator",
        softDeletedByRole: "moderator",
      }),
    );
  });

  it("preserves existing latest tags when restoring packages", async () => {
    const { ctx, patch } = makeSoftDeletePackageCtx({
      pkg: makePackageDoc({
        softDeletedAt: 123,
        softDeletedBy: "users:owner",
        softDeletedByRole: "user",
        latestReleaseId: "packageReleases:demo-1",
        tags: {
          latest: "packageReleases:demo-1",
          beta: "packageReleases:demo-2",
        },
      }),
      releases: [
        makeReleaseDoc({
          version: "1.0.0",
          softDeletedAt: 123,
          distTags: ["latest"],
          artifactKind: "legacy-zip",
          integritySha256: "a".repeat(64),
        }),
        makeReleaseDoc({
          _id: "packageReleases:demo-2",
          version: "2.0.0-beta.1",
          softDeletedAt: 123,
          distTags: ["beta"],
          createdAt: 2,
          artifactKind: "legacy-zip",
          integritySha256: "b".repeat(64),
        }),
      ],
    });

    await expect(
      restorePackageInternalHandler(ctx, {
        userId: "users:owner",
        name: "demo-plugin",
      }),
    ).resolves.toMatchObject({ ok: true, alreadyRestored: false });

    expect(patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        latestReleaseId: "packageReleases:demo-1",
        latestVersionSummary: expect.objectContaining({ version: "1.0.0" }),
        tags: {
          latest: "packageReleases:demo-1",
          beta: "packageReleases:demo-2",
        },
      }),
    );
    expect(patch).not.toHaveBeenCalledWith("packageReleases:demo-2", {
      distTags: ["beta", "latest"],
    });
  });

  it("syncs package search digest when packages are soft-deleted", async () => {
    const { ctx, patch } = makeSoftDeletePackageCtx({
      packageSearchDigest: {
        _id: "packageSearchDigest:demo",
        packageId: "packages:demo",
        softDeletedAt: undefined,
      },
    });

    await expect(
      softDeletePackageInternalHandler(ctx, {
        userId: "users:owner",
        name: "demo-plugin",
      }),
    ).resolves.toMatchObject({ ok: true, alreadyDeleted: false });

    expect(patch).toHaveBeenCalledWith(
      "packageSearchDigest:demo",
      expect.objectContaining({
        softDeletedAt: expect.any(Number),
        updatedAt: expect.any(Number),
      }),
    );
  });

  it("reserves private package placeholders without releases", async () => {
    const { ctx, insert } = makeReservePackageNameCtx();

    await expect(
      reservePackageNameInternalHandler(ctx, {
        actorUserId: "users:admin",
        ownerUserId: "users:openclaw",
        ownerPublisherId: "publishers:openclaw",
        name: " @openclaw/diffs ",
        reason: "reserve official plugin",
      }),
    ).resolves.toMatchObject({
      ok: true,
      action: "reserved",
      packageId: "packages:reserved",
      name: "@openclaw/diffs",
    });

    expect(insert).toHaveBeenCalledWith(
      "packages",
      expect.objectContaining({
        name: "@openclaw/diffs",
        normalizedName: "@openclaw/diffs",
        displayName: "@openclaw/diffs",
        ownerUserId: "users:openclaw",
        ownerPublisherId: "publishers:openclaw",
        family: "code-plugin",
        channel: "private",
        isOfficial: false,
        tags: {},
        stats: { downloads: 0, installs: 0, stars: 0, versions: 0 },
        recommendedScore: 170,
        recommendedScoreVersion: 4,
      }),
    );
    expect(insert).not.toHaveBeenCalledWith("packageReleases", expect.anything());
  });

  it("rejects reserving package names owned by another publisher", async () => {
    const { ctx } = makeReservePackageNameCtx({
      existing: makePackageDoc({
        ownerUserId: "users:other",
        ownerPublisherId: "publishers:other",
      }),
    });

    await expect(
      reservePackageNameInternalHandler(ctx, {
        actorUserId: "users:admin",
        ownerUserId: "users:openclaw",
        ownerPublisherId: "publishers:openclaw",
        name: "@openclaw/diffs",
      }),
    ).rejects.toThrow("Package already exists and belongs to another publisher");
  });

  it("lets admins transfer a package to the OpenClaw publisher and make it official", async () => {
    const { ctx, patch, insert } = makeTransferPackageOwnerCtx();

    await expect(
      transferPackageOwnerInternalHandler(ctx, {
        actorUserId: "users:admin",
        name: " demo-plugin ",
        ownerUserId: "users:openclaw",
        ownerPublisherId: "publishers:openclaw",
        channel: "official",
        reason: "move official plugin package under OpenClaw",
      }),
    ).resolves.toMatchObject({
      ok: true,
      packageId: "packages:demo",
      ownerPublisherId: "publishers:openclaw",
      channel: "official",
    });

    expect(patch).toHaveBeenCalledWith("packages:demo", {
      ownerUserId: "users:openclaw",
      ownerPublisherId: "publishers:openclaw",
      channel: "official",
      isOfficial: true,
      updatedAt: expect.any(Number),
    });
    expect(insert).toHaveBeenCalledWith(
      "auditLogs",
      expect.objectContaining({
        action: "package.owner.transfer",
        targetType: "package",
        targetId: "packages:demo",
        metadata: expect.objectContaining({
          name: "demo-plugin",
          previousOwnerUserId: "users:owner",
          nextOwnerUserId: "users:openclaw",
          nextOwnerPublisherId: "publishers:openclaw",
          previousChannel: "community",
          nextChannel: "official",
        }),
      }),
    );
  });

  it("lets package owners transfer legacy scoped plugins to the matching org without changing package identity", async () => {
    const trustedPublisher = {
      _id: "packageTrustedPublishers:opik",
      packageId: "packages:opik",
      provider: "github-actions",
      repository: "comet-ml/opik-openclaw",
      repositoryId: "1",
      repositoryOwner: "comet-ml",
      repositoryOwnerId: "2",
      workflowFilename: "publish-clawhub.yml",
    };
    const { ctx, patch, insert, pkg } = makeUserTransferPackageOwnerCtx({
      destinationMembershipRole: "owner",
      trustedPublisher,
    });

    await expect(
      transferPackageOwnerForUserInternalHandler(ctx, {
        actorUserId: "users:vincent",
        name: "@opik/opik-openclaw",
        toOwner: "opik",
      }),
    ).resolves.toMatchObject({
      ok: true,
      packageId: "packages:opik",
      name: "@opik/opik-openclaw",
      ownerPublisherId: "publishers:opik",
      channel: "community",
    });

    expect(patch).toHaveBeenCalledWith("packages:opik", {
      ownerUserId: "users:vincent",
      ownerPublisherId: "publishers:opik",
      channel: "community",
      isOfficial: false,
      updatedAt: expect.any(Number),
    });
    expect(patch).toHaveBeenCalledWith(
      "packageSearchDigest:opik",
      expect.objectContaining({
        ownerUserId: "users:vincent",
        ownerPublisherId: "publishers:opik",
        channel: "community",
        isOfficial: false,
      }),
    );
    expect(patch).not.toHaveBeenCalledWith(
      "packages:opik",
      expect.objectContaining({ stats: expect.anything() }),
    );
    expect((pkg as { stats?: unknown }).stats).toEqual({
      downloads: 42,
      installs: 7,
      stars: 3,
      versions: 1,
    });
    expect(insert).toHaveBeenCalledWith(
      "auditLogs",
      expect.objectContaining({
        action: "package.owner.transfer",
        targetId: "packages:opik",
        metadata: expect.objectContaining({
          name: "@opik/opik-openclaw",
          previousOwnerPublisherId: "publishers:vincent",
          nextOwnerPublisherId: "publishers:opik",
        }),
      }),
    );
  });

  it("rejects user package transfers without source admin access", async () => {
    const { ctx } = makeUserTransferPackageOwnerCtx({
      pkg: makePackageDoc({
        name: "@opik/opik-openclaw",
        normalizedName: "@opik/opik-openclaw",
        ownerUserId: "users:someoneelse",
        ownerPublisherId: "publishers:source-org",
      }),
      sourceMembershipRole: "publisher",
      destinationMembershipRole: "owner",
    });

    await expect(
      transferPackageOwnerForUserInternalHandler(ctx, {
        actorUserId: "users:vincent",
        name: "@opik/opik-openclaw",
        toOwner: "opik",
      }),
    ).rejects.toThrow("Forbidden");
  });

  it("rejects user package transfers through stale personal-publisher memberships", async () => {
    const { ctx } = makeUserTransferPackageOwnerCtx({
      pkg: makePackageDoc({
        name: "@owner/demo",
        normalizedName: "@owner/demo",
        ownerUserId: "users:owner",
        ownerPublisherId: "publishers:vincent",
      }),
      sourcePublisher: {
        _id: "publishers:vincent",
        kind: "user",
        handle: "owner",
        linkedUserId: "users:owner",
      },
      sourceMembershipRole: "admin",
      destinationMembershipRole: "owner",
    });

    await expect(
      transferPackageOwnerForUserInternalHandler(ctx, {
        actorUserId: "users:vincent",
        name: "demo-plugin",
        toOwner: "opik",
      }),
    ).rejects.toThrow("Forbidden");
  });

  it("lets owners transfer packages from legacy personal publishers without linked users", async () => {
    const { ctx } = makeUserTransferPackageOwnerCtx({
      sourcePublisher: {
        _id: "publishers:vincent",
        kind: "user",
        handle: "vincentkoc",
        linkedUserId: undefined,
      },
      sourceMembershipRole: null,
      destinationMembershipRole: "owner",
    });

    await expect(
      transferPackageOwnerForUserInternalHandler(ctx, {
        actorUserId: "users:vincent",
        name: "@opik/opik-openclaw",
        toOwner: "opik",
      }),
    ).resolves.toMatchObject({
      ok: true,
      ownerUserId: "users:vincent",
      ownerPublisherId: "publishers:opik",
    });
  });

  it("rejects package transfers through stale no-link personal memberships", async () => {
    const { ctx } = makeUserTransferPackageOwnerCtx({
      pkg: makePackageDoc({
        name: "@owner/demo",
        normalizedName: "@owner/demo",
        ownerUserId: "users:owner",
        ownerPublisherId: "publishers:vincent",
      }),
      sourcePublisher: {
        _id: "publishers:vincent",
        kind: "user",
        handle: "owner",
        linkedUserId: undefined,
      },
      sourceMembershipRole: "admin",
      destinationMembershipRole: "owner",
    });

    await expect(
      transferPackageOwnerForUserInternalHandler(ctx, {
        actorUserId: "users:vincent",
        name: "demo-plugin",
        toOwner: "opik",
      }),
    ).rejects.toThrow("Forbidden");
  });

  it("rejects package transfer destinations through stale no-link personal memberships", async () => {
    const { ctx } = makeUserTransferPackageOwnerCtx({
      destinationPublisher: {
        _id: "publishers:opik",
        kind: "user",
        handle: "opik",
        linkedUserId: undefined,
      },
      destinationMembershipRole: "admin",
    });

    await expect(
      transferPackageOwnerForUserInternalHandler(ctx, {
        actorUserId: "users:vincent",
        name: "@opik/opik-openclaw",
        toOwner: "opik",
      }),
    ).rejects.toThrow('admin access for "@opik"');
  });

  it("rejects user package transfers without destination admin access", async () => {
    const { ctx } = makeUserTransferPackageOwnerCtx({ destinationMembershipRole: "publisher" });

    await expect(
      transferPackageOwnerForUserInternalHandler(ctx, {
        actorUserId: "users:vincent",
        name: "@opik/opik-openclaw",
        toOwner: "opik",
      }),
    ).rejects.toThrow('admin access for "@opik"');
  });

  it("rejects scoped package transfers to a mismatched destination", async () => {
    const { ctx } = makeUserTransferPackageOwnerCtx({ destinationMembershipRole: "owner" });

    await expect(
      transferPackageOwnerForUserInternalHandler(ctx, {
        actorUserId: "users:vincent",
        name: "@opik/opik-openclaw",
        toOwner: "otherorg",
      }),
    ).rejects.toThrow('Package scope "@opik" can only be transferred to publisher "@opik"');
  });

  it("rejects user package transfers to missing publishers with clear guidance", async () => {
    const { ctx } = makeUserTransferPackageOwnerCtx({
      destinationPublisher: null,
    });

    await expect(
      transferPackageOwnerForUserInternalHandler(ctx, {
        actorUserId: "users:vincent",
        name: "@opik/opik-openclaw",
        toOwner: "opik",
      }),
    ).rejects.toThrow('Create the "@opik" organization');
  });

  it("lets admins repair a package name and runtime id with an audit trail", async () => {
    const { ctx, patch, insert } = makeTransferPackageOwnerCtx({
      pkg: makePackageDoc({
        name: "whatsapp",
        normalizedName: "whatsapp",
        runtimeId: "whatsapp",
      }),
    });

    await expect(
      repairPackageIdentityInternalHandler(ctx, {
        actorUserId: "users:admin",
        name: "whatsapp",
        nextName: "ivangdavila-whatsapp",
        nextRuntimeId: "ivangdavila-whatsapp",
        reason: "free official OpenClaw WhatsApp package id",
      }),
    ).resolves.toMatchObject({
      ok: true,
      packageId: "packages:demo",
      name: "ivangdavila-whatsapp",
      runtimeId: "ivangdavila-whatsapp",
    });

    expect(patch).toHaveBeenCalledWith("packages:demo", {
      name: "ivangdavila-whatsapp",
      normalizedName: "ivangdavila-whatsapp",
      runtimeId: "ivangdavila-whatsapp",
      updatedAt: expect.any(Number),
    });
    expect(patch).toHaveBeenCalledWith(
      "packageSearchDigest:demo",
      expect.objectContaining({
        name: "ivangdavila-whatsapp",
        normalizedName: "ivangdavila-whatsapp",
        runtimeId: "ivangdavila-whatsapp",
      }),
    );
    expect(insert).toHaveBeenCalledWith(
      "auditLogs",
      expect.objectContaining({
        action: "package.identity.repair",
        targetType: "package",
        targetId: "packages:demo",
        metadata: expect.objectContaining({
          previousName: "whatsapp",
          nextName: "ivangdavila-whatsapp",
          previousRuntimeId: "whatsapp",
          nextRuntimeId: "ivangdavila-whatsapp",
        }),
      }),
    );
  });

  it("rejects official package transfers to non-official publishers", async () => {
    const { ctx } = makeTransferPackageOwnerCtx({
      ownerPublisher: {
        _id: "publishers:openclaw",
        kind: "org",
        handle: "other",
        displayName: "Other",
      },
    });

    await expect(
      transferPackageOwnerInternalHandler(ctx, {
        actorUserId: "users:admin",
        name: "demo-plugin",
        ownerUserId: "users:openclaw",
        ownerPublisherId: "publishers:openclaw",
        channel: "official",
      }),
    ).rejects.toThrow("Only official publishers may own official packages");
  });

  it("lets owners publish real releases into reserved package placeholders", async () => {
    const ctx = makeInsertReleaseCtx(
      makePackageDoc({
        name: "@openclaw/diffs",
        normalizedName: "@openclaw/diffs",
        ownerUserId: "users:openclaw",
        ownerPublisherId: "publishers:openclaw",
        family: "bundle-plugin",
        channel: "private",
        isOfficial: false,
        latestReleaseId: undefined,
        latestVersionSummary: undefined,
        tags: {},
        stats: { downloads: 0, installs: 0, stars: 0, versions: 0 },
      }),
      [],
      {
        "users:admin": {
          _id: "users:admin",
          role: "admin",
          trustedPublisher: false,
        },
        "users:openclaw": {
          _id: "users:openclaw",
          role: "user",
          trustedPublisher: false,
        },
        "publishers:openclaw": {
          _id: "publishers:openclaw",
          kind: "org",
          handle: "openclaw",
          displayName: "OpenClaw",
          trustedPublisher: true,
        },
      },
    );

    await insertReleaseInternalHandler(ctx, {
      actorUserId: "users:admin",
      ownerUserId: "users:openclaw",
      ownerPublisherId: "publishers:openclaw",
      name: "@openclaw/diffs",
      displayName: "@openclaw/diffs",
      family: "code-plugin",
      version: "1.0.0",
      changelog: "init",
      tags: ["latest"],
      summary: "diff tools",
      files: [],
      integritySha256: "abc123",
    });

    expect(ctx.patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        latestReleaseId: "packageReleases:new",
        tags: { latest: "packageReleases:new" },
        stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
      }),
    );
  });

  it("rejects legacy OpenClaw authorization inside the release mutation", async () => {
    const pkg = makePackageDoc({ family: "bundle-plugin" });
    const token = {
      _id: "packagePublishTokens:legacy",
      packageId: pkg._id,
      version: "1.0.0",
      provider: "github-actions",
      repository: "openclaw/openclaw",
      repositoryId: "1",
      repositoryOwner: "openclaw",
      repositoryOwnerId: "2",
      workflowFilename: "plugin-clawhub-release.yml",
      environment: "clawhub-release",
      expiresAt: Date.now() + 60_000,
    };
    const ctx = makeInsertReleaseCtx(pkg, [], {
      [token._id]: token,
    });

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:owner",
        ownerUserId: "users:owner",
        name: pkg.name,
        displayName: pkg.displayName,
        family: "bundle-plugin",
        version: token.version,
        changelog: "legacy release",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
        publicationStatus: "pending",
        trustedPublishTokenId: token._id,
      }),
    ).rejects.toThrow("OpenClaw trusted publishes require authorization version 2");

    expect(ctx.insert).not.toHaveBeenCalled();
    expect(ctx.patch).not.toHaveBeenCalled();
  });

  it("atomically consumes a v2 trusted publish capability with the release insert", async () => {
    const inventoryDigest = "d".repeat(64);
    const pkg = makePackageDoc({ family: "bundle-plugin" });
    const token = {
      _id: "packagePublishTokens:1",
      packageId: pkg._id,
      version: "1.0.0",
      provider: "github-actions",
      repository: "openclaw/openclaw",
      repositoryId: "1",
      repositoryOwner: "openclaw",
      repositoryOwnerId: "2",
      workflowFilename: "plugin-clawhub-release.yml",
      environment: "clawhub-release",
      runId: "100",
      runAttempt: "1",
      sha: "c".repeat(40),
      ref: "refs/tags/release-publish/tooling",
      scope: "publish",
      inventoryDigest,
      authorizationVersion: 2,
      authorizationTransactionKey: "exact-transaction",
      authorizationKey: "exact-transaction:publish",
      expiresAt: Date.now() + 60_000,
    };
    const trustedPublisher = {
      _id: "packageTrustedPublishers:1",
      packageId: pkg._id,
      provider: token.provider,
      repository: token.repository,
      repositoryId: token.repositoryId,
      repositoryOwner: token.repositoryOwner,
      repositoryOwnerId: token.repositoryOwnerId,
      workflowFilename: token.workflowFilename,
      environment: token.environment,
    };
    const ctx = makeInsertReleaseCtx(pkg, [], {
      "users:owner": { _id: "users:owner", role: "user" },
      [token._id]: token,
      [trustedPublisher._id]: trustedPublisher,
    });
    const args = {
      actorUserId: "users:owner",
      ownerUserId: "users:owner",
      publishActor: {
        kind: "github-actions" as const,
        repository: token.repository,
        workflow: token.workflowFilename,
        runId: token.runId,
        runAttempt: token.runAttempt,
        sha: token.sha,
      },
      name: pkg.name,
      displayName: pkg.displayName,
      family: "bundle-plugin" as const,
      version: token.version,
      changelog: "authorized release",
      tags: ["latest"],
      summary: "demo",
      files: [],
      integritySha256: "abc123",
      publicationStatus: "pending" as const,
      trustedPublishTokenId: token._id,
      trustedPublishInventoryDigest: inventoryDigest,
    };

    await expect(insertReleaseInternalHandler(ctx, args)).resolves.toMatchObject({
      ok: true,
      packageId: pkg._id,
      releaseId: "packageReleases:new",
      publicationStatus: "pending",
    });
    expect(ctx.patch).toHaveBeenCalledWith(token._id, {
      consumedAt: expect.any(Number),
    });
    expect(ctx.insert).toHaveBeenCalledWith(
      "packageReleases",
      expect.objectContaining({
        publicationStatus: "pending",
        pendingPublication: expect.objectContaining({
          trustedPublishTokenId: token._id,
          trustedPublishInventoryDigest: inventoryDigest,
          trustedPublishAuthorizationVersion: 2,
        }),
      }),
    );

    await expect(insertReleaseInternalHandler(ctx, args)).rejects.toThrow(
      "Trusted publish authorization is missing, expired, or consumed",
    );
  });

  it("creates pending package releases without updating public latest pointers", async () => {
    const existingPackage = makePackageDoc({
      latestReleaseId: "packageReleases:old",
      latestVersionSummary: { version: "1.0.0" },
      tags: { latest: "packageReleases:old" },
      stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
    });
    const priorRelease = makeReleaseDoc({
      _id: "packageReleases:old",
      version: "1.0.0",
      distTags: ["latest"],
    });
    const ctx = makeInsertReleaseCtx(existingPackage, [priorRelease]);

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:owner",
        ownerUserId: "users:owner",
        name: "demo-plugin",
        displayName: "Demo Plugin",
        family: "code-plugin",
        version: "2.0.0",
        publicationStatus: "pending",
        changelog: "next",
        tags: ["latest"],
        summary: "pending summary",
        files: [],
        integritySha256: "pending-sha",
      }),
    ).resolves.toMatchObject({
      ok: true,
      packageId: "packages:demo",
      releaseId: "packageReleases:new",
      publicationStatus: "pending",
      createdNewParent: false,
    });

    expect(ctx.insert).toHaveBeenCalledWith(
      "packageReleases",
      expect.objectContaining({
        publicationStatus: "pending",
        pendingPublication: expect.objectContaining({
          tags: ["latest"],
          displayName: "Demo Plugin",
        }),
      }),
    );
    expect(ctx.patch).not.toHaveBeenCalledWith("packages:demo", expect.anything());
    expect(ctx.patch).not.toHaveBeenCalledWith("packageReleases:old", expect.anything());
  });

  it("publishes a pending package release by promoting the existing row", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const existingPackage = makePackageDoc({
      latestReleaseId: "packageReleases:old",
      latestVersionSummary: { version: "1.0.0" },
      tags: { latest: "packageReleases:old" },
      stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
    });
    const priorRelease = makeReleaseDoc({
      _id: "packageReleases:old",
      version: "1.0.0",
      distTags: ["latest"],
      publicationStatus: "published",
    });
    const pendingRelease = makeReleaseDoc({
      _id: "packageReleases:pending",
      version: "2.0.0",
      publicationStatus: "pending",
      pendingPublication: {
        displayName: "Demo Plugin",
        tags: ["latest"],
        channel: "community",
        isOfficial: false,
      },
      distTags: ["latest"],
      summary: "pending summary",
      changelog: "next",
      integritySha256: "pending-sha",
      verification: { scanStatus: "pending" },
      llmAnalysis: {
        status: "clean",
        verdict: "clean",
        checkedAt: 1_700_000_000_000,
      },
    });
    const ctx = makeInsertReleaseCtx(existingPackage, [priorRelease, pendingRelease], {
      "packageReleases:pending": pendingRelease,
      "packages:demo": existingPackage,
    });

    await expect(
      publishPendingReleaseInternalHandler(ctx, {
        releaseId: "packageReleases:pending",
      }),
    ).resolves.toEqual({
      ok: true,
      packageId: "packages:demo",
      releaseId: "packageReleases:pending",
    });

    expect(ctx.patch).toHaveBeenCalledWith("packageReleases:pending", {
      publicationStatus: "published",
      pendingPublication: undefined,
      distTags: ["latest"],
      verification: { scanStatus: "clean" },
    });
    await flushScheduledPackageReleaseTagCleanup(ctx);
    expect(ctx.patch).toHaveBeenCalledWith("packageReleases:old", { distTags: [] });
    expect(ctx.patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        latestReleaseId: "packageReleases:pending",
        latestVersionSummary: expect.objectContaining({ version: "2.0.0" }),
        tags: { latest: "packageReleases:pending" },
        stats: { downloads: 0, installs: 0, stars: 0, versions: 2 },
        scanStatus: "clean",
      }),
    );
  });

  it("atomically revalidates staged v2 authorization during public promotion", async () => {
    const inventoryDigest = "d".repeat(64);
    const buildCtx = (options?: { revoked?: boolean; rotated?: boolean }) => {
      const pkg = makePackageDoc({ family: "bundle-plugin" });
      const token = {
        _id: "packagePublishTokens:v2",
        packageId: pkg._id,
        version: "2.0.0",
        provider: "github-actions",
        repository: "openclaw/openclaw",
        repositoryId: "1",
        repositoryOwner: "openclaw",
        repositoryOwnerId: "2",
        workflowFilename: "plugin-clawhub-release.yml",
        environment: "clawhub-release",
        runId: "100",
        runAttempt: "1",
        sha: "c".repeat(40),
        ref: "refs/tags/release-publish/tooling",
        scope: "publish",
        inventoryDigest,
        authorizationVersion: 2,
        consumedAt: 1_700_000_000_000,
        revokedAt: options?.revoked ? 1_700_000_000_001 : undefined,
        expiresAt: 1_700_000_000_000,
      };
      const trustedPublisher = {
        _id: "packageTrustedPublishers:1",
        packageId: pkg._id,
        provider: token.provider,
        repository: options?.rotated ? "openclaw/rotated" : token.repository,
        repositoryId: token.repositoryId,
        repositoryOwner: token.repositoryOwner,
        repositoryOwnerId: token.repositoryOwnerId,
        workflowFilename: token.workflowFilename,
        environment: token.environment,
      };
      const pendingRelease = makeReleaseDoc({
        _id: "packageReleases:pending-v2",
        packageId: pkg._id,
        version: token.version,
        publicationStatus: "pending",
        pendingPublication: {
          displayName: "Demo Plugin",
          tags: ["latest"],
          channel: "community",
          isOfficial: false,
          trustedPublishTokenId: token._id,
          trustedPublishInventoryDigest: inventoryDigest,
          trustedPublishAuthorizationVersion: 2,
        },
      });
      return {
        ctx: makeInsertReleaseCtx(pkg, [pendingRelease], {
          [pkg._id]: pkg,
          [pendingRelease._id]: pendingRelease,
          [token._id]: token,
          [trustedPublisher._id]: trustedPublisher,
        }),
        releaseId: pendingRelease._id,
      };
    };

    const valid = buildCtx();
    await expect(
      publishPendingReleaseInternalHandler(valid.ctx, {
        releaseId: valid.releaseId,
        trustedPublishTokenId: "packagePublishTokens:v2",
        trustedPublishInventoryDigest: inventoryDigest,
        trustedPublishAuthorizationVersion: 2,
      }),
    ).resolves.toMatchObject({ ok: true, releaseId: valid.releaseId });
    expect(valid.ctx.patch).toHaveBeenCalledWith(
      valid.releaseId,
      expect.objectContaining({ publicationStatus: "published" }),
    );

    const revoked = buildCtx({ revoked: true });
    await expect(
      publishPendingReleaseInternalHandler(revoked.ctx, {
        releaseId: revoked.releaseId,
        trustedPublishTokenId: "packagePublishTokens:v2",
        trustedPublishInventoryDigest: inventoryDigest,
        trustedPublishAuthorizationVersion: 2,
      }),
    ).rejects.toThrow("Staged OpenClaw publish authorization no longer matches the release");
    expect(revoked.ctx.patch).not.toHaveBeenCalled();

    const rotated = buildCtx({ rotated: true });
    await expect(
      publishPendingReleaseInternalHandler(rotated.ctx, {
        releaseId: rotated.releaseId,
        trustedPublishTokenId: "packagePublishTokens:v2",
        trustedPublishInventoryDigest: inventoryDigest,
        trustedPublishAuthorizationVersion: 2,
      }),
    ).rejects.toThrow(
      "Trusted publish authorization no longer matches the current trusted publisher",
    );
    expect(rotated.ctx.patch).not.toHaveBeenCalled();

    const missingCallerBinding = buildCtx();
    await expect(
      publishPendingReleaseInternalHandler(missingCallerBinding.ctx, {
        releaseId: missingCallerBinding.releaseId,
      }),
    ).rejects.toThrow("Staged OpenClaw publish authorization no longer matches the release");
    expect(missingCallerBinding.ctx.patch).not.toHaveBeenCalled();
  });

  it("keeps the current latest when finalizing an older package release", async () => {
    const existingPackage = makePackageDoc({
      latestReleaseId: "packageReleases:latest",
      latestVersionSummary: { version: "2.0.0" },
      tags: { latest: "packageReleases:latest" },
      summary: "current summary",
      stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
    });
    const latestRelease = makeReleaseDoc({
      _id: "packageReleases:latest",
      version: "2.0.0",
      distTags: ["latest"],
      publicationStatus: "published",
    });
    const pendingRelease = makeReleaseDoc({
      _id: "packageReleases:pending",
      version: "1.0.1",
      publicationStatus: "pending",
      pendingPublication: {
        displayName: "Demo Plugin v1",
        tags: ["latest", "v1"],
        channel: "community",
        isOfficial: false,
      },
      distTags: ["latest", "v1"],
      summary: "backport summary",
      changelog: "backport",
      integritySha256: "backport-sha",
      verification: { scanStatus: "pending" },
      llmAnalysis: {
        status: "clean",
        verdict: "clean",
        checkedAt: 1_700_000_000_000,
      },
    });
    const ctx = makeInsertReleaseCtx(existingPackage, [latestRelease, pendingRelease], {
      "packageReleases:latest": latestRelease,
      "packageReleases:pending": pendingRelease,
      "packages:demo": existingPackage,
    });

    await publishPendingReleaseInternalHandler(ctx, {
      releaseId: "packageReleases:pending",
    });

    expect(ctx.patch).toHaveBeenCalledWith(
      "packageReleases:pending",
      expect.objectContaining({
        publicationStatus: "published",
        distTags: ["v1"],
      }),
    );
    expect(ctx.patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        latestReleaseId: "packageReleases:latest",
        latestVersionSummary: { version: "2.0.0" },
        summary: "current summary",
        tags: {
          latest: "packageReleases:latest",
          v1: "packageReleases:pending",
        },
        stats: { downloads: 0, installs: 0, stars: 0, versions: 2 },
      }),
    );
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });

  it("publishes a pending release without reading its file-heavy release history", async () => {
    const priorRelease = makeReleaseDoc({
      _id: "packageReleases:old",
      version: "1.0.0",
      distTags: ["latest"],
      publicationStatus: "published",
      extractedPackageJson: {
        description: "x".repeat(190_000),
      },
    });
    const unrelatedReleases = Array.from({ length: 91 }, (_, index) =>
      makeReleaseDoc({
        _id: `packageReleases:history-${index}`,
        version: `0.0.${index}`,
        distTags: [],
        publicationStatus: "published",
        extractedPackageJson: {
          description: "x".repeat(190_000),
        },
      }),
    );
    const pendingRelease = makeReleaseDoc({
      _id: "packageReleases:pending",
      version: "2.0.0",
      publicationStatus: "pending",
      pendingPublication: {
        displayName: "Demo Plugin",
        tags: ["latest"],
        channel: "community",
        isOfficial: false,
      },
      distTags: ["latest"],
      summary: "pending summary",
      changelog: "next",
      integritySha256: "pending-sha",
      verification: { scanStatus: "pending" },
      llmAnalysis: {
        status: "clean",
        verdict: "clean",
        checkedAt: 1_700_000_000_000,
      },
    });
    const existingPackage = makePackageDoc({
      latestReleaseId: "packageReleases:old",
      latestVersionSummary: { version: "1.0.0" },
      tags: { latest: "packageReleases:old" },
      stats: { downloads: 0, installs: 0, stars: 0, versions: 92 },
    });
    const allReleases = [priorRelease, ...unrelatedReleases, pendingRelease];
    const ctx = makeInsertReleaseCtx(
      existingPackage,
      allReleases,
      {
        "packageReleases:old": priorRelease,
        "packageReleases:pending": pendingRelease,
        "packages:demo": existingPackage,
      },
      [],
      undefined,
      16 * 1024 * 1024,
    );

    await expect(
      publishPendingReleaseInternalHandler(ctx, {
        releaseId: "packageReleases:pending",
      }),
    ).resolves.toEqual({
      ok: true,
      packageId: "packages:demo",
      releaseId: "packageReleases:pending",
    });

    await flushScheduledPackageReleaseTagCleanup(ctx);
    expect(ctx.patch).toHaveBeenCalledWith("packageReleases:old", { distTags: [] });
    expect(ctx.patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        latestReleaseId: "packageReleases:pending",
        tags: { latest: "packageReleases:pending" },
        stats: { downloads: 0, installs: 0, stars: 0, versions: 93 },
      }),
    );
  });

  it("publishes a pending release without hydrating every file-heavy tag owner", async () => {
    const tagNames = ["latest", ...Array.from({ length: 89 }, (_, index) => `tag-${index}`)];
    const priorReleases = tagNames.map((tag, index) =>
      makeReleaseDoc({
        _id: `packageReleases:old-${index}`,
        version: `1.0.${index}`,
        distTags: [tag],
        publicationStatus: "published",
        extractedPackageJson: {
          description: "x".repeat(190_000),
        },
      }),
    );
    const pendingRelease = makeReleaseDoc({
      _id: "packageReleases:pending",
      version: "2.0.0",
      publicationStatus: "pending",
      pendingPublication: {
        displayName: "Demo Plugin",
        tags: tagNames,
        channel: "community",
        isOfficial: false,
      },
      distTags: tagNames,
      summary: "pending summary",
      changelog: "next",
      integritySha256: "pending-sha",
      verification: { scanStatus: "pending" },
      llmAnalysis: {
        status: "clean",
        verdict: "clean",
        checkedAt: 1_700_000_000_000,
      },
    });
    const packageTags = Object.fromEntries(
      tagNames.map((tag, index) => [tag, `packageReleases:old-${index}`]),
    );
    const existingPackage = makePackageDoc({
      latestReleaseId: "packageReleases:old-0",
      latestVersionSummary: { version: "1.0.0" },
      tags: packageTags,
      stats: { downloads: 0, installs: 0, stars: 0, versions: priorReleases.length },
    });
    const recordsById: Record<string, Record<string, unknown>> = Object.fromEntries(
      [...priorReleases, pendingRelease].map((release) => [release._id, release]),
    );
    recordsById["packages:demo"] = existingPackage;
    const ctx = makeInsertReleaseCtx(
      existingPackage,
      [...priorReleases, pendingRelease],
      recordsById,
      [],
      undefined,
      16 * 1024 * 1024,
    );

    await expect(
      publishPendingReleaseInternalHandler(ctx, {
        releaseId: "packageReleases:pending",
      }),
    ).resolves.toEqual({
      ok: true,
      packageId: "packages:demo",
      releaseId: "packageReleases:pending",
    });

    expect(ctx.scheduler.runAfter).toHaveBeenCalledOnce();
    expect(ctx.patch).not.toHaveBeenCalledWith(
      expect.stringMatching(/^packageReleases:old-/),
      expect.anything(),
    );
    await flushScheduledPackageReleaseTagCleanup(ctx);
    expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(23);
    expect(
      ctx.patch.mock.calls.filter(([id]) => id.startsWith("packageReleases:old-")),
    ).toHaveLength(90);
  });

  it("keeps a dist-tag when a later publish moves it back before cleanup runs", async () => {
    const priorRelease = makeReleaseDoc({
      _id: "packageReleases:old",
      distTags: ["latest"],
      publicationStatus: "published",
    });
    const pkg = makePackageDoc({
      latestReleaseId: "packageReleases:old",
      tags: { latest: "packageReleases:old" },
    });
    const ctx = makeInsertReleaseCtx(pkg, [priorRelease]);

    await cleanupReassignedPackageReleaseTagsInternalHandler(ctx, {
      packageId: "packages:demo",
      assignments: [{ releaseId: "packageReleases:old", tags: ["latest"] }],
    });

    expect(ctx.patch).not.toHaveBeenCalledWith("packageReleases:old", expect.anything());
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });

  it("releases release-backed finalization claims when pending promotion fails", async () => {
    const promotionError = new Error("promotion failed");
    const runMutation = vi.fn(async (_ref: unknown, args: unknown) => {
      if (typeof args === "object" && args !== null && "attemptId" in args && !("error" in args)) {
        return {
          status: "claimed",
          attemptId: "publishAttempts:demo",
          packageId: "packages:demo",
          releaseId: "packageReleases:pending",
          packageFollowup: {},
        };
      }
      if (typeof args === "object" && args !== null && "releaseId" in args) {
        throw promotionError;
      }
      if (typeof args === "object" && args !== null && "error" in args) {
        return { attemptId: "publishAttempts:demo", status: "ready_to_finalize" };
      }
      throw new Error(`Unexpected mutation args ${JSON.stringify(args)}`);
    });
    const ctx = {
      runMutation,
      runQuery: vi.fn(async () => {
        throw new Error("legacy insert recovery should not run for release-backed attempts");
      }),
    };

    await expect(
      finalizePackagePublishAttemptInternalHandler(ctx as never, {
        attemptId: "publishAttempts:demo",
      }),
    ).rejects.toThrow("promotion failed");

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ releaseId: "packageReleases:pending" }),
    );
    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        attemptId: "publishAttempts:demo",
        error: "promotion failed",
      }),
    );
    expect(ctx.runQuery).not.toHaveBeenCalled();
  });

  it("rejects staged legacy OpenClaw attempts before public promotion", async () => {
    const runMutation = vi.fn(async (_ref: unknown, args: unknown) => {
      if (typeof args === "object" && args !== null && "attemptId" in args && !("error" in args)) {
        return {
          status: "claimed",
          attemptId: "publishAttempts:demo",
          packageId: "packages:demo",
          releaseId: "packageReleases:pending",
          packageFollowup: {
            packageName: "demo-plugin",
            version: "1.0.0",
            trustedPublishTokenId: "packagePublishTokens:legacy",
          },
        };
      }
      if (typeof args === "object" && args !== null && "error" in args) {
        return { attemptId: "publishAttempts:demo", status: "ready_to_finalize" };
      }
      throw new Error(`Unexpected mutation args ${JSON.stringify(args)}`);
    });
    const ctx = {
      runMutation,
      runQuery: vi.fn(async () => ({
        _id: "packagePublishTokens:legacy",
        repository: "openclaw/openclaw",
      })),
    };

    await expect(
      finalizePackagePublishAttemptInternalHandler(ctx as never, {
        attemptId: "publishAttempts:demo",
      }),
    ).rejects.toThrow("OpenClaw trusted publishes require authorization version 2");

    expect(runMutation).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ releaseId: "packageReleases:pending" }),
    );
    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        attemptId: "publishAttempts:demo",
        error: "OpenClaw trusted publishes require authorization version 2",
      }),
    );
    expect(ctx.runQuery).toHaveBeenCalledOnce();
  });

  it("keeps v2 releases pending until the exact parent succeeds", async () => {
    const inventoryDigest = "d".repeat(64);
    const token = {
      _id: "packagePublishTokens:v2",
      packageId: "packages:demo",
      version: "1.0.0",
      provider: "github-actions",
      repository: "openclaw/openclaw",
      repositoryId: "1",
      repositoryOwner: "openclaw",
      repositoryOwnerId: "2",
      workflowFilename: "plugin-clawhub-release.yml",
      environment: "clawhub-release",
      runId: "100",
      runAttempt: "1",
      sha: "c".repeat(40),
      ref: "refs/tags/release-publish/tooling",
      scope: "publish",
      inventoryDigest,
      authorizationVersion: 2,
      authorizationRoute: "automated-awaited",
      authorizationTransactionKey: "exact-transaction",
      authorizationKey: "exact-transaction:publish",
      authorizationArtifactId: "101",
      authorizationArtifactDigest: `sha256:${"a".repeat(64)}`,
      trustedToolingIdentityJson: '{"version":2}',
      candidateRepository: "openclaw/openclaw",
      candidateSha: "b".repeat(40),
      parentRepository: "openclaw/openclaw",
      parentWorkflow: ".github/workflows/openclaw-release-publish.yml",
      parentRunId: "99",
      parentRunAttempt: "1",
      consumedAt: Date.now(),
      expiresAt: Date.now() - 1,
    };
    const runMutation = vi.fn(async (_ref: unknown, args: unknown) => {
      if (typeof args === "object" && args !== null && "attemptId" in args && !("error" in args)) {
        return {
          status: "claimed",
          attemptId: "publishAttempts:demo",
          packageId: "packages:demo",
          releaseId: "packageReleases:pending",
          packageFollowup: {
            packageName: "demo-plugin",
            version: "1.0.0",
            trustedPublishTokenId: token._id,
            trustedPublishInventoryDigest: inventoryDigest,
            trustedPublishAuthorizationVersion: 2,
          },
        };
      }
      if (typeof args === "object" && args !== null && "error" in args) {
        return { attemptId: "publishAttempts:demo", status: "ready_to_finalize" };
      }
      throw new Error(`Unexpected mutation args ${JSON.stringify(args)}`);
    });
    const ctx = {
      runMutation,
      runQuery: vi.fn(async () => token),
    };
    vi.mocked(verifyOpenClawPublishAuthorization).mockRejectedValue(
      new Error("OpenClaw release parent is not terminal; public publication remains pending"),
    );

    await expect(
      finalizePackagePublishAttemptInternalHandler(ctx as never, {
        attemptId: "publishAttempts:demo",
      }),
    ).rejects.toThrow("public publication remains pending");

    expect(verifyOpenClawPublishAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: "demo-plugin",
        version: "1.0.0",
        inventoryDigest,
        requiredParentState: "terminal",
      }),
    );
    expect(runMutation).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ releaseId: "packageReleases:pending" }),
    );
  });

  it("publishes a staged v2 release only after terminal parent authorization", async () => {
    const inventoryDigest = "d".repeat(64);
    const token = {
      _id: "packagePublishTokens:v2",
      packageId: "packages:demo",
      version: "1.0.0",
      provider: "github-actions",
      repository: "openclaw/openclaw",
      repositoryId: "1",
      repositoryOwner: "openclaw",
      repositoryOwnerId: "2",
      workflowFilename: "plugin-clawhub-release.yml",
      environment: "clawhub-release",
      runId: "100",
      runAttempt: "1",
      sha: "c".repeat(40),
      ref: "refs/tags/release-publish/tooling",
      scope: "publish",
      inventoryDigest,
      authorizationVersion: 2,
      authorizationRoute: "automated-awaited",
      authorizationTransactionKey: "exact-transaction",
      authorizationKey: "exact-transaction:publish",
      authorizationArtifactId: "101",
      authorizationArtifactDigest: `sha256:${"a".repeat(64)}`,
      trustedToolingIdentityJson: '{"version":2}',
      candidateRepository: "openclaw/openclaw",
      candidateSha: "b".repeat(40),
      parentRepository: "openclaw/openclaw",
      parentWorkflow: ".github/workflows/openclaw-release-publish.yml",
      parentRunId: "99",
      parentRunAttempt: "1",
      consumedAt: Date.now(),
      expiresAt: Date.now() - 1,
    };
    const authorization = {
      identity: {
        candidateRepository: token.candidateRepository,
        candidateSha: token.candidateSha,
        parentRepository: token.parentRepository,
        parentWorkflow: token.parentWorkflow,
        parentRunId: token.parentRunId,
        parentRunAttempt: token.parentRunAttempt,
      },
      authorizationRoute: token.authorizationRoute,
      artifactId: token.authorizationArtifactId,
      artifactDigest: token.authorizationArtifactDigest,
      transactionKey: "exact-transaction",
    };
    vi.mocked(verifyOpenClawPublishAuthorization).mockResolvedValue(authorization as never);
    const runMutation = vi.fn(async (_ref: unknown, args: unknown) => {
      if (typeof args !== "object" || args === null) {
        throw new Error(`Unexpected mutation args ${JSON.stringify(args)}`);
      }
      if ("attemptId" in args && !("result" in args) && !("error" in args)) {
        return {
          status: "claimed",
          attemptId: "publishAttempts:demo",
          packageId: "packages:demo",
          releaseId: "packageReleases:pending",
          packageFollowup: {
            packageName: "demo-plugin",
            version: "1.0.0",
            trustedPublishTokenId: token._id,
            trustedPublishInventoryDigest: inventoryDigest,
            trustedPublishAuthorizationVersion: 2,
          },
        };
      }
      if ("releaseId" in args) {
        return {
          ok: true,
          packageId: "packages:demo",
          releaseId: "packageReleases:pending",
        };
      }
      return null;
    });
    const ctx = {
      runMutation,
      runQuery: vi.fn(async () => token),
      scheduler: { runAfter: vi.fn() },
    };

    await expect(
      finalizePackagePublishAttemptInternalHandler(ctx as never, {
        attemptId: "publishAttempts:demo",
      }),
    ).resolves.toMatchObject({
      ok: true,
      packageId: "packages:demo",
      releaseId: "packageReleases:pending",
    });

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        releaseId: "packageReleases:pending",
        trustedPublishTokenId: token._id,
        trustedPublishInventoryDigest: inventoryDigest,
        trustedPublishAuthorizationVersion: 2,
      }),
    );
  });

  it("fails closed when a staged v2 release loses its durable publish token", async () => {
    const runMutation = vi.fn(async (_ref: unknown, args: unknown) => {
      if (typeof args === "object" && args !== null && "attemptId" in args && !("error" in args)) {
        return {
          status: "claimed",
          attemptId: "publishAttempts:demo",
          packageId: "packages:demo",
          releaseId: "packageReleases:pending",
          packageFollowup: {
            packageName: "demo-plugin",
            version: "1.0.0",
            trustedPublishInventoryDigest: "d".repeat(64),
            trustedPublishAuthorizationVersion: 2,
          },
        };
      }
      if (typeof args === "object" && args !== null && "error" in args) {
        return { attemptId: "publishAttempts:demo", status: "ready_to_finalize" };
      }
      throw new Error(`Unexpected mutation args ${JSON.stringify(args)}`);
    });
    const ctx = {
      runMutation,
      runQuery: vi.fn(),
    };

    await expect(
      finalizePackagePublishAttemptInternalHandler(ctx as never, {
        attemptId: "publishAttempts:demo",
      }),
    ).rejects.toThrow("Staged OpenClaw publish authorization token is missing");

    expect(ctx.runQuery).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ releaseId: "packageReleases:pending" }),
    );
  });

  it("recovers idempotent package publish results for the same owner", async () => {
    const release = makeReleaseDoc({ integritySha256: "abc123" });
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn((table: string) => {
          if (table === "packages") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(
                  makePackageDoc({
                    ownerUserId: "users:owner",
                    ownerPublisherId: "publishers:owner",
                  }),
                ),
              })),
            };
          }
          if (table === "packageReleases") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(release),
              })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
        insert: vi.fn(),
        patch: vi.fn(),
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn(() => null),
      },
    };

    await expect(
      findPackagePublishResultInternalHandler(ctx as never, {
        name: "demo-plugin",
        version: "1.0.0",
        integritySha256: "abc123",
        ownerUserId: "users:owner",
        ownerPublisherId: "publishers:owner",
      }),
    ).resolves.toEqual({
      ok: true,
      packageId: "packages:demo",
      releaseId: "packageReleases:demo-1",
    });
  });

  it("does not recover a Claw publish result for different exact artifact bytes", async () => {
    const ctx = {
      db: {
        query: vi.fn((table: string) => ({
          withIndex: vi.fn(() => ({
            unique: vi.fn().mockResolvedValue(
              table === "packages"
                ? makePackageDoc({
                    family: "claw",
                    ownerUserId: "users:owner",
                    ownerPublisherId: "publishers:owner",
                  })
                : makeReleaseDoc({
                    integritySha256: "same-extracted-files",
                    clawpackSha256: "a".repeat(64),
                  }),
            ),
          })),
        })),
      },
    };

    await expect(
      findPackagePublishResultInternalHandler(ctx as never, {
        name: "demo-claw",
        version: "1.0.0",
        integritySha256: "same-extracted-files",
        clawpackSha256: "b".repeat(64),
        ownerUserId: "users:owner",
        ownerPublisherId: "publishers:owner",
      }),
    ).resolves.toBeNull();
  });

  it("does not recover pending package publish results as public successes", async () => {
    const release = makeReleaseDoc({
      integritySha256: "abc123",
      publicationStatus: "pending",
    });
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn((table: string) => {
          if (table === "packages") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(
                  makePackageDoc({
                    ownerUserId: "users:owner",
                    ownerPublisherId: "publishers:owner",
                  }),
                ),
              })),
            };
          }
          if (table === "packageReleases") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(release),
              })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      },
    };

    await expect(
      findPackagePublishResultInternalHandler(ctx as never, {
        name: "demo-plugin",
        version: "1.0.0",
        integritySha256: "abc123",
        ownerUserId: "users:owner",
        ownerPublisherId: "publishers:owner",
      }),
    ).resolves.toBeNull();
  });

  it("does not recover idempotent package publish results for another owner", async () => {
    const ctx = {
      db: {
        query: vi.fn((table: string) => {
          if (table === "packages") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(
                  makePackageDoc({
                    ownerUserId: "users:other",
                    ownerPublisherId: "publishers:other",
                  }),
                ),
              })),
            };
          }
          if (table === "packageReleases") {
            throw new Error("release query should be skipped for owner mismatch");
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      },
    };

    await expect(
      findPackagePublishResultInternalHandler(ctx as never, {
        name: "demo-plugin",
        version: "1.0.0",
        integritySha256: "abc123",
        ownerUserId: "users:owner",
        ownerPublisherId: "publishers:owner",
      }),
    ).resolves.toBeNull();
  });

  it("clears inferred catalog state when a publisher promotes a latest package release", async () => {
    const ctx = makeInsertReleaseCtx(
      makePackageDoc({
        inferredCategories: ["tools"],
        inferredTopics: ["Old inference"],
        inferredFromReleaseId: "packageReleases:demo-1",
        inferredCategoryConfidence: "high",
        inferredTopicConfidence: "high",
        inferredClassifierVersion: "taxonomy-prototype-v9",
        inferredTopicClassifierVersion: "topic-prototype-v1",
        inferredInputHash: "category-hash",
        inferredTopicInputHash: "topic-hash",
        inferredAt: 123,
      }),
    );

    await insertReleaseInternalHandler(ctx, {
      actorUserId: "users:owner",
      ownerUserId: "users:owner",
      name: "demo-plugin",
      displayName: "Demo Plugin",
      family: "code-plugin",
      version: "1.0.1",
      changelog: "replace catalog metadata",
      tags: ["latest"],
      summary: "demo",
      categories: ["models"],
      topics: ["Local models"],
      files: [],
      integritySha256: "abc123",
    });

    const packagePatch = ctx.patch.mock.calls.find(([id]) => id === "packages:demo")?.[1];
    expect(packagePatch).toBeDefined();
    for (const field of [
      "inferredCategories",
      "inferredTopics",
      "inferredFromReleaseId",
      "inferredCategoryConfidence",
      "inferredTopicConfidence",
      "inferredClassifierVersion",
      "inferredTopicClassifierVersion",
      "inferredInputHash",
      "inferredTopicInputHash",
      "inferredAt",
    ]) {
      expect(packagePatch).toHaveProperty(field, undefined);
    }
  });

  it("uses the latest tag when the version summary and release pointer are stale", async () => {
    const existingPackage = makePackageDoc({
      latestReleaseId: "packageReleases:stale",
      latestVersionSummary: undefined,
      tags: { latest: "packageReleases:latest" },
      summary: "current summary",
      stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
    });
    const staleRelease = makeReleaseDoc({
      _id: "packageReleases:stale",
      version: "1.0.0",
      distTags: [],
    });
    const latestRelease = makeReleaseDoc({
      _id: "packageReleases:latest",
      version: "2.0.0",
      distTags: ["latest"],
    });
    const ctx = makeInsertReleaseCtx(existingPackage, [staleRelease, latestRelease]);

    await insertReleaseInternalHandler(ctx, {
      actorUserId: "users:owner",
      ownerUserId: "users:owner",
      name: "demo-plugin",
      displayName: "Demo Plugin v1",
      family: "code-plugin",
      version: "1.5.0",
      changelog: "backport",
      tags: ["latest", "v1"],
      summary: "backport summary",
      files: [],
      integritySha256: "backport-sha",
    });

    expect(ctx.insert).toHaveBeenCalledWith(
      "packageReleases",
      expect.objectContaining({
        version: "1.5.0",
        distTags: ["v1"],
      }),
    );
    expect(ctx.patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        latestReleaseId: "packageReleases:stale",
        latestVersionSummary: undefined,
        summary: "current summary",
        tags: {
          latest: "packageReleases:latest",
          v1: "packageReleases:new",
        },
        stats: { downloads: 0, installs: 0, stars: 0, versions: 2 },
      }),
    );
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });

  it("publishes suspicious prepublication plugin results with a suspicious scan status", async () => {
    const ctx = makeInsertReleaseCtx(makePackageDoc());
    const llmAnalysis = {
      status: "completed",
      verdict: "suspicious",
      summary: "Review before installing.",
      checkedAt: 123,
    };

    await insertReleaseInternalHandler(ctx, {
      actorUserId: "users:owner",
      ownerUserId: "users:owner",
      name: "demo-plugin",
      displayName: "Demo Plugin",
      family: "code-plugin",
      version: "1.0.1",
      changelog: "reviewed release",
      tags: ["latest"],
      summary: "demo",
      verification: { tier: "structural", scanStatus: "pending" },
      llmAnalysis,
      files: [],
      integritySha256: "abc123",
      sha256hash: "abc123",
    });

    expect(ctx.insert).toHaveBeenCalledWith(
      "packageReleases",
      expect.objectContaining({
        llmAnalysis,
        verification: expect.objectContaining({ scanStatus: "suspicious" }),
      }),
    );
    expect(ctx.patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        scanStatus: "suspicious",
        verification: expect.objectContaining({ scanStatus: "suspicious" }),
      }),
    );
  });

  it("rejects family changes on an existing package name", async () => {
    const ctx = makeInsertReleaseCtx(makePackageDoc({ family: "bundle-plugin" }));

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:owner",
        ownerUserId: "users:owner",
        name: "demo-plugin",
        displayName: "Demo Plugin",
        family: "code-plugin",
        version: "1.0.0",
        changelog: "init",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
      }),
    ).rejects.toThrow("family changes are not allowed");
  });

  it("rejects new releases on a soft-deleted package", async () => {
    const ctx = makeInsertReleaseCtx(makePackageDoc({ softDeletedAt: 123 }));

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:owner",
        ownerUserId: "users:owner",
        name: "demo-plugin",
        displayName: "Demo Plugin",
        family: "code-plugin",
        version: "1.0.1",
        changelog: "try deleted package",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
      }),
    ).rejects.toThrow("Restore it before publishing another release");
  });

  it("rejects final package publish inserts when the actor was banned mid-publish", async () => {
    const ctx = makeInsertReleaseCtx(makePackageDoc(), [], {
      "users:owner": {
        _id: "users:owner",
        role: "user",
        trustedPublisher: false,
        deletedAt: 123,
      },
    });

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:owner",
        ownerUserId: "users:owner",
        name: "demo-plugin",
        displayName: "Demo Plugin",
        family: "code-plugin",
        version: "1.0.1",
        changelog: "try banned owner",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
      }),
    ).rejects.toThrow("Unauthorized");
    expect(ctx.insert).not.toHaveBeenCalledWith("packageReleases", expect.anything());
  });

  it("rejects final package publish inserts when the requested owner was banned mid-publish", async () => {
    const ctx = makeInsertReleaseCtx(makePackageDoc(), [], {
      "users:admin": { _id: "users:admin", role: "admin", trustedPublisher: false },
      "users:owner": {
        _id: "users:owner",
        role: "user",
        trustedPublisher: false,
        deletedAt: 123,
      },
    });

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:admin",
        ownerUserId: "users:owner",
        name: "demo-plugin",
        displayName: "Demo Plugin",
        family: "code-plugin",
        version: "1.0.1",
        changelog: "try banned owner",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
      }),
    ).rejects.toThrow("Package owner is unavailable");
    expect(ctx.insert).not.toHaveBeenCalledWith("packageReleases", expect.anything());
  });

  it("rejects final package publish inserts when the owner publisher was deleted mid-publish", async () => {
    const ctx = makeInsertReleaseCtx(makePackageDoc(), [], {
      "users:owner": { _id: "users:owner", role: "user", trustedPublisher: false },
      "publishers:org": {
        _id: "publishers:org",
        kind: "org",
        handle: "org",
        deletedAt: 123,
      },
    });

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:owner",
        ownerUserId: "users:owner",
        ownerPublisherId: "publishers:org",
        name: "demo-plugin",
        displayName: "Demo Plugin",
        family: "code-plugin",
        version: "1.0.1",
        changelog: "try deleted publisher",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
      }),
    ).rejects.toThrow("Package owner publisher is unavailable");
    expect(ctx.insert).not.toHaveBeenCalledWith("packageReleases", expect.anything());
  });

  it("rejects final package publish inserts when a personal publisher owner was banned mid-publish", async () => {
    const ctx = makeInsertReleaseCtx(
      makePackageDoc({
        ownerUserId: "users:publishing-actor",
        ownerPublisherId: "publishers:personal",
      }),
      [],
      {
        "users:publishing-actor": {
          _id: "users:publishing-actor",
          role: "user",
          trustedPublisher: false,
        },
        "users:owner": {
          _id: "users:owner",
          role: "user",
          trustedPublisher: false,
          deletedAt: 1_000,
        },
        "publishers:personal": {
          _id: "publishers:personal",
          kind: "user",
          handle: "owner",
          linkedUserId: "users:owner",
        },
      },
    );

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:publishing-actor",
        ownerUserId: "users:publishing-actor",
        ownerPublisherId: "publishers:personal",
        name: "demo-plugin",
        displayName: "Demo Plugin",
        family: "code-plugin",
        version: "1.0.1",
        changelog: "try banned publisher owner",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
      }),
    ).rejects.toThrow("Package owner publisher is unavailable");
    expect(ctx.insert).not.toHaveBeenCalledWith("packageReleases", expect.anything());
  });

  it("rejects final user org package publish inserts when membership was removed mid-publish", async () => {
    const ctx = makeInsertReleaseCtx(null, [], {
      "users:member": { _id: "users:member", role: "user", trustedPublisher: false },
      "publishers:org": {
        _id: "publishers:org",
        kind: "org",
        handle: "org",
        trustedPublisher: false,
      },
    });

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:member",
        ownerUserId: "users:member",
        ownerPublisherId: "publishers:org",
        publishActor: { kind: "user", userId: "users:member" },
        name: "@org/demo-plugin",
        displayName: "Demo Plugin",
        family: "bundle-plugin",
        version: "1.0.0",
        changelog: "init",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
      }),
    ).rejects.toThrow('publish access for "@org"');
    expect(ctx.insert).not.toHaveBeenCalledWith("packages", expect.anything());
    expect(ctx.insert).not.toHaveBeenCalledWith("packageReleases", expect.anything());
  });

  it("rejects final user org package publish inserts when publish actor drifts from actor user", async () => {
    const ctx = makeInsertReleaseCtx(
      null,
      [],
      {
        "users:member": { _id: "users:member", role: "user", trustedPublisher: false },
        "publishers:org": {
          _id: "publishers:org",
          kind: "org",
          handle: "org",
          trustedPublisher: false,
        },
      },
      [],
      "publisher",
    );

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:member",
        ownerUserId: "users:member",
        ownerPublisherId: "publishers:org",
        publishActor: { kind: "user", userId: "users:other" },
        name: "@org/demo-plugin",
        displayName: "Demo Plugin",
        family: "bundle-plugin",
        version: "1.0.0",
        changelog: "init",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
      }),
    ).rejects.toThrow("Publish actor must match the authenticated actor");
    expect(ctx.insert).not.toHaveBeenCalledWith("packages", expect.anything());
    expect(ctx.insert).not.toHaveBeenCalledWith("packageReleases", expect.anything());
  });

  it("keeps final user org package publishes working when membership remains valid", async () => {
    const ctx = makeInsertReleaseCtx(
      null,
      [],
      {
        "users:member": { _id: "users:member", role: "user", trustedPublisher: false },
        "publishers:org": {
          _id: "publishers:org",
          kind: "org",
          handle: "org",
          trustedPublisher: false,
        },
      },
      [],
      "publisher",
    );

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:member",
        ownerUserId: "users:member",
        ownerPublisherId: "publishers:org",
        publishActor: { kind: "user", userId: "users:member" },
        name: "@org/demo-plugin",
        displayName: "Demo Plugin",
        family: "bundle-plugin",
        version: "1.0.0",
        changelog: "init",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
      }),
    ).resolves.toMatchObject({ ok: true, packageId: "packages:new" });
    expect(ctx.insert).toHaveBeenCalledWith("packageReleases", expect.anything());
  });

  it("pins newly created Claw packages to the current profile policy", async () => {
    const previous = process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    process.env.CLAWHUB_EXPERIMENTAL_CLAWS = "1";
    const ctx = makeInsertReleaseCtx(null);

    try {
      await insertReleaseInternalHandler(ctx, {
        actorUserId: "users:owner",
        ownerUserId: "users:owner",
        name: "demo-claw",
        displayName: "Demo Claw",
        family: "claw",
        version: "1.0.0",
        changelog: "init",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
      });
    } finally {
      if (previous === undefined) delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
      else process.env.CLAWHUB_EXPERIMENTAL_CLAWS = previous;
    }

    expect(ctx.insert).toHaveBeenCalledWith(
      "packages",
      expect.objectContaining({
        family: "claw",
        clawProfilePolicyVersion: 1,
      }),
    );
  });

  it("pins a reserved package when its first published release is a Claw", async () => {
    const previous = process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    process.env.CLAWHUB_EXPERIMENTAL_CLAWS = "1";
    const reservation = makePackageDoc({
      family: "code-plugin",
      latestReleaseId: undefined,
      latestVersionSummary: undefined,
      stats: { downloads: 0, installs: 0, stars: 0, versions: 0 },
    });
    const ctx = makeInsertReleaseCtx(reservation);

    try {
      await insertReleaseInternalHandler(ctx, {
        actorUserId: "users:owner",
        ownerUserId: "users:owner",
        name: "demo-plugin",
        displayName: "Demo Claw",
        family: "claw",
        version: "1.0.0",
        changelog: "init",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
      });
    } finally {
      if (previous === undefined) delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
      else process.env.CLAWHUB_EXPERIMENTAL_CLAWS = previous;
    }

    expect(ctx.patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        family: "claw",
        clawProfilePolicyVersion: 1,
      }),
    );
  });

  it("pins a reserved package when its pending first Claw release is published", async () => {
    const reservation = makePackageDoc({
      family: "code-plugin",
      latestReleaseId: undefined,
      latestVersionSummary: undefined,
      stats: { downloads: 0, installs: 0, stars: 0, versions: 0 },
    });
    const pendingRelease = makeReleaseDoc({
      _id: "packageReleases:pending",
      packageId: "packages:demo",
      publicationStatus: "pending",
      pendingPublication: {
        family: "claw",
        displayName: "Demo Claw",
        tags: ["latest"],
      },
    });
    const ctx = makeInsertReleaseCtx(reservation, [pendingRelease], {
      "packages:demo": reservation,
      "packageReleases:pending": pendingRelease,
    });

    await publishPendingReleaseInternalHandler(ctx, {
      releaseId: "packageReleases:pending",
    });

    expect(ctx.patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        family: "claw",
        clawProfilePolicyVersion: 1,
      }),
    );
  });

  it("preserves trusted GitHub Actions package publishes without org membership", async () => {
    const ctx = makeInsertReleaseCtx(
      makePackageDoc({
        name: "@org/demo-plugin",
        normalizedName: "@org/demo-plugin",
        ownerUserId: "users:member",
        ownerPublisherId: "publishers:org",
      }),
      [],
      {
        "users:member": { _id: "users:member", role: "user", trustedPublisher: false },
        "publishers:org": {
          _id: "publishers:org",
          kind: "org",
          handle: "org",
          trustedPublisher: false,
        },
      },
    );

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:member",
        ownerUserId: "users:member",
        ownerPublisherId: "publishers:org",
        publishActor: {
          kind: "github-actions",
          repository: "org/demo-plugin",
          workflow: "publish.yml",
          runId: "1",
          runAttempt: "1",
          sha: "abc123",
        },
        name: "@org/demo-plugin",
        displayName: "Demo Plugin",
        family: "code-plugin",
        version: "1.0.1",
        changelog: "trusted publish",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
      }),
    ).resolves.toMatchObject({ ok: true, packageId: "packages:demo" });
    expect(ctx.insert).toHaveBeenCalledWith("packageReleases", expect.anything());
  });

  it("rejects package scopes that do not match the selected owner handle", async () => {
    const runMutation = vi.fn();
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          _id: "users:vintageayu",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "users:vintageayu",
          role: "user",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        }),
      runMutation,
      runAction: makePublishRunActionMock(),
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: {
        get: vi.fn(),
      },
    };

    await expect(
      publishPackageForUserInternalHandler(ctx as never, {
        actorUserId: "users:vintageayu",
        payload: {
          name: "@openclaw/dronzer",
          displayName: "Dronzer Controller",
          ownerHandle: "vintageayu",
          family: "code-plugin",
          version: "1.0.0",
          changelog: "init",
          files: [],
        },
      }),
    ).rejects.toThrow('Package scope "@openclaw" must match selected owner "@vintageayu"');

    expect(runMutation).not.toHaveBeenCalled();
  });

  it("rejects unscoped package names that collide with publish routes", async () => {
    const ctx = {
      runQuery: vi.fn(),
      runMutation: vi.fn(),
      scheduler: { runAfter: vi.fn() },
      storage: { get: vi.fn() },
    };

    await expect(
      publishPackageForUserInternalHandler(ctx as never, {
        actorUserId: "users:owner",
        payload: {
          name: "publish",
          displayName: "Publish",
          family: "code-plugin",
          version: "1.0.0",
          changelog: "init",
          files: [],
        },
      }),
    ).rejects.toThrow('Package name "publish" is reserved for ClawHub routes');

    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it("rejects runtime id changes on an existing code plugin package", async () => {
    const ctx = makeInsertReleaseCtx(makePackageDoc({ runtimeId: "demo.plugin" }));

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:owner",
        ownerUserId: "users:owner",
        name: "demo-plugin",
        displayName: "Demo Plugin",
        family: "code-plugin",
        version: "1.0.1",
        changelog: "retarget runtime id",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
        runtimeId: "other.plugin",
      }),
    ).rejects.toThrow("runtime id changes are not allowed");
  });

  it("rejects plugin id collisions with active packages", async () => {
    const ctx = makeInsertReleaseCtx(null, [], {}, [
      makePackageDoc({
        _id: "packages:claimed",
        name: "claimed-plugin",
        normalizedName: "claimed-plugin",
        runtimeId: "dronzer",
        softDeletedAt: undefined,
      }),
    ]);

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:owner",
        ownerUserId: "users:owner",
        name: "dronzerclaw",
        displayName: "Dronzer Claw",
        family: "code-plugin",
        version: "1.0.0",
        changelog: "init",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
        runtimeId: "dronzer",
      }),
    ).rejects.toThrow('Plugin id "dronzer" is already claimed by another package');
  });

  it("allows plugin ids held only by soft-deleted packages", async () => {
    const ctx = makeInsertReleaseCtx(null, [], {}, [
      makePackageDoc({
        _id: "packages:deleted",
        name: "@openclaw/dronzer",
        normalizedName: "@openclaw/dronzer",
        runtimeId: "dronzer",
        softDeletedAt: 123,
      }),
    ]);

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:owner",
        ownerUserId: "users:owner",
        name: "dronzerclaw",
        displayName: "Dronzer Claw",
        family: "code-plugin",
        version: "1.0.0",
        changelog: "init",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
        runtimeId: "dronzer",
      }),
    ).resolves.toMatchObject({ ok: true, packageId: "packages:new" });
  });

  it("promotes existing packages to official when owner is the OpenClaw publisher", async () => {
    const ctx = makeInsertReleaseCtx(
      makePackageDoc({
        ownerUserId: "users:openclaw",
        ownerPublisherId: "publishers:openclaw",
        channel: "community",
        isOfficial: false,
        stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
      }),
      [],
      {
        "users:owner": { _id: "users:owner", role: "admin" },
        "users:openclaw": { _id: "users:openclaw", role: "user" },
        "publishers:openclaw": {
          _id: "publishers:openclaw",
          kind: "org",
          handle: "openclaw",
          displayName: "OpenClaw",
        },
      },
    );

    await insertReleaseInternalHandler(ctx, {
      actorUserId: "users:owner",
      ownerUserId: "users:openclaw",
      ownerPublisherId: "publishers:openclaw",
      name: "demo-plugin",
      displayName: "Demo Plugin",
      family: "code-plugin",
      version: "1.1.0",
      changelog: "promote",
      tags: ["latest"],
      summary: "demo",
      files: [],
      integritySha256: "abc123",
      capabilities: { capabilityTags: ["tools"], executesCode: true },
    });

    expect(ctx.patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        channel: "official",
        isOfficial: true,
      }),
    );
  });

  it("lets admins publish package releases on behalf of another owner", async () => {
    const ctx = makeInsertReleaseCtx(
      makePackageDoc({
        ownerUserId: "users:openclaw",
        ownerPublisherId: "publishers:openclaw",
        channel: "official",
        isOfficial: true,
        stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
      }),
      [],
      {
        "users:admin": {
          _id: "users:admin",
          role: "admin",
          trustedPublisher: false,
        },
        "users:openclaw": {
          _id: "users:openclaw",
          role: "user",
        },
        "publishers:openclaw": {
          _id: "publishers:openclaw",
          kind: "org",
          handle: "openclaw",
          displayName: "OpenClaw",
        },
      },
    );

    await insertReleaseInternalHandler(ctx, {
      actorUserId: "users:admin",
      ownerUserId: "users:openclaw",
      ownerPublisherId: "publishers:openclaw",
      name: "demo-plugin",
      displayName: "Demo Plugin",
      family: "code-plugin",
      version: "1.1.0",
      changelog: "promote",
      tags: ["latest"],
      summary: "demo",
      files: [],
      integritySha256: "abc123",
      channel: "official",
    });

    expect(ctx.insert).toHaveBeenCalledWith(
      "packageReleases",
      expect.objectContaining({
        createdBy: "users:admin",
      }),
    );
  });

  it("rejects non-admin publishes on behalf of another owner", async () => {
    const ctx = makeInsertReleaseCtx(
      makePackageDoc({
        ownerUserId: "users:openclaw",
        stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
      }),
      [],
      {
        "users:owner": {
          _id: "users:owner",
          role: "user",
          trustedPublisher: false,
        },
        "users:openclaw": {
          _id: "users:openclaw",
          role: "user",
          trustedPublisher: true,
        },
      },
    );

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:owner",
        ownerUserId: "users:openclaw",
        name: "demo-plugin",
        displayName: "Demo Plugin",
        family: "code-plugin",
        version: "1.1.0",
        changelog: "promote",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
      }),
    ).rejects.toThrow("Forbidden");
  });

  it("rejects publishing the same package name across different publishers", async () => {
    const ctx = makeInsertReleaseCtx(
      makePackageDoc({
        ownerUserId: "users:owner",
        ownerPublisherId: undefined,
        stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
      }),
      [],
      {
        "users:owner": {
          _id: "users:owner",
          role: "user",
          trustedPublisher: false,
        },
        "publishers:org": {
          _id: "publishers:org",
          kind: "org",
          handle: "acme",
          displayName: "Acme",
          trustedPublisher: false,
        },
      },
    );

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:owner",
        ownerUserId: "users:owner",
        ownerPublisherId: "publishers:org",
        name: "demo-plugin",
        displayName: "Demo Plugin",
        family: "code-plugin",
        version: "1.1.0",
        changelog: "org release",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
      }),
    ).rejects.toThrow("Package already exists and belongs to another publisher");
  });

  it("treats a legacy personal package as the same personal publisher", async () => {
    const ctx = makeInsertReleaseCtx(
      makePackageDoc({
        ownerUserId: "users:owner",
        ownerPublisherId: undefined,
        stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
      }),
      [],
      {
        "users:owner": {
          _id: "users:owner",
          role: "user",
          trustedPublisher: false,
        },
        "publishers:owner": {
          _id: "publishers:owner",
          kind: "user",
          handle: "owner",
          displayName: "Owner",
          linkedUserId: "users:owner",
          trustedPublisher: false,
        },
      },
    );

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:owner",
        ownerUserId: "users:owner",
        ownerPublisherId: "publishers:owner",
        name: "demo-plugin",
        displayName: "Demo Plugin",
        family: "code-plugin",
        version: "1.1.0",
        changelog: "personal release",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
      }),
    ).resolves.toMatchObject({ ok: true, packageId: "packages:demo" });

    expect(ctx.patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        ownerUserId: "users:owner",
        ownerPublisherId: "publishers:owner",
      }),
    );
  });

  it("does not overwrite latest package metadata for non-latest releases", async () => {
    const ctx = makeInsertReleaseCtx(
      makePackageDoc({
        tags: { latest: "packageReleases:demo-1" },
        latestReleaseId: "packageReleases:demo-1",
        latestVersionSummary: {
          version: "1.0.0",
          createdAt: 1,
          changelog: "latest",
          compatibility: null,
          verification: null,
          artifact: null,
        },
        stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
      }),
    );

    await insertReleaseInternalHandler(ctx, {
      actorUserId: "users:owner",
      ownerUserId: "users:owner",
      name: "demo-plugin",
      displayName: "Demo Plugin",
      family: "code-plugin",
      version: "0.9.9",
      changelog: "branch patch",
      tags: ["legacy"],
      summary: "demo",
      files: [],
      integritySha256: "abc123",
    });

    const packagePatch = ctx.patch.mock.calls.find(([id]) => id === "packages:demo")?.[1];
    expect(packagePatch).toEqual(
      expect.objectContaining({
        latestReleaseId: "packageReleases:demo-1",
        latestVersionSummary: expect.objectContaining({ version: "1.0.0" }),
      }),
    );
    expect(packagePatch).not.toHaveProperty("capabilityTags");
    expect(packagePatch).not.toHaveProperty("capabilities");
    expect(packagePatch).not.toHaveProperty("executesCode");
  });

  it("adds artifact summary for promoted ClawPack releases", async () => {
    const ctx = makeInsertReleaseCtx(
      makePackageDoc({
        tags: { latest: "packageReleases:demo-1" },
        latestReleaseId: "packageReleases:demo-1",
        stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
      }),
    );

    await insertReleaseInternalHandler(ctx, {
      actorUserId: "users:owner",
      ownerUserId: "users:owner",
      name: "demo-plugin",
      displayName: "Demo Plugin",
      family: "code-plugin",
      version: "1.1.0",
      changelog: "clawpack",
      tags: ["latest"],
      summary: "demo",
      files: [],
      integritySha256: "abc123",
      sha256hash: "legacy-zip-sha",
      artifactKind: "npm-pack",
      clawpackStorageId: "storage:clawpack",
      clawpackSha256: "a".repeat(64),
      clawpackSize: 1024,
      clawpackFormat: "tgz",
      npmIntegrity: "sha512-demo",
      npmShasum: "b".repeat(40),
      npmTarballName: "demo-plugin-1.1.0.tgz",
    });

    expect(ctx.insert).toHaveBeenCalledWith(
      "packageReleases",
      expect.objectContaining({
        artifactKind: "npm-pack",
        clawpackStorageId: "storage:clawpack",
        npmIntegrity: "sha512-demo",
      }),
    );
    expect(ctx.patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        latestVersionSummary: expect.objectContaining({
          artifact: expect.objectContaining({
            kind: "npm-pack",
            sha256: "a".repeat(64),
            npmIntegrity: "sha512-demo",
            npmShasum: "b".repeat(40),
          }),
        }),
      }),
    );
  });

  it("uses the exact legacy ZIP hash in promoted legacy artifact summaries", async () => {
    const ctx = makeInsertReleaseCtx(
      makePackageDoc({
        tags: { latest: "packageReleases:demo-1" },
        latestReleaseId: "packageReleases:demo-1",
        stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
      }),
    );

    await insertReleaseInternalHandler(ctx, {
      actorUserId: "users:owner",
      ownerUserId: "users:owner",
      name: "demo-plugin",
      displayName: "Demo Plugin",
      family: "code-plugin",
      version: "1.1.0",
      changelog: "legacy zip",
      tags: ["latest"],
      summary: "demo",
      files: [],
      integritySha256: "file-set-sha",
      sha256hash: "legacy-zip-sha",
      artifactKind: "legacy-zip",
    });

    expect(ctx.patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        latestVersionSummary: expect.objectContaining({
          artifact: {
            kind: "legacy-zip",
            sha256: "legacy-zip-sha",
            format: "zip",
          },
        }),
      }),
    );
  });

  it("keeps package summary pinned to the promoted release for non-latest publishes", async () => {
    const ctx = makeInsertReleaseCtx(
      makePackageDoc({
        summary: "latest summary",
        tags: { latest: "packageReleases:demo-1" },
        latestReleaseId: "packageReleases:demo-1",
        stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
      }),
    );

    await insertReleaseInternalHandler(ctx, {
      actorUserId: "users:owner",
      ownerUserId: "users:owner",
      name: "demo-plugin",
      displayName: "Demo Plugin",
      family: "code-plugin",
      version: "0.9.9",
      changelog: "branch patch",
      tags: ["legacy"],
      summary: "legacy branch summary",
      files: [],
      integritySha256: "abc123",
    });

    expect(ctx.patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        summary: "latest summary",
      }),
    );
  });

  it("keeps runtimeId pinned to the promoted release for non-latest publishes", async () => {
    const ctx = makeInsertReleaseCtx(
      makePackageDoc({
        family: "bundle-plugin",
        runtimeId: "bundle.current",
        tags: { latest: "packageReleases:demo-1" },
        latestReleaseId: "packageReleases:demo-1",
        stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
      }),
    );

    await insertReleaseInternalHandler(ctx, {
      actorUserId: "users:owner",
      ownerUserId: "users:owner",
      name: "demo-plugin",
      displayName: "Demo Plugin",
      family: "bundle-plugin",
      version: "0.9.9",
      changelog: "legacy branch",
      tags: ["legacy"],
      summary: "legacy summary",
      files: [],
      integritySha256: "abc123",
      runtimeId: "bundle.legacy",
    });

    expect(ctx.patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        runtimeId: "bundle.current",
      }),
    );
  });

  it("removes moved dist-tags from older package releases", async () => {
    const olderRelease = makeReleaseDoc({
      _id: "packageReleases:old",
      version: "1.0.0",
      distTags: ["latest", "stable"],
    });
    const ctx = makeInsertReleaseCtx(
      makePackageDoc({
        tags: { latest: "packageReleases:old", stable: "packageReleases:old" },
        latestReleaseId: "packageReleases:old",
        stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
      }),
      [olderRelease],
    );

    await insertReleaseInternalHandler(ctx, {
      actorUserId: "users:owner",
      ownerUserId: "users:owner",
      name: "demo-plugin",
      displayName: "Demo Plugin",
      family: "code-plugin",
      version: "1.1.0",
      changelog: "promote",
      tags: ["latest"],
      summary: "demo",
      files: [],
      integritySha256: "abc123",
    });

    await flushScheduledPackageReleaseTagCleanup(ctx);
    expect(ctx.patch).toHaveBeenCalledWith("packageReleases:old", {
      distTags: ["stable"],
    });
  });

  it("rejects an owner-deleted package version even when matching workflow retries are allowed", async () => {
    const ctx = makeInsertReleaseCtx(makePackageDoc(), [
      makeReleaseDoc({
        _id: "packageReleases:existing",
        version: "1.0.0",
        integritySha256: "abc123",
        softDeletedAt: 123,
        ownerDeletedAt: 123,
        ownerDeletedBy: "users:owner",
      }),
    ]);

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:owner",
        ownerUserId: "users:owner",
        name: "demo-plugin",
        displayName: "Demo Plugin",
        family: "code-plugin",
        version: "1.0.0",
        changelog: "retry",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
        allowExistingRelease: true,
      }),
    ).rejects.toThrow("Version 1.0.0 already exists. Increment the version number and try again.");
  });

  it("treats matching workflow duplicate package releases as idempotent", async () => {
    const ctx = makeInsertReleaseCtx(makePackageDoc(), [
      makeReleaseDoc({
        _id: "packageReleases:existing",
        version: "1.0.0",
        integritySha256: "abc123",
      }),
    ]);

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:owner",
        ownerUserId: "users:owner",
        name: "demo-plugin",
        displayName: "Demo Plugin",
        family: "code-plugin",
        version: "1.0.0",
        changelog: "retry",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "abc123",
        allowExistingRelease: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      packageId: "packages:demo",
      releaseId: "packageReleases:existing",
    });

    expect(ctx.insert).not.toHaveBeenCalled();
    expect(ctx.patch).not.toHaveBeenCalled();
  });

  it("rejects a Claw version retry when the exact artifact digest differs", async () => {
    const ctx = makeInsertReleaseCtx(makePackageDoc({ family: "claw" }), [
      makeReleaseDoc({
        _id: "packageReleases:existing",
        version: "1.0.0",
        integritySha256: "same-extracted-files",
        clawpackSha256: "a".repeat(64),
      }),
    ]);

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:owner",
        ownerUserId: "users:owner",
        name: "demo-claw",
        displayName: "Demo Claw",
        family: "claw",
        version: "1.0.0",
        changelog: "retry",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "same-extracted-files",
        clawpackSha256: "b".repeat(64),
        allowExistingRelease: true,
      }),
    ).rejects.toThrow("Version 1.0.0 already exists. Increment the version number and try again.");
  });

  it("treats an ordinary-user exact Claw artifact retry as idempotent", async () => {
    const artifactSha256 = "a".repeat(64);
    const ctx = makeInsertReleaseCtx(makePackageDoc({ family: "claw" }), [
      makeReleaseDoc({
        _id: "packageReleases:existing",
        version: "1.0.0",
        integritySha256: "same-extracted-files",
        clawpackSha256: artifactSha256,
      }),
    ]);

    await expect(
      insertReleaseInternalHandler(ctx, {
        actorUserId: "users:owner",
        ownerUserId: "users:owner",
        name: "demo-claw",
        displayName: "Demo Claw",
        family: "claw",
        version: "1.0.0",
        changelog: "retry",
        tags: ["latest"],
        summary: "demo",
        files: [],
        integritySha256: "same-extracted-files",
        clawpackSha256: artifactSha256,
      }),
    ).resolves.toMatchObject({
      ok: true,
      packageId: "packages:demo",
      releaseId: "packageReleases:existing",
    });
  });

  it.each(["pending", "blocked"] as const)(
    "does not report a %s exact Claw release as published",
    async (publicationStatus) => {
      const artifactSha256 = "a".repeat(64);
      const ctx = makeInsertReleaseCtx(makePackageDoc({ family: "claw" }), [
        makeReleaseDoc({
          _id: "packageReleases:pending",
          version: "1.0.0",
          publicationStatus,
          integritySha256: "same-extracted-files",
          clawpackSha256: artifactSha256,
        }),
      ]);

      await expect(
        insertReleaseInternalHandler(ctx, {
          actorUserId: "users:owner",
          ownerUserId: "users:owner",
          name: "demo-claw",
          displayName: "Demo Claw",
          family: "claw",
          version: "1.0.0",
          changelog: "retry",
          tags: ["latest"],
          summary: "demo",
          files: [],
          integritySha256: "same-extracted-files",
          clawpackSha256: artifactSha256,
        }),
      ).rejects.toThrow(
        "Version 1.0.0 already exists. Increment the version number and try again.",
      );
    },
  );

  it("keeps an initial beta-only package publish off latest", async () => {
    const ctx = makeInsertReleaseCtx(
      makePackageDoc({
        latestReleaseId: undefined,
        latestVersionSummary: undefined,
        tags: {},
        stats: { downloads: 0, installs: 0, stars: 0, versions: 0 },
      }),
    );

    await insertReleaseInternalHandler(ctx, {
      actorUserId: "users:owner",
      ownerUserId: "users:owner",
      name: "demo-plugin",
      displayName: "Demo Plugin",
      family: "code-plugin",
      version: "1.0.0",
      changelog: "beta",
      tags: ["beta"],
      summary: "demo",
      files: [],
      integritySha256: "abc123",
      verification: {
        tier: "source-linked",
        scope: "artifact-only",
        scanStatus: "suspicious",
      },
      staticScan: {
        status: "suspicious",
        reasonCodes: ["suspicious.dynamic_code_execution"],
        findings: [],
        summary: "Detected: suspicious.dynamic_code_execution",
        engineVersion: "test",
        checkedAt: 123,
      },
    });

    expect(ctx.insert).toHaveBeenCalledWith(
      "packageReleases",
      expect.objectContaining({
        distTags: ["beta"],
        verification: expect.objectContaining({ scanStatus: "suspicious" }),
        staticScan: expect.objectContaining({ status: "suspicious" }),
      }),
    );
    expect(ctx.patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        latestReleaseId: undefined,
        tags: { beta: "packageReleases:new" },
      }),
    );
  });

  it("validates package publish payloads inside the action path", async () => {
    await expect(
      publishPackageForUserInternalHandler({} as never, {
        actorUserId: "users:owner",
        payload: {
          name: "demo-plugin",
          family: "bundle-plugin",
          version: "1.0.0",
          changelog: "init",
          bundle: { hostTargets: ["desktop"] },
          files: "invalid",
        },
      }),
    ).rejects.toThrow(/Package publish payload/i);
  });

  it("rejects skill publishes on the package endpoint", async () => {
    await expect(
      publishPackageForUserInternalHandler({} as never, {
        actorUserId: "users:owner",
        payload: {
          name: "demo-skill",
          family: "skill",
          version: "1.0.0",
          changelog: "init",
          files: [],
        },
      }),
    ).rejects.toThrow("Skill packages must use the skills publish flow");
  });

  it("requires the exact-artifact HTTP flow for public Claw publishes", async () => {
    await expect(
      publishReleaseHandler({} as never, {
        payload: {
          name: "demo-claw",
          family: "claw",
          version: "1.0.0",
        },
      }),
    ).rejects.toThrow("Claw packages must use the exact-artifact HTTP publish flow");
    expect(getAuthUserId).not.toHaveBeenCalled();
  });

  it("rejects Claw publication before mutation when the experimental gate is disabled", async () => {
    const previous = process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    try {
      await expect(
        publishPackageForUserInternalHandler({} as never, {
          actorUserId: "users:owner",
          payload: {
            name: "demo-claw",
            family: "claw",
            version: "1.0.0",
            changelog: "init",
            files: [],
          },
        }),
      ).rejects.toThrow("Experimental Claw publication is disabled");
    } finally {
      if (previous === undefined) delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
      else process.env.CLAWHUB_EXPERIMENTAL_CLAWS = previous;
    }
  });

  it("rechecks the Claw gate at release insertion for staged publications", async () => {
    const previous = process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    const dbGet = vi.fn();
    try {
      await expect(
        insertReleaseInternalHandler(
          {
            db: {
              system: {},
              get: dbGet,
              insert: vi.fn(),
              patch: vi.fn(),
              replace: vi.fn(),
              delete: vi.fn(),
              query: vi.fn(),
              normalizeId: vi.fn(),
            },
          } as never,
          {
            family: "claw",
          } as never,
        ),
      ).rejects.toThrow("Experimental Claw publication is disabled");
      expect(dbGet).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
      else process.env.CLAWHUB_EXPERIMENTAL_CLAWS = previous;
    }
  });

  it("publishes a profile-bearing Claw through the existing release pipeline when enabled", async () => {
    const previous = process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    process.env.CLAWHUB_EXPERIMENTAL_CLAWS = "1";
    const longClawDescription = "x".repeat(1_100);
    const artifactSha256 = "a".repeat(64);
    const storedFiles = new Map<string, string>([
      [
        "storage:package",
        JSON.stringify({
          name: "demo-claw",
          version: "1.0.0",
          openclaw: { claw: "manifests/CLAW.md" },
        }),
      ],
      [
        "storage:claw",
        `---\nschemaVersion: 1\nagent:\n  id: demo-claw\n  name: Demo Claw\n  description: ${longClawDescription}\n---\nRun the demo workflow precisely.\n`,
      ],
      ["storage:profile", "schemaVersion: 1\nagent:\n  tools:\n    profile: minimal\n"],
      ["storage:codex-profile", "version: 1\nfeatures: [future]\n"],
      ["storage:bootstrap", "Ask which repositories the user owns.\n"],
    ]);
    const runMutation = vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
      if (args.minimumRole === "publisher") {
        return { publisherId: "publishers:owner", linkedUserId: "users:owner" };
      }
      if (args.family === "claw") {
        return { ok: true, packageId: "packages:claw", releaseId: "releases:claw-1" };
      }
      return null;
    });
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          _id: "users:owner",
          role: "user",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "users:owner",
          role: "user",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "publishers:owner",
          kind: "user",
          handle: "owner",
          linkedUserId: "users:owner",
        }),
      runMutation,
      scheduler: { runAfter: vi.fn() },
      storage: {
        get: vi.fn(async (storageId: string) => {
          const content = storedFiles.get(storageId);
          return content === undefined ? null : new Blob([content]);
        }),
        store: vi.fn(async () => "storage:legacy-zip"),
      },
      runAction: makePublishRunActionMock(),
    };

    try {
      await expect(
        publishPackageForUserInternalHandler(ctx as never, {
          actorUserId: "users:owner",
          payload: {
            name: "demo-claw",
            displayName: "Demo Claw",
            family: "claw",
            version: "1.0.0",
            changelog: "init",
            expectedArtifactSha256: artifactSha256,
            files: [
              { path: "package.json", size: 1, storageId: "storage:package", sha256: "package" },
              {
                path: "manifests/CLAW.md",
                size: 1,
                storageId: "storage:claw",
                sha256: "claw",
              },
              {
                path: "profiles/openclaw.yml",
                size: 1,
                storageId: "storage:profile",
                sha256: "profile",
              },
              {
                path: "profiles/codex.yml",
                size: 1,
                storageId: "storage:codex-profile",
                sha256: "codex-profile",
              },
              {
                path: "BOOTSTRAP.md",
                size: 1,
                storageId: "storage:bootstrap",
                sha256: "bootstrap",
              },
            ],
            artifact: {
              kind: "npm-pack",
              storageId: "storage:archive",
              sha256: artifactSha256,
              size: 3,
              format: "tgz",
              npmIntegrity: "sha512-demo",
              npmShasum: "b".repeat(40),
              npmTarballName: "demo-claw-1.0.0.tgz",
              npmUnpackedSize: 3,
              npmFileCount: 3,
            },
          },
        }),
      ).resolves.toEqual({
        ok: true,
        packageId: "packages:claw",
        releaseId: "releases:claw-1",
        publicationStatus: "published",
        artifactSha256,
      });

      expect(runMutation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          family: "claw",
          summary: expect.any(String),
          artifactKind: "npm-pack",
          clawpackStorageId: "storage:archive",
          clawpackSha256: artifactSha256,
          clawpackSize: 3,
          clawManifestSummary: expect.objectContaining({
            agent: expect.objectContaining({
              id: "demo-claw",
              description: "x".repeat(1_024),
            }),
            workspace: expect.objectContaining({
              bootstrapFiles: ["BOOTSTRAP.md", "SOUL.md"],
            }),
          }),
          pluginManifestSummary: undefined,
        }),
      );
      const publishMutationArgs = runMutation.mock.calls.find(
        ([, args]) => args.family === "claw",
      )?.[1];
      expect(publishMutationArgs?.summary).toBe("x".repeat(1_024));
      expect(publishMutationArgs).not.toHaveProperty("extractedClawManifest");
    } finally {
      if (previous === undefined) delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
      else process.env.CLAWHUB_EXPERIMENTAL_CLAWS = previous;
    }
  });

  it("reuses an in-flight staged Claw publish for the same user and artifact", async () => {
    const previousStage = process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES;
    process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES = "1";
    const artifactSha256 = "a".repeat(64);
    const storedFiles = new Map<string, string>([
      [
        "storage:package",
        JSON.stringify({
          name: "demo-claw",
          version: "1.0.0",
          openclaw: { claw: "manifests/CLAW.md" },
        }),
      ],
      [
        "storage:claw",
        "---\nschemaVersion: 1\nagent:\n  id: demo-claw\n  name: Demo Claw\n---\nRun the demo workflow precisely.\n",
      ],
      ["storage:profile", "schemaVersion: 1\nagent:\n  tools:\n    profile: future-profile\n"],
    ]);
    const existingPackage = makePackageDoc({
      family: "claw",
      ownerUserId: "users:owner",
      ownerPublisherId: "publishers:owner",
    });
    const currentPolicyPackage = {
      ...existingPackage,
      clawProfilePolicyVersion: 1,
    };
    const existingRelease = makeReleaseDoc({
      _id: "packageReleases:pending",
      packageId: "packages:demo",
      publicationStatus: "pending",
      clawpackSha256: artifactSha256,
    });
    const runMutation = vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
      if (args.minimumRole === "publisher") {
        return { publisherId: "publishers:owner", linkedUserId: "users:owner" };
      }
      throw new Error("retry should not create another release or publish attempt");
    });
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce(existingPackage)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        _id: "users:owner",
        githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
      })
      .mockResolvedValueOnce({
        _id: "users:owner",
        role: "user",
        githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
      })
      .mockResolvedValueOnce({
        _id: "publishers:owner",
        kind: "user",
        handle: "owner",
        linkedUserId: "users:owner",
      })
      .mockResolvedValueOnce(existingRelease)
      .mockResolvedValueOnce({
        attemptId: "publishAttempts:pending",
        status: "pending_checks",
        reusable: true,
        packageId: "packages:demo",
        releaseId: "packageReleases:pending",
        artifactFingerprint: artifactSha256,
      });
    const ctx = {
      runQuery,
      runMutation,
      scheduler: { runAfter: vi.fn() },
      storage: {
        get: vi.fn(async (storageId: string) => {
          const content = storedFiles.get(storageId);
          return content === undefined ? null : new Blob([content]);
        }),
        store: vi.fn(async () => "storage:legacy-zip"),
      },
      runAction: makePublishRunActionMock(),
    };

    try {
      await expect(
        publishPackageForUserInternalHandler(ctx as never, {
          actorUserId: "users:owner",
          payload: {
            name: "demo-claw",
            displayName: "Demo Claw",
            family: "claw",
            version: "1.0.0",
            changelog: "retry",
            ownerHandle: "owner",
            expectedArtifactSha256: artifactSha256,
            files: [
              { path: "package.json", size: 1, storageId: "storage:package", sha256: "package" },
              {
                path: "manifests/CLAW.md",
                size: 1,
                storageId: "storage:claw",
                sha256: "claw",
              },
              {
                path: "profiles/openclaw.yml",
                size: 1,
                storageId: "storage:profile",
                sha256: "profile",
              },
            ],
            artifact: {
              kind: "npm-pack",
              storageId: "storage:archive",
              sha256: artifactSha256,
              size: 3,
              format: "tgz",
              npmIntegrity: "sha512-demo",
              npmShasum: "b".repeat(40),
              npmTarballName: "demo-claw-1.0.0.tgz",
              npmUnpackedSize: 3,
              npmFileCount: 3,
            },
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
        status: "pending",
        packageId: "packages:demo",
        releaseId: "packageReleases:pending",
        artifactSha256,
        publicationStatus: "pending",
        attemptId: "publishAttempts:pending",
      });

      expect(runMutation).toHaveBeenCalledTimes(1);
      expect(runQuery).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          kind: "package",
          slug: "demo-claw",
          version: "1.0.0",
          userId: "users:owner",
          ownerUserId: "users:owner",
          ownerPublisherId: "publishers:owner",
          artifactFingerprint: artifactSha256,
        }),
      );

      runQuery
        .mockResolvedValueOnce(currentPolicyPackage)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          _id: "users:owner",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "users:owner",
          role: "user",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "publishers:owner",
          kind: "user",
          handle: "owner",
          linkedUserId: "users:owner",
        });

      await expect(
        publishPackageForUserInternalHandler(ctx as never, {
          actorUserId: "users:owner",
          payload: {
            name: "demo-claw",
            displayName: "Demo Claw",
            family: "claw",
            version: "1.0.0",
            changelog: "retry",
            ownerHandle: "owner",
            expectedArtifactSha256: artifactSha256,
            files: [
              { path: "package.json", size: 1, storageId: "storage:package", sha256: "package" },
              {
                path: "manifests/CLAW.md",
                size: 1,
                storageId: "storage:claw",
                sha256: "claw",
              },
              {
                path: "profiles/openclaw.yml",
                size: 1,
                storageId: "storage:profile",
                sha256: "profile",
              },
            ],
            artifact: {
              kind: "npm-pack",
              storageId: "storage:archive",
              sha256: artifactSha256,
              size: 3,
              format: "tgz",
              npmIntegrity: "sha512-demo",
              npmShasum: "b".repeat(40),
              npmTarballName: "demo-claw-1.0.0.tgz",
              npmUnpackedSize: 3,
              npmFileCount: 3,
            },
          },
        }),
      ).rejects.toThrow(
        "profiles/openclaw.yml.agent.tools.profile: Must name a registered OpenClaw built-in profile.",
      );
      expect(runMutation).toHaveBeenCalledTimes(2);

      runQuery.mockReset();
      runQuery
        .mockResolvedValueOnce(existingPackage)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          _id: "users:owner",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "users:owner",
          role: "user",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "publishers:owner",
          kind: "user",
          handle: "owner",
          linkedUserId: "users:owner",
        })
        .mockResolvedValueOnce(existingRelease)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          attemptId: "publishAttempts:different-artifact",
        });

      await expect(
        publishPackageForUserInternalHandler(ctx as never, {
          actorUserId: "users:owner",
          payload: {
            name: "demo-claw",
            displayName: "Demo Claw",
            family: "claw",
            version: "1.0.0",
            changelog: "different artifact",
            ownerHandle: "owner",
            expectedArtifactSha256: "c".repeat(64),
            files: [
              { path: "package.json", size: 1, storageId: "storage:package", sha256: "package" },
              {
                path: "manifests/CLAW.md",
                size: 1,
                storageId: "storage:claw",
                sha256: "claw",
              },
              {
                path: "profiles/openclaw.yml",
                size: 1,
                storageId: "storage:profile",
                sha256: "profile",
              },
            ],
            artifact: {
              kind: "npm-pack",
              storageId: "storage:archive",
              sha256: "c".repeat(64),
              size: 3,
              format: "tgz",
              npmIntegrity: "sha512-different",
              npmShasum: "d".repeat(40),
              npmTarballName: "demo-claw-1.0.0.tgz",
              npmUnpackedSize: 3,
              npmFileCount: 3,
            },
          },
        }),
      ).rejects.toThrow(
        "Version 1.0.0 already exists. Increment the version number and try again.",
      );

      expect(runQuery).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          kind: "package",
          slug: "demo-claw",
          version: "1.0.0",
        }),
      );
      expect(runQuery.mock.calls.at(-1)?.[1]).not.toHaveProperty("artifactFingerprint");
      expect(runMutation).toHaveBeenCalledTimes(3);
      expect(runMutation).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          packageId: existingPackage._id,
          releaseId: existingRelease._id,
          createdNewParent: expect.anything(),
        }),
      );
    } finally {
      if (previousStage === undefined) {
        delete process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES;
      } else {
        process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES = previousStage;
      }
    }
  });

  it("keeps raw package publishes behind the per-file size limit", async () => {
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          _id: "users:owner",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "users:owner",
          role: "user",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce(null),
      runMutation: vi.fn(),
      storage: {
        get: vi.fn(async (storageId: string) => {
          if (storageId !== "storage:large") return null;
          return new Blob([new Uint8Array(MAX_PUBLISH_FILE_BYTES + 1)]);
        }),
      },
    };

    await expect(
      publishPackageForUserInternalHandler(ctx as never, {
        actorUserId: "users:owner",
        payload: {
          name: "demo-plugin",
          family: "bundle-plugin",
          version: "1.0.0",
          changelog: "init",
          bundle: { hostTargets: ["desktop"] },
          files: [
            {
              path: "assets/viewer-runtime.js",
              size: 1,
              storageId: "storage:large",
              sha256: "large",
            },
          ],
        },
      }),
    ).rejects.toThrow('File "assets/viewer-runtime.js" exceeds 10MB limit');
  });

  it("allows large files inside ClawPack npm package artifacts", async () => {
    const runMutation = vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
      if (args.name === "demo-plugin" && args.version === "1.0.0") {
        return { ok: true, packageId: "packages:demo", releaseId: "releases:demo-1" };
      }
      return null;
    });
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          _id: "users:owner",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "users:owner",
          role: "user",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce(null),
      runMutation,
      runAction: makePublishRunActionMock(),
      scheduler: {
        runAfter: vi.fn(async () => {}),
      },
      storage: {
        get: vi.fn(async (storageId: string) => {
          const files = new Map<string, BlobPart>([
            [
              "storage:package",
              JSON.stringify({
                name: "demo-plugin",
                version: "1.0.0",
                openclaw: {
                  extensions: ["./dist/index.js"],
                  compat: { pluginApi: "^1.0.0" },
                  build: { openclawVersion: "2026.5.28" },
                  configSchema: { type: "object", additionalProperties: false },
                },
              }),
            ],
            ["storage:manifest", JSON.stringify({ id: "demo-plugin" })],
            ["storage:runtime", "export {};"],
            ["storage:large", new Uint8Array(MAX_PUBLISH_FILE_BYTES + 1)],
          ]);
          const content = files.get(storageId);
          return content ? new Blob([content]) : null;
        }),
        store: vi.fn(async () => "storage:legacy-zip"),
      },
    };

    await expect(
      publishPackageForUserInternalHandler(ctx as never, {
        actorUserId: "users:owner",
        payload: {
          name: "demo-plugin",
          displayName: "Demo Plugin",
          family: "code-plugin",
          version: "1.0.0",
          changelog: "init",
          source: {
            kind: "github",
            url: "https://github.com/openclaw/demo-plugin",
            repo: "openclaw/demo-plugin",
            ref: "refs/tags/v1.0.0",
            commit: "abc123",
            path: ".",
            importedAt: Date.now(),
          },
          files: [
            {
              path: "package.json",
              size: 1,
              storageId: "storage:package",
              sha256: "package",
              contentType: "application/json",
            },
            {
              path: "openclaw.plugin.json",
              size: 1,
              storageId: "storage:manifest",
              sha256: "manifest",
              contentType: "application/json",
            },
            {
              path: "dist/index.js",
              size: 1,
              storageId: "storage:runtime",
              sha256: "runtime",
              contentType: "application/javascript",
            },
            {
              path: "assets/viewer-runtime.js",
              size: MAX_PUBLISH_FILE_BYTES + 1,
              storageId: "storage:large",
              sha256: "large",
              contentType: "application/javascript",
            },
          ],
          artifact: {
            kind: "npm-pack",
            storageId: "storage:clawpack",
            sha256: "clawpack",
            size: MAX_PUBLISH_FILE_BYTES + 1,
            format: "tgz",
            npmIntegrity: "sha512-test",
            npmShasum: "shasum",
            npmTarballName: "demo-plugin-1.0.0.tgz",
            npmUnpackedSize: MAX_PUBLISH_FILE_BYTES + 1,
            npmFileCount: 4,
          },
        },
      }),
    ).resolves.toEqual({
      ok: true,
      packageId: "packages:demo",
      releaseId: "releases:demo-1",
      publicationStatus: "published",
    });

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        artifactKind: "npm-pack",
        files: expect.arrayContaining([
          expect.objectContaining({
            path: "assets/viewer-runtime.js",
            size: MAX_PUBLISH_FILE_BYTES + 1,
          }),
        ]),
      }),
    );
  });

  it("rejects trusted publish tokens after trusted publisher rotation or deletion", async () => {
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce({
          _id: "packagePublishTokens:1",
          packageId: "packages:demo",
          provider: "github-actions",
          repository: "example/example",
          repositoryId: "1",
          repositoryOwner: "example",
          repositoryOwnerId: "2",
          workflowFilename: "plugin-clawhub-release.yml",
          environment: "clawhub-release",
          version: "1.0.0",
          sha: "abc123",
          ref: "refs/heads/main",
          runId: "100",
          runAttempt: "1",
          expiresAt: Date.now() + 60_000,
        })
        .mockResolvedValueOnce(null),
    };

    await expect(
      publishPackageForTrustedPublisherInternalHandler(ctx as never, {
        publishTokenId: "packagePublishTokens:1",
        payload: {
          name: "demo-plugin",
          family: "bundle-plugin",
          version: "1.0.0",
          changelog: "init",
          bundle: { hostTargets: ["desktop"] },
          files: [],
        },
      }),
    ).rejects.toThrow(
      "Trusted publish token no longer matches the current package trusted publisher",
    );
  });

  it("rejects legacy OpenClaw tokens before trusted publish action work", async () => {
    const ctx = {
      runQuery: vi.fn(async () => ({
        _id: "packagePublishTokens:legacy",
        packageId: "packages:demo",
        provider: "github-actions",
        repository: "openclaw/openclaw",
        repositoryId: "1",
        repositoryOwner: "openclaw",
        repositoryOwnerId: "2",
        workflowFilename: "plugin-clawhub-release.yml",
        environment: "clawhub-release",
        version: "1.0.0",
        sha: "abc123",
        ref: "refs/heads/main",
        runId: "100",
        runAttempt: "1",
        expiresAt: Date.now() + 60_000,
      })),
      runMutation: vi.fn(),
      runAction: vi.fn(),
    };

    await expect(
      publishPackageForTrustedPublisherInternalHandler(ctx as never, {
        publishTokenId: "packagePublishTokens:legacy",
        payload: {
          name: "demo-plugin",
          family: "bundle-plugin",
          version: "1.0.0",
          changelog: "legacy publish",
          bundle: { hostTargets: ["desktop"] },
          files: [],
        },
      }),
    ).rejects.toThrow("OpenClaw trusted publishes require authorization version 2");

    expect(ctx.runQuery).toHaveBeenCalledOnce();
    expect(ctx.runMutation).not.toHaveBeenCalled();
    expect(ctx.runAction).not.toHaveBeenCalled();
  });

  it("binds a split-ref trusted publish to the frozen candidate source", async () => {
    const candidateSha = "b".repeat(40);
    const previousStage = process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES;
    delete process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES;
    const manifestBytes = new TextEncoder().encode(JSON.stringify({ id: "demo.plugin" }));
    const inventoryDigest = await buildPackageInventoryDigest([
      {
        path: packageManifestFile.path,
        size: manifestBytes.byteLength,
        sha256: await sha256Hex(manifestBytes),
      },
    ]);
    vi.mocked(verifyOpenClawPublishAuthorization).mockResolvedValue({
      identity: {
        version: 2,
        repository: "openclaw/openclaw",
        workflow: ".github/workflows/plugin-clawhub-release.yml",
        runId: "100",
        runAttempt: "1",
        ref: "release-publish/tooling",
        fullRef: "refs/tags/release-publish/tooling",
        sha: "c".repeat(40),
        candidateRepository: "openclaw/openclaw",
        candidateSha,
        toolingRef: "release-publish/tooling",
        toolingFullRef: "refs/tags/release-publish/tooling",
        toolingSha: "c".repeat(40),
        parentRepository: "openclaw/openclaw",
        parentWorkflow: ".github/workflows/openclaw-release-publish.yml",
        parentRunId: "99",
        parentRunAttempt: "1",
      },
      authorizationRoute: "automated-awaited",
      artifactId: "101",
      artifactDigest: `sha256:${"d".repeat(64)}`,
      transactionKey: "exact-transaction",
    });
    const runMutation = vi.fn(async (_ref: unknown, args: unknown) => {
      if (
        typeof args === "object" &&
        args !== null &&
        "name" in args &&
        "version" in args &&
        "files" in args
      ) {
        return {
          ok: true,
          packageId: "packages:demo",
          releaseId: "packageReleases:demo-2",
        };
      }
      return null;
    });
    const trustedPublisher = {
      _id: "packageTrustedPublishers:1",
      packageId: "packages:demo",
      provider: "github-actions",
      repository: "openclaw/openclaw",
      repositoryId: "1",
      repositoryOwner: "openclaw",
      repositoryOwnerId: "2",
      workflowFilename: "plugin-clawhub-release.yml",
      environment: "clawhub-release",
    };
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce({
          _id: "packagePublishTokens:1",
          packageId: "packages:demo",
          provider: "github-actions",
          repository: "openclaw/openclaw",
          repositoryId: "1",
          repositoryOwner: "openclaw",
          repositoryOwnerId: "2",
          workflowFilename: "plugin-clawhub-release.yml",
          environment: "clawhub-release",
          version: "1.0.0",
          sha: "c".repeat(40),
          ref: "refs/tags/release-publish/tooling",
          runId: "100",
          runAttempt: "1",
          scope: "publish",
          inventoryDigest,
          authorizationVersion: 2,
          authorizationRoute: "automated-awaited",
          authorizationTransactionKey: "exact-transaction",
          authorizationKey: "exact-transaction:publish",
          authorizationArtifactId: "101",
          authorizationArtifactDigest: `sha256:${"d".repeat(64)}`,
          trustedToolingIdentityJson: '{"version":2}',
          candidateRepository: "openclaw/openclaw",
          candidateSha,
          parentRepository: "openclaw/openclaw",
          parentWorkflow: ".github/workflows/openclaw-release-publish.yml",
          parentRunId: "99",
          parentRunAttempt: "1",
          expiresAt: Date.now() + 60_000,
        })
        .mockResolvedValueOnce(trustedPublisher)
        .mockResolvedValueOnce(makePackageDoc({ family: "bundle-plugin" }))
        .mockResolvedValueOnce(trustedPublisher)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
      runMutation,
      runAction: makePublishRunActionMock(),
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: makePackageManifestStorage(),
    };

    let result: unknown;
    try {
      result = await publishPackageForTrustedPublisherInternalHandler(ctx as never, {
        publishTokenId: "packagePublishTokens:1",
        payload: {
          name: "demo-plugin",
          family: "bundle-plugin",
          version: "1.0.0",
          changelog: "split ref",
          bundle: { hostTargets: ["desktop"] },
          source: {
            kind: "github",
            url: "https://github.com/openclaw/openclaw",
            repo: "openclaw/openclaw",
            ref: candidateSha,
            commit: candidateSha,
            path: "extensions/demo-plugin",
            importedAt: 1,
          },
          files: [packageManifestFile],
        },
      });
    } finally {
      if (previousStage === undefined) {
        delete process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES;
      } else {
        process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES = previousStage;
      }
    }
    expect(result).toMatchObject({
      ok: true,
      packageId: "packages:demo",
      releaseId: "packageReleases:demo-2",
      publicationStatus: "pending",
    });

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source: expect.objectContaining({
          repo: "openclaw/openclaw",
          ref: candidateSha,
          commit: candidateSha,
          path: "extensions/demo-plugin",
        }),
        trustedPublishInventoryDigest: inventoryDigest,
      }),
    );
    expect(runMutation).not.toHaveBeenCalledWith(expect.anything(), {
      tokenId: "packagePublishTokens:1",
    });
    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        packageFollowup: expect.objectContaining({
          trustedPublishTokenId: "packagePublishTokens:1",
          trustedPublishInventoryDigest: inventoryDigest,
          trustedPublishAuthorizationVersion: 2,
        }),
      }),
    );
    expect(verifyOpenClawPublishAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        rawIdentity: '{"version":2}',
        packageName: "demo-plugin",
        version: "1.0.0",
        inventoryDigest,
      }),
    );
  });

  it("accepts and records tag refs for ordinary trusted publishes", async () => {
    const runMutation = vi.fn(async (_ref: unknown, args: unknown) => {
      if (
        typeof args === "object" &&
        args !== null &&
        "name" in args &&
        "version" in args &&
        "files" in args
      ) {
        return {
          ok: true,
          packageId: "packages:demo",
          releaseId: "packageReleases:demo-2",
        };
      }
      return null;
    });
    const trustedPublisher = {
      _id: "packageTrustedPublishers:1",
      packageId: "packages:demo",
      provider: "github-actions",
      repository: "example/example",
      repositoryId: "1",
      repositoryOwner: "example",
      repositoryOwnerId: "2",
      workflowFilename: "plugin-clawhub-release.yml",
      environment: "clawhub-release",
    };
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce({
          _id: "packagePublishTokens:1",
          packageId: "packages:demo",
          provider: "github-actions",
          repository: "example/example",
          repositoryId: "1",
          repositoryOwner: "example",
          repositoryOwnerId: "2",
          workflowFilename: "plugin-clawhub-release.yml",
          environment: "clawhub-release",
          version: "1.0.0",
          sha: "abc123",
          ref: "refs/tags/v1.0.0",
          runId: "100",
          runAttempt: "1",
          expiresAt: Date.now() + 60_000,
        })
        .mockResolvedValueOnce(trustedPublisher)
        .mockResolvedValueOnce(makePackageDoc({ family: "bundle-plugin" }))
        .mockResolvedValueOnce(trustedPublisher)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
      runMutation,
      runAction: makePublishRunActionMock(),
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: makePackageManifestStorage(),
    };

    await expect(
      publishPackageForTrustedPublisherInternalHandler(ctx as never, {
        publishTokenId: "packagePublishTokens:1",
        payload: {
          name: "demo-plugin",
          family: "bundle-plugin",
          version: "1.0.0",
          changelog: "init",
          bundle: { hostTargets: ["desktop"] },
          source: {
            kind: "github",
            url: "https://github.com/example/example",
            repo: "example/example",
            ref: "refs/tags/v1.0.0",
            commit: "abc123",
            path: ".",
            importedAt: 1,
          },
          files: [packageManifestFile],
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      packageId: "packages:demo",
      releaseId: "packageReleases:demo-2",
    });

    expect(runMutation).toHaveBeenCalledWith(expect.anything(), {
      tokenId: "packagePublishTokens:1",
    });
    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source: expect.objectContaining({
          repo: "example/example",
          ref: "refs/tags/v1.0.0",
          commit: "abc123",
          path: ".",
        }),
      }),
    );
  });

  it.each([
    {
      mode: "ordinary commit",
      candidateSha: undefined,
      sourceCommit: "wrong-sha",
      sourceRef: "refs/tags/v1.0.0",
      expectedError: "Trusted publish source commit must match the authorized source commit",
    },
    {
      mode: "ordinary ref",
      candidateSha: undefined,
      sourceCommit: "abc123",
      sourceRef: "refs/tags/v2.0.0",
      expectedError: "Trusted publish source ref must match the authorized source ref",
    },
    {
      mode: "split-candidate commit",
      candidateSha: "candidate-sha",
      sourceCommit: "abc123",
      sourceRef: "candidate-sha",
      expectedError: "Trusted publish source commit must match the authorized source commit",
    },
    {
      mode: "split-candidate ref",
      candidateSha: "candidate-sha",
      sourceCommit: "candidate-sha",
      sourceRef: "refs/tags/v1.0.0",
      expectedError: "Trusted publish source ref must match the authorized source ref",
    },
  ])(
    "rejects $mode mismatches",
    async ({ candidateSha, sourceCommit, sourceRef, expectedError }) => {
      const trustedPublisher = {
        _id: "packageTrustedPublishers:1",
        packageId: "packages:demo",
        provider: "github-actions",
        repository: "example/example",
        repositoryId: "1",
        repositoryOwner: "example",
        repositoryOwnerId: "2",
        workflowFilename: "plugin-clawhub-release.yml",
        environment: "clawhub-release",
      };
      const ctx = {
        runQuery: vi
          .fn()
          .mockResolvedValueOnce({
            _id: "packagePublishTokens:1",
            packageId: "packages:demo",
            provider: "github-actions",
            repository: "example/example",
            repositoryId: "1",
            repositoryOwner: "example",
            repositoryOwnerId: "2",
            workflowFilename: "plugin-clawhub-release.yml",
            environment: "clawhub-release",
            version: "1.0.0",
            sha: "abc123",
            ref: "refs/tags/v1.0.0",
            runId: "100",
            runAttempt: "1",
            candidateSha,
            expiresAt: Date.now() + 60_000,
          })
          .mockResolvedValueOnce(trustedPublisher)
          .mockResolvedValueOnce(makePackageDoc({ family: "bundle-plugin" }))
          .mockResolvedValueOnce(trustedPublisher),
      };

      await expect(
        publishPackageForTrustedPublisherInternalHandler(ctx as never, {
          publishTokenId: "packagePublishTokens:1",
          payload: {
            name: "demo-plugin",
            family: "bundle-plugin",
            version: "1.0.0",
            changelog: "init",
            bundle: { hostTargets: ["desktop"] },
            source: {
              kind: "github",
              url: "https://github.com/example/example",
              repo: "example/example",
              ref: sourceRef,
              commit: sourceCommit,
              path: ".",
              importedAt: 1,
            },
            files: [packageManifestFile],
          },
        }),
      ).rejects.toThrow(expectedError);

      expect(ctx.runQuery).toHaveBeenCalledTimes(4);
    },
  );

  it("revokes trusted publish tokens when a staged publish is accepted for checks", async () => {
    const previousFlag = process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES;
    process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES = "1";
    const runMutation = vi.fn(async (_ref: unknown, args: unknown) => {
      if (
        typeof args === "object" &&
        args !== null &&
        "publicationStatus" in args &&
        (args as { publicationStatus?: string }).publicationStatus === "pending"
      ) {
        return {
          ok: true,
          packageId: "packages:demo",
          releaseId: "packageReleases:pending",
          publicationStatus: "pending",
          createdNewParent: false,
        };
      }
      if (
        typeof args === "object" &&
        args !== null &&
        "packageReleaseId" in args &&
        "packageFollowup" in args
      ) {
        return {
          attemptId: "publishAttempts:demo",
          status: "pending_checks",
        };
      }
      return null;
    });
    const trustedPublisher = {
      _id: "packageTrustedPublishers:1",
      packageId: "packages:demo",
      provider: "github-actions",
      repository: "example/example",
      repositoryId: "1",
      repositoryOwner: "example",
      repositoryOwnerId: "2",
      workflowFilename: "plugin-clawhub-release.yml",
      environment: "clawhub-release",
    };
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce({
          _id: "packagePublishTokens:1",
          packageId: "packages:demo",
          provider: "github-actions",
          repository: "example/example",
          repositoryId: "1",
          repositoryOwner: "example",
          repositoryOwnerId: "2",
          workflowFilename: "plugin-clawhub-release.yml",
          environment: "clawhub-release",
          version: "1.0.0",
          sha: "abc123",
          ref: "refs/heads/main",
          runId: "100",
          runAttempt: "1",
          expiresAt: Date.now() + 60_000,
        })
        .mockResolvedValueOnce(trustedPublisher)
        .mockResolvedValueOnce(makePackageDoc({ family: "bundle-plugin" }))
        .mockResolvedValueOnce(trustedPublisher)
        .mockResolvedValueOnce(null),
      runMutation,
      runAction: makePublishRunActionMock(),
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: makePackageManifestStorage(),
    };

    try {
      await expect(
        publishPackageForTrustedPublisherInternalHandler(ctx as never, {
          publishTokenId: "packagePublishTokens:1",
          payload: {
            name: "demo-plugin",
            family: "bundle-plugin",
            version: "1.0.0",
            changelog: "init",
            bundle: { hostTargets: ["desktop"] },
            files: [packageManifestFile],
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
        status: "pending",
        packageId: "packages:demo",
        releaseId: "packageReleases:pending",
        publicationStatus: "pending",
        attemptId: "publishAttempts:demo",
        packageName: "demo-plugin",
        version: "1.0.0",
      });
    } finally {
      if (previousFlag === undefined) {
        delete process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES;
      } else {
        process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES = previousFlag;
      }
    }

    expect(runMutation).toHaveBeenCalledWith(expect.anything(), {
      tokenId: "packagePublishTokens:1",
    });
    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        packageId: "packages:demo",
        packageReleaseId: "packageReleases:pending",
        scanContext: expect.any(Object),
      }),
    );
  });

  it("cleans up orphan pending package releases instead of wedging future retries", async () => {
    const previousFlag = process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES;
    process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES = "1";
    const runMutation = vi.fn(async (_ref: unknown, args: unknown) => {
      if (
        typeof args === "object" &&
        args !== null &&
        "publicationStatus" in args &&
        (args as { publicationStatus?: string }).publicationStatus === "pending"
      ) {
        throw new Error("orphan recovery should not insert a second pending release");
      }
      if (
        typeof args === "object" &&
        args !== null &&
        "packageReleaseId" in args &&
        "packageFollowup" in args
      ) {
        throw new Error("orphan cleanup should reject before creating a publish attempt");
      }
      if (
        typeof args === "object" &&
        args !== null &&
        "releaseId" in args &&
        "createdNewParent" in args
      ) {
        return { deleted: true, parentDeleted: true };
      }
      return null;
    });
    const trustedPublisher = {
      _id: "packageTrustedPublishers:1",
      packageId: "packages:demo",
      provider: "github-actions",
      repository: "example/example",
      repositoryId: "1",
      repositoryOwner: "example",
      repositoryOwnerId: "2",
      workflowFilename: "plugin-clawhub-release.yml",
      environment: "clawhub-release",
    };
    const orphanParent = makePackageDoc({
      latestReleaseId: undefined,
      latestVersionSummary: undefined,
      stats: { downloads: 0, installs: 0, stars: 0, versions: 0 },
    });
    const orphanRelease = makeReleaseDoc({
      _id: "packageReleases:orphan",
      packageId: "packages:demo",
      integritySha256: "b8107c6a51a6a7554e20d2963348212b80bc816fb59492ee163792103a6b7df6",
      publicationStatus: "pending",
    });
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce({
          _id: "packagePublishTokens:1",
          packageId: "packages:demo",
          provider: "github-actions",
          repository: "example/example",
          repositoryId: "1",
          repositoryOwner: "example",
          repositoryOwnerId: "2",
          workflowFilename: "plugin-clawhub-release.yml",
          environment: "clawhub-release",
          version: "1.0.0",
          sha: "abc123",
          ref: "refs/heads/main",
          runId: "100",
          runAttempt: "1",
          expiresAt: Date.now() + 60_000,
        })
        .mockResolvedValueOnce(trustedPublisher)
        .mockResolvedValueOnce(orphanParent)
        .mockResolvedValueOnce(trustedPublisher)
        .mockResolvedValueOnce(orphanRelease)
        .mockResolvedValueOnce(null),
      runMutation,
      runAction: makePublishRunActionMock(),
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: makePackageManifestStorage(),
    };

    try {
      await expect(
        publishPackageForTrustedPublisherInternalHandler(ctx as never, {
          publishTokenId: "packagePublishTokens:1",
          payload: {
            name: "demo-plugin",
            family: "bundle-plugin",
            version: "1.0.0",
            changelog: "init",
            bundle: { hostTargets: ["desktop"] },
            files: [packageManifestFile],
          },
        }),
      ).rejects.toThrow(
        "Previous pending publish for 1.0.0 did not finish creating security checks. It was cleaned up; retry the publish.",
      );
    } finally {
      if (previousFlag === undefined) {
        delete process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES;
      } else {
        process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES = previousFlag;
      }
    }

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        packageId: "packages:demo",
        releaseId: "packageReleases:orphan",
        createdNewParent: true,
      }),
    );
  });

  it("cleans up pending package releases when staged publish attempt creation fails", async () => {
    const previousFlag = process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES;
    process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES = "1";
    const runMutation = vi.fn(async (_ref: unknown, args: unknown) => {
      if (
        typeof args === "object" &&
        args !== null &&
        "publicationStatus" in args &&
        (args as { publicationStatus?: string }).publicationStatus === "pending"
      ) {
        return {
          ok: true,
          packageId: "packages:demo",
          releaseId: "packageReleases:pending",
          publicationStatus: "pending",
          createdNewParent: false,
        };
      }
      if (typeof args === "object" && args !== null && "packageReleaseId" in args) {
        throw new Error("attempt creation outage");
      }
      if (
        typeof args === "object" &&
        args !== null &&
        "releaseId" in args &&
        "createdNewParent" in args
      ) {
        return { deleted: true, parentDeleted: true };
      }
      return null;
    });
    const trustedPublisher = {
      _id: "packageTrustedPublishers:1",
      packageId: "packages:demo",
      provider: "github-actions",
      repository: "example/example",
      repositoryId: "1",
      repositoryOwner: "example",
      repositoryOwnerId: "2",
      workflowFilename: "plugin-clawhub-release.yml",
      environment: "clawhub-release",
    };
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce({
          _id: "packagePublishTokens:1",
          packageId: "packages:demo",
          provider: "github-actions",
          repository: "example/example",
          repositoryId: "1",
          repositoryOwner: "example",
          repositoryOwnerId: "2",
          workflowFilename: "plugin-clawhub-release.yml",
          environment: "clawhub-release",
          version: "1.0.0",
          sha: "abc123",
          ref: "refs/heads/main",
          runId: "100",
          runAttempt: "1",
          expiresAt: Date.now() + 60_000,
        })
        .mockResolvedValueOnce(trustedPublisher)
        .mockResolvedValueOnce(makePackageDoc({ family: "bundle-plugin" }))
        .mockResolvedValueOnce(trustedPublisher)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
      runMutation,
      runAction: makePublishRunActionMock(),
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: makePackageManifestStorage(),
    };

    try {
      await expect(
        publishPackageForTrustedPublisherInternalHandler(ctx as never, {
          publishTokenId: "packagePublishTokens:1",
          payload: {
            name: "demo-plugin",
            family: "bundle-plugin",
            version: "1.0.0",
            changelog: "init",
            bundle: { hostTargets: ["desktop"] },
            files: [packageManifestFile],
          },
        }),
      ).rejects.toThrow("attempt creation outage");
    } finally {
      if (previousFlag === undefined) {
        delete process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES;
      } else {
        process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES = previousFlag;
      }
    }

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        packageId: "packages:demo",
        releaseId: "packageReleases:pending",
        createdNewParent: false,
      }),
    );
    expect(runMutation).not.toHaveBeenCalledWith(expect.anything(), {
      tokenId: "packagePublishTokens:1",
    });
  });

  it("rejects duplicate staged package releases before creating a publish attempt", async () => {
    const previousFlag = process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES;
    process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES = "1";
    const runMutation = vi.fn(async () => {
      throw new Error("duplicate publish should not create an attempt");
    });
    const trustedPublisher = {
      _id: "packageTrustedPublishers:1",
      packageId: "packages:demo",
      provider: "github-actions",
      repository: "example/example",
      repositoryId: "1",
      repositoryOwner: "example",
      repositoryOwnerId: "2",
      workflowFilename: "plugin-clawhub-release.yml",
      environment: "clawhub-release",
    };
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce({
          _id: "packagePublishTokens:1",
          packageId: "packages:demo",
          provider: "github-actions",
          repository: "example/example",
          repositoryId: "1",
          repositoryOwner: "example",
          repositoryOwnerId: "2",
          workflowFilename: "plugin-clawhub-release.yml",
          environment: "clawhub-release",
          version: "1.0.0",
          sha: "abc123",
          ref: "refs/heads/main",
          runId: "100",
          runAttempt: "1",
          expiresAt: Date.now() + 60_000,
        })
        .mockResolvedValueOnce(trustedPublisher)
        .mockResolvedValueOnce(makePackageDoc({ family: "bundle-plugin" }))
        .mockResolvedValueOnce(trustedPublisher)
        .mockResolvedValueOnce(
          makeReleaseDoc({
            integritySha256: "different-existing-artifact",
          }),
        ),
      runMutation,
      runAction: makePublishRunActionMock(),
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: makePackageManifestStorage(),
    };

    try {
      await expect(
        publishPackageForTrustedPublisherInternalHandler(ctx as never, {
          publishTokenId: "packagePublishTokens:1",
          payload: {
            name: "demo-plugin",
            family: "bundle-plugin",
            version: "1.0.0",
            changelog: "duplicate",
            bundle: { hostTargets: ["desktop"] },
            files: [packageManifestFile],
          },
        }),
      ).rejects.toThrow(
        "Version 1.0.0 already exists. Increment the version number and try again.",
      );
    } finally {
      if (previousFlag === undefined) {
        delete process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES;
      } else {
        process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES = previousFlag;
      }
    }

    expect(runMutation).not.toHaveBeenCalled();
  });

  it("rejects staged package releases reserved by a retained publish attempt", async () => {
    const previousFlag = process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES;
    process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES = "1";
    const runMutation = vi.fn(async () => {
      throw new Error("duplicate publish should not create an attempt");
    });
    const trustedPublisher = {
      _id: "packageTrustedPublishers:1",
      packageId: "packages:demo",
      provider: "github-actions",
      repository: "example/example",
      repositoryId: "1",
      repositoryOwner: "example",
      repositoryOwnerId: "2",
      workflowFilename: "plugin-clawhub-release.yml",
      environment: "clawhub-release",
    };
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce({
          _id: "packagePublishTokens:1",
          packageId: "packages:demo",
          provider: "github-actions",
          repository: "example/example",
          repositoryId: "1",
          repositoryOwner: "example",
          repositoryOwnerId: "2",
          workflowFilename: "plugin-clawhub-release.yml",
          environment: "clawhub-release",
          version: "1.0.0",
          sha: "abc123",
          ref: "refs/heads/main",
          runId: "100",
          runAttempt: "1",
          expiresAt: Date.now() + 60_000,
        })
        .mockResolvedValueOnce(trustedPublisher)
        .mockResolvedValueOnce(makePackageDoc({ family: "bundle-plugin" }))
        .mockResolvedValueOnce(trustedPublisher)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          attemptId: "publishAttempts:secret-blocked",
          status: "blocked",
        }),
      runMutation,
      runAction: makePublishRunActionMock(),
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: makePackageManifestStorage(),
    };

    try {
      await expect(
        publishPackageForTrustedPublisherInternalHandler(ctx as never, {
          publishTokenId: "packagePublishTokens:1",
          payload: {
            name: "demo-plugin",
            family: "bundle-plugin",
            version: "1.0.0",
            changelog: "duplicate",
            bundle: { hostTargets: ["desktop"] },
            files: [packageManifestFile],
          },
        }),
      ).rejects.toThrow(
        "Version 1.0.0 already exists. Increment the version number and try again.",
      );
    } finally {
      if (previousFlag === undefined) {
        delete process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES;
      } else {
        process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES = previousFlag;
      }
    }

    expect(runMutation).not.toHaveBeenCalled();
  });

  it("accepts trusted publish tokens when no environment is pinned", async () => {
    const runMutation = vi.fn(async (_ref: unknown, args: unknown) => {
      if (
        typeof args === "object" &&
        args !== null &&
        "name" in args &&
        "version" in args &&
        "files" in args
      ) {
        return {
          ok: true,
          packageId: "packages:demo",
          releaseId: "packageReleases:demo-2",
        };
      }
      return null;
    });
    const trustedPublisher = {
      _id: "packageTrustedPublishers:1",
      packageId: "packages:demo",
      provider: "github-actions",
      repository: "example/example",
      repositoryId: "1",
      repositoryOwner: "example",
      repositoryOwnerId: "2",
      workflowFilename: "plugin-clawhub-release.yml",
    };
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce({
          _id: "packagePublishTokens:1",
          packageId: "packages:demo",
          provider: "github-actions",
          repository: "example/example",
          repositoryId: "1",
          repositoryOwner: "example",
          repositoryOwnerId: "2",
          workflowFilename: "plugin-clawhub-release.yml",
          version: "1.0.0",
          sha: "abc123",
          ref: "refs/heads/main",
          runId: "100",
          runAttempt: "1",
          expiresAt: Date.now() + 60_000,
        })
        .mockResolvedValueOnce(trustedPublisher)
        .mockResolvedValueOnce(makePackageDoc({ family: "bundle-plugin" }))
        .mockResolvedValueOnce(trustedPublisher)
        .mockResolvedValueOnce(null),
      runMutation,
      runAction: makePublishRunActionMock(),
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: makePackageManifestStorage(),
    };

    await expect(
      publishPackageForTrustedPublisherInternalHandler(ctx as never, {
        publishTokenId: "packagePublishTokens:1",
        payload: {
          name: "demo-plugin",
          family: "bundle-plugin",
          version: "1.0.0",
          changelog: "init",
          bundle: { hostTargets: ["desktop"] },
          files: [packageManifestFile],
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      packageId: "packages:demo",
      releaseId: "packageReleases:demo-2",
    });
  });

  it("requires manual override for user-auth publishes when trusted publisher config exists", async () => {
    const runMutation = vi.fn(async (_ref: unknown, args: unknown) => {
      if (
        typeof args === "object" &&
        args !== null &&
        "actorUserId" in args &&
        "minimumRole" in args
      ) {
        return null;
      }
      if (
        typeof args === "object" &&
        args !== null &&
        "name" in args &&
        "version" in args &&
        "files" in args
      ) {
        return {
          ok: true,
          packageId: "packages:demo",
          releaseId: "packageReleases:demo-2",
        };
      }
      return null;
    });
    const trustedPublisher = {
      _id: "packageTrustedPublishers:1",
      packageId: "packages:demo",
      provider: "github-actions",
      repository: "openclaw/openclaw",
      repositoryId: "1",
      repositoryOwner: "openclaw",
      repositoryOwnerId: "2",
      workflowFilename: "plugin-clawhub-release.yml",
      environment: "clawhub-release",
    };
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce(makePackageDoc({ family: "bundle-plugin" }))
        .mockResolvedValueOnce(trustedPublisher)
        .mockResolvedValueOnce({
          _id: "users:owner",
          role: "user",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "users:owner",
          role: "user",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce(null),
      runMutation,
      runAction: makePublishRunActionMock(),
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: {
        get: vi.fn(),
      },
    };

    await expect(
      publishPackageForUserInternalHandler(ctx as never, {
        actorUserId: "users:owner",
        payload: {
          name: "demo-plugin",
          family: "bundle-plugin",
          version: "1.0.0",
          changelog: "tag publish",
          bundle: { hostTargets: ["desktop"] },
          source: {
            kind: "github",
            url: "https://github.com/openclaw/openclaw",
            repo: "openclaw/openclaw",
            ref: "refs/tags/plugins-2026.4.1-beta.1",
            commit: "abc123",
            path: "extensions/discord",
            importedAt: Date.now(),
          },
          files: [],
        },
      }),
    ).rejects.toThrow(
      "Manual publishes for packages with trusted publisher config require manualOverrideReason",
    );
  });

  it("lets admins user-publish trusted packages without a manual override reason", async () => {
    const runMutation = vi.fn(async (_ref: unknown, args: unknown) => {
      if (
        typeof args === "object" &&
        args !== null &&
        "actorUserId" in args &&
        "minimumRole" in args
      ) {
        return { publisherId: "publishers:openclaw" };
      }
      return null;
    });
    const trustedPublisher = {
      _id: "packageTrustedPublishers:1",
      packageId: "packages:demo",
      provider: "github-actions",
      repository: "openclaw/openclaw",
      repositoryId: "1",
      repositoryOwner: "openclaw",
      repositoryOwnerId: "2",
      workflowFilename: "plugin-clawhub-release.yml",
      environment: "clawhub-release",
    };
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce(makePackageDoc({ family: "bundle-plugin" }))
        .mockResolvedValueOnce(trustedPublisher)
        .mockResolvedValueOnce({
          _id: "users:admin",
          role: "admin",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "users:admin",
          role: "admin",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce(null),
      runMutation,
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: {
        get: vi.fn(),
      },
    };

    await expect(
      publishPackageForUserInternalHandler(ctx as never, {
        actorUserId: "users:admin",
        payload: {
          name: "@openclaw/discord",
          family: "bundle-plugin",
          version: "2026.5.3-beta.2",
          changelog: "tag publish",
          bundle: { hostTargets: ["desktop"] },
          source: {
            kind: "github",
            url: "https://github.com/openclaw/openclaw",
            repo: "openclaw/openclaw",
            ref: "refs/tags/plugins-2026.5.3-beta.2",
            commit: "abc123",
            path: "extensions/discord",
            importedAt: Date.now(),
          },
          files: [],
        },
      }),
    ).rejects.toThrow("openclaw.plugin.json is required");
  });

  it("allows package names that match an unrelated skill slug", async () => {
    const storedFiles = new Map<string, string>([
      [
        "storage:package",
        JSON.stringify({
          name: "shared-slug",
          openclaw: {
            extensions: ["./dist/index.js"],
            hostTargets: ["darwin-arm64", "linux-x64"],
            environment: {},
            compat: { pluginApi: "^1.0.0" },
            build: { openclawVersion: "2026.3.14" },
            configSchema: { type: "object" },
          },
        }),
      ],
      ["storage:manifest", JSON.stringify({ id: "shared.plugin" })],
      ["storage:code", "export default {};"],
    ]);
    const runMutation = vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
      if (args.minimumRole === "publisher") {
        return { publisherId: "publishers:owner", linkedUserId: "users:owner" };
      }
      if ("name" in args && "version" in args && "files" in args) {
        return { ok: true, packageId: "packages:demo", releaseId: "releases:demo-1" };
      }
      return null;
    });
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          _id: "users:owner",
          role: "user",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "users:owner",
          role: "user",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "publishers:owner",
          kind: "user",
          handle: "owner",
          linkedUserId: "users:owner",
        }),
      runMutation,
      runAction: makePublishRunActionMock(),
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: {
        get: vi.fn(async (storageId: string) => {
          const content = storedFiles.get(storageId);
          return content ? new Blob([content]) : null;
        }),
        store: vi.fn(async () => "storage:legacy-zip"),
      },
    };

    const result = await publishPackageForUserInternalHandler(ctx as never, {
      actorUserId: "users:owner",
      payload: {
        name: "shared-slug",
        displayName: "Shared Slug Plugin",
        family: "code-plugin",
        version: "1.0.0",
        changelog: "init",
        source: {
          kind: "github",
          url: "https://github.com/openclaw/shared-slug",
          repo: "openclaw/shared-slug",
          ref: "refs/tags/v1.0.0",
          commit: "abc123",
          path: ".",
          importedAt: Date.now(),
        },
        files: [
          {
            path: "package.json",
            size: 1,
            storageId: "storage:package",
            sha256: "package",
            contentType: "application/json",
          },
          {
            path: "openclaw.plugin.json",
            size: 1,
            storageId: "storage:manifest",
            sha256: "manifest",
            contentType: "application/json",
          },
          {
            path: "dist/index.js",
            size: 1,
            storageId: "storage:code",
            sha256: "code",
            contentType: "application/javascript",
          },
        ],
      },
    });

    expect(result).toMatchObject({
      ok: true,
      packageId: "packages:demo",
      releaseId: "releases:demo-1",
    });
    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "shared-slug",
        ownerPublisherId: "publishers:owner",
      }),
    );
  });

  it("forwards only valid HTTPS plugin manifest icons to release insertion", async () => {
    async function publishWithManifestIcon(icon: unknown) {
      const runMutation = vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
        if (args.minimumRole === "publisher") {
          return { publisherId: "publishers:owner", linkedUserId: "users:owner" };
        }
        if ("name" in args && "version" in args && "files" in args) {
          return { ok: true, packageId: "packages:demo", releaseId: "releases:demo-1" };
        }
        return null;
      });
      const storedFiles = new Map<string, string>([
        [
          "storage:package",
          JSON.stringify({
            name: "demo-plugin",
            openclaw: {
              extensions: ["./dist/index.js"],
              hostTargets: ["darwin-arm64", "linux-x64"],
              environment: {},
              compat: { pluginApi: "^1.0.0" },
              build: { openclawVersion: "2026.3.14" },
              configSchema: { type: "object" },
            },
          }),
        ],
        ["storage:manifest", JSON.stringify({ id: "demo.plugin", icon })],
        ["storage:code", "export default {};"],
      ]);
      const ctx = {
        runQuery: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            _id: "users:owner",
            role: "user",
            githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
          })
          .mockResolvedValueOnce({
            _id: "users:owner",
            role: "user",
            githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
          })
          .mockResolvedValueOnce({
            _id: "publishers:owner",
            kind: "user",
            handle: "owner",
            linkedUserId: "users:owner",
          }),
        runMutation,
        runAction: makePublishRunActionMock(),
        scheduler: {
          runAfter: vi.fn(),
        },
        storage: {
          get: vi.fn(async (storageId: string) => {
            const content = storedFiles.get(storageId);
            return content ? new Blob([content]) : null;
          }),
          store: vi.fn(async () => "storage:legacy-zip"),
        },
      };

      await publishPackageForUserInternalHandler(ctx as never, {
        actorUserId: "users:owner",
        payload: {
          name: "demo-plugin",
          displayName: "Demo Plugin",
          family: "code-plugin",
          version: "1.0.0",
          changelog: "init",
          source: {
            kind: "github",
            url: "https://github.com/openclaw/demo-plugin",
            repo: "openclaw/demo-plugin",
            ref: "refs/tags/v1.0.0",
            commit: "abc123",
            path: ".",
            importedAt: Date.now(),
          },
          files: [
            {
              path: "package.json",
              size: 1,
              storageId: "storage:package",
              sha256: "package",
              contentType: "application/json",
            },
            {
              path: "openclaw.plugin.json",
              size: 1,
              storageId: "storage:manifest",
              sha256: "manifest",
              contentType: "application/json",
            },
            {
              path: "dist/index.js",
              size: 1,
              storageId: "storage:code",
              sha256: "code",
              contentType: "application/javascript",
            },
          ],
        },
      });

      const insertCall = runMutation.mock.calls.find(
        ([, args]) =>
          typeof args === "object" &&
          args !== null &&
          (args as { name?: string }).name === "demo-plugin" &&
          (args as { version?: string }).version === "1.0.0",
      );
      return insertCall?.[1] as Record<string, unknown>;
    }

    await expect(
      publishWithManifestIcon("https://cdn.example.test/icons/demo.svg"),
    ).resolves.toMatchObject({ icon: "https://cdn.example.test/icons/demo.svg" });

    for (const icon of [
      "http://cdn.example.test/icons/demo.svg",
      "/icons/demo.svg",
      "not a url",
      "",
      123,
      { src: "https://cdn.example.test/icons/demo.svg" },
    ]) {
      await expect(publishWithManifestIcon(icon)).resolves.not.toHaveProperty("icon");
    }
  });

  it("scans plugin publishes and forwards scan status to insertReleaseInternal", async () => {
    const runMutation = vi.fn(async (_ref: unknown, args: unknown) => args);
    const storedFiles = new Map<string, string>([
      [
        "storage:package",
        JSON.stringify({
          $schema: "https://json.schemastore.org/package.json",
          name: "demo-plugin",
          keywords: [
            "one",
            "two",
            "three",
            "four",
            "five",
            "six",
            "seven",
            "eight",
            "nine",
            "a".repeat(33),
          ],
          openclaw: {
            extensions: ["./dist/index.js"],
            hostTargets: ["darwin-arm64", "linux-x64"],
            environment: {},
            compat: { pluginApi: "^1.0.0" },
            build: { openclawVersion: "2026.3.14" },
            configSchema: { type: "object" },
          },
        }),
      ],
      [
        "storage:manifest",
        JSON.stringify({
          id: "demo.plugin",
          categories: ["security"],
          topics: ["Manifest Topic"],
          contracts: { tools: ["demoTool"] },
        }),
      ],
      [
        "storage:code",
        "import { execSync } from 'node:child_process';\nexecSync('curl http://x');\n",
      ],
    ]);
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce(makePackageDoc({ categories: ["retired-category"] }))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          _id: "users:owner",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "users:owner",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce(null),
      runMutation,
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: {
        get: vi.fn(async (storageId: string) => {
          const content = storedFiles.get(storageId);
          return content ? new Blob([content]) : null;
        }),
        store: vi.fn(async () => "storage:legacy-zip"),
      },
      runAction: makePublishRunActionMock(() => ({
        status: "pass",
        summary: {
          breakageCount: 0,
          warningCount: 0,
          deprecationWarningCount: 0,
          issueCount: 0,
        },
        warnings: [],
      })),
    };

    const result = (await publishPackageForUserInternalHandler(ctx as never, {
      actorUserId: "users:owner",
      payload: {
        name: "demo-plugin",
        displayName: "Demo Plugin",
        family: "code-plugin",
        version: "1.0.0",
        changelog: "init",
        source: {
          kind: "github",
          url: "https://github.com/openclaw/demo-plugin",
          repo: "openclaw/demo-plugin",
          ref: "refs/tags/v1.0.0",
          commit: "abc123",
          path: ".",
          importedAt: Date.now(),
        },
        files: [
          {
            path: "package.json",
            size: 1,
            storageId: "storage:package",
            sha256: "package",
            contentType: "application/json",
          },
          {
            path: "openclaw.plugin.json",
            size: 1,
            storageId: "storage:manifest",
            sha256: "manifest",
            contentType: "application/json",
          },
          {
            path: "dist/index.js",
            size: 1,
            storageId: "storage:code",
            sha256: "code",
            contentType: "application/javascript",
          },
        ],
      },
    })) as Record<string, unknown>;
    const expectedLegacyZipSha256 = await sha256Hex(
      buildDeterministicPackageZip([
        {
          path: "package.json",
          bytes: new TextEncoder().encode(storedFiles.get("storage:package")),
        },
        {
          path: "openclaw.plugin.json",
          bytes: new TextEncoder().encode(storedFiles.get("storage:manifest")),
        },
        {
          path: "dist/index.js",
          bytes: new TextEncoder().encode(storedFiles.get("storage:code")),
        },
      ]),
    );

    expect(runMutation).toHaveBeenCalled();
    expect(result.categories).toEqual(["other"]);
    expect(result.topics).toBeUndefined();
    expect(result.sha256hash).toBe(expectedLegacyZipSha256);
    expect(result.verification).toEqual(expect.objectContaining({ scanStatus: "pending" }));
    expect(result.staticScan).toEqual(
      expect.objectContaining({
        status: "suspicious",
        reasonCodes: expect.arrayContaining(["suspicious.dangerous_exec"]),
      }),
    );
    expect(ctx.scheduler.runAfter).toHaveBeenNthCalledWith(
      1,
      30_000,
      expect.anything(),
      expect.any(Object),
    );
  });

  it("blocks plugin publishes when plugin inspector reports hard breakages", async () => {
    const runMutation = vi.fn(async (_ref: unknown, args: unknown) => {
      if (typeof args === "object" && args !== null && "minimumRole" in args) return null;
      return args;
    });
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          _id: "users:owner",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "users:owner",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce(null),
      runMutation,
      runAction: vi.fn(async () => ({
        status: "fail",
        summary: {
          breakageCount: 1,
          warningCount: 0,
          deprecationWarningCount: 0,
          issueCount: 1,
        },
        warnings: [],
        breakages: [
          {
            code: "missing-expected-seam",
            severity: "P0",
            message: "missing expected registration registerTool",
            evidence: ["registerTool"],
          },
        ],
      })),
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: {
        get: vi.fn(async (storageId: string) => {
          const files = new Map<string, string>([
            [
              "storage:package",
              JSON.stringify({
                name: "demo-plugin",
                openclaw: {
                  extensions: ["./dist/index.js"],
                  compat: { pluginApi: "^1.0.0" },
                  build: { openclawVersion: "2026.3.14" },
                  configSchema: { type: "object" },
                },
              }),
            ],
            ["storage:manifest", JSON.stringify({ id: "demo.plugin" })],
            ["storage:code", "export const demo = true;\n"],
          ]);
          const content = files.get(storageId);
          return content ? new Blob([content]) : null;
        }),
        store: vi.fn(async () => "storage:legacy-zip"),
      },
    };

    await expect(
      publishPackageForUserInternalHandler(ctx as never, {
        actorUserId: "users:owner",
        payload: {
          name: "demo-plugin",
          displayName: "Demo Plugin",
          family: "code-plugin",
          version: "1.0.0",
          changelog: "init",
          source: {
            kind: "github",
            url: "https://github.com/openclaw/demo-plugin",
            repo: "openclaw/demo-plugin",
            ref: "refs/tags/v1.0.0",
            commit: "abc123",
            path: ".",
            importedAt: Date.now(),
          },
          files: [
            {
              path: "package.json",
              size: 1,
              storageId: "storage:package",
              sha256: "package",
              contentType: "application/json",
            },
            {
              path: "openclaw.plugin.json",
              size: 1,
              storageId: "storage:manifest",
              sha256: "manifest",
              contentType: "application/json",
            },
            {
              path: "dist/index.js",
              size: 1,
              storageId: "storage:code",
              sha256: "code",
              contentType: "application/javascript",
            },
          ],
        },
      }),
    ).rejects.toThrow(/Plugin Inspector blocked publish: 1 breakage/);

    expect(runMutation).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ version: "1.0.0" }),
    );
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });

  it("stores plugin inspector warnings after successful warning-only publishes", async () => {
    const runMutation = vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
      if ("minimumRole" in args) return null;
      if ("warnings" in args) return { ok: true, inserted: 1 };
      return { ok: true, packageId: "packages:demo", releaseId: "packageReleases:demo-1" };
    });
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          _id: "users:owner",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "users:owner",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce(null),
      runMutation,
      runAction: vi.fn(async () => ({
        status: "pass",
        summary: {
          breakageCount: 0,
          warningCount: 1,
          deprecationWarningCount: 1,
          issueCount: 1,
        },
        warnings: [
          {
            id: "demo:legacy-before-agent-start",
            code: "legacy-before-agent-start",
            severity: "P2",
            issueClass: "deprecation-warning",
            compatStatus: "deprecated",
            message: "legacy before_agent_start hook is deprecated",
            evidence: ["src/index.ts:4"],
            authorRemediation: {
              summary: "Move prompt mutation work to before_prompt_build.",
              docsUrl:
                "https://docs.openclaw.ai/clawhub/plugin-validation-fixes#legacy-before-agent-start",
            },
          },
        ],
        metadata: {
          inspectorVersion: "0.3.19",
          targetOpenClawVersion: "2026.7.1-2",
        },
      })),
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: {
        get: vi.fn(async (storageId: string) => {
          const files = new Map<string, string>([
            [
              "storage:package",
              JSON.stringify({
                name: "demo-plugin",
                openclaw: {
                  extensions: ["./dist/index.js"],
                  compat: { pluginApi: "^1.0.0" },
                  build: { openclawVersion: "2026.3.14" },
                  configSchema: { type: "object" },
                },
              }),
            ],
            ["storage:manifest", JSON.stringify({ id: "demo.plugin" })],
            ["storage:code", "export const demo = true;\n"],
          ]);
          const content = files.get(storageId);
          return content ? new Blob([content]) : null;
        }),
        store: vi.fn(async () => "storage:legacy-zip"),
      },
    };

    await publishPackageForUserInternalHandler(ctx as never, {
      actorUserId: "users:owner",
      payload: {
        name: "demo-plugin",
        displayName: "Demo Plugin",
        family: "code-plugin",
        version: "1.0.0",
        changelog: "init",
        source: {
          kind: "github",
          url: "https://github.com/openclaw/demo-plugin",
          repo: "openclaw/demo-plugin",
          ref: "refs/tags/v1.0.0",
          commit: "abc123",
          path: ".",
          importedAt: Date.now(),
        },
        files: [
          {
            path: "package.json",
            size: 1,
            storageId: "storage:package",
            sha256: "package",
            contentType: "application/json",
          },
          {
            path: "openclaw.plugin.json",
            size: 1,
            storageId: "storage:manifest",
            sha256: "manifest",
            contentType: "application/json",
          },
          {
            path: "dist/index.js",
            size: 1,
            storageId: "storage:code",
            sha256: "code",
            contentType: "application/javascript",
          },
        ],
      },
    });

    const inspectorWarningCall = runMutation.mock.calls.find(
      ([, args]) =>
        typeof args === "object" &&
        args !== null &&
        (args as { packageId?: string }).packageId === "packages:demo" &&
        Array.isArray((args as { findings?: unknown[] }).findings),
    );
    expect(inspectorWarningCall?.[1]).toMatchObject({
      packageId: "packages:demo",
      releaseId: "packageReleases:demo-1",
      packageName: "demo-plugin",
      version: "1.0.0",
      inspectorVersion: "0.3.19",
      targetOpenClawVersion: "2026.7.1-2",
      findings: [
        expect.objectContaining({
          code: "legacy-before-agent-start",
          issueClass: "deprecation-warning",
          message: "legacy before_agent_start hook is deprecated",
          authorRemediation: {
            summary: "Move prompt mutation work to before_prompt_build.",
            docsUrl:
              "https://docs.openclaw.ai/clawhub/plugin-validation-fixes#legacy-before-agent-start",
          },
        }),
      ],
    });
  });

  it("deduplicates plugin inspector warnings when an idempotent publish retry returns an existing release", async () => {
    const insert = vi.fn();
    const collect = vi.fn(async () => [
      {
        inspectorFindingId: "demo:legacy-before-agent-start",
        code: "legacy-before-agent-start",
        message: "legacy before_agent_start hook is deprecated",
        evidence: ["src/index.ts:4"],
        fixture: "demo",
      },
    ]);
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn(() => ({
          withIndex: vi.fn(() => ({
            collect,
            unique: vi.fn().mockResolvedValue(null),
          })),
        })),
        insert,
        patch: vi.fn(),
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn((tableName: string, id: string) =>
          id.startsWith(`${tableName}:`) ? id : null,
        ),
      },
    };

    await expect(
      insertPackageInspectorWarningsInternalHandler(ctx as never, {
        packageId: "packages:demo",
        releaseId: "packageReleases:demo-1",
        ownerUserId: "users:owner",
        packageName: "demo-plugin",
        version: "1.0.0",
        warnings: [
          {
            id: "demo:legacy-before-agent-start",
            code: "legacy-before-agent-start",
            message: "legacy before_agent_start hook is deprecated",
            evidence: ["src/index.ts:4"],
            fixture: "demo",
          },
          {
            id: "demo:manifest-name-missing",
            code: "manifest-name-missing",
            message: "openclaw.plugin.json does not declare a display name",
            evidence: ["openclaw.plugin.json"],
            fixture: "demo",
            authorRemediation: {
              summary: "Add a display name to the plugin manifest.",
              docsUrl:
                "https://docs.openclaw.ai/clawhub/plugin-validation-fixes#manifest-name-missing",
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ ok: true, inserted: 1, shouldEmailOwner: false });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(
      "packageInspectorWarnings",
      expect.objectContaining({
        code: "manifest-name-missing",
        inspectorFindingId: "demo:manifest-name-missing",
        authorRemediation: {
          summary: "Add a display name to the plugin manifest.",
          docsUrl: "https://docs.openclaw.ai/clawhub/plugin-validation-fixes#manifest-name-missing",
        },
      }),
    );
  });

  it("keeps the same plugin inspector finding when the inspector version changes", async () => {
    const insert = vi.fn();
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn(() => ({
          withIndex: vi.fn(() => ({
            collect: vi.fn().mockResolvedValue([
              {
                inspectorFindingId: "demo:legacy-before-agent-start",
                code: "legacy-before-agent-start",
                message: "legacy before_agent_start hook is deprecated",
                evidence: ["src/index.ts:4"],
                fixture: "demo",
                inspectorVersion: "0.4.0",
                targetOpenClawVersion: "2026.4.0",
              },
            ]),
            unique: vi.fn().mockResolvedValue(null),
          })),
        })),
        insert,
        patch: vi.fn(),
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn((tableName: string, id: string) =>
          id.startsWith(`${tableName}:`) ? id : null,
        ),
      },
    };

    await expect(
      insertPackageInspectorWarningsInternalHandler(ctx as never, {
        packageId: "packages:demo",
        releaseId: "packageReleases:demo-1",
        ownerUserId: "users:owner",
        packageName: "demo-plugin",
        version: "1.0.0",
        scanSource: "nightly",
        inspectorVersion: "0.5.0",
        targetOpenClawVersion: "2026.5.0",
        findings: [
          {
            id: "demo:legacy-before-agent-start",
            code: "legacy-before-agent-start",
            message: "legacy before_agent_start hook is deprecated",
            evidence: ["src/index.ts:4"],
            fixture: "demo",
            authorRemediation: {
              summary: "Move prompt mutation work to before_prompt_build.",
              docsUrl:
                "https://docs.openclaw.ai/clawhub/plugin-validation-fixes#legacy-before-agent-start",
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ ok: true, inserted: 1, shouldEmailOwner: false });

    expect(insert).toHaveBeenCalledWith(
      "packageInspectorWarnings",
      expect.objectContaining({
        code: "legacy-before-agent-start",
        inspectorVersion: "0.5.0",
        targetOpenClawVersion: "2026.5.0",
      }),
    );
  });

  it("replaces the current nightly beta findings while preserving publish findings", async () => {
    const insert = vi.fn();
    const deleteRow = vi.fn();
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn((table: string) => {
          if (table === "packageInspectorWarnings") {
            return {
              withIndex: vi.fn(() => ({
                collect: vi.fn().mockResolvedValue([
                  {
                    _id: "packageInspectorWarnings:static",
                    scanSource: "publish",
                    inspectorFindingId: "demo:manifest-name-missing",
                    code: "manifest-name-missing",
                    message: "manifest name is missing",
                    authorRemediation: { summary: "Add a manifest name." },
                  },
                  {
                    _id: "packageInspectorWarnings:old-beta",
                    scanSource: "nightly",
                    inspectorFindingId: "demo:old-beta-api",
                    code: "old-beta-api",
                    message: "old beta API is missing",
                    targetOpenClawVersion: "2026.7.0-beta.1",
                    authorRemediation: { summary: "Use the supported API." },
                  },
                ]),
              })),
            };
          }
          if (table === "packageInspectorFindingNotifications") {
            return {
              withIndex: vi.fn(() => ({ unique: vi.fn().mockResolvedValue(null) })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
        insert,
        patch: vi.fn(),
        replace: vi.fn(),
        delete: deleteRow,
        normalizeId: vi.fn((tableName: string, id: string) =>
          id.startsWith(`${tableName}:`) ? id : null,
        ),
      },
    };

    await expect(
      insertPackageInspectorWarningsInternalHandler(ctx as never, {
        packageId: "packages:demo",
        releaseId: "packageReleases:demo-1",
        ownerUserId: "users:owner",
        packageName: "demo-plugin",
        version: "1.0.0",
        scanSource: "nightly",
        inspectorVersion: "0.6.0",
        targetOpenClawVersion: "2026.8.0-beta.1",
        findings: [
          {
            id: "demo:new-beta-api",
            code: "new-beta-api",
            level: "breakage",
            message: "new beta API is missing",
            authorRemediation: { summary: "Use the replacement API." },
          },
        ],
      }),
    ).resolves.toMatchObject({ ok: true, inserted: 1, shouldEmailOwner: false });

    expect(deleteRow).toHaveBeenCalledTimes(1);
    expect(deleteRow).toHaveBeenCalledWith("packageInspectorWarnings:old-beta");
    expect(insert).toHaveBeenCalledWith(
      "packageInspectorWarnings",
      expect.objectContaining({
        scanSource: "nightly",
        targetOpenClawVersion: "2026.8.0-beta.1",
        code: "new-beta-api",
      }),
    );
  });

  it("does not notify for a warning-only nightly result with a preserved publish error", async () => {
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn((table: string) => {
          if (table === "packageInspectorWarnings") {
            return {
              withIndex: vi.fn(() => ({
                collect: vi.fn().mockResolvedValue([
                  {
                    _id: "packageInspectorWarnings:publish",
                    scanSource: "publish",
                    findingKind: "error",
                    code: "manifest-name-missing",
                    message: "manifest name is missing",
                    authorRemediation: { summary: "Add a manifest name." },
                  },
                ]),
              })),
            };
          }
          if (table === "packageInspectorScanStates") {
            return {
              withIndex: vi.fn(() => ({ unique: vi.fn().mockResolvedValue(null) })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
        insert: vi.fn(),
        patch: vi.fn(),
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn(() => null),
      },
    };

    await expect(
      insertPackageInspectorWarningsInternalHandler(ctx as never, {
        packageId: "packages:demo",
        releaseId: "packageReleases:demo-1",
        ownerUserId: "users:owner",
        packageName: "demo-plugin",
        version: "1.0.0",
        scanSource: "nightly",
        inspectorVersion: "0.6.0",
        targetOpenClawVersion: "2026.8.0-beta.1",
        notifyOwners: true,
        findings: [
          {
            id: "demo:deprecated-api",
            code: "deprecated-api",
            level: "warning",
            message: "The API is deprecated but still available.",
            authorRemediation: { summary: "Migrate before a future release." },
          },
        ],
      }),
    ).resolves.toEqual({ ok: true, inserted: 1, shouldEmailOwner: false });
  });

  it("records a clean beta scan identity and completes a no-op notification", async () => {
    const insert = vi.fn().mockResolvedValue("packageInspectorScanStates:demo");
    const deleteRow = vi.fn();
    const scanStateWithIndex = vi.fn((indexName: string) => ({
      unique: vi.fn().mockResolvedValue(
        indexName === "by_release"
          ? {
              _id: "packageInspectorScanStates:previous",
              inspectorVersion: "0.5.0",
              targetOpenClawVersion: "2026.7.0-beta.1",
            }
          : null,
      ),
    }));
    const ctx = {
      db: {
        get: vi.fn(async (id: string) => {
          if (id === "packages:demo") {
            return {
              _id: "packages:demo",
              name: "demo-plugin",
              ownerUserId: "users:owner",
            };
          }
          if (id === "packageReleases:demo-1") {
            return {
              _id: "packageReleases:demo-1",
              packageId: "packages:demo",
              version: "1.0.0",
            };
          }
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table === "packageInspectorWarnings") {
            return {
              withIndex: vi.fn(() => ({
                collect: vi.fn().mockResolvedValue([
                  {
                    _id: "packageInspectorWarnings:old-beta",
                    scanSource: "nightly",
                    code: "old-beta-api",
                    message: "old beta API is missing",
                    authorRemediation: { summary: "Use the supported API." },
                  },
                ]),
              })),
            };
          }
          if (table === "packageInspectorScanStates") {
            return { withIndex: scanStateWithIndex };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
        insert,
        patch: vi.fn(),
        replace: vi.fn(),
        delete: deleteRow,
        normalizeId: vi.fn((tableName: string, id: string) =>
          id.startsWith(`${tableName}:`) ? id : null,
        ),
      },
    };

    await expect(
      ingestPackageInspectorScanResultsInternalHandler(ctx as never, {
        packageId: "packages:demo",
        releaseId: "packageReleases:demo-1",
        inspectorVersion: "0.6.0",
        targetOpenClawVersion: "2026.8.0-beta.1",
        notifyOwners: true,
        findings: [],
      }),
    ).resolves.toEqual({ ok: true, inserted: 0, shouldEmailOwner: false });

    expect(deleteRow).toHaveBeenCalledWith("packageInspectorWarnings:old-beta");
    expect(scanStateWithIndex).toHaveBeenCalledWith(
      "by_release_and_inspector_version_and_target_openclaw_version",
      expect.any(Function),
    );
    expect(insert).toHaveBeenCalledWith("packageInspectorScanStates", {
      packageId: "packages:demo",
      releaseId: "packageReleases:demo-1",
      inspectorVersion: "0.6.0",
      targetOpenClawVersion: "2026.8.0-beta.1",
      completedAt: expect.any(Number),
      notificationCompletedAt: expect.any(Number),
    });
  });

  it("stores nightly errors and does not reuse an earlier target's email dedupe", async () => {
    const insert = vi.fn();
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn((table: string) => ({
          withIndex: vi.fn(() => ({
            collect: vi.fn().mockResolvedValue([]),
            unique: vi
              .fn()
              .mockResolvedValue(
                table === "packageInspectorFindingNotifications"
                  ? { _id: "packageInspectorFindingNotifications:old-target" }
                  : null,
              ),
          })),
        })),
        insert,
        patch: vi.fn(),
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn((tableName: string, id: string) =>
          id.startsWith(`${tableName}:`) ? id : null,
        ),
      },
    };

    await expect(
      insertPackageInspectorWarningsInternalHandler(ctx as never, {
        packageId: "packages:demo",
        releaseId: "packageReleases:demo-1",
        ownerUserId: "users:owner",
        packageName: "demo-plugin",
        version: "1.0.0",
        scanSource: "nightly",
        inspectorVersion: "0.5.0",
        targetOpenClawVersion: "0.10.0",
        notifyOwners: true,
        findings: [
          {
            id: "demo:missing-expected-seam",
            code: "missing-expected-seam",
            level: "breakage",
            message: "registerTool is no longer available",
            evidence: ["dist/index.js:2"],
            fixture: "demo",
            authorRemediation: {
              summary: "Replace registerTool with the current plugin API.",
              docsUrl:
                "https://docs.openclaw.ai/clawhub/plugin-validation-fixes#missing-expected-seam",
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ ok: true, inserted: 1, shouldEmailOwner: true });

    expect(insert).toHaveBeenCalledWith(
      "packageInspectorWarnings",
      expect.objectContaining({
        findingKind: "error",
        scanSource: "nightly",
        inspectorVersion: "0.5.0",
        targetOpenClawVersion: "0.10.0",
        code: "missing-expected-seam",
      }),
    );
  });

  it("drops plugin inspector coverage gaps before storing public findings", async () => {
    const insert = vi.fn();
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn(() => ({
          withIndex: vi.fn(() => ({
            collect: vi.fn().mockResolvedValue([]),
            unique: vi.fn().mockResolvedValue(null),
          })),
        })),
        insert,
        patch: vi.fn(),
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn((tableName: string, id: string) =>
          id.startsWith(`${tableName}:`) ? id : null,
        ),
      },
    };

    await expect(
      insertPackageInspectorWarningsInternalHandler(ctx as never, {
        packageId: "packages:demo",
        releaseId: "packageReleases:demo-1",
        ownerUserId: "users:owner",
        packageName: "demo-plugin",
        version: "1.0.0",
        scanSource: "nightly",
        inspectorVersion: "0.5.0",
        targetOpenClawVersion: "0.10.0",
        notifyOwners: true,
        findings: [
          {
            id: "demo:runtime-tool-capture",
            code: "runtime-tool-capture",
            issueClass: "inspector-gap",
            message: "runtime tools need capture before contract judgment",
            evidence: ["src/index.ts:2"],
            fixture: "demo",
          },
          {
            id: "demo:legacy-before-agent-start",
            code: "legacy-before-agent-start",
            issueClass: "deprecation-warning",
            message: "legacy before_agent_start hook is deprecated",
            evidence: ["src/index.ts:4"],
            fixture: "demo",
            authorRemediation: {
              summary: "Move prompt mutation work to before_prompt_build.",
              docsUrl:
                "https://docs.openclaw.ai/clawhub/plugin-validation-fixes#legacy-before-agent-start",
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ ok: true, inserted: 1, shouldEmailOwner: false });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(
      "packageInspectorWarnings",
      expect.objectContaining({
        code: "legacy-before-agent-start",
        issueClass: "deprecation-warning",
        authorRemediation: {
          summary: "Move prompt mutation work to before_prompt_build.",
          docsUrl:
            "https://docs.openclaw.ai/clawhub/plugin-validation-fixes#legacy-before-agent-start",
        },
      }),
    );
  });

  it("stores an exact nightly hard error despite an identical preserved finding", async () => {
    const insert = vi.fn();
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn(() => ({
          withIndex: vi.fn(() => ({
            collect: vi.fn().mockResolvedValue([
              {
                findingKind: "error",
                inspectorFindingId: "demo:legacy-before-agent-start",
                code: "legacy-before-agent-start",
                message: "legacy before_agent_start hook is deprecated",
                evidence: ["src/index.ts:4"],
                fixture: "demo",
                inspectorVersion: "0.5.0",
                targetOpenClawVersion: "0.10.0",
                authorRemediation: {
                  summary: "Move prompt mutation work to before_prompt_build.",
                  docsUrl:
                    "https://docs.openclaw.ai/clawhub/plugin-validation-fixes#legacy-before-agent-start",
                },
              },
            ]),
            unique: vi.fn().mockResolvedValue(null),
          })),
        })),
        insert,
        patch: vi.fn(),
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn((tableName: string, id: string) =>
          id.startsWith(`${tableName}:`) ? id : null,
        ),
      },
    };

    await expect(
      insertPackageInspectorWarningsInternalHandler(ctx as never, {
        packageId: "packages:demo",
        releaseId: "packageReleases:demo-1",
        ownerUserId: "users:owner",
        packageName: "demo-plugin",
        version: "1.0.0",
        scanSource: "nightly",
        inspectorVersion: "0.5.0",
        targetOpenClawVersion: "0.10.0",
        notifyOwners: true,
        findings: [
          {
            id: "demo:legacy-before-agent-start",
            code: "legacy-before-agent-start",
            level: "breakage",
            message: "legacy before_agent_start hook is deprecated",
            evidence: ["src/index.ts:4"],
            fixture: "demo",
            authorRemediation: {
              summary: "Move prompt mutation work to before_prompt_build.",
              docsUrl:
                "https://docs.openclaw.ai/clawhub/plugin-validation-fixes#legacy-before-agent-start",
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ ok: true, inserted: 1, shouldEmailOwner: true });

    expect(insert).toHaveBeenCalledWith(
      "packageInspectorWarnings",
      expect.objectContaining({
        findingKind: "error",
        scanSource: "nightly",
        inspectorVersion: "0.5.0",
        targetOpenClawVersion: "0.10.0",
      }),
    );
  });

  it("summarizes plugin inspector validation findings for signed-out viewers", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue(null);
    const ctx = {
      db: {
        get: vi.fn(async (id: string) => {
          if (id === "packages:demo") {
            return {
              _id: "packages:demo",
              name: "demo-plugin",
              normalizedName: "demo-plugin",
              family: "code-plugin",
              latestReleaseId: "packageReleases:demo-1",
            };
          }
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table === "packages") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue({
                  _id: "packages:demo",
                  name: "demo-plugin",
                  normalizedName: "demo-plugin",
                  family: "code-plugin",
                  latestReleaseId: "packageReleases:demo-1",
                }),
              })),
            };
          }
          if (table === "packageInspectorWarnings") {
            return {
              withIndex: vi.fn(() => ({
                order: vi.fn(() => ({
                  take: vi.fn().mockResolvedValue([
                    {
                      _id: "packageInspectorWarnings:1",
                      packageName: "demo-plugin",
                      version: "1.0.0",
                      findingKind: "error",
                      code: "missing-expected-seam",
                      issueClass: "compatibility-error",
                      message: "registerTool is no longer available",
                      evidence: ["dist/index.js:2"],
                      inspectorVersion: "0.5.0",
                      targetOpenClawVersion: "0.10.0",
                      scanSource: "nightly",
                      authorRemediation: {
                        summary: "Replace registerTool with the current plugin API.",
                        docsUrl:
                          "https://docs.openclaw.ai/clawhub/plugin-validation-fixes#missing-expected-seam",
                      },
                      createdAt: 2,
                    },
                  ]),
                })),
              })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      },
    };

    await expect(
      getPackageInspectorValidationSummaryPublicHandler(ctx as never, { name: "demo-plugin" }),
    ).resolves.toEqual({
      findingCount: 1,
      errorCount: 1,
      warningCount: 0,
      incompatibleAfterOpenClawVersion: "0.10.0",
    });
  });

  it("summarizes only latest-release plugin inspector findings", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue(null);
    const warningIndexEq = vi.fn(() => ({}));
    const warningWithIndex = vi.fn(
      (_indexName: string, build: (q: { eq: typeof warningIndexEq }) => unknown) => {
        build({ eq: warningIndexEq });
        return {
          order: vi.fn(() => ({
            take: vi.fn().mockResolvedValue([]),
          })),
        };
      },
    );
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn((table: string) => {
          if (table === "packages") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue({
                  _id: "packages:demo",
                  name: "demo-plugin",
                  normalizedName: "demo-plugin",
                  family: "code-plugin",
                  latestReleaseId: "packageReleases:demo-2",
                }),
              })),
            };
          }
          if (table === "packageInspectorWarnings") {
            return { withIndex: warningWithIndex };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      },
    };

    await expect(
      getPackageInspectorValidationSummaryPublicHandler(ctx as never, { name: "demo-plugin" }),
    ).resolves.toEqual({
      findingCount: 0,
      errorCount: 0,
      warningCount: 0,
      incompatibleAfterOpenClawVersion: null,
    });
    expect(warningWithIndex).toHaveBeenCalledWith("by_release_created", expect.any(Function));
    expect(warningIndexEq).toHaveBeenCalledWith("releaseId", "packageReleases:demo-2");
    expect(warningIndexEq).not.toHaveBeenCalledWith("packageId", "packages:demo");
  });

  it("does not list detailed plugin inspector findings for signed-out viewers", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue(null);
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn(),
      },
    };

    await expect(
      listPackageInspectorFindingsPublicHandler(ctx as never, { name: "demo-plugin" }),
    ).resolves.toEqual([]);
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  it("does not expose detailed plugin inspector findings for private packages", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue(null);
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn((table: string) => {
          if (table === "packages") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue({
                  _id: "packages:private",
                  name: "private-plugin",
                  normalizedName: "private-plugin",
                  family: "code-plugin",
                  channel: "private",
                  scanStatus: "clean",
                  ownerUserId: "users:owner",
                }),
              })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      },
    };

    await expect(
      listPackageInspectorFindingsPublicHandler(ctx as never, { name: "private-plugin" }),
    ).resolves.toEqual([]);
    expect(ctx.db.query).not.toHaveBeenCalled();
    expect(ctx.db.query).not.toHaveBeenCalledWith("packageInspectorWarnings");
  });

  it("dedupes package inspector finding emails per release", async () => {
    const insert = vi.fn(async () => "packageInspectorFindingNotifications:1");
    const unique = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
      _id: "packageInspectorFindingNotifications:1",
    });
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn(() => ({
          withIndex: vi.fn(() => ({
            unique,
          })),
        })),
        insert,
        patch: vi.fn(),
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn((tableName: string, id: string) =>
          id.startsWith(`${tableName}:`) ? id : null,
        ),
      },
    };

    await expect(
      markPackageInspectorFindingsEmailedInternalHandler(ctx as never, {
        packageId: "packages:demo",
        releaseId: "packageReleases:demo-1",
        ownerUserId: "users:owner",
        packageName: "demo-plugin",
        version: "1.0.0",
        findingCount: 2,
        email: "owner@example.com",
      }),
    ).resolves.toEqual({ ok: true, created: true });
    await expect(
      markPackageInspectorFindingsEmailedInternalHandler(ctx as never, {
        packageId: "packages:demo",
        releaseId: "packageReleases:demo-1",
        ownerUserId: "users:owner",
        packageName: "demo-plugin",
        version: "1.0.0",
        findingCount: 3,
        email: "owner@example.com",
      }),
    ).resolves.toEqual({ ok: true, created: false });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("marks the exact scan notification complete after owner email succeeds", async () => {
    const patch = vi.fn();
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn((table: string) => ({
          withIndex: vi.fn(() => ({
            unique: vi
              .fn()
              .mockResolvedValue(
                table === "packageInspectorScanStates"
                  ? { _id: "packageInspectorScanStates:demo" }
                  : null,
              ),
          })),
        })),
        insert: vi.fn(),
        patch,
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn(() => null),
      },
    };

    await expect(
      markPackageInspectorFindingsEmailedInternalHandler(ctx as never, {
        packageId: "packages:demo",
        releaseId: "packageReleases:demo-1",
        ownerUserId: "users:owner",
        packageName: "demo-plugin",
        version: "1.0.0",
        findingCount: 2,
        email: "owner@example.com",
        inspectorVersion: "0.6.0",
        targetOpenClawVersion: "2026.8.0-beta.1",
      }),
    ).resolves.toEqual({ ok: true, created: true });
    expect(patch).toHaveBeenCalledWith(
      "packageInspectorScanStates:demo",
      expect.objectContaining({ notificationCompletedAt: expect.any(Number) }),
    );
  });

  it("excludes internal and warning-only findings from owner emails", async () => {
    const ctx = {
      db: {
        get: vi.fn(async (id: string) => {
          if (id === "packages:demo") {
            return makePackageDoc({
              _id: "packages:demo",
              name: "demo-plugin",
              ownerUserId: "users:owner",
            });
          }
          if (id === "packageReleases:demo-1") {
            return makeReleaseDoc({
              _id: "packageReleases:demo-1",
              packageId: "packages:demo",
              version: "1.0.0",
            });
          }
          if (id === "users:owner") {
            return { _id: "users:owner", handle: "owner", email: "owner@example.com" };
          }
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table === "packageInspectorWarnings") {
            return {
              withIndex: vi.fn(() => ({
                order: vi.fn(() => ({
                  take: vi.fn().mockResolvedValue([
                    {
                      _id: "packageInspectorWarnings:internal",
                      packageName: "demo-plugin",
                      version: "1.0.0",
                      findingKind: "warning",
                      code: "runtime-tool-capture",
                      issueClass: "inspector-gap",
                      message: "runtime tool schema needs registration capture",
                      createdAt: 2,
                    },
                    {
                      _id: "packageInspectorWarnings:author",
                      packageName: "demo-plugin",
                      version: "1.0.0",
                      findingKind: "warning",
                      code: "legacy-before-agent-start",
                      issueClass: "deprecation-warning",
                      message: "legacy before_agent_start hook is deprecated",
                      authorRemediation: {
                        summary: "Move prompt mutation work to before_prompt_build.",
                        docsUrl:
                          "https://docs.openclaw.ai/clawhub/plugin-validation-fixes#legacy-before-agent-start",
                      },
                      createdAt: 1,
                    },
                    {
                      _id: "packageInspectorWarnings:error",
                      packageName: "demo-plugin",
                      version: "1.0.0",
                      findingKind: "error",
                      code: "missing-api",
                      issueClass: "compatibility-error",
                      message: "an API is unavailable in the upcoming OpenClaw release",
                      authorRemediation: {
                        summary: "Use the replacement API.",
                      },
                      createdAt: 0,
                    },
                  ]),
                })),
              })),
            };
          }
          if (table === "packageInspectorFindingNotifications") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(null),
              })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      },
    };

    const result = await getPackageInspectorEmailContextInternalHandler(ctx as never, {
      packageId: "packages:demo",
      releaseId: "packageReleases:demo-1",
    });
    expect(result?.packageName).toBe("demo-plugin");
    expect(result?.findings.map((finding) => finding.code)).toEqual(["missing-api"]);
    expect(result?.findings[0]?.authorRemediation).toMatchObject({
      summary: "Use the replacement API.",
    });
  });

  it("rejects a notification request whose release does not belong to the package", async () => {
    const ctx = {
      db: {
        get: vi.fn(async (id: string) => {
          if (id === "packages:demo") {
            return makePackageDoc({
              _id: "packages:demo",
              name: "demo-plugin",
              ownerUserId: "users:owner",
            });
          }
          if (id === "packageReleases:other") {
            return makeReleaseDoc({
              _id: "packageReleases:other",
              packageId: "packages:other",
              version: "1.0.0",
            });
          }
          return null;
        }),
        query: vi.fn(() => {
          throw new Error("Mismatched releases must be rejected before querying findings");
        }),
      },
    };

    await expect(
      getPackageInspectorEmailContextInternalHandler(ctx as never, {
        packageId: "packages:demo",
        releaseId: "packageReleases:other",
        inspectorVersion: "0.3.20",
        targetOpenClawVersion: "2026.8.0-beta.1",
      }),
    ).resolves.toBeNull();
  });

  it("builds email context for a new exact target despite an older release notification", async () => {
    const ctx = {
      db: {
        get: vi.fn(async (id: string) => {
          if (id === "packages:demo") {
            return makePackageDoc({
              _id: "packages:demo",
              name: "demo-plugin",
              ownerUserId: "users:owner",
            });
          }
          if (id === "packageReleases:demo-1") {
            return makeReleaseDoc({
              _id: "packageReleases:demo-1",
              packageId: "packages:demo",
              version: "1.0.0",
            });
          }
          if (id === "users:owner") {
            return { _id: "users:owner", handle: "owner", email: "owner@example.com" };
          }
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table === "packageInspectorWarnings") {
            return {
              withIndex: vi.fn(() => ({
                filter: vi.fn(() => ({
                  order: vi.fn(() => ({
                    take: vi.fn().mockResolvedValue([
                      {
                        findingKind: "error",
                        code: "missing-api",
                        scanSource: "nightly",
                        inspectorVersion: "0.6.0",
                        targetOpenClawVersion: "2026.8.0-beta.1",
                        message: "API removed",
                        authorRemediation: { summary: "Use the replacement API." },
                      },
                    ]),
                  })),
                })),
              })),
            };
          }
          if (table === "packageInspectorScanStates") {
            return {
              withIndex: vi.fn(() => ({ unique: vi.fn().mockResolvedValue(null) })),
            };
          }
          if (table === "packageInspectorFindingNotifications") {
            throw new Error("Exact-target email context must not use release-wide dedupe");
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      },
    };

    await expect(
      getPackageInspectorEmailContextInternalHandler(ctx as never, {
        packageId: "packages:demo",
        releaseId: "packageReleases:demo-1",
        inspectorVersion: "0.6.0",
        targetOpenClawVersion: "2026.8.0-beta.1",
      }),
    ).resolves.toMatchObject({ packageName: "demo-plugin" });
  });

  it("selects the exact nightly scan before limiting owner email findings", async () => {
    const ctx = {
      db: {
        get: vi.fn(async (id: string) => {
          if (id === "packages:demo") {
            return makePackageDoc({
              _id: "packages:demo",
              name: "demo-plugin",
              ownerUserId: "users:owner",
            });
          }
          if (id === "packageReleases:demo-1") {
            return makeReleaseDoc({
              _id: "packageReleases:demo-1",
              packageId: "packages:demo",
              version: "1.0.0",
            });
          }
          if (id === "users:owner") {
            return { _id: "users:owner", handle: "owner", email: "owner@example.com" };
          }
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table === "packageInspectorWarnings") {
            return {
              withIndex: vi.fn(() => ({
                filter: vi.fn(() => ({
                  order: vi.fn(() => ({
                    take: vi.fn().mockResolvedValue([
                      {
                        findingKind: "error",
                        code: "missing-api",
                        scanSource: "nightly",
                        inspectorVersion: "0.6.0",
                        targetOpenClawVersion: "2026.8.0-beta.1",
                        message: "API removed",
                        authorRemediation: { summary: "Use the replacement API." },
                      },
                    ]),
                  })),
                })),
                order: vi.fn(() => ({
                  take: vi.fn().mockResolvedValue([
                    {
                      code: "publish-warning-100",
                      scanSource: "publish",
                      message: "The release-wide limit was exhausted by publish findings.",
                      authorRemediation: { summary: "Fix the package metadata." },
                    },
                  ]),
                })),
              })),
            };
          }
          if (table === "packageInspectorScanStates") {
            return {
              withIndex: vi.fn(() => ({ unique: vi.fn().mockResolvedValue(null) })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      },
    };

    const result = await getPackageInspectorEmailContextInternalHandler(ctx as never, {
      packageId: "packages:demo",
      releaseId: "packageReleases:demo-1",
      inspectorVersion: "0.6.0",
      targetOpenClawVersion: "2026.8.0-beta.1",
    });

    expect(result?.findings.map((finding) => finding.code)).toEqual(["missing-api"]);
  });

  it("leases a scan page without advancing past unprocessed releases", async () => {
    const paginate = vi.fn(async () => ({
      page: [
        {
          _id: "packageReleases:one",
          packageId: "packages:one",
          version: "1.0.0",
          artifactKind: "legacy-zip",
        },
        {
          _id: "packageReleases:two",
          packageId: "packages:two",
          version: "2.0.0",
          artifactKind: "npm-pack",
        },
      ],
      isDone: false,
      continueCursor: "cursor-after-returned-page",
    }));
    const insert = vi.fn();
    const ctx = {
      db: {
        get: vi.fn(async (id: string) => {
          if (id === "packages:one") {
            return {
              _id: "packages:one",
              name: "one-plugin",
              family: "code-plugin",
              latestReleaseId: "packageReleases:one",
            };
          }
          if (id === "packages:two") {
            return {
              _id: "packages:two",
              name: "two-plugin",
              family: "bundle-plugin",
              tags: { latest: "packageReleases:two" },
            };
          }
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table === "packageInspectorScanCursors") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(null),
              })),
            };
          }
          if (table === "packageReleases") {
            return {
              withIndex: vi.fn(() => ({
                order: vi.fn(() => ({
                  paginate,
                })),
              })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
        insert,
        patch: vi.fn(),
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn(() => null),
      },
    };

    await expect(
      claimPackageInspectorScanBatchInternalHandler(ctx as never, {
        batchSize: 2,
        leaseMs: 60_000,
        runId: "run-42",
      }),
    ).resolves.toMatchObject({
      ok: true,
      leased: false,
      nextCursor: "cursor-after-returned-page",
      items: [
        { packageName: "one-plugin", artifactKind: "legacy-zip" },
        { packageName: "two-plugin", artifactKind: "npm-pack" },
      ],
    });
    expect(paginate).toHaveBeenCalledWith({ cursor: null, numItems: 2 });
    expect(insert).toHaveBeenCalledWith(
      "packageInspectorScanCursors",
      expect.objectContaining({
        cursor: null,
        pendingCursor: "cursor-after-returned-page",
      }),
    );
  });

  it("advances a leased scan page only after the owning run acknowledges it", async () => {
    const patch = vi.fn();
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn((table: string) => {
          if (table !== "packageInspectorScanCursors") {
            throw new Error(`Unexpected table ${table}`);
          }
          return {
            withIndex: vi.fn(() => ({
              unique: vi.fn().mockResolvedValue({
                _id: "packageInspectorScanCursors:nightly",
                name: "nightly",
                cursor: null,
                pendingCursor: "page-2",
                runId: "run-42",
                leaseExpiresAt: Date.now() + 60_000,
              }),
            })),
          };
        }),
        patch,
        insert: vi.fn(),
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn(() => null),
      },
    };

    await expect(
      acknowledgePackageInspectorScanBatchInternalHandler(ctx as never, {
        runId: "  run-42  ",
        cursor: "page-2",
        leaseMs: 60_000,
      }),
    ).resolves.toEqual({ ok: true, cursor: "page-2", completed: false });
    expect(patch).toHaveBeenCalledWith(
      "packageInspectorScanCursors:nightly",
      expect.objectContaining({
        cursor: "page-2",
        pendingCursor: undefined,
        runId: "run-42",
      }),
    );
  });

  it("rejects acknowledgement from a different scan run", async () => {
    const patch = vi.fn();
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn(() => ({
          withIndex: vi.fn(() => ({
            unique: vi.fn().mockResolvedValue({
              _id: "packageInspectorScanCursors:nightly",
              cursor: null,
              pendingCursor: "page-2",
              runId: "run-42",
            }),
          })),
        })),
        patch,
        insert: vi.fn(),
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn(() => null),
      },
    };

    await expect(
      acknowledgePackageInspectorScanBatchInternalHandler(ctx as never, {
        runId: "run-other",
        cursor: "page-2",
      }),
    ).rejects.toThrow("does not own the active lease");
    expect(patch).not.toHaveBeenCalled();
  });

  it("continues only from the cursor owned by the same nightly scan run", async () => {
    const paginate = vi.fn(async () => ({
      page: [],
      isDone: true,
      continueCursor: null,
    }));
    const patch = vi.fn();
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn((table: string) => {
          if (table === "packageInspectorScanCursors") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue({
                  _id: "packageInspectorScanCursors:nightly",
                  name: "nightly",
                  runId: "run-42",
                  cursor: "page-2",
                  leaseExpiresAt: Date.now() + 60_000,
                }),
              })),
            };
          }
          if (table === "packageReleases") {
            return {
              withIndex: vi.fn(() => ({ order: vi.fn(() => ({ paginate })) })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
        insert: vi.fn(),
        patch,
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn(() => null),
      },
    };

    await expect(
      claimPackageInspectorScanBatchInternalHandler(ctx as never, {
        batchSize: 25,
        leaseMs: 60_000,
        cursor: "page-2",
        runId: "run-42",
      }),
    ).resolves.toMatchObject({
      ok: true,
      leased: false,
      nextCursor: null,
      items: [],
    });
    expect(paginate).toHaveBeenCalledWith({ cursor: "page-2", numItems: 25 });
    expect(patch).toHaveBeenCalledWith(
      "packageInspectorScanCursors:nightly",
      expect.objectContaining({ cursor: "page-2", pendingCursor: null, runId: "run-42" }),
    );
  });

  it("reclaims an unacknowledged page immediately for the same nightly scan run", async () => {
    const paginate = vi.fn(async () => ({
      page: [],
      isDone: true,
      continueCursor: null,
    }));
    const patch = vi.fn();
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn((table: string) => {
          if (table === "packageInspectorScanCursors") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue({
                  _id: "packageInspectorScanCursors:nightly",
                  name: "nightly",
                  runId: "run-42",
                  cursor: "page-1",
                  pendingCursor: "page-2",
                  leaseExpiresAt: Date.now() + 60_000,
                }),
              })),
            };
          }
          if (table === "packageReleases") {
            return {
              withIndex: vi.fn(() => ({ order: vi.fn(() => ({ paginate })) })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
        insert: vi.fn(),
        patch,
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn(() => null),
      },
    };

    await expect(
      claimPackageInspectorScanBatchInternalHandler(ctx as never, {
        batchSize: 25,
        leaseMs: 60_000,
        cursor: "page-1",
        runId: "run-42",
      }),
    ).resolves.toMatchObject({
      ok: true,
      leased: false,
      nextCursor: null,
    });
    expect(paginate).toHaveBeenCalledWith({ cursor: "page-1", numItems: 25 });
    expect(patch).toHaveBeenCalledWith(
      "packageInspectorScanCursors:nightly",
      expect.objectContaining({
        cursor: "page-1",
        pendingCursor: null,
        runId: "run-42",
      }),
    );
  });

  it("resumes the persisted cursor when the same nightly run restarts", async () => {
    const paginate = vi.fn(async () => ({
      page: [],
      isDone: true,
      continueCursor: null,
    }));
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn((table: string) => {
          if (table === "packageInspectorScanCursors") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue({
                  _id: "packageInspectorScanCursors:nightly",
                  runId: "run-42",
                  cursor: "page-3",
                  leaseExpiresAt: Date.now() + 60_000,
                }),
              })),
            };
          }
          if (table === "packageReleases") {
            return {
              withIndex: vi.fn(() => ({ order: vi.fn(() => ({ paginate })) })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
        insert: vi.fn(),
        patch: vi.fn(),
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn(() => null),
      },
    };

    await expect(
      claimPackageInspectorScanBatchInternalHandler(ctx as never, {
        cursor: "page-2",
        runId: "run-42",
      }),
    ).resolves.toMatchObject({ ok: true, leased: false, nextCursor: null, items: [] });
    expect(paginate).toHaveBeenCalledWith({ cursor: "page-3", numItems: 25 });
  });

  it("resumes the persisted cursor when a replacement nightly run acquires an expired lease", async () => {
    const paginate = vi.fn(async () => ({
      page: [
        {
          _id: "packageReleases:current",
          packageId: "packages:current",
          version: "1.0.0",
          artifactKind: "legacy-zip",
        },
      ],
      isDone: false,
      continueCursor: "page-3",
    }));
    const patch = vi.fn();
    const ctx = {
      db: {
        get: vi.fn(async (id: string) =>
          id === "packages:current"
            ? {
                _id: "packages:current",
                name: "current-plugin",
                family: "code-plugin",
                channel: "community",
                ownerUserId: "users:owner",
                latestReleaseId: "packageReleases:current",
              }
            : null,
        ),
        query: vi.fn((table: string) => {
          if (table === "packageInspectorScanCursors") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue({
                  _id: "packageInspectorScanCursors:nightly",
                  runId: "run-old",
                  cursor: "page-2",
                  leaseExpiresAt: Date.now() - 1,
                }),
              })),
            };
          }
          if (table === "packageReleases") {
            return {
              withIndex: vi.fn(() => ({ order: vi.fn(() => ({ paginate })) })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
        patch,
        insert: vi.fn(),
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn(() => null),
      },
    };

    await expect(
      claimPackageInspectorScanBatchInternalHandler(ctx as never, {
        batchSize: 1,
        cursor: null,
        runId: "run-new",
      }),
    ).resolves.toMatchObject({ ok: true, leased: false, nextCursor: "page-3" });
    expect(paginate).toHaveBeenCalledWith({ cursor: "page-2", numItems: 1 });
    expect(patch).toHaveBeenCalledWith(
      "packageInspectorScanCursors:nightly",
      expect.objectContaining({ cursor: "page-2", pendingCursor: "page-3", runId: "run-new" }),
    );
  });

  it("claims only latest releases for nightly plugin inspector scans", async () => {
    const paginate = vi.fn(async () => ({
      page: [
        {
          _id: "packageReleases:old",
          packageId: "packages:modern",
          version: "1.0.0",
          artifactKind: "legacy-zip",
        },
        {
          _id: "packageReleases:current",
          packageId: "packages:modern",
          version: "2.0.0",
          artifactKind: "npm-pack",
        },
        {
          _id: "packageReleases:legacy-latest",
          packageId: "packages:legacy",
          version: "1.5.0",
          artifactKind: "legacy-zip",
        },
      ],
      isDone: true,
      continueCursor: null,
    }));
    const ctx = {
      db: {
        get: vi.fn(async (id: string) => {
          if (id === "packages:modern") {
            return {
              _id: "packages:modern",
              name: "modern-plugin",
              family: "code-plugin",
              channel: "community",
              latestReleaseId: "packageReleases:current",
              tags: { latest: "packageReleases:current" },
            };
          }
          if (id === "packages:legacy") {
            return {
              _id: "packages:legacy",
              name: "legacy-plugin",
              family: "code-plugin",
              channel: "community",
              tags: { latest: "packageReleases:legacy-latest" },
            };
          }
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table === "packageInspectorScanCursors") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(null),
              })),
            };
          }
          if (table === "packageReleases") {
            return {
              withIndex: vi.fn(() => ({
                order: vi.fn(() => ({
                  paginate,
                })),
              })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
        insert: vi.fn(),
        patch: vi.fn(),
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn(() => null),
      },
    };

    await expect(
      claimPackageInspectorScanBatchInternalHandler(ctx as never, {
        batchSize: 3,
        leaseMs: 60_000,
        runId: "run-42",
      }),
    ).resolves.toMatchObject({
      ok: true,
      leased: false,
      items: [
        { releaseId: "packageReleases:current", packageName: "modern-plugin" },
        { releaseId: "packageReleases:legacy-latest", packageName: "legacy-plugin" },
      ],
    });
  });

  it("skips latest releases already scanned by the same beta target and inspector", async () => {
    const paginate = vi.fn(async () => ({
      page: [
        {
          _id: "packageReleases:current",
          packageId: "packages:modern",
          version: "2.0.0",
          artifactKind: "npm-pack",
        },
      ],
      isDone: true,
      continueCursor: null,
    }));
    const scanStateWithIndex = vi.fn(() => ({
      unique: vi.fn().mockResolvedValue({
        releaseId: "packageReleases:current",
        inspectorVersion: "0.6.0",
        targetOpenClawVersion: "2026.8.0-beta.1",
      }),
    }));
    const ctx = {
      db: {
        get: vi.fn(async (id: string) =>
          id === "packages:modern"
            ? {
                _id: "packages:modern",
                name: "modern-plugin",
                family: "code-plugin",
                channel: "community",
                ownerUserId: "users:owner",
                latestReleaseId: "packageReleases:current",
              }
            : null,
        ),
        query: vi.fn((table: string) => {
          if (table === "packageReleases") {
            return {
              withIndex: vi.fn(() => ({ order: vi.fn(() => ({ paginate })) })),
            };
          }
          if (table === "packageInspectorScanStates") {
            return { withIndex: scanStateWithIndex };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      },
    };

    await expect(
      previewPackageInspectorScanBatchInternalHandler(ctx as never, {
        batchSize: 1,
        inspectorVersion: "0.6.0",
        targetOpenClawVersion: "2026.8.0-beta.1",
      }),
    ).resolves.toMatchObject({
      ok: true,
      items: [],
      skippedUnchanged: 1,
    });
    expect(scanStateWithIndex).toHaveBeenCalledWith(
      "by_release_and_inspector_version_and_target_openclaw_version",
      expect.any(Function),
    );

    await expect(
      previewPackageInspectorScanBatchInternalHandler(ctx as never, {
        batchSize: 1,
        inspectorVersion: "0.6.0",
        targetOpenClawVersion: "2026.8.0-beta.1",
        notifyOwners: true,
      }),
    ).resolves.toMatchObject({
      items: [{ releaseId: "packageReleases:current" }],
      skippedUnchanged: 0,
    });
  });

  it("returns a filtered source page without issuing a second paginated query", async () => {
    const paginate = vi
      .fn()
      .mockResolvedValueOnce({
        page: [
          {
            _id: "packageReleases:old",
            packageId: "packages:modern",
            version: "1.0.0",
            artifactKind: "legacy-zip",
          },
          {
            _id: "packageReleases:current",
            packageId: "packages:modern",
            version: "2.0.0",
            artifactKind: "npm-pack",
          },
        ],
        isDone: false,
        continueCursor: "page-2",
      })
      .mockResolvedValueOnce({
        page: [
          {
            _id: "packageReleases:other",
            packageId: "packages:other",
            version: "1.0.0",
            artifactKind: "npm-pack",
          },
        ],
        isDone: true,
        continueCursor: null,
      });
    const ctx = {
      db: {
        get: vi.fn(async (id: string) =>
          id === "packages:modern"
            ? {
                _id: "packages:modern",
                name: "modern-plugin",
                family: "code-plugin",
                channel: "community",
                ownerUserId: "users:owner",
                latestReleaseId: "packageReleases:current",
              }
            : {
                _id: "packages:other",
                name: "other-plugin",
                family: "bundle-plugin",
                channel: "community",
                ownerUserId: "users:owner",
                latestReleaseId: "packageReleases:other",
              },
        ),
        query: vi.fn((table: string) => {
          if (table !== "packageReleases") throw new Error(`Unexpected table ${table}`);
          return { withIndex: vi.fn(() => ({ order: vi.fn(() => ({ paginate })) })) };
        }),
      },
    };

    await expect(
      previewPackageInspectorScanBatchInternalHandler(ctx as never, { batchSize: 2 }),
    ).resolves.toMatchObject({
      nextCursor: "page-2",
      items: [{ releaseId: "packageReleases:current", packageName: "modern-plugin" }],
    });
    expect(paginate).toHaveBeenCalledTimes(1);
    expect(paginate).toHaveBeenCalledWith({ cursor: null, numItems: 2 });
  });

  it("rejects a non-advancing nightly scan pagination cursor", async () => {
    const paginate = vi.fn(async () => ({
      page: [],
      isDone: false,
      continueCursor: "stuck-cursor",
    }));
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn((table: string) => {
          if (table !== "packageReleases") throw new Error(`Unexpected table ${table}`);
          return { withIndex: vi.fn(() => ({ order: vi.fn(() => ({ paginate })) })) };
        }),
      },
    };

    await expect(
      previewPackageInspectorScanBatchInternalHandler(ctx as never, {
        cursor: "stuck-cursor",
        batchSize: 25,
      }),
    ).rejects.toThrow("Package Inspector scan pagination cursor did not advance");
    expect(paginate).toHaveBeenCalledTimes(1);
  });

  it("previews nightly plugin inspector batches without leasing or advancing the cursor", async () => {
    const paginate = vi.fn(async () => ({
      page: [
        {
          _id: "packageReleases:old",
          packageId: "packages:modern",
          version: "1.0.0",
          artifactKind: "legacy-zip",
        },
        {
          _id: "packageReleases:current",
          packageId: "packages:modern",
          version: "2.0.0",
          artifactKind: "npm-pack",
        },
      ],
      isDone: false,
      continueCursor: "cursor-after-preview",
    }));
    const insert = vi.fn();
    const patch = vi.fn();
    const ctx = {
      db: {
        get: vi.fn(async (id: string) => {
          if (id === "packages:modern") {
            return {
              _id: "packages:modern",
              name: "modern-plugin",
              family: "code-plugin",
              channel: "community",
              ownerUserId: "users:owner",
              ownerPublisherId: "publishers:owner",
              latestReleaseId: "packageReleases:current",
            };
          }
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table === "packageReleases") {
            return {
              withIndex: vi.fn(() => ({
                order: vi.fn(() => ({
                  paginate,
                })),
              })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
        insert,
        patch,
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn(() => null),
      },
    };

    await expect(
      previewPackageInspectorScanBatchInternalHandler(ctx as never, {
        cursor: "cursor-before-preview",
        batchSize: 1,
      }),
    ).resolves.toMatchObject({
      ok: true,
      leased: false,
      nextCursor: "cursor-after-preview",
      items: [
        {
          releaseId: "packageReleases:current",
          packageName: "modern-plugin",
          ownerUserId: "users:owner",
          ownerPublisherId: "publishers:owner",
        },
      ],
    });
    expect(paginate).toHaveBeenCalledWith({ cursor: "cursor-before-preview", numItems: 1 });
    expect(insert).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("does not claim private or public-blocked releases for unauthenticated nightly scans", async () => {
    const paginate = vi.fn(async () => ({
      page: [
        {
          _id: "packageReleases:public",
          packageId: "packages:public",
          version: "1.0.0",
          artifactKind: "legacy-zip",
        },
        {
          _id: "packageReleases:private",
          packageId: "packages:private",
          version: "1.0.0",
          artifactKind: "legacy-zip",
        },
        {
          _id: "packageReleases:blocked",
          packageId: "packages:blocked",
          version: "1.0.0",
          artifactKind: "legacy-zip",
          manualModeration: { state: "revoked" },
        },
      ],
      isDone: true,
      continueCursor: null,
    }));
    const ctx = {
      db: {
        get: vi.fn(async (id: string) => {
          if (id === "packages:public") {
            return {
              _id: "packages:public",
              name: "public-plugin",
              family: "code-plugin",
              channel: "community",
              scanStatus: "clean",
              latestReleaseId: "packageReleases:public",
            };
          }
          if (id === "packages:private") {
            return {
              _id: "packages:private",
              name: "private-plugin",
              family: "code-plugin",
              channel: "private",
              scanStatus: "clean",
              latestReleaseId: "packageReleases:private",
            };
          }
          if (id === "packages:blocked") {
            return {
              _id: "packages:blocked",
              name: "blocked-plugin",
              family: "code-plugin",
              channel: "community",
              scanStatus: "clean",
              latestReleaseId: "packageReleases:blocked",
            };
          }
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table === "packageInspectorScanCursors") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(null),
              })),
            };
          }
          if (table === "packageReleases") {
            return {
              withIndex: vi.fn(() => ({
                order: vi.fn(() => ({
                  paginate,
                })),
              })),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
        insert: vi.fn(),
        patch: vi.fn(),
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn(() => null),
      },
    };

    await expect(
      claimPackageInspectorScanBatchInternalHandler(ctx as never, {
        batchSize: 3,
        leaseMs: 60_000,
        runId: "run-42",
      }),
    ).resolves.toMatchObject({
      ok: true,
      leased: false,
      items: [{ packageName: "public-plugin" }],
    });
  });

  it("does not list plugin inspector warnings for signed-out viewers", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue(null);
    const ctx = {
      db: {
        get: vi.fn(),
        query: vi.fn(),
      },
    };

    await expect(
      listPackageInspectorWarningsForManagerHandler(ctx as never, {
        name: "demo-plugin",
      }),
    ).resolves.toEqual([]);
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  it("lists manager plugin inspector findings only for the latest release", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue("users:owner" as never);
    const warningIndexEq = vi.fn(() => ({}));
    const warningWithIndex = vi.fn(
      (_indexName: string, build: (q: { eq: typeof warningIndexEq }) => unknown) => {
        build({ eq: warningIndexEq });
        return {
          order: vi.fn(() => ({
            take: vi.fn().mockResolvedValue([
              {
                _id: "packageInspectorWarnings:latest",
                packageName: "demo-plugin",
                version: "2.0.0",
                findingKind: "warning",
                code: "latest-warning",
                message: "latest release warning",
                createdAt: 2,
                authorRemediation: {
                  summary: "Update the plugin API usage.",
                },
              },
            ]),
          })),
        };
      },
    );
    const ctx = {
      db: {
        get: vi.fn(async (id: string) => {
          if (id === "users:owner") return { _id: "users:owner", role: "user" };
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table === "packages") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue({
                  _id: "packages:demo",
                  name: "demo-plugin",
                  normalizedName: "demo-plugin",
                  family: "code-plugin",
                  ownerUserId: "users:owner",
                  latestReleaseId: "packageReleases:demo-2",
                }),
              })),
            };
          }
          if (table === "packageInspectorWarnings") {
            return { withIndex: warningWithIndex };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      },
    };

    await expect(
      listPackageInspectorWarningsForManagerHandler(ctx as never, {
        name: "demo-plugin",
      }),
    ).resolves.toMatchObject([{ code: "latest-warning", version: "2.0.0" }]);
    expect(warningWithIndex).toHaveBeenCalledWith("by_release_created", expect.any(Function));
    expect(warningIndexEq).toHaveBeenCalledWith("releaseId", "packageReleases:demo-2");
    expect(warningIndexEq).not.toHaveBeenCalledWith("packageId", "packages:demo");
  });

  it("infers owner handle from scoped package names for user package publishes", async () => {
    const runMutation = vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
      if (args.minimumRole === "publisher") {
        return { publisherId: "publishers:openclaw" };
      }
      return { ok: true, packageId: "packages:discord", releaseId: "releases:discord-1" };
    });
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          _id: "users:steipete",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "users:steipete",
          role: "admin",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce(null),
      runMutation,
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: {
        get: vi.fn(),
      },
    };

    await expect(
      publishPackageForUserInternalHandler(ctx as never, {
        actorUserId: "users:steipete",
        payload: {
          name: "@openclaw/discord",
          displayName: "Discord",
          family: "bundle-plugin",
          version: "2026.5.3-beta.2",
          changelog: "beta",
          bundle: { hostTargets: ["desktop"] },
          files: [],
        },
      }),
    ).rejects.toThrow("openclaw.plugin.json is required");

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorUserId: "users:steipete",
        ownerHandle: "openclaw",
        minimumRole: "publisher",
      }),
    );
  });

  it("treats blank owner handles as omitted for scoped package publishes", async () => {
    const runMutation = vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
      if (args.minimumRole === "publisher") {
        return { publisherId: "publishers:opik" };
      }
      return { ok: true, packageId: "packages:opik", releaseId: "releases:opik-1" };
    });
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          _id: "users:vincent",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "users:vincent",
          role: "admin",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce(null),
      runMutation,
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: {
        get: vi.fn(),
      },
    };

    await expect(
      publishPackageForUserInternalHandler(ctx as never, {
        actorUserId: "users:vincent",
        payload: {
          name: "@opik/opik-openclaw",
          ownerHandle: "   ",
          displayName: "Opik",
          family: "bundle-plugin",
          version: "0.2.15",
          changelog: "beta",
          bundle: { hostTargets: ["desktop"] },
          files: [],
        },
      }),
    ).rejects.toThrow("openclaw.plugin.json is required");

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorUserId: "users:vincent",
        ownerHandle: "opik",
        minimumRole: "publisher",
      }),
    );
  });

  it("rejects scoped package publishes to missing publishers with package.json guidance", async () => {
    const runMutation = vi.fn(async () => {
      throw new Error('Publisher "@opik" not found');
    });
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          _id: "users:vincent",
          handle: "vincentkoc",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "users:vincent",
          handle: "vincentkoc",
          role: "user",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        }),
      runMutation,
      runAction: makePublishRunActionMock(),
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: {
        get: vi.fn(),
      },
    };

    await expect(
      publishPackageForUserInternalHandler(ctx as never, {
        actorUserId: "users:vincent",
        payload: {
          name: "@opik/opik-openclaw",
          displayName: "Opik",
          family: "bundle-plugin",
          version: "0.2.15",
          changelog: "beta",
          bundle: { hostTargets: ["desktop"] },
          files: [],
        },
      }),
    ).rejects.toThrow('Create it with "clawhub publisher create opik".');
  });

  it("guides legacy personal scoped packages through org creation and transfer", async () => {
    const runMutation = vi.fn(async () => {
      throw new Error('Publisher "@opik" not found');
    });
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce({
          _id: "packages:opik-openclaw",
          ownerUserId: "users:vincent",
          ownerPublisherId: "publishers:vincent",
        })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          _id: "users:vincent",
          handle: "vincentkoc",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "users:vincent",
          handle: "vincentkoc",
          role: "user",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "publishers:vincent",
          kind: "user",
          handle: "vincentkoc",
          linkedUserId: "users:vincent",
        }),
      runMutation,
      runAction: makePublishRunActionMock(),
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: {
        get: vi.fn(),
      },
    };

    await expect(
      publishPackageForUserInternalHandler(ctx as never, {
        actorUserId: "users:vincent",
        payload: {
          name: "@opik/opik-openclaw",
          displayName: "Opik",
          family: "bundle-plugin",
          version: "0.2.15",
          changelog: "beta",
          bundle: { hostTargets: ["desktop"] },
          files: [],
        },
      }),
    ).rejects.toThrow(
      [
        'Cannot publish @opik/opik-openclaw: package.json name is scoped to "@opik", but ClawHub has no "@opik" publisher.',
        "",
        'This package already exists under your personal publisher "@vincentkoc". To move it into the matching org publisher, run:',
        "",
        '  clawhub publisher create opik --display-name "Opik"',
        '  clawhub package transfer @opik/opik-openclaw --to opik --reason "Move legacy personal package into @opik"',
        "",
        "Then rerun publish.",
      ].join("\n"),
    );
  });

  it("does not show transfer guidance for scoped packages owned by another publisher", async () => {
    const runMutation = vi.fn(async () => {
      throw new Error('Publisher "@opik" not found');
    });
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce({
          _id: "packages:opik-openclaw",
          ownerUserId: "users:other",
          ownerPublisherId: "publishers:other",
        })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          _id: "users:vincent",
          handle: "vincentkoc",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "users:vincent",
          handle: "vincentkoc",
          role: "user",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        }),
      runMutation,
      runAction: makePublishRunActionMock(),
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: {
        get: vi.fn(),
      },
    };

    await expect(
      publishPackageForUserInternalHandler(ctx as never, {
        actorUserId: "users:vincent",
        payload: {
          name: "@opik/opik-openclaw",
          displayName: "Opik",
          family: "bundle-plugin",
          version: "0.2.15",
          changelog: "beta",
          bundle: { hostTargets: ["desktop"] },
          files: [],
        },
      }),
    ).rejects.toThrow(
      [
        'Cannot publish @opik/opik-openclaw: package.json name is scoped to "@opik", but ClawHub has no "@opik" publisher.',
        'Create it with "clawhub publisher create opik".',
      ].join(" "),
    );
  });

  it("suggests publisher creation for missing npm-compatible package scopes", async () => {
    const runMutation = vi.fn(async () => {
      throw new Error('Publisher "@example.tools" not found');
    });
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          _id: "users:vincent",
          handle: "vincentkoc",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "users:vincent",
          handle: "vincentkoc",
          role: "user",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        }),
      runMutation,
      runAction: makePublishRunActionMock(),
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: {
        get: vi.fn(),
      },
    };

    await expect(
      publishPackageForUserInternalHandler(ctx as never, {
        actorUserId: "users:vincent",
        payload: {
          name: "@example.tools/demo-plugin",
          displayName: "Demo",
          family: "bundle-plugin",
          version: "1.0.0",
          changelog: "beta",
          bundle: { hostTargets: ["desktop"] },
          files: [],
        },
      }),
    ).rejects.toThrow('Create it with "clawhub publisher create example.tools".');
  });

  it("explains scoped package publish access failures from package.json", async () => {
    const runMutation = vi.fn(async () => {
      throw new Error('Forbidden: you do not have publish access to publisher "@openclaw"');
    });
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          _id: "users:steipete",
          handle: "steipete",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "users:steipete",
          handle: "steipete",
          role: "user",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        }),
      runMutation,
      runAction: makePublishRunActionMock(),
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: {
        get: vi.fn(),
      },
    };

    await expect(
      publishPackageForUserInternalHandler(ctx as never, {
        actorUserId: "users:steipete",
        payload: {
          name: "@openclaw/discord",
          displayName: "Discord",
          family: "bundle-plugin",
          version: "2026.5.3-beta.2",
          changelog: "beta",
          bundle: { hostTargets: ["desktop"] },
          files: [],
        },
      }),
    ).rejects.toThrow(
      [
        'Cannot publish @openclaw/discord: package.json name is scoped to "@openclaw", but your account does not have publish rights to the "@openclaw" ClawHub organization.',
        "Create the matching ClawHub organization if it does not exist, get publish rights to that organization, or rename package.json name to use an organization scope you control.",
      ].join("\n\n"),
    );
  });

  it("rejects scoped package publishes when --owner conflicts with the package scope", async () => {
    const runMutation = vi.fn();
    const ctx = {
      runQuery: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          _id: "users:steipete",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        })
        .mockResolvedValueOnce({
          _id: "users:steipete",
          role: "user",
          githubCreatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000,
        }),
      runMutation,
      runAction: makePublishRunActionMock(),
      scheduler: {
        runAfter: vi.fn(),
      },
      storage: {
        get: vi.fn(),
      },
    };

    await expect(
      publishPackageForUserInternalHandler(ctx as never, {
        actorUserId: "users:steipete",
        payload: {
          name: "@opik/opik-openclaw",
          ownerHandle: "vincentkoc",
          displayName: "Opik",
          family: "bundle-plugin",
          version: "0.2.15",
          changelog: "beta",
          bundle: { hostTargets: ["desktop"] },
          files: [],
        },
      }),
    ).rejects.toThrow('Package scope "@opik" must match selected owner "@vincentkoc"');
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("keeps pending-scan packages visible to public reads", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue(null);
    const ctx = {
      db: {
        get: vi.fn(async (id: string) => {
          if (id === "packageReleases:demo-1") return makeReleaseDoc({ version: "1.0.0" });
          if (id === "users:owner") return { _id: "users:owner", handle: "owner" };
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table !== "packages") throw new Error(`Unexpected table ${table}`);
          return {
            withIndex: vi.fn(() => ({
              unique: vi.fn().mockResolvedValue(makePackageDoc({ scanStatus: "pending" })),
            })),
          };
        }),
      },
    };

    const result = await getByNameHandler(ctx as never, {
      name: "demo-plugin",
    });
    expect(result?.package?.name).toBe("demo-plugin");
  });

  it("keeps pending-scan packages visible to the owner", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue("users:owner" as never);
    const result = await getByNameHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "packageReleases:demo-1") return makeReleaseDoc({ version: "1.0.0" });
            if (id === "users:owner") return { _id: "users:owner", handle: "owner" };
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table !== "packages") throw new Error(`Unexpected table ${table}`);
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(
                  makePackageDoc({
                    ownerUserId: "users:owner",
                    scanStatus: "pending",
                  }),
                ),
              })),
            };
          }),
          replace: vi.fn(),
          delete: vi.fn(),
          normalizeId: vi.fn(),
        },
      } as never,
      { name: "demo-plugin" },
    );

    expect(result?.package?.name).toBe("demo-plugin");
  });

  it("lists owner packages with pending review and latest release scan state", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue("users:owner" as never);
    const result = await listHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "packageReleases:demo-1") {
              return makeReleaseDoc({
                version: "1.0.0",
                vtAnalysis: { status: "pending" },
                llmAnalysis: { status: "clean" },
                staticScan: { status: "clean" },
              });
            }
            if (id === "users:owner") {
              return { _id: "users:owner", handle: "owner" };
            }
            if (id === "publishers:owner") {
              return {
                _id: "publishers:owner",
                kind: "user",
                linkedUserId: "users:owner",
              };
            }
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table === "packages") {
              return {
                withIndex: vi.fn((indexName: string) => {
                  if (indexName === "by_owner_publisher") {
                    return {
                      order: vi.fn(() => ({
                        take: vi.fn().mockResolvedValue([
                          makePackageDoc({
                            ownerPublisherId: "publishers:owner",
                            scanStatus: "pending",
                          }),
                        ]),
                      })),
                    };
                  }
                  if (indexName === "by_owner") {
                    return {
                      order: vi.fn(() => ({
                        take: vi.fn().mockResolvedValue([]),
                      })),
                    };
                  }
                  throw new Error(`Unexpected index ${indexName}`);
                }),
              };
            }
            if (table === "publisherMembers") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue(null),
                })),
              };
            }
            if (table === "packageInspectorWarnings") {
              return {
                withIndex: vi.fn(() => ({
                  order: vi.fn(() => ({
                    take: vi.fn().mockResolvedValue([
                      {
                        _id: "packageInspectorWarnings:internal",
                        code: "runtime-tool-capture",
                        issueClass: "inspector-gap",
                        message: "runtime tool schema needs registration capture",
                      },
                      {
                        _id: "packageInspectorWarnings:author",
                        code: "legacy-before-agent-start",
                        issueClass: "deprecation-warning",
                        message: "legacy before_agent_start hook is deprecated",
                        authorRemediation: {
                          summary: "Move prompt mutation work to before_prompt_build.",
                        },
                      },
                    ]),
                  })),
                })),
              };
            }
            throw new Error(`Unexpected table ${table}`);
          }),
        },
      } as never,
      { ownerPublisherId: "publishers:owner", limit: 20 },
    );

    expect(result).toEqual([
      expect.objectContaining({
        name: "demo-plugin",
        pendingReview: true,
        scanStatus: "pending",
        inspectorWarningCount: 1,
        latestRelease: expect.objectContaining({
          vtStatus: "pending",
          staticScanStatus: "clean",
        }),
      }),
    ]);
  });

  it("lists packages for the viewer's legacy no-link personal publisher dashboard", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue("users:owner" as never);
    const result = await listHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "packageReleases:demo-1") return makeReleaseDoc({ version: "1.0.0" });
            if (id === "packageReleases:legacy-1") {
              return makeReleaseDoc({
                _id: "packageReleases:legacy-1",
                packageId: "packages:legacy-direct",
                version: "1.0.0",
              });
            }
            if (id === "users:owner") {
              return {
                _id: "users:owner",
                handle: "owner",
                personalPublisherId: "publishers:owner",
              };
            }
            if (id === "publishers:owner") {
              return {
                _id: "publishers:owner",
                kind: "user",
                linkedUserId: undefined,
              };
            }
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table === "packages") {
              return {
                withIndex: vi.fn((indexName: string) => {
                  if (indexName === "by_owner_publisher") {
                    return {
                      order: vi.fn(() => ({
                        take: vi
                          .fn()
                          .mockResolvedValue([
                            makePackageDoc({ ownerPublisherId: "publishers:owner" }),
                          ]),
                      })),
                    };
                  }
                  if (indexName === "by_owner") {
                    return {
                      order: vi.fn(() => ({
                        take: vi.fn().mockResolvedValue([
                          makePackageDoc({
                            _id: "packages:legacy-direct",
                            name: "legacy-direct-plugin",
                            normalizedName: "legacy-direct-plugin",
                            displayName: "Legacy Direct Plugin",
                            ownerPublisherId: undefined,
                            latestReleaseId: "packageReleases:legacy-1",
                          }),
                        ]),
                      })),
                    };
                  }
                  throw new Error(`Unexpected index ${indexName}`);
                }),
              };
            }
            if (table === "publisherMembers") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue(null),
                })),
              };
            }
            if (table === "packageInspectorWarnings") {
              return makeEmptyPackageInspectorWarningsQuery();
            }
            throw new Error(`Unexpected table ${table}`);
          }),
        },
      } as never,
      { ownerPublisherId: "publishers:owner", limit: 20 },
    );

    expect(result).toEqual([
      expect.objectContaining({
        name: "demo-plugin",
        ownerPublisherId: "publishers:owner",
      }),
      expect.objectContaining({
        name: "legacy-direct-plugin",
        ownerPublisherId: undefined,
      }),
    ]);
  });

  it("keeps stale publisher-owned package rows out of owner-user dashboards", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue("users:owner" as never);
    const result = await listHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "users:owner") {
              return { _id: "users:owner", handle: "owner" };
            }
            if (id === "publishers:other-personal") {
              return {
                _id: "publishers:other-personal",
                kind: "user",
                linkedUserId: "users:other",
              };
            }
            if (id === "publishers:org") {
              return { _id: "publishers:org", kind: "org" };
            }
            if (id === "packageReleases:legacy-1") {
              return makeReleaseDoc({
                _id: "packageReleases:legacy-1",
                packageId: "packages:legacy-direct",
                version: "1.0.0",
              });
            }
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table === "packages") {
              return {
                withIndex: vi.fn((indexName: string) => {
                  if (indexName !== "by_owner") throw new Error(`Unexpected index ${indexName}`);
                  return {
                    order: vi.fn(() => ({
                      take: vi.fn().mockResolvedValue([
                        makePackageDoc({
                          _id: "packages:other-personal",
                          name: "other-personal-plugin",
                          ownerPublisherId: "publishers:other-personal",
                        }),
                        makePackageDoc({
                          _id: "packages:org",
                          name: "org-plugin",
                          ownerPublisherId: "publishers:org",
                        }),
                        makePackageDoc({
                          _id: "packages:legacy-direct",
                          name: "legacy-direct-plugin",
                          normalizedName: "legacy-direct-plugin",
                          displayName: "Legacy Direct Plugin",
                          ownerPublisherId: undefined,
                          latestReleaseId: "packageReleases:legacy-1",
                        }),
                      ]),
                    })),
                  };
                }),
              };
            }
            if (table === "packageInspectorWarnings") {
              return makeEmptyPackageInspectorWarningsQuery();
            }
            throw new Error(`Unexpected table ${table}`);
          }),
        },
      } as never,
      { ownerUserId: "users:owner", limit: 20 },
    );

    expect(result.map((entry) => entry.name)).toEqual(["legacy-direct-plugin"]);
  });

  it("returns no owner packages when the viewer lacks access", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue("users:stranger" as never);
    const result = await listHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "users:stranger") {
              return { _id: "users:stranger", handle: "stranger", displayName: "Stranger" };
            }
            if (id === "publishers:owner") {
              return {
                _id: "publishers:owner",
                kind: "user",
                linkedUserId: "users:owner",
              };
            }
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table === "publisherMembers") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue(null),
                })),
              };
            }
            throw new Error(`Unexpected table ${table}`);
          }),
        },
      } as never,
      { ownerPublisherId: "publishers:owner", limit: 20 },
    );

    expect(result).toEqual([]);
  });

  it("ignores stale personal memberships for package dashboards", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue("users:stranger" as never);
    const result = await listHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "publishers:owner") {
              return {
                _id: "publishers:owner",
                kind: "user",
                linkedUserId: "users:owner",
              };
            }
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table === "packages") {
              return {
                withIndex: vi.fn(() => ({
                  order: vi.fn(() => ({
                    take: vi
                      .fn()
                      .mockResolvedValue([
                        makePackageDoc({ ownerPublisherId: "publishers:owner" }),
                      ]),
                  })),
                })),
              };
            }
            if (table === "publisherMembers") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue({
                    _id: "publisherMembers:stale",
                    publisherId: "publishers:owner",
                    userId: "users:stranger",
                    role: "owner",
                  }),
                })),
              };
            }
            if (table === "packageInspectorWarnings") {
              return makeEmptyPackageInspectorWarningsQuery();
            }
            throw new Error(`Unexpected table ${table}`);
          }),
        },
      } as never,
      { ownerPublisherId: "publishers:owner", limit: 20 },
    );

    expect(result).toEqual([]);
  });

  it("keeps org memberships authorized for package dashboards", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue("users:member" as never);
    const result = await listHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "users:member") {
              return { _id: "users:member", handle: "member", displayName: "Member" };
            }
            if (id === "publishers:org") {
              return {
                _id: "publishers:org",
                kind: "org",
                handle: "team",
                displayName: "Team",
              };
            }
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table === "packages") {
              return {
                withIndex: vi.fn(() => ({
                  order: vi.fn(() => ({
                    take: vi
                      .fn()
                      .mockResolvedValue([makePackageDoc({ ownerPublisherId: "publishers:org" })]),
                  })),
                })),
              };
            }
            if (table === "publisherMembers") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue({
                    _id: "publisherMembers:member",
                    publisherId: "publishers:org",
                    userId: "users:member",
                    role: "publisher",
                  }),
                })),
              };
            }
            if (table === "packageInspectorWarnings") {
              return makeEmptyPackageInspectorWarningsQuery();
            }
            throw new Error(`Unexpected table ${table}`);
          }),
        },
      } as never,
      { ownerPublisherId: "publishers:org", limit: 20 },
    );

    expect(result).toEqual([expect.objectContaining({ name: "demo-plugin" })]);
  });

  it("records package reports for moderation", async () => {
    const insert = vi.fn(async (table: string) =>
      table === "packageReports" ? "packageReports:1" : "auditLogs:1",
    );
    const patch = vi.fn();
    const reportReason = "x".repeat(520);

    const result = await reportPackageForUserInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "users:reporter") return { _id: id };
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table === "packages") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue(makePackageDoc()),
                })),
              };
            }
            if (table === "packageReleases") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue(makeReleaseDoc({ version: "1.2.3" })),
                })),
              };
            }
            if (table === "packageReports") {
              return {
                withIndex: vi.fn((indexName: string) => {
                  if (indexName === "by_user") {
                    return { collect: vi.fn().mockResolvedValue([]) };
                  }
                  return { unique: vi.fn().mockResolvedValue(null) };
                }),
              };
            }
            throw new Error(`Unexpected table ${table}`);
          }),
          insert,
          patch,
          replace: vi.fn(),
          delete: vi.fn(),
          normalizeId: vi.fn(),
        },
      } as never,
      {
        actorUserId: "users:reporter",
        name: "@scope/demo",
        version: "1.2.3",
        reason: reportReason,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      reported: true,
      alreadyReported: false,
      packageId: "packages:demo",
      releaseId: "packageReleases:demo-1",
      reportCount: 1,
    });
    expect(insert).toHaveBeenCalledWith("packageReports", {
      packageId: "packages:demo",
      releaseId: "packageReleases:demo-1",
      version: "1.2.3",
      userId: "users:reporter",
      reason: "x".repeat(500),
      status: "open",
      createdAt: expect.any(Number),
    });
    expect(patch).toHaveBeenCalledWith("packages:demo", {
      reportCount: 1,
      lastReportedAt: expect.any(Number),
    });
    expect(insert).toHaveBeenCalledWith(
      "auditLogs",
      expect.objectContaining({
        actorUserId: "users:reporter",
        action: "package.report",
        targetType: "package",
        targetId: "packages:demo",
      }),
    );
  });

  it("dedupes package reports by user and package", async () => {
    const insert = vi.fn();
    const patch = vi.fn();

    const result = await reportPackageForUserInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "users:reporter") return { _id: id };
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table === "packages") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue(makePackageDoc({ reportCount: 2 })),
                })),
              };
            }
            if (table === "packageReports") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue({
                    _id: "packageReports:existing",
                    packageId: "packages:demo",
                    releaseId: "packageReleases:demo-1",
                    userId: "users:reporter",
                    status: "open",
                  }),
                })),
              };
            }
            throw new Error(`Unexpected table ${table}`);
          }),
          insert,
          patch,
          replace: vi.fn(),
          delete: vi.fn(),
          normalizeId: vi.fn(),
        },
      } as never,
      {
        actorUserId: "users:reporter",
        name: "@scope/demo",
        reason: "already reported",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      reported: false,
      alreadyReported: true,
      reportCount: 2,
    });
    expect(insert).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("lists package reports for moderators", async () => {
    const result = await listPackageReportsInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "users:moderator") return { _id: id, role: "moderator" };
            if (id === "users:reporter") {
              return { _id: id, handle: "reporter", displayName: "Reporter" };
            }
            if (id === "packages:demo") return makePackageDoc({ name: "@scope/demo" });
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table !== "packageReports") throw new Error(`Unexpected table ${table}`);
            return {
              withIndex: vi.fn(() => ({
                order: vi.fn(() => ({
                  paginate: vi.fn().mockResolvedValue({
                    page: [
                      {
                        _id: "packageReports:1",
                        packageId: "packages:demo",
                        releaseId: "packageReleases:demo-1",
                        version: "1.2.3",
                        userId: "users:reporter",
                        reason: "suspicious",
                        status: "open",
                        createdAt: 123,
                      },
                    ],
                    continueCursor: null,
                    isDone: true,
                  }),
                })),
              })),
            };
          }),
        },
      } as never,
      { actorUserId: "users:moderator", status: "open", limit: 10 },
    );

    expect(result).toEqual({
      items: [
        expect.objectContaining({
          reportId: "packageReports:1",
          name: "@scope/demo",
          version: "1.2.3",
          reason: "suspicious",
          status: "open",
          reporter: expect.objectContaining({ handle: "reporter" }),
        }),
      ],
      nextCursor: null,
      done: true,
    });
  });

  it("triages package reports and decrements open count", async () => {
    const patch = vi.fn();
    const insert = vi.fn(async () => "auditLogs:1");

    const result = await triagePackageReportForUserInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "users:moderator") return { _id: id, role: "moderator" };
            if (id === "packageReports:1") {
              return {
                _id: id,
                packageId: "packages:demo",
                userId: "users:reporter",
                status: "open",
                createdAt: 123,
              };
            }
            if (id === "packages:demo") return makePackageDoc({ reportCount: 2 });
            return null;
          }),
          patch,
          insert,
          query: vi.fn((table: string) => {
            if (table === "packageSearchDigest") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue({
                    _id: "packageSearchDigest:demo",
                    packageId: "packages:demo",
                  }),
                })),
              };
            }
            if (
              table === "packageCapabilitySearchDigest" ||
              table === "packageTopicSearchDigest" ||
              table === "packagePluginCategorySearchDigest"
            ) {
              return {
                withIndex: vi.fn(() => ({
                  collect: vi.fn().mockResolvedValue([]),
                })),
              };
            }
            throw new Error(`Unexpected table ${table}`);
          }),
          replace: vi.fn(),
          delete: vi.fn(),
          normalizeId: vi.fn(),
        },
      } as never,
      {
        actorUserId: "users:moderator",
        reportId: "packageReports:1",
        status: "confirmed",
        note: "handled",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      reportId: "packageReports:1",
      status: "confirmed",
      reportCount: 1,
    });
    expect(patch).toHaveBeenCalledWith("packageReports:1", {
      status: "confirmed",
      triagedAt: expect.any(Number),
      triagedBy: "users:moderator",
      triageNote: "handled",
      actionTaken: "none",
    });
    expect(patch).toHaveBeenCalledWith("packages:demo", { reportCount: 1 });
    expect(insert).toHaveBeenCalledWith(
      "auditLogs",
      expect.objectContaining({
        action: "package.report.triage",
        targetType: "packageReport",
      }),
    );
  });

  it("can quarantine a package release while triaging a valid report", async () => {
    const patch = vi.fn();
    const insert = vi.fn(async () => "auditLogs:1");
    const pkg = makePackageDoc({ reportCount: 1, latestReleaseId: "packageReleases:demo-1" });
    const release = makeReleaseDoc({
      _id: "packageReleases:demo-1",
      packageId: "packages:demo",
      version: "1.2.3",
      verification: { scanStatus: "clean" },
    });

    const result = await triagePackageReportForUserInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "users:moderator") return { _id: id, role: "moderator" };
            if (id === "packageReports:1") {
              return {
                _id: id,
                packageId: "packages:demo",
                releaseId: "packageReleases:demo-1",
                version: "1.2.3",
                userId: "users:reporter",
                status: "open",
                createdAt: 123,
              };
            }
            if (id === "packages:demo") return pkg;
            if (id === "packageReleases:demo-1") return release;
            return null;
          }),
          patch,
          insert,
          query: vi.fn((table: string) => {
            if (table === "packageSearchDigest") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue({
                    _id: "packageSearchDigest:demo",
                    packageId: "packages:demo",
                  }),
                })),
              };
            }
            if (
              table === "packageCapabilitySearchDigest" ||
              table === "packageTopicSearchDigest" ||
              table === "packagePluginCategorySearchDigest"
            ) {
              return {
                withIndex: vi.fn(() => ({
                  collect: vi.fn().mockResolvedValue([]),
                })),
              };
            }
            throw new Error(`Unexpected table ${table}`);
          }),
          replace: vi.fn(),
          delete: vi.fn(),
          normalizeId: vi.fn(),
        },
      } as never,
      {
        actorUserId: "users:moderator",
        reportId: "packageReports:1",
        status: "confirmed",
        note: "confirmed malicious behavior",
        finalAction: "quarantine",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      status: "confirmed",
      actionTaken: "quarantine",
    });
    expect(patch).toHaveBeenCalledWith("packageReports:1", {
      status: "confirmed",
      triagedAt: expect.any(Number),
      triagedBy: "users:moderator",
      triageNote: "confirmed malicious behavior",
      actionTaken: "quarantine",
    });
    expect(patch).toHaveBeenCalledWith(
      "packageReleases:demo-1",
      expect.objectContaining({
        manualModeration: expect.objectContaining({ state: "quarantined" }),
      }),
    );
    expect(insert).toHaveBeenCalledWith(
      "auditLogs",
      expect.objectContaining({
        action: "package.release.moderation",
        targetType: "packageRelease",
      }),
    );
  });

  it("returns package moderation status to package owners", async () => {
    const result = await getPackageModerationStatusForUserInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "users:owner") return { _id: id, role: "user" };
            if (id === "packageReleases:demo-1") {
              return makeReleaseDoc({
                _id: "packageReleases:demo-1",
                version: "1.2.3",
                artifactKind: "npm-pack",
                manualModeration: {
                  state: "quarantined",
                  reason: "manual review",
                  reviewerUserId: "users:moderator",
                  updatedAt: 2,
                },
              });
            }
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table !== "packages") throw new Error(`Unexpected table ${table}`);
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(
                  makePackageDoc({
                    name: "@scope/demo",
                    ownerUserId: "users:owner",
                    reportCount: 2,
                    lastReportedAt: 456,
                  }),
                ),
              })),
            };
          }),
        },
      } as never,
      { actorUserId: "users:owner", name: "@scope/demo" },
    );

    expect(result).toMatchObject({
      package: {
        name: "@scope/demo",
        reportCount: 2,
      },
      latestRelease: {
        version: "1.2.3",
        scanStatus: "malicious",
        moderationState: "quarantined",
        blockedFromDownload: true,
        reasons: ["manual:quarantined", "scan:malicious", "reports:2"],
      },
    });
  });

  it("does not let stale personal ownerUserId read package moderation status", async () => {
    await expect(
      getPackageModerationStatusForUserInternalHandler(
        {
          db: {
            get: vi.fn(async (id: string) => {
              if (id === "users:viewer") return { _id: id, role: "user" };
              return null;
            }),
            query: vi.fn((table: string) => {
              if (table === "packages") {
                return {
                  withIndex: vi.fn(() => ({
                    unique: vi.fn().mockResolvedValue(
                      makePackageDoc({
                        name: "@scope/demo",
                        ownerKind: "user",
                        ownerUserId: "users:viewer",
                        ownerPublisherId: "publishers:other-personal",
                      }),
                    ),
                  })),
                };
              }
              if (table === "publisherMembers") {
                return {
                  withIndex: vi.fn(() => ({
                    unique: vi.fn().mockResolvedValue(null),
                  })),
                };
              }
              throw new Error(`Unexpected table ${table}`);
            }),
          },
        } as never,
        { actorUserId: "users:viewer", name: "@scope/demo" },
      ),
    ).rejects.toThrow("Unauthorized");
  });

  it("submits owner appeals for quarantined package releases", async () => {
    const insert = vi.fn(async (table: string) =>
      table === "packageAppeals" ? "packageAppeals:1" : "auditLogs:1",
    );

    const result = await submitPackageAppealForUserInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "users:owner") return { _id: id, role: "user" };
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table === "packages") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue(
                    makePackageDoc({
                      name: "@scope/demo",
                      ownerUserId: "users:owner",
                    }),
                  ),
                })),
              };
            }
            if (table === "packageReleases") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue(
                    makeReleaseDoc({
                      version: "1.2.3",
                      manualModeration: {
                        state: "quarantined",
                        reason: "manual review",
                        reviewerUserId: "users:moderator",
                        updatedAt: 2,
                      },
                    }),
                  ),
                })),
              };
            }
            if (table === "packageAppeals") {
              return {
                withIndex: vi.fn(() => ({
                  order: vi.fn(() => ({
                    first: vi.fn().mockResolvedValue(null),
                  })),
                })),
              };
            }
            throw new Error(`Unexpected table ${table}`);
          }),
          insert,
          patch: vi.fn(),
          replace: vi.fn(),
          delete: vi.fn(),
          normalizeId: vi.fn(),
        },
      } as never,
      {
        actorUserId: "users:owner",
        name: "@scope/demo",
        version: "1.2.3",
        message: "please review",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      submitted: true,
      appealId: "packageAppeals:1",
      status: "open",
    });
    expect(insert).toHaveBeenCalledWith("packageAppeals", {
      packageId: "packages:demo",
      releaseId: "packageReleases:demo-1",
      version: "1.2.3",
      userId: "users:owner",
      message: "please review",
      status: "open",
      createdAt: expect.any(Number),
    });
    expect(insert).toHaveBeenCalledWith(
      "auditLogs",
      expect.objectContaining({
        action: "package.appeal.submit",
        targetType: "packageAppeal",
      }),
    );
  });

  it("does not let stale personal-publisher memberships submit package appeals", async () => {
    const insert = vi.fn();

    await expect(
      submitPackageAppealForUserInternalHandler(
        {
          db: {
            get: vi.fn(async (id: string) => {
              if (id === "users:stale-member") return { _id: id, role: "user" };
              if (id === "publishers:owner") {
                return {
                  _id: id,
                  kind: "user",
                  handle: "owner",
                  linkedUserId: "users:owner",
                };
              }
              return null;
            }),
            query: vi.fn((table: string) => {
              if (table === "packages") {
                return {
                  withIndex: vi.fn(() => ({
                    unique: vi.fn().mockResolvedValue(
                      makePackageDoc({
                        name: "@scope/demo",
                        ownerUserId: "users:owner",
                        ownerPublisherId: "publishers:owner",
                      }),
                    ),
                  })),
                };
              }
              if (table === "publisherMembers") {
                return {
                  withIndex: vi.fn(() => ({
                    unique: vi.fn().mockResolvedValue({
                      _id: "publisherMembers:stale",
                      publisherId: "publishers:owner",
                      userId: "users:stale-member",
                      role: "admin",
                    }),
                  })),
                };
              }
              throw new Error(`Unexpected table ${table}`);
            }),
            insert,
            patch: vi.fn(),
            replace: vi.fn(),
            delete: vi.fn(),
            normalizeId: vi.fn(),
          },
        } as never,
        {
          actorUserId: "users:stale-member",
          name: "@scope/demo",
          version: "1.2.3",
          message: "please review",
        },
      ),
    ).rejects.toThrow("Unauthorized");

    expect(insert).not.toHaveBeenCalled();
  });

  it("does not let stale personal-publisher memberships read package manage context", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue("users:stale-member" as never);

    const result = await getManageContextHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "users:stale-member") return { _id: id, role: "user" };
            if (id === "publishers:owner") {
              return {
                _id: id,
                kind: "user",
                handle: "owner",
                linkedUserId: "users:owner",
              };
            }
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table === "packages") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue(
                    makePackageDoc({
                      name: "@scope/demo",
                      ownerUserId: "users:owner",
                      ownerPublisherId: "publishers:owner",
                    }),
                  ),
                })),
              };
            }
            if (table === "publisherMembers") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue({
                    _id: "publisherMembers:stale",
                    publisherId: "publishers:owner",
                    userId: "users:stale-member",
                    role: "admin",
                  }),
                })),
              };
            }
            throw new Error(`Unexpected table ${table}`);
          }),
        },
      } as never,
      { name: "@scope/demo" },
    );

    expect(result).toBeNull();
  });

  it("paginates owner-withdrawn releases with explicit restore markers", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue("users:owner" as never);
    const indexNames: string[] = [];
    const filters = new Map<string, unknown>();
    const paginate = vi.fn().mockResolvedValue({
      page: [
        {
          _id: "packageReleases:withdrawn",
          packageId: "packages:demo",
          version: "0.8.0",
          changelog: "Withdrawn release",
          distTags: [],
          files: [],
          integritySha256: "sha256:withdrawn",
          compatibility: null,
          verification: null,
          createdBy: "users:owner",
          publishActor: { kind: "user", userId: "users:owner" },
          createdAt: 1,
          softDeletedAt: 123,
          ownerDeletedAt: 123,
          ownerDeletedBy: "users:owner",
        },
      ],
      isDone: true,
      continueCursor: "",
    });
    const ctx = {
      db: {
        get: vi.fn(async (id: string) => (id === "users:owner" ? { _id: id, role: "user" } : null)),
        query: vi.fn((table: string) => {
          if (table === "packages") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(makePackageDoc()),
              })),
            };
          }
          if (table === "packageReleases") {
            return {
              withIndex: vi.fn(
                (
                  index: string,
                  buildQuery?: (q: { eq: (field: string, value: unknown) => unknown }) => unknown,
                ) => {
                  indexNames.push(index);
                  const query = {
                    eq(field: string, value: unknown) {
                      filters.set(field, value);
                      return query;
                    },
                  };
                  buildQuery?.(query);
                  return { order: vi.fn(() => ({ paginate })) };
                },
              ),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      },
    } as never;

    const result = await listVersionsForManagerHandler(ctx, {
      name: "demo-plugin",
      paginationOpts: { cursor: null, numItems: 20 },
    });

    expect(result.page).toEqual([
      expect.objectContaining({
        version: "0.8.0",
        softDeletedAt: 123,
        ownerDeletedAt: 123,
      }),
    ]);
    expect(indexNames).toEqual(["by_package_owner_deleted_created"]);
    expect(filters).toEqual(
      new Map<string, unknown>([
        ["packageId", "packages:demo"],
        ["ownerDeletedBy", "users:owner"],
      ]),
    );
    expect(paginate).toHaveBeenCalledWith({ cursor: null, numItems: 20 });
  });

  it("allows direct package owners to delete versions", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue("users:owner" as never);

    const result = await canDeleteVersionsHandler(
      makeCanDeleteVersionsCtx({
        viewerId: "users:owner",
        ownerUserId: "users:owner",
      }) as never,
      { name: "demo-plugin" },
    );

    expect(result).toBe(true);
  });

  it("does not let package owners delete versions when the package is blocked from public use", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue("users:owner" as never);

    const result = await canDeleteVersionsHandler(
      makeCanDeleteVersionsCtx({
        viewerId: "users:owner",
        ownerUserId: "users:owner",
        packageOverrides: { scanStatus: "malicious" },
      }) as never,
      { name: "demo-plugin" },
    );

    expect(result).toBe(false);
  });

  it.each(["owner", "admin"] as const)(
    "allows org %s members to delete versions",
    async (membershipRole) => {
      vi.mocked(getAuthUserId).mockResolvedValue("users:org-manager" as never);

      const result = await canDeleteVersionsHandler(
        makeCanDeleteVersionsCtx({
          viewerId: "users:org-manager",
          ownerUserId: "users:creator",
          ownerPublisherId: "publishers:demo-org",
          membershipRole,
        }) as never,
        { name: "demo-plugin" },
      );

      expect(result).toBe(true);
    },
  );

  it.each([
    { label: "ordinary org publisher", membershipRole: "publisher" as const },
    { label: "non-member", membershipRole: undefined },
  ])("does not let $label delete versions", async ({ membershipRole }) => {
    vi.mocked(getAuthUserId).mockResolvedValue("users:org-viewer" as never);

    const result = await canDeleteVersionsHandler(
      makeCanDeleteVersionsCtx({
        viewerId: "users:org-viewer",
        ownerUserId: "users:creator",
        ownerPublisherId: "publishers:demo-org",
        membershipRole,
      }) as never,
      { name: "demo-plugin" },
    );

    expect(result).toBe(false);
  });

  it.each(["admin", "moderator"] as const)(
    "does not let platform %s staff delete versions without ownership",
    async (viewerRole) => {
      vi.mocked(getAuthUserId).mockResolvedValue("users:staff" as never);

      const result = await canDeleteVersionsHandler(
        makeCanDeleteVersionsCtx({
          viewerId: "users:staff",
          viewerRole,
          ownerUserId: "users:owner",
        }) as never,
        { name: "demo-plugin" },
      );

      expect(result).toBe(false);
    },
  );

  it("bounds normalized unique candidate lookups when checking version delete capability", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue("users:owner" as never);
    const packageLookupNames: string[] = [];

    const result = await canDeleteVersionsHandler(
      makeCanDeleteVersionsCtx({
        viewerId: "users:owner",
        ownerUserId: "users:owner",
        packageLookupNames,
        packageMatchName: null,
      }) as never,
      {
        name: " primary-plugin ",
        candidateNames: [
          "PRIMARY-PLUGIN",
          "candidate-one",
          "candidate-two",
          "candidate-three",
          "candidate-four",
          "candidate-five",
          "candidate-one",
        ],
      },
    );

    expect(result).toBe(false);
    expect(packageLookupNames).toEqual([
      "primary-plugin",
      "candidate-one",
      "candidate-two",
      "candidate-three",
    ]);
  });

  it("returns slim package metadata and generated category suggestions for manage context", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue("users:owner" as never);

    const pkg = makePackageDoc({
      name: "large-plugin",
      displayName: "Large Plugin",
      sourceRepo: "owner/large-plugin",
      latestVersionSummary: {
        version: "1.2.3",
        changelog: "x".repeat(10_000),
        artifact: { kind: "legacy-zip", sha256: "abc", format: "zip" },
      },
      tags: {
        latest: "packageReleases:demo-1",
        beta: "packageReleases:demo-beta",
      },
    });
    const release = makeReleaseDoc({
      version: "1.2.3",
      files: [
        {
          path: "README.md",
          size: 10_000,
          sha256: "abc",
          contentType: "text/plain; charset=utf-8",
        },
      ],
      llmAnalysis: {
        status: "clean",
        checkedAt: 2,
        findings: "x".repeat(10_000),
      },
    });

    const result = await getManageContextHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "users:owner") return { _id: id, role: "user" };
            if (id === "packageReleases:demo-1") return release;
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table === "packages") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue(pkg),
                })),
              };
            }
            throw new Error(`Unexpected table ${table}`);
          }),
        },
      } as never,
      { name: "large-plugin" },
    );

    expect(result).toEqual({
      package: {
        _id: "packages:demo",
        name: "large-plugin",
        displayName: "Large Plugin",
        categories: undefined,
        topics: undefined,
      },
      latestRelease: {
        _id: "packageReleases:demo-1",
        version: "1.2.3",
      },
      suggestedCategories: ["other"],
    });
  });

  it("lists package appeals for moderators", async () => {
    const result = await listPackageAppealsInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "users:moderator") return { _id: id, role: "moderator" };
            if (id === "users:owner") return { _id: id, handle: "owner" };
            if (id === "packages:demo") return makePackageDoc({ name: "@scope/demo" });
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table !== "packageAppeals") throw new Error(`Unexpected table ${table}`);
            return {
              withIndex: vi.fn(() => ({
                order: vi.fn(() => ({
                  paginate: vi.fn().mockResolvedValue({
                    page: [
                      {
                        _id: "packageAppeals:1",
                        packageId: "packages:demo",
                        releaseId: "packageReleases:demo-1",
                        version: "1.2.3",
                        userId: "users:owner",
                        message: "please review",
                        status: "open",
                        createdAt: 123,
                      },
                    ],
                    continueCursor: null,
                    isDone: true,
                  }),
                })),
              })),
            };
          }),
        },
      } as never,
      { actorUserId: "users:moderator", status: "open", limit: 10 },
    );

    expect(result).toEqual({
      items: [
        expect.objectContaining({
          appealId: "packageAppeals:1",
          name: "@scope/demo",
          version: "1.2.3",
          message: "please review",
          status: "open",
          submitter: expect.objectContaining({ handle: "owner" }),
        }),
      ],
      nextCursor: null,
      done: true,
    });
  });

  it("resolves package appeals for moderators", async () => {
    const patch = vi.fn();
    const insert = vi.fn(async () => "auditLogs:1");

    const result = await resolvePackageAppealForUserInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "users:moderator") return { _id: id, role: "moderator" };
            if (id === "packageAppeals:1") {
              return {
                _id: id,
                packageId: "packages:demo",
                releaseId: "packageReleases:demo-1",
                version: "1.2.3",
                userId: "users:owner",
                message: "please review",
                status: "open",
                createdAt: 123,
              };
            }
            if (id === "packages:demo") return makePackageDoc({ name: "@scope/demo" });
            return null;
          }),
          patch,
          insert,
          query: vi.fn((table: string) => {
            if (table === "packageSearchDigest") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue({
                    _id: "packageSearchDigest:demo",
                    packageId: "packages:demo",
                  }),
                })),
              };
            }
            if (
              table === "packageCapabilitySearchDigest" ||
              table === "packageTopicSearchDigest" ||
              table === "packagePluginCategorySearchDigest"
            ) {
              return {
                withIndex: vi.fn(() => ({
                  collect: vi.fn().mockResolvedValue([]),
                })),
              };
            }
            throw new Error(`Unexpected table ${table}`);
          }),
          replace: vi.fn(),
          delete: vi.fn(),
          normalizeId: vi.fn(),
        },
      } as never,
      {
        actorUserId: "users:moderator",
        appealId: "packageAppeals:1",
        status: "rejected",
        note: "scanner finding still applies",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      appealId: "packageAppeals:1",
      status: "rejected",
    });
    expect(patch).toHaveBeenCalledWith("packageAppeals:1", {
      status: "rejected",
      resolvedAt: expect.any(Number),
      resolvedBy: "users:moderator",
      resolutionNote: "scanner finding still applies",
      actionTaken: "none",
    });
    expect(insert).toHaveBeenCalledWith(
      "auditLogs",
      expect.objectContaining({
        action: "package.appeal.resolve",
        targetType: "packageAppeal",
      }),
    );
  });

  it("can approve a package release while accepting an appeal", async () => {
    const patch = vi.fn();
    const insert = vi.fn(async () => "auditLogs:1");
    const pkg = makePackageDoc({ name: "@scope/demo", latestReleaseId: "packageReleases:demo-1" });
    const release = makeReleaseDoc({
      _id: "packageReleases:demo-1",
      packageId: "packages:demo",
      version: "1.2.3",
      manualModeration: {
        state: "quarantined",
        reason: "manual review",
        reviewerUserId: "users:moderator",
        updatedAt: 2,
      },
      verification: { scanStatus: "malicious" },
    });

    const result = await resolvePackageAppealForUserInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "users:moderator") return { _id: id, role: "moderator" };
            if (id === "packageAppeals:1") {
              return {
                _id: id,
                packageId: "packages:demo",
                releaseId: "packageReleases:demo-1",
                version: "1.2.3",
                userId: "users:owner",
                message: "please review",
                status: "open",
                createdAt: 123,
              };
            }
            if (id === "packages:demo") return pkg;
            if (id === "packageReleases:demo-1") return release;
            return null;
          }),
          patch,
          insert,
          query: vi.fn((table: string) => {
            if (table === "packageSearchDigest") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue({
                    _id: "packageSearchDigest:demo",
                    packageId: "packages:demo",
                  }),
                })),
              };
            }
            if (
              table === "packageCapabilitySearchDigest" ||
              table === "packageTopicSearchDigest" ||
              table === "packagePluginCategorySearchDigest"
            ) {
              return {
                withIndex: vi.fn(() => ({
                  collect: vi.fn().mockResolvedValue([]),
                })),
              };
            }
            throw new Error(`Unexpected table ${table}`);
          }),
          replace: vi.fn(),
          delete: vi.fn(),
          normalizeId: vi.fn(),
        },
      } as never,
      {
        actorUserId: "users:moderator",
        appealId: "packageAppeals:1",
        status: "accepted",
        note: "false positive confirmed",
        finalAction: "approve",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      status: "accepted",
      actionTaken: "approve",
    });
    expect(patch).toHaveBeenCalledWith("packageAppeals:1", {
      status: "accepted",
      resolvedAt: expect.any(Number),
      resolvedBy: "users:moderator",
      resolutionNote: "false positive confirmed",
      actionTaken: "approve",
    });
    expect(patch).toHaveBeenCalledWith(
      "packageReleases:demo-1",
      expect.objectContaining({
        manualModeration: expect.objectContaining({ state: "approved" }),
      }),
    );
    expect(insert).toHaveBeenCalledWith(
      "auditLogs",
      expect.objectContaining({
        action: "package.release.moderation",
        targetType: "packageRelease",
      }),
    );
  });

  it("upserts official plugin migration rows for admins", async () => {
    let insertedMigration: Record<string, unknown> | null = null;
    const insert = vi.fn(async (table: string, doc: Record<string, unknown>) => {
      if (table === "officialPluginMigrations") {
        insertedMigration = doc;
        return "officialPluginMigrations:1";
      }
      return "auditLogs:1";
    });

    const result = await upsertOfficialPluginMigrationForUserInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "users:admin") return { _id: id, role: "admin" };
            if (id === "officialPluginMigrations:1") {
              return { _id: id, ...insertedMigration };
            }
            return null;
          }),
          insert,
          patch: vi.fn(),
          replace: vi.fn(),
          delete: vi.fn(),
          normalizeId: vi.fn(),
          query: vi.fn((table: string) => {
            if (table === "packages") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue(makePackageDoc({ _id: "packages:demo" })),
                })),
              };
            }
            if (table === "officialPluginMigrations") {
              return {
                withIndex: vi.fn(() => ({ unique: vi.fn().mockResolvedValue(null) })),
              };
            }
            throw new Error(`Unexpected table ${table}`);
          }),
        },
      } as never,
      {
        actorUserId: "users:admin",
        bundledPluginId: "Core.Search",
        packageName: "@scope/demo",
        phase: "blocked",
        blockers: ["missing ClawPack", "missing ClawPack"],
        hostTargetsComplete: true,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      migration: {
        bundledPluginId: "core.search",
        packageName: "@scope/demo",
        packageId: "packages:demo",
        phase: "blocked",
        blockers: ["missing ClawPack"],
        hostTargetsComplete: true,
      },
    });
    expect(insert).toHaveBeenCalledWith(
      "auditLogs",
      expect.objectContaining({ action: "package.official_migration.upsert" }),
    );
  });

  it("lists official plugin migration rows for moderators", async () => {
    const result = await listOfficialPluginMigrationsInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "users:moderator") return { _id: id, role: "moderator" };
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table !== "officialPluginMigrations") throw new Error(`Unexpected table ${table}`);
            return {
              withIndex: vi.fn(() => ({
                order: vi.fn(() => ({
                  paginate: vi.fn().mockResolvedValue({
                    page: [
                      {
                        _id: "officialPluginMigrations:1",
                        bundledPluginId: "core.search",
                        packageName: "@scope/demo",
                        packageId: "packages:demo",
                        phase: "ready-for-openclaw",
                        blockers: [],
                        hostTargetsComplete: true,
                        scanClean: true,
                        moderationApproved: true,
                        runtimeBundlesReady: false,
                        createdAt: 100,
                        updatedAt: 200,
                      },
                    ],
                    continueCursor: null,
                    isDone: true,
                  }),
                })),
              })),
            };
          }),
        },
      } as never,
      { actorUserId: "users:moderator", phase: "all", limit: 10 },
    );

    expect(result).toEqual({
      items: [
        expect.objectContaining({
          bundledPluginId: "core.search",
          packageName: "@scope/demo",
          phase: "ready-for-openclaw",
        }),
      ],
      nextCursor: null,
      done: true,
    });
  });
});

describe("package scan backfill", () => {
  it("lists blocked package releases for the moderation queue", async () => {
    const result = await listPackageModerationQueueInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "users:moderator") return { _id: id, role: "moderator" };
            if (id === "packages:demo") {
              return {
                ...makePackageDoc(),
                _id: "packages:demo",
                name: "@scope/demo",
                displayName: "Demo",
                family: "code-plugin",
                channel: "community",
                isOfficial: false,
              };
            }
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table === "packageReports") {
              return {
                withIndex: vi.fn(() => ({
                  order: vi.fn(() => ({
                    take: vi.fn().mockResolvedValue([
                      {
                        _id: "packageReports:1",
                        packageId: "packages:demo",
                        releaseId: "packageReleases:latest",
                        userId: "users:reporter",
                        status: "open",
                        createdAt: 500,
                      },
                    ]),
                  })),
                })),
              };
            }
            if (table !== "packageReleases") throw new Error(`Unexpected table ${table}`);
            return {
              withIndex: vi.fn(() => ({
                order: vi.fn(() => ({
                  paginate: vi.fn().mockResolvedValue({
                    page: [
                      {
                        _id: "packageReleases:blocked",
                        packageId: "packages:demo",
                        version: "1.2.3",
                        createdAt: 123,
                        artifactKind: "npm-pack",
                        sha256hash: "a".repeat(64),
                        verification: { scanStatus: "suspicious" },
                        staticScan: {
                          status: "malicious",
                          reasonCodes: ["malware.test"],
                          findings: [],
                          summary: "malware",
                          engineVersion: "test",
                          checkedAt: 1,
                        },
                        manualModeration: {
                          state: "quarantined",
                          reason: "manual review",
                          reviewerUserId: "users:moderator",
                          updatedAt: 2,
                        },
                        source: {
                          repo: "openclaw/demo",
                          commit: "abc123",
                        },
                      },
                    ],
                    continueCursor: null,
                    isDone: true,
                  }),
                })),
              })),
            };
          }),
        },
      } as never,
      { actorUserId: "users:moderator", limit: 10, status: "blocked" },
    );

    expect(result).toEqual({
      items: [
        expect.objectContaining({
          packageId: "packages:demo",
          releaseId: "packageReleases:blocked",
          name: "@scope/demo",
          version: "1.2.3",
          artifactKind: "npm-pack",
          scanStatus: "malicious",
          moderationState: "quarantined",
          moderationReason: "manual review",
          sourceRepo: "openclaw/demo",
          sourceCommit: "abc123",
          reasons: ["manual:quarantined", "scan:malicious"],
        }),
      ],
      nextCursor: null,
      done: true,
    });
  });

  it("lists reported packages on their latest release for the moderation queue", async () => {
    const result = await listPackageModerationQueueInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "users:moderator") return { _id: id, role: "moderator" };
            if (id === "packages:demo") {
              return {
                ...makePackageDoc({
                  _id: "packages:demo",
                  name: "@scope/demo",
                  displayName: "Demo",
                  family: "code-plugin",
                  latestReleaseId: "packageReleases:latest",
                  reportCount: 2,
                  lastReportedAt: 456,
                }),
              };
            }
            if (id === "packageReleases:latest") {
              return makeReleaseDoc({
                _id: "packageReleases:latest",
                packageId: "packages:demo",
                version: "1.1.0",
                createdAt: 101,
                verification: { scanStatus: "clean" },
              });
            }
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table === "packageReports") {
              return {
                withIndex: vi.fn(() => ({
                  order: vi.fn(() => ({
                    take: vi.fn().mockResolvedValue([
                      {
                        _id: "packageReports:1",
                        packageId: "packages:demo",
                        releaseId: "packageReleases:latest",
                        userId: "users:reporter",
                        status: "open",
                        createdAt: 500,
                      },
                    ]),
                  })),
                })),
              };
            }
            if (table !== "packageReleases") throw new Error(`Unexpected table ${table}`);
            return {
              withIndex: vi.fn(() => ({
                order: vi.fn(() => ({
                  paginate: vi.fn().mockResolvedValue({
                    page: [
                      {
                        ...makeReleaseDoc({
                          _id: "packageReleases:old",
                          packageId: "packages:demo",
                          version: "1.0.0",
                          createdAt: 100,
                          verification: { scanStatus: "clean" },
                        }),
                      },
                      {
                        ...makeReleaseDoc({
                          _id: "packageReleases:latest",
                          packageId: "packages:demo",
                          version: "1.1.0",
                          createdAt: 101,
                          verification: { scanStatus: "clean" },
                        }),
                      },
                    ],
                    continueCursor: null,
                    isDone: true,
                  }),
                })),
              })),
            };
          }),
        },
      } as never,
      { actorUserId: "users:moderator", limit: 10, status: "open" },
    );

    expect(result.items).toEqual([
      expect.objectContaining({
        releaseId: "packageReleases:latest",
        version: "1.1.0",
        reportCount: 2,
        lastReportedAt: 456,
        reasons: ["reports:2"],
      }),
    ]);
  });

  it("normalizes legacy package release timestamps for the moderation queue", async () => {
    const result = await listPackageModerationQueueInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "users:moderator") return { _id: id, role: "moderator" };
            if (id === "packages:demo") {
              return {
                ...makePackageDoc(),
                _id: "packages:demo",
                name: "@scope/demo",
                displayName: "Demo",
                family: "code-plugin",
                channel: "community",
                isOfficial: false,
              };
            }
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table !== "packageReleases") throw new Error(`Unexpected table ${table}`);
            return {
              withIndex: vi.fn(() => ({
                order: vi.fn(() => ({
                  paginate: vi.fn().mockResolvedValue({
                    page: [
                      {
                        ...makeReleaseDoc({
                          _id: "packageReleases:legacy",
                          _creationTime: 321,
                          packageId: "packages:demo",
                          createdAt: undefined,
                          manualModeration: {
                            state: "quarantined",
                            reason: "manual review",
                            reviewerUserId: "users:moderator",
                            updatedAt: 2,
                          },
                        }),
                      },
                    ],
                    continueCursor: null,
                    isDone: true,
                  }),
                })),
              })),
            };
          }),
        },
      } as never,
      { actorUserId: "users:moderator", limit: 10, status: "manual" },
    );

    expect(result.items).toEqual([
      expect.objectContaining({
        releaseId: "packageReleases:legacy",
        createdAt: 321,
        moderationState: "quarantined",
      }),
    ]);
  });

  it("includes releases missing static scan in the backfill batch", async () => {
    const result = await getPackageReleaseScanBackfillBatchInternalHandler(
      {
        db: {
          query: vi.fn((table: string) => {
            if (table !== "packageReleases") throw new Error(`Unexpected table ${table}`);
            return {
              order: vi.fn(() => ({
                take: vi.fn().mockResolvedValue([]),
              })),
              withIndex: vi.fn(() => ({
                order: vi.fn(() => ({
                  take: vi.fn().mockResolvedValue([
                    {
                      _id: "packageReleases:missing-static",
                      _creationTime: 10,
                      packageId: "packages:demo",
                      sha256hash: "hash",
                      vtAnalysis: { status: "clean" },
                      llmAnalysis: { status: "clean" },
                      staticScan: undefined,
                    },
                    {
                      _id: "packageReleases:fully-scanned",
                      _creationTime: 11,
                      packageId: "packages:demo",
                      sha256hash: "hash",
                      vtAnalysis: { status: "clean" },
                      llmAnalysis: { status: "clean" },
                      staticScan: { status: "clean" },
                    },
                  ]),
                })),
              })),
            };
          }),
          get: vi.fn(async (id: string) => {
            if (id === "packages:demo") return makePackageDoc();
            return null;
          }),
        },
      } as never,
      { batchSize: 10, prioritizeRecent: false },
    );

    expect(result.releases).toEqual([
      {
        releaseId: "packageReleases:missing-static",
        packageId: "packages:demo",
        needsVt: false,
        needsLlm: false,
        needsStatic: true,
      },
    ]);
  });

  it("does not repeatedly rescan a release solely because its artifact hash is missing", async () => {
    const result = await getPackageReleaseScanBackfillBatchInternalHandler(
      {
        db: {
          query: vi.fn((table: string) => {
            if (table !== "packageReleases") throw new Error(`Unexpected table ${table}`);
            return {
              order: vi.fn(() => ({
                take: vi.fn().mockResolvedValue([]),
              })),
              withIndex: vi.fn(() => ({
                order: vi.fn(() => ({
                  take: vi.fn().mockResolvedValue([
                    {
                      _id: "packageReleases:npm-missing-artifact-hash",
                      _creationTime: 10,
                      packageId: "packages:demo",
                      artifactKind: "npm-pack",
                      sha256hash: "legacy-zip-hash",
                      vtAnalysis: { status: "clean" },
                      llmAnalysis: { status: "clean" },
                      staticScan: { status: "clean" },
                    },
                  ]),
                })),
              })),
            };
          }),
          get: vi.fn(async (id: string) => {
            if (id === "packages:demo") return makePackageDoc();
            return null;
          }),
        },
      } as never,
      { batchSize: 10, prioritizeRecent: false },
    );

    expect(result.releases).toEqual([]);
  });

  it("bounds the recent-release probe independently of the scan batch size", async () => {
    const recentTake = vi.fn().mockResolvedValue([]);
    const backlogTake = vi.fn().mockResolvedValue([]);

    const result = await getPackageReleaseScanBackfillBatchInternalHandler(
      {
        db: {
          query: vi.fn((table: string) => {
            if (table !== "packageReleases") throw new Error(`Unexpected table ${table}`);
            return {
              order: vi.fn(() => ({ take: recentTake })),
              withIndex: vi.fn(() => ({
                order: vi.fn(() => ({ take: backlogTake })),
              })),
            };
          }),
          get: vi.fn(),
        },
      } as never,
      { batchSize: 100, prioritizeRecent: true },
    );

    expect(recentTake).toHaveBeenCalledWith(4);
    expect(backlogTake).not.toHaveBeenCalled();
    expect(result).toEqual({ releases: [], nextCursor: 0, done: false });
  });

  it("bounds the historical candidate page independently of the scan batch size", async () => {
    const backlogTake = vi.fn().mockResolvedValue([]);

    const result = await getPackageReleaseScanBackfillBatchInternalHandler(
      {
        db: {
          query: vi.fn((table: string) => {
            if (table !== "packageReleases") throw new Error(`Unexpected table ${table}`);
            return {
              order: vi.fn(),
              withIndex: vi.fn(() => ({
                order: vi.fn(() => ({ take: backlogTake })),
              })),
            };
          }),
          get: vi.fn(),
        },
      } as never,
      { batchSize: 100, prioritizeRecent: false },
    );

    expect(backlogTake).toHaveBeenCalledWith(8);
    expect(result).toEqual({ releases: [], nextCursor: 0, done: true });
  });

  it("runs the recent-release probe before draining older backlog", async () => {
    const result = await getPackageReleaseScanBackfillBatchInternalHandler(
      {
        db: {
          query: vi.fn((table: string) => {
            if (table !== "packageReleases") throw new Error(`Unexpected table ${table}`);
            return {
              order: vi.fn(() => ({
                take: vi.fn().mockResolvedValue([
                  {
                    _id: "packageReleases:recent-vt",
                    _creationTime: 200,
                    packageId: "packages:demo",
                    sha256hash: "hash",
                    vtAnalysis: undefined,
                    llmAnalysis: { status: "clean" },
                    staticScan: { status: "clean" },
                  },
                ]),
              })),
              withIndex: vi.fn(() => ({
                order: vi.fn(() => ({
                  take: vi.fn().mockResolvedValue([
                    {
                      _id: "packageReleases:old-static",
                      _creationTime: 10,
                      packageId: "packages:demo",
                      sha256hash: "hash",
                      vtAnalysis: { status: "clean" },
                      llmAnalysis: { status: "clean" },
                      staticScan: undefined,
                    },
                  ]),
                })),
              })),
            };
          }),
          get: vi.fn(async (id: string) => {
            if (id === "packages:demo") return makePackageDoc();
            return null;
          }),
        },
      } as never,
      { batchSize: 2, prioritizeRecent: true },
    );

    expect(result).toEqual({
      releases: [
        {
          releaseId: "packageReleases:recent-vt",
          packageId: "packages:demo",
          needsVt: true,
          needsLlm: false,
          needsStatic: false,
        },
      ],
      nextCursor: 0,
      done: false,
    });
  });

  it("starts the cursor backlog after the bounded recent probe", async () => {
    const runAfter = vi.fn().mockResolvedValue(undefined);

    const result = await backfillPackageReleaseScansInternalHandler(
      {
        runQuery: vi.fn().mockResolvedValue({
          releases: [],
          nextCursor: 0,
          done: false,
        }),
        scheduler: { runAfter },
      } as never,
      { batchSize: 100 },
    );

    expect(result).toEqual({ scheduled: 0, nextCursor: 0, done: false });
    expect(runAfter).toHaveBeenCalledTimes(1);
    expect(runAfter).toHaveBeenCalledWith(0, expect.anything(), {
      cursor: 0,
      batchSize: 100,
      scheduled: 0,
    });
  });

  it("schedules static rescans for releases missing only static scan data", async () => {
    const originalVtApiKey = process.env.VT_API_KEY;
    process.env.VT_API_KEY = "vt-test-key";

    try {
      const runAfter = vi.fn().mockResolvedValue(undefined);
      const result = await backfillPackageReleaseScansInternalHandler(
        {
          runQuery: vi.fn().mockResolvedValue({
            releases: [
              {
                releaseId: "packageReleases:static-only",
                needsVt: false,
                needsLlm: false,
                needsStatic: true,
              },
            ],
            nextCursor: 123,
            done: true,
          }),
          scheduler: { runAfter },
        } as never,
        { batchSize: 10 },
      );

      expect(result).toEqual({ scheduled: 1, nextCursor: 123, done: true });
      expect(runAfter).toHaveBeenCalledTimes(1);
      expect(runAfter).toHaveBeenCalledWith(
        0,
        expect.anything(),
        expect.objectContaining({ releaseId: "packageReleases:static-only" }),
      );
    } finally {
      if (originalVtApiKey === undefined) {
        delete process.env.VT_API_KEY;
      } else {
        process.env.VT_API_KEY = originalVtApiKey;
      }
    }
  });

  it("backfills legacy static-only package scan status into the package search digest", async () => {
    const verification = {
      tier: "source-linked",
      scope: "artifact-only",
      scanStatus: "malicious",
    };
    const pkg = makePackageDoc({
      scanStatus: "malicious",
      verification,
      latestVersionSummary: {
        version: "1.0.0",
        verification,
      },
    });
    const release = makeReleaseDoc({
      sha256hash: "a".repeat(64),
      verification,
      staticScan: {
        status: "malicious",
        reasonCodes: ["malicious.static_fixture"],
        findings: [],
        summary: "Static fixture only.",
        engineVersion: "test",
        checkedAt: 1,
      },
      llmAnalysis: {
        status: "clean",
        verdict: "clean",
        checkedAt: 2,
      },
    });
    const patch = vi.fn();

    const result = await backfillLatestPackageScanStatusInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "packageReleases:demo-1") return release;
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table === "packages") {
              return {
                paginate: vi.fn().mockResolvedValue({
                  page: [pkg],
                  continueCursor: null,
                  isDone: true,
                }),
              };
            }
            if (table === "packageSearchDigest") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue({
                    _id: "packageSearchDigest:demo",
                    packageId: "packages:demo",
                    scanStatus: "malicious",
                  }),
                })),
              };
            }
            if (
              table === "packageCapabilitySearchDigest" ||
              table === "packageTopicSearchDigest" ||
              table === "packagePluginCategorySearchDigest"
            ) {
              return {
                withIndex: vi.fn(() => ({
                  collect: vi.fn().mockResolvedValue([]),
                })),
              };
            }
            throw new Error(`Unexpected table ${table}`);
          }),
          patch,
          insert: vi.fn(),
          replace: vi.fn(),
          delete: vi.fn(),
          normalizeId: vi.fn(),
        },
        scheduler: { runAfter: vi.fn() },
      } as never,
      { batchSize: 10 },
    );

    expect(result).toEqual({ patched: 1, isDone: true, scanned: 1 });
    expect(patch).toHaveBeenCalledWith(
      "packageReleases:demo-1",
      expect.objectContaining({
        verification: expect.objectContaining({ scanStatus: "clean" }),
      }),
    );
    expect(patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        scanStatus: "clean",
        verification: expect.objectContaining({ scanStatus: "clean" }),
        latestVersionSummary: expect.objectContaining({
          verification: expect.objectContaining({ scanStatus: "clean" }),
        }),
      }),
    );
    expect(patch).toHaveBeenCalledWith(
      "packageSearchDigest:demo",
      expect.objectContaining({ scanStatus: "clean" }),
    );
  });

  it("repairs stale package search digests even when package scan status is already current", async () => {
    const verification = {
      tier: "source-linked",
      scope: "artifact-only",
      scanStatus: "clean",
    };
    const pkg = makePackageDoc({
      ownerPublisherId: "publishers:owner",
      scanStatus: "clean",
      verification,
      latestVersionSummary: {
        version: "1.0.0",
        verification,
      },
    });
    const release = makeReleaseDoc({
      verification,
      llmAnalysis: {
        status: "clean",
        verdict: "clean",
        checkedAt: 2,
      },
    });
    const patch = vi.fn();

    const result = await backfillLatestPackageScanStatusInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "packageReleases:demo-1") return release;
            if (id === "publishers:owner") {
              return {
                _id: "publishers:owner",
                kind: "user",
                handle: "tongfei11",
                linkedUserId: "users:owner",
              };
            }
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table === "packages") {
              return {
                paginate: vi.fn().mockResolvedValue({
                  page: [pkg],
                  continueCursor: null,
                  isDone: true,
                }),
              };
            }
            if (table === "packageSearchDigest") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue({
                    _id: "packageSearchDigest:demo",
                    packageId: "packages:demo",
                    scanStatus: "malicious",
                  }),
                })),
              };
            }
            if (
              table === "packagePluginCategorySearchDigest" ||
              table === "packageTopicSearchDigest"
            ) {
              return {
                withIndex: vi.fn(() => ({
                  collect: vi.fn().mockResolvedValue([]),
                })),
              };
            }
            throw new Error(`Unexpected table ${table}`);
          }),
          patch,
          insert: vi.fn(),
          replace: vi.fn(),
          delete: vi.fn(),
          normalizeId: vi.fn(),
        },
        scheduler: { runAfter: vi.fn() },
      } as never,
      { batchSize: 10 },
    );

    expect(result).toEqual({ patched: 0, isDone: true, scanned: 1 });
    expect(patch).not.toHaveBeenCalledWith("packages:demo", expect.anything());
    expect(patch).toHaveBeenCalledWith(
      "packageSearchDigest:demo",
      expect.objectContaining({
        scanStatus: "clean",
        ownerHandle: "tongfei11",
        ownerKind: "user",
      }),
    );
  });

  it("stores static package scan results without promoting malware status", async () => {
    const patch = vi.fn().mockResolvedValue(undefined);
    const release = {
      _id: "packageReleases:demo-1",
      packageId: "packages:demo",
      verification: {
        tier: "source-linked",
        scope: "artifact-only",
        scanStatus: "pending",
      },
      softDeletedAt: undefined,
    };
    const pkg = {
      ...makePackageDoc(),
      _id: "packages:demo",
      latestReleaseId: "packageReleases:demo-1",
      verification: {
        tier: "source-linked",
        scope: "artifact-only",
        scanStatus: "pending",
      },
      latestVersionSummary: {
        version: "1.0.0",
        verification: {
          tier: "source-linked",
          scope: "artifact-only",
          scanStatus: "pending",
        },
      },
    };

    await updateReleaseStaticScanInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "packageReleases:demo-1") return release;
            if (id === "packages:demo") return pkg;
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table === "packageSearchDigest") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue({
                    _id: "packageSearchDigest:demo",
                    packageId: "packages:demo",
                    scanStatus: "pending",
                  }),
                })),
              };
            }
            if (
              table === "packageCapabilitySearchDigest" ||
              table === "packageTopicSearchDigest" ||
              table === "packagePluginCategorySearchDigest"
            ) {
              return {
                withIndex: vi.fn(() => ({
                  collect: vi.fn().mockResolvedValue([]),
                })),
              };
            }
            throw new Error(`Unexpected query table: ${table}`);
          }),
          insert: vi.fn(),
          patch,
          replace: vi.fn(),
          delete: vi.fn(),
          normalizeId: vi.fn(),
        },
      } as never,
      {
        releaseId: "packageReleases:demo-1",
        staticScan: {
          status: "malicious",
          reasonCodes: ["malware.test"],
          findings: [],
          summary: "Malware detected",
          engineVersion: "test",
          checkedAt: 1,
        },
      },
    );

    expect(patch).toHaveBeenNthCalledWith(
      1,
      "packageReleases:demo-1",
      expect.objectContaining({
        staticScan: expect.objectContaining({ status: "malicious" }),
        verification: expect.objectContaining({ scanStatus: "pending" }),
      }),
    );
    expect(patch).toHaveBeenNthCalledWith(
      2,
      "packages:demo",
      expect.objectContaining({
        scanStatus: "pending",
        verification: expect.objectContaining({ scanStatus: "pending" }),
        latestVersionSummary: expect.objectContaining({
          verification: expect.objectContaining({ scanStatus: "pending" }),
        }),
      }),
    );
    expect(patch).toHaveBeenCalledWith(
      "packageSearchDigest:demo",
      expect.objectContaining({ scanStatus: "pending" }),
    );
  });

  it("quarantines a malicious latest plugin release and restores the previous clean latest", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const patch = vi.fn().mockResolvedValue(undefined);
    const runAfter = vi.fn().mockResolvedValue(undefined);
    const previousRelease = makeReleaseDoc({
      _id: "packageReleases:demo-1",
      packageId: "packages:demo",
      version: "1.0.0",
      runtimeId: "demo.plugin",
      distTags: [],
      verification: { scanStatus: "clean" },
      createdAt: 1_600_000_000_000,
    });
    const candidateRelease = makeReleaseDoc({
      _id: "packageReleases:demo-2",
      packageId: "packages:demo",
      version: "2.0.0",
      runtimeId: "demo.plugin",
      sourceRepo: "openclaw/demo-malicious",
      distTags: ["latest"],
      verification: { scanStatus: "pending" },
      createdBy: "users:member",
      publishActor: { kind: "user", userId: "users:member" },
      staticScan: {
        status: "clean",
        reasonCodes: [],
        findings: [],
        summary: "No static findings.",
        engineVersion: "test",
        checkedAt: 1,
      },
      createdAt: 1_700_000_000_000,
    });
    const pkg = makePackageDoc({
      _id: "packages:demo",
      ownerUserId: "users:owner",
      ownerPublisherId: "publishers:org",
      runtimeId: "demo.plugin",
      sourceRepo: "openclaw/demo-malicious",
      latestReleaseId: "packageReleases:demo-2",
      tags: { latest: "packageReleases:demo-2" },
      latestVersionSummary: { version: "2.0.0", verification: { scanStatus: "pending" } },
      verification: { scanStatus: "pending" },
      scanStatus: "pending",
    });

    await updateReleaseLlmAnalysisInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "packageReleases:demo-2") return candidateRelease;
            if (id === "packages:demo") return pkg;
            if (id === "publishers:org") {
              return {
                _id: "publishers:org",
                kind: "org",
                handle: "org",
                deletedAt: undefined,
                deactivatedAt: undefined,
              };
            }
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table === "packageReleases") {
              return {
                withIndex: vi.fn(() => ({
                  collect: vi.fn().mockResolvedValue([previousRelease, candidateRelease]),
                })),
              };
            }
            if (table === "packageSearchDigest") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue({
                    _id: "packageSearchDigest:demo",
                    packageId: "packages:demo",
                    scanStatus: "pending",
                  }),
                })),
              };
            }
            if (
              table === "packageCapabilitySearchDigest" ||
              table === "packageTopicSearchDigest" ||
              table === "packagePluginCategorySearchDigest"
            ) {
              return {
                withIndex: vi.fn(() => ({
                  collect: vi.fn().mockResolvedValue([]),
                })),
              };
            }
            throw new Error(`Unexpected query table: ${table}`);
          }),
          insert: vi.fn(),
          patch,
          replace: vi.fn(),
          delete: vi.fn(),
          normalizeId: vi.fn(),
        },
        scheduler: { runAfter },
      } as never,
      {
        releaseId: "packageReleases:demo-2",
        llmAnalysis: {
          status: "malicious",
          verdict: "malicious",
          confidence: "high",
          summary: "ClawScan found malicious behavior.",
          guidance: "Fix locally and rescan.",
          checkedAt: 1_700_000_000_000,
        },
      },
    );

    expect(patch).toHaveBeenCalledWith(
      "packageReleases:demo-2",
      expect.objectContaining({
        softDeletedAt: 1_700_000_000_000,
        verification: expect.objectContaining({ scanStatus: "malicious" }),
      }),
    );
    expect(patch).toHaveBeenCalledWith(
      "packageReleases:demo-1",
      expect.objectContaining({ distTags: ["latest"] }),
    );
    expect(patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        latestReleaseId: "packageReleases:demo-1",
        runtimeId: "demo.plugin",
        sourceRepo: undefined,
        scanStatus: "clean",
        tags: { latest: "packageReleases:demo-1" },
      }),
    );
    expect(runAfter).toHaveBeenCalledWith(
      0,
      expect.anything(),
      expect.objectContaining({
        ownerUserId: "users:member",
        artifactKind: "plugin",
        artifactName: "demo-plugin",
        version: "2.0.0",
        findingSummary: "ClawScan found malicious behavior.",
      }),
    );
  });

  it("quarantines a malicious non-latest plugin release without changing the clean latest", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const patch = vi.fn().mockResolvedValue(undefined);
    const runAfter = vi.fn().mockResolvedValue(undefined);
    const candidateRelease = makeReleaseDoc({
      _id: "packageReleases:demo-beta",
      packageId: "packages:demo",
      version: "1.5.0",
      distTags: ["beta"],
      verification: { scanStatus: "pending" },
      createdBy: "users:member",
      publishActor: { kind: "user", userId: "users:member" },
      staticScan: {
        status: "clean",
        reasonCodes: [],
        findings: [],
        summary: "No static findings.",
        engineVersion: "test",
        checkedAt: 1,
      },
      createdAt: 1_650_000_000_000,
    });
    const pkg = makePackageDoc({
      _id: "packages:demo",
      ownerUserId: "users:owner",
      ownerPublisherId: "publishers:org",
      latestReleaseId: "packageReleases:demo-latest",
      tags: {
        latest: "packageReleases:demo-latest",
        beta: "packageReleases:demo-beta",
      },
      latestVersionSummary: { version: "2.0.0", verification: { scanStatus: "clean" } },
      verification: { scanStatus: "clean" },
      scanStatus: "clean",
    });

    await updateReleaseLlmAnalysisInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "packageReleases:demo-beta") return candidateRelease;
            if (id === "packages:demo") return pkg;
            if (id === "publishers:org") {
              return {
                _id: "publishers:org",
                kind: "org",
                handle: "org",
                deletedAt: undefined,
                deactivatedAt: undefined,
              };
            }
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table === "packageSearchDigest") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue({
                    _id: "packageSearchDigest:demo",
                    packageId: "packages:demo",
                    scanStatus: "clean",
                  }),
                })),
              };
            }
            if (
              table === "packageCapabilitySearchDigest" ||
              table === "packageTopicSearchDigest" ||
              table === "packagePluginCategorySearchDigest"
            ) {
              return {
                withIndex: vi.fn(() => ({
                  collect: vi.fn().mockResolvedValue([]),
                })),
              };
            }
            throw new Error(`Unexpected query table: ${table}`);
          }),
          insert: vi.fn(),
          patch,
          replace: vi.fn(),
          delete: vi.fn(),
          normalizeId: vi.fn(),
        },
        scheduler: { runAfter },
      } as never,
      {
        releaseId: "packageReleases:demo-beta",
        llmAnalysis: {
          status: "malicious",
          verdict: "malicious",
          confidence: "high",
          summary: "ClawScan found malicious behavior.",
          guidance: "Fix locally and rescan.",
          checkedAt: 1_700_000_000_000,
        },
      },
    );

    expect(patch).toHaveBeenCalledWith(
      "packageReleases:demo-beta",
      expect.objectContaining({
        llmAnalysis: expect.objectContaining({ verdict: "malicious" }),
      }),
    );
    expect(patch).toHaveBeenCalledWith(
      "packageReleases:demo-beta",
      expect.objectContaining({
        softDeletedAt: 1_700_000_000_000,
        verification: expect.objectContaining({ scanStatus: "malicious" }),
      }),
    );
    expect(patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        tags: { latest: "packageReleases:demo-latest" },
      }),
    );
    expect(patch).not.toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({ latestReleaseId: "packageReleases:demo-beta" }),
    );
    expect(runAfter).toHaveBeenCalledWith(
      0,
      expect.anything(),
      expect.objectContaining({
        ownerUserId: "users:member",
        artifactKind: "plugin",
        artifactName: "demo-plugin",
        version: "1.5.0",
        findingSummary: "ClawScan found malicious behavior.",
      }),
    );
  });

  it("keeps a first malicious plugin release out of public package lists", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const patch = vi.fn().mockResolvedValue(undefined);
    const candidateRelease = makeReleaseDoc({
      _id: "packageReleases:demo-1",
      packageId: "packages:demo",
      version: "1.0.0",
      distTags: ["latest"],
      verification: { scanStatus: "pending" },
      createdAt: 1_700_000_000_000,
    });
    const pkg = makePackageDoc({
      _id: "packages:demo",
      latestReleaseId: "packageReleases:demo-1",
      tags: { latest: "packageReleases:demo-1" },
      latestVersionSummary: { version: "1.0.0", verification: { scanStatus: "pending" } },
      verification: { scanStatus: "pending" },
      scanStatus: "pending",
    });

    await updateReleaseLlmAnalysisInternalHandler(
      {
        db: {
          get: vi.fn(async (id: string) => {
            if (id === "packageReleases:demo-1") return candidateRelease;
            if (id === "packages:demo") return pkg;
            return null;
          }),
          query: vi.fn((table: string) => {
            if (table === "packageReleases") {
              return {
                withIndex: vi.fn(() => ({
                  collect: vi.fn().mockResolvedValue([candidateRelease]),
                })),
              };
            }
            if (table === "packageSearchDigest") {
              return {
                withIndex: vi.fn(() => ({
                  unique: vi.fn().mockResolvedValue({
                    _id: "packageSearchDigest:demo",
                    packageId: "packages:demo",
                    scanStatus: "pending",
                  }),
                })),
              };
            }
            if (
              table === "packageCapabilitySearchDigest" ||
              table === "packageTopicSearchDigest" ||
              table === "packagePluginCategorySearchDigest"
            ) {
              return {
                withIndex: vi.fn(() => ({
                  collect: vi.fn().mockResolvedValue([]),
                })),
              };
            }
            throw new Error(`Unexpected query table: ${table}`);
          }),
          insert: vi.fn(),
          patch,
          replace: vi.fn(),
          delete: vi.fn(),
          normalizeId: vi.fn(),
        },
      } as never,
      {
        releaseId: "packageReleases:demo-1",
        llmAnalysis: {
          status: "malicious",
          verdict: "malicious",
          confidence: "high",
          summary: "ClawScan found malicious behavior.",
          guidance: "Fix locally and rescan.",
          checkedAt: 1_700_000_000_000,
        },
      },
    );

    expect(patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        latestReleaseId: undefined,
        latestVersionSummary: undefined,
        scanStatus: "malicious",
        tags: {},
      }),
    );
    expect(patch).toHaveBeenCalledWith(
      "packageSearchDigest:demo",
      expect.objectContaining({
        latestVersion: undefined,
        scanStatus: "malicious",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// softDeletePackageInternal / restorePackageInternal
// ---------------------------------------------------------------------------

/**
 * Build a ctx that exercises the full softDeletePackageDoc / restorePackageDoc
 * path, including the upsertPackageSearchDigest branch that previously crashed
 * when ownerHandle was missing.
 */
function makeSoftDeleteCtx(options?: {
  pkg?: Record<string, unknown>;
  actor?: Record<string, unknown>;
  /** When true, no retired digest rows exist. */
  noCapabilityDigest?: boolean;
  /** Personal publisher linked to the owner user. */
  personalPublisher?: Record<string, unknown> | null;
  /** Override the releases returned for this package. */
  releases?: Array<Record<string, unknown>>;
}) {
  const pkg =
    options?.pkg ??
    makePackageDoc({
      ownerUserId: "users:owner",
      ownerPublisherId: "publishers:owner-personal",
    });

  const personalPublisher =
    options?.personalPublisher === undefined
      ? {
          _id: "publishers:owner-personal",
          kind: "user",
          handle: "tongfei11",
          linkedUserId: "users:owner",
        }
      : options.personalPublisher;

  const existingCapabilityRows =
    options?.noCapabilityDigest === true
      ? []
      : [
          {
            _id: "packageCapabilitySearchDigest:demo-read-files",
            packageId: pkg._id,
            capabilityTag: "read-files",
            ownerHandle: "tongfei11",
          },
        ];

  const releases = options?.releases ?? [
    makeReleaseDoc({ _id: "packageReleases:demo-1", softDeletedAt: undefined }),
  ];

  const patch = vi.fn();
  const insert = vi.fn().mockResolvedValue("auditLogs:1");

  return {
    patch,
    insert,
    ctx: {
      db: {
        get: vi.fn(async (id: string) => {
          if (id === "users:owner") return options?.actor ?? { _id: id, role: "user" };
          if (id === "publishers:owner-personal") return personalPublisher;
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table === "packages") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(pkg),
              })),
            };
          }
          if (table === "packageReleases") {
            return {
              withIndex: vi.fn(() => ({
                collect: vi.fn().mockResolvedValue(releases),
              })),
            };
          }
          if (table === "packageSearchDigest") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi
                  .fn()
                  .mockResolvedValue({ _id: "packageSearchDigest:demo", packageId: pkg._id }),
              })),
            };
          }
          if (table === "packageCapabilitySearchDigest") {
            return {
              withIndex: vi.fn(() => ({
                collect: vi.fn().mockResolvedValue(existingCapabilityRows),
              })),
            };
          }
          if (
            table === "packageTopicSearchDigest" ||
            table === "packagePluginCategorySearchDigest"
          ) {
            return {
              withIndex: vi.fn(() => ({
                collect: vi.fn().mockResolvedValue([]),
              })),
            };
          }
          if (table === "publisherMemberships") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue(null),
              })),
            };
          }
          throw new Error(`Unexpected table: ${table}`);
        }),
        insert,
        patch,
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn(),
      },
    },
  };
}

function makeOwnedPackageBatchCtx(options?: {
  pkg?: Record<string, unknown>;
  owner?: Record<string, unknown> | null;
  packageTokens?: Array<Record<string, unknown>>;
  releases?: Array<Record<string, unknown>>;
  publisherPackages?: Array<Record<string, unknown>>;
  publishers?: Record<string, Record<string, unknown> | null>;
  isDone?: boolean;
  continueCursor?: string;
}) {
  const pkg = options?.pkg ?? makePackageDoc({ ownerUserId: "users:owner" });
  const releases = options?.releases ?? [
    makeReleaseDoc({ _id: "packageReleases:demo-1", packageId: pkg._id }),
  ];
  const packageTokens = options?.packageTokens ?? [
    {
      _id: "packagePublishTokens:demo",
      packageId: pkg._id,
      version: "1.0.1",
      revokedAt: undefined,
    },
  ];
  const patch = vi.fn();
  const insert = vi.fn().mockResolvedValue("auditLogs:1");
  const runAfter = vi.fn();

  return {
    patch,
    insert,
    runAfter,
    ctx: {
      scheduler: { runAfter },
      db: {
        get: vi.fn(async (id: string) => {
          if (id === "users:admin") {
            return {
              _id: "users:admin",
              role: "admin",
              deletedAt: undefined,
              deactivatedAt: undefined,
            };
          }
          if (id === "users:owner") {
            return options?.owner === undefined
              ? { _id: "users:owner", deletedAt: undefined, deactivatedAt: undefined }
              : options.owner;
          }
          if (options?.publishers && id in options.publishers) {
            return options.publishers[id];
          }
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table === "packages") {
            return {
              withIndex: vi.fn((index: string) => ({
                order: vi.fn(() => ({
                  paginate: vi.fn().mockResolvedValue({
                    page:
                      index === "by_owner_publisher" ? (options?.publisherPackages ?? []) : [pkg],
                    isDone: options?.isDone ?? true,
                    continueCursor: options?.continueCursor ?? "",
                  }),
                })),
              })),
            };
          }
          if (table === "publishers") {
            return {
              withIndex: vi.fn(
                (
                  index: string,
                  cb: (q: { eq: (field: string, value: string) => unknown }) => unknown,
                ) => {
                  expect(index).toBe("by_linked_user");
                  let linkedUserId = "";
                  cb({
                    eq: (field: string, value: string) => {
                      if (field === "linkedUserId") linkedUserId = value;
                      return {};
                    },
                  });
                  return {
                    unique: vi.fn(
                      async () =>
                        Object.values(options?.publishers ?? {}).find(
                          (publisher) =>
                            publisher?.kind === "user" && publisher.linkedUserId === linkedUserId,
                        ) ?? null,
                    ),
                  };
                },
              ),
            };
          }
          if (table === "packagePublishTokens") {
            return {
              withIndex: vi.fn(
                (
                  _index: string,
                  builder?: (q: {
                    eq: (field: string, value: string | undefined) => unknown;
                    lte: (field: string, value: number) => unknown;
                  }) => unknown,
                ) => {
                  let maxCreatedAt = Number.POSITIVE_INFINITY;
                  const queryBuilder = {
                    eq: () => queryBuilder,
                    lte: (field: string, value: number) => {
                      if (field === "createdAt") maxCreatedAt = value;
                      return queryBuilder;
                    },
                  };
                  builder?.(queryBuilder);
                  return {
                    order: vi.fn(() => ({
                      take: vi.fn(async (limit: number) =>
                        packageTokens
                          .filter(
                            (token) =>
                              typeof token.createdAt !== "number" ||
                              token.createdAt <= maxCreatedAt,
                          )
                          .slice(0, limit),
                      ),
                    })),
                  };
                },
              ),
            };
          }
          if (table === "packageReleases") {
            return {
              withIndex: vi.fn(() => ({
                collect: vi.fn().mockResolvedValue(releases),
              })),
            };
          }
          if (table === "packageSearchDigest") {
            return {
              withIndex: vi.fn(() => ({
                unique: vi
                  .fn()
                  .mockResolvedValue({ _id: "packageSearchDigest:demo", packageId: pkg._id }),
              })),
            };
          }
          if (table === "packageCapabilitySearchDigest") {
            return {
              withIndex: vi.fn(() => ({
                collect: vi.fn().mockResolvedValue([]),
              })),
            };
          }
          if (
            table === "packageTopicSearchDigest" ||
            table === "packagePluginCategorySearchDigest"
          ) {
            return {
              withIndex: vi.fn(() => ({
                collect: vi.fn().mockResolvedValue([]),
              })),
            };
          }
          throw new Error(`Unexpected table: ${table}`);
        }),
        insert,
        patch,
        replace: vi.fn(),
        delete: vi.fn(),
        normalizeId: vi.fn(),
      },
    },
  };
}

describe("owned package sanction batches", () => {
  it("soft-deletes owned packages with a ban reason and revokes package publish tokens", async () => {
    const { ctx, patch } = makeOwnedPackageBatchCtx({
      owner: { _id: "users:owner", deletedAt: 1_000, deactivatedAt: undefined },
    });

    const result = await applyBanToOwnedPackagesBatchInternalHandler(ctx as never, {
      ownerUserId: "users:owner",
      bannedAt: 1_000,
      deletedBy: "users:moderator",
      deletedByRole: "moderator",
    });

    expect(result).toMatchObject({ deletedCount: 1, revokedTokenCount: 1, scheduled: false });
    expect(patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        softDeletedAt: 1_000,
        softDeletedReason: "user.banned",
        softDeletedBy: "users:moderator",
        softDeletedByRole: "moderator",
      }),
    );
    expect(patch).toHaveBeenCalledWith("packagePublishTokens:demo", { revokedAt: 1_000 });
  });

  it("bounds package publish token revocation during owned package bans", async () => {
    const packageTokens = Array.from({ length: 26 }, (_, index) => ({
      _id: `packagePublishTokens:active-${index}`,
      packageId: "packages:demo",
      version: "1.0.1",
      revokedAt: undefined,
    }));
    const { ctx, patch, runAfter } = makeOwnedPackageBatchCtx({
      owner: { _id: "users:owner", deletedAt: 1_000, deactivatedAt: undefined },
      packageTokens,
    });

    const result = await applyBanToOwnedPackagesBatchInternalHandler(ctx as never, {
      ownerUserId: "users:owner",
      bannedAt: 1_000,
      deletedBy: "users:moderator",
      deletedByRole: "moderator",
    });

    expect(result).toMatchObject({ deletedCount: 1, revokedTokenCount: 25, scheduled: false });
    expect(patch).toHaveBeenCalledWith("packagePublishTokens:active-24", { revokedAt: 1_000 });
    expect(patch).not.toHaveBeenCalledWith("packagePublishTokens:active-25", expect.anything());
    expect(runAfter).toHaveBeenCalledWith(0, expect.anything(), {
      packageId: "packages:demo",
      revokedAt: 1_000,
    });
  });

  it("does not let stale token revocation batches revoke tokens minted after the ban marker", async () => {
    const { ctx, patch } = makeOwnedPackageBatchCtx({
      packageTokens: [
        {
          _id: "packagePublishTokens:before-ban",
          packageId: "packages:demo",
          version: "1.0.1",
          revokedAt: undefined,
          createdAt: 999,
        },
        {
          _id: "packagePublishTokens:after-unban",
          packageId: "packages:demo",
          version: "1.0.2",
          revokedAt: undefined,
          createdAt: 1_001,
        },
      ],
    });

    const result = await revokePackagePublishTokensForPackageBatchInternalHandler(ctx as never, {
      packageId: "packages:demo",
      revokedAt: 1_000,
    });

    expect(result).toMatchObject({ revokedCount: 1, scheduled: false });
    expect(patch).toHaveBeenCalledWith("packagePublishTokens:before-ban", { revokedAt: 1_000 });
    expect(patch).not.toHaveBeenCalledWith("packagePublishTokens:after-unban", expect.anything());
  });

  it("soft-deletes packages owned through the user's personal publisher", async () => {
    const personalPublisherPackage = makePackageDoc({
      _id: "packages:personal-publisher",
      ownerUserId: "users:publishing-actor",
      ownerPublisherId: "publishers:personal",
    });
    const { ctx, patch } = makeOwnedPackageBatchCtx({
      owner: {
        _id: "users:owner",
        deletedAt: 1_000,
        deactivatedAt: undefined,
        personalPublisherId: "publishers:personal",
      },
      publisherPackages: [personalPublisherPackage],
      packageTokens: [
        {
          _id: "packagePublishTokens:personal-publisher",
          packageId: "packages:personal-publisher",
          version: "1.0.1",
          revokedAt: undefined,
        },
      ],
      publishers: {
        "publishers:personal": {
          _id: "publishers:personal",
          kind: "user",
          linkedUserId: "users:owner",
        },
      },
    });

    const result = await applyBanToOwnedPackagesBatchInternalHandler(ctx as never, {
      ownerUserId: "users:owner",
      bannedAt: 1_000,
      deletedBy: "users:moderator",
      deletedByRole: "moderator",
      scope: "personalPublisher",
    });

    expect(result).toMatchObject({ deletedCount: 1, revokedTokenCount: 1, scheduled: false });
    expect(patch).toHaveBeenCalledWith(
      "packages:personal-publisher",
      expect.objectContaining({ softDeletedAt: 1_000, softDeletedReason: "user.banned" }),
    );
    expect(patch).toHaveBeenCalledWith("packagePublishTokens:personal-publisher", {
      revokedAt: 1_000,
    });
  });

  it("schedules hard deletes for packages owned by a deleted publisher", async () => {
    const orgPackage = makePackageDoc({
      _id: "packages:org-plugin",
      ownerUserId: "users:owner",
      ownerPublisherId: "publishers:org",
    });
    const { ctx, patch, runAfter } = makeOwnedPackageBatchCtx({
      publisherPackages: [orgPackage],
      releases: [
        makeReleaseDoc({
          _id: "packageReleases:org-plugin-1",
          packageId: "packages:org-plugin",
        }),
      ],
      packageTokens: [
        {
          _id: "packagePublishTokens:org-plugin",
          packageId: "packages:org-plugin",
          version: "1.0.0",
          revokedAt: undefined,
        },
      ],
      publishers: {
        "publishers:org": {
          _id: "publishers:org",
          kind: "org",
          deletedAt: 3_000,
        },
      },
    });

    const result = await applyPublisherDeletionToOwnedPackagesBatchInternalHandler(ctx as never, {
      ownerPublisherId: "publishers:org",
      actorUserId: "users:owner",
      deletedAt: 3_000,
    });

    expect(result).toMatchObject({ deletedCount: 1, revokedTokenCount: 0, scheduled: false });
    expect(patch).toHaveBeenCalledWith(
      "packages:org-plugin",
      expect.objectContaining({
        softDeletedAt: 3_000,
        softDeletedReason: "publisher.deleted",
        softDeletedBy: "users:owner",
        softDeletedByRole: "user",
      }),
    );
    expect(runAfter).toHaveBeenCalledWith(0, expect.anything(), {
      packageId: "packages:org-plugin",
      actorUserId: "users:owner",
      deletedAt: 3_000,
      source: "publisher.delete",
    });
    expect(patch).not.toHaveBeenCalledWith("packagePublishTokens:org-plugin", expect.anything());
  });

  it("schedules linked legacy personal publisher scans when the user row lacks the publisher id", async () => {
    const { ctx, runAfter } = makeOwnedPackageBatchCtx({
      owner: {
        _id: "users:owner",
        deletedAt: 1_000,
        deactivatedAt: undefined,
      },
      publishers: {
        "publishers:personal": {
          _id: "publishers:personal",
          kind: "user",
          linkedUserId: "users:owner",
        },
      },
    });

    const result = await applyBanToOwnedPackagesBatchInternalHandler(ctx as never, {
      ownerUserId: "users:owner",
      bannedAt: 1_000,
      deletedBy: "users:moderator",
      deletedByRole: "moderator",
    });

    expect(result).toMatchObject({ scheduled: true });
    expect(runAfter).toHaveBeenCalledWith(
      0,
      expect.anything(),
      expect.objectContaining({
        scope: "personalPublisher",
        cursor: undefined,
      }),
    );
  });

  it("soft-deletes linked legacy personal publisher packages without users.personalPublisherId", async () => {
    const personalPublisherPackage = makePackageDoc({
      _id: "packages:personal-publisher",
      ownerUserId: "users:publishing-actor",
      ownerPublisherId: "publishers:personal",
    });
    const { ctx, patch } = makeOwnedPackageBatchCtx({
      owner: {
        _id: "users:owner",
        deletedAt: 1_000,
        deactivatedAt: undefined,
      },
      publisherPackages: [personalPublisherPackage],
      packageTokens: [
        {
          _id: "packagePublishTokens:personal-publisher",
          packageId: "packages:personal-publisher",
          version: "1.0.1",
          revokedAt: undefined,
        },
      ],
      publishers: {
        "publishers:personal": {
          _id: "publishers:personal",
          kind: "user",
          linkedUserId: "users:owner",
        },
      },
    });

    const result = await applyBanToOwnedPackagesBatchInternalHandler(ctx as never, {
      ownerUserId: "users:owner",
      bannedAt: 1_000,
      deletedBy: "users:moderator",
      deletedByRole: "moderator",
      scope: "personalPublisher",
    });

    expect(result).toMatchObject({ deletedCount: 1, revokedTokenCount: 1, scheduled: false });
    expect(patch).toHaveBeenCalledWith(
      "packages:personal-publisher",
      expect.objectContaining({ softDeletedAt: 1_000, softDeletedReason: "user.banned" }),
    );
    expect(patch).toHaveBeenCalledWith("packagePublishTokens:personal-publisher", {
      revokedAt: 1_000,
    });
  });

  it("processes the initial package ban batch before the user ban is visible", async () => {
    const { ctx, patch } = makeOwnedPackageBatchCtx({
      owner: { _id: "users:owner", deletedAt: undefined, deactivatedAt: undefined },
    });

    const result = await applyBanToOwnedPackagesBatchInternalHandler(ctx as never, {
      ownerUserId: "users:owner",
      bannedAt: 1_000,
      deletedBy: "users:moderator",
      deletedByRole: "moderator",
    });

    expect(result).toMatchObject({ deletedCount: 1, revokedTokenCount: 1, scheduled: false });
    expect(patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({ softDeletedAt: 1_000, softDeletedReason: "user.banned" }),
    );
    expect(patch).toHaveBeenCalledWith("packagePublishTokens:demo", { revokedAt: 1_000 });
  });

  it("stops stale package ban pages when the owner has already been unbanned", async () => {
    const { ctx, patch } = makeOwnedPackageBatchCtx();

    const result = await applyBanToOwnedPackagesBatchInternalHandler(ctx as never, {
      ownerUserId: "users:owner",
      bannedAt: 1_000,
      deletedBy: "users:moderator",
      deletedByRole: "moderator",
      cursor: "next-page",
    });

    expect(result).toMatchObject({
      stale: true,
      deletedCount: 0,
      revokedTokenCount: 0,
      scheduled: false,
    });
    expect(patch).not.toHaveBeenCalledWith("packages:demo", expect.anything());
    expect(patch).not.toHaveBeenCalledWith("packagePublishTokens:demo", expect.anything());
  });

  it("continues committed package ban pages without a pre-commit bypass", async () => {
    const firstPage = makeOwnedPackageBatchCtx({
      owner: { _id: "users:owner", deletedAt: 1_000, deactivatedAt: undefined },
      pkg: makePackageDoc({ _id: "packages:first", ownerUserId: "users:owner" }),
      packageTokens: [
        {
          _id: "packagePublishTokens:first",
          packageId: "packages:first",
          version: "1.0.1",
          revokedAt: undefined,
        },
      ],
      isDone: false,
      continueCursor: "next-page",
    });

    const firstResult = await applyBanToOwnedPackagesBatchInternalHandler(firstPage.ctx as never, {
      ownerUserId: "users:owner",
      bannedAt: 1_000,
      deletedBy: "users:moderator",
      deletedByRole: "moderator",
    });

    expect(firstResult).toMatchObject({ deletedCount: 1, revokedTokenCount: 1, scheduled: true });
    expect(firstPage.patch).toHaveBeenCalledWith(
      "packages:first",
      expect.objectContaining({ softDeletedAt: 1_000, softDeletedReason: "user.banned" }),
    );
    expect(firstPage.patch).toHaveBeenCalledWith("packagePublishTokens:first", {
      revokedAt: 1_000,
    });
    expect(firstPage.runAfter).toHaveBeenCalledWith(
      0,
      expect.anything(),
      expect.objectContaining({
        cursor: "next-page",
      }),
    );

    const staleContinuationPage = makeOwnedPackageBatchCtx({
      owner: { _id: "users:owner", deletedAt: undefined, deactivatedAt: undefined },
      pkg: makePackageDoc({ _id: "packages:second", ownerUserId: "users:owner" }),
      packageTokens: [
        {
          _id: "packagePublishTokens:second",
          packageId: "packages:second",
          version: "1.0.1",
          revokedAt: undefined,
        },
      ],
    });

    const staleContinuationResult = await applyBanToOwnedPackagesBatchInternalHandler(
      staleContinuationPage.ctx as never,
      {
        ownerUserId: "users:owner",
        bannedAt: 1_000,
        deletedBy: "users:moderator",
        deletedByRole: "moderator",
        cursor: "next-page",
      },
    );

    expect(staleContinuationResult).toMatchObject({
      stale: true,
      deletedCount: 0,
      revokedTokenCount: 0,
      scheduled: false,
    });
    expect(staleContinuationPage.patch).not.toHaveBeenCalledWith(
      "packages:second",
      expect.anything(),
    );
    expect(staleContinuationPage.patch).not.toHaveBeenCalledWith(
      "packagePublishTokens:second",
      expect.anything(),
    );

    const committedContinuationPage = makeOwnedPackageBatchCtx({
      owner: { _id: "users:owner", deletedAt: 1_000, deactivatedAt: undefined },
      pkg: makePackageDoc({ _id: "packages:second", ownerUserId: "users:owner" }),
      packageTokens: [
        {
          _id: "packagePublishTokens:second",
          packageId: "packages:second",
          version: "1.0.1",
          revokedAt: undefined,
        },
      ],
    });

    const committedContinuationResult = await applyBanToOwnedPackagesBatchInternalHandler(
      committedContinuationPage.ctx as never,
      {
        ownerUserId: "users:owner",
        bannedAt: 1_000,
        deletedBy: "users:moderator",
        deletedByRole: "moderator",
        cursor: "next-page",
      },
    );

    expect(committedContinuationResult).toMatchObject({
      deletedCount: 1,
      revokedTokenCount: 1,
      scheduled: false,
    });
    expect(committedContinuationPage.patch).toHaveBeenCalledWith(
      "packages:second",
      expect.objectContaining({ softDeletedAt: 1_000, softDeletedReason: "user.banned" }),
    );
    expect(committedContinuationPage.patch).toHaveBeenCalledWith("packagePublishTokens:second", {
      revokedAt: 1_000,
    });
  });

  it("retimestamps earlier ban-hidden packages during a later ban", async () => {
    const { ctx, patch } = makeOwnedPackageBatchCtx({
      owner: { _id: "users:owner", deletedAt: 2_000, deactivatedAt: undefined },
      pkg: makePackageDoc({
        softDeletedAt: 1_000,
        softDeletedReason: "user.banned",
        softDeletedBy: "users:first-moderator",
        softDeletedByRole: "moderator",
      }),
      releases: [
        makeReleaseDoc({
          _id: "packageReleases:ban-hidden",
          softDeletedAt: 1_000,
        }),
        makeReleaseDoc({
          _id: "packageReleases:moderation-hidden",
          softDeletedAt: 500,
        }),
      ],
    });

    const result = await applyBanToOwnedPackagesBatchInternalHandler(ctx as never, {
      ownerUserId: "users:owner",
      bannedAt: 2_000,
      deletedBy: "users:second-moderator",
      deletedByRole: "admin",
    });

    expect(result).toMatchObject({ deletedCount: 0, revokedTokenCount: 1, scheduled: false });
    expect(patch).toHaveBeenCalledWith(
      "packageReleases:ban-hidden",
      expect.objectContaining({ softDeletedAt: 2_000 }),
    );
    expect(patch).not.toHaveBeenCalledWith("packageReleases:moderation-hidden", expect.anything());
    expect(patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        softDeletedAt: 2_000,
        softDeletedBy: "users:second-moderator",
        softDeletedByRole: "admin",
        updatedAt: 2_000,
      }),
    );
    expect(patch).toHaveBeenCalledWith("packagePublishTokens:demo", { revokedAt: 2_000 });
  });

  it("does not hide org-owned packages when banning a member in the legacy owner field", async () => {
    const { ctx, patch } = makeOwnedPackageBatchCtx({
      owner: {
        _id: "users:owner",
        deletedAt: 1_000,
        deactivatedAt: undefined,
        personalPublisherId: "publishers:personal",
      },
      pkg: makePackageDoc({
        ownerUserId: "users:owner",
        ownerPublisherId: "publishers:org",
      }),
      publishers: {
        "publishers:org": { _id: "publishers:org", kind: "org" },
      },
    });

    const result = await applyBanToOwnedPackagesBatchInternalHandler(ctx as never, {
      ownerUserId: "users:owner",
      bannedAt: 1_000,
      deletedBy: "users:moderator",
      deletedByRole: "moderator",
    });

    expect(result).toMatchObject({ deletedCount: 0, revokedTokenCount: 0, scheduled: true });
    expect(patch).not.toHaveBeenCalledWith("packages:demo", expect.anything());
    expect(patch).not.toHaveBeenCalledWith("packagePublishTokens:demo", expect.anything());
  });

  it("restores only packages that were hidden by the matching ban batch", async () => {
    const { ctx, patch, insert } = makeOwnedPackageBatchCtx({
      pkg: makePackageDoc({
        softDeletedAt: 1_000,
        softDeletedReason: "user.banned",
        softDeletedByRole: "moderator",
      }),
      releases: [
        makeReleaseDoc({
          _id: "packageReleases:demo-1",
          softDeletedAt: 1_000,
          distTags: ["latest"],
          version: "1.0.0",
          changelog: "",
          compatibility: null,
          capabilities: null,
          verification: null,
        }),
        makeReleaseDoc({
          _id: "packageReleases:malicious",
          softDeletedAt: 500,
          distTags: ["malicious"],
          version: "0.9.0",
          changelog: "",
          compatibility: null,
          capabilities: null,
          verification: null,
        }),
      ],
    });

    const result = await restoreOwnedPackagesForUnbanBatchInternalHandler(ctx as never, {
      actorUserId: "users:admin",
      ownerUserId: "users:owner",
      bannedAt: 1_000,
    });

    expect(result).toMatchObject({ restoredCount: 1, scheduled: false });
    expect(patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        softDeletedAt: undefined,
        softDeletedReason: undefined,
        softDeletedBy: undefined,
        softDeletedByRole: undefined,
      }),
    );
    expect(insert).toHaveBeenCalledWith(
      "auditLogs",
      expect.objectContaining({
        actorUserId: "users:admin",
        action: "package.undelete",
      }),
    );
    expect(patch).not.toHaveBeenCalledWith("packageReleases:malicious", expect.anything());
  });

  it("restores appeal-service packages without attributing package audit to the target user", async () => {
    const { ctx, insert } = makeOwnedPackageBatchCtx({
      pkg: makePackageDoc({
        softDeletedAt: 1_000,
        softDeletedReason: "user.banned",
        softDeletedByRole: "moderator",
      }),
      releases: [
        makeReleaseDoc({
          _id: "packageReleases:demo-1",
          softDeletedAt: 1_000,
          distTags: ["latest"],
          version: "1.0.0",
          changelog: "",
          compatibility: null,
          capabilities: null,
          verification: null,
        }),
      ],
    });

    const result = await restoreOwnedPackagesForUnbanBatchInternalHandler(ctx as never, {
      ownerUserId: "users:owner",
      bannedAt: 1_000,
    });

    expect(result).toMatchObject({ restoredCount: 1, scheduled: false });
    expect(insert).toHaveBeenCalledWith(
      "auditLogs",
      expect.objectContaining({
        action: "package.undelete",
        metadata: expect.objectContaining({ source: "service" }),
      }),
    );
    const packageAudit = insert.mock.calls.find(
      ([table, doc]) => table === "auditLogs" && doc.action === "package.undelete",
    )?.[1];
    expect(packageAudit).not.toHaveProperty("actorUserId");
  });

  it("restores ban-hidden packages owned through the user's personal publisher", async () => {
    const personalPublisherPackage = makePackageDoc({
      _id: "packages:personal-publisher",
      ownerUserId: "users:publishing-actor",
      ownerPublisherId: "publishers:personal",
      softDeletedAt: 1_000,
      softDeletedReason: "user.banned",
      softDeletedByRole: "moderator",
      latestReleaseId: "packageReleases:personal-publisher-1",
      tags: { latest: "packageReleases:personal-publisher-1" },
    });
    const { ctx, patch } = makeOwnedPackageBatchCtx({
      owner: {
        _id: "users:owner",
        deletedAt: undefined,
        deactivatedAt: undefined,
        personalPublisherId: "publishers:personal",
      },
      publisherPackages: [personalPublisherPackage],
      publishers: {
        "publishers:personal": {
          _id: "publishers:personal",
          kind: "user",
          linkedUserId: "users:owner",
        },
      },
      releases: [
        makeReleaseDoc({
          _id: "packageReleases:personal-publisher-1",
          packageId: "packages:personal-publisher",
          softDeletedAt: 1_000,
          distTags: ["latest"],
          version: "1.0.0",
          changelog: "",
          compatibility: null,
          capabilities: null,
          verification: null,
        }),
      ],
    });

    const result = await restoreOwnedPackagesForUnbanBatchInternalHandler(ctx as never, {
      actorUserId: "users:admin",
      ownerUserId: "users:owner",
      bannedAt: 1_000,
      scope: "personalPublisher",
    });

    expect(result).toMatchObject({ restoredCount: 1, scheduled: false });
    expect(patch).toHaveBeenCalledWith(
      "packages:personal-publisher",
      expect.objectContaining({
        softDeletedAt: undefined,
        softDeletedReason: undefined,
      }),
    );
  });

  it("stops stale package restore batches when the owner is banned again", async () => {
    const { ctx, patch } = makeOwnedPackageBatchCtx({
      owner: { _id: "users:owner", deletedAt: 2_000, deactivatedAt: undefined },
      pkg: makePackageDoc({
        softDeletedAt: 1_000,
        softDeletedReason: "user.banned",
      }),
    });

    const result = await restoreOwnedPackagesForUnbanBatchInternalHandler(ctx as never, {
      actorUserId: "users:admin",
      ownerUserId: "users:owner",
      bannedAt: 1_000,
    });

    expect(result).toMatchObject({ stale: true, restoredCount: 0, scheduled: false });
    expect(patch).not.toHaveBeenCalledWith("packages:demo", expect.anything());
  });

  it("hides and schedules hard deletes for account-deleted packages", async () => {
    const { ctx, patch, runAfter } = makeOwnedPackageBatchCtx();

    const result = await applyAccountDeletionToOwnedPackagesBatchInternalHandler(ctx as never, {
      ownerUserId: "users:owner",
      deletedAt: 3_000,
    });

    expect(result).toMatchObject({ deletedCount: 1, revokedTokenCount: 0, scheduled: false });
    expect(patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        softDeletedAt: 3_000,
        softDeletedReason: "user.deactivated",
        softDeletedBy: "users:owner",
        softDeletedByRole: "user",
      }),
    );
    expect(runAfter).toHaveBeenCalledWith(0, expect.anything(), {
      packageId: "packages:demo",
      actorUserId: "users:owner",
      deletedAt: 3_000,
      source: "account.delete",
    });
  });

  it("schedules hard deletes for account-deleted packages owned through the user's personal publisher", async () => {
    const personalPublisherPackage = makePackageDoc({
      _id: "packages:personal-publisher",
      ownerUserId: "users:publishing-actor",
      ownerPublisherId: "publishers:personal",
    });
    const { ctx, patch, runAfter } = makeOwnedPackageBatchCtx({
      owner: {
        _id: "users:owner",
        deactivatedAt: 3_000,
        personalPublisherId: "publishers:personal",
      },
      publisherPackages: [personalPublisherPackage],
      packageTokens: [
        {
          _id: "packagePublishTokens:personal-publisher",
          packageId: "packages:personal-publisher",
          version: "1.0.1",
          revokedAt: undefined,
        },
      ],
      publishers: {
        "publishers:personal": {
          _id: "publishers:personal",
          kind: "user",
          linkedUserId: "users:owner",
        },
      },
    });

    const result = await applyAccountDeletionToOwnedPackagesBatchInternalHandler(ctx as never, {
      ownerUserId: "users:owner",
      deletedAt: 3_000,
      scope: "personalPublisher",
    });

    expect(result).toMatchObject({ deletedCount: 1, revokedTokenCount: 0, scheduled: false });
    expect(patch).toHaveBeenCalledWith(
      "packages:personal-publisher",
      expect.objectContaining({
        softDeletedAt: 3_000,
        softDeletedReason: "user.deactivated",
        softDeletedBy: "users:owner",
        softDeletedByRole: "user",
      }),
    );
    expect(runAfter).toHaveBeenCalledWith(0, expect.anything(), {
      packageId: "packages:personal-publisher",
      actorUserId: "users:owner",
      deletedAt: 3_000,
      source: "account.delete",
    });
  });

  it("does not delete org-owned packages when deleting a member account", async () => {
    const { ctx, patch } = makeOwnedPackageBatchCtx({
      owner: {
        _id: "users:owner",
        deletedAt: undefined,
        deactivatedAt: 3_000,
        personalPublisherId: "publishers:personal",
      },
      pkg: makePackageDoc({
        ownerUserId: "users:owner",
        ownerPublisherId: "publishers:org",
      }),
      publishers: {
        "publishers:org": { _id: "publishers:org", kind: "org" },
      },
    });

    const result = await applyAccountDeletionToOwnedPackagesBatchInternalHandler(ctx as never, {
      ownerUserId: "users:owner",
      deletedAt: 3_000,
    });

    expect(result).toMatchObject({ deletedCount: 0, revokedTokenCount: 0, scheduled: true });
    expect(patch).not.toHaveBeenCalledWith("packages:demo", expect.anything());
    expect(patch).not.toHaveBeenCalledWith("packagePublishTokens:demo", expect.anything());
  });
});

describe("softDeletePackageInternal", () => {
  it("soft-deletes a package owned by a personal publisher and writes ownerHandle to the search digest", async () => {
    const { ctx, patch, insert } = makeSoftDeleteCtx();

    const result = await softDeletePackageInternalHandler(ctx as never, {
      userId: "users:owner",
      name: "demo-plugin",
    });

    expect(result).toMatchObject({ ok: true, alreadyDeleted: false, releaseCount: 1 });

    // The package doc must be soft-deleted.
    expect(patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({ softDeletedAt: expect.any(Number) }),
    );

    // The packageSearchDigest row must be updated with ownerHandle resolved.
    expect(patch).toHaveBeenCalledWith(
      "packageSearchDigest:demo",
      expect.objectContaining({ ownerHandle: "tongfei11", softDeletedAt: expect.any(Number) }),
    );

    // An audit log must be inserted.
    expect(insert).toHaveBeenCalledWith(
      "auditLogs",
      expect.objectContaining({ action: "package.delete" }),
    );
  });

  it("does not recreate retired capability digest rows", async () => {
    const { ctx, insert } = makeSoftDeleteCtx({ noCapabilityDigest: true });

    await softDeletePackageInternalHandler(ctx as never, {
      userId: "users:owner",
      name: "demo-plugin",
    });

    expect(insert).not.toHaveBeenCalledWith("packageCapabilitySearchDigest", expect.anything());
  });

  it("returns alreadyDeleted:true without touching releases when package is already soft-deleted", async () => {
    const { ctx, patch } = makeSoftDeleteCtx({
      pkg: makePackageDoc({ softDeletedAt: 999, softDeletedByRole: "user" }),
    });

    const result = await softDeletePackageInternalHandler(ctx as never, {
      userId: "users:owner",
      name: "demo-plugin",
    });

    expect(result).toMatchObject({ ok: true, alreadyDeleted: true, releaseCount: 0 });
    // No release patches should have been made.
    expect(patch).not.toHaveBeenCalledWith("packageReleases:demo-1", expect.anything());
  });

  it("keeps manually moderated ban-hidden packages out of unban restore scope", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    const { ctx, patch } = makeSoftDeleteCtx({
      actor: { _id: "users:owner", role: "moderator" },
      pkg: makePackageDoc({
        ownerUserId: "users:owner",
        ownerPublisherId: "publishers:owner-personal",
        softDeletedAt: 1_000,
        softDeletedReason: "user.banned",
        softDeletedBy: "users:first-moderator",
        softDeletedByRole: "moderator",
      }),
    });

    const result = await softDeletePackageInternalHandler(ctx as never, {
      userId: "users:owner",
      name: "demo-plugin",
    });

    expect(result).toMatchObject({ ok: true, alreadyDeleted: true });
    expect(patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({
        softDeletedAt: 2_000,
        softDeletedReason: undefined,
        softDeletedBy: "users:owner",
        softDeletedByRole: "moderator",
      }),
    );
  });
});

describe("restorePackageInternal", () => {
  it("restores a soft-deleted package and writes ownerHandle to the search digest", async () => {
    const pkg = makePackageDoc({
      ownerUserId: "users:owner",
      ownerPublisherId: "publishers:owner-personal",
      softDeletedAt: 500,
      softDeletedByRole: "user",
      softDeletedBy: "users:owner",
      latestReleaseId: "packageReleases:demo-1",
      tags: { latest: "packageReleases:demo-1" },
    });
    // The release was soft-deleted together with the package.
    const restoredRelease = makeReleaseDoc({
      _id: "packageReleases:demo-1",
      softDeletedAt: 500,
      distTags: ["latest"],
      version: "1.0.0",
      changelog: "",
      integritySha256: "abc",
      compatibility: null,
      verification: null,
      scanStatus: "clean",
    });

    const { ctx, patch, insert } = makeSoftDeleteCtx({
      pkg,
      noCapabilityDigest: true,
      releases: [restoredRelease],
    });

    const result = await restorePackageInternalHandler(ctx as never, {
      userId: "users:owner",
      name: "demo-plugin",
    });

    expect(result).toMatchObject({ ok: true, alreadyRestored: false });

    // The package doc must have softDeletedAt cleared.
    expect(patch).toHaveBeenCalledWith(
      "packages:demo",
      expect.objectContaining({ softDeletedAt: undefined }),
    );

    // The packageSearchDigest row must be updated with ownerHandle resolved.
    expect(patch).toHaveBeenCalledWith(
      "packageSearchDigest:demo",
      expect.objectContaining({ ownerHandle: "tongfei11", softDeletedAt: undefined }),
    );

    expect(insert).not.toHaveBeenCalledWith("packageCapabilitySearchDigest", expect.anything());

    // An audit log must be inserted.
    expect(insert).toHaveBeenCalledWith(
      "auditLogs",
      expect.objectContaining({ action: "package.undelete" }),
    );
  });

  it("returns alreadyRestored:true when package is not soft-deleted", async () => {
    const { ctx, patch } = makeSoftDeleteCtx();

    const result = await restorePackageInternalHandler(ctx as never, {
      userId: "users:owner",
      name: "demo-plugin",
    });

    expect(result).toMatchObject({ ok: true, alreadyRestored: true, releaseCount: 0 });
    expect(patch).not.toHaveBeenCalledWith("packages:demo", expect.anything());
  });

  it("does not let package owners directly restore packages hidden by a user ban", async () => {
    const { ctx, patch } = makeSoftDeleteCtx({
      pkg: makePackageDoc({
        ownerUserId: "users:owner",
        ownerPublisherId: "publishers:owner-personal",
        softDeletedAt: 1_000,
        softDeletedReason: "user.banned",
        softDeletedByRole: "moderator",
      }),
    });

    await expect(
      restorePackageInternalHandler(ctx as never, {
        userId: "users:owner",
        name: "demo-plugin",
      }),
    ).rejects.toThrow("Forbidden");
    expect(patch).not.toHaveBeenCalledWith("packages:demo", expect.anything());
  });

  it("does not let moderators directly restore packages hidden by a user ban", async () => {
    const { ctx, patch } = makeSoftDeleteCtx({
      actor: { _id: "users:owner", role: "moderator" },
      pkg: makePackageDoc({
        ownerUserId: "users:owner",
        ownerPublisherId: "publishers:owner-personal",
        softDeletedAt: 1_000,
        softDeletedReason: "user.banned",
        softDeletedByRole: "moderator",
      }),
    });

    await expect(
      restorePackageInternalHandler(ctx as never, {
        userId: "users:owner",
        name: "demo-plugin",
      }),
    ).rejects.toThrow("Forbidden");
    expect(patch).not.toHaveBeenCalledWith("packages:demo", expect.anything());
  });

  it("does not let moderators directly restore packages hidden by account deletion", async () => {
    const { ctx, patch } = makeSoftDeleteCtx({
      actor: { _id: "users:owner", role: "moderator" },
      pkg: makePackageDoc({
        ownerUserId: "users:owner",
        ownerPublisherId: "publishers:owner-personal",
        softDeletedAt: 1_000,
        softDeletedReason: "user.deactivated",
        softDeletedByRole: "user",
      }),
    });

    await expect(
      restorePackageInternalHandler(ctx as never, {
        userId: "users:owner",
        name: "demo-plugin",
      }),
    ).rejects.toThrow("Forbidden");
    expect(patch).not.toHaveBeenCalledWith("packages:demo", expect.anything());
  });

  it("gates Claw named reads and exposes only the safe manifest summary when enabled", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue(null);
    const previous = process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    const latestClawManifestSummary = {
      schemaVersion: 1,
      agent: { id: "demo-claw-latest", name: "Demo Claw Latest", description: "Latest" },
      workspace: { bootstrapFiles: ["SOUL.md"], fileCount: 1 },
      packages: { skillCount: 1, pluginCount: 1 },
      mcpServerCount: 1,
      cronJobCount: 1,
    };
    const exactClawManifestSummary = {
      schemaVersion: 1,
      agent: { id: "demo-claw-v1", name: "Demo Claw v1", description: "Exact" },
      workspace: { bootstrapFiles: ["SOUL.md"], fileCount: 2 },
      packages: { skillCount: 2, pluginCount: 1 },
      mcpServerCount: 2,
      cronJobCount: 2,
    };
    const latestRelease = makeReleaseDoc({
      _id: "packageReleases:demo-latest",
      version: "2.0.0",
      changelog: "Latest release",
      distTags: ["latest"],
      files: [],
      integritySha256: "latest-integrity",
      clawManifestSummary: latestClawManifestSummary,
      createdBy: "users:must-not-project-latest",
      publishActor: { kind: "user", userId: "users:must-not-project-latest" },
      extractedPackageJson: {
        openclaw: {
          packageCoordinate: "must-not-project-latest",
          profile: { workspaceRoot: "must-not-project-latest", policy: "must-not-project-latest" },
          manifest: {
            workspace: { content: "must-not-project-latest" },
            mcp: { command: "must-not-project-latest", env: "must-not-project-latest" },
            cron: { schedule: "must-not-project-latest", message: "must-not-project-latest" },
          },
        },
      },
      extractedClawManifest: {
        schemaVersion: 1,
        agent: { id: "demo-claw-latest" },
      },
    });
    const { ctx } = makePackageCtx({
      pkg: makePackageDoc({
        family: "claw",
        clawProfilePolicyVersion: 1,
        latestReleaseId: "packageReleases:demo-latest",
        latestVersionSummary: { version: "2.0.0" },
      }),
      latestRelease,
      versionRelease: makeReleaseDoc({
        _id: "packageReleases:demo-v1",
        changelog: "Exact release",
        distTags: [],
        files: [],
        integritySha256: "exact-integrity",
        clawManifestSummary: exactClawManifestSummary,
        createdBy: "users:must-not-project-exact",
        publishActor: { kind: "user", userId: "users:must-not-project-exact" },
        extractedPackageJson: {
          openclaw: {
            packageCoordinate: "must-not-project-exact",
            profile: { workspaceRoot: "must-not-project-exact", policy: "must-not-project-exact" },
            manifest: {
              workspace: { content: "must-not-project-exact" },
              mcp: { command: "must-not-project-exact", env: "must-not-project-exact" },
              cron: { schedule: "must-not-project-exact", message: "must-not-project-exact" },
            },
          },
        },
        extractedClawManifest: {
          schemaVersion: 1,
          agent: { id: "demo-claw-v1" },
          workspace: { bootstrapFiles: { "SOUL.md": { source: "workspace/SOUL.md" } } },
        },
      }),
    });

    try {
      delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
      await expect(getByNameHandler(ctx, { name: "demo-plugin" })).resolves.toBeNull();
      await expect(
        getVersionByNameHandler(ctx, { name: "demo-plugin", version: "1.0.0" }),
      ).resolves.toBeNull();

      process.env.CLAWHUB_EXPERIMENTAL_CLAWS = "1";
      const detail = await getByNameHandler(ctx, { name: "demo-plugin" });
      expect(detail).toMatchObject({
        package: {
          family: "claw",
          clawProfilePolicyVersion: 1,
          clawManifestSummary: latestClawManifestSummary,
        },
        latestRelease: { clawManifestSummary: latestClawManifestSummary },
      });
      expect(detail?.latestRelease).not.toHaveProperty("extractedClawManifest");
      expect(JSON.stringify(detail)).not.toContain("must-not-project");

      const version = await getVersionByNameHandler(ctx, {
        name: "demo-plugin",
        version: "1.0.0",
      });
      expect(version).toMatchObject({
        package: { family: "claw", clawManifestSummary: latestClawManifestSummary },
        version: { clawManifestSummary: exactClawManifestSummary },
      });
      expect(version?.version).not.toHaveProperty("extractedClawManifest");
      expect(JSON.stringify(version)).not.toContain("must-not-project");
    } finally {
      if (previous === undefined) delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
      else process.env.CLAWHUB_EXPERIMENTAL_CLAWS = previous;
    }
  });

  it("selects the bounded release projection from package family, not summary presence", async () => {
    vi.mocked(getAuthUserId).mockResolvedValue(null);
    const previous = process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    process.env.CLAWHUB_EXPERIMENTAL_CLAWS = "1";
    const staleSummary = {
      schemaVersion: 1,
      agent: { id: "stale-non-claw-summary" },
      workspace: { bootstrapFiles: [], fileCount: 0 },
      packages: { skillCount: 0, pluginCount: 0 },
      mcpServerCount: 0,
      cronJobCount: 0,
    };

    try {
      const clawRelease = makeReleaseDoc({
        files: [],
        clawManifestSummary: undefined,
        createdBy: "users:must-not-project",
        publishActor: { kind: "user", userId: "users:must-not-project" },
        extractedPackageJson: { privateWorkspace: "must-not-project" },
      });
      const { ctx: clawCtx } = makePackageCtx({
        pkg: makePackageDoc({ family: "claw" }),
        latestRelease: clawRelease,
      });
      const claw = await getByNameHandler(clawCtx, { name: "demo-plugin" });
      expect(claw?.latestRelease).not.toHaveProperty("extractedPackageJson");
      expect(JSON.stringify(claw)).not.toContain("must-not-project");

      const ownerDeletedRelease = makeReleaseDoc({
        files: [],
        ownerDeletedAt: 123,
        clawManifestSummary: staleSummary,
        extractedPackageJson: { privateWorkspace: "must-not-project-owner-deleted" },
      });
      const { ctx: ownerDeletedCtx } = makePackageCtx({
        pkg: makePackageDoc({ family: "claw" }),
        latestRelease: ownerDeletedRelease,
      });
      const ownerDeleted = await getByNameHandler(ownerDeletedCtx, { name: "demo-plugin" });
      expect(ownerDeleted).toMatchObject({ package: { latestVersion: null }, latestRelease: null });
      expect(JSON.stringify(ownerDeleted)).not.toContain("stale-non-claw-summary");
      expect(JSON.stringify(ownerDeleted)).not.toContain("must-not-project-owner-deleted");

      const pluginPackageJson = { name: "demo-plugin", openclaw: { extensions: ["index.js"] } };
      const pluginRelease = makeReleaseDoc({
        clawManifestSummary: staleSummary,
        extractedPackageJson: pluginPackageJson,
      });
      const { ctx: pluginCtx } = makePackageCtx({ latestRelease: pluginRelease });
      const plugin = await getByNameHandler(pluginCtx, { name: "demo-plugin" });
      expect(plugin?.latestRelease).toMatchObject({ extractedPackageJson: pluginPackageJson });
      expect(plugin?.latestRelease).not.toHaveProperty("clawManifestSummary");
    } finally {
      if (previous === undefined) delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
      else process.env.CLAWHUB_EXPERIMENTAL_CLAWS = previous;
    }
  });

  it("omits stored Claws from unfiltered public lists while disabled", async () => {
    const previous = process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    const ctx = makePluginExportCtx([
      makeDigest("demo-claw", { family: "claw", updatedAt: 2, _creationTime: 2 }),
      makeDigest("demo-plugin", { updatedAt: 1, _creationTime: 1 }),
    ]);

    try {
      const result = await listPublicPageHandler(ctx, {
        paginationOpts: { cursor: null, numItems: 25 },
      });
      expect(result.page.map((entry) => entry.name)).toEqual(["demo-plugin"]);
    } finally {
      if (previous === undefined) delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
      else process.env.CLAWHUB_EXPERIMENTAL_CLAWS = previous;
    }
  });

  it("does not let disabled Claws starve unfiltered public list pages", async () => {
    const previous = process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    const hiddenClaws = Array.from({ length: 50 }, (_, index) =>
      makeDigest(`demo-claw-${index}`, {
        family: "claw",
        updatedAt: 100 - index,
        _creationTime: 100 - index,
      }),
    );
    const ctx = makePluginExportCtx([
      ...hiddenClaws,
      makeDigest("visible-plugin", { updatedAt: 1, _creationTime: 1 }),
    ]);

    try {
      const result = await listPublicPageHandler(ctx, {
        paginationOpts: { cursor: null, numItems: 1 },
      });
      expect(result.page.map((entry) => entry.name)).toEqual(["visible-plugin"]);
    } finally {
      if (previous === undefined) delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
      else process.env.CLAWHUB_EXPERIMENTAL_CLAWS = previous;
    }
  });

  it("paginates stable families beyond the per-query read window while Claws are disabled", async () => {
    const previous = process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    const digests = Array.from({ length: 250 }, (_, index) =>
      makeDigest(`stable-${index.toString().padStart(3, "0")}`, {
        updatedAt: 250 - index,
        _creationTime: 250 - index,
      }),
    );
    const ctx = makePluginExportCtx(digests);

    try {
      const first = await listPublicPageHandler(ctx, {
        paginationOpts: { cursor: null, numItems: 200 },
      });
      const second = await listPublicPageHandler(ctx, {
        paginationOpts: { cursor: first.continueCursor, numItems: 200 },
      });
      expect(first.page).toHaveLength(200);
      expect(first.isDone).toBe(false);
      expect(second.page).toHaveLength(50);
      expect(second.isDone).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
      else process.env.CLAWHUB_EXPERIMENTAL_CLAWS = previous;
    }
  });

  it("preserves each stable family's index order across tied public list pages", async () => {
    const previous = process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    const ctx = makePluginExportCtx([
      makeDigest("zulu-plugin", {
        _id: "packageSearchDigest:zulu",
        packageId: "packages:zulu",
        updatedAt: 1,
        _creationTime: 1,
      }),
      makeDigest("alpha-plugin", {
        _id: "packageSearchDigest:alpha",
        packageId: "packages:alpha",
        updatedAt: 1,
        _creationTime: 1,
      }),
    ]);

    try {
      const first = await listPublicPageHandler(ctx, {
        paginationOpts: { cursor: null, numItems: 1 },
      });
      const second = await listPublicPageHandler(ctx, {
        paginationOpts: { cursor: first.continueCursor, numItems: 1 },
      });
      expect([...first.page, ...second.page].map((entry) => entry.name)).toEqual([
        "zulu-plugin",
        "alpha-plugin",
      ]);
      expect(second.isDone).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
      else process.env.CLAWHUB_EXPERIMENTAL_CLAWS = previous;
    }
  });

  it("keeps the cursor's effective sort when recommendation backfill completes between pages", async () => {
    const previous = process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    let recommendationScoresMissing = true;
    const ctx = makePluginExportCtx(
      [
        makeDigest("newer-plugin", { updatedAt: 2, _creationTime: 2 }),
        makeDigest("older-plugin", { updatedAt: 1, _creationTime: 1 }),
      ],
      { recommendationScoresMissing: () => recommendationScoresMissing },
    );

    try {
      const first = await listPublicPageHandler(ctx, {
        sort: "recommended",
        paginationOpts: { cursor: null, numItems: 1 },
      });
      recommendationScoresMissing = false;
      const second = await listPublicPageHandler(ctx, {
        sort: "recommended",
        paginationOpts: { cursor: first.continueCursor, numItems: 1 },
      });
      expect(first.page.map((entry) => entry.name)).toEqual(["newer-plugin"]);
      expect(second.page.map((entry) => entry.name)).toEqual(["older-plugin"]);
    } finally {
      if (previous === undefined) delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
      else process.env.CLAWHUB_EXPERIMENTAL_CLAWS = previous;
    }
  });

  it("does not let disabled Claws starve unfiltered public search", async () => {
    const previous = process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
    const hiddenClaws = Array.from({ length: 50 }, (_, index) =>
      makeDigest(`matching-claw-${index}`, {
        family: "claw",
        displayName: `Matching Claw ${index}`,
        updatedAt: 100 - index,
      }),
    );
    const { ctx } = makeDigestCtx({
      pages: [
        {
          page: hiddenClaws,
          isDone: false,
          continueCursor: "after-claws",
        },
        {
          page: [makeDigest("matching-plugin", { displayName: "Matching Plugin" })],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    try {
      const result = await searchPublicHandler(ctx, { query: "matching", limit: 1 });
      expect(result.map((entry) => entry.package.name)).toEqual(["matching-plugin"]);
    } finally {
      if (previous === undefined) delete process.env.CLAWHUB_EXPERIMENTAL_CLAWS;
      else process.env.CLAWHUB_EXPERIMENTAL_CLAWS = previous;
    }
  });

  it("continues past older search hits to find a later eligible New plugin", async () => {
    const olderMatches = Array.from({ length: 50 }, (_, index) =>
      makeDigest(`matching-old-${index}`, {
        family: "code-plugin",
        displayName: `Matching Old ${index}`,
        createdAt: 10,
      }),
    );
    const { ctx, paginate } = makeDigestCtx({
      pages: [
        {
          page: olderMatches,
          isDone: false,
          continueCursor: "after-older",
        },
        {
          page: [
            makeDigest("matching-new", {
              family: "code-plugin",
              displayName: "Matching New",
              createdAt: 200,
            }),
          ],
          isDone: true,
          continueCursor: "",
        },
      ],
    });

    const result = await searchPublicHandler(ctx, {
      query: "matching",
      family: "code-plugin",
      limit: 1,
      createdAfter: 100,
    });

    expect(result.map((entry) => entry.package.name)).toEqual(["matching-new"]);
    expect(paginate).toHaveBeenCalledTimes(2);
  });
});
