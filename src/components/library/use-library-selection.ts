import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { addNovelsToCategory, removeNovelsFromCategory } from "../../db/queries/category";
import {
  listUnqueuedChapterDownloads,
  restoreChapterReadStates,
  setNovelsReadState,
  type ChapterListRow,
  type ChapterReadState,
} from "../../db/queries/chapter";
import {
  getNovelById,
  listLibraryNovelIds,
  type LibraryNovelRefreshFilter,
} from "../../db/queries/novel";
import type { NovelDownloadGoal } from "../../db/queries/novel-download-goal";
import { useTranslation } from "../../i18n";
import { useOverlayBackNavigation } from "../../lib/android-back-navigation";
import { setDownloadGoal } from "../../lib/download-goals/goal-service";
import { showErrorToast } from "../../lib/runtime/error-toast";
import { isChapterDownloadQueued, type ChapterDownloadJob } from "../../lib/tasks/chapter-download";
import { submitChapterDownloadRequest } from "../../lib/tasks/chapter-download-requests";
import { MAX_CHAPTER_BULK_INPUT_ROWS, MAX_ROUTE_QUERY_ROWS } from "../../lib/performance-budgets";
import { invalidateChapterReadStateQueries } from "../../lib/reader-query-invalidation";
import { markUpdatesIndexDirty } from "../../lib/updates/update-index-events";
import { confirmContentDeletion } from "../../store/content-deletion";
import { type LibrarySortOrder } from "../../store/library";
import { DOWNLOAD_GOALS_QUERY_KEY } from "../DownloadGoalWorkLine";
import { showReadStateUndoToast } from "../read-state-undo-toast";

