import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  setNovelInLibrary,
  type NovelDetailRecord,
} from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { saveNovelCoverFromSource } from "../../lib/novel-cover-storage";
import { pluginManager } from "../../lib/plugins/manager";
import {
  getSourceDuplicateChapterInfo,
  syncNovelFromSource,
  type SourceDuplicateChapterInfo,
} from "../../lib/plugins/sync-novel";
import { enqueueSourceTask } from "../../lib/tasks/source-tasks";
import { markUpdatesIndexDirty } from "../../lib/updates/update-index-events";
import {
  chaptersKey,
  novelKey,
  type NovelMetadataRefreshMode,
} from "./novel-detail-model";

type NovelMetadataSource = Pick<
  NovelDetailRecord,
  "id" | "name" | "path" | "pluginId" | "cover" | "isLocal" | "inLibrary"
>;

export function useNovelMetadata(
  id: number,
  novel: NovelMetadataSource | null | undefined,
) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [sourceDuplicateChapters, setSourceDuplicateChapters] = useState<
    readonly SourceDuplicateChapterInfo[]
  >(() => getSourceDuplicateChapterInfo(id));
  useEffect(() => {
    setSourceDuplicateChapters(getSourceDuplicateChapterInfo(id));
  }, [id]);

  const toggle = useMutation({
    mutationFn: async () => {
      if (!novel) return;
      const inLibrary = !novel.inLibrary;
      await setNovelInLibrary(novel.id, inLibrary);
      return { inLibrary, novel };
    },
    onSuccess: (result) => {
      if (!result) return;
      markUpdatesIndexDirty("library-membership");
      queryClient.setQueryData<NovelDetailRecord | null>(
        novelKey(result.novel.id),
        (current) =>
          current ? { ...current, inLibrary: result.inLibrary } : current,
      );
      void queryClient.invalidateQueries({
        exact: true,
        queryKey: novelKey(result.novel.id),
        refetchType: "none",
      });
      void queryClient.invalidateQueries({
        queryKey: ["novel", "library"],
        refetchType: "none",
      });

      if (!result.inLibrary || result.novel.isLocal || !result.novel.cover) {
        return;
      }
      const plugin = pluginManager.getPlugin(result.novel.pluginId);
      if (!plugin) return;
      void saveNovelCoverFromSource(
        plugin,
        {
          id: result.novel.id,
          name: result.novel.name,
          path: result.novel.path,
          pluginId: result.novel.pluginId,
        },
        result.novel.cover,
      ).catch((error) => {
        console.warn("[novel] failed to store novel cover", {
          error,
          novelId: result.novel.id,
          pluginId: result.novel.pluginId,
        });
      });
    },
  });

  function invalidateNovelMetadataRefresh() {
    void queryClient.invalidateQueries({ queryKey: novelKey(id) });
    void queryClient.invalidateQueries({ queryKey: chaptersKey(id) });
    void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
  }

  function enqueueNovelMetadataRefresh(mode: NovelMetadataRefreshMode) {
    if (!novel || novel.isLocal) return Promise.resolve(null);
    const plugin = pluginManager.getPlugin(novel.pluginId);
    if (!plugin) {
      throw new Error(t("source.pluginNotLoaded"));
    }

    return enqueueSourceTask({
      plugin,
      kind: "source.refreshNovel",
      priority: "user",
      title: t(
        mode === "full"
          ? "tasks.task.refreshNovelMetadataFull"
          : "tasks.task.refreshNovelMetadata",
        { name: novel.name },
      ),
      subject: {
        novelId: novel.id,
        novelName: novel.name,
        path: novel.path,
      },
      dedupeKey:
        mode === "full"
          ? `source.refreshNovel:full:${novel.pluginId}:${novel.path}`
          : `source.refreshNovel:${novel.pluginId}:${novel.path}`,
      run: (context) =>
        syncNovelFromSource(
          pluginManager.getPluginForExecutor(
            novel.pluginId,
            context.executor ?? "immediate",
          ),
          {
            cover: novel.cover ?? undefined,
            name: novel.name,
            path: novel.path,
          },
          {
            chapterRefreshMode: mode,
            novelId: novel.id,
            preserveMissingMetadata: true,
          },
        ),
    }).promise;
  }

  const refreshMetadata = useMutation({
    mutationFn: () => enqueueNovelMetadataRefresh("since"),
    onSuccess: (result) => {
      if (result) setSourceDuplicateChapters(result.duplicateChapters);
      invalidateNovelMetadataRefresh();
    },
  });

  const fullRefreshMetadata = useMutation({
    mutationFn: () => enqueueNovelMetadataRefresh("full"),
    onSuccess: (result) => {
      if (result) setSourceDuplicateChapters(result.duplicateChapters);
      invalidateNovelMetadataRefresh();
    },
  });

  return {
    sourceDuplicateChapters,
    toggle,
    refreshMetadata,
    fullRefreshMetadata,
  };
}
