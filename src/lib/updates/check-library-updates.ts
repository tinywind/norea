import { getDb } from "../../db/client";
import {
  listLibraryUpdatesPage,
  type LibraryUpdateEntry,
  type LibraryUpdatesCursor,
} from "../../db/queries/chapter";
import { listLibraryNovelRefreshTargets, type LibraryNovelRefreshFilter } from "../../db/queries/novel";
import { countRecentChecksBySource, recordNovelCheck } from "../../db/queries/novel-freshness";
import { isAbortError } from "../abort";
import { pluginManager } from "../plugins/manager";
import { syncNovelFromSource, type SyncNovelFromSourceResult } from "../plugins/sync-novel";
import { describeError } from "../errors";
import { LOCAL_PLUGIN_ID, type Plugin } from "../plugins/types";
import { runBoundedTaskBatch } from "../tasks/batch-window";
import { enqueueSourceTask } from "../tasks/source-tasks";
import { taskScheduler, type TaskHandle, type TaskRunContext } from "../tasks/scheduler";
import { SOURCE_CHECKS_PER_HOUR } from "./check-cadence";

export interface NovelForCheck {
  id: number;
  pluginId: string;
  path: string;
  name: string;
}

const LIBRARY_UPDATE_CHECK_KEY = "library.checkUpdates";
const HOUR_SECONDS = 60 * 60;
/** An automatic run stops checking a source after this many failed or slow checks in a row. */
const SOURCE_BACKOFF_STRIKES = 3;
/** A check that runs longer than this counts as the source slowing down. */
const SLOW_CHECK_MS = 30_000;

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
  /** Novels left for later because their source used its hourly check budget. */
  deferredNovels: number;
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
  /** A cadence run: a manual check started meanwhile joins it instead of waiting behind it. */
  automatic?: boolean;
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

type CheckProgress = Parameters<NonNullable<NewChapterCheckOptions["onProgress"]>>[0];

/** One running library check; a manual check started during an automatic one joins it. */
interface CheckRun {
  automatic: boolean;
  /** Novels not handed to their source yet, in check order. */
  pending: NovelForCheck[];
  /** Every novel this run covers, by id. */
  covered: Map<number, NovelForCheck>;
  /** Handed to their source and not settled yet. */
  inFlight: Set<number>;
  /** Novels a user asked for, checked at user priority. */
  userRequested: Set<number>;
  /** Novels left for later: their source used its hourly budget, or kept failing or slowing down. */
  deferredNovels: number;
  /** Failed or slow checks in a row per source, in an automatic run. */
  strikes: Map<string, number>;
  /** Source check task per novel handed to its source. */
  taskIds: Map<number, string>;
  onProgress: Set<(progress: CheckProgress) => void>;
  taskTitle: (novel: NovelForCheck) => string;
  /** Settles once the run has listed its own novels. */
  listed: Promise<void>;
  promise: Promise<UpdateCheckResult> | null;
}

let activeRun: CheckRun | null = null;

/**
 * The novels a manual check may add, within each source's hourly budget: checks recorded in the
 * last hour plus the ones the running check has not recorded yet.
 */
async function withinSourceBudget(
  novels: readonly NovelForCheck[],
  unrecorded: Iterable<NovelForCheck>,
): Promise<NovelForCheck[]> {
  const used = await countRecentChecksBySource(Math.floor(Date.now() / 1000) - HOUR_SECONDS);
  for (const novel of unrecorded) used.set(novel.pluginId, (used.get(novel.pluginId) ?? 0) + 1);
  return novels.filter((novel) => {
    if (novel.pluginId === LOCAL_PLUGIN_ID) return true;
    const count = used.get(novel.pluginId) ?? 0;
    if (count >= SOURCE_CHECKS_PER_HOUR) return false;
    used.set(novel.pluginId, count + 1);
    return true;
  });
}

function unrecordedNovels(run: CheckRun): NovelForCheck[] {
  return [...run.pending, ...[...run.inFlight].map((id) => run.covered.get(id)!)];
}

/**
 * Adds a manual check to a running automatic one: novels it already checked are not checked
 * again, its remaining requested novels move to the front at user priority, and novels outside
 * it are added within their source's hourly budget.
 */
