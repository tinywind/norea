import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
const downloadQueue = vi.hoisted(() => ({
  discardQueuedChapterDownloads: vi.fn(),
  waitForChapterDownloadQueueMutations: vi.fn(),
}));
const queries = vi.hoisted(() => ({ listNonLocalDownloadCacheDeleteChapters: vi.fn() }));
const scheduler = vi.hoisted(() => ({
  cancel: vi.fn(),
  getSnapshot: vi.fn(),
  waitForSourceTaskSettlement: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("../../db/queries/chapter", () => ({ getChapterById: vi.fn() }));
vi.mock("../../db/queries/download-cache", () => ({
  listNonLocalDownloadCacheDeleteChapters: queries.listNonLocalDownloadCacheDeleteChapters,
}));
vi.mock("../../db/queries/novel", () => ({ getNovelById: vi.fn() }));
vi.mock("../android-storage", () => ({
  deleteAndroidStoragePath: vi.fn(),
  listAndroidChapterStorageDirs: vi.fn(),
}));
vi.mock("../tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(() => false),
  isTauriRuntime: vi.fn(() => true),
}));
vi.mock("./chapter-download", () => ({
  discardQueuedChapterDownloads: downloadQueue.discardQueuedChapterDownloads,
  waitForChapterDownloadQueueMutations: downloadQueue.waitForChapterDownloadQueueMutations,
}));
vi.mock("./scheduler", () => ({ taskScheduler: scheduler }));

import {
  deleteDownloadCache,
  type DownloadCacheDeleteResult,
  type DownloadCacheDeleteWork,
} from "./download-cache-delete";
import { getChapterById } from "../../db/queries/chapter";
import { getNovelById } from "../../db/queries/novel";
import { deleteAndroidStoragePath, listAndroidChapterStorageDirs } from "../android-storage";
import { isAndroidRuntime } from "../tauri-runtime";
import { clearAuthoritativeStorageDirs, rememberAuthoritativeChapterStorageDir } from "../chapter-storage-resolution";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function createWork(id: string): DownloadCacheDeleteWork {
  return {
    id, scope: "chapter", targetIds: [7], status: "queued",
    total: 1, completed: 0, failed: 0, cancelRequested: false,
  };
}

const deleted: DownloadCacheDeleteResult = {
  workId: "work-1", total: 1, deleted: 1, failed: 0, cancelled: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  clearAuthoritativeStorageDirs();
  queries.listNonLocalDownloadCacheDeleteChapters.mockResolvedValue([{
    id: 7, contentBytes: 128, isDownloaded: true, path: "/chapter/7",
    pluginId: "source-a", sourceContentType: "html",
  }]);
  vi.mocked(getChapterById).mockResolvedValue(null);
  vi.mocked(getNovelById).mockResolvedValue(null);
  vi.mocked(isAndroidRuntime).mockReturnValue(false);
  downloadQueue.waitForChapterDownloadQueueMutations.mockResolvedValue(undefined);
  scheduler.getSnapshot.mockReturnValue({ records: [] });
  scheduler.waitForSourceTaskSettlement.mockResolvedValue(undefined);
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "chapter_download_queue_remove") return;
    if (command === "download_cache_delete_work_enqueue") return createWork("work-1");
    if (command === "download_cache_delete_work_cancel") return;
    if (command === "download_cache_delete_work_run") return deleted;
    throw new Error(`Unexpected invoke command: ${command}`);
  });
});

