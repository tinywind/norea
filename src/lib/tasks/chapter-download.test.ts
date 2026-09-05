import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceTaskSpec } from "./scheduler";

const schedulerMocks = vi.hoisted(() => ({
  batch: vi.fn((run: () => void) => run()),
  enqueueSource: vi.fn(),
}));

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

const pluginMocks = vi.hoisted(() => ({
  getPlugin: vi.fn(),
  getPluginForExecutor: vi.fn(),
  loadInstalledFromDb: vi.fn(),
  getChapterAcquisitionPlan: vi.fn(),
  getChapterResource: vi.fn(),
}));

const acquisitionMocks = vi.hoisted(() => ({
  captureChapterPage: vi.fn(),
  validateChapterAcquisitionPlan: vi.fn((plan: unknown) => plan),
}));

const epubMocks = vi.hoisted(() => ({
  convertEpubToHtml: vi.fn(),
  mergeEpubHtmlSections: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
}));
vi.mock("../../db/queries/chapter", () => ({
  getChapterById: vi.fn(),
}));
vi.mock("../../db/queries/novel", () => ({
  getNovelById: vi.fn(),
}));
vi.mock("../../store/browse", () => ({
  useBrowseStore: {
    getState: vi.fn(() => ({ chapterDownloadCooldownSeconds: 0 })),
  },
}));
vi.mock("../chapter-media", () => ({
  cacheHtmlChapterMedia: vi.fn(),
  clearChapterMedia: vi.fn(),
  getStoredChapterMediaBytes: vi.fn(),
  hasRemoteChapterMedia: vi.fn(),
  isChapterMediaFinalizationError: vi.fn(
    (value: unknown) =>
      value !== null &&
      typeof value === "object" &&
      (value as { code?: unknown }).code ===
        "chapter-media-finalization-failed",
  ),
  localChapterMediaSources: vi.fn(),
  protectRemoteChapterMediaForPartialHtml: vi.fn((html: string) => html),
  restoreProtectedRemoteChapterMediaSources: vi.fn((html: string) => html),
  storeEmbeddedChapterMedia: vi.fn(),
}));
vi.mock("../chapter-content-storage", () => ({
  readStoredChapterContentMirror: vi.fn(),
  readStoredChapterPartialContentMirror: vi.fn(),
  reconcileStoredChapterContent: vi.fn(),
  saveStoredChapterContent: vi.fn(),
  saveStoredChapterPartialContent: vi.fn(),
}));
vi.mock("../epub-html", () => ({
  convertEpubToHtml: epubMocks.convertEpubToHtml,
  mergeEpubHtmlSections: epubMocks.mergeEpubHtmlSections,
}));
vi.mock("../plugins/manager", () => ({
  pluginManager: {
    getPlugin: pluginMocks.getPlugin,
    getPluginForExecutor: pluginMocks.getPluginForExecutor,
    loadInstalledFromDb: pluginMocks.loadInstalledFromDb,
  },
}));
vi.mock("../plugins/chapter-acquisition", () => acquisitionMocks);
vi.mock("../tauri-runtime", () => ({
  isTauriRuntime: vi.fn(() => false),
}));
vi.mock("./scheduler", () => ({
  sourceBaseDomainKey: vi.fn((baseUrl?: string) =>
    baseUrl ? "source.test" : null,
  ),
  TASK_PAUSE_ABORT_MESSAGE: "Task was paused.",
  taskScheduler: {
    batch: schedulerMocks.batch,
    enqueueSource: schedulerMocks.enqueueSource,
    getSnapshot: vi.fn(() => ({ records: [] })),
    getTaskByDedupeKey: vi.fn(),
    subscribeEvents: vi.fn(),
  },
}));

import { getChapterById } from "../../db/queries/chapter";
import { getNovelById } from "../../db/queries/novel";
import {
  cacheHtmlChapterMedia,
  clearChapterMedia,
  getStoredChapterMediaBytes,
  hasRemoteChapterMedia,
  localChapterMediaSources,
  storeEmbeddedChapterMedia,
} from "../chapter-media";
import {
  readStoredChapterContentMirror,
  readStoredChapterPartialContentMirror,
  reconcileStoredChapterContent,
  saveStoredChapterContent,
  saveStoredChapterPartialContent,
} from "../chapter-content-storage";
import { convertEpubToHtml, mergeEpubHtmlSections } from "../epub-html";
import { SourceAccessRequiredError } from "../plugins/source-access";
import { isTauriRuntime } from "../tauri-runtime";
import { runExclusiveChapterStorageOperation } from "./chapter-storage-operation";
import {
  cancelChapterDownloadBatches,
  enqueueChapterDownloadBatch,
  enqueueChapterDownload,
  enqueueChapterMediaRepair,
  getActiveChapterDownloadBatchProgress,
  startChapterDownloadQueueExecutor,
  subscribeChapterDownloadBatchesSettled,
  type ChapterDownloadJob,
} from "./chapter-download";

let capturedSpec: SourceTaskSpec<void> | null = null;
const backendQueueValues = new Map<number, unknown>();

interface Deferred<T> {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
}

function createDeferred<T>(): Deferred<T> {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(count = 20): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function contentResource(
  content: string,
  contentType: "html" | "text" | "markdown" = "html",
) {
  return { type: "content" as const, contentType, content };
}

function installBrowserHarness(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: vi.fn(),
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      addEventListener: vi.fn(),
      visibilityState: "visible",
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  backendQueueValues.clear();
  installBrowserHarness();
  capturedSpec = null;
  vi.mocked(isTauriRuntime).mockReturnValue(false);
  schedulerMocks.enqueueSource.mockImplementation(
    (spec: SourceTaskSpec<void>) => {
      capturedSpec = spec;
      return { id: "task-1", promise: new Promise<void>(() => {}) };
    },
  );
  tauriMocks.invoke.mockImplementation(
    (command: string, args?: Record<string, unknown>) => {
      if (command === "chapter_download_queue_enqueue") {
        const jobs = Array.isArray(args?.jobs) ? args.jobs : [];
        for (const job of jobs) {
          if (
            job !== null &&
            typeof job === "object" &&
            typeof (job as { id?: unknown }).id === "number"
          ) {
            backendQueueValues.set((job as { id: number }).id, job);
          }
        }
        return Promise.resolve(undefined);
      }
      if (command === "chapter_download_queue_remove") {
        const chapterIds = Array.isArray(args?.chapterIds)
          ? args.chapterIds
          : [];
        for (const chapterId of chapterIds) {
          if (typeof chapterId === "number") {
            backendQueueValues.delete(chapterId);
          }
        }
        return Promise.resolve(undefined);
      }
      if (command === "chapter_download_queue_lease") {
        const values = [...backendQueueValues.values()];
        if (typeof args?.limit !== "number") return Promise.resolve(values);
        return Promise.resolve(values.slice(0, args.limit));
      }
      return Promise.reject(new Error(`unexpected invoke: ${command}`));
    },
  );
  const plugin = {
    apiVersion: "0.2",
    id: "source-a",
    imageRequestInit: { headers: { Referer: "https://source.test/" } },
    name: "Source A",
    getBaseUrl: () => "https://source.test",
    getChapterAcquisitionPlan: pluginMocks.getChapterAcquisitionPlan,
    getChapterResource: pluginMocks.getChapterResource,
  };
  pluginMocks.getPlugin.mockReturnValue(plugin);
  pluginMocks.getPluginForExecutor.mockReturnValue(plugin);
  pluginMocks.getChapterAcquisitionPlan.mockReturnValue({ type: "resource" });
  pluginMocks.getChapterResource.mockResolvedValue({
    type: "content",
    contentType: "text",
    content: `plain <chapter>`,
  });
  acquisitionMocks.captureChapterPage.mockResolvedValue({
    baseUrl: "https://source.test/chapter/7",
    content: `<img src="https://cdn.test/page.png?accessKey=signed">`,
  });
  vi.mocked(cacheHtmlChapterMedia).mockResolvedValue({
    html: "<img>",
    mediaFailures: [],
    mediaBytes: 3,
    storedMediaCount: 1,
  });
  vi.mocked(getChapterById).mockResolvedValue({
    contentType: "text",
    sourceContentType: "text",
    id: 7,
  } as never);
  vi.mocked(getNovelById).mockResolvedValue(null);
  vi.mocked(getStoredChapterMediaBytes).mockResolvedValue(3);
  vi.mocked(hasRemoteChapterMedia).mockReturnValue(true);
  vi.mocked(localChapterMediaSources).mockReturnValue([]);
  vi.mocked(readStoredChapterContentMirror).mockResolvedValue(null);
  vi.mocked(readStoredChapterPartialContentMirror).mockResolvedValue(null);
  vi.mocked(reconcileStoredChapterContent).mockResolvedValue({
    status: "missing",
    contentFile: null,
    contentBytes: 0,
    mediaBytes: 0,
  });
  vi.mocked(saveStoredChapterContent).mockResolvedValue({ rowsAffected: 1 });
  vi.mocked(saveStoredChapterPartialContent).mockResolvedValue({ rowsAffected: 1 });
  vi.mocked(convertEpubToHtml).mockResolvedValue({
    sections: [],
    title: "EPUB",
  });
  vi.mocked(mergeEpubHtmlSections).mockReturnValue(
    `<article class="reader-epub-content" data-epub-rendered="true"></article>`,
  );
  vi.mocked(storeEmbeddedChapterMedia).mockResolvedValue({
    html: `<article class="reader-epub-content" data-epub-rendered="true"></article>`,
    mediaBytes: 0,
    storedMediaCount: 0,
  });
});

