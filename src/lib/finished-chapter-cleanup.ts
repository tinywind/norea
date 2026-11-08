import { create } from "zustand";
import { persist } from "zustand/middleware";
import { translate } from "../i18n";
import { useAppearanceStore } from "../store/appearance";
import { useContentSyncStore } from "../store/content-sync";
import { useDownloadGoalSettingsStore } from "../store/download-goals";
import { isApplyingSharedReaderResume, useReaderStore } from "../store/reader";
import { approveChapterCleanupTargets, previewChapterCleanup, type ChapterCleanupFilters } from "./chapter-cleanup";
import { listGoalProtectedChapterIds } from "./download-goals/goal-protection";
import { noteDownloadDeletion } from "./download-goals/goal-service";
import { enqueueChapterCleanup, isChapterCleanupActive } from "./tasks/chapter-cleanup";
import { subscribeUpdatesIndexChanges } from "./updates/update-index-events";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Reading progress settles for this long before a run, so page turns do not start one each. */
const AFTER_PROGRESS_DELAY_MS = 60_000;
/** A launch or foreground return waits this long so the run does not compete with startup work. */
const AFTER_START_DELAY_MS = 30_000;
const DUE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface FinishedChapterCleanupRun {
  /** Unix milliseconds when the run finished. */
  at: number;
  deleted: number;
  bytesFreed: number;
}

interface FinishedChapterCleanupState {
  /** Unix milliseconds of the last completed run, whether or not it removed anything. */
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
  if (finishedChapterKeep === 0) return null;
  const hasServer = Boolean(useContentSyncStore.getState().serverUrl);
  // Only a verified complete server copy justifies unattended deletion; without a server the user must accept that.
  if (!hasServer && !finishedCleanupWithoutServer) return null;
  return {
    reading: "read",
    categories: { mode: "all" },
    server: hasServer ? "server-contains-local" : "any",
    finished: { keepLast: finishedChapterKeep },
  };
}

/** Whether a daily run is due: never ran, or 24 hours passed since the last run. */
export function isFinishedChapterCleanupDue(now: number, lastRunAt: number | null): boolean {
  return lastRunAt === null || now - lastRunAt >= DAY_MS;
}

let running: Promise<void> | null = null;

/**
 * Removes downloaded chapters that are finished and far enough behind the reading position.
 * Skipped while another cleanup runs. Every removed chapter becomes a goal exclusion.
 */
export function runFinishedChapterCleanup(): Promise<void> {
  running ??= runOnce().finally(() => { running = null; });
  return running;
}

async function runOnce(): Promise<void> {
  const filters = finishedChapterCleanupFilters();
  if (!filters || isChapterCleanupActive()) return;
  const preview = await previewChapterCleanup(filters);
  const novelIds = [...new Set(preview.targets.map((target) => target.candidate.identity.novel.id))];
  const approved = approveChapterCleanupTargets(preview, await listGoalProtectedChapterIds(novelIds),
    { includeUnread: false, includeGoalKept: false });
  if (approved.targets.length === 0 || isChapterCleanupActive()) {
    useFinishedChapterCleanupStore.setState({ lastRunAt: Date.now() });
    return;
  }
  const locale = useAppearanceStore.getState().appLocale;
  const result = await enqueueChapterCleanup(approved, translate(locale, "finishedCleanup.task"), undefined, "background").promise;
  const deleted = result.results.filter((item) => item.status === "deleted").map((item) => item.chapterId);
  if (deleted.length > 0) await noteDownloadDeletion(deleted);
  const at = Date.now();
  useFinishedChapterCleanupStore.setState({
    lastRunAt: at,
    ...(deleted.length > 0 ? { lastRemoval: { at, deleted: deleted.length, bytesFreed: result.bytesFreed } } : {}),
  });
}

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const unsubscribers: (() => void)[] = [];

function schedule(delayMs: number): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runFinishedChapterCleanup().catch((error: unknown) =>
      console.warn("[finished-chapter-cleanup] automatic removal failed:", error));
  }, delayMs);
}

function scheduleWhenDue(): void {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  if (!finishedChapterCleanupFilters()) return;
  if (isFinishedChapterCleanupDue(Date.now(), useFinishedChapterCleanupStore.getState().lastRunAt)) {
    schedule(AFTER_START_DELAY_MS);
  }
}

/** Runs after reading progress changes and daily while the app is visible, catching up a missed day on return. */
export function startFinishedChapterCleanup(): void {
  if (started) return;
  started = true;
  unsubscribers.push(
    useReaderStore.subscribe((state, previous) => {
      if (!isApplyingSharedReaderResume() && state.lastReadChapterByNovel !== previous.lastReadChapterByNovel && finishedChapterCleanupFilters()) {
        schedule(AFTER_PROGRESS_DELAY_MS);
      }
    }),
    subscribeUpdatesIndexChanges((event) => {
      if (event.reason === "read-progress" && finishedChapterCleanupFilters()) schedule(AFTER_PROGRESS_DELAY_MS);
    }),
    useDownloadGoalSettingsStore.subscribe((state, previous) => {
      if (state.finishedChapterKeep !== previous.finishedChapterKeep && state.finishedChapterKeep > 0) {
        schedule(AFTER_START_DELAY_MS);
      }
    }),
  );
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", scheduleWhenDue);
    unsubscribers.push(() => document.removeEventListener("visibilitychange", scheduleWhenDue));
  }
  const interval = setInterval(scheduleWhenDue, DUE_CHECK_INTERVAL_MS);
  unsubscribers.push(() => clearInterval(interval));
  scheduleWhenDue();
}

/** Test hook: forget all module state. */
export function resetFinishedChapterCleanupForTests(): void {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  if (timer !== null) clearTimeout(timer);
  timer = null; started = false; running = null;
}
