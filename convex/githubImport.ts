import { ConvexError, v } from "convex/values";
import { unzipSync } from "fflate";
import semver from "semver";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action } from "./functions";
import { requireUserFromAction } from "./lib/access";
import { buildGitHubApiHeaders, isGitHubAppConfigured } from "./lib/githubAuth";
import {
  buildGitHubImportFileList,
  computeDefaultSelectedPaths,
  detectGitHubImportCandidates,
  fetchGitHubZipBytes,
  isGitHubSkillFilePath,
  listFilesUnderCandidate,
  normalizeRepoPath,
  parseGitHubImportUrl,
  resolveGitHubCommit,
  stripGitHubZipRoot,
  suggestDisplayName,
  suggestVersion,
} from "./lib/githubImport";
import { publishVersionForUser } from "./lib/skillPublish";
import { isMacJunkPath, sanitizePath } from "./lib/skills";

const MAX_SELECTED_BYTES = 50 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 80 * 1024 * 1024;
const MAX_FILE_COUNT = 7_500;
const MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FALLBACK_DISCOVERY_REPOS_PER_PAGE = 30;
const GITHUB_API = "https://api.github.com";
const OWNED_PUBLIC_REPO_ONLY_ERROR =
  "You can only import public repositories owned by your GitHub account.";

type GitHubUserPayload = {
  id?: unknown;
  login?: unknown;
  avatar_url?: unknown;
};

type GitHubRepoPayload = {
  name?: unknown;
  full_name?: unknown;
  html_url?: unknown;
  default_branch?: unknown;
  pushed_at?: unknown;
  updated_at?: unknown;
  language?: unknown;
  fork?: unknown;
  archived?: unknown;
  disabled?: unknown;
  private?: unknown;
  visibility?: unknown;
  owner?: {
    id?: unknown;
    login?: unknown;
  };
};

type GitHubTreePayload = {
  tree?: unknown;
  truncated?: unknown;
};

type GitHubCodeSearchPayload = {
  items?: unknown;
};

type GitHubCodeSearchItemPayload = {
  path?: unknown;
  repository?: GitHubRepoPayload;
};

type GitHubTreeEntryPayload = {
  path?: unknown;
  type?: unknown;
  sha?: unknown;
  size?: unknown;
};

type GitHubIdentityForImport = {
  providerAccountId: string;
  login: string;
  avatarUrl: string | null;
};

type OwnedPublicRepoListItem = {
  owner: string;
  name: string;
  repoName: string;
  repoFullName: string;
  fullName: string;
  htmlUrl: string;
  defaultBranch: string | null;
  pushedAt: string | null;
  updatedAt: string | null;
  language: string | null;
  fork: boolean;
  archived: boolean;
  disabled: boolean;
  visibility: "public";
  importable: boolean;
  unavailableReason: string | null;
  candidatePath: string;
  skillPath: string;
};

export const listOwnedPublicGitHubRepos = action({
  args: {
    query: v.optional(v.string()),
    page: v.optional(v.number()),
    perPage: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireUserFromAction(ctx);
    return listOwnedPublicGitHubReposForUser(ctx, userId, args, fetch);
  },
});

export const previewGitHubImport = action({
  args: { url: v.string() },
  handler: async (ctx, args) => {
    const { userId } = await requireUserFromAction(ctx);
    return previewGitHubImportForUser(ctx, userId, args, fetch);
  },
});

async function previewGitHubImportForUser(
  ctx: Pick<ActionCtx, "runQuery">,
  userId: Id<"users">,
  args: { url: string },
  fetcher: typeof fetch,
) {
  const parsed = parseGitHubImportUrl(args.url);
  await requireOwnedPublicGitHubRepoForImport(ctx, userId, parsed.owner, parsed.repo, fetcher);
  const resolved = await resolveGitHubCommit(parsed, fetcher);
  const entries = await fetchResolvedGitHubEntries(resolved, fetcher);
  const candidates = detectGitHubImportCandidates(entries).filter((candidate) =>
    isCandidateUnderResolvedPath(candidate.path, resolved.path),
  );
  if (candidates.length === 0) throw new ConvexError("No SKILL.md or skills.md found in this repo");

  return {
    resolved,
    candidates: candidates.map((candidate) => ({
      path: candidate.path,
      readmePath: candidate.readmePath,
      name: candidate.name ?? null,
      description: candidate.description ?? null,
    })),
  };
}

