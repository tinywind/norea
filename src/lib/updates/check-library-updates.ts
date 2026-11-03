import { getDb } from "../../db/client";
import {
  listLibraryUpdatesPage,
  type LibraryUpdateEntry,
  type LibraryUpdatesCursor,
} from "../../db/queries/chapter";
import { listLibraryNovelRefreshTargets, type LibraryNovelRefreshFilter } from "../../db/queries/novel";
import { recordNovelCheck } from "../../db/queries/novel-freshness";
import { isAbortError } from "../abort";
import { pluginManager } from "../plugins/manager";
import { syncNovelFromSource, type SyncNovelFromSourceResult } from "../plugins/sync-novel";
import { describeError } from "../errors";
import { LOCAL_PLUGIN_ID, type Plugin } from "../plugins/types";
import { runBoundedTaskBatch } from "../tasks/batch-window";
import { enqueueSourceTask } from "../tasks/source-tasks";
import { taskScheduler, type TaskHandle, type TaskRunContext } from "../tasks/scheduler";

export interface NovelForCheck {
  id: number;
  pluginId: string;
  path: string;
  name: string;
}

const LIBRARY_UPDATE_CHECK_KEY = "library.checkUpdates";

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
  /** Chapters the check inserted into novels that already had chapters. */
  newChapters: number;
  skippedNovels: number;
  failures: UpdateCheckFailure[];
  hasMoreUpdates: boolean;
  nextUpdateCursor: LibraryUpdatesCursor | null;
  updates: LibraryUpdateEntry[];
}

export interface NewChapterCheckOptions {
  /** Novels to check; every library novel when omitted, unless `filter` narrows the library. */
  novelIds?: readonly number[];
  filter?: LibraryNovelRefreshFilter;
  /** Rows of the Updates list returned with the result. */
  limit: number;
  aggregateTaskTitle?: string;
  onProgress?: (progress: {
    current: number;
    detail?: string;
    total: number;
  }) => void;
  taskTitle?: (novel: NovelForCheck) => string;
}

/** Library novels, the ones being read first. */
const SELECT_LIBRARY_NOVELS_FOR_CHECK = `
  SELECT id, plugin_id AS pluginId, path, name
  FROM novel
  WHERE in_library = 1
  ORDER BY last_read_at IS NULL, last_read_at DESC, name COLLATE NOCASE ASC
`;

async function listNovelsForCheck(options: NewChapterCheckOptions): Promise<NovelForCheck[]> {
  if (options.filter) return listLibraryNovelRefreshTargets(options.filter);
  const db = await getDb();
  const novels = await db.select<NovelForCheck[]>(SELECT_LIBRARY_NOVELS_FOR_CHECK);
  if (!options.novelIds) return novels;
  const wanted = new Set(options.novelIds);
  return novels.filter((novel) => wanted.has(novel.id));
}

/** One novel's check, shared by every entry point so a novel is never fetched twice at once. */
export function newChapterCheckDedupeKey(pluginId: string, path: string): string {
  return `source.checkLibraryUpdates:${pluginId}:${path}`;
}

/**
 * Checks one novel for new chapters: metadata plus chapters since the latest one, falling back
 * to the full list when the anchor is missing or inconsistent. Chapters it inserts into a novel
 * that already had chapters show in Updates, and the outcome is recorded for the check cadence.
 */
export function checkNovelForNewChapters(
  plugin: Pick<Plugin, "getBaseUrl" | "id" | "name">,
  novel: NovelForCheck,
  options: { priority?: "deferred" | "user"; title: string },
): TaskHandle<SyncNovelFromSourceResult> {
  return enqueueSourceTask({
    plugin,
    kind: "source.checkLibraryUpdates",
    priority: options.priority ?? "deferred",
    title: options.title,
    subject: { novelId: novel.id, novelName: novel.name, path: novel.path },
    dedupeKey: newChapterCheckDedupeKey(plugin.id, novel.path),
    run: async (context) => {
      try {
        const result = await syncNovelFromSource(
          pluginManager.getPluginForExecutor(novel.pluginId, context.executor ?? "immediate"),
          { name: novel.name, path: novel.path },
          {
            chapterRefreshMode: "since",
            markFoundByCheck: true,
            novelId: novel.id,
            preserveMissingMetadata: true,
            signal: context.signal,
          },
        );
        await recordNovelCheck(novel.id, { ok: true, newChapters: result.newChapters });
        return result;
      } catch (error) {
        if (!isAbortError(error) && !context.signal.aborted) {
          await recordNovelCheck(novel.id, { ok: false }).catch(() => undefined);
        }
        throw error;
      }
    },
  });
}

async function runNewChapterCheck(
  options: NewChapterCheckOptions,
  context?: TaskRunContext,
): Promise<UpdateCheckResult> {
  const novels = await listNovelsForCheck(options);
  const failures: UpdateCheckFailure[] = [];
  let checkedNovels = 0;
  let newChapters = 0;
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
        const result = await checkNovelForNewChapters(plugin, novel, {
          title: options.taskTitle?.(novel) ?? novel.name,
        }).promise;
        checkedNovels += 1;
        newChapters += result.newChapters;
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

  const updatesPage = await listLibraryUpdatesPage(options.limit);

  return {
    checkedNovels,
    newChapters,
    skippedNovels,
    failures,
    hasMoreUpdates: updatesPage.hasMore,
    nextUpdateCursor: updatesPage.nextCursor,
    updates: updatesPage.updates,
  };
}

/**
 * "Check for new chapters" for the library, a filtered part of it, or chosen novels such as the
 * ones that failed last time. Sources run in parallel and each source stays serial.
 */
export async function checkForNewChapters(options: NewChapterCheckOptions): Promise<UpdateCheckResult> {
  const scope = options.novelIds ? { novelIds: [...options.novelIds].sort((left, right) => left - right) }
    : options.filter ? { filter: options.filter } : null;
  return taskScheduler.enqueueMain<UpdateCheckResult>({
    kind: "library.checkUpdates",
    priority: "deferred",
    title: options.aggregateTaskTitle ?? "Check for new chapters",
    dedupeKey: scope ? `${LIBRARY_UPDATE_CHECK_KEY}:${JSON.stringify(scope)}` : LIBRARY_UPDATE_CHECK_KEY,
    run: (context) => runNewChapterCheck(options, context),
  }).promise;
}

/**
 * Cancels running checks for new chapters. Novels already handed to their
 * source finish their check; the remaining novels are not started.
 */
export function cancelLibraryUpdateCheck(): boolean {
  let cancelled = false;
  for (const record of taskScheduler.getSnapshot().records) {
    if (record.kind === "library.checkUpdates" && (record.status === "queued" || record.status === "running")) {
      cancelled = taskScheduler.cancel(record.id) || cancelled;
    }
  }
  return cancelled;
}
