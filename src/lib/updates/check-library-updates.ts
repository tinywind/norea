import { getDb } from "../../db/client";
import {
  listLibraryUpdatesPage,
  type LibraryUpdateEntry,
  type LibraryUpdatesCursor,
} from "../../db/queries/chapter";
import { pluginManager } from "../plugins/manager";
import { syncNovelFromSource } from "../plugins/sync-novel";
import { LOCAL_PLUGIN_ID } from "../plugins/types";
import { runBoundedTaskBatch } from "../tasks/batch-window";
import { enqueueSourceTask } from "../tasks/source-tasks";
import { taskScheduler, type TaskRunContext } from "../tasks/scheduler";

interface LibraryNovelForUpdate {
  id: number;
  pluginId: string;
  path: string;
  name: string;
}

export interface UpdateCheckFailure {
  novelId: number;
  novelName: string;
  pluginId: string;
  pluginName?: string;
  reason:
    | { kind: "plugin-missing"; pluginId: string }
    | { kind: "error"; message: string };
}

export interface UpdateCheckResult {
  checkedNovels: number;
  skippedNovels: number;
  failures: UpdateCheckFailure[];
  hasMoreUpdates: boolean;
  nextUpdateCursor: LibraryUpdatesCursor | null;
  updates: LibraryUpdateEntry[];
}

export interface UpdateCheckOptions {
  aggregateTaskTitle?: string;
  onProgress?: (progress: {
    current: number;
    detail?: string;
    total: number;
  }) => void;
  taskTitle?: (novel: LibraryNovelForUpdate) => string;
}

const SELECT_LIBRARY_NOVELS_FOR_UPDATE = `
  SELECT
    id,
    plugin_id AS pluginId,
    path,
    name
  FROM novel
  WHERE in_library = 1
  ORDER BY name COLLATE NOCASE ASC
`;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function listLibraryNovelsForUpdate(): Promise<
  LibraryNovelForUpdate[]
> {
  const db = await getDb();
  return db.select<LibraryNovelForUpdate[]>(
    SELECT_LIBRARY_NOVELS_FOR_UPDATE,
  );
}

async function runLibraryUpdateCheck(
  limit: number,
  options: UpdateCheckOptions = {},
  context?: TaskRunContext,
): Promise<UpdateCheckResult> {
  const novels = await listLibraryNovelsForUpdate();
  const failures: UpdateCheckFailure[] = [];
  let checkedNovels = 0;
  let processedNovels = 0;
  let skippedNovels = 0;

  const reportProgress = (detail?: string) => {
    const progress = { current: processedNovels, detail, total: novels.length };
    options.onProgress?.(progress);
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
      if (novel.pluginId === LOCAL_PLUGIN_ID) {
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
          reason: { kind: "plugin-missing", pluginId: novel.pluginId },
        });
        processedNovels += 1;
        reportProgress(novel.name);
        return;
      }

      try {
        const handle = enqueueSourceTask({
          plugin,
          kind: "source.checkLibraryUpdates",
          priority: "deferred",
          title: options.taskTitle?.(novel) ?? novel.name,
          subject: {
            novelId: novel.id,
            novelName: novel.name,
            path: novel.path,
          },
          dedupeKey: `source.checkLibraryUpdates:${plugin.id}:${novel.path}`,
          run: (context) =>
            syncNovelFromSource(
              pluginManager.getPluginForExecutor(
                novel.pluginId,
                context.executor ?? "immediate",
              ),
              { name: novel.name, path: novel.path },
              {
                chapterRefreshMode: "since",
                novelId: novel.id,
                notifyUpdatesIndex: false,
                preserveMissingMetadata: true,
              },
            ),
        });
        await handle.promise
          .then(() => {
            checkedNovels += 1;
          })
          .catch((error) => {
            failures.push({
              novelId: novel.id,
              novelName: novel.name,
              pluginId: novel.pluginId,
              pluginName: plugin.name,
              reason: { kind: "error", message: describeError(error) },
            });
          });
      } catch (error) {
        failures.push({
          novelId: novel.id,
          novelName: novel.name,
          pluginId: novel.pluginId,
          pluginName: plugin.name,
          reason: { kind: "error", message: describeError(error) },
        });
      } finally {
        processedNovels += 1;
        reportProgress(novel.name);
      }
    },
  });

  const updatesPage = await listLibraryUpdatesPage(limit);

  return {
    checkedNovels,
    skippedNovels,
    failures,
    hasMoreUpdates: updatesPage.hasMore,
    nextUpdateCursor: updatesPage.nextCursor,
    updates: updatesPage.updates,
  };
}

export async function checkLibraryUpdates(
  limit: number,
  options: UpdateCheckOptions = {},
): Promise<UpdateCheckResult> {
  return taskScheduler.enqueueMain<UpdateCheckResult>({
    kind: "library.checkUpdates",
    priority: "deferred",
    title: options.aggregateTaskTitle ?? "Check library updates",
    dedupeKey: "library.checkUpdates",
    run: (context) => runLibraryUpdateCheck(limit, options, context),
  }).promise;
}
