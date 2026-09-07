import {
  ApiRoutes,
  ApiV1PackageOfficialMigrationListResponseSchema,
  ApiV1PackageOfficialMigrationResponseSchema,
  ApiV1PackageValidationReportPageSchema,
  ApiV1PackageModerationStatusResponseSchema,
  ApiV1PackageSecurityResponseSchema,
  PackageHardDeleteRequestSchema,
  PackageAppealResolveRequestSchema,
  PackageAppealRequestSchema,
  PackageOfficialMigrationUpsertRequestSchema,
  PackageRepairNameRequestSchema,
  PackageRepairRuntimeIdRequestSchema,
  PackageReportRequestSchema,
  PackageReportTriageRequestSchema,
  PackageReleaseModerationRequestSchema,
  PackagePublishMetadataSchema,
  PackageTransferRequestSchema,
  PackageTrustedPublisherUpsertRequestSchema,
  PublishTokenMintRequestSchema,
  formatSecurityAuditOverview,
  normalizeContentType,
  isPluginCategorySlug,
  PLUGIN_CATEGORY_DEFINITIONS,
  parseArk,
  type PackagePublishMetadata,
  type PackageAppealListStatus,
  type PackageModerationQueueStatus,
  type PackageOfficialMigrationListPhase,
  type PackageReportListStatus,
  type PluginCategorySlug,
  type ServerPackagePublishRequest,
} from "clawhub-schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { buildDownloadMetricArgs, getDownloadIdentity } from "../downloadMetrics";
import { getOptionalActiveAuthUserIdFromAction } from "../lib/access";
import { getOptionalApiTokenUserId, requireApiTokenUser } from "../lib/apiTokenAuth";
import { parseClawPack, sha256Base64, sha256Hex } from "../lib/clawpack";
import { experimentalClawsEnabled } from "../lib/experimentalClaws";
import {
  fetchGitHubRepositoryIdentity,
  verifyGitHubActionsTrustedPublishJwt,
} from "../lib/githubActionsOidc";
import { corsHeaders, mergeHeaders } from "../lib/httpHeaders";
import { applyRateLimit } from "../lib/httpRateLimit";
import { verifyOpenClawPublishAuthorization } from "../lib/openClawPublishAuthorization";
import { getPackageReleaseArtifactSha256 } from "../lib/packageArtifacts";
import { tryNormalizePackageName } from "../lib/packageRegistry";
import {
  getPackageDownloadSecurityBlock,
  isPackageReleaseTrustStale,
  getPackageTrustReasons,
  resolvePackageReleaseScanStatus,
} from "../lib/packageSecurity";
import {
  getClawPackSizeError,
  getPackageMultipartSizeError,
  getPublishFileSizeError,
  getPublishTotalSizeError,
  isPackageMultipartUploadTooLarge,
  MAX_CLAWPACK_BYTES,
  MAX_PUBLISH_FILE_BYTES,
  MAX_PUBLISH_TOTAL_BYTES,
} from "../lib/publishLimits";
import { compareRecommendationStats } from "../lib/recommendationScore";
import { isCuratedSearchResult } from "../lib/searchRanking";
import {
  getPublicSkillVersionAccessBlock,
  getPublicSkillVersionDownloadBlock,
  getSkillFileModerationInfoFromSkill,
  isSkillVersionForSkill,
} from "../lib/skillFileAccess";
import { isMacJunkPath } from "../lib/skills";
import {
  buildDeterministicPackageZip,
  buildMergedExportZip,
  validateFilePath,
  type MergedExportManifestEntry,
} from "../lib/skillZip";
import { generateToken, hashToken } from "../lib/tokens";
import {
  MAX_RAW_FILE_BYTES,
  getPathSegments,
  json,
  parsePackagePathSegments,
  publicApiOrigin,
  resolveTagsBatch,
  requireApiTokenUserOrResponse,
  requireAdminOrResponse,
  requireModeratorOrResponse,
  requirePackagePublishAuthOrResponse,
  safeStoredFilePreviewResponse,
  safeStoredFileResponse,
  softDeleteErrorToResponse,
  ambiguousSkillSlugResponse,
  type AmbiguousSkillSlugChoice,
  formatAuthzMessage,
  formatUserFacingErrorMessage,
  text,
  toOptionalNumber,
} from "./shared";

const apiRefs = api as unknown as {
  packages: {
    listPublicPage: unknown;
    searchPublic: unknown;
  };
  skills: {
    listPackageCatalogPage: unknown;
    getBySlug: unknown;
    listVersionsPage: unknown;
    getVersionBySkillAndVersion: unknown;
  };
};
const internalRefs = internal as unknown as {
  packages: {
    countPublicPluginsInternal: unknown;
    getByNameForViewerInternal: unknown;
    hasMissingRecommendationScoresInternal: unknown;
    listPluginExportPageInternal: unknown;
    listPluginValidationReportPageInternal: unknown;
    listPageForViewerInternal: unknown;
    searchForViewerInternal: unknown;
    listVersionsForViewerInternal: unknown;
    getPackageByNameInternal: unknown;
    hardDeleteForAdminInternal: unknown;
    getTrustedPublisherByPackageIdInternal: unknown;
    getVersionByNameForViewerInternal: unknown;
    getVersionSecurityByNameForViewerInternal: unknown;
    publishPackageForUserInternal: unknown;
    publishPackageForTrustedPublisherInternal: unknown;
    setTrustedPublisherForUserInternal: unknown;
    transferPackageOwnerForUserInternal: unknown;
    deleteTrustedPublisherForUserInternal: unknown;
    deleteOwnedReleaseForUserInternal: unknown;
    restoreOwnedReleaseForUserInternal: unknown;
    getReleasesByIdsInternal: unknown;
    getReleaseByPackageAndVersionInternal: unknown;
    getReleaseByIdInternal: unknown;
    insertAuditLogInternal: unknown;
    recordPackageDownloadInternal: unknown;
    recordPackageInstallInternal: unknown;
    softDeletePackageInternal: unknown;
    restorePackageInternal: unknown;
    repairPackageIdentityInternal: unknown;
    moderatePackageReleaseForUserInternal: unknown;
    transferPackageOwnerInternal: unknown;
    reportPackageForUserInternal: unknown;
    listPackageReportsInternal: unknown;
    triagePackageReportForUserInternal: unknown;
    getPackageModerationStatusForUserInternal: unknown;
    submitPackageAppealForUserInternal: unknown;
    listPackageAppealsInternal: unknown;
    resolvePackageAppealForUserInternal: unknown;
    listOfficialPluginMigrationsInternal: unknown;
    upsertOfficialPluginMigrationForUserInternal: unknown;
    listPackageModerationQueueInternal: unknown;
    setPackageFeaturedForUserInternal: unknown;
  };
  downloadMetrics: {
    recordDownloadMetricInternal: unknown;
  };
  packagePublishTokens: {
    createInternal: unknown;
  };
  uploads: {
    consumePackagePublishUploadTicketInternal: unknown;
  };
  skills: {
    getSkillBySlugInternal: unknown;
    hasMissingPackageCatalogRecommendationScoresInternal: unknown;
    searchPackageCatalogForHttpInternal: unknown;
    getVersionByIdInternal: unknown;
    getVersionBySkillAndVersionInternal: unknown;
  };
  publishers: {
    getByHandleInternal: unknown;
  };
  securityScan: {
    requestPackageRescanForUserInternal: unknown;
  };
  publishAttempts: {
    getPackagePublishAttemptStatusInternal: unknown;
  };
};

function packageOperationErrorToResponse(
  error: unknown,
  headers: HeadersInit,
  fallback = "Package operation failed",
) {
  const message = formatUserFacingErrorMessage(error, fallback);
  const lower = message.toLowerCase();
  if (lower.includes("unauthorized"))
    return text(formatAuthzMessage(error, "Unauthorized"), 401, headers);
  if (lower.includes("forbidden"))
    return text(formatAuthzMessage(error, "Forbidden"), 403, headers);
  if (lower.includes("not found")) return text(message, 404, headers);
  return text(message, 400, headers);
}

async function readOptionalJson(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (!raw.trim()) return undefined;
  return JSON.parse(raw) as unknown;
}

function optionalStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function hasOwnField(value: unknown, key: string) {
  return Boolean(
    value &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value as Record<string, unknown>, key),
  );
}

function resolveVersionPathTarget(
  pathVersion: string | undefined,
  request: Request,
  body: unknown,
): { version?: string; error?: string } {
  const rawBodyVersion = optionalStringField(body, "version");
  if (hasOwnField(body, "version") && rawBodyVersion === undefined) {
    return { error: "Version must be a non-empty string" };
  }
  const version = pathVersion?.trim();
  const bodyVersion = rawBodyVersion?.trim();
  const queryVersions = new URL(request.url).searchParams
    .getAll("version")
    .map((queryVersion) => queryVersion.trim());
  if (
    !version ||
    (rawBodyVersion !== undefined && !bodyVersion) ||
    queryVersions.some((queryVersion) => !queryVersion)
  ) {
    return { error: "Version cannot be empty" };
  }
  if (
    (bodyVersion && bodyVersion !== version) ||
    queryVersions.some((queryVersion) => queryVersion !== version)
  ) {
    return { error: "Version does not match request target" };
  }
  return { version };
}

function hasVersionDeleteSelector(request: Request, body: unknown) {
  return hasOwnField(body, "version") || new URL(request.url).searchParams.has("version");
}

function versionDeleteRouteGuidance(basePath: string, request: Request, body: unknown) {
  const version =
    optionalStringField(body, "version")?.trim() ??
    new URL(request.url).searchParams.get("version")?.trim();
  return `Version deletion requires DELETE ${basePath}/versions/${
    version ? encodeURIComponent(version) : "<version>"
  }.`;
}

function isTransientConvexContentionMessage(message: string) {
  const lower = message.toLowerCase();
  return (
    lower.includes("optimistic concurrency") ||
    lower.includes("write conflict") ||
    (/documents read from or written to the ".+" table changed/.test(lower) &&
      lower.includes("while this mutation was being run"))
  );
}

function packagePublishErrorToResponse(error: unknown, headers: HeadersInit) {
  const message = formatUserFacingErrorMessage(error, "Publish failed");
  if (!isTransientConvexContentionMessage(message)) {
    return text(message, 400, headers);
  }
  return text(
    `Transient ClawHub write contention. Package validation was not the cause; retrying usually succeeds. ${message}`,
    503,
    mergeHeaders(headers, { "Retry-After": "1" }),
  );
}

async function runQueryRef<T>(ctx: ActionCtx, ref: unknown, args: unknown): Promise<T> {
  return (await ctx.runQuery(ref as never, args as never)) as T;
}

async function runActionRef<T>(ctx: ActionCtx, ref: unknown, args: unknown): Promise<T> {
  return (await ctx.runAction(ref as never, args as never)) as T;
}

async function runMutationRef<T>(ctx: ActionCtx, ref: unknown, args: unknown): Promise<T> {
  return (await ctx.runMutation(ref as never, args as never)) as T;
}

async function chunkedParallel<T, R>(
  items: T[],
  chunkSize: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const chunkResults = await Promise.all(chunk.map(fn));
    results.push(...chunkResults);
  }
  return results;
}

async function getOptionalViewerUserIdForRequest(ctx: ActionCtx, request: Request) {
  const apiTokenUserId = await getOptionalApiTokenUserId(ctx, request);
  if (apiTokenUserId) return apiTokenUserId;
  try {
    const userId = (await getOptionalActiveAuthUserIdFromAction(ctx)) ?? null;
    if (!userId) return null;
    return userId;
  } catch {
    // Public package reads should degrade to anonymous when cookie-backed auth is stale.
    return null;
  }
}

const PACKAGE_FAMILY_VALUES = ["skill", "code-plugin", "bundle-plugin"] as const;
const PACKAGE_FAMILY_VALUES_WITH_CLAWS = [...PACKAGE_FAMILY_VALUES, "claw"] as const;

function publicPackageFamilyValues() {
  return experimentalClawsEnabled() ? PACKAGE_FAMILY_VALUES_WITH_CLAWS : PACKAGE_FAMILY_VALUES;
}
const PLUGIN_EXPORT_FAMILY_VALUES = ["code-plugin", "bundle-plugin"] as const;
const PACKAGE_CHANNEL_VALUES = ["official", "community", "private"] as const;
const PACKAGE_LIST_SORT_VALUES = [
  "updated",
  "recommended",
  "downloads",
  "installs",
  "trending",
] as const;
const PACKAGE_SCAN_STATUS_VALUES = [
  "clean",
  "suspicious",
  "malicious",
  "pending",
  "not-run",
] as const;
const LEGACY_PLUGIN_CATEGORY_FILTER_ALIASES = {
  "mcp-tooling": "tools",
  data: "tools",
  observability: "gateway",
  automation: "tools",
  deployment: "gateway",
  "dev-tools": "runtime",
} as const satisfies Record<string, PluginCategorySlug>;
const MAX_PLUGIN_EXPORT_FILE_COUNT = 10_000;
const MAX_PLUGIN_EXPORT_PAGE_LIMIT = 250;
const DEFAULT_PLUGIN_EXPORT_PAGE_LIMIT = 250;
const MAX_PLUGIN_EXPORT_TOTAL_BYTES = 256 * 1024 * 1024;

function resolvePluginCategoryFilter(value: string | undefined): PluginCategorySlug | undefined {
  if (!value) return undefined;
  if (isPluginCategorySlug(value)) return value;
  if (!Object.hasOwn(LEGACY_PLUGIN_CATEGORY_FILTER_ALIASES, value)) return undefined;
  return LEGACY_PLUGIN_CATEGORY_FILTER_ALIASES[
    value as keyof typeof LEGACY_PLUGIN_CATEGORY_FILTER_ALIASES
  ];
}

function parseExcludedScanStatuses(value: string | null) {
  if (!value) return { ok: true as const, value: undefined };
  const statuses = [
    ...new Set(
      value
        .split(",")
        .map((status) => status.trim())
        .filter(Boolean),
    ),
  ];
  const invalid = statuses.find(
    (status) =>
      !PACKAGE_SCAN_STATUS_VALUES.includes(status as (typeof PACKAGE_SCAN_STATUS_VALUES)[number]),
  );
  if (invalid) return { ok: false as const, message: `Invalid excludeScanStatus: ${invalid}` };
  return {
    ok: true as const,
    value: statuses as Array<(typeof PACKAGE_SCAN_STATUS_VALUES)[number]>,
  };
}

function invalidQueryParamMessage(name: string) {
  return `Invalid ${name} query parameter`;
}

function parseEnumQueryParam<const T extends readonly string[]>(
  params: URLSearchParams,
  name: string,
  allowed: T,
): { ok: true; value: T[number] | undefined } | { ok: false; message: string } {
  if (!params.has(name)) return { ok: true, value: undefined };
  const value = params.get(name)?.trim() ?? "";
  if ((allowed as readonly string[]).includes(value)) return { ok: true, value };
  return { ok: false, message: invalidQueryParamMessage(name) };
}

function parseBooleanQueryParam(
  params: URLSearchParams,
  name: string,
): { ok: true; value: boolean | undefined } | { ok: false; message: string } {
  if (!params.has(name)) return { ok: true, value: undefined };
  const value = params.get(name)?.trim().toLowerCase() ?? "";
  if (value === "true" || value === "1") return { ok: true, value: true };
  if (value === "false" || value === "0") return { ok: true, value: false };
  return { ok: false, message: invalidQueryParamMessage(name) };
}

function parsePackageModerationQueueStatus(
  value: string | null,
): PackageModerationQueueStatus | null {
  if (!value) return "open";
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "open" ||
    normalized === "blocked" ||
    normalized === "manual" ||
    normalized === "all"
  ) {
    return normalized;
  }
  return null;
}

function parsePackageReportListStatus(value: string | null): PackageReportListStatus | null {
  if (!value) return "open";
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "open" ||
    normalized === "confirmed" ||
    normalized === "dismissed" ||
    normalized === "all"
  ) {
    return normalized;
  }
  return null;
}

function parsePackageAppealListStatus(value: string | null): PackageAppealListStatus | null {
  if (!value) return "open";
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "open" ||
    normalized === "accepted" ||
    normalized === "rejected" ||
    normalized === "all"
  ) {
    return normalized;
  }
  return null;
}

function parsePackageOfficialMigrationPhase(
  value: string | null,
): PackageOfficialMigrationListPhase | null {
  if (!value) return "all";
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "planned" ||
    normalized === "published" ||
    normalized === "clawpack-ready" ||
    normalized === "legacy-zip-only" ||
    normalized === "metadata-ready" ||
    normalized === "blocked" ||
    normalized === "ready-for-openclaw" ||
    normalized === "all"
  ) {
    return normalized;
  }
  return null;
}

type PackageListQueryArgs = {
  family?: "skill" | "code-plugin" | "bundle-plugin" | "claw";
  channel?: "official" | "community" | "private";
  isOfficial?: boolean;
  highlightedOnly?: boolean;
  category?: string;
  topic?: string;
  officialFirst?: boolean;
  excludedScanStatuses?: Array<(typeof PACKAGE_SCAN_STATUS_VALUES)[number]>;
  sort?: (typeof PACKAGE_LIST_SORT_VALUES)[number];
  viewerUserId?: Id<"users">;
  paginationOpts: { cursor: string | null; numItems: number };
};

type SkillPackageDocLike = {
  _id: Id<"skills">;
  slug: string;
  displayName: string;
  summary?: string | null;
  topics?: string[];
  latestVersionId?: Id<"skillVersions">;
  tags: Record<string, Id<"skillVersions">>;
  stats?: unknown;
  createdAt: number;
  updatedAt: number;
  badges?: { official?: unknown };
};

type SkillVersionLike = {
  _id: Id<"skillVersions">;
  skillId: Id<"skills">;
  version: string;
  createdAt: number;
  changelog: string;
  files: Array<{
    path: string;
    size: number;
    sha256: string;
    storageId?: Id<"_storage">;
    contentType?: string;
  }>;
  softDeletedAt?: number;
};

type ReleaseLike = {
  _id: Id<"packageReleases">;
  packageId: Id<"packages">;
  version: string;
  createdAt: number;
  changelog: string;
  distTags?: string[];
  files: Array<{
    path: string;
    size: number;
    sha256: string;
    storageId: Id<"_storage">;
    contentType?: string;
  }>;
  compatibility?: Doc<"packageReleases">["compatibility"];
  pluginManifestSummary?: Doc<"packageReleases">["pluginManifestSummary"];
  clawManifestSummary?: Doc<"packageReleases">["clawManifestSummary"];
  verification?: Doc<"packageReleases">["verification"];
  extractedPackageJson?: Doc<"packageReleases">["extractedPackageJson"];
  sha256hash?: string;
  vtAnalysis?: Doc<"packageReleases">["vtAnalysis"];
  skillSpectorAnalysis?: Doc<"packageReleases">["skillSpectorAnalysis"];
  llmAnalysis?: Doc<"packageReleases">["llmAnalysis"];
  staticScan?: Doc<"packageReleases">["staticScan"];
  manualModeration?: Doc<"packageReleases">["manualModeration"];
  integritySha256?: string;
  artifactKind?: Doc<"packageReleases">["artifactKind"];
  clawpackStorageId?: Doc<"packageReleases">["clawpackStorageId"];
  clawpackSha256?: string;
  clawpackSize?: number;
  clawpackFormat?: "tgz";
  npmIntegrity?: string;
  npmShasum?: string;
  npmTarballName?: string;
  npmUnpackedSize?: number;
  npmFileCount?: number;
  softDeletedAt?: number;
};

type PluginExportFamily = (typeof PLUGIN_EXPORT_FAMILY_VALUES)[number];

type PluginExportDigest = {
  packageId: Id<"packages">;
  name: string;
  displayName: string;
  family: PluginExportFamily;
  latestReleaseId?: Id<"packageReleases">;
  latestVersion?: string | null;
  createdAt: number;
  updatedAt: number;
  stats?: Record<string, unknown> | null;
  ownerUserId: Id<"users">;
  ownerHandle?: string | null;
  ownerDisplayName?: string | null;
};

type PackageTrustedPublisherLike = {
  _id: Id<"packageTrustedPublishers">;
  packageId: Id<"packages">;
  provider: "github-actions";
  repository: string;
  repositoryId: string;
  repositoryOwner: string;
  repositoryOwnerId: string;
  workflowFilename: string;
  environment?: string;
  createdAt: number;
  updatedAt: number;
};

