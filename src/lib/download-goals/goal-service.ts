import { listLibraryDownloadChapters, type LibraryDownloadChapter } from "../../db/queries/chapter";
import {
  clearDownloadGoalExclusions,
  excludeChaptersFromDownloadGoals,
  listDownloadGoalExcludedChapterIds,
  listDownloadGoalNovels,
  listGoalNovelIdsForDownloadScope,
  setNovelDownloadGoal,
  type DownloadGoalNovel,
  type NovelDownloadGoal,
} from "../../db/queries/novel-download-goal";
import { translate } from "../../i18n";
import { useAppearanceStore } from "../../store/appearance";
import { useDownloadGoalSettingsStore } from "../../store/download-goals";
import { useReaderStore } from "../../store/reader";
import { planServerLaneJobs } from "../content-sync/server-lane";
import { useNetworkStore } from "../network";
import { pluginManager } from "../plugins/manager";
import {
  cancelChapterDownloadTasks,
  discardQueuedChapterDownloads,
  getChapterDownloadStatus,
  isChapterDownloadQueued,
  subscribeChapterDownloads,
  waitForChapterDownloadQueueRestoration,
  type ChapterDownloadJob,
} from "../tasks/chapter-download";
import { cancelChapterDownloadRequest, submitChapterDownloadRequest } from "../tasks/chapter-download-requests";
import {
  getChapterDownloadFailureSnapshot,
  refreshChapterDownloadFailures,
  subscribeChapterDownloadFailures,
} from "../tasks/chapter-download-failures";
import { taskScheduler } from "../tasks/scheduler";
import { subscribeUpdatesIndexChanges } from "../updates/update-index-events";
import {
  automaticDownloadPause,
  clearDownloadGoalRestoreHold,
  isDownloadGoalRestoreHoldSet,
  readDownloadBudgetStatus,
  type DownloadGoalPause,
} from "./budget";
import { ACTIVE_NOVEL_WINDOW_SECONDS, goalReadingChapterId, resolveGoalTargets } from "./goal-targets";
import { recordChapterDownloadDuration } from "./download-eta";
import { migrateLegacyReadAhead } from "./legacy-read-ahead";

const RECONCILE_DELAY_MS = 500;
const PAUSED_RECHECK_MS = 60_000;

interface DownloadGoalPauseState {
  pause: DownloadGoalPause | null;
}

let started = false;
let pauseState: DownloadGoalPauseState = { pause: null };
let allowedOnce = false;
let pendingNovelIds: Set<number> | "all" | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let pausedRecheck: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> = Promise.resolve();
const pauseListeners = new Set<() => void>();
/** User cancellations of goal chapters waiting to be persisted as goal exclusions. */
const pendingExclusionIds = new Set<number>();
let exclusionWrite: Promise<void> = Promise.resolve();
/** Goal chapters this service is withdrawing itself; their cancellation is not the user's. */
const withdrawingChapterIds = new Set<number>();
/** Goal chapters this session queued, per novel, so stopping a goal can withdraw them. */
const submittedByNovel = new Map<number, Set<number>>();
/** Goal chapters whose request is still being prepared and not yet visible as queued work. */
const preparingChapterIds = new Set<number>();
const preparingRequestsByNovel = new Map<number, Set<string>>();
const unsubscribers: (() => void)[] = [];

function publishPause(pause: DownloadGoalPause | null): void {
  taskScheduler.setAutomaticWorkPaused(pause !== null);
  if (pauseState.pause === pause) return;
  pauseState = { pause };
  for (const listener of pauseListeners) listener();
}

export function getDownloadGoalPauseSnapshot(): DownloadGoalPauseState {
  return pauseState;
}

export function subscribeDownloadGoalPause(listener: () => void): () => void {
  pauseListeners.add(listener);
  return () => { pauseListeners.delete(listener); };
}

/** Schedules a reconcile for some novels, or for every goal novel when ids are omitted. */
export function reconcileDownloadGoals(novelIds?: readonly number[]): void {
  if (!started) return;
  if (!novelIds) pendingNovelIds = "all";
  else if (pendingNovelIds !== "all") {
    pendingNovelIds ??= new Set();
    for (const id of novelIds) pendingNovelIds.add(id);
  }
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    const ids = pendingNovelIds;
    pendingNovelIds = null;
    if (ids === null) return;
    running = running.then(() => runReconcile(ids === "all" ? undefined : [...ids])).catch((error: unknown) => {
      console.warn("[download-goals] could not reconcile download goals:", error);
    });
  }, RECONCILE_DELAY_MS);
}

