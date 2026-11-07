import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { hasStoredChapterContent, type ChapterListRow } from "../../db/queries/chapter";
import { hasRemoteChapterMedia } from "../../lib/chapter-media";
import {
  getNextChapterPreparationPlan,
  readerChapterQueryOptions,
} from "../../lib/reader-chapter";
import { invalidateReaderContentQueries } from "../../lib/reader-query-invalidation";
import { subscribeChapterDownloads } from "../../lib/tasks/chapter-download";
import type { PreparedReaderDocument } from "../reader-document";
import { useReaderDocument } from "../use-reader-document";

interface NextReaderChapterOptions {
  active: boolean;
  nextChapter: ChapterListRow | undefined;
  currentNovelId: number;
  bionicReading: boolean;
  currentChapterReady: boolean;
}

/** Hidden layout must not run embedded content, change the current chapter's styles, or fetch remote media. */
export function canPreRenderReaderDocument(document: PreparedReaderDocument): boolean {
  return document.virtualDocument.staticHtml.trim() === ""
    && !/<(?:script|style|link|iframe|object|embed|audio|video)\b|\son[a-z]+\s*=|\bautofocus\b/i.test(document.html)
    && !hasRemoteChapterMedia(document.html, "https://norea.invalid/");
}

/** Prepares one stored chapter; download goals remain responsible for fetching missing chapters. */
export function useNextReaderChapter({
  active,
  nextChapter,
  currentNovelId,
  bionicReading,
  currentChapterReady,
}: NextReaderChapterOptions) {
  const queryClient = useQueryClient();
  const nextChapterPreparationPlan = getNextChapterPreparationPlan({
    currentChapterReady: active && currentChapterReady,
    nextChapter: nextChapter?.novelId === currentNovelId ? nextChapter : undefined,
  });
  const nextChapterId = nextChapterPreparationPlan?.chapterId ?? 0;
  const nextChapterQuery = useQuery({
    ...readerChapterQueryOptions(nextChapterId),
    enabled: nextChapterId > 0,
    retry: false,
  });
  const nextContent = nextChapterQuery.data;
  const chapter = nextContent?.id === nextChapterId
    && nextContent.novelId === currentNovelId
    && hasStoredChapterContent(nextContent)
    && nextContent.contentType !== "pdf"
    ? nextContent
    : null;
  const preparation = useReaderDocument(
    chapter?.content ?? null,
    bionicReading,
    nextChapterId,
  );
  const preparedChapter = useMemo(() =>
    chapter && preparation.isCurrent && preparation.document
      && canPreRenderReaderDocument(preparation.document)
      ? { chapter, document: preparation.document }
      : null,
  [chapter, preparation.document, preparation.isCurrent]);
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
  return preparedChapter;
}
