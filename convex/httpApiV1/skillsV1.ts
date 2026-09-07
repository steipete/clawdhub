import {
  ApiRoutes,
  ApiV1SkillUploadUrlRequestSchema,
  ApiV1SkillBulkRescanBatchRequestSchema,
  ApiV1SkillBulkRescanStatusRequestSchema,
  ApiV1SkillHardDeleteRequestSchema,
  ApiV1SkillRepairVtPendingRequestSchema,
  ApiV1SkillScanBatchRequestSchema,
  ApiV1SkillScanBatchStatusRequestSchema,
  ApiV1SkillScanSubmitRequestSchema,
  SkillAppealRequestSchema,
  SkillAppealResolveRequestSchema,
  SkillReportTriageRequestSchema,
  SkillVersionRevokeRequestSchema,
  formatSecurityAuditOverview,
  normalizeContentType,
  parseArk,
  type SkillAppealListStatus,
  type SkillReportListStatus,
} from "clawhub-schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { getOptionalApiTokenUserId, requireApiTokenUser } from "../lib/apiTokenAuth";
import {
  ARCHIVE_MANIFEST_AUDIENCE,
  ARCHIVE_MANIFEST_CONTENT_TYPE,
  ARCHIVE_MANIFEST_JWS_TYPE,
  signArchivePayload,
  type SkillExportArchiveManifest,
} from "../lib/archiveManifest";
import { serializeCanonicalSkillSearchResults } from "../lib/canonicalSkillSearchResponse";
import {
  ARCHIVE_REQUEST_IDENTITY_HEADER,
  expectedVercelEnvironmentForConvexSite,
  type ClawHubVercelEnvironment,
  verifyClawHubVercelOidcToken,
} from "../lib/clawhubVercelOidc";
import {
  buildGitHubSkillHandoffDescriptor,
  getGitHubHandoffBlock,
  isReadyGitHubHandoffTarget,
  type GitHubHandoffTarget,
  type ReadyGitHubHandoffTarget,
} from "../lib/githubHandoff";
import { mergeHeaders } from "../lib/httpHeaders";
import { applyRateLimit } from "../lib/httpRateLimit";
import { parseBooleanQueryParam, resolveBooleanQueryParam } from "../lib/httpUtils";
import {
  buildSkillInstallResolution,
  type InstallResolverSkill,
  type InstallResolverSource,
  type SkillInstallResolution,
} from "../lib/installResolver";
import { normalizePublisherHandle } from "../lib/publishers";
import { MAX_PUBLISH_FILE_BYTES } from "../lib/publishLimits";
import { getRuntimeRolloutCapabilities } from "../lib/rolloutCapabilities";
import type {
  LlmAgenticRiskFinding,
  LlmEvalDimension,
  LlmRiskSummary,
} from "../lib/securityPrompt";
import { selectGeneratedSkillCardFile, sourceSkillVersionFiles } from "../lib/skillCards";
import {
  getPublicSkillFileAccessBlock,
  getPublicSkillVersionAccessBlock,
  getPublicSkillVersionDownloadBlock,
  getSkillFileModerationInfoFromSkill,
  isSkillVersionForSkill,
} from "../lib/skillFileAccess";
import { normalizeSkillSlug } from "../lib/skillSlugValidator";
import {
  buildDeterministicZip,
  buildMergedExportZip,
  type MergedExportManifestEntry,
  validateExportArchivePath,
  validateSlug,
  validateFilePath,
} from "../lib/skillZip";
import { publishVersionForUser } from "../skills";
import {
  MAX_RAW_FILE_BYTES,
  type AmbiguousSkillSlugChoice,
  ambiguousSkillSlugResponse,
  deleteStoredMultipartFiles,
  formatAuthzMessage,
  formatUserFacingErrorMessage,
  getPathSegments,
  json,
  parseJsonPayload,
  parseMultipartPublish,
  parsePublishBody,
  publicApiOrigin,
  requireAdminOrResponse,
  requireApiTokenUserOrResponse,
  resolveTagsBatch,
  safeStoredFilePreviewResponse,
  safeStoredFileResponse,
  safeTextFileResponse,
  softDeleteErrorToResponse,
  text,
  toOptionalNumber,
} from "./shared";
import {
  parseSkillsShCatalogReference,
  resolveSkillsShInstall,
  resolveSkillsShVerify,
} from "./skillsShCatalogV1";

const MAX_EXPORT_FILE_COUNT = 10_000;
const MAX_EXPORT_PAGE_LIMIT = 250;
const DEFAULT_EXPORT_PAGE_LIMIT = 250;
const MAX_EXPORT_TOTAL_BYTES = 256 * 1024 * 1024;
const ARCHIVE_MANIFEST_REQUEST_HEADER = "x-clawhub-archive-manifest";
const ARCHIVE_MANIFEST_TTL_MS = 30_000;
// Covers the 10,000-file export contract (including long paths and JWS
// expansion) while keeping the trusted Nitro handoff materially bounded.
const MAX_ARCHIVE_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_SECURITY_VERDICT_ITEMS = 100;

type SkillsExportDependencies = {
  verifyArchiveRequester: (
    token: string,
    expectedEnvironment: ClawHubVercelEnvironment,
  ) => Promise<unknown>;
  signArchiveManifest: (manifest: SkillExportArchiveManifest) => Promise<string>;
};

const DEFAULT_SKILLS_EXPORT_DEPENDENCIES: SkillsExportDependencies = {
  verifyArchiveRequester: verifyClawHubVercelOidcToken,
  signArchiveManifest: (manifest) => signArchivePayload(manifest, ARCHIVE_MANIFEST_JWS_TYPE),
};

async function readRequestBodyWithinLimit(request: Request, maxBytes: number) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel("Upload exceeds its declared size").catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

type ListSkillsResult = {
  items: Array<{
    skill: {
      _id: Id<"skills">;
      slug: string;
      displayName: string;
      summary?: string;
      topics?: string[];
      tags: Record<string, Id<"skillVersions">>;
      stats: unknown;
      createdAt: number;
      updatedAt: number;
      latestVersionId?: Id<"skillVersions">;
    };
    latestVersion: {
      _id: Id<"skillVersions">;
      version: string;
      createdAt: number;
      changelog: string;
      parsed?: PublicSkillVersionParsed;
    } | null;
  }>;
  nextCursor: string | null;
};

type PublicSkillVersionFile = {
  path: string;
  size: number;
  sha256: string;
  contentType?: string;
};

type PublicSkillVersionParsed = {
  description?: string;
  license?: "MIT-0";
  clawdis?: {
    os?: string[];
    nix?: { plugin?: boolean; systems?: string[] };
    requires?: { env?: string[]; config?: string[] };
    envVars?: Array<{ name: string; required?: boolean; description?: string }>;
  };
};

type SkillSetupEntry = {
  key: string;
  required: boolean;
};

type PublicSkillVersionStaticScan = Pick<
  NonNullable<Doc<"skillVersions">["staticScan"]>,
  "status" | "reasonCodes" | "summary" | "engineVersion" | "checkedAt"
>;

type PublicSkillVersionResponse = {
  _id: Id<"skillVersions">;
  skillId?: Id<"skills">;
  version: string;
  createdAt?: number;
  changelog?: string;
  changelogSource?: "auto" | "user";
  files: PublicSkillVersionFile[];
  parsed?: PublicSkillVersionParsed;
  softDeletedAt?: number;
  sha256hash?: string;
  vtAnalysis?: Doc<"skillVersions">["vtAnalysis"];
  skillSpectorAnalysis?: Doc<"skillVersions">["skillSpectorAnalysis"];
  llmAnalysis?: Doc<"skillVersions">["llmAnalysis"];
  staticScan?: PublicSkillVersionStaticScan;
};

type ModerationEvidence = {
  code: string;
  severity: "info" | "warn" | "critical";
  file: string;
  line: number;
  message: string;
  evidence: string;
};

type SkillModerationShape = {
  moderationFlags?: string[];
  moderationVerdict?: "clean" | "suspicious" | "malicious";
  moderationReasonCodes?: string[];
  moderationSummary?: string;
  moderationEngineVersion?: string;
  moderationEvaluatedAt?: number;
  moderationReason?: string;
  moderationEvidence?: ModerationEvidence[];
  updatedAt?: number;
};

type GetBySlugResult = {
  skill: {
    _id: Id<"skills">;
    slug: string;
    displayName: string;
    summary?: string;
    icon?: string;
    topics?: string[];
    tags: Record<string, Id<"skillVersions">>;
    stats: unknown;
    createdAt: number;
    updatedAt: number;
    latestVersionId?: Id<"skillVersions">;
  } | null;
  latestVersion: PublicSkillVersionResponse | null;
  owner: { _id: Id<"users">; handle?: string; displayName?: string; image?: string } | null;
  moderationInfo?: {
    isPendingScan: boolean;
    isMalwareBlocked: boolean;
    isSuspicious: boolean;
    isHiddenByMod: boolean;
    isRemoved: boolean;
    verdict?: "clean" | "suspicious" | "malicious";
    reasonCodes?: string[];
    summary?: string;
    engineVersion?: string;
    updatedAt?: number;
    sourceVersionId?: Id<"skillVersions"> | null;
    reason?: string;
  } | null;
  ambiguous?: boolean;
  ambiguousMatches?: Array<{ slug: string; ownerHandle?: string | null }>;
} | null;

type ResolveVersionResult = {
  match: { version: string } | null;
  latestVersion: { version: string } | null;
  ambiguous?: boolean;
  ambiguousMatches?: Array<{ slug: string; ownerHandle?: string | null }>;
} | null;
type SkillUrlOwner = { _id: string; handle?: string | null } | null;

type ListVersionsResult = {
  items: PublicSkillVersionResponse[];
  nextCursor: string | null;
};

function sanitizeEvidence(
  evidence: ModerationEvidence[],
  allowSensitiveEvidence: boolean,
): ModerationEvidence[] {
  if (allowSensitiveEvidence) return evidence;
  return evidence.map((entry) => ({
    code: entry.code,
    severity: entry.severity,
    file: entry.file,
    line: entry.line,
    message: entry.message,
    evidence: "",
  }));
}

function normalizeModerationFromSkill(skill: SkillModerationShape) {
  const flags = Array.isArray(skill.moderationFlags) ? skill.moderationFlags : [];
  const verdict =
    skill.moderationVerdict ??
    (flags.includes("blocked.malware")
      ? "malicious"
      : flags.includes("flagged.suspicious")
        ? "suspicious"
        : "clean");
  const isMalwareBlocked = verdict === "malicious" || flags.includes("blocked.malware");
  const isSuspicious =
    !isMalwareBlocked && (verdict === "suspicious" || flags.includes("flagged.suspicious"));

  return {
    isMalwareBlocked,
    isSuspicious,
    verdict,
    reasonCodes: Array.isArray(skill.moderationReasonCodes) ? skill.moderationReasonCodes : [],
    summary: skill.moderationSummary ?? null,
    engineVersion: skill.moderationEngineVersion ?? null,
    updatedAt: skill.moderationEvaluatedAt ?? skill.updatedAt ?? null,
    reason: skill.moderationReason ?? null,
    evidence: Array.isArray(skill.moderationEvidence) ? skill.moderationEvidence : [],
  };
}

type NormalizedSecurityStatus = "clean" | "suspicious" | "malicious" | "pending" | "error";

type SkillSecuritySnapshot = {
  status: NormalizedSecurityStatus;
  hasWarnings: boolean;
  checkedAt: number | null;
  model: string | null;
  hasScanResult: boolean;
  sha256hash: string | null;
  virustotalUrl: string | null;
  scanners: {
    vt: {
      status: string;
      verdict: string | null;
      normalizedStatus: NormalizedSecurityStatus;
      analysis: string | null;
      source: string | null;
      checkedAt: number | null;
    } | null;
    skillspector: {
      status: string;
      normalizedStatus: NormalizedSecurityStatus;
      score: number | null;
      severity: string | null;
      recommendation: string | null;
      issueCount: number;
      checkedAt: number | null;
    } | null;
    llm: {
      status: string;
      verdict: string | null;
      normalizedStatus: NormalizedSecurityStatus;
      confidence: string | null;
      summary: string | null;
      dimensions: LlmEvalDimension[] | null;
      guidance: string | null;
      findings: string | null;
      agenticRiskFindings: LlmAgenticRiskFinding[] | null;
      riskSummary: LlmRiskSummary | null;
      model: string | null;
      checkedAt: number | null;
    } | null;
  };
};

const internalRefs = internal as unknown as {
  githubSkillSources: {
    getByIdInternal: unknown;
  };
  securityScan: {
    createPublishedSkillScanRequestInternal: unknown;
    enqueueBulkSkillRescanBatchForAdminInternal: unknown;
    getStoredScanReportForUserInternal: unknown;
    getSkillScanRequestForUserInternal: unknown;
    getBulkSkillRescanBatchStatusForAdminInternal: unknown;
    requestSkillRescanForUserInternal: unknown;
  };
  vt: {
    repairPendingSkillVtAnalysis: unknown;
  };
  skills: {
    deleteOwnedVersionForUserInternal: unknown;
    setSkillTagForUserInternal: unknown;
    restoreOwnedVersionForUserInternal: unknown;
    revokeSkillVersionForUserInternal: unknown;
    getSecurityVerdictTargetInternal: unknown;
    getVerifyTargetBySlugInternal: unknown;
    getSkillBySlugInternal: unknown;
    getVersionByIdInternal: unknown;
    getVersionBySkillAndVersionInternal: unknown;
    hardDeleteForAdminInternal: unknown;
    reportSkillForUserInternal: unknown;
    listSkillReportsInternal: unknown;
    triageSkillReportForUserInternal: unknown;
    submitSkillAppealForUserInternal: unknown;
    listSkillAppealsInternal: unknown;
    resolveSkillAppealForUserInternal: unknown;
    setSkillFeaturedForUserInternal: unknown;
  };
};

async function runQueryRef<T>(ctx: ActionCtx, ref: unknown, args: unknown): Promise<T> {
  return (await ctx.runQuery(ref as never, args as never)) as T;
}

async function runMutationRef<T>(ctx: ActionCtx, ref: unknown, args: unknown): Promise<T> {
  return (await ctx.runMutation(ref as never, args as never)) as T;
}

async function runActionRef<T>(ctx: ActionCtx, ref: unknown, args: unknown): Promise<T> {
  return (await ctx.runAction(ref as never, args as never)) as T;
}

function isMultipartRequest(request: Request) {
  return (
    request.headers.get("content-type")?.toLowerCase().includes("multipart/form-data") === true
  );
}

