import { type inferred } from "arktype";
export declare const GlobalConfigSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    registry: string;
    token?: string | undefined;
}, {}>;
export type GlobalConfig = (typeof GlobalConfigSchema)[inferred];
export declare const WellKnownConfigSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    apiBase: string;
    authBase?: string | undefined;
    minCliVersion?: string | undefined;
} | {
    registry: string;
    authBase?: string | undefined;
    minCliVersion?: string | undefined;
}, {}>;
export type WellKnownConfig = (typeof WellKnownConfigSchema)[inferred];
export declare const LockfileSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    version: 1;
    skills: {
        [x: string]: {
            version: string | null;
            installedAt: number;
            ownerHandle?: string | undefined;
            sourceRef?: string | undefined;
            pinned?: boolean | undefined;
            pinReason?: string | undefined;
        };
    };
}, {}>;
export type Lockfile = (typeof LockfileSchema)[inferred];
export declare const ApiCliWhoamiResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    user: {
        handle: string | null;
    };
}, {}>;
export declare const ApiSearchResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    results: {
        slug?: string | undefined;
        ownerHandle?: string | null | undefined;
        displayName?: string | undefined;
        version?: string | null | undefined;
        score: number;
    }[];
}, {}>;
export declare const ApiSkillMetaResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    latestVersion?: {
        version: string;
    } | undefined;
    skill?: unknown;
}, {}>;
export declare const ApiCliUploadUrlResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    uploadUrl: string;
    uploadTicket: string;
}, {}>;
export declare const ApiUploadFileResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    storageId: string;
}, {}>;
export declare const ApiV1SkillUploadUrlRequestSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    path: string;
    size: number;
    sha256: string;
    contentType?: string | undefined;
}, {}>;
export declare const ApiV1SkillUploadUrlResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    uploadUrl: string;
    uploadTicket: string;
}, {}>;
export declare const CliPublishFileSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    path: string;
    size: number;
    storageId: string;
    sha256: string;
    contentType?: string | undefined;
    uploadTicket?: string | undefined;
}, {}>;
export type CliPublishFile = (typeof CliPublishFileSchema)[inferred];
export declare const PublishSourceSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    kind: "github";
    url: string;
    repo: string;
    ref: string;
    commit: string;
    path: string;
    importedAt: number;
}, {}>;
export declare const CliPublishRequestSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    slug: string;
    displayName: string;
    ownerHandle?: string | undefined;
    sourceOwnerHandle?: string | undefined;
    migrateOwner?: boolean | undefined;
    version: string;
    changelog: string;
    acceptLicenseTerms?: boolean | undefined;
    tags?: string[] | undefined;
    categories?: string[] | undefined;
    topics?: string[] | undefined;
    source?: {
        kind: "github";
        url: string;
        repo: string;
        ref: string;
        commit: string;
        path: string;
        importedAt: number;
    } | undefined;
    forkOf?: {
        slug: string;
        ownerHandle?: string | undefined;
        version?: string | undefined;
    } | undefined;
    files: {
        path: string;
        size: number;
        storageId: string;
        sha256: string;
        contentType?: string | undefined;
        uploadTicket?: string | undefined;
    }[];
}, {}>;
export type CliPublishRequest = (typeof CliPublishRequestSchema)[inferred];
export declare const ApiCliPublishResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    skillId: string;
    versionId: string;
    status?: "pending" | "published" | undefined;
    slug?: string | undefined;
    version?: string | undefined;
    publicationStatus?: "pending" | "published" | undefined;
    attemptId?: string | undefined;
}, {}>;
export declare const CliSkillDeleteRequestSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    slug: string;
    reason?: string | undefined;
}, {}>;
export type CliSkillDeleteRequest = (typeof CliSkillDeleteRequestSchema)[inferred];
export declare const ApiCliSkillDeleteResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    slugReservedUntil?: number | undefined;
}, {}>;
export declare const ApiSkillResolveResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    match: {
        version: string;
    } | null;
    latestVersion: {
        version: string;
    } | null;
}, {}>;
export declare const ApiV1SkillInstallResolveResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    slug: string;
    installKind: "archive";
    archive: {
        version: string;
        downloadUrl: string;
    };
} | {
    ok: true;
    slug: string;
    installKind: "github";
    github: {
        repo: string;
        path: string;
        commit: string;
        contentHash: string;
        sourceUrl: string;
    };
} | {
    ok: false;
    slug: string;
    reason: "archive_version_missing" | "github_scan_failed" | "github_source_missing" | "github_upstream_missing" | "github_upstream_removed" | "github_upstream_unknown" | "github_verification_pending";
    message: string;
    status: number;
}, {}>;
export type ApiV1SkillInstallResolveResponse = (typeof ApiV1SkillInstallResolveResponseSchema)[inferred];
export declare const ApiV1SkillsShCatalogEntrySchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ref: string;
    route: string;
    displayName: string;
    summary: string;
    owner: {
        handle: string;
        githubUrl: string;
    };
    repository: string;
    githubPath: string;
    githubCommit: string;
    githubContentHash: string;
    sourceUrl: string;
    installs: number;
    security: {
        verdict: "clean" | "suspicious";
        source: "clawhub";
        attemptId: string;
        scannedAt: number;
    };
    install: {
        ok: true;
        slug: string;
        installKind: "github";
        github: {
            repo: string;
            path: string;
            commit: string;
            contentHash: string;
            sourceUrl: string;
        };
    };
}, {}>;
export type ApiV1SkillsShCatalogEntry = (typeof ApiV1SkillsShCatalogEntrySchema)[inferred];
export declare const CliTelemetryInstallRequestSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    event: "install";
    slug: string;
    ownerHandle?: string | undefined;
    sourceRef?: string | undefined;
    sourceKind?: "skills-sh" | undefined;
    sourceRepository?: string | undefined;
    sourcePath?: string | undefined;
    sourceUrl?: string | undefined;
    canonicalRef?: string | undefined;
    clawhubScan?: "scanned" | "unscanned" | undefined;
    trustLabel?: string | undefined;
    version?: string | undefined;
    rootId?: string | undefined;
    rootLabel?: string | undefined;
} | {
    event: "plugin_install";
    packageName: string;
    version?: string | undefined;
} | {
    roots: {
        rootId: string;
        label: string;
        skills: {
            slug: string;
            version?: string | null | undefined;
        }[];
    }[];
}, {}>;
export type CliTelemetryInstallRequest = (typeof CliTelemetryInstallRequestSchema)[inferred];
export declare const ApiCliTelemetryInstallResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
}, {}>;
export declare const ApiV1WhoamiResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    user: {
        handle: string | null;
        displayName?: string | null | undefined;
        image?: string | null | undefined;
        role?: "admin" | "moderator" | "user" | null | undefined;
    };
}, {}>;
export declare const ApiV1UserSearchResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    items: {
        userId: string;
        handle: string | null;
        displayName?: string | null | undefined;
        name?: string | null | undefined;
        role?: "admin" | "moderator" | "user" | null | undefined;
    }[];
    total: number;
}, {}>;
export declare const ApiV1PublisherCreateResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    publisherId: string;
    handle: string;
    created: true;
    trusted: false;
}, {}>;
export type ApiV1PublisherCreateResponse = (typeof ApiV1PublisherCreateResponseSchema)[inferred];
export declare const ApiV1PublisherDeleteResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    publisherId: string;
    handle: string;
    dryRun: boolean;
    deleted: boolean;
    activeSkills: number;
    activePackages: number;
    memberCount: number;
}, {}>;
export type ApiV1PublisherDeleteResponse = (typeof ApiV1PublisherDeleteResponseSchema)[inferred];
export declare const ApiV1PublisherReclaimResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    publisherId: string;
    handle: string;
    dryRun: boolean;
    hardDeleted: boolean;
    activeSkills: number;
    activePackages: number;
    memberCount: number;
    githubSources: number;
    githubSourceContents: number;
    officialPublisher: boolean;
    confirmationToken: string;
}, {}>;
export type ApiV1PublisherReclaimResponse = (typeof ApiV1PublisherReclaimResponseSchema)[inferred];
export declare const ApiV1StaffEmailSendResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    sent: true;
    recipient: {
        email: string;
        userId?: string | undefined;
        handle?: string | null | undefined;
    };
    subject: string;
    template: string;
    providerId: string | null;
}, {}>;
export type ApiV1StaffEmailSendResponse = (typeof ApiV1StaffEmailSendResponseSchema)[inferred];
export declare const ApiV1SearchResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    results: {
        slug?: string | undefined;
        ownerHandle?: string | null | undefined;
        displayName?: string | undefined;
        summary?: string | null | undefined;
        version?: string | null | undefined;
        score: number;
        downloads?: number | undefined;
        updatedAt?: number | undefined;
        owner?: {
            handle?: string | null | undefined;
            displayName?: string | null | undefined;
            image?: string | null | undefined;
        } | null | undefined;
    }[];
}, {}>;
export declare const ApiV1SkillListResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    items: {
        ownerHandle: string;
        slug: string;
        displayName: string;
        summary?: string | null | undefined;
        description?: string | null | undefined;
        topics?: string[] | undefined;
        tags: unknown;
        stats: unknown;
        createdAt: number;
        updatedAt: number;
        latestVersion: {
            version: string;
            createdAt: number;
            changelog: string;
            license?: "MIT-0" | null | undefined;
        } | null;
        metadata?: {
            setup: {
                key: string;
                required: boolean;
            }[];
            os?: string[] | null | undefined;
            systems?: string[] | null | undefined;
        } | null | undefined;
    }[];
    nextCursor: string | null;
}, {}>;
export declare const ApiV1SkillResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    skill: {
        slug: string;
        displayName: string;
        summary?: string | null | undefined;
        description?: string | null | undefined;
        topics?: string[] | undefined;
        tags: unknown;
        stats: unknown;
        createdAt: number;
        updatedAt: number;
    } | null;
    latestVersion: {
        version: string;
        createdAt: number;
        changelog: string;
        license?: "MIT-0" | null | undefined;
    } | null;
    metadata?: {
        setup: {
            key: string;
            required: boolean;
        }[];
        os?: string[] | null | undefined;
        systems?: string[] | null | undefined;
    } | null | undefined;
    owner: {
        handle: string | null;
        displayName?: string | null | undefined;
        image?: string | null | undefined;
    } | null;
    moderation?: {
        isSuspicious: boolean;
        isMalwareBlocked: boolean;
        verdict?: "clean" | "malicious" | "suspicious" | undefined;
        reasonCodes?: string[] | undefined;
        updatedAt?: number | null | undefined;
        engineVersion?: string | null | undefined;
        summary?: string | null | undefined;
    } | null | undefined;
}, {}>;
export declare const ApiV1SkillModerationResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    moderation: {
        isSuspicious: boolean;
        isMalwareBlocked: boolean;
        verdict: "clean" | "malicious" | "suspicious";
        reasonCodes: string[];
        updatedAt?: number | null | undefined;
        engineVersion?: string | null | undefined;
        summary?: string | null | undefined;
        legacyReason?: string | null | undefined;
        evidence: {
            code: string;
            severity: "critical" | "info" | "warn";
            file: string;
            line: number;
            message: string;
            evidence: string;
        }[];
    } | null;
}, {}>;
export declare const SkillVersionRevokeRequestSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    state: "revoked";
    reason: string;
    ownerHandle?: string | undefined;
}, {}>;
export type SkillVersionRevokeRequest = (typeof SkillVersionRevokeRequestSchema)[inferred];
export declare const ApiV1SkillVersionRevokeResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    slug: string;
    version: string;
    skillId: string;
    versionId: string;
    alreadyRevoked: boolean;
    replacementVersion: string | null;
    skillHidden: boolean;
}, {}>;
export type ApiV1SkillVersionRevokeResponse = (typeof ApiV1SkillVersionRevokeResponseSchema)[inferred];
export declare const SkillReportStatusSchema: import("arktype/internal/variants/string.ts").StringType<"confirmed" | "dismissed" | "open", {}>;
export type SkillReportStatus = (typeof SkillReportStatusSchema)[inferred];
export declare const SkillReportFinalActionSchema: import("arktype/internal/variants/string.ts").StringType<"hide" | "none", {}>;
export type SkillReportFinalAction = (typeof SkillReportFinalActionSchema)[inferred];
export declare const SkillReportListStatusSchema: import("arktype/internal/variants/string.ts").StringType<"all" | "confirmed" | "dismissed" | "open", {}>;
export type SkillReportListStatus = (typeof SkillReportListStatusSchema)[inferred];
export declare const SkillAppealStatusSchema: import("arktype/internal/variants/string.ts").StringType<"accepted" | "open" | "rejected", {}>;
export type SkillAppealStatus = (typeof SkillAppealStatusSchema)[inferred];
export declare const SkillAppealFinalActionSchema: import("arktype/internal/variants/string.ts").StringType<"none" | "restore", {}>;
export type SkillAppealFinalAction = (typeof SkillAppealFinalActionSchema)[inferred];
export declare const SkillAppealListStatusSchema: import("arktype/internal/variants/string.ts").StringType<"accepted" | "all" | "open" | "rejected", {}>;
export type SkillAppealListStatus = (typeof SkillAppealListStatusSchema)[inferred];
export declare const SkillAppealRequestSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    version?: string | undefined;
    message: string;
}, {}>;
export type SkillAppealRequest = (typeof SkillAppealRequestSchema)[inferred];
export declare const ApiV1SkillReportResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    reported: boolean;
    alreadyReported: boolean;
    reportId: string;
    skillId: string;
    reportCount: number;
}, {}>;
export type ApiV1SkillReportResponse = (typeof ApiV1SkillReportResponseSchema)[inferred];
export declare const ApiV1SkillAppealResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    submitted: boolean;
    alreadyOpen: boolean;
    appealId: string;
    skillId: string;
    status: "accepted" | "open" | "rejected";
}, {}>;
export type ApiV1SkillAppealResponse = (typeof ApiV1SkillAppealResponseSchema)[inferred];
export declare const SkillReportTriageRequestSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    status: "confirmed" | "dismissed" | "open";
    note?: string | undefined;
    finalAction?: "hide" | "none" | undefined;
}, {}>;
export type SkillReportTriageRequest = (typeof SkillReportTriageRequestSchema)[inferred];
export declare const SkillAppealResolveRequestSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    status: "accepted" | "open" | "rejected";
    note?: string | undefined;
    finalAction?: "none" | "restore" | undefined;
}, {}>;
export type SkillAppealResolveRequest = (typeof SkillAppealResolveRequestSchema)[inferred];
export declare const ApiV1SkillReportListResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    items: {
        reportId: string;
        skillId: string;
        skillVersionId?: string | null | undefined;
        slug: string;
        displayName: string;
        version?: string | null | undefined;
        reason?: string | null | undefined;
        status: "confirmed" | "dismissed" | "open";
        createdAt: number;
        reporter: {
            userId: string;
            handle?: string | null | undefined;
            displayName?: string | null | undefined;
        };
        triagedAt?: number | null | undefined;
        triagedBy?: string | null | undefined;
        triageNote?: string | null | undefined;
        actionTaken?: "hide" | "none" | null | undefined;
    }[];
    nextCursor: string | null;
    done: boolean;
}, {}>;
export type ApiV1SkillReportListResponse = (typeof ApiV1SkillReportListResponseSchema)[inferred];
export declare const ApiV1SkillReportTriageResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    reportId: string;
    skillId: string;
    status: "confirmed" | "dismissed" | "open";
    reportCount: number;
    actionTaken?: "hide" | "none" | undefined;
}, {}>;
export type ApiV1SkillReportTriageResponse = (typeof ApiV1SkillReportTriageResponseSchema)[inferred];
export declare const ApiV1SkillAppealListResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    items: {
        appealId: string;
        skillId: string;
        skillVersionId?: string | null | undefined;
        slug: string;
        displayName: string;
        version?: string | null | undefined;
        message: string;
        status: "accepted" | "open" | "rejected";
        createdAt: number;
        submitter: {
            userId: string;
            handle?: string | null | undefined;
            displayName?: string | null | undefined;
        };
        resolvedAt?: number | null | undefined;
        resolvedBy?: string | null | undefined;
        resolutionNote?: string | null | undefined;
        actionTaken?: "none" | "restore" | null | undefined;
    }[];
    nextCursor: string | null;
    done: boolean;
}, {}>;
export type ApiV1SkillAppealListResponse = (typeof ApiV1SkillAppealListResponseSchema)[inferred];
export declare const ApiV1SkillAppealResolveResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    appealId: string;
    skillId: string;
    status: "accepted" | "open" | "rejected";
    actionTaken?: "none" | "restore" | undefined;
}, {}>;
export type ApiV1SkillAppealResolveResponse = (typeof ApiV1SkillAppealResolveResponseSchema)[inferred];
export declare const ApiV1SkillRescanResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    slug: string;
    version: string;
    skillId: string;
    skillVersionId: string;
    jobId: string;
    alreadyQueued: boolean;
} | {
    ok: true;
    slug: string;
    version: string;
    skillId: string;
    githubContentHash: string;
    jobId?: string | undefined;
    scheduled: boolean;
    alreadyQueued: boolean;
}, {}>;
export type ApiV1SkillRescanResponse = (typeof ApiV1SkillRescanResponseSchema)[inferred];
export declare const ApiV1SkillHardDeleteRequestSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ownerHandle: string;
    reason: string;
    dryRun?: boolean | undefined;
    confirmationToken?: string | undefined;
}, {}>;
export type ApiV1SkillHardDeleteRequest = (typeof ApiV1SkillHardDeleteRequestSchema)[inferred];
export declare const ApiV1SkillHardDeleteResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    skillId: string;
    slug: string;
    ownerHandle: string;
    displayName: string;
    dryRun: boolean;
    scheduled: boolean;
    confirmationToken: string;
}, {}>;
export type ApiV1SkillHardDeleteResponse = (typeof ApiV1SkillHardDeleteResponseSchema)[inferred];
export declare const ApiV1SkillScanStatusSchema: import("arktype/internal/variants/string.ts").StringType<"failed" | "queued" | "running" | "succeeded", {}>;
export type ApiV1SkillScanStatus = (typeof ApiV1SkillScanStatusSchema)[inferred];
export declare const ApiV1SkillScanSourceSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    kind: "upload";
} | {
    kind: "published";
    slug: string;
    ownerHandle?: string | undefined;
    version?: string | undefined;
}, {}>;
export type ApiV1SkillScanSource = (typeof ApiV1SkillScanSourceSchema)[inferred];
export declare const ApiV1SkillScanSubmitRequestSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    source: {
        kind: "upload";
    } | {
        kind: "published";
        slug: string;
        ownerHandle?: string | undefined;
        version?: string | undefined;
    };
    update?: boolean | undefined;
}, {}>;
export type ApiV1SkillScanSubmitRequest = (typeof ApiV1SkillScanSubmitRequestSchema)[inferred];
export declare const ApiV1SkillScanQueueSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    queuedAhead: number;
    queuedAheadIsEstimate?: boolean | undefined;
    position: number | null;
    running: number;
    runningIsEstimate?: boolean | undefined;
    note: string;
}, {}>;
export type ApiV1SkillScanQueue = (typeof ApiV1SkillScanQueueSchema)[inferred];
export declare const ApiV1SkillScanSubmitResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    scanId: string;
    jobId?: string | undefined;
    status: "failed" | "queued" | "running" | "succeeded";
    sourceKind: "published" | "upload";
    update: boolean;
    alreadyQueued?: boolean | undefined;
    queue?: {
        queuedAhead: number;
        queuedAheadIsEstimate?: boolean | undefined;
        position: number | null;
        running: number;
        runningIsEstimate?: boolean | undefined;
        note: string;
    } | undefined;
}, {}>;
export type ApiV1SkillScanSubmitResponse = (typeof ApiV1SkillScanSubmitResponseSchema)[inferred];
export declare const ApiV1SkillScanStatusResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    scanId: string;
    jobId?: string | undefined;
    status: "failed" | "queued" | "running" | "succeeded";
    sourceKind: "published" | "upload";
    update: boolean;
    writtenBack?: boolean | undefined;
    artifact?: unknown;
    report?: unknown;
    queue?: {
        queuedAhead: number;
        queuedAheadIsEstimate?: boolean | undefined;
        position: number | null;
        running: number;
        runningIsEstimate?: boolean | undefined;
        note: string;
    } | undefined;
    lastError?: string | undefined;
    createdAt: number;
    updatedAt: number;
    completedAt?: number | undefined;
}, {}>;
export type ApiV1SkillScanStatusResponse = (typeof ApiV1SkillScanStatusResponseSchema)[inferred];
export declare const ApiV1SkillScanDownloadManifestSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    scanId: string;
    sourceKind: "published" | "upload";
    update: boolean;
    status: "failed" | "queued" | "running" | "succeeded";
    artifact?: unknown;
    createdAt: number;
    updatedAt: number;
    completedAt?: number | undefined;
    writtenBack?: boolean | undefined;
}, {}>;
export type ApiV1SkillScanDownloadManifest = (typeof ApiV1SkillScanDownloadManifestSchema)[inferred];
export declare const ApiV1SkillBulkRescanBatchRequestSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    mode?: "all-active-latest" | undefined;
    cursor?: string | null | undefined;
    batchSize?: number | undefined;
    dryRun?: boolean | undefined;
}, {}>;
export type ApiV1SkillBulkRescanBatchRequest = (typeof ApiV1SkillBulkRescanBatchRequestSchema)[inferred];
export declare const ApiV1SkillBulkRescanBatchResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    mode: "all-active-latest";
    queued: number;
    alreadyQueued: number;
    skipped: number;
    jobIds: string[];
    nextCursor: string | null;
    done: boolean;
    sampleSlugs: string[];
}, {}>;
export type ApiV1SkillBulkRescanBatchResponse = (typeof ApiV1SkillBulkRescanBatchResponseSchema)[inferred];
export declare const ApiV1SkillBulkRescanStatusRequestSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    jobIds: string[];
}, {}>;
export type ApiV1SkillBulkRescanStatusRequest = (typeof ApiV1SkillBulkRescanStatusRequestSchema)[inferred];
export declare const ApiV1SkillBulkRescanStatusResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    missing: number;
    terminal: number;
    done: boolean;
    failedJobIds: string[];
}, {}>;
export type ApiV1SkillBulkRescanStatusResponse = (typeof ApiV1SkillBulkRescanStatusResponseSchema)[inferred];
export declare const ApiV1SkillScanBatchRequestSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    mode?: "all-active-latest" | undefined;
    cursor?: string | null | undefined;
    batchSize?: number | undefined;
    dryRun?: boolean | undefined;
}, {}>;
export type ApiV1SkillScanBatchRequest = (typeof ApiV1SkillScanBatchRequestSchema)[inferred];
export declare const ApiV1SkillScanBatchResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    mode: "all-active-latest";
    queued: number;
    alreadyQueued: number;
    skipped: number;
    jobIds: string[];
    nextCursor: string | null;
    done: boolean;
    sampleSlugs: string[];
}, {}>;
export type ApiV1SkillScanBatchResponse = (typeof ApiV1SkillScanBatchResponseSchema)[inferred];
export declare const ApiV1SkillScanBatchStatusRequestSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    jobIds: string[];
}, {}>;
export type ApiV1SkillScanBatchStatusRequest = (typeof ApiV1SkillScanBatchStatusRequestSchema)[inferred];
export declare const ApiV1SkillScanBatchStatusResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    missing: number;
    terminal: number;
    done: boolean;
    failedJobIds: string[];
}, {}>;
export type ApiV1SkillScanBatchStatusResponse = (typeof ApiV1SkillScanBatchStatusResponseSchema)[inferred];
export declare const ApiV1SkillRepairVtPendingRequestSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    cursor?: string | null | undefined;
    batchSize?: number | undefined;
    concurrency?: number | undefined;
    dryRun?: boolean | undefined;
}, {}>;
export type ApiV1SkillRepairVtPendingRequest = (typeof ApiV1SkillRepairVtPendingRequestSchema)[inferred];
export declare const ApiV1SkillRepairVtPendingResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    dryRun: boolean;
    total: number;
    wouldUpdate: number;
    updated: number;
    noResults: number;
    noDecisiveStats: number;
    errors: number;
    done: boolean;
    cursor: string | null;
    statusCounts: {
        [x: string]: number;
    };
    sampleUpdated: {
        slug: string;
        status: string;
    }[];
}, {}>;
export type ApiV1SkillRepairVtPendingResponse = (typeof ApiV1SkillRepairVtPendingResponseSchema)[inferred];
export declare const ApiV1SkillVersionListResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    items: {
        version: string;
        createdAt: number;
        changelog: string;
        changelogSource?: "auto" | "user" | null | undefined;
    }[];
    nextCursor: string | null;
}, {}>;
export declare const SecurityStatusSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    status: "clean" | "error" | "malicious" | "pending" | "suspicious";
    hasWarnings: boolean;
    checkedAt: number | null;
    model: string | null;
}, {}>;
export declare const ApiV1SkillVersionResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    version: {
        version: string;
        createdAt: number;
        changelog: string;
        changelogSource?: "auto" | "user" | null | undefined;
        license?: "MIT-0" | null | undefined;
        files?: unknown;
        security?: {
            status: "clean" | "error" | "malicious" | "pending" | "suspicious";
            hasWarnings: boolean;
            checkedAt: number | null;
            model: string | null;
        } | undefined;
    } | null;
    skill: {
        slug: string;
        displayName: string;
    } | null;
}, {}>;
export declare const ApiV1SkillResolveResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    match: {
        version: string;
    } | null;
    latestVersion: {
        version: string;
    } | null;
}, {}>;
export declare const ApiV1SkillVerifyResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    schema: "clawhub.skill.verify.v1";
    ok: boolean;
    decision: "fail" | "pass";
    reasons: string[];
    slug: string;
    displayName: string;
    pageUrl: string;
    publisherHandle: string | null;
    publisherDisplayName: string | null;
    publisherProfileUrl: string | null;
    version: string;
    resolvedFrom: "latest" | "tag" | "version";
    tag: string | null;
    createdAt: number;
    card: unknown;
    artifact: unknown;
    provenance: unknown;
    security: unknown;
    signature: unknown;
}, {}>;
export declare const ApiV1PublishResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    skillId: string;
    versionId: string;
    status?: "pending" | "published" | undefined;
    slug?: string | undefined;
    version?: string | undefined;
    publicationStatus?: "pending" | "published" | undefined;
    attemptId?: string | undefined;
}, {}>;
export declare const ApiV1DeleteResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    slugReservedUntil?: number | undefined;
}, {}>;
export declare const ApiV1SkillTagResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    slug: string;
    tag: string;
    version: string;
}, {}>;
export declare const ApiV1SkillRenameResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    slug: string;
    previousSlug: string;
}, {}>;
export declare const ApiV1SkillMergeResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    sourceSlug: string;
    targetSlug: string;
}, {}>;
export declare const ApiV1TransferRequestResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    transferId?: string | undefined;
    toUserHandle?: string | undefined;
    toPublisherHandle?: string | undefined;
    skillSlug?: string | undefined;
    expiresAt?: number | undefined;
    transferred?: boolean | undefined;
}, {}>;
export declare const ApiV1TransferDecisionResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    skillSlug?: string | undefined;
}, {}>;
export declare const ApiV1TransferListResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    transfers: {
        _id: string;
        skill: {
            _id: string;
            slug: string;
            displayName: string;
        };
        fromUser?: {
            _id: string;
            handle: string | null;
            displayName: string | null;
        } | undefined;
        toUser?: {
            _id: string;
            handle: string | null;
            displayName: string | null;
        } | undefined;
        message?: string | undefined;
        requestedAt: number;
        expiresAt: number;
    }[];
}, {}>;
export declare const ApiV1SetRoleResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    role: "admin" | "moderator" | "user";
}, {}>;
export declare const ApiV1ReclassifyBanResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    dryRun: boolean;
    userId: string;
    handle: string | null;
    previousReason: string | null;
    nextReason: string;
    changed: boolean;
}, {}>;
export declare const ApiV1StarResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    starred: boolean;
    alreadyStarred: boolean;
}, {}>;
export declare const ApiV1UnstarResponseSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    ok: true;
    unstarred: boolean;
    alreadyUnstarred: boolean;
}, {}>;
export declare const SkillInstallSpecSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    id?: string | undefined;
    kind: "brew" | "go" | "node" | "uv";
    label?: string | undefined;
    bins?: string[] | undefined;
    formula?: string | undefined;
    tap?: string | undefined;
    package?: string | undefined;
    module?: string | undefined;
}, {}>;
export type SkillInstallSpec = (typeof SkillInstallSpecSchema)[inferred];
export declare const NixPluginSpecSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    plugin: string;
    systems?: string[] | undefined;
}, {}>;
export type NixPluginSpec = (typeof NixPluginSpecSchema)[inferred];
export declare const ClawdbotConfigSpecSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    requiredEnv?: string[] | undefined;
    stateDirs?: string[] | undefined;
    example?: string | undefined;
}, {}>;
export type ClawdbotConfigSpec = (typeof ClawdbotConfigSpecSchema)[inferred];
export declare const ClawdisRequiresSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    bins?: string[] | undefined;
    anyBins?: string[] | undefined;
    env?: string[] | undefined;
    config?: string[] | undefined;
}, {}>;
export type ClawdisRequires = (typeof ClawdisRequiresSchema)[inferred];
export declare const EnvVarDeclarationSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    name: string;
    required?: boolean | undefined;
    description?: string | undefined;
}, {}>;
export type EnvVarDeclaration = (typeof EnvVarDeclarationSchema)[inferred];
export declare const DependencyDeclarationSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    name: string;
    type: "apt" | "brew" | "cargo" | "go" | "npm" | "other" | "pip";
    version?: string | undefined;
    url?: string | undefined;
    repository?: string | undefined;
}, {}>;
export type DependencyDeclaration = (typeof DependencyDeclarationSchema)[inferred];
export declare const SkillLinksSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    homepage?: string | undefined;
    repository?: string | undefined;
    documentation?: string | undefined;
    changelog?: string | undefined;
}, {}>;
export type SkillLinks = (typeof SkillLinksSchema)[inferred];
export declare const ClawdisSkillMetadataSchema: import("arktype/internal/variants/object.ts").ObjectType<{
    always?: boolean | undefined;
    skillKey?: string | undefined;
    primaryEnv?: string | undefined;
    emoji?: string | undefined;
    homepage?: string | undefined;
    os?: string[] | undefined;
    cliHelp?: string | undefined;
    requires?: {
        bins?: string[] | undefined;
        anyBins?: string[] | undefined;
        env?: string[] | undefined;
        config?: string[] | undefined;
    } | undefined;
    install?: {
        id?: string | undefined;
        kind: "brew" | "go" | "node" | "uv";
        label?: string | undefined;
        bins?: string[] | undefined;
        formula?: string | undefined;
        tap?: string | undefined;
        package?: string | undefined;
        module?: string | undefined;
    }[] | undefined;
    nix?: {
        plugin: string;
        systems?: string[] | undefined;
    } | undefined;
    config?: {
        requiredEnv?: string[] | undefined;
        stateDirs?: string[] | undefined;
        example?: string | undefined;
    } | undefined;
    envVars?: {
        name: string;
        required?: boolean | undefined;
        description?: string | undefined;
    }[] | undefined;
    dependencies?: {
        name: string;
        type: "apt" | "brew" | "cargo" | "go" | "npm" | "other" | "pip";
        version?: string | undefined;
        url?: string | undefined;
        repository?: string | undefined;
    }[] | undefined;
    author?: string | undefined;
    links?: {
        homepage?: string | undefined;
        repository?: string | undefined;
        documentation?: string | undefined;
        changelog?: string | undefined;
    } | undefined;
}, {}>;
export type ClawdisSkillMetadata = {
    always?: boolean;
    skillKey?: string;
    primaryEnv?: string;
    emoji?: string;
    homepage?: string;
    os?: string[];
    cliHelp?: string;
    requires?: ClawdisRequires;
    install?: SkillInstallSpec[];
    nix?: NixPluginSpec;
    config?: ClawdbotConfigSpec;
    envVars?: EnvVarDeclaration[];
    dependencies?: DependencyDeclaration[];
    author?: string;
    links?: SkillLinks;
};
