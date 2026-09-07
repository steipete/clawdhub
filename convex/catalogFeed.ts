import {
  CATALOG_FEED_GITHUB_SOURCE_REF,
  CATALOG_FEED_ID,
  CATALOG_FEED_SCHEMA_VERSION,
  CATALOG_FEED_SOURCE_REF,
  CATALOG_SKILLS_FEED_DESCRIPTION,
  CATALOG_SKILLS_FEED_ID,
  PROMOTIONS_FEED_ID,
  EXPERIMENTAL_CLAW_FEED_DESCRIPTION,
  EXPERIMENTAL_CLAW_FEED_ID,
  EXPERIMENTAL_CLAW_FEED_SCHEMA_VERSION,
  serializeCatalogFeed,
  serializeExperimentalClawFeed,
  type CatalogFeedEntry,
  type CatalogFeedPluginEntry,
  type CatalogFeedSkillEntry,
  type ExperimentalClawFeedEntry,
} from "clawhub-schema";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalQuery } from "./_generated/server";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import { internalMutation } from "./functions";
import { isSkillHighlighted } from "./lib/badges";
import { projectCatalogFeedOpenClaw } from "./lib/catalogFeedOpenClaw";
import { sha256Hex } from "./lib/clawpack";
import { experimentalClawsEnabled } from "./lib/experimentalClaws";
import { isPublicSkillDoc } from "./lib/globalStats";
import { isOfficialPublisher } from "./lib/officialPublishers";
import { getPackageReleaseArtifactSha256 } from "./lib/packageArtifacts";
import { isPackageBlockedFromPublic, resolvePackageReleaseScanStatus } from "./lib/packageSecurity";
import { getOwnerPublisher } from "./lib/publishers";
import { MAX_PUBLISH_FILE_BYTES } from "./lib/publishLimits";
import { isSecurityScanStatusCompletedNonBlocked } from "./lib/securityScanPolicy";
import {
  getPublicSkillVersionDownloadBlock,
  getSkillFileModerationInfoFromSkill,
  isPublicSkillVersionAvailableForSkill,
} from "./lib/skillFileAccess";
import { isHostedSkillPresentationIconPath, stripPresentationEmoji } from "./lib/skillPresentation";

const CATALOG_FEED_DESCRIPTION = "Official OpenClaw plugins published on ClawHub.";
const CATALOG_FEED_PAGE_SIZE = 100;
const MAX_CATALOG_FEED_ENTRIES = 1000;
// One publication is one Convex document (1 MiB); leave room for row metadata.
const MAX_CATALOG_FEED_PAYLOAD_BYTES = 900 * 1024;
const CATALOG_FEED_FAMILIES = ["code-plugin", "bundle-plugin"] as const;
const CATALOG_CLAW_FAMILY = "claw" as const;

type CatalogQueryCtx = Pick<QueryCtx, "db">;
type CatalogEntryProjection<T = CatalogFeedPluginEntry | ExperimentalClawFeedEntry> = {
  entry: T;
  manifest?: Pick<Doc<"packageReleases">["files"][number], "storageId" | "size" | "sha256"> & {
    runtimeId: string;
  };
};
type CatalogFeedPublicationResult = {
  publicationId: string;
  feedId: string;
  sequence: number;
  payloadSha256: string;
  publishedAt: number;
  entryCount: number;
};

function appendEntriesWithinFeedLimit<T>(target: T[], entries: T[]) {
  const remaining = MAX_CATALOG_FEED_ENTRIES - target.length;
  if (remaining <= 0) return false;
  target.push(...entries.slice(0, remaining));
  return entries.length <= remaining;
}

