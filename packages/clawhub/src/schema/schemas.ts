import { type inferred, type } from "arktype";

export const GlobalConfigSchema = type({
  registry: "string",
  token: "string?",
});
export type GlobalConfig = (typeof GlobalConfigSchema)[inferred];

export const WellKnownConfigSchema = type({
  apiBase: "string",
  authBase: "string?",
  minCliVersion: "string?",
}).or({
  registry: "string",
  authBase: "string?",
  minCliVersion: "string?",
});
export type WellKnownConfig = (typeof WellKnownConfigSchema)[inferred];

export const LockfileSchema = type({
  version: "1",
  skills: {
    "[string]": {
      version: "string|null",
      installedAt: "number",
      ownerHandle: "string?",
      sourceRef: "string?",
      sourceKind: '"skills-sh"?',
      sourceRepository: "string?",
      sourcePath: "string?",
      sourceUrl: "string?",
      canonicalRef: "string?",
      clawhubScan: '"unscanned"|"scanned"?',
      trustLabel: "string?",
      pinned: "boolean?",
      pinReason: "string?",
    },
  },
});
export type Lockfile = (typeof LockfileSchema)[inferred];

export const ApiCliWhoamiResponseSchema = type({
  user: {
    handle: "string|null",
  },
});

export const ApiSearchResponseSchema = type({
  results: type({
    slug: "string?",
    ownerHandle: "string|null?",
    displayName: "string?",
    version: "string|null?",
    score: "number",
  }).array(),
});

export const ApiSkillMetaResponseSchema = type({
  latestVersion: type({
    version: "string",
  }).optional(),
  skill: "unknown|null?",
});

export const ApiCliUploadUrlResponseSchema = type({
  uploadUrl: "string",
  uploadTicket: "string",
});

export const ApiUploadFileResponseSchema = type({
  storageId: "string",
});

export const ApiV1SkillUploadUrlRequestSchema = type({
  path: "string",
  size: "number",
  sha256: "string",
  contentType: "string?",
});

export const ApiV1SkillUploadUrlResponseSchema = type({
  uploadUrl: "string",
  uploadTicket: "string",
});

export const CliPublishFileSchema = type({
  path: "string",
  size: "number",
  storageId: "string",
  sha256: "string",
  contentType: "string?",
  uploadTicket: "string?",
});
export type CliPublishFile = (typeof CliPublishFileSchema)[inferred];

export const PublishSourceSchema = type({
  kind: '"github"',
  url: "string",
  repo: "string",
  ref: "string",
  commit: "string",
  path: "string",
  importedAt: "number",
});

export const CliPublishRequestSchema = type({
  slug: "string",
  displayName: "string",
  ownerHandle: "string?",
  sourceOwnerHandle: "string?",
  migrateOwner: "boolean?",
  version: "string",
  changelog: "string",
  acceptLicenseTerms: "boolean?",
  tags: "string[]?",
  categories: "string[]?",
  topics: "string[]?",
  source: PublishSourceSchema.optional(),
  forkOf: type({
    slug: "string",
    ownerHandle: "string?",
    version: "string?",
  }).optional(),
  files: CliPublishFileSchema.array(),
});
export type CliPublishRequest = (typeof CliPublishRequestSchema)[inferred];

export const ApiCliPublishResponseSchema = type({
  ok: "true",
  skillId: "string",
  versionId: "string",
  status: '"pending"|"published"?',
  slug: "string?",
  version: "string?",
  publicationStatus: '"pending"|"published"?',
  attemptId: "string?",
});

export const CliSkillDeleteRequestSchema = type({
  slug: "string",
  reason: "string?",
});
export type CliSkillDeleteRequest = (typeof CliSkillDeleteRequestSchema)[inferred];

export const ApiCliSkillDeleteResponseSchema = type({
  ok: "true",
  slugReservedUntil: "number?",
});

export const ApiSkillResolveResponseSchema = type({
  match: type({ version: "string" }).or("null"),
  latestVersion: type({ version: "string" }).or("null"),
});

export const ApiV1SkillInstallResolveResponseSchema = type({
  ok: "true",
  slug: "string",
  installKind: '"archive"',
  archive: {
    version: "string",
    downloadUrl: "string",
  },
})
  .or({
    ok: "true",
    slug: "string",
    installKind: '"github"',
    github: {
      repo: "string",
      path: "string",
      commit: "string",
      contentHash: "string",
      sourceUrl: "string",
    },
  })
  .or({
    ok: "false",
    slug: "string",
    reason:
      '"archive_version_missing"|"github_source_missing"|"github_upstream_removed"|"github_upstream_missing"|"github_upstream_unknown"|"github_verification_pending"|"github_scan_failed"',
    message: "string",
    status: "number",
  });
