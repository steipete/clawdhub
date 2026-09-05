import {
  CliPublishRequestSchema,
  decodeUtf8Text,
  normalizeContentType,
  parseArk,
} from "clawhub-schema";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { assertAdmin, assertModerator } from "../lib/access";
import { requireApiTokenUser, requirePackagePublishAuth } from "../lib/apiTokenAuth";
import { corsHeaders, mergeHeaders } from "../lib/httpHeaders";
import { getPublishFileSizeError, MAX_PUBLISH_FILE_BYTES } from "../lib/publishLimits";
import { isMacJunkPath } from "../lib/skills";
export { getPathSegments, parsePackagePathSegments } from "../lib/httpPathSegments";

export const MAX_RAW_FILE_BYTES = 200 * 1024;
const DEFAULT_PUBLIC_SITE_URL = "https://clawhub.ai";

const SAFE_TEXT_FILE_CSP =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function attachmentDisposition(path: string) {
  return `attachment; filename*=UTF-8''${encodeURIComponent(path.split("/").at(-1) || "download")}`;
}

type SafeFileResponseParams = {
  path: string;
  contentType?: string;
  sha256: string;
  size: number;
  headers?: HeadersInit;
};

function safeFileResponseHeaders(
  params: SafeFileResponseParams,
  contentType: string,
  forceAttachment: boolean,
) {
  return mergeHeaders(
    params.headers,
    {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=60",
      ETag: params.sha256,
      "X-Content-SHA256": params.sha256,
      "X-Content-Size": String(params.size),
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": SAFE_TEXT_FILE_CSP,
      ...(forceAttachment ? { "Content-Disposition": attachmentDisposition(params.path) } : {}),
    },
    corsHeaders(),
  );
}

export function safeTextFileResponse(params: SafeFileResponseParams & { textContent: string }) {
  const normalized = normalizeContentType(params.contentType);
  const contentType = normalized ? `${normalized}; charset=utf-8` : "text/plain; charset=utf-8";
  const headers = safeFileResponseHeaders(params, contentType, false);

  return new Response(params.textContent, { status: 200, headers });
}

export async function safeStoredFileResponse(
  params: SafeFileResponseParams & {
    blob: Blob;
  },
) {
  const bytes = new Uint8Array(await params.blob.arrayBuffer());
  const contentType = normalizeContentType(params.contentType) ?? "application/octet-stream";

  return new Response(bytes, {
    status: 200,
    headers: safeFileResponseHeaders(params, contentType, true),
  });
}

export async function safeStoredFilePreviewResponse(
  params: SafeFileResponseParams & {
    blob: Blob;
  },
) {
  const bytes = new Uint8Array(await params.blob.arrayBuffer());
  const textContent = decodeUtf8Text(bytes);
  if (textContent === null) {
    return text("File cannot be previewed as text", 415, params.headers);
  }

  return new Response(textContent, {
    status: 200,
    headers: safeFileResponseHeaders(params, "text/plain; charset=utf-8", false),
  });
}

export function json(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), {
    status,
    headers: mergeHeaders(
      {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      headers,
      corsHeaders(),
    ),
  });
}

export function text(value: string, status: number, headers?: HeadersInit) {
  return new Response(value, {
    status,
    headers: mergeHeaders(
      {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
      headers,
      corsHeaders(),
    ),
  });
}

export type AmbiguousSkillSlugChoice = {
  ownerHandle: string;
  slug: string;
  ref: string;
  url: string;
};

export function ambiguousSkillSlugMessage(slug: string, examplePath?: string) {
  if (!examplePath) {
    return `Found multiple skills with the slug "${slug}"; specify which one you want to install:`;
  }
  return (
    `Ambiguous skill slug "${slug}". Multiple publishers use this slug. ` +
    `Retry with ownerHandle, for example: ${examplePath}.`
  );
}

export function ambiguousSkillSlugResponse(
  slug: string,
  examplePath: string,
  headers?: HeadersInit,
  choices?: AmbiguousSkillSlugChoice[],
) {
  if (choices && choices.length > 0) {
    return json(
      {
        code: "AMBIGUOUS_SKILL_SLUG",
        message: ambiguousSkillSlugMessage(slug),
        slug,
        matches: choices,
      },
      409,
      headers,
    );
  }
  return text(ambiguousSkillSlugMessage(slug, examplePath), 409, headers);
}

export async function parseJsonPayload(request: Request, headers: HeadersInit) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    return { ok: true as const, payload };
  } catch {
    return { ok: false as const, response: text("Invalid JSON", 400, headers) };
  }
}

