import { getAuthUserId } from "@convex-dev/auth/server";
import {
  decodeUtf8Text,
  getCatalogTopicSlugs,
  INTERNAL_UNCATEGORIZED_CATEGORY,
  isSkillCategorySlug,
  normalizeCatalogTopic,
  normalizeCatalogTopics,
  normalizeContentType,
  resolveSkillCategories,
  resolveStoredSkillCategories,
  type SkillCategorySlug,
} from "clawhub-schema";
import { getPage, type IndexKey, paginator } from "convex-helpers/server/pagination";
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
  getOptionalActiveAuthUserId,
  getOptionalActiveAuthUserIdFromAction,
  requireUser,
  requireUserFromAction,
} from "./lib/access";
import {
  assertArtifactAppealFinalAction,
  assertArtifactAppealTransition,
  assertArtifactReportFinalAction,
  assertArtifactReportTransition,
  readArtifactReportStatus,
  appendSkillModerationEventLog,
} from "./lib/artifactModeration";
import { getSkillBadgeMap, getSkillBadgeMaps, isSkillHighlighted } from "./lib/badges";
import { scheduleNextBatchIfNeeded } from "./lib/batching";
import { generateChangelogPreview as buildChangelogPreview } from "./lib/changelog";
import {
  ACTIVITY_TREND_DAYS,
  buildDailyMetricTrends,
  clampActivityTrendEndDay,
  getActivityTrendRangeForEndDay,
} from "./lib/downloadTrend";
import { embeddingVisibilityFor } from "./lib/embeddingVisibility";
import {
  canHealSkillOwnershipByGitHubProviderAccountId,
  getGitHubProviderAccountId,
} from "./lib/githubIdentity";
import { deleteGitHubSkillScansForSkill } from "./lib/githubSkillScans";
import {
  adjustGlobalPublicSkillsCount,
  getPublicSkillVisibilityDelta,
  isPublicSkillDoc,
  readGlobalPublicSkillsCount,
} from "./lib/globalStats";
import {
  TRENDING_LEADERBOARD_KIND,
  TRENDING_NON_SUSPICIOUS_LEADERBOARD_KIND,
} from "./lib/leaderboards";
import { deriveModerationFlags } from "./lib/moderation";
import { buildModerationSnapshot } from "./lib/moderationEngine";
import {
  legacyFlagsFromVerdict,
  MODERATION_ENGINE_VERSION,
  summarizeReasonCodes,
  verdictFromCodes,
} from "./lib/moderationReasonCodes";
import { hasOfficialPublisherRow, toPublicPublisherWithOfficial } from "./lib/officialPublishers";
import {
  type HydratableSkill,
  type PublicPublisher,
  toPublicPublisher,
  toPublicSkill,
  toPublicUser,
} from "./lib/public";
import {
  hostedSkillMayHavePriorApprovedVersion,
  isHostedSkillPendingPublicReview,
  resolvePublicBrowseVersionForSkill,
  shouldExcludeSkillFromPublicBrowse,
} from "./lib/publicBrowse";
import {
  assertCanManageOwnedResource,
  canAccessPublisherOwnerScope,
  ensurePersonalPublisherForUser,
  getPersonalPublisherForUserOrFallback,
  getOwnerPublisher,
  getPublisherByHandle,
  getPublisherMembership,
  isPublisherActive,
  isPublisherRoleAllowed,
  normalizePublisherHandle,
  requirePublisherRole,
} from "./lib/publishers";
import { RECOMMENDATION_SCORE_VERSION } from "./lib/recommendationScore";
import {
  AUTO_HIDE_REPORT_THRESHOLD,
  MAX_ACTIVE_REPORTS_PER_USER,
  MAX_REPORT_REASON_LENGTH,
} from "./lib/reporting";
import {
  canReleaseReservedSlugForPublisher,
  enforceReservedSlugCooldownForNewSkill,
  formatReservedSlugCooldownMessage,
  getLatestActiveReservedSlugForPublisher,
  getLatestActiveReservedSlug,
  listActiveReservedSlugsForSlug,
  releaseActiveReservedSlugsForPublisher,
  reserveSlugForHardDeleteFinalize,
  upsertReservedSlugForRightfulOwner,
} from "./lib/reservedSlugs";
import {
  compareRankedSearchKeys,
  isDemotedExactMatch,
  rankedSearchKey,
  type SearchTrustSignals,
} from "./lib/searchRanking";
import { matchesAllTokens, matchesExploratoryTokenPrefixes, tokenize } from "./lib/searchText";
import {
  selectGeneratedSkillCardFile,
  selectSkillCardFile,
  sourceSkillVersionFiles,
} from "./lib/skillCards";
import { isPublicSkillVersionAvailableForSkill } from "./lib/skillFileAccess";
import { isHostedSkillPresentationIconPath } from "./lib/skillPresentation";
import {
  fetchText,
  queueHighlightedWebhook,
  stageSkillPublishAttemptForUser,
  type SkillPublishResult,
} from "./lib/skillPublish";
import { getFrontmatterValue, hashSkillFiles } from "./lib/skills";
import {
  getSkillBySlugForPublisher,
  getSkillSlugAliasBySlugForPublisher,
  getSkillSlugAliasBySlugScoped,
  normalizeSkillSlugKey,
  resolveLegacySkillBySlugOrAlias,
  resolvePublisherByOwnerHandle,
  type LegacyAmbiguousSkillMatch,
} from "./lib/skills/slugResolution";
import {
  computeIsSuspicious,
  isSoftDeletedSkillEligibleForAdminTransfer,
  isSkillReviewFlagged,
  isSkillSuspicious,
  isSkillTransferBlockedByModeration,
} from "./lib/skillSafety";
import {
  digestToHydratableSkill,
  digestToOwnerInfo,
  extractValidatedDigestFields,
  upsertSkillSearchDigest,
} from "./lib/skillSearchDigest";
import { assertValidSkillSlug, normalizeSkillSlug } from "./lib/skillSlugValidator";
import { readCanonicalStat, readPublicDownloads, readSkillMetricSources } from "./lib/skillStats";
import { normalizeSkillTags } from "./lib/skillTags";
import { runStaticPublishScan } from "./lib/staticPublishScan";
import { adjustUserSkillStatsForSkillChange } from "./lib/userSkillStats";
import schema from "./schema";
import { consumeSkillPublishUploads } from "./skillPublishUploads";

const MAX_OWNER_SUMMARY_LENGTH = 500;
const MAX_POINTERLESS_VERSION_SURVIVOR_SCAN = 100;

export { publishVersionForUser } from "./lib/skillPublish";

type ReadmeResult = { path: string; text: string; sourceBaseUrl?: string };
type FileTextResult = {
  path: string;
  text: string;
  size: number;
  sha256: string;
};
type FilePreviewResult = {
  path: string;
  text: string | null;
  size: number;
  sha256: string;
};
const PLATFORM_SKILL_LICENSE = "MIT-0" as const;

const MAX_DIFF_FILE_BYTES = 200 * 1024;
const MAX_LIST_LIMIT = 50;
const MAX_PUBLIC_LIST_LIMIT = 200;
export const MAX_EXPORT_LIST_LIMIT = 250;
const MAX_LIST_BULK_LIMIT = 200;
const MAX_LIST_TAKE = 1000;
const MAX_SKILL_CATALOG_SCAN_DOCUMENTS = 500;
const MAX_SKILL_CATALOG_SCAN_PAGES = 6;
const MAX_SKILL_CATALOG_SEARCH_PAGE_SIZE = 200;
const MAX_DIRECT_SKILL_CATALOG_SEARCH_CANDIDATES = 20;
const DEFAULT_RELATED_CATEGORY_SKILL_LIMIT = 5;
const MAX_RELATED_CATEGORY_SKILL_LIMIT = 8;
const MAX_RELATED_CATEGORY_SCAN_ROWS = 240;
const HARD_DELETE_BATCH_SIZE = 100;
const HARD_DELETE_VERSION_BATCH_SIZE = 10;
const HARD_DELETE_LEADERBOARD_BATCH_SIZE = 25;
const BAN_USER_SKILLS_BATCH_SIZE = 25;
const MAX_REPORT_REASON_SAMPLE = 5;
const MAX_APPEAL_MESSAGE_LENGTH = 2_000;
const RATE_LIMIT_DAY_MS = 24 * 60 * 60 * 1000;
const SLUG_RESERVATION_DAYS = 90;
const SLUG_RESERVATION_MS = SLUG_RESERVATION_DAYS * RATE_LIMIT_DAY_MS;
const UNPUBLISHED_SLUG_RESERVATION_DAYS = 30;
const UNPUBLISHED_SLUG_RESERVATION_MS = UNPUBLISHED_SLUG_RESERVATION_DAYS * RATE_LIMIT_DAY_MS;
const MAX_SKILL_SLUG_ALIASES_PER_MERGE = 200;
const MAX_MODERATION_NOTE_LENGTH = 1200;
const DEFAULT_STAFF_AUDIT_LOG_LIMIT = 10;
const MAX_STAFF_AUDIT_LOG_LIMIT = 50;
const USER_MODERATION_REASON = "user.moderation";
const SKILL_CATALOG_CURSOR_PREFIX = "skillcat:";

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

function buildStructuredModerationPatch(params: {
  staticScan?: Doc<"skillVersions">["staticScan"];
  vtAnalysis?: Doc<"skillVersions">["vtAnalysis"];
  llmAnalysis?: Doc<"skillVersions">["llmAnalysis"];
  vtStatus?: string;
  llmStatus?: string;
  sourceVersionId?: Id<"skillVersions">;
}): Pick<
  Doc<"skills">,
  | "moderationVerdict"
  | "moderationReasonCodes"
  | "moderationEvidence"
  | "moderationSummary"
  | "moderationEngineVersion"
  | "moderationEvaluatedAt"
  | "moderationSourceVersionId"
> {
  const snapshot = buildModerationSnapshot({
    staticScan: params.staticScan,
    vtAnalysis: params.vtAnalysis,
    vtStatus: params.vtStatus,
    llmStatus: params.llmStatus,
    llmAnalysis: params.llmAnalysis,
    sourceVersionId: params.sourceVersionId,
  });

  return {
    moderationVerdict: snapshot.verdict,
    moderationReasonCodes: snapshot.reasonCodes.length ? snapshot.reasonCodes : undefined,
    moderationEvidence: snapshot.evidence.length ? snapshot.evidence : undefined,
    moderationSummary: snapshot.summary,
    moderationEngineVersion: snapshot.engineVersion,
    moderationEvaluatedAt: snapshot.evaluatedAt,
    moderationSourceVersionId: params.sourceVersionId,
  };
}

type SkillModerationPatch = Partial<Doc<"skills">>;

function trimModerationNote(note: string) {
  const trimmed = note.trim();
  if (!trimmed) {
    throw new ConvexError("Audit note is required.");
  }
  if (trimmed.length > MAX_MODERATION_NOTE_LENGTH) {
    throw new ConvexError(`Audit note must be at most ${MAX_MODERATION_NOTE_LENGTH} characters.`);
  }
  return trimmed;
}

function normalizeAnalysisStatus(status: string | undefined) {
  return status?.trim().toLowerCase();
}

function hasCompletedScannerResult(
  version: Pick<Doc<"skillVersions">, "staticScan" | "vtAnalysis" | "llmAnalysis">,
) {
  const completedStatuses = new Set(["clean", "benign", "safe", "suspicious", "malicious"]);
  return [
    version.staticScan?.status,
    version.vtAnalysis?.status,
    version.llmAnalysis?.status,
    version.llmAnalysis?.verdict,
  ].some((status) => completedStatuses.has(normalizeAnalysisStatus(status) ?? ""));
}

function hasReviewReasonCode(codes: readonly string[] | undefined) {
  return (codes ?? []).some((code) => code.startsWith("review."));
}

function isObviousJunkSkill(
  skill: Pick<Doc<"skills">, "slug" | "displayName" | "summary" | "isSuspicious">,
) {
  if (!skill.isSuspicious) return false;
  const slug = skill.slug.trim().toLowerCase();
  const displayName = skill.displayName.trim().toLowerCase();
  const summary = (skill.summary ?? "").trim().toLowerCase();
  if (
    /^(?:test-skill|testskill|dummy-skill|placeholder-skill|untitled-skill)(?:-[0-9a-z]+)?$/.test(
      slug,
    )
  ) {
    return true;
  }
  if (slug === "skill-tester" && displayName === "skill tester" && summary === "skill tester") {
    return true;
  }
  return (
    (displayName === "test skill" ||
      displayName === "demo skill" ||
      displayName === "dummy skill" ||
      displayName === "placeholder skill" ||
      displayName === "untitled skill") &&
    (!summary || summary === "test" || summary === "demo" || summary === "todo")
  );
}

function resolveScannerModerationReason(params: {
  vtStatus?: string;
  llmStatus?: string;
  verdict?: Doc<"skills">["moderationVerdict"];
}) {
  const vtStatus = normalizeAnalysisStatus(params.vtStatus);
  const llmStatus = normalizeAnalysisStatus(params.llmStatus);

  if (params.verdict === "clean" && (vtStatus === "suspicious" || llmStatus === "suspicious")) {
    return "scanner.aggregate.clean";
  }
  if (vtStatus === "malicious") return "scanner.vt.malicious";
  if (llmStatus === "malicious") return "scanner.llm.malicious";
  if (vtStatus === "suspicious") return "scanner.vt.suspicious";
  if (llmStatus === "suspicious") return "scanner.llm.suspicious";
  if (vtStatus === "pending" || vtStatus === "loading" || vtStatus === "not_found") {
    return "scanner.vt.pending";
  }
  if (llmStatus === "pending" || llmStatus === "loading") return "scanner.llm.pending";
  if (vtStatus === "clean") return "scanner.vt.clean";
  if (llmStatus === "clean") return "scanner.llm.clean";
  if (params.verdict === "malicious") return "scanner.aggregate.malicious";
  if (params.verdict === "suspicious") return "scanner.aggregate.suspicious";
  return "scanner.aggregate.clean";
}

function scannerStatusFromReasonCodes(params: {
  scanner: "vt" | "llm";
  status?: string;
  reasonCodes: readonly string[];
}) {
  const scanner = params.scanner;
  if (params.reasonCodes.includes(`malicious.${scanner}_malicious`)) return "malicious";
  if (params.reasonCodes.includes(`suspicious.${scanner}_suspicious`)) return "suspicious";

  const status = normalizeAnalysisStatus(params.status);
  return status === "malicious" || status === "suspicious" ? undefined : status;
}

function isClawScanMaliciousAnalysis(analysis: Doc<"skillVersions">["llmAnalysis"] | undefined) {
  return normalizeAnalysisStatus(analysis?.verdict ?? analysis?.status) === "malicious";
}

export function buildScannerModerationPatchFromVersion(params: {
  owner: Doc<"users"> | null | undefined;
  version: Pick<Doc<"skillVersions">, "_id" | "staticScan" | "vtAnalysis" | "llmAnalysis">;
  now: number;
}): SkillModerationPatch {
  const structuredPatch = buildStructuredModerationPatch({
    staticScan: params.version.staticScan,
    vtAnalysis: params.version.vtAnalysis,
    llmAnalysis: params.version.llmAnalysis,
    vtStatus: params.version.vtAnalysis?.status,
    llmStatus: params.version.llmAnalysis?.status,
    sourceVersionId: params.version._id,
  });

  const sourceReasonCodes = structuredPatch.moderationReasonCodes ?? [];
  const vtStatusForReason = scannerStatusFromReasonCodes({
    scanner: "vt",
    status: params.version.vtAnalysis?.status,
    reasonCodes: sourceReasonCodes,
  });
  const rawVtStatus = normalizeAnalysisStatus(params.version.vtAnalysis?.status);
  const llmStatusForReason =
    !vtStatusForReason &&
    (rawVtStatus === "malicious" || rawVtStatus === "suspicious") &&
    normalizeAnalysisStatus(params.version.llmAnalysis?.status) === "clean"
      ? undefined
      : params.version.llmAnalysis?.status;
  const sourceReason = resolveScannerModerationReason({
    vtStatus: vtStatusForReason,
    llmStatus: llmStatusForReason,
    verdict: structuredPatch.moderationVerdict,
  });
  const bypassSuspicious =
    structuredPatch.moderationVerdict === "suspicious" &&
    isPrivilegedOwnerForSuspiciousBypass(params.owner);
  const moderationReasonCodes = bypassSuspicious
    ? sourceReasonCodes.filter((code) => !code.startsWith("suspicious."))
    : sourceReasonCodes;
  const moderationVerdict = verdictFromCodes(moderationReasonCodes);
  const isReviewOnlyVerdict =
    moderationVerdict === "clean" && hasReviewReasonCode(moderationReasonCodes);
  const moderationFlags = isReviewOnlyVerdict
    ? ["flagged.review"]
    : legacyFlagsFromVerdict(moderationVerdict);
  const moderationReason = bypassSuspicious
    ? normalizeScannerSuspiciousReason(sourceReason)
    : isReviewOnlyVerdict
      ? "scanner.llm.review"
      : sourceReason;
  const moderationStatus = moderationVerdict === "malicious" ? "hidden" : "active";

  return {
    moderationStatus,
    moderationReason,
    moderationFlags,
    moderationVerdict,
    moderationReasonCodes: moderationReasonCodes.length ? moderationReasonCodes : undefined,
    moderationEvidence: structuredPatch.moderationEvidence,
    moderationSummary: summarizeReasonCodes(moderationReasonCodes),
    moderationEngineVersion: structuredPatch.moderationEngineVersion,
    moderationEvaluatedAt: structuredPatch.moderationEvaluatedAt,
    moderationSourceVersionId: structuredPatch.moderationSourceVersionId,
    moderationNotes: undefined,
    isSuspicious: computeIsSuspicious({
      moderationFlags,
      moderationReason,
    }),
    hiddenAt: moderationStatus === "hidden" ? params.now : undefined,
    hiddenBy: undefined,
    lastReviewedAt: moderationStatus === "hidden" ? params.now : undefined,
  };
}

async function patchStructuredModerationFromVersion(
  ctx: MutationCtx,
  skill: Doc<"skills">,
  version: Pick<
    Doc<"skillVersions">,
    "_id" | "version" | "staticScan" | "vtAnalysis" | "llmAnalysis" | "sha256hash"
  >,
) {
  const now = Date.now();
  const owner = skill.ownerUserId ? await ctx.db.get(skill.ownerUserId) : null;
  const patch = buildScannerModerationPatchFromVersion({
    owner,
    version,
    now,
  });

  const shouldPersistClawScanMalwareBlock =
    patch.moderationVerdict === "malicious" && isClawScanMaliciousAnalysis(version.llmAnalysis);

  if (shouldPersistClawScanMalwareBlock) {
    await scheduleClawScanMaliciousArtifactFinding(ctx, skill, version, patch);
    await quarantineMaliciousLatestSkillVersion(ctx, skill, version, owner, now, patch);
    return;
  }

  // A ClawScan-malicious result is itself a security lock. Persist it even
  // when the skill was already hidden by a user or quality hold so a later
  // hold lift cannot restore a latest-version malware verdict.
  if (shouldPreserveExistingModerationLock(skill)) {
    await scheduleClawScanMaliciousArtifactFinding(ctx, skill, version, patch);
    return;
  }

  const nextSkill = { ...skill, ...patch };
  await ctx.db.patch(skill._id, patch);
  await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);

  await scheduleClawScanMaliciousArtifactFinding(ctx, skill, version, patch);
}

function latestVersionSummaryFromSkillVersion(
  version: Pick<
    Doc<"skillVersions">,
    "version" | "createdAt" | "changelog" | "changelogSource" | "parsed"
  >,
): NonNullable<Doc<"skills">["latestVersionSummary"]> {
  return {
    version: version.version,
    createdAt: version.createdAt,
    changelog: version.changelog,
    changelogSource: version.changelogSource,
    description: skillSummaryFromSkillVersion(version),
    clawdis: version.parsed?.clawdis,
  };
}

function skillSummaryFromSkillVersion(
  version: Pick<Doc<"skillVersions">, "parsed"> | null | undefined,
) {
  const presentationSummary = version?.parsed?.presentation?.summary?.trim();
  if (presentationSummary) return presentationSummary;
  return version?.parsed?.frontmatter
    ? getFrontmatterValue(version.parsed.frontmatter, "description")?.trim() || undefined
    : undefined;
}

function skillDisplayNameFromSkillVersion(
  version: Pick<Doc<"skillVersions">, "parsed"> | null | undefined,
) {
  const presentationDisplayName = version?.parsed?.presentation?.displayName?.trim();
  if (presentationDisplayName) return presentationDisplayName;
  return version?.parsed?.frontmatter
    ? getFrontmatterValue(version.parsed.frontmatter, "name")?.trim() || undefined
    : undefined;
}

function skillIconFromSkillVersion(version: Pick<Doc<"skillVersions">, "icon"> | null | undefined) {
  return version && "icon" in version ? version.icon : undefined;
}

function isKnownMaliciousSkillVersion(
  version: Pick<Doc<"skillVersions">, "_id" | "staticScan" | "vtAnalysis" | "llmAnalysis">,
) {
  const patch = buildStructuredModerationPatch({
    staticScan: version.staticScan,
    vtAnalysis: version.vtAnalysis,
    llmAnalysis: version.llmAnalysis,
    vtStatus: version.vtAnalysis?.status,
    llmStatus: version.llmAnalysis?.status,
    sourceVersionId: version._id,
  });
  return patch.moderationVerdict === "malicious";
}

type SkillVersionOwnerDeleteAvailability = Pick<
  Doc<"skillVersions">,
  | "_id"
  | "skillId"
  | "softDeletedAt"
  | "ownerDeletedAt"
  | "manualRevocation"
  | "staticScan"
  | "vtAnalysis"
  | "llmAnalysis"
>;

function isSkillVersionAvailableForOwnerDeleteSafety(
  version: SkillVersionOwnerDeleteAvailability | null | undefined,
  skillId: Id<"skills">,
) {
  return Boolean(
    version &&
    isPublicSkillVersionAvailableForSkill(version, skillId) &&
    version.ownerDeletedAt === undefined &&
    !version.manualRevocation &&
    !isKnownMaliciousSkillVersion(version),
  );
}

function compareSkillVersionsForRestore(
  left: Pick<Doc<"skillVersions">, "version" | "createdAt">,
  right: Pick<Doc<"skillVersions">, "version" | "createdAt">,
) {
  const leftValid = semver.valid(left.version);
  const rightValid = semver.valid(right.version);
  if (leftValid && rightValid) return semver.rcompare(leftValid, rightValid);
  if (leftValid) return -1;
  if (rightValid) return 1;
  return right.createdAt - left.createdAt;
}

async function findReplacementLatestSkillVersion(
  ctx: MutationCtx,
  skillId: Id<"skills">,
  quarantinedVersionId: Id<"skillVersions">,
) {
  const versions = await ctx.db
    .query("skillVersions")
    .withIndex("by_skill", (q) => q.eq("skillId", skillId))
    .collect();
  return (
    versions
      .filter(
        (candidate) =>
          candidate._id !== quarantinedVersionId &&
          !candidate.softDeletedAt &&
          !candidate.manualRevocation &&
          !isKnownMaliciousSkillVersion(candidate),
      )
      .sort(compareSkillVersionsForRestore)[0] ?? null
  );
}

type SkillVersionRevocationSkill = Pick<
  Doc<"skills">,
  | "_id"
  | "slug"
  | "displayName"
  | "summary"
  | "icon"
  | "latestVersionId"
  | "latestVersionSummary"
  | "tags"
>;

type SkillVersionRevocationVersion = Pick<
  Doc<"skillVersions">,
  "_id" | "skillId" | "version" | "createdAt" | "changelog" | "changelogSource" | "parsed" | "icon"
>;

export function buildSkillVersionRevocationPlan(params: {
  actorUserId: Id<"users">;
  skill: SkillVersionRevocationSkill;
  target: SkillVersionRevocationVersion;
  replacement: SkillVersionRevocationVersion | null;
  reason: string;
  now: number;
}) {
  const versionPatch: Partial<Doc<"skillVersions">> = {
    softDeletedAt: params.now,
    manualRevocation: {
      reason: params.reason,
      reviewerUserId: params.actorUserId,
      revokedAt: params.now,
    },
  };
  const isLatest =
    params.skill.latestVersionId === params.target._id ||
    params.skill.tags.latest === params.target._id ||
    params.skill.latestVersionSummary?.version === params.target.version;
  const nextTags = Object.fromEntries(
    Object.entries(params.skill.tags).filter(([, versionId]) => versionId !== params.target._id),
  ) as Doc<"skills">["tags"];

  if (!isLatest) {
    return {
      versionPatch,
      skillPatch: {
        tags: nextTags,
        updatedAt: params.now,
      } satisfies Partial<Doc<"skills">>,
      isLatest,
    };
  }

  if (params.replacement) {
    nextTags.latest = params.replacement._id;
    return {
      versionPatch,
      skillPatch: {
        displayName: skillDisplayNameFromSkillVersion(params.replacement) ?? params.skill.slug,
        summary: skillSummaryFromSkillVersion(params.replacement),
        icon: skillIconFromSkillVersion(params.replacement) ?? params.skill.icon,
        latestVersionId: params.replacement._id,
        latestVersionSummary: latestVersionSummaryFromSkillVersion(params.replacement),
        tags: nextTags,
        updatedAt: params.now,
      } satisfies Partial<Doc<"skills">>,
      isLatest,
    };
  }

  return {
    versionPatch,
    skillPatch: {
      latestVersionId: undefined,
      latestVersionSummary: undefined,
      tags: nextTags,
      softDeletedAt: params.now,
      moderationStatus: "hidden",
      moderationReason: "manual.version_revoked",
      moderationNotes: params.reason,
      hiddenAt: params.now,
      hiddenBy: params.actorUserId,
      lastReviewedAt: params.now,
      updatedAt: params.now,
    } satisfies Partial<Doc<"skills">>,
    isLatest,
  };
}

async function clearSkillEmbeddingsLatestVersion(
  ctx: MutationCtx,
  skillId: Id<"skills">,
  now: number,
) {
  const embeddings = await listSkillEmbeddingsForSkill(ctx, skillId);
  for (const embedding of embeddings) {
    if (
      !embedding.isLatest &&
      embedding.visibility === embeddingVisibilityFor(false, embedding.isApproved)
    ) {
      continue;
    }
    await ctx.db.patch(embedding._id, {
      isLatest: false,
      visibility: embeddingVisibilityFor(false, embedding.isApproved),
      updatedAt: now,
    });
  }
}

async function quarantineMaliciousLatestSkillVersion(
  ctx: MutationCtx,
  skill: Doc<"skills">,
  version: Pick<Doc<"skillVersions">, "_id">,
  owner: Doc<"users"> | null | undefined,
  now: number,
  maliciousPatch: SkillModerationPatch,
) {
  await ctx.db.patch(version._id, { softDeletedAt: now });

  const replacement = await findReplacementLatestSkillVersion(ctx, skill._id, version._id);
  const nextTags: Record<string, Id<"skillVersions">> = {};
  for (const [tag, versionId] of Object.entries(skill.tags ?? {})) {
    if (versionId === version._id || tag === "latest") continue;
    nextTags[tag] = versionId;
  }
  if (replacement) {
    nextTags.latest = replacement._id;
  }

  const patch: Partial<Doc<"skills">> = {
    displayName: replacement
      ? (skillDisplayNameFromSkillVersion(replacement) ?? skill.slug)
      : skill.displayName,
    summary: replacement ? skillSummaryFromSkillVersion(replacement) : skill.summary,
    icon: replacement ? (skillIconFromSkillVersion(replacement) ?? skill.icon) : skill.icon,
    latestVersionId: replacement?._id,
    latestVersionSummary: replacement
      ? latestVersionSummaryFromSkillVersion(replacement)
      : undefined,
    tags: nextTags,
    updatedAt: now,
  };

  if (!shouldPreserveExistingModerationLock(skill)) {
    const basePatch = replacement
      ? buildScannerModerationPatchFromVersion({
          owner,
          version: replacement,
          now,
        })
      : maliciousPatch;
    Object.assign(patch, basePatch);
  }

  const nextSkill = { ...skill, ...patch } as Doc<"skills">;
  await ctx.db.patch(skill._id, patch);
  await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);
  await adjustUserSkillStatsForSkillChange(ctx, skill, nextSkill);

  if (replacement) {
    await setSkillEmbeddingsLatestVersion(ctx, skill._id, replacement._id, now);
  } else {
    await clearSkillEmbeddingsLatestVersion(ctx, skill._id, now);
  }
  await syncSkillSearchDigestForSkillDoc(ctx, nextSkill);
}

async function quarantineMaliciousNonLatestSkillVersion(
  ctx: MutationCtx,
  skill: Doc<"skills">,
  versionId: Id<"skillVersions">,
  now: number,
) {
  await ctx.db.patch(versionId, { softDeletedAt: now });
  const nextTags = Object.fromEntries(
    Object.entries(skill.tags ?? {}).filter(([, taggedVersionId]) => taggedVersionId !== versionId),
  ) as Record<string, Id<"skillVersions">>;
  if (Object.keys(nextTags).length === Object.keys(skill.tags ?? {}).length) return;

  const patch: Partial<Doc<"skills">> = {
    tags: nextTags,
    updatedAt: now,
  };
  const nextSkill = { ...skill, ...patch } as Doc<"skills">;
  await ctx.db.patch(skill._id, patch);
  await syncSkillSearchDigestForSkillDoc(ctx, nextSkill);
}

async function scheduleClawScanMaliciousArtifactFinding(
  ctx: MutationCtx,
  skill: Doc<"skills">,
  version: Pick<Doc<"skillVersions">, "llmAnalysis" | "sha256hash" | "version"> &
    Partial<Pick<Doc<"skillVersions">, "createdBy">>,
  patch: SkillModerationPatch,
) {
  if (
    patch.moderationVerdict === "malicious" &&
    skill.ownerUserId &&
    isClawScanMaliciousAnalysis(version.llmAnalysis)
  ) {
    await ctx.scheduler.runAfter(0, internal.users.recordMaliciousArtifactFindingInternal, {
      ownerUserId: version.createdBy ?? skill.ownerUserId,
      artifactKind: "skill",
      artifactName: skill.slug,
      version: version.version,
      ...(version.sha256hash ? { sha256hash: version.sha256hash } : {}),
      ...(version.llmAnalysis?.summary ? { findingSummary: version.llmAnalysis.summary } : {}),
      trigger:
        patch.moderationReasonCodes?.find((code) => code.startsWith("malicious.llm_")) ??
        "malicious.llm_malicious",
    });
  }
}

export const recomputeLatestSkillModerationInternal = internalMutation({
  args: { skillId: v.id("skills") },
  handler: async (ctx, args) => {
    const skill = await ctx.db.get(args.skillId);
    if (!skill) return { ok: true as const, skipped: "missing" as const };
    if (shouldPreserveExistingModerationLock(skill)) {
      return { ok: true as const, skipped: "existing_lock" as const };
    }
    if (!skill.latestVersionId) return { ok: true as const, skipped: "missing_latest" as const };

    const version = await ctx.db.get(skill.latestVersionId);
    if (!version) return { ok: true as const, skipped: "missing_latest" as const };

    const now = Date.now();
    const owner = skill.ownerUserId ? await ctx.db.get(skill.ownerUserId) : null;
    const basePatch = buildScannerModerationPatchFromVersion({
      owner,
      version,
      now,
    });
    const patch = basePatch;
    const nextSkill = { ...skill, ...patch };
    await ctx.db.patch(skill._id, patch);
    await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);

    return {
      ok: true as const,
      skillId: skill._id,
      slug: skill.slug,
      verdict: patch.moderationVerdict ?? "clean",
      reason: patch.moderationReason,
      reasonCodes: patch.moderationReasonCodes ?? [],
    };
  },
});

export const previewLatestSkillModerationInternal = internalQuery({
  args: { skillId: v.id("skills") },
  handler: async (ctx, args) => {
    const skill = await ctx.db.get(args.skillId);
    if (!skill) return { ok: true as const, skipped: "missing" as const };
    if (!skill.latestVersionId) return { ok: true as const, skipped: "missing_latest" as const };

    const version = await ctx.db.get(skill.latestVersionId);
    if (!version) return { ok: true as const, skipped: "missing_latest" as const };

    const owner = skill.ownerUserId ? await ctx.db.get(skill.ownerUserId) : null;
    const patch = buildScannerModerationPatchFromVersion({
      owner,
      version,
      now: Date.now(),
    });

    return {
      ok: true as const,
      skillId: skill._id,
      slug: skill.slug,
      verdict: patch.moderationVerdict ?? "clean",
      reason: patch.moderationReason,
      reasonCodes: patch.moderationReasonCodes ?? [],
    };
  },
});
const OWNER_ACTIVITY_SCAN_LIMIT = 500;
const NEW_SKILL_DAILY_LIMIT = 200;

const SORT_INDEXES = {
  recommended: "by_active_recommended_score",
  newest: "by_active_created",
  updated: "by_active_updated",
  name: "by_active_name",
  downloads: "by_active_stats_downloads",
  stars: "by_active_stats_stars",
  installs: "by_active_stats_installs_all_time",
} as const;

// Compound indexes on skillSearchDigest that filter isSuspicious at the index level.
const NONSUSPICIOUS_SORT_INDEXES = {
  recommended: "by_nonsuspicious_recommended_score",
  newest: "by_nonsuspicious_created",
  updated: "by_nonsuspicious_updated",
  name: "by_nonsuspicious_name",
  downloads: "by_nonsuspicious_downloads",
  stars: "by_nonsuspicious_stars",
  installs: "by_nonsuspicious_installs",
} as const;

const RECOMMENDED_RANK_INDEXES = {
  active: "by_active_recommended_rank",
  nonSuspicious: "by_nonsuspicious_recommended_rank",
} as const;

const RECOMMENDED_RANK_INDEX_FIELD_COUNTS = {
  active: 5,
  nonSuspicious: 6,
} as const;
const MAX_FILTERED_PUBLIC_LIST_SCAN_PAGES = 12;
const MAX_FILTERED_PUBLIC_LIST_SCAN_ROWS = 500;

// Convex document IDs are opaque strings (e.g. "r97c0xws..."), not "table:id" —
// so just confirm the schema-typed id is actually present before ctx.db.get.
function isSkillVersionId(
  value: Id<"skillVersions"> | null | undefined,
): value is Id<"skillVersions"> {
  return typeof value === "string" && value.length > 0;
}

function isUserId(value: Id<"users"> | null | undefined): value is Id<"users"> {
  return typeof value === "string" && value.length > 0;
}

type OwnerPublishActivity = {
  skillsLastDay: number;
};

function isPrivilegedOwnerForSuspiciousBypass(owner: Doc<"users"> | null | undefined) {
  if (!owner) return false;
  return owner.role === "admin" || owner.role === "moderator";
}

function stripSuspiciousFlag(flags: string[] | undefined) {
  if (!flags?.length) return undefined;
  const next = flags.filter((flag) => flag !== "flagged.suspicious");
  return next.length ? next : undefined;
}

function isScannerManagedReason(reason: string | undefined) {
  if (!reason) return false;
  return (
    reason === "pending.scan" || reason === "pending.scan.stale" || reason.startsWith("scanner.")
  );
}

function isLegacyStaticScannerReason(reason: string | undefined) {
  return reason === "scanner.static.malicious" || reason === "scanner.static.suspicious";
}

function shouldPreserveExistingModerationLock(
  skill: Pick<Doc<"skills">, "moderationStatus" | "moderationReason">,
) {
  if (skill.moderationStatus !== "hidden") return false;
  return !isScannerManagedReason(skill.moderationReason);
}

function shouldSyncModerationFromLatestVersion(
  skill: Pick<Doc<"skills">, "moderationStatus" | "moderationReason" | "softDeletedAt">,
) {
  if (skill.softDeletedAt) return false;
  if (skill.moderationStatus === "active") return true;
  if (skill.moderationStatus === "removed") return false;
  if (
    skill.moderationReason === "pending.scan" ||
    skill.moderationReason === "pending.scan.stale"
  ) {
    return true;
  }
  return (
    typeof skill.moderationReason === "string" && skill.moderationReason.startsWith("scanner.")
  );
}

function shouldBackfillLatestSkillModeration(
  skill: Pick<
    Doc<"skills">,
    | "latestVersionId"
    | "moderationStatus"
    | "moderationReason"
    | "moderationSourceVersionId"
    | "softDeletedAt"
  >,
) {
  if (!shouldSyncModerationFromLatestVersion(skill)) return false;
  if (!skill.latestVersionId) return false;
  if (isLegacyStaticScannerReason(skill.moderationReason as string | undefined)) return true;
  if (skill.moderationSourceVersionId === skill.latestVersionId) return false;
  return isScannerManagedReason(skill.moderationReason as string | undefined);
}

function shouldForceBackfillLatestSkillModeration(
  skill: Pick<
    Doc<"skills">,
    "latestVersionId" | "moderationStatus" | "moderationReason" | "softDeletedAt"
  >,
) {
  if (!shouldSyncModerationFromLatestVersion(skill)) return false;
  if (!skill.latestVersionId) return false;
  return isScannerManagedReason(skill.moderationReason as string | undefined);
}

async function syncSkillModerationFromLatestVersion(
  ctx: MutationCtx,
  skill: Doc<"skills">,
  now: number,
) {
  const owner = skill.ownerUserId ? await ctx.db.get(skill.ownerUserId) : null;
  const latestVersion = skill.latestVersionId ? await ctx.db.get(skill.latestVersionId) : null;
  const basePatch: SkillModerationPatch = latestVersion
    ? buildScannerModerationPatchFromVersion({
        owner,
        version: latestVersion,
        now,
      })
    : {
        moderationStatus: "active",
        moderationReason: undefined,
        moderationNotes: undefined,
        moderationFlags: undefined,
        moderationVerdict: "clean",
        moderationReasonCodes: undefined,
        moderationEvidence: undefined,
        moderationSummary: "No suspicious patterns detected.",
        moderationEngineVersion: undefined,
        moderationEvaluatedAt: now,
        moderationSourceVersionId: undefined,
        isSuspicious: false,
        hiddenAt: undefined,
        hiddenBy: undefined,
        lastReviewedAt: undefined,
        updatedAt: now,
      };

  const patch = basePatch;

  const nextSkill = { ...skill, ...patch };
  await ctx.db.patch(skill._id, patch);
  await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);
}

function buildConflictingSkillUrl(skill: Doc<"skills">, owner: SkillOwnerRef) {
  if (!owner || owner.deletedAt || owner.deactivatedAt || !isPublicSkillDoc(skill)) return null;
  const ownerParam = owner.handle?.trim() || String(owner._id);
  if (!ownerParam) return null;
  return `/${encodeURIComponent(ownerParam)}/${encodeURIComponent(skill.slug)}`;
}

function buildSlugTakenErrorMessage(skill: Doc<"skills">, owner: SkillOwnerRef) {
  if (!owner || owner.deletedAt || owner.deactivatedAt) {
    return (
      "This slug is locked to a deleted or banned account. " +
      "If you believe you are the rightful owner, open a GitHub issue to reclaim it: https://github.com/openclaw/clawhub/issues/new."
    );
  }
  const base = "Slug is already taken. Choose a different slug.";
  const url = buildConflictingSkillUrl(skill, owner);
  if (!url) return base;
  return `${base} Existing skill: ${url}`;
}

function buildAliasTakenErrorMessage(skill: Doc<"skills">, owner: SkillOwnerRef) {
  const base = "Slug redirects to an existing skill. Choose a different slug.";
  const url = buildConflictingSkillUrl(skill, owner);
  if (!url) return base;
  return `${base} Existing skill: ${url}`;
}

function formatUnpublishedSlugReservationMessage(slug: string, expiresAt: number) {
  return (
    `Slug "${slug}" is reserved by an unpublished skill until ` +
    `${new Date(expiresAt).toISOString()}. Publish or restore it before then to keep the slug; ` +
    "after that another publisher can claim it."
  );
}

async function getUnpublishedSlugReservationExpiresAt(
  ctx: QueryCtx | MutationCtx,
  skill: Pick<
    Doc<"skills">,
    | "softDeletedAt"
    | "hiddenBy"
    | "ownerUserId"
    | "ownerPublisherId"
    | "moderationFlags"
    | "moderationStatus"
    | "moderationVerdict"
    | "unpublishedSlugReservedUntil"
  >,
) {
  if (!skill.softDeletedAt) return null;
  if (!skill.hiddenBy) return null;
  if (typeof skill.unpublishedSlugReservedUntil === "number") {
    if (skill.moderationStatus === "removed") return null;
    if (skill.moderationVerdict === "malicious") return null;
    if (skill.moderationFlags?.includes("blocked.malware")) return null;
    if (await isKnownPlatformModeratorSkillHide(ctx, skill)) return null;
    return skill.unpublishedSlugReservedUntil;
  }
  if (skill.hiddenBy !== skill.ownerUserId) return null;
  return skill.softDeletedAt + UNPUBLISHED_SLUG_RESERVATION_MS;
}

async function isKnownPlatformModeratorSkillHide(
  ctx: QueryCtx | MutationCtx,
  skill: Pick<Doc<"skills">, "hiddenBy">,
) {
  if (!skill.hiddenBy) return true;
  const hiddenBy = await ctx.db.get(skill.hiddenBy);
  return hiddenBy?.role === "admin" || hiddenBy?.role === "moderator";
}

async function canUserManageSkillOwner(
  ctx: QueryCtx | MutationCtx,
  skill: Pick<Doc<"skills">, "ownerUserId" | "ownerPublisherId">,
  userId: Id<"users">,
) {
  const user = await ctx.db.get(userId);
  if (!user || user.deletedAt || user.deactivatedAt) return false;
  return canManageSkillOwnerForActor(ctx, user, skill);
}

function buildReleasedUnpublishedSkillSlug(skill: Pick<Doc<"skills">, "_id">, attempt = 0) {
  const idPart = String(skill._id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const suffix = attempt > 0 ? `_${attempt}` : "";
  // The double-underscore namespace is intentionally not user-claimable by
  // the public slug validator, so released hidden rows cannot squat on public
  // slug space after their unpublished reservation expires.
  return `__unpublished_${idPart || "skill"}${suffix}`;
}

function slugValidationAvailabilityFailure(error: unknown) {
  const message =
    error instanceof ConvexError && typeof error.data === "string" ? error.data : "Invalid slug.";
  return {
    available: false,
    reason: /reserved|protected/i.test(message) ? ("reserved" as const) : ("taken" as const),
    message,
    url: null,
  };
}

type SkillOwnerRef =
  | {
      _id: Id<"users"> | Id<"publishers">;
      handle?: string | null;
      deletedAt?: number | null;
      deactivatedAt?: number | null;
    }
  | null
  | undefined;

function normalizeSkillSlugForWrite(slug: string) {
  // Write-path: full validation (length, pattern, reserved words,
  // no consecutive hyphens). See `lib/skillSlugValidator.ts`.
  return assertValidSkillSlug(slug);
}

async function getSkillSlugAliasBySlug(ctx: Pick<QueryCtx | MutationCtx, "db">, slug: string) {
  const normalizedSlug = normalizeSkillSlugKey(slug);
  const resolved = await resolveLegacySkillBySlugOrAlias(ctx, normalizedSlug);
  return resolved.alias;
}

async function listSkillSlugAliasesForMerge(
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  skillId: Id<"skills">,
) {
  const aliases = await ctx.db
    .query("skillSlugAliases")
    .withIndex("by_skill", (q) => q.eq("skillId", skillId))
    .take(MAX_SKILL_SLUG_ALIASES_PER_MERGE + 1);
  if (aliases.length > MAX_SKILL_SLUG_ALIASES_PER_MERGE) {
    throw new ConvexError(
      `A skill with more than ${MAX_SKILL_SLUG_ALIASES_PER_MERGE} historical slugs cannot be merged in one transaction. Contact a ClawHub maintainer for a batched migration.`,
    );
  }
  return aliases;
}

function sameSkillSlugAliasOwner(
  alias: Pick<Doc<"skillSlugAliases">, "ownerUserId" | "ownerPublisherId">,
  ownerUserId: Id<"users">,
  ownerPublisherId: Id<"publishers"> | undefined,
) {
  return (
    alias.ownerUserId === ownerUserId &&
    (alias.ownerPublisherId ?? null) === (ownerPublisherId ?? null)
  );
}

async function releaseExpiredUnpublishedSkillSlug(
  ctx: MutationCtx,
  skill: Doc<"skills">,
  now: number,
  actorUserId: Id<"users">,
) {
  const reservedUntil = await getUnpublishedSlugReservationExpiresAt(ctx, skill);
  if (reservedUntil === null || reservedUntil > now) return false;

  let releasedSlug: string | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = buildReleasedUnpublishedSkillSlug(skill, attempt);
    const [conflictingSkills, conflictingAliases] = await Promise.all([
      ctx.db
        .query("skills")
        .withIndex("by_slug", (q) => q.eq("slug", candidate))
        .take(1),
      ctx.db
        .query("skillSlugAliases")
        .withIndex("by_slug", (q) => q.eq("slug", candidate))
        .take(1),
    ]);
    const conflictingSkill = conflictingSkills.find(
      (candidateSkill) => candidateSkill._id !== skill._id,
    );
    if (!conflictingSkill && conflictingAliases.length === 0) {
      releasedSlug = candidate;
      break;
    }
  }
  if (!releasedSlug) {
    throw new ConvexError("Unable to release expired unpublished slug without a slug collision.");
  }

  await ctx.db.patch(skill._id, {
    slug: releasedSlug,
    unpublishedOriginalSlug: skill.unpublishedOriginalSlug ?? skill.slug,
    unpublishedSlugReservedUntil: undefined,
    unpublishedSlugReleasedAt: now,
    updatedAt: now,
  });
  await ctx.db.insert("auditLogs", {
    actorUserId,
    action: "skill.slug.unpublished_release",
    targetType: "skill",
    targetId: skill._id,
    metadata: {
      from: skill.slug,
      to: releasedSlug,
      previousOwnerUserId: skill.ownerUserId,
      reservedUntil,
    },
    createdAt: now,
  });
  return true;
}

async function resolveSkillBySlugOrAlias(
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  slug: string,
  options: { includeSoftDeleted?: boolean } = {},
) {
  return await resolveLegacySkillBySlugOrAlias(ctx, slug, options);
}

async function resolveUnambiguousSkillForLegacySlug(
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  slug: string,
  options: { includeSoftDeleted?: boolean; notFoundMessage?: string } = {},
) {
  const resolved = await resolveSkillBySlugOrAlias(ctx, slug, options);
  if (resolved.ambiguous) {
    throw new ConvexError("Slug is used by multiple publishers. Use an owner-qualified skill URL.");
  }
  if (!resolved.skill) throw new ConvexError(options.notFoundMessage ?? "Skill not found");
  return resolved.skill;
}

async function resolveOptionalUnambiguousSkillForLegacySlug(
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  slug: string,
  options: { includeSoftDeleted?: boolean } = {},
) {
  const resolved = await resolveSkillBySlugOrAlias(ctx, slug, options);
  if (resolved.ambiguous) {
    throw new ConvexError("Slug is used by multiple publishers. Use an owner-qualified skill URL.");
  }
  return resolved.skill;
}

async function resolveLegacyPersonalSkillForSameGitHubOwner(
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  slug: string,
  userId: Id<"users">,
) {
  const resolved = await resolveLegacySkillBySlugOrAlias(ctx, slug, {
    includeSoftDeleted: true,
  });
  if (resolved.ambiguous || !resolved.skill || resolved.skill.ownerPublisherId) {
    return null;
  }
  if (resolved.skill.ownerUserId === userId) return resolved.skill;

  const [ownerProviderAccountId, callerProviderAccountId] = await Promise.all([
    getGitHubProviderAccountId(ctx, resolved.skill.ownerUserId),
    getGitHubProviderAccountId(ctx, userId),
  ]);
  return canHealSkillOwnershipByGitHubProviderAccountId(
    ownerProviderAccountId,
    callerProviderAccountId,
  )
    ? resolved.skill
    : null;
}

async function repointSkillRelationships(
  ctx: MutationCtx,
  params: {
    fromSkillId: Id<"skills">;
    toSkillId: Id<"skills">;
    toCanonicalSkillId: Id<"skills">;
    skipSkillId?: Id<"skills">;
    targetVersion: Doc<"skillVersions"> | null;
    now: number;
  },
) {
  const canonicalRefs = await ctx.db
    .query("skills")
    .withIndex("by_canonical", (q) => q.eq("canonicalSkillId", params.fromSkillId))
    .collect();
  for (const related of canonicalRefs) {
    if (related._id === params.skipSkillId) continue;
    await ctx.db.patch(related._id, {
      canonicalSkillId: params.toCanonicalSkillId,
      updatedAt: params.now,
    });
  }

  const forkRefs = await ctx.db
    .query("skills")
    .withIndex("by_fork_of", (q) => q.eq("forkOf.skillId", params.fromSkillId))
    .collect();
  for (const related of forkRefs) {
    if (related._id === params.skipSkillId) continue;
    await ctx.db.patch(related._id, {
      canonicalSkillId: params.toCanonicalSkillId,
      forkOf: related.forkOf
        ? {
            ...related.forkOf,
            skillId: params.toSkillId,
            version: params.targetVersion?.version ?? related.forkOf.version,
            at: params.now,
          }
        : {
            skillId: params.toSkillId,
            kind: "duplicate",
            version: params.targetVersion?.version,
            at: params.now,
          },
      updatedAt: params.now,
    });
  }
}

function normalizeScannerSuspiciousReason(reason: string | undefined) {
  if (!reason) return reason;
  if (!reason.startsWith("scanner.")) return reason;
  if (reason.endsWith(".suspicious")) {
    return `${reason.slice(0, -".suspicious".length)}.clean`;
  }
  if (reason.endsWith(".malicious")) {
    return `${reason.slice(0, -".malicious".length)}.clean`;
  }
  return reason;
}

async function adjustGlobalPublicCountForSkillChange(
  ctx: MutationCtx,
  previousSkill: Doc<"skills"> | null | undefined,
  nextSkill: Doc<"skills"> | null | undefined,
) {
  const delta = getPublicSkillVisibilityDelta(previousSkill, nextSkill);
  if (delta === 0) return;
  await adjustGlobalPublicSkillsCount(ctx, delta);
}

async function getOwnerPublishActivity(
  ctx: QueryCtx | MutationCtx,
  ownerUserId: Id<"users">,
  now: number,
): Promise<OwnerPublishActivity> {
  const ownerSkills = await ctx.db
    .query("skills")
    .withIndex("by_owner", (q) => q.eq("ownerUserId", ownerUserId))
    .order("desc")
    .take(OWNER_ACTIVITY_SCAN_LIMIT);

  const dayThreshold = now - RATE_LIMIT_DAY_MS;
  let skillsLastDay = 0;

  for (const skill of ownerSkills) {
    if (skill.createdAt >= dayThreshold) {
      skillsLastDay += 1;
    }
  }

  return { skillsLastDay };
}

function enforceNewSkillRateLimit(activity: OwnerPublishActivity) {
  if (activity.skillsLastDay >= NEW_SKILL_DAILY_LIMIT) {
    throw new ConvexError(
      `Rate limit: max ${NEW_SKILL_DAILY_LIMIT} new skills per 24 hours. Please wait before publishing more.`,
    );
  }
}

const HARD_DELETE_PHASES = [
  "versions",
  "fingerprints",
  "githubScans",
  "skillCardJobs",
  "embeddings",
  "reports",
  "stars",
  "badges",
  "dailyStats",
  "statEvents",
  "installs",
  "installTelemetryDedupes",
  "leaderboards",
  "canonical",
  "forks",
  "finalize",
] as const;

type HardDeletePhase = (typeof HARD_DELETE_PHASES)[number];
type HardDeleteSource = "admin" | "account.delete" | "publisher.delete";
type HardDeleteScope = {
  source?: HardDeleteSource;
  ownerPublisherId?: Id<"publishers">;
  reason?: string;
};

const hardDeleteSourceValidator = v.optional(
  v.union(v.literal("admin"), v.literal("account.delete"), v.literal("publisher.delete")),
);

function isHardDeletePhase(value: string | undefined): value is HardDeletePhase {
  if (!value) return false;
  return (HARD_DELETE_PHASES as readonly string[]).includes(value);
}

async function scheduleHardDelete(
  ctx: MutationCtx,
  skillId: Id<"skills">,
  actorUserId: Id<"users">,
  phase: HardDeletePhase,
  scope: HardDeleteScope = {},
) {
  await ctx.scheduler.runAfter(0, internal.skills.hardDeleteInternal, {
    skillId,
    actorUserId,
    phase,
    source: scope.source,
    ownerPublisherId: scope.ownerPublisherId,
    reason: scope.reason,
  });
}

async function hardDeleteSkillStep(
  ctx: MutationCtx,
  skill: Doc<"skills">,
  actorUserId: Id<"users">,
  phase: HardDeletePhase,
  scope: HardDeleteScope = {},
) {
  const now = Date.now();
  const patch: Partial<Doc<"skills">> = {};
  if (!skill.softDeletedAt) patch.softDeletedAt = now;
  if (skill.moderationStatus !== "removed") patch.moderationStatus = "removed";
  if (!skill.hiddenAt) patch.hiddenAt = now;
  if (!skill.hiddenBy) patch.hiddenBy = actorUserId;
  if (Object.keys(patch).length) {
    patch.lastReviewedAt = now;
    patch.updatedAt = now;
    const nextSkill = { ...skill, ...patch };
    await ctx.db.patch(skill._id, patch);
    await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);
    await adjustUserSkillStatsForSkillChange(ctx, skill, nextSkill);
  }

  switch (phase) {
    case "versions": {
      const versions = await ctx.db
        .query("skillVersions")
        .withIndex("by_skill", (q) => q.eq("skillId", skill._id))
        .take(HARD_DELETE_VERSION_BATCH_SIZE);
      for (const version of versions) {
        await ctx.db.delete(version._id);
      }
      if (versions.length === HARD_DELETE_VERSION_BATCH_SIZE) {
        await scheduleHardDelete(ctx, skill._id, actorUserId, "versions", scope);
        return;
      }
      await scheduleHardDelete(ctx, skill._id, actorUserId, "fingerprints", scope);
      return;
    }
    case "fingerprints": {
      const fingerprints = await ctx.db
        .query("skillVersionFingerprints")
        .withIndex("by_skill_fingerprint", (q) => q.eq("skillId", skill._id))
        .take(HARD_DELETE_BATCH_SIZE);
      for (const fingerprint of fingerprints) {
        await ctx.db.delete(fingerprint._id);
      }
      if (fingerprints.length === HARD_DELETE_BATCH_SIZE) {
        await scheduleHardDelete(ctx, skill._id, actorUserId, "fingerprints", scope);
        return;
      }
      await scheduleHardDelete(ctx, skill._id, actorUserId, "githubScans", scope);
      return;
    }
    case "githubScans": {
      const deletedScans = await deleteGitHubSkillScansForSkill(
        ctx,
        skill._id,
        HARD_DELETE_BATCH_SIZE,
      );
      if (deletedScans === HARD_DELETE_BATCH_SIZE) {
        await scheduleHardDelete(ctx, skill._id, actorUserId, "githubScans", scope);
        return;
      }
      await scheduleHardDelete(ctx, skill._id, actorUserId, "skillCardJobs", scope);
      return;
    }
    case "skillCardJobs": {
      const jobs = await ctx.db
        .query("skillCardGenerationJobs")
        .withIndex("by_skill", (q) => q.eq("skillId", skill._id))
        .take(HARD_DELETE_BATCH_SIZE);
      for (const job of jobs) {
        await ctx.db.delete(job._id);
      }
      if (jobs.length === HARD_DELETE_BATCH_SIZE) {
        await scheduleHardDelete(ctx, skill._id, actorUserId, "skillCardJobs", scope);
        return;
      }
      await scheduleHardDelete(ctx, skill._id, actorUserId, "embeddings", scope);
      return;
    }
    case "embeddings": {
      const embeddings = await ctx.db
        .query("skillEmbeddings")
        .withIndex("by_skill", (q) => q.eq("skillId", skill._id))
        .take(HARD_DELETE_BATCH_SIZE);
      for (const embedding of embeddings) {
        const maps = await ctx.db
          .query("embeddingSkillMap")
          .withIndex("by_embedding", (q) => q.eq("embeddingId", embedding._id))
          .collect();
        for (const map of maps) await ctx.db.delete(map._id);
        await ctx.db.delete(embedding._id);
      }
      if (embeddings.length === HARD_DELETE_BATCH_SIZE) {
        await scheduleHardDelete(ctx, skill._id, actorUserId, "embeddings", scope);
        return;
      }
      await scheduleHardDelete(ctx, skill._id, actorUserId, "reports", scope);
      return;
    }
    case "reports": {
      const reports = await ctx.db
        .query("skillReports")
        .withIndex("by_skill", (q) => q.eq("skillId", skill._id))
        .take(HARD_DELETE_BATCH_SIZE);
      for (const report of reports) {
        await ctx.db.delete(report._id);
      }
      if (reports.length === HARD_DELETE_BATCH_SIZE) {
        await scheduleHardDelete(ctx, skill._id, actorUserId, "reports", scope);
        return;
      }
      await scheduleHardDelete(ctx, skill._id, actorUserId, "stars", scope);
      return;
    }
    case "stars": {
      const stars = await ctx.db
        .query("stars")
        .withIndex("by_skill", (q) => q.eq("skillId", skill._id))
        .take(HARD_DELETE_BATCH_SIZE);
      for (const star of stars) {
        await ctx.db.delete(star._id);
      }
      if (stars.length === HARD_DELETE_BATCH_SIZE) {
        await scheduleHardDelete(ctx, skill._id, actorUserId, "stars", scope);
        return;
      }
      await scheduleHardDelete(ctx, skill._id, actorUserId, "badges", scope);
      return;
    }
    case "badges": {
      const badges = await ctx.db
        .query("skillBadges")
        .withIndex("by_skill", (q) => q.eq("skillId", skill._id))
        .take(HARD_DELETE_BATCH_SIZE);
      for (const badge of badges) {
        await ctx.db.delete(badge._id);
      }
      if (badges.length === HARD_DELETE_BATCH_SIZE) {
        await scheduleHardDelete(ctx, skill._id, actorUserId, "badges", scope);
        return;
      }
      await scheduleHardDelete(ctx, skill._id, actorUserId, "dailyStats", scope);
      return;
    }
    case "dailyStats": {
      const dailyStats = await ctx.db
        .query("skillDailyStats")
        .withIndex("by_skill_day", (q) => q.eq("skillId", skill._id))
        .take(HARD_DELETE_BATCH_SIZE);
      for (const stat of dailyStats) {
        await ctx.db.delete(stat._id);
      }
      if (dailyStats.length === HARD_DELETE_BATCH_SIZE) {
        await scheduleHardDelete(ctx, skill._id, actorUserId, "dailyStats", scope);
        return;
      }
      await scheduleHardDelete(ctx, skill._id, actorUserId, "statEvents", scope);
      return;
    }
    case "statEvents": {
      const statEvents = await ctx.db
        .query("skillStatEvents")
        .withIndex("by_skill", (q) => q.eq("skillId", skill._id))
        .take(HARD_DELETE_BATCH_SIZE);
      for (const statEvent of statEvents) {
        await ctx.db.delete(statEvent._id);
      }
      if (statEvents.length === HARD_DELETE_BATCH_SIZE) {
        await scheduleHardDelete(ctx, skill._id, actorUserId, "statEvents", scope);
        return;
      }
      await scheduleHardDelete(ctx, skill._id, actorUserId, "installs", scope);
      return;
    }
    case "installs": {
      const installs = await ctx.db
        .query("userSkillInstalls")
        .withIndex("by_skill", (q) => q.eq("skillId", skill._id))
        .take(HARD_DELETE_BATCH_SIZE);
      for (const install of installs) {
        await ctx.db.delete(install._id);
      }
      if (installs.length === HARD_DELETE_BATCH_SIZE) {
        await scheduleHardDelete(ctx, skill._id, actorUserId, "installs", scope);
        return;
      }
      await scheduleHardDelete(ctx, skill._id, actorUserId, "installTelemetryDedupes", scope);
      return;
    }
    case "installTelemetryDedupes": {
      const dedupeRows = await ctx.db
        .query("installTelemetryDedupes")
        .withIndex("by_skill", (q) => q.eq("skillId", skill._id))
        .take(HARD_DELETE_BATCH_SIZE);
      for (const row of dedupeRows) {
        await ctx.db.delete(row._id);
      }
      if (dedupeRows.length === HARD_DELETE_BATCH_SIZE) {
        await scheduleHardDelete(ctx, skill._id, actorUserId, "installTelemetryDedupes", scope);
        return;
      }
      await scheduleHardDelete(ctx, skill._id, actorUserId, "leaderboards", scope);
      return;
    }
    case "leaderboards": {
      const leaderboards = await ctx.db
        .query("skillLeaderboards")
        .take(HARD_DELETE_LEADERBOARD_BATCH_SIZE);
      for (const leaderboard of leaderboards) {
        const items = leaderboard.items.filter((item) => item.skillId !== skill._id);
        if (items.length !== leaderboard.items.length) {
          await ctx.db.patch(leaderboard._id, { items });
        }
      }
      if (leaderboards.length === HARD_DELETE_LEADERBOARD_BATCH_SIZE) {
        await scheduleHardDelete(ctx, skill._id, actorUserId, "leaderboards", scope);
        return;
      }
      await scheduleHardDelete(ctx, skill._id, actorUserId, "canonical", scope);
      return;
    }
    case "canonical": {
      const canonicalRefs = await ctx.db
        .query("skills")
        .withIndex("by_canonical", (q) => q.eq("canonicalSkillId", skill._id))
        .take(HARD_DELETE_BATCH_SIZE);
      for (const related of canonicalRefs) {
        await ctx.db.patch(related._id, {
          canonicalSkillId: undefined,
          updatedAt: now,
        });
      }
      if (canonicalRefs.length === HARD_DELETE_BATCH_SIZE) {
        await scheduleHardDelete(ctx, skill._id, actorUserId, "canonical", scope);
        return;
      }
      await scheduleHardDelete(ctx, skill._id, actorUserId, "forks", scope);
      return;
    }
    case "forks": {
      const forkRefs = await ctx.db
        .query("skills")
        .withIndex("by_fork_of", (q) => q.eq("forkOf.skillId", skill._id))
        .take(HARD_DELETE_BATCH_SIZE);
      for (const related of forkRefs) {
        await ctx.db.patch(related._id, {
          forkOf: undefined,
          updatedAt: now,
        });
      }
      if (forkRefs.length === HARD_DELETE_BATCH_SIZE) {
        await scheduleHardDelete(ctx, skill._id, actorUserId, "forks", scope);
        return;
      }
      await scheduleHardDelete(ctx, skill._id, actorUserId, "finalize", scope);
      return;
    }
    case "finalize": {
      await reserveSlugForHardDeleteFinalize(ctx, {
        slug: skill.slug,
        originalOwnerUserId: skill.ownerUserId,
        originalOwnerPublisherId: skill.ownerPublisherId,
        deletedAt: now,
        expiresAt: now + SLUG_RESERVATION_MS,
      });

      await ctx.db.delete(skill._id);
      await ctx.db.insert("auditLogs", {
        actorUserId,
        action: "skill.hard_delete",
        targetType: "skill",
        targetId: skill._id,
        metadata: {
          slug: skill.slug,
          source: scope.source ?? "admin",
          ...(scope.reason ? { reason: scope.reason } : {}),
        },
        createdAt: now,
      });
      return;
    }
  }
}

type PublicSkillEntry = {
  skill: NonNullable<ReturnType<typeof toPublicSkill>>;
  latestVersion: PublicSkillListVersion | null;
  ownerHandle: string | null;
  owner: PublicPublisher | null;
};

type StaffSkillAuditLogEntry = Doc<"auditLogs"> & {
  actor: ReturnType<typeof toPublicUser> | null;
};

async function loadPublicSkillReference(ctx: QueryCtx, skillId: Id<"skills"> | null | undefined) {
  if (!skillId) return null;
  const skill = await ctx.db.get(skillId);
  if (!isPublicSkillDoc(skill)) return null;

  const owner = toPublicPublisher(
    await getOwnerPublisher(ctx, {
      ownerPublisherId: skill.ownerPublisherId,
      ownerUserId: skill.ownerUserId,
    }),
  );
  if (!owner) return null;

  return { skill, owner };
}

type PublicSkillListVersion = Pick<
  Doc<"skillVersions">,
  "_id" | "_creationTime" | "skillId" | "version" | "createdAt" | "changelog" | "changelogSource"
> & {
  parsed?: PublicSkillVersionParsed;
};

type PublicSkillVersionParsed = {
  license?: typeof PLATFORM_SKILL_LICENSE;
  description?: string;
  clawdis?: {
    os?: string[];
    nix?: {
      plugin?: boolean;
      systems?: string[];
    };
  };
};

type PublicSkillVersion = {
  _id: Id<"skillVersions">;
  _creationTime?: number;
  skillId?: Id<"skills">;
  version: string;
  fingerprint?: string;
  changelog?: string;
  changelogSource?: Doc<"skillVersions">["changelogSource"];
  files: Array<{
    path: string;
    size: number;
    sha256: string;
    contentType?: string;
  }>;
  parsed?: PublicSkillVersionParsed;
  createdBy?: Id<"users">;
  createdAt?: number;
  softDeletedAt?: number;
  sha256hash?: string;
  vtAnalysis?: Doc<"skillVersions">["vtAnalysis"];
  aigAnalysis?: Doc<"skillVersions">["aigAnalysis"];
  skillSpectorAnalysis?: Doc<"skillVersions">["skillSpectorAnalysis"];
  llmAnalysis?: Doc<"skillVersions">["llmAnalysis"];
  staticScan?: {
    status: NonNullable<Doc<"skillVersions">["staticScan"]>["status"];
    reasonCodes: NonNullable<Doc<"skillVersions">["staticScan"]>["reasonCodes"];
    findings: Array<{
      code: string;
      severity: "info" | "warn" | "critical";
      file: string;
      line: number;
      message: string;
      evidence: string;
    }>;
    summary: NonNullable<Doc<"skillVersions">["staticScan"]>["summary"];
    engineVersion: NonNullable<Doc<"skillVersions">["staticScan"]>["engineVersion"];
    checkedAt: NonNullable<Doc<"skillVersions">["staticScan"]>["checkedAt"];
  };
  generatedSkillCard?: {
    path: string;
    size: number;
    sha256: string;
    contentType?: string;
  } | null;
};

type ManagementSkillEntry = {
  skill: Doc<"skills">;
  latestVersion: Doc<"skillVersions"> | null;
  owner: Doc<"users"> | null;
};

type DashboardSkillListItem = {
  _id: Id<"skills">;
  _creationTime: number;
  slug: string;
  displayName: string;
  summary?: string;
  ownerUserId: Id<"users">;
  ownerPublisherId?: Id<"publishers">;
  canonicalSkillId?: Id<"skills">;
  forkOf?: Doc<"skills">["forkOf"];
  latestVersionId?: Id<"skillVersions">;
  tags: Doc<"skills">["tags"];
  badges: Doc<"skills">["badges"];
  stats: Doc<"skills">["stats"];
  metricSources: ReturnType<typeof readSkillMetricSources>;
  moderationStatus?: Doc<"skills">["moderationStatus"];
  moderationReason?: string;
  moderationSummary?: string;
  moderationVerdict?: Doc<"skills">["moderationVerdict"];
  moderationFlags?: string[];
  isSuspicious?: boolean;
  pendingReview?: true;
  qualityDecision?: NonNullable<Doc<"skills">["quality"]>["decision"];
  latestVersion: {
    version: string;
    createdAt: number;
    vtStatus: string | null;
    llmStatus: string | null;
    staticScanStatus: "clean" | "suspicious" | "malicious" | null;
  } | null;
  createdAt: number;
  updatedAt: number;
};

type BadgeKind = Doc<"skillBadges">["kind"];

async function buildPublicSkillEntries(
  ctx: QueryCtx,
  skills: HydratableSkill[],
  opts?: {
    includeVersion?: boolean;
    preResolvedOwners?: Map<
      Id<"skills">,
      { ownerHandle: string | null; owner: PublicPublisher | null }
    >;
  },
) {
  const includeVersion = opts?.includeVersion ?? true;
  const ownerInfoCache = new Map<
    string,
    Promise<{
      ownerHandle: string | null;
      owner: PublicPublisher | null;
    }>
  >();

  const getOwnerInfo = (
    skillId: Id<"skills">,
    ownerUserId: Id<"users">,
    ownerPublisherId?: Id<"publishers"> | null,
  ) => {
    // Use pre-resolved owner from digest when available to avoid adding the
    // users table to the reactive read set (which causes thundering-herd
    // invalidation on every user-doc write).
    const preResolved = opts?.preResolvedOwners?.get(skillId);
    if (preResolved?.owner) return Promise.resolve(preResolved);

    const cacheKey = String(ownerPublisherId ?? ownerUserId);
    const cached = ownerInfoCache.get(cacheKey);
    if (cached) return cached;
    const ownerPromise = getOwnerPublisher(ctx, {
      ownerPublisherId,
      ownerUserId,
    }).then((ownerDoc) => {
      return toPublicPublisherWithOfficial(ctx, ownerDoc).then((publicOwner) => {
        if (!publicOwner) {
          return { ownerHandle: null, owner: null };
        }
        return {
          ownerHandle: publicOwner.handle ?? String(publicOwner._id),
          owner: publicOwner,
        };
      });
    });
    ownerInfoCache.set(cacheKey, ownerPromise);
    return ownerPromise;
  };

  const entries = await Promise.all(
    skills.map(async (skill) => {
      // Use denormalized summary when available to avoid reading the full ~6KB version doc.
      const summary = skill.latestVersionSummary;
      const hasSummary = includeVersion && summary;
      const [latestVersionDoc, ownerInfo] = await Promise.all([
        includeVersion && skill.latestVersionId
          ? loadPublicLatestVersionForSkill(ctx, skill)
          : null,
        getOwnerInfo(skill._id, skill.ownerUserId, skill.ownerPublisherId),
      ]);
      const publicSkill = toPublicSkill(skill);
      if (!publicSkill || !ownerInfo.owner) return null;
      const latestVersion =
        hasSummary && latestVersionDoc
          ? toPublicSkillListVersionFromSummary(summary!, latestVersionDoc._id, skill._id)
          : toPublicSkillListVersion(latestVersionDoc);
      return {
        skill: publicSkill,
        latestVersion,
        ownerHandle: ownerInfo.ownerHandle,
        owner: ownerInfo.owner,
      };
    }),
  );

  return entries.filter(Boolean) as PublicSkillEntry[];
}

async function filterSkillsByActiveOwner(ctx: Pick<QueryCtx, "db">, skills: Doc<"skills">[]) {
  const ownerCache = new Map<Id<"users">, Promise<Doc<"users"> | null>>();

  const getOwner = (ownerUserId: Id<"users">) => {
    const cached = ownerCache.get(ownerUserId);
    if (cached) return cached;
    const ownerPromise = ctx.db.get(ownerUserId);
    ownerCache.set(ownerUserId, ownerPromise);
    return ownerPromise;
  };

  const filtered = await Promise.all(
    skills.map(async (skill) => {
      const owner = await getOwner(skill.ownerUserId);
      if (!owner || owner.deletedAt || owner.deactivatedAt) return null;
      return skill;
    }),
  );

  return filtered.filter((skill): skill is Doc<"skills"> => skill !== null);
}

async function skillBelongsToOwnerUserDashboardScope(
  ctx: Pick<QueryCtx, "db">,
  skill: Pick<Doc<"skills">, "ownerUserId" | "ownerPublisherId">,
  ownerUserId: Id<"users">,
) {
  if (skill.ownerUserId !== ownerUserId) return false;
  if (!skill.ownerPublisherId) return true;
  const ownerPublisher = await ctx.db.get(skill.ownerPublisherId);
  if (!ownerPublisher || !isPublisherActive(ownerPublisher) || ownerPublisher.kind !== "user") {
    return false;
  }
  return ownerPublisher.linkedUserId ? ownerPublisher.linkedUserId === ownerUserId : true;
}

async function filterSkillsForOwnerUserDashboard(
  ctx: Pick<QueryCtx, "db">,
  skills: Doc<"skills">[],
  ownerUserId: Id<"users">,
) {
  const scoped = await Promise.all(
    skills.map(async (skill) =>
      (await skillBelongsToOwnerUserDashboardScope(ctx, skill, ownerUserId)) ? skill : null,
    ),
  );
  return scoped.filter((skill): skill is Doc<"skills"> => Boolean(skill));
}

async function loadPublicLatestVersionForSkill(
  ctx: Pick<QueryCtx, "db">,
  skill: Pick<Doc<"skills">, "_id" | "latestVersionId">,
) {
  if (!skill.latestVersionId) return null;
  const version = await ctx.db.get(skill.latestVersionId);
  return isPublicSkillVersionAvailableForSkill(version, skill._id) ? version : null;
}

function toPublicSkillListVersion(
  version: Doc<"skillVersions"> | null,
): PublicSkillListVersion | null {
  if (!version) return null;
  return {
    _id: version._id,
    _creationTime: version._creationTime,
    skillId: version.skillId,
    version: version.version,
    createdAt: version.createdAt,
    changelog: version.changelog,
    changelogSource: version.changelogSource,
    parsed:
      version.parsed?.clawdis || version.parsed?.license
        ? {
            ...(version.parsed?.license ? { license: version.parsed.license } : {}),
            ...(version.parsed?.clawdis ? { clawdis: version.parsed.clawdis } : {}),
          }
        : undefined,
  };
}

function toPublicSkillVersion(
  version: Doc<"skillVersions"> | null | undefined,
): PublicSkillVersion | null {
  if (!version) return null;
  const description = skillSummaryFromSkillVersion(version);
  return {
    _id: version._id,
    _creationTime: version._creationTime,
    skillId: version.skillId,
    version: version.version,
    fingerprint: version.fingerprint,
    changelog: version.changelog,
    changelogSource: version.changelogSource,
    files: (version.files ?? []).map((file) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256,
      contentType: normalizeContentType(file.contentType),
    })),
    parsed: version.parsed
      ? {
          license: version.parsed.license,
          ...(description ? { description } : {}),
          clawdis: version.parsed.clawdis,
        }
      : undefined,
    createdBy: version.createdBy,
    createdAt: version.createdAt,
    softDeletedAt: version.softDeletedAt,
    sha256hash: version.sha256hash,
    vtAnalysis: version.vtAnalysis,
    aigAnalysis: version.aigAnalysis,
    skillSpectorAnalysis: version.skillSpectorAnalysis,
    llmAnalysis: version.llmAnalysis,
    staticScan: version.staticScan
      ? {
          status: version.staticScan.status,
          reasonCodes: version.staticScan.reasonCodes,
          findings: (version.staticScan.findings ?? []).map((finding) => ({
            code: finding.code,
            severity: finding.severity,
            file: finding.file,
            line: finding.line,
            message: finding.message,
            evidence: "",
          })),
          summary: version.staticScan.summary,
          engineVersion: version.staticScan.engineVersion,
          checkedAt: version.staticScan.checkedAt,
        }
      : undefined,
  };
}

function toManagerSkillVersion(version: Doc<"skillVersions">) {
  return {
    ...toPublicSkillVersion(version)!,
    ownerDeletedAt: version.ownerDeletedAt,
  };
}

function toPublicGitHubSkillScan(
  scan: Doc<"githubSkillScans"> | null | undefined,
  version: string | undefined,
  currentCommit: string | undefined,
  currentPath: string | undefined,
) {
  if (!scan) return null;
  const commit = currentCommit ?? scan.commit;
  return {
    _id: scan._id,
    contentHash: scan.contentHash,
    commit,
    path: currentPath ?? scan.path,
    status: scan.status,
    version: version ?? commit.slice(0, 12),
    aigAnalysis: scan.aigAnalysis,
    skillSpectorAnalysis: scan.skillSpectorAnalysis,
    llmAnalysis: scan.llmAnalysis,
    staticScan: scan.staticScan
      ? {
          ...scan.staticScan,
          findings: scan.staticScan.findings.map((finding) => ({ ...finding, evidence: "" })),
        }
      : undefined,
    completedAt: scan.completedAt,
    createdAt: scan.createdAt,
    updatedAt: scan.updatedAt,
  };
}

function toPublicSkillCardFile(file: Doc<"skillVersions">["files"][number]) {
  return {
    path: file.path,
    size: file.size,
    sha256: file.sha256,
    contentType: normalizeContentType(file.contentType),
  };
}

async function getGeneratedSkillCardPublicFile(
  ctx: Pick<QueryCtx, "db">,
  version: Doc<"skillVersions"> | null,
) {
  if (!version) return null;
  const files = Array.isArray(version.files) ? version.files : [];
  if (!selectSkillCardFile(files)) return null;
  const entries = await ctx.db
    .query("skillVersionFingerprints")
    .withIndex("by_version_kind", (q) =>
      q.eq("versionId", version._id).eq("kind", "generated-bundle"),
    )
    .collect();
  const file = await selectGeneratedSkillCardFile(
    files,
    entries.map((entry) => entry.fingerprint),
  );
  return file ? toPublicSkillCardFile(file) : null;
}

function toPublicSkillListVersionFromSummary(
  summary: NonNullable<Doc<"skills">["latestVersionSummary"]>,
  latestVersionId: Id<"skillVersions"> | undefined,
  skillId: Id<"skills">,
): PublicSkillListVersion | null {
  if (!latestVersionId) return null;
  return {
    _id: latestVersionId,
    skillId,
    // Approximates _creationTime; both are set to `now` in the same transaction
    _creationTime: summary.createdAt,
    version: summary.version,
    createdAt: summary.createdAt,
    changelog: summary.changelog,
    changelogSource: summary.changelogSource,
    parsed:
      summary.description || summary.clawdis
        ? {
            ...(summary.description ? { description: summary.description } : {}),
            ...(summary.clawdis ? { clawdis: summary.clawdis } : {}),
          }
        : undefined,
  };
}

async function buildSkillActivityTrend(
  ctx: Pick<QueryCtx, "db">,
  skill: Doc<"skills">,
  endDay: number,
) {
  const safeEndDay = clampActivityTrendEndDay(endDay, Date.now());
  const { startDay, endDay: normalizedEndDay } = getActivityTrendRangeForEndDay(safeEndDay);
  const rows = await ctx.db
    .query("skillDailyStats")
    .withIndex("by_skill_day", (q) =>
      q.eq("skillId", skill._id).gte("day", startDay).lte("day", normalizedEndDay),
    )
    .take(ACTIVITY_TREND_DAYS);

  return buildDailyMetricTrends(rows, normalizedEndDay);
}

async function buildManagementSkillEntries(ctx: QueryCtx, skills: Doc<"skills">[]) {
  const ownerCache = new Map<Id<"users">, Promise<Doc<"users"> | null>>();
  const badgeMapBySkillId = await getSkillBadgeMaps(
    ctx,
    skills.map((skill) => skill._id),
  );

  const getOwner = (ownerUserId: Id<"users">) => {
    const cached = ownerCache.get(ownerUserId);
    if (cached) return cached;
    const ownerPromise = ctx.db.get(ownerUserId);
    ownerCache.set(ownerUserId, ownerPromise);
    return ownerPromise;
  };

  return Promise.all(
    skills.map(async (skill) => {
      const [latestVersion, owner] = await Promise.all([
        skill.latestVersionId ? ctx.db.get(skill.latestVersionId) : null,
        getOwner(skill.ownerUserId),
      ]);
      const badges = badgeMapBySkillId.get(skill._id) ?? {};
      return {
        skill: { ...skill, badges },
        latestVersion,
        owner,
      };
    }),
  ) satisfies Promise<ManagementSkillEntry[]>;
}

async function attachBadgesToSkills(ctx: QueryCtx, skills: Doc<"skills">[]) {
  const badgeMapBySkillId = await getSkillBadgeMaps(
    ctx,
    skills.map((skill) => skill._id),
  );
  return skills.map((skill) => ({
    ...skill,
    badges: badgeMapBySkillId.get(skill._id) ?? {},
  }));
}

async function toDashboardSkillListItem(
  ctx: QueryCtx,
  skill: Doc<"skills"> & { badges?: Doc<"skills">["badges"] },
): Promise<DashboardSkillListItem> {
  const latestVersion = skill.latestVersionId ? await ctx.db.get(skill.latestVersionId) : null;
  const stats = {
    ...skill.stats,
    downloads: readPublicDownloads(skill),
    stars: readCanonicalStat(skill, "stars"),
    installsCurrent: readCanonicalStat(skill, "installsCurrent"),
    installsAllTime: readCanonicalStat(skill, "installsAllTime"),
  };

  return {
    _id: skill._id,
    _creationTime: skill._creationTime,
    slug: skill.slug,
    displayName: skill.displayName,
    summary: skill.summary,
    ownerUserId: skill.ownerUserId,
    ownerPublisherId: skill.ownerPublisherId,
    canonicalSkillId: skill.canonicalSkillId,
    forkOf: skill.forkOf,
    latestVersionId: skill.latestVersionId,
    tags: skill.tags,
    badges: skill.badges,
    stats,
    metricSources: readSkillMetricSources(skill),
    moderationStatus: skill.moderationStatus,
    moderationReason: skill.moderationReason,
    moderationSummary: skill.moderationSummary,
    moderationVerdict: skill.moderationVerdict,
    moderationFlags: skill.moderationFlags,
    isSuspicious: skill.isSuspicious,
    pendingReview:
      skill.moderationStatus === "hidden" &&
      (skill.moderationReason === "pending.scan" || skill.moderationReason === "pending.scan.stale")
        ? true
        : undefined,
    qualityDecision: skill.quality?.decision,
    latestVersion:
      latestVersion && !latestVersion.softDeletedAt
        ? {
            version: latestVersion.version,
            createdAt: latestVersion.createdAt,
            vtStatus: latestVersion.vtAnalysis?.status ?? null,
            llmStatus: latestVersion.llmAnalysis?.status ?? null,
            staticScanStatus: latestVersion.staticScan?.status ?? null,
          }
        : null,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

async function loadHighlightedSkills(ctx: QueryCtx, limit: number) {
  const entries = await ctx.db
    .query("skillBadges")
    .withIndex("by_kind_at", (q) => q.eq("kind", "highlighted"))
    .order("desc")
    .take(MAX_LIST_TAKE);

  const skills: Doc<"skills">[] = [];
  for (const badge of entries) {
    const skill = await ctx.db.get(badge.skillId);
    if (!skill || skill.softDeletedAt) continue;
    skills.push(skill);
    if (skills.length >= limit) break;
  }

  return skills;
}

async function upsertSkillBadge(
  ctx: MutationCtx,
  skillId: Id<"skills">,
  kind: BadgeKind,
  userId: Id<"users">,
  at: number,
) {
  const existing = await ctx.db
    .query("skillBadges")
    .withIndex("by_skill_kind", (q) => q.eq("skillId", skillId).eq("kind", kind))
    .unique();
  if (existing) {
    await ctx.db.patch(existing._id, { byUserId: userId, at });
  } else {
    await ctx.db.insert("skillBadges", {
      skillId,
      kind,
      byUserId: userId,
      at,
    });
  }
  // Keep denormalized badges field on skill doc in sync
  const skill = await ctx.db.get(skillId);
  if (skill) {
    await ctx.db.patch(skillId, {
      badges: {
        ...(skill.badges as Record<string, unknown> | undefined),
        [kind]: { byUserId: userId, at },
      },
    });
  }
}

async function removeSkillBadge(ctx: MutationCtx, skillId: Id<"skills">, kind: BadgeKind) {
  const existing = await ctx.db
    .query("skillBadges")
    .withIndex("by_skill_kind", (q) => q.eq("skillId", skillId).eq("kind", kind))
    .unique();
  if (existing) {
    await ctx.db.delete(existing._id);
  }
  // Keep denormalized badges field on skill doc in sync
  const skill = await ctx.db.get(skillId);
  if (skill) {
    const { [kind]: _, ...remainingBadges } = (skill.badges ?? {}) as Record<string, unknown>;
    await ctx.db.patch(skillId, { badges: remainingBadges });
  }
}

async function resolveSkillBySlugOrAliasForOwner(
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  slug: string,
  ownerHandle?: string,
  options: { includeSoftDeleted?: boolean; includeInactiveOwnerFallback?: boolean } = {},
) {
  let skill: Doc<"skills"> | null = null;
  let requestedSlug = normalizeSkillSlugKey(slug);
  let resolvedSlug: string | null = null;
  if (ownerHandle) {
    const resolvedOwner = await resolvePublisherByOwnerHandle(ctx, ownerHandle);
    const scopedOwnerPublisher = resolvedOwner.publisher;
    if (scopedOwnerPublisher && requestedSlug) {
      skill = await getSkillBySlugForPublisher(ctx, requestedSlug, scopedOwnerPublisher);
      if (skill?.softDeletedAt && !options.includeSoftDeleted) {
        skill = null;
      }
      if (!skill) {
        const alias = await getSkillSlugAliasBySlugForPublisher(
          ctx,
          requestedSlug,
          scopedOwnerPublisher,
        );
        skill = alias ? await ctx.db.get(alias.skillId) : null;
        if (skill?.softDeletedAt && !options.includeSoftDeleted) {
          skill = null;
        }
      }
      resolvedSlug = skill?.slug ?? null;
    }
    if (!skill && options.includeInactiveOwnerFallback) {
      const legacyResolved = await resolveLegacySkillBySlugOrAlias(ctx, requestedSlug, {
        includeSoftDeleted: options.includeSoftDeleted,
        ownerHandle,
      });
      if (legacyResolved.ambiguous) {
        return {
          requestedSlug,
          resolvedSlug,
          skill: null,
          ambiguous: true as const,
          ambiguousMatches: legacyResolved.ambiguousMatches,
        };
      }
      skill = legacyResolved.skill;
      requestedSlug = legacyResolved.requestedSlug;
      resolvedSlug = legacyResolved.resolvedSlug;
    }
  } else {
    const resolved = await resolveSkillBySlugOrAlias(ctx, slug, options);
    if (resolved.ambiguous) {
      return {
        requestedSlug,
        resolvedSlug,
        skill: null,
        ambiguous: true as const,
        ambiguousMatches: resolved.ambiguousMatches,
      };
    }
    skill = resolved.skill;
    requestedSlug = resolved.requestedSlug;
    resolvedSlug = resolved.resolvedSlug;
  }
  return {
    requestedSlug,
    resolvedSlug,
    skill,
    ambiguous: false as const,
    ambiguousMatches: [] as LegacyAmbiguousSkillMatch[],
  };
}

function isDirectSkillOwner(
  skill: Pick<Doc<"skills">, "ownerUserId" | "ownerPublisherId">,
  userId: Id<"users">,
) {
  return !skill.ownerPublisherId && skill.ownerUserId === userId;
}

export const getGitHubScanForAudit = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const resolved = await resolveSkillBySlugOrAlias(ctx, args.slug);
    const skill = resolved.skill;
    if (
      !skill ||
      skill.installKind !== "github" ||
      !skill.githubCurrentContentHash ||
      !skill.githubCurrentCommit ||
      !skill.githubPath
    ) {
      return null;
    }

    const ownerPublisher = await getOwnerPublisher(ctx, {
      ownerPublisherId: skill.ownerPublisherId,
      ownerUserId: skill.ownerUserId,
    });
    if (!toPublicPublisher(ownerPublisher)) return null;
    const skillOwnerRef = {
      ownerPublisherId: skill.ownerPublisherId,
      ownerUserId: skill.ownerUserId,
    };

    const isMalwareBlocked =
      skill.moderationVerdict === "malicious" ||
      (skill.moderationFlags?.includes("blocked.malware") ?? false);
    if (isMalwareBlocked) return null;

    if (!isPublicSkillDoc(skill)) {
      const userId = await getOptionalActiveAuthUserId(ctx);
      const skillOwnerPublisher = skillOwnerRef.ownerPublisherId
        ? await ctx.db.get(skillOwnerRef.ownerPublisherId)
        : null;
      const publisherOwner =
        userId && skillOwnerPublisher
          ? await canAccessPublisherOwnerScope(ctx, {
              publisher: skillOwnerPublisher,
              userId,
              legacyOwnerUserId: skillOwnerRef.ownerUserId,
            })
          : false;
      if (!userId || (!isDirectSkillOwner(skillOwnerRef, userId) && !publisherOwner)) return null;
    }

    const scan = await ctx.db
      .query("githubSkillScans")
      .withIndex("by_skill_and_content_hash", (q) =>
        q.eq("skillId", skill._id).eq("contentHash", skill.githubCurrentContentHash as string),
      )
      .unique();
    return toPublicGitHubSkillScan(
      scan,
      skill.latestVersionSummary?.version,
      skill.githubCurrentCommit,
      skill.githubPath,
    );
  },
});

export const getBySlug = query({
  args: { slug: v.string(), ownerHandle: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { skill, requestedSlug, resolvedSlug, ambiguous, ambiguousMatches } =
      await resolveSkillBySlugOrAliasForOwner(ctx, args.slug, args.ownerHandle);
    if (ambiguous) {
      return {
        requestedSlug,
        resolvedSlug,
        skill: null,
        latestVersion: null,
        owner: null,
        pendingReview: false,
        moderationInfo: null,
        forkOf: null,
        canonical: null,
        ambiguous: true as const,
        ambiguousMatches,
      };
    }
    if (!skill) return null;

    const userId = await getOptionalActiveAuthUserId(ctx);
    const ownerPublisher = await getOwnerPublisher(ctx, {
      ownerPublisherId: skill.ownerPublisherId,
      ownerUserId: skill.ownerUserId,
    });
    const skillOwnerPublisher = skill.ownerPublisherId
      ? await ctx.db.get(skill.ownerPublisherId)
      : null;
    const publisherOwner =
      userId && skillOwnerPublisher
        ? await canAccessPublisherOwnerScope(ctx, {
            publisher: skillOwnerPublisher,
            userId,
            legacyOwnerUserId: skill.ownerUserId,
          })
        : false;
    const isOwner = Boolean(userId && (isDirectSkillOwner(skill, userId) || publisherOwner));

    const latestVersionDoc = skill.latestVersionId ? await ctx.db.get(skill.latestVersionId) : null;
    const publicLatestVersionDoc = isPublicSkillVersionAvailableForSkill(
      latestVersionDoc,
      skill._id,
    )
      ? latestVersionDoc
      : null;
    const latestVersion = toPublicSkillVersion(publicLatestVersionDoc);
    const generatedSkillCard = await getGeneratedSkillCardPublicFile(ctx, publicLatestVersionDoc);
    if (latestVersion) latestVersion.generatedSkillCard = generatedSkillCard;
    const owner = toPublicPublisher(ownerPublisher);
    if (!owner) return null;
    const badges = await getSkillBadgeMap(ctx, skill._id);

    const forkOf = await loadPublicSkillReference(ctx, skill.forkOf?.skillId);
    const canonical = await loadPublicSkillReference(ctx, skill.canonicalSkillId);
    const githubSource = skill.githubSourceId ? await ctx.db.get(skill.githubSourceId) : null;
    const githubSourceRepo = skill.githubCurrentRepo ?? githubSource?.repo;

    const publicSkill = toPublicSkill({ ...skill, badges });

    // Determine moderation state
    const isPendingScan =
      skill.moderationStatus === "hidden" && skill.moderationReason === "pending.scan";
    const isMalwareBlocked =
      skill.moderationVerdict === "malicious" ||
      (skill.moderationFlags?.includes("blocked.malware") ?? false);
    const isSuspicious = skill.moderationFlags?.includes("flagged.suspicious") ?? false;
    const isReviewFlagged = isSkillReviewFlagged(skill);
    const isHiddenByMod =
      skill.moderationStatus === "hidden" && !isPendingScan && !isMalwareBlocked;
    const isRemoved = skill.moderationStatus === "removed";

    if (isMalwareBlocked) return null;

    // Owners can see their non-malicious moderated skills.
    if (!publicSkill && !isOwner) return null;

    // For owners viewing their moderated skill, construct the response manually
    const skillData = publicSkill ?? {
      _id: skill._id,
      _creationTime: skill._creationTime,
      slug: skill.slug,
      displayName: skill.displayName,
      summary: skill.summary,
      ownerUserId: skill.ownerUserId,
      ownerPublisherId: skill.ownerPublisherId,
      canonicalSkillId: skill.canonicalSkillId,
      forkOf: skill.forkOf,
      latestVersionId: skill.latestVersionId,
      installKind: skill.installKind,
      githubPath: skill.githubPath,
      githubCurrentCommit: skill.githubCurrentCommit,
      githubCurrentStatus: skill.githubCurrentStatus,
      githubScanStatus: skill.githubScanStatus,
      githubHasSkillCard: skill.githubHasSkillCard,
      tags: skill.tags,
      badges,
      stats: skill.stats,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
    };
    const responseSkillData = {
      ...skillData,
      canonicalSkillId: canonical ? skillData.canonicalSkillId : undefined,
      forkOf: forkOf ? skillData.forkOf : undefined,
      ...(githubSourceRepo ? { githubSourceRepo } : {}),
    };

    // Moderation info - visible to owners for all states, or anyone for flagged skills (transparency)
    const showModerationInfo = isOwner || isMalwareBlocked || isSuspicious || isReviewFlagged;
    const moderationInfo = showModerationInfo
      ? {
          isPendingScan,
          isMalwareBlocked,
          isSuspicious,
          isReviewFlagged,
          isHiddenByMod,
          isRemoved,
          verdict: skill.moderationVerdict,
          reasonCodes: skill.moderationReasonCodes,
          summary: skill.moderationSummary,
          engineVersion: skill.moderationEngineVersion,
          updatedAt: skill.moderationEvaluatedAt,
          sourceVersionId: skill.moderationSourceVersionId ?? null,
          reason: isOwner ? skill.moderationReason : undefined,
        }
      : null;

    return {
      requestedSlug,
      resolvedSlug,
      skill: responseSkillData,
      latestVersion,
      owner,
      pendingReview: isOwner && isPendingScan,
      moderationInfo,
      forkOf: forkOf
        ? {
            kind: skill.forkOf?.kind ?? "fork",
            version: skill.forkOf?.version ?? null,
            skill: {
              slug: forkOf.skill.slug,
              displayName: forkOf.skill.displayName,
            },
            owner: {
              handle: forkOf.owner.handle ?? null,
              userId: forkOf.owner.linkedUserId ?? null,
            },
          }
        : null,
      canonical: canonical
        ? {
            skill: {
              slug: canonical.skill.slug,
              displayName: canonical.skill.displayName,
            },
            owner: {
              handle: canonical.owner.handle ?? null,
              userId: canonical.owner.linkedUserId ?? null,
            },
          }
        : null,
      ambiguous: false as const,
    };
  },
});

export const getSecurityReviewForManager = query({
  args: { slug: v.string(), ownerHandle: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { skill } = await resolveSkillBySlugOrAliasForOwner(ctx, args.slug, args.ownerHandle);
    if (!skill) return null;

    const userId = await getOptionalActiveAuthUserId(ctx);
    if (!userId) return null;

    const ownerPublisher = skill.ownerPublisherId ? await ctx.db.get(skill.ownerPublisherId) : null;
    const canManagePublisher = ownerPublisher
      ? await canAccessPublisherOwnerScope(ctx, {
          publisher: ownerPublisher,
          userId,
          legacyOwnerUserId: skill.ownerUserId,
        })
      : false;
    if (!isDirectSkillOwner(skill, userId) && !canManagePublisher) return null;

    const latestVersion = skill.latestVersionId ? await ctx.db.get(skill.latestVersionId) : null;
    if (!latestVersion || latestVersion.skillId !== skill._id || latestVersion.softDeletedAt) {
      return null;
    }

    const publicOwner = toPublicPublisher(
      await getOwnerPublisher(ctx, {
        ownerPublisherId: skill.ownerPublisherId,
        ownerUserId: skill.ownerUserId,
      }),
    );

    return {
      skill: { displayName: skill.displayName },
      owner: publicOwner,
      latestVersion: {
        version: latestVersion.version,
        skillSpectorAnalysis: latestVersion.skillSpectorAnalysis ?? null,
      },
    };
  },
});

export const getGitHubDownloadTargetInternal = internalQuery({
  args: { skillId: v.id("skills") },
  handler: async (ctx, args) => {
    const skill = await ctx.db.get(args.skillId);
    if (!skill || skill.installKind !== "github") return null;
    const source = skill.githubSourceId ? await ctx.db.get(skill.githubSourceId) : null;

    return {
      installKind: "github" as const,
      repo: skill.githubCurrentRepo ?? source?.repo ?? null,
      path: skill.githubPath ?? null,
      commit: skill.githubCurrentCommit ?? null,
      contentHash: skill.githubCurrentContentHash ?? null,
      currentStatus: skill.githubCurrentStatus ?? null,
      scanStatus: skill.githubScanStatus ?? null,
      removedAt: skill.githubRemovedAt ?? null,
    };
  },
});

export const getVerifyTargetBySlugInternal = internalQuery({
  args: { slug: v.string(), ownerHandle: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const resolved = await resolveSkillBySlugOrAliasForOwner(ctx, args.slug, args.ownerHandle);
    const skill = resolved.skill;
    if (!skill) return null;

    const isMalwareBlocked =
      skill.moderationVerdict === "malicious" ||
      (skill.moderationFlags?.includes("blocked.malware") ?? false);
    if (!isMalwareBlocked && !isPublicSkillDoc(skill)) return null;

    const owner = toPublicPublisher(
      await getOwnerPublisher(ctx, {
        ownerPublisherId: skill.ownerPublisherId,
        ownerUserId: skill.ownerUserId,
      }),
    );
    if (!owner) return null;

    const isPendingScan =
      skill.moderationStatus === "hidden" && skill.moderationReason === "pending.scan";
    const isSuspicious = skill.moderationFlags?.includes("flagged.suspicious") ?? false;
    const isReviewFlagged = isSkillReviewFlagged(skill);
    const isHiddenByMod =
      skill.moderationStatus === "hidden" && !isPendingScan && !isMalwareBlocked;
    const isRemoved = skill.moderationStatus === "removed";

    return {
      requestedSlug: resolved.requestedSlug,
      resolvedSlug: resolved.resolvedSlug,
      skill: {
        _id: skill._id,
        slug: skill.slug,
        displayName: skill.displayName,
        summary: skill.summary,
        tags: skill.tags,
        stats: skill.stats,
        createdAt: skill.createdAt,
        updatedAt: skill.updatedAt,
        latestVersionId: skill.latestVersionId,
      },
      latestVersion: null,
      owner,
      moderationInfo: {
        isPendingScan,
        isMalwareBlocked,
        isSuspicious,
        isReviewFlagged,
        isHiddenByMod,
        isRemoved,
        verdict: skill.moderationVerdict,
        reasonCodes: skill.moderationReasonCodes,
        summary: skill.moderationSummary,
        engineVersion: skill.moderationEngineVersion,
        updatedAt: skill.moderationEvaluatedAt,
        sourceVersionId: skill.moderationSourceVersionId ?? null,
      },
    };
  },
});

export const checkSlugAvailability = query({
  args: { slug: v.string(), ownerHandle: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const slug = normalizeSkillSlugKey(args.slug);
    if (!slug) {
      return {
        available: false,
        reason: "taken" as const,
        message: "Slug is required.",
        url: null,
      };
    }

    const { requestedHandle, publisher: requestedPublisher } = await resolvePublisherByOwnerHandle(
      ctx,
      args.ownerHandle,
    );
    if (!requestedHandle) {
      return {
        available: false,
        reason: "taken" as const,
        message: "Owner is required to check skill slug availability.",
        url: null,
      };
    }
    if (!requestedPublisher) {
      return {
        available: false,
        reason: "taken" as const,
        message: `Owner @${requestedHandle} was not found.`,
        url: null,
      };
    }

    const skill = await getSkillBySlugForPublisher(ctx, slug, requestedPublisher);

    if (!skill) {
      const alias = await getSkillSlugAliasBySlugForPublisher(ctx, slug, requestedPublisher);
      if (alias) {
        const aliasedSkill = await ctx.db.get(alias.skillId);
        const owner = aliasedSkill
          ? await getOwnerPublisher(ctx, {
              ownerPublisherId: aliasedSkill.ownerPublisherId,
              ownerUserId: aliasedSkill.ownerUserId,
            })
          : null;
        return {
          available: false,
          reason: "taken" as const,
          message: aliasedSkill
            ? buildAliasTakenErrorMessage(aliasedSkill, owner)
            : "Slug redirects to an existing skill. Choose a different slug.",
          url: aliasedSkill ? buildConflictingSkillUrl(aliasedSkill, owner) : null,
        };
      }

      const reservation = await getLatestActiveReservedSlugForPublisher(
        ctx,
        slug,
        requestedPublisher,
      );
      if (
        reservation &&
        reservation.expiresAt > Date.now() &&
        !canReleaseReservedSlugForPublisher(reservation, requestedPublisher, userId)
      ) {
        return {
          available: false,
          reason: "reserved" as const,
          message: formatReservedSlugCooldownMessage(slug, reservation.expiresAt),
          url: null,
        };
      }
      try {
        assertValidSkillSlug(slug);
      } catch (error) {
        return slugValidationAvailabilityFailure(error);
      }
      return {
        available: true,
        reason: "available" as const,
        message: null,
        url: null,
      };
    }

    const unpublishedReservationExpiresAt = await getUnpublishedSlugReservationExpiresAt(
      ctx,
      skill,
    );
    const viewerCanManageReservation = userId
      ? await canUserManageSkillOwner(ctx, skill, userId)
      : false;
    if (
      skill.softDeletedAt &&
      unpublishedReservationExpiresAt !== null &&
      !viewerCanManageReservation
    ) {
      if (unpublishedReservationExpiresAt <= Date.now()) {
        try {
          assertValidSkillSlug(slug);
        } catch (error) {
          return slugValidationAvailabilityFailure(error);
        }
        return {
          available: true,
          reason: "available" as const,
          message: null,
          url: null,
        };
      }
      return {
        available: false,
        reason: "reserved" as const,
        message: formatUnpublishedSlugReservationMessage(slug, unpublishedReservationExpiresAt),
        url: null,
      };
    }

    const requestedPublisherMatchesSkill = skill.ownerPublisherId
      ? requestedPublisher._id === skill.ownerPublisherId
      : requestedPublisher.kind === "user" && requestedPublisher.linkedUserId === skill.ownerUserId;

    if (userId && skill.ownerUserId === userId && requestedPublisherMatchesSkill) {
      return {
        available: true,
        reason: "available" as const,
        message: null,
        url: null,
      };
    }
    if (userId && skill.ownerPublisherId && requestedPublisherMatchesSkill) {
      const membership = await getPublisherMembership(ctx, skill.ownerPublisherId, userId);
      if (membership && isPublisherRoleAllowed(membership.role, ["publisher"])) {
        return {
          available: true,
          reason: "available" as const,
          message: null,
          url: null,
        };
      }
    }

    const owner = await getOwnerPublisher(ctx, {
      ownerPublisherId: skill.ownerPublisherId,
      ownerUserId: skill.ownerUserId,
    });
    const url = buildConflictingSkillUrl(skill, owner);
    const slugTakenMessage = buildSlugTakenErrorMessage(skill, owner);

    // Check GitHub identity FIRST so healing works even when the previous
    // owner record is deleted/deactivated (e.g. duplicate Convex Auth user
    // where the old record was later banned).
    if (userId) {
      const [ownerProviderAccountId, callerProviderAccountId] = await Promise.all([
        getGitHubProviderAccountId(ctx, skill.ownerUserId),
        getGitHubProviderAccountId(ctx, userId),
      ]);

      if (
        canHealSkillOwnershipByGitHubProviderAccountId(
          ownerProviderAccountId,
          callerProviderAccountId,
        )
      ) {
        return {
          available: true,
          reason: "available" as const,
          message: null,
          url: null,
        };
      }
    }

    if (!owner || owner.deletedAt || owner.deactivatedAt) {
      return {
        available: false,
        reason: "taken" as const,
        message:
          "This slug is locked to a deleted or banned account. " +
          "If you believe you are the rightful owner, open a GitHub issue to reclaim it: https://github.com/openclaw/clawhub/issues/new.",
        url: null,
      };
    }

    return {
      available: false,
      reason: "taken" as const,
      message: slugTakenMessage,
      url,
    };
  },
});

export const getBySlugForStaff = query({
  args: {
    slug: v.string(),
    ownerHandle: v.optional(v.string()),
    auditLogLimit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    assertModerator(user);

    const auditLogLimit = clampStaffAuditLogLimit(args.auditLogLimit);

    const resolved = await resolveSkillBySlugOrAliasForOwner(ctx, args.slug, args.ownerHandle);
    const skill = resolved.skill;
    if (!skill) return null;

    const latestVersion = skill.latestVersionId ? await ctx.db.get(skill.latestVersionId) : null;
    const generatedSkillCard = await getGeneratedSkillCardPublicFile(ctx, latestVersion);
    const ownerPublisher = await getOwnerPublisher(ctx, {
      ownerPublisherId: skill.ownerPublisherId,
      ownerUserId: skill.ownerUserId,
    });
    const owner = toPublicPublisher(ownerPublisher);
    const badges = await getSkillBadgeMap(ctx, skill._id);
    const rawAuditLogs = await ctx.db
      .query("auditLogs")
      .withIndex("by_target_createdAt", (q) =>
        q.eq("targetType", "skill").eq("targetId", skill._id),
      )
      .order("desc")
      .take(auditLogLimit);

    const staffUserIds = new Set<Id<"users">>();
    for (const log of rawAuditLogs) {
      if (log.actorUserId) staffUserIds.add(log.actorUserId);
    }
    const publicUsers = await loadPublicUsersById(ctx, [...staffUserIds]);
    const auditLogs: StaffSkillAuditLogEntry[] = rawAuditLogs.map((log) => ({
      ...log,
      actor: log.actorUserId ? (publicUsers.get(log.actorUserId) ?? null) : null,
    }));

    const forkOfSkill = skill.forkOf?.skillId ? await ctx.db.get(skill.forkOf.skillId) : null;
    const forkOfOwner = forkOfSkill
      ? await getOwnerPublisher(ctx, {
          ownerPublisherId: forkOfSkill.ownerPublisherId,
          ownerUserId: forkOfSkill.ownerUserId,
        })
      : null;

    const canonicalSkill = skill.canonicalSkillId ? await ctx.db.get(skill.canonicalSkillId) : null;
    const canonicalOwner = canonicalSkill
      ? await getOwnerPublisher(ctx, {
          ownerPublisherId: canonicalSkill.ownerPublisherId,
          ownerUserId: canonicalSkill.ownerUserId,
        })
      : null;

    return {
      requestedSlug: resolved.requestedSlug,
      resolvedSlug: resolved.resolvedSlug,
      skill: { ...skill, badges },
      latestVersion: latestVersion ? { ...latestVersion, generatedSkillCard } : null,
      owner,
      auditLogs,
      forkOf: forkOfSkill
        ? {
            kind: skill.forkOf?.kind ?? "fork",
            version: skill.forkOf?.version ?? null,
            skill: {
              slug: forkOfSkill.slug,
              displayName: forkOfSkill.displayName,
            },
            owner: {
              handle: forkOfOwner?.handle ?? null,
              userId: forkOfOwner?.linkedUserId ?? null,
            },
          }
        : null,
      canonical: canonicalSkill
        ? {
            skill: {
              slug: canonicalSkill.slug,
              displayName: canonicalSkill.displayName,
            },
            owner: {
              handle: canonicalOwner?.handle ?? null,
              userId: canonicalOwner?.linkedUserId ?? null,
            },
          }
        : null,
    };
  },
});

function clampStaffAuditLogLimit(limit?: number) {
  if (!Number.isFinite(limit)) return DEFAULT_STAFF_AUDIT_LOG_LIMIT;
  return Math.min(
    Math.max(Math.trunc(limit ?? DEFAULT_STAFF_AUDIT_LOG_LIMIT), 1),
    MAX_STAFF_AUDIT_LOG_LIMIT,
  );
}

async function loadPublicUsersById(ctx: Pick<QueryCtx, "db">, userIds: Id<"users">[]) {
  const uniqueUserIds = [...new Set(userIds)];
  const entries = await Promise.all(
    uniqueUserIds.map(async (userId) => [userId, toPublicUser(await ctx.db.get(userId))] as const),
  );
  return new Map(entries);
}

export const getReservedSlugInternal = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return getLatestActiveReservedSlug(ctx, args.slug);
  },
});

export const getSkillBySlugInternal = internalQuery({
  args: { slug: v.string(), ownerHandle: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const resolved = await resolveSkillBySlugOrAliasForOwner(ctx, args.slug, args.ownerHandle);
    return resolved.skill;
  },
});

export const getActivityTrendForSlug = query({
  args: { slug: v.string(), ownerHandle: v.optional(v.string()), endDay: v.number() },
  handler: async (ctx, args) => {
    const resolved = await resolveSkillBySlugOrAliasForOwner(ctx, args.slug, args.ownerHandle);
    const skill = resolved.skill;
    if (!skill || !isPublicSkillDoc(skill)) return null;
    const ownerPublisher = await getOwnerPublisher(ctx, {
      ownerPublisherId: skill.ownerPublisherId,
      ownerUserId: skill.ownerUserId,
    });
    if (!toPublicPublisher(ownerPublisher)) return null;

    return await buildSkillActivityTrend(ctx, skill, args.endDay);
  },
});

export const getSkillForPublishPreflightInternal = internalQuery({
  args: {
    userId: v.id("users"),
    slug: v.string(),
    ownerPublisherId: v.optional(v.id("publishers")),
    sourceOwnerPublisherId: v.optional(v.id("publishers")),
    migrateOwner: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const normalizedSlug = normalizeSkillSlug(args.slug);
    if (!normalizedSlug) return null;

    const user = await ctx.db.get(args.userId);
    if (!user || user.deletedAt || user.deactivatedAt) return null;
    const personalPublisher = await getPersonalPublisherForUserOrFallback(ctx, user);
    const ownerPublisher = args.ownerPublisherId
      ? await ctx.db.get(args.ownerPublisherId)
      : personalPublisher;
    if (!ownerPublisher) return null;

    const destinationSkill = await getSkillBySlugForPublisher(ctx, normalizedSlug, ownerPublisher);
    let skill = destinationSkill;
    if (!skill && ownerPublisher._id === personalPublisher?._id && args.migrateOwner !== true) {
      skill = await resolveLegacyPersonalSkillForSameGitHubOwner(ctx, normalizedSlug, args.userId);
    }
    if (args.ownerPublisherId !== undefined && args.migrateOwner === true) {
      if (args.sourceOwnerPublisherId) {
        const sourcePublisher = await ctx.db.get(args.sourceOwnerPublisherId);
        if (!sourcePublisher) throw new ConvexError("Source publisher not found");
        skill = await getSkillBySlugForPublisher(ctx, normalizedSlug, sourcePublisher);
        if (!skill) {
          throw new ConvexError(
            `Source owner @${sourcePublisher.handle} does not have skill "${normalizedSlug}".`,
          );
        }
        if (destinationSkill && destinationSkill._id !== skill._id) {
          throw new ConvexError(buildDestinationSkillExistsMessage(ownerPublisher, normalizedSlug));
        }
      } else if (destinationSkill) {
        throw new ConvexError(buildDestinationSkillExistsMessage(ownerPublisher, normalizedSlug));
      } else {
        const resolved = await resolveLegacySkillBySlugOrAlias(ctx, normalizedSlug, {
          includeSoftDeleted: true,
        });
        if (resolved.ambiguous) {
          throw new ConvexError(
            "Slug is used by multiple publishers. Publish with the source owner namespace instead.",
          );
        }
        skill = resolved.skill;
      }
    }

    return skill;
  },
});

function buildDestinationSkillExistsMessage(publisher: Doc<"publishers">, slug: string) {
  return `Destination owner @${publisher.handle} already has skill "${slug}". Choose a different slug or publish without migrating ownership.`;
}

export const getSkillBySlugIncludingSoftDeletedInternal = internalQuery({
  args: { slug: v.string(), ownerHandle: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const resolved = args.ownerHandle
      ? await resolveSkillBySlugOrAliasForOwner(ctx, args.slug, args.ownerHandle, {
          includeSoftDeleted: true,
        })
      : await resolveLegacySkillBySlugOrAlias(ctx, args.slug, { includeSoftDeleted: true });
    return resolved.skill;
  },
});

function compactSecurityVerdictVersion(version: Doc<"skillVersions">) {
  return {
    _id: version._id,
    version: version.version,
    createdAt: version.createdAt,
    softDeletedAt: version.softDeletedAt,
    ...(version.staticScan
      ? {
          staticScan: {
            status: version.staticScan.status,
            reasonCodes: version.staticScan.reasonCodes,
            summary: version.staticScan.summary,
            engineVersion: version.staticScan.engineVersion,
            checkedAt: version.staticScan.checkedAt,
          },
        }
      : {}),
    ...(version.llmAnalysis
      ? {
          llmAnalysis: {
            status: version.llmAnalysis.status,
            ...(version.llmAnalysis.verdict !== undefined
              ? { verdict: version.llmAnalysis.verdict }
              : {}),
            ...(version.llmAnalysis.confidence !== undefined
              ? { confidence: version.llmAnalysis.confidence }
              : {}),
            ...(version.llmAnalysis.summary !== undefined
              ? { summary: version.llmAnalysis.summary }
              : {}),
            ...(version.llmAnalysis.model !== undefined
              ? { model: version.llmAnalysis.model }
              : {}),
            checkedAt: version.llmAnalysis.checkedAt,
          },
        }
      : {}),
    ...(version.vtAnalysis
      ? {
          vtAnalysis: {
            status: version.vtAnalysis.status,
            ...(version.vtAnalysis.verdict !== undefined
              ? { verdict: version.vtAnalysis.verdict }
              : {}),
            ...(version.vtAnalysis.source !== undefined
              ? { source: version.vtAnalysis.source }
              : {}),
            checkedAt: version.vtAnalysis.checkedAt,
          },
        }
      : {}),
    ...(version.skillSpectorAnalysis
      ? {
          skillSpectorAnalysis: {
            status: version.skillSpectorAnalysis.status,
            ...(version.skillSpectorAnalysis.score !== undefined
              ? { score: version.skillSpectorAnalysis.score }
              : {}),
            ...(version.skillSpectorAnalysis.severity !== undefined
              ? { severity: version.skillSpectorAnalysis.severity }
              : {}),
            ...(version.skillSpectorAnalysis.recommendation !== undefined
              ? { recommendation: version.skillSpectorAnalysis.recommendation }
              : {}),
            issueCount: version.skillSpectorAnalysis.issueCount,
            ...(version.skillSpectorAnalysis.scannerVersion !== undefined
              ? { scannerVersion: version.skillSpectorAnalysis.scannerVersion }
              : {}),
            checkedAt: version.skillSpectorAnalysis.checkedAt,
          },
        }
      : {}),
  };
}

export const getSecurityVerdictTargetInternal = internalQuery({
  args: { slug: v.string(), ownerHandle: v.optional(v.string()), version: v.string() },
  handler: async (ctx, args) => {
    const resolved = await resolveSkillBySlugOrAliasForOwner(ctx, args.slug, args.ownerHandle);
    const skill = resolved.skill;
    if (!skill) return null;

    const isMalwareBlocked =
      skill.moderationVerdict === "malicious" ||
      (skill.moderationFlags?.includes("blocked.malware") ?? false);
    const isSuspicious = skill.moderationFlags?.includes("flagged.suspicious") ?? false;
    const isReviewFlagged = isSkillReviewFlagged(skill);
    if (!isMalwareBlocked && !isPublicSkillDoc(skill)) return null;

    const owner = toPublicPublisher(
      await getOwnerPublisher(ctx, {
        ownerPublisherId: skill.ownerPublisherId,
        ownerUserId: skill.ownerUserId,
      }),
    );
    if (!owner) return null;

    const version = await ctx.db
      .query("skillVersions")
      .withIndex("by_skill_version", (q) => q.eq("skillId", skill._id).eq("version", args.version))
      .unique();
    const isPendingScan =
      skill.moderationStatus === "hidden" && skill.moderationReason === "pending.scan";
    const isHiddenByMod =
      skill.moderationStatus === "hidden" && !isPendingScan && !isMalwareBlocked;
    const isRemoved = skill.moderationStatus === "removed";
    const showModerationInfo = isMalwareBlocked || isSuspicious || isReviewFlagged;

    return {
      skill: {
        _id: skill._id,
        slug: skill.slug,
        displayName: skill.displayName,
      },
      owner: {
        _id: owner._id,
        handle: owner.handle ?? null,
        displayName: owner.displayName ?? null,
      },
      moderationInfo: showModerationInfo
        ? {
            isPendingScan,
            isMalwareBlocked,
            isSuspicious,
            isReviewFlagged,
            isHiddenByMod,
            isRemoved,
            verdict: skill.moderationVerdict,
            reasonCodes: skill.moderationReasonCodes,
            summary: skill.moderationSummary,
            engineVersion: skill.moderationEngineVersion,
            updatedAt: skill.moderationEvaluatedAt,
            sourceVersionId: skill.moderationSourceVersionId ?? null,
          }
        : null,
      version: version ? compactSecurityVerdictVersion(version) : null,
    };
  },
});

export const getOwnerSkillActivityInternal = internalQuery({
  args: {
    ownerUserId: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = clampInt(args.limit ?? 60, 1, 500);
    const skills = await ctx.db
      .query("skills")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", args.ownerUserId))
      .order("desc")
      .take(limit);

    return skills.map((skill) => ({
      slug: skill.slug,
      summary: skill.summary,
      createdAt: skill.createdAt,
      latestVersionId: skill.latestVersionId,
    }));
  },
});

export const clearOwnerSuspiciousFlagsInternal = internalMutation({
  args: {
    ownerUserId: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const owner = await ctx.db.get(args.ownerUserId);
    if (!owner || owner.deletedAt || owner.deactivatedAt) throw new Error("Owner not found");
    if (!isPrivilegedOwnerForSuspiciousBypass(owner)) {
      return {
        inspected: 0,
        updated: 0,
        skipped: "owner_not_privileged" as const,
      };
    }

    const limit = clampInt(args.limit ?? 500, 1, 5000);
    const skills = await ctx.db
      .query("skills")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", args.ownerUserId))
      .order("desc")
      .take(limit);

    let updated = 0;
    const now = Date.now();

    for (const skill of skills) {
      const existingFlags: string[] = (skill.moderationFlags as string[] | undefined) ?? [];
      const hasSuspiciousFlag = existingFlags.includes("flagged.suspicious");
      const hasSuspiciousReason =
        skill.moderationReason?.startsWith("scanner.") &&
        skill.moderationReason.endsWith(".suspicious");
      if (!hasSuspiciousFlag && !hasSuspiciousReason) continue;

      const patch: Partial<Doc<"skills">> = { updatedAt: now };
      patch.moderationFlags = stripSuspiciousFlag(existingFlags);
      if (hasSuspiciousReason) {
        patch.moderationReason = normalizeScannerSuspiciousReason(skill.moderationReason);
      }
      if (
        (skill.moderationStatus ?? "active") === "hidden" &&
        hasSuspiciousReason &&
        !skill.softDeletedAt
      ) {
        patch.moderationStatus = "active";
      }
      patch.isSuspicious = computeIsSuspicious({
        moderationFlags: patch.moderationFlags,
        moderationReason: (patch.moderationReason ?? skill.moderationReason) as string | undefined,
      });

      const nextSkill = { ...skill, ...patch };
      await ctx.db.patch(skill._id, patch);
      await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);
      updated += 1;
    }

    return { inspected: skills.length, updated };
  },
});

/**
 * Get quick stats without loading versions (fast).
 */
export const getQuickStatsInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const allSkills = await ctx.db.query("skills").collect();
    const active = allSkills.filter((s) => !s.softDeletedAt);

    const byStatus: Record<string, number> = {};
    const byReason: Record<string, number> = {};

    for (const skill of active) {
      const status = skill.moderationStatus ?? "active";
      byStatus[status] = (byStatus[status] ?? 0) + 1;

      if (skill.moderationReason) {
        byReason[skill.moderationReason] = (byReason[skill.moderationReason] ?? 0) + 1;
      }
    }

    return { total: active.length, byStatus, byReason };
  },
});

/**
 * Get aggregate stats for all skills (for social posts, dashboards, etc.)
 */
/**
 * Paginated helper: counts stats for a batch of skills.
 * Returns partial counts + cursor for the next page.
 */
export const getStatsPageInternal = internalQuery({
  args: { cursor: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const PAGE_SIZE = 500;
    const cursor = args.cursor ?? 0;

    const page = await ctx.db
      .query("skills")
      .filter((q) => q.gt(q.field("_creationTime"), cursor))
      .order("asc")
      .take(PAGE_SIZE);

    let total = 0;
    const byStatus: Record<string, number> = {};
    const byReason: Record<string, number> = {};
    const byFlags: Record<string, number> = {};
    const vtStats = {
      clean: 0,
      suspicious: 0,
      malicious: 0,
      pending: 0,
      noAnalysis: 0,
    };

    for (const skill of page) {
      if (skill.softDeletedAt) continue;
      total++;

      const status = skill.moderationStatus ?? "active";
      byStatus[status] = (byStatus[status] ?? 0) + 1;

      if (skill.moderationReason) {
        byReason[skill.moderationReason] = (byReason[skill.moderationReason] ?? 0) + 1;
      }

      for (const flag of skill.moderationFlags ?? []) {
        byFlags[flag] = (byFlags[flag] ?? 0) + 1;
      }

      if (status === "active") {
        const reason = skill.moderationReason;
        if (!reason) {
          vtStats.noAnalysis++;
        } else if (reason === "scanner.vt.clean") {
          vtStats.clean++;
        } else if (reason === "scanner.vt.malicious") {
          vtStats.malicious++;
        } else if (reason === "scanner.vt.suspicious") {
          vtStats.suspicious++;
        } else if (reason === "scanner.vt.pending" || reason === "pending.scan") {
          vtStats.pending++;
        } else if (reason.startsWith("scanner.vt-rescan.")) {
          const suffix = reason.slice("scanner.vt-rescan.".length);
          if (suffix === "clean") vtStats.clean++;
          else if (suffix === "malicious") vtStats.malicious++;
          else if (suffix === "suspicious") vtStats.suspicious++;
          else vtStats.pending++;
        } else {
          vtStats.noAnalysis++;
        }
      }
    }

    const nextCursor = page.length > 0 ? page[page.length - 1]._creationTime : null;
    const done = page.length < PAGE_SIZE;

    return { total, byStatus, byReason, byFlags, vtStats, nextCursor, done };
  },
});

export const getHighlightedCountInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const badges = await ctx.db
      .query("skillBadges")
      .withIndex("by_kind_at", (q) => q.eq("kind", "highlighted"))
      .collect();
    return badges.length;
  },
});

/**
 * Get aggregate stats for all skills (for social posts, dashboards, etc.)
 * Uses an action to call paginated queries, avoiding the 16MB byte limit.
 */
type StatsResult = {
  total: number;
  highlighted: number;
  byStatus: Record<string, number>;
  byReason: Record<string, number>;
  byFlags: Record<string, number>;
  vtStats: {
    clean: number;
    suspicious: number;
    malicious: number;
    pending: number;
    noAnalysis: number;
  };
};

export const getStatsInternal = internalAction({
  args: {},
  handler: async (ctx): Promise<StatsResult> => {
    let total = 0;
    const byStatus: Record<string, number> = {};
    const byReason: Record<string, number> = {};
    const byFlags: Record<string, number> = {};
    const vtStats = {
      clean: 0,
      suspicious: 0,
      malicious: 0,
      pending: 0,
      noAnalysis: 0,
    };

    let cursor: number | undefined;
    let done = false;

    while (!done) {
      const page: {
        total: number;
        byStatus: Record<string, number>;
        byReason: Record<string, number>;
        byFlags: Record<string, number>;
        vtStats: {
          clean: number;
          suspicious: number;
          malicious: number;
          pending: number;
          noAnalysis: number;
        };
        nextCursor: number | null;
        done: boolean;
      } = await ctx.runQuery(internal.skills.getStatsPageInternal, { cursor });

      total += page.total;
      for (const [k, cnt] of Object.entries(page.byStatus)) {
        byStatus[k] = (byStatus[k] ?? 0) + cnt;
      }
      for (const [k, cnt] of Object.entries(page.byReason)) {
        byReason[k] = (byReason[k] ?? 0) + cnt;
      }
      for (const [k, cnt] of Object.entries(page.byFlags)) {
        byFlags[k] = (byFlags[k] ?? 0) + cnt;
      }
      vtStats.clean += page.vtStats.clean;
      vtStats.suspicious += page.vtStats.suspicious;
      vtStats.malicious += page.vtStats.malicious;
      vtStats.pending += page.vtStats.pending;
      vtStats.noAnalysis += page.vtStats.noAnalysis;

      done = page.done;
      if (page.nextCursor !== null) {
        cursor = page.nextCursor;
      }
    }

    const highlighted: number = await ctx.runQuery(internal.skills.getHighlightedCountInternal, {});

    return { total, highlighted, byStatus, byReason, byFlags, vtStats };
  },
});

export const list = query({
  args: {
    batch: v.optional(v.string()),
    ownerUserId: v.optional(v.id("users")),
    ownerPublisherId: v.optional(v.id("publishers")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = clampInt(args.limit ?? 24, 1, MAX_LIST_BULK_LIMIT);
    const takeLimit = Math.min(limit * 5, MAX_LIST_TAKE);
    if (args.batch) {
      if (args.batch === "highlighted") {
        const skills = await loadHighlightedSkills(ctx, limit);
        const withBadges = await attachBadgesToSkills(ctx, skills);
        const visibleSkills = await filterSkillsByActiveOwner(ctx, withBadges);
        return visibleSkills
          .map((skill) => toPublicSkill(skill))
          .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill));
      }
      const entries = await ctx.db
        .query("skills")
        .withIndex("by_batch", (q) => q.eq("batch", args.batch))
        .order("desc")
        .take(takeLimit);
      const filtered = entries.filter((skill) => !skill.softDeletedAt).slice(0, limit);
      const withBadges = await attachBadgesToSkills(ctx, filtered);
      const visibleSkills = await filterSkillsByActiveOwner(ctx, withBadges);
      return visibleSkills
        .map((skill) => toPublicSkill(skill))
        .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill));
    }
    const ownerPublisherId = args.ownerPublisherId;
    if (ownerPublisherId) {
      const userId = await getOptionalActiveAuthUserId(ctx);
      const ownerPublisher = await ctx.db.get(ownerPublisherId);
      const owner =
        userId && ownerPublisher?.kind === "user" && !ownerPublisher.linkedUserId
          ? await ctx.db.get(userId)
          : null;
      const isOwnDashboard = Boolean(
        userId &&
        ((await canAccessPublisherOwnerScope(ctx, {
          publisher: ownerPublisher,
          userId,
        })) ||
          (ownerPublisher?.kind === "user" &&
            isPublisherActive(ownerPublisher) &&
            !ownerPublisher.linkedUserId &&
            owner?.personalPublisherId === ownerPublisherId)),
      );
      const scopedEntries = await ctx.db
        .query("skills")
        .withIndex("by_owner_publisher", (q) => q.eq("ownerPublisherId", ownerPublisherId))
        .order("desc")
        .take(takeLimit);
      const legacyPersonalOwnerUserId =
        ownerPublisher?.kind === "user"
          ? (ownerPublisher.linkedUserId ?? (isOwnDashboard ? userId : undefined))
          : undefined;
      const legacyEntries = legacyPersonalOwnerUserId
        ? await ctx.db
            .query("skills")
            .withIndex("by_owner", (q) => q.eq("ownerUserId", legacyPersonalOwnerUserId))
            .order("desc")
            .take(takeLimit)
        : [];
      const combined = [...scopedEntries, ...legacyEntries].filter(
        (skill, index, all) =>
          !skill.softDeletedAt &&
          (!skill.ownerPublisherId || skill.ownerPublisherId === ownerPublisherId) &&
          all.findIndex((candidate) => candidate._id === skill._id) === index,
      );
      const filtered = combined.slice(0, limit);
      const withBadges = await attachBadgesToSkills(ctx, filtered);

      if (isOwnDashboard) {
        return await Promise.all(
          withBadges.map(async (skill) => await toDashboardSkillListItem(ctx, skill)),
        );
      }

      const visibleSkills = await filterSkillsByActiveOwner(ctx, withBadges);
      return visibleSkills
        .map((skill) => toPublicSkill(skill))
        .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill));
    }
    const ownerUserId = args.ownerUserId;
    if (ownerUserId) {
      const userId = await getOptionalActiveAuthUserId(ctx);
      const isOwnDashboard = Boolean(userId && userId === ownerUserId);
      const entries = await ctx.db
        .query("skills")
        .withIndex("by_owner", (q) => q.eq("ownerUserId", ownerUserId))
        .order("desc")
        .take(takeLimit);
      const scoped = await filterSkillsForOwnerUserDashboard(ctx, entries, ownerUserId);
      const filtered = scoped.filter((skill) => !skill.softDeletedAt).slice(0, limit);
      const withBadges = await attachBadgesToSkills(ctx, filtered);

      if (isOwnDashboard) {
        return await Promise.all(
          withBadges.map(async (skill) => await toDashboardSkillListItem(ctx, skill)),
        );
      }

      const visibleSkills = await filterSkillsByActiveOwner(ctx, withBadges);
      return visibleSkills
        .map((skill) => toPublicSkill(skill))
        .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill));
    }
    const entries = await ctx.db.query("skills").order("desc").take(takeLimit);
    const filtered = entries.filter((skill) => !skill.softDeletedAt).slice(0, limit);
    const withBadges = await attachBadgesToSkills(ctx, filtered);
    const visibleSkills = await filterSkillsByActiveOwner(ctx, withBadges);
    return visibleSkills
      .map((skill) => toPublicSkill(skill))
      .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill));
  },
});

async function mapDashboardSkillPage(
  ctx: QueryCtx,
  skills: Doc<"skills">[],
  isOwnDashboard: boolean,
) {
  const withBadges = await attachBadgesToSkills(ctx, skills);

  if (isOwnDashboard) {
    return await Promise.all(
      withBadges.map(async (skill) => await toDashboardSkillListItem(ctx, skill)),
    );
  }

  const visibleSkills = await filterSkillsByActiveOwner(ctx, withBadges);
  return visibleSkills
    .map((skill) => toPublicSkill(skill))
    .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill));
}

export const listDashboardPaginated = query({
  args: {
    ownerUserId: v.optional(v.id("users")),
    ownerPublisherId: v.optional(v.id("publishers")),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const ownerPublisherId = args.ownerPublisherId;
    if (ownerPublisherId) {
      const userId = await getOptionalActiveAuthUserId(ctx);
      const ownerPublisher = await ctx.db.get(ownerPublisherId);
      const owner =
        userId && ownerPublisher?.kind === "user" && !ownerPublisher.linkedUserId
          ? await ctx.db.get(userId)
          : null;
      const isOwnDashboard = Boolean(
        userId &&
        ((await canAccessPublisherOwnerScope(ctx, {
          publisher: ownerPublisher,
          userId,
        })) ||
          (ownerPublisher?.kind === "user" &&
            isPublisherActive(ownerPublisher) &&
            !ownerPublisher.linkedUserId &&
            owner?.personalPublisherId === ownerPublisherId)),
      );

      const legacyPersonalOwnerUserId =
        ownerPublisher?.kind === "user"
          ? (ownerPublisher.linkedUserId ?? (isOwnDashboard ? userId : undefined))
          : undefined;
      const shouldIncludeLegacyPersonalSkills = Boolean(legacyPersonalOwnerUserId);
      const result = shouldIncludeLegacyPersonalSkills
        ? await ctx.db
            .query("skills")
            .withIndex("by_owner_active_updated", (q) =>
              q.eq("ownerUserId", legacyPersonalOwnerUserId!).eq("softDeletedAt", undefined),
            )
            .order("desc")
            .paginate(args.paginationOpts)
        : await ctx.db
            .query("skills")
            .withIndex("by_owner_publisher_active_updated", (q) =>
              q.eq("ownerPublisherId", ownerPublisherId).eq("softDeletedAt", undefined),
            )
            .order("desc")
            .paginate(args.paginationOpts);
      const scopedPage = shouldIncludeLegacyPersonalSkills
        ? result.page.filter(
            (skill) => !skill.ownerPublisherId || skill.ownerPublisherId === ownerPublisherId,
          )
        : result.page;
      const page = await mapDashboardSkillPage(ctx, scopedPage, isOwnDashboard);
      return { ...result, page };
    }

    const ownerUserId = args.ownerUserId;
    if (ownerUserId) {
      const userId = await getOptionalActiveAuthUserId(ctx);
      const isOwnDashboard = Boolean(userId && userId === ownerUserId);
      const result = await ctx.db
        .query("skills")
        .withIndex("by_owner_active_updated", (q) =>
          q.eq("ownerUserId", ownerUserId).eq("softDeletedAt", undefined),
        )
        .order("desc")
        .paginate(args.paginationOpts);
      const scopedPage = await filterSkillsForOwnerUserDashboard(ctx, result.page, ownerUserId);
      const page = await mapDashboardSkillPage(ctx, scopedPage, isOwnDashboard);
      return { ...result, page };
    }

    return { page: [], isDone: true as const, continueCursor: "" };
  },
});

export const listWithLatest = query({
  args: {
    batch: v.optional(v.string()),
    ownerUserId: v.optional(v.id("users")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = clampInt(args.limit ?? 24, 1, MAX_LIST_BULK_LIMIT);
    const takeLimit = Math.min(limit * 5, MAX_LIST_TAKE);
    let entries: Doc<"skills">[] = [];
    if (args.batch) {
      if (args.batch === "highlighted") {
        entries = await loadHighlightedSkills(ctx, limit);
      } else {
        entries = await ctx.db
          .query("skills")
          .withIndex("by_batch", (q) => q.eq("batch", args.batch))
          .order("desc")
          .take(takeLimit);
      }
    } else if (args.ownerUserId) {
      const ownerUserId = args.ownerUserId;
      entries = await ctx.db
        .query("skills")
        .withIndex("by_owner", (q) => q.eq("ownerUserId", ownerUserId))
        .order("desc")
        .take(takeLimit);
    } else {
      entries = await ctx.db.query("skills").order("desc").take(takeLimit);
    }

    const filtered = await filterSkillsByActiveOwner(
      ctx,
      entries.filter((skill) => !skill.softDeletedAt),
    );
    const withBadges = await attachBadgesToSkills(ctx, filtered);
    const ordered =
      args.batch === "highlighted"
        ? [...withBadges].sort(
            (a, b) => (b.badges?.highlighted?.at ?? 0) - (a.badges?.highlighted?.at ?? 0),
          )
        : withBadges;
    const limited = ordered.slice(0, limit);
    const items = await Promise.all(
      limited.map(async (skill) => {
        const latestVersion = await loadPublicLatestVersionForSkill(ctx, skill);
        return {
          skill: toPublicSkill(skill),
          latestVersion: toPublicSkillVersion(latestVersion),
        };
      }),
    );
    return items.filter(
      (
        item,
      ): item is {
        skill: NonNullable<ReturnType<typeof toPublicSkill>>;
        latestVersion: Doc<"skillVersions"> | null;
      } => Boolean(item.skill),
    );
  },
});

export const listHighlightedPublic = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = clampInt(args.limit ?? 12, 1, MAX_PUBLIC_LIST_LIMIT);
    const skills = await loadHighlightedSkills(ctx, limit);
    return buildPublicSkillEntries(ctx, skills);
  },
});

export const listForManagement = query({
  args: {
    limit: v.optional(v.number()),
    includeDeleted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    assertModerator(user);
    const limit = clampInt(args.limit ?? 50, 1, MAX_LIST_BULK_LIMIT);
    const takeLimit = Math.min(limit * 5, MAX_LIST_TAKE);
    const entries = await ctx.db.query("skills").order("desc").take(takeLimit);
    const filtered = (
      args.includeDeleted ? entries : entries.filter((skill) => !skill.softDeletedAt)
    ).slice(0, limit);
    return buildManagementSkillEntries(ctx, filtered);
  },
});

export const listRecentVersions = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    assertModerator(user);
    const limit = clampInt(args.limit ?? 20, 1, MAX_LIST_BULK_LIMIT);
    const versions = await ctx.db
      .query("skillVersions")
      .order("desc")
      .take(limit * 2);
    const entries = versions.filter((version) => !version.softDeletedAt).slice(0, limit);

    const results: Array<{
      version: Doc<"skillVersions">;
      skill: Doc<"skills"> | null;
      owner: Doc<"users"> | null;
    }> = [];

    for (const version of entries) {
      const skill = await ctx.db.get(version.skillId);
      if (!skill) {
        results.push({ version, skill: null, owner: null });
        continue;
      }
      const owner = await ctx.db.get(skill.ownerUserId);
      results.push({ version, skill, owner });
    }

    return results;
  },
});

export const listReportedSkills = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    assertModerator(user);
    const limit = clampInt(args.limit ?? 25, 1, MAX_LIST_BULK_LIMIT);
    const takeLimit = Math.min(limit * 5, MAX_LIST_TAKE);
    const entries = await ctx.db.query("skills").order("desc").take(takeLimit);
    const reported = entries
      .filter((skill) => (skill.reportCount ?? 0) > 0)
      .sort((a, b) => (b.lastReportedAt ?? 0) - (a.lastReportedAt ?? 0))
      .slice(0, limit);
    const managementEntries = await buildManagementSkillEntries(ctx, reported);
    const reporterCache = new Map<Id<"users">, Promise<Doc<"users"> | null>>();

    const getReporter = (reporterId: Id<"users">) => {
      const cached = reporterCache.get(reporterId);
      if (cached) return cached;
      const reporterPromise = ctx.db.get(reporterId);
      reporterCache.set(reporterId, reporterPromise);
      return reporterPromise;
    };

    return Promise.all(
      managementEntries.map(async (entry) => {
        const reports = await ctx.db
          .query("skillReports")
          .withIndex("by_skill_createdAt", (q) => q.eq("skillId", entry.skill._id))
          .order("desc")
          .take(MAX_REPORT_REASON_SAMPLE);
        const reportEntries = await Promise.all(
          reports.map(async (report) => {
            const reporter = await getReporter(report.userId);
            const reason = report.reason?.trim();
            return {
              reason: reason && reason.length > 0 ? reason : "No reason provided.",
              createdAt: report.createdAt,
              reporterHandle: reporter?.handle ?? reporter?.name ?? null,
              reporterId: report.userId,
            };
          }),
        );
        return { ...entry, reports: reportEntries };
      }),
    );
  },
});

export const listDuplicateCandidates = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    assertModerator(user);
    const limit = clampInt(args.limit ?? 20, 1, MAX_LIST_BULK_LIMIT);
    const takeLimit = Math.min(limit * 5, MAX_LIST_TAKE);
    const skills = await ctx.db.query("skills").order("desc").take(takeLimit);
    const entries = skills.filter((skill) => !skill.softDeletedAt).slice(0, limit);

    const results: Array<{
      skill: Doc<"skills">;
      latestVersion: Doc<"skillVersions"> | null;
      fingerprint: string | null;
      matches: Array<{ skill: Doc<"skills">; owner: Doc<"users"> | null }>;
      owner: Doc<"users"> | null;
    }> = [];

    for (const skill of entries) {
      const latestVersion = isSkillVersionId(skill.latestVersionId)
        ? await ctx.db.get(skill.latestVersionId)
        : null;
      const fingerprint = latestVersion?.fingerprint ?? null;
      if (!fingerprint) continue;

      let matchedFingerprints: Doc<"skillVersionFingerprints">[] = [];
      try {
        matchedFingerprints = await ctx.db
          .query("skillVersionFingerprints")
          .withIndex("by_fingerprint", (q) => q.eq("fingerprint", fingerprint))
          .take(10);
      } catch (error) {
        console.error("listDuplicateCandidates: fingerprint lookup failed", error);
        continue;
      }

      const matchEntries: Array<{
        skill: Doc<"skills">;
        owner: Doc<"users"> | null;
      }> = [];
      for (const match of matchedFingerprints) {
        if (match.skillId === skill._id) continue;
        const matchSkill = await ctx.db.get(match.skillId);
        if (!matchSkill || matchSkill.softDeletedAt) continue;
        const matchOwner = await ctx.db.get(matchSkill.ownerUserId);
        matchEntries.push({ skill: matchSkill, owner: matchOwner });
      }

      if (matchEntries.length === 0) continue;

      const owner = isUserId(skill.ownerUserId) ? await ctx.db.get(skill.ownerUserId) : null;
      results.push({
        skill,
        latestVersion,
        fingerprint,
        matches: matchEntries,
        owner,
      });
    }

    return results;
  },
});

async function countActiveReportsForUser(ctx: MutationCtx, userId: Id<"users">) {
  const reports = await ctx.db
    .query("skillReports")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();

  let count = 0;
  for (const report of reports) {
    if (report.status && report.status !== "open") continue;
    const skill = await ctx.db.get(report.skillId);
    if (!skill) continue;
    if (skill.softDeletedAt) continue;
    if (skill.moderationStatus === "removed") continue;
    const owner = await ctx.db.get(skill.ownerUserId);
    if (!owner || owner.deletedAt || owner.deactivatedAt) continue;
    count += 1;
    if (count >= MAX_ACTIVE_REPORTS_PER_USER) break;
  }

  return count;
}

export const report = mutation({
  args: { skillId: v.id("skills"), reason: v.string() },
  handler: async (ctx, args) => {
    const { userId } = await requireUser(ctx);
    const skill = await ctx.db.get(args.skillId);
    if (!skill || skill.softDeletedAt || skill.moderationStatus === "removed") {
      throw new Error("Skill not found");
    }
    const reason = args.reason.trim();
    if (!reason) {
      throw new Error("Report reason required.");
    }

    const existing = await ctx.db
      .query("skillReports")
      .withIndex("by_skill_user", (q) => q.eq("skillId", args.skillId).eq("userId", userId))
      .unique();
    if (existing) return { ok: true as const, reported: false, alreadyReported: true };

    const activeReports = await countActiveReportsForUser(ctx, userId);
    if (activeReports >= MAX_ACTIVE_REPORTS_PER_USER) {
      throw new Error("Report limit reached. Please wait for moderation before reporting more.");
    }

    const now = Date.now();
    const reportId = await ctx.db.insert("skillReports", {
      skillId: args.skillId,
      ...(skill.latestVersionId ? { skillVersionId: skill.latestVersionId } : {}),
      userId,
      reason: reason.slice(0, MAX_REPORT_REASON_LENGTH),
      status: "open",
      createdAt: now,
    });

    const nextReportCount = (skill.reportCount ?? 0) + 1;
    const shouldAutoHide = nextReportCount > AUTO_HIDE_REPORT_THRESHOLD && !skill.softDeletedAt;
    const updates: Partial<Doc<"skills">> = {
      reportCount: nextReportCount,
      lastReportedAt: now,
      updatedAt: now,
    };
    if (shouldAutoHide) {
      Object.assign(updates, {
        softDeletedAt: now,
        moderationStatus: "hidden",
        moderationReason: "auto.reports",
        moderationNotes: "Auto-hidden after 4 unique reports.",
        isSuspicious: computeIsSuspicious({
          moderationFlags: skill.moderationFlags,
          moderationReason: "auto.reports",
        }),
        hiddenAt: now,
        lastReviewedAt: now,
        unpublishedSlugReservedUntil: undefined,
        unpublishedSlugReleasedAt: undefined,
        unpublishedOriginalSlug: undefined,
      });
    }

    const nextSkill = { ...skill, ...updates };
    await ctx.db.patch(skill._id, updates);
    await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);
    await adjustUserSkillStatsForSkillChange(ctx, skill, nextSkill);

    if (shouldAutoHide) {
      await setSkillEmbeddingsSoftDeleted(ctx, skill._id, true, now);

      await ctx.db.insert("auditLogs", {
        actorUserId: userId,
        action: "skill.auto_hide",
        targetType: "skill",
        targetId: skill._id,
        metadata: { reportCount: nextReportCount },
        createdAt: now,
      });
    }

    await appendSkillModerationEventLog(ctx, {
      kind: "report",
      reportId,
      actorUserId: userId,
      action: "skill.report.submit",
      timelineMetadata: { skillId: skill._id, reportCount: nextReportCount },
      auditAction: "skill.report",
      auditTargetType: "skill",
      auditTargetId: skill._id,
      auditMetadata: { reportId, slug: skill.slug, reportCount: nextReportCount },
      createdAt: now,
    });

    return { ok: true as const, reported: true, alreadyReported: false, reportId };
  },
});

export const reportSkillForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    slug: v.string(),
    reason: v.string(),
    version: v.optional(v.string()),
    // Owner qualifier for ambiguous slugs (mirrors GET /skills/{slug}?owner=).
    ownerHandle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");

    const ownerHandle = args.ownerHandle?.trim().replace(/^@+/, "") || undefined;
    const resolved = await resolveSkillBySlugOrAliasForOwner(ctx, args.slug, ownerHandle);
    if (resolved.ambiguous) {
      // Prefer the same guidance used by other slug-only endpoints instead of
      // collapsing collisions into a misleading "Skill not found".
      throw new ConvexError(
        "Slug is used by multiple publishers. Use an owner-qualified skill URL.",
      );
    }
    const skill = resolved.skill;
    if (!skill || skill.softDeletedAt || skill.moderationStatus === "removed") {
      throw new ConvexError("Skill not found");
    }
    const reason = args.reason.trim();
    if (!reason) throw new ConvexError("Report reason required.");

    const version = args.version?.trim();
    const skillVersion = version
      ? await ctx.db
          .query("skillVersions")
          .withIndex("by_skill_version", (q) => q.eq("skillId", skill._id).eq("version", version))
          .unique()
      : skill.latestVersionId
        ? await ctx.db.get(skill.latestVersionId)
        : null;
    if (version && (!skillVersion || skillVersion.softDeletedAt)) {
      throw new ConvexError("Skill version not found");
    }

    const existing = await ctx.db
      .query("skillReports")
      .withIndex("by_skill_user", (q) => q.eq("skillId", skill._id).eq("userId", actor._id))
      .unique();
    if (existing) {
      if ((existing.status ?? "open") !== "open") {
        const activeReports = await countActiveReportsForUser(ctx, actor._id);
        if (activeReports >= MAX_ACTIVE_REPORTS_PER_USER) {
          throw new ConvexError(
            "Report limit reached. Please wait for moderation before reporting more.",
          );
        }
        const now = Date.now();
        await ctx.db.patch(existing._id, {
          ...(skillVersion
            ? { skillVersionId: skillVersion._id, version: skillVersion.version }
            : {}),
          reason: reason.slice(0, MAX_REPORT_REASON_LENGTH),
          status: "open",
          triagedAt: undefined,
          triagedBy: undefined,
          triageNote: undefined,
          createdAt: now,
        });
        const nextReportCount = (skill.reportCount ?? 0) + 1;
        await ctx.db.patch(skill._id, {
          reportCount: nextReportCount,
          lastReportedAt: now,
          updatedAt: now,
        });
        await appendSkillModerationEventLog(ctx, {
          kind: "report",
          reportId: existing._id,
          actorUserId: actor._id,
          action: "skill.report.reopen",
          timelineMetadata: { skillId: skill._id, reportCount: nextReportCount },
          auditAction: "skill.report.reopen",
          auditTargetType: "skill",
          auditTargetId: skill._id,
          auditMetadata: {
            reportId: existing._id,
            slug: skill.slug,
            version: skillVersion?.version ?? version ?? null,
            reportCount: nextReportCount,
          },
          createdAt: now,
        });
        return {
          ok: true as const,
          reported: true,
          alreadyReported: false,
          reportId: existing._id,
          skillId: skill._id,
          reportCount: nextReportCount,
        };
      }
      return {
        ok: true as const,
        reported: false,
        alreadyReported: true,
        reportId: existing._id,
        skillId: skill._id,
        reportCount: skill.reportCount ?? 0,
      };
    }

    const activeReports = await countActiveReportsForUser(ctx, actor._id);
    if (activeReports >= MAX_ACTIVE_REPORTS_PER_USER) {
      throw new ConvexError(
        "Report limit reached. Please wait for moderation before reporting more.",
      );
    }

    const now = Date.now();
    const reportId = await ctx.db.insert("skillReports", {
      skillId: skill._id,
      ...(skillVersion ? { skillVersionId: skillVersion._id, version: skillVersion.version } : {}),
      userId: actor._id,
      reason: reason.slice(0, MAX_REPORT_REASON_LENGTH),
      status: "open",
      createdAt: now,
    });
    const nextReportCount = (skill.reportCount ?? 0) + 1;
    await ctx.db.patch(skill._id, {
      reportCount: nextReportCount,
      lastReportedAt: now,
      updatedAt: now,
    });
    await appendSkillModerationEventLog(ctx, {
      kind: "report",
      reportId,
      actorUserId: actor._id,
      action: "skill.report.submit",
      timelineMetadata: { skillId: skill._id, reportCount: nextReportCount },
      auditAction: "skill.report",
      auditTargetType: "skill",
      auditTargetId: skill._id,
      auditMetadata: {
        reportId,
        slug: skill.slug,
        version: skillVersion?.version ?? version ?? null,
        reportCount: nextReportCount,
      },
      createdAt: now,
    });

    return {
      ok: true as const,
      reported: true,
      alreadyReported: false,
      reportId,
      skillId: skill._id,
      reportCount: nextReportCount,
    };
  },
});

type SkillReportStatus = "open" | "confirmed" | "dismissed";
type SkillAppealStatus = "open" | "accepted" | "rejected";
type SkillReportFinalAction = "none" | "hide";
type SkillAppealFinalAction = "none" | "restore";

type SkillReportListItem = {
  reportId: Id<"skillReports">;
  skillId: Id<"skills">;
  skillVersionId?: Id<"skillVersions"> | null;
  slug: string;
  displayName: string;
  version?: string | null;
  reason?: string | null;
  status: SkillReportStatus;
  createdAt: number;
  reporter: {
    userId: Id<"users">;
    handle?: string | null;
    displayName?: string | null;
  };
  triagedAt?: number | null;
  triagedBy?: Id<"users"> | null;
  triageNote?: string | null;
  actionTaken?: SkillReportFinalAction | null;
};

type SkillAppealListItem = {
  appealId: Id<"skillAppeals">;
  skillId: Id<"skills">;
  skillVersionId?: Id<"skillVersions"> | null;
  slug: string;
  displayName: string;
  version?: string | null;
  message: string;
  status: SkillAppealStatus;
  createdAt: number;
  submitter: {
    userId: Id<"users">;
    handle?: string | null;
    displayName?: string | null;
  };
  resolvedAt?: number | null;
  resolvedBy?: Id<"users"> | null;
  resolutionNote?: string | null;
  actionTaken?: SkillAppealFinalAction | null;
};

function toSkillReportListItem(
  skillReport: Doc<"skillReports">,
  skill: Doc<"skills">,
  reporter: Doc<"users"> | null,
): SkillReportListItem {
  return {
    reportId: skillReport._id,
    skillId: skill._id,
    skillVersionId: skillReport.skillVersionId ?? null,
    slug: skill.slug,
    displayName: skill.displayName,
    version: skillReport.version ?? null,
    reason: skillReport.reason ?? null,
    status: readArtifactReportStatus(skillReport.status),
    createdAt: skillReport.createdAt,
    reporter: {
      userId: skillReport.userId,
      handle: reporter?.handle ?? null,
      displayName: reporter?.displayName ?? reporter?.name ?? null,
    },
    triagedAt: skillReport.triagedAt ?? null,
    triagedBy: skillReport.triagedBy ?? null,
    triageNote: skillReport.triageNote ?? null,
    actionTaken: skillReport.actionTaken ?? null,
  };
}

function toSkillAppealListItem(
  appeal: Doc<"skillAppeals">,
  skill: Doc<"skills">,
  submitter: Doc<"users"> | null,
): SkillAppealListItem {
  return {
    appealId: appeal._id,
    skillId: skill._id,
    skillVersionId: appeal.skillVersionId ?? null,
    slug: skill.slug,
    displayName: skill.displayName,
    version: appeal.version ?? null,
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

async function applySkillReportFinalAction(
  ctx: MutationCtx,
  params: {
    actorUserId: Id<"users">;
    skill: Doc<"skills">;
    action: SkillReportFinalAction;
    note: string;
    reportId: Id<"skillReports">;
    now: number;
  },
) {
  if (params.action === "none") return;

  const patch: Partial<Doc<"skills">> = {
    softDeletedAt: params.now,
    moderationStatus: "hidden",
    moderationReason: "manual.report",
    moderationNotes: trimModerationNote(params.note),
    hiddenAt: params.now,
    hiddenBy: params.actorUserId,
    unpublishedSlugReservedUntil: undefined,
    unpublishedSlugReleasedAt: undefined,
    unpublishedOriginalSlug: undefined,
    lastReviewedAt: params.now,
    updatedAt: params.now,
  };
  const nextSkill = { ...params.skill, ...patch };
  await ctx.db.patch(params.skill._id, patch);
  await adjustGlobalPublicCountForSkillChange(ctx, params.skill, nextSkill);
  await setSkillEmbeddingsSoftDeleted(ctx, params.skill._id, true, params.now);

  await ctx.db.insert("auditLogs", {
    actorUserId: params.actorUserId,
    action: "skill.report.final_action",
    targetType: "skill",
    targetId: params.skill._id,
    metadata: {
      slug: params.skill.slug,
      reportId: params.reportId,
      finalAction: params.action,
      reason: patch.moderationNotes,
    },
    createdAt: params.now,
  });
}

async function applySkillAppealFinalAction(
  ctx: MutationCtx,
  params: {
    actorUserId: Id<"users">;
    skill: Doc<"skills">;
    action: SkillAppealFinalAction;
    note: string;
    appealId: Id<"skillAppeals">;
    now: number;
  },
) {
  if (params.action === "none") return;

  const owner = params.skill.ownerUserId ? await ctx.db.get(params.skill.ownerUserId) : null;
  const latestVersion = params.skill.latestVersionId
    ? await ctx.db.get(params.skill.latestVersionId)
    : null;
  if (!latestVersion) {
    throw new ConvexError("Cannot restore appeal: latest scanner version is unavailable.");
  }
  const moderationPatch = buildScannerModerationPatchFromVersion({
    owner,
    version: latestVersion,
    now: params.now,
  });
  const patch: Partial<Doc<"skills">> = {
    softDeletedAt: undefined,
    ...moderationPatch,
    updatedAt: params.now,
  };
  const nextSkill = { ...params.skill, ...patch };
  await ctx.db.patch(params.skill._id, patch);
  await adjustGlobalPublicCountForSkillChange(ctx, params.skill, nextSkill);
  await setSkillEmbeddingsSoftDeleted(
    ctx,
    params.skill._id,
    nextSkill.moderationStatus === "hidden",
    params.now,
  );

  await ctx.db.insert("auditLogs", {
    actorUserId: params.actorUserId,
    action: "skill.appeal.final_action",
    targetType: "skill",
    targetId: params.skill._id,
    metadata: {
      slug: params.skill.slug,
      appealId: params.appealId,
      finalAction: params.action,
      reason: trimModerationNote(params.note),
    },
    createdAt: params.now,
  });
}

async function canUserAppealSkill(ctx: MutationCtx, skill: Doc<"skills">, userId: Id<"users">) {
  if (isDirectSkillOwner(skill, userId)) return true;
  if (!skill.ownerPublisherId) return false;
  const publisher = await ctx.db.get(skill.ownerPublisherId);
  return await canAccessPublisherOwnerScope(ctx, {
    publisher,
    userId,
    legacyOwnerUserId: skill.ownerUserId,
  });
}

async function getActiveSkillVersionForAppeal(
  ctx: MutationCtx,
  skill: Doc<"skills">,
  version: string | undefined,
) {
  if (version?.trim()) {
    const skillVersion = await ctx.db
      .query("skillVersions")
      .withIndex("by_skill_version", (q) => q.eq("skillId", skill._id).eq("version", version))
      .unique();
    if (!skillVersion || skillVersion.softDeletedAt)
      throw new ConvexError("Skill version not found");
    return skillVersion;
  }
  return skill.latestVersionId ? await ctx.db.get(skill.latestVersionId) : null;
}

// Deprecated compatibility path. First-class appeal intake is no longer exposed
// in the CLI/docs; keep this route backed until legacy clients age out.
export const submitSkillAppealForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    slug: v.string(),
    version: v.optional(v.string()),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");

    const resolved = await resolveSkillBySlugOrAlias(ctx, args.slug, {
      includeSoftDeleted: true,
    });
    const skill = resolved.skill;
    if (!skill) throw new ConvexError("Skill not found");
    if (!(await canUserAppealSkill(ctx, skill, actor._id))) throw new ConvexError("Unauthorized");

    const isAppealable =
      skill.softDeletedAt ||
      skill.moderationStatus === "hidden" ||
      skill.moderationStatus === "removed" ||
      skill.moderationVerdict === "suspicious" ||
      skill.moderationVerdict === "malicious" ||
      (skill.moderationReasonCodes?.length ?? 0) > 0 ||
      (skill.moderationFlags?.length ?? 0) > 0;
    if (!isAppealable) throw new ConvexError("Skill is not in an appealable state");

    const message = args.message.trim();
    if (!message) throw new ConvexError("Appeal message required.");
    const version = args.version?.trim();
    const skillVersion = await getActiveSkillVersionForAppeal(ctx, skill, version);

    const existingOpenAppeal = await ctx.db
      .query("skillAppeals")
      .withIndex("by_skill_status_createdAt", (q) =>
        q.eq("skillId", skill._id).eq("status", "open"),
      )
      .order("desc")
      .first();
    if (existingOpenAppeal) {
      return {
        ok: true as const,
        submitted: false,
        alreadyOpen: true,
        appealId: existingOpenAppeal._id,
        skillId: skill._id,
        status: existingOpenAppeal.status,
      };
    }

    const now = Date.now();
    const appealId = await ctx.db.insert("skillAppeals", {
      skillId: skill._id,
      ...(skillVersion ? { skillVersionId: skillVersion._id, version: skillVersion.version } : {}),
      userId: actor._id,
      message: message.slice(0, MAX_APPEAL_MESSAGE_LENGTH),
      status: "open",
      createdAt: now,
    });

    await appendSkillModerationEventLog(ctx, {
      kind: "appeal",
      appealId,
      actorUserId: actor._id,
      action: "skill.appeal.submit",
      timelineMetadata: {
        skillId: skill._id,
        slug: skill.slug,
        moderationStatus: skill.moderationStatus ?? "active",
        moderationVerdict: skill.moderationVerdict ?? null,
      },
      auditAction: "skill.appeal.submit",
      auditTargetType: "skillAppeal",
      auditTargetId: appealId,
      auditMetadata: {
        skillId: skill._id,
        slug: skill.slug,
        version: skillVersion?.version ?? null,
      },
      createdAt: now,
    });

    return {
      ok: true as const,
      submitted: true,
      alreadyOpen: false,
      appealId,
      skillId: skill._id,
      status: "open" as const,
    };
  },
});

export const listSkillReportsInternal = internalQuery({
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
      status === "all" || status === "open"
        ? ctx.db.query("skillReports").withIndex("by_createdAt", (q) => q)
        : ctx.db
            .query("skillReports")
            .withIndex("by_status_createdAt", (q) => q.eq("status", status));
    const page = await reportQuery.order("desc").paginate({
      cursor: args.cursor ?? null,
      numItems: limit,
    });

    const items: SkillReportListItem[] = [];
    for (const skillReport of page.page) {
      if (status === "open" && (skillReport.status ?? "open") !== "open") continue;
      const skill = await ctx.db.get(skillReport.skillId);
      if (!skill) continue;
      const reporter = await ctx.db.get(skillReport.userId);
      items.push(toSkillReportListItem(skillReport, skill, reporter));
    }

    return { items, nextCursor: page.isDone ? null : page.continueCursor, done: page.isDone };
  },
});

export const triageSkillReportForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    reportId: v.id("skillReports"),
    status: v.union(v.literal("open"), v.literal("confirmed"), v.literal("dismissed")),
    note: v.optional(v.string()),
    finalAction: v.optional(v.union(v.literal("none"), v.literal("hide"))),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
    assertModerator(actor);

    const skillReport = await ctx.db.get(args.reportId);
    if (!skillReport) throw new ConvexError("Skill report not found");
    const skill = await ctx.db.get(skillReport.skillId);
    if (!skill) throw new ConvexError("Skill report not found");

    const now = Date.now();
    const previousStatus = readArtifactReportStatus(skillReport.status);
    const nextStatus = args.status;
    assertArtifactReportTransition(previousStatus, nextStatus);
    const wasOpen = previousStatus === "open";
    const willBeOpen = nextStatus === "open";
    const note = args.note?.trim();
    if (!willBeOpen && !note) throw new ConvexError("Review note required.");
    const finalAction = args.finalAction ?? "none";
    assertArtifactReportFinalAction(nextStatus, finalAction, ["hide"]);

    await ctx.db.patch(skillReport._id, {
      status: nextStatus,
      triagedAt: willBeOpen ? undefined : now,
      triagedBy: willBeOpen ? undefined : actor._id,
      triageNote: willBeOpen ? undefined : note?.slice(0, MAX_REPORT_REASON_LENGTH),
      actionTaken: willBeOpen ? undefined : finalAction,
    });

    let reportCount = skill.reportCount ?? 0;
    if (wasOpen && !willBeOpen) reportCount = Math.max(0, reportCount - 1);
    if (!wasOpen && willBeOpen) reportCount += 1;
    if (reportCount !== (skill.reportCount ?? 0)) {
      await ctx.db.patch(skill._id, {
        reportCount,
        ...(willBeOpen ? { lastReportedAt: now } : {}),
        updatedAt: now,
      });
    }

    await applySkillReportFinalAction(ctx, {
      actorUserId: actor._id,
      skill,
      action: finalAction,
      note: note ?? "",
      reportId: skillReport._id,
      now,
    });

    await appendSkillModerationEventLog(ctx, {
      kind: "report",
      reportId: skillReport._id,
      actorUserId: actor._id,
      action: "skill.report.triage",
      timelineMetadata: { skillId: skill._id, status: args.status, finalAction },
      auditAction: "skill.report.triage",
      auditTargetType: "skillReport",
      auditTargetId: skillReport._id,
      auditMetadata: {
        skillId: skill._id,
        slug: skill.slug,
        status: args.status,
        finalAction,
        reportCount,
      },
      createdAt: now,
    });

    return {
      ok: true as const,
      reportId: skillReport._id,
      skillId: skill._id,
      status: args.status,
      reportCount,
      actionTaken: finalAction,
    };
  },
});

export const listSkillAppealsInternal = internalQuery({
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
        ? ctx.db.query("skillAppeals").withIndex("by_createdAt", (q) => q)
        : ctx.db
            .query("skillAppeals")
            .withIndex("by_status_createdAt", (q) => q.eq("status", status));
    const page = await appealQuery.order("desc").paginate({
      cursor: args.cursor ?? null,
      numItems: limit,
    });

    const items: SkillAppealListItem[] = [];
    for (const appeal of page.page) {
      const skill = await ctx.db.get(appeal.skillId);
      if (!skill) continue;
      const submitter = await ctx.db.get(appeal.userId);
      items.push(toSkillAppealListItem(appeal, skill, submitter));
    }

    return { items, nextCursor: page.isDone ? null : page.continueCursor, done: page.isDone };
  },
});

export const resolveSkillAppealForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    appealId: v.id("skillAppeals"),
    status: v.union(v.literal("open"), v.literal("accepted"), v.literal("rejected")),
    note: v.optional(v.string()),
    finalAction: v.optional(v.union(v.literal("none"), v.literal("restore"))),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
    assertModerator(actor);

    const appeal = await ctx.db.get(args.appealId);
    if (!appeal) throw new ConvexError("Skill appeal not found");
    const skill = await ctx.db.get(appeal.skillId);
    if (!skill) throw new ConvexError("Skill appeal not found");

    const note = args.note?.trim();
    const isOpen = args.status === "open";
    assertArtifactAppealTransition(appeal.status, args.status);
    if (!isOpen && !note) throw new ConvexError("Resolution note required.");
    const finalAction = args.finalAction ?? "none";
    assertArtifactAppealFinalAction(args.status, finalAction, ["restore"]);
    const now = Date.now();

    await ctx.db.patch(appeal._id, {
      status: args.status,
      resolvedAt: isOpen ? undefined : now,
      resolvedBy: isOpen ? undefined : actor._id,
      resolutionNote: isOpen ? undefined : note?.slice(0, MAX_APPEAL_MESSAGE_LENGTH),
      actionTaken: isOpen ? undefined : finalAction,
    });

    await applySkillAppealFinalAction(ctx, {
      actorUserId: actor._id,
      skill,
      action: finalAction,
      note: note ?? "",
      appealId: appeal._id,
      now,
    });

    await appendSkillModerationEventLog(ctx, {
      kind: "appeal",
      appealId: appeal._id,
      actorUserId: actor._id,
      action: "skill.appeal.resolve",
      timelineMetadata: { skillId: skill._id, status: args.status, finalAction },
      auditAction: "skill.appeal.resolve",
      auditTargetType: "skillAppeal",
      auditTargetId: appeal._id,
      auditMetadata: { skillId: skill._id, slug: skill.slug, status: args.status, finalAction },
      createdAt: now,
    });

    return {
      ok: true as const,
      appealId: appeal._id,
      skillId: skill._id,
      status: args.status,
      actionTaken: finalAction,
    };
  },
});

export const listSkillModerationEventLogsInternal = internalQuery({
  args: {
    actorUserId: v.id("users"),
    kind: v.union(v.literal("report"), v.literal("appeal")),
    reportId: v.optional(v.id("skillReports")),
    appealId: v.optional(v.id("skillAppeals")),
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
        .query("skillModerationEventLogs")
        .withIndex("by_report_createdAt", (q) => q.eq("reportId", args.reportId))
        .order("asc")
        .take(limit);
    }
    if (!args.appealId) throw new ConvexError("appealId required");
    return await ctx.db
      .query("skillModerationEventLogs")
      .withIndex("by_appeal_createdAt", (q) => q.eq("appealId", args.appealId))
      .order("asc")
      .take(limit);
  },
});

/** @deprecated V1 is gutted — returns empty results with no DB reads. */
export const listPublicPage = query({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    nonSuspiciousOnly: v.optional(v.boolean()),
    sort: v.optional(
      v.union(
        v.literal("updated"),
        v.literal("downloads"),
        v.literal("stars"),
        v.literal("installsCurrent"),
        v.literal("installsAllTime"),
        v.literal("trending"),
      ),
    ),
  },
  handler: async () => {
    return { items: [], nextCursor: null };
  },
});

/** @deprecated V2 is gutted — returns empty results with no DB reads. */
export const listPublicPageV2 = query({
  args: {
    paginationOpts: paginationOptsValidator,
    sort: v.optional(
      v.union(
        v.literal("default"),
        v.literal("recommended"),
        v.literal("newest"),
        v.literal("updated"),
        v.literal("downloads"),
        v.literal("installs"),
        v.literal("stars"),
        v.literal("name"),
      ),
    ),
    dir: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
    highlightedOnly: v.optional(v.boolean()),
    nonSuspiciousOnly: v.optional(v.boolean()),
  },
  handler: async () => {
    return { page: [], isDone: true, continueCursor: "" };
  },
});

/** V3 — kept intact for remaining subscribers during migration to V4. */
export const listPublicPageV3 = query({
  args: {
    paginationOpts: paginationOptsValidator,
    sort: v.optional(
      v.union(
        v.literal("newest"),
        v.literal("updated"),
        v.literal("downloads"),
        v.literal("installs"),
        v.literal("stars"),
        v.literal("name"),
      ),
    ),
    dir: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
    highlightedOnly: v.optional(v.boolean()),
    nonSuspiciousOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const sort = args.sort ?? "newest";
    const dir = args.dir ?? (sort === "name" ? "asc" : "desc");
    const { numItems, cursor: initialCursor } = normalizePublicListPagination(args.paginationOpts);

    const runPaginateBase = (cursor: string | null) =>
      ctx.db
        .query("skillSearchDigest")
        .withIndex(SORT_INDEXES[sort], (q) => q.eq("softDeletedAt", undefined))
        .order(dir)
        .paginate({ cursor, numItems });

    const runPaginateCompound = (cursor: string | null) =>
      ctx.db
        .query("skillSearchDigest")
        .withIndex(NONSUSPICIOUS_SORT_INDEXES[sort], (q) =>
          q.eq("softDeletedAt", undefined).eq("isSuspicious", false),
        )
        .order(dir)
        .paginate({ cursor, numItems });

    let result = await paginateWithStaleCursorRecovery(
      args.nonSuspiciousOnly ? runPaginateCompound : runPaginateBase,
      initialCursor,
    );

    if (
      args.nonSuspiciousOnly &&
      initialCursor === null &&
      result.page.length === 0 &&
      !result.isDone
    ) {
      result = await paginateWithStaleCursorRecovery(runPaginateBase, null);
    }

    const filteredPage = filterPublicSkillPage(result.page.map(digestToHydratableSkill), args);

    const filteredMap = new Map(filteredPage.map((s) => [s._id, s]));
    const items: PublicSkillEntry[] = [];
    for (const digest of result.page) {
      const hydratable = filteredMap.get(digest.skillId);
      if (!hydratable) continue;
      const publicSkill = toPublicSkill(hydratable);
      if (!publicSkill) continue;
      const ownerInfo = await addOfficialStatusToOwnerInfo(
        ctx,
        digestToOwnerInfo(digest),
        digest.ownerPublisherId,
      );
      if (!ownerInfo?.owner) continue;
      const latestVersion = await resolveDigestLatestVersionForSkill(ctx, digest);
      if (isHostedSkillPendingPublicReview(hydratable) && !latestVersion) continue;
      items.push({
        skill: publicSkill,
        latestVersion,
        ownerHandle: ownerInfo.ownerHandle,
        owner: ownerInfo.owner,
      });
    }
    return { ...result, page: items };
  },
});

type PublicListSort = keyof typeof SORT_INDEXES;
const TOPIC_SORT_INDEXES = {
  recommended: "by_active_topic_recommended_score",
  newest: "by_active_topic_created",
  updated: "by_active_topic_updated",
  name: "by_active_topic_name",
  downloads: "by_active_topic_downloads",
  stars: "by_active_topic_stars",
  installs: "by_active_topic_installs",
} as const satisfies Record<PublicListSort, string>;
const NONSUSPICIOUS_TOPIC_SORT_INDEXES = {
  recommended: "by_nonsuspicious_topic_recommended_score",
  newest: "by_nonsuspicious_topic_created",
  updated: "by_nonsuspicious_topic_updated",
  name: "by_nonsuspicious_topic_name",
  downloads: "by_nonsuspicious_topic_downloads",
  stars: "by_nonsuspicious_topic_stars",
  installs: "by_nonsuspicious_topic_installs",
} as const satisfies Record<PublicListSort, string>;
const CURATED_SORT_INDEXES = {
  recommended: "by_active_recommended_score",
  newest: "by_active_created",
  updated: "by_active_updated",
  name: "by_active_name",
  downloads: "by_active_downloads",
  stars: "by_active_stars",
  installs: "by_active_installs",
} as const satisfies Record<PublicListSort, string>;
const NONSUSPICIOUS_CURATED_SORT_INDEXES = {
  recommended: "by_nonsuspicious_recommended_score",
  newest: "by_nonsuspicious_created",
  updated: "by_nonsuspicious_updated",
  name: "by_nonsuspicious_name",
  downloads: "by_nonsuspicious_downloads",
  stars: "by_nonsuspicious_stars",
  installs: "by_nonsuspicious_installs",
} as const satisfies Record<PublicListSort, string>;
type SkillSearchDigestSortIndexName =
  | (typeof SORT_INDEXES)[keyof typeof SORT_INDEXES]
  | (typeof NONSUSPICIOUS_SORT_INDEXES)[keyof typeof NONSUSPICIOUS_SORT_INDEXES]
  | (typeof RECOMMENDED_RANK_INDEXES)[keyof typeof RECOMMENDED_RANK_INDEXES];
type OfficialFirstSkillCategoryCursorState = {
  phase: "curated" | "community";
  cursor: string | null;
  sort?: PublicListSort;
};
type PublicSkillListPage = {
  page: PublicSkillEntry[];
  hasMore: boolean;
  nextCursor: string | null;
};
const OFFICIAL_FIRST_SKILL_CATEGORY_CURSOR_PREFIX = "skillofficialfirst:";
const OFFICIAL_SKILL_CURSOR_PREFIX = "skillofficial:";

const SORT_INDEX_FIELD_COUNTS: Record<PublicListSort, number> = {
  recommended: 3,
  newest: 2,
  updated: 2,
  name: 2,
  downloads: 3,
  stars: 3,
  installs: 3,
};

const NONSUSPICIOUS_SORT_INDEX_FIELD_COUNTS: Record<PublicListSort, number> = {
  recommended: 4,
  newest: 3,
  updated: 3,
  name: 3,
  downloads: 4,
  stars: 4,
  installs: 4,
};
const GET_PAGE_TIEBREAKER_FIELD_COUNT = 2;
const PUBLIC_API_PREFIX_CURSOR_PREFIX = "skillprefix:";

function encodeIndexKeyValue(val: Value | undefined): Value {
  return val === undefined ? { __undef: 1 } : val;
}

function decodeIndexKeyValue(val: unknown): Value | undefined {
  if (val !== null && typeof val === "object" && "__undef" in (val as Record<string, unknown>)) {
    return undefined;
  }
  return val as Value;
}

function encodeIndexKey(indexName: string, key: IndexKey): string {
  return JSON.stringify({
    v: 1,
    index: indexName,
    key: key.map(encodeIndexKeyValue),
  });
}

function encodePublicApiPrefixCursor(prefix: string, indexName: string, key: IndexKey) {
  return `${PUBLIC_API_PREFIX_CURSOR_PREFIX}${JSON.stringify({
    prefix,
    cursor: encodeIndexKey(indexName, key),
  })}`;
}

function decodePublicApiPrefixCursor(cursor: string | undefined, prefix: string) {
  if (!cursor?.startsWith(PUBLIC_API_PREFIX_CURSOR_PREFIX)) return undefined;
  try {
    const parsed = JSON.parse(cursor.slice(PUBLIC_API_PREFIX_CURSOR_PREFIX.length)) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      (parsed as { prefix?: unknown }).prefix !== prefix ||
      typeof (parsed as { cursor?: unknown }).cursor !== "string"
    ) {
      return undefined;
    }
    return (parsed as { cursor: string }).cursor;
  } catch {
    return undefined;
  }
}

function indexKeyStartsWithPrefix(key: IndexKey, prefix: IndexKey): boolean {
  if (key.length < prefix.length) return false;
  return prefix.every((value, index) => key[index] === value);
}

function decodePublicListCursor({
  cursor,
  indexName,
  maxIndexKeyLength,
  eqPrefix,
  allowLegacyArray = true,
}: {
  cursor?: string;
  indexName: string;
  maxIndexKeyLength: number;
  eqPrefix: IndexKey;
  allowLegacyArray?: boolean;
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
    const arr =
      Array.isArray(parsed) && allowLegacyArray
        ? parsed
        : isSelfDescribingCursor
          ? (parsed as { key: unknown[] }).key
          : null;
    if (!Array.isArray(arr)) return null;
    const key = arr.map(decodeIndexKeyValue);
    // Self-describing cursors include the index name, so they can safely carry
    // getPage's full key with Convex's implicit _creationTime/_id tie-breakers.
    const maxLength = isSelfDescribingCursor
      ? maxIndexKeyLength + GET_PAGE_TIEBREAKER_FIELD_COUNT
      : maxIndexKeyLength;
    if (key.length > maxLength) return null;
    if (!indexKeyStartsWithPrefix(key, eqPrefix)) return null;
    return key;
  } catch {
    return null;
  }
}

function getPublicListCursorKey({
  cursor,
  sort,
  nonSuspiciousOnly,
  indexName,
  eqPrefix,
  allowLegacyArray,
}: {
  cursor?: string;
  sort: PublicListSort;
  nonSuspiciousOnly: boolean;
  indexName: string;
  eqPrefix: IndexKey;
  allowLegacyArray?: boolean;
}): IndexKey | null {
  const fieldCounts = nonSuspiciousOnly
    ? NONSUSPICIOUS_SORT_INDEX_FIELD_COUNTS
    : SORT_INDEX_FIELD_COUNTS;
  return decodePublicListCursor({
    cursor,
    indexName,
    maxIndexKeyLength: fieldCounts[sort],
    eqPrefix,
    allowLegacyArray,
  });
}

function encodeOfficialFirstSkillCategoryCursor(state: OfficialFirstSkillCategoryCursorState) {
  return `${OFFICIAL_FIRST_SKILL_CATEGORY_CURSOR_PREFIX}${JSON.stringify(state)}`;
}

function decodeOfficialFirstSkillCategoryCursor(
  raw: string | null | undefined,
): OfficialFirstSkillCategoryCursorState {
  if (!raw) return { phase: "curated", cursor: null };
  if (!raw.startsWith(OFFICIAL_FIRST_SKILL_CATEGORY_CURSOR_PREFIX)) {
    return { phase: "community", cursor: raw };
  }
  try {
    const parsed = JSON.parse(
      raw.slice(OFFICIAL_FIRST_SKILL_CATEGORY_CURSOR_PREFIX.length),
    ) as Partial<OfficialFirstSkillCategoryCursorState>;
    return {
      phase: parsed.phase === "community" ? "community" : "curated",
      cursor: typeof parsed.cursor === "string" ? parsed.cursor : null,
      sort:
        parsed.sort === "recommended" ||
        parsed.sort === "newest" ||
        parsed.sort === "updated" ||
        parsed.sort === "name" ||
        parsed.sort === "downloads" ||
        parsed.sort === "stars" ||
        parsed.sort === "installs"
          ? parsed.sort
          : undefined,
    };
  } catch {
    return { phase: "curated", cursor: null };
  }
}

function encodeOfficialSkillCursor(cursor: string) {
  return `${OFFICIAL_SKILL_CURSOR_PREFIX}${cursor}`;
}

function decodeOfficialSkillCursor(raw: string | undefined) {
  if (!raw) return { projection: "curated" as const, cursor: null };
  if (!raw.startsWith(OFFICIAL_SKILL_CURSOR_PREFIX)) {
    // Untagged cursors were emitted by the legacy projection. Keep that session on
    // the same table; fresh curated sessions tag every continuation cursor.
    return { projection: "legacy" as const, cursor: raw };
  }
  const cursor = raw.slice(OFFICIAL_SKILL_CURSOR_PREFIX.length);
  return { projection: "curated" as const, cursor: cursor || null };
}

/**
 * V4 of listPublicPage using convex-helpers `getPage()` for deterministic,
 * cacheable cursors. Two users requesting the same page produce identical
 * query args, enabling shared query caching across all users.
 */
export const listPublicPageV4 = query({
  args: {
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
    sort: v.optional(
      v.union(
        v.literal("default"),
        v.literal("recommended"),
        v.literal("newest"),
        v.literal("updated"),
        v.literal("downloads"),
        v.literal("installs"),
        v.literal("stars"),
        v.literal("name"),
      ),
    ),
    dir: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
    highlightedOnly: v.optional(v.boolean()),
    officialOnly: v.optional(v.boolean()),
    createdAfter: v.optional(v.number()),
    nonSuspiciousOnly: v.optional(v.boolean()),
    categorySlug: v.optional(v.string()),
    topic: v.optional(v.string()),
    officialFirst: v.optional(v.boolean()),
    categoryKeywords: v.optional(v.array(v.string())),
    excludeCategoryKeywords: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const categoryKeywords = normalizeRelatedCategoryKeywords(args.categoryKeywords ?? []);
    const excludeCategoryKeywords = normalizeRelatedCategoryKeywords(
      args.excludeCategoryKeywords ?? [],
    );
    const categorySlug = normalizeRelatedCategorySlug(args.categorySlug);
    const topic = args.topic ? normalizeCatalogTopic(args.topic) : undefined;
    if (args.topic !== undefined && !topic) {
      return { page: [], hasMore: false, nextCursor: null };
    }
    const officialFirstCursor =
      args.officialFirst && categorySlug
        ? decodeOfficialFirstSkillCategoryCursor(args.cursor)
        : null;
    const publicListCursor = args.cursor;
    const officialCursor = args.officialOnly ? decodeOfficialSkillCursor(args.cursor) : null;
    const requestedSort = normalizePublicListSort(args.sort);
    const dir = resolvePublicListDir(requestedSort, args.dir);
    const numItems = clampInt(args.numItems ?? 25, 1, MAX_PUBLIC_LIST_LIMIT);
    const eqPrefix: IndexKey = args.nonSuspiciousOnly ? [undefined, false] : [undefined];
    const recommendedIndexName = args.nonSuspiciousOnly
      ? NONSUSPICIOUS_SORT_INDEXES.recommended
      : SORT_INDEXES.recommended;
    const recommendedRankIndexName = getRecommendedRankIndexName(args.nonSuspiciousOnly ?? false);
    const updatedIndexName = args.nonSuspiciousOnly
      ? NONSUSPICIOUS_SORT_INDEXES.updated
      : SORT_INDEXES.updated;
    const recommendedCursor = getPublicListCursorKey({
      cursor: publicListCursor,
      sort: "recommended",
      nonSuspiciousOnly: args.nonSuspiciousOnly ?? false,
      indexName: recommendedIndexName,
      eqPrefix,
      allowLegacyArray: false,
    });
    const recommendedRankCursor = getRecommendedRankCursorKey({
      cursor: publicListCursor,
      nonSuspiciousOnly: args.nonSuspiciousOnly ?? false,
      eqPrefix,
    });
    const updatedCursor = getPublicListCursorKey({
      cursor: publicListCursor,
      sort: "updated",
      nonSuspiciousOnly: args.nonSuspiciousOnly ?? false,
      indexName: updatedIndexName,
      eqPrefix,
    });

    // Highlighted skills use a completely different path: query skillBadges
    // by kind to find highlighted skill IDs, then look up their digests.
    // This avoids scanning thousands of rows in the sort index.
    if (args.highlightedOnly) {
      return fetchHighlightedPage(ctx, {
        sort: requestedSort,
        dir,
        numItems,
        categorySlug,
        topic,
        categoryKeywords,
        excludeCategoryKeywords,
        nonSuspiciousOnly: args.nonSuspiciousOnly ?? false,
      });
    }

    if (officialFirstCursor && categorySlug) {
      return await listOfficialFirstSkillCategoryPage(ctx, {
        state: { ...officialFirstCursor, sort: officialFirstCursor.sort ?? requestedSort },
        sort: officialFirstCursor.sort ?? requestedSort,
        dir: resolvePublicListDir(officialFirstCursor.sort ?? requestedSort, args.dir),
        numItems,
        topic,
        categorySlug,
        categoryKeywords,
        excludeCategoryKeywords,
        nonSuspiciousOnly: args.nonSuspiciousOnly ?? false,
      });
    }

    if (args.officialOnly && officialCursor?.projection === "curated") {
      const result = await listCuratedSkillPage(ctx, {
        cursor: officialCursor.cursor,
        sort: requestedSort,
        dir,
        numItems,
        topic,
        categorySlug,
        categoryKeywords,
        excludeCategoryKeywords,
        nonSuspiciousOnly: args.nonSuspiciousOnly ?? false,
        officialOnly: true,
        createdAfter: args.createdAfter,
      });
      return {
        ...result,
        nextCursor: result.nextCursor ? encodeOfficialSkillCursor(result.nextCursor) : null,
      };
    }

    if (topic && !officialFirstCursor) {
      return await listSkillTopicFilteredPage(ctx, {
        cursor: publicListCursor,
        dir,
        numItems,
        sort: requestedSort,
        topic,
        categorySlug,
        categoryKeywords,
        excludeCategoryKeywords,
        nonSuspiciousOnly: args.nonSuspiciousOnly ?? false,
      });
    }

    const recommendedAnyCursor = recommendedCursor ?? recommendedRankCursor ?? updatedCursor;
    const hasMissingRecommendedScore =
      requestedSort === "recommended"
        ? await hasMissingRecommendedScores(
            ctx,
            args.nonSuspiciousOnly ?? false,
            recommendedAnyCursor,
          )
        : false;
    const recommendedResolution =
      requestedSort === "recommended"
        ? resolveRecommendedPublicListQuery({
            scoreIndexName: recommendedIndexName,
            rankIndexName: recommendedRankIndexName,
            updatedIndexName,
            scoreCursor: recommendedCursor,
            rankCursor: recommendedRankCursor,
            updatedCursor,
            hasMissingScores: hasMissingRecommendedScore,
          })
        : null;
    const sort = recommendedResolution?.sort ?? requestedSort;
    const indexName =
      recommendedResolution?.indexName ??
      (args.nonSuspiciousOnly ? NONSUSPICIOUS_SORT_INDEXES[sort] : SORT_INDEXES[sort]);
    const decodedCursor =
      recommendedResolution?.decodedCursor ??
      getPublicListCursorKey({
        cursor: publicListCursor,
        sort,
        nonSuspiciousOnly: args.nonSuspiciousOnly ?? false,
        indexName,
        eqPrefix,
      });
    const isFirstPage = !decodedCursor;
    const startIndexKey: IndexKey = decodedCursor ?? eqPrefix;

    const hasDigestFilters =
      Boolean(categorySlug) ||
      Boolean(topic) ||
      Boolean(args.officialOnly) ||
      typeof args.createdAfter === "number" ||
      categoryKeywords.length > 0 ||
      excludeCategoryKeywords.length > 0;

    if (!hasDigestFilters) {
      const result = await getPage(ctx, {
        table: "skillSearchDigest",
        startIndexKey,
        startInclusive: isFirstPage,
        endIndexKey: eqPrefix,
        endInclusive: true,
        absoluteMaxRows: numItems,
        order: dir,
        index: indexName,
        schema,
      });

      const items: PublicSkillEntry[] = [];
      for (const digest of result.page) {
        const item = await buildPublicSkillEntryFromDigest(ctx, digest);
        if (item) items.push(item);
      }
      let nextCursor: string | null = null;
      if (result.hasMore && result.indexKeys.length > 0) {
        nextCursor = encodeIndexKey(indexName, result.indexKeys[result.indexKeys.length - 1]);
      }

      return { page: items, hasMore: result.hasMore, nextCursor };
    }

    const items: PublicSkillEntry[] = [];
    let scanCursor = startIndexKey;
    let scanInclusive = isFirstPage;
    let hasMore = false;
    let nextCursor: string | null = null;
    let remainingRows = Math.max(
      numItems,
      Math.min(MAX_FILTERED_PUBLIC_LIST_SCAN_ROWS, numItems * 12),
    );

    for (let pageCount = 0; pageCount < MAX_FILTERED_PUBLIC_LIST_SCAN_PAGES; pageCount += 1) {
      if (remainingRows <= 0) break;
      const batchSize = Math.min(remainingRows, Math.max(numItems * 3, numItems));
      const result = await getPage(ctx, {
        table: "skillSearchDigest",
        startIndexKey: scanCursor,
        startInclusive: scanInclusive,
        endIndexKey: eqPrefix,
        endInclusive: true,
        absoluteMaxRows: batchSize,
        order: dir,
        index: indexName,
        schema,
      });
      remainingRows -= batchSize;
      if (result.indexKeys.length === 0) {
        hasMore = false;
        nextCursor = null;
        break;
      }

      for (let index = 0; index < result.page.length; index += 1) {
        const digest = result.page[index];
        const cursor = result.indexKeys[index];
        if (
          sort === "newest" &&
          dir === "desc" &&
          typeof args.createdAfter === "number" &&
          digest.createdAt < args.createdAfter
        ) {
          return { page: items, hasMore: false, nextCursor: null };
        }
        if (
          (!args.officialOnly || isSkillCatalogOfficial(digest)) &&
          (typeof args.createdAfter !== "number" || digest.createdAt >= args.createdAfter) &&
          digestPassesPublicListFilters(digest, {
            categorySlug,
            topic,
            categoryKeywords,
            excludeCategoryKeywords,
          })
        ) {
          const item = await buildPublicSkillEntryFromDigest(ctx, digest);
          if (item) items.push(item);
        }
        if (items.length >= numItems) {
          const nextDigest = result.page[index + 1];
          if (
            sort === "newest" &&
            dir === "desc" &&
            typeof args.createdAfter === "number" &&
            nextDigest &&
            nextDigest.createdAt < args.createdAfter
          ) {
            return { page: items, hasMore: false, nextCursor: null };
          }
          hasMore = result.hasMore || index < result.page.length - 1;
          nextCursor = hasMore ? encodeIndexKey(indexName, cursor) : null;
          return { page: items, hasMore, nextCursor };
        }
      }

      if (!result.hasMore) {
        hasMore = false;
        nextCursor = null;
        break;
      }

      scanCursor = result.indexKeys[result.indexKeys.length - 1];
      scanInclusive = false;
      hasMore = true;
      nextCursor = encodeIndexKey(indexName, scanCursor);
    }

    return { page: items, hasMore, nextCursor };
  },
});

type ServerSkillCategorySlug = SkillCategorySlug;

function normalizeRelatedCategorySlug(categorySlug: string | undefined) {
  const value = categorySlug?.trim().toLowerCase();
  return isSkillCategorySlug(value) ? value : null;
}

function normalizeRelatedCategoryKeywords(keywords: string[]) {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const keyword of keywords) {
    const value = keyword.trim().toLowerCase();
    if (!value || value.length > 40 || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
    if (normalized.length >= 12) break;
  }

  return normalized;
}

function stripGeneratedRelatedSlugPrefixTokens(tokens: string[]) {
  if (tokens[0] !== "dev") return tokens;
  const maybeGeneratedId = tokens[1];
  if (!maybeGeneratedId || maybeGeneratedId.length < 7 || !/\d/.test(maybeGeneratedId)) {
    return tokens;
  }
  return tokens.slice(2);
}

function relatedTokenMatchesKeyword(token: string, keyword: string) {
  if (token === keyword) return true;
  if (keyword === "dev") {
    return token === "developer" || token === "development" || token === "devops";
  }
  if (keyword === "api") {
    return token === "apis";
  }
  return keyword.length >= 4 && token.includes(keyword);
}

function digestMatchesRelatedCategory(
  digest: Pick<Doc<"skillSearchDigest">, "slug" | "displayName" | "summary">,
  keywords: string[],
) {
  const primaryTokens = tokenize([digest.displayName, digest.summary ?? ""].join(" "));
  const slugTokens = stripGeneratedRelatedSlugPrefixTokens(tokenize(digest.slug));

  return keywords.some(
    (keyword) =>
      primaryTokens.some((token) => relatedTokenMatchesKeyword(token, keyword)) ||
      slugTokens.some((token) => relatedTokenMatchesKeyword(token, keyword)),
  );
}

function digestPassesPublicListFilters(
  digest: Pick<
    Doc<"skillSearchDigest">,
    "slug" | "displayName" | "summary" | "categories" | "topics"
  >,
  opts: {
    categorySlug: ServerSkillCategorySlug | null;
    topic?: string;
    categoryKeywords: string[];
    excludeCategoryKeywords: string[];
  },
) {
  if (opts.categorySlug && !resolveStoredSkillCategories(digest).includes(opts.categorySlug)) {
    return false;
  }
  if (opts.topic && !getCatalogTopicSlugs(digest.topics).includes(opts.topic)) {
    return false;
  }
  if (
    !opts.categorySlug &&
    opts.categoryKeywords.length > 0 &&
    !digestMatchesRelatedCategory(digest, opts.categoryKeywords)
  ) {
    return false;
  }
  if (
    !opts.categorySlug &&
    opts.excludeCategoryKeywords.length > 0 &&
    digestMatchesRelatedCategory(digest, opts.excludeCategoryKeywords)
  ) {
    return false;
  }
  return true;
}

async function listSkillTopicFilteredPage(
  ctx: QueryCtx,
  opts: {
    cursor?: string;
    dir: "asc" | "desc";
    numItems: number;
    sort: PublicListSort;
    topic: string;
    categorySlug: ServerSkillCategorySlug | null;
    categoryKeywords: string[];
    excludeCategoryKeywords: string[];
    nonSuspiciousOnly: boolean;
    excludeCurated?: boolean;
  },
): Promise<PublicSkillListPage> {
  const eqPrefix: IndexKey = opts.nonSuspiciousOnly
    ? [undefined, false, opts.topic]
    : [undefined, opts.topic];
  const getTopicIndexName = (sort: PublicListSort) =>
    opts.nonSuspiciousOnly ? NONSUSPICIOUS_TOPIC_SORT_INDEXES[sort] : TOPIC_SORT_INDEXES[sort];
  const decodeTopicCursor = (sort: PublicListSort) =>
    decodePublicListCursor({
      cursor: opts.cursor,
      indexName: getTopicIndexName(sort),
      maxIndexKeyLength: eqPrefix.length + (sort === "updated" ? 1 : 2),
      eqPrefix,
      allowLegacyArray: false,
    });
  const recommendedCursor = opts.sort === "recommended" ? decodeTopicCursor("recommended") : null;
  const sort = opts.sort;
  const indexName = getTopicIndexName(sort);
  const decodedCursor = opts.sort === "recommended" ? recommendedCursor : decodeTopicCursor(sort);
  const items: PublicSkillEntry[] = [];
  let scanCursor = decodedCursor ?? eqPrefix;
  let scanInclusive = !decodedCursor;
  let hasMore = false;
  let nextCursor: string | null = null;
  let remainingRows = Math.max(
    opts.numItems,
    Math.min(MAX_FILTERED_PUBLIC_LIST_SCAN_ROWS, opts.numItems * 12),
  );

  for (let pageCount = 0; pageCount < MAX_FILTERED_PUBLIC_LIST_SCAN_PAGES; pageCount += 1) {
    if (remainingRows <= 0) break;
    const batchSize = Math.min(remainingRows, Math.max(opts.numItems * 3, opts.numItems));
    const result = await getPage(ctx, {
      table: "skillTopicSearchDigest",
      startIndexKey: scanCursor,
      startInclusive: scanInclusive,
      endIndexKey: eqPrefix,
      endInclusive: true,
      absoluteMaxRows: batchSize,
      order: opts.dir,
      index: indexName,
      schema,
    });
    remainingRows -= batchSize;
    if (result.indexKeys.length === 0) {
      hasMore = false;
      nextCursor = null;
      break;
    }

    for (let index = 0; index < result.page.length; index += 1) {
      const topicDigest = result.page[index];
      const cursor = result.indexKeys[index];
      const digest = await ctx.db
        .query("skillSearchDigest")
        .withIndex("by_skill", (q) => q.eq("skillId", topicDigest.skillId))
        .unique();
      if (
        digest &&
        (!opts.excludeCurated || !isCuratedSkillDigest(digest)) &&
        digestPassesPublicListFilters(digest, {
          categorySlug: opts.categorySlug,
          topic: opts.topic,
          categoryKeywords: opts.categoryKeywords,
          excludeCategoryKeywords: opts.excludeCategoryKeywords,
        })
      ) {
        const item = await buildPublicSkillEntryFromDigest(ctx, digest);
        if (item) items.push(item);
      }
      if (items.length >= opts.numItems) {
        hasMore = result.hasMore || index < result.page.length - 1;
        nextCursor = hasMore ? encodeIndexKey(indexName, cursor) : null;
        return { page: items, hasMore, nextCursor };
      }
    }

    if (!result.hasMore) {
      hasMore = false;
      nextCursor = null;
      break;
    }
    scanCursor = result.indexKeys[result.indexKeys.length - 1];
    scanInclusive = false;
    hasMore = true;
    nextCursor = encodeIndexKey(indexName, scanCursor);
  }

  return { page: items, hasMore, nextCursor };
}

export const listRelatedByCategory = query({
  args: {
    skillId: v.id("skills"),
    categorySlug: v.optional(v.string()),
    keywords: v.array(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const keywords = normalizeRelatedCategoryKeywords(args.keywords);
    const categorySlug = normalizeRelatedCategorySlug(args.categorySlug);
    if (keywords.length === 0) return { items: [] };

    const limit = clampInt(
      args.limit ?? DEFAULT_RELATED_CATEGORY_SKILL_LIMIT,
      1,
      MAX_RELATED_CATEGORY_SKILL_LIMIT,
    );
    const scanLimit = Math.min(MAX_RELATED_CATEGORY_SCAN_ROWS, Math.max(80, limit * 24));

    const digests = await ctx.db
      .query("skillSearchDigest")
      .withIndex("by_active_stats_downloads", (q) => q.eq("softDeletedAt", undefined))
      .order("desc")
      .take(scanLimit);

    const items: PublicSkillEntry[] = [];
    for (const digest of digests) {
      if (digest.skillId === args.skillId) continue;
      const hydratable = digestToHydratableSkill(digest);
      if (isSkillSuspicious(hydratable)) continue;
      const hasExplicitCategoryMatch = Boolean(
        categorySlug && digest.categories?.includes(categorySlug),
      );
      if (categorySlug && !resolveStoredSkillCategories(digest).includes(categorySlug)) continue;
      if (!hasExplicitCategoryMatch && !digestMatchesRelatedCategory(digest, keywords)) continue;
      const item = await buildPublicSkillEntryFromDigest(ctx, digest);
      if (!item) continue;
      items.push(item);
      if (items.length >= limit) break;
    }

    return { items };
  },
});

export const listPublicTrendingPage = query({
  args: {
    limit: v.optional(v.number()),
    nonSuspiciousOnly: v.optional(v.boolean()),
    categorySlug: v.optional(v.string()),
    topic: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = clampInt(args.limit ?? 25, 1, MAX_PUBLIC_LIST_LIMIT);
    const normalizedCategorySlug = args.categorySlug?.trim().toLowerCase();
    const categorySlug =
      args.categorySlug === undefined
        ? undefined
        : normalizedCategorySlug && isSkillCategorySlug(normalizedCategorySlug)
          ? normalizedCategorySlug
          : null;
    if (args.categorySlug !== undefined && categorySlug === null) {
      return { items: [], nextCursor: null };
    }
    const topic = args.topic === undefined ? undefined : normalizeCatalogTopic(args.topic);
    if (args.topic !== undefined && !topic) return { items: [], nextCursor: null };
    const kind = args.nonSuspiciousOnly
      ? TRENDING_NON_SUSPICIOUS_LEADERBOARD_KIND
      : TRENDING_LEADERBOARD_KIND;
    let leaderboard = await ctx.db
      .query("skillLeaderboards")
      .withIndex("by_kind", (q) => q.eq("kind", kind))
      .order("desc")
      .first();

    // Older deployments may have the general snapshot but not the
    // non-suspicious snapshot yet. Keep trending populated during rollout.
    if (!leaderboard && args.nonSuspiciousOnly) {
      leaderboard = await ctx.db
        .query("skillLeaderboards")
        .withIndex("by_kind", (q) => q.eq("kind", TRENDING_LEADERBOARD_KIND))
        .order("desc")
        .first();
    }

    if (!leaderboard) {
      // The first leaderboard snapshot may not exist yet after deployment.
      // Use a bounded recent catalog warm-up instead of rendering an empty page.
      const fallbackDigests = await ctx.db
        .query("skillSearchDigest")
        .withIndex("by_active_updated", (q) => q.eq("softDeletedAt", undefined))
        .order("desc")
        .take(Math.min(Math.max(limit * 8, limit), 200));
      const fallbackItems: PublicSkillEntry[] = [];
      for (const digest of fallbackDigests) {
        if (args.nonSuspiciousOnly && digest.isSuspicious) continue;
        if (categorySlug && !resolveStoredSkillCategories(digest).includes(categorySlug)) continue;
        if (topic && !getCatalogTopicSlugs(digest.topics).includes(topic)) continue;
        const item = await buildPublicSkillEntryFromDigest(ctx, digest);
        if (!item) continue;
        fallbackItems.push(item);
        if (fallbackItems.length >= limit) break;
      }
      return { items: fallbackItems, nextCursor: null };
    }

    const items: PublicSkillEntry[] = [];
    for (const entry of leaderboard.items) {
      const digest = await ctx.db
        .query("skillSearchDigest")
        .withIndex("by_skill", (q) => q.eq("skillId", entry.skillId))
        .unique();
      if (!digest) continue;
      if (args.nonSuspiciousOnly && digest.isSuspicious) continue;
      if (categorySlug && !resolveStoredSkillCategories(digest).includes(categorySlug)) continue;
      if (topic && !getCatalogTopicSlugs(digest.topics).includes(topic)) continue;
      const item = await buildPublicSkillEntryFromDigest(ctx, digest);
      if (!item) continue;
      items.push(item);
      if (items.length >= limit) break;
    }

    return { items, nextCursor: null };
  },
});

export const listAuditPage = query({
  args: {
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const { numItems, cursor } = normalizePublicListPagination(args.paginationOpts);
    const result = await ctx.db
      .query("skillSearchDigest")
      .withIndex("by_active_stats_downloads", (q) => q.eq("softDeletedAt", undefined))
      .order("desc")
      .paginate({ cursor, numItems });

    const page = [];
    for (const digest of result.page) {
      const entry = await buildPublicSkillEntryFromDigest(ctx, digest);
      if (!entry) continue;
      const latestVersion = await loadPublicLatestVersionForDigest(ctx, digest);
      page.push({
        kind: "skill" as const,
        skill: entry.skill,
        ownerHandle: entry.ownerHandle,
        owner: entry.owner,
        latestVersion: latestVersion
          ? {
              version: latestVersion.version,
              createdAt: latestVersion.createdAt,
              vtAnalysis: latestVersion.vtAnalysis,
              llmAnalysis: latestVersion.llmAnalysis,
              staticScan: latestVersion.staticScan
                ? {
                    status: latestVersion.staticScan.status,
                    reasonCodes: latestVersion.staticScan.reasonCodes,
                    findings: (latestVersion.staticScan.findings ?? []).map((finding) => ({
                      code: finding.code,
                      severity: finding.severity,
                      file: finding.file,
                      line: finding.line,
                      message: finding.message,
                      evidence: "",
                    })),
                    summary: latestVersion.staticScan.summary,
                    engineVersion: latestVersion.staticScan.engineVersion,
                    checkedAt: latestVersion.staticScan.checkedAt,
                  }
                : null,
            }
          : null,
      });
    }

    return result.isDone
      ? { page, hasMore: false, nextCursor: null }
      : { page, hasMore: true, nextCursor: result.continueCursor };
  },
});

async function buildPublicSkillEntryFromDigest(
  ctx: Pick<QueryCtx, "db">,
  digest: Doc<"skillSearchDigest">,
): Promise<PublicSkillEntry | null> {
  const hydratable = digestToHydratableSkill(digest);
  if (shouldExcludeSkillFromPublicBrowse(hydratable)) return null;
  const publicSkill = toPublicSkill(hydratable);
  if (!publicSkill) return null;
  const ownerInfo = await addOfficialStatusToOwnerInfo(
    ctx,
    digestToOwnerInfo(digest),
    digest.ownerPublisherId,
  );
  if (!ownerInfo?.owner) return null;
  const latestVersion = await resolveDigestLatestVersionForSkill(ctx, digest);
  if (isHostedSkillPendingPublicReview(hydratable) && !latestVersion) return null;
  return {
    skill: publicSkill,
    latestVersion,
    ownerHandle: ownerInfo.ownerHandle,
    owner: ownerInfo.owner,
  };
}

async function addOfficialStatusToOwnerInfo(
  ctx: Pick<QueryCtx, "db">,
  ownerInfo: { ownerHandle: string | null; owner: PublicPublisher | null } | null,
  publisherId?: Id<"publishers">,
) {
  if (!ctx?.db || !ownerInfo?.owner || !publisherId) return ownerInfo;
  const official = await hasOfficialPublisherRow(ctx, publisherId);
  return official ? { ...ownerInfo, owner: { ...ownerInfo.owner, official: true } } : ownerInfo;
}

async function loadPublicLatestVersionForDigest(
  ctx: Pick<QueryCtx, "db">,
  digest: Pick<
    Doc<"skillSearchDigest">,
    | "skillId"
    | "latestVersionId"
    | "latestVersionSkillId"
    | "publicVersion"
    | "moderationReason"
    | "moderationFlags"
    | "stats"
    | "installKind"
  >,
) {
  if (digest.publicVersion?.status === "unavailable") return null;
  if (digest.publicVersion?.status === "available") {
    const version = await ctx.db.get(digest.publicVersion.versionId);
    return isPublicSkillVersionAvailableForSkill(version, digest.skillId) ? version : null;
  }
  if (!digest.latestVersionId) return null;
  if (digest.latestVersionSkillId !== undefined && digest.latestVersionSkillId !== digest.skillId) {
    return null;
  }

  const needsApprovedSnapshot =
    isHostedSkillPendingPublicReview(digest) && hostedSkillMayHavePriorApprovedVersion(digest);

  if (!needsApprovedSnapshot) {
    const version = await ctx.db.get(digest.latestVersionId);
    return isPublicSkillVersionAvailableForSkill(version, digest.skillId) ? version : null;
  }

  const skill = await ctx.db.get(digest.skillId);
  if (!skill) return null;
  const version = await resolvePublicBrowseVersionForSkill(ctx, skill);
  return version && isPublicSkillVersionAvailableForSkill(version, digest.skillId) ? version : null;
}

async function resolveDigestLatestVersionForSkill(
  ctx: Pick<QueryCtx, "db">,
  digest: Doc<"skillSearchDigest">,
) {
  if (digest.publicVersion?.status === "unavailable") return null;
  const publicVersionId =
    digest.publicVersion?.status === "available" ? digest.publicVersion.versionId : undefined;
  const needsApprovedSnapshot =
    isHostedSkillPendingPublicReview(digest) && hostedSkillMayHavePriorApprovedVersion(digest);

  if (
    (!needsApprovedSnapshot || publicVersionId === digest.latestVersionId) &&
    digest.latestVersionSummary &&
    digest.latestVersionId &&
    (!publicVersionId || publicVersionId === digest.latestVersionId) &&
    (digest.latestVersionSkillId === undefined || digest.latestVersionSkillId === digest.skillId)
  ) {
    return toPublicSkillListVersionFromSummary(
      digest.latestVersionSummary,
      digest.latestVersionId,
      digest.skillId,
    );
  }

  const version = await loadPublicLatestVersionForDigest(ctx, digest);
  if (!version) return null;

  if (
    digest.latestVersionSummary &&
    digest.latestVersionId === version._id &&
    (digest.latestVersionSkillId === undefined || digest.latestVersionSkillId === digest.skillId)
  ) {
    return toPublicSkillListVersionFromSummary(
      digest.latestVersionSummary,
      version._id,
      digest.skillId,
    );
  }

  return toPublicSkillListVersion(version);
}

async function buildPublicSkillApiListEntryFromDigest(
  ctx: Pick<QueryCtx, "db">,
  digest: Doc<"skillSearchDigest">,
) {
  const hydratable = digestToHydratableSkill(digest);
  if (shouldExcludeSkillFromPublicBrowse(hydratable)) return null;
  const publicSkill = toPublicSkill(hydratable);
  if (!publicSkill) return null;
  const ownerInfo = digestToOwnerInfo(digest);
  if (!ownerInfo?.owner || !ownerInfo.ownerHandle) return null;
  const latestVersion = await resolveDigestLatestVersionForSkill(ctx, digest);
  if (isHostedSkillPendingPublicReview(hydratable) && !latestVersion) return null;

  return {
    skill: {
      _id: publicSkill._id,
      slug: publicSkill.slug,
      displayName: publicSkill.displayName,
      summary: publicSkill.summary,
      topics: publicSkill.topics,
      tags: publicSkill.tags,
      stats: publicSkill.stats,
      createdAt: publicSkill.createdAt,
      updatedAt: publicSkill.updatedAt,
      latestVersionId: publicSkill.latestVersionId,
    },
    ownerHandle: ownerInfo.ownerHandle,
    latestVersion,
  };
}

export const listPublicApiPageV1 = query({
  args: {
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
    prefix: v.optional(v.string()),
    sort: v.optional(
      v.union(
        v.literal("default"),
        v.literal("recommended"),
        v.literal("newest"),
        v.literal("updated"),
        v.literal("downloads"),
        v.literal("installs"),
        v.literal("stars"),
        v.literal("name"),
      ),
    ),
    dir: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
    nonSuspiciousOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const normalizedPrefix = normalizeSkillSlug(args.prefix);
    const requestedSort = normalizePublicListSort(args.sort);
    const dir = resolvePublicListDir(requestedSort, args.dir);
    const numItems = clampInt(args.numItems ?? 25, 1, MAX_PUBLIC_LIST_LIMIT);
    const eqPrefix: IndexKey = args.nonSuspiciousOnly ? [undefined, false] : [undefined];
    if (normalizedPrefix) {
      const indexName = args.nonSuspiciousOnly
        ? "by_nonsuspicious_normalized_slug"
        : "by_active_normalized_slug";
      const decodedCursor = decodePublicListCursor({
        cursor: decodePublicApiPrefixCursor(args.cursor, normalizedPrefix),
        indexName,
        // Count declared index fields only; the decoder adds getPage's two tie-breakers.
        maxIndexKeyLength: args.nonSuspiciousOnly ? 3 : 2,
        eqPrefix,
        allowLegacyArray: false,
      });
      const normalizedSlugIndex = eqPrefix.length;
      const cursorSlug = decodedCursor?.[normalizedSlugIndex];
      const prefixCursor =
        typeof cursorSlug === "string" && cursorSlug.startsWith(normalizedPrefix)
          ? decodedCursor
          : null;
      const result = await getPage(ctx, {
        table: "skillSearchDigest",
        startIndexKey: prefixCursor ?? [...eqPrefix, normalizedPrefix],
        startInclusive: !prefixCursor,
        endIndexKey: [...eqPrefix, `${normalizedPrefix}\uffff`],
        endInclusive: false,
        absoluteMaxRows: numItems,
        order: "asc",
        index: indexName,
        schema,
      });
      const items = [];
      for (const digest of result.page) {
        const item = await buildPublicSkillApiListEntryFromDigest(ctx, digest);
        if (item) items.push(item);
      }
      const nextCursor =
        result.hasMore && result.indexKeys.length > 0
          ? encodePublicApiPrefixCursor(
              normalizedPrefix,
              indexName,
              result.indexKeys[result.indexKeys.length - 1],
            )
          : null;
      return { items, nextCursor };
    }
    const recommendedIndexName = args.nonSuspiciousOnly
      ? NONSUSPICIOUS_SORT_INDEXES.recommended
      : SORT_INDEXES.recommended;
    const recommendedRankIndexName = getRecommendedRankIndexName(args.nonSuspiciousOnly ?? false);
    const updatedIndexName = args.nonSuspiciousOnly
      ? NONSUSPICIOUS_SORT_INDEXES.updated
      : SORT_INDEXES.updated;
    const recommendedCursor = getPublicListCursorKey({
      cursor: args.cursor,
      sort: "recommended",
      nonSuspiciousOnly: args.nonSuspiciousOnly ?? false,
      indexName: recommendedIndexName,
      eqPrefix,
      allowLegacyArray: false,
    });
    const recommendedRankCursor = getRecommendedRankCursorKey({
      cursor: args.cursor,
      nonSuspiciousOnly: args.nonSuspiciousOnly ?? false,
      eqPrefix,
    });
    const updatedCursor = getPublicListCursorKey({
      cursor: args.cursor,
      sort: "updated",
      nonSuspiciousOnly: args.nonSuspiciousOnly ?? false,
      indexName: updatedIndexName,
      eqPrefix,
    });
    const recommendedAnyCursor = recommendedCursor ?? recommendedRankCursor ?? updatedCursor;
    const hasMissingRecommendedScore =
      requestedSort === "recommended"
        ? await hasMissingRecommendedScores(
            ctx,
            args.nonSuspiciousOnly ?? false,
            recommendedAnyCursor,
          )
        : false;
    const recommendedResolution =
      requestedSort === "recommended"
        ? resolveRecommendedPublicListQuery({
            scoreIndexName: recommendedIndexName,
            rankIndexName: recommendedRankIndexName,
            updatedIndexName,
            scoreCursor: recommendedCursor,
            rankCursor: recommendedRankCursor,
            updatedCursor,
            hasMissingScores: hasMissingRecommendedScore,
          })
        : null;
    const sort = recommendedResolution?.sort ?? requestedSort;
    const indexName =
      recommendedResolution?.indexName ??
      (args.nonSuspiciousOnly ? NONSUSPICIOUS_SORT_INDEXES[sort] : SORT_INDEXES[sort]);
    const decodedCursor =
      recommendedResolution?.decodedCursor ??
      getPublicListCursorKey({
        cursor: args.cursor,
        sort,
        nonSuspiciousOnly: args.nonSuspiciousOnly ?? false,
        indexName,
        eqPrefix,
      });
    const isFirstPage = !decodedCursor;
    const result = await getPage(ctx, {
      table: "skillSearchDigest",
      startIndexKey: decodedCursor ?? eqPrefix,
      startInclusive: isFirstPage,
      endIndexKey: eqPrefix,
      endInclusive: true,
      absoluteMaxRows: numItems,
      order: dir,
      index: indexName,
      schema,
    });
    const items = [];
    for (const digest of result.page) {
      const item = await buildPublicSkillApiListEntryFromDigest(ctx, digest);
      if (item) items.push(item);
    }
    const nextCursor =
      result.hasMore && result.indexKeys.length > 0
        ? encodeIndexKey(indexName, result.indexKeys[result.indexKeys.length - 1])
        : null;
    return { items, nextCursor };
  },
});

type PublicSkillCatalogItem = {
  name: string;
  displayName: string;
  family: "skill";
  runtimeId: null;
  channel: "official" | "community";
  isOfficial: boolean;
  summary: string | null;
  categories?: string[];
  topics?: string[];
  ownerHandle: string | null;
  createdAt: number;
  updatedAt: number;
  latestVersion: string | null;
  featuredAt?: number;
  verificationTier: null;
  stats: { downloads: number; installs: number; stars: number; versions: number };
};

type SkillCatalogCursorState = {
  cursor: string | null;
  offset: number;
  pageSize: number | null;
  done: boolean;
  recommendedFallback?: SkillCatalogRecommendedFallbackSort;
};

type SkillCatalogRecommendedFallbackSort = "updated" | "downloads";

const SKILL_CATALOG_RECOMMENDED_FALLBACK_SORT = "downloads" as const;

function normalizeSkillCatalogRecommendedFallbackSort(
  value: unknown,
): SkillCatalogRecommendedFallbackSort | undefined {
  if (value === "installs") return "downloads";
  return value === "updated" || value === SKILL_CATALOG_RECOMMENDED_FALLBACK_SORT
    ? value
    : undefined;
}

function readSkillCatalogCursorField(input: unknown, field: string): unknown {
  if (input === null || typeof input !== "object") return undefined;
  return Object.getOwnPropertyDescriptor(input, field)?.value;
}

function encodeSkillCatalogCursor(state: SkillCatalogCursorState) {
  if (state.done && state.offset === 0) return "";
  return `${SKILL_CATALOG_CURSOR_PREFIX}${JSON.stringify(state)}`;
}

function decodeSkillCatalogCursor(raw: string | null | undefined): SkillCatalogCursorState {
  if (!raw) return { cursor: null, offset: 0, pageSize: null, done: false };
  if (!raw.startsWith(SKILL_CATALOG_CURSOR_PREFIX)) {
    return { cursor: raw, offset: 0, pageSize: null, done: false };
  }
  try {
    const parsed: unknown = JSON.parse(raw.slice(SKILL_CATALOG_CURSOR_PREFIX.length));
    const recommendedFallbackValue = readSkillCatalogCursorField(parsed, "recommendedFallback");
    const resetLegacyInstallCursorState = recommendedFallbackValue === "installs";
    const cursorValue = readSkillCatalogCursorField(parsed, "cursor");
    const offsetValue = readSkillCatalogCursorField(parsed, "offset");
    const pageSizeValue = readSkillCatalogCursorField(parsed, "pageSize");
    const doneValue = readSkillCatalogCursorField(parsed, "done");
    return {
      cursor:
        !resetLegacyInstallCursorState && typeof cursorValue === "string" ? cursorValue : null,
      offset:
        !resetLegacyInstallCursorState && typeof offsetValue === "number" && offsetValue > 0
          ? offsetValue
          : 0,
      pageSize:
        !resetLegacyInstallCursorState && typeof pageSizeValue === "number" && pageSizeValue > 0
          ? pageSizeValue
          : null,
      done: !resetLegacyInstallCursorState && doneValue === true,
      recommendedFallback: normalizeSkillCatalogRecommendedFallbackSort(recommendedFallbackValue),
    };
  } catch {
    return { cursor: null, offset: 0, pageSize: null, done: false };
  }
}

function isSkillCatalogOfficial(digest: Doc<"skillSearchDigest">) {
  return Boolean(digest.badges?.official);
}

function isCuratedSkillDigest(digest: Pick<Doc<"skillSearchDigest">, "badges">) {
  return Boolean(digest.badges?.official || digest.badges?.highlighted);
}

function getSkillCatalogChannel(digest: Doc<"skillSearchDigest">): "official" | "community" {
  return isSkillCatalogOfficial(digest) ? "official" : "community";
}

function isVisibleSkillCatalogDigest(digest: Doc<"skillSearchDigest">) {
  const publicSkill = toPublicSkill(digestToHydratableSkill(digest));
  if (!publicSkill) return false;
  const ownerInfo = digestToOwnerInfo(digest);
  return Boolean(ownerInfo?.owner);
}

function skillCatalogMatchesFilters(
  digest: Doc<"skillSearchDigest">,
  args: {
    channel?: "official" | "community" | "private";
    isOfficial?: boolean;
    highlightedOnly?: boolean;
    topic?: string;
  },
) {
  if (!isVisibleSkillCatalogDigest(digest)) return false;
  if (shouldExcludeSkillFromPublicBrowse(digestToHydratableSkill(digest))) return false;
  if (args.channel === "private") return false;
  const isOfficial = isSkillCatalogOfficial(digest);
  const channel = getSkillCatalogChannel(digest);
  if (typeof args.isOfficial === "boolean" && isOfficial !== args.isOfficial) return false;
  if (args.highlightedOnly && !isSkillHighlighted(digest)) return false;
  if (args.channel && channel !== args.channel) return false;
  if (args.topic && !getCatalogTopicSlugs(digest.topics).includes(args.topic)) return false;
  return true;
}

async function toPublicSkillCatalogItem(
  ctx: Pick<QueryCtx, "db">,
  digest: Doc<"skillSearchDigest">,
): Promise<PublicSkillCatalogItem | null> {
  const hydratable = digestToHydratableSkill(digest);
  const ownerInfo = digestToOwnerInfo(digest);
  const latestVersion = await resolveDigestLatestVersionForSkill(ctx, digest);
  if (isHostedSkillPendingPublicReview(hydratable) && !latestVersion) return null;
  return {
    name: digest.slug,
    displayName: digest.displayName,
    family: "skill",
    runtimeId: null,
    channel: getSkillCatalogChannel(digest),
    isOfficial: isSkillCatalogOfficial(digest),
    summary: digest.summary ?? null,
    categories: digest.categories,
    topics: digest.topics,
    ownerHandle: ownerInfo?.ownerHandle ?? null,
    createdAt: digest.createdAt,
    updatedAt: digest.updatedAt,
    latestVersion: latestVersion?.version ?? null,
    ...(digest.badges?.highlighted?.at === undefined
      ? {}
      : { featuredAt: digest.badges.highlighted.at }),
    verificationTier: null,
    stats: {
      // CLAW-561 changes presentation only. Download indexes and ranking remain
      // native-only until a separately accepted indexed combined metric exists.
      downloads: readPublicDownloads(digest),
      installs: readDigestRankStat(digest, "installsAllTime"),
      stars: readDigestRankStat(digest, "stars"),
      versions: digest.stats.versions,
    },
  };
}

async function listSkillPackageCatalogTopicPage(
  ctx: QueryCtx,
  args: {
    channel?: "official" | "community" | "private";
    isOfficial?: boolean;
    highlightedOnly?: boolean;
    topic: string;
    sort?: "updated" | "downloads" | "recommended" | "installs";
    paginationOpts: { cursor: string | null; numItems: number };
  },
) {
  const targetCount = args.paginationOpts.numItems;
  const collected: PublicSkillCatalogItem[] = [];
  const decodedCursor = decodeSkillCatalogCursor(args.paginationOpts.cursor);
  let cursor = decodedCursor.cursor;
  let offset = decodedCursor.offset;
  let pageSize = decodedCursor.pageSize;
  let done = decodedCursor.done;
  let loops = 0;
  let remainingScanBudget = MAX_SKILL_CATALOG_SCAN_DOCUMENTS;
  const recommendedFallback = decodedCursor.recommendedFallback;
  const catalogSort = recommendedFallback ?? args.sort;

  while (
    (offset > 0 || !done) &&
    collected.length < targetCount &&
    loops < MAX_SKILL_CATALOG_SCAN_PAGES &&
    remainingScanBudget > 0
  ) {
    loops += 1;
    const effectivePageSize = Math.min(
      remainingScanBudget,
      250,
      offset > 0 && pageSize
        ? Math.max(pageSize, offset + 1)
        : Math.max(targetCount * 3, targetCount),
    );
    if (effectivePageSize <= 0) break;
    remainingScanBudget -= effectivePageSize;
    const pageCursor = cursor;
    const indexName =
      catalogSort === "downloads"
        ? "by_active_topic_downloads"
        : catalogSort === "installs"
          ? "by_active_topic_installs"
          : catalogSort === "recommended"
            ? "by_active_topic_recommended_score"
            : "by_active_topic_updated";
    const page = await paginator(ctx.db, schema)
      .query("skillTopicSearchDigest")
      .withIndex(indexName, (q) => q.eq("softDeletedAt", undefined).eq("topic", args.topic))
      .order("desc")
      .paginate({ cursor: pageCursor, numItems: effectivePageSize });

    for (let index = offset; index < page.page.length; index += 1) {
      const topicDigest = page.page[index];
      const digest = await ctx.db
        .query("skillSearchDigest")
        .withIndex("by_skill", (q) => q.eq("skillId", topicDigest.skillId))
        .unique();
      if (!digest || !skillCatalogMatchesFilters(digest, args)) continue;
      const item = await toPublicSkillCatalogItem(ctx, digest);
      if (!item) continue;
      collected.push(item);
      if (collected.length >= targetCount) {
        const nextOffset = index + 1;
        if (nextOffset < page.page.length) {
          cursor = pageCursor;
          offset = nextOffset;
          pageSize = effectivePageSize;
          done = page.isDone;
        } else {
          cursor = page.continueCursor;
          offset = 0;
          pageSize = effectivePageSize;
          done = page.isDone;
        }
        return {
          page: collected,
          isDone: done && offset === 0,
          continueCursor: encodeSkillCatalogCursor({
            cursor,
            offset,
            pageSize,
            done,
            recommendedFallback,
          }),
        };
      }
    }

    done = page.isDone;
    cursor = page.continueCursor;
    offset = 0;
    pageSize = effectivePageSize;
  }

  return {
    page: collected,
    isDone: done,
    continueCursor: encodeSkillCatalogCursor({
      cursor,
      offset,
      pageSize,
      done,
      recommendedFallback,
    }),
  };
}

type SkillCatalogSearchMatch = {
  rankTier: number;
  score: number;
};

function skillCatalogSearchMatch(
  digest: Doc<"skillSearchDigest">,
  queryText: string,
): SkillCatalogSearchMatch | null {
  const needle = queryText.toLowerCase();
  const queryTokens = tokenize(queryText);
  if (queryTokens.length === 0) return null;
  const slug = digest.slug.toLowerCase();
  const display = digest.displayName.toLowerCase();
  const slugTokens = tokenize(slug);
  const displayTokens = tokenize(display);
  let score = 0;
  let rankTier = Number.POSITIVE_INFINITY;

  const setMatch = (tier: number, boost: number) => {
    score += boost;
    rankTier = Math.min(rankTier, tier);
  };

  if (slug === needle) setMatch(0, 200);
  else if (slug.startsWith(needle)) setMatch(1, 120);
  else if (slug.includes(needle)) setMatch(1, 80);

  if (display === needle) setMatch(0, 150);
  else if (display.startsWith(needle)) setMatch(1, 70);
  else if (display.includes(needle)) setMatch(1, 40);

  if (matchesAllTokens(queryTokens, [...slugTokens, ...displayTokens], (a, b) => a === b)) {
    setMatch(1, 65);
  } else if (
    matchesAllTokens(queryTokens, [...slugTokens, ...displayTokens], (a, b) => a.startsWith(b))
  ) {
    setMatch(1, 35);
  }

  const taxonomyQuery = normalizeCatalogTopic(queryText);
  const categories = (digest.categories ?? []).filter(
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
      EXPLORATORY_SKILL_CATALOG_SEARCH_MIN_TOKEN_LENGTH,
    )
  ) {
    setMatch(2, 20);
  }

  if (
    matchesExploratoryTokenPrefixes(
      queryTokens,
      [digest.summary],
      EXPLORATORY_SKILL_CATALOG_SEARCH_MIN_TOKEN_LENGTH,
    )
  ) {
    setMatch(3, 20);
  }
  if (!Number.isFinite(rankTier)) return null;
  return { rankTier, score };
}

// Skills have no verification tiers, so curated status + adoption are the
// only trust signals feeding the shared squat gate.
function skillTrustSignals(
  pkg: Pick<PublicSkillCatalogItem, "isOfficial" | "featuredAt" | "stats">,
): SearchTrustSignals {
  return {
    isOfficial: pkg.isOfficial,
    featured: typeof pkg.featuredAt === "number",
    downloads: pkg.stats.downloads,
    installs: pkg.stats.installs,
  };
}

function compareSkillCatalogSearchMatches<
  T extends SkillCatalogSearchMatch & {
    package: Pick<PublicSkillCatalogItem, "isOfficial" | "featuredAt" | "updatedAt" | "stats">;
  },
>(a: T, b: T) {
  return (
    compareRankedSearchKeys(
      rankedSearchKey(a, skillTrustSignals(a.package)),
      rankedSearchKey(b, skillTrustSignals(b.package)),
    ) ||
    Number(b.package.isOfficial) - Number(a.package.isOfficial) ||
    b.package.updatedAt - a.package.updatedAt
  );
}

export const listPackageCatalogPage = query({
  args: {
    channel: v.optional(
      v.union(v.literal("official"), v.literal("community"), v.literal("private")),
    ),
    isOfficial: v.optional(v.boolean()),
    highlightedOnly: v.optional(v.boolean()),
    topic: v.optional(v.string()),
    sort: v.optional(
      v.union(
        v.literal("updated"),
        v.literal("downloads"),
        v.literal("installs"),
        v.literal("recommended"),
      ),
    ),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    if (args.channel === "private") {
      return { page: [], isDone: true, continueCursor: "" };
    }

    const topic = args.topic ? normalizeCatalogTopic(args.topic) : undefined;
    if (args.topic !== undefined && !topic) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    if (topic) {
      return await listSkillPackageCatalogTopicPage(ctx, {
        ...args,
        topic,
      });
    }
    const targetCount = args.paginationOpts.numItems;
    const collected: PublicSkillCatalogItem[] = [];
    const decodedCursor = decodeSkillCatalogCursor(args.paginationOpts.cursor);
    let cursor = decodedCursor.cursor;
    let offset = decodedCursor.offset;
    let pageSize = decodedCursor.pageSize;
    let done = decodedCursor.done;
    let loops = 0;
    let remainingScanBudget = MAX_SKILL_CATALOG_SCAN_DOCUMENTS;
    const recommendedFallback = decodedCursor.recommendedFallback;
    const catalogSort = recommendedFallback ?? args.sort;

    while (
      (offset > 0 || !done) &&
      collected.length < targetCount &&
      loops < MAX_SKILL_CATALOG_SCAN_PAGES &&
      remainingScanBudget > 0
    ) {
      loops += 1;
      const effectivePageSize = Math.min(
        remainingScanBudget,
        250,
        offset > 0 && pageSize
          ? Math.max(pageSize, offset + 1)
          : Math.max(targetCount * 3, targetCount),
      );
      if (effectivePageSize <= 0) break;
      remainingScanBudget -= effectivePageSize;
      const pageCursor = cursor;
      const indexName =
        catalogSort === "downloads"
          ? "by_active_stats_downloads"
          : catalogSort === "installs"
            ? "by_active_stats_installs_all_time"
            : catalogSort === "recommended"
              ? "by_active_recommended_score"
              : "by_active_updated";
      const page = await paginator(ctx.db, schema)
        .query("skillSearchDigest")
        .withIndex(indexName, (q) => q.eq("softDeletedAt", undefined))
        .order("desc")
        .paginate({ cursor: pageCursor, numItems: effectivePageSize });

      for (let index = offset; index < page.page.length; index += 1) {
        const digest = page.page[index];
        if (!skillCatalogMatchesFilters(digest, args)) continue;
        const item = await toPublicSkillCatalogItem(ctx, digest);
        if (!item) continue;
        collected.push(item);
        if (collected.length >= targetCount) {
          const nextOffset = index + 1;
          if (nextOffset < page.page.length) {
            cursor = pageCursor;
            offset = nextOffset;
            pageSize = effectivePageSize;
            done = page.isDone;
          } else {
            cursor = page.continueCursor;
            offset = 0;
            pageSize = effectivePageSize;
            done = page.isDone;
          }
          return {
            page: collected,
            isDone: done && offset === 0,
            continueCursor: encodeSkillCatalogCursor({
              cursor,
              offset,
              pageSize,
              done,
              recommendedFallback,
            }),
          };
        }
      }

      done = page.isDone;
      cursor = page.continueCursor;
      offset = 0;
      pageSize = effectivePageSize;
    }

    return {
      page: collected,
      isDone: done,
      continueCursor: encodeSkillCatalogCursor({
        cursor,
        offset,
        pageSize,
        done,
        recommendedFallback,
      }),
    };
  },
});

export const hasMissingPackageCatalogRecommendationScoresInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await hasMissingRecommendedScores(ctx, false, null);
  },
});

const EXPLORATORY_SKILL_CATALOG_SEARCH_MIN_TOKEN_LENGTH = 3;

function skillCatalogPrefixUpperBound(value: string) {
  return `${value}\uffff`;
}

type SkillPackageCatalogSearchArgs = {
  query: string;
  limit?: number;
  channel?: "official" | "community" | "private";
  isOfficial?: boolean;
  highlightedOnly?: boolean;
  topic?: string;
};

async function searchPackageCatalogImpl(ctx: QueryCtx, args: SkillPackageCatalogSearchArgs) {
  const queryText = args.query.trim().toLowerCase();
  if (!queryText) return [];
  if (args.channel === "private") return [];

  const topic = args.topic ? normalizeCatalogTopic(args.topic) : undefined;
  if (args.topic !== undefined && !topic) return [];
  const filters = { ...args, topic };
  const targetCount = Math.max(1, Math.min(args.limit ?? 20, 100));
  const matches: Array<SkillCatalogSearchMatch & { package: PublicSkillCatalogItem }> = [];
  const seen = new Set<string>();

  // Curated rows have their own bounded projection, so recall them before the
  // result quota can be filled by recent community matches. Eligibility still
  // comes exclusively from the normal filters and text matcher below.
  const curatedDigests = await ctx.db
    .query("curatedSkillSearchDigest")
    .withIndex("by_active_updated", (q) => q.eq("softDeletedAt", undefined))
    .order("desc")
    .take(MAX_SKILL_CATALOG_SEARCH_PAGE_SIZE);
  for (const curatedDigest of curatedDigests) {
    const digest = await ctx.db
      .query("skillSearchDigest")
      .withIndex("by_skill", (q) => q.eq("skillId", curatedDigest.skillId))
      .unique();
    if (!digest || !isCuratedSkillDigest(digest) || !skillCatalogMatchesFilters(digest, filters)) {
      continue;
    }
    const match = skillCatalogSearchMatch(digest, queryText);
    if (!match || seen.has(digest.skillId)) continue;
    const catalogItem = await toPublicSkillCatalogItem(ctx, digest);
    if (!catalogItem) continue;
    seen.add(digest.skillId);
    matches.push({ ...match, package: catalogItem });
  }

  const exactSkill = await resolveSkillBySlugOrAlias(ctx, queryText);
  if (exactSkill.skill) {
    const exactDigest = await ctx.db
      .query("skillSearchDigest")
      .withIndex("by_skill", (q) => q.eq("skillId", exactSkill.skill!._id))
      .unique();
    if (exactDigest && skillCatalogMatchesFilters(exactDigest, filters)) {
      const match = skillCatalogSearchMatch(exactDigest, queryText);
      if (match) {
        seen.add(exactDigest.skillId);
        const catalogItem = await toPublicSkillCatalogItem(ctx, exactDigest);
        if (catalogItem) {
          matches.push({
            ...match,
            package: catalogItem,
          });
        }
      }
    }
  }

  // Demoted exact hits never satisfy the collection quota: the fallback scans
  // must still gather the adopted lexical alternatives they are ranked against
  // (top-1 queries would otherwise return a slug squat unchallenged).
  const authoritativeMatchCount = () =>
    matches.filter((entry) => !isDemotedExactMatch(entry, skillTrustSignals(entry.package))).length;

  if (!topic && authoritativeMatchCount() < targetCount) {
    const directTopic = normalizeCatalogTopic(queryText);
    if (directTopic) {
      const exactTopicDigests = await ctx.db
        .query("skillTopicSearchDigest")
        .withIndex("by_active_topic_updated", (q) =>
          q.eq("softDeletedAt", undefined).eq("topic", directTopic),
        )
        .order("desc")
        .take(MAX_DIRECT_SKILL_CATALOG_SEARCH_CANDIDATES);
      const prefixTopicDigests =
        exactTopicDigests.length < MAX_DIRECT_SKILL_CATALOG_SEARCH_CANDIDATES
          ? await ctx.db
              .query("skillTopicSearchDigest")
              .withIndex("by_active_topic_updated", (q) =>
                q
                  .eq("softDeletedAt", undefined)
                  .gte("topic", directTopic)
                  .lt("topic", skillCatalogPrefixUpperBound(directTopic)),
              )
              .order("desc")
              .take(MAX_DIRECT_SKILL_CATALOG_SEARCH_CANDIDATES - exactTopicDigests.length)
          : [];
      const topicDigests = [...exactTopicDigests, ...prefixTopicDigests].filter(
        (digest, index, all) =>
          all.findIndex((candidate) => candidate.skillId === digest.skillId) === index,
      );
      for (const topicDigest of topicDigests) {
        const digest = await ctx.db
          .query("skillSearchDigest")
          .withIndex("by_skill", (q) => q.eq("skillId", topicDigest.skillId))
          .unique();
        if (!digest || !skillCatalogMatchesFilters(digest, filters)) continue;
        const match = skillCatalogSearchMatch(digest, queryText);
        if (!match || seen.has(digest.skillId)) continue;
        seen.add(digest.skillId);
        const catalogItem = await toPublicSkillCatalogItem(ctx, digest);
        if (!catalogItem) continue;
        matches.push({
          ...match,
          package: catalogItem,
        });
        if (authoritativeMatchCount() >= targetCount) break;
      }
    }
  }

  if (authoritativeMatchCount() < targetCount) {
    const pageSize = Math.min(MAX_SKILL_CATALOG_SEARCH_PAGE_SIZE, Math.max(targetCount * 5, 50));
    const candidateDigests: Doc<"skillSearchDigest">[] = [];
    if (topic) {
      const page = await ctx.db
        .query("skillTopicSearchDigest")
        .withIndex("by_active_topic_updated", (q) =>
          q.eq("softDeletedAt", undefined).eq("topic", topic),
        )
        .order("desc")
        .paginate({ cursor: null, numItems: pageSize });
      for (const topicDigest of page.page) {
        const digest = await ctx.db
          .query("skillSearchDigest")
          .withIndex("by_skill", (q) => q.eq("skillId", topicDigest.skillId))
          .unique();
        if (digest) candidateDigests.push(digest);
      }
    } else {
      const page = await ctx.db
        .query("skillSearchDigest")
        .withIndex("by_active_updated", (q) => q.eq("softDeletedAt", undefined))
        .order("desc")
        .paginate({ cursor: null, numItems: pageSize });
      candidateDigests.push(...page.page);
    }

    for (const digest of candidateDigests) {
      if (!skillCatalogMatchesFilters(digest, filters)) continue;
      const match = skillCatalogSearchMatch(digest, queryText);
      if (!match || seen.has(digest.skillId)) continue;
      seen.add(digest.skillId);
      const catalogItem = await toPublicSkillCatalogItem(ctx, digest);
      if (!catalogItem) continue;
      matches.push({
        ...match,
        package: catalogItem,
      });
    }
  }

  return matches.sort(compareSkillCatalogSearchMatches).slice(0, targetCount);
}

function toPublicSkillCatalogSearchEntry(
  entry: SkillCatalogSearchMatch & { package: PublicSkillCatalogItem },
) {
  return {
    score: entry.score,
    package: entry.package,
  };
}

export const searchPackageCatalogPublic = query({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    channel: v.optional(
      v.union(v.literal("official"), v.literal("community"), v.literal("private")),
    ),
    isOfficial: v.optional(v.boolean()),
    highlightedOnly: v.optional(v.boolean()),
    topic: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return (await searchPackageCatalogImpl(ctx, args)).map(toPublicSkillCatalogSearchEntry);
  },
});

export const searchPackageCatalogForHttpInternal = internalQuery({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    channel: v.optional(
      v.union(v.literal("official"), v.literal("community"), v.literal("private")),
    ),
    isOfficial: v.optional(v.boolean()),
    highlightedOnly: v.optional(v.boolean()),
    topic: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await searchPackageCatalogImpl(ctx, args);
  },
});

type SortKey = keyof typeof SORT_INDEXES;
type SortKeyInput = SortKey | "default" | undefined;

function normalizePublicListSort(sort: SortKeyInput): SortKey {
  return sort === undefined || sort === "default" ? "recommended" : sort;
}

function resolvePublicListDir(sort: SortKeyInput, dir: "asc" | "desc" | undefined) {
  const normalizedSort = normalizePublicListSort(sort);
  if (normalizedSort === "recommended") return "desc";
  return dir ?? (normalizedSort === "name" ? "asc" : "desc");
}

function getRecommendedRankIndexName(nonSuspiciousOnly: boolean) {
  return nonSuspiciousOnly
    ? RECOMMENDED_RANK_INDEXES.nonSuspicious
    : RECOMMENDED_RANK_INDEXES.active;
}

function getRecommendedRankCursorKey({
  cursor,
  nonSuspiciousOnly,
  eqPrefix,
}: {
  cursor?: string;
  nonSuspiciousOnly: boolean;
  eqPrefix: IndexKey;
}) {
  const rankKey = nonSuspiciousOnly ? "nonSuspicious" : "active";
  return decodePublicListCursor({
    cursor,
    indexName: RECOMMENDED_RANK_INDEXES[rankKey],
    maxIndexKeyLength: RECOMMENDED_RANK_INDEX_FIELD_COUNTS[rankKey],
    eqPrefix,
  });
}

function resolveRecommendedPublicListQuery({
  scoreIndexName,
  rankIndexName,
  updatedIndexName,
  scoreCursor,
  rankCursor,
  updatedCursor,
  hasMissingScores,
}: {
  scoreIndexName: SkillSearchDigestSortIndexName;
  rankIndexName: SkillSearchDigestSortIndexName;
  updatedIndexName: SkillSearchDigestSortIndexName;
  scoreCursor: IndexKey | null;
  rankCursor: IndexKey | null;
  updatedCursor: IndexKey | null;
  hasMissingScores: boolean;
}): { sort: SortKey; indexName: SkillSearchDigestSortIndexName; decodedCursor: IndexKey | null } {
  if (scoreCursor) {
    return { sort: "recommended", indexName: scoreIndexName, decodedCursor: scoreCursor };
  }
  if (rankCursor) {
    return { sort: "recommended", indexName: rankIndexName, decodedCursor: rankCursor };
  }
  if (updatedCursor) {
    return { sort: "updated", indexName: updatedIndexName, decodedCursor: updatedCursor };
  }
  if (hasMissingScores) {
    return { sort: "recommended", indexName: rankIndexName, decodedCursor: null };
  }
  return { sort: "recommended", indexName: scoreIndexName, decodedCursor: null };
}

async function hasMissingRecommendedScores(
  ctx: Pick<QueryCtx, "db">,
  nonSuspiciousOnly: boolean,
  decodedCursor: IndexKey | null,
) {
  if (decodedCursor) return false;
  if (nonSuspiciousOnly) {
    const missingScore = await ctx.db
      .query("skillSearchDigest")
      .withIndex("by_nonsuspicious_recommended_score", (q) =>
        q
          .eq("softDeletedAt", undefined)
          .eq("isSuspicious", false)
          .eq("recommendedScore", undefined),
      )
      .first();
    if (missingScore) return true;

    const missingVersion = await ctx.db
      .query("skillSearchDigest")
      .withIndex("by_nonsuspicious_recommended_score_version", (q) =>
        q
          .eq("softDeletedAt", undefined)
          .eq("isSuspicious", false)
          .eq("recommendedScoreVersion", undefined),
      )
      .first();
    if (missingVersion) return true;

    const staleVersion = await ctx.db
      .query("skillSearchDigest")
      .withIndex("by_nonsuspicious_recommended_score_version", (q) =>
        q
          .eq("softDeletedAt", undefined)
          .eq("isSuspicious", false)
          .lt("recommendedScoreVersion", RECOMMENDATION_SCORE_VERSION),
      )
      .first();
    return Boolean(staleVersion);
  }

  const missingScore = await ctx.db
    .query("skillSearchDigest")
    .withIndex("by_active_recommended_score", (q) =>
      q.eq("softDeletedAt", undefined).eq("recommendedScore", undefined),
    )
    .first();
  if (missingScore) return true;

  const missingVersion = await ctx.db
    .query("skillSearchDigest")
    .withIndex("by_active_recommended_score_version", (q) =>
      q.eq("softDeletedAt", undefined).eq("recommendedScoreVersion", undefined),
    )
    .first();
  if (missingVersion) return true;

  const staleVersion = await ctx.db
    .query("skillSearchDigest")
    .withIndex("by_active_recommended_score_version", (q) =>
      q.eq("softDeletedAt", undefined).lt("recommendedScoreVersion", RECOMMENDATION_SCORE_VERSION),
    )
    .first();
  return Boolean(staleVersion);
}

function readDigestRankStat(
  digest: Doc<"skillSearchDigest">,
  field: "downloads" | "stars" | "installsAllTime",
): number {
  if (field === "downloads") return digest.statsDownloads ?? digest.stats.downloads ?? 0;
  if (field === "stars") return digest.statsStars ?? digest.stats.stars ?? 0;
  return digest.statsInstallsAllTime ?? digest.stats.installsAllTime ?? 0;
}

type OfficialFirstSkillCategoryPageOptions = {
  sort: PublicListSort;
  dir: "asc" | "desc";
  numItems: number;
  topic?: string;
  categorySlug: ServerSkillCategorySlug;
  categoryKeywords: string[];
  excludeCategoryKeywords: string[];
  nonSuspiciousOnly: boolean;
};

type CuratedSkillPageOptions = Omit<OfficialFirstSkillCategoryPageOptions, "categorySlug"> & {
  categorySlug: ServerSkillCategorySlug | null;
  officialOnly?: boolean;
  createdAfter?: number;
};

async function listCuratedSkillPage(
  ctx: QueryCtx,
  opts: CuratedSkillPageOptions & { cursor: string | null },
): Promise<PublicSkillListPage> {
  const indexName = opts.nonSuspiciousOnly
    ? NONSUSPICIOUS_CURATED_SORT_INDEXES[opts.sort]
    : CURATED_SORT_INDEXES[opts.sort];
  const eqPrefix: IndexKey = opts.nonSuspiciousOnly ? [undefined, false] : [undefined];
  const decodedCursor = getPublicListCursorKey({
    cursor: opts.cursor ?? undefined,
    sort: opts.sort,
    nonSuspiciousOnly: opts.nonSuspiciousOnly,
    indexName,
    eqPrefix,
    allowLegacyArray: false,
  });
  const items: PublicSkillEntry[] = [];
  const ascendingCreatedAfterCursor: IndexKey | null =
    opts.sort === "newest" && opts.dir === "asc" && typeof opts.createdAfter === "number"
      ? [...eqPrefix, opts.createdAfter]
      : null;
  let scanCursor = decodedCursor ?? ascendingCreatedAfterCursor ?? eqPrefix;
  let scanInclusive = !decodedCursor;
  let hasMore = false;
  let nextCursor: string | null = null;
  let remainingRows = Math.max(
    opts.numItems,
    Math.min(MAX_FILTERED_PUBLIC_LIST_SCAN_ROWS, opts.numItems * 12),
  );

  for (let pageCount = 0; pageCount < MAX_FILTERED_PUBLIC_LIST_SCAN_PAGES; pageCount += 1) {
    if (remainingRows <= 0) break;
    const batchSize = Math.min(remainingRows, Math.max(opts.numItems * 3, opts.numItems));
    const result = await getPage(ctx, {
      table: "curatedSkillSearchDigest",
      startIndexKey: scanCursor,
      startInclusive: scanInclusive,
      endIndexKey: eqPrefix,
      endInclusive: true,
      absoluteMaxRows: batchSize,
      order: opts.dir,
      index: indexName,
      schema,
    });
    remainingRows -= batchSize;
    if (result.indexKeys.length === 0) {
      hasMore = false;
      nextCursor = null;
      break;
    }

    for (let index = 0; index < result.page.length; index += 1) {
      const curatedDigest = result.page[index];
      const cursor = result.indexKeys[index];
      if (
        opts.sort === "newest" &&
        opts.dir === "desc" &&
        typeof opts.createdAfter === "number" &&
        curatedDigest.createdAt < opts.createdAfter
      ) {
        return { page: items, hasMore: false, nextCursor: null };
      }
      if (
        (typeof opts.createdAfter !== "number" || curatedDigest.createdAt >= opts.createdAfter) &&
        digestPassesPublicListFilters(curatedDigest, {
          topic: opts.topic,
          categorySlug: opts.categorySlug,
          categoryKeywords: opts.categoryKeywords,
          excludeCategoryKeywords: opts.excludeCategoryKeywords,
        })
      ) {
        // The compact projection contains official and highlighted rows but omits badge kind,
        // so hydrate before applying officialOnly and appending a result.
        const digest = await ctx.db
          .query("skillSearchDigest")
          .withIndex("by_skill", (q) => q.eq("skillId", curatedDigest.skillId))
          .unique();
        if (
          digest &&
          isCuratedSkillDigest(digest) &&
          (!opts.officialOnly || isSkillCatalogOfficial(digest)) &&
          (typeof opts.createdAfter !== "number" || digest.createdAt >= opts.createdAfter) &&
          (!opts.nonSuspiciousOnly || !digest.isSuspicious) &&
          digestPassesPublicListFilters(digest, {
            topic: opts.topic,
            categorySlug: opts.categorySlug,
            categoryKeywords: opts.categoryKeywords,
            excludeCategoryKeywords: opts.excludeCategoryKeywords,
          })
        ) {
          const item = await buildPublicSkillEntryFromDigest(ctx, digest);
          if (item) items.push(item);
        }
      }
      if (items.length >= opts.numItems) {
        const nextDigest = result.page[index + 1];
        if (
          opts.sort === "newest" &&
          opts.dir === "desc" &&
          typeof opts.createdAfter === "number" &&
          nextDigest &&
          nextDigest.createdAt < opts.createdAfter
        ) {
          return { page: items, hasMore: false, nextCursor: null };
        }
        hasMore = result.hasMore || index < result.page.length - 1;
        nextCursor = hasMore ? encodeIndexKey(indexName, cursor) : null;
        return { page: items, hasMore, nextCursor };
      }
    }

    if (!result.hasMore) {
      hasMore = false;
      nextCursor = null;
      break;
    }
    scanCursor = result.indexKeys[result.indexKeys.length - 1];
    scanInclusive = false;
    hasMore = true;
    nextCursor = encodeIndexKey(indexName, scanCursor);
  }

  return { page: items, hasMore, nextCursor };
}

async function listCommunitySkillCategoryPage(
  ctx: QueryCtx,
  opts: OfficialFirstSkillCategoryPageOptions & { cursor: string | null },
): Promise<PublicSkillListPage> {
  if (opts.topic) {
    return await listSkillTopicFilteredPage(ctx, {
      cursor: opts.cursor ?? undefined,
      dir: opts.dir,
      numItems: opts.numItems,
      sort: opts.sort,
      topic: opts.topic,
      categorySlug: opts.categorySlug,
      categoryKeywords: opts.categoryKeywords,
      excludeCategoryKeywords: opts.excludeCategoryKeywords,
      nonSuspiciousOnly: opts.nonSuspiciousOnly,
      excludeCurated: true,
    });
  }

  const indexName = opts.nonSuspiciousOnly
    ? NONSUSPICIOUS_SORT_INDEXES[opts.sort]
    : SORT_INDEXES[opts.sort];
  const eqPrefix: IndexKey = opts.nonSuspiciousOnly ? [undefined, false] : [undefined];
  const decodedCursor = getPublicListCursorKey({
    cursor: opts.cursor ?? undefined,
    sort: opts.sort,
    nonSuspiciousOnly: opts.nonSuspiciousOnly,
    indexName,
    eqPrefix,
    allowLegacyArray: false,
  });
  const items: PublicSkillEntry[] = [];
  let scanCursor = decodedCursor ?? eqPrefix;
  let scanInclusive = !decodedCursor;
  let hasMore = false;
  let nextCursor: string | null = null;
  let remainingRows = Math.max(
    opts.numItems,
    Math.min(MAX_FILTERED_PUBLIC_LIST_SCAN_ROWS, opts.numItems * 12),
  );

  for (let pageCount = 0; pageCount < MAX_FILTERED_PUBLIC_LIST_SCAN_PAGES; pageCount += 1) {
    if (remainingRows <= 0) break;
    const batchSize = Math.min(remainingRows, Math.max(opts.numItems * 3, opts.numItems));
    const result = await getPage(ctx, {
      table: "skillSearchDigest",
      startIndexKey: scanCursor,
      startInclusive: scanInclusive,
      endIndexKey: eqPrefix,
      endInclusive: true,
      absoluteMaxRows: batchSize,
      order: opts.dir,
      index: indexName,
      schema,
    });
    remainingRows -= batchSize;
    if (result.indexKeys.length === 0) {
      hasMore = false;
      nextCursor = null;
      break;
    }

    for (let index = 0; index < result.page.length; index += 1) {
      const digest = result.page[index];
      const cursor = result.indexKeys[index];
      if (
        !isCuratedSkillDigest(digest) &&
        digestPassesPublicListFilters(digest, {
          topic: opts.topic,
          categorySlug: opts.categorySlug,
          categoryKeywords: opts.categoryKeywords,
          excludeCategoryKeywords: opts.excludeCategoryKeywords,
        })
      ) {
        const item = await buildPublicSkillEntryFromDigest(ctx, digest);
        if (item) items.push(item);
      }
      if (items.length >= opts.numItems) {
        hasMore = result.hasMore || index < result.page.length - 1;
        nextCursor = hasMore ? encodeIndexKey(indexName, cursor) : null;
        return { page: items, hasMore, nextCursor };
      }
    }

    if (!result.hasMore) {
      hasMore = false;
      nextCursor = null;
      break;
    }
    scanCursor = result.indexKeys[result.indexKeys.length - 1];
    scanInclusive = false;
    hasMore = true;
    nextCursor = encodeIndexKey(indexName, scanCursor);
  }

  return { page: items, hasMore, nextCursor };
}

async function listOfficialFirstSkillCategoryPage(
  ctx: QueryCtx,
  opts: OfficialFirstSkillCategoryPageOptions & {
    state: OfficialFirstSkillCategoryCursorState;
  },
): Promise<PublicSkillListPage> {
  const items: PublicSkillEntry[] = [];
  if (opts.state.phase === "curated") {
    const curatedPage = await listCuratedSkillPage(ctx, {
      ...opts,
      cursor: opts.state.cursor,
    });
    items.push(...curatedPage.page);
    if (curatedPage.hasMore) {
      return {
        page: items,
        hasMore: true,
        nextCursor: encodeOfficialFirstSkillCategoryCursor({
          phase: "curated",
          cursor: curatedPage.nextCursor,
          sort: opts.sort,
        }),
      };
    }
    if (items.length >= opts.numItems) {
      const communityProbe = await listCommunitySkillCategoryPage(ctx, {
        ...opts,
        cursor: null,
        numItems: 1,
      });
      const hasCommunityPage = communityProbe.page.length > 0 || communityProbe.hasMore;
      return {
        page: items,
        hasMore: hasCommunityPage,
        nextCursor: hasCommunityPage
          ? encodeOfficialFirstSkillCategoryCursor({
              phase: "community",
              cursor: communityProbe.page.length > 0 ? null : communityProbe.nextCursor,
              sort: opts.sort,
            })
          : null,
      };
    }
  }

  const communityPage = await listCommunitySkillCategoryPage(ctx, {
    ...opts,
    cursor: opts.state.phase === "community" ? opts.state.cursor : null,
    numItems: opts.numItems - items.length,
  });
  items.push(...communityPage.page);
  return {
    page: items,
    hasMore: communityPage.hasMore,
    nextCursor: communityPage.hasMore
      ? encodeOfficialFirstSkillCategoryCursor({
          phase: "community",
          cursor: communityPage.nextCursor,
          sort: opts.sort,
        })
      : null,
  };
}

/** Fetch highlighted skills newest-first via the skillBadges timestamp index. */
async function fetchHighlightedPage(
  ctx: QueryCtx,
  opts: {
    sort: SortKey;
    dir: "asc" | "desc";
    numItems: number;
    categorySlug: ServerSkillCategorySlug | null;
    topic?: string;
    categoryKeywords: string[];
    excludeCategoryKeywords: string[];
    nonSuspiciousOnly: boolean;
  },
) {
  // Get all highlighted skill IDs from the skillBadges index (very few rows)
  const badges = await ctx.db
    .query("skillBadges")
    .withIndex("by_kind_at", (q) => q.eq("kind", "highlighted"))
    .order("desc")
    .take(MAX_LIST_TAKE);

  // Look up digests for each highlighted skill
  const digests: Doc<"skillSearchDigest">[] = [];
  for (const badge of badges) {
    const digest = await ctx.db
      .query("skillSearchDigest")
      .withIndex("by_skill", (q) => q.eq("skillId", badge.skillId))
      .unique();
    if (!digest || digest.softDeletedAt) continue;
    if (opts.nonSuspiciousOnly && digest.isSuspicious) continue;
    if (
      !digestPassesPublicListFilters(digest, {
        categorySlug: opts.categorySlug,
        topic: opts.topic,
        categoryKeywords: opts.categoryKeywords,
        excludeCategoryKeywords: opts.excludeCategoryKeywords,
      })
    ) {
      continue;
    }
    digests.push(digest);
  }

  const trimmed = digests.slice(0, opts.numItems);

  const items: PublicSkillEntry[] = [];
  for (const digest of trimmed) {
    const item = await buildPublicSkillEntryFromDigest(ctx, digest);
    if (item) items.push(item);
  }

  // Highlighted skills are few enough to return in one page — no cursor needed
  return { page: items, hasMore: false, nextCursor: null };
}

function filterPublicSkillPage(
  page: HydratableSkill[],
  args: { highlightedOnly?: boolean; nonSuspiciousOnly?: boolean },
) {
  if (!args.nonSuspiciousOnly && !args.highlightedOnly) {
    return page;
  }
  return page.filter((skill) => {
    if (args.nonSuspiciousOnly && isSkillSuspicious(skill)) return false;
    if (args.highlightedOnly && !isSkillHighlighted(skill)) return false;
    return true;
  });
}

function normalizePublicListPagination(paginationOpts: {
  cursor?: string | null;
  numItems: number;
}) {
  return {
    cursor: paginationOpts.cursor ?? null,
    numItems: clampInt(paginationOpts.numItems, 1, MAX_PUBLIC_LIST_LIMIT),
  };
}

async function paginateWithStaleCursorRecovery<T>(
  runPaginate: (
    cursor: string | null,
  ) => Promise<{ page: T[]; isDone: boolean; continueCursor: string }>,
  initialCursor: string | null,
) {
  try {
    return await runPaginate(initialCursor);
  } catch (error) {
    if (initialCursor && isStaleCursorError(error)) {
      // Return a synthetic empty page so usePaginatedQuery restarts cleanly.
      return { page: [] as T[], isDone: true, continueCursor: "" };
    }
    throw error;
  }
}

function isStaleCursorError(error: unknown) {
  const patterns = ["Failed to parse cursor", "cursor is from a different query"];
  const msg =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error
        ? String((error as { message?: unknown }).message)
        : "";
  return patterns.some((p) => msg.includes(p));
}

async function paginatePublicSkillVersions(
  ctx: QueryCtx,
  skillId: Id<"skills">,
  initialCursor: string | null,
  limit: number,
) {
  const scanLimit = Math.max(
    limit,
    Math.min(MAX_FILTERED_PUBLIC_LIST_SCAN_ROWS, limit * MAX_FILTERED_PUBLIC_LIST_SCAN_PAGES),
  );
  const runPaginate = (pageCursor: string | null) =>
    ctx.db
      .query("skillVersions")
      .withIndex("by_skill_active_created", (q) =>
        q.eq("skillId", skillId).eq("softDeletedAt", undefined),
      )
      .order("desc")
      .paginate({ cursor: pageCursor, numItems: scanLimit });
  const page = await paginateWithStaleCursorRecovery(runPaginate, initialCursor);
  const items = page.page
    .filter((version) => isPublicSkillVersionAvailableForSkill(version, skillId))
    .slice(0, limit);

  return { items, nextCursor: page.isDone ? null : page.continueCursor };
}

export const countPublicSkills = query({
  args: {},
  handler: async (ctx) => {
    const statsCount = await readGlobalPublicSkillsCount(ctx);
    return statsCount ?? 0;
  },
});

export const listVersions = query({
  args: { skillId: v.id("skills"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = clampInt(args.limit ?? 20, 1, MAX_PUBLIC_LIST_LIMIT);
    const authUserId = await getAuthUserId(ctx);
    const actor = authUserId ? await ctx.db.get(authUserId) : null;
    const isStaff = actor?.role === "admin" || actor?.role === "moderator";
    if (isStaff) {
      const versions = await ctx.db
        .query("skillVersions")
        .withIndex("by_skill", (q) => q.eq("skillId", args.skillId))
        .order("desc")
        .take(limit);
      return versions.map((version) => toPublicSkillVersion(version)!);
    }
    if (actor) {
      const skill = await ctx.db.get(args.skillId);
      if (skill && (await canManageSkillOwnerForActor(ctx, actor, skill))) {
        const versions = await ctx.db
          .query("skillVersions")
          .withIndex("by_skill_active_created", (q) =>
            q.eq("skillId", args.skillId).eq("softDeletedAt", undefined),
          )
          .order("desc")
          .take(limit);
        return versions.map((version) => toPublicSkillVersion(version)!);
      }
    }
    const publicVersions = await paginatePublicSkillVersions(ctx, args.skillId, null, limit);
    return publicVersions.items.map((version) => toPublicSkillVersion(version)!);
  },
});

export const listWithdrawnVersionsForManager = query({
  args: {
    skillId: v.id("skills"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) return { page: [], isDone: true, continueCursor: "" };
    const actor = await ctx.db.get(authUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) {
      return { page: [], isDone: true, continueCursor: "" };
    }

    const skill = await ctx.db.get(args.skillId);
    if (
      !skill ||
      skill.softDeletedAt ||
      (skill.moderationStatus ?? "active") !== "active" ||
      !(await canManageSkillOwnerForActor(ctx, actor, skill))
    ) {
      return { page: [], isDone: true, continueCursor: "" };
    }

    const result = await ctx.db
      .query("skillVersions")
      .withIndex("by_skill_owner_deleted_created", (q) =>
        q.eq("skillId", skill._id).eq("ownerDeletedBy", actor._id),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page
        .filter((version) => isSkillVersionRestorableByOwner(version, skill._id, actor._id))
        .map(toManagerSkillVersion),
    };
  },
});

export const listVersionsPage = query({
  args: {
    skillId: v.id("skills"),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = clampInt(args.limit ?? 20, 1, MAX_LIST_LIMIT);
    const page = await paginatePublicSkillVersions(ctx, args.skillId, args.cursor ?? null, limit);
    return {
      items: page.items.map((version) => toPublicSkillVersion(version)!),
      nextCursor: page.nextCursor,
    };
  },
});

export const getVersionById = query({
  args: { versionId: v.id("skillVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    return version &&
      !version.softDeletedAt &&
      version.ownerDeletedAt === undefined &&
      isPublicSkillVersionAvailableForSkill(version, version.skillId)
      ? toPublicSkillVersion(version)
      : null;
  },
});

export const getVersionsByIdsInternal = internalQuery({
  args: { versionIds: v.array(v.id("skillVersions")) },
  handler: async (ctx, args) => {
    const versions = await Promise.all(args.versionIds.map((id) => ctx.db.get(id)));
    return versions.filter(
      (versionDoc): versionDoc is NonNullable<typeof versionDoc> => versionDoc !== null,
    );
  },
});

export const getVersionByIdInternal = internalQuery({
  args: { versionId: v.id("skillVersions") },
  handler: async (ctx, args) => ctx.db.get(args.versionId),
});

export const getVersionBySkillAndVersionInternal = internalQuery({
  args: { skillId: v.id("skills"), version: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("skillVersions")
      .withIndex("by_skill_version", (q) =>
        q.eq("skillId", args.skillId).eq("version", args.version),
      )
      .unique();
  },
});

export const listVersionFingerprintsInternal = internalQuery({
  args: { skillVersionId: v.id("skillVersions") },
  handler: async (ctx, args) => {
    const entries = await ctx.db
      .query("skillVersionFingerprints")
      .withIndex("by_version", (q) => q.eq("versionId", args.skillVersionId))
      .collect();
    return entries.map((entry) => ({
      fingerprint: entry.fingerprint,
      kind: entry.kind,
      createdAt: entry.createdAt,
    }));
  },
});

export const getSkillByIdInternal = internalQuery({
  args: { skillId: v.id("skills") },
  handler: async (ctx, args) => ctx.db.get(args.skillId),
});

export const getPendingScanSkillsInternal = internalQuery({
  args: {
    limit: v.optional(v.number()),
    skipRecentMinutes: v.optional(v.number()),
    exhaustive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const exhaustive = args.exhaustive ?? false;
    const limit = exhaustive
      ? Math.max(1, Math.floor(args.limit ?? 10000))
      : clampInt(args.limit ?? 10, 1, 100);
    const skipRecentMinutes = exhaustive ? 0 : (args.skipRecentMinutes ?? 60);
    const skipThreshold = Date.now() - skipRecentMinutes * 60 * 1000;

    let allSkills: Doc<"skills">[] = [];
    if (exhaustive) {
      // Used by manual/backfill tooling where fairness matters more than query cost.
      allSkills = await ctx.db
        .query("skills")
        .withIndex("by_active_updated", (q) => q.eq("softDeletedAt", undefined))
        .collect();
    } else {
      // Mix "most recently updated" with "oldest created" slices so older pending
      // items don't starve behind high-churn records.
      const poolSize = Math.min(Math.max(limit * 20, 200), 1000);
      const [recentSkills, oldestSkills] = await Promise.all([
        ctx.db
          .query("skills")
          .withIndex("by_active_updated", (q) => q.eq("softDeletedAt", undefined))
          .order("desc")
          .take(poolSize),
        ctx.db
          .query("skills")
          .withIndex("by_active_created", (q) => q.eq("softDeletedAt", undefined))
          .order("asc")
          .take(poolSize),
      ]);

      const deduped = new Map<Id<"skills">, Doc<"skills">>();
      for (const skill of [...recentSkills, ...oldestSkills]) {
        deduped.set(skill._id, skill);
      }
      allSkills = [...deduped.values()];
    }

    const candidates = allSkills.filter((skill) => {
      const reason = skill.moderationReason;
      if (skill.moderationStatus === "hidden" && reason === "pending.scan") return true;
      if (skill.moderationStatus === "hidden" && reason === "quality.low") return true;
      if (skill.moderationStatus === "active" && reason === "pending.scan") return true;
      if (skill.moderationStatus === "active" && reason === "scanner.vt.pending") return true;
      return (
        reason === "scanner.llm.clean" ||
        reason === "scanner.llm.suspicious" ||
        reason === "scanner.llm.malicious"
      );
    });

    // Filter out recently checked skills unless caller explicitly disables recency filtering.
    const skills =
      skipRecentMinutes <= 0
        ? candidates
        : candidates.filter((s) => !s.scanLastCheckedAt || s.scanLastCheckedAt < skipThreshold);

    // Shuffle and take the requested limit (Fisher-Yates)
    for (let i = skills.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [skills[i], skills[j]] = [skills[j], skills[i]];
    }
    const selected = skills.slice(0, limit);

    const results: Array<{
      skillId: Id<"skills">;
      versionId: Id<"skillVersions"> | null;
      sha256hash: string | null;
      checkCount: number;
    }> = [];

    const FINAL_VT_STATUSES = new Set(["clean", "malicious", "suspicious"]);
    for (const skill of selected) {
      const version = skill.latestVersionId ? await ctx.db.get(skill.latestVersionId) : null;
      if (!version?.sha256hash) continue;
      const vtStatus = version.vtAnalysis?.status?.trim().toLowerCase();
      // Keep retrying unresolved VT results (pending/stale/error), but skip finalized outcomes.
      if (vtStatus && FINAL_VT_STATUSES.has(vtStatus)) continue;
      results.push({
        skillId: skill._id,
        versionId: version?._id ?? null,
        sha256hash: version?.sha256hash ?? null,
        checkCount: skill.scanCheckCount ?? 0,
      });
    }

    return results;
  },
});

/**
 * Health check query to monitor scan queue status
 */
export const getScanQueueHealthInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.db
      .query("skills")
      .withIndex("by_moderation", (q) =>
        q.eq("moderationStatus", "hidden").eq("moderationReason", "pending.scan"),
      )
      .collect();

    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    let staleCount = 0;
    let veryStaleCount = 0;
    let oldestTimestamp = now;

    for (const skill of pending) {
      const createdAt = skill.createdAt ?? skill._creationTime;
      if (createdAt < oldestTimestamp) oldestTimestamp = createdAt;
      if (createdAt < oneHourAgo) staleCount++;
      if (createdAt < oneDayAgo) veryStaleCount++;
    }

    return {
      queueSize: pending.length,
      staleCount, // pending > 1 hour
      veryStaleCount, // pending > 24 hours
      oldestAgeMinutes: Math.round((now - oldestTimestamp) / 60000),
      healthy: pending.length < 50 && veryStaleCount === 0,
    };
  },
});

/**
 * Get active skills that have a version hash but no vtAnalysis cached.
 * Used to backfill VT results for skills approved before VT integration.
 */
export const getActiveSkillsMissingVTCacheInternal = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    const poolSize = limit * 2; // Take more to account for some having vtAnalysis

    // Skills waiting for VT + LLM-evaluated skills that still need VT cache
    const vtPending = await ctx.db
      .query("skills")
      .withIndex("by_moderation", (q) =>
        q.eq("moderationStatus", "active").eq("moderationReason", "scanner.vt.pending"),
      )
      .take(poolSize);
    const [llmClean, llmSuspicious, llmMalicious] = await Promise.all([
      ctx.db
        .query("skills")
        .withIndex("by_moderation", (q) =>
          q.eq("moderationStatus", "active").eq("moderationReason", "scanner.llm.clean"),
        )
        .take(poolSize),
      ctx.db
        .query("skills")
        .withIndex("by_moderation", (q) =>
          q.eq("moderationStatus", "active").eq("moderationReason", "scanner.llm.suspicious"),
        )
        .take(poolSize),
      ctx.db
        .query("skills")
        .withIndex("by_moderation", (q) =>
          q.eq("moderationStatus", "active").eq("moderationReason", "scanner.llm.malicious"),
        )
        .take(poolSize),
    ]);
    const llmEvaluated = [...llmClean, ...llmSuspicious, ...llmMalicious];

    // Dedup across pools
    const seen = new Set<string>();
    const allSkills: typeof vtPending = [];
    for (const skill of [...vtPending, ...llmEvaluated]) {
      if (!seen.has(skill._id)) {
        seen.add(skill._id);
        allSkills.push(skill);
      }
    }

    const results: Array<{
      skillId: Id<"skills">;
      versionId: Id<"skillVersions">;
      sha256hash: string;
      slug: string;
    }> = [];

    for (const skill of allSkills) {
      if (results.length >= limit) break;
      if (!skill.latestVersionId) continue;
      const version = await ctx.db.get(skill.latestVersionId);
      if (!version) continue;
      // Include if version has hash but no vtAnalysis
      if (version.sha256hash && !version.vtAnalysis) {
        results.push({
          skillId: skill._id,
          versionId: version._id,
          sha256hash: version.sha256hash,
          slug: skill.slug,
        });
      }
    }

    return results;
  },
});

/**
 * Get all active skills with VT analysis for daily re-scan.
 */
export const getAllActiveSkillsForRescanInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const activeSkills = await ctx.db
      .query("skills")
      .withIndex("by_moderation", (q) => q.eq("moderationStatus", "active"))
      .collect();

    const results: Array<{
      skillId: Id<"skills">;
      versionId: Id<"skillVersions">;
      sha256hash: string;
      slug: string;
    }> = [];

    for (const skill of activeSkills) {
      if (!skill.latestVersionId) continue;
      const version = await ctx.db.get(skill.latestVersionId);
      if (!version?.sha256hash) continue;

      results.push({
        skillId: skill._id,
        versionId: version._id,
        sha256hash: version.sha256hash,
        slug: skill.slug,
      });
    }

    return results;
  },
});

/**
 * Cursor-based batch query for daily rescan. Uses _creationTime for stable pagination.
 * Returns a batch of active skills with sha256hash, plus a cursor and done flag.
 */
export const getActiveSkillBatchForRescanInternal = internalQuery({
  args: {
    cursor: v.optional(v.number()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? 100;
    const cursor = args.cursor ?? 0;

    // Use built-in by_creation_time index for stable cursor-based pagination
    const candidates = await ctx.db
      .query("skills")
      .withIndex("by_creation_time", (q) => q.gt("_creationTime", cursor))
      .order("asc")
      .take(batchSize * 3); // Over-fetch to account for filtering

    const results: Array<{
      skillId: Id<"skills">;
      versionId: Id<"skillVersions">;
      sha256hash: string;
      slug: string;
      wasFlagged: boolean;
    }> = [];
    let nextCursor = cursor;

    for (const skill of candidates) {
      nextCursor = skill._creationTime;
      if (results.length >= batchSize) break;

      // Filter out soft-deleted and non-active
      if (skill.softDeletedAt) continue;
      if ((skill.moderationStatus ?? "active") !== "active") continue;
      if (!skill.latestVersionId) continue;

      const version = await ctx.db.get(skill.latestVersionId);
      if (!version?.sha256hash) continue;

      results.push({
        skillId: skill._id,
        versionId: version._id,
        sha256hash: version.sha256hash,
        slug: skill.slug,
        wasFlagged:
          (skill.moderationFlags as string[] | undefined)?.includes("flagged.suspicious") ?? false,
      });
    }

    // Done when we got fewer candidates than our over-fetch limit
    const done = candidates.length < batchSize * 3;

    return { skills: results, nextCursor, done };
  },
});

export const hideObviousJunkSuspiciousSkillsInternal = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    maxToHide: v.optional(v.number()),
    accExamined: v.optional(v.number()),
    accMatched: v.optional(v.number()),
    accHidden: v.optional(v.number()),
    examples: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const batchSize = clampInt(args.batchSize ?? 200, 1, 200);
    const dryRun = args.dryRun ?? false;
    const maxToHide =
      args.maxToHide === undefined ? Number.POSITIVE_INFINITY : Math.max(0, args.maxToHide);
    const now = Date.now();
    let accExamined = args.accExamined ?? 0;
    let accMatched = args.accMatched ?? 0;
    let accHidden = args.accHidden ?? 0;
    const examples = [...(args.examples ?? [])];

    const { page, continueCursor, isDone } = await ctx.db
      .query("skills")
      .withIndex("by_nonsuspicious_updated", (q) =>
        q.eq("softDeletedAt", undefined).eq("isSuspicious", true),
      )
      .order("asc")
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    for (const skill of page) {
      accExamined++;
      if (!isObviousJunkSkill(skill)) continue;
      accMatched++;
      if (examples.length < 25) examples.push(skill.slug);
      if (dryRun || accHidden >= maxToHide) continue;

      await ctx.db.patch(skill._id, {
        softDeletedAt: now,
        moderationStatus: "hidden",
        moderationReason: "cleanup.obvious_junk",
        moderationNotes: "Auto-hidden obvious test or placeholder skill during ClawScan cleanup.",
        hiddenAt: now,
        hiddenBy: undefined,
        lastReviewedAt: now,
        updatedAt: now,
      });
      accHidden++;
    }

    const hitLimit = accHidden >= maxToHide;
    if (!isDone && !hitLimit && !dryRun) {
      await ctx.scheduler.runAfter(0, internal.skills.hideObviousJunkSuspiciousSkillsInternal, {
        cursor: continueCursor,
        batchSize,
        dryRun,
        maxToHide,
        accExamined,
        accMatched,
        accHidden,
        examples,
      });
    }

    return {
      status: dryRun ? "dry_run" : hitLimit ? "limit_reached" : isDone ? "complete" : "continuing",
      examined: accExamined,
      matched: accMatched,
      hidden: accHidden,
      examples,
      cursor: continueCursor,
      done: isDone,
    };
  },
});

/**
 * Get active latest skill versions whose static scan is missing or uses an older engine version.
 * Used to backfill new static rules onto already-published skills.
 */
export const getActiveSkillBatchForStaticScanBackfillInternal = internalQuery({
  args: {
    cursor: v.optional(v.number()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? 25;
    const cursor = args.cursor ?? 0;

    const candidates = await ctx.db
      .query("skills")
      .withIndex("by_creation_time", (q) => q.gt("_creationTime", cursor))
      .order("asc")
      .take(batchSize * 4);

    const results: Array<{
      skillId: Id<"skills">;
      versionId: Id<"skillVersions">;
      slug: string;
    }> = [];
    let nextCursor = cursor;

    for (const skill of candidates) {
      nextCursor = skill._creationTime;
      if (results.length >= batchSize) break;

      if (skill.softDeletedAt) continue;
      if ((skill.moderationStatus ?? "active") !== "active") continue;
      if (!skill.latestVersionId) continue;

      const version = await ctx.db.get(skill.latestVersionId);
      if (!version) continue;
      if (version.staticScan?.engineVersion === MODERATION_ENGINE_VERSION) continue;

      results.push({
        skillId: skill._id,
        versionId: version._id,
        slug: skill.slug,
      });
    }

    const done = candidates.length < batchSize * 4;
    return { skills: results, nextCursor, done };
  },
});

/**
 * Get skills with stale moderationReason that have vtAnalysis cached.
 * Used to sync moderationReason with cached VT results.
 */
export const getSkillsWithStaleModerationReasonInternal = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;

    // Over-fetch from each bucket since some will be filtered out (no vtAnalysis).
    const poolSize = limit * 2;
    // Find skills with pending-like moderationReason using indexed queries
    const [vtPending, pendingScan] = await Promise.all([
      ctx.db
        .query("skills")
        .withIndex("by_moderation", (q) =>
          q.eq("moderationStatus", "active").eq("moderationReason", "scanner.vt.pending"),
        )
        .take(poolSize),
      ctx.db
        .query("skills")
        .withIndex("by_moderation", (q) =>
          q.eq("moderationStatus", "active").eq("moderationReason", "pending.scan"),
        )
        .take(poolSize),
    ]);

    const results: Array<{
      skillId: Id<"skills">;
      versionId: Id<"skillVersions">;
      slug: string;
      currentReason: string;
      vtStatus: string | null;
      sha256hash: string | null;
    }> = [];

    for (const skill of [...vtPending, ...pendingScan]) {
      if (results.length >= limit) break;
      if (!skill.moderationReason) continue;
      if (!skill.latestVersionId) continue;

      const version = await ctx.db.get(skill.latestVersionId);
      if (!version?.vtAnalysis?.status) continue; // Skip if no vtAnalysis

      results.push({
        skillId: skill._id,
        versionId: version._id,
        slug: skill.slug,
        currentReason: skill.moderationReason,
        vtStatus: version.vtAnalysis.status,
        sha256hash: version.sha256hash ?? null,
      });
    }

    return results;
  },
});

/**
 * Get skill versions with pending VT cache rows that need reanalysis.
 */
export const getPendingVTSkillsInternal = internalQuery({
  args: { limit: v.optional(v.number()), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;

    const { page, continueCursor, isDone } = await ctx.db
      .query("skillVersions")
      .withIndex("by_active_vt_status_created", (q) =>
        q.eq("softDeletedAt", undefined).eq("vtAnalysis.status", "pending"),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: limit });

    const results: Array<{
      skillId: Id<"skills">;
      versionId: Id<"skillVersions">;
      slug: string;
      sha256hash: string;
      isLatest: boolean;
    }> = [];

    for (const version of page) {
      if (!version.sha256hash) continue;
      const skill = await ctx.db.get(version.skillId);
      if (!skill || skill.softDeletedAt) continue;

      results.push({
        skillId: skill._id,
        versionId: version._id,
        slug: skill.slug,
        sha256hash: version.sha256hash,
        isLatest: skill.latestVersionId === version._id,
      });
    }

    return { skills: results, cursor: continueCursor, done: isDone };
  },
});

export const updateSkillVersionStaticScanInternal = internalMutation({
  args: {
    skillId: v.id("skills"),
    versionId: v.id("skillVersions"),
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
    const version = await ctx.db.get(args.versionId);
    if (!version || version.skillId !== args.skillId)
      return { ok: true as const, skipped: "missing" as const };

    await ctx.db.patch(version._id, {
      staticScan: args.staticScan,
    });
    await ctx.scheduler?.runAfter(0, internal.skillCards.enqueueForVersionInternal, {
      versionId: version._id,
      source: "scan",
    });

    return { ok: true as const, status: args.staticScan.status };
  },
});

export const scanSkillVersionStaticallyInternal: ReturnType<typeof internalAction> = internalAction(
  {
    args: {
      skillId: v.id("skills"),
      versionId: v.id("skillVersions"),
    },
    handler: async (ctx, args) => {
      const [skill, version] = await Promise.all([
        ctx.runQuery(internal.skills.getSkillByIdInternal, { skillId: args.skillId }),
        ctx.runQuery(internal.skills.getVersionByIdInternal, { versionId: args.versionId }),
      ]);

      if (!skill || !version) {
        return { ok: true as const, skipped: "missing" as const };
      }

      const fingerprintEntries = (await ctx.runQuery(
        internal.skills.listVersionFingerprintsInternal,
        {
          skillVersionId: version._id,
        },
      )) as Array<{ fingerprint: string; kind?: "source" | "generated-bundle" }>;
      const generatedBundleFingerprints = fingerprintEntries
        .filter((entry) => entry.kind === "generated-bundle")
        .map((entry) => entry.fingerprint);
      const staticScan = await runStaticPublishScan(ctx, {
        slug: skill.slug,
        displayName: skill.displayName,
        summary: skill.summary ?? undefined,
        frontmatter: version.parsed?.frontmatter ?? {},
        metadata: version.parsed?.metadata,
        files: sourceSkillVersionFiles(version.files, { generatedBundleFingerprints }),
      });

      return await ctx.runMutation(internal.skills.updateSkillVersionStaticScanInternal, {
        skillId: skill._id,
        versionId: version._id,
        staticScan,
      });
    },
  },
);

export const backfillSkillStaticScansInternal: ReturnType<typeof internalAction> = internalAction({
  args: {
    cursor: v.optional(v.number()),
    batchSize: v.optional(v.number()),
    rescanned: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = Math.max(1, Math.min(args.batchSize ?? 25, 100));
    const batch = await ctx.runQuery(
      internal.skills.getActiveSkillBatchForStaticScanBackfillInternal,
      {
        cursor: args.cursor,
        batchSize,
      },
    );

    let rescanned = args.rescanned ?? 0;
    for (const skill of batch.skills) {
      await ctx.scheduler.runAfter(0, internal.skills.scanSkillVersionStaticallyInternal, {
        skillId: skill.skillId,
        versionId: skill.versionId,
      });
      rescanned += 1;
    }

    if (!batch.done) {
      await ctx.scheduler.runAfter(0, internal.skills.backfillSkillStaticScansInternal, {
        cursor: batch.nextCursor,
        batchSize,
        rescanned,
      });
    }

    return {
      rescanned,
      nextCursor: batch.nextCursor,
      done: batch.done,
    };
  },
});

export const backfillSkillStaticScans: ReturnType<typeof action> = action({
  args: {
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUserFromAction(ctx);
    assertAdmin(user);
    return await ctx.runAction(internal.skills.backfillSkillStaticScansInternal, {
      batchSize: args.batchSize,
    });
  },
});

/**
 * Emergency escalation by skillId for legacy rows without sha256hash.
 * Rebuilds the full moderation snapshot so legacy rows stay in sync with structured fields.
 */
export const escalateSkillByIdInternal = internalMutation({
  args: {
    skillId: v.id("skills"),
    moderationReason: v.string(),
    moderationFlags: v.array(v.string()),
    moderationStatus: v.union(v.literal("active"), v.literal("hidden")),
  },
  handler: async (ctx, args) => {
    const skill = await ctx.db.get(args.skillId);
    if (!skill) return;

    const now = Date.now();
    const version = skill.latestVersionId ? await ctx.db.get(skill.latestVersionId) : null;
    const owner = skill.ownerUserId ? await ctx.db.get(skill.ownerUserId) : null;
    const normalizedReason = args.moderationReason.trim().toLowerCase();
    const reasonMatch = /^scanner\.(vt|llm)\.([^.]+)$/.exec(normalizedReason);
    const vtStatus = reasonMatch?.[1] === "vt" ? reasonMatch[2] : version?.vtAnalysis?.status;
    const llmStatus = reasonMatch?.[1] === "llm" ? reasonMatch[2] : version?.llmAnalysis?.status;
    const snapshot = buildModerationSnapshot({
      staticScan: version?.staticScan,
      vtAnalysis: version?.vtAnalysis,
      vtStatus,
      llmStatus,
      llmAnalysis: version?.llmAnalysis,
      sourceVersionId: version?._id,
    });
    const sourceReasonCodes = snapshot.reasonCodes;
    const vtStatusForReason = scannerStatusFromReasonCodes({
      scanner: "vt",
      status: vtStatus,
      reasonCodes: sourceReasonCodes,
    });
    const rawVtStatus = normalizeAnalysisStatus(vtStatus);
    const llmStatusForReason =
      !vtStatusForReason &&
      (rawVtStatus === "malicious" || rawVtStatus === "suspicious") &&
      normalizeAnalysisStatus(llmStatus) === "clean"
        ? undefined
        : llmStatus;
    const sourceReason = resolveScannerModerationReason({
      vtStatus: vtStatusForReason,
      llmStatus: llmStatusForReason,
      verdict: snapshot.verdict,
    });
    const bypassSuspicious =
      snapshot.verdict === "suspicious" && isPrivilegedOwnerForSuspiciousBypass(owner);
    const moderationReasonCodes = bypassSuspicious
      ? sourceReasonCodes.filter((code) => !code.startsWith("suspicious."))
      : sourceReasonCodes;
    const moderationVerdict = verdictFromCodes(moderationReasonCodes);
    const isReviewOnlyVerdict =
      moderationVerdict === "clean" && hasReviewReasonCode(moderationReasonCodes);
    const moderationFlags = isReviewOnlyVerdict
      ? ["flagged.review"]
      : legacyFlagsFromVerdict(moderationVerdict);
    const moderationReason = bypassSuspicious
      ? normalizeScannerSuspiciousReason(sourceReason)
      : isReviewOnlyVerdict
        ? "scanner.llm.review"
        : sourceReason;
    const moderationStatus =
      moderationVerdict === "malicious"
        ? "hidden"
        : moderationVerdict === "clean"
          ? "active"
          : args.moderationStatus;

    const basePatch: SkillModerationPatch = {
      moderationReason,
      moderationFlags,
      moderationStatus,
      moderationVerdict,
      moderationReasonCodes: moderationReasonCodes.length ? moderationReasonCodes : undefined,
      moderationEvidence: snapshot.evidence.length ? snapshot.evidence : undefined,
      moderationSummary: summarizeReasonCodes(moderationReasonCodes),
      moderationEngineVersion: snapshot.engineVersion,
      moderationEvaluatedAt: snapshot.evaluatedAt,
      moderationSourceVersionId: version?._id,
      moderationNotes: undefined,
      isSuspicious: computeIsSuspicious({
        moderationFlags,
        moderationReason,
      }),
      hiddenAt: moderationStatus === "hidden" ? now : undefined,
      hiddenBy: undefined,
      unpublishedSlugReservedUntil: undefined,
      unpublishedSlugReleasedAt: undefined,
      unpublishedOriginalSlug: undefined,
      lastReviewedAt: moderationStatus === "hidden" ? now : undefined,
      updatedAt: now,
    };
    const patch = basePatch;
    const nextSkill = { ...skill, ...patch };
    await ctx.db.patch(skill._id, patch);
    await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);
  },
});

/**
 * Update a skill's moderationReason.
 */
export const updateSkillModerationReasonInternal = internalMutation({
  args: {
    skillId: v.id("skills"),
    moderationReason: v.string(),
  },
  handler: async (ctx, args) => {
    const skill = await ctx.db.get(args.skillId);
    await ctx.db.patch(args.skillId, {
      moderationReason: args.moderationReason,
      isSuspicious: computeIsSuspicious({
        moderationFlags: skill?.moderationFlags,
        moderationReason: args.moderationReason,
      }),
    });
  },
});

/**
 * Get skills with null moderationStatus that need to be normalized.
 */
export const getSkillsWithNullModerationStatusInternal = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    const skills = await ctx.db
      .query("skills")
      .filter((q) =>
        q.and(
          q.eq(q.field("moderationStatus"), undefined),
          q.eq(q.field("softDeletedAt"), undefined),
        ),
      )
      .take(limit);

    return skills.map((s) => ({
      skillId: s._id,
      slug: s.slug,
      moderationReason: s.moderationReason,
    }));
  },
});

/**
 * Set moderationStatus to 'active' for a skill.
 */
export const setSkillModerationStatusActiveInternal = internalMutation({
  args: { skillId: v.id("skills") },
  handler: async (ctx, args) => {
    const skill = await ctx.db.get(args.skillId);
    if (!skill) return;

    const patch: Partial<Doc<"skills">> = { moderationStatus: "active" };
    const nextSkill = { ...skill, ...patch };
    await ctx.db.patch(args.skillId, patch);
    await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);
  },
});

async function listSkillEmbeddingsForSkill(ctx: MutationCtx, skillId: Id<"skills">) {
  return ctx.db
    .query("skillEmbeddings")
    .withIndex("by_skill", (q) => q.eq("skillId", skillId))
    .collect();
}

async function markSkillEmbeddingsDeleted(ctx: MutationCtx, skillId: Id<"skills">, now: number) {
  const embeddings = await listSkillEmbeddingsForSkill(ctx, skillId);
  for (const embedding of embeddings) {
    if (embedding.visibility === "deleted") continue;
    await ctx.db.patch(embedding._id, { visibility: "deleted", updatedAt: now });
  }
}

async function restoreSkillEmbeddingsVisibility(
  ctx: MutationCtx,
  skillId: Id<"skills">,
  now: number,
) {
  const embeddings = await listSkillEmbeddingsForSkill(ctx, skillId);
  for (const embedding of embeddings) {
    const visibility = embeddingVisibilityFor(embedding.isLatest, embedding.isApproved);
    await ctx.db.patch(embedding._id, { visibility, updatedAt: now });
  }
}

export async function setSkillEmbeddingsSoftDeleted(
  ctx: MutationCtx,
  skillId: Id<"skills">,
  deleted: boolean,
  now: number,
) {
  if (deleted) {
    await markSkillEmbeddingsDeleted(ctx, skillId, now);
    return;
  }

  await restoreSkillEmbeddingsVisibility(ctx, skillId, now);
}

async function setSkillEmbeddingsLatestVersion(
  ctx: MutationCtx,
  skillId: Id<"skills">,
  latestVersionId: Id<"skillVersions">,
  now: number,
  skillHidden = false,
) {
  const embeddings = await listSkillEmbeddingsForSkill(ctx, skillId);
  for (const embedding of embeddings) {
    const isLatest = embedding.versionId === latestVersionId;
    await ctx.db.patch(embedding._id, {
      isLatest,
      visibility: skillHidden ? "deleted" : embeddingVisibilityFor(isLatest, embedding.isApproved),
      updatedAt: now,
    });
  }
}

async function setSkillEmbeddingsApproved(
  ctx: MutationCtx,
  skillId: Id<"skills">,
  approved: boolean,
  now: number,
) {
  const embeddings = await listSkillEmbeddingsForSkill(ctx, skillId);
  for (const embedding of embeddings) {
    await ctx.db.patch(embedding._id, {
      isApproved: approved,
      visibility: embeddingVisibilityFor(embedding.isLatest, approved),
      updatedAt: now,
    });
  }
}

export const applyBanToOwnedSkillsBatchInternal = internalMutation({
  args: {
    ownerUserId: v.id("users"),
    bannedAt: v.number(),
    hiddenBy: v.optional(v.id("users")),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.cursor) {
      const owner = await ctx.db.get(args.ownerUserId);
      if (!owner || owner.deletedAt !== args.bannedAt || owner.deactivatedAt) {
        return { ok: true as const, hiddenCount: 0, scheduled: false, aborted: true };
      }
    }

    const { page, isDone, continueCursor } = await ctx.db
      .query("skills")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", args.ownerUserId))
      .order("desc")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: BAN_USER_SKILLS_BATCH_SIZE,
      });

    let hiddenCount = 0;
    for (const skill of page) {
      if (skill.softDeletedAt) {
        const isBanHiddenStatus =
          skill.moderationStatus === "hidden" || skill.moderationStatus === undefined;
        if (
          isBanHiddenStatus &&
          skill.moderationReason === "user.banned" &&
          skill.softDeletedAt < args.bannedAt
        ) {
          await ctx.db.patch(skill._id, {
            softDeletedAt: args.bannedAt,
            hiddenAt: args.bannedAt,
            hiddenBy: args.hiddenBy,
            lastReviewedAt: args.bannedAt,
            updatedAt: args.bannedAt,
          });
        }
        continue;
      }

      // Only overwrite moderation fields for active skills. Keep existing hidden/removed
      // moderation reasons intact.
      const shouldMarkModeration = (skill.moderationStatus ?? "active") === "active";

      const patch: Partial<Doc<"skills">> = {
        softDeletedAt: args.bannedAt,
        updatedAt: args.bannedAt,
      };
      if (shouldMarkModeration) {
        patch.moderationStatus = "hidden";
        patch.moderationReason = "user.banned";
        patch.hiddenAt = args.bannedAt;
        patch.hiddenBy = args.hiddenBy;
        patch.lastReviewedAt = args.bannedAt;
        patch.isSuspicious = computeIsSuspicious({
          moderationFlags: skill.moderationFlags,
          moderationReason: "user.banned",
        });
        hiddenCount += 1;
      }

      const nextSkill = { ...skill, ...patch };
      await ctx.db.patch(skill._id, patch);
      await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);
      await adjustUserSkillStatsForSkillChange(ctx, skill, nextSkill);
      await setSkillEmbeddingsSoftDeleted(ctx, skill._id, true, args.bannedAt);
    }

    scheduleNextBatchIfNeeded(
      ctx.scheduler,
      internal.skills.applyBanToOwnedSkillsBatchInternal,
      args,
      isDone,
      continueCursor,
    );

    return { ok: true as const, hiddenCount, scheduled: !isDone };
  },
});

export const applyUserModerationToOwnedSkillsBatchInternal = internalMutation({
  args: {
    ownerUserId: v.id("users"),
    hiddenAt: v.number(),
    hiddenBy: v.optional(v.id("users")),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Stale batch guard: if the hold was lifted between batch pages,
    // stop hiding skills. Without this, a liftModerationHold call that
    // races with a multi-page hide chain can leave late-hidden skills
    // permanently stuck (the restore may have already paged past them).
    const user = await ctx.db.get(args.ownerUserId);
    if (user && !user.requiresModerationAt) {
      return { ok: true as const, hiddenCount: 0, scheduled: false, aborted: true };
    }

    const { page, isDone, continueCursor } = await ctx.db
      .query("skills")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", args.ownerUserId))
      .order("desc")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: BAN_USER_SKILLS_BATCH_SIZE,
      });

    let hiddenCount = 0;
    for (const skill of page) {
      if (skill.softDeletedAt) continue;
      const currentStatus = skill.moderationStatus ?? "active";
      if (currentStatus !== "active") continue;

      const nextReason =
        skill.moderationVerdict === "malicious"
          ? (skill.moderationReason ?? "scanner.aggregate.malicious")
          : USER_MODERATION_REASON;
      const nextStatus = "hidden";
      const patch: Partial<Doc<"skills">> = {
        moderationStatus: nextStatus,
        moderationReason: nextReason,
        hiddenAt: args.hiddenAt,
        hiddenBy: args.hiddenBy,
        lastReviewedAt: args.hiddenAt,
        updatedAt: args.hiddenAt,
        isSuspicious: computeIsSuspicious({
          moderationFlags: skill.moderationFlags,
          moderationReason: nextReason,
        }),
      };

      const nextSkill = { ...skill, ...patch };
      await ctx.db.patch(skill._id, patch);
      await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);
      hiddenCount += 1;
    }

    scheduleNextBatchIfNeeded(
      ctx.scheduler,
      internal.skills.applyUserModerationToOwnedSkillsBatchInternal,
      args,
      isDone,
      continueCursor,
    );

    return { ok: true as const, hiddenCount, scheduled: !isDone };
  },
});

export const applyPublisherDeletionToOwnedSkillsBatchInternal = internalMutation({
  args: {
    ownerPublisherId: v.id("publishers"),
    actorUserId: v.id("users"),
    deletedAt: v.number(),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const publisher = await ctx.db.get(args.ownerPublisherId);
    if (publisher && publisher.deletedAt !== args.deletedAt) {
      return { ok: true as const, hiddenCount: 0, scheduled: false, stale: true as const };
    }

    const { page, isDone, continueCursor } = await ctx.db
      .query("skills")
      .withIndex("by_owner_publisher", (q) => q.eq("ownerPublisherId", args.ownerPublisherId))
      .order("desc")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: BAN_USER_SKILLS_BATCH_SIZE,
      });

    let hiddenCount = 0;
    for (const skill of page) {
      await hardDeleteSkillStep(ctx, skill, args.actorUserId, "versions", {
        source: "publisher.delete",
        ownerPublisherId: args.ownerPublisherId,
      });
      hiddenCount += 1;
    }

    scheduleNextBatchIfNeeded(
      ctx.scheduler,
      internal.skills.applyPublisherDeletionToOwnedSkillsBatchInternal,
      args,
      isDone,
      continueCursor,
    );

    return { ok: true as const, hiddenCount, scheduled: !isDone };
  },
});

export const applyAccountDeletionToOwnedSkillsBatchInternal = internalMutation({
  args: {
    ownerUserId: v.id("users"),
    deletedAt: v.number(),
    hiddenBy: v.optional(v.id("users")),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { page, isDone, continueCursor } = await ctx.db
      .query("skills")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", args.ownerUserId))
      .order("desc")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: BAN_USER_SKILLS_BATCH_SIZE,
      });

    let hiddenCount = 0;
    for (const skill of page) {
      if (skill.ownerPublisherId) continue;
      await hardDeleteSkillStep(ctx, skill, args.hiddenBy ?? args.ownerUserId, "versions", {
        source: "account.delete",
      });
      hiddenCount += 1;
    }

    scheduleNextBatchIfNeeded(
      ctx.scheduler,
      internal.skills.applyAccountDeletionToOwnedSkillsBatchInternal,
      args,
      isDone,
      continueCursor,
    );

    return { ok: true as const, hiddenCount, scheduled: !isDone };
  },
});

export const restoreOwnedSkillsForUnbanBatchInternal = internalMutation({
  args: {
    ownerUserId: v.id("users"),
    bannedAt: v.number(),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.ownerUserId);
    if (!user || user.deletedAt || user.deactivatedAt) {
      return { ok: true as const, restoredCount: 0, scheduled: false, aborted: true };
    }

    const now = Date.now();

    const { page, isDone, continueCursor } = await ctx.db
      .query("skills")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", args.ownerUserId))
      .order("desc")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: BAN_USER_SKILLS_BATCH_SIZE,
      });

    let restoredCount = 0;
    for (const skill of page) {
      if (
        !skill.softDeletedAt ||
        skill.softDeletedAt !== args.bannedAt ||
        skill.moderationStatus === "removed" ||
        skill.moderationReason !== "user.banned"
      ) {
        continue;
      }

      const patch: Partial<Doc<"skills">> = {
        softDeletedAt: undefined,
        moderationStatus: "active",
        moderationReason: "restored.unban",
        isSuspicious: computeIsSuspicious({
          moderationFlags: skill.moderationFlags,
          moderationReason: "restored.unban",
        }),
        hiddenAt: undefined,
        hiddenBy: undefined,
        lastReviewedAt: now,
        updatedAt: now,
      };
      const nextSkill = { ...skill, ...patch };
      await ctx.db.patch(skill._id, patch);
      await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);
      await adjustUserSkillStatsForSkillChange(ctx, skill, nextSkill);

      await setSkillEmbeddingsSoftDeleted(ctx, skill._id, false, now);
      restoredCount += 1;
    }

    scheduleNextBatchIfNeeded(
      ctx.scheduler,
      internal.skills.restoreOwnedSkillsForUnbanBatchInternal,
      args,
      isDone,
      continueCursor,
    );

    return { ok: true as const, restoredCount, scheduled: !isDone };
  },
});

/**
 * Batch restore skills hidden by a moderation hold.
 * Only restores skills where moderationReason is "user.moderation"
 * and moderationStatus is "hidden".
 *
 * Race condition safety: before processing each page, verifies the user
 * has not been placed under a new moderation hold. If requiresModerationAt
 * is set again (new hold placed between batch pages), the batch aborts
 * to avoid restoring skills that should remain hidden.
 *
 * Skills published while under hold also get moderationReason "user.moderation"
 * and are included in the restore. Skills hidden for other reasons (manual
 * moderator action, community reports) are not affected.
 */
export const restoreOwnedSkillsForModerationLiftBatchInternal = internalMutation({
  args: {
    ownerUserId: v.id("users"),
    holdPlacedAt: v.number(),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Race condition guard: if the user has been re-held between batch pages,
    // abort to avoid restoring skills that should stay hidden under the new hold.
    const user = await ctx.db.get(args.ownerUserId);
    if (user?.requiresModerationAt) {
      return { ok: true as const, restoredCount: 0, scheduled: false, aborted: true };
    }

    const now = Date.now();
    const { page, isDone, continueCursor } = await ctx.db
      .query("skills")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", args.ownerUserId))
      .order("desc")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: BAN_USER_SKILLS_BATCH_SIZE,
      });

    let restoredCount = 0;
    for (const skill of page) {
      // Skip skills hidden before this hold was placed — they belong to
      // an earlier moderation action and should not be restored here.
      // We use >= (not ===) because the hide batch may stamp hiddenAt
      // with the same `now` used for requiresModerationAt, or a later
      // timestamp if the user was re-moderated without clearing the hold.
      // The primary race-condition guard is the requiresModerationAt check
      // above: if a *new* hold exists, the batch aborts entirely.
      if (skill.hiddenAt != null && skill.hiddenAt < args.holdPlacedAt) continue;
      // Skip soft-deleted skills: if a ban raced with this batch, those
      // rows need their moderationReason intact for unban recovery.
      if (skill.softDeletedAt) continue;
      if (skill.moderationReason !== USER_MODERATION_REASON) continue;
      if (skill.moderationStatus !== "hidden") continue;

      const latestVersion = skill.latestVersionId ? await ctx.db.get(skill.latestVersionId) : null;

      // Restore from the current structured scanner result. VirusTotal is no
      // longer guaranteed to run, so checking only vtAnalysis would leave
      // clean ClawScan versions hidden as pending forever.
      const patch: Partial<Doc<"skills">> =
        latestVersion && hasCompletedScannerResult(latestVersion)
          ? {
              ...buildScannerModerationPatchFromVersion({
                owner: user,
                version: latestVersion,
                now,
              }),
              updatedAt: now,
            }
          : {
              moderationStatus: "hidden",
              moderationReason: "pending.scan",
              isSuspicious: computeIsSuspicious({
                moderationFlags: skill.moderationFlags,
                moderationReason: "pending.scan",
              }),
              hiddenAt: undefined,
              hiddenBy: undefined,
              lastReviewedAt: now,
              updatedAt: now,
            };
      const nextSkill = { ...skill, ...patch };
      await ctx.db.patch(skill._id, patch);
      await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);
      restoredCount += 1;
    }

    scheduleNextBatchIfNeeded(
      ctx.scheduler,
      internal.skills.restoreOwnedSkillsForModerationLiftBatchInternal,
      args,
      isDone,
      continueCursor,
    );

    return { ok: true as const, restoredCount, scheduled: !isDone };
  },
});

/**
 * Get legacy skills that are active but still have "pending.scan" reason.
 * These need to be scanned through VT to get proper verdicts.
 */
export const getLegacyPendingScanSkillsInternal = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 1000;
    const skills = await ctx.db
      .query("skills")
      .withIndex("by_moderation", (q) =>
        q.eq("moderationStatus", "active").eq("moderationReason", "pending.scan"),
      )
      .take(limit);

    const results: Array<{
      skillId: Id<"skills">;
      versionId: Id<"skillVersions">;
      slug: string;
      hasHash: boolean;
    }> = [];

    for (const skill of skills) {
      if (!skill.latestVersionId) continue;
      const version = await ctx.db.get(skill.latestVersionId);
      results.push({
        skillId: skill._id,
        versionId: version?._id ?? ("" as Id<"skillVersions">),
        slug: skill.slug,
        hasHash: Boolean(version?.sha256hash),
      });
    }

    return results;
  },
});

/**
 * Get active skills that bypassed VT entirely (null moderationReason).
 */
export const getUnscannedActiveSkillsInternal = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 1000;
    const skills = await ctx.db
      .query("skills")
      .withIndex("by_moderation", (q) =>
        q.eq("moderationStatus", "active").eq("moderationReason", undefined),
      )
      .take(limit);

    const results: Array<{
      skillId: Id<"skills">;
      versionId: Id<"skillVersions">;
      slug: string;
    }> = [];

    for (const skill of skills) {
      if (skill.softDeletedAt) continue;
      if (!skill.latestVersionId) continue;
      const version = await ctx.db.get(skill.latestVersionId);
      results.push({
        skillId: skill._id,
        versionId: version?._id ?? ("" as Id<"skillVersions">),
        slug: skill.slug,
      });
    }

    return results;
  },
});

/**
 * Update scan tracking for a skill (called after each VT check)
 */
export const updateScanCheckInternal = internalMutation({
  args: { skillId: v.id("skills") },
  handler: async (ctx, args) => {
    const skill = await ctx.db.get(args.skillId);
    if (!skill) return;

    await ctx.db.patch(args.skillId, {
      scanLastCheckedAt: Date.now(),
      scanCheckCount: (skill.scanCheckCount ?? 0) + 1,
    });
  },
});

/**
 * Mark a skill as stale after too many failed scan checks
 * TODO: Setup webhook/notification when skills are marked stale for manual review
 */
export const markScanStaleInternal = internalMutation({
  args: { skillId: v.id("skills") },
  handler: async (ctx, args) => {
    const skill = await ctx.db.get(args.skillId);
    if (!skill) return;

    await ctx.db.patch(args.skillId, {
      moderationReason: "pending.scan.stale",
      isSuspicious: computeIsSuspicious({
        moderationFlags: skill.moderationFlags,
        moderationReason: "pending.scan.stale",
      }),
      updatedAt: Date.now(),
    });
  },
});

export const listVersionsInternal = internalQuery({
  args: { skillId: v.id("skills") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("skillVersions")
      .withIndex("by_skill", (q) => q.eq("skillId", args.skillId))
      .collect();
  },
});

export const updateVersionScanResultsInternal = internalMutation({
  args: {
    versionId: v.id("skillVersions"),
    sha256hash: v.optional(v.string()),
    vtAnalysis: v.optional(vtAnalysisValidator),
  },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) return;

    const patch: Partial<Doc<"skillVersions">> = {};
    if (args.sha256hash !== undefined) {
      patch.sha256hash = args.sha256hash;
    }
    if (args.vtAnalysis !== undefined) {
      patch.vtAnalysis = args.vtAnalysis;
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.versionId, patch);
    }
  },
});

export const updateVersionSkillSpectorAnalysisInternal = internalMutation({
  args: {
    versionId: v.id("skillVersions"),
    skillSpectorAnalysis: skillSpectorAnalysisValidator,
  },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) return;
    await ctx.db.patch(args.versionId, {
      skillSpectorAnalysis: args.skillSpectorAnalysis,
    });
  },
});

export const updateVersionAigAnalysisInternal = internalMutation({
  args: {
    versionId: v.id("skillVersions"),
    aigAnalysis: aigAnalysisValidator,
  },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) return;
    await ctx.db.patch(args.versionId, {
      aigAnalysis: args.aigAnalysis,
    });
  },
});

export const updateVersionLlmAnalysisInternal = internalMutation({
  args: {
    versionId: v.id("skillVersions"),
    moderationMode: v.optional(v.union(v.literal("normal"), v.literal("preserve"))),
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
      agenticRiskFindings: v.optional(
        v.array(
          v.object({
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
            evidence: v.optional(
              v.object({
                path: v.string(),
                snippet: v.string(),
                explanation: v.string(),
              }),
            ),
            userImpact: v.string(),
            recommendation: v.string(),
          }),
        ),
      ),
      riskSummary: v.optional(
        v.object({
          abnormal_behavior_control: v.object({
            status: v.union(v.literal("none"), v.literal("note"), v.literal("concern")),
            summary: v.string(),
            highestSeverity: v.optional(v.string()),
          }),
          permission_boundary: v.object({
            status: v.union(v.literal("none"), v.literal("note"), v.literal("concern")),
            summary: v.string(),
            highestSeverity: v.optional(v.string()),
          }),
          sensitive_data_protection: v.object({
            status: v.union(v.literal("none"), v.literal("note"), v.literal("concern")),
            summary: v.string(),
            highestSeverity: v.optional(v.string()),
          }),
        }),
      ),
      model: v.optional(v.string()),
      checkedAt: v.number(),
    }),
  },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) return;
    const nextVersion = { ...version, llmAnalysis: args.llmAnalysis };
    await ctx.db.patch(args.versionId, { llmAnalysis: args.llmAnalysis });
    await ctx.scheduler?.runAfter(0, internal.skillCards.enqueueForVersionInternal, {
      versionId: args.versionId,
      source: "scan",
    });
    if (args.moderationMode === "preserve") return;

    const skill = await ctx.db.get(version.skillId);
    if (!skill) return;
    if (skill.latestVersionId !== version._id) {
      const owner = skill.ownerUserId ? await ctx.db.get(skill.ownerUserId) : null;
      const now = Date.now();
      const patch = buildScannerModerationPatchFromVersion({
        owner,
        version: nextVersion,
        now,
      });
      if (
        patch.moderationVerdict === "malicious" &&
        isClawScanMaliciousAnalysis(args.llmAnalysis)
      ) {
        await scheduleClawScanMaliciousArtifactFinding(ctx, skill, nextVersion, patch);
        await quarantineMaliciousNonLatestSkillVersion(ctx, skill, version._id, now);
      }
      return;
    }
    await patchStructuredModerationFromVersion(ctx, skill, nextVersion);
  },
});

export const approveSkillByHashInternal = internalMutation({
  args: {
    sha256hash: v.string(),
    scanner: v.string(),
    status: v.string(),
    moderationStatus: v.optional(v.union(v.literal("active"), v.literal("hidden"))),
  },
  handler: async (ctx, args) => {
    const version = await ctx.db
      .query("skillVersions")
      .withIndex("by_sha256hash", (q) => q.eq("sha256hash", args.sha256hash))
      .unique();

    if (!version) throw new Error("Version not found for hash");

    // Update the skill's moderation status based on scan result
    const skill = await ctx.db.get(version.skillId);
    if (skill) {
      if (skill.latestVersionId && skill.latestVersionId !== version._id) {
        return { ok: true, skillId: version.skillId, versionId: version._id };
      }

      const owner = skill.ownerUserId ? await ctx.db.get(skill.ownerUserId) : null;
      const isMalicious = args.status === "malicious";
      const isSuspicious = args.status === "suspicious";
      const isClean = !isMalicious && !isSuspicious;

      // Defense-in-depth: read existing flags to merge scanner results.
      // The stricter verdict always wins across scanners.
      const existingFlags: string[] = (skill.moderationFlags as string[] | undefined) ?? [];
      const existingReason: string | undefined = skill.moderationReason as string | undefined;
      const alreadyBlocked = existingFlags.includes("blocked.malware");
      const bypassSuspicious =
        isSuspicious && !alreadyBlocked && isPrivilegedOwnerForSuspiciousBypass(owner);

      // Determine new flags based on multi-scanner merge
      let newFlags: string[] | undefined;
      if (isMalicious || alreadyBlocked) {
        // Malicious from ANY scanner → blocked.malware (upgrade from suspicious)
        newFlags = ["blocked.malware"];
      } else if (isSuspicious && !bypassSuspicious) {
        // Suspicious from this scanner → flagged.suspicious
        newFlags = ["flagged.suspicious"];
      } else if (isClean) {
        // Clean from this scanner — only clear if no other scanner has flagged
        const otherScannerFlagged =
          existingReason?.startsWith("scanner.") &&
          !existingReason.startsWith(`scanner.${args.scanner}.`) &&
          !existingReason.endsWith(".clean") &&
          !existingReason.endsWith(".pending");
        newFlags = otherScannerFlagged ? existingFlags : undefined;
      }
      if (!alreadyBlocked && isPrivilegedOwnerForSuspiciousBypass(owner)) {
        newFlags = stripSuspiciousFlag(newFlags ?? existingFlags);
      }

      const now = Date.now();
      const qualityLocked = skill.moderationReason === "quality.low" && !isMalicious;
      const nextModerationNotes = qualityLocked
        ? (skill.moderationNotes ??
          "Quality gate quarantine is still active. Manual moderation review required.")
        : undefined;
      const scanner = args.scanner.trim().toLowerCase();
      const snapshot = buildModerationSnapshot({
        staticScan: version.staticScan,
        vtAnalysis: version.vtAnalysis,
        vtStatus: scanner === "vt" ? args.status : version.vtAnalysis?.status,
        llmStatus: scanner === "llm" ? args.status : version.llmAnalysis?.status,
        llmAnalysis: version.llmAnalysis,
        sourceVersionId: version._id,
      });
      const nextReasonCodes =
        bypassSuspicious && !isMalicious
          ? snapshot.reasonCodes.filter((code) => !code.startsWith("suspicious."))
          : snapshot.reasonCodes;
      const nextVerdict = verdictFromCodes(nextReasonCodes);
      const nextLegacyFlags = legacyFlagsFromVerdict(nextVerdict);
      const isReviewOnlyVerdict = nextVerdict === "clean" && hasReviewReasonCode(nextReasonCodes);
      if (nextVerdict === "clean") {
        newFlags = isReviewOnlyVerdict ? ["flagged.review"] : undefined;
      }
      const nextModerationReason = qualityLocked
        ? "quality.low"
        : isReviewOnlyVerdict
          ? "scanner.llm.review"
          : bypassSuspicious
            ? `scanner.${args.scanner}.clean`
            : nextVerdict === "clean"
              ? "scanner.aggregate.clean"
              : `scanner.${args.scanner}.${args.status}`;
      const nextModerationStatus =
        nextVerdict === "malicious" || qualityLocked ? "hidden" : "active";

      const basePatch: SkillModerationPatch = {
        moderationStatus: nextModerationStatus,
        moderationReason: nextModerationReason,
        moderationFlags: newFlags ?? nextLegacyFlags,
        moderationVerdict: nextVerdict,
        moderationReasonCodes: nextReasonCodes.length ? nextReasonCodes : undefined,
        moderationEvidence: snapshot.evidence.length ? snapshot.evidence : undefined,
        moderationSummary: summarizeReasonCodes(nextReasonCodes),
        moderationEngineVersion: snapshot.engineVersion,
        moderationEvaluatedAt: snapshot.evaluatedAt,
        moderationSourceVersionId: version._id,
        moderationNotes: nextModerationNotes,
        isSuspicious: computeIsSuspicious({
          moderationFlags: (newFlags ?? nextLegacyFlags) as string[] | undefined,
          moderationReason: nextModerationReason,
        }),
        hiddenAt: nextModerationStatus === "hidden" ? now : undefined,
        hiddenBy: undefined,
        unpublishedSlugReservedUntil: undefined,
        unpublishedSlugReleasedAt: undefined,
        unpublishedOriginalSlug: undefined,
        lastReviewedAt: nextModerationStatus === "hidden" ? now : undefined,
      };
      const patch = basePatch;
      const nextSkill = { ...skill, ...patch };
      await ctx.db.patch(skill._id, patch);
      await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);
    }

    return { ok: true, skillId: version.skillId, versionId: version._id };
  },
});

/**
 * Lighter VT-only escalation: adds moderation flags and hides/bans for malicious,
 * but never touches moderationReason (preserves the LLM verdict).
 */
export const escalateByVtInternal = internalMutation({
  args: {
    sha256hash: v.string(),
    status: v.union(v.literal("malicious"), v.literal("suspicious")),
  },
  handler: async (ctx, args) => {
    const version = await ctx.db
      .query("skillVersions")
      .withIndex("by_sha256hash", (q) => q.eq("sha256hash", args.sha256hash))
      .unique();

    if (!version) throw new Error("Version not found for hash");

    const skill = await ctx.db.get(version.skillId);
    if (!skill) return;
    if (skill.latestVersionId && skill.latestVersionId !== version._id) return;

    const isMalicious = args.status === "malicious";
    const existingFlags: string[] = (skill.moderationFlags as string[] | undefined) ?? [];
    const alreadyBlocked = existingFlags.includes("blocked.malware");
    const owner = skill.ownerUserId ? await ctx.db.get(skill.ownerUserId) : null;
    const bypassSuspicious =
      !isMalicious && !alreadyBlocked && isPrivilegedOwnerForSuspiciousBypass(owner);

    const snapshot = buildModerationSnapshot({
      staticScan: version.staticScan,
      vtAnalysis: version.vtAnalysis,
      vtStatus: args.status,
      llmStatus: version.llmAnalysis?.status,
      llmAnalysis: version.llmAnalysis,
      sourceVersionId: version._id,
    });
    const nextReasonCodes =
      bypassSuspicious && !isMalicious
        ? snapshot.reasonCodes.filter((code) => !code.startsWith("suspicious."))
        : snapshot.reasonCodes;
    const nextVerdict = verdictFromCodes(nextReasonCodes);
    const nextLegacyFlags = legacyFlagsFromVerdict(nextVerdict);

    // Determine new flags — stricter structured verdict wins.
    let newFlags: string[];
    if (nextVerdict === "malicious" || alreadyBlocked) {
      newFlags = ["blocked.malware"];
    } else if (bypassSuspicious) {
      newFlags = stripSuspiciousFlag(existingFlags) ?? [];
    } else {
      newFlags = ["flagged.suspicious"];
    }

    const isReviewOnlyVerdict = nextVerdict === "clean" && hasReviewReasonCode(nextReasonCodes);
    const nextModerationFlags = isReviewOnlyVerdict
      ? ["flagged.review"]
      : nextVerdict === "clean"
        ? undefined
        : newFlags.length
          ? newFlags
          : nextLegacyFlags;
    const now = Date.now();
    const basePatch: SkillModerationPatch = {
      moderationFlags: nextModerationFlags,
      moderationVerdict: nextVerdict,
      moderationReasonCodes: nextReasonCodes.length ? nextReasonCodes : undefined,
      moderationEvidence: snapshot.evidence.length ? snapshot.evidence : undefined,
      moderationSummary: summarizeReasonCodes(nextReasonCodes),
      moderationEngineVersion: snapshot.engineVersion,
      moderationEvaluatedAt: snapshot.evaluatedAt,
      moderationSourceVersionId: version._id,
    };
    if (bypassSuspicious) {
      basePatch.moderationReason = normalizeScannerSuspiciousReason(
        skill.moderationReason as string | undefined,
      );
    } else if (isReviewOnlyVerdict) {
      basePatch.moderationReason = "scanner.llm.review";
    } else if (nextVerdict === "clean") {
      const existingReason = skill.moderationReason as string | undefined;
      if (
        existingReason?.startsWith("scanner.") &&
        (existingReason.endsWith(".suspicious") || existingReason.endsWith(".malicious"))
      ) {
        basePatch.moderationReason = normalizeScannerSuspiciousReason(existingReason);
      }
    }

    // Only hide for malicious — suspicious stays visible with a flag
    if (nextVerdict === "malicious") {
      basePatch.moderationStatus = "hidden";
      // Security: reset hide provenance so the owner-undelete gate cannot
      // mistake prior owner-initiated soft-deletes (hiddenBy === owner,
      // moderationReason === undefined) for self-service state. The
      // moderationReason is intentionally NOT overwritten here to preserve
      // the aggregate LLM verdict (see function doc), but `blocked.malware`
      // is stamped into moderationFlags above and `moderationVerdict` is
      // "malicious", both of which the undelete gate also enforces.
      basePatch.hiddenAt = now;
      basePatch.hiddenBy = undefined;
      basePatch.unpublishedSlugReservedUntil = undefined;
      basePatch.unpublishedSlugReleasedAt = undefined;
      basePatch.unpublishedOriginalSlug = undefined;
      basePatch.lastReviewedAt = now;
    } else if (nextVerdict === "clean") {
      basePatch.moderationStatus = "active";
      basePatch.hiddenAt = undefined;
      basePatch.hiddenBy = undefined;
      basePatch.lastReviewedAt = undefined;
    }

    basePatch.isSuspicious = computeIsSuspicious({
      moderationFlags: nextModerationFlags,
      moderationReason: (basePatch.moderationReason ?? skill.moderationReason) as
        | string
        | undefined,
    });

    const patch = basePatch;
    const nextSkill = { ...skill, ...patch };
    await ctx.db.patch(skill._id, patch);
    await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);
  },
});

/**
 * Re-sync skill-level moderation from each skill's current latest version.
 * This repairs rows that were previously stamped from an older version scan.
 */
export const backfillLatestSkillModerationInternal = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const batchSize = clampInt(args.batchSize ?? 100, 10, 200);
    const { page, continueCursor, isDone } = await ctx.db
      .query("skills")
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let patched = 0;
    for (const skill of page) {
      const shouldBackfill = args.force
        ? shouldForceBackfillLatestSkillModeration(skill)
        : shouldBackfillLatestSkillModeration(skill);
      if (!shouldBackfill) continue;
      await syncSkillModerationFromLatestVersion(ctx, skill, Date.now());
      patched++;
    }

    if (!isDone) {
      await ctx.scheduler.runAfter(0, internal.skills.backfillLatestSkillModerationInternal, {
        cursor: continueCursor,
        batchSize: args.batchSize,
        force: args.force,
      });
    }

    return { patched, isDone, scanned: page.length };
  },
});

export const getVersionBySkillAndVersion = query({
  args: { skillId: v.id("skills"), version: v.string() },
  handler: async (ctx, args) => {
    const version = await ctx.db
      .query("skillVersions")
      .withIndex("by_skill_version", (q) =>
        q.eq("skillId", args.skillId).eq("version", args.version),
      )
      .unique();
    return version &&
      !version.softDeletedAt &&
      version.ownerDeletedAt === undefined &&
      isPublicSkillVersionAvailableForSkill(version, args.skillId)
      ? toPublicSkillVersion(version)
      : null;
  },
});

async function hasBoundedAvailableSkillVersionSurvivor(
  ctx: MutationCtx,
  skillId: Id<"skills">,
  targetVersionId: Id<"skillVersions">,
) {
  const candidates = await ctx.db
    .query("skillVersions")
    .withIndex("by_skill_active_created", (q) =>
      q.eq("skillId", skillId).eq("softDeletedAt", undefined),
    )
    .take(MAX_POINTERLESS_VERSION_SURVIVOR_SCAN + 1);
  const hasSurvivor = candidates.some(
    (candidate) =>
      candidate._id !== targetVersionId &&
      isSkillVersionAvailableForOwnerDeleteSafety(candidate, skillId),
  );
  if (hasSurvivor) return true;
  if (candidates.length > MAX_POINTERLESS_VERSION_SURVIVOR_SCAN) {
    throw new ConvexError(
      "This skill has too many active versions to safely delete an individual version.",
    );
  }
  return false;
}

async function hasAvailableLatestSkillVersionPointer(
  ctx: MutationCtx,
  skill: Pick<Doc<"skills">, "_id" | "latestVersionId" | "tags">,
) {
  const pointerIds = new Set<Id<"skillVersions">>();
  if (skill.latestVersionId) pointerIds.add(skill.latestVersionId);
  if (skill.tags.latest) pointerIds.add(skill.tags.latest);

  for (const pointerId of pointerIds) {
    const pointer = await ctx.db.get(pointerId);
    if (isSkillVersionAvailableForOwnerDeleteSafety(pointer, skill._id)) return true;
  }
  return false;
}

export async function deleteOwnedSkillVersionForActor(
  ctx: MutationCtx,
  actor: Doc<"users">,
  args: { versionId: Id<"skillVersions"> },
) {
  const version = await ctx.db.get(args.versionId);
  if (!version) throw new ConvexError("Forbidden");

  const skill = await ctx.db.get(version.skillId);
  if (!skill) throw new ConvexError("Forbidden");

  await assertCanManageOwnedResource(ctx, {
    actor,
    ownerUserId: skill.ownerUserId,
    ownerPublisherId: skill.ownerPublisherId,
    allowedPublisherRoles: ["admin"],
  });

  if (!isSkillVersionAvailableForOwnerDeleteSafety(version, skill._id)) {
    throw new ConvexError("This skill version is already unavailable and cannot be deleted.");
  }
  if (skill.softDeletedAt || (skill.moderationStatus ?? "active") !== "active") {
    throw new ConvexError("This skill is unavailable and its versions cannot be deleted.");
  }

  let mustPublishReplacement =
    skill.latestVersionId === version._id ||
    skill.tags.latest === version._id ||
    skill.latestVersionSummary?.version === version.version;
  if (!mustPublishReplacement && !(await hasAvailableLatestSkillVersionPointer(ctx, skill))) {
    // Admin cleanup can clear latest pointers, so prove a survivor with a bounded indexed read.
    mustPublishReplacement = !(await hasBoundedAvailableSkillVersionSurvivor(
      ctx,
      skill._id,
      version._id,
    ));
  }
  if (mustPublishReplacement) {
    throw new ConvexError(
      "Publish a replacement version before deleting the current latest version.",
    );
  }

  const now = Date.now();
  await ctx.db.patch(version._id, {
    softDeletedAt: now,
    ownerDeletedAt: now,
    ownerDeletedBy: actor._id,
  });

  const nextTags = Object.fromEntries(
    Object.entries(skill.tags ?? {}).filter(([, versionId]) => versionId !== version._id),
  ) as Doc<"skills">["tags"];

  if (Object.keys(nextTags).length !== Object.keys(skill.tags ?? {}).length) {
    const skillPatch: Partial<Doc<"skills">> = {
      tags: nextTags,
      updatedAt: now,
    };
    await ctx.db.patch(skill._id, skillPatch);
    await syncSkillSearchDigestForSkillDoc(ctx, { ...skill, ...skillPatch });
  }

  await ctx.db.insert("auditLogs", {
    actorUserId: actor._id,
    action: "skill.version.delete",
    targetType: "skillVersion",
    targetId: version._id,
    metadata: {
      skillId: skill._id,
      slug: skill.slug,
      version: version.version,
    },
    createdAt: now,
  });

  return { ok: true as const, skillId: skill._id, versionId: version._id };
}

export async function deleteOwnedSkillVersionForUser(
  ctx: MutationCtx,
  args: {
    actorUserId: Id<"users">;
    slug: string;
    version: string;
  },
) {
  const actor = await ctx.db.get(args.actorUserId);
  if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");

  const slug = args.slug.trim();
  if (!slug) throw new ConvexError("Slug required");
  const version = args.version.trim();
  if (!version) throw new ConvexError("Version required");

  const resolved = await resolveSkillBySlugOrAlias(ctx, slug);
  const skill = resolved.skill;
  if (!skill) throw new ConvexError("Skill not found");

  await assertCanManageOwnedResource(ctx, {
    actor,
    ownerUserId: skill.ownerUserId,
    ownerPublisherId: skill.ownerPublisherId,
    allowedPublisherRoles: ["admin"],
  });

  const skillVersion = await ctx.db
    .query("skillVersions")
    .withIndex("by_skill_version", (q) => q.eq("skillId", skill._id).eq("version", version))
    .unique();
  if (!skillVersion) throw new ConvexError("Skill version not found");

  return await deleteOwnedSkillVersionForActor(ctx, actor, { versionId: skillVersion._id });
}

export const deleteOwnedVersionForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    slug: v.string(),
    version: v.string(),
  },
  handler: async (ctx, args) => {
    return await deleteOwnedSkillVersionForUser(ctx, args);
  },
});

function isSkillVersionRestorableByOwner(
  version: Doc<"skillVersions"> | null | undefined,
  skillId: Id<"skills">,
  actorUserId: Id<"users">,
): version is Doc<"skillVersions"> {
  return Boolean(
    version &&
    version.skillId === skillId &&
    version.softDeletedAt !== undefined &&
    version.ownerDeletedAt !== undefined &&
    version.softDeletedAt === version.ownerDeletedAt &&
    version.ownerDeletedBy === actorUserId &&
    !version.manualRevocation &&
    !isKnownMaliciousSkillVersion(version),
  );
}

export async function restoreOwnedSkillVersionForActor(
  ctx: MutationCtx,
  actor: Doc<"users">,
  args: { versionId: Id<"skillVersions"> },
) {
  const version = await ctx.db.get(args.versionId);
  if (!version) throw new ConvexError("Forbidden");

  const skill = await ctx.db.get(version.skillId);
  if (!skill) throw new ConvexError("Forbidden");

  await assertCanManageOwnedResource(ctx, {
    actor,
    ownerUserId: skill.ownerUserId,
    ownerPublisherId: skill.ownerPublisherId,
    allowedPublisherRoles: ["admin"],
  });

  if (skill.softDeletedAt || (skill.moderationStatus ?? "active") !== "active") {
    throw new ConvexError("This skill is unavailable and its versions cannot be restored.");
  }
  if (!isSkillVersionRestorableByOwner(version, skill._id, actor._id)) {
    throw new ConvexError(
      "This skill version was not withdrawn by this owner and cannot be restored.",
    );
  }

  const now = Date.now();
  await ctx.db.patch(version._id, {
    softDeletedAt: undefined,
    ownerDeletedAt: undefined,
    ownerDeletedBy: undefined,
  });
  await ctx.db.insert("auditLogs", {
    actorUserId: actor._id,
    action: "skill.version.restore",
    targetType: "skillVersion",
    targetId: version._id,
    metadata: {
      skillId: skill._id,
      slug: skill.slug,
      version: version.version,
    },
    createdAt: now,
  });

  return { ok: true as const, skillId: skill._id, versionId: version._id };
}

export async function restoreOwnedSkillVersionForUser(
  ctx: MutationCtx,
  args: {
    actorUserId: Id<"users">;
    slug: string;
    version: string;
    ownerHandle?: string;
  },
) {
  const actor = await ctx.db.get(args.actorUserId);
  if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");

  const slug = args.slug.trim().toLowerCase();
  if (!slug) throw new ConvexError("Slug required");
  const version = args.version.trim();
  if (!version) throw new ConvexError("Version required");
  const ownerHandle = args.ownerHandle?.trim().replace(/^@+/, "") || undefined;

  const resolved = await resolveSkillBySlugOrAliasForOwner(ctx, slug, ownerHandle);
  const skill = resolved.skill;
  if (!skill) throw new ConvexError("Skill not found");

  await assertCanManageOwnedResource(ctx, {
    actor,
    ownerUserId: skill.ownerUserId,
    ownerPublisherId: skill.ownerPublisherId,
    allowedPublisherRoles: ["admin"],
  });

  const skillVersion = await ctx.db
    .query("skillVersions")
    .withIndex("by_skill_version", (q) => q.eq("skillId", skill._id).eq("version", version))
    .unique();
  if (!skillVersion) throw new ConvexError("Skill version not found");

  return await restoreOwnedSkillVersionForActor(ctx, actor, { versionId: skillVersion._id });
}

export const restoreOwnedVersionForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    slug: v.string(),
    version: v.string(),
    ownerHandle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await restoreOwnedSkillVersionForUser(ctx, args);
  },
});

export const restoreOwnedVersion = mutation({
  args: { versionId: v.id("skillVersions") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    return await restoreOwnedSkillVersionForActor(ctx, user, args);
  },
});

export async function revokeSkillVersionForUser(
  ctx: MutationCtx,
  args: {
    actorUserId: Id<"users">;
    slug: string;
    version: string;
    reason: string;
    ownerHandle?: string;
  },
) {
  const actor = await ctx.db.get(args.actorUserId);
  if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
  assertModerator(actor);

  const slug = args.slug.trim().toLowerCase();
  if (!slug) throw new ConvexError("Slug required");
  const versionName = args.version.trim();
  if (!versionName) throw new ConvexError("Version required");
  const reason = trimModerationNote(args.reason);
  const ownerHandle = args.ownerHandle?.trim().replace(/^@+/, "") || undefined;

  const resolved = await resolveSkillBySlugOrAliasForOwner(ctx, slug, ownerHandle, {
    includeSoftDeleted: true,
  });
  if (resolved.ambiguous) {
    throw new ConvexError("Slug is used by multiple publishers. Pass an owner handle.");
  }
  const skill = resolved.skill;
  if (!skill) throw new ConvexError("Skill not found");

  const version = await ctx.db
    .query("skillVersions")
    .withIndex("by_skill_version", (q) => q.eq("skillId", skill._id).eq("version", versionName))
    .unique();
  if (!version) throw new ConvexError("Skill version not found");

  if (version.manualRevocation) {
    return {
      ok: true as const,
      slug: skill.slug,
      version: version.version,
      skillId: skill._id,
      versionId: version._id,
      alreadyRevoked: true,
      replacementVersion:
        skill.latestVersionId === version._id
          ? null
          : (skill.latestVersionSummary?.version ?? null),
      skillHidden: Boolean(skill.softDeletedAt),
    };
  }

  const isLatest =
    skill.latestVersionId === version._id ||
    skill.tags.latest === version._id ||
    skill.latestVersionSummary?.version === version.version;
  const replacement = isLatest
    ? await findReplacementLatestSkillVersion(ctx, skill._id, version._id)
    : null;
  const now = Date.now();
  const plan = buildSkillVersionRevocationPlan({
    actorUserId: actor._id,
    skill,
    target: version,
    replacement,
    reason,
    now,
  });

  if (replacement && !shouldPreserveExistingModerationLock(skill)) {
    const owner = skill.ownerUserId ? await ctx.db.get(skill.ownerUserId) : null;
    Object.assign(
      plan.skillPatch,
      buildScannerModerationPatchFromVersion({
        owner,
        version: replacement,
        now,
      }),
    );
  }

  await ctx.db.patch(version._id, plan.versionPatch);
  const nextSkill = { ...skill, ...plan.skillPatch };
  await ctx.db.patch(skill._id, plan.skillPatch);
  await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);
  await adjustUserSkillStatsForSkillChange(ctx, skill, nextSkill);

  if (plan.isLatest) {
    if (replacement) {
      await setSkillEmbeddingsLatestVersion(
        ctx,
        skill._id,
        replacement._id,
        now,
        Boolean(nextSkill.softDeletedAt),
      );
    } else {
      await clearSkillEmbeddingsLatestVersion(ctx, skill._id, now);
      await setSkillEmbeddingsSoftDeleted(ctx, skill._id, true, now);
    }
  }
  await syncSkillSearchDigestForSkillDoc(ctx, nextSkill);

  await ctx.db.insert("auditLogs", {
    actorUserId: actor._id,
    action: "skill.version.revoke",
    targetType: "skillVersion",
    targetId: version._id,
    metadata: {
      skillId: skill._id,
      slug: skill.slug,
      version: version.version,
      reason,
      replacementVersion: replacement?.version ?? null,
      skillHidden: Boolean(nextSkill.softDeletedAt),
    },
    createdAt: now,
  });

  return {
    ok: true as const,
    slug: skill.slug,
    version: version.version,
    skillId: skill._id,
    versionId: version._id,
    alreadyRevoked: false,
    replacementVersion: replacement?.version ?? null,
    skillHidden: Boolean(nextSkill.softDeletedAt),
  };
}

export const revokeSkillVersionForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    slug: v.string(),
    version: v.string(),
    reason: v.string(),
    ownerHandle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await revokeSkillVersionForUser(ctx, args);
  },
});

export const deleteOwnedVersion = mutation({
  args: { versionId: v.id("skillVersions") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    return await deleteOwnedSkillVersionForActor(ctx, user, args);
  },
});

export const publishVersion: ReturnType<typeof action> = action({
  args: {
    ownerHandle: v.optional(v.string()),
    sourceOwnerHandle: v.optional(v.string()),
    // Explicit opt-in from the client to migrate an existing skill's owner
    // when `ownerHandle` differs from the skill's current owner. Without this
    // flag, a mismatching Owner selector is treated as a slug collision so
    // re-publishes cannot silently transfer ownership.
    migrateOwner: v.optional(v.boolean()),
    slug: v.string(),
    displayName: v.string(),
    // Legacy cached clients may still send this; accept and ignore it.
    icon: v.optional(v.string()),
    version: v.string(),
    changelog: v.string(),
    acceptLicenseTerms: v.optional(v.boolean()),
    tags: v.optional(v.array(v.string())),
    categories: v.optional(v.array(v.string())),
    topics: v.optional(v.array(v.string())),
    summary: v.optional(v.string()),
    forkOf: v.optional(
      v.object({
        slug: v.string(),
        ownerHandle: v.optional(v.string()),
        version: v.optional(v.string()),
      }),
    ),
    files: v.array(
      v.object({
        path: v.string(),
        size: v.number(),
        storageId: v.id("_storage"),
        sha256: v.string(),
        contentType: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<SkillPublishResult> => {
    if (args.acceptLicenseTerms !== true) {
      throw new ConvexError("MIT-0 license terms must be accepted to publish skills");
    }
    const { userId, user } = await requireUserFromAction(ctx);
    const target = (await ctx.runMutation(internal.publishers.resolvePublishTargetForUserInternal, {
      actorUserId: userId,
      ownerHandle: args.ownerHandle,
      minimumRole: "publisher",
    })) as { publisherId: Id<"publishers">; handle: string };
    const sourceOwnerHandle =
      args.migrateOwner === true
        ? args.sourceOwnerHandle?.trim() || user.handle?.trim() || undefined
        : undefined;
    const source =
      sourceOwnerHandle && sourceOwnerHandle !== args.ownerHandle
        ? ((await ctx.runMutation(internal.publishers.resolvePublishTargetForUserInternal, {
            actorUserId: userId,
            ownerHandle: sourceOwnerHandle,
            minimumRole: "publisher",
          })) as { publisherId: Id<"publishers"> })
        : null;
    const { icon: _legacyIcon, ...publishArgs } = args;
    return stageSkillPublishAttemptForUser(ctx, userId, publishArgs, {
      ownerPublisherId: target.publisherId,
      ownerHandle: target.handle,
      sourceOwnerPublisherId: source?.publisherId,
      migrateOwner: args.migrateOwner,
      stagePrePublicationChecks: stagedPrePublicationPublishesEnabled(),
    });
  },
});

function stagedPrePublicationPublishesEnabled() {
  return process.env.CLAWHUB_STAGED_PREPUBLICATION_PUBLISHES === "1";
}

export const generateChangelogPreview = action({
  args: {
    slug: v.string(),
    version: v.string(),
    readmeText: v.string(),
    filePaths: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await requireUserFromAction(ctx);
    const changelog = await buildChangelogPreview(ctx, {
      slug: args.slug.trim().toLowerCase(),
      version: args.version.trim(),
      readmeText: args.readmeText,
      filePaths: args.filePaths?.map((value) => value.trim()).filter(Boolean),
    });
    return { changelog, source: "auto" as const };
  },
});

async function canReadSkillVersionFiles(ctx: ActionCtx, version: Doc<"skillVersions">) {
  const skill = (await ctx.runQuery(internal.skills.getSkillByIdInternal, {
    skillId: version.skillId,
  })) as Doc<"skills"> | null;
  if (!skill) return false;

  const authUserId = await getOptionalActiveAuthUserIdFromAction(ctx);
  if (authUserId) {
    if (isDirectSkillOwner(skill, authUserId) && !skill.softDeletedAt && !version.softDeletedAt) {
      return true;
    }
    if (skill.ownerPublisherId && !skill.softDeletedAt && !version.softDeletedAt) {
      const canAccessOwnerScope = (await ctx.runQuery(
        internal.publishers.canAccessOwnerScopeInternal,
        {
          publisherId: skill.ownerPublisherId,
          userId: authUserId,
          allowedPublisherRoles: ["publisher"],
          legacyOwnerUserId: skill.ownerUserId,
        },
      )) as boolean;
      if (canAccessOwnerScope) {
        return true;
      }
    }
    const actor = (await ctx.runQuery(internal.users.getByIdInternal, {
      userId: authUserId,
    })) as Doc<"users"> | null;
    if (actor?.role === "admin" || actor?.role === "moderator") return true;
  }

  if (skill.softDeletedAt || version.softDeletedAt) return false;

  return Boolean(toPublicSkill(skill)) && isPublicSkillVersionAvailableForSkill(version, skill._id);
}

async function canReadGitHubSkillContent(ctx: QueryCtx, skill: Doc<"skills">) {
  const authUserId = await getOptionalActiveAuthUserId(ctx);
  if (authUserId) {
    if (isDirectSkillOwner(skill, authUserId) && !skill.softDeletedAt) return true;
    if (skill.ownerPublisherId && !skill.softDeletedAt) {
      const canAccessOwnerScope = await canAccessPublisherOwnerScope(ctx, {
        publisher: await ctx.db.get(skill.ownerPublisherId),
        userId: authUserId,
        legacyOwnerUserId: skill.ownerUserId,
      });
      if (canAccessOwnerScope) return true;
    }
    const actor = await ctx.db.get(authUserId);
    if (actor?.role === "admin" || actor?.role === "moderator") return true;
  }

  if (skill.softDeletedAt) return false;
  return Boolean(toPublicSkill(skill));
}

export const getGitHubSkillContent = query({
  args: {
    skillId: v.id("skills"),
    kind: v.union(v.literal("readme"), v.literal("skill-card")),
  },
  handler: async (ctx, args): Promise<ReadmeResult | null> => {
    const skill = await ctx.db.get(args.skillId);
    if (!skill || skill.installKind !== "github") return null;
    if (skill.githubCurrentStatus !== "present") return null;
    if (!(await canReadGitHubSkillContent(ctx, skill))) return null;

    const content = await ctx.db
      .query("githubSkillContents")
      .withIndex("by_skill", (q) => q.eq("skillId", args.skillId))
      .unique();
    if (!content) return null;
    if (content.githubContentHash !== skill.githubCurrentContentHash) return null;

    const source = await ctx.db.get(content.githubSourceId);
    const resultSource = source
      ? buildGitHubMarkdownSourceBaseUrl(
          skill.githubCurrentRepo ?? source.repo,
          content.githubCommit,
          content.githubPath,
        )
      : undefined;

    if (args.kind === "skill-card") {
      if (!content.skillCardMarkdown || !content.skillCardMarkdownPath) return null;
      return {
        path: content.skillCardMarkdownPath,
        text: content.skillCardMarkdown,
        ...(resultSource ? { sourceBaseUrl: resultSource } : {}),
      };
    }

    return {
      path: content.skillMarkdownPath,
      text: content.skillMarkdown,
      ...(resultSource ? { sourceBaseUrl: resultSource } : {}),
    };
  },
});

function buildGitHubMarkdownSourceBaseUrl(repo: string, commit: string, githubPath: string) {
  if (!repo || !commit) return undefined;
  const encodedRepo = repo
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const normalizedPath = githubPath.replace(/^\/+|\/+$/g, "");
  const encodedPath = normalizedPath
    ? `/${normalizedPath
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/")}`
    : "";
  return `https://github.com/${encodedRepo}/blob/${encodeURIComponent(commit)}${encodedPath}`;
}

export const getReadme: ReturnType<typeof action> = action({
  args: { versionId: v.id("skillVersions") },
  handler: async (ctx, args): Promise<ReadmeResult> => {
    const version = (await ctx.runQuery(internal.skills.getVersionByIdInternal, {
      versionId: args.versionId,
    })) as Doc<"skillVersions"> | null;
    if (!version) throw new ConvexError("Version not found");
    if (!(await canReadSkillVersionFiles(ctx, version))) {
      throw new ConvexError("Version not available");
    }
    const readmeFile = version.files.find(
      (file) => file.path.toLowerCase() === "skill.md" || file.path.toLowerCase() === "skills.md",
    );
    if (!readmeFile) throw new ConvexError("SKILL.md not found");
    const text = await fetchText(ctx, readmeFile.storageId);
    return { path: readmeFile.path, text };
  },
});

export const getSkillCard: ReturnType<typeof action> = action({
  args: { versionId: v.id("skillVersions") },
  handler: async (ctx, args): Promise<FileTextResult> => {
    const version = (await ctx.runQuery(internal.skills.getVersionByIdInternal, {
      versionId: args.versionId,
    })) as Doc<"skillVersions"> | null;
    if (!version) throw new ConvexError("Version not found");
    if (!(await canReadSkillVersionFiles(ctx, version))) {
      throw new ConvexError("Version not available");
    }

    const fingerprintEntries = (await ctx.runQuery(
      internal.skills.listVersionFingerprintsInternal,
      {
        skillVersionId: version._id,
      },
    )) as Array<{ fingerprint: string; kind?: "source" | "generated-bundle" }>;
    const file = await selectGeneratedSkillCardFile(
      version.files,
      fingerprintEntries
        .filter((entry) => entry.kind === "generated-bundle")
        .map((entry) => entry.fingerprint),
    );
    if (!file) throw new ConvexError("Skill Card not found");
    if (file.size > MAX_DIFF_FILE_BYTES) {
      throw new ConvexError("File exceeds 200KB limit");
    }

    const text = await fetchText(ctx, file.storageId);
    return { path: file.path, text, size: file.size, sha256: file.sha256 };
  },
});

export const getFileText: ReturnType<typeof action> = action({
  args: { versionId: v.id("skillVersions"), path: v.string() },
  handler: async (ctx, args): Promise<FileTextResult> => {
    const version = (await ctx.runQuery(internal.skills.getVersionByIdInternal, {
      versionId: args.versionId,
    })) as Doc<"skillVersions"> | null;
    if (!version) throw new ConvexError("Version not found");
    if (!(await canReadSkillVersionFiles(ctx, version))) {
      throw new ConvexError("Version not available");
    }

    const normalizedPath = args.path.trim();
    const normalizedLower = normalizedPath.toLowerCase();
    const file =
      version.files.find((entry) => entry.path === normalizedPath) ??
      version.files.find((entry) => entry.path.toLowerCase() === normalizedLower);
    if (!file) throw new ConvexError("File not found");
    if (file.size > MAX_DIFF_FILE_BYTES) {
      throw new ConvexError("File exceeds 200KB limit");
    }

    const text = await fetchText(ctx, file.storageId);
    return { path: file.path, text, size: file.size, sha256: file.sha256 };
  },
});

export const getFilePreview: ReturnType<typeof action> = action({
  args: { versionId: v.id("skillVersions"), path: v.string() },
  handler: async (ctx, args): Promise<FilePreviewResult> => {
    const version = (await ctx.runQuery(internal.skills.getVersionByIdInternal, {
      versionId: args.versionId,
    })) as Doc<"skillVersions"> | null;
    if (!version) throw new ConvexError("Version not found");
    if (!(await canReadSkillVersionFiles(ctx, version))) {
      throw new ConvexError("Version not available");
    }

    const normalizedPath = args.path.trim();
    const normalizedLower = normalizedPath.toLowerCase();
    const file =
      version.files.find((entry) => entry.path === normalizedPath) ??
      version.files.find((entry) => entry.path.toLowerCase() === normalizedLower);
    if (!file) throw new ConvexError("File not found");

    if (file.size > MAX_DIFF_FILE_BYTES) {
      return {
        path: file.path,
        text: null,
        size: file.size,
        sha256: file.sha256,
      };
    }

    const blob = await ctx.storage.get(file.storageId);
    if (!blob) throw new ConvexError("File missing in storage");
    const text = decodeUtf8Text(new Uint8Array(await blob.arrayBuffer()));
    return { path: file.path, text, size: file.size, sha256: file.sha256 };
  },
});

export const resolveVersionByHash = query({
  args: { slug: v.string(), hash: v.string(), ownerHandle: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const slug = args.slug.trim().toLowerCase();
    const hash = args.hash.trim().toLowerCase();
    if (!slug || !/^[a-f0-9]{64}$/.test(hash)) return null;

    const resolved = args.ownerHandle
      ? await resolveSkillBySlugOrAliasForOwner(ctx, slug, args.ownerHandle)
      : await resolveSkillBySlugOrAlias(ctx, slug);
    if (resolved.ambiguous) {
      return {
        match: null,
        latestVersion: null,
        ambiguous: true as const,
        ambiguousMatches: resolved.ambiguousMatches,
      };
    }
    const skill = resolved.skill;
    if (!skill) return null;

    const latestVersionDoc = skill.latestVersionId ? await ctx.db.get(skill.latestVersionId) : null;
    const latestVersion = isPublicSkillVersionAvailableForSkill(latestVersionDoc, skill._id)
      ? latestVersionDoc
      : null;

    const fingerprintMatches = await ctx.db
      .query("skillVersionFingerprints")
      .withIndex("by_skill_fingerprint", (q) => q.eq("skillId", skill._id).eq("fingerprint", hash))
      .take(25);

    let match: { version: string } | null = null;
    if (fingerprintMatches.length > 0) {
      const newest = fingerprintMatches.reduce(
        (best, entry) => (entry.createdAt > best.createdAt ? entry : best),
        fingerprintMatches[0] as (typeof fingerprintMatches)[number],
      );
      const version = await ctx.db.get(newest.versionId);
      if (version && !version.softDeletedAt) {
        match = { version: version.version };
      }
    }

    if (!match) {
      const versions = await ctx.db
        .query("skillVersions")
        .withIndex("by_skill", (q) => q.eq("skillId", skill._id))
        .order("desc")
        .take(200);

      for (const version of versions) {
        if (version.softDeletedAt) continue;
        if (typeof version.fingerprint === "string" && version.fingerprint === hash) {
          match = { version: version.version };
          break;
        }

        const fingerprint = await hashSkillFiles(
          version.files.map((file) => ({
            path: file.path,
            sha256: file.sha256,
          })),
        );
        if (fingerprint === hash) {
          match = { version: version.version };
          break;
        }
      }
    }

    return {
      match,
      latestVersion: latestVersion ? { version: latestVersion.version } : null,
    };
  },
});

async function updateSkillTagsForActor(
  ctx: MutationCtx,
  actor: Doc<"users">,
  skill: Doc<"skills">,
  tags: Array<{ tag: string; versionId: Id<"skillVersions"> }>,
) {
  if (actor.role !== "admin" && actor.role !== "moderator") {
    await assertCanManageOwnedResource(ctx, {
      actor,
      ownerUserId: skill.ownerUserId,
      ownerPublisherId: skill.ownerPublisherId,
      allowedPublisherRoles: ["admin"],
    });
  }

  const versionsById = new Map<Id<"skillVersions">, Doc<"skillVersions">>();
  for (const entry of tags) {
    let version = versionsById.get(entry.versionId) ?? null;
    if (!version) {
      version = await ctx.db.get(entry.versionId);
      if (version) versionsById.set(entry.versionId, version);
    }
    if (!isPublicSkillVersionAvailableForSkill(version, skill._id)) {
      throw new Error("Version not found");
    }
  }

  const nextTags = { ...skill.tags };
  for (const entry of tags) {
    nextTags[entry.tag] = entry.versionId;
  }

  const changedTags = tags.filter((entry) => skill.tags[entry.tag] !== entry.versionId);
  if (changedTags.length === 0) return { ok: true as const, skillId: skill._id };

  let latestEntry: (typeof tags)[number] | undefined;
  for (const entry of tags) {
    if (entry.tag === "latest") latestEntry = entry;
  }
  const now = Date.now();
  const patch: Partial<Doc<"skills">> = {
    tags: nextTags,
    latestVersionId: latestEntry ? latestEntry.versionId : skill.latestVersionId,
    updatedAt: now,
  };

  // Keep latestVersionSummary in sync when the latest tag is repointed.
  if (latestEntry && latestEntry.versionId !== skill.latestVersionId) {
    const version = versionsById.get(latestEntry.versionId)!;
    patch.latestVersionSummary = {
      version: version.version,
      createdAt: version.createdAt,
      changelog: version.changelog,
      changelogSource: version.changelogSource,
      description: skillSummaryFromSkillVersion(version),
      clawdis: version.parsed?.clawdis,
    };
  }

  await ctx.db.patch(skill._id, patch);

  if (
    latestEntry &&
    latestEntry.versionId !== skill.latestVersionId &&
    shouldSyncModerationFromLatestVersion(skill)
  ) {
    await syncSkillModerationFromLatestVersion(
      ctx,
      { ...skill, latestVersionId: latestEntry.versionId },
      now,
    );
  }

  if (latestEntry) {
    await setSkillEmbeddingsLatestVersion(ctx, skill._id, latestEntry.versionId, now);
  }

  await ctx.db.insert("auditLogs", {
    actorUserId: actor._id,
    action: "skill.tags.update",
    targetType: "skill",
    targetId: skill._id,
    metadata: {
      slug: skill.slug,
      previous: Object.fromEntries(
        changedTags.map((entry) => [entry.tag, skill.tags[entry.tag] ?? null]),
      ),
      next: Object.fromEntries(changedTags.map((entry) => [entry.tag, entry.versionId])),
    },
    createdAt: now,
  });

  return { ok: true as const, skillId: skill._id };
}

export const updateTags = mutation({
  args: {
    skillId: v.id("skills"),
    tags: v.array(v.object({ tag: v.string(), versionId: v.id("skillVersions") })),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");
    return await updateSkillTagsForActor(ctx, user, skill, args.tags);
  },
});

export const setSkillTagForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    slug: v.string(),
    tag: v.string(),
    version: v.string(),
    ownerHandle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");

    const slug = args.slug.trim().toLowerCase();
    if (!slug) throw new ConvexError("Slug required");
    const requestedTag = args.tag.trim();
    const normalizedTag =
      requestedTag.toLowerCase() === "latest"
        ? "latest"
        : (normalizeSkillTags([requestedTag])?.[0] ?? "");
    if (!normalizedTag) throw new ConvexError("Valid tag required");
    const versionName = args.version.trim();
    if (!versionName) throw new ConvexError("Version required");
    const ownerHandle = args.ownerHandle?.trim().replace(/^@+/, "") || undefined;

    const resolved = await resolveSkillBySlugOrAliasForOwner(ctx, slug, ownerHandle);
    if (resolved.ambiguous) {
      throw new ConvexError("Slug is used by multiple publishers. Pass an owner handle.");
    }
    const skill = resolved.skill;
    if (!skill) throw new ConvexError("Skill not found");

    const version = await ctx.db
      .query("skillVersions")
      .withIndex("by_skill_version", (q) => q.eq("skillId", skill._id).eq("version", versionName))
      .unique();
    if (!version) throw new ConvexError("Skill version not found");

    await updateSkillTagsForActor(ctx, actor, skill, [
      { tag: normalizedTag, versionId: version._id },
    ]);
    return {
      ok: true as const,
      slug: skill.slug,
      tag: normalizedTag,
      version: version.version,
    };
  },
});

export const deleteTags = mutation({
  args: {
    skillId: v.id("skills"),
    tags: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");
    if (user.role !== "admin" && user.role !== "moderator") {
      await assertCanManageOwnedResource(ctx, {
        actor: user,
        ownerUserId: skill.ownerUserId,
        ownerPublisherId: skill.ownerPublisherId,
        allowedPublisherRoles: ["admin"],
      });
    }

    const nextTags = { ...skill.tags };
    let changed = false;
    for (const tag of args.tags) {
      if (tag === "latest") continue;
      if (tag in nextTags) {
        delete nextTags[tag];
        changed = true;
      }
    }

    if (!changed) return;

    await ctx.db.patch(skill._id, {
      tags: nextTags,
      updatedAt: Date.now(),
    });
  },
});

export const updateSummary = mutation({
  args: {
    skillId: v.id("skills"),
    summary: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");
    if (user.role !== "admin" && user.role !== "moderator") {
      await assertCanManageOwnedResource(ctx, {
        actor: user,
        ownerUserId: skill.ownerUserId,
        ownerPublisherId: skill.ownerPublisherId,
        allowedPublisherRoles: ["admin"],
      });
    }
    const summary = args.summary.trim();
    if (summary.length > MAX_OWNER_SUMMARY_LENGTH) {
      throw new ConvexError(`Summary must be ${MAX_OWNER_SUMMARY_LENGTH} characters or less`);
    }

    const now = Date.now();
    const patch: Partial<Doc<"skills">> = {
      summary,
      updatedAt: now,
    };

    await ctx.db.patch(skill._id, patch);
  },
});

export const setCatalogMetadata = mutation({
  args: {
    skillId: v.id("skills"),
    categories: v.optional(v.array(v.string())),
    topics: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new ConvexError("Skill not found");
    if (user.role !== "admin" && user.role !== "moderator") {
      await assertCanManageOwnedResource(ctx, {
        actor: user,
        ownerUserId: skill.ownerUserId,
        ownerPublisherId: skill.ownerPublisherId,
        allowedPublisherRoles: ["admin"],
      });
    }

    let categories: string[];
    let topics: string[];
    try {
      categories = resolveSkillCategories({ declared: args.categories });
      topics = normalizeCatalogTopics(args.topics);
    } catch (error) {
      throw new ConvexError(error instanceof Error ? error.message : "Invalid catalog metadata");
    }

    const now = Date.now();
    const nextSkill = {
      ...skill,
      categories,
      topics: topics.length ? topics : undefined,
      inferredCategories: undefined,
      inferredTopics: undefined,
      inferredFromVersionId: undefined,
      inferredCategoryConfidence: undefined,
      inferredTopicConfidence: undefined,
      inferredClassifierVersion: undefined,
      inferredTopicClassifierVersion: undefined,
      inferredInputHash: undefined,
      inferredTopicInputHash: undefined,
      inferredAt: undefined,
      updatedAt: now,
    };
    await ctx.db.patch(skill._id, {
      categories: nextSkill.categories,
      topics: nextSkill.topics,
      inferredCategories: nextSkill.inferredCategories,
      inferredTopics: nextSkill.inferredTopics,
      inferredFromVersionId: nextSkill.inferredFromVersionId,
      inferredCategoryConfidence: nextSkill.inferredCategoryConfidence,
      inferredTopicConfidence: nextSkill.inferredTopicConfidence,
      inferredClassifierVersion: nextSkill.inferredClassifierVersion,
      inferredTopicClassifierVersion: nextSkill.inferredTopicClassifierVersion,
      inferredInputHash: nextSkill.inferredInputHash,
      inferredTopicInputHash: nextSkill.inferredTopicInputHash,
      inferredAt: nextSkill.inferredAt,
      updatedAt: now,
    });
    await syncSkillSearchDigestForSkillDoc(ctx, nextSkill);
    await ctx.db.insert("auditLogs", {
      actorUserId: user._id,
      action: "skill.catalog_metadata.set",
      targetType: "skill",
      targetId: skill._id,
      metadata: {
        previous: { categories: skill.categories, topics: skill.topics },
        next: { categories: nextSkill.categories, topics: nextSkill.topics },
      },
      createdAt: now,
    });
  },
});

export const setRedactionApproved = mutation({
  args: { skillId: v.id("skills"), approved: v.boolean() },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    assertAdmin(user);

    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");

    const now = Date.now();
    if (args.approved) {
      await upsertSkillBadge(ctx, skill._id, "redactionApproved", user._id, now);
    } else {
      await removeSkillBadge(ctx, skill._id, "redactionApproved");
    }

    await ctx.db.patch(skill._id, {
      lastReviewedAt: now,
      updatedAt: now,
    });

    await setSkillEmbeddingsApproved(ctx, skill._id, args.approved, now);

    await ctx.db.insert("auditLogs", {
      actorUserId: user._id,
      action: args.approved ? "badge.set" : "badge.unset",
      targetType: "skill",
      targetId: skill._id,
      metadata: { badge: "redactionApproved", approved: args.approved },
      createdAt: now,
    });
  },
});

export const setBatch = mutation({
  args: { skillId: v.id("skills"), batch: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    assertModerator(user);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");
    const nextBatch = args.batch?.trim() || undefined;
    await setSkillFeaturedForActor(ctx, user, skill, nextBatch);
  },
});

async function setSkillFeaturedForActor(
  ctx: MutationCtx,
  actor: Doc<"users">,
  skill: Doc<"skills">,
  nextBatch: string | undefined,
) {
  const existingBadges = await getSkillBadgeMap(ctx, skill._id);
  const previousHighlighted = isSkillHighlighted({ badges: existingBadges });
  const featured = nextBatch === "highlighted";
  const now = Date.now();

  if (featured) {
    await upsertSkillBadge(ctx, skill._id, "highlighted", actor._id, now);
  } else {
    await removeSkillBadge(ctx, skill._id, "highlighted");
  }

  await ctx.db.patch(skill._id, {
    batch: nextBatch,
    updatedAt: now,
  });
  await ctx.db.insert("auditLogs", {
    actorUserId: actor._id,
    action: "badge.highlighted",
    targetType: "skill",
    targetId: skill._id,
    metadata: { highlighted: featured },
    createdAt: now,
  });

  if (featured && !previousHighlighted) {
    void queueHighlightedWebhook(ctx, skill._id);
  }

  return { ok: true as const, featured, skillId: skill._id, slug: skill.slug };
}

export const setSkillFeaturedForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    slug: v.string(),
    ownerHandle: v.optional(v.string()),
    featured: v.boolean(),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
    assertModerator(actor);

    const resolved = await resolveSkillBySlugOrAliasForOwner(ctx, args.slug, args.ownerHandle);
    if (resolved.ambiguous) {
      throw new ConvexError(
        "Slug is used by multiple publishers. Use an owner-qualified skill URL.",
      );
    }
    const skill = resolved.skill;
    if (!skill || skill.softDeletedAt || skill.moderationStatus === "removed") {
      throw new ConvexError("Skill not found");
    }

    const result = await setSkillFeaturedForActor(
      ctx,
      actor,
      skill,
      args.featured ? "highlighted" : undefined,
    );
    return { ...result, ownerHandle: args.ownerHandle ?? null };
  },
});

export const setSoftDeleted = mutation({
  args: {
    skillId: v.id("skills"),
    deleted: v.boolean(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    assertModerator(user);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");

    const now = Date.now();
    const note = args.reason ? trimModerationNote(args.reason) : undefined;
    if (!note) {
      throw new ConvexError(
        args.deleted ? "Hide reason is required." : "Restore reason is required.",
      );
    }
    const patch: Partial<Doc<"skills">> = {
      softDeletedAt: args.deleted ? now : undefined,
      moderationStatus: args.deleted ? "hidden" : "active",
      moderationNotes: note,
      hiddenAt: args.deleted ? now : undefined,
      hiddenBy: args.deleted ? user._id : undefined,
      lastReviewedAt: now,
      updatedAt: now,
    };
    const nextSkill = { ...skill, ...patch };
    await ctx.db.patch(skill._id, patch);
    await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);
    await adjustUserSkillStatsForSkillChange(ctx, skill, nextSkill);

    await setSkillEmbeddingsSoftDeleted(ctx, skill._id, args.deleted, now);

    await ctx.db.insert("auditLogs", {
      actorUserId: user._id,
      action: args.deleted ? "skill.delete" : "skill.undelete",
      targetType: "skill",
      targetId: skill._id,
      metadata: {
        slug: skill.slug,
        softDeletedAt: args.deleted ? now : null,
        reason: note,
      },
      createdAt: now,
    });
  },
});

export const changeOwner = mutation({
  args: { skillId: v.id("skills"), ownerUserId: v.id("users") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    assertAdmin(user);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");

    const nextOwner = await ctx.db.get(args.ownerUserId);
    if (!nextOwner || nextOwner.deletedAt || nextOwner.deactivatedAt)
      throw new Error("User not found");

    if (skill.ownerUserId === args.ownerUserId) return;

    const now = Date.now();
    await transferSkillOwnershipAndEmbeddings(ctx, {
      skill,
      ownerUserId: args.ownerUserId,
      now,
    });

    await ctx.db.insert("auditLogs", {
      actorUserId: user._id,
      action: "skill.owner.change",
      targetType: "skill",
      targetId: skill._id,
      metadata: { from: skill.ownerUserId, to: args.ownerUserId },
      createdAt: now,
    });
  },
});

export const renameOwnedSkill = mutation({
  args: {
    slug: v.string(),
    newSlug: v.string(),
    ownerHandle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    return renameOwnedSkillByActor(ctx, user._id, args.slug, args.newSlug, args.ownerHandle);
  },
});

export const mergeOwnedSkillIntoCanonical = mutation({
  args: {
    sourceSlug: v.string(),
    targetSlug: v.string(),
    sourceOwnerHandle: v.optional(v.string()),
    targetOwnerHandle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    return mergeOwnedSkillIntoCanonicalByActor(
      ctx,
      user._id,
      args.sourceSlug,
      args.targetSlug,
      args.sourceOwnerHandle,
      args.targetOwnerHandle,
    );
  },
});

export const setOwnedSkillSoftDeleted = mutation({
  args: {
    skillId: v.id("skills"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new ConvexError("Skill not found");
    await assertCanManageOwnedResource(ctx, {
      actor: user,
      ownerUserId: skill.ownerUserId,
      ownerPublisherId: skill.ownerPublisherId,
      allowedPublisherRoles: ["admin"],
    });
    return setSkillSoftDeletedByActor(ctx, {
      userId: user._id,
      skillId: skill._id,
      deleted: true,
    });
  },
});

export const renameOwnedSkillInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    slug: v.string(),
    newSlug: v.string(),
    ownerHandle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return renameOwnedSkillByActor(
      ctx,
      args.actorUserId,
      args.slug,
      args.newSlug,
      args.ownerHandle,
    );
  },
});

export const mergeOwnedSkillIntoCanonicalInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    sourceSlug: v.string(),
    targetSlug: v.string(),
    sourceOwnerHandle: v.optional(v.string()),
    targetOwnerHandle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return mergeOwnedSkillIntoCanonicalByActor(
      ctx,
      args.actorUserId,
      args.sourceSlug,
      args.targetSlug,
      args.sourceOwnerHandle,
      args.targetOwnerHandle,
    );
  },
});

export const mergeSamePublisherDuplicateSkillByIdInternal = internalMutation({
  args: {
    sourceSkillId: v.id("skills"),
    targetSkillId: v.id("skills"),
    expectedSlug: v.string(),
    expectedSourceVersionId: v.id("skillVersions"),
    expectedTargetVersionId: v.id("skillVersions"),
    expectedTargetVersion: v.string(),
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceSkillId);
    const target = await ctx.db.get(args.targetSkillId);
    if (!source || !target) throw new ConvexError("Duplicate repair skill not found");
    if (
      source.softDeletedAt &&
      source.canonicalSkillId === target._id &&
      source.forkOf?.skillId === target._id
    ) {
      return { ok: true as const, alreadyMerged: true as const };
    }
    if (source.softDeletedAt || target.softDeletedAt) {
      throw new ConvexError("Duplicate repair requires two active skills");
    }
    if (
      !source.ownerPublisherId ||
      source.ownerPublisherId !== target.ownerPublisherId ||
      source.slug !== target.slug ||
      source.slug !== args.expectedSlug
    ) {
      throw new ConvexError("Duplicate repair invariant changed before apply");
    }
    if (
      source.latestVersionId !== args.expectedSourceVersionId ||
      target.latestVersionId !== args.expectedTargetVersionId
    ) {
      throw new ConvexError("Duplicate repair lineage changed before apply");
    }
    const targetVersion = target.latestVersionId ? await ctx.db.get(target.latestVersionId) : null;
    if (targetVersion?.version !== args.expectedTargetVersion) {
      throw new ConvexError("Duplicate repair target version changed before apply");
    }

    const result = await mergeOwnedSkillIntoCanonicalByActor(
      ctx,
      target.ownerUserId,
      source.slug,
      target.slug,
      undefined,
      undefined,
      { sourceSkillId: source._id, targetSkillId: target._id },
    );
    return { ...result, alreadyMerged: false as const };
  },
});

async function canManageSkillOwnerForActor(
  ctx: QueryCtx | MutationCtx,
  actor: Doc<"users">,
  skill: Pick<Doc<"skills">, "ownerUserId" | "ownerPublisherId">,
) {
  try {
    await assertCanManageOwnedResource(ctx, {
      actor,
      ownerUserId: skill.ownerUserId,
      ownerPublisherId: skill.ownerPublisherId,
      allowedPublisherRoles: ["admin"],
      allowPlatformAdmin: true,
    });
    return true;
  } catch (error) {
    if (error instanceof ConvexError || error instanceof Error) return false;
    throw error;
  }
}

async function renameOwnedSkillByActor(
  ctx: MutationCtx,
  actorUserId: Id<"users">,
  sourceSlugArg: string,
  newSlugArg: string,
  ownerHandle?: string,
) {
  const user = await ctx.db.get(actorUserId);
  if (!user || user.deletedAt || user.deactivatedAt) {
    throw new ConvexError("Forbidden");
  }

  const now = Date.now();
  const sourceSlug = normalizeSkillSlug(sourceSlugArg);
  if (!sourceSlug) throw new ConvexError("Current slug required");
  // Full write-path validation for the new slug: length, pattern,
  // reserved-word blocklist, no consecutive hyphens.
  const newSlug = assertValidSkillSlug(newSlugArg);

  const resolved = await resolveSkillBySlugOrAliasForOwner(ctx, sourceSlug, ownerHandle);
  const skill = resolved.skill;
  if (!skill || skill.softDeletedAt) throw new ConvexError("Skill not found");
  await assertCanManageOwnedResource(ctx, {
    actor: user,
    ownerUserId: skill.ownerUserId,
    ownerPublisherId: skill.ownerPublisherId,
    allowedPublisherRoles: ["admin"],
    allowPlatformAdmin: true,
  });
  if (skill.slug === newSlug) {
    return { ok: true as const, slug: skill.slug, previousSlug: skill.slug };
  }

  const skillOwner = await getOwnerPublisher(ctx, {
    ownerPublisherId: skill.ownerPublisherId,
    ownerUserId: skill.ownerUserId,
  });
  if (!skillOwner) throw new ConvexError("Skill owner not found");
  const existingSkill = await getSkillBySlugForPublisher(ctx, newSlug, skillOwner);
  if (existingSkill && existingSkill._id !== skill._id) {
    const owner = await ctx.db.get(existingSkill.ownerUserId);
    const ownsExisting =
      existingSkill.ownerUserId === actorUserId ||
      (await canManageSkillOwnerForActor(ctx, user, existingSkill));
    if (ownsExisting) {
      throw new ConvexError("Slug already belongs to one of your skills. Use merge instead.");
    }
    throw new ConvexError(buildSlugTakenErrorMessage(existingSkill, owner));
  }

  const existingAlias = await getSkillSlugAliasBySlugForPublisher(ctx, newSlug, skillOwner);
  if (existingAlias && existingAlias.skillId !== skill._id) {
    const aliasSkill = await ctx.db.get(existingAlias.skillId);
    const owner = aliasSkill ? await ctx.db.get(aliasSkill.ownerUserId) : null;
    throw new ConvexError(
      aliasSkill
        ? buildAliasTakenErrorMessage(aliasSkill, owner)
        : "Slug redirects to an existing skill. Choose a different slug.",
    );
  }

  const reservation = await getLatestActiveReservedSlugForPublisher(ctx, newSlug, skillOwner);
  if (
    reservation &&
    reservation.expiresAt > now &&
    !canReleaseReservedSlugForPublisher(reservation, skillOwner, actorUserId)
  ) {
    throw new ConvexError(formatReservedSlugCooldownMessage(newSlug, reservation.expiresAt));
  }

  const previousAlias = await getSkillSlugAliasBySlugForPublisher(ctx, skill.slug, skillOwner);

  if (existingAlias && existingAlias.skillId === skill._id) {
    await ctx.db.delete(existingAlias._id);
  }

  await ctx.db.patch(skill._id, {
    slug: newSlug,
    updatedAt: now,
  });
  await releaseActiveReservedSlugsForPublisher(ctx, newSlug, skillOwner, now);

  if (previousAlias) {
    await ctx.db.patch(previousAlias._id, {
      skillId: skill._id,
      ownerUserId: skill.ownerUserId,
      ownerPublisherId: skill.ownerPublisherId,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("skillSlugAliases", {
      slug: skill.slug,
      skillId: skill._id,
      ownerUserId: skill.ownerUserId,
      ownerPublisherId: skill.ownerPublisherId,
      createdAt: now,
      updatedAt: now,
    });
  }

  await ctx.db.insert("auditLogs", {
    actorUserId,
    action: "skill.slug.rename",
    targetType: "skill",
    targetId: skill._id,
    metadata: {
      from: skill.slug,
      to: newSlug,
    },
    createdAt: now,
  });

  return { ok: true as const, slug: newSlug, previousSlug: skill.slug };
}

async function mergeOwnedSkillIntoCanonicalByActor(
  ctx: MutationCtx,
  actorUserId: Id<"users">,
  sourceSlugArg: string,
  targetSlugArg: string,
  sourceOwnerHandle?: string,
  targetOwnerHandle?: string,
  skillIds?: { sourceSkillId: Id<"skills">; targetSkillId: Id<"skills"> },
) {
  const user = await ctx.db.get(actorUserId);
  if (!user || user.deletedAt || user.deactivatedAt) {
    throw new ConvexError("Forbidden");
  }

  const now = Date.now();
  let source: Doc<"skills"> | null;
  let target: Doc<"skills"> | null;
  if (skillIds) {
    [source, target] = await Promise.all([
      ctx.db.get(skillIds.sourceSkillId),
      ctx.db.get(skillIds.targetSkillId),
    ]);
  } else {
    const sourceSlug = sourceSlugArg.trim().toLowerCase();
    const targetSlug = targetSlugArg.trim().toLowerCase();
    if (!sourceSlug || !targetSlug) {
      throw new ConvexError("Source slug and target slug are required");
    }
    const sourceOwnerKey = normalizePublisherHandle(sourceOwnerHandle);
    const targetOwnerKey = normalizePublisherHandle(targetOwnerHandle);
    if (sourceSlug === targetSlug && sourceOwnerKey === targetOwnerKey) {
      throw new ConvexError("Source and target must be different skills");
    }

    const [sourceResolved, targetResolved] = await Promise.all([
      resolveSkillBySlugOrAliasForOwner(ctx, sourceSlug, sourceOwnerHandle),
      resolveSkillBySlugOrAliasForOwner(ctx, targetSlug, targetOwnerHandle),
    ]);
    source = sourceResolved.skill;
    target = targetResolved.skill;
  }
  if (!source || source.softDeletedAt) throw new ConvexError("Source skill not found");
  if (!target || target.softDeletedAt) throw new ConvexError("Target skill not found");
  if (source._id === target._id) {
    throw new ConvexError("Source and target must be different skills");
  }
  await assertCanManageOwnedResource(ctx, {
    actor: user,
    ownerUserId: source.ownerUserId,
    ownerPublisherId: source.ownerPublisherId,
  });
  await assertCanManageOwnedResource(ctx, {
    actor: user,
    ownerUserId: target.ownerUserId,
    ownerPublisherId: target.ownerPublisherId,
  });

  const targetLatestVersion = target.latestVersionId
    ? await ctx.db.get(target.latestVersionId)
    : null;
  const targetLineageIds = [target.canonicalSkillId, target.forkOf?.skillId].filter(
    (skillId): skillId is Id<"skills"> => Boolean(skillId),
  );
  const targetReferencesSource = targetLineageIds.some((skillId) => skillId === source._id);
  const targetReferencesAnotherSkill = targetLineageIds.some((skillId) => skillId !== source._id);
  if (targetReferencesAnotherSkill) {
    throw new ConvexError(
      "Target skill must be canonical before merging. Merge into its canonical skill instead.",
    );
  }
  const targetCanonicalSkillId = target._id;

  const targetAliases = await listSkillSlugAliasesForMerge(ctx, target._id);
  const targetAliasSlugs = new Set(targetAliases.map((alias) => alias.slug));
  const aliases = await listSkillSlugAliasesForMerge(ctx, source._id);
  const targetPublisher = await getOwnerPublisher(ctx, {
    ownerPublisherId: target.ownerPublisherId,
    ownerUserId: target.ownerUserId,
  });
  if (!targetPublisher) throw new ConvexError("Target owner publisher not found");
  const sourceOwnerMatchesTargetOwner =
    source.ownerUserId === target.ownerUserId &&
    (source.ownerPublisherId ?? null) === (target.ownerPublisherId ?? null);
  const sourceAlias = source.ownerPublisherId
    ? await getSkillSlugAliasBySlugScoped(
        ctx,
        source.slug,
        source.ownerPublisherId,
        source.ownerUserId,
      )
    : await getSkillSlugAliasBySlug(ctx, source.slug);
  const addedSkillAliasSlugs = new Set<string>();
  const addedOwnerAliasSlugs = new Set<string>();

  for (const alias of aliases) {
    if (sourceOwnerMatchesTargetOwner && alias.slug === target.slug) continue;
    if (!targetAliasSlugs.has(alias.slug)) {
      addedSkillAliasSlugs.add(alias.slug);
    }
    if (!sameSkillSlugAliasOwner(alias, target.ownerUserId, target.ownerPublisherId)) {
      addedOwnerAliasSlugs.add(alias.slug);
    }
  }
  if (sourceAlias) {
    if (sourceAlias.skillId !== target._id && !targetAliasSlugs.has(source.slug)) {
      addedSkillAliasSlugs.add(source.slug);
    }
    if (!sameSkillSlugAliasOwner(sourceAlias, target.ownerUserId, target.ownerPublisherId)) {
      addedOwnerAliasSlugs.add(source.slug);
    }
  } else {
    const sharedOwnerSlug = sourceOwnerMatchesTargetOwner && source.slug === target.slug;
    if (!sharedOwnerSlug && !targetAliasSlugs.has(source.slug)) {
      addedSkillAliasSlugs.add(source.slug);
    }
    if (!sharedOwnerSlug) addedOwnerAliasSlugs.add(source.slug);
  }

  if (sourceOwnerMatchesTargetOwner) {
    const movedAliasSlugs = new Set([...addedSkillAliasSlugs, ...addedOwnerAliasSlugs]);
    for (const slug of movedAliasSlugs) {
      const existingSkill = await getSkillBySlugForPublisher(ctx, slug, targetPublisher);
      if (existingSkill && existingSkill._id !== source._id && existingSkill._id !== target._id) {
        throw new ConvexError(buildDestinationSkillExistsMessage(targetPublisher, slug));
      }

      const existingAlias = await getSkillSlugAliasBySlugForPublisher(ctx, slug, targetPublisher);
      if (
        existingAlias &&
        existingAlias.skillId !== source._id &&
        existingAlias.skillId !== target._id
      ) {
        throw new ConvexError(
          `Destination owner @${targetPublisher.handle} already has a redirect for skill "${slug}". Rename or merge before merging skills.`,
        );
      }
    }
  }

  const willInsertSourceAlias =
    !sourceAlias && (!sourceOwnerMatchesTargetOwner || source.slug !== target.slug);

  for (const alias of aliases) {
    if (sourceOwnerMatchesTargetOwner && alias.slug === target.slug) {
      await ctx.db.delete(alias._id);
      continue;
    }
    await ctx.db.patch(alias._id, {
      skillId: target._id,
      updatedAt: now,
    });
  }

  if (sourceAlias && source.slug === target.slug && sourceOwnerMatchesTargetOwner) {
    await ctx.db.delete(sourceAlias._id);
  } else if (sourceAlias) {
    await ctx.db.patch(sourceAlias._id, {
      skillId: target._id,
      updatedAt: now,
    });
  } else if (willInsertSourceAlias) {
    await ctx.db.insert("skillSlugAliases", {
      slug: source.slug,
      skillId: target._id,
      ownerUserId: source.ownerUserId,
      ownerPublisherId: source.ownerPublisherId,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (targetReferencesSource) {
    await ctx.db.patch(target._id, {
      canonicalSkillId: undefined,
      forkOf: undefined,
      updatedAt: now,
    });
  }

  await repointSkillRelationships(ctx, {
    fromSkillId: source._id,
    toSkillId: target._id,
    toCanonicalSkillId: targetCanonicalSkillId,
    skipSkillId: target._id,
    targetVersion: targetLatestVersion,
    now,
  });

  const patch: Partial<Doc<"skills">> = {
    canonicalSkillId: targetCanonicalSkillId,
    forkOf: {
      skillId: target._id,
      kind: "duplicate",
      version: targetLatestVersion?.version,
      at: now,
    },
    softDeletedAt: now,
    moderationStatus: "hidden",
    moderationReason: "owner.merged",
    hiddenAt: now,
    hiddenBy: actorUserId,
    lastReviewedAt: now,
    updatedAt: now,
  };
  const nextSkill = { ...source, ...patch };
  await ctx.db.patch(source._id, patch);
  await adjustGlobalPublicCountForSkillChange(ctx, source, nextSkill);
  await adjustUserSkillStatsForSkillChange(ctx, source, nextSkill);
  await setSkillEmbeddingsSoftDeleted(ctx, source._id, true, now);

  await ctx.db.insert("auditLogs", {
    actorUserId,
    action: "skill.merge",
    targetType: "skill",
    targetId: source._id,
    metadata: {
      from: source.slug,
      to: target.slug,
      targetSkillId: target._id,
    },
    createdAt: now,
  });

  return {
    ok: true as const,
    sourceSlug: source.slug,
    targetSlug: target.slug,
  };
}

async function transferSkillOwnershipAndEmbeddings(
  ctx: MutationCtx,
  params: {
    skill: Doc<"skills">;
    ownerUserId: Id<"users">;
    ownerPublisherId?: Id<"publishers"> | null;
    now: number;
    allowSoftDeleted?: boolean;
  },
) {
  const patch: Partial<Doc<"skills">> = {
    ownerUserId: params.ownerUserId,
    lastReviewedAt: params.now,
    updatedAt: params.now,
  };
  if ("ownerPublisherId" in params) {
    patch.ownerPublisherId = params.ownerPublisherId ?? undefined;
  }

  const ownerChanged = params.skill.ownerUserId !== params.ownerUserId;
  const publisherChanged =
    "ownerPublisherId" in params && params.skill.ownerPublisherId !== params.ownerPublisherId;
  if (!ownerChanged && !publisherChanged) return;
  if (
    isSkillTransferBlockedByModeration(params.skill) &&
    !(params.allowSoftDeleted && isSoftDeletedSkillEligibleForAdminTransfer(params.skill))
  ) {
    throw new ConvexError("Skill is not eligible for ownership transfer while under moderation");
  }

  await ctx.db.patch(params.skill._id, patch);

  if (ownerChanged) {
    const embeddings = await listSkillEmbeddingsForSkill(ctx, params.skill._id);
    for (const embedding of embeddings) {
      await ctx.db.patch(embedding._id, {
        ownerId: params.ownerUserId,
        updatedAt: params.now,
      });
    }
    await adjustUserSkillStatsForSkillChange(ctx, params.skill, {
      ...params.skill,
      ...patch,
    });
  }
}

async function syncSkillSearchDigestForSkillDoc(ctx: MutationCtx, skill: Doc<"skills">) {
  const owner = await getOwnerPublisher(ctx, {
    ownerPublisherId: skill.ownerPublisherId,
    ownerUserId: skill.ownerUserId,
  });
  await upsertSkillSearchDigest(ctx, {
    ...(await extractValidatedDigestFields(ctx, skill)),
    ownerHandle: owner?.handle ?? "",
    ownerKind: owner?.kind,
    ownerName: owner?.linkedUserId ? owner.handle : undefined,
    ownerDisplayName: owner?.displayName,
    ownerImage: owner?.image,
  });
}

async function canManagePublisherDestination(
  ctx: MutationCtx,
  actor: Doc<"users">,
  publisher: Doc<"publishers">,
) {
  // Platform-admin transfers are audited staff recovery/moderation operations,
  // so they may select any verified active destination without publisher membership.
  if (actor.role === "admin") return true;
  if (publisher.kind === "user") {
    return publisher.linkedUserId
      ? publisher.linkedUserId === actor._id
      : actor.personalPublisherId === publisher._id;
  }
  const membership = await getPublisherMembership(ctx, publisher._id, actor._id);
  return Boolean(membership && isPublisherRoleAllowed(membership.role, ["admin"]));
}

async function getDestinationSkillSlugAliasToReplace(
  ctx: MutationCtx,
  skill: Doc<"skills">,
  destinationPublisher: Doc<"publishers">,
) {
  const existingSkill = await getSkillBySlugForPublisher(ctx, skill.slug, destinationPublisher);
  if (existingSkill && existingSkill._id !== skill._id) {
    throw new ConvexError(buildDestinationSkillExistsMessage(destinationPublisher, skill.slug));
  }

  return getSkillSlugAliasBySlugForPublisher(ctx, skill.slug, destinationPublisher);
}

export const transferSkillOwnerForUserInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    slug: v.string(),
    ownerHandle: v.optional(v.string()),
    toOwner: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");

    const slug = normalizeSkillSlug(args.slug);
    if (!slug) throw new ConvexError("Skill slug required");
    const skill = args.ownerHandle
      ? (
          await resolveSkillBySlugOrAliasForOwner(ctx, slug, args.ownerHandle, {
            includeSoftDeleted: true,
          })
        ).skill
      : await resolveUnambiguousSkillForLegacySlug(ctx, slug, {
          includeSoftDeleted: true,
        });
    if (!skill || (skill.softDeletedAt && actor.role !== "admin")) {
      throw new ConvexError("Skill not found");
    }

    await assertCanManageOwnedResource(ctx, {
      actor,
      ownerUserId: skill.ownerUserId,
      ownerPublisherId: skill.ownerPublisherId,
      allowedPublisherRoles: ["admin"],
      allowPlatformAdmin: true,
    });
    const allowSoftDeletedTransfer =
      actor.role === "admin" &&
      isSoftDeletedSkillEligibleForAdminTransfer(skill) &&
      (await isOwnerInitiatedSkillHideForAdminTransfer(ctx, skill));
    if (isSkillTransferBlockedByModeration(skill) && !allowSoftDeletedTransfer) {
      throw new ConvexError("Skill is not eligible for ownership transfer while under moderation");
    }
    if (allowSoftDeletedTransfer && !args.reason?.trim()) {
      throw new ConvexError("Reason required for soft-deleted skill ownership transfer");
    }

    const destinationHandle = normalizePublisherHandle(args.toOwner);
    if (!destinationHandle) throw new ConvexError("Destination owner is required");
    const destinationPublisher = await getPublisherByHandle(ctx, destinationHandle);
    if (!destinationPublisher || !isPublisherActive(destinationPublisher)) {
      throw new ConvexError(`Publisher "@${destinationHandle}" not found`);
    }
    if (!(await canManagePublisherDestination(ctx, actor, destinationPublisher))) {
      throw new ConvexError(
        `You do not have admin access for "@${destinationHandle}". Ask an owner or admin to add you before transferring this skill.`,
      );
    }

    const nextOwner =
      destinationPublisher.kind === "user" && destinationPublisher.linkedUserId
        ? await ctx.db.get(destinationPublisher.linkedUserId)
        : actor;
    if (!nextOwner || nextOwner.deletedAt || nextOwner.deactivatedAt) {
      throw new ConvexError("Destination owner user not found");
    }

    const replacedDestinationAlias = await getDestinationSkillSlugAliasToReplace(
      ctx,
      skill,
      destinationPublisher,
    );

    const now = Date.now();
    if (replacedDestinationAlias) {
      await ctx.db.delete(replacedDestinationAlias._id);
    }
    await transferSkillOwnershipAndEmbeddings(ctx, {
      skill,
      ownerUserId: nextOwner._id,
      ownerPublisherId: destinationPublisher._id,
      now,
      allowSoftDeleted: allowSoftDeletedTransfer,
    });
    await syncSkillSearchDigestForSkillDoc(ctx, {
      ...skill,
      ownerUserId: nextOwner._id,
      ownerPublisherId: destinationPublisher._id,
      lastReviewedAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      actorUserId: actor._id,
      action: "skill.owner.transfer",
      targetType: "skill",
      targetId: skill._id,
      metadata: {
        slug: skill.slug,
        previousOwnerUserId: skill.ownerUserId,
        previousOwnerPublisherId: skill.ownerPublisherId,
        nextOwnerUserId: nextOwner._id,
        nextOwnerPublisherId: destinationPublisher._id,
        reason: args.reason || undefined,
        replacedDestinationAliasId: replacedDestinationAlias?._id,
        replacedDestinationAliasSkillId: replacedDestinationAlias?.skillId,
      },
      createdAt: now,
    });

    return {
      ok: true as const,
      transferred: true as const,
      skillSlug: skill.slug,
      toPublisherHandle: destinationPublisher.handle,
      ownerUserId: nextOwner._id,
      ownerPublisherId: destinationPublisher._id,
    };
  },
});

async function releaseActiveReservationsForSlug(
  ctx: MutationCtx,
  slug: string,
  releasedAt: number,
) {
  const active = await listActiveReservedSlugsForSlug(ctx, slug);
  for (const reservation of active) {
    await ctx.db.patch(reservation._id, { releasedAt });
  }
}

/**
 * Admin-only: reclaim a squatted slug by hard-deleting the squatter's skill
 * and reserving the slug for the rightful owner.
 */
export const reclaimSlug = mutation({
  args: {
    slug: v.string(),
    rightfulOwnerUserId: v.id("users"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    assertAdmin(user);

    const slug = args.slug.trim().toLowerCase();
    if (!slug) throw new Error("Slug required");

    const rightfulOwner = await ctx.db.get(args.rightfulOwnerUserId);
    if (!rightfulOwner) throw new Error("Rightful owner not found");

    const now = Date.now();

    // Check if slug is currently occupied by someone else
    const existingSkill = await resolveOptionalUnambiguousSkillForLegacySlug(ctx, slug, {
      includeSoftDeleted: true,
    });

    if (existingSkill) {
      if (existingSkill.ownerUserId === args.rightfulOwnerUserId) {
        return { ok: true as const, action: "already_owned" };
      }

      // Hard-delete the squatter's skill
      await ctx.scheduler.runAfter(0, internal.skills.hardDeleteInternal, {
        skillId: existingSkill._id,
        actorUserId: user._id,
      });

      await ctx.db.insert("auditLogs", {
        actorUserId: user._id,
        action: "slug.reclaim",
        targetType: "skill",
        targetId: existingSkill._id,
        metadata: {
          slug,
          squatterUserId: existingSkill.ownerUserId,
          rightfulOwnerUserId: args.rightfulOwnerUserId,
          reason: args.reason || undefined,
        },
        createdAt: now,
      });
    }

    await upsertReservedSlugForRightfulOwner(ctx, {
      slug,
      rightfulOwnerUserId: args.rightfulOwnerUserId,
      deletedAt: now,
      expiresAt: now + SLUG_RESERVATION_MS,
      reason: args.reason || "slug.reclaimed",
    });

    return {
      ok: true as const,
      action: existingSkill ? "reclaimed_from_squatter" : "reserved",
    };
  },
});

/**
 * Admin-only: reclaim slugs in bulk. Useful for recovering multiple squatted slugs at once.
 */
export const reclaimSlugInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    slug: v.string(),
    rightfulOwnerUserId: v.id("users"),
    reason: v.optional(v.string()),
    transferRootSlugOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new Error("User not found");
    assertAdmin(actor);

    const slug = args.slug.trim().toLowerCase();
    if (!slug) throw new Error("Slug required");

    const now = Date.now();
    const transferRootSlugOnly = args.transferRootSlugOnly === true;

    const rightfulOwner = await ctx.db.get(args.rightfulOwnerUserId);
    if (!rightfulOwner || rightfulOwner.deletedAt || rightfulOwner.deactivatedAt) {
      throw new Error("Rightful owner not found");
    }

    const existingSkill = await resolveOptionalUnambiguousSkillForLegacySlug(ctx, slug, {
      includeSoftDeleted: true,
    });

    if (transferRootSlugOnly) {
      if (!existingSkill) {
        await ctx.db.insert("auditLogs", {
          actorUserId: args.actorUserId,
          action: "slug.reclaim",
          targetType: "slug",
          targetId: slug,
          metadata: {
            slug,
            rightfulOwnerUserId: args.rightfulOwnerUserId,
            transferRootSlugOnly: true,
            action: "missing",
            reason: args.reason || undefined,
          },
          createdAt: now,
        });
        return { ok: true as const, action: "missing" as const };
      }

      if (existingSkill.ownerUserId === args.rightfulOwnerUserId) {
        await releaseActiveReservationsForSlug(ctx, slug, now);
        await ctx.db.insert("auditLogs", {
          actorUserId: args.actorUserId,
          action: "slug.reclaim",
          targetType: "slug",
          targetId: slug,
          metadata: {
            slug,
            rightfulOwnerUserId: args.rightfulOwnerUserId,
            transferRootSlugOnly: true,
            action: "already_owned",
            reason: args.reason || undefined,
          },
          createdAt: now,
        });
        return { ok: true as const, action: "already_owned" as const };
      }

      await transferSkillOwnershipAndEmbeddings(ctx, {
        skill: existingSkill,
        ownerUserId: args.rightfulOwnerUserId,
        now,
      });
      await releaseActiveReservationsForSlug(ctx, slug, now);

      await ctx.db.insert("auditLogs", {
        actorUserId: args.actorUserId,
        action: "slug.reclaim",
        targetType: "slug",
        targetId: slug,
        metadata: {
          slug,
          rightfulOwnerUserId: args.rightfulOwnerUserId,
          previousOwnerUserId: existingSkill.ownerUserId,
          hadSquatter: true,
          transferRootSlugOnly: true,
          action: "ownership_transferred",
          reason: args.reason || undefined,
        },
        createdAt: now,
      });
      return { ok: true as const, action: "ownership_transferred" as const };
    }

    if (existingSkill && existingSkill.ownerUserId !== args.rightfulOwnerUserId) {
      await ctx.scheduler.runAfter(0, internal.skills.hardDeleteInternal, {
        skillId: existingSkill._id,
        actorUserId: args.actorUserId,
      });
    }

    await upsertReservedSlugForRightfulOwner(ctx, {
      slug,
      rightfulOwnerUserId: args.rightfulOwnerUserId,
      deletedAt: now,
      expiresAt: now + SLUG_RESERVATION_MS,
      reason: args.reason || "slug.reclaimed",
    });

    await ctx.db.insert("auditLogs", {
      actorUserId: args.actorUserId,
      action: "slug.reclaim",
      targetType: "slug",
      targetId: slug,
      metadata: {
        slug,
        rightfulOwnerUserId: args.rightfulOwnerUserId,
        hadSquatter: Boolean(
          existingSkill && existingSkill.ownerUserId !== args.rightfulOwnerUserId,
        ),
        reason: args.reason || undefined,
      },
      createdAt: now,
    });

    return { ok: true as const };
  },
});

export const reserveSlugInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    slug: v.string(),
    rightfulOwnerUserId: v.id("users"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new Error("User not found");
    assertAdmin(actor);

    const slug = args.slug.trim().toLowerCase();
    if (!slug) throw new Error("Slug required");

    const rightfulOwner = await ctx.db.get(args.rightfulOwnerUserId);
    if (!rightfulOwner || rightfulOwner.deletedAt || rightfulOwner.deactivatedAt) {
      throw new Error("Rightful owner not found");
    }

    const now = Date.now();
    const existingSkill = await resolveOptionalUnambiguousSkillForLegacySlug(ctx, slug, {
      includeSoftDeleted: true,
    });

    if (existingSkill) {
      if (existingSkill.ownerUserId !== args.rightfulOwnerUserId) {
        throw new Error("Slug already exists and belongs to another owner");
      }

      await releaseActiveReservationsForSlug(ctx, slug, now);
      await ctx.db.insert("auditLogs", {
        actorUserId: args.actorUserId,
        action: "slug.reserve",
        targetType: "slug",
        targetId: slug,
        metadata: {
          slug,
          rightfulOwnerUserId: args.rightfulOwnerUserId,
          action: "already_owned",
          reason: args.reason || undefined,
        },
        createdAt: now,
      });
      return { ok: true as const, action: "already_owned" as const };
    }

    await upsertReservedSlugForRightfulOwner(ctx, {
      slug,
      rightfulOwnerUserId: args.rightfulOwnerUserId,
      deletedAt: now,
      expiresAt: now + SLUG_RESERVATION_MS,
      reason: args.reason || "slug.reserved",
    });

    await ctx.db.insert("auditLogs", {
      actorUserId: args.actorUserId,
      action: "slug.reserve",
      targetType: "slug",
      targetId: slug,
      metadata: {
        slug,
        rightfulOwnerUserId: args.rightfulOwnerUserId,
        reason: args.reason || undefined,
      },
      createdAt: now,
    });

    return { ok: true as const, action: "reserved" as const };
  },
});

export const setDuplicate = mutation({
  args: {
    skillId: v.id("skills"),
    canonicalSlug: v.optional(v.string()),
    canonicalSkillId: v.optional(v.id("skills")),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    assertModerator(user);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");

    const now = Date.now();
    const canonicalSlug = args.canonicalSlug?.trim().toLowerCase();

    if (!canonicalSlug && !args.canonicalSkillId) {
      await ctx.db.patch(skill._id, {
        canonicalSkillId: undefined,
        forkOf: undefined,
        lastReviewedAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("auditLogs", {
        actorUserId: user._id,
        action: "skill.duplicate.clear",
        targetType: "skill",
        targetId: skill._id,
        metadata: { canonicalSlug: null },
        createdAt: now,
      });
      return;
    }

    const canonical = args.canonicalSkillId
      ? await ctx.db.get(args.canonicalSkillId)
      : canonicalSlug
        ? await resolveUnambiguousSkillForLegacySlug(ctx, canonicalSlug)
        : null;
    if (!canonical) throw new Error("Canonical skill not found");
    if (canonical._id === skill._id) throw new Error("Cannot duplicate a skill onto itself");

    const canonicalVersion = canonical.latestVersionId
      ? await ctx.db.get(canonical.latestVersionId)
      : null;

    await ctx.db.patch(skill._id, {
      canonicalSkillId: canonical._id,
      forkOf: {
        skillId: canonical._id,
        kind: "duplicate",
        version: canonicalVersion?.version,
        at: now,
      },
      lastReviewedAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      actorUserId: user._id,
      action: "skill.duplicate.set",
      targetType: "skill",
      targetId: skill._id,
      metadata: { canonicalSlug: canonical.slug, canonicalSkillId: canonical._id },
      createdAt: now,
    });
  },
});

export const setOfficialBadge = mutation({
  args: { skillId: v.id("skills"), official: v.boolean() },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    assertAdmin(user);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");

    const now = Date.now();
    if (args.official) {
      await upsertSkillBadge(ctx, skill._id, "official", user._id, now);
    } else {
      await removeSkillBadge(ctx, skill._id, "official");
    }

    await ctx.db.patch(skill._id, {
      lastReviewedAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      actorUserId: user._id,
      action: args.official ? "badge.official.set" : "badge.official.unset",
      targetType: "skill",
      targetId: skill._id,
      metadata: { official: args.official },
      createdAt: now,
    });
  },
});

export const setDeprecatedBadge = mutation({
  args: { skillId: v.id("skills"), deprecated: v.boolean() },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    assertAdmin(user);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");

    const now = Date.now();
    if (args.deprecated) {
      await upsertSkillBadge(ctx, skill._id, "deprecated", user._id, now);
    } else {
      await removeSkillBadge(ctx, skill._id, "deprecated");
    }

    await ctx.db.patch(skill._id, {
      lastReviewedAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      actorUserId: user._id,
      action: args.deprecated ? "badge.deprecated.set" : "badge.deprecated.unset",
      targetType: "skill",
      targetId: skill._id,
      metadata: { deprecated: args.deprecated },
      createdAt: now,
    });
  },
});

export const hardDelete = mutation({
  args: { skillId: v.id("skills") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    assertAdmin(user);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");
    await hardDeleteSkillStep(ctx, skill, user._id, "versions");
  },
});

export const hardDeleteForAdminInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    slug: v.string(),
    ownerHandle: v.string(),
    reason: v.string(),
    dryRun: v.optional(v.boolean()),
    confirmationToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new ConvexError("Unauthorized");
    assertAdmin(actor);

    const slug = normalizeSkillSlugKey(args.slug);
    const ownerHandle = normalizePublisherHandle(args.ownerHandle);
    const reason = args.reason.trim();
    if (!slug) throw new ConvexError("Slug required");
    if (!ownerHandle) throw new ConvexError("Owner handle required");
    if (!reason) throw new ConvexError("Reason is required");
    if (reason.length > 500) throw new ConvexError("Reason too long (max 500 chars)");

    const resolved = await resolveSkillBySlugOrAliasForOwner(ctx, slug, ownerHandle, {
      includeSoftDeleted: true,
      includeInactiveOwnerFallback: true,
    });
    const skill = resolved.skill;
    if (!skill) throw new ConvexError("Skill not found");

    const generated_token_reference = `hard-delete-skill:@${ownerHandle}/${skill.slug}:${skill._id}`;
    const baseResult = {
      ok: true as const,
      skillId: skill._id,
      slug: skill.slug,
      ownerHandle,
      displayName: skill.displayName,
      confirmationToken: generated_token_reference,
    };
    const dryRun = args.dryRun !== false;
    if (dryRun) {
      return {
        ...baseResult,
        dryRun: true,
        scheduled: false,
      };
    }

    if (args.confirmationToken !== generated_token_reference) {
      throw new ConvexError(`Confirmation token must be "${generated_token_reference}"`);
    }

    const now = Date.now();
    await ctx.db.insert("auditLogs", {
      actorUserId: args.actorUserId,
      action: "skill.hard_delete.requested",
      targetType: "skill",
      targetId: skill._id,
      metadata: {
        slug: skill.slug,
        ownerHandle,
        reason,
        source: "clawhub-admin",
      },
      createdAt: now,
    });
    await hardDeleteSkillStep(ctx, skill, args.actorUserId, "versions", {
      source: "admin",
      reason,
    });

    return {
      ...baseResult,
      dryRun: false,
      scheduled: true,
    };
  },
});

export const hardDeleteInternal = internalMutation({
  args: {
    skillId: v.id("skills"),
    actorUserId: v.id("users"),
    phase: v.optional(v.string()),
    source: hardDeleteSourceValidator,
    ownerPublisherId: v.optional(v.id("publishers")),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    const skill = await ctx.db.get(args.skillId);
    if (!skill) return;
    const source = args.source ?? "admin";
    if (source === "admin") {
      if (!actor || actor.deletedAt || actor.deactivatedAt) throw new Error("User not found");
      assertAdmin(actor);
    } else if (source === "account.delete") {
      if (!actor) throw new Error("User not found");
      if (skill.ownerUserId !== args.actorUserId || skill.ownerPublisherId) {
        throw new Error("Skill is outside account deletion scope");
      }
    } else {
      if (!actor) throw new Error("User not found");
      if (!args.ownerPublisherId || skill.ownerPublisherId !== args.ownerPublisherId) {
        throw new Error("Skill is outside publisher deletion scope");
      }
    }
    // Jobs scheduled before earlier cleanup phases were removed should continue
    // at the next durable phase instead of restarting from the beginning.
    const phase =
      args.phase === "rootInstalls"
        ? "installTelemetryDedupes"
        : args.phase === "comments" || args.phase === "commentReports"
          ? "reports"
          : isHardDeletePhase(args.phase)
            ? args.phase
            : "versions";
    await hardDeleteSkillStep(ctx, skill, args.actorUserId, phase, {
      source,
      ownerPublisherId: args.ownerPublisherId,
      reason: args.reason,
    });
  },
});

type SkillPendingPublishArgs = {
  userId: Id<"users">;
  ownerPublisherId?: Id<"publishers">;
  displayName: string;
  icon?: string;
  version: string;
  changelog: string;
  changelogSource?: "auto" | "user";
  tags?: string[];
  categories?: string[];
  topics?: string[];
  files: Doc<"skillVersions">["files"];
  parsed: Doc<"skillVersions">["parsed"];
  summary?: string;
  qualityAssessment?: {
    decision: "pass" | "quarantine" | "reject";
    score: number;
    reason: string;
    trustTier: "low" | "medium" | "trusted";
    similarRecentCount: number;
    signals: {
      bodyChars: number;
      bodyWords: number;
      uniqueWordRatio: number;
      headingCount: number;
      bulletCount: number;
      templateMarkerHits: number;
      genericSummary: boolean;
      cjkChars?: number;
    };
  };
  staticScan: NonNullable<Doc<"skillVersions">["staticScan"]>;
  llmAnalysis?: Doc<"skillVersions">["llmAnalysis"];
  embedding: number[];
};

function asSkillPendingPublishArgs(value: unknown): SkillPendingPublishArgs {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConvexError("Pending skill publication metadata is missing.");
  }
  return value as SkillPendingPublishArgs;
}

function stripUndefinedForStoredPublication(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefinedForStoredPublication);
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (nested !== undefined) result[key] = stripUndefinedForStoredPublication(nested);
  }
  return result;
}

export const insertVersion = internalMutation({
  args: {
    userId: v.id("users"),
    skillPublishUploadTickets: v.optional(v.array(v.id("skillPublishUploadTickets"))),
    ownerPublisherId: v.optional(v.id("publishers")),
    sourceOwnerPublisherId: v.optional(v.id("publishers")),
    // Explicit opt-in to owner migration. When an existing skill row already has
    // a different `ownerPublisherId` than the one supplied above, the mutation
    // only rewrites ownership if `migrateOwner === true`. Without this flag the
    // mismatch is surfaced as a slug-collision error (the pre-org-migration
    // behaviour), so a silently-different Owner value in an older CLI or a
    // wrongly-defaulted form cannot re-own an org-owned skill by accident.
    migrateOwner: v.optional(v.boolean()),
    slug: v.string(),
    displayName: v.string(),
    icon: v.optional(v.string()),
    version: v.string(),
    changelog: v.string(),
    changelogSource: v.optional(v.union(v.literal("auto"), v.literal("user"))),
    sourceProvenance: v.optional(
      v.object({
        kind: v.literal("github"),
        url: v.string(),
        repo: v.string(),
        ref: v.string(),
        commit: v.string(),
        path: v.optional(v.string()),
        importedAt: v.number(),
      }),
    ),
    tags: v.optional(v.array(v.string())),
    categories: v.optional(v.array(v.string())),
    topics: v.optional(v.array(v.string())),
    fingerprint: v.string(),
    bypassNewSkillRateLimit: v.optional(v.boolean()),
    forkOf: v.optional(
      v.object({
        slug: v.string(),
        ownerHandle: v.optional(v.string()),
        version: v.optional(v.string()),
      }),
    ),
    files: v.array(
      v.object({
        path: v.string(),
        size: v.number(),
        storageId: v.id("_storage"),
        sha256: v.string(),
        contentType: v.optional(v.string()),
      }),
    ),
    parsed: v.object({
      frontmatter: v.record(v.string(), v.any()),
      metadata: v.optional(v.any()),
      clawdis: v.optional(v.any()),
      license: v.optional(v.literal(PLATFORM_SKILL_LICENSE)),
      presentation: v.optional(
        v.object({
          displayName: v.string(),
          displayNameSource: v.optional(
            v.union(
              v.literal("publisher"),
              v.literal("openai"),
              v.literal("skill"),
              v.literal("slug"),
            ),
          ),
          summary: v.optional(v.string()),
          summarySource: v.optional(
            v.union(
              v.literal("publisher"),
              v.literal("openai"),
              v.literal("skill"),
              v.literal("generated"),
            ),
          ),
          icon: v.optional(v.string()),
        }),
      ),
    }),
    summary: v.optional(v.string()),
    qualityAssessment: v.optional(
      v.object({
        decision: v.union(v.literal("pass"), v.literal("quarantine"), v.literal("reject")),
        score: v.number(),
        reason: v.string(),
        trustTier: v.union(v.literal("low"), v.literal("medium"), v.literal("trusted")),
        similarRecentCount: v.number(),
        signals: v.object({
          bodyChars: v.number(),
          bodyWords: v.number(),
          uniqueWordRatio: v.number(),
          headingCount: v.number(),
          bulletCount: v.number(),
          templateMarkerHits: v.number(),
          genericSummary: v.boolean(),
          cjkChars: v.optional(v.number()),
        }),
      }),
    ),
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
    llmAnalysis: v.optional(v.any()),
    embedding: v.array(v.number()),
    publicationStatus: v.optional(v.union(v.literal("pending"), v.literal("published"))),
    deferredAiEnrichment: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const userId = args.userId;
    const isPendingPublication = args.publicationStatus === "pending";
    // Lenient normalization first so we can look up an existing skill row
    // before deciding whether to enforce the strict write-path validator.
    // Owners of grandfathered slugs (reserved, <3 chars, >48 chars, or other
    // pre-validator shapes) must remain able to publish new versions; the
    // strict reserved/length/pattern rules only apply when creating a brand
    // new skill. The caller (publishVersionForUser) performs the same split,
    // but the mutation re-validates defensively because it can be invoked on
    // its own (e.g. tests, internal schedulers).
    const normalizedSlug = normalizeSkillSlug(args.slug);
    if (!normalizedSlug) throw new ConvexError("Slug is required.");
    const user = await ctx.db.get(userId);
    if (!user || user.deletedAt || user.deactivatedAt) throw new Error("User not found");
    if (args.skillPublishUploadTickets) {
      await consumeSkillPublishUploads(ctx, {
        userId,
        uploadTickets: args.skillPublishUploadTickets,
        files: args.files,
      });
    }
    const personalPublisher = await ensurePersonalPublisherForUser(ctx, user, {
      actorUserId: userId,
      source: "skill.publish",
    });
    if (!personalPublisher) throw new ConvexError("Personal publisher not found");
    // `callerExplicitlySpecifiedOwner` distinguishes the two semantically
    // different reasons we end up with `ownerPublisherId === personalPublisher._id`:
    //   1. the caller explicitly asked to publish under their own personal
    //      publisher (we still allow migration in that case — moving from an
    //      org back to personal is symmetric to the org-migration flow), or
    //   2. the caller simply didn't pass the field (e.g. older CLI builds).
    // We only treat case (2) as "no migration intent", so that a silent client
    // upgrade can never re-own an org-owned skill into a personal namespace.
    const callerExplicitlySpecifiedOwner = args.ownerPublisherId !== undefined;
    const ownerPublisherId = args.ownerPublisherId ?? personalPublisher._id;
    let ownerPublisher: Doc<"publishers"> = personalPublisher;
    if (ownerPublisherId !== personalPublisher._id) {
      const roleCheck = await requirePublisherRole(ctx, {
        publisherId: ownerPublisherId,
        userId,
        allowed: ["publisher"],
      });
      if (!roleCheck.publisher) throw new ConvexError("Publisher not found");
      ownerPublisher = roleCheck.publisher;
    }

    const now = Date.now();

    const destinationSkill = await getSkillBySlugForPublisher(ctx, normalizedSlug, ownerPublisher);
    let skill = destinationSkill;
    if (!skill && ownerPublisherId === personalPublisher._id && args.migrateOwner !== true) {
      // Older clients do not send an owner namespace, and current CLI builds
      // default omitted --owner to the caller's personal namespace. Keep the
      // narrow legacy duplicate-auth repair path for pre-publisher personal
      // rows in both cases, but do not use global slug matches to block
      // unrelated owners from publishing the same slug in their own namespace.
      skill = await resolveLegacyPersonalSkillForSameGitHubOwner(ctx, normalizedSlug, userId);
    }
    if (!skill && callerExplicitlySpecifiedOwner && args.migrateOwner !== true) {
      const legacyPersonalSkill = await resolveLegacyPersonalSkillForSameGitHubOwner(
        ctx,
        normalizedSlug,
        userId,
      );
      if (legacyPersonalSkill && isSkillTransferBlockedByModeration(legacyPersonalSkill)) {
        throw new ConvexError(
          "Skill is not eligible for ownership transfer while under moderation",
        );
      }
    }
    if (callerExplicitlySpecifiedOwner && args.migrateOwner === true) {
      if (args.sourceOwnerPublisherId) {
        const sourcePublisher = await ctx.db.get(args.sourceOwnerPublisherId);
        if (!sourcePublisher) throw new ConvexError("Source publisher not found");
        skill = await getSkillBySlugForPublisher(ctx, normalizedSlug, sourcePublisher);
        if (!skill) {
          throw new ConvexError(
            `Source owner @${sourcePublisher.handle} does not have skill "${normalizedSlug}".`,
          );
        }
        if (destinationSkill && destinationSkill._id !== skill._id) {
          throw new ConvexError(buildDestinationSkillExistsMessage(ownerPublisher, normalizedSlug));
        }
      } else if (destinationSkill) {
        throw new ConvexError(buildDestinationSkillExistsMessage(ownerPublisher, normalizedSlug));
      } else {
        const resolved = await resolveLegacySkillBySlugOrAlias(ctx, normalizedSlug, {
          includeSoftDeleted: true,
        });
        if (resolved.ambiguous) {
          throw new ConvexError(
            "Slug is used by multiple publishers. Publish with the source owner namespace instead.",
          );
        }
        skill = resolved.skill;
      }
    }

    if (skill && skill.softDeletedAt && !(await canUserManageSkillOwner(ctx, skill, userId))) {
      const unpublishedReservationExpiresAt = await getUnpublishedSlugReservationExpiresAt(
        ctx,
        skill,
      );
      if (unpublishedReservationExpiresAt !== null) {
        if (unpublishedReservationExpiresAt > now) {
          throw new ConvexError(
            formatUnpublishedSlugReservationMessage(
              normalizedSlug,
              unpublishedReservationExpiresAt,
            ),
          );
        }
        normalizeSkillSlugForWrite(args.slug);
        await releaseExpiredUnpublishedSkillSlug(ctx, skill, now, userId);
        skill = null;
      }
    }

    // Only enforce the strict write-path rules when creating a new skill.
    // For existing rows, keep the already-persisted (possibly grandfathered)
    // slug as-is so legacy publishers are not locked out of version updates.
    const slug = skill ? normalizedSlug : normalizeSkillSlugForWrite(args.slug);
    const createdNewParent = !skill;

    if (!skill) {
      const alias = await getSkillSlugAliasBySlugScoped(
        ctx,
        slug,
        ownerPublisherId,
        ownerPublisher.kind === "user" ? ownerPublisher.linkedUserId : undefined,
      );
      if (alias) {
        const aliasedSkill = await ctx.db.get(alias.skillId);
        const owner = aliasedSkill
          ? await getOwnerPublisher(ctx, {
              ownerPublisherId: aliasedSkill.ownerPublisherId,
              ownerUserId: aliasedSkill.ownerUserId,
            })
          : null;
        throw new ConvexError(
          aliasedSkill
            ? buildAliasTakenErrorMessage(aliasedSkill, owner)
            : "Slug redirects to an existing skill. Choose a different slug.",
        );
      }
    }

    if (skill && skill.ownerPublisherId && skill.ownerPublisherId !== ownerPublisherId) {
      // Owner migration: allow publishing under a different publisher (e.g. moving
      // a skill from a personal publisher into an org, or between orgs) only when
      // the caller has sufficient authority on BOTH sides AND has explicitly
      // opted into a migration.
      //
      // Authority model — aligned with `transferPackage` in convex/packages.ts:
      //   * destination side — publisher-level rights were already enforced above
      //     (`requirePublisherRole(..., ["publisher"])`) when the caller is
      //     publishing into an org. That is enough for *publishing* into the
      //     destination, but *transferring ownership into* it is a stronger
      //     operation, so on the migration path we additionally require ADMIN
      //     rights on the destination publisher. Moving a skill into the
      //     caller's own personal publisher is still allowed because
      //     `ensurePersonalPublisherForUser` guarantees the caller is the
      //     publisher's `linkedUser` with role `owner` (>= admin).
      //   * source side — must be ADMIN on the source publisher (or the linked
      //     personal-publisher user themselves). This matches the transfer spec:
      //     moving a skill *out* of an org is an ownership change, so a plain
      //     "publisher" role member must not be able to trigger it by republishing.
      //
      // We also require the caller to have *explicitly* asked to publish under
      // a specific publisher (`args.ownerPublisherId !== undefined`) AND to
      // have explicitly signalled migration intent (`args.migrateOwner === true`).
      // Older clients that just call `publishVersion` without an owner param, or
      // newer clients where the Owner selector defaulted to the caller's
      // personal publisher, would otherwise accidentally migrate org-owned
      // skills on every publish.
      //
      // Defense in depth: `addMember` does not currently require publisher.kind ===
      // "org", so in principle a user-kind ("personal") publisher can end up with
      // extra members beyond its linkedUser. We refuse migration *out* of a
      // user-kind publisher unless the caller IS its linkedUser, so the only
      // way to move a personal skill is "the owner themselves decides to move
      // it" — never "a third party who happens to share a publisher row".
      // Legacy personal publisher rows may be missing `linkedUserId`, so the
      // persisted skill owner is accepted as the compatibility fallback.
      const callerRequestedMigration = args.migrateOwner === true;
      const sourcePublisher = await ctx.db.get(skill.ownerPublisherId);
      const callerOwnsSourceViaPersonalLink =
        sourcePublisher?.kind === "user" &&
        isPublisherActive(sourcePublisher) &&
        (sourcePublisher.linkedUserId
          ? sourcePublisher.linkedUserId === userId
          : skill.ownerUserId === userId);
      const sourceIsOrg = sourcePublisher?.kind === "org" && isPublisherActive(sourcePublisher);

      const sourceMembership =
        callerExplicitlySpecifiedOwner && callerRequestedMigration && sourceIsOrg
          ? await getPublisherMembership(ctx, skill.ownerPublisherId, userId)
          : null;
      const callerHasSourceAdminRole = Boolean(
        sourceMembership && isPublisherRoleAllowed(sourceMembership.role, ["admin"]),
      );
      const callerCanPublishFromSource =
        callerExplicitlySpecifiedOwner &&
        callerRequestedMigration &&
        (callerOwnsSourceViaPersonalLink || callerHasSourceAdminRole);

      if (!callerCanPublishFromSource) {
        const owner = await getOwnerPublisher(ctx, {
          ownerPublisherId: skill.ownerPublisherId,
          ownerUserId: skill.ownerUserId,
        });
        throw new ConvexError(buildSlugTakenErrorMessage(skill, owner));
      }

      // Destination admin check: publishing into a publisher only requires
      // publisher-level rights, but *transferring ownership into* a publisher
      // requires admin-level rights on that destination too. For the caller's
      // own personal publisher this is trivially satisfied (linkedUser ===
      // role "owner"); for an org destination this rejects plain publishers.
      await requirePublisherRole(ctx, {
        publisherId: ownerPublisherId,
        userId,
        allowed: ["admin"],
      });
      const replacedDestinationAlias = await getDestinationSkillSlugAliasToReplace(
        ctx,
        skill,
        ownerPublisher,
      );

      const previousOwnerPublisherId = skill.ownerPublisherId;
      const previousOwnerUserId = skill.ownerUserId;

      const nextSkill: Doc<"skills"> = {
        ...skill,
        ownerPublisherId,
        ownerUserId: userId,
        lastReviewedAt: now,
        updatedAt: now,
      };

      if (replacedDestinationAlias) {
        await ctx.db.delete(replacedDestinationAlias._id);
      }
      await transferSkillOwnershipAndEmbeddings(ctx, {
        skill,
        ownerPublisherId,
        ownerUserId: userId,
        now,
      });

      await ctx.db.insert("auditLogs", {
        actorUserId: userId,
        action: "skill.ownership.migrate",
        targetType: "skill",
        targetId: skill._id,
        metadata: {
          reason: "publishVersion.ownerMigration",
          from: {
            ownerPublisherId: previousOwnerPublisherId,
            ownerUserId: previousOwnerUserId,
          },
          to: {
            ownerPublisherId,
            ownerUserId: userId,
          },
          replacedDestinationAliasId: replacedDestinationAlias?._id,
          replacedDestinationAliasSkillId: replacedDestinationAlias?.skillId,
        },
        createdAt: now,
      });

      skill = nextSkill;
    }

    if (skill && !skill.ownerPublisherId && skill.ownerUserId !== userId) {
      // Fallback: Convex Auth can create duplicate `users` records. Heal ownership ONLY
      // when the underlying GitHub identity matches (authAccounts.providerAccountId).
      const owner = await getOwnerPublisher(ctx, {
        ownerPublisherId: skill.ownerPublisherId,
        ownerUserId: skill.ownerUserId,
      });
      const slugTakenMessage = buildSlugTakenErrorMessage(skill, owner);

      // Check GitHub identity FIRST so ownership healing works even when the
      // previous owner record is deleted/deactivated (e.g. duplicate Convex Auth
      // user where the old record was later banned).
      const [ownerProviderAccountId, callerProviderAccountId] = await Promise.all([
        getGitHubProviderAccountId(ctx, skill.ownerUserId),
        getGitHubProviderAccountId(ctx, userId),
      ]);

      if (
        canHealSkillOwnershipByGitHubProviderAccountId(
          ownerProviderAccountId,
          callerProviderAccountId,
        )
      ) {
        await transferSkillOwnershipAndEmbeddings(ctx, {
          skill,
          ownerUserId: userId,
          ownerPublisherId,
          now,
        });
        skill = {
          ...skill,
          ownerUserId: userId,
          ownerPublisherId,
          lastReviewedAt: now,
          updatedAt: now,
        };
      } else {
        throw new ConvexError(slugTakenMessage);
      }
    } else if (skill && !skill.ownerPublisherId) {
      await transferSkillOwnershipAndEmbeddings(ctx, {
        skill,
        ownerUserId: userId,
        ownerPublisherId,
        now,
      });
      skill = { ...skill, ownerPublisherId, lastReviewedAt: now, updatedAt: now };
    }

    const qualityAssessment = args.qualityAssessment;
    const isQualityQuarantine = qualityAssessment?.decision === "quarantine";

    const initialScannerSnapshot = buildModerationSnapshot({});
    const isPublisherUnderModeration = Boolean(user.requiresModerationAt);
    const initialModerationStatus =
      isQualityQuarantine || isPublisherUnderModeration ? "hidden" : "active";

    const moderationReason = isQualityQuarantine
      ? "quality.low"
      : isPublisherUnderModeration
        ? USER_MODERATION_REASON
        : "pending.scan";
    const moderationNotes = isQualityQuarantine
      ? `Auto-quarantined by quality gate (score=${qualityAssessment.score}, tier=${qualityAssessment.trustTier}, similar=${qualityAssessment.similarRecentCount}).`
      : isPublisherUnderModeration
        ? (user.requiresModerationReason ??
          "Publisher is currently under manual moderation review.")
        : undefined;

    const qualityRecord = qualityAssessment
      ? {
          score: qualityAssessment.score,
          decision: qualityAssessment.decision,
          trustTier: qualityAssessment.trustTier,
          similarRecentCount: qualityAssessment.similarRecentCount,
          reason: qualityAssessment.reason,
          signals: qualityAssessment.signals,
          evaluatedAt: now,
        }
      : undefined;

    if (!skill) {
      // Anti-squatting: enforce reserved slug cooldown.
      await enforceReservedSlugCooldownForNewSkill(ctx, {
        slug,
        userId,
        ownerPublisher,
        now,
      });

      if (!args.bypassNewSkillRateLimit) {
        const ownerPublishActivity = await getOwnerPublishActivity(ctx, user._id, now);
        enforceNewSkillRateLimit(ownerPublishActivity);
      }

      const forkOfSlug = args.forkOf?.slug.trim().toLowerCase() || "";
      const forkOfOwnerHandle = args.forkOf?.ownerHandle?.trim().replace(/^@+/, "") || undefined;
      const forkOfVersion = args.forkOf?.version?.trim() || undefined;

      let canonicalSkillId: Id<"skills"> | undefined;
      let forkOf:
        | {
            skillId: Id<"skills">;
            kind: "fork" | "duplicate";
            version?: string;
            at: number;
          }
        | undefined;

      if (forkOfSlug) {
        const upstream = forkOfOwnerHandle
          ? (await resolveSkillBySlugOrAliasForOwner(ctx, forkOfSlug, forkOfOwnerHandle)).skill
          : await resolveUnambiguousSkillForLegacySlug(ctx, forkOfSlug, {
              notFoundMessage: "Upstream skill not found",
            });
        if (!upstream || upstream.softDeletedAt) throw new Error("Upstream skill not found");
        canonicalSkillId = upstream.canonicalSkillId ?? upstream._id;
        forkOf = {
          skillId: upstream._id,
          kind: "fork",
          version: forkOfVersion,
          at: now,
        };
      } else {
        const match = await findCanonicalSkillForFingerprint(ctx, args.fingerprint);
        if (match) {
          canonicalSkillId = match.canonicalSkillId ?? match._id;
          forkOf = {
            skillId: match._id,
            kind: "duplicate",
            at: now,
          };
        }
      }

      const summary = args.summary ?? getFrontmatterValue(args.parsed.frontmatter, "description");
      const summaryValue = summary ?? undefined;
      const derivedFlags = deriveModerationFlags({
        skill: {
          slug,
          displayName: args.displayName,
          summary: summaryValue,
        },
        parsed: args.parsed,
        files: args.files,
      });
      const newSkillFlags = Array.from(
        new Set([...(derivedFlags ?? []), ...(initialScannerSnapshot.legacyFlags ?? [])]),
      );
      const skillId = await ctx.db.insert("skills", {
        slug,
        displayName: args.displayName,
        summary: summaryValue,
        icon: args.icon,
        ownerUserId: userId,
        ownerPublisherId,
        canonicalSkillId,
        forkOf,
        latestVersionId: undefined,
        tags: {},
        categories: args.categories,
        topics: args.topics,
        softDeletedAt: undefined,
        badges: {
          redactionApproved: undefined,
          highlighted: undefined,
          official: undefined,
          deprecated: undefined,
        },
        moderationStatus: isPendingPublication ? "hidden" : initialModerationStatus,
        moderationReason: isPendingPublication ? "pending.publication" : moderationReason,
        moderationNotes: isPendingPublication
          ? "Pre-publication security checks are pending."
          : moderationNotes,
        moderationVerdict: initialScannerSnapshot.verdict,
        moderationReasonCodes: initialScannerSnapshot.reasonCodes.length
          ? initialScannerSnapshot.reasonCodes
          : undefined,
        moderationEvidence: initialScannerSnapshot.evidence.length
          ? initialScannerSnapshot.evidence
          : undefined,
        moderationSummary: initialScannerSnapshot.summary,
        moderationEngineVersion: initialScannerSnapshot.engineVersion,
        moderationEvaluatedAt: initialScannerSnapshot.evaluatedAt,
        moderationSourceVersionId: undefined,
        quality: qualityRecord,
        moderationFlags: newSkillFlags.length ? newSkillFlags : undefined,
        isSuspicious: computeIsSuspicious({
          moderationFlags: newSkillFlags.length ? newSkillFlags : undefined,
          moderationReason: moderationReason,
        }),
        reportCount: 0,
        lastReportedAt: undefined,
        statsDownloads: 0,
        statsStars: 0,
        statsInstallsCurrent: 0,
        statsInstallsAllTime: 0,
        stats: {
          downloads: 0,
          installsCurrent: 0,
          installsAllTime: 0,
          stars: 0,
          versions: 0,
          comments: 0,
        },
        createdAt: now,
        updatedAt: now,
      });
      skill = await ctx.db.get(skillId);
      if (skill) {
        // Digest sync is handled after the version patch below (line ~4222),
        // which captures the final state including latestVersionId and tags.
        await adjustGlobalPublicCountForSkillChange(ctx, null, skill);
        await adjustUserSkillStatsForSkillChange(ctx, null, skill);
      }
    }

    if (!skill) throw new Error("Skill creation failed");

    const existingVersion = await ctx.db
      .query("skillVersions")
      .withIndex("by_skill_version", (q) => q.eq("skillId", skill._id).eq("version", args.version))
      .unique();
    if (existingVersion) {
      throw new ConvexError(
        `Version ${args.version} already exists. Increment the version number and try again.`,
      );
    }

    const versionId = await ctx.db.insert("skillVersions", {
      skillId: skill._id,
      version: args.version,
      publicationStatus: args.publicationStatus ?? "published",
      pendingPublication: isPendingPublication
        ? stripUndefinedForStoredPublication({ skillInsertArgs: args })
        : undefined,
      fingerprint: args.fingerprint,
      sourceProvenance: args.sourceProvenance,
      changelog: args.changelog,
      changelogSource: args.changelogSource,
      icon: args.icon,
      files: args.files,
      parsed: args.parsed,
      staticScan: args.staticScan,
      llmAnalysis: args.llmAnalysis,
      createdBy: userId,
      createdAt: now,
      softDeletedAt: undefined,
    });

    if (isPendingPublication) {
      await ctx.db.insert("skillVersionFingerprints", {
        skillId: skill._id,
        versionId,
        fingerprint: args.fingerprint,
        kind: "source",
        createdAt: now,
      });
      return {
        skillId: skill._id,
        versionId,
        publicationStatus: "pending" as const,
        createdNewParent,
      };
    }

    // Only promote this version to `latest` if it is strictly greater than the
    // currently published latest version (by semver). This allows backport /
    // hotfix publishes on lower version lines (e.g. shipping 1.0.1 while 2.x is
    // live) without clobbering the latest pointer, tag, embedding, or summary.
    //
    // The schema only enforces `v.string()` on `latestVersionSummary.version`,
    // so legacy / imported skills may persist non-semver values (e.g. "latest",
    // "2024-12"). Calling `semver.gt` with a malformed right-hand operand
    // throws `TypeError: Invalid Version`, which would crash the publish
    // mutation. Short-circuit to treating the incoming publish as the new
    // latest in that case, which self-heals the skill back into a valid
    // semver latest pointer (args.version is already validated upstream in
    // publishVersionForUser / githubImport).
    const prevLatestVersion = skill.latestVersionSummary?.version;
    const isNewLatest =
      !prevLatestVersion ||
      !semver.valid(prevLatestVersion) ||
      semver.gt(args.version, prevLatestVersion);

    const nextTags: Record<string, Id<"skillVersions">> = { ...skill.tags };
    if (isNewLatest) {
      nextTags.latest = versionId;
    }
    // `latest` is a reserved tag: it is managed exclusively by the semver
    // comparison above so that backport publishes cannot clobber the latest
    // pointer. Silently drop it (case-insensitively) from caller-provided tags
    // to prevent a trivial bypass via args.tags: ["latest"].
    for (const tag of normalizeSkillTags(args.tags) ?? []) {
      if (tag.toLowerCase() === "latest") continue;
      nextTags[tag] = versionId;
    }

    const latestBefore = skill.latestVersionId;

    const derivedSummary =
      args.summary ?? getFrontmatterValue(args.parsed.frontmatter, "description") ?? skill.summary;
    // Skill-level fields (displayName / summary) should only
    // follow the latest version. Backport publishes must not leak their values
    // into the skill card shown on the listing / detail pages.
    const nextSummary = isNewLatest ? derivedSummary : skill.summary;
    // Backport publishes must not promote their displayName/summary onto the
    // skill card (see basePatch below), so the moderation evaluation must use
    // the same values that will actually be persisted. Otherwise we would
    // persist flags derived from text the user can never see on the card.
    const nextDisplayName = isNewLatest ? args.displayName : skill.displayName;
    const derivedFlags = deriveModerationFlags({
      skill: {
        slug: skill.slug,
        displayName: nextDisplayName,
        summary: nextSummary ?? undefined,
      },
      parsed: args.parsed,
      files: args.files,
    });
    const moderationSnapshot = buildModerationSnapshot({ sourceVersionId: versionId });
    const nextFlags = Array.from(
      new Set([...(derivedFlags ?? []), ...(moderationSnapshot.legacyFlags ?? [])]),
    );
    const scannerModerationPatch =
      args.llmAnalysis && !isQualityQuarantine && !isPublisherUnderModeration
        ? buildScannerModerationPatchFromVersion({
            owner: null,
            version: {
              _id: versionId,
              staticScan: args.staticScan,
              vtAnalysis: undefined,
              llmAnalysis: args.llmAnalysis,
            },
            now,
          })
        : {};
    const basePatch: SkillModerationPatch = {
      displayName: nextDisplayName,
      summary: nextSummary ?? undefined,
      icon: isNewLatest
        ? (args.icon ?? (isHostedSkillPresentationIconPath(skill.icon) ? undefined : skill.icon))
        : skill.icon,
      ownerPublisherId: skill.ownerPublisherId ?? ownerPublisherId,
      latestVersionId: isNewLatest ? versionId : skill.latestVersionId,
      latestVersionSummary: isNewLatest
        ? {
            version: args.version,
            createdAt: now,
            changelog: args.changelog,
            changelogSource: args.changelogSource,
            description:
              args.summary ?? getFrontmatterValue(args.parsed.frontmatter, "description")?.trim(),
            clawdis: args.parsed.clawdis,
          }
        : skill.latestVersionSummary,
      tags: nextTags,
      categories: isNewLatest ? args.categories : skill.categories,
      topics: isNewLatest ? args.topics : skill.topics,
      ...(isNewLatest
        ? {
            inferredCategories: undefined,
            inferredTopics: undefined,
            inferredFromVersionId: undefined,
            inferredCategoryConfidence: undefined,
            inferredTopicConfidence: undefined,
            inferredClassifierVersion: undefined,
            inferredTopicClassifierVersion: undefined,
            inferredInputHash: undefined,
            inferredTopicInputHash: undefined,
            inferredAt: undefined,
          }
        : {}),
      stats: { ...skill.stats, versions: skill.stats.versions + 1 },
      softDeletedAt: undefined,
      moderationStatus: initialModerationStatus,
      moderationReason,
      moderationNotes,
      moderationVerdict: moderationSnapshot.verdict,
      moderationReasonCodes: moderationSnapshot.reasonCodes.length
        ? moderationSnapshot.reasonCodes
        : undefined,
      moderationEvidence: moderationSnapshot.evidence.length
        ? moderationSnapshot.evidence
        : undefined,
      moderationSummary: moderationSnapshot.summary,
      moderationEngineVersion: moderationSnapshot.engineVersion,
      moderationEvaluatedAt: moderationSnapshot.evaluatedAt,
      moderationSourceVersionId: versionId,
      quality: qualityRecord ?? skill.quality,
      moderationFlags: nextFlags.length ? nextFlags : undefined,
      isSuspicious: computeIsSuspicious({
        moderationFlags: nextFlags.length ? nextFlags : undefined,
        moderationReason: moderationReason,
      }),
      unpublishedSlugReservedUntil: undefined,
      unpublishedSlugReleasedAt: undefined,
      unpublishedOriginalSlug: undefined,
      updatedAt: now,
      ...scannerModerationPatch,
    };
    const patch = basePatch;
    const nextSkill = { ...skill, ...patch };
    await ctx.db.patch(skill._id, patch);
    await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);

    const badgeMap = await getSkillBadgeMap(ctx, skill._id);
    const isApproved = Boolean(badgeMap.redactionApproved);

    const embeddingId = await ctx.db.insert("skillEmbeddings", {
      skillId: skill._id,
      versionId,
      ownerId: userId,
      embedding: args.embedding,
      isLatest: isNewLatest,
      isApproved,
      visibility: embeddingVisibilityFor(isNewLatest, isApproved),
      updatedAt: now,
    });
    // Lightweight lookup so search hydration can skip reading the 12KB embedding doc
    await ctx.db.insert("embeddingSkillMap", {
      embeddingId,
      skillId: skill._id,
    });

    // Only demote the previous latest embedding when this publish actually
    // replaces `latest`. Backport publishes must leave the existing latest
    // embedding untouched so vector search keeps returning the right version.
    if (isNewLatest && latestBefore) {
      const previousEmbedding = await ctx.db
        .query("skillEmbeddings")
        .withIndex("by_version", (q) => q.eq("versionId", latestBefore))
        .unique();
      if (previousEmbedding) {
        await ctx.db.patch(previousEmbedding._id, {
          isLatest: false,
          visibility: embeddingVisibilityFor(false, previousEmbedding.isApproved),
          updatedAt: now,
        });
      }
    }

    await ctx.db.insert("skillVersionFingerprints", {
      skillId: skill._id,
      versionId,
      fingerprint: args.fingerprint,
      kind: "source",
      createdAt: now,
    });

    return { skillId: skill._id, versionId, embeddingId };
  },
});

export const getPendingVersionPublishArgsInternal = internalQuery({
  args: { versionId: v.id("skillVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) return null;
    const pendingPublication =
      version.pendingPublication &&
      typeof version.pendingPublication === "object" &&
      !Array.isArray(version.pendingPublication)
        ? (version.pendingPublication as { skillInsertArgs?: unknown })
        : null;
    return pendingPublication?.skillInsertArgs ?? null;
  },
});

export const discardPendingPublicationInternal = internalMutation({
  args: {
    skillId: v.id("skills"),
    versionId: v.id("skillVersions"),
    createdNewParent: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version || version.skillId !== args.skillId || version.publicationStatus !== "pending") {
      return { deleted: false };
    }

    const storageIds = new Set<Id<"_storage">>();
    for (const file of version.files ?? []) {
      if (typeof file.storageId === "string") {
        storageIds.add(file.storageId as Id<"_storage">);
      }
    }

    const fingerprints = await ctx.db
      .query("skillVersionFingerprints")
      .withIndex("by_version", (q) => q.eq("versionId", version._id))
      .take(100);
    for (const fingerprint of fingerprints) {
      await ctx.db.delete(fingerprint._id);
    }
    await ctx.db.delete(version._id);
    await Promise.allSettled([...storageIds].map((storageId) => ctx.storage.delete(storageId)));

    let parentDeleted = false;
    if (args.createdNewParent) {
      const skill = await ctx.db.get(args.skillId);
      if (skill && !skill.latestVersionId) {
        const remainingVersions = await ctx.db
          .query("skillVersions")
          .withIndex("by_skill", (q) => q.eq("skillId", args.skillId))
          .take(1);
        if (remainingVersions.length === 0) {
          await ctx.db.delete(args.skillId);
          parentDeleted = true;
        }
      }
    }

    return { deleted: true, parentDeleted };
  },
});

export const publishPendingVersionInternal = internalMutation({
  args: {
    versionId: v.id("skillVersions"),
    publishArgs: v.any(),
  },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version || version.softDeletedAt) {
      throw new ConvexError("Pending skill version not found.");
    }
    const skill = await ctx.db.get(version.skillId);
    if (!skill) throw new ConvexError("Skill not found.");

    const existingEmbedding = await ctx.db
      .query("skillEmbeddings")
      .withIndex("by_version", (q) => q.eq("versionId", version._id))
      .unique();
    if (version.publicationStatus === "published" || version.publicationStatus === undefined) {
      if (!existingEmbedding) {
        throw new ConvexError("Published skill version is missing its embedding.");
      }
      return {
        skillId: skill._id,
        versionId: version._id,
        embeddingId: existingEmbedding._id,
        publicationStatus: "published" as const,
      };
    }
    if (version.publicationStatus !== "pending") {
      throw new ConvexError(`Skill version is ${version.publicationStatus}, not pending.`);
    }

    const publishArgs = asSkillPendingPublishArgs(args.publishArgs);
    const user = await ctx.db.get(publishArgs.userId);
    if (!user || user.deletedAt || user.deactivatedAt) throw new Error("User not found");

    const now = Date.now();
    const prevLatestVersion = skill.latestVersionSummary?.version;
    const isNewLatest =
      !prevLatestVersion ||
      !semver.valid(prevLatestVersion) ||
      semver.gt(version.version, prevLatestVersion);
    const nextTags: Record<string, Id<"skillVersions">> = { ...skill.tags };
    if (isNewLatest) {
      nextTags.latest = version._id;
    }
    for (const tag of normalizeSkillTags(publishArgs.tags) ?? []) {
      if (tag.toLowerCase() === "latest") continue;
      nextTags[tag] = version._id;
    }

    const latestBefore = skill.latestVersionId;
    const derivedSummary =
      publishArgs.summary ??
      getFrontmatterValue(publishArgs.parsed.frontmatter, "description") ??
      skill.summary;
    const nextSummary = isNewLatest ? derivedSummary : skill.summary;
    const nextDisplayName = isNewLatest ? publishArgs.displayName : skill.displayName;
    const qualityAssessment = publishArgs.qualityAssessment;
    const isQualityQuarantine = qualityAssessment?.decision === "quarantine";
    const isPublisherUnderModeration = Boolean(user.requiresModerationAt);
    const initialModerationStatus =
      isQualityQuarantine || isPublisherUnderModeration ? "hidden" : "active";
    const moderationReason = isQualityQuarantine
      ? "quality.low"
      : isPublisherUnderModeration
        ? USER_MODERATION_REASON
        : "pending.scan";
    const moderationNotes = isQualityQuarantine
      ? `Auto-quarantined by quality gate (score=${qualityAssessment.score}, tier=${qualityAssessment.trustTier}, similar=${qualityAssessment.similarRecentCount}).`
      : isPublisherUnderModeration
        ? (user.requiresModerationReason ??
          "Publisher is currently under manual moderation review.")
        : undefined;
    const qualityRecord = qualityAssessment
      ? {
          score: qualityAssessment.score,
          decision: qualityAssessment.decision,
          trustTier: qualityAssessment.trustTier,
          similarRecentCount: qualityAssessment.similarRecentCount,
          reason: qualityAssessment.reason,
          signals: qualityAssessment.signals,
          evaluatedAt: now,
        }
      : undefined;

    const derivedFlags = deriveModerationFlags({
      skill: {
        slug: skill.slug,
        displayName: nextDisplayName,
        summary: nextSummary ?? undefined,
      },
      parsed: publishArgs.parsed,
      files: publishArgs.files,
    });
    const moderationSnapshot = buildModerationSnapshot({ sourceVersionId: version._id });
    const nextFlags = Array.from(
      new Set([...(derivedFlags ?? []), ...(moderationSnapshot.legacyFlags ?? [])]),
    );
    const versionForModeration = {
      ...version,
      staticScan: publishArgs.staticScan,
      llmAnalysis: publishArgs.llmAnalysis ?? version.llmAnalysis,
    };
    const scannerModerationPatch =
      versionForModeration.llmAnalysis && !isQualityQuarantine && !isPublisherUnderModeration
        ? buildScannerModerationPatchFromVersion({
            owner: null,
            version: versionForModeration,
            now,
          })
        : {};

    const basePatch: SkillModerationPatch = {
      displayName: nextDisplayName,
      summary: nextSummary ?? undefined,
      icon: skill.icon,
      ownerPublisherId: skill.ownerPublisherId ?? publishArgs.ownerPublisherId,
      latestVersionId: isNewLatest ? version._id : skill.latestVersionId,
      latestVersionSummary: isNewLatest
        ? {
            version: version.version,
            createdAt: version.createdAt,
            changelog: publishArgs.changelog,
            changelogSource: publishArgs.changelogSource,
            description: getFrontmatterValue(publishArgs.parsed.frontmatter, "description")?.trim(),
            clawdis: publishArgs.parsed.clawdis,
          }
        : skill.latestVersionSummary,
      tags: nextTags,
      categories: isNewLatest ? publishArgs.categories : skill.categories,
      topics: isNewLatest ? publishArgs.topics : skill.topics,
      ...(isNewLatest
        ? {
            inferredCategories: undefined,
            inferredTopics: undefined,
            inferredFromVersionId: undefined,
            inferredCategoryConfidence: undefined,
            inferredTopicConfidence: undefined,
            inferredClassifierVersion: undefined,
            inferredTopicClassifierVersion: undefined,
            inferredInputHash: undefined,
            inferredTopicInputHash: undefined,
            inferredAt: undefined,
          }
        : {}),
      stats: { ...skill.stats, versions: skill.stats.versions + 1 },
      softDeletedAt: undefined,
      moderationStatus: initialModerationStatus,
      moderationReason,
      moderationNotes,
      moderationVerdict: moderationSnapshot.verdict,
      moderationReasonCodes: moderationSnapshot.reasonCodes.length
        ? moderationSnapshot.reasonCodes
        : undefined,
      moderationEvidence: moderationSnapshot.evidence.length
        ? moderationSnapshot.evidence
        : undefined,
      moderationSummary: moderationSnapshot.summary,
      moderationEngineVersion: moderationSnapshot.engineVersion,
      moderationEvaluatedAt: moderationSnapshot.evaluatedAt,
      moderationSourceVersionId: version._id,
      quality: qualityRecord ?? skill.quality,
      moderationFlags: nextFlags.length ? nextFlags : undefined,
      isSuspicious: computeIsSuspicious({
        moderationFlags: nextFlags.length ? nextFlags : undefined,
        moderationReason,
      }),
      unpublishedSlugReservedUntil: undefined,
      unpublishedSlugReleasedAt: undefined,
      unpublishedOriginalSlug: undefined,
      updatedAt: now,
      ...scannerModerationPatch,
    };
    const patch = basePatch;
    const nextSkill = { ...skill, ...patch };

    await ctx.db.patch(version._id, {
      publicationStatus: "published",
      changelog: publishArgs.changelog,
      changelogSource: publishArgs.changelogSource,
      llmAnalysis: publishArgs.llmAnalysis ?? version.llmAnalysis,
    });
    await ctx.db.patch(skill._id, patch);
    await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);
    await adjustUserSkillStatsForSkillChange(ctx, skill, nextSkill);
    await syncSkillSearchDigestForSkillDoc(ctx, nextSkill);

    const badgeMap = await getSkillBadgeMap(ctx, skill._id);
    const isApproved = Boolean(badgeMap.redactionApproved);
    const embeddingId = existingEmbedding
      ? existingEmbedding._id
      : await ctx.db.insert("skillEmbeddings", {
          skillId: skill._id,
          versionId: version._id,
          ownerId: publishArgs.userId,
          embedding: publishArgs.embedding,
          isLatest: isNewLatest,
          isApproved,
          visibility: embeddingVisibilityFor(isNewLatest, isApproved),
          updatedAt: now,
        });
    if (!existingEmbedding) {
      await ctx.db.insert("embeddingSkillMap", {
        embeddingId,
        skillId: skill._id,
      });
    }

    if (isNewLatest && latestBefore) {
      const previousEmbedding = await ctx.db
        .query("skillEmbeddings")
        .withIndex("by_version", (q) => q.eq("versionId", latestBefore))
        .unique();
      if (previousEmbedding) {
        await ctx.db.patch(previousEmbedding._id, {
          isLatest: false,
          visibility: embeddingVisibilityFor(false, previousEmbedding.isApproved),
          updatedAt: now,
        });
      }
    }

    return {
      skillId: skill._id,
      versionId: version._id,
      embeddingId,
      publicationStatus: "published" as const,
    };
  },
});

async function isOwnerInitiatedSkillHideForActor(
  ctx: MutationCtx,
  skill: Pick<Doc<"skills">, "ownerUserId" | "ownerPublisherId" | "hiddenBy">,
  actorUserId: Id<"users">,
) {
  if (skill.hiddenBy === actorUserId) return true;
  if (!skill.hiddenBy) return false;

  const hiddenBy = await ctx.db.get(skill.hiddenBy);
  if (!hiddenBy || hiddenBy.deletedAt || hiddenBy.deactivatedAt) return false;
  if (hiddenBy.role === "admin" || hiddenBy.role === "moderator") return false;

  try {
    await assertCanManageOwnedResource(ctx, {
      actor: hiddenBy,
      ownerUserId: skill.ownerUserId,
      ownerPublisherId: skill.ownerPublisherId,
      allowedPublisherRoles: ["admin"],
    });
    return true;
  } catch (error) {
    if (error instanceof ConvexError || error instanceof Error) return false;
    throw error;
  }
}

async function isOwnerInitiatedSkillHideForAdminTransfer(
  ctx: MutationCtx,
  skill: Pick<
    Doc<"skills">,
    "_id" | "ownerUserId" | "ownerPublisherId" | "hiddenBy" | "softDeletedAt" | "forkOf"
  >,
) {
  if (!skill.hiddenBy || skill.softDeletedAt === undefined) return false;
  const softDeletedAt = skill.softDeletedAt;
  const hiddenBy = await ctx.db.get(skill.hiddenBy);
  if (!hiddenBy || hiddenBy.deletedAt || hiddenBy.deactivatedAt) return false;

  const hideAuditLogs = await ctx.db
    .query("auditLogs")
    .withIndex("by_target_createdAt", (q) =>
      q.eq("targetType", "skill").eq("targetId", skill._id).eq("createdAt", softDeletedAt),
    )
    .take(10);
  const hasOrdinaryOwnerDeleteAudit = hideAuditLogs.some((log) => {
    const metadata =
      typeof log.metadata === "object" && log.metadata !== null
        ? (log.metadata as Record<string, unknown>)
        : null;
    return (
      log.action === "skill.delete" &&
      log.actorUserId === skill.hiddenBy &&
      metadata?.actorRole === "user" &&
      metadata.softDeletedAt === softDeletedAt
    );
  });
  if (!hasOrdinaryOwnerDeleteAudit) return false;

  const duplicate = skill.forkOf?.kind === "duplicate" ? skill.forkOf : null;
  if (duplicate) {
    const relationshipAuditLogs = await ctx.db
      .query("auditLogs")
      .withIndex("by_target_createdAt", (q) =>
        q.eq("targetType", "skill").eq("targetId", skill._id).eq("createdAt", duplicate.at),
      )
      .take(10);
    const hasMergeProvenance = relationshipAuditLogs.some((log) => {
      const metadata =
        typeof log.metadata === "object" && log.metadata !== null
          ? (log.metadata as Record<string, unknown>)
          : null;
      return log.action === "skill.merge" && metadata?.targetSkillId === duplicate.skillId;
    });
    if (hasMergeProvenance) return false;
  }

  try {
    await assertCanManageOwnedResource(ctx, {
      actor: hiddenBy,
      ownerUserId: skill.ownerUserId,
      ownerPublisherId: skill.ownerPublisherId,
      allowedPublisherRoles: ["admin"],
    });
    return true;
  } catch (error) {
    if (error instanceof ConvexError || error instanceof Error) return false;
    throw error;
  }
}

export const setSkillSoftDeletedInternal = internalMutation({
  args: {
    userId: v.id("users"),
    slug: v.string(),
    deleted: v.boolean(),
    reason: v.optional(v.string()),
    ownerHandle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return setSkillSoftDeletedByActor(ctx, args);
  },
});

async function setSkillSoftDeletedByActor(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    slug?: string;
    skillId?: Id<"skills">;
    deleted: boolean;
    reason?: string;
    ownerHandle?: string;
  },
) {
  const user = await ctx.db.get(args.userId);
  if (!user || user.deletedAt || user.deactivatedAt) throw new Error("User not found");

  const requestedSlug = args.slug?.trim().toLowerCase();
  if (!args.skillId && !requestedSlug) throw new Error("Slug required");

  const resolved = args.skillId
    ? { skill: await ctx.db.get(args.skillId), ambiguous: false }
    : await resolveSkillBySlugOrAliasForOwner(ctx, requestedSlug!, args.ownerHandle, {
        includeSoftDeleted: true,
      });
  if (resolved.ambiguous) {
    throw new ConvexError("Slug is used by multiple publishers. Use an owner-qualified skill URL.");
  }
  const skill = resolved.skill;
  if (!skill) throw new Error("Skill not found");
  const slug = skill.slug;

  const isModeratorOrAdmin = user.role === "admin" || user.role === "moderator";
  let isOwner = skill.ownerUserId === args.userId;

  if (!isOwner) {
    try {
      await assertCanManageOwnedResource(ctx, {
        actor: user,
        ownerUserId: skill.ownerUserId,
        ownerPublisherId: skill.ownerPublisherId,
        allowedPublisherRoles: ["admin"],
      });
      isOwner = true;
    } catch {
      if (!isModeratorOrAdmin) {
        // Preserve legacy behavior: delegate to assertModerator to produce the
        // standard "Forbidden" error for non-owners without elevated roles.
        assertModerator(user);
      }
    }
  }
  if (args.deleted && skill.moderationStatus === "removed") {
    throw new ConvexError("Forbidden: Removed skills cannot be deleted.");
  }

  // Owner-delete provenance guard: an owner must NOT be able to "re-delete"
  // a skill that is currently in a non-owner-initiated hidden state. Such
  // a re-delete would rewrite `hiddenBy` to the owner (and clear
  // `moderationReason` via the data-hygiene reset below), erasing the
  // moderator/system provenance of the current hide and letting a
  // subsequent owner-undelete succeed — a privilege-escalation path where
  // the owner reverses moderator actions in two calls (delete, then
  // undelete).
  //
  // We only guard against hides whose current source is NOT the owner:
  //   - skill.hiddenBy === owner: the current hide was owner-initiated
  //     (e.g. a prior `clawhub delete`); re-delete is effectively a
  //     no-op and must remain idempotent.
  //   - skill.hiddenBy is some moderator/admin/system actor, OR is
  //     undefined while the row is hidden (e.g. `auto.reports` does not
  //     write hiddenBy): the hide is not owner-initiated, so block the
  //     owner from re-delete. Moderators/admins keep full access via the
  //     existing `isModeratorOrAdmin` branch.
  //
  // Staleness note: if a moderator previously restored the row
  // (`setSoftDeleted(deleted=false)`), `hiddenBy` is cleared and
  // `moderationStatus === "active"`, so this guard does NOT fire on
  // active rows — the existing data-hygiene reset continues to handle
  // stale `moderationReason` on active rows.
  if (args.deleted && isOwner && !isModeratorOrAdmin) {
    const isCurrentlyHidden = Boolean(skill.softDeletedAt) || skill.moderationStatus === "hidden";
    const isOwnerInitiatedHide = await isOwnerInitiatedSkillHideForActor(ctx, skill, args.userId);
    if (isCurrentlyHidden && !isOwnerInitiatedHide) {
      // Prefix with "Forbidden:" so HTTP boundary mappers
      // (softDeleteErrorToResponse) deterministically return 403 instead of
      // falling through to 500.
      throw new ConvexError(
        "Forbidden: This skill is currently hidden by moderation and cannot be re-deleted by the owner. Please contact a moderator.",
      );
    }
  }

  // gate: when an owner (without moderator/admin privileges) attempts to
  // undelete a skill, only allow it if the current hidden state was produced
  // by the owner themselves (i.e. via `clawhub delete`). Any other hidden
  // state originates from moderation, scanning, merges, bans, or security
  // redaction — only moderators/admins may lift those.
  //
  // Authorization is based on the *source of the current hide* (`hiddenBy`),
  // plus a small deny list of `moderationReason` values that are truly
  // bound to a non-owner current hide and therefore cannot be stale from
  // historical moderation metadata.
  //
  //   - `hiddenBy === args.userId` is the necessary baseline. A moderator
  //     hiding via `setSoftDeleted` records `hiddenBy = mod._id`, so the
  //     owner simply fails this check. A security redaction / auto-ban
  //     likewise records an admin/system actor, so those naturally fail.
  //   - The deny list below is intentionally narrow: each entry is a
  //     reason that is *only* set atomically with the current hide it
  //     describes, so it cannot be leftover historical metadata:
  //       * "owner.merged": merge mutation writes moderationReason,
  //         softDeletedAt, and hiddenBy as a single atomic patch; there
  //         is no flow that later restores the row while leaving this
  //         reason stale.
  //       * "user.banned": only written by the ban batch with
  //         hiddenBy = admin; unban clears softDeletedAt and rewrites
  //         moderationReason to "restored.unban", so a banned row never
  //         survives into an active state with this reason.
  //       * "security.redaction": paired with hiddenBy = security-admin;
  //         there is no owner-reachable path that lifts redaction while
  //         leaving this reason in place.
  //     Notably EXCLUDED:
  //       * "auto.reports" / "manual.report" — set by auto-hide or the
  //         moderator report-triage flow, but `setSoftDeleted(deleted=
  //         false)` (moderator restore) does NOT clear moderationReason.
  //         That means a row can be `moderationStatus="active"` with a
  //         stale `"auto.reports"` reason; if the owner later does a
  //         normal self-delete, `hiddenBy` becomes the owner and the
  //         current hide is owner-initiated, but the stale reason would
  //         still block self-undelete. These are therefore enforced
  //         solely via `hiddenBy !== owner` (auto.reports does not write
  //         hiddenBy; manual.report writes hiddenBy = mod._id).
  //       * "pending.scan.stale" / "pending.scan" / "scanner.*.*" — these
  //         describe the skill's moderation state, not the cause of the
  //         current hide, and must never block owner self-restore.
  //   - Benign scanner / pipeline reasons such as `pending.scan`,
  //     `scanner.aggregate.clean`, or `scanner.<scanner>.clean` describe
  //     the skill's moderation state, not the cause of the current hide,
  //     so they must NOT block owner self-restore.
  //   - If `hiddenBy` is somehow missing (legacy rows or incomplete
  //     provenance), fail closed and route the caller to a
  //     moderator.
  const moderationFlags = (skill.moderationFlags as string[] | undefined) ?? [];
  const isMalwareBlocked =
    moderationFlags.includes("blocked.malware") || skill.moderationVerdict === "malicious";
  if (!args.deleted && isOwner && !isModeratorOrAdmin) {
    // Defense-in-depth: regardless of `hiddenBy`/`moderationReason`
    // provenance, an owner must NEVER be able to restore a skill that any
    // scanner has marked malicious. This closes a class of bugs where a
    // stale owner-initiated hide is left in place while a later scanner
    // escalation upgrades the verdict to malicious without rewriting
    // provenance fields (e.g. the VT-only escalation path intentionally
    // does not overwrite `moderationReason` to preserve the LLM verdict).
    if (isMalwareBlocked) {
      throw new ConvexError(
        "Forbidden: This skill was blocked by automated malware detection and cannot be restored by the owner. Please contact a moderator.",
      );
    }

    // Reasons that are atomically bound to a non-owner current hide and
    // therefore cannot survive as stale historical metadata on an
    // owner-initiated hide. See the block comment above for why each is
    // included, and why report-related reasons are intentionally NOT.
    const OWNER_UNDELETE_DENIED_REASONS = new Set<string>([
      "owner.merged",
      "user.banned",
      "security.redaction",
    ]);
    const reason = skill.moderationReason as string | undefined;
    const ownerInitiatedHide =
      (await isOwnerInitiatedSkillHideForActor(ctx, skill, args.userId)) &&
      (reason === undefined || !OWNER_UNDELETE_DENIED_REASONS.has(reason));
    if (!ownerInitiatedHide) {
      // Prefix with "Forbidden:" so HTTP boundary mappers
      // (softDeleteErrorToResponse) deterministically return 403 instead of
      // falling through to 500. The suffix is preserved for clients that
      // surface a human-readable reason.
      throw new ConvexError(
        "Forbidden: This skill was hidden by moderation and cannot be restored by the owner. Please contact a moderator.",
      );
    }
  }

  let restoreVersion: Doc<"skillVersions"> | null = null;
  let restoreOwner: Doc<"users"> | null = null;
  if (!args.deleted) {
    [restoreVersion, restoreOwner] = await Promise.all([
      skill.latestVersionId ? ctx.db.get(skill.latestVersionId) : null,
      skill.ownerUserId ? ctx.db.get(skill.ownerUserId) : null,
    ]);
    const hasSecurityLock =
      isMalwareBlocked || isSkillSuspicious(skill) || isSkillReviewFlagged(skill);
    if (!restoreVersion && (skill.latestVersionId || hasSecurityLock)) {
      throw new ConvexError(
        "Forbidden: This skill's scanner state cannot be reconstructed, so it cannot be restored.",
      );
    }
  }

  const now = Date.now();
  const note = args.reason ? trimModerationNote(args.reason) : undefined;
  const slugReservedUntil =
    args.deleted && isOwner ? now + UNPUBLISHED_SLUG_RESERVATION_MS : undefined;
  const patch: Partial<Doc<"skills">> = {
    softDeletedAt: args.deleted ? now : undefined,
    moderationStatus: args.deleted || isMalwareBlocked ? "hidden" : "active",
    hiddenAt: args.deleted || isMalwareBlocked ? now : undefined,
    hiddenBy: args.deleted ? args.userId : undefined,
    unpublishedSlugReservedUntil: slugReservedUntil,
    unpublishedSlugReleasedAt: undefined,
    unpublishedOriginalSlug: undefined,
    lastReviewedAt: now,
    updatedAt: now,
  };
  if (note) patch.moderationNotes = note;
  if (!args.deleted && restoreVersion) {
    Object.assign(
      patch,
      buildScannerModerationPatchFromVersion({
        owner: restoreOwner,
        version: restoreVersion,
        now,
      }),
      { softDeletedAt: undefined, updatedAt: now },
    );
    if (note) patch.moderationNotes = note;
  }
  // Data hygiene: when an owner/org manager deletes, reset any stale
  // `moderationReason` that may have survived from prior moderation metadata.
  // This keeps the row's provenance fields consistent with the current hide
  // (owner-initiated) and prevents future restore/reservation checks from
  // tripping on historical reasons.
  if (args.deleted && isOwner) {
    patch.moderationReason = undefined;
  }
  const nextSkill = { ...skill, ...patch };
  await ctx.db.patch(skill._id, patch);
  await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);
  await adjustUserSkillStatsForSkillChange(ctx, skill, nextSkill);

  await setSkillEmbeddingsSoftDeleted(
    ctx,
    skill._id,
    Boolean(nextSkill.softDeletedAt || nextSkill.moderationStatus === "hidden"),
    now,
  );

  await ctx.db.insert("auditLogs", {
    actorUserId: args.userId,
    action: args.deleted ? "skill.delete" : "skill.undelete",
    targetType: "skill",
    targetId: skill._id,
    metadata: {
      slug,
      softDeletedAt: args.deleted ? now : null,
      actorRole: user.role ?? "user",
      ...(slugReservedUntil ? { slugReservedUntil } : {}),
      ...(note ? { reason: note } : {}),
    },
    createdAt: now,
  });

  return slugReservedUntil ? { ok: true as const, slugReservedUntil } : { ok: true as const };
}

export const hideSkillForSecurityRedactionInternal = internalMutation({
  args: {
    actorUserId: v.id("users"),
    slug: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor || actor.deletedAt || actor.deactivatedAt) throw new Error("Actor not found");

    const slug = args.slug.trim().toLowerCase();
    if (!slug) throw new Error("Slug required");

    const skill = await resolveUnambiguousSkillForLegacySlug(ctx, slug);
    if (!skill) throw new Error("Skill not found");
    if (skill.softDeletedAt) return { ok: true as const, changed: false as const };

    const now = Date.now();
    const note = trimModerationNote(args.reason);
    if (!note) throw new Error("Reason required");

    const patch: Partial<Doc<"skills">> = {
      softDeletedAt: now,
      moderationStatus: "hidden",
      moderationReason: "security.redaction",
      moderationNotes: note,
      hiddenAt: now,
      hiddenBy: actor._id,
      unpublishedSlugReservedUntil: undefined,
      unpublishedSlugReleasedAt: undefined,
      unpublishedOriginalSlug: undefined,
      lastReviewedAt: now,
      updatedAt: now,
    };
    const nextSkill = { ...skill, ...patch };
    await ctx.db.patch(skill._id, patch);
    await adjustGlobalPublicCountForSkillChange(ctx, skill, nextSkill);
    await adjustUserSkillStatsForSkillChange(ctx, skill, nextSkill);
    await setSkillEmbeddingsSoftDeleted(ctx, skill._id, true, now);

    await ctx.db.insert("auditLogs", {
      actorUserId: actor._id,
      action: "skill.delete.security_redaction",
      targetType: "skill",
      targetId: skill._id,
      metadata: {
        slug,
        softDeletedAt: now,
        reason: note,
      },
      createdAt: now,
    });

    return { ok: true as const, changed: true as const };
  },
});

function clampInt(value: number, min: number, max: number) {
  const rounded = Number.isFinite(value) ? Math.round(value) : min;
  return Math.min(max, Math.max(min, rounded));
}

async function findCanonicalSkillForFingerprint(
  ctx: { db: MutationCtx["db"] },
  fingerprint: string,
) {
  const matches = await ctx.db
    .query("skillVersionFingerprints")
    .withIndex("by_fingerprint", (q) => q.eq("fingerprint", fingerprint))
    .take(25);

  for (const entry of matches) {
    const skill = await ctx.db.get(entry.skillId);
    if (!skill || skill.softDeletedAt) continue;
    return skill;
  }

  return null;
}
export const listByDateRange = internalQuery({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const numItems = Math.max(
      1,
      Math.min(args.numItems ?? MAX_EXPORT_LIST_LIMIT, MAX_EXPORT_LIST_LIMIT),
    );
    const { startDate, endDate } = args;

    const decodedCursor = args.cursor
      ? decodePublicListCursor({
          cursor: args.cursor,
          indexName: "by_active_updated",
          maxIndexKeyLength: 2,
          eqPrefix: [undefined],
        })
      : null;
    if (args.cursor && !decodedCursor) {
      throw new Error("Invalid cursor format");
    }

    const isFirstPage = !decodedCursor;
    const startIndexKey: IndexKey = decodedCursor ?? [undefined, endDate];
    const endIndexKey: IndexKey = [undefined, startDate];

    const result = await getPage(ctx, {
      table: "skillSearchDigest",
      index: "by_active_updated",
      startIndexKey,
      startInclusive: isFirstPage,
      endIndexKey,
      endInclusive: true,
      order: "desc",
      absoluteMaxRows: numItems,
      schema,
    });

    let nextCursor: string | null = null;
    if (result.hasMore && result.indexKeys.length > 0) {
      nextCursor = encodeIndexKey(
        "by_active_updated",
        result.indexKeys[result.indexKeys.length - 1],
      );
    }

    return {
      page: result.page.filter(isExportableSkillDigest),
      nextCursor,
      hasMore: result.hasMore,
    };
  },
});

function isExportableSkillDigest(
  skill: Pick<
    Doc<"skillSearchDigest">,
    | "latestVersionId"
    | "installKind"
    | "githubCurrentStatus"
    | "githubScanStatus"
    | "softDeletedAt"
    | "moderationStatus"
    | "moderationFlags"
  >,
) {
  if (!isPublicSkillDoc(skill)) return false;
  if (skill.latestVersionId) return true;
  return (
    skill.installKind === "github" &&
    skill.githubCurrentStatus === "present" &&
    (skill.githubScanStatus === "clean" || skill.githubScanStatus === "suspicious")
  );
}

export const __test = {
  normalizePublicListSort,
  resolveRecommendedPublicListQuery,
  resolvePublicListDir,
};
