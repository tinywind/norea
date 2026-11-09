import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  setNovelInLibrary,
  type NovelDetailRecord,
} from "../../db/queries/novel";
import { confirmContentDeletion } from "../../store/content-deletion";
import { useTranslation } from "../../i18n";
import { readServerNovelSource } from "../../lib/content-sync/novel-source";
import { saveNovelCoverFromSource } from "../../lib/novel-cover-storage";
import { pluginManager } from "../../lib/plugins/manager";
import {
  getSourceDuplicateChapterInfo,
  type SourceDuplicateChapterInfo,
} from "../../lib/plugins/sync-novel";
import { enqueueFullNovelRefresh } from "../../lib/tasks/novel-full-refresh";
import { checkNovelForNewChapters } from "../../lib/updates/check-library-updates";
import { markUpdatesIndexDirty } from "../../lib/updates/update-index-events";
import {
  chaptersKey,
  novelKey,
  type NovelMetadataRefreshMode,
} from "./novel-detail-model";

type NovelMetadataSource = Pick<
  NovelDetailRecord,
  "id" | "name" | "path" | "pluginId" | "sourceNovelId" | "cover" | "isLocal" | "inLibrary"
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
    /** Removing asks first; `unshelve` sizes the confirmation's optional deletions. */
    mutationFn: async (unshelve?: { downloadedCount: number; serverWork: boolean }) => {
      if (!novel) return;
      if (novel.inLibrary) {
        await confirmContentDeletion({ kind: "library", ids: [novel.id], title: novel.name, ...unshelve });
        return;
      }
      const inLibrary = true;
      const serverSource = inLibrary ? await readServerNovelSource(novel.id) : null;
      await setNovelInLibrary(novel.id, inLibrary);
      return { inLibrary, novel, serverSource };
    },
    meta: { errorPresentation: "toast" },
    // Adding shows as added at once and rolls back if the write fails; removing waits for its confirmation.
    onMutate: async () => {
      if (!novel || novel.inLibrary) return undefined;
      const queryKey = novelKey(novel.id);
      await queryClient.cancelQueries({ exact: true, queryKey });
      const previous = queryClient.getQueryData<NovelDetailRecord | null>(queryKey);
      queryClient.setQueryData<NovelDetailRecord | null>(queryKey, (current) =>
        current ? { ...current, inLibrary: true } : current,
      );
      return { previous, queryKey };
    },
    onError: (_error, _unshelve, context) => {
      if (context) queryClient.setQueryData(context.queryKey, context.previous);
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

      if (!result.inLibrary || result.serverSource || result.novel.isLocal || !result.novel.cover) {
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
          sourceNovelId: result.novel.sourceNovelId,
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
    void queryClient.invalidateQueries({ queryKey: ["content-server", "novel-chapters"] });
  }

  async function enqueueNovelMetadataRefresh(mode: NovelMetadataRefreshMode) {
    if (!novel) return null;
    const serverSource = await readServerNovelSource(novel.id);
    if (serverSource) {
      const { syncServerNovelOnOpen, refreshServerNovelFromSource } = await import("../../lib/content-sync/work-refresh");
      let sourceRefreshed = false;
      const serverRefresh = syncServerNovelOnOpen(novel.id, undefined, () => !sourceRefreshed).then(changed => {
        if (changed) invalidateNovelMetadataRefresh();
        return null;
      }, error => ({ error }));
      try {
        if (mode === "since") {
          const plugin = novel.isLocal || novel.path.startsWith("norea-folder:")
            ? undefined : pluginManager.getPlugin(novel.pluginId);
          if (plugin) {
            await checkNovelForNewChapters(plugin, novel, {
              priority: "user", title: t("tasks.task.checkUpdates", { name: novel.name }),
            }).promise;
            sourceRefreshed = true;
          }
        } else {
          sourceRefreshed = await refreshServerNovelFromSource(novel.id,
            t("tasks.task.refreshNovelMetadataFull", { name: novel.name }), undefined, { priority: "user", refreshCover: true });
        }
      }
      finally { invalidateNovelMetadataRefresh(); }
      if (!sourceRefreshed) {
        const failure = await serverRefresh;
        if (failure) throw failure.error;
      }
      return { duplicateChapters: getSourceDuplicateChapterInfo(novel.id) };
    }
    if (novel.isLocal) return null;
    const plugin = pluginManager.getPlugin(novel.pluginId);
    if (!plugin) {
      throw new Error(t("source.pluginNotLoaded"));
    }
    if (mode === "since") {
      return checkNovelForNewChapters(plugin, novel, {
        priority: "user", title: t("tasks.task.checkUpdates", { name: novel.name }),
      }).promise;
    }

    return enqueueFullNovelRefresh(plugin, novel, t("tasks.task.refreshNovelMetadataFull", { name: novel.name })).promise;
  }

  const refreshMetadata = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: () => enqueueNovelMetadataRefresh("since"),
    onSuccess: (result) => {
      if (result) setSourceDuplicateChapters(result.duplicateChapters);
      invalidateNovelMetadataRefresh();
    },
  });

  const fullRefreshMetadata = useMutation({
    meta: { errorPresentation: "inline" },
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
