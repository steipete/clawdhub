import { type inferred, type } from "arktype";
import { ClawManifestSummarySchema } from "./claws.js";
import { DocsLinks } from "./docsLinks.js";
import { CliPublishFileSchema, PublishSourceSchema } from "./schemas.js";

export const PACKAGE_TRENDING_LEADERBOARD_LIMIT = 200;

export function normalizePackageOwnerHandle(handle: string | null | undefined) {
  const normalized = handle?.trim().replace(/^@+/, "").toLowerCase();
  return normalized || undefined;
}

export function inferPackageNameScope(name: string) {
  return /^@([^/]+)\//.exec(name.trim().toLowerCase())?.[1];
}

export function getPackageScopeOwnerMismatch(name: string, ownerHandle: string | null | undefined) {
  const scope = inferPackageNameScope(name);
  const selectedOwner = normalizePackageOwnerHandle(ownerHandle);
  if (!scope || !selectedOwner || scope === selectedOwner) return null;
  const packageSlug = name.split("/").pop()?.trim() || "plugin-name";
  return {
    scope,
    selectedOwner,
    suggestedName: `@${selectedOwner}/${packageSlug}`,
    message: `Package scope "@${scope}" must match selected owner "@${selectedOwner}". Publish as "@${scope}" or rename this package to "@${selectedOwner}/${packageSlug}". More info: ${DocsLinks.clawhub.packageScopeFaq}`,
  };
}

export const PackageFamilySchema = type('"skill"|"code-plugin"|"bundle-plugin"|"claw"');
export type PackageFamily = (typeof PackageFamilySchema)[inferred];

export const PackagePublishFamilySchema = type('"skill"|"code-plugin"|"bundle-plugin"|"claw"');
export type PackagePublishFamily = (typeof PackagePublishFamilySchema)[inferred];

export const PackageChannelSchema = type('"official"|"community"|"private"');
export type PackageChannel = (typeof PackageChannelSchema)[inferred];

export const PackageVerificationTierSchema = type(
  '"structural"|"source-linked"|"provenance-verified"|"rebuild-verified"',
);
export type PackageVerificationTier = (typeof PackageVerificationTierSchema)[inferred];

export const PackageVerificationScopeSchema = type('"artifact-only"|"dependency-graph-aware"');
export type PackageVerificationScope = (typeof PackageVerificationScopeSchema)[inferred];

export const PackageCompatibilitySchema = type({
  pluginApiRange: "string?",
  builtWithOpenClawVersion: "string?",
  pluginSdkVersion: "string?",
  minGatewayVersion: "string?",
});
export type PackageCompatibility = (typeof PackageCompatibilitySchema)[inferred];

export const PluginManifestSummarySchema = type({
  schemaVersion: "number",
  icon: "string?",
  compatibility: PackageCompatibilitySchema.optional(),
  manifestIdentity: type({
    name: "string?",
    description: "string?",
    version: "string?",
    family: "string?",
  }).optional(),
  configFields: type({
    name: "string",
    description: "string?",
    required: "boolean",
    sensitive: "boolean",
  }).array(),
  mcpServers: type({
    name: "string",
  }).array(),
  bundledSkills: type({
    name: "string",
    description: "string?",
    rootPath: "string",
    skillMdPath: "string",
    sha256: "string",
    size: "number",
  }).array(),
});
export type PluginManifestSummary = (typeof PluginManifestSummarySchema)[inferred];

export const PackageVerificationSummarySchema = type({
  tier: PackageVerificationTierSchema,
  scope: PackageVerificationScopeSchema,
  summary: "string?",
  sourceRepo: "string?",
  sourceCommit: "string?",
  sourceTag: "string?",
  // Path of the package directory inside the source repo (e.g.
  // "examples/openclaw-plugin"). Forward slash separated, no leading or
  // trailing slash. Used when resolving relative README asset URLs against
  // raw.githubusercontent.com so that subdirectory packages render correctly.
  // Absent or "." means the package lives at the repo root.
  sourcePath: "string?",
  hasProvenance: "boolean?",
  trustedOpenClawPlugin: "boolean?",
  scanStatus: '"clean"|"suspicious"|"malicious"|"pending"|"not-run"?',
});
export type PackageVerificationSummary = (typeof PackageVerificationSummarySchema)[inferred];

export const PackageStatsSchema = type({
  downloads: "number",
  installs: "number",
  stars: "number",
  versions: "number",
});
export type PackageStats = (typeof PackageStatsSchema)[inferred];

export const PackageArtifactKindSchema = type('"legacy-zip"|"npm-pack"');
export type PackageArtifactKind = (typeof PackageArtifactKindSchema)[inferred];

export const PackageReleaseModerationStateSchema = type('"approved"|"quarantined"|"revoked"');
export type PackageReleaseModerationState = (typeof PackageReleaseModerationStateSchema)[inferred];

