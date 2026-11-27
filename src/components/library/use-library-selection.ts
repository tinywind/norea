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
  listLibraryNovelIds,
  type LibraryNovelRefreshFilter,
} from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { isAbortError } from "../../lib/abort";
import { useOverlayBackNavigation } from "../../lib/android-back-navigation";
import { showErrorToast } from "../../lib/runtime/error-toast";
import { refreshSelectedNovelsMetadata } from "../../lib/tasks/novel-full-refresh";
import { MAX_CHAPTER_BULK_INPUT_ROWS } from "../../lib/performance-budgets";
import { invalidateChapterReadStateQueries } from "../../lib/reader-query-invalidation";
import { markUpdatesIndexDirty } from "../../lib/updates/update-index-events";
import { confirmContentDeletion } from "../../store/content-deletion";
import { type LibrarySortOrder } from "../../store/library";
import { useConfirm } from "../ui/ConfirmDialog";
import { showReadStateUndoToast } from "../read-state-undo-toast";
import { chaptersKey, novelKey } from "../novel/novel-detail-model";
import { downloadOnceNotice, queueChapterDownloadsOnce, type DownloadOnceSelection } from "./download-once";

export function useLibrarySelection(
  libraryFilter: LibraryNovelRefreshFilter,
  sortOrder: LibrarySortOrder,
  active = true,
) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const {
    search: debouncedSearch,
    categoryId: selectedCategoryId,
    downloadedOnly: downloadedOnlyMode,
    sourceId: selectedSourceId,
    unreadOnly: unreadOnlyMode,
    localOnly,
    completedOnly,
    repairNeededOnly,
    statuses,
    tags,
  } = libraryFilter;
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [selecting, setSelecting] = useState(false);
  const selectionMode = selecting || selectedIds.size > 0;
  const selectionRequestRef = useRef(0);
  const statusesKey = JSON.stringify(statuses ?? []);
  const tagsKey = JSON.stringify(tags ?? []);
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
    statusesKey,
    tagsKey,
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
    mutationFn: ({ novelIds, selection }: DownloadOnceInput) => queueChapterDownloadsOnce(novelIds, t, queryClient, selection),
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
    mutationFn: async ({ novelIds, unread }: SetNovelsReadStateInput) => {
      let limit = MAX_CHAPTER_BULK_INPUT_ROWS;
      for (;;) {
        const result = await setNovelsReadState(novelIds, unread, limit);
        if (result.confirmationChapterCount === undefined) return result;
        limit = result.confirmationChapterCount;
        const action = t(unread ? "selection.markUnread" : "selection.markRead");
        if (!await confirm({
          confirmLabel: action,
          danger: true,
          message: t("library.readState.confirmBulk", { chapters: limit, count: novelIds.length }),
          title: action,
        })) return null;
      }
    },
    onSuccess: (result, { novelIds, unread }) => {
      if (!result) return;
      const { previous, rowsAffected } = result;
      exitSelection();
      refreshReadState(novelIds);
      const message = t(unread ? "library.readState.markedUnread" : "library.readState.markedRead", {
        chapters: rowsAffected,
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

  const refreshAllMetadataMutation = useMutation({
    mutationFn: ({ novelIds }: { novelIds: readonly number[] }) =>
      refreshSelectedNovelsMetadata({
        novelIds,
        aggregateTaskTitle: t("novel.refreshAllDetails"),
        pluginNotLoadedMessage: t("source.pluginNotLoaded"),
        taskTitle: (novel) => t("tasks.task.refreshNovelMetadataFull", { name: novel.name }),
        onNovelSettled: (novelId) => {
          void queryClient.invalidateQueries({ queryKey: novelKey(novelId) });
          void queryClient.invalidateQueries({ queryKey: chaptersKey(novelId) });
        },
      }).promise,
    onSuccess: ({ refreshed, skippedLocal, failedIds }) => {
      if (failedIds.length) setSelectedIds(new Set(failedIds));
      else exitSelection();
      notifications.show({
        color: failedIds.length || refreshed === 0 ? "warn" : "ok",
        message: t(failedIds.length ? "library.refreshAll.partial" : "library.refreshAll.done", {
          count: refreshed, failed: failedIds.length, skipped: skippedLocal,
        }),
      });
    },
    onError: (error) => {
      if (!isAbortError(error)) showErrorToast(t("novel.refreshAllDetails"), error);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
      void queryClient.invalidateQueries({ queryKey: ["content-server", "novel-chapters"] });
    },
  });

  return {
    refreshAllMetadataMutation,
    selectedIds,
    selectionMode,
    toggleSelected,
    clearSelection,
    enterSelection,
    exitSelection,
    selectAllMutation,
    assignCategoryMutation,
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
  selection?: DownloadOnceSelection;
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
