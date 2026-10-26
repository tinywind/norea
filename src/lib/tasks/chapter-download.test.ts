import { beforeEach, describe, expect, it, vi } from "vitest";
import { taskScheduler, type SourceTaskSpec } from "./scheduler";

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
  markChapterMediaRepairPending: vi.fn(async () => ({ rowsAffected: 1 })),
}));
vi.mock("../../db/queries/novel", () => ({
  getNovelById: vi.fn(),
}));
vi.mock("../../db/work-metadata", () => ({
  refreshStoredNovelChapterDownloads: vi.fn(),
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
const serverMediaMocks = vi.hoisted(() => ({ fetch: vi.fn(async () => null as Response | null) }));
vi.mock("../content-sync/media-repair", () => ({
  createServerChapterMediaFetcher: vi.fn(() => serverMediaMocks.fetch),
}));
vi.mock("../content-sync/novel-source", () => ({
  tryDownloadServerChapter: vi.fn(async () => false),
}));
vi.mock("./scheduler", () => ({
  TASK_PAUSE_ABORT_MESSAGE: "Task was paused.",
  taskScheduler: {
    batch: schedulerMocks.batch,
    enqueueSource: schedulerMocks.enqueueSource,
    getSnapshot: vi.fn(() => ({ records: [] })),
    getTaskByDedupeKey: vi.fn(),
    subscribeEvents: vi.fn(() => () => undefined),
  },
}));

import { getChapterById } from "../../db/queries/chapter";
import { getNovelById } from "../../db/queries/novel";
import { refreshStoredNovelChapterDownloads } from "../../db/work-metadata";
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
import { ChapterMediaIncompleteError } from "../chapter-media/errors";
import { isTauriRuntime } from "../tauri-runtime";
import { watchChapterDownloadActivity } from "./chapter-download-activity";
import { tryDownloadServerChapter } from "../content-sync/novel-source";
import { TaskUserCancelledError } from "./task-errors";
import { runExclusiveChapterStorageOperation } from "./chapter-storage-operation";
import { withChapterDownloadDeletion } from "../chapter-download-writes";
import {
  cancelChapterDownloadBatches,
  enqueueChapterDownloadBatch,
  enqueueChapterDownload,
  enqueueChapterMediaRepair,
  discardQueuedChapterDownloads,
  getActiveChapterDownloadBatchProgress,
  isChapterDownloadQueued,
  startChapterDownloadQueueExecutor,
  subscribeChapterDownloadBatchesSettled,
  waitForChapterDownloadQueueMutations,
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
  vi.mocked(taskScheduler.getTaskByDedupeKey).mockReset();
  backendQueueValues.clear();
  installBrowserHarness();
  capturedSpec = null;
  vi.mocked(isTauriRuntime).mockReturnValue(false);
  vi.mocked(tryDownloadServerChapter).mockResolvedValue(false);
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
  vi.mocked(getChapterById).mockReset().mockResolvedValue({
    contentType: "text",
    sourceContentType: "text",
    id: 7,
    novelId: 11,
    chapterNumber: "7",
    name: "Chapter 7",
    path: "/chapter/7",
    position: 7,
    isDownloaded: false,
  } as never);
  vi.mocked(getNovelById).mockReset().mockResolvedValue({
    id: 11, pluginId: "source-a", sourceNovelId: "novel", path: "/novel", name: "Novel",
    cover: null, summary: null, author: null, artist: null, status: null, genres: null, rating: null,
    inLibrary: true, isLocal: false, createdAt: 1, updatedAt: 1, libraryAddedAt: 1, lastReadAt: null,
  });
  vi.mocked(refreshStoredNovelChapterDownloads).mockReset().mockResolvedValue(undefined);
  vi.mocked(getStoredChapterMediaBytes).mockResolvedValue(3);
  vi.mocked(hasRemoteChapterMedia).mockReturnValue(true);
  vi.mocked(localChapterMediaSources).mockReturnValue([]);
  vi.mocked(readStoredChapterContentMirror).mockResolvedValue(null);
  vi.mocked(readStoredChapterPartialContentMirror).mockResolvedValue(null);
  vi.mocked(reconcileStoredChapterContent).mockReset().mockResolvedValue({
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

describe("chapter download queue membership", () => {
  it.each(["queued", "running", "succeeded", "failed", "cancelled"] as const)(
    "uses active task state instead of retained %s history",
    (status) => {
      vi.mocked(taskScheduler.getTaskByDedupeKey).mockImplementation((key) =>
        key === "chapter.download:900001" ? { status } as never : undefined,
      );
      expect(isChapterDownloadQueued(900001)).toBe(status === "queued" || status === "running");
    },
  );

  it("reserves an unmaterialized batch job and releases an individually cancelled job", async () => {
    const first = createDeferred<void>();
    schedulerMocks.enqueueSource.mockReturnValue({ id: "reservation", promise: first.promise });
    const handle = enqueueChapterDownloadBatch({
      jobs: [900002, 900003].map((id) => ({
        id, pluginId: "source-a", chapterPath: `/chapter/${id}`, title: `Chapter ${id}`,
      })),
      title: "Reserved batch",
      windowSize: 1,
    });
    expect(schedulerMocks.enqueueSource).toHaveBeenCalledOnce();
    expect(isChapterDownloadQueued(900003)).toBe(true);

    discardQueuedChapterDownloads([900003]);
    expect(isChapterDownloadQueued(900003)).toBe(false);
    expect(isChapterDownloadQueued(900002)).toBe(true);

    first.resolve();
    await handle.promise;
    expect(isChapterDownloadQueued(900002)).toBe(false);
    expect(schedulerMocks.enqueueSource).toHaveBeenCalledOnce();
  });

  it("keeps an active media repair out of a new download batch", () => {
    vi.mocked(taskScheduler.getTaskByDedupeKey).mockImplementation((key) =>
      key === "chapter.repairMedia:900004" ? { status: "running" } as never : undefined,
    );
    expect(isChapterDownloadQueued(900004)).toBe(true);
  });
});

describe("enqueueChapterDownloadBatch", () => {
  it("checks one work once for a thousand downloads and skips files missing from the cache", async () => {
    let localChaptersDiscovered = false;
    vi.mocked(refreshStoredNovelChapterDownloads).mockImplementation(async () => { localChaptersDiscovered = true; });
    vi.mocked(getChapterById).mockImplementation(async (id) => ({
      id, novelId: 42, contentType: "html", isDownloaded: localChaptersDiscovered && id <= 500,
    }) as never);
    vi.mocked(reconcileStoredChapterContent).mockRejectedValue(
      new Error("Download batches must not recover bodies or finalize media."),
    );
    vi.mocked(tryDownloadServerChapter).mockResolvedValue(true);
    schedulerMocks.enqueueSource.mockImplementation((spec: SourceTaskSpec<void>) => ({
      id: `task-${spec.subject?.chapterId}`,
      promise: spec.run({
        executor: "pool:1",
        setDetail: vi.fn(),
        setProgress: vi.fn(),
        signal: new AbortController().signal,
        taskId: `task-${spec.subject?.chapterId}`,
      }),
    }));
    const jobs = Array.from({ length: 1000 }, (_, index) => ({
      id: index + 1,
      novelId: 42,
      pluginId: "source-a",
      chapterPath: `/chapter/${index + 1}`,
      title: `Chapter ${index + 1}`,
    }));

    const handle = enqueueChapterDownloadBatch({ jobs, title: "All chapters" });

    await expect(handle.promise).resolves.toEqual({
      total: 1000, succeeded: 1000, failed: 0, cancelled: 0,
    });
    expect(reconcileStoredChapterContent).not.toHaveBeenCalled();
    expect(refreshStoredNovelChapterDownloads).toHaveBeenCalledExactlyOnceWith(42);
    expect(tryDownloadServerChapter).toHaveBeenCalledTimes(500);
    expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
  });

  it("does not materialize a deleted chapter from a pending batch window", async () => {
    const first = createDeferred<void>();
    schedulerMocks.enqueueSource.mockImplementation(() => ({ id: "first", promise: first.promise }));
    const jobs = [7, 8].map((id) => ({ id, pluginId: "source-a", chapterPath: `/chapter/${id}`, title: `Chapter ${id}` }));
    const handle = enqueueChapterDownloadBatch({ jobs, title: "Batch", windowSize: 1 });
    await flushMicrotasks();
    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(1);
    discardQueuedChapterDownloads([8]);
    first.resolve();
    await expect(handle.promise).resolves.toMatchObject({ cancelled: 1, succeeded: 1, total: 2 });
    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(1);
  });

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

  it("registers every requested array batch task without waiting for downloads to settle", async () => {
    const deferreds: Deferred<void>[] = [];
    const specs: SourceTaskSpec<void>[] = [];
    schedulerMocks.enqueueSource.mockImplementation(
      (spec: SourceTaskSpec<void>) => {
        specs.push(spec);
        const deferred = createDeferred<void>();
        deferreds.push(deferred);
        return {
          id: `task-${deferreds.length}`,
          promise: deferred.promise,
        };
      },
    );
    const jobs = Array.from({ length: 64 }, (_, index) => {
      const id = index + 1;
      return {
        id,
        pluginId: "source-a",
        chapterPath: `/chapter/${id}`,
        title: `Chapter ${id}`,
      };
    });

    const handle = enqueueChapterDownloadBatch({
      jobs,
      materializeAllTasks: true,
      persist: false,
      title: "Download 64 chapters",
      total: 64,
    });

    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(16);
    await vi.waitFor(() => {
      expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(64);
    });
    expect(new Set(specs.map((spec) => spec.subject?.batchId)).size).toBe(1);

    const batchId = specs[0]?.subject?.batchId;
    expect(batchId).toBeTruthy();
    expect(cancelChapterDownloadBatches([batchId!])).toBe(1);
    for (const deferred of deferreds) {
      deferred.reject(new DOMException("Task was cancelled.", "AbortError"));
    }

    await expect(handle.promise).resolves.toEqual({
      cancelled: 64,
      failed: 0,
      succeeded: 0,
      total: 64,
    });
  });

  it("stops paced array registration after cancellation", async () => {
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
    const jobs = Array.from({ length: 64 }, (_, index) => {
      const id = index + 1;
      return {
        id,
        pluginId: "source-a",
        chapterPath: `/chapter/${id}`,
        title: `Chapter ${id}`,
      };
    });

    const handle = enqueueChapterDownloadBatch({
      jobs,
      materializeAllTasks: true,
      title: "Download 64 chapters",
      total: 64,
    });

    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(16);
    expect(cancelChapterDownloadBatches([handle.id])).toBe(1);
    for (const deferred of deferreds) {
      deferred.reject(new DOMException("Task was cancelled.", "AbortError"));
    }

    await expect(handle.promise).resolves.toEqual({
      cancelled: 64,
      failed: 0,
      succeeded: 0,
      total: 64,
    });
    await waitForChapterDownloadQueueMutations();

    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(16);
    expect([...backendQueueValues.keys()]).toEqual([]);
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

    const unmaterializedUpload = watchChapterDownloadActivity(4);
    expect(unmaterializedUpload.signal.aborted).toBe(true);
    unmaterializedUpload.dispose();

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

  it.each([true, false])("removes only manually cancelled restored jobs (cancelled: %s)", async (cancelled) => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const deferreds: Deferred<void>[] = [];
    schedulerMocks.enqueueSource.mockImplementation(() => {
      const deferred = createDeferred<void>();
      deferreds.push(deferred);
      return { id: `task-${deferreds.length}`, promise: deferred.promise };
    });
    const jobs = [1, 2].map((id) => ({
      id,
      pluginId: "source-a",
      chapterPath: `/chapter/${id}`,
      title: `Chapter ${id}`,
    }));
    for (const job of jobs) backendQueueValues.set(job.id, job);
    const batch = enqueueChapterDownloadBatch({
      jobs,
      persist: false,
      removeBackendQueuedJobsOnCancel: true,
      title: "Restore downloads",
      windowSize: 1,
    });
    await flushMicrotasks();
    deferreds[0]!.reject(cancelled
      ? new DOMException("Task was cancelled.", "AbortError")
      : new Error("Storage is full."));
    await flushMicrotasks();
    await waitForChapterDownloadQueueMutations();

    expect([...backendQueueValues.keys()]).toEqual(cancelled ? [2] : [1, 2]);
    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(2);
    deferreds[1]!.resolve();
    if (cancelled) {
      await expect(batch.promise).resolves.toEqual({
        cancelled: 1,
        failed: 0,
        succeeded: 1,
        total: 2,
      });
    } else {
      await expect(batch.promise).rejects.toThrow("1 chapter downloads failed.");
    }
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
  it("waits for storage operations and skips jobs deleted during restore inspection", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const deferreds: Deferred<void>[] = [];
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
        const deferred = createDeferred<void>();
        deferreds.push(deferred);
        return {
          id: `task-${deferreds.length}`,
          promise: deferred.promise,
        };
      },
    );
    const restoredJobCount = 35;
    const jobs = Array.from({ length: restoredJobCount }, (_, index) => {
      const id = index + 1;
      return {
        id,
        pluginId: "source-a",
        chapterPath: `/chapter/${id}`,
        chapterName: `Chapter ${id}`,
        novelId: 11,
        novelName: "Novel",
        sourceNovelId: "novel",
        title: `Chapter ${id}`,
      };
    });
    for (const job of jobs) backendQueueValues.set(job.id, job);
    vi.mocked(getChapterById).mockImplementation(async (chapterId) => {
      if (chapterId === 2) {
        return null as never;
      }
      if (chapterId === 3) discardQueuedChapterDownloads([3]);
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

    try {
      await vi.waitFor(() => {
        expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(
          restoredJobCount - 3,
        );
      });
      expect(pluginMocks.loadInstalledFromDb).not.toHaveBeenCalled();
      expect(reconcileStoredChapterContent).not.toHaveBeenCalled();
      const restoredSpecs = schedulerMocks.enqueueSource.mock.calls.map(
        ([spec]) => spec as SourceTaskSpec<void>,
      );
      expect(restoredSpecs.map((spec) => spec.subject?.chapterId)).toEqual(
        jobs.slice(3).map((job) => job.id),
      );
      expect(restoredSpecs.every((spec) => spec.priority === "background")).toBe(
        true,
      );
      expect([...backendQueueValues.keys()]).toEqual(
        jobs.slice(3).map((job) => job.id),
      );
      expect(capturedSpec?.kind).toBe("chapter.download");
      expect(capturedSpec?.subject?.batchTitle).toBe("Queued chapter downloads");
    } finally {
      for (const deferred of deferreds) {
        deferred.reject(new Error("executor failed"));
      }
      await flushMicrotasks(100);
    }
  });
});

describe("enqueueChapterDownload", () => {
  it("removes a deleted job even when its native queue insertion finishes late", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const inserting = createDeferred<void>();
    const original = tauriMocks.invoke.getMockImplementation()!;
    tauriMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "chapter_download_queue_enqueue") await inserting.promise;
      return original(command, args);
    });
    enqueueChapterDownload({ id: 7, pluginId: "source-a", chapterPath: "/chapter/7", title: "Chapter 7" });
    await flushMicrotasks();
    try {
      discardQueuedChapterDownloads([7]);
      expect(backendQueueValues.has(7)).toBe(false);
    } finally {
      inserting.resolve();
    }
    await waitForChapterDownloadQueueMutations();
    expect(backendQueueValues.has(7)).toBe(false);
  });

  it("does not save a late media result after the chapter was cancelled", async () => {
    const controller = new AbortController();
    vi.mocked(getChapterById).mockResolvedValue({ id: 7, novelId: 3, contentType: "html" } as never);
    pluginMocks.getChapterResource.mockResolvedValue(contentResource('<img src="https://cdn.test/page.png">'));
    vi.mocked(cacheHtmlChapterMedia).mockImplementationOnce(async () => {
      controller.abort();
      return { html: "<p>Late</p>", mediaBytes: 0, mediaFailures: [], storedMediaCount: 0 };
    });
    vi.mocked(hasRemoteChapterMedia).mockReturnValue(true);
    enqueueChapterDownload({ id: 7, novelId: 3, pluginId: "source-a", chapterPath: "/chapter/7", title: "Chapter 7" });
    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await expect(capturedSpec.run({ setDetail: vi.fn(), setProgress: vi.fn(), signal: controller.signal, taskId: "task-1" })).rejects.toMatchObject({ name: "AbortError" });
    expect(saveStoredChapterContent).not.toHaveBeenCalled();
  });

  it("completes a server download without starting plugin source access", async () => {
    vi.mocked(tryDownloadServerChapter).mockImplementationOnce(async (_job, _signal, onPhase) => {
      onPhase?.("server-lookup");
      onPhase?.("server-download");
      return true;
    });
    pluginMocks.getPlugin.mockReturnValue(undefined);
    pluginMocks.getPluginForExecutor.mockImplementation(() => { throw new Error("Plugin is not installed"); });
    enqueueChapterDownload({ id: 7, novelId: 3, pluginId: "source-a", chapterPath: "/chapter/7", title: "Chapter 7" });
    if (!capturedSpec) throw new Error("Task spec was not captured.");
    const tryStartSourceAccess = vi.fn(() => false);
    const setProgress = vi.fn();
    const setChapterDownloadPhase = vi.fn();
    await capturedSpec.run({ setChapterDownloadPhase, setDetail: vi.fn(), setProgress, signal: new AbortController().signal, taskId: "task-1", tryStartSourceAccess });
    expect(setChapterDownloadPhase.mock.calls).toEqual([["local"], ["server-lookup"], ["server-download"]]);
    expect(setProgress).toHaveBeenLastCalledWith({ current: 1, total: 1 });
    expect(tryStartSourceAccess).not.toHaveBeenCalled();
    expect(pluginMocks.loadInstalledFromDb).not.toHaveBeenCalled();
    expect(pluginMocks.getPluginForExecutor).not.toHaveBeenCalled();
  });

  it("surfaces a server failure without trying plugin source access", async () => {
    vi.mocked(tryDownloadServerChapter).mockRejectedValueOnce(new Error("Content server unavailable"));
    enqueueChapterDownload({ id: 7, novelId: 3, pluginId: "source-a", chapterPath: "/chapter/7", title: "Chapter 7" });
    if (!capturedSpec) throw new Error("Task spec was not captured.");
    const tryStartSourceAccess = vi.fn(() => true);
    await expect(capturedSpec.run({ setDetail: vi.fn(), setProgress: vi.fn(), signal: new AbortController().signal, taskId: "task-1", tryStartSourceAccess })).rejects.toThrow("Content server unavailable");
    expect(tryStartSourceAccess).not.toHaveBeenCalled();
    expect(pluginMocks.getPluginForExecutor).not.toHaveBeenCalled();
  });

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

  it.each(["visible", "hidden"])("removes explicit user cancellation from persistent storage while %s", async (visibilityState) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: visibilityState });
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const deferred = createDeferred<void>();
    schedulerMocks.enqueueSource.mockReturnValue({ id: "cancel-test", promise: deferred.promise });
    const handle = enqueueChapterDownload({ id: 71, pluginId: "source-a", chapterPath: "/chapter/71", title: "Cancel test" });
    await waitForChapterDownloadQueueMutations();
    expect(backendQueueValues.has(71)).toBe(true);
    const checked = expect(handle.promise).rejects.toMatchObject({ name: "AbortError", cancelledByUser: true });
    deferred.reject(new TaskUserCancelledError());
    await checked;
    await flushMicrotasks();
    await waitForChapterDownloadQueueMutations();
    expect(backendQueueValues.has(71)).toBe(false);
  });

  it("retains a genuine hidden lifecycle interruption for restoration", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const deferred = createDeferred<void>();
    schedulerMocks.enqueueSource.mockReturnValue({ id: "suspend-test", promise: deferred.promise });
    const handle = enqueueChapterDownload({ id: 72, pluginId: "source-a", chapterPath: "/chapter/72", title: "Suspend test" });
    await waitForChapterDownloadQueueMutations();
    const checked = expect(handle.promise).rejects.toMatchObject({ name: "AbortError" });
    deferred.reject(new DOMException("WebView suspended", "AbortError"));
    await checked;
    await flushMicrotasks();
    await waitForChapterDownloadQueueMutations();
    expect(backendQueueValues.has(72)).toBe(true);
  });

  it("gives downloads a transient-only automatic retry policy", () => {
    enqueueChapterDownload({ id: 73, pluginId: "source-a", chapterPath: "/chapter/73", title: "Retry test" });
    if (!capturedSpec) throw new Error("Missing task spec");
    expect(capturedSpec.retry?.(new TypeError("Failed to fetch"), 1)).toMatchObject({ delayMs: 5000 });
    expect(capturedSpec.retry?.(new Error("HTTP 404 Not Found"), 1)).toBeNull();
    expect(capturedSpec.retry?.(new TaskUserCancelledError(), 1)).toBeNull();
  });

  it.each(["download", "repair"] as const)("isolates each asset retry budget from VPN recovery for %s", (operation) => {
    if (operation === "download") {
      enqueueChapterDownload({ id: 7, pluginId: "source-a", chapterPath: "/chapter/7", title: "Chapter 7" });
    } else {
      enqueueChapterMediaRepair({ id: 7, pluginId: "source-a", title: "Chapter 7" });
    }
    if (!capturedSpec?.retry) throw new Error("Missing task retry policy");
    const retry = capturedSpec.retry;
    const vpnError = Object.assign(new Error("Plugin VPN is unavailable."), { code: "plugin-vpn-unavailable" });
    for (let attempt = 1; attempt <= 4; attempt += 1) expect(retry(vpnError, attempt)).not.toBeNull();
    const missing = new ChapterMediaIncompleteError([
      { fileName: "missing.jpg", message: "Failed to fetch", url: "https://media.test/missing.jpg" },
    ]);
    const other = new ChapterMediaIncompleteError([
      { fileName: "other.jpg", message: "Failed to fetch", url: "https://media.test/other.jpg" },
    ]);
    expect(retry(missing, 5)?.delayMs).toBe(5000);
    expect(retry(other, 6)?.delayMs).toBe(5000);
    expect(retry(missing, 7)?.delayMs).toBe(15000);
    expect(retry(missing, 8)?.delayMs).toBe(30000);
    expect(retry(missing, 9)?.delayMs).toBe(60000);
    expect(retry(missing, 10)).toBeNull();
    expect(retry(other, 11)?.delayMs).toBe(15000);
    expect(retry(missing, 1)?.delayMs).toBe(5000);
  });

  it("keeps an unavailable-VPN job resumable instead of discarding it", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const vpnError = Object.assign(
      new Error("Plugin VPN is unavailable."),
      { code: "plugin-vpn-unavailable" as const },
    );
    schedulerMocks.enqueueSource.mockImplementationOnce(
      (spec: SourceTaskSpec<void>) => {
        capturedSpec = spec;
        return { id: "task-1", promise: Promise.reject(vpnError) };
      },
    );

    const handle = enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      title: "Chapter 7",
    });

    await expect(handle.promise).rejects.toBe(vpnError);
    await flushMicrotasks();

    expect([...backendQueueValues.keys()]).toEqual([7]);
    expect(
      tauriMocks.invoke.mock.calls.filter(
        ([command]) => command === "chapter_download_queue_remove",
      ),
    ).toHaveLength(0);
  });

  it.each(["source", "server", "local"] as const)(
    "removes a retained VPN job after a manual retry completes from %s",
    async (completion) => {
      vi.mocked(isTauriRuntime).mockReturnValue(true);
      pluginMocks.loadInstalledFromDb.mockResolvedValue(undefined);
      const vpnError = Object.assign(new Error("Plugin VPN is unavailable."), {
        code: "plugin-vpn-unavailable" as const,
      });
      schedulerMocks.enqueueSource.mockImplementationOnce((spec: SourceTaskSpec<void>) => {
        capturedSpec = spec;
        return { id: "original-download", promise: Promise.reject(vpnError) };
      });
      const handle = enqueueChapterDownload({
        id: 7, pluginId: "source-a", chapterPath: "/chapter/7", title: "Chapter 7",
      });
      await expect(handle.promise).rejects.toBe(vpnError);
      await waitForChapterDownloadQueueMutations();
      expect(backendQueueValues.has(7)).toBe(true);
      if (!capturedSpec) throw new Error("Missing task spec");
      if (completion === "server") vi.mocked(tryDownloadServerChapter).mockResolvedValue(true);
      if (completion === "local") {
        vi.mocked(getChapterById).mockResolvedValue({ id: 7, isDownloaded: true } as never);
      }

      // Scheduler retries replay the spec without the original handle's observers.
      await capturedSpec.run({
        setDetail: vi.fn(), setProgress: vi.fn(),
        signal: new AbortController().signal, taskId: "retried-download",
      });
      await waitForChapterDownloadQueueMutations();

      expect(backendQueueValues.has(7)).toBe(false);
      expect(tauriMocks.invoke.mock.calls.filter(
        ([command]) => command === "chapter_download_queue_remove",
      )).toHaveLength(1);
    },
  );

  it("keeps a queued job when source access defers its run", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    enqueueChapterDownload({
      id: 7, pluginId: "source-a", chapterPath: "/chapter/7", title: "Chapter 7",
    });
    await waitForChapterDownloadQueueMutations();
    if (!capturedSpec) throw new Error("Missing task spec");

    await capturedSpec.run({
      setDetail: vi.fn(), setProgress: vi.fn(),
      signal: new AbortController().signal, taskId: "deferred-download",
      tryStartSourceAccess: () => false,
    });
    await waitForChapterDownloadQueueMutations();

    expect(backendQueueValues.has(7)).toBe(true);
    expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
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

  it("skips a completed chapter without filesystem, plugin, or network work", async () => {
    const getBaseUrl = vi.fn(() => "https://source.test");
    pluginMocks.getPlugin.mockReturnValueOnce({
      apiVersion: "0.2",
      id: "source-a",
      name: "Source A",
      getBaseUrl,
      getChapterAcquisitionPlan: pluginMocks.getChapterAcquisitionPlan,
      getChapterResource: pluginMocks.getChapterResource,
    });
    vi.mocked(getChapterById).mockResolvedValueOnce({
      id: 7, contentType: "html", isDownloaded: true,
    } as never);
    vi.mocked(reconcileStoredChapterContent).mockRejectedValueOnce(
      new Error("Completed downloads must not be rescanned."),
    );

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
    expect(getChapterById).toHaveBeenCalledWith(7);
    expect(reconcileStoredChapterContent).not.toHaveBeenCalled();
    expect(readStoredChapterContentMirror).not.toHaveBeenCalled();
    expect(readStoredChapterPartialContentMirror).not.toHaveBeenCalled();
    expect(tryDownloadServerChapter).not.toHaveBeenCalled();
  });

  it("checks the current download state after a concurrent deletion finishes", async () => {
    const removing = createDeferred<void>();
    const deletion = withChapterDownloadDeletion([7], () => removing.promise);
    vi.mocked(getChapterById).mockResolvedValue({
      id: 7, contentType: "html", isDownloaded: true,
    } as never);
    vi.mocked(tryDownloadServerChapter).mockResolvedValue(true);
    enqueueChapterDownload({
      id: 7, pluginId: "source-a", chapterPath: "/chapter/7", title: "Chapter 7",
    });
    if (!capturedSpec) throw new Error("Task spec was not captured.");
    const pending = capturedSpec.run({
      executor: "pool:1",
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });
    try {
      await flushMicrotasks();
      expect(getChapterById).not.toHaveBeenCalled();
      expect(tryDownloadServerChapter).not.toHaveBeenCalled();
      vi.mocked(getChapterById).mockResolvedValue({
        id: 7, contentType: "html", isDownloaded: false,
      } as never);
    } finally {
      removing.resolve();
      await Promise.all([deletion, pending]);
    }
    expect(getChapterById).toHaveBeenCalledWith(7);
    expect(tryDownloadServerChapter).toHaveBeenCalledOnce();
    expect(reconcileStoredChapterContent).not.toHaveBeenCalled();
  });

  it("returns to the scheduler before plugin work when source access is deferred", async () => {
    const tryStartSourceAccess = vi.fn(() => false);
    const setChapterDownloadPhase = vi.fn();
    vi.mocked(tryDownloadServerChapter).mockImplementationOnce(async (_job, _signal, onPhase) => {
      onPhase?.("server-lookup");
      return false;
    });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      executor: "pool:1",
      setChapterDownloadPhase,
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
      tryStartSourceAccess,
    });

    expect(getChapterById).toHaveBeenCalledWith(7);
    expect(reconcileStoredChapterContent).not.toHaveBeenCalled();
    expect(tryStartSourceAccess).toHaveBeenCalledOnce();
    expect(setChapterDownloadPhase.mock.calls).toEqual([["local"], ["server-lookup"], ["source-download"]]);
    expect(pluginMocks.loadInstalledFromDb).not.toHaveBeenCalled();
    expect(pluginMocks.getPluginForExecutor).not.toHaveBeenCalled();
    expect(pluginMocks.getChapterAcquisitionPlan).not.toHaveBeenCalled();
    expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
    expect(acquisitionMocks.captureChapterPage).not.toHaveBeenCalled();
  });

  it("does not start network work when the download state cannot be read", async () => {
    const storageError = new Error("Database is unavailable.");
    const tryStartSourceAccess = vi.fn(() => true);
    vi.mocked(getChapterById).mockRejectedValueOnce(storageError);

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
    expect(tryDownloadServerChapter).not.toHaveBeenCalled();
    expect(pluginMocks.loadInstalledFromDb).not.toHaveBeenCalled();
    expect(pluginMocks.getPluginForExecutor).not.toHaveBeenCalled();
    expect(pluginMocks.getChapterAcquisitionPlan).not.toHaveBeenCalled();
    expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
    expect(acquisitionMocks.captureChapterPage).not.toHaveBeenCalled();
  });

  it("reacquires final content when verifying source access", async () => {
    const confirmSourceAccess = vi.fn(() => true);
    const setSourceAccessUrl = vi.fn(() => true);
    vi.mocked(getChapterById).mockResolvedValueOnce({
      id: 7, contentType: "text", isDownloaded: true,
    } as never);

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

    await vi.waitFor(() => expect(pluginMocks.loadInstalledFromDb).toHaveBeenCalledTimes(1));

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

  it("keeps partial content without marking the chapter downloaded after VPN wait expiry", async () => {
    const vpnError = Object.assign(new Error("Plugin VPN is unavailable."), {
      code: "plugin-vpn-unavailable" as const,
    });
    vi.mocked(getChapterById).mockResolvedValueOnce({ contentType: "html", id: 7, isDownloaded: false } as never);
    pluginMocks.getChapterResource.mockResolvedValueOnce(contentResource('<img src="https://source.test/page.png">'));
    vi.mocked(cacheHtmlChapterMedia).mockRejectedValueOnce(vpnError);
    enqueueChapterDownload({
      id: 7, pluginId: "source-a", chapterPath: "/chapter/7", contentType: "html", title: "Chapter 7",
    });
    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await expect(capturedSpec.run({
      executor: "pool:1", setDetail: vi.fn(), setProgress: vi.fn(),
      signal: new AbortController().signal, taskId: "task-1",
    })).rejects.toBe(vpnError);
    expect(saveStoredChapterPartialContent).toHaveBeenCalled();
    expect(saveStoredChapterContent).not.toHaveBeenCalled();
    expect(clearChapterMedia).not.toHaveBeenCalled();
  });

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

  it("verifies the requested source after a page redirects to a new hostname", async () => {
    const confirmSourceAccess = vi.fn(() => true);
    const setSourceAccessUrl = vi.fn(
      (url: string) => new URL(url).hostname === "source.test",
    );
    const storedHtml = `<img src="norea-media://reader-asset/page.png">`;
    pluginMocks.getChapterAcquisitionPlan.mockReturnValueOnce({
      type: "page",
      url: "https://source.test/chapter/7",
      contentSelector: "article.chapter",
    });
    acquisitionMocks.captureChapterPage.mockResolvedValueOnce({
      baseUrl: "https://source-new.test/chapter/7",
      content: `<img src="https://cdn.test/page.png?accessKey=signed">`,
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
    expect(setSourceAccessUrl).toHaveBeenCalledExactlyOnceWith(
      "https://source.test/chapter/7",
    );
    expect(cacheHtmlChapterMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://source-new.test/chapter/7",
        sourceAccessUrl: "https://source.test/chapter/7",
        html: `<img src="https://cdn.test/page.png?accessKey=signed">`,
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

    expect(pluginMocks.getChapterResource).toHaveBeenCalledWith(
      "/chapter/7",
      "html",
    );
    expect(cacheHtmlChapterMedia).toHaveBeenCalledWith(
      expect.objectContaining({
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

  it("never marks an offline chapter complete when a media result contains failures", async () => {
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
    await expect(capturedSpec.run({
      setDetail,
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    })).rejects.toMatchObject({ code: "chapter-media-incomplete" });

    expect(cacheHtmlChapterMedia).toHaveBeenCalledWith(expect.objectContaining({ requireComplete: true }));
    expect(saveStoredChapterContent).not.toHaveBeenCalled();
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
  it("keeps repair cooldowns separate for plugins sharing a hostname", () => {
    pluginMocks.getPlugin.mockImplementation((id: string) => ({
      id, name: id, getBaseUrl: () => "https://source.test",
    }));
    enqueueChapterMediaRepair({ id: 7, pluginId: "source-a", title: "Chapter 7" });
    enqueueChapterMediaRepair({ id: 8, pluginId: "source-b", title: "Chapter 8" });
    const specs = schedulerMocks.enqueueSource.mock.calls.map(([spec]) => spec as SourceTaskSpec<void>);
    expect(specs.map(spec => spec.sourceCooldownKey)).toEqual([
      "chapter.download:source-a", "chapter.download:source-b",
    ]);
  });

  it.each(["html", "epub"])("repairs stored %s assets without replacing the package or refreshing the body", async (contentType) => {
    const storedHtml = `<p>Original body</p><img src="norea-media://reader-asset/page.png">`;
    vi.mocked(tryDownloadServerChapter).mockResolvedValueOnce(true);
    pluginMocks.getChapterResource.mockResolvedValueOnce(contentResource("<p>Source removed its images</p>"));
    vi.mocked(readStoredChapterContentMirror).mockResolvedValueOnce(storedHtml);
    vi.mocked(getChapterById).mockResolvedValueOnce({
      id: 7, novelId: 11, path: "/chapter/7", name: "Chapter 7", position: 7,
      chapterNumber: "7", contentType, sourceContentType: contentType,
      isDownloaded: true, mediaRepairNeeded: true,
    } as never);
    vi.mocked(cacheHtmlChapterMedia).mockResolvedValueOnce({
      html: storedHtml, mediaBytes: 8, mediaFailures: [], storedMediaCount: 1,
    });
    vi.mocked(getStoredChapterMediaBytes).mockResolvedValueOnce(8);
    enqueueChapterMediaRepair({ id: 7, pluginId: "source-a", title: "Chapter 7" });
    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      setDetail: vi.fn(), setProgress: vi.fn(),
      signal: new AbortController().signal, taskId: "task-1",
    });
    expect(tryDownloadServerChapter).not.toHaveBeenCalled();
    expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
    expect(acquisitionMocks.captureChapterPage).not.toHaveBeenCalled();
    expect(clearChapterMedia).not.toHaveBeenCalled();
    expect(cacheHtmlChapterMedia).toHaveBeenCalledWith(expect.objectContaining({
      html: storedHtml, repair: true, requireComplete: true,
    }));
    expect(saveStoredChapterContent).toHaveBeenCalledWith(7, storedHtml, contentType, { mediaBytes: 8 });
  });

  it("repairs manifest assets even when the stored body does not reference them", async () => {
    vi.mocked(cacheHtmlChapterMedia).mockResolvedValueOnce({ html: "<p>Original body</p>", mediaBytes: 81, mediaFailures: [], storedMediaCount: 1 });
    const storedHtml = "<p>Original body</p>";
    vi.mocked(readStoredChapterContentMirror).mockResolvedValueOnce(storedHtml);
    vi.mocked(hasRemoteChapterMedia).mockReturnValueOnce(false);
    vi.mocked(localChapterMediaSources).mockReturnValueOnce([]);
    enqueueChapterMediaRepair({ id: 7, pluginId: "source-a", title: "Chapter 7" });
    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      setDetail: vi.fn(), setProgress: vi.fn(),
      signal: new AbortController().signal, taskId: "task-1",
    });
    expect(saveStoredChapterContent).toHaveBeenCalledWith(7, storedHtml, "html", { mediaBytes: 81 });
    expect(clearChapterMedia).not.toHaveBeenCalled();
    expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
    expect(cacheHtmlChapterMedia).toHaveBeenCalledWith(expect.objectContaining({ html: storedHtml, repair: true }));
  });
  it("finishes local-only repair without requiring an installed source or contacting a server", async () => {
    pluginMocks.getPlugin.mockReturnValue(undefined);
    vi.mocked(readStoredChapterContentMirror).mockResolvedValueOnce("<p>Stored body</p>");
    vi.mocked(cacheHtmlChapterMedia).mockResolvedValueOnce({ html: "<p>Stored body</p>", mediaBytes: 25, mediaFailures: [], storedMediaCount: 0 });
    enqueueChapterMediaRepair({ id: 7, pluginId: "source-a", title: "Chapter 7" });
    if (!capturedSpec) throw new Error("Task spec was not captured.");
    const tryStartSourceAccess = vi.fn(() => false);
    await capturedSpec.run({ setDetail: vi.fn(), setProgress: vi.fn(), signal: new AbortController().signal, taskId: "task-1", tryStartSourceAccess });
    expect(pluginMocks.getPluginForExecutor).not.toHaveBeenCalled();
    expect(tryStartSourceAccess).not.toHaveBeenCalled();
    expect(serverMediaMocks.fetch).not.toHaveBeenCalled();
    expect(saveStoredChapterContent).toHaveBeenCalledWith(7, "<p>Stored body</p>", "html", { mediaBytes: 25 });
  });

  it("rejects every concurrent missing asset when the source scope is invalid", async () => {
    vi.mocked(readStoredChapterContentMirror).mockResolvedValueOnce("<p>Stored body</p>");
    vi.mocked(cacheHtmlChapterMedia).mockImplementationOnce(async options => {
      const results = await Promise.allSettled(["one.png", "two.png"].map(fileName => options.fetchMissingMedia!({
        bytes: 3, fileName, path: `media/${fileName}`, sourceUrl: `https://source.test/${fileName}`, status: "remote", updatedAt: 1,
      })));
      expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
      throw new Error("Source scope rejected");
    });
    enqueueChapterMediaRepair({ id: 7, pluginId: "source-a", title: "Chapter 7" });
    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await expect(capturedSpec.run({ setDetail: vi.fn(), setProgress: vi.fn(), signal: new AbortController().signal, taskId: "task-1", setSourceAccessUrl: () => false })).rejects.toThrow("Source scope rejected");
    expect(saveStoredChapterContent).not.toHaveBeenCalled();
  });

  it("settles a deferred source attempt normally so the scheduler can requeue the repair", async () => {
    vi.mocked(readStoredChapterContentMirror).mockResolvedValueOnce("<p>Stored body</p>");
    vi.mocked(cacheHtmlChapterMedia).mockImplementationOnce(async options => {
      await options.fetchMissingMedia!({ bytes: 3, fileName: "one.png", path: "media/one.png", sourceUrl: "https://source.test/one.png", status: "remote", updatedAt: 1 });
      throw new Error("A deferred source must stop media acquisition");
    });
    enqueueChapterMediaRepair({ id: 7, pluginId: "source-a", title: "Chapter 7" });
    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await expect(capturedSpec.run({ setDetail: vi.fn(), setProgress: vi.fn(), signal: new AbortController().signal, taskId: "task-1", tryStartSourceAccess: () => false })).resolves.toBeUndefined();
    expect(saveStoredChapterContent).not.toHaveBeenCalled();
  });

});