export type ApiV1SkillInstallResolveResponse =
  (typeof ApiV1SkillInstallResolveResponseSchema)[inferred];

export const ApiV1SkillsShCatalogEntrySchema = type({
  ref: "string",
  route: "string",
  displayName: "string",
  summary: "string",
  owner: {
    handle: "string",
    githubUrl: "string",
  },
  repository: "string",
  githubPath: "string",
  githubCommit: "string",
  githubContentHash: "string",
  sourceUrl: "string",
  installs: "number",
  security: {
    verdict: '"clean"|"suspicious"',
    source: '"clawhub"',
    attemptId: "string",
    scannedAt: "number",
  },
  install: {
    ok: "true",
    slug: "string",
    installKind: '"github"',
    github: {
      repo: "string",
      path: "string",
      commit: "string",
      contentHash: "string",
      sourceUrl: "string",
    },
  },
});
export type ApiV1SkillsShCatalogEntry = (typeof ApiV1SkillsShCatalogEntrySchema)[inferred];

export const CliTelemetryInstallRequestSchema = type({
  event: '"install"',
  slug: "string",
  ownerHandle: "string?",
  sourceRef: "string?",
  sourceKind: '"skills-sh"?',
  sourceRepository: "string?",
  sourcePath: "string?",
  sourceUrl: "string?",
  canonicalRef: "string?",
  clawhubScan: '"unscanned"|"scanned"?',
  trustLabel: "string?",
  version: "string?",
  // Deprecated compatibility fields accepted and ignored by the backend.
  rootId: "string?",
  rootLabel: "string?",
})
  .or({
    event: '"plugin_install"',
    packageName: "string",
    version: "string?",
  })
  .or({
    // Legacy bulk snapshots remain accepted while older CLIs are in circulation.
    roots: type({
      rootId: "string",
      label: "string",
      skills: type({
        slug: "string",
        version: "string|null?",
      }).array(),
    }).array(),
  });
export type CliTelemetryInstallRequest = (typeof CliTelemetryInstallRequestSchema)[inferred];

export const ApiCliTelemetryInstallResponseSchema = type({
  ok: "true",
});

export const ApiV1WhoamiResponseSchema = type({
  user: {
    handle: "string|null",
    displayName: "string|null?",
    image: "string|null?",
    role: '"admin"|"moderator"|"user"|null?',
  },
});

export const ApiV1UserSearchResponseSchema = type({
  items: type({
    userId: "string",
    handle: "string|null",
    displayName: "string|null?",
    name: "string|null?",
    role: '"admin"|"moderator"|"user"|null?',
  }).array(),
  total: "number",
});

export const ApiV1PublisherCreateResponseSchema = type({
  ok: "true",
  publisherId: "string",
  handle: "string",
  created: "true",
  trusted: "false",
});
export type ApiV1PublisherCreateResponse = (typeof ApiV1PublisherCreateResponseSchema)[inferred];

export const ApiV1PublisherEnsureResponseSchema = type({
  ok: "true",
  publisherId: "string",
  handle: "string",
  created: "boolean",
  migrated: "boolean",
  trusted: "boolean",
  "member?": type({
    userId: "string",
    handle: "string",
    role: '"owner"|"admin"|"publisher"',
  }),
});
export type ApiV1PublisherEnsureResponse = (typeof ApiV1PublisherEnsureResponseSchema)[inferred];

export const ApiV1PublisherRemoveMemberResponseSchema = type({
  ok: "true",
  publisherId: "string",
  handle: "string",
  removed: "boolean",
  member: type({
    userId: "string",
    handle: "string",
    role: '"owner"|"admin"|"publisher"',
  }),
});
export type ApiV1PublisherRemoveMemberResponse =
  (typeof ApiV1PublisherRemoveMemberResponseSchema)[inferred];

export const ApiV1PublisherProfileUpdateResponseSchema = type({
  ok: "true",
  publisherId: "string",
  handle: "string",
  bio: "string|null",
  image: "string|null",
  bioUpdated: "boolean",
  logoUpdated: "boolean",
});
export type ApiV1PublisherProfileUpdateResponse =
  (typeof ApiV1PublisherProfileUpdateResponseSchema)[inferred];

export const ApiV1PublisherDeleteResponseSchema = type({
  ok: "true",
  publisherId: "string",
  handle: "string",
  dryRun: "boolean",
  deleted: "boolean",
  activeSkills: "number",
  activePackages: "number",
  memberCount: "number",
});
export type ApiV1PublisherDeleteResponse = (typeof ApiV1PublisherDeleteResponseSchema)[inferred];