export const PackageReportStatusSchema = type('"open"|"confirmed"|"dismissed"');
export type PackageReportStatus = (typeof PackageReportStatusSchema)[inferred];
export const PackageReportFinalActionSchema = type('"none"|"quarantine"|"revoke"');
export type PackageReportFinalAction = (typeof PackageReportFinalActionSchema)[inferred];

export const PackageReportListStatusSchema = PackageReportStatusSchema.or('"all"');
export type PackageReportListStatus = (typeof PackageReportListStatusSchema)[inferred];

export const PackageAppealStatusSchema = type('"open"|"accepted"|"rejected"');
export type PackageAppealStatus = (typeof PackageAppealStatusSchema)[inferred];
export const PackageAppealFinalActionSchema = type('"none"|"approve"');
export type PackageAppealFinalAction = (typeof PackageAppealFinalActionSchema)[inferred];

export const PackageAppealListStatusSchema = PackageAppealStatusSchema.or('"all"');
export type PackageAppealListStatus = (typeof PackageAppealListStatusSchema)[inferred];

export const PackageOfficialMigrationPhaseSchema = type(
  '"planned"|"published"|"clawpack-ready"|"legacy-zip-only"|"metadata-ready"|"blocked"|"ready-for-openclaw"',
);
export type PackageOfficialMigrationPhase = (typeof PackageOfficialMigrationPhaseSchema)[inferred];

export const PackageOfficialMigrationListPhaseSchema =
  PackageOfficialMigrationPhaseSchema.or('"all"');
export type PackageOfficialMigrationListPhase =
  (typeof PackageOfficialMigrationListPhaseSchema)[inferred];

export const PackageArtifactSummarySchema = type({
  kind: PackageArtifactKindSchema,
  sha256: "string?",
  size: "number?",
  format: "string?",
  npmIntegrity: "string?",
  npmShasum: "string?",
  npmTarballName: "string?",
  npmUnpackedSize: "number?",
  npmFileCount: "number?",
  source: '"clawhub"?',
  artifactKind: PackageArtifactKindSchema.optional(),
  artifactSha256: "string?",
  packageName: "string?",
  version: "string?",
});
export type PackageArtifactSummary = (typeof PackageArtifactSummarySchema)[inferred];

export const PackagePublishArtifactSchema = type({
  kind: '"npm-pack"',
  storageId: "string",
  sha256: "string",
  size: "number",
  format: '"tgz"',
  npmIntegrity: "string",
  npmShasum: "string",
  npmTarballName: "string",
  npmUnpackedSize: "number",
  npmFileCount: "number",
});
export type PackagePublishArtifact = (typeof PackagePublishArtifactSchema)[inferred];

export const PackageVtAnalysisSchema = type({
  status: "string",
  verdict: "string?",
  analysis: "string?",
  source: "string?",
  checkedAt: "number",
});
export type PackageVtAnalysis = (typeof PackageVtAnalysisSchema)[inferred];

export const PackageSkillSpectorIssueSchema = type({
  issueId: "string",
  category: "string?",
  pattern: "string?",
  severity: "string",
  confidence: "number?",
  file: "string?",
  startLine: "number?",
  endLine: "number?",
  explanation: "string",
  remediation: "string?",
  finding: "string?",
  codeSnippet: "string?",
});
export type PackageSkillSpectorIssue = (typeof PackageSkillSpectorIssueSchema)[inferred];

export const PackageSkillSpectorAnalysisSchema = type({
  status: "string",
  score: "number?",
  severity: "string?",
  recommendation: "string?",
  issueCount: "number",
  issues: PackageSkillSpectorIssueSchema.array(),
  scannerVersion: "string?",
  summary: "string?",
  error: "string?",
  checkedAt: "number",
});
export type PackageSkillSpectorAnalysis = (typeof PackageSkillSpectorAnalysisSchema)[inferred];

export const PackageAigFindingSchema = type({
  ruleId: "string",
  level: "string",
  message: "string",
  title: "string?",
  description: "string?",
  file: "string?",
  startLine: "number?",
  endLine: "number?",
  remediation: "string?",
});
export type PackageAigFinding = (typeof PackageAigFindingSchema)[inferred];

export const PackageAigAnalysisSchema = type({
  status: "string",
  issueCount: "number",
  findings: PackageAigFindingSchema.array(),
  scannerVersion: "string?",
  summary: "string?",
  error: "string?",
  checkedAt: "number",
});
export type PackageAigAnalysis = (typeof PackageAigAnalysisSchema)[inferred];

export const PackageLlmAnalysisDimensionSchema = type({
  name: "string",
  label: "string",
  rating: "string",
  detail: "string",
});
export type PackageLlmAnalysisDimension = (typeof PackageLlmAnalysisDimensionSchema)[inferred];

export const PackageLlmAnalysisSchema = type({
  status: "string",
  verdict: "string?",
  confidence: "string?",
  summary: "string?",
  dimensions: PackageLlmAnalysisDimensionSchema.array().optional(),
  guidance: "string?",
  findings: "string?",
  agenticRiskFindings: "unknown[]?",
  riskSummary: "unknown?",
  model: "string?",
  checkedAt: "number",
});
export type PackageLlmAnalysis = (typeof PackageLlmAnalysisSchema)[inferred];

