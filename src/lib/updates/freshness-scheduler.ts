import { countRecentChecksBySource, listCheckCandidates } from "../../db/queries/novel-freshness";
import { translate } from "../../i18n";
import { useAppearanceStore } from "../../store/appearance";
import { useDownloadGoalSettingsStore } from "../../store/download-goals";
import { normalizeCheckIntervalHours, useLibraryStore } from "../../store/library";
import { isAbortError } from "../abort";
import { readDownloadBudgetStatus } from "../download-goals/budget";
import { isNetworkOnline } from "../network";
import { pluginManager } from "../plugins/manager";
import { taskScheduler } from "../tasks/scheduler";
import { selectDueChecks } from "./check-cadence";
import { checkForNewChapters } from "./check-library-updates";

const TICK_MS = 30 * 60_000;
const HOUR_SECONDS = 60 * 60;

let started = false;
let running = false;
let tick: ReturnType<typeof setInterval> | null = null;
/** After the user cancels an automatic check, the next one waits for the next interval. */
let pausedUntilMs = 0;

const isVisible = () => typeof document === "undefined" || document.visibilityState === "visible";

function isCheckRunning(): boolean {
  return taskScheduler.getSnapshot().records.some((record) =>
    record.kind === "library.checkUpdates" && (record.status === "queued" || record.status === "running"));
}

/** Mobile data (unless allowed) and battery saver pause automatic checks, as they pause goal work. */
async function isBudgetPaused(): Promise<boolean> {
  const status = await readDownloadBudgetStatus();
  return status.powerSave || (status.metered && !useDownloadGoalSettingsStore.getState().automaticOnMobileData);
}

/**
 * Checks the library novels that are due (spec F2) while the app is visible: novels being read
 * first, at most 30 checks per source per hour, so a catch-up spreads over the following hours.
 * Skipped while offline, while another check runs, or under the mobile-data and battery budgets.
 */
export async function runDueChecks(nowMs = Date.now()): Promise<void> {
  const intervalHours = normalizeCheckIntervalHours(useLibraryStore.getState().checkIntervalHours);
  if (running || intervalHours === 0 || !isVisible() || nowMs < pausedUntilMs || !isNetworkOnline() || isCheckRunning()) return;
  running = true;
  try {
    if (await isBudgetPaused()) return;
    await pluginManager.loadInstalledFromDb();
    const nowSeconds = Math.floor(nowMs / 1000);
    const candidates = (await listCheckCandidates()).filter((novel) => pluginManager.getPlugin(novel.pluginId));
    const due = selectDueChecks(candidates, {
      intervalHours, nowSeconds, recentChecksBySource: await countRecentChecksBySource(nowSeconds - HOUR_SECONDS),
    });
    if (due.length === 0) return;
    const locale = useAppearanceStore.getState().appLocale;
    try {
      await checkForNewChapters({
        aggregateTaskTitle: translate(locale, "tasks.task.checkLibraryUpdates"),
        limit: 1,
        novelIds: due,
        taskTitle: (novel) => translate(locale, "tasks.task.checkUpdates", { name: novel.name }),
      });
    } catch (error) {
      if (isAbortError(error)) pausedUntilMs = nowMs + intervalHours * HOUR_SECONDS * 1000;
      else throw error;
    }
  } finally {
    running = false;
  }
}

function runInBackground(): void {
  void runDueChecks().catch((error: unknown) => console.warn("[freshness] automatic check failed:", error));
}

function onVisibilityChange(): void {
  if (isVisible()) runInBackground();
}

/** Starts automatic checks: now, whenever the app returns to the foreground, and every 30 minutes. */
export function startFreshnessChecks(): void {
  if (started) return;
  started = true;
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange);
  tick = setInterval(runInBackground, TICK_MS);
  runInBackground();
}

/** Test hook: forget all module state. */
export function resetFreshnessChecksForTests(): void {
  if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange);
  if (tick !== null) clearInterval(tick);
  tick = null; started = false; running = false; pausedUntilMs = 0;
}
