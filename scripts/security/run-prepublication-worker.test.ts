/* @vitest-environment node */
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import {
  DEFAULT_PREPUBLICATION_CLAWSCAN_TIMEOUT_MS,
  claimBatchDrainedQueue,
  claimPrePublicationAttempt,
  claimPrePublicationBatch,
  parseArgs,
  processPrePublicationBatch,
  processPrePublicationAttempt,
  runNativeClawScan,
  resolveTruffleHogImage,
  runNativeTruffleHog,
} from "./run-prepublication-worker";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "clawhub-prepublication-worker-test-"));
  tempDirs.push(dir);
  return dir;
}

async function readStartedPid(path: string) {
  while (true) {
    const contents = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (contents) return Number(contents);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  }
}

const attempt = {
  attemptId: "publishAttempts:test" as Id<"publishAttempts">,
  claimId: "claim-test",
  kind: "skill" as const,
  slug: "demo-skill",
  displayName: "Demo Skill",
  version: "1.2.3",
  artifactFingerprint: "f".repeat(64),
  checkClaimExpiresAt: Date.now() + 60_000,
  createdAt: Date.now(),
  files: [
    {
      path: "SKILL.md",
      size: 12,
      sha256: "a".repeat(64),
      url: "https://signed.example.invalid/skill-md?token=secret",
      contentType: "text/markdown",
    },
  ],
};