export const ApiV1PublisherReclaimResponseSchema = type({
  ok: "true",
  publisherId: "string",
  handle: "string",
  dryRun: "boolean",
  hardDeleted: "boolean",
  activeSkills: "number",
  activePackages: "number",
  memberCount: "number",
  githubSources: "number",
  githubSourceContents: "number",
  officialPublisher: "boolean",
  confirmationToken: "string",
});
export type ApiV1PublisherReclaimResponse = (typeof ApiV1PublisherReclaimResponseSchema)[inferred];

export const ApiV1PublisherRecoveryResponseSchema = type({
  ok: "true",
  dryRun: "boolean",
  recovered: "boolean",
  publisherId: "string",
  handle: "string",
  previousUser: {
    userId: "string",
    handle: "string|null",
    nextHandle: "string|null",
    githubProviderAccountId: "string",
    authAccountCount: "number",
  },
  nextUser: {
    userId: "string",
    handle: "string|null",
    nextHandle: "string",
    githubProviderAccountId: "string",
    authAccountCount: "number",
  },
  retiredPersonalPublisher: type({
    publisherId: "string",
    handle: "string",
    skills: "number",
    packages: "number",
    githubSources: "number",
  }).or("null"),
  resourceOwnerMigration: {
    limitPerTable: "number",
    skills: "number",
    skillSlugAliases: "number",
    packages: "number",
    packageInspectorWarnings: "number",
    githubSourcesChecked: "number",
    handleReservations: "number",
  },
  identityVerified: "boolean",
  reason: "string",
});
export type ApiV1PublisherRecoveryResponse =
  (typeof ApiV1PublisherRecoveryResponseSchema)[inferred];

export const ApiV1OfficialPublisherListResponseSchema = type({
  ok: "true",
  items: type({
    officialPublisherId: "string",
    publisherId: "string",
    handle: "string|null",
    displayName: "string|null",
    kind: '"user"|"org"|null',
    active: "boolean",
    reason: "string|null",
    createdByUserId: "string|null",
    createdByHandle: "string|null",
    createdAt: "number",
    updatedAt: "number",
  }).array(),
});
export type ApiV1OfficialPublisherListResponse =
  (typeof ApiV1OfficialPublisherListResponseSchema)[inferred];

export const ApiV1OfficialPublisherUpdateResponseSchema = type({
  ok: "true",
  publisherId: "string",
  handle: "string",
  "added?": "boolean",
  "removed?": "boolean",
  "officialPublisherId?": "string",
});
export type ApiV1OfficialPublisherUpdateResponse =
  (typeof ApiV1OfficialPublisherUpdateResponseSchema)[inferred];

export const ApiV1StaffEmailSendResponseSchema = type({
  ok: "true",
  sent: "true",
  recipient: type({
    email: "string",
    "userId?": "string",
    "handle?": "string|null",
  }),
  subject: "string",
  template: "string",
  providerId: "string|null",
});
export type ApiV1StaffEmailSendResponse = (typeof ApiV1StaffEmailSendResponseSchema)[inferred];

export const ApiV1SearchResponseSchema = type({
  results: type({
    "id?": "string",
    "source?": '"clawhub"|"skills-sh"',
    slug: "string?",
    ownerHandle: "string|null?",
    displayName: "string?",
    summary: "string|null?",
    version: "string|null?",
    score: "number",
    downloads: "number?",
    updatedAt: "number?",
    owner: type({
      handle: "string|null?",
      displayName: "string|null?",
      image: "string|null?",
      "kind?": '"user"|"org"',
      "official?": "boolean",
    })
      .or("null")
      .optional(),
    "canonicalUrl?": "string",
    "official?": "boolean",
    "featured?": "boolean",
    "links?": {
      canonical: "string",
      source: "string|null",
    },
    "publisher?": type({
      kind: '"user"|"org"',
      handle: "string|null",
      displayName: "string|null",
      image: "string|null",
      official: "boolean",
    }).or("null"),
    "install?": {
      kind: '"clawhub"|"github"|"skills-sh"',
      reference: "string",
      sourceUrl: "string|null",
    },
    "sourceIdentity?": {
      id: "string",
      owner: "string|null",
      repo: "string|null",
      host: "string|null",
      lifetimeInstalls: "number|null",
    },
    "trust?": {
      visibility: '"public"',
      installability: '"installable"',
      clawHubVerdict: "string|null",
      upstreamScanners: "unknown|null",
      sourceFreshness: '"native"|"observed-only"',
    },
    "metrics?": {
      rolling60DayInstalls: "number|null",
      bookmarks: "number|null",
      updatedAt: "number",
    },
  }).array(),
});

