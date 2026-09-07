import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { useCallback, useRef } from "react";
import { api } from "../../../convex/_generated/api";
import {
  BrowseActions,
  BrowseCategorySelect,
  BrowseCategorySidebar,
  BrowseControls,
  BrowseControlsDivider,
  BrowseControlsRow,
  BrowseSearchInput,
  BrowseSearchPanel,
  BrowseSearchTrigger,
  BrowseTabs,
  BrowseTopicChips,
  BrowseViewToggle,
  useBrowseSearchDisclosure,
} from "../../components/BrowseControls";
import { convexHttp } from "../../convex/client";
import { formatBrowseCount } from "../../lib/browseCount";
import {
  parseBrowseTopicFromSearchInput,
  sanitizeBrowseTopicSearch,
} from "../../lib/browseTopicSearch";
import { fetchCatalogDiscoveryCapabilities } from "../../lib/catalogDiscoveryCapabilities";
import { resolveSkillBrowseCategorySlug, SKILL_CATEGORIES } from "../../lib/categories";
import { fetchCanonicalTrendingPage } from "../../lib/trendingApi";
import { useBrowseTopicSearch } from "../../lib/useBrowseTopicSearch";
import { parseSort } from "./-params";
import { SkillsResults } from "./-SkillsResults";
import type { SkillSearchEntry } from "./-types";
import {
  buildSkillsSearchKey,
  type InitialSkillsListData,
  type InitialSkillsSearchData,
  normalizeSkillsView,
  normalizeSkillsCatalogTab,
  SKILLS_PAGE_SIZE,
  useSkillsBrowseModel,
  type SkillsSearchState,
} from "./-useSkillsBrowseModel";

const SKILLS_VIEW_OPTIONS = [
  { value: "trending", label: "Trending" },
  { value: "featured", label: "Featured" },
  { value: "official", label: "Official" },
  { value: "new", label: "New" },
];
const SKILLS_INITIAL_SEARCH_LIMIT = 25;
export const SKILLS_INITIAL_PAGE_TIMEOUT_MS = 250;

type InitialSkillsLoaderData = InitialSkillsSearchData | InitialSkillsListData;

function parseSkillCategorySlug(value: unknown) {
  return typeof value === "string" ? resolveSkillBrowseCategorySlug(value) : undefined;
}

export const Route = createFileRoute("/skills/")({
  validateSearch: (search): SkillsSearchState => {
    const category = parseSkillCategorySlug(search.category);
    const topic = parseBrowseTopicFromSearchInput(search as Record<string, unknown>);
    const sort = typeof search.sort === "string" ? parseSort(search.sort) : undefined;
    const featured =
      search.featured === "1" || search.featured === "true" || search.featured === true
        ? true
        : undefined;
    const highlighted =
      search.highlighted === "1" || search.highlighted === "true" || search.highlighted === true
        ? true
        : undefined;
    return {
      q: typeof search.q === "string" && search.q.trim() ? search.q : undefined,
      sort,
      dir: search.dir === "asc" || search.dir === "desc" ? search.dir : undefined,
      highlighted,
      featured,
      category,
      topic,
      view: normalizeSkillsView(search.view),
      focus: search.focus === "search" ? "search" : undefined,
      tab: normalizeSkillsCatalogTab(search.tab, {
        category,
        featured,
        highlighted,
        sort,
        topic,
      }),
    };
  },
  loaderDeps: ({ search }) => {
    const hasQuery = Boolean(search.q?.trim());
    return {
      q: search.q,
      featured: search.featured,
      highlighted: search.highlighted,
      category: search.category,
      topic: search.topic,
      tab: hasQuery ? undefined : search.tab,
      sort: hasQuery ? undefined : search.sort,
      dir: hasQuery ? undefined : search.dir,
    };
  },
  loader: async ({ deps, abortController }): Promise<InitialSkillsLoaderData> =>
    isCanonicalSkillsBrowse(deps)
      ? await loadInitialSkillsDataWithinBudget(deps, abortController.signal)
      : await loadInitialSkillsData(deps, abortController.signal),
  component: SkillsIndex,
});