function encodeJsonEntry(value: unknown) {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function encodeTextEntry(value: string) {
  return new TextEncoder().encode(value);
}

function scanReportPart(status: Record<string, unknown>, key: string) {
  const report = status.report;
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  return (report as Record<string, unknown>)[key] ?? null;
}

function buildSkillScanReportZip(status: Record<string, unknown>) {
  const manifest = {
    scanId: status.scanId,
    sourceKind: status.sourceKind,
    update: status.update,
    status: status.status,
    artifact: status.artifact ?? null,
    createdAt: status.createdAt,
    updatedAt: status.updatedAt,
    completedAt: status.completedAt ?? null,
    writtenBack: status.writtenBack === true,
  };
  const scanIdText = typeof status.scanId === "string" ? status.scanId : "";
  const statusText = typeof status.status === "string" ? status.status : "";
  const readme = [
    "# ClawHub Scan Report",
    "",
    `Scan ID: ${scanIdText}`,
    `Status: ${statusText}`,
    "",
    "This archive contains the stored security scan results for the submitted ClawHub version.",
    "",
    "## How to read this report",
    "",
    "Start with `clawscan.json`. ClawScan is the primary security verdict for the submitted artifact. Its `summary` field is the short explanation of what triggered the result, and `guidance` explains what to change before uploading a fixed version.",
    "",
    "- `malicious` means ClawHub blocked the submitted version from public install surfaces.",
    "- `suspicious` means ClawHub found behavior that needs review before users should rely on it.",
    "- `clean` means ClawHub did not find blocking security issues in this scan.",
    "",
    "VirusTotal results are supporting reputation telemetry. They can help explain a risk signal, but they are not the sole source of ClawHub's final verdict.",
    "",
    "## Files",
    "",
    "- `manifest.json`: artifact identity, scan status, timestamps, and writeback state.",
    "- `clawscan.json`: final ClawScan verdict, summary, guidance, and findings.",
    "- `skillspector.json`: SkillSpector structure and agentic-risk signals when available.",
    "- `static-analysis.json`: deterministic scanner findings, reason codes, and static summary.",
    "- `virustotal.json`: external reputation counts and status when available.",
    "- `README.md`: this interpretation guide.",
    "",
  ].join("\n");

  return buildDeterministicZip([
    { path: "manifest.json", bytes: encodeJsonEntry(manifest) },
    { path: "clawscan.json", bytes: encodeJsonEntry(scanReportPart(status, "clawscan")) },
    { path: "skillspector.json", bytes: encodeJsonEntry(scanReportPart(status, "skillspector")) },
    {
      path: "static-analysis.json",
      bytes: encodeJsonEntry(scanReportPart(status, "staticAnalysis")),
    },
    { path: "virustotal.json", bytes: encodeJsonEntry(scanReportPart(status, "virustotal")) },
    { path: "README.md", bytes: encodeTextEntry(readme) },
  ]);
}

function safeScanReportFilenamePart(value: string) {
  return (
    value
      .replace(/^@/, "")
      .replaceAll("/", "-")
      .replaceAll(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "artifact"
  );
}

async function handleSkillScanBatchSubmit(ctx: ActionCtx, request: Request, headers: HeadersInit) {
  const auth = await requireApiTokenUserOrResponse(ctx, request, headers);
  if (!auth.ok) return auth.response;
  const admin = requireAdminOrResponse(auth.user, headers);
  if (!admin.ok) return admin.response;
  try {
    const body = parseArk(
      ApiV1SkillScanBatchRequestSchema,
      await request.json(),
      "Skill scan batch payload",
    ) as {
      mode?: "all-active-latest";
      cursor?: string | null;
      batchSize?: number;
      dryRun?: boolean;
    };
    const result = await runMutationRef(
      ctx,
      internalRefs.securityScan.enqueueBulkSkillRescanBatchForAdminInternal,
      {
        actorUserId: auth.userId,
        ...(body.mode ? { mode: body.mode } : {}),
        cursor: body.cursor ?? null,
        ...(body.batchSize !== undefined ? { batchSize: body.batchSize } : {}),
        ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
      },
    );
    return json(result, 200, headers);
  } catch (error) {
    if (error instanceof SyntaxError) return text("Invalid JSON", 400, headers);
    return text(error instanceof Error ? error.message : "Skill scan batch failed", 400, headers);
  }
}

async function handleSkillScanBatchStatus(ctx: ActionCtx, request: Request, headers: HeadersInit) {
  const auth = await requireApiTokenUserOrResponse(ctx, request, headers);
  if (!auth.ok) return auth.response;
  const admin = requireAdminOrResponse(auth.user, headers);
  if (!admin.ok) return admin.response;
  try {
    const body = parseArk(
      ApiV1SkillScanBatchStatusRequestSchema,
      await request.json(),
      "Skill scan batch status payload",
    ) as { jobIds: string[] };
    const result = await runQueryRef(
      ctx,
      internalRefs.securityScan.getBulkSkillRescanBatchStatusForAdminInternal,
      {
        actorUserId: auth.userId,
        jobIds: body.jobIds,
      },
    );
    return json(result, 200, headers);
  } catch (error) {
    if (error instanceof SyntaxError) return text("Invalid JSON", 400, headers);
    return text(
      error instanceof Error ? error.message : "Skill scan batch status failed",
      400,
      headers,
    );
  }
}

function isDefinitiveSecurityStatus(
  status: NormalizedSecurityStatus | null | undefined,
): status is "clean" | "suspicious" | "malicious" {
  return status === "clean" || status === "suspicious" || status === "malicious";
}

const SECURITY_STATUS_PRIORITY: Record<NormalizedSecurityStatus, number> = {
  clean: 0,
  error: 1,
  pending: 2,
  suspicious: 3,
  malicious: 4,
};

function normalizeSecurityStatus(value: string | null | undefined): NormalizedSecurityStatus {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "benign":
    case "clean":
      return "clean";
    case "suspicious":
      return "suspicious";
    case "malicious":
      return "malicious";
    case "error":
    case "failed":
    case "completed":
      return "error";
    case "pending":
    case "loading":
    case "not_found":
    case "not-found":
    case "stale":
      return "pending";
    default:
      return "pending";
  }
}

function mergeSecurityStatuses(statuses: NormalizedSecurityStatus[]) {
  if (statuses.length === 0) return "pending" satisfies NormalizedSecurityStatus;
  return statuses.reduce((current, candidate) =>
    SECURITY_STATUS_PRIORITY[candidate] > SECURITY_STATUS_PRIORITY[current] ? candidate : current,
  );
}

function hasLlmDimensionWarnings(dimensions: LlmEvalDimension[] | undefined) {
  if (!Array.isArray(dimensions)) return false;
  return dimensions.some((dimension) => {
    if (!dimension || typeof dimension !== "object") return false;
    const rating = (dimension as { rating?: unknown }).rating;
    return typeof rating === "string" && rating !== "ok";
  });
}

function buildSkillSecuritySnapshot(
  version: Pick<
    PublicSkillVersionResponse,
    "sha256hash" | "vtAnalysis" | "skillSpectorAnalysis" | "llmAnalysis"
  >,
): SkillSecuritySnapshot | null {
  const sha256hash = version.sha256hash ?? null;
  const vt = version.vtAnalysis;
  const skillSpector = version.skillSpectorAnalysis;
  const llm = version.llmAnalysis;

  if (!sha256hash && !vt && !skillSpector && !llm) {
    return null;
  }

  const vtStatus = vt ? normalizeSecurityStatus(vt.verdict ?? vt.status) : null;
  const skillSpectorStatus = skillSpector ? normalizeSecurityStatus(skillSpector.status) : null;
  const llmStatus = llm ? normalizeSecurityStatus(llm.verdict ?? llm.status) : null;

  const statuses: NormalizedSecurityStatus[] = [];
  if (llmStatus) statuses.push(llmStatus);
  if (statuses.length === 0 && (sha256hash || skillSpector)) statuses.push("pending");
  const status = mergeSecurityStatuses(statuses);
  const hasScanResult = isDefinitiveSecurityStatus(llmStatus);
  const hasWarnings =
    status === "suspicious" || status === "malicious" || hasLlmDimensionWarnings(llm?.dimensions);

  const checkedAtCandidates = [vt?.checkedAt, skillSpector?.checkedAt, llm?.checkedAt].filter(
    (value): value is number => typeof value === "number",
  );
  const checkedAt = checkedAtCandidates.length > 0 ? Math.max(...checkedAtCandidates) : null;

  return {
    status,
    hasWarnings,
    checkedAt,
    model: llm?.model ?? null,
    hasScanResult,
    sha256hash,
    virustotalUrl: sha256hash ? `https://www.virustotal.com/gui/file/${sha256hash}` : null,
    scanners: {
      vt: vt
        ? {
            status: vt.status,
            verdict: vt.verdict ?? null,
            normalizedStatus: vtStatus ?? "pending",
            analysis: vt.analysis ?? null,
            source: vt.source ?? null,
            checkedAt: vt.checkedAt ?? null,
          }
        : null,
      skillspector: skillSpector
        ? {
            status: skillSpector.status,
            normalizedStatus: skillSpectorStatus ?? "pending",
            score: skillSpector.score ?? null,
            severity: skillSpector.severity ?? null,
            recommendation: skillSpector.recommendation ?? null,
            issueCount: skillSpector.issueCount ?? 0,
            checkedAt: skillSpector.checkedAt ?? null,
          }
        : null,
      llm: llm
        ? {
            status: llm.status,
            verdict: llm.verdict ?? null,
            normalizedStatus: llmStatus ?? "pending",
            confidence: llm.confidence ?? null,
            summary: llm.summary ?? null,
            dimensions: llm.dimensions ?? null,
            guidance: llm.guidance ?? null,
            findings: llm.findings ?? null,
            agenticRiskFindings: llm.agenticRiskFindings ?? null,
            riskSummary: llm.riskSummary ?? null,
            model: llm.model ?? null,
            checkedAt: llm.checkedAt ?? null,
          }
        : null,
    },
  };
}

type VerificationResolvedFrom = "latest" | "version" | "tag";

type SkillVersionFingerprintSummary = {
  fingerprint: string;
  kind?: "source" | "generated-bundle";
  createdAt: number;
};

type SecurityVerdictRequestItem = {
  slug: string;
  ownerHandle?: string;
  version: string;
};

type VerifySecurityVersion = {
  staticScan?: Pick<
    NonNullable<Doc<"skillVersions">["staticScan"]>,
    "status" | "reasonCodes" | "summary" | "engineVersion" | "checkedAt"
  >;
  llmAnalysis?: Pick<
    NonNullable<Doc<"skillVersions">["llmAnalysis"]>,
    "status" | "verdict" | "confidence" | "summary" | "guidance" | "model" | "checkedAt"
  >;
  vtAnalysis?: Pick<
    NonNullable<Doc<"skillVersions">["vtAnalysis"]>,
    "status" | "verdict" | "source" | "checkedAt"
  > &
    Partial<
      Pick<NonNullable<Doc<"skillVersions">["vtAnalysis"]>, "analysis" | "scanner" | "engineStats">
    >;
  skillSpectorAnalysis?: Pick<
    NonNullable<Doc<"skillVersions">["skillSpectorAnalysis"]>,
    | "status"
    | "score"
    | "severity"
    | "recommendation"
    | "issueCount"
    | "scannerVersion"
    | "checkedAt"
  > &
    Partial<Pick<NonNullable<Doc<"skillVersions">["skillSpectorAnalysis"]>, "summary" | "error">>;
};

type SecurityVerdictTargetResult = {
  skill: {
    _id: Id<"skills">;
    slug: string;
    displayName: string;
  } | null;
  owner: { _id: string; handle?: string | null; displayName?: string | null } | null;
  moderationInfo?: {
    isPendingScan: boolean;
    isMalwareBlocked: boolean;
    isSuspicious: boolean;
    isHiddenByMod: boolean;
    isRemoved: boolean;
    verdict?: "clean" | "suspicious" | "malicious";
    reasonCodes?: string[];
    summary?: string;
    engineVersion?: string;
    updatedAt?: number;
  } | null;
  version:
    | (VerifySecurityVersion &
        Pick<Doc<"skillVersions">, "_id" | "version" | "createdAt" | "softDeletedAt">)
    | null;
} | null;

function normalizeVerificationStatus(value: string | null | undefined): NormalizedSecurityStatus {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "pending";
  if (normalized === "clean" || normalized === "benign") return "clean";
  if (normalized === "suspicious" || normalized === "review") return "suspicious";
  if (normalized === "malicious") return "malicious";
  if (normalized === "error" || normalized === "failed") return "error";
  if (normalized === "completed") return "pending";
  return normalizeSecurityStatus(normalized);
}

function buildVerifySecurity(version: VerifySecurityVersion) {
  const staticStatus = normalizeVerificationStatus(version.staticScan?.status);
  const clawRawStatus = version.llmAnalysis?.status ?? null;
  const clawStatus = normalizeVerificationStatus(version.llmAnalysis?.verdict ?? clawRawStatus);
  const vtStatus = version.vtAnalysis
    ? normalizeVerificationStatus(version.vtAnalysis.verdict ?? version.vtAnalysis.status)
    : null;
  const skillSpectorStatus = version.skillSpectorAnalysis
    ? normalizeVerificationStatus(version.skillSpectorAnalysis.status)
    : null;
  const status = clawStatus;

  return {
    status,
    passed: status === "clean",
    rawStatus: clawRawStatus,
    verdict: version.llmAnalysis?.verdict ?? null,
    confidence: version.llmAnalysis?.confidence ?? null,
    summary: version.llmAnalysis?.summary ?? null,
    model: version.llmAnalysis?.model ?? null,
    checkedAt: version.llmAnalysis?.checkedAt ?? null,
    signals: {
      staticScan: version.staticScan
        ? {
            status: staticStatus,
            rawStatus: version.staticScan.status,
            reasonCodes: version.staticScan.reasonCodes ?? [],
            summary: version.staticScan.summary ?? null,
            engineVersion: version.staticScan.engineVersion ?? null,
            checkedAt: version.staticScan.checkedAt ?? null,
          }
        : {
            status: "pending" as const,
            rawStatus: null,
            reasonCodes: [],
            summary: null,
            engineVersion: null,
            checkedAt: null,
          },
      virusTotal: version.vtAnalysis
        ? {
            status: vtStatus ?? "pending",
            rawStatus: version.vtAnalysis.status,
            verdict: version.vtAnalysis.verdict ?? null,
            analysis: version.vtAnalysis.analysis ?? null,
            source: version.vtAnalysis.source ?? null,
            scanner: version.vtAnalysis.scanner ?? null,
            engineStats: version.vtAnalysis.engineStats ?? null,
            checkedAt: version.vtAnalysis.checkedAt ?? null,
          }
        : null,
      skillSpector: version.skillSpectorAnalysis
        ? {
            status: skillSpectorStatus ?? "pending",
            rawStatus: version.skillSpectorAnalysis.status,
            score: version.skillSpectorAnalysis.score ?? null,
            severity: version.skillSpectorAnalysis.severity ?? null,
            recommendation: version.skillSpectorAnalysis.recommendation ?? null,
            issueCount: version.skillSpectorAnalysis.issueCount ?? 0,
            scannerVersion: version.skillSpectorAnalysis.scannerVersion ?? null,
            summary: version.skillSpectorAnalysis.summary ?? null,
            error: version.skillSpectorAnalysis.error ?? null,
            checkedAt: version.skillSpectorAnalysis.checkedAt ?? null,
          }
        : null,
      dependencyRegistry: null,
    },
  };
}

function sourceFilesForVerify(
  files: Doc<"skillVersions">["files"],
  generatedBundleFingerprints: readonly string[],
) {
  return sourceSkillVersionFiles(files, { generatedBundleFingerprints }).map((file) => ({
    path: file.path,
    size: file.size,
    sha256: file.sha256,
    contentType: normalizeContentType(file.contentType) ?? null,
  }));
}

function buildCardUrl(
  request: Request,
  slug: string,
  version: string,
  ownerHandle?: string | null,
) {
  const cardUrl = new URL(
    `/api/v1/skills/${encodeURIComponent(slug)}/card`,
    new URL(request.url).origin,
  );
  if (ownerHandle) cardUrl.searchParams.set("ownerHandle", ownerHandle);
  cardUrl.searchParams.set("version", version);
  return cardUrl.toString();
}

function buildVerifyReasons(args: {
  cardAvailable: boolean;
  isMalwareBlocked: boolean;
  securityPassed: boolean;
  securityStatus: NormalizedSecurityStatus;
}) {
  const reasons: string[] = [];
  if (!args.cardAvailable && !args.isMalwareBlocked) reasons.push("card.missing");
  reasons.push(
    ...buildSecurityVerdictReasons({
      isMalwareBlocked: args.isMalwareBlocked,
      securityPassed: args.securityPassed,
      securityStatus: args.securityStatus,
    }),
  );
  return [...new Set(reasons)];
}

function buildSecurityVerdictReasons(args: {
  isMalwareBlocked: boolean;
  securityPassed: boolean;
  securityStatus: NormalizedSecurityStatus;
}) {
  const reasons: string[] = [];
  if (args.isMalwareBlocked) reasons.push("moderation.malware_blocked");
  if (!args.securityPassed) reasons.push("security.status_not_clean");
  if (args.securityStatus === "pending") reasons.push("security.pending");
  if (args.securityStatus === "error") reasons.push("security.error");
  return [...new Set(reasons)];
}

function getVerifySecurityCheckedAt(security: ReturnType<typeof buildVerifySecurity>) {
  const candidates = [
    security.checkedAt,
    security.signals.staticScan?.checkedAt,
    security.signals.virusTotal?.checkedAt,
    security.signals.skillSpector?.checkedAt,
  ].filter((value): value is number => typeof value === "number");
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function buildSecurityVerdictSummary(security: ReturnType<typeof buildVerifySecurity>) {
  return {
    status: security.status,
    passed: security.passed,
    rawStatus: security.rawStatus,
    verdict: security.verdict,
    confidence: security.confidence,
    summary: security.summary,
    model: security.model,
    checkedAt: security.checkedAt,
    signals: {
      staticScan: security.signals.staticScan
        ? {
            status: security.signals.staticScan.status,
            rawStatus: security.signals.staticScan.rawStatus,
            reasonCodes: security.signals.staticScan.reasonCodes,
            summary: security.signals.staticScan.summary,
            engineVersion: security.signals.staticScan.engineVersion,
            checkedAt: security.signals.staticScan.checkedAt,
          }
        : null,
      virusTotal: security.signals.virusTotal
        ? {
            status: security.signals.virusTotal.status,
            rawStatus: security.signals.virusTotal.rawStatus,
            verdict: security.signals.virusTotal.verdict,
            source: security.signals.virusTotal.source,
            checkedAt: security.signals.virusTotal.checkedAt,
          }
        : null,
      skillSpector: security.signals.skillSpector
        ? {
            status: security.signals.skillSpector.status,
            rawStatus: security.signals.skillSpector.rawStatus,
            score: security.signals.skillSpector.score,
            severity: security.signals.skillSpector.severity,
            recommendation: security.signals.skillSpector.recommendation,
            issueCount: security.signals.skillSpector.issueCount,
            scannerVersion: security.signals.skillSpector.scannerVersion,
            checkedAt: security.signals.skillSpector.checkedAt,
          }
        : null,
      dependencyRegistry: null,
    },
  };
}

function isValidRequestedVersion(version: string) {
  return version.length > 0 && version.length <= 128 && !/[\s/\\]/.test(version);
}

function parseSecurityVerdictItems(
  payload: unknown,
): { ok: true; items: SecurityVerdictRequestItem[] } | { ok: false; message: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, message: "JSON body must be an object" };
  }

  const items = (payload as Record<string, unknown>).items;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_SECURITY_VERDICT_ITEMS) {
    return { ok: false, message: `items must contain 1 to ${MAX_SECURITY_VERDICT_ITEMS} entries` };
  }

  const parsed: SecurityVerdictRequestItem[] = [];
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object") {
      return { ok: false, message: `Invalid item at items[${index}]` };
    }
    const raw = item as Record<string, unknown>;
    if (typeof raw.slug !== "string" || typeof raw.version !== "string") {
      return { ok: false, message: `items[${index}] requires slug and version strings` };
    }
    const rawOwnerHandle = raw.ownerHandle;
    if (rawOwnerHandle !== undefined && typeof rawOwnerHandle !== "string") {
      return { ok: false, message: `Invalid ownerHandle at items[${index}]` };
    }
    if ("tag" in raw) {
      return { ok: false, message: `items[${index}] uses version only; tag is not supported` };
    }
    const slug = raw.slug.trim().toLowerCase();
    const ownerHandle = normalizePublisherHandle(rawOwnerHandle);
    const version = raw.version.trim();
    if (!validateSlug(slug)) {
      return { ok: false, message: `Invalid slug at items[${index}]` };
    }
    if (!isValidRequestedVersion(version)) {
      return { ok: false, message: `Invalid version at items[${index}]` };
    }
    const key = `${ownerHandle ? `@${ownerHandle}/` : ""}${slug}@${version}`;
    if (seen.has(key)) return { ok: false, message: `Duplicate item: ${key}` };
    seen.add(key);
    parsed.push({ slug, ...(ownerHandle ? { ownerHandle } : {}), version });
  }

  return { ok: true, items: parsed };
}