export const PackageStaticFindingSchema = type({
  code: "string",
  severity: "string",
  file: "string",
  line: "number",
  message: "string",
  evidence: "string",
});
export type PackageStaticFinding = (typeof PackageStaticFindingSchema)[inferred];

export const PackageStaticScanSchema = type({
  status: "string",
  reasonCodes: "string[]",
  findings: PackageStaticFindingSchema.array(),
  summary: "string",
  engineVersion: "string",
  checkedAt: "number",
});
export type PackageStaticScan = (typeof PackageStaticScanSchema)[inferred];

export const BundlePublishMetadataSchema = type({
  id: "string?",
  format: "string?",
  hostTargets: "string[]?",
});
export type BundlePublishMetadata = (typeof BundlePublishMetadataSchema)[inferred];

export const PackageTrustedPublisherSchema = type({
  provider: '"github-actions"',
  repository: "string",
  repositoryId: "string",
  repositoryOwner: "string",
  repositoryOwnerId: "string",
  workflowFilename: "string",
  environment: "string?",
});
export type PackageTrustedPublisher = (typeof PackageTrustedPublisherSchema)[inferred];

// The public registry API is served through Vercel functions, which reject request
// bodies over 4.5 MB before ClawHub code runs. Inline multipart publishes stay under
// that cap; larger ClawPacks stage through the upload-url flow straight into storage.
const MAX_PACKAGE_MULTIPART_MB = 4;
export const MAX_PACKAGE_MULTIPART_BYTES = MAX_PACKAGE_MULTIPART_MB * 1024 * 1024;
export const MAX_PACKAGE_CLAWPACK_BYTES = 120 * 1024 * 1024;
const PACKAGE_MULTIPART_FIXED_OVERHEAD_BYTES = 4096;
const PACKAGE_MULTIPART_PART_OVERHEAD_BYTES = 1024;

export type PackageMultipartUploadField = "files" | "clawpack";
export type PackageMultipartUploadPart = {
  name: string;
  size: number;
  type?: string;
};
export type PackageMultipartUploadSizeInput = {
  payloadJson: string;
  fileFieldName: PackageMultipartUploadField;
  files: readonly PackageMultipartUploadPart[];
};

export function estimatePackageMultipartUploadBytes(
  input: PackageMultipartUploadSizeInput,
): number {
  return (
    PACKAGE_MULTIPART_FIXED_OVERHEAD_BYTES +
    estimateMultipartStringPartBytes("payload", input.payloadJson) +
    input.files.reduce(
      (sum, file) => sum + estimateMultipartFilePartBytes(input.fileFieldName, file),
      0,
    )
  );
}

export function isPackageMultipartUploadTooLarge(input: PackageMultipartUploadSizeInput): boolean {
  return estimatePackageMultipartUploadBytes(input) > MAX_PACKAGE_MULTIPART_BYTES;
}

export function getPackageMultipartSizeError(): string {
  return `Package upload exceeds ${MAX_PACKAGE_MULTIPART_MB}MB multipart upload limit`;
}

function estimateMultipartStringPartBytes(fieldName: string, value: string): number {
  return PACKAGE_MULTIPART_PART_OVERHEAD_BYTES + utf8ByteLength(fieldName) + utf8ByteLength(value);
}

function estimateMultipartFilePartBytes(
  fieldName: PackageMultipartUploadField,
  file: PackageMultipartUploadPart,
): number {
  return (
    file.size +
    PACKAGE_MULTIPART_PART_OVERHEAD_BYTES +
    utf8ByteLength(fieldName) +
    utf8ByteLength(file.name) +
    utf8ByteLength(file.type ?? "")
  );
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) continue;
    if (codePoint > 0xffff) index += 1;
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}

const PackagePublishMetadataFields = {
  name: "string",
  displayName: "string?",
  ownerHandle: "string?",
  family: PackagePublishFamilySchema,
  version: "string",
  changelog: "string",
  expectedArtifactSha256: "string?",
  manualOverrideReason: "string?",
  channel: PackageChannelSchema.optional(),
  tags: "string[]?",
  categories: "string[]?",
  topics: "string[]?",
  source: PublishSourceSchema.optional(),
  bundle: BundlePublishMetadataSchema.optional(),
} as const;

export const PackagePublishMetadataSchema = type({
  "+": "reject",
  ...PackagePublishMetadataFields,
});
export type PackagePublishMetadata = (typeof PackagePublishMetadataSchema)[inferred];

export const ServerPackagePublishRequestSchema = type({
  "+": "reject",
  ...PackagePublishMetadataFields,
  artifact: PackagePublishArtifactSchema.optional(),
  files: CliPublishFileSchema.array(),
});
export type ServerPackagePublishRequest = (typeof ServerPackagePublishRequestSchema)[inferred];

