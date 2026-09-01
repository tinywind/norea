import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MainTaskSpec, TaskRunContext } from "./scheduler";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

const downloadQueueMocks = vi.hoisted(() => ({
  waitForChapterDownloadQueueMutations: vi.fn(),
}));

const queryMocks = vi.hoisted(() => ({
  listNonLocalDownloadCacheDeleteChapters: vi.fn(),
}));

const schedulerMocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  enqueueMain: vi.fn(),
  getSnapshot: vi.fn(),
  waitForSourceTaskSettlement: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: tauriMocks.listen,
}));
vi.mock("../../db/queries/chapter", () => ({
  getChapterById: vi.fn(),
}));
vi.mock("../../db/queries/download-cache", () => ({
  listNonLocalDownloadCacheDeleteChapters:
    queryMocks.listNonLocalDownloadCacheDeleteChapters,
}));
vi.mock("../../db/queries/novel", () => ({
  getNovelById: vi.fn(),
}));
vi.mock("../android-storage", () => ({
  deleteAndroidStoragePath: vi.fn(),
  listAndroidChapterStorageDirs: vi.fn(),
}));
vi.mock("../tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(() => false),
  isTauriRuntime: vi.fn(() => true),
}));
vi.mock("./chapter-download", () => ({
  waitForChapterDownloadQueueMutations:
    downloadQueueMocks.waitForChapterDownloadQueueMutations,
}));
vi.mock("./scheduler", () => ({
  taskScheduler: schedulerMocks,
}));

import {
  enqueueDownloadCacheDelete,
  type DownloadCacheDeleteResult,
  type DownloadCacheDeleteWork,
} from "./download-cache-delete";
import { getChapterById } from "../../db/queries/chapter";
import { getNovelById } from "../../db/queries/novel";
import { runExclusiveChapterStorageOperation } from "./chapter-storage-operation";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function flushMicrotasks(count = 20): Promise<void> {
  return Array.from({ length: count }).reduce<Promise<void>>(
    (pending) => pending.then(() => Promise.resolve()),
    Promise.resolve(),
  );
}

function createWork(id: string): DownloadCacheDeleteWork {
  return {
    id,
    scope: "all",
    targetIds: [],
    status: "queued",
    total: 0,
    completed: 0,
    failed: 0,
    cancelRequested: false,
  };
}

function createContext(controller: AbortController): TaskRunContext {
  return {
    signal: controller.signal,
    taskId: "task-1",
    setDetail: vi.fn(),
    setProgress: vi.fn(),
  };
}

let capturedSpec: MainTaskSpec<DownloadCacheDeleteResult> | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  capturedSpec = null;
  queryMocks.listNonLocalDownloadCacheDeleteChapters.mockResolvedValue([]);
  vi.mocked(getChapterById).mockResolvedValue(null);
  vi.mocked(getNovelById).mockResolvedValue(null);
  downloadQueueMocks.waitForChapterDownloadQueueMutations.mockResolvedValue(
    undefined,
  );
  schedulerMocks.getSnapshot.mockReturnValue({ records: [] });
  schedulerMocks.waitForSourceTaskSettlement.mockResolvedValue(undefined);
  schedulerMocks.enqueueMain.mockImplementation(
    (spec: MainTaskSpec<DownloadCacheDeleteResult>) => {
      capturedSpec = spec;
      return { id: "task-1", promise: new Promise(() => {}) };
    },
  );
  tauriMocks.listen.mockResolvedValue(vi.fn());
  tauriMocks.invoke.mockImplementation((command: string) => {
    if (command === "chapter_download_queue_remove") {
      return Promise.resolve(undefined);
    }
    if (command === "download_cache_delete_work_enqueue") {
      return Promise.resolve(createWork("work-1"));
    }
    if (command === "download_cache_delete_work_cancel") {
      return Promise.resolve(undefined);
    }
    if (command === "download_cache_delete_work_run") {
      return Promise.resolve({
        workId: "work-1",
        total: 0,
        deleted: 0,
        failed: 0,
        cancelled: false,
      });
    }
    return Promise.reject(new Error(`Unexpected invoke command: ${command}`));
  });
});