export function useLibrarySelection(
  libraryFilter: LibraryNovelRefreshFilter,
  sortOrder: LibrarySortOrder,
  active = true,
) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const {
    search: debouncedSearch,
    categoryId: selectedCategoryId,
    downloadedOnly: downloadedOnlyMode,
    sourceId: selectedSourceId,
    unreadOnly: unreadOnlyMode,
    localOnly,
    completedOnly,
    repairNeededOnly,
  } = libraryFilter;
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [selecting, setSelecting] = useState(false);
  const selectionMode = selecting || selectedIds.size > 0;
  const selectionRequestRef = useRef(0);
  const selectionScope = JSON.stringify([libraryFilter, sortOrder, active]);
  const selectionScopeRef = useRef(selectionScope);
  selectionScopeRef.current = selectionScope;
  useEffect(() => {
    selectionRequestRef.current += 1;
    setSelectedIds(new Set());
  }, [
    debouncedSearch,
    downloadedOnlyMode,
    selectedCategoryId,
    selectedSourceId,
    sortOrder,
    unreadOnlyMode,
    localOnly,
    completedOnly,
    repairNeededOnly,
  ]);

  const invalidateLibraryCategories = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["category"] });
    void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
  }, [queryClient]);

  const exitSelection = useCallback(() => {
    selectionRequestRef.current += 1;
    setSelectedIds(new Set());
    setSelecting(false);
  }, []);

  const assignCategoryMutation = useMutation({
    mutationFn: async ({ add, novelIds, remove }: AssignCategoryInput) => {
      for (const categoryId of add) await addNovelsToCategory(novelIds, categoryId);
      for (const categoryId of remove) await removeNovelsFromCategory(novelIds, categoryId);
    },
    onSuccess: (_result, { novelIds }) => {
      invalidateLibraryCategories();
      exitSelection();
      notifications.show({
        color: "ok",
        message: t("library.categoryAction.done", { count: novelIds.length }),
      });
    },
    onError: (error) => {
      showErrorToast(t("library.editSelectedCategories"), error);
    },
  });

  const setDownloadGoalMutation = useMutation({
    mutationFn: async ({ goal, novelIds }: SetDownloadGoalInput) => {
      let applied = 0;
      let skippedLocal = 0;
      for (const novelId of novelIds) {
        const novel = await getNovelById(novelId);
        if (!novel) continue;
        if (novel.isLocal) {
          skippedLocal += 1;
          continue;
        }
        await setDownloadGoal(novelId, goal);
        applied += 1;
      }
      return { applied, skippedLocal };
    },
    onSuccess: ({ applied, skippedLocal }) => {
      exitSelection();
      notifications.show(applied === 0
        ? { color: "warn", message: t("library.downloadGoal.noneApplied", { skipped: skippedLocal }) }
        : {
            color: "ok",
            message: skippedLocal > 0
              ? t("library.downloadGoal.doneSkippedLocal", { count: applied, skipped: skippedLocal })
              : t("library.downloadGoal.done", { count: applied }),
          });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: DOWNLOAD_GOALS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["download-goal"] });
    },
    onError: (error) => {
      showErrorToast(t("library.selection.download"), error);
    },
  });

  const deleteSelectedDownloadsMutation = useMutation({
    mutationFn: ({ downloadedChapters, novelIds }: DeleteSelectedDownloadsInput) =>
      confirmContentDeletion({
        kind: "downloads", scope: "novel",
        ids: novelIds,
        title: t("library.deleteSelectedDownloadsConfirm", {
          chapters: downloadedChapters,
          count: novelIds.length,
        }),
      }),
    onSuccess: changed => { if (changed) exitSelection(); },
    onSettled: () => {
      invalidateLibraryCategories();
      void queryClient.invalidateQueries({ queryKey: ["download-cache"] });
    },
    onError: (error) => {
      showErrorToast(t("tasks.task.deleteDownloadCache"), error);
    },
  });

  const removeSelectedFromLibraryMutation = useMutation({
    mutationFn: ({ downloadedCount, novelIds }: RemoveSelectedFromLibraryInput) => confirmContentDeletion({
      kind: "library",
      ids: novelIds,
      downloadedCount,
      title: t("library.removeSelectedFromLibraryConfirm", { count: novelIds.length }),
    }),
    onSuccess: changed => {
      if (!changed) return;
      exitSelection();
      invalidateLibraryCategories();
      void queryClient.invalidateQueries({ queryKey: ["download-cache"] });
    },
  });

  const toggleSelected = useCallback((id: number) => {
    selectionRequestRef.current += 1;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    selectionRequestRef.current += 1;
    setSelectedIds(new Set());
    setSelecting(true);
  }, []);
  const enterSelection = useCallback(() => setSelecting(true), []);
  useOverlayBackNavigation(active && selectionMode, exitSelection);

  const selectAllMutation = useMutation({
    mutationFn: async () => {
      const request = ++selectionRequestRef.current;
      const scope = selectionScopeRef.current;
      const ids = await listLibraryNovelIds(libraryFilter);
      if (request === selectionRequestRef.current && scope === selectionScopeRef.current) {
        setSelectedIds(new Set(ids));
      }
      return ids.length;
    },
    onError: (error) => {
      showErrorToast(t("library.selection.selectAll"), error);
    },
  });

  const downloadOnceMutation = useMutation({
    mutationFn: async ({ novelIds }: DownloadOnceInput) => {
      let queued = 0;
      let skippedLocal = 0;
      for (const novelId of novelIds) {
        const novel = await getNovelById(novelId);
        if (!novel) continue;
        if (novel.isLocal) {
          skippedLocal += 1;
          continue;
        }
        const chapters = (await listChaptersToDownloadOnce(novel.id))
          .filter((chapter) => !isChapterDownloadQueued(chapter.id));
        if (chapters.length === 0) continue;
        const jobs: ChapterDownloadJob[] = chapters.map((chapter) => ({
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
        }));
        const title = t("tasks.task.downloadChapterBatch", { count: jobs.length });
        void submitChapterDownloadRequest({
          key: JSON.stringify(["download-once", novel.id, jobs.map((job) => job.id)]),
          title,
          novelIds: [novel.id],
          total: jobs.length,
          prepare: async () => ({ jobs, materializeAllTasks: true, title, total: jobs.length }),
        }).promise.finally(() => queryClient.invalidateQueries({ queryKey: ["novel", "library"] }))
          .catch(() => undefined);
        queued += jobs.length;
      }
      return { queued, skippedLocal };
    },
    onSuccess: ({ queued, skippedLocal }) => {
      exitSelection();
      if (queued === 0) {
        notifications.show({
          color: "warn",
          message: skippedLocal > 0
            ? t("library.downloadOnce.nothingSkippedLocal", { skipped: skippedLocal })
            : t("library.downloadOnce.nothing"),
        });
        return;
      }
      notifications.show({
        color: "ok",
        message: skippedLocal > 0
          ? t("library.downloadOnce.doneSkippedLocal", { count: queued, skipped: skippedLocal })
          : t("library.downloadOnce.done", { count: queued }),
      });
    },
    onError: (error) => {
      showErrorToast(t("library.downloadOnce.title"), error);
    },
  });

  const refreshReadState = (novelIds: readonly number[]) => {
    markUpdatesIndexDirty("read-progress");
    for (const novelId of novelIds) void invalidateChapterReadStateQueries(queryClient, { novelId });
  };

  const undoNovelsReadStateMutation = useMutation({
    mutationFn: ({ previous }: { novelIds: readonly number[]; previous: readonly ChapterReadState[] }) =>
      restoreChapterReadStates(previous),
    onSuccess: (_result, { novelIds }) => refreshReadState(novelIds),
    onError: (error) => {
      showErrorToast(t("novel.readState.undoFailed"), error);
    },
  });

  const setNovelsReadStateMutation = useMutation({
    mutationFn: ({ novelIds, unread }: SetNovelsReadStateInput) => setNovelsReadState(novelIds, unread),
    onSuccess: ({ previous }, { novelIds, unread }) => {
      exitSelection();
      refreshReadState(novelIds);
      const message = t(unread ? "library.readState.markedUnread" : "library.readState.markedRead", {
        chapters: previous.length,
        count: novelIds.length,
      });
      // Restoring is bounded by the bulk chapter limit, so a larger change is reported without Undo.
      if (previous.length === 0 || previous.length > MAX_CHAPTER_BULK_INPUT_ROWS) {
        notifications.show({ color: "ok", message });
        return;
      }
      showReadStateUndoToast({
        message,
        onUndo: () => undoNovelsReadStateMutation.mutate({ novelIds, previous }),
        undoLabel: t("common.undo"),
      });
    },
    onError: (error, { unread }) => {
      showErrorToast(t(unread ? "library.selection.markUnread" : "library.selection.markRead"), error);
    },
  });

  return {
    selectedIds,
    selectionMode,
    toggleSelected,
    clearSelection,
    enterSelection,
    exitSelection,
    selectAllMutation,
    assignCategoryMutation,
    setDownloadGoalMutation,
    downloadOnceMutation,
    deleteSelectedDownloadsMutation,
    removeSelectedFromLibraryMutation,
    setNovelsReadStateMutation,
  };
}