function buildSkillPageUrl(request: Request, owner: SkillUrlOwner, slug: string) {
  const origin = publicApiOrigin(request);
  const ownerSegment = owner?.handle ?? owner?._id ?? null;
  if (!ownerSegment) {
    return new URL(`/api/v1/skills/${encodeURIComponent(slug)}`, origin).toString();
  }
  return new URL(
    `/${encodeURIComponent(ownerSegment)}/skills/${encodeURIComponent(slug)}`,
    origin,
  ).toString();
}

function buildSecurityAuditUrl(
  request: Request,
  owner: SkillUrlOwner,
  slug: string,
  version: string,
) {
  const ownerSegment = owner?.handle ?? owner?._id ?? null;
  if (!ownerSegment) return null;

  const url = new URL(
    `/${encodeURIComponent(ownerSegment)}/skills/${encodeURIComponent(slug)}/security-audit`,
    publicApiOrigin(request),
  );
  url.searchParams.set("version", version);
  return url.toString();
}

function addSetupEntry(
  entries: SkillSetupEntry[],
  seen: Set<string>,
  key: string,
  options: { required?: boolean } = {},
) {
  const normalizedKey = key.trim();
  if (!normalizedKey) return;
  if (seen.has(normalizedKey)) return;
  seen.add(normalizedKey);
  entries.push({
    key: normalizedKey,
    required: options.required ?? true,
  });
}

function buildSkillSetup(parsed: PublicSkillVersionParsed | undefined): SkillSetupEntry[] {
  const clawdis = parsed?.clawdis;
  if (!clawdis) return [];

  const entries: SkillSetupEntry[] = [];
  const seen = new Set<string>();

  for (const key of clawdis.requires?.env ?? []) {
    addSetupEntry(entries, seen, key, { required: true });
  }
  for (const key of clawdis.requires?.config ?? []) {
    addSetupEntry(entries, seen, key, { required: true });
  }
  for (const entry of clawdis.envVars ?? []) {
    addSetupEntry(entries, seen, entry.name, { required: entry.required ?? true });
  }

  return entries;
}

function selectSkillReadmeFile(version: Doc<"skillVersions"> | null | undefined) {
  return version?.files.find((file) => {
    const path = file.path.trim().toLowerCase();
    return path === "skill.md" || path === "skills.md";
  });
}

async function readSkillDescriptionMarkdown(
  ctx: ActionCtx,
  skillId: Id<"skills">,
  versionId: Id<"skillVersions"> | undefined,
) {
  if (versionId) {
    const version = (await ctx.runQuery(internal.skills.getVersionByIdInternal, {
      versionId,
    })) as Doc<"skillVersions"> | null;
    if (version && isSkillVersionForSkill(version, skillId) && !version.softDeletedAt) {
      const file = selectSkillReadmeFile(version);
      if (file && file.size <= MAX_RAW_FILE_BYTES) {
        const blob = await ctx.storage.get(file.storageId);
        if (blob) return await blob.text();
      }
    }
  }

  const githubContent = (await ctx.runQuery(api.skills.getGitHubSkillContent, {
    skillId,
    kind: "readme",
  })) as { text?: string } | null;
  return githubContent?.text ?? null;
}

function buildSecurityVerdictError(
  item: SecurityVerdictRequestItem,
  code: string,
  message: string,
  reason: string,
) {
  return {
    ok: false,
    decision: "fail",
    reasons: [reason],
    requestedSlug: item.slug,
    ...(item.ownerHandle ? { requestedOwnerHandle: item.ownerHandle } : {}),
    slug: item.slug,
    requestedVersion: item.version,
    version: null,
    displayName: null,
    publisherHandle: null,
    publisherDisplayName: null,
    createdAt: null,
    checkedAt: null,
    skillUrl: null,
    securityAuditUrl: null,
    security: null,
    error: { code, message },
  };
}

async function buildSecurityVerdictItem(
  ctx: ActionCtx,
  request: Request,
  item: SecurityVerdictRequestItem,
) {
  const result = await runQueryRef<SecurityVerdictTargetResult>(
    ctx,
    internalRefs.skills.getSecurityVerdictTargetInternal,
    {
      slug: item.slug,
      ...(item.ownerHandle ? { ownerHandle: item.ownerHandle } : {}),
      version: item.version,
    },
  );
  if (!result?.skill) {
    return buildSecurityVerdictError(item, "skill_not_found", "Skill not found", "skill.not_found");
  }

  const version = result.version;
  if (!version) {
    return buildSecurityVerdictError(
      item,
      "version_not_found",
      "Version not found",
      "version.not_found",
    );
  }
  if (version.softDeletedAt) {
    return buildSecurityVerdictError(
      item,
      "version_unavailable",
      "Version not available",
      "version.unavailable",
    );
  }

  const security = buildVerifySecurity(version);
  const reasons = buildSecurityVerdictReasons({
    isMalwareBlocked: result.moderationInfo?.isMalwareBlocked ?? false,
    securityPassed: security.passed,
    securityStatus: security.status,
  });

  return {
    ok: reasons.length === 0,
    decision: reasons.length === 0 ? "pass" : "fail",
    reasons,
    requestedSlug: item.slug,
    ...(item.ownerHandle ? { requestedOwnerHandle: item.ownerHandle } : {}),
    slug: result.skill.slug,
    displayName: result.skill.displayName,
    publisherHandle: result.owner?.handle ?? null,
    publisherDisplayName: result.owner?.displayName ?? null,
    requestedVersion: item.version,
    version: version.version,
    createdAt: version.createdAt,
    checkedAt: getVerifySecurityCheckedAt(security),
    skillUrl: buildSkillPageUrl(request, result.owner, result.skill.slug),
    securityAuditUrl: buildSecurityAuditUrl(
      request,
      result.owner,
      result.skill.slug,
      version.version,
    ),
    overview: formatSecurityAuditOverview({ llmAnalysis: version.llmAnalysis }),
    security: buildSecurityVerdictSummary(security),
  };
}

export async function skillSecurityVerdictsV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, "read");
  if (!rate.ok) return rate.response;

  const parsed = await parseJsonPayload(request, rate.headers);
  if (!parsed.ok) return parsed.response;

  const requestItems = parseSecurityVerdictItems(parsed.payload);
  if (!requestItems.ok) return text(requestItems.message, 400, rate.headers);

  const items = await chunkedParallel(requestItems.items, 20, (item) =>
    buildSecurityVerdictItem(ctx, request, item),
  );
  return json({ schema: "clawhub.skill.security-verdicts.v1", items }, 200, rate.headers);
}

export async function skillScanSubmitV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, "write");
  if (!rate.ok) return rate.response;
  const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
  if (!auth.ok) return auth.response;

  try {
    if (isMultipartRequest(request)) {
      return text(
        "Local upload scans are no longer supported. Upload a version, then use `clawhub scan download <slug> --version <version>` to retrieve stored scan results.",
        410,
        rate.headers,
      );
    }

    const body = parseArk(
      ApiV1SkillScanSubmitRequestSchema,
      await request.json(),
      "Skill scan payload",
    ) as {
      source:
        | { kind: "upload" }
        | { kind: "published"; slug: string; ownerHandle?: string; version?: string };
      update?: boolean;
    };
    if (body.source.kind === "upload") {
      return text(
        "Local upload scans are no longer supported. Upload a version, then use `clawhub scan download <slug> --version <version>` to retrieve stored scan results.",
        410,
        rate.headers,
      );
    }
    const result = await runMutationRef(
      ctx,
      internalRefs.securityScan.createPublishedSkillScanRequestInternal,
      {
        actorUserId: auth.userId,
        slug: body.source.slug,
        ...(body.source.ownerHandle ? { ownerHandle: body.source.ownerHandle } : {}),
        ...(body.source.version ? { version: body.source.version } : {}),
        update: body.update === true,
      },
    );
    return json(result, 202, rate.headers);
  } catch (error) {
    if (error instanceof SyntaxError) return text("Invalid JSON", 400, rate.headers);
    return text(
      error instanceof Error ? error.message : "Skill scan submit failed",
      400,
      rate.headers,
    );
  }
}

export async function skillScanGetRouterV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, "read");
  if (!rate.ok) return rate.response;
  const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
  if (!auth.ok) return auth.response;

  const segments = getPathSegments(request, `${ApiRoutes.skillScans}/`);
  const scanId = segments[0];
  if (!scanId) return text("scanId required", 400, rate.headers);

  try {
    if (segments.length === 2 && scanId === "download") {
      const name = (segments[1] ?? "").trim();
      const url = new URL(request.url);
      const version = url.searchParams.get("version")?.trim() ?? "";
      const kind = url.searchParams.get("kind")?.trim() === "plugin" ? "plugin" : "skill";
      const ownerHandle = url.searchParams.get("ownerHandle")?.trim() || undefined;
      if (!name) return text("name required", 400, rate.headers);
      if (!version) return text("version required", 400, rate.headers);

      const status = (await runQueryRef(
        ctx,
        internalRefs.securityScan.getStoredScanReportForUserInternal,
        {
          actorUserId: auth.userId,
          kind,
          name,
          ...(ownerHandle ? { ownerHandle } : {}),
          version,
        },
      )) as Record<string, unknown>;
      const zip = buildSkillScanReportZip(status);
      const headers = mergeHeaders(rate.headers, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="clawhub-scan-${safeScanReportFilenamePart(name)}-${safeScanReportFilenamePart(version)}.zip"`,
      });
      return new Response(zip, { status: 200, headers });
    }

    const status = (await runQueryRef(
      ctx,
      internalRefs.securityScan.getSkillScanRequestForUserInternal,
      {
        actorUserId: auth.userId,
        scanId: scanId as Id<"skillScanRequests">,
      },
    )) as Record<string, unknown>;

    if (segments.length === 1) return json(status, 200, rate.headers);

    if (segments.length === 2 && segments[1] === "download") {
      if (status.status !== "succeeded") return text("Scan is not complete", 409, rate.headers);
      const zip = buildSkillScanReportZip(status);
      const headers = mergeHeaders(rate.headers, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="clawhub-scan-${scanId}.zip"`,
      });
      return new Response(zip, { status: 200, headers });
    }

    return text("Not found", 404, rate.headers);
  } catch (error) {
    return text(error instanceof Error ? error.message : "Skill scan failed", 400, rate.headers);
  }
}

export async function skillScanBatchSubmitV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, "write");
  if (!rate.ok) return rate.response;
  return handleSkillScanBatchSubmit(ctx, request, rate.headers);
}

export async function skillScanBatchStatusV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, "write");
  if (!rate.ok) return rate.response;
  return handleSkillScanBatchStatus(ctx, request, rate.headers);
}

export async function searchSkillsV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, "read");
  if (!rate.ok) return rate.response;

  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const limit = toOptionalNumber(url.searchParams.get("limit"));
  const rawMode = url.searchParams.get("mode")?.trim().toLowerCase();
  const highlightedOnly = parseBooleanQueryParam(url.searchParams.get("highlightedOnly"));
  const nonSuspiciousOnly = resolveBooleanQueryParam(
    url.searchParams.get("nonSuspiciousOnly"),
    url.searchParams.get("nonSuspicious"),
  );

  if (rawMode && rawMode !== "exact") {
    return text("Invalid search mode", 400, rate.headers);
  }
  if (!query) return json({ results: [] }, 200, rate.headers);

  const results = (await ctx.runAction(api.search.searchSkills, {
    query,
    limit,
    ...(rawMode ? { mode: "exact" as const } : {}),
    highlightedOnly: highlightedOnly || undefined,
    nonSuspiciousOnly: nonSuspiciousOnly || undefined,
  })) as unknown[];

  // The action owns the canonical shape and ordering for every consumer.
  // This HTTP surface must serialize it without projecting or re-sorting.
  return json({ results: serializeCanonicalSkillSearchResults(results) }, 200, rate.headers);
}

export async function resolveSkillVersionV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, "read");
  if (!rate.ok) return rate.response;

  const url = new URL(request.url);
  const slug = url.searchParams.get("slug")?.trim().toLowerCase();
  const ownerHandle = getOwnerHandleParam(url);
  const hash = url.searchParams.get("hash")?.trim().toLowerCase();
  if (!slug || !hash) return text("Missing slug or hash", 400, rate.headers);
  if (!/^[a-f0-9]{64}$/.test(hash)) return text("Invalid hash", 400, rate.headers);

  const resolved = (await ctx.runQuery(api.skills.resolveVersionByHash, {
    slug,
    hash,
    ...(ownerHandle ? { ownerHandle } : {}),
  })) as ResolveVersionResult;
  if (!resolved) return text("Skill not found", 404, rate.headers);
  if (resolved.ambiguous) {
    return ambiguousSkillSlugResponse(
      slug,
      `/api/v1/resolve?slug=${encodeURIComponent(slug)}&ownerHandle=<owner>&hash=${hash}`,
      rate.headers,
    );
  }

  return json(
    { slug, match: resolved.match, latestVersion: resolved.latestVersion },
    200,
    rate.headers,
  );
}

type SkillListSort =
  | "recommended"
  | "createdAt"
  | "updated"
  | "downloads"
  | "stars"
  | "name"
  | "trending";

type PublicListSort = "recommended" | "newest" | "updated" | "downloads" | "stars" | "name";

function parseListSort(value: string | null): SkillListSort | null {
  if (value === null) return "updated";
  const normalized = value.trim().toLowerCase();
  if (normalized === "default" || normalized === "recommended") {
    return "recommended";
  }
  if (normalized === "createdat" || normalized === "created-at" || normalized === "newest") {
    return "createdAt";
  }
  if (normalized === "downloads") return "downloads";
  if (normalized === "stars" || normalized === "rating") return "stars";
  if (normalized === "name") return "name";
  if (
    normalized === "installs" ||
    normalized === "install" ||
    normalized === "installscurrent" ||
    normalized === "installs-current" ||
    normalized === "current" ||
    normalized === "installsalltime" ||
    normalized === "installs-all-time"
  ) {
    return "downloads";
  }
  if (normalized === "trending") return "trending";
  if (normalized === "updated") return "updated";
  return null;
}

function toPublicListSort(sort: Exclude<SkillListSort, "trending">): PublicListSort {
  switch (sort) {
    case "recommended":
      return "recommended";
    case "createdAt":
      return "newest";
    case "updated":
      return "updated";
    case "downloads":
      return "downloads";
    case "stars":
      return "stars";
    case "name":
      return "name";
  }
  throw new Error("Unhandled skill list sort");
}

export async function listSkillsV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, "read");
  if (!rate.ok) return rate.response;

  const url = new URL(request.url);
  const limit = toOptionalNumber(url.searchParams.get("limit"));
  const rawCursor = url.searchParams.get("cursor")?.trim() || undefined;
  const rawPrefix = url.searchParams.get("prefix");
  const prefix = rawPrefix === null ? undefined : normalizeSkillSlug(rawPrefix);
  if (
    rawPrefix !== null &&
    (!prefix || prefix.length > 96 || !/^[a-z0-9][a-z0-9-]*$/.test(prefix))
  ) {
    return text("Invalid prefix query parameter", 400, rate.headers);
  }
  const requestedSort = parseListSort(url.searchParams.get("sort"));
  const sort = prefix && url.searchParams.get("sort") === null ? "name" : requestedSort;
  if (!sort) return text("Invalid sort query parameter", 400, rate.headers);
  if (prefix && sort !== "name") {
    return text("Prefix listing only supports name sort", 400, rate.headers);
  }
  const cursor = sort === "trending" ? undefined : rawCursor;
  const nonSuspiciousOnly = resolveBooleanQueryParam(
    url.searchParams.get("nonSuspiciousOnly"),
    url.searchParams.get("nonSuspicious"),
  );

  let result: ListSkillsResult;
  if (sort === "trending") {
    result = (await ctx.runQuery(api.skills.listPublicTrendingPage, {
      limit,
      nonSuspiciousOnly: nonSuspiciousOnly || undefined,
    })) as ListSkillsResult;
  } else {
    const pageResult = (await ctx.runQuery(api.skills.listPublicApiPageV1, {
      cursor,
      numItems: limit,
      sort: toPublicListSort(sort),
      ...(prefix ? { dir: "asc" as const, prefix } : {}),
      nonSuspiciousOnly: nonSuspiciousOnly || undefined,
    })) as {
      items?: ListSkillsResult["items"];
      page?: ListSkillsResult["items"];
      nextCursor?: string | null;
    };
    result = {
      items: pageResult.items ?? pageResult.page ?? [],
      nextCursor: pageResult.nextCursor ?? null,
    };
  }

  // Batch resolve all tags in a single query instead of N queries
  const resolvedTagsList = await resolveTagsBatch(
    ctx,
    result.items.map((item) => item.skill.tags),
    result.items.map((item) => item.latestVersion),
    result.items.map((item) => item.skill._id),
  );

  const items = result.items.map((item, idx) => ({
    slug: item.skill.slug,
    displayName: item.skill.displayName,
    summary: item.skill.summary ?? null,
    description: item.latestVersion?.parsed?.description ?? null,
    topics: item.skill.topics,
    tags: resolvedTagsList[idx],
    stats: item.skill.stats,
    createdAt: item.skill.createdAt,
    updatedAt: item.skill.updatedAt,
    latestVersion: item.latestVersion
      ? {
          version: item.latestVersion.version,
          createdAt: item.latestVersion.createdAt,
          changelog: item.latestVersion.changelog,
          license: item.latestVersion.parsed?.license ?? null,
        }
      : null,
    metadata: item.latestVersion?.parsed?.clawdis
      ? {
          setup: buildSkillSetup(item.latestVersion.parsed),
          os: item.latestVersion.parsed.clawdis.os ?? null,
          systems: item.latestVersion.parsed.clawdis.nix?.systems ?? null,
        }
      : null,
  }));

  const responseHeaders =
    sort === "trending" && getRuntimeRolloutCapabilities().skillsSh.runtimeEnabled
      ? mergeHeaders(rate.headers, {
          Deprecation: "true",
          Link: `<${ApiRoutes.trending}?kind=skills>; rel="successor-version"`,
        })
      : rate.headers;
  return json({ items, nextCursor: result.nextCursor ?? null }, 200, responseHeaders);
}

