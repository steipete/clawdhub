import { getCatalogTopicSlugs, normalizeCatalogTopic } from "clawhub-schema";
import { useAction } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { api } from "../../../convex/_generated/api";
import { convexHttp } from "../../convex/client";
import { fetchCatalogDiscoveryCapabilities } from "../../lib/catalogDiscoveryCapabilities";
import {
  ALL_CATEGORY_KEYWORDS,
  getSkillCategoryBySlug,
  getSkillCategoriesForSkill,
} from "../../lib/categories";
import { fetchCanonicalTrendingPage, type TrendingFeedState } from "../../lib/trendingApi";
import { parseDir, parseSort, toListSort, type SortDir, type SortKey } from "./-params";
import {
  isExternalSkillListEntry,
  isTrendingSkillListEntry,
  type SkillListEntry,
  type SkillSearchEntry,
} from "./-types";

export const SKILLS_PAGE_SIZE = 20;
const featuredPageSize = 40;
const newWindowMs = 14 * 24 * 60 * 60 * 1_000;
const maxConsecutiveEmptyPagesPerFetch = 3;

function isNavigationAbortError(err: unknown) {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "AbortError" || err.message === "Failed to fetch" || err.message === "Load failed"
  );
}

export type SkillsView = "grid" | "list";
export type SkillsCatalogTab = "trending" | "new" | "featured" | "official";
type LegacySkillsView = SkillsView | "cards";

export function normalizeSkillsView(value: unknown): SkillsView | undefined {
  if (value === "list") return "list";
  if (value === "grid" || value === "cards") return "grid";
  return undefined;
}

export type SkillsSearchState = {
  q?: string;
  sort?: SortKey;
  dir?: SortDir;
  highlighted?: boolean;
  featured?: boolean;
  category?: string;
  topic?: string;
  view?: LegacySkillsView;
  focus?: "search";
  tab?: SkillsCatalogTab;
};

export function normalizeSkillsCatalogTab(
  value: unknown,
  legacy?: Pick<SkillsSearchState, "featured" | "highlighted" | "sort" | "category" | "topic">,
): SkillsCatalogTab {
  if (value === "trending" || value === "new" || value === "featured" || value === "official") {
    return value;
  }
  if (legacy?.featured || legacy?.highlighted) return "featured";
  if (legacy?.sort === "newest") return "new";
  if (legacy?.category || legacy?.topic) return "new";
  return "trending";
}

export type InitialSkillsSearchData = {
  key: string;
  limit: number;
  results: SkillSearchEntry[];
} | null;

export type InitialSkillsListData = {
  kind: "canonical";
  results: SkillListEntry[];
  nextCursor: string | null;
  trendingState: TrendingFeedState;
};

type SkillsNavigate = (options: {
  search: (prev: SkillsSearchState) => SkillsSearchState;
  replace?: boolean;
}) => void | Promise<void>;

type ListStatus = "loading" | "idle" | "loadingMore" | "done" | "error";

export function buildSkillsSearchKey({
  categorySlug,
  featuredOnly,
  query,
  topic,
}: {
  categorySlug?: string;
  featuredOnly: boolean;
  query: string;
  topic?: string;
}) {
  const trimmed = query.trim();
  return trimmed
    ? `${trimmed}::${featuredOnly ? "1" : "0"}::${categorySlug ?? ""}::${topic ?? ""}`
    : "";
}

