/* @vitest-environment node */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  authTables: {},
}));

vi.mock("convex-helpers/server/pagination", async () => {
  const actual = await vi.importActual<typeof import("convex-helpers/server/pagination")>(
    "convex-helpers/server/pagination",
  );
  return {
    ...actual,
    getPage: vi.fn(),
  };
});

const pagination = await import("convex-helpers/server/pagination");
const {
  listAuditPage,
  listPublicApiPageV1,
  listPublicPageV4,
  listPublicTrendingPage,
  listRelatedByCategory,
} = await import("./skills");

type WrappedHandler<TArgs, TResult> = {
  _handler: (ctx: unknown, args: TArgs) => Promise<TResult>;
};

type PublicListArgs = {
  cursor?: string;
  numItems?: number;
  prefix?: string;
  sort?:
    | "default"
    | "recommended"
    | "newest"
    | "updated"
    | "downloads"
    | "installs"
    | "stars"
    | "name";
  dir?: "asc" | "desc";
  highlightedOnly?: boolean;
  officialOnly?: boolean;
  createdAfter?: number;
  nonSuspiciousOnly?: boolean;
  capabilityTag?: string;
  topic?: string;
  categorySlug?: string;
  officialFirst?: boolean;
  categoryKeywords?: string[];
  excludeCategoryKeywords?: string[];
};

type PublicListResult = {
  page: unknown[];
  hasMore: boolean;
  nextCursor: string | null;
};

type PublicApiListResult = {
  items: unknown[];
  nextCursor: string | null;
};

const getPageMock = pagination.getPage as unknown as ReturnType<typeof vi.fn>;
const listPublicPageV4Handler = (
  listPublicPageV4 as unknown as WrappedHandler<PublicListArgs, PublicListResult>
)._handler;
const listPublicApiPageV1Handler = (
  listPublicApiPageV1 as unknown as WrappedHandler<PublicListArgs, PublicApiListResult>
)._handler;
const listRelatedByCategoryHandler = (
  listRelatedByCategory as unknown as WrappedHandler<
    { skillId: string; categorySlug?: string; keywords: string[]; limit?: number },
    { items: Array<{ skill: { slug: string }; ownerHandle: string | null }> }
  >
)._handler;
const listPublicTrendingPageHandler = (
  listPublicTrendingPage as unknown as WrappedHandler<
    { limit?: number; nonSuspiciousOnly?: boolean },
    PublicApiListResult
  >
)._handler;
const listAuditPageHandler = (
  listAuditPage as unknown as WrappedHandler<
    { paginationOpts: { cursor: string | null; numItems: number } },
    PublicListResult
  >
)._handler;