describe("pre-publication worker", () => {
  it("allows production ClawScan runs up to 15 minutes by default", () => {
    expect(DEFAULT_PREPUBLICATION_CLAWSCAN_TIMEOUT_MS).toBe(900_000);
  });

  it("treats empty scheduled recovery flags as absent", () => {
    expect(
      parseArgs(
        [
          "--batch-limit",
          "2",
          "--max-jobs",
          "--max-runtime-minutes",
          "8",
          "--attempt-id",
          "--kind",
          "--slug",
          "--version",
        ],
        {},
      ),
    ).toEqual({
      batchLimit: 2,
      maxJobs: undefined,
      maxRuntimeMs: 8 * 60 * 1000,
      claimFilters: {
        attemptId: undefined,
        kind: undefined,
        slug: undefined,
        version: undefined,
      },
    });
  });

  it("parses populated targeted recovery inputs", () => {
    expect(
      parseArgs(
        [
          "--batch-limit",
          "1",
          "--max-jobs",
          "1",
          "--max-runtime-minutes",
          "12",
          "--attempt-id",
          "publishAttempts:driver",
          "--kind",
          "skill",
          "--slug",
          "driver",
          "--version",
          "0.8.3",
        ],
        {},
      ),
    ).toEqual({
      batchLimit: 1,
      maxJobs: 1,
      maxRuntimeMs: 12 * 60 * 1000,
      claimFilters: {
        attemptId: "publishAttempts:driver",
        kind: "skill",
        slug: "driver",
        version: "0.8.3",
      },
    });
  });

  it("forwards targeted recovery filters when claiming an attempt", async () => {
    const client = {
      action: vi.fn().mockResolvedValue(attempt),
    };

    await expect(
      claimPrePublicationAttempt(client, "fixture", {
        kind: "skill",
        slug: "driver",
        version: "0.8.3",
      }),
    ).resolves.toEqual(attempt);

    expect(client.action).toHaveBeenCalledWith(expect.anything(), {
      token: "fixture",
      kind: "skill",
      slug: "driver",
      version: "0.8.3",
    });
  });

  it("keeps claiming after partial transient claim failures", () => {
    expect(claimBatchDrainedQueue(0, 0, 6)).toBe(true);
    expect(claimBatchDrainedQueue(0, 5, 6)).toBe(true);
    expect(claimBatchDrainedQueue(1, 5, 6)).toBe(false);
    expect(claimBatchDrainedQueue(0, 6, 6)).toBe(false);
  });

  it("requires the TruffleHog image to be pinned by digest", () => {
    expect(resolveTruffleHogImage()).toContain("@sha256:");
    expect(() => resolveTruffleHogImage("ghcr.io/trufflesecurity/trufflehog:3.95.6")).toThrow(
      "must be pinned",
    );
  });

  it("completes clean staged publishes after TruffleHog and ClawScan pass", async () => {
    const client = {
      action: vi.fn().mockResolvedValue({ status: "finalized" }),
    };
    const runTruffleHog = vi.fn().mockResolvedValue({
      exitCode: 0,
      status: "clean",
      summary: "TruffleHog found no verified secrets.",
    });
    const runClawScan = vi.fn().mockResolvedValue({
      aigAnalysis: {
        checkedAt: 123,
        findings: [],
        issueCount: 0,
        scannerVersion: "0.2.1",
        status: "clean",
        summary: "A.I.G reported 0 findings.",
      },
      analysis: {
        checkedAt: 123,
        confidence: "high",
        status: "clean",
        summary: "ClawScan passed.",
        verdict: "benign",
      },
      check: {
        status: "clean",
        summary: "ClawScan passed.",
      },
    });

    await expect(
      processPrePublicationAttempt(client, "worker-token", attempt, {
        runClawScan,
        runTruffleHog,
        writeWorkspace: vi.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toMatchObject({ completed: true });

    expect(runTruffleHog).toHaveBeenCalledTimes(1);
    expect(runClawScan).toHaveBeenCalledTimes(1);
    expect(client.action).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        artifactFingerprint: attempt.artifactFingerprint,
        attemptId: attempt.attemptId,
        claimId: attempt.claimId,
        token: "worker-token",
        trufflehog: { status: "clean", summary: "TruffleHog found no verified secrets." },
        clawscan: expect.objectContaining({ status: "clean" }),
        aigAnalysis: expect.objectContaining({ status: "clean", issueCount: 0 }),
      }),
    );
    expect(client.action.mock.calls[0]?.[1].trufflehog).not.toHaveProperty("exitCode");
  });

  it("reuses a completed ClawScan verdict from the exact staged artifact", async () => {
    const client = {
      action: vi.fn().mockResolvedValue({ status: "finalized" }),
    };
    const runTruffleHog = vi.fn().mockResolvedValue({
      exitCode: 0,
      status: "clean",
      summary: "TruffleHog found no verified secrets.",
    });
    const runClawScan = vi.fn();
    const existingClawscanAnalysis = {
      checkedAt: 123,
      confidence: "high",
      status: "suspicious",
      summary: "Exact-artifact ClawScan review.",
      verdict: "suspicious",
    };
    const existingAigAnalysis = {
      checkedAt: 123,
      findings: [],
      issueCount: 0,
      scannerVersion: "0.2.1",
      status: "clean",
      summary: "A.I.G reported 0 findings.",
    };

    await expect(
      processPrePublicationAttempt(
        client,
        "worker-token",
        { ...attempt, existingAigAnalysis, existingClawscanAnalysis },
        {
          runClawScan,
          runTruffleHog,
          writeWorkspace: vi.fn().mockResolvedValue(undefined),
        },
      ),
    ).resolves.toMatchObject({ completed: true });

    expect(runTruffleHog).toHaveBeenCalledTimes(1);
    expect(runClawScan).not.toHaveBeenCalled();
    expect(client.action).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        clawscan: expect.objectContaining({ status: "clean" }),
        aigAnalysis: existingAigAnalysis,
        clawscanAnalysis: existingClawscanAnalysis,
      }),
    );
  });

  it("rescans exact artifacts when cached A.I.G and ClawScan runs differ", async () => {
    const client = {
      action: vi.fn().mockResolvedValue({ status: "finalized" }),
    };
    const runClawScan = vi.fn().mockResolvedValue({
      aigAnalysis: {
        checkedAt: 456,
        findings: [],
        issueCount: 0,
        scannerVersion: "0.2.1",
        status: "clean",
        summary: "A.I.G reported 0 findings.",
      },
      analysis: {
        checkedAt: 456,
        confidence: "high",
        status: "clean",
        summary: "Fresh ClawScan review.",
        verdict: "benign",
      },
      check: { status: "clean", summary: "Fresh ClawScan review." },
    });

    await expect(
      processPrePublicationAttempt(
        client,
        "worker-token",
        {
          ...attempt,
          existingAigAnalysis: {
            checkedAt: 122,
            findings: [],
            issueCount: 0,
            scannerVersion: "0.2.1",
            status: "clean",
            summary: "A.I.G reported 0 findings.",
          },
          existingClawscanAnalysis: {
            checkedAt: 123,
            confidence: "high",
            status: "clean",
            summary: "Legacy exact-artifact review.",
            verdict: "benign",
          },
        },
        {
          runClawScan,
          runTruffleHog: vi.fn().mockResolvedValue({
            status: "clean",
            summary: "TruffleHog found no verified secrets.",
          }),
          writeWorkspace: vi.fn().mockResolvedValue(undefined),
        },
      ),
    ).resolves.toMatchObject({ completed: true });

    expect(runClawScan).toHaveBeenCalledTimes(1);
    expect(client.action).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        aigAnalysis: expect.objectContaining({ checkedAt: 456, status: "clean" }),
        clawscanAnalysis: expect.objectContaining({ checkedAt: 456 }),
      }),
    );
  });

  it("rescans legacy skill artifacts that have no cached A.I.G evidence", async () => {
    const client = {
      action: vi.fn().mockResolvedValue({ status: "finalized" }),
    };
    const runClawScan = vi.fn().mockResolvedValue({
      aigAnalysis: {
        checkedAt: 456,
        findings: [],
        issueCount: 0,
        scannerVersion: "0.2.1",
        status: "clean",
        summary: "A.I.G reported 0 findings.",
      },
      analysis: {
        checkedAt: 456,
        confidence: "high",
        status: "clean",
        summary: "Fresh ClawScan review.",
        verdict: "benign",
      },
      check: { status: "clean", summary: "Fresh ClawScan review." },
    });

    await processPrePublicationAttempt(
      client,
      "worker-token",
      {
        ...attempt,
        existingClawscanAnalysis: {
          checkedAt: 123,
          confidence: "high",
          status: "clean",
          summary: "Legacy exact-artifact review.",
          verdict: "benign",
        },
      },
      {
        runClawScan,
        runTruffleHog: vi.fn().mockResolvedValue({
          status: "clean",
          summary: "TruffleHog found no verified secrets.",
        }),
        writeWorkspace: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(runClawScan).toHaveBeenCalledTimes(1);
    expect(client.action).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        aigAnalysis: expect.objectContaining({ checkedAt: 456, status: "clean" }),
        clawscanAnalysis: expect.objectContaining({ checkedAt: 456 }),
      }),
    );
  });

  it("publishes suspicious staged artifacts without treating them as malicious", async () => {
    const client = {
      action: vi.fn().mockResolvedValue({ status: "finalized" }),
    };

    await expect(
      processPrePublicationAttempt(client, "worker-token", attempt, {
        runClawScan: vi.fn().mockResolvedValue({
          analysis: {
            checkedAt: 123,
            confidence: "high",
            status: "suspicious",
            summary: "The artifact needs moderator review.",
            verdict: "suspicious",
          },
          check: {
            status: "clean",
            summary: "The artifact needs moderator review.",
            redactedFindings: ["status=suspicious; verdict=suspicious"],
          },
        }),
        runTruffleHog: vi.fn().mockResolvedValue({
          status: "clean",
          summary: "TruffleHog found no verified secrets.",
        }),
        writeWorkspace: vi.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toMatchObject({ completed: true });

    expect(client.action).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        clawscan: {
          status: "clean",
          summary: "The artifact needs moderator review.",
          redactedFindings: ["status=suspicious; verdict=suspicious"],
        },
        clawscanAnalysis: expect.objectContaining({
          status: "suspicious",
          verdict: "suspicious",
        }),
      }),
    );
  });

  it("keeps malicious staged artifacts private", async () => {
    const client = {
      action: vi.fn().mockResolvedValue({ status: "blocked" }),
    };

    await expect(
      processPrePublicationAttempt(client, "worker-token", attempt, {
        runClawScan: vi.fn().mockResolvedValue({
          analysis: {
            checkedAt: 123,
            confidence: "high",
            status: "malicious",
            summary: "The artifact contains intentional credential exfiltration.",
            verdict: "malicious",
          },
          check: {
            status: "blocked",
            summary: "The artifact contains intentional credential exfiltration.",
            redactedFindings: ["status=malicious; verdict=malicious"],
          },
        }),
        runTruffleHog: vi.fn().mockResolvedValue({
          status: "clean",
          summary: "TruffleHog found no verified secrets.",
        }),
        writeWorkspace: vi.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toMatchObject({ completed: true });

    expect(client.action).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        clawscan: expect.objectContaining({
          status: "blocked",
          redactedFindings: ["status=malicious; verdict=malicious"],
        }),
        clawscanAnalysis: expect.objectContaining({
          status: "malicious",
          verdict: "malicious",
        }),
      }),
    );
  });

  it("continues later attempts when one attempt throws", async () => {
    const laterAttempt = {
      ...attempt,
      attemptId: "publishAttempts:later" as Id<"publishAttempts">,
    };
    const processAttempt = vi
      .fn()
      .mockRejectedValueOnce(new Error("finalization conflict"))
      .mockResolvedValueOnce({ completed: true });

    await expect(
      processPrePublicationBatch([attempt, laterAttempt], processAttempt),
    ).resolves.toEqual([{ completed: false, result: undefined }, { completed: true }]);
    expect(processAttempt).toHaveBeenCalledTimes(2);
  });

  it("continues with successful claims when a concurrent claim fails", async () => {
    const client = {
      action: vi
        .fn()
        .mockRejectedValueOnce(new Error("claim conflict"))
        .mockResolvedValueOnce(attempt),
    };

    await expect(claimPrePublicationBatch(client, "worker-token", 2)).resolves.toEqual({
      attempts: [attempt],
      claimFailures: 1,
    });
    expect(client.action).toHaveBeenCalledTimes(2);
  });

  it("reserves one batch claim for expired retries, including filtered batches", async () => {
    const client = {
      action: vi.fn().mockResolvedValue(null),
    };

    await expect(
      claimPrePublicationBatch(client, "worker-token", 4, { kind: "skill" }),
    ).resolves.toEqual({
      attempts: [],
      claimFailures: 0,
    });
    expect(client.action.mock.calls.map(([, args]) => args.preferRetry)).toEqual([
      true,
      undefined,
      undefined,
      undefined,
    ]);
    expect(client.action).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "skill", preferRetry: true }),
    );
  });

  it("fails the worker batch when claims fail without claiming work", async () => {
    const client = {
      action: vi
        .fn()
        .mockRejectedValueOnce(new Error("claim conflict"))
        .mockResolvedValueOnce(null),
    };

    await expect(claimPrePublicationBatch(client, "worker-token", 2)).rejects.toThrow(
      "Pre-publication claims failed without claiming work.",
    );
  });

  it("blocks secret-positive attempts without running ClawScan", async () => {
    const client = {
      action: vi.fn().mockResolvedValue({ status: "blocked" }),
    };
    const runTruffleHog = vi.fn().mockResolvedValue({
      status: "blocked",
      summary: "TruffleHog found verified secret material.",
      redactedFindings: ["GitHub token in filesystem"],
    });
    const runClawScan = vi.fn();

    await expect(
      processPrePublicationAttempt(client, "worker-token", attempt, {
        runClawScan,
        runTruffleHog,
        writeWorkspace: vi.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toMatchObject({ completed: true });

    expect(runClawScan).not.toHaveBeenCalled();
    expect(client.action).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        trufflehog: expect.objectContaining({
          redactedFindings: ["GitHub token in filesystem"],
          status: "blocked",
        }),
        clawscan: expect.objectContaining({
          status: "failed",
          summary: expect.stringContaining("skipped"),
        }),
      }),
    );
  });

  it("does not downgrade TruffleHog-positive attempts when blocked cleanup completion fails", async () => {
    const client = {
      action: vi.fn().mockRejectedValue(new Error("storage unavailable")),
    };
    const runTruffleHog = vi.fn().mockResolvedValue({
      status: "blocked",
      summary: "TruffleHog found verified secret material.",
      redactedFindings: ["GitHub token in filesystem"],
    });

    await expect(
      processPrePublicationAttempt(client, "worker-token", attempt, {
        runClawScan: vi.fn(),
        runTruffleHog,
        writeWorkspace: vi.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toMatchObject({ completed: false, result: undefined });

    expect(client.action).toHaveBeenCalledTimes(1);
    expect(client.action).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        trufflehog: expect.objectContaining({ status: "blocked" }),
        clawscan: expect.objectContaining({
          status: "failed",
          summary: expect.stringContaining("skipped"),
        }),
      }),
    );
  });

  it("retries ready-to-finalize attempts without rerunning scanners", async () => {
    const client = {
      action: vi.fn().mockResolvedValue({ status: "finalized" }),
    };
    const runClawScan = vi.fn();
    const runTruffleHog = vi.fn();
    const writeWorkspace = vi.fn();

    await expect(
      processPrePublicationAttempt(
        client,
        "worker-token",
        { ...attempt, status: "ready_to_finalize", files: [] },
        {
          runClawScan,
          runTruffleHog,
          writeWorkspace,
        },
      ),
    ).resolves.toMatchObject({ completed: true });

    expect(writeWorkspace).not.toHaveBeenCalled();
    expect(runTruffleHog).not.toHaveBeenCalled();
    expect(runClawScan).not.toHaveBeenCalled();
    expect(client.action).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        attemptId: attempt.attemptId,
        trufflehog: expect.objectContaining({ status: "clean" }),
        clawscan: expect.objectContaining({ status: "clean" }),
      }),
    );
  });

  it("passes package ClawPack and manifest context into the ClawScan job", async () => {
    const packageAttempt = {
      ...attempt,
      kind: "package" as const,
      slug: "demo-plugin",
      displayName: "Demo Plugin",
      artifactFingerprint: "b".repeat(64),
      clawpackUrl: "https://signed.example.invalid/package.tgz?token=secret",
      scanContext: {
        trustedOpenClawPlugin: true,
        release: {
          artifactKind: "npm-pack",
          pluginManifestSummary: {
            bundledSkills: [{ rootPath: "skills/demo" }],
          },
          staticScan: { status: "clean" },
        },
      },
    };
    const client = {
      action: vi.fn().mockResolvedValue({ status: "finalized" }),
    };
    const writeWorkspace = vi.fn().mockResolvedValue(undefined);

    await expect(
      processPrePublicationAttempt(client, "worker-token", packageAttempt, {
        runClawScan: vi.fn().mockResolvedValue({
          analysis: {
            checkedAt: 123,
            confidence: "high",
            status: "clean",
            summary: "ClawScan passed.",
            verdict: "benign",
          },
          check: {
            status: "clean",
            summary: "ClawScan passed.",
          },
        }),
        runTruffleHog: vi.fn().mockResolvedValue({
          status: "clean",
          summary: "TruffleHog found no verified secrets.",
        }),
        writeWorkspace,
      }),
    ).resolves.toMatchObject({ completed: true });

    expect(writeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ targetKind: "packageRelease" }),
        target: expect.objectContaining({
          clawpackUrl: packageAttempt.clawpackUrl,
          trustedOpenClawPlugin: true,
          release: expect.objectContaining({
            artifactKind: "npm-pack",
            integritySha256: packageAttempt.artifactFingerprint,
            pluginManifestSummary: packageAttempt.scanContext.release.pluginManifestSummary,
          }),
        }),
      }),
      expect.any(String),
    );
  });

  it("marks attempts failed when staged artifact URLs are unavailable", async () => {
    const client = {
      action: vi.fn().mockResolvedValue({ status: "failed" }),
    };

    await expect(
      processPrePublicationAttempt(
        client,
        "worker-token",
        {
          ...attempt,
          files: [{ ...attempt.files[0], url: null }],
        },
        {
          runClawScan: vi.fn(),
          runTruffleHog: vi.fn(),
          writeWorkspace: vi.fn().mockResolvedValue(undefined),
        },
      ),
    ).resolves.toMatchObject({ completed: false });

    expect(client.action).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        trufflehog: expect.objectContaining({
          status: "failed",
          summary: expect.stringContaining("Artifact file unavailable"),
        }),
        clawscan: expect.objectContaining({
          status: "failed",
          summary: expect.stringContaining("Artifact file unavailable"),
        }),
      }),
    );
  });

  it("records deterministic check failures for unsupported Python bytecode", async () => {
    const client = {
      action: vi.fn().mockResolvedValue({ status: "failed" }),
    };
    const runClawScan = vi.fn();
    const runTruffleHog = vi.fn();

    const result = await processPrePublicationAttempt(
      client,
      "worker-token",
      {
        ...attempt,
        files: [{ ...attempt.files[0], path: "payload.pyc" }],
      },
      {
        runClawScan,
        runTruffleHog,
        writeWorkspace: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(result.completed).toBe(false);
    expect(result.result).toEqual({ status: "failed" });

    expect(runTruffleHog).not.toHaveBeenCalled();
    expect(runClawScan).not.toHaveBeenCalled();
    const payload = client.action.mock.calls[0]?.[1] as {
      clawscan: { status: string; summary?: string };
      trufflehog: { status: string; summary?: string };
    };
    expect(payload.trufflehog.status).toBe("failed");
    expect(payload.trufflehog.summary).toContain("Python bytecode");
    expect(payload.clawscan.status).toBe("failed");
    expect(payload.clawscan.summary).toContain("Python bytecode");
  });

  it("runs the required skill scan with an explicit manifest for a dual-layout artifact", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, "artifact"), { recursive: true });
    await writeFile(join(workspace, "artifact", "SKILL.md"), "# Demo\n");
    await writeFile(join(workspace, "artifact", "openclaw.plugin.json"), '{"id":"demo"}\n');
    const fakeClawScan = join(workspace, "fake-clawscan");
    await writeFile(
      fakeClawScan,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "${workspace}/clawscan-args.txt"
printf '%s\n' "\${SECURITY_SCAN_WORKER_TOKEN-}" > "${workspace}/clawscan-worker-token.txt"
printf '%s\n' "\${DEFAULT_BASE_URL-}" > "${workspace}/clawscan-default-base-url.txt"
printf '%s\n' "\${OPENAI_BASE_URL-}" > "${workspace}/clawscan-openai-base-url.txt"
printf '%s\n' "\${OPENAI_API_KEY-}" > "${workspace}/clawscan-provider-key.txt"
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    output="$2"
    break
  fi
  shift
done
cat > "$output" <<'JSON'
{"schemaVersion":"clawscan-run-v1","profile":"clawhub","scanners":{"aig":{"status":"completed","raw":{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"aig-skill-scan","version":"0.2.1"}},"results":[]}]}},"clawscan-static":{"status":"completed"},"skillspector":{"status":"completed"}},"judge":{"status":"completed","result":{"verdict":"benign","confidence":"high","summary":"Native ClawScan passed."}}}
JSON
`,
    );
    await chmod(fakeClawScan, 0o755);
    const previousCommand = process.env.PREPUBLICATION_CLAWSCAN_COMMAND;
    const previousSandbox = process.env.PREPUBLICATION_CLAWSCAN_SANDBOX;
    const previousWorkerToken = process.env.SECURITY_SCAN_WORKER_TOKEN;
    const previousDefaultBaseUrl = process.env.DEFAULT_BASE_URL;
    const previousOpenAiBaseUrl = process.env.OPENAI_BASE_URL;
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.PREPUBLICATION_CLAWSCAN_COMMAND = fakeClawScan;
    process.env.PREPUBLICATION_CLAWSCAN_SANDBOX = "off";
    process.env.SECURITY_SCAN_WORKER_TOKEN = "mock-completion-token";
    process.env.DEFAULT_BASE_URL = "https://api.openai.com/v1";
    process.env.OPENAI_BASE_URL = "https://unapproved.example.invalid/v1";
    process.env.OPENAI_API_KEY = "mock-provider-key";

    try {
      await expect(
        runNativeClawScan(
          {
            job: {
              _id: String(attempt.attemptId),
              attempts: 1,
              hasMaliciousSignal: false,
              leaseToken: attempt.claimId,
              source: "pre-publication",
              targetKind: "skillVersion",
              waitForVtUntil: 0,
            },
            target: {},
          },
          workspace,
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          analysis: expect.objectContaining({
            status: "clean",
            verdict: "benign",
          }),
          aigAnalysis: expect.objectContaining({
            issueCount: 0,
            scannerVersion: "0.2.1",
            status: "clean",
          }),
          check: {
            status: "clean",
            summary: "Native ClawScan passed.",
          },
        }),
      );

      const args = await readFile(join(workspace, "clawscan-args.txt"), "utf8");
      expect(args.split("\n")[0]).toBe("./artifact/SKILL.md");
      expect(args).toContain("--profile\nclawhub");
      expect(args).toContain("--output\n");
      expect(args).toContain("--sandbox\noff");
      expect(await readFile(join(workspace, "clawscan-worker-token.txt"), "utf8")).toBe("\n");
      expect(await readFile(join(workspace, "clawscan-default-base-url.txt"), "utf8")).toBe(
        "https://api.openai.com/v1\n",
      );
      expect(await readFile(join(workspace, "clawscan-openai-base-url.txt"), "utf8")).toBe("\n");
      expect(await readFile(join(workspace, "clawscan-provider-key.txt"), "utf8")).toBe(
        "mock-provider-key\n",
      );
      expect(process.env.SECURITY_SCAN_WORKER_TOKEN).toBe("mock-completion-token");
    } finally {
      if (previousCommand === undefined) delete process.env.PREPUBLICATION_CLAWSCAN_COMMAND;
      else process.env.PREPUBLICATION_CLAWSCAN_COMMAND = previousCommand;
      if (previousSandbox === undefined) delete process.env.PREPUBLICATION_CLAWSCAN_SANDBOX;
      else process.env.PREPUBLICATION_CLAWSCAN_SANDBOX = previousSandbox;
      if (previousWorkerToken === undefined) delete process.env.SECURITY_SCAN_WORKER_TOKEN;
      else process.env.SECURITY_SCAN_WORKER_TOKEN = previousWorkerToken;
      if (previousDefaultBaseUrl === undefined) delete process.env.DEFAULT_BASE_URL;
      else process.env.DEFAULT_BASE_URL = previousDefaultBaseUrl;
      if (previousOpenAiBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previousOpenAiBaseUrl;
      if (previousOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiApiKey;
    }
  });

  it.each(["./artifact", "./artifact/package"])(
    "scans the plugin manifest in dual-layout package %s",
    async (packageRoot) => {
      const workspace = await tempDir();
      await mkdir(join(workspace, packageRoot), { recursive: true });
      await writeFile(join(workspace, packageRoot, "package.json"), '{"name":"demo-plugin"}\n');
      await writeFile(
        join(workspace, packageRoot, "openclaw.plugin.json"),
        '{"id":"demo-plugin"}\n',
      );
      await writeFile(join(workspace, packageRoot, "SKILL.md"), "# Bundled skill\n");
      const fakeClawScan = join(workspace, "fake-clawscan");
      await writeFile(
        fakeClawScan,
        `#!/usr/bin/env bash