async function joinRun(run: CheckRun, options: NewChapterCheckOptions): Promise<boolean> {
  await run.listed;
  const requested = await listNovelsForCheck(options);
  const outside = requested.filter((novel) => !run.covered.has(novel.id));
  const budgeted = await withinSourceBudget(outside, unrecordedNovels(run));
  if (activeRun !== run) return false;
  run.deferredNovels += outside.length - budgeted.length;
  const fresh = budgeted.filter((novel) => !run.covered.has(novel.id));
  const requestedIds = new Set(requested.map((novel) => novel.id));
  const promoted = run.pending.filter((novel) => requestedIds.has(novel.id));
  run.pending = [...promoted, ...fresh, ...run.pending.filter((novel) => !requestedIds.has(novel.id))];
  for (const novel of [...promoted, ...fresh]) {
    run.covered.set(novel.id, novel);
    run.userRequested.add(novel.id);
  }
  for (const id of run.inFlight) {
    const novel = run.covered.get(id)!;
    const plugin = requestedIds.has(id) ? pluginManager.getPlugin(novel.pluginId) : undefined;
    const queued = taskScheduler.getTaskByDedupeKey(newChapterCheckDedupeKey(novel.pluginId, novel.path))?.status === "queued";
    // Enqueueing the same check again at user priority moves its queued source task forward.
    if (plugin && queued) {
      checkNovelForNewChapters(plugin, novel, { priority: "user", title: run.taskTitle(novel) }).promise.catch(() => undefined);
    }
  }
  if (options.onProgress) run.onProgress.add(options.onProgress);
  return true;
}

