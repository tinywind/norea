import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chapterDetailQueryKey,
  chapterHistoryQueryKey,
  chapterListQueryKey,
  chapterUpdatesQueryKey,
  downloadCacheQueryKey,
  invalidateReaderContentQueries,
  invalidateReaderOpenedQueries,
  invalidateReaderProgressQueries,
  novelChaptersQueryKey,
  novelDetailQueryKey,
  novelLibraryQueryKey,
  type QueryInvalidator,
} from "./reader-query-invalidation";

const unsubscriptions: Array<() => void> = [];

function collectInvalidations(): {
  invalidated: unknown[];
  queryClient: QueryInvalidator;
} {
  const invalidated: unknown[] = [];
  const queryClient = {
    invalidateQueries: vi.fn((filters: { queryKey: unknown }) => {
      invalidated.push(filters.queryKey);
      return Promise.resolve();
    }),
  } as unknown as QueryInvalidator;
  return {
    invalidated,
    queryClient,
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
      },
    },
  });
}

async function observeQuery<T>(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  queryFn: () => Promise<T>,
): Promise<void> {
  await queryClient.fetchQuery({ queryFn, queryKey, staleTime: Infinity });
  const observer = new QueryObserver(queryClient, { queryFn, queryKey });
  unsubscriptions.push(observer.subscribe(() => undefined));
}

afterEach(() => {
  for (const unsubscribe of unsubscriptions.splice(0)) {
    unsubscribe();
  }
});

describe("reader query invalidation", () => {
  it("scopes progress writes to reader, history, and updates keys", () => {
    const { invalidated, queryClient } = collectInvalidations();

    invalidateReaderProgressQueries(queryClient, {
      novelId: 7,
      progress: 100,
      recordHistory: true,
    });

    expect(invalidated).toEqual([
      chapterListQueryKey(7),
      novelChaptersQueryKey(7),
      novelDetailQueryKey(7),
      chapterHistoryQueryKey,
      chapterUpdatesQueryKey,
    ]);
    expect(invalidated).not.toContainEqual(["novel"]);
  });

  it("keeps incognito progress writes out of history and novel detail", () => {
    const { invalidated, queryClient } = collectInvalidations();

    invalidateReaderProgressQueries(queryClient, {
      novelId: 7,
      progress: 42,
      recordHistory: false,
    });

    expect(invalidated).toEqual([
      chapterListQueryKey(7),
      novelChaptersQueryKey(7),
    ]);
    expect(invalidated).not.toContainEqual(["novel"]);
    expect(invalidated).not.toContainEqual(chapterHistoryQueryKey);
    expect(invalidated).not.toContainEqual(novelDetailQueryKey(7));
    expect(invalidated).not.toContainEqual(novelLibraryQueryKey);
  });

  it("scopes chapter-open history updates without broad novel invalidation", () => {
    const { invalidated, queryClient } = collectInvalidations();

    invalidateReaderOpenedQueries(queryClient, {
      novelId: 7,
    });

    expect(invalidated).toEqual([
      novelDetailQueryKey(7),
      chapterHistoryQueryKey,
    ]);
    expect(invalidated).not.toContainEqual(["novel"]);
    expect(invalidated).not.toContainEqual(novelLibraryQueryKey);
  });

  it("does not refetch unrelated novel or library queries on ordinary progress saves", async () => {
    const queryClient = createQueryClient();
    const currentChapterListQuery = vi.fn().mockResolvedValue([]);
    const currentNovelChaptersQuery = vi.fn().mockResolvedValue([]);
    const currentNovelQuery = vi.fn().mockResolvedValue({ id: 7 });
    const unrelatedNovelQuery = vi.fn().mockResolvedValue({ id: 99 });
    const unrelatedLibraryQuery = vi.fn().mockResolvedValue([{ id: 99 }]);
    const updatesQuery = vi.fn().mockResolvedValue([]);

    await observeQuery(queryClient, chapterListQueryKey(7), currentChapterListQuery);
    await observeQuery(
      queryClient,
      novelChaptersQueryKey(7),
      currentNovelChaptersQuery,
    );
    await observeQuery(queryClient, novelDetailQueryKey(7), currentNovelQuery);
    await observeQuery(queryClient, novelDetailQueryKey(99), unrelatedNovelQuery);
    await observeQuery(
      queryClient,
      ["novel", "library", { sortOrder: "nameAsc" }],
      unrelatedLibraryQuery,
    );
    await observeQuery(queryClient, chapterUpdatesQueryKey, updatesQuery);

    await invalidateReaderProgressQueries(queryClient, {
      novelId: 7,
      progress: 42,
      recordHistory: true,
    });

    expect(currentChapterListQuery).toHaveBeenCalledTimes(2);
    expect(currentNovelChaptersQuery).toHaveBeenCalledTimes(2);
    expect(currentNovelQuery).toHaveBeenCalledTimes(2);
    expect(unrelatedNovelQuery).toHaveBeenCalledTimes(1);
    expect(unrelatedLibraryQuery).toHaveBeenCalledTimes(1);
    expect(updatesQuery).toHaveBeenCalledTimes(1);
  });

  it("can include download-cache invalidation for content repair paths", () => {
    const { invalidated, queryClient } = collectInvalidations();

    invalidateReaderContentQueries(queryClient, {
      chapterId: 11,
      includeDownloadCache: true,
      novelId: 7,
    });

    expect(invalidated).toEqual([
      chapterDetailQueryKey(11),
      chapterListQueryKey(7),
      novelChaptersQueryKey(7),
      novelLibraryQueryKey,
      downloadCacheQueryKey,
    ]);
    expect(invalidated).not.toContainEqual(["novel"]);
  });
});
