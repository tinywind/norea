import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TaskEvent, TaskRecord, TaskSnapshot } from "./scheduler";
import type { ChapterDownloadBatchProgressEvent } from "./chapter-download";
import type { TaskNotificationTranslate } from "./task-notification-model";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  getSnapshot: vi.fn(), subscribe: vi.fn(), subscribeEvents: vi.fn(),
  subscribeBatches: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../tauri-runtime", () => ({ isWindowsRuntime: () => true }));
vi.mock("./scheduler", () => ({ taskScheduler: mocks }));
vi.mock("./chapter-download", () => ({
  getChapterDownloadBatchProgress: () => [],
  subscribeChapterDownloadBatchProgress: mocks.subscribeBatches,
}));

import { startTrayTaskProgress } from "./tray-progress";

let emit: (event: TaskEvent) => void;
let emitBatch: (event: ChapterDownloadBatchProgressEvent) => void;
let publish: () => void;
let dispose: (() => void) | undefined;

const t: TaskNotificationTranslate = (key, params) =>
  key === "tasks.notification.downloadTitleProgress"
    ? `${params?.current}/${params?.total} processed`
    : key;

function task(id: string): TaskRecord {
  return {
    id, lane: "source", kind: "chapter.download", priority: "background",
    title: id, source: { id: "source", name: "Source" }, status: "queued",
    createdAt: 1, canCancel: true, canRetry: false,
  };
}

function snapshot(records: TaskRecord[] = []): TaskSnapshot {
  return {
    records, pausedSourceIds: [], pausedTaskGroups: [], sourceQueueOrder: [],
    recordLimit: records.length, recordsTruncated: false, sourceQueueLimit: 0,
    sourceQueuesTotal: 0, sourceQueuesTruncated: false, sourceQueuesPaused: false,
    sourceAccessBlocks: [], total: records.length, running: 0, queued: records.length,
    failed: 0, succeeded: 0, cancelled: 0,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  emit = () => undefined;
  emitBatch = () => undefined;
  publish = () => undefined;
  mocks.getSnapshot.mockReturnValue(snapshot());
  mocks.subscribe.mockImplementation((listener: () => void) => {
    publish = listener; return vi.fn();
  });
  mocks.subscribeEvents.mockImplementation((listener: typeof emit) => {
    emit = listener; return vi.fn();
  });
  mocks.subscribeBatches.mockImplementation((listener: typeof emitBatch) => {
    emitBatch = listener; return vi.fn();
  });
});

afterEach(() => {
  dispose?.(); dispose = undefined;
  vi.useRealTimers();
});

it("publishes batch progress while no download children are materialized", async () => {
  dispose = startTrayTaskProgress(t);
  await vi.advanceTimersByTimeAsync(250);

  emitBatch({
    batchId: "batch", active: true,
    progress: { current: 2, total: 4, succeeded: 2, failed: 0, cancelled: 0 },
  });
  await vi.advanceTimersByTimeAsync(250);

  expect(mocks.invoke).toHaveBeenLastCalledWith("tray_set_task_progress", {
    items: [{ label: "2/4 processed" }], summary: "tasks.notification.downloads",
  });
});

it("applies changed task records without rescanning later snapshots", async () => {
  const first = task("first");
  mocks.getSnapshot.mockReturnValue(snapshot([first, task("second")]));
  dispose = startTrayTaskProgress(t);
  await vi.advanceTimersByTimeAsync(250);
  const metadata = snapshot();
  Object.defineProperty(metadata, "records", { get: () => { throw new Error("Full records rescanned"); } });
  mocks.getSnapshot.mockReturnValue(metadata);

  emit({ task: { ...first, status: "succeeded" }, previousStatus: "queued" });
  publish();
  await vi.advanceTimersByTimeAsync(250);

  expect(mocks.invoke).toHaveBeenLastCalledWith("tray_set_task_progress", {
    items: [{ label: "1/2 processed" }], summary: "tasks.notification.downloads",
  });
});

it("coalesces frequent snapshots without postponing publication indefinitely", async () => {
  mocks.getSnapshot.mockReturnValue(snapshot([task("first")]));
  dispose = startTrayTaskProgress(t);
  await vi.advanceTimersByTimeAsync(100);
  publish();
  await vi.advanceTimersByTimeAsync(100);
  publish();
  await vi.advanceTimersByTimeAsync(50);

  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});