export const previewGitHubImportCandidate = action({
  args: { url: v.string(), candidatePath: v.string() },
  handler: async (ctx, args) => {
    const { userId } = await requireUserFromAction(ctx);
    return previewGitHubImportCandidateForUser(ctx, userId, args, fetch);
  },
});

async function previewGitHubImportCandidateForUser(
  ctx: ActionCtx,
  userId: Id<"users">,
  args: { url: string; candidatePath: string },
  fetcher: typeof fetch,
) {
  const parsed = parseGitHubImportUrl(args.url);
  await requireOwnedPublicGitHubRepoForImport(ctx, userId, parsed.owner, parsed.repo, fetcher);
  const resolved = await resolveGitHubCommit(parsed, fetcher);
  const entries = await fetchResolvedGitHubEntries(resolved, fetcher);

  const normalizedCandidatePath = normalizeRepoPath(args.candidatePath);
  if (!isCandidateUnderResolvedPath(normalizedCandidatePath, resolved.path)) {
    throw new ConvexError("Candidate path is outside the requested import scope");
  }

  const candidates = detectGitHubImportCandidates(entries).filter((candidate) =>
    isCandidateUnderResolvedPath(candidate.path, resolved.path),
  );

  const candidate = candidates.find((item) => item.path === normalizedCandidatePath);
  if (!candidate) throw new ConvexError("Candidate not found");

  const files = listFilesUnderCandidate(entries, candidate.path);
  const defaultSelectedPaths = computeDefaultSelectedPaths({ candidate, files });
  const fileList = buildGitHubImportFileList({
    candidate,
    files,
    defaultSelectedPaths,
  });

  const baseForNaming = candidate.path ? (candidate.path.split("/").at(-1) ?? "") : resolved.repo;
  const suggestedDisplayName = suggestDisplayName(candidate, baseForNaming);

  const rawSlugBase = sanitizeSlug(candidate.path ? baseForNaming : resolved.repo);
  const suggestedSlug = await suggestAvailableSlug(ctx, userId, rawSlugBase);

  const existing = await ctx.runQuery(api.skills.getBySlug, { slug: suggestedSlug });
  const existingLatest =
    existing?.skill && existing.skill.ownerUserId === userId
      ? (existing.latestVersion?.version ?? null)
      : null;
  const suggestedVersion = suggestVersion(existingLatest);

  return {
    resolved,
    candidate: {
      path: candidate.path,
      readmePath: candidate.readmePath,
      name: candidate.name ?? null,
      description: candidate.description ?? null,
    },
    defaults: {
      selectedPaths: defaultSelectedPaths,
      slug: suggestedSlug,
      displayName: suggestedDisplayName,
      version: suggestedVersion,
      tags: ["latest"],
    },
    files: fileList,
  };
}

export const importGitHubSkill = action({
  args: {
    url: v.string(),
    commit: v.string(),
    candidatePath: v.string(),
    selectedPaths: v.array(v.string()),
    slug: v.optional(v.string()),
    ownerHandle: v.optional(v.string()),
    displayName: v.optional(v.string()),
    version: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    categories: v.optional(v.array(v.string())),
    topics: v.optional(v.array(v.string())),
    // Legacy cached clients may still send this; accept and ignore it.
    icon: v.optional(v.string()),
    acceptLicenseTerms: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireUserFromAction(ctx);
    return importGitHubSkillForUser(ctx, userId, args, fetch);
  },
});

