import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { createWorkerLogger } from "../lib/workerLogger";
import {
  maskKnownWorkerSecrets,
  redactWorkerPublicErrorMessage,
  redactWorkerPublicText,
} from "../lib/workerRedaction";
import {
  type AigAnalysis,
  assertAigFilePathsHaveNoCompiledPython,
  type ClaimedJob,
  normalizeAigAnalysis,
  resolveClawScanTarget,
  type StoredLlmAnalysis,
  writeArtifactWorkspace,
} from "./run-codex-scan-worker";

type ClaimedPrePublicationAttempt = {
  attemptId: Id<"publishAttempts">;
  status?: "pending_checks" | "ready_to_finalize";
  claimId: string;
  kind: "skill" | "package";
  slug: string;
  displayName: string;
  version: string;
  artifactFingerprint: string;
  files: Array<{
    path: string;
    size: number;
    sha256: string;
    url: string | null;
    contentType?: string;
  }>;
  clawpackUrl?: string | null;
  scanContext?: {
    trustedOpenClawPlugin?: boolean;
    skill?: Record<string, unknown>;
    version?: Record<string, unknown>;
    package?: Record<string, unknown>;
    release?: Record<string, unknown>;
  };
  existingClawscanAnalysis?: StoredLlmAnalysis;
  existingAigAnalysis?: AigAnalysis;
  checkClaimExpiresAt: number;
  createdAt: number;
};

type WorkerCheckResult = {
  status: "clean" | "blocked" | "failed";
  summary?: string;
  redactedFindings?: string[];
};

type ProcessAttemptResult = {
  completed: boolean;
  result?: unknown;
};

type PrePublicationWorkerClient = Pick<ConvexHttpClient, "action">;

type PrePublicationClaimFilters = {
  attemptId?: Id<"publishAttempts">;
  kind?: "skill" | "package";
  slug?: string;
  version?: string;
};

type TruffleHogResult = WorkerCheckResult & {
  exitCode?: number | null;
};

type ClawScanResult = {
  check: WorkerCheckResult;
  analysis?: StoredLlmAnalysis;
  aigAnalysis?: AigAnalysis;
};

type ProcessAttemptDeps = {
  runClawScan?: (job: ClaimedJob, workspace: string) => Promise<ClawScanResult>;
  runTruffleHog?: (workspace: string) => Promise<TruffleHogResult>;
  writeWorkspace?: (job: ClaimedJob, workspace: string) => Promise<void>;
};

const DEFAULT_BATCH_LIMIT = 2;
const DEFAULT_MAX_RUNTIME_MS = 8 * 60 * 1000;
const CLAIM_WINDOW_SHUTDOWN_BUFFER_MS = 90_000;
const DEFAULT_TRUFFLEHOG_IMAGE =
  "ghcr.io/trufflesecurity/trufflehog:3.95.6@sha256:96f8429082cb2d4ae73b1096dcdb2f5aa139881d97042b0c5e5fa226a392e056";
const TRUFFLEHOG_SECRET_EXIT_CODE = 183;
const MAX_TRUFFLEHOG_FINDINGS = 10;
const MAX_PUBLIC_SUMMARY_CHARS = 600;
const REQUIRED_SKILL_SCANNERS = ["clawscan-static", "skillspector", "aig"];
const REQUIRED_PACKAGE_SCANNERS = ["clawscan-static", "skillspector"];
const CHILD_RUNTIME_ENV_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;
// ClawScan's judge and A.I.G require these provider aliases. The pinned scanner
// process is the trust boundary; never add worker tokens or ambient endpoints.
const CLAWSCAN_PROVIDER_ENV_KEYS = [
  "CODEX_API_KEY",
  "DEFAULT_BASE_URL",
  "DEFAULT_MODEL",
  "LLM_API_KEY",
  "OPENAI_API_KEY",
] as const;
const logger = createWorkerLogger({ name: "prepublication-worker" });

