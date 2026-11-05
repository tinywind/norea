import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { addNovelsToCategory, removeNovelsFromCategory } from "../../db/queries/category";
import {
  restoreChapterReadStates,
  setNovelsReadState,
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
import { MAX_CHAPTER_BULK_INPUT_ROWS } from "../../lib/performance-budgets";
import { invalidateChapterReadStateQueries } from "../../lib/reader-query-invalidation";
import { markUpdatesIndexDirty } from "../../lib/updates/update-index-events";
import { confirmContentDeletion } from "../../store/content-deletion";
import { type LibrarySortOrder } from "../../store/library";
import { DOWNLOAD_GOALS_QUERY_KEY } from "../DownloadGoalWorkLine";
import { showReadStateUndoToast } from "../read-state-undo-toast";
import { downloadOnceNotice, queueChapterDownloadsOnce } from "./download-once";

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
    mutationFn: ({ novelIds }: DownloadOnceInput) => queueChapterDownloadsOnce(novelIds, t, queryClient),
    onSuccess: (outcome) => {
      exitSelection();
      notifications.show(downloadOnceNotice(t, outcome));
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