set -euo pipefail
test "$1" = "${packageRoot}/openclaw.plugin.json"
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    output="$2"
    break
  fi
  shift
done
cat > "$output" <<'JSON'
{"schemaVersion":"clawscan-run-v1","profile":"clawhub","scanners":{"aig":{"status":"skipped"},"clawscan-static":{"status":"completed"},"skillspector":{"status":"completed"}},"judge":{"status":"completed","result":{"verdict":"benign","confidence":"high","summary":"Native ClawScan passed."}}}
JSON
`,
      );
      await chmod(fakeClawScan, 0o755);
      const previousCommand = process.env.PREPUBLICATION_CLAWSCAN_COMMAND;
      process.env.PREPUBLICATION_CLAWSCAN_COMMAND = fakeClawScan;

      try {
        await expect(
          runNativeClawScan(
            {
              job: {
                _id: String(attempt.attemptId),
                attempts: 1,
                hasMaliciousSignal: false,
                leaseToken: attempt.claimId,
                source: "pre-publication",
                targetKind: "packageRelease",
                waitForVtUntil: 0,
              },
              target: {},
            },
            workspace,
          ),
        ).resolves.toEqual({
          analysis: expect.objectContaining({
            status: "clean",
            verdict: "benign",
          }),
          aigAnalysis: undefined,
          check: {
            status: "clean",
            summary: "Native ClawScan passed.",
          },
        });
      } finally {
        if (previousCommand === undefined) delete process.env.PREPUBLICATION_CLAWSCAN_COMMAND;
        else process.env.PREPUBLICATION_CLAWSCAN_COMMAND = previousCommand;
      }
    },
  );

  it("fails closed when a completed skill scan omits a required scanner", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, "artifact"), { recursive: true });
    await writeFile(join(workspace, "artifact", "SKILL.md"), "# Demo\n");
    const fakeClawScan = join(workspace, "fake-clawscan");
    await writeFile(
      fakeClawScan,
      `#!/usr/bin/env bash