/** Resolves when every reconcile scheduled so far has finished. */
export async function waitForDownloadGoalReconcile(): Promise<void> {
  while (timer !== null || pendingNovelIds !== null) {
    await new Promise((resolve) => setTimeout(resolve, RECONCILE_DELAY_MS));
  }
  await running;
}

async function currentPause(): Promise<DownloadGoalPause | null> {
  const settings = useDownloadGoalSettingsStore.getState();
  return automaticDownloadPause({
    heldAfterRestore: isDownloadGoalRestoreHoldSet(),
    status: await readDownloadBudgetStatus(),
    allowMobileData: settings.automaticOnMobileData,
    allowedOnce,
  });
}

function schedulePausedRecheck(): void {
  if (pausedRecheck !== null) return;
  pausedRecheck = setTimeout(() => {
    pausedRecheck = null;
    reconcileDownloadGoals();
  }, PAUSED_RECHECK_MS);
}

function goalFor(novel: DownloadGoalNovel): NovelDownloadGoal | null {
  if (novel.goal) return novel.goal;
  const count = useDownloadGoalSettingsStore.getState().defaultKeepAhead;
  return count > 0 ? { kind: "keep_ahead", count } : null;
}

function isOwned(chapter: LibraryDownloadChapter): boolean {
  return chapter.isDownloadQueued || preparingChapterIds.has(chapter.id) || isChapterDownloadQueued(chapter.id);
}

function activeSinceSeconds(): number | null {
  return useDownloadGoalSettingsStore.getState().defaultKeepAhead > 0
    ? Math.floor(Date.now() / 1000) - ACTIVE_NOVEL_WINDOW_SECONDS
    : null;
}

function persistExclusions(chapterIds: readonly number[]): Promise<void> {
  for (const id of chapterIds) pendingExclusionIds.add(id);
  exclusionWrite = exclusionWrite.then(async () => {
    const ids = [...pendingExclusionIds];
    pendingExclusionIds.clear();
    if (ids.length > 0) await excludeChaptersFromDownloadGoals(ids);
  }).catch((error: unknown) => console.warn("[download-goals] could not save goal exclusions:", error));
  return exclusionWrite;
}

async function runReconcile(novelIds: number[] | undefined): Promise<void> {
  await exclusionWrite;
  const pause = await currentPause();
  publishPause(pause);
  if (pause !== null) {
    if (pause !== "restore") schedulePausedRecheck();
    return;
  }
  const activeSince = activeSinceSeconds();
  const novels = await listDownloadGoalNovels(activeSince, novelIds);
  if (novels.length === 0) return;
  await pluginManager.loadInstalledFromDb();
  const failed = new Set(getChapterDownloadFailureSnapshot().map((row) => row.chapterId));
  // Candidates come most recently read first, so the first read one is the novel to keep ready first.
  const [latest] = novelIds ? await listDownloadGoalNovels(activeSince) : novels;
  const focusNovelId = latest?.lastReadAt != null ? latest.id : undefined;
  for (const novel of novels) {
    const goal = goalFor(novel);
    if (!goal) continue;
    const plugin = pluginManager.getPlugin(novel.pluginId);
    if (!plugin) continue;
    const chapters = await listLibraryDownloadChapters(novel.id);
    const excluded = new Set(await listDownloadGoalExcludedChapterIds(novel.id));
    const readingChapterId = goalReadingChapterId(chapters, useReaderStore.getState().lastReadChapterByNovel[novel.id]);
    const targets = resolveGoalTargets(goal, chapters, readingChapterId, isOwned,
      (chapter) => excluded.has(chapter.id) || failed.has(chapter.id));
    if (targets.pending.length > 0) submitGoalWork(novel, plugin.name, targets.pending, novel.id === focusNovelId);
  }
}