const catalogFeedEntryFields = {
  id: v.string(),
  title: v.string(),
  description: v.optional(v.string()),
  icon: v.optional(v.string()),
  version: v.string(),
  state: v.union(
    v.literal("available"),
    v.literal("recommended"),
    v.literal("disabled"),
    v.literal("blocked"),
    v.literal("deprecated"),
  ),
  featured: v.optional(v.boolean()),
  featuredAt: v.optional(v.number()),
  publisher: v.object({
    id: v.string(),
    trust: v.union(v.literal("official"), v.literal("community")),
  }),
  install: v.object({
    candidates: v.array(
      v.object({
        sourceRef: v.string(),
        package: v.string(),
        version: v.string(),
        integrity: v.string(),
        github: v.optional(
          v.object({
            repo: v.string(),
            path: v.string(),
            commit: v.string(),
            contentHash: v.string(),
          }),
        ),
      }),
    ),
  }),
};
const providerAuthChoiceValidator = v.object({
  method: v.string(),
  choiceId: v.string(),
  choiceLabel: v.string(),
  choiceHint: v.optional(v.string()),
  assistantPriority: v.optional(v.number()),
  assistantVisibility: v.optional(v.union(v.literal("visible"), v.literal("manual-only"))),
  groupId: v.optional(v.string()),
  groupLabel: v.optional(v.string()),
  groupHint: v.optional(v.string()),
  optionKey: v.optional(v.string()),
  cliFlag: v.optional(v.string()),
  cliOption: v.optional(v.string()),
  cliDescription: v.optional(v.string()),
  deprecatedChoiceIds: v.optional(v.array(v.string())),
  onboardingScopes: v.optional(
    v.array(
      v.union(
        v.literal("text-inference"),
        v.literal("image-generation"),
        v.literal("music-generation"),
      ),
    ),
  ),
  appGuidedSecret: v.optional(v.boolean()),
  appGuidedAuth: v.optional(v.union(v.literal("oauth"), v.literal("device-code"))),
  appGuidedActionLabel: v.optional(v.string()),
  onboardingFeatured: v.optional(v.boolean()),
  icon: v.optional(v.string()),
  website: v.optional(v.string()),
});
const catalogFeedOpenClawValidator = v.object({
  plugin: v.object({ id: v.string(), label: v.optional(v.string()) }),
  providers: v.array(
    v.object({
      id: v.string(),
      envVars: v.optional(v.array(v.string())),
      authChoices: v.optional(v.array(providerAuthChoiceValidator)),
    }),
  ),
  modelCatalog: v.optional(
    v.object({
      providers: v.record(
        v.string(),
        v.object({
          defaultModel: v.optional(v.string()),
          models: v.array(
            v.object({
              id: v.string(),
              name: v.optional(v.string()),
              input: v.optional(
                v.array(v.union(v.literal("text"), v.literal("image"), v.literal("document"))),
              ),
              reasoning: v.optional(v.boolean()),
              contextWindow: v.optional(v.number()),
              maxTokens: v.optional(v.number()),
            }),
          ),
        }),
      ),
    }),
  ),
});
const catalogFeedEntryValidator = v.union(
  v.object({
    type: v.literal("plugin"),
    ...catalogFeedEntryFields,
    openclaw: v.optional(catalogFeedOpenClawValidator),
  }),
  v.object({ type: v.literal("skill"), ...catalogFeedEntryFields }),
);
const clawFeedEntryValidator = v.object({
  type: v.literal("claw"),
  ...catalogFeedEntryFields,
  install: v.object({
    candidates: v.array(
      v.object({
        sourceRef: v.literal(CATALOG_FEED_SOURCE_REF),
        package: v.string(),
        version: v.string(),
        integrity: v.string(),
      }),
    ),
  }),
  clawManifestSummary: v.object({
    schemaVersion: v.literal(1),
    agent: v.object({
      id: v.string(),
      name: v.optional(v.string()),
      description: v.optional(v.string()),
    }),
    workspace: v.object({
      bootstrapFiles: v.array(v.string()),
      fileCount: v.number(),
    }),
    packages: v.object({ skillCount: v.number(), pluginCount: v.number() }),
    profiles: v.optional(v.object({ count: v.number(), hasOpenClaw: v.boolean() })),
    extensions: v.optional(v.object({ count: v.number() })),
    mcpServerCount: v.number(),
    cronJobCount: v.number(),
  }),
});

