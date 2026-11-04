import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { addNovelsToCategory, removeNovelsFromCategory } from "../../db/queries/category";
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
import { confirmContentDeletion } from "../../store/content-deletion";
import { type LibrarySortOrder } from "../../store/library";
import { DOWNLOAD_GOALS_QUERY_KEY } from "../DownloadGoalWorkLine";

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
    deleteSelectedDownloadsMutation,
    removeSelectedFromLibraryMutation,
  };
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
