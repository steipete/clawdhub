import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { buildDownloadMetricArgs, getDownloadIdentity } from "./downloadMetrics";
import { httpAction } from "./functions";
import { ambiguousSkillSlugResponse, publicApiOrigin } from "./httpApiV1/shared";
import { getOptionalActiveAuthUserIdFromAction } from "./lib/access";
import { getOptionalApiTokenUserId } from "./lib/apiTokenAuth";
import {
  ARCHIVE_MANIFEST_AUDIENCE,
  ARCHIVE_MANIFEST_CONTENT_TYPE,
  ARCHIVE_MANIFEST_JWS_TYPE,
  ARCHIVE_METRIC_AUDIENCE,
  ARCHIVE_METRIC_JWS_TYPE,
  type ArchiveMetricArgs,
  type ArchiveMetricPayload,
  signArchivePayload,
  type SkillArchiveManifest,
  verifyArchivePayloadWithLocalJwks,
} from "./lib/archiveManifest";
import {
  ARCHIVE_REQUEST_IDENTITY_HEADER,
  expectedVercelEnvironmentForConvexSite,
  type ClawHubVercelEnvironment,
  verifyClawHubVercelOidcToken,
} from "./lib/clawhubVercelOidc";
import {
  buildGitHubSkillHandoffDescriptor,
  getGitHubHandoffBlock,
  isReadyGitHubHandoffTarget,
  type GitHubHandoffTarget,
} from "./lib/githubHandoff";
import { corsHeaders, mergeHeaders } from "./lib/httpHeaders";
import { applyRateLimit, getClientIp } from "./lib/httpRateLimit";
import {
  getPublicSkillFileAccessBlock,
  getPublicSkillVersionDownloadBlock,
  isSkillVersionForSkill,
} from "./lib/skillFileAccess";
import { buildDeterministicZipStream } from "./lib/skillZip";

const HOUR_MS = 3_600_000;
const DOWNLOAD_STAT_JITTER_MS = 60_000;
const ARCHIVE_MANIFEST_REQUEST_HEADER = "x-clawhub-archive-manifest";
const ARCHIVE_MANIFEST_TTL_MS = 30_000;
const ARCHIVE_MANIFEST_CLOCK_SKEW_MS = 5_000;
const MAX_ARCHIVE_MANIFEST_FILES = 8_192;
const MAX_ARCHIVE_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_METRIC_TOKEN_BYTES = 16 * 1024;
const LOCAL_DOWNLOAD_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

type DownloadCtx = Parameters<Parameters<typeof httpAction>[0]>[0];

type DownloadDependencies = {
  verifyArchiveRequester: (
    token: string,
    expectedEnvironment: ClawHubVercelEnvironment,
  ) => Promise<unknown>;
};

const DEFAULT_DOWNLOAD_DEPENDENCIES: DownloadDependencies = {
  verifyArchiveRequester: verifyClawHubVercelOidcToken,
};

