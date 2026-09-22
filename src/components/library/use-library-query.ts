import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
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
import { type LibrarySortOrder } from "../../store/library";
const LIBRARY_PAGE_SIZE = Math.min(100, MAX_ROUTE_QUERY_ROWS);
const LIBRARY_LOAD_MORE_THRESHOLD_PX = 640;
const EMPTY_LIBRARY_SUMMARY: LibraryNovelSummary = {
  completeNovels: 0,
  downloadedChapters: 0,
  downloadedNovels: 0,
  lastUpdatedAt: null,
  localNovels: 0,
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
    downloadedOnly: downloadedOnlyMode,
    unreadOnly: unreadOnlyMode,
  } = libraryFilter;
  const libraryBodyRef = useRef<HTMLDivElement>(null);
  const librarySourceFilter = useMemo(
    () => ({
      search: debouncedSearch,
      categoryId: selectedCategoryId,
      downloadedOnly: downloadedOnlyMode,
      unreadOnly: unreadOnlyMode,
    }),
    [debouncedSearch, downloadedOnlyMode, selectedCategoryId, unreadOnlyMode],
  );

  const novels = useInfiniteQuery({
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
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: Infinity,
  });
  const libraryRowsLoaded = novels.data !== undefined;

  const librarySummary = useQuery({
    enabled: active && libraryRowsLoaded,
    queryKey: ["novel", "library", "summary", libraryFilter] as const,
    queryFn: () => getLibraryNovelSummary(libraryFilter),
    staleTime: Infinity,
  });

  const sourceFilters = useQuery({
    enabled: active && libraryRowsLoaded,
    queryKey: ["novel", "library", "sources", librarySourceFilter] as const,
    queryFn: () => listLibrarySourceFilters(librarySourceFilter),
    staleTime: Infinity,
  });

  const categories = useQuery({
    enabled: active && libraryRowsLoaded,
    queryKey: ["category", "list"],
    queryFn: listCategories,
    staleTime: Infinity,
  });

  const categoryCounts = useQuery({
    enabled: active && libraryRowsLoaded,
    queryKey: ["category", "counts"],
    queryFn: getLibraryCategoryCounts,
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
    sourceFilters,
    categories,
    categoryCounts,
    rows,
    libraryBodyRef,
  };
}
