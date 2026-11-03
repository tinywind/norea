import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { addNovelsToCategory, removeNovelsFromCategory } from "../../db/queries/category";
import {
  listLibraryDownloadChapters,
  type LibraryDownloadChapter,
} from "../../db/queries/chapter";
import {
  getNovelById,
  listLibraryNovelIds,
  type LibraryNovel,
  type LibraryNovelRefreshFilter,
} from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { useOverlayBackNavigation } from "../../lib/android-back-navigation";
import { showErrorToast } from "../../lib/runtime/error-toast";
import { submitChapterDownloadRequest } from "../../lib/tasks/chapter-download-requests";
import { REQUEST_CANCELLED_ERROR, throwIfAborted } from "../../lib/abort";
import { confirmContentDeletion } from "../../store/content-deletion";
import { type LibrarySortOrder } from "../../store/library";
import { useReaderStore } from "../../store/reader";
import {
  getLibraryBatchDownloadTargets,
  type LibraryBatchDownloadMode,
} from "./library-batch-download";
import { useLibraryDownloadAvailability } from "./use-library-download-availability";

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
  const batchDownloadAvailability = useLibraryDownloadAvailability(
    selectedIds,
    active,
  );
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

  const batchDownloadMutation = useMutation({
    mutationFn: async (mode: LibraryBatchDownloadMode) => {
      const novelIds = [...selectedIds];
      const lastReadChapterByNovel =
        useReaderStore.getState().lastReadChapterByNovel;
      let total = 0;
      const handle = submitChapterDownloadRequest({
        key: JSON.stringify(["library", mode, [...novelIds].sort((left, right) => left - right), novelIds.map(novelId => lastReadChapterByNovel[novelId])]),
        title: t("library.batchDownload.open"),
        novelIds,
        prepare: async signal => {
          const batchSources: Array<{
            chapters: LibraryDownloadChapter[];
            novel: Pick<LibraryNovel, "id" | "name" | "path" | "pluginId">;
          }> = [];
          for (const novelId of novelIds) {
            throwIfAborted(signal, REQUEST_CANCELLED_ERROR);
            const novel = await getNovelById(novelId);
            throwIfAborted(signal, REQUEST_CANCELLED_ERROR);
            if (!novel || novel.isLocal) continue;
            const chapters = await listLibraryDownloadChapters(novel.id);
            throwIfAborted(signal, REQUEST_CANCELLED_ERROR);
            const targetChapters = getLibraryBatchDownloadTargets(mode, chapters, lastReadChapterByNovel[novel.id]);
            if (targetChapters.length > 0) batchSources.push({ chapters: targetChapters, novel });
          }
          const jobs = batchSources.flatMap(({ chapters, novel }) =>
            getLibraryBatchDownloadTargets("all", chapters, undefined).map(chapter => ({
              id: chapter.id,
              pluginId: novel.pluginId,
              chapterPath: chapter.path,
              chapterName: chapter.name,
              chapterNumber: chapter.chapterNumber ?? undefined,
              contentType: chapter.contentType,
              novelId: novel.id,
              novelName: novel.name,
              novelPath: novel.path,
              title: t("tasks.task.downloadChapter", { name: chapter.name }),
            })),
          );
          total = jobs.length;
          return { jobs, materializeAllTasks: true, title: t("tasks.task.downloadChapterBatch", { count: total }), total };
        },
      });
      void handle.promise
        .finally(() => total > 0 ? queryClient.invalidateQueries({ queryKey: ["novel", "library"] }) : undefined)
        .catch(() => undefined);
      await handle.materialized;
      return total;
    },
    onSuccess: (total) => {
      notifications.show({
        color: total > 0 ? "ok" : undefined,
        message: total > 0
          ? t("library.batchDownload.queued", { count: total })
          : t("library.batchDownload.nothingQueued"),
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["novel", "library", "batch-download"],
      });
    },
    onError: (error) => {
      showErrorToast(t("library.batchDownload.open"), error);
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
    mutationFn: (novelIds: readonly number[]) => confirmContentDeletion({
      kind: "library",
      ids: novelIds,
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
    batchDownloadMutation,
    batchDownloadAvailability,
    deleteSelectedDownloadsMutation,
    removeSelectedFromLibraryMutation,
  };
}

interface DeleteSelectedDownloadsInput {
  downloadedChapters: number;
  novelIds: readonly number[];
}

interface AssignCategoryInput {
  add: readonly number[];
  novelIds: readonly number[];
  remove: readonly number[];
}