export async function downloadZipHandler(
  ctx: DownloadCtx,
  request: Request,
  dependencies: DownloadDependencies = DEFAULT_DOWNLOAD_DEPENDENCIES,
) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug")?.trim().toLowerCase();
  const ownerHandle =
    (url.searchParams.get("ownerHandle") ?? url.searchParams.get("owner"))
      ?.trim()
      .replace(/^@+/, "") || undefined;
  const versionParam = url.searchParams.get("version")?.trim();
  const tagParam = url.searchParams.get("tag")?.trim();

  if (!slug) {
    return new Response("Missing slug", {
      status: 400,
      headers: corsHeaders(),
    });
  }

  const manifestRequested = request.headers.get(ARCHIVE_MANIFEST_REQUEST_HEADER) === "v1";
  const publicOrigin = publicApiOrigin(request);
  const isLocalDownload = LOCAL_DOWNLOAD_HOSTS.has(url.hostname);
  if (!manifestRequested && !isLocalDownload && publicOrigin !== url.origin) {
    return new Response(null, {
      status: 307,
      headers: mergeHeaders(
        {
          Location: new URL(`${url.pathname}${url.search}`, publicOrigin).href,
          "Cache-Control": "no-store",
        },
        corsHeaders(),
      ),
    });
  }
  if (manifestRequested) {
    const token = request.headers.get(ARCHIVE_REQUEST_IDENTITY_HEADER)?.trim();
    const expectedEnvironment = expectedVercelEnvironmentForConvexSite(request.url);
    if (!token || !expectedEnvironment) {
      return unauthorizedArchiveManifestResponse();
    }
    try {
      await dependencies.verifyArchiveRequester(token, expectedEnvironment);
    } catch {
      return unauthorizedArchiveManifestResponse();
    }
  }

  const rate = await applyRateLimit(ctx, request, "download");
  if (!rate.ok) return rate.response;

  const skillResult = await ctx.runQuery(api.skills.getBySlug, {
    slug,
    ...(ownerHandle ? { ownerHandle } : {}),
  });
  if (!skillResult?.skill) {
    if (skillResult?.ambiguous) {
      return ambiguousSkillSlugResponse(
        slug,
        `/api/v1/download?slug=${encodeURIComponent(slug)}&ownerHandle=<owner>`,
        mergeHeaders(rate.headers, corsHeaders()),
      );
    }
    return new Response("Skill not found", {
      status: 404,
      headers: mergeHeaders(rate.headers, corsHeaders()),
    });
  }

  const skill = skillResult.skill;
  let version = skill.latestVersionId
    ? await ctx.runQuery(internal.skills.getVersionByIdInternal, {
        versionId: skill.latestVersionId,
      })
    : null;

  if (versionParam) {
    version = await ctx.runQuery(internal.skills.getVersionBySkillAndVersionInternal, {
      skillId: skill._id,
      version: versionParam,
    });
  } else if (tagParam) {
    const versionId = skill.tags[tagParam];
    if (versionId) {
      version = await ctx.runQuery(internal.skills.getVersionByIdInternal, { versionId });
    }
  }

  if (!version || !isSkillVersionForSkill(version, skill._id)) {
    if (!versionParam && !tagParam && skill.installKind === "github") {
      const moderationBlock = getPublicSkillFileAccessBlock(skillResult.moderationInfo);
      if (moderationBlock) {
        return new Response(moderationBlock.message, {
          status: moderationBlock.status,
          headers: mergeHeaders(rate.headers, corsHeaders()),
        });
      }
      return githubDownloadHandoffResponse(ctx, request, skill._id, rate.headers);
    }
    return new Response("Version not found", {
      status: 404,
      headers: mergeHeaders(rate.headers, corsHeaders()),
    });
  }
  if (version.softDeletedAt) {
    return new Response("Version not available", {
      status: 410,
      headers: mergeHeaders(rate.headers, corsHeaders()),
    });
  }

  const moderationBlock = getPublicSkillVersionDownloadBlock(
    skillResult.moderationInfo,
    version,
    skill.latestVersionId ?? skill.tags.latest,
  );
  if (moderationBlock) {
    return new Response(moderationBlock.message, {
      status: moderationBlock.status,
      headers: mergeHeaders(rate.headers, corsHeaders()),
    });
  }

  const meta = {
    ownerId: String(skill.ownerUserId),
    slug: skill.slug,
    version: version.version,
    publishedAt: version.createdAt,
  };

  if (manifestRequested) {
    if (version.files.length > MAX_ARCHIVE_MANIFEST_FILES) {
      return new Response("Skill archive contains too many files", {
        status: 413,
        headers: mergeHeaders(rate.headers, corsHeaders()),
      });
    }
    const entries: Array<{ path: string; url: string }> = [];
    for (const file of version.files) {
      const fileUrl = await ctx.storage.getUrl(file.storageId);
      if (fileUrl) entries.push({ path: file.path, url: fileUrl });
    }
    const issuedAt = Date.now();
    const expiresAt = issuedAt + ARCHIVE_MANIFEST_TTL_MS;
    const issuer = url.origin;
    const metricToken = await buildArchiveDownloadMetricToken(
      ctx,
      request,
      skill._id,
      issuer,
      issuedAt,
      expiresAt,
    );
    const manifest: SkillArchiveManifest = {
      schema: "clawhub.skill-archive-manifest.v1",
      issuer,
      audience: ARCHIVE_MANIFEST_AUDIENCE,
      issuedAt,
      expiresAt,
      filename: `${slug}-${version.version}.zip`,
      meta,
      entries,
      ...(metricToken ? { metricToken } : {}),
    };
    const signedManifest = await signArchivePayload(manifest, ARCHIVE_MANIFEST_JWS_TYPE);
    if (new TextEncoder().encode(signedManifest).byteLength > MAX_ARCHIVE_MANIFEST_BYTES) {
      return new Response("Skill archive manifest is too large", {
        status: 413,
        headers: mergeHeaders(rate.headers, corsHeaders()),
      });
    }

    return new Response(signedManifest, {
      status: 200,
      headers: mergeHeaders(
        rate.headers,
        {
          "Content-Type": ARCHIVE_MANIFEST_CONTENT_TYPE,
          "Cache-Control": "private, no-store",
        },
        corsHeaders(),
      ),
    });
  }

  const entries: Array<{
    path: string;
    openStream: () => Promise<ReadableStream<Uint8Array> | null>;
  }> = [];
  for (const file of version.files) {
    const blob = await ctx.storage.get(file.storageId);
    if (!blob) {
      return new Response("Skill archive file missing from storage", {
        status: 410,
        headers: mergeHeaders(rate.headers, corsHeaders()),
      });
    }
    entries.push({
      path: file.path,
      openStream: async () => blob.stream(),
    });
  }
  const zipStream = buildDeterministicZipStream(entries, meta);

  await scheduleSkillDownloadMetric(ctx, request, skill._id);

  return new Response(zipStream, {
    status: 200,
    headers: mergeHeaders(
      rate.headers,
      {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${slug}-${version.version}.zip"`,
        "Cache-Control": "private, max-age=60",
      },
      corsHeaders(),
    ),
  });
}