async function importGitHubSkillForUser(
  ctx: ActionCtx,
  userId: Id<"users">,
  args: {
    url: string;
    commit: string;
    candidatePath: string;
    selectedPaths: string[];
    slug?: string;
    ownerHandle?: string;
    displayName?: string;
    version?: string;
    tags?: string[];
    categories?: string[];
    topics?: string[];
    icon?: string;
    acceptLicenseTerms: boolean;
  },
  fetcher: typeof fetch,
) {
  if (!args.acceptLicenseTerms) {
    throw new ConvexError("MIT-0 license terms must be accepted to publish skills");
  }

  const parsed = parseGitHubImportUrl(args.url);
  await requireOwnedPublicGitHubRepoForImport(ctx, userId, parsed.owner, parsed.repo, fetcher);
  const resolved = await resolveGitHubCommit(parsed, fetcher);
  if (!/^[a-f0-9]{40}$/i.test(args.commit)) throw new ConvexError("Invalid commit");
  if (args.commit.toLowerCase() !== resolved.commit.toLowerCase()) {
    throw new ConvexError("Import is out of date. Re-run preview.");
  }

  const normalizedCandidatePath = normalizeRepoPath(args.candidatePath);
  if (!isCandidateUnderResolvedPath(normalizedCandidatePath, resolved.path)) {
    throw new ConvexError("Candidate path is outside the requested import scope");
  }

  const entries = await fetchResolvedGitHubEntries(resolved, fetcher);

  const candidates = detectGitHubImportCandidates(entries).filter((candidate) =>
    isCandidateUnderResolvedPath(candidate.path, resolved.path),
  );
  const candidate = candidates.find((item) => item.path === normalizedCandidatePath);
  if (!candidate) throw new ConvexError("Candidate not found");

  const filesUnderCandidate = listFilesUnderCandidate(entries, candidate.path);
  const byPath = new Map(filesUnderCandidate.map((file) => [file.path, file.bytes]));

  const selected = Array.from(
    new Set(args.selectedPaths.map((path) => normalizeRepoPath(path)).filter(Boolean)),
  );
  if (selected.length === 0) throw new ConvexError("No files selected");

  const candidateRoot = candidate.path ? `${candidate.path}/` : "";
  const normalizedReadmePath = normalizeRepoPath(candidate.readmePath);
  if (!selected.includes(normalizedReadmePath)) {
    throw new ConvexError("The skill file must be selected");
  }

  const slugBase = (args.slug ?? "").trim().toLowerCase();
  const displayName = (args.displayName ?? "").trim();
  const tags = (args.tags ?? ["latest"]).map((tag) => tag.trim()).filter(Boolean);
  const version = (args.version ?? "").trim();

  if (!slugBase) throw new ConvexError("Slug required");
  const ownerHandle = args.ownerHandle?.trim().replace(/^@+/, "") || "";
  if (!ownerHandle) throw new ConvexError("Owner is required");
  if (!displayName) throw new ConvexError("Display name required");
  if (!version || !semver.valid(version)) throw new ConvexError("Version must be valid semver");

  const target = (await ctx.runMutation(internal.publishers.resolvePublishTargetForUserInternal, {
    actorUserId: userId,
    ownerHandle,
    minimumRole: "publisher",
  })) as { publisherId: Id<"publishers"> };

  const storedFiles: Array<{
    path: string;
    size: number;
    storageId: Id<"_storage">;
    sha256: string;
    contentType?: string;
  }> = [];

  try {
    let totalBytes = 0;
    for (const path of selected.sort()) {
      if (candidateRoot && !path.startsWith(candidateRoot)) {
        throw new ConvexError("Selected file is outside the chosen skill folder");
      }

      const bytes = byPath.get(path);
      if (!bytes) continue;
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_SELECTED_BYTES)
        throw new ConvexError("Selected files exceed 50MB limit");

      const relPath = candidateRoot ? path.slice(candidateRoot.length) : path;
      const sanitized = sanitizePath(relPath);
      if (!sanitized) throw new ConvexError("Invalid file paths");

      const sha256 = await sha256Hex(bytes);
      const safeBytes = new Uint8Array(bytes);
      let storageId: Id<"_storage">;
      try {
        storageId = await ctx.storage.store(
          new Blob([safeBytes], { type: "application/octet-stream" }),
        );
      } catch (error) {
        throw new ConvexError(buildStoreFailureMessage(sanitized, bytes.byteLength, error));
      }
      storedFiles.push({
        path: sanitized,
        size: bytes.byteLength,
        storageId,
        sha256,
        contentType: "application/octet-stream",
      });
    }

    if (storedFiles.length === 0) throw new ConvexError("No files selected");

    const sourceProvenance = {
      kind: "github" as const,
      url: resolved.originalUrl,
      repo: `${resolved.owner}/${resolved.repo}`,
      ref: resolved.ref,
      commit: resolved.commit,
      path: candidate.path,
      importedAt: Date.now(),
    };

    let result: Awaited<ReturnType<typeof publishVersionForUser>>;
    try {
      result = await publishVersionForUser(
        ctx,
        userId,
        {
          slug: slugBase,
          displayName,
          version,
          changelog: "",
          tags,
          categories: args.categories,
          topics: args.topics,
          files: storedFiles,
          source: sourceProvenance,
        },
        { ownerPublisherId: target.publisherId, sourceProvenance },
      );
    } catch (error) {
      throw new ConvexError(buildPublishFailureMessage(error));
    }

    return { ok: true, slug: slugBase, version, ...result };
  } catch (error) {
    await Promise.allSettled(storedFiles.map((file) => ctx.storage.delete(file.storageId)));
    throw error;
  }
}