export const ApiV1SkillListResponseSchema = type({
  items: type({
    ownerHandle: "string?",
    slug: "string",
    displayName: "string",
    summary: "string|null?",
    description: "string|null?",
    topics: "string[]?",
    tags: "unknown",
    stats: "unknown",
    createdAt: "number",
    updatedAt: "number",
    latestVersion: type({
      version: "string",
      createdAt: "number",
      changelog: "string",
      license: '"MIT-0"|null?',
    })
      .or("null")
      .optional(),
    metadata: type({
      setup: type({
        key: "string",
        required: "boolean",
      }).array(),
      os: "string[]|null?",
      systems: "string[]|null?",
    })
      .or("null")
      .optional(),
  }).array(),
  nextCursor: "string|null",
});

export const ApiV1SkillResponseSchema = type({
  skill: type({
    slug: "string",
    displayName: "string",
    summary: "string|null?",
    description: "string|null?",
    topics: "string[]?",
    tags: "unknown",
    stats: "unknown",
    createdAt: "number",
    updatedAt: "number",
  }).or("null"),
  latestVersion: type({
    version: "string",
    createdAt: "number",
    changelog: "string",
    license: '"MIT-0"|null?',
  }).or("null"),
  metadata: type({
    setup: type({
      key: "string",
      required: "boolean",
    }).array(),
    os: "string[]|null?",
    systems: "string[]|null?",
  })
    .or("null")
    .optional(),
  owner: type({
    handle: "string|null",
    displayName: "string|null?",
    image: "string|null?",
  }).or("null"),
  moderation: type({
    isSuspicious: "boolean",
    isMalwareBlocked: "boolean",
    verdict: '"clean"|"suspicious"|"malicious"?',
    reasonCodes: "string[]?",
    updatedAt: "number|null?",
    engineVersion: "string|null?",
    summary: "string|null?",
  })
    .or("null")
    .optional(),
});

export const ApiV1SkillModerationResponseSchema = type({
  moderation: type({
    isSuspicious: "boolean",
    isMalwareBlocked: "boolean",
    verdict: '"clean"|"suspicious"|"malicious"',
    reasonCodes: "string[]",
    updatedAt: "number|null?",
    engineVersion: "string|null?",
    summary: "string|null?",
    legacyReason: "string|null?",
    evidence: type({
      code: "string",
      severity: '"info"|"warn"|"critical"',
      file: "string",
      line: "number",
      message: "string",
      evidence: "string",
    }).array(),
  }).or("null"),
});

export const SkillVersionRevokeRequestSchema = type({
  state: '"revoked"',
  reason: "string",
  ownerHandle: "string?",
});
export type SkillVersionRevokeRequest = (typeof SkillVersionRevokeRequestSchema)[inferred];

export const ApiV1SkillVersionRevokeResponseSchema = type({
  ok: "true",
  slug: "string",
  version: "string",
  skillId: "string",
  versionId: "string",
  alreadyRevoked: "boolean",
  replacementVersion: "string|null",
  skillHidden: "boolean",
});
export type ApiV1SkillVersionRevokeResponse =
  (typeof ApiV1SkillVersionRevokeResponseSchema)[inferred];

export const SkillReportStatusSchema = type('"open"|"confirmed"|"dismissed"');
export type SkillReportStatus = (typeof SkillReportStatusSchema)[inferred];
export const SkillReportFinalActionSchema = type('"none"|"hide"');
export type SkillReportFinalAction = (typeof SkillReportFinalActionSchema)[inferred];

export const SkillReportListStatusSchema = SkillReportStatusSchema.or('"all"');
export type SkillReportListStatus = (typeof SkillReportListStatusSchema)[inferred];

export const SkillAppealStatusSchema = type('"open"|"accepted"|"rejected"');
export type SkillAppealStatus = (typeof SkillAppealStatusSchema)[inferred];
export const SkillAppealFinalActionSchema = type('"none"|"restore"');
export type SkillAppealFinalAction = (typeof SkillAppealFinalActionSchema)[inferred];

export const SkillAppealListStatusSchema = SkillAppealStatusSchema.or('"all"');
export type SkillAppealListStatus = (typeof SkillAppealListStatusSchema)[inferred];

export const SkillAppealRequestSchema = type({
  version: "string?",
  message: "string",
});
export type SkillAppealRequest = (typeof SkillAppealRequestSchema)[inferred];

