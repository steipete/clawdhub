import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import semver from "semver";
import { apiRequest, downloadZip, fetchBinary, registryUrl } from "../../http.js";
import {
  ApiRoutes,
  ApiV1SkillInstallResolveResponseSchema,
  ApiV1SearchResponseSchema,
  ApiV1SkillListResponseSchema,
  ApiV1SkillReportListResponseSchema,
  ApiV1SkillReportResponseSchema,
  ApiV1SkillReportTriageResponseSchema,
  ApiV1SkillResolveResponseSchema,
  ApiV1SkillResponseSchema,
  ApiV1SkillVersionResponseSchema,
  type ApiV1SkillInstallResolveResponse,
  type Lockfile,
  type SkillReportFinalAction,
  type SkillReportListStatus,
  type SkillReportStatus,
} from "../../schema/index.js";
import {
  buildGitHubFolderContentHash,
  extractGitHubZipPathToDir,
  extractZipToDir,
  hashSkillFiles,
  listManualSkills,
  listSkillFiles,
  readLockfile,
  readSkillOrigin,
  writeLockfile,
  writeSkillOrigin,
} from "../../skills.js";
import { getOptionalAuthToken, requireAuthToken } from "../authToken.js";
import { getRegistry } from "../registry.js";
import {
  parseSkillsShCliReference,
  parseStoredSkillsShReference,
  SKILLS_SH_SCANNED_LABEL,
  SKILLS_SH_UNSCANNED_LABEL,
  type SkillsShReference,
} from "../skillReference.js";
import type { GlobalOpts, ResolveResult } from "../types.js";
import {
  createCrabLoader,
  fail,
  formatError,
  isInteractive,
  promptConfirm,
  styleText,
} from "../ui.js";
import { reportInstalledSkillsTelemetryIfEnabled } from "./installTelemetry.js";
import { presentModerationPlan, reportModerationPlan } from "./moderationPlan.js";

type SkillReportOptions = {
  version?: string;
  reason?: string;
  json?: boolean;
};

type SkillReportListOptions = {
  status?: SkillReportListStatus;
  cursor?: string;
  limit?: number;
  json?: boolean;
};

type SkillReportTriageOptions = {
  status?: SkillReportStatus;
  action?: SkillReportFinalAction;
  finalAction?: SkillReportFinalAction;
  note?: string;
  json?: boolean;
  yes?: boolean;
};

type SkillSearchOptions = {
  limit?: number;
  prefix?: boolean;
  exact?: boolean;
  cursor?: string;
};

type SkillRef = {
  slug: string;
  ownerHandle?: string;
  sourceRef?: string;
  skillsSh?: SkillsShReference;
};

function normalizeOwnerHandle(raw: string | null | undefined) {
  const handle = raw?.trim().replace(/^@+/, "").toLowerCase();
  if (!handle) return undefined;
  if (handle.includes("/") || handle.includes("\\") || handle.includes("..")) {
    fail(`Invalid owner handle: ${raw}`);
  }
  return handle;
}

type GitHubInstallResolution = Extract<
  ApiV1SkillInstallResolveResponse,
  { ok: true; installKind: "github" }
>;
type SuccessfulInstallResolution = Extract<ApiV1SkillInstallResolveResponse, { ok: true }>;

type SkillsShState = {
  sourceRef: string;
  sourceKind: "skills-sh";
  sourceRepository?: string;
  sourcePath?: string;
  sourceUrl?: string;
  canonicalRef?: string;
  clawhubScan: "unscanned" | "scanned";
  trustLabel: string;
};

function normalizeSkillSlugOrFail(raw: string) {
  const slug = raw.trim();
  if (!slug) fail("Slug required");
  // Safety: never allow path traversal or nested paths to become filesystem operations.
  if (slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    fail(`Invalid slug: ${slug}`);
  }
  return slug;
}

function normalizeSkillSlugForRemote(raw: unknown) {
  if (typeof raw !== "string") return undefined;
  const slug = raw.trim();
  if (!isSafeSkillSlug(slug)) return undefined;
  return slug;
}

function parseSkillRefOrFail(raw: string): SkillRef {
  const ref = raw.trim();
  if (!ref) fail("Slug required");
  const skillsSh = parseSkillsShCliReference(ref);
  if (skillsSh) return { slug: skillsSh.slug, sourceRef: skillsSh.sourceRef, skillsSh };
  const slashIndex = ref.indexOf("/");
  if (slashIndex < 0) {
    return { slug: normalizeSkillSlugOrFail(ref) };
  }
  if (ref.indexOf("/", slashIndex + 1) >= 0) {
    fail(`Invalid skill ref: ${ref}`);
  }
  const rawOwnerHandle = ref.slice(0, slashIndex);
  if (rawOwnerHandle.includes("\\") || rawOwnerHandle.includes("..")) {
    fail(`Invalid slug: ${ref}`);
  }
  const ownerHandle = normalizeOwnerHandle(rawOwnerHandle);
  const slug = normalizeSkillSlugOrFail(ref.slice(slashIndex + 1));
  if (!ownerHandle) fail(`Invalid skill ref: ${ref}`);
  return { slug, ownerHandle };
}

function parseStoredSkillRefOrFail(raw: string): SkillRef {
  const skillsSh = parseStoredSkillsShReference(raw);
  if (skillsSh) return { slug: skillsSh.slug, sourceRef: skillsSh.sourceRef, skillsSh };
  return parseSkillRefOrFail(raw);
}

function isSafeSkillSlug(slug: string) {
  return Boolean(slug) && !slug.includes("/") && !slug.includes("\\") && !slug.includes("..");
}

function skillIdentity(ref: SkillRef) {
  if (ref.sourceRef) return ref.sourceRef;
  return ref.ownerHandle ? `@${ref.ownerHandle}/${ref.slug}` : ref.slug;
}

function skillTarget(dir: string, ref: SkillRef) {
  if (ref.sourceRef) return join(dir, ref.slug);
  return ref.ownerHandle ? join(dir, `@${ref.ownerHandle}`, ref.slug) : join(dir, ref.slug);
}

function isSafeSkillIdentity(value: string) {
  try {
    if (parseStoredSkillsShReference(value)) return true;
  } catch {
    return false;
  }
  const slashIndex = value.indexOf("/");
  if (slashIndex < 0) return isSafeSkillSlug(value);
  if (value.indexOf("/", slashIndex + 1) >= 0) return false;
  const ownerHandle = value.slice(0, slashIndex).replace(/^@+/, "");
  const slug = value.slice(slashIndex + 1);
  return Boolean(ownerHandle) && isSafeSkillSlug(ownerHandle) && isSafeSkillSlug(slug);
}

function findExistingLockKey(
  lock: { skills: Record<string, { ownerHandle?: string; sourceRef?: string }> },
  ref: SkillRef,
) {
  const key = skillIdentity(ref);
  if (lock.skills[key]) return key;
  if (ref.sourceRef) {
    for (const [candidateKey, entry] of Object.entries(lock.skills)) {
      const candidate = entry.sourceRef ?? candidateKey;
      try {
        if (parseStoredSkillsShReference(candidate)?.sourceRef === ref.sourceRef) {
          return candidateKey;
        }
      } catch {
        continue;
      }
    }
    return key;
  }
  if (ref.ownerHandle) {
    const legacyEntry = lock.skills[ref.slug];
    if (legacyEntry && normalizeOwnerHandle(legacyEntry.ownerHandle) === ref.ownerHandle) {
      return ref.slug;
    }
  }
  return key;
}

function replaceLockEntry(
  lock: Lockfile,
  previousKey: string,
  canonicalKey: string,
  entry: Lockfile["skills"][string],
) {
  if (previousKey !== canonicalKey) delete lock.skills[previousKey];
  lock.skills[canonicalKey] = entry;
}

function ownerScopedUrl(registry: string, path: string, ownerHandle?: string) {
  if (!ownerHandle) return null;
  const url = registryUrl(path, registry);
  url.searchParams.set("ownerHandle", ownerHandle);
  return url.toString();
}