type AdminRepairPackageLike = Pick<
  Doc<"packages">,
  | "_id"
  | "name"
  | "normalizedName"
  | "runtimeId"
  | "ownerUserId"
  | "ownerPublisherId"
  | "channel"
  | "softDeletedAt"
>;

type RepairOwnerPublisherLike = Pick<Doc<"publishers">, "_id" | "handle" | "deletedAt">;

function toVisibleRelease(release: ReleaseLike | null) {
  if (!release || ("softDeletedAt" in release && release.softDeletedAt !== undefined)) return null;
  return release;
}

function toPublicTrustedPublisher(trustedPublisher: PackageTrustedPublisherLike | null) {
  if (!trustedPublisher) return null;
  return {
    provider: trustedPublisher.provider,
    repository: trustedPublisher.repository,
    repositoryId: trustedPublisher.repositoryId,
    repositoryOwner: trustedPublisher.repositoryOwner,
    repositoryOwnerId: trustedPublisher.repositoryOwnerId,
    workflowFilename: trustedPublisher.workflowFilename,
    ...(trustedPublisher.environment ? { environment: trustedPublisher.environment } : {}),
  };
}

function toRepairPackageSnapshot(pkg: AdminRepairPackageLike) {
  return {
    packageId: String(pkg._id),
    name: pkg.normalizedName || pkg.name,
    runtimeId: pkg.runtimeId ?? null,
    ownerUserId: String(pkg.ownerUserId),
    ownerPublisherId: pkg.ownerPublisherId ? String(pkg.ownerPublisherId) : null,
    channel: pkg.channel,
    softDeletedAt: pkg.softDeletedAt ?? null,
  };
}

function defaultRetiredPackageName(name: string) {
  const yyyymmdd = new Date(Date.now()).toISOString().slice(0, 10).replaceAll("-", "");
  return `${name}-retired-${yyyymmdd}`;
}

function normalizePublisherHandleInput(value: string | undefined) {
  const normalized = value?.trim().replace(/^@+/, "").toLowerCase();
  return normalized || undefined;
}

function getReleaseSecurityBlock(release: ReleaseLike) {
  return getPackageDownloadSecurityBlock(release);
}

function toReleaseArtifact(release: ReleaseLike, packageName?: string) {
  if (release.artifactKind === "npm-pack") {
    return {
      kind: "npm-pack" as const,
      sha256: release.clawpackSha256,
      size: release.clawpackSize,
      format: release.clawpackFormat ?? "tgz",
      npmIntegrity: release.npmIntegrity,
      npmShasum: release.npmShasum,
      npmTarballName: release.npmTarballName,
      npmUnpackedSize: release.npmUnpackedSize,
      npmFileCount: release.npmFileCount,
    };
  }
  const sha256 = release.sha256hash;
  return {
    kind: "legacy-zip" as const,
    ...(sha256 ? { sha256 } : {}),
    ...(release.clawpackSize !== undefined ? { size: release.clawpackSize } : {}),
    format: "zip",
    source: "clawhub" as const,
    artifactKind: "legacy-zip" as const,
    ...(sha256 ? { artifactSha256: sha256 } : {}),
    packageName,
    version: release.version,
  };
}

function toPackageReleaseSecurityResponse(params: {
  request: Request;
  pkg: PublicPackageDocLike;
  release: ReleaseLike;
}) {
  const scanStatus = resolvePackageReleaseScanStatus(params.release);
  const artifactSha256 = getPackageReleaseArtifactSha256(params.release);
  const packageBlockedFromDownload = params.pkg.publicDownloadBlocked === true;
  const reasons = getPackageTrustReasons(params.release, scanStatus);
  if (packageBlockedFromDownload) reasons.push("package:malicious");
  return {
    overview: formatSecurityAuditOverview({ llmAnalysis: params.release.llmAnalysis }),
    securityAuditUrl: buildPackageSecurityAuditUrl(
      params.request,
      params.pkg.name,
      params.release.version,
    ),
    package: {
      name: params.pkg.name,
      displayName: params.pkg.displayName,
      family: params.pkg.family,
    },
    release: {
      releaseId: params.release._id,
      version: params.release.version,
      artifactKind: params.release.artifactKind ?? null,
      ...(artifactSha256 ? { artifactSha256 } : {}),
      ...(params.release.npmIntegrity ? { npmIntegrity: params.release.npmIntegrity } : {}),
      ...(params.release.npmShasum ? { npmShasum: params.release.npmShasum } : {}),
      ...(params.release.npmTarballName ? { npmTarballName: params.release.npmTarballName } : {}),
      createdAt: params.release.createdAt,
    },
    trust: {
      scanStatus,
      moderationState: params.release.manualModeration?.state ?? null,
      blockedFromDownload:
        packageBlockedFromDownload || getPackageDownloadSecurityBlock(params.release) !== null,
      reasons,
      pending: scanStatus === "pending" || scanStatus === "not-run",
      stale: isPackageReleaseTrustStale(params.release),
    },
  };
}

function buildPackageSecurityAuditUrl(request: Request, packageName: string, version: string) {
  const [scope, scopedName] = packageName.split("/");
  const path =
    scope?.startsWith("@") && scopedName
      ? `/${encodeURIComponent(scope.slice(1))}/plugins/${encodeURIComponent(scopedName)}/security-audit`
      : `/plugins/${encodeURIComponent(packageName)}/security-audit`;
  const url = new URL(path, publicApiOrigin(request));
  url.searchParams.set("version", version);
  return url.toString();
}

function encodePackagePath(name: string) {
  return name
    .split("/")
    .map((segment) =>
      segment.startsWith("@")
        ? `@${encodeURIComponent(segment.slice(1))}`
        : encodeURIComponent(segment),
    )
    .join("/");
}

function absoluteApiUrl(request: Request, path: string) {
  return new URL(path, publicApiOrigin(request)).toString();
}

function releaseArtifactUrls(request: Request, packageName: string, release: ReleaseLike) {
  const packagePath = encodePackagePath(packageName);
  const version = encodeURIComponent(release.version);
  const legacyDownloadUrl = absoluteApiUrl(
    request,
    `/api/v1/packages/${packagePath}/download?version=${version}`,
  );
  if (release.artifactKind !== "npm-pack") {
    return {
      downloadUrl: legacyDownloadUrl,
      legacyDownloadUrl,
    };
  }
  const tarball = encodeURIComponent(
    release.npmTarballName ??
      `${packageName.replace(/^@/, "").replace("/", "-")}-${release.version}.tgz`,
  );
  const tarballUrl = absoluteApiUrl(request, `/api/npm/${packagePath}/-/${tarball}`);
  return {
    downloadUrl: tarballUrl,
    tarballUrl,
    legacyDownloadUrl,
  };
}

async function streamClawPackRelease(
  ctx: ActionCtx,
  request: Request,
  rateHeaders: HeadersInit,
  pkg: PublicPackageDocLike,
  release: ReleaseLike,
  viewerUserId: Id<"users"> | null,
  statKind: "download" | "install" = "download",
) {
  const securityBlock = getReleaseSecurityBlock(release);
  if (securityBlock) return text(securityBlock.message, securityBlock.status, rateHeaders);
  if (release.artifactKind !== "npm-pack" || !release.clawpackStorageId) {
    return text("ClawPack artifact not found", 404, rateHeaders);
  }
  const blob = await ctx.storage.get(release.clawpackStorageId);
  if (!blob) return text("ClawPack artifact not found", 404, rateHeaders);
  try {
    const identity = getDownloadIdentity(request, viewerUserId ? String(viewerUserId) : null);
    const now = Date.now();
    const metricArgs = identity
      ? await buildDownloadMetricArgs({
          target: { kind: "package", id: pkg._id },
          identity,
          now,
        })
      : null;
    if (statKind === "install") {
      await runMutationRef(ctx, internalRefs.packages.recordPackageInstallInternal, {
        packageId: pkg._id,
        ...(metricArgs
          ? {
              identityKind: metricArgs.identityKind,
              identityHash: metricArgs.identityHash,
              dayStart: metricArgs.dayStart,
              occurredAt: metricArgs.occurredAt,
            }
          : {}),
      });
    }

    if (metricArgs) {
      await runMutationRef(
        ctx,
        internalRefs.downloadMetrics.recordDownloadMetricInternal,
        metricArgs,
      );
    }
  } catch {
    // Best-effort metric path; never fail package downloads.
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${release.npmTarballName ?? `${pkg.name.replaceAll("/", "-")}-${release.version}.tgz`}"`,
    "X-ClawHub-Artifact-Type": "npm-pack-tarball",
  };
  if (release.clawpackSha256) {
    headers.ETag = `"sha256:${release.clawpackSha256}"`;
    headers["X-ClawHub-Artifact-Sha256"] = release.clawpackSha256;
  }
  if (release.npmIntegrity) headers["X-ClawHub-Npm-Integrity"] = release.npmIntegrity;
  if (release.npmShasum) headers["X-ClawHub-Npm-Shasum"] = release.npmShasum;
  return new Response(blob, {
    status: 200,
    headers: mergeHeaders(rateHeaders, headers, corsHeaders()),
  });
}