export const ApiV1SkillReportResponseSchema = type({
  ok: "true",
  reported: "boolean",
  alreadyReported: "boolean",
  reportId: "string",
  skillId: "string",
  reportCount: "number",
});
export type ApiV1SkillReportResponse = (typeof ApiV1SkillReportResponseSchema)[inferred];

export const ApiV1SkillAppealResponseSchema = type({
  ok: "true",
  submitted: "boolean",
  alreadyOpen: "boolean",
  appealId: "string",
  skillId: "string",
  status: SkillAppealStatusSchema,
});
export type ApiV1SkillAppealResponse = (typeof ApiV1SkillAppealResponseSchema)[inferred];

export const SkillReportTriageRequestSchema = type({
  status: SkillReportStatusSchema,
  note: "string?",
  finalAction: SkillReportFinalActionSchema.optional(),
});
export type SkillReportTriageRequest = (typeof SkillReportTriageRequestSchema)[inferred];

export const SkillAppealResolveRequestSchema = type({
  status: SkillAppealStatusSchema,
  note: "string?",
  finalAction: SkillAppealFinalActionSchema.optional(),
});
export type SkillAppealResolveRequest = (typeof SkillAppealResolveRequestSchema)[inferred];

export const ApiV1SkillReportListResponseSchema = type({
  items: type({
    reportId: "string",
    skillId: "string",
    skillVersionId: "string|null?",
    slug: "string",
    displayName: "string",
    version: "string|null?",
    reason: "string|null?",
    status: SkillReportStatusSchema,
    createdAt: "number",
    reporter: type({
      userId: "string",
      handle: "string|null?",
      displayName: "string|null?",
    }),
    triagedAt: "number|null?",
    triagedBy: "string|null?",
    triageNote: "string|null?",
    actionTaken: SkillReportFinalActionSchema.or("null").optional(),
  }).array(),
  nextCursor: "string|null",
  done: "boolean",
});
export type ApiV1SkillReportListResponse = (typeof ApiV1SkillReportListResponseSchema)[inferred];

export const ApiV1SkillReportTriageResponseSchema = type({
  ok: "true",
  reportId: "string",
  skillId: "string",
  status: SkillReportStatusSchema,
  reportCount: "number",
  actionTaken: SkillReportFinalActionSchema.optional(),
});
export type ApiV1SkillReportTriageResponse =
  (typeof ApiV1SkillReportTriageResponseSchema)[inferred];

export const ApiV1SkillAppealListResponseSchema = type({
  items: type({
    appealId: "string",
    skillId: "string",
    skillVersionId: "string|null?",
    slug: "string",
    displayName: "string",
    version: "string|null?",
    message: "string",
    status: SkillAppealStatusSchema,
    createdAt: "number",
    submitter: type({
      userId: "string",
      handle: "string|null?",
      displayName: "string|null?",
    }),
    resolvedAt: "number|null?",
    resolvedBy: "string|null?",
    resolutionNote: "string|null?",
    actionTaken: SkillAppealFinalActionSchema.or("null").optional(),
  }).array(),
  nextCursor: "string|null",
  done: "boolean",
});
export type ApiV1SkillAppealListResponse = (typeof ApiV1SkillAppealListResponseSchema)[inferred];

export const ApiV1SkillAppealResolveResponseSchema = type({
  ok: "true",
  appealId: "string",
  skillId: "string",
  status: SkillAppealStatusSchema,
  actionTaken: SkillAppealFinalActionSchema.optional(),
});
export type ApiV1SkillAppealResolveResponse =
  (typeof ApiV1SkillAppealResolveResponseSchema)[inferred];

export const ApiV1SkillRescanResponseSchema = type({
  ok: "true",
  slug: "string",
  version: "string",
  skillId: "string",
  skillVersionId: "string",
  jobId: "string",
  alreadyQueued: "boolean",
}).or({
  ok: "true",
  slug: "string",
  version: "string",
  skillId: "string",
  githubContentHash: "string",
  jobId: "string?",
  scheduled: "boolean",
  alreadyQueued: "boolean",
});
export type ApiV1SkillRescanResponse = (typeof ApiV1SkillRescanResponseSchema)[inferred];

export const ApiV1SkillHardDeleteRequestSchema = type({
  ownerHandle: "string",
  reason: "string",
  dryRun: "boolean?",
  confirmationToken: "string?",
});
export type ApiV1SkillHardDeleteRequest = (typeof ApiV1SkillHardDeleteRequestSchema)[inferred];

