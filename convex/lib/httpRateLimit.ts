import { MINUTE, type RateLimitConfig } from "@convex-dev/rate-limiter";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { getOptionalApiTokenUser } from "./apiTokenAuth";
import { corsHeaders, mergeHeaders } from "./httpHeaders";

export const RATE_LIMITS = {
  read: { ip: 3000, key: 12000, adminKey: 120000 },
  write: { ip: 300, key: 3000, adminKey: 30000 },
  trustedPublish: { ip: 3000, key: 12000, adminKey: 120000 },
  download: { ip: 1200, key: 6000, adminKey: 60000 },
  export: { ip: 10, key: 60, adminKey: 60 },
} as const;

const RATE_LIMIT_WINDOW_MS = 60_000;
const HTTP_RATE_LIMIT_SHARDS = 64;
const HTTP_RATE_LIMIT_MIN_SHARD_CAPACITY = 10;
const HTTP_RATE_LIMIT_KEY_TTL_MS = 24 * 60 * 60 * 1000;

type RateLimitResult = {
  allowed: boolean;
  // The component does not expose an exact global remaining count for sharded
  // buckets, so successful responses omit this instead of guessing.
  remaining?: number;
  limit: number;
  resetAt: number;
  unavailable?: boolean;
};

export type ApplyRateLimitResult =
  | { ok: true; headers: HeadersInit }
  | { ok: false; response: Response };

type RateLimitKind = keyof typeof RATE_LIMITS;
type RateLimitSubject = "ip" | "key" | "adminKey";
type HttpRateLimitName = `${RateLimitKind}${Capitalize<RateLimitSubject>}`;
type FixedWindowRateLimitConfig = Extract<RateLimitConfig, { kind: "fixed window" }>;

const preappliedRateLimitHeaders = new WeakMap<Request, HeadersInit>();

function fixedWindowRateLimit(rate: number): FixedWindowRateLimitConfig {
  const shards = Math.max(
    1,
    Math.min(HTTP_RATE_LIMIT_SHARDS, Math.floor(rate / HTTP_RATE_LIMIT_MIN_SHARD_CAPACITY)),
  );
  return {
    kind: "fixed window",
    rate,
    period: MINUTE,
    start: 0,
    shards,
  };
}

const HTTP_RATE_LIMIT_CONFIGS = {
  readIp: fixedWindowRateLimit(RATE_LIMITS.read.ip),
  readKey: fixedWindowRateLimit(RATE_LIMITS.read.key),
  readAdminKey: fixedWindowRateLimit(RATE_LIMITS.read.adminKey),
  writeIp: fixedWindowRateLimit(RATE_LIMITS.write.ip),
  writeKey: fixedWindowRateLimit(RATE_LIMITS.write.key),
  writeAdminKey: fixedWindowRateLimit(RATE_LIMITS.write.adminKey),
  trustedPublishIp: fixedWindowRateLimit(RATE_LIMITS.trustedPublish.ip),
  trustedPublishKey: fixedWindowRateLimit(RATE_LIMITS.trustedPublish.key),
  trustedPublishAdminKey: fixedWindowRateLimit(RATE_LIMITS.trustedPublish.adminKey),
  downloadIp: fixedWindowRateLimit(RATE_LIMITS.download.ip),
  downloadKey: fixedWindowRateLimit(RATE_LIMITS.download.key),
  downloadAdminKey: fixedWindowRateLimit(RATE_LIMITS.download.adminKey),
  exportIp: fixedWindowRateLimit(RATE_LIMITS.export.ip),
  exportKey: fixedWindowRateLimit(RATE_LIMITS.export.key),
  exportAdminKey: fixedWindowRateLimit(RATE_LIMITS.export.adminKey),
} as const satisfies Record<HttpRateLimitName, RateLimitConfig>;

export function markRateLimitApplied(request: Request, headers: HeadersInit): void {
  preappliedRateLimitHeaders.set(request, headers);
}

