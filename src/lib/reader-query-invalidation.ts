import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { getChapterById, type ChapterListRow } from "../db/queries/chapter";

const FINISHED_PROGRESS = 100;

export type QueryInvalidator = Pick<QueryClient, "invalidateQueries">;
type ChapterDownloadQueryCache = Pick<
  QueryClient,
  "getQueryData" | "invalidateQueries" | "setQueryData"
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
  return applyNovelChapterDownloadCompletions(
    queryClient,
    new Map([[novelId, new Set([chapterId])]]),
  );
}

export async function applyNovelChapterDownloadCompletions(
  queryClient: ChapterDownloadQueryCache,
  completionsByNovel: ReadonlyMap<number, ReadonlySet<number>>,
): Promise<void> {
  const invalidations: Array<Promise<unknown>> = [];

  for (const [novelId, requestedChapterIds] of completionsByNovel) {
    if (novelId <= 0) continue;
    const chapterIds = new Set(
      [...requestedChapterIds].filter((chapterId) => chapterId > 0),
    );
    if (chapterIds.size === 0) continue;

    const cachedChapters = queryClient.getQueryData<ChapterListRow[]>(
      novelChaptersQueryKey(novelId),
    );
    const storedChapters = await Promise.all(
      (cachedChapters ?? [])
        .filter(chapter => chapterIds.has(chapter.id))
        .map(chapter => getChapterById(chapter.id)),
    );
    const storedById = new Map(
      storedChapters.flatMap(chapter => chapter ? [[chapter.id, chapter] as const] : []),
    );
    queryClient.setQueryData<ChapterListRow[]>(
      novelChaptersQueryKey(novelId),
      (chapters) => {
        if (!chapters) return chapters;
        let updated: ChapterListRow[] | null = null;
        for (let index = 0; index < chapters.length; index += 1) {
          const chapter = chapters[index]!;
          const stored = storedById.get(chapter.id);
          if (!stored || (
            chapter.isDownloaded === stored.isDownloaded
            && chapter.mediaRepairNeeded === stored.mediaRepairNeeded
            && chapter.contentBytes === stored.contentBytes
            && chapter.mediaBytes === stored.mediaBytes
            && chapter.contentType === stored.contentType
          )) continue;
          updated ??= [...chapters];
          updated[index] = {
            ...chapter,
            isDownloaded: stored.isDownloaded,
            mediaRepairNeeded: stored.mediaRepairNeeded,
            contentBytes: stored.contentBytes,
            mediaBytes: stored.mediaBytes,
            contentType: stored.contentType,
          };
        }
        return updated ?? chapters;
      },
    );
    invalidations.push(
      queryClient.invalidateQueries({
        exact: true,
        queryKey: novelChaptersQueryKey(novelId),
        refetchType: "none",
      }),
    );
  }

  if (invalidations.length === 0) return;
  invalidations.push(
    queryClient.invalidateQueries({
      queryKey: novelLibraryQueryKey,
      refetchType: "none",
    }),
  );
  await Promise.all(invalidations);
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
    invalidate(queryClient, chapterHistoryQueryKey),
    invalidate(queryClient, chapterUpdatesQueryKey),
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
      invalidate(queryClient, novelLibraryQueryKey),
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
      invalidate(queryClient, novelLibraryQueryKey),
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
