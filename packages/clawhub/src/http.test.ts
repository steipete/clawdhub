/* @vitest-environment node */

import { describe, expect, it, vi } from "vitest";
import {
  createHttpClient,
  detectHttpRuntime,
  getHttpErrorStatus,
  isRetryableHttpError,
  registryUrl,
  shouldUseProxyFromEnv,
} from "./http.js";
import { ApiV1WhoamiResponseSchema } from "./schema/index.js";

function createNodeClient(options?: {
  fetchImpl?: typeof fetch;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  now?: () => number;
}) {
  return createHttpClient({
    runtime: "node",
    configureDispatcher: false,
    fetchImpl: options?.fetchImpl,
    setTimeoutImpl: options?.setTimeoutImpl,
    clearTimeoutImpl: options?.clearTimeoutImpl,
    now: options?.now,
    random: () => 0,
  });
}

function createImmediateTimeouts() {
  const setTimeoutImpl = vi.fn((callback: () => void, _ms?: number) => {
    callback();
    return 1 as unknown as ReturnType<typeof setTimeout>;
  });
  const clearTimeoutImpl = vi.fn();
  return { setTimeoutImpl, clearTimeoutImpl };
}

function createAbortingFetchMock() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    if (!(signal instanceof AbortSignal)) {
      throw new Error("Missing abort signal");
    }
    if (signal.aborted) {
      throw signal.reason;
    }
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          reject(signal.reason);
        },
        { once: true },
      );
    });
  });
}

function createStalledBodyFetch(options?: {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
}) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    const hang = () =>
      new Promise<never>((_resolve, reject) => {
        if (!(signal instanceof AbortSignal)) return;
        const abort = () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
      });
    const headers = new Headers(options?.headers);
    return {
      ok: options?.ok ?? true,
      status: options?.status ?? 200,
      headers,
      json: hang,
      text: hang,
      arrayBuffer: hang,
    };
  });
}

describe("detectHttpRuntime", () => {
  it("detects bun and node runtimes explicitly", () => {
    expect(detectHttpRuntime({ bun: "1.2.3" } as unknown as NodeJS.ProcessVersions)).toBe("bun");
    expect(detectHttpRuntime({ node: "22.0.0" } as unknown as NodeJS.ProcessVersions)).toBe("node");
  });
});

