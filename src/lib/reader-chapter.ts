import { queryOptions } from "@tanstack/react-query";
import {
  getChapterById,
  hasStoredChapterContent,
  type ChapterListRow,
  type ChapterRow,
} from "../db/queries/chapter";
import { readStoredChapterContentMirror } from "./chapter-content-storage";
import { chapterDetailQueryKey } from "./reader-query-invalidation";

export type ReaderChapterRow = ChapterRow & { content: string | null };

export interface NextChapterPreparationPlan {
  chapterId: number;
}

/** The stored next chapter to prepare once the current one is ready; download goals fetch missing ones. */
export function getNextChapterPreparationPlan({
  currentChapterReady,
  nextChapter,
}: {
  currentChapterReady: boolean;
  nextChapter: Pick<ChapterListRow, "id" | "isDownloaded" | "contentBytes"> | undefined;
}): NextChapterPreparationPlan | null {
  if (!currentChapterReady || !nextChapter || !hasStoredChapterContent(nextChapter)) return null;
  return { chapterId: nextChapter.id };
}

export function readerChapterQueryOptions(chapterId: number) {
  return queryOptions({
    queryKey: chapterDetailQueryKey(chapterId),
    queryFn: async ({ signal }): Promise<ReaderChapterRow | null> => {
      const chapter = await getChapterById(chapterId, "committed");
      signal.throwIfAborted();
      if (!chapter) return null;
      const content = await readStoredChapterContentMirror(chapter.id, "committed");
      signal.throwIfAborted();
      const reconciledChapter = await getChapterById(chapterId, "committed");
      signal.throwIfAborted();
      return { ...(reconciledChapter ?? chapter), content };
    },
  });
}