function normalizeOrigin(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

function firstForwardedValue(value: string | null) {
  return value?.split(",")[0]?.trim() || null;
}

function isProductionDeployment() {
  const deployment = process.env.CONVEX_DEPLOYMENT?.trim() ?? "";
  return deployment.startsWith("prod:") || deployment.includes("production");
}

function isTrustedForwardedHost(value: string) {
  try {
    const hostname = new URL(`https://${value}`).hostname.toLowerCase();
    return (
      hostname === "clawhub.ai" ||
      hostname === "www.clawhub.ai" ||
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0"
    );
  } catch {
    return false;
  }
}

export function publicApiOrigin(request: Request) {
  const configured = normalizeOrigin(process.env.SITE_URL ?? process.env.VITE_SITE_URL);
  if (configured) return configured;

  const forwardedHost = firstForwardedValue(request.headers.get("x-forwarded-host"));
  if (
    forwardedHost &&
    !forwardedHost.endsWith(".convex.site") &&
    isTrustedForwardedHost(forwardedHost)
  ) {
    const forwardedProto =
      firstForwardedValue(request.headers.get("x-forwarded-proto")) ??
      firstForwardedValue(request.headers.get("x-forwarded-protocol")) ??
      "https";
    const proto = forwardedProto === "http" ? "http" : "https";
    return `${proto}://${forwardedHost}`;
  }

  const requestUrl = new URL(request.url);
  if (isProductionDeployment() && requestUrl.hostname.endsWith(".convex.site")) {
    return DEFAULT_PUBLIC_SITE_URL;
  }
  return requestUrl.origin;
}

export async function requireApiTokenUserOrResponse(
  ctx: ActionCtx,
  request: Request,
  headers: HeadersInit,
) {
  try {
    const auth = await requireApiTokenUser(ctx, request);
    return {
      ok: true as const,
      userId: auth.userId,
      user: auth.user as Doc<"users">,
      apiTokenId: auth.apiTokenId,
    };
  } catch (error) {
    return { ok: false as const, response: text(formatAuthFailure(error), 401, headers) };
  }
}

export async function requirePackagePublishAuthOrResponse(
  ctx: ActionCtx,
  request: Request,
  headers: HeadersInit,
) {
  try {
    return { ok: true as const, auth: await requirePackagePublishAuth(ctx, request) };
  } catch (error) {
    return { ok: false as const, response: text(formatAuthFailure(error), 401, headers) };
  }
}

export function requireAdminOrResponse(user: Doc<"users">, headers: HeadersInit) {
  try {
    assertAdmin(user);
    return { ok: true as const };
  } catch {
    return { ok: false as const, response: text("Admin role required.", 403, headers) };
  }
}

export function requireModeratorOrResponse(user: Doc<"users">, headers: HeadersInit) {
  try {
    assertModerator(user);
    return { ok: true as const };
  } catch {
    return { ok: false as const, response: text("Moderator role required.", 403, headers) };
  }
}

export function toOptionalNumber(value: string | null) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

type LatestVersionTag =
  | {
      _id: Id<"skillVersions">;
      version?: string;
      softDeletedAt?: unknown;
      skillId?: Id<"skills">;
    }
  | null
  | undefined;

/**
 * Batch resolve version tags to version strings.
 * Collects all version IDs, fetches them in a single query, then maps back.
 *
 * Notes:
 * - Uses `internal.*` queries to avoid expanding the public Convex API surface.
 * - Sorts ids for stable query args (helps caching/log diffs).
 */
export async function resolveTagsBatch(
  ctx: ActionCtx,
  tagsList: Array<Record<string, Id<"skillVersions">>>,
  latestVersions: Array<LatestVersionTag>,
  skillIds: Array<Id<"skills">>,
): Promise<Array<Record<string, string>>> {
  const allVersionIds = new Set<Id<"skillVersions">>();
  const preResolvedTags = tagsList.map((tags, idx) => {
    const resolved: Record<string, string> = {};
    const latest = latestVersions[idx];
    const skillId = skillIds[idx];
    for (const [tag, versionId] of Object.entries(tags)) {
      if (
        latest?._id === versionId &&
        latest.version &&
        !latest.softDeletedAt &&
        latest.skillId === skillId
      ) {
        resolved[tag] = latest.version;
      } else {
        allVersionIds.add(versionId);
      }
    }
    return resolved;
  });

  if (allVersionIds.size === 0) {
    return preResolvedTags;
  }

  const versionIds = [...allVersionIds].sort();
  const versions =
    (await ctx.runQuery(internal.skills.getVersionsByIdsInternal, { versionIds })) ?? [];

  const versionMap = new Map<
    Id<"skillVersions">,
    {
      version: string;
      skillId?: Id<"skills">;
    }
  >();
  for (const v of versions) {
    if (!v?.softDeletedAt) versionMap.set(v._id, { version: v.version, skillId: v.skillId });
  }

  return tagsList.map((tags, idx) => {
    const resolved = { ...preResolvedTags[idx] };
    const skillId = skillIds[idx];
    for (const [tag, versionId] of Object.entries(tags)) {
      if (resolved[tag]) continue;
      const version = versionMap.get(versionId);
      if (version?.skillId === skillId) resolved[tag] = version.version;
    }
    return resolved;
  });
}

async function sha256Hex(bytes: Uint8Array) {
  const data = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

type FileLike = {
  name: string;
  size: number;
  type: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

type FileLikeEntry = FormDataEntryValue & FileLike;

function toFileLike(entry: FormDataEntryValue): FileLikeEntry | null {
  if (typeof entry === "string") return null;
  const candidate = entry as Partial<FileLike>;
  if (typeof candidate.name !== "string") return null;
  if (typeof candidate.size !== "number") return null;
  if (typeof candidate.arrayBuffer !== "function") return null;
  return entry as FileLikeEntry;
}

export async function parseMultipartPublish(
  ctx: ActionCtx,
  request: Request,
): Promise<ReturnType<typeof parsePublishBody>> {
  const form = await request.formData();
  const payloadRaw = form.get("payload");
  if (!payloadRaw || typeof payloadRaw !== "string") {
    throw new Error("Missing payload");
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadRaw) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid JSON payload");
  }

  const files: Array<{
    path: string;
    size: number;
    storageId: Id<"_storage">;
    sha256: string;
    contentType?: string;
  }> = [];

  for (const entry of form.getAll("files")) {
    const file = toFileLike(entry);
    if (!file) continue;
    const path = file.name;
    if (isMacJunkPath(path)) continue;
    const size = file.size;
    if (size > MAX_PUBLISH_FILE_BYTES) {
      throw new Error(getPublishFileSizeError(path));
    }
    const contentType = file.type || undefined;
    const buffer = new Uint8Array(await file.arrayBuffer());
    const sha256 = await sha256Hex(buffer);
    const storageId = await ctx.storage.store(file as Blob);
    files.push({ path, size, storageId, sha256, contentType });
  }

  const forkOf = payload.forkOf && typeof payload.forkOf === "object" ? payload.forkOf : undefined;
  const hasAcceptLicenseTerms = Object.prototype.hasOwnProperty.call(payload, "acceptLicenseTerms");
  const body = {
    slug: payload.slug,
    displayName: payload.displayName,
    ...(typeof payload.ownerHandle === "string" ? { ownerHandle: payload.ownerHandle } : {}),
    ...(typeof payload.sourceOwnerHandle === "string"
      ? { sourceOwnerHandle: payload.sourceOwnerHandle }
      : {}),
    ...(typeof payload.migrateOwner === "boolean" ? { migrateOwner: payload.migrateOwner } : {}),
    version: payload.version,
    changelog: typeof payload.changelog === "string" ? payload.changelog : "",
    ...(hasAcceptLicenseTerms ? { acceptLicenseTerms: payload.acceptLicenseTerms } : {}),
    tags: Array.isArray(payload.tags) ? payload.tags : undefined,
    ...(Array.isArray(payload.categories) ? { categories: payload.categories } : {}),
    ...(Array.isArray(payload.topics) ? { topics: payload.topics } : {}),
    ...(payload.source ? { source: payload.source } : {}),
    files,
    ...(forkOf ? { forkOf } : {}),
  };

  return parsePublishBody(body);
}

export async function parseMultipartSkillScan(
  ctx: ActionCtx,
  request: Request,
  validatePayload?: (payload: Record<string, unknown>) => Record<string, unknown>,
): Promise<{
  payload: Record<string, unknown>;
  files: Array<{
    path: string;
    size: number;
    storageId: Id<"_storage">;
    sha256: string;
    contentType?: string;
  }>;
}> {
  const form = await request.formData();
  const payloadRaw = form.get("payload");
  if (!payloadRaw || typeof payloadRaw !== "string") {
    throw new Error("Missing payload");
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadRaw) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid JSON payload");
  }
  const validatedPayload = validatePayload ? validatePayload(payload) : payload;

  const fileEntries = form
    .getAll("files")
    .map((entry) => toFileLike(entry))
    .filter((file): file is FileLikeEntry => Boolean(file))
    .filter((file) => !isMacJunkPath(file.name));
  if (fileEntries.length === 0) throw new Error("files required");
  if (!fileEntries.some((file) => file.name.trim().toLowerCase() === "skill.md")) {
    throw new Error("SKILL.md required");
  }
  const oversized = fileEntries.find((file) => file.size > MAX_PUBLISH_FILE_BYTES);
  if (oversized) throw new Error(getPublishFileSizeError(oversized.name));

  const files: Array<{
    path: string;
    size: number;
    storageId: Id<"_storage">;
    sha256: string;
    contentType?: string;
  }> = [];

  try {
    for (const file of fileEntries) {
      const path = file.name;
      const size = file.size;
      const contentType = file.type || undefined;
      const buffer = new Uint8Array(await file.arrayBuffer());
      const sha256 = await sha256Hex(buffer);
      const storageId = await ctx.storage.store(file as Blob);
      files.push({ path, size, storageId, sha256, contentType });
    }
  } catch (error) {
    await Promise.allSettled(files.map((file) => ctx.storage.delete(file.storageId)));
    throw error;
  }

  return { payload: validatedPayload, files };
}

export function parsePublishBody(body: unknown) {
  const parsed = parseArk(CliPublishRequestSchema, body, "Publish payload");
  if (parsed.files.length === 0) throw new Error("files required");
  const tags = parsed.tags && parsed.tags.length > 0 ? parsed.tags : undefined;
  return {
    slug: parsed.slug,
    displayName: parsed.displayName,
    ownerHandle: parsed.ownerHandle?.trim().replace(/^@+/, "") || undefined,
    sourceOwnerHandle: parsed.sourceOwnerHandle?.trim().replace(/^@+/, "") || undefined,
    migrateOwner: parsed.migrateOwner === true ? true : undefined,
    version: parsed.version,
    changelog: parsed.changelog,
    acceptLicenseTerms: parsed.acceptLicenseTerms,
    tags,
    categories: parsed.categories,
    topics: parsed.topics,
    source: parsed.source ?? undefined,
    forkOf: parsed.forkOf
      ? {
          slug: parsed.forkOf.slug,
          ownerHandle: parsed.forkOf.ownerHandle?.trim().replace(/^@+/, "") || undefined,
          version: parsed.forkOf.version ?? undefined,
        }
      : undefined,
    files: parsed.files.map((file) => ({
      ...file,
      storageId: file.storageId as Id<"_storage">,
      uploadTicket: file.uploadTicket as Id<"skillPublishUploadTickets"> | undefined,
    })),
  };
}

// Substrings that indicate user-input validation failures from the underlying
// mutations (e.g. `normalizePackageName` ConvexErrors). These are surfaced as
// 400s with the cleaned message so CLI/API clients can see the actual reason
// instead of an opaque 500.
const SOFT_DELETE_BAD_REQUEST_HINTS = [
  "slug required",
  "package name required",
  "package name must be",
  "must be lowercase",
  "npm-safe",
  "reserved for clawhub routes",
  "version required",
] as const;

export function softDeleteErrorToResponse(
  entity: "skill" | "package",
  error: unknown,
  headers: HeadersInit,
) {
  const rawMessage = error instanceof Error ? error.message : `${entity} delete failed`;
  const cleaned = cleanUserFacingErrorMessage(rawMessage) || rawMessage;
  const lower = cleaned.toLowerCase();

  if (lower.includes("unauthorized"))
    return text(formatAuthzMessage(error, "Unauthorized"), 401, headers);
  if (lower.includes("forbidden"))
    return text(formatAuthzMessage(error, "Forbidden"), 403, headers);
  if (lower.includes("not found")) return text(cleaned, 404, headers);
  if (lower.includes("multiple publishers") || lower.includes("owner-qualified")) {
    return text(cleaned, 409, headers);
  }
  if (SOFT_DELETE_BAD_REQUEST_HINTS.some((hint) => lower.includes(hint))) {
    return text(cleaned, 400, headers);
  }

  // Unknown: server-side failure. Keep the body generic; only known
  // user-input validation failures above surface the cleaned mutation message.
  return text("Internal Server Error", 500, headers);
}

export function cleanUserFacingErrorMessage(message: string) {
  let cleaned = message
    .replace(/\[CONVEX[^\]]*\]\s*/g, "")
    .replace(/\[Request ID:[^\]]*\]\s*/g, "")
    .replace(/^Server Error Called by client\s*/i, "")
    .trim();

  for (let i = 0; i < 3; i += 1) {
    const next = cleaned
      .replace(/^Error:\s*/i, "")
      .replace(/^(?:Uncaught\s+)?ConvexError:\s*/i, "")
      .trim();
    if (next === cleaned) break;
    cleaned = next;
  }

  return cleaned;
}

export function formatUserFacingErrorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  return cleanUserFacingErrorMessage(message) || fallback;
}

function formatAuthFailure(error: unknown) {
  const message = formatUserFacingErrorMessage(error, "");
  if (!message || /^unauthorized$/i.test(message)) return "Unauthorized";
  return message || "Unauthorized";
}

// Shared formatter for authz responses.
// - Returns the clean fallback ("Unauthorized" | "Forbidden") when the error
//   carries no additional context beyond the fallback itself (so existing
//   callers that throw `new Error("Forbidden")` keep their body unchanged).
// - Otherwise returns the full message (minus the `ConvexError:` prefix) so
//   CLI/API clients can surface actionable reasons such as
//   "Forbidden: This skill was hidden by moderation ...".
export function formatAuthzMessage(error: unknown, fallback: "Unauthorized" | "Forbidden") {
  const message = formatUserFacingErrorMessage(error, "");
  if (!message) return fallback;
  const stripped = cleanUserFacingErrorMessage(message);
  if (!stripped || stripped.toLowerCase() === fallback.toLowerCase()) return fallback;
  return stripped;
}