function skillRequestArgs(
  registry: string,
  slug: string,
  ownerHandle: string | undefined,
  token: string | undefined,
) {
  const path = `${ApiRoutes.skills}/${encodeURIComponent(slug)}`;
  const url = ownerScopedUrl(registry, path, ownerHandle);
  return url ? { method: "GET" as const, url, token } : { method: "GET" as const, path, token };
}

function skillVersionRequestArgs(
  registry: string,
  slug: string,
  version: string,
  ownerHandle: string | undefined,
  token: string | undefined,
) {
  const path = `${ApiRoutes.skills}/${encodeURIComponent(slug)}/versions/${encodeURIComponent(
    version,
  )}`;
  const url = ownerScopedUrl(registry, path, ownerHandle);
  return url ? { method: "GET" as const, url, token } : { method: "GET" as const, path, token };
}

function withOwnerMetadata(
  version: string | null,
  installedAt: number,
  ownerHandle: string | undefined,
  existing?: { pinned?: boolean; pinReason?: string; ownerHandle?: string },
) {
  return {
    ...withPinnedMetadata(version, installedAt, existing),
    ...(ownerHandle ? { ownerHandle } : {}),
  };
}

function isPinnedSkillEntry(entry?: { pinned?: boolean | null }) {
  return entry?.pinned === true;
}

function withPinnedMetadata(
  version: string | null,
  installedAt: number,
  existing?: { pinned?: boolean; pinReason?: string },
) {
  return {
    version,
    installedAt,
    ...(existing?.pinned ? { pinned: true } : {}),
    ...(existing?.pinned && existing.pinReason ? { pinReason: existing.pinReason } : {}),
  };
}

function formatPinnedDetails(entry?: { pinReason?: string }) {
  return entry?.pinReason ? ` (${entry.pinReason})` : "";
}

function formatSearchOwner(entry: {
  ownerHandle?: string | null;
  owner?: { handle?: string | null; displayName?: string | null } | null;
  publisher?: { handle?: string | null; displayName?: string | null } | null;
  sourceIdentity?: { owner?: string | null; host?: string | null };
}) {
  const handle =
    entry.publisher?.handle ??
    entry.ownerHandle ??
    entry.owner?.handle ??
    entry.sourceIdentity?.owner ??
    entry.sourceIdentity?.host;
  if (handle) return `@${handle}`;
  return entry.publisher?.displayName ?? entry.owner?.displayName ?? "unknown owner";
}

export async function cmdSearch(
  opts: GlobalOpts,
  query: string,
  options: number | SkillSearchOptions = {},
) {
  if (!query) fail("Query required");
  const searchOptions = typeof options === "number" ? { limit: options } : options;
  if (searchOptions.prefix && searchOptions.exact) {
    fail("Choose either --prefix or --exact, not both");
  }
  if (searchOptions.cursor && !searchOptions.prefix) {
    fail("--cursor requires --prefix");
  }

  const token = await getOptionalAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const spinner = createCrabLoader("Searching");
  try {
    const effectiveLimit =
      typeof searchOptions.limit === "number" && Number.isFinite(searchOptions.limit)
        ? searchOptions.limit
        : 25;
    if (searchOptions.prefix) {
      const url = registryUrl(ApiRoutes.skills, registry);
      url.searchParams.set("prefix", query);
      url.searchParams.set("limit", String(effectiveLimit));
      if (searchOptions.cursor?.trim()) url.searchParams.set("cursor", searchOptions.cursor.trim());
      const result = await apiRequest(
        registry,
        { method: "GET", url: url.toString(), token },
        ApiV1SkillListResponseSchema,
      );

      spinner.stop();
      if (result.items.length === 0) console.log("No skills found.");
      for (const item of result.items) console.log(formatExploreLine(item));
      if (result.nextCursor) console.log(`Next cursor: ${result.nextCursor}`);
      return;
    }

    const url = registryUrl(ApiRoutes.search, registry);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(effectiveLimit));
    if (searchOptions.exact) url.searchParams.set("mode", "exact");
    const result = await apiRequest(
      registry,
      { method: "GET", url: url.toString(), token },
      ApiV1SearchResponseSchema,
    );

    spinner.stop();
    const rows = result.results.map((entry) => {
      const slug = entry.slug ?? "unknown";
      return {
        slug:
          entry.source === "skills-sh" && entry.install?.reference
            ? entry.install.reference
            : entry.version
              ? `${slug} v${entry.version}`
              : slug,
        owner: formatSearchOwner(entry),
        name: entry.displayName ?? slug,
        metric: formatSearchMetric(entry),
      };
    });
    const slugWidth = maxColumnWidth(rows.map((row) => row.slug));
    const ownerWidth = maxColumnWidth(rows.map((row) => row.owner));
    const nameWidth = maxColumnWidth(rows.map((row) => row.name));
    for (const row of rows) {
      console.log(
        `${styleText(row.slug.padEnd(slugWidth), "brand")}  ${styleText(
          row.owner.padEnd(ownerWidth),
          "muted",
        )}  ${styleText(row.name.padEnd(nameWidth), "strong")}  ${styleText(row.metric, "muted")}`,
      );
    }
  } catch (error) {
    spinner.fail(formatError(error));
    throw error;
  }
}

function maxColumnWidth(values: string[]) {
  return values.reduce((max, value) => Math.max(max, value.length), 0);
}

function formatSearchMetric(entry: {
  downloads?: number;
  score: number;
  metrics?: { rolling60DayInstalls?: number | null };
  sourceIdentity?: { lifetimeInstalls?: number | null };
}) {
  if (typeof entry.metrics?.rolling60DayInstalls === "number") {
    const value = new Intl.NumberFormat("en-US").format(entry.metrics.rolling60DayInstalls);
    return `${value} installs / 60d`;
  }
  if (typeof entry.sourceIdentity?.lifetimeInstalls === "number") {
    const value = new Intl.NumberFormat("en-US").format(entry.sourceIdentity.lifetimeInstalls);
    return `${value} skills.sh lifetime installs`;
  }
  if (typeof entry.downloads === "number") {
    const value = new Intl.NumberFormat("en-US").format(entry.downloads);
    return `${value} ${entry.downloads === 1 ? "download" : "downloads"}`;
  }
  return `score ${entry.score.toFixed(3)}`;
}