async function listOwnedPublicGitHubReposForUser(
  ctx: Pick<ActionCtx, "runQuery">,
  userId: Id<"users">,
  args: { query?: string; page?: number; perPage?: number },
  fetcher: typeof fetch,
) {
  const identity = await requireCurrentGitHubIdentity(ctx, userId, fetcher);
  const page = clampInteger(args.page ?? 1, 1, 100);
  const perPage = clampInteger(args.perPage ?? 30, 1, 100);
  const query = normalizeRepoSearchQuery(args.query ?? "");

  if (hasGitHubApiToken()) {
    const searchResult = await listOwnedPublicSkillCandidatesWithCodeSearch(
      identity,
      { query, page, perPage },
      fetcher,
    );
    return {
      account: { login: identity.login, avatarUrl: identity.avatarUrl },
      page,
      perPage,
      ...searchResult,
    };
  }

  const fallbackPerPage = Math.min(perPage, MAX_FALLBACK_DISCOVERY_REPOS_PER_PAGE);
  const url = new URL(`${GITHUB_API}/users/${encodeURIComponent(identity.login)}/repos`);
  url.searchParams.set("type", "owner");
  url.searchParams.set("sort", "pushed");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("per_page", String(fallbackPerPage));
  url.searchParams.set("page", String(page));

  // Public repo discovery still benefits from the installation token's
  // higher rate limit. If the app cannot access this endpoint, fetchGitHubApi
  // retries with the configured token or anonymous public access.
  const response = await fetchGitHubApi(url.toString(), fetcher);
  if (!response.ok) throwGitHubApiError(response.status);

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) throw new ConvexError("GitHub repository lookup failed");

  const repos = payload
    .map((repo) => toOwnedPublicRepoListItem(repo as GitHubRepoPayload, identity))
    .filter((repo): repo is OwnedPublicRepoListItem => Boolean(repo))
    .filter((repo) => repo.importable);

  const skillCandidates: OwnedPublicRepoListItem[] = [];
  for (const repo of repos) {
    const candidates = await listSkillCandidatesForRepo(repo, fetcher);
    skillCandidates.push(...candidates);
  }

  const filteredSkillCandidates = skillCandidates.filter((repo) => {
    if (!query) return true;
    return (
      repo.name.toLowerCase().includes(query) ||
      repo.fullName.toLowerCase().includes(query) ||
      repo.candidatePath.toLowerCase().includes(query) ||
      repo.skillPath.toLowerCase().includes(query)
    );
  });

  return {
    account: { login: identity.login, avatarUrl: identity.avatarUrl },
    page,
    perPage: fallbackPerPage,
    hasMore: payload.length === fallbackPerPage,
    repos: filteredSkillCandidates,
  };
}

async function requireOwnedPublicGitHubRepoForImport(
  ctx: Pick<ActionCtx, "runQuery">,
  userId: Id<"users">,
  owner: string,
  repo: string,
  fetcher: typeof fetch,
) {
  const identity = await requireCurrentGitHubIdentity(ctx, userId, fetcher);
  if (owner.toLowerCase() !== identity.login.toLowerCase()) {
    throw new ConvexError(OWNED_PUBLIC_REPO_ONLY_ERROR);
  }

  const metadata = await fetchGitHubRepoMetadata(owner, repo, fetcher);
  assertOwnedPublicGitHubRepoMetadata(metadata, identity);
  if (metadata.archived === true) {
    throw new ConvexError("Archived GitHub repositories cannot be imported.");
  }
  if (metadata.disabled === true) {
    throw new ConvexError("Disabled GitHub repositories cannot be imported.");
  }
  if (metadata.fork === true) {
    throw new ConvexError("Forked GitHub repositories cannot be imported.");
  }
  return metadata;
}

