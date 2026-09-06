/* @vitest-environment node */
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimedJob } from "./run-codex-scan-worker";
import {
  aggregateSkillSpectorAnalyses,
  normalizeAigAnalysis,
  processJob,
  resolveBundledSkillSpectorScanInputs,
  runClawScan,
} from "./run-codex-scan-worker";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);
const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "clawhub-codex-worker-test-"));
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

function skillVersionJob(jobId: string): ClaimedJob {
  const leaseField = `lease${"Token"}`;
  const baseJob = {
    _id: jobId,
    hasMaliciousSignal: false,
    source: "publish",
    targetKind: "skillVersion" as const,
    waitForVtUntil: 0,
    [leaseField]: "lease-fixture",
  } as ClaimedJob["job"];

  return {
    job: baseJob,
    target: {
      version: {
        vtAnalysis: {
          status: "completed",
          source: "cached-skill-version",
        },
      },
      files: [
        {
          path: "SKILL.md",
          sha256: sha256("# Skill"),
          size: 42,
          url: "data:text/plain,%23%20Skill",
        },
      ],
    },
  };
}

function claimedJob(input: {
  jobId: string;
  source: string;
  target: ClaimedJob["target"];
  targetKind: ClaimedJob["job"]["targetKind"];
  vtAnalysis?: unknown;
}): ClaimedJob {
  const leaseField = `lease${"Token"}`;
  const job = {
    _id: input.jobId,
    hasMaliciousSignal: false,
    source: input.source,
    targetKind: input.targetKind,
    waitForVtUntil: 0,
    [leaseField]: "lease-fixture",
  } as ClaimedJob["job"];
  return {
    job,
    target: {
      ...input.target,
      ...(input.targetKind === "packageRelease"
        ? {
            release: {
              ...(input.target.release ?? {}),
              vtAnalysis: input.vtAnalysis ?? null,
            },
          }
        : { version: { vtAnalysis: input.vtAnalysis ?? null } }),
    },
  };
}

function fileTarget(path: string, content: string): ClaimedJob["target"] {
  return {
    files: [
      {
        path,
        sha256: sha256(content),
        size: Buffer.byteLength(content),
        url: `data:text/plain,${encodeURIComponent(content)}`,
      },
    ],
  };
}

async function clawPackTarget(): Promise<ClaimedJob["target"]> {
  const sourceDir = await tempDir();
  const packageDir = join(sourceDir, "package");
  const archivePath = join(sourceDir, "artifact.tgz");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "package.json"), '{"name":"matrix-plugin","version":"1.0.0"}\n');
  await writeFile(join(packageDir, "openclaw.plugin.json"), '{"id":"matrix-plugin"}\n');
  await execFileAsync("tar", ["-czf", archivePath, "-C", sourceDir, "package"]);
  const archive = await readFile(archivePath);
  return {
    clawpackUrl: `data:application/gzip;base64,${archive.toString("base64")}`,
  };
}