export const downloadZip = httpAction(downloadZipHandler);

function unauthorizedArchiveManifestResponse() {
  return new Response("Unauthorized archive manifest request", {
    status: 401,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function recordArchiveDownloadMetricHandler(ctx: DownloadCtx, request: Request) {
  const token = await readBoundedRequestText(request, MAX_ARCHIVE_METRIC_TOKEN_BYTES);
  if (!token) {
    return new Response("Invalid archive metric capability", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  let value: unknown;
  try {
    value = await verifyArchivePayloadWithLocalJwks(token, ARCHIVE_METRIC_JWS_TYPE);
  } catch {
    return new Response("Invalid archive metric capability", {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const payload = parseArchiveMetricPayload(value, new URL(request.url).origin, Date.now());
  if (!payload) {
    return new Response("Invalid archive metric capability", {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    await ctx.scheduler.runAfter(
      Math.floor(Math.random() * DOWNLOAD_STAT_JITTER_MS),
      internal.downloadMetrics.recordDownloadMetricInternal,
      {
        ...payload.metric,
        target: { kind: "skill", id: payload.metric.target.id as Id<"skills"> },
      },
    );
  } catch {
    // Metrics remain best-effort and must not affect an archive already being streamed.
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

export const recordArchiveDownloadMetric = httpAction(recordArchiveDownloadMetricHandler);

export function getHourStart(timestamp: number) {
  return Math.floor(timestamp / HOUR_MS) * HOUR_MS;
}

export function getDownloadIdentityValue(request: Request, userId: string | null) {
  if (userId) return `user:${userId}`;
  const ip = getClientIp(request);
  if (!ip) return null;
  return `ip:${ip}`;
}

async function githubDownloadHandoffResponse(
  ctx: DownloadCtx,
  request: Request,
  skillId: Id<"skills">,
  rateHeaders: HeadersInit,
) {
  const target = (await ctx.runQuery(internal.skills.getGitHubDownloadTargetInternal, {
    skillId,
  })) as GitHubHandoffTarget;
  const block = getGitHubHandoffBlock(target);
  if (block) {
    return new Response(block.message, {
      status: block.status,
      headers: mergeHeaders(rateHeaders, corsHeaders()),
    });
  }
  if (!isReadyGitHubHandoffTarget(target)) {
    return new Response("GitHub-backed skill source metadata is incomplete.", {
      status: 409,
      headers: mergeHeaders(rateHeaders, corsHeaders()),
    });
  }

  await scheduleSkillDownloadMetric(ctx, request, skillId);

  return Response.json(buildGitHubSkillHandoffDescriptor(target), {
    status: 200,
    headers: mergeHeaders(
      rateHeaders,
      {
        "Cache-Control": "private, max-age=60",
      },
      corsHeaders(),
    ),
  });
}

export async function scheduleSkillDownloadMetric(
  ctx: DownloadCtx,
  request: Request,
  skillId: Id<"skills">,
) {
  try {
    const userId = await getOptionalDownloadUserId(ctx, request);
    const identity = getDownloadIdentity(request, userId ? String(userId) : null);
    if (identity) {
      await ctx.scheduler.runAfter(
        Math.floor(Math.random() * DOWNLOAD_STAT_JITTER_MS),
        internal.downloadMetrics.recordDownloadMetricInternal,
        await buildDownloadMetricArgs({
          target: { kind: "skill", id: skillId },
          identity,
          now: Date.now(),
        }),
      );
    }
  } catch {
    // Best-effort metric path; do not fail downloads.
  }
}

async function buildArchiveDownloadMetricToken(
  ctx: DownloadCtx,
  request: Request,
  skillId: Id<"skills">,
  issuer: string,
  issuedAt: number,
  expiresAt: number,
) {
  try {
    const userId = await getOptionalDownloadUserId(ctx, request);
    const identity = getDownloadIdentity(request, userId ? String(userId) : null);
    if (!identity) return undefined;
    const metricArgs = await buildDownloadMetricArgs({
      target: { kind: "skill", id: skillId },
      identity,
      now: issuedAt,
    });
    const metric: ArchiveMetricArgs = {
      ...metricArgs,
      target: { kind: "skill", id: String(skillId) },
    };
    const payload: ArchiveMetricPayload = {
      schema: "clawhub.archive-download-metric.v1",
      issuer,
      audience: ARCHIVE_METRIC_AUDIENCE,
      issuedAt,
      expiresAt,
      metric,
    };
    return await signArchivePayload(payload, ARCHIVE_METRIC_JWS_TYPE);
  } catch {
    return undefined;
  }
}

function parseArchiveMetricPayload(
  value: unknown,
  expectedIssuer: string,
  now: number,
): ArchiveMetricPayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Partial<ArchiveMetricPayload>;
  if (payload.schema !== "clawhub.archive-download-metric.v1") return null;
  if (payload.issuer !== expectedIssuer || payload.audience !== ARCHIVE_METRIC_AUDIENCE)
    return null;
  if (!Number.isFinite(payload.issuedAt) || !Number.isFinite(payload.expiresAt)) return null;
  const issuedAt = payload.issuedAt as number;
  const expiresAt = payload.expiresAt as number;
  if (issuedAt > now + ARCHIVE_MANIFEST_CLOCK_SKEW_MS || expiresAt <= now) return null;
  if (expiresAt <= issuedAt || expiresAt - issuedAt > ARCHIVE_MANIFEST_TTL_MS) return null;
  if (!payload.metric || typeof payload.metric !== "object") return null;
  const metric = payload.metric as Partial<ArchiveMetricArgs>;
  if (metric.target?.kind !== "skill" || typeof metric.target.id !== "string") return null;
  if (metric.identityKind !== "user" && metric.identityKind !== "ip") return null;
  if (typeof metric.identityHash !== "string" || metric.identityHash.length === 0) return null;
  if (!Number.isFinite(metric.dayStart) || !Number.isFinite(metric.occurredAt)) return null;
  return payload as ArchiveMetricPayload;
}

async function readBoundedRequestText(request: Request, maxBytes: number) {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function getOptionalDownloadUserId(
  ctx: DownloadCtx,
  request: Request,
): Promise<Id<"users"> | null> {
  const apiTokenUserId = await getOptionalApiTokenUserId(ctx, request);
  if (apiTokenUserId) return apiTokenUserId;
  return (await getOptionalActiveAuthUserIdFromAction(ctx)) ?? null;
}

export const __test = {
  getHourStart,
  getDownloadIdentityValue,
};
