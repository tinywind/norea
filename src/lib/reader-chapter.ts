import { queryOptions } from "@tanstack/react-query";
import {
  getChapterById,
  type ChapterListRow,
  type ChapterRow,
} from "../db/queries/chapter";
import { readStoredChapterContentMirror } from "./chapter-content-storage";
import { chapterDetailQueryKey } from "./reader-query-invalidation";

export type ReaderChapterRow = ChapterRow & { content: string | null };

export interface NextChapterPreparationPlan {
  chapterId: number;
  download: boolean;
}

export function getNextChapterPreparationPlan({
  autoDownloadNextChapter,
  currentChapterReady,
  nextChapter,
}: {
  autoDownloadNextChapter: boolean;
  currentChapterReady: boolean;
  nextChapter: Pick<ChapterListRow, "id" | "isDownloaded"> | undefined;
}): NextChapterPreparationPlan | null {
  if (!currentChapterReady || !nextChapter) return null;
  if (nextChapter.isDownloaded) {
    return { chapterId: nextChapter.id, download: false };
  }
  return autoDownloadNextChapter
    ? { chapterId: nextChapter.id, download: true }
    : null;
}

export function readerChapterQueryOptions(chapterId: number) {
  return queryOptions({
    queryKey: chapterDetailQueryKey(chapterId),
    queryFn: async ({ signal }): Promise<ReaderChapterRow | null> => {
      const chapter = await getChapterById(chapterId);
      signal.throwIfAborted();
      if (!chapter) return null;
      const content = await readStoredChapterContentMirror(chapter.id);
      signal.throwIfAborted();
      const reconciledChapter = await getChapterById(chapterId);
      signal.throwIfAborted();
      return { ...(reconciledChapter ?? chapter), content };
    },
  });
}
