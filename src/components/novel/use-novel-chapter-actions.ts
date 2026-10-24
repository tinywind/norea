import { useMutation, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import {
  setChaptersReadState,
  setRelativeChaptersReadState,
  type ChapterListRow,
} from "../../db/queries/chapter";
import { type NovelDetailRecord } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { invalidateChapterReadStateQueries } from "../../lib/reader-query-invalidation";
import { describeError } from "../../lib/errors";
import {
  enqueueChapterDownload,
  enqueueChapterDownloadBatch,
  enqueueChapterMediaRepair,
} from "../../lib/tasks/chapter-download";
import { confirmContentDeletion } from "../../store/content-deletion";
import { markUpdatesIndexDirty } from "../../lib/updates/update-index-events";
import { chaptersKey } from "./novel-detail-model";

type NovelDownloadSource = Pick<
  NovelDetailRecord,
  "id" | "name" | "path" | "pluginId" | "isLocal"
>;

export function useNovelChapterActions(
  id: number,
  novel: NovelDownloadSource | null | undefined,
  chapters: readonly Pick<ChapterListRow, "id" | "name">[],
) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const invalidateDeletedChapters = () => {
    void queryClient.invalidateQueries({ queryKey: chaptersKey(id) });
    void queryClient.invalidateQueries({ queryKey: ["chapter"] });
    void queryClient.invalidateQueries({ queryKey: ["download-cache"] });
    void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
  };
  const showDeleteError = (error: Error) => {
    notifications.show({
      color: "red",
      title: t("tasks.task.deleteDownloadCache"),
      message: describeError(error),
    });
  };
  const clearDownload = useMutation({
    mutationFn: async (chapterId: number) => {
      const chapter = chapters.find((row) => row.id === chapterId);
      return confirmContentDeletion({
        kind: "downloads", scope: "chapter",
        ids: [chapterId],
        title: t("tasks.task.deleteDownloadCacheChapter", {
          name: chapter?.name ?? String(chapterId),
        }),
      });
    },
    onSettled: invalidateDeletedChapters,
    onError: showDeleteError,
  });

  const clearSelectedDownloads = useMutation({
    mutationFn: async (chapterIds: readonly number[]) => {
      const uniqueChapterIds = Array.from(new Set(chapterIds)).filter(
        (chapterId) => Number.isInteger(chapterId) && chapterId > 0,
      );
      return confirmContentDeletion({
        kind: "downloads", scope: "chapter",
        ids: uniqueChapterIds,
        title: t("tasks.task.deleteDownloadCache"),
      });
    },
    onSettled: invalidateDeletedChapters,
    onError: showDeleteError,
  });

  const setSelectedChapterReadState = useMutation({
    mutationFn: ({
      chapterIds,
      unread,
    }: {
      chapterIds: readonly number[];
      unread: boolean;
    }) => setChaptersReadState(chapterIds, unread),
    onSuccess: () => {
      markUpdatesIndexDirty("read-progress");
      void invalidateChapterReadStateQueries(queryClient, { novelId: id });
    },
  });

  const setRelativeChapterReadState = useMutation({
    mutationFn: ({
      anchorChapterId,
      direction,
      unread,
    }: {
      anchorChapterId: number;
      direction: "before" | "after";
      unread: boolean;
    }) => setRelativeChaptersReadState(anchorChapterId, direction, unread),
    onSuccess: () => {
      markUpdatesIndexDirty("read-progress");
      void invalidateChapterReadStateQueries(queryClient, { novelId: id });
    },
  });

  const repairMedia = useMutation({
    mutationFn: async (chapter: ChapterListRow) => {
      if (!novel || novel.isLocal) return;
      await enqueueChapterMediaRepair({
        id: chapter.id,
        pluginId: novel.pluginId,
        priority: "user",
        title: t("tasks.task.repairChapterMedia", { name: chapter.name }),
      }).promise;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: chaptersKey(id),
      });
      void queryClient.invalidateQueries({ queryKey: ["chapter"] });
      void queryClient.invalidateQueries({ queryKey: ["download-cache"] });
      void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
    },
  });

  function downloadChapter(chapter: ChapterListRow): void {
    if (!novel) return;
    void enqueueChapterDownload({
      id: chapter.id,
      pluginId: novel.pluginId,
      chapterPath: chapter.path,
      chapterName: chapter.name,
      chapterNumber: chapter.chapterNumber ?? undefined,
      contentType: chapter.contentType,
      novelId: novel.id,
      novelName: novel.name,
      novelPath: novel.path,
      priority: "user",
      title: t("tasks.task.downloadChapter", { name: chapter.name }),
    }).promise.finally(() => queryClient.invalidateQueries({ queryKey: chaptersKey(id), exact: true })).catch(() => undefined);
  }

  function downloadChapters(chaptersToDownload: ChapterListRow[]): void {
    if (!novel || chaptersToDownload.length === 0) return;
    const batchNovel = novel;
    const chapterDownloadJobs = chaptersToDownload.map((chapter) => ({
      id: chapter.id,
      pluginId: batchNovel.pluginId,
      chapterPath: chapter.path,
      chapterName: chapter.name,
      chapterNumber: chapter.chapterNumber ?? undefined,
      contentType: chapter.contentType,
      novelId: batchNovel.id,
      novelName: batchNovel.name,
      novelPath: batchNovel.path,
      title: t("tasks.task.downloadChapter", { name: chapter.name }),
    }));

    void enqueueChapterDownloadBatch({
      jobs: chapterDownloadJobs,
      materializeAllTasks: true,
      title: t("tasks.task.downloadChapterBatch", {
        count: chaptersToDownload.length,
      }),
      total: chaptersToDownload.length,
    }).promise.finally(() => queryClient.invalidateQueries({ queryKey: chaptersKey(id), exact: true })).catch(() => undefined);
  }

  return {
    clearDownload,
    clearSelectedDownloads,
    setSelectedChapterReadState,
    setRelativeChapterReadState,
    repairMedia,
    downloadChapter,
    downloadChapters,
  };
}
