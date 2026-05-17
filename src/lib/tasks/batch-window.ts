import { MAX_SCHEDULER_MATERIALIZED_TASKS } from "../performance-budgets";

export const TASK_BATCH_MATERIALIZATION_WINDOW = Math.max(
  1,
  MAX_SCHEDULER_MATERIALIZED_TASKS - 1,
);

interface RunBoundedTaskBatchOptions<T> {
  items: Iterable<T>;
  materialize: (item: T, index: number) => Promise<void>;
  shouldContinue?: () => boolean;
  windowSize?: number;
}

function normalizeTaskBatchWindowSize(windowSize: number): number {
  if (!Number.isFinite(windowSize)) return TASK_BATCH_MATERIALIZATION_WINDOW;
  return Math.min(
    MAX_SCHEDULER_MATERIALIZED_TASKS,
    Math.max(1, Math.floor(windowSize)),
  );
}

export async function runBoundedTaskBatch<T>({
  items,
  materialize,
  shouldContinue = () => true,
  windowSize = TASK_BATCH_MATERIALIZATION_WINDOW,
}: RunBoundedTaskBatchOptions<T>): Promise<void> {
  const maxActive = normalizeTaskBatchWindowSize(windowSize);
  const active = new Set<Promise<void>>();
  const iterator = items[Symbol.iterator]();
  let iteratorDone = false;
  let nextIndex = 0;

  const startNext = (): void => {
    const next = iterator.next();
    if (next.done) {
      iteratorDone = true;
      return;
    }
    const index = nextIndex;
    nextIndex += 1;
    const item = next.value;
    let promise!: Promise<void>;
    promise = Promise.resolve()
      .then(() => materialize(item, index))
      .finally(() => {
        active.delete(promise);
      });
    active.add(promise);
  };

  while (!iteratorDone || active.size > 0) {
    while (
      !iteratorDone &&
      active.size < maxActive &&
      shouldContinue()
    ) {
      startNext();
    }

    if (active.size === 0) break;
    await Promise.race(active);
  }
}