describe("shouldUseProxyFromEnv", () => {
  it("detects standard proxy variables", () => {
    expect(
      shouldUseProxyFromEnv({
        HTTPS_PROXY: "http://proxy.example:3128",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      shouldUseProxyFromEnv({
        HTTP_PROXY: "http://proxy.example:3128",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      shouldUseProxyFromEnv({
        https_proxy: "http://proxy.example:3128",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("ignores NO_PROXY-only configs", () => {
    expect(
      shouldUseProxyFromEnv({
        NO_PROXY: "localhost,127.0.0.1",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(shouldUseProxyFromEnv({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("registryUrl", () => {
  it("preserves registry base paths and normalizes slashes", () => {
    expect(registryUrl("/api/v1/skills", "https://clawhub.ai").toString()).toBe(
      "https://clawhub.ai/api/v1/skills",
    );
    expect(registryUrl("/api/v1/skills", "http://localhost:8081/custom/path").toString()).toBe(
      "http://localhost:8081/custom/path/api/v1/skills",
    );
    expect(registryUrl("api/v1/skills", "http://localhost:8081/custom/path/").toString()).toBe(
      "http://localhost:8081/custom/path/api/v1/skills",
    );
  });
});

describe("node http client", () => {
  it("adds bearer token and parses json", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { handle: null } }),
    });
    const client = createNodeClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.apiRequest(
      "https://example.com",
      { method: "GET", path: "/x", token: "clh_token" },
      ApiV1WhoamiResponseSchema,
    );

    expect(result.user.handle).toBeNull();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer clh_token");
  });

  it("posts json body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    const client = createNodeClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.apiRequest("https://example.com", {
      method: "POST",
      path: "/x",
      body: { a: 1 },
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/x");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("parses explicitly accepted non-2xx json responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        ok: false,
        message: "GitHub-backed skill changed upstream; waiting for scan.",
      }),
    });
    const client = createNodeClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      client.apiRequest("https://example.com", {
        method: "GET",
        path: "/api/v1/skills/demo/install",
        acceptedStatuses: [409],
      }),
    ).resolves.toEqual({
      ok: false,
      message: "GitHub-backed skill changed upstream; waiting for scan.",
    });
  });

  it("includes rate-limit guidance from response headers on 429", async () => {
    const { setTimeoutImpl, clearTimeoutImpl } = createImmediateTimeouts();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({
        "Retry-After": "34",
        "X-RateLimit-Limit": "20",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": "1771404540",
      }),
      text: async () => "Rate limit exceeded",
    });
    const client = createNodeClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      setTimeoutImpl: setTimeoutImpl as unknown as typeof setTimeout,
      clearTimeoutImpl,
    });

    await expect(
      client.apiRequest("https://example.com", { method: "GET", path: "/x" }),
    ).rejects.toThrow(/retry in 34s.*remaining: 0\/20.*reset in 34s/i);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(clearTimeoutImpl).toHaveBeenCalledTimes(3);
  });

  it("formats ambiguous skill slug errors with install choices", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      headers: new Headers({ "Content-Type": "application/json" }),
      text: async () =>
        JSON.stringify({
          code: "AMBIGUOUS_SKILL_SLUG",
          message:
            'Found multiple skills with the slug "discrawl"; specify which one you want to install:',
          slug: "discrawl",
          matches: [
            {
              ownerHandle: "openclaw",
              slug: "discrawl",
              ref: "@openclaw/discrawl",
              url: "https://clawhub.ai/openclaw/skills/discrawl",
            },
            {
              ownerHandle: "patrick",
              slug: "discrawl",
              ref: "@patrick/discrawl",
              url: "https://clawhub.ai/patrick/skills/discrawl",
            },
          ],
        }),
    });
    const client = createNodeClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      client.apiRequest("https://clawhub.ai", { method: "GET", path: "/api/v1/skills/discrawl" }),
    ).rejects.toThrow(
      [
        'Found multiple skills with the slug "discrawl"; specify which one you want to install:',
        "",
        "  1.",
        "     Skill: openclaw/discrawl",
        "     Page:  https://clawhub.ai/openclaw/skills/discrawl",
        "     Run:   clawhub install @openclaw/discrawl",
        "",
        "  2.",
        "     Skill: patrick/discrawl",
        "     Page:  https://clawhub.ai/patrick/skills/discrawl",
        "     Run:   clawhub install @patrick/discrawl",
      ].join("\n"),
    );
  });

  it("interprets legacy epoch Retry-After values as reset delays", async () => {
    const { setTimeoutImpl, clearTimeoutImpl } = createImmediateTimeouts();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({
        "Retry-After": "1771404540",
        "X-RateLimit-Limit": "20",
        "X-RateLimit-Remaining": "0",
      }),
      text: async () => "Rate limit exceeded",
    });
    const client = createNodeClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      setTimeoutImpl: setTimeoutImpl as unknown as typeof setTimeout,
      clearTimeoutImpl,
      now: () => 1_771_404_500_000,
    });

    await expect(
      client.apiRequest("https://example.com", { method: "GET", path: "/x" }),
    ).rejects.toThrow(/retry in 40s.*remaining: 0\/20/i);
  });

  it("falls back to HTTP status when response bodies are empty", async () => {
    const { setTimeoutImpl, clearTimeoutImpl } = createImmediateTimeouts();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "",
    });
    const client = createNodeClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      setTimeoutImpl: setTimeoutImpl as unknown as typeof setTimeout,
      clearTimeoutImpl,
    });

    await expect(
      client.apiRequest("https://example.com", { method: "GET", url: "https://example.com/x" }),
    ).rejects.toThrow("HTTP 500");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries and labels transient Convex write contention", async () => {
    const contention =
      'Documents read from or written to the "publishers" table changed while this mutation was being run';
    const { setTimeoutImpl, clearTimeoutImpl } = createImmediateTimeouts();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => contention,
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => contention,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      });
    const client = createNodeClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      setTimeoutImpl: setTimeoutImpl as unknown as typeof setTimeout,
      clearTimeoutImpl,
    });

    await expect(
      client.apiRequestForm("https://example.com", {
        method: "POST",
        path: "/upload",
        form: new FormData(),
        retryCount: 5,
      }),
    ).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const failingFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => contention,
    });
    const failingClient = createNodeClient({
      fetchImpl: failingFetch as unknown as typeof fetch,
      setTimeoutImpl: setTimeoutImpl as unknown as typeof setTimeout,
      clearTimeoutImpl,
    });
    await expect(
      failingClient.apiRequestForm("https://example.com", {
        method: "POST",
        path: "/upload",
        form: new FormData(),
        retryCount: 0,
      }),
    ).rejects.toThrow(/Transient ClawHub write contention.*package artifact passed/i);
  });

  it("expands generic auth and visibility failures into actionable messages", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers(),
        text: async () => "Unauthorized",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers(),
        text: async () => "Forbidden",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers(),
        text: async () => "Package not found",
      });
    const client = createNodeClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      client.apiRequest("https://example.com", { method: "GET", path: "/auth" }),
    ).rejects.toThrow(/clawhub login.*deleted, banned, or disabled/i);
    await expect(
      client.apiRequest("https://example.com", { method: "GET", path: "/forbidden" }),
    ).rejects.toThrow(/account does not have access.*not in good standing/i);
    await expect(
      client.apiRequest("https://example.com", { method: "GET", path: "/missing" }),
    ).rejects.toThrow(/Package not found or not visible to this account/i);
  });

  it("preserves HTTP status and classifies transient request failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => "Unauthorized",
    });
    const client = createNodeClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const error = await client
      .apiRequest("https://example.com", {
        method: "GET",
        path: "/auth",
        retryCount: 0,
      })
      .catch((caught: unknown) => caught);

    expect(getHttpErrorStatus(error)).toBe(401);
    expect(isRetryableHttpError(error)).toBe(false);
    expect(isRetryableHttpError(Object.assign(new Error("busy"), { status: 408 }))).toBe(true);
    expect(isRetryableHttpError(Object.assign(new Error("busy"), { status: 429 }))).toBe(true);
    expect(isRetryableHttpError(Object.assign(new Error("down"), { status: 503 }))).toBe(true);
    expect(isRetryableHttpError(new TypeError("fetch failed"))).toBe(true);
  });

  it("strips Convex transport wrappers from HTTP error bodies", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
      text: async () =>
        "[CONVEX A] [Request ID: abc] Server Error Called by client Uncaught ConvexError: Missing runtime",
    });
    const client = createNodeClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      client.apiRequest("https://example.com", { method: "POST", path: "/publish" }),
    ).rejects.toThrow("Missing runtime");
    await expect(
      client.apiRequest("https://example.com", { method: "POST", path: "/publish" }),
    ).rejects.not.toThrow(/ConvexError|Request ID|Server Error/i);
  });

  it("downloads zip bytes and does not retry non-retryable errors", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "nope",
      });
    const client = createNodeClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const bytes = await client.downloadZip("https://example.com", {
      slug: "demo",
      version: "1.0.0",
      token: "clh_token",
    });
    expect(Array.from(bytes)).toEqual([1, 2, 3]);

    await expect(client.downloadZip("https://example.com", { slug: "demo" })).rejects.toThrow(
      "nope",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("includes ownerHandle when downloading owner-qualified skills", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    const client = createNodeClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.downloadZip("https://example.com", {
      slug: "demo",
      ownerHandle: "openclaw",
      version: "1.0.0",
    });

    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/v1/download");
    expect(parsed.searchParams.get("slug")).toBe("demo");
    expect(parsed.searchParams.get("ownerHandle")).toBe("openclaw");
    expect(parsed.searchParams.get("version")).toBe("1.0.0");
  });

  it("retries request and text timeouts using injected timeout helpers", async () => {
    const { setTimeoutImpl, clearTimeoutImpl } = createImmediateTimeouts();
    const fetchImpl = createAbortingFetchMock();
    const client = createNodeClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      setTimeoutImpl: setTimeoutImpl as unknown as typeof setTimeout,
      clearTimeoutImpl,
    });

    await expect(
      client.apiRequest("https://example.com", { method: "GET", path: "/x" }),
    ).rejects.toThrow(/timed out/i);
    await expect(client.fetchText("https://example.com", { path: "/x" })).rejects.toThrow(
      /timed out/i,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(clearTimeoutImpl).toHaveBeenCalledTimes(6);
  });

  it("normalizes non-Error throws from fetch", async () => {
    const fetchImpl = vi.fn(async () => {
      throw { message: "The operation was aborted", name: "AbortError" };
    });
    const client = createNodeClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      client.apiRequest("https://example.com", { method: "GET", path: "/x" }),
    ).rejects.toThrow("The operation was aborted");
  });

  it("posts form data, retries 429, and uses the upload timeout", async () => {
    const successFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    const successClient = createNodeClient({ fetchImpl: successFetch as unknown as typeof fetch });
    const form = new FormData();
    form.append("x", "1");
    const result = await successClient.apiRequestForm("https://example.com", {
      method: "POST",
      path: "/upload",
      token: "clh_token",
      form,
    });
    expect(result).toEqual({ ok: true });
    const [, init] = successFetch.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(form);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer clh_token");

    const rateLimitedFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });
    const retryClient = createNodeClient({
      fetchImpl: rateLimitedFetch as unknown as typeof fetch,
      setTimeoutImpl: createImmediateTimeouts().setTimeoutImpl as unknown as typeof setTimeout,
      clearTimeoutImpl: vi.fn(),
    });
    await expect(
      retryClient.apiRequestForm("https://example.com", {
        method: "POST",
        path: "/upload",
        form: new FormData(),
      }),
    ).rejects.toThrow("rate limited");
    expect(rateLimitedFetch).toHaveBeenCalledTimes(3);

    const { setTimeoutImpl, clearTimeoutImpl } = createImmediateTimeouts();
    const abortingFetch = createAbortingFetchMock();
    const timeoutClient = createNodeClient({
      fetchImpl: abortingFetch as unknown as typeof fetch,
      setTimeoutImpl: setTimeoutImpl as unknown as typeof setTimeout,
      clearTimeoutImpl,
    });
    await expect(
      timeoutClient.apiRequestForm("https://example.com", {
        method: "POST",
        path: "/upload",
        form: new FormData(),
      }),
    ).rejects.toThrow(/timed out after 120s/i);
    expect(setTimeoutImpl.mock.calls[0]?.[1]).toBe(120_000);

    const longTimeouts = createImmediateTimeouts();
    const longTimeoutClient = createNodeClient({
      fetchImpl: createAbortingFetchMock() as unknown as typeof fetch,
      setTimeoutImpl: longTimeouts.setTimeoutImpl as unknown as typeof setTimeout,
      clearTimeoutImpl: longTimeouts.clearTimeoutImpl,
    });
    await expect(
      longTimeoutClient.apiRequestForm("https://example.com", {
        method: "POST",
        path: "/upload",
        form: new FormData(),
        timeoutMs: 300_000,
      }),
    ).rejects.toThrow(/timed out after 300s/i);
    expect(longTimeouts.setTimeoutImpl.mock.calls[0]?.[1]).toBe(300_000);
  });

  describe("stalled response body", () => {
    function createShortTimeouts() {
      const setTimeoutImpl = vi.fn((callback: () => void, _ms?: number) =>
        setTimeout(callback, 50),
      );
      return {
        setTimeoutImpl: setTimeoutImpl as unknown as typeof setTimeout,
        clearTimeoutImpl: clearTimeout,
      };
    }

    it(
      "aborts apiRequest when json never completes after headers",
      { timeout: 5_000 },
      async () => {
        const fetchImpl = createStalledBodyFetch();
        const client = createNodeClient({
          fetchImpl: fetchImpl as unknown as typeof fetch,
          ...createShortTimeouts(),
        });
        await expect(
          client.apiRequest("https://example.com", {
            method: "GET",
            path: "/x",
            retryCount: 0,
          }),
        ).rejects.toThrow(/Request timed out after 15s/);
      },
    );

    it(
      "aborts fetchText when the text body never completes after headers",
      { timeout: 5_000 },
      async () => {
        const fetchImpl = createStalledBodyFetch();
        const client = createNodeClient({
          fetchImpl: fetchImpl as unknown as typeof fetch,
          ...createShortTimeouts(),
        });
        await expect(client.fetchText("https://example.com", { path: "/x" })).rejects.toThrow(
          /Request timed out after 15s/,
        );
      },
    );

    it(
      "aborts downloadZip when arrayBuffer never completes after headers",
      { timeout: 5_000 },
      async () => {
        const fetchImpl = createStalledBodyFetch();
        const client = createNodeClient({
          fetchImpl: fetchImpl as unknown as typeof fetch,
          ...createShortTimeouts(),
        });
        await expect(client.downloadZip("https://example.com", { slug: "demo" })).rejects.toThrow(
          /Request timed out after 15s/,
        );
      },
    );

    it(
      "times out a stalled 429 body instead of retrying Retry-After",
      { timeout: 5_000 },
      async () => {
        const fetchImpl = createStalledBodyFetch({
          ok: false,
          status: 429,
          headers: { "Retry-After": "120" },
        });
        const client = createNodeClient({
          fetchImpl: fetchImpl as unknown as typeof fetch,
          ...createShortTimeouts(),
        });
        await expect(
          client.apiRequest("https://example.com", {
            method: "GET",
            path: "/x",
            retryCount: 0,
          }),
        ).rejects.toThrow(/Request timed out after 15s/);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      },
    );
  });
});
