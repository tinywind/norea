import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  restoreChapterReadStates,
  setChaptersReadState,
  setRelativeChaptersReadState,
  type ChapterListRow,
  type ChapterReadState,
} from "../../db/queries/chapter";
import { type NovelDetailRecord } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { readServerNovelSource } from "../../lib/content-sync/novel-source";
import { prepareContentDeletion, runContentDeletion } from "../../lib/content-deletion";
import { invalidateChapterReadStateQueries } from "../../lib/reader-query-invalidation";
import { showErrorToast } from "../../lib/runtime/error-toast";
import {
  enqueueChapterMediaRepair,
  resumeChapterDownloadQueueAfterFailure,
} from "../../lib/tasks/chapter-download";
import { submitChapterDownloadRequest } from "../../lib/tasks/chapter-download-requests";
import { confirmContentDeletion } from "../../store/content-deletion";
import { useContentSyncStore } from "../../store/content-sync";
import { markUpdatesIndexDirty } from "../../lib/updates/update-index-events";
import { showReadStateUndoToast } from "../read-state-undo-toast";
import { BRIEF_TOAST_AUTO_CLOSE_MS } from "../ui/AppToasts";
import { useStopDownloadGoalsOffer } from "../use-stop-download-goals-offer";
import { chaptersKey } from "./novel-detail-model";
import type { ServerAwareChapterListRow } from "./NovelChapterList";

type NovelDownloadSource = Pick<
  NovelDetailRecord,
  "id" | "name" | "path" | "pluginId" | "isLocal"
>;

export function useNovelChapterActions(
  id: number,
  novel: NovelDownloadSource | null | undefined,
  chapters: readonly Pick<ChapterListRow, "id" | "name">[],
  options: { serverOnly?: boolean } = {},
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
      return chapter?.name ?? String(chapterId);
    },
    onSuccess: (name, chapterId) => {
      notifications.show({
        autoClose: BRIEF_TOAST_AUTO_CLOSE_MS,
        color: "ok",
        message: t("novel.downloadDeleted", { name }),
      });
      void offerToStopDownloadGoals([chapterId]);
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

  const refreshReadState = () => {
    markUpdatesIndexDirty("read-progress");
    void invalidateChapterReadStateQueries(queryClient, { novelId: id });
  };

  const setSelectedChapterReadState = useMutation({
    mutationFn: ({
      chapterIds,
      unread,
    }: {
      chapterIds: readonly number[];
      unread: boolean;
    }) => setChaptersReadState(chapterIds, unread),
    onSuccess: ({ previous }, { unread }) => {
      refreshReadState();
      offerReadStateUndo(previous, unread);
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
    onSuccess: ({ previous }, { unread }) => {
      refreshReadState();
      offerReadStateUndo(previous, unread);
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

  const undoReadState = useMutation({
    mutationFn: (previous: readonly ChapterReadState[]) => restoreChapterReadStates(previous),
    onSuccess: refreshReadState,
    onError: (error) => {
      showErrorToast(t("novel.readState.undoFailed"), error);
    },
  });

  /** Shows how many chapters changed with an Undo that puts back each one's read flag and progress. */
  function offerReadStateUndo(previous: readonly ChapterReadState[], unread: boolean): void {
    if (previous.length === 0) return;
    showReadStateUndoToast({
      message: t(unread ? "novel.readState.markedUnread" : "novel.readState.markedRead", { count: previous.length }),
      onUndo: () => undoReadState.mutate(previous),
      undoLabel: t("common.undo"),
    });
  }

  function downloadChapter(chapter: ServerAwareChapterListRow, retryAfterFailure = false): void {
    queueChapterDownloads([chapter], retryAfterFailure);
  }

  /** Downloads several chapters the user chose and confirms how many were queued. */
  function downloadChapters(chaptersToDownload: ServerAwareChapterListRow[]): void {
    const queued = queueChapterDownloads(chaptersToDownload);
    if (queued === 0) return;
    notifications.show({
      autoClose: BRIEF_TOAST_AUTO_CLOSE_MS,
      color: "ok",
      message: t("novel.downloadsQueued", { count: queued }),
    });
  }

  /** Queues available chosen chapters ahead of automatic goal work and returns the admitted count. */
  function queueChapterDownloads(chaptersToDownload: ServerAwareChapterListRow[], retryAfterFailure = false): number {
    if (!novel || chaptersToDownload.length === 0) return 0;
    const selected = options.serverOnly
      ? chaptersToDownload.filter(chapter => chapter.serverAvailable !== false)
      : chaptersToDownload;
    const skipped = chaptersToDownload.length - selected.length;
    if (skipped > 0) notifications.show({ autoClose: BRIEF_TOAST_AUTO_CLOSE_MS, color: "warn",
      message: t("downloadOnce.serverUnavailable", { count: skipped }) });
    if (selected.length === 0) return 0;
    const batchNovel = novel;
    let serverOnly = options.serverOnly === true;
    const chapterDownloadJobs = selected.map((chapter) => ({
      id: chapter.id,
      pluginId: batchNovel.pluginId,
      chapterPath: chapter.path,
      chapterName: chapter.name,
      chapterNumber: chapter.chapterNumber ?? undefined,
      contentType: chapter.contentType,
      novelId: batchNovel.id,
      novelName: batchNovel.name,
      novelPath: batchNovel.path,
      priority: "user" as const,
      title: t("tasks.task.downloadChapter", { name: chapter.name }),
    }));
    const title = t("tasks.task.downloadChapterBatch", { count: selected.length });
    const request = submitChapterDownloadRequest({
      key: JSON.stringify([batchNovel.pluginId, batchNovel.id, serverOnly, chapterDownloadJobs.map(job => job.id).sort((left, right) => left - right)]),
      title,
      novelIds: [batchNovel.id],
      total: selected.length,
      prepare: async () => {
        serverOnly ||= Boolean(await readServerNovelSource(batchNovel.id));
        return { jobs: chapterDownloadJobs.map(job => ({ ...job, ...(serverOnly ? { serverOnly: true as const } : {}) })),
          materializeAllTasks: true, title, total: selected.length };
      },
    });
    if (retryAfterFailure) {
      // Publish the current chapter path before acknowledging its source's failure stop.
      void request.materialized.then(() => {
        if (!serverOnly) return resumeChapterDownloadQueueAfterFailure(batchNovel.pluginId);
      }).catch(() => undefined);
    }
    void request.promise.finally(() => queryClient.invalidateQueries({ queryKey: chaptersKey(id), exact: true })).catch(() => undefined);
    return selected.length;
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