describe("enqueueChapterDownloadBatch", () => {
  it("notifies listeners once after a batch settles", async () => {
    schedulerMocks.enqueueSource.mockImplementation(() => ({
      id: "task-1",
      promise: Promise.resolve(),
    }));
    const listener = vi.fn();
    const unsubscribe = subscribeChapterDownloadBatchesSettled(listener);

    const handle = enqueueChapterDownloadBatch({
      jobs: [
        {
          id: 1,
          pluginId: "source-a",
          chapterPath: "/chapter/1",
          title: "Chapter 1",
        },
      ],
      title: "Download chapter",
      total: 1,
    });

    await handle.promise;
    unsubscribe();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(handle.id);
  });

  it("limits generator materialization to the bounded scheduler window", async () => {
    const deferreds: Deferred<void>[] = [];
    schedulerMocks.enqueueSource.mockImplementation(
      (spec: SourceTaskSpec<void>) => {
        capturedSpec = spec;
        const deferred = createDeferred<void>();
        deferreds.push(deferred);
        return {
          id: `task-${deferreds.length}`,
          promise: deferred.promise,
        };
      },
    );
    let yielded = 0;
    function* jobs(): Iterable<ChapterDownloadJob> {
      for (let id = 1; id <= 64; id += 1) {
        yielded += 1;
        yield {
          id,
          pluginId: "source-a",
          chapterPath: `/chapter/${id}`,
          title: `Chapter ${id}`,
        };
      }
    }

    const handle = enqueueChapterDownloadBatch({
      jobs: jobs(),
      persist: false,
      title: "Download 64 chapters",
      total: 64,
    });

    expect(yielded).toBe(16);
    await flushMicrotasks();

    expect(schedulerMocks.batch).toHaveBeenCalled();
    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(16);
    expect(capturedSpec?.subject?.batchTitle).toBe("Download 64 chapters");

    expect(cancelChapterDownloadBatches([capturedSpec!.subject!.batchId!])).toBe(
      1,
    );
    for (const deferred of deferreds) {
      deferred.reject(new DOMException("Task was cancelled.", "AbortError"));
    }

    await expect(handle.promise).resolves.toEqual({
      cancelled: 64,
      failed: 0,
      succeeded: 0,
      total: 64,
    });
    expect(yielded).toBe(16);
  });

  it("queues every array batch job before requested scheduler materialization", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const deferreds: Deferred<void>[] = [];
    schedulerMocks.enqueueSource.mockImplementation(
      (spec: SourceTaskSpec<void>) => {
        capturedSpec = spec;
        const deferred = createDeferred<void>();
        deferreds.push(deferred);
        return {
          id: `task-${deferreds.length}`,
          promise: deferred.promise,
        };
      },
    );
    const jobs = [1, 2, 3, 4].map((id) => ({
      id,
      pluginId: "source-a",
      chapterPath: `/chapter/${id}`,
      title: `Chapter ${id}`,
    }));

    const handle = enqueueChapterDownloadBatch({
      jobs,
      title: "Download 4 chapters",
      total: 4,
      windowSize: 2,
    });
    void handle.promise.catch(() => undefined);

    await flushMicrotasks();

    expect([...backendQueueValues.keys()]).toEqual([1, 2, 3, 4]);
    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(2);
    expect(capturedSpec?.subject?.batchTitle).toBe("Download 4 chapters");
  });

  it("does not settle a batch job while source access is blocked", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    pluginMocks.loadInstalledFromDb.mockResolvedValueOnce(undefined);
    const deferred = createDeferred<void>();
    schedulerMocks.enqueueSource.mockImplementationOnce(
      (spec: SourceTaskSpec<void>) => {
        capturedSpec = spec;
        return { id: "task-1", promise: deferred.promise };
      },
    );
    const accessError = Object.assign(new Error("Complete the CAPTCHA."), {
      code: "manual-action-required" as const,
      challenge: {
        kind: "captcha",
        url: "https://source.test/chapter/7",
      },
    });
    pluginMocks.getChapterResource.mockRejectedValueOnce(accessError);
    const progressBefore = getActiveChapterDownloadBatchProgress() ?? {
      current: 0,
      total: 0,
    };

    const handle = enqueueChapterDownloadBatch({
      jobs: [
        {
          id: 7,
          pluginId: "source-a",
          chapterPath: "/chapter/7",
          title: "Chapter 7",
        },
      ],
      title: "Download blocked chapter",
      total: 1,
    });
    await flushMicrotasks();

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await expect(
      capturedSpec.run({
        setDetail: vi.fn(),
        setProgress: vi.fn(),
        signal: new AbortController().signal,
        taskId: "task-1",
      }),
    ).rejects.toBe(accessError);

    expect(getActiveChapterDownloadBatchProgress()).toEqual({
      current: progressBefore.current,
      total: progressBefore.total + 1,
    });
    expect([...backendQueueValues.keys()]).toEqual([7]);

    expect(cancelChapterDownloadBatches([handle.id])).toBe(1);
    deferred.reject(new DOMException("Task was cancelled.", "AbortError"));
    await expect(handle.promise).resolves.toEqual({
      cancelled: 1,
      failed: 0,
      succeeded: 0,
      total: 1,
    });
  });

  it("refills the bounded batch window after a cancelled task settles", async () => {
    const deferreds: Deferred<void>[] = [];
    schedulerMocks.enqueueSource.mockImplementation(
      (spec: SourceTaskSpec<void>) => {
        capturedSpec = spec;
        const deferred = createDeferred<void>();
        deferreds.push(deferred);
        return {
          id: `task-${deferreds.length}`,
          promise: deferred.promise,
        };
      },
    );

    const handle = enqueueChapterDownloadBatch({
      jobs: [1, 2, 3, 4].map((id) => ({
        id,
        pluginId: "source-a",
        chapterPath: `/chapter/${id}`,
        title: `Chapter ${id}`,
      })),
      title: "Download 4 chapters",
      total: 4,
      windowSize: 2,
    });

    await flushMicrotasks();

    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(2);

    deferreds[0]!.reject(
      new DOMException("Task was cancelled.", "AbortError"),
    );
    await flushMicrotasks();

    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(3);

    deferreds[1]!.resolve();
    await flushMicrotasks();

    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(4);

    deferreds[2]!.resolve();
    deferreds[3]!.resolve();

    await expect(handle.promise).resolves.toEqual({
      cancelled: 1,
      failed: 0,
      succeeded: 3,
      total: 4,
    });
  });

  it("stops materializing a batch after the batch is cancelled", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const deferreds: Deferred<void>[] = [];
    schedulerMocks.enqueueSource.mockImplementation(
      (spec: SourceTaskSpec<void>) => {
        capturedSpec = spec;
        const deferred = createDeferred<void>();
        deferreds.push(deferred);
        return {
          id: `task-${deferreds.length}`,
          promise: deferred.promise,
        };
      },
    );

    const handle = enqueueChapterDownloadBatch({
      jobs: [1, 2, 3, 4].map((id) => ({
        id,
        pluginId: "source-a",
        chapterPath: `/chapter/${id}`,
        title: `Chapter ${id}`,
      })),
      title: "Download 4 chapters",
      total: 4,
      windowSize: 2,
    });

    await flushMicrotasks();

    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(2);
    expect(cancelChapterDownloadBatches([capturedSpec!.subject!.batchId!])).toBe(
      1,
    );

    deferreds[0]!.reject(
      new DOMException("Task was cancelled.", "AbortError"),
    );
    deferreds[1]!.reject(
      new DOMException("Task was cancelled.", "AbortError"),
    );

    await expect(handle.promise).resolves.toEqual({
      cancelled: 4,
      failed: 0,
      succeeded: 0,
      total: 4,
    });
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();

    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(2);
    expect([...backendQueueValues.keys()]).toEqual([]);
    expect(
      tauriMocks.invoke.mock.calls.filter(
        ([command]) => command === "chapter_download_queue_remove",
      ),
    ).toHaveLength(1);
  });

  it("removes restored backend queued jobs when the restored batch is cancelled", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const deferreds: Deferred<void>[] = [];
    schedulerMocks.enqueueSource.mockImplementation(
      (spec: SourceTaskSpec<void>) => {
        capturedSpec = spec;
        const deferred = createDeferred<void>();
        deferreds.push(deferred);
        return {
          id: `task-${deferreds.length}`,
          promise: deferred.promise,
        };
      },
    );
    const jobs = [1, 2, 3, 4].map((id) => ({
      id,
      pluginId: "source-a",
      chapterPath: `/chapter/${id}`,
      title: `Chapter ${id}`,
    }));
    for (const job of jobs) backendQueueValues.set(job.id, job);

    const handle = enqueueChapterDownloadBatch({
      jobs,
      persist: false,
      removeBackendQueuedJobsOnCancel: true,
      title: "Restore queued downloads",
      total: 4,
      windowSize: 2,
    });

    await flushMicrotasks();

    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(2);
    expect(cancelChapterDownloadBatches([capturedSpec!.subject!.batchId!])).toBe(
      1,
    );

    deferreds[0]!.reject(
      new DOMException("Task was cancelled.", "AbortError"),
    );
    deferreds[1]!.reject(
      new DOMException("Task was cancelled.", "AbortError"),
    );

    await expect(handle.promise).resolves.toEqual({
      cancelled: 4,
      failed: 0,
      succeeded: 0,
      total: 4,
    });
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();

    expect([...backendQueueValues.keys()]).toEqual([]);
    expect(
      tauriMocks.invoke.mock.calls.filter(
        ([command]) => command === "chapter_download_queue_remove",
      ),
    ).toHaveLength(1);
  });
});