async function resolvePackageTags(
  ctx: ActionCtx,
  tags: Record<string, Id<"packageReleases">>,
): Promise<Record<string, string>> {
  const releaseIds = Object.values(tags);
  if (releaseIds.length === 0) return {};
  const releases = await runQueryRef<ReleaseLike[]>(
    ctx,
    internalRefs.packages.getReleasesByIdsInternal,
    {
      releaseIds,
    },
  );
  const byId = new Map(releases.map((release) => [release._id, release.version]));
  return Object.fromEntries(
    Object.entries(tags)
      .map(([tag, releaseId]) => [tag, byId.get(releaseId)])
      .filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

type CatalogListItem = {
  name: string;
  displayName: string;
  family: "skill" | "code-plugin" | "bundle-plugin" | "claw";
  runtimeId?: string | null;
  channel: "official" | "community" | "private";
  isOfficial: boolean;
  summary?: string | null;
  ownerHandle?: string | null;
  createdAt: number;
  updatedAt: number;
  latestVersion?: string | null;
  featuredAt?: number;
  verificationTier?: string | null;
  stats?: { downloads: number; installs: number; stars: number; versions: number };
};

type CatalogSearchEntry = {
  score: number;
  rankTier?: number;
  package: CatalogListItem;
};

type CatalogSourceCursorState = {
  cursor: string | null;
  offset: number;
  pageSize: number | null;
  done: boolean;
};

type UnifiedCatalogCursorState = {
  packages: CatalogSourceCursorState;
  skills: CatalogSourceCursorState;
  recommendedFallback?: RecommendedFallbackSort;
  legacyInstallSort?: LegacyInstallSortMarker;
};

type PluginCatalogCursorState = {
  codePlugins: CatalogSourceCursorState;
  bundlePlugins: CatalogSourceCursorState;
  recommendedFallback?: RecommendedFallbackSort;
  legacyInstallSort?: LegacyInstallSortMarker;
};

type RecommendedFallbackSort = "updated" | "downloads";
type LegacyInstallSortMarker = "downloads";

type PackagePageCursorState = {
  cursor: string | null;
  legacyInstallSort?: LegacyInstallSortMarker;
};

type CatalogPageResult<T> = {
  page: T[];
  isDone: boolean;
  continueCursor: string;
};

type CatalogSourceState<T> = {
  state: CatalogSourceCursorState;
  page: CatalogPageResult<T> | null;
  pageCursor: string | null;
  index: number;
};

const UNIFIED_CATALOG_CURSOR_PREFIX = "pkgcatalog:";
const PLUGIN_CATALOG_CURSOR_PREFIX = "pkgplugins:";
const LEGACY_PLUGIN_SEARCH_CURSOR_PREFIX = "pkgpluginsearch:";
const SKILL_CATALOG_CURSOR_PREFIX = "skillcat:";
const PACKAGE_PAGE_CURSOR_PREFIX = "pkgpage:";
const RECOMMENDED_FALLBACK_SORT = "downloads" as const;
const CATALOG_CURSOR_PREFIXES = [
  UNIFIED_CATALOG_CURSOR_PREFIX,
  PLUGIN_CATALOG_CURSOR_PREFIX,
  LEGACY_PLUGIN_SEARCH_CURSOR_PREFIX,
  SKILL_CATALOG_CURSOR_PREFIX,
  PACKAGE_PAGE_CURSOR_PREFIX,
];

function normalizeRecommendedFallbackSort(value: unknown): RecommendedFallbackSort | undefined {
  if (value === "installs") return "downloads";
  return value === "updated" || value === RECOMMENDED_FALLBACK_SORT ? value : undefined;
}

function defaultCatalogSourceCursorState(): CatalogSourceCursorState {
  return { cursor: null, offset: 0, pageSize: null, done: false };
}

function readObjectField(input: unknown, field: string): unknown {
  if (input === null || typeof input !== "object") return undefined;
  return Object.getOwnPropertyDescriptor(input, field)?.value;
}

function normalizeCatalogSourceCursorState(input: unknown): CatalogSourceCursorState {
  const cursor = readObjectField(input, "cursor");
  const offset = readObjectField(input, "offset");
  const pageSize = readObjectField(input, "pageSize");
  const done = readObjectField(input, "done");
  return {
    cursor: typeof cursor === "string" ? cursor : null,
    offset: typeof offset === "number" && offset > 0 ? offset : 0,
    pageSize: typeof pageSize === "number" && pageSize > 0 ? pageSize : null,
    done: done === true,
  };
}

function encodeUnifiedCatalogCursor(state: UnifiedCatalogCursorState) {
  return `${UNIFIED_CATALOG_CURSOR_PREFIX}${JSON.stringify(state)}`;
}

function isKnownCatalogCursor(raw: string | null | undefined) {
  return Boolean(raw && CATALOG_CURSOR_PREFIXES.some((prefix) => raw.startsWith(prefix)));
}

function decodeUnifiedCatalogCursor(raw: string | null | undefined): UnifiedCatalogCursorState {
  if (!raw?.startsWith(UNIFIED_CATALOG_CURSOR_PREFIX)) {
    return {
      packages: {
        ...defaultCatalogSourceCursorState(),
        cursor: isKnownCatalogCursor(raw) ? null : (raw ?? null),
      },
      skills: defaultCatalogSourceCursorState(),
    };
  }
  try {
    const parsed: unknown = JSON.parse(raw.slice(UNIFIED_CATALOG_CURSOR_PREFIX.length));
    const recommendedFallbackValue = readObjectField(parsed, "recommendedFallback");
    const resetLegacyInstallCursorState = recommendedFallbackValue === "installs";
    return {
      packages: resetLegacyInstallCursorState
        ? defaultCatalogSourceCursorState()
        : normalizeCatalogSourceCursorState(readObjectField(parsed, "packages")),
      skills: resetLegacyInstallCursorState
        ? defaultCatalogSourceCursorState()
        : normalizeCatalogSourceCursorState(readObjectField(parsed, "skills")),
      recommendedFallback: normalizeRecommendedFallbackSort(recommendedFallbackValue),
    };
  } catch {
    return {
      packages: defaultCatalogSourceCursorState(),
      skills: defaultCatalogSourceCursorState(),
    };
  }
}

function encodePluginCatalogCursor(state: PluginCatalogCursorState) {
  return `${PLUGIN_CATALOG_CURSOR_PREFIX}${JSON.stringify(state)}`;
}

function encodePackagePageCursor(state: PackagePageCursorState) {
  return `${PACKAGE_PAGE_CURSOR_PREFIX}${JSON.stringify(state)}`;
}

function parsePrefixedCursorPayload(raw: string | null | undefined, prefix: string): unknown {
  if (!raw?.startsWith(prefix)) return null;
  try {
    return JSON.parse(raw.slice(prefix.length));
  } catch {
    return null;
  }
}

function hasDownloadsMappedLegacyInstallCursor(raw: string | null | undefined, prefix: string) {
  const payload = parsePrefixedCursorPayload(raw, prefix);
  return readObjectField(payload, "legacyInstallSort") === "downloads";
}

function normalizeLegacyInstallAggregateCursor(raw: string | null, prefix: string) {
  if (!raw) return null;
  return hasDownloadsMappedLegacyInstallCursor(raw, prefix) ? raw : null;
}

function decodeLegacyInstallPageCursor(raw: string | null) {
  const payload = parsePrefixedCursorPayload(raw, PACKAGE_PAGE_CURSOR_PREFIX);
  if (readObjectField(payload, "legacyInstallSort") !== "downloads") return null;
  const cursor = readObjectField(payload, "cursor");
  return typeof cursor === "string" ? cursor : null;
}

function legacyInstallSortMarker(isLegacyInstallSortRequest: boolean) {
  return isLegacyInstallSortRequest ? ("downloads" as const) : undefined;
}

function decodeMultiPluginCursor(
  raw: string | null | undefined,
  prefix: string,
): PluginCatalogCursorState {
  if (!raw?.startsWith(prefix)) {
    return {
      codePlugins: {
        ...defaultCatalogSourceCursorState(),
        cursor: isKnownCatalogCursor(raw) ? null : (raw ?? null),
      },
      bundlePlugins: defaultCatalogSourceCursorState(),
    };
  }
  try {
    const parsed: unknown = JSON.parse(raw.slice(prefix.length));
    const recommendedFallbackValue = readObjectField(parsed, "recommendedFallback");
    const resetLegacyInstallCursorState = recommendedFallbackValue === "installs";
    return {
      codePlugins: resetLegacyInstallCursorState
        ? defaultCatalogSourceCursorState()
        : normalizeCatalogSourceCursorState(readObjectField(parsed, "codePlugins")),
      bundlePlugins: resetLegacyInstallCursorState
        ? defaultCatalogSourceCursorState()
        : normalizeCatalogSourceCursorState(readObjectField(parsed, "bundlePlugins")),
      recommendedFallback: normalizeRecommendedFallbackSort(recommendedFallbackValue),
    };
  } catch {
    return {
      codePlugins: defaultCatalogSourceCursorState(),
      bundlePlugins: defaultCatalogSourceCursorState(),
    };
  }
}

function decodePluginCatalogCursor(raw: string | null | undefined): PluginCatalogCursorState {
  return decodeMultiPluginCursor(raw, PLUGIN_CATALOG_CURSOR_PREFIX);
}

function initCatalogSource<T>(state: CatalogSourceCursorState): CatalogSourceState<T> {
  return {
    state: { ...state },
    page: null,
    pageCursor: state.cursor,
    index: state.offset,
  };
}

function finalizeCatalogSource<T>(source: CatalogSourceState<T>): CatalogSourceCursorState {
  if (!source.page) return source.state;
  if (source.index < source.page.page.length) {
    return {
      cursor: source.pageCursor,
      offset: source.index,
      pageSize: source.state.pageSize,
      done: false,
    };
  }
  return {
    cursor: source.page.continueCursor,
    offset: 0,
    pageSize: source.state.pageSize,
    done: source.page.isDone,
  };
}

async function ensureCatalogSourcePage<T>(
  source: CatalogSourceState<T>,
  pageSize: number,
  fetchPage: (cursor: string | null, pageSize: number) => Promise<CatalogPageResult<T>>,
) {
  while (true) {
    if (!source.page) {
      if (source.state.done && source.state.offset === 0) return null;
      const effectivePageSize = source.state.pageSize ?? pageSize;
      source.pageCursor = source.state.cursor;
      source.page = await fetchPage(source.pageCursor, effectivePageSize);
      source.state.pageSize = effectivePageSize;
      source.index = source.state.offset;
    }

    if (source.index < source.page.page.length) {
      return source.page.page[source.index];
    }

    if (source.page.isDone) return null;

    source.state.cursor = source.page.continueCursor;
    source.state.offset = 0;
    source.state.done = source.page.isDone;
    source.page = null;
    source.pageCursor = source.state.cursor;
    source.index = 0;
  }
}

function compareCatalogItems(a: CatalogListItem, b: CatalogListItem) {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  if (a.family !== b.family) return a.family.localeCompare(b.family);
  return a.name.localeCompare(b.name);
}

function normalizePublicPackageSort(sort: (typeof PACKAGE_LIST_SORT_VALUES)[number] | undefined) {
  return sort === "installs" ? "downloads" : sort;
}

function compareCatalogItemsForSort(
  a: CatalogListItem,
  b: CatalogListItem,
  sort: (typeof PACKAGE_LIST_SORT_VALUES)[number] | undefined,
) {
  if (sort === "recommended") {
    const score = compareRecommendationStats(
      {
        downloads: a.stats?.downloads ?? 0,
        installs: a.stats?.installs ?? 0,
        stars: a.stats?.stars ?? 0,
      },
      {
        downloads: b.stats?.downloads ?? 0,
        installs: b.stats?.installs ?? 0,
        stars: b.stats?.stars ?? 0,
      },
    );
    if (score !== 0) return score;
  }
  if (sort === "downloads" || sort === "installs") {
    const downloads = (b.stats?.downloads ?? 0) - (a.stats?.downloads ?? 0);
    if (downloads !== 0) return downloads;
  }
  return compareCatalogItems(a, b);
}

function compareCatalogSearchEntries(a: CatalogSearchEntry, b: CatalogSearchEntry) {
  return (
    Number(
      isCuratedSearchResult({
        isOfficial: b.package.isOfficial,
        featured: typeof b.package.featuredAt === "number",
      }),
    ) -
      Number(
        isCuratedSearchResult({
          isOfficial: a.package.isOfficial,
          featured: typeof a.package.featuredAt === "number",
        }),
      ) ||
    (a.rankTier ?? Number.POSITIVE_INFINITY) - (b.rankTier ?? Number.POSITIVE_INFINITY) ||
    b.score - a.score ||
    Number(b.package.isOfficial) - Number(a.package.isOfficial) ||
    compareCatalogItems(a.package, b.package)
  );
}

function toPublicCatalogSearchEntry(entry: CatalogSearchEntry) {
  return {
    score: entry.score,
    package: entry.package,
  };
}

async function searchPackageCatalog(
  ctx: ActionCtx,
  args: {
    query: string;
    limit: number;
    family?: "skill" | "code-plugin" | "bundle-plugin" | "claw";
    channel?: "official" | "community" | "private";
    isOfficial?: boolean;
    highlightedOnly?: boolean;
    createdAfter?: number;
    category?: string;
    topic?: string;
    excludedScanStatuses?: Array<(typeof PACKAGE_SCAN_STATUS_VALUES)[number]>;
    viewerUserId?: Id<"users">;
  },
): Promise<CatalogSearchEntry[]> {
  return await runQueryRef<CatalogSearchEntry[]>(
    ctx,
    internalRefs.packages.searchForViewerInternal,
    {
      query: args.query,
      limit: args.limit,
      family: args.family,
      channel: args.channel,
      isOfficial: args.isOfficial,
      highlightedOnly: args.highlightedOnly,
      createdAfter: args.createdAfter,
      category: args.category,
      topic: args.topic,
      excludedScanStatuses: args.excludedScanStatuses,
      viewerUserId: args.viewerUserId,
    },
  );
}

async function resolveSkillTags(
  ctx: ActionCtx,
  skillId: Id<"skills">,
  tags: Record<string, Id<"skillVersions">>,
  latestVersion?: SkillVersionLike | null,
): Promise<Record<string, string>> {
  const [resolved] = await resolveTagsBatch(ctx, [tags], [latestVersion], [skillId]);
  return resolved ?? {};
}

function isSkillOfficial(skill: SkillPackageDocLike) {
  return Boolean(skill.badges?.official);
}

function toSkillPackageDetail(
  skill: SkillPackageDocLike,
  latestVersion: SkillVersionLike | null,
  owner: { handle?: string; displayName?: string; image?: string } | null,
  resolvedTags: Record<string, string>,
) {
  return {
    package: {
      name: skill.slug,
      displayName: skill.displayName,
      family: "skill" as const,
      runtimeId: null,
      channel: isSkillOfficial(skill) ? ("official" as const) : ("community" as const),
      isOfficial: isSkillOfficial(skill),
      summary: skill.summary ?? null,
      topics: skill.topics,
      ownerHandle: owner?.handle ?? null,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
      latestVersion: latestVersion?.version ?? null,
      tags: resolvedTags,
      compatibility: null,
      verification: null,
    },
    owner: owner
      ? {
          handle: owner.handle ?? null,
          displayName: owner.displayName ?? null,
          image: owner.image ?? null,
        }
      : null,
  };
}

function toPackageDetailResponsePackage(pkg: PublicPackageDocLike) {
  const {
    capabilityTags: _capabilityTags,
    capabilities: _capabilities,
    executesCode: _executesCode,
    ...publicPackage
  } = pkg as PublicPackageDocLike & {
    capabilityTags?: unknown;
    capabilities?: unknown;
    executesCode?: unknown;
  };
  return publicPackage;
}

function skillVersionTags(tags: Record<string, string>, version: string) {
  return Object.entries(tags)
    .filter(([, taggedVersion]) => taggedVersion === version)
    .map(([tag]) => tag);
}

type StoredPackagePublishFile = ServerPackagePublishRequest["files"][number];
type PackagePublishTarballArtifact = NonNullable<ServerPackagePublishRequest["artifact"]>;
type ParsedPackageClawPack = Awaited<ReturnType<typeof parseClawPack>>;
type PackagePublishAuth =
  | { kind: "user"; userId: Id<"users"> }
  | { kind: "github-actions"; publishToken: Doc<"packagePublishTokens"> };
type PackagePublishTarballPart =
  | { kind: "file"; file: File }
  | {
      kind: "storage";
      storageId: Id<"_storage">;
      uploadTicket: Id<"packagePublishUploadTickets">;
    };

function defaultStoredPackageContentType() {
  return "application/octet-stream";
}

function bytesToArrayBuffer(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function storeClawPackFile(
  ctx: ActionCtx,
  entry: { path: string; bytes: Uint8Array },
): Promise<StoredPackagePublishFile> {
  const contentType = defaultStoredPackageContentType();
  const storageId = await ctx.storage.store(
    new Blob([bytesToArrayBuffer(entry.bytes)], { type: contentType }),
  );
  return {
    path: entry.path,
    size: entry.bytes.byteLength,
    storageId,
    sha256: await sha256Hex(entry.bytes),
    contentType,
  };
}

// Convex actions have a tight memory ceiling, so bound in-flight Blob copies by
// bytes as well as count. Storing thousands of small files one at a time
// otherwise pushes large ClawPacks past clients' publish request timeouts.
const CLAWPACK_STORE_BATCH_BYTES = 8 * 1024 * 1024;
const CLAWPACK_STORE_BATCH_FILES = 16;

async function deleteUnpublishedPackagePublishBlobs(
  ctx: ActionCtx,
  stored: {
    files?: Array<{ storageId: string }>;
    artifact?: { storageId?: string } | null;
  },
) {
  const remove = ctx.storage.delete?.bind(ctx.storage);
  if (!remove) {
    return;
  }
  const storageIds: string[] = [];
  for (const file of stored.files ?? []) {
    storageIds.push(file.storageId);
  }
  if (stored.artifact?.storageId) {
    storageIds.push(stored.artifact.storageId);
  }
  await Promise.allSettled(storageIds.map((storageId) => remove(storageId as Id<"_storage">)));
}

async function storeClawPackFiles(
  ctx: ActionCtx,
  entries: Array<{ path: string; bytes: Uint8Array }>,
) {
  const files: StoredPackagePublishFile[] = [];
  let batch: Array<{ path: string; bytes: Uint8Array }> = [];
  let batchBytes = 0;
  const flush = async () => {
    const results = await Promise.allSettled(batch.map((entry) => storeClawPackFile(ctx, entry)));
    for (const result of results) {
      if (result.status === "fulfilled") {
        files.push(result.value);
      }
    }
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") {
      throw rejected.reason;
    }
    batch = [];
    batchBytes = 0;
  };
  try {
    for (const entry of entries) {
      const overflows =
        batch.length >= CLAWPACK_STORE_BATCH_FILES ||
        batchBytes + entry.bytes.byteLength > CLAWPACK_STORE_BATCH_BYTES;
      if (batch.length > 0 && overflows) await flush();
      batch.push(entry);
      batchBytes += entry.bytes.byteLength;
    }
    if (batch.length > 0) await flush();
    return files;
  } catch (error) {
    await deleteUnpublishedPackagePublishBlobs(ctx, { files });
    throw error;
  }
}

async function storeUploadedPackageFile(
  ctx: ActionCtx,
  entry: File,
): Promise<StoredPackagePublishFile> {
  if (entry.size > MAX_PUBLISH_FILE_BYTES) {
    throw new Error(getPublishFileSizeError(entry.name));
  }
  const buffer = new Uint8Array(await entry.arrayBuffer());
  const contentType = normalizeContentType(entry.type) ?? defaultStoredPackageContentType();
  const storageId = await ctx.storage.store(
    new Blob([bytesToArrayBuffer(buffer)], { type: contentType }),
  );
  return {
    path: entry.name,
    size: entry.size,
    storageId,
    sha256: await sha256Hex(buffer),
    contentType,
  };
}

function getFileParts(form: FormData, fields: readonly string[], stringPartError: string) {
  const parts = fields.flatMap((field) => form.getAll(field));
  if (parts.some((entry) => typeof entry === "string")) {
    throw new Error(stringPartError);
  }
  return parts.filter((entry): entry is File => typeof entry !== "string");
}

function getTarballPart(form: FormData): PackagePublishTarballPart | null {
  const parts = form.getAll("clawpack");
  if (parts.length > 1) throw new Error("Upload one package tarball");
  const ticketParts = form.getAll("clawpackUploadTicket");
  if (ticketParts.length > 1) throw new Error("Upload one package tarball ticket");
  const ticketPart = ticketParts[0];
  if (ticketPart && typeof ticketPart !== "string") {
    throw new Error("Package tarball upload ticket must be a string");
  }
  const part = parts[0];
  if (!part) {
    if (ticketPart) throw new Error("Package tarball upload ticket requires a staged ClawPack");
    return null;
  }
  if (typeof part !== "string") {
    if (ticketPart) throw new Error("Package tarball upload ticket requires a staged ClawPack");
    return { kind: "file", file: part };
  }

  const storageId = part.trim();
  if (!storageId) throw new Error("Package tarball storage id required");
  const uploadTicket = ticketPart?.trim();
  if (!uploadTicket) throw new Error("Package tarball upload ticket required");
  return {
    kind: "storage",
    storageId: storageId as Id<"_storage">,
    uploadTicket: uploadTicket as Id<"packagePublishUploadTickets">,
  };
}

async function consumePackageTarballUploadTicket(
  ctx: ActionCtx,
  auth: PackagePublishAuth,
  part: Extract<PackagePublishTarballPart, { kind: "storage" }>,
) {
  await ctx.runMutation(
    internalRefs.uploads.consumePackagePublishUploadTicketInternal as never,
    {
      uploadTicket: part.uploadTicket,
      storageId: part.storageId,
      auth:
        auth.kind === "user"
          ? { kind: "user", userId: auth.userId }
          : { kind: "github-actions", publishTokenId: auth.publishToken._id },
    } as never,
  );
}

async function readStoredPackageTarball(ctx: ActionCtx, storageId: Id<"_storage">) {
  const blob = await ctx.storage.get(storageId);
  if (!blob) throw new Error("Package tarball upload no longer exists");
  if (blob.size > MAX_CLAWPACK_BYTES) {
    throw new Error(getClawPackSizeError("uploaded ClawPack"));
  }
  return new Uint8Array(await blob.arrayBuffer());
}

async function buildPackagePublishRequestFromClawPack(
  ctx: ActionCtx,
  metadata: PackagePublishMetadata,
  parsed: ParsedPackageClawPack,
  artifactBytes: Uint8Array,
  artifactStorageId: Id<"_storage">,
): Promise<ServerPackagePublishRequest> {
  if (parsed.unpackedSize > MAX_PUBLISH_TOTAL_BYTES) {
    throw new Error(getPublishTotalSizeError("package"));
  }
  const artifact: PackagePublishTarballArtifact = {
    kind: "npm-pack",
    storageId: artifactStorageId,
    sha256: parsed.artifactSha256,
    size: artifactBytes.byteLength,
    format: "tgz",
    npmIntegrity: parsed.npmIntegrity,
    npmShasum: parsed.npmShasum,
    npmTarballName: parsed.npmTarballName,
    npmUnpackedSize: parsed.unpackedSize,
    npmFileCount: parsed.fileCount,
  };
  try {
    const files = await storeClawPackFiles(ctx, parsed.entries);
    return { ...metadata, files, artifact };
  } catch (error) {
    // Extracted-file store failed after the tarball was already written.
    await deleteUnpublishedPackagePublishBlobs(ctx, { artifact });
    throw error;
  }
}

function assertClawPackPublicationIdentity(
  metadata: PackagePublishMetadata,
  parsed: ParsedPackageClawPack,
) {
  if (metadata.family !== "claw") return;
  const expectedName = tryNormalizePackageName(metadata.name);
  if (!expectedName || parsed.packageName !== expectedName) {
    throw new Error(
      `Claw package name mismatch: expected ${expectedName ?? metadata.name}, got ${parsed.packageName}`,
    );
  }
  const expectedVersion = metadata.version.trim();
  if (parsed.packageVersion !== expectedVersion) {
    throw new Error(
      `Claw package version mismatch: expected ${expectedVersion}, got ${parsed.packageVersion}`,
    );
  }
  const expectedDigest = metadata.expectedArtifactSha256?.trim().toLowerCase();
  if (!expectedDigest) throw new Error("Claw publication requires expectedArtifactSha256");
  if (expectedDigest !== parsed.artifactSha256) {
    throw new Error(
      `Claw artifact SHA-256 mismatch: expected ${expectedDigest}, got ${parsed.artifactSha256}`,
    );
  }
}

const PACKAGE_PUBLISH_FILE_FIELDS = ["files"] as const;
const PACKAGE_PUBLISH_TARBALL_FIELDS = ["clawpack"] as const;
const PACKAGE_PUBLISH_FORM_FIELDS = new Set([
  "payload",
  ...PACKAGE_PUBLISH_FILE_FIELDS,
  ...PACKAGE_PUBLISH_TARBALL_FIELDS,
  "clawpackUploadTicket",
]);

function multipartUploadPart(file: File) {
  return {
    name: file.name,
    size: file.size,
    type: file.type || undefined,
  };
}

async function parseMultipartPackagePublish(
  ctx: ActionCtx,
  auth: PackagePublishAuth,
  request: Request,
): Promise<ServerPackagePublishRequest> {
  const form = await request.formData();
  for (const field of form.keys()) {
    if (!PACKAGE_PUBLISH_FORM_FIELDS.has(field)) {
      throw new Error(`Unsupported package publish form field: ${field}`);
    }
  }

  const payloadParts = form.getAll("payload");
  const payloadRaw = payloadParts[0];
  if (payloadParts.length !== 1 || typeof payloadRaw !== "string") {
    throw new Error("Package publish payload must be one JSON string");
  }
  const parsedPayload: unknown = JSON.parse(payloadRaw);
  const metadata: PackagePublishMetadata = parseArk(
    PackagePublishMetadataSchema,
    parsedPayload,
    "Package publish payload",
  );
  if (metadata.family === "claw" && !experimentalClawsEnabled()) {
    throw new Error("Experimental Claw publication is disabled");
  }

  const tarballPart = getTarballPart(form);
  const fileParts = getFileParts(
    form,
    PACKAGE_PUBLISH_FILE_FIELDS,
    "Package publish file uploads must be files",
  );
  if (metadata.family === "claw" && !tarballPart) {
    throw new Error("Claw publication requires an already-built package tarball (.tgz)");
  }

  if (tarballPart) {
    if (fileParts.length > 0) {
      throw new Error("Upload either a package tarball or individual files, not both");
    }
    if (tarballPart.kind === "storage") {
      await consumePackageTarballUploadTicket(ctx, auth, tarballPart);
      const artifactBytes = await readStoredPackageTarball(ctx, tarballPart.storageId);
      const parsed = await parseClawPack(artifactBytes);
      assertClawPackPublicationIdentity(metadata, parsed);
      return await buildPackagePublishRequestFromClawPack(
        ctx,
        metadata,
        parsed,
        artifactBytes,
        tarballPart.storageId,
      );
    }

    const tarballEntry = tarballPart.file;
    if (tarballEntry.size > MAX_CLAWPACK_BYTES) {
      throw new Error(getClawPackSizeError(tarballEntry.name));
    }
    if (
      isPackageMultipartUploadTooLarge({
        payloadJson: payloadRaw,
        fileFieldName: "clawpack",
        files: [multipartUploadPart(tarballEntry)],
      })
    ) {
      throw new Error(getPackageMultipartSizeError());
    }
    const artifactBytes = new Uint8Array(await tarballEntry.arrayBuffer());
    const parsed = await parseClawPack(artifactBytes);
    assertClawPackPublicationIdentity(metadata, parsed);
    const artifactStorageId = await ctx.storage.store(
      new Blob([bytesToArrayBuffer(artifactBytes)], { type: "application/octet-stream" }),
    );
    return await buildPackagePublishRequestFromClawPack(
      ctx,
      metadata,
      parsed,
      artifactBytes,
      artifactStorageId,
    );
  }

  if (
    isPackageMultipartUploadTooLarge({
      payloadJson: payloadRaw,
      fileFieldName: "files",
      files: fileParts.map(multipartUploadPart),
    })
  ) {
    throw new Error(getPackageMultipartSizeError());
  }

  const packageFileParts = fileParts.filter((entry) => !isMacJunkPath(entry.name));
  const files: StoredPackagePublishFile[] = [];
  try {
    const results = await Promise.allSettled(
      packageFileParts.map((entry) => storeUploadedPackageFile(ctx, entry)),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        files.push(result.value);
      }
    }
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") {
      throw rejected.reason;
    }
    if (files.length === 0) throw new Error("files required");
    return { ...metadata, files };
  } catch (error) {
    await deleteUnpublishedPackagePublishBlobs(ctx, { files });
    throw error;
  }
}