async function describeOwnerVisibleSkillState(
  ctx: ActionCtx,
  request: Request,
  slug: string,
  ownerHandle?: string,
): Promise<{ status: number; message: string } | null> {
  const skill = await ctx.runQuery(internal.skills.getSkillBySlugInternal, {
    slug,
    ...(ownerHandle ? { ownerHandle } : {}),
  });
  if (!skill) return null;

  const apiTokenUserId = await getOptionalApiTokenUserId(ctx, request);
  const isOwner = Boolean(apiTokenUserId && apiTokenUserId === skill.ownerUserId);
  if (!isOwner) return null;

  if (skill.softDeletedAt) {
    return {
      status: 410,
      message: `Skill is hidden/deleted. Run "clawhub undelete ${slug}" to restore it.`,
    };
  }

  if (skill.moderationStatus === "hidden") {
    if (
      skill.moderationReason === "pending.scan" ||
      skill.moderationReason === "scanner.vt.pending"
    ) {
      return {
        status: 423,
        message: "Skill is hidden while security scan is pending. Try again in a few minutes.",
      };
    }
    if (skill.moderationReason === "quality.low") {
      return {
        status: 403,
        message:
          'Skill is hidden by quality checks. Update SKILL.md content or run "clawhub undelete <slug>" after review.',
      };
    }
    return {
      status: 403,
      message: `Skill is hidden by moderation${
        skill.moderationReason ? ` (${skill.moderationReason})` : ""
      }.`,
    };
  }

  if (skill.moderationStatus === "removed") {
    return { status: 410, message: "Skill has been removed by moderation." };
  }

  return null;
}

function getOwnerHandleParam(url: URL) {
  const value = url.searchParams.get("ownerHandle") ?? url.searchParams.get("owner");
  return value?.trim().replace(/^@+/, "") || undefined;
}

function skillOwnerHandleExample(slug: string, suffix = "") {
  const encodedSlug = encodeURIComponent(slug);
  const queryIndex = suffix.indexOf("?");
  if (queryIndex >= 0) {
    const path = suffix.slice(0, queryIndex);
    const query = suffix.slice(queryIndex + 1);
    return `/api/v1/skills/${encodedSlug}${path}?ownerHandle=<owner>&${query}`;
  }
  return `/api/v1/skills/${encodedSlug}${suffix}?ownerHandle=<owner>`;
}

function ambiguousSkillChoicesForRequest(
  request: Request,
  matches: Array<{ slug: string; ownerHandle?: string | null }> | undefined,
): AmbiguousSkillSlugChoice[] {
  const origin = publicApiOrigin(request);
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
          origin,
        ).toString(),
      },
    ];
  });
}

function skillNotFoundOrAmbiguousResponse(
  request: Request,
  result:
    | {
        ambiguous?: boolean;
        ambiguousMatches?: Array<{ slug: string; ownerHandle?: string | null }>;
      }
    | null
    | undefined,
  slug: string,
  examplePath: string,
  headers?: HeadersInit,
) {
  return result?.ambiguous
    ? ambiguousSkillSlugResponse(
        slug,
        examplePath,
        headers,
        ambiguousSkillChoicesForRequest(request, result.ambiguousMatches),
      )
    : text("Skill not found", 404, headers);
}

function shouldExposeHiddenGitHubInstallBlock(
  skill: InstallResolverSkill & {
    installKind?: "github";
    moderationStatus?: "active" | "hidden" | "removed";
    moderationReason?: string;
  },
  resolution: SkillInstallResolution,
) {
  if (skill.installKind !== "github" || resolution.ok) return false;
  if (skill.moderationStatus !== "hidden") return false;
  const reason = skill.moderationReason ?? "";
  return (
    reason === "pending.scan" ||
    reason === "scanner.failed" ||
    reason === "scanner.llm.malicious" ||
    reason.startsWith("github.")
  );
}

type ExactVersionModeratedSkill = Pick<
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

async function getUnavailableSkillVersionBlock(
  ctx: ActionCtx,
  slug: string,
  ownerHandle?: string,
  selector?: { versionName?: string; tagName?: string },
) {
  const skill = await runQueryRef<ExactVersionModeratedSkill | null>(
    ctx,
    internalRefs.skills.getSkillBySlugInternal,
    { slug, ...(ownerHandle ? { ownerHandle } : {}) },
  );
  if (!skill || skill.softDeletedAt) return null;

  const latestVersionId = skill.latestVersionId ?? skill.tags?.latest;
  const selectedVersionId = selector?.tagName ? skill.tags?.[selector.tagName] : latestVersionId;
  if (!selector?.versionName && !selectedVersionId) return null;

  const version = selector?.versionName
    ? await runQueryRef<PublicSkillVersionResponse | null>(
        ctx,
        internalRefs.skills.getVersionBySkillAndVersionInternal,
        {
          skillId: skill._id,
          version: selector.versionName,
        },
      )
    : await runQueryRef<PublicSkillVersionResponse | null>(
        ctx,
        internalRefs.skills.getVersionByIdInternal,
        {
          versionId: selectedVersionId,
        },
      );
  if (!version || !isSkillVersionForSkill(version, skill._id)) return null;
  if (version.softDeletedAt) return { status: 410, message: "Version not available" };

  return getPublicSkillVersionAccessBlock(
    getSkillFileModerationInfoFromSkill(skill),
    version._id,
    skill.latestVersionId ?? skill.tags?.latest,
  );
}