export function useSkillsBrowseModel({
  initialList,
  initialSearch,
  search,
  navigate,
  searchInputRef,
}: {
  initialList?: InitialSkillsListData;
  initialSearch?: InitialSkillsSearchData;
  search: SkillsSearchState;
  navigate: SkillsNavigate;
  searchInputRef: RefObject<HTMLInputElement | null>;
}) {
  const [query, setQuery] = useState(search.q ?? "");
  const [canonicalTrendingUnavailable, setCanonicalTrendingUnavailable] = useState(false);
  const searchRequest = useRef(0);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const loadMoreInFlightRef = useRef(false);
  const retryInFlightRef = useRef(false);
  const navigateTimer = useRef<number>(0);

  const view: SkillsView = normalizeSkillsView(search.view) ?? "list";
  const featuredOnly = search.featured ?? search.highlighted ?? false;
  const searchSkills = useAction(api.search.searchSkills);

  const trimmedQuery = useMemo(() => query.trim(), [query]);
  const urlCategory = useMemo(() => getSkillCategoryBySlug(search.category), [search.category]);
  const activeCategory = urlCategory;
  const activeTopic = search.topic ? normalizeCatalogTopic(search.topic) : undefined;
  const categoryKeywords =
    activeCategory && activeCategory.slug !== "other" ? activeCategory.keywords : undefined;
  const excludeCategoryKeywords =
    activeCategory?.slug === "other" ? ALL_CATEGORY_KEYWORDS : undefined;
  const hasQuery = trimmedQuery.length > 0;
  const requestedCatalogTab = normalizeSkillsCatalogTab(search.tab, search);
  const catalogTab =
    requestedCatalogTab === "trending" && canonicalTrendingUnavailable
      ? "featured"
      : requestedCatalogTab;
  const requestedSort = hasQuery
    ? search.sort === "default"
      ? "recommended"
      : search.sort
    : catalogTab === "new" || catalogTab === "official"
      ? "newest"
      : catalogTab === "featured"
        ? "updated"
        : "trending";
  const sort: SortKey =
    requestedSort === "relevance" && !hasQuery
      ? "recommended"
      : requestedSort === "recommended" && hasQuery
        ? "relevance"
        : (requestedSort ?? (hasQuery ? "relevance" : "recommended"));
  const listSort = sort === "trending" ? undefined : toListSort(sort);
  const dir = sort === "relevance" ? "desc" : parseDir(search.dir, sort);
  const searchKey = buildSkillsSearchKey({
    query: trimmedQuery,
    featuredOnly,
    categorySlug: activeCategory?.slug,
    topic: activeTopic,
  });
  const matchedInitialSearch = initialSearch?.key === searchKey ? initialSearch : null;
  const initialSearchMatches = matchedInitialSearch !== null;
  const [searchResults, setSearchResults] = useState<Array<SkillSearchEntry>>(() =>
    matchedInitialSearch ? matchedInitialSearch.results : [],
  );
  const [searchLimit, setSearchLimit] = useState(() =>
    matchedInitialSearch ? matchedInitialSearch.limit : SKILLS_PAGE_SIZE,
  );
  const [isSearching, setIsSearching] = useState(() => hasQuery && !initialSearchMatches);
  const appliedInitialSearchKey = useRef(matchedInitialSearch ? matchedInitialSearch.key : null);

  // One-shot paginated fetches (no reactive subscription)
  const matchedInitialList = !hasQuery && requestedCatalogTab === "trending" ? initialList : null;
  const [listResults, setListResults] = useState<SkillListEntry[]>(
    () => matchedInitialList?.results ?? [],
  );
  const [listCursor, setListCursor] = useState<string | null>(
    () => matchedInitialList?.nextCursor ?? null,
  );
  const [listStatus, setListStatus] = useState<ListStatus>(() =>
    matchedInitialList?.nextCursor ? "idle" : matchedInitialList ? "done" : "loading",
  );
  const [trendingState, setTrendingState] = useState<TrendingFeedState | undefined>(
    () => matchedInitialList?.trendingState,
  );
  const [, setListAutoLoadPaused] = useState(false);
  const fetchGeneration = useRef(0);
  const appliedInitialList = useRef(matchedInitialList);
  const newCutoff = useMemo(() => Date.now() - newWindowMs, [catalogTab]);

  const fetchPage = useCallback(
    async (cursor: string | null, generation: number) => {
      let pageCursor = cursor;
      let consecutiveEmptyPages = 0;
      try {
        if (catalogTab === "trending") {
          // Trending selection clears category/topic URL state and hides those controls.
          // Consume the one canonical order instead of constructing filtered variants.
          const capabilities = await fetchCatalogDiscoveryCapabilities();
          if (!capabilities.canonicalTrendingEnabled) {
            if (generation !== fetchGeneration.current) return;
            setCanonicalTrendingUnavailable(true);
            setListResults([]);
            setListCursor(null);
            setListAutoLoadPaused(false);
            setTrendingState("unavailable");
            setListStatus("done");
            return;
          }

          const result = await fetchCanonicalTrendingPage({
            cursor: pageCursor,
            limit: SKILLS_PAGE_SIZE,
          });
          if (generation !== fetchGeneration.current) return;
          const entries = result.items.map((trending) => ({ trending }));
          setCanonicalTrendingUnavailable(false);
          setListResults((prev) => (cursor ? [...prev, ...entries] : entries));
          setListCursor(result.nextCursor);
          setListAutoLoadPaused(false);
          setTrendingState(entries.length > 0 || result.nextCursor ? "available" : "empty");
          setListStatus(result.nextCursor ? "idle" : "done");
          return;
        }
        const capabilities =
          catalogTab === "new"
            ? await fetchCatalogDiscoveryCapabilities()
            : { apiVersion: 1 as const };
        while (true) {
          const result = await convexHttp.query(api.skills.listPublicPageV4, {
            cursor: pageCursor ?? undefined,
            numItems: catalogTab === "featured" ? featuredPageSize : SKILLS_PAGE_SIZE,
            ...(listSort ? { sort: listSort } : {}),
            dir,
            highlightedOnly: catalogTab === "featured" ? true : undefined,
            officialOnly: catalogTab === "official" ? true : undefined,
            ...(catalogTab === "new" && capabilities.apiVersion >= 1
              ? { createdAfter: newCutoff }
              : {}),
            categorySlug: activeCategory?.slug,
            topic: activeTopic,
            ...(activeCategory && catalogTab !== "new" && catalogTab !== "official"
              ? { officialFirst: true }
              : {}),
            categoryKeywords,
            excludeCategoryKeywords,
          });
          if (generation !== fetchGeneration.current) return;
          const visiblePage =
            catalogTab === "new" && capabilities.apiVersion === 0
              ? result.page.filter((entry) => entry.skill.createdAt >= newCutoff)
              : result.page;
          const reachedLegacyNewCutoff =
            catalogTab === "new" &&
            capabilities.apiVersion === 0 &&
            result.page.some((entry) => entry.skill.createdAt < newCutoff);
          const nextCursor =
            catalogTab !== "featured" &&
            !reachedLegacyNewCutoff &&
            result.hasMore &&
            result.nextCursor != null &&
            result.nextCursor !== pageCursor
              ? result.nextCursor
              : null;

          // Filtered scans can yield empty transport pages before reaching visible results.
          if (visiblePage.length === 0 && nextCursor) {
            consecutiveEmptyPages += 1;
            if (consecutiveEmptyPages < maxConsecutiveEmptyPagesPerFetch) {
              pageCursor = nextCursor;
              continue;
            }
          }

          setListResults((prev) => (cursor ? [...prev, ...visiblePage] : visiblePage));
          setListCursor(nextCursor);
          setListAutoLoadPaused(visiblePage.length === 0 && Boolean(nextCursor));
          setListStatus(nextCursor ? "idle" : "done");
          return;
        }
      } catch (err) {
        if (generation !== fetchGeneration.current) return;
        if (!isNavigationAbortError(err)) {
          console.error("Failed to fetch skills page:", err);
        }
        if (catalogTab === "trending" && !pageCursor) {
          setCanonicalTrendingUnavailable(true);
          setListResults([]);
          setTrendingState("unavailable");
        }
        // Keep canonical Trending's dedicated unavailable state. Elsewhere a failed first page
        // gets its own error state, so neither the empty state nor the load-more affordance has
        // to stand in for "the request failed"; later pages stay retryable through load-more.
        setListCursor(pageCursor);
        setListAutoLoadPaused(Boolean(pageCursor));
        setListStatus(
          catalogTab === "trending" && !pageCursor ? "done" : pageCursor ? "idle" : "error",
        );
      }
    },
    [
      activeCategory?.slug,
      activeTopic,
      catalogTab,
      categoryKeywords,
      dir,
      excludeCategoryKeywords,
      featuredOnly,
      listSort,
      newCutoff,
      sort,
    ],
  );

  // Reset and fetch first page when sort/dir/filters change
  useEffect(() => {
    if (hasQuery) {
      return () => {};
    }
    fetchGeneration.current += 1;
    const generation = fetchGeneration.current;
    if (matchedInitialList) {
      if (appliedInitialList.current !== matchedInitialList) {
        setCanonicalTrendingUnavailable(false);
        setListResults(matchedInitialList.results);
        setListCursor(matchedInitialList.nextCursor);
        setListAutoLoadPaused(false);
        setTrendingState(matchedInitialList.trendingState);
        setListStatus(matchedInitialList.nextCursor ? "idle" : "done");
        appliedInitialList.current = matchedInitialList;
      }
      return () => {
        fetchGeneration.current += 1;
      };
    }
    appliedInitialList.current = null;
    setListResults([]);
    setListCursor(null);
    setListAutoLoadPaused(false);
    setTrendingState(undefined);
    setListStatus("loading");
    void fetchPage(null, generation);
    return () => {
      fetchGeneration.current += 1;
    };
  }, [hasQuery, fetchPage, matchedInitialList]);

  const isLoadingList = listStatus === "loading";
  const canLoadMoreList = listStatus === "idle";
  const isLoadingMoreList = listStatus === "loadingMore";
  const listFailedList = listStatus === "error";

  useEffect(() => {
    window.clearTimeout(navigateTimer.current);
    setQuery(search.q ?? "");
  }, [search.q]);

  useEffect(() => {
    if (search.focus === "search" && searchInputRef.current) {
      searchInputRef.current.focus();
      void navigate({ search: (prev) => ({ ...prev, focus: undefined }), replace: true });
    }
  }, [navigate, search.focus, searchInputRef]);

  useEffect(() => {
    if (!searchKey) {
      setSearchResults([]);
      setIsSearching(false);
      appliedInitialSearchKey.current = null;
      return;
    }
    if (matchedInitialSearch && appliedInitialSearchKey.current !== matchedInitialSearch.key) {
      setSearchResults(matchedInitialSearch.results);
      setSearchLimit(matchedInitialSearch.limit);
      setIsSearching(false);
      appliedInitialSearchKey.current = matchedInitialSearch.key;
    }
    if (matchedInitialSearch) return;
    setSearchResults([]);
    setSearchLimit(SKILLS_PAGE_SIZE);
    setIsSearching(true);
    appliedInitialSearchKey.current = null;
  }, [matchedInitialSearch, searchKey]);

  useEffect(() => {
    if (!hasQuery) return () => {};
    if (matchedInitialSearch && searchLimit === matchedInitialSearch.limit) {
      searchRequest.current += 1;
      setIsSearching(false);
      return () => {};
    }

    searchRequest.current += 1;
    const requestId = searchRequest.current;
    setIsSearching(true);
    void (async () => {
      try {
        const data = (await searchSkills({
          query: trimmedQuery,
          highlightedOnly: featuredOnly,
          categorySlug: activeCategory?.slug,
          topic: activeTopic,
          limit: searchLimit,
        })) as Array<SkillSearchEntry>;
        if (requestId === searchRequest.current) {
          setSearchResults(data);
        }
      } finally {
        if (requestId === searchRequest.current) {
          setIsSearching(false);
        }
      }
    })();
    return () => {};
  }, [
    activeCategory?.slug,
    activeTopic,
    hasQuery,
    featuredOnly,
    matchedInitialSearch,
    searchLimit,
    searchSkills,
    trimmedQuery,
  ]);

  const baseItems = useMemo(() => {
    if (hasQuery) {
      return searchResults.map((entry): SkillListEntry =>
        entry.native
          ? {
              skill: entry.native.skill,
              latestVersion: entry.native.version,
              ownerHandle: entry.native.ownerHandle,
              owner: entry.native.owner,
              searchScore: entry.score,
            }
          : { external: entry, searchScore: entry.score },
      );
    }
    return listResults;
  }, [hasQuery, listResults, searchResults]);

  const sorted = useMemo(() => {
    const topicItems = activeTopic
      ? baseItems.filter(
          (entry) =>
            isExternalSkillListEntry(entry) ||
            isTrendingSkillListEntry(entry) ||
            getCatalogTopicSlugs(entry.skill.topics).includes(activeTopic),
        )
      : baseItems;
    const categoryItems = activeCategory
      ? topicItems.filter(
          (entry) =>
            isExternalSkillListEntry(entry) ||
            isTrendingSkillListEntry(entry) ||
            getSkillCategoriesForSkill(entry.skill).some(
              (category) => category.slug === activeCategory.slug,
            ),
        )
      : topicItems;
    if (!hasQuery || sort === "relevance") {
      // The canonical search action already ordered mixed results. Preserve
      // that order exactly for web/API/CLI parity.
      return categoryItems;
    }
    const multiplier = dir === "asc" ? 1 : -1;
    const results = [...categoryItems];
    results.sort((a, b) => {
      if (isTrendingSkillListEntry(a) || isTrendingSkillListEntry(b)) return 0;
      const aSkill = isExternalSkillListEntry(a) ? a.external : a.skill;
      const bSkill = isExternalSkillListEntry(b) ? b.external : b.skill;
      const aDownloads = isExternalSkillListEntry(a) ? 0 : a.skill.stats.downloads;
      const bDownloads = isExternalSkillListEntry(b) ? 0 : b.skill.stats.downloads;
      const aStars = isExternalSkillListEntry(a) ? 0 : a.skill.stats.stars;
      const bStars = isExternalSkillListEntry(b) ? 0 : b.skill.stats.stars;
      const tieBreak = () => {
        const updated = (aSkill.updatedAt - bSkill.updatedAt) * multiplier;
        if (updated !== 0) return updated;
        return aSkill.slug.localeCompare(bSkill.slug);
      };
      switch (sort) {
        case "downloads":
          return (aDownloads - bDownloads) * multiplier || tieBreak();
        case "stars":
          return (aStars - bStars) * multiplier || tieBreak();
        case "updated":
          return (
            (aSkill.updatedAt - bSkill.updatedAt) * multiplier ||
            aSkill.slug.localeCompare(bSkill.slug)
          );
        case "name":
          return (
            (aSkill.displayName.localeCompare(bSkill.displayName) ||
              aSkill.slug.localeCompare(bSkill.slug)) * multiplier
          );
        default:
          return (
            (("createdAt" in aSkill ? aSkill.createdAt : aSkill.updatedAt) -
              ("createdAt" in bSkill ? bSkill.createdAt : bSkill.updatedAt)) *
              multiplier || aSkill.slug.localeCompare(bSkill.slug)
          );
      }
    });
    return results;
  }, [activeCategory, activeTopic, baseItems, dir, hasQuery, sort]);

  const isLoadingSkills = hasQuery ? isSearching && searchResults.length === 0 : isLoadingList;
  const canLoadMore = hasQuery
    ? !isSearching && searchResults.length === searchLimit && searchResults.length > 0
    : canLoadMoreList;
  const isLoadingMore = hasQuery ? isSearching && searchResults.length > 0 : isLoadingMoreList;
  const listFailed = !hasQuery && listFailedList;
  const canAutoLoad = false;

  const loadMore = useCallback(() => {
    if (loadMoreInFlightRef.current || isLoadingMore || !canLoadMore) return;
    loadMoreInFlightRef.current = true;
    setListAutoLoadPaused(false);
    if (hasQuery) {
      setSearchLimit((value) => value + SKILLS_PAGE_SIZE);
    } else {
      setListStatus("loadingMore");
      void fetchPage(listCursor, fetchGeneration.current);
    }
  }, [canLoadMore, fetchPage, hasQuery, isLoadingMore, listCursor]);

  // The failed first page never advanced a cursor, so a retry just replays it. Two activations
  // can reach this callback before a rerender clears the failure, and both would replay the
  // first page under the same generation, so an older reply could overwrite the newer one.
  const retryLoad = useCallback(() => {
    if (retryInFlightRef.current || !listFailed) return;
    retryInFlightRef.current = true;
    setListStatus("loading");
    void fetchPage(null, fetchGeneration.current);
  }, [fetchPage, listFailed]);

  useEffect(() => {
    if (!isLoadingMore) {
      loadMoreInFlightRef.current = false;
    }
  }, [isLoadingMore]);

  useEffect(() => {
    if (!isLoadingSkills) {
      retryInFlightRef.current = false;
    }
  }, [isLoadingSkills]);

  useEffect(() => {
    return () => window.clearTimeout(navigateTimer.current);
  }, []);

  const onQueryChange = useCallback(
    (next: string) => {
      setQuery(next);
      window.clearTimeout(navigateTimer.current);
      const trimmed = next.trim();
      navigateTimer.current = window.setTimeout(() => {
        void navigate({
          search: (prev) => {
            const hadQuery = typeof prev.q === "string" && prev.q.trim().length > 0;
            const enteringSearch = Boolean(trimmed) && !hadQuery;
            return {
              ...prev,
              q: trimmed ? next : undefined,
              ...(enteringSearch ? { category: undefined, topic: undefined } : null),
              ...(enteringSearch && parseSort(prev.sort) === "recommended"
                ? { sort: undefined, dir: undefined }
                : null),
            };
          },
          replace: true,
        });
      }, 250);
    },
    [navigate],
  );

  const onToggleFeatured = useCallback(() => {
    void navigate({
      search: (prev) => ({
        ...prev,
        featured: prev.featured || prev.highlighted ? undefined : true,
        highlighted: undefined,
      }),
      replace: true,
    });
  }, [navigate]);

  const onClearFilters = useCallback(() => {
    window.clearTimeout(navigateTimer.current);
    setQuery("");
    void navigate({
      search: (prev) => ({
        ...prev,
        q: undefined,
        category: undefined,
        topic: undefined,
        featured: undefined,
        highlighted: undefined,
      }),
      replace: true,
    });
  }, [navigate]);

  const onClearQuery = useCallback(() => {
    window.clearTimeout(navigateTimer.current);
    setQuery("");
    searchInputRef.current?.focus();
    void navigate({
      search: (prev) => {
        const clearsSearchOnlySort = parseSort(prev.sort) === "relevance";
        return {
          ...prev,
          q: undefined,
          sort: clearsSearchOnlySort ? undefined : prev.sort,
          dir: clearsSearchOnlySort ? undefined : prev.dir,
        };
      },
      replace: true,
    });
  }, [navigate, searchInputRef]);

  const onSortChange = useCallback(
    (value: string) => {
      const nextSort = parseSort(value);
      void navigate({
        search: (prev) => {
          const clearsDefaultSearchSort = hasQuery && nextSort === "recommended";
          const reusePreviousDir =
            prev.sort !== undefined &&
            prev.sort !== "recommended" &&
            prev.sort !== "default" &&
            prev.sort !== "relevance";
          return {
            ...prev,
            sort: clearsDefaultSearchSort ? undefined : nextSort,
            dir:
              clearsDefaultSearchSort || nextSort === "recommended" || nextSort === "default"
                ? undefined
                : parseDir(reusePreviousDir ? prev.dir : undefined, nextSort),
          };
        },
        replace: true,
      });
    },
    [hasQuery, navigate],
  );

  const onToggleDir = useCallback(() => {
    void navigate({
      search: (prev) => ({
        ...prev,
        dir: parseDir(prev.dir, sort) === "asc" ? "desc" : "asc",
      }),
      replace: true,
    });
  }, [navigate, sort]);

  const onToggleView = useCallback(() => {
    void navigate({
      search: (prev) => ({
        ...prev,
        view: normalizeSkillsView(prev.view) === "grid" ? undefined : "grid",
      }),
      replace: true,
    });
  }, [navigate]);

  const activeFilters: string[] = [];
  if (featuredOnly) activeFilters.push("featured");

  return {
    activeFilters,
    activeCategory: activeCategory?.slug,
    activeTopic,
    canonicalTrendingUnavailable,
    catalogTab,
    canAutoLoad,
    canLoadMore,
    dir,
    hasQuery,
    featuredOnly,
    isLoadingMore,
    isLoadingSkills,
    listFailed,
    loadMore,
    loadMoreRef,
    onClearFilters,
    onClearQuery,
    onQueryChange,
    onSortChange,
    onToggleDir,
    onToggleFeatured,
    onToggleView,
    query,
    retryLoad,
    sort,
    sorted,
    trendingState,
    view,
  };
}
