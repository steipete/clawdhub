/* @vitest-environment node */
import { describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import {
  formatUserFacingErrorMessage,
  parseMultipartPublish,
  parseMultipartSkillScan,
  resolveTagsBatch,
  softDeleteErrorToResponse,
} from "./httpApiV1/shared";
import { MAX_PUBLISH_FILE_BYTES } from "./lib/publishLimits";

function makeCtx() {
  return {
    runQuery: vi.fn(),
  } as unknown as ActionCtx & { runQuery: ReturnType<typeof vi.fn> };
}

describe("http API v1 shared helpers", () => {
  it("removes Convex transport wrappers from user-facing errors", () => {
    expect(
      formatUserFacingErrorMessage(
        new Error(
          "[CONVEX A] [Request ID: abc] Server Error Called by client Uncaught ConvexError: Bad publish payload",
        ),
        "Request failed",
      ),
    ).toBe("Bad publish payload");
    expect(
      formatUserFacingErrorMessage(
        new Error("Uncaught ConvexError: Uncaught ConvexError: Publisher not found"),
        "Request failed",
      ),
    ).toBe("Publisher not found");
  });

  it("maps soft-delete validation failures to 400 with cleaned messages", async () => {
    const response = softDeleteErrorToResponse(
      "package",
      new Error(
        "[CONVEX M] [Request ID: abc] Server Error Called by client Uncaught ConvexError: Package name must be lowercase and npm-safe (example: @scope/name or plugin-name)",
      ),
      {},
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe(
      "Package name must be lowercase and npm-safe (example: @scope/name or plugin-name)",
    );
  });

  it("maps reserved package route validation failures to 400 with cleaned messages", async () => {
    const response = softDeleteErrorToResponse(
      "package",
      new Error(
        '[CONVEX M] [Request ID: abc] Server Error Called by client Uncaught ConvexError: Package name "publish" is reserved for ClawHub routes. Use a scoped name or choose a different package name.',
      ),
      {},
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe(
      'Package name "publish" is reserved for ClawHub routes. Use a scoped name or choose a different package name.',
    );
  });

  it("keeps unknown soft-delete failures generic 500s", async () => {
    const response = softDeleteErrorToResponse("skill", new Error("boom"), {});

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("Internal Server Error");
  });

  it("keeps unrelated reserved-word failures generic 500s", async () => {
    const response = softDeleteErrorToResponse(
      "package",
      new Error("database reserved capacity exceeded"),
      {},
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("Internal Server Error");
  });

  it("resolves latest tags without reading version documents", async () => {
    const ctx = makeCtx();
    const versionId = "skillVersions:latest" as Id<"skillVersions">;
    const skillId = "skills:demo" as Id<"skills">;

    const result = await resolveTagsBatch(
      ctx,
      [{ latest: versionId }],
      [{ _id: versionId, skillId, version: "2.0.0" }],
      [skillId],
    );

    expect(result).toEqual([{ latest: "2.0.0" }]);
    expect(ctx.runQuery).not.toHaveBeenCalled();
  });

  it("only fetches tag versions that cannot be resolved from latest", async () => {
    const ctx = makeCtx();
    const latestId = "skillVersions:latest" as Id<"skillVersions">;
    const stableId = "skillVersions:stable" as Id<"skillVersions">;
    const skillId = "skills:demo" as Id<"skills">;
    ctx.runQuery.mockResolvedValueOnce([{ _id: stableId, skillId, version: "1.5.0" }]);

    const result = await resolveTagsBatch(
      ctx,
      [{ latest: latestId, stable: stableId }],
      [{ _id: latestId, skillId, version: "2.0.0" }],
      [skillId],
    );

    expect(ctx.runQuery).toHaveBeenCalledWith(internal.skills.getVersionsByIdsInternal, {
      versionIds: [stableId],
    });
    expect(result).toEqual([{ latest: "2.0.0", stable: "1.5.0" }]);
  });

  it("filters resolved skill tags by owning skill", async () => {
    const ctx = makeCtx();
    const otherId = "skillVersions:other" as Id<"skillVersions">;
    const stableId = "skillVersions:stable" as Id<"skillVersions">;
    const skillId = "skills:1" as Id<"skills">;
    ctx.runQuery.mockResolvedValueOnce([
      { _id: otherId, skillId: "skills:other", version: "9.9.9" },
      { _id: stableId, skillId, version: "1.5.0" },
    ]);

    const result = await resolveTagsBatch(
      ctx,
      [{ latest: otherId, stable: stableId }],
      [{ _id: otherId, skillId: "skills:other" as Id<"skills">, version: "9.9.9" }],
      [skillId],
    );

    expect(result).toEqual([{ stable: "1.5.0" }]);
  });

  it("validates skill scan multipart payloads before storing uploaded files", async () => {
    const form = new FormData();
    form.set("payload", JSON.stringify({ source: { kind: "upload" }, update: true }));
    form.append("files", new Blob(["# Demo"], { type: "text/markdown" }), "SKILL.md");
    const request = new Request("https://clawhub.ai/api/v1/skills/-/scan", {
      method: "POST",
      body: form,
    });
    const store = vi.fn();
    const ctx = {
      storage: {
        store,
        delete: vi.fn(),
      },
    } as unknown as ActionCtx;

    await expect(
      parseMultipartSkillScan(ctx, request, () => {
        throw new Error("update is not valid for uploaded scans");
      }),
    ).rejects.toThrow("update is not valid for uploaded scans");
    expect(store).not.toHaveBeenCalled();
  });

  it("deletes stored publish blobs when the payload fails after upload", async () => {
    const form = new FormData();
    form.set(
      "payload",
      JSON.stringify({
        displayName: "Demo",
        version: "1.0.0",
        changelog: "",
        tags: ["latest"],
      }),
    );
    form.append("files", new Blob(["# Demo"], { type: "text/markdown" }), "SKILL.md");
    const request = new Request("https://clawhub.ai/api/v1/skills", {
      method: "POST",
      body: form,
    });
    const store = vi.fn().mockResolvedValue("storage:1");
    const remove = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      storage: {
        store,
        delete: remove,
      },
    } as unknown as ActionCtx;

    await expect(parseMultipartPublish(ctx, request)).rejects.toThrow(/slug/i);
    expect(store).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("storage:1");
  });

  it("does not store publish files when a later part exceeds the size limit", async () => {
    const form = new FormData();
    form.set(
      "payload",
      JSON.stringify({
        slug: "demo",
        displayName: "Demo",
        version: "1.0.0",
        changelog: "",
        acceptLicenseTerms: true,
        tags: ["latest"],
      }),
    );
    form.append("files", new Blob(["# Demo"], { type: "text/markdown" }), "SKILL.md");
    form.append(
      "files",
      new File([new Uint8Array(MAX_PUBLISH_FILE_BYTES + 1)], "big.bin", {
        type: "application/octet-stream",
      }),
    );
    const request = new Request("https://clawhub.ai/api/v1/skills", {
      method: "POST",
      body: form,
    });
    const store = vi.fn().mockResolvedValue("storage:1");
    const remove = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      storage: {
        store,
        delete: remove,
      },
    } as unknown as ActionCtx;

    await expect(parseMultipartPublish(ctx, request)).rejects.toThrow(
      'File "big.bin" exceeds 10MB limit',
    );
    expect(store).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
