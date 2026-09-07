import type { RateLimitArgs, RateLimitReturns } from "@convex-dev/rate-limiter";
import { unzipSync } from "fflate";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionCtx } from "./_generated/server";
import { __test, downloadZipHandler, recordArchiveDownloadMetricHandler } from "./downloads";
import {
  ARCHIVE_MANIFEST_AUDIENCE,
  ARCHIVE_MANIFEST_CONTENT_TYPE,
  ARCHIVE_MANIFEST_JWS_TYPE,
  ARCHIVE_METRIC_AUDIENCE,
  ARCHIVE_METRIC_JWS_TYPE,
  type ArchiveMetricPayload,
  signArchivePayload,
  type SkillArchiveManifest,
  verifyArchivePayloadWithLocalJwks,
} from "./lib/archiveManifest";

function isRateLimitArgs(args: unknown): args is RateLimitArgs {
  if (!args || typeof args !== "object") return false;
  const value = args as Record<string, unknown>;
  const config = value.config as Record<string, unknown> | undefined;
  return (
    typeof value.name === "string" &&
    (!("key" in value) || typeof value.key === "string") &&
    !!config &&
    typeof config === "object" &&
    (config.kind === "fixed window" || config.kind === "token bucket") &&
    typeof config.rate === "number" &&
    typeof config.period === "number"
  );
}

const okRate = (): RateLimitReturns => ({
  ok: true,
});

function stubZipResponse() {
  class MockResponse {
    status: number;
    headers: Headers;

    constructor(_body?: BodyInit | null, init?: ResponseInit) {
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers);
    }
  }
  vi.stubGlobal("Response", MockResponse as unknown as typeof Response);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function streamingBlob(text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
  } as Blob;
}