export async function skillsGetRouterV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, "read");
  if (!rate.ok) return rate.response;

  const segments = getPathSegments(request, "/api/v1/skills/");
  if (segments.length === 0) return text("Missing slug", 400, rate.headers);
  const slug = segments[0]?.trim().toLowerCase() ?? "";
  const second = segments[1];
  const third = segments[2];
  const url = new URL(request.url);
  const ownerHandle = getOwnerHandleParam(url);
  const skillLookupArgs = { slug, ...(ownerHandle ? { ownerHandle } : {}) };

  if (segments.length === 1 && slug === "resolve") {
    const resolveUrl = new URL(request.url);
    if (resolveUrl.searchParams.has("slug") || resolveUrl.searchParams.has("hash")) {
      const resolveSlug = resolveUrl.searchParams.get("slug")?.trim().toLowerCase();
      const hash = resolveUrl.searchParams.get("hash")?.trim().toLowerCase();
      if (!resolveSlug || !hash) return text("Missing slug or hash", 400, rate.headers);
      if (!/^[a-f0-9]{64}$/.test(hash)) return text("Invalid hash", 400, rate.headers);
      const resolved = await ctx.runQuery(api.skills.resolveVersionByHash, {
        slug: resolveSlug,
        hash,
        ...(ownerHandle ? { ownerHandle } : {}),
      });
      if (!resolved) return text("Skill not found", 404, rate.headers);
      if (resolved.ambiguous) {
        return ambiguousSkillSlugResponse(
          resolveSlug,
          `/api/v1/skills/resolve?slug=${encodeURIComponent(resolveSlug)}&ownerHandle=<owner>&hash=${hash}`,
          rate.headers,
        );
      }
      return json(
        { slug: resolveSlug, match: resolved.match, latestVersion: resolved.latestVersion },
        200,
        rate.headers,
      );
    }
  }

  if (segments[0] === "-" && segments[1] === "reports" && segments.length === 2) {
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;
    const status = (url.searchParams.get("status")?.trim() || "open") as SkillReportListStatus;
    if (!["open", "confirmed", "dismissed", "all"].includes(status)) {
      return text("Invalid skill report status", 400, rate.headers);
    }
    const result = await runQueryRef(ctx, internalRefs.skills.listSkillReportsInternal, {
      actorUserId: auth.userId,
      status,
      cursor: url.searchParams.get("cursor")?.trim() || null,
      limit: toOptionalNumber(url.searchParams.get("limit")),
    });
    return json(result, 200, rate.headers);
  }

  if (segments[0] === "-" && segments[1] === "appeals" && segments.length === 2) {
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;
    const status = (url.searchParams.get("status")?.trim() || "open") as SkillAppealListStatus;
    if (!["open", "accepted", "rejected", "all"].includes(status)) {
      return text("Invalid skill appeal status", 400, rate.headers);
    }
    const result = await runQueryRef(ctx, internalRefs.skills.listSkillAppealsInternal, {
      actorUserId: auth.userId,
      status,
      cursor: url.searchParams.get("cursor")?.trim() || null,
      limit: toOptionalNumber(url.searchParams.get("limit")),
    });
    return json(result, 200, rate.headers);
  }

  if (second === "install" && segments.length === 2) {
    const installUrl = new URL(request.url);
    if (installUrl.searchParams.has("reference")) {
      const reference = installUrl.searchParams.get("reference") ?? "";
      const catalogRef = parseSkillsShCatalogReference(reference);
      if (!catalogRef || catalogRef.slug !== slug) {
        return text("Invalid skills.sh reference", 400, rate.headers);
      }
      if (!getRuntimeRolloutCapabilities().skillsSh.runtimeEnabled) {
        return text("Skill not found", 404, rate.headers);
      }
      const resolution = await resolveSkillsShInstall(ctx, request, catalogRef);
      if (!resolution) return text("Skill not found", 404, rate.headers);
      return json(resolution, resolution.ok ? 200 : resolution.status, rate.headers);
    }
    const forceInstall = parseBooleanQueryParam(installUrl.searchParams.get("forceInstall"));
    const skill = (await runQueryRef<
      | (InstallResolverSkill & {
          _id: Id<"skills">;
          githubSourceId?: Id<"githubSkillSources">;
          softDeletedAt?: number;
          moderationStatus?: "active" | "hidden" | "removed";
          moderationReason?: string;
          moderationFlags?: string[];
        })
      | null
    >(ctx, internalRefs.skills.getSkillBySlugInternal, skillLookupArgs)) as
      | (InstallResolverSkill & {
          _id: Id<"skills">;
          githubSourceId?: Id<"githubSkillSources">;
          softDeletedAt?: number;
          moderationStatus?: "active" | "hidden" | "removed";
          moderationReason?: string;
          moderationFlags?: string[];
        })
      | null;
    if (!skill || skill.softDeletedAt || skill.moderationStatus === "removed") {
      return text("Skill not found", 404, rate.headers);
    }

    const source =
      skill.installKind === "github" && skill.githubSourceId
        ? ((await runQueryRef(ctx, internalRefs.githubSkillSources.getByIdInternal, {
            sourceId: skill.githubSourceId,
          })) as InstallResolverSource | null)
        : null;
    const resolution = buildSkillInstallResolution({
      origin: publicApiOrigin(request),
      skill,
      source,
      ownerHandle,
      forceInstall,
    });

    const publicSkillResult = (await ctx.runQuery(
      api.skills.getBySlug,
      skillLookupArgs,
    )) as GetBySlugResult;
    const publiclyVisible = publicSkillResult?.skill?._id === skill._id;
    if (!publiclyVisible) {
      if (!resolution.ok && shouldExposeHiddenGitHubInstallBlock(skill, resolution)) {
        return json(resolution, resolution.status, rate.headers);
      }
      return text("Skill not found", 404, rate.headers);
    }

    return json(resolution, resolution.ok ? 200 : resolution.status, rate.headers);
  }

  if (segments.length === 1) {
    const result = (await ctx.runQuery(api.skills.getBySlug, skillLookupArgs)) as GetBySlugResult;
    if (!result?.skill) {
      const hidden = await describeOwnerVisibleSkillState(ctx, request, slug, ownerHandle);
      if (hidden) return text(hidden.message, hidden.status, rate.headers);
      return skillNotFoundOrAmbiguousResponse(
        request,
        result,
        slug,
        skillOwnerHandleExample(slug),
        rate.headers,
      );
    }

    const [tags] = await resolveTagsBatch(
      ctx,
      [result.skill.tags],
      [result.latestVersion],
      [result.skill._id],
    );
    const latestVersionId =
      result.skill.latestVersionId ?? result.skill.tags?.latest ?? result.latestVersion?._id;
    const descriptionAccessBlock = result.latestVersion
      ? getPublicSkillVersionAccessBlock(
          result.moderationInfo,
          result.latestVersion._id,
          latestVersionId,
        )
      : getPublicSkillFileAccessBlock(result.moderationInfo);
    const description = descriptionAccessBlock
      ? null
      : await readSkillDescriptionMarkdown(ctx, result.skill._id, latestVersionId);
    const setup = buildSkillSetup(result.latestVersion?.parsed);

    return json(
      {
        skill: {
          slug: result.skill.slug,
          displayName: result.skill.displayName,
          summary: result.skill.summary ?? null,
          icon: result.skill.icon ?? null,
          description: description ?? result.latestVersion?.parsed?.description ?? null,
          topics: result.skill.topics,
          tags,
          stats: result.skill.stats,
          createdAt: result.skill.createdAt,
          updatedAt: result.skill.updatedAt,
        },
        latestVersion: result.latestVersion
          ? {
              version: result.latestVersion.version,
              createdAt: result.latestVersion.createdAt,
              changelog: result.latestVersion.changelog,
              license: result.latestVersion.parsed?.license ?? null,
            }
          : null,
        metadata: result.latestVersion?.parsed?.clawdis
          ? {
              setup,
              os: result.latestVersion.parsed.clawdis.os ?? null,
              systems: result.latestVersion.parsed.clawdis.nix?.systems ?? null,
            }
          : null,
        owner: result.owner
          ? {
              handle: result.owner.handle ?? null,
              userId: result.owner._id,
              displayName: result.owner.displayName ?? null,
              image: result.owner.image ?? null,
            }
          : null,
        moderation: result.moderationInfo
          ? {
              isSuspicious: result.moderationInfo.isSuspicious ?? false,
              isMalwareBlocked: result.moderationInfo.isMalwareBlocked ?? false,
              verdict: result.moderationInfo.verdict ?? "clean",
              reasonCodes: result.moderationInfo.reasonCodes ?? [],
              summary: result.moderationInfo.summary ?? null,
              engineVersion: result.moderationInfo.engineVersion ?? null,
              updatedAt: result.moderationInfo.updatedAt ?? null,
            }
          : null,
      },
      200,
      rate.headers,
    );
  }

  if (second === "moderation" && segments.length === 2) {
    const apiTokenUserId = await getOptionalApiTokenUserId(ctx, request);
    let isStaff = false;
    if (apiTokenUserId) {
      const caller = await ctx.runQuery(internal.users.getByIdInternal, { userId: apiTokenUserId });
      if (caller?.role === "admin" || caller?.role === "moderator") {
        isStaff = true;
      }
    }

    const hiddenSkill = await ctx.runQuery(internal.skills.getSkillBySlugInternal, skillLookupArgs);
    const isOwner = Boolean(
      apiTokenUserId && hiddenSkill && apiTokenUserId === hiddenSkill.ownerUserId,
    );

    const result = (await ctx.runQuery(api.skills.getBySlug, skillLookupArgs)) as GetBySlugResult;
    if (!result?.skill) {
      if (result?.ambiguous) {
        return ambiguousSkillSlugResponse(
          slug,
          skillOwnerHandleExample(slug, "/moderation"),
          rate.headers,
        );
      }
      if (hiddenSkill && (isOwner || isStaff)) {
        const mod = normalizeModerationFromSkill(hiddenSkill as SkillModerationShape);
        return json(
          {
            moderation: {
              isSuspicious: mod.isSuspicious,
              isMalwareBlocked: mod.isMalwareBlocked,
              verdict: mod.verdict,
              reasonCodes: mod.reasonCodes,
              summary: mod.summary,
              engineVersion: mod.engineVersion,
              updatedAt: mod.updatedAt,
              evidence: sanitizeEvidence(mod.evidence, true),
              legacyReason: mod.reason,
            },
          },
          200,
          rate.headers,
        );
      }

      return text("Moderation details unavailable", 404, rate.headers);
    }

    const mod = hiddenSkill
      ? normalizeModerationFromSkill(hiddenSkill as SkillModerationShape)
      : result.moderationInfo
        ? {
            isSuspicious: result.moderationInfo.isSuspicious ?? false,
            isMalwareBlocked: result.moderationInfo.isMalwareBlocked ?? false,
            verdict: result.moderationInfo.verdict ?? "clean",
            reasonCodes: result.moderationInfo.reasonCodes ?? [],
            summary: result.moderationInfo.summary ?? null,
            engineVersion: result.moderationInfo.engineVersion ?? null,
            updatedAt: result.moderationInfo.updatedAt ?? null,
            reason: result.moderationInfo.reason ?? null,
            evidence: [],
          }
        : null;
    const isFlagged = Boolean(mod?.isSuspicious || mod?.isMalwareBlocked);

    if (!isOwner && !isStaff && !isFlagged) {
      return text("Moderation details unavailable", 404, rate.headers);
    }

    return json(
      {
        moderation: mod
          ? {
              isSuspicious: mod.isSuspicious,
              isMalwareBlocked: mod.isMalwareBlocked,
              verdict: mod.verdict,
              reasonCodes: mod.reasonCodes,
              summary: mod.summary,
              engineVersion: mod.engineVersion,
              updatedAt: mod.updatedAt,
              evidence: sanitizeEvidence(mod.evidence, isOwner || isStaff),
              legacyReason: isOwner || isStaff ? mod.reason : null,
            }
          : null,
      },
      200,
      rate.headers,
    );
  }

  if (second === "versions" && segments.length === 2) {
    const skillResult = (await ctx.runQuery(
      api.skills.getBySlug,
      skillLookupArgs,
    )) as GetBySlugResult;
    if (!skillResult?.skill) {
      return skillNotFoundOrAmbiguousResponse(
        request,
        skillResult,
        slug,
        skillOwnerHandleExample(slug, "/versions"),
        rate.headers,
      );
    }

    const limit = toOptionalNumber(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor")?.trim() || undefined;
    const versionsResult = (await ctx.runQuery(api.skills.listVersionsPage, {
      skillId: skillResult.skill._id,
      limit,
      cursor,
    })) as ListVersionsResult;

    const items = versionsResult.items
      .filter((version) => !version.softDeletedAt)
      .map((version) => ({
        version: version.version,
        createdAt: version.createdAt,
        changelog: version.changelog,
        changelogSource: version.changelogSource ?? null,
      }));

    return json({ items, nextCursor: versionsResult.nextCursor ?? null }, 200, rate.headers);
  }

  if (second === "versions" && third && segments.length === 3) {
    const skillResult = (await ctx.runQuery(
      api.skills.getBySlug,
      skillLookupArgs,
    )) as GetBySlugResult;
    if (!skillResult?.skill) {
      const moderationBlock = await getUnavailableSkillVersionBlock(ctx, slug, ownerHandle, {
        versionName: third,
      });
      if (moderationBlock) {
        return text(moderationBlock.message, moderationBlock.status, rate.headers);
      }
      return skillNotFoundOrAmbiguousResponse(
        request,
        skillResult,
        slug,
        skillOwnerHandleExample(slug, `/versions/${encodeURIComponent(third)}`),
        rate.headers,
      );
    }

    const version = (await ctx.runQuery(api.skills.getVersionBySkillAndVersion, {
      skillId: skillResult.skill._id,
      version: third,
    })) as PublicSkillVersionResponse | null;
    if (!version) return text("Version not found", 404, rate.headers);
    if (version.softDeletedAt) return text("Version not available", 410, rate.headers);
    const effectiveLatestVersionId =
      skillResult.skill.latestVersionId ?? skillResult.skill.tags?.latest;
    const moderationBlock = getPublicSkillVersionAccessBlock(
      skillResult.moderationInfo,
      version._id,
      effectiveLatestVersionId,
    );
    if (moderationBlock) {
      return text(moderationBlock.message, moderationBlock.status, rate.headers);
    }
    const security = buildSkillSecuritySnapshot(version);

    return json(
      {
        skill: { slug: skillResult.skill.slug, displayName: skillResult.skill.displayName },
        version: {
          version: version.version,
          createdAt: version.createdAt,
          changelog: version.changelog,
          changelogSource: version.changelogSource ?? null,
          license: version.parsed?.license ?? null,
          files: version.files.map((file) => ({
            path: file.path,
            size: file.size,
            sha256: file.sha256,
            contentType: normalizeContentType(file.contentType) ?? null,
          })),
          security: security ?? undefined,
        },
      },
      200,
      rate.headers,
    );
  }

  if (second === "scan" && segments.length === 2) {
    const versionParam = url.searchParams.get("version")?.trim();
    const tagParam = url.searchParams.get("tag")?.trim();

    const result = (await ctx.runQuery(api.skills.getBySlug, skillLookupArgs)) as GetBySlugResult;
    if (!result?.skill) {
      const moderationBlock = await getUnavailableSkillVersionBlock(ctx, slug, ownerHandle, {
        versionName: versionParam,
        tagName: tagParam,
      });
      if (moderationBlock) {
        return text(moderationBlock.message, moderationBlock.status, rate.headers);
      }
      const hidden = await describeOwnerVisibleSkillState(ctx, request, slug, ownerHandle);
      if (hidden) return text(hidden.message, hidden.status, rate.headers);
      return skillNotFoundOrAmbiguousResponse(
        request,
        result,
        slug,
        skillOwnerHandleExample(slug, "/scan"),
        rate.headers,
      );
    }

    let version = result.latestVersion;
    if (versionParam) {
      version = await ctx.runQuery(api.skills.getVersionBySkillAndVersion, {
        skillId: result.skill._id,
        version: versionParam,
      });
    } else if (tagParam) {
      const versionId = result.skill.tags[tagParam];
      if (versionId) {
        version = await ctx.runQuery(api.skills.getVersionById, { versionId });
      } else {
        version = null;
      }
    }

    if (!version || !isSkillVersionForSkill(version, result.skill._id)) {
      return text("Version not found", 404, rate.headers);
    }
    if (version.softDeletedAt) return text("Version not available", 410, rate.headers);

    const effectiveLatestVersionId = result.skill.latestVersionId ?? result.skill.tags?.latest;
    const moderationBlock = getPublicSkillVersionAccessBlock(
      result.moderationInfo,
      version._id,
      effectiveLatestVersionId,
    );
    if (moderationBlock) {
      return text(moderationBlock.message, moderationBlock.status, rate.headers);
    }

    let moderationSourceVersion: PublicSkillVersionResponse | null = result.latestVersion;
    const moderationSourceVersionId = result.moderationInfo?.sourceVersionId;
    if (moderationSourceVersionId) {
      if (version._id === moderationSourceVersionId) {
        moderationSourceVersion = version;
      } else if (result.latestVersion?._id !== moderationSourceVersionId) {
        const sourceVersion = (await ctx.runQuery(api.skills.getVersionById, {
          versionId: moderationSourceVersionId,
        })) as PublicSkillVersionResponse | null;
        moderationSourceVersion = isSkillVersionForSkill(sourceVersion, result.skill._id)
          ? sourceVersion
          : null;
      }
    }
    const security = buildSkillSecuritySnapshot(version);
    const moderationMatchesRequestedVersion = Boolean(
      moderationSourceVersion && moderationSourceVersion._id === version._id,
    );

    return json(
      {
        skill: {
          slug: result.skill.slug,
          displayName: result.skill.displayName,
        },
        version: {
          version: version.version,
          createdAt: version.createdAt,
          changelogSource: version.changelogSource ?? null,
        },
        moderation: result.moderationInfo
          ? {
              scope: "skill",
              sourceVersion: moderationSourceVersion
                ? {
                    version: moderationSourceVersion.version,
                    createdAt: moderationSourceVersion.createdAt,
                  }
                : null,
              matchesRequestedVersion: moderationMatchesRequestedVersion,
              isPendingScan: result.moderationInfo.isPendingScan ?? false,
              isMalwareBlocked: result.moderationInfo.isMalwareBlocked ?? false,
              isSuspicious: result.moderationInfo.isSuspicious ?? false,
              isHiddenByMod: result.moderationInfo.isHiddenByMod ?? false,
              isRemoved: result.moderationInfo.isRemoved ?? false,
            }
          : null,
        security,
      },
      200,
      rate.headers,
    );
  }

  if (second === "verify" && segments.length === 2) {
    const verifyUrl = new URL(request.url);
    const versionParam = verifyUrl.searchParams.get("version")?.trim();
    const tagParam = verifyUrl.searchParams.get("tag")?.trim();
    if (versionParam && tagParam) return text("Use either version or tag", 400, rate.headers);
    if (verifyUrl.searchParams.has("reference")) {
      const reference = verifyUrl.searchParams.get("reference") ?? "";
      const catalogRef = parseSkillsShCatalogReference(reference);
      if (!catalogRef || catalogRef.slug !== slug || versionParam || tagParam) {
        return text("Invalid skills.sh reference", 400, rate.headers);
      }
      if (!getRuntimeRolloutCapabilities().skillsSh.runtimeEnabled) {
        return text("Skill not found", 404, rate.headers);
      }
      const verification = await resolveSkillsShVerify(ctx, request, catalogRef);
      return verification
        ? json(verification, 200, rate.headers)
        : text("Skill not found", 404, rate.headers);
    }

    const skillResult = (await runQueryRef<GetBySlugResult>(
      ctx,
      internalRefs.skills.getVerifyTargetBySlugInternal,
      skillLookupArgs,
    )) as GetBySlugResult;
    if (!skillResult?.skill) {
      const hidden = await describeOwnerVisibleSkillState(ctx, request, slug, ownerHandle);
      if (hidden) return text(hidden.message, hidden.status, rate.headers);
      return skillNotFoundOrAmbiguousResponse(
        request,
        skillResult,
        slug,
        skillOwnerHandleExample(slug, "/verify"),
        rate.headers,
      );
    }

    let resolvedFrom: VerificationResolvedFrom = "latest";
    let version: Doc<"skillVersions"> | null = skillResult.skill.latestVersionId
      ? await ctx.runQuery(internal.skills.getVersionByIdInternal, {
          versionId: skillResult.skill.latestVersionId,
        })
      : null;
    if (versionParam) {
      resolvedFrom = "version";
      version = await ctx.runQuery(internal.skills.getVersionBySkillAndVersionInternal, {
        skillId: skillResult.skill._id,
        version: versionParam,
      });
    } else if (tagParam) {
      resolvedFrom = "tag";
      const versionId = skillResult.skill.tags[tagParam];
      version = versionId
        ? await ctx.runQuery(internal.skills.getVersionByIdInternal, { versionId })
        : null;
    }

    if (!version || !isSkillVersionForSkill(version, skillResult.skill._id)) {
      return text("Version not found", 404, rate.headers);
    }
    if (version.softDeletedAt) return text("Version not available", 410, rate.headers);

    const fingerprintEntries = ((await ctx.runQuery(
      internal.skills.listVersionFingerprintsInternal,
      { skillVersionId: version._id },
    )) ?? []) as SkillVersionFingerprintSummary[];
    const bundleFingerprints = fingerprintEntries
      .filter((entry) => entry.kind === "generated-bundle")
      .map((entry) => entry.fingerprint);
    const isMalwareBlocked = skillResult.moderationInfo?.isMalwareBlocked ?? false;
    const generatedCardFile = isMalwareBlocked
      ? null
      : await selectGeneratedSkillCardFile(version.files, bundleFingerprints);
    const security = buildVerifySecurity(version);
    const reasons = buildVerifyReasons({
      cardAvailable: Boolean(generatedCardFile),
      isMalwareBlocked,
      securityPassed: security.passed,
      securityStatus: security.status,
    });
    const publisherOwnerHandle = skillResult.owner?.handle ?? null;
    const ownerDisplayName = skillResult.owner?.displayName ?? null;

    return json(
      {
        schema: "clawhub.skill.verify.v1",
        ok: reasons.length === 0,
        decision: reasons.length === 0 ? "pass" : "fail",
        reasons,
        slug: skillResult.skill.slug,
        displayName: skillResult.skill.displayName,
        pageUrl: publisherOwnerHandle
          ? `https://clawhub.ai/${publisherOwnerHandle}/skills/${skillResult.skill.slug}`
          : `https://clawhub.ai/api/v1/skills/${skillResult.skill.slug}`,
        publisherHandle: publisherOwnerHandle,
        publisherDisplayName: ownerDisplayName,
        publisherProfileUrl: publisherOwnerHandle
          ? `https://clawhub.ai/${publisherOwnerHandle}`
          : null,
        version: version.version,
        resolvedFrom,
        tag: tagParam || null,
        createdAt: version.createdAt,
        card: generatedCardFile
          ? {
              available: true,
              path: generatedCardFile.path,
              url: buildCardUrl(
                request,
                skillResult.skill.slug,
                version.version,
                publisherOwnerHandle,
              ),
              sha256: generatedCardFile.sha256,
              size: generatedCardFile.size,
              contentType: generatedCardFile.contentType ?? "text/markdown; charset=utf-8",
            }
          : {
              available: false,
              path: "skill-card.md",
              url: isMalwareBlocked
                ? null
                : buildCardUrl(
                    request,
                    skillResult.skill.slug,
                    version.version,
                    publisherOwnerHandle,
                  ),
              sha256: null,
              size: null,
              contentType: null,
            },
        artifact: {
          sourceFingerprint: version.fingerprint ?? null,
          bundleFingerprints,
          files: sourceFilesForVerify(version.files, bundleFingerprints),
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
        security,
        signature: {
          status: "unsigned",
        },
      },
      200,
      rate.headers,
    );
  }

  if (second === "card" && segments.length === 2) {
    const cardRequestUrl = new URL(request.url);
    const versionParam = cardRequestUrl.searchParams.get("version")?.trim();
    const tagParam = cardRequestUrl.searchParams.get("tag")?.trim();

    const skillResult = (await ctx.runQuery(
      api.skills.getBySlug,
      skillLookupArgs,
    )) as GetBySlugResult;
    if (!skillResult?.skill) {
      const hidden = await describeOwnerVisibleSkillState(ctx, request, slug, ownerHandle);
      if (hidden) return text(hidden.message, hidden.status, rate.headers);
      return skillNotFoundOrAmbiguousResponse(
        request,
        skillResult,
        slug,
        skillOwnerHandleExample(slug, "/card"),
        rate.headers,
      );
    }

    let version: Doc<"skillVersions"> | null = skillResult.skill.latestVersionId
      ? await ctx.runQuery(internal.skills.getVersionByIdInternal, {
          versionId: skillResult.skill.latestVersionId,
        })
      : null;
    if (versionParam) {
      version = await ctx.runQuery(internal.skills.getVersionBySkillAndVersionInternal, {
        skillId: skillResult.skill._id,
        version: versionParam,
      });
    } else if (tagParam) {
      const versionId = skillResult.skill.tags[tagParam];
      version = versionId
        ? await ctx.runQuery(internal.skills.getVersionByIdInternal, { versionId })
        : null;
    }

    if (!version || !isSkillVersionForSkill(version, skillResult.skill._id)) {
      return text("Version not found", 404, rate.headers);
    }
    if (version.softDeletedAt) return text("Version not available", 410, rate.headers);
    const effectiveLatestVersionId =
      skillResult.skill.latestVersionId ?? skillResult.skill.tags?.latest;
    const versionDownloadBlock = getPublicSkillVersionDownloadBlock(
      skillResult.moderationInfo,
      version,
      effectiveLatestVersionId,
    );
    if (versionDownloadBlock) {
      return text(versionDownloadBlock.message, versionDownloadBlock.status, rate.headers);
    }

    const fingerprintEntries = ((await ctx.runQuery(
      internal.skills.listVersionFingerprintsInternal,
      { skillVersionId: version._id },
    )) ?? []) as SkillVersionFingerprintSummary[];
    const bundleFingerprints = fingerprintEntries
      .filter((entry) => entry.kind === "generated-bundle")
      .map((entry) => entry.fingerprint);
    const file = await selectGeneratedSkillCardFile(version.files, bundleFingerprints);
    if (!file) return text("Skill Card not found", 404, rate.headers);
    if (file.size > MAX_RAW_FILE_BYTES) return text("File exceeds 200KB limit", 413, rate.headers);

    const blob = await ctx.storage.get(file.storageId);
    if (!blob) return text("File missing in storage", 410, rate.headers);
    return safeTextFileResponse({
      textContent: await blob.text(),
      path: file.path,
      contentType: file.contentType ?? "text/markdown; charset=utf-8",
      sha256: file.sha256,
      size: file.size,
      headers: rate.headers,
    });
  }

  if (second === "file" && segments.length === 2) {
    const path = url.searchParams.get("path")?.trim();
    if (!path) return text("Missing path", 400, rate.headers);
    const preview = url.searchParams.get("preview") === "1";
    const versionParam = url.searchParams.get("version")?.trim();
    const tagParam = url.searchParams.get("tag")?.trim();

    const skillResult = (await ctx.runQuery(
      api.skills.getBySlug,
      skillLookupArgs,
    )) as GetBySlugResult;
    if (!skillResult?.skill) {
      return skillNotFoundOrAmbiguousResponse(
        request,
        skillResult,
        slug,
        skillOwnerHandleExample(slug, `/file?path=${encodeURIComponent(path)}`),
        rate.headers,
      );
    }
    const moderationBlock = getPublicSkillFileAccessBlock(skillResult.moderationInfo);
    if (moderationBlock) {
      return text(moderationBlock.message, moderationBlock.status, rate.headers);
    }

    let version: Doc<"skillVersions"> | null = skillResult.skill.latestVersionId
      ? await ctx.runQuery(internal.skills.getVersionByIdInternal, {
          versionId: skillResult.skill.latestVersionId,
        })
      : null;
    if (versionParam) {
      version = await ctx.runQuery(internal.skills.getVersionBySkillAndVersionInternal, {
        skillId: skillResult.skill._id,
        version: versionParam,
      });
    } else if (tagParam) {
      const versionId = skillResult.skill.tags[tagParam];
      if (versionId) {
        version = await ctx.runQuery(internal.skills.getVersionByIdInternal, { versionId });
      }
    }

    if (!version || !isSkillVersionForSkill(version, skillResult.skill._id)) {
      return text("Version not found", 404, rate.headers);
    }
    if (version.softDeletedAt) return text("Version not available", 410, rate.headers);
    const effectiveLatestVersionId =
      skillResult.skill.latestVersionId ?? skillResult.skill.tags?.latest;
    const versionDownloadBlock = getPublicSkillVersionDownloadBlock(
      skillResult.moderationInfo,
      version,
      effectiveLatestVersionId,
    );
    if (versionDownloadBlock) {
      return text(versionDownloadBlock.message, versionDownloadBlock.status, rate.headers);
    }

    const normalized = path.trim();
    const normalizedLower = normalized.toLowerCase();
    const file =
      version.files.find((entry) => entry.path === normalized) ??
      version.files.find((entry) => entry.path.toLowerCase() === normalizedLower);
    if (!file) return text("File not found", 404, rate.headers);
    const maxBytes = preview ? MAX_RAW_FILE_BYTES : MAX_PUBLISH_FILE_BYTES;
    if (file.size > maxBytes) {
      return text(
        preview ? "File exceeds 200KB preview limit" : "File exceeds 10MB limit",
        413,
        rate.headers,
      );
    }

    const blob = await ctx.storage.get(file.storageId);
    if (!blob) return text("File missing in storage", 410, rate.headers);
    if (preview) {
      return await safeStoredFilePreviewResponse({
        blob,
        path: file.path,
        contentType: file.contentType ?? undefined,
        sha256: file.sha256,
        size: file.size,
        headers: rate.headers,
      });
    }
    return await safeStoredFileResponse({
      blob,
      path: file.path,
      contentType: file.contentType ?? undefined,
      sha256: file.sha256,
      size: file.size,
      headers: rate.headers,
    });
  }

  return text("Not found", 404, rate.headers);
}

export async function publishSkillV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, "write");
  if (!rate.ok) return rate.response;

  const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
  if (!auth.ok) return auth.response;

  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = await request.json();
      const payload = parsePublishBody(body);
      if (!hasAcceptedLegacyLicenseTerms(payload.acceptLicenseTerms)) {
        return text("MIT-0 license terms must be accepted to publish skills", 400, rate.headers);
      }
      if (payload.files.some((file) => !file.uploadTicket)) {
        return text(
          "Every directly uploaded skill file requires an upload ticket",
          400,
          rate.headers,
        );
      }
      const result = await publishSkillPayloadForApiUser(ctx, auth.userId, payload);
      return json({ ok: true, ...result }, 200, rate.headers);
    }

    if (contentType.includes("multipart/form-data")) {
      const payload = await parseMultipartPublish(ctx, request);
      let keepStoredFiles = false;
      try {
        if (!hasAcceptedLegacyLicenseTerms(payload.acceptLicenseTerms)) {
          return text("MIT-0 license terms must be accepted to publish skills", 400, rate.headers);
        }
        const result = await publishSkillPayloadForApiUser(ctx, auth.userId, payload);
        keepStoredFiles = true;
        return json({ ok: true, ...result }, 200, rate.headers);
      } finally {
        if (!keepStoredFiles) {
          await deleteStoredMultipartFiles(ctx, payload.files);
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Publish failed";
    return text(message, 400, rate.headers);
  }

  return text("Unsupported content type", 415, rate.headers);
}

async function publishSkillPayloadForApiUser(
  ctx: ActionCtx,
  userId: Id<"users">,
  payload: ReturnType<typeof parsePublishBody>,
) {
  const { ownerHandle, sourceOwnerHandle, migrateOwner, ...publishPayload } = payload;
  const uploadTickets = publishPayload.files.flatMap((file) =>
    file.uploadTicket ? [file.uploadTicket] : [],
  );
  if (uploadTickets.length > 0 && uploadTickets.length !== publishPayload.files.length) {
    throw new Error("Every directly uploaded skill file requires an upload ticket");
  }
  const files = publishPayload.files.map(({ uploadTicket: _uploadTicket, ...file }) => file);
  const target = ownerHandle
    ? ((await ctx.runMutation(internal.publishers.resolvePublishTargetForUserInternal, {
        actorUserId: userId,
        ownerHandle,
        minimumRole: "publisher",
      })) as { publisherId: Id<"publishers"> })
    : null;
  const source =
    target && migrateOwner === true && sourceOwnerHandle && sourceOwnerHandle !== ownerHandle
      ? ((await ctx.runMutation(internal.publishers.resolvePublishTargetForUserInternal, {
          actorUserId: userId,
          ownerHandle: sourceOwnerHandle,
          minimumRole: "publisher",
        })) as { publisherId: Id<"publishers"> })
      : null;
  const shouldMigrateOwner = Boolean(target && source);
  return await publishVersionForUser(
    ctx,
    userId,
    { ...publishPayload, files },
    {
      ...(target ? { ownerPublisherId: target.publisherId } : {}),
      ...(source ? { sourceOwnerPublisherId: source.publisherId } : {}),
      ...(shouldMigrateOwner ? { migrateOwner: true } : {}),
      ...(uploadTickets.length > 0 ? { skillPublishUploadTickets: uploadTickets } : {}),
    },
  );
}

function hasAcceptedLegacyLicenseTerms(acceptLicenseTerms: boolean | undefined) {
  return acceptLicenseTerms === true;
}

type TransferDecisionAction = "accept" | "reject" | "cancel";

function isTransferDecisionFailure(result: unknown): result is { ok: false; error: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { ok?: unknown }).ok === false &&
    typeof (result as { error?: unknown }).error === "string"
  );
}

