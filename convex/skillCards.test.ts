import { describe, expect, it, vi } from "vitest";
import { hashSkillFiles } from "./lib/skills";
import {
  attachCardAndSucceedJobInternal,
  claimQueuedJobsInternal,
  claimSkillCardJobs,
  completeSkillCardJob,
  enqueueForVersionInternal,
  failJobInternal,
} from "./skillCards";

type WrappedHandler<TArgs, TResult = unknown> = {
  _handler: (ctx: unknown, args: TArgs) => Promise<TResult>;
};

const enqueueHandler = (
  enqueueForVersionInternal as unknown as WrappedHandler<
    { versionId: string; source: "scan"; priority?: number; requireMissingCard?: boolean },
    { ok: true; skipped?: string; jobId?: string; alreadyQueued?: boolean }
  >
)._handler;

const attachHandler = (
  attachCardAndSucceedJobInternal as unknown as WrappedHandler<
    {
      jobId: string;
      leaseToken: string;
      cardFile: {
        path: string;
        size: number;
        storageId: string;
        sha256: string;
        contentType?: string;
      };
      runId?: string;
    },
    { ok: true; bundleFingerprint: string }
  >
)._handler;

const completeHandler = (
  completeSkillCardJob as unknown as WrappedHandler<
    {
      token: string;
      jobId: string;
      leaseToken: string;
      markdown: string;
      runId?: string;
    },
    { ok: true }
  >
)._handler;

const failHandler = (
  failJobInternal as unknown as WrappedHandler<
    { jobId: string; leaseToken: string; error: string },
    { ok: true; retry: boolean }
  >
)._handler;

const claimHandler = (
  claimSkillCardJobs as unknown as WrappedHandler<
    { token: string; workerId: string; limit?: number; leaseMs?: number },
    Array<{ target: { evidence: Record<string, unknown> } }>
  >
)._handler;

const claimQueuedHandler = (
  claimQueuedJobsInternal as unknown as WrappedHandler<
    { workerId: string; limit: number; leaseMs?: number },
    Array<{ _id: string; skillVersionId: string; status: "running"; leaseToken: string }>
  >
)._handler;

function makeSettledVersion(overrides: Record<string, unknown> = {}) {
  return {
    _id: "skillVersions:1",
    _creationTime: 1,
    skillId: "skills:1",
    version: "1.0.0",
    fingerprint: "source-fingerprint",
    changelog: "init",
    files: [
      {
        path: "SKILL.md",
        size: 12,
        storageId: "_storage:skill",
        sha256: "a".repeat(64),
        contentType: "text/markdown",
      },
    ],
    parsed: { frontmatter: {}, license: "MIT-0" },
    createdBy: "users:1",
    createdAt: 1,
    softDeletedAt: undefined,
    staticScan: {
      status: "clean",
      reasonCodes: [],
      findings: [],
      summary: "clean",
      engineVersion: "test",
      checkedAt: 1,
    },
    llmAnalysis: {
      status: "clean",
      checkedAt: 2,
    },
    ...overrides,
  };
}

function makeQueryWithCollect(items: unknown[]) {
  const collect = vi.fn(async () => items);
  const take = vi.fn(async () => items);
  const order = vi.fn(() => ({ take }));
  const withIndex = vi.fn((_name: string, build: (q: unknown) => unknown) => {
    const q: { eq: ReturnType<typeof vi.fn>; lte: ReturnType<typeof vi.fn> } = {
      eq: vi.fn(),
      lte: vi.fn(),
    };
    q.eq.mockReturnValue(q);
    q.lte.mockReturnValue(q);
    build(q);
    return { collect, take, order };
  });
  return { withIndex, collect, take, order };
}

function completeDb<T extends Record<string, unknown>>(db: T) {
  return {
    delete: vi.fn(),
    get: vi.fn(),
    insert: vi.fn(),
    normalizeId: vi.fn(() => null),
    patch: vi.fn(),
    query: vi.fn(() => makeQueryWithCollect([])),
    replace: vi.fn(),
    system: {},
    ...db,
  };
}