export async function loadInitialSkillsData(
  search: SkillsSearchState,
  signal?: AbortSignal,
): Promise<InitialSkillsLoaderData> {
  const query = search.q?.trim();
  if (query) {
    const featuredOnly = search.featured ?? search.highlighted ?? false;
    const key = buildSkillsSearchKey({
      query,
      featuredOnly,
      categorySlug: search.category,
      topic: search.topic,
    });
    try {
      const results = (await convexHttp.action(api.search.searchSkills, {
        query,
        highlightedOnly: featuredOnly,
        categorySlug: search.category,
        topic: search.topic,
        limit: SKILLS_INITIAL_SEARCH_LIMIT,
      })) as SkillSearchEntry[];
      return { key, limit: SKILLS_INITIAL_SEARCH_LIMIT, results };
    } catch (error) {
      console.error("Failed to load initial skills search:", error);
      return null;
    }
  }

  if (!isCanonicalSkillsBrowse(search)) return null;

  try {
    const capabilities = await fetchCatalogDiscoveryCapabilities();
    if (signal?.aborted) throw signal.reason;
    if (!capabilities.canonicalTrendingEnabled) return null;

    const result = await fetchCanonicalTrendingPage({
      cursor: null,
      limit: SKILLS_PAGE_SIZE,
      signal,
    });
    return {
      kind: "canonical",
      results: result.items.map((trending) => ({ trending })),
      nextCursor: result.nextCursor,
      trendingState: result.items.length > 0 || result.nextCursor ? "available" : "empty",
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    console.error("Failed to load initial skills page:", error);
    return null;
  }
}

async function loadInitialSkillsDataWithinBudget(
  search: SkillsSearchState,
  navigationSignal: AbortSignal,
): Promise<InitialSkillsLoaderData> {
  if (navigationSignal.aborted) throw navigationSignal.reason;

  const requestController = new AbortController();
  let rejectOnNavigationAbort: (reason: unknown) => void = () => {};
  const navigationAbort = new Promise<never>((_, reject) => {
    rejectOnNavigationAbort = reject;
  });
  const abortFromNavigation = () => {
    requestController.abort(navigationSignal.reason);
    rejectOnNavigationAbort(navigationSignal.reason);
  };
  navigationSignal.addEventListener("abort", abortFromNavigation, { once: true });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve(null);
      requestController.abort(
        new DOMException("Initial Skills catalog request timed out", "TimeoutError"),
      );
    }, SKILLS_INITIAL_PAGE_TIMEOUT_MS);
  });

  try {
    // Slow catalog dependencies must not hold the document response open.
    // Hydration falls back to the existing client fetch after this budget.
    return await Promise.race([
      loadInitialSkillsData(search, requestController.signal),
      timeout,
      navigationAbort,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    navigationSignal.removeEventListener("abort", abortFromNavigation);
  }
}

function isCanonicalSkillsBrowse(search: SkillsSearchState) {
  return (
    search.tab === "trending" &&
    search.sort === undefined &&
    search.dir === undefined &&
    search.featured === undefined &&
    search.highlighted === undefined &&
    search.category === undefined &&
    search.topic === undefined
  );
}

export function SkillsIndex() {
  const navigate = Route.useNavigate();
  const routeSearch = Route.useSearch();
  const initialData = Route.useLoaderData() as InitialSkillsLoaderData | undefined;
  const initialList = initialData && "kind" in initialData ? initialData : undefined;
  const initialSearch = initialData && !("kind" in initialData) ? initialData : undefined;
  const { search, activeTopic } = useBrowseTopicSearch(routeSearch, navigate);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const model = useSkillsBrowseModel({
    initialList,
    initialSearch,
    navigate,
    search,
    searchInputRef,
  });
  const browseSearch = useBrowseSearchDisclosure({
    value: model.query,
    onClear: model.onClearQuery,
    inputRef: searchInputRef,
  });

  const activeView = model.catalogTab;
  const viewOptions = model.canonicalTrendingUnavailable
    ? SKILLS_VIEW_OPTIONS.filter((option) => option.value !== "trending")
    : SKILLS_VIEW_OPTIONS;
  const hasActiveFilters =
    model.catalogTab !== "trending" ||
    model.hasQuery ||
    Boolean(model.activeCategory) ||
    Boolean(activeTopic);
  const totalSkillsCount = useQuery(api.skills.countPublicSkills, {});
  const categoryTopics = useQuery(
    api.catalogTopics.listTopByCategory,
    model.activeCategory
      ? {
          kind: "skill",
          category: model.activeCategory,
        }
      : "skip",
  );
  const formattedCount = !hasActiveFilters ? formatBrowseCount(totalSkillsCount) : null;

  const handleViewChange = useCallback(
    (value: string) => {
      void navigate({
        search: (prev: SkillsSearchState) => {
          if (value === "trending") {
            return {
              ...prev,
              q: undefined,
              tab: "trending",
              sort: undefined,
              dir: undefined,
              category: undefined,
              topic: undefined,
              featured: undefined,
              highlighted: undefined,
            };
          }
          return {
            ...prev,
            q: undefined,
            tab: value as "new" | "featured" | "official",
            sort: undefined,
            dir: undefined,
            featured: undefined,
            highlighted: undefined,
          };
        },
        replace: true,
      });
    },
    [navigate],
  );

  const handleCategoryChange = useCallback(
    (slug: string | undefined) => {
      const category = parseSkillCategorySlug(slug);
      void navigate({
        search: (prev: SkillsSearchState) => ({
          ...prev,
          category,
          topic: undefined,
          featured: undefined,
          highlighted: undefined,
        }),
        replace: true,
      });
    },
    [navigate],
  );

  const handleTopicChange = useCallback(
    (topic: string | undefined) => {
      void navigate({
        search: (prev: SkillsSearchState) =>
          sanitizeBrowseTopicSearch(
            {
              ...prev,
              featured: undefined,
              highlighted: undefined,
            },
            topic ?? null,
          ),
        replace: true,
      });
    },
    [navigate],
  );

  return (
    <main className="browse-page browse-page-borderless-header skills-browse-page">
      <div className="browse-page-header">
        <div className="browse-page-header-main">
          <h1 className="browse-title">
            Skills
            {formattedCount ? (
              <>
                {" "}
                <span className="browse-count">{formattedCount}</span>
              </>
            ) : null}
          </h1>
        </div>
      </div>
      <BrowseControls>
        <BrowseControlsRow>
          <BrowseTabs
            ariaLabel="Skill view"
            options={viewOptions}
            value={activeView}
            onChange={(value) => {
              if (value) handleViewChange(value);
            }}
          />
          <BrowseControlsDivider />
          <BrowseActions>
            <BrowseSearchTrigger
              open={browseSearch.open}
              onOpen={browseSearch.openSearch}
              label="Search skills"
            />
            {activeView === "trending" ? null : (
              <BrowseCategorySelect
                categories={SKILL_CATEGORIES}
                value={model.activeCategory}
                onChange={handleCategoryChange}
                responsive
              />
            )}
            <BrowseViewToggle view={model.view} onToggle={model.onToggleView} />
          </BrowseActions>
          <BrowseSearchPanel open={browseSearch.open}>
            <BrowseSearchInput
              inputRef={searchInputRef}
              label="skill search"
              placeholder="Search skills..."
              value={model.query}
              onChange={model.onQueryChange}
              onClear={browseSearch.closeSearch}
              closeLabel="Close search"
            />
          </BrowseSearchPanel>
        </BrowseControlsRow>
        {activeView === "trending" ? null : (
          <BrowseTopicChips
            topics={categoryTopics ?? []}
            activeTopic={activeTopic}
            onChange={handleTopicChange}
            loading={Boolean(model.activeCategory && categoryTopics === undefined)}
          />
        )}
      </BrowseControls>
      <div
        className={`browse-layout${activeView === "trending" ? "" : " browse-layout-with-sidebar"}`}
      >
        {activeView === "trending" ? null : (
          <BrowseCategorySidebar
            ariaLabel="Skill categories"
            categories={SKILL_CATEGORIES}
            value={model.activeCategory}
            onChange={handleCategoryChange}
          />
        )}
        <div className="browse-results">
          <SkillsResults
            isLoadingSkills={model.isLoadingSkills}
            sorted={model.sorted}
            view={model.view}
            listDoneLoading={!model.isLoadingSkills && !model.canLoadMore && !model.isLoadingMore}
            hasQuery={model.hasQuery}
            canLoadMore={model.canLoadMore}
            isLoadingMore={model.isLoadingMore}
            canAutoLoad={model.canAutoLoad}
            loadMoreRef={model.loadMoreRef}
            loadMore={model.loadMore}
            listFailed={model.listFailed}
            retryLoad={model.retryLoad}
            catalogTab={model.catalogTab}
            trendingState={model.trendingState}
          />
        </div>
      </div>
    </main>
  );
}
