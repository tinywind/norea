import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  getLibraryCategoryCounts,
  listCategories,
} from "../../db/queries/category";
import {
  getLibraryNovelSummary,
  listLibraryNovelPage,
  listLibrarySourceFilters,
  type LibraryNovelCursor,
  type LibraryNovelRefreshFilter,
  type LibraryNovelSummary,
} from "../../db/queries/novel";
import { MAX_ROUTE_QUERY_ROWS } from "../../lib/performance-budgets";
import { subscribeChapterDownloadsSettled } from "../../lib/tasks/chapter-download-activity";
import { type LibrarySortOrder } from "../../store/library";
const LIBRARY_PAGE_SIZE = Math.min(100, MAX_ROUTE_QUERY_ROWS);
const LIBRARY_LOAD_MORE_THRESHOLD_PX = 640;
export const DOWNLOAD_SETTLED_REFRESH_INTERVAL_MS = 1000;
const EMPTY_LIBRARY_SUMMARY: LibraryNovelSummary = {
  completeNovels: 0,
  downloadedChapters: 0,
  downloadedNovels: 0,
  lastUpdatedAt: null,
  localNovels: 0,
  repairNeededNovels: 0,
  totalChapters: 0,
  totalNovels: 0,
  unreadChapters: 0,
  unreadNovels: 0,
};

export function useLibraryQuery(
  active: boolean,
  libraryFilter: LibraryNovelRefreshFilter,
  sortOrder: LibrarySortOrder,
) {
  const {
    search: debouncedSearch,
    categoryId: selectedCategoryId,
  } = libraryFilter;
  const queryClient = useQueryClient();
  const libraryBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ["novel", "library", "summary"] });
      void queryClient.invalidateQueries({ queryKey: ["novel", "library", { repairNeededOnly: true }] });
    };
    let lastSettledRefreshAt = Number.NEGATIVE_INFINITY;
    let settledRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshSettled = () => {
      settledRefreshTimer = undefined;
      lastSettledRefreshAt = performance.now();
      refresh();
    };
    // Every finished chapter settles, so a batch refreshes these queries at most once a second.
    const scheduleSettledRefresh = () => {
      if (settledRefreshTimer !== undefined) return;
      const waitMs = lastSettledRefreshAt + DOWNLOAD_SETTLED_REFRESH_INTERVAL_MS - performance.now();
      if (waitMs <= 0) refreshSettled();
      else settledRefreshTimer = setTimeout(refreshSettled, waitMs);
    };
    refresh();
    const unsubscribe = subscribeChapterDownloadsSettled(scheduleSettledRefresh);
    return () => {
      unsubscribe();
      if (settledRefreshTimer !== undefined) clearTimeout(settledRefreshTimer);
    };
  }, [active, queryClient]);
  const librarySourceFilter = useMemo(
    () => ({
      search: debouncedSearch,
      categoryId: selectedCategoryId,
    }),
    [debouncedSearch, selectedCategoryId],
  );

  const novels = useInfiniteQuery({
    meta: { errorPresentation: "inline" },
    enabled: active,
    queryKey: [
      "novel",
      "library",
      {
        ...libraryFilter,
        limit: LIBRARY_PAGE_SIZE,
        sortOrder,
      },
    ] as const,
    initialPageParam: null as LibraryNovelCursor | null,
    queryFn: ({ pageParam }) =>
      listLibraryNovelPage({
        ...libraryFilter,
        cursor: pageParam,
        limit: LIBRARY_PAGE_SIZE,
        sortOrder,
      }, "committed"),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    // A filter change keeps the current grid until the new rows arrive, so shared cards stay mounted.
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });
  const libraryRowsLoaded = novels.data !== undefined;

  const librarySummary = useQuery({
    enabled: active && libraryRowsLoaded,
    queryKey: ["novel", "library", "summary", libraryFilter] as const,
    queryFn: () => getLibraryNovelSummary(libraryFilter, "committed"),
    staleTime: Infinity,
  });

  const tagFilter = {
    search: debouncedSearch,
    categoryId: selectedCategoryId,
    sourceId: libraryFilter.sourceId,
  };
  const tagSummary = useQuery({
    enabled: active && libraryRowsLoaded,
    queryKey: ["novel", "library", "summary", tagFilter] as const,
    queryFn: () => getLibraryNovelSummary(tagFilter, "committed"),
    staleTime: Infinity,
  });

  const sourceFilters = useQuery({
    enabled: active && libraryRowsLoaded,
    queryKey: ["novel", "library", "sources", librarySourceFilter] as const,
    queryFn: () => listLibrarySourceFilters(librarySourceFilter, "committed"),
    staleTime: Infinity,
  });

  const categories = useQuery({
    meta: { errorPresentation: "inline" },
    enabled: active && libraryRowsLoaded,
    queryKey: ["category", "list"],
    queryFn: () => listCategories("committed"),
    staleTime: Infinity,
  });

  const categoryCounts = useQuery({
    enabled: active && libraryRowsLoaded,
    queryKey: ["category", "counts"],
    queryFn: () => getLibraryCategoryCounts("committed"),
    staleTime: Infinity,
  });

  const rows = useMemo(
    () => novels.data?.pages.flatMap((page) => page.novels) ?? [],
    [novels.data?.pages],
  );
  const summary = librarySummary.data ?? {
    ...EMPTY_LIBRARY_SUMMARY,
    totalNovels: rows.length,
  };
  const loadMoreIfNeeded = useCallback(() => {
    if (
      !active ||
      !novels.hasNextPage ||
      novels.isFetchingNextPage ||
      novels.isLoading
    ) {
      return;
    }

    const scrollElement = libraryBodyRef.current;
    if (!scrollElement) return;

    const distanceToBottom =
      scrollElement.scrollHeight -
      scrollElement.clientHeight -
      scrollElement.scrollTop;
    if (distanceToBottom <= LIBRARY_LOAD_MORE_THRESHOLD_PX) {
      void novels.fetchNextPage();
    }
  }, [
    active,
    novels.fetchNextPage,
    novels.hasNextPage,
    novels.isFetchingNextPage,
    novels.isLoading,
  ]);
  useEffect(() => {
    if (!active) return;

    const scrollElement = libraryBodyRef.current;
    if (!scrollElement) return;

    scrollElement.addEventListener("scroll", loadMoreIfNeeded, {
      passive: true,
    });
    window.addEventListener("resize", loadMoreIfNeeded);
    loadMoreIfNeeded();

    return () => {
      scrollElement.removeEventListener("scroll", loadMoreIfNeeded);
      window.removeEventListener("resize", loadMoreIfNeeded);
    };
  }, [active, loadMoreIfNeeded, rows.length]);

  return {
    novels,
    summary,
    tagSummary: tagSummary.data ?? EMPTY_LIBRARY_SUMMARY,
    sourceFilters,
    categories,
    categoryCounts,
    rows,
    libraryBodyRef,
  };
}
