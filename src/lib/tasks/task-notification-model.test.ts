import { describe, expect, it, vi } from "vitest";
import {
  TaskNotificationTracker,
  buildTaskEventNotificationBody,
  sumTaskNotificationProgress,
  type TaskNotificationTranslate,
} from "./task-notification-model";
import type { TaskRecord, TaskSnapshot } from "./scheduler";

vi.mock("./chapter-download", () => ({
  getActiveChapterDownloadBatchProgress: () => undefined,
  getChapterDownloadBatchProgress: () => [],
}));

const t: TaskNotificationTranslate = (key, params) => `${key}:${JSON.stringify(params ?? {})}`;
function task(id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id, lane: "source", kind: "chapter.download", priority: "background",
    title: id, source: { id: "source", name: "Source" }, status: "queued",
    createdAt: 1, canCancel: true, canRetry: false, ...patch,
  };
}
function snapshot(records: TaskRecord[] = [], patch: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    records, pausedSourceIds: [], pausedTaskGroups: [], sourceQueueOrder: [],
    recordLimit: records.length, recordsTruncated: false, sourceQueueLimit: 0,
    sourceQueuesTotal: 0, sourceQueuesTruncated: false, sourceQueuesPaused: false,
    sourceAccessBlocks: [], total: records.length, running: 0, queued: records.length,
    failed: 0, succeeded: 0, cancelled: 0, ...patch,
  };
}