function transferErrorToResponse(error: unknown, headers: HeadersInit) {
  const message = error instanceof Error ? error.message : "Transfer failed";
  const lower = message.toLowerCase();
  if (lower.includes("unauthorized"))
    return text(formatAuthzMessage(error, "Unauthorized"), 401, headers);
  if (lower.includes("forbidden"))
    return text(formatAuthzMessage(error, "Forbidden"), 403, headers);
  if (lower.includes("not found")) return text(message, 404, headers);
  if (lower.includes("required") || lower.includes("invalid") || lower.includes("pending")) {
    return text(message, 400, headers);
  }
  return text(message, 400, headers);
}

function ownershipErrorToResponse(error: unknown, headers: HeadersInit) {
  const message = error instanceof Error ? error.message : "Skill update failed";
  const lower = message.toLowerCase();
  if (lower.includes("unauthorized"))
    return text(formatAuthzMessage(error, "Unauthorized"), 401, headers);
  if (lower.includes("forbidden"))
    return text(formatAuthzMessage(error, "Forbidden"), 403, headers);
  if (lower.includes("not found")) return text(message, 404, headers);
  return text(message, 400, headers);
}

async function resolveTransferContext(
  ctx: ActionCtx,
  request: Request,
  slug: string,
  ownerHandle: string | undefined,
  headers: HeadersInit,
): Promise<
  { ok: true; userId: Id<"users">; skill: Doc<"skills"> } | { ok: false; response: Response }
> {
  const auth = await requireApiTokenUserOrResponse(ctx, request, headers);
  if (!auth.ok) return auth;

  const liveSkill = await ctx.runQuery(internal.skills.getSkillBySlugInternal, {
    slug,
    ...(ownerHandle ? { ownerHandle } : {}),
  });
  const skill =
    liveSkill ??
    (auth.user.role === "admin"
      ? await ctx.runQuery(internal.skills.getSkillBySlugIncludingSoftDeletedInternal, {
          slug,
          ...(ownerHandle ? { ownerHandle } : {}),
        })
      : null);
  if (!skill || (skill.softDeletedAt && auth.user.role !== "admin"))
    return { ok: false, response: text("Skill not found", 404, headers) };

  return { ok: true, userId: auth.userId, skill };
}

async function handleTransferRequest(
  ctx: ActionCtx,
  request: Request,
  slug: string,
  headers: HeadersInit,
) {
  const ownerHandle = getOwnerHandleParam(new URL(request.url));
  const transferContext = await resolveTransferContext(ctx, request, slug, ownerHandle, headers);
  if (!transferContext.ok) return transferContext.response;

  const parsed = await parseJsonPayload(request, headers);
  if (!parsed.ok) return parsed.response;

  const toUserHandleRaw =
    typeof parsed.payload.toUserHandle === "string" ? parsed.payload.toUserHandle.trim() : "";
  const toOwnerRaw =
    typeof parsed.payload.toOwner === "string"
      ? parsed.payload.toOwner.trim()
      : typeof parsed.payload.toPublisherHandle === "string"
        ? parsed.payload.toPublisherHandle.trim()
        : "";
  const toHandleRaw = toOwnerRaw || toUserHandleRaw;
  if (!toHandleRaw) return text("toUserHandle required", 400, headers);
  const message = typeof parsed.payload.message === "string" ? parsed.payload.message : undefined;
  if (transferContext.skill.softDeletedAt && !message?.trim()) {
    return text("message required for soft-deleted skill transfer", 400, headers);
  }

  try {
    const publisher = (await ctx.runQuery(internal.publishers.getByHandleInternal, {
      handle: toHandleRaw,
    })) as { kind?: "user" | "org"; handle?: string; linkedUserId?: Id<"users"> } | null;
    const isActorPersonalPublisher =
      publisher?.kind === "user" && publisher.linkedUserId === transferContext.userId;
    if (
      transferContext.skill.softDeletedAt ||
      toOwnerRaw ||
      publisher?.kind === "org" ||
      isActorPersonalPublisher
    ) {
      const result = await ctx.runMutation(internal.skills.transferSkillOwnerForUserInternal, {
        actorUserId: transferContext.userId,
        slug: transferContext.skill.slug,
        ...(ownerHandle ? { ownerHandle } : {}),
        toOwner: toHandleRaw,
        ...(message ? { reason: message } : {}),
      });
      return json(result, 200, headers);
    }

    const result = await ctx.runMutation(internal.skillTransfers.requestTransferInternal, {
      actorUserId: transferContext.userId,
      skillId: transferContext.skill._id,
      toUserHandle: toHandleRaw,
      message,
    });
    return json(result, 200, headers);
  } catch (error) {
    return transferErrorToResponse(error, headers);
  }
}

async function handleTransferDecision(
  ctx: ActionCtx,
  request: Request,
  slug: string,
  decision: TransferDecisionAction,
  headers: HeadersInit,
) {
  const ownerHandle = getOwnerHandleParam(new URL(request.url));
  const transferContext = await resolveTransferContext(ctx, request, slug, ownerHandle, headers);
  if (!transferContext.ok) return transferContext.response;

  const pendingTransfer =
    decision === "cancel"
      ? await ctx.runQuery(internal.skillTransfers.getPendingTransferBySkillAndFromUserInternal, {
          skillId: transferContext.skill._id,
          fromUserId: transferContext.userId,
        })
      : await ctx.runQuery(internal.skillTransfers.getPendingTransferBySkillAndUserInternal, {
          skillId: transferContext.skill._id,
          toUserId: transferContext.userId,
        });
  if (!pendingTransfer) return text("No pending transfer found", 404, headers);

  const mutation =
    decision === "accept"
      ? internal.skillTransfers.acceptTransferInternal
      : decision === "reject"
        ? internal.skillTransfers.rejectTransferInternal
        : internal.skillTransfers.cancelTransferInternal;

  try {
    const result = await ctx.runMutation(mutation, {
      actorUserId: transferContext.userId,
      transferId: pendingTransfer._id,
    });
    if (isTransferDecisionFailure(result)) {
      return transferErrorToResponse(new Error(result.error), headers);
    }
    return json(result, 200, headers);
  } catch (error) {
    return transferErrorToResponse(error, headers);
  }
}

async function handleSkillsTransferPost(
  ctx: ActionCtx,
  request: Request,
  segments: string[],
  headers: HeadersInit,
) {
  const slug = segments[0]?.trim().toLowerCase() ?? "";
  if (!slug) return text("Slug required", 400, headers);

  if (segments.length === 2) {
    return handleTransferRequest(ctx, request, slug, headers);
  }
  if (segments.length === 3) {
    const decision = segments[2]?.trim().toLowerCase();
    if (decision === "accept" || decision === "reject" || decision === "cancel") {
      return handleTransferDecision(ctx, request, slug, decision, headers);
    }
  }
  return text("Not found", 404, headers);
}

async function handleSkillRenamePost(
  ctx: ActionCtx,
  request: Request,
  slug: string,
  headers: HeadersInit,
) {
  const auth = await requireApiTokenUserOrResponse(ctx, request, headers);
  if (!auth.ok) return auth.response;

  const parsed = await parseJsonPayload(request, headers);
  if (!parsed.ok) return parsed.response;
  const newSlug = typeof parsed.payload.newSlug === "string" ? parsed.payload.newSlug : "";
  if (!newSlug.trim()) return text("newSlug required", 400, headers);
  const url = new URL(request.url);
  const ownerHandle =
    optionalStringField(parsed.payload, "ownerHandle") ?? getOwnerHandleParam(url);

  try {
    const result = await ctx.runMutation(internal.skills.renameOwnedSkillInternal, {
      actorUserId: auth.userId,
      slug,
      newSlug,
      ...(ownerHandle ? { ownerHandle } : {}),
    });
    return json(result, 200, headers);
  } catch (error) {
    return ownershipErrorToResponse(error, headers);
  }
}

async function handleSkillMergePost(
  ctx: ActionCtx,
  request: Request,
  slug: string,
  headers: HeadersInit,
) {
  const auth = await requireApiTokenUserOrResponse(ctx, request, headers);
  if (!auth.ok) return auth.response;

  const parsed = await parseJsonPayload(request, headers);
  if (!parsed.ok) return parsed.response;
  const targetSlug = typeof parsed.payload.targetSlug === "string" ? parsed.payload.targetSlug : "";
  if (!targetSlug.trim()) return text("targetSlug required", 400, headers);
  const url = new URL(request.url);
  const ownerHandle =
    optionalStringField(parsed.payload, "ownerHandle") ?? getOwnerHandleParam(url);
  const sourceOwnerHandle = optionalStringField(parsed.payload, "sourceOwnerHandle") ?? ownerHandle;
  const targetOwnerHandle = optionalStringField(parsed.payload, "targetOwnerHandle");

  try {
    const result = await ctx.runMutation(internal.skills.mergeOwnedSkillIntoCanonicalInternal, {
      actorUserId: auth.userId,
      sourceSlug: slug,
      targetSlug,
      ...(sourceOwnerHandle ? { sourceOwnerHandle } : {}),
      ...(targetOwnerHandle ? { targetOwnerHandle } : {}),
    });
    return json(result, 200, headers);
  } catch (error) {
    return ownershipErrorToResponse(error, headers);
  }
}