async function requireCurrentGitHubIdentity(
  ctx: Pick<ActionCtx, "runQuery">,
  userId: Id<"users">,
  fetcher: typeof fetch,
): Promise<GitHubIdentityForImport> {
  const providerAccountId = await ctx.runQuery(
    internal.githubIdentity.getGitHubProviderAccountIdInternal,
    { userId },
  );
  if (!providerAccountId) throw new ConvexError("GitHub account required");
  assertGitHubNumericId(providerAccountId);

  const response = await fetchGitHubApi(`${GITHUB_API}/user/${providerAccountId}`, fetcher);
  if (!response.ok) throwGitHubApiError(response.status);

  const payload = (await response.json()) as GitHubUserPayload;
  const login = typeof payload.login === "string" ? payload.login.trim() : "";
  const avatarUrl = typeof payload.avatar_url === "string" ? payload.avatar_url.trim() : "";
  const payloadId = stringifyGitHubNumericId(payload.id);
  if (!login || payloadId !== providerAccountId) {
    throw new ConvexError("GitHub account lookup failed");
  }

  return { providerAccountId, login, avatarUrl: avatarUrl || null };
}

async function fetchGitHubRepoMetadata(owner: string, repo: string, fetcher: typeof fetch) {
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const response = await fetchGitHubApi(url, fetcher);
  if (!response.ok) {
    if (response.status === 404) throw new ConvexError(OWNED_PUBLIC_REPO_ONLY_ERROR);
    throwGitHubApiError(response.status);
  }
  return (await response.json()) as GitHubRepoPayload;
}

function assertOwnedPublicGitHubRepoMetadata(
  repo: GitHubRepoPayload,
  identity: GitHubIdentityForImport,
) {
  const ownerId = stringifyGitHubNumericId(repo.owner?.id);
  const ownerLogin = typeof repo.owner?.login === "string" ? repo.owner.login.trim() : "";
  const visibility = typeof repo.visibility === "string" ? repo.visibility : "";
  const isPublicVisibility = visibility ? visibility === "public" : true;
  if (
    repo.private !== false ||
    !isPublicVisibility ||
    ownerId !== identity.providerAccountId ||
    ownerLogin.toLowerCase() !== identity.login.toLowerCase()
  ) {
    throw new ConvexError(OWNED_PUBLIC_REPO_ONLY_ERROR);
  }
}

function stringifyGitHubNumericId(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value;
  return "";
}

function toOwnedPublicRepoListItem(
  repo: GitHubRepoPayload,
  identity: GitHubIdentityForImport,
): OwnedPublicRepoListItem | null {
  try {
    assertOwnedPublicGitHubRepoMetadata(repo, identity);
  } catch {
    return null;
  }

  const name = typeof repo.name === "string" ? repo.name.trim() : "";
  if (!name) return null;

  const owner = typeof repo.owner?.login === "string" ? repo.owner.login.trim() : identity.login;
  const fullName = typeof repo.full_name === "string" ? repo.full_name.trim() : `${owner}/${name}`;
  const archived = repo.archived === true;
  const disabled = repo.disabled === true;
  const fork = repo.fork === true;
  const unavailableReason = archived
    ? "Archived repositories cannot be imported."
    : disabled
      ? "Disabled repositories cannot be imported."
      : fork
        ? "Forked repositories cannot be imported."
        : null;

  return {
    owner,
    name,
    repoName: name,
    repoFullName: fullName,
    fullName,
    htmlUrl: typeof repo.html_url === "string" ? repo.html_url : `https://github.com/${fullName}`,
    defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : null,
    pushedAt: typeof repo.pushed_at === "string" ? repo.pushed_at : null,
    updatedAt: typeof repo.updated_at === "string" ? repo.updated_at : null,
    language: typeof repo.language === "string" ? repo.language : null,
    fork,
    archived,
    disabled,
    visibility: "public",
    importable: !archived && !disabled && !fork,
    unavailableReason,
    candidatePath: "",
    skillPath: "SKILL.md",
  };
}

async function listSkillCandidatesForRepo(repo: OwnedPublicRepoListItem, fetcher: typeof fetch) {
  if (!repo.defaultBranch) return [];

  const tree = await fetchGitHubRepoTreeResult(repo.owner, repo.name, repo.defaultBranch, fetcher);
  if (!tree) return [];
  if (tree.truncated) return listSkillCandidatesFromArchive(repo, fetcher);

  const skillPaths = tree.entries
    .map((entry) => normalizeSkillTreePath(entry))
    .filter((path): path is string => Boolean(path));

  return skillPaths.map((skillPath) => toOwnedPublicSkillCandidate(repo, skillPath));
}