export async function cmdInstall(
  opts: GlobalOpts,
  slug: string,
  versionFlag?: string,
  force = false,
  forceInstall = false,
) {
  const requested = parseSkillRefOrFail(slug);
  const trimmed = requested.slug;
  if (requested.sourceRef && versionFlag) {
    fail("--version is not supported for skills.sh catalog references");
  }

  const token = await getOptionalAuthToken();

  const registry = await getRegistry(opts, { cache: true });
  await mkdir(opts.dir, { recursive: true });
  const lock = await readLockfile(opts.workdir);
  const lockKey = findExistingLockKey(lock, requested);
  const localRef =
    requested.sourceRef || lockKey === skillIdentity(requested)
      ? requested
      : parseStoredSkillRefOrFail(lockKey);
  const target = skillTarget(opts.dir, localRef);
  const targetExists = await fileExists(target);
  const existingOrigin = requested.sourceRef && targetExists ? await readSkillOrigin(target) : null;
  if (requested.sourceRef) {
    assertSkillsShTargetOwnership({
      dir: opts.dir,
      lock,
      lockKey,
      requested,
      target,
      targetExists,
      existingOrigin,
    });
  }
  if (!force && targetExists) {
    fail(`Already installed: ${target} (use --force)`);
  }

  const existingEntry = lock.skills[lockKey];
  if (isPinnedSkillEntry(existingEntry)) {
    fail(
      `skill "${skillIdentity(localRef)}" is pinned; run \`clawhub unpin ${skillIdentity(localRef)}\` first`,
    );
  }

  const spinner = createCrabLoader(`Resolving ${trimmed}`);
  try {
    if (requested.sourceRef && requested.skillsSh) {
      const { resolution: resolvedInstall, state } = await resolveSkillsShCatalogInstall(
        registry,
        requested,
        token,
      );
      const resolvedVersion = getInstallResolutionVersion(resolvedInstall);
      const artifactIdentity = getInstallResolutionArtifactIdentity(
        resolvedInstall,
        state.canonicalRef,
      );
      spinner.text = `Downloading ${trimmed} ${formatInstallResolutionVersion(resolvedInstall)}`;
      await installSkillWithOptionalStaging(target, targetExists, (installTarget) =>
        installSkillsShResolution(
          registry,
          resolvedInstall,
          state.canonicalRef,
          installTarget,
          token,
        ),
      );
      const installedFiles = await listSkillFiles(target);
      const installedFingerprint =
        installedFiles.length > 0 ? hashSkillFiles(installedFiles).fingerprint : undefined;
      const installedAt = Date.now();
      await writeSkillOrigin(target, {
        version: 1,
        registry,
        slug: trimmed,
        ...state,
        artifactIdentity,
        installedVersion: resolvedVersion,
        installedAt,
        fingerprint: installedFingerprint,
      });
      replaceLockEntry(lock, lockKey, requested.sourceRef, {
        ...withPinnedMetadata(resolvedVersion, installedAt, existingEntry),
        ...state,
      });
      await writeLockfile(opts.workdir, lock);
      await reportInstalledSkillsTelemetryIfEnabled({
        token,
        registry,
        slug: trimmed,
        ...state,
        version: resolvedVersion,
      });
      spinner.succeed(
        `${styleText("Installed", "brand")} ${styleText(
          requested.sourceRef,
          "strong",
        )} ${styleText(formatInstallResolutionVersion(resolvedInstall), "muted")} -> ${styleText(
          target,
          "muted",
        )} (${state.trustLabel})`,
      );
      return;
    }

    // Fetch skill metadata including moderation status
    const skillMeta = await apiRequest(
      registry,
      skillRequestArgs(registry, trimmed, requested.ownerHandle, token),
      ApiV1SkillResponseSchema,
    );
    const resolvedOwnerHandle = normalizeOwnerHandle(
      requested.ownerHandle ?? skillMeta.owner?.handle,
    );
    const canonicalOwnerHandle =
      normalizeOwnerHandle(skillMeta.owner?.handle) ?? resolvedOwnerHandle;
    const resolvedSlug = normalizeSkillSlugForRemote(skillMeta.skill?.slug) ?? trimmed;
    const remoteSlug = requested.ownerHandle ? trimmed : resolvedSlug;

    // Check moderation status before proceeding
    if (skillMeta.moderation?.isMalwareBlocked) {
      spinner.fail(`Blocked: ${trimmed} is flagged as malicious`);
      fail("This skill has been flagged as malware and cannot be installed.");
    }

    if (skillMeta.moderation?.isSuspicious && !force) {
      spinner.stop();
      console.log(
        `\n⚠️  Warning: "${trimmed}" is flagged for ClawHub security review.\n` +
          "   This skill may contain risky patterns (crypto keys, external APIs, eval, etc.)\n" +
          "   Review the skill code before use.\n",
      );
      if (isInteractive()) {
        const confirm = await promptConfirm("Install anyway?");
        if (!confirm) fail("Installation cancelled");
        spinner.start(`Resolving ${trimmed}`);
      } else {
        fail("Use --force to install suspicious skills in non-interactive mode");
      }
    }

    let resolvedVersion = versionFlag ?? skillMeta.latestVersion?.version ?? null;
    let githubInstall: GitHubInstallResolution | null = null;
    if (!resolvedVersion && !versionFlag) {
      const resolvedInstall = await resolveLatestSkillInstall(
        registry,
        remoteSlug,
        resolvedOwnerHandle,
        token,
        { forceInstall },
      );
      if (!resolvedInstall.ok) fail(resolvedInstall.message);
      if (resolvedInstall.installKind === "github") {
        githubInstall = resolvedInstall;
      } else {
        resolvedVersion = resolvedInstall.archive.version;
      }
    }
    if (!resolvedVersion && !githubInstall) fail("Could not resolve latest version");

    if (versionFlag) {
      await apiRequest(
        registry,
        skillVersionRequestArgs(registry, remoteSlug, versionFlag, resolvedOwnerHandle, token),
        ApiV1SkillVersionResponseSchema,
      );
    }

    if (githubInstall) {
      spinner.text = `Downloading ${trimmed} ${formatGitHubVersion(githubInstall.github.commit)}`;
      await installSkillWithOptionalStaging(target, targetExists, (installTarget) =>
        installGitHubSkill(registry, githubInstall, installTarget),
      );
      resolvedVersion = githubInstall.github.commit;
    } else {
      const archiveVersion = resolvedVersion;
      if (!archiveVersion) fail("Could not resolve latest version");
      spinner.text = `Downloading ${trimmed} v${archiveVersion}`;
      await installSkillWithOptionalStaging(target, targetExists, async (installTarget) => {
        const zip = await downloadZip(registry, {
          slug: remoteSlug,
          ...(resolvedOwnerHandle ? { ownerHandle: resolvedOwnerHandle } : {}),
          version: archiveVersion,
          token,
        });
        await extractZipToDir(zip, installTarget);
      });
    }
    const installedFiles = await listSkillFiles(target);
    const installedFingerprint =
      installedFiles.length > 0 ? hashSkillFiles(installedFiles).fingerprint : undefined;

    const installedAt = Date.now();
    await writeSkillOrigin(target, {
      version: 1,
      registry,
      slug: remoteSlug,
      ...(resolvedOwnerHandle ? { ownerHandle: resolvedOwnerHandle } : {}),
      installedVersion: resolvedVersion!,
      installedAt,
      fingerprint: installedFingerprint,
    });

    lock.skills[lockKey] = withOwnerMetadata(
      resolvedVersion!,
      installedAt,
      resolvedOwnerHandle,
      existingEntry,
    );
    await writeLockfile(opts.workdir, lock);
    await reportInstalledSkillsTelemetryIfEnabled({
      token,
      registry,
      slug: skillMeta.skill?.slug ?? trimmed,
      ownerHandle: canonicalOwnerHandle,
      version: resolvedVersion,
    });
    spinner.succeed(
      `${styleText("Installed", "brand")} ${styleText(trimmed, "strong")} ${styleText(
        githubInstall ? formatGitHubVersion(resolvedVersion!) : `v${resolvedVersion}`,
        "muted",
      )} -> ${styleText(target, "muted")}`,
    );
  } catch (error) {
    spinner.fail(formatError(error));
    throw error;
  }
}

