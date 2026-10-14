import type { PluginManager } from "./manager";
import type { NovelItem, Plugin } from "./types";
import { enqueueSourceTask } from "../tasks/source-tasks";
import { taskScheduler, type TaskHandle } from "../tasks/scheduler";
import { cancelAndroidScraperExecutor } from "../android-scraper";

export interface GlobalSearchResult {
  pluginId: string;
  pluginName: string;
  novels: NovelItem[];
  error?: string;
}

export interface GlobalSearchOptions {
  plugins?: readonly Plugin[];
  /** When the signal aborts, no further results are yielded. */
  signal?: AbortSignal;
  /** Per-plugin search timeout. Default 30 seconds. */
  timeoutMs?: number;
  /** Called as each plugin's task settles. */
  onResult?: (result: GlobalSearchResult) => void;
  taskTitle?: (plugin: Plugin) => string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function normalizeTimeoutMs(value: unknown): number {
  const numeric = typeof value === "number" ? value : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(numeric)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.round(numeric));
}

function formatTimeoutSeconds(timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}

async function withTimeout<T>(
  task: () => Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const promise = task();
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      promise.catch(() => undefined);
      onTimeout?.();
      reject(
        new Error(
          `Search timed out after ${formatTimeoutSeconds(timeoutMs)} seconds.`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

/**
 * Fan a single search query across every installed plugin with three search
 * executors, separate from the download queue. Returns the per-plugin results
 * once every task has settled.
 *
 * If the {@link AbortSignal} fires, in-flight plugin tasks may still
 * finish (the upstream plugin contract does not guarantee abortable
 * HTTP), but their results are discarded and no further plugin tasks
 * are started. The per-plugin timeout keeps stalled plugins from
 * blocking the full search result set.
 */
export async function globalSearch(
  manager: PluginManager,
  term: string,
  options: GlobalSearchOptions = {},
): Promise<GlobalSearchResult[]> {
  const plugins = options.plugins ?? manager.list();
  if (plugins.length === 0) return [];

  const { signal, onResult } = options;
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const collected: GlobalSearchResult[] = [];
  const handles: TaskHandle<NovelItem[]>[] = [];

  const cancelQueuedSearches = () => {
    for (const handle of handles) taskScheduler.cancel(handle.id);
  };
  signal?.addEventListener("abort", cancelQueuedSearches, { once: true });

  const tasks = plugins.map(async (plugin) => {
    if (signal?.aborted) return;
    let result: GlobalSearchResult;
    try {
      const handle = enqueueSourceTask<NovelItem[]>({
        plugin,
        kind: "source.globalSearch",
        priority: "user",
        title: options.taskTitle?.(plugin) ?? plugin.name,
        subject: { path: term },
        dedupeKey: `source.globalSearch:${plugin.id}:${term}`,
        run: (context) => {
          const executor = context.executor ?? "immediate";
          const runtimePlugin = manager.getPluginForExecutor(
            plugin.id,
            executor,
          );
          return (
            withTimeout(
              () => runtimePlugin.searchNovels(term, 1),
              timeoutMs,
              () =>
                cancelAndroidScraperExecutor(
                  "scraper: global search timed out",
                  executor,
                ),
            )
          );
        },
      });
      handles.push(handle);
      const novels = await handle.promise;
      result = {
        pluginId: plugin.id,
        pluginName: plugin.name,
        novels,
      };
    } catch (error) {
      result = {
        pluginId: plugin.id,
        pluginName: plugin.name,
        novels: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (signal?.aborted) return;
    collected.push(result);
    onResult?.(result);
  });

  try {
    await Promise.all(tasks);
    return collected;
  } finally {
    signal?.removeEventListener("abort", cancelQueuedSearches);
  }
}