export async function applyRateLimit(
  ctx: ActionCtx,
  request: Request,
  kind: RateLimitKind,
): Promise<ApplyRateLimitResult> {
  const preappliedHeaders = preappliedRateLimitHeaders.get(request);
  if (preappliedHeaders) return { ok: true, headers: preappliedHeaders };

  const auth = await getOptionalApiTokenUser(ctx, request);
  const ip = getClientIp(request) ?? "unknown";
  const ipSource = getClientIpSource(request);
  const hasClientIp = ip !== "unknown";

  // Authenticated requests are enforced and consumed by user bucket only to
  // avoid draining shared IP quota.
  if (auth) {
    const userLimit = getAuthenticatedRateLimit(kind, auth.user);
    const userResult = await checkRateLimit(
      ctx,
      getAuthenticatedRateLimitKey(auth.userId, kind),
      userLimit.name,
      userLimit.limit,
    );
    const headers = rateHeaders(userResult);
    if (userResult.unavailable) return rateLimitUnavailable(headers);
    if (!userResult.allowed) {
      console.info("rate_limit_denied", {
        kind,
        auth: true,
        admin: auth.user.role === "admin",
        userAllowed: false,
        ipAllowed: null,
        ipSource,
        hasClientIp,
      });
      return {
        ok: false,
        response: new Response("Rate limit exceeded", {
          status: 429,
          headers: mergeHeaders(
            {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
            },
            headers,
            corsHeaders(),
          ),
        }),
      };
    }
    return { ok: true, headers };
  }

  // Anonymous requests remain IP-enforced.
  const ipResult = await checkRateLimit(
    ctx,
    getAnonymousRateLimitKey(kind, ip),
    getHttpRateLimitName(kind, "ip"),
    RATE_LIMITS[kind].ip,
  );
  const headers = rateHeaders(ipResult);
  if (ipResult.unavailable) return rateLimitUnavailable(headers);

  if (!ipResult.allowed) {
    console.info("rate_limit_denied", {
      kind,
      auth: false,
      userAllowed: null,
      ipAllowed: ipResult.allowed,
      ipSource,
      hasClientIp,
    });
    return {
      ok: false,
      response: new Response("Rate limit exceeded", {
        status: 429,
        headers: mergeHeaders(
          {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
          headers,
          corsHeaders(),
        ),
      }),
    };
  }

  return { ok: true, headers };
}

function getAnonymousRateLimitKey(kind: RateLimitKind, ip: string) {
  if (ip !== "unknown") return `ip:${ip}:${kind}`;
  return `ip:unknown:${kind}`;
}

function getAuthenticatedRateLimitKey(userId: string, kind: RateLimitKind) {
  return `user:${userId}:${kind}`;
}

function getAuthenticatedRateLimit(kind: RateLimitKind, user: Pick<Doc<"users">, "role">) {
  const subject = user.role === "admin" ? "adminKey" : "key";
  return {
    name: getHttpRateLimitName(kind, subject),
    limit: RATE_LIMITS[kind][subject],
  };
}

export function getClientIp(request: Request): string | null {
  if (!shouldTrustClientIpHeaders()) return null;

  const cfHeader = request.headers.get("cf-connecting-ip");
  if (cfHeader) return splitFirstIp(cfHeader);

  const forwarded =
    request.headers.get("x-forwarded-for") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("fly-client-ip");

  return splitFirstIp(forwarded);
}

function getClientIpSource(request: Request) {
  if (!shouldTrustClientIpHeaders()) return "none";
  if (request.headers.get("cf-connecting-ip")) return "cf-connecting-ip";
  if (request.headers.get("x-forwarded-for")) return "x-forwarded-for";
  if (request.headers.get("x-real-ip")) return "x-real-ip";
  if (request.headers.get("fly-client-ip")) return "fly-client-ip";
  return "none";
}

async function checkRateLimit(
  ctx: ActionCtx,
  key: string,
  name: HttpRateLimitName,
  limit: number,
): Promise<RateLimitResult> {
  const now = Date.now();
  try {
    await touchRateLimitKeyMetadata(ctx, { name, key, now });
    const status = await ctx.runMutation(internal.rateLimits.consumeHttpRateLimitKeyInternal, {
      name,
      key,
      config: HTTP_RATE_LIMIT_CONFIGS[name],
    });
    if (!status.ok) {
      return {
        allowed: false,
        remaining: 0,
        limit,
        resetAt: now + status.retryAfter,
      };
    }

    return {
      allowed: true,
      limit,
      resetAt: getCurrentWindowResetAt(now),
    };
  } catch (error) {
    if (!isRateLimitCounterWriteConflict(error)) throw error;
    return {
      allowed: false,
      remaining: 0,
      limit,
      resetAt: now + 1000,
      unavailable: true,
    };
  }
}

async function touchRateLimitKeyMetadata(
  ctx: ActionCtx,
  args: { name: HttpRateLimitName; key: string; now: number },
) {
  try {
    await ctx.runMutation(internal.rateLimits.touchHttpRateLimitKeyInternal, {
      ...args,
      ttlMs: HTTP_RATE_LIMIT_KEY_TTL_MS,
    });
  } catch (error) {
    if (!isRateLimitMetadataWriteConflict(error)) throw error;
    // Metadata must be attempted before quota consumption so cleanup cannot
    // reset a bucket after it is consumed. A conflict means cleanup or another
    // refresh committed first, so the later counter mutation remains ordered.
    console.warn("rate_limit_metadata_write_contention", {
      name: args.name,
    });
  }
}

function rateLimitUnavailable(headers: HeadersInit): Extract<ApplyRateLimitResult, { ok: false }> {
  console.warn("rate_limit_unavailable", {
    reason: "counter_write_contention",
  });
  return {
    ok: false,
    response: new Response("Rate limit temporarily unavailable", {
      status: 503,
      headers: mergeHeaders(
        {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "Retry-After": "1",
        },
        headers,
        corsHeaders(),
      ),
    }),
  };
}

function rateHeaders(result: RateLimitResult): HeadersInit {
  const nowMs = Date.now();
  const resetSeconds = Math.ceil(result.resetAt / 1000);
  const resetDelaySeconds = Math.max(1, Math.ceil((result.resetAt - nowMs) / 1000));
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Reset": String(resetSeconds),
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Reset": String(resetDelaySeconds),
  };
  if (result.remaining !== undefined) {
    headers["X-RateLimit-Remaining"] = String(result.remaining);
    headers["RateLimit-Remaining"] = String(result.remaining);
  }
  if (!result.allowed) headers["Retry-After"] = String(resetDelaySeconds);
  return headers;
}