async function listPackages(
  ctx: ActionCtx,
  request: Request,
  family?: PackageListQueryArgs["family"],
  options?: {
    defaultSort?: (typeof PACKAGE_LIST_SORT_VALUES)[number];
    includeSkills?: boolean;
    pluginFamilies?: Array<"code-plugin" | "bundle-plugin">;
  },
) {
  const rate = await applyRateLimit(ctx, request, "read");
  if (!rate.ok) return rate.response;

  const url = new URL(request.url);
  const viewerUserId = await getOptionalViewerUserIdForRequest(ctx, request);
  const limit = Math.max(1, Math.min(toOptionalNumber(url.searchParams.get("limit")) ?? 25, 100));
  const rawCursor = url.searchParams.get("cursor");
  const familyParam = parseEnumQueryParam(url.searchParams, "family", publicPackageFamilyValues());
  if (!familyParam.ok) return text(familyParam.message, 400, rate.headers);
  const channelParam = parseEnumQueryParam(url.searchParams, "channel", PACKAGE_CHANNEL_VALUES);
  if (!channelParam.ok) return text(channelParam.message, 400, rate.headers);
  const isOfficial = parseBooleanQueryParam(url.searchParams, "isOfficial");
  if (!isOfficial.ok) return text(isOfficial.message, 400, rate.headers);
  const featured = parseBooleanQueryParam(url.searchParams, "featured");
  if (!featured.ok) return text(featured.message, 400, rate.headers);
  const highlightedOnlyParam = parseBooleanQueryParam(url.searchParams, "highlightedOnly");
  if (!highlightedOnlyParam.ok) return text(highlightedOnlyParam.message, 400, rate.headers);
  const sortParam = parseEnumQueryParam(url.searchParams, "sort", PACKAGE_LIST_SORT_VALUES);
  if (!sortParam.ok) return text(sortParam.message, 400, rate.headers);
  const rawCategory = url.searchParams.get("category")?.trim() || undefined;
  const category = resolvePluginCategoryFilter(rawCategory);
  const topic = url.searchParams.get("topic")?.trim().toLowerCase() || undefined;
  const officialFirst = parseBooleanQueryParam(url.searchParams, "officialFirst");
  if (!officialFirst.ok) return text(officialFirst.message, 400, rate.headers);
  const excludedScanStatuses = parseExcludedScanStatuses(url.searchParams.get("excludeScanStatus"));
  if (!excludedScanStatuses.ok) {
    return text(excludedScanStatuses.message, 400, rate.headers);
  }
  if (rawCategory && !category) {
    return text("Invalid plugin category", 400, rate.headers);
  }
  const effectiveFamily = family ?? familyParam.value;
  const includeSkills = options?.includeSkills ?? effectiveFamily === undefined;
  const highlightedOnly = featured.value === true || highlightedOnlyParam.value === true;
  const pluginDefaultSort =
    options?.defaultSort === "recommended" &&
    options.pluginFamilies?.length &&
    !includeSkills &&
    (highlightedOnly || category)
      ? RECOMMENDED_FALLBACK_SORT
      : options?.defaultSort;
  const isLegacyInstallSortRequest = sortParam.value === "installs";
  const effectiveSort = normalizePublicPackageSort(sortParam.value ?? pluginDefaultSort);
  if (
    category &&
    (effectiveFamily === "skill" ||
      effectiveFamily === "claw" ||
      (!effectiveFamily && includeSkills))
  ) {
    return text(
      "Plugin category is only supported for plugin package endpoints",
      400,
      rate.headers,
    );
  }
  if (effectiveSort === "trending" && (includeSkills || effectiveFamily === "claw")) {
    return text(
      "Trending sort is only supported for plugin package endpoints; use /api/v1/skills?sort=trending for skills.",
      400,
      rate.headers,
    );
  }

  if (effectiveFamily === "skill") {
    const cursor = isLegacyInstallSortRequest
      ? decodeLegacyInstallPageCursor(rawCursor)
      : rawCursor;
    const result = await runQueryRef<{
      page: CatalogListItem[];
      isDone: boolean;
      continueCursor: string | null;
    }>(ctx, apiRefs.skills.listPackageCatalogPage, {
      channel: channelParam.value,
      isOfficial: isOfficial.value,
      highlightedOnly: highlightedOnly || undefined,
      topic,
      sort: effectiveSort,
      paginationOpts: { cursor, numItems: limit },
    });
    return json(
      {
        items: result.page,
        nextCursor: result.isDone
          ? null
          : isLegacyInstallSortRequest
            ? encodePackagePageCursor({
                cursor: result.continueCursor,
                legacyInstallSort: "downloads",
              })
            : result.continueCursor,
      },
      200,
      rate.headers,
    );
  }

  if (!effectiveFamily && includeSkills) {
    const cursor = isLegacyInstallSortRequest
      ? normalizeLegacyInstallAggregateCursor(rawCursor, UNIFIED_CATALOG_CURSOR_PREFIX)
      : rawCursor;
    const decodedCursor = decodeUnifiedCatalogCursor(cursor);
    const isFreshRecommendedRequest = effectiveSort === "recommended" && !cursor;
    const [hasMissingPackageRecommendationScores, hasMissingSkillRecommendationScores] =
      isFreshRecommendedRequest
        ? await Promise.all([
            runQueryRef<boolean>(
              ctx,
              internalRefs.packages.hasMissingRecommendationScoresInternal,
              {},
            ),
            runQueryRef<boolean>(
              ctx,
              internalRefs.skills.hasMissingPackageCatalogRecommendationScoresInternal,
              {},
            ),
          ])
        : [false, false];
    const recommendedFallback =
      effectiveSort === "recommended"
        ? (decodedCursor.recommendedFallback ??
          (isFreshRecommendedRequest &&
          (hasMissingPackageRecommendationScores || hasMissingSkillRecommendationScores)
            ? RECOMMENDED_FALLBACK_SORT
            : undefined))
        : undefined;
    const unifiedListSort = recommendedFallback ?? effectiveSort;
    const packageSource = initCatalogSource<CatalogListItem>(decodedCursor.packages);
    const skillSource = initCatalogSource<CatalogListItem>(decodedCursor.skills);
    const pageSize = limit;
    const items: CatalogListItem[] = [];

    while (items.length < limit) {
      const [packageCandidate, skillCandidate] = await Promise.all([
        ensureCatalogSourcePage(packageSource, pageSize, async (pageCursor, numItems) => {
          const result = await runQueryRef<{
            page: CatalogListItem[];
            isDone: boolean;
            continueCursor: string | null;
          }>(ctx, internalRefs.packages.listPageForViewerInternal, {
            channel: channelParam.value,
            isOfficial: isOfficial.value,
            highlightedOnly: highlightedOnly || undefined,
            category,
            topic,
            officialFirst: officialFirst.value,
            excludedScanStatuses: excludedScanStatuses.value,
            sort: unifiedListSort,
            viewerUserId: viewerUserId ?? undefined,
            paginationOpts: { cursor: pageCursor, numItems },
          });
          return {
            page: result.page,
            isDone: result.isDone,
            continueCursor: result.continueCursor ?? "",
          };
        }),
        ensureCatalogSourcePage(skillSource, pageSize, async (pageCursor, numItems) => {
          const result = await runQueryRef<{
            page: CatalogListItem[];
            isDone: boolean;
            continueCursor: string | null;
          }>(ctx, apiRefs.skills.listPackageCatalogPage, {
            channel: channelParam.value,
            isOfficial: isOfficial.value,
            highlightedOnly: highlightedOnly || undefined,
            topic,
            sort: unifiedListSort,
            paginationOpts: { cursor: pageCursor, numItems },
          });
          return {
            page: result.page,
            isDone: result.isDone,
            continueCursor: result.continueCursor ?? "",
          };
        }),
      ]);

      if (!packageCandidate && !skillCandidate) break;
      if (
        !skillCandidate ||
        (packageCandidate &&
          compareCatalogItemsForSort(packageCandidate, skillCandidate, unifiedListSort) <= 0)
      ) {
        items.push(packageCandidate!);
        packageSource.index += 1;
      } else {
        items.push(skillCandidate);
        skillSource.index += 1;
      }
    }

    const nextState = {
      packages: finalizeCatalogSource(packageSource),
      skills: finalizeCatalogSource(skillSource),
      recommendedFallback,
      legacyInstallSort: legacyInstallSortMarker(isLegacyInstallSortRequest),
    };
    const isDoneAll =
      nextState.packages.done &&
      nextState.packages.offset === 0 &&
      nextState.skills.done &&
      nextState.skills.offset === 0;
    return json(
      {
        items,
        nextCursor: isDoneAll ? null : encodeUnifiedCatalogCursor(nextState),
      },
      200,
      rate.headers,
    );
  }

  if (!effectiveFamily && options?.pluginFamilies?.length && effectiveSort === "trending") {
    const result = await runQueryRef<{
      page: CatalogListItem[];
      isDone: boolean;
      continueCursor: string | null;
    }>(ctx, internalRefs.packages.listPageForViewerInternal, {
      channel: channelParam.value,
      isOfficial: isOfficial.value,
      highlightedOnly: highlightedOnly || undefined,
      category,
      topic,
      excludedScanStatuses: excludedScanStatuses.value,
      sort: "trending",
      viewerUserId: viewerUserId ?? undefined,
      paginationOpts: { cursor: rawCursor, numItems: limit },
    });
    return json(
      {
        items: result.page,
        nextCursor: result.isDone ? null : result.continueCursor,
      },
      200,
      rate.headers,
    );
  }

  if (!effectiveFamily && options?.pluginFamilies?.length && highlightedOnly) {
    const result = await runQueryRef<{
      page: CatalogListItem[];
      isDone: boolean;
      continueCursor: string | null;
    }>(ctx, internalRefs.packages.listPageForViewerInternal, {
      families: options.pluginFamilies,
      channel: channelParam.value,
      isOfficial: isOfficial.value,
      highlightedOnly: true,
      category,
      topic,
      excludedScanStatuses: excludedScanStatuses.value,
      viewerUserId: viewerUserId ?? undefined,
      paginationOpts: { cursor: rawCursor, numItems: limit },
    });
    return json(
      {
        items: result.page,
        nextCursor: result.isDone ? null : result.continueCursor,
      },
      200,
      rate.headers,
    );
  }

  if (!effectiveFamily && options?.pluginFamilies?.length) {
    const shouldMarkDefaultDownloadCursor =
      !sortParam.value && pluginDefaultSort === RECOMMENDED_FALLBACK_SORT;
    const cursor =
      isLegacyInstallSortRequest || shouldMarkDefaultDownloadCursor
        ? normalizeLegacyInstallAggregateCursor(rawCursor, PLUGIN_CATALOG_CURSOR_PREFIX)
        : rawCursor;
    const includeTotalCount =
      !includeSkills &&
      !category &&
      !topic &&
      !channelParam.value &&
      typeof isOfficial.value !== "boolean" &&
      !highlightedOnly &&
      !excludedScanStatuses.value?.length;
    const totalCount = includeTotalCount
      ? await runQueryRef<number | null>(ctx, internalRefs.packages.countPublicPluginsInternal, {})
      : null;
    const decodedCursor = decodePluginCatalogCursor(cursor);
    const codePluginSource = initCatalogSource<CatalogListItem>(decodedCursor.codePlugins);
    const bundlePluginSource = initCatalogSource<CatalogListItem>(decodedCursor.bundlePlugins);
    const isFreshRecommendedRequest = effectiveSort === "recommended" && !cursor;
    const hasMissingRecommendationScores = isFreshRecommendedRequest
      ? await runQueryRef<boolean>(
          ctx,
          internalRefs.packages.hasMissingRecommendationScoresInternal,
          {
            families: options.pluginFamilies,
          },
        )
      : false;
    const recommendedFallback =
      effectiveSort === "recommended"
        ? (decodedCursor.recommendedFallback ??
          (isFreshRecommendedRequest && hasMissingRecommendationScores
            ? RECOMMENDED_FALLBACK_SORT
            : undefined))
        : undefined;
    const pluginListSort = recommendedFallback ?? effectiveSort;
    const pageSize = limit;
    const items: CatalogListItem[] = [];
    const fetchPluginPage = async (
      pluginFamily: "code-plugin" | "bundle-plugin",
      pageCursor: string | null,
      numItems: number,
    ) => {
      const result = await runQueryRef<{
        page: CatalogListItem[];
        isDone: boolean;
        continueCursor: string | null;
      }>(ctx, internalRefs.packages.listPageForViewerInternal, {
        family: pluginFamily,
        channel: channelParam.value,
        isOfficial: isOfficial.value,
        highlightedOnly: highlightedOnly || undefined,
        category,
        topic,
        officialFirst: officialFirst.value,
        excludedScanStatuses: excludedScanStatuses.value,
        sort: pluginListSort,
        viewerUserId: viewerUserId ?? undefined,
        paginationOpts: { cursor: pageCursor, numItems },
      });
      return {
        page: result.page,
        isDone: result.isDone,
        continueCursor: result.continueCursor ?? "",
      };
    };

    while (items.length < limit) {
      const [codePluginCandidate, bundlePluginCandidate] = await Promise.all([
        options.pluginFamilies.includes("code-plugin")
          ? ensureCatalogSourcePage(codePluginSource, pageSize, (pageCursor, numItems) =>
              fetchPluginPage("code-plugin", pageCursor, numItems),
            )
          : Promise.resolve(null),
        options.pluginFamilies.includes("bundle-plugin")
          ? ensureCatalogSourcePage(bundlePluginSource, pageSize, (pageCursor, numItems) =>
              fetchPluginPage("bundle-plugin", pageCursor, numItems),
            )
          : Promise.resolve(null),
      ]);

      if (!codePluginCandidate && !bundlePluginCandidate) break;
      if (
        !bundlePluginCandidate ||
        (codePluginCandidate &&
          ((officialFirst.value
            ? Number(bundlePluginCandidate.isOfficial) - Number(codePluginCandidate.isOfficial)
            : 0) ||
            compareCatalogItemsForSort(
              codePluginCandidate,
              bundlePluginCandidate,
              pluginListSort,
            )) <= 0)
      ) {
        items.push(codePluginCandidate!);
        codePluginSource.index += 1;
      } else {
        items.push(bundlePluginCandidate);
        bundlePluginSource.index += 1;
      }
    }

    const nextState = {
      codePlugins: finalizeCatalogSource(codePluginSource),
      bundlePlugins: finalizeCatalogSource(bundlePluginSource),
      recommendedFallback,
      legacyInstallSort: legacyInstallSortMarker(
        isLegacyInstallSortRequest || shouldMarkDefaultDownloadCursor,
      ),
    };
    const isDoneAll =
      nextState.codePlugins.done &&
      nextState.codePlugins.offset === 0 &&
      nextState.bundlePlugins.done &&
      nextState.bundlePlugins.offset === 0;
    return json(
      {
        items,
        nextCursor: isDoneAll ? null : encodePluginCatalogCursor(nextState),
        ...(totalCount !== null ? { totalCount } : {}),
      },
      200,
      rate.headers,
    );
  }

  const cursor = isLegacyInstallSortRequest ? decodeLegacyInstallPageCursor(rawCursor) : rawCursor;
  const result = await runQueryRef<{
    page: unknown[];
    isDone: boolean;
    continueCursor: string | null;
  }>(ctx, internalRefs.packages.listPageForViewerInternal, {
    family: effectiveFamily,
    channel: channelParam.value,
    isOfficial: isOfficial.value,
    highlightedOnly: highlightedOnly || undefined,
    category,
    topic,
    officialFirst: officialFirst.value,
    excludedScanStatuses: excludedScanStatuses.value,
    sort: effectiveSort,
    viewerUserId: viewerUserId ?? undefined,
    paginationOpts: { cursor, numItems: limit },
  } satisfies PackageListQueryArgs);
  return json(
    {
      items: result.page,
      nextCursor: result.isDone
        ? null
        : isLegacyInstallSortRequest
          ? encodePackagePageCursor({
              cursor: result.continueCursor,
              legacyInstallSort: "downloads",
            })
          : result.continueCursor,
    },
    200,
    rate.headers,
  );
}

export async function listPackagesV1Handler(ctx: ActionCtx, request: Request) {
  return await listPackages(ctx, request, undefined, { includeSkills: true });
}

type PluginsExportPhase =
  | "list_plugins"
  | "build_empty_zip"
  | "load_releases"
  | "plan_blobs"
  | "load_blobs"
  | "assemble_entries"
  | "build_zip";

type PluginsExportLogContext = {
  phase: PluginsExportPhase;
  startDate: number;
  endDate: number;
  family: PluginExportFamily | null;
  limit: number;
  cursorPresent: boolean;
  pageLength: number;
  hasMore: boolean | null;
  nextCursorPresent: boolean | null;
  releaseCount: number;
  blobTaskCount: number;
  blobCount: number;
  zipEntryCount: number;
  manifestCount: number;
  exportErrorCount: number;
  totalExportBytes: number;
};

function logPluginsExportFailure(context: PluginsExportLogContext, error: unknown) {
  console.error("plugins_export_failed", {
    ...context,
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage:
      error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
  });
}

function parsePluginExportFamily(value: string | null) {
  const family = value?.trim();
  if (!family) return undefined;
  return PLUGIN_EXPORT_FAMILY_VALUES.includes(family as PluginExportFamily)
    ? (family as PluginExportFamily)
    : null;
}

function isReleaseForPackage(release: ReleaseLike, digest: PluginExportDigest) {
  return release.packageId === digest.packageId;
}

function pluginExportRoot(digest: PluginExportDigest) {
  return `${digest.family}/${digest.name}`;
}

function pluginExportMetaPath(digest: PluginExportDigest) {
  return `__clawhub_export/${pluginExportRoot(digest)}/plugin_meta.json`;
}