async function listOwnedPublicSkillCandidatesWithCodeSearch(
  identity: GitHubIdentityForImport,
  args: { query: string; page: number; perPage: number },
  fetcher: typeof fetch,
) {
  const results = await Promise.all(
    ["SKILL.md", "skills.md"].map(async (filename) => {
      const url = new URL(`${GITHUB_API}/search/code`);
      const searchParts = [`filename:${filename}`, `user:${identity.login}`];
      if (args.query) searchParts.push(args.query);
      url.searchParams.set("q", searchParts.join(" "));
      url.searchParams.set("per_page", String(args.perPage));
      url.searchParams.set("page", String(args.page));

      const response = await fetchGitHubApi(url.toString(), fetcher, undefined, false);
      if (!response.ok) throwGitHubApiError(response.status);

      const payload = (await response.json()) as GitHubCodeSearchPayload;
      const items = Array.isArray(payload.items) ? payload.items : [];
      return { items, hasMore: items.length === args.perPage };
    }),
  );

  const candidates = dedupeOwnedPublicSkillCandidates(
    results
      .flatMap((result) => result.items)
      .map((item) => toOwnedPublicSkillCandidateFromSearchItem(item, identity))
      .filter((candidate): candidate is OwnedPublicRepoListItem => Boolean(candidate)),
  );

  return {
    hasMore: results.some((result) => result.hasMore),
    repos: candidates,
  };
}

function toOwnedPublicSkillCandidateFromSearchItem(
  item: unknown,
  identity: GitHubIdentityForImport,
) {
  const searchItem = item as GitHubCodeSearchItemPayload;
  const skillPath = normalizeSkillTreePath({ path: searchItem.path, type: "blob" });
  if (!skillPath || !searchItem.repository) return null;

  const repo = toOwnedPublicRepoListItem(searchItem.repository, identity);
  if (!repo?.importable) return null;
  return toOwnedPublicSkillCandidate(repo, skillPath);
}

async function listSkillCandidatesFromArchive(
  repo: OwnedPublicRepoListItem,
  fetcher: typeof fetch,
) {
  if (!repo.defaultBranch) return [];
  const zipBytes = await fetchGitHubZipBytes(
    {
      owner: repo.owner,
      repo: repo.name,
      ref: repo.defaultBranch,
      commit: repo.defaultBranch,
      path: "",
      repoUrl: repo.htmlUrl,
      originalUrl: repo.htmlUrl,
    },
    fetcher,
  );
  const entries = stripGitHubZipRoot(unzipToEntries(zipBytes));
  return detectGitHubImportCandidates(entries).map((candidate) =>
    toOwnedPublicSkillCandidate(repo, candidate.readmePath),
  );
}

async function fetchResolvedGitHubEntries(
  resolved: Awaited<ReturnType<typeof resolveGitHubCommit>>,
  fetcher: typeof fetch,
) {
  if (resolved.path) return fetchGitHubPathEntries(resolved, fetcher);

  const zipBytes = await fetchGitHubZipBytes(resolved, fetcher);
  return stripGitHubZipRoot(unzipToEntries(zipBytes));
}

async function fetchGitHubPathEntries(
  resolved: Awaited<ReturnType<typeof resolveGitHubCommit>>,
  fetcher: typeof fetch,
) {
  const tree = await fetchGitHubRepoTree(resolved.owner, resolved.repo, resolved.commit, fetcher);
  if (!tree) throw new ConvexError("GitHub tree is too large");

  const root = normalizeRepoPath(resolved.path);
  const prefix = `${root}/`;
  const blobEntries = tree
    .map((entry) => toImportableTreeBlob(entry, prefix))
    .filter((entry): entry is { path: string; sha: string; size: number } => Boolean(entry));

  if (blobEntries.length > MAX_FILE_COUNT) throw new ConvexError("Repo folder has too many files");

  const out: Record<string, Uint8Array> = {};
  let totalBytes = 0;
  for (const entry of blobEntries) {
    if (entry.size > MAX_SINGLE_FILE_BYTES) continue;
    const bytes = await fetchGitHubBlobBytes(resolved.owner, resolved.repo, entry.sha, fetcher);
    if (bytes.byteLength > MAX_SINGLE_FILE_BYTES) continue;
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_UNZIPPED_BYTES) throw new ConvexError("Repo folder is too large");
    out[entry.path] = bytes;
  }

  return out;
}