describe("deleteDownloadCache", () => {
  it("does not run restored deletion work twice while its first execution is active", async () => {
    const finished = deferred<DownloadCacheDeleteResult>();
    const invoke = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "download_cache_delete_work_run") return finished.promise;
      return invoke(...args);
    });
    const options = { existingWork: createWork("work-1"), scope: "chapter" as const, title: "Delete chapter" };
    const first = deleteDownloadCache(options);
    const second = deleteDownloadCache(options);
    await flushMicrotasks();
    try {
      expect(native.invoke.mock.calls.filter(([command]) => command === "download_cache_delete_work_run")).toHaveLength(1);
    } finally {
      finished.resolve(deleted);
      await Promise.all([first, second]);
    }
  });

  it("cancels only target downloads without waiting for network settlement or the download queue", async () => {
    const pending = new Promise<void>(() => {});
    scheduler.getSnapshot.mockReturnValue({ records: [
      { id: "target", kind: "chapter.download", subject: { chapterId: 7 } },
      { id: "other", kind: "chapter.download", subject: { chapterId: 8 } },
    ] });
    scheduler.cancel.mockReturnValue(true);
    scheduler.waitForSourceTaskSettlement.mockReturnValue(pending);
    downloadQueue.waitForChapterDownloadQueueMutations.mockReturnValue(pending);

    await expect(deleteDownloadCache({
      scope: "chapter", targetIds: [7], title: "Delete chapter", workId: "work-1",
    })).resolves.toEqual(deleted);

    expect(scheduler.cancel).toHaveBeenCalledExactlyOnceWith("target");
    expect(downloadQueue.discardQueuedChapterDownloads).toHaveBeenCalledExactlyOnceWith([7]);
    expect(scheduler.waitForSourceTaskSettlement).not.toHaveBeenCalled();
    expect(downloadQueue.waitForChapterDownloadQueueMutations).not.toHaveBeenCalled();
    expect(native.invoke).toHaveBeenCalledWith("chapter_download_queue_remove", { chapterIds: [7] });
    expect(native.invoke).toHaveBeenCalledWith("download_cache_delete_work_run", { workId: "work-1", clearFiles: true });
  });

  it("clears the record for a missing known folder without searching other works", async () => {
    vi.mocked(isAndroidRuntime).mockReturnValue(true);
    const directory = "contents/source/Original-work/1-Opening";
    rememberAuthoritativeChapterStorageDir(7, directory);
    vi.mocked(getChapterById).mockResolvedValue({ id: 7, novelId: 3, name: "Opening", position: 1 } as never);
    vi.mocked(getNovelById).mockResolvedValue({ id: 3, pluginId: "source", path: "/work", name: "Renamed", isLocal: false } as never);
    vi.mocked(deleteAndroidStoragePath).mockResolvedValue(undefined);
    vi.mocked(listAndroidChapterStorageDirs).mockRejectedValue(new Error("Unrelated folder search must not run"));

    await expect(deleteDownloadCache({
      scope: "chapter", targetIds: [7], title: "Delete chapter", workId: "work-1",
    })).resolves.toEqual(deleted);

    expect(listAndroidChapterStorageDirs).not.toHaveBeenCalled();
    expect(deleteAndroidStoragePath).toHaveBeenCalledWith(directory);
    expect(native.invoke).toHaveBeenCalledWith("download_cache_delete_work_run", { workId: "work-1", clearFiles: false });
  });

  it("deletes stored content when its source plugin is unavailable", async () => {
    queries.listNonLocalDownloadCacheDeleteChapters.mockResolvedValue([{
      id: 7, contentBytes: 128, isDownloaded: true, path: "/chapter/7",
      pluginId: "missing-source", sourceContentType: "html",
    }]);
    await expect(deleteDownloadCache({
      scope: "chapter", targetIds: [7], title: "Delete chapter", workId: "work-1",
    })).resolves.toEqual(deleted);
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual([
      "chapter_download_queue_remove", "download_cache_delete_work_enqueue", "download_cache_delete_work_run",
    ]);
  });

  it("preserves native deletion failures", async () => {
    const failure = new Error("Native deletion failed");
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "chapter_download_queue_remove") return;
      if (command === "download_cache_delete_work_enqueue") return createWork("work-1");
      if (command === "download_cache_delete_work_run") throw failure;
      throw new Error(`Unexpected invoke command: ${command}`);
    });
    await expect(deleteDownloadCache({
      scope: "chapter", targetIds: [7], title: "Delete chapter", workId: "work-1",
    })).rejects.toBe(failure);
  });

  it("cancels restored native work when deletion was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(deleteDownloadCache({
      existingWork: createWork("work-1"), scope: "all", title: "Clear downloaded content", signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("download_cache_delete_work_cancel", { workId: "work-1" });
  });

  it("does not create deletion work after cancellation during target queue removal", async () => {
    const removed = deferred<void>();
    native.invoke.mockImplementation((command: string) => {
      if (command === "chapter_download_queue_remove") return removed.promise;
      throw new Error(`Unexpected invoke command: ${command}`);
    });
    const controller = new AbortController();
    const running = deleteDownloadCache({
      scope: "all", title: "Clear downloaded content", workId: "work-1", signal: controller.signal,
    });
    const rejected = expect(running).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks();
    controller.abort();
    removed.resolve();
    await rejected;
    expect(native.invoke).not.toHaveBeenCalledWith("download_cache_delete_work_enqueue", expect.anything());
  });

  it("cancels native work created after the deletion was aborted", async () => {
    const created = deferred<DownloadCacheDeleteWork>();
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "chapter_download_queue_remove") return;
      if (command === "download_cache_delete_work_enqueue") return created.promise;
      if (command === "download_cache_delete_work_cancel") return;
      throw new Error(`Unexpected invoke command: ${command}`);
    });
    const controller = new AbortController();
    const running = deleteDownloadCache({
      scope: "all", title: "Clear downloaded content", workId: "work-1", signal: controller.signal,
    });
    const rejected = expect(running).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks();
    controller.abort();
    created.resolve(createWork("work-1"));
    await rejected;
    expect(native.invoke).toHaveBeenCalledWith("download_cache_delete_work_cancel", { workId: "work-1" });
    expect(native.invoke).not.toHaveBeenCalledWith("download_cache_delete_work_run", expect.anything());
  });

  it("waits for native cancellation before settling an aborted deletion", async () => {
    const run = deferred<DownloadCacheDeleteResult>();
    const started = deferred<void>();
    const cancelled = deferred<void>();
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "chapter_download_queue_remove") return;
      if (command === "download_cache_delete_work_enqueue") return createWork("work-1");
      if (command === "download_cache_delete_work_cancel") return cancelled.promise;
      if (command === "download_cache_delete_work_run") {
        started.resolve();
        return run.promise;
      }
      throw new Error(`Unexpected invoke command: ${command}`);
    });
    const controller = new AbortController();
    const running = deleteDownloadCache({
      scope: "all", title: "Clear downloaded content", workId: "work-1", signal: controller.signal,
    });
    const rejected = expect(running).rejects.toMatchObject({ name: "AbortError" });
    const settled = vi.fn();
    void running.then(settled, settled);
    await started.promise;
    controller.abort();
    run.resolve({ ...deleted, cancelled: true });
    await flushMicrotasks();
    expect(settled).not.toHaveBeenCalled();
    cancelled.resolve();
    await rejected;
    expect(native.invoke).toHaveBeenCalledWith("download_cache_delete_work_cancel", { workId: "work-1" });
  });
});