export function parseArgs(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env) {
  const get = (name: string) => {
    const index = args.indexOf(name);
    const value = index === -1 ? undefined : args[index + 1];
    return value && !value.startsWith("--") ? value : undefined;
  };
  const numberFrom = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const optionalNumberFrom = (value: string | undefined) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const optionalStringFrom = (value: string | undefined) => value?.trim() || undefined;
  const kind = optionalStringFrom(get("--kind") ?? env.PREPUBLICATION_CHECK_KIND);
  if (kind && kind !== "skill" && kind !== "package") {
    throw new Error("--kind must be skill or package");
  }
  return {
    batchLimit: numberFrom(
      get("--batch-limit") ?? env.PREPUBLICATION_CHECK_LIMIT,
      DEFAULT_BATCH_LIMIT,
    ),
    maxJobs: optionalNumberFrom(get("--max-jobs") ?? env.PREPUBLICATION_CHECK_MAX_JOBS),
    maxRuntimeMs:
      numberFrom(
        get("--max-runtime-minutes") ?? env.PREPUBLICATION_CHECK_MAX_RUNTIME_MINUTES,
        DEFAULT_MAX_RUNTIME_MS / 60_000,
      ) * 60_000,
    claimFilters: {
      attemptId: optionalStringFrom(get("--attempt-id") ?? env.PREPUBLICATION_CHECK_ATTEMPT_ID) as
        | Id<"publishAttempts">
        | undefined,
      kind: kind as "skill" | "package" | undefined,
      slug: optionalStringFrom(get("--slug") ?? env.PREPUBLICATION_CHECK_SLUG),
      version: optionalStringFrom(get("--version") ?? env.PREPUBLICATION_CHECK_VERSION),
    } satisfies PrePublicationClaimFilters,
  };
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function publicText(value: string, maxChars = MAX_PUBLIC_SUMMARY_CHARS) {
  return redactWorkerPublicErrorMessage(redactWorkerPublicText(value, maxChars));
}

function buildSyntheticScanJob(attempt: ClaimedPrePublicationAttempt): ClaimedJob {
  const targetKind = attempt.kind === "skill" ? "skillVersion" : "packageRelease";
  if (attempt.kind === "package" && attempt.clawpackUrl === null) {
    throw new Error("ClawPack artifact unavailable");
  }
  return {
    job: {
      _id: String(attempt.attemptId),
      leaseToken: attempt.claimId,
      targetKind,
      source: "pre-publication",
      hasMaliciousSignal: false,
      waitForVtUntil: 0,
      attempts: 1,
    },
    target: {
      ...(attempt.scanContext?.trustedOpenClawPlugin
        ? { trustedOpenClawPlugin: attempt.scanContext.trustedOpenClawPlugin }
        : {}),
      files: attempt.files.map((file) => {
        if (!file.url) throw new Error(`Artifact file unavailable: ${file.path}`);
        return {
          path: file.path,
          size: file.size,
          sha256: file.sha256,
          contentType: file.contentType,
          url: file.url,
        };
      }),
      ...(attempt.kind === "skill"
        ? {
            skill: {
              ...attempt.scanContext?.skill,
              slug: attempt.slug,
              displayName: attempt.displayName,
            },
            version: {
              ...attempt.scanContext?.version,
              version: attempt.version,
              sha256hash: attempt.artifactFingerprint,
            },
          }
        : {
            package: {
              ...attempt.scanContext?.package,
              name: attempt.slug,
              displayName: attempt.displayName,
            },
            release: {
              ...attempt.scanContext?.release,
              version: attempt.version,
              integritySha256: attempt.artifactFingerprint,
            },
            clawpackUrl: attempt.clawpackUrl,
          }),
    },
  };
}

function truffleHogTimeoutMs() {
  const parsed = Number(process.env.PREPUBLICATION_TRUFFLEHOG_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180_000;
}

function truffleHogCommand() {
  return process.env.PREPUBLICATION_TRUFFLEHOG_COMMAND?.trim() || "";
}

export function resolveTruffleHogImage(image = process.env.PREPUBLICATION_TRUFFLEHOG_IMAGE) {
  const resolved = image?.trim() || DEFAULT_TRUFFLEHOG_IMAGE;
  if (!resolved.includes("@sha256:")) {
    throw new Error("PREPUBLICATION_TRUFFLEHOG_IMAGE must be pinned by sha256 digest");
  }
  return resolved;
}

function parseTruffleHogFindings(stdout: string) {
  const findings: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const detector =
        typeof parsed.DetectorName === "string"
          ? parsed.DetectorName
          : typeof parsed.detectorName === "string"
            ? parsed.detectorName
            : "verified secret";
      const source =
        typeof parsed.SourceName === "string"
          ? parsed.SourceName
          : typeof parsed.sourceName === "string"
            ? parsed.sourceName
            : "artifact";
      findings.push(publicText(`${detector} in ${source}`, 160));
    } catch {
      // TruffleHog can write human text on some paths. Keep only a redacted, bounded summary.
      findings.push(publicText(trimmed, 160));
    }
    if (findings.length >= MAX_TRUFFLEHOG_FINDINGS) break;
  }
  return findings;
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let forceKillTimeout: NodeJS.Timeout | undefined;
      const killProcessTree = (signal: NodeJS.Signals) => {
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // The process group may already have exited; fall back to the direct child.
          }
        }
        child.kill(signal);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        killProcessTree("SIGTERM");
        forceKillTimeout = setTimeout(() => killProcessTree("SIGKILL"), 10_000);
        forceKillTimeout.unref();
      }, options.timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        if (timedOut) killProcessTree("SIGKILL");
        if (forceKillTimeout) clearTimeout(forceKillTimeout);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (timedOut) killProcessTree("SIGKILL");
        if (forceKillTimeout) clearTimeout(forceKillTimeout);
        if (timedOut) {
          reject(new Error(`${command} timed out`));
          return;
        }
        resolvePromise({ code, stdout, stderr });
      });
    },
  );
}

