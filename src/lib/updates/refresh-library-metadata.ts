import {
  listLibraryNovelRefreshTargets,
  type LibraryNovelRefreshTarget,
} from "../../db/queries/novel";
import { pluginManager } from "../plugins/manager";
import { syncNovelFromSource } from "../plugins/sync-novel";
import { LOCAL_PLUGIN_ID } from "../plugins/types";
import { runBoundedTaskBatch } from "../tasks/batch-window";
import { enqueueSourceTask } from "../tasks/source-tasks";
import { taskScheduler, type TaskRunContext } from "../tasks/scheduler";
import { markUpdatesIndexDirty } from "./update-index-events";

export interface MetadataRefreshFailure {
  novelId: number;
  novelName: string;
  pluginId: string;
  reason: string;
}

export interface MetadataRefreshResult {
  checkedNovels: number;
  failures: MetadataRefreshFailure[];
  skippedNovels: number;
  targetNovels: number;
}

export interface RefreshLibraryMetadataOptions {
  aggregateTaskTitle?: string;
  categoryId?: number | null;
  onProgress?: (progress: {
    current: number;
    detail?: string;
    total: number;
  }) => void;
  taskTitle?: (novel: LibraryNovelRefreshTarget) => string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runLibraryMetadataRefresh(
  options: RefreshLibraryMetadataOptions = {},
  context?: TaskRunContext,
): Promise<MetadataRefreshResult> {
  const novels = await listLibraryNovelRefreshTargets({
    categoryId: options.categoryId,
  });
  const failures: MetadataRefreshFailure[] = [];
  let checkedNovels = 0;
  let changedNovels = 0;
  let processedNovels = 0;
  let skippedNovels = 0;

  const reportProgress = (detail?: string) => {
    options.onProgress?.({
      current: processedNovels,
      detail,
      total: novels.length,
    });
    context?.setProgress({
      current: processedNovels,
      total: novels.length,
    });
    if (detail) context?.setDetail(detail);
  };

  reportProgress();

  await runBoundedTaskBatch({
    items: novels,
    shouldContinue: () => !context?.signal.aborted,
    materialize: async (novel) => {
      if (novel.isLocal || novel.pluginId === LOCAL_PLUGIN_ID) {
        skippedNovels += 1;
        processedNovels += 1;
        reportProgress(novel.name);
        return;
      }

      const plugin = pluginManager.getPlugin(novel.pluginId);
      if (!plugin) {
        failures.push({
          novelId: novel.id,
          novelName: novel.name,
          pluginId: novel.pluginId,
          reason: `Plugin "${novel.pluginId}" is not installed.`,
        });
        processedNovels += 1;
        reportProgress(novel.name);
        return;
      }

      try {
        const handle = enqueueSourceTask({
          plugin,
          kind: "source.refreshNovel",
          priority: "deferred",
          title: options.taskTitle?.(novel) ?? novel.name,
          subject: {
            novelId: novel.id,
            novelName: novel.name,
            path: novel.path,
          },
          dedupeKey: `source.refreshNovel:${plugin.id}:${novel.path}`,
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
                chapterRefreshMode: "since",
                novelId: novel.id,
                notifyUpdatesIndex: false,
                preserveMissingMetadata: true,
              },
            ),
        });
        await handle.promise
          .then((result) => {
            if (result.changed) changedNovels += 1;
            checkedNovels += 1;
          })
          .catch((error) => {
            failures.push({
              novelId: novel.id,
              novelName: novel.name,
              pluginId: novel.pluginId,
              reason: describeError(error),
            });
          });
      } catch (error) {
        failures.push({
          novelId: novel.id,
          novelName: novel.name,
          pluginId: novel.pluginId,
          reason: describeError(error),
        });
      } finally {
        processedNovels += 1;
        reportProgress(novel.name);
      }
    },
  });

  if (changedNovels > 0) {
    markUpdatesIndexDirty("novel-sync");
  }

  return {
    checkedNovels,
    failures,
    skippedNovels,
    targetNovels: novels.length,
  };
}

export async function refreshLibraryMetadata(
  options: RefreshLibraryMetadataOptions = {},
): Promise<MetadataRefreshResult> {
  return taskScheduler.enqueueMain<MetadataRefreshResult>({
    kind: "library.refreshMetadata",
    priority: "deferred",
    title: options.aggregateTaskTitle ?? "Refresh library metadata",
    subject: { categoryId: options.categoryId },
    dedupeKey: `library.refreshMetadata:${options.categoryId ?? "all"}`,
    run: (context) => runLibraryMetadataRefresh(options, context),
  }).promise;
}
