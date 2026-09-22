import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { type ChapterListRow } from "../../db/queries/chapter";
import type { NovelDetailRecord } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import {
  getNextChapterPreparationPlan,
  readerChapterQueryOptions,
} from "../../lib/reader-chapter";
import { invalidateReaderContentQueries } from "../../lib/reader-query-invalidation";
import {
  enqueueChapterDownload,
  subscribeChapterDownloads,
} from "../../lib/tasks/chapter-download";
import { useReaderDocument } from "../use-reader-document";

interface NextReaderChapterOptions {
  nextChapter: ChapterListRow | undefined;
  currentNovel: Pick<
    NovelDetailRecord,
    "id" | "name" | "path" | "pluginId"
  > | null;
  currentNovelId: number;
  currentSourceName: string | null;
  autoDownloadNextChapter: boolean;
  bionicReading: boolean;
  currentChapterReady: boolean;
}
export function useNextReaderChapter({
  nextChapter,
  currentNovel,
  currentNovelId,
  currentSourceName,
  autoDownloadNextChapter,
  bionicReading,
  currentChapterReady,
}: NextReaderChapterOptions) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const nextChapterPreparationPlan = getNextChapterPreparationPlan({
    autoDownloadNextChapter: autoDownloadNextChapter,
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
      nextContent.isDownloaded &&
      nextContent.contentType !== "pdf"
      ? nextContent.content
      : null,
    bionicReading,
    nextChapterId,
  );
  useEffect(() => {
    if (nextChapterId <= 0) return;
    return subscribeChapterDownloads((event) => {
      if (event.job.id !== nextChapterId || event.status.kind !== "done")
        return;
      void invalidateReaderContentQueries(queryClient, {
        chapterId: nextChapterId,
        novelId: currentNovelId,
      });
    });
  }, [currentNovelId, nextChapterId, queryClient]);
  const nextChapterDownloadRequestRef = useRef<number | null>(null);
  useEffect(() => {
    if (!nextChapterPreparationPlan?.download) {
      nextChapterDownloadRequestRef.current = null;
      return;
    }
    if (
      !nextChapter ||
      !currentNovel ||
      nextChapterDownloadRequestRef.current === nextChapter.id
    ) {
      return;
    }
    nextChapterDownloadRequestRef.current = nextChapter.id;
    const handle = enqueueChapterDownload({
      id: nextChapter.id,
      pluginId: currentNovel.pluginId,
      pluginName: currentSourceName ?? currentNovel.pluginId,
      chapterPath: nextChapter.path,
      chapterName: nextChapter.name,
      chapterNumber: nextChapter.chapterNumber ?? undefined,
      contentType: nextChapter.contentType,
      novelId: currentNovel.id,
      novelName: currentNovel.name,
      novelPath: currentNovel.path,
      priority: "background",
      title: t("tasks.task.downloadChapter", { name: nextChapter.name }),
    });
    void handle.promise.catch(() => undefined);
  }, [
    currentNovel,
    currentSourceName,
    nextChapter,
    nextChapterPreparationPlan?.download,
    t,
  ]);
}
