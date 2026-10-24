import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyNovelChapterDownloadCompletion,
  applyNovelChapterDownloadCompletions,
  chapterDetailQueryKey,
  chapterHistoryQueryKey,
  chapterListQueryKey,
  chapterUpdatesQueryKey,
  downloadCacheQueryKey,
  invalidateChapterReadStateQueries,
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
  it("refreshes chapter read-state caches after a manual change", () => {
    const { invalidated, queryClient } = collectInvalidations();

    invalidateChapterReadStateQueries(queryClient, { novelId: 7 });

    expect(invalidated).toEqual([
      chapterListQueryKey(7),
      novelChaptersQueryKey(7),
      ["chapter", "detail"],
      novelLibraryQueryKey,
    ]);
  });

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
      novelLibraryQueryKey,
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
      novelLibraryQueryKey,
    ]);
    expect(invalidated).not.toContainEqual(["novel"]);
    expect(invalidated).not.toContainEqual(chapterHistoryQueryKey);
    expect(invalidated).not.toContainEqual(novelDetailQueryKey(7));
  });

  it("scopes chapter-open history updates without broad novel invalidation", () => {
    const { invalidated, queryClient } = collectInvalidations();

    invalidateReaderOpenedQueries(queryClient, {
      novelId: 7,
    });

    expect(invalidated).toEqual([
      novelDetailQueryKey(7),
      novelLibraryQueryKey,
      chapterHistoryQueryKey,
    ]);
    expect(invalidated).not.toContainEqual(["novel"]);
  });

  it("does not refetch unrelated novels or a hidden library on ordinary progress saves", async () => {
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
    await queryClient.fetchQuery({
      queryKey: ["novel", "library", { sortOrder: "nameAsc" }],
      queryFn: unrelatedLibraryQuery,
    });
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

  it.each([false, true])("refreshes persisted progress when returning to the library (history: %s)", async recordHistory => {
    const queryClient = createQueryClient();
    const queryKey = ["novel", "library", { sortOrder: "lastReadDesc" }];
    let storedProgress = 0;
    const queryFn = vi.fn(async () => [{ id: 7, readingProgress: storedProgress }]);
    await queryClient.fetchQuery({ queryKey, queryFn });
    const observer = new QueryObserver(queryClient, { queryKey, queryFn, enabled: false });
    unsubscriptions.push(observer.subscribe(() => undefined));
    storedProgress = 42;
    await invalidateReaderProgressQueries(queryClient, { novelId: 7, progress: 42, recordHistory });
    expect(queryFn).toHaveBeenCalledTimes(1);
    observer.setOptions({ queryKey, queryFn, enabled: true });
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual([{ id: 7, readingProgress: 42 }]));
    storedProgress = 100;
    await invalidateReaderProgressQueries(queryClient, { novelId: 7, progress: 100, recordHistory });
    expect(observer.getCurrentResult().data).toEqual([{ id: 7, readingProgress: 100 }]);
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

  it("updates a completed download without refetching active local queries", async () => {
    const queryClient = createQueryClient();
    const chaptersQuery = vi.fn().mockResolvedValue([
      { id: 11, isDownloaded: false },
      { id: 12, isDownloaded: false },
    ]);
    const libraryQuery = vi.fn().mockResolvedValue([{ id: 7 }]);

    await observeQuery(
      queryClient,
      novelChaptersQueryKey(7),
      chaptersQuery,
    );
    await observeQuery(
      queryClient,
      ["novel", "library", { sortOrder: "nameAsc" }],
      libraryQuery,
    );

    await applyNovelChapterDownloadCompletion(queryClient, {
      chapterId: 11,
      novelId: 7,
    });

    expect(queryClient.getQueryData(novelChaptersQueryKey(7))).toEqual([
      { id: 11, isDownloaded: true },
      { id: 12, isDownloaded: false },
    ]);
    expect(chaptersQuery).toHaveBeenCalledTimes(1);
    expect(libraryQuery).toHaveBeenCalledTimes(1);
  });

  it("preserves cached chapter rows for an unrelated download", async () => {
    const queryClient = createQueryClient();
    const chapters = [{ id: 11, isDownloaded: false }];
    queryClient.setQueryData(novelChaptersQueryKey(7), chapters);

    await applyNovelChapterDownloadCompletion(queryClient, {
      chapterId: 99,
      novelId: 7,
    });

    expect(queryClient.getQueryData(novelChaptersQueryKey(7))).toBe(chapters);
  });

  it("applies batched download completions once per novel and library", async () => {
    const queryClient = createQueryClient();
    const firstNovelChapters = [
      { id: 11, isDownloaded: false },
      { id: 12, isDownloaded: false },
    ];
    const secondNovelChapters = [{ id: 21, isDownloaded: false }];
    queryClient.setQueryData(novelChaptersQueryKey(7), firstNovelChapters);
    queryClient.setQueryData(novelChaptersQueryKey(8), secondNovelChapters);
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    await applyNovelChapterDownloadCompletions(
      queryClient,
      new Map([
        [7, new Set([11, 12])],
        [8, new Set([21])],
      ]),
    );

    expect(queryClient.getQueryData(novelChaptersQueryKey(7))).toEqual([
      { id: 11, isDownloaded: true },
      { id: 12, isDownloaded: true },
    ]);
    expect(queryClient.getQueryData(novelChaptersQueryKey(8))).toEqual([
      { id: 21, isDownloaded: true },
    ]);
    expect(
      invalidateQueries.mock.calls.filter(
        ([filters]) => filters?.queryKey === novelLibraryQueryKey,
      ),
    ).toHaveLength(1);
  });
});