function restrictedChildEnvironment(
  workspace: string,
  passthroughKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    NO_COLOR: "1",
    TEMP: workspace,
    TMP: workspace,
    TMPDIR: workspace,
  };
  for (const key of [...CHILD_RUNTIME_ENV_KEYS, ...passthroughKeys]) {
    const value = process.env[key];
    if (value !== undefined) childEnv[key] = value;
  }
  return childEnv;
}

export async function runNativeTruffleHog(workspace: string): Promise<TruffleHogResult> {
  const artifactDir = join(workspace, "artifact");
  const explicitCommand = truffleHogCommand();
  const command = explicitCommand || "docker";
  const args = explicitCommand
    ? ["filesystem", artifactDir, "--only-verified", "--fail", "--json", "--no-update"]
    : [
        "run",
        "--rm",
        "-v",
        `${artifactDir}:/scan:ro`,
        resolveTruffleHogImage(),
        "filesystem",
        "/scan",
        "--only-verified",
        "--fail",
        "--json",
        "--no-update",
      ];

  const output = await runCommand(command, args, {
    cwd: workspace,
    env: restrictedChildEnvironment(workspace),
    timeoutMs: truffleHogTimeoutMs(),
  });
  if (output.code === 0) {
    return {
      status: "clean",
      summary: "TruffleHog found no verified secrets in the staged publish artifact.",
      exitCode: output.code,
    };
  }
  if (output.code === TRUFFLEHOG_SECRET_EXIT_CODE) {
    const findings = parseTruffleHogFindings(output.stdout);
    return {
      status: "blocked",
      summary:
        findings.length > 0
          ? `TruffleHog found verified secret material: ${findings.join("; ")}.`
          : "TruffleHog found verified secret material in the staged publish artifact.",
      redactedFindings: findings.length > 0 ? findings : undefined,
      exitCode: output.code,
    };
  }
  return {
    status: "failed",
    summary: publicText(`TruffleHog failed before returning a verdict: ${output.stderr}`),
    exitCode: output.code,
  };
}

