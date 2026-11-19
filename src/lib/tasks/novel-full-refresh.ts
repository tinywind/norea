import { getNovelById, type NovelDetailRecord } from "../../db/queries/novel";
import { isAbortError } from "../abort";
import { readServerNovelSource } from "../content-sync/novel-source";
import { pluginManager } from "../plugins/manager";
import { syncNovelFromSource } from "../plugins/sync-novel";
import type { Plugin } from "../plugins/types";
import { isTauriRuntime } from "../tauri-runtime";
import { runBoundedTaskBatch } from "./batch-window";
import { taskScheduler, type TaskHandle } from "./scheduler";
import { enqueueSourceTask } from "./source-tasks";

const LIBRARY_REFRESH_NOVELS_KEY = "library.refreshNovels";

export function enqueueFullNovelRefresh(
  plugin: Plugin,
  novel: Pick<NovelDetailRecord, "id" | "pluginId" | "name" | "path" | "cover">,
  title: string,
  options: { priority?: "user" | "deferred" } = {},
) {
  return enqueueSourceTask({
    plugin,
    kind: "source.refreshNovel",
    priority: options.priority ?? "user",
    title,
    subject: { novelId: novel.id, novelName: novel.name, path: novel.path },
    dedupeKey: `source.refreshNovel:full:${novel.pluginId}:${novel.path}`,
    run: (context) => syncNovelFromSource(
      pluginManager.getPluginForExecutor(novel.pluginId, context.executor ?? "immediate"),
      { cover: novel.cover ?? undefined, name: novel.name, path: novel.path },
      { chapterRefreshMode: "full", novelId: novel.id, preserveMissingMetadata: true, refreshCover: true, signal: context.signal },
    ),
  });
}

/**
 * Enqueues a content-server-only metadata or chapter-check refresh on the server lane
 * so works without an installed source plugin still appear and cancel in the queue.
 */
export function enqueueServerNovelRefreshTask(
  novel: Pick<NovelDetailRecord, "id" | "pluginId" | "name" | "path"> & { pluginName?: string | null },
  options: {
    kind: "source.checkLibraryUpdates" | "source.refreshNovel";
    priority?: "user" | "deferred";
    title: string;
    run: (signal: AbortSignal) => Promise<boolean>;
  },
): TaskHandle<boolean> {
  const sourceName = novel.pluginName?.trim() || novel.pluginId;
  return taskScheduler.enqueueSource<boolean>({
    kind: options.kind,
    priority: options.priority ?? "user",
    title: options.title,
    source: { id: novel.pluginId, name: sourceName },
    subject: { novelId: novel.id, novelName: novel.name, path: novel.path, pluginId: novel.pluginId },
    dedupeKey: `${options.kind}:server:${novel.id}`,
    serverLane: true,
    canCompleteWithoutSourceAccess: true,
    run: ({ signal }) => options.run(signal),
  });
}

export interface RefreshSelectedNovelsOptions {
  novelIds: readonly number[];
  aggregateTaskTitle: string;
  pluginNotLoadedMessage: string;
  taskTitle: (novel: Pick<NovelDetailRecord, "id" | "name">) => string;
  onNovelSettled?: (novelId: number) => void;
}

export interface RefreshSelectedNovelsResult {
  refreshed: number;
  skippedLocal: number;
  failedIds: number[];
}

/**
 * Refreshes full metadata for selected library novels under one aggregate main task,
 * fanning out per-novel tasks across sources in bounded batches so the queue shows
 * progress, active items, and cancellation.
 */
export function refreshSelectedNovelsMetadata(
  options: RefreshSelectedNovelsOptions,
): TaskHandle<RefreshSelectedNovelsResult> {
  const uniqueIds = [...new Set(options.novelIds)];
  const dedupeIds = [...uniqueIds].sort((left, right) => left - right);
  return taskScheduler.enqueueMain<RefreshSelectedNovelsResult>({
    kind: "library.refreshNovels",
    priority: "deferred",
    title: options.aggregateTaskTitle,
    dedupeKey: `${LIBRARY_REFRESH_NOVELS_KEY}:${JSON.stringify(dedupeIds)}`,
    run: async (context) => {
      if (isTauriRuntime()) await pluginManager.loadInstalledFromDb();
      let refreshed = 0;
      let skippedLocal = 0;
      let processed = 0;
      const failedIds: number[] = [];
      const total = uniqueIds.length;
      const reportProgress = (detail?: string) => {
        context.setProgress({ current: processed, total });
        if (detail) context.setDetail(detail);
      };
      reportProgress();

      const refreshNovel = async (novelId: number) => {
        if (context.signal.aborted) return;
        let novelName: string | undefined;
        try {
          const novel = await getNovelById(novelId);
          if (!novel) return;
          novelName = novel.name;
          if (novel.isLocal) {
            skippedLocal += 1;
            return;
          }
          const title = options.taskTitle(novel);
          if (await readServerNovelSource(novelId)) {
            const { refreshServerNovelFromSource, syncServerNovelOnOpen } = await import("../content-sync/work-refresh");
            const sourceRefreshed = await refreshServerNovelFromSource(
              novelId,
              title,
              context.signal,
              { priority: "deferred", refreshCover: true },
            );
            if (!sourceRefreshed && !context.signal.aborted) {
              const serverTask = enqueueServerNovelRefreshTask(novel, {
                kind: "source.refreshNovel",
                priority: "deferred",
                title,
                run: (signal) => syncServerNovelOnOpen(novelId, signal),
              });
              const abortServerTask = () => { taskScheduler.cancel(serverTask.id); };
              context.signal.addEventListener("abort", abortServerTask, { once: true });
              try { await serverTask.promise; }
              finally { context.signal.removeEventListener("abort", abortServerTask); }
            }
          } else {
            if (context.signal.aborted) return;
            const plugin = pluginManager.getPlugin(novel.pluginId);
            if (!plugin) throw new Error(options.pluginNotLoadedMessage);
            const task = enqueueFullNovelRefresh(plugin, novel, title, { priority: "deferred" });
            const abortTask = () => { taskScheduler.cancel(task.id); };
            context.signal.addEventListener("abort", abortTask, { once: true });
            try { await task.promise; }
            finally { context.signal.removeEventListener("abort", abortTask); }
          }
          refreshed += 1;
        } catch (error) {
          if (context.signal.aborted && isAbortError(error)) return;
          failedIds.push(novelId);
        } finally {
          options.onNovelSettled?.(novelId);
          processed += 1;
          reportProgress(novelName);
        }
      };

      await runBoundedTaskBatch({
        items: uniqueIds,
        shouldContinue: () => !context.signal.aborted,
        materialize: refreshNovel,
      });

      return { refreshed, skippedLocal, failedIds };
    },
  });
}
