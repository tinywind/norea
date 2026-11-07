import { getNovelById } from "../../db/queries/novel";
import { countRecentChecksBySource, getNovelFreshness, listCheckCandidates } from "../../db/queries/novel-freshness";
import { translate } from "../../i18n";
import { useAppearanceStore } from "../../store/appearance";
import { useDownloadGoalSettingsStore } from "../../store/download-goals";
import { normalizeCheckIntervalHours, useLibraryStore } from "../../store/library";
import { isAbortError } from "../abort";
import { readDownloadBudgetStatus } from "../download-goals/budget";
import { automaticDownloadActiveSince } from "../download-goals/goal-targets";
import { isNetworkOnline } from "../network";
import { pluginManager } from "../plugins/manager";
import { taskScheduler } from "../tasks/scheduler";
import { readServerNovelSource } from "../content-sync/novel-source";
import { SOURCE_CHECKS_PER_HOUR, STALE_ON_OPEN_SECONDS, selectDueChecks } from "./check-cadence";
import { checkForNewChapters, checkNovelForNewChapters } from "./check-library-updates";

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
    const activeSince = automaticDownloadActiveSince(useDownloadGoalSettingsStore.getState().automaticGoal, nowSeconds);
    const candidates = (await listCheckCandidates(activeSince)).filter((novel) => pluginManager.getPlugin(novel.pluginId));
    const due = selectDueChecks(candidates, {
      intervalHours, nowSeconds, recentChecksBySource: await countRecentChecksBySource(nowSeconds - HOUR_SECONDS),
    });
    if (due.length === 0) return;
    const locale = useAppearanceStore.getState().appLocale;
    try {
      await checkForNewChapters({
        aggregateTaskTitle: translate(locale, "tasks.task.checkLibraryUpdates"),
        automatic: true,
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

/**
 * Opening a library novel or a content-server work whose last check is older than 6 hours checks
 * it in the background, within its source's hourly budget. Resolves true when a check ran.
 */
export async function checkNovelIfStale(
  novelId: number,
  title: string,
  signal: AbortSignal,
  options: { nowMs?: number; onStart?: () => void } = {},
): Promise<boolean> {
  const nowMs = options.nowMs ?? Date.now();
  const novel = await getNovelById(novelId);
  if (!novel || novel.isLocal || novel.path.startsWith("norea-folder:") || !isNetworkOnline()) return false;
  if (!novel.inLibrary && !await readServerNovelSource(novelId)) return false;
  const nowSeconds = Math.floor(nowMs / 1000);
  const lastCheckedAt = (await getNovelFreshness(novelId))?.lastCheckedAt ?? null;
  if (lastCheckedAt !== null && nowSeconds - lastCheckedAt < STALE_ON_OPEN_SECONDS) return false;
  if (((await countRecentChecksBySource(nowSeconds - HOUR_SECONDS)).get(novel.pluginId) ?? 0) >= SOURCE_CHECKS_PER_HOUR) return false;
  await pluginManager.loadInstalledFromDb();
  const plugin = pluginManager.getPlugin(novel.pluginId);
  if (!plugin || signal.aborted) return false;
  options.onStart?.();
  const task = checkNovelForNewChapters(plugin, novel, { title });
  const cancel = () => { taskScheduler.cancel(task.id); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await task.promise;
    return true;
  } finally {
    signal.removeEventListener("abort", cancel);
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
