/* @vitest-environment node */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const recovery = {
  ok: true,
  attemptId: "successor",
  recoveredFromAttemptId: "predecessor",
  packageId: "package",
  releaseId: "release",
  name: "@example/plugin",
  version: "1.2.3",
  status: "pending_checks",
  publicationStatus: "pending",
  reused: false,
};

it.for([
  { scenario: "pending", wait: false, expectedCode: 0 },
  { scenario: "published", wait: true, expectedCode: 0 },
  { scenario: "failed replay", wait: false, expectedCode: 1 },
  { scenario: "forbidden", wait: false, expectedCode: 1 },
  { scenario: "revoked", wait: true, expectedCode: 1 },
  { scenario: "invalid reason", wait: false, expectedCode: 1 },
] as const)(
  "package recover handles $scenario through the real CLI",
  async (testCase, { signal }) => {
    const dir = await mkdtemp(join(tmpdir(), "clawhub-cli-recovery-"));
    const requests: Array<{
      method?: string;
      url?: string;
      body: unknown;
      authorization?: string;
    }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: request.method,
        url: request.url,
        body: body ? JSON.parse(body) : null,
        authorization: request.headers.authorization,
      });
      response.setHeader("content-type", "application/json");
      if (testCase.scenario === "forbidden") {
        response.writeHead(403).end(JSON.stringify({ error: "Publisher access required" }));
      } else if (request.method === "GET" && testCase.scenario === "revoked") {
        response.writeHead(401).end(JSON.stringify({ error: "Token revoked" }));
      } else if (request.method === "GET") {
        response.end(
          JSON.stringify({
            ...recovery,
            status: "finalized",
            publicationStatus: "published",
            terminal: true,
            checks: { trufflehog: { status: "clean" }, clawscan: { status: "clean" } },
          }),
        );
      } else {
        response.writeHead(testCase.scenario === "failed replay" ? 200 : 202).end(
          JSON.stringify({
            ...recovery,
            ...(testCase.scenario === "failed replay"
              ? { status: "failed", publicationStatus: "failed", reused: true }
              : {}),
          }),
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const registry = `http://127.0.0.1:${address.port}`;
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ registry, token: "clh_fixture" }));
    const args = [
      "src/cli.ts",
      "--workdir",
      dir,
      "--registry",
      registry,
      "--no-input",
      "package",
      "recover",
      "predecessor",
      "--manual-override-reason",
      testCase.scenario === "invalid reason" ? " " : "  Retry interrupted publication  ",
      "--json",
      ...(testCase.wait ? ["--wait", "--wait-timeout", "5"] : []),
    ];
    const child = spawn("bun", args, {
      signal,
      cwd: packageRoot,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        TMPDIR: tmpdir(),
        NO_COLOR: "1",
        CLAWHUB_CONFIG_PATH: configPath,
        ACTIONS_ID_TOKEN_REQUEST_URL: `${registry}/oidc`,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect({ code, stderr }).toMatchObject({ code: testCase.expectedCode });
      if (testCase.scenario === "invalid reason") {
        expect(requests).toEqual([]);
        expect(stderr).toContain("1 through 500");
        return;
      }
      expect(requests[0]).toEqual({
        method: "POST",
        url: "/api/v1/publish/attempts/predecessor/recover",
        body: { manualOverrideReason: "Retry interrupted publication" },
        authorization: "Bearer clh_fixture",
      });
      expect(requests).toHaveLength(testCase.wait ? 2 : 1);
      if (testCase.expectedCode === 0) {
        expect(JSON.parse(stdout)).toMatchObject({
          recoveredFromAttemptId: "predecessor",
          attemptId: "successor",
          publicationStatus: testCase.wait ? "published" : "pending",
        });
      } else {
        expect(stdout).not.toContain("pending security checks");
        expect(stderr).toContain(
          testCase.scenario === "forbidden"
            ? "Publisher access required"
            : testCase.scenario === "revoked"
              ? "Token revoked"
              : "Recovery failed",
        );
      }
      if (testCase.wait) expect(requests[1]?.url).toBe("/api/v1/publish/attempts/successor");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