export async function cmdUpdate(
  opts: GlobalOpts,
  slugArg: string | undefined,
  options: { all?: boolean; version?: string; force?: boolean; forceInstall?: boolean },
  inputAllowed: boolean,
) {
  const requestedRef = slugArg ? parseSkillRefOrFail(slugArg) : null;
  const slug = requestedRef?.slug;
  const all = Boolean(options.all);
  if (!slug && !all) fail("Provide <skill> or --all");
  if (slug && all) fail("Use either <skill> or --all");
  if (options.version && !slug) fail("--version requires a single <skill>");
  if (options.version && !semver.valid(options.version)) fail("--version must be valid semver");
  if (requestedRef?.sourceRef && options.version) {
    fail("--version is not supported for skills.sh catalog references");
  }
  const lock = await readLockfile(opts.workdir);
  const requestedLockKey = requestedRef ? findExistingLockKey(lock, requestedRef) : undefined;
  if (requestedLockKey && isPinnedSkillEntry(lock.skills[requestedLockKey])) {
    fail(
      `skill "${skillIdentity(requestedRef!)}" is pinned; run \`clawhub unpin ${skillIdentity(requestedRef!)}\` first`,
    );
  }
  const allowPrompt = isInteractive() && inputAllowed;

  const token = await getOptionalAuthToken();

  const registry = await getRegistry(opts, { cache: true });
  const requestedSlugs = slug
    ? [requestedLockKey ?? skillIdentity(requestedRef!)]
    : Object.keys(lock.skills).filter(isSafeSkillIdentity);
  const skippedPinned = slug
    ? []
    : requestedSlugs.filter((entry) => isPinnedSkillEntry(lock.skills[entry]));
  const slugs = slug
    ? requestedSlugs
    : requestedSlugs.filter((entry) => !isPinnedSkillEntry(lock.skills[entry]));
  if (slugs.length === 0) {
    if (skippedPinned.length > 0) {
      const suffix = skippedPinned.length === 1 ? "" : "s";
      console.log(
        `Skipped ${skippedPinned.length} pinned skill${suffix}: ${skippedPinned.join(", ")}`,
      );
      return;
    }
    console.log("No installed skills.");
    return;
  }

  let lockDirty = false;
  const markLockDirty = () => {
    lockDirty = true;
  };
  const flushLockfile = async () => {
    if (!lockDirty) return;
    await writeLockfile(opts.workdir, lock);
    lockDirty = false;
  };

  for (const entry of slugs) {
    const entryLock = lock.skills[entry];
    const entryRef = parseStoredSkillRefOrFail(entryLock?.sourceRef ?? entry);
    const spinner = createCrabLoader(`Checking ${entry}`);
    try {
      const target = skillTarget(opts.dir, entryRef);
      const exists = await fileExists(target);
      const existingOrigin = exists ? await readSkillOrigin(target) : null;
      if (entryRef.sourceRef && entryRef.skillsSh) {
        assertSkillsShTargetOwnership({
          dir: opts.dir,
          lock,
          lockKey: entry,
          requested: entryRef,
          target,
          targetExists: exists,
          existingOrigin,
        });
        const filesOnDisk = exists ? await listSkillFiles(target) : [];
        const localFingerprint =
          filesOnDisk.length > 0 ? hashSkillFiles(filesOnDisk).fingerprint : null;
        const { resolution: latestInstall, state } = await resolveSkillsShCatalogInstall(
          registry,
          entryRef,
          token,
        );
        const targetVersion = getInstallResolutionVersion(latestInstall);
        const targetArtifactIdentity = getInstallResolutionArtifactIdentity(
          latestInstall,
          state.canonicalRef,
        );
        const originFingerprint = sameSkillsShSource(existingOrigin?.sourceRef, entryRef.sourceRef)
          ? existingOrigin?.fingerprint
          : undefined;
        const hasLocalChanges = Boolean(
          exists &&
          localFingerprint &&
          (!originFingerprint || originFingerprint !== localFingerprint),
        );
        const matched =
          sameSkillsShSource(existingOrigin?.sourceRef, entryRef.sourceRef) &&
          originFingerprint &&
          localFingerprint &&
          originFingerprint === localFingerprint
            ? existingOrigin?.installedVersion
            : null;

        if (hasLocalChanges && !options.force) {
          spinner.stop();
          if (!allowPrompt) {
            console.log(`${entry}: local changes (no match). Use --force to overwrite.`);
            continue;
          }
          const confirm = await promptConfirm(
            `${entry}: local changes (no match). Overwrite with ${formatInstallResolutionVersion(
              latestInstall,
            )}?`,
          );
          if (!confirm) {
            console.log(`${entry}: skipped`);
            continue;
          }
          spinner.start(`Updating ${entry} -> ${formatInstallResolutionVersion(latestInstall)}`);
        }

        if (
          matched === targetVersion &&
          existingOrigin?.artifactIdentity === targetArtifactIdentity &&
          !options.force &&
          !hasLocalChanges
        ) {
          const installedAt = existingOrigin?.installedAt ?? lock.skills[entry]?.installedAt;
          if (
            exists &&
            installedAt &&
            (!existingOrigin ||
              !sameSkillsShSource(existingOrigin.sourceRef, state.sourceRef) ||
              existingOrigin.sourceRepository !== state.sourceRepository ||
              existingOrigin.sourcePath !== state.sourcePath ||
              existingOrigin.sourceUrl !== state.sourceUrl ||
              existingOrigin.canonicalRef !== state.canonicalRef ||
              existingOrigin.clawhubScan !== state.clawhubScan ||
              existingOrigin.trustLabel !== state.trustLabel)
          ) {
            await writeSkillOrigin(target, {
              version: 1,
              registry: existingOrigin?.registry ?? registry,
              slug: entryRef.slug,
              ...state,
              artifactIdentity: targetArtifactIdentity,
              installedVersion: targetVersion,
              installedAt,
              fingerprint: localFingerprint ?? existingOrigin?.fingerprint,
            });
          }
          if (
            lock.skills[entry]?.version !== targetVersion ||
            lock.skills[entry]?.sourceRef !== entryRef.sourceRef ||
            lock.skills[entry]?.sourceRepository !== state.sourceRepository ||
            lock.skills[entry]?.sourcePath !== state.sourcePath ||
            lock.skills[entry]?.sourceUrl !== state.sourceUrl ||
            lock.skills[entry]?.canonicalRef !== state.canonicalRef ||
            lock.skills[entry]?.clawhubScan !== state.clawhubScan ||
            lock.skills[entry]?.trustLabel !== state.trustLabel
          ) {
            replaceLockEntry(lock, entry, entryRef.sourceRef, {
              ...withPinnedMetadata(
                targetVersion,
                lock.skills[entry]?.installedAt ?? Date.now(),
                lock.skills[entry],
              ),
              ...state,
            });
            markLockDirty();
            await flushLockfile();
          }
          spinner.succeed(
            `${entry}: up to date (${formatInstallResolutionVersion(latestInstall)})`,
          );
          continue;
        }

        spinner.text = `Updating ${entry} -> ${formatInstallResolutionVersion(latestInstall)}`;
        await installSkillWithOptionalStaging(target, exists, (installTarget) =>
          installSkillsShResolution(
            registry,
            latestInstall,
            state.canonicalRef,
            installTarget,
            token,
          ),
        );
        const installedFiles = await listSkillFiles(target);
        const installedFingerprint =
          installedFiles.length > 0 ? hashSkillFiles(installedFiles).fingerprint : undefined;
        const installedAt = existingOrigin?.installedAt ?? Date.now();
        await writeSkillOrigin(target, {
          version: 1,
          registry: existingOrigin?.registry ?? registry,
          slug: entryRef.slug,
          ...state,
          artifactIdentity: targetArtifactIdentity,
          installedVersion: targetVersion,
          installedAt,
          fingerprint: installedFingerprint,
        });
        replaceLockEntry(lock, entry, entryRef.sourceRef, {
          ...withPinnedMetadata(targetVersion, installedAt, lock.skills[entry]),
          ...state,
        });
        markLockDirty();
        await flushLockfile();
        await reportInstalledSkillsTelemetryIfEnabled({
          token,
          registry,
          slug: entryRef.slug,
          ...state,
          version: targetVersion,
        });
        spinner.succeed(
          `${entry}: updated -> ${formatInstallResolutionVersion(latestInstall)} (${state.trustLabel})`,
        );
        continue;
      }

      const requestedOwnerHandle = normalizeOwnerHandle(
        requestedRef?.ownerHandle ??
          entryRef.ownerHandle ??
          entryLock?.ownerHandle ??
          existingOrigin?.ownerHandle,
      );

      // Always fetch skill metadata to check moderation status
      const skillMeta = await apiRequest(
        registry,
        skillRequestArgs(registry, entryRef.slug, requestedOwnerHandle, token),
        ApiV1SkillResponseSchema,
      );
      const resolvedOwnerHandle = normalizeOwnerHandle(
        requestedOwnerHandle ?? skillMeta.owner?.handle,
      );
      const resolvedSlug = normalizeSkillSlugForRemote(skillMeta.skill?.slug) ?? entryRef.slug;
      const remoteSlug =
        existingOrigin?.slug ?? (requestedOwnerHandle ? entryRef.slug : resolvedSlug);

      // Check moderation status before proceeding
      if (skillMeta.moderation?.isMalwareBlocked) {
        spinner.fail(`${entry}: blocked as malicious`);
        console.log("   This skill has been flagged as malware and cannot be updated.");
        continue;
      }

      if (skillMeta.moderation?.isSuspicious && !options.force) {
        spinner.stop();
        console.log(
          `\n⚠️  Warning: "${entry}" is flagged for ClawHub security review.\n` +
            "   This skill may contain risky patterns (crypto keys, external APIs, eval, etc.)\n",
        );
        if (allowPrompt) {
          const confirm = await promptConfirm("Update anyway?");
          if (!confirm) {
            console.log(`${entry}: skipped`);
            continue;
          }
          spinner.start(`Checking ${entry}`);
        } else {
          console.log(`${entry}: skipped (use --force to update suspicious skills)`);
          continue;
        }
      }

      let localFingerprint: string | null = null;
      if (exists) {
        const filesOnDisk = await listSkillFiles(target);
        if (filesOnDisk.length > 0) {
          const hashed = hashSkillFiles(filesOnDisk);
          localFingerprint = hashed.fingerprint;
        }
      }

      let latestInstall: ApiV1SkillInstallResolveResponse | null = null;
      if (!skillMeta.latestVersion && !options.version) {
        latestInstall = await resolveLatestSkillInstall(
          registry,
          remoteSlug,
          resolvedOwnerHandle,
          token,
          {
            forceInstall: Boolean(options.forceInstall),
          },
        );
        if (!latestInstall.ok) {
          spinner.fail(`${entry}: ${latestInstall.message}`);
          continue;
        }
        if (latestInstall.installKind === "github") {
          const targetVersion = latestInstall.github.commit;
          const originFingerprint =
            existingOrigin?.slug === remoteSlug ? existingOrigin.fingerprint : undefined;
          const hasLocalChanges = Boolean(
            exists &&
            localFingerprint &&
            (!originFingerprint || originFingerprint !== localFingerprint),
          );
          const matched =
            existingOrigin?.slug === remoteSlug &&
            originFingerprint &&
            localFingerprint &&
            originFingerprint === localFingerprint
              ? existingOrigin.installedVersion
              : null;

          if (hasLocalChanges && !options.force) {
            spinner.stop();
            if (!allowPrompt) {
              console.log(`${entry}: local changes (no match). Use --force to overwrite.`);
              continue;
            }
            const confirm = await promptConfirm(
              `${entry}: local changes (no match). Overwrite with ${formatGitHubVersion(targetVersion)}?`,
            );
            if (!confirm) {
              console.log(`${entry}: skipped`);
              continue;
            }
            spinner.start(`Updating ${entry} -> ${formatGitHubVersion(targetVersion)}`);
          }

          if (matched === targetVersion && !options.force && !hasLocalChanges) {
            if (lock.skills[entry]?.version !== targetVersion) {
              lock.skills[entry] = withPinnedMetadata(
                targetVersion,
                lock.skills[entry]?.installedAt ?? Date.now(),
                lock.skills[entry],
              );
              markLockDirty();
              await flushLockfile();
            }
            spinner.succeed(`${entry}: up to date (${formatGitHubVersion(targetVersion)})`);
            continue;
          }

          if (spinner.isSpinning) {
            spinner.text = `Updating ${entry} -> ${formatGitHubVersion(targetVersion)}`;
          } else {
            spinner.start(`Updating ${entry} -> ${formatGitHubVersion(targetVersion)}`);
          }
          const githubResolution = latestInstall;
          await installSkillWithOptionalStaging(target, exists, (installTarget) =>
            installGitHubSkill(registry, githubResolution, installTarget),
          );
          const installedFiles = await listSkillFiles(target);
          const installedFingerprint =
            installedFiles.length > 0 ? hashSkillFiles(installedFiles).fingerprint : undefined;

          const installedAt = existingOrigin?.installedAt ?? Date.now();
          await writeSkillOrigin(target, {
            version: 1,
            registry: existingOrigin?.registry ?? registry,
            slug: remoteSlug,
            ...(resolvedOwnerHandle ? { ownerHandle: resolvedOwnerHandle } : {}),
            installedVersion: targetVersion,
            installedAt,
            fingerprint: installedFingerprint,
          });

          lock.skills[entry] = withOwnerMetadata(
            targetVersion,
            installedAt,
            resolvedOwnerHandle,
            lock.skills[entry],
          );
          markLockDirty();
          await flushLockfile();
          spinner.succeed(`${entry}: updated -> ${formatGitHubVersion(targetVersion)}`);
          continue;
        }
      }

      const latestVersion =
        skillMeta.latestVersion ??
        (latestInstall?.ok && latestInstall.installKind === "archive"
          ? { version: latestInstall.archive.version }
          : null);

      let resolveResult: ResolveResult;
      if (localFingerprint) {
        resolveResult = await resolveSkillVersion(
          registry,
          remoteSlug,
          localFingerprint,
          resolvedOwnerHandle,
          token,
        );
      } else {
        resolveResult = { match: null, latestVersion };
      }

      const originOwnerMatches =
        !resolvedOwnerHandle ||
        !existingOrigin?.ownerHandle ||
        normalizeOwnerHandle(existingOrigin.ownerHandle) === resolvedOwnerHandle;
      const latest = resolveResult.latestVersion?.version ?? null;
      const matched =
        resolveResult.match?.version ??
        (localFingerprint &&
        existingOrigin?.fingerprint === localFingerprint &&
        existingOrigin.slug === remoteSlug &&
        originOwnerMatches
          ? existingOrigin.installedVersion
          : null);

      if (
        matched &&
        (lock.skills[entry]?.version !== matched ||
          (resolvedOwnerHandle && lock.skills[entry]?.ownerHandle !== resolvedOwnerHandle))
      ) {
        lock.skills[entry] = withOwnerMetadata(
          matched,
          lock.skills[entry]?.installedAt ?? Date.now(),
          resolvedOwnerHandle,
          lock.skills[entry],
        );
        markLockDirty();
        await flushLockfile();
      }

      if (!latest) {
        spinner.fail(`${entry}: not found`);
        continue;
      }

      if (!matched && localFingerprint && !options.force) {
        spinner.stop();
        if (!allowPrompt) {
          console.log(`${entry}: local changes (no match). Use --force to overwrite.`);
          continue;
        }
        const confirm = await promptConfirm(
          `${entry}: local changes (no match). Overwrite with ${options.version ?? latest}?`,
        );
        if (!confirm) {
          console.log(`${entry}: skipped`);
          continue;
        }
        spinner.start(`Updating ${entry} -> ${options.version ?? latest}`);
      }

      const targetVersion = options.version ?? latest;
      if (options.version) {
        if (matched && matched === targetVersion) {
          spinner.succeed(
            `${styleText(entry, "strong")} ${styleText("already at", "brand")} ${styleText(
              `v${matched}`,
              "muted",
            )}`,
          );
          continue;
        }
      } else if (matched && semver.valid(matched) && semver.gte(matched, targetVersion)) {
        spinner.succeed(
          `${styleText(entry, "strong")} ${styleText("up to date", "brand")} ${styleText(
            `v${matched}`,
            "muted",
          )}`,
        );
        continue;
      }

      if (spinner.isSpinning) {
        spinner.text = `Updating ${entry} -> ${targetVersion}`;
      } else {
        spinner.start(`Updating ${entry} -> ${targetVersion}`);
      }
      await installSkillWithOptionalStaging(target, exists, async (installTarget) => {
        const zip = await downloadZip(registry, {
          slug: remoteSlug,
          ...(resolvedOwnerHandle ? { ownerHandle: resolvedOwnerHandle } : {}),
          version: targetVersion,
          token,
        });
        await extractZipToDir(zip, installTarget);
      });
      const installedFiles = await listSkillFiles(target);
      const installedFingerprint =
        installedFiles.length > 0 ? hashSkillFiles(installedFiles).fingerprint : undefined;

      const installedAt = existingOrigin?.installedAt ?? Date.now();
      await writeSkillOrigin(target, {
        version: 1,
        registry: existingOrigin?.registry ?? registry,
        slug: remoteSlug,
        ...(resolvedOwnerHandle ? { ownerHandle: resolvedOwnerHandle } : {}),
        installedVersion: targetVersion,
        installedAt,
        fingerprint: installedFingerprint,
      });

      lock.skills[entry] = withOwnerMetadata(
        targetVersion,
        installedAt,
        resolvedOwnerHandle,
        lock.skills[entry],
      );
      markLockDirty();
      await flushLockfile();
      spinner.succeed(
        `${styleText("Updated", "brand")} ${styleText(entry, "strong")} -> ${styleText(
          `v${targetVersion}`,
          "muted",
        )}`,
      );
    } catch (error) {
      spinner.fail(formatError(error));
      throw error;
    }
  }

  await flushLockfile();
  if (skippedPinned.length > 0) {
    const suffix = skippedPinned.length === 1 ? "" : "s";
    console.log(
      `Skipped ${skippedPinned.length} pinned skill${suffix}: ${skippedPinned.join(", ")}`,
    );
  }
}