export const ApiV1SkillHardDeleteResponseSchema = type({
  ok: "true",
  skillId: "string",
  slug: "string",
  ownerHandle: "string",
  displayName: "string",
  dryRun: "boolean",
  scheduled: "boolean",
  confirmationToken: "string",
});
export type ApiV1SkillHardDeleteResponse = (typeof ApiV1SkillHardDeleteResponseSchema)[inferred];

export const ApiV1SkillScanStatusSchema = type('"queued"|"running"|"succeeded"|"failed"');
export type ApiV1SkillScanStatus = (typeof ApiV1SkillScanStatusSchema)[inferred];

export const ApiV1SkillScanSourceSchema = type({
  kind: '"upload"',
}).or({
  kind: '"published"',
  slug: "string",
  ownerHandle: "string?",
  version: "string?",
});
export type ApiV1SkillScanSource = (typeof ApiV1SkillScanSourceSchema)[inferred];

export const ApiV1SkillScanSubmitRequestSchema = type({
  source: ApiV1SkillScanSourceSchema,
  update: "boolean?",
});
export type ApiV1SkillScanSubmitRequest = (typeof ApiV1SkillScanSubmitRequestSchema)[inferred];

export const ApiV1SkillScanQueueSchema = type({
  queuedAhead: "number",
  queuedAheadIsEstimate: "boolean?",
  position: "number|null",
  running: "number",
  runningIsEstimate: "boolean?",
  note: "string",
});
export type ApiV1SkillScanQueue = (typeof ApiV1SkillScanQueueSchema)[inferred];

export const ApiV1SkillScanSubmitResponseSchema = type({
  ok: "true",
  scanId: "string",
  jobId: "string?",
  status: ApiV1SkillScanStatusSchema,
  sourceKind: '"upload"|"published"',
  update: "boolean",
  alreadyQueued: "boolean?",
  queue: ApiV1SkillScanQueueSchema.optional(),
});
export type ApiV1SkillScanSubmitResponse = (typeof ApiV1SkillScanSubmitResponseSchema)[inferred];

export const ApiV1SkillScanStatusResponseSchema = type({
  ok: "true",
  scanId: "string",
  jobId: "string?",
  status: ApiV1SkillScanStatusSchema,
  sourceKind: '"upload"|"published"',
  update: "boolean",
  writtenBack: "boolean?",
  artifact: "unknown?",
  report: "unknown?",
  queue: ApiV1SkillScanQueueSchema.optional(),
  lastError: "string?",
  createdAt: "number",
  updatedAt: "number",
  completedAt: "number?",
});
export type ApiV1SkillScanStatusResponse = (typeof ApiV1SkillScanStatusResponseSchema)[inferred];

export const ApiV1SkillScanDownloadManifestSchema = type({
  scanId: "string",
  sourceKind: '"upload"|"published"',
  update: "boolean",
  status: ApiV1SkillScanStatusSchema,
  artifact: "unknown?",
  createdAt: "number",
  updatedAt: "number",
  completedAt: "number?",
  writtenBack: "boolean?",
});
export type ApiV1SkillScanDownloadManifest =
  (typeof ApiV1SkillScanDownloadManifestSchema)[inferred];

export const ApiV1SkillBulkRescanBatchRequestSchema = type({
  mode: '"all-active-latest"?',
  cursor: "string|null?",
  batchSize: "number?",
  dryRun: "boolean?",
});
export type ApiV1SkillBulkRescanBatchRequest =
  (typeof ApiV1SkillBulkRescanBatchRequestSchema)[inferred];

export const ApiV1SkillBulkRescanBatchResponseSchema = type({
  ok: "true",
  mode: '"all-active-latest"',
  queued: "number",
  alreadyQueued: "number",
  skipped: "number",
  jobIds: "string[]",
  nextCursor: "string|null",
  done: "boolean",
  sampleSlugs: "string[]",
});
export type ApiV1SkillBulkRescanBatchResponse =
  (typeof ApiV1SkillBulkRescanBatchResponseSchema)[inferred];

export const ApiV1SkillBulkRescanStatusRequestSchema = type({
  jobIds: "string[]",
});
export type ApiV1SkillBulkRescanStatusRequest =
  (typeof ApiV1SkillBulkRescanStatusRequestSchema)[inferred];

export const ApiV1SkillBulkRescanStatusResponseSchema = type({
  ok: "true",
  total: "number",
  queued: "number",
  running: "number",
  succeeded: "number",
  failed: "number",
  missing: "number",
  terminal: "number",
  done: "boolean",
  failedJobIds: "string[]",
});
export type ApiV1SkillBulkRescanStatusResponse =
  (typeof ApiV1SkillBulkRescanStatusResponseSchema)[inferred];