export async function exportPluginsV1Handler(ctx: ActionCtx, request: Request) {
  try {
    await requireApiTokenUser(ctx, request);
  } catch (err) {
    return text(err instanceof Error ? err.message : "Unauthorized", 401);
  }

  const rate = await applyRateLimit(ctx, request, "export");
  if (!rate.ok) return rate.response;

  const url = new URL(request.url);
  const startDate = toOptionalNumber(url.searchParams.get("startDate"));
  const endDate = toOptionalNumber(url.searchParams.get("endDate"));
  const requestedLimit = toOptionalNumber(url.searchParams.get("limit"));
  const cursor = url.searchParams.get("cursor")?.trim() || undefined;
  const family = parsePluginExportFamily(url.searchParams.get("family"));

  if (family === null) {
    return text("family must be code-plugin or bundle-plugin", 400, rate.headers);
  }
  if (startDate == null || endDate == null) {
    return text(
      "startDate and endDate query parameters are required (Unix milliseconds)",
      400,
      rate.headers,
    );
  }
  if (startDate > endDate) {
    return text("startDate must be <= endDate", 400, rate.headers);
  }
  if (requestedLimit != null && requestedLimit > MAX_PLUGIN_EXPORT_PAGE_LIMIT) {
    return text(`limit must be <= ${MAX_PLUGIN_EXPORT_PAGE_LIMIT}`, 400, rate.headers);
  }
  const limit = Math.max(1, requestedLimit ?? DEFAULT_PLUGIN_EXPORT_PAGE_LIMIT);

  const logContext: PluginsExportLogContext = {
    phase: "list_plugins",
    startDate,
    endDate,
    family: family ?? null,
    limit,
    cursorPresent: Boolean(cursor),
    pageLength: 0,
    hasMore: null,
    nextCursorPresent: null,
    releaseCount: 0,
    blobTaskCount: 0,
    blobCount: 0,
    zipEntryCount: 0,
    manifestCount: 0,
    exportErrorCount: 0,
    totalExportBytes: 0,
  };

  let result: {
    page: PluginExportDigest[];
    nextCursor: string | null;
    hasMore: boolean;
  };
  try {
    result = await runQueryRef(ctx, internalRefs.packages.listPluginExportPageInternal, {
      startDate,
      endDate,
      cursor,
      numItems: limit,
      family,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Invalid cursor format")) {
      return text("Invalid cursor format", 400, rate.headers);
    }
    logPluginsExportFailure(logContext, err);
    throw err;
  }
  logContext.pageLength = result.page.length;
  logContext.hasMore = result.hasMore;
  logContext.nextCursorPresent = Boolean(result.nextCursor);

  const familyLabel = family ?? "all";
  if (result.page.length === 0) {
    try {
      logContext.phase = "build_empty_zip";
      const emptyZip = buildMergedExportZip([], []);
      return new Response(emptyZip as unknown as BodyInit, {
        status: 200,
        headers: mergeHeaders(rate.headers, {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="plugins-export-${familyLabel}-${startDate}-${endDate}-empty.zip"`,
          "X-Next-Cursor": result.nextCursor ?? "",
          "X-Has-More": String(result.hasMore),
          "X-Total-Returned": "0",
          "X-Date-Range": `${startDate}-${endDate}`,
          "X-Export-Errors": "0",
        }),
      });
    } catch (err) {
      logPluginsExportFailure(logContext, err);
      throw err;
    }
  }

  const exportErrors: Array<{ package: string; error: string }> = [];

  try {
    logContext.phase = "load_releases";
    const releases = await chunkedParallel(result.page, 100, (digest) =>
      digest.latestReleaseId
        ? runQueryRef<ReleaseLike | null>(ctx, internalRefs.packages.getReleaseByIdInternal, {
            releaseId: digest.latestReleaseId,
          })
        : Promise.resolve(null),
    );
    logContext.releaseCount = releases.filter(Boolean).length;
    const exportableReleases: Array<ReleaseLike | null> = Array.from(
      { length: result.page.length },
      () => null,
    );

    type BlobTask = {
      digestIndex: number;
      fileIndex: number;
      storageId: Id<"_storage">;
      archivePath: string;
    };
    const blobTasks: BlobTask[] = [];

    logContext.phase = "plan_blobs";
    for (let i = 0; i < result.page.length; i++) {
      const digest = result.page[i];
      const release = releases[i] ?? null;

      if (!digest.latestReleaseId || !release) {
        exportErrors.push({
          package: digest.name,
          error: `release not found (latestReleaseId: ${digest.latestReleaseId ?? "null"})`,
        });
        continue;
      }
      if (!isReleaseForPackage(release, digest)) {
        exportErrors.push({
          package: digest.name,
          error: `release not found (latestReleaseId: ${digest.latestReleaseId})`,
        });
        continue;
      }
      if (release.softDeletedAt) {
        exportErrors.push({
          package: digest.name,
          error: `release not available (latestReleaseId: ${digest.latestReleaseId})`,
        });
        continue;
      }
      const securityBlock = getReleaseSecurityBlock(release);
      if (securityBlock) {
        exportErrors.push({
          package: digest.name,
          error: `release blocked: ${securityBlock.message}`,
        });
        continue;
      }
      if (!release.files || release.files.length === 0) {
        exportErrors.push({
          package: digest.name,
          error: `release has no files (latestReleaseId: ${digest.latestReleaseId})`,
        });
        continue;
      }
      if (!validateFilePath(pluginExportRoot(digest))) {
        exportErrors.push({
          package: digest.name,
          error: "invalid package export path (fails Zip Slip validation)",
        });
        continue;
      }
      exportableReleases[i] = release;

      const exportRoot = pluginExportRoot(digest);
      const archivePaths = new Set<string>();

      for (let j = 0; j < release.files.length; j++) {
        if (blobTasks.length >= MAX_PLUGIN_EXPORT_FILE_COUNT) {
          exportErrors.push({
            package: digest.name,
            error: `file count cap exceeded (${MAX_PLUGIN_EXPORT_FILE_COUNT})`,
          });
          break;
        }
        const archivePath = `${exportRoot}/${release.files[j].path}`;
        if (archivePaths.has(archivePath)) {
          exportErrors.push({
            package: digest.name,
            error: `duplicate archive path skipped: "${archivePath}"`,
          });
          continue;
        }
        archivePaths.add(archivePath);
        blobTasks.push({
          digestIndex: i,
          fileIndex: j,
          storageId: release.files[j].storageId,
          archivePath,
        });
      }
    }
    logContext.blobTaskCount = blobTasks.length;
    logContext.exportErrorCount = exportErrors.length;

    logContext.phase = "load_blobs";
    const blobs = await chunkedParallel(blobTasks, 50, (task) => ctx.storage.get(task.storageId));
    logContext.blobCount = blobs.length;

    const zipEntries: Array<{ path: string; bytes: Uint8Array }> = [];
    const manifest: Array<
      MergedExportManifestEntry & {
        family: PluginExportFamily;
        packageName: string;
        latestReleaseId: string | null;
        artifactKind: ReleaseLike["artifactKind"] | null;
      }
    > = [];
    let totalExportBytes = 0;

    const blobsByDigest = new Map<
      number,
      Map<number, { blob: Blob | null; archivePath: string }>
    >();
    for (let k = 0; k < blobTasks.length; k++) {
      const task = blobTasks[k];
      if (!blobsByDigest.has(task.digestIndex)) {
        blobsByDigest.set(task.digestIndex, new Map());
      }
      blobsByDigest.get(task.digestIndex)!.set(task.fileIndex, {
        blob: blobs[k],
        archivePath: task.archivePath,
      });
    }

    logContext.phase = "assemble_entries";
    for (let i = 0; i < result.page.length; i++) {
      const digest = result.page[i];
      const release = exportableReleases[i];
      if (!release?.files) continue;
      const exportRoot = pluginExportRoot(digest);
      if (!validateFilePath(exportRoot)) continue;
      const digestBlobs = blobsByDigest.get(i);
      if (!digestBlobs) continue;

      let fileCount = 0;
      for (let j = 0; j < release.files.length; j++) {
        const filePath = release.files[j].path;

        if (!validateFilePath(filePath)) {
          exportErrors.push({
            package: digest.name,
            error: `invalid file path: "${filePath}" (fails Zip Slip validation)`,
          });
          continue;
        }

        const plannedFile = digestBlobs.get(j);
        if (!plannedFile) continue;
        if (!plannedFile.blob) {
          exportErrors.push({
            package: digest.name,
            error: `blob not found for file "${filePath}" (storageId: ${release.files[j].storageId})`,
          });
          continue;
        }

        const buffer = new Uint8Array(await plannedFile.blob.arrayBuffer());
        if (totalExportBytes + buffer.byteLength > MAX_PLUGIN_EXPORT_TOTAL_BYTES) {
          exportErrors.push({
            package: digest.name,
            error: `byte cap exceeded (${MAX_PLUGIN_EXPORT_TOTAL_BYTES}) at file "${filePath}"`,
          });
          continue;
        }
        totalExportBytes += buffer.byteLength;
        zipEntries.push({ path: plannedFile.archivePath, bytes: buffer });
        fileCount++;
      }

      const pluginMeta = {
        name: digest.name,
        displayName: digest.displayName,
        family: digest.family,
        version: release.version ?? digest.latestVersion ?? null,
        latestReleaseId: digest.latestReleaseId ?? null,
        artifactKind: release.artifactKind ?? null,
        createdAt: digest.createdAt,
        updatedAt: digest.updatedAt,
        stats: digest.stats ?? null,
        owner: {
          handle: digest.ownerHandle ?? null,
          displayName: digest.ownerDisplayName ?? null,
        },
      };
      zipEntries.push({
        path: pluginExportMetaPath(digest),
        bytes: new TextEncoder().encode(JSON.stringify(pluginMeta, null, 2)),
      });

      manifest.push({
        publisher: digest.ownerHandle ?? String(digest.ownerUserId),
        slug: digest.name,
        packageName: digest.name,
        family: digest.family,
        version: release.version ?? digest.latestVersion ?? null,
        displayName: digest.displayName,
        createdAt: digest.createdAt,
        updatedAt: digest.updatedAt,
        stats: digest.stats ?? null,
        fileCount,
        latestReleaseId: digest.latestReleaseId ?? null,
        artifactKind: release.artifactKind ?? null,
      });
    }

    if (exportErrors.length > 0) {
      zipEntries.push({
        path: "_errors.json",
        bytes: new TextEncoder().encode(JSON.stringify(exportErrors, null, 2)),
      });
    }
    logContext.zipEntryCount = zipEntries.length;
    logContext.manifestCount = manifest.length;
    logContext.exportErrorCount = exportErrors.length;
    logContext.totalExportBytes = totalExportBytes;

    logContext.phase = "build_zip";
    const zipBytes = buildMergedExportZip(zipEntries, manifest);

    return new Response(zipBytes as unknown as BodyInit, {
      status: 200,
      headers: mergeHeaders(rate.headers, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="plugins-export-${familyLabel}-${startDate}-${endDate}.zip"`,
        "X-Next-Cursor": result.nextCursor ?? "",
        "X-Has-More": String(result.hasMore),
        "X-Total-Returned": String(manifest.length),
        "X-Date-Range": `${startDate}-${endDate}`,
        "X-Export-Errors": String(exportErrors.length),
      }),
    });
  } catch (err) {
    logPluginsExportFailure(logContext, err);
    throw err;
  }
}

export async function listPluginsV1Handler(ctx: ActionCtx, request: Request) {
  return await listPackages(ctx, request, undefined, {
    defaultSort: "recommended",
    includeSkills: false,
    pluginFamilies: ["code-plugin", "bundle-plugin"],
  });
}

export async function listPluginCategoriesV1Handler(_ctx: ActionCtx, _request: Request) {
  return json({
    categories: PLUGIN_CATEGORY_DEFINITIONS.map((category, order) => ({
      slug: category.slug,
      label: category.label,
      description: category.description,
      icon: category.icon,
      order,
    })),
  });
}

export async function listCodePluginsV1Handler(ctx: ActionCtx, request: Request) {
  return await listPackages(ctx, request, "code-plugin");
}

export async function listBundlePluginsV1Handler(ctx: ActionCtx, request: Request) {
  return await listPackages(ctx, request, "bundle-plugin");
}

export async function publishPackageV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, "write");
  if (!rate.ok) return rate.response;

  const auth = await requirePackagePublishAuthOrResponse(ctx, request, rate.headers);
  if (!auth.ok) return auth.response;

  let payload: ServerPackagePublishRequest | undefined;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return text("Package publish requires multipart/form-data", 415, rate.headers);
    }
    payload = await parseMultipartPackagePublish(ctx, auth.auth, request);
    const result =
      auth.auth.kind === "user"
        ? await runActionRef(ctx, internalRefs.packages.publishPackageForUserInternal, {
            actorUserId: auth.auth.userId,
            payload,
          })
        : await runActionRef(ctx, internalRefs.packages.publishPackageForTrustedPublisherInternal, {
            publishTokenId: auth.auth.publishToken._id,
            payload,
          });
    return json(result, 200, rate.headers);
  } catch (error) {
    // Parse succeeded, so these blobs have no release owner yet.
    if (payload) {
      await deleteUnpublishedPackagePublishBlobs(ctx, payload);
    }
    return packagePublishErrorToResponse(error, rate.headers);
  }
}

type PackagePublishAttemptStatusResult = {
  attemptId: Id<"publishAttempts">;
  userId: Id<"users">;
  packageId: Id<"packages">;
  releaseId: Id<"packageReleases">;
  artifactSha256?: string;
  name: string;
  version: string;
  status:
    | "pending_checks"
    | "ready_to_finalize"
    | "finalizing"
    | "finalized"
    | "blocked"
    | "failed"
    | "expired";
  checks: {
    trufflehog: {
      status: "pending" | "clean" | "blocked" | "failed";
      summary?: string;
    };
    clawscan: {
      status: "pending" | "clean" | "blocked" | "failed";
      summary?: string;
    };
  };
  error?: string;
};

function normalizePackagePublicationStatus(status: PackagePublishAttemptStatusResult["status"]) {
  if (status === "finalized") return "published" as const;
  if (status === "blocked" || status === "failed" || status === "expired") return status;
  return "pending" as const;
}

export async function publishAttemptsGetRouterV1Handler(ctx: ActionCtx, request: Request) {
  const segments = getPathSegments(request, "/api/v1/publish/attempts/");
  if (segments.length !== 1) return text("Not found", 404);

  const rate = await applyRateLimit(ctx, request, "read");
  if (!rate.ok) return rate.response;
  const auth = await requirePackagePublishAuthOrResponse(ctx, request, rate.headers);
  if (!auth.ok) return auth.response;

  const attempt = await runQueryRef<PackagePublishAttemptStatusResult | null>(
    ctx,
    internalRefs.publishAttempts.getPackagePublishAttemptStatusInternal,
    { attemptId: segments[0] },
  );
  const authorized =
    attempt &&
    (auth.auth.kind === "user"
      ? auth.auth.userId === attempt.userId
      : auth.auth.publishToken.packageId === attempt.packageId &&
        auth.auth.publishToken.version === attempt.version);
  if (!authorized) return text("Not found", 404, rate.headers);

  const publicationStatus = normalizePackagePublicationStatus(attempt.status);
  const response = {
    attemptId: attempt.attemptId,
    packageId: attempt.packageId,
    releaseId: attempt.releaseId,
    ...(attempt.artifactSha256 ? { artifactSha256: attempt.artifactSha256 } : {}),
    name: attempt.name,
    version: attempt.version,
    status: attempt.status,
    publicationStatus,
    terminal: publicationStatus !== "pending",
    checks: attempt.checks,
    ...(attempt.error ? { error: attempt.error } : {}),
  };
  return json(response, 200, rate.headers);
}

async function getPackageAndTrustedPublisherByName(ctx: ActionCtx, packageName: string) {
  const pkg = await runQueryRef<Doc<"packages"> | null>(
    ctx,
    internalRefs.packages.getPackageByNameInternal,
    {
      name: packageName,
    },
  );
  if (!pkg || pkg.softDeletedAt) return { pkg: null, trustedPublisher: null };
  const trustedPublisher = await runQueryRef<PackageTrustedPublisherLike | null>(
    ctx,
    internalRefs.packages.getTrustedPublisherByPackageIdInternal,
    { packageId: pkg._id },
  );
  return { pkg, trustedPublisher };
}

async function derivePackagePublishAuthorizationTransactionKey(args: {
  packageId: Id<"packages">;
  version: string;
  inventoryDigest: string;
  verified: Awaited<ReturnType<typeof verifyGitHubActionsTrustedPublishJwt>>;
}) {
  return await hashToken(
    JSON.stringify([
      "github-actions-package-publish-v1",
      args.packageId,
      args.version,
      args.inventoryDigest,
      args.verified.repository,
      args.verified.repositoryId,
      args.verified.repositoryOwner,
      args.verified.repositoryOwnerId,
      args.verified.workflowFilename,
      args.verified.environment ?? "",
      args.verified.runId,
      args.verified.runAttempt,
      args.verified.sha,
      args.verified.ref,
      args.verified.refType ?? "",
    ]),
  );
}

export async function mintPublishTokenV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, "trustedPublish");
  if (!rate.ok) return rate.response;

  const parsedBody = await request.json().catch(() => null);
  if (!parsedBody) return text("Invalid JSON", 400, rate.headers);

  try {
    const payload = parseArk(
      PublishTokenMintRequestSchema,
      parsedBody,
      "Publish token mint payload",
    ) as {
      packageName: string;
      version: string;
      githubOidcToken: string;
      scope?: "upload" | "publish";
      inventoryDigest?: string;
      trustedToolingIdentityJson?: string;
    };
    const { pkg, trustedPublisher } = await getPackageAndTrustedPublisherByName(
      ctx,
      payload.packageName,
    );
    if (!pkg) return text("Package not found", 404, rate.headers);
    if (!trustedPublisher) {
      return text("Trusted publisher config is not set for this package", 403, rate.headers);
    }

    try {
      const verified = await verifyGitHubActionsTrustedPublishJwt(payload.githubOidcToken, {
        repository: trustedPublisher.repository,
        repositoryId: trustedPublisher.repositoryId,
        repositoryOwner: trustedPublisher.repositoryOwner,
        repositoryOwnerId: trustedPublisher.repositoryOwnerId,
        workflowFilename: trustedPublisher.workflowFilename,
        ...(trustedPublisher.environment ? { environment: trustedPublisher.environment } : {}),
      });
      const scope = payload.scope ?? "publish";
      if (payload.scope !== undefined && payload.inventoryDigest === undefined) {
        throw new Error("Scoped trusted publishes require an inventory digest");
      }
      let openClawAuthorization = null;
      if (verified.repository === "openclaw/openclaw") {
        if (
          payload.scope === undefined ||
          payload.inventoryDigest === undefined ||
          !payload.trustedToolingIdentityJson?.trim()
        ) {
          throw new Error("OpenClaw trusted publishes require authorization version 2");
        }
        openClawAuthorization = await verifyOpenClawPublishAuthorization({
          rawIdentity: payload.trustedToolingIdentityJson,
          packageName: payload.packageName,
          version: payload.version,
          inventoryDigest: payload.inventoryDigest,
          oidc: verified,
        });
      }
      const authorizationTransactionKey =
        payload.scope === undefined
          ? undefined
          : (openClawAuthorization?.transactionKey ??
            (await derivePackagePublishAuthorizationTransactionKey({
              packageId: pkg._id,
              version: payload.version,
              inventoryDigest: payload.inventoryDigest!,
              verified,
            })));
      const { token, prefix } = generateToken();
      const tokenHash = await hashToken(token);
      const expiresAt = Date.now() + 15 * 60_000;

      await ctx.runMutation(
        internalRefs.packagePublishTokens.createInternal as never,
        {
          packageId: pkg._id,
          version: payload.version,
          prefix,
          tokenHash,
          provider: "github-actions",
          repository: verified.repository,
          repositoryId: verified.repositoryId,
          repositoryOwner: verified.repositoryOwner,
          repositoryOwnerId: verified.repositoryOwnerId,
          workflowFilename: verified.workflowFilename,
          ...(trustedPublisher.environment ? { environment: trustedPublisher.environment } : {}),
          runId: verified.runId,
          runAttempt: verified.runAttempt,
          sha: verified.sha,
          ref: verified.ref,
          ...(verified.refType ? { refType: verified.refType } : {}),
          ...(verified.actor ? { actor: verified.actor } : {}),
          ...(verified.actorId ? { actorId: verified.actorId } : {}),
          ...(payload.scope ? { scope } : {}),
          ...(payload.inventoryDigest ? { inventoryDigest: payload.inventoryDigest } : {}),
          ...(openClawAuthorization
            ? {
                authorizationVersion: 2,
                authorizationRoute: openClawAuthorization.authorizationRoute,
                authorizationArtifactId: openClawAuthorization.artifactId,
                authorizationArtifactDigest: openClawAuthorization.artifactDigest,
                trustedToolingIdentityJson: payload.trustedToolingIdentityJson,
                candidateRepository: openClawAuthorization.identity.candidateRepository,
                candidateSha: openClawAuthorization.identity.candidateSha,
                parentRepository: openClawAuthorization.identity.parentRepository,
                parentWorkflow: openClawAuthorization.identity.parentWorkflow,
                parentRunId: openClawAuthorization.identity.parentRunId,
                parentRunAttempt: openClawAuthorization.identity.parentRunAttempt,
              }
            : {}),
          ...(authorizationTransactionKey
            ? {
                authorizationTransactionKey,
                authorizationKey: `${authorizationTransactionKey}:${scope}`,
              }
            : {}),
          expiresAt,
        } as never,
      );
      await ctx.runMutation(
        internalRefs.packages.insertAuditLogInternal as never,
        {
          actorUserId: pkg.ownerUserId,
          action: "package.publish_token.mint",
          targetType: "package",
          targetId: String(pkg._id),
          metadata: {
            version: payload.version,
            repository: verified.repository,
            workflowFilename: verified.workflowFilename,
            ...(verified.environment ? { environment: verified.environment } : {}),
            runId: verified.runId,
            runAttempt: verified.runAttempt,
            sha: verified.sha,
            ref: verified.ref,
            scope,
            ...(payload.inventoryDigest ? { inventoryDigest: payload.inventoryDigest } : {}),
            ...(openClawAuthorization
              ? {
                  authorizationVersion: 2,
                  authorizationRoute: openClawAuthorization.authorizationRoute,
                  authorizationArtifactId: openClawAuthorization.artifactId,
                  candidateSha: openClawAuthorization.identity.candidateSha,
                  parentRunId: openClawAuthorization.identity.parentRunId,
                  parentRunAttempt: openClawAuthorization.identity.parentRunAttempt,
                }
              : {}),
            decision: "allowed",
          },
        } as never,
      );
      return json({ token, expiresAt }, 200, rate.headers);
    } catch (error) {
      await ctx.runMutation(
        internalRefs.packages.insertAuditLogInternal as never,
        {
          actorUserId: pkg.ownerUserId,
          action: "package.publish_token.mint_rejected",
          targetType: "package",
          targetId: String(pkg._id),
          metadata: {
            version: payload.version,
            repository: trustedPublisher.repository,
            workflowFilename: trustedPublisher.workflowFilename,
            ...(trustedPublisher.environment ? { environment: trustedPublisher.environment } : {}),
            decision: "rejected",
            reason: error instanceof Error ? error.message : "Token verification failed",
          },
        } as never,
      );
      throw error;
    }
  } catch (error) {
    return text(error instanceof Error ? error.message : "Token mint failed", 400, rate.headers);
  }
}