export async function cmdList(opts: GlobalOpts) {
  const lock = await readLockfile(opts.workdir);
  const entries = Object.entries(lock.skills);
  const trackedTargets = new Set(
    Object.keys(lock.skills).map((entry) => {
      const ref = parseStoredSkillRefOrFail(lock.skills[entry]?.sourceRef ?? entry);
      return ref.sourceRef ? ref.slug : entry;
    }),
  );
  const manualSkills = await listManualSkills(opts.dir, trackedTargets);
  if (entries.length === 0 && manualSkills.length === 0) {
    console.log("No installed skills.");
    return;
  }
  for (const [slug, entry] of entries) {
    const storedRef = parseStoredSkillsShReference(entry.sourceRef ?? slug);
    const displaySlug = storedRef?.sourceRef ?? slug;
    const pinned = isPinnedSkillEntry(entry) ? `  pinned${formatPinnedDetails(entry)}` : "";
    const trust = entry.clawhubScan === "unscanned" ? `  ${entry.trustLabel}` : "";
    console.log(`${displaySlug}  ${entry.version ?? "latest"}${pinned}${trust}`);
  }
  if (manualSkills.length > 0) {
    if (entries.length > 0) console.log();
    console.log("Manually installed (not tracked by clawhub):");
    for (const slug of manualSkills) {
      console.log(`  ${slug}`);
    }
  }
}