set -euo pipefail
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    output="$2"
    break
  fi
  shift
done
cat > "$output" <<'JSON'
{"schemaVersion":"clawscan-run-v1","profile":"clawhub","scanners":{"aig":{"status":"completed","raw":{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"aig-skill-scan","version":"0.2.1"}},"results":[]}]}},"clawscan-static":{"status":"completed"}},"judge":{"status":"completed","result":{"verdict":"benign","confidence":"high","summary":"Native ClawScan passed."}}}
JSON
`,
    );
    await chmod(fakeClawScan, 0o755);
    const previousCommand = process.env.PREPUBLICATION_CLAWSCAN_COMMAND;
    process.env.PREPUBLICATION_CLAWSCAN_COMMAND = fakeClawScan;

    try {
      await expect(
        runNativeClawScan(
          {
            job: {
              _id: String(attempt.attemptId),
              attempts: 1,
              hasMaliciousSignal: false,
              leaseToken: attempt.claimId,
              source: "pre-publication",
              targetKind: "skillVersion",
              waitForVtUntil: 0,
            },
            target: {},
          },
          workspace,
        ),
      ).resolves.toEqual({
        check: {
          status: "failed",
          summary: "ClawScan scanner did not complete: skillspector=missing",
        },
      });
    } finally {
      if (previousCommand === undefined) delete process.env.PREPUBLICATION_CLAWSCAN_COMMAND;
      else process.env.PREPUBLICATION_CLAWSCAN_COMMAND = previousCommand;
    }
  });

  it("preserves a redacted scanner error when a required scanner fails", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, "artifact"), { recursive: true });
    await writeFile(join(workspace, "artifact", "SKILL.md"), "# Demo\n");
    const fakeClawScan = join(workspace, "fake-clawscan");
    await writeFile(
      fakeClawScan,
      `#!/usr/bin/env bash