async function buildEntry(
  ctx: CatalogQueryCtx,
  pkg: Doc<"packages">,
): Promise<CatalogEntryProjection | null> {
  if (pkg.softDeletedAt || pkg.channel !== "official" || !pkg.latestReleaseId) return null;
  const release = await ctx.db.get(pkg.latestReleaseId);
  if (!release || release.packageId !== pkg._id || release.softDeletedAt) return null;

  const scanStatus = resolvePackageReleaseScanStatus(release);
  if (isPackageBlockedFromPublic(scanStatus)) return null;
  const artifactSha256 = getPackageReleaseArtifactSha256(release);
  if (!artifactSha256) return null;

  const owner = await getOwnerPublisher(ctx, {
    ownerPublisherId: pkg.ownerPublisherId,
    ownerUserId: pkg.ownerUserId,
  });
  if (!(await isOfficialPublisher(ctx, owner))) return null;
  const publisherId = owner?.handle?.trim();
  if (!publisherId) return null;

  const packageName = pkg.name.trim();
  const id = pkg.normalizedName.trim();
  const title = stripPresentationEmoji(pkg.displayName.trim()) || packageName;
  const description = pkg.summary?.trim();
  const icon = pkg.icon?.trim();
  const version = release.version.trim();
  if (!packageName || !id || !title || !version) return null;
  const highlighted = await ctx.db
    .query("packageBadges")
    .withIndex("by_package_kind", (q) => q.eq("packageId", pkg._id).eq("kind", "highlighted"))
    .unique();

  if (pkg.family === "claw") {
    if (!release.clawManifestSummary) return null;
    return {
      entry: {
        type: "claw",
        id,
        title,
        version,
        state: "available",
        publisher: {
          id: publisherId,
          trust: "official",
        },
        clawManifestSummary: release.clawManifestSummary,
        install: {
          candidates: [
            {
              sourceRef: CATALOG_FEED_SOURCE_REF,
              package: packageName,
              version,
              integrity: `sha256:${artifactSha256}`,
            },
          ],
        },
      } satisfies ExperimentalClawFeedEntry,
    };
  }

  const manifestFile =
    pkg.family === "code-plugin" && release.runtimeId
      ? release.files.find((file) => file.path.toLowerCase() === "openclaw.plugin.json")
      : undefined;
  return {
    ...(manifestFile && release.runtimeId
      ? {
          manifest: {
            runtimeId: release.runtimeId,
            storageId: manifestFile.storageId,
            size: manifestFile.size,
            sha256: manifestFile.sha256,
          },
        }
      : {}),
    entry: {
      type: "plugin",
      id,
      title,
      ...(description ? { description } : {}),
      ...(icon ? { icon } : {}),
      version,
      state: "available",
      featured: Boolean(highlighted),
      ...(highlighted ? { featuredAt: highlighted.at } : {}),
      publisher: {
        id: publisherId,
        trust: "official",
      },
      install: {
        candidates: [
          {
            sourceRef: CATALOG_FEED_SOURCE_REF,
            package: packageName,
            version,
            integrity: `sha256:${artifactSha256}`,
          },
        ],
      },
    },
  };
}

async function listFamilyEntries(
  ctx: CatalogQueryCtx,
  family: (typeof CATALOG_FEED_FAMILIES)[number] | typeof CATALOG_CLAW_FAMILY,
) {
  const entries: CatalogEntryProjection[] = [];
  let cursor: string | null = null;

  while (true) {
    const page = await ctx.db
      .query("packages")
      .withIndex("by_active_family_official_downloads", (q) =>
        q.eq("softDeletedAt", undefined).eq("family", family).eq("isOfficial", true),
      )
      .order("desc")
      .paginate({ cursor, numItems: CATALOG_FEED_PAGE_SIZE });

    for (const pkg of page.page) {
      const entry = await buildEntry(ctx, pkg);
      if (entry) entries.push(entry);
      if (entries.length > MAX_CATALOG_FEED_ENTRIES) {
        throw new Error(`Catalog feed exceeds ${MAX_CATALOG_FEED_ENTRIES} entries`);
      }
    }
    if (page.isDone) return entries;
    cursor = page.continueCursor;
  }
}

