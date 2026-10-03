import { requestAbortedError } from "../abort";
import {
  activeScraperExecutorSignal,
  subscribeScraperExecutorSignalChanges,
  type ScraperExecutorId,
} from "../tasks/scraper-queue";
import type { FetchResultWire, PluginFetchPriority } from "./types";

interface PendingFetch {
  priority: number;
  signal?: AbortSignal;
  ownerSignal?: AbortSignal;
  run: () => Promise<FetchResultWire>;
  resolve: (result: FetchResultWire) => void;
  reject: (error: unknown) => void;
}

interface ExecutorFetchQueue {
  active?: PendingFetch;
  cancellations: number;
  pending: PendingFetch[];
  unsubscribe: () => void;
}

const queues = new Map<ScraperExecutorId, ExecutorFetchQueue>();
const priorityRanks: Record<PluginFetchPriority, number> = {
  interactive: 0,
  user: 1,
  normal: 2,
  deferred: 3,
  background: 4,
};

function executorQueue(executor: ScraperExecutorId): ExecutorFetchQueue {
  const existing = queues.get(executor);
  if (existing) return existing;
  const queue: ExecutorFetchQueue = {
    cancellations: 0,
    pending: [],
    unsubscribe: subscribeScraperExecutorSignalChanges((changed) => {
      if (changed === executor) drain(executor, queue);
    }),
  };
  queues.set(executor, queue);
  return queue;
}

function drain(executor: ScraperExecutorId, queue: ExecutorFetchQueue): void {
  if (queue.active || queue.cancellations > 0) return;
  const owner = activeScraperExecutorSignal(executor);
  let selectedIndex = -1;
  for (let index = 0; index < queue.pending.length; index += 1) {
    const candidate = queue.pending[index]!;
    // Keep unrelated covers out of a source task's whole request sequence.
    if (
      owner &&
      candidate.priority > priorityRanks.normal &&
      candidate.ownerSignal !== owner
    ) {
      continue;
    }
    if (
      selectedIndex < 0 ||
      candidate.priority < queue.pending[selectedIndex]!.priority
    ) {
      selectedIndex = index;
    }
  }
  if (selectedIndex < 0) {
    if (queue.pending.length === 0) {
      queue.unsubscribe();
      queues.delete(executor);
    }
    return;
  }
  const entry = queue.pending.splice(selectedIndex, 1)[0]!;
  queue.active = entry;
  const finish = () => {
    queue.active = undefined;
    drain(executor, queue);
  };
  let request: Promise<FetchResultWire>;
  try {
    request = entry.run();
  } catch (error) {
    entry.reject(error);
    finish();
    return;
  }
  void request.then(
    (result) => {
      entry.resolve(result);
      finish();
    },
    (error: unknown) => {
      entry.reject(error);
      finish();
    },
  );
}

export function enqueueDesktopFetch(
  executor: ScraperExecutorId,
  priority: PluginFetchPriority | undefined,
  signal: AbortSignal | undefined,
  run: () => Promise<FetchResultWire>,
  cancelActive: () => Promise<unknown>,
  ownerSignal: AbortSignal | undefined = signal,
): Promise<FetchResultWire> {
  if (signal?.aborted) return Promise.reject(requestAbortedError());
  const queue = executorQueue(executor);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const entry: PendingFetch = {
      priority: priorityRanks[priority ?? "normal"],
      signal,
      ownerSignal,
      run,
      resolve: (result) => {
        cleanup();
        resolve(result);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
    };
    const abort = () => {
      entry.reject(requestAbortedError());
      if (queue.active === entry) {
        // Native settlement, not the public abort result, releases admission.
        void cancelActive();
      } else {
        queue.pending = queue.pending.filter((pending) => pending !== entry);
        drain(executor, queue);
      }
    };
    queue.pending.push(entry);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else drain(executor, queue);
  });
}

export function beginDesktopFetchCancellation(
  executor: ScraperExecutorId,
): () => void {
  const queue = executorQueue(executor);
  queue.cancellations += 1;
  for (const pending of queue.pending.splice(0)) {
    pending.reject(requestAbortedError());
  }
  return () => {
    queue.cancellations -= 1;
    drain(executor, queue);
  };
}