describe("skillCards queue", () => {
  it("passes ClawScan rollup evidence instead of raw scanner feeds", async () => {
    const previousToken = process.env.SECURITY_SCAN_WORKER_TOKEN;
    process.env.SECURITY_SCAN_WORKER_TOKEN = "test-worker-token";
    const job = {
      _id: "skillCardGenerationJobs:1",
      skillVersionId: "skillVersions:1",
      leaseToken: "lease",
      status: "running",
    };
    const version = makeSettledVersion({
      llmAnalysis: {
        status: "clean",
        verdict: "benign",
        confidence: "high",
        summary: "ClawScan found no suspicious behavior.",
        guidance: "Review generated files before running them.",
        findings: "No notable findings.",
        agenticRiskFindings: [
          {
            categoryId: "ASI06",
            categoryLabel: "Sensitive data protection",
            riskBucket: "sensitive_data_protection",
            status: "note",
            severity: "low",
            confidence: "medium",
            userImpact: "Logs could capture sensitive local context.",
            recommendation: "Redact secrets before writing learning entries.",
          },
        ],
        riskSummary: {
          abnormal_behavior_control: { status: "none", summary: "No abnormal behavior." },
          permission_boundary: { status: "none", summary: "No boundary concern." },
          sensitive_data_protection: {
            status: "note",
            summary: "Review logs for sensitive data.",
            highestSeverity: "low",
          },
        },
        model: "test-model",
        checkedAt: 2,
      },
      staticScan: {
        status: "suspicious",
        reasonCodes: ["suspicious.raw_static"],
        findings: [
          {
            code: "suspicious.raw_static",
            severity: "warn",
            file: "SKILL.md",
            line: 1,
            message: "Raw static finding should not be passed to card evidence.",
            evidence: "raw scanner detail",
          },
        ],
        summary: "raw scanner detail",
        engineVersion: "test",
        checkedAt: 1,
      },
      vtAnalysis: {
        status: "suspicious",
        verdict: "suspicious",
        checkedAt: 4,
      },
    });
    const ctx = {
      runMutation: vi.fn(async () => [job]),
      runQuery: vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
        if ("jobId" in args) {
          return {
            job,
            skill: {
              _id: "skills:1",
              slug: "demo",
              displayName: "Demo",
              summary: "Demo skill",
              capabilityTags: [],
              badges: null,
              ownerUserId: "users:1",
              ownerPublisherId: null,
              moderationVerdict: "malicious",
              moderationSummary: "Latest version should not leak into this card.",
              moderationReasonCodes: ["clean.llm_clean"],
              moderationEvidence: [],
              moderationEngineVersion: "test-engine",
              moderationEvaluatedAt: 5,
            },
            version,
            owner: { _id: "users:1", handle: "alice", displayName: "Alice" },
            publisher: null,
          };
        }
        if ("skillVersionId" in args) return [];
        throw new Error(`Unexpected query args: ${JSON.stringify(args)}`);
      }),
      storage: {
        getUrl: vi.fn(async () => "https://storage.example/SKILL.md"),
      },
    };

    try {
      const result = await claimHandler(ctx, {
        token: "test-worker-token",
        workerId: "worker",
        limit: 1,
      });

      const evidence = result[0]?.target.evidence;
      expect(evidence).not.toHaveProperty("scans");
      expect(evidence).toMatchObject({
        security: {
          source: "clawscan",
          verdict: "clean",
          summary: "ClawScan found no suspicious behavior.",
          guidance: "Review generated files before running them.",
          riskFindings: [
            {
              category: "Sensitive data protection",
              status: "note",
              severity: "low",
              confidence: "medium",
              userImpact: "Logs could capture sensitive local context.",
              recommendation: "Redact secrets before writing learning entries.",
            },
          ],
        },
      });
    } finally {
      if (previousToken === undefined) delete process.env.SECURITY_SCAN_WORKER_TOKEN;
      else process.env.SECURITY_SCAN_WORKER_TOKEN = previousToken;
    }
  });

  it("does not enqueue before static and ClawScan inputs settle", async () => {
    const version = makeSettledVersion({ llmAnalysis: undefined });
    const ctx = {
      db: completeDb({
        get: vi.fn(async () => version),
        insert: vi.fn(),
      }),
    };

    const result = await enqueueHandler(ctx, {
      versionId: "skillVersions:1",
      source: "scan",
    });

    expect(result).toEqual({ ok: true, skipped: "scan-not-settled" });
    expect(ctx.db.insert).not.toHaveBeenCalled();
  });

  it("enqueues after static and ClawScan inputs settle", async () => {
    const version = makeSettledVersion();
    const insert = vi.fn(async () => "skillCardGenerationJobs:1");
    const ctx = {
      db: completeDb({
        get: vi.fn(async () => version),
        query: vi.fn(() => makeQueryWithCollect([])),
        insert,
        patch: vi.fn(),
      }),
    };

    const result = await enqueueHandler(ctx, {
      versionId: "skillVersions:1",
      source: "scan",
    });

    expect(result).toMatchObject({
      ok: true,
      jobId: "skillCardGenerationJobs:1",
      alreadyQueued: false,
    });
    expect(insert).toHaveBeenCalledWith(
      "skillCardGenerationJobs",
      expect.objectContaining({
        skillVersionId: "skillVersions:1",
        status: "queued",
        source: "scan",
      }),
    );
  });

  it("bounds queued job lookup by version and status", async () => {
    const version = makeSettledVersion();
    const eq = vi.fn(function (this: unknown) {
      return this;
    });
    const collect = vi.fn(async () => []);
    const take = vi.fn(async () => []);
    const withIndex = vi.fn((_name: string, build: (q: { eq: typeof eq }) => unknown) => {
      build({ eq });
      return { collect, take };
    });
    const ctx = {
      db: completeDb({
        get: vi.fn(async () => version),
        query: vi.fn(() => ({ withIndex })),
        insert: vi.fn(async () => "skillCardGenerationJobs:1"),
      }),
    };

    await enqueueHandler(ctx, {
      versionId: "skillVersions:1",
      source: "scan",
    });

    expect(withIndex).toHaveBeenCalledWith("by_skill_version_status", expect.any(Function));
    expect(eq).toHaveBeenCalledWith("skillVersionId", "skillVersions:1");
    expect(eq).toHaveBeenCalledWith("status", "queued");
    expect(take).toHaveBeenCalledWith(1);
  });

  it("queues a follow-up job when evidence changes during a running generation", async () => {
    const version = makeSettledVersion();
    const insert = vi.fn(async () => "skillCardGenerationJobs:2");
    const patch = vi.fn();
    const ctx = {
      db: completeDb({
        get: vi.fn(async () => version),
        query: vi.fn(() => makeQueryWithCollect([])),
        insert,
        patch,
      }),
    };

    const result = await enqueueHandler(ctx, {
      versionId: "skillVersions:1",
      source: "scan",
    });

    expect(result).toMatchObject({
      ok: true,
      jobId: "skillCardGenerationJobs:2",
      alreadyQueued: false,
    });
    expect(patch).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith(
      "skillCardGenerationJobs",
      expect.objectContaining({
        skillVersionId: "skillVersions:1",
        status: "queued",
        source: "scan",
      }),
    );
  });

  it("enqueues when ClawScan stores a final verdict with a generic completed status", async () => {
    const version = makeSettledVersion({
      llmAnalysis: {
        status: "completed",
        verdict: "benign",
        checkedAt: 2,
      },
    });
    const insert = vi.fn(async () => "skillCardGenerationJobs:1");
    const ctx = {
      db: completeDb({
        get: vi.fn(async () => version),
        query: vi.fn(() => makeQueryWithCollect([])),
        insert,
        patch: vi.fn(),
      }),
    };

    const result = await enqueueHandler(ctx, {
      versionId: "skillVersions:1",
      source: "scan",
    });

    expect(result).toMatchObject({
      ok: true,
      jobId: "skillCardGenerationJobs:1",
      alreadyQueued: false,
    });
    expect(insert).toHaveBeenCalled();
  });

  it("does not claim a queued follow-up while the same version has an active job", async () => {
    const now = Date.now();
    const runningJob = {
      _id: "skillCardGenerationJobs:running",
      skillId: "skills:1",
      skillVersionId: "skillVersions:1",
      status: "running",
      source: "scan",
      priority: 0,
      nextRunAt: now - 100,
      attempts: 1,
      leaseToken: "old-lease",
      leaseExpiresAt: now + 60_000,
      createdAt: now - 200,
      updatedAt: now - 100,
    };
    const queuedSameVersion = {
      _id: "skillCardGenerationJobs:queued-same",
      skillId: "skills:1",
      skillVersionId: "skillVersions:1",
      status: "queued",
      source: "scan",
      priority: 10,
      nextRunAt: now - 10,
      attempts: 0,
      createdAt: now - 10,
      updatedAt: now - 10,
    };
    const queuedOtherVersion = {
      ...queuedSameVersion,
      _id: "skillCardGenerationJobs:queued-other",
      skillVersionId: "skillVersions:2",
      priority: 1,
    };
    const patch = vi.fn(async () => undefined);
    const ctx = {
      db: completeDb({
        patch,
        query: vi.fn(() => ({
          withIndex: vi.fn(
            (
              name: string,
              build: (q: {
                eq: (...args: unknown[]) => unknown;
                lte: (...args: unknown[]) => unknown;
              }) => unknown,
            ) => {
              const q = {
                eq: vi.fn(function (this: unknown) {
                  return this;
                }),
                lte: vi.fn(function (this: unknown) {
                  return this;
                }),
              };
              build(q);
              if (name === "by_status_and_lease_expires_at") {
                return { take: vi.fn(async () => [runningJob]) };
              }
              return {
                order: vi.fn(() => ({
                  take: vi.fn(async () => [queuedSameVersion, queuedOtherVersion]),
                })),
              };
            },
          ),
        })),
      }),
    };

    const claimed = await claimQueuedHandler(ctx, {
      workerId: "worker",
      limit: 10,
      leaseMs: 60_000,
    });

    expect(claimed.map((job) => job._id)).toEqual(["skillCardGenerationJobs:queued-other"]);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(
      "skillCardGenerationJobs:queued-other",
      expect.objectContaining({ status: "running", workerId: "worker" }),
    );
    expect(patch).not.toHaveBeenCalledWith(
      "skillCardGenerationJobs:queued-same",
      expect.anything(),
    );
  });

  it("caps global running Skill Card claims at security-worker parity", async () => {
    const now = Date.now();
    const queuedJobs = Array.from({ length: 80 }, (_, index) => ({
      _id: `skillCardGenerationJobs:${index}`,
      skillId: `skills:${index}`,
      skillVersionId: `skillVersions:${index}`,
      status: "queued",
      source: "scan",
      priority: 0,
      nextRunAt: now - index - 1,
      attempts: 0,
      createdAt: now - index - 1,
      updatedAt: now - index - 1,
    }));
    const patch = vi.fn(async () => undefined);
    const ctx = {
      db: completeDb({
        patch,
        query: vi.fn(() => ({
          withIndex: vi.fn(
            (
              name: string,
              build: (q: {
                eq: (...args: unknown[]) => unknown;
                lte: (...args: unknown[]) => unknown;
              }) => unknown,
            ) => {
              const q = {
                eq: vi.fn(function (this: unknown) {
                  return this;
                }),
                lte: vi.fn(function (this: unknown) {
                  return this;
                }),
              };
              build(q);
              if (name === "by_status_and_lease_expires_at") {
                return { take: vi.fn(async () => []) };
              }
              return {
                order: vi.fn(() => ({
                  take: vi.fn(async () => queuedJobs),
                })),
              };
            },
          ),
        })),
      }),
    };

    const claimed = await claimQueuedHandler(ctx, {
      workerId: "worker",
      limit: 80,
      leaseMs: 60_000,
    });

    expect(claimed).toHaveLength(64);
    expect(patch).toHaveBeenCalledTimes(64);
  });

  it("uses the same default queued job lease as the security worker", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
    const now = Date.now();
    const queuedJob = {
      _id: "skillCardGenerationJobs:queued",
      skillId: "skills:1",
      skillVersionId: "skillVersions:1",
      status: "queued",
      source: "scan",
      priority: 0,
      nextRunAt: now - 1,
      attempts: 0,
      createdAt: now - 1,
      updatedAt: now - 1,
    };
    const patch = vi.fn(async () => undefined);
    const ctx = {
      db: completeDb({
        patch,
        query: vi.fn(() => ({
          withIndex: vi.fn(
            (
              name: string,
              build: (q: {
                eq: (...args: unknown[]) => unknown;
                lte: (...args: unknown[]) => unknown;
              }) => unknown,
            ) => {
              const q = {
                eq: vi.fn(function (this: unknown) {
                  return this;
                }),
                lte: vi.fn(function (this: unknown) {
                  return this;
                }),
              };
              build(q);
              if (name === "by_status_and_lease_expires_at") {
                return { take: vi.fn(async () => []) };
              }
              return {
                order: vi.fn(() => ({
                  take: vi.fn(async () => [queuedJob]),
                })),
              };
            },
          ),
        })),
      }),
    };

    try {
      await claimQueuedHandler(ctx, {
        workerId: "worker",
        limit: 1,
      });
    } finally {
      vi.useRealTimers();
    }

    expect(patch).toHaveBeenCalledWith(
      "skillCardGenerationJobs:queued",
      expect.objectContaining({
        leaseExpiresAt: now + 60 * 60 * 1000,
      }),
    );
  });

  it("generation failure is non-blocking and retryable", async () => {
    const patch = vi.fn(async () => undefined);
    const ctx = {
      db: completeDb({
        get: vi.fn(async () => ({
          _id: "skillCardGenerationJobs:1",
          leaseToken: "lease",
          attempts: 1,
          nextRunAt: 1,
        })),
        patch,
      }),
    };

    const result = await failHandler(ctx, {
      jobId: "skillCardGenerationJobs:1",
      leaseToken: "lease",
      error: "renderer failed",
    });

    expect(result).toEqual({ ok: true, retry: true });
    expect(patch).toHaveBeenCalledWith(
      "skillCardGenerationJobs:1",
      expect.objectContaining({
        status: "queued",
        lastError: "renderer failed",
      }),
    );
  });

  it("redacts worker failure details before persistence", async () => {
    const patch = vi.fn(async (_id: string, _patch: Record<string, unknown>) => undefined);
    const ctx = {
      db: completeDb({
        get: vi.fn(async () => ({
          _id: "skillCardGenerationJobs:1",
          leaseToken: "lease",
          attempts: 3,
          nextRunAt: 1,
        })),
        patch,
      }),
    };

    const result = await failHandler(ctx, {
      jobId: "skillCardGenerationJobs:1",
      leaseToken: "lease",
      error:
        "Download failed 403: https://signed.example.invalid/file?token=secret " +
        "Authorization: Bearer worker-secret OPENAI_API_KEY=openai-runtime-secret " +
        "path=artifacts/token=artifact-path-secret.json",
    });

    expect(result).toEqual({ ok: true, retry: false });
    expect(patch).toHaveBeenCalledWith(
      "skillCardGenerationJobs:1",
      expect.objectContaining({
        status: "failed",
        lastError: expect.any(String),
      }),
    );
    const patchPayload = patch.mock.calls[0]?.[1] as { lastError?: unknown } | undefined;
    const lastError = String(patchPayload?.lastError);
    expect(lastError).toContain("Download failed 403");
    expect(lastError).not.toContain("https://");
    expect(lastError).not.toContain("signed.example.invalid");
    expect(lastError).not.toContain("token=secret");
    expect(lastError).not.toContain("Authorization");
    expect(lastError).not.toContain("worker-secret");
    expect(lastError).not.toContain("openai-runtime-secret");
    expect(lastError).not.toContain("artifact-path-secret");
    expect(lastError).toContain("OPENAI_API_KEY=[redacted-secret]");
  });
});