async function runNewChapterCheck(
  options: NewChapterCheckOptions,
  context?: TaskRunContext,
): Promise<UpdateCheckResult> {
  let finishListing!: () => void;
  const run: CheckRun = {
    automatic: options.automatic ?? false,
    pending: [],
    covered: new Map(),
    inFlight: new Set(),
    userRequested: new Set(),
    deferredNovels: 0,
    strikes: new Map(),
    taskIds: new Map(),
    onProgress: new Set(options.onProgress ? [options.onProgress] : []),
    taskTitle: (novel) => options.taskTitle?.(novel) ?? novel.name,
    listed: new Promise((resolve) => { finishListing = resolve; }),
    promise: null,
  };
  // Registered before the first await, so a check started while this one lists its novels joins it.
  activeRun = run;
  try {
    const listed = await listNovelsForCheck(options);
    const novels = run.automatic ? listed : await withinSourceBudget(listed, []);
    run.pending = [...novels];
    for (const novel of novels) {
      run.covered.set(novel.id, novel);
      if (!run.automatic) run.userRequested.add(novel.id);
    }
    run.deferredNovels = listed.length - novels.length;
  } catch (error) {
    if (activeRun === run) activeRun = null;
    throw error;
  } finally {
    finishListing();
  }
  const failures: UpdateCheckFailure[] = [];
  let checkedNovels = 0;
  let newChapters = 0;
  let processedNovels = 0;
  let skippedNovels = 0;

  const reportProgress = (detail?: string) => {
    const progress = { current: processedNovels, detail, total: run.covered.size };
    for (const listener of run.onProgress) listener(progress);
    context?.setProgress({
      current: processedNovels,
      total: run.covered.size,
    });
    if (detail) context?.setDetail(detail);
  };

  const backedOff = (novel: NovelForCheck) =>
    run.automatic && !run.userRequested.has(novel.id) && (run.strikes.get(novel.pluginId) ?? 0) >= SOURCE_BACKOFF_STRIKES;

  /**
   * Spec F2 backoff: after 3 failed or slow checks of a source in a row, an automatic run leaves
   * that source's remaining novels for a later run, cancelling the ones still queued.
   */
  const recordSourceOutcome = (novel: NovelForCheck, taskId: string, ok: boolean) => {
    const task = taskScheduler.getTask(taskId);
    const slow = task?.startedAt !== undefined && task.finishedAt !== undefined && task.finishedAt - task.startedAt > SLOW_CHECK_MS;
    const strikes = ok && !slow ? 0 : (run.strikes.get(novel.pluginId) ?? 0) + 1;
    run.strikes.set(novel.pluginId, strikes);
    if (strikes !== SOURCE_BACKOFF_STRIKES || !run.automatic) return;
    for (const id of run.inFlight) {
      const queued = run.covered.get(id)!;
      const queuedTaskId = run.taskIds.get(id);
      if (queued.pluginId !== novel.pluginId || run.userRequested.has(id) || !queuedTaskId) continue;
      if (taskScheduler.getTask(queuedTaskId)?.status === "queued") taskScheduler.cancel(queuedTaskId);
    }
  };

  const checkNovel = async (novel: NovelForCheck) => {
    if (backedOff(novel)) {
      run.deferredNovels += 1;
      processedNovels += 1;
      reportProgress(novel.name);
      return;
    }
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

    run.inFlight.add(novel.id);
    const handle = checkNovelForNewChapters(plugin, novel, {
      priority: run.userRequested.has(novel.id) ? "user" : "deferred",
      title: run.taskTitle(novel),
    });
    run.taskIds.set(novel.id, handle.id);
    try {
      const result = await handle.promise;
      checkedNovels += 1;
      newChapters += result.newChapters;
      recordSourceOutcome(novel, handle.id, true);
    } catch (error) {
      if (isAbortError(error) && backedOff(novel) && !context?.signal.aborted) {
        run.deferredNovels += 1;
        return;
      }
      if (!isAbortError(error)) recordSourceOutcome(novel, handle.id, false);
      failures.push({
        novelId: novel.id,
        novelName: novel.name,
        pluginId: novel.pluginId,
        pluginName: plugin.name,
        reason: { kind: "error", message: describeError(error) },
      });
    } finally {
      run.inFlight.delete(novel.id);
      run.taskIds.delete(novel.id);
      processedNovels += 1;
      reportProgress(novel.name);
    }
  };

  // Novels a joining check adds while a batch runs are taken by that batch, or by the next one.
  function* takePending(): Generator<NovelForCheck> {
    while (run.pending.length > 0) yield run.pending.shift()!;
  }

  try {
    reportProgress();
    while (run.pending.length > 0 && !context?.signal.aborted) {
      await runBoundedTaskBatch({
        items: takePending(),
        shouldContinue: () => !context?.signal.aborted,
        materialize: checkNovel,
      });
    }
  } finally {
    if (activeRun === run) activeRun = null;
  }

  const updatesPage = await listLibraryUpdatesPage(options.limit);

  return {
    checkedNovels,
    deferredNovels: run.deferredNovels,
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
 * ones that failed last time. Sources run in parallel and each source stays serial. A manual
 * check ignores the cadence but not each source's hourly budget; started during an automatic
 * check, it joins that check instead of waiting behind it.
 */
export async function checkForNewChapters(options: NewChapterCheckOptions): Promise<UpdateCheckResult> {
  const running = activeRun;
  if (!options.automatic && running?.automatic && running.promise && await joinRun(running, options)) {
    const result = await running.promise!;
    const updatesPage = await listLibraryUpdatesPage(options.limit);
    return {
      ...result,
      hasMoreUpdates: updatesPage.hasMore,
      nextUpdateCursor: updatesPage.nextCursor,
      updates: updatesPage.updates,
    };
  }
  const scope = options.novelIds ? { novelIds: [...options.novelIds].sort((left, right) => left - right) }
    : options.filter ? { filter: options.filter } : null;
  const handle = taskScheduler.enqueueMain<UpdateCheckResult>({
    kind: "library.checkUpdates",
    priority: "deferred",
    title: options.aggregateTaskTitle ?? "Check for new chapters",
    dedupeKey: scope ? `${LIBRARY_UPDATE_CHECK_KEY}:${JSON.stringify(scope)}` : LIBRARY_UPDATE_CHECK_KEY,
    run: (context) => {
      const promise = runNewChapterCheck(options, context);
      if (activeRun) activeRun.promise = promise;
      return promise;
    },
  });
  return handle.promise;
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