describe("startChapterDownloadQueueExecutor", () => {
  it("does not restore queue entries removed by a storage operation", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const storageOperationStarted = createDeferred<void>();
    const releaseStorageOperation = createDeferred<void>();
    const storageOperation = runExclusiveChapterStorageOperation(
      { kind: "sources", sourceIds: ["source-a"] },
      undefined,
      async () => {
        storageOperationStarted.resolve();
        await releaseStorageOperation.promise;
      },
    );
    await storageOperationStarted.promise;
    schedulerMocks.enqueueSource.mockImplementation(
      (spec: SourceTaskSpec<void>) => {
        capturedSpec = spec;
        return {
          id: `task-${schedulerMocks.enqueueSource.mock.calls.length}`,
          promise: Promise.reject(new Error("executor failed")),
        };
      },
    );
    const restoredJobCount = 15;
    const jobs = Array.from({ length: restoredJobCount }, (_, index) => {
      const id = index + 1;
      return {
        id,
        pluginId: "source-a",
        chapterPath: `/chapter/${id}`,
        chapterName: `Chapter ${id}`,
        novelId: 11,
        novelName: "Novel",
        novelPath: "/novel",
        title: `Chapter ${id}`,
      };
    });
    for (const job of jobs) backendQueueValues.set(job.id, job);
    vi.mocked(getChapterById).mockImplementation(async (chapterId) => {
      if (chapterId === 2) {
        return null as never;
      }
      return { isDownloaded: chapterId === 3 } as never;
    });
    await startChapterDownloadQueueExecutor();
    await flushMicrotasks();

    expect(getChapterById).not.toHaveBeenCalled();
    expect(reconcileStoredChapterContent).not.toHaveBeenCalled();
    expect(schedulerMocks.enqueueSource).not.toHaveBeenCalled();

    backendQueueValues.delete(1);
    releaseStorageOperation.resolve();
    await storageOperation;
    await flushMicrotasks(50);

    expect(pluginMocks.loadInstalledFromDb).not.toHaveBeenCalled();
    expect(reconcileStoredChapterContent).not.toHaveBeenCalled();
    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(
      restoredJobCount - 2,
    );
    expect([...backendQueueValues.keys()]).toEqual(
      jobs.slice(2).map((job) => job.id),
    );
    expect(capturedSpec?.kind).toBe("chapter.download");
    expect(capturedSpec?.subject?.batchTitle).toBe("Queued chapter downloads");
  });
});