export async function skillsPostRouterV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, "write");
  if (!rate.ok) return rate.response;

  const segments = getPathSegments(request, "/api/v1/skills/");
  const action = segments[1] ?? "";
  const slug = segments[0]?.trim().toLowerCase() ?? "";

  if (segments.length === 2 && slug === "-" && action === "upload-url") {
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;
    try {
      const expected = parseArk(
        ApiV1SkillUploadUrlRequestSchema,
        await request.json(),
        "Skill upload request",
      );
      const { uploadTicket } = await ctx.runMutation(
        internal.skillPublishUploads.createSkillPublishUploadInternal,
        {
          userId: auth.userId,
          path: expected.path,
          size: expected.size,
          sha256: expected.sha256,
          ...(expected.contentType ? { contentType: expected.contentType } : {}),
        },
      );
      // The request reaching this Convex action has the direct Convex origin even
      // when clawhub.ai forwarded it. Keep the file body off the Vercel request path.
      const uploadUrl = new URL(
        `/api/v1/skills/-/upload/${encodeURIComponent(uploadTicket)}`,
        request.url,
      ).toString();
      return json({ uploadUrl, uploadTicket }, 200, rate.headers);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid skill upload request";
      return text(message, 400, rate.headers);
    }
  }

  if (segments.length === 3 && slug === "-" && action === "upload" && segments[2]) {
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;
    const uploadTicket = segments[2] as Id<"skillPublishUploadTickets">;
    let storageId: Id<"_storage"> | undefined;
    try {
      const expected = await ctx.runQuery(
        internal.skillPublishUploads.getSkillPublishUploadForUserInternal,
        { userId: auth.userId, uploadTicket },
      );
      const declaredLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > expected.size) {
        return text("Uploaded file exceeds its declared size", 413, rate.headers);
      }
      const bytes = await readRequestBodyWithinLimit(request, expected.size);
      if (!bytes) {
        return text("Uploaded file exceeds its declared size", 413, rate.headers);
      }
      if (bytes.byteLength !== expected.size) {
        return text("Uploaded file size does not match its upload ticket", 400, rate.headers);
      }
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sha256 = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      if (sha256 !== expected.sha256) {
        return text("Uploaded file SHA-256 does not match its upload ticket", 400, rate.headers);
      }
      storageId = await ctx.storage.store(
        new Blob([bytes], expected.contentType ? { type: expected.contentType } : undefined),
      );
      await ctx.runMutation(internal.skillPublishUploads.attachSkillPublishUploadInternal, {
        userId: auth.userId,
        uploadTicket,
        storageId,
      });
      return json({ storageId }, 200, rate.headers);
    } catch (error) {
      if (storageId) await ctx.storage.delete(storageId).catch(() => undefined);
      const message = error instanceof Error ? error.message : "Skill upload failed";
      return text(message, 400, rate.headers);
    }
  }

  if (segments.length === 3 && segments[1] === "tags" && segments[2]) {
    if (!slug) return text("Slug required", 400, rate.headers);
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;
    try {
      const body = await readOptionalJson(request);
      const version = optionalStringField(body, "version")?.trim();
      if (!version) return text("Version required", 400, rate.headers);
      const ownerHandle =
        optionalStringField(body, "ownerHandle") ?? getOwnerHandleParam(new URL(request.url));
      const result = await runMutationRef(ctx, internalRefs.skills.setSkillTagForUserInternal, {
        actorUserId: auth.userId,
        slug,
        tag: segments[2],
        version,
        ...(ownerHandle ? { ownerHandle } : {}),
      });
      return json(result, 200, rate.headers);
    } catch (error) {
      if (error instanceof SyntaxError) return text("Invalid JSON", 400, rate.headers);
      return ownershipErrorToResponse(error, rate.headers);
    }
  }

  if (
    segments.length === 4 &&
    segments[1] === "versions" &&
    segments[2] &&
    segments[3] === "moderation"
  ) {
    if (!slug) return text("Slug required", 400, rate.headers);
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;
    try {
      const body = parseArk(
        SkillVersionRevokeRequestSchema,
        await request.json(),
        "Skill version moderation payload",
      ) as { state: "revoked"; reason: string; ownerHandle?: string };
      const result = await runMutationRef(
        ctx,
        internalRefs.skills.revokeSkillVersionForUserInternal,
        {
          actorUserId: auth.userId,
          slug,
          version: segments[2],
          reason: body.reason,
          ...(body.ownerHandle ? { ownerHandle: body.ownerHandle } : {}),
        },
      );
      return json(result, 200, rate.headers);
    } catch (error) {
      if (error instanceof SyntaxError) return text("Invalid JSON", 400, rate.headers);
      return skillVersionModerationErrorToResponse(error, rate.headers);
    }
  }

  if (segments[0] === "-" && segments[1] === "repair-vt-pending" && segments.length === 2) {
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;
    const admin = requireAdminOrResponse(auth.user, rate.headers);
    if (!admin.ok) return admin.response;
    try {
      const body = parseArk(
        ApiV1SkillRepairVtPendingRequestSchema,
        await request.json(),
        "Skill VT pending repair payload",
      ) as {
        cursor?: string | null;
        batchSize?: number;
        concurrency?: number;
        dryRun?: boolean;
      };
      const result = await runActionRef<
        | {
            dryRun: boolean;
            total: number;
            wouldUpdate: number;
            updated: number;
            noResults: number;
            noDecisiveStats: number;
            errors: number;
            done: boolean;
            cursor: string | null;
            statusCounts: Record<string, number>;
            sampleUpdated: Array<{ slug: string; status: string }>;
          }
        | { error: string }
      >(ctx, internalRefs.vt.repairPendingSkillVtAnalysis, {
        dryRun: body.dryRun !== false,
        cursor: body.cursor ?? null,
        ...(body.batchSize !== undefined ? { batchSize: body.batchSize } : {}),
        ...(body.concurrency !== undefined ? { concurrency: body.concurrency } : {}),
      });
      if ("error" in result) return text(result.error, 400, rate.headers);
      return json({ ok: true, ...result }, 200, rate.headers);
    } catch (error) {
      if (error instanceof SyntaxError) return text("Invalid JSON", 400, rate.headers);
      return text(
        error instanceof Error ? error.message : "Skill VT pending repair failed",
        400,
        rate.headers,
      );
    }
  }

  if (segments[0] === "-" && segments[1] === "rescan-batch" && segments.length === 2) {
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;
    const admin = requireAdminOrResponse(auth.user, rate.headers);
    if (!admin.ok) return admin.response;
    try {
      const body = parseArk(
        ApiV1SkillBulkRescanBatchRequestSchema,
        await request.json(),
        "Skill bulk rescan batch payload",
      ) as {
        mode?: "all-active-latest";
        cursor?: string | null;
        batchSize?: number;
        dryRun?: boolean;
      };
      const result = await runMutationRef(
        ctx,
        internalRefs.securityScan.enqueueBulkSkillRescanBatchForAdminInternal,
        {
          actorUserId: auth.userId,
          ...(body.mode ? { mode: body.mode } : {}),
          cursor: body.cursor ?? null,
          ...(body.batchSize !== undefined ? { batchSize: body.batchSize } : {}),
          ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
        },
      );
      return json(result, 200, rate.headers);
    } catch (error) {
      if (error instanceof SyntaxError) return text("Invalid JSON", 400, rate.headers);
      return text(
        error instanceof Error ? error.message : "Skill bulk rescan failed",
        400,
        rate.headers,
      );
    }
  }

  if (
    segments[0] === "-" &&
    segments[1] === "rescan-batch" &&
    segments[2] === "status" &&
    segments.length === 3
  ) {
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;
    const admin = requireAdminOrResponse(auth.user, rate.headers);
    if (!admin.ok) return admin.response;
    try {
      const body = parseArk(
        ApiV1SkillBulkRescanStatusRequestSchema,
        await request.json(),
        "Skill bulk rescan status payload",
      ) as { jobIds: string[] };
      const result = await runQueryRef(
        ctx,
        internalRefs.securityScan.getBulkSkillRescanBatchStatusForAdminInternal,
        {
          actorUserId: auth.userId,
          jobIds: body.jobIds,
        },
      );
      return json(result, 200, rate.headers);
    } catch (error) {
      if (error instanceof SyntaxError) return text("Invalid JSON", 400, rate.headers);
      return text(
        error instanceof Error ? error.message : "Skill bulk rescan status failed",
        400,
        rate.headers,
      );
    }
  }

  if (segments.length === 2 && action === "hard-delete") {
    if (!slug) return text("Slug required", 400, rate.headers);
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;
    const admin = requireAdminOrResponse(auth.user, rate.headers);
    if (!admin.ok) return admin.response;
    try {
      const payload = parseArk(
        ApiV1SkillHardDeleteRequestSchema,
        await request.json(),
        "Skill hard-delete payload",
      ) as {
        ownerHandle: string;
        reason: string;
        dryRun?: boolean;
        confirmationToken?: string;
      };
      const result = await runMutationRef(ctx, internalRefs.skills.hardDeleteForAdminInternal, {
        actorUserId: auth.userId,
        slug,
        ownerHandle: payload.ownerHandle,
        reason: payload.reason,
        ...(payload.dryRun !== undefined ? { dryRun: payload.dryRun } : {}),
        ...(payload.confirmationToken ? { confirmationToken: payload.confirmationToken } : {}),
      });
      return json(result, 200, rate.headers);
    } catch (error) {
      if (error instanceof SyntaxError) return text("Invalid JSON", 400, rate.headers);
      return skillHardDeleteErrorToResponse(error, rate.headers);
    }
  }

  if (
    segments[0] === "-" &&
    segments[1] === "reports" &&
    segments[2] &&
    segments[3] === "triage" &&
    segments.length === 4
  ) {
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;
    try {
      const body = parseArk(
        SkillReportTriageRequestSchema,
        await request.json(),
        "Skill report triage payload",
      ) as {
        status: "open" | "confirmed" | "dismissed";
        note?: string;
        finalAction?: "none" | "hide";
      };
      const result = await runMutationRef(
        ctx,
        internalRefs.skills.triageSkillReportForUserInternal,
        {
          actorUserId: auth.userId,
          reportId: segments[2] as Id<"skillReports">,
          status: body.status,
          ...(body.note ? { note: body.note } : {}),
          ...(body.finalAction ? { finalAction: body.finalAction } : {}),
        },
      );
      return json(result, 200, rate.headers);
    } catch (error) {
      return text(
        error instanceof Error ? error.message : "Skill report triage failed",
        400,
        rate.headers,
      );
    }
  }

  if (
    segments[0] === "-" &&
    segments[1] === "appeals" &&
    segments[2] &&
    segments[3] === "resolve" &&
    segments.length === 4
  ) {
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;
    try {
      const body = parseArk(
        SkillAppealResolveRequestSchema,
        await request.json(),
        "Skill appeal resolve payload",
      ) as {
        status: "open" | "accepted" | "rejected";
        note?: string;
        finalAction?: "none" | "restore";
      };
      const result = await runMutationRef(
        ctx,
        internalRefs.skills.resolveSkillAppealForUserInternal,
        {
          actorUserId: auth.userId,
          appealId: segments[2] as Id<"skillAppeals">,
          status: body.status,
          ...(body.note ? { note: body.note } : {}),
          ...(body.finalAction ? { finalAction: body.finalAction } : {}),
        },
      );
      return json(result, 200, rate.headers);
    } catch (error) {
      return text(
        error instanceof Error ? error.message : "Skill appeal resolve failed",
        400,
        rate.headers,
      );
    }
  }

  if (segments.length === 2 && action === "report") {
    if (!slug) return text("Slug required", 400, rate.headers);
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;
    const parsed = await parseJsonPayload(request, rate.headers);
    if (!parsed.ok) return parsed.response;
    const reason = typeof parsed.payload.reason === "string" ? parsed.payload.reason : "";
    const version = typeof parsed.payload.version === "string" ? parsed.payload.version : undefined;
    const url = new URL(request.url);
    const ownerHandle =
      optionalStringField(parsed.payload, "ownerHandle") ??
      optionalStringField(parsed.payload, "owner") ??
      getOwnerHandleParam(url);
    try {
      const result = await runMutationRef(ctx, internalRefs.skills.reportSkillForUserInternal, {
        actorUserId: auth.userId,
        slug,
        reason,
        ...(version ? { version } : {}),
        ...(ownerHandle ? { ownerHandle } : {}),
      });
      return json(result, 200, rate.headers);
    } catch (error) {
      return text(
        error instanceof Error ? error.message : "Skill report failed",
        400,
        rate.headers,
      );
    }
  }

  if (segments.length === 2 && action === "featured") {
    if (!slug) return text("Slug required", 400, rate.headers);
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
      const ownerHandle =
        optionalStringField(body, "ownerHandle") ?? getOwnerHandleParam(new URL(request.url));
      const result = await runMutationRef(
        ctx,
        internalRefs.skills.setSkillFeaturedForUserInternal,
        {
          actorUserId: auth.userId,
          slug,
          ...(ownerHandle ? { ownerHandle } : {}),
          featured,
        },
      );
      return json(result, 200, rate.headers);
    } catch (error) {
      if (error instanceof SyntaxError) return text("Invalid JSON", 400, rate.headers);
      return skillRescanErrorToResponse(error, rate.headers);
    }
  }

  if (segments.length === 2 && action === "appeal") {
    if (!slug) return text("Slug required", 400, rate.headers);
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;
    try {
      const body = parseArk(
        SkillAppealRequestSchema,
        await request.json(),
        "Skill appeal payload",
      ) as {
        version?: string;
        message: string;
      };
      const result = await runMutationRef(
        ctx,
        internalRefs.skills.submitSkillAppealForUserInternal,
        {
          actorUserId: auth.userId,
          slug,
          ...(body.version ? { version: body.version } : {}),
          message: body.message,
        },
      );
      return json(result, 200, rate.headers);
    } catch (error) {
      return text(
        error instanceof Error ? error.message : "Skill appeal failed",
        400,
        rate.headers,
      );
    }
  }

  if (segments.length === 2 && action === "rescan") {
    if (!slug) return text("Slug required", 400, rate.headers);
    const auth = await requireApiTokenUserOrResponse(ctx, request, rate.headers);
    if (!auth.ok) return auth.response;
    try {
      const body = await readOptionalJson(request);
      const version = optionalStringField(body, "version");
      const ownerHandle =
        optionalStringField(body, "ownerHandle") ?? getOwnerHandleParam(new URL(request.url));
      const result = await runMutationRef(
        ctx,
        internalRefs.securityScan.requestSkillRescanForUserInternal,
        {
          actorUserId: auth.userId,
          slug,
          ...(ownerHandle ? { ownerHandle } : {}),
          ...(version ? { version } : {}),
        },
      );
      return json(result, 200, rate.headers);
    } catch (error) {
      if (error instanceof SyntaxError) return text("Invalid JSON", 400, rate.headers);
      return skillRescanErrorToResponse(error, rate.headers);
    }
  }

  if (segments.length === 2 && action === "undelete") {
    try {
      const { userId } = await requireApiTokenUser(ctx, request);
      const body = await readOptionalJson(request);
      const reason = optionalStringField(body, "reason");
      const ownerHandle =
        optionalStringField(body, "ownerHandle") ?? getOwnerHandleParam(new URL(request.url));
      const result = await ctx.runMutation(internal.skills.setSkillSoftDeletedInternal, {
        userId,
        slug,
        deleted: false,
        reason,
        ...(ownerHandle ? { ownerHandle } : {}),
      });
      return json(result, 200, rate.headers);
    } catch (error) {
      return softDeleteErrorToResponse("skill", error, rate.headers);
    }
  }

  if (
    segments.length === 4 &&
    segments[1] === "versions" &&
    segments[2] &&
    segments[3] === "restore"
  ) {
    try {
      const { userId } = await requireApiTokenUser(ctx, request);
      const body = await readOptionalJson(request);
      const ownerHandle =
        optionalStringField(body, "ownerHandle") ?? getOwnerHandleParam(new URL(request.url));
      const result = await runMutationRef(
        ctx,
        internalRefs.skills.restoreOwnedVersionForUserInternal,
        {
          actorUserId: userId,
          slug,
          version: segments[2],
          ...(ownerHandle ? { ownerHandle } : {}),
        },
      );
      return json(result, 200, rate.headers);
    } catch (error) {
      if (error instanceof SyntaxError) return text("Invalid JSON", 400, rate.headers);
      return skillVersionDeleteErrorToResponse(error, rate.headers);
    }
  }

  if (action === "transfer") {
    return handleSkillsTransferPost(ctx, request, segments, rate.headers);
  }

  if (segments.length === 2 && action === "rename") {
    if (!slug) return text("Slug required", 400, rate.headers);
    return handleSkillRenamePost(ctx, request, slug, rate.headers);
  }

  if (segments.length === 2 && action === "merge") {
    if (!slug) return text("Slug required", 400, rate.headers);
    return handleSkillMergePost(ctx, request, slug, rate.headers);
  }

  return text("Not found", 404, rate.headers);
}

function skillVersionModerationErrorToResponse(error: unknown, headers: HeadersInit) {
  const message = error instanceof Error ? error.message : "Skill version moderation failed";
  const lower = message.toLowerCase();
  if (lower.includes("unauthorized")) return text(message, 401, headers);
  if (lower.includes("forbidden")) return text(message, 403, headers);
  if (lower.includes("not found")) return text(message, 404, headers);
  return text(message, 400, headers);
}

function skillHardDeleteErrorToResponse(error: unknown, headers: HeadersInit) {
  const message = error instanceof Error ? error.message : "Skill hard delete failed";
  const lower = message.toLowerCase();
  if (lower.includes("unauthorized")) return text(message, 401, headers);
  if (lower.includes("forbidden")) return text(message, 403, headers);
  if (lower.includes("not found")) return text(message, 404, headers);
  return text(message, 400, headers);
}

function skillRescanErrorToResponse(error: unknown, headers: HeadersInit) {
  const message = error instanceof Error ? error.message : "Skill rescan failed";
  const lower = message.toLowerCase();
  if (lower.includes("unauthorized")) {
    return text(formatAuthzMessage(error, "Unauthorized"), 401, headers);
  }
  if (lower.includes("forbidden")) {
    return text(formatAuthzMessage(error, "Forbidden"), 403, headers);
  }
  if (lower.includes("not found")) return text(message, 404, headers);
  return text(message, 400, headers);
}

export async function skillsDeleteRouterV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, "write");
  if (!rate.ok) return rate.response;

  const segments = getPathSegments(request, "/api/v1/skills/");
  const isWholeDelete = segments.length === 1;
  const isVersionDelete = segments.length === 3 && segments[1] === "versions";
  if (!isWholeDelete && !isVersionDelete) return text("Not found", 404, rate.headers);
  const slug = segments[0]?.trim().toLowerCase() ?? "";
  try {
    const { userId } = await requireApiTokenUser(ctx, request);
    const body = await readOptionalJson(request);
    if (isVersionDelete) {
      const versionTarget = resolveVersionPathTarget(segments[2], request, body);
      if (versionTarget.error) return text(versionTarget.error, 400, rate.headers);
      await runMutationRef(ctx, internalRefs.skills.deleteOwnedVersionForUserInternal, {
        actorUserId: userId,
        slug,
        version: versionTarget.version!,
      });
      return json({ ok: true }, 200, rate.headers);
    }
    if (hasVersionDeleteSelector(request, body)) {
      return text(
        versionDeleteRouteGuidance(
          `${ApiRoutes.skills}/${encodeURIComponent(slug)}`,
          request,
          body,
        ),
        400,
        rate.headers,
      );
    }
    const reason = optionalStringField(body, "reason");
    const ownerHandle =
      optionalStringField(body, "ownerHandle") ?? getOwnerHandleParam(new URL(request.url));
    const result = await ctx.runMutation(internal.skills.setSkillSoftDeletedInternal, {
      userId,
      slug,
      deleted: true,
      reason,
      ...(ownerHandle ? { ownerHandle } : {}),
    });
    return json(result, 200, rate.headers);
  } catch (error) {
    if (error instanceof SyntaxError) return text("Invalid JSON", 400, rate.headers);
    if (isVersionDelete) return skillVersionDeleteErrorToResponse(error, rate.headers);
    return softDeleteErrorToResponse("skill", error, rate.headers);
  }
}

