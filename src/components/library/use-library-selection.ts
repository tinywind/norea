import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { addNovelsToCategory } from "../../db/queries/category";
import {
  listChaptersByNovel,
  type ChapterListRow,
} from "../../db/queries/chapter";
import {
  getNovelById,
  setNovelInLibrary,
  type LibraryNovel,
  type LibraryNovelRefreshFilter,
} from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { enqueueChapterDownloadBatch } from "../../lib/tasks/chapter-download";
import { enqueueDownloadCacheDelete } from "../../lib/tasks/download-cache-delete";
import { type LibrarySortOrder } from "../../store/library";
import { useReaderStore } from "../../store/reader";
import {
  getLibraryBatchDownloadTargets,
  type LibraryBatchDownloadMode,
} from "./library-batch-download";

export function useLibrarySelection(
  libraryFilter: LibraryNovelRefreshFilter,
  sortOrder: LibrarySortOrder,
) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const {
    search: debouncedSearch,
    categoryId: selectedCategoryId,
    downloadedOnly: downloadedOnlyMode,
    sourceId: selectedSourceId,
    unreadOnly: unreadOnlyMode,
  } = libraryFilter;
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  useEffect(() => {
    setSelectedIds(new Set());
  }, [
    debouncedSearch,
    downloadedOnlyMode,
    selectedCategoryId,
    selectedSourceId,
    sortOrder,
    unreadOnlyMode,
  ]);

  const invalidateLibraryCategories = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["category"] });
    void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
  }, [queryClient]);

  const assignCategoryMutation = useMutation({
    mutationFn: ({ categoryId, novelIds }: AssignCategoryInput) =>
      addNovelsToCategory(novelIds, categoryId),
    onSuccess: () => {
      invalidateLibraryCategories();
      setSelectedIds(new Set());
    },
  });

  const batchDownloadMutation = useMutation({
    mutationFn: async (mode: LibraryBatchDownloadMode) => {
      const batchSources: Array<{
        chapters: ChapterListRow[];
        novel: Pick<LibraryNovel, "id" | "name" | "path" | "pluginId">;
      }> = [];
      let total = 0;
      const lastReadChapterByNovel =
        useReaderStore.getState().lastReadChapterByNovel;

      for (const novelId of selectedIds) {
        const novel = await getNovelById(novelId);
        if (!novel || novel.isLocal) continue;

        const chapters = await listChaptersByNovel(novel.id);
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
          total += targetChapters.length;
        }
      }

      if (total === 0) return 0;

      const chapterDownloadJobs = batchSources.flatMap(({ chapters, novel }) =>
        chapters.map((chapter) => ({
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

      const handle = enqueueChapterDownloadBatch({
        jobs: chapterDownloadJobs,
        materializeAllTasks: true,
        title: t("tasks.task.downloadChapterBatch", { count: total }),
        total,
      });
      const result = await handle.promise;
      return result.total;
    },
  });

  const deleteSelectedDownloadsMutation = useMutation({
    mutationFn: async (novelIds: readonly number[]) => {
      const handle = enqueueDownloadCacheDelete({
        scope: "novel",
        targetIds: novelIds,
        title: t("tasks.task.deleteDownloadCache"),
        progressLabel: (current, total) =>
          t("tasks.progress.deleteDownloadCache", { current, total }),
      });
      void handle.promise.then(
        () => {
          setSelectedIds(new Set());
          invalidateLibraryCategories();
          void queryClient.invalidateQueries({ queryKey: ["download-cache"] });
        },
        () => {
          invalidateLibraryCategories();
          void queryClient.invalidateQueries({ queryKey: ["download-cache"] });
        },
      );
      return { queued: true };
    },
  });

  const removeSelectedFromLibraryMutation = useMutation({
    mutationFn: async (novelIds: readonly number[]) => {
      for (const novelId of novelIds) {
        await setNovelInLibrary(novelId, false);
      }
    },
    onSuccess: () => {
      setSelectedIds(new Set());
      invalidateLibraryCategories();
      void queryClient.invalidateQueries({ queryKey: ["download-cache"] });
    },
  });

  const toggleSelected = useCallback((id: number) => {
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
    setSelectedIds(new Set());
  }, []);

  return {
    selectedIds,
    toggleSelected,
    clearSelection,
    assignCategoryMutation,
    batchDownloadMutation,
    deleteSelectedDownloadsMutation,
    removeSelectedFromLibraryMutation,
  };
}

interface AssignCategoryInput {
  categoryId: number;
  novelIds: number[];
}