export const ApiV1SkillScanBatchRequestSchema = type({
  mode: '"all-active-latest"?',
  cursor: "string|null?",
  batchSize: "number?",
  dryRun: "boolean?",
});
export type ApiV1SkillScanBatchRequest = (typeof ApiV1SkillScanBatchRequestSchema)[inferred];

export const ApiV1SkillScanBatchResponseSchema = type({
  ok: "true",
  mode: '"all-active-latest"',
  queued: "number",
  alreadyQueued: "number",
  skipped: "number",
  jobIds: "string[]",
  nextCursor: "string|null",
  done: "boolean",
  sampleSlugs: "string[]",
});
export type ApiV1SkillScanBatchResponse = (typeof ApiV1SkillScanBatchResponseSchema)[inferred];

export const ApiV1SkillScanBatchStatusRequestSchema = type({
  jobIds: "string[]",
});
export type ApiV1SkillScanBatchStatusRequest =
  (typeof ApiV1SkillScanBatchStatusRequestSchema)[inferred];

export const ApiV1SkillScanBatchStatusResponseSchema = type({
  ok: "true",
  total: "number",
  queued: "number",
  running: "number",
  succeeded: "number",
  failed: "number",
  missing: "number",
  terminal: "number",
  done: "boolean",
  failedJobIds: "string[]",
});
export type ApiV1SkillScanBatchStatusResponse =
  (typeof ApiV1SkillScanBatchStatusResponseSchema)[inferred];

export const ApiV1SkillRepairVtPendingRequestSchema = type({
  cursor: "string|null?",
  batchSize: "number?",
  concurrency: "number?",
  dryRun: "boolean?",
});
export type ApiV1SkillRepairVtPendingRequest =
  (typeof ApiV1SkillRepairVtPendingRequestSchema)[inferred];

export const ApiV1SkillRepairVtPendingResponseSchema = type({
  ok: "true",
  dryRun: "boolean",
  total: "number",
  wouldUpdate: "number",
  updated: "number",
  noResults: "number",
  noDecisiveStats: "number",
  errors: "number",
  done: "boolean",
  cursor: "string|null",
  statusCounts: { "[string]": "number" },
  sampleUpdated: type({
    slug: "string",
    status: "string",
  }).array(),
});
export type ApiV1SkillRepairVtPendingResponse =
  (typeof ApiV1SkillRepairVtPendingResponseSchema)[inferred];

export const ApiV1SkillVersionListResponseSchema = type({
  items: type({
    version: "string",
    createdAt: "number",
    changelog: "string",
    changelogSource: '"auto"|"user"|null?',
  }).array(),
  nextCursor: "string|null",
});

export const ApiV1SkillVersionResponseSchema = type({
  version: type({
    version: "string",
    createdAt: "number",
    changelog: "string",
    changelogSource: '"auto"|"user"|null?',
    license: '"MIT-0"|null?',
    files: "unknown?",
  }).or("null"),
  skill: type({
    slug: "string",
    displayName: "string",
  }).or("null"),
});

export const ApiV1SkillResolveResponseSchema = type({
  match: type({ version: "string" }).or("null"),
  latestVersion: type({ version: "string" }).or("null"),
});

export const ApiV1SkillVerifyResponseSchema = type({
  schema: '"clawhub.skill.verify.v1"',
  ok: "boolean",
  decision: '"pass"|"fail"',
  reasons: "string[]",
  slug: "string",
  displayName: "string",
  pageUrl: "string",
  publisherHandle: "string|null",
  publisherDisplayName: "string|null",
  publisherProfileUrl: "string|null",
  version: "string",
  resolvedFrom: '"latest"|"version"|"tag"',
  tag: "string|null",
  createdAt: "number",
  card: "unknown",
  artifact: "unknown",
  provenance: "unknown",
  security: "unknown",
  signature: "unknown",
});

export const ApiV1PublishResponseSchema = type({
  ok: "true",
  skillId: "string",
  versionId: "string",
  status: '"pending"|"published"?',
  slug: "string?",
  version: "string?",
  publicationStatus: '"pending"|"published"?',
  attemptId: "string?",
});

export const ApiV1DeleteResponseSchema = type({
  ok: "true",
  slugReservedUntil: "number?",
});

export const ApiV1SkillTagResponseSchema = type({
  ok: "true",
  slug: "string",
  tag: "string",
  version: "string",
});

export const ApiV1SkillRenameResponseSchema = type({
  ok: "true",
  slug: "string",
  previousSlug: "string",
});