describe("enqueueChapterDownload", () => {
  it("removes the backend queue job when the scheduler rejects source verification", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const accessError = new SourceAccessRequiredError(
      "Complete the Cloudflare verification.",
      {
        kind: "cloudflare",
        url: "https://source.test/chapter/7",
      },
    );
    schedulerMocks.enqueueSource.mockImplementationOnce(
      (spec: SourceTaskSpec<void>) => {
        capturedSpec = spec;
        return { id: "task-1", promise: Promise.reject(accessError) };
      },
    );

    const handle = enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      title: "Chapter 7",
    });

    await expect(handle.promise).rejects.toBe(accessError);
    await flushMicrotasks();

    expect([...backendQueueValues.keys()]).toEqual([]);
    expect(
      tauriMocks.invoke.mock.calls.filter(
        ([command]) => command === "chapter_download_queue_remove",
      ),
    ).toHaveLength(1);
  });

  it("keeps the backend queue job when media finalization fails", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const finalizationError = Object.assign(
      new Error("Chapter media archive finalization failed."),
      { code: "chapter-media-finalization-failed" as const },
    );
    schedulerMocks.enqueueSource.mockImplementationOnce(
      (spec: SourceTaskSpec<void>) => {
        capturedSpec = spec;
        return { id: "task-1", promise: Promise.reject(finalizationError) };
      },
    );

    const handle = enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      title: "Chapter 7",
    });

    await expect(handle.promise).rejects.toBe(finalizationError);
    await flushMicrotasks();

    expect([...backendQueueValues.keys()]).toEqual([7]);
    expect(
      tauriMocks.invoke.mock.calls.filter(
        ([command]) => command === "chapter_download_queue_remove",
      ),
    ).toHaveLength(0);
  });

  it("keeps chapter downloads off the interaction executor", () => {
    pluginMocks.getPlugin.mockReturnValueOnce({
      apiVersion: "0.2",
      id: "source-a",
      name: "Source A",
      getBaseUrl: () => "https://source.test",
      getChapterAcquisitionPlan: pluginMocks.getChapterAcquisitionPlan,
      getChapterResource: pluginMocks.getChapterResource,
    });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      title: "Chapter 7",
    });

    expect(capturedSpec?.requiresForegroundExecutor).toBeUndefined();
  });

  it("rebuilds the page-plan URL for persisted source verification", async () => {
    const pageUrl =
      "https://source.test/chapter/7?signed=fresh-proof#challenge";
    pluginMocks.getChapterAcquisitionPlan.mockReturnValueOnce({
      type: "page",
      url: pageUrl,
      contentSelector: "article.chapter",
    });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      contentType: "html",
      title: "Chapter 7",
    });

    await expect(capturedSpec?.resolveSourceAccessUrl?.()).resolves.toBe(
      pageUrl,
    );
    expect(pluginMocks.getChapterAcquisitionPlan).toHaveBeenCalledWith(
      "/chapter/7",
      "text",
    );
  });

  it("finishes without plugin or network work when final content exists", async () => {
    const getBaseUrl = vi.fn(() => "https://source.test");
    pluginMocks.getPlugin.mockReturnValueOnce({
      apiVersion: "0.2",
      id: "source-a",
      name: "Source A",
      getBaseUrl,
      getChapterAcquisitionPlan: pluginMocks.getChapterAcquisitionPlan,
      getChapterResource: pluginMocks.getChapterResource,
    });
    vi.mocked(reconcileStoredChapterContent).mockResolvedValueOnce({
      status: "present",
      contentFile: "contents/source-a/novel/7-Chapter/content.html",
      contentBytes: 24,
      mediaBytes: 8,
    });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    const setProgress = vi.fn();
    const tryStartSourceAccess = vi.fn(() => true);
    await capturedSpec.run({
      executor: "pool:1",
      setDetail: vi.fn(),
      setProgress,
      signal: new AbortController().signal,
      taskId: "task-1",
      tryStartSourceAccess,
    });

    expect(capturedSpec.canCompleteWithoutSourceAccess).toBe(true);
    expect(tryStartSourceAccess).not.toHaveBeenCalled();
    expect(setProgress).toHaveBeenLastCalledWith({ current: 1, total: 1 });
    expect(pluginMocks.loadInstalledFromDb).not.toHaveBeenCalled();
    expect(getBaseUrl).not.toHaveBeenCalled();
    expect(pluginMocks.getPluginForExecutor).not.toHaveBeenCalled();
    expect(pluginMocks.getChapterAcquisitionPlan).not.toHaveBeenCalled();
    expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
    expect(acquisitionMocks.captureChapterPage).not.toHaveBeenCalled();
    expect(getChapterById).not.toHaveBeenCalled();
  });

  it("returns to the scheduler before plugin work when source access is deferred", async () => {
    const tryStartSourceAccess = vi.fn(() => false);

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      executor: "pool:1",
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
      tryStartSourceAccess,
    });

    expect(reconcileStoredChapterContent).toHaveBeenCalledWith(7);
    expect(tryStartSourceAccess).toHaveBeenCalledOnce();
    expect(pluginMocks.loadInstalledFromDb).not.toHaveBeenCalled();
    expect(pluginMocks.getPluginForExecutor).not.toHaveBeenCalled();
    expect(pluginMocks.getChapterAcquisitionPlan).not.toHaveBeenCalled();
    expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
    expect(acquisitionMocks.captureChapterPage).not.toHaveBeenCalled();
  });

  it("does not start source work when local storage inspection fails", async () => {
    const storageError = new Error("Android storage folder is not readable.");
    const tryStartSourceAccess = vi.fn(() => true);
    vi.mocked(reconcileStoredChapterContent).mockRejectedValueOnce(storageError);

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await expect(
      capturedSpec.run({
        executor: "pool:1",
        setDetail: vi.fn(),
        setProgress: vi.fn(),
        signal: new AbortController().signal,
        taskId: "task-1",
        tryStartSourceAccess,
      }),
    ).rejects.toBe(storageError);

    expect(tryStartSourceAccess).not.toHaveBeenCalled();
    expect(pluginMocks.loadInstalledFromDb).not.toHaveBeenCalled();
    expect(pluginMocks.getPluginForExecutor).not.toHaveBeenCalled();
    expect(pluginMocks.getChapterAcquisitionPlan).not.toHaveBeenCalled();
    expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
    expect(acquisitionMocks.captureChapterPage).not.toHaveBeenCalled();
  });

  it("reacquires final content when verifying source access", async () => {
    const confirmSourceAccess = vi.fn(() => true);
    const setSourceAccessUrl = vi.fn(() => true);
    vi.mocked(reconcileStoredChapterContent).mockResolvedValueOnce({
      status: "present",
      contentFile: "contents/source-a/novel/7-Chapter/content.html",
      contentBytes: 24,
      mediaBytes: 8,
    });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      confirmSourceAccess,
      executor: "immediate",
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      setSourceAccessUrl,
      signal: new AbortController().signal,
      sourceAccessVerification: true,
      taskId: "task-1",
    });

    expect(pluginMocks.getPluginForExecutor).toHaveBeenCalledOnce();
    expect(pluginMocks.getChapterResource).toHaveBeenCalledWith(
      "/chapter/7",
      "text",
    );
    expect(confirmSourceAccess).toHaveBeenCalledOnce();
  });

  it("yields the foreground executor when paused during the download preamble", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const blockedLoad = createDeferred<void>();
    pluginMocks.loadInstalledFromDb.mockReturnValueOnce(blockedLoad.promise);

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    const controller = new AbortController();
    const runPromise = capturedSpec.run({
      executor: "immediate",
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      signal: controller.signal,
      taskId: "task-1",
    });
    void runPromise.catch(() => undefined);

    await flushMicrotasks();
    expect(pluginMocks.loadInstalledFromDb).toHaveBeenCalledTimes(1);

    controller.abort(new DOMException("Task was paused.", "AbortError"));

    // The blocked preamble never resolves; the run still rejects promptly so
    // the shared foreground executor is released for interactive work.
    await expect(runPromise).rejects.toThrow("Task was paused.");
    expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
  });

  it("carries contentType through the task subject and saveStoredChapterContent", async () => {
    vi.mocked(hasRemoteChapterMedia).mockReturnValueOnce(false);

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      contentType: "text",
      title: "Chapter 7",
    });

    expect(capturedSpec?.subject).toEqual(
      expect.objectContaining({ contentType: "text" }),
    );

    await capturedSpec?.run({
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(saveStoredChapterContent).toHaveBeenCalledWith(
      7,
      `<article class="reader-text-content" data-source-format="text"><section class="reader-text-section" data-section-index="0"><p class="reader-text-paragraph" data-paragraph-index="0"><span class="reader-text-line" data-line-index="0">plain &lt;chapter&gt;</span></p></section></article>`,
      "html",
      { mediaBytes: 0 },
    );
    expect(clearChapterMedia).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ chapterId: 7, sourceId: "source-a" }),
    );
  });

  it("uses the current source type instead of the stored effective type", async () => {
    vi.mocked(getChapterById).mockResolvedValueOnce({
      contentType: "html",
      sourceContentType: "text",
      id: 7,
    } as never);
    vi.mocked(hasRemoteChapterMedia).mockReturnValueOnce(false);

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      contentType: "html",
      title: "Chapter 7",
    });

    await capturedSpec?.run({
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(pluginMocks.getChapterAcquisitionPlan).toHaveBeenCalledWith(
      "/chapter/7",
      "text",
    );
    expect(pluginMocks.getChapterResource).toHaveBeenCalledWith(
      "/chapter/7",
      "text",
    );
  });

  it("binds a resource plan to its resolved chapter URL before acquisition", async () => {
    const setSourceAccessUrl = vi.fn(() => true);
    pluginMocks.getChapterResource.mockResolvedValueOnce({
      type: "content",
      contentType: "text",
      content: "plain <chapter>",
      baseUrl: "https://cdn.test/assets/",
    });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      contentType: "text",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      setSourceAccessUrl,
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(setSourceAccessUrl).toHaveBeenCalledWith(
      "https://source.test/chapter/7",
    );
    expect(setSourceAccessUrl).toHaveBeenCalledOnce();
    expect(setSourceAccessUrl.mock.invocationCallOrder[0]).toBeLessThan(
      pluginMocks.getChapterResource.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(cacheHtmlChapterMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://cdn.test/assets/",
        contextUrl: "https://cdn.test/assets/",
        sourceAccessUrl: "https://source.test/chapter/7",
      }),
    );
  });

  it.each([
    ["text", "plain <chapter>", 'data-source-format="text"'],
    ["markdown", "# Chapter 7", 'class="reader-markdown-content"'],
  ] as const)(
    "accepts a normalized html request backed by a %s resource",
    async (resourceContentType, content, expectedHtml) => {
      pluginMocks.getChapterResource.mockResolvedValueOnce(
        contentResource(content, resourceContentType),
      );
      vi.mocked(getChapterById).mockResolvedValueOnce({
        contentType: "html",
        id: 7,
      } as never);
      vi.mocked(hasRemoteChapterMedia).mockReturnValueOnce(false);

      enqueueChapterDownload({
        id: 7,
        pluginId: "source-a",
        chapterPath: "/chapter/7",
        contentType: "html",
        title: "Chapter 7",
      });

      if (!capturedSpec) throw new Error("Task spec was not captured.");
      await capturedSpec.run({
        setDetail: vi.fn(),
        setProgress: vi.fn(),
        signal: new AbortController().signal,
        taskId: "task-1",
      });

      expect(pluginMocks.getChapterResource).toHaveBeenCalledWith(
        "/chapter/7",
        "html",
      );
      expect(saveStoredChapterContent).toHaveBeenCalledWith(
        7,
        expect.stringContaining(expectedHtml),
        "html",
        { mediaBytes: 0 },
      );
    },
  );

  it("uses stored chapter HTML as the media download source", async () => {
    const storedHtml = `<img src="norea-media://reader-asset/page.png">`;
    pluginMocks.getChapterAcquisitionPlan.mockReturnValueOnce({
      type: "page",
      url: "https://source.test/chapter/7",
      contentSelector: "article.chapter",
    });
    vi.mocked(readStoredChapterPartialContentMirror).mockResolvedValueOnce(
      storedHtml,
    );
    vi.mocked(hasRemoteChapterMedia).mockReturnValueOnce(false);
    vi.mocked(localChapterMediaSources).mockReturnValueOnce([
      "norea-media://reader-asset/page.png",
    ]);
    vi.mocked(cacheHtmlChapterMedia).mockResolvedValueOnce({
      html: storedHtml,
      mediaFailures: [],
      mediaBytes: 3,
      storedMediaCount: 1,
    });
    vi.mocked(getChapterById).mockResolvedValueOnce({
      contentType: "html",
      id: 7,
      isDownloaded: false,
    } as never);

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      contentType: "html",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      executor: "pool:1",
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
    expect(acquisitionMocks.captureChapterPage).not.toHaveBeenCalled();
    expect(cacheHtmlChapterMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        html: storedHtml,
        previousHtml: storedHtml,
        repair: true,
        requestInit: { headers: { Referer: "https://source.test/" } },
        scraperExecutor: "pool:1",
        sourceId: "source-a",
      }),
    );
    expect(saveStoredChapterContent).toHaveBeenCalledWith(7, storedHtml, "html", {
      mediaBytes: 3,
    });
  });

  it("recaptures a page plan when verifying source access", async () => {
    const confirmSourceAccess = vi.fn(() => true);
    const setSourceAccessUrl = vi.fn(() => true);
    const storedHtml = `<img src="norea-media://reader-asset/page.png">`;
    pluginMocks.getChapterAcquisitionPlan.mockReturnValueOnce({
      type: "page",
      url: "https://source.test/chapter/7",
      contentSelector: "article.chapter",
    });
    vi.mocked(readStoredChapterPartialContentMirror).mockResolvedValueOnce(
      storedHtml,
    );
    vi.mocked(getChapterById).mockResolvedValueOnce({
      contentType: "html",
      id: 7,
      isDownloaded: false,
    } as never);

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      contentType: "html",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      confirmSourceAccess,
      executor: "immediate",
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      setSourceAccessUrl,
      signal: new AbortController().signal,
      sourceAccessVerification: true,
      taskId: "task-1",
    });

    expect(acquisitionMocks.captureChapterPage).toHaveBeenCalledOnce();
    expect(confirmSourceAccess).toHaveBeenCalledOnce();
    expect(cacheHtmlChapterMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        html: `<img src="https://cdn.test/page.png?accessKey=signed">`,
        previousHtml: storedHtml,
        repair: false,
      }),
    );
  });

  it("captures page plans on the assigned executor and reuses its browser cache", async () => {
    const confirmSourceAccess = vi.fn(() => true);
    const setSourceAccessUrl = vi.fn(() => true);
    pluginMocks.getChapterAcquisitionPlan.mockReturnValueOnce({
      type: "page",
      url: "https://source.test/chapter/7?accessKey=chapter",
      contentSelector: "article.chapter",
    });
    vi.mocked(getChapterById).mockResolvedValueOnce({
      contentType: "html",
      id: 7,
      isDownloaded: false,
    } as never);

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      contentType: "html",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      confirmSourceAccess,
      executor: "pool:2",
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      setSourceAccessUrl,
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(acquisitionMocks.captureChapterPage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "page" }),
      expect.objectContaining({
        contentType: "html",
        executor: "pool:2",
        sourceId: "source-a",
      }),
    );
    expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
    expect(setSourceAccessUrl).toHaveBeenNthCalledWith(
      1,
      "https://source.test/chapter/7?accessKey=chapter",
    );
    expect(setSourceAccessUrl.mock.invocationCallOrder[0]).toBeLessThan(
      acquisitionMocks.captureChapterPage.mock.invocationCallOrder[0] ??
        Infinity,
    );
    expect(setSourceAccessUrl).toHaveBeenNthCalledWith(
      2,
      "https://source.test/chapter/7",
    );
    expect(setSourceAccessUrl.mock.invocationCallOrder[1]).toBeLessThan(
      confirmSourceAccess.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(confirmSourceAccess).toHaveBeenCalledOnce();
    expect(cacheHtmlChapterMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://source.test/chapter/7",
        contextUrl: "https://source.test/chapter/7",
        scraperExecutor: "pool:2",
        sourceAccessUrl: "https://source.test/chapter/7",
      }),
    );
  });

  it("keeps fresh chapter media downloads on the assigned scraper executor", async () => {
    pluginMocks.getChapterResource.mockResolvedValueOnce(
      contentResource(`<img src="/page.png">`),
    );
    vi.mocked(readStoredChapterPartialContentMirror).mockResolvedValueOnce(
      null,
    );
    vi.mocked(getChapterById).mockResolvedValueOnce({
      contentType: "html",
      id: 7,
      isDownloaded: true,
    } as never);

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      contentType: "html",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      executor: "pool:1",
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(pluginMocks.getChapterResource).toHaveBeenCalledWith(
      "/chapter/7",
      "html",
    );
    expect(cacheHtmlChapterMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        previousHtml: null,
        repair: false,
        requestInit: { headers: { Referer: "https://source.test/" } },
        scraperExecutor: "pool:1",
        sourceId: "source-a",
      }),
    );
    expect(saveStoredChapterContent).toHaveBeenCalledWith(7, "<img>", "html", {
      mediaBytes: 3,
    });
  });

  it("persists background chapter HTML before caching media", async () => {
    const mediaDeferred = createDeferred<{
      html: string;
      mediaBytes: number;
      mediaFailures: never[];
      storedMediaCount: number;
    }>();
    pluginMocks.getChapterResource.mockResolvedValueOnce(
      contentResource(`<img src="/page.png">`),
    );
    vi.mocked(cacheHtmlChapterMedia).mockReturnValueOnce(mediaDeferred.promise);
    vi.mocked(getChapterById).mockResolvedValueOnce({
      contentType: "html",
      id: 7,
      isDownloaded: false,
    } as never);

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      contentType: "html",
      priority: "background",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    const runPromise = capturedSpec.run({
      executor: "pool:1",
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    await flushMicrotasks();

    expect(saveStoredChapterPartialContent).toHaveBeenCalledWith(
      7,
      `<img src="/page.png">`,
      "html",
    );
    expect(cacheHtmlChapterMedia).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(saveStoredChapterPartialContent).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(cacheHtmlChapterMedia).mock.invocationCallOrder[0]!,
    );

    mediaDeferred.resolve({
      html: "<img>",
      mediaBytes: 3,
      mediaFailures: [],
      storedMediaCount: 1,
    });
    await runPromise;
  });

  it("renders markdown chapters before caching rendered media", async () => {
    pluginMocks.getChapterResource.mockResolvedValueOnce(
      contentResource(
        [
          "# Chapter 7",
          "",
          "[kept](https://source.test/read)",
          "![Page](/page.png)",
        ].join("\n"),
        "markdown",
      ),
    );
    vi.mocked(getChapterById).mockResolvedValueOnce({
      content: null,
      contentType: "markdown",
      id: 7,
    } as never);
    vi.mocked(cacheHtmlChapterMedia).mockResolvedValueOnce({
      html: `<section class="reader-markdown-content"><h1>Chapter 7</h1><p><a href="https://source.test/read">kept</a><img src="norea-media://reader-asset/page.png" alt="Page"></p></section>`,
      mediaFailures: [],
      mediaBytes: 3,
      storedMediaCount: 1,
    });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      contentType: "markdown",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(cacheHtmlChapterMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringMatching(
          /<section class="reader-markdown-content">[\s\S]*src="\/page\.png"/,
        ),
        sourceId: "source-a",
      }),
    );
    expect(saveStoredChapterContent).toHaveBeenCalledWith(
      7,
      expect.stringContaining("norea-media://reader-asset/page.png"),
      "html",
      { mediaBytes: 3 },
    );
    expect(clearChapterMedia).not.toHaveBeenCalled();
  });

  it("downloads pdf chapters from an explicit resource plan", async () => {
    vi.mocked(getChapterById).mockResolvedValueOnce({
      content: null,
      contentType: "pdf",
      id: 7,
    } as never);
    pluginMocks.getChapterResource.mockResolvedValueOnce({
      type: "binary",
      contentType: "pdf",
      mediaType: "application/pdf",
      bytes: new Uint8Array([37, 80, 68, 70]),
      byteLength: 4,
    });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7.pdf",
      contentType: "pdf",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(pluginMocks.getChapterResource).toHaveBeenCalledWith(
      "/chapter/7.pdf",
      "pdf",
    );
    expect(saveStoredChapterContent).toHaveBeenCalledWith(
      7,
      "data:application/pdf;base64,JVBERg==",
      "pdf",
      { mediaBytes: 0 },
    );
    expect(clearChapterMedia).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ chapterId: 7, sourceId: "source-a" }),
    );
  });

  it("converts epub resources to reader html and stores embedded media", async () => {
    const section = {
      html: `<section><img src="norea-epub-resource://OEBPS%2Fpage.png"></section>`,
      href: "OEBPS/chapter.xhtml",
      name: "Chapter 7",
      resources: [
        {
          bytes: new Uint8Array([1, 2, 3]),
          fileName: "0001-page.png",
          mediaType: "image/png",
          placeholder: "norea-epub-resource://OEBPS%2Fpage.png",
          sourcePath: "OEBPS/page.png",
        },
      ],
    };
    vi.mocked(getChapterById).mockResolvedValueOnce({
      content: null,
      contentType: "epub",
      id: 7,
      name: "Chapter 7",
    } as never);
    pluginMocks.getChapterResource.mockResolvedValueOnce({
      type: "binary",
      contentType: "epub",
      mediaType: "application/epub+zip",
      bytes: new Uint8Array([80, 75, 3, 4]),
      byteLength: 4,
    });
    vi.mocked(convertEpubToHtml).mockResolvedValueOnce({
      direction: "rtl",
      language: "en",
      sections: [section],
      title: "Book",
    });
    vi.mocked(mergeEpubHtmlSections).mockReturnValueOnce(
      `<article><img src="norea-epub-resource://OEBPS%2Fpage.png"></article>`,
    );
    vi.mocked(storeEmbeddedChapterMedia).mockResolvedValueOnce({
      html: `<article><img src="norea-media://reader-asset/0001-page.png"></article>`,
      mediaBytes: 3,
      storedMediaCount: 1,
    });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7.epub",
      contentType: "epub",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(pluginMocks.getChapterResource).toHaveBeenCalledWith(
      "/chapter/7.epub",
      "epub",
    );
    expect(convertEpubToHtml).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      { fallbackTitle: "Chapter 7" },
    );
    expect(mergeEpubHtmlSections).toHaveBeenCalledWith([section], {
      direction: "rtl",
      language: "en",
    });
    expect(storeEmbeddedChapterMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        chapterId: 7,
        resources: [
          expect.objectContaining({
            contentType: "image/png",
            fileName: "0001-page.png",
            placeholder: "norea-epub-resource://OEBPS%2Fpage.png",
            sourcePath: "OEBPS/page.png",
          }),
        ],
        sourceId: "source-a",
      }),
    );
    expect(saveStoredChapterContent).toHaveBeenCalledWith(
      7,
      `<article><img src="norea-media://reader-asset/0001-page.png"></article>`,
      "epub",
      { mediaBytes: 3 },
    );
    expect(clearChapterMedia).not.toHaveBeenCalled();
  });

  it("fails epub downloads when getChapterResource is unavailable", async () => {
    pluginMocks.getPluginForExecutor.mockReturnValueOnce({
      apiVersion: "0.2",
      id: "source-a",
      imageRequestInit: { headers: { Referer: "https://source.test/" } },
      name: "Source A",
      getBaseUrl: () => "https://source.test",
      getChapterAcquisitionPlan: pluginMocks.getChapterAcquisitionPlan,
    });
    vi.mocked(getChapterById).mockResolvedValueOnce({
      content: null,
      contentType: "epub",
      id: 7,
    } as never);

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7.epub",
      contentType: "epub",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await expect(
      capturedSpec.run({
        setDetail: vi.fn(),
        setProgress: vi.fn(),
        signal: new AbortController().signal,
        taskId: "task-1",
      }),
    ).rejects.toThrow("getChapterResource");

    expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
    expect(saveStoredChapterContent).not.toHaveBeenCalled();
  });

  it("fails binary downloads when resource metadata does not match the chapter type", async () => {
    vi.mocked(getChapterById).mockResolvedValueOnce({
      content: null,
      contentType: "epub",
      id: 7,
    } as never);
    pluginMocks.getChapterResource.mockResolvedValueOnce({
      type: "binary",
      contentType: "epub",
      mediaType: "application/pdf",
      bytes: new Uint8Array([80, 75, 3, 4]),
      byteLength: 4,
    });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7.epub",
      contentType: "epub",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await expect(
      capturedSpec.run({
        setDetail: vi.fn(),
        setProgress: vi.fn(),
        signal: new AbortController().signal,
        taskId: "task-1",
      }),
    ).rejects.toThrow("mediaType");

    expect(pluginMocks.getChapterResource).toHaveBeenCalledTimes(1);
    expect(saveStoredChapterContent).not.toHaveBeenCalled();
  });

  it("fails binary downloads when resource bytes are empty", async () => {
    vi.mocked(getChapterById).mockResolvedValueOnce({
      content: null,
      contentType: "pdf",
      id: 7,
    } as never);
    pluginMocks.getChapterResource.mockResolvedValueOnce({
      type: "binary",
      contentType: "pdf",
      mediaType: "application/pdf",
      bytes: new Uint8Array(),
      byteLength: 0,
    });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7.pdf",
      contentType: "pdf",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await expect(
      capturedSpec.run({
        setDetail: vi.fn(),
        setProgress: vi.fn(),
        signal: new AbortController().signal,
        taskId: "task-1",
      }),
    ).rejects.toThrow("bytes are empty");

    expect(pluginMocks.getChapterResource).toHaveBeenCalledTimes(1);
    expect(saveStoredChapterContent).not.toHaveBeenCalled();
  });

  it("fails binary downloads when declared byteLength does not match bytes", async () => {
    vi.mocked(getChapterById).mockResolvedValueOnce({
      content: null,
      contentType: "pdf",
      id: 7,
    } as never);
    pluginMocks.getChapterResource.mockResolvedValueOnce({
      type: "binary",
      contentType: "pdf",
      mediaType: "application/pdf",
      bytes: new Uint8Array([37, 80, 68, 70]),
      byteLength: 99,
    });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7.pdf",
      contentType: "pdf",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await expect(
      capturedSpec.run({
        setDetail: vi.fn(),
        setProgress: vi.fn(),
        signal: new AbortController().signal,
        taskId: "task-1",
      }),
    ).rejects.toThrow("byteLength");

    expect(pluginMocks.getChapterResource).toHaveBeenCalledTimes(1);
    expect(saveStoredChapterContent).not.toHaveBeenCalled();
  });

  it("records media fallback detail without failing the chapter download", async () => {
    const setDetail = vi.fn();
    pluginMocks.getChapterResource.mockResolvedValueOnce(
      contentResource(`<img src="/page.png">`),
    );
    vi.mocked(getChapterById).mockResolvedValueOnce({
      content: null,
      contentType: "html",
      id: 7,
    } as never);
    vi.mocked(cacheHtmlChapterMedia).mockResolvedValueOnce({
      html: `<img src="https://source.test/page.png">`,
      mediaFailures: [
        {
          message: "Failed to fetch",
          url: "https://source.test/page.png",
        },
      ],
      mediaBytes: 0,
      storedMediaCount: 0,
    });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      contentType: "html",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      setDetail,
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(setDetail).toHaveBeenCalledWith(
      "1 media assets using remote fallback",
    );
    expect(saveStoredChapterContent).toHaveBeenCalledWith(
      7,
      `<img src="https://source.test/page.png">`,
      "html",
      { mediaBytes: 0 },
    );
  });

  it("fails when the local chapter row is missing", async () => {
    vi.mocked(getChapterById).mockResolvedValueOnce(null);

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await expect(
      capturedSpec.run({
        setDetail: vi.fn(),
        setProgress: vi.fn(),
        signal: new AbortController().signal,
        taskId: "task-1",
      }),
    ).rejects.toThrow(
      'chapter-download: local chapter 7 was not found for "Chapter 7" from plugin "source-a" at path "/chapter/7".',
    );

    expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
    expect(saveStoredChapterContent).not.toHaveBeenCalled();
  });

  it("fails when saving downloaded content does not update a chapter row", async () => {
    vi.mocked(saveStoredChapterContent).mockResolvedValueOnce({ rowsAffected: 0 });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await expect(
      capturedSpec.run({
        setDetail: vi.fn(),
        setProgress: vi.fn(),
        signal: new AbortController().signal,
        taskId: "task-1",
      }),
    ).rejects.toThrow(
      'chapter-download: local chapter 7 was not found for "Chapter 7" from plugin "source-a" at path "/chapter/7".',
    );

    expect(clearChapterMedia).not.toHaveBeenCalled();
  });
});