function getCurrentWindowResetAt(now: number) {
  return Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS + RATE_LIMIT_WINDOW_MS;
}

function getHttpRateLimitName(kind: RateLimitKind, subject: RateLimitSubject): HttpRateLimitName {
  const suffix = subject === "ip" ? "Ip" : subject === "key" ? "Key" : "AdminKey";
  return `${kind}${suffix}` as HttpRateLimitName;
}

export function parseBearerToken(request: Request) {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token || null;
}

function splitFirstIp(header: string | null) {
  if (!header) return null;
  if (header.includes(",")) return header.split(",")[0]?.trim() || null;
  const trimmed = header.trim();
  return trimmed || null;
}

function shouldTrustClientIpHeaders() {
  const value = (process.env.TRUST_FORWARDED_IPS ?? "").trim().toLowerCase();
  // Direct Convex HTTP endpoints can be reached without ClawHub's edge. Trust
  // client IP headers only when the deployment is explicitly behind that edge.
  if (!value) return false;
  if (value === "1" || value === "true" || value === "yes") return true;
  return false;
}

function isRateLimitCounterWriteConflict(error: unknown) {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("rateLimits") &&
    error.message.includes("changed while this mutation was being run")
  );
}

function isRateLimitMetadataWriteConflict(error: unknown) {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("httpRateLimitKeys") &&
    error.message.includes("changed while this mutation was being run")
  );
}
