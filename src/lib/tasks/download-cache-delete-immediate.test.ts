import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("../../db/queries/chapter", () => ({ getChapterById: vi.fn() }));
vi.mock("../../db/queries/novel", () => ({ getNovelById: vi.fn() }));
vi.mock("../../db/queries/download-cache", () => ({
  listNonLocalDownloadCacheDeleteChapters: vi.fn(async () => [{
    id: 7,
    contentBytes: 128,
    isDownloaded: true,
    path: "/chapter/7",
    pluginId: "source-a",
    sourceContentType: "html",
  }]),
}));
vi.mock("../android-storage", () => ({
  deleteAndroidStoragePath: vi.fn(),
  listAndroidChapterStorageDirs: vi.fn(),
}));
vi.mock("../tauri-runtime", () => ({
  isAndroidRuntime: () => false,
  isTauriRuntime: () => true,
}));
vi.mock("./chapter-download", () => ({
  discardQueuedChapterDownloads: vi.fn(),
  waitForChapterDownloadQueueMutations: vi.fn(async () => undefined),
}));

import { deleteDownloadCache } from "./download-cache-delete";
import { runExclusiveChapterStorageOperation } from "./chapter-storage-operation";
import { withChapterDownloadWrite } from "../chapter-download-writes";
import { taskScheduler } from "./scheduler";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "chapter_download_queue_remove") return;
    if (command === "download_cache_delete_work_enqueue") {
      return {
        id: "delete-7",
        scope: "chapter",
        targetIds: [7],
        status: "queued",
        total: 1,
        completed: 0,
        failed: 0,
        cancelRequested: false,
      };
    }
    if (command === "download_cache_delete_work_run") {
      return { workId: "delete-7", total: 1, deleted: 1, failed: 0, cancelled: false };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
});

it("completes deletion while unrelated main work, downloads, and a storage operation remain pending", async () => {
  const network = deferred();
  const mainWork = deferred();
  const mainStarted = deferred();
  const download = taskScheduler.enqueueSource({
    kind: "chapter.download",
    title: "Unrelated download",
    source: { id: "source-a", name: "Source A" },
    subject: { chapterId: 8 },
    run: () => network.promise,
  });
  await vi.waitFor(() => expect(taskScheduler.getTask(download.id)?.status).toBe("running"));
  const main = taskScheduler.enqueueMain({
    kind: "repository.add",
    title: "Unrelated main work",
    run: () => runExclusiveChapterStorageOperation({ kind: "all" }, undefined, async () => {
      mainStarted.resolve();
      await mainWork.promise;
    }),
  });
  await mainStarted.promise;
  const completed = vi.fn();
  const deletion = deleteDownloadCache({
    scope: "chapter", targetIds: [7], title: "Delete chapter", workId: "delete-7",
  }).then(completed);
  try {
    await vi.waitFor(() => expect(completed).toHaveBeenCalledWith({
      workId: "delete-7", total: 1, deleted: 1, failed: 0, cancelled: false,
    }));
    expect(taskScheduler.getTask(main.id)?.status).toBe("running");
    expect(taskScheduler.getTask(download.id)?.status).toBe("running");
    expect(taskScheduler.getSnapshot().records.filter((task) => task.kind === "maintenance.clearDownloadedContent")).toEqual([]);
  } finally {
    network.resolve();
    mainWork.resolve();
    await Promise.all([main.promise, download.promise, deletion]);
  }
});

it("finishes deletion before the cancelled target network request settles and rejects its late write", async () => {
  const network = deferred();
  const started = deferred();
  const lateWrite = vi.fn(async () => undefined);
  let networkSettled = false;
  const download = taskScheduler.enqueueSource({
    kind: "chapter.download",
    title: "Target download",
    source: { id: "source-a", name: "Source A" },
    subject: { chapterId: 7 },
    run: async ({ signal }) => {
      started.resolve();
      await network.promise;
      networkSettled = true;
      await withChapterDownloadWrite(7, signal, lateWrite);
    },
  });
  const failed = download.promise.catch((error: unknown) => error);
  await started.promise;
  try {
    await expect(deleteDownloadCache({
      scope: "chapter", targetIds: [7], title: "Delete chapter", workId: "delete-7",
    })).resolves.toMatchObject({ deleted: 1 });
    expect(networkSettled).toBe(false);
  } finally {
    network.resolve();
    await taskScheduler.waitForSourceTaskSettlement(download.id);
  }
  expect(await failed).toMatchObject({ name: "AbortError" });
  expect(lateWrite).not.toHaveBeenCalled();
});

it("waits only for a target local write already in progress before deleting its files", async () => {
  const targetWrite = deferred();
  const otherWrite = deferred();
  const started = deferred();
  const events: string[] = [];
  const unrelated = withChapterDownloadWrite(8, undefined, () => otherWrite.promise);
  const download = taskScheduler.enqueueSource({
    kind: "chapter.download",
    title: "Target download",
    source: { id: "source-a", name: "Source A" },
    subject: { chapterId: 7 },
    run: ({ signal }) => withChapterDownloadWrite(7, signal, async () => {
      started.resolve();
      await targetWrite.promise;
      events.push("write");
    }),
  });
  const failed = download.promise.catch((error: unknown) => error);
  await started.promise;
  const invoke = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (...args: unknown[]) => {
    if (args[0] === "download_cache_delete_work_run") events.push("delete");
    return invoke(...args);
  });
  const completed = vi.fn();
  const deletion = deleteDownloadCache({
    scope: "chapter", targetIds: [7], title: "Delete chapter", workId: "delete-7",
  }).then(completed);
  try {
    await vi.waitFor(() => expect(taskScheduler.getTask(download.id)?.status).toBe("cancelled"));
    expect(completed).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    targetWrite.resolve();
    await deletion;
    expect(events).toEqual(["write", "delete"]);
    expect(completed).toHaveBeenCalledOnce();
  } finally {
    targetWrite.resolve();
    otherWrite.resolve();
    await Promise.all([deletion, failed, unrelated]);
  }
});

it("starts a newly requested local write only after the target deletion finishes", async () => {
  const removing = deferred();
  const started = deferred();
  const invoke = native.invoke.getMockImplementation()!;
  const events: string[] = [];
  native.invoke.mockImplementation(async (...args: unknown[]) => {
    if (args[0] === "download_cache_delete_work_run") {
      started.resolve();
      await removing.promise;
      events.push("delete");
    }
    return invoke(...args);
  });
  const deletion = deleteDownloadCache({
    scope: "chapter", targetIds: [7], title: "Delete chapter", workId: "delete-7",
  });
  await started.promise;
  const write = withChapterDownloadWrite(7, new AbortController().signal, async () => { events.push("new write"); });
  try {
    await withChapterDownloadWrite(8, undefined, async () => { events.push("unrelated write"); });
    expect(events).toEqual(["unrelated write"]);
  } finally {
    removing.resolve();
    await Promise.all([deletion, write]);
  }
  expect(events).toEqual(["unrelated write", "delete", "new write"]);
});