export const DEFAULT_PREPUBLICATION_CLAWSCAN_TIMEOUT_MS = 15 * 60 * 1000;

function clawScanTimeoutMs() {
  const parsed = Number(process.env.PREPUBLICATION_CLAWSCAN_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_PREPUBLICATION_CLAWSCAN_TIMEOUT_MS;
}

function clawScanCommand() {
  return process.env.PREPUBLICATION_CLAWSCAN_COMMAND?.trim() || "clawscan";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown> | undefined, names: string[]) {
  if (!record) return undefined;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function verdictToStoredStatus(verdict: string | undefined): StoredLlmAnalysis["status"] {
  const normalized = verdict?.trim().toLowerCase();
  if (normalized === "benign" || normalized === "clean") return "clean";
  if (normalized === "suspicious") return "suspicious";
  if (normalized === "malicious") return "malicious";
  return "pending";
}

function collectClawScanScannerFailures(
  scanners: Record<string, unknown> | undefined,
  scannerSet: readonly string[],
) {
  const failures: string[] = [];
  for (const scanner of scannerSet) {
    const value = scanners?.[scanner];
    if (value === undefined) continue;
    const scannerRecord = asRecord(value);
    const status = readString(scannerRecord, ["status"]) ?? "unknown";
    if (status !== "completed") {
      const error = readString(scannerRecord, ["error"]);
      const errorTail = error ? publicText(error.slice(-450), 450) : undefined;
      failures.push(`${scanner}=${status}${errorTail ? ` (${errorTail})` : ""}`);
    }
  }
  return failures;
}

function storedAnalysisFromClawScanArtifact(
  artifact: unknown,
  targetKind: ClaimedJob["job"]["targetKind"],
): {
  analysis?: StoredLlmAnalysis;
  aigAnalysis?: AigAnalysis;
  error?: string;
} {
  const record = asRecord(artifact);
  const judge = asRecord(record?.judge);
  const result = asRecord(judge?.result);
  const judgeStatus = readString(judge, ["status"]);
  const judgeError = readString(judge, ["error"]);
  const requireAig = targetKind !== "packageRelease";
  const scanners = asRecord(record?.scanners);
  const requiredScanners = requireAig ? REQUIRED_SKILL_SCANNERS : REQUIRED_PACKAGE_SCANNERS;
  const scannerFailures = collectClawScanScannerFailures(scanners, requiredScanners);
  if (scannerFailures.length > 0) {
    return { error: `ClawScan scanner did not complete: ${scannerFailures.join(", ")}` };
  }
  if (judgeStatus !== "completed") {
    return {
      error: [
        `ClawScan judge status was ${judgeStatus ?? "missing"}`,
        ...(judgeError ? [judgeError] : []),
      ].join(": "),
    };
  }
  const missingScanners = requiredScanners.filter((scanner) => scanners?.[scanner] === undefined);
  if (missingScanners.length > 0) {
    return {
      error: `ClawScan scanner did not complete: ${missingScanners
        .map((scanner) => `${scanner}=missing`)
        .join(", ")}`,
    };
  }
  const verdict = readString(result, ["verdict", "status"]);
  if (!verdict) return { error: "ClawScan judge did not return a verdict" };

  const dimensions = Array.isArray(result?.dimensions)
    ? (result.dimensions as StoredLlmAnalysis["dimensions"])
    : undefined;
  const confidence = readString(result, ["confidence"]);
  const findings = readString(result, ["findings"]);
  const guidance = readString(result, ["guidance"]);
  const model = readString(result, ["model"]);
  const summary = readString(result, ["summary"]);
  const checkedAt = Date.now();
  let aigAnalysis: AigAnalysis | undefined;
  if (requireAig) {
    const aig = asRecord(asRecord(record?.scanners)?.aig);
    if (!aig || aig.raw === undefined) {
      return { error: "ClawScan aig scanner output was missing" };
    }
    const rawAig = typeof aig.raw === "string" ? aig.raw : JSON.stringify(aig.raw);
    aigAnalysis = normalizeAigAnalysis(rawAig, checkedAt);
    if (aigAnalysis.status === "error") {
      return { error: aigAnalysis.error ?? "A.I.G returned unusable scanner output" };
    }
  }
  return {
    aigAnalysis,
    analysis: {
      checkedAt,
      status: verdictToStoredStatus(verdict),
      verdict,
      ...(confidence ? { confidence } : {}),
      ...(dimensions ? { dimensions } : {}),
      ...(findings ? { findings } : {}),
      ...(guidance ? { guidance } : {}),
      ...(model ? { model } : {}),
      ...(summary ? { summary } : {}),
    },
  };
}

function clawScanCheckResult(analysis: StoredLlmAnalysis): WorkerCheckResult {
  const status = (analysis.status || analysis.verdict || "").trim().toLowerCase();
  const verdict = (analysis.verdict || "").trim().toLowerCase();
  const normalizedVerdict = verdict || status;
  const summary = publicText(
    analysis.summary ?? analysis.findings ?? `ClawScan returned ${analysis.status}.`,
  );
  if (status === "clean" || normalizedVerdict === "benign") {
    return {
      status: "clean",
      summary: summary || "ClawScan passed.",
    };
  }
  if (normalizedVerdict === "suspicious") {
    return {
      status: "clean",
      summary: summary || "ClawScan returned suspicious review findings.",
      redactedFindings: [publicText(`status=${analysis.status}; verdict=${analysis.verdict}`)],
    };
  }
  if (normalizedVerdict !== "malicious") {
    return {
      status: "failed",
      summary: summary || "ClawScan did not return a final verdict.",
      redactedFindings: [publicText(`status=${analysis.status}; verdict=${analysis.verdict}`)],
    };
  }
  return {
    status: "blocked",
    summary: summary || `ClawScan blocked the staged publish with status ${analysis.status}.`,
    redactedFindings: [publicText(`status=${analysis.status}; verdict=${analysis.verdict}`)],
  };
}

export async function runNativeClawScan(
  job: ClaimedJob,
  workspace: string,
): Promise<ClawScanResult> {
  const artifactPath = join(workspace, "clawscan-result.json");
  const target = await resolveClawScanTarget(workspace, job);
  if (job.job.targetKind !== "packageRelease") {
    assertAigFilePathsHaveNoCompiledPython(job.target.files?.map((file) => file.path) ?? []);
  }
  const command = clawScanCommand();
  const args = [target, "--profile", "clawhub", "--output", artifactPath];
  const sandbox = process.env.PREPUBLICATION_CLAWSCAN_SANDBOX?.trim();
  if (sandbox) {
    args.push("--sandbox", sandbox);
    const sandboxImage = process.env.PREPUBLICATION_CLAWSCAN_SANDBOX_IMAGE?.trim();
    if (sandbox === "docker" && sandboxImage) args.push("--sandbox-image", sandboxImage);
  }

  const output = await runCommand(command, args, {
    cwd: workspace,
    env: restrictedChildEnvironment(workspace, CLAWSCAN_PROVIDER_ENV_KEYS),
    timeoutMs: clawScanTimeoutMs(),
  });
  if (output.code !== 0) {
    return {
      check: {
        status: "failed",
        summary: publicText(
          `ClawScan failed before returning a verdict: ${output.stderr || output.stdout}`,
        ),
      },
    };
  }

  const raw = await readFile(artifactPath, "utf8");
  const parsed = storedAnalysisFromClawScanArtifact(JSON.parse(raw) as unknown, job.job.targetKind);
  if (parsed.error || !parsed.analysis) {
    return {
      check: {
        status: "failed",
        summary: publicText(parsed.error ?? "ClawScan did not return a usable result."),
      },
    };
  }
  return {
    analysis: parsed.analysis,
    aigAnalysis: parsed.aigAnalysis,
    check: clawScanCheckResult(parsed.analysis),
  };
}

function checkResultForConvex(result: WorkerCheckResult): WorkerCheckResult {
  return {
    status: result.status,
    ...(result.summary ? { summary: result.summary } : {}),
    ...(result.redactedFindings ? { redactedFindings: result.redactedFindings } : {}),
  };
}

async function completeAttempt(
  client: PrePublicationWorkerClient,
  token: string,
  attempt: ClaimedPrePublicationAttempt,
  trufflehog: WorkerCheckResult,
  clawscan: WorkerCheckResult,
  clawscanAnalysis?: StoredLlmAnalysis,
  aigAnalysis?: AigAnalysis,
) {
  return await client.action(api.publishAttempts.completePrePublicationChecks, {
    token,
    attemptId: attempt.attemptId,
    claimId: attempt.claimId,
    artifactFingerprint: attempt.artifactFingerprint,
    trufflehog: checkResultForConvex(trufflehog),
    clawscan: checkResultForConvex(clawscan),
    ...(clawscanAnalysis ? { clawscanAnalysis } : {}),
    ...(aigAnalysis ? { aigAnalysis } : {}),
  });
}

export async function processPrePublicationAttempt(
  client: PrePublicationWorkerClient,
  token: string,
  attempt: ClaimedPrePublicationAttempt,
  deps: ProcessAttemptDeps = {},
) {
  if (attempt.status === "ready_to_finalize") {
    try {
      const result = await completeAttempt(
        client,
        token,
        attempt,
        {
          status: "clean",
          summary: "Pre-publication TruffleHog check already passed.",
        },
        {
          status: "clean",
          summary: "Pre-publication ClawScan already passed.",
        },
        undefined,
        attempt.existingAigAnalysis,
      );
      logger.info(
        {
          attemptId: attempt.attemptId,
          event: "prepublication_attempt_finalization_retried",
          kind: attempt.kind,
        },
        "pre-publication attempt finalization retried",
      );
      return { completed: (result as { status?: string })?.status === "finalized", result };
    } catch {
      logger.warn(
        {
          attemptId: attempt.attemptId,
          event: "prepublication_attempt_finalization_retry_failed",
          kind: attempt.kind,
        },
        "pre-publication attempt finalization retry failed",
      );
      return { completed: false, result: undefined };
    }
  }

  const workspace = await mkdtemp(
    join(tmpdir(), `clawhub-prepublication-${basename(String(attempt.attemptId))}-`),
  );
  const startedAt = Date.now();
  const writeWorkspace = deps.writeWorkspace ?? writeArtifactWorkspace;
  const runTruffleHog = deps.runTruffleHog ?? runNativeTruffleHog;
  const runClawScan = deps.runClawScan ?? runNativeClawScan;
  let truffleHogBlocked = false;
  let completionStarted = false;
  try {
    const job = buildSyntheticScanJob(attempt);
    await writeWorkspace(job, workspace);
    if (attempt.kind === "skill") {
      assertAigFilePathsHaveNoCompiledPython(attempt.files.map((file) => file.path));
    }
    const trufflehog = await runTruffleHog(workspace);
    if (trufflehog.status === "blocked") {
      truffleHogBlocked = true;
      completionStarted = true;
      const result = await completeAttempt(client, token, attempt, trufflehog, {
        status: "failed",
        summary: "ClawScan skipped because TruffleHog blocked the artifact.",
      });
      logger.info(
        {
          attemptId: attempt.attemptId,
          durationMs: Date.now() - startedAt,
          event: "prepublication_attempt_blocked",
          kind: attempt.kind,
          scanner: "trufflehog",
        },
        "pre-publication attempt blocked by TruffleHog",
      );
      return { completed: true, result };
    }
    if (trufflehog.status === "failed") {
      completionStarted = true;
      const result = await completeAttempt(client, token, attempt, trufflehog, {
        status: "failed",
        summary: "ClawScan skipped because TruffleHog failed.",
      });
      return { completed: false, result };
    }

    let clawscan: WorkerCheckResult;
    let clawscanAnalysis: StoredLlmAnalysis | undefined;
    let aigAnalysis: AigAnalysis | undefined;
    const existingClawscanAnalysis = attempt.existingClawscanAnalysis;
    const existingAigAnalysis = attempt.existingAigAnalysis;
    if (
      existingClawscanAnalysis &&
      (attempt.kind === "package" ||
        (existingAigAnalysis &&
          existingAigAnalysis.status !== "error" &&
          existingAigAnalysis.checkedAt === existingClawscanAnalysis.checkedAt))
    ) {
      clawscanAnalysis = existingClawscanAnalysis;
      aigAnalysis = attempt.kind === "skill" ? existingAigAnalysis : undefined;
      clawscan = clawScanCheckResult(clawscanAnalysis);
      logger.info(
        {
          attemptId: attempt.attemptId,
          event: "prepublication_clawscan_result_reused",
          kind: attempt.kind,
        },
        "pre-publication ClawScan result reused for exact artifact",
      );
    } else {
      try {
        const review = await runClawScan(job, workspace);
        clawscanAnalysis = review.analysis;
        aigAnalysis = review.aigAnalysis;
        clawscan = review.check;
      } catch (error) {
        clawscan = {
          status: "failed",
          summary: publicText(error instanceof Error ? error.message : String(error)),
        };
      }
    }

    completionStarted = true;
    const result = await completeAttempt(
      client,
      token,
      attempt,
      trufflehog,
      clawscan,
      clawscanAnalysis,
      aigAnalysis,
    );
    logger.info(
      {
        attemptId: attempt.attemptId,
        clawscanSummary: clawscan.summary,
        clawscanStatus: clawscan.status,
        durationMs: Date.now() - startedAt,
        event: "prepublication_attempt_completed",
        kind: attempt.kind,
        trufflehogStatus: trufflehog.status,
      },
      "pre-publication attempt completed",
    );
    const status = (result as { status?: string })?.status;
    return { completed: status === "finalized" || status === "blocked", result };
  } catch (error) {
    if (truffleHogBlocked) {
      logger.error(
        {
          attemptId: attempt.attemptId,
          durationMs: Date.now() - startedAt,
          event: "prepublication_attempt_secret_block_completion_failed",
          kind: attempt.kind,
        },
        "pre-publication TruffleHog block completion failed; leaving attempt retryable",
      );
      return { completed: false, result: undefined };
    }
    if (completionStarted) {
      logger.warn(
        {
          attemptId: attempt.attemptId,
          durationMs: Date.now() - startedAt,
          event: "prepublication_attempt_completion_failed",
          kind: attempt.kind,
        },
        "pre-publication attempt completion failed; leaving attempt retryable",
      );
      return { completed: false, result: undefined };
    }
    const failure = {
      status: "failed" as const,
      summary: publicText(error instanceof Error ? error.message : String(error)),
    };
    let result: unknown;
    try {
      result = await completeAttempt(client, token, attempt, failure, failure);
    } catch {
      logger.warn(
        {
          attemptId: attempt.attemptId,
          durationMs: Date.now() - startedAt,
          event: "prepublication_attempt_failure_record_failed",
          kind: attempt.kind,
        },
        "pre-publication attempt failure could not be recorded; leaving attempt retryable",
      );
      return { completed: false, result: undefined };
    }
    logger.warn(
      {
        attemptId: attempt.attemptId,
        durationMs: Date.now() - startedAt,
        event: "prepublication_attempt_failed",
        kind: attempt.kind,
      },
      "pre-publication attempt failed before checks completed",
    );
    return { completed: false, result };
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}

export async function processPrePublicationBatch(
  attempts: ClaimedPrePublicationAttempt[],
  processAttempt: (attempt: ClaimedPrePublicationAttempt) => Promise<ProcessAttemptResult>,
) {
  return await Promise.all(
    attempts.map(async (attempt) => {
      try {
        return await processAttempt(attempt);
      } catch {
        logger.warn(
          {
            attemptId: attempt.attemptId,
            event: "prepublication_attempt_unhandled_failure",
            kind: attempt.kind,
          },
          "pre-publication attempt failed unexpectedly; continuing batch",
        );
        return { completed: false, result: undefined };
      }
    }),
  );
}

export async function claimPrePublicationAttempt(
  client: PrePublicationWorkerClient,
  token: string,
  filters: PrePublicationClaimFilters = {},
  preferRetry = false,
) {
  return (await client.action(api.publishAttempts.claimPrePublicationChecks, {
    token,
    ...filters,
    ...(preferRetry ? { preferRetry: true } : {}),
  })) as ClaimedPrePublicationAttempt | null;
}

export async function claimPrePublicationBatch(
  client: PrePublicationWorkerClient,
  token: string,
  limit: number,
  filters: PrePublicationClaimFilters = {},
) {
  const claims = await Promise.allSettled(
    Array.from({ length: limit }, (_, index) =>
      claimPrePublicationAttempt(client, token, filters, index === 0),
    ),
  );
  const attempts: ClaimedPrePublicationAttempt[] = [];
  const failures: unknown[] = [];
  for (const claim of claims) {
    if (claim.status === "fulfilled") {
      if (claim.value) attempts.push(claim.value);
      continue;
    }
    failures.push(claim.reason);
    logger.warn(
      { event: "prepublication_claim_failed" },
      "pre-publication claim failed; continuing with successful claims",
    );
  }
  if (attempts.length === 0 && failures.length > 0) {
    throw new AggregateError(failures, "Pre-publication claims failed without claiming work.");
  }
  return { attempts, claimFailures: failures.length };
}

export function claimBatchDrainedQueue(
  claimFailures: number,
  claimedAttempts: number,
  claimLimit: number,
) {
  return claimFailures === 0 && claimedAttempts < claimLimit;
}

async function main() {
  const { batchLimit, claimFilters, maxJobs, maxRuntimeMs } = parseArgs();
  maskKnownWorkerSecrets();
  const convexUrl = process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL;
  if (!convexUrl) throw new Error("CONVEX_URL or VITE_CONVEX_URL is required");
  const token = requireEnv("SECURITY_SCAN_WORKER_TOKEN");
  const client = new ConvexHttpClient(convexUrl);
  const startedAt = Date.now();
  const claimDeadline = startedAt + maxRuntimeMs;
  let totalClaimed = 0;
  let totalCompleted = 0;

  logger.info(
    {
      event: "prepublication_worker_started",
      workerId:
        process.env.PREPUBLICATION_WORKER_ID ??
        `github-actions:${process.env.GITHUB_RUN_ID ?? process.pid}`,
    },
    "pre-publication worker started",
  );

  while (Date.now() < claimDeadline) {
    if (totalClaimed > 0 && claimDeadline - Date.now() < CLAIM_WINDOW_SHUTDOWN_BUFFER_MS) break;
    const remainingJobs = maxJobs === undefined ? batchLimit : Math.max(0, maxJobs - totalClaimed);
    if (remainingJobs === 0) break;
    const targeted = Object.values(claimFilters).some(Boolean);
    const claimLimit = Math.min(targeted ? 1 : batchLimit, remainingJobs);
    const { attempts, claimFailures } = await claimPrePublicationBatch(
      client,
      token,
      claimLimit,
      claimFilters,
    );
    if (attempts.length === 0) break;
    totalClaimed += attempts.length;
    const results = await processPrePublicationBatch(attempts, (attempt) =>
      processPrePublicationAttempt(client, token, attempt),
    );
    totalCompleted += results.filter((result) => result.completed).length;
    if (claimBatchDrainedQueue(claimFailures, attempts.length, claimLimit)) break;
  }

  logger.info(
    {
      elapsedMs: Date.now() - startedAt,
      event: "prepublication_worker_summary",
      totalClaimed,
      totalCompleted,
    },
    "pre-publication worker summary",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
