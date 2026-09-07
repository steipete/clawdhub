/* @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyRateLimit, getClientIp, RATE_LIMITS } from "./httpRateLimit";

type MockRateLimitStatus = {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: number;
};

type MockRateLimitPlan = {
  ip: MockRateLimitStatus;
  user?: MockRateLimitStatus;
  tokenValid?: boolean;
  userActive?: boolean;
  userRole?: "admin" | "moderator" | "user" | null;
};

function makeRateLimitCtx(plan: MockRateLimitPlan) {
  const runQuery = vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
    if ("tokenHash" in args) {
      if (plan.tokenValid === false) return null;
      return { _id: "token_1", revokedAt: undefined };
    }
    if ("tokenId" in args) {
      if (plan.userActive === false) return null;
      return {
        _id: "users_123",
        deletedAt: undefined,
        deactivatedAt: undefined,
        role: plan.userRole ?? "user",
      };
    }
    throw new Error(`Unexpected runQuery args: ${JSON.stringify(args)}`);
  });

  const runMutation = vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
    if ("name" in args && "key" in args && !("config" in args)) {
      return { action: "updated", expiresAt: Date.now() + 86_400_000 };
    }
    if (!("name" in args && "config" in args)) {
      throw new Error(`Unexpected runMutation args: ${JSON.stringify(args)}`);
    }
    const key = String(args.key);
    const source = key.startsWith("user:") ? plan.user : plan.ip;
    if (!source) throw new Error(`Missing rate limit source for ${key}`);
    if (source.allowed) {
      source.remaining = Math.max(0, source.remaining - 1);
      return { ok: true };
    }
    return { ok: false, retryAfter: Math.max(1, source.resetAt - Date.now()) };
  });

  return {
    runQuery,
    runMutation,
  } as unknown as Parameters<typeof applyRateLimit>[0];
}

function componentRateLimitCalls(runMutation: ReturnType<typeof vi.fn>) {
  return runMutation.mock.calls.filter(([, args]) => {
    return Boolean(args && typeof args === "object" && "config" in args);
  }) as [unknown, Record<string, unknown>][];
}

function metadataTouchCalls(runMutation: ReturnType<typeof vi.fn>) {
  return runMutation.mock.calls.filter(([, args]) => {
    return Boolean(args && typeof args === "object" && "ttlMs" in args && !("config" in args));
  }) as [unknown, Record<string, unknown>][];
}

describe("getClientIp", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.TRUST_FORWARDED_IPS;
  });
  afterEach(() => {
    if (prev === undefined) {
      delete process.env.TRUST_FORWARDED_IPS;
    } else {
      process.env.TRUST_FORWARDED_IPS = prev;
    }
  });

  it("returns null when cf-connecting-ip is missing (CF-only default)", () => {
    const request = new Request("https://example.com", {
      headers: {
        "x-forwarded-for": "203.0.113.9",
      },
    });
    delete process.env.TRUST_FORWARDED_IPS;
    expect(getClientIp(request)).toBeNull();
  });

  it("keeps forwarded headers disabled when TRUST_FORWARDED_IPS=false", () => {
    const request = new Request("https://example.com", {
      headers: {
        "x-forwarded-for": "203.0.113.9",
      },
    });
    process.env.TRUST_FORWARDED_IPS = "false";
    expect(getClientIp(request)).toBeNull();
  });

  it("ignores cf-connecting-ip unless client ip headers are explicitly trusted", () => {
    const request = new Request("https://example.com", {
      headers: {
        "cf-connecting-ip": "203.0.113.1, 198.51.100.2",
      },
    });
    delete process.env.TRUST_FORWARDED_IPS;
    expect(getClientIp(request)).toBeNull();
  });

  it("returns first ip from cf-connecting-ip when trusted mode is enabled", () => {
    const request = new Request("https://example.com", {
      headers: {
        "cf-connecting-ip": "203.0.113.1, 198.51.100.2",
      },
    });
    process.env.TRUST_FORWARDED_IPS = "true";
    expect(getClientIp(request)).toBe("203.0.113.1");
  });

  it("uses forwarded headers when opt-in enabled", () => {
    const request = new Request("https://example.com", {
      headers: {
        "x-forwarded-for": "203.0.113.9, 198.51.100.2",
      },
    });
    process.env.TRUST_FORWARDED_IPS = "true";
    expect(getClientIp(request)).toBe("203.0.113.9");
  });

  it("prefers x-forwarded-for over x-real-ip when trusted mode is enabled", () => {
    const request = new Request("https://example.com", {
      headers: {
        "x-forwarded-for": "203.0.113.9, 198.51.100.2",
        "x-real-ip": "198.51.100.77",
      },
    });
    process.env.TRUST_FORWARDED_IPS = "true";
    expect(getClientIp(request)).toBe("203.0.113.9");
  });
});

describe("RATE_LIMITS", () => {
  it("keeps anonymous download bursts installation-friendly", () => {
    expect(RATE_LIMITS.download.ip).toBeGreaterThanOrEqual(1200);
    expect(RATE_LIMITS.download.key).toBeGreaterThanOrEqual(6000);
  });

  it("keeps authenticated write bursts release-friendly", () => {
    expect(RATE_LIMITS.write.ip).toBeGreaterThanOrEqual(300);
    expect(RATE_LIMITS.write.key).toBeGreaterThanOrEqual(3000);
  });

  it("allows trusted publish token mint bursts from shared CI egress", () => {
    expect(RATE_LIMITS.trustedPublish.ip).toBeGreaterThanOrEqual(3000);
    expect(RATE_LIMITS.trustedPublish.key).toBeGreaterThanOrEqual(12000);
  });

  it("gives admin API tokens a larger authenticated bucket", () => {
    expect(RATE_LIMITS.write.adminKey).toBeGreaterThan(RATE_LIMITS.write.key);
    expect(RATE_LIMITS.trustedPublish.adminKey).toBeGreaterThan(RATE_LIMITS.trustedPublish.key);
  });
});

describe("applyRateLimit headers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("returns delay-seconds Retry-After on 429 (not epoch)", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const ctx = makeRateLimitCtx({
      ip: {
        allowed: false,
        remaining: 0,
        limit: RATE_LIMITS.download.ip,
        resetAt: 1_030_500,
      },
    });
    const request = new Request("https://example.com", {
      headers: { "cf-connecting-ip": "203.0.113.1" },
    });

    const result = await applyRateLimit(ctx, request, "download");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("Retry-After")).toBe("31");
    expect(result.response.headers.get("X-RateLimit-Reset")).toBe("1031");
    expect(result.response.headers.get("RateLimit-Reset")).toBe("31");
  });

  it("includes rate-limit headers without Retry-After when allowed", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    const ctx = makeRateLimitCtx({
      ip: {
        allowed: true,
        remaining: 19,
        limit: RATE_LIMITS.download.ip,
        resetAt: 2_015_000,
      },
    });
    const request = new Request("https://example.com", {
      headers: { "cf-connecting-ip": "203.0.113.1" },
    });

    const result = await applyRateLimit(ctx, request, "download");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const headers = new Headers(result.headers);
    expect(headers.get("X-RateLimit-Limit")).toBe(String(RATE_LIMITS.download.ip));
    expect(headers.get("X-RateLimit-Remaining")).toBeNull();
    expect(headers.get("X-RateLimit-Reset")).toBe("2040");
    expect(headers.get("RateLimit-Limit")).toBe(String(RATE_LIMITS.download.ip));
    expect(headers.get("RateLimit-Remaining")).toBeNull();
    expect(headers.get("RateLimit-Reset")).toBe("40");
    expect(headers.get("Retry-After")).toBeNull();
  });

  it("returns retryable unavailable response when component counter writes conflict", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_500_000);
    const ctx = {
      runMutation: vi
        .fn()
        .mockResolvedValueOnce({ action: "updated", expiresAt: 88_900_000 })
        .mockRejectedValueOnce(
          new Error('Document in table "rateLimits" changed while this mutation was being run'),
        ),
    } as unknown as Parameters<typeof applyRateLimit>[0];
    const request = new Request("https://example.com", {
      headers: { "cf-connecting-ip": "203.0.113.1" },
    });

    const result = await applyRateLimit(ctx, request, "download");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(503);
    expect(result.response.headers.get("Retry-After")).toBe("1");
    await expect(result.response.text()).resolves.toBe("Rate limit temporarily unavailable");
  });

  it("keeps successful checks available when metadata key writes conflict", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_550_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runMutation = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'Document in table "httpRateLimitKeys" changed while this mutation was being run',
        ),
      )
      .mockResolvedValueOnce({ ok: true });
    const ctx = {
      runMutation,
    } as unknown as Parameters<typeof applyRateLimit>[0];

    const result = await applyRateLimit(
      ctx,
      new Request("https://example.com/api/v1/packages/demo"),
      "read",
    );

    expect(result.ok).toBe(true);
    expect(runMutation).toHaveBeenCalledTimes(2);
    expect(
      runMutation.mock.calls.map(([, args]) => ("config" in args ? "counter" : "metadata")),
    ).toEqual(["metadata", "counter"]);
    expect(warn).toHaveBeenCalledWith("rate_limit_metadata_write_contention", {
      name: "readIp",
    });
  });

  it("configures high-volume component-backed HTTP limits with 64 shards", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_600_000);
    const ctx = makeRateLimitCtx({
      ip: {
        allowed: true,
        remaining: 19,
        limit: 20,
        resetAt: 2_640_000,
      },
    });
    const request = new Request("https://example.com", {
      headers: { "cf-connecting-ip": "203.0.113.1" },
    });

    const result = await applyRateLimit(ctx, request, "download");

    expect(result.ok).toBe(true);
    const runMutation = (ctx as unknown as { runMutation: ReturnType<typeof vi.fn> }).runMutation;
    const [, args] = componentRateLimitCalls(runMutation)[0];
    expect(args).toMatchObject({
      name: "downloadIp",
      key: "ip:unknown:download",
      config: expect.objectContaining({
        kind: "fixed window",
        rate: RATE_LIMITS.download.ip,
        period: 60_000,
        start: 0,
        shards: 64,
      }),
    });
  });

  it("records component key metadata before an allowed limiter check", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_650_000);
    const ctx = makeRateLimitCtx({
      ip: {
        allowed: true,
        remaining: 19,
        limit: RATE_LIMITS.download.ip,
        resetAt: 2_700_000,
      },
    });

    const result = await applyRateLimit(
      ctx,
      new Request("https://example.com/api/v1/download?slug=demo"),
      "download",
    );

    expect(result.ok).toBe(true);
    const runMutation = (ctx as unknown as { runMutation: ReturnType<typeof vi.fn> }).runMutation;
    expect(
      runMutation.mock.calls.map(([, args]) => ("config" in args ? "counter" : "metadata")),
    ).toEqual(["metadata", "counter"]);
    expect(metadataTouchCalls(runMutation).map(([, args]) => args)).toContainEqual(
      expect.objectContaining({
        name: "downloadIp",
        key: "ip:unknown:download",
        now: 2_650_000,
        ttlMs: 86_400_000,
      }),
    );
  });

  it("records component key metadata before a denied limiter check", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_660_000);
    const ctx = makeRateLimitCtx({
      ip: {
        allowed: false,
        remaining: 0,
        limit: RATE_LIMITS.download.ip,
        resetAt: 2_690_000,
      },
    });

    const result = await applyRateLimit(
      ctx,
      new Request("https://example.com/api/v1/download?slug=demo"),
      "download",
    );

    expect(result.ok).toBe(false);
    const runMutation = (ctx as unknown as { runMutation: ReturnType<typeof vi.fn> }).runMutation;
    expect(
      runMutation.mock.calls.map(([, args]) => ("config" in args ? "counter" : "metadata")),
    ).toEqual(["metadata", "counter"]);
    expect(metadataTouchCalls(runMutation).map(([, args]) => args)).toContainEqual(
      expect.objectContaining({
        name: "downloadIp",
        key: "ip:unknown:download",
        now: 2_660_000,
        ttlMs: 86_400_000,
      }),
    );
  });

  it("does not shard low-rate export ip buckets", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_700_000);
    const ctx = makeRateLimitCtx({
      ip: {
        allowed: true,
        remaining: 9,
        limit: RATE_LIMITS.export.ip,
        resetAt: 2_740_000,
      },
    });

    const result = await applyRateLimit(
      ctx,
      new Request("https://example.com/api/v1/skills/export"),
      "export",
    );

    expect(result.ok).toBe(true);
    const runMutation = (ctx as unknown as { runMutation: ReturnType<typeof vi.fn> }).runMutation;
    const [, args] = componentRateLimitCalls(runMutation)[0];
    expect(args).toMatchObject({
      name: "exportIp",
      key: "ip:unknown:export",
      config: expect.objectContaining({
        kind: "fixed window",
        rate: RATE_LIMITS.export.ip,
        period: 60_000,
        start: 0,
        shards: 1,
      }),
    });
  });

  it("allows authenticated users when user bucket is healthy and shared ip bucket is exhausted", async () => {
    vi.spyOn(Date, "now").mockReturnValue(3_000_000);
    const ctx = makeRateLimitCtx({
      ip: {
        allowed: false,
        remaining: 0,
        limit: 20,
        resetAt: 3_040_000,
      },
      user: {
        allowed: true,
        remaining: 42,
        limit: 120,
        resetAt: 3_010_000,
      },
    });
    const request = new Request("https://example.com", {
      headers: {
        authorization: "Bearer clh_token",
        "cf-connecting-ip": "203.0.113.1",
      },
    });

    const result = await applyRateLimit(ctx, request, "download");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const headers = new Headers(result.headers);
    expect(headers.get("X-RateLimit-Limit")).toBe(String(RATE_LIMITS.download.key));
    expect(headers.get("X-RateLimit-Remaining")).toBeNull();
    expect(headers.get("Retry-After")).toBeNull();
  });

  it("does not consume ip bucket for authenticated requests", async () => {
    vi.spyOn(Date, "now").mockReturnValue(3_100_000);
    const ctx = makeRateLimitCtx({
      ip: {
        allowed: true,
        remaining: 19,
        limit: 20,
        resetAt: 3_140_000,
      },
      user: {
        allowed: true,
        remaining: 41,
        limit: 120,
        resetAt: 3_110_000,
      },
    });
    const request = new Request("https://example.com", {
      headers: {
        authorization: "Bearer clh_token",
        "cf-connecting-ip": "203.0.113.1",
      },
    });

    const result = await applyRateLimit(ctx, request, "download");
    expect(result.ok).toBe(true);
    const runMutation = (ctx as unknown as { runMutation: ReturnType<typeof vi.fn> }).runMutation;
    const consumedKeys = componentRateLimitCalls(runMutation).map(([, args]) => String(args.key));
    expect(consumedKeys.some((key) => key.startsWith("user:"))).toBe(true);
    expect(consumedKeys.some((key) => key.startsWith("ip:"))).toBe(false);
  });

  it("uses the admin bucket for authenticated admin requests", async () => {
    vi.spyOn(Date, "now").mockReturnValue(3_200_000);
    const ctx = makeRateLimitCtx({
      userRole: "admin",
      ip: {
        allowed: true,
        remaining: 19,
        limit: RATE_LIMITS.write.ip,
        resetAt: 3_240_000,
      },
      user: {
        allowed: true,
        remaining: RATE_LIMITS.write.adminKey,
        limit: RATE_LIMITS.write.adminKey,
        resetAt: 3_230_000,
      },
    });
    const request = new Request("https://example.com", {
      headers: {
        authorization: "Bearer clh_admin",
        "cf-connecting-ip": "203.0.113.1",
      },
    });

    const result = await applyRateLimit(ctx, request, "write");

    expect(result.ok).toBe(true);
    const runMutation = (ctx as unknown as { runMutation: ReturnType<typeof vi.fn> }).runMutation;
    expect(componentRateLimitCalls(runMutation).map(([, args]) => args)).toContainEqual(
      expect.objectContaining({
        name: "writeAdminKey",
        key: "user:users_123:write",
        config: expect.objectContaining({ rate: RATE_LIMITS.write.adminKey }),
      }),
    );
    if (!result.ok) return;
    expect(new Headers(result.headers).get("X-RateLimit-Limit")).toBe(
      String(RATE_LIMITS.write.adminKey),
    );
  });

  it("denies authenticated users when user bucket is exhausted even if ip bucket is healthy", async () => {
    vi.spyOn(Date, "now").mockReturnValue(4_000_000);
    const ctx = makeRateLimitCtx({
      ip: {
        allowed: true,
        remaining: 19,
        limit: 20,
        resetAt: 4_020_000,
      },
      user: {
        allowed: false,
        remaining: 0,
        limit: 120,
        resetAt: 4_030_000,
      },
    });
    const request = new Request("https://example.com", {
      headers: {
        authorization: "Bearer clh_token",
        "cf-connecting-ip": "203.0.113.1",
      },
    });

    const result = await applyRateLimit(ctx, request, "download");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("X-RateLimit-Limit")).toBe(String(RATE_LIMITS.download.key));
    expect(result.response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(result.response.headers.get("Retry-After")).toBe("30");
  });

  it("uses one anonymous download fallback bucket when client ip is missing", async () => {
    vi.spyOn(Date, "now").mockReturnValue(4_500_000);
    const ctx = makeRateLimitCtx({
      ip: {
        allowed: true,
        remaining: 19,
        limit: 20,
        resetAt: 4_530_000,
      },
    });

    await applyRateLimit(
      ctx,
      new Request("https://example.com/api/v1/download?slug=first&version=1.0.0"),
      "download",
    );
    await applyRateLimit(
      ctx,
      new Request("https://example.com/api/v1/packages/second-plugin/download?version=0.2.0"),
      "download",
    );

    const runMutation = (ctx as unknown as { runMutation: ReturnType<typeof vi.fn> }).runMutation;
    expect(componentRateLimitCalls(runMutation).map(([, args]) => String(args.key))).toEqual([
      "ip:unknown:download",
      "ip:unknown:download",
    ]);
  });

  it("scopes known-ip anonymous buckets by rate limit kind", async () => {
    vi.stubEnv("TRUST_FORWARDED_IPS", "true");
    vi.spyOn(Date, "now").mockReturnValue(4_550_000);
    const readCtx = makeRateLimitCtx({
      ip: {
        allowed: true,
        remaining: 19,
        limit: RATE_LIMITS.read.ip,
        resetAt: 4_580_000,
      },
    });
    const downloadCtx = makeRateLimitCtx({
      ip: {
        allowed: true,
        remaining: 19,
        limit: RATE_LIMITS.download.ip,
        resetAt: 4_580_000,
      },
    });
    const request = new Request("https://example.com/api/v1/packages/demo/download", {
      headers: { "cf-connecting-ip": "203.0.113.1" },
    });

    await applyRateLimit(readCtx, request, "read");
    await applyRateLimit(downloadCtx, request, "download");

    const readMutation = (readCtx as unknown as { runMutation: ReturnType<typeof vi.fn> })
      .runMutation;
    const downloadMutation = (downloadCtx as unknown as { runMutation: ReturnType<typeof vi.fn> })
      .runMutation;
    expect(componentRateLimitCalls(readMutation).map(([, args]) => String(args.key))).toContain(
      "ip:203.0.113.1:read",
    );
    expect(componentRateLimitCalls(downloadMutation).map(([, args]) => String(args.key))).toContain(
      "ip:203.0.113.1:download",
    );
  });

  it("scopes authenticated buckets by rate limit kind", async () => {
    vi.spyOn(Date, "now").mockReturnValue(4_575_000);
    const ctx = makeRateLimitCtx({
      ip: {
        allowed: true,
        remaining: 19,
        limit: RATE_LIMITS.read.ip,
        resetAt: 4_600_000,
      },
      user: {
        allowed: true,
        remaining: 42,
        limit: RATE_LIMITS.download.key,
        resetAt: 4_600_000,
      },
    });
    const request = new Request("https://example.com/api/v1/packages/demo/download", {
      headers: {
        authorization: "Bearer clh_token",
        "cf-connecting-ip": "203.0.113.1",
      },
    });

    const result = await applyRateLimit(ctx, request, "download");

    expect(result.ok).toBe(true);
    const runMutation = (ctx as unknown as { runMutation: ReturnType<typeof vi.fn> }).runMutation;
    expect(componentRateLimitCalls(runMutation).map(([, args]) => String(args.key))).toContain(
      "user:users_123:download",
    );
  });

  it("uses one anonymous read fallback bucket when client ip is missing", async () => {
    vi.spyOn(Date, "now").mockReturnValue(4_600_000);
    const ctx = makeRateLimitCtx({
      ip: {
        allowed: true,
        remaining: 19,
        limit: 20,
        resetAt: 4_630_000,
      },
    });

    await applyRateLimit(ctx, new Request("https://example.com/api/v1/search?q=demo"), "read");
    await applyRateLimit(
      ctx,
      new Request("https://example.com/api/v1/packages/second-plugin"),
      "read",
    );

    const runMutation = (ctx as unknown as { runMutation: ReturnType<typeof vi.fn> }).runMutation;
    expect(componentRateLimitCalls(runMutation).map(([, args]) => String(args.key))).toEqual([
      "ip:unknown:read",
      "ip:unknown:read",
    ]);
  });

  it("falls back to ip enforcement when bearer token is invalid", async () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000_000);
    const ctx = makeRateLimitCtx({
      tokenValid: false,
      ip: {
        allowed: false,
        remaining: 0,
        limit: 20,
        resetAt: 5_030_000,
      },
    });
    const request = new Request("https://example.com", {
      headers: {
        authorization: "Bearer invalid",
        "cf-connecting-ip": "203.0.113.1",
      },
    });

    const result = await applyRateLimit(ctx, request, "download");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("X-RateLimit-Limit")).toBe(String(RATE_LIMITS.download.ip));
    expect(result.response.headers.get("Retry-After")).toBe("30");
  });
});