set -euo pipefail
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    output="$2"
    break
  fi
  shift
done
cat > "$output" <<'JSON'
{"schemaVersion":"clawscan-run-v1","profile":"clawhub","scanners":{"aig":{"status":"failed","error":"provider rejected request with api_key=secret-value"},"clawscan-static":{"status":"completed"},"skillspector":{"status":"completed"}},"judge":{"status":"failed"}}
JSON
`,
    );
    await chmod(fakeClawScan, 0o755);
    const previousCommand = process.env.PREPUBLICATION_CLAWSCAN_COMMAND;
    process.env.PREPUBLICATION_CLAWSCAN_COMMAND = fakeClawScan;

    try {
      await expect(
        runNativeClawScan(
          {
            job: {
              _id: String(attempt.attemptId),
              attempts: 1,
              hasMaliciousSignal: false,
              leaseToken: attempt.claimId,
              source: "pre-publication",
              targetKind: "skillVersion",
              waitForVtUntil: 0,
            },
            target: {},
          },
          workspace,
        ),
      ).resolves.toEqual({
        check: {
          status: "failed",
          summary:
            "ClawScan scanner did not complete: aig=failed (provider rejected request with api_key=[redacted-secret])",
        },
      });
    } finally {
      if (previousCommand === undefined) delete process.env.PREPUBLICATION_CLAWSCAN_COMMAND;
      else process.env.PREPUBLICATION_CLAWSCAN_COMMAND = previousCommand;
    }
  });

  it("fails closed when completed A.I.G output has no SARIF run", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, "artifact"), { recursive: true });
    await writeFile(join(workspace, "artifact", "SKILL.md"), "# Demo\n");
    const fakeClawScan = join(workspace, "fake-clawscan");
    await writeFile(
      fakeClawScan,
      `#!/usr/bin/env bash