/** Every chapter of a source novel with no stored body and no persisted download, in reading order. */
async function listChaptersToDownloadOnce(novelId: number): Promise<ChapterListRow[]> {
  const chapters: ChapterListRow[] = [];
  for (let afterChapterId = 0; ;) {
    const page = await listUnqueuedChapterDownloads(novelId, afterChapterId);
    chapters.push(...page);
    if (page.length < MAX_ROUTE_QUERY_ROWS) break;
    afterChapterId = page.at(-1)!.id;
  }
  return chapters.sort((left, right) => left.position - right.position || left.id - right.id);
}

interface SetNovelsReadStateInput {
  novelIds: readonly number[];
  unread: boolean;
}

interface DownloadOnceInput {
  novelIds: readonly number[];
}

interface SetDownloadGoalInput {
  goal: NovelDownloadGoal | null;
  novelIds: readonly number[];
}

interface DeleteSelectedDownloadsInput {
  downloadedChapters: number;
  novelIds: readonly number[];
}

interface RemoveSelectedFromLibraryInput {
  /** Stored chapters of the selection, when known; zero hides the download deletion option. */
  downloadedCount?: number;
  novelIds: readonly number[];
}

interface AssignCategoryInput {
  add: readonly number[];
  novelIds: readonly number[];
  remove: readonly number[];
}
