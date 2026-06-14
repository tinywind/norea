export type ScraperExecutorId = "immediate" | `pool:${number}`;

const DEFAULT_SCRAPER_EXECUTOR: ScraperExecutorId = "immediate";

const activeExecutorsBySourceId = new Map<
  string,
  Map<string, ScraperExecutorId>
>();

// Exactly one task runs per executor at a time, so the active task's abort
// signal can be keyed by executor. Plugin-owned fetch/WebView helpers read it
// to make in-flight site traffic abortable when the owning task is paused or
// cancelled, freeing the executor for interactive work.
const activeSignalByExecutor = new Map<ScraperExecutorId, AbortSignal>();

export function activeScraperExecutor(
  sourceId: string | undefined,
): ScraperExecutorId {
  if (!sourceId) return DEFAULT_SCRAPER_EXECUTOR;
  const active = activeExecutorsBySourceId.get(sourceId);
  if (!active || active.size === 0) return DEFAULT_SCRAPER_EXECUTOR;
  return [...active.values()][active.size - 1] ?? DEFAULT_SCRAPER_EXECUTOR;
}

export function activeScraperExecutorSignal(
  executor: ScraperExecutorId | undefined,
): AbortSignal | undefined {
  if (!executor) return undefined;
  return activeSignalByExecutor.get(executor);
}

export async function runWithScraperExecutor<T>(
  sourceId: string,
  taskId: string,
  executorId: ScraperExecutorId,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const active = activeExecutorsBySourceId.get(sourceId) ?? new Map();
  active.set(taskId, executorId);
  activeExecutorsBySourceId.set(sourceId, active);
  const previousSignal = activeSignalByExecutor.get(executorId);
  if (signal) activeSignalByExecutor.set(executorId, signal);

  try {
    return await run();
  } finally {
    active.delete(taskId);
    if (active.size === 0) {
      activeExecutorsBySourceId.delete(sourceId);
    }
    if (signal && activeSignalByExecutor.get(executorId) === signal) {
      if (previousSignal) {
        activeSignalByExecutor.set(executorId, previousSignal);
      } else {
        activeSignalByExecutor.delete(executorId);
      }
    }
  }
}