set -euo pipefail
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    output="$2"
    break
  fi
  shift
done
cat > "$output" <<'JSON'
{"schemaVersion":"clawscan-run-v1","profile":"clawhub","scanners":{"aig":{"status":"completed","raw":{"version":"2.1.0","runs":[]}},"clawscan-static":{"status":"completed"},"skillspector":{"status":"completed"}},"judge":{"status":"completed","result":{"verdict":"benign","confidence":"high","summary":"Native ClawScan passed."}}}
JSON
`,
    );
    await chmod(fakeClawScan, 0o755);
    const previousCommand = process.env.PREPUBLICATION_CLAWSCAN_COMMAND;
    process.env.PREPUBLICATION_CLAWSCAN_COMMAND = fakeClawScan;

    try {
      await expect(
        runNativeClawScan(
          {
            job: {
              _id: String(attempt.attemptId),
              attempts: 1,
              hasMaliciousSignal: false,
              leaseToken: attempt.claimId,
              source: "pre-publication",
              targetKind: "skillVersion",
              waitForVtUntil: 0,
            },
            target: {},
          },
          workspace,
        ),
      ).resolves.toEqual({
        check: {
          status: "failed",
          summary: "A.I.G SARIF output did not contain a run.",
        },
      });
    } finally {
      if (previousCommand === undefined) delete process.env.PREPUBLICATION_CLAWSCAN_COMMAND;
      else process.env.PREPUBLICATION_CLAWSCAN_COMMAND = previousCommand;
    }
  });

  it("preserves the redacted ClawScan judge failure reason", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, "artifact"), { recursive: true });
    await writeFile(join(workspace, "artifact", "SKILL.md"), "# Demo\n");
    const fakeClawScan = join(workspace, "fake-clawscan");
    await writeFile(
      fakeClawScan,
      `#!/usr/bin/env bash