function toImportableTreeBlob(entry: GitHubTreeEntryPayload, prefix: string) {
  if (entry.type !== "blob" || typeof entry.path !== "string" || typeof entry.sha !== "string") {
    return null;
  }
  const path = normalizeRepoPath(entry.path);
  if (!path || !path.startsWith(prefix)) return null;
  if (isMacJunkPath(path)) return null;
  const size = typeof entry.size === "number" && Number.isFinite(entry.size) ? entry.size : 0;
  return { path, sha: entry.sha, size };
}

async function fetchGitHubBlobBytes(
  owner: string,
  repo: string,
  sha: string,
  fetcher: typeof fetch,
) {
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(sha)}`;
  const response = await fetchGitHubApi(url, fetcher, "application/vnd.github.raw");
  if (!response.ok) throwGitHubApiError(response.status);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchGitHubRepoTree(
  owner: string,
  repo: string,
  defaultBranch: string,
  fetcher: typeof fetch,
): Promise<GitHubTreeEntryPayload[] | null> {
  const result = await fetchGitHubRepoTreeResult(owner, repo, defaultBranch, fetcher);
  if (!result || result.truncated) return null;
  return result.entries;
}

async function fetchGitHubRepoTreeResult(
  owner: string,
  repo: string,
  defaultBranch: string,
  fetcher: typeof fetch,
): Promise<{ entries: GitHubTreeEntryPayload[]; truncated: boolean } | null> {
  const url = new URL(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(defaultBranch)}`,
  );
  url.searchParams.set("recursive", "1");

  const response = await fetchGitHubApi(url.toString(), fetcher);
  if (response.status === 404 || response.status === 409) return null;
  if (!response.ok) throwGitHubApiError(response.status);

  const payload = (await response.json()) as GitHubTreePayload;
  if (!Array.isArray(payload.tree)) return null;

  return {
    entries: payload.tree as GitHubTreeEntryPayload[],
    truncated: payload.truncated === true,
  };
}

function normalizeSkillTreePath(entry: GitHubTreeEntryPayload) {
  if (entry.type !== "blob" || typeof entry.path !== "string") return null;
  const path = normalizeRepoPath(entry.path);
  if (!path) return null;
  if (path.split("/").some((segment) => segment.startsWith("."))) return null;
  return isGitHubSkillFilePath(path) ? path : null;
}

