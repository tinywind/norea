export const TASK_BATCH_MATERIALIZATION_WINDOW = 16;
const TASK_BATCH_EVENT_LOOP_YIELD_INTERVAL =
  TASK_BATCH_MATERIALIZATION_WINDOW;

interface RunBoundedTaskBatchOptions<T> {
  items: Iterable<T>;
  materializeBatch?: (run: () => void) => void;
  materialize: (item: T, index: number) => Promise<void>;
  shouldContinue?: () => boolean;
  windowSize?: number;
}

function normalizeTaskBatchWindowSize(windowSize: number): number {
  if (!Number.isFinite(windowSize)) return TASK_BATCH_MATERIALIZATION_WINDOW;
  return Math.min(
    TASK_BATCH_MATERIALIZATION_WINDOW,
    Math.max(1, Math.floor(windowSize)),
  );
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

export async function runBoundedTaskBatch<T>({
  items,
  materializeBatch,
  materialize,
  shouldContinue = () => true,
  windowSize = TASK_BATCH_MATERIALIZATION_WINDOW,
}: RunBoundedTaskBatchOptions<T>): Promise<void> {
  const maxActive = normalizeTaskBatchWindowSize(windowSize);
  const active = new Set<Promise<void>>();
  const iterator = items[Symbol.iterator]();
  let iteratorDone = false;
  let nextIndex = 0;
  let settledSinceYield = 0;

  const startNext = (): void => {
    const next = iterator.next();
    if (next.done) {
      iteratorDone = true;
      return;
    }
    const index = nextIndex;
    nextIndex += 1;
    const item = next.value;
    let promise: Promise<void>;
    try {
      promise = Promise.resolve(materialize(item, index));
    } catch (error) {
      promise = Promise.reject(error);
    }
    promise = promise.finally(() => {
      active.delete(promise);
      settledSinceYield += 1;
    });
    active.add(promise);
  };

  while (!iteratorDone || active.size > 0) {
    const startAvailable = (): void => {
      while (
        !iteratorDone &&
        active.size < maxActive &&
        shouldContinue()
      ) {
        startNext();
      }
    };
    if (materializeBatch) {
      materializeBatch(startAvailable);
    } else {
      startAvailable();
    }

    if (active.size === 0) break;
    await Promise.race(active);
    if (settledSinceYield >= TASK_BATCH_EVENT_LOOP_YIELD_INTERVAL) {
      settledSinceYield -= TASK_BATCH_EVENT_LOOP_YIELD_INTERVAL;
      await yieldToEventLoop();
    }
  }
}