async function buildSkillEntry(
  ctx: CatalogQueryCtx,
  skill: Doc<"skills">,
  trustedOwner?: Doc<"publishers">,
): Promise<CatalogFeedSkillEntry | null> {
  if (
    !isPublicSkillDoc(skill) ||
    !skill.ownerPublisherId ||
    (trustedOwner && skill.ownerPublisherId !== trustedOwner._id)
  ) {
    return null;
  }

  const owner = trustedOwner ?? (await ctx.db.get(skill.ownerPublisherId));
  if (
    !owner ||
    (trustedOwner
      ? Boolean(owner.deletedAt || owner.deactivatedAt)
      : !(await isOfficialPublisher(ctx, owner)))
  ) {
    return null;
  }

  const publisherId = owner.handle?.trim();
  const slug = skill.slug.trim();
  const title = stripPresentationEmoji(skill.displayName.trim()) || slug;
  const description = skill.summary?.trim();
  const icon = catalogFeedIconUrl(skill.icon);
  const highlightedAt = skill.badges?.highlighted?.at;
  const packageName = `@${publisherId}/${slug}`;
  if (!publisherId || !slug || !title) return null;

  if (skill.installKind === "github") {
    if (
      !skill.githubSourceId ||
      !skill.githubPath ||
      !skill.githubCurrentCommit ||
      !skill.githubCurrentContentHash ||
      skill.githubCurrentStatus !== "present" ||
      !isSecurityScanStatusCompletedNonBlocked(skill.githubScanStatus) ||
      skill.githubRemovedAt
    ) {
      return null;
    }
    const source = await ctx.db.get(skill.githubSourceId);
    if (!source || source.ownerPublisherId !== skill.ownerPublisherId) return null;

    const repo = (skill.githubCurrentRepo ?? source.repo).trim();
    const path = skill.githubPath.trim();
    const commit = skill.githubCurrentCommit.trim();
    const contentHash = skill.githubCurrentContentHash.trim();
    if (!repo || !path || !commit || !contentHash) return null;

    return {
      type: "skill",
      id: packageName,
      title,
      ...(description ? { description } : {}),
      ...(icon ? { icon } : {}),
      version: commit,
      state: "available",
      featured: isSkillHighlighted(skill),
      ...(highlightedAt !== undefined ? { featuredAt: highlightedAt } : {}),
      publisher: {
        id: publisherId,
        trust: "official",
      },
      install: {
        candidates: [
          {
            sourceRef: CATALOG_FEED_GITHUB_SOURCE_REF,
            package: packageName,
            version: commit,
            integrity: `sha256:${contentHash}`,
            github: {
              repo,
              path,
              commit,
              contentHash,
            },
          },
        ],
      },
    };
  }

  if (!skill.latestVersionId) return null;
  const version = await ctx.db.get(skill.latestVersionId);
  if (
    !version ||
    !isPublicSkillVersionAvailableForSkill(version, skill._id) ||
    getPublicSkillVersionDownloadBlock(getSkillFileModerationInfoFromSkill(skill), version) ||
    !version.files.length ||
    !version.sha256hash
  ) {
    return null;
  }

  const versionName = version.version.trim();
  if (!versionName) return null;

  return {
    type: "skill",
    id: packageName,
    title,
    ...(description ? { description } : {}),
    ...(icon ? { icon } : {}),
    version: versionName,
    state: "available",
    featured: isSkillHighlighted(skill),
    ...(highlightedAt !== undefined ? { featuredAt: highlightedAt } : {}),
    publisher: {
      id: publisherId,
      trust: "official",
    },
    install: {
      candidates: [
        {
          sourceRef: CATALOG_FEED_SOURCE_REF,
          package: packageName,
          version: versionName,
          integrity: `sha256:${version.sha256hash}`,
        },
      ],
    },
  };
}

function catalogFeedIconUrl(value: string | undefined) {
  const icon = value?.trim();
  if (!icon) return undefined;
  if (isHostedSkillPresentationIconPath(icon)) {
    return `https://clawhub.ai${icon}`;
  }
  return icon.startsWith("https://") ? icon : undefined;
}