function skillVersionDeleteErrorToResponse(error: unknown, headers: HeadersInit) {
  const message = formatUserFacingErrorMessage(error, "Skill version delete failed");
  const lower = message.toLowerCase();
  if (lower.includes("unauthorized")) {
    return text(formatAuthzMessage(error, "Unauthorized"), 401, headers);
  }
  if (lower.includes("forbidden")) {
    return text(formatAuthzMessage(error, "Forbidden"), 403, headers);
  }
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

type SkillsExportPhase =
  | "list_skills"
  | "build_empty_zip"
  | "load_versions"
  | "plan_blobs"
  | "load_blob_urls"
  | "load_blobs"
  | "assemble_entries"
  | "build_zip";

type SkillsExportLogContext = {
  phase: SkillsExportPhase;
  startDate: number;
  endDate: number;
  limit: number;
  cursorPresent: boolean;
  pageLength: number;
  hasMore: boolean | null;
  nextCursorPresent: boolean | null;
  versionCount: number;
  blobTaskCount: number;
  blobCount: number;
  zipEntryCount: number;
  manifestCount: number;
  exportErrorCount: number;
  totalExportBytes: number;
};

function logSkillsExportFailure(context: SkillsExportLogContext, error: unknown) {
  console.error("skills_export_failed", {
    ...context,
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage:
      error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
  });
}

export async function exportSkillsV1Handler(
  ctx: ActionCtx,
  request: Request,
  dependencies: SkillsExportDependencies = DEFAULT_SKILLS_EXPORT_DEPENDENCIES,
) {
  try {
    await requireApiTokenUser(ctx, request);
  } catch (err) {
    return text(err instanceof Error ? err.message : "Unauthorized", 401);
  }

  const manifestRequested = request.headers.get(ARCHIVE_MANIFEST_REQUEST_HEADER) === "v1";
  if (manifestRequested) {
    const token = request.headers.get(ARCHIVE_REQUEST_IDENTITY_HEADER)?.trim();
    const expectedEnvironment = expectedVercelEnvironmentForConvexSite(request.url);
    if (!token || !expectedEnvironment) return unauthorizedSkillsExportManifestResponse();
    try {
      await dependencies.verifyArchiveRequester(token, expectedEnvironment);
    } catch {
      return unauthorizedSkillsExportManifestResponse();
    }
  }

  const rate = await applyRateLimit(ctx, request, "export");
  if (!rate.ok) return rate.response;

  const url = new URL(request.url);
  const startDate = toOptionalNumber(url.searchParams.get("startDate"));
  const endDate = toOptionalNumber(url.searchParams.get("endDate"));
  const requestedLimit = toOptionalNumber(url.searchParams.get("limit"));
  const cursor = url.searchParams.get("cursor")?.trim() || undefined;

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
  if (requestedLimit != null && requestedLimit > MAX_EXPORT_PAGE_LIMIT) {
    return text(`limit must be <= ${MAX_EXPORT_PAGE_LIMIT}`, 400, rate.headers);
  }
  const limit = Math.max(1, requestedLimit ?? DEFAULT_EXPORT_PAGE_LIMIT);

  const logContext: SkillsExportLogContext = {
    phase: "list_skills",
    startDate,
    endDate,
    limit,
    cursorPresent: Boolean(cursor),
    pageLength: 0,
    hasMore: null,
    nextCursorPresent: null,
    versionCount: 0,
    blobTaskCount: 0,
    blobCount: 0,
    zipEntryCount: 0,
    manifestCount: 0,
    exportErrorCount: 0,
    totalExportBytes: 0,
  };

  let result: {
    page: Array<{
      skillId: Id<"skills">;
      slug: string;
      displayName: string;
      latestVersionId?: Id<"skillVersions">;
      installKind?: "github";
      createdAt: number;
      updatedAt: number;
      stats?: Record<string, unknown> | null;
      ownerUserId: Id<"users">;
      ownerHandle?: string | null;
      ownerDisplayName?: string | null;
    }>;
    nextCursor: string | null;
    hasMore: boolean;
  };
  try {
    result = await ctx.runQuery(internal.skills.listByDateRange, {
      startDate,
      endDate,
      cursor,
      numItems: limit,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Invalid cursor format")) {
      return text("Invalid cursor format", 400, rate.headers);
    }
    logSkillsExportFailure(logContext, err);
    throw err;
  }
  logContext.pageLength = result.page.length;
  logContext.hasMore = result.hasMore;
  logContext.nextCursorPresent = Boolean(result.nextCursor);

  if (result.page.length === 0) {
    try {
      logContext.phase = "build_empty_zip";
      const filename = `skills-export-${startDate}-${endDate}-empty.zip`;
      if (manifestRequested) {
        return await buildSignedSkillsExportManifestResponse(
          request,
          dependencies,
          filename,
          [],
          [],
          mergeHeaders(rate.headers, {
            "X-Next-Cursor": result.nextCursor ?? "",
            "X-Has-More": String(result.hasMore),
            "X-Total-Returned": "0",
            "X-Date-Range": `${startDate}-${endDate}`,
            "X-Export-Errors": "0",
          }),
        );
      }
      const emptyZip = buildMergedExportZip([], []);
      return new Response(emptyZip as unknown as BodyInit, {
        status: 200,
        headers: mergeHeaders(rate.headers, {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "X-Next-Cursor": result.nextCursor ?? "",
          "X-Has-More": String(result.hasMore),
          "X-Total-Returned": "0",
          "X-Date-Range": `${startDate}-${endDate}`,
        }),
      });
    } catch (err) {
      logSkillsExportFailure(logContext, err);
      throw err;
    }
  }

  const exportErrors: Array<{ slug: string; error: string }> = [];

  try {
    logContext.phase = "load_versions";
    const versionDocs = await chunkedParallel(result.page, 100, (digest) =>
      digest.latestVersionId
        ? ctx.runQuery(internal.skills.getVersionByIdInternal, {
            versionId: digest.latestVersionId,
          })
        : Promise.resolve(null),
    );
    const githubTargets = await chunkedParallel(result.page, 100, (digest) =>
      isGitHubSourceExportDigest(digest)
        ? ctx.runQuery(internal.skills.getGitHubDownloadTargetInternal, {
            skillId: digest.skillId,
          })
        : Promise.resolve(null),
    );
    logContext.versionCount = versionDocs.filter(Boolean).length;
    const exportableVersions: Array<Doc<"skillVersions"> | null> = Array.from(
      { length: result.page.length },
      () => null,
    );
    const exportableGitHubTargets: Array<ReadyGitHubHandoffTarget | null> = Array.from(
      { length: result.page.length },
      () => null,
    );

    type BlobTask = {
      digestIndex: number;
      fileIndex: number;
      storageId: Id<"_storage">;
      archivePath: string;
      size: number;
      sha256: string;
    };
    const blobTasks: BlobTask[] = [];

    logContext.phase = "plan_blobs";
    for (let i = 0; i < result.page.length; i++) {
      const digest = result.page[i];
      const version = versionDocs[i] as Doc<"skillVersions"> | null;

      if (!version) {
        if (isGitHubSourceExportDigest(digest)) {
          const target = githubTargets[i] as GitHubHandoffTarget;
          const block = getGitHubHandoffBlock(target);
          if (block) {
            exportErrors.push({
              slug: digest.slug,
              error: block.message,
            });
            continue;
          }
          if (!isReadyGitHubHandoffTarget(target)) {
            exportErrors.push({
              slug: digest.slug,
              error: "GitHub-backed skill source metadata is incomplete.",
            });
            continue;
          }
          exportableGitHubTargets[i] = target;
          continue;
        }
        exportErrors.push({
          slug: digest.slug,
          error: `version not found (latestVersionId: ${digest.latestVersionId ?? "null"})`,
        });
        continue;
      }
      if (!isSkillVersionForSkill(version, digest.skillId)) {
        exportErrors.push({
          slug: digest.slug,
          error: `version not found (latestVersionId: ${digest.latestVersionId})`,
        });
        continue;
      }
      if (version.softDeletedAt) {
        exportErrors.push({
          slug: digest.slug,
          error: `version not available (latestVersionId: ${digest.latestVersionId})`,
        });
        continue;
      }
      if (!version.files || version.files.length === 0) {
        exportErrors.push({
          slug: digest.slug,
          error: `version has no files (latestVersionId: ${digest.latestVersionId})`,
        });
        continue;
      }
      exportableVersions[i] = version;

      if (!validateSlug(digest.slug)) {
        exportErrors.push({
          slug: digest.slug,
          error: "invalid slug (fails Zip Slip validation)",
        });
        continue;
      }

      const publisherSegment = getExportPublisherSegment(digest);
      if (!publisherSegment) continue;
      const exportRoot = `${publisherSegment}/${digest.slug}`;
      const archivePaths = new Set([`${exportRoot}/_export_skill_meta.json`]);

      for (let j = 0; j < version.files.length; j++) {
        if (blobTasks.length >= MAX_EXPORT_FILE_COUNT) {
          exportErrors.push({
            slug: digest.slug,
            error: `file count cap exceeded (${MAX_EXPORT_FILE_COUNT})`,
          });
          break;
        }
        const archivePath = `${exportRoot}/${version.files[j].path}`;
        if (!validateExportArchivePath(archivePath)) {
          exportErrors.push({
            slug: digest.slug,
            error: `archive path exceeds signed manifest byte limit (file index ${j})`,
          });
          continue;
        }
        if (archivePaths.has(archivePath)) {
          exportErrors.push({
            slug: digest.slug,
            error: `duplicate archive path skipped: "${archivePath}"`,
          });
          continue;
        }
        archivePaths.add(archivePath);
        blobTasks.push({
          digestIndex: i,
          fileIndex: j,
          storageId: version.files[j].storageId,
          archivePath,
          size: version.files[j].size,
          sha256: version.files[j].sha256,
        });
      }
    }
    logContext.blobTaskCount = blobTasks.length;
    logContext.exportErrorCount = exportErrors.length;

    logContext.phase = manifestRequested ? "load_blob_urls" : "load_blobs";
    const blobs = await chunkedParallel(blobTasks, 50, async (task) =>
      manifestRequested
        ? { kind: "storage" as const, url: await ctx.storage.getUrl(task.storageId) }
        : { kind: "blob" as const, blob: await ctx.storage.get(task.storageId) },
    );
    logContext.blobCount = blobs.length;

    type PreparedExportEntry =
      | { path: string; bytes: Uint8Array }
      | { path: string; url: string; size: number; sha256: string };
    const zipEntries: PreparedExportEntry[] = [];
    const manifest: MergedExportManifestEntry[] = [];
    let totalExportBytes = 0;

    const blobsByDigest = new Map<
      number,
      Map<
        number,
        {
          source: { kind: "blob"; blob: Blob | null } | { kind: "storage"; url: string | null };
          archivePath: string;
          size: number;
          sha256: string;
        }
      >
    >();
    for (let k = 0; k < blobTasks.length; k++) {
      const task = blobTasks[k];
      if (!blobsByDigest.has(task.digestIndex)) {
        blobsByDigest.set(task.digestIndex, new Map());
      }
      blobsByDigest.get(task.digestIndex)!.set(task.fileIndex, {
        source: blobs[k],
        archivePath: task.archivePath,
        size: task.size,
        sha256: task.sha256,
      });
    }

    logContext.phase = "assemble_entries";
    for (let i = 0; i < result.page.length; i++) {
      const digest = result.page[i];
      const version = exportableVersions[i] as {
        version?: string;
        files?: Array<{ storageId: Id<"_storage">; path: string }>;
      } | null;
      if (!validateSlug(digest.slug)) continue;

      const publisherSegment = getExportPublisherSegment(digest);
      if (!publisherSegment) {
        exportErrors.push({
          slug: digest.slug,
          error: "invalid publisher path segment (fails Zip Slip validation)",
        });
        continue;
      }
      const exportRoot = `${publisherSegment}/${digest.slug}`;
      const githubTarget = exportableGitHubTargets[i];
      if (githubTarget) {
        const descriptor = buildGitHubSkillHandoffDescriptor(githubTarget);
        zipEntries.push({
          path: `${exportRoot}/_source_handoff.json`,
          bytes: new TextEncoder().encode(JSON.stringify(descriptor, null, 2)),
        });

        const skillMeta = buildExportSkillMeta(digest, {
          sourceRef: "public-github",
          version: null,
        });
        zipEntries.push({
          path: `${exportRoot}/_export_skill_meta.json`,
          bytes: new TextEncoder().encode(JSON.stringify(skillMeta, null, 2)),
        });

        manifest.push({
          publisher: publisherSegment,
          slug: digest.slug,
          sourceRef: "public-github",
          version: null,
          displayName: digest.displayName,
          createdAt: digest.createdAt,
          updatedAt: digest.updatedAt,
          stats: (digest.stats as Record<string, unknown>) ?? null,
          fileCount: 0,
        });
        continue;
      }

      if (!version?.files) continue;
      const digestBlobs = blobsByDigest.get(i);
      if (!digestBlobs) continue;

      let fileCount = 0;
      for (let j = 0; j < version.files.length; j++) {
        const filePath = version.files[j].path;

        if (!validateFilePath(filePath)) {
          exportErrors.push({
            slug: digest.slug,
            error: `invalid file path: "${filePath}" (fails Zip Slip validation)`,
          });
          continue;
        }

        const plannedFile = digestBlobs.get(j);
        if (!plannedFile) continue;
        const sourceAvailable =
          plannedFile.source.kind === "storage"
            ? Boolean(plannedFile.source.url)
            : Boolean(plannedFile.source.blob);
        if (!sourceAvailable) {
          exportErrors.push({
            slug: digest.slug,
            error: `blob not found for file "${filePath}" (storageId: ${version.files[j].storageId})`,
          });
          continue;
        }

        const fileBytes =
          plannedFile.source.kind === "storage" ? plannedFile.size : plannedFile.source.blob!.size;
        if (totalExportBytes + fileBytes > MAX_EXPORT_TOTAL_BYTES) {
          exportErrors.push({
            slug: digest.slug,
            error: `byte cap exceeded (${MAX_EXPORT_TOTAL_BYTES}) at file "${filePath}"`,
          });
          continue;
        }
        totalExportBytes += fileBytes;
        if (plannedFile.source.kind === "storage") {
          zipEntries.push({
            path: plannedFile.archivePath,
            url: plannedFile.source.url!,
            size: plannedFile.size,
            sha256: plannedFile.sha256,
          });
        } else {
          zipEntries.push({
            path: plannedFile.archivePath,
            bytes: new Uint8Array(await plannedFile.source.blob!.arrayBuffer()),
          });
        }
        fileCount++;
      }

      const skillMeta = buildExportSkillMeta(digest, {
        sourceRef: "public-clawhub",
        version: version.version ?? null,
      });
      zipEntries.push({
        path: `${exportRoot}/_export_skill_meta.json`,
        bytes: new TextEncoder().encode(JSON.stringify(skillMeta, null, 2)),
      });

      manifest.push({
        publisher: publisherSegment,
        slug: digest.slug,
        sourceRef: "public-clawhub",
        version: version.version ?? null,
        displayName: digest.displayName,
        createdAt: digest.createdAt,
        updatedAt: digest.updatedAt,
        stats: (digest.stats as Record<string, unknown>) ?? null,
        fileCount,
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
    const filename = `skills-export-${startDate}-${endDate}.zip`;
    if (manifestRequested) {
      return await buildSignedSkillsExportManifestResponse(
        request,
        dependencies,
        filename,
        zipEntries,
        manifest,
        mergeHeaders(rate.headers, {
          "X-Next-Cursor": result.nextCursor ?? "",
          "X-Has-More": String(result.hasMore),
          "X-Total-Returned": String(manifest.length),
          "X-Date-Range": `${startDate}-${endDate}`,
          "X-Export-Errors": String(exportErrors.length),
        }),
      );
    }
    const zipBytes = buildMergedExportZip(
      zipEntries.filter((entry): entry is { path: string; bytes: Uint8Array } => "bytes" in entry),
      manifest,
    );

    return new Response(zipBytes as unknown as BodyInit, {
      status: 200,
      headers: mergeHeaders(rate.headers, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Next-Cursor": result.nextCursor ?? "",
        "X-Has-More": String(result.hasMore),
        "X-Total-Returned": String(manifest.length),
        "X-Date-Range": `${startDate}-${endDate}`,
        "X-Export-Errors": String(exportErrors.length),
      }),
    });
  } catch (err) {
    logSkillsExportFailure(logContext, err);
    throw err;
  }
}

function unauthorizedSkillsExportManifestResponse() {
  return new Response("Unauthorized archive manifest request", {
    status: 401,
    headers: { "Cache-Control": "no-store" },
  });
}

async function buildSignedSkillsExportManifestResponse(
  request: Request,
  dependencies: SkillsExportDependencies,
  filename: string,
  entries: Array<
    | { path: string; bytes: Uint8Array }
    | { path: string; url: string; size: number; sha256: string }
  >,
  exportManifest: MergedExportManifestEntry[],
  headers: HeadersInit,
) {
  const issuedAt = Date.now();
  const manifest: SkillExportArchiveManifest = {
    schema: "clawhub.skill-export-archive-manifest.v1",
    issuer: new URL(request.url).origin,
    audience: ARCHIVE_MANIFEST_AUDIENCE,
    issuedAt,
    expiresAt: issuedAt + ARCHIVE_MANIFEST_TTL_MS,
    filename,
    entries: entries.map((entry) =>
      "bytes" in entry
        ? {
            kind: "inline" as const,
            path: entry.path,
            text: new TextDecoder().decode(entry.bytes),
          }
        : {
            kind: "storage" as const,
            path: entry.path,
            url: entry.url,
            size: entry.size,
            sha256: entry.sha256,
          },
    ),
    exportManifest,
  };
  const signedManifest = await dependencies.signArchiveManifest(manifest);
  if (new TextEncoder().encode(signedManifest).byteLength > MAX_ARCHIVE_MANIFEST_BYTES) {
    return new Response("Skill export archive manifest is too large", {
      status: 413,
      headers,
    });
  }
  return new Response(signedManifest, {
    status: 200,
    headers: mergeHeaders(headers, {
      "Content-Type": ARCHIVE_MANIFEST_CONTENT_TYPE,
      "Cache-Control": "private, no-store",
    }),
  });
}

function getExportPublisherSegment(digest: {
  ownerHandle?: string | null;
  ownerUserId: Id<"users">;
}) {
  const ownerHandle = digest.ownerHandle?.trim();
  if (ownerHandle && validateSlug(ownerHandle)) return ownerHandle;
  const fallback = String(digest.ownerUserId).replace(/[^a-zA-Z0-9._-]/g, "-");
  return validateSlug(fallback) ? fallback : null;
}

function isGitHubSourceExportDigest(digest: {
  installKind?: "github";
  latestVersionId?: Id<"skillVersions">;
}) {
  return digest.installKind === "github" && !digest.latestVersionId;
}

function buildExportSkillMeta(
  digest: {
    slug: string;
    displayName: string;
    createdAt: number;
    updatedAt: number;
    stats?: Record<string, unknown> | null;
    ownerHandle?: string | null;
    ownerDisplayName?: string | null;
  },
  source: { sourceRef: "public-clawhub" | "public-github"; version: string | null },
) {
  return {
    slug: digest.slug,
    displayName: digest.displayName,
    sourceRef: source.sourceRef,
    version: source.version,
    createdAt: digest.createdAt,
    updatedAt: digest.updatedAt,
    stats: digest.stats ?? null,
    owner: {
      handle: digest.ownerHandle ?? null,
      displayName: digest.ownerDisplayName ?? null,
    },
  };
}