export const PackageListItemSchema = type({
  name: "string",
  displayName: "string",
  family: PackageFamilySchema,
  runtimeId: "string|null?",
  channel: PackageChannelSchema,
  isOfficial: "boolean",
  summary: "string|null?",
  icon: "string|null?",
  ownerHandle: "string|null?",
  createdAt: "number",
  updatedAt: "number",
  latestVersion: "string|null?",
  categories: "string[]?",
  topics: "string[]?",
  featuredAt: "number?",
  verificationTier: PackageVerificationTierSchema.or("null").optional(),
  stats: PackageStatsSchema.optional(),
});
export type PackageListItem = (typeof PackageListItemSchema)[inferred];

export const ApiV1PackageListResponseSchema = type({
  items: PackageListItemSchema.array(),
  nextCursor: "string|null",
});
export type ApiV1PackageListResponse = (typeof ApiV1PackageListResponseSchema)[inferred];

export const PackageValidationReportScanStatusSchema = type(
  '"not-scanned"|"skipped"|"clean"|"warning"|"error"',
);
export type PackageValidationReportScanStatus =
  (typeof PackageValidationReportScanStatusSchema)[inferred];

export const PackageValidationReportFindingSeveritySchema = type('"info"|"warning"|"error"');
export type PackageValidationReportFindingSeverity =
  (typeof PackageValidationReportFindingSeveritySchema)[inferred];

export const PackageValidationReportItemSchema = type({
  package: {
    id: "string",
    name: "string",
    displayName: "string",
  },
  release: {
    id: "string",
    version: "string",
    createdAt: "number",
  },
  references: {
    packagePage: "string",
    release: "string",
  },
  scan: {
    status: PackageValidationReportScanStatusSchema,
    scannedAt: "number|null",
    target: type({ channel: "string", version: "string" }).or("null"),
    inspectorVersion: "string|null",
    skipReason: "string|null",
  },
  findings: type({
    severity: PackageValidationReportFindingSeveritySchema,
    code: "string",
    message: "string",
  }).array(),
});
export type PackageValidationReportItem = (typeof PackageValidationReportItemSchema)[inferred];

export const ApiV1PackageValidationReportPageSchema = type({
  items: PackageValidationReportItemSchema.array(),
  nextCursor: "string|null",
  done: "boolean",
});
export type ApiV1PackageValidationReportPage =
  (typeof ApiV1PackageValidationReportPageSchema)[inferred];

export const ApiV1PackageSearchResponseSchema = type({
  results: type({
    score: "number",
    package: PackageListItemSchema,
  }).array(),
});
export type ApiV1PackageSearchResponse = (typeof ApiV1PackageSearchResponseSchema)[inferred];

export const ApiV1PackageResponseSchema = type({
  package: type({
    name: "string",
    displayName: "string",
    family: PackageFamilySchema,
    runtimeId: "string|null?",
    channel: PackageChannelSchema,
    isOfficial: "boolean",
    summary: "string|null?",
    icon: "string|null?",
    ownerHandle: "string|null?",
    createdAt: "number",
    updatedAt: "number",
    latestVersion: "string|null?",
    categories: "string[]?",
    topics: "string[]?",
    tags: "unknown",
    compatibility: PackageCompatibilitySchema.or("null").optional(),
    pluginManifestSummary: PluginManifestSummarySchema.or("null").optional(),
    clawManifestSummary: ClawManifestSummarySchema.or("null").optional(),
    verification: PackageVerificationSummarySchema.or("null").optional(),
    artifact: PackageArtifactSummarySchema.or("null").optional(),
    scanStatus: '"clean"|"suspicious"|"malicious"|"pending"|"not-run"?',
    stats: PackageStatsSchema.optional(),
  }).or("null"),
  owner: type({
    handle: "string|null",
    displayName: "string|null?",
    image: "string|null?",
  }).or("null"),
});
export type ApiV1PackageResponse = (typeof ApiV1PackageResponseSchema)[inferred];

export const ApiV1PackageVersionListResponseSchema = type({
  items: type({
    version: "string",
    createdAt: "number",
    changelog: "string",
    distTags: "string[]?",
  }).array(),
  nextCursor: "string|null",
});
export type ApiV1PackageVersionListResponse =
  (typeof ApiV1PackageVersionListResponseSchema)[inferred];

export const ApiV1PackageVersionResponseSchema = type({
  package: type({
    name: "string",
    displayName: "string",
    family: PackageFamilySchema,
  }).or("null"),
  version: type({
    version: "string",
    createdAt: "number",
    changelog: "string",
    distTags: "string[]?",
    files: "unknown",
    compatibility: PackageCompatibilitySchema.or("null").optional(),
    pluginManifestSummary: PluginManifestSummarySchema.or("null").optional(),
    clawManifestSummary: ClawManifestSummarySchema.or("null").optional(),
    verification: PackageVerificationSummarySchema.or("null").optional(),
    artifact: PackageArtifactSummarySchema.or("null").optional(),
    // Deprecated compatibility hash for exact /download ZIP bytes; use artifact.sha256 for installs.
    sha256hash: "string|null?",
    vtAnalysis: PackageVtAnalysisSchema.or("null").optional(),
    skillSpectorAnalysis: PackageSkillSpectorAnalysisSchema.or("null").optional(),
    aigAnalysis: PackageAigAnalysisSchema.or("null").optional(),
    llmAnalysis: PackageLlmAnalysisSchema.or("null").optional(),
    staticScan: PackageStaticScanSchema.or("null").optional(),
  }).or("null"),
});
export type ApiV1PackageVersionResponse = (typeof ApiV1PackageVersionResponseSchema)[inferred];