describe("incremental task notifications", () => {
  it("seeds completed standalone work that overlapped the still-active group", () => {
    const tracker = new TaskNotificationTracker(snapshot([
      task("historical", { status: "succeeded", createdAt: 0, finishedAt: 1 }),
      task("completed", { status: "succeeded", createdAt: 1, finishedAt: 3 }),
      task("pending", { createdAt: 2 }),
    ]));
    expect(tracker.groups(t, snapshot())[0]).toMatchObject({
      progress: { current: 1, total: 2 },
    });
  });

  it("retains successful standalone counts until the whole group settles", () => {
    const first = task("first", { status: "running" });
    const second = task("second");
    const tracker = new TaskNotificationTracker(snapshot([first, second]));
    tracker.update({ task: { ...first, status: "succeeded" }, previousStatus: "running" });
    expect(tracker.groups(t, snapshot())[0]).toMatchObject({
      key: "downloads", progress: { current: 1, total: 2 },
      body: 'tasks.notification.downloadTitleProgress:{"current":1,"total":2}',
    });
    expect(tracker.takeCompletions(t)).toEqual([]);
    tracker.update({ task: { ...second, status: "failed" }, previousStatus: "queued" });
    expect(tracker.takeCompletions(t)).toMatchObject([
      { key: "downloads", succeeded: 1, failed: 1, cancelled: 0, total: 2 },
    ]);
    expect(tracker.takeCompletions(t)).toEqual([]);
  });

  it("keeps unmaterialized batch work active between scheduler windows", () => {
    const progress = { current: 0, total: 3, succeeded: 0, failed: 0, cancelled: 0 };
    const child = task("child", { subject: { batchId: "batch" }, status: "running" });
    const tracker = new TaskNotificationTracker(snapshot([child]), [{ batchId: "batch", active: true, progress }]);
    tracker.update({ task: { ...child, status: "failed" }, previousStatus: "running" });
    tracker.updateBatch({ batchId: "batch", active: true, progress: { ...progress, current: 1, failed: 1 } });
    expect(tracker.groups(t, snapshot())[0]).toMatchObject({
      key: "downloads", progress: { current: 1, total: 3 },
    });
    expect(tracker.takeCompletions(t)).toEqual([]);
    tracker.updateBatch({ batchId: "batch", active: false, progress: { ...progress, current: 3, succeeded: 1, failed: 1, cancelled: 1 } });
    expect(tracker.takeCompletions(t)).toMatchObject([
      { key: "downloads", succeeded: 1, failed: 1, cancelled: 1, total: 3 },
    ]);
  });

  it("combines batch outcomes with standalone downloads without counting batch children twice", () => {
    const standalone = task("standalone");
    const batchChild = task("child", { subject: { batchId: "batch" } });
    const tracker = new TaskNotificationTracker(snapshot([standalone, batchChild]), [{
      batchId: "batch", active: true,
      progress: { current: 2, total: 5, succeeded: 1, failed: 1, cancelled: 0 },
    }]);
    tracker.update({ task: { ...standalone, status: "succeeded" }, previousStatus: "queued" });
    const group = tracker.groups(t, snapshot())[0];
    expect(group.progress).toEqual({ current: 3, total: 6 });
    expect(group.body).toBe('tasks.notification.results:{"succeeded":2,"failed":1,"cancelled":0,"total":6}');
  });

  it("reads only changed records after the initial snapshot", () => {
    const running = task("running", { status: "running" });
    const tracker = new TaskNotificationTracker(snapshot([running]));
    const metadata = snapshot();
    Object.defineProperty(metadata, "records", { get: () => { throw new Error("Records were rescanned"); } });
    tracker.update({ task: { ...running, detail: "A chapter" }, previousStatus: "running" });
    expect(tracker.groups(t, metadata)).toHaveLength(1);
    expect(tracker.tray(t, metadata).items).toHaveLength(1);
  });

  it("keeps paused groups visible without producing a completion", () => {
    const tracker = new TaskNotificationTracker(snapshot([task("waiting")]));
    expect(tracker.groups(t, snapshot([], { pausedTaskGroups: ["downloads"] }))[0]).toMatchObject({
      key: "downloads", paused: true, progress: { current: 0, total: 1 },
    });
    expect(tracker.takeCompletions(t)).toEqual([]);
  });

  it("counts metadata child outcomes instead of a successful aggregate wrapper", () => {
    const aggregate = task("aggregate", { lane: "main", kind: "library.refreshMetadata", status: "running", progress: { current: 0, total: 2 } });
    const good = task("good", { kind: "source.refreshNovel" });
    const bad = task("bad", { kind: "source.refreshNovel" });
    const tracker = new TaskNotificationTracker(snapshot([aggregate, good, bad]));
    tracker.update({ task: { ...good, status: "succeeded" }, previousStatus: "queued" });
    tracker.update({ task: { ...bad, status: "failed" }, previousStatus: "queued" });
    expect(tracker.takeCompletions(t)).toEqual([]);
    tracker.update({ task: { ...aggregate, status: "succeeded", progress: { current: 2, total: 2 } }, previousStatus: "running" });
    expect(tracker.takeCompletions(t)).toMatchObject([
      { key: "libraryMetadata", succeeded: 1, failed: 1, cancelled: 0, total: 2 },
    ]);
  });

  it("does not replay historical completions and starts a fresh count for new work", () => {
    const old = task("old", { status: "succeeded" });
    const first = task("first");
    const tracker = new TaskNotificationTracker(snapshot([old, first]));
    tracker.update({ task: { ...first, status: "cancelled" }, previousStatus: "queued" });
    expect(tracker.takeCompletions(t)).toMatchObject([{ succeeded: 0, cancelled: 1, total: 1 }]);
    const next = task("next", { status: "running" });
    tracker.update({ task: next, previousStatus: null });
    tracker.update({ task: { ...next, status: "succeeded" }, previousStatus: "running" });
    expect(tracker.takeCompletions(t)).toMatchObject([{ succeeded: 1, cancelled: 0, total: 1 }]);
  });
});

describe("unknown task totals", () => {
  it("does not turn a partially known group into a misleading percentage", () => {
    expect(sumTaskNotificationProgress([
      task("known", { progress: { current: 1, total: 2 } }),
      task("unknown", { progress: { current: 3 } }),
    ])).toBeUndefined();
  });

  it("does not report zero percent for an undiscovered total", () => {
    expect(buildTaskEventNotificationBody(t, task("unknown", { status: "running", progress: { current: 0, total: 0 } })))
      .toBe("notifications.task.running:{}");
  });
});