set -euo pipefail
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    output="$2"
    break
  fi
  shift
done
cat > "$output" <<'JSON'
{"schemaVersion":"clawscan-run-v1","profile":"clawhub","scanners":{"clawscan-static":{"status":"completed"},"skillspector":{"status":"completed"}},"judge":{"status":"failed","error":"Codex request was rate limited.","result":null}}
JSON
`,
    );
    await chmod(fakeClawScan, 0o755);
    const previousCommand = process.env.PREPUBLICATION_CLAWSCAN_COMMAND;
    process.env.PREPUBLICATION_CLAWSCAN_COMMAND = fakeClawScan;

    try {
      await expect(
        runNativeClawScan(
          {
            job: {
              _id: String(attempt.attemptId),
              attempts: 1,
              hasMaliciousSignal: false,
              leaseToken: attempt.claimId,
              source: "pre-publication",
              targetKind: "skillVersion",
              waitForVtUntil: 0,
            },
            target: {},
          },
          workspace,
        ),
      ).resolves.toEqual({
        check: {
          status: "failed",
          summary: "ClawScan judge status was failed: Codex request was rate limited.",
        },
      });
    } finally {
      if (previousCommand === undefined) delete process.env.PREPUBLICATION_CLAWSCAN_COMMAND;
      else process.env.PREPUBLICATION_CLAWSCAN_COMMAND = previousCommand;
    }
  });

  it("terminates the full ClawScan process tree on timeout", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, "artifact"), { recursive: true });
    await writeFile(join(workspace, "artifact", "SKILL.md"), "# Demo\n");
    const fakeClawScan = join(workspace, "fake-clawscan");
    await writeFile(
      fakeClawScan,
      `#!/usr/bin/env bash