describe("downloads helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("calculates hour start boundaries", () => {
    const hour = 3_600_000;
    expect(__test.getHourStart(0)).toBe(0);
    expect(__test.getHourStart(hour - 1)).toBe(0);
    expect(__test.getHourStart(hour)).toBe(hour);
    expect(__test.getHourStart(hour + 1)).toBe(hour);
  });

  it("prefers user identity when token user exists", () => {
    const request = new Request("https://example.com", {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    expect(__test.getDownloadIdentityValue(request, "users_123")).toBe("user:users_123");
  });

  it("uses cf-connecting-ip for anonymous identity when trusted headers are enabled", () => {
    vi.stubEnv("TRUST_FORWARDED_IPS", "true");
    const request = new Request("https://example.com", {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    expect(__test.getDownloadIdentityValue(request, null)).toBe("ip:1.2.3.4");
  });

  it("falls back to forwarded ip when explicitly enabled", () => {
    vi.stubEnv("TRUST_FORWARDED_IPS", "true");
    const request = new Request("https://example.com", {
      headers: { "x-forwarded-for": "10.0.0.1, 10.0.0.2" },
    });
    expect(__test.getDownloadIdentityValue(request, null)).toBe("ip:10.0.0.1");
  });

  it("returns null when user and ip are missing", () => {
    const request = new Request("https://example.com");
    expect(__test.getDownloadIdentityValue(request, null)).toBeNull();
  });

  it("redirects direct production downloads to the Nitro streaming owner", async () => {
    vi.stubEnv("CONVEX_DEPLOYMENT", "prod:wry-manatee-359");
    vi.stubEnv("SITE_URL", "");
    vi.stubEnv("VITE_SITE_URL", "");
    const runMutation = vi.fn(async () => okRate());
    const runQuery = vi.fn(async () => null);

    const response = await downloadZipHandler(
      { runMutation, runQuery } as unknown as ActionCtx,
      new Request("https://wry-manatee-359.convex.site/api/v1/download?slug=demo&version=1.0.0"),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe(
      "https://clawhub.ai/api/v1/download?slug=demo&version=1.0.0",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(runMutation).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("keeps local direct downloads on the local Convex handler", async () => {
    vi.stubEnv("CONVEX_DEPLOYMENT", "anonymous:anonymous-clawhub-test");
    vi.stubEnv("SITE_URL", "http://127.0.0.1:3000");
    const runMutation = vi.fn(async () => okRate());
    const runQuery = vi.fn(async () => null);

    const response = await downloadZipHandler(
      { runMutation, runQuery } as unknown as ActionCtx,
      new Request("http://127.0.0.1:3211/api/v1/download?slug=demo"),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Location")).toBeNull();
    expect(runMutation).toHaveBeenCalled();
    expect(runQuery).toHaveBeenCalledOnce();
  });

  it("redirects direct downloads from a hosted Convex custom domain", async () => {
    vi.stubEnv("SITE_URL", "https://clawhub.ai");
    const runMutation = vi.fn(async () => okRate());
    const runQuery = vi.fn(async () => null);

    const response = await downloadZipHandler(
      { runMutation, runQuery } as unknown as ActionCtx,
      new Request("https://api.clawhub.example/api/v1/download?slug=demo"),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("https://clawhub.ai/api/v1/download?slug=demo");
    expect(runMutation).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("schedules zip download stats outside the response path", async () => {
    vi.stubEnv("TRUST_FORWARDED_IPS", "true");

    const runQuery = vi.fn(async (_query: unknown, args: Record<string, unknown>) => {
      if ("slug" in args) {
        return {
          skill: {
            _id: "skills:1",
            ownerUserId: "users:1",
            slug: "demo",
            tags: {},
            latestVersionId: "skillVersions:1",
          },
          moderationInfo: null,
        };
      }
      if ("versionId" in args) {
        return {
          _id: "skillVersions:1",
          skillId: "skills:1",
          version: "1.0.0",
          createdAt: 3,
          files: [{ path: "SKILL.md", storageId: "_storage:1" }],
          softDeletedAt: undefined,
        };
      }
      return null;
    });
    const runMutation = vi.fn(async (mutation: unknown, args: Record<string, unknown>) => {
      if (isRateLimitArgs(args)) return okRate();
      return { mutation, args };
    });
    const runAfter = vi.fn();
    const storageGet = vi.fn().mockResolvedValue(streamingBlob("hello"));

    const response = await downloadZipHandler(
      {
        runQuery,
        runMutation,
        scheduler: { runAfter },
        storage: {
          get: storageGet,
          getMetadata: vi.fn().mockResolvedValue({}),
        },
      } as unknown as ActionCtx,
      new Request("https://preview-branch-123.convex.site/api/v1/download?slug=demo", {
        headers: { "cf-connecting-ip": "1.2.3.4" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    const archive = new Uint8Array(await response.arrayBuffer());
    expect(storageGet).toHaveBeenCalledWith("_storage:1");
    expect(new TextDecoder().decode(unzipSync(archive)["SKILL.md"])).toBe("hello");

    const recordCalls = runAfter.mock.calls.filter(([, , args]) => {
      if (!args || typeof args !== "object") return false;
      const value = args as Record<string, unknown>;
      return (
        typeof value.target === "object" &&
        typeof value.identityHash === "string" &&
        value.identityKind === "ip" &&
        typeof value.dayStart === "number"
      );
    });
    expect(recordCalls).toHaveLength(1);
    expect(recordCalls[0]?.[0]).toEqual(expect.any(Number));
    expect(recordCalls[0]?.[0]).toBeGreaterThanOrEqual(0);
    expect(recordCalls[0]?.[0]).toBeLessThan(60_000);
    expect(recordCalls[0]?.[2]).toEqual({
      target: { kind: "skill", id: "skills:1" },
      identityKind: "ip",
      identityHash: expect.any(String),
      dayStart: expect.any(Number),
      occurredAt: expect.any(Number),
    });
  });

  it("returns a bounded archive manifest to the Nitro streaming owner", async () => {
    vi.stubEnv("CLAWHUB_PREVIEW", "1");
    vi.stubEnv("TRUST_FORWARDED_IPS", "true");
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    const keyPair = await generateKeyPair("RS256", { extractable: true });
    const privateKey = await exportPKCS8(keyPair.privateKey);
    const publicKey = await exportJWK(keyPair.publicKey);
    const jwks = JSON.stringify({ keys: [{ use: "sig", ...publicKey }] });
    vi.stubEnv("JWT_PRIVATE_KEY", privateKey);
    vi.stubEnv("JWKS", jwks);
    const runQuery = vi.fn(async (_query: unknown, args: Record<string, unknown>) => {
      if ("slug" in args) {
        return {
          skill: {
            _id: "skills:1",
            ownerUserId: "users:1",
            slug: "demo",
            tags: {},
            latestVersionId: "skillVersions:1",
          },
          moderationInfo: null,
        };
      }
      if ("versionId" in args) {
        return {
          _id: "skillVersions:1",
          skillId: "skills:1",
          version: "1.0.0+build",
          createdAt: 3,
          files: [
            { path: "SKILL.md", storageId: "_storage:1" },
            { path: "missing.txt", storageId: "_storage:missing" },
          ],
          softDeletedAt: undefined,
        };
      }
      return null;
    });
    const runMutation = vi.fn(async (_mutation: unknown, args: Record<string, unknown>) => {
      if (isRateLimitArgs(args)) return okRate();
      return null;
    });
    const runAfter = vi.fn();
    const storageGet = vi.fn();
    const storageGetUrl = vi.fn(async (storageId: string) =>
      storageId === "_storage:1"
        ? "https://preview-branch-123.convex.cloud/api/storage/storage-1"
        : null,
    );

    const response = await downloadZipHandler(
      {
        runQuery,
        runMutation,
        scheduler: { runAfter },
        storage: {
          get: storageGet,
          getUrl: storageGetUrl,
          getMetadata: vi.fn(),
        },
      } as unknown as ActionCtx,
      new Request("https://preview-branch-123.convex.site/api/v1/download?slug=demo", {
        headers: {
          "cf-connecting-ip": "1.2.3.4",
          "x-clawhub-archive-manifest": "v1",
          "x-clawhub-vercel-oidc-token": "vercel-oidc",
        },
      }),
      { verifyArchiveRequester: vi.fn(async () => undefined) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(ARCHIVE_MANIFEST_CONTENT_TYPE);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const manifest = (await verifyArchivePayloadWithLocalJwks(
      await response.text(),
      ARCHIVE_MANIFEST_JWS_TYPE,
      jwks,
    )) as SkillArchiveManifest;
    expect(manifest).toEqual({
      schema: "clawhub.skill-archive-manifest.v1",
      issuer: "https://preview-branch-123.convex.site",
      audience: ARCHIVE_MANIFEST_AUDIENCE,
      issuedAt: 10_000,
      expiresAt: 40_000,
      filename: "demo-1.0.0+build.zip",
      meta: {
        ownerId: "users:1",
        slug: "demo",
        version: "1.0.0+build",
        publishedAt: 3,
      },
      entries: [
        {
          path: "SKILL.md",
          url: "https://preview-branch-123.convex.cloud/api/storage/storage-1",
        },
      ],
      metricToken: expect.any(String),
    });
    const metricPayload = (await verifyArchivePayloadWithLocalJwks(
      manifest.metricToken!,
      ARCHIVE_METRIC_JWS_TYPE,
      jwks,
    )) as ArchiveMetricPayload;
    expect(metricPayload).toMatchObject({
      schema: "clawhub.archive-download-metric.v1",
      issuer: "https://preview-branch-123.convex.site",
      audience: ARCHIVE_METRIC_AUDIENCE,
      issuedAt: 10_000,
      expiresAt: 40_000,
      metric: {
        target: { kind: "skill", id: "skills:1" },
        identityKind: "ip",
        identityHash: expect.any(String),
        dayStart: 0,
        occurredAt: 10_000,
      },
    });
    expect(storageGet).not.toHaveBeenCalled();
    expect(storageGetUrl).toHaveBeenCalledTimes(2);
    expect(runAfter).not.toHaveBeenCalled();
  });

  it("rejects a direct manifest request without the Nitro Vercel identity", async () => {
    vi.stubEnv("CLAWHUB_PREVIEW", "1");
    const runQuery = vi.fn();
    const runMutation = vi.fn(async (_mutation: unknown, args: Record<string, unknown>) => {
      if (isRateLimitArgs(args)) return okRate();
      return null;
    });

    const verifyArchiveRequester = vi.fn(async () => {
      throw new Error("invalid Vercel identity");
    });
    const response = await downloadZipHandler(
      { runQuery, runMutation } as unknown as ActionCtx,
      new Request("https://preview-branch-123.convex.site/api/v1/download?slug=demo", {
        headers: {
          "x-clawhub-archive-manifest": "v1",
          "x-clawhub-vercel-oidc-token": "client-forgery",
        },
      }),
      { verifyArchiveRequester },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(verifyArchiveRequester).toHaveBeenCalledWith("client-forgery", "preview");
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("records only a valid, unexpired archive metric capability", async () => {
    const keyPair = await generateKeyPair("RS256", { extractable: true });
    const privateKey = await exportPKCS8(keyPair.privateKey);
    const publicKey = await exportJWK(keyPair.publicKey);
    const jwks = JSON.stringify({ keys: [{ use: "sig", ...publicKey }] });
    vi.stubEnv("JWKS", jwks);
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    const payload: ArchiveMetricPayload = {
      schema: "clawhub.archive-download-metric.v1",
      issuer: "https://example.com",
      audience: ARCHIVE_METRIC_AUDIENCE,
      issuedAt: 1_000,
      expiresAt: 31_000,
      metric: {
        target: { kind: "skill", id: "skills:1" },
        identityKind: "ip",
        identityHash: "identity-hash",
        dayStart: 0,
        occurredAt: 1_000,
      },
    };
    const token = await signArchivePayload(payload, ARCHIVE_METRIC_JWS_TYPE, privateKey);
    const runAfter = vi.fn();
    const ctx = { scheduler: { runAfter } } as unknown as ActionCtx;

    const response = await recordArchiveDownloadMetricHandler(
      ctx,
      new Request("https://example.com/api/internal/archive-download-metric", {
        method: "POST",
        body: token,
      }),
    );
    expect(response.status).toBe(204);
    expect(runAfter).toHaveBeenCalledWith(expect.any(Number), expect.anything(), payload.metric);

    const [header, body, signature] = token.split(".");
    const modifiedBody = `${body!.slice(0, -1)}${body!.endsWith("A") ? "B" : "A"}`;
    const modifiedToken = `${header}.${modifiedBody}.${signature}`;
    const modifiedResponse = await recordArchiveDownloadMetricHandler(
      ctx,
      new Request("https://example.com/api/internal/archive-download-metric", {
        method: "POST",
        body: modifiedToken,
      }),
    );
    expect(modifiedResponse.status).toBe(401);

    const expiredToken = await signArchivePayload(
      { ...payload, expiresAt: 1_500 },
      ARCHIVE_METRIC_JWS_TYPE,
      privateKey,
    );
    const expiredResponse = await recordArchiveDownloadMetricHandler(
      ctx,
      new Request("https://example.com/api/internal/archive-download-metric", {
        method: "POST",
        body: expiredToken,
      }),
    );
    expect(expiredResponse.status).toBe(401);
    expect(runAfter).toHaveBeenCalledTimes(1);
  });

  it("streams stored file chunks and stays deterministic", async () => {
    const firstChunk = new Uint8Array(64 * 1024).fill(0x61);
    const secondChunk = new TextEncoder().encode("streamed body\n");
    const releaseSecondChunk = deferred<void>();
    const arrayBuffer = vi.fn(() => Promise.reject(new Error("whole Blob read")));
    const stream = vi.fn(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(firstChunk);
          },
          async pull(controller) {
            await releaseSecondChunk.promise;
            controller.enqueue(secondChunk);
            controller.close();
          },
        }),
    );
    const storageGetMetadata = vi.fn().mockResolvedValue({});
    const storageGet = vi.fn(async (storageId: string) => {
      if (storageId === "_storage:skill") {
        return { arrayBuffer, stream } as unknown as Blob;
      }
      if (storageId === "_storage:notes") {
        return {
          stream: () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("supporting notes\n"));
                controller.close();
              },
            }),
        } as Blob;
      }
      return null;
    });
    const runQuery = vi.fn(async (_query: unknown, args: Record<string, unknown>) => {
      if ("slug" in args) {
        return {
          skill: {
            _id: "skills:1",
            ownerUserId: "users:1",
            slug: "demo",
            tags: {},
            latestVersionId: "skillVersions:1",
          },
          moderationInfo: null,
        };
      }
      if ("versionId" in args) {
        return {
          _id: "skillVersions:1",
          skillId: "skills:1",
          version: "1.0.0",
          createdAt: 3,
          files: [
            { path: "a.txt", storageId: "_storage:skill" },
            { path: "b.txt", storageId: "_storage:notes" },
          ],
          softDeletedAt: undefined,
        };
      }
      return null;
    });
    const runMutation = vi.fn(async (_mutation: unknown, args: Record<string, unknown>) => {
      if (isRateLimitArgs(args)) return okRate();
      return null;
    });

    const response = await Promise.race([
      downloadZipHandler(
        {
          runQuery,
          runMutation,
          scheduler: { runAfter: vi.fn() },
          storage: { get: storageGet, getMetadata: storageGetMetadata },
        } as unknown as ActionCtx,
        new Request("https://example.com/api/v1/download?slug=demo"),
      ),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("download handler read archive bodies before responding")),
          1_000,
        );
      }),
    ]);

    expect(response.status).toBe(200);
    expect(storageGetMetadata).not.toHaveBeenCalled();
    expect(storageGet).toHaveBeenCalledWith("_storage:skill");
    expect(storageGet).toHaveBeenCalledWith("_storage:notes");
    expect(stream).not.toHaveBeenCalled();

    const reader = response.body!.getReader();
    const firstArchiveChunk = await reader.read();
    expect(firstArchiveChunk.done).toBe(false);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(arrayBuffer).not.toHaveBeenCalled();
    releaseSecondChunk.resolve();

    const archiveChunks = [firstArchiveChunk.value!];
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      archiveChunks.push(chunk.value);
    }
    const responseBytes = Uint8Array.from(archiveChunks.flatMap((chunk) => [...chunk]));
    const unzipped = unzipSync(responseBytes);
    expect(Object.keys(unzipped).sort()).toEqual(["_meta.json", "a.txt", "b.txt"]);
    expect(unzipped["a.txt"]).toEqual(Uint8Array.from([...firstChunk, ...secondChunk]));
    expect(new TextDecoder().decode(unzipped["b.txt"])).toBe("supporting notes\n");

    const repeatResponse = await downloadZipHandler(
      {
        runQuery,
        runMutation,
        scheduler: { runAfter: vi.fn() },
        storage: {
          get: vi.fn(async (storageId: string) => {
            if (storageId === "_storage:skill") {
              return {
                stream: () =>
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(firstChunk);
                      controller.enqueue(secondChunk);
                      controller.close();
                    },
                  }),
              } as Blob;
            }
            if (storageId === "_storage:notes") {
              return {
                stream: () =>
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(new TextEncoder().encode("supporting notes\n"));
                      controller.close();
                    },
                  }),
              } as Blob;
            }
            return null;
          }),
          getMetadata: storageGetMetadata,
        },
      } as unknown as ActionCtx,
      new Request("https://example.com/api/v1/download?slug=demo"),
    );
    expect(new Uint8Array(await repeatResponse.arrayBuffer())).toEqual(responseBytes);
  });

  it("returns 410 when a skill archive blob is missing from storage", async () => {
    const runQuery = vi.fn(async (_query: unknown, args: Record<string, unknown>) => {
      if ("slug" in args) {
        return {
          skill: {
            _id: "skills:1",
            ownerUserId: "users:1",
            slug: "demo",
            tags: {},
            latestVersionId: "skillVersions:1",
          },
          moderationInfo: null,
        };
      }
      if ("versionId" in args) {
        return {
          _id: "skillVersions:1",
          skillId: "skills:1",
          version: "1.0.0",
          createdAt: 3,
          files: [
            { path: "SKILL.md", storageId: "_storage:1" },
            { path: "missing.txt", storageId: "_storage:missing" },
          ],
          softDeletedAt: undefined,
        };
      }
      return null;
    });
    const runMutation = vi.fn(async (_mutation: unknown, args: Record<string, unknown>) => {
      if (isRateLimitArgs(args)) return okRate();
      return null;
    });
    const runAfter = vi.fn();
    const storageGet = vi.fn(async (storageId: string) =>
      storageId === "_storage:1" ? streamingBlob("hello") : null,
    );

    const response = await downloadZipHandler(
      {
        runQuery,
        runMutation,
        scheduler: { runAfter },
        storage: { get: storageGet, getMetadata: vi.fn().mockResolvedValue({}) },
      } as unknown as ActionCtx,
      new Request("https://example.com/api/v1/download?slug=demo", {
        headers: { "cf-connecting-ip": "1.2.3.4" },
      }),
    );

    expect(response.status).toBe(410);
    expect(await response.text()).toBe("Skill archive file missing from storage");
    expect(response.headers.get("Content-Type")).not.toBe("application/zip");
    expect(storageGet).toHaveBeenCalledWith("_storage:missing");
    expect(runAfter).not.toHaveBeenCalled();
  });

  it("returns 410 for an explicitly requested revoked version", async () => {
    const runQuery = vi.fn(async (_query: unknown, args: Record<string, unknown>) => {
      if ("slug" in args) {
        return {
          skill: {
            _id: "skills:1",
            ownerUserId: "users:1",
            slug: "demo",
            tags: {},
            latestVersionId: undefined,
          },
          moderationInfo: null,
        };
      }
      if ("version" in args) {
        return {
          _id: "skillVersions:1",
          skillId: "skills:1",
          version: "1.0.0",
          createdAt: 3,
          files: [{ path: "SKILL.md", storageId: "_storage:1" }],
          softDeletedAt: 123,
          manualRevocation: {
            reason: "confirmed unsafe artifact",
            reviewerUserId: "users:moderator",
            revokedAt: 123,
          },
        };
      }
      return null;
    });
    const runMutation = vi.fn(async (_mutation: unknown, args: Record<string, unknown>) => {
      if (isRateLimitArgs(args)) return okRate();
      return null;
    });
    const runAfter = vi.fn();
    const storageGet = vi.fn();

    const response = await downloadZipHandler(
      {
        runQuery,
        runMutation,
        scheduler: { runAfter },
        storage: { get: storageGet, getMetadata: vi.fn().mockResolvedValue({}) },
      } as unknown as ActionCtx,
      new Request("https://example.com/api/v1/download?slug=demo&version=1.0.0"),
    );

    expect(response.status).toBe(410);
    expect(await response.text()).toBe("Version not available");
    expect(storageGet).not.toHaveBeenCalled();
    expect(runAfter).not.toHaveBeenCalled();
  });

  it("threads owner handle through the skill lookup", async () => {
    const runQuery = vi.fn(async (_query: unknown, args: Record<string, unknown>) => {
      if ("slug" in args) {
        return {
          skill: {
            _id: "skills:1",
            ownerUserId: "users:1",
            slug: "demo",
            tags: {},
            latestVersionId: "skillVersions:1",
          },
          moderationInfo: null,
        };
      }
      if ("versionId" in args) {
        return {
          _id: "skillVersions:1",
          version: "1.0.0",
          createdAt: 3,
          files: [{ path: "SKILL.md", storageId: "_storage:1" }],
          softDeletedAt: undefined,
        };
      }
      return null;
    });
    const runMutation = vi.fn(async (_mutation: unknown, args: Record<string, unknown>) => {
      if (isRateLimitArgs(args)) return okRate();
      return null;
    });

    await downloadZipHandler(
      {
        runQuery,
        runMutation,
        scheduler: { runAfter: vi.fn() },
        storage: {
          get: vi.fn().mockResolvedValue(streamingBlob("hello")),
          getMetadata: vi.fn().mockResolvedValue({}),
        },
      } as unknown as ActionCtx,
      new Request("https://example.com/api/v1/download?slug=demo&ownerHandle=clawkit"),
    );

    const skillLookup = runQuery.mock.calls.find(([, args]) => {
      const value = args as Record<string, unknown>;
      return value.slug === "demo";
    });
    expect(skillLookup?.[1]).toEqual(
      expect.objectContaining({ slug: "demo", ownerHandle: "clawkit" }),
    );
  });

  it("does not serve a tag that points at another skill's version", async () => {
    const runQuery = vi.fn(async (_query: unknown, args: Record<string, unknown>) => {
      if ("slug" in args) {
        return {
          skill: {
            _id: "skills:1",
            ownerUserId: "users:1",
            slug: "demo",
            tags: { old: "skillVersions:other" },
            latestVersionId: "skillVersions:1",
          },
          moderationInfo: null,
        };
      }
      if (args.versionId === "skillVersions:1") {
        return {
          _id: "skillVersions:1",
          skillId: "skills:1",
          version: "1.0.0",
          createdAt: 3,
          files: [],
          softDeletedAt: undefined,
        };
      }
      if (args.versionId === "skillVersions:other") {
        return {
          _id: "skillVersions:other",
          skillId: "skills:other",
          version: "9.9.9",
          createdAt: 4,
          files: [{ path: "SKILL.md", storageId: "_storage:other" }],
          softDeletedAt: undefined,
        };
      }
      return null;
    });
    const runMutation = vi.fn(async (_mutation: unknown, args: Record<string, unknown>) => {
      if (isRateLimitArgs(args)) return okRate();
      return null;
    });
    const storageGet = vi.fn();

    const response = await downloadZipHandler(
      {
        runQuery,
        runMutation,
        scheduler: { runAfter: vi.fn() },
        storage: { get: storageGet, getMetadata: vi.fn().mockResolvedValue({}) },
      } as unknown as ActionCtx,
      new Request("https://example.com/api/v1/download?slug=demo&tag=old", {
        headers: { "cf-connecting-ip": "1.2.3.4" },
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Version not found");
    expect(storageGet).not.toHaveBeenCalled();
  });

  it("returns ownerHandle guidance when a slug-only download is ambiguous", async () => {
    const runQuery = vi.fn(async (_query: unknown, args: Record<string, unknown>) => {
      if ("slug" in args) return { skill: null, ambiguous: true };
      return null;
    });
    const runMutation = vi.fn(async (_mutation: unknown, args: Record<string, unknown>) => {
      if (isRateLimitArgs(args)) return okRate();
      return null;
    });

    const response = await downloadZipHandler(
      {
        runQuery,
        runMutation,
        scheduler: { runAfter: vi.fn() },
        storage: { get: vi.fn() },
      } as unknown as ActionCtx,
      new Request("https://example.com/api/v1/download?slug=demo"),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = await response.text();
    expect(body).toContain('Ambiguous skill slug "demo"');
    expect(body).toContain("/api/v1/download?slug=demo&ownerHandle=<owner>");
  });

  it("blocks the exact requested skill version when its ClawScan verdict is malicious", async () => {
    const runQuery = vi.fn(async (_query: unknown, args: Record<string, unknown>) => {
      if ("slug" in args) {
        return {
          skill: {
            _id: "skills:1",
            ownerUserId: "users:1",
            slug: "demo",
            tags: {},
            latestVersionId: "skillVersions:2",
          },
          moderationInfo: {
            isMalwareBlocked: false,
            isPendingScan: false,
            isHiddenByMod: false,
            isRemoved: false,
          },
        };
      }
      if ("skillId" in args && "version" in args) {
        return {
          _id: "skillVersions:1",
          skillId: "skills:1",
          version: "1.0.0",
          createdAt: 3,
          files: [{ path: "SKILL.md", storageId: "_storage:bad" }],
          softDeletedAt: undefined,
          llmAnalysis: {
            status: "completed",
            verdict: "malicious",
            checkedAt: 4,
          },
        };
      }
      if (args.versionId === "skillVersions:2") {
        return {
          _id: "skillVersions:2",
          skillId: "skills:1",
          version: "1.0.1",
          createdAt: 5,
          files: [],
          softDeletedAt: undefined,
          llmAnalysis: {
            status: "completed",
            verdict: "clean",
            checkedAt: 6,
          },
        };
      }
      return null;
    });
    const runMutation = vi.fn(async (_mutation: unknown, args: Record<string, unknown>) => {
      if (isRateLimitArgs(args)) return okRate();
      return null;
    });
    const storageGet = vi.fn();

    const response = await downloadZipHandler(
      {
        runQuery,
        runMutation,
        scheduler: { runAfter: vi.fn() },
        storage: { get: storageGet, getMetadata: vi.fn().mockResolvedValue({}) },
      } as unknown as ActionCtx,
      new Request("https://example.com/api/v1/download?slug=demo&version=1.0.0", {
        headers: { "cf-connecting-ip": "1.2.3.4" },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe(
      "Blocked: this skill version has been flagged as malicious by ClawScan and cannot be downloaded.",
    );
    expect(storageGet).not.toHaveBeenCalled();
  });

  it("uses API token user identity for zip download stats when present", async () => {
    stubZipResponse();

    const runQuery = vi.fn(async (_query: unknown, args: Record<string, unknown>) => {
      if ("tokenHash" in args) {
        return { _id: "apiTokens:1", revokedAt: undefined };
      }
      if ("tokenId" in args) {
        return { _id: "users:token", deletedAt: undefined, deactivatedAt: undefined };
      }
      if ("slug" in args) {
        return {
          skill: {
            _id: "skills:1",
            ownerUserId: "users:1",
            slug: "demo",
            tags: {},
            latestVersionId: "skillVersions:1",
          },
          moderationInfo: null,
        };
      }
      if ("versionId" in args) {
        return {
          _id: "skillVersions:1",
          skillId: "skills:1",
          version: "1.0.0",
          createdAt: 3,
          files: [{ path: "SKILL.md", storageId: "_storage:1" }],
          softDeletedAt: undefined,
        };
      }
      return null;
    });
    const runMutation = vi.fn(async (_mutation: unknown, args: Record<string, unknown>) => {
      if (isRateLimitArgs(args)) return okRate();
      if (Object.keys(args).length === 0) return "https://upload.example";
      return { tokenTouched: "tokenId" in args };
    });
    const runAfter = vi.fn();
    const storageGet = vi.fn().mockResolvedValue(streamingBlob("hello"));

    const response = await downloadZipHandler(
      {
        runQuery,
        runMutation,
        scheduler: { runAfter },
        storage: {
          get: storageGet,
          getMetadata: vi.fn().mockResolvedValue({}),
        },
      } as unknown as ActionCtx,
      new Request("https://example.com/api/v1/download?slug=demo", {
        headers: {
          authorization: "Bearer clh_test",
          "cf-connecting-ip": "1.2.3.4",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(runAfter).toHaveBeenCalledWith(
      expect.any(Number),
      expect.anything(),
      expect.objectContaining({
        target: { kind: "skill", id: "skills:1" },
        identityKind: "user",
        identityHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it("returns zip downloads when download metering is scheduled", async () => {
    vi.stubEnv("TRUST_FORWARDED_IPS", "true");
    stubZipResponse();

    const runQuery = vi.fn(async (_query: unknown, args: Record<string, unknown>) => {
      if ("slug" in args) {
        return {
          skill: {
            _id: "skills:1",
            ownerUserId: "users:1",
            slug: "demo",
            tags: {},
            latestVersionId: "skillVersions:1",
          },
          moderationInfo: null,
        };
      }
      if ("versionId" in args) {
        return {
          _id: "skillVersions:1",
          skillId: "skills:1",
          version: "1.0.0",
          createdAt: 3,
          files: [{ path: "SKILL.md", storageId: "_storage:1" }],
          softDeletedAt: undefined,
        };
      }
      return null;
    });
    const runMutation = vi.fn(async (_mutation: unknown, args: Record<string, unknown>) => {
      if (isRateLimitArgs(args)) return okRate();
      if (Object.keys(args).length === 0) return "https://upload.example";
      return { mutationRecorded: true };
    });
    const runAfter = vi.fn();
    const storageGet = vi.fn().mockResolvedValue(streamingBlob("hello"));

    const response = await downloadZipHandler(
      {
        runQuery,
        runMutation,
        scheduler: { runAfter },
        storage: {
          get: storageGet,
          getMetadata: vi.fn().mockResolvedValue({}),
        },
      } as unknown as ActionCtx,
      new Request("https://example.com/api/v1/download?slug=demo", {
        headers: { "cf-connecting-ip": "1.2.3.4" },
      }),
    );

    expect(response.status).toBe(200);
    expect(runAfter).toHaveBeenCalledWith(
      expect.any(Number),
      expect.anything(),
      expect.objectContaining({
        target: { kind: "skill", id: "skills:1" },
        identityKind: "ip",
        identityHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it.each(["clean", "suspicious"] as const)(
    "returns a metered public GitHub handoff descriptor for %s scan without scan metadata",
    async (scanStatus) => {
      vi.stubEnv("TRUST_FORWARDED_IPS", "true");
      const commit = "1".repeat(40);
      const runQuery = vi.fn(async (_query: unknown, args: Record<string, unknown>) => {
        if (isRateLimitArgs(args)) return okRate();
        if ("slug" in args) {
          return {
            skill: {
              _id: "skills:github",
              ownerUserId: "users:1",
              slug: "aiq-deploy",
              tags: {},
              latestVersionId: undefined,
              installKind: "github",
              githubPath: "skills/aiq-deploy",
              githubCurrentCommit: commit,
              githubCurrentContentHash: "hash-aiq-deploy",
              githubCurrentStatus: "present",
              githubScanStatus: scanStatus,
            },
            moderationInfo: null,
          };
        }
        if ("skillId" in args) {
          return {
            installKind: "github",
            repo: "NVIDIA/skills",
            path: "skills/aiq-deploy",
            commit,
            contentHash: "hash-aiq-deploy",
            currentStatus: "present",
            scanStatus,
            removedAt: null,
          };
        }
        return null;
      });
      const runMutation = vi.fn(async (_mutation: unknown, args: Record<string, unknown>) => {
        if (isRateLimitArgs(args)) return okRate();
        return null;
      });
      const runAfter = vi.fn();
      const storageGet = vi.fn();

      const response = await downloadZipHandler(
        {
          runQuery,
          runMutation,
          scheduler: { runAfter },
          storage: { get: storageGet },
        } as unknown as ActionCtx,
        new Request("https://example.com/api/v1/download?slug=aiq-deploy", {
          headers: { "cf-connecting-ip": "1.2.3.4" },
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(storageGet).not.toHaveBeenCalled();

      const body = await response.json();
      expect(body).toEqual({
        sourceRef: "public-github",
        repo: "NVIDIA/skills",
        commit,
        path: "skills/aiq-deploy",
        contentHash: "hash-aiq-deploy",
        archiveUrl: `https://api.github.com/repos/NVIDIA/skills/zipball/${commit}`,
      });
      expect(body).not.toHaveProperty("scan");
      expect(body).not.toHaveProperty("scanStatus");

      expect(runAfter).toHaveBeenCalledWith(
        expect.any(Number),
        expect.anything(),
        expect.objectContaining({
          target: { kind: "skill", id: "skills:github" },
          identityKind: "ip",
          identityHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      );
    },
  );

  it.each([
    {
      name: "pending scan",
      skill: { githubCurrentStatus: "present", githubScanStatus: "pending" },
      source: { repo: "NVIDIA/skills" },
      status: 423,
      message: "GitHub-backed skill security scan is in progress.",
    },
    {
      name: "failed scan",
      skill: { githubCurrentStatus: "present", githubScanStatus: "failed" },
      source: { repo: "NVIDIA/skills" },
      status: 403,
      message: "GitHub-backed skill failed ClawHub security scanning.",
    },
    {
      name: "malicious scan",
      skill: { githubCurrentStatus: "present", githubScanStatus: "malicious" },
      source: { repo: "NVIDIA/skills" },
      status: 403,
      message: "GitHub-backed skill failed ClawHub security scanning.",
    },
    {
      name: "missing upstream path",
      skill: { githubCurrentStatus: "missing", githubScanStatus: "clean" },
      source: { repo: "NVIDIA/skills" },
      status: 410,
      message: "GitHub-backed skill path is missing upstream.",
    },
    {
      name: "removed upstream path",
      skill: { githubCurrentStatus: "present", githubRemovedAt: 123, githubScanStatus: "clean" },
      source: { repo: "NVIDIA/skills" },
      status: 410,
      message: "GitHub-backed skill has been removed upstream.",
    },
    {
      name: "unknown upstream freshness",
      skill: { githubCurrentStatus: "unknown", githubScanStatus: "clean" },
      source: { repo: "NVIDIA/skills" },
      status: 423,
      message: "GitHub-backed skill needs an upstream freshness check before download.",
    },
    {
      name: "incomplete source",
      skill: { githubCurrentStatus: "present", githubScanStatus: "clean" },
      source: null,
      status: 409,
      message: "GitHub-backed skill source metadata is incomplete.",
    },
  ])(
    "blocks $name GitHub handoffs without scheduling metrics",
    async ({ skill, source, status, message }) => {
      const runQuery = vi.fn(async (_query: unknown, args: Record<string, unknown>) => {
        if (isRateLimitArgs(args)) return okRate();
        if ("slug" in args) {
          return {
            skill: {
              _id: "skills:github",
              ownerUserId: "users:1",
              slug: "aiq-deploy",
              tags: {},
              latestVersionId: undefined,
              installKind: "github",
              githubPath: "skills/aiq-deploy",
              githubCurrentCommit: "1".repeat(40),
              githubCurrentContentHash: "hash-aiq-deploy",
              ...skill,
            },
            moderationInfo: null,
          };
        }
        if ("skillId" in args) {
          if (!source) return null;
          return {
            installKind: "github",
            repo: source.repo,
            path: "skills/aiq-deploy",
            commit: "1".repeat(40),
            contentHash: "hash-aiq-deploy",
            currentStatus: "present",
            scanStatus: "clean",
            removedAt: null,
            ...skill,
            ...(skill.githubCurrentStatus ? { currentStatus: skill.githubCurrentStatus } : {}),
            ...(skill.githubScanStatus ? { scanStatus: skill.githubScanStatus } : {}),
            ...(skill.githubRemovedAt ? { removedAt: skill.githubRemovedAt } : {}),
          };
        }
        return null;
      });
      const runMutation = vi.fn(async (_mutation: unknown, args: Record<string, unknown>) => {
        if (isRateLimitArgs(args)) return okRate();
        return null;
      });
      const runAfter = vi.fn();

      const response = await downloadZipHandler(
        {
          runQuery,
          runMutation,
          scheduler: { runAfter },
          storage: { get: vi.fn() },
        } as unknown as ActionCtx,
        new Request("https://example.com/api/v1/download?slug=aiq-deploy", {
          headers: { "cf-connecting-ip": "1.2.3.4" },
        }),
      );

      expect(response.status).toBe(status);
      expect(await response.text()).toBe(message);
      expect(runAfter).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "hidden by moderators",
      moderationInfo: {
        isPendingScan: false,
        isMalwareBlocked: false,
        isHiddenByMod: true,
        isRemoved: false,
      },
      status: 403,
      message: "This skill is currently unavailable.",
    },
    {
      name: "removed by moderators",
      moderationInfo: {
        isPendingScan: false,
        isMalwareBlocked: false,
        isHiddenByMod: false,
        isRemoved: true,
      },
      status: 410,
      message: "This skill has been removed by a moderator.",
    },
  ])(
    "blocks $name GitHub handoffs before source descriptor creation",
    async ({ moderationInfo, status, message }) => {
      const runQuery = vi.fn(async (_query: unknown, args: Record<string, unknown>) => {
        if (isRateLimitArgs(args)) return okRate();
        if ("slug" in args) {
          return {
            skill: {
              _id: "skills:github",
              ownerUserId: "users:1",
              slug: "aiq-deploy",
              tags: {},
              latestVersionId: undefined,
              installKind: "github",
              githubPath: "skills/aiq-deploy",
              githubCurrentCommit: "1".repeat(40),
              githubCurrentContentHash: "hash-aiq-deploy",
              githubCurrentStatus: "present",
              githubScanStatus: "clean",
            },
            moderationInfo,
          };
        }
        if ("skillId" in args) {
          return {
            installKind: "github",
            repo: "NVIDIA/skills",
            path: "skills/aiq-deploy",
            commit: "1".repeat(40),
            contentHash: "hash-aiq-deploy",
            currentStatus: "present",
            scanStatus: "clean",
            removedAt: null,
          };
        }
        return null;
      });
      const runMutation = vi.fn(async (_mutation: unknown, args: Record<string, unknown>) => {
        if (isRateLimitArgs(args)) return okRate();
        return null;
      });
      const runAfter = vi.fn();

      const response = await downloadZipHandler(
        {
          runQuery,
          runMutation,
          scheduler: { runAfter },
          storage: { get: vi.fn() },
        } as unknown as ActionCtx,
        new Request("https://example.com/api/v1/download?slug=aiq-deploy", {
          headers: { "cf-connecting-ip": "1.2.3.4" },
        }),
      );

      expect(response.status).toBe(status);
      expect(await response.text()).toBe(message);
      expect(runQuery).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ skillId: "skills:github" }),
      );
      expect(runAfter).not.toHaveBeenCalled();
    },
  );
});