export const ApiV1PackageArtifactResponseSchema = type({
  package: type({
    name: "string",
    displayName: "string",
    family: PackageFamilySchema,
  }),
  version: "string",
  artifact: type({
    kind: PackageArtifactKindSchema,
    sha256: "string?",
    size: "number?",
    format: "string?",
    npmIntegrity: "string?",
    npmShasum: "string?",
    npmTarballName: "string?",
    npmUnpackedSize: "number?",
    npmFileCount: "number?",
    downloadUrl: "string",
    tarballUrl: "string?",
    legacyDownloadUrl: "string?",
    source: '"clawhub"?',
    artifactKind: PackageArtifactKindSchema.optional(),
    artifactSha256: "string?",
    packageName: "string?",
    version: "string?",
  }),
});
export type ApiV1PackageArtifactResponse = (typeof ApiV1PackageArtifactResponseSchema)[inferred];

export const ApiV1PackageSecurityResponseSchema = type({
  overview: "string",
  securityAuditUrl: "string",
  package: type({
    name: "string",
    displayName: "string",
    family: PackageFamilySchema,
  }),
  release: type({
    releaseId: "string",
    version: "string",
    artifactKind: PackageArtifactKindSchema.or("null").optional(),
    artifactSha256: "string?",
    npmIntegrity: "string?",
    npmShasum: "string?",
    npmTarballName: "string?",
    createdAt: "number",
  }),
  trust: type({
    scanStatus: '"clean"|"suspicious"|"malicious"|"pending"|"not-run"',
    moderationState: PackageReleaseModerationStateSchema.or("null").optional(),
    blockedFromDownload: "boolean",
    reasons: "string[]",
    pending: "boolean",
    stale: "boolean",
  }),
});
export type ApiV1PackageSecurityResponse = (typeof ApiV1PackageSecurityResponseSchema)[inferred];

export const PackageReleaseModerationRequestSchema = type({
  state: PackageReleaseModerationStateSchema,
  reason: "string",
});
export type PackageReleaseModerationRequest =
  (typeof PackageReleaseModerationRequestSchema)[inferred];

export const PackageReportRequestSchema = type({
  reason: "string",
  version: "string?",
});
export type PackageReportRequest = (typeof PackageReportRequestSchema)[inferred];

export const ApiV1PackageReportResponseSchema = type({
  ok: "true",
  reported: "boolean",
  alreadyReported: "boolean",
  packageId: "string",
  releaseId: "string|null",
  reportCount: "number",
});
export type ApiV1PackageReportResponse = (typeof ApiV1PackageReportResponseSchema)[inferred];

export const PackageReportTriageRequestSchema = type({
  status: PackageReportStatusSchema,
  note: "string?",
  finalAction: PackageReportFinalActionSchema.optional(),
});
export type PackageReportTriageRequest = (typeof PackageReportTriageRequestSchema)[inferred];

export const PackageAppealRequestSchema = type({
  version: "string",
  message: "string",
});
export type PackageAppealRequest = (typeof PackageAppealRequestSchema)[inferred];

export const ApiV1PackageAppealResponseSchema = type({
  ok: "true",
  submitted: "boolean",
  alreadyOpen: "boolean",
  appealId: "string",
  packageId: "string",
  releaseId: "string",
  status: PackageAppealStatusSchema,
});
export type ApiV1PackageAppealResponse = (typeof ApiV1PackageAppealResponseSchema)[inferred];

export const PackageAppealResolveRequestSchema = type({
  status: PackageAppealStatusSchema,
  note: "string?",
  finalAction: PackageAppealFinalActionSchema.optional(),
});
export type PackageAppealResolveRequest = (typeof PackageAppealResolveRequestSchema)[inferred];

export const ApiV1PackageAppealListResponseSchema = type({
  items: type({
    appealId: "string",
    packageId: "string",
    releaseId: "string",
    name: "string",
    displayName: "string",
    family: PackageFamilySchema,
    version: "string",
    message: "string",
    status: PackageAppealStatusSchema,
    createdAt: "number",
    submitter: type({
      userId: "string",
      handle: "string|null?",
      displayName: "string|null?",
    }),
    resolvedAt: "number|null?",
    resolvedBy: "string|null?",
    resolutionNote: "string|null?",
    actionTaken: PackageAppealFinalActionSchema.or("null").optional(),
  }).array(),
  nextCursor: "string|null",
  done: "boolean",
});
export type ApiV1PackageAppealListResponse =
  (typeof ApiV1PackageAppealListResponseSchema)[inferred];

