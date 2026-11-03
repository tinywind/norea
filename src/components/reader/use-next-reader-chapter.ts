import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { hasStoredChapterContent, type ChapterListRow } from "../../db/queries/chapter";
import {
  getNextChapterPreparationPlan,
  readerChapterQueryOptions,
} from "../../lib/reader-chapter";
import { invalidateReaderContentQueries } from "../../lib/reader-query-invalidation";
import { subscribeChapterDownloads } from "../../lib/tasks/chapter-download";
import { useReaderDocument } from "../use-reader-document";

interface NextReaderChapterOptions {
  nextChapter: ChapterListRow | undefined;
  currentNovelId: number;
  bionicReading: boolean;
  currentChapterReady: boolean;
}

/** Prepares the stored next chapter; download goals keep the following chapters on the device. */
export function useNextReaderChapter({
  nextChapter,
  currentNovelId,
  bionicReading,
  currentChapterReady,
}: NextReaderChapterOptions) {
  const queryClient = useQueryClient();
  const nextChapterPreparationPlan = getNextChapterPreparationPlan({
    currentChapterReady: currentChapterReady,
    nextChapter,
  });
  const nextChapterId = nextChapterPreparationPlan?.chapterId ?? 0;
  const nextChapterQuery = useQuery({
    ...readerChapterQueryOptions(nextChapterId),
    enabled: nextChapterId > 0,
    retry: false,
  });
  const nextContent = nextChapterQuery.data;
  useReaderDocument(
    nextContent?.id === nextChapterId &&
      hasStoredChapterContent(nextContent) &&
      nextContent.contentType !== "pdf"
      ? nextContent.content
      : null,
    bionicReading,
    nextChapterId,
  );
  const upcomingChapterId = nextChapter?.id ?? 0;
  useEffect(() => {
    if (upcomingChapterId <= 0) return;
    return subscribeChapterDownloads((event) => {
      if (event.job.id !== upcomingChapterId || event.status.kind !== "done")
        return;
      void invalidateReaderContentQueries(queryClient, {
        chapterId: upcomingChapterId,
        novelId: currentNovelId,
      });
    });
  }, [currentNovelId, upcomingChapterId, queryClient]);
}