set -euo pipefail
(
  trap '' TERM
  exec >/dev/null 2>&1
  while true; do sleep 1; done
) &
child_pid=$!
printf '%s' "$child_pid" > "${workspace}/descendant.pid"
wait "$child_pid"
`,
    );
    await chmod(fakeClawScan, 0o755);
    const descendantPidPath = join(workspace, "descendant.pid");
    const previousCommand = process.env.PREPUBLICATION_CLAWSCAN_COMMAND;
    const previousTimeout = process.env.PREPUBLICATION_CLAWSCAN_TIMEOUT_MS;
    process.env.PREPUBLICATION_CLAWSCAN_COMMAND = fakeClawScan;
    process.env.PREPUBLICATION_CLAWSCAN_TIMEOUT_MS = "500";
    vi.useFakeTimers({ toFake: ["setTimeout"] });

    try {
      const scanPromise = runNativeClawScan(
        {
          job: {
            targetKind: "skillVersion",
          },
          target: {},
        } as Parameters<typeof runNativeClawScan>[0],
        workspace,
      );
      void scanPromise.catch(() => undefined);
      const descendantPid = await readStartedPid(descendantPidPath);
      await vi.advanceTimersByTimeAsync(10_500);
      await expect(scanPromise).rejects.toThrow("timed out");
      vi.useRealTimers();

      let descendantRunning = true;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          // Signal 0 also succeeds for terminated zombies until their parent reaps them.
          const state = execFileSync("ps", ["-o", "state=", "-p", String(descendantPid)], {
            encoding: "utf8",
          }).trim();
          if (state.startsWith("Z")) {
            descendantRunning = false;
            break;
          }
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
        } catch {
          descendantRunning = false;
          break;
        }
      }
      expect(descendantRunning).toBe(false);
    } finally {
      vi.useRealTimers();
      if (previousCommand === undefined) delete process.env.PREPUBLICATION_CLAWSCAN_COMMAND;
      else process.env.PREPUBLICATION_CLAWSCAN_COMMAND = previousCommand;
      if (previousTimeout === undefined) delete process.env.PREPUBLICATION_CLAWSCAN_TIMEOUT_MS;
      else process.env.PREPUBLICATION_CLAWSCAN_TIMEOUT_MS = previousTimeout;
    }
  });

  it("maps TruffleHog verified-secret exit code to a blocked result", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, "artifact"), { recursive: true });
    const fakeTruffleHog = join(workspace, "fake-trufflehog");
    await writeFile(
      fakeTruffleHog,
      `#!/usr/bin/env bash
cat <<'JSON'
{"DetectorName":"GitHub","SourceName":"Filesystem"}
JSON
exit 183
`,
    );
    await chmod(fakeTruffleHog, 0o755);
    const previousCommand = process.env.PREPUBLICATION_TRUFFLEHOG_COMMAND;
    process.env.PREPUBLICATION_TRUFFLEHOG_COMMAND = fakeTruffleHog;

    await expect(runNativeTruffleHog(workspace)).resolves.toMatchObject({
      redactedFindings: ["GitHub in Filesystem"],
      status: "blocked",
    });

    if (previousCommand === undefined) delete process.env.PREPUBLICATION_TRUFFLEHOG_COMMAND;
    else process.env.PREPUBLICATION_TRUFFLEHOG_COMMAND = previousCommand;
  });
});
