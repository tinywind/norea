import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  setChaptersReadState,
  setRelativeChaptersReadState,
  type ChapterListRow,
} from "../../db/queries/chapter";
import { type NovelDetailRecord } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { prepareContentDeletion, runContentDeletion } from "../../lib/content-deletion";
import { invalidateChapterReadStateQueries } from "../../lib/reader-query-invalidation";
import { showErrorToast } from "../../lib/runtime/error-toast";
import {
  enqueueChapterMediaRepair,
} from "../../lib/tasks/chapter-download";
import { submitChapterDownloadRequest } from "../../lib/tasks/chapter-download-requests";
import { confirmContentDeletion } from "../../store/content-deletion";
import { useContentSyncStore } from "../../store/content-sync";
import { markUpdatesIndexDirty } from "../../lib/updates/update-index-events";
import { useStopDownloadGoalsOffer } from "../use-stop-download-goals-offer";
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
  const offerToStopDownloadGoals = useStopDownloadGoalsOffer();
  const invalidateDeletedChapters = () => {
    void queryClient.invalidateQueries({ queryKey: chaptersKey(id) });
    void queryClient.invalidateQueries({ queryKey: ["chapter"] });
    void queryClient.invalidateQueries({ queryKey: ["download-cache"] });
    void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
  };
  const showDeleteError = (error: Error) => {
    showErrorToast(
      t("tasks.task.deleteDownloadCache"),
      error,
      `downloads:novel:${id}`,
    );
  };
  /** Deletes one chapter's stored files; the caller confirms first. */
  const clearDownload = useMutation({
    mutationFn: async (chapterId: number) => {
      const chapter = chapters.find((row) => row.id === chapterId);
      const actions = await prepareContentDeletion({
        kind: "downloads", scope: "chapter",
        ids: [chapterId],
        serverUrl: useContentSyncStore.getState().serverUrl,
        title: t("tasks.task.deleteDownloadCacheChapter", {
          name: chapter?.name ?? String(chapterId),
        }),
      }, { local: false, server: false });
      const failure = (await runContentDeletion(actions))
        .find((result) => result.status === "failed");
      if (failure) throw new Error(failure.error);
      markUpdatesIndexDirty("library-membership");
    },
    onSuccess: (_result, chapterId) => { void offerToStopDownloadGoals("chapter", [chapterId]); },
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
    downloadChapters([chapter], "user");
  }

  function downloadChapters(chaptersToDownload: ChapterListRow[], priority?: "user"): void {
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
      priority,
      title: t("tasks.task.downloadChapter", { name: chapter.name }),
    }));
    const title = t("tasks.task.downloadChapterBatch", { count: chaptersToDownload.length });
    void submitChapterDownloadRequest({
      key: JSON.stringify([batchNovel.pluginId, batchNovel.id, chapterDownloadJobs.map(job => job.id).sort((left, right) => left - right), priority]),
      title,
      novelIds: [batchNovel.id],
      total: chaptersToDownload.length,
      prepare: async () => ({ jobs: chapterDownloadJobs, materializeAllTasks: true, title, total: chaptersToDownload.length }),
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