export const ApiV1PackageAppealResolveResponseSchema = type({
  ok: "true",
  appealId: "string",
  packageId: "string",
  releaseId: "string",
  status: PackageAppealStatusSchema,
  actionTaken: PackageAppealFinalActionSchema.optional(),
});
export type ApiV1PackageAppealResolveResponse =
  (typeof ApiV1PackageAppealResolveResponseSchema)[inferred];

export const ApiV1PackageReportListResponseSchema = type({
  items: type({
    reportId: "string",
    packageId: "string",
    releaseId: "string|null?",
    name: "string",
    displayName: "string",
    family: PackageFamilySchema,
    version: "string|null?",
    reason: "string|null?",
    status: PackageReportStatusSchema,
    createdAt: "number",
    reporter: type({
      userId: "string",
      handle: "string|null?",
      displayName: "string|null?",
    }),
    triagedAt: "number|null?",
    triagedBy: "string|null?",
    triageNote: "string|null?",
    actionTaken: PackageReportFinalActionSchema.or("null").optional(),
  }).array(),
  nextCursor: "string|null",
  done: "boolean",
});
export type ApiV1PackageReportListResponse =
  (typeof ApiV1PackageReportListResponseSchema)[inferred];

export const ApiV1PackageReportTriageResponseSchema = type({
  ok: "true",
  reportId: "string",
  packageId: "string",
  status: PackageReportStatusSchema,
  reportCount: "number",
  actionTaken: PackageReportFinalActionSchema.optional(),
});
export type ApiV1PackageReportTriageResponse =
  (typeof ApiV1PackageReportTriageResponseSchema)[inferred];

export const ApiV1PackageModerationStatusResponseSchema = type({
  package: type({
    packageId: "string",
    name: "string",
    displayName: "string",
    family: PackageFamilySchema,
    channel: PackageChannelSchema,
    isOfficial: "boolean",
    reportCount: "number",
    lastReportedAt: "number|null?",
    scanStatus: '"clean"|"suspicious"|"malicious"|"pending"|"not-run"?',
  }),
  latestRelease: type({
    releaseId: "string",
    version: "string",
    artifactKind: PackageArtifactKindSchema.or("null").optional(),
    scanStatus: '"clean"|"suspicious"|"malicious"|"pending"|"not-run"',
    moderationState: PackageReleaseModerationStateSchema.or("null").optional(),
    moderationReason: "string|null?",
    blockedFromDownload: "boolean",
    reasons: "string[]",
    createdAt: "number",
  }).or("null"),
});
export type ApiV1PackageModerationStatusResponse =
  (typeof ApiV1PackageModerationStatusResponseSchema)[inferred];

export const PackageReadinessCheckSchema = type({
  id: "string",
  label: "string",
  status: '"pass"|"warn"|"fail"',
  message: "string",
});
export type PackageReadinessCheck = (typeof PackageReadinessCheckSchema)[inferred];

export const ApiV1PackageReadinessResponseSchema = type({
  package: type({
    name: "string",
    displayName: "string",
    family: PackageFamilySchema,
    isOfficial: "boolean",
    latestVersion: "string|null?",
  }),
  ready: "boolean",
  checks: PackageReadinessCheckSchema.array(),
  blockers: "string[]",
});
export type ApiV1PackageReadinessResponse = (typeof ApiV1PackageReadinessResponseSchema)[inferred];

export const PackageTransferRequestSchema = type({
  toOwner: "string",
  reason: "string?",
});
export type PackageTransferRequest = (typeof PackageTransferRequestSchema)[inferred];

export const ApiV1PackageTransferResponseSchema = type({
  ok: "true",
  packageId: "string",
  name: "string",
  ownerUserId: "string",
  ownerPublisherId: "string?",
  channel: PackageChannelSchema,
  isOfficial: "boolean",
});
export type ApiV1PackageTransferResponse = (typeof ApiV1PackageTransferResponseSchema)[inferred];

export const PackageHardDeleteRequestSchema = type({
  ownerHandle: "string",
  reason: "string",
  dryRun: "boolean?",
  confirmationToken: "string?",
});
export type PackageHardDeleteRequest = (typeof PackageHardDeleteRequestSchema)[inferred];

export const ApiV1PackageHardDeleteResponseSchema = type({
  ok: "true",
  packageId: "string",
  name: "string",
  ownerHandle: "string",
  displayName: "string",
  runtimeId: "string|null?",
  dryRun: "boolean",
  deleted: "boolean",
  confirmationToken: "string",
});
export type ApiV1PackageHardDeleteResponse =
  (typeof ApiV1PackageHardDeleteResponseSchema)[inferred];

export const PackageRepairNameRequestSchema = type({
  nextName: "string",
  retireTarget: "boolean?",
  owner: "string?",
  reason: "string",
  dryRun: "boolean?",
});
export type PackageRepairNameRequest = (typeof PackageRepairNameRequestSchema)[inferred];