function submitGoalWork(
  novel: DownloadGoalNovel,
  pluginName: string,
  chapters: readonly LibraryDownloadChapter[],
  focus: boolean,
): void {
  const locale = useAppearanceStore.getState().appLocale;
  const jobs: ChapterDownloadJob[] = chapters.map((chapter) => ({
    id: chapter.id,
    pluginId: novel.pluginId,
    pluginName,
    chapterPath: chapter.path,
    chapterName: chapter.name,
    chapterNumber: chapter.chapterNumber ?? undefined,
    contentType: chapter.contentType,
    novelId: novel.id,
    novelName: novel.name,
    novelPath: novel.path,
    // The most recently read novel's goal work runs ahead of other goal work from the same source.
    priority: focus ? "deferred" : "background",
    goal: true,
    title: translate(locale, "tasks.task.downloadChapter", { name: chapter.name }),
  }));
  const submitted = submittedByNovel.get(novel.id) ?? new Set<number>();
  for (const job of jobs) { submitted.add(job.id); preparingChapterIds.add(job.id); }
  submittedByNovel.set(novel.id, submitted);
  const title = translate(locale, "downloadGoals.task.title", { name: novel.name });
  const handle = submitChapterDownloadRequest({
    key: JSON.stringify(["download-goal", novel.id, jobs.map((job) => job.id)]),
    title,
    novelIds: [novel.id],
    total: jobs.length,
    prepare: async (signal) => {
      // Chapters the content server holds take the server lane; the rest keep their source route.
      const planned = await planServerLaneJobs(novel, jobs, signal);
      return { jobs: planned, materializeAllTasks: true, title, total: planned.length };
    },
  });
  const requests = preparingRequestsByNovel.get(novel.id) ?? new Set<string>();
  requests.add(handle.id);
  preparingRequestsByNovel.set(novel.id, requests);
  const settle = () => {
    for (const job of jobs) preparingChapterIds.delete(job.id);
    requests.delete(handle.id);
  };
  void handle.materialized.then(settle, settle);
  void handle.promise.catch(() => undefined);
}

/**
 * Stores a novel's goal, withdraws goal work it no longer wants, and reconciles.
 * Null returns the novel to the default keep-ahead; `none` stops automatic downloads for it.
 */
export async function setDownloadGoal(novelId: number, goal: NovelDownloadGoal | null): Promise<void> {
  await setNovelDownloadGoal(novelId, goal);
  await withdrawGoalWork([novelId]);
  // A goal the user just chose covers chapters they cancelled or deleted before.
  await exclusionWrite;
  await clearDownloadGoalExclusions(novelId);
  reconcileDownloadGoals([novelId]);
}

/** The user stopped keeping these novels downloaded: no goal and no default keep-ahead; downloads are kept. */
export async function stopDownloadGoals(novelIds: readonly number[]): Promise<void> {
  for (const novelId of novelIds) await setNovelDownloadGoal(novelId, { kind: "none" });
  await withdrawGoalWork(novelIds);
}

/** Removing a novel from the library ends its goal; queued goal work is withdrawn, downloads are kept. */
export async function removeDownloadGoals(novelIds: readonly number[]): Promise<void> {
  for (const novelId of novelIds) await setNovelDownloadGoal(novelId, null);
  await withdrawGoalWork(novelIds);
}

/** Queued goal chapters for the novels, from this session's submissions and restored automatic tasks. */
function queuedGoalChapterIds(novelIds: readonly number[]): number[] {
  const wanted = new Set(novelIds);
  const ids = new Set<number>();
  for (const novelId of novelIds) for (const id of submittedByNovel.get(novelId) ?? []) ids.add(id);
  for (const record of taskScheduler.getSnapshot().records) {
    const chapterId = record.subject?.chapterId;
    if (record.kind === "chapter.download" && record.automatic && record.status === "queued" &&
        chapterId !== undefined && record.subject?.novelId !== undefined && wanted.has(record.subject.novelId)) {
      ids.add(chapterId);
    }
  }
  return [...ids].filter(isChapterDownloadQueued);
}

async function withdrawGoalWork(novelIds: readonly number[]): Promise<void> {
  for (const novelId of novelIds) {
    for (const requestId of preparingRequestsByNovel.get(novelId) ?? []) cancelChapterDownloadRequest(requestId);
    preparingRequestsByNovel.delete(novelId);
  }
  const ids = queuedGoalChapterIds(novelIds).filter((id) => getChapterDownloadStatus(id)?.kind !== "running");
  for (const novelId of novelIds) submittedByNovel.delete(novelId);
  if (ids.length === 0) return;
  for (const id of ids) withdrawingChapterIds.add(id);
  try {
    await discardQueuedChapterDownloads(ids);
    await cancelChapterDownloadTasks(ids);
  } finally {
    for (const id of ids) withdrawingChapterIds.delete(id);
  }
}

