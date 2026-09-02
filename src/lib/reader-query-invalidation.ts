import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { ChapterListRow } from "../db/queries/chapter";

const FINISHED_PROGRESS = 100;

export type QueryInvalidator = Pick<QueryClient, "invalidateQueries">;
type ChapterDownloadQueryCache = Pick<
  QueryClient,
  "invalidateQueries" | "setQueryData"
>;

export function chapterDetailQueryKey(chapterId: number) {
  return ["chapter", "detail", chapterId] as const;
}

export function chapterListQueryKey(novelId: number) {
  return ["chapter", "list", novelId] as const;
}

export function novelDetailQueryKey(novelId: number) {
  return ["novel", "detail", novelId] as const;
}

export function novelChaptersQueryKey(novelId: number) {
  return ["novel", "detail", novelId, "chapters"] as const;
}

export const novelLibraryQueryKey = ["novel", "library"] as const;
export const chapterHistoryQueryKey = ["chapter", "history"] as const;
export const chapterUpdatesQueryKey = ["chapter", "updates"] as const;
export const downloadCacheQueryKey = ["download-cache"] as const;

export async function applyNovelChapterDownloadCompletion(
  queryClient: ChapterDownloadQueryCache,
  {
    chapterId,
    novelId,
  }: {
    chapterId: number;
    novelId: number;
  },
): Promise<void> {
  if (chapterId <= 0 || novelId <= 0) return;

  queryClient.setQueryData<ChapterListRow[]>(
    novelChaptersQueryKey(novelId),
    (chapters) => {
      if (!chapters) return chapters;
      const index = chapters.findIndex((chapter) => chapter.id === chapterId);
      if (index < 0 || chapters[index]?.isDownloaded) return chapters;
      const updated = [...chapters];
      updated[index] = { ...updated[index]!, isDownloaded: true };
      return updated;
    },
  );

  await Promise.all([
    queryClient.invalidateQueries({
      exact: true,
      queryKey: novelChaptersQueryKey(novelId),
      refetchType: "none",
    }),
    queryClient.invalidateQueries({
      queryKey: novelLibraryQueryKey,
      refetchType: "none",
    }),
  ]);
}

function invalidate(
  queryClient: QueryInvalidator,
  queryKey: QueryKey,
  exact = false,
): Promise<unknown> {
  return queryClient.invalidateQueries({ exact, queryKey });
}

export function invalidateChapterReadStateQueries(
  queryClient: QueryInvalidator,
  { novelId }: { novelId: number },
): Promise<void> {
  if (novelId <= 0) return Promise.resolve();

  return Promise.all([
    invalidate(queryClient, chapterListQueryKey(novelId), true),
    invalidate(queryClient, novelChaptersQueryKey(novelId), true),
    invalidate(queryClient, ["chapter", "detail"]),
    invalidate(queryClient, novelLibraryQueryKey),
  ]).then(() => undefined);
}

export function invalidateReaderProgressQueries(
  queryClient: QueryInvalidator,
  {
    novelId,
    progress,
    recordHistory,
  }: {
    novelId: number;
    progress: number;
    recordHistory: boolean;
  },
): Promise<void> {
  const invalidations: Array<Promise<unknown>> = [];

  if (novelId > 0) {
    invalidations.push(
      invalidate(queryClient, chapterListQueryKey(novelId), true),
      invalidate(queryClient, novelChaptersQueryKey(novelId), true),
    );
    if (recordHistory) {
      invalidations.push(
        invalidate(queryClient, novelDetailQueryKey(novelId), true),
      );
    }
  }

  if (recordHistory) {
    invalidations.push(invalidate(queryClient, chapterHistoryQueryKey));
  }

  if (progress >= FINISHED_PROGRESS) {
    invalidations.push(invalidate(queryClient, chapterUpdatesQueryKey));
  }

  return Promise.all(invalidations).then(() => undefined);
}

export function invalidateReaderOpenedQueries(
  queryClient: QueryInvalidator,
  {
    novelId,
  }: {
    novelId: number;
  },
): Promise<void> {
  const invalidations: Array<Promise<unknown>> = [];

  if (novelId > 0) {
    invalidations.push(
      invalidate(queryClient, novelDetailQueryKey(novelId), true),
    );
  }
  invalidations.push(invalidate(queryClient, chapterHistoryQueryKey));

  return Promise.all(invalidations).then(() => undefined);
}

export function invalidateReaderContentQueries(
  queryClient: QueryInvalidator,
  {
    chapterId,
    novelId,
    includeDownloadCache = false,
  }: {
    chapterId: number;
    novelId: number;
    includeDownloadCache?: boolean;
  },
): Promise<void> {
  const invalidations: Array<Promise<unknown>> = [];

  if (chapterId > 0) {
    invalidations.push(
      invalidate(queryClient, chapterDetailQueryKey(chapterId), true),
    );
  }
  if (novelId > 0) {
    invalidations.push(
      invalidate(queryClient, chapterListQueryKey(novelId), true),
      invalidate(queryClient, novelChaptersQueryKey(novelId), true),
      invalidate(queryClient, novelLibraryQueryKey),
    );
  }
  if (includeDownloadCache) {
    invalidations.push(invalidate(queryClient, downloadCacheQueryKey));
  }

  return Promise.all(invalidations).then(() => undefined);
}