function makeSearchDigest(overrides: Record<string, unknown> = {}) {
  return {
    _id: "skillSearchDigest:demo",
    skillId: "skills:demo",
    slug: "demo",
    displayName: "Demo",
    summary: "Demo skill",
    icon: undefined,
    ownerUserId: "users:owner",
    ownerPublisherId: undefined,
    ownerHandle: "owner",
    ownerKind: "user",
    ownerName: "Owner",
    ownerDisplayName: "Owner",
    ownerImage: null,
    canonicalSkillId: undefined,
    forkOf: undefined,
    latestVersionId: "skillVersions:1",
    latestVersionSkillId: "skills:demo",
    latestVersionSummary: {
      version: "1.0.0",
      createdAt: 9,
      changelog: "initial",
      changelogSource: "user",
      clawdis: undefined,
    },
    tags: {},
    capabilityTags: [],
    badges: {},
    stats: { downloads: 0, stars: 0, versions: 1, comments: 0 },
    statsDownloads: 0,
    statsStars: 0,
    statsInstallsCurrent: 0,
    statsInstallsAllTime: 0,
    softDeletedAt: undefined,
    moderationStatus: "active",
    moderationFlags: undefined,
    moderationReason: undefined,
    isSuspicious: false,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function makeOfficialFirstCategoryCtx(curatedDigests: Array<ReturnType<typeof makeSearchDigest>>) {
  const digestsBySkillId = new Map(curatedDigests.map((digest) => [digest.skillId, digest]));
  const query = vi.fn((table: string) => {
    if (table === "skillSearchDigest") {
      return {
        withIndex: vi.fn(
          (
            _indexName: string,
            builder: (q: { eq: (field: string, value: string) => unknown }) => unknown,
          ) => {
            let skillId = "";
            const queryBuilder = {
              eq: (_field: string, value: string) => {
                skillId = value;
                return queryBuilder;
              },
            };
            builder(queryBuilder);
            return {
              unique: vi.fn().mockResolvedValue(digestsBySkillId.get(skillId) ?? null),
            };
          },
        ),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  return {
    db: {
      query,
    },
  };
}

function makeTopicFilteredCtx(
  digests: Array<ReturnType<typeof makeSearchDigest>>,
  options: { missingRecommendedScores?: boolean } = {},
) {
  const digestsBySkillId = new Map(digests.map((digest) => [digest.skillId, digest]));
  const withIndex = vi.fn(
    (
      indexName: string,
      builder: (q: {
        eq: (field: string, value: unknown) => unknown;
        lt: (field: string, value: unknown) => unknown;
      }) => unknown,
    ) => {
      let skillId = "";
      const queryBuilder = {
        eq: (field: string, value: unknown) => {
          if (field === "skillId") skillId = String(value);
          return queryBuilder;
        },
        lt: () => queryBuilder,
      };
      builder(queryBuilder);
      return {
        first: vi
          .fn()
          .mockResolvedValue(
            options.missingRecommendedScores && indexName.includes("recommended_score")
              ? makeSearchDigest({ recommendedScore: undefined })
              : null,
          ),
        unique: vi.fn().mockResolvedValue(digestsBySkillId.get(skillId) ?? null),
      };
    },
  );
  return {
    withIndex,
    db: {
      query: vi.fn((table: string) => {
        if (table !== "skillSearchDigest") throw new Error(`Unexpected table: ${table}`);
        return {
          withIndex,
        };
      }),
    },
  };
}

function legacyCursor(key: unknown[]): string {
  return JSON.stringify(key);
}

function cursorForIndex(index: string, key: unknown[]): string {
  return JSON.stringify({ v: 1, index, key });
}

class TestEqBuilder {
  eq(_field: string, _value: unknown) {
    return this;
  }
}

function makeMissingRecommendedScoresCtx() {
  const first = vi.fn(async () => makeSearchDigest({ statsStars: undefined }));
  const withIndex = vi.fn((_indexName: string, build: (q: TestEqBuilder) => unknown) => {
    build(new TestEqBuilder());
    return { first };
  });
  const query = vi.fn((table: string) => {
    if (table !== "skillSearchDigest") throw new Error(`unexpected table ${table}`);
    return { withIndex };
  });

  return {
    ctx: { db: { query } },
    first,
    query,
    withIndex,
  };
}

describe("public skill list deterministic cursors", () => {
  beforeEach(() => {
    getPageMock.mockReset();
    getPageMock.mockResolvedValue({ page: [], hasMore: false, indexKeys: [] });
  });

  it("rejects invalid topic filters instead of returning an unfiltered page", async () => {
    const result = await listPublicPageV4Handler({} as never, {
      topic: "!!!",
      numItems: 10,
    });

    expect(result).toEqual({ page: [], hasMore: false, nextCursor: null });
    expect(getPageMock).not.toHaveBeenCalled();
  });

  it("includes official publisher status on browse owners", async () => {
    const digest = makeSearchDigest({
      ownerPublisherId: "publishers:openclaw",
      ownerHandle: "openclaw",
      ownerKind: "org",
      ownerName: undefined,
      ownerDisplayName: "OpenClaw",
    });
    getPageMock.mockResolvedValueOnce({
      page: [digest],
      hasMore: false,
      indexKeys: [[undefined, digest.updatedAt, digest._id]],
    });

    const result = await listPublicPageV4Handler(
      {
        db: {
          query: vi.fn((table: string) => {
            if (table !== "officialPublishers") {
              throw new Error(`Unexpected table: ${table}`);
            }
            return {
              withIndex: vi.fn(() => ({
                unique: vi.fn().mockResolvedValue({ publisherId: "publishers:openclaw" }),
              })),
            };
          }),
        },
      } as never,
      { sort: "updated", numItems: 10 },
    );

    expect((result.page as Array<{ owner?: { official?: boolean } }>)[0]?.owner?.official).toBe(
      true,
    );
  });

  it("applies Official and New eligibility at the backend cursor boundary", async () => {
    const officialNew = makeSearchDigest({
      skillId: "skills:official-new",
      slug: "official-new",
      badges: { official: { byUserId: "users:admin", at: 200 } },
      createdAt: 200,
    });
    const communityNew = makeSearchDigest({
      skillId: "skills:community-new",
      slug: "community-new",
      createdAt: 200,
    });
    const officialOld = makeSearchDigest({
      skillId: "skills:official-old",
      slug: "official-old",
      badges: { official: { byUserId: "users:admin", at: 50 } },
      createdAt: 50,
    });
    getPageMock.mockResolvedValueOnce({
      page: [officialNew, communityNew, officialOld],
      hasMore: false,
      indexKeys: [
        [undefined, 200, officialNew.updatedAt, officialNew._id],
        [undefined, 200, communityNew.updatedAt, communityNew._id],
        [undefined, 50, officialOld.updatedAt, officialOld._id],
      ],
    });

    const result = await listPublicPageV4Handler(
      makeOfficialFirstCategoryCtx([officialNew, communityNew, officialOld]) as never,
      {
        officialOnly: true,
        createdAfter: 100,
        sort: "newest",
        numItems: 10,
      },
    );

    expect(
      (result.page as Array<{ skill: { slug: string } }>).map((entry) => entry.skill.slug),
    ).toEqual(["official-new"]);
  });

  it("reads Official pages from the indexed curated projection", async () => {
    const official = makeSearchDigest({
      skillId: "skills:official",
      slug: "official",
      badges: { official: { byUserId: "users:admin", at: 2 } },
      createdAt: 2,
      updatedAt: 2,
    });
    const highlighted = makeSearchDigest({
      skillId: "skills:highlighted",
      slug: "highlighted",
      badges: { highlighted: { byUserId: "users:admin", at: 1 } },
      createdAt: 1,
      updatedAt: 1,
    });
    const ctx = makeOfficialFirstCategoryCtx([official, highlighted]);
    getPageMock.mockResolvedValueOnce({
      page: [official, highlighted],
      hasMore: false,
      indexKeys: [
        [undefined, official.createdAt, official.updatedAt, "curatedSkillSearchDigest:official"],
        [
          undefined,
          highlighted.createdAt,
          highlighted.updatedAt,
          "curatedSkillSearchDigest:highlighted",
        ],
      ],
    });

    const result = await listPublicPageV4Handler(ctx as never, {
      officialOnly: true,
      sort: "newest",
      dir: "desc",
      numItems: 10,
    });

    expect(getPageMock).toHaveBeenCalledTimes(1);
    expect(getPageMock.mock.calls[0]?.[1]).toMatchObject({
      table: "curatedSkillSearchDigest",
      index: "by_active_created",
    });
    expect(
      (result.page as Array<{ skill: { slug: string } }>).map((entry) => entry.skill.slug),
    ).toEqual(["official"]);
  });

  it("continues through highlighted-only curated windows to reach Official rows", async () => {
    const highlighted = makeSearchDigest({
      skillId: "skills:highlighted",
      slug: "highlighted",
      badges: { highlighted: { byUserId: "users:admin", at: 2 } },
      createdAt: 2,
      updatedAt: 2,
    });
    const official = makeSearchDigest({
      skillId: "skills:official",
      slug: "official",
      badges: { official: { byUserId: "users:admin", at: 1 } },
      createdAt: 1,
      updatedAt: 1,
    });
    const highlightedIndexKey = [
      undefined,
      highlighted.createdAt,
      highlighted.updatedAt,
      "curatedSkillSearchDigest:highlighted",
    ];
    const ctx = makeOfficialFirstCategoryCtx([highlighted, official]);
    getPageMock
      .mockResolvedValueOnce({
        page: [highlighted],
        hasMore: true,
        indexKeys: [highlightedIndexKey],
      })
      .mockResolvedValueOnce({
        page: [official],
        hasMore: false,
        indexKeys: [
          [undefined, official.createdAt, official.updatedAt, "curatedSkillSearchDigest:official"],
        ],
      });

    const result = await listPublicPageV4Handler(ctx as never, {
      officialOnly: true,
      sort: "newest",
      numItems: 1,
    });

    expect(
      (result.page as Array<{ skill: { slug: string } }>).map((entry) => entry.skill.slug),
    ).toEqual(["official"]);
    expect(getPageMock).toHaveBeenCalledTimes(2);
    expect(getPageMock.mock.calls[1]?.[1]).toMatchObject({
      table: "curatedSkillSearchDigest",
      startIndexKey: highlightedIndexKey,
      startInclusive: false,
    });
  });

  it("tags Official projection cursors before continuing on the curated index", async () => {
    const official = makeSearchDigest({
      skillId: "skills:official",
      slug: "official",
      badges: { official: { byUserId: "users:admin", at: 2 } },
      createdAt: 2,
      updatedAt: 2,
    });
    const indexKey = [
      undefined,
      official.createdAt,
      official.updatedAt,
      "curatedSkillSearchDigest:official",
    ];
    const ctx = makeOfficialFirstCategoryCtx([official]);
    getPageMock
      .mockResolvedValueOnce({
        page: [official],
        hasMore: true,
        indexKeys: [indexKey],
      })
      .mockResolvedValueOnce({ page: [], hasMore: false, indexKeys: [] });

    const first = await listPublicPageV4Handler(ctx as never, {
      officialOnly: true,
      sort: "newest",
      numItems: 1,
    });
    const second = await listPublicPageV4Handler(ctx as never, {
      cursor: first.nextCursor!,
      officialOnly: true,
      sort: "newest",
      numItems: 1,
    });

    expect(first.nextCursor).toMatch(/^skillofficial:/);
    expect(second.nextCursor).toBeNull();
    expect(getPageMock.mock.calls[1]?.[1]).toMatchObject({
      table: "curatedSkillSearchDigest",
      startIndexKey: indexKey,
      startInclusive: false,
    });
  });

  it("keeps pre-deploy Official cursors on the legacy projection", async () => {
    const indexKey = [undefined, 2, 2, "skillSearchDigest:official"];
    const legacyOfficialCursor = cursorForIndex("by_active_created", [
      { __undef: 1 },
      2,
      2,
      "skillSearchDigest:official",
    ]);

    await listPublicPageV4Handler({} as never, {
      cursor: legacyOfficialCursor,
      officialOnly: true,
      sort: "newest",
      numItems: 1,
    });

    expect(getPageMock).toHaveBeenCalledTimes(1);
    expect(getPageMock.mock.calls[0]?.[1]).toMatchObject({
      table: "skillSearchDigest",
      startIndexKey: indexKey,
      startInclusive: false,
    });
  });

  it("preserves the Official creation cutoff for non-creation sorts", async () => {
    const recent = makeSearchDigest({
      skillId: "skills:recent-official",
      slug: "recent-official",
      badges: { official: { byUserId: "users:admin", at: 2 } },
      createdAt: 200,
      updatedAt: 1,
    });
    const old = makeSearchDigest({
      skillId: "skills:old-official",
      slug: "old-official",
      badges: { official: { byUserId: "users:admin", at: 1 } },
      createdAt: 50,
      updatedAt: 2,
    });
    getPageMock.mockResolvedValueOnce({
      page: [old, recent],
      hasMore: false,
      indexKeys: [
        [undefined, old.updatedAt, old._id],
        [undefined, recent.updatedAt, recent._id],
      ],
    });

    const result = await listPublicPageV4Handler(
      makeOfficialFirstCategoryCtx([recent, old]) as never,
      {
        officialOnly: true,
        createdAfter: 100,
        sort: "updated",
        numItems: 10,
      },
    );

    expect(
      (result.page as Array<{ skill: { slug: string } }>).map((entry) => entry.skill.slug),
    ).toEqual(["recent-official"]);
  });

  it("starts ascending Official creation scans at the requested cutoff", async () => {
    await listPublicPageV4Handler({} as never, {
      officialOnly: true,
      createdAfter: 100,
      sort: "newest",
      dir: "asc",
      numItems: 10,
    });

    expect(getPageMock).toHaveBeenCalledTimes(1);
    expect(getPageMock.mock.calls[0]?.[1]).toMatchObject({
      table: "curatedSkillSearchDigest",
      index: "by_active_created",
      startIndexKey: [undefined, 100],
      startInclusive: true,
    });
  });

  it("ends descending New pagination when the creation window boundary is reached", async () => {
    const recent = makeSearchDigest({
      skillId: "skills:recent",
      slug: "recent",
      createdAt: 200,
    });
    const old = makeSearchDigest({
      skillId: "skills:old",
      slug: "old",
      createdAt: 99,
    });
    getPageMock.mockResolvedValueOnce({
      page: [recent, old],
      hasMore: true,
      indexKeys: [
        [undefined, recent.createdAt, recent.updatedAt, recent._id],
        [undefined, old.createdAt, old.updatedAt, old._id],
      ],
    });

    const result = await listPublicPageV4Handler({} as never, {
      createdAfter: 100,
      sort: "newest",
      dir: "desc",
      numItems: 10,
    });

    expect(
      (result.page as Array<{ skill: { slug: string } }>).map((entry) => entry.skill.slug),
    ).toEqual(["recent"]);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(getPageMock).toHaveBeenCalledTimes(1);
  });

  it("uses the topic digest index for topic-filtered recommended browse", async () => {
    const digest = makeSearchDigest({
      skillId: "skills:calendar",
      slug: "calendar",
      topics: ["Calendar", "Official"],
    });
    getPageMock.mockResolvedValueOnce({
      page: [
        {
          skillId: digest.skillId,
          topic: "calendar",
          softDeletedAt: undefined,
          isSuspicious: false,
          updatedAt: digest.updatedAt,
        },
      ],
      hasMore: false,
      indexKeys: [[undefined, "calendar", digest.updatedAt, "skillTopicSearchDigest:calendar"]],
    });

    const result = await listPublicPageV4Handler(makeTopicFilteredCtx([digest]) as never, {
      topic: "calendar",
      sort: "recommended",
      numItems: 10,
    });

    expect(getPageMock).toHaveBeenCalledTimes(1);
    expect(getPageMock.mock.calls[0]?.[1]).toMatchObject({
      table: "skillTopicSearchDigest",
      index: "by_active_topic_recommended_score",
      startIndexKey: [undefined, "calendar"],
      endIndexKey: [undefined, "calendar"],
    });
    expect(
      (result.page as Array<{ skill: { slug: string } }>).map((entry) => entry.skill.slug),
    ).toEqual(["calendar"]);
  });

  it("uses the selected sort index for topic-filtered browse", async () => {
    const digest = makeSearchDigest({
      skillId: "skills:calendar",
      slug: "calendar",
      topics: ["Calendar"],
      statsDownloads: 42,
    });
    getPageMock.mockResolvedValueOnce({
      page: [
        {
          skillId: digest.skillId,
          topic: "calendar",
          statsDownloads: digest.statsDownloads,
          updatedAt: digest.updatedAt,
        },
      ],
      hasMore: false,
      indexKeys: [
        [
          undefined,
          "calendar",
          digest.statsDownloads,
          digest.updatedAt,
          "skillTopicSearchDigest:calendar",
        ],
      ],
    });

    await listPublicPageV4Handler(makeTopicFilteredCtx([digest]) as never, {
      topic: "calendar",
      sort: "downloads",
      numItems: 10,
    });

    expect(getPageMock.mock.calls[0]?.[1]).toMatchObject({
      table: "skillTopicSearchDigest",
      index: "by_active_topic_downloads",
      startIndexKey: [undefined, "calendar"],
      endIndexKey: [undefined, "calendar"],
    });
  });

  it("keeps topic recommended browse on the recommended score index when scores are missing", async () => {
    const firstDigest = makeSearchDigest({
      skillId: "skills:calendar-one",
      slug: "calendar-one",
      topics: ["Calendar"],
      updatedAt: 10,
    });
    const secondDigest = makeSearchDigest({
      skillId: "skills:calendar-two",
      slug: "calendar-two",
      topics: ["Calendar"],
      updatedAt: 9,
    });
    const firstIndexKey = [
      undefined,
      "calendar",
      firstDigest.updatedAt,
      100,
      "skillTopicSearchDigest:calendar-one",
    ];
    getPageMock
      .mockResolvedValueOnce({
        page: [
          {
            skillId: firstDigest.skillId,
            topic: "calendar",
            updatedAt: firstDigest.updatedAt,
          },
        ],
        hasMore: true,
        indexKeys: [firstIndexKey],
      })
      .mockResolvedValueOnce({
        page: [
          {
            skillId: secondDigest.skillId,
            topic: "calendar",
            updatedAt: secondDigest.updatedAt,
          },
        ],
        hasMore: false,
        indexKeys: [
          [
            undefined,
            "calendar",
            secondDigest.updatedAt,
            200,
            "skillTopicSearchDigest:calendar-two",
          ],
        ],
      });
    const ctx = makeTopicFilteredCtx([firstDigest, secondDigest], {
      missingRecommendedScores: true,
    }) as never;

    const first = await listPublicPageV4Handler(ctx, {
      topic: "calendar",
      sort: "recommended",
      numItems: 1,
    });
    const second = await listPublicPageV4Handler(ctx, {
      cursor: first.nextCursor!,
      topic: "calendar",
      sort: "recommended",
      numItems: 1,
    });

    expect(first.nextCursor).not.toBeNull();
    expect(second.nextCursor).toBeNull();
    expect(getPageMock.mock.calls[0]?.[1]).toMatchObject({
      index: "by_active_topic_recommended_score",
      startIndexKey: [undefined, "calendar"],
      startInclusive: true,
    });
    expect(getPageMock.mock.calls[1]?.[1]).toMatchObject({
      index: "by_active_topic_recommended_score",
      startIndexKey: firstIndexKey,
      startInclusive: false,
    });
  });

  it("paginates topic browse from the selected sort's full self-describing cursor", async () => {
    const firstDigest = makeSearchDigest({
      skillId: "skills:calendar-one",
      slug: "calendar-one",
      topics: ["Calendar"],
      statsDownloads: 42,
      updatedAt: 10,
    });
    const secondDigest = makeSearchDigest({
      skillId: "skills:calendar-two",
      slug: "calendar-two",
      topics: ["Calendar"],
      statsDownloads: 21,
      updatedAt: 9,
    });
    const firstIndexKey = [
      undefined,
      "calendar",
      firstDigest.statsDownloads,
      firstDigest.updatedAt,
      100,
      "skillTopicSearchDigest:calendar-one",
    ];
    getPageMock
      .mockResolvedValueOnce({
        page: [
          {
            skillId: firstDigest.skillId,
            topic: "calendar",
            statsDownloads: firstDigest.statsDownloads,
            updatedAt: firstDigest.updatedAt,
          },
        ],
        hasMore: true,
        indexKeys: [firstIndexKey],
      })
      .mockResolvedValueOnce({
        page: [
          {
            skillId: secondDigest.skillId,
            topic: "calendar",
            statsDownloads: secondDigest.statsDownloads,
            updatedAt: secondDigest.updatedAt,
          },
        ],
        hasMore: false,
        indexKeys: [
          [
            undefined,
            "calendar",
            secondDigest.statsDownloads,
            secondDigest.updatedAt,
            200,
            "skillTopicSearchDigest:calendar-two",
          ],
        ],
      });
    const ctx = makeTopicFilteredCtx([firstDigest, secondDigest]) as never;

    const first = await listPublicPageV4Handler(ctx, {
      topic: "calendar",
      sort: "downloads",
      numItems: 1,
    });
    const second = await listPublicPageV4Handler(ctx, {
      cursor: first.nextCursor!,
      topic: "calendar",
      sort: "downloads",
      numItems: 1,
    });

    expect(first.nextCursor).not.toBeNull();
    expect(second.nextCursor).toBeNull();
    expect(getPageMock.mock.calls[1]?.[1]).toMatchObject({
      index: "by_active_topic_downloads",
      startIndexKey: firstIndexKey,
      startInclusive: false,
    });
  });

  it("falls back to the recommended rank index while recommendation scores are missing", async () => {
    const { ctx, withIndex } = makeMissingRecommendedScoresCtx();

    await listPublicPageV4Handler(ctx, {
      numItems: 10,
    });

    expect(withIndex.mock.calls.map(([indexName]) => indexName)).toEqual([
      "by_active_recommended_score",
    ]);
    expect(getPageMock).toHaveBeenCalledTimes(1);
    expect(getPageMock.mock.calls[0]?.[1]).toMatchObject({
      index: "by_active_recommended_rank",
      startIndexKey: [undefined],
      endIndexKey: [undefined],
      startInclusive: true,
    });
  });

  it("falls back to the non-suspicious recommended rank index while recommendation scores are missing", async () => {
    const { ctx, withIndex } = makeMissingRecommendedScoresCtx();

    await listPublicApiPageV1Handler(ctx, {
      numItems: 10,
      sort: "recommended",
      nonSuspiciousOnly: true,
    });

    expect(withIndex.mock.calls.map(([indexName]) => indexName)).toEqual([
      "by_nonsuspicious_recommended_score",
    ]);
    expect(getPageMock).toHaveBeenCalledTimes(1);
    expect(getPageMock.mock.calls[0]?.[1]).toMatchObject({
      index: "by_nonsuspicious_recommended_rank",
      startIndexKey: [undefined, false],
      endIndexKey: [undefined, false],
      startInclusive: true,
    });
  });

  it("ignores stale legacy cursors that are longer than the selected index", async () => {
    const staleDownloadsCursor = legacyCursor([{ __undef: 1 }, false, 100, 200]);

    await listPublicPageV4Handler({} as never, {
      cursor: staleDownloadsCursor,
      sort: "name",
      nonSuspiciousOnly: false,
      numItems: 10,
    });

    expect(getPageMock).toHaveBeenCalledTimes(1);
    expect(getPageMock.mock.calls[0]?.[1]).toMatchObject({
      index: "by_active_name",
      startIndexKey: [undefined],
      startInclusive: true,
    });
  });

  it("ignores self-describing cursors from a different selected index", async () => {
    const staleCursor = cursorForIndex("by_nonsuspicious_downloads", [
      { __undef: 1 },
      false,
      100,
      200,
    ]);

    await listPublicPageV4Handler({} as never, {
      cursor: staleCursor,
      sort: "downloads",
      nonSuspiciousOnly: false,
      numItems: 10,
    });

    expect(getPageMock).toHaveBeenCalledTimes(1);
    expect(getPageMock.mock.calls[0]?.[1]).toMatchObject({
      index: "by_active_stats_downloads",
      startIndexKey: [undefined],
      startInclusive: true,
    });
  });

  it("continues from valid cursors and emits the selected index with the next cursor", async () => {
    getPageMock.mockResolvedValueOnce({
      page: [],
      hasMore: true,
      indexKeys: [[undefined, "delta", 200, "skillSearchDigest:delta"]],
    });
    const validCursor = cursorForIndex("by_active_name", [
      { __undef: 1 },
      "beta",
      100,
      "skillSearchDigest:beta",
    ]);

    const result = await listPublicPageV4Handler({} as never, {
      cursor: validCursor,
      sort: "name",
      nonSuspiciousOnly: false,
      numItems: 10,
    });

    expect(getPageMock.mock.calls[0]?.[1]).toMatchObject({
      index: "by_active_name",
      startIndexKey: [undefined, "beta", 100, "skillSearchDigest:beta"],
      startInclusive: false,
    });
    expect(JSON.parse(result.nextCursor ?? "")).toEqual({
      v: 1,
      index: "by_active_name",
      key: [{ __undef: 1 }, "delta", 200, "skillSearchDigest:delta"],
    });
  });

  it("guards the public API list against stale index cursors too", async () => {
    const staleCursor = legacyCursor([{ __undef: 1 }, false, 100, 200]);

    await listPublicApiPageV1Handler({} as never, {
      cursor: staleCursor,
      sort: "updated",
      nonSuspiciousOnly: false,
      numItems: 10,
    });

    expect(getPageMock).toHaveBeenCalledTimes(1);
    expect(getPageMock.mock.calls[0]?.[1]).toMatchObject({
      index: "by_active_updated",
      startIndexKey: [undefined],
      startInclusive: true,
    });
  });

  it("paginates the public API list from getPage's full self-describing cursor", async () => {
    getPageMock
      .mockResolvedValueOnce({
        page: [],
        hasMore: true,
        indexKeys: [[undefined, 200, 201, "skillSearchDigest:alpha"]],
      })
      .mockResolvedValueOnce({
        page: [],
        hasMore: false,
        indexKeys: [[undefined, 300, 301, "skillSearchDigest:beta"]],
      });

    const first = await listPublicApiPageV1Handler({} as never, {
      sort: "updated",
      nonSuspiciousOnly: false,
      numItems: 1,
    });

    expect(first.nextCursor).not.toBeNull();
    expect(getPageMock.mock.calls[0]?.[1]).toMatchObject({
      index: "by_active_updated",
      startIndexKey: [undefined],
      startInclusive: true,
    });

    const second = await listPublicApiPageV1Handler({} as never, {
      cursor: first.nextCursor!,
      sort: "updated",
      nonSuspiciousOnly: false,
      numItems: 1,
    });

    expect(second.nextCursor).toBeNull();
    expect(getPageMock.mock.calls[1]?.[1]).toMatchObject({
      index: "by_active_updated",
      startIndexKey: [undefined, 200, 201, "skillSearchDigest:alpha"],
      startInclusive: false,
    });
  });

  it("paginates a slug prefix through the normalized-slug index", async () => {
    getPageMock
      .mockResolvedValueOnce({
        page: [],
        hasMore: true,
        indexKeys: [[undefined, "aigroup-alpha", 200, "skillSearchDigest:alpha"]],
      })
      .mockResolvedValueOnce({
        page: [],
        hasMore: false,
        indexKeys: [[undefined, "aigroup-beta", 300, "skillSearchDigest:beta"]],
      });

    const first = await listPublicApiPageV1Handler({} as never, {
      prefix: "aigroup-",
      numItems: 1,
    });

    expect(getPageMock.mock.calls[0]?.[1]).toMatchObject({
      index: "by_active_normalized_slug",
      startIndexKey: [undefined, "aigroup-"],
      startInclusive: true,
      endIndexKey: [undefined, "aigroup-\uffff"],
      endInclusive: false,
      order: "asc",
    });
    expect(first.nextCursor).not.toBeNull();

    const second = await listPublicApiPageV1Handler({} as never, {
      prefix: "aigroup-",
      cursor: first.nextCursor!,
      numItems: 1,
    });

    expect(getPageMock.mock.calls[1]?.[1]).toMatchObject({
      index: "by_active_normalized_slug",
      startIndexKey: [undefined, "aigroup-alpha", 200, "skillSearchDigest:alpha"],
      startInclusive: false,
    });
    expect(second.nextCursor).toBeNull();
  });

  it("does not reuse a prefix cursor for a different prefix", async () => {
    getPageMock.mockResolvedValueOnce({
      page: [],
      hasMore: false,
      indexKeys: [],
    });
    const cursor = `skillprefix:${JSON.stringify({
      prefix: "aigroup-",
      cursor: cursorForIndex("by_active_normalized_slug", [
        { __undef: 1 },
        "aigroup-alpha",
        200,
        "skillSearchDigest:alpha",
      ]),
    })}`;

    await listPublicApiPageV1Handler({} as never, {
      prefix: "ai",
      cursor,
      numItems: 1,
    });

    expect(getPageMock.mock.calls[0]?.[1]).toMatchObject({
      index: "by_active_normalized_slug",
      startIndexKey: [undefined, "ai"],
      startInclusive: true,
    });
  });

  it("does not apply inferred category filters while scanning public list pages", async () => {
    getPageMock.mockResolvedValueOnce({
      page: [
        makeDigest({
          slug: "navigation-without-screens",
          displayName: "Navigation Without Screens",
          summary: "Physical navigation skills without digital devices.",
          statsDownloads: 22,
        }),
        makeDigest({
          slug: "developer-utils",
          displayName: "Developer Utils",
          summary: "Utilities for build and debug workflows.",
          statsDownloads: 21,
        }),
      ],
      hasMore: false,
      indexKeys: [
        [undefined, 22, 1],
        [undefined, 21, 2],
      ],
    });

    const result = await listPublicPageV4Handler(
      {} as never,
      {
        categoryKeywords: ["dev", "debug", "lint", "test", "build"],
        categorySlug: "development",
        nonSuspiciousOnly: false,
        numItems: 10,
        sort: "downloads",
      } as PublicListArgs,
    );

    expect(getPageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        absoluteMaxRows: expect.any(Number),
        index: "by_active_stats_downloads",
      }),
    );
    expect(result.page).toEqual([]);
  });

  it("uses a stored category without requiring matching inference keywords", async () => {
    getPageMock.mockResolvedValueOnce({
      page: [
        makeDigest({
          slug: "navigation-without-screens",
          displayName: "Navigation Without Screens",
          summary: "Physical navigation skills without digital devices.",
          categories: ["development"],
          statsDownloads: 22,
        }),
      ],
      hasMore: false,
      indexKeys: [[undefined, 22, 1]],
    });

    const result = await listPublicPageV4Handler({} as never, {
      categoryKeywords: ["dev", "debug", "lint", "test", "build"],
      categorySlug: "development",
      nonSuspiciousOnly: false,
      numItems: 10,
      sort: "downloads",
    });

    expect(
      (result.page as Array<{ skill: { slug: string } }>).map((entry) => entry.skill.slug),
    ).toEqual(["navigation-without-screens"]);
  });

  it("does not exclude Other skills by inferred keywords", async () => {
    getPageMock.mockResolvedValueOnce({
      page: [
        makeDigest({
          slug: "explicit-code-calendar-helper",
          displayName: "Explicit Code Calendar Helper",
          summary: "API utilities for calendar workflows.",
          categories: ["other"],
          statsDownloads: 22,
        }),
        makeDigest({
          slug: "implicit-code-calendar-helper",
          displayName: "Implicit Code Calendar Helper",
          summary: "API utilities for calendar workflows.",
          statsDownloads: 21,
        }),
      ],
      hasMore: false,
      indexKeys: [
        [undefined, 22, 1],
        [undefined, 21, 2],
      ],
    });

    const result = await listPublicPageV4Handler({} as never, {
      categorySlug: "other",
      excludeCategoryKeywords: ["code", "api", "calendar"],
      nonSuspiciousOnly: false,
      numItems: 10,
      sort: "downloads",
    });

    expect(
      (result.page as Array<{ skill: { slug: string } }>).map((entry) => entry.skill.slug),
    ).toEqual(["explicit-code-calendar-helper", "implicit-code-calendar-helper"]);
  });

  it("paginates curated category skills before community fallback", async () => {
    const official = makeSearchDigest({
      skillId: "skills:official-dev",
      slug: "official-dev",
      displayName: "Official Dev",
      categories: ["development"],
      badges: { official: { byUserId: "users:admin", at: 1 } },
      updatedAt: 1,
    });
    const community = makeSearchDigest({
      skillId: "skills:community-dev",
      slug: "community-dev",
      displayName: "Community Dev",
      categories: ["development"],
      updatedAt: 2,
    });
    const ctx = makeOfficialFirstCategoryCtx([official]);
    getPageMock
      .mockResolvedValueOnce({
        page: [official],
        hasMore: false,
        indexKeys: [[undefined, 1, 1, "curatedSkillSearchDigest:official-dev"]],
      })
      .mockResolvedValueOnce({
        page: [community, official],
        hasMore: false,
        indexKeys: [
          [undefined, 2, 2, "skillSearchDigest:community-dev"],
          [undefined, 1, 1, "skillSearchDigest:official-dev"],
        ],
      })
      .mockResolvedValueOnce({
        page: [community, official],
        hasMore: false,
        indexKeys: [
          [undefined, 2, 2, "skillSearchDigest:community-dev"],
          [undefined, 1, 1, "skillSearchDigest:official-dev"],
        ],
      })
      .mockResolvedValueOnce({
        page: [official],
        hasMore: false,
        indexKeys: [[undefined, 1, 1, "skillSearchDigest:official-dev"]],
      });

    const first = await listPublicPageV4Handler(ctx as never, {
      categorySlug: "development",
      officialFirst: true,
      numItems: 1,
      sort: "updated",
    });
    expect(
      (first.page as Array<{ skill: { slug: string } }>).map((entry) => entry.skill.slug),
    ).toEqual(["official-dev"]);
    expect(first.hasMore).toBe(true);

    const second = await listPublicPageV4Handler(ctx as never, {
      cursor: first.nextCursor!,
      categorySlug: "development",
      officialFirst: true,
      numItems: 1,
      sort: "updated",
    });
    expect(
      (second.page as Array<{ skill: { slug: string } }>).map((entry) => entry.skill.slug),
    ).toEqual(["community-dev"]);
    expect(second.hasMore).toBe(true);

    const third = await listPublicPageV4Handler(ctx as never, {
      cursor: second.nextCursor!,
      categorySlug: "development",
      officialFirst: true,
      numItems: 1,
      sort: "updated",
    });
    expect(third.page).toEqual([]);
    expect(third.nextCursor).toBeNull();
  });

  it("does not advertise an empty community page after a full curated category page", async () => {
    const official = makeSearchDigest({
      skillId: "skills:official-dev",
      slug: "official-dev",
      displayName: "Official Dev",
      categories: ["development"],
      badges: { official: { byUserId: "users:admin", at: 1 } },
      updatedAt: 1,
    });
    const ctx = makeOfficialFirstCategoryCtx([official]);
    getPageMock.mockResolvedValue({
      page: [official],
      hasMore: false,
      indexKeys: [[undefined, 1, 1, "skillSearchDigest:official-dev"]],
    });

    const result = await listPublicPageV4Handler(ctx as never, {
      categorySlug: "development",
      officialFirst: true,
      numItems: 1,
      sort: "updated",
    });

    expect(
      (result.page as Array<{ skill: { slug: string } }>).map((entry) => entry.skill.slug),
    ).toEqual(["official-dev"]);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("uses the indexed curated projection instead of a capped badge list", async () => {
    const official = makeSearchDigest({
      skillId: "skills:older-official-dev",
      slug: "older-official-dev",
      displayName: "Older Official Dev",
      categories: ["development"],
      badges: { official: { byUserId: "users:admin", at: 1 } },
      updatedAt: 1,
    });
    const ctx = makeOfficialFirstCategoryCtx([official]);
    getPageMock
      .mockResolvedValueOnce({
        page: [official],
        hasMore: false,
        indexKeys: [[undefined, 1, 1, "curatedSkillSearchDigest:older-official-dev"]],
      })
      .mockResolvedValueOnce({ page: [], hasMore: false, indexKeys: [] });

    const result = await listPublicPageV4Handler(ctx as never, {
      categorySlug: "development",
      officialFirst: true,
      numItems: 1,
      sort: "updated",
    });

    expect(
      (result.page as Array<{ skill: { slug: string } }>).map((entry) => entry.skill.slug),
    ).toEqual(["older-official-dev"]);
    expect(getPageMock.mock.calls[0]?.[1]).toMatchObject({
      table: "curatedSkillSearchDigest",
      index: "by_active_updated",
    });
    expect(ctx.db.query).not.toHaveBeenCalledWith("skillBadges");
  });

  it("hydrates only curated rows that match the requested category page", async () => {
    const research = makeSearchDigest({
      skillId: "skills:official-research",
      slug: "official-research",
      displayName: "Official Research",
      categories: ["research"],
      badges: { official: { byUserId: "users:admin", at: 2 } },
      updatedAt: 2,
    });
    const development = makeSearchDigest({
      skillId: "skills:official-dev",
      slug: "official-dev",
      displayName: "Official Dev",
      categories: ["development"],
      badges: { highlighted: { byUserId: "users:admin", at: 1 } },
      updatedAt: 1,
    });
    const ctx = makeOfficialFirstCategoryCtx([research, development]);
    getPageMock
      .mockResolvedValueOnce({
        page: [research, development],
        hasMore: false,
        indexKeys: [
          [undefined, 2, 2, "curatedSkillSearchDigest:official-research"],
          [undefined, 1, 1, "curatedSkillSearchDigest:official-dev"],
        ],
      })
      .mockResolvedValueOnce({ page: [], hasMore: false, indexKeys: [] });

    const result = await listPublicPageV4Handler(ctx as never, {
      categorySlug: "development",
      officialFirst: true,
      numItems: 1,
      sort: "updated",
    });

    expect(
      (result.page as Array<{ skill: { slug: string } }>).map((entry) => entry.skill.slug),
    ).toEqual(["official-dev"]);
    expect(ctx.db.query).toHaveBeenCalledTimes(1);
    expect(ctx.db.query).toHaveBeenCalledWith("skillSearchDigest");
  });

  it("preserves community scan progress after a sparse category probe", async () => {
    const official = makeSearchDigest({
      skillId: "skills:official-dev",
      slug: "official-dev",
      displayName: "Official Dev",
      categories: ["development"],
      badges: { official: { byUserId: "users:admin", at: 1 } },
      updatedAt: 1,
    });
    const community = makeSearchDigest({
      skillId: "skills:community-dev",
      slug: "community-dev",
      displayName: "Community Dev",
      categories: ["development"],
      updatedAt: 2,
    });
    const ctx = makeOfficialFirstCategoryCtx([official]);
    getPageMock.mockResolvedValueOnce({
      page: [official],
      hasMore: false,
      indexKeys: [[undefined, 1, 1, "curatedSkillSearchDigest:official-dev"]],
    });
    for (let downloads = 100; downloads > 96; downloads -= 1) {
      getPageMock.mockResolvedValueOnce({
        page: [
          makeSearchDigest({
            skillId: `skills:research-${downloads}`,
            slug: `research-${downloads}`,
            categories: ["research"],
            statsDownloads: downloads,
          }),
        ],
        hasMore: true,
        indexKeys: [[undefined, downloads, downloads, `skillSearchDigest:research-${downloads}`]],
      });
    }
    getPageMock.mockResolvedValueOnce({
      page: [community],
      hasMore: false,
      indexKeys: [[undefined, 2, 2, "skillSearchDigest:community-dev"]],
    });

    const first = await listPublicPageV4Handler(ctx as never, {
      categorySlug: "development",
      officialFirst: true,
      numItems: 1,
      sort: "updated",
    });
    expect(
      (first.page as Array<{ skill: { slug: string } }>).map((entry) => entry.skill.slug),
    ).toEqual(["official-dev"]);
    expect(first.hasMore).toBe(true);

    const second = await listPublicPageV4Handler(ctx as never, {
      cursor: first.nextCursor!,
      categorySlug: "development",
      officialFirst: true,
      numItems: 1,
      sort: "updated",
    });

    expect(
      (second.page as Array<{ skill: { slug: string } }>).map((entry) => entry.skill.slug),
    ).toEqual(["community-dev"]);
    expect(getPageMock.mock.calls[5]?.[1].startIndexKey).toEqual([
      undefined,
      97,
      97,
      "skillSearchDigest:research-97",
    ]);
  });

  it("continues filtered public list pagination across empty scan windows", async () => {
    const emptySecurityWindow = (downloads: number) => ({
      page: [
        makeDigest({
          slug: `weather-helper-${downloads}`,
          displayName: "Weather Helper",
          summary: "Get current forecasts.",
          statsDownloads: downloads,
        }),
      ],
      hasMore: true,
      indexKeys: [[undefined, downloads, downloads]],
    });
    getPageMock
      .mockResolvedValueOnce(emptySecurityWindow(30))
      .mockResolvedValueOnce(emptySecurityWindow(29))
      .mockResolvedValueOnce(emptySecurityWindow(28))
      .mockResolvedValueOnce(emptySecurityWindow(27));

    const result = await listPublicPageV4Handler({} as never, {
      categoryKeywords: ["security", "scan", "auth", "encrypt"],
      categorySlug: "security",
      nonSuspiciousOnly: false,
      numItems: 10,
      sort: "downloads",
    });

    expect(result.page).toEqual([]);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBeTruthy();
  });

  it("drops stale API list latest versions that belong to another skill", async () => {
    getPageMock.mockResolvedValueOnce({
      page: [
        makeSearchDigest({
          latestVersionId: "skillVersions:other",
          latestVersionSkillId: "skills:other",
          latestVersionSummary: {
            version: "9.9.9",
            createdAt: 9,
            changelog: "other",
            changelogSource: "user",
            clawdis: undefined,
          },
        }),
      ],
      hasMore: false,
      indexKeys: [],
    });

    const result = await listPublicApiPageV1Handler({} as never, {
      numItems: 10,
      sort: "updated",
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ latestVersion: null });
  });

  it("carries author topics through the public API list", async () => {
    getPageMock.mockResolvedValueOnce({
      page: [
        makeSearchDigest({
          topics: ["Calendar", "Official"],
        }),
      ],
      hasMore: false,
      indexKeys: [],
    });

    const result = await listPublicApiPageV1Handler({} as never, {
      numItems: 10,
      sort: "updated",
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      ownerHandle: "owner",
      skill: {
        slug: "demo",
        topics: ["Calendar", "Official"],
      },
    });
  });

  it("keeps verified legacy API list latest versions without owner markers", async () => {
    getPageMock.mockResolvedValueOnce({
      page: [
        makeSearchDigest({
          latestVersionSkillId: undefined,
        }),
      ],
      hasMore: false,
      indexKeys: [],
    });

    const result = await listPublicApiPageV1Handler(
      {
        db: {
          get: vi.fn(async (id: string) =>
            id === "skillVersions:1"
              ? {
                  _id: id,
                  skillId: "skills:demo",
                  version: "1.0.0",
                  softDeletedAt: undefined,
                }
              : null,
          ),
        },
      } as never,
      { numItems: 10, sort: "updated" },
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      latestVersion: {
        version: "1.0.0",
      },
    });
  });

  it("carries denormalized latest-version descriptions through the public API list", async () => {
    getPageMock.mockResolvedValueOnce({
      page: [
        makeSearchDigest({
          latestVersionSummary: {
            version: "1.0.0",
            createdAt: 9,
            changelog: "initial",
            changelogSource: "user",
            description: "Long-form frontmatter description.",
            clawdis: {
              requires: { env: ["HA_TOKEN"] },
            },
          },
        }),
      ],
      hasMore: false,
      indexKeys: [],
    });

    const result = await listPublicApiPageV1Handler({} as never, {
      numItems: 10,
      sort: "updated",
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      latestVersion: {
        parsed: {
          description: "Long-form frontmatter description.",
          clawdis: {
            requires: { env: ["HA_TOKEN"] },
          },
        },
      },
    });
  });

  it("loads the approved digest version directly for a pending update", async () => {
    const get = vi.fn(async (id: string) =>
      id === "skillVersions:approved"
        ? {
            _id: id,
            skillId: "skills:demo",
            version: "1.0.0",
            createdAt: 8,
            changelog: "approved",
            softDeletedAt: undefined,
          }
        : null,
    );
    getPageMock.mockResolvedValueOnce({
      page: [
        makeSearchDigest({
          moderationReason: "pending.scan",
          stats: { downloads: 0, stars: 0, versions: 2, comments: 0 },
          latestVersionId: "skillVersions:pending",
          publicVersion: {
            status: "available",
            versionId: "skillVersions:approved",
          },
        }),
      ],
      hasMore: false,
      indexKeys: [],
    });

    const result = await listPublicApiPageV1Handler({ db: { get } } as never, {
      numItems: 10,
      sort: "updated",
    });

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("skillVersions:approved");
    expect(result.items[0]).toMatchObject({
      latestVersion: {
        version: "1.0.0",
      },
    });
  });

  it("carries topics through the public API list projection", async () => {
    getPageMock.mockResolvedValueOnce({
      page: [
        makeSearchDigest({
          topics: ["Calendar", "Scheduling"],
        }),
      ],
      hasMore: false,
      indexKeys: [],
    });

    const result = await listPublicApiPageV1Handler({} as never, {
      numItems: 10,
      sort: "updated",
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      skill: {
        topics: ["Calendar", "Scheduling"],
      },
    });
  });

  it("drops stale trending latest versions that belong to another skill", async () => {
    const staleDigest = makeSearchDigest({
      latestVersionId: "skillVersions:other",
      latestVersionSkillId: "skills:other",
      latestVersionSummary: {
        version: "9.9.9",
        createdAt: 9,
        changelog: "other",
        changelogSource: "user",
        clawdis: undefined,
      },
    });
    const ctx = {
      db: {
        query: vi.fn((table: string) => {
          if (table === "skillLeaderboards") {
            return {
              withIndex: () => ({
                order: () => ({
                  first: async () => ({ items: [{ skillId: "skills:demo" }] }),
                }),
              }),
            };
          }
          if (table === "skillSearchDigest") {
            return {
              withIndex: () => ({
                unique: async () => staleDigest,
              }),
            };
          }
          throw new Error(`unexpected table ${table}`);
        }),
      },
    };

    const result = await listPublicTrendingPageHandler(ctx as never, { limit: 10 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ latestVersion: null });
  });

  it("falls back to the general trending snapshot during non-suspicious rollout", async () => {
    const digest = makeSearchDigest();
    const requestedKinds: string[] = [];
    const ctx = {
      db: {
        query: vi.fn((table: string) => {
          if (table === "skillLeaderboards") {
            return {
              withIndex: vi.fn(
                (
                  _indexName: string,
                  builder: (q: { eq: (field: string, value: string) => unknown }) => unknown,
                ) => {
                  const queryBuilder = {
                    eq: (_field: string, value: string) => {
                      requestedKinds.push(value);
                      return queryBuilder;
                    },
                  };
                  builder(queryBuilder);
                  return {
                    order: () => ({
                      first: async () =>
                        requestedKinds.at(-1) === "trending_non_suspicious"
                          ? null
                          : { items: [{ skillId: "skills:demo" }] },
                    }),
                  };
                },
              ),
            };
          }
          if (table === "skillSearchDigest") {
            return {
              withIndex: () => ({
                unique: async () => digest,
              }),
            };
          }
          throw new Error(`unexpected table ${table}`);
        }),
      },
    };

    const result = await listPublicTrendingPageHandler(ctx as never, {
      limit: 10,
      nonSuspiciousOnly: true,
    });

    expect(requestedKinds).toEqual(["trending_non_suspicious", "trending"]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ skill: { slug: "demo" } });
  });

  it("warms trending with recent public skills before the first snapshot exists", async () => {
    const digest = makeSearchDigest({ updatedAt: 12 });
    const ctx = {
      db: {
        query: vi.fn((table: string) => {
          if (table === "skillLeaderboards") {
            return {
              withIndex: () => ({
                order: () => ({
                  first: async () => null,
                }),
              }),
            };
          }
          if (table === "skillSearchDigest") {
            return {
              withIndex: () => ({
                order: () => ({
                  take: async () => [digest],
                }),
              }),
            };
          }
          throw new Error(`unexpected table ${table}`);
        }),
      },
    };

    const result = await listPublicTrendingPageHandler(ctx as never, {
      limit: 10,
      nonSuspiciousOnly: true,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ skill: { slug: "demo" } });
  });

  it("keeps verified legacy trending latest versions without owner markers", async () => {
    const legacyDigest = makeSearchDigest({
      latestVersionSkillId: undefined,
    });
    const ctx = {
      db: {
        get: vi.fn(async (id: string) =>
          id === "skillVersions:1"
            ? {
                _id: id,
                skillId: "skills:demo",
                version: "1.0.0",
                softDeletedAt: undefined,
              }
            : null,
        ),
        query: vi.fn((table: string) => {
          if (table === "skillLeaderboards") {
            return {
              withIndex: () => ({
                order: () => ({
                  first: async () => ({ items: [{ skillId: "skills:demo" }] }),
                }),
              }),
            };
          }
          if (table === "skillSearchDigest") {
            return {
              withIndex: () => ({
                unique: async () => legacyDigest,
              }),
            };
          }
          throw new Error(`unexpected table ${table}`);
        }),
      },
    };

    const result = await listPublicTrendingPageHandler(ctx as never, { limit: 10 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      latestVersion: {
        version: "1.0.0",
      },
    });
  });

  it("orders public audit skills by downloads", async () => {
    const digest = makeSearchDigest({ latestVersionId: undefined });
    const withIndex = vi.fn(() => ({
      order: vi.fn(() => ({
        paginate: vi.fn().mockResolvedValue({
          page: [digest],
          isDone: true,
          continueCursor: "",
        }),
      })),
    }));
    const ctx = {
      db: {
        query: vi.fn((table: string) => {
          if (table !== "skillSearchDigest") throw new Error(`unexpected table ${table}`);
          return { withIndex };
        }),
        get: vi.fn(),
      },
    };

    const result = await listAuditPageHandler(ctx as never, {
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(result.page).toHaveLength(1);
    expect(withIndex).toHaveBeenCalledWith("by_active_stats_downloads", expect.any(Function));
  });

  it("drops audit latest versions that resolve to another skill", async () => {
    const digest = makeSearchDigest({
      latestVersionId: "skillVersions:other",
      latestVersionSkillId: undefined,
    });
    const withIndex = vi.fn(() => ({
      order: vi.fn(() => ({
        paginate: vi.fn().mockResolvedValue({
          page: [digest],
          isDone: true,
          continueCursor: "",
        }),
      })),
    }));
    const ctx = {
      db: {
        get: vi.fn(async (id: string) => {
          if (id === "skillVersions:other") {
            return {
              _id: id,
              _creationTime: 1,
              skillId: "skills:other",
              version: "9.9.9",
              createdAt: 9,
              files: [],
              vtAnalysis: { status: "clean" },
              llmAnalysis: { status: "clean" },
              staticScan: { status: "clean", reasonCodes: [], findings: [] },
              softDeletedAt: undefined,
            };
          }
          return null;
        }),
        query: vi.fn((table: string) => {
          if (table !== "skillSearchDigest") throw new Error(`unexpected table ${table}`);
          return { withIndex };
        }),
      },
    };

    const result = await listAuditPageHandler(ctx as never, {
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(result.page).toHaveLength(1);
    expect(result.page[0]).toMatchObject({ latestVersion: null });
  });
});

function makeDigest(overrides: Record<string, unknown>) {
  return {
    _id: `skillSearchDigest:${String(overrides.slug)}`,
    _creationTime: 0,
    skillId: `skills:${String(overrides.slug)}`,
    slug: String(overrides.slug),
    displayName: String(overrides.displayName ?? overrides.slug),
    summary: overrides.summary,
    ownerUserId: "users:owner",
    ownerPublisherId: "publishers:owner",
    ownerHandle: "owner",
    ownerKind: "user",
    ownerDisplayName: "Owner",
    tags: {},
    badges: {},
    stats: {
      downloads: 0,
      installsCurrent: 0,
      installsAllTime: 0,
      stars: 0,
      versions: 1,
      comments: 0,
    },
    statsDownloads: overrides.statsDownloads ?? 0,
    statsStars: 0,
    statsInstallsCurrent: 0,
    statsInstallsAllTime: 0,
    softDeletedAt: overrides.softDeletedAt,
    moderationStatus: overrides.moderationStatus ?? "active",
    moderationFlags: overrides.moderationFlags,
    isSuspicious: overrides.isSuspicious,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("skills.listRelatedByCategory", () => {
  it("uses an indexed bounded digest query and returns matching public category skills", async () => {
    const digests = [
      makeDigest({
        skillId: "skills:current",
        slug: "workflow-runner",
        displayName: "Workflow Runner",
        summary: "Build workflow pipelines.",
      }),
      makeDigest({
        slug: "pipeline-builder",
        displayName: "Pipeline Builder",
        summary: "Compose workflow automations.",
        statsDownloads: 20,
      }),
      makeDigest({
        slug: "calendar",
        displayName: "Calendar",
        summary: "Track meetings.",
        statsDownloads: 18,
      }),
      makeDigest({
        slug: "hidden-workflow",
        displayName: "Hidden Workflow",
        summary: "Workflow helper.",
        moderationStatus: "hidden",
        statsDownloads: 16,
      }),
      makeDigest({
        slug: "suspicious-workflow",
        displayName: "Suspicious Workflow",
        summary: "Workflow helper.",
        moderationFlags: ["flagged.suspicious"],
        isSuspicious: true,
        statsDownloads: 14,
      }),
      makeDigest({
        slug: "workflow-audit",
        displayName: "Workflow Audit",
        summary: "Review workflow runs.",
        statsDownloads: 12,
      }),
    ];
    const take = vi.fn().mockResolvedValue(digests);
    const order = vi.fn(() => ({ take }));
    const eq = vi.fn(() => ({ eq }));
    const withIndex = vi.fn((_index: string, builder: (q: { eq: typeof eq }) => void) => {
      builder({ eq });
      return { order };
    });
    const query = vi.fn((table: string) => {
      if (table === "officialPublishers") {
        return {
          withIndex: vi.fn(() => ({
            unique: vi.fn().mockResolvedValue(null),
          })),
        };
      }
      if (table !== "skillSearchDigest") throw new Error(`Unexpected query table: ${table}`);
      return { withIndex };
    });

    const result = await listRelatedByCategoryHandler({ db: { query } } as never, {
      skillId: "skills:current",
      keywords: ["workflow"],
      limit: 2,
    });

    expect(withIndex).toHaveBeenCalledWith("by_active_stats_downloads", expect.any(Function));
    expect(eq).toHaveBeenCalledWith("softDeletedAt", undefined);
    expect(order).toHaveBeenCalledWith("desc");
    expect(take).toHaveBeenCalledWith(expect.any(Number));
    expect(result.items.map((entry) => entry.skill.slug)).toEqual([
      "pipeline-builder",
      "workflow-audit",
    ]);
    expect(result.items[0]?.ownerHandle).toBe("owner");
  });

  it("does not use inferred categories for related skill suggestions", async () => {
    const digests = [
      makeDigest({
        skillId: "skills:current",
        slug: "debug-helper",
        displayName: "Debug Helper",
        summary: "Debug build failures.",
      }),
      makeDigest({
        slug: "navigation-without-screens",
        displayName: "Navigation Without Screens",
        summary: "Physical navigation skills without digital devices.",
        statsDownloads: 22,
      }),
      makeDigest({
        slug: "developer-utils",
        displayName: "Developer Utils",
        summary: "Utilities for build and debug workflows.",
        statsDownloads: 21,
      }),
      makeDigest({
        slug: "web3-dev",
        displayName: "Blockscout for Web3 Dev",
        summary:
          "Build web3 applications that need blockchain data via the Blockscout PRO API over HTTP.",
        statsDownloads: 19,
      }),
      makeDigest({
        slug: "dev-jh86ceyb-weather-helper",
        displayName: "Weather Helper",
        summary: "Get current forecasts.",
        statsDownloads: 20,
      }),
      makeDigest({
        slug: "build-runner",
        displayName: "Build Runner",
        summary: "Run build checks.",
        statsDownloads: 18,
      }),
    ];
    const take = vi.fn().mockResolvedValue(digests);
    const order = vi.fn(() => ({ take }));
    const eq = vi.fn(() => ({ eq }));
    const withIndex = vi.fn((_index: string, builder: (q: { eq: typeof eq }) => void) => {
      builder({ eq });
      return { order };
    });
    const query = vi.fn((table: string) => {
      if (table === "officialPublishers") {
        return {
          withIndex: vi.fn(() => ({
            unique: vi.fn().mockResolvedValue(null),
          })),
        };
      }
      if (table !== "skillSearchDigest") throw new Error(`Unexpected query table: ${table}`);
      return { withIndex };
    });

    const result = await listRelatedByCategoryHandler({ db: { query } } as never, {
      skillId: "skills:current",
      categorySlug: "development",
      keywords: ["dev", "debug", "lint", "test", "build"],
      limit: 3,
    });

    expect(result.items).toEqual([]);
  });

  it("uses explicit categories without requiring inference keywords for suggestions", async () => {
    const explicitlyCategorized = makeDigest({
      slug: "navigation-without-screens",
      displayName: "Navigation Without Screens",
      summary: "Physical navigation skills without digital devices.",
      categories: ["development"],
      statsDownloads: 22,
    });
    const take = vi.fn().mockResolvedValue([explicitlyCategorized]);
    const order = vi.fn(() => ({ take }));
    const eq = vi.fn(() => ({ eq }));
    const withIndex = vi.fn((_index: string, builder: (q: { eq: typeof eq }) => void) => {
      builder({ eq });
      return { order };
    });
    const query = vi.fn((table: string) => {
      if (table === "officialPublishers") {
        return {
          withIndex: vi.fn(() => ({
            unique: vi.fn().mockResolvedValue(null),
          })),
        };
      }
      return { withIndex };
    });

    const result = await listRelatedByCategoryHandler({ db: { query } } as never, {
      skillId: "skills:current",
      categorySlug: "development",
      keywords: ["dev", "debug", "lint", "test", "build"],
      limit: 3,
    });

    expect(result.items.map((entry) => entry.skill.slug)).toEqual(["navigation-without-screens"]);
  });
});