export async function packagesPostRouterV1Handler(ctx: ActionCtx, request: Request) {
  const segments = getPathSegments(request, "/api/v1/packages/");
  if (segments[0] === "migrations" && segments.length === 1) {
    const rate = await applyRateLimit(ctx, request, "write");
    if (!rate.ok) return rate.response;
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;

    try {
      const body = parseArk(
        PackageOfficialMigrationUpsertRequestSchema,
        await request.json(),
        "Package official migration payload",
      );
      const result = await runMutationRef(
        ctx,
        internalRefs.packages.upsertOfficialPluginMigrationForUserInternal,
        {
          actorUserId: auth.userId,
          ...body,
        },
      );
      const parsed = parseArk(
        ApiV1PackageOfficialMigrationResponseSchema,
        result,
        "Package official migration response",
      );
      return json(parsed, 200, rate.headers);
    } catch (error) {
      return text(
        error instanceof Error ? error.message : "Package official migration update failed",
        400,
        rate.headers,
      );
    }
  }

  if (
    segments[0] === "reports" &&
    segments[1] &&
    segments[2] === "triage" &&
    segments.length === 3
  ) {
    const rate = await applyRateLimit(ctx, request, "write");
    if (!rate.ok) return rate.response;
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;

    try {
      const body = parseArk(
        PackageReportTriageRequestSchema,
        await request.json(),
        "Package report triage payload",
      ) as {
        status: "open" | "confirmed" | "dismissed";
        note?: string;
        finalAction?: "none" | "quarantine" | "revoke";
      };
      const result = await runMutationRef(
        ctx,
        internalRefs.packages.triagePackageReportForUserInternal,
        {
          actorUserId: auth.userId,
          reportId: segments[1] as Id<"packageReports">,
          status: body.status,
          ...(body.note ? { note: body.note } : {}),
          ...(body.finalAction ? { finalAction: body.finalAction } : {}),
        },
      );
      return json(result, 200, rate.headers);
    } catch (error) {
      return text(
        error instanceof Error ? error.message : "Package report triage failed",
        400,
        rate.headers,
      );
    }
  }

  if (
    segments[0] === "appeals" &&
    segments[1] &&
    segments[2] === "resolve" &&
    segments.length === 3
  ) {
    const rate = await applyRateLimit(ctx, request, "write");
    if (!rate.ok) return rate.response;
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;

    try {
      const body = parseArk(
        PackageAppealResolveRequestSchema,
        await request.json(),
        "Package appeal resolve payload",
      ) as {
        status: "open" | "accepted" | "rejected";
        note?: string;
        finalAction?: "none" | "approve";
      };
      const result = await runMutationRef(
        ctx,
        internalRefs.packages.resolvePackageAppealForUserInternal,
        {
          actorUserId: auth.userId,
          appealId: segments[1] as Id<"packageAppeals">,
          status: body.status,
          ...(body.note ? { note: body.note } : {}),
          ...(body.finalAction ? { finalAction: body.finalAction } : {}),
        },
      );
      return json(result, 200, rate.headers);
    } catch (error) {
      return text(
        error instanceof Error ? error.message : "Package appeal resolve failed",
        400,
        rate.headers,
      );
    }
  }

  const packageRoute = parsePackagePathSegments(segments);
  if (!packageRoute) return text("Not found", 404);
  const packageName = packageRoute.packageName;
  const packageSegments = packageRoute.rest;

  if (packageSegments[0] === "hard-delete" && packageSegments.length === 1) {
    const rate = await applyRateLimit(ctx, request, "write");
    if (!rate.ok) return rate.response;
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;
    const admin = requireAdminOrResponse(auth.user, rate.headers);
    if (!admin.ok) return admin.response;

    try {
      const body = parseArk(
        PackageHardDeleteRequestSchema,
        await request.json(),
        "Package hard-delete payload",
      ) as {
        ownerHandle: string;
        reason: string;
        dryRun?: boolean;
        confirmationToken?: string;
      };
      const result = await runMutationRef(ctx, internalRefs.packages.hardDeleteForAdminInternal, {
        actorUserId: auth.userId,
        name: packageName,
        ownerHandle: body.ownerHandle,
        reason: body.reason,
        ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
        ...(body.confirmationToken ? { confirmationToken: body.confirmationToken } : {}),
      });
      return json(result, 200, rate.headers);
    } catch (error) {
      if (error instanceof SyntaxError) return text("Invalid JSON", 400, rate.headers);
      return packageOperationErrorToResponse(error, rate.headers, "Package hard delete failed");
    }
  }

  if (packageSegments[0] === "rescan" && packageSegments.length === 1) {
    const rate = await applyRateLimit(ctx, request, "write");
    if (!rate.ok) return rate.response;
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;

    try {
      const body = await readOptionalJson(request);
      const version = optionalStringField(body, "version");
      const result = await runMutationRef(
        ctx,
        internalRefs.securityScan.requestPackageRescanForUserInternal,
        {
          actorUserId: auth.userId,
          name: packageName,
          ...(version ? { version } : {}),
        },
      );
      return json(result, 200, rate.headers);
    } catch (error) {
      if (error instanceof SyntaxError) return text("Invalid JSON", 400, rate.headers);
      return packageOperationErrorToResponse(error, rate.headers, "Package rescan failed");
    }
  }

  if (packageSegments[0] === "repair-name" && packageSegments.length === 1) {
    const rate = await applyRateLimit(ctx, request, "write");
    if (!rate.ok) return rate.response;
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;
    const admin = requireAdminOrResponse(auth.user, rate.headers);
    if (!admin.ok) return admin.response;

    try {
      const body = parseArk(
        PackageRepairNameRequestSchema,
        await request.json(),
        "Package name repair payload",
      ) as {
        nextName: string;
        retireTarget?: boolean;
        owner?: string;
        reason: string;
        dryRun?: boolean;
      };
      const nextName = tryNormalizePackageName(body.nextName);
      if (!nextName) {
        return text(
          "Target package name must be lowercase and npm-safe (example: @scope/name).",
          400,
          rate.headers,
        );
      }
      const reason = body.reason.trim();
      if (!reason) return text("Repair reason required", 400, rate.headers);
      const dryRun = body.dryRun !== false;
      const ownerHandle = normalizePublisherHandleInput(body.owner);

      const source = await runQueryRef<AdminRepairPackageLike | null>(
        ctx,
        internalRefs.packages.getPackageByNameInternal,
        { name: packageName },
      );
      if (!source || source.softDeletedAt) return text("Package not found", 404, rate.headers);

      const target = await runQueryRef<AdminRepairPackageLike | null>(
        ctx,
        internalRefs.packages.getPackageByNameInternal,
        { name: nextName },
      );
      const targetIsDifferentPackage = Boolean(target && target._id !== source._id);
      if (targetIsDifferentPackage && target?.softDeletedAt) {
        return text(
          `Target package "${nextName}" is held by a soft-deleted package; restore or repair that row first.`,
          409,
          rate.headers,
        );
      }
      if (targetIsDifferentPackage && !body.retireTarget) {
        return text(
          `Target package "${nextName}" already exists; pass retireTarget.`,
          409,
          rate.headers,
        );
      }

      const retiredName = targetIsDifferentPackage ? defaultRetiredPackageName(nextName) : null;
      if (retiredName) {
        const existingRetiredName = await runQueryRef<AdminRepairPackageLike | null>(
          ctx,
          internalRefs.packages.getPackageByNameInternal,
          { name: retiredName },
        );
        if (existingRetiredName && existingRetiredName._id !== target?._id) {
          return text(`Retired package name "${retiredName}" already exists.`, 409, rate.headers);
        }
      }

      const ownerPublisher = ownerHandle
        ? await runQueryRef<RepairOwnerPublisherLike | null>(
            ctx,
            internalRefs.publishers.getByHandleInternal,
            { handle: ownerHandle },
          )
        : null;
      if (ownerHandle && (!ownerPublisher || ownerPublisher.deletedAt)) {
        return text(`Publisher "@${ownerHandle}" not found.`, 404, rate.headers);
      }

      const operations: Array<Record<string, string>> = [];
      if (targetIsDifferentPackage && target && retiredName) {
        operations.push({
          action: "retire-target",
          packageId: String(target._id),
          from: target.normalizedName || target.name,
          to: retiredName,
        });
      }
      if ((source.normalizedName || source.name) !== nextName) {
        operations.push({
          action: "rename-source",
          packageId: String(source._id),
          from: source.normalizedName || source.name,
          to: nextName,
        });
      }
      if (ownerHandle && ownerPublisher) {
        operations.push({
          action: "transfer-owner",
          packageId: String(source._id),
          owner: ownerHandle,
        });
      }

      if (!dryRun) {
        if (targetIsDifferentPackage && retiredName) {
          await runMutationRef(ctx, internalRefs.packages.repairPackageIdentityInternal, {
            actorUserId: auth.userId,
            name: nextName,
            nextName: retiredName,
            reason,
          });
          await runMutationRef(ctx, internalRefs.packages.softDeletePackageInternal, {
            userId: auth.userId,
            name: retiredName,
          });
        }
        if ((source.normalizedName || source.name) !== nextName) {
          await runMutationRef(ctx, internalRefs.packages.repairPackageIdentityInternal, {
            actorUserId: auth.userId,
            name: packageName,
            nextName,
            reason,
          });
        }
        if (ownerHandle && ownerPublisher) {
          await runMutationRef(ctx, internalRefs.packages.transferPackageOwnerInternal, {
            actorUserId: auth.userId,
            name: nextName,
            ownerUserId: source.ownerUserId,
            ownerPublisherId: ownerPublisher._id,
            channel: source.channel,
            reason,
          });
        }
      }

      return json(
        {
          ok: true,
          dryRun,
          source: toRepairPackageSnapshot(source),
          target: target ? toRepairPackageSnapshot(target) : null,
          retiredName,
          operations,
        },
        200,
        rate.headers,
      );
    } catch (error) {
      return packageOperationErrorToResponse(error, rate.headers, "Package name repair failed");
    }
  }

  if (packageSegments[0] === "repair-runtime-id" && packageSegments.length === 1) {
    const rate = await applyRateLimit(ctx, request, "write");
    if (!rate.ok) return rate.response;
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;
    const admin = requireAdminOrResponse(auth.user, rate.headers);
    if (!admin.ok) return admin.response;

    try {
      const body = parseArk(
        PackageRepairRuntimeIdRequestSchema,
        await request.json(),
        "Package runtime id repair payload",
      ) as {
        nextRuntimeId: string;
        reason: string;
        dryRun?: boolean;
      };
      const nextRuntimeId = body.nextRuntimeId.trim();
      if (!nextRuntimeId) return text("Runtime id required", 400, rate.headers);
      const reason = body.reason.trim();
      if (!reason) return text("Repair reason required", 400, rate.headers);
      const dryRun = body.dryRun !== false;

      const source = await runQueryRef<AdminRepairPackageLike | null>(
        ctx,
        internalRefs.packages.getPackageByNameInternal,
        { name: packageName },
      );
      if (!source || source.softDeletedAt) return text("Package not found", 404, rate.headers);

      const operations = [
        {
          action: "repair-runtime-id",
          packageId: String(source._id),
          from: source.runtimeId ?? null,
          to: nextRuntimeId,
        },
      ];

      if (!dryRun) {
        await runMutationRef(ctx, internalRefs.packages.repairPackageIdentityInternal, {
          actorUserId: auth.userId,
          name: packageName,
          nextRuntimeId,
          reason,
        });
      }

      return json(
        {
          ok: true,
          dryRun,
          source: toRepairPackageSnapshot(source),
          operations,
        },
        200,
        rate.headers,
      );
    } catch (error) {
      return packageOperationErrorToResponse(
        error,
        rate.headers,
        "Package runtime id repair failed",
      );
    }
  }

  if (
    packageSegments[0] === "versions" &&
    packageSegments[1] &&
    packageSegments[2] === "moderation" &&
    packageSegments.length === 3
  ) {
    const rate = await applyRateLimit(ctx, request, "write");
    if (!rate.ok) return rate.response;
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;

    try {
      const body = parseArk(
        PackageReleaseModerationRequestSchema,
        await request.json(),
        "Package release moderation payload",
      ) as {
        state: "approved" | "quarantined" | "revoked";
        reason: string;
      };
      const result = await runMutationRef(
        ctx,
        internalRefs.packages.moderatePackageReleaseForUserInternal,
        {
          actorUserId: auth.userId,
          name: packageName,
          version: packageSegments[1],
          state: body.state,
          reason: body.reason,
        },
      );
      return json(result, 200, rate.headers);
    } catch (error) {
      return text(
        error instanceof Error ? error.message : "Package release moderation failed",
        400,
        rate.headers,
      );
    }
  }

  if (packageSegments[0] === "featured" && packageSegments.length === 1) {
    const rate = await applyRateLimit(ctx, request, "write");
    if (!rate.ok) return rate.response;
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;

    try {
      const body = await readOptionalJson(request);
      const featured =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>).featured
          : undefined;
      if (typeof featured !== "boolean") {
        return text("featured must be a boolean", 400, rate.headers);
      }
      const result = await runMutationRef(
        ctx,
        internalRefs.packages.setPackageFeaturedForUserInternal,
        {
          actorUserId: auth.userId,
          name: packageName,
          featured,
        },
      );
      return json(result, 200, rate.headers);
    } catch (error) {
      if (error instanceof SyntaxError) return text("Invalid JSON", 400, rate.headers);
      return packageOperationErrorToResponse(error, rate.headers, "Package feature update failed");
    }
  }

  if (packageSegments[0] === "report" && packageSegments.length === 1) {
    const rate = await applyRateLimit(ctx, request, "write");
    if (!rate.ok) return rate.response;
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;

    try {
      const body = parseArk(
        PackageReportRequestSchema,
        await request.json(),
        "Package report payload",
      ) as {
        reason: string;
        version?: string;
      };
      const result = await runMutationRef(ctx, internalRefs.packages.reportPackageForUserInternal, {
        actorUserId: auth.userId,
        name: packageName,
        reason: body.reason,
        ...(body.version ? { version: body.version } : {}),
      });
      return json(result, 200, rate.headers);
    } catch (error) {
      return text(
        error instanceof Error ? error.message : "Package report failed",
        400,
        rate.headers,
      );
    }
  }

  if (packageSegments[0] === "appeal" && packageSegments.length === 1) {
    const rate = await applyRateLimit(ctx, request, "write");
    if (!rate.ok) return rate.response;
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;

    try {
      const body = parseArk(
        PackageAppealRequestSchema,
        await request.json(),
        "Package appeal payload",
      ) as {
        version: string;
        message: string;
      };
      const result = await runMutationRef(
        ctx,
        internalRefs.packages.submitPackageAppealForUserInternal,
        {
          actorUserId: auth.userId,
          name: packageName,
          version: body.version,
          message: body.message,
        },
      );
      return json(result, 200, rate.headers);
    } catch (error) {
      return text(
        error instanceof Error ? error.message : "Package appeal failed",
        400,
        rate.headers,
      );
    }
  }

  if (packageSegments[0] === "undelete" && packageSegments.length === 1) {
    const rate = await applyRateLimit(ctx, request, "write");
    if (!rate.ok) return rate.response;
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;

    try {
      await runMutationRef(ctx, internalRefs.packages.restorePackageInternal, {
        userId: auth.userId,
        name: packageName,
      });
      return json({ ok: true }, 200, rate.headers);
    } catch (error) {
      return softDeleteErrorToResponse("package", error, rate.headers);
    }
  }

  if (
    packageSegments[0] === "versions" &&
    packageSegments[1] &&
    packageSegments[2] === "restore" &&
    packageSegments.length === 3
  ) {
    const rate = await applyRateLimit(ctx, request, "write");
    if (!rate.ok) return rate.response;
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;

    try {
      const result = await runMutationRef(
        ctx,
        internalRefs.packages.restoreOwnedReleaseForUserInternal,
        {
          actorUserId: auth.userId,
          name: packageName,
          version: packageSegments[1],
        },
      );
      return json(result, 200, rate.headers);
    } catch (error) {
      return packageOperationErrorToResponse(error, rate.headers, "Package version restore failed");
    }
  }

  if (packageSegments[0] === "transfer" && packageSegments.length === 1) {
    const rate = await applyRateLimit(ctx, request, "write");
    if (!rate.ok) return rate.response;
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;

    try {
      const body = parseArk(
        PackageTransferRequestSchema,
        await request.json(),
        "Package transfer payload",
      ) as { toOwner: string; reason?: string };
      const result = await runMutationRef(
        ctx,
        internalRefs.packages.transferPackageOwnerForUserInternal,
        {
          actorUserId: auth.userId,
          name: packageName,
          toOwner: body.toOwner,
          ...(body.reason ? { reason: body.reason } : {}),
        },
      );
      return json(result, 200, rate.headers);
    } catch (error) {
      return packageOperationErrorToResponse(error, rate.headers, "Package transfer failed");
    }
  }

  if (packageSegments[0] !== "trusted-publisher" || packageSegments.length !== 1) {
    return text("Not found", 404);
  }
  const rate = await applyRateLimit(ctx, request, "write");
  if (!rate.ok) return rate.response;
  const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
  if (!auth.ok) return auth.response;

  try {
    const body = parseArk(
      PackageTrustedPublisherUpsertRequestSchema,
      await request.json(),
      "Trusted publisher payload",
    ) as {
      repository: string;
      workflowFilename: string;
      environment?: string;
    };
    const repositoryIdentity = await fetchGitHubRepositoryIdentity(body.repository);
    const trustedPublisher = await runMutationRef<PackageTrustedPublisherLike | null>(
      ctx,
      internalRefs.packages.setTrustedPublisherForUserInternal,
      {
        actorUserId: auth.userId,
        packageName,
        repository: repositoryIdentity.repository,
        repositoryId: repositoryIdentity.repositoryId,
        repositoryOwner: repositoryIdentity.repositoryOwner,
        repositoryOwnerId: repositoryIdentity.repositoryOwnerId,
        workflowFilename: body.workflowFilename,
        ...(body.environment ? { environment: body.environment } : {}),
      },
    );
    return json(
      { trustedPublisher: toPublicTrustedPublisher(trustedPublisher) },
      200,
      rate.headers,
    );
  } catch (error) {
    return text(
      error instanceof Error ? error.message : "Trusted publisher update failed",
      400,
      rate.headers,
    );
  }
}

export async function packagesDeleteRouterV1Handler(ctx: ActionCtx, request: Request) {
  const segments = getPathSegments(request, "/api/v1/packages/");
  const packageRoute = parsePackagePathSegments(segments);
  if (!packageRoute) return text("Not found", 404);
  const packageName = packageRoute.packageName;
  const packageSegments = packageRoute.rest;
  const rate = await applyRateLimit(ctx, request, "write");
  if (!rate.ok) return rate.response;
  const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
  if (!auth.ok) return auth.response;

  if (packageSegments.length === 2 && packageSegments[0] === "versions" && packageSegments[1]) {
    try {
      const body = await readOptionalJson(request);
      const versionTarget = resolveVersionPathTarget(packageSegments[1], request, body);
      if (versionTarget.error) return text(versionTarget.error, 400, rate.headers);
      await runMutationRef(ctx, internalRefs.packages.deleteOwnedReleaseForUserInternal, {
        actorUserId: auth.userId,
        name: packageName,
        version: versionTarget.version!,
      });
      return json({ ok: true }, 200, rate.headers);
    } catch (error) {
      if (error instanceof SyntaxError) return text("Invalid JSON", 400, rate.headers);
      return packageOperationErrorToResponse(error, rate.headers, "Package version delete failed");
    }
  }

  if (packageSegments.length === 0) {
    try {
      const body = await readOptionalJson(request);
      if (hasVersionDeleteSelector(request, body)) {
        return text(
          versionDeleteRouteGuidance(
            `${ApiRoutes.packages}/${encodeURIComponent(packageName)}`,
            request,
            body,
          ),
          400,
          rate.headers,
        );
      }
      await runMutationRef(ctx, internalRefs.packages.softDeletePackageInternal, {
        userId: auth.userId,
        name: packageName,
      });
      return json({ ok: true }, 200, rate.headers);
    } catch (error) {
      if (error instanceof SyntaxError) return text("Invalid JSON", 400, rate.headers);
      return softDeleteErrorToResponse("package", error, rate.headers);
    }
  }

  if (packageSegments[0] !== "trusted-publisher" || packageSegments.length !== 1) {
    return text("Not found", 404, rate.headers);
  }

  try {
    await runMutationRef(ctx, internalRefs.packages.deleteTrustedPublisherForUserInternal, {
      actorUserId: auth.userId,
      packageName,
    });
    return json({ ok: true }, 200, rate.headers);
  } catch (error) {
    return text(
      error instanceof Error ? error.message : "Trusted publisher delete failed",
      400,
      rate.headers,
    );
  }
}

async function getReleaseForRequest(
  ctx: ActionCtx,
  pkg: Pick<PublicPackageDocLike, "_id" | "tags" | "latestReleaseId">,
  request: Request,
): Promise<ReleaseLike | null> {
  const url = new URL(request.url);
  const versionParam = url.searchParams.get("version")?.trim();
  const tagParam = url.searchParams.get("tag")?.trim();

  if (versionParam) {
    return toVisibleRelease(
      await runQueryRef<ReleaseLike | null>(
        ctx,
        internalRefs.packages.getReleaseByPackageAndVersionInternal,
        {
          packageId: pkg._id,
          version: versionParam,
        },
      ),
    );
  }
  if (tagParam) {
    const releaseId = pkg.tags[tagParam];
    if (!releaseId) return null;
    return toVisibleRelease(
      await runQueryRef<ReleaseLike | null>(ctx, internalRefs.packages.getReleaseByIdInternal, {
        releaseId,
      }),
    );
  }
  if (!pkg.latestReleaseId) return null;
  return toVisibleRelease(
    await runQueryRef<ReleaseLike | null>(ctx, internalRefs.packages.getReleaseByIdInternal, {
      releaseId: pkg.latestReleaseId,
    }),
  );
}

function isReadmeVariantPath(path: string) {
  const normalized = path.trim().toLowerCase();
  return (
    normalized === "readme.md" || normalized === "readme.mdx" || normalized === "readme.markdown"
  );
}

function resolveSkillFilePath(version: SkillVersionLike, requestedPath: string) {
  const normalized = requestedPath.trim();
  const lower = normalized.toLowerCase();
  if (isReadmeVariantPath(normalized)) {
    return (
      version.files.find((file) => {
        const fileLower = file.path.toLowerCase();
        return fileLower === "skill.md" || fileLower === "skills.md";
      }) ?? null
    );
  }
  return (
    version.files.find((file) => file.path === normalized) ??
    version.files.find((file) => file.path.toLowerCase() === lower) ??
    null
  );
}

function resolvePackageFilePath(release: ReleaseLike, requestedPath: string) {
  const normalized = requestedPath.trim();
  const lower = normalized.toLowerCase();
  if (isReadmeVariantPath(normalized)) {
    return (
      release.files.find((file) => isReadmeVariantPath(file.path)) ??
      release.files.find((file) => file.path.toLowerCase() === lower) ??
      null
    );
  }
  return (
    release.files.find((file) => file.path === normalized) ??
    release.files.find((file) => file.path.toLowerCase() === lower) ??
    null
  );
}