export const PackageRepairNamePackageSchema = type({
  packageId: "string",
  name: "string",
  runtimeId: "string|null?",
  ownerUserId: "string",
  ownerPublisherId: "string|null?",
  channel: PackageChannelSchema,
  softDeletedAt: "number|null?",
});
export type PackageRepairNamePackage = (typeof PackageRepairNamePackageSchema)[inferred];

export const PackageRepairNameOperationSchema = type({
  action: '"retire-target"|"rename-source"|"transfer-owner"',
  packageId: "string?",
  from: "string?",
  to: "string?",
  owner: "string?",
});
export type PackageRepairNameOperation = (typeof PackageRepairNameOperationSchema)[inferred];

export const ApiV1PackageRepairNameResponseSchema = type({
  ok: "true",
  dryRun: "boolean",
  source: PackageRepairNamePackageSchema,
  target: PackageRepairNamePackageSchema.or("null"),
  retiredName: "string|null?",
  operations: PackageRepairNameOperationSchema.array(),
});
export type ApiV1PackageRepairNameResponse =
  (typeof ApiV1PackageRepairNameResponseSchema)[inferred];

export const PackageRepairRuntimeIdRequestSchema = type({
  nextRuntimeId: "string",
  reason: "string",
  dryRun: "boolean?",
});
export type PackageRepairRuntimeIdRequest = (typeof PackageRepairRuntimeIdRequestSchema)[inferred];

export const PackageRepairRuntimeIdOperationSchema = type({
  action: '"repair-runtime-id"',
  packageId: "string?",
  from: "string|null?",
  to: "string?",
});
export type PackageRepairRuntimeIdOperation =
  (typeof PackageRepairRuntimeIdOperationSchema)[inferred];

export const ApiV1PackageRepairRuntimeIdResponseSchema = type({
  ok: "true",
  dryRun: "boolean",
  source: PackageRepairNamePackageSchema,
  operations: PackageRepairRuntimeIdOperationSchema.array(),
});
export type ApiV1PackageRepairRuntimeIdResponse =
  (typeof ApiV1PackageRepairRuntimeIdResponseSchema)[inferred];

export const PackageOfficialMigrationUpsertRequestSchema = type({
  bundledPluginId: "string",
  packageName: "string",
  owner: "string?",
  sourceRepo: "string?",
  sourcePath: "string?",
  sourceCommit: "string?",
  phase: PackageOfficialMigrationPhaseSchema.optional(),
  blockers: "string[]?",
  hostTargetsComplete: "boolean?",
  scanClean: "boolean?",
  moderationApproved: "boolean?",
  runtimeBundlesReady: "boolean?",
  notes: "string?",
});
export type PackageOfficialMigrationUpsertRequest =
  (typeof PackageOfficialMigrationUpsertRequestSchema)[inferred];

export const PackageOfficialMigrationItemSchema = type({
  migrationId: "string",
  bundledPluginId: "string",
  packageName: "string",
  packageId: "string|null?",
  owner: "string|null?",
  sourceRepo: "string|null?",
  sourcePath: "string|null?",
  sourceCommit: "string|null?",
  phase: PackageOfficialMigrationPhaseSchema,
  blockers: "string[]",
  hostTargetsComplete: "boolean",
  scanClean: "boolean",
  moderationApproved: "boolean",
  runtimeBundlesReady: "boolean",
  notes: "string|null?",
  createdAt: "number",
  updatedAt: "number",
});
export type PackageOfficialMigrationItem = (typeof PackageOfficialMigrationItemSchema)[inferred];

export const ApiV1PackageOfficialMigrationListResponseSchema = type({
  items: PackageOfficialMigrationItemSchema.array(),
  nextCursor: "string|null",
  done: "boolean",
});
export type ApiV1PackageOfficialMigrationListResponse =
  (typeof ApiV1PackageOfficialMigrationListResponseSchema)[inferred];

export const ApiV1PackageOfficialMigrationResponseSchema = type({
  ok: "true",
  migration: PackageOfficialMigrationItemSchema,
});
export type ApiV1PackageOfficialMigrationResponse =
  (typeof ApiV1PackageOfficialMigrationResponseSchema)[inferred];

export const PackageModerationQueueStatusSchema = type('"open"|"blocked"|"manual"|"all"');
export type PackageModerationQueueStatus = (typeof PackageModerationQueueStatusSchema)[inferred];

export const ApiV1PackageModerationQueueResponseSchema = type({
  items: type({
    packageId: "string",
    releaseId: "string",
    name: "string",
    displayName: "string",
    family: PackageFamilySchema,
    channel: PackageChannelSchema,
    isOfficial: "boolean",
    version: "string",
    createdAt: "number",
    artifactKind: PackageArtifactKindSchema.or("null").optional(),
    scanStatus: '"clean"|"suspicious"|"malicious"|"pending"|"not-run"',
    moderationState: PackageReleaseModerationStateSchema.or("null").optional(),
    moderationReason: "string|null?",
    sourceRepo: "string|null?",
    sourceCommit: "string|null?",
    reportCount: "number",
    lastReportedAt: "number|null?",
    reasons: "string[]",
  }).array(),
  nextCursor: "string|null",
  done: "boolean",
});
export type ApiV1PackageModerationQueueResponse =
  (typeof ApiV1PackageModerationQueueResponseSchema)[inferred];

