import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { crc32, createDeflateRaw } from "node:zlib";
import { EXPERIMENTAL_CLAW_FEED_ID, serializeExperimentalClawFeed } from "clawhub-schema";
import { gzipSync, strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertSafeClawArchive,
  extractSafeClawZip,
  findExtractedPackageRoot,
  readResponseBytesBounded,
  runPublishedClawDryRun,
  selectPublishedClaw,
} from "./claws-feed-openclaw-e2e";

const execFileAsync = promisify(execFile);
const openclawRepo = process.env.OPENCLAW_CLAWS_CHECKOUT;
const fixtureRoot = resolve("fixtures/claws/hosted-e2e");
const conformanceFixture = resolve("fixtures/claws/conformance-v1/cases.json");
let tempRoot = "";
let archiveBytes = new Uint8Array();
let integrity = "";
let server: Server | undefined;
let serverPort = 0;
const TAR_BLOCK_SIZE = 512;

function writeTarString(target: Uint8Array, offset: number, width: number, value: string) {
  target.set(new TextEncoder().encode(value).subarray(0, width), offset);
}

function writeTarOctal(target: Uint8Array, offset: number, width: number, value: number) {
  writeTarString(target, offset, width, `${value.toString(8).padStart(width - 1, "0")}\0`);
}

function tarEntry(path: string, type: "0" | "2", content = new Uint8Array()) {
  const header = new Uint8Array(TAR_BLOCK_SIZE);
  writeTarString(header, 0, 100, path);
  writeTarOctal(header, 100, 8, type === "0" ? 0o644 : 0o777);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, content.byteLength);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  if (type === "2") writeTarString(header, 157, 100, "../../outside");
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  writeTarOctal(
    header,
    148,
    8,
    header.reduce((sum, byte) => sum + byte, 0),
  );
  const body = new Uint8Array(Math.ceil(content.byteLength / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE);
  body.set(content);
  return [header, body];
}

function deterministicLinkArchive() {
  const parts = [
    ...tarEntry(
      "package/package.json",
      "0",
      new TextEncoder().encode('{"name":"@openclaw/hosted-e2e","version":"1.0.0"}\n'),
    ),
    ...tarEntry("package/workspace", "2"),
    new Uint8Array(TAR_BLOCK_SIZE * 2),
  ];
  const tar = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    tar.set(part, offset);
    offset += part.byteLength;
  }
  return gzipSync(tar);
}

async function compactZipOfZeros(path: string, unpackedSize: number) {
  const deflate = createDeflateRaw({ level: 9 });
  const compressedChunks: Buffer[] = [];
  deflate.on("data", (chunk: Buffer) => compressedChunks.push(chunk));
  const finished = once(deflate, "end");
  const zeroChunk = Buffer.alloc(64 * 1024);
  let remaining = unpackedSize;
  let checksum = 0;
  while (remaining > 0) {
    const chunk = zeroChunk.subarray(0, Math.min(remaining, zeroChunk.byteLength));
    checksum = crc32(chunk, checksum);
    remaining -= chunk.byteLength;
    if (!deflate.write(chunk)) await once(deflate, "drain");
  }
  deflate.end();
  await finished;

  const compressed = Buffer.concat(compressedChunks);
  const encodedPath = strToU8(path);
  const localHeaderSize = 30;
  const centralHeaderSize = 46;
  const endRecordSize = 22;
  const centralOffset = localHeaderSize + encodedPath.byteLength + compressed.byteLength;
  const centralSize = centralHeaderSize + encodedPath.byteLength;
  const archive = new Uint8Array(centralOffset + centralSize + endRecordSize);
  const view = new DataView(archive.buffer);

  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(8, 8, true);
  view.setUint32(14, checksum, true);
  view.setUint32(18, compressed.byteLength, true);
  view.setUint32(22, unpackedSize, true);
  view.setUint16(26, encodedPath.byteLength, true);
  archive.set(encodedPath, localHeaderSize);
  archive.set(compressed, localHeaderSize + encodedPath.byteLength);

  view.setUint32(centralOffset, 0x02014b50, true);
  view.setUint16(centralOffset + 4, 20, true);
  view.setUint16(centralOffset + 6, 20, true);
  view.setUint16(centralOffset + 10, 8, true);
  view.setUint32(centralOffset + 16, checksum, true);
  view.setUint32(centralOffset + 20, compressed.byteLength, true);
  view.setUint32(centralOffset + 24, unpackedSize, true);
  view.setUint16(centralOffset + 28, encodedPath.byteLength, true);
  archive.set(encodedPath, centralOffset + centralHeaderSize);

  const endOffset = centralOffset + centralSize;
  view.setUint32(endOffset, 0x06054b50, true);
  view.setUint16(endOffset + 8, 1, true);
  view.setUint16(endOffset + 10, 1, true);
  view.setUint32(endOffset + 12, centralSize, true);
  view.setUint32(endOffset + 16, centralOffset, true);
  return archive;
}