describe("enqueueDownloadCacheDelete", () => {
  it("deletes local chapter artifacts without mutating WebView cache state", async () => {
    const events: string[] = [];
    const chapterCandidate = {
      id: 7,
      contentBytes: 256,
      isDownloaded: false,
      path: "/chapter/7",
      pluginId: "source-a",
      sourceContentType: "html",
    };
    queryMocks.listNonLocalDownloadCacheDeleteChapters.mockResolvedValue([
      chapterCandidate,
      {
        contentBytes: 0,
        id: 8,
        isDownloaded: false,
        path: "/chapter/8",
        pluginId: "source-a",
        sourceContentType: "html",
      },
    ]);
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "chapter_download_queue_remove") {
        return Promise.resolve(undefined);
      }
      if (command === "download_cache_delete_work_enqueue") {
        events.push("enqueue");
        return Promise.resolve({
          ...createWork("work-1"),
          scope: "novel",
          targetIds: [3],
          total: 2,
        });
      }
      if (command === "download_cache_delete_work_run") {
        events.push("run");
        return Promise.resolve({
          workId: "work-1",
          total: 2,
          deleted: 2,
          failed: 0,
          cancelled: false,
        });
      }
      return Promise.reject(new Error(`Unexpected invoke command: ${command}`));
    });
    enqueueDownloadCacheDelete({
      scope: "novel",
      targetIds: [3],
      title: "Delete chapter",
      workId: "work-1",
    });
    if (!capturedSpec) throw new Error("Task spec was not captured.");

    await capturedSpec.run(createContext(new AbortController()));

    expect(events).toEqual(["enqueue", "run"]);
  });

  it("continues deletion when source metadata is unavailable", async () => {
    queryMocks.listNonLocalDownloadCacheDeleteChapters.mockResolvedValue([
      {
        contentBytes: 0,
        id: 7,
        isDownloaded: true,
        path: "/chapter/7",
        pluginId: "missing-source",
        sourceContentType: "html",
      },
    ]);
    enqueueDownloadCacheDelete({
      scope: "chapter",
      targetIds: [7],
      title: "Delete chapter",
      workId: "work-1",
    });
    if (!capturedSpec) throw new Error("Task spec was not captured.");

    await expect(
      capturedSpec.run(createContext(new AbortController())),
    ).resolves.toMatchObject({ cancelled: false });
    expect(tauriMocks.invoke).toHaveBeenCalledWith(
      "download_cache_delete_work_run",
      expect.objectContaining({ workId: "work-1" }),
    );
  });

  it("preserves native deletion failures", async () => {
    const deletionError = new Error("native deletion failed");
    queryMocks.listNonLocalDownloadCacheDeleteChapters.mockResolvedValue([
      {
        contentBytes: 0,
        id: 7,
        isDownloaded: true,
        path: "/chapter/7",
        pluginId: "source-a",
        sourceContentType: "html",
      },
    ]);
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "chapter_download_queue_remove") {
        return Promise.resolve(undefined);
      }
      if (command === "download_cache_delete_work_enqueue") {
        return Promise.resolve(createWork("work-1"));
      }
      if (command === "download_cache_delete_work_run") {
        return Promise.reject(deletionError);
      }
      return Promise.reject(new Error(`Unexpected invoke command: ${command}`));
    });

    enqueueDownloadCacheDelete({
      scope: "chapter",
      targetIds: [7],
      title: "Delete chapter",
      workId: "work-1",
    });
    if (!capturedSpec) throw new Error("Task spec was not captured.");

    const result = capturedSpec.run(createContext(new AbortController()));
    await expect(result).rejects.toBe(deletionError);
  });

  it("cancels restored native work while waiting for the storage gate", async () => {
    const storageOperationStarted = deferred<void>();
    const releaseStorageOperation = deferred<void>();
    const storageOperation = runExclusiveChapterStorageOperation(
      { kind: "all" },
      undefined,
      async () => {
        storageOperationStarted.resolve();
        await releaseStorageOperation.promise;
      },
    );
    await storageOperationStarted.promise;
    const controller = new AbortController();

    enqueueDownloadCacheDelete({
      existingWork: createWork("work-1"),
      scope: "all",
      title: "Clear downloaded content",
    });
    if (!capturedSpec) throw new Error("Task spec was not captured.");
    const running = capturedSpec.run(createContext(controller));
    const rejected = expect(running).rejects.toMatchObject({
      name: "AbortError",
    });
    await flushMicrotasks();

    controller.abort(new DOMException("Task was cancelled.", "AbortError"));

    await rejected;
    releaseStorageOperation.resolve();
    await storageOperation;
    expect(tauriMocks.invoke).toHaveBeenCalledWith(
      "download_cache_delete_work_cancel",
      { workId: "work-1" },
    );
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith(
      "download_cache_delete_work_run",
      expect.anything(),
    );
  });

  it("does not enqueue native deletion after cancellation while downloads settle", async () => {
    const downloadsSettled = deferred<void>();
    downloadQueueMocks.waitForChapterDownloadQueueMutations.mockImplementationOnce(
      () => downloadsSettled.promise,
    );
    const controller = new AbortController();

    enqueueDownloadCacheDelete({
      scope: "all",
      title: "Clear downloaded content",
      workId: "work-1",
    });
    if (!capturedSpec) throw new Error("Task spec was not captured.");
    const running = capturedSpec.run(createContext(controller));
    const rejected = expect(running).rejects.toMatchObject({
      name: "AbortError",
    });
    await flushMicrotasks();

    controller.abort(new DOMException("Task was cancelled.", "AbortError"));
    downloadsSettled.resolve();

    await rejected;
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith(
      "download_cache_delete_work_enqueue",
      expect.anything(),
    );
  });

  it("cancels native deletion when cancellation occurs while work is enqueued", async () => {
    const workEnqueued = deferred<DownloadCacheDeleteWork>();
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "download_cache_delete_work_enqueue") {
        return workEnqueued.promise;
      }
      if (command === "download_cache_delete_work_cancel") {
        return Promise.resolve(undefined);
      }
      if (command === "download_cache_delete_work_run") {
        return Promise.resolve({
          workId: "work-1",
          total: 0,
          deleted: 0,
          failed: 0,
          cancelled: false,
        });
      }
      return Promise.reject(new Error(`Unexpected invoke command: ${command}`));
    });
    const controller = new AbortController();

    enqueueDownloadCacheDelete({
      scope: "all",
      title: "Clear downloaded content",
      workId: "work-1",
    });
    if (!capturedSpec) throw new Error("Task spec was not captured.");
    const running = capturedSpec.run(createContext(controller));
    const rejected = expect(running).rejects.toMatchObject({
      name: "AbortError",
    });
    await flushMicrotasks();

    controller.abort(new DOMException("Task was cancelled.", "AbortError"));
    workEnqueued.resolve(createWork("work-1"));

    await rejected;
    expect(tauriMocks.invoke).toHaveBeenCalledWith(
      "download_cache_delete_work_cancel",
      { workId: "work-1" },
    );
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith(
      "download_cache_delete_work_run",
      expect.anything(),
    );
  });

  it("waits for native cancellation before releasing a running deletion", async () => {
    const nativeRun = deferred<DownloadCacheDeleteResult>();
    const nativeRunStarted = deferred<void>();
    const nativeCancellation = deferred<void>();
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "download_cache_delete_work_enqueue") {
        return Promise.resolve(createWork("work-1"));
      }
      if (command === "download_cache_delete_work_cancel") {
        return nativeCancellation.promise;
      }
      if (command === "download_cache_delete_work_run") {
        nativeRunStarted.resolve();
        return nativeRun.promise;
      }
      return Promise.reject(new Error(`Unexpected invoke command: ${command}`));
    });
    const controller = new AbortController();

    enqueueDownloadCacheDelete({
      scope: "all",
      title: "Clear downloaded content",
      workId: "work-1",
    });
    if (!capturedSpec) throw new Error("Task spec was not captured.");
    const running = capturedSpec.run(createContext(controller));
    const rejected = expect(running).rejects.toMatchObject({
      name: "AbortError",
    });
    let settled = false;
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await nativeRunStarted.promise;

    controller.abort(new DOMException("Task was cancelled.", "AbortError"));
    nativeRun.resolve({
      workId: "work-1",
      total: 0,
      deleted: 0,
      failed: 0,
      cancelled: true,
    });
    await flushMicrotasks();

    expect(settled).toBe(false);
    nativeCancellation.resolve();
    await rejected;
    expect(tauriMocks.invoke).toHaveBeenCalledWith(
      "download_cache_delete_work_cancel",
      { workId: "work-1" },
    );
  });
});
