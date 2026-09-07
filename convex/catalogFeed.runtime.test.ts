/// <reference types="vite/client" />
/* @vitest-environment edge-runtime */
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import { sha256Hex } from "./lib/clawpack";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const digest = `sha256:${"a".repeat(64)}`;

describe("experimental Claw feed runtime", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stores and serves the exact publication only while the gate is enabled", async () => {
    vi.stubEnv("CLAWHUB_EXPERIMENTAL_CLAWS", "1");
    const t = convexTest(schema, modules);
    registerRateLimiter(t);
    const stored = await t.mutation(internal.catalogFeed.storeClawPublication, {
      generatedAt: "2026-07-24T00:00:00.000Z",
      expiresAt: "2026-07-25T00:00:00.000Z",
      entries: [
        {
          type: "claw",
          id: "@openclaw/runtime-proof",
          title: "Runtime proof",
          version: "1.0.0",
          state: "available",
          publisher: { id: "openclaw", trust: "official" },
          clawManifestSummary: {
            schemaVersion: 1,
            agent: { id: "runtime-proof", name: "Runtime proof" },
            workspace: { bootstrapFiles: ["SOUL.md"], fileCount: 1 },
            packages: { skillCount: 0, pluginCount: 0 },
            mcpServerCount: 0,
            cronJobCount: 0,
          },
          install: {
            candidates: [
              {
                sourceRef: "public-clawhub",
                package: "@openclaw/runtime-proof",
                version: "1.0.0",
                integrity: digest,
              },
            ],
          },
        },
      ],
    });
    expect(stored).toMatchObject({
      feedId: "clawhub-official-claws",
      sequence: 1,
      entryCount: 1,
    });

    const publication = await t.query(internal.catalogFeed.getLatestPublication, {
      feedId: "clawhub-official-claws",
    });
    expect(publication?.payload).toContain('"id":"@openclaw/runtime-proof"');

    const enabled = await t.fetch("/api/v1/feeds/claws");
    expect(enabled.status).toBe(200);
    expect(enabled.headers.get("cache-control")).toBe("no-store");
    expect(enabled.headers.get("surrogate-control")).toBeNull();
    expect(await enabled.text()).toBe(publication?.payload);

    vi.stubEnv("CLAWHUB_EXPERIMENTAL_CLAWS", "0");
    const disabled = await t.fetch("/api/v1/feeds/claws");
    expect(disabled.status).toBe(404);
    expect(disabled.headers.get("cache-control")).toBe("no-store");
  });
});

describe("provider catalog feed runtime", () => {
  it("stores and serves provider setup metadata beside the exact release pin", async () => {
    const t = convexTest(schema, modules);
    registerRateLimiter(t);
    const openclaw = {
      plugin: { id: "demo-provider", label: "Demo Provider" },
      providers: [
        {
          id: "demo",
          envVars: ["DEMO_API_KEY"],
          authChoices: [
            {
              method: "api-key",
              choiceId: "demo-api-key",
              choiceLabel: "Demo API key",
              appGuidedSecret: true,
            },
          ],
        },
      ],
      modelCatalog: {
        providers: { demo: { defaultModel: "latest", models: [{ id: "latest", name: "Latest" }] } },
      },
    };
    const candidate = {
      sourceRef: "public-clawhub",
      package: "@openclaw/demo-provider",
      version: "1.2.3",
      integrity: digest,
    };
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        id: openclaw.plugin.id,
        name: openclaw.plugin.label,
        providers: ["demo"],
        setup: { providers: [{ id: "demo", envVars: ["DEMO_API_KEY"] }] },
        providerAuthChoices: openclaw.providers[0].authChoices.map((choice) => ({
          provider: "demo",
          ...choice,
        })),
        modelCatalog: openclaw.modelCatalog,
      }),
    );
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob([bytes])));
    const file = {
      path: "openclaw.plugin.json",
      storageId,
      size: bytes.byteLength,
      sha256: await sha256Hex(bytes),
    };
    const releaseId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const ownerPublisherId = await ctx.db.insert("publishers", {
        kind: "org",
        handle: "openclaw",
        displayName: "OpenClaw",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("officialPublishers", {
        publisherId: ownerPublisherId,
        createdAt: 1,
        updatedAt: 1,
      });
      const packageId = await ctx.db.insert("packages", {
        name: candidate.package,
        normalizedName: candidate.package,
        displayName: "Demo Provider",
        ownerUserId: userId,
        ownerPublisherId,
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        tags: {},
        scanStatus: "clean",
        stats: { downloads: 0, installs: 0, stars: 0, versions: 1 },
        createdAt: 1,
        updatedAt: 1,
      });
      const id = await ctx.db.insert("packageReleases", {
        packageId,
        version: candidate.version,
        changelog: "",
        distTags: [],
        files: [file],
        integritySha256: "a".repeat(64),
        sha256hash: "a".repeat(64),
        runtimeId: openclaw.plugin.id,
        verification: { tier: "structural", scope: "artifact-only", scanStatus: "clean" },
        createdBy: userId,
        publishActor: { kind: "user", userId },
        createdAt: 1,
      });
      await ctx.db.patch(packageId, { latestReleaseId: id });
      return id;
    });
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    await t.action(internal.catalogFeed.publish, { expiresAt });
    const publication = await t.query(internal.catalogFeed.getLatestPublication, {
      feedId: "clawhub-official",
    });
    const response = await t.fetch("/api/v1/feeds/plugins");
    const payload = await response.text();

    expect(response.status).toBe(200);
    expect(payload).toBe(publication?.payload);
    expect(JSON.parse(payload).entries[0]).toMatchObject({
      openclaw,
      install: { candidates: [candidate] },
    });
    expect(response.headers.get("etag")).toBe(`"sha256:${publication?.payloadSha256}"`);
    expect(payload).not.toContain(storageId);

    await t.run((ctx) => ctx.db.patch(releaseId, { files: [{ ...file, sha256: "0".repeat(64) }] }));
    await expect(t.action(internal.catalogFeed.publish, { expiresAt })).rejects.toThrow(
      "Catalog manifest digest mismatch",
    );
    expect(
      await t.query(internal.catalogFeed.getLatestPublication, { feedId: "clawhub-official" }),
    ).toEqual(publication);

    await expect(
      t.mutation(internal.catalogFeed.storePublication, {
        feedId: "clawhub-official",
        description: "x".repeat(900 * 1024),
        generatedAt: new Date().toISOString(),
        expiresAt,
        entries: [
          {
            type: "plugin",
            id: candidate.package,
            title: "Demo Provider",
            version: candidate.version,
            state: "available",
            publisher: { id: "openclaw", trust: "official" },
            install: { candidates: [candidate] },
            openclaw,
          },
        ],
      }),
    ).rejects.toThrow("payload");
    expect(
      await t.query(internal.catalogFeed.getLatestPublication, { feedId: "clawhub-official" }),
    ).toEqual(publication);
  });
});