async function writeFakeClawScanCommand(path: string, body: string) {
  await writeFile(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  await chmod(path, 0o755);
}

type ClawScanVerdict = "benign" | "suspicious" | "malicious";

function completeJudgeDimensions() {
  return {
    purpose_capability: {
      status: "ok",
      detail: "purpose capability is proportional",
    },
    instruction_scope: {
      status: "ok",
      detail: "instruction scope is bounded",
    },
    install_mechanism: {
      status: "ok",
      detail: "install mechanism is expected for this artifact",
    },
    environment_proportionality: {
      status: "ok",
      detail: "environment permissions are proportional",
    },
    persistence_privilege: {
      status: "ok",
      detail: "persistence/privilege behavior is expected",
    },
  };
}

function completeJudgeResult(verdict: ClawScanVerdict) {
  return {
    verdict,
    confidence: "high",
    summary: "summary",
    dimensions: completeJudgeDimensions(),
    scan_findings_in_context: [],
    user_guidance: "guidance",
    artifact_inspection: {
      status: "completed",
      challenge: "inspection-challenge",
      required_file_sha256: "a".repeat(64),
      files_inspected: ["artifact/SKILL.md"],
    },
  };
}

function clawScanArtifactJson(options?: {
  aigRaw?: unknown;
  completedAt?: string;
  includeCompletedAt?: boolean;
  judgeResult?: Record<string, unknown>;
  omitAigRaw?: boolean;
  scannerStatuses?: Partial<Record<"aig" | "clawscan-static" | "skillspector", string>>;
  verdict?: ClawScanVerdict;
}) {
  const verdict = options?.verdict ?? "benign";
  const scannerStatuses = {
    aig: "completed",
    "clawscan-static": "completed",
    skillspector: "completed",
    ...options?.scannerStatuses,
  };
  const artifact: Record<string, unknown> = {
    schemaVersion: "clawscan-run-v1",
    profile: "clawhub",
    scanners: {
      aig: {
        status: scannerStatuses.aig,
        ...(options?.omitAigRaw
          ? {}
          : {
              raw: options?.aigRaw ?? {
                version: "2.1.0",
                runs: [
                  {
                    tool: { driver: { name: "aig-skill-scan", version: "0.2.1" } },
                    results: [
                      {
                        ruleId: "T04",
                        level: "error",
                        message: { text: "Embedded payload" },
                        properties: { remediation: "Remove the payload." },
                      },
                    ],
                  },
                ],
              },
            }),
      },
      skillspector: {
        status: scannerStatuses.skillspector,
        raw: {
          risk_assessment: {
            score: 55,
            severity: "HIGH",
            recommendation: "DO_NOT_INSTALL",
          },
          issues: [{ id: "SDI-1", severity: "HIGH", explanation: "test finding" }],
        },
      },
      "clawscan-static": {
        status: scannerStatuses["clawscan-static"],
        raw: {
          status: scannerStatuses["clawscan-static"] === "completed" ? "clean" : "failed",
        },
      },
    },
    judge: {
      status: "completed",
      promptSha256: "prompt-sha-1",
      outputSchemaSha256: "schema-sha-1",
      result: options?.judgeResult ?? completeJudgeResult(verdict),
    },
  };
  if (options?.includeCompletedAt === false) {
    return JSON.stringify(artifact);
  }
  artifact.completedAt = options?.completedAt ?? "2026-07-15T00:00:00Z";
  return JSON.stringify(artifact);
}

describe("run-codex-scan-worker clawscan authority", () => {
  it("drops non-finite and invalid A.I.G SARIF line numbers", () => {
    const analysis = normalizeAigAnalysis(
      '{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"aig-skill-scan","version":"0.2.1"}},"results":[{"ruleId":"T04","message":{"text":"Finding"},"locations":[{"physicalLocation":{"region":{"startLine":1e400,"endLine":-1}}}]}]}]}',
      123,
    );

    expect(analysis.findings).toEqual([
      expect.not.objectContaining({ startLine: expect.anything(), endLine: expect.anything() }),
    ]);
  });

  it("rejects malformed A.I.G SARIF results explicitly", () => {
    expect(
      normalizeAigAnalysis(
        '{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"aig-skill-scan","version":"0.2.1"}},"results":[null]}]}',
        123,
      ),
    ).toEqual({
      status: "error",
      issueCount: 0,
      findings: [],
      error: "A.I.G SARIF output contained a malformed result.",
      checkedAt: 123,
    });
  });

  it("passes only the approved provider endpoint to ClawScan", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, "artifact"), { recursive: true });
    await writeFile(join(workspace, "artifact", "SKILL.md"), "# Safe skill\n");
    const fakeClawScan = join(workspace, "fake-clawscan");
    const environmentLog = join(workspace, "clawscan-environment.log");
    await writeFakeClawScanCommand(
      fakeClawScan,
      `printf '%s\\n' "\${DEFAULT_BASE_URL-}" "\${OPENAI_BASE_URL-}" "\${OPENAI_API_KEY-}" "\${SECURITY_SCAN_WORKER_TOKEN-}" > ${JSON.stringify(environmentLog)}
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      out="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
cat > "$out" <<'JSON'
${clawScanArtifactJson({ verdict: "benign" })}
JSON`,
    );

    const previousCommand = process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
    const previousSandbox = process.env.CODEX_SECURITY_SCAN_CLAWSCAN_SANDBOX;
    const previousDefaultBaseUrl = process.env.DEFAULT_BASE_URL;
    const previousOpenAiBaseUrl = process.env.OPENAI_BASE_URL;
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    const previousWorkerToken = process.env.SECURITY_SCAN_WORKER_TOKEN;
    process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = fakeClawScan;
    process.env.CODEX_SECURITY_SCAN_CLAWSCAN_SANDBOX = "off";
    process.env.DEFAULT_BASE_URL = "https://api.openai.com/v1";
    process.env.OPENAI_BASE_URL = "https://unapproved.example.invalid/v1";
    process.env.OPENAI_API_KEY = "mock-provider-key";
    process.env.SECURITY_SCAN_WORKER_TOKEN = "mock-worker-token";

    try {
      const onDiagnostic = vi.fn();
      await runClawScan(
        skillVersionJob("securityScanJobs:restricted-environment"),
        workspace,
        onDiagnostic,
      );

      expect(onDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(["--sandbox", "off"]),
        }),
      );

      expect((await readFile(environmentLog, "utf8")).split("\n")).toEqual([
        "https://api.openai.com/v1",
        "",
        "mock-provider-key",
        "",
        "",
      ]);
    } finally {
      if (previousCommand === undefined) delete process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
      else process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = previousCommand;
      if (previousSandbox === undefined) delete process.env.CODEX_SECURITY_SCAN_CLAWSCAN_SANDBOX;
      else process.env.CODEX_SECURITY_SCAN_CLAWSCAN_SANDBOX = previousSandbox;
      if (previousDefaultBaseUrl === undefined) delete process.env.DEFAULT_BASE_URL;
      else process.env.DEFAULT_BASE_URL = previousDefaultBaseUrl;
      if (previousOpenAiBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previousOpenAiBaseUrl;
      if (previousOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiApiKey;
      if (previousWorkerToken === undefined) delete process.env.SECURITY_SCAN_WORKER_TOKEN;
      else process.env.SECURITY_SCAN_WORKER_TOKEN = previousWorkerToken;
    }
  });

  it.each([
    {
      name: "zero roots",
      roots: [],
      expected: [],
    },
    {
      name: "one root",
      roots: ["skills/alpha"],
      expected: [{ rootPath: "skills/alpha", scanPath: "artifact/package/skills/alpha" }],
    },
    {
      name: "multiple roots in deterministic order",
      roots: ["skills/zeta/", "./skills/alpha", "skills/zeta"],
      expected: [
        { rootPath: "skills/alpha", scanPath: "artifact/package/skills/alpha" },
        { rootPath: "skills/zeta", scanPath: "artifact/package/skills/zeta" },
      ],
    },
    {
      name: "traversal roots rejected",
      roots: ["../outside", "skills/../../outside", "/absolute", ".", "skills/safe"],
      expected: [{ rootPath: "skills/safe", scanPath: "artifact/package/skills/safe" }],
    },
  ])("selects $name only from the package manifest", async ({ name, roots, expected }) => {
    const workspace = await tempDir();
    await mkdir(join(workspace, "artifact", "package"), { recursive: true });
    await writeFile(join(workspace, "artifact", "package", "package.json"), "{}\n");
    const job = claimedJob({
      jobId: `securityScanJobs:${name.replaceAll(" ", "-")}`,
      source: "publish",
      targetKind: "packageRelease",
      target: {
        release: {
          pluginManifestSummary: {
            bundledSkills: roots.map((rootPath) => ({ rootPath })),
          },
        },
      },
    });

    await expect(resolveBundledSkillSpectorScanInputs(workspace, job)).resolves.toEqual(expected);
  });

  it("produces an explicit result when a package has no bundled skills", () => {
    expect(aggregateSkillSpectorAnalyses([])).toEqual({
      applicable: false,
      status: "clean",
      risk_assessment: {
        score: 0,
        severity: "NONE",
        recommendation: "NOT_APPLICABLE",
      },
      issue_count: 0,
      filtered_findings: [],
      metadata: { skillspector_version: "skillspector" },
      summary: "Package declares no bundled skills; SkillSpector was not applicable.",
    });
  });

  it("aggregates bundled SkillSpector reports deterministically", () => {
    const analyses = [
      {
        status: "clean",
        score: 5,
        severity: "LOW",
        recommendation: "ALLOW",
        issueCount: 0,
        issues: [],
        scannerVersion: "2.0.0",
        summary: "alpha clean",
        checkedAt: 20,
      },
      {
        status: "suspicious",
        score: 80,
        severity: "HIGH",
        recommendation: "REVIEW",
        issueCount: 1,
        issues: [
          {
            issueId: "SDI-2",
            severity: "HIGH",
            explanation: "review beta",
          },
        ],
        scannerVersion: "1.0.0",
        summary: "beta suspicious",
        checkedAt: 10,
      },
    ];

    expect(aggregateSkillSpectorAnalyses(analyses)).toEqual(
      aggregateSkillSpectorAnalyses([...analyses].reverse()),
    );
    expect(aggregateSkillSpectorAnalyses(analyses)).toMatchObject({
      applicable: true,
      status: "suspicious",
      risk_assessment: {
        score: 80,
        severity: "HIGH",
        recommendation: "ALLOW; REVIEW",
      },
      issue_count: 1,
      metadata: { skillspector_version: "1.0.0, 2.0.0" },
      summary: "Scanned 2 bundled skills. alpha clean beta suspicious",
    });
  });

  it("never passes a package root to SkillSpector", async () => {
    const workspace = await tempDir();
    const packageRoot = join(workspace, "artifact", "package");
    await mkdir(join(packageRoot, "skills", "alpha"), { recursive: true });
    await mkdir(join(packageRoot, "skills", "beta"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), "{}\n");
    await writeFile(join(packageRoot, "openclaw.plugin.json"), '{"id":"demo-plugin"}\n');
    await writeFile(join(packageRoot, "SKILL.md"), "# Bundled skill\n");
    await writeFile(join(packageRoot, "skills", "alpha", "SKILL.md"), "# alpha\n");
    await writeFile(join(packageRoot, "skills", "beta", "SKILL.md"), "# beta\n");

    const fakeSkillSpector = join(workspace, "skillspector");
    const skillSpectorTargets = join(workspace, "skillspector-targets.log");
    await writeFakeClawScanCommand(
      fakeSkillSpector,
      `target="$2"
printf '%s\\n' "$target" >> ${JSON.stringify(skillSpectorTargets)}
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      out="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
cat > "$out" <<JSON
{"status":"suspicious","risk_score":25,"risk_severity":"MEDIUM","risk_recommendation":"REVIEW","issue_count":1,"issues":[{"id":"same-name","severity":"MEDIUM","file":"SKILL.md","explanation":"review"}],"scanner_version":"test","summary":"$(basename "$target") suspicious"}
JSON`,
    );

    const fakeClawScan = join(workspace, "fake-clawscan");
    const copiedFixture = join(workspace, "skillspector-fixture.json");
    await writeFakeClawScanCommand(
      fakeClawScan,
      `test "$1" = "./artifact/package/openclaw.plugin.json"
out=""
fixture=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      out="$2"
      shift 2
      ;;
    --scanner-result)
      fixture="\${2#skillspector=}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
cp "$fixture" ${JSON.stringify(copiedFixture)}
cat > "$out" <<'JSON'
${clawScanArtifactJson()}
JSON`,
    );

    const previousClawScan = process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
    const previousPath = process.env.PATH;
    process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = fakeClawScan;
    process.env.PATH = `${workspace}:${previousPath ?? ""}`;
    try {
      const job = claimedJob({
        jobId: "securityScanJobs:bundled-roots-only",
        source: "publish",
        targetKind: "packageRelease",
        target: {
          release: {
            pluginManifestSummary: {
              bundledSkills: [{ rootPath: "skills/beta" }, { rootPath: "skills/alpha" }],
            },
          },
        },
      });

      await runClawScan(job, workspace, () => {});

      expect((await readFile(skillSpectorTargets, "utf8")).trim().split("\n")).toEqual([
        "artifact/package/skills/alpha",
        "artifact/package/skills/beta",
      ]);
      expect(JSON.parse(await readFile(copiedFixture, "utf8"))).toMatchObject({
        applicable: true,
        status: "suspicious",
        issue_count: 2,
        filtered_findings: [{ file: "skills/alpha/SKILL.md" }, { file: "skills/beta/SKILL.md" }],
        summary: "Scanned 2 bundled skills. alpha suspicious beta suspicious",
      });
    } finally {
      if (previousClawScan === undefined) delete process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
      else process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = previousClawScan;
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  it("uses ClawScan as the only skillVersion scan implementation", async () => {
    const workspace = await tempDir();
    const fakeClawScan = join(workspace, "fake-clawscan");
    const clawscanMarker = join(workspace, "clawscan-called.log");
    await writeFakeClawScanCommand(
      fakeClawScan,
      `echo "called" > ${JSON.stringify(clawscanMarker)}
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      out="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$(dirname "$out")"
cat > "$out" <<'JSON'
${clawScanArtifactJson({ verdict: "benign" })}
JSON`,
    );

    const previousCommand = process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
    process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = fakeClawScan;
    try {
      const client = {
        action: vi.fn(async (..._args: unknown[]) => ({})),
      };
      const result = await processJob(
        client,
        "worker-auth",
        skillVersionJob("securityScanJobs:clawscan-only"),
        undefined,
      );

      expect(result).toEqual({
        completed: true,
        hardFailed: false,
        retryableFailed: false,
      });
      expect(await readFile(clawscanMarker, "utf8")).toContain("called");
      expect(client.action.mock.calls[0]?.[1]).toMatchObject({
        llmAnalysis: { status: "clean", verdict: "benign" },
      });
    } finally {
      if (previousCommand === undefined) delete process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
      else process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = previousCommand;
    }
  });

  it.each([
    { verdict: "benign", expectedStatus: "clean" },
    { verdict: "suspicious", expectedStatus: "suspicious" },
    { verdict: "malicious", expectedStatus: "malicious" },
  ] satisfies Array<{ expectedStatus: string; verdict: ClawScanVerdict }>)(
    "persists %s ClawScan verdicts through the existing completion shape",
    async ({ verdict, expectedStatus }) => {
      const workspace = await tempDir();
      const fakeClawScan = join(workspace, "fake-clawscan");
      const argsLog = join(workspace, "clawscan-args.log");
      const artifactJson = clawScanArtifactJson({ verdict });
      await writeFakeClawScanCommand(
        fakeClawScan,
        `if [[ -n "\${VIRUSTOTAL_API_KEY:-}" ]]; then
  echo "VirusTotal key leaked into ClawScan" >&2
  exit 86
fi
printf '%s\n' "$@" > ${JSON.stringify(argsLog)}
out=""
	while [[ $# -gt 0 ]]; do
	  case "$1" in
	    --output)
      out="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$(dirname "$out")"
cat > "$out" <<'JSON'
${artifactJson}
JSON`,
      );

      const previousCommand = process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
      const previousVirusTotalKey = process.env.VIRUSTOTAL_API_KEY;
      process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = fakeClawScan;
      process.env.VIRUSTOTAL_API_KEY = "vt-fixture-that-must-not-reach-clawscan";
      try {
        const client = {
          action: vi.fn(async (..._args: unknown[]) => ({})),
        };
        const result = await processJob(
          client,
          "worker-auth",
          skillVersionJob(`securityScanJobs:${verdict}`),
          undefined,
        );

        expect(result).toEqual({
          completed: true,
          hardFailed: false,
          retryableFailed: false,
        });
        expect(client.action).toHaveBeenCalledTimes(1);
        expect(client.action.mock.calls[0]?.[1]).toMatchObject({
          llmAnalysis: {
            status: expectedStatus,
            verdict,
          },
          aigAnalysis: {
            issueCount: 1,
            scannerVersion: "0.2.1",
            status: "suspicious",
          },
          skillSpectorAnalysis: {
            issueCount: 1,
            status: "suspicious",
          },
        });
        const payload = client.action.mock.calls[0]?.[1] as
          | { llmAnalysis?: { model?: string } }
          | undefined;
        expect(payload?.llmAnalysis?.model).toBeUndefined();

        const invocationArgs = await readFile(argsLog, "utf8");
        expect(invocationArgs).toContain("--profile");
        expect(invocationArgs).toContain("clawhub");
        expect(invocationArgs).not.toContain("--context");
        expect(invocationArgs).not.toContain("--scanner-result");
      } finally {
        if (previousCommand === undefined) delete process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
        else process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = previousCommand;
        if (previousVirusTotalKey === undefined) delete process.env.VIRUSTOTAL_API_KEY;
        else process.env.VIRUSTOTAL_API_KEY = previousVirusTotalKey;
      }
    },
  );

  it.each([
    {
      name: "skill-version publish",
      source: "publish",
      targetKind: "skillVersion" as const,
      expectedTarget: "./artifact",
      expectedFile: "./artifact/SKILL.md",
      target: async () => fileTarget("SKILL.md", "# Published skill\n"),
    },
    {
      name: "package-release publish",
      source: "publish",
      targetKind: "packageRelease" as const,
      expectedTarget: "./artifact/package",
      expectedFile: "./artifact/package/package.json",
      target: clawPackTarget,
    },
    {
      name: "skill-scan-request manual",
      source: "manual",
      targetKind: "skillScanRequest" as const,
      expectedTarget: "./artifact",
      expectedFile: "./artifact/SKILL.md",
      target: async () => fileTarget("SKILL.md", "# Uploaded skill\n"),
    },
    {
      name: "skill-version VirusTotal update",
      source: "vt-update",
      targetKind: "skillVersion" as const,
      expectedTarget: "./artifact",
      expectedFile: "./artifact/SKILL.md",
      target: async () => fileTarget("SKILL.md", "# VT update\n"),
    },
    {
      name: "package-release backfill",
      source: "backfill",
      targetKind: "packageRelease" as const,
      expectedTarget: "./artifact",
      expectedFile: "./artifact/package.json",
      target: async () => fileTarget("package.json", '{"name":"backfill-plugin"}\n'),
    },
    {
      name: "skill-version bulk rescan",
      source: "bulk-rescan",
      targetKind: "skillVersion" as const,
      expectedTarget: "./artifact",
      expectedFile: "./artifact/SKILL.md",
      target: async () => fileTarget("SKILL.md", "# Bulk rescan\n"),
    },
  ])(
    "routes $name through the same artifact-only ClawScan persistence adapter",
    async ({ source, targetKind, expectedTarget, expectedFile, target }) => {
      const workspace = await tempDir();
      const fakeClawScan = join(workspace, "fake-clawscan");
      const argsLog = join(workspace, "clawscan-args.log");
      const filesLog = join(workspace, "clawscan-files.log");
      const isPackageRelease = targetKind === "packageRelease";
      await writeFakeClawScanCommand(
        fakeClawScan,
        `target="$1"
printf '%s\n' "$@" > ${JSON.stringify(argsLog)}
find "$target" -type f -print | sort > ${JSON.stringify(filesLog)}
out=""
	while [[ $# -gt 0 ]]; do
	  case "$1" in
	    --output)
      out="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$(dirname "$out")"
cat > "$out" <<'JSON'
${clawScanArtifactJson({
  omitAigRaw: isPackageRelease,
  scannerStatuses: isPackageRelease ? { aig: "skipped" } : undefined,
})}
JSON`,
      );

      const previousCommand = process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
      process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = fakeClawScan;
      try {
        const client = {
          action: vi.fn(async (..._args: unknown[]) => ({})),
        };
        const result = await processJob(
          client,
          "worker-auth",
          claimedJob({
            jobId: `securityScanJobs:${targetKind}-${source}`,
            source,
            target: await target(),
            targetKind,
            vtAnalysis: {
              status: "completed",
              source: `${targetKind}-${source}`,
            },
          }),
          undefined,
        );

        expect(result).toEqual({
          completed: true,
          hardFailed: false,
          retryableFailed: false,
        });
        expect(client.action).toHaveBeenCalledTimes(1);
        expect(client.action.mock.calls[0]?.[1]).toMatchObject({
          llmAnalysis: {
            status: "clean",
            verdict: "benign",
          },
          skillSpectorAnalysis: {
            issueCount: 1,
            status: "suspicious",
          },
          ...(isPackageRelease
            ? { aigAnalysis: undefined }
            : {
                aigAnalysis: {
                  issueCount: 1,
                  status: "suspicious",
                },
              }),
        });

        const invocationArgs = (await readFile(argsLog, "utf8")).trim().split("\n");
        expect(invocationArgs[0]).toBe(expectedTarget);
        expect(invocationArgs).toEqual(
          expect.arrayContaining(["--profile", "clawhub", "--output"]),
        );
        expect(invocationArgs).not.toContain("--context");
        if (targetKind === "packageRelease") {
          expect(invocationArgs).toContain("--scanner-result");
          expect(invocationArgs.some((arg) => arg.startsWith("skillspector="))).toBe(true);
        } else {
          expect(invocationArgs).not.toContain("--scanner-result");
        }
        expect((await readFile(filesLog, "utf8")).trim().split("\n")).toContain(expectedFile);
      } finally {
        if (previousCommand === undefined) delete process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
        else process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = previousCommand;
      }
    },
  );

  it.each([
    {
      source: "bulk-rescan",
      targetKind: "skillVersion" as const,
      target: async () => fileTarget("SKILL.md", "# Failed skill\n"),
    },
    {
      source: "vt-update",
      targetKind: "packageRelease" as const,
      target: async () => fileTarget("package.json", '{"name":"failed-plugin"}\n'),
    },
    {
      source: "manual",
      targetKind: "skillScanRequest" as const,
      target: async () => fileTarget("SKILL.md", "# Failed upload\n"),
    },
  ])(
    "uses the existing retry lifecycle when $targetKind/$source ClawScan execution fails",
    async ({ source, targetKind, target }) => {
      const workspace = await tempDir();
      const fakeClawScan = join(workspace, "fake-clawscan");
      await writeFakeClawScanCommand(fakeClawScan, 'echo "matrix failure" >&2\nexit 17');

      const previousCommand = process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
      process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = fakeClawScan;
      try {
        const client = {
          action: vi.fn(async (...args: unknown[]) => {
            const payload = args[1] as { error?: string } | undefined;
            return payload?.error ? { retry: true } : {};
          }),
        };
        const result = await processJob(
          client,
          "worker-auth",
          claimedJob({
            jobId: `securityScanJobs:failed-${targetKind}-${source}`,
            source,
            target: await target(),
            targetKind,
          }),
          undefined,
        );

        expect(result).toEqual({
          completed: false,
          hardFailed: false,
          retryableFailed: true,
        });
        expect(client.action).toHaveBeenCalledTimes(1);
        expect(client.action.mock.calls[0]?.[1]).toMatchObject({
          error: expect.stringContaining("exited 17"),
        });
      } finally {
        if (previousCommand === undefined) delete process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
        else process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = previousCommand;
      }
    },
  );

  it("fails the job when SkillSpector scanner status is skipped", async () => {
    const workspace = await tempDir();
    const fakeClawScan = join(workspace, "fake-clawscan");
    const artifactJson = clawScanArtifactJson({
      scannerStatuses: { skillspector: "skipped" },
    });
    await writeFakeClawScanCommand(
      fakeClawScan,
      `out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      out="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$(dirname "$out")"
cat > "$out" <<'JSON'
${artifactJson}
JSON`,
    );

    const previousCommand = process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
    process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = fakeClawScan;
    try {
      const client = {
        action: vi.fn(async (...args: unknown[]) => {
          const payload = args[1] as { error?: string } | undefined;
          return payload?.error ? { retry: false } : {};
        }),
      };
      const result = await processJob(
        client,
        "worker-auth",
        skillVersionJob("securityScanJobs:skillspector-skipped"),
        undefined,
      );

      expect(result).toEqual({
        completed: false,
        hardFailed: true,
        retryableFailed: false,
      });
      expect(client.action).toHaveBeenCalledTimes(1);
      expect(client.action.mock.calls[0]?.[1]).toMatchObject({
        error: "ClawScan scanner skillspector status was skipped",
      });
    } finally {
      if (previousCommand === undefined) delete process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
      else process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = previousCommand;
    }
  });

  it("fails the job when the ClawScan artifact is malformed", async () => {
    const workspace = await tempDir();
    const fakeClawScan = join(workspace, "fake-clawscan");
    await writeFakeClawScanCommand(
      fakeClawScan,
      `out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      out="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$(dirname "$out")"
echo "not json" > "$out"`,
    );

    const previousCommand = process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
    process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = fakeClawScan;
    try {
      const client = {
        action: vi.fn(async (...args: unknown[]) => {
          const payload = args[1] as { error?: string } | undefined;
          return payload?.error ? { retry: false } : {};
        }),
      };
      const onHealth = vi.fn();

      const result = await processJob(
        client,
        "worker-auth",
        skillVersionJob("securityScanJobs:malformed"),
        undefined,
        onHealth,
      );

      expect(result).toEqual({
        completed: false,
        hardFailed: true,
        retryableFailed: false,
      });
      expect(client.action).toHaveBeenCalledTimes(1);
      expect(client.action.mock.calls[0]?.[1]).toMatchObject({
        error: "ClawScan did not emit a valid JSON artifact",
      });
    } finally {
      if (previousCommand === undefined) delete process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
      else process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = previousCommand;
    }
  });

  it("fails the job when completed A.I.G output has no SARIF run", async () => {
    const workspace = await tempDir();
    const fakeClawScan = join(workspace, "fake-clawscan");
    const artifactJson = clawScanArtifactJson({
      aigRaw: { version: "2.1.0", runs: [] },
    });
    await writeFakeClawScanCommand(
      fakeClawScan,
      `out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      out="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$(dirname "$out")"
cat > "$out" <<'JSON'
${artifactJson}
JSON`,
    );

    const previousCommand = process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
    process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = fakeClawScan;
    try {
      const client = {
        action: vi.fn(async (...args: unknown[]) => {
          const payload = args[1] as { error?: string } | undefined;
          return payload?.error ? { retry: false } : {};
        }),
      };

      await expect(
        processJob(
          client,
          "worker-auth",
          skillVersionJob("securityScanJobs:aig-empty-runs"),
          undefined,
        ),
      ).resolves.toEqual({
        completed: false,
        hardFailed: true,
        retryableFailed: false,
      });
      expect(client.action.mock.calls[0]?.[1]).toMatchObject({
        error: "A.I.G SARIF output did not contain a run.",
      });
    } finally {
      if (previousCommand === undefined) delete process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
      else process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = previousCommand;
    }
  });

  it("fails the job when the ClawScan judge omits artifact inspection proof", async () => {
    const workspace = await tempDir();
    const fakeClawScan = join(workspace, "fake-clawscan");
    const { artifact_inspection: _inspection, ...judgeResult } = completeJudgeResult("benign");
    const artifactJson = clawScanArtifactJson({ judgeResult });
    await writeFakeClawScanCommand(
      fakeClawScan,
      `out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      out="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$(dirname "$out")"
cat > "$out" <<'JSON'
${artifactJson}
JSON`,
    );

    const previousCommand = process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
    process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = fakeClawScan;
    try {
      const client = {
        action: vi.fn(async (...args: unknown[]) => {
          const payload = args[1] as { error?: string } | undefined;
          return payload?.error ? { retry: false } : {};
        }),
      };
      const result = await processJob(
        client,
        "worker-auth",
        skillVersionJob("securityScanJobs:judge-no-inspection"),
        undefined,
      );

      expect(result).toEqual({
        completed: false,
        hardFailed: true,
        retryableFailed: false,
      });
      expect(client.action).toHaveBeenCalledTimes(1);
      expect(client.action.mock.calls[0]?.[1]).toMatchObject({
        error: "ClawScan judge result missing required field(s): artifact_inspection",
      });
    } finally {
      if (previousCommand === undefined) delete process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
      else process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = previousCommand;
    }
  });

  it("fails the job when the ClawScan judge result is missing required dimensions", async () => {
    const workspace = await tempDir();
    const fakeClawScan = join(workspace, "fake-clawscan");
    const artifactJson = clawScanArtifactJson({
      judgeResult: {
        verdict: "benign",
        confidence: "high",
        summary: "summary",
        dimensions: {
          purpose_capability: {
            status: "ok",
            detail: "only one dimension",
          },
        },
        scan_findings_in_context: [],
        user_guidance: "guidance",
        artifact_inspection: {
          status: "completed",
          challenge: "inspection-challenge",
          required_file_sha256: "a".repeat(64),
          files_inspected: ["artifact/SKILL.md"],
        },
      },
    });
    await writeFakeClawScanCommand(
      fakeClawScan,
      `out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      out="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$(dirname "$out")"
cat > "$out" <<'JSON'
${artifactJson}
JSON`,
    );

    const previousCommand = process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
    process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = fakeClawScan;
    try {
      const client = {
        action: vi.fn(async (...args: unknown[]) => {
          const payload = args[1] as { error?: string } | undefined;
          return payload?.error ? { retry: false } : {};
        }),
      };
      const onHealth = vi.fn();

      const result = await processJob(
        client,
        "worker-auth",
        skillVersionJob("securityScanJobs:judge-incomplete"),
        undefined,
        onHealth,
      );

      expect(result).toEqual({
        completed: false,
        hardFailed: true,
        retryableFailed: false,
      });
      expect(client.action).toHaveBeenCalledTimes(1);
      const payload = client.action.mock.calls[0]?.[1] as { error?: string } | undefined;
      expect(payload?.error).toContain("ClawScan judge dimensions missing required field(s)");
      expect(onHealth).toHaveBeenCalledWith(
        expect.objectContaining({
          completed: false,
          failureStage: "judge",
          judgeStageFailed: true,
        }),
      );
    } finally {
      if (previousCommand === undefined) delete process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
      else process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = previousCommand;
    }
  });

  it.each([
    {
      artifactJson: clawScanArtifactJson({ includeCompletedAt: false }),
      expectedError: "ClawScan artifact completedAt was missing",
      name: "missing",
    },
    {
      artifactJson: clawScanArtifactJson({ completedAt: "not-a-date" }),
      expectedError: "ClawScan artifact completedAt was not-a-date",
      name: "invalid",
    },
  ])(
    "fails the job when ClawScan artifact completedAt is $name",
    async ({ artifactJson, expectedError, name }) => {
      const workspace = await tempDir();
      const fakeClawScan = join(workspace, "fake-clawscan");
      await writeFakeClawScanCommand(
        fakeClawScan,
        `out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      out="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$(dirname "$out")"
cat > "$out" <<'JSON'
${artifactJson}
JSON`,
      );

      const previousCommand = process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
      process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = fakeClawScan;
      try {
        const client = {
          action: vi.fn(async (...args: unknown[]) => {
            const payload = args[1] as { error?: string } | undefined;
            return payload?.error ? { retry: false } : {};
          }),
        };

        const result = await processJob(
          client,
          "worker-auth",
          skillVersionJob(`securityScanJobs:completed-at-${name}`),
          undefined,
        );

        expect(result).toEqual({
          completed: false,
          hardFailed: true,
          retryableFailed: false,
        });
        expect(client.action).toHaveBeenCalledTimes(1);
        expect(client.action.mock.calls[0]?.[1]).toMatchObject({
          error: expectedError,
        });
      } finally {
        if (previousCommand === undefined) delete process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
        else process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = previousCommand;
      }
    },
  );

  it("fails the job when a required ClawScan scanner reports failed", async () => {
    const workspace = await tempDir();
    const fakeClawScan = join(workspace, "fake-clawscan");
    const artifactJson = clawScanArtifactJson({
      scannerStatuses: { skillspector: "failed" },
    });
    await writeFakeClawScanCommand(
      fakeClawScan,
      `out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      out="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$(dirname "$out")"
cat > "$out" <<'JSON'
${artifactJson}
JSON`,
    );

    const previousCommand = process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
    process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = fakeClawScan;
    try {
      const client = {
        action: vi.fn(async (...args: unknown[]) => {
          const payload = args[1] as { error?: string } | undefined;
          return payload?.error ? { retry: false } : {};
        }),
      };
      const onHealth = vi.fn();

      const result = await processJob(
        client,
        "worker-auth",
        skillVersionJob("securityScanJobs:scanner-failed"),
        undefined,
        onHealth,
      );

      expect(result).toEqual({
        completed: false,
        hardFailed: true,
        retryableFailed: false,
      });
      expect(client.action).toHaveBeenCalledTimes(1);
      expect(client.action.mock.calls[0]?.[1]).toMatchObject({
        error: "ClawScan scanner skillspector status was failed",
      });
      expect(onHealth).toHaveBeenCalledWith(
        expect.objectContaining({
          completed: false,
          failureStage: "scanner",
          scannerStageFailed: true,
        }),
      );
    } finally {
      if (previousCommand === undefined) delete process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
      else process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = previousCommand;
    }
  });

  it("uses the existing timeout/failure retry path for ClawScan timeouts", async () => {
    const workspace = await tempDir();
    const fakeClawScan = join(workspace, "fake-clawscan");
    await writeFakeClawScanCommand(
      fakeClawScan,
      `sleep 2
echo "this should never complete"`,
    );

    const previousCommand = process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
    const previousTimeout = process.env.CODEX_SECURITY_SCAN_CLAWSCAN_TIMEOUT_MS;
    process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = fakeClawScan;
    process.env.CODEX_SECURITY_SCAN_CLAWSCAN_TIMEOUT_MS = "25";
    try {
      const client = {
        action: vi.fn(async (...args: unknown[]) => {
          const payload = args[1] as { error?: string } | undefined;
          return payload?.error ? { retry: true } : {};
        }),
      };
      const onHealth = vi.fn();

      const result = await processJob(
        client,
        "worker-auth",
        skillVersionJob("securityScanJobs:timeout"),
        undefined,
        onHealth,
      );

      expect(result).toEqual({
        completed: false,
        hardFailed: false,
        retryableFailed: true,
      });
      expect(client.action).toHaveBeenCalledTimes(1);
      const payload = client.action.mock.calls[0]?.[1] as { error?: string } | undefined;
      expect(payload?.error).toContain("timed out");
      expect(onHealth).toHaveBeenCalledWith(
        expect.objectContaining({
          completed: false,
          failureStage: "unclassified",
          timedOut: true,
        }),
      );
    } finally {
      if (previousCommand === undefined) delete process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
      else process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = previousCommand;
      if (previousTimeout === undefined) delete process.env.CODEX_SECURITY_SCAN_CLAWSCAN_TIMEOUT_MS;
      else process.env.CODEX_SECURITY_SCAN_CLAWSCAN_TIMEOUT_MS = previousTimeout;
    }
  });

  it("terminates the full ClawScan process tree on timeout", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, "artifact"), { recursive: true });
    const fakeClawScan = join(workspace, "fake-clawscan");
    await writeFakeClawScanCommand(
      fakeClawScan,
      `(
  trap '' TERM
  exec >/dev/null 2>&1
  while true; do sleep 1; done
) &
child_pid=$!
printf '%s' "$child_pid" > "${workspace}/descendant.pid"
wait "$child_pid"`,
    );
    const descendantPidPath = join(workspace, "descendant.pid");
    const previousCommand = process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
    const previousTimeout = process.env.CODEX_SECURITY_SCAN_CLAWSCAN_TIMEOUT_MS;
    process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = fakeClawScan;
    process.env.CODEX_SECURITY_SCAN_CLAWSCAN_TIMEOUT_MS = "500";
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let descendantPid: number | undefined;

    try {
      const scanPromise = runClawScan(
        skillVersionJob("securityScanJobs:process-tree-timeout"),
        workspace,
        () => {},
      );
      void scanPromise.catch(() => undefined);
      descendantPid = await readStartedPid(descendantPidPath);
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
      if (descendantPid) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The fixed worker has already terminated the descendant.
        }
      }
      if (previousCommand === undefined) delete process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND;
      else process.env.CODEX_SECURITY_SCAN_CLAWSCAN_COMMAND = previousCommand;
      if (previousTimeout === undefined) {
        delete process.env.CODEX_SECURITY_SCAN_CLAWSCAN_TIMEOUT_MS;
      } else {
        process.env.CODEX_SECURITY_SCAN_CLAWSCAN_TIMEOUT_MS = previousTimeout;
      }
    }
  });
});