export const ApiV1PackageReleaseModerationResponseSchema = type({
  ok: "true",
  packageId: "string",
  releaseId: "string",
  state: PackageReleaseModerationStateSchema,
  scanStatus: '"clean"|"malicious"',
});
export type ApiV1PackageReleaseModerationResponse =
  (typeof ApiV1PackageReleaseModerationResponseSchema)[inferred];

export const ApiV1PackagePublishResponseSchema = type({
  ok: "true",
  packageId: "string",
  releaseId: "string",
  artifactSha256: "string?",
  publicationStatus: '"pending"|"published"?',
  attemptId: "string?",
  inspectorFindings: type({
    findingKind: '"warning"|"error"',
    code: "string",
    severity: "string?",
    level: "string?",
    issueClass: "string?",
    message: "string",
    authorRemediation: type({
      summary: "string",
      docsUrl: "string?",
    }).optional(),
    inspectorVersion: "string?",
    targetOpenClawVersion: "string?",
  })
    .array()
    .optional(),
});
export type ApiV1PackagePublishResponse = (typeof ApiV1PackagePublishResponseSchema)[inferred];

export const PackagePublishAttemptStatusSchema = type(
  '"pending_checks"|"ready_to_finalize"|"finalizing"|"finalized"|"blocked"|"failed"|"expired"',
);
export type PackagePublishAttemptStatus = (typeof PackagePublishAttemptStatusSchema)[inferred];

export const PackagePublicationStatusSchema = type(
  '"pending"|"published"|"blocked"|"failed"|"expired"',
);
export type PackagePublicationStatus = (typeof PackagePublicationStatusSchema)[inferred];

export const ApiV1PackagePublishRecoveryRequestSchema = type({
  manualOverrideReason: "string",
});
export type ApiV1PackagePublishRecoveryRequest =
  (typeof ApiV1PackagePublishRecoveryRequestSchema)[inferred];

export const ApiV1PackagePublishRecoveryResponseSchema = type({
  ok: "true",
  attemptId: "string",
  recoveredFromAttemptId: "string",
  packageId: "string",
  releaseId: "string",
  name: "string",
  version: "string",
  status: PackagePublishAttemptStatusSchema,
  publicationStatus: PackagePublicationStatusSchema,
  reused: "boolean",
});
export type ApiV1PackagePublishRecoveryResponse =
  (typeof ApiV1PackagePublishRecoveryResponseSchema)[inferred];

export const PackagePublishAttemptCheckSchema = type({
  status: '"pending"|"clean"|"blocked"|"failed"',
  summary: "string?",
});
export type PackagePublishAttemptCheck = (typeof PackagePublishAttemptCheckSchema)[inferred];

export const ApiV1PackagePublishAttemptResponseSchema = type({
  attemptId: "string",
  packageId: "string",
  releaseId: "string",
  artifactSha256: "string?",
  name: "string",
  version: "string",
  status: PackagePublishAttemptStatusSchema,
  publicationStatus: PackagePublicationStatusSchema,
  terminal: "boolean",
  checks: {
    trufflehog: PackagePublishAttemptCheckSchema,
    clawscan: PackagePublishAttemptCheckSchema,
  },
  error: "string?",
});
export type ApiV1PackagePublishAttemptResponse =
  (typeof ApiV1PackagePublishAttemptResponseSchema)[inferred];

export const PackageTrustedPublisherUpsertRequestSchema = type({
  repository: "string",
  workflowFilename: "string",
  environment: "string?",
});
export type PackageTrustedPublisherUpsertRequest =
  (typeof PackageTrustedPublisherUpsertRequestSchema)[inferred];

export const ApiV1PackageTrustedPublisherResponseSchema = type({
  trustedPublisher: PackageTrustedPublisherSchema.or("null"),
});
export type ApiV1PackageTrustedPublisherResponse =
  (typeof ApiV1PackageTrustedPublisherResponseSchema)[inferred];

export const PublishTokenMintRequestSchema = type({
  packageName: "string",
  version: "string",
  githubOidcToken: "string",
  scope: '("upload" | "publish")?',
  inventoryDigest: "string?",
  trustedToolingIdentityJson: "string?",
});
export type PublishTokenMintRequest = (typeof PublishTokenMintRequestSchema)[inferred];

export const ApiV1PublishTokenMintResponseSchema = type({
  token: "string",
  expiresAt: "number",
});
export type ApiV1PublishTokenMintResponse = (typeof ApiV1PublishTokenMintResponseSchema)[inferred];