function getOwnerHandleParam(request: Request) {
  const url = new URL(request.url);
  const value = url.searchParams.get("ownerHandle") ?? url.searchParams.get("owner");
  return value?.trim().replace(/^@+/, "") || undefined;
}

async function getSkillDetailForRequest(ctx: ActionCtx, slug: string, ownerHandle?: string) {
  return (await runQueryRef(ctx, apiRefs.skills.getBySlug, {
    slug,
    ...(ownerHandle ? { ownerHandle } : {}),
  })) as {
    skill: SkillPackageDocLike | null;
    latestVersion: SkillVersionLike | null;
    owner: { handle?: string; displayName?: string; image?: string } | null;
    ambiguous?: boolean;
    ambiguousMatches?: Array<{ slug: string; ownerHandle?: string | null }>;
    moderationInfo?: {
      isPendingScan?: boolean | null;
      isMalwareBlocked?: boolean | null;
      isHiddenByMod?: boolean | null;
      isRemoved?: boolean | null;
      sourceVersionId?: Id<"skillVersions"> | null;
    } | null;
  } | null;
}

function ambiguousSkillChoicesForPackageRequest(
  request: Request,
  matches: Array<{ slug: string; ownerHandle?: string | null }> | undefined,
): AmbiguousSkillSlugChoice[] {
  return (matches ?? []).flatMap((match) => {
    const ownerHandle = match.ownerHandle?.trim().replace(/^@+/, "");
    if (!ownerHandle) return [];
    const slug = match.slug.trim().toLowerCase();
    if (!slug) return [];
    return [
      {
        ownerHandle,
        slug,
        ref: `@${ownerHandle}/${slug}`,
        url: new URL(
          `/${encodeURIComponent(ownerHandle)}/skills/${encodeURIComponent(slug)}`,
          request.url,
        ).toString(),
      },
    ];
  });
}

type PackageExactVersionModeratedSkill = Pick<
  Doc<"skills">,
  | "_id"
  | "softDeletedAt"
  | "latestVersionId"
  | "tags"
  | "moderationStatus"
  | "moderationReason"
  | "moderationFlags"
  | "moderationVerdict"
  | "moderationSourceVersionId"
>;

async function getUnavailableSkillPackageVersionBlock(
  ctx: ActionCtx,
  slug: string,
  ownerHandle: string | undefined,
  versionName: string,
) {
  const skill = await runQueryRef<PackageExactVersionModeratedSkill | null>(
    ctx,
    internalRefs.skills.getSkillBySlugInternal,
    { slug, ...(ownerHandle ? { ownerHandle } : {}) },
  );
  if (!skill || skill.softDeletedAt) return null;

  const version = (await runQueryRef(ctx, internalRefs.skills.getVersionBySkillAndVersionInternal, {
    skillId: skill._id,
    version: versionName,
  })) as SkillVersionLike | null;
  if (!version || !isSkillVersionForSkill(version, skill._id)) return null;
  if (version.softDeletedAt) return { status: 410, message: "Version not available" };

  return getPublicSkillVersionAccessBlock(
    getSkillFileModerationInfoFromSkill(skill),
    version._id,
    skill.latestVersionId ?? skill.tags?.latest,
  );
}

async function getSkillVersionForRequest(
  ctx: ActionCtx,
  skill: Pick<SkillPackageDocLike, "_id" | "latestVersionId" | "tags">,
  request: Request,
) {
  const url = new URL(request.url);
  const versionParam = url.searchParams.get("version")?.trim();
  const tagParam = url.searchParams.get("tag")?.trim();

  if (versionParam) {
    const version = (await runQueryRef(
      ctx,
      internalRefs.skills.getVersionBySkillAndVersionInternal,
      {
        skillId: skill._id,
        version: versionParam,
      },
    )) as SkillVersionLike | null;
    return isSkillVersionForSkill(version, skill._id) ? version : null;
  }
  if (tagParam) {
    const versionId = skill.tags[tagParam];
    if (!versionId) return null;
    const version = (await runQueryRef(ctx, internalRefs.skills.getVersionByIdInternal, {
      versionId,
    })) as SkillVersionLike | null;
    return isSkillVersionForSkill(version, skill._id) ? version : null;
  }
  const latestVersionId = skill.latestVersionId ?? skill.tags.latest;
  if (!latestVersionId) return null;
  const version = (await runQueryRef(ctx, internalRefs.skills.getVersionByIdInternal, {
    versionId: latestVersionId,
  })) as SkillVersionLike | null;
  return isSkillVersionForSkill(version, skill._id) ? version : null;
}

