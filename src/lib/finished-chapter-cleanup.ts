import { create } from "zustand";
import { persist } from "zustand/middleware";
import { listChapterCleanupCandidates, type ChapterCleanupCandidate } from "../db/queries/chapter-cleanup";
import { subscribeUserStateApplied } from "../db/user-state-core";
import { translate } from "../i18n";
import { useAppearanceStore } from "../store/appearance";
import { useContentSyncStore } from "../store/content-sync";
import { useDownloadGoalSettingsStore } from "../store/download-goals";
import { isApplyingSharedReaderResume, useReaderStore } from "../store/reader";
import { isAppActive, subscribeAppLifecycle } from "./app-lifecycle";
import type { ChapterCleanupFilters } from "./chapter-cleanup";
import { subscribeContentSyncUploadSettled } from "./content-sync/sync";
import { listGoalProtectedChapterIds } from "./download-goals/goal-protection";
import { getActiveReaderChapterIds, subscribeActiveReaderChapters } from "./reader-active-chapters";
import type { QueryInvalidator } from "./reader-query-invalidation";
import { enqueueFinishedChapterCleanup, isChapterCleanupActive } from "./tasks/chapter-cleanup";
import { subscribeUpdatesIndexChanges } from "./updates/update-index-events";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Reading progress settles for this long before a run, preserving the Undo toast window. */
const AFTER_PROGRESS_DELAY_MS = 60_000;
/** A launch, settings change, or upload settle waits this long to avoid competing with foreground work. */
const AFTER_START_DELAY_MS = 30_000;
const DUE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

const TRANSIENT_OR_DEFERRED_SKIP_REASONS = new Set<string>([
  "no-server",
  "server-missing",
  "server-conflict",
  "server-auth",
  "server-unavailable",
  "server-timeout",
  "server-error",
  "not-complete",
  "pending-upload",
  "storage-error",
  "changed",
  "active-reader",
]);

export interface FinishedChapterCleanupRun {
  /** Unix milliseconds when the run finished. */
  at: number;
  deleted: number;
  bytesFreed: number;
}

interface FinishedChapterCleanupState {
  /** Unix milliseconds of the last completed run without transient/deferred skips. */
  lastRunAt: number | null;
  /** The last run that removed chapters. */
  lastRemoval: FinishedChapterCleanupRun | null;
}

/** Device-only run history; it is runtime state, not a setting, so backups leave it out. */
export const useFinishedChapterCleanupStore = create<FinishedChapterCleanupState>()(persist(
  (): FinishedChapterCleanupState => ({ lastRunAt: null, lastRemoval: null }),
  { name: "finished-chapter-cleanup-state" },
));

/** The cleanup conditions an automatic run uses, or null while removal is off or not yet allowed. */
export function finishedChapterCleanupFilters(): ChapterCleanupFilters | null {
  const { finishedChapterKeep, finishedCleanupWithoutServer } = useDownloadGoalSettingsStore.getState();
  if (finishedChapterKeep === "off") return null;
  const hasServer = Boolean(useContentSyncStore.getState().serverUrl);
  // Only a verified complete server copy justifies unattended deletion; without a server the user must accept that.
  if (!hasServer && !finishedCleanupWithoutServer) return null;
  return {
    reading: "read",
    categories: { mode: "all" },
    server: hasServer ? "server-complete" : "any",
    finished: {
      keepLast: finishedChapterKeep,
      requireInstalledPlugin: !hasServer,
    },
  };
}

/** Whether a daily run is due: never ran, or 24 hours passed since the last run. */
export function isFinishedChapterCleanupDue(now: number, lastRunAt: number | null): boolean {
  return lastRunAt === null || now - lastRunAt >= DAY_MS;
}

let running: Promise<void> | null = null;
let activeQueryClient: QueryInvalidator | null = null;

/**
 * Removes downloaded chapters that are finished beyond the configured `finishedChapterKeep` count.
 * Skipped while another cleanup runs. Does not add permanent download goal exclusions.
 */
export function runFinishedChapterCleanup(): Promise<void> {
  running ??= runOnce().finally(() => { running = null; });
  return running;
}

async function collectFinishedCandidates(
  filters: ChapterCleanupFilters,
): Promise<ChapterCleanupCandidate[]> {
  const candidates: ChapterCleanupCandidate[] = [];
  let afterId = 0;
  for (;;) {
    const page = await listChapterCleanupCandidates(filters, { afterId });
    if (page.length === 0) break;
    candidates.push(...page);
    afterId = page[page.length - 1]!.identity.chapter.id;
  }
  return candidates;
}

