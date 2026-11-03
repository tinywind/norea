import { beforeEach, expect, it, vi } from "vitest";
import type { ChapterDownloadBatchHandle, ChapterDownloadBatchJob, ChapterDownloadBatchResult } from "./chapter-download";

const backend = vi.hoisted(() => ({
  enqueue: vi.fn<(batch: ChapterDownloadBatchJob) => ChapterDownloadBatchHandle>(),
  cancel: vi.fn<(ids: Iterable<string>) => void>(),
}));
vi.mock("./chapter-download", () => ({
  enqueueChapterDownloadBatch: backend.enqueue,
  cancelChapterDownloadBatches: backend.cancel,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const batch: ChapterDownloadBatchJob = {
  title: "Requested chapters", total: 1,
  jobs: [{ id: 7, novelId: 2, pluginId: "source", chapterPath: "/chapter-7", title: "Chapter 7" }],
};

function childBatch() {
  const materialized = deferred<void>();
  const completed = deferred<ChapterDownloadBatchResult>();
  const handle = { id: "child-batch", materialized: materialized.promise, promise: materialized.promise.then(() => completed.promise) };
  backend.enqueue.mockReturnValue(handle);
  return { handle, materialized, completed };
}

beforeEach(() => {
  vi.resetModules();
  backend.enqueue.mockReset();
  backend.cancel.mockReset();
});

it("settles an empty prepared selection without starting a source or VPN batch", async () => {
  const requests = await import("./chapter-download-requests");
  const handle = requests.submitChapterDownloadRequest({ key: "empty", title: "No missing chapters", novelIds: [2], prepare: async () => ({ title: "No missing chapters", jobs: [], total: 0 }) });
  expect(await handle.promise).toEqual({ total: 0, succeeded: 0, failed: 0, cancelled: 0 });
  await handle.materialized;
  expect(requests.getChapterDownloadRequestSnapshot()).toEqual([]);
  expect(backend.enqueue).not.toHaveBeenCalled();
});

it("publishes preparing intent before a held catalog and hides it only after queue materialization", async () => {
  const requests = await import("./chapter-download-requests");
  const preparation = deferred<ChapterDownloadBatchJob>();
  const child = childBatch();
  const states: string[][] = [];
  const unsubscribe = requests.subscribeChapterDownloadRequests(() => {
    states.push(requests.getChapterDownloadRequestSnapshot().map(row => row.phase));
  });
  const handle = requests.submitChapterDownloadRequest({ key: "work-2:all", title: "Work 2", novelIds: [2], prepare: () => preparation.promise });
  expect(requests.getChapterDownloadRequestSnapshot()).toEqual([
    { id: handle.id, title: "Work 2", novelIds: [2], total: null, phase: "preparing", error: null },
  ]);
  expect(requests.getChapterDownloadRequestSnapshot()).toBe(requests.getChapterDownloadRequestSnapshot());
  expect(backend.enqueue).not.toHaveBeenCalled();
  preparation.resolve(batch);
  await vi.waitFor(() => expect(requests.getChapterDownloadRequestSnapshot()).toMatchObject([{ phase: "publishing", total: 1 }]));
  child.materialized.resolve();
  await handle.materialized;
  expect(requests.getChapterDownloadRequestSnapshot()).toEqual([]);
  child.completed.resolve({ total: 1, succeeded: 1, failed: 0, cancelled: 0 });
  expect(await handle.promise).toEqual({ total: 1, succeeded: 1, failed: 0, cancelled: 0 });
  expect(states).toEqual([["preparing"], ["publishing"], []]);
  unsubscribe();
});

it("coalesces the same pending intent while preserving different requested work", async () => {
  const requests = await import("./chapter-download-requests");
  const preparation = deferred<ChapterDownloadBatchJob>();
  const child = childBatch();
  const first = requests.submitChapterDownloadRequest({ key: "work-2:all", title: "Work 2", novelIds: [2], total: 1, prepare: () => preparation.promise });
  const duplicate = requests.submitChapterDownloadRequest({ key: "work-2:all", title: "Work 2", novelIds: [2], total: 1, prepare: () => preparation.promise });
  const otherPreparation = deferred<ChapterDownloadBatchJob>();
  const other = requests.submitChapterDownloadRequest({ key: "work-3:all", title: "Work 3", novelIds: [3], prepare: () => otherPreparation.promise });
  expect(duplicate).toBe(first);
  expect(requests.getChapterDownloadRequestSnapshot().map(row => row.novelIds)).toEqual([[2], [3]]);
  const cancelled = expect(other.promise).rejects.toMatchObject({ name: "AbortError" });
  requests.cancelChapterDownloadRequest(other.id);
  await cancelled;
  preparation.resolve(batch);
  child.materialized.resolve();
  await first.materialized;
  expect(backend.enqueue).toHaveBeenCalledExactlyOnceWith(batch);
  child.completed.resolve({ total: 1, succeeded: 1, failed: 0, cancelled: 0 });
  await first.promise;
});

it("cancels a held preparation immediately and cannot enqueue its late result", async () => {
  const requests = await import("./chapter-download-requests");
  const preparation = deferred<ChapterDownloadBatchJob>();
  let signal!: AbortSignal;
  const handle = requests.submitChapterDownloadRequest({ key: "cancelled", title: "Work 2", novelIds: [2], prepare: value => { signal = value; return preparation.promise; } });
  const completed = expect(handle.promise).rejects.toMatchObject({ name: "AbortError" });
  const materialized = expect(handle.materialized).rejects.toMatchObject({ name: "AbortError" });
  requests.cancelChapterDownloadRequest(handle.id);
  await Promise.all([completed, materialized]);
  expect(signal.aborted).toBe(true);
  expect(requests.getChapterDownloadRequestSnapshot()).toEqual([]);
  preparation.resolve(batch);
  await Promise.resolve();
  await Promise.resolve();
  expect(backend.enqueue).not.toHaveBeenCalled();
});

it("cancels exactly its child batch after preparation without leaving a failure row", async () => {
  const requests = await import("./chapter-download-requests");
  const child = childBatch();
  const handle = requests.submitChapterDownloadRequest({ key: "child", title: "Work 2", novelIds: [2], prepare: async () => batch });
  await vi.waitFor(() => expect(requests.getChapterDownloadRequestSnapshot()).toMatchObject([{ phase: "publishing" }]));
  const cancelled = expect(handle.promise).rejects.toMatchObject({ name: "AbortError" });
  requests.cancelChapterDownloadRequest(handle.id);
  await cancelled;
  expect(backend.cancel.mock.calls.map(([ids]) => [...ids])).toEqual([["child-batch"]]);
  expect(requests.getChapterDownloadRequestSnapshot()).toEqual([]);
  child.materialized.resolve();
  child.completed.resolve({ total: 1, succeeded: 0, failed: 0, cancelled: 1 });
});

it("retains an actionable preparation failure and permits a fresh retry of that intent", async () => {
  const requests = await import("./chapter-download-requests");
  const failure = new Error("Catalog could not be read");
  const first = requests.submitChapterDownloadRequest({ key: "retry", title: "Work 2", novelIds: [2], prepare: async () => { throw failure; } });
  await expect(first.promise).rejects.toBe(failure);
  expect(requests.getChapterDownloadRequestSnapshot()).toMatchObject([{ phase: "failed", error: "Catalog could not be read" }]);
  const child = childBatch();
  const next = requests.submitChapterDownloadRequest({ key: "retry", title: "Work 2", novelIds: [2], prepare: async () => batch });
  expect(next.id).not.toBe(first.id);
  requests.cancelChapterDownloadRequest(first.id);
  child.materialized.resolve();
  child.completed.resolve({ total: 1, succeeded: 1, failed: 0, cancelled: 0 });
  await next.promise;
  expect(requests.getChapterDownloadRequestSnapshot()).toEqual([]);
});

it("does not announce a queued request when child queue publication fails", async () => {
  const requests = await import("./chapter-download-requests");
  const child = childBatch();
  const handle = requests.submitChapterDownloadRequest({ key: "persist", title: "Work 2", novelIds: [2], prepare: async () => batch });
  await vi.waitFor(() => expect(requests.getChapterDownloadRequestSnapshot()).toMatchObject([{ phase: "publishing" }]));
  const failure = new Error("Queue publication failed");
  const completed = expect(handle.promise).rejects.toBe(failure);
  const materialized = expect(handle.materialized).rejects.toBe(failure);
  child.materialized.reject(failure);
  await Promise.all([completed, materialized]);
  expect(requests.getChapterDownloadRequestSnapshot()).toMatchObject([{ phase: "failed", error: "Queue publication failed" }]);
  requests.cancelChapterDownloadRequest(handle.id);
});