async function searchPackages(
  ctx: ActionCtx,
  request: Request,
  options?: { includeSkills?: boolean; pluginFamilies?: Array<"code-plugin" | "bundle-plugin"> },
) {
  const rate = await applyRateLimit(ctx, request, "read");
  if (!rate.ok) return rate.response;

  const url = new URL(request.url);
  const viewerUserId = await getOptionalViewerUserIdForRequest(ctx, request);
  const queryText = url.searchParams.get("q")?.trim() ?? "";
  if (!queryText) return text("Missing q query parameter", 400, rate.headers);
  const limit = Math.max(1, Math.min(toOptionalNumber(url.searchParams.get("limit")) ?? 20, 100));
  const familyParam = parseEnumQueryParam(url.searchParams, "family", publicPackageFamilyValues());
  if (!familyParam.ok) return text(familyParam.message, 400, rate.headers);
  const channelParam = parseEnumQueryParam(url.searchParams, "channel", PACKAGE_CHANNEL_VALUES);
  if (!channelParam.ok) return text(channelParam.message, 400, rate.headers);
  const isOfficial = parseBooleanQueryParam(url.searchParams, "isOfficial");
  if (!isOfficial.ok) return text(isOfficial.message, 400, rate.headers);
  const featured = parseBooleanQueryParam(url.searchParams, "featured");
  if (!featured.ok) return text(featured.message, 400, rate.headers);
  const highlightedOnlyParam = parseBooleanQueryParam(url.searchParams, "highlightedOnly");
  if (!highlightedOnlyParam.ok) return text(highlightedOnlyParam.message, 400, rate.headers);
  const highlightedOnly = featured.value === true || highlightedOnlyParam.value === true;
  const rawCreatedAfter = url.searchParams.get("createdAfter")?.trim();
  const createdAfter = rawCreatedAfter ? Number(rawCreatedAfter) : undefined;
  if (
    rawCreatedAfter &&
    (createdAfter === undefined || !Number.isSafeInteger(createdAfter) || createdAfter < 0)
  ) {
    return text("Invalid createdAfter", 400, rate.headers);
  }
  const rawCategory = url.searchParams.get("category")?.trim() || undefined;
  const category = resolvePluginCategoryFilter(rawCategory);
  const topic = url.searchParams.get("topic")?.trim().toLowerCase() || undefined;
  const excludedScanStatuses = parseExcludedScanStatuses(url.searchParams.get("excludeScanStatus"));
  if (!excludedScanStatuses.ok) {
    return text(excludedScanStatuses.message, 400, rate.headers);
  }
  if (rawCategory && !category) {
    return text("Invalid plugin category", 400, rate.headers);
  }
  const family = familyParam.value;
  const includeSkills = options?.includeSkills ?? family === undefined;
  if (category && (family === "skill" || family === "claw" || (!family && includeSkills))) {
    return text(
      "Plugin category is only supported for plugin package endpoints",
      400,
      rate.headers,
    );
  }
  if (
    createdAfter !== undefined &&
    (family === "skill" || family === "claw" || (!family && includeSkills))
  ) {
    return text("createdAfter is only supported for plugin package endpoints", 400, rate.headers);
  }

  let results: CatalogSearchEntry[];
  if (family === "skill") {
    results = await runQueryRef<CatalogSearchEntry[]>(
      ctx,
      internalRefs.skills.searchPackageCatalogForHttpInternal,
      {
        query: queryText,
        limit,
        channel: channelParam.value,
        isOfficial: isOfficial.value,
        highlightedOnly: highlightedOnly || undefined,
        topic,
      },
    );
  } else if (family || !includeSkills) {
    if (!family && options?.pluginFamilies?.length) {
      const pluginResults = await Promise.all(
        options.pluginFamilies.map((pluginFamily) =>
          searchPackageCatalog(ctx, {
            query: queryText,
            limit,
            family: pluginFamily,
            channel: channelParam.value,
            isOfficial: isOfficial.value,
            highlightedOnly: highlightedOnly || undefined,
            createdAfter,
            category,
            topic,
            excludedScanStatuses: excludedScanStatuses.value,
            viewerUserId: viewerUserId ?? undefined,
          }),
        ),
      );
      const seen = new Set<string>();
      results = pluginResults
        .flat()
        .filter((entry) => {
          const key = `${entry.package.family}:${entry.package.name}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort(compareCatalogSearchEntries)
        .slice(0, limit);
    } else {
      results = await searchPackageCatalog(ctx, {
        query: queryText,
        limit,
        family,
        channel: channelParam.value,
        isOfficial: isOfficial.value,
        highlightedOnly: highlightedOnly || undefined,
        createdAfter,
        category,
        topic,
        excludedScanStatuses: excludedScanStatuses.value,
        viewerUserId: viewerUserId ?? undefined,
      });
    }
  } else {
    const [packageResults, skillResults] = await Promise.all([
      searchPackageCatalog(ctx, {
        query: queryText,
        limit,
        channel: channelParam.value,
        isOfficial: isOfficial.value,
        highlightedOnly: highlightedOnly || undefined,
        createdAfter,
        category,
        topic,
        excludedScanStatuses: excludedScanStatuses.value,
        viewerUserId: viewerUserId ?? undefined,
      }),
      runQueryRef<CatalogSearchEntry[]>(
        ctx,
        internalRefs.skills.searchPackageCatalogForHttpInternal,
        {
          query: queryText,
          limit,
          channel: channelParam.value,
          isOfficial: isOfficial.value,
          highlightedOnly: highlightedOnly || undefined,
          topic,
        },
      ),
    ]);
    const seen = new Set<string>();
    results = [...packageResults, ...skillResults]
      .filter((entry) => {
        const key = `${entry.package.family}:${entry.package.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort(compareCatalogSearchEntries)
      .slice(0, limit);
  }
  return json({ results: results.map(toPublicCatalogSearchEntry) }, 200, rate.headers);
}

export async function packagesGetRouterV1Handler(ctx: ActionCtx, request: Request) {
  const segments = getPathSegments(request, "/api/v1/packages/");
  if (segments.length === 0) return text("Not found", 404);
  if (segments[0] === "search" && segments.length === 1) {
    return await searchPackages(ctx, request, { includeSkills: true });
  }

  if (segments[0] === "validation-report" && segments.length === 1) {
    const rate = await applyRateLimit(ctx, request, "read");
    if (!rate.ok) return rate.response;
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;
    const moderator = requireModeratorOrResponse(auth.user, rate.headers);
    if (!moderator.ok) return moderator.response;

    const url = new URL(request.url);
    const limit = Math.max(
      1,
      Math.min(toOptionalNumber(url.searchParams.get("limit")) ?? 100, 100),
    );
    const cursor = url.searchParams.get("cursor")?.trim() || undefined;
    const result = await runQueryRef(
      ctx,
      internalRefs.packages.listPluginValidationReportPageInternal,
      { cursor, numItems: limit },
    );
    return json(
      parseArk(
        ApiV1PackageValidationReportPageSchema,
        result,
        "Package validation report response",
      ),
      200,
      rate.headers,
    );
  }

  if (segments[0] === "moderation" && segments[1] === "queue" && segments.length === 2) {
    const rate = await applyRateLimit(ctx, request, "read");
    if (!rate.ok) return rate.response;
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;

    const url = new URL(request.url);
    const status = parsePackageModerationQueueStatus(url.searchParams.get("status"));
    if (!status) return text("Invalid moderation queue status", 400, rate.headers);
    const limit = Math.max(1, Math.min(toOptionalNumber(url.searchParams.get("limit")) ?? 25, 100));
    const cursor = url.searchParams.get("cursor");
    const result = await runQueryRef(
      ctx,
      internalRefs.packages.listPackageModerationQueueInternal,
      {
        actorUserId: auth.userId,
        cursor: cursor ?? null,
        limit,
        status,
      },
    );
    return json(result, 200, rate.headers);
  }

  if (segments[0] === "reports" && segments.length === 1) {
    const rate = await applyRateLimit(ctx, request, "read");
    if (!rate.ok) return rate.response;
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;

    const url = new URL(request.url);
    const status = parsePackageReportListStatus(url.searchParams.get("status"));
    if (!status) return text("Invalid package report status", 400, rate.headers);
    const limit = Math.max(1, Math.min(toOptionalNumber(url.searchParams.get("limit")) ?? 25, 100));
    const cursor = url.searchParams.get("cursor");
    const result = await runQueryRef(ctx, internalRefs.packages.listPackageReportsInternal, {
      actorUserId: auth.userId,
      cursor: cursor ?? null,
      limit,
      status,
    });
    return json(result, 200, rate.headers);
  }

  if (segments[0] === "appeals" && segments.length === 1) {
    const rate = await applyRateLimit(ctx, request, "read");
    if (!rate.ok) return rate.response;
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;

    const url = new URL(request.url);
    const status = parsePackageAppealListStatus(url.searchParams.get("status"));
    if (!status) return text("Invalid package appeal status", 400, rate.headers);
    const limit = Math.max(1, Math.min(toOptionalNumber(url.searchParams.get("limit")) ?? 25, 100));
    const cursor = url.searchParams.get("cursor");
    const result = await runQueryRef(ctx, internalRefs.packages.listPackageAppealsInternal, {
      actorUserId: auth.userId,
      cursor: cursor ?? null,
      limit,
      status,
    });
    return json(result, 200, rate.headers);
  }

  if (segments[0] === "migrations" && segments.length === 1) {
    const rate = await applyRateLimit(ctx, request, "read");
    if (!rate.ok) return rate.response;
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;

    const url = new URL(request.url);
    const phase = parsePackageOfficialMigrationPhase(url.searchParams.get("phase"));
    if (!phase) return text("Invalid official migration phase", 400, rate.headers);
    const limit = Math.max(1, Math.min(toOptionalNumber(url.searchParams.get("limit")) ?? 25, 100));
    const cursor = url.searchParams.get("cursor");
    const result = await runQueryRef(
      ctx,
      internalRefs.packages.listOfficialPluginMigrationsInternal,
      {
        actorUserId: auth.userId,
        cursor: cursor ?? null,
        limit,
        phase,
      },
    );
    const parsed = parseArk(
      ApiV1PackageOfficialMigrationListResponseSchema,
      result,
      "Package official migration list response",
    );
    return json(parsed, 200, rate.headers);
  }

  const packageRoute = parsePackagePathSegments(segments);
  if (!packageRoute) return text("Not found", 404);
  const packageName = packageRoute.packageName;
  const packageSegments = packageRoute.rest;

  if (packageSegments[0] === "moderation" && packageSegments.length === 1) {
    const rate = await applyRateLimit(ctx, request, "read");
    if (!rate.ok) return rate.response;
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;

    try {
      const result = await runQueryRef(
        ctx,
        internalRefs.packages.getPackageModerationStatusForUserInternal,
        {
          actorUserId: auth.userId,
          name: packageName,
        },
      );
      const parsed = parseArk(
        ApiV1PackageModerationStatusResponseSchema,
        result,
        "Package moderation status response",
      );
      return json(parsed, 200, rate.headers);
    } catch (error) {
      return text(
        error instanceof Error ? error.message : "Package moderation status failed",
        400,
        rate.headers,
      );
    }
  }

  const rateKind =
    packageSegments[0] === "download" ||
    packageSegments[2] === "artifact" ||
    packageSegments[3] === "download"
      ? "download"
      : "read";
  const rate = await applyRateLimit(ctx, request, rateKind);
  if (!rate.ok) return rate.response;
  const normalizedPackageName = tryNormalizePackageName(packageName);
  if (!normalizedPackageName) return text("Package not found", 404, rate.headers);

  const viewerUserId = await getOptionalViewerUserIdForRequest(ctx, request);
  if (
    packageSegments[0] === "versions" &&
    packageSegments[1] &&
    packageSegments[2] === "security" &&
    packageSegments.length === 3
  ) {
    const result = (await runQueryRef(
      ctx,
      internalRefs.packages.getVersionSecurityByNameForViewerInternal,
      {
        name: normalizedPackageName,
        version: packageSegments[1],
        viewerUserId: viewerUserId ?? undefined,
      },
    )) as { package: PublicPackageDocLike; version: ReleaseLike } | null;
    if (!result) return text("Package security not found", 404, rate.headers);
    const parsed = parseArk(
      ApiV1PackageSecurityResponseSchema,
      toPackageReleaseSecurityResponse({
        request,
        pkg: result.package,
        release: result.version,
      }),
      "Package security response",
    );
    return json(parsed, 200, rate.headers);
  }

  const ownerHandle = getOwnerHandleParam(request);
  const isExactVersionRequest =
    packageSegments[0] === "versions" && packageSegments[1] && packageSegments.length === 2;
  const detail = (await runQueryRef(ctx, internalRefs.packages.getByNameForViewerInternal, {
    name: normalizedPackageName,
    viewerUserId: viewerUserId ?? undefined,
  })) as {
    package: PublicPackageDocLike | null;
    latestRelease: ReleaseLike | null;
    owner: { _id: Id<"users">; handle?: string; displayName?: string; image?: string } | null;
  } | null;
  const skillDetail = detail?.package
    ? null
    : await getSkillDetailForRequest(ctx, normalizedPackageName, ownerHandle);
  if (!detail?.package && !skillDetail?.skill) {
    if (isExactVersionRequest) {
      const moderationBlock = await getUnavailableSkillPackageVersionBlock(
        ctx,
        normalizedPackageName,
        ownerHandle,
        packageSegments[1],
      );
      if (moderationBlock) {
        return text(moderationBlock.message, moderationBlock.status, rate.headers);
      }
    }
    if (skillDetail?.ambiguous) {
      return ambiguousSkillSlugResponse(
        normalizedPackageName,
        `/api/v1/packages/${encodeURIComponent(normalizedPackageName)}?ownerHandle=<owner>`,
        rate.headers,
        ambiguousSkillChoicesForPackageRequest(request, skillDetail.ambiguousMatches),
      );
    }
    return text("Package not found", 404, rate.headers);
  }
  const packageDetail = detail?.package ? detail : null;
  const publicPackage = packageDetail?.package ?? null;
  const packageOwner = packageDetail?.owner ?? null;

  if (packageSegments.length === 0) {
    if (skillDetail?.skill) {
      return json(
        toSkillPackageDetail(
          skillDetail.skill,
          skillDetail.latestVersion,
          skillDetail.owner,
          await resolveSkillTags(
            ctx,
            skillDetail.skill._id,
            skillDetail.skill.tags,
            skillDetail.latestVersion,
          ),
        ),
        200,
        rate.headers,
      );
    }
    const tags = await resolvePackageTags(ctx, publicPackage!.tags);

    return json(
      {
        package: {
          ...toPackageDetailResponsePackage(publicPackage!),
          tags,
        },
        owner: packageOwner
          ? {
              handle: packageOwner.handle ?? null,
              displayName: packageOwner.displayName ?? null,
              image: packageOwner.image ?? null,
            }
          : null,
      },
      200,
      rate.headers,
    );
  }

  if (packageSegments[0] === "trusted-publisher" && packageSegments.length === 1) {
    if (!publicPackage) return text("Not found", 404, rate.headers);
    const trustedPublisher = await runQueryRef<PackageTrustedPublisherLike | null>(
      ctx,
      internalRefs.packages.getTrustedPublisherByPackageIdInternal,
      { packageId: publicPackage._id },
    );
    return json(
      { trustedPublisher: toPublicTrustedPublisher(trustedPublisher) },
      200,
      rate.headers,
    );
  }

  if (packageSegments[0] === "readiness" && packageSegments.length === 1) {
    if (!publicPackage) return text("Not found", 404, rate.headers);
    return json(buildPackageReadiness(publicPackage), 200, rate.headers);
  }

  if (packageSegments[0] === "versions" && packageSegments.length === 1) {
    const limit = Math.max(
      1,
      Math.min(toOptionalNumber(new URL(request.url).searchParams.get("limit")) ?? 25, 100),
    );
    const cursor = new URL(request.url).searchParams.get("cursor");
    if (skillDetail?.skill) {
      const result = (await runQueryRef(ctx, apiRefs.skills.listVersionsPage, {
        skillId: skillDetail.skill._id,
        cursor: cursor ?? undefined,
        limit,
      })) as {
        items: Array<{ version: string; createdAt: number; changelog: string }>;
        nextCursor: string | null;
      };
      const tags = await resolveSkillTags(ctx, skillDetail.skill._id, skillDetail.skill.tags);
      return json(
        {
          items: result.items.map((version) => ({
            version: version.version,
            createdAt: version.createdAt,
            changelog: version.changelog,
            distTags: skillVersionTags(tags, version.version),
          })),
          nextCursor: result.nextCursor,
        },
        200,
        rate.headers,
      );
    }
    const result = await runQueryRef<{
      page: ReleaseLike[];
      isDone: boolean;
      continueCursor: string | null;
    }>(ctx, internalRefs.packages.listVersionsForViewerInternal, {
      name: packageName,
      viewerUserId: viewerUserId ?? undefined,
      paginationOpts: { cursor, numItems: limit },
    });
    return json(
      {
        items: result.page.map((release: ReleaseLike) => ({
          version: release.version,
          createdAt: release.createdAt,
          changelog: release.changelog,
          distTags: release.distTags ?? [],
        })),
        nextCursor: result.isDone ? null : result.continueCursor,
      },
      200,
      rate.headers,
    );
  }

  if (
    packageSegments[0] === "versions" &&
    packageSegments[1] &&
    packageSegments[2] === "artifact"
  ) {
    if (skillDetail?.skill) return text("Artifact not found", 404, rate.headers);
    const result = (await runQueryRef(
      ctx,
      internalRefs.packages.getVersionByNameForViewerInternal,
      {
        name: packageName,
        version: packageSegments[1],
        viewerUserId: viewerUserId ?? undefined,
      },
    )) as { package: PublicPackageDocLike; version: ReleaseLike } | null;
    const release = result?.version ?? null;
    if (!release) return text("Version not found", 404, rate.headers);
    if (packageSegments[3] === "download") {
      if (release.artifactKind === "npm-pack") {
        return await streamClawPackRelease(
          ctx,
          request,
          rate.headers,
          publicPackage!,
          release,
          viewerUserId ?? null,
        );
      }
      const url = new URL(
        `/api/v1/packages/${encodePackagePath(publicPackage!.name)}/download`,
        request.url,
      );
      url.searchParams.set("version", release.version);
      return new Response(null, {
        status: 307,
        headers: mergeHeaders(rate.headers, { Location: url.toString() }, corsHeaders()),
      });
    }
    return json(
      {
        package: {
          name: publicPackage!.name,
          displayName: publicPackage!.displayName,
          family: publicPackage!.family,
        },
        version: release.version,
        artifact: {
          ...toReleaseArtifact(release, publicPackage!.name),
          ...releaseArtifactUrls(request, publicPackage!.name, release),
        },
      },
      200,
      rate.headers,
    );
  }

  if (packageSegments[0] === "versions" && packageSegments[1]) {
    if (skillDetail?.skill) {
      const version = (await runQueryRef(
        ctx,
        internalRefs.skills.getVersionBySkillAndVersionInternal,
        {
          skillId: skillDetail.skill._id,
          version: packageSegments[1],
        },
      )) as SkillVersionLike | null;
      if (!version || version.softDeletedAt) return text("Version not found", 404, rate.headers);
      const effectiveLatestVersionId =
        skillDetail.skill.latestVersionId ?? skillDetail.skill.tags?.latest;
      const moderationBlock = getPublicSkillVersionAccessBlock(
        skillDetail.moderationInfo,
        version._id,
        effectiveLatestVersionId,
      );
      if (moderationBlock)
        return text(moderationBlock.message, moderationBlock.status, rate.headers);
      const tags = await resolveSkillTags(ctx, skillDetail.skill._id, skillDetail.skill.tags);
      return json(
        {
          package: {
            name: skillDetail.skill.slug,
            displayName: skillDetail.skill.displayName,
            family: "skill",
          },
          version: {
            version: version.version,
            createdAt: version.createdAt,
            changelog: version.changelog,
            distTags: skillVersionTags(tags, version.version),
            files: version.files.map((file) => ({
              path: file.path,
              size: file.size,
              sha256: file.sha256,
              contentType: file.contentType,
            })),
            compatibility: null,
            verification: null,
            artifact: null,
          },
        },
        200,
        rate.headers,
      );
    }
    const result = (await runQueryRef(
      ctx,
      internalRefs.packages.getVersionByNameForViewerInternal,
      {
        name: packageName,
        version: packageSegments[1],
        viewerUserId: viewerUserId ?? undefined,
      },
    )) as { package: PublicPackageDocLike; version: ReleaseLike } | null;
    if (!result) return text("Version not found", 404, rate.headers);
    const scanStatus = resolvePackageReleaseScanStatus(result.version);
    const verification = result.version.verification
      ? { ...result.version.verification, scanStatus }
      : null;
    return json(
      {
        package: {
          name: result.package.name,
          displayName: result.package.displayName,
          family: result.package.family,
        },
        version: {
          version: result.version.version,
          createdAt: result.version.createdAt,
          changelog: result.version.changelog,
          distTags: result.version.distTags ?? [],
          files: result.version.files.map((file) => ({
            path: file.path,
            size: file.size,
            sha256: file.sha256,
            contentType: file.contentType,
          })),
          compatibility: result.version.compatibility ?? null,
          pluginManifestSummary: result.version.pluginManifestSummary ?? null,
          clawManifestSummary: result.version.clawManifestSummary ?? null,
          verification,
          artifact: toReleaseArtifact(result.version, result.package.name),
          sha256hash: result.version.sha256hash ?? null,
          vtAnalysis: result.version.vtAnalysis ?? null,
          skillSpectorAnalysis: result.version.skillSpectorAnalysis ?? null,
          llmAnalysis: result.version.llmAnalysis ?? null,
          staticScan: result.version.staticScan ?? null,
        },
      },
      200,
      rate.headers,
    );
  }

  if (packageSegments[0] === "file") {
    const requestUrl = new URL(request.url);
    const path = requestUrl.searchParams.get("path")?.trim();
    if (!path) return text("Missing path", 400, rate.headers);
    const preview = requestUrl.searchParams.get("preview") === "1";
    if (skillDetail?.skill) {
      const version = await getSkillVersionForRequest(ctx, skillDetail.skill, request);
      if (!version || version.softDeletedAt) return text("Version not found", 404, rate.headers);
      const effectiveLatestVersionId =
        skillDetail.skill.latestVersionId ?? skillDetail.skill.tags?.latest;
      const moderationBlock = getPublicSkillVersionDownloadBlock(
        skillDetail.moderationInfo,
        version,
        effectiveLatestVersionId,
      );
      if (moderationBlock)
        return text(moderationBlock.message, moderationBlock.status, rate.headers);
      const file = resolveSkillFilePath(version, path);
      if (!file) return text("File not found", 404, rate.headers);
      if (!("storageId" in file) || !file.storageId)
        return text("File not found", 404, rate.headers);
      const maxBytes = preview ? MAX_RAW_FILE_BYTES : MAX_PUBLISH_FILE_BYTES;
      if (file.size > maxBytes) return text("File too large", 413, rate.headers);
      const blob = await ctx.storage.get(file.storageId);
      if (!blob) return text("File not found", 404, rate.headers);
      if (preview) {
        return await safeStoredFilePreviewResponse({
          blob,
          path: file.path,
          contentType: file.contentType,
          sha256: file.sha256,
          size: file.size,
          headers: rate.headers,
        });
      }
      return await safeStoredFileResponse({
        blob,
        path: file.path,
        contentType: file.contentType,
        sha256: file.sha256,
        size: file.size,
        headers: rate.headers,
      });
    }
    const release = await getReleaseForRequest(ctx, publicPackage!, request);
    if (!release) return text("Version not found", 404, rate.headers);
    const securityBlock = getReleaseSecurityBlock(release);
    if (securityBlock) return text(securityBlock.message, securityBlock.status, rate.headers);
    const file = resolvePackageFilePath(release, path);
    if (!file) return text("File not found", 404, rate.headers);
    const maxBytes = preview ? MAX_RAW_FILE_BYTES : MAX_PUBLISH_FILE_BYTES;
    if (file.size > maxBytes) return text("File too large", 413, rate.headers);
    const blob = await ctx.storage.get(file.storageId);
    if (!blob) return text("File not found", 404, rate.headers);
    const responseParams = {
      blob,
      path: file.path,
      contentType: file.contentType,
      sha256: file.sha256,
      size: file.size,
      headers: rate.headers,
    };
    return preview
      ? await safeStoredFilePreviewResponse(responseParams)
      : await safeStoredFileResponse(responseParams);
  }

  if (packageSegments[0] === "download") {
    if (skillDetail?.skill) {
      const url = new URL("/api/v1/download", request.url);
      url.searchParams.set("slug", skillDetail.skill.slug);
      if (skillDetail.owner?.handle) {
        url.searchParams.set("ownerHandle", skillDetail.owner.handle);
      }
      const requestUrl = new URL(request.url);
      const version = requestUrl.searchParams.get("version")?.trim();
      const tag = requestUrl.searchParams.get("tag")?.trim();
      if (version) url.searchParams.set("version", version);
      if (tag) url.searchParams.set("tag", tag);
      return new Response(null, {
        status: 307,
        headers: mergeHeaders(rate.headers, { Location: url.toString() }, corsHeaders()),
      });
    }
    const release = await getReleaseForRequest(ctx, publicPackage!, request);
    if (!release) return text("Version not found", 404, rate.headers);
    const securityBlock = getReleaseSecurityBlock(release);
    if (securityBlock) return text(securityBlock.message, securityBlock.status, rate.headers);
    const storedZip =
      release.artifactKind === "legacy-zip" && release.clawpackStorageId
        ? await ctx.storage.get(release.clawpackStorageId)
        : null;
    if (release.artifactKind === "legacy-zip" && release.clawpackStorageId && !storedZip) {
      return text("Missing stored package artifact", 500, rate.headers);
    }
    let zip: Uint8Array;
    if (storedZip) {
      zip = new Uint8Array(await storedZip.arrayBuffer());
    } else {
      // Historical legacy releases and npm packs need a compatibility ZIP projection.
      const entries: Array<{ path: string; bytes: Uint8Array }> = [];
      for (const file of release.files) {
        const blob = await ctx.storage.get(file.storageId);
        if (!blob) return text(`Missing stored file: ${file.path}`, 500, rate.headers);
        entries.push({
          path: file.path,
          bytes: new Uint8Array(await blob.arrayBuffer()),
        });
      }
      zip = buildDeterministicPackageZip(entries);
    }
    const [zipSha256, zipSha256Base64] = await Promise.all([sha256Hex(zip), sha256Base64(zip)]);
    try {
      const identity = getDownloadIdentity(request, viewerUserId ? String(viewerUserId) : null);
      if (identity) {
        await runMutationRef(
          ctx,
          internalRefs.downloadMetrics.recordDownloadMetricInternal,
          await buildDownloadMetricArgs({
            target: { kind: "package", id: publicPackage!._id },
            identity,
            now: Date.now(),
          }),
        );
      }
    } catch {
      // Best-effort metric path; never fail package downloads.
    }
    const zipBody = zip.buffer.slice(
      zip.byteOffset,
      zip.byteOffset + zip.byteLength,
    ) as ArrayBuffer;
    return new Response(new Blob([zipBody], { type: "application/zip" }), {
      status: 200,
      headers: mergeHeaders(
        rate.headers,
        {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${publicPackage!.name.replaceAll("/", "-")}-${release.version}.zip"`,
          ETag: `"sha256:${zipSha256}"`,
          Digest: `sha-256=${zipSha256Base64}`,
          "X-ClawHub-Artifact-Type": "legacy-plugin-zip",
          "X-ClawHub-Artifact-Sha256": zipSha256,
        },
        corsHeaders(),
      ),
    });
  }

  return text("Not found", 404, rate.headers);
}

function parseNpmMirrorPath(request: Request) {
  const segments = getPathSegments(request, "/api/npm/");
  if (segments.length === 0) return null;
  return parsePackagePathSegments(segments);
}

type NpmPackReleasePage = {
  page: ReleaseLike[];
  isDone: boolean;
  continueCursor: string | null;
};

async function listNpmPackReleases(
  ctx: ActionCtx,
  packageName: string,
  viewerUserId: Id<"users"> | null,
) {
  const releases: ReleaseLike[] = [];
  let cursor: string | null = null;
  let done = false;
  let pages = 0;
  while (!done && pages < 20) {
    pages += 1;
    const result: NpmPackReleasePage = await runQueryRef(
      ctx,
      internalRefs.packages.listVersionsForViewerInternal,
      {
        name: packageName,
        viewerUserId: viewerUserId ?? undefined,
        paginationOpts: { cursor, numItems: 100 },
      },
    );
    releases.push(
      ...result.page.filter(
        (release: ReleaseLike) =>
          release.artifactKind === "npm-pack" &&
          Boolean(release.clawpackStorageId) &&
          Boolean(release.npmIntegrity) &&
          Boolean(release.npmShasum),
      ),
    );
    done = result.isDone;
    cursor = result.continueCursor;
    if (!cursor && !done) break;
  }
  return releases;
}

function packageJsonDependencies(packageJson: unknown) {
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) return {};
  const dependencies = (packageJson as { dependencies?: unknown }).dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) return {};
  return Object.fromEntries(
    Object.entries(dependencies as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export async function npmMirrorGetHandler(ctx: ActionCtx, request: Request) {
  const path = parseNpmMirrorPath(request);
  if (!path) return text("Not found", 404);
  const isTarballRequest = path.rest[0] === "-" && Boolean(path.rest[1]);
  const rate = await applyRateLimit(ctx, request, isTarballRequest ? "download" : "read");
  if (!rate.ok) return rate.response;
  const normalizedPackageName = tryNormalizePackageName(path.packageName);
  if (!normalizedPackageName) return text("Package not found", 404, rate.headers);

  const viewerUserId = await getOptionalViewerUserIdForRequest(ctx, request);
  const detail = (await runQueryRef(ctx, internalRefs.packages.getByNameForViewerInternal, {
    name: normalizedPackageName,
    viewerUserId: viewerUserId ?? undefined,
  })) as {
    package: PublicPackageDocLike | null;
    latestRelease: ReleaseLike | null;
    owner: { _id: Id<"users">; handle?: string; displayName?: string; image?: string } | null;
  } | null;
  if (!detail?.package) return text("Package not found", 404, rate.headers);

  const releases = await listNpmPackReleases(ctx, normalizedPackageName, viewerUserId);
  if (isTarballRequest) {
    const tarballName = path.rest[1]!;
    const release = releases.find((candidate) => candidate.npmTarballName === tarballName);
    if (!release) return text("ClawPack artifact not found", 404, rate.headers);
    return await streamClawPackRelease(
      ctx,
      request,
      rate.headers,
      detail.package,
      release,
      viewerUserId ?? null,
      "install",
    );
  }
  if (path.rest.length > 0) return text("Not found", 404, rate.headers);

  const versions = Object.fromEntries(
    releases.map((release) => {
      const artifact = toReleaseArtifact(release, detail.package!.name);
      const urls = releaseArtifactUrls(request, detail.package!.name, release);
      return [
        release.version,
        {
          name: detail.package!.name,
          version: release.version,
          description: detail.package!.summary ?? undefined,
          dependencies: packageJsonDependencies(release.extractedPackageJson),
          dist: {
            tarball: urls.tarballUrl,
            integrity: artifact.npmIntegrity,
            shasum: artifact.npmShasum,
          },
        },
      ];
    }),
  );
  const latestNpmRelease =
    releases.find((release) => release.distTags?.includes("latest")) ?? releases[0] ?? null;
  return json(
    {
      name: detail.package.name,
      "dist-tags": latestNpmRelease ? { latest: latestNpmRelease.version } : {},
      versions,
    },
    200,
    rate.headers,
  );
}

export async function pluginsGetRouterV1Handler(ctx: ActionCtx, request: Request) {
  const segments = getPathSegments(request, "/api/v1/plugins/");
  if (segments.length === 0) return text("Not found", 404);
  if (segments[0] === "search" && new URL(request.url).searchParams.has("q")) {
    return await searchPackages(ctx, request, {
      includeSkills: false,
      pluginFamilies: ["code-plugin", "bundle-plugin"],
    });
  }
  return text("Not found", 404);
}

type PublicPackageDocLike = {
  _id: Id<"packages">;
  name: string;
  displayName: string;
  family: "skill" | "code-plugin" | "bundle-plugin" | "claw";
  tags: Record<string, Id<"packageReleases">>;
  latestReleaseId?: Id<"packageReleases">;
  channel: "official" | "community" | "private";
  isOfficial: boolean;
  scanStatus?: Doc<"packages">["scanStatus"];
  publicDownloadBlocked?: boolean;
  runtimeId?: string;
  summary?: string;
  latestVersion?: string | null;
  compatibility?: Doc<"packages">["compatibility"];
  verification?: Doc<"packages">["verification"];
  artifact?: {
    kind: "legacy-zip" | "npm-pack";
    sha256?: string;
    size?: number;
    format?: string;
    npmIntegrity?: string;
    npmShasum?: string;
    npmTarballName?: string;
    npmUnpackedSize?: number;
    npmFileCount?: number;
  };
  clawManifestSummary?: Doc<"packageReleases">["clawManifestSummary"];
  stats?: { downloads: number; installs: number; stars: number; versions: number };
  createdAt: number;
  updatedAt: number;
};

type PackageReadinessCheck = {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  message: string;
};

function buildPackageReadiness(pkg: PublicPackageDocLike) {
  const checks: PackageReadinessCheck[] = [];
  const add = (check: PackageReadinessCheck) => checks.push(check);
  const scanStatus = pkg.verification?.scanStatus ?? "not-run";

  add({
    id: "official",
    label: "Official package",
    status: pkg.isOfficial ? "pass" : "fail",
    message: pkg.isOfficial ? "Package is official." : "Package is not in the official channel.",
  });
  add({
    id: "latest-version",
    label: "Latest version",
    status: pkg.latestVersion ? "pass" : "fail",
    message: pkg.latestVersion ? `Latest version is ${pkg.latestVersion}.` : "No latest version.",
  });
  add({
    id: "clawpack",
    label: "ClawPack artifact",
    status: pkg.artifact?.kind === "npm-pack" ? "pass" : "fail",
    message:
      pkg.artifact?.kind === "npm-pack"
        ? "Latest version has an npm-pack ClawPack artifact."
        : "Latest version is legacy ZIP-only.",
  });
  add({
    id: "artifact-digest",
    label: "Artifact digest",
    status: pkg.artifact?.sha256 ? "pass" : "fail",
    message: pkg.artifact?.sha256 ? "Artifact has a SHA-256 digest." : "Artifact digest missing.",
  });
  add({
    id: "source",
    label: "Source provenance",
    status: pkg.verification?.sourceRepo && pkg.verification?.sourceCommit ? "pass" : "fail",
    message:
      pkg.verification?.sourceRepo && pkg.verification?.sourceCommit
        ? `Source is ${pkg.verification.sourceRepo}@${pkg.verification.sourceCommit}.`
        : "Source repo and commit are required.",
  });
  add({
    id: "compatibility",
    label: "OpenClaw compatibility",
    status:
      pkg.compatibility?.pluginApiRange && pkg.compatibility?.builtWithOpenClawVersion
        ? "pass"
        : "fail",
    message:
      pkg.compatibility?.pluginApiRange && pkg.compatibility?.builtWithOpenClawVersion
        ? `pluginApi=${pkg.compatibility.pluginApiRange}, builtWith=${pkg.compatibility.builtWithOpenClawVersion}.`
        : "pluginApi range and build OpenClaw version are required.",
  });
  add({
    id: "scan",
    label: "Security scan",
    status:
      scanStatus === "clean"
        ? "pass"
        : scanStatus === "pending" || scanStatus === "not-run"
          ? "warn"
          : "fail",
    message: `Scan status is ${scanStatus}.`,
  });

  const blockers = checks.filter((check) => check.status === "fail").map((check) => check.id);
  return {
    package: {
      name: pkg.name,
      displayName: pkg.displayName,
      family: pkg.family,
      isOfficial: pkg.isOfficial,
      latestVersion: pkg.latestVersion ?? null,
    },
    ready: blockers.length === 0,
    checks,
    blockers,
  };
}