export async function cmdPin(opts: GlobalOpts, slug: string, options: { reason?: string } = {}) {
  const requested = parseSkillRefOrFail(slug);
  const lock = await readLockfile(opts.workdir);
  const lockKey = findExistingLockKey(lock, requested);
  const existing = lock.skills[lockKey];
  const label = skillIdentity(requested);
  if (!existing) fail(`Not installed: ${label}`);

  const reason = options.reason?.trim() || existing.pinReason;
  if (isPinnedSkillEntry(existing) && reason === existing.pinReason) {
    console.log(`Skill "${label}" is already pinned${reason ? `: ${reason}` : ""}`);
    return;
  }

  lock.skills[lockKey] = {
    ...existing,
    pinned: true,
    ...(reason ? { pinReason: reason } : {}),
  };
  await writeLockfile(opts.workdir, lock);
  console.log(`Pinned ${label}${reason ? `: ${reason}` : ""}`);
}

export async function cmdUnpin(opts: GlobalOpts, slug: string) {
  const requested = parseSkillRefOrFail(slug);
  const lock = await readLockfile(opts.workdir);
  const lockKey = findExistingLockKey(lock, requested);
  const existing = lock.skills[lockKey];
  const label = skillIdentity(requested);
  if (!existing) fail(`Not installed: ${label}`);
  if (!isPinnedSkillEntry(existing)) fail(`Skill "${label}" is not pinned`);

  const { pinned: _pinned, pinReason: _pinReason, ...unpinned } = existing;
  lock.skills[lockKey] = unpinned;
  await writeLockfile(opts.workdir, lock);
  console.log(`Unpinned ${label}`);
}

export async function cmdUninstall(
  opts: GlobalOpts,
  slug: string,
  options: { yes?: boolean } = {},
  inputAllowed: boolean,
) {
  const requested = parseSkillRefOrFail(slug);

  const lock = await readLockfile(opts.workdir);
  const lockKey = findExistingLockKey(lock, requested);
  if (!lock.skills[lockKey]) {
    fail(`Not installed: ${skillIdentity(requested)}`);
  }

  const allowPrompt = isInteractive() && inputAllowed;
  if (!options.yes) {
    if (!allowPrompt) fail("Pass --yes (no input)");
    const confirm = await promptConfirm(`Uninstall ${skillIdentity(requested)}?`);
    if (!confirm) {
      console.log("Cancelled.");
      return;
    }
  }

  const localRef =
    lockKey === skillIdentity(requested) ? requested : parseStoredSkillRefOrFail(lockKey);
  const spinner = createCrabLoader(`Uninstalling ${skillIdentity(localRef)}`);
  try {
    const target = skillTarget(opts.dir, localRef);

    await rm(target, { recursive: true, force: true });

    delete lock.skills[lockKey];
    await writeLockfile(opts.workdir, lock);

    spinner.succeed(
      `${styleText("Uninstalled", "brand")} ${styleText(skillIdentity(localRef), "strong")}`,
    );
  } catch (error) {
    spinner.fail(formatError(error));
    throw error;
  }
}

type ExploreSort = "newest" | "rating" | "downloads" | "installs" | "trending";
type ApiExploreSort = "createdAt" | "updated" | "downloads" | "stars" | "installs" | "trending";

export async function cmdExplore(
  opts: GlobalOpts,
  options: { limit?: number; sort?: string; json?: boolean } = {},
) {
  const token = await getOptionalAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const spinner = createCrabLoader("Fetching latest skills");
  try {
    const url = registryUrl(ApiRoutes.skills, registry);
    const boundedLimit = clampLimit(options.limit ?? 25);
    const { apiSort } = resolveExploreSort(options.sort);
    url.searchParams.set("limit", String(boundedLimit));
    if (apiSort !== "updated") url.searchParams.set("sort", apiSort);
    const result = await apiRequest(
      registry,
      { method: "GET", url: url.toString(), token },
      ApiV1SkillListResponseSchema,
    );

    spinner.stop();
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.items.length === 0) {
      console.log("No skills found.");
      return;
    }

    for (const item of result.items) {
      console.log(formatExploreLine(item));
    }
  } catch (error) {
    spinner.fail(formatError(error));
    throw error;
  }
}

export function formatExploreLine(item: {
  ownerHandle?: string;
  slug: string;
  summary?: string | null;
  updatedAt: number;
  latestVersion?: { version: string } | null;
}) {
  const version = item.latestVersion?.version ?? "?";
  const age = formatRelativeTime(item.updatedAt);
  const summary = item.summary ? `  ${styleText(truncate(item.summary, 50), "muted")}` : "";
  const qualifiedSlug = item.ownerHandle ? `${item.ownerHandle}/${item.slug}` : item.slug;
  return `${styleText(qualifiedSlug, "brand")}  ${styleText(`v${version}`, "muted")}  ${styleText(
    age,
    "muted",
  )}${summary}`;
}

export function clampLimit(limit: number, fallback = 25) {
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(1, limit), 200);
}

