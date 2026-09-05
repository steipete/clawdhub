import {
  ServerPackagePublishRequestSchema,
  validateClawPackageContents,
  derivePluginCategoryTags,
  getCatalogTopicSlugs,
  getPackageScopeOwnerMismatch,
  INTERNAL_UNCATEGORIZED_CATEGORY,
  isPluginCategorySlug,
  normalizeCatalogTopic,
  normalizeCatalogTopics,
  normalizePluginCategories,
  parseArk,
  resolvePluginCategories,
  validateOpenClawExternalCodePluginPackageContents,
  type PackageArtifactSummary,
  type PackageChannel,
  type PackageFamily,
  type PluginCategorySlug,
  type PackageModerationQueueStatus,
  type PackageOfficialMigrationListPhase,
  type PackageOfficialMigrationPhase,
  type ServerPackagePublishRequest,
  type PackageVerificationTier,
} from "clawhub-schema";
import { getPage, type IndexKey } from "convex-helpers/server/pagination";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v, type Value } from "convex/values";
import semver from "semver";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./functions";
import {
  assertAdmin,
  assertModerator,
  assertRole,
  getOptionalActiveAuthUserId,
  requireUserFromAction,
  requireUser,
} from "./lib/access";
import {
  assertArtifactAppealFinalAction,
  assertArtifactAppealTransition,
  assertArtifactReportFinalAction,
  assertArtifactReportTransition,
  readArtifactReportStatus,
  appendPackageModerationEventLog,
} from "./lib/artifactModeration";
import { generatePackageChangelogPreview } from "./lib/changelog";
import { sha256Hex } from "./lib/clawpack";
import {
  ACTIVITY_TREND_DAYS,
  buildDailyMetricTrends,
  clampActivityTrendEndDay,
  getActivityTrendRangeForEndDay,
} from "./lib/downloadTrend";
import {
  buildPackageInspectorFindingsEmail,
  buildPackageInspectorValidationUrl,
} from "./lib/emails";
import { experimentalClawsEnabled, isClawFamilyPubliclyVisible } from "./lib/experimentalClaws";
import { requireGitHubAccountAge } from "./lib/githubAccount";
import { normalizeGitHubRepository } from "./lib/githubActionsOidc";
import { readGlobalPublicPluginsCount } from "./lib/globalStats";
import { toDayKey } from "./lib/leaderboards";
import type { StaticScanResult } from "./lib/moderationEngine";
import { isOfficialPublisher } from "./lib/officialPublishers";
import { verifyOpenClawPublishAuthorization } from "./lib/openClawPublishAuthorization";
import { getPackageReleaseArtifactSha256 } from "./lib/packageArtifacts";
import {
  assertManualRecoveryFinalization,
  manualPackageRecovery,
} from "./lib/packagePublishRecovery";
import {
  assertPackageVersion,
  derivePluginManifestSummary,
  ensurePluginNameMatchesPackage,
  extractBundlePluginArtifacts,
  extractCodePluginArtifacts,
  maybeParseJson,
  normalizePluginManifestIcon,
  normalizePackageName,
  normalizePublishFiles,
  readStorageText,
  readOptionalTextFile,
  summarizePackageForSearch,
  toConvexSafeJsonValue,
} from "./lib/packageRegistry";
import { assertPackageRuntimeIdAvailable } from "./lib/packageRuntimeIdentity";
import { extractPackageDigestFields, upsertPackageSearchDigest } from "./lib/packageSearchDigest";
import {
  getPackageTrustReasons,
  isPackageBlockedFromPublic,
  normalizePackageScanStatus,
  resolvePackageReleaseScanStatus,
} from "./lib/packageSecurity";
import { insertPackageInstallStatEvent } from "./lib/packageStatEvents";
import { toPublicPublisher } from "./lib/public";
import {
  assertCanManageOwnedResource,
  canAccessPublisherOwnerScope,
  getPublisherByHandle,
  getPersonalPublisherForUser,
  getOwnerPublisher,
  getPublisherMembership,
  isPublisherActive,
  isPublisherRoleAllowed,
  PUBLISHER_HANDLE_PATTERN,
  normalizePublisherHandle,
} from "./lib/publishers";
import {
  findOversizedPublishFile,
  getPublishFileSizeError,
  getPublishTotalSizeError,
  MAX_PUBLISH_TOTAL_BYTES,
} from "./lib/publishLimits";
import { assertRankingMetricWritesAllowed } from "./lib/rankingMetricsImportLock";
import {
  computeRecommendationScore,
  RECOMMENDATION_SCORE_VERSION,
} from "./lib/recommendationScore";
import { MAX_ACTIVE_REPORTS_PER_USER, MAX_REPORT_REASON_LENGTH } from "./lib/reporting";
import {
  compareRankedSearchKeys,
  isDemotedExactMatch,
  rankedSearchKey,
  verificationRank,
  type SearchTrustSignals,
} from "./lib/searchRanking";
import { matchesAllTokens, matchesExploratoryTokenPrefixes, tokenize } from "./lib/searchText";
import { buildPackageInventoryDigest, hashSkillFiles } from "./lib/skills";
import { buildDeterministicPackageZip } from "./lib/skillZip";
import { PACKAGE_TRENDING_LEADERBOARD_KIND } from "./packageLeaderboards";
import { ACTIVE_PUBLISH_ATTEMPT_STATUSES, failedPublishAttemptPatch } from "./publishAttempts";
import schema from "./schema";

const MAX_PUBLIC_LIST_PAGE_SIZE = 200;
const MAX_PUBLIC_LIST_FILTER_SCAN_DOCUMENTS = 500;
const MAX_PUBLIC_LIST_FILTER_SCAN_PAGES = 6;
const MAX_PLUGIN_EXPORT_LIST_LIMIT = 250;
const MAX_PLUGIN_VALIDATION_REPORT_PAGE_SIZE = 50;
const MAX_SEARCH_PAGE_SIZE = 200;
const MAX_DIRECT_PACKAGE_SEARCH_CANDIDATES = 20;
const MAX_DIRECT_PACKAGE_FULL_TEXT_CANDIDATES = 40;
const STABLE_PACKAGE_FAMILIES = ["skill", "code-plugin", "bundle-plugin"] as const;
const MAX_PACKAGE_VERSION_DELETE_LOOKUP_CANDIDATES = 4;
const MAX_POINTERLESS_RELEASE_SURVIVOR_SCAN = 100;
// Release rows can approach 1 MiB, and trigger-wrapped patches materialize full documents.
const PACKAGE_RELEASE_TAG_CLEANUP_BATCH_SIZE = 4;
// The recent scan probe reads full release rows plus each parent package in one transaction.
const MAX_PACKAGE_RELEASE_SCAN_RECENT_CANDIDATES = 4;
const MAX_PACKAGE_RELEASE_SCAN_BACKLOG_CANDIDATES = 8;
const packageListScanStatusValidator = v.union(
  v.literal("clean"),
  v.literal("suspicious"),
  v.literal("malicious"),
  v.literal("pending"),
  v.literal("not-run"),
);
type PackageListScanStatus = NonNullable<Doc<"packages">["scanStatus"]>;
const MAX_APPEAL_MESSAGE_LENGTH = 2_000;
const MAX_OFFICIAL_MIGRATION_BLOCKERS = 20;
const MAX_OFFICIAL_MIGRATION_FIELD_LENGTH = 300;
const MAX_OFFICIAL_MIGRATION_NOTES_LENGTH = 2_000;
const MAX_STORED_PACKAGE_METADATA_DEPTH = 10;
const CURRENT_OPENCLAW_PROFILE_POLICY_VERSION = 1;
const REAL_BUNDLE_MANIFESTS = [
  { path: ".codex-plugin/plugin.json", format: "codex" },
  { path: ".claude-plugin/plugin.json", format: "claude" },
  { path: ".cursor-plugin/plugin.json", format: "cursor" },
] as const;
const INITIAL_PACKAGE_VT_SCAN_DELAY_MS = 30_000;
const PLUGIN_EXPORT_FAMILIES = ["code-plugin", "bundle-plugin"] as const;
const GET_PAGE_TIEBREAKER_FIELD_COUNT = 2;

function computePackageRecommendationScore(
  stats: Doc<"packages">["stats"],
  context?: { createdAt?: number; updatedAt?: number; now?: number },
) {
  return computeRecommendationScore(
    {
      downloads: stats.downloads,
      installs: stats.installs,
      stars: stats.stars,
    },
    context,
  );
}

function computePackageRecommendationPatch(
  stats: Doc<"packages">["stats"],
  context?: { createdAt?: number; updatedAt?: number; now?: number },
) {
  return {
    recommendedScore: computePackageRecommendationScore(stats, context),
    recommendedScoreVersion: RECOMMENDATION_SCORE_VERSION,
  };
}

function getPackageRecommendedScoreIndexName(family: Doc<"packages">["family"] | undefined) {
  return family ? "by_active_family_recommended_score" : "by_active_recommended_score";
}

async function getPackageRecommendedIndexName(
  ctx: Pick<QueryCtx, "db">,
  family: Doc<"packages">["family"] | undefined,
) {
  const missingScore = await hasMissingPackageRecommendedScore(ctx, family);
  if (missingScore) return null;
  return getPackageRecommendedScoreIndexName(family);
}

async function hasMissingPackageRecommendedScore(
  ctx: Pick<QueryCtx, "db">,
  family: Doc<"packages">["family"] | undefined,
) {
  if (family) {
    const missingScore = await ctx.db
      .query("packages")
      .withIndex("by_active_family_recommended_score", (q) =>
        q.eq("softDeletedAt", undefined).eq("family", family).eq("recommendedScore", undefined),
      )
      .first();
    if (missingScore) return true;

    const missingVersion = await ctx.db
      .query("packages")
      .withIndex("by_active_family_recommended_score_version", (q) =>
        q
          .eq("softDeletedAt", undefined)
          .eq("family", family)
          .eq("recommendedScoreVersion", undefined),
      )
      .first();
    if (missingVersion) return true;

    const staleVersion = await ctx.db
      .query("packages")
      .withIndex("by_active_family_recommended_score_version", (q) =>
        q
          .eq("softDeletedAt", undefined)
          .eq("family", family)
          .lt("recommendedScoreVersion", RECOMMENDATION_SCORE_VERSION),
      )
      .first();
    return Boolean(staleVersion);
  }

  const missingScore = await ctx.db
    .query("packages")
    .withIndex("by_active_recommended_score", (q) =>
      q.eq("softDeletedAt", undefined).eq("recommendedScore", undefined),
    )
    .first();
  if (missingScore) return true;

  const missingVersion = await ctx.db
    .query("packages")
    .withIndex("by_active_recommended_score_version", (q) =>
      q.eq("softDeletedAt", undefined).eq("recommendedScoreVersion", undefined),
    )
    .first();
  if (missingVersion) return true;

  const staleVersion = await ctx.db
    .query("packages")
    .withIndex("by_active_recommended_score_version", (q) =>
      q.eq("softDeletedAt", undefined).lt("recommendedScoreVersion", RECOMMENDATION_SCORE_VERSION),
    )
    .first();
  return Boolean(staleVersion);
}

const llmAgenticRiskEvidenceValidator = v.object({
  path: v.string(),
  snippet: v.string(),
  explanation: v.string(),
});

const llmAgenticRiskFindingValidator = v.object({
  categoryId: v.string(),
  categoryLabel: v.string(),
  riskBucket: v.union(
    v.literal("abnormal_behavior_control"),
    v.literal("permission_boundary"),
    v.literal("sensitive_data_protection"),
  ),
  status: v.union(v.literal("none"), v.literal("note"), v.literal("concern")),
  severity: v.string(),
  confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
  evidence: v.optional(llmAgenticRiskEvidenceValidator),
  userImpact: v.string(),
  recommendation: v.string(),
});

const llmRiskSummaryBucketValidator = v.object({
  status: v.union(v.literal("none"), v.literal("note"), v.literal("concern")),
  summary: v.string(),
  highestSeverity: v.optional(v.string()),
});
const packageOfficialMigrationPhaseValidator = v.union(
  v.literal("planned"),
  v.literal("published"),
  v.literal("clawpack-ready"),
  v.literal("legacy-zip-only"),
  v.literal("metadata-ready"),
  v.literal("blocked"),
  v.literal("ready-for-openclaw"),
);
const vtEngineStatsValidator = v.object({
  malicious: v.optional(v.number()),
  suspicious: v.optional(v.number()),
  undetected: v.optional(v.number()),
  harmless: v.optional(v.number()),
});
const vtAnalysisValidator = v.object({
  status: v.string(),
  verdict: v.optional(v.string()),
  analysis: v.optional(v.string()),
  source: v.optional(v.string()),
  scanner: v.optional(v.string()),
  engineStats: v.optional(vtEngineStatsValidator),
  checkedAt: v.number(),
});

const skillSpectorIssueValidator = v.object({
  issueId: v.string(),
  category: v.optional(v.string()),
  pattern: v.optional(v.string()),
  severity: v.string(),
  confidence: v.optional(v.number()),
  file: v.optional(v.string()),
  startLine: v.optional(v.number()),
  endLine: v.optional(v.number()),
  explanation: v.string(),
  remediation: v.optional(v.string()),
  finding: v.optional(v.string()),
  codeSnippet: v.optional(v.string()),
});

const skillSpectorAnalysisValidator = v.object({
  status: v.string(),
  score: v.optional(v.number()),
  severity: v.optional(v.string()),
  recommendation: v.optional(v.string()),
  issueCount: v.number(),
  issues: v.array(skillSpectorIssueValidator),
  scannerVersion: v.optional(v.string()),
  summary: v.optional(v.string()),
  error: v.optional(v.string()),
  checkedAt: v.number(),
});

const aigAnalysisValidator = v.object({
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

const PACKAGE_STAT_EVENT_BATCH_SIZE = 100;
export const PROCESSED_PACKAGE_STAT_EVENT_PRUNE_CONFIRMATION_TOKEN =
  "PRUNE_PROCESSED_PACKAGE_STAT_EVENTS";
const DEFAULT_PROCESSED_PACKAGE_STAT_EVENT_RETENTION_DAYS = 7;
const MIN_PROCESSED_PACKAGE_STAT_EVENT_RETENTION_DAYS = 1;
const MAX_PROCESSED_PACKAGE_STAT_EVENT_RETENTION_DAYS = 90;
const DEFAULT_PROCESSED_PACKAGE_STAT_EVENT_PRUNE_BATCH_SIZE = 1_000;
const MAX_PROCESSED_PACKAGE_STAT_EVENT_PRUNE_BATCH_SIZE = 5_000;
const DEFAULT_PROCESSED_PACKAGE_STAT_EVENT_PRUNE_MAX_BATCHES = 20;
const MAX_PROCESSED_PACKAGE_STAT_EVENT_PRUNE_MAX_BATCHES = 100;

type ProcessedPackageStatEventPruneBatchResult = {
  cutoffProcessedAt: number;
  dryRun: boolean;
  matched: number;
  deleted: number;
  hasMore: boolean;
};

type ProcessedPackageStatEventPruneResult = {
  cutoffProcessedAt: number;
  retentionDays: number;
  dryRun: boolean;
  batches: number;
  matched: number;
  deleted: number;
  stoppedReason: "empty" | "max_batches";
  scheduledContinuation: boolean;
};

function clampPackageStatInt(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(Math.floor(value), max));
}

function normalizeProcessedPackageStatEventRetentionDays(retentionDays: number | undefined) {
  return clampPackageStatInt(
    retentionDays ?? DEFAULT_PROCESSED_PACKAGE_STAT_EVENT_RETENTION_DAYS,
    MIN_PROCESSED_PACKAGE_STAT_EVENT_RETENTION_DAYS,
    MAX_PROCESSED_PACKAGE_STAT_EVENT_RETENTION_DAYS,
  );
}

function normalizeProcessedPackageStatEventPruneBatchSize(batchSize: number | undefined) {
  return clampPackageStatInt(
    batchSize ?? DEFAULT_PROCESSED_PACKAGE_STAT_EVENT_PRUNE_BATCH_SIZE,
    1,
    MAX_PROCESSED_PACKAGE_STAT_EVENT_PRUNE_BATCH_SIZE,
  );
}

function normalizeProcessedPackageStatEventPruneMaxBatches(maxBatches: number | undefined) {
  return clampPackageStatInt(
    maxBatches ?? DEFAULT_PROCESSED_PACKAGE_STAT_EVENT_PRUNE_MAX_BATCHES,
    1,
    MAX_PROCESSED_PACKAGE_STAT_EVENT_PRUNE_MAX_BATCHES,
  );
}

function inferOwnerHandleFromScopedPackageName(name: string) {
  const match = /^@([^/]+)\//.exec(name);
  return match?.[1] || undefined;
}

function getPackageSlugFromName(name: string) {
  return name.split("/").pop()?.trim() || "plugin-name";
}

function getClawHubPublisherHandleSuggestion(handle: string) {
  const suggestion = handle
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 40)
    .replace(/[._-]+$/g, "");
  return PUBLISHER_HANDLE_PATTERN.test(suggestion) ? suggestion : null;
}

function getScopedPackageMissingPublisherMessage(params: {
  scopedOwnerHandle: string;
  packageName: string;
  legacyPersonalOwnerHandle?: string;
}) {
  if (!PUBLISHER_HANDLE_PATTERN.test(params.scopedOwnerHandle)) {
    const suggestedOwnerHandle = getClawHubPublisherHandleSuggestion(params.scopedOwnerHandle);
    const packageSlug = getPackageSlugFromName(params.packageName);
    const renameGuidance = suggestedOwnerHandle
      ? ` Rename package.json to a ClawHub-compatible scope, such as "@${suggestedOwnerHandle}/${packageSlug}", then publish again.`
      : " Rename package.json to a ClawHub-compatible scope that starts and ends with a lowercase letter or number and uses lowercase letters, numbers, hyphens, dots, or underscores, then publish again.";
    return `Cannot publish ${params.packageName}: package.json name is scoped to "@${params.scopedOwnerHandle}", but ClawHub publisher handles must start and end with a lowercase letter or number and may only use lowercase letters, numbers, hyphens, dots, or underscores.${renameGuidance}`;
  }
  if (params.legacyPersonalOwnerHandle) {
    const displayName = params.scopedOwnerHandle
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
    return `Cannot publish ${params.packageName}: package.json name is scoped to "@${params.scopedOwnerHandle}", but ClawHub has no "@${params.scopedOwnerHandle}" publisher.\n\nThis package already exists under your personal publisher "@${params.legacyPersonalOwnerHandle}". To move it into the matching org publisher, run:\n\n  clawhub publisher create ${params.scopedOwnerHandle} --display-name "${displayName || params.scopedOwnerHandle}"\n  clawhub package transfer ${params.packageName} --to ${params.scopedOwnerHandle} --reason "Move legacy personal package into @${params.scopedOwnerHandle}"\n\nThen rerun publish.`;
  }
  return `Cannot publish ${params.packageName}: package.json name is scoped to "@${params.scopedOwnerHandle}", but ClawHub has no "@${params.scopedOwnerHandle}" publisher. Create it with "clawhub publisher create ${params.scopedOwnerHandle}".`;
}

function getScopedPackagePublishAccessMessage(params: {
  scopedOwnerHandle: string;
  packageName: string;
}) {
  return [
    `Cannot publish ${params.packageName}: package.json name is scoped to "@${params.scopedOwnerHandle}", but your account does not have publish rights to the "@${params.scopedOwnerHandle}" ClawHub organization.`,
    "Create the matching ClawHub organization if it does not exist, get publish rights to that organization, or rename package.json name to use an organization scope you control.",
  ].join("\n\n");
}

function isTrustedOpenClawPluginPackage(params: {
  family: PackageFamily;
  normalizedName: string;
  ownerPublisher?: Pick<Doc<"publishers">, "handle" | "deletedAt"> | null;
}) {
  if (params.family !== "code-plugin" && params.family !== "bundle-plugin") return false;
  if (!params.normalizedName.startsWith("@openclaw/")) return false;
  const ownerHandle = params.ownerPublisher?.handle?.trim().toLowerCase();
  return ownerHandle === "openclaw" && params.ownerPublisher?.deletedAt === undefined;
}

const internalRefs = internal as unknown as {
  packages: {
    backfillPackageReleaseScansInternal: unknown;
    scanPackageReleaseStaticallyInternal: unknown;
    insertReleaseInternal: unknown;
    getPackageByNameInternal: unknown;
    findPackagePublishResultInternal: unknown;
    getTrustedPublisherByPackageIdInternal: unknown;
    getByNameForViewerInternal: unknown;
    getPackageByIdInternal: unknown;
    getReleaseByIdInternal: unknown;
    assertCanGenerateChangelogPreviewInternal: unknown;
    getReleaseByPackageAndVersionInternal: unknown;
    getPackageReleaseScanBackfillBatchInternal: unknown;
    listVersionsForViewerInternal: unknown;
    getVersionByNameForViewerInternal: unknown;
    publishPackageForUserInternal: unknown;
    insertAuditLogInternal: unknown;
    updateReleaseStaticScanInternal: unknown;
    backfillLatestPackageScanStatusInternal: unknown;
    normalizeOfficialPublisherPackagesInternal: unknown;
    insertPackageInspectorWarningsInternal: unknown;
    sendPackageInspectorFindingsEmailInternal: unknown;
    getPackageInspectorEmailContextInternal: unknown;
    markPackageInspectorFindingsEmailedInternal: unknown;
    claimPackageInspectorScanBatchInternal: unknown;
    ingestPackageInspectorScanResultsInternal: unknown;
    discardPendingPackagePublicationInternal: unknown;
    cleanupReassignedPackageReleaseTagsInternal: unknown;
    publishPendingReleaseInternal: unknown;
  };
  packageInspectorNode: {
    runPackageInspectorForPublishInternal: unknown;
  };
  staticPublishScanNode: {
    runStaticPublishScanInternal: unknown;
  };
  packagePublishTokens: {
    createInternal: unknown;
    getByIdInternal: unknown;
    revokeInternal: unknown;
  };
  skills: {
    getSkillBySlugInternal: unknown;
  };
  users: {
    getByIdInternal: unknown;
    getByHandleInternal: unknown;
  };
  publishers: {
    getByIdInternal: unknown;
    resolvePublishTargetForUserInternal: unknown;
  };
  publishAttempts: {
    createPackagePublishAttemptInternal: unknown;
    findExistingPublishAttemptForArtifactInternal: unknown;
    claimPackagePublishAttemptForFinalizationInternal: unknown;
    releasePackagePublishAttemptFinalizationClaimInternal: unknown;
    recordPackagePublishAttemptFinalizedInternal: unknown;
  };
  securityScan: {
    enqueuePackageReleaseScanInternal: unknown;
  };
  vt: {
    scanPackageReleaseWithVirusTotal: unknown;
  };
};

const packageInspectorWarningInputValidator = v.object({
  id: v.optional(v.string()),
  code: v.string(),
  severity: v.optional(v.string()),
  level: v.optional(v.string()),
  issueClass: v.optional(v.string()),
  compatStatus: v.optional(v.string()),
  deprecated: v.optional(v.boolean()),
  message: v.string(),
  evidence: v.optional(v.array(v.string())),
  authorRemediation: v.optional(
    v.object({
      summary: v.string(),
      docsUrl: v.optional(v.string()),
    }),
  ),
  fixture: v.optional(v.string()),
  decision: v.optional(v.string()),
});

const packageInspectorFindingInputValidator = v.object({
  id: v.optional(v.string()),
  code: v.string(),
  severity: v.optional(v.string()),
  level: v.optional(v.string()),
  issueClass: v.optional(v.string()),
  compatStatus: v.optional(v.string()),
  deprecated: v.optional(v.boolean()),
  message: v.string(),
  evidence: v.optional(v.array(v.string())),
  authorRemediation: v.optional(
    v.object({
      summary: v.string(),
      docsUrl: v.optional(v.string()),
    }),
  ),
  fixture: v.optional(v.string()),
  decision: v.optional(v.string()),
});

type PackageInspectorAuthorRemediation = {
  summary: string;
  docsUrl?: string;
};

type PackageInspectorFinding = {
  id?: string;
  code: string;
  severity?: string;
  level?: string;
  issueClass?: string;
  compatStatus?: string;
  deprecated?: boolean;
  message: string;
  evidence?: string[];
  authorRemediation?: PackageInspectorAuthorRemediation;
  fixture?: string;
  decision?: string;
};

type PackageInspectorPublishResult = {
  status: "pass" | "fail";
  summary: {
    breakageCount: number;
    warningCount: number;
    deprecationWarningCount: number;
    issueCount: number;
  };
  breakages: PackageInspectorFinding[];
  warnings: PackageInspectorFinding[];
  metadata?: {
    inspectorVersion?: string;
    targetOpenClawVersion?: string;
  };
};

function hasAuthorRemediation(finding: PackageInspectorFinding) {
  return Boolean(finding.authorRemediation?.summary);
}
type DbReaderCtx = Pick<QueryCtx | MutationCtx, "db">;
const BAN_USER_PACKAGES_BATCH_SIZE = 25;
const PACKAGE_PUBLISH_TOKEN_REVOKE_BATCH_SIZE = 25;
type PackageSoftDeletedReason = "user.banned" | "user.deactivated" | "publisher.deleted";
const ownedPackageScanScopeValidator = v.optional(
  v.union(v.literal("ownerUserId"), v.literal("personalPublisher")),
);
const hardDeletePackageSourceValidator = v.union(
  v.literal("admin"),
  v.literal("account.delete"),
  v.literal("publisher.delete"),
);
type OwnedPackageScanScope = "ownerUserId" | "personalPublisher";
type PackagePublishActor =
  | {
      kind: "user";
      userId: Id<"users">;
    }
  | {
      kind: "github-actions";
      repository: string;
      workflow: string;
      runId: string;
      runAttempt: string;
      sha: string;
    };
type PackagePublishAuthContext =
  | {
      kind: "user";
      actorUserId: Id<"users">;
      manualOverrideReason?: string;
    }
  | {
      kind: "github-actions";
      publishToken: Doc<"packagePublishTokens">;
    };
type PackageTrustedPublisherDoc = Doc<"packageTrustedPublishers">;
type PackagePublishOptions = {
  stagePrePublicationChecks?: boolean;
};
type PackageDoc = Doc<"packages">;
type PublicPackageListItem = {
  name: string;
  displayName: string;
  family: PackageFamily;
  runtimeId: string | null;
  channel: PackageChannel;
  isOfficial: boolean;
  summary: string | null;
  icon: string | null;
  ownerHandle: string | null;
  createdAt: number;
  updatedAt: number;
  latestVersion: string | null;
  categories?: string[];
  topics?: string[];
  featuredAt?: number;
  verificationTier: PackageVerificationTier | null;
  stats: Doc<"packages">["stats"];
};
type PackageReleaseScanStatus = ReturnType<typeof resolvePackageReleaseScanStatus>;
type PackageReleaseModerationQueueDoc = Omit<Doc<"packageReleases">, "createdAt"> & {
  createdAt?: number;
};
type PackageReportStatus = "open" | "confirmed" | "dismissed";
type PackageReportFinalAction = "none" | "quarantine" | "revoke";
type PackageAppealFinalAction = "none" | "approve";
type PackageModerationQueueItem = {
  packageId: Id<"packages">;
  releaseId: Id<"packageReleases">;
  name: string;
  displayName: string;
  family: PackageFamily;
  channel: PackageChannel;
  isOfficial: boolean;
  version: string;
  createdAt: number;
  artifactKind?: Doc<"packageReleases">["artifactKind"] | null;
  scanStatus: PackageReleaseScanStatus;
  moderationState?: NonNullable<Doc<"packageReleases">["manualModeration"]>["state"] | null;
  moderationReason?: string | null;
  sourceRepo?: string | null;
  sourceCommit?: string | null;
  reportCount: number;
  lastReportedAt?: number | null;
  reasons: string[];
};
type PackageReportListItem = {
  reportId: Id<"packageReports">;
  packageId: Id<"packages">;
  releaseId?: Id<"packageReleases"> | null;
  name: string;
  displayName: string;
  family: PackageFamily;
  version?: string | null;
  reason?: string | null;
  status: PackageReportStatus;
  createdAt: number;
  reporter: {
    userId: Id<"users">;
    handle?: string | null;
    displayName?: string | null;
  };
  triagedAt?: number | null;
  triagedBy?: Id<"users"> | null;
  triageNote?: string | null;
  actionTaken?: PackageReportFinalAction | null;
};
type PackageAppealStatus = "open" | "accepted" | "rejected";
type PackageAppealListItem = {
  appealId: Id<"packageAppeals">;
  packageId: Id<"packages">;
  releaseId: Id<"packageReleases">;
  name: string;
  displayName: string;
  family: PackageFamily;
  version: string;
  message: string;
  status: PackageAppealStatus;
  createdAt: number;
  submitter: {
    userId: Id<"users">;
    handle?: string | null;
    displayName?: string | null;
  };
  resolvedAt?: number | null;
  resolvedBy?: Id<"users"> | null;
  resolutionNote?: string | null;
  actionTaken?: PackageAppealFinalAction | null;
};
type PackageOfficialMigrationListItem = {
  migrationId: Id<"officialPluginMigrations">;
  bundledPluginId: string;
  packageName: string;
  packageId?: Id<"packages"> | null;
  owner?: string | null;
  sourceRepo?: string | null;
  sourcePath?: string | null;
  sourceCommit?: string | null;
  phase: PackageOfficialMigrationPhase;
  blockers: string[];
  hostTargetsComplete: boolean;
  scanClean: boolean;
  moderationApproved: boolean;
  runtimeBundlesReady: boolean;
  notes?: string | null;
  createdAt: number;
  updatedAt: number;
};
type PackageModerationStatus = {
  package: {
    packageId: Id<"packages">;
    name: string;
    displayName: string;
    family: PackageFamily;
    channel: PackageChannel;
    isOfficial: boolean;
    reportCount: number;
    lastReportedAt?: number | null;
    scanStatus?: Doc<"packages">["scanStatus"];
  };
  latestRelease: {
    releaseId: Id<"packageReleases">;
    version: string;
    artifactKind?: Doc<"packageReleases">["artifactKind"] | null;
    scanStatus: PackageReleaseScanStatus;
    moderationState?: NonNullable<Doc<"packageReleases">["manualModeration"]>["state"] | null;
    moderationReason?: string | null;
    blockedFromDownload: boolean;
    reasons: string[];
    createdAt: number;
  } | null;
};

function getPackageOwnerKey(
  pkg: Pick<PackageDoc, "ownerUserId" | "ownerPublisherId">,
  options?: {
    nextOwnerPublisherId?: Id<"publishers">;
    ownerPublisher?: Doc<"publishers"> | null;
  },
) {
  if (pkg.ownerPublisherId) return `publisher:${pkg.ownerPublisherId}`;
  if (
    options?.nextOwnerPublisherId &&
    options.ownerPublisher?.kind === "user" &&
    options.ownerPublisher.linkedUserId === pkg.ownerUserId
  ) {
    return `publisher:${options.nextOwnerPublisherId}`;
  }
  return `user:${pkg.ownerUserId}`;
}

function getRequestedPackageOwnerKey(args: {
  ownerUserId: Id<"users">;
  ownerPublisherId?: Id<"publishers">;
}) {
  return args.ownerPublisherId ? `publisher:${args.ownerPublisherId}` : `user:${args.ownerUserId}`;
}

function derivePackagePublisherChannel(args: {
  requestedChannel?: PackageChannel;
  currentChannel?: PackageChannel;
  currentIsReservation?: boolean;
  publisherOfficial: boolean;
}) {
  if (
    args.currentChannel === "private" &&
    !args.currentIsReservation &&
    args.requestedChannel === undefined
  ) {
    return "private";
  }
  if (args.publisherOfficial) {
    return args.requestedChannel === "private" ? "private" : "official";
  }
  return args.requestedChannel ?? "community";
}

function isReservedPackagePlaceholder(pkg: PackageDoc | null | undefined) {
  return Boolean(pkg && !pkg.latestReleaseId && !pkg.latestVersionSummary);
}

function shouldIncludePackageReportsInModerationQueue(
  reportCount: number,
  status: PackageModerationQueueStatus,
) {
  return reportCount > 0 && (status === "open" || status === "all");
}

function shouldIncludeReleaseInModerationQueue(
  release: Doc<"packageReleases">,
  scanStatus: PackageReleaseScanStatus,
  status: PackageModerationQueueStatus,
) {
  const manualState = release.manualModeration?.state;
  if (status === "manual") return Boolean(manualState);
  if (status === "blocked") {
    return manualState === "quarantined" || manualState === "revoked" || scanStatus === "malicious";
  }
  if (status === "all") return Boolean(manualState) || scanStatus !== "clean";
  return (
    manualState === "quarantined" ||
    manualState === "revoked" ||
    scanStatus === "suspicious" ||
    scanStatus === "malicious" ||
    scanStatus === "pending"
  );
}

function getPackageReleaseCreatedAt(release: PackageReleaseModerationQueueDoc) {
  return typeof release.createdAt === "number" ? release.createdAt : release._creationTime;
}

function toPackageModerationQueueItem(
  pkg: Doc<"packages">,
  release: PackageReleaseModerationQueueDoc,
): PackageModerationQueueItem {
  const scanStatus = resolvePackageReleaseScanStatus(release);
  const reportCount = pkg.reportCount ?? 0;
  const source = (release.source && typeof release.source === "object" ? release.source : {}) as {
    repo?: unknown;
    commit?: unknown;
  };

  return {
    packageId: pkg._id,
    releaseId: release._id,
    name: pkg.name,
    displayName: pkg.displayName,
    family: pkg.family,
    channel: pkg.channel,
    isOfficial: pkg.isOfficial,
    version: release.version,
    createdAt: getPackageReleaseCreatedAt(release),
    artifactKind: release.artifactKind ?? null,
    scanStatus,
    moderationState: release.manualModeration?.state ?? null,
    moderationReason: release.manualModeration?.reason ?? null,
    sourceRepo: typeof source.repo === "string" ? source.repo : null,
    sourceCommit: typeof source.commit === "string" ? source.commit : null,
    reportCount,
    lastReportedAt: pkg.lastReportedAt ?? null,
    reasons: getPackageTrustReasons(release, scanStatus, reportCount),
  };
}

type PackageBadgeKind = Doc<"packageBadges">["kind"];
type PackageDigestLike = Pick<
  Doc<"packageSearchDigest">,
  | "packageId"
  | "name"
  | "normalizedName"
  | "displayName"
  | "family"
  | "runtimeId"
  | "channel"
  | "isOfficial"
  | "ownerUserId"
  | "ownerPublisherId"
  | "summary"
  | "icon"
  | "ownerHandle"
  | "ownerKind"
  | "createdAt"
  | "updatedAt"
  | "latestVersion"
  | "categories"
  | "topics"
  | "pluginCategoryTags"
  | "verificationTier"
  | "stats"
  | "recommendedScore"
  | "scanStatus"
  | "softDeletedAt"
> & { pluginCategory?: string };
type PackageOwnerAccessRef = Pick<PackageDigestLike, "ownerUserId" | "ownerPublisherId"> &
  Partial<Pick<PackageDigestLike, "ownerKind">>;
type PublicPageCursorState = {
  cursor: string | null;
  offset: number;
  pageSize: number | null;
  done: boolean;
  mode?: "packages" | "digest";
  sort?: "updated" | "downloads" | "recommended" | "installs" | "trending";
  packageIndex?: "family-official-downloads";
};
const PUBLIC_PAGE_CURSOR_PREFIX = "pkgpage:";
type OfficialFirstPackageCategoryCursorState = {
  phase: "official" | "community";
  cursor: string | null;
};
type PublicPackageListPage = {
  page: PublicPackageListItem[];
  isDone: boolean;
  continueCursor: string;
};
const STABLE_PACKAGE_DISCOVERY_CURSOR_PREFIX = "pkgstable:";
type StablePackageFamily = (typeof STABLE_PACKAGE_FAMILIES)[number];
type StablePackageDiscoverySourceState = { key: IndexKey | null; done: boolean };
type StablePackageDiscoveryCursorState = {
  sort: "updated" | "created" | "downloads" | "recommended" | "installs";
  sources: Record<StablePackageFamily, StablePackageDiscoverySourceState>;
};
const OFFICIAL_FIRST_PACKAGE_CATEGORY_CURSOR_PREFIX = "pkgofficialfirst:";

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

async function runActionRef<T>(
  ctx: { runAction: (ref: never, args: never) => Promise<unknown> },
  ref: unknown,
  args: unknown,
): Promise<T> {
  return (await ctx.runAction(ref as never, args as never)) as T;
}

// The moderation scan decodes every package file; large ClawPacks exceed the
// Convex runtime's 64 MiB action ceiling, so it runs in the Node runtime.
async function runStaticPublishScanInNode(
  ctx: { runAction: (ref: never, args: never) => Promise<unknown> },
  input: {
    slug: string;
    displayName: string;
    summary?: string;
    metadata?: unknown;
    files: ReadonlyArray<{ path: string; size: number; storageId: string; contentType?: string }>;
  },
): Promise<StaticScanResult> {
  return await runActionRef<StaticScanResult>(
    ctx,
    internalRefs.staticPublishScanNode.runStaticPublishScanInternal,
    stripUndefinedForStoredAttempt({
      slug: input.slug,
      displayName: input.displayName,
      summary: input.summary,
      // JSON string, not a Convex object: manifests carry `$schema` keys, which
      // Convex values reject, and the scan must see the metadata unchanged.
      metadataJson: input.metadata === undefined ? undefined : JSON.stringify(input.metadata),
      files: input.files.map(({ path, size, storageId, contentType }) => ({
        path,
        size,
        storageId: storageId as Id<"_storage">,
        contentType,
      })),
    }),
  );
}

async function runAfterRef(
  ctx: {
    scheduler: {
      runAfter: (delayMs: number, ref: never, args: never) => Promise<unknown>;
    };
  },
  delayMs: number,
  ref: unknown,
  args: unknown,
) {
  return await ctx.scheduler.runAfter(delayMs, ref as never, args as never);
}

type PublicPackageDoc = {
  _id: Id<"packages">;
  name: string;
  displayName: string;
  family: PackageFamily;
  clawProfilePolicyVersion?: 1;
  channel: PackageChannel;
  isOfficial: boolean;
  runtimeId?: string;
  summary?: string;
  icon: string | null;
  tags: Record<string, Id<"packageReleases">>;
  latestReleaseId?: Id<"packageReleases">;
  latestVersion?: string | null;
  categories?: string[];
  topics?: string[];
  compatibility?: Doc<"packages">["compatibility"];
  verification?: Doc<"packages">["verification"];
  artifact?: PackageArtifactSummary;
  clawManifestSummary?: Doc<"packageReleases">["clawManifestSummary"];
  scanStatus?: Doc<"packages">["scanStatus"];
  stats: Doc<"packages">["stats"];
  createdAt: number;
  updatedAt: number;
};

type DashboardPackageListItem = {
  _id: Id<"packages">;
  name: string;
  displayName: string;
  family: PackageFamily;
  channel: PackageChannel;
  isOfficial: boolean;
  runtimeId: string | null;
  sourceRepo: string | null;
  summary: string | null;
  categories?: string[];
  topics?: string[];
  ownerUserId: Id<"users">;
  ownerPublisherId?: Id<"publishers">;
  latestVersion: string | null;
  inspectorWarningCount: number;
  topInspectorFinding?: {
    message: string;
    remediation?: string;
  };
  stats: Doc<"packages">["stats"];
  verification: Doc<"packages">["verification"];
  scanStatus: Doc<"packages">["scanStatus"];
  createdAt: number;
  updatedAt: number;
  pendingReview?: true;
  latestRelease: {
    version: string;
    createdAt: number;
    vtStatus: string | null;
    llmStatus: string | null;
    staticScanStatus: "clean" | "suspicious" | "malicious" | null;
  } | null;
};

function requiresPrivilegedPackageAccess(
  digest: Pick<PackageDigestLike, "channel" | "scanStatus">,
) {
  return digest.channel === "private" || isPackageBlockedFromPublic(digest.scanStatus);
}

async function viewerCanAccessPackageOwner(
  ctx: DbReaderCtx,
  digest: PackageOwnerAccessRef,
  viewerUserId: Id<"users"> | undefined,
  membershipCache?: Map<string, Promise<boolean>>,
) {
  if (!viewerUserId) return false;
  if (!digest.ownerPublisherId) return digest.ownerUserId === viewerUserId;

  const ownerPublisherId = digest.ownerPublisherId;
  const cacheKey = `${ownerPublisherId}:${digest.ownerUserId}`;
  const cached = membershipCache?.get(cacheKey);
  if (cached) return await cached;

  const membershipPromise = (async () => {
    const ownerPublisher = await ctx.db.get(ownerPublisherId);
    return await canAccessPublisherOwnerScope(ctx, {
      publisher: ownerPublisher,
      userId: viewerUserId,
      legacyOwnerUserId: digest.ownerUserId,
    });
  })();
  membershipCache?.set(cacheKey, membershipPromise);
  return await membershipPromise;
}

async function viewerCanManagePackageOwner(
  ctx: DbReaderCtx,
  digest: PackageOwnerAccessRef,
  viewerUserId: Id<"users"> | undefined,
) {
  if (!viewerUserId) return false;
  if (!digest.ownerPublisherId) return digest.ownerUserId === viewerUserId;

  const ownerPublisher = await ctx.db.get(digest.ownerPublisherId);
  return await canAccessPublisherOwnerScope(ctx, {
    publisher: ownerPublisher,
    userId: viewerUserId,
    allowedPublisherRoles: ["admin"],
    legacyOwnerUserId: digest.ownerUserId,
  });
}

async function canViewerReadPackage(
  ctx: DbReaderCtx,
  digest: Pick<PackageDigestLike, "channel" | "scanStatus" | "ownerUserId" | "ownerPublisherId"> &
    Partial<Pick<PackageDigestLike, "ownerKind">>,
  viewerUserId: Id<"users"> | undefined,
  membershipCache?: Map<string, Promise<boolean>>,
) {
  if (!requiresPrivilegedPackageAccess(digest)) return true;
  const isPrivilegedViewer = await viewerCanAccessPackageOwner(
    ctx,
    digest,
    viewerUserId,
    membershipCache,
  );
  return (
    (digest.channel !== "private" || isPrivilegedViewer) &&
    (!isPackageBlockedFromPublic(digest.scanStatus) || isPrivilegedViewer)
  );
}

function resolvePublicPackageScanStatus(
  pkg: Pick<Doc<"packages">, "scanStatus">,
  latestRelease?: Doc<"packageReleases"> | null,
) {
  if (latestRelease && !latestRelease.softDeletedAt) {
    const releaseScanStatus = resolvePackageReleaseScanStatus(latestRelease);
    return releaseScanStatus === "not-run" ? pkg.scanStatus : releaseScanStatus;
  }
  return pkg.scanStatus;
}

function isPublishedPackageRelease(
  release: Doc<"packageReleases"> | null | undefined,
): release is Doc<"packageReleases"> {
  return Boolean(
    release &&
    !release.softDeletedAt &&
    release.ownerDeletedAt === undefined &&
    (release.publicationStatus === undefined || release.publicationStatus === "published"),
  );
}

function hasNoPublishedPackageVersions(
  pkg: Pick<Doc<"packages">, "latestReleaseId" | "latestVersionSummary" | "stats">,
) {
  return !pkg.latestReleaseId && !pkg.latestVersionSummary && (pkg.stats?.versions ?? 0) <= 0;
}

function normalizePublicPackageSourcePath(sourcePath: unknown) {
  if (typeof sourcePath !== "string") return undefined;
  const trimmed = sourcePath.trim();
  if (!trimmed || trimmed === ".") return undefined;
  return trimmed.replace(/^\/+/, "").replace(/\/+$/, "") || undefined;
}

function getReleaseSourcePath(release?: Pick<Doc<"packageReleases">, "source"> | null) {
  const source = release?.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  return normalizePublicPackageSourcePath((source as { path?: unknown }).path);
}

function resolvePublicPackageVerification(
  pkg: Pick<Doc<"packages">, "verification" | "latestVersionSummary" | "scanStatus">,
  latestRelease?: Doc<"packageReleases"> | null,
) {
  const scanStatus = resolvePublicPackageScanStatus(pkg, latestRelease);
  const source = pkg.verification ?? pkg.latestVersionSummary?.verification;
  if (!source) return source;
  const sourcePath = source.sourcePath ?? getReleaseSourcePath(latestRelease);
  const verification = sourcePath ? { ...source, sourcePath } : source;
  return scanStatus ? { ...verification, scanStatus } : verification;
}

function toPublicPackage(
  pkg: Doc<"packages"> | null | undefined,
  latestRelease?: Doc<"packageReleases"> | null,
): PublicPackageDoc | null {
  if (!pkg || pkg.softDeletedAt) return null;
  if (hasNoPublishedPackageVersions(pkg)) return null;
  if (
    latestRelease !== undefined &&
    latestRelease &&
    (latestRelease.publicationStatus === "pending" || latestRelease.publicationStatus === "blocked")
  ) {
    return null;
  }
  const latestVersion =
    latestRelease === undefined
      ? (pkg.latestVersionSummary?.version ?? null)
      : isPublishedPackageRelease(latestRelease)
        ? latestRelease.version
        : null;
  const scanStatus = resolvePublicPackageScanStatus(pkg, latestRelease);
  return {
    _id: pkg._id,
    name: pkg.name,
    displayName: pkg.displayName,
    family: pkg.family,
    clawProfilePolicyVersion: pkg.clawProfilePolicyVersion,
    channel: pkg.channel,
    isOfficial: pkg.isOfficial,
    runtimeId: pkg.runtimeId,
    summary: pkg.summary,
    icon: pkg.icon ?? null,
    tags: pkg.tags,
    latestReleaseId: pkg.latestReleaseId,
    latestVersion,
    categories: pkg.categories,
    topics: pkg.topics,
    compatibility: pkg.compatibility,
    verification: resolvePublicPackageVerification(pkg, latestRelease),
    artifact:
      latestRelease === undefined
        ? pkg.latestVersionSummary?.artifact
        : isPublishedPackageRelease(latestRelease)
          ? packageArtifactSummary(latestRelease)
          : undefined,
    clawManifestSummary:
      pkg.family === "claw" && isPublishedPackageRelease(latestRelease)
        ? latestRelease.clawManifestSummary
        : undefined,
    scanStatus,
    stats: pkg.stats,
    createdAt: pkg.createdAt,
    updatedAt: pkg.updatedAt,
  };
}

function toPublicPackageRelease(release: Doc<"packageReleases">, family: PackageFamily) {
  // Package family owns this boundary; optional release metadata must not select a looser projection.
  if (family === "claw") {
    const sourcePath = release.verification?.sourcePath ?? getReleaseSourcePath(release);
    return {
      _id: release._id,
      packageId: release.packageId,
      version: release.version,
      changelog: release.changelog,
      summary: release.summary,
      icon: release.icon,
      distTags: release.distTags,
      files: release.files.map((file) => ({
        path: file.path,
        size: file.size,
        sha256: file.sha256,
        contentType: file.contentType,
      })),
      integritySha256: release.integritySha256,
      artifactKind: release.artifactKind,
      clawpackSha256: release.clawpackSha256,
      clawpackSize: release.clawpackSize,
      clawpackFormat: release.clawpackFormat,
      npmIntegrity: release.npmIntegrity,
      npmShasum: release.npmShasum,
      npmTarballName: release.npmTarballName,
      npmUnpackedSize: release.npmUnpackedSize,
      npmFileCount: release.npmFileCount,
      clawManifestSummary: release.clawManifestSummary,
      compatibility: release.compatibility,
      runtimeId: release.runtimeId,
      sourceRepo: release.sourceRepo,
      verification:
        release.verification && sourcePath
          ? { ...release.verification, sourcePath }
          : release.verification,
      sha256hash: release.sha256hash,
      vtAnalysis: release.vtAnalysis,
      aigAnalysis: release.aigAnalysis,
      skillSpectorAnalysis: release.skillSpectorAnalysis,
      llmAnalysis: release.llmAnalysis,
      staticScan: release.staticScan,
      createdAt: release.createdAt,
    };
  }
  const {
    capabilities: _capabilities,
    clawManifestSummary: _clawManifestSummary,
    extractedClawManifest: _extractedClawManifest,
    ...publicRelease
  } = release as Doc<"packageReleases"> & {
    capabilities?: unknown;
    extractedClawManifest?: unknown;
  };
  const sourcePath = release.verification?.sourcePath ?? getReleaseSourcePath(release);
  if (!release.verification || !sourcePath) return publicRelease;
  return {
    ...publicRelease,
    verification: {
      ...release.verification,
      sourcePath,
    },
  };
}

function toManagerPackageRelease(release: Doc<"packageReleases">, family: PackageFamily) {
  return {
    ...toPublicPackageRelease(release, family),
    softDeletedAt: release.softDeletedAt,
    ownerDeletedAt: release.ownerDeletedAt,
  };
}

async function paginatePublishedPackageReleases(
  ctx: QueryCtx,
  packageId: Id<"packages">,
  paginationOpts: { cursor: string | null; numItems: number },
) {
  const targetCount = Math.max(1, Math.min(paginationOpts.numItems, MAX_PUBLIC_LIST_PAGE_SIZE));
  const page: Doc<"packageReleases">[] = [];
  let cursor = paginationOpts.cursor;
  let isDone = false;
  let continueCursor = "";
  let remainingScanBudget = Math.max(
    targetCount,
    Math.min(
      MAX_PUBLIC_LIST_FILTER_SCAN_DOCUMENTS,
      targetCount * MAX_PUBLIC_LIST_FILTER_SCAN_PAGES,
    ),
  );

  for (let scanPages = 0; scanPages < MAX_PUBLIC_LIST_FILTER_SCAN_PAGES; scanPages += 1) {
    if (page.length >= targetCount || isDone || remainingScanBudget <= 0) break;
    const pageSize = Math.min(remainingScanBudget, targetCount - page.length);
    const result = await ctx.db
      .query("packageReleases")
      .withIndex("by_package_active_created", (q) =>
        q.eq("packageId", packageId).eq("softDeletedAt", undefined),
      )
      .order("desc")
      .paginate({ cursor, numItems: pageSize });
    remainingScanBudget -= pageSize;
    cursor = result.continueCursor;
    continueCursor = result.continueCursor;
    isDone = result.isDone;
    for (const release of result.page) {
      if (isPublishedPackageRelease(release)) {
        page.push(release);
        if (page.length >= targetCount) break;
      }
    }
    if (result.page.length === 0) break;
  }

  return { page, isDone, continueCursor: isDone ? "" : continueCursor };
}

function packageArtifactSummary(
  release: Pick<
    Doc<"packageReleases">,
    | "artifactKind"
    | "clawpackSha256"
    | "sha256hash"
    | "clawpackSize"
    | "clawpackFormat"
    | "npmIntegrity"
    | "npmShasum"
    | "npmTarballName"
    | "npmUnpackedSize"
    | "npmFileCount"
  >,
): PackageArtifactSummary {
  if (release.artifactKind === "npm-pack") {
    return {
      kind: "npm-pack",
      sha256: getPackageReleaseArtifactSha256(release) ?? undefined,
      size: release.clawpackSize,
      format: release.clawpackFormat ?? "tgz",
      npmIntegrity: release.npmIntegrity,
      npmShasum: release.npmShasum,
      npmTarballName: release.npmTarballName,
      npmUnpackedSize: release.npmUnpackedSize,
      npmFileCount: release.npmFileCount,
    };
  }
  return {
    kind: "legacy-zip",
    sha256: getPackageReleaseArtifactSha256(release) ?? undefined,
    format: "zip",
  };
}

function digestMatchesFilters(
  digest: PackageDigestLike,
  args: {
    category?: string;
    topic?: string;
    createdAfter?: number;
    excludedScanStatuses?: PackageListScanStatus[];
  },
) {
  if (!isClawFamilyPubliclyVisible(digest.family)) return false;
  if (digest.scanStatus && args.excludedScanStatuses?.includes(digest.scanStatus)) return false;
  if (args.category) {
    if (digest.pluginCategory) {
      if (digest.pluginCategory !== args.category) return false;
    } else if (!(digest.pluginCategoryTags ?? []).includes(args.category)) {
      return false;
    }
  }
  if (args.topic && !getCatalogTopicSlugs(digest.topics).includes(args.topic)) {
    return false;
  }
  if (args.createdAfter !== undefined && digest.createdAt < args.createdAfter) return false;
  return true;
}

function digestMatchesSearchFilters(
  digest: PackageDigestLike,
  args: {
    family?: PackageFamily;
    families?: PackageFamily[];
    channel?: PackageChannel;
    isOfficial?: boolean;
    category?: string;
    topic?: string;
    createdAfter?: number;
    excludedScanStatuses?: PackageListScanStatus[];
  },
) {
  if (args.family && digest.family !== args.family) return false;
  if (args.families?.length && !args.families.includes(digest.family)) return false;
  if (args.channel && digest.channel !== args.channel) return false;
  if (typeof args.isOfficial === "boolean" && digest.isOfficial !== args.isOfficial) {
    return false;
  }
  return digestMatchesFilters(digest, args);
}

function packageMatchesListFilters(
  pkg: Doc<"packages">,
  args: {
    family?: PackageFamily;
    channel?: PackageChannel;
    isOfficial?: boolean;
    category?: string;
    topic?: string;
    excludedScanStatuses?: PackageListScanStatus[];
  },
) {
  if (!isClawFamilyPubliclyVisible(pkg.family)) return false;
  if (pkg.scanStatus && args.excludedScanStatuses?.includes(pkg.scanStatus)) return false;
  if (args.family && pkg.family !== args.family) return false;
  if (args.channel && pkg.channel !== args.channel) return false;
  if (typeof args.isOfficial === "boolean" && pkg.isOfficial !== args.isOfficial) return false;
  if (args.category) {
    if (!(pkg.categories ?? []).includes(args.category)) return false;
  }
  if (args.topic && !getCatalogTopicSlugs(pkg.topics).includes(args.topic)) return false;
  return true;
}

async function upsertPackageBadge(
  ctx: MutationCtx,
  packageId: Id<"packages">,
  kind: PackageBadgeKind,
  userId: Id<"users">,
  at: number,
) {
  const existing = await ctx.db
    .query("packageBadges")
    .withIndex("by_package_kind", (q) => q.eq("packageId", packageId).eq("kind", kind))
    .unique();
  if (existing) {
    await ctx.db.patch(existing._id, { byUserId: userId, at });
    return;
  }
  await ctx.db.insert("packageBadges", {
    packageId,
    kind,
    byUserId: userId,
    at,
  });
}

async function removePackageBadge(
  ctx: MutationCtx,
  packageId: Id<"packages">,
  kind: PackageBadgeKind,
) {
  const existing = await ctx.db
    .query("packageBadges")
    .withIndex("by_package_kind", (q) => q.eq("packageId", packageId).eq("kind", kind))
    .unique();
  if (existing) await ctx.db.delete(existing._id);
}

function defaultPackageStats(): Doc<"packages">["stats"] {
  return { downloads: 0, installs: 0, stars: 0, versions: 0 };
}

async function resolvePackageListStats(
  ctx: DbReaderCtx,
  digest: PackageDigestLike,
): Promise<Doc<"packages">["stats"]> {
  const pkg = await ctx.db.get(digest.packageId);
  return pkg?.stats ?? digest.stats ?? defaultPackageStats();
}

async function toPublicPackageListItem(
  ctx: DbReaderCtx,
  digest: PackageDigestLike,
  featuredAt?: number,
): Promise<PublicPackageListItem> {
  return {
    name: digest.name,
    displayName: digest.displayName,
    family: digest.family,
    runtimeId: digest.runtimeId ?? null,
    channel: digest.channel,
    isOfficial: digest.isOfficial,
    summary: digest.summary ?? null,
    icon: digest.icon ?? null,
    ownerHandle: digest.ownerHandle || null,
    createdAt: digest.createdAt,
    updatedAt: digest.updatedAt,
    latestVersion: digest.latestVersion ?? null,
    categories: digest.categories,
    topics: digest.topics,
    ...(featuredAt === undefined ? {} : { featuredAt }),
    verificationTier: digest.verificationTier ?? null,
    stats: await resolvePackageListStats(ctx, digest),
  };
}

async function toPublicPackageListItemFromPackage(
  ctx: DbReaderCtx,
  pkg: Doc<"packages">,
): Promise<PublicPackageListItem> {
  const catalogMetadata =
    pkg.family === "code-plugin" || pkg.family === "bundle-plugin"
      ? extractPackageDigestFields(pkg)
      : pkg;
  const owner = toPublicPublisher(
    await getOwnerPublisher(ctx, {
      ownerPublisherId: pkg.ownerPublisherId,
      ownerUserId: pkg.ownerUserId,
    }),
  );
  return {
    name: pkg.name,
    displayName: pkg.displayName,
    family: pkg.family,
    runtimeId: pkg.runtimeId ?? null,
    channel: pkg.channel,
    isOfficial: pkg.isOfficial,
    summary: pkg.summary ?? null,
    icon: pkg.icon ?? null,
    ownerHandle: owner?.handle ?? null,
    createdAt: pkg.createdAt,
    updatedAt: pkg.updatedAt,
    latestVersion: pkg.latestVersionSummary?.version ?? null,
    categories: catalogMetadata.categories,
    topics: catalogMetadata.topics,
    verificationTier: pkg.verification?.tier ?? null,
    stats: pkg.stats,
  };
}

async function toDashboardPackageListItem(
  ctx: DbReaderCtx,
  pkg: Doc<"packages">,
  _viewerUserId: Id<"users">,
): Promise<DashboardPackageListItem | null> {
  if (pkg.softDeletedAt) return null;
  const latestRelease = pkg.latestReleaseId ? await ctx.db.get(pkg.latestReleaseId) : null;
  const inspectorAttention = await getInspectorAttentionForRelease(ctx, pkg.latestReleaseId);
  return {
    _id: pkg._id,
    name: pkg.name,
    displayName: pkg.displayName,
    family: pkg.family,
    channel: pkg.channel,
    isOfficial: pkg.isOfficial,
    runtimeId: pkg.runtimeId ?? null,
    sourceRepo: pkg.sourceRepo ?? null,
    summary: pkg.summary ?? null,
    ownerUserId: pkg.ownerUserId,
    ownerPublisherId: pkg.ownerPublisherId,
    latestVersion: pkg.latestVersionSummary?.version ?? null,
    inspectorWarningCount: inspectorAttention.count,
    topInspectorFinding: inspectorAttention.topFinding,
    stats: pkg.stats,
    verification: pkg.verification,
    scanStatus: pkg.scanStatus,
    createdAt: pkg.createdAt,
    updatedAt: pkg.updatedAt,
    pendingReview: pkg.scanStatus === "pending" ? true : undefined,
    latestRelease:
      latestRelease && !latestRelease.softDeletedAt
        ? {
            version: latestRelease.version,
            createdAt: latestRelease.createdAt,
            vtStatus: latestRelease.vtAnalysis?.status ?? null,
            llmStatus: latestRelease.llmAnalysis?.status ?? null,
            staticScanStatus: latestRelease.staticScan?.status ?? null,
          }
        : null,
  };
}

async function getInspectorAttentionForRelease(
  ctx: DbReaderCtx,
  latestReleaseId?: Id<"packageReleases">,
): Promise<{
  count: number;
  topFinding?: {
    message: string;
    remediation?: string;
  };
}> {
  if (!latestReleaseId) return { count: 0 };
  const findings = await takeAuthorRemediationWarningsByRelease(ctx, latestReleaseId, 101);
  const count = findings.length > 100 ? 100 : findings.length;
  const top = findings[0];
  if (!top) return { count };
  const remediation = top.authorRemediation?.summary?.trim();
  return {
    count,
    topFinding: {
      message: top.message,
      remediation: remediation || undefined,
    },
  };
}

async function listDashboardPackagesForOwnerPublisher(
  ctx: QueryCtx,
  ownerPublisherId: Id<"publishers">,
  viewerUserId: Id<"users">,
  limit: number,
) {
  const takeLimit = Math.min(limit * 5, 500);
  const ownerPublisher = await ctx.db.get(ownerPublisherId);
  const owner =
    ownerPublisher?.kind === "user" && !ownerPublisher.linkedUserId
      ? await ctx.db.get(viewerUserId)
      : null;
  const isOwnDashboard =
    (await canAccessPublisherOwnerScope(ctx, {
      publisher: ownerPublisher,
      userId: viewerUserId,
    })) ||
    (ownerPublisher?.kind === "user" &&
      isPublisherActive(ownerPublisher) &&
      !ownerPublisher.linkedUserId &&
      owner?.personalPublisherId === ownerPublisherId);
  if (!isOwnDashboard) return [];

  const scopedEntries = await ctx.db
    .query("packages")
    .withIndex("by_owner_publisher", (q) => q.eq("ownerPublisherId", ownerPublisherId))
    .order("desc")
    .take(takeLimit);
  const legacyPersonalOwnerUserId =
    ownerPublisher?.kind === "user"
      ? (ownerPublisher.linkedUserId ?? (isOwnDashboard ? viewerUserId : undefined))
      : undefined;
  const legacyEntries = legacyPersonalOwnerUserId
    ? await ctx.db
        .query("packages")
        .withIndex("by_owner", (q) => q.eq("ownerUserId", legacyPersonalOwnerUserId))
        .order("desc")
        .take(takeLimit)
    : [];

  const combined = [...scopedEntries, ...legacyEntries].filter(
    (pkg, index, all) =>
      !pkg.softDeletedAt &&
      (!pkg.ownerPublisherId || pkg.ownerPublisherId === ownerPublisherId) &&
      all.findIndex((candidate) => candidate._id === pkg._id) === index,
  );
  const limited = combined.slice(0, limit);
  return (
    await Promise.all(
      limited.map(async (pkg) => await toDashboardPackageListItem(ctx, pkg, viewerUserId)),
    )
  ).filter((pkg): pkg is DashboardPackageListItem => Boolean(pkg));
}

async function packageBelongsToOwnerUserDashboardScope(
  ctx: Pick<QueryCtx, "db">,
  pkg: Pick<Doc<"packages">, "ownerUserId" | "ownerPublisherId">,
  ownerUserId: Id<"users">,
) {
  if (pkg.ownerUserId !== ownerUserId) return false;
  if (!pkg.ownerPublisherId) return true;
  const ownerPublisher = await ctx.db.get(pkg.ownerPublisherId);
  if (!ownerPublisher || !isPublisherActive(ownerPublisher) || ownerPublisher.kind !== "user") {
    return false;
  }
  return ownerPublisher.linkedUserId ? ownerPublisher.linkedUserId === ownerUserId : true;
}

async function filterPackagesForOwnerUserDashboard(
  ctx: Pick<QueryCtx, "db">,
  packages: Doc<"packages">[],
  ownerUserId: Id<"users">,
) {
  const scoped = await Promise.all(
    packages.map(async (pkg) =>
      (await packageBelongsToOwnerUserDashboardScope(ctx, pkg, ownerUserId)) ? pkg : null,
    ),
  );
  return scoped.filter((pkg): pkg is Doc<"packages"> => Boolean(pkg));
}

async function listDashboardPackagesForOwnerUser(
  ctx: QueryCtx,
  ownerUserId: Id<"users">,
  viewerUserId: Id<"users">,
  limit: number,
) {
  if (ownerUserId !== viewerUserId) return [];
  const takeLimit = Math.min(limit * 5, 500);
  const entries = await ctx.db
    .query("packages")
    .withIndex("by_owner", (q) => q.eq("ownerUserId", ownerUserId))
    .order("desc")
    .take(takeLimit);
  const scoped = await filterPackagesForOwnerUserDashboard(ctx, entries, ownerUserId);
  const filtered = scoped.filter((pkg) => !pkg.softDeletedAt).slice(0, limit);
  return (
    await Promise.all(
      filtered.map(async (pkg) => await toDashboardPackageListItem(ctx, pkg, viewerUserId)),
    )
  ).filter((pkg): pkg is DashboardPackageListItem => Boolean(pkg));
}

function encodePublicPageCursor(state: PublicPageCursorState) {
  if (state.done && state.offset === 0) return "";
  return `${PUBLIC_PAGE_CURSOR_PREFIX}${JSON.stringify(state)}`;
}

function decodePublicPageCursor(raw: string | null | undefined): PublicPageCursorState {
  if (!raw) return { cursor: null, offset: 0, pageSize: null, done: false };
  if (!raw.startsWith(PUBLIC_PAGE_CURSOR_PREFIX)) {
    return { cursor: raw, offset: 0, pageSize: null, done: false };
  }
  try {
    const parsed = JSON.parse(
      raw.slice(PUBLIC_PAGE_CURSOR_PREFIX.length),
    ) as Partial<PublicPageCursorState>;
    return {
      cursor: typeof parsed.cursor === "string" ? parsed.cursor : null,
      offset: typeof parsed.offset === "number" && parsed.offset > 0 ? parsed.offset : 0,
      pageSize: typeof parsed.pageSize === "number" && parsed.pageSize > 0 ? parsed.pageSize : null,
      done: parsed.done === true,
      mode: parsed.mode === "packages" || parsed.mode === "digest" ? parsed.mode : undefined,
      sort:
        parsed.sort === "updated" ||
        parsed.sort === "downloads" ||
        parsed.sort === "recommended" ||
        parsed.sort === "installs" ||
        parsed.sort === "trending"
          ? parsed.sort
          : undefined,
      packageIndex:
        parsed.packageIndex === "family-official-downloads" ? parsed.packageIndex : undefined,
    };
  } catch {
    return { cursor: null, offset: 0, pageSize: null, done: false };
  }
}

function encodeOfficialFirstPackageCategoryCursor(state: OfficialFirstPackageCategoryCursorState) {
  return `${OFFICIAL_FIRST_PACKAGE_CATEGORY_CURSOR_PREFIX}${JSON.stringify(state)}`;
}

function decodeOfficialFirstPackageCategoryCursor(
  raw: string | null | undefined,
): OfficialFirstPackageCategoryCursorState {
  if (!raw) return { phase: "official", cursor: null };
  if (!raw.startsWith(OFFICIAL_FIRST_PACKAGE_CATEGORY_CURSOR_PREFIX)) {
    return { phase: "community", cursor: raw };
  }
  try {
    const parsed = JSON.parse(
      raw.slice(OFFICIAL_FIRST_PACKAGE_CATEGORY_CURSOR_PREFIX.length),
    ) as Partial<OfficialFirstPackageCategoryCursorState>;
    return {
      phase: parsed.phase === "community" ? "community" : "official",
      cursor: typeof parsed.cursor === "string" ? parsed.cursor : null,
    };
  } catch {
    return { phase: "official", cursor: null };
  }
}

async function getOptionalViewerUserId(ctx: QueryCtx | MutationCtx) {
  return await getOptionalActiveAuthUserId(ctx);
}

const EXPLORATORY_SEARCH_MIN_TOKEN_LENGTH = 3;

type PackageSearchMatch = {
  rankTier: number;
  score: number;
};

function packageSearchMatch(
  digest: PackageDigestLike,
  queryText: string,
): PackageSearchMatch | null {
  const needle = queryText.toLowerCase();
  const queryTokens = tokenize(queryText);
  if (queryTokens.length === 0) return null;
  const normalized = digest.normalizedName.toLowerCase();
  const display = digest.displayName.toLowerCase();
  const runtimeId = digest.runtimeId?.toLowerCase() ?? "";
  const ownerHandle = digest.ownerHandle?.toLowerCase() ?? "";
  const nameTokens = tokenize(normalized);
  const displayTokens = tokenize(display);
  const runtimeTokens = tokenize(runtimeId);
  const ownerHandleTokens = tokenize(ownerHandle);
  let score = 0;
  let rankTier = Number.POSITIVE_INFINITY;

  const setMatch = (tier: number, boost: number) => {
    score += boost;
    rankTier = Math.min(rankTier, tier);
  };

  if (normalized === needle) setMatch(0, 200);
  else if (normalized.startsWith(needle)) setMatch(1, 120);
  else if (normalized.includes(needle)) setMatch(1, 80);

  if (display === needle) setMatch(0, 150);
  else if (display.startsWith(needle)) setMatch(1, 70);
  else if (display.includes(needle)) setMatch(1, 40);

  if (runtimeId === needle) setMatch(0, 180);
  else if (runtimeId.startsWith(needle)) setMatch(1, 90);
  else if (runtimeId.includes(needle)) setMatch(1, 45);

  if (ownerHandle === needle || `@${ownerHandle}` === needle) setMatch(1, 60);
  else if (ownerHandle.startsWith(needle) || `@${ownerHandle}`.startsWith(needle)) setMatch(1, 35);
  else if (ownerHandle.includes(needle)) setMatch(1, 20);

  if (
    matchesAllTokens(
      queryTokens,
      [...nameTokens, ...displayTokens, ...runtimeTokens, ...ownerHandleTokens],
      (a, b) => a === b,
    )
  ) {
    setMatch(1, 65);
  } else if (
    matchesAllTokens(
      queryTokens,
      [...nameTokens, ...displayTokens, ...runtimeTokens, ...ownerHandleTokens],
      (a, b) => a.startsWith(b),
    )
  ) {
    setMatch(1, 35);
  }

  const taxonomyQuery = normalizeCatalogTopic(queryText);
  const categories = (digest.pluginCategoryTags ?? []).filter(
    (category) => category !== INTERNAL_UNCATEGORIZED_CATEGORY,
  );
  const topicSlugs = getCatalogTopicSlugs(digest.topics);
  if (taxonomyQuery && (categories.includes(taxonomyQuery) || topicSlugs.includes(taxonomyQuery))) {
    setMatch(2, 25);
  }
  if (
    matchesExploratoryTokenPrefixes(
      queryTokens,
      [...categories, ...(digest.topics ?? [])],
      EXPLORATORY_SEARCH_MIN_TOKEN_LENGTH,
    )
  ) {
    setMatch(2, 20);
  }

  if (
    matchesExploratoryTokenPrefixes(
      queryTokens,
      [digest.summary],
      EXPLORATORY_SEARCH_MIN_TOKEN_LENGTH,
    )
  ) {
    setMatch(3, 20);
  }
  if (!Number.isFinite(rankTier)) return null;
  return { rankTier, score };
}

function packageTrustSignals(pkg: {
  isOfficial: boolean;
  featuredAt?: number;
  verificationTier?: PackageDigestLike["verificationTier"] | null;
  stats?: { downloads: number; installs: number; stars: number } | null;
}): SearchTrustSignals {
  return {
    isOfficial: pkg.isOfficial,
    featured: typeof pkg.featuredAt === "number",
    verificationTier: pkg.verificationTier,
    downloads: pkg.stats?.downloads,
    installs: pkg.stats?.installs,
  };
}

function comparePackageSearchMatches<
  T extends PackageSearchMatch & {
    package: {
      isOfficial: boolean;
      featuredAt?: number;
      updatedAt: number;
      verificationTier?: PackageDigestLike["verificationTier"] | null;
      stats?: { downloads: number; installs: number; stars: number } | null;
    };
  },
>(a: T, b: T) {
  return (
    compareRankedSearchKeys(
      rankedSearchKey(a, packageTrustSignals(a.package)),
      rankedSearchKey(b, packageTrustSignals(b.package)),
    ) ||
    Number(b.package.isOfficial) - Number(a.package.isOfficial) ||
    verificationRank(b.package.verificationTier) - verificationRank(a.package.verificationTier) ||
    (b.package.stats?.stars ?? 0) - (a.package.stats?.stars ?? 0) ||
    (b.package.stats?.installs ?? 0) - (a.package.stats?.installs ?? 0) ||
    (b.package.stats?.downloads ?? 0) - (a.package.stats?.downloads ?? 0) ||
    b.package.updatedAt - a.package.updatedAt
  );
}

function toPublicPackageSearchEntry(
  entry: PackageSearchMatch & { package: PublicPackageListItem },
) {
  return {
    score: entry.score,
    package: entry.package,
  };
}

function prefixUpperBound(value: string) {
  return `${value}\uffff`;
}

function maybeNormalizePackageQuery(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return normalizePackageName(trimmed);
  } catch {
    return null;
  }
}

async function resolveDirectPackageSearchDigests(
  ctx: DbReaderCtx,
  queryText: string,
  family?: PackageFamily,
): Promise<PackageDigestLike[]> {
  const normalizedQuery = maybeNormalizePackageQuery(queryText);
  const topicQuery = normalizeCatalogTopic(queryText);
  const categoryQuery =
    topicQuery !== INTERNAL_UNCATEGORIZED_CATEGORY && isPluginCategorySlug(topicQuery)
      ? topicQuery
      : undefined;
  const queryTokens = tokenize(queryText).filter((token) => token.length > 1);
  const runtimePrefix = queryTokens.length === 1 ? queryTokens[0] : queryText;
  const ownerHandlePrefix = queryTokens.length === 1 ? queryTokens[0] : null;
  const [
    nameDigests,
    runtimeDigests,
    displayNameDigests,
    ownerHandleDigests,
    exactTopicDigests,
    categoryDigests,
  ] = await Promise.all([
    normalizedQuery
      ? family
        ? ctx.db
            .query("packageSearchDigest")
            .withIndex("by_active_family_normalized_name", (q) =>
              q
                .eq("softDeletedAt", undefined)
                .eq("family", family)
                .gte("normalizedName", normalizedQuery)
                .lt("normalizedName", prefixUpperBound(normalizedQuery)),
            )
            .take(MAX_DIRECT_PACKAGE_SEARCH_CANDIDATES)
        : ctx.db
            .query("packageSearchDigest")
            .withIndex("by_active_normalized_name", (q) =>
              q
                .eq("softDeletedAt", undefined)
                .gte("normalizedName", normalizedQuery)
                .lt("normalizedName", prefixUpperBound(normalizedQuery)),
            )
            .take(MAX_DIRECT_PACKAGE_SEARCH_CANDIDATES)
      : Promise.resolve([]),
    runtimePrefix
      ? family
        ? ctx.db
            .query("packageSearchDigest")
            .withIndex("by_active_family_runtime_id", (q) =>
              q
                .eq("softDeletedAt", undefined)
                .eq("family", family)
                .gte("runtimeId", runtimePrefix)
                .lt("runtimeId", prefixUpperBound(runtimePrefix)),
            )
            .take(MAX_DIRECT_PACKAGE_SEARCH_CANDIDATES)
        : ctx.db
            .query("packageSearchDigest")
            .withIndex("by_active_runtime_id", (q) =>
              q
                .eq("softDeletedAt", undefined)
                .gte("runtimeId", runtimePrefix)
                .lt("runtimeId", prefixUpperBound(runtimePrefix)),
            )
            .take(MAX_DIRECT_PACKAGE_SEARCH_CANDIDATES)
      : Promise.resolve([]),
    ctx.db
      .query("packageSearchDigest")
      .withSearchIndex("search_by_display_name", (q) => {
        const search = q.search("displayName", queryText).eq("softDeletedAt", undefined);
        return family ? search.eq("family", family) : search;
      })
      .take(MAX_DIRECT_PACKAGE_FULL_TEXT_CANDIDATES),
    ownerHandlePrefix
      ? family
        ? ctx.db
            .query("packageSearchDigest")
            .withIndex("by_active_family_owner_handle", (q) =>
              q
                .eq("softDeletedAt", undefined)
                .eq("family", family)
                .gte("ownerHandle", ownerHandlePrefix)
                .lt("ownerHandle", prefixUpperBound(ownerHandlePrefix)),
            )
            .take(MAX_DIRECT_PACKAGE_SEARCH_CANDIDATES)
        : ctx.db
            .query("packageSearchDigest")
            .withIndex("by_active_owner_handle", (q) =>
              q
                .eq("softDeletedAt", undefined)
                .gte("ownerHandle", ownerHandlePrefix)
                .lt("ownerHandle", prefixUpperBound(ownerHandlePrefix)),
            )
            .take(MAX_DIRECT_PACKAGE_SEARCH_CANDIDATES)
      : Promise.resolve([]),
    topicQuery
      ? ctx.db
          .query("packageTopicSearchDigest")
          .withIndex(family ? "by_active_family_topic_updated" : "by_active_topic_updated", (q) =>
            family
              ? q.eq("softDeletedAt", undefined).eq("family", family).eq("topic", topicQuery)
              : q.eq("softDeletedAt", undefined).eq("topic", topicQuery),
          )
          .order("desc")
          .take(MAX_DIRECT_PACKAGE_SEARCH_CANDIDATES)
      : Promise.resolve([]),
    categoryQuery
      ? ctx.db
          .query("packagePluginCategorySearchDigest")
          .withIndex(
            family ? "by_active_family_category_updated" : "by_active_category_updated",
            (q) =>
              family
                ? q
                    .eq("softDeletedAt", undefined)
                    .eq("family", family)
                    .eq("pluginCategory", categoryQuery)
                : q.eq("softDeletedAt", undefined).eq("pluginCategory", categoryQuery),
          )
          .order("desc")
          .take(MAX_DIRECT_PACKAGE_SEARCH_CANDIDATES)
      : Promise.resolve([]),
  ]);
  const prefixTopicDigests =
    topicQuery && exactTopicDigests.length < MAX_DIRECT_PACKAGE_SEARCH_CANDIDATES
      ? await ctx.db
          .query("packageTopicSearchDigest")
          .withIndex(family ? "by_active_family_topic_updated" : "by_active_topic_updated", (q) =>
            family
              ? q
                  .eq("softDeletedAt", undefined)
                  .eq("family", family)
                  .gte("topic", topicQuery)
                  .lt("topic", prefixUpperBound(topicQuery))
              : q
                  .eq("softDeletedAt", undefined)
                  .gte("topic", topicQuery)
                  .lt("topic", prefixUpperBound(topicQuery)),
          )
          .order("desc")
          .take(MAX_DIRECT_PACKAGE_SEARCH_CANDIDATES - exactTopicDigests.length)
      : [];
  return [
    ...nameDigests,
    ...runtimeDigests,
    ...displayNameDigests,
    ...ownerHandleDigests,
    ...exactTopicDigests,
    ...prefixTopicDigests,
    ...categoryDigests,
  ].filter(
    (digest, index, all) =>
      all.findIndex((candidate) => candidate?.packageId === digest?.packageId) === index,
  ) as PackageDigestLike[];
}

function buildPackageDigestQuery(
  ctx: DbReaderCtx,
  args: {
    family?: PackageFamily;
    channel?: PackageChannel;
    isOfficial?: boolean;
  },
) {
  const family = args.family;
  const channel = args.channel;
  const isOfficial = args.isOfficial;

  if (family && channel) {
    return ctx.db
      .query("packageSearchDigest")
      .withIndex("by_active_family_channel_updated", (q) =>
        q.eq("softDeletedAt", undefined).eq("family", family).eq("channel", channel),
      );
  }
  if (family && typeof isOfficial === "boolean") {
    return ctx.db
      .query("packageSearchDigest")
      .withIndex("by_active_family_official_updated", (q) =>
        q.eq("softDeletedAt", undefined).eq("family", family).eq("isOfficial", isOfficial),
      );
  }
  if (family) {
    return ctx.db
      .query("packageSearchDigest")
      .withIndex("by_active_family_updated", (q) =>
        q.eq("softDeletedAt", undefined).eq("family", family),
      );
  }
  if (channel && typeof isOfficial === "boolean") {
    return ctx.db
      .query("packageSearchDigest")
      .withIndex("by_active_channel_official_updated", (q) =>
        q.eq("softDeletedAt", undefined).eq("channel", channel).eq("isOfficial", isOfficial),
      );
  }
  if (channel) {
    return ctx.db
      .query("packageSearchDigest")
      .withIndex("by_active_channel_updated", (q) =>
        q.eq("softDeletedAt", undefined).eq("channel", channel),
      );
  }
  if (typeof isOfficial === "boolean") {
    return ctx.db
      .query("packageSearchDigest")
      .withIndex("by_active_official_updated", (q) =>
        q.eq("softDeletedAt", undefined).eq("isOfficial", isOfficial),
      );
  }
  return ctx.db
    .query("packageSearchDigest")
    .withIndex("by_active_updated", (q) => q.eq("softDeletedAt", undefined));
}

function buildPackagePluginCategoryDigestQuery(
  ctx: DbReaderCtx,
  args: {
    category: PluginCategorySlug;
    family?: PackageFamily;
    channel?: PackageChannel;
    isOfficial?: boolean;
    sort?: "updated" | "downloads" | "recommended" | "installs" | "trending";
  },
) {
  const family = args.family;
  const channel = args.channel;
  const isOfficial = args.isOfficial;
  if (args.sort === "downloads") {
    if (family && channel && typeof isOfficial === "boolean") {
      return ctx.db
        .query("packagePluginCategorySearchDigest")
        .withIndex("by_active_family_channel_official_category_downloads", (q) =>
          q
            .eq("softDeletedAt", undefined)
            .eq("family", family)
            .eq("channel", channel)
            .eq("isOfficial", isOfficial)
            .eq("pluginCategory", args.category),
        );
    }
    if (family && channel) {
      return ctx.db
        .query("packagePluginCategorySearchDigest")
        .withIndex("by_active_family_channel_category_downloads", (q) =>
          q
            .eq("softDeletedAt", undefined)
            .eq("family", family)
            .eq("channel", channel)
            .eq("pluginCategory", args.category),
        );
    }
    if (family && typeof isOfficial === "boolean") {
      return ctx.db
        .query("packagePluginCategorySearchDigest")
        .withIndex("by_active_family_official_category_downloads", (q) =>
          q
            .eq("softDeletedAt", undefined)
            .eq("family", family)
            .eq("isOfficial", isOfficial)
            .eq("pluginCategory", args.category),
        );
    }
    if (channel && typeof isOfficial === "boolean") {
      return ctx.db
        .query("packagePluginCategorySearchDigest")
        .withIndex("by_active_channel_official_category_downloads", (q) =>
          q
            .eq("softDeletedAt", undefined)
            .eq("channel", channel)
            .eq("isOfficial", isOfficial)
            .eq("pluginCategory", args.category),
        );
    }
    if (family) {
      return ctx.db
        .query("packagePluginCategorySearchDigest")
        .withIndex("by_active_family_category_downloads", (q) =>
          q.eq("softDeletedAt", undefined).eq("family", family).eq("pluginCategory", args.category),
        );
    }
    if (channel) {
      return ctx.db
        .query("packagePluginCategorySearchDigest")
        .withIndex("by_active_channel_category_downloads", (q) =>
          q
            .eq("softDeletedAt", undefined)
            .eq("channel", channel)
            .eq("pluginCategory", args.category),
        );
    }
    if (typeof isOfficial === "boolean") {
      return ctx.db
        .query("packagePluginCategorySearchDigest")
        .withIndex("by_active_official_category_downloads", (q) =>
          q
            .eq("softDeletedAt", undefined)
            .eq("isOfficial", isOfficial)
            .eq("pluginCategory", args.category),
        );
    }
    return ctx.db
      .query("packagePluginCategorySearchDigest")
      .withIndex("by_active_category_downloads", (q) =>
        q.eq("softDeletedAt", undefined).eq("pluginCategory", args.category),
      );
  }
  if (args.sort === "installs") {
    if (family && typeof isOfficial === "boolean") {
      return ctx.db
        .query("packagePluginCategorySearchDigest")
        .withIndex("by_active_family_official_category_installs", (q) =>
          q
            .eq("softDeletedAt", undefined)
            .eq("family", family)
            .eq("isOfficial", isOfficial)
            .eq("pluginCategory", args.category),
        );
    }
    if (family) {
      return ctx.db
        .query("packagePluginCategorySearchDigest")
        .withIndex("by_active_family_category_installs", (q) =>
          q.eq("softDeletedAt", undefined).eq("family", family).eq("pluginCategory", args.category),
        );
    }
    if (typeof isOfficial === "boolean") {
      return ctx.db
        .query("packagePluginCategorySearchDigest")
        .withIndex("by_active_official_category_installs", (q) =>
          q
            .eq("softDeletedAt", undefined)
            .eq("isOfficial", isOfficial)
            .eq("pluginCategory", args.category),
        );
    }
    return ctx.db
      .query("packagePluginCategorySearchDigest")
      .withIndex("by_active_category_installs", (q) =>
        q.eq("softDeletedAt", undefined).eq("pluginCategory", args.category),
      );
  }
  if (args.sort === "recommended") {
    if (family && typeof isOfficial === "boolean") {
      return ctx.db
        .query("packagePluginCategorySearchDigest")
        .withIndex("by_active_family_official_category_recommended_score", (q) =>
          q
            .eq("softDeletedAt", undefined)
            .eq("family", family)
            .eq("isOfficial", isOfficial)
            .eq("pluginCategory", args.category),
        );
    }
    if (family) {
      return ctx.db
        .query("packagePluginCategorySearchDigest")
        .withIndex("by_active_family_category_recommended_score", (q) =>
          q.eq("softDeletedAt", undefined).eq("family", family).eq("pluginCategory", args.category),
        );
    }
    if (typeof isOfficial === "boolean") {
      return ctx.db
        .query("packagePluginCategorySearchDigest")
        .withIndex("by_active_official_category_recommended_score", (q) =>
          q
            .eq("softDeletedAt", undefined)
            .eq("isOfficial", isOfficial)
            .eq("pluginCategory", args.category),
        );
    }
    return ctx.db
      .query("packagePluginCategorySearchDigest")
      .withIndex("by_active_category_recommended_score", (q) =>
        q.eq("softDeletedAt", undefined).eq("pluginCategory", args.category),
      );
  }
  if (family && channel) {
    return ctx.db
      .query("packagePluginCategorySearchDigest")
      .withIndex("by_active_family_channel_category_updated", (q) =>
        q
          .eq("softDeletedAt", undefined)
          .eq("family", family)
          .eq("channel", channel)
          .eq("pluginCategory", args.category),
      );
  }
  if (family && typeof isOfficial === "boolean") {
    return ctx.db
      .query("packagePluginCategorySearchDigest")
      .withIndex("by_active_family_official_category_updated", (q) =>
        q
          .eq("softDeletedAt", undefined)
          .eq("family", family)
          .eq("isOfficial", isOfficial)
          .eq("pluginCategory", args.category),
      );
  }
  if (channel && typeof isOfficial === "boolean") {
    return ctx.db
      .query("packagePluginCategorySearchDigest")
      .withIndex("by_active_channel_official_category_updated", (q) =>
        q
          .eq("softDeletedAt", undefined)
          .eq("channel", channel)
          .eq("isOfficial", isOfficial)
          .eq("pluginCategory", args.category),
      );
  }
  if (family) {
    return ctx.db
      .query("packagePluginCategorySearchDigest")
      .withIndex("by_active_family_category_updated", (q) =>
        q.eq("softDeletedAt", undefined).eq("family", family).eq("pluginCategory", args.category),
      );
  }
  if (channel) {
    return ctx.db
      .query("packagePluginCategorySearchDigest")
      .withIndex("by_active_channel_category_updated", (q) =>
        q.eq("softDeletedAt", undefined).eq("channel", channel).eq("pluginCategory", args.category),
      );
  }
  if (typeof isOfficial === "boolean") {
    return ctx.db
      .query("packagePluginCategorySearchDigest")
      .withIndex("by_active_official_category_updated", (q) =>
        q
          .eq("softDeletedAt", undefined)
          .eq("isOfficial", isOfficial)
          .eq("pluginCategory", args.category),
      );
  }
  return ctx.db
    .query("packagePluginCategorySearchDigest")
    .withIndex("by_active_category_updated", (q) =>
      q.eq("softDeletedAt", undefined).eq("pluginCategory", args.category),
    );
}

function buildPackageTopicDigestQuery(
  ctx: DbReaderCtx,
  args: {
    topic: string;
    family?: PackageFamily;
    channel?: PackageChannel;
    isOfficial?: boolean;
    sort?: "updated" | "downloads" | "recommended" | "installs" | "trending";
  },
) {
  const family = args.family;
  const channel = args.channel;
  const isOfficial = args.isOfficial;
  if (args.sort === "downloads") {
    if (family && channel && typeof isOfficial === "boolean") {
      return ctx.db
        .query("packageTopicSearchDigest")
        .withIndex("by_active_family_channel_official_topic_downloads", (q) =>
          q
            .eq("softDeletedAt", undefined)
            .eq("family", family)
            .eq("channel", channel)
            .eq("isOfficial", isOfficial)
            .eq("topic", args.topic),
        );
    }
    if (family && channel) {
      return ctx.db
        .query("packageTopicSearchDigest")
        .withIndex("by_active_family_channel_topic_downloads", (q) =>
          q
            .eq("softDeletedAt", undefined)
            .eq("family", family)
            .eq("channel", channel)
            .eq("topic", args.topic),
        );
    }
    if (family && typeof isOfficial === "boolean") {
      return ctx.db
        .query("packageTopicSearchDigest")
        .withIndex("by_active_family_official_topic_downloads", (q) =>
          q
            .eq("softDeletedAt", undefined)
            .eq("family", family)
            .eq("isOfficial", isOfficial)
            .eq("topic", args.topic),
        );
    }
    if (channel && typeof isOfficial === "boolean") {
      return ctx.db
        .query("packageTopicSearchDigest")
        .withIndex("by_active_channel_official_topic_downloads", (q) =>
          q
            .eq("softDeletedAt", undefined)
            .eq("channel", channel)
            .eq("isOfficial", isOfficial)
            .eq("topic", args.topic),
        );
    }
    if (family) {
      return ctx.db
        .query("packageTopicSearchDigest")
        .withIndex("by_active_family_topic_downloads", (q) =>
          q.eq("softDeletedAt", undefined).eq("family", family).eq("topic", args.topic),
        );
    }
    if (channel) {
      return ctx.db
        .query("packageTopicSearchDigest")
        .withIndex("by_active_channel_topic_downloads", (q) =>
          q.eq("softDeletedAt", undefined).eq("channel", channel).eq("topic", args.topic),
        );
    }
    if (typeof isOfficial === "boolean") {
      return ctx.db
        .query("packageTopicSearchDigest")
        .withIndex("by_active_official_topic_downloads", (q) =>
          q.eq("softDeletedAt", undefined).eq("isOfficial", isOfficial).eq("topic", args.topic),
        );
    }
    return ctx.db
      .query("packageTopicSearchDigest")
      .withIndex("by_active_topic_downloads", (q) =>
        q.eq("softDeletedAt", undefined).eq("topic", args.topic),
      );
  }
  if (args.sort === "installs") {
    if (typeof isOfficial === "boolean") {
      return ctx.db
        .query("packageTopicSearchDigest")
        .withIndex("by_active_official_topic_installs", (q) =>
          q.eq("softDeletedAt", undefined).eq("isOfficial", isOfficial).eq("topic", args.topic),
        );
    }
    return ctx.db
      .query("packageTopicSearchDigest")
      .withIndex("by_active_topic_installs", (q) =>
        q.eq("softDeletedAt", undefined).eq("topic", args.topic),
      );
  }
  if (args.sort === "recommended") {
    if (typeof isOfficial === "boolean") {
      return ctx.db
        .query("packageTopicSearchDigest")
        .withIndex("by_active_official_topic_recommended_score", (q) =>
          q.eq("softDeletedAt", undefined).eq("isOfficial", isOfficial).eq("topic", args.topic),
        );
    }
    return ctx.db
      .query("packageTopicSearchDigest")
      .withIndex("by_active_topic_recommended_score", (q) =>
        q.eq("softDeletedAt", undefined).eq("topic", args.topic),
      );
  }
  if (family && channel) {
    return ctx.db
      .query("packageTopicSearchDigest")
      .withIndex("by_active_family_channel_topic_updated", (q) =>
        q
          .eq("softDeletedAt", undefined)
          .eq("family", family)
          .eq("channel", channel)
          .eq("topic", args.topic),
      );
  }
  if (family && typeof isOfficial === "boolean") {
    return ctx.db
      .query("packageTopicSearchDigest")
      .withIndex("by_active_family_official_topic_updated", (q) =>
        q
          .eq("softDeletedAt", undefined)
          .eq("family", family)
          .eq("isOfficial", isOfficial)
          .eq("topic", args.topic),
      );
  }
  if (channel && typeof isOfficial === "boolean") {
    return ctx.db
      .query("packageTopicSearchDigest")
      .withIndex("by_active_channel_official_topic_updated", (q) =>
        q
          .eq("softDeletedAt", undefined)
          .eq("channel", channel)
          .eq("isOfficial", isOfficial)
          .eq("topic", args.topic),
      );
  }
  if (family) {
    return ctx.db
      .query("packageTopicSearchDigest")
      .withIndex("by_active_family_topic_updated", (q) =>
        q.eq("softDeletedAt", undefined).eq("family", family).eq("topic", args.topic),
      );
  }
  if (channel) {
    return ctx.db
      .query("packageTopicSearchDigest")
      .withIndex("by_active_channel_topic_updated", (q) =>
        q.eq("softDeletedAt", undefined).eq("channel", channel).eq("topic", args.topic),
      );
  }
  if (typeof isOfficial === "boolean") {
    return ctx.db
      .query("packageTopicSearchDigest")
      .withIndex("by_active_official_topic_updated", (q) =>
        q.eq("softDeletedAt", undefined).eq("isOfficial", isOfficial).eq("topic", args.topic),
      );
  }
  return ctx.db
    .query("packageTopicSearchDigest")
    .withIndex("by_active_topic_updated", (q) =>
      q.eq("softDeletedAt", undefined).eq("topic", args.topic),
    );
}

async function mayHaveVisiblePackageCategoryDigest(
  ctx: DbReaderCtx,
  args: {
    family?: PackageFamily;
    channel?: PackageChannel;
    isOfficial?: boolean;
    category: PluginCategorySlug;
    topic?: string;
    excludedScanStatuses?: PackageListScanStatus[];
    sort?: "updated" | "downloads" | "recommended" | "installs" | "trending";
    viewerUserId?: Id<"users">;
  },
) {
  const membershipCache = new Map<string, Promise<boolean>>();
  const digests = await (
    args.topic
      ? buildPackageTopicDigestQuery(ctx, {
          topic: args.topic,
          family: args.family,
          channel: args.channel,
          isOfficial: args.isOfficial,
          sort: args.sort,
        })
      : buildPackagePluginCategoryDigestQuery(ctx, {
          category: args.category,
          family: args.family,
          channel: args.channel,
          isOfficial: args.isOfficial,
          sort: args.sort,
        })
  )
    .order("desc")
    .take(MAX_PUBLIC_LIST_PAGE_SIZE);

  for (const digest of digests as PackageDigestLike[]) {
    if (args.family && digest.family !== args.family) continue;
    if (args.channel && digest.channel !== args.channel) continue;
    if (typeof args.isOfficial === "boolean" && digest.isOfficial !== args.isOfficial) continue;
    if (!digestMatchesFilters(digest, args)) continue;
    if (!(await canViewerReadPackage(ctx, digest, args.viewerUserId, membershipCache))) continue;
    return true;
  }
  // A saturated bounded probe cannot prove that later rows are also invisible.
  return digests.length >= MAX_PUBLIC_LIST_PAGE_SIZE;
}

async function takeVisiblePackageCategoryDigestPage(
  ctx: DbReaderCtx,
  args: {
    family?: PackageFamily;
    channel?: PackageChannel;
    isOfficial?: boolean;
    category: PluginCategorySlug;
    topic?: string;
    excludedScanStatuses?: PackageListScanStatus[];
    sort?: "updated" | "downloads" | "recommended" | "installs" | "trending";
    viewerUserId?: Id<"users">;
    numItems: number;
  },
): Promise<PublicPackageListPage> {
  const targetCount = Math.max(0, Math.min(args.numItems, MAX_PUBLIC_LIST_PAGE_SIZE));
  if (targetCount === 0) {
    return { page: [], isDone: true, continueCursor: "" };
  }
  const membershipCache = new Map<string, Promise<boolean>>();
  const scanPageSize = MAX_PUBLIC_LIST_PAGE_SIZE;
  const digests = await (
    args.topic
      ? buildPackageTopicDigestQuery(ctx, {
          topic: args.topic,
          family: args.family,
          channel: args.channel,
          isOfficial: args.isOfficial,
          sort: args.sort,
        })
      : buildPackagePluginCategoryDigestQuery(ctx, {
          category: args.category,
          family: args.family,
          channel: args.channel,
          isOfficial: args.isOfficial,
          sort: args.sort,
        })
  )
    .order("desc")
    .take(scanPageSize);

  const page: PublicPackageListItem[] = [];
  let consumed = 0;
  for (let index = 0; index < digests.length; index += 1) {
    consumed = index + 1;
    const digest = digests[index] as PackageDigestLike;
    if (args.family && digest.family !== args.family) continue;
    if (args.channel && digest.channel !== args.channel) continue;
    if (typeof args.isOfficial === "boolean" && digest.isOfficial !== args.isOfficial) continue;
    if (!digestMatchesFilters(digest, args)) continue;
    if (!(await canViewerReadPackage(ctx, digest, args.viewerUserId, membershipCache))) continue;
    page.push(await toPublicPackageListItem(ctx, digest));
    if (page.length >= targetCount) break;
  }

  const hasMore = consumed < digests.length || digests.length >= scanPageSize;
  return {
    page,
    isDone: !hasMore,
    continueCursor: hasMore
      ? encodePublicPageCursor({
          cursor: null,
          offset: consumed,
          pageSize: scanPageSize,
          done: false,
          mode: "digest",
          sort: args.sort,
        })
      : "",
  };
}

async function fetchHighlightedPackageEntries(
  ctx: DbReaderCtx,
  args: {
    family?: PackageFamily;
    families?: PackageFamily[];
    channel?: PackageChannel;
    isOfficial?: boolean;
    category?: string;
    topic?: string;
    viewerUserId?: Id<"users">;
  },
) {
  const viewerUserId = args.viewerUserId;
  const membershipCache = new Map<string, Promise<boolean>>();
  const badges = await ctx.db
    .query("packageBadges")
    .withIndex("by_kind_at", (q) => q.eq("kind", "highlighted"))
    .order("desc")
    .take(MAX_PUBLIC_LIST_PAGE_SIZE);
  const entries: Array<{ digest: PackageDigestLike; featuredAt: number }> = [];
  for (const badge of badges) {
    const digest = await ctx.db
      .query("packageSearchDigest")
      .withIndex("by_package", (q) => q.eq("packageId", badge.packageId))
      .unique();
    if (!digest || digest.softDeletedAt) continue;
    if (!(await canViewerReadPackage(ctx, digest, viewerUserId, membershipCache))) continue;
    if (!digestMatchesSearchFilters(digest, args)) continue;
    entries.push({ digest, featuredAt: badge.at });
  }
  return entries;
}

async function fetchHighlightedPackagePage(
  ctx: DbReaderCtx,
  args: {
    family?: PackageFamily;
    families?: PackageFamily[];
    channel?: PackageChannel;
    isOfficial?: boolean;
    category?: string;
    topic?: string;
    officialFirst?: boolean;
    sort?: "updated" | "downloads" | "recommended" | "installs" | "trending";
    viewerUserId?: Id<"users">;
    numItems: number;
  },
) {
  const entries = await fetchHighlightedPackageEntries(ctx, args);
  const items = await Promise.all(
    entries.map(
      async ({ digest, featuredAt }) => await toPublicPackageListItem(ctx, digest, featuredAt),
    ),
  );
  // fetchHighlightedPackageEntries follows the badge timestamp index newest-first.
  // Preserve that editorial order instead of re-ranking Featured by popularity.
  if (!args.officialFirst) {
    return items.slice(0, args.numItems);
  }
  const official = items.filter((item) => item.isOfficial);
  const community = items.filter((item) => !item.isOfficial);
  return [...official, ...community].slice(0, args.numItems);
}

async function getPackageByNormalizedName(ctx: DbReaderCtx, normalizedName: string) {
  return (await ctx.db
    .query("packages")
    .withIndex("by_name", (q) => q.eq("normalizedName", normalizedName))
    .unique()) as Doc<"packages"> | null;
}

async function getReadablePackageByName(
  ctx: DbReaderCtx,
  name: string,
  viewerUserId?: Id<"users">,
) {
  const normalizedName = normalizePackageName(name);
  const pkg = await getPackageByNormalizedName(ctx, normalizedName);
  if (!pkg || pkg.softDeletedAt) return null;
  if (!isClawFamilyPubliclyVisible(pkg.family)) return null;
  if (pkg.channel === "private" || isPackageBlockedFromPublic(pkg.scanStatus)) {
    const canAccessOwner = await viewerCanAccessPackageOwner(ctx, pkg, viewerUserId);
    if (pkg.channel === "private" && !canAccessOwner) return null;

    if (isPackageBlockedFromPublic(pkg.scanStatus)) {
      const latestRelease = pkg.latestReleaseId ? await ctx.db.get(pkg.latestReleaseId) : null;
      const scanStatus = resolvePublicPackageScanStatus(pkg, latestRelease);
      if (isPackageBlockedFromPublic(scanStatus) && !canAccessOwner) return null;
    }
  }
  return pkg;
}

async function getPackageReadableForPublicTrust(
  ctx: DbReaderCtx,
  name: string,
  viewerUserId?: Id<"users">,
) {
  const pkg = await getPackageByNormalizedName(ctx, normalizePackageName(name));
  if (!pkg || pkg.softDeletedAt) return null;
  if (!isClawFamilyPubliclyVisible(pkg.family)) return null;
  if (pkg.channel === "private" && !(await viewerCanAccessPackageOwner(ctx, pkg, viewerUserId))) {
    return null;
  }
  return pkg;
}

async function getPackageTrustedPublisherByPackageId(ctx: DbReaderCtx, packageId: Id<"packages">) {
  return await ctx.db
    .query("packageTrustedPublishers")
    .withIndex("by_package", (q) => q.eq("packageId", packageId))
    .unique();
}

function normalizeWorkflowFilenameOrThrow(value: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new ConvexError("Workflow filename is required");
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new ConvexError("Workflow filename must not include a path");
  }
  return trimmed;
}

function normalizeManualOverrideReason(reason: string | undefined) {
  const normalized = reason?.trim();
  return normalized || undefined;
}

async function requireTrustedPublisherEditor(
  ctx: Pick<MutationCtx, "db">,
  pkg: Doc<"packages">,
  actorUserId: Id<"users">,
) {
  await assertCanManageOwnedResource(ctx, {
    actor: { _id: actorUserId },
    ownerUserId: pkg.ownerUserId,
    ownerPublisherId: pkg.ownerPublisherId,
    allowPlatformAdmin: false,
  });
}

type PackageManageContext = {
  package: Pick<Doc<"packages">, "_id" | "name" | "displayName" | "categories" | "topics">;
  latestRelease: Pick<Doc<"packageReleases">, "_id" | "version">;
  suggestedCategories: PluginCategorySlug[];
};

function toPackageManageContext(
  pkg: Doc<"packages">,
  latestRelease: Doc<"packageReleases">,
): PackageManageContext {
  return {
    package: {
      _id: pkg._id,
      name: pkg.name,
      displayName: pkg.displayName,
      categories: pkg.categories,
      topics: pkg.topics,
    },
    latestRelease: {
      _id: latestRelease._id,
      version: latestRelease.version,
    },
    suggestedCategories: derivePluginCategoryTags({
      family: pkg.family,
      pluginManifest: latestRelease.extractedPluginManifest,
    }),
  };
}

export const getByName = query({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const viewerUserId = await getOptionalViewerUserId(ctx);
    const pkg = await getReadablePackageByName(ctx, args.name, viewerUserId);
    if (!pkg) return null;
    const latestRelease = pkg.latestReleaseId ? await ctx.db.get(pkg.latestReleaseId) : null;
    const publicPackage = toPublicPackage(pkg, latestRelease);
    if (!publicPackage) return null;
    const owner = toPublicPublisher(
      await getOwnerPublisher(ctx, {
        ownerPublisherId: pkg.ownerPublisherId,
        ownerUserId: pkg.ownerUserId,
      }),
    );
    return {
      package: publicPackage,
      latestRelease: isPublishedPackageRelease(latestRelease)
        ? toPublicPackageRelease(latestRelease, pkg.family)
        : null,
      owner,
    };
  },
});

export const getManageContext = query({
  args: {
    name: v.string(),
    candidateNames: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const viewerUserId = await getOptionalViewerUserId(ctx);
    if (!viewerUserId) return null;

    const candidates = [args.name, ...(args.candidateNames ?? [])]
      .map((name) => normalizePackageName(name))
      .filter(Boolean);
    const uniqueCandidates = Array.from(new Set(candidates));

    let pkg: Doc<"packages"> | null = null;
    for (const candidate of uniqueCandidates) {
      pkg = await getPackageByNormalizedName(ctx, candidate);
      if (pkg && !pkg.softDeletedAt && pkg.family !== "skill") break;
      pkg = null;
    }
    if (!pkg || !pkg.latestReleaseId) return null;

    const actor = await ctx.db.get(viewerUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) return null;
    if (actor.role !== "admin" && actor.role !== "moderator") {
      const canAccess = await viewerCanManagePackageOwner(ctx, pkg, viewerUserId);
      if (!canAccess) return null;
    }

    const latestRelease = await ctx.db.get(pkg.latestReleaseId);
    if (!latestRelease || latestRelease.softDeletedAt) return null;

    return toPackageManageContext(pkg, latestRelease);
  },
});

export const assertCanGenerateChangelogPreviewInternal = internalQuery({
  args: {
    actorUserId: v.id("users"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) {
      throw new ConvexError("Unauthorized");
    }

    const pkg = await getPackageByNormalizedName(ctx, args.name);
    if (!pkg || pkg.softDeletedAt) return { ok: true as const, latestReleaseId: null };
    if (pkg.family === "skill") throw new ConvexError("Forbidden");
    const result = { ok: true as const, latestReleaseId: pkg.latestReleaseId ?? null };
    if (actor.role === "admin" || actor.role === "moderator") return result;

    const canPublish = await viewerCanAccessPackageOwner(ctx, pkg, args.actorUserId);
    if (!canPublish) throw new ConvexError("Forbidden");
    return result;
  },
});

export const canDeleteVersions = query({
  args: {
    name: v.string(),
    candidateNames: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const viewerUserId = await getOptionalViewerUserId(ctx);
    if (!viewerUserId) return false;

    const candidates = [args.name, ...(args.candidateNames ?? [])]
      .map((name) => normalizePackageName(name))
      .filter(Boolean);
    const uniqueCandidates = Array.from(new Set(candidates)).slice(
      0,
      MAX_PACKAGE_VERSION_DELETE_LOOKUP_CANDIDATES,
    );

    let pkg: Doc<"packages"> | null = null;
    for (const candidate of uniqueCandidates) {
      pkg = await getPackageByNormalizedName(ctx, candidate);
      if (pkg && !pkg.softDeletedAt && pkg.family !== "skill") break;
      pkg = null;
    }
    if (!pkg || isPackageBlockedFromPublic(pkg.scanStatus)) return false;

    const actor = await ctx.db.get(viewerUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) return false;

    return await viewerCanManagePackageOwner(ctx, pkg, viewerUserId);
  },
});

function toPublicPackageInspectorFinding(warning: Doc<"packageInspectorWarnings">) {
  const findingKind =
    warning.findingKind ??
    (warning.level === "breakage" || warning.severity === "P0" ? "error" : "warning");
  return {
    _id: warning._id,
    packageName: warning.packageName,
    version: warning.version,
    findingKind,
    code: warning.code,
    severity: warning.severity,
    level: warning.level,
    issueClass: warning.issueClass,
    compatStatus: warning.compatStatus,
    deprecated: warning.deprecated,
    message: warning.message,
    evidence: warning.evidence ?? [],
    authorRemediation: warning.authorRemediation,
    fixture: warning.fixture,
    decision: warning.decision,
    inspectorVersion: warning.inspectorVersion,
    targetOpenClawVersion: warning.targetOpenClawVersion,
    scanSource: warning.scanSource ?? "publish",
    createdAt: warning.createdAt,
  };
}

export const listPackageInspectorFindingsPublic = query({
  args: {
    name: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const viewerUserId = await getOptionalActiveAuthUserId(ctx);
    if (!viewerUserId) return [];
    const pkg = await getReadablePackageByName(ctx, args.name, viewerUserId);
    if (!pkg || pkg.softDeletedAt || pkg.family === "skill") return [];
    const actor = await ctx.db.get(viewerUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) return [];
    if (actor.role !== "admin" && actor.role !== "moderator") {
      const canManage = await viewerCanManagePackageOwner(ctx, pkg, viewerUserId);
      if (!canManage) return [];
    }

    if (!pkg.latestReleaseId) return [];
    const limit = Math.max(1, Math.min(args.limit ?? 50, 100));
    const warnings = await takeAuthorRemediationWarningsByRelease(ctx, pkg.latestReleaseId, limit);
    return warnings.map(toPublicPackageInspectorFinding);
  },
});

export const getPackageInspectorValidationSummaryPublic = query({
  args: {
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const viewerUserId = await getOptionalActiveAuthUserId(ctx);
    const pkg = await getReadablePackageByName(ctx, args.name, viewerUserId ?? undefined);
    if (!pkg || pkg.softDeletedAt || pkg.family === "skill") {
      return {
        findingCount: 0,
        errorCount: 0,
        warningCount: 0,
        incompatibleAfterOpenClawVersion: null,
      };
    }

    const findings = pkg.latestReleaseId
      ? await takeAuthorRemediationWarningsByRelease(ctx, pkg.latestReleaseId, 100)
      : [];
    const errorFindings = findings.filter((finding) => {
      const kind =
        finding.findingKind ??
        (finding.level === "breakage" || finding.severity === "P0" ? "error" : "warning");
      return kind === "error";
    });
    return {
      findingCount: findings.length,
      errorCount: errorFindings.length,
      warningCount: findings.length - errorFindings.length,
      incompatibleAfterOpenClawVersion:
        errorFindings.find((finding) => finding.targetOpenClawVersion)?.targetOpenClawVersion ??
        null,
    };
  },
});

export const listPackageInspectorWarningsForManager = query({
  args: {
    name: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const viewerUserId = await getOptionalActiveAuthUserId(ctx);
    if (!viewerUserId) return [];
    const pkg = await getPackageByNormalizedName(ctx, normalizePackageName(args.name));
    if (!pkg || pkg.softDeletedAt || pkg.family === "skill") return [];
    const actor = await ctx.db.get(viewerUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) return [];
    if (actor.role !== "admin" && actor.role !== "moderator") {
      const canManage = await viewerCanManagePackageOwner(ctx, pkg, viewerUserId);
      if (!canManage) return [];
    }
    if (!pkg.latestReleaseId) return [];
    const limit = Math.max(1, Math.min(args.limit ?? 50, 100));
    const warnings = await takeAuthorRemediationWarningsByRelease(ctx, pkg.latestReleaseId, limit);
    return warnings.map(toPublicPackageInspectorFinding);
  },
});

async function takeAuthorRemediationWarningsByRelease(
  ctx: DbReaderCtx,
  releaseId: Id<"packageReleases">,
  limit: number,
) {
  const findings = await ctx.db
    .query("packageInspectorWarnings")
    .withIndex("by_release_created", (q) => q.eq("releaseId", releaseId))
    .order("desc")
    .take(authorRemediationScanLimit(limit));
  return findings.filter(hasStoredAuthorRemediation).slice(0, limit);
}

async function takeExactNightlyAuthorRemediationWarningsByRelease(
  ctx: DbReaderCtx,
  releaseId: Id<"packageReleases">,
  inspectorVersion: string,
  targetOpenClawVersion: string,
  limit: number,
) {
  const findings = await ctx.db
    .query("packageInspectorWarnings")
    .withIndex("by_release_created", (q) => q.eq("releaseId", releaseId))
    .filter((q) =>
      q.and(
        q.eq(q.field("scanSource"), "nightly"),
        q.eq(q.field("inspectorVersion"), inspectorVersion),
        q.eq(q.field("targetOpenClawVersion"), targetOpenClawVersion),
      ),
    )
    .order("desc")
    .take(authorRemediationScanLimit(limit));
  return findings.filter(hasStoredAuthorRemediation).slice(0, limit);
}

function authorRemediationScanLimit(limit: number) {
  return Math.min(500, Math.max(limit * 5, 50));
}

function hasStoredAuthorRemediation(warning: Doc<"packageInspectorWarnings">) {
  return Boolean(warning.authorRemediation?.summary);
}

export const getByNameForStaff = query({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    assertModerator(user);

    const pkg = await getPackageByNormalizedName(ctx, normalizePackageName(args.name));
    if (!pkg || pkg.softDeletedAt || pkg.family === "skill") return null;

    const highlighted = await ctx.db
      .query("packageBadges")
      .withIndex("by_package_kind", (q) => q.eq("packageId", pkg._id).eq("kind", "highlighted"))
      .unique();
    const latestRelease = pkg.latestReleaseId ? await ctx.db.get(pkg.latestReleaseId) : null;
    const owner = toPublicPublisher(
      await getOwnerPublisher(ctx, {
        ownerPublisherId: pkg.ownerPublisherId,
        ownerUserId: pkg.ownerUserId,
      }),
    );

    return {
      package: pkg,
      latestRelease: isPublishedPackageRelease(latestRelease)
        ? toPublicPackageRelease(latestRelease, pkg.family)
        : null,
      owner,
      highlighted: highlighted
        ? {
            byUserId: highlighted.byUserId,
            at: highlighted.at,
          }
        : null,
    };
  },
});

export const getByNameForViewerInternal = internalQuery({
  args: {
    name: v.string(),
    viewerUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const pkg = await getReadablePackageByName(ctx, args.name, args.viewerUserId);
    if (!pkg) return null;
    const latestRelease = pkg.latestReleaseId ? await ctx.db.get(pkg.latestReleaseId) : null;
    const publicPackage = toPublicPackage(pkg, latestRelease);
    if (!publicPackage) return null;
    const owner = toPublicPublisher(
      await getOwnerPublisher(ctx, {
        ownerPublisherId: pkg.ownerPublisherId,
        ownerUserId: pkg.ownerUserId,
      }),
    );
    return {
      package: publicPackage,
      latestRelease: isPublishedPackageRelease(latestRelease)
        ? toPublicPackageRelease(latestRelease, pkg.family)
        : null,
      owner,
    };
  },
});

export const listVersions = query({
  args: {
    name: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const viewerUserId = await getOptionalViewerUserId(ctx);
    const pkg = await getReadablePackageByName(ctx, args.name, viewerUserId);
    if (!pkg) return { page: [], isDone: true, continueCursor: "" };
    const result = await paginatePublishedPackageReleases(ctx, pkg._id, args.paginationOpts);
    return {
      ...result,
      page: result.page.map((release) => toPublicPackageRelease(release, pkg.family)),
    };
  },
});

export const listVersionsForViewerInternal = internalQuery({
  args: {
    name: v.string(),
    viewerUserId: v.optional(v.id("users")),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const pkg = await getReadablePackageByName(ctx, args.name, args.viewerUserId);
    if (!pkg) return { page: [], isDone: true, continueCursor: "" };
    const result = await paginatePublishedPackageReleases(ctx, pkg._id, args.paginationOpts);
    return {
      ...result,
      page: result.page.map((release) => ({
        ...toPublicPackageRelease(release, pkg.family),
        // Internal HTTP handlers need the opaque storage id to stream exact ClawPack bytes.
        ...(release.clawpackStorageId ? { clawpackStorageId: release.clawpackStorageId } : {}),
      })),
    };
  },
});

export const listVersionsForManager = query({
  args: {
    name: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const viewerUserId = await getOptionalViewerUserId(ctx);
    if (!viewerUserId) return { page: [], isDone: true, continueCursor: "" };
    const actor = await ctx.db.get(viewerUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) {
      return { page: [], isDone: true, continueCursor: "" };
    }

    const pkg = await getPackageByNormalizedName(ctx, normalizePackageName(args.name));
    if (
      !pkg ||
      pkg.softDeletedAt ||
      pkg.family === "skill" ||
      isPackageBlockedFromPublic(pkg.scanStatus)
    ) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    if (!(await viewerCanManagePackageOwner(ctx, pkg, viewerUserId))) {
      return { page: [], isDone: true, continueCursor: "" };
    }

    const result = await ctx.db
      .query("packageReleases")
      .withIndex("by_package_owner_deleted_created", (q) =>
        q.eq("packageId", pkg._id).eq("ownerDeletedBy", actor._id),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page
        .filter((release) => isPackageReleaseRestorableByOwner(release, pkg._id, actor._id))
        .map((release) => toManagerPackageRelease(release, pkg.family)),
    };
  },
});

export const getVersionByName = query({
  args: {
    name: v.string(),
    version: v.string(),
  },
  handler: async (ctx, args) => {
    const viewerUserId = await getOptionalViewerUserId(ctx);
    const pkg = await getReadablePackageByName(ctx, args.name, viewerUserId);
    if (!pkg) return null;
    const release = await ctx.db
      .query("packageReleases")
      .withIndex("by_package_version", (q) =>
        q.eq("packageId", pkg._id).eq("version", args.version),
      )
      .unique();
    if (!isPublishedPackageRelease(release)) return null;
    const latestRelease =
      pkg.latestReleaseId === release._id
        ? release
        : pkg.latestReleaseId
          ? await ctx.db.get(pkg.latestReleaseId)
          : null;
    const publicPackage = toPublicPackage(pkg, latestRelease);
    if (!publicPackage) return null;
    return {
      package: publicPackage,
      version: toPublicPackageRelease(release, pkg.family),
    };
  },
});

export const getVersionByNameForViewerInternal = internalQuery({
  args: {
    name: v.string(),
    version: v.string(),
    viewerUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const pkg = await getReadablePackageByName(ctx, args.name, args.viewerUserId);
    if (!pkg) return null;
    const release = await ctx.db
      .query("packageReleases")
      .withIndex("by_package_version", (q) =>
        q.eq("packageId", pkg._id).eq("version", args.version),
      )
      .unique();
    if (!isPublishedPackageRelease(release)) return null;
    const latestRelease =
      pkg.latestReleaseId === release._id
        ? release
        : pkg.latestReleaseId
          ? await ctx.db.get(pkg.latestReleaseId)
          : null;
    const publicPackage = toPublicPackage(pkg, latestRelease);
    if (!publicPackage) return null;
    return {
      package: publicPackage,
      version: {
        ...toPublicPackageRelease(release, pkg.family),
        // Internal HTTP handlers need the opaque storage id to stream exact ClawPack bytes.
        ...(release.clawpackStorageId ? { clawpackStorageId: release.clawpackStorageId } : {}),
      },
    };
  },
});

export const getVersionSecurityByNameForViewerInternal = internalQuery({
  args: {
    name: v.string(),
    version: v.string(),
    viewerUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const pkg = await getPackageReadableForPublicTrust(ctx, args.name, args.viewerUserId);
    if (!pkg) return null;
    const release = await ctx.db
      .query("packageReleases")
      .withIndex("by_package_version", (q) =>
        q.eq("packageId", pkg._id).eq("version", args.version),
      )
      .unique();
    if (!isPublishedPackageRelease(release)) return null;
    const latestRelease =
      pkg.latestReleaseId === release._id
        ? release
        : pkg.latestReleaseId
          ? await ctx.db.get(pkg.latestReleaseId)
          : null;
    const publicPackage = toPublicPackage(pkg, latestRelease);
    if (!publicPackage) return null;
    const publicDownloadBlocked =
      isPackageBlockedFromPublic(publicPackage.scanStatus) &&
      !(await viewerCanAccessPackageOwner(ctx, pkg, args.viewerUserId));
    return {
      package: {
        ...publicPackage,
        publicDownloadBlocked,
      },
      version: toPublicPackageRelease(release, pkg.family),
    };
  },
});

export const list = query({
  args: {
    ownerUserId: v.optional(v.id("users")),
    ownerPublisherId: v.optional(v.id("publishers")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const viewerUserId = await getOptionalActiveAuthUserId(ctx);
    if (!viewerUserId) return [];
    const limit = Math.max(1, Math.min(args.limit ?? 50, 100));
    if (args.ownerPublisherId) {
      return await listDashboardPackagesForOwnerPublisher(
        ctx,
        args.ownerPublisherId,
        viewerUserId,
        limit,
      );
    }
    if (args.ownerUserId) {
      return await listDashboardPackagesForOwnerUser(ctx, args.ownerUserId, viewerUserId, limit);
    }
    return await listDashboardPackagesForOwnerUser(ctx, viewerUserId, viewerUserId, limit);
  },
});

export const listPublicPage = query({
  args: {
    family: v.optional(
      v.union(
        v.literal("skill"),
        v.literal("code-plugin"),
        v.literal("bundle-plugin"),
        v.literal("claw"),
      ),
    ),
    channel: v.optional(
      v.union(v.literal("official"), v.literal("community"), v.literal("private")),
    ),
    isOfficial: v.optional(v.boolean()),
    highlightedOnly: v.optional(v.boolean()),
    category: v.optional(v.string()),
    topic: v.optional(v.string()),
    officialFirst: v.optional(v.boolean()),
    excludedScanStatuses: v.optional(v.array(packageListScanStatusValidator)),
    sort: v.optional(
      v.union(
        v.literal("updated"),
        v.literal("downloads"),
        v.literal("recommended"),
        v.literal("installs"),
        v.literal("trending"),
      ),
    ),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    return await listPackagePageImpl(ctx, args);
  },
});

export const listPublicNewPluginsPage = query({
  args: {
    category: v.optional(v.string()),
    createdAfter: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const category = isPluginCategorySlug(args.category) ? args.category : undefined;
    if (args.category && !category) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    return await listStablePackageDiscoveryPage(ctx, {
      families: ["code-plugin", "bundle-plugin"],
      category,
      sort: "created",
      createdAfter: args.createdAfter,
      paginationOpts: args.paginationOpts,
    });
  },
});

export const listAuditPage = query({
  args: {
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const numItems = Math.max(1, Math.min(args.paginationOpts.numItems, MAX_PUBLIC_LIST_PAGE_SIZE));
    const result = await ctx.db
      .query("packages")
      .withIndex("by_active_downloads", (q) => q.eq("softDeletedAt", undefined))
      .order("desc")
      .paginate({ cursor: args.paginationOpts.cursor, numItems });

    const page = [];
    const membershipCache = new Map<string, Promise<boolean>>();
    for (const pkg of result.page) {
      if (pkg.family !== "code-plugin" && pkg.family !== "bundle-plugin") continue;
      if (!(await canViewerReadPackage(ctx, pkg, undefined, membershipCache))) continue;

      const owner = toPublicPublisher(
        await getOwnerPublisher(ctx, {
          ownerPublisherId: pkg.ownerPublisherId,
          ownerUserId: pkg.ownerUserId,
        }),
      );
      const latestRelease = pkg.latestReleaseId ? await ctx.db.get(pkg.latestReleaseId) : null;
      page.push({
        kind: "plugin" as const,
        package: {
          name: pkg.name,
          displayName: pkg.displayName,
          family: pkg.family,
          channel: pkg.channel,
          isOfficial: pkg.isOfficial,
          summary: pkg.summary ?? null,
          icon: pkg.icon ?? null,
          ownerHandle: owner?.handle ?? null,
          createdAt: pkg.createdAt,
          updatedAt: pkg.updatedAt,
          latestVersion: pkg.latestVersionSummary?.version ?? null,
          stats: pkg.stats,
          verificationTier: pkg.verification?.tier ?? null,
        },
        owner,
        latestRelease: isPublishedPackageRelease(latestRelease)
          ? {
              version: latestRelease.version,
              createdAt: latestRelease.createdAt,
              vtAnalysis: latestRelease.vtAnalysis,
              llmAnalysis: latestRelease.llmAnalysis,
              staticScan: latestRelease.staticScan
                ? {
                    status: latestRelease.staticScan.status,
                    reasonCodes: latestRelease.staticScan.reasonCodes,
                    findings: (latestRelease.staticScan.findings ?? []).map((finding) => ({
                      code: finding.code,
                      severity: finding.severity,
                      file: finding.file,
                      line: finding.line,
                      message: finding.message,
                      evidence: "",
                    })),
                    summary: latestRelease.staticScan.summary,
                    engineVersion: latestRelease.staticScan.engineVersion,
                    checkedAt: latestRelease.staticScan.checkedAt,
                  }
                : null,
            }
          : null,
      });
    }

    return {
      page,
      isDone: result.isDone,
      continueCursor: result.isDone ? "" : result.continueCursor,
    };
  },
});

type PluginExportFamily = (typeof PLUGIN_EXPORT_FAMILIES)[number];

type PluginExportDigest = {
  packageId: Id<"packages">;
  name: string;
  displayName: string;
  family: PluginExportFamily;
  latestReleaseId?: Id<"packageReleases">;
  latestVersion?: string | null;
  createdAt: number;
  updatedAt: number;
  stats?: Doc<"packages">["stats"] | null;
  ownerUserId: Id<"users">;
  ownerHandle?: string | null;
};

type PluginExportFamilyPage = {
  page: PluginExportDigest[];
  nextCursor: string | null;
  hasMore: boolean;
};

type PluginExportSourceState = {
  cursor: string | null;
  offset: number;
  pageSize?: number;
  done: boolean;
};

type PluginExportMergedCursor = {
  codePlugins: PluginExportSourceState;
  bundlePlugins: PluginExportSourceState;
};

function emptyPluginExportSourceState(): PluginExportSourceState {
  return { cursor: null, offset: 0, done: false };
}

function emptyPluginExportMergedCursor(): PluginExportMergedCursor {
  return {
    codePlugins: emptyPluginExportSourceState(),
    bundlePlugins: emptyPluginExportSourceState(),
  };
}

function encodePackageIndexKeyValue(val: Value | undefined): Value {
  return val === undefined ? { __undef: 1 } : val;
}

function decodePackageIndexKeyValue(val: unknown): Value | undefined {
  if (val !== null && typeof val === "object" && "__undef" in (val as Record<string, unknown>)) {
    return undefined;
  }
  return val as Value;
}

function emptyStablePackageDiscoveryCursor(
  sort: StablePackageDiscoveryCursorState["sort"],
): StablePackageDiscoveryCursorState {
  return {
    sort,
    sources: {
      skill: { key: null, done: false },
      "code-plugin": { key: null, done: false },
      "bundle-plugin": { key: null, done: false },
    },
  };
}

function encodeStablePackageDiscoveryCursor(state: StablePackageDiscoveryCursorState) {
  const sources = Object.fromEntries(
    STABLE_PACKAGE_FAMILIES.map((family) => [
      family,
      {
        key: state.sources[family].key?.map(encodePackageIndexKeyValue) ?? null,
        done: state.sources[family].done,
      },
    ]),
  );
  return `${STABLE_PACKAGE_DISCOVERY_CURSOR_PREFIX}${JSON.stringify({
    v: 1,
    sort: state.sort,
    sources,
  })}`;
}

function readStablePackageDiscoveryCursorSort(
  raw: string | null | undefined,
): "updated" | "created" | "recommended" | null {
  if (!raw?.startsWith(STABLE_PACKAGE_DISCOVERY_CURSOR_PREFIX)) return null;
  try {
    const parsed = JSON.parse(raw.slice(STABLE_PACKAGE_DISCOVERY_CURSOR_PREFIX.length)) as {
      v?: unknown;
      sort?: unknown;
    };
    return parsed.v === 1 &&
      (parsed.sort === "updated" || parsed.sort === "created" || parsed.sort === "recommended")
      ? parsed.sort
      : null;
  } catch {
    return null;
  }
}

function decodeStablePackageDiscoveryCursor(
  raw: string | null | undefined,
  sort: StablePackageDiscoveryCursorState["sort"],
): StablePackageDiscoveryCursorState {
  const fallback = emptyStablePackageDiscoveryCursor(sort);
  if (!raw?.startsWith(STABLE_PACKAGE_DISCOVERY_CURSOR_PREFIX)) return fallback;
  try {
    const parsed = JSON.parse(raw.slice(STABLE_PACKAGE_DISCOVERY_CURSOR_PREFIX.length)) as {
      v?: unknown;
      sort?: unknown;
      sources?: unknown;
    };
    if (
      parsed.v !== 1 ||
      parsed.sort !== sort ||
      !parsed.sources ||
      typeof parsed.sources !== "object"
    ) {
      return fallback;
    }
    const sources = parsed.sources as Record<string, unknown>;
    const decoded = emptyStablePackageDiscoveryCursor(sort);
    for (const family of STABLE_PACKAGE_FAMILIES) {
      const value = sources[family];
      if (!value || typeof value !== "object") return fallback;
      const source = value as { key?: unknown; done?: unknown };
      if (source.key !== null && !Array.isArray(source.key)) return fallback;
      decoded.sources[family] = {
        key: Array.isArray(source.key) ? source.key.map(decodePackageIndexKeyValue) : null,
        done: source.done === true,
      };
    }
    return decoded;
  } catch {
    return fallback;
  }
}

function encodePackageIndexCursor(indexName: string, key: IndexKey): string {
  return JSON.stringify({
    v: 1,
    index: indexName,
    key: key.map(encodePackageIndexKeyValue),
  });
}

function packageIndexKeyStartsWithPrefix(key: IndexKey, prefix: IndexKey): boolean {
  if (key.length < prefix.length) return false;
  return prefix.every((value, index) => key[index] === value);
}

function decodePackageIndexCursor({
  cursor,
  indexName,
  maxIndexKeyLength,
  eqPrefix,
}: {
  cursor?: string | null;
  indexName: string;
  maxIndexKeyLength: number;
  eqPrefix: IndexKey;
}): IndexKey | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor) as unknown;
    const isSelfDescribingCursor =
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as { v?: unknown }).v === 1 &&
      (parsed as { index?: unknown }).index === indexName &&
      Array.isArray((parsed as { key?: unknown }).key);
    const arr = Array.isArray(parsed)
      ? parsed
      : isSelfDescribingCursor
        ? (parsed as { key: unknown[] }).key
        : null;
    if (!Array.isArray(arr)) return null;
    const key = arr.map(decodePackageIndexKeyValue);
    const maxLength = isSelfDescribingCursor
      ? maxIndexKeyLength + GET_PAGE_TIEBREAKER_FIELD_COUNT
      : maxIndexKeyLength;
    if (key.length > maxLength) return null;
    if (!packageIndexKeyStartsWithPrefix(key, eqPrefix)) return null;
    return key;
  } catch {
    return null;
  }
}

function encodePluginExportMergedCursor(state: PluginExportMergedCursor): string {
  return `pkgpluginexport:${JSON.stringify({ v: 1, ...state })}`;
}

function parsePluginExportSourceState(value: unknown): PluginExportSourceState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.cursor !== null && typeof record.cursor !== "string") return null;
  if (typeof record.offset !== "number" || record.offset < 0) return null;
  if (record.pageSize !== undefined && typeof record.pageSize !== "number") return null;
  if (typeof record.done !== "boolean") return null;
  return {
    cursor: record.cursor,
    offset: Math.floor(record.offset),
    pageSize: record.pageSize === undefined ? undefined : Math.floor(record.pageSize),
    done: record.done,
  };
}

function decodePluginExportMergedCursor(cursor?: string | null): PluginExportMergedCursor | null {
  if (!cursor) return emptyPluginExportMergedCursor();
  if (!cursor.startsWith("pkgpluginexport:")) return null;
  try {
    const parsed = JSON.parse(cursor.slice("pkgpluginexport:".length)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1) return null;
    const codePlugins = parsePluginExportSourceState(record.codePlugins);
    const bundlePlugins = parsePluginExportSourceState(record.bundlePlugins);
    if (!codePlugins || !bundlePlugins) return null;
    return { codePlugins, bundlePlugins };
  } catch {
    return null;
  }
}

function comparePluginExportDigests(a: PluginExportDigest, b: PluginExportDigest) {
  const updatedDiff = b.updatedAt - a.updatedAt;
  if (updatedDiff !== 0) return updatedDiff;
  return a.name.localeCompare(b.name);
}

function getPluginExportSourcePageSize(source: PluginExportSourceState, targetCount: number) {
  return Math.min(
    MAX_PLUGIN_EXPORT_LIST_LIMIT,
    Math.max(targetCount, source.pageSize ?? 0, source.offset + targetCount),
  );
}

function finalizePluginExportSourceState(params: {
  source: PluginExportSourceState;
  index: number;
  pageLength: number;
  pageSize: number;
  nextCursor: string | null;
  hasMore: boolean;
}): PluginExportSourceState {
  if (params.index < params.pageLength) {
    return {
      cursor: params.source.cursor,
      offset: params.index,
      pageSize: params.pageSize,
      done: false,
    };
  }
  return {
    cursor: params.nextCursor,
    offset: 0,
    pageSize: params.pageSize,
    done: !params.hasMore,
  };
}

async function listPluginExportFamilyPage(
  ctx: DbReaderCtx,
  args: {
    family: PluginExportFamily;
    startDate: number;
    endDate: number;
    cursor?: string | null;
    numItems: number;
  },
): Promise<PluginExportFamilyPage> {
  const indexName = "by_active_family_updated";
  const eqPrefix: IndexKey = [undefined, args.family];
  const decodedCursor = args.cursor
    ? decodePackageIndexCursor({
        cursor: args.cursor,
        indexName,
        maxIndexKeyLength: 3,
        eqPrefix,
      })
    : null;
  if (args.cursor && !decodedCursor) {
    throw new Error("Invalid cursor format");
  }

  const result = await getPage(ctx, {
    table: "packageSearchDigest",
    index: indexName,
    startIndexKey: decodedCursor ?? [undefined, args.family, args.endDate],
    startInclusive: !decodedCursor,
    endIndexKey: [undefined, args.family, args.startDate],
    endInclusive: true,
    order: "desc",
    absoluteMaxRows: args.numItems,
    schema,
  });

  const page: PluginExportDigest[] = [];
  const membershipCache = new Map<string, Promise<boolean>>();
  for (const digest of result.page) {
    if (!(await canViewerReadPackage(ctx, digest, undefined, membershipCache))) continue;
    const pkg = await ctx.db.get(digest.packageId);
    if (!pkg || pkg.softDeletedAt || pkg.family !== args.family || !pkg.latestReleaseId) continue;
    page.push({
      packageId: digest.packageId,
      name: digest.name,
      displayName: digest.displayName,
      family: args.family,
      latestReleaseId: pkg.latestReleaseId,
      latestVersion: digest.latestVersion ?? pkg.latestVersionSummary?.version ?? null,
      createdAt: digest.createdAt,
      updatedAt: digest.updatedAt,
      stats: pkg.stats ?? digest.stats ?? null,
      ownerUserId: digest.ownerUserId,
      ownerHandle: digest.ownerHandle ?? null,
    });
  }

  const nextCursor =
    result.hasMore && result.indexKeys.length > 0
      ? encodePackageIndexCursor(indexName, result.indexKeys[result.indexKeys.length - 1])
      : null;
  return { page, nextCursor, hasMore: result.hasMore };
}

async function listMergedPluginExportPage(
  ctx: DbReaderCtx,
  args: {
    startDate: number;
    endDate: number;
    cursor?: string | null;
    numItems: number;
  },
) {
  const decodedCursor = decodePluginExportMergedCursor(args.cursor);
  if (!decodedCursor) throw new Error("Invalid cursor format");

  const codePageSize = getPluginExportSourcePageSize(decodedCursor.codePlugins, args.numItems);
  const bundlePageSize = getPluginExportSourcePageSize(decodedCursor.bundlePlugins, args.numItems);
  const [codePlugins, bundlePlugins] = await Promise.all([
    decodedCursor.codePlugins.done
      ? Promise.resolve({
          page: [],
          nextCursor: null,
          hasMore: false,
        } satisfies PluginExportFamilyPage)
      : listPluginExportFamilyPage(ctx, {
          family: "code-plugin",
          startDate: args.startDate,
          endDate: args.endDate,
          cursor: decodedCursor.codePlugins.cursor,
          numItems: codePageSize,
        }),
    decodedCursor.bundlePlugins.done
      ? Promise.resolve({
          page: [],
          nextCursor: null,
          hasMore: false,
        } satisfies PluginExportFamilyPage)
      : listPluginExportFamilyPage(ctx, {
          family: "bundle-plugin",
          startDate: args.startDate,
          endDate: args.endDate,
          cursor: decodedCursor.bundlePlugins.cursor,
          numItems: bundlePageSize,
        }),
  ]);

  let codeIndex = decodedCursor.codePlugins.offset;
  let bundleIndex = decodedCursor.bundlePlugins.offset;
  const page: PluginExportDigest[] = [];
  while (page.length < args.numItems) {
    const codeCandidate = codePlugins.page[codeIndex];
    const bundleCandidate = bundlePlugins.page[bundleIndex];
    if (!codeCandidate && !bundleCandidate) break;
    if (
      !bundleCandidate ||
      (codeCandidate && comparePluginExportDigests(codeCandidate, bundleCandidate) <= 0)
    ) {
      page.push(codeCandidate);
      codeIndex += 1;
    } else {
      page.push(bundleCandidate);
      bundleIndex += 1;
    }
  }

  const nextState: PluginExportMergedCursor = {
    codePlugins: finalizePluginExportSourceState({
      source: decodedCursor.codePlugins,
      index: codeIndex,
      pageLength: codePlugins.page.length,
      pageSize: codePageSize,
      nextCursor: codePlugins.nextCursor,
      hasMore: codePlugins.hasMore,
    }),
    bundlePlugins: finalizePluginExportSourceState({
      source: decodedCursor.bundlePlugins,
      index: bundleIndex,
      pageLength: bundlePlugins.page.length,
      pageSize: bundlePageSize,
      nextCursor: bundlePlugins.nextCursor,
      hasMore: bundlePlugins.hasMore,
    }),
  };
  const isDone =
    nextState.codePlugins.done &&
    nextState.codePlugins.offset === 0 &&
    nextState.bundlePlugins.done &&
    nextState.bundlePlugins.offset === 0;
  return {
    page,
    nextCursor: isDone ? null : encodePluginExportMergedCursor(nextState),
    hasMore: !isDone,
  };
}

export const listPluginExportPageInternal = internalQuery({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
    family: v.optional(v.union(v.literal("code-plugin"), v.literal("bundle-plugin"))),
  },
  handler: async (ctx, args) => {
    const numItems = Math.max(
      1,
      Math.min(args.numItems ?? MAX_PLUGIN_EXPORT_LIST_LIMIT, MAX_PLUGIN_EXPORT_LIST_LIMIT),
    );
    if (args.family) {
      return await listPluginExportFamilyPage(ctx, {
        family: args.family,
        startDate: args.startDate,
        endDate: args.endDate,
        cursor: args.cursor,
        numItems,
      });
    }
    return await listMergedPluginExportPage(ctx, {
      startDate: args.startDate,
      endDate: args.endDate,
      cursor: args.cursor,
      numItems,
    });
  },
});

function normalizePackageValidationFinding(warning: Doc<"packageInspectorWarnings">) {
  const severity =
    warning.findingKind === "error" ||
    warning.level === "breakage" ||
    warning.level === "error" ||
    warning.severity === "P0"
      ? ("error" as const)
      : warning.severity?.toLowerCase() === "info"
        ? ("info" as const)
        : ("warning" as const);
  return { severity, code: warning.code, message: warning.message };
}

export const listPluginValidationReportPageInternal = internalQuery({
  args: {
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const numItems = Math.max(
      1,
      Math.min(
        args.numItems ?? MAX_PLUGIN_VALIDATION_REPORT_PAGE_SIZE,
        MAX_PLUGIN_VALIDATION_REPORT_PAGE_SIZE,
      ),
    );
    const result = await listMergedPluginExportPage(ctx, {
      startDate: 0,
      endDate: Number.MAX_SAFE_INTEGER,
      cursor: args.cursor,
      numItems,
    });
    const items = [];
    for (const digest of result.page) {
      if (!digest.latestReleaseId) continue;
      const release = await ctx.db.get(digest.latestReleaseId);
      if (!release || release.softDeletedAt || release.packageId !== digest.packageId) continue;
      const scanState = await ctx.db
        .query("packageInspectorScanStates")
        .withIndex("by_release_and_completed_at", (q) => q.eq("releaseId", release._id))
        .order("desc")
        .first();
      // CLAW-626 reconciles nightly findings per release and preserves publish/static findings.
      // Matching the selected tuple also fails closed if stale nightly rows survive a partial rollout.
      const storedWarnings = await ctx.db
        .query("packageInspectorWarnings")
        .withIndex("by_release_created", (q) => q.eq("releaseId", release._id))
        .order("asc")
        .collect();
      const warnings = storedWarnings.filter(
        (warning) =>
          warning.scanSource !== "nightly" ||
          (scanState !== null &&
            warning.inspectorVersion === scanState.inspectorVersion &&
            warning.targetOpenClawVersion === scanState.targetOpenClawVersion),
      );
      const findings = warnings.map(normalizePackageValidationFinding);
      const status = findings.some((finding) => finding.severity === "error")
        ? ("error" as const)
        : findings.length > 0
          ? ("warning" as const)
          : !scanState
            ? ("not-scanned" as const)
            : ("clean" as const);
      items.push({
        package: {
          id: String(digest.packageId),
          name: digest.name,
          displayName: digest.displayName,
        },
        release: {
          id: String(release._id),
          version: release.version,
          createdAt: release.createdAt,
        },
        references: {
          packagePage: `/plugins/${encodeURIComponent(digest.name)}`,
          release: `${digest.name}@${release.version}`,
        },
        scan: {
          status,
          scannedAt: scanState?.completedAt ?? null,
          target: scanState
            ? { channel: "beta" as const, version: scanState.targetOpenClawVersion }
            : null,
          inspectorVersion: scanState?.inspectorVersion ?? null,
          skipReason: null,
        },
        findings,
      });
    }
    return {
      items,
      nextCursor: result.nextCursor,
      done: !result.hasMore,
    };
  },
});

export const listPageForViewerInternal = internalQuery({
  args: {
    family: v.optional(
      v.union(
        v.literal("skill"),
        v.literal("code-plugin"),
        v.literal("bundle-plugin"),
        v.literal("claw"),
      ),
    ),
    families: v.optional(
      v.array(v.union(v.literal("skill"), v.literal("code-plugin"), v.literal("bundle-plugin"))),
    ),
    channel: v.optional(
      v.union(v.literal("official"), v.literal("community"), v.literal("private")),
    ),
    isOfficial: v.optional(v.boolean()),
    highlightedOnly: v.optional(v.boolean()),
    category: v.optional(v.string()),
    topic: v.optional(v.string()),
    officialFirst: v.optional(v.boolean()),
    excludedScanStatuses: v.optional(v.array(packageListScanStatusValidator)),
    sort: v.optional(
      v.union(
        v.literal("updated"),
        v.literal("downloads"),
        v.literal("recommended"),
        v.literal("installs"),
        v.literal("trending"),
      ),
    ),
    viewerUserId: v.optional(v.id("users")),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    return await listPackagePageImpl(ctx, args);
  },
});

export const countPublicPluginsInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await readGlobalPublicPluginsCount(ctx);
  },
});

export const hasMissingRecommendationScoresInternal = internalQuery({
  args: {
    families: v.optional(
      v.array(v.union(v.literal("skill"), v.literal("code-plugin"), v.literal("bundle-plugin"))),
    ),
  },
  handler: async (ctx, args) => {
    if (!args.families || args.families.length === 0) {
      return await hasMissingPackageRecommendedScore(ctx, undefined);
    }
    for (const family of args.families) {
      if (await hasMissingPackageRecommendedScore(ctx, family)) return true;
    }
    return false;
  },
});

export const countPublicPlugins = query({
  args: {},
  handler: async (ctx) => {
    const statsCount = await readGlobalPublicPluginsCount(ctx);
    return statsCount ?? 0;
  },
});

function compareStablePackageDiscoveryCandidates(
  a: PackageDigestLike,
  b: PackageDigestLike,
  sort: "updated" | "created" | "downloads" | "recommended" | "installs",
) {
  const metric = (candidate: PackageDigestLike) => {
    if (sort === "downloads") return candidate.stats?.downloads ?? 0;
    if (sort === "installs") return candidate.stats?.installs ?? 0;
    if (sort === "recommended") return candidate.recommendedScore ?? 0;
    if (sort === "created") return candidate.createdAt;
    return candidate.updatedAt;
  };
  const metricDiff = metric(b) - metric(a);
  if (metricDiff !== 0) return metricDiff;
  const updatedDiff = b.updatedAt - a.updatedAt;
  if (updatedDiff !== 0) return updatedDiff;
  const familyDiff = a.family.localeCompare(b.family);
  if (familyDiff !== 0) return familyDiff;
  return a.name.localeCompare(b.name);
}

async function listStablePackageDiscoveryPage(
  ctx: DbReaderCtx,
  args: {
    families?: StablePackageFamily[];
    channel?: PackageChannel;
    isOfficial?: boolean;
    category?: PluginCategorySlug;
    topic?: string;
    excludedScanStatuses?: PackageListScanStatus[];
    sort?: "updated" | "created" | "downloads" | "recommended" | "installs";
    createdAfter?: number;
    viewerUserId?: Id<"users">;
    paginationOpts: { cursor: string | null; numItems: number };
  },
): Promise<PublicPackageListPage> {
  const targetCount = Math.max(
    1,
    Math.min(args.paginationOpts.numItems, MAX_PUBLIC_LIST_PAGE_SIZE),
  );
  const requestedSort = args.sort ?? "updated";
  const cursorSort =
    requestedSort === "recommended"
      ? readStablePackageDiscoveryCursorSort(args.paginationOpts.cursor)
      : null;
  let sort = cursorSort ?? requestedSort;
  if (!cursorSort && requestedSort === "recommended") {
    const recommendationScoresMissing = (
      await Promise.all(
        STABLE_PACKAGE_FAMILIES.map(
          async (family) => await hasMissingPackageRecommendedScore(ctx, family),
        ),
      )
    ).some(Boolean);
    if (recommendationScoresMissing) sort = "updated";
  }
  const cursor = decodeStablePackageDiscoveryCursor(args.paginationOpts.cursor, sort);
  const families = args.families ?? [...STABLE_PACKAGE_FAMILIES];
  for (const family of STABLE_PACKAGE_FAMILIES) {
    if (!families.includes(family)) cursor.sources[family].done = true;
  }
  const scanLimit = Math.min(MAX_PUBLIC_LIST_PAGE_SIZE, Math.max(targetCount * 5, 50));
  const loadFamily = async (family: StablePackageFamily) => {
    const state = cursor.sources[family];
    if (state.done) {
      return { family, rows: [] as PackageDigestLike[], keys: [] as IndexKey[], hasMore: false };
    }
    const eqPrefix: IndexKey = [undefined, family];
    if (sort === "updated" || sort === "created") {
      const index = sort === "created" ? "by_active_family_created" : "by_active_family_updated";
      const result = await getPage(ctx, {
        table: "packageSearchDigest",
        index,
        startIndexKey: state.key ?? eqPrefix,
        startInclusive: state.key === null,
        endIndexKey:
          sort === "created" && args.createdAfter !== undefined
            ? [undefined, family, args.createdAfter]
            : eqPrefix,
        endInclusive: true,
        order: "desc",
        absoluteMaxRows: scanLimit,
        schema,
      });
      return {
        family,
        rows: result.page as PackageDigestLike[],
        keys: result.indexKeys,
        hasMore: result.hasMore,
      };
    }
    const index =
      sort === "downloads"
        ? "by_active_family_downloads"
        : sort === "installs"
          ? "by_active_family_installs"
          : "by_active_family_recommended_score";
    const result = await getPage(ctx, {
      table: "packages",
      index,
      startIndexKey: state.key ?? eqPrefix,
      startInclusive: state.key === null,
      endIndexKey: eqPrefix,
      endInclusive: true,
      order: "desc",
      absoluteMaxRows: scanLimit,
      schema,
    });
    return {
      family,
      rows: result.page.map(extractPackageDigestFields),
      keys: result.indexKeys,
      hasMore: result.hasMore,
    };
  };
  const familyPages = await Promise.all(families.map(async (family) => await loadFamily(family)));
  const membershipCache = new Map<string, Promise<boolean>>();
  const page: PublicPackageListItem[] = [];
  const consumedByFamily = new Map<StablePackageFamily, number>();
  while (page.length < targetCount) {
    // Merge only the current head from each source so every persisted source
    // cursor advances through a contiguous prefix of that source's index order.
    const candidate = familyPages
      .flatMap((source) => {
        const index = consumedByFamily.get(source.family) ?? 0;
        const row = source.rows[index];
        return row ? [{ family: source.family, row, key: source.keys[index] }] : [];
      })
      .sort((a, b) => compareStablePackageDiscoveryCandidates(a.row, b.row, sort))[0];
    if (!candidate) break;
    const digest = candidate.row;
    consumedByFamily.set(candidate.family, (consumedByFamily.get(candidate.family) ?? 0) + 1);
    cursor.sources[candidate.family].key = candidate.key;
    if (!digestMatchesSearchFilters(digest, args)) continue;
    if (!(await canViewerReadPackage(ctx, digest, args.viewerUserId, membershipCache))) continue;
    page.push(await toPublicPackageListItem(ctx, digest));
  }
  for (const source of familyPages) {
    const consumed = consumedByFamily.get(source.family) ?? 0;
    cursor.sources[source.family].done = consumed === source.rows.length && !source.hasMore;
  }
  const hasMore = families.some((family) => !cursor.sources[family].done);
  return {
    page,
    isDone: !hasMore,
    continueCursor: hasMore ? encodeStablePackageDiscoveryCursor(cursor) : "",
  };
}

async function listPackagePageImpl(
  ctx: DbReaderCtx,
  args: {
    family?: PackageFamily;
    families?: PackageFamily[];
    channel?: PackageChannel;
    isOfficial?: boolean;
    highlightedOnly?: boolean;
    category?: string;
    topic?: string;
    officialFirst?: boolean;
    excludedScanStatuses?: PackageListScanStatus[];
    sort?: "updated" | "downloads" | "recommended" | "installs" | "trending";
    viewerUserId?: Id<"users">;
    paginationOpts: { cursor: string | null; numItems: number };
  },
): Promise<PublicPackageListPage> {
  if (args.channel === "private" && !args.viewerUserId) {
    return { page: [], isDone: true, continueCursor: "" };
  }
  if (args.families?.length && !args.highlightedOnly) {
    throw new Error("families is only supported for highlighted package pages");
  }
  if (args.category && !isPluginCategorySlug(args.category)) {
    return { page: [], isDone: true, continueCursor: "" };
  }
  const viewerUserId = args.viewerUserId;
  const membershipCache = new Map<string, Promise<boolean>>();
  const canViewPackage = async (digest: PackageDigestLike) =>
    await canViewerReadPackage(ctx, digest, viewerUserId, membershipCache);
  const targetCount = args.paginationOpts.numItems;
  const category = isPluginCategorySlug(args.category) ? args.category : undefined;
  const topic = args.topic ? normalizeCatalogTopic(args.topic) : undefined;
  const hasCatalogMetadataFilter = Boolean(category || topic);
  if (args.topic !== undefined && !topic) {
    return { page: [], isDone: true, continueCursor: "" };
  }

  if (args.sort === "trending") {
    const leaderboard = await ctx.db
      .query("packageLeaderboards")
      .withIndex("by_kind", (q) => q.eq("kind", PACKAGE_TRENDING_LEADERBOARD_KIND))
      .order("desc")
      .first();
    if (!leaderboard) return { page: [], isDone: true, continueCursor: "" };

    const cursorState = decodePublicPageCursor(args.paginationOpts.cursor);
    const startIndex = cursorState.sort === "trending" ? cursorState.offset : 0;
    const page: PublicPackageListItem[] = [];
    let nextOffset = startIndex;
    for (let index = startIndex; index < leaderboard.items.length; index += 1) {
      const entry = leaderboard.items[index];
      nextOffset = index + 1;
      const pkg = await ctx.db.get(entry.packageId);
      if (!pkg || pkg.softDeletedAt) continue;
      if (!(await canViewerReadPackage(ctx, pkg, viewerUserId, membershipCache))) continue;
      if (!packageMatchesListFilters(pkg, { ...args, category, topic })) continue;
      page.push(await toPublicPackageListItemFromPackage(ctx, pkg));
      if (page.length >= targetCount) break;
    }
    const isDone = nextOffset >= leaderboard.items.length;
    return {
      page,
      isDone,
      continueCursor: isDone
        ? ""
        : encodePublicPageCursor({
            cursor: null,
            offset: nextOffset,
            pageSize: targetCount,
            done: false,
            mode: "packages",
            sort: "trending",
          }),
    };
  }

  if (args.officialFirst && category && typeof args.isOfficial !== "boolean") {
    return await listOfficialFirstPackageCategoryPage(ctx, {
      ...args,
      category,
      topic,
    });
  }

  if (args.highlightedOnly) {
    const page = await fetchHighlightedPackagePage(ctx, {
      ...args,
      category,
      topic,
      numItems: targetCount,
    });
    return { page, isDone: true, continueCursor: "" };
  }

  if (!args.family && !experimentalClawsEnabled()) {
    return await listStablePackageDiscoveryPage(ctx, {
      channel: args.channel,
      isOfficial: args.isOfficial,
      category,
      topic,
      excludedScanStatuses: args.excludedScanStatuses,
      sort: args.sort,
      viewerUserId: args.viewerUserId,
      paginationOpts: args.paginationOpts,
    });
  }

  const collected: PublicPackageListItem[] = [];
  const family = args.family;
  const channel = args.channel;
  const isOfficial = args.isOfficial;
  const decodedCursor = decodePublicPageCursor(args.paginationOpts.cursor);
  if (decodedCursor.done && decodedCursor.offset === 0) {
    return { page: collected, isDone: true, continueCursor: "" };
  }
  const pageCursor = decodedCursor.cursor;
  const offset = decodedCursor.offset;
  const sortedPackageIndex =
    family &&
    args.sort === "downloads" &&
    typeof isOfficial === "boolean" &&
    (!args.paginationOpts.cursor || decodedCursor.packageIndex === "family-official-downloads")
      ? ("family-official-downloads" as const)
      : undefined;
  const effectivePageSize = Math.min(
    MAX_PUBLIC_LIST_PAGE_SIZE,
    Math.max(
      targetCount,
      decodedCursor.pageSize ?? 0,
      offset > 0 ? offset + targetCount : targetCount,
    ),
  );

  const keepDigestCursor = args.sort === "recommended" && decodedCursor.mode === "digest";
  const keepRecommendedPackageCursor =
    args.sort === "recommended" &&
    Boolean(args.paginationOpts.cursor) &&
    decodedCursor.mode !== "digest";
  const recommendedIndexName =
    args.sort === "recommended" && !keepDigestCursor
      ? keepRecommendedPackageCursor
        ? getPackageRecommendedScoreIndexName(family)
        : await getPackageRecommendedIndexName(ctx, family)
      : null;
  // Digest cursors created before sort persistence always came from updated indexes.
  const effectiveDigestSort =
    decodedCursor.mode === "digest"
      ? (decodedCursor.sort ?? "updated")
      : args.sort === "recommended"
        ? recommendedIndexName
          ? "recommended"
          : "updated"
        : args.sort;

  if (
    !hasCatalogMetadataFilter &&
    (args.sort === "downloads" || args.sort === "installs" || recommendedIndexName)
  ) {
    let cursor = pageCursor;
    let pageOffset = offset;
    let pageSize: number | null = decodedCursor.pageSize ?? null;
    let done = decodedCursor.done;
    const buildSortedQuery = () => {
      if (family) {
        if (sortedPackageIndex === "family-official-downloads" && typeof isOfficial === "boolean") {
          return ctx.db
            .query("packages")
            .withIndex("by_active_family_official_downloads", (q) =>
              q.eq("softDeletedAt", undefined).eq("family", family).eq("isOfficial", isOfficial),
            );
        }
        if (args.sort === "installs" && typeof isOfficial === "boolean") {
          return ctx.db
            .query("packages")
            .withIndex("by_active_family_official_installs", (q) =>
              q.eq("softDeletedAt", undefined).eq("family", family).eq("isOfficial", isOfficial),
            );
        }
        const indexName =
          args.sort === "installs"
            ? "by_active_family_installs"
            : (recommendedIndexName ?? "by_active_family_downloads");
        return ctx.db
          .query("packages")
          .withIndex(indexName, (q) => q.eq("softDeletedAt", undefined).eq("family", family));
      }
      const indexName =
        args.sort === "installs"
          ? "by_active_installs"
          : (recommendedIndexName ?? "by_active_downloads");
      return ctx.db.query("packages").withIndex(indexName, (q) => q.eq("softDeletedAt", undefined));
    };

    if (pageOffset > 0 || !done) {
      const scanPageSize = Math.min(
        MAX_PUBLIC_LIST_PAGE_SIZE,
        pageOffset > 0 && pageSize
          ? Math.max(pageSize, pageOffset + targetCount)
          : Math.max(targetCount * 5, targetCount, 50),
      );
      const currentCursor = cursor;
      const page = await buildSortedQuery()
        .order("desc")
        .paginate({ cursor: currentCursor, numItems: scanPageSize });

      for (let index = pageOffset; index < page.page.length; index += 1) {
        const pkg = page.page[index];
        if (!(await canViewerReadPackage(ctx, pkg, viewerUserId, membershipCache))) continue;
        if (!packageMatchesListFilters(pkg, { ...args, category, topic })) continue;
        collected.push(await toPublicPackageListItemFromPackage(ctx, pkg));
        if (collected.length >= targetCount) {
          const nextOffset = index + 1;
          const nextState =
            nextOffset < page.page.length
              ? {
                  cursor: currentCursor,
                  offset: nextOffset,
                  pageSize: scanPageSize,
                  done: page.isDone,
                  mode: "packages" as const,
                  packageIndex: sortedPackageIndex,
                }
              : {
                  cursor: page.continueCursor,
                  offset: 0,
                  pageSize: scanPageSize,
                  done: page.isDone,
                  mode: "packages" as const,
                  packageIndex: sortedPackageIndex,
                };
          return {
            page: collected,
            isDone: nextState.done && nextState.offset === 0,
            continueCursor: encodePublicPageCursor(nextState),
          };
        }
      }

      done = page.isDone;
      cursor = page.continueCursor;
      pageOffset = 0;
      pageSize = scanPageSize;
    }

    return {
      page: collected,
      isDone: done,
      continueCursor: encodePublicPageCursor({
        cursor,
        offset: pageOffset,
        pageSize,
        done,
        mode: "packages",
        packageIndex: sortedPackageIndex,
      }),
    };
  }

  const buildDigestQuery = () =>
    topic
      ? buildPackageTopicDigestQuery(ctx, {
          topic,
          family,
          channel,
          isOfficial,
          sort: effectiveDigestSort,
        })
      : category
        ? buildPackagePluginCategoryDigestQuery(ctx, {
            category,
            family,
            channel,
            isOfficial,
            sort: effectiveDigestSort,
          })
        : buildPackageDigestQuery(ctx, {
            family,
            channel,
            isOfficial,
          });
  let cursor = pageCursor;
  let pageOffset = offset;
  let pageSize: number | null = decodedCursor.pageSize ?? null;
  let done = decodedCursor.done;
  const requiresDigestPostFilterScan =
    hasCatalogMetadataFilter || Boolean(args.excludedScanStatuses?.length);
  let digestScanPages = 0;
  let remainingDigestScanBudget = requiresDigestPostFilterScan
    ? MAX_PUBLIC_LIST_FILTER_SCAN_DOCUMENTS
    : MAX_PUBLIC_LIST_PAGE_SIZE;

  if (
    (pageOffset > 0 || !done) &&
    collected.length < targetCount &&
    digestScanPages < MAX_PUBLIC_LIST_FILTER_SCAN_PAGES &&
    remainingDigestScanBudget > 0
  ) {
    const scanPageSize = Math.min(
      remainingDigestScanBudget,
      MAX_PUBLIC_LIST_PAGE_SIZE,
      pageOffset > 0 && pageSize
        ? Math.max(pageSize, pageOffset + targetCount)
        : Math.max(effectivePageSize, targetCount),
    );
    if (scanPageSize > 0) {
      digestScanPages += 1;
      remainingDigestScanBudget -= scanPageSize;
      const currentCursor = cursor;
      const page: {
        page: PackageDigestLike[];
        isDone: boolean;
        continueCursor: string;
      } = await buildDigestQuery()
        .order("desc")
        .paginate({ cursor: currentCursor, numItems: scanPageSize });

      for (let index = pageOffset; index < page.page.length; index += 1) {
        const digest = page.page[index] as PackageDigestLike;
        if (!(await canViewPackage(digest))) continue;
        if (family && digest.family !== family) continue;
        if (channel && digest.channel !== channel) continue;
        if (typeof isOfficial === "boolean" && digest.isOfficial !== isOfficial) {
          continue;
        }
        if (!digestMatchesFilters(digest, { ...args, category, topic })) continue;
        collected.push(await toPublicPackageListItem(ctx, digest));
        if (collected.length >= targetCount) {
          const nextOffset = index + 1;
          const nextState =
            nextOffset < page.page.length
              ? {
                  cursor: currentCursor,
                  offset: nextOffset,
                  pageSize: scanPageSize,
                  done: page.isDone,
                  mode: "digest" as const,
                  sort: effectiveDigestSort,
                }
              : {
                  cursor: page.continueCursor,
                  offset: 0,
                  pageSize: scanPageSize,
                  done: page.isDone,
                  mode: "digest" as const,
                  sort: effectiveDigestSort,
                };
          return {
            page: collected,
            isDone: nextState.done && nextState.offset === 0,
            continueCursor: encodePublicPageCursor(nextState),
          };
        }
      }

      done = page.isDone;
      cursor = page.continueCursor;
      pageOffset = 0;
      pageSize = scanPageSize;
    }
  }

  return {
    page: collected,
    isDone: done,
    continueCursor: encodePublicPageCursor({
      cursor,
      offset: pageOffset,
      pageSize,
      done,
      mode: "digest",
      sort: effectiveDigestSort,
    }),
  };
}

async function listOfficialFirstPackageCategoryPage(
  ctx: DbReaderCtx,
  args: {
    family?: PackageFamily;
    channel?: PackageChannel;
    highlightedOnly?: boolean;
    category: PluginCategorySlug;
    topic?: string;
    excludedScanStatuses?: PackageListScanStatus[];
    sort?: "updated" | "downloads" | "recommended" | "installs" | "trending";
    viewerUserId?: Id<"users">;
    paginationOpts: { cursor: string | null; numItems: number };
  },
): Promise<PublicPackageListPage> {
  const state = decodeOfficialFirstPackageCategoryCursor(args.paginationOpts.cursor);
  const targetCount = args.paginationOpts.numItems;
  const collected: PublicPackageListItem[] = [];

  if (state.phase === "official") {
    const officialPage = await listPackagePageImpl(ctx, {
      ...args,
      officialFirst: false,
      isOfficial: true,
      paginationOpts: {
        cursor: state.cursor,
        numItems: targetCount,
      },
    });
    collected.push(...officialPage.page);
    if (!officialPage.isDone) {
      return {
        page: collected,
        isDone: false,
        continueCursor: encodeOfficialFirstPackageCategoryCursor({
          phase: "official",
          cursor: officialPage.continueCursor,
        }),
      };
    }
    if (collected.length >= targetCount) {
      const mayHaveCommunityPage = args.highlightedOnly
        ? (
            await listPackagePageImpl(ctx, {
              ...args,
              officialFirst: false,
              isOfficial: false,
              paginationOpts: {
                cursor: null,
                numItems: 1,
              },
            })
          ).page.length > 0
        : await mayHaveVisiblePackageCategoryDigest(ctx, {
            ...args,
            isOfficial: false,
          });
      return {
        page: collected,
        isDone: !mayHaveCommunityPage,
        continueCursor: mayHaveCommunityPage
          ? encodeOfficialFirstPackageCategoryCursor({
              phase: "community",
              cursor: null,
            })
          : "",
      };
    }
    const communityPage = args.highlightedOnly
      ? await listPackagePageImpl(ctx, {
          ...args,
          officialFirst: false,
          isOfficial: false,
          paginationOpts: {
            cursor: null,
            numItems: targetCount - collected.length,
          },
        })
      : await takeVisiblePackageCategoryDigestPage(ctx, {
          ...args,
          isOfficial: false,
          numItems: targetCount - collected.length,
        });
    collected.push(...communityPage.page);
    return {
      page: collected,
      isDone: communityPage.isDone,
      continueCursor: communityPage.isDone
        ? ""
        : encodeOfficialFirstPackageCategoryCursor({
            phase: "community",
            cursor: communityPage.continueCursor,
          }),
    };
  }

  const communityPage = await listPackagePageImpl(ctx, {
    ...args,
    officialFirst: false,
    isOfficial: false,
    paginationOpts: {
      cursor: state.phase === "community" ? state.cursor : null,
      numItems: targetCount - collected.length,
    },
  });
  collected.push(...communityPage.page);
  return {
    page: collected,
    isDone: communityPage.isDone,
    continueCursor: communityPage.isDone
      ? ""
      : encodeOfficialFirstPackageCategoryCursor({
          phase: "community",
          cursor: communityPage.continueCursor,
        }),
  };
}

export const searchPublic = query({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    family: v.optional(
      v.union(
        v.literal("skill"),
        v.literal("code-plugin"),
        v.literal("bundle-plugin"),
        v.literal("claw"),
      ),
    ),
    channel: v.optional(
      v.union(v.literal("official"), v.literal("community"), v.literal("private")),
    ),
    isOfficial: v.optional(v.boolean()),
    highlightedOnly: v.optional(v.boolean()),
    category: v.optional(v.string()),
    topic: v.optional(v.string()),
    createdAfter: v.optional(v.number()),
    excludedScanStatuses: v.optional(v.array(packageListScanStatusValidator)),
  },
  handler: async (ctx, args) => {
    return (await searchPackagesImpl(ctx, args)).map(toPublicPackageSearchEntry);
  },
});

export const searchForViewerInternal = internalQuery({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    family: v.optional(
      v.union(
        v.literal("skill"),
        v.literal("code-plugin"),
        v.literal("bundle-plugin"),
        v.literal("claw"),
      ),
    ),
    channel: v.optional(
      v.union(v.literal("official"), v.literal("community"), v.literal("private")),
    ),
    isOfficial: v.optional(v.boolean()),
    highlightedOnly: v.optional(v.boolean()),
    category: v.optional(v.string()),
    topic: v.optional(v.string()),
    createdAfter: v.optional(v.number()),
    excludedScanStatuses: v.optional(v.array(packageListScanStatusValidator)),
    viewerUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    return await searchPackagesImpl(ctx, args);
  },
});

async function searchPackagesImpl(
  ctx: DbReaderCtx,
  args: {
    query: string;
    limit?: number;
    family?: PackageFamily;
    channel?: PackageChannel;
    isOfficial?: boolean;
    highlightedOnly?: boolean;
    category?: string;
    topic?: string;
    createdAfter?: number;
    excludedScanStatuses?: PackageListScanStatus[];
    viewerUserId?: Id<"users">;
  },
) {
  const queryText = args.query.trim().toLowerCase();
  if (!queryText) return [];
  if (args.category && !isPluginCategorySlug(args.category)) return [];
  if (args.channel === "private" && !args.viewerUserId) return [];
  const targetCount = Math.max(1, Math.min(args.limit ?? 20, 100));
  const viewerUserId = args.viewerUserId;
  const membershipCache = new Map<string, Promise<boolean>>();
  const canViewPackage = async (digest: PackageDigestLike) =>
    await canViewerReadPackage(ctx, digest, viewerUserId, membershipCache);
  const category = isPluginCategorySlug(args.category) ? args.category : undefined;
  const topic = args.topic ? normalizeCatalogTopic(args.topic) : undefined;
  if (args.topic !== undefined && !topic) return [];
  if (args.highlightedOnly) {
    const highlightedEntries = await fetchHighlightedPackageEntries(ctx, {
      ...args,
      category,
      topic,
    });
    const entries = highlightedEntries
      .filter(({ digest }) => isClawFamilyPubliclyVisible(digest.family))
      .filter(({ digest }) =>
        args.createdAfter === undefined ? true : digest.createdAt >= args.createdAfter,
      )
      .filter(
        ({ digest }) =>
          !digest.scanStatus || !args.excludedScanStatuses?.includes(digest.scanStatus),
      )
      .map(({ digest, featuredAt }) => {
        const match = packageSearchMatch(digest, queryText);
        return match ? { ...match, package: digest, featuredAt } : null;
      })
      .filter(
        (
          entry,
        ): entry is PackageSearchMatch & {
          package: PackageDigestLike;
          featuredAt: number;
        } => Boolean(entry),
      )
      .sort(comparePackageSearchMatches)
      .slice(0, targetCount);
    const results: Array<PackageSearchMatch & { package: PublicPackageListItem }> = [];
    for (const entry of entries) {
      results.push({
        score: entry.score,
        rankTier: entry.rankTier,
        package: await toPublicPackageListItem(ctx, entry.package, entry.featuredAt),
      });
    }
    return results;
  }

  const searchFamilies =
    !args.family && !experimentalClawsEnabled()
      ? ([...STABLE_PACKAGE_FAMILIES] as PackageFamily[])
      : [args.family];
  const buildSearchDigestQuery = (
    family: PackageFamily | undefined,
    isOfficial = args.isOfficial,
  ) =>
    topic
      ? buildPackageTopicDigestQuery(ctx, {
          topic,
          family,
          channel: args.channel,
          isOfficial,
        })
      : category
        ? buildPackagePluginCategoryDigestQuery(ctx, {
            category,
            family,
            channel: args.channel,
            isOfficial,
          })
        : buildPackageDigestQuery(ctx, {
            family,
            channel: args.channel,
            isOfficial,
          });
  const matches: Array<PackageSearchMatch & { package: PublicPackageListItem }> = [];
  const seen = new Set<string>();
  const shouldRecallOfficial =
    args.isOfficial === undefined && args.channel !== "community" && args.channel !== "private";
  const [highlightedEntries, officialDigestGroups, directDigests] = await Promise.all([
    fetchHighlightedPackageEntries(ctx, { ...args, category, topic }),
    shouldRecallOfficial
      ? Promise.all(
          searchFamilies.map(async (family) =>
            buildSearchDigestQuery(family, true).order("desc").take(MAX_PUBLIC_LIST_PAGE_SIZE),
          ),
        )
      : Promise.resolve([]),
    category && !topic
      ? Promise.resolve([])
      : Promise.all(
          searchFamilies.map(
            async (family) => await resolveDirectPackageSearchDigests(ctx, queryText, family),
          ),
        ).then((results) => results.flat()),
  ]);
  const featuredAtByPackage = new Map(
    highlightedEntries.map(({ digest, featuredAt }) => [String(digest.packageId), featuredAt]),
  );
  // Curated recall is still subject to the same filters and text matcher below.
  // It only ensures Official and Featured matches are present before the result limit is applied.
  const candidateDigests = [
    ...highlightedEntries.map(({ digest }) => digest),
    ...officialDigestGroups.flat().filter((digest) => digest.isOfficial),
    ...directDigests,
  ];
  for (const digest of candidateDigests) {
    if (!(await canViewPackage(digest))) continue;
    if (!digestMatchesSearchFilters(digest, { ...args, topic })) continue;
    const match = packageSearchMatch(digest, queryText);
    if (!match || seen.has(digest.packageId)) continue;
    seen.add(digest.packageId);
    matches.push({
      ...match,
      package: await toPublicPackageListItem(
        ctx,
        digest,
        featuredAtByPackage.get(String(digest.packageId)),
      ),
    });
  }

  // Demoted exact hits never satisfy the collection quota: the fallback scan
  // must still gather the adopted lexical alternatives they are ranked against
  // (top-1 queries would otherwise return a name squat unchallenged).
  const authoritativeMatchCount = () =>
    matches.filter((entry) => !isDemotedExactMatch(entry, packageTrustSignals(entry.package)))
      .length;

  if (authoritativeMatchCount() < targetCount) {
    const scanLimit = Math.min(MAX_SEARCH_PAGE_SIZE, Math.max(targetCount * 5, 50));
    const collectDigestMatches = async (digests: PackageDigestLike[]) => {
      for (const digest of digests) {
        if (!(await canViewPackage(digest))) continue;
        if (!digestMatchesSearchFilters(digest, { ...args, topic })) continue;
        const match = packageSearchMatch(digest, queryText);
        if (!match || seen.has(digest.packageId)) continue;
        seen.add(digest.packageId);
        matches.push({
          ...match,
          package: await toPublicPackageListItem(
            ctx,
            digest,
            featuredAtByPackage.get(String(digest.packageId)),
          ),
        });
      }
    };

    if ((topic && category) || args.createdAfter !== undefined) {
      const scanStates = searchFamilies.map((family) => ({
        family,
        cursor: null as string | null,
        isDone: false,
        pagesScanned: 0,
      }));
      let remainingScanBudget = MAX_PUBLIC_LIST_FILTER_SCAN_DOCUMENTS;
      while (
        authoritativeMatchCount() < targetCount &&
        scanStates.some(
          (state) => !state.isDone && state.pagesScanned < MAX_PUBLIC_LIST_FILTER_SCAN_PAGES,
        ) &&
        remainingScanBudget > 0
      ) {
        // Finish each round before checking the match quota so the fixed family
        // order cannot decide global relevance or consume another family's cap.
        for (const state of scanStates) {
          if (
            state.isDone ||
            state.pagesScanned >= MAX_PUBLIC_LIST_FILTER_SCAN_PAGES ||
            remainingScanBudget <= 0
          ) {
            continue;
          }
          const pageSize = Math.min(scanLimit, remainingScanBudget);
          const page: {
            page: PackageDigestLike[];
            isDone: boolean;
            continueCursor: string;
          } = await buildSearchDigestQuery(state.family)
            .order("desc")
            .paginate({ cursor: state.cursor, numItems: pageSize });
          state.pagesScanned += 1;
          remainingScanBudget -= pageSize;
          await collectDigestMatches(page.page);
          state.cursor = page.continueCursor;
          state.isDone = page.isDone;
        }
      }
    } else {
      const digests = (
        await Promise.all(
          searchFamilies.map(
            async (family) =>
              (await buildSearchDigestQuery(family)
                .order("desc")
                .take(scanLimit)) as PackageDigestLike[],
          ),
        )
      ).flat();
      await collectDigestMatches(digests);
    }
  }

  return matches.sort(comparePackageSearchMatches).slice(0, targetCount);
}

export const getPackageByNameInternal = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    return await getPackageByNormalizedName(ctx, normalizePackageName(args.name));
  },
});

export const findPackagePublishResultInternal = internalQuery({
  args: {
    name: v.string(),
    version: v.string(),
    integritySha256: v.string(),
    clawpackSha256: v.optional(v.string()),
    ownerUserId: v.id("users"),
    ownerPublisherId: v.optional(v.id("publishers")),
  },
  handler: async (ctx, args) => {
    const pkg = await getPackageByNormalizedName(ctx, normalizePackageName(args.name));
    if (!pkg) return null;
    if (getPackageOwnerKey(pkg) !== getRequestedPackageOwnerKey(args)) return null;
    const release = await ctx.db
      .query("packageReleases")
      .withIndex("by_package_version", (q) =>
        q.eq("packageId", pkg._id).eq("version", args.version),
      )
      .unique();
    const matchesExactClawArtifact =
      pkg.family !== "claw" ||
      (typeof args.clawpackSha256 === "string" && release?.clawpackSha256 === args.clawpackSha256);
    if (
      !isPublishedPackageRelease(release) ||
      release.integritySha256 !== args.integritySha256 ||
      !matchesExactClawArtifact
    ) {
      return null;
    }
    return { ok: true as const, packageId: pkg._id, releaseId: release._id };
  },
});

async function buildPackageActivityTrend(ctx: DbReaderCtx, pkg: Doc<"packages">, endDay: number) {
  const safeEndDay = clampActivityTrendEndDay(endDay, Date.now());
  const { startDay, endDay: normalizedEndDay } = getActivityTrendRangeForEndDay(safeEndDay);
  const rows = await ctx.db
    .query("packageDailyStats")
    .withIndex("by_package_day", (q) =>
      q.eq("packageId", pkg._id).gte("day", startDay).lte("day", normalizedEndDay),
    )
    .take(ACTIVITY_TREND_DAYS);

  return buildDailyMetricTrends(rows, normalizedEndDay);
}

export const getActivityTrendForName = query({
  args: { name: v.string(), endDay: v.number() },
  handler: async (ctx, args) => {
    const viewerUserId = await getOptionalViewerUserId(ctx);
    const pkg = await getReadablePackageByName(ctx, args.name, viewerUserId);
    if (!pkg) return null;

    return await buildPackageActivityTrend(ctx, pkg, args.endDay);
  },
});

export const recordPackageDownloadInternal = internalMutation({
  args: { packageId: v.id("packages") },
  handler: async (ctx, args) => {
    await ctx.db.insert("packageStatEvents", {
      packageId: args.packageId,
      kind: "download",
      occurredAt: Date.now(),
      processedAt: undefined,
    });
  },
});

export const recordPackageInstallInternal = internalMutation({
  args: {
    packageId: v.id("packages"),
    identityKind: v.optional(v.union(v.literal("user"), v.literal("ip"))),
    identityHash: v.optional(v.string()),
    dayStart: v.optional(v.number()),
    occurredAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identityKind = args.identityKind;
    const identityHash = args.identityHash;
    const dayStart = args.dayStart;
    if (identityKind && identityHash && typeof dayStart === "number") {
      const existing = await ctx.db
        .query("packageInstallMetricDedupes")
        .withIndex("by_target_metric_identity_day", (q) =>
          q
            .eq("targetKind", "package")
            .eq("targetId", args.packageId)
            .eq("metricKind", "install")
            .eq("identityKind", identityKind)
            .eq("identityHash", identityHash)
            .eq("dayStart", dayStart),
        )
        .unique();
      if (existing) return;

      await ctx.db.insert("packageInstallMetricDedupes", {
        targetKind: "package",
        targetId: args.packageId,
        metricKind: "install",
        identityKind,
        identityHash,
        dayStart,
        createdAt: Date.now(),
      });
    }

    await insertPackageInstallStatEvent(ctx, {
      packageId: args.packageId,
      occurredAt: args.occurredAt,
    });
  },
});

async function bumpDailyPackageStats(
  ctx: MutationCtx,
  params: {
    packageId: Id<"packages">;
    day: number;
    downloads: number;
    installs: number;
    now: number;
  },
) {
  if (params.downloads === 0 && params.installs === 0) return;
  assertRankingMetricWritesAllowed();

  const existing = await ctx.db
    .query("packageDailyStats")
    .withIndex("by_package_day", (q) => q.eq("packageId", params.packageId).eq("day", params.day))
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      downloads: Math.max(0, existing.downloads + params.downloads),
      installs: Math.max(0, existing.installs + params.installs),
      updatedAt: params.now,
    });
    return;
  }

  await ctx.db.insert("packageDailyStats", {
    packageId: params.packageId,
    day: params.day,
    downloads: Math.max(0, params.downloads),
    installs: Math.max(0, params.installs),
    updatedAt: params.now,
  });
}

type PackageDailyStatsDelta = {
  packageId: Id<"packages">;
  day: number;
  downloads: number;
  installs: number;
};

export const processPackageStatEventsInternal = internalMutation({
  args: { batchSize: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const batchSize = Math.max(
      1,
      Math.min(args.batchSize ?? PACKAGE_STAT_EVENT_BATCH_SIZE, PACKAGE_STAT_EVENT_BATCH_SIZE),
    );
    const now = Date.now();
    const events = await ctx.db
      .query("packageStatEvents")
      .withIndex("by_unprocessed", (q) => q.eq("processedAt", undefined))
      .take(batchSize);

    if (events.length === 0) return { processed: 0, packagesUpdated: 0 };

    const statsByPackage = new Map<Id<"packages">, { downloads: number; installs: number }>();
    const dailyStatsByPackageDay = new Map<string, PackageDailyStatsDelta>();
    const dailyStatsByPackage = new Map<Id<"packages">, PackageDailyStatsDelta[]>();
    for (const event of events) {
      const stats = statsByPackage.get(event.packageId) ?? { downloads: 0, installs: 0 };
      const day = toDayKey(event.occurredAt);
      const dailyKey = `${event.packageId}:${day}`;
      let dailyStats = dailyStatsByPackageDay.get(dailyKey);
      if (!dailyStats) {
        dailyStats = {
          packageId: event.packageId,
          day,
          downloads: 0,
          installs: 0,
        };
        dailyStatsByPackageDay.set(dailyKey, dailyStats);
        const packageDailyStats = dailyStatsByPackage.get(event.packageId);
        if (packageDailyStats) {
          packageDailyStats.push(dailyStats);
        } else {
          dailyStatsByPackage.set(event.packageId, [dailyStats]);
        }
      }
      if (event.kind === "install") {
        stats.installs += 1;
        dailyStats.installs += 1;
      } else if (event.kind === "install_clear") {
        stats.installs -= 1;
        dailyStats.installs -= 1;
      } else {
        stats.downloads += 1;
        dailyStats.downloads += 1;
      }
      statsByPackage.set(event.packageId, stats);
    }

    let packagesUpdated = 0;
    for (const [packageId, stats] of statsByPackage) {
      const pkg = await ctx.db.get(packageId);
      if (!pkg) continue;
      for (const dailyStats of dailyStatsByPackage.get(packageId) ?? []) {
        await bumpDailyPackageStats(ctx, { ...dailyStats, now });
      }
      const nextStats = {
        downloads: (pkg.stats?.downloads ?? 0) + stats.downloads,
        installs: Math.max(0, (pkg.stats?.installs ?? 0) + stats.installs),
        stars: pkg.stats?.stars ?? 0,
        versions: pkg.stats?.versions ?? 0,
      };
      await ctx.db.patch(pkg._id, {
        stats: nextStats,
        ...computePackageRecommendationPatch(nextStats, {
          createdAt: pkg.createdAt ?? pkg._creationTime,
          updatedAt: pkg.updatedAt,
          now,
        }),
      });
      packagesUpdated += 1;
    }

    for (const event of events) {
      await ctx.db.patch(event._id, { processedAt: now });
    }

    if (events.length === batchSize) {
      await ctx.scheduler.runAfter(0, internal.packages.processPackageStatEventsInternal, {
        batchSize,
      });
    }

    return { processed: events.length, packagesUpdated };
  },
});

export const pruneProcessedPackageStatEventBatchInternal = internalMutation({
  args: {
    cutoffProcessedAt: v.number(),
    dryRun: v.boolean(),
    batchSize: v.optional(v.number()),
    confirmationToken: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ProcessedPackageStatEventPruneBatchResult> => {
    if (
      !args.dryRun &&
      args.confirmationToken !== PROCESSED_PACKAGE_STAT_EVENT_PRUNE_CONFIRMATION_TOKEN
    ) {
      throw new Error(
        `Apply requires confirmationToken=${PROCESSED_PACKAGE_STAT_EVENT_PRUNE_CONFIRMATION_TOKEN}`,
      );
    }

    const batchSize = normalizeProcessedPackageStatEventPruneBatchSize(args.batchSize);
    const events = await ctx.db
      .query("packageStatEvents")
      .withIndex("by_unprocessed", (q) =>
        q.gt("processedAt", 0).lt("processedAt", args.cutoffProcessedAt),
      )
      .take(batchSize);

    if (!args.dryRun) {
      for (const event of events) {
        await ctx.db.delete(event._id);
      }
    }

    return {
      cutoffProcessedAt: args.cutoffProcessedAt,
      dryRun: args.dryRun,
      matched: events.length,
      deleted: args.dryRun ? 0 : events.length,
      hasMore: events.length === batchSize,
    };
  },
});

export const pruneProcessedPackageStatEventsInternal: ReturnType<typeof internalAction> =
  internalAction({
    args: {
      dryRun: v.optional(v.boolean()),
      retentionDays: v.optional(v.number()),
      batchSize: v.optional(v.number()),
      maxBatches: v.optional(v.number()),
      confirmationToken: v.optional(v.string()),
    },
    handler: async (ctx, args): Promise<ProcessedPackageStatEventPruneResult> => {
      const dryRun = args.dryRun ?? false;
      const retentionDays = normalizeProcessedPackageStatEventRetentionDays(args.retentionDays);
      const batchSize = normalizeProcessedPackageStatEventPruneBatchSize(args.batchSize);
      const maxBatches = normalizeProcessedPackageStatEventPruneMaxBatches(args.maxBatches);
      const cutoffProcessedAt = Date.now() - retentionDays * 24 * 60 * 60 * 1_000;

      let batches = 0;
      let matched = 0;
      let deleted = 0;
      let hasMore = false;
      let stoppedReason: "empty" | "max_batches" = "empty";
      const batchLimit = dryRun ? 1 : maxBatches;

      for (let index = 0; index < batchLimit; index += 1) {
        const batch = (await ctx.runMutation(
          internal.packages.pruneProcessedPackageStatEventBatchInternal,
          {
            cutoffProcessedAt,
            dryRun,
            batchSize,
            confirmationToken: args.confirmationToken,
          },
        )) as ProcessedPackageStatEventPruneBatchResult;

        batches += 1;
        matched += batch.matched;
        deleted += batch.deleted;
        hasMore = batch.hasMore;

        if (!batch.hasMore) {
          stoppedReason = "empty";
          break;
        }

        stoppedReason = "max_batches";
      }

      if (!dryRun && hasMore && stoppedReason === "max_batches") {
        await ctx.scheduler.runAfter(0, internal.packages.pruneProcessedPackageStatEventsInternal, {
          dryRun,
          retentionDays,
          batchSize,
          maxBatches,
          confirmationToken: args.confirmationToken,
        });
      }

      return {
        cutoffProcessedAt,
        retentionDays,
        dryRun,
        batches,
        matched,
        deleted,
        stoppedReason,
        scheduledContinuation: !dryRun && hasMore && stoppedReason === "max_batches",
      };
    },
  });

export const getTrustedPublisherByPackageIdInternal = internalQuery({
  args: { packageId: v.id("packages") },
  handler: async (ctx, args) => {
    return await getPackageTrustedPublisherByPackageId(ctx, args.packageId);
  },
});

export const setTrustedPublisherForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    packageName: v.string(),
    repository: v.string(),
    repositoryId: v.string(),
    repositoryOwner: v.string(),
    repositoryOwnerId: v.string(),
    workflowFilename: v.string(),
    environment: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const pkg = await getPackageByNormalizedName(ctx, normalizePackageName(args.packageName));
    if (!pkg) throw new ConvexError("Package not found");
    if (pkg.family === "skill") {
      throw new ConvexError(
        "Trusted publishers are only supported for code-plugin and bundle-plugin packages",
      );
    }
    await requireTrustedPublisherEditor(ctx, pkg, args.actorUserId);

    const workflowFilename = normalizeWorkflowFilenameOrThrow(args.workflowFilename);
    const environment = args.environment?.trim() || undefined;

    const existing = await getPackageTrustedPublisherByPackageId(ctx, pkg._id);
    const now = Date.now();
    const patch = {
      provider: "github-actions" as const,
      repository: args.repository,
      repositoryId: args.repositoryId,
      repositoryOwner: args.repositoryOwner,
      repositoryOwnerId: args.repositoryOwnerId,
      workflowFilename,
      environment,
      updatedByUserId: args.actorUserId,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("packageTrustedPublishers", {
        packageId: pkg._id,
        createdByUserId: args.actorUserId,
        createdAt: now,
        ...patch,
      });
    }

    await ctx.db.insert("auditLogs", {
      actorUserId: args.actorUserId,
      action: "package.trusted_publisher.set",
      targetType: "package",
      targetId: pkg._id,
      metadata: {
        provider: "github-actions",
        repository: args.repository,
        repositoryId: args.repositoryId,
        repositoryOwner: args.repositoryOwner,
        repositoryOwnerId: args.repositoryOwnerId,
        workflowFilename,
        ...(environment ? { environment } : {}),
      },
      createdAt: now,
    });

    return await getPackageTrustedPublisherByPackageId(ctx, pkg._id);
  },
});

export const deleteTrustedPublisherForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    packageName: v.string(),
  },
  handler: async (ctx, args) => {
    const pkg = await getPackageByNormalizedName(ctx, normalizePackageName(args.packageName));
    if (!pkg) throw new ConvexError("Package not found");
    await requireTrustedPublisherEditor(ctx, pkg, args.actorUserId);

    const existing = await getPackageTrustedPublisherByPackageId(ctx, pkg._id);
    if (!existing) return { deleted: false as const };
    await ctx.db.delete(existing._id);

    await ctx.db.insert("auditLogs", {
      actorUserId: args.actorUserId,
      action: "package.trusted_publisher.delete",
      targetType: "package",
      targetId: pkg._id,
      metadata: {
        provider: existing.provider,
        repository: existing.repository,
        repositoryId: existing.repositoryId,
        repositoryOwner: existing.repositoryOwner,
        repositoryOwnerId: existing.repositoryOwnerId,
        workflowFilename: existing.workflowFilename,
        environment: existing.environment,
      },
      createdAt: Date.now(),
    });
    return { deleted: true as const };
  },
});

export const insertAuditLogInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    action: v.string(),
    targetType: v.string(),
    targetId: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("auditLogs", {
      actorUserId: args.actorUserId,
      action: args.action,
      targetType: args.targetType,
      targetId: args.targetId,
      metadata: args.metadata,
      createdAt: Date.now(),
    });
  },
});

async function softDeletePackageDoc(
  ctx: Pick<MutationCtx, "db">,
  pkg: Doc<"packages">,
  params: {
    actorUserId: Id<"users">;
    actorRole?: Doc<"users">["role"];
    deletedAt?: number;
    reason?: PackageSoftDeletedReason;
    source: "cli" | "dashboard";
  },
) {
  const now = params.deletedAt ?? Date.now();
  if (pkg.softDeletedAt) {
    if (params.actorRole === "admin" || params.actorRole === "moderator") {
      const packagePatch: Partial<Doc<"packages">> = {
        softDeletedBy: params.actorUserId,
        softDeletedByRole: params.actorRole,
        updatedAt: now,
      };
      if (pkg.softDeletedReason === "user.banned" && params.reason !== "user.banned") {
        packagePatch.softDeletedAt = now;
        packagePatch.softDeletedReason = params.reason;
      }
      const nextPackage: Doc<"packages"> = { ...pkg, ...packagePatch };
      await ctx.db.patch(pkg._id, packagePatch);
      const deleteOwner = await getOwnerPublisher(ctx, {
        ownerPublisherId: pkg.ownerPublisherId,
        ownerUserId: pkg.ownerUserId,
      });
      await upsertPackageSearchDigest(ctx, {
        ...extractPackageDigestFields(nextPackage),
        ownerHandle: deleteOwner?.handle ?? "",
        ownerKind: deleteOwner?.kind,
      });
    }
    return {
      ok: true as const,
      packageId: pkg._id,
      releaseCount: 0,
      alreadyDeleted: true as const,
    };
  }

  const releases = await ctx.db
    .query("packageReleases")
    .withIndex("by_package", (q) => q.eq("packageId", pkg._id))
    .collect();
  const deletedReleaseIds = releases
    .filter((release) => !release.softDeletedAt)
    .map((release) => release._id);
  const packagePatch: Partial<Doc<"packages">> = {
    softDeletedAt: now,
    softDeletedReason: params.reason,
    softDeletedBy: params.actorUserId,
    softDeletedByRole: params.actorRole ?? "user",
    updatedAt: now,
  };
  const nextPackage: Doc<"packages"> = { ...pkg, ...packagePatch };
  await ctx.db.patch(pkg._id, packagePatch);
  const deleteOwner = await getOwnerPublisher(ctx, {
    ownerPublisherId: pkg.ownerPublisherId,
    ownerUserId: pkg.ownerUserId,
  });
  await upsertPackageSearchDigest(ctx, {
    ...extractPackageDigestFields(nextPackage),
    ownerHandle: deleteOwner?.handle ?? "",
    ownerKind: deleteOwner?.kind,
  });
  for (const releaseId of deletedReleaseIds) {
    await ctx.db.patch(releaseId, { softDeletedAt: now });
  }
  await ctx.db.insert("auditLogs", {
    actorUserId: params.actorUserId,
    action: "package.delete",
    targetType: "package",
    targetId: pkg._id,
    metadata: {
      name: pkg.name,
      normalizedName: pkg.normalizedName,
      ownerUserId: pkg.ownerUserId,
      ownerPublisherId: pkg.ownerPublisherId,
      actorRole: params.actorRole ?? "user",
      softDeletedReason: params.reason ?? null,
      releaseCount: deletedReleaseIds.length,
      releaseIds: deletedReleaseIds,
      source: params.source,
    },
    createdAt: now,
  });

  return {
    ok: true as const,
    packageId: pkg._id,
    releaseCount: deletedReleaseIds.length,
    alreadyDeleted: false as const,
  };
}

async function deletePackageModerationEventsForReport(
  ctx: Pick<MutationCtx, "db">,
  reportId: Id<"packageReports">,
) {
  const logs = await ctx.db
    .query("packageModerationEventLogs")
    .withIndex("by_report_createdAt", (q) => q.eq("reportId", reportId))
    .collect();
  for (const log of logs) await ctx.db.delete(log._id);
}

async function deletePackageModerationEventsForAppeal(
  ctx: Pick<MutationCtx, "db">,
  appealId: Id<"packageAppeals">,
) {
  const logs = await ctx.db
    .query("packageModerationEventLogs")
    .withIndex("by_appeal_createdAt", (q) => q.eq("appealId", appealId))
    .collect();
  for (const log of logs) await ctx.db.delete(log._id);
}

async function hardDeletePackageDoc(
  ctx: Pick<MutationCtx, "db">,
  pkg: Doc<"packages">,
  params: {
    actorUserId: Id<"users">;
    deletedAt: number;
    source: "admin" | "account.delete" | "publisher.delete";
    reason?: string;
  },
) {
  const releases = await ctx.db
    .query("packageReleases")
    .withIndex("by_package", (q) => q.eq("packageId", pkg._id))
    .collect();
  for (const release of releases) {
    const jobs = await ctx.db
      .query("securityScanJobs")
      .withIndex("by_package_release", (q) => q.eq("packageReleaseId", release._id))
      .collect();
    for (const job of jobs) await ctx.db.delete(job._id);
  }

  const reports = await ctx.db
    .query("packageReports")
    .withIndex("by_package", (q) => q.eq("packageId", pkg._id))
    .collect();
  for (const report of reports) {
    await deletePackageModerationEventsForReport(ctx, report._id);
    await ctx.db.delete(report._id);
  }

  const appeals = await ctx.db
    .query("packageAppeals")
    .withIndex("by_package", (q) => q.eq("packageId", pkg._id))
    .collect();
  for (const appeal of appeals) {
    await deletePackageModerationEventsForAppeal(ctx, appeal._id);
    await ctx.db.delete(appeal._id);
  }

  const badges = await ctx.db
    .query("packageBadges")
    .withIndex("by_package", (q) => q.eq("packageId", pkg._id))
    .collect();
  for (const badge of badges) await ctx.db.delete(badge._id);

  const trustedPublishers = await ctx.db
    .query("packageTrustedPublishers")
    .withIndex("by_package", (q) => q.eq("packageId", pkg._id))
    .collect();
  for (const trustedPublisher of trustedPublishers) await ctx.db.delete(trustedPublisher._id);

  const tokens = await ctx.db
    .query("packagePublishTokens")
    .withIndex("by_package", (q) => q.eq("packageId", pkg._id))
    .collect();
  for (const token of tokens) {
    const tickets = await ctx.db
      .query("packagePublishUploadTickets")
      .withIndex("by_publish_token", (q) => q.eq("publishTokenId", token._id))
      .collect();
    for (const ticket of tickets) await ctx.db.delete(ticket._id);
    await ctx.db.delete(token._id);
  }

  const statEvents = await ctx.db
    .query("packageStatEvents")
    .withIndex("by_package", (q) => q.eq("packageId", pkg._id))
    .collect();
  for (const statEvent of statEvents) await ctx.db.delete(statEvent._id);

  const dailyStats = await ctx.db
    .query("packageDailyStats")
    .withIndex("by_package_day", (q) => q.eq("packageId", pkg._id))
    .collect();
  for (const dailyStat of dailyStats) await ctx.db.delete(dailyStat._id);

  for (const release of releases) await ctx.db.delete(release._id);
  await ctx.db.delete(pkg._id);
  await ctx.db.insert("auditLogs", {
    actorUserId: params.actorUserId,
    action: "package.hard_delete",
    targetType: "package",
    targetId: pkg._id,
    metadata: {
      name: pkg.name,
      normalizedName: pkg.normalizedName,
      ownerUserId: pkg.ownerUserId,
      ownerPublisherId: pkg.ownerPublisherId,
      source: params.source,
      reason: params.reason,
      releases: releases.length,
      reports: reports.length,
      appeals: appeals.length,
      publishTokens: tokens.length,
    },
    createdAt: params.deletedAt,
  });

  return {
    ok: true as const,
    packageId: pkg._id,
    releaseCount: releases.length,
    revokedTokenCount: tokens.length,
  };
}

export const hardDeletePackageInternal = internalMutation({
  args: {
    packageId: v.id("packages"),
    actorUserId: v.id("users"),
    deletedAt: v.number(),
    source: hardDeletePackageSourceValidator,
  },
  handler: async (ctx, args) => {
    const pkg = await ctx.db.get(args.packageId);
    if (!pkg) return { ok: true as const, deleted: false as const };
    const result = await hardDeletePackageDoc(ctx, pkg, {
      actorUserId: args.actorUserId,
      deletedAt: args.deletedAt,
      source: args.source,
    });
    return { ...result, deleted: true as const };
  },
});

export const hardDeleteForAdminInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    name: v.string(),
    ownerHandle: v.string(),
    reason: v.string(),
    dryRun: v.optional(v.boolean()),
    confirmationToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
    assertAdmin(actor);

    const name = normalizePackageName(args.name);
    const ownerHandle = normalizePublisherHandle(args.ownerHandle);
    const reason = args.reason.trim();
    if (!name) throw new ConvexError("Package name required");
    if (!ownerHandle) throw new ConvexError("Owner handle required");
    if (!reason) throw new ConvexError("Reason is required");
    if (reason.length > 500) throw new ConvexError("Reason too long (max 500 chars)");

    const pkg = await getPackageByNormalizedName(ctx, name);
    if (!pkg) throw new ConvexError("Package not found");
    if (!pkg.softDeletedAt) throw new ConvexError("Package must be soft-deleted first");
    const owner = await getOwnerPublisher(ctx, {
      ownerPublisherId: pkg.ownerPublisherId,
      ownerUserId: pkg.ownerUserId,
    });
    if (normalizePublisherHandle(owner?.handle) !== ownerHandle) {
      throw new ConvexError("Package owner does not match --owner");
    }

    const confirmationToken = `hard-delete-package:@${ownerHandle}/${pkg.normalizedName}:${pkg._id}`;
    const baseResult = {
      ok: true as const,
      packageId: pkg._id,
      name: pkg.normalizedName,
      ownerHandle,
      displayName: pkg.displayName,
      runtimeId: pkg.runtimeId ?? null,
      confirmationToken,
    };
    if (args.dryRun !== false) return { ...baseResult, dryRun: true, deleted: false };
    if (args.confirmationToken !== confirmationToken) {
      throw new ConvexError(`Confirmation token must be "${confirmationToken}"`);
    }

    const now = Date.now();
    await ctx.db.insert("auditLogs", {
      actorUserId: args.actorUserId,
      action: "package.hard_delete.requested",
      targetType: "package",
      targetId: pkg._id,
      metadata: {
        name: pkg.normalizedName,
        ownerHandle,
        reason,
        source: "clawhub-admin",
      },
      createdAt: now,
    });
    await hardDeletePackageDoc(ctx, pkg, {
      actorUserId: args.actorUserId,
      deletedAt: now,
      source: "admin",
      reason,
    });
    return { ...baseResult, dryRun: false, deleted: true };
  },
});

function comparePackageRestoreLatestCandidates(
  family: Doc<"packages">["family"],
  a: Doc<"packageReleases">,
  b: Doc<"packageReleases">,
) {
  if (family === "bundle-plugin") {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a._id.localeCompare(b._id);
  }
  const aSemver = semver.valid(a.version);
  const bSemver = semver.valid(b.version);
  if (aSemver && bSemver) return semver.compare(aSemver, bSemver);
  if (aSemver) return 1;
  if (bSemver) return -1;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a._id.localeCompare(b._id);
}

function getPreferredRestoredPackageRelease(
  family: Doc<"packages">["family"],
  releases: Doc<"packageReleases">[],
) {
  return releases.reduce<Doc<"packageReleases"> | null>((best, release) => {
    if (release.softDeletedAt) return best;
    if (!best || comparePackageRestoreLatestCandidates(family, best, release) < 0) return release;
    return best;
  }, null);
}

function getPreservedRestoredPackageRelease(
  pkg: Doc<"packages">,
  releases: Doc<"packageReleases">[],
) {
  const byId = new Map(
    releases.filter((release) => !release.softDeletedAt).map((release) => [release._id, release]),
  );
  return (
    byId.get(pkg.tags.latest) ??
    (pkg.latestReleaseId ? byId.get(pkg.latestReleaseId) : null) ??
    null
  );
}

function rebuildPackageTagsFromActiveReleases(releases: Doc<"packageReleases">[]) {
  const tags: Doc<"packages">["tags"] = {};
  for (const release of releases) {
    if (release.softDeletedAt) continue;
    for (const tag of release.distTags ?? []) {
      tags[tag] = release._id;
    }
  }
  return tags;
}

function packageLatestSummaryFromRelease(release: Doc<"packageReleases"> | null) {
  return release
    ? {
        version: release.version,
        createdAt: release.createdAt,
        changelog: release.changelog,
        icon: release.icon,
        compatibility: release.compatibility,
        verification: release.verification,
        artifact: packageArtifactSummary(release),
      }
    : undefined;
}

function packageRuntimeIdFromRelease(release: Doc<"packageReleases"> | null) {
  return release?.runtimeId;
}

function packageSourceRepoFromRelease(release: Doc<"packageReleases"> | null) {
  return release?.sourceRepo ?? release?.verification?.sourceRepo;
}

async function restorePackageDoc(
  ctx: Pick<MutationCtx, "db">,
  pkg: Doc<"packages">,
  params: {
    actorUserId?: Id<"users">;
    actorRole?: Doc<"users">["role"];
    allowBanRestore?: boolean;
    releaseSoftDeletedAt?: number;
    source: "cli" | "dashboard" | "service";
  },
) {
  if (!pkg.softDeletedAt) {
    return {
      ok: true as const,
      packageId: pkg._id,
      releaseCount: 0,
      alreadyRestored: true as const,
    };
  }

  const now = Date.now();
  const actorRole = params.actorRole ?? "user";
  const isPrivilegedActor = actorRole === "admin" || actorRole === "moderator";
  const isDirectlyRestorableDelete = pkg.softDeletedReason === undefined;
  const isPrivilegedRestorableDelete = isPrivilegedActor && isDirectlyRestorableDelete;
  const isUserRestorableDelete = pkg.softDeletedByRole === "user" && isDirectlyRestorableDelete;
  const isUnbanBatchRestore =
    params.allowBanRestore === true && pkg.softDeletedReason === "user.banned";
  if (!isPrivilegedRestorableDelete && !isUserRestorableDelete && !isUnbanBatchRestore) {
    throw new ConvexError(
      "Forbidden: This package was hidden by moderation and cannot be restored by the owner. Please contact a moderator.",
    );
  }

  if (pkg.family === "code-plugin") await assertPackageRuntimeIdAvailable(ctx, pkg);

  const releases = await ctx.db
    .query("packageReleases")
    .withIndex("by_package", (q) => q.eq("packageId", pkg._id))
    .collect();
  let releaseCount = 0;
  const restoredReleaseIds: Array<Id<"packageReleases">> = [];
  const activeReleases: Doc<"packageReleases">[] = [];
  for (const release of releases) {
    if (release.ownerDeletedAt !== undefined) continue;
    if (release.softDeletedAt) {
      if (
        params.releaseSoftDeletedAt !== undefined &&
        release.softDeletedAt !== params.releaseSoftDeletedAt
      ) {
        continue;
      }
      const restoredRelease = { ...release, softDeletedAt: undefined };
      await ctx.db.patch(release._id, { softDeletedAt: undefined });
      releaseCount += 1;
      restoredReleaseIds.push(release._id);
      activeReleases.push(restoredRelease);
    } else {
      activeReleases.push(release);
    }
  }

  const nextLatest =
    getPreservedRestoredPackageRelease(pkg, activeReleases) ??
    getPreferredRestoredPackageRelease(pkg.family, activeReleases);
  const nextTags = rebuildPackageTagsFromActiveReleases(activeReleases);
  if (nextLatest) {
    nextTags.latest = nextLatest._id;
    if (!(nextLatest.distTags ?? []).includes("latest")) {
      await ctx.db.patch(nextLatest._id, {
        distTags: [...(nextLatest.distTags ?? []), "latest"],
      });
    }
  }

  const packagePatch: Partial<Doc<"packages">> = {
    softDeletedAt: undefined,
    softDeletedReason: undefined,
    softDeletedBy: undefined,
    softDeletedByRole: undefined,
    tags: nextTags,
    latestReleaseId: nextLatest?._id,
    latestVersionSummary: nextLatest
      ? {
          version: nextLatest.version,
          createdAt: nextLatest.createdAt,
          changelog: nextLatest.changelog,
          icon: nextLatest.icon,
          compatibility: nextLatest.compatibility,
          verification: nextLatest.verification,
          artifact: packageArtifactSummary(nextLatest),
        }
      : undefined,
    summary: nextLatest?.summary,
    icon: nextLatest?.icon,
    compatibility: nextLatest?.compatibility,
    verification: nextLatest?.verification,
    scanStatus: nextLatest ? resolvePackageReleaseScanStatus(nextLatest) : pkg.scanStatus,
    updatedAt: now,
  };
  const nextPackage: Doc<"packages"> = { ...pkg, ...packagePatch };
  await ctx.db.patch(pkg._id, packagePatch);
  const restoreOwner = await getOwnerPublisher(ctx, {
    ownerPublisherId: pkg.ownerPublisherId,
    ownerUserId: pkg.ownerUserId,
  });
  await upsertPackageSearchDigest(ctx, {
    ...extractPackageDigestFields(nextPackage),
    ownerHandle: restoreOwner?.handle ?? "",
    ownerKind: restoreOwner?.kind,
  });
  await ctx.db.insert("auditLogs", {
    ...(params.actorUserId ? { actorUserId: params.actorUserId } : {}),
    action: "package.undelete",
    targetType: "package",
    targetId: pkg._id,
    metadata: {
      name: pkg.name,
      normalizedName: pkg.normalizedName,
      ownerUserId: pkg.ownerUserId,
      ownerPublisherId: pkg.ownerPublisherId,
      deletedBy: pkg.softDeletedBy,
      deletedByRole: pkg.softDeletedByRole,
      releaseCount,
      releaseIds: restoredReleaseIds,
      source: params.source,
    },
    createdAt: now,
  });

  return {
    ok: true as const,
    packageId: pkg._id,
    releaseCount,
    alreadyRestored: false as const,
  };
}

async function revokePackagePublishTokensForPackage(
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  packageId: Id<"packages">,
  revokedAt: number,
) {
  const tokens = await ctx.db
    .query("packagePublishTokens")
    .withIndex("by_package_revoked_created", (q) =>
      q.eq("packageId", packageId).eq("revokedAt", undefined).lte("createdAt", revokedAt),
    )
    .order("desc")
    .take(PACKAGE_PUBLISH_TOKEN_REVOKE_BATCH_SIZE + 1);
  let revokedCount = 0;
  for (const token of tokens.slice(0, PACKAGE_PUBLISH_TOKEN_REVOKE_BATCH_SIZE)) {
    await ctx.db.patch(token._id, { revokedAt });
    revokedCount += 1;
  }
  const scheduled = tokens.length > PACKAGE_PUBLISH_TOKEN_REVOKE_BATCH_SIZE;
  if (scheduled) {
    void ctx.scheduler.runAfter(
      0,
      internal.packages.revokePackagePublishTokensForPackageBatchInternal,
      { packageId, revokedAt },
    );
  }
  return { revokedCount, scheduled };
}

async function isPackageOwnedByPersonalUser(
  ctx: Pick<MutationCtx, "db">,
  pkg: Pick<Doc<"packages">, "ownerPublisherId">,
  owner: Doc<"users">,
) {
  if (!pkg.ownerPublisherId) return true;
  if (owner.personalPublisherId && pkg.ownerPublisherId === owner.personalPublisherId) {
    return true;
  }
  const ownerPublisher = await ctx.db.get(pkg.ownerPublisherId);
  return ownerPublisher?.kind === "user" && ownerPublisher.linkedUserId === owner._id;
}

async function getOwnedPackagePersonalPublisherId(
  ctx: Pick<MutationCtx, "db">,
  owner: Pick<Doc<"users">, "_id" | "personalPublisherId">,
) {
  if (owner.personalPublisherId) return owner.personalPublisherId;
  const linkedPublisher = await getPersonalPublisherForUser(ctx, owner._id);
  if (
    linkedPublisher?.kind === "user" &&
    !linkedPublisher.deletedAt &&
    !linkedPublisher.deactivatedAt
  ) {
    return linkedPublisher._id;
  }
  return undefined;
}

function getOwnedPackageScanScope(args: { scope?: OwnedPackageScanScope }) {
  return args.scope ?? "ownerUserId";
}

function shouldSkipOwnedPackageScanRow(
  pkg: Pick<Doc<"packages">, "ownerUserId">,
  args: { ownerUserId: Id<"users">; scope?: OwnedPackageScanScope },
) {
  return (
    getOwnedPackageScanScope(args) === "personalPublisher" && pkg.ownerUserId === args.ownerUserId
  );
}

function scheduleNextOwnedPackageScanBatch(
  ctx: Pick<MutationCtx, "scheduler">,
  fn: unknown,
  args: { ownerUserId: Id<"users">; cursor?: string; scope?: OwnedPackageScanScope } & Record<
    string,
    unknown
  >,
  personalPublisherId: Id<"publishers"> | undefined,
  isDone: boolean,
  continueCursor: string | null,
) {
  if (!isDone) {
    void ctx.scheduler.runAfter(
      0,
      fn as never,
      {
        ...args,
        cursor: continueCursor ?? undefined,
      } as never,
    );
    return true;
  }
  if (getOwnedPackageScanScope(args) === "ownerUserId" && personalPublisherId) {
    void ctx.scheduler.runAfter(
      0,
      fn as never,
      {
        ...args,
        scope: "personalPublisher",
        cursor: undefined,
      } as never,
    );
    return true;
  }
  return false;
}

export const revokePackagePublishTokensForPackageBatchInternal = internalMutation({
  args: {
    packageId: v.id("packages"),
    revokedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const result = await revokePackagePublishTokensForPackage(ctx, args.packageId, args.revokedAt);
    return { ok: true as const, ...result };
  },
});

export const applyBanToOwnedPackagesBatchInternal = internalMutation({
  args: {
    ownerUserId: v.id("users"),
    bannedAt: v.number(),
    deletedBy: v.id("users"),
    deletedByRole: v.union(v.literal("admin"), v.literal("moderator"), v.literal("user")),
    cursor: v.optional(v.string()),
    scope: ownedPackageScanScopeValidator,
  },
  handler: async (ctx, args) => {
    const owner = await ctx.db.get(args.ownerUserId);
    const scope = getOwnedPackageScanScope(args);
    const isInitialOwnerUserIdBatch = !args.cursor && scope === "ownerUserId";
    const ownerMatchesCurrentBan = owner?.deletedAt === args.bannedAt;
    if (!owner || owner.deactivatedAt || (!isInitialOwnerUserIdBatch && !ownerMatchesCurrentBan)) {
      return {
        ok: true as const,
        deletedCount: 0,
        revokedTokenCount: 0,
        scheduled: false,
        stale: true as const,
      };
    }

    const personalPublisherId = await getOwnedPackagePersonalPublisherId(ctx, owner);
    const packageQuery =
      scope === "personalPublisher" && personalPublisherId
        ? ctx.db
            .query("packages")
            .withIndex("by_owner_publisher", (q) => q.eq("ownerPublisherId", personalPublisherId))
        : ctx.db
            .query("packages")
            .withIndex("by_owner", (q) => q.eq("ownerUserId", args.ownerUserId));
    const { page, isDone, continueCursor } = await packageQuery.order("desc").paginate({
      cursor: args.cursor ?? null,
      numItems: BAN_USER_PACKAGES_BATCH_SIZE,
    });

    let deletedCount = 0;
    let revokedTokenCount = 0;
    for (const pkg of page) {
      if (shouldSkipOwnedPackageScanRow(pkg, args)) continue;
      if (!(await isPackageOwnedByPersonalUser(ctx, pkg, owner))) continue;
      const revokeResult = await revokePackagePublishTokensForPackage(ctx, pkg._id, args.bannedAt);
      revokedTokenCount += revokeResult.revokedCount;
      if (pkg.softDeletedAt) {
        if (pkg.softDeletedReason === "user.banned" && pkg.softDeletedAt !== args.bannedAt) {
          const previousBanHiddenAt = pkg.softDeletedAt;
          const releases = await ctx.db
            .query("packageReleases")
            .withIndex("by_package", (q) => q.eq("packageId", pkg._id))
            .collect();
          for (const release of releases) {
            if (release.softDeletedAt === previousBanHiddenAt) {
              await ctx.db.patch(release._id, { softDeletedAt: args.bannedAt });
            }
          }
          const packagePatch: Partial<Doc<"packages">> = {
            softDeletedAt: args.bannedAt,
            softDeletedBy: args.deletedBy,
            softDeletedByRole: args.deletedByRole,
            updatedAt: args.bannedAt,
          };
          const nextPackage: Doc<"packages"> = { ...pkg, ...packagePatch };
          await ctx.db.patch(pkg._id, packagePatch);
          const ownerPublisher = await getOwnerPublisher(ctx, {
            ownerPublisherId: pkg.ownerPublisherId,
            ownerUserId: pkg.ownerUserId,
          });
          await upsertPackageSearchDigest(ctx, {
            ...extractPackageDigestFields(nextPackage),
            ownerHandle: ownerPublisher?.handle ?? "",
            ownerKind: ownerPublisher?.kind,
          });
        }
        continue;
      }

      await softDeletePackageDoc(ctx, pkg, {
        actorUserId: args.deletedBy,
        actorRole: args.deletedByRole,
        deletedAt: args.bannedAt,
        reason: "user.banned",
        source: "dashboard",
      });
      deletedCount += 1;
    }

    const scheduled = scheduleNextOwnedPackageScanBatch(
      ctx,
      internal.packages.applyBanToOwnedPackagesBatchInternal,
      args,
      personalPublisherId,
      isDone,
      continueCursor,
    );

    return { ok: true as const, deletedCount, revokedTokenCount, scheduled };
  },
});

export const restoreOwnedPackagesForUnbanBatchInternal = internalMutation({
  args: {
    actorUserId: v.optional(v.id("users")),
    ownerUserId: v.id("users"),
    bannedAt: v.number(),
    cursor: v.optional(v.string()),
    scope: ownedPackageScanScopeValidator,
  },
  handler: async (ctx, args) => {
    const actor = args.actorUserId ? await ctx.db.get(args.actorUserId) : null;
    if (args.actorUserId && (!actor || actor.deletedAt || actor.deactivatedAt)) {
      throw new ConvexError("Unauthorized");
    }
    const owner = await ctx.db.get(args.ownerUserId);
    if (!owner || owner.deletedAt || owner.deactivatedAt) {
      return { ok: true as const, restoredCount: 0, scheduled: false, stale: true as const };
    }

    const scope = getOwnedPackageScanScope(args);
    const personalPublisherId = await getOwnedPackagePersonalPublisherId(ctx, owner);
    const packageQuery =
      scope === "personalPublisher" && personalPublisherId
        ? ctx.db
            .query("packages")
            .withIndex("by_owner_publisher", (q) => q.eq("ownerPublisherId", personalPublisherId))
        : ctx.db
            .query("packages")
            .withIndex("by_owner", (q) => q.eq("ownerUserId", args.ownerUserId));
    const { page, isDone, continueCursor } = await packageQuery.order("desc").paginate({
      cursor: args.cursor ?? null,
      numItems: BAN_USER_PACKAGES_BATCH_SIZE,
    });

    let restoredCount = 0;
    for (const pkg of page) {
      if (shouldSkipOwnedPackageScanRow(pkg, args)) continue;
      if (!(await isPackageOwnedByPersonalUser(ctx, pkg, owner))) continue;
      if (
        !pkg.softDeletedAt ||
        pkg.softDeletedAt !== args.bannedAt ||
        pkg.softDeletedReason !== "user.banned"
      ) {
        continue;
      }

      await restorePackageDoc(ctx, pkg, {
        actorUserId: actor?._id,
        actorRole: actor?.role,
        allowBanRestore: true,
        releaseSoftDeletedAt: args.bannedAt,
        source: actor ? "dashboard" : "service",
      });
      restoredCount += 1;
    }

    const scheduled = scheduleNextOwnedPackageScanBatch(
      ctx,
      internal.packages.restoreOwnedPackagesForUnbanBatchInternal,
      args,
      personalPublisherId,
      isDone,
      continueCursor,
    );

    return { ok: true as const, restoredCount, scheduled };
  },
});

export const applyAccountDeletionToOwnedPackagesBatchInternal = internalMutation({
  args: {
    ownerUserId: v.id("users"),
    deletedAt: v.number(),
    cursor: v.optional(v.string()),
    scope: ownedPackageScanScopeValidator,
  },
  handler: async (ctx, args) => {
    const owner = await ctx.db.get(args.ownerUserId);
    if (!owner) {
      return {
        ok: true as const,
        deletedCount: 0,
        revokedTokenCount: 0,
        scheduled: false,
        stale: true as const,
      };
    }

    const scope = getOwnedPackageScanScope(args);
    const personalPublisherId = await getOwnedPackagePersonalPublisherId(ctx, owner);
    const packageQuery =
      scope === "personalPublisher" && personalPublisherId
        ? ctx.db
            .query("packages")
            .withIndex("by_owner_publisher", (q) => q.eq("ownerPublisherId", personalPublisherId))
        : ctx.db
            .query("packages")
            .withIndex("by_owner", (q) => q.eq("ownerUserId", args.ownerUserId));
    const { page, isDone, continueCursor } = await packageQuery.order("desc").paginate({
      cursor: args.cursor ?? null,
      numItems: BAN_USER_PACKAGES_BATCH_SIZE,
    });

    let deletedCount = 0;
    let revokedTokenCount = 0;
    for (const pkg of page) {
      if (shouldSkipOwnedPackageScanRow(pkg, args)) continue;
      if (!(await isPackageOwnedByPersonalUser(ctx, pkg, owner))) continue;
      await softDeletePackageDoc(ctx, pkg, {
        actorUserId: args.ownerUserId,
        deletedAt: args.deletedAt,
        reason: "user.deactivated",
        source: "dashboard",
      });
      void ctx.scheduler.runAfter(0, internal.packages.hardDeletePackageInternal, {
        packageId: pkg._id,
        actorUserId: args.ownerUserId,
        deletedAt: args.deletedAt,
        source: "account.delete",
      });
      deletedCount += 1;
    }

    const scheduled = scheduleNextOwnedPackageScanBatch(
      ctx,
      internal.packages.applyAccountDeletionToOwnedPackagesBatchInternal,
      args,
      personalPublisherId,
      isDone,
      continueCursor,
    );

    return { ok: true as const, deletedCount, revokedTokenCount, scheduled };
  },
});

export const applyPublisherDeletionToOwnedPackagesBatchInternal = internalMutation({
  args: {
    ownerPublisherId: v.id("publishers"),
    actorUserId: v.id("users"),
    deletedAt: v.number(),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const publisher = await ctx.db.get(args.ownerPublisherId);
    if (publisher && publisher.deletedAt !== args.deletedAt) {
      return {
        ok: true as const,
        deletedCount: 0,
        revokedTokenCount: 0,
        scheduled: false,
        stale: true as const,
      };
    }

    const { page, isDone, continueCursor } = await ctx.db
      .query("packages")
      .withIndex("by_owner_publisher", (q) => q.eq("ownerPublisherId", args.ownerPublisherId))
      .order("desc")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: BAN_USER_PACKAGES_BATCH_SIZE,
      });

    let deletedCount = 0;
    let revokedTokenCount = 0;
    for (const pkg of page) {
      await softDeletePackageDoc(ctx, pkg, {
        actorUserId: args.actorUserId,
        deletedAt: args.deletedAt,
        reason: "publisher.deleted",
        source: "dashboard",
      });
      void ctx.scheduler.runAfter(0, internal.packages.hardDeletePackageInternal, {
        packageId: pkg._id,
        actorUserId: args.actorUserId,
        deletedAt: args.deletedAt,
        source: "publisher.delete",
      });
      deletedCount += 1;
    }

    if (!isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.packages.applyPublisherDeletionToOwnedPackagesBatchInternal,
        {
          ...args,
          cursor: continueCursor,
        },
      );
    }

    return { ok: true as const, deletedCount, revokedTokenCount, scheduled: !isDone };
  },
});

export const softDeletePackageInternal = internalMutation({
  args: {
    userId: v.id("users"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.deletedAt || user.deactivatedAt) throw new Error("User not found");

    const normalizedName = normalizePackageName(args.name);
    if (!normalizedName) throw new Error("Package name required");

    const pkg = await getPackageByNormalizedName(ctx, normalizedName);
    if (!pkg) throw new Error("Package not found");

    if (user.role === "moderator" || user.role === "admin") {
      // Moderators can manage packages outside their own publisher memberships.
    } else {
      await assertCanManageOwnedResource(ctx, {
        actor: user,
        ownerUserId: pkg.ownerUserId,
        ownerPublisherId: pkg.ownerPublisherId,
        allowedPublisherRoles: ["admin"],
      });
    }

    return await softDeletePackageDoc(ctx, pkg, {
      actorUserId: user._id,
      actorRole: user.role,
      source: "cli",
    });
  },
});

export const restorePackageInternal = internalMutation({
  args: {
    userId: v.id("users"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.deletedAt || user.deactivatedAt) throw new Error("User not found");

    const normalizedName = normalizePackageName(args.name);
    if (!normalizedName) throw new Error("Package name required");

    const pkg = await getPackageByNormalizedName(ctx, normalizedName);
    if (!pkg) throw new Error("Package not found");

    if (user.role === "moderator" || user.role === "admin") {
      // Moderators can manage packages outside their own publisher memberships.
    } else {
      await assertCanManageOwnedResource(ctx, {
        actor: user,
        ownerUserId: pkg.ownerUserId,
        ownerPublisherId: pkg.ownerPublisherId,
        allowedPublisherRoles: ["admin"],
      });
    }

    return await restorePackageDoc(ctx, pkg, {
      actorUserId: user._id,
      actorRole: user.role,
      source: "cli",
    });
  },
});

export const softDeletePackage = mutation({
  args: {
    packageId: v.id("packages"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const pkg = await ctx.db.get(args.packageId);
    if (!pkg) throw new ConvexError("Package not found");

    if (user.role === "moderator" || user.role === "admin") {
      // Moderators can manage packages outside their own publisher memberships.
    } else {
      await assertCanManageOwnedResource(ctx, {
        actor: user,
        ownerUserId: pkg.ownerUserId,
        ownerPublisherId: pkg.ownerPublisherId,
        allowedPublisherRoles: ["admin"],
      });
    }

    return await softDeletePackageDoc(ctx, pkg, {
      actorUserId: user._id,
      actorRole: user.role,
      source: "dashboard",
    });
  },
});

async function hasBoundedAvailablePackageReleaseSurvivor(
  ctx: MutationCtx,
  packageId: Id<"packages">,
  targetReleaseId: Id<"packageReleases">,
) {
  const candidates = await ctx.db
    .query("packageReleases")
    .withIndex("by_package_active_created", (q) =>
      q.eq("packageId", packageId).eq("softDeletedAt", undefined),
    )
    .take(MAX_POINTERLESS_RELEASE_SURVIVOR_SCAN + 1);
  const hasSurvivor = candidates.some(
    (candidate) =>
      candidate._id !== targetReleaseId &&
      isPackageReleaseAvailableForOwnerDeleteSafety(candidate, packageId),
  );
  if (hasSurvivor) return true;
  if (candidates.length > MAX_POINTERLESS_RELEASE_SURVIVOR_SCAN) {
    throw new ConvexError(
      "This package has too many active releases to safely delete an individual release.",
    );
  }
  return false;
}

function isPackageReleaseAvailableForOwnerDeleteSafety(
  release: Doc<"packageReleases"> | null | undefined,
  packageId: Id<"packages">,
): release is Doc<"packageReleases"> {
  return Boolean(
    release &&
    release.packageId === packageId &&
    !release.softDeletedAt &&
    release.ownerDeletedAt === undefined &&
    resolvePackageReleaseScanStatus(release) !== "malicious",
  );
}

async function hasAvailableLatestPackageReleasePointer(
  ctx: MutationCtx,
  pkg: Pick<Doc<"packages">, "_id" | "latestReleaseId" | "tags">,
) {
  const pointerIds = new Set<Id<"packageReleases">>();
  if (pkg.latestReleaseId) pointerIds.add(pkg.latestReleaseId);
  if (pkg.tags.latest) pointerIds.add(pkg.tags.latest);

  for (const pointerId of pointerIds) {
    const pointer = await ctx.db.get(pointerId);
    if (isPackageReleaseAvailableForOwnerDeleteSafety(pointer, pkg._id)) return true;
  }
  return false;
}

export async function deleteOwnedPackageReleaseForActor(
  ctx: MutationCtx,
  actor: Doc<"users">,
  args: { name: string; version: string },
) {
  const normalizedName = normalizePackageName(args.name);
  const pkg = await getPackageByNormalizedName(ctx, normalizedName);
  if (!pkg || pkg.softDeletedAt || isPackageBlockedFromPublic(pkg.scanStatus)) {
    throw new ConvexError("This package is unavailable and its releases cannot be deleted.");
  }
  if (pkg.family === "skill") {
    throw new ConvexError("Skill packages must use the skills deletion flow.");
  }

  await assertCanManageOwnedResource(ctx, {
    actor,
    ownerUserId: pkg.ownerUserId,
    ownerPublisherId: pkg.ownerPublisherId,
    allowedPublisherRoles: ["admin"],
  });

  const release = await ctx.db
    .query("packageReleases")
    .withIndex("by_package_version", (q) => q.eq("packageId", pkg._id).eq("version", args.version))
    .unique();
  if (!isPackageReleaseAvailableForOwnerDeleteSafety(release, pkg._id)) {
    throw new ConvexError("This package release is already unavailable and cannot be deleted.");
  }

  let mustPublishReplacement =
    pkg.latestReleaseId === release._id ||
    pkg.tags.latest === release._id ||
    pkg.latestVersionSummary?.version === release.version ||
    release.distTags?.includes("latest") === true;
  if (!mustPublishReplacement && !(await hasAvailableLatestPackageReleasePointer(ctx, pkg))) {
    // Admin cleanup can clear latest pointers, so prove a survivor with a bounded indexed read.
    mustPublishReplacement = !(await hasBoundedAvailablePackageReleaseSurvivor(
      ctx,
      pkg._id,
      release._id,
    ));
  }
  if (mustPublishReplacement) {
    throw new ConvexError(
      "Publish a replacement release before deleting the current latest release.",
    );
  }

  const now = Date.now();
  await ctx.db.patch(release._id, {
    softDeletedAt: now,
    ownerDeletedAt: now,
    ownerDeletedBy: actor._id,
  });

  const nextTags = Object.fromEntries(
    Object.entries(pkg.tags ?? {}).filter(([, releaseId]) => releaseId !== release._id),
  ) as Doc<"packages">["tags"];
  if (Object.keys(nextTags).length !== Object.keys(pkg.tags ?? {}).length) {
    const packagePatch: Partial<Doc<"packages">> = {
      tags: nextTags,
      updatedAt: now,
    };
    const nextPackage: Doc<"packages"> = {
      ...pkg,
      ...packagePatch,
    };
    await ctx.db.patch(pkg._id, packagePatch);
    const owner = await getOwnerPublisher(ctx, {
      ownerPublisherId: pkg.ownerPublisherId,
      ownerUserId: pkg.ownerUserId,
    });
    await upsertPackageSearchDigest(ctx, {
      ...extractPackageDigestFields(nextPackage),
      ownerHandle: owner?.handle ?? "",
      ownerKind: owner?.kind,
    });
  }

  await ctx.db.insert("auditLogs", {
    actorUserId: actor._id,
    action: "package.release.delete",
    targetType: "packageRelease",
    targetId: release._id,
    metadata: {
      packageId: pkg._id,
      name: pkg.name,
      version: release.version,
    },
    createdAt: now,
  });

  return { ok: true as const, packageId: pkg._id, releaseId: release._id };
}

export const deleteOwnedReleaseForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    name: v.string(),
    version: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");

    const version = args.version.trim();
    if (!version) throw new ConvexError("Version required");

    return await deleteOwnedPackageReleaseForActor(ctx, actor, {
      name: args.name,
      version,
    });
  },
});

export const deleteOwnedRelease = mutation({
  args: { name: v.string(), version: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    return await deleteOwnedPackageReleaseForActor(ctx, user, args);
  },
});

function isPackageReleaseRestorableByOwner(
  release: Doc<"packageReleases"> | null | undefined,
  packageId: Id<"packages">,
  actorUserId: Id<"users">,
): release is Doc<"packageReleases"> {
  return Boolean(
    release &&
    release.packageId === packageId &&
    release.softDeletedAt !== undefined &&
    release.ownerDeletedAt !== undefined &&
    release.softDeletedAt === release.ownerDeletedAt &&
    release.ownerDeletedBy === actorUserId &&
    resolvePackageReleaseScanStatus(release) !== "malicious" &&
    release.manualModeration?.state !== "quarantined" &&
    release.manualModeration?.state !== "revoked",
  );
}

export async function restoreOwnedPackageReleaseForActor(
  ctx: MutationCtx,
  actor: Doc<"users">,
  args: { name: string; version: string },
) {
  const normalizedName = normalizePackageName(args.name);
  const pkg = await getPackageByNormalizedName(ctx, normalizedName);
  if (!pkg || pkg.softDeletedAt || isPackageBlockedFromPublic(pkg.scanStatus)) {
    throw new ConvexError("This package is unavailable and its releases cannot be restored.");
  }
  if (pkg.family === "skill") {
    throw new ConvexError("Skill packages must use the skills restore flow.");
  }

  await assertCanManageOwnedResource(ctx, {
    actor,
    ownerUserId: pkg.ownerUserId,
    ownerPublisherId: pkg.ownerPublisherId,
    allowedPublisherRoles: ["admin"],
  });

  const release = await ctx.db
    .query("packageReleases")
    .withIndex("by_package_version", (q) => q.eq("packageId", pkg._id).eq("version", args.version))
    .unique();
  if (!isPackageReleaseRestorableByOwner(release, pkg._id, actor._id)) {
    throw new ConvexError(
      "This package release was not withdrawn by this owner and cannot be restored.",
    );
  }

  const now = Date.now();
  await ctx.db.patch(release._id, {
    softDeletedAt: undefined,
    ownerDeletedAt: undefined,
    ownerDeletedBy: undefined,
    distTags: [],
  });
  await ctx.db.insert("auditLogs", {
    actorUserId: actor._id,
    action: "package.release.restore",
    targetType: "packageRelease",
    targetId: release._id,
    metadata: {
      packageId: pkg._id,
      name: pkg.name,
      version: release.version,
    },
    createdAt: now,
  });

  return { ok: true as const, packageId: pkg._id, releaseId: release._id };
}

export const restoreOwnedReleaseForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    name: v.string(),
    version: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");

    const version = args.version.trim();
    if (!version) throw new ConvexError("Version required");

    return await restoreOwnedPackageReleaseForActor(ctx, actor, {
      name: args.name,
      version,
    });
  },
});

export const restoreOwnedRelease = mutation({
  args: { name: v.string(), version: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    return await restoreOwnedPackageReleaseForActor(ctx, user, args);
  },
});

export const moderatePackageReleaseForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    name: v.string(),
    version: v.string(),
    state: v.union(v.literal("approved"), v.literal("quarantined"), v.literal("revoked")),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
    assertModerator(actor);

    const normalizedName = normalizePackageName(args.name);
    const pkg = await getPackageByNormalizedName(ctx, normalizedName);
    if (!pkg || pkg.softDeletedAt || pkg.family === "skill") {
      throw new ConvexError("Package not found");
    }

    const release = await ctx.db
      .query("packageReleases")
      .withIndex("by_package_version", (q) =>
        q.eq("packageId", pkg._id).eq("version", args.version),
      )
      .unique();
    if (!release || release.softDeletedAt) throw new ConvexError("Version not found");

    const now = Date.now();
    const reason = args.reason.trim();
    if (!reason) throw new ConvexError("Moderation reason required");

    const scanStatus = args.state === "approved" ? ("clean" as const) : ("malicious" as const);
    const verification = release.verification
      ? {
          ...release.verification,
          scanStatus,
        }
      : release.verification;
    const patch: Partial<Doc<"packageReleases">> = {
      manualModeration: {
        state: args.state,
        reason,
        reviewerUserId: actor._id,
        updatedAt: now,
      },
      verification,
    };

    await ctx.db.patch(release._id, patch);
    const updatedRelease = { ...release, ...patch } as Doc<"packageReleases">;
    await syncLatestPackageVerification(ctx, updatedRelease);
    await ctx.db.insert("auditLogs", {
      actorUserId: actor._id,
      action: "package.release.moderation",
      targetType: "packageRelease",
      targetId: release._id,
      metadata: {
        packageId: pkg._id,
        packageName: pkg.name,
        version: release.version,
        state: args.state,
        reason,
      },
      createdAt: now,
    });

    return {
      ok: true as const,
      packageId: pkg._id,
      releaseId: release._id,
      state: args.state,
      scanStatus,
    };
  },
});

async function applyPackageReleaseModerationFinalAction(
  ctx: MutationCtx,
  params: {
    actorUserId: Id<"users">;
    pkg: Doc<"packages">;
    release: Doc<"packageReleases">;
    state: "approved" | "quarantined" | "revoked";
    reason: string;
    sourceKind: "report" | "appeal";
    sourceId: Id<"packageReports"> | Id<"packageAppeals">;
    now: number;
  },
) {
  const reason = params.reason.trim();
  if (!reason) throw new ConvexError("Moderation reason required");

  const scanStatus = params.state === "approved" ? ("clean" as const) : ("malicious" as const);
  const verification = params.release.verification
    ? {
        ...params.release.verification,
        scanStatus,
      }
    : params.release.verification;
  const patch: Partial<Doc<"packageReleases">> = {
    manualModeration: {
      state: params.state,
      reason,
      reviewerUserId: params.actorUserId,
      updatedAt: params.now,
    },
    verification,
  };

  await ctx.db.patch(params.release._id, patch);
  const updatedRelease = { ...params.release, ...patch } as Doc<"packageReleases">;
  await syncLatestPackageVerification(ctx, updatedRelease);
  await ctx.db.insert("auditLogs", {
    actorUserId: params.actorUserId,
    action: "package.release.moderation",
    targetType: "packageRelease",
    targetId: params.release._id,
    metadata: {
      packageId: params.pkg._id,
      packageName: params.pkg.name,
      version: params.release.version,
      state: params.state,
      reason,
      sourceKind: params.sourceKind,
      sourceId: params.sourceId,
    },
    createdAt: params.now,
  });

  return { state: params.state, scanStatus };
}

async function countActivePackageReportsForUser(ctx: MutationCtx, userId: Id<"users">) {
  const reports = await ctx.db
    .query("packageReports")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();

  let count = 0;
  for (const report of reports) {
    if (report.status !== "open") continue;
    const pkg = await ctx.db.get(report.packageId);
    if (!pkg || pkg.softDeletedAt) continue;
    const owner = await ctx.db.get(pkg.ownerUserId);
    if (!owner || owner.deletedAt || owner.deactivatedAt) continue;
    count += 1;
    if (count >= MAX_ACTIVE_REPORTS_PER_USER) break;
  }

  return count;
}

export const reportPackageForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    name: v.string(),
    version: v.optional(v.string()),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) {
      throw new ConvexError("Unauthorized");
    }

    const pkg = await getPackageByNormalizedName(ctx, normalizePackageName(args.name));
    if (!pkg || pkg.softDeletedAt) throw new ConvexError("Package not found");
    if (!(await canViewerReadPackage(ctx, pkg, actor._id))) {
      throw new ConvexError("Package not found");
    }

    const reason = args.reason.trim();
    if (!reason) throw new ConvexError("Report reason required.");

    const version = args.version?.trim();
    let release: Doc<"packageReleases"> | null = null;
    if (version) {
      release = await ctx.db
        .query("packageReleases")
        .withIndex("by_package_version", (q) => q.eq("packageId", pkg._id).eq("version", version))
        .unique();
      if (!release || release.softDeletedAt) throw new ConvexError("Package version not found");
    } else if (pkg.latestReleaseId) {
      const latest = await ctx.db.get(pkg.latestReleaseId);
      release = latest && !latest.softDeletedAt ? latest : null;
    }

    const existing = await ctx.db
      .query("packageReports")
      .withIndex("by_package_user", (q) => q.eq("packageId", pkg._id).eq("userId", actor._id))
      .unique();
    if (existing) {
      if (existing.status !== "open") {
        const activeReports = await countActivePackageReportsForUser(ctx, actor._id);
        if (activeReports >= MAX_ACTIVE_REPORTS_PER_USER) {
          throw new ConvexError(
            "Report limit reached. Please wait for moderation before reporting more.",
          );
        }
        const now = Date.now();
        await ctx.db.patch(existing._id, {
          ...(release ? { releaseId: release._id, version: release.version } : {}),
          reason: reason.slice(0, MAX_REPORT_REASON_LENGTH),
          status: "open",
          triagedAt: undefined,
          triagedBy: undefined,
          triageNote: undefined,
          createdAt: now,
        });
        const nextReportCount = (pkg.reportCount ?? 0) + 1;
        await ctx.db.patch(pkg._id, {
          reportCount: nextReportCount,
          lastReportedAt: now,
        });
        const eventMetadata = {
          packageId: pkg._id,
          packageName: pkg.name,
          releaseId: release?._id ?? existing.releaseId ?? null,
          version: release?.version ?? version ?? null,
          reportCount: nextReportCount,
        };
        await appendPackageModerationEventLog(ctx, {
          kind: "report",
          reportId: existing._id,
          actorUserId: actor._id,
          action: "package.report.reopen",
          timelineMetadata: eventMetadata,
          auditAction: "package.report.reopen",
          auditTargetType: "package",
          auditTargetId: pkg._id,
          auditMetadata: {
            reportId: existing._id,
            ...eventMetadata,
          },
          createdAt: now,
        });
        return {
          ok: true as const,
          reported: true,
          alreadyReported: false,
          packageId: pkg._id,
          releaseId: release?._id ?? existing.releaseId ?? null,
          reportCount: nextReportCount,
        };
      }
      return {
        ok: true as const,
        reported: false,
        alreadyReported: true,
        packageId: pkg._id,
        releaseId: existing.releaseId ?? null,
        reportCount: pkg.reportCount ?? 0,
      };
    }

    const activeReports = await countActivePackageReportsForUser(ctx, actor._id);
    if (activeReports >= MAX_ACTIVE_REPORTS_PER_USER) {
      throw new ConvexError(
        "Report limit reached. Please wait for moderation before reporting more.",
      );
    }

    const now = Date.now();
    const reportId = await ctx.db.insert("packageReports", {
      packageId: pkg._id,
      ...(release ? { releaseId: release._id, version: release.version } : {}),
      userId: actor._id,
      reason: reason.slice(0, MAX_REPORT_REASON_LENGTH),
      status: "open",
      createdAt: now,
    });

    const nextReportCount = (pkg.reportCount ?? 0) + 1;
    await ctx.db.patch(pkg._id, {
      reportCount: nextReportCount,
      lastReportedAt: now,
    });

    const eventMetadata = {
      packageId: pkg._id,
      packageName: pkg.name,
      releaseId: release?._id ?? null,
      version: release?.version ?? version ?? null,
      reportCount: nextReportCount,
    };
    await appendPackageModerationEventLog(ctx, {
      kind: "report",
      reportId,
      actorUserId: actor._id,
      action: "package.report.submit",
      timelineMetadata: eventMetadata,
      auditAction: "package.report",
      auditTargetType: "package",
      auditTargetId: pkg._id,
      auditMetadata: {
        reportId,
        ...eventMetadata,
      },
      createdAt: now,
    });

    return {
      ok: true as const,
      reported: true,
      alreadyReported: false,
      packageId: pkg._id,
      releaseId: release?._id ?? null,
      reportCount: nextReportCount,
    };
  },
});

function toPackageReportListItem(
  report: Doc<"packageReports">,
  pkg: Doc<"packages">,
  reporter: Doc<"users"> | null,
): PackageReportListItem {
  return {
    reportId: report._id,
    packageId: pkg._id,
    releaseId: report.releaseId ?? null,
    name: pkg.name,
    displayName: pkg.displayName,
    family: pkg.family,
    version: report.version ?? null,
    reason: report.reason ?? null,
    status: readArtifactReportStatus(report.status),
    createdAt: report.createdAt,
    reporter: {
      userId: report.userId,
      handle: reporter?.handle ?? null,
      displayName: reporter?.displayName ?? reporter?.name ?? null,
    },
    triagedAt: report.triagedAt ?? null,
    triagedBy: report.triagedBy ?? null,
    triageNote: report.triageNote ?? null,
    actionTaken: report.actionTaken ?? null,
  };
}

export const listPackageReportsInternal = internalQuery({
  args: {
    actorUserId: v.id("users"),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    status: v.optional(
      v.union(v.literal("open"), v.literal("confirmed"), v.literal("dismissed"), v.literal("all")),
    ),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
    assertModerator(actor);

    const limit = Math.max(1, Math.min(Math.round(args.limit ?? 25), 100));
    const status = args.status ?? "open";
    const reportQuery =
      status === "all"
        ? ctx.db.query("packageReports").withIndex("by_createdAt", (q) => q)
        : ctx.db
            .query("packageReports")
            .withIndex("by_status_createdAt", (q) => q.eq("status", status));
    const page = await reportQuery.order("desc").paginate({
      cursor: args.cursor ?? null,
      numItems: limit,
    });

    const items: PackageReportListItem[] = [];
    for (const report of page.page) {
      const pkg = await ctx.db.get(report.packageId);
      if (!pkg || pkg.softDeletedAt || pkg.family === "skill") continue;
      const reporter = await ctx.db.get(report.userId);
      items.push(toPackageReportListItem(report, pkg, reporter));
    }

    return {
      items,
      nextCursor: page.isDone ? null : page.continueCursor,
      done: page.isDone,
    };
  },
});

export const triagePackageReportForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    reportId: v.id("packageReports"),
    status: v.union(v.literal("open"), v.literal("confirmed"), v.literal("dismissed")),
    note: v.optional(v.string()),
    finalAction: v.optional(
      v.union(v.literal("none"), v.literal("quarantine"), v.literal("revoke")),
    ),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
    assertModerator(actor);

    const report = await ctx.db.get(args.reportId);
    if (!report) throw new ConvexError("Package report not found");
    const pkg = await ctx.db.get(report.packageId);
    if (!pkg || pkg.softDeletedAt) throw new ConvexError("Package report not found");

    const now = Date.now();
    const previousStatus = readArtifactReportStatus(report.status);
    const nextStatus = args.status;
    assertArtifactReportTransition(previousStatus, nextStatus);
    const wasOpen = previousStatus === "open";
    const willBeOpen = nextStatus === "open";
    const note = args.note?.trim();
    if (!willBeOpen && !note) throw new ConvexError("Review note required.");
    const finalAction = args.finalAction ?? "none";
    assertArtifactReportFinalAction(nextStatus, finalAction, ["quarantine", "revoke"]);

    await ctx.db.patch(report._id, {
      status: nextStatus,
      triagedAt: willBeOpen ? undefined : now,
      triagedBy: willBeOpen ? undefined : actor._id,
      triageNote: willBeOpen ? undefined : note?.slice(0, MAX_REPORT_REASON_LENGTH),
      actionTaken: willBeOpen ? undefined : finalAction,
    });

    let reportCount = pkg.reportCount ?? 0;
    if (wasOpen && !willBeOpen) reportCount = Math.max(0, reportCount - 1);
    if (!wasOpen && willBeOpen) reportCount += 1;
    if (reportCount !== (pkg.reportCount ?? 0)) {
      await ctx.db.patch(pkg._id, {
        reportCount,
        ...(willBeOpen ? { lastReportedAt: now } : {}),
      });
    }

    let moderatedRelease: Doc<"packageReleases"> | null = null;
    if (finalAction !== "none") {
      const releaseId = report.releaseId ?? pkg.latestReleaseId;
      if (!releaseId) throw new ConvexError("Package report has no release to moderate");
      const release = await ctx.db.get(releaseId);
      if (!release || release.softDeletedAt) {
        throw new ConvexError("Package report release not found");
      }
      moderatedRelease = release;
      await applyPackageReleaseModerationFinalAction(ctx, {
        actorUserId: actor._id,
        pkg,
        release,
        state: finalAction === "quarantine" ? "quarantined" : "revoked",
        reason: note ?? "",
        sourceKind: "report",
        sourceId: report._id,
        now,
      });
    }

    const eventMetadata = {
      packageId: pkg._id,
      packageName: pkg.name,
      status: args.status,
      finalAction,
      releaseId: moderatedRelease?._id ?? report.releaseId ?? null,
      version: moderatedRelease?.version ?? report.version ?? null,
      reportCount,
    };
    await appendPackageModerationEventLog(ctx, {
      kind: "report",
      reportId: report._id,
      actorUserId: actor._id,
      action: "package.report.triage",
      timelineMetadata: eventMetadata,
      auditAction: "package.report.triage",
      auditTargetType: "packageReport",
      auditTargetId: report._id,
      auditMetadata: eventMetadata,
      createdAt: now,
    });

    return {
      ok: true as const,
      reportId: report._id,
      packageId: pkg._id,
      status: args.status,
      reportCount,
      actionTaken: finalAction,
    };
  },
});

export const getPackageModerationStatusForUserInternal = internalQuery({
  args: {
    actorUserId: v.id("users"),
    name: v.string(),
  },
  handler: async (ctx, args): Promise<PackageModerationStatus> => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");

    const pkg = await getPackageByNormalizedName(ctx, normalizePackageName(args.name));
    if (!pkg || pkg.softDeletedAt) throw new ConvexError("Package not found");

    const canSeeOwnerStatus = await viewerCanAccessPackageOwner(ctx, pkg, actor._id);
    const canSeeStaffStatus = actor.role === "admin" || actor.role === "moderator";
    if (!canSeeOwnerStatus && !canSeeStaffStatus) throw new ConvexError("Unauthorized");

    const latestRelease = pkg.latestReleaseId ? await ctx.db.get(pkg.latestReleaseId) : null;
    const activeLatestRelease =
      latestRelease && !latestRelease.softDeletedAt ? latestRelease : null;
    const latestReleaseStatus = activeLatestRelease
      ? (() => {
          const releaseScanStatus = resolvePackageReleaseScanStatus(activeLatestRelease);
          return {
            releaseId: activeLatestRelease._id,
            version: activeLatestRelease.version,
            artifactKind: activeLatestRelease.artifactKind ?? null,
            scanStatus: releaseScanStatus,
            moderationState: activeLatestRelease.manualModeration?.state ?? null,
            moderationReason: activeLatestRelease.manualModeration?.reason ?? null,
            blockedFromDownload: releaseScanStatus === "malicious",
            reasons: getPackageTrustReasons(
              activeLatestRelease,
              releaseScanStatus,
              pkg.reportCount ?? 0,
            ),
            createdAt: activeLatestRelease.createdAt,
          };
        })()
      : null;

    return {
      package: {
        packageId: pkg._id,
        name: pkg.name,
        displayName: pkg.displayName,
        family: pkg.family,
        channel: pkg.channel,
        isOfficial: pkg.isOfficial,
        reportCount: pkg.reportCount ?? 0,
        lastReportedAt: pkg.lastReportedAt ?? null,
        scanStatus: latestReleaseStatus?.scanStatus ?? pkg.scanStatus,
      },
      latestRelease: latestReleaseStatus,
    };
  },
});

// Deprecated compatibility path. First-class appeal intake is no longer exposed
// in the CLI/docs; keep this route backed until legacy clients age out.
export const submitPackageAppealForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    name: v.string(),
    version: v.string(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");

    const pkg = await getPackageByNormalizedName(ctx, normalizePackageName(args.name));
    if (!pkg || pkg.softDeletedAt) throw new ConvexError("Package not found");
    if (!(await viewerCanAccessPackageOwner(ctx, pkg, actor._id))) {
      throw new ConvexError("Unauthorized");
    }

    const version = args.version.trim();
    if (!version) throw new ConvexError("Package version required");
    const release = await ctx.db
      .query("packageReleases")
      .withIndex("by_package_version", (q) => q.eq("packageId", pkg._id).eq("version", version))
      .unique();
    if (!release || release.softDeletedAt) throw new ConvexError("Package version not found");

    const scanStatus = resolvePackageReleaseScanStatus(release);
    const moderationState = release.manualModeration?.state ?? null;
    const isAppealable =
      moderationState === "quarantined" ||
      moderationState === "revoked" ||
      scanStatus === "suspicious" ||
      scanStatus === "malicious";
    if (!isAppealable) throw new ConvexError("Package release is not in an appealable state");

    const message = args.message.trim();
    if (!message) throw new ConvexError("Appeal message required.");

    const existingOpenAppeal = await ctx.db
      .query("packageAppeals")
      .withIndex("by_release_status_createdAt", (q) =>
        q.eq("releaseId", release._id).eq("status", "open"),
      )
      .order("desc")
      .first();
    if (existingOpenAppeal) {
      return {
        ok: true as const,
        submitted: false,
        alreadyOpen: true,
        appealId: existingOpenAppeal._id,
        packageId: pkg._id,
        releaseId: release._id,
        status: existingOpenAppeal.status,
      };
    }

    const now = Date.now();
    const appealId = await ctx.db.insert("packageAppeals", {
      packageId: pkg._id,
      releaseId: release._id,
      version: release.version,
      userId: actor._id,
      message: message.slice(0, MAX_APPEAL_MESSAGE_LENGTH),
      status: "open",
      createdAt: now,
    });

    const eventMetadata = {
      packageId: pkg._id,
      releaseId: release._id,
      packageName: pkg.name,
      version: release.version,
      moderationState,
      scanStatus,
    };
    await appendPackageModerationEventLog(ctx, {
      kind: "appeal",
      appealId,
      actorUserId: actor._id,
      action: "package.appeal.submit",
      timelineMetadata: eventMetadata,
      auditAction: "package.appeal.submit",
      auditTargetType: "packageAppeal",
      auditTargetId: appealId,
      auditMetadata: eventMetadata,
      createdAt: now,
    });

    return {
      ok: true as const,
      submitted: true,
      alreadyOpen: false,
      appealId,
      packageId: pkg._id,
      releaseId: release._id,
      status: "open" as const,
    };
  },
});

function toPackageAppealListItem(
  appeal: Doc<"packageAppeals">,
  pkg: Doc<"packages">,
  submitter: Doc<"users"> | null,
): PackageAppealListItem {
  return {
    appealId: appeal._id,
    packageId: pkg._id,
    releaseId: appeal.releaseId,
    name: pkg.name,
    displayName: pkg.displayName,
    family: pkg.family,
    version: appeal.version,
    message: appeal.message,
    status: appeal.status,
    createdAt: appeal.createdAt,
    submitter: {
      userId: appeal.userId,
      handle: submitter?.handle ?? null,
      displayName: submitter?.displayName ?? submitter?.name ?? null,
    },
    resolvedAt: appeal.resolvedAt ?? null,
    resolvedBy: appeal.resolvedBy ?? null,
    resolutionNote: appeal.resolutionNote ?? null,
    actionTaken: appeal.actionTaken ?? null,
  };
}

export const listPackageAppealsInternal = internalQuery({
  args: {
    actorUserId: v.id("users"),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    status: v.optional(
      v.union(v.literal("open"), v.literal("accepted"), v.literal("rejected"), v.literal("all")),
    ),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
    assertModerator(actor);

    const limit = Math.max(1, Math.min(Math.round(args.limit ?? 25), 100));
    const status = args.status ?? "open";
    const appealQuery =
      status === "all"
        ? ctx.db.query("packageAppeals").withIndex("by_createdAt", (q) => q)
        : ctx.db
            .query("packageAppeals")
            .withIndex("by_status_createdAt", (q) => q.eq("status", status));
    const page = await appealQuery.order("desc").paginate({
      cursor: args.cursor ?? null,
      numItems: limit,
    });

    const items: PackageAppealListItem[] = [];
    for (const appeal of page.page) {
      const pkg = await ctx.db.get(appeal.packageId);
      if (!pkg || pkg.softDeletedAt || pkg.family === "skill") continue;
      const submitter = await ctx.db.get(appeal.userId);
      items.push(toPackageAppealListItem(appeal, pkg, submitter));
    }

    return {
      items,
      nextCursor: page.isDone ? null : page.continueCursor,
      done: page.isDone,
    };
  },
});

export const resolvePackageAppealForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    appealId: v.id("packageAppeals"),
    status: v.union(v.literal("open"), v.literal("accepted"), v.literal("rejected")),
    note: v.optional(v.string()),
    finalAction: v.optional(v.union(v.literal("none"), v.literal("approve"))),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
    assertModerator(actor);

    const appeal = await ctx.db.get(args.appealId);
    if (!appeal) throw new ConvexError("Package appeal not found");
    const pkg = await ctx.db.get(appeal.packageId);
    if (!pkg || pkg.softDeletedAt) throw new ConvexError("Package appeal not found");

    const note = args.note?.trim();
    const isOpen = args.status === "open";
    assertArtifactAppealTransition(appeal.status, args.status);
    if (!isOpen && !note) throw new ConvexError("Resolution note required.");
    const finalAction = args.finalAction ?? "none";
    assertArtifactAppealFinalAction(args.status, finalAction, ["approve"]);
    const now = Date.now();

    await ctx.db.patch(appeal._id, {
      status: args.status,
      resolvedAt: isOpen ? undefined : now,
      resolvedBy: isOpen ? undefined : actor._id,
      resolutionNote: isOpen ? undefined : note?.slice(0, MAX_APPEAL_MESSAGE_LENGTH),
      actionTaken: isOpen ? undefined : finalAction,
    });

    if (finalAction === "approve") {
      const release = await ctx.db.get(appeal.releaseId);
      if (!release || release.softDeletedAt)
        throw new ConvexError("Package appeal release not found");
      await applyPackageReleaseModerationFinalAction(ctx, {
        actorUserId: actor._id,
        pkg,
        release,
        state: "approved",
        reason: note ?? "",
        sourceKind: "appeal",
        sourceId: appeal._id,
        now,
      });
    }

    const eventMetadata = {
      packageId: pkg._id,
      releaseId: appeal.releaseId,
      packageName: pkg.name,
      version: appeal.version,
      status: args.status,
      finalAction,
    };
    await appendPackageModerationEventLog(ctx, {
      kind: "appeal",
      appealId: appeal._id,
      actorUserId: actor._id,
      action: "package.appeal.resolve",
      timelineMetadata: eventMetadata,
      auditAction: "package.appeal.resolve",
      auditTargetType: "packageAppeal",
      auditTargetId: appeal._id,
      auditMetadata: eventMetadata,
      createdAt: now,
    });

    return {
      ok: true as const,
      appealId: appeal._id,
      packageId: pkg._id,
      releaseId: appeal.releaseId,
      status: args.status,
      actionTaken: finalAction,
    };
  },
});

export const listPackageModerationEventLogsInternal = internalQuery({
  args: {
    actorUserId: v.id("users"),
    kind: v.union(v.literal("report"), v.literal("appeal")),
    reportId: v.optional(v.id("packageReports")),
    appealId: v.optional(v.id("packageAppeals")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
    assertModerator(actor);

    const limit = Math.max(1, Math.min(Math.round(args.limit ?? 50), 100));
    if (args.kind === "report") {
      if (!args.reportId) throw new ConvexError("reportId required");
      return await ctx.db
        .query("packageModerationEventLogs")
        .withIndex("by_report_createdAt", (q) => q.eq("reportId", args.reportId))
        .order("asc")
        .take(limit);
    }
    if (!args.appealId) throw new ConvexError("appealId required");
    return await ctx.db
      .query("packageModerationEventLogs")
      .withIndex("by_appeal_createdAt", (q) => q.eq("appealId", args.appealId))
      .order("asc")
      .take(limit);
  },
});

function normalizeOfficialMigrationId(raw: string) {
  const value = raw.trim().toLowerCase();
  if (!value) throw new ConvexError("Bundled plugin id required");
  if (value.length > MAX_OFFICIAL_MIGRATION_FIELD_LENGTH) {
    throw new ConvexError("Bundled plugin id too long");
  }
  if (!/^[a-z0-9][a-z0-9._:-]*$/.test(value)) {
    throw new ConvexError(
      "Bundled plugin id must use letters, numbers, dot, dash, underscore, or colon.",
    );
  }
  return value;
}

function normalizeOptionalMigrationText(raw: string | undefined) {
  const value = raw?.trim();
  if (!value) return undefined;
  return value.slice(0, MAX_OFFICIAL_MIGRATION_FIELD_LENGTH);
}

function normalizeMigrationBlockers(raw: string[] | undefined) {
  if (!raw) return undefined;
  const blockers: string[] = [];
  const seen = new Set<string>();
  for (const blocker of raw) {
    const value = blocker.trim().slice(0, MAX_OFFICIAL_MIGRATION_FIELD_LENGTH);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    blockers.push(value);
    if (blockers.length >= MAX_OFFICIAL_MIGRATION_BLOCKERS) break;
  }
  return blockers;
}

function toPackageOfficialMigrationItem(
  migration: Doc<"officialPluginMigrations">,
): PackageOfficialMigrationListItem {
  return {
    migrationId: migration._id,
    bundledPluginId: migration.bundledPluginId,
    packageName: migration.packageName,
    packageId: migration.packageId ?? null,
    owner: migration.owner ?? null,
    sourceRepo: migration.sourceRepo ?? null,
    sourcePath: migration.sourcePath ?? null,
    sourceCommit: migration.sourceCommit ?? null,
    phase: migration.phase,
    blockers: migration.blockers,
    hostTargetsComplete: migration.hostTargetsComplete,
    scanClean: migration.scanClean,
    moderationApproved: migration.moderationApproved,
    runtimeBundlesReady: migration.runtimeBundlesReady,
    notes: migration.notes ?? null,
    createdAt: migration.createdAt,
    updatedAt: migration.updatedAt,
  };
}

export const listOfficialPluginMigrationsInternal = internalQuery({
  args: {
    actorUserId: v.id("users"),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    phase: v.optional(v.union(packageOfficialMigrationPhaseValidator, v.literal("all"))),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
    assertModerator(actor);

    const limit = Math.max(1, Math.min(Math.round(args.limit ?? 25), 100));
    const phase: PackageOfficialMigrationListPhase = args.phase ?? "all";
    const migrationQuery =
      phase === "all"
        ? ctx.db.query("officialPluginMigrations").withIndex("by_updatedAt", (q) => q)
        : ctx.db
            .query("officialPluginMigrations")
            .withIndex("by_phase_updatedAt", (q) => q.eq("phase", phase));
    const page = await migrationQuery.order("desc").paginate({
      cursor: args.cursor ?? null,
      numItems: limit,
    });

    return {
      items: page.page.map(toPackageOfficialMigrationItem),
      nextCursor: page.isDone ? null : page.continueCursor,
      done: page.isDone,
    };
  },
});

export const upsertOfficialPluginMigrationForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    bundledPluginId: v.string(),
    packageName: v.string(),
    owner: v.optional(v.string()),
    sourceRepo: v.optional(v.string()),
    sourcePath: v.optional(v.string()),
    sourceCommit: v.optional(v.string()),
    phase: v.optional(packageOfficialMigrationPhaseValidator),
    blockers: v.optional(v.array(v.string())),
    hostTargetsComplete: v.optional(v.boolean()),
    scanClean: v.optional(v.boolean()),
    moderationApproved: v.optional(v.boolean()),
    runtimeBundlesReady: v.optional(v.boolean()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
    assertAdmin(actor);

    const bundledPluginId = normalizeOfficialMigrationId(args.bundledPluginId);
    const packageName = normalizePackageName(args.packageName);
    const packageDoc = await ctx.db
      .query("packages")
      .withIndex("by_name", (q) => q.eq("normalizedName", packageName))
      .unique();
    const existing = await ctx.db
      .query("officialPluginMigrations")
      .withIndex("by_bundled_plugin", (q) => q.eq("bundledPluginId", bundledPluginId))
      .unique();
    const blockers = normalizeMigrationBlockers(args.blockers);
    const now = Date.now();

    if (existing) {
      const patch: Partial<Doc<"officialPluginMigrations">> = {
        packageName,
        packageId: packageDoc && !packageDoc.softDeletedAt ? packageDoc._id : undefined,
        owner: normalizeOptionalMigrationText(args.owner),
        sourceRepo: normalizeOptionalMigrationText(args.sourceRepo),
        sourcePath: normalizeOptionalMigrationText(args.sourcePath),
        sourceCommit: normalizeOptionalMigrationText(args.sourceCommit),
        phase: args.phase ?? existing.phase,
        blockers: blockers ?? existing.blockers,
        hostTargetsComplete: args.hostTargetsComplete ?? existing.hostTargetsComplete,
        scanClean: args.scanClean ?? existing.scanClean,
        moderationApproved: args.moderationApproved ?? existing.moderationApproved,
        runtimeBundlesReady: args.runtimeBundlesReady ?? existing.runtimeBundlesReady,
        notes: args.notes?.trim().slice(0, MAX_OFFICIAL_MIGRATION_NOTES_LENGTH),
        updatedAt: now,
      };
      await ctx.db.patch(existing._id, patch);
      const migration = { ...existing, ...patch } as Doc<"officialPluginMigrations">;
      await ctx.db.insert("auditLogs", {
        actorUserId: actor._id,
        action: "package.official_migration.upsert",
        targetType: "officialPluginMigration",
        targetId: existing._id,
        metadata: {
          bundledPluginId,
          packageName,
          phase: migration.phase,
          packageId: migration.packageId,
        },
        createdAt: now,
      });
      return { ok: true as const, migration: toPackageOfficialMigrationItem(migration) };
    }

    const phase: PackageOfficialMigrationPhase =
      args.phase ?? (blockers && blockers.length > 0 ? "blocked" : "planned");
    const migrationId = await ctx.db.insert("officialPluginMigrations", {
      bundledPluginId,
      packageName,
      packageId: packageDoc && !packageDoc.softDeletedAt ? packageDoc._id : undefined,
      owner: normalizeOptionalMigrationText(args.owner),
      sourceRepo: normalizeOptionalMigrationText(args.sourceRepo),
      sourcePath: normalizeOptionalMigrationText(args.sourcePath),
      sourceCommit: normalizeOptionalMigrationText(args.sourceCommit),
      phase,
      blockers: blockers ?? [],
      hostTargetsComplete: args.hostTargetsComplete ?? false,
      scanClean: args.scanClean ?? false,
      moderationApproved: args.moderationApproved ?? false,
      runtimeBundlesReady: args.runtimeBundlesReady ?? false,
      notes: args.notes?.trim().slice(0, MAX_OFFICIAL_MIGRATION_NOTES_LENGTH),
      createdAt: now,
      updatedAt: now,
    });
    const migration = (await ctx.db.get(migrationId))!;
    await ctx.db.insert("auditLogs", {
      actorUserId: actor._id,
      action: "package.official_migration.upsert",
      targetType: "officialPluginMigration",
      targetId: migrationId,
      metadata: {
        bundledPluginId,
        packageName,
        phase,
        packageId: migration.packageId,
      },
      createdAt: now,
    });

    return { ok: true as const, migration: toPackageOfficialMigrationItem(migration) };
  },
});

export const listPackageModerationQueueInternal = internalQuery({
  args: {
    actorUserId: v.id("users"),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    status: v.optional(
      v.union(v.literal("open"), v.literal("blocked"), v.literal("manual"), v.literal("all")),
    ),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
    assertModerator(actor);

    const limit = Math.max(1, Math.min(Math.round(args.limit ?? 25), 100));
    const status = args.status ?? "open";
    let cursor = args.cursor ?? null;
    let done = false;
    let scannedPages = 0;
    const items: PackageModerationQueueItem[] = [];
    const seenReleaseIds = new Set<string>();

    if (status === "open" || status === "all") {
      const reports = await ctx.db
        .query("packageReports")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "open"))
        .order("desc")
        .take(limit * 3);

      for (const report of reports) {
        if (items.length >= limit) break;
        const pkg = await ctx.db.get(report.packageId);
        if (!pkg || pkg.softDeletedAt || pkg.family === "skill" || !pkg.latestReleaseId) continue;
        const release = await ctx.db.get(pkg.latestReleaseId);
        if (!release || release.softDeletedAt || seenReleaseIds.has(release._id)) continue;
        const item = toPackageModerationQueueItem(pkg, release);
        if (!shouldIncludePackageReportsInModerationQueue(item.reportCount, status)) continue;
        seenReleaseIds.add(release._id);
        items.push(item);
      }
    }

    while (items.length < limit && !done && scannedPages < 5) {
      const page = await ctx.db
        .query("packageReleases")
        .withIndex("by_active_created", (q) => q.eq("softDeletedAt", undefined))
        .order("desc")
        .paginate({
          cursor,
          numItems: limit,
        });

      scannedPages += 1;
      cursor = page.continueCursor;
      done = page.isDone;

      for (const release of page.page) {
        if (items.length >= limit) break;
        const scanStatus = resolvePackageReleaseScanStatus(release);
        const pkg = await ctx.db.get(release.packageId);
        if (!pkg || pkg.softDeletedAt || pkg.family === "skill") continue;
        const reportCount = pkg.reportCount ?? 0;
        const releaseNeedsReview = shouldIncludeReleaseInModerationQueue(
          release,
          scanStatus,
          status,
        );
        const packageReportsNeedReview = shouldIncludePackageReportsInModerationQueue(
          reportCount,
          status,
        );
        if (
          !releaseNeedsReview &&
          (!packageReportsNeedReview || pkg.latestReleaseId !== release._id)
        )
          continue;
        if (seenReleaseIds.has(release._id)) continue;
        seenReleaseIds.add(release._id);
        items.push(toPackageModerationQueueItem(pkg, release));
      }
    }

    return {
      items,
      nextCursor: done ? null : cursor,
      done,
    };
  },
});

export const getReleaseByIdInternal = internalQuery({
  args: { releaseId: v.id("packageReleases") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.releaseId);
  },
});

export const getPackageByIdInternal = internalQuery({
  args: { packageId: v.id("packages") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.packageId);
  },
});

export const getReleaseByPackageAndVersionInternal = internalQuery({
  args: {
    packageId: v.id("packages"),
    version: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("packageReleases")
      .withIndex("by_package_version", (q) =>
        q.eq("packageId", args.packageId).eq("version", args.version),
      )
      .unique();
  },
});

export const getReleasesByIdsInternal = internalQuery({
  args: { releaseIds: v.array(v.id("packageReleases")) },
  handler: async (ctx, args) => {
    return (
      await Promise.all(
        args.releaseIds.map(async (releaseId) => {
          const release = await ctx.db.get(releaseId);
          return release && !release.softDeletedAt ? release : null;
        }),
      )
    ).filter(Boolean);
  },
});

export const getPackageReleaseScanBackfillBatchInternal = internalQuery({
  args: {
    cursor: v.optional(v.number()),
    batchSize: v.optional(v.number()),
    prioritizeRecent: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const batchSize = Math.max(1, Math.min(args.batchSize ?? 50, 200));
    const cursor = args.cursor ?? 0;
    const prioritizeRecent = args.prioritizeRecent ?? true;

    // Each candidate can read a near-1 MiB release and parent package.
    const backlogCandidateLimit = Math.min(
      batchSize * 3,
      MAX_PACKAGE_RELEASE_SCAN_BACKLOG_CANDIDATES,
    );
    const releases = prioritizeRecent
      ? await ctx.db
          .query("packageReleases")
          .order("desc")
          .take(Math.min(batchSize * 2, MAX_PACKAGE_RELEASE_SCAN_RECENT_CANDIDATES))
      : await ctx.db
          .query("packageReleases")
          .withIndex("by_creation_time", (q) => q.gt("_creationTime", cursor))
          .order("asc")
          .take(backlogCandidateLimit);

    const results: Array<{
      releaseId: Id<"packageReleases">;
      packageId: Id<"packages">;
      needsVt: boolean;
      needsLlm: boolean;
      needsStatic: boolean;
    }> = [];
    let nextCursor = cursor;

    for (const release of releases) {
      if (!prioritizeRecent) nextCursor = release._creationTime;
      if (results.length >= batchSize) break;
      if (release.softDeletedAt) continue;

      const pkg = await ctx.db.get(release.packageId);
      if (!pkg || pkg.softDeletedAt || pkg.family === "skill") continue;

      const needsVt = !release.vtAnalysis;
      const needsLlm = !release.llmAnalysis || release.llmAnalysis.status === "error";
      const needsStatic = !release.staticScan;
      if (!needsVt && !needsLlm && !needsStatic) continue;

      results.push({
        releaseId: release._id,
        packageId: release.packageId,
        needsVt,
        needsLlm,
        needsStatic,
      });
    }

    return {
      releases: results,
      nextCursor,
      done: prioritizeRecent ? false : releases.length < backlogCandidateLimit,
    };
  },
});

function buildGitHubActionsPublishActor(
  publishToken: Doc<"packagePublishTokens">,
): Extract<PackagePublishActor, { kind: "github-actions" }> {
  return {
    kind: "github-actions",
    repository: publishToken.repository,
    workflow: publishToken.workflowFilename,
    runId: publishToken.runId,
    runAttempt: publishToken.runAttempt,
    sha: publishToken.sha,
  };
}

function resolveTrustedPublishSource(
  payload: ServerPackagePublishRequest,
  publishToken: Doc<"packagePublishTokens">,
): ServerPackagePublishRequest["source"] {
  const source = payload.source;
  const sourceRepository = publishToken.candidateRepository ?? publishToken.repository;
  const sourceSha = publishToken.candidateSha ?? publishToken.sha;
  if (source && source.kind !== "github") {
    throw new ConvexError("Trusted publishes only support GitHub source metadata");
  }
  const requestedRepo =
    typeof source?.repo === "string" && source.repo.trim()
      ? (normalizeGitHubRepository(source.repo) ?? source.repo.trim())
      : undefined;
  if (requestedRepo && requestedRepo !== sourceRepository) {
    throw new ConvexError("Trusted publish source repo must match the verified GitHub repository");
  }
  if (source?.commit && source.commit !== sourceSha) {
    throw new ConvexError("Trusted publish source commit must match the authorized candidate SHA");
  }
  if (source?.ref && source.ref !== sourceSha) {
    throw new ConvexError("Trusted publish source ref must match the authorized candidate SHA");
  }
  const path = source?.path?.trim() || ".";
  return {
    kind: "github",
    url: `https://github.com/${sourceRepository}`,
    repo: sourceRepository,
    ref: sourceSha,
    commit: sourceSha,
    path,
    importedAt: source?.importedAt ?? Date.now(),
  };
}

function doesTrustedPublisherMatchPublishToken(
  trustedPublisher: PackageTrustedPublisherDoc | null,
  publishToken: Doc<"packagePublishTokens">,
) {
  return Boolean(
    trustedPublisher &&
    trustedPublisher.packageId === publishToken.packageId &&
    trustedPublisher.provider === publishToken.provider &&
    trustedPublisher.repository === publishToken.repository &&
    trustedPublisher.repositoryId === publishToken.repositoryId &&
    trustedPublisher.repositoryOwner === publishToken.repositoryOwner &&
    trustedPublisher.repositoryOwnerId === publishToken.repositoryOwnerId &&
    trustedPublisher.workflowFilename === publishToken.workflowFilename &&
    trustedPublisher.environment === publishToken.environment,
  );
}

function assertOpenClawPublishAuthorizationVersion(token: {
  repository?: string;
  authorizationVersion?: number;
}) {
  if (token.repository === "openclaw/openclaw" && token.authorizationVersion !== 2) {
    throw new ConvexError("OpenClaw trusted publishes require authorization version 2");
  }
}

async function reverifyOpenClawAuthorizationBeforePublish(
  auth: PackagePublishAuthContext,
  transaction: {
    name: string;
    version: string;
    inventoryDigest: string;
  },
) {
  if (auth.kind !== "github-actions" || auth.publishToken.repository !== "openclaw/openclaw")
    return;
  assertOpenClawPublishAuthorizationVersion(auth.publishToken);
  await reverifyOpenClawAuthorizationEvidence(auth.publishToken, transaction, "submission");
}

async function reverifyOpenClawAuthorizationEvidence(
  token: Doc<"packagePublishTokens">,
  transaction: {
    name: string;
    version: string;
    inventoryDigest: string;
  },
  requiredParentState: "submission" | "terminal",
) {
  if (
    !token.trustedToolingIdentityJson ||
    !token.authorizationTransactionKey ||
    !token.authorizationKey ||
    !token.authorizationArtifactId ||
    !token.authorizationArtifactDigest
  ) {
    throw new ConvexError("OpenClaw trusted publish authorization evidence is incomplete");
  }
  const authorization = await verifyOpenClawPublishAuthorization({
    rawIdentity: token.trustedToolingIdentityJson,
    packageName: transaction.name,
    version: transaction.version,
    inventoryDigest: transaction.inventoryDigest,
    requiredParentState,
    oidc: {
      repository: token.repository,
      repositoryId: token.repositoryId,
      repositoryOwner: token.repositoryOwner,
      repositoryOwnerId: token.repositoryOwnerId,
      workflowFilename: token.workflowFilename,
      workflowName: token.workflowFilename,
      workflowRef: `${token.repository}/.github/workflows/${token.workflowFilename}@${token.ref}`,
      environment: token.environment,
      runnerEnvironment: "github-hosted",
      eventName: "workflow_dispatch",
      sha: token.sha,
      ref: token.ref,
      refType: token.refType,
      actor: token.actor,
      actorId: token.actorId,
      runId: token.runId,
      runAttempt: token.runAttempt,
    },
  });
  if (
    token.authorizationTransactionKey !== authorization.transactionKey ||
    token.authorizationKey !== `${token.authorizationTransactionKey}:publish` ||
    token.authorizationArtifactId !== authorization.artifactId ||
    token.authorizationArtifactDigest !== authorization.artifactDigest ||
    token.authorizationRoute !== authorization.authorizationRoute ||
    token.candidateRepository !== authorization.identity.candidateRepository ||
    token.candidateSha !== authorization.identity.candidateSha ||
    token.parentRepository !== authorization.identity.parentRepository ||
    token.parentWorkflow !== authorization.identity.parentWorkflow ||
    token.parentRunId !== authorization.identity.parentRunId ||
    token.parentRunAttempt !== authorization.identity.parentRunAttempt
  ) {
    throw new ConvexError("OpenClaw trusted publish authorization evidence changed after mint");
  }
}

async function reverifyStagedOpenClawAuthorizationBeforeFinalize(
  ctx: ActionCtx,
  claim: {
    attemptId: Id<"publishAttempts">;
    packageId?: Id<"packages">;
    packageFollowup: unknown;
  },
  claimId: string,
) {
  if (manualPackageRecovery(claim.packageFollowup)) {
    return { manualRecoveryAttemptId: claim.attemptId, manualRecoveryClaimId: claimId };
  }
  const followup = claim.packageFollowup as {
    packageName?: string;
    version?: string;
    trustedPublishTokenId?: Id<"packagePublishTokens">;
    trustedPublishInventoryDigest?: string;
    trustedPublishAuthorizationVersion?: number;
    githubActionsAudit?: { repository?: string };
  };
  const token = followup.trustedPublishTokenId
    ? await runQueryRef<Doc<"packagePublishTokens"> | null>(
        ctx,
        internalRefs.packagePublishTokens.getByIdInternal,
        { tokenId: followup.trustedPublishTokenId },
      )
    : null;
  assertOpenClawPublishAuthorizationVersion({
    repository: followup.githubActionsAudit?.repository ?? token?.repository,
    authorizationVersion: followup.trustedPublishAuthorizationVersion,
  });
  if (followup.trustedPublishAuthorizationVersion !== 2) return undefined;
  if (!followup.trustedPublishTokenId) {
    throw new ConvexError("Staged OpenClaw publish authorization token is missing");
  }
  // Staging already consumed this exact transaction. Finalization may outlive
  // the short token TTL, so durable consumed evidence replaces expiry here.
  if (
    !token ||
    token.repository !== "openclaw/openclaw" ||
    token.authorizationVersion !== 2 ||
    !token.consumedAt ||
    token.revokedAt ||
    token.packageId !== claim.packageId ||
    token.version !== followup.version ||
    !token.inventoryDigest ||
    token.inventoryDigest !== followup.trustedPublishInventoryDigest ||
    !followup.packageName
  ) {
    throw new ConvexError("Staged OpenClaw publish authorization no longer matches the release");
  }
  await reverifyOpenClawAuthorizationEvidence(
    token,
    {
      name: followup.packageName,
      version: followup.version,
      inventoryDigest: token.inventoryDigest,
    },
    "terminal",
  );
  return {
    trustedPublishTokenId: token._id,
    trustedPublishInventoryDigest: token.inventoryDigest,
    trustedPublishAuthorizationVersion: 2 as const,
  };
}

async function runPackageInspectorPublishGate(
  ctx: Pick<ActionCtx, "runAction">,
  args: {
    packageName: string;
    version: string;
    files: ReturnType<typeof normalizePublishFiles>;
  },
): Promise<PackageInspectorPublishResult> {
  const result = await runActionRef<PackageInspectorPublishResult>(
    ctx,
    internalRefs.packageInspectorNode.runPackageInspectorForPublishInternal,
    {
      packageName: args.packageName,
      version: args.version,
      files: args.files,
    },
  );
  if (result.status === "fail" || result.summary.breakageCount > 0) {
    throw new ConvexError(formatPackageInspectorBlockedPublishError(result));
  }
  return result;
}

function formatPackageInspectorBlockedPublishError(result: PackageInspectorPublishResult) {
  const count = Math.max(result.summary.breakageCount, result.breakages.length, 1);
  const noun = count === 1 ? "breakage" : "breakages";
  const details = result.breakages
    .slice(0, 3)
    .map((finding) => `${finding.code}: ${finding.message}`)
    .join("; ");
  return `Plugin Inspector blocked publish: ${count} ${noun}${details ? `. ${details}` : ""}`;
}

function packageInspectorWarningDedupeKey(
  warning: Pick<PackageInspectorFinding, "id" | "code" | "message" | "evidence" | "fixture"> & {
    inspectorVersion?: string;
    targetOpenClawVersion?: string;
  },
) {
  return JSON.stringify([
    warning.id ?? "",
    warning.code,
    warning.message,
    warning.fixture ?? "",
    warning.evidence ?? [],
    warning.inspectorVersion ?? "",
    warning.targetOpenClawVersion ?? "",
  ]);
}

async function verifyPublishFileStorageMetadata(
  ctx: Pick<ActionCtx, "storage">,
  files: ReturnType<typeof normalizePublishFiles>,
) {
  const verified = await Promise.all(
    files.map(async (file) => {
      const blob = await ctx.storage.get(file.storageId as Id<"_storage">);
      if (!blob) throw new ConvexError(`Uploaded file no longer exists: ${file.path}`);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return {
        file: {
          ...file,
          size: blob.size,
          sha256: await sha256Hex(bytes),
          contentType: file.contentType?.trim() || blob.type || undefined,
        },
        zipEntry: { path: file.path, bytes },
      };
    }),
  );
  return {
    files: verified.map(({ file }) => file),
    legacyZipEntries: verified.map(({ zipEntry }) => zipEntry),
  };
}

function normalizeStoredPluginCategoryOverride(categories: readonly string[] | undefined) {
  if (categories === undefined) return undefined;
  try {
    return normalizePluginCategories(categories);
  } catch {
    return undefined;
  }
}

async function withSkillMarkdownTextsForManifestSummary(
  ctx: Pick<ActionCtx, "storage">,
  files: ReturnType<typeof normalizePublishFiles>,
) {
  const summaryFiles: Array<
    (typeof files)[number] & {
      text?: string;
    }
  > = [];
  for (const file of files) {
    const lower = file.path.toLowerCase();
    if (lower === "skill.md" || lower.endsWith("/skill.md")) {
      summaryFiles.push({
        ...file,
        text: await readStorageText(ctx, file.storageId),
      });
    } else {
      summaryFiles.push(file);
    }
  }
  return summaryFiles;
}

async function publishPackageImpl(
  ctx: Parameters<typeof requireGitHubAccountAge>[0] &
    Pick<ActionCtx, "storage" | "scheduler" | "runAction">,
  auth: PackagePublishAuthContext,
  rawPayload: unknown,
  options: PackagePublishOptions = {},
) {
  const payload = parseArk<ServerPackagePublishRequest>(
    ServerPackagePublishRequestSchema,
    rawPayload,
    "Package publish payload",
  );
  if (payload.family === "claw" && !experimentalClawsEnabled()) {
    throw new ConvexError("Experimental Claw publication is disabled");
  }
  if (payload.family === "skill") {
    throw new ConvexError("Skill packages must use the skills publish flow");
  }
  const family = payload.family;
  const name = normalizePackageName(payload.name);
  if (payload.family === "claw" && payload.name !== name) {
    throw new ConvexError(`Claw package name must use canonical form ${name}`);
  }
  const version = assertPackageVersion(family, payload.version);
  if (family === "claw") {
    if (payload.artifact?.kind !== "npm-pack") {
      throw new ConvexError("Claw publication requires an already-built package tarball (.tgz)");
    }
    const expectedArtifactSha256 = payload.expectedArtifactSha256?.trim().toLowerCase();
    if (!expectedArtifactSha256) {
      throw new ConvexError("Claw publication requires expectedArtifactSha256");
    }
    if (!/^[a-f0-9]{64}$/.test(expectedArtifactSha256)) {
      throw new ConvexError(
        "Claw expectedArtifactSha256 must be a 64-character SHA-256 hex digest",
      );
    }
    if (!/^[a-f0-9]{64}$/.test(payload.artifact.sha256)) {
      throw new ConvexError("Claw artifact SHA-256 must be a 64-character lowercase hex digest");
    }
    if (expectedArtifactSha256 !== payload.artifact.sha256) {
      throw new ConvexError(
        `Claw artifact SHA-256 mismatch: expected ${expectedArtifactSha256}, got ${payload.artifact.sha256}`,
      );
    }
  }
  const existingPackage = await runQueryRef<Doc<"packages"> | null>(
    ctx,
    internalRefs.packages.getPackageByNameInternal,
    { name },
  );
  const existingTrustedPublisher = existingPackage
    ? await runQueryRef<PackageTrustedPublisherDoc | null>(
        ctx,
        internalRefs.packages.getTrustedPublisherByPackageIdInternal,
        { packageId: existingPackage._id },
      )
    : null;

  let actorUserId: Id<"users">;
  let ownerUserId: Id<"users">;
  let ownerPublisherId: Id<"publishers"> | undefined;
  let publishActor: PackagePublishActor;
  let effectiveSource = payload.source;
  const manualOverrideReason = normalizeManualOverrideReason(payload.manualOverrideReason);

  if (auth.kind === "github-actions") {
    if (!existingPackage) {
      throw new ConvexError("First publish must be manual by a logged-in package owner");
    }
    if (auth.publishToken.packageId !== existingPackage._id) {
      throw new ConvexError("Trusted publish token does not match the target package");
    }
    if (auth.publishToken.version !== version) {
      throw new ConvexError("Trusted publish token does not match the target version");
    }
    if (payload.ownerHandle?.trim()) {
      throw new ConvexError("Trusted publishes must not override the package owner");
    }
    if (payload.channel && payload.channel !== existingPackage.channel) {
      throw new ConvexError("Trusted publishes must not change the package channel");
    }
    actorUserId = existingPackage.ownerUserId;
    ownerUserId = existingPackage.ownerUserId;
    ownerPublisherId = existingPackage.ownerPublisherId;
    publishActor = buildGitHubActionsPublishActor(auth.publishToken);
    effectiveSource = resolveTrustedPublishSource(payload, auth.publishToken);
  } else {
    actorUserId = auth.actorUserId;
    await requireGitHubAccountAge(ctx, actorUserId);
    const actor = await runQueryRef<Doc<"users"> | null>(ctx, internalRefs.users.getByIdInternal, {
      userId: actorUserId,
    });
    const ownerMismatch = getPackageScopeOwnerMismatch(name, payload.ownerHandle);
    if (ownerMismatch) throw new ConvexError(ownerMismatch.message);
    const scopedOwnerHandle = inferOwnerHandleFromScopedPackageName(name);
    const ownerHandle = normalizePublisherHandle(payload.ownerHandle) ?? scopedOwnerHandle;
    let ownerTarget: {
      publisherId: Id<"publishers">;
      linkedUserId?: Id<"users">;
    } | null;
    try {
      ownerTarget = await runMutationRef<{
        publisherId: Id<"publishers">;
        linkedUserId?: Id<"users">;
      } | null>(ctx, internalRefs.publishers.resolvePublishTargetForUserInternal, {
        actorUserId,
        ownerHandle,
        minimumRole: "publisher",
      });
    } catch (error) {
      if (scopedOwnerHandle && error instanceof Error) {
        if (/not found/i.test(error.message)) {
          let legacyPersonalOwnerHandle: string | undefined;
          if (existingPackage && actor && existingPackage.ownerUserId === actor._id) {
            if (existingPackage.ownerPublisherId) {
              const existingOwnerPublisher = await runQueryRef<Doc<"publishers"> | null>(
                ctx,
                internalRefs.publishers.getByIdInternal,
                { publisherId: existingPackage.ownerPublisherId },
              );
              if (
                existingOwnerPublisher?.kind === "user" &&
                existingOwnerPublisher.linkedUserId === actor._id
              ) {
                legacyPersonalOwnerHandle = normalizePublisherHandle(existingOwnerPublisher.handle);
              }
            } else {
              legacyPersonalOwnerHandle = normalizePublisherHandle(actor.handle);
            }
          }
          throw new ConvexError(
            getScopedPackageMissingPublisherMessage({
              scopedOwnerHandle,
              packageName: name,
              legacyPersonalOwnerHandle,
            }),
          );
        }
        if (/forbidden|publish access/i.test(error.message)) {
          throw new ConvexError(
            getScopedPackagePublishAccessMessage({ scopedOwnerHandle, packageName: name }),
          );
        }
      }
      throw error;
    }
    ownerUserId = ownerTarget?.linkedUserId ?? actorUserId;
    ownerPublisherId = ownerTarget?.publisherId;
    if (existingTrustedPublisher && !manualOverrideReason && actor?.role !== "admin") {
      throw new ConvexError(
        "Manual publishes for packages with trusted publisher config require manualOverrideReason",
      );
    }
    publishActor = { kind: "user", userId: actorUserId };
  }

  const displayName = payload.displayName?.trim() || name;
  const { files, legacyZipEntries } = await verifyPublishFileStorageMetadata(
    ctx,
    normalizePublishFiles(payload.files),
  );
  const inventoryDigest = await buildPackageInventoryDigest(files);
  if (
    auth.kind === "github-actions" &&
    auth.publishToken.inventoryDigest !== undefined &&
    auth.publishToken.inventoryDigest !== inventoryDigest
  ) {
    throw new ConvexError("Published package inventory does not match the minted authorization");
  }
  if (payload.artifact?.kind !== "npm-pack") {
    const oversizedFile = findOversizedPublishFile(files);
    if (oversizedFile) {
      throw new ConvexError(getPublishFileSizeError(oversizedFile.path));
    }
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_PUBLISH_TOTAL_BYTES) {
    throw new ConvexError(getPublishTotalSizeError("package"));
  }
  const legacyZipBytes = buildDeterministicPackageZip(legacyZipEntries);
  const legacyZipSha256 = await sha256Hex(legacyZipBytes);

  if (family === "code-plugin" && (!effectiveSource?.repo || !effectiveSource?.commit)) {
    throw new ConvexError("Code plugins require source repo and commit metadata");
  }

  const packageJsonEntry = await readOptionalTextFile(
    ctx,
    files,
    (path) => path === "package.json",
    family === "claw"
      ? {
          exactPath: true,
          maxBytes: 256 * 1024,
          label: "Claw package.json",
          strictUtf8: true,
        }
      : undefined,
  );
  const pluginManifestEntry = await readOptionalTextFile(
    ctx,
    files,
    (path) => path === "openclaw.plugin.json",
  );
  let detectedBundleFormat: string | undefined;
  let bundleManifestEntry: Awaited<ReturnType<typeof readOptionalTextFile>> | undefined;
  for (const marker of REAL_BUNDLE_MANIFESTS) {
    const entry = await readOptionalTextFile(ctx, files, (path) => path === marker.path);
    if (entry) {
      bundleManifestEntry = entry;
      detectedBundleFormat = marker.format;
      break;
    }
  }
  const readmeEntry = await readOptionalTextFile(
    ctx,
    files,
    (path) => path === "readme.md" || path === "readme.mdx",
  );

  const packageJson = maybeParseJson(packageJsonEntry?.text);
  const declaredClawManifestPath =
    family === "claw" &&
    packageJson &&
    typeof packageJson.openclaw === "object" &&
    packageJson.openclaw !== null &&
    !Array.isArray(packageJson.openclaw) &&
    typeof (packageJson.openclaw as Record<string, unknown>).claw === "string"
      ? ((packageJson.openclaw as Record<string, unknown>).claw as string)
      : undefined;
  const clawManifestEntry = declaredClawManifestPath
    ? await readOptionalTextFile(ctx, files, (path) => path === declaredClawManifestPath, {
        exactPath: true,
        maxBytes: 1024 * 1024,
        label: "Claw manifest",
        strictUtf8: true,
      })
    : null;
  const pluginManifest = maybeParseJson(pluginManifestEntry?.text);
  const bundleManifest = maybeParseJson(bundleManifestEntry?.text);
  const storedPackageJson = toConvexSafeJsonValue(packageJson, {
    maxDepth: MAX_STORED_PACKAGE_METADATA_DEPTH,
  });
  const storedPluginManifest = toConvexSafeJsonValue(pluginManifest, {
    maxDepth: MAX_STORED_PACKAGE_METADATA_DEPTH,
  });
  const storedBundleManifest = toConvexSafeJsonValue(bundleManifest, {
    maxDepth: MAX_STORED_PACKAGE_METADATA_DEPTH,
  });
  if (family !== "claw" && packageJson) ensurePluginNameMatchesPackage(name, packageJson);
  if (family !== "claw" && !pluginManifest) {
    throw new ConvexError("openclaw.plugin.json is required for plugin packages");
  }
  const clawTextByPath = new Map<string, string>();
  if (clawManifestEntry) {
    clawTextByPath.set(clawManifestEntry.file.path, clawManifestEntry.text);
  }
  if (family === "claw") {
    const bootstrapEntry = await readOptionalTextFile(
      ctx,
      files,
      (path) => path === "BOOTSTRAP.md",
      {
        exactPath: true,
        maxBytes: 2 * 1024 * 1024,
        label: "Claw BOOTSTRAP.md",
        strictUtf8: true,
      },
    );
    if (bootstrapEntry) {
      clawTextByPath.set(bootstrapEntry.file.path, bootstrapEntry.text);
    }
    for (const profileFile of files.filter((file) => /^profiles\/.*\.ya?ml$/i.test(file.path))) {
      const profileText = await readStorageText(ctx, profileFile.storageId, {
        maxBytes: 256 * 1024,
        label:
          profileFile.path === "profiles/openclaw.yml" ? "OpenClaw profile" : "Harness profile",
        strictUtf8: true,
      });
      clawTextByPath.set(profileFile.path, profileText);
    }
  }
  const clawValidationFiles = files.map((file) => ({
    path: file.path,
    ...(clawTextByPath.has(file.path) ? { text: clawTextByPath.get(file.path) } : {}),
  }));
  const clawPackage =
    family === "claw"
      ? validateClawPackageContents({
          packageName: name,
          version,
          packageJson,
          openClawProfilePolicy:
            existingPackage &&
            !hasNoPublishedPackageVersions(existingPackage) &&
            existingPackage.clawProfilePolicyVersion !== CURRENT_OPENCLAW_PROFILE_POLICY_VERSION
              ? "publication-compatible"
              : "current",
          files: clawValidationFiles,
        })
      : null;
  if (clawPackage && !clawPackage.ok) {
    throw new ConvexError(
      `Invalid Claw package: ${clawPackage.issues
        .map((entry) => `${entry.path}: ${entry.message}`)
        .join(" ")}`,
    );
  }
  const validatedClaw = clawPackage?.ok ? clawPackage.value : undefined;
  const icon = family === "claw" ? undefined : normalizePluginManifestIcon(pluginManifest);
  if (family === "code-plugin") {
    const validation = validateOpenClawExternalCodePluginPackageContents(
      packageJson,
      files.map((file) => file.path),
    );
    if (validation.issues.length > 0) {
      throw new ConvexError(validation.issues.map((issue) => issue.message).join(" "));
    }
  }
  if (payload.artifact?.kind === "npm-pack") {
    if (!packageJson) throw new ConvexError("ClawPack must contain package.json");
    const declaredVersion =
      typeof packageJson.version === "string" ? packageJson.version.trim() : "";
    if (declaredVersion !== version) {
      throw new ConvexError(`ClawPack package.json version must match ${version}`);
    }
  }

  const bundleArtifacts =
    family === "bundle-plugin"
      ? extractBundlePluginArtifacts({
          packageName: name,
          packageJson,
          pluginManifest:
            pluginManifest ??
            (() => {
              throw new ConvexError("openclaw.plugin.json is required for plugin packages");
            })(),
          bundleManifest,
          bundleMetadata:
            payload.bundle || detectedBundleFormat
              ? {
                  ...payload.bundle,
                  format: payload.bundle?.format ?? detectedBundleFormat,
                }
              : undefined,
          source: effectiveSource,
        })
      : null;

  const codeArtifacts =
    family === "code-plugin"
      ? extractCodePluginArtifacts({
          packageName: name,
          packageJson:
            packageJson ??
            (() => {
              throw new ConvexError("package.json is required for code plugins");
            })(),
          pluginManifest:
            pluginManifest ??
            (() => {
              throw new ConvexError("openclaw.plugin.json is required for plugin packages");
            })(),
          source: effectiveSource,
        })
      : null;

  const summary =
    validatedClaw?.summary.agent.description ||
    validatedClaw?.summary.agent.name ||
    summarizePackageForSearch({
      packageName: name,
      packageJson,
      readmeText: readmeEntry?.text ?? null,
    });
  let categories: string[];
  let normalizedTopics: string[];
  try {
    const declaredCategories =
      payload.categories ?? normalizeStoredPluginCategoryOverride(existingPackage?.categories);
    categories =
      family === "claw"
        ? (declaredCategories ?? [])
        : resolvePluginCategories({ declared: declaredCategories });
    normalizedTopics = normalizeCatalogTopics(payload.topics ?? existingPackage?.topics);
  } catch (error) {
    throw new ConvexError(error instanceof Error ? error.message : "Invalid catalog metadata");
  }
  const topics = normalizedTopics.length ? normalizedTopics : undefined;
  const staticScan = await runStaticPublishScanInNode(ctx, {
    slug: name,
    displayName,
    summary,
    metadata: {
      packageJson,
      pluginManifest,
      bundleManifest,
      clawManifest: validatedClaw?.manifest,
      source: effectiveSource,
    },
    files,
  });
  const inspectorResult =
    family === "code-plugin" || family === "bundle-plugin"
      ? await runPackageInspectorPublishGate(ctx, {
          packageName: name,
          version,
          files,
        })
      : null;
  const ownerPublisher = ownerPublisherId
    ? await runQueryRef<Doc<"publishers"> | null>(ctx, internalRefs.publishers.getByIdInternal, {
        publisherId: ownerPublisherId,
      })
    : null;
  const trustedOpenClawPlugin = isTrustedOpenClawPluginPackage({
    family,
    normalizedName: name,
    ownerPublisher,
  });
  const verificationSource = codeArtifacts?.verification ?? bundleArtifacts?.verification;
  const initialScanStatus = trustedOpenClawPlugin ? "clean" : "pending";
  const verification = verificationSource
    ? {
        ...verificationSource,
        trustedOpenClawPlugin: trustedOpenClawPlugin || undefined,
        scanStatus: initialScanStatus,
      }
    : undefined;
  const integritySha256 = await hashSkillFiles(
    files.map((file) => ({ path: file.path, sha256: file.sha256 })),
  );
  const pluginManifestSummary =
    family === "claw"
      ? undefined
      : derivePluginManifestSummary({
          pluginManifest:
            pluginManifest ??
            (() => {
              throw new ConvexError("openclaw.plugin.json is required for plugin packages");
            })(),
          ...(bundleManifest ? { skillManifest: bundleManifest } : {}),
          compatibility: codeArtifacts?.compatibility ?? bundleArtifacts?.compatibility,
          files: await withSkillMarkdownTextsForManifestSummary(ctx, files),
        });

  const legacyZipStorageId =
    payload.artifact?.kind === "npm-pack"
      ? undefined
      : await ctx.storage.store(
          new Blob(
            [
              legacyZipBytes.buffer.slice(
                legacyZipBytes.byteOffset,
                legacyZipBytes.byteOffset + legacyZipBytes.byteLength,
              ) as ArrayBuffer,
            ],
            { type: "application/zip" },
          ),
        );

  const packageInsertArgs = {
    actorUserId,
    ownerUserId,
    ownerPublisherId,
    publishActor,
    name,
    displayName,
    family,
    version,
    changelog: payload.changelog.trim(),
    tags: payload.tags?.map((tag: string) => tag.trim()).filter(Boolean) ?? ["latest"],
    summary,
    ...(icon ? { icon } : {}),
    categories,
    topics,
    sourceRepo: effectiveSource?.repo || effectiveSource?.url,
    runtimeId: codeArtifacts?.runtimeId ?? bundleArtifacts?.runtimeId,
    channel: payload.channel,
    compatibility: codeArtifacts?.compatibility ?? bundleArtifacts?.compatibility,
    verification,
    staticScan,
    files,
    integritySha256,
    sha256hash: legacyZipSha256,
    artifactKind: payload.artifact?.kind ?? "legacy-zip",
    clawpackStorageId:
      (payload.artifact?.storageId as Id<"_storage"> | undefined) ?? legacyZipStorageId,
    clawpackSha256: payload.artifact?.sha256 ?? legacyZipSha256,
    clawpackSize: payload.artifact?.size ?? legacyZipBytes.byteLength,
    clawpackFormat: payload.artifact?.format,
    npmIntegrity: payload.artifact?.npmIntegrity,
    npmShasum: payload.artifact?.npmShasum,
    npmTarballName: payload.artifact?.npmTarballName,
    npmUnpackedSize: payload.artifact?.npmUnpackedSize,
    npmFileCount: payload.artifact?.npmFileCount,
    allowExistingRelease:
      auth.kind === "github-actions" ||
      (auth.kind === "user" && manualOverrideReason?.startsWith("GitHub Actions ")),
    extractedPackageJson: storedPackageJson,
    extractedPluginManifest: storedPluginManifest,
    normalizedBundleManifest: family === "bundle-plugin" ? storedBundleManifest : undefined,
    pluginManifestSummary,
    clawManifestSummary: validatedClaw?.summary,
    source: effectiveSource,
    trustedPublishTokenId: auth.kind === "github-actions" ? auth.publishToken._id : undefined,
    trustedPublishInventoryDigest: auth.kind === "github-actions" ? inventoryDigest : undefined,
  };
  const publishedArtifactSha256 = family === "claw" ? packageInsertArgs.clawpackSha256 : undefined;
  const attemptArtifactFingerprint = publishedArtifactSha256 ?? integritySha256;

  const inspectorFindings =
    inspectorResult?.warnings.map((finding) =>
      toPackageInspectorPublishResponseFinding(finding, inspectorResult.metadata),
    ) ?? [];

  if (options.stagePrePublicationChecks) {
    let existingRelease: Doc<"packageReleases"> | null = null;
    if (existingPackage) {
      existingRelease = await runQueryRef<Doc<"packageReleases"> | null>(
        ctx,
        internalRefs.packages.getReleaseByPackageAndVersionInternal,
        { packageId: existingPackage._id, version },
      );
    }
    const existingAttempt = await runQueryRef<null | {
      attemptId: Id<"publishAttempts">;
      status: string;
      reusable: boolean;
      packageId?: Id<"packages">;
      releaseId?: Id<"packageReleases">;
      result?: {
        ok: true;
        packageId: Id<"packages">;
        releaseId: Id<"packageReleases">;
      };
    }>(ctx, internalRefs.publishAttempts.findExistingPublishAttemptForArtifactInternal, {
      kind: "package",
      slug: name,
      version,
      ...(family === "claw"
        ? {
            userId: actorUserId,
            ownerUserId,
            ownerPublisherId,
            artifactFingerprint: attemptArtifactFingerprint,
          }
        : {}),
    });
    if (existingAttempt) {
      const reusableClawAttempt =
        family === "claw" &&
        existingAttempt.reusable &&
        existingPackage !== null &&
        !existingPackage.softDeletedAt &&
        existingAttempt.packageId !== undefined &&
        existingAttempt.packageId === existingPackage._id &&
        existingAttempt.releaseId !== undefined &&
        existingRelease !== null &&
        existingAttempt.releaseId === existingRelease._id &&
        !existingRelease.softDeletedAt &&
        existingRelease.ownerDeletedAt === undefined &&
        existingRelease.manualModeration?.state !== "quarantined" &&
        existingRelease.manualModeration?.state !== "revoked" &&
        resolvePackageReleaseScanStatus(existingRelease) !== "malicious" &&
        (existingAttempt.status === "finalized"
          ? isPublishedPackageRelease(existingRelease)
          : existingRelease.publicationStatus === "pending");
      if (reusableClawAttempt) {
        if (existingAttempt.status === "finalized") {
          if (!existingAttempt.result) {
            throw new ConvexError("Finalized publish attempt is missing its package result.");
          }
          if (auth.kind === "github-actions" && auth.publishToken.authorizationVersion !== 2) {
            await runMutationRef(ctx, internalRefs.packagePublishTokens.revokeInternal, {
              tokenId: auth.publishToken._id,
            });
          }
          const finalizedResult = {
            ...existingAttempt.result,
            publicationStatus: "published" as const,
            artifactSha256: publishedArtifactSha256,
          };
          return inspectorFindings.length > 0
            ? { ...finalizedResult, inspectorFindings }
            : finalizedResult;
        }
        if (auth.kind === "github-actions" && auth.publishToken.authorizationVersion !== 2) {
          await runMutationRef(ctx, internalRefs.packagePublishTokens.revokeInternal, {
            tokenId: auth.publishToken._id,
          });
        }
        return {
          ok: true as const,
          status: "pending" as const,
          packageId: existingAttempt.packageId,
          releaseId: existingAttempt.releaseId,
          artifactSha256: publishedArtifactSha256,
          publicationStatus: "pending" as const,
          attemptId: existingAttempt.attemptId,
          packageName: name,
          version,
          ...(inspectorFindings.length > 0 ? { inspectorFindings } : {}),
        };
      }
      throw new ConvexError(
        `Version ${version} already exists. Increment the version number and try again.`,
      );
    }
    if (family === "claw") {
      const conflictingAttempt = await runQueryRef<null | { attemptId: Id<"publishAttempts"> }>(
        ctx,
        internalRefs.publishAttempts.findExistingPublishAttemptForArtifactInternal,
        {
          kind: "package",
          slug: name,
          version,
        },
      );
      if (conflictingAttempt) {
        throw new ConvexError(
          `Version ${version} already exists. Increment the version number and try again.`,
        );
      }
    }
    if (existingPackage && existingRelease) {
      if (!existingRelease.softDeletedAt && existingRelease.publicationStatus === "pending") {
        await runMutationRef(ctx, internalRefs.packages.discardPendingPackagePublicationInternal, {
          packageId: existingPackage._id,
          releaseId: existingRelease._id,
          createdNewParent: hasNoPublishedPackageVersions(existingPackage),
        });
        throw new ConvexError(
          `Previous pending publish for ${version} did not finish creating security checks. It was cleaned up; retry the publish.`,
        );
      }
      throw new ConvexError(
        `Version ${version} already exists. Increment the version number and try again.`,
      );
    }

    await reverifyOpenClawAuthorizationBeforePublish(auth, {
      name,
      version,
      inventoryDigest,
    });
    const pendingResult = await runMutationRef<{
      ok: true;
      packageId: Id<"packages">;
      releaseId: Id<"packageReleases">;
      publicationStatus?: "pending" | "published";
      createdNewParent?: boolean;
    }>(ctx, internalRefs.packages.insertReleaseInternal, {
      ...packageInsertArgs,
      publicationStatus: "pending",
    });

    const staged = await runMutationRef<{
      attemptId: Id<"publishAttempts">;
      status: string;
      result?: { ok: true; packageId: Id<"packages">; releaseId: Id<"packageReleases"> };
    }>(ctx, internalRefs.publishAttempts.createPackagePublishAttemptInternal, {
      userId: actorUserId,
      ownerUserId,
      ownerPublisherId,
      packageId: pendingResult.packageId,
      packageReleaseId: pendingResult.releaseId,
      createdNewParent: pendingResult.createdNewParent,
      name,
      displayName,
      version,
      idempotencyKey: buildPackagePublishAttemptIdempotencyKey({
        actorUserId,
        ownerPublisherId,
        ownerUserId,
        name,
        version,
        artifactFingerprint: attemptArtifactFingerprint,
      }),
      artifactFingerprint: attemptArtifactFingerprint,
      files,
      clawpackStorageId: packageInsertArgs.clawpackStorageId,
      scanContext: buildPackagePublishAttemptScanContext(packageInsertArgs),
      packageFollowup: stripUndefinedForStoredAttempt({
        ownerUserId,
        ownerPublisherId,
        packageName: name,
        version,
        inspectorWarnings: inspectorResult?.warnings ?? [],
        inspectorMetadata: inspectorResult?.metadata,
        trustedPublishTokenId: auth.kind === "github-actions" ? auth.publishToken._id : undefined,
        trustedPublishInventoryDigest: auth.kind === "github-actions" ? inventoryDigest : undefined,
        trustedPublishAuthorizationVersion:
          auth.kind === "github-actions" ? auth.publishToken.authorizationVersion : undefined,
        manualOverrideAudit:
          auth.kind === "user" && existingTrustedPublisher && manualOverrideReason
            ? {
                actorUserId,
                version,
                reason: manualOverrideReason,
                trustedPublisher: {
                  provider: existingTrustedPublisher.provider,
                  repository: existingTrustedPublisher.repository,
                  workflowFilename: existingTrustedPublisher.workflowFilename,
                  environment: existingTrustedPublisher.environment,
                },
              }
            : undefined,
        githubActionsAudit:
          auth.kind === "github-actions"
            ? {
                actorUserId,
                version,
                repository: auth.publishToken.repository,
                workflowFilename: auth.publishToken.workflowFilename,
                environment: auth.publishToken.environment,
                runId: auth.publishToken.runId,
                runAttempt: auth.publishToken.runAttempt,
                sha: auth.publishToken.sha,
              }
            : undefined,
      }),
    }).catch(async (error) => {
      await runMutationRef(ctx, internalRefs.packages.discardPendingPackagePublicationInternal, {
        packageId: pendingResult.packageId,
        releaseId: pendingResult.releaseId,
        createdNewParent: pendingResult.createdNewParent,
      });
      throw error;
    });
    if (auth.kind === "github-actions" && auth.publishToken.authorizationVersion !== 2) {
      await runMutationRef(ctx, internalRefs.packagePublishTokens.revokeInternal, {
        tokenId: auth.publishToken._id,
      });
    }
    if (staged.status === "finalized" && staged.result) {
      const finalizedResult = {
        ...staged.result,
        publicationStatus: "published" as const,
        ...(publishedArtifactSha256 ? { artifactSha256: publishedArtifactSha256 } : {}),
      };
      return inspectorFindings.length > 0
        ? { ...finalizedResult, inspectorFindings }
        : finalizedResult;
    }

    return {
      ok: true as const,
      status: "pending" as const,
      packageId: pendingResult.packageId,
      releaseId: pendingResult.releaseId,
      ...(publishedArtifactSha256 ? { artifactSha256: publishedArtifactSha256 } : {}),
      publicationStatus: "pending" as const,
      attemptId: staged.attemptId,
      packageName: name,
      version,
      ...(inspectorFindings.length > 0 ? { inspectorFindings } : {}),
    };
  }

  await reverifyOpenClawAuthorizationBeforePublish(auth, {
    name,
    version,
    inventoryDigest,
  });
  const publishResult = await runMutationRef<{
    ok: true;
    packageId: Id<"packages">;
    releaseId: Id<"packageReleases">;
  }>(ctx, internalRefs.packages.insertReleaseInternal, packageInsertArgs);
  if (inspectorResult?.warnings.length) {
    const insertFindingsResult = await runMutationRef<{
      ok: true;
      inserted: number;
      shouldEmailOwner: boolean;
    }>(ctx, internalRefs.packages.insertPackageInspectorWarningsInternal, {
      packageId: publishResult.packageId,
      releaseId: publishResult.releaseId,
      ownerUserId,
      ownerPublisherId,
      packageName: name,
      version,
      scanSource: "publish",
      inspectorVersion: inspectorResult.metadata?.inspectorVersion,
      targetOpenClawVersion: inspectorResult.metadata?.targetOpenClawVersion,
      findings: inspectorResult.warnings,
    });
    if (insertFindingsResult.shouldEmailOwner) {
      try {
        await runActionRef(ctx, internalRefs.packages.sendPackageInspectorFindingsEmailInternal, {
          packageId: publishResult.packageId,
          releaseId: publishResult.releaseId,
        });
      } catch (error) {
        console.error("Package Inspector findings email failed", error);
      }
    }
  }

  if (auth.kind === "github-actions" && auth.publishToken.authorizationVersion !== 2) {
    await runMutationRef(ctx, internalRefs.packagePublishTokens.revokeInternal, {
      tokenId: auth.publishToken._id,
    });
  }
  if (auth.kind === "user" && existingTrustedPublisher && manualOverrideReason) {
    await runMutationRef(ctx, internalRefs.packages.insertAuditLogInternal, {
      actorUserId,
      action: "package.publish.manual_override",
      targetType: "package",
      targetId: String(publishResult.packageId),
      metadata: {
        version,
        reason: manualOverrideReason,
        trustedPublisher: {
          provider: existingTrustedPublisher.provider,
          repository: existingTrustedPublisher.repository,
          workflowFilename: existingTrustedPublisher.workflowFilename,
          environment: existingTrustedPublisher.environment,
        },
      },
    });
  }
  if (auth.kind === "github-actions") {
    await runMutationRef(ctx, internalRefs.packages.insertAuditLogInternal, {
      actorUserId,
      action: "package.publish.github_actions",
      targetType: "package",
      targetId: String(publishResult.packageId),
      metadata: {
        version,
        repository: auth.publishToken.repository,
        workflowFilename: auth.publishToken.workflowFilename,
        environment: auth.publishToken.environment,
        runId: auth.publishToken.runId,
        runAttempt: auth.publishToken.runAttempt,
        sha: auth.publishToken.sha,
      },
    });
  }

  await runAfterRef(
    ctx,
    INITIAL_PACKAGE_VT_SCAN_DELAY_MS,
    internalRefs.vt.scanPackageReleaseWithVirusTotal,
    {
      releaseId: publishResult.releaseId,
    },
  );
  await runMutationRef(ctx, internalRefs.securityScan.enqueuePackageReleaseScanInternal, {
    releaseId: publishResult.releaseId,
    source: "publish",
  });

  const publishedResult = {
    ...publishResult,
    publicationStatus: "published" as const,
    ...(publishedArtifactSha256 ? { artifactSha256: publishedArtifactSha256 } : {}),
  };
  return inspectorFindings.length > 0 ? { ...publishedResult, inspectorFindings } : publishedResult;
}

function toPackageInspectorPublishResponseFinding(
  finding: PackageInspectorFinding,
  metadata: PackageInspectorPublishResult["metadata"],
) {
  const findingKind =
    finding.level === "breakage" || finding.level === "error" || finding.severity === "P0"
      ? ("error" as const)
      : ("warning" as const);
  return {
    findingKind,
    code: finding.code,
    severity: finding.severity,
    level: finding.level,
    issueClass: finding.issueClass,
    message: finding.message,
    authorRemediation: finding.authorRemediation,
    inspectorVersion: metadata?.inspectorVersion,
    targetOpenClawVersion: metadata?.targetOpenClawVersion,
  };
}

export const publishPackageForUserInternal = internalAction({
  args: {
    actorUserId: v.id("users"),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    return await publishPackageImpl(
      ctx,
      { kind: "user", actorUserId: args.actorUserId },
      args.payload,
      { stagePrePublicationChecks: stagedPrePublicationPublishesEnabled() },
    );
  },
});

export const publishRelease: ReturnType<typeof action> = action({
  args: {
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    if (
      args.payload &&
      typeof args.payload === "object" &&
      !Array.isArray(args.payload) &&
      (args.payload as Record<string, unknown>).family === "claw"
    ) {
      throw new ConvexError("Claw packages must use the exact-artifact HTTP publish flow");
    }
    const { userId } = await requireUserFromAction(ctx);
    const stagePrePublicationChecks = stagedPrePublicationPublishesEnabled();
    return await publishPackageImpl(ctx, { kind: "user", actorUserId: userId }, args.payload, {
      stagePrePublicationChecks,
    });
  },
});

function stagedPrePublicationPublishesEnabled() {
  return process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES === "1";
}

export const finalizePackagePublishAttemptInternal = internalAction({
  args: {
    attemptId: v.id("publishAttempts"),
  },
  handler: async (ctx, args) => {
    const claimId = buildPackageFinalizationClaimId();
    const claim = await runMutationRef<
      | {
          status: "claimed";
          attemptId: Id<"publishAttempts">;
          packageId?: Id<"packages">;
          releaseId?: Id<"packageReleases">;
          packageInsertArgs?: unknown;
          packageFollowup: unknown;
        }
      | {
          status: "finalized";
          attemptId: Id<"publishAttempts">;
          result: { ok: true; packageId: Id<"packages">; releaseId: Id<"packageReleases"> };
          packageFollowup: unknown;
        }
    >(ctx, internalRefs.publishAttempts.claimPackagePublishAttemptForFinalizationInternal, {
      attemptId: args.attemptId,
      claimId,
    });
    if (claim.status === "finalized") return claim.result;

    let publishResult: { ok: true; packageId: Id<"packages">; releaseId: Id<"packageReleases"> };
    try {
      const trustedPublishAuthorization =
        claim.releaseId !== undefined
          ? await reverifyStagedOpenClawAuthorizationBeforeFinalize(ctx, claim, claimId)
          : undefined;
      publishResult =
        claim.releaseId !== undefined
          ? await runMutationRef(ctx, internalRefs.packages.publishPendingReleaseInternal, {
              releaseId: claim.releaseId,
              ...trustedPublishAuthorization,
            })
          : await runMutationRef(
              ctx,
              internalRefs.packages.insertReleaseInternal,
              claim.packageInsertArgs,
            );
    } catch (error) {
      if (claim.releaseId !== undefined) {
        await releasePackagePublishAttemptFinalizationClaim(ctx, claim.attemptId, claimId, error);
        throw error;
      }
      const insertArgs = claim.packageInsertArgs as {
        name?: string;
        version?: string;
        integritySha256?: string;
        clawpackSha256?: string;
        ownerUserId?: Id<"users">;
        ownerPublisherId?: Id<"publishers">;
      };
      const existingResult =
        insertArgs.name &&
        insertArgs.version &&
        insertArgs.integritySha256 &&
        insertArgs.ownerUserId
          ? await runQueryRef<{
              ok: true;
              packageId: Id<"packages">;
              releaseId: Id<"packageReleases">;
            } | null>(ctx, internalRefs.packages.findPackagePublishResultInternal, {
              name: insertArgs.name,
              version: insertArgs.version,
              integritySha256: insertArgs.integritySha256,
              clawpackSha256: insertArgs.clawpackSha256,
              ownerUserId: insertArgs.ownerUserId,
              ownerPublisherId: insertArgs.ownerPublisherId,
            })
          : null;
      if (!existingResult) {
        await releasePackagePublishAttemptFinalizationClaim(ctx, claim.attemptId, claimId, error);
        throw error;
      }
      publishResult = existingResult;
    }

    try {
      await runPackagePublishPostFinalizeFollowups(ctx, publishResult, claim.packageFollowup);
      await runMutationRef(
        ctx,
        internalRefs.publishAttempts.recordPackagePublishAttemptFinalizedInternal,
        {
          attemptId: claim.attemptId,
          claimId,
          result: publishResult,
        },
      );
    } catch (error) {
      await releasePackagePublishAttemptFinalizationClaim(ctx, claim.attemptId, claimId, error);
      throw error;
    }

    return publishResult;
  },
});

export const generateChangelogPreview: ReturnType<typeof action> = action({
  args: {
    name: v.string(),
    family: v.union(v.literal("code-plugin"), v.literal("bundle-plugin")),
    version: v.string(),
    readmeText: v.string(),
    filePaths: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireUserFromAction(ctx);
    const name = normalizePackageName(args.name);
    const version = assertPackageVersion(args.family, args.version);
    const authorizedPreview = await runQueryRef<{
      ok: true;
      latestReleaseId?: Id<"packageReleases"> | null;
    }>(ctx, internalRefs.packages.assertCanGenerateChangelogPreviewInternal, {
      actorUserId: userId,
      name,
    });
    const changelog = await generatePackageChangelogPreview(ctx, {
      name,
      version,
      readmeText: args.readmeText,
      filePaths: args.filePaths,
      latestReleaseId: authorizedPreview.latestReleaseId ?? null,
    });
    return { changelog };
  },
});

export const publishPackageForTrustedPublisherInternal = internalAction({
  args: {
    publishTokenId: v.id("packagePublishTokens"),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    const publishToken = await runQueryRef<Doc<"packagePublishTokens"> | null>(
      ctx,
      internalRefs.packagePublishTokens.getByIdInternal,
      { tokenId: args.publishTokenId },
    );
    if (
      !publishToken ||
      publishToken.revokedAt ||
      publishToken.consumedAt ||
      publishToken.expiresAt <= Date.now()
    ) {
      throw new ConvexError("Trusted publish token is missing or expired");
    }
    if ((publishToken.scope ?? "publish") !== "publish") {
      throw new ConvexError("Trusted upload token cannot authorize package publication");
    }
    assertOpenClawPublishAuthorizationVersion(publishToken);
    const trustedPublisher = await runQueryRef<PackageTrustedPublisherDoc | null>(
      ctx,
      internalRefs.packages.getTrustedPublisherByPackageIdInternal,
      { packageId: publishToken.packageId },
    );
    if (!doesTrustedPublisherMatchPublishToken(trustedPublisher, publishToken)) {
      throw new ConvexError(
        "Trusted publish token no longer matches the current package trusted publisher",
      );
    }
    return await publishPackageImpl(ctx, { kind: "github-actions", publishToken }, args.payload, {
      stagePrePublicationChecks:
        publishToken.authorizationVersion === 2 || stagedPrePublicationPublishesEnabled(),
    });
  },
});

function buildPackagePublishAttemptIdempotencyKey(args: {
  actorUserId: Id<"users">;
  ownerUserId: Id<"users">;
  ownerPublisherId?: Id<"publishers">;
  name: string;
  version: string;
  artifactFingerprint: string;
}) {
  return [
    "package",
    args.actorUserId,
    args.ownerPublisherId ?? args.ownerUserId,
    args.name,
    args.version,
    args.artifactFingerprint,
  ].join(":");
}

function stripUndefinedForStoredAttempt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefinedForStoredAttempt);
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (nested !== undefined) result[key] = stripUndefinedForStoredAttempt(nested);
  }
  return result;
}

function buildPackagePublishAttemptScanContext(insertArgs: Record<string, unknown>) {
  const verification =
    insertArgs.verification &&
    typeof insertArgs.verification === "object" &&
    !Array.isArray(insertArgs.verification)
      ? (insertArgs.verification as Record<string, unknown>)
      : {};
  return stripUndefinedForStoredAttempt({
    trustedOpenClawPlugin: verification.trustedOpenClawPlugin === true ? true : undefined,
    release: {
      staticScan: insertArgs.staticScan,
      pluginManifestSummary: insertArgs.pluginManifestSummary,
      verification: insertArgs.verification,
      artifactKind: insertArgs.artifactKind,
      npmIntegrity: insertArgs.npmIntegrity,
      npmShasum: insertArgs.npmShasum,
      npmTarballName: insertArgs.npmTarballName,
      source: insertArgs.source,
    },
  });
}

function buildPackageFinalizationClaimId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

async function releasePackagePublishAttemptFinalizationClaim(
  ctx: ActionCtx,
  attemptId: Id<"publishAttempts">,
  claimId: string,
  error: unknown,
) {
  await runMutationRef(
    ctx,
    internalRefs.publishAttempts.releasePackagePublishAttemptFinalizationClaimInternal,
    {
      attemptId,
      claimId,
      error: error instanceof Error ? error.message : String(error),
    },
  );
}

async function runPackagePublishPostFinalizeFollowups(
  ctx: ActionCtx,
  publishResult: { packageId: Id<"packages">; releaseId: Id<"packageReleases"> },
  rawFollowup: unknown,
) {
  const followup = rawFollowup as {
    ownerUserId?: Id<"users">;
    ownerPublisherId?: Id<"publishers">;
    packageName?: string;
    version?: string;
    inspectorWarnings?: PackageInspectorFinding[];
    inspectorMetadata?: PackageInspectorPublishResult["metadata"];
    trustedPublishTokenId?: Id<"packagePublishTokens">;
    trustedPublishInventoryDigest?: string;
    trustedPublishAuthorizationVersion?: number;
    manualOverrideAudit?: {
      actorUserId: Id<"users">;
      version: string;
      reason: string;
      trustedPublisher: {
        provider: string;
        repository: string;
        workflowFilename: string;
        environment?: string;
      };
    };
    githubActionsAudit?: {
      actorUserId: Id<"users">;
      version: string;
      repository: string;
      workflowFilename: string;
      environment?: string;
      runId?: string;
      runAttempt?: string;
      sha?: string;
    };
  };

  if (
    followup.ownerUserId &&
    followup.packageName &&
    followup.version &&
    followup.inspectorWarnings?.length
  ) {
    const insertFindingsResult = await runMutationRef<{
      ok: true;
      inserted: number;
      shouldEmailOwner: boolean;
    }>(ctx, internalRefs.packages.insertPackageInspectorWarningsInternal, {
      packageId: publishResult.packageId,
      releaseId: publishResult.releaseId,
      ownerUserId: followup.ownerUserId,
      ownerPublisherId: followup.ownerPublisherId,
      packageName: followup.packageName,
      version: followup.version,
      scanSource: "publish",
      inspectorVersion: followup.inspectorMetadata?.inspectorVersion,
      targetOpenClawVersion: followup.inspectorMetadata?.targetOpenClawVersion,
      findings: followup.inspectorWarnings,
    });
    if (insertFindingsResult.shouldEmailOwner) {
      try {
        await runActionRef(ctx, internalRefs.packages.sendPackageInspectorFindingsEmailInternal, {
          packageId: publishResult.packageId,
          releaseId: publishResult.releaseId,
        });
      } catch (error) {
        console.error("Package Inspector findings email failed", error);
      }
    }
  }

  if (followup.trustedPublishTokenId) {
    await runMutationRef(ctx, internalRefs.packagePublishTokens.revokeInternal, {
      tokenId: followup.trustedPublishTokenId,
    });
  }

  if (followup.manualOverrideAudit) {
    await runMutationRef(ctx, internalRefs.packages.insertAuditLogInternal, {
      actorUserId: followup.manualOverrideAudit.actorUserId,
      action: "package.publish.manual_override",
      targetType: "package",
      targetId: String(publishResult.packageId),
      metadata: {
        version: followup.manualOverrideAudit.version,
        reason: followup.manualOverrideAudit.reason,
        trustedPublisher: followup.manualOverrideAudit.trustedPublisher,
      },
    });
  }

  if (followup.githubActionsAudit) {
    await runMutationRef(ctx, internalRefs.packages.insertAuditLogInternal, {
      actorUserId: followup.githubActionsAudit.actorUserId,
      action: "package.publish.github_actions",
      targetType: "package",
      targetId: String(publishResult.packageId),
      metadata: {
        version: followup.githubActionsAudit.version,
        repository: followup.githubActionsAudit.repository,
        workflowFilename: followup.githubActionsAudit.workflowFilename,
        environment: followup.githubActionsAudit.environment,
        runId: followup.githubActionsAudit.runId,
        runAttempt: followup.githubActionsAudit.runAttempt,
        sha: followup.githubActionsAudit.sha,
      },
    });
  }

  await runAfterRef(
    ctx,
    INITIAL_PACKAGE_VT_SCAN_DELAY_MS,
    internalRefs.vt.scanPackageReleaseWithVirusTotal,
    {
      releaseId: publishResult.releaseId,
    },
  );
  await runMutationRef(ctx, internalRefs.securityScan.enqueuePackageReleaseScanInternal, {
    releaseId: publishResult.releaseId,
    source: "publish",
  });
}

export const reservePackageNameInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    ownerUserId: v.id("users"),
    ownerPublisherId: v.optional(v.id("publishers")),
    name: v.string(),
    displayName: v.optional(v.string()),
    summary: v.optional(v.string()),
    family: v.optional(
      v.union(v.literal("skill"), v.literal("code-plugin"), v.literal("bundle-plugin")),
    ),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
    assertAdmin(actor);

    const owner = await ctx.db.get(args.ownerUserId);
    if (!owner || owner.deletedAt || owner.deactivatedAt) {
      throw new ConvexError("Owner user not found");
    }

    const ownerPublisher = args.ownerPublisherId ? await ctx.db.get(args.ownerPublisherId) : null;
    if (args.ownerPublisherId && (!ownerPublisher || ownerPublisher.deletedAt)) {
      throw new ConvexError("Owner publisher not found");
    }

    const normalizedName = normalizePackageName(args.name);
    const family = args.family ?? "code-plugin";
    const existing = await getPackageByNormalizedName(ctx, normalizedName);
    if (existing) {
      const existingOwnerKey = getPackageOwnerKey(existing, {
        nextOwnerPublisherId: args.ownerPublisherId,
        ownerPublisher,
      });
      const nextOwnerKey = getRequestedPackageOwnerKey({
        ownerUserId: args.ownerUserId,
        ownerPublisherId: args.ownerPublisherId,
      });
      if (existingOwnerKey !== nextOwnerKey) {
        throw new ConvexError("Package already exists and belongs to another publisher");
      }

      await ctx.db.insert("auditLogs", {
        actorUserId: args.actorUserId,
        action: "package.reserve",
        targetType: "package",
        targetId: existing._id,
        metadata: {
          name: normalizedName,
          ownerUserId: args.ownerUserId,
          ownerPublisherId: args.ownerPublisherId,
          action: "already_owned",
          reason: args.reason || undefined,
        },
        createdAt: now,
      });

      return {
        ok: true as const,
        action: "already_owned" as const,
        packageId: existing._id,
        name: normalizedName,
      };
    }

    const packageId = await ctx.db.insert("packages", {
      name: normalizedName,
      normalizedName,
      displayName: args.displayName?.trim() || normalizedName,
      summary: args.summary?.trim() || "Reserved for an official OpenClaw plugin.",
      ownerUserId: args.ownerUserId,
      ownerPublisherId: args.ownerPublisherId,
      family,
      channel: "private",
      isOfficial: false,
      tags: {},
      stats: { downloads: 0, installs: 0, stars: 0, versions: 0 },
      ...computePackageRecommendationPatch(
        {
          downloads: 0,
          installs: 0,
          stars: 0,
          versions: 0,
        },
        {
          createdAt: now,
          updatedAt: now,
          now,
        },
      ),
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      actorUserId: args.actorUserId,
      action: "package.reserve",
      targetType: "package",
      targetId: packageId,
      metadata: {
        name: normalizedName,
        ownerUserId: args.ownerUserId,
        ownerPublisherId: args.ownerPublisherId,
        family,
        reason: args.reason || undefined,
      },
      createdAt: now,
    });

    return {
      ok: true as const,
      action: "reserved" as const,
      packageId,
      name: normalizedName,
    };
  },
});

async function patchPackageOwnerWithAudit(
  ctx: Pick<MutationCtx, "db">,
  args: {
    actorUserId: Id<"users">;
    pkg: Doc<"packages">;
    owner: Doc<"users">;
    ownerPublisher?: Doc<"publishers"> | null;
    publisherOfficial?: boolean;
    channel?: "official" | "community" | "private";
    reason?: string;
  },
) {
  const now = Date.now();
  const publisherOfficial =
    args.publisherOfficial ?? (await isOfficialPublisher(ctx, args.ownerPublisher));
  const nextChannel = derivePackagePublisherChannel({
    requestedChannel: args.channel,
    currentChannel: args.pkg.channel,
    publisherOfficial,
  });
  if (nextChannel === "official" && !publisherOfficial) {
    throw new ConvexError("Only official publishers may own official packages");
  }
  const nextPackageFields = {
    ownerUserId: args.owner._id,
    ownerPublisherId: args.ownerPublisher?._id,
    channel: nextChannel,
    isOfficial: nextChannel === "official",
    updatedAt: now,
  };

  if (args.pkg.family === "code-plugin") {
    await assertPackageRuntimeIdAvailable(ctx, { ...args.pkg, ...nextPackageFields });
  }

  await ctx.db.patch(args.pkg._id, nextPackageFields);
  await upsertPackageSearchDigest(ctx, {
    ...extractPackageDigestFields(args.pkg),
    ...nextPackageFields,
  });

  await ctx.db.insert("auditLogs", {
    actorUserId: args.actorUserId,
    action: "package.owner.transfer",
    targetType: "package",
    targetId: args.pkg._id,
    metadata: {
      name: args.pkg.normalizedName,
      previousOwnerUserId: args.pkg.ownerUserId,
      previousOwnerPublisherId: args.pkg.ownerPublisherId,
      nextOwnerUserId: args.owner._id,
      nextOwnerPublisherId: args.ownerPublisher?._id,
      previousChannel: args.pkg.channel,
      nextChannel,
      reason: args.reason || undefined,
    },
    createdAt: now,
  });

  return {
    ok: true as const,
    packageId: args.pkg._id,
    name: args.pkg.normalizedName,
    ownerUserId: args.owner._id,
    ownerPublisherId: args.ownerPublisher?._id,
    channel: nextChannel,
    isOfficial: nextChannel === "official",
  };
}

async function transferPackageOwnerForUser(
  ctx: MutationCtx,
  args: {
    actorUserId: Id<"users">;
    name: string;
    toOwner: string;
    reason?: string;
  },
) {
  const actor = await ctx.db.get(args.actorUserId);
  if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");

  const normalizedName = normalizePackageName(args.name);
  const pkg = await getPackageByNormalizedName(ctx, normalizedName);
  if (!pkg || pkg.softDeletedAt) throw new ConvexError("Package not found");
  if (pkg.family === "skill") {
    throw new ConvexError("Skill packages must use the skills transfer flow");
  }

  const scopedOwner = inferOwnerHandleFromScopedPackageName(normalizedName);
  const destinationHandle = normalizePublisherHandle(args.toOwner);
  if (!destinationHandle) throw new ConvexError("Destination owner is required");
  if (scopedOwner && scopedOwner !== destinationHandle) {
    throw new ConvexError(
      `Package scope "@${scopedOwner}" can only be transferred to publisher "@${scopedOwner}".`,
    );
  }

  if (pkg.ownerPublisherId) {
    const sourcePublisher = await ctx.db.get(pkg.ownerPublisherId);
    const sourceMembership = await getPublisherMembership(ctx, pkg.ownerPublisherId, actor._id);
    const canManagePersonalSource =
      sourcePublisher?.kind === "user" &&
      (sourcePublisher.linkedUserId
        ? sourcePublisher.linkedUserId === actor._id
        : pkg.ownerUserId === actor._id);
    const canManageSource =
      actor.role === "admin" ||
      (sourcePublisher?.kind === "user"
        ? canManagePersonalSource
        : Boolean(sourceMembership && isPublisherRoleAllowed(sourceMembership.role, ["admin"])));
    if (!canManageSource) {
      throw new ConvexError("Forbidden");
    }
  } else {
    await assertCanManageOwnedResource(ctx, {
      actor,
      ownerUserId: pkg.ownerUserId,
      ownerPublisherId: pkg.ownerPublisherId,
      allowedPublisherRoles: ["admin"],
      allowPlatformAdmin: true,
    });
  }

  const destinationPublisher = await getPublisherByHandle(ctx, destinationHandle);
  if (
    !destinationPublisher ||
    destinationPublisher.deletedAt ||
    destinationPublisher.deactivatedAt
  ) {
    throw new ConvexError(
      `Publisher "@${destinationHandle}" not found. Create the "@${destinationHandle}" organization on ClawHub before transferring this package.`,
    );
  }

  const destinationMembership = await getPublisherMembership(
    ctx,
    destinationPublisher._id,
    actor._id,
  );
  const canManagePersonalDestination =
    destinationPublisher.kind === "user" &&
    (destinationPublisher.linkedUserId
      ? destinationPublisher.linkedUserId === actor._id
      : actor.personalPublisherId === destinationPublisher._id);
  const canManageDestination =
    actor.role === "admin" ||
    (destinationPublisher.kind === "user"
      ? canManagePersonalDestination
      : Boolean(
          destinationMembership && isPublisherRoleAllowed(destinationMembership.role, ["admin"]),
        ));
  if (!canManageDestination) {
    throw new ConvexError(
      `You do not have admin access for "@${destinationHandle}". Ask an owner or admin to add you before transferring this package.`,
    );
  }

  return await patchPackageOwnerWithAudit(ctx, {
    actorUserId: actor._id,
    pkg,
    owner: actor,
    ownerPublisher: destinationPublisher,
    publisherOfficial: await isOfficialPublisher(ctx, destinationPublisher),
    reason: args.reason,
  });
}

export const transferPackageOwnerForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    name: v.string(),
    toOwner: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => await transferPackageOwnerForUser(ctx, args),
});

export const transferPackageOwner = mutation({
  args: {
    name: v.string(),
    toOwner: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    return await transferPackageOwnerForUser(ctx, {
      actorUserId: user._id,
      ...args,
    });
  },
});

export const transferPackageOwnerInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    name: v.string(),
    ownerUserId: v.id("users"),
    ownerPublisherId: v.optional(v.id("publishers")),
    channel: v.optional(
      v.union(v.literal("official"), v.literal("community"), v.literal("private")),
    ),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
    assertAdmin(actor);

    const owner = await ctx.db.get(args.ownerUserId);
    if (!owner || owner.deletedAt || owner.deactivatedAt) {
      throw new ConvexError("Owner user not found");
    }

    const ownerPublisher = args.ownerPublisherId ? await ctx.db.get(args.ownerPublisherId) : null;
    if (args.ownerPublisherId && (!ownerPublisher || ownerPublisher.deletedAt)) {
      throw new ConvexError("Owner publisher not found");
    }
    const officialPublisher = await getOwnerPublisher(ctx, {
      ownerPublisherId: args.ownerPublisherId,
      ownerUserId: args.ownerUserId,
    });

    const normalizedName = normalizePackageName(args.name);
    const pkg = await getPackageByNormalizedName(ctx, normalizedName);
    if (!pkg || pkg.softDeletedAt) throw new ConvexError("Package not found");

    return await patchPackageOwnerWithAudit(ctx, {
      actorUserId: args.actorUserId,
      pkg,
      owner,
      ownerPublisher,
      publisherOfficial: await isOfficialPublisher(ctx, officialPublisher),
      channel: args.channel,
      reason: args.reason,
    });
  },
});

export const repairPackageIdentityInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    name: v.string(),
    nextName: v.optional(v.string()),
    nextRuntimeId: v.optional(v.string()),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
    assertAdmin(actor);

    const normalizedName = normalizePackageName(args.name);
    const pkg = await getPackageByNormalizedName(ctx, normalizedName);
    if (!pkg || pkg.softDeletedAt) throw new ConvexError("Package not found");

    const patch: Partial<Doc<"packages">> = { updatedAt: now };
    const metadata: Record<string, unknown> = {
      name: normalizedName,
      reason: args.reason,
    };

    if (typeof args.nextName === "string") {
      const nextName = normalizePackageName(args.nextName);
      if (!nextName) throw new ConvexError("Package name required");
      const existingByName = await getPackageByNormalizedName(ctx, nextName);
      if (existingByName && existingByName._id !== pkg._id && !existingByName.softDeletedAt) {
        throw new ConvexError(`Package "${nextName}" already exists`);
      }
      patch.name = nextName;
      patch.normalizedName = nextName;
      metadata.previousName = pkg.normalizedName;
      metadata.nextName = nextName;
    }

    if (typeof args.nextRuntimeId === "string") {
      const nextRuntimeId = args.nextRuntimeId.trim();
      if (!nextRuntimeId) throw new ConvexError("Runtime id required");
      await assertPackageRuntimeIdAvailable(ctx, { ...pkg, runtimeId: nextRuntimeId });
      patch.runtimeId = nextRuntimeId;
      metadata.previousRuntimeId = pkg.runtimeId;
      metadata.nextRuntimeId = nextRuntimeId;
    }

    await ctx.db.patch(pkg._id, patch);
    await upsertPackageSearchDigest(ctx, {
      ...extractPackageDigestFields(pkg),
      ...patch,
    });
    await ctx.db.insert("auditLogs", {
      actorUserId: args.actorUserId,
      action: "package.identity.repair",
      targetType: "package",
      targetId: pkg._id,
      metadata,
      createdAt: now,
    });

    return {
      ok: true as const,
      packageId: pkg._id,
      name: patch.normalizedName ?? pkg.normalizedName,
      runtimeId: patch.runtimeId ?? pkg.runtimeId,
    };
  },
});

export const setPackageCatalogMetadata = mutation({
  args: {
    packageId: v.id("packages"),
    categories: v.optional(v.array(v.string())),
    topics: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);

    const pkg = await ctx.db.get(args.packageId);
    if (!pkg || pkg.softDeletedAt) throw new ConvexError("Package not found");
    await assertCanManageOwnedResource(ctx, {
      actor: user,
      ownerUserId: pkg.ownerUserId,
      ownerPublisherId: pkg.ownerPublisherId,
      allowedPublisherRoles: ["publisher"],
      allowPlatformModerator: true,
    });

    let normalizedCategories: string[];
    let normalizedTopics: string[];
    try {
      normalizedCategories = resolvePluginCategories({ declared: args.categories });
      normalizedTopics = normalizeCatalogTopics(args.topics);
    } catch (error) {
      throw new ConvexError(error instanceof Error ? error.message : "Invalid catalog metadata");
    }

    const now = Date.now();
    const nextPackage = {
      ...pkg,
      categories: normalizedCategories,
      topics: normalizedTopics.length ? normalizedTopics : undefined,
      inferredCategories: undefined,
      inferredTopics: undefined,
      inferredFromReleaseId: undefined,
      inferredCategoryConfidence: undefined,
      inferredTopicConfidence: undefined,
      inferredClassifierVersion: undefined,
      inferredTopicClassifierVersion: undefined,
      inferredInputHash: undefined,
      inferredTopicInputHash: undefined,
      inferredAt: undefined,
      updatedAt: now,
    };
    await ctx.db.patch(pkg._id, {
      categories: nextPackage.categories,
      topics: nextPackage.topics,
      inferredCategories: nextPackage.inferredCategories,
      inferredTopics: nextPackage.inferredTopics,
      inferredFromReleaseId: nextPackage.inferredFromReleaseId,
      inferredCategoryConfidence: nextPackage.inferredCategoryConfidence,
      inferredTopicConfidence: nextPackage.inferredTopicConfidence,
      inferredClassifierVersion: nextPackage.inferredClassifierVersion,
      inferredTopicClassifierVersion: nextPackage.inferredTopicClassifierVersion,
      inferredInputHash: nextPackage.inferredInputHash,
      inferredTopicInputHash: nextPackage.inferredTopicInputHash,
      inferredAt: nextPackage.inferredAt,
      updatedAt: now,
    });
    const owner = await getOwnerPublisher(ctx, {
      ownerPublisherId: nextPackage.ownerPublisherId,
      ownerUserId: nextPackage.ownerUserId,
    });
    await upsertPackageSearchDigest(ctx, {
      ...extractPackageDigestFields(nextPackage),
      ownerHandle: owner?.handle ?? "",
      ownerKind: owner?.kind,
    });
    await ctx.db.insert("auditLogs", {
      actorUserId: user._id,
      action: "package.catalog_metadata.set",
      targetType: "package",
      targetId: pkg._id,
      metadata: {
        previous: { categories: pkg.categories, topics: pkg.topics },
        next: { categories: nextPackage.categories, topics: nextPackage.topics },
      },
      createdAt: now,
    });
  },
});

export const insertPackageInspectorWarningsInternal = internalMutation({
  args: {
    packageId: v.id("packages"),
    releaseId: v.id("packageReleases"),
    ownerUserId: v.id("users"),
    ownerPublisherId: v.optional(v.id("publishers")),
    packageName: v.string(),
    version: v.string(),
    scanSource: v.optional(v.union(v.literal("publish"), v.literal("nightly"))),
    inspectorVersion: v.optional(v.string()),
    targetOpenClawVersion: v.optional(v.string()),
    findings: v.optional(v.array(packageInspectorFindingInputValidator)),
    warnings: v.optional(v.array(packageInspectorWarningInputValidator)),
  },
  handler: async (ctx, args) => {
    return await insertPackageInspectorFindings(ctx, args);
  },
});

async function hasCompletedPackageInspectorNotification(
  ctx: DbReaderCtx,
  args: {
    releaseId: Id<"packageReleases">;
    inspectorVersion?: string;
    targetOpenClawVersion?: string;
    exactScanIdentity: boolean;
  },
) {
  if (args.exactScanIdentity && args.inspectorVersion && args.targetOpenClawVersion) {
    const scanState = await ctx.db
      .query("packageInspectorScanStates")
      .withIndex("by_release_and_inspector_version_and_target_openclaw_version", (q) =>
        q
          .eq("releaseId", args.releaseId)
          .eq("inspectorVersion", args.inspectorVersion as string)
          .eq("targetOpenClawVersion", args.targetOpenClawVersion as string),
      )
      .unique();
    return Boolean(scanState?.notificationCompletedAt);
  }
  const notification = await ctx.db
    .query("packageInspectorFindingNotifications")
    .withIndex("by_release", (q) => q.eq("releaseId", args.releaseId))
    .unique();
  return Boolean(notification);
}

async function insertPackageInspectorFindings(
  ctx: Pick<MutationCtx, "db">,
  args: {
    packageId: Id<"packages">;
    releaseId: Id<"packageReleases">;
    ownerUserId: Id<"users">;
    ownerPublisherId?: Id<"publishers">;
    packageName: string;
    version: string;
    scanSource?: "publish" | "nightly";
    inspectorVersion?: string;
    targetOpenClawVersion?: string;
    notifyOwners?: boolean;
    findings?: PackageInspectorFinding[];
    warnings?: PackageInspectorFinding[];
  },
) {
  const findings = (args.findings ?? args.warnings ?? []).filter(hasAuthorRemediation);
  const existingWarnings = await ctx.db
    .query("packageInspectorWarnings")
    .withIndex("by_release", (q) => q.eq("releaseId", args.releaseId))
    .collect();
  const replaceNightlyFindings = args.scanSource === "nightly";
  if (replaceNightlyFindings) {
    for (const warning of existingWarnings) {
      if (warning.scanSource === "nightly") await ctx.db.delete(warning._id);
    }
  }
  const existingAuthorWarnings = existingWarnings.filter(
    (warning) =>
      hasStoredAuthorRemediation(warning) &&
      !(replaceNightlyFindings && warning.scanSource === "nightly"),
  );
  if (findings.length === 0 && existingAuthorWarnings.length === 0) {
    return { ok: true as const, inserted: 0, shouldEmailOwner: false };
  }
  const existingWarningKeys = new Set(
    replaceNightlyFindings
      ? []
      : existingAuthorWarnings.map((warning) =>
          packageInspectorWarningDedupeKey({
            id: warning.inspectorFindingId,
            code: warning.code,
            message: warning.message,
            evidence: warning.evidence,
            fixture: warning.fixture,
            inspectorVersion: warning.inspectorVersion,
            targetOpenClawVersion: warning.targetOpenClawVersion,
          }),
        ),
  );
  const shouldNotifyOwner = args.notifyOwners ?? args.scanSource !== "nightly";
  const notificationCompleted = shouldNotifyOwner
    ? await hasCompletedPackageInspectorNotification(ctx, {
        releaseId: args.releaseId,
        inspectorVersion: args.inspectorVersion,
        targetOpenClawVersion: args.targetOpenClawVersion,
        exactScanIdentity: args.scanSource === "nightly",
      })
    : false;
  const now = Date.now();
  let inserted = 0;
  let hasStoredHardError =
    args.scanSource !== "nightly" &&
    existingAuthorWarnings.some((warning) => warning.findingKind === "error");
  for (const warning of findings.slice(0, 100)) {
    const warningKey = packageInspectorWarningDedupeKey({
      ...warning,
      inspectorVersion: args.inspectorVersion,
      targetOpenClawVersion: args.targetOpenClawVersion,
    });
    if (existingWarningKeys.has(warningKey)) continue;
    const findingKind =
      warning.level === "breakage" || warning.level === "error" || warning.severity === "P0"
        ? "error"
        : "warning";
    if (findingKind === "error") hasStoredHardError = true;
    await ctx.db.insert("packageInspectorWarnings", {
      packageId: args.packageId,
      releaseId: args.releaseId,
      ownerUserId: args.ownerUserId,
      ownerPublisherId: args.ownerPublisherId,
      packageName: args.packageName,
      version: args.version,
      findingKind,
      scanSource: args.scanSource ?? "publish",
      inspectorVersion: args.inspectorVersion,
      targetOpenClawVersion: args.targetOpenClawVersion,
      code: warning.code,
      severity: warning.severity,
      level: warning.level,
      issueClass: warning.issueClass,
      compatStatus: warning.compatStatus,
      deprecated: warning.deprecated,
      message: warning.message,
      evidence: warning.evidence,
      authorRemediation: warning.authorRemediation,
      fixture: warning.fixture,
      decision: warning.decision,
      inspectorFindingId: warning.id,
      createdAt: now,
    });
    existingWarningKeys.add(warningKey);
    inserted += 1;
  }
  return {
    ok: true as const,
    inserted,
    shouldEmailOwner:
      shouldNotifyOwner &&
      !notificationCompleted &&
      hasStoredHardError &&
      (args.scanSource === "nightly"
        ? findings.length > 0
        : inserted > 0 || existingAuthorWarnings.length > 0),
  };
}

export const markPackageInspectorFindingsEmailedInternal = internalMutation({
  args: {
    packageId: v.id("packages"),
    releaseId: v.id("packageReleases"),
    ownerUserId: v.id("users"),
    ownerPublisherId: v.optional(v.id("publishers")),
    packageName: v.string(),
    version: v.string(),
    findingCount: v.number(),
    email: v.string(),
    inspectorVersion: v.optional(v.string()),
    targetOpenClawVersion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("packageInspectorFindingNotifications")
      .withIndex("by_release", (q) => q.eq("releaseId", args.releaseId))
      .unique();
    const now = Date.now();
    if (!existing) {
      await ctx.db.insert("packageInspectorFindingNotifications", {
        packageId: args.packageId,
        releaseId: args.releaseId,
        ownerUserId: args.ownerUserId,
        ownerPublisherId: args.ownerPublisherId,
        packageName: args.packageName,
        version: args.version,
        email: args.email,
        findingCount: Math.max(0, Math.round(args.findingCount)),
        sentAt: now,
      });
    }
    const { inspectorVersion, targetOpenClawVersion } = args;
    if (inspectorVersion && targetOpenClawVersion) {
      const scanState = await ctx.db
        .query("packageInspectorScanStates")
        .withIndex("by_release_and_inspector_version_and_target_openclaw_version", (q) =>
          q
            .eq("releaseId", args.releaseId)
            .eq("inspectorVersion", inspectorVersion)
            .eq("targetOpenClawVersion", targetOpenClawVersion),
        )
        .unique();
      if (scanState) await ctx.db.patch(scanState._id, { notificationCompletedAt: now });
    }
    return { ok: true as const, created: !existing };
  },
});

export const markPackageInspectorNotificationCompletedInternal = internalMutation({
  args: {
    packageId: v.id("packages"),
    releaseId: v.id("packageReleases"),
    inspectorVersion: v.string(),
    targetOpenClawVersion: v.string(),
  },
  handler: async (ctx, args) => {
    const scanState = await ctx.db
      .query("packageInspectorScanStates")
      .withIndex("by_release_and_inspector_version_and_target_openclaw_version", (q) =>
        q
          .eq("releaseId", args.releaseId)
          .eq("inspectorVersion", args.inspectorVersion)
          .eq("targetOpenClawVersion", args.targetOpenClawVersion),
      )
      .unique();
    if (!scanState || scanState.packageId !== args.packageId) {
      return { ok: true as const, marked: false };
    }
    if (!scanState.notificationCompletedAt) {
      await ctx.db.patch(scanState._id, { notificationCompletedAt: Date.now() });
    }
    return { ok: true as const, marked: true };
  },
});

export const getPackageInspectorEmailContextInternal = internalQuery({
  args: {
    packageId: v.id("packages"),
    releaseId: v.id("packageReleases"),
    inspectorVersion: v.optional(v.string()),
    targetOpenClawVersion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const [pkg, release] = await Promise.all([
      ctx.db.get(args.packageId),
      ctx.db.get(args.releaseId),
    ]);
    if (
      !pkg ||
      pkg.softDeletedAt ||
      !release ||
      release.softDeletedAt ||
      release.packageId !== pkg._id
    ) {
      return null;
    }
    const owner = await ctx.db.get(pkg.ownerUserId);
    if (!owner || owner.deletedAt || owner.deactivatedAt || !owner.email) return null;
    const exactScanIdentity = Boolean(args.inspectorVersion && args.targetOpenClawVersion);
    const findings =
      args.inspectorVersion && args.targetOpenClawVersion
        ? await takeExactNightlyAuthorRemediationWarningsByRelease(
            ctx,
            release._id,
            args.inspectorVersion,
            args.targetOpenClawVersion,
            100,
          )
        : await takeAuthorRemediationWarningsByRelease(ctx, release._id, 100);
    const hardErrors = findings.filter((finding) => finding.findingKind === "error");
    if (hardErrors.length === 0) return null;
    const notificationCompleted = await hasCompletedPackageInspectorNotification(ctx, {
      releaseId: release._id,
      inspectorVersion: args.inspectorVersion,
      targetOpenClawVersion: args.targetOpenClawVersion,
      exactScanIdentity,
    });
    if (notificationCompleted) return null;
    return {
      packageId: pkg._id,
      releaseId: release._id,
      ownerUserId: pkg.ownerUserId,
      ownerPublisherId: pkg.ownerPublisherId,
      ownerEmail: owner.email,
      ownerHandle: owner.handle,
      packageName: pkg.name,
      version: release.version,
      findings: hardErrors.map(toPublicPackageInspectorFinding),
    };
  },
});

export const sendPackageInspectorFindingsEmailInternal = internalAction({
  args: {
    packageId: v.id("packages"),
    releaseId: v.id("packageReleases"),
    inspectorVersion: v.optional(v.string()),
    targetOpenClawVersion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const context = await runQueryRef<{
      packageId: Id<"packages">;
      releaseId: Id<"packageReleases">;
      ownerUserId: Id<"users">;
      ownerPublisherId?: Id<"publishers">;
      ownerEmail: string;
      ownerHandle?: string;
      packageName: string;
      version: string;
      findings: Array<{
        findingKind: "warning" | "error";
        code: string;
        issueClass?: string;
        level?: string;
        severity?: string;
        message: string;
        authorRemediation?: PackageInspectorAuthorRemediation;
        inspectorVersion?: string;
        targetOpenClawVersion?: string;
        scanSource?: "publish" | "nightly";
      }>;
    } | null>(ctx, internalRefs.packages.getPackageInspectorEmailContextInternal, args);
    if (!context) return { ok: true as const, sent: false, reason: "no-context" as const };

    const email = await buildPackageInspectorFindingsEmail({
      handle: context.ownerHandle,
      packageName: context.packageName,
      version: context.version,
      validationUrl: buildPackageInspectorValidationUrl(context.packageName),
    });
    const sent = await sendResendEmail({
      to: context.ownerEmail,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    if (sent) {
      await runMutationRef(ctx, internalRefs.packages.markPackageInspectorFindingsEmailedInternal, {
        packageId: context.packageId,
        releaseId: context.releaseId,
        ownerUserId: context.ownerUserId,
        ownerPublisherId: context.ownerPublisherId,
        packageName: context.packageName,
        version: context.version,
        findingCount: context.findings.length,
        email: context.ownerEmail,
        inspectorVersion: args.inspectorVersion,
        targetOpenClawVersion: args.targetOpenClawVersion,
      });
    }
    return { ok: true as const, sent };
  },
});

type PackageInspectorScanBatchItem = {
  packageId: Id<"packages">;
  releaseId: Id<"packageReleases">;
  ownerUserId: Id<"users">;
  ownerPublisherId?: Id<"publishers">;
  packageName: string;
  version: string;
  artifactKind: "legacy-zip" | "npm-pack";
};

async function listPackageInspectorScanBatch(
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  args: {
    cursor?: string | null;
    batchSize?: number;
    inspectorVersion?: string;
    targetOpenClawVersion?: string;
    notifyOwners?: boolean;
  },
) {
  const batchSize = Math.max(1, Math.min(Math.round(args.batchSize ?? 25), 50));
  const items: PackageInspectorScanBatchItem[] = [];
  let skippedUnchanged = 0;
  const sourceCursor = args.cursor ?? null;
  // Convex permits only one native paginated query per function. The workflow
  // acknowledges this source-page cursor and requests the next page separately.
  const page = await ctx.db
    .query("packageReleases")
    .withIndex("by_active_created", (q) => q.eq("softDeletedAt", undefined))
    .order("asc")
    .paginate({
      cursor: sourceCursor,
      numItems: batchSize,
    });
  if (!page.isDone && page.continueCursor === sourceCursor) {
    throw new Error("Package Inspector scan pagination cursor did not advance");
  }
  for (const release of page.page) {
    if (!isPublishedPackageRelease(release)) continue;
    const pkg = await ctx.db.get(release.packageId);
    if (
      !pkg ||
      pkg.softDeletedAt ||
      (pkg.family !== "code-plugin" && pkg.family !== "bundle-plugin") ||
      pkg.channel === "private" ||
      isPackageBlockedFromPublic(resolvePublicPackageScanStatus(pkg, release))
    ) {
      continue;
    }
    const latestReleaseId = pkg.latestReleaseId ?? pkg.tags?.latest;
    if (latestReleaseId !== release._id) continue;
    const { inspectorVersion, targetOpenClawVersion } = args;
    if (inspectorVersion && targetOpenClawVersion) {
      const scanState = await ctx.db
        .query("packageInspectorScanStates")
        .withIndex("by_release_and_inspector_version_and_target_openclaw_version", (q) =>
          q
            .eq("releaseId", release._id)
            .eq("inspectorVersion", inspectorVersion)
            .eq("targetOpenClawVersion", targetOpenClawVersion),
        )
        .unique();
      if (scanState && (!args.notifyOwners || scanState.notificationCompletedAt)) {
        skippedUnchanged += 1;
        continue;
      }
    }
    items.push({
      packageId: pkg._id,
      releaseId: release._id,
      ownerUserId: pkg.ownerUserId,
      ownerPublisherId: pkg.ownerPublisherId,
      packageName: pkg.name,
      version: release.version,
      artifactKind: release.artifactKind ?? "legacy-zip",
    });
  }
  const nextCursor = page.isDone ? null : page.continueCursor;
  return {
    items,
    nextCursor,
    skippedUnchanged,
  };
}

export const previewPackageInspectorScanBatchInternal = internalQuery({
  args: {
    batchSize: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
    inspectorVersion: v.optional(v.string()),
    targetOpenClawVersion: v.optional(v.string()),
    notifyOwners: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const result = await listPackageInspectorScanBatch(ctx, args);
    return { ok: true as const, leased: false as const, ...result };
  },
});

export const claimPackageInspectorScanBatchInternal = internalMutation({
  args: {
    batchSize: v.optional(v.number()),
    leaseMs: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
    runId: v.string(),
    inspectorVersion: v.optional(v.string()),
    targetOpenClawVersion: v.optional(v.string()),
    notifyOwners: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const runId = args.runId.trim();
    if (!runId) throw new Error("Package Inspector scan runId is required");
    const leaseMs = Math.max(
      60_000,
      Math.min(Math.round(args.leaseMs ?? 30 * 60_000), 2 * 60 * 60_000),
    );
    const cursorName = "nightly";
    const cursorDoc = await ctx.db
      .query("packageInspectorScanCursors")
      .withIndex("by_name", (q) => q.eq("name", cursorName))
      .unique();
    const expectedCursor = cursorDoc?.cursor ?? null;
    const hasPendingBatch = Boolean(cursorDoc && Object.hasOwn(cursorDoc, "pendingCursor"));
    // A GitHub workflow rerun keeps its run id. Let it reclaim an unacknowledged
    // page immediately so a failed attempt does not strand the cursor until expiry.
    const continuingSameRun = cursorDoc?.runId === runId;
    if (cursorDoc?.leaseExpiresAt && cursorDoc.leaseExpiresAt > now && !continuingSameRun) {
      return {
        ok: true as const,
        leased: true as const,
        items: [],
        nextCursor: hasPendingBatch ? (cursorDoc.pendingCursor ?? null) : expectedCursor,
      };
    }

    const { items, nextCursor, skippedUnchanged } = await listPackageInspectorScanBatch(ctx, {
      cursor: expectedCursor,
      batchSize: args.batchSize,
      inspectorVersion: args.inspectorVersion,
      targetOpenClawVersion: args.targetOpenClawVersion,
      notifyOwners: args.notifyOwners,
    });
    if (cursorDoc) {
      await ctx.db.patch(cursorDoc._id, {
        cursor: expectedCursor,
        pendingCursor: nextCursor,
        runId,
        leaseExpiresAt: now + leaseMs,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("packageInspectorScanCursors", {
        name: cursorName,
        cursor: expectedCursor,
        pendingCursor: nextCursor,
        runId,
        leaseExpiresAt: now + leaseMs,
        updatedAt: now,
      });
    }
    return {
      ok: true as const,
      leased: false as const,
      items,
      nextCursor,
      skippedUnchanged,
    };
  },
});

export const acknowledgePackageInspectorScanBatchInternal = internalMutation({
  args: {
    runId: v.string(),
    cursor: v.union(v.string(), v.null()),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const runId = args.runId.trim();
    if (!runId) throw new Error("Package Inspector scan runId is required");
    const leaseMs = Math.max(
      60_000,
      Math.min(Math.round(args.leaseMs ?? 30 * 60_000), 2 * 60 * 60_000),
    );
    const cursorDoc = await ctx.db
      .query("packageInspectorScanCursors")
      .withIndex("by_name", (q) => q.eq("name", "nightly"))
      .unique();
    if (!cursorDoc || cursorDoc.runId !== runId) {
      throw new Error("Package Inspector scan run does not own the active lease");
    }
    if (!Object.hasOwn(cursorDoc, "pendingCursor") || cursorDoc.pendingCursor !== args.cursor) {
      throw new Error("Package Inspector scan acknowledgement cursor does not match the lease");
    }

    const completed = args.cursor === null;
    await ctx.db.patch(cursorDoc._id, {
      cursor: args.cursor,
      pendingCursor: undefined,
      runId: completed ? undefined : runId,
      leaseExpiresAt: completed ? now : now + leaseMs,
      updatedAt: now,
    });
    return { ok: true as const, cursor: args.cursor, completed };
  },
});

export const getPackageInspectorArtifactInternal = internalQuery({
  args: {
    releaseId: v.id("packageReleases"),
  },
  handler: async (ctx, args) => {
    const release = await ctx.db.get(args.releaseId);
    if (!isPublishedPackageRelease(release)) return null;
    const pkg = await ctx.db.get(release.packageId);
    if (
      !pkg ||
      pkg.softDeletedAt ||
      (pkg.family !== "code-plugin" && pkg.family !== "bundle-plugin") ||
      pkg.channel === "private" ||
      isPackageBlockedFromPublic(resolvePublicPackageScanStatus(pkg, release))
    ) {
      return null;
    }
    return {
      packageName: pkg.name,
      version: release.version,
      artifactKind: release.artifactKind ?? ("legacy-zip" as const),
      clawpackStorageId: release.clawpackStorageId,
      clawpackSha256: release.clawpackSha256,
      npmIntegrity: release.npmIntegrity,
      npmShasum: release.npmShasum,
      npmTarballName: release.npmTarballName,
      files: release.files.map((file) => ({
        path: file.path,
        storageId: file.storageId,
      })),
    };
  },
});

export const ingestPackageInspectorScanResultsInternal = internalMutation({
  args: {
    packageId: v.id("packages"),
    releaseId: v.id("packageReleases"),
    inspectorVersion: v.optional(v.string()),
    targetOpenClawVersion: v.optional(v.string()),
    notifyOwners: v.optional(v.boolean()),
    findings: v.array(packageInspectorFindingInputValidator),
  },
  handler: async (ctx, args) => {
    const [pkg, release] = await Promise.all([
      ctx.db.get(args.packageId),
      ctx.db.get(args.releaseId),
    ]);
    if (
      !pkg ||
      pkg.softDeletedAt ||
      !release ||
      release.softDeletedAt ||
      release.packageId !== pkg._id
    ) {
      throw new ConvexError("Package release not found");
    }
    const result = await insertPackageInspectorFindings(ctx, {
      packageId: pkg._id,
      releaseId: release._id,
      ownerUserId: pkg.ownerUserId,
      ownerPublisherId: pkg.ownerPublisherId,
      packageName: pkg.name,
      version: release.version,
      scanSource: "nightly",
      inspectorVersion: args.inspectorVersion,
      targetOpenClawVersion: args.targetOpenClawVersion,
      notifyOwners: args.notifyOwners,
      findings: args.findings,
    });
    const { inspectorVersion, targetOpenClawVersion } = args;
    if (inspectorVersion && targetOpenClawVersion) {
      const completedAt = Date.now();
      const existingState = await ctx.db
        .query("packageInspectorScanStates")
        .withIndex("by_release_and_inspector_version_and_target_openclaw_version", (q) =>
          q
            .eq("releaseId", release._id)
            .eq("inspectorVersion", inspectorVersion)
            .eq("targetOpenClawVersion", targetOpenClawVersion),
        )
        .unique();
      const state = {
        packageId: pkg._id,
        releaseId: release._id,
        inspectorVersion,
        targetOpenClawVersion,
        completedAt,
        ...(args.notifyOwners === true && !result.shouldEmailOwner
          ? { notificationCompletedAt: completedAt }
          : {}),
      };
      if (existingState) {
        await ctx.db.patch(existingState._id, {
          completedAt,
          ...(state.notificationCompletedAt
            ? { notificationCompletedAt: state.notificationCompletedAt }
            : {}),
        });
      } else {
        await ctx.db.insert("packageInspectorScanStates", state);
      }
    }
    return result;
  },
});

async function sendResendEmail(args: { to: string; subject: string; text: string; html: string }) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM_EMAIL?.trim() || process.env.CLAWHUB_EMAIL_FROM?.trim();
  if (!apiKey || !from) return false;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: args.to,
        subject: args.subject,
        text: args.text,
        html: args.html,
      }),
    });
    if (!response.ok) {
      console.error(`Resend email failed: ${response.status} ${await response.text()}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Resend email failed", error);
    return false;
  }
}

function pendingPackagePublicationMetadata(release: Doc<"packageReleases">) {
  return release.pendingPublication &&
    typeof release.pendingPublication === "object" &&
    !Array.isArray(release.pendingPublication)
    ? (release.pendingPublication as Record<string, unknown>)
    : {};
}

function stringPendingField(metadata: Record<string, unknown>, field: string, fallback?: string) {
  const value = metadata[field];
  return typeof value === "string" ? value : fallback;
}

function booleanPendingField(metadata: Record<string, unknown>, field: string, fallback: boolean) {
  const value = metadata[field];
  return typeof value === "boolean" ? value : fallback;
}

function stringArrayPendingField(metadata: Record<string, unknown>, field: string) {
  const value = metadata[field];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

type PackageReleaseTagCleanupAssignment = {
  releaseId: Id<"packageReleases">;
  tags: string[];
};

function resolvePackageReleaseTagsForPublish(params: {
  family: Doc<"packages">["family"];
  currentLatestExists: boolean;
  currentLatestVersion?: string;
  candidateVersion: string;
  requestedTags: string[];
}) {
  const requestedLatest = params.requestedTags.some((tag) => tag.toLowerCase() === "latest");
  const currentLatestSemver = params.currentLatestVersion
    ? semver.valid(params.currentLatestVersion)
    : null;
  const candidateSemver = semver.valid(params.candidateVersion);
  const latestUsesSemver = params.family === "code-plugin" || params.family === "claw";
  // `latest` is reserved for the highest semver on versioned package families.
  // Callers default to this tag, so accepting it blindly would let backports roll the catalog back.
  const shouldPromoteLatest =
    requestedLatest &&
    (!latestUsesSemver ||
      !params.currentLatestExists ||
      (currentLatestSemver !== null &&
        candidateSemver !== null &&
        semver.gt(candidateSemver, currentLatestSemver)));
  const effectiveTags = [
    ...new Set(params.requestedTags.filter((tag) => tag.toLowerCase() !== "latest")),
  ];
  if (shouldPromoteLatest) effectiveTags.push("latest");
  return { effectiveTags, shouldPromoteLatest };
}

function getPackageTagReleaseId(
  pkg: Pick<Doc<"packages">, "_id" | "latestReleaseId" | "tags">,
  tag: string,
) {
  return tag === "latest" ? (pkg.tags.latest ?? pkg.latestReleaseId) : pkg.tags[tag];
}

async function resolvePackageCurrentLatestForPublish(
  ctx: Pick<MutationCtx, "db">,
  pkg: Pick<
    Doc<"packages">,
    "_id" | "family" | "latestReleaseId" | "latestVersionSummary" | "tags"
  >,
) {
  const latestReleaseId = getPackageTagReleaseId(pkg, "latest");
  if (!latestReleaseId) return { exists: false, version: undefined };
  if (pkg.family !== "code-plugin" && pkg.family !== "claw") {
    return { exists: true, version: pkg.latestVersionSummary?.version };
  }

  const latestRelease = await ctx.db.get(latestReleaseId);
  if (
    latestRelease &&
    latestRelease.packageId === pkg._id &&
    isPublishedPackageRelease(latestRelease)
  ) {
    return { exists: true, version: latestRelease.version };
  }
  // Keep the current pointer when its release row is missing or unusable.
  // Promotion without a comparable version could roll installs back to a backport.
  return { exists: true, version: pkg.latestVersionSummary?.version };
}

function planPackageReleaseTagReassignment(
  pkg: Pick<Doc<"packages">, "_id" | "latestReleaseId" | "tags">,
  releaseId: Id<"packageReleases">,
  effectiveTags: string[],
) {
  const cleanupTagsByRelease = new Map<Id<"packageReleases">, string[]>();
  const nextTags = { ...pkg.tags };

  for (const tag of new Set(effectiveTags)) {
    const priorReleaseId = getPackageTagReleaseId(pkg, tag);
    nextTags[tag] = releaseId;
    if (priorReleaseId && priorReleaseId !== releaseId) {
      cleanupTagsByRelease.set(priorReleaseId, [
        ...(cleanupTagsByRelease.get(priorReleaseId) ?? []),
        tag,
      ]);
    }
  }

  return {
    nextTags,
    cleanupAssignments: [...cleanupTagsByRelease].map(([priorReleaseId, tags]) => ({
      releaseId: priorReleaseId,
      tags,
    })),
  };
}

export const discardPendingPackagePublicationInternal = internalMutation({
  args: {
    packageId: v.id("packages"),
    releaseId: v.id("packageReleases"),
    createdNewParent: v.optional(v.boolean()),
    reason: v.optional(v.string()),
    attemptId: v.optional(v.id("publishAttempts")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    deleted: boolean;
    parentDeleted?: boolean;
    retiredAttemptIds: Id<"publishAttempts">[];
  }> => {
    const release = await ctx.db.get(args.releaseId);
    if (
      release &&
      (release.packageId !== args.packageId || release.publicationStatus !== "pending")
    ) {
      return { deleted: false, retiredAttemptIds: [] };
    }

    const pkg = await ctx.db.get(args.packageId);
    const attempts: Doc<"publishAttempts">[] = [];
    if (args.attemptId) {
      const attempt = await ctx.db.get(args.attemptId);
      if (
        !attempt ||
        attempt.kind !== "package" ||
        attempt.packageId !== args.packageId ||
        attempt.packageReleaseId !== args.releaseId
      ) {
        throw new ConvexError("Publish attempt does not own the pending package release");
      }
      if (!ACTIVE_PUBLISH_ATTEMPT_STATUSES.some((status) => status === attempt.status)) {
        return { deleted: false, retiredAttemptIds: [] };
      }
      attempts.push(attempt);
    } else if (pkg) {
      for (const status of ACTIVE_PUBLISH_ATTEMPT_STATUSES) {
        // Bound large attempt reads; operators can call this mutation with attemptId for more.
        const matches = await ctx.db
          .query("publishAttempts")
          .withIndex("by_kind_status_slug_version_created", (q) => {
            const byName = q.eq("kind", "package").eq("status", status).eq("slug", pkg.name);
            return release ? byName.eq("version", release.version) : byName;
          })
          .take(200);
        attempts.push(...matches.filter((attempt) => attempt.packageReleaseId === args.releaseId));
      }
    }

    const storageIds = new Set<Id<"_storage">>();
    for (const file of release?.files ?? []) {
      if (typeof file.storageId === "string") {
        storageIds.add(file.storageId as Id<"_storage">);
      }
    }
    if (typeof release?.clawpackStorageId === "string") {
      storageIds.add(release.clawpackStorageId as Id<"_storage">);
    }

    if (release) await ctx.db.delete(release._id);
    await Promise.allSettled([...storageIds].map((storageId) => ctx.storage.delete(storageId)));

    // This reason is publisher-visible as `error` in the publish attempt status API.
    const error = args.reason ?? "Pending package release discarded";
    const now = Date.now();
    for (const attempt of attempts) {
      await ctx.db.patch(attempt._id, failedPublishAttemptPatch(attempt.status, error, now));
    }

    let parentDeleted = false;
    if (args.createdNewParent) {
      if (pkg && !pkg.latestReleaseId) {
        const remainingReleases = await ctx.db
          .query("packageReleases")
          .withIndex("by_package", (q) => q.eq("packageId", args.packageId))
          .take(1);
        if (remainingReleases.length === 0) {
          await ctx.db.delete(args.packageId);
          parentDeleted = true;
        }
      }
    }

    return {
      deleted: Boolean(release),
      parentDeleted,
      retiredAttemptIds: attempts.map((attempt) => attempt._id),
    };
  },
});

export const cleanupReassignedPackageReleaseTagsInternal = internalMutation({
  args: {
    packageId: v.id("packages"),
    assignments: v.array(
      v.object({
        releaseId: v.id("packageReleases"),
        tags: v.array(v.string()),
      }),
    ),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const offset = Math.max(0, Math.floor(args.offset ?? 0));
    const pkg = await ctx.db.get(args.packageId);
    if (!pkg) return { cleaned: 0, scheduled: false };

    const batch = args.assignments.slice(offset, offset + PACKAGE_RELEASE_TAG_CLEANUP_BATCH_SIZE);
    let cleaned = 0;
    for (const assignment of batch) {
      const tagsToRemove = assignment.tags.filter(
        (tag) => getPackageTagReleaseId(pkg, tag) !== assignment.releaseId,
      );
      if (tagsToRemove.length === 0) continue;

      const priorRelease = await ctx.db.get(assignment.releaseId);
      if (
        !priorRelease ||
        priorRelease.packageId !== pkg._id ||
        !isPublishedPackageRelease(priorRelease)
      ) {
        continue;
      }
      const tagsToRemoveSet = new Set(tagsToRemove);
      const nextDistTags = (priorRelease.distTags ?? []).filter((tag) => !tagsToRemoveSet.has(tag));
      if (nextDistTags.length === (priorRelease.distTags ?? []).length) continue;
      await ctx.db.patch(priorRelease._id, { distTags: nextDistTags });
      cleaned += 1;
    }

    const nextOffset = offset + batch.length;
    const scheduled = nextOffset < args.assignments.length;
    if (scheduled) {
      await runAfterRef(ctx, 0, internalRefs.packages.cleanupReassignedPackageReleaseTagsInternal, {
        packageId: args.packageId,
        assignments: args.assignments,
        offset: nextOffset,
      });
    }
    return { cleaned, scheduled };
  },
});

async function schedulePackageReleaseTagCleanup(
  ctx: Pick<MutationCtx, "scheduler">,
  packageId: Id<"packages">,
  assignments: PackageReleaseTagCleanupAssignment[],
) {
  if (assignments.length === 0) return;
  await runAfterRef(ctx, 0, internalRefs.packages.cleanupReassignedPackageReleaseTagsInternal, {
    packageId,
    assignments,
  });
}

export const publishPendingReleaseInternal = internalMutation({
  args: {
    releaseId: v.id("packageReleases"),
    trustedPublishTokenId: v.optional(v.id("packagePublishTokens")),
    trustedPublishInventoryDigest: v.optional(v.string()),
    trustedPublishAuthorizationVersion: v.optional(v.literal(2)),
    manualRecoveryAttemptId: v.optional(v.id("publishAttempts")),
    manualRecoveryClaimId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const release = await ctx.db.get(args.releaseId);
    if (!release || release.softDeletedAt) {
      throw new ConvexError("Pending package release not found");
    }
    if (release.publicationStatus === undefined || release.publicationStatus === "published") {
      return {
        ok: true as const,
        packageId: release.packageId,
        releaseId: release._id,
      };
    }
    if (release.publicationStatus !== "pending") {
      throw new ConvexError(`Package release is ${release.publicationStatus}, not pending.`);
    }

    const pkg = await ctx.db.get(release.packageId);
    if (!pkg || pkg.softDeletedAt || pkg.family === "skill") {
      throw new ConvexError("Package not found");
    }

    const metadata = pendingPackagePublicationMetadata(release);
    const manualRecovery =
      manualPackageRecovery(metadata) || args.manualRecoveryAttemptId
        ? await assertManualRecoveryFinalization(
            ctx,
            pkg,
            release,
            args.manualRecoveryAttemptId,
            args.manualRecoveryClaimId,
          )
        : undefined;
    // The pending row and finalizer must present the same v2 binding. Recheck
    // mutable revocation and publisher state in the transaction that goes public.
    if (
      metadata.trustedPublishAuthorizationVersion !== undefined ||
      args.trustedPublishAuthorizationVersion !== undefined
    ) {
      if (
        metadata.trustedPublishAuthorizationVersion !== 2 ||
        typeof metadata.trustedPublishTokenId !== "string" ||
        typeof metadata.trustedPublishInventoryDigest !== "string" ||
        args.trustedPublishAuthorizationVersion !== 2 ||
        args.trustedPublishTokenId !== metadata.trustedPublishTokenId ||
        args.trustedPublishInventoryDigest !== metadata.trustedPublishInventoryDigest
      ) {
        throw new ConvexError(
          "Staged OpenClaw publish authorization no longer matches the release",
        );
      }
      const token = await ctx.db.get(args.trustedPublishTokenId);
      if (
        !token ||
        token.repository !== "openclaw/openclaw" ||
        token.authorizationVersion !== 2 ||
        (token.scope ?? "publish") !== "publish" ||
        !token.consumedAt ||
        token.revokedAt ||
        token.packageId !== release.packageId ||
        token.version !== release.version ||
        !token.inventoryDigest ||
        token.inventoryDigest !== metadata.trustedPublishInventoryDigest
      ) {
        throw new ConvexError(
          "Staged OpenClaw publish authorization no longer matches the release",
        );
      }
      const trustedPublisher = await ctx.db
        .query("packageTrustedPublishers")
        .withIndex("by_package", (q) => q.eq("packageId", token.packageId))
        .unique();
      if (!doesTrustedPublisherMatchPublishToken(trustedPublisher, token)) {
        throw new ConvexError(
          "Trusted publish authorization no longer matches the current trusted publisher",
        );
      }
    }

    const now = Date.now();
    const firstPublishedRelease = hasNoPublishedPackageVersions(pkg);
    const pendingFamily = stringPendingField(metadata, "family", pkg.family) as PackageFamily;
    const packageFamily = firstPublishedRelease ? pendingFamily : pkg.family;
    const currentLatest = await resolvePackageCurrentLatestForPublish(ctx, pkg);
    const { effectiveTags, shouldPromoteLatest } = resolvePackageReleaseTagsForPublish({
      family: packageFamily,
      currentLatestExists: currentLatest.exists,
      currentLatestVersion: currentLatest.version,
      candidateVersion: release.version,
      requestedTags: stringArrayPendingField(metadata, "tags") ?? release.distTags ?? [],
    });
    // Staging does not freeze ownership or administrative identity repairs.
    // Recheck the effective claim in the transaction that makes it public.
    if (packageFamily === "code-plugin") {
      await assertPackageRuntimeIdAvailable(ctx, {
        ...pkg,
        runtimeId: release.runtimeId,
      });
    }
    const scanStatus = resolvePackageReleaseScanStatus(release);
    const releaseVerification = release.verification
      ? { ...release.verification, scanStatus }
      : release.verification;
    const publishedRelease = {
      ...release,
      publicationStatus: "published" as const,
      pendingPublication: undefined,
      distTags: effectiveTags,
      verification: releaseVerification,
    } as Doc<"packageReleases">;

    const { nextTags, cleanupAssignments } = planPackageReleaseTagReassignment(
      pkg,
      release._id,
      effectiveTags,
    );

    await ctx.db.patch(release._id, {
      publicationStatus: "published",
      pendingPublication: undefined,
      distTags: effectiveTags,
      verification: releaseVerification,
      ...(manualRecovery
        ? { publishActor: { kind: "user" as const, userId: manualRecovery.actorUserId } }
        : {}),
    });

    await ctx.db.patch(pkg._id, {
      displayName: stringPendingField(metadata, "displayName", pkg.displayName),
      ownerUserId: pkg.ownerUserId,
      ownerPublisherId: pkg.ownerPublisherId,
      family: packageFamily,
      clawProfilePolicyVersion:
        firstPublishedRelease && packageFamily === "claw"
          ? CURRENT_OPENCLAW_PROFILE_POLICY_VERSION
          : pkg.clawProfilePolicyVersion,
      summary: shouldPromoteLatest ? release.summary : pkg.summary,
      icon: shouldPromoteLatest ? release.icon : pkg.icon,
      categories: shouldPromoteLatest
        ? stringArrayPendingField(metadata, "categories")
        : pkg.categories,
      topics: shouldPromoteLatest ? stringArrayPendingField(metadata, "topics") : pkg.topics,
      ...(shouldPromoteLatest
        ? {
            inferredCategories: undefined,
            inferredTopics: undefined,
            inferredFromReleaseId: undefined,
            inferredCategoryConfidence: undefined,
            inferredTopicConfidence: undefined,
            inferredClassifierVersion: undefined,
            inferredTopicClassifierVersion: undefined,
            inferredInputHash: undefined,
            inferredTopicInputHash: undefined,
            inferredAt: undefined,
          }
        : {}),
      sourceRepo: stringPendingField(metadata, "sourceRepo", release.sourceRepo),
      runtimeId: shouldPromoteLatest ? release.runtimeId : pkg.runtimeId,
      channel: stringPendingField(metadata, "channel", pkg.channel) as Doc<"packages">["channel"],
      isOfficial: booleanPendingField(metadata, "isOfficial", pkg.isOfficial),
      latestReleaseId: shouldPromoteLatest ? release._id : pkg.latestReleaseId,
      latestVersionSummary: shouldPromoteLatest
        ? packageLatestSummaryFromRelease(publishedRelease)
        : pkg.latestVersionSummary,
      tags: nextTags,
      compatibility: shouldPromoteLatest ? release.compatibility : pkg.compatibility,
      verification: shouldPromoteLatest ? releaseVerification : pkg.verification,
      scanStatus: shouldPromoteLatest ? scanStatus : pkg.scanStatus,
      stats: { ...pkg.stats, versions: (pkg.stats?.versions ?? 0) + 1 },
      updatedAt: now,
    });
    await schedulePackageReleaseTagCleanup(ctx, pkg._id, cleanupAssignments);

    return {
      ok: true as const,
      packageId: pkg._id,
      releaseId: release._id,
    };
  },
});

export const insertReleaseInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    ownerUserId: v.id("users"),
    ownerPublisherId: v.optional(v.id("publishers")),
    publishActor: v.optional(
      v.union(
        v.object({
          kind: v.literal("user"),
          userId: v.id("users"),
        }),
        v.object({
          kind: v.literal("github-actions"),
          repository: v.string(),
          workflow: v.string(),
          runId: v.string(),
          runAttempt: v.string(),
          sha: v.string(),
        }),
      ),
    ),
    name: v.string(),
    displayName: v.string(),
    family: v.union(
      v.literal("skill"),
      v.literal("code-plugin"),
      v.literal("bundle-plugin"),
      v.literal("claw"),
    ),
    version: v.string(),
    publicationStatus: v.optional(v.union(v.literal("pending"), v.literal("published"))),
    changelog: v.string(),
    icon: v.optional(v.string()),
    tags: v.array(v.string()),
    summary: v.string(),
    categories: v.optional(v.array(v.string())),
    topics: v.optional(v.array(v.string())),
    sourceRepo: v.optional(v.string()),
    runtimeId: v.optional(v.string()),
    channel: v.optional(
      v.union(v.literal("official"), v.literal("community"), v.literal("private")),
    ),
    compatibility: v.optional(v.any()),
    verification: v.optional(v.any()),
    staticScan: v.optional(v.any()),
    llmAnalysis: v.optional(v.any()),
    allowExistingRelease: v.optional(v.boolean()),
    files: v.array(
      v.object({
        path: v.string(),
        size: v.number(),
        storageId: v.id("_storage"),
        sha256: v.string(),
        contentType: v.optional(v.string()),
      }),
    ),
    integritySha256: v.string(),
    sha256hash: v.string(),
    artifactKind: v.optional(v.union(v.literal("legacy-zip"), v.literal("npm-pack"))),
    clawpackStorageId: v.optional(v.id("_storage")),
    clawpackSha256: v.optional(v.string()),
    clawpackSize: v.optional(v.number()),
    clawpackFormat: v.optional(v.literal("tgz")),
    npmIntegrity: v.optional(v.string()),
    npmShasum: v.optional(v.string()),
    npmTarballName: v.optional(v.string()),
    npmUnpackedSize: v.optional(v.number()),
    npmFileCount: v.optional(v.number()),
    extractedPackageJson: v.optional(v.any()),
    extractedPluginManifest: v.optional(v.any()),
    normalizedBundleManifest: v.optional(v.any()),
    pluginManifestSummary: v.optional(v.any()),
    clawManifestSummary: v.optional(v.any()),
    source: v.optional(v.any()),
    trustedPublishTokenId: v.optional(v.id("packagePublishTokens")),
    trustedPublishInventoryDigest: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.family === "claw" && !experimentalClawsEnabled()) {
      throw new ConvexError("Experimental Claw publication is disabled");
    }
    const now = Date.now();
    const publicationStatus = args.publicationStatus ?? "published";
    const pendingPublication = publicationStatus === "pending";
    const prePublicationScanStatus = args.llmAnalysis
      ? normalizePackageScanStatus(args.llmAnalysis.verdict ?? args.llmAnalysis.status)
      : undefined;
    const releaseVerification =
      args.verification && prePublicationScanStatus
        ? { ...args.verification, scanStatus: prePublicationScanStatus }
        : args.verification;
    const normalizedName = normalizePackageName(args.name);
    let trustedPublishAuthorizationVersion: 2 | undefined;
    if (args.trustedPublishTokenId) {
      const token = await ctx.db.get(args.trustedPublishTokenId);
      if (
        !token ||
        token.revokedAt ||
        token.consumedAt ||
        token.expiresAt <= now ||
        (token.scope ?? "publish") !== "publish"
      ) {
        throw new ConvexError("Trusted publish authorization is missing, expired, or consumed");
      }
      if (
        token.version !== args.version ||
        (token.inventoryDigest !== undefined &&
          (!args.trustedPublishInventoryDigest ||
            token.inventoryDigest !== args.trustedPublishInventoryDigest))
      ) {
        throw new ConvexError(
          "Trusted publish authorization does not match this package transaction",
        );
      }
      assertOpenClawPublishAuthorizationVersion(token);
      const tokenPackage = await ctx.db.get(token.packageId);
      if (
        !tokenPackage ||
        tokenPackage.normalizedName !== normalizedName ||
        tokenPackage.softDeletedAt
      ) {
        throw new ConvexError("Trusted publish authorization package no longer matches");
      }
      const trustedPublisher = await ctx.db
        .query("packageTrustedPublishers")
        .withIndex("by_package", (q) => q.eq("packageId", token.packageId))
        .unique();
      if (!doesTrustedPublisherMatchPublishToken(trustedPublisher, token)) {
        throw new ConvexError(
          "Trusted publish authorization no longer matches the current trusted publisher",
        );
      }
      // Consuming inside this mutation makes replay impossible: any later failure
      // rolls this patch back with the release insert.
      await ctx.db.patch(token._id, { consumedAt: now });
      trustedPublishAuthorizationVersion = token.authorizationVersion;
    } else if (args.trustedPublishInventoryDigest) {
      throw new ConvexError("Trusted publish inventory requires a publish token");
    }
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
    const owner = await ctx.db.get(args.ownerUserId);
    if (!owner || owner.deletedAt || owner.deactivatedAt) {
      throw new ConvexError("Package owner is unavailable");
    }
    const ownerPublisher = args.ownerPublisherId ? await ctx.db.get(args.ownerPublisherId) : null;
    if (
      args.ownerPublisherId &&
      (!ownerPublisher || ownerPublisher.deletedAt || ownerPublisher.deactivatedAt)
    ) {
      throw new ConvexError("Package owner publisher is unavailable");
    }
    if (ownerPublisher?.kind === "user" && ownerPublisher.linkedUserId) {
      const linkedPublisherUser = await ctx.db.get(ownerPublisher.linkedUserId);
      if (
        !linkedPublisherUser ||
        linkedPublisherUser.deletedAt ||
        linkedPublisherUser.deactivatedAt
      ) {
        throw new ConvexError("Package owner publisher is unavailable");
      }
    }
    if (args.publishActor?.kind === "user" && args.publishActor.userId !== args.actorUserId) {
      throw new ConvexError("Publish actor must match the authenticated actor");
    }
    if (args.publishActor?.kind === "user" && ownerPublisher?.kind === "org") {
      const membership = await getPublisherMembership(
        ctx,
        ownerPublisher._id,
        args.publishActor.userId,
      );
      if (!membership || !isPublisherRoleAllowed(membership.role, ["publisher"])) {
        throw new ConvexError(
          `You do not have publish access for "@${ownerPublisher.handle}". Ask an owner or admin to add you before publishing this package.`,
        );
      }
    }
    if (args.ownerUserId !== args.actorUserId) {
      assertAdmin(actor);
    }
    const officialPublisher = await getOwnerPublisher(ctx, {
      ownerPublisherId: args.ownerPublisherId,
      ownerUserId: args.ownerUserId,
    });
    const publisherOfficial = await isOfficialPublisher(ctx, officialPublisher);
    if (args.channel === "official" && !publisherOfficial) {
      throw new ConvexError("Only official publishers may publish to the official channel");
    }
    const existing = await getPackageByNormalizedName(ctx, normalizedName);
    const existingIsReservation = isReservedPackagePlaceholder(existing);
    const nextNameLabel = typeof args.name === "string" ? args.name : "<unknown>";
    if (existing?.softDeletedAt) {
      throw new ConvexError(
        `Package "${nextNameLabel}" was deleted. Restore it before publishing another release or choose a new package name.`,
      );
    }
    const nextChannel = derivePackagePublisherChannel({
      requestedChannel: args.channel,
      currentChannel: existing?.channel,
      currentIsReservation: existingIsReservation,
      publisherOfficial,
    });
    const nextIsOfficial = nextChannel === "official";
    const nextVersionLabel = typeof args.version === "string" ? args.version : "<unknown>";
    if (existing) {
      const existingOwnerKey = getPackageOwnerKey(existing, {
        nextOwnerPublisherId: args.ownerPublisherId,
        ownerPublisher,
      });
      const nextOwnerKey = getRequestedPackageOwnerKey({
        ownerUserId: args.ownerUserId,
        ownerPublisherId: args.ownerPublisherId,
      });
      if (existingOwnerKey !== nextOwnerKey) {
        throw new ConvexError("Package already exists and belongs to another publisher");
      }
    }
    if (existing && existing.family !== args.family && !existingIsReservation) {
      throw new ConvexError(
        `Package "${nextNameLabel}" already exists as a ${existing.family}; family changes are not allowed`,
      );
    }
    if (
      existing &&
      existing.family === "code-plugin" &&
      existing.runtimeId &&
      args.runtimeId &&
      existing.runtimeId !== args.runtimeId
    ) {
      throw new ConvexError(
        `Package "${nextNameLabel}" already exists with plugin id "${existing.runtimeId}"; runtime id changes are not allowed`,
      );
    }
    if (args.family === "code-plugin" && args.runtimeId) {
      await assertPackageRuntimeIdAvailable(ctx, {
        _id: existing?._id,
        ownerUserId: args.ownerUserId,
        ownerPublisherId: args.ownerPublisherId ?? existing?.ownerPublisherId,
        runtimeId: args.runtimeId,
      });
    }

    const createdNewParent = !existing;
    const pkgId =
      existing?._id ??
      (await ctx.db.insert("packages", {
        name: args.name,
        normalizedName,
        displayName: args.displayName,
        summary: args.summary,
        icon: args.icon,
        ownerUserId: args.ownerUserId,
        ownerPublisherId: args.ownerPublisherId,
        family: args.family,
        clawProfilePolicyVersion:
          args.family === "claw" ? CURRENT_OPENCLAW_PROFILE_POLICY_VERSION : undefined,
        channel: nextChannel,
        isOfficial: nextIsOfficial,
        runtimeId: args.runtimeId,
        sourceRepo: args.sourceRepo,
        categories: args.categories,
        topics: args.topics,
        tags: {},
        compatibility: args.compatibility,
        verification: releaseVerification,
        scanStatus: releaseVerification?.scanStatus,
        stats: { downloads: 0, installs: 0, stars: 0, versions: 0 },
        ...computePackageRecommendationPatch(
          {
            downloads: 0,
            installs: 0,
            stars: 0,
            versions: 0,
          },
          {
            createdAt: now,
            updatedAt: now,
            now,
          },
        ),
        createdAt: now,
        updatedAt: now,
      }));

    if (existing) {
      const releaseExists = await ctx.db
        .query("packageReleases")
        .withIndex("by_package_version", (q) =>
          q.eq("packageId", existing._id).eq("version", args.version),
        )
        .unique();
      if (releaseExists) {
        const matchesExactClawArtifact =
          args.family !== "claw" ||
          (typeof args.clawpackSha256 === "string" &&
            releaseExists.clawpackSha256 === args.clawpackSha256);
        const matchesExistingOwner =
          args.ownerPublisherId !== undefined
            ? existing.ownerPublisherId === args.ownerPublisherId
            : existing.ownerPublisherId === undefined && existing.ownerUserId === args.ownerUserId;
        const allowExactClawRetry =
          args.family === "claw" && matchesExistingOwner && matchesExactClawArtifact;
        const canReuseExistingRelease =
          args.allowExistingRelease ||
          (allowExactClawRetry &&
            isPublishedPackageRelease(releaseExists) &&
            releaseExists.manualModeration?.state !== "quarantined" &&
            releaseExists.manualModeration?.state !== "revoked" &&
            resolvePackageReleaseScanStatus(releaseExists) !== "malicious");
        if (
          canReuseExistingRelease &&
          !releaseExists.softDeletedAt &&
          releaseExists.integritySha256 === args.integritySha256 &&
          matchesExactClawArtifact
        ) {
          return {
            ok: true as const,
            packageId: existing._id,
            releaseId: releaseExists._id,
          };
        }
        throw new ConvexError(
          `Version ${nextVersionLabel} already exists. Increment the version number and try again.`,
        );
      }
    }
    const currentLatest = existing
      ? await resolvePackageCurrentLatestForPublish(ctx, existing)
      : { exists: false, version: undefined };
    const { effectiveTags, shouldPromoteLatest } = resolvePackageReleaseTagsForPublish({
      family: args.family,
      currentLatestExists: currentLatest.exists,
      currentLatestVersion: currentLatest.version,
      candidateVersion: args.version,
      requestedTags: args.tags,
    });

    const releaseId = await ctx.db.insert("packageReleases", {
      packageId: pkgId,
      version: args.version,
      publicationStatus,
      pendingPublication: pendingPublication
        ? {
            displayName: args.displayName,
            ownerUserId: args.ownerUserId,
            ownerPublisherId: args.ownerPublisherId,
            family: args.family,
            summary: args.summary,
            icon: args.icon,
            categories: args.categories,
            topics: args.topics,
            sourceRepo: args.sourceRepo,
            runtimeId: args.runtimeId,
            channel: nextChannel,
            isOfficial: nextIsOfficial,
            tags: effectiveTags,
            trustedPublishTokenId:
              trustedPublishAuthorizationVersion === 2 ? args.trustedPublishTokenId : undefined,
            trustedPublishInventoryDigest:
              trustedPublishAuthorizationVersion === 2
                ? args.trustedPublishInventoryDigest
                : undefined,
            trustedPublishAuthorizationVersion,
          }
        : undefined,
      changelog: args.changelog,
      summary: args.summary,
      icon: args.icon,
      distTags: effectiveTags,
      files: args.files,
      integritySha256: args.integritySha256,
      sha256hash: args.sha256hash,
      artifactKind: args.artifactKind,
      clawpackStorageId: args.clawpackStorageId,
      clawpackSha256: args.clawpackSha256,
      clawpackSize: args.clawpackSize,
      clawpackFormat: args.clawpackFormat,
      npmIntegrity: args.npmIntegrity,
      npmShasum: args.npmShasum,
      npmTarballName: args.npmTarballName,
      npmUnpackedSize: args.npmUnpackedSize,
      npmFileCount: args.npmFileCount,
      extractedPackageJson: args.extractedPackageJson,
      extractedPluginManifest: args.extractedPluginManifest,
      normalizedBundleManifest: args.normalizedBundleManifest,
      pluginManifestSummary: args.pluginManifestSummary,
      clawManifestSummary: args.clawManifestSummary,
      compatibility: args.compatibility,
      runtimeId: args.runtimeId,
      sourceRepo: args.sourceRepo,
      verification: releaseVerification,
      staticScan: args.staticScan,
      llmAnalysis: args.llmAnalysis,
      source: args.source,
      createdBy: args.actorUserId,
      publishActor: args.publishActor,
      createdAt: now,
    });

    const pkg = existing ?? (await ctx.db.get(pkgId));
    if (!pkg) throw new ConvexError("Package insert failed");
    if (pendingPublication) {
      return {
        ok: true as const,
        packageId: pkgId,
        releaseId,
        publicationStatus,
        createdNewParent,
      };
    }

    const { nextTags, cleanupAssignments } = planPackageReleaseTagReassignment(
      pkg,
      releaseId,
      effectiveTags,
    );

    await ctx.db.patch(pkgId, {
      displayName: args.displayName,
      ownerUserId: args.ownerUserId,
      ownerPublisherId: args.ownerPublisherId ?? pkg.ownerPublisherId,
      family: existingIsReservation ? args.family : pkg.family,
      clawProfilePolicyVersion:
        existingIsReservation && args.family === "claw"
          ? CURRENT_OPENCLAW_PROFILE_POLICY_VERSION
          : pkg.clawProfilePolicyVersion,
      summary: shouldPromoteLatest ? args.summary : pkg.summary,
      icon: shouldPromoteLatest ? args.icon : pkg.icon,
      categories: shouldPromoteLatest ? args.categories : pkg.categories,
      topics: shouldPromoteLatest ? args.topics : pkg.topics,
      ...(shouldPromoteLatest
        ? {
            inferredCategories: undefined,
            inferredTopics: undefined,
            inferredFromReleaseId: undefined,
            inferredCategoryConfidence: undefined,
            inferredTopicConfidence: undefined,
            inferredClassifierVersion: undefined,
            inferredTopicClassifierVersion: undefined,
            inferredInputHash: undefined,
            inferredTopicInputHash: undefined,
            inferredAt: undefined,
          }
        : {}),
      sourceRepo: args.sourceRepo,
      runtimeId: shouldPromoteLatest ? args.runtimeId : pkg.runtimeId,
      channel: nextChannel,
      isOfficial: nextIsOfficial,
      latestReleaseId: shouldPromoteLatest ? releaseId : pkg.latestReleaseId,
      latestVersionSummary: shouldPromoteLatest
        ? {
            version: args.version,
            createdAt: now,
            changelog: args.changelog,
            icon: args.icon,
            compatibility: args.compatibility,
            verification: releaseVerification,
            artifact: packageArtifactSummary(args),
          }
        : pkg.latestVersionSummary,
      tags: nextTags,
      compatibility: shouldPromoteLatest ? args.compatibility : pkg.compatibility,
      verification: shouldPromoteLatest ? releaseVerification : pkg.verification,
      scanStatus: shouldPromoteLatest ? releaseVerification?.scanStatus : pkg.scanStatus,
      stats: { ...pkg.stats, versions: (pkg.stats?.versions ?? 0) + 1 },
      updatedAt: now,
    });
    await schedulePackageReleaseTagCleanup(ctx, pkgId, cleanupAssignments);

    return {
      ok: true as const,
      packageId: pkgId,
      releaseId,
    };
  },
});
function isReleaseActive(
  release: Doc<"packageReleases"> | null | undefined,
): release is Doc<"packageReleases"> {
  return Boolean(release && !release.softDeletedAt);
}

async function recordMaliciousPluginReleaseFinding(
  ctx: Pick<MutationCtx, "scheduler">,
  pkg: Doc<"packages">,
  release: Doc<"packageReleases">,
  trigger: string,
) {
  const artifactSha256 = getPackageReleaseArtifactSha256(release);
  await ctx.scheduler.runAfter(0, internal.users.recordMaliciousArtifactFindingInternal, {
    ownerUserId: release.createdBy,
    artifactKind: "plugin",
    artifactName: pkg.normalizedName,
    version: release.version,
    trigger,
    ...(release.llmAnalysis?.summary ? { findingSummary: release.llmAnalysis.summary } : {}),
    ...(artifactSha256 ? { sha256hash: artifactSha256 } : {}),
  });
}

async function quarantineMaliciousNonLatestPackageRelease(
  ctx: Pick<MutationCtx, "db"> & Partial<Pick<MutationCtx, "scheduler">>,
  pkg: Doc<"packages">,
  release: Doc<"packageReleases">,
  trigger: string,
) {
  const now = Date.now();
  const maliciousVerification = release.verification
    ? { ...release.verification, scanStatus: "malicious" as const }
    : release.verification;
  await ctx.db.patch(release._id, {
    verification: maliciousVerification,
    softDeletedAt: now,
  });

  const nextTags = Object.fromEntries(
    Object.entries(pkg.tags ?? {}).filter(([, releaseId]) => releaseId !== release._id),
  ) as Doc<"packages">["tags"];
  if (Object.keys(nextTags).length !== Object.keys(pkg.tags ?? {}).length) {
    const packagePatch: Partial<Doc<"packages">> = {
      tags: nextTags,
      updatedAt: now,
    };
    const nextPackage: Doc<"packages"> = { ...pkg, ...packagePatch };
    await ctx.db.patch(pkg._id, packagePatch);
    const owner = await getOwnerPublisher(ctx, {
      ownerPublisherId: pkg.ownerPublisherId,
      ownerUserId: pkg.ownerUserId,
    });
    await upsertPackageSearchDigest(ctx, {
      ...extractPackageDigestFields(nextPackage),
      ownerHandle: owner?.handle ?? "",
      ownerKind: owner?.kind,
    });
  }

  if (ctx.scheduler) {
    await recordMaliciousPluginReleaseFinding(
      ctx as Pick<MutationCtx, "scheduler">,
      pkg,
      release,
      trigger,
    );
  }
}

async function quarantineMaliciousLatestPackageRelease(
  ctx: Pick<MutationCtx, "db"> & Partial<Pick<MutationCtx, "scheduler">>,
  pkg: Doc<"packages">,
  release: Doc<"packageReleases">,
  trigger: string,
) {
  const now = Date.now();
  const maliciousVerification = release.verification
    ? { ...release.verification, scanStatus: "malicious" as const }
    : release.verification;
  const quarantinedRelease = {
    ...release,
    verification: maliciousVerification,
    softDeletedAt: now,
  } as Doc<"packageReleases">;

  await ctx.db.patch(release._id, {
    verification: maliciousVerification,
    softDeletedAt: now,
  });

  const releases = await ctx.db
    .query("packageReleases")
    .withIndex("by_package", (q) => q.eq("packageId", pkg._id))
    .collect();
  const activeNonMaliciousReleases = releases
    .map((candidate) => (candidate._id === release._id ? quarantinedRelease : candidate))
    .filter(
      (candidate) =>
        !candidate.softDeletedAt &&
        resolvePackageReleaseScanStatus(candidate) !== "malicious" &&
        // Administrative identity repairs do not rewrite historical artifacts. Never promote an
        // incompatible historical id, but always commit quarantine of the malicious release.
        (pkg.family !== "code-plugin" || !pkg.runtimeId || candidate.runtimeId === pkg.runtimeId),
    );
  const nextLatest = getPreferredRestoredPackageRelease(pkg.family, activeNonMaliciousReleases);
  const nextTags = rebuildPackageTagsFromActiveReleases(activeNonMaliciousReleases);
  if (nextLatest) {
    nextTags.latest = nextLatest._id;
    if (!(nextLatest.distTags ?? []).includes("latest")) {
      await ctx.db.patch(nextLatest._id, {
        distTags: [...(nextLatest.distTags ?? []), "latest"],
      });
    }
  }

  const restoredRuntimeId = packageRuntimeIdFromRelease(nextLatest);
  const restoredSourceRepo = packageSourceRepoFromRelease(nextLatest);
  const packagePatch: Partial<Doc<"packages">> = {
    tags: nextTags,
    latestReleaseId: nextLatest?._id,
    latestVersionSummary: packageLatestSummaryFromRelease(nextLatest),
    summary: nextLatest?.summary,
    icon: nextLatest?.icon,
    sourceRepo: restoredSourceRepo,
    runtimeId:
      pkg.family === "code-plugin" ? (pkg.runtimeId ?? restoredRuntimeId) : restoredRuntimeId,
    compatibility: nextLatest?.compatibility,
    verification: nextLatest?.verification,
    scanStatus: nextLatest ? resolvePackageReleaseScanStatus(nextLatest) : "malicious",
    updatedAt: now,
  };
  const nextPackage: Doc<"packages"> = { ...pkg, ...packagePatch };
  await ctx.db.patch(pkg._id, packagePatch);
  const owner = await getOwnerPublisher(ctx, {
    ownerPublisherId: pkg.ownerPublisherId,
    ownerUserId: pkg.ownerUserId,
  });
  await upsertPackageSearchDigest(ctx, {
    ...extractPackageDigestFields(nextPackage),
    ownerHandle: owner?.handle ?? "",
    ownerKind: owner?.kind,
  });

  if (ctx.scheduler) {
    await recordMaliciousPluginReleaseFinding(
      ctx as Pick<MutationCtx, "scheduler">,
      pkg,
      release,
      trigger,
    );
  }
}

type SyncLatestPackageVerificationOptions = {
  quarantineMaliciousLatest?: boolean;
  maliciousTrigger?: string;
};

async function syncLatestPackageVerification(
  ctx: Pick<MutationCtx, "db"> & Partial<Pick<MutationCtx, "scheduler">>,
  release: Doc<"packageReleases">,
  options: SyncLatestPackageVerificationOptions = {},
) {
  const pkg = await ctx.db.get(release.packageId);
  const scanStatus = resolvePackageReleaseScanStatus(release);
  if (!pkg) return;

  if (scanStatus === "malicious" && options.quarantineMaliciousLatest) {
    if (pkg.latestReleaseId !== release._id) {
      await quarantineMaliciousNonLatestPackageRelease(
        ctx,
        pkg,
        release,
        options.maliciousTrigger ?? "malicious.llm_malicious",
      );
      return;
    }
    await quarantineMaliciousLatestPackageRelease(
      ctx,
      pkg,
      release,
      options.maliciousTrigger ?? "malicious.llm_malicious",
    );
    return;
  }

  if (pkg.latestReleaseId !== release._id) return;

  const nextVerification = pkg.verification
    ? {
        ...pkg.verification,
        scanStatus,
      }
    : pkg.latestVersionSummary?.verification
      ? {
          ...pkg.latestVersionSummary.verification,
          scanStatus,
        }
      : undefined;
  const nextLatestVersionSummary = pkg.latestVersionSummary
    ? {
        ...pkg.latestVersionSummary,
        verification: nextVerification,
      }
    : pkg.latestVersionSummary;
  const nextPackage: Doc<"packages"> = {
    ...pkg,
    verification: nextVerification,
    scanStatus,
    latestVersionSummary: nextLatestVersionSummary,
  };

  await ctx.db.patch(pkg._id, {
    verification: nextVerification,
    scanStatus,
    latestVersionSummary: nextLatestVersionSummary,
  });
  const owner = await getOwnerPublisher(ctx, {
    ownerPublisherId: pkg.ownerPublisherId,
    ownerUserId: pkg.ownerUserId,
  });
  await upsertPackageSearchDigest(ctx, {
    ...extractPackageDigestFields(nextPackage),
    ownerHandle: owner?.handle ?? "",
    ownerKind: owner?.kind,
  });
}

export const updateReleaseScanResultsInternal = internalMutation({
  args: {
    releaseId: v.id("packageReleases"),
    vtAnalysis: v.optional(vtAnalysisValidator),
  },
  handler: async (ctx, args) => {
    const release = await ctx.db.get(args.releaseId);
    if (!release || release.softDeletedAt) return;

    const patch: Partial<Doc<"packageReleases">> = {};
    if (args.vtAnalysis !== undefined) {
      patch.vtAnalysis = args.vtAnalysis;
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.releaseId, patch);
    }
  },
});

export const updateReleaseSkillSpectorAnalysisInternal = internalMutation({
  args: {
    releaseId: v.id("packageReleases"),
    skillSpectorAnalysis: v.optional(skillSpectorAnalysisValidator),
  },
  handler: async (ctx, args) => {
    const release = await ctx.db.get(args.releaseId);
    if (!isReleaseActive(release)) return;
    await ctx.db.patch(args.releaseId, {
      skillSpectorAnalysis: args.skillSpectorAnalysis,
    });
  },
});

export const updateReleaseAigAnalysisInternal = internalMutation({
  args: {
    releaseId: v.id("packageReleases"),
    aigAnalysis: v.optional(aigAnalysisValidator),
  },
  handler: async (ctx, args) => {
    const release = await ctx.db.get(args.releaseId);
    if (!isReleaseActive(release)) return;
    await ctx.db.patch(args.releaseId, {
      aigAnalysis: args.aigAnalysis,
    });
  },
});

export const updateReleaseLlmAnalysisInternal = internalMutation({
  args: {
    releaseId: v.id("packageReleases"),
    llmAnalysis: v.object({
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
      agenticRiskFindings: v.optional(v.array(llmAgenticRiskFindingValidator)),
      riskSummary: v.optional(
        v.object({
          abnormal_behavior_control: llmRiskSummaryBucketValidator,
          permission_boundary: llmRiskSummaryBucketValidator,
          sensitive_data_protection: llmRiskSummaryBucketValidator,
        }),
      ),
      model: v.optional(v.string()),
      checkedAt: v.number(),
    }),
  },
  handler: async (ctx, args) => {
    const release = await ctx.db.get(args.releaseId);
    if (!isReleaseActive(release)) return;
    await ctx.db.patch(args.releaseId, { llmAnalysis: args.llmAnalysis });
    const updatedRelease = {
      ...release,
      llmAnalysis: args.llmAnalysis,
    } as Doc<"packageReleases">;
    const llmVerdict = (args.llmAnalysis.verdict ?? args.llmAnalysis.status).trim().toLowerCase();
    await syncLatestPackageVerification(ctx, updatedRelease, {
      quarantineMaliciousLatest: llmVerdict === "malicious",
      maliciousTrigger: "malicious.llm_malicious",
    });
  },
});

export const backfillLatestPackageScanStatusInternal = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = Math.max(10, Math.min(args.batchSize ?? 100, 200));
    const { page, continueCursor, isDone } = await ctx.db
      .query("packages")
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let patched = 0;
    for (const pkg of page) {
      if (!pkg.latestReleaseId) continue;
      const release = await ctx.db.get(pkg.latestReleaseId);
      if (!isReleaseActive(release)) continue;

      const scanStatus = resolvePackageReleaseScanStatus(release);
      const releaseVerification = release.verification
        ? { ...release.verification, scanStatus }
        : release.verification;
      if (release.verification?.scanStatus !== releaseVerification?.scanStatus) {
        await ctx.db.patch(release._id, { verification: releaseVerification });
      }

      const nextVerification = pkg.verification
        ? { ...pkg.verification, scanStatus }
        : pkg.latestVersionSummary?.verification
          ? { ...pkg.latestVersionSummary.verification, scanStatus }
          : undefined;
      const nextLatestVersionSummary = pkg.latestVersionSummary
        ? {
            ...pkg.latestVersionSummary,
            verification: nextVerification,
          }
        : pkg.latestVersionSummary;
      const nextPackage: Doc<"packages"> = {
        ...pkg,
        verification: nextVerification,
        scanStatus,
        latestVersionSummary: nextLatestVersionSummary,
      };

      if (
        pkg.scanStatus !== scanStatus ||
        pkg.verification?.scanStatus !== nextVerification?.scanStatus ||
        pkg.latestVersionSummary?.verification?.scanStatus !==
          nextLatestVersionSummary?.verification?.scanStatus
      ) {
        await ctx.db.patch(pkg._id, {
          verification: nextVerification,
          scanStatus,
          latestVersionSummary: nextLatestVersionSummary,
        });
        patched++;
      }
      const owner = await getOwnerPublisher(ctx, {
        ownerPublisherId: pkg.ownerPublisherId,
        ownerUserId: pkg.ownerUserId,
      });
      await upsertPackageSearchDigest(ctx, {
        ...extractPackageDigestFields(nextPackage),
        ownerHandle: owner?.handle ?? "",
        ownerKind: owner?.kind,
      });
    }

    if (!isDone) {
      await ctx.scheduler.runAfter(0, internal.packages.backfillLatestPackageScanStatusInternal, {
        cursor: continueCursor,
        batchSize: args.batchSize,
      });
    }

    return { patched, isDone, scanned: page.length };
  },
});

export const backfillLatestPackageScanStatus = action({
  args: {
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await runMutationRef(
      ctx,
      internalRefs.packages.backfillLatestPackageScanStatusInternal,
      {
        batchSize: args.batchSize,
      },
    );
  },
});

export const normalizeOfficialPublisherPackagesInternal = internalMutation({
  args: {
    family: v.optional(v.union(v.literal("code-plugin"), v.literal("bundle-plugin"))),
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const batchSize = Math.max(10, Math.min(args.batchSize ?? 100, 200));
    const dryRun = args.dryRun !== false;
    const family = args.family ?? "code-plugin";
    const { page, continueCursor, isDone } = await ctx.db
      .query("packages")
      .withIndex("by_family_updated", (q) => q.eq("family", family))
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let matched = 0;
    let patched = 0;
    let skippedPrivate = 0;
    for (const pkg of page) {
      if (!pkg.ownerPublisherId || pkg.softDeletedAt) continue;
      const ownerPublisher = await ctx.db.get(pkg.ownerPublisherId);
      if (!(await isOfficialPublisher(ctx, ownerPublisher))) continue;
      if (pkg.channel === "private") {
        skippedPrivate++;
        continue;
      }
      if (pkg.channel === "official" && pkg.isOfficial === true) continue;

      matched++;
      if (dryRun) continue;

      const nextPackage = {
        ...pkg,
        channel: "official" as const,
        isOfficial: true,
      };
      await ctx.db.patch(pkg._id, {
        channel: nextPackage.channel,
        isOfficial: nextPackage.isOfficial,
      });
      const owner = await getOwnerPublisher(ctx, {
        ownerPublisherId: nextPackage.ownerPublisherId,
        ownerUserId: nextPackage.ownerUserId,
      });
      await upsertPackageSearchDigest(ctx, {
        ...extractPackageDigestFields(nextPackage),
        ownerHandle: owner?.handle ?? "",
        ownerKind: owner?.kind,
      });
      patched++;
    }

    return {
      family,
      cursor: continueCursor,
      isDone,
      scanned: page.length,
      matched,
      patched,
      skippedPrivate,
      dryRun,
    };
  },
});

export const normalizeOfficialPublisherPackages = action({
  args: {
    family: v.optional(v.union(v.literal("code-plugin"), v.literal("bundle-plugin"))),
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUserFromAction(ctx);
    assertRole(user, ["admin"]);
    return await runMutationRef(
      ctx,
      internalRefs.packages.normalizeOfficialPublisherPackagesInternal,
      {
        family: args.family,
        cursor: args.cursor,
        batchSize: args.batchSize,
        dryRun: args.dryRun,
      },
    );
  },
});

export const updateReleaseStaticScanInternal = internalMutation({
  args: {
    releaseId: v.id("packageReleases"),
    staticScan: v.object({
      status: v.union(v.literal("clean"), v.literal("suspicious"), v.literal("malicious")),
      reasonCodes: v.array(v.string()),
      findings: v.array(
        v.object({
          code: v.string(),
          severity: v.union(v.literal("info"), v.literal("warn"), v.literal("critical")),
          file: v.string(),
          line: v.number(),
          message: v.string(),
          evidence: v.string(),
        }),
      ),
      summary: v.string(),
      engineVersion: v.string(),
      checkedAt: v.number(),
    }),
  },
  handler: async (ctx, args) => {
    const release = await ctx.db.get(args.releaseId);
    if (!release || release.softDeletedAt) return;
    const activeRelease = release;

    const patch: Partial<Doc<"packageReleases">> = {
      staticScan: args.staticScan,
    };
    if (activeRelease.verification) {
      const nextScanStatus = resolvePackageReleaseScanStatus({
        ...activeRelease,
        staticScan: args.staticScan,
      });
      patch.verification = activeRelease.verification
        ? {
            ...activeRelease.verification,
            scanStatus: nextScanStatus,
          }
        : activeRelease.verification;
    }

    await ctx.db.patch(args.releaseId, patch);

    const updatedRelease = {
      ...activeRelease,
      ...patch,
    } as Doc<"packageReleases">;
    await syncLatestPackageVerification(ctx, updatedRelease);
  },
});

export const scanPackageReleaseStaticallyInternal = internalAction({
  args: {
    releaseId: v.id("packageReleases"),
  },
  handler: async (ctx, args) => {
    const release = await runQueryRef<Doc<"packageReleases"> | null>(
      ctx,
      internalRefs.packages.getReleaseByIdInternal,
      { releaseId: args.releaseId },
    );
    if (!release || release.softDeletedAt) {
      return { ok: true as const, skipped: "missing_release" as const };
    }
    const activeRelease = release;

    const pkg = await runQueryRef<Doc<"packages"> | null>(
      ctx,
      internalRefs.packages.getPackageByIdInternal,
      { packageId: activeRelease.packageId },
    );
    if (!pkg || pkg.softDeletedAt || pkg.family === "skill") {
      return { ok: true as const, skipped: "missing_package" as const };
    }

    const staticScan = await runStaticPublishScanInNode(ctx, {
      slug: pkg.name,
      displayName: pkg.displayName,
      summary: pkg.summary,
      metadata: {
        packageJson: activeRelease.extractedPackageJson,
        pluginManifest: activeRelease.extractedPluginManifest,
        bundleManifest: activeRelease.normalizedBundleManifest,
        source: activeRelease.source,
      },
      files: activeRelease.files,
    });

    await runMutationRef(ctx, internalRefs.packages.updateReleaseStaticScanInternal, {
      releaseId: args.releaseId,
      staticScan,
    });

    return {
      ok: true as const,
      status: staticScan.status,
    };
  },
});

export const backfillPackageReleaseScansInternal = internalAction({
  args: {
    cursor: v.optional(v.number()),
    batchSize: v.optional(v.number()),
    scheduled: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = Math.max(1, Math.min(args.batchSize ?? 50, 200));
    const batch = (await runQueryRef(
      ctx,
      internalRefs.packages.getPackageReleaseScanBackfillBatchInternal,
      {
        cursor: args.cursor,
        batchSize,
        prioritizeRecent: args.cursor === undefined,
      },
    )) as {
      releases: Array<{
        releaseId: Id<"packageReleases">;
        needsVt: boolean;
        needsLlm: boolean;
        needsStatic: boolean;
      }>;
      nextCursor: number;
      done: boolean;
    };

    let scheduled = args.scheduled ?? 0;
    const vtEnabled = Boolean(process.env.VT_API_KEY);
    for (const release of batch.releases) {
      if (release.needsVt && vtEnabled) {
        await runAfterRef(ctx, 0, internalRefs.vt.scanPackageReleaseWithVirusTotal, {
          releaseId: release.releaseId,
        });
      }
      if (release.needsLlm) {
        await runMutationRef(ctx, internalRefs.securityScan.enqueuePackageReleaseScanInternal, {
          releaseId: release.releaseId,
          source: "backfill",
        });
      }
      if (release.needsStatic) {
        await runAfterRef(ctx, 0, internalRefs.packages.scanPackageReleaseStaticallyInternal, {
          releaseId: release.releaseId,
        });
      }
      scheduled += 1;
    }

    if (!batch.done) {
      await runAfterRef(ctx, 0, internalRefs.packages.backfillPackageReleaseScansInternal, {
        cursor: batch.nextCursor,
        batchSize,
        scheduled,
      });
    }

    return {
      scheduled,
      nextCursor: batch.nextCursor,
      done: batch.done,
    };
  },
});

export const backfillPackageReleaseScans = action({
  args: {
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await runActionRef(ctx, internalRefs.packages.backfillPackageReleaseScansInternal, {
      batchSize: args.batchSize,
    });
  },
});

export const setBatch = mutation({
  args: { packageId: v.id("packages"), batch: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    assertModerator(user);
    const pkg = await ctx.db.get(args.packageId);
    if (!pkg || pkg.softDeletedAt || pkg.family === "skill") {
      throw new ConvexError("Plugin not found");
    }
    const nextBatch = args.batch?.trim() || undefined;
    await setPackageFeaturedForActor(ctx, user, pkg, nextBatch === "highlighted");
  },
});

async function setPackageFeaturedForActor(
  ctx: MutationCtx,
  actor: Doc<"users">,
  pkg: Doc<"packages">,
  featured: boolean,
) {
  const now = Date.now();
  if (featured) {
    await upsertPackageBadge(ctx, pkg._id, "highlighted", actor._id, now);
  } else {
    await removePackageBadge(ctx, pkg._id, "highlighted");
  }

  await ctx.db.insert("auditLogs", {
    actorUserId: actor._id,
    action: "package.badge.highlighted",
    targetType: "package",
    targetId: pkg._id,
    metadata: { highlighted: featured },
    createdAt: now,
  });

  return { ok: true as const, featured, packageId: pkg._id, name: pkg.name };
}

export const setPackageFeaturedForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    name: v.string(),
    featured: v.boolean(),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
    assertModerator(actor);

    const pkg = await getPackageByNormalizedName(ctx, normalizePackageName(args.name));
    if (!pkg || pkg.softDeletedAt || pkg.family === "skill") {
      throw new ConvexError("Plugin not found");
    }

    return await setPackageFeaturedForActor(ctx, actor, pkg, args.featured);
  },
});

export const removeBetaLatestPackageTagsInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    names: v.array(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
    assertAdmin(actor);

    const results = [];
    const now = Date.now();
    for (const name of args.names) {
      const normalizedName = normalizePackageName(name);
      const pkg = await getPackageByNormalizedName(ctx, normalizedName);
      if (!pkg || pkg.softDeletedAt || pkg.family === "skill") {
        results.push({
          name: normalizedName,
          ok: false as const,
          error: "Package not found",
        });
        continue;
      }
      const latestReleaseId = pkg.latestReleaseId ?? pkg.tags.latest;
      if (!latestReleaseId) {
        results.push({
          name: normalizedName,
          ok: true as const,
          changed: false,
        });
        continue;
      }
      const latestRelease = await ctx.db.get(latestReleaseId);
      if (!latestRelease || latestRelease.softDeletedAt) {
        results.push({
          name: normalizedName,
          ok: false as const,
          error: "Latest release not found",
        });
        continue;
      }
      if (!latestRelease.version.includes("-")) {
        results.push({
          name: normalizedName,
          ok: false as const,
          error: `Latest release ${latestRelease.version} is not a prerelease`,
        });
        continue;
      }

      const nextTags = { ...pkg.tags };
      delete nextTags.latest;
      await ctx.db.patch(pkg._id, {
        latestReleaseId: undefined,
        latestVersionSummary: undefined,
        tags: nextTags,
        updatedAt: now,
      });
      await ctx.db.patch(latestRelease._id, {
        distTags: (latestRelease.distTags ?? []).filter((tag) => tag !== "latest"),
      });
      await ctx.db.insert("auditLogs", {
        actorUserId: args.actorUserId,
        action: "package.tags.remove_beta_latest",
        targetType: "package",
        targetId: pkg._id,
        metadata: {
          name: normalizedName,
          version: latestRelease.version,
          reason: args.reason || undefined,
        },
        createdAt: now,
      });
      results.push({ name: normalizedName, ok: true as const, changed: true });
    }
    return { ok: true as const, results };
  },
});