function dedupeOwnedPublicSkillCandidates(candidates: OwnedPublicRepoListItem[]) {
  const seen = new Set<string>();
  const out: OwnedPublicRepoListItem[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.repoFullName.toLowerCase()}::${candidate.skillPath.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function toOwnedPublicSkillCandidate(repo: OwnedPublicRepoListItem, skillPath: string) {
  const candidatePath = skillPath.split("/").slice(0, -1).join("/");
  const candidateName = candidatePath ? (candidatePath.split("/").at(-1) ?? repo.name) : repo.name;
  const htmlUrl = candidatePath
    ? `${repo.htmlUrl}/tree/${encodeURIComponent(repo.defaultBranch ?? "HEAD")}/${candidatePath
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`
    : repo.htmlUrl;

  return {
    ...repo,
    name: candidateName,
    repoName: repo.repoName,
    repoFullName: repo.repoFullName,
    fullName: candidatePath ? `${repo.fullName}/${candidatePath}` : repo.fullName,
    htmlUrl,
    candidatePath,
    skillPath,
  };
}

async function fetchGitHubApi(
  url: string,
  fetcher: typeof fetch,
  accept = "application/vnd.github+json",
  useGitHubApp = true,
) {
  const headers = await buildGitHubApiHeaders({
    userAgent: "clawhub/github-import",
    accept,
    fetchImpl: fetcher,
    useGitHubApp,
  });
  const response = await fetcher(url, { headers });
  if (
    useGitHubApp &&
    !response.ok &&
    isGitHubAppConfigured() &&
    headers.Authorization &&
    (response.status === 401 || response.status === 403 || response.status === 404)
  ) {
    const fallbackHeaders = await buildGitHubApiHeaders({
      userAgent: "clawhub/github-import",
      accept,
      fetchImpl: fetcher,
      useGitHubApp: false,
    });
    if (fallbackHeaders.Authorization !== headers.Authorization) {
      return await fetcher(url, { headers: fallbackHeaders });
    }
  }
  return response;
}

function hasGitHubApiToken() {
  return Boolean(process.env.GITHUB_TOKEN?.trim());
}

function assertGitHubNumericId(providerAccountId: string) {
  if (!/^[0-9]+$/.test(providerAccountId)) {
    throw new ConvexError("GitHub account lookup failed");
  }
}

function throwGitHubApiError(status: number): never {
  if (status === 403 || status === 429) {
    throw new ConvexError("GitHub API rate limit exceeded — please try again in a few minutes");
  }
  throw new ConvexError("GitHub account lookup failed");
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function normalizeRepoSearchQuery(query: string) {
  return query.trim().toLowerCase();
}

function unzipToEntries(zipBytes: Uint8Array) {
  const entries = unzipSync(zipBytes);
  const out: Record<string, Uint8Array> = {};
  const rawPaths = Object.keys(entries);
  if (rawPaths.length > MAX_FILE_COUNT) throw new ConvexError("Repo archive has too many files");
  let totalBytes = 0;
  for (const [rawPath, bytes] of Object.entries(entries)) {
    const normalizedPath = normalizeZipPath(rawPath);
    if (!normalizedPath) continue;
    if (isMacJunkPath(normalizedPath)) continue;
    if (!bytes) continue;
    if (bytes.byteLength > MAX_SINGLE_FILE_BYTES) continue;
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_UNZIPPED_BYTES) throw new ConvexError("Repo archive is too large");
    out[normalizedPath] = bytes;
  }
  return out;
}

function isCandidateUnderResolvedPath(candidatePath: string, resolvedPath: string) {
  const root = normalizeRepoPath(resolvedPath);
  if (!root) return true;
  if (!candidatePath) return false;
  if (candidatePath === root) return true;
  return candidatePath.startsWith(`${root}/`);
}

function sanitizeSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .replace(/--+/g, "-");
}

async function suggestAvailableSlug(ctx: ActionCtx, userId: Id<"users">, base: string) {
  const cleaned = sanitizeSlug(base);
  if (!cleaned) throw new ConvexError("Could not derive slug");
  for (let i = 0; i < 50; i += 1) {
    const candidate = i === 0 ? cleaned : `${cleaned}-${i + 1}`;
    const existing = await ctx.runQuery(internal.skills.getSkillBySlugInternal, {
      slug: candidate,
    });
    if (!existing) return candidate;
    if (existing.ownerUserId === userId) return candidate;
  }
  throw new ConvexError("Could not find an available slug");
}

async function sha256Hex(bytes: Uint8Array) {
  const normalized = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", normalized.buffer);
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function normalizeZipPath(path: string) {
  const normalized = path
    .replaceAll("\u0000", "")
    .replaceAll("\\", "/")
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
  if (!normalized) return "";
  if (normalized.includes("..")) return "";
  return normalized;
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function toUserFacingErrorMessage(error: unknown) {
  return toErrorMessage(error)
    .replace(/^Uncaught ConvexError:\s*/, "")
    .split(/\s+at\s+/)[0]
    .trim();
}

function buildStoreFailureMessage(path: string, sizeBytes: number, error: unknown) {
  return `Failed to store file "${path}" (${sizeBytes} bytes). ${toErrorMessage(error)}`;
}

function buildPublishFailureMessage(error: unknown) {
  return `Import failed during publish: ${toUserFacingErrorMessage(error)}. Check skill format, slug availability, and try again.`;
}

export const __test = {
  assertOwnedPublicGitHubRepoMetadata,
  buildPublishFailureMessage,
  buildStoreFailureMessage,
  importGitHubSkillForUser,
  listOwnedPublicGitHubReposForUser,
  listSkillCandidatesForRepo,
  previewGitHubImportCandidateForUser,
  previewGitHubImportForUser,
  requireOwnedPublicGitHubRepoForImport,
  toOwnedPublicSkillCandidate,
  toOwnedPublicRepoListItem,
  unzipToEntries,
};