export async function cmdReportSkill(
  opts: GlobalOpts,
  slug: string,
  options: SkillReportOptions = {},
) {
  const trimmed = normalizeSkillSlugOrFail(slug);
  const reason = options.reason?.trim();
  if (!reason) fail("--reason required");

  const token = await requireAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const result = await apiRequest(
    registry,
    {
      method: "POST",
      path: `${ApiRoutes.skills}/${encodeURIComponent(trimmed)}/report`,
      token,
      body: {
        reason,
        ...(options.version?.trim() ? { version: options.version.trim() } : {}),
      },
    },
    ApiV1SkillReportResponseSchema,
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (result.alreadyReported) {
    console.log(`Already reported ${trimmed}.`);
  } else {
    console.log(`OK. Reported ${trimmed} (${result.reportId}).`);
  }
}

export async function cmdListSkillReports(opts: GlobalOpts, options: SkillReportListOptions = {}) {
  const status = options.status?.trim() || "open";
  if (!["open", "confirmed", "dismissed", "all"].includes(status)) {
    fail("--status must be open, confirmed, dismissed, or all");
  }

  const token = await requireAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const url = registryUrl(`${ApiRoutes.skills}/-/reports`, registry);
  url.searchParams.set("status", status);
  if (options.cursor?.trim()) url.searchParams.set("cursor", options.cursor.trim());
  url.searchParams.set("limit", String(clampLimit(options.limit ?? 25, 25)));
  const result = await apiRequest(
    registry,
    { method: "GET", url: url.toString(), token },
    ApiV1SkillReportListResponseSchema,
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (result.items.length === 0) {
    console.log("No skill reports found.");
  } else {
    for (const item of result.items) {
      const reporter = item.reporter.handle ?? item.reporter.userId;
      console.log(`${item.reportId} ${item.status} ${item.slug}`);
      console.log(`  reporter: ${reporter}`);
      if (item.reason) console.log(`  reason: ${item.reason}`);
      if (item.triageNote) console.log(`  note: ${item.triageNote}`);
    }
  }
  if (!result.done && result.nextCursor) console.log(`Next cursor: ${result.nextCursor}`);
}

export async function cmdTriageSkillReport(
  opts: GlobalOpts,
  reportId: string,
  options: SkillReportTriageOptions = {},
) {
  const trimmed = reportId.trim();
  if (!trimmed) fail("Report id required");
  const statusValue = options.status?.trim();
  if (!statusValue || !["open", "confirmed", "dismissed"].includes(statusValue)) {
    fail("--status must be open, confirmed, or dismissed");
  }
  const status = statusValue as SkillReportStatus;
  const finalAction = (options.finalAction ?? options.action)?.trim() as
    | SkillReportFinalAction
    | undefined;
  if (finalAction && !["none", "hide"].includes(finalAction)) {
    fail("--action must be none or hide");
  }
  const note = options.note?.trim();
  if (status !== "open" && !note) fail("--note required unless reopening");

  const token = await requireAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  await presentModerationPlan(
    reportModerationPlan({
      entityLabel: "skill",
      reportId: trimmed,
      status,
      finalAction: finalAction ?? "none",
    }),
    options,
  );
  const result = await apiRequest(
    registry,
    {
      method: "POST",
      path: `${ApiRoutes.skills}/-/reports/${encodeURIComponent(trimmed)}/triage`,
      token,
      body: {
        status,
        ...(note ? { note } : {}),
        ...(finalAction ? { finalAction } : {}),
      },
    },
    ApiV1SkillReportTriageResponseSchema,
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const actionSuffix =
    result.actionTaken && result.actionTaken !== "none" ? `; action ${result.actionTaken}` : "";
  console.log(`OK. Skill report ${trimmed} set to ${result.status}${actionSuffix}.`);
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 30) {
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  }
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 1)}…`;
}

function resolveExploreSort(raw?: string): { sort: ExploreSort; apiSort: ApiExploreSort } {
  const normalized = raw?.trim().toLowerCase();
  if (
    !normalized ||
    normalized === "newest" ||
    normalized === "createdat" ||
    normalized === "created-at"
  ) {
    return { sort: "newest", apiSort: "createdAt" };
  }
  if (normalized === "updated") {
    return { sort: "newest", apiSort: "updated" };
  }
  if (normalized === "rating" || normalized === "stars" || normalized === "star") {
    return { sort: "rating", apiSort: "stars" };
  }
  if (normalized === "downloads" || normalized === "download") {
    return { sort: "downloads", apiSort: "downloads" };
  }
  if (normalized === "installs" || normalized === "install") {
    return { sort: "installs", apiSort: "installs" };
  }
  if (
    normalized === "installscurrent" ||
    normalized === "installs-current" ||
    normalized === "current" ||
    normalized === "installsalltime" ||
    normalized === "installs-all-time"
  ) {
    return { sort: "installs", apiSort: "installs" };
  }
  if (normalized === "trending") {
    return { sort: "trending", apiSort: "trending" };
  }
  return fail(
    `Invalid sort "${raw}". Use newest, updated, rating, downloads, installs, or trending.`,
  );
}

async function resolveSkillVersion(
  registry: string,
  slug: string,
  hash: string,
  ownerHandle?: string,
  token?: string,
) {
  const url = registryUrl(ApiRoutes.resolve, registry);
  url.searchParams.set("slug", slug);
  if (ownerHandle) url.searchParams.set("ownerHandle", ownerHandle);
  url.searchParams.set("hash", hash);
  return apiRequest(
    registry,
    { method: "GET", url: url.toString(), token },
    ApiV1SkillResolveResponseSchema,
  );
}

async function resolveLatestSkillInstall(
  registry: string,
  slug: string,
  ownerHandle?: string,
  token?: string,
  options: { forceInstall?: boolean } = {},
) {
  const path = `${ApiRoutes.skills}/${encodeURIComponent(slug)}/install`;
  const url = ownerScopedUrl(registry, path, ownerHandle);
  const requestUrl = url ? new URL(url) : null;
  if (options.forceInstall) {
    if (requestUrl) requestUrl.searchParams.set("forceInstall", "1");
  }
  return await apiRequest(
    registry,
    requestUrl
      ? {
          method: "GET",
          url: requestUrl.toString(),
          token,
          acceptedStatuses: [403, 409, 410, 423],
        }
      : {
          method: "GET",
          path: `${path}${options.forceInstall ? "?forceInstall=1" : ""}`,
          token,
          acceptedStatuses: [403, 409, 410, 423],
        },
    ApiV1SkillInstallResolveResponseSchema,
  );
}

async function resolveSkillsShCatalogInstall(registry: string, ref: SkillRef, token?: string) {
  if (!ref.sourceRef || !ref.skillsSh) {
    fail("Invalid skills.sh ref: use skills-sh:owner/repo/slug");
  }
  const path = `${ApiRoutes.skillsSh}/${encodeURIComponent(
    ref.skillsSh.owner,
  )}/${encodeURIComponent(ref.skillsSh.repo)}/${encodeURIComponent(ref.slug)}/install`;
  const resolution = await apiRequest(
    registry,
    { method: "GET", path, token },
    ApiV1SkillInstallResolveResponseSchema,
  );
  if (!resolution.ok) fail(resolution.message);
  const metadata = readSkillsShResolverMetadata(resolution, ref.sourceRef);
  if (metadata.clawhubScan === "unscanned") {
    if (resolution.installKind !== "github") {
      fail("unscanned skills.sh catalog entries must resolve to an exact GitHub install");
    }
  } else {
    if (!metadata.canonicalRef) {
      fail("adopted skills.sh aliases must return their canonical native reference");
    }
    validateCanonicalSkillsShAliasRef(metadata.canonicalRef);
  }
  return {
    resolution,
    state: {
      sourceRef: ref.sourceRef,
      sourceKind: "skills-sh",
      ...(resolution.installKind === "github"
        ? {
            sourceRepository: resolution.github.repo,
            sourcePath: resolution.github.path,
            sourceUrl: resolution.github.sourceUrl,
          }
        : {
            ...(metadata.sourceRepository ? { sourceRepository: metadata.sourceRepository } : {}),
            ...(metadata.sourcePath ? { sourcePath: metadata.sourcePath } : {}),
            ...(metadata.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
          }),
      ...(metadata.canonicalRef ? { canonicalRef: metadata.canonicalRef } : {}),
      clawhubScan: metadata.clawhubScan,
      trustLabel: metadata.trustLabel,
    } satisfies SkillsShState,
  };
}

function readSkillsShResolverMetadata(
  resolution: ApiV1SkillInstallResolveResponse,
  requestedRef: string,
): {
  clawhubScan: "unscanned" | "scanned";
  trustLabel: string;
  canonicalRef?: string;
  sourceRepository?: string;
  sourcePath?: string;
  sourceUrl?: string;
} {
  const record = asRecord(resolution);
  const provenance = asRecord(record.provenance);
  const trust = asRecord(record.trust);
  if (provenance.source !== "skills.sh" || provenance.reference !== requestedRef) {
    fail("skills.sh catalog resolver did not preserve the requested external provenance");
  }
  const clawhubScan = trust.clawhubScan;
  const trustLabel = typeof trust.label === "string" ? trust.label.trim() : "";
  if (clawhubScan !== "unscanned" && clawhubScan !== "scanned") {
    fail("skills.sh catalog resolver did not return a ClawHub scan state");
  }
  if (!trustLabel) {
    fail("skills.sh catalog resolver did not return a trust label");
  }
  if (clawhubScan === "unscanned" && trustLabel !== SKILLS_SH_UNSCANNED_LABEL) {
    fail(`skills.sh catalog resolver must label unscanned sources "${SKILLS_SH_UNSCANNED_LABEL}"`);
  }
  if (clawhubScan === "scanned" && trustLabel !== SKILLS_SH_SCANNED_LABEL) {
    fail(`skills.sh catalog resolver must label scanned sources "${SKILLS_SH_SCANNED_LABEL}"`);
  }
  const canonicalRef =
    record.canonicalRef === null || record.canonicalRef === undefined
      ? undefined
      : typeof record.canonicalRef === "string"
        ? record.canonicalRef.trim()
        : fail("skills.sh catalog resolver returned an invalid canonical reference");
  const sourceRepository =
    typeof provenance.repository === "string" ? provenance.repository.trim() : undefined;
  const sourcePath = typeof provenance.path === "string" ? provenance.path.trim() : undefined;
  const sourceUrl =
    typeof provenance.sourceUrl === "string" ? provenance.sourceUrl.trim() : undefined;
  return {
    clawhubScan,
    trustLabel,
    canonicalRef,
    sourceRepository,
    sourcePath,
    sourceUrl,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sameSkillsShSource(left: string | undefined, right: string | undefined) {
  if (!left || !right) return false;
  try {
    return parseStoredSkillsShReference(left)?.sourceRef === right;
  } catch {
    return false;
  }
}

function validateCanonicalSkillsShAliasRef(canonicalRef: string) {
  const canonical = parseSkillRefOrFail(canonicalRef);
  if (!canonical.ownerHandle || canonical.sourceRef) {
    fail("adopted skills.sh alias returned an invalid canonical native reference");
  }
  return canonical;
}

function getInstallResolutionVersion(resolution: SuccessfulInstallResolution) {
  return resolution.installKind === "github"
    ? resolution.github.commit
    : resolution.archive.version;
}

function getInstallResolutionArtifactIdentity(
  resolution: SuccessfulInstallResolution,
  canonicalRef: string | undefined,
) {
  return resolution.installKind === "github"
    ? JSON.stringify({
        installKind: resolution.installKind,
        repo: resolution.github.repo,
        path: resolution.github.path,
        commit: resolution.github.commit,
        contentHash: resolution.github.contentHash,
      })
    : JSON.stringify({
        installKind: resolution.installKind,
        canonicalRef,
        version: resolution.archive.version,
      });
}

function formatInstallResolutionVersion(resolution: SuccessfulInstallResolution) {
  return resolution.installKind === "github"
    ? formatGitHubVersion(resolution.github.commit)
    : `v${resolution.archive.version}`;
}

async function installSkillsShResolution(
  registry: string,
  resolution: SuccessfulInstallResolution,
  canonicalRef: string | undefined,
  target: string,
  token: string | undefined,
) {
  if (resolution.installKind === "github") {
    await installGitHubSkill(registry, resolution, target, {
      expectedContentHash: resolution.github.contentHash,
    });
    return;
  }
  if (!canonicalRef) fail("adopted skills.sh alias did not return a canonical native reference");
  const canonical = validateCanonicalSkillsShAliasRef(canonicalRef);
  const zip = await downloadZip(registry, {
    slug: canonical.slug,
    ownerHandle: canonical.ownerHandle,
    version: resolution.archive.version,
    token,
  });
  await extractZipToDir(zip, target);
}

async function installGitHubSkill(
  registry: string,
  resolution: GitHubInstallResolution,
  target: string,
  options: { expectedContentHash?: string } = {},
) {
  const zip = await fetchBinary(registry, {
    url: gitHubZipUrl(resolution.github.repo, resolution.github.commit),
  });
  await extractGitHubZipPathToDir(zip, target, resolution.github.path);
  if (options.expectedContentHash) {
    const installed = hashSkillFiles(await listSkillFiles(target));
    const actualContentHash = buildGitHubFolderContentHash(installed.files);
    if (actualContentHash !== options.expectedContentHash.toLowerCase()) {
      await rm(target, { recursive: true, force: true });
      fail("Downloaded skills.sh folder hash does not match the approved ClawHub resolver");
    }
  }
}

function assertSkillsShTargetOwnership(args: {
  dir: string;
  lock: { skills: Record<string, { sourceRef?: string }> };
  lockKey: string;
  requested: SkillRef;
  target: string;
  targetExists: boolean;
  existingOrigin: Awaited<ReturnType<typeof readSkillOrigin>>;
}) {
  if (!args.requested.sourceRef) return;
  for (const [key, entry] of Object.entries(args.lock.skills)) {
    if (key === args.lockKey) continue;
    const identity = entry.sourceRef ?? key;
    if (!isSafeSkillIdentity(identity)) continue;
    const ref = parseSkillRefOrFail(identity);
    if (skillTarget(args.dir, ref) === args.target) {
      fail(`Install target collision: ${args.target} is owned by ${identity}`);
    }
  }
  if (!args.targetExists) return;
  const lockedSource = args.lock.skills[args.lockKey]?.sourceRef;
  if (
    args.existingOrigin?.sourceRef &&
    !sameSkillsShSource(args.existingOrigin.sourceRef, args.requested.sourceRef)
  ) {
    fail(`Install target collision: ${args.target} is owned by ${args.existingOrigin.sourceRef}`);
  }
  if (
    !args.existingOrigin?.sourceRef &&
    !sameSkillsShSource(lockedSource, args.requested.sourceRef)
  ) {
    const owner = args.existingOrigin?.ownerHandle
      ? `@${args.existingOrigin.ownerHandle}/${args.existingOrigin.slug}`
      : (args.existingOrigin?.slug ?? "another local skill");
    fail(`Install target collision: ${args.target} is owned by ${owner}`);
  }
}

async function installSkillWithOptionalStaging(
  target: string,
  targetExists: boolean,
  install: (target: string) => Promise<void>,
) {
  if (!targetExists) {
    await install(target);
    return;
  }

  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, `.${basename(target)}.tmp-`));
  const backup = join(parent, `.${basename(target)}.backup-${process.pid}-${Date.now()}`);
  let stageMoved = false;
  let backupCreated = false;

  try {
    await install(stage);
    await rename(target, backup);
    backupCreated = true;
    await rename(stage, target);
    stageMoved = true;
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (backupCreated) {
      await rm(target, { recursive: true, force: true }).catch(() => {});
      await rename(backup, target).catch(() => {});
    }
    throw error;
  } finally {
    if (!stageMoved) {
      await rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function gitHubZipUrl(repo: string, commit: string) {
  const base = (
    process.env.CLAWHUB_GITHUB_CODELOAD_BASE_URL ||
    process.env.OPENCLAW_CLAWHUB_GITHUB_CODELOAD_BASE_URL ||
    "https://codeload.github.com"
  ).replace(/\/+$/, "");
  return `${base}/${encodeGitHubRepo(repo)}/zip/${encodeURIComponent(commit)}`;
}

function encodeGitHubRepo(repo: string) {
  return repo
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function formatGitHubVersion(commit: string) {
  return commit.length > 12 ? commit.slice(0, 12) : commit;
}

async function fileExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