async function npmPackFixture(destination: string) {
  const npmArgs =
    process.platform === "win32"
      ? [join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")]
      : [];
  const { stdout } = await execFileAsync(
    process.platform === "win32" ? process.execPath : "npm",
    [
      ...npmArgs,
      "pack",
      join(fixtureRoot, "package"),
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      destination,
    ],
    { cwd: destination },
  );
  const output = JSON.parse(stdout) as unknown;
  const packed = Array.isArray(output)
    ? output[0]
    : output && typeof output === "object"
      ? Object.values(output)[0]
      : undefined;
  const filename = packed && typeof packed.filename === "string" ? packed.filename : undefined;
  if (!filename) throw new Error("npm pack did not return a fixture filename");
  return join(destination, filename);
}

function feedValue() {
  const now = Date.now();
  return JSON.parse(
    serializeExperimentalClawFeed({
      schemaVersion: 1,
      id: EXPERIMENTAL_CLAW_FEED_ID,
      generatedAt: new Date(now).toISOString(),
      sequence: 1,
      expiresAt: new Date(now + 86_400_000).toISOString(),
      entries: [
        {
          type: "claw",
          id: "@openclaw/hosted-e2e",
          title: "Hosted E2E",
          version: "1.0.0",
          state: "available",
          publisher: { id: "openclaw", trust: "official" },
          clawManifestSummary: {
            schemaVersion: 1,
            agent: { id: "hosted-e2e", name: "Hosted E2E" },
            workspace: {
              bootstrapFiles: ["BOOTSTRAP.md", "HEARTBEAT.md", "SOUL.md"],
              fileCount: 1,
            },
            packages: { skillCount: 0, pluginCount: 0 },
            profiles: { count: 1, hasOpenClaw: true },
            extensions: { count: 0 },
            mcpServerCount: 0,
            cronJobCount: 0,
          },
          install: {
            candidates: [
              {
                sourceRef: "public-clawhub",
                package: "@openclaw/hosted-e2e",
                version: "1.0.0",
                integrity,
              },
            ],
          },
        },
      ],
    }),
  );
}

async function runOpenClawProfileConformance(openclawCheckout: string) {
  const runner = `
    import { readFileSync } from "node:fs";
    import { parse } from "yaml";
    import { parseClawOpenClawProfile } from "./src/claws/schema.ts";
    const cases = JSON.parse(readFileSync(process.env.CLAWHUB_CONFORMANCE_CASES, "utf8"));
    const vectors = [
      ...cases.profileCases,
      ...cases.heartbeatCases,
      ...cases.extensionCases,
    ];
    const mismatches = vectors
      .filter((vector) => parseClawOpenClawProfile(parse(vector.yaml)).ok !== vector.consumerAccepted)
      .map((vector) => vector.name);
    process.stdout.write(JSON.stringify(mismatches));
  `;
  const { stdout } = await execFileAsync("pnpm", ["exec", "tsx", "--eval", runner], {
    cwd: openclawCheckout,
    env: {
      ...process.env,
      CLAWHUB_CONFORMANCE_CASES: conformanceFixture,
    },
  });
  return JSON.parse(stdout) as string[];
}

describe("published Claw to OpenClaw dry-run proof", () => {
  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "clawhub-hosted-e2e-fixture-"));
    const archivePath = await npmPackFixture(tempRoot);
    archiveBytes = new Uint8Array(await readFile(archivePath));
    integrity = `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}`;
    server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/v1/feeds/claws") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(feedValue()));
        return;
      }
      if (pathname === "/api/v1/packages/%40openclaw%2Fhosted-e2e/versions/1.0.0/artifact") {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            artifact: {
              kind: "npm-pack",
              sha256: integrity.slice("sha256:".length),
              downloadUrl: "/download.tgz",
            },
          }),
        );
        return;
      }
      if (pathname === "/download.tgz") {
        response.setHeader("Content-Type", "application/gzip");
        response.end(archiveBytes);
        return;
      }
      response.statusCode = 404;
      response.end("Not found");
    });
    await new Promise<void>((resolveListen) => server!.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
    serverPort = address.port;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  }, 30_000);

  it("selects only the exact public ClawHub candidate", () => {
    const selected = selectPublishedClaw(feedValue(), "@openclaw/hosted-e2e");
    expect(selected.candidate).toMatchObject({ version: "1.0.0", integrity });
    expect(() => selectPublishedClaw(feedValue(), "@openclaw/missing")).toThrow("was not present");
  });

  it("builds a portable production-equivalent ClawPack fixture", async () => {
    const archivePath = join(tempRoot, "portable-claw.tgz");
    await writeFile(archivePath, archiveBytes);
    await expect(assertSafeClawArchive(archivePath)).resolves.toBeUndefined();
  });

  it("rejects link entries before extracting a published artifact", async () => {
    const archivePath = join(tempRoot, "linked.tgz");
    await writeFile(archivePath, deterministicLinkArchive());
    await expect(assertSafeClawArchive(archivePath)).rejects.toThrow(
      "only contain regular files and directories",
    );
  });

  it("extracts legacy ZIP artifacts without permitting traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawhub-hosted-e2e-zip-"));
    try {
      const archive = zipSync({
        "package/package.json": strToU8("{}\n"),
        "package/CLAW.md": strToU8("---\nschemaVersion: 1\n---\n"),
      });
      await extractSafeClawZip(archive, root);
      await expect(readFile(join(root, "package", "package.json"), "utf8")).resolves.toBe("{}\n");

      const unsafeArchive = zipSync({ "../outside": strToU8("unsafe") });
      await expect(extractSafeClawZip(unsafeArchive, root)).rejects.toThrow("unsafe path");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers legacy ZIP packages extracted directly at the archive root", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawhub-hosted-e2e-root-zip-"));
    try {
      const archive = zipSync({
        "package.json": strToU8("{}\n"),
        "CLAW.md": strToU8("---\nschemaVersion: 1\n---\n"),
      });
      await extractSafeClawZip(archive, root);
      await expect(findExtractedPackageRoot(root)).resolves.toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects ZIP artifacts whose expanded content exceeds the package limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawhub-hosted-e2e-large-zip-"));
    try {
      const archive = await compactZipOfZeros("package/large.bin", 50 * 1024 * 1024 + 1);
      expect(archive.byteLength).toBeLessThan(64 * 1024);
      await expect(extractSafeClawZip(archive, root)).rejects.toThrow("50MB unpacked limit");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects oversized downloads from metadata before buffering the body", async () => {
    const response = new Response("", { headers: { "Content-Length": String(65 * 1024 * 1024) } });
    await expect(readResponseBytesBounded(response)).rejects.toThrow("64MB download limit");
  });

  it.skipIf(!openclawRepo)(
    "executes profile conformance vectors against the pinned OpenClaw parser",
    async () => {
      await expect(runOpenClawProfileConformance(openclawRepo!)).resolves.toEqual([]);
    },
  );

  it.skipIf(!openclawRepo)(
    "runs the downloaded package through OpenClaw dry-run",
    async () => {
      const origin = `http://127.0.0.1:${serverPort}`;
      const result = await runPublishedClawDryRun({
        feedUrl: `${origin}/v1/feeds/claws`,
        packageName: "@openclaw/hosted-e2e",
        registryUrl: origin,
        openclawRepo: openclawRepo!,
      });
      expect(result.plan).toMatchObject({
        schemaVersion: "openclaw.clawAddPlan.v1",
        dryRun: true,
        mutationAllowed: false,
        agent: { finalId: "hosted-e2e" },
        summary: { blockedActions: 0 },
      });
      expect(result.plan.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "agent",
            id: "hosted-e2e",
            details: expect.objectContaining({
              tools: expect.objectContaining({
                profile: "full",
                allow: ["session_status"],
              }),
            }),
          }),
          expect.objectContaining({
            kind: "workspaceFile",
            id: "SOUL.md",
            sourceKind: "clawMarkdownBody",
            blocked: false,
          }),
          expect.objectContaining({
            kind: "bootstrap",
            id: "BOOTSTRAP.md",
            blocked: false,
            details: expect.objectContaining({ lifecycle: "native-seed-once" }),
          }),
          expect.objectContaining({
            kind: "workspaceFile",
            id: "assets/incident.schema.json",
            blocked: false,
          }),
          expect.objectContaining({
            kind: "workspaceFile",
            id: "HEARTBEAT.md",
            blocked: false,
          }),
        ]),
      );
      expect(JSON.stringify(result.plan)).not.toContain(
        "Use the published Claw package without mutating local state during proof.",
      );
    },
    120_000,
  );
});
