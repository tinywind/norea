import { useMutation, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
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
import { describeError } from "../../lib/errors";
import { enqueueChapterDownloadBatch } from "../../lib/tasks/chapter-download";
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

  const assignCategoryMutation = useMutation({
    mutationFn: ({ categoryId, novelIds, mode = "add" }: AssignCategoryInput) =>
      mode === "remove"
        ? removeNovelsFromCategory(novelIds, categoryId)
        : addNovelsToCategory(novelIds, categoryId),
    onSuccess: () => {
      invalidateLibraryCategories();
      setSelectedIds(new Set());
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: t("library.editSelectedCategories"),
        message: describeError(error),
      });
    },
  });

  const batchDownloadMutation = useMutation({
    mutationFn: async (mode: LibraryBatchDownloadMode) => {
      const batchSources: Array<{
        chapters: LibraryDownloadChapter[];
        novel: Pick<LibraryNovel, "id" | "name" | "path" | "pluginId">;
      }> = [];
      const lastReadChapterByNovel =
        useReaderStore.getState().lastReadChapterByNovel;

      for (const novelId of selectedIds) {
        const novel = await getNovelById(novelId);
        if (!novel || novel.isLocal) continue;

        const chapters = await listLibraryDownloadChapters(novel.id);
        const targetChapters = getLibraryBatchDownloadTargets(
          mode,
          chapters,
          lastReadChapterByNovel[novel.id],
        );

        if (targetChapters.length > 0) {
          batchSources.push({
            chapters: targetChapters,
            novel,
          });
        }
      }

      const chapterDownloadJobs = batchSources.flatMap(({ chapters, novel }) =>
        getLibraryBatchDownloadTargets("all", chapters, undefined).map((chapter) => ({
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
      const total = chapterDownloadJobs.length;
      if (total === 0) return 0;

      const handle = enqueueChapterDownloadBatch({
        jobs: chapterDownloadJobs,
        materializeAllTasks: true,
        title: t("tasks.task.downloadChapterBatch", { count: total }),
        total,
      });
      void handle.promise
        .finally(() =>
          queryClient.invalidateQueries({ queryKey: ["novel", "library"] }),
        )
        .catch(() => undefined);
      return total;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["novel", "library", "batch-download"],
      });
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: t("library.batchDownload.open"),
        message: describeError(error),
      });
    },
  });

  const deleteSelectedDownloadsMutation = useMutation({
    mutationFn: (novelIds: readonly number[]) =>
      confirmContentDeletion({
        kind: "downloads", scope: "novel",
        ids: novelIds,
        title: t("tasks.task.deleteDownloadCache"),
      }),
    onSuccess: changed => { if (changed) setSelectedIds(new Set()); },
    onSettled: () => {
      invalidateLibraryCategories();
      void queryClient.invalidateQueries({ queryKey: ["download-cache"] });
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: t("tasks.task.deleteDownloadCache"),
        message: describeError(error),
      });
    },
  });

  const removeSelectedFromLibraryMutation = useMutation({
    mutationFn: (novelIds: readonly number[]) => confirmContentDeletion({ kind: "library", ids: novelIds, title: t("library.removeSelectedFromLibrary") }),
    onSuccess: changed => {
      if (!changed) return;
      setSelectedIds(new Set());
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
  }, []);

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
      notifications.show({
        color: "red",
        title: t("library.selection.selectAll"),
        message: describeError(error),
      });
    },
  });

  return {
    selectedIds,
    toggleSelected,
    clearSelection,
    selectAllMutation,
    assignCategoryMutation,
    batchDownloadMutation,
    batchDownloadAvailability,
    deleteSelectedDownloadsMutation,
    removeSelectedFromLibraryMutation,
  };
}

interface AssignCategoryInput {
  mode?: "add" | "remove";
  categoryId: number;
  novelIds: number[];
}