export const listOfficialPublisherPage = internalQuery({
  args: {
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("officialPublishers")
      .withIndex("by_created")
      .order("desc")
      .paginate({ cursor: args.cursor, numItems: CATALOG_FEED_PAGE_SIZE });
    const publishers: Doc<"publishers">[] = [];
    for (const row of page.page) {
      const publisher = await ctx.db.get(row.publisherId);
      if (publisher && !publisher.deletedAt && !publisher.deactivatedAt) {
        publishers.push(publisher);
      }
    }
    return {
      publishers,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const listOfficialEntries = internalQuery({
  args: {
    family: v.union(v.literal("code-plugin"), v.literal("bundle-plugin")),
  },
  handler: async (ctx, args) => {
    const entries = await listFamilyEntries(ctx, args.family);
    return entries.map(({ entry, manifest }): CatalogEntryProjection<CatalogFeedPluginEntry> => {
      if (entry.type !== "plugin")
        throw new Error("Plugin feed projection returned a mismatched entry type");
      return { entry, ...(manifest ? { manifest } : {}) };
    });
  },
});

export const listOfficialClawEntries = internalQuery({
  args: {},
  handler: async (ctx) => {
    if (!experimentalClawsEnabled()) return [];
    const entries = await listFamilyEntries(ctx, CATALOG_CLAW_FAMILY);
    return entries.map(({ entry }) => {
      if (entry.type !== "claw")
        throw new Error("Claw feed projection returned a mismatched entry type");
      return entry;
    });
  },
});

export const listOfficialSkillEntries = internalQuery({
  args: {
    publisherId: v.id("publishers"),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const owner = await ctx.db.get(args.publisherId);
    if (
      !owner ||
      owner.deletedAt ||
      owner.deactivatedAt ||
      !(await isOfficialPublisher(ctx, owner))
    ) {
      return { entries: [], isDone: true, continueCursor: "" };
    }

    const page = await ctx.db
      .query("skills")
      .withIndex("by_owner_publisher_active_updated", (q) =>
        q.eq("ownerPublisherId", args.publisherId).eq("softDeletedAt", undefined),
      )
      .order("desc")
      .paginate({ cursor: args.cursor, numItems: CATALOG_FEED_PAGE_SIZE });
    const entries: CatalogFeedSkillEntry[] = [];
    for (const skill of page.page) {
      const entry = await buildSkillEntry(ctx, skill, owner);
      if (entry) entries.push(entry);
    }
    return {
      entries,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

async function hashCatalogFeedPayload(payload: string): Promise<string> {
  const bytes = new TextEncoder().encode(payload);
  if (bytes.byteLength > MAX_CATALOG_FEED_PAYLOAD_BYTES) {
    throw new Error(
      `Catalog feed payload exceeds ${MAX_CATALOG_FEED_PAYLOAD_BYTES} bytes; reduce feed metadata`,
    );
  }
  return sha256Hex(bytes);
}

export const storePublication = internalMutation({
  args: {
    feedId: v.union(v.literal(CATALOG_FEED_ID), v.literal(CATALOG_SKILLS_FEED_ID)),
    description: v.string(),
    generatedAt: v.string(),
    expiresAt: v.string(),
    entries: v.array(catalogFeedEntryValidator),
  },
  handler: async (ctx, args) => {
    const expectedEntryType = args.feedId === CATALOG_SKILLS_FEED_ID ? "skill" : "plugin";
    if (args.entries.some((entry) => entry.type !== expectedEntryType)) {
      throw new Error(`Catalog ${expectedEntryType} feed received a mismatched entry type`);
    }
    const latest = await ctx.db
      .query("catalogFeedPublications")
      .withIndex("by_feed", (q) => q.eq("feedId", args.feedId))
      .unique();
    const sequence = (latest?.sequence ?? 0) + 1;
    const payload = serializeCatalogFeed({
      schemaVersion: CATALOG_FEED_SCHEMA_VERSION,
      id: args.feedId,
      generatedAt: args.generatedAt,
      sequence,
      expiresAt: args.expiresAt,
      description: args.description,
      entries: args.entries,
    });
    const payloadSha256 = await hashCatalogFeedPayload(payload);
    const publishedAt = Date.now();
    const publication = {
      feedId: args.feedId,
      sequence,
      generatedAt: args.generatedAt,
      expiresAt: args.expiresAt,
      payload,
      payloadSha256,
      publishedAt,
    };
    const publicationId = latest
      ? (await ctx.db.patch(latest._id, publication), latest._id)
      : await ctx.db.insert("catalogFeedPublications", publication);
    return {
      publicationId,
      feedId: args.feedId,
      sequence,
      payloadSha256,
      publishedAt,
      entryCount: args.entries.length,
    };
  },
});

export const storeClawPublication = internalMutation({
  args: {
    generatedAt: v.string(),
    expiresAt: v.string(),
    entries: v.array(clawFeedEntryValidator),
  },
  handler: async (ctx, args) => {
    if (!experimentalClawsEnabled()) throw new Error("Experimental Claw feeds are disabled");
    const latest = await ctx.db
      .query("catalogFeedPublications")
      .withIndex("by_feed", (q) => q.eq("feedId", EXPERIMENTAL_CLAW_FEED_ID))
      .unique();
    const sequence = (latest?.sequence ?? 0) + 1;
    const payload = serializeExperimentalClawFeed({
      schemaVersion: EXPERIMENTAL_CLAW_FEED_SCHEMA_VERSION,
      id: EXPERIMENTAL_CLAW_FEED_ID,
      generatedAt: args.generatedAt,
      sequence,
      expiresAt: args.expiresAt,
      description: EXPERIMENTAL_CLAW_FEED_DESCRIPTION,
      entries: args.entries,
    });
    const payloadSha256 = await hashCatalogFeedPayload(payload);
    const publishedAt = Date.now();
    const publication = {
      feedId: EXPERIMENTAL_CLAW_FEED_ID,
      sequence,
      generatedAt: args.generatedAt,
      expiresAt: args.expiresAt,
      payload,
      payloadSha256,
      publishedAt,
    };
    const publicationId = latest
      ? (await ctx.db.patch(latest._id, publication), latest._id)
      : await ctx.db.insert("catalogFeedPublications", publication);
    return {
      publicationId,
      feedId: EXPERIMENTAL_CLAW_FEED_ID,
      sequence,
      payloadSha256,
      publishedAt,
      entryCount: args.entries.length,
    };
  },
});

async function hydratePluginEntry(
  ctx: Pick<ActionCtx, "storage">,
  { entry, manifest }: CatalogEntryProjection<CatalogFeedPluginEntry>,
): Promise<CatalogFeedPluginEntry> {
  if (!manifest) return entry;
  if (manifest.size > MAX_PUBLISH_FILE_BYTES)
    throw new Error(`Catalog manifest too large: ${entry.id}`);
  const blob = await ctx.storage.get(manifest.storageId);
  if (!blob || blob.size !== manifest.size)
    throw new Error(`Catalog manifest size mismatch: ${entry.id}`);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if ((await sha256Hex(bytes)) !== manifest.sha256)
    throw new Error(`Catalog manifest digest mismatch: ${entry.id}`);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`Catalog manifest is not valid JSON: ${entry.id}`);
  }
  const openclaw = projectCatalogFeedOpenClaw(raw, manifest.runtimeId, entry.title);
  return { ...entry, ...(openclaw ? { openclaw } : {}) };
}

export const publish = internalAction({
  args: {
    expiresAt: v.string(),
  },
  handler: async (ctx, args): Promise<CatalogFeedPublicationResult[]> => {
    const generatedAt = new Date().toISOString();
    const familyEntries: CatalogFeedEntry[][] = await Promise.all(
      CATALOG_FEED_FAMILIES.map(async (family) => {
        const projections: CatalogEntryProjection<CatalogFeedPluginEntry>[] = await ctx.runQuery(
          internal.catalogFeed.listOfficialEntries,
          { family },
        );
        const entries: CatalogFeedPluginEntry[] = [];
        // Read immutable manifests one at a time, not the lossy extracted JSON.
        // Keep storage ids private and bind every projection to the release hash.
        for (const projection of projections)
          entries.push(await hydratePluginEntry(ctx, projection));
        return entries;
      }),
    );
    const entries = familyEntries.flat();
    if (entries.length > MAX_CATALOG_FEED_ENTRIES) {
      throw new Error(`Catalog feed exceeds ${MAX_CATALOG_FEED_ENTRIES} entries`);
    }
    const skillEntries: CatalogFeedSkillEntry[] = [];
    const seenPublisherIds = new Set<string>();
    let publisherCursor: string | null = null;
    // The skills feed currently ships as one bounded snapshot. Cap it instead
    // of blocking the plugin feed refresh until skills pagination/sharding lands.
    publisherLoop: while (true) {
      const publisherPage: {
        publishers: Doc<"publishers">[];
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.catalogFeed.listOfficialPublisherPage, {
        cursor: publisherCursor,
      });
      for (const publisher of publisherPage.publishers) {
        if (seenPublisherIds.has(publisher._id)) continue;
        seenPublisherIds.add(publisher._id);
        let skillCursor: string | null = null;
        while (true) {
          const skillPage: {
            entries: CatalogFeedSkillEntry[];
            isDone: boolean;
            continueCursor: string;
          } = await ctx.runQuery(internal.catalogFeed.listOfficialSkillEntries, {
            publisherId: publisher._id,
            cursor: skillCursor,
          });
          if (!appendEntriesWithinFeedLimit(skillEntries, skillPage.entries)) break publisherLoop;
          if (skillPage.isDone) break;
          skillCursor = skillPage.continueCursor;
        }
      }
      if (publisherPage.isDone) break;
      publisherCursor = publisherPage.continueCursor;
    }

    const pluginResult: CatalogFeedPublicationResult = await ctx.runMutation(
      internal.catalogFeed.storePublication,
      {
        feedId: CATALOG_FEED_ID,
        description: CATALOG_FEED_DESCRIPTION,
        generatedAt,
        expiresAt: args.expiresAt,
        entries: entries.sort((left, right) => left.id.localeCompare(right.id)),
      },
    );
    const skillsResult: CatalogFeedPublicationResult = await ctx.runMutation(
      internal.catalogFeed.storePublication,
      {
        feedId: CATALOG_SKILLS_FEED_ID,
        description: CATALOG_SKILLS_FEED_DESCRIPTION,
        generatedAt,
        expiresAt: args.expiresAt,
        entries: skillEntries.sort((left, right) => left.id.localeCompare(right.id)),
      },
    );
    if (!experimentalClawsEnabled()) {
      return [pluginResult, skillsResult];
    }
    const clawEntries: ExperimentalClawFeedEntry[] = await ctx.runQuery(
      internal.catalogFeed.listOfficialClawEntries,
      {},
    );
    if (clawEntries.length > MAX_CATALOG_FEED_ENTRIES) {
      throw new Error(`Catalog feed exceeds ${MAX_CATALOG_FEED_ENTRIES} entries`);
    }
    const clawsResult: CatalogFeedPublicationResult = await ctx.runMutation(
      internal.catalogFeed.storeClawPublication,
      {
        generatedAt,
        expiresAt: args.expiresAt,
        entries: clawEntries.sort((left, right) => left.id.localeCompare(right.id)),
      },
    );
    return [pluginResult, skillsResult, clawsResult];
  },
});

export const getLatestPublication = internalQuery({
  args: {
    feedId: v.union(
      v.literal(CATALOG_FEED_ID),
      v.literal(CATALOG_SKILLS_FEED_ID),
      v.literal(EXPERIMENTAL_CLAW_FEED_ID),
      v.literal(PROMOTIONS_FEED_ID),
    ),
  },
  handler: async (ctx, args) =>
    await ctx.db
      .query("catalogFeedPublications")
      .withIndex("by_feed", (q) => q.eq("feedId", args.feedId))
      .unique(),
});
