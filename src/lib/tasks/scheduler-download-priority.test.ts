import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskScheduler, type TaskPriority } from "./scheduler";

let scheduler: TaskScheduler;
let order: string[];
let releaseFirst: () => void;

const download = (key: string, priority: TaskPriority, source = "source") => scheduler.enqueueSource({
  kind: "chapter.download", title: key, source: { id: source, name: source }, dedupeKey: key, priority,
  run: async () => {
    order.push(key);
    if (key === "first") await new Promise<void>((resolve) => { releaseFirst = resolve; });
  },
});

beforeEach(() => {
  vi.useFakeTimers();
  order = [];
  scheduler = new TaskScheduler({ sourceForegroundConcurrency: 1, sourceQueuesPaused: false });
});
afterEach(() => { vi.useRealTimers(); });

async function drainAll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  releaseFirst();
  for (let step = 0; step < 10; step += 1) await vi.advanceTimersByTimeAsync(0);
}

it("starts a tapped chapter before earlier background downloads from the same source", async () => {
  download("first", "background");
  await vi.advanceTimersByTimeAsync(0);
  download("background-1", "background");
  download("goal-focus", "deferred");
  download("background-2", "background");
  download("tapped", "user");
  await drainAll();

  expect(order).toEqual(["first", "tapped", "goal-focus", "background-1", "background-2"]);
});

it("moves a queued background chapter forward when the user requests it", async () => {
  download("first", "background");
  await vi.advanceTimersByTimeAsync(0);
  download("background-1", "background");
  download("background-2", "background");
  download("background-2", "user");
  await drainAll();

  expect(order).toEqual(["first", "background-2", "background-1"]);
});
