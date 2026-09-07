import { afterEach, describe, expect, it, vi } from "vitest";
import { __test } from "./changelog";

describe("changelog utils", () => {
  it("summarizes file diffs", () => {
    const diff = __test.summarizeFileDiff(
      [
        { path: "a.txt", sha256: "aaa" },
        { path: "b.txt", sha256: "bbb" },
      ],
      [
        { path: "a.txt", sha256: "aaa" },
        { path: "b.txt", sha256: "ccc" },
        { path: "c.txt", sha256: "ddd" },
      ],
    );

    expect(diff.added).toEqual(["c.txt"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual(["b.txt"]);
    expect(__test.formatDiffSummary(diff)).toBe("1 added, 1 changed");
  });

  it("generates a fallback initial release note", () => {
    const text = __test.generateFallback({
      slug: "demo",
      version: "1.0.0",
      oldReadme: null,
      nextReadme: "hi",
      fileDiff: null,
    });
    expect(text).toMatch(/Initial release/i);
  });

  it("generates a package-specific fallback update note", () => {
    const text = __test.generatePackageFallback({
      name: "demo-plugin",
      version: "1.2.0",
      oldReadme: "old",
      nextReadme: "new",
      fileDiff: { added: ["src/index.ts"], changed: [], removed: [] },
    });
    expect(text).toContain("Updated README and package contents");
    expect(text).not.toContain("SKILL.md");
  });

  describe("OpenAI changelog fetch deadline", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      delete process.env.OPENAI_API_KEY;
    });

    it("passes an abort signal with the changelog timeout", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      let seenSignal: AbortSignal | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          seenSignal = init?.signal ?? undefined;
          return new Response(
            JSON.stringify({
              output: [{ type: "message", content: [{ type: "output_text", text: "- Updated." }] }],
            }),
            { status: 200 },
          );
        }),
      );

      const text = await __test.generateWithOpenAI({
        slug: "demo",
        version: "1.0.1",
        oldReadme: "old",
        nextReadme: "new",
        fileDiff: null,
      });

      expect(text).toBe("- Updated.");
      expect(seenSignal).toBeInstanceOf(AbortSignal);
      expect(fetch).toHaveBeenCalledWith(
        "https://api.openai.com/v1/responses",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("aborts a hung OpenAI changelog fetch instead of waiting forever", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);
        return controller.signal;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, init?: RequestInit) => {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
            });
          });
        }),
      );

      const started = Date.now();
      await expect(
        __test.generateWithOpenAI({
          slug: "demo",
          version: "1.0.1",
          oldReadme: "old",
          nextReadme: "new",
          fileDiff: null,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(Date.now() - started).toBeLessThan(1000);
      expect(timeoutSpy).toHaveBeenCalledWith(__test.CHANGELOG_TIMEOUT_MS);
    });
  });
});
