import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_SKILLS_DISCOVERY_TIMEOUT_MS,
  fetchAgentSkillsDiscovery,
  proxyAgentSkillsDiscoveryResponse,
} from "../routes/$owner/skills/$slug/[.]well-known/agent-skills/index[.]json";

process.env.VITE_CONVEX_URL = process.env.VITE_CONVEX_URL ?? "https://example.convex.cloud";

describe("Agent Skills discovery route", () => {
  it("does not forward stale compression or transport headers", async () => {
    const upstream = new Response('{"skills":[]}', {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=60",
        Connection: "keep-alive",
        "Content-Encoding": "gzip",
        "Content-Length": "123",
        "Content-Type": "application/json; charset=utf-8",
      },
    });

    const response = await proxyAgentSkillsDiscoveryResponse(upstream);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"skills":[]}');
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Connection")).toBeNull();
    expect(response.headers.get("Content-Encoding")).toBeNull();
    expect(response.headers.get("Content-Length")).toBeNull();
  });

  it("returns the discovery headers without a body for HEAD requests", async () => {
    const upstream = new Response('{"skills":[]}', {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=60",
        "Content-Type": "application/json; charset=utf-8",
      },
    });

    const response = await proxyAgentSkillsDiscoveryResponse(upstream, false);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  });

  describe("upstream discovery fetch deadline", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it("passes an abort signal on GET and HEAD upstream fetches", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
        return new AbortController().signal;
      });
      const fetchMock = vi.fn(async () => {
        return new Response('{"skills":[]}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      await fetchAgentSkillsDiscovery("openclaw", "demo", "GET");
      await fetchAgentSkillsDiscovery("openclaw", "demo", "HEAD");

      expect(timeoutSpy).toHaveBeenCalledWith(AGENT_SKILLS_DISCOVERY_TIMEOUT_MS);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        expect.any(URL),
        expect.objectContaining({
          method: "GET",
          headers: { Accept: "application/json" },
          signal: expect.any(AbortSignal),
        }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        expect.any(URL),
        expect.objectContaining({
          method: "HEAD",
          headers: { Accept: "application/json" },
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("aborts a hanging upstream fetch after the discovery timeout", async () => {
      vi.useFakeTimers();
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
        const controller = new AbortController();
        setTimeout(() => {
          controller.abort(
            Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
          );
        }, ms);
        return controller.signal;
      });
      let usedSignal: AbortSignal | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: URL, init?: RequestInit) => {
          usedSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
            });
          });
        }),
      );

      const pending = fetchAgentSkillsDiscovery("openclaw", "demo", "GET");
      const aborted = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await Promise.resolve();
      expect(usedSignal).toBeInstanceOf(AbortSignal);
      expect(usedSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(AGENT_SKILLS_DISCOVERY_TIMEOUT_MS - 1);
      expect(usedSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await aborted;
      expect(usedSignal?.aborted).toBe(true);
      expect(timeoutSpy).toHaveBeenCalledWith(AGENT_SKILLS_DISCOVERY_TIMEOUT_MS);
    });
  });
});