async function runOnce(): Promise<void> {
  const filters = finishedChapterCleanupFilters();
  if (!filters || isChapterCleanupActive()) return;
  const serverSetting = useContentSyncStore.getState().serverUrl;
  const candidates = await collectFinishedCandidates(filters);
  const activeReaderIds = getActiveReaderChapterIds();
  let skippedActiveReader = false;
  const nonActive: ChapterCleanupCandidate[] = [];
  for (const candidate of candidates) {
    if (activeReaderIds.has(candidate.identity.chapter.id)) {
      skippedActiveReader = true;
    } else {
      nonActive.push(candidate);
    }
  }
  const novelIds = [...new Set(nonActive.map((candidate) => candidate.identity.novel.id))];
  const goalProtectedIds =
    novelIds.length > 0 ? await listGoalProtectedChapterIds(novelIds) : new Set<number>();
  const eligible = nonActive.filter(
    (candidate) => !goalProtectedIds.has(candidate.identity.chapter.id),
  );
  if (eligible.length === 0 || isChapterCleanupActive()) {
    if (!isChapterCleanupActive() && !skippedActiveReader) {
      useFinishedChapterCleanupStore.setState({ lastRunAt: Date.now() });
    }
    return;
  }
  const locale = useAppearanceStore.getState().appLocale;
  const result = await enqueueFinishedChapterCleanup(
    filters,
    serverSetting,
    eligible,
    translate(locale, "finishedCleanup.task"),
    undefined,
    "background",
  ).promise;
  const deleted = result.results
    .filter((item) => item.status === "deleted")
    .map((item) => item.chapterId);
  if (deleted.length > 0 && activeQueryClient) {
    await Promise.all([
      activeQueryClient.invalidateQueries({ queryKey: ["novel"] }),
      activeQueryClient.invalidateQueries({ queryKey: ["chapter"] }),
      activeQueryClient.invalidateQueries({ queryKey: ["download-cache"] }),
    ]).catch(() => undefined);
  }
  const hasTransientOrDeferredSkip =
    skippedActiveReader ||
    result.failed > 0 ||
    result.cancelled > 0 ||
    result.results.some(
      (item) =>
        item.status === "skipped" &&
        item.reason !== undefined &&
        TRANSIENT_OR_DEFERRED_SKIP_REASONS.has(item.reason),
    );
  const at = Date.now();
  useFinishedChapterCleanupStore.setState({
    ...(hasTransientOrDeferredSkip ? {} : { lastRunAt: at }),
    ...(deleted.length > 0
      ? { lastRemoval: { at, deleted: deleted.length, bytesFreed: result.bytesFreed } }
      : {}),
  });
}

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let scheduledDeadline: number | null = null;
const unsubscribers: (() => void)[] = [];

function schedule(delayMs: number, options?: { preserveLaterDeadline?: boolean }): void {
  const nextDeadline = Date.now() + delayMs;
  if (
    options?.preserveLaterDeadline &&
    timer !== null &&
    scheduledDeadline !== null &&
    scheduledDeadline > nextDeadline
  ) {
    return;
  }
  if (timer !== null) clearTimeout(timer);
  scheduledDeadline = nextDeadline;
  timer = setTimeout(() => {
    timer = null;
    scheduledDeadline = null;
    void runFinishedChapterCleanup().catch((error: unknown) =>
      console.warn("[finished-chapter-cleanup] automatic removal failed:", error));
  }, delayMs);
}

function scheduleWhenDue(): void {
  if (!isAppActive()) return;
  if (!finishedChapterCleanupFilters()) return;
  if (isFinishedChapterCleanupDue(Date.now(), useFinishedChapterCleanupStore.getState().lastRunAt)) {
    schedule(AFTER_START_DELAY_MS, { preserveLaterDeadline: true });
  }
}

/**
 * Runs after reading progress/shared sync/reader exit and daily while visible,
 * catching up missed runs or deferred skips on return.
 */
export function startFinishedChapterCleanup(queryClient?: QueryInvalidator): void {
  if (queryClient) activeQueryClient = queryClient;
  if (started) return;
  started = true;
  unsubscribers.push(
    useReaderStore.subscribe((state, previous) => {
      if (!isApplyingSharedReaderResume() && state.lastReadChapterByNovel !== previous.lastReadChapterByNovel && finishedChapterCleanupFilters()) {
        schedule(AFTER_PROGRESS_DELAY_MS);
      }
    }),
    subscribeActiveReaderChapters((removedIds) => {
      if (removedIds.length > 0 && finishedChapterCleanupFilters()) {
        schedule(AFTER_PROGRESS_DELAY_MS);
      }
    }),
    subscribeUpdatesIndexChanges((event) => {
      if ((event.reason === "read-progress" || event.reason === "updates-cleared") && finishedChapterCleanupFilters()) {
        schedule(AFTER_PROGRESS_DELAY_MS);
      }
    }),
    subscribeUserStateApplied((effects) => {
      if (effects.hasFinishedReading && finishedChapterCleanupFilters()) {
        schedule(AFTER_PROGRESS_DELAY_MS);
      }
    }),
    useDownloadGoalSettingsStore.subscribe((state, previous) => {
      const relevantChanged =
        state.finishedChapterKeep !== previous.finishedChapterKeep ||
        state.finishedCleanupWithoutServer !== previous.finishedCleanupWithoutServer ||
        state.automaticActiveWindow !== previous.automaticActiveWindow ||
        JSON.stringify(state.automaticGoal) !== JSON.stringify(previous.automaticGoal);
      if (relevantChanged && finishedChapterCleanupFilters()) {
        schedule(AFTER_START_DELAY_MS, { preserveLaterDeadline: true });
      }
    }),
    useContentSyncStore.subscribe((state, previous) => {
      const relevantChanged =
        state.serverUrl !== previous.serverUrl ||
        state.uploadConflictPolicy !== previous.uploadConflictPolicy;
      if (relevantChanged && finishedChapterCleanupFilters()) {
        schedule(AFTER_START_DELAY_MS, { preserveLaterDeadline: true });
      }
    }),
    subscribeContentSyncUploadSettled(() => {
      if (finishedChapterCleanupFilters()) {
        schedule(AFTER_START_DELAY_MS, { preserveLaterDeadline: true });
      }
    }),
  );
  unsubscribers.push(subscribeAppLifecycle((active) => {
    if (active) scheduleWhenDue();
  }));
  const interval = setInterval(scheduleWhenDue, DUE_CHECK_INTERVAL_MS);
  unsubscribers.push(() => clearInterval(interval));
  scheduleWhenDue();
}

/** Test hook: forget all module state. */
export function resetFinishedChapterCleanupForTests(): void {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  if (timer !== null) clearTimeout(timer);
  timer = null;
  scheduledDeadline = null;
  started = false;
  running = null;
  activeQueryClient = null;
}