describe("skillCards attach", () => {
  it("rejects generated Skill Cards over the public reader size limit", async () => {
    const previousToken = process.env.SECURITY_SCAN_WORKER_TOKEN;
    process.env.SECURITY_SCAN_WORKER_TOKEN = "test-worker-token";
    const markdown = `${"x".repeat(200 * 1024)}x`;
    const store = vi.fn(async () => "_storage:card");
    const runMutation = vi.fn(async () => ({ ok: true }));

    await expect(
      completeHandler(
        {
          storage: { store },
          runMutation,
        },
        {
          token: "test-worker-token",
          jobId: "skillCardGenerationJobs:1",
          leaseToken: "lease",
          markdown,
        },
      ),
    ).rejects.toThrow(/200KB/);

    expect(store).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
    process.env.SECURITY_SCAN_WORKER_TOKEN = previousToken;
  });

  it("deletes the stored card blob when attach fails", async () => {
    const previousToken = process.env.SECURITY_SCAN_WORKER_TOKEN;
    process.env.SECURITY_SCAN_WORKER_TOKEN = "test-worker-token";
    const store = vi.fn(async () => "_storage:new-card");
    const deleteStorage = vi.fn(async () => undefined);
    const runMutation = vi.fn(async () => {
      throw new Error("Lease mismatch");
    });

    await expect(
      completeHandler(
        {
          storage: { store, delete: deleteStorage },
          runMutation,
        },
        {
          token: "test-worker-token",
          jobId: "skillCardGenerationJobs:1",
          leaseToken: "stale-lease",
          markdown: "# Card\n",
        },
      ),
    ).rejects.toThrow(/Lease mismatch/);

    expect(store).toHaveBeenCalledOnce();
    expect(deleteStorage).toHaveBeenCalledWith("_storage:new-card");
    process.env.SECURITY_SCAN_WORKER_TOKEN = previousToken;
  });

  it("keeps the stored card blob when attach succeeds", async () => {
    const previousToken = process.env.SECURITY_SCAN_WORKER_TOKEN;
    process.env.SECURITY_SCAN_WORKER_TOKEN = "test-worker-token";
    const store = vi.fn(async () => "_storage:new-card");
    const deleteStorage = vi.fn(async () => undefined);
    const runMutation = vi.fn(async () => ({ ok: true, bundleFingerprint: "fp" }));

    await expect(
      completeHandler(
        {
          storage: { store, delete: deleteStorage },
          runMutation,
        },
        {
          token: "test-worker-token",
          jobId: "skillCardGenerationJobs:1",
          leaseToken: "lease",
          markdown: "# Card\n",
        },
      ),
    ).resolves.toEqual({ ok: true, bundleFingerprint: "fp" });

    expect(deleteStorage).not.toHaveBeenCalled();
    process.env.SECURITY_SCAN_WORKER_TOKEN = previousToken;
  });

  it("replaces skill-card.md, preserves source and prior bundle fingerprints, and inserts current bundle fingerprint", async () => {
    const version = makeSettledVersion({
      files: [
        {
          path: "SKILL.md",
          size: 12,
          storageId: "_storage:skill",
          sha256: "a".repeat(64),
          contentType: "text/markdown",
        },
        {
          path: "skill-card.md",
          size: 9,
          storageId: "_storage:old-card",
          sha256: "b".repeat(64),
          contentType: "text/markdown",
        },
      ],
    });
    const job = {
      _id: "skillCardGenerationJobs:1",
      skillVersionId: "skillVersions:1",
      leaseToken: "lease",
    };
    const patch = vi.fn(async () => undefined);
    const delete_ = vi.fn(async () => undefined);
    const insert = vi.fn(async () => "skillVersionFingerprints:1");
    const get = vi.fn(async (id: string) => {
      if (id === "skillCardGenerationJobs:1") return job;
      if (id === "skillVersions:1") return version;
      return null;
    });
    const ctx = {
      db: completeDb({
        get,
        patch,
        insert,
        delete: delete_,
        query: vi.fn(() =>
          makeQueryWithCollect([
            {
              _id: "skillVersionFingerprints:old-bundle",
              versionId: "skillVersions:1",
              fingerprint: "d".repeat(64),
              kind: "generated-bundle",
            },
          ]),
        ),
      }),
    };
    const expectedBundleFingerprint = await hashSkillFiles([
      { path: "SKILL.md", sha256: "a".repeat(64) },
      { path: "skill-card.md", sha256: "c".repeat(64) },
    ]);

    const result = await attachHandler(ctx, {
      jobId: "skillCardGenerationJobs:1",
      leaseToken: "lease",
      cardFile: {
        path: "skill-card.md",
        size: 20,
        storageId: "_storage:new-card",
        sha256: "c".repeat(64),
        contentType: "text/markdown",
      },
    });

    expect(result.bundleFingerprint).toBe(expectedBundleFingerprint);
    expect(patch).toHaveBeenCalledWith(
      "skillVersions:1",
      expect.objectContaining({
        files: [
          expect.objectContaining({ path: "SKILL.md", sha256: "a".repeat(64) }),
          expect.objectContaining({ path: "skill-card.md", sha256: "c".repeat(64) }),
        ],
      }),
    );
    expect(patch).not.toHaveBeenCalledWith(
      "skillVersions:1",
      expect.objectContaining({ fingerprint: expect.anything() }),
    );
    expect(delete_).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith(
      "skillVersionFingerprints",
      expect.objectContaining({
        skillId: "skills:1",
        versionId: "skillVersions:1",
        fingerprint: expectedBundleFingerprint,
        kind: "generated-bundle",
      }),
    );
  });
});