/**
 * Called after the user deleted these chapters' downloads. Deleted chapters stay out of goal work until the
 * novel's goal is set again; returns the novels with a goal in effect so the caller can offer to stop it.
 */
export async function noteDownloadDeletion(chapterIds: readonly number[]): Promise<number[]> {
  await persistExclusions(chapterIds);
  return listGoalNovelIdsForDownloadScope("chapter", chapterIds, activeSinceSeconds());
}

/** "Allow once": lifts the mobile-data and battery budgets until the app restarts. */
export function allowAutomaticDownloadsOnce(): void {
  allowedOnce = true;
  reconcileDownloadGoals();
}

/** Resumes goals that a device restore held. */
export function resumeDownloadGoalsAfterRestore(): void {
  clearDownloadGoalRestoreHold();
  reconcileDownloadGoals();
}

function lastReadChanges(next: Record<number, number>, previous: Record<number, number>): number[] {
  const ids: number[] = [];
  for (const key of Object.keys(next)) {
    const id = Number(key);
    if (next[id] !== previous[id]) ids.push(id);
  }
  return ids;
}

/** Starts goal reconciliation after the restored download queue has been reattached. */
export function startDownloadGoals(): void {
  if (started) return;
  started = true;
  unsubscribers.push(
    taskScheduler.subscribeEvents(recordChapterDownloadDuration),
    useReaderStore.subscribe((state, previous) => {
      if (state.lastReadChapterByNovel === previous.lastReadChapterByNovel) return;
      const changed = lastReadChanges(state.lastReadChapterByNovel, previous.lastReadChapterByNovel);
      if (changed.length) reconcileDownloadGoals(changed);
    }),
    useDownloadGoalSettingsStore.subscribe((state, previous) => {
      if (state.defaultKeepAhead !== previous.defaultKeepAhead ||
          state.automaticOnMobileData !== previous.automaticOnMobileData) reconcileDownloadGoals();
    }),
    useNetworkStore.subscribe((state, previous) => {
      if (state.revision !== previous.revision) reconcileDownloadGoals();
    }),
    subscribeUpdatesIndexChanges((event) => {
      if (event.reason === "read-progress" || event.reason === "novel-sync") reconcileDownloadGoals();
    }),
    subscribeChapterDownloadFailuresCleared(() => reconcileDownloadGoals()),
    subscribeChapterDownloads((event) => {
      if (event.job.goal && event.status.kind === "cancelled" && !withdrawingChapterIds.has(event.job.id) &&
          (typeof document === "undefined" || document.visibilityState === "visible")) {
        void persistExclusions([event.job.id]);
      }
    }),
  );
  void waitForChapterDownloadQueueRestoration()
    .then(() => refreshChapterDownloadFailures())
    .catch((error: unknown) => console.warn("[download-goals] could not read download failures:", error))
    .then(() => migrateLegacyReadAhead())
    .catch((error: unknown) => console.warn("[download-goals] could not carry over the read-ahead setting:", error))
    .then(() => reconcileDownloadGoals());
}

function subscribeChapterDownloadFailuresCleared(listener: () => void): () => void {
  let previous = new Set(getChapterDownloadFailureSnapshot().map((row) => row.chapterId));
  return subscribeChapterDownloadFailures(() => {
    const current = new Set(getChapterDownloadFailureSnapshot().map((row) => row.chapterId));
    const cleared = [...previous].some((id) => !current.has(id));
    previous = current;
    if (cleared) listener();
  });
}

/** Test hook: forget all module state. */
export function resetDownloadGoalsForTests(): void {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  if (timer !== null) clearTimeout(timer);
  if (pausedRecheck !== null) clearTimeout(pausedRecheck);
  timer = null; pausedRecheck = null; pendingNovelIds = null;
  started = false; allowedOnce = false; pauseState = { pause: null };
  running = Promise.resolve();
  pendingExclusionIds.clear(); exclusionWrite = Promise.resolve(); withdrawingChapterIds.clear();
  submittedByNovel.clear(); preparingChapterIds.clear(); preparingRequestsByNovel.clear();
}