describe("enqueueChapterMediaRepair", () => {
  it("uses the source type for acquisition and the effective type for stored HTML", async () => {
    const storedHtml = `<img src="https://cdn.test/page.png">`;
    vi.mocked(readStoredChapterContentMirror).mockResolvedValueOnce(storedHtml);
    vi.mocked(getChapterById).mockResolvedValueOnce({
      chapterNumber: "7",
      contentType: "html",
      sourceContentType: "text",
      id: 7,
      isDownloaded: true,
      name: "Chapter 7",
      novelId: 11,
      path: "/chapter/7",
      position: 7,
    } as never);

    enqueueChapterMediaRepair({
      id: 7,
      pluginId: "source-a",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(pluginMocks.getChapterAcquisitionPlan).toHaveBeenCalledWith(
      "/chapter/7",
      "text",
    );
    expect(saveStoredChapterContent).toHaveBeenCalledWith(7, "<img>", "html", {
      mediaBytes: 3,
    });
  });

  it("recaptures page plans before repairing media", async () => {
    const confirmSourceAccess = vi.fn(() => true);
    const setSourceAccessUrl = vi.fn(() => true);
    const setDetail = vi.fn();
    const signal = new AbortController().signal;
    const storedHtml = `<img src="norea-media://reader-asset/0001-page.png">`;
    const capturedHtml = `<img src="https://cdn.test/page.png?accessKey=asset">`;
    const repairedHtml = `<img src="norea-media://reader-asset/page.png">`;
    const pagePlan = {
      type: "page" as const,
      url: "https://source.test/chapter/7?accessKey=chapter",
      contentSelector: "article.chapter",
      documentStartScript: "window.__captureChapter = true;",
    };
    pluginMocks.getChapterAcquisitionPlan.mockReturnValueOnce(pagePlan);
    acquisitionMocks.captureChapterPage.mockResolvedValueOnce({
      baseUrl: "https://source.test/chapter/7?accessKey=fresh",
      content: capturedHtml,
    });
    vi.mocked(readStoredChapterContentMirror).mockResolvedValueOnce(storedHtml);
    vi.mocked(hasRemoteChapterMedia).mockImplementationOnce(
      (html) => html.includes("accessKey=asset"),
    );
    vi.mocked(getChapterById).mockResolvedValueOnce({
      chapterNumber: "7",
      content: storedHtml,
      contentType: "html",
      sourceContentType: "html",
      id: 7,
      isDownloaded: true,
      name: "Chapter 7",
      novelId: 11,
      path: "/chapter/7",
      position: 7,
    } as never);
    vi.mocked(getNovelById).mockResolvedValueOnce({
      id: 11,
      name: "Novel",
      path: "/novel",
    } as never);
    vi.mocked(cacheHtmlChapterMedia).mockResolvedValueOnce({
      html: repairedHtml,
      mediaFailures: [],
      mediaBytes: 8,
      storedMediaCount: 1,
    });
    vi.mocked(getStoredChapterMediaBytes).mockResolvedValueOnce(8);

    enqueueChapterMediaRepair({
      id: 7,
      pluginId: "source-a",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      confirmSourceAccess,
      executor: "pool:1",
      setDetail,
      setProgress: vi.fn(),
      setSourceAccessUrl,
      signal,
      taskId: "task-1",
    });

    expect(pluginMocks.getChapterAcquisitionPlan).toHaveBeenCalledWith(
      "/chapter/7",
      "html",
    );
    expect(acquisitionMocks.validateChapterAcquisitionPlan).toHaveBeenCalledWith(
      pagePlan,
    );
    expect(acquisitionMocks.captureChapterPage).toHaveBeenCalledWith(pagePlan, {
      contentType: "html",
      executor: "pool:1",
      signal,
      sourceId: "source-a",
    });
    expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
    expect(setSourceAccessUrl).toHaveBeenNthCalledWith(1, pagePlan.url);
    expect(setSourceAccessUrl).toHaveBeenNthCalledWith(
      2,
      "https://source.test/chapter/7?accessKey=fresh",
    );
    expect(setSourceAccessUrl).toHaveBeenCalledTimes(2);
    expect(setSourceAccessUrl.mock.invocationCallOrder[1]).toBeLessThan(
      confirmSourceAccess.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(confirmSourceAccess).toHaveBeenCalledOnce();
    expect(cacheHtmlChapterMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://source.test/chapter/7?accessKey=fresh",
        contextUrl: "https://source.test/chapter/7?accessKey=fresh",
        html: capturedHtml,
        previousHtml: storedHtml,
        repair: true,
        requestInit: { headers: { Referer: "https://source.test/" } },
        scraperExecutor: "pool:1",
        sourceId: "source-a",
        sourceAccessUrl: "https://source.test/chapter/7?accessKey=fresh",
      }),
    );
    expect(saveStoredChapterContent).toHaveBeenCalledWith(7, repairedHtml, "html", {
      mediaBytes: 8,
    });
    expect(setDetail).toHaveBeenCalledWith("1 media assets repaired");
  });

  it("repairs stored resource-plan media without page capture", async () => {
    const setDetail = vi.fn();
    const storedHtml = `<img src="norea-media://reader-asset/0001-page.png">`;
    pluginMocks.getChapterAcquisitionPlan.mockReturnValueOnce({
      type: "resource",
    });
    vi.mocked(readStoredChapterContentMirror).mockResolvedValueOnce(storedHtml);
    vi.mocked(hasRemoteChapterMedia).mockReturnValueOnce(false);
    vi.mocked(localChapterMediaSources).mockReturnValueOnce([
      "norea-media://reader-asset/0001-page.png",
    ]);
    vi.mocked(getChapterById).mockResolvedValueOnce({
      chapterNumber: "7",
      content: storedHtml,
      contentType: "epub",
      sourceContentType: "epub",
      id: 7,
      isDownloaded: true,
      name: "Chapter 7",
      novelId: 11,
      path: "/chapter/7",
      position: 7,
    } as never);
    vi.mocked(getNovelById).mockResolvedValueOnce({
      id: 11,
      name: "Novel",
      path: "/novel",
    } as never);
    vi.mocked(cacheHtmlChapterMedia).mockResolvedValueOnce({
      html: storedHtml,
      mediaFailures: [],
      mediaBytes: 8,
      storedMediaCount: 1,
    });
    vi.mocked(getStoredChapterMediaBytes).mockResolvedValueOnce(8);

    enqueueChapterMediaRepair({
      id: 7,
      pluginId: "source-a",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      executor: "pool:1",
      setDetail,
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(pluginMocks.getChapterAcquisitionPlan).toHaveBeenCalledWith(
      "/chapter/7",
      "epub",
    );
    expect(acquisitionMocks.captureChapterPage).not.toHaveBeenCalled();
    expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
    expect(cacheHtmlChapterMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        html: storedHtml,
        previousHtml: storedHtml,
        repair: true,
      }),
    );
    expect(saveStoredChapterContent).toHaveBeenCalledWith(7, storedHtml, "epub", {
      mediaBytes: 8,
    });
    expect(setDetail).toHaveBeenCalledWith("1 media assets repaired");
  });

  it("refetches resource-plan HTML while reusing completed media", async () => {
    const storedHtml = `<img src="norea-media://reader-asset/0001-page.png">`;
    const freshHtml = `<img src="https://cdn.test/page.png?accessKey=fresh">`;
    pluginMocks.getChapterAcquisitionPlan.mockReturnValueOnce({
      type: "resource",
    });
    pluginMocks.getChapterResource.mockResolvedValueOnce({
      type: "content",
      contentType: "html",
      content: freshHtml,
      baseUrl: "https://source.test/chapter/7",
    });
    vi.mocked(readStoredChapterContentMirror).mockResolvedValueOnce(storedHtml);
    vi.mocked(getChapterById).mockResolvedValueOnce({
      chapterNumber: "7",
      contentType: "html",
      sourceContentType: "html",
      id: 7,
      isDownloaded: true,
      name: "Chapter 7",
      novelId: 11,
      path: "/chapter/7",
      position: 7,
    } as never);
    vi.mocked(getNovelById).mockResolvedValueOnce({
      id: 11,
      name: "Novel",
      path: "/novel",
    } as never);

    enqueueChapterMediaRepair({
      id: 7,
      pluginId: "source-a",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      confirmSourceAccess: vi.fn(() => true),
      executor: "pool:1",
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      setSourceAccessUrl: vi.fn(() => true),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(pluginMocks.getChapterResource).toHaveBeenCalledWith(
      "/chapter/7",
      "html",
    );
    expect(acquisitionMocks.captureChapterPage).not.toHaveBeenCalled();
    expect(cacheHtmlChapterMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://source.test/chapter/7",
        html: freshHtml,
        previousHtml: storedHtml,
        repair: true,
      }),
    );
  });

  it("persists the refetched body when downloaded HTML has no media", async () => {
    const setDetail = vi.fn();
    vi.mocked(readStoredChapterContentMirror).mockResolvedValueOnce(
      `<p>plain chapter</p>`,
    );
    pluginMocks.getChapterResource.mockResolvedValueOnce(
      contentResource(`<p>refetched chapter</p>`),
    );
    vi.mocked(hasRemoteChapterMedia).mockReturnValueOnce(false);
    vi.mocked(localChapterMediaSources).mockReturnValueOnce([]);
    vi.mocked(getChapterById).mockResolvedValueOnce({
      content: `<p>plain chapter</p>`,
      contentType: "html",
      id: 7,
      isDownloaded: true,
      name: "Chapter 7",
      novelId: 11,
      path: "/chapter/7",
      position: 7,
    } as never);

    enqueueChapterMediaRepair({
      id: 7,
      pluginId: "source-a",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      setDetail,
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(setDetail).toHaveBeenCalledWith("Chapter body refreshed");
    expect(pluginMocks.getChapterResource).toHaveBeenCalledWith(
      "/chapter/7",
      "html",
    );
    expect(cacheHtmlChapterMedia).not.toHaveBeenCalled();
    expect(saveStoredChapterContent).toHaveBeenCalledWith(
      7,
      "<p>refetched chapter</p>",
      "html",
      { mediaBytes: 0 },
    );
  });
});