export const ApiV1SkillMergeResponseSchema = type({
  ok: "true",
  sourceSlug: "string",
  targetSlug: "string",
});

export const ApiV1TransferRequestResponseSchema = type({
  ok: "true",
  transferId: "string?",
  toUserHandle: "string?",
  toPublisherHandle: "string?",
  skillSlug: "string?",
  expiresAt: "number?",
  transferred: "boolean?",
});

export const ApiV1TransferDecisionResponseSchema = type({
  ok: "true",
  skillSlug: "string?",
});

export const ApiV1TransferListResponseSchema = type({
  transfers: type({
    _id: "string",
    skill: type({
      _id: "string",
      slug: "string",
      displayName: "string",
    }),
    fromUser: type({
      _id: "string",
      handle: "string|null",
      displayName: "string|null",
    }).optional(),
    toUser: type({
      _id: "string",
      handle: "string|null",
      displayName: "string|null",
    }).optional(),
    message: "string?",
    requestedAt: "number",
    expiresAt: "number",
  }).array(),
});

export const ApiV1BanUserResponseSchema = type({
  ok: "true",
  alreadyBanned: "boolean",
  deletedSkills: "number",
});

export const ApiV1UnbanUserResponseSchema = type({
  ok: "true",
  alreadyUnbanned: "boolean",
  restoredSkills: "number?",
});

export const ApiV1LiftModerationHoldResponseSchema = type({
  ok: "true",
  alreadyCleared: "boolean",
  restoredSkills: "number",
  scheduledSkills: "boolean",
});

export const ApiV1ReclassifyBanResponseSchema = type({
  ok: "true",
  dryRun: "boolean",
  userId: "string",
  handle: "string|null",
  previousReason: "string|null",
  nextReason: "string",
  changed: "boolean",
});

export const ApiV1SetRoleResponseSchema = type({
  ok: "true",
  role: '"admin"|"moderator"|"user"',
});

export const ApiV1PromotionModelSchema = type({
  modelRef: "string",
  alias: "string?",
  suggestedDefault: "boolean?",
});

export const ApiV1PromotionSchema = type({
  slug: "string",
  title: "string",
  blurb: "string",
  sponsor: "string?",
  status: '"draft"|"active"|"ended"',
  active: "boolean",
  startsAt: "number",
  endsAt: "number",
  provider: "string?",
  authChoiceId: "string?",
  pluginNames: "string[]?",
  models: ApiV1PromotionModelSchema.array(),
  signupUrl: "string?",
  docsUrl: "string?",
  launchPageUrl: "string?",
});
export type ApiV1Promotion = (typeof ApiV1PromotionSchema)[inferred];

export const ApiV1PromotionsListResponseSchema = type({
  promotions: ApiV1PromotionSchema.array(),
  "nextCursor?": "string|null",
});

export const ApiV1PromotionWriteResponseSchema = type({
  ok: "true",
  slug: "string",
  status: '"draft"|"active"|"ended"',
});

export const ApiV1StarResponseSchema = type({
  ok: "true",
  starred: "boolean",
  alreadyStarred: "boolean",
});

export const ApiV1UnstarResponseSchema = type({
  ok: "true",
  unstarred: "boolean",
  alreadyUnstarred: "boolean",
});

export const SkillInstallSpecSchema = type({
  id: "string?",
  kind: '"brew"|"node"|"go"|"uv"',
  label: "string?",
  bins: "string[]?",
  formula: "string?",
  tap: "string?",
  package: "string?",
  module: "string?",
});
export type SkillInstallSpec = (typeof SkillInstallSpecSchema)[inferred];

export const ClawdisRequiresSchema = type({
  bins: "string[]?",
  anyBins: "string[]?",
  env: "string[]?",
  config: "string[]?",
});
export type ClawdisRequires = (typeof ClawdisRequiresSchema)[inferred];

export const EnvVarDeclarationSchema = type({
  name: "string",
  required: "boolean?",
  description: "string?",
});
export type EnvVarDeclaration = (typeof EnvVarDeclarationSchema)[inferred];

export const ClawdisSkillMetadataSchema = type({
  always: "boolean?",
  skillKey: "string?",
  primaryEnv: "string?",
  emoji: "string?",
  homepage: "string?",
  os: "string[]?",
  requires: ClawdisRequiresSchema.optional(),
  install: SkillInstallSpecSchema.array().optional(),
  envVars: EnvVarDeclarationSchema.array().optional(),
});
export type ClawdisSkillMetadata = (typeof ClawdisSkillMetadataSchema)[inferred];
