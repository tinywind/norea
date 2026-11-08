import { beforeEach, describe, expect, it, vi } from "vitest";
import { taskScheduler, type SourceTaskSpec, type TaskHandle } from "./scheduler";
vi.mock("../android-scraper", () => ({ androidEnsureVpnDownloadWorker: vi.fn(async () => undefined) }));

const recoveryHarness = vi.hoisted(() => ({ current: null as unknown as import("./download-recovery").DownloadRecoveryController }));
vi.mock("./download-recovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./download-recovery")>();
  return { ...actual, downloadRecovery: new Proxy({} as typeof actual.downloadRecovery, {
    get: (_target, key) => {
      const value = Reflect.get(recoveryHarness.current, key);
      return typeof value === "function" ? value.bind(recoveryHarness.current) : value;
    },
  }) };
});
import { DownloadRecoveryController } from "./download-recovery";
import { HttpStatusError } from "../http/status-error";
import { getDownloadRecoveryPolicy, useDownloadRecoveryStore } from "../../store/download-recovery";
const siteRecoveryMocks = vi.hoisted(() => ({ reset: vi.fn<(_source: string, _url: string) => Promise<void>>() }));
vi.mock("../site-browser/session", () => ({ resetSourceSiteData: siteRecoveryMocks.reset }));


const schedulerMocks = vi.hoisted(() => ({
  batch: vi.fn((run: () => void) => run()),
  enqueueSource: vi.fn(),
  holdOrdinary: vi.fn<() => (() => void)>(() => () => undefined),
}));
const queueMocks = vi.hoisted(() => ({ list: vi.fn(), adopt: vi.fn() }));
const failureQueryMocks = vi.hoisted(() => ({ clearScheduledRetries: vi.fn(async () => 0) }));
vi.mock("../../db/queries/chapter-download-failure", () => ({ clearScheduledChapterDownloadRetries: failureQueryMocks.clearScheduledRetries }));
vi.mock("../../db/queries/chapter-download-queue", () => ({
  listOrdinaryChapterDownloadJobs: queueMocks.list,
  adoptOrdinaryChapterDownloadJobs: queueMocks.adopt,
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
  listExistingChapterIds: vi.fn(),
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
vi.mock("../plugins/sync-novel", () => ({ syncNovelFromSource: vi.fn() }));
const failureMocks = vi.hoisted(() => ({
  record: vi.fn(async (): Promise<{ nextRetryAt: number | null } | null> => null),
  forget: vi.fn(async () => undefined),
  refresh: vi.fn(async (): Promise<void> => undefined),
  snapshot: vi.fn((): StoredChapterDownloadFailure[] => []),
}));
vi.mock("./chapter-download-failures", () => ({
  recordFailedChapterDownloadAttempt: failureMocks.record,
  forgetChapterDownloadFailures: failureMocks.forget,
  refreshChapterDownloadFailures: failureMocks.refresh,
  getChapterDownloadFailureSnapshot: failureMocks.snapshot,
}));
vi.mock("./scheduler", () => ({
  TASK_PAUSE_ABORT_MESSAGE: "Task was paused.",
  taskScheduler: {
    batch: schedulerMocks.batch,
    holdOrdinaryChapterDownloads: schedulerMocks.holdOrdinary,
    enqueueSource: schedulerMocks.enqueueSource,
    getSnapshot: vi.fn(() => ({ records: [], sourceAccessBlocks: [] })),
    getTaskByDedupeKey: vi.fn(),
    cancel: vi.fn(),
    waitForSourceTaskSettlement: vi.fn(async () => undefined),
    subscribeEvents: vi.fn(() => () => undefined),
    forgetSettledTask: vi.fn(),
    reportDownloadFailure: vi.fn(),
    resumeSourceQueue: vi.fn(),
  },
}));

import { getChapterById, listExistingChapterIds } from "../../db/queries/chapter";
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
import type { ChapterResource } from "../plugins/types";
import type { PluginVpnDownloadWorkerStatus } from "../plugin-vpn-download-workers";
import type { ScraperExecutorId } from "./scraper-queue";
import type { VpnDownloadWorkerRef } from "./vpn-download-types";
import { isTauriRuntime } from "../tauri-runtime";
import { watchChapterDownloadActivity } from "./chapter-download-activity";
import { tryDownloadServerChapter } from "../content-sync/novel-source";
import { syncNovelFromSource } from "../plugins/sync-novel";
import { isPluginVpnUnavailableError } from "../plugin-vpn-traffic";
import { TaskUserCancelledError } from "./task-errors";
import { runExclusiveChapterStorageOperation } from "./chapter-storage-operation";
import { installChapterDownloadBatchInterceptor } from "./chapter-download-batch-interceptor";
import { withChapterDownloadDeletion } from "../chapter-download-writes";
import {
  cancelChapterDownloadBatches,
  cancelChapterDownloadTasks,
  enqueueChapterDownloadBatch,
  enqueueChapterDownload,
  failedChapterDownloadJob,
  retryFailedChapterDownloads,
  enqueueVpnDownloadChapter,
  releaseVpnDownloadPlanLocalWorkScans,
  enqueueChapterMediaRepair,
  discardQueuedChapterDownloads,
  getActiveChapterDownloadBatchProgress,
  getChapterDownloadBatchProgress,
  subscribeChapterDownloadBatchProgress,
  isChapterDownloadQueued,
  startChapterDownloadQueueExecutor,
  subscribeChapterDownloadBatchesSettled,
  waitForChapterDownloadQueueMutations,
  waitForChapterDownloadQueueRestoration,
  type ChapterDownloadJob,
} from "./chapter-download";
import type { StoredQueuedChapterDownload } from "../../db/queries/chapter-download-queue";
import type { StoredChapterDownloadFailure } from "../../db/queries/chapter-download-failure";

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
  const recoveryValues = new Map<string, string>();
  recoveryHarness.current = new DownloadRecoveryController({
    getItem: key => recoveryValues.get(key) ?? null,
    setItem: (key, value) => { recoveryValues.set(key, value); },
  });
  vi.clearAllMocks();
  installChapterDownloadBatchInterceptor({ enqueue: () => null, cancel: () => false });
  vi.mocked(taskScheduler.getTaskByDedupeKey).mockReset();
  vi.mocked(taskScheduler.getSnapshot).mockReset().mockReturnValue({ records: [], sourceAccessBlocks: [] } as never);
  vi.mocked(taskScheduler.cancel).mockReset();
  vi.mocked(taskScheduler.reportDownloadFailure).mockReset();
  vi.mocked(taskScheduler.resumeSourceQueue).mockReset();
  failureQueryMocks.clearScheduledRetries.mockReset().mockResolvedValue(0);
  failureMocks.refresh.mockReset().mockResolvedValue(undefined);
  failureMocks.snapshot.mockReset().mockReturnValue([]);
  vi.mocked(taskScheduler.waitForSourceTaskSettlement).mockReset().mockResolvedValue(undefined);
  backendQueueValues.clear();
  schedulerMocks.holdOrdinary.mockReset().mockReturnValue(() => undefined);
  queueMocks.list.mockReset().mockImplementation(async () => [...backendQueueValues.values()].map(job => ({
    job: job as ChapterDownloadJob, jobJson: JSON.stringify(job), updatedAtMs: 0,
  })).filter(row => row.job.vpnBatchId == null && row.job.vpnPlanId == null));
  queueMocks.adopt.mockReset().mockImplementation(async (batchId: string, expected: StoredQueuedChapterDownload[]) => {
    const jobs = expected.map(row => {
      if (JSON.stringify(backendQueueValues.get(row.job.id)) !== row.jobJson) throw new Error("Stale queue owner");
      return { ...row.job, vpnBatchId: batchId };
    });
    for (const job of jobs) backendQueueValues.set(job.id, job);
    return jobs;
  });
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
  tauriMocks.invoke.mockReset().mockImplementation(
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

describe("ordinary to VPN handover", () => {
  it("recognizes pending VPN intent before an ordinary task or queue row is materialized", () => {
    installChapterDownloadBatchInterceptor({ enqueue: () => null, cancel: () => false, isQueued: id => id === 900070 });
    expect(isChapterDownloadQueued(900070)).toBe(true);
    expect(isChapterDownloadQueued(900071)).toBe(false);
  });

  async function setup(paused = false) {
    const { TaskScheduler } = await vi.importActual<typeof import("./scheduler")>("./scheduler");
    const scheduler = new TaskScheduler({ sourceForegroundConcurrency: 1, sourceQueuesPaused: paused });
    schedulerMocks.enqueueSource.mockImplementation((spec: SourceTaskSpec<void>) => scheduler.enqueueSource(spec));
    schedulerMocks.holdOrdinary.mockImplementation(() => scheduler.holdOrdinaryChapterDownloads());
    vi.mocked(taskScheduler.getTaskByDedupeKey).mockImplementation(key => scheduler.getTaskByDedupeKey(key));
    vi.mocked(taskScheduler.getSnapshot).mockImplementation(() => scheduler.getSnapshot());
    vi.mocked(taskScheduler.cancel).mockImplementation(id => scheduler.cancel(id));
    vi.mocked(taskScheduler.waitForSourceTaskSettlement).mockImplementation(id => scheduler.waitForSourceTaskSettlement(id));
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    return scheduler;
  }
  const job = (id: number) => ({ id, novelId: 11, pluginId: `source-${id}`, chapterPath: `/chapter/${id}`, title: `Chapter ${id}` });

  it("transfers ready jobs while another chapter finishes and never recreates its successful download", async () => {
    const scheduler = await setup();
    const finish = createDeferred<boolean>();
    vi.mocked(tryDownloadServerChapter).mockImplementation(async value => value.id === 900061 ? finish.promise : true);
    const active = enqueueChapterDownload(job(900061));
    const queued = enqueueChapterDownload(job(900062));
    void active.promise.catch(() => undefined); void queued.promise.catch(() => undefined);
    await vi.waitFor(() => expect(tryDownloadServerChapter).toHaveBeenCalled());
    const { beginChapterDownloadVpnHandover } = await import("./chapter-download");
    const handover = await beginChapterDownloadVpnHandover();
    try {
      expect(handover.pending.map(row => row.job.job.id)).toEqual([900061]);
      expect((await handover.commitReady("run-a")).map(row => row.id)).toEqual([900062]);
      expect(scheduler.getTask(active.id)?.status).toBe("running");
      expect(scheduler.getTask(queued.id)?.status).toBe("cancelled");
      await waitForChapterDownloadQueueMutations();
      expect(backendQueueValues.get(900062)).toMatchObject({ vpnBatchId: "run-a" });
      finish.resolve(true);
      await handover.pending[0]!.settled;
      expect(await handover.commitReady("run-a")).toEqual([]);
      expect(backendQueueValues.has(900061)).toBe(false);
      expect(backendQueueValues.get(900062)).toMatchObject({ vpnBatchId: "run-a" });
    } finally { finish.resolve(true); handover.release(); scheduler.cancelActiveTasks({ discardQueued: true }); await active.promise.catch(() => undefined); }
  });

  it("retains a failed in-flight chapter for the VPN owner instead of deleting its requested intent", async () => {
    const scheduler = await setup();
    const finish = createDeferred<boolean>();
    vi.mocked(tryDownloadServerChapter).mockReturnValue(finish.promise);
    const active = enqueueChapterDownload(job(900063));
    void active.promise.catch(() => undefined);
    await vi.waitFor(() => expect(tryDownloadServerChapter).toHaveBeenCalled());
    const { beginChapterDownloadVpnHandover } = await import("./chapter-download");
    const handover = await beginChapterDownloadVpnHandover();
    try {
      expect(await handover.commitReady("run-a")).toEqual([]);
      finish.reject(new Error("Connection lost"));
      await handover.pending[0]!.settled;
      expect((await handover.commitReady("run-a")).map(row => row.id)).toEqual([900063]);
      expect(backendQueueValues.get(900063)).toMatchObject({ vpnBatchId: "run-a" });
    } finally { finish.resolve(true); handover.release(); scheduler.cancelActiveTasks({ discardQueued: true }); }
  });

  it("releases only its own dispatch hold when adoption fails and leaves the ordinary request usable", async () => {
    const scheduler = await setup(true);
    vi.mocked(tryDownloadServerChapter).mockResolvedValue(true);
    const queued = enqueueChapterDownload(job(900064));
    const { beginChapterDownloadVpnHandover } = await import("./chapter-download");
    const handover = await beginChapterDownloadVpnHandover();
    scheduler.resumeSourceQueue();
    queueMocks.adopt.mockRejectedValueOnce(new Error("Queue transaction failed"));
    try {
      await expect(handover.commitReady("run-a")).rejects.toThrow("Queue transaction failed");
      expect(scheduler.getTask(queued.id)?.status).toBe("queued");
      handover.release(); handover.release();
      await queued.promise;
      expect(scheduler.getTask(queued.id)?.status).toBe("succeeded");
      expect(backendQueueValues.has(900064)).toBe(false);
    } finally { handover.release(); scheduler.cancelActiveTasks({ discardQueued: true }); }
  });

  it("honors user cancellation of an in-flight handover chapter instead of adopting it later", async () => {
    const scheduler = await setup();
    const finish = createDeferred<boolean>();
    vi.mocked(tryDownloadServerChapter).mockReturnValue(finish.promise);
    const active = enqueueChapterDownload(job(900065));
    void active.promise.catch(() => undefined);
    await vi.waitFor(() => expect(tryDownloadServerChapter).toHaveBeenCalled());
    const { beginChapterDownloadVpnHandover } = await import("./chapter-download");
    const handover = await beginChapterDownloadVpnHandover();
    try {
      const cancelling = cancelChapterDownloadTasks([900065]);
      finish.resolve(true);
      await cancelling;
      await handover.pending[0]!.settled;
      expect(await handover.commitReady("run-a")).toEqual([]);
      expect(backendQueueValues.has(900065)).toBe(false);
    } finally { finish.resolve(true); handover.release(); scheduler.cancelActiveTasks({ discardQueued: true }); }
  });

  it("does not materialize old ordinary tasks for jobs already transferred outside the batch window", async () => {
    const scheduler = await setup(true);
    const batch = enqueueChapterDownloadBatch({ jobs: [job(900066), job(900067), job(900068)], title: "Original request", materializeAllTasks: true, windowSize: 1 });
    void batch.promise.catch(() => undefined);
    const { beginChapterDownloadVpnHandover } = await import("./chapter-download");
    const handover = await beginChapterDownloadVpnHandover();
    try {
      expect((await handover.commitReady("run-a")).map(row => row.id)).toEqual([900066, 900067, 900068]);
      await batch.materialized;
      expect(scheduler.getSnapshot().records.some(task => task.status === "queued" || task.status === "running")).toBe(false);
      expect([...backendQueueValues.values()].every(value => (value as ChapterDownloadJob).vpnBatchId === "run-a")).toBe(true);
    } finally { handover.release(); scheduler.cancelActiveTasks({ discardQueued: true }); }
  });
});

describe("VPN range chapter acquisition", () => {
  const worker = { rangeId: "range-a", slot: 0, generation: 8 } as const;
  const connected: PluginVpnDownloadWorkerStatus = {
    supported: true, worker, phase: "connected", proxyPort: 12000, error: null,
    profile: { id: "profile-a", ip: "192.0.2.1", protocol: "tcp", hash: "a".repeat(64), approvedAt: 1, approvalSequence: 1 },
  };
  const job: ChapterDownloadJob = {
    id: 7, pluginId: "source-a", chapterPath: "/chapter/7", title: "Chapter 7",
    novelId: 11, vpnPlanId: "plan-a", vpnRangeId: "range-a",
  };

  beforeEach(() => {
    const invoke = tauriMocks.invoke.getMockImplementation()!;
    tauriMocks.invoke.mockImplementation((command, args) => command === "plugin_vpn_download_worker_validate"
      ? Promise.resolve(connected) : invoke(command, args));
  });

  it("waits for authoritative lease validation at execution time before reading or acquiring a chapter", async () => {
    const validation = createDeferred<PluginVpnDownloadWorkerStatus>();
    tauriMocks.invoke.mockImplementationOnce(() => validation.promise);
    let completed = false;
    enqueueVpnDownloadChapter(job, worker, async () => { completed = true; });
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
    const running = capturedSpec!.run({ executor: "vpn:0:8", setDetail: vi.fn(), setProgress: vi.fn(),
      signal: new AbortController().signal, taskId: "task-1" });
    await flushMicrotasks();
    try {
      expect(tauriMocks.invoke).toHaveBeenCalledExactlyOnceWith("plugin_vpn_download_worker_validate", { worker });
      expect(getChapterById).not.toHaveBeenCalled();
      expect(tryDownloadServerChapter).not.toHaveBeenCalled();
      expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
      expect(saveStoredChapterContent).not.toHaveBeenCalled();
      expect(completed).toBe(false);
    } finally { validation.resolve(connected); await running; }
    expect(pluginMocks.getPluginForExecutor).toHaveBeenCalledWith("source-a", "vpn:0:8");
    expect(pluginMocks.getChapterResource).toHaveBeenCalledOnce();
    expect(saveStoredChapterContent).toHaveBeenCalledOnce();
    expect(completed).toBe(true);
  });

  it("rechecks approval for the next chapter on an already connected worker", async () => {
    let completed = 0;
    enqueueVpnDownloadChapter(job, worker, async () => { completed++; });
    const context = { executor: "vpn:0:8" as const, setDetail: vi.fn(), setProgress: vi.fn(),
      signal: new AbortController().signal, taskId: "task-1" };
    await capturedSpec!.run(context);
    const revoked = new Error("The retained VPN profile is no longer approved or available");
    tauriMocks.invoke.mockRejectedValueOnce(revoked);
    enqueueVpnDownloadChapter({ ...job, id: 8, chapterPath: "/chapter/8" }, worker, async () => { completed++; });
    await expect(capturedSpec!.run({ ...context, taskId: "task-2" })).rejects.toBe(revoked);
    expect(tauriMocks.invoke.mock.calls.filter(([command]) => command === "plugin_vpn_download_worker_validate")).toHaveLength(2);
    expect(pluginMocks.getChapterResource).toHaveBeenCalledExactlyOnceWith("/chapter/7", "text");
    expect(saveStoredChapterContent).toHaveBeenCalledOnce();
    expect(completed).toBe(1);
  });

  it("checks the work's stored chapters once per plan across rotated leases and sibling ranges", async () => {
    const scanned = { ...job, vpnPlanId: "plan-scanned" };
    const run = async (value: ChapterDownloadJob, lease: VpnDownloadWorkerRef) => {
      tauriMocks.invoke.mockResolvedValueOnce({ ...connected, worker: lease });
      enqueueVpnDownloadChapter(value, lease, async () => undefined);
      await capturedSpec!.run({ executor: `vpn:${lease.slot}:${lease.generation}` as ScraperExecutorId, setDetail: vi.fn(),
        setProgress: vi.fn(), signal: new AbortController().signal, taskId: `task-${value.id}` });
    };
    await run(scanned, worker);
    await run({ ...scanned, id: 8, chapterPath: "/chapter/8" }, worker);
    await run({ ...scanned, id: 9, chapterPath: "/chapter/9" }, { ...worker, slot: 1, generation: 9 });
    await run({ ...scanned, id: 10, chapterPath: "/chapter/10", vpnRangeId: "range-b" }, { rangeId: "range-b", slot: 0, generation: 10 });
    expect(refreshStoredNovelChapterDownloads).toHaveBeenCalledExactlyOnceWith(11);

    const chapter = (await getChapterById(7))!;
    vi.mocked(getChapterById).mockResolvedValueOnce({ ...chapter, novelId: 13 }).mockResolvedValueOnce({ ...chapter, novelId: 13 });
    await run({ ...scanned, id: 12, chapterPath: "/chapter/12", novelId: 13 }, { ...worker, generation: 11 });
    await run({ ...scanned, id: 14, chapterPath: "/chapter/14", vpnPlanId: "plan-next" }, { ...worker, generation: 12 });
    expect(vi.mocked(refreshStoredNovelChapterDownloads).mock.calls).toEqual([[11], [13], [11]]);
  });

  it("releases a terminal plan's scan cache without clearing another plan", async () => {
    const run = async (planId: string, id: number) => {
      enqueueVpnDownloadChapter({ ...job, id, vpnPlanId: planId }, worker, async () => undefined);
      await capturedSpec!.run({ executor: "vpn:0:8", setDetail: vi.fn(), setProgress: vi.fn(),
        signal: new AbortController().signal, taskId: `task-${id}` });
    };
    await run("plan-release", 20);
    await run("plan-retained", 21);

    releaseVpnDownloadPlanLocalWorkScans("plan-release");
    releaseVpnDownloadPlanLocalWorkScans("plan-release");
    await run("plan-release", 22);
    await run("plan-retained", 23);

    expect(vi.mocked(refreshStoredNovelChapterDownloads).mock.calls).toEqual([[11], [11], [11]]);
    releaseVpnDownloadPlanLocalWorkScans("plan-release");
    releaseVpnDownloadPlanLocalWorkScans("plan-retained");
  });

  it("keeps a released plan's pending scan separate from later plan work", async () => {
    const previous = createDeferred<void>();
    const current = createDeferred<void>();
    vi.mocked(refreshStoredNovelChapterDownloads)
      .mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
    const run = (id: number) => {
      enqueueVpnDownloadChapter({ ...job, id, vpnPlanId: "plan-pending-release" }, worker, async () => undefined);
      return capturedSpec!.run({ executor: "vpn:0:8", setDetail: vi.fn(), setProgress: vi.fn(),
        signal: new AbortController().signal, taskId: `task-${id}` });
    };
    const first = run(24);
    const failed = expect(first).rejects.toThrow("Previous scan failed");
    await vi.waitFor(() => expect(refreshStoredNovelChapterDownloads).toHaveBeenCalledOnce());
    try {
      releaseVpnDownloadPlanLocalWorkScans("plan-pending-release");
      const second = run(25);
      await vi.waitFor(() => expect(refreshStoredNovelChapterDownloads).toHaveBeenCalledTimes(2));
      previous.reject(new Error("Previous scan failed"));
      await failed;
      current.resolve();
      await second;
      await run(26);
      expect(refreshStoredNovelChapterDownloads).toHaveBeenCalledTimes(2);
    } finally {
      previous.reject(new Error("Previous scan failed"));
      current.resolve();
      await failed;
      releaseVpnDownloadPlanLocalWorkScans("plan-pending-release");
    }
  });

  it.each([
    { reason: "unsupported runtime", status: { ...connected, supported: false } },
    { reason: "disconnected tunnel", status: { ...connected, phase: "disabled" } },
    { reason: "missing lease", status: { ...connected, profile: null } },
    { reason: "different slot", status: { ...connected, worker: { ...worker, slot: 1 } } },
    { reason: "different range", status: { ...connected, worker: { ...worker, rangeId: "range-b" } } },
    { reason: "different generation", status: { ...connected, worker: { ...worker, generation: 9 } } },
  ])("rejects $reason returned by native validation before source access", async value => {
    tauriMocks.invoke.mockResolvedValueOnce(value.status);
    let completed = false;
    enqueueVpnDownloadChapter(job, worker, async () => { completed = true; });
    await expect(capturedSpec!.run({ executor: "vpn:0:8", setDetail: vi.fn(), setProgress: vi.fn(),
      signal: new AbortController().signal, taskId: "task-1" })).rejects.toThrow(/VPN worker/i);
    expect(getChapterById).not.toHaveBeenCalled();
    expect(tryDownloadServerChapter).not.toHaveBeenCalled();
    expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
    expect(saveStoredChapterContent).not.toHaveBeenCalled();
    expect(completed).toBe(false);
  });

  it.each(["pool:0", "vpn:1:8", "vpn:0:9"] satisfies ScraperExecutorId[])(
    "rejects executor %s for the enrolled worker before validation or source access", async executor => {
      enqueueVpnDownloadChapter(job, worker, async () => undefined);
      await expect(capturedSpec!.run({ executor, setDetail: vi.fn(), setProgress: vi.fn(),
        signal: new AbortController().signal, taskId: "task-1" })).rejects.toThrow(/VPN.*executor/i);
      expect(tauriMocks.invoke).not.toHaveBeenCalled();
      expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
      expect(saveStoredChapterContent).not.toHaveBeenCalled();
    },
  );

  it("cancels while native validation is pending without publishing a late success", async () => {
    const validation = createDeferred<PluginVpnDownloadWorkerStatus>();
    tauriMocks.invoke.mockImplementationOnce(() => validation.promise);
    let completed = false;
    enqueueVpnDownloadChapter(job, worker, async () => { completed = true; });
    const controller = new AbortController();
    const running = capturedSpec!.run({ executor: "vpn:0:8", setDetail: vi.fn(), setProgress: vi.fn(),
      signal: controller.signal, taskId: "task-1" });
    const cancelled = expect(running).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks();
    controller.abort(new DOMException("Task cancelled", "AbortError"));
    try { await cancelled; } finally { validation.resolve(connected); }
    await flushMicrotasks();
    expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
    expect(saveStoredChapterContent).not.toHaveBeenCalled();
    expect(completed).toBe(false);
  });

  it("keeps the worker identity and settles its checkpoint only after content publication", async () => {
    const events: string[] = [];
    vi.mocked(saveStoredChapterContent).mockImplementation(async () => { events.push("content"); return { rowsAffected: 1 }; });
    enqueueVpnDownloadChapter(job, worker, async () => { events.push("checkpoint"); });
    expect(capturedSpec?.vpnWorker).toEqual(worker);
    expect(capturedSpec?.sourceCooldownKey).toBe("chapter.download:range-a");
    expect(capturedSpec?.retryManually).toBeUndefined();
    await capturedSpec!.run({ executor: "vpn:0:8", setDetail: vi.fn(), setProgress: vi.fn(), signal: new AbortController().signal, taskId: "task-1" });
    expect(events).toEqual(["content", "checkpoint"]);
  });

  it("does not settle a chapter whose source-owned asset still requires authentication", async () => {
    const chapter = (await getChapterById(7))!;
    vi.mocked(getChapterById).mockResolvedValue({ ...chapter, sourceContentType: "html", contentType: "html" });
    pluginMocks.getChapterResource.mockResolvedValue(contentResource("<img src='https://source.test/image'>"));
    vi.mocked(cacheHtmlChapterMedia).mockRejectedValue(new SourceAccessRequiredError("CAPTCHA", { kind: "captcha", url: "https://source.test/chapter/7" }));
    let settled = false;
    enqueueVpnDownloadChapter(job, worker, async () => { settled = true; });
    await expect(capturedSpec!.run({ executor: "vpn:0:8", setDetail: vi.fn(), setProgress: vi.fn(), signal: new AbortController().signal, taskId: "task-1" }))
      .rejects.toMatchObject({ code: "source-access-required" });
    expect(settled).toBe(false);
  });

  describe("recovered folder chapters missing on the content server", () => {
    const folderJob = { ...job, chapterPath: "norea-folder:7" };
    const workerPlugin = { id: "source-a", name: "Source A (worker)", getBaseUrl: () => "https://source.test",
      getChapterAcquisitionPlan: pluginMocks.getChapterAcquisitionPlan, getChapterResource: pluginMocks.getChapterResource };
    let path = "norea-folder:7";
    beforeEach(async () => {
      path = "norea-folder:7";
      const chapter = (await getChapterById(7))!;
      vi.mocked(getChapterById).mockImplementation(async () => ({ ...chapter, path }));
      pluginMocks.getPluginForExecutor.mockImplementation((_id, executor) => executor === "vpn:0:8" ? workerPlugin : undefined);
    });

    it("resolves the source path through the worker's plugin route and downloads from the source", async () => {
      vi.mocked(syncNovelFromSource).mockImplementation(async () => { path = "/novel/7"; return {} as never; });
      let settled = false;
      enqueueVpnDownloadChapter(folderJob, worker, async () => { settled = true; });
      await capturedSpec!.run({ executor: "vpn:0:8", setDetail: vi.fn(), setProgress: vi.fn(), signal: new AbortController().signal, taskId: "task-1" });
      expect(syncNovelFromSource).toHaveBeenCalledOnce();
      expect(vi.mocked(syncNovelFromSource).mock.calls[0]![0]).toBe(workerPlugin);
      expect(vi.mocked(syncNovelFromSource).mock.calls[0]![1]).toMatchObject({ path: "/novel" });
      expect(pluginMocks.getChapterResource).toHaveBeenCalledWith("/novel/7", "text");
      expect(settled).toBe(true);
    });

    it("uses an already resolved source path for a frozen folder job without refreshing again", async () => {
      path = "/novel/7";
      enqueueVpnDownloadChapter(folderJob, worker, async () => undefined);
      await capturedSpec!.run({ executor: "vpn:0:8", setDetail: vi.fn(), setProgress: vi.fn(), signal: new AbortController().signal, taskId: "task-1" });
      expect(vi.mocked(tryDownloadServerChapter).mock.calls[0]![0]).toMatchObject({ id: 7, chapterPath: "/novel/7" });
      expect(syncNovelFromSource).not.toHaveBeenCalled();
      expect(pluginMocks.getChapterResource).toHaveBeenCalledWith("/novel/7", "text");
    });

    it("registers source access before refreshing a recovered chapter that receives 403", async () => {
      const setSourceAccessUrl = vi.fn(() => true);
      vi.mocked(getNovelById).mockResolvedValue({ ...(await getNovelById(11))!, id: 9012 });
      vi.mocked(syncNovelFromSource).mockImplementation(async () => {
        expect(setSourceAccessUrl).toHaveBeenCalledWith("https://source.test/");
        throw new Error("HTTP 403 Forbidden");
      });
      enqueueVpnDownloadChapter(folderJob, worker, async () => undefined);
      await expect(capturedSpec!.run({
        executor: "vpn:0:8", setSourceAccessUrl, setDetail: vi.fn(), setProgress: vi.fn(),
        signal: new AbortController().signal, taskId: "task-1",
      })).rejects.toThrow("HTTP 403");
      expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
    });

    it("reports a content error, not a VPN failure, when the source has no matching chapter", async () => {
      vi.mocked(syncNovelFromSource).mockResolvedValue({} as never);
      vi.mocked(getNovelById).mockResolvedValue({ ...(await getNovelById(11))!, id: 12 });
      let settled = false;
      enqueueVpnDownloadChapter(folderJob, worker, async () => { settled = true; });
      const failure = await capturedSpec!.run({ executor: "vpn:0:8", setDetail: vi.fn(), setProgress: vi.fn(), signal: new AbortController().signal, taskId: "task-1" })
        .then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/not on the content server.*no matching chapter/);
      expect(isPluginVpnUnavailableError(failure)).toBe(false);
      expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
      expect(settled).toBe(false);
    });
  });

  it("verifies the real source rather than satisfying a VPN canary from a content server", async () => {
    vi.mocked(tryDownloadServerChapter).mockResolvedValue(true);
    let settled = false;
    enqueueVpnDownloadChapter(job, worker, async () => { settled = true; });
    await capturedSpec!.run({ executor: "vpn:0:8", sourceAccessVerification: true, confirmSourceAccess: () => true,
      setDetail: vi.fn(), setProgress: vi.fn(), signal: new AbortController().signal, taskId: "task-1" });
    expect(pluginMocks.getChapterResource).toHaveBeenCalledWith("/chapter/7", "text");
    expect(settled).toBe(true);
  });

  it("rejects range ownership mismatches before a task can reach a default executor", () => {
    expect(() => enqueueVpnDownloadChapter(job, { ...worker, rangeId: "other" }, async () => undefined)).toThrow(/range/i);
    expect(schedulerMocks.enqueueSource).not.toHaveBeenCalled();
  });

  it("rejects enrolled jobs submitted through the ordinary default-route entrypoint", () => {
    expect(() => enqueueChapterDownload(job)).toThrow(/worker/i);
    expect(schedulerMocks.enqueueSource).not.toHaveBeenCalled();
  });
});

describe("targeted cleanup cancellation", () => {
  it("cancels matching download and repair tasks outside the UI snapshot and waits for settlement", async () => {
    const pending = createDeferred<void>();
    vi.mocked(taskScheduler.getTaskByDedupeKey).mockImplementation((key) => {
      if (key === "chapter.download:42") return { id: "download", status: "running" } as never;
      if (key === "chapter.repairMedia:42") return { id: "repair", status: "queued" } as never;
      if (key === "chapter.download:99") return { id: "unrelated", status: "running" } as never;
      return undefined;
    });
    vi.mocked(taskScheduler.waitForSourceTaskSettlement).mockImplementation((id) => id === "download" ? pending.promise : Promise.resolve());
    let finished = false;
    const cancellation = cancelChapterDownloadTasks([42]).then(() => { finished = true; });
    await flushMicrotasks();
    expect(finished).toBe(false);
    expect(taskScheduler.cancel).toHaveBeenCalledWith("download");
    expect(taskScheduler.cancel).toHaveBeenCalledWith("repair");
    expect(taskScheduler.cancel).not.toHaveBeenCalledWith("unrelated");
    expect(taskScheduler.getTaskByDedupeKey).not.toHaveBeenCalledWith("chapter.download:99");
    pending.resolve();
    await cancellation;
    expect(taskScheduler.waitForSourceTaskSettlement).toHaveBeenCalledTimes(2);
  });
});

describe("chapter download queue membership", () => {
  it("routes a direct interactive chapter through the installed VPN admission boundary without creating ordinary work", async () => {
    const done = createDeferred<void>();
    const requested: ChapterDownloadJob[] = [];
    installChapterDownloadBatchInterceptor({ enqueue: () => null, cancel: () => false,
      enqueueChapter: job => { requested.push(job); return { id: "vpn-chapter", promise: done.promise }; } });
    const job: ChapterDownloadJob = { id: 900081, novelId: 42, pluginId: "source-a", chapterPath: "/81", title: "Interactive chapter", priority: "interactive" };
    const handle = enqueueChapterDownload(job);
    expect(handle.id).toBe("vpn-chapter");
    expect(requested).toEqual([job]);
    expect(schedulerMocks.enqueueSource).not.toHaveBeenCalled();
    done.resolve(); await handle.promise;
  });

  it("keeps a direct server-backed local chapter on its independent ordinary route", () => {
    installChapterDownloadBatchInterceptor({ enqueue: () => null, cancel: () => false,
      enqueueChapter: () => { throw new Error("Local work must not enter source VPN admission"); } });
    const handle = enqueueChapterDownload({ id: 900082, novelId: 42, pluginId: "local", chapterPath: "/82", title: "Server-backed local chapter", priority: "interactive" });
    expect(handle.id).toBe("task-1");
    expect(schedulerMocks.enqueueSource).toHaveBeenCalledOnce();
  });

  it("keeps discard pending until durable ordinary deletion succeeds and exposes a failed deletion", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const deleting = createDeferred<void>();
    const failure = new Error("Queue deletion failed");
    backendQueueValues.set(900080, { id: 900080 });
    recoveryHarness.current.register([{ id: 900080, pluginId: "source-a", title: "Held chapter" }]);
    recoveryHarness.current.networkLost("chapter:900080", new Error("Network connection was lost."));
    const original = tauriMocks.invoke.getMockImplementation()!;
    tauriMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "chapter_download_queue_remove") await deleting.promise;
      return original(command, args);
    });
    let settled = false;
    const result = Promise.resolve(discardQueuedChapterDownloads([900080])).finally(() => { settled = true; });
    const outcome = result.then(() => null, error => error);
    await flushMicrotasks();
    try {
      expect(settled).toBe(false);
      expect(recoveryHarness.current.getSnapshot()).toMatchObject([{ key: "chapter:900080", status: "held" }]);
    } finally {
      deleting.reject(failure);
      expect(await outcome).toMatchObject({ code: "chapter-storage-failed", cause: failure });
      await expect(waitForChapterDownloadQueueMutations()).rejects.toMatchObject({ code: "chapter-storage-failed", cause: failure });
    }
    expect(backendQueueValues.has(900080)).toBe(true);
    expect(recoveryHarness.current.getSnapshot()).toMatchObject([{ key: "chapter:900080", status: "held" }]);
    tauriMocks.invoke.mockImplementation(original);
    await discardQueuedChapterDownloads([900080]);
    expect(backendQueueValues.has(900080)).toBe(false);
    expect(recoveryHarness.current.getSnapshot()).toEqual([]);
    expect(recoveryHarness.current.networkLost("chapter:900080", new Error("Network connection was lost."))).toBeNull();
  });

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
  it("does not materialize a persistent batch before its queue write settles", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const inserting = createDeferred<void>();
    const completed = createDeferred<void>();
    const original = tauriMocks.invoke.getMockImplementation()!;
    tauriMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "chapter_download_queue_enqueue") await inserting.promise;
      return original(command, args);
    });
    schedulerMocks.enqueueSource.mockReturnValue({ id: "held-publication", promise: completed.promise });
    const handle = enqueueChapterDownloadBatch({
      jobs: [{ id: 900050, pluginId: "source-a", chapterPath: "/chapter/50", title: "Chapter 50" }],
      title: "Persist the request", materializeAllTasks: true,
    });
    let materialized = false;
    const publication = handle.materialized.then(() => { materialized = true; });
    await flushMicrotasks();
    try {
      expect(materialized).toBe(false);
      expect(backendQueueValues.has(900050)).toBe(false);
    } finally {
      inserting.resolve();
      await publication;
      completed.resolve();
      await handle.promise;
      discardQueuedChapterDownloads([900050]);
      await waitForChapterDownloadQueueMutations();
    }
  });

  it("rejects materialization when the persistent queue cannot accept the batch", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const completed = createDeferred<void>();
    const failure = new Error("Queue publication unavailable");
    const original = tauriMocks.invoke.getMockImplementation()!;
    tauriMocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) =>
      command === "chapter_download_queue_enqueue" ? Promise.reject(failure) : original(command, args),
    );
    schedulerMocks.enqueueSource.mockReturnValue({ id: "failed-publication", promise: completed.promise });
    const handle = enqueueChapterDownloadBatch({
      jobs: [{ id: 900051, pluginId: "source-a", chapterPath: "/chapter/51", title: "Chapter 51" }],
      title: "Reject an unpersisted request", materializeAllTasks: true,
    });
    try {
      await expect(handle.materialized).rejects.toMatchObject({ code: "chapter-storage-failed", cause: failure });
      expect(backendQueueValues.has(900051)).toBe(false);
    } finally {
      const settled = expect(handle.promise).rejects.toThrow("1 chapter downloads failed.");
      completed.reject(failure);
      await settled;
      discardQueuedChapterDownloads([900051]);
      await waitForChapterDownloadQueueMutations();
    }
  });

  it("sends new automatic batches to range confirmation before ordinary queue publication", async () => {
    const result = { total: 1, succeeded: 0, failed: 0, cancelled: 1 };
    const intercepted = { id: "vpn-batch", materialized: Promise.resolve(), promise: Promise.resolve(result) };
    installChapterDownloadBatchInterceptor({ enqueue: () => intercepted, cancel: id => id === "vpn-batch" });
    const handle = enqueueChapterDownloadBatch({ jobs: [{ id: 100, pluginId: "source", chapterPath: "/chapter", title: "Chapter" }], title: "Batch" });
    expect(handle).toBe(intercepted);
    expect(schedulerMocks.enqueueSource).not.toHaveBeenCalled();
    expect(cancelChapterDownloadBatches([handle.id])).toBe(1);
    await expect(handle.promise).resolves.toEqual(result);
  });

  it("publishes batch outcomes separately from settled progress before removal", async () => {
    const pending: Deferred<void>[] = [];
    schedulerMocks.enqueueSource.mockImplementation(() => {
      const deferred = createDeferred<void>();
      pending.push(deferred);
      return { id: `progress-${pending.length}`, promise: deferred.promise };
    });
    const events: Array<Parameters<Parameters<typeof subscribeChapterDownloadBatchProgress>[0]>[0]> = [];
    const unsubscribe = subscribeChapterDownloadBatchProgress(event => events.push(event));
    const handle = enqueueChapterDownloadBatch({
      jobs: [910001, 910002, 910003].map(id => ({
        id, pluginId: "source-a", chapterPath: `/chapter/${id}`, title: `Chapter ${id}`,
      })),
      persist: false, title: "Progress batch", windowSize: 3,
    });
    const rejected = expect(handle.promise).rejects.toThrow("1 chapter downloads failed.");
    await flushMicrotasks();
    expect(getChapterDownloadBatchProgress().find(event => event.batchId === handle.id)).toMatchObject({
      active: true, progress: { current: 0, total: 3, succeeded: 0, failed: 0, cancelled: 0 },
    });
    pending[0].resolve();
    pending[1].reject(new Error("Download failed"));
    pending[2].reject(new DOMException("Cancelled", "AbortError"));
    await rejected;
    unsubscribe();
    expect(events.filter(event => event.batchId === handle.id).at(-1)).toEqual({
      batchId: handle.id, active: false,
      progress: { current: 3, total: 3, succeeded: 1, failed: 1, cancelled: 1 },
    });
    expect(getChapterDownloadBatchProgress().some(event => event.batchId === handle.id)).toBe(false);
  });

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

    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(64);
    expect(schedulerMocks.batch).toHaveBeenCalledOnce();
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

  it("cancels every registered array task and its queue rows", async () => {
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

    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(64);
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

    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(64);
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

    expect(getActiveChapterDownloadBatchProgress()).toMatchObject({
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

  it.each([true, false])("removes failed or manually cancelled restored jobs (cancelled: %s)", async (cancelled) => {
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

    expect([...backendQueueValues.keys()]).toEqual([2]);
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
  function failureRow(chapterId: number, nextRetryAt: number | null, patch: Partial<StoredChapterDownloadFailure> = {}): StoredChapterDownloadFailure {
    return { chapterId, pluginId: "source-a", failureClass: "transient", messageSummary: "HTTP 503 Service Unavailable",
      attempts: 2, nextRetryAt, challengeUrl: null, updatedAt: 1,
      jobJson: JSON.stringify({ id: chapterId, pluginId: "source-a", chapterPath: `/chapter/${chapterId}`, title: `Chapter ${chapterId}` }), ...patch };
  }

  it("restores preserved jobs before explicit resume after the startup database recovers", async () => {
    vi.resetModules();
    const downloads = await import("./chapter-download");
    const { TaskScheduler } = await vi.importActual<typeof import("./scheduler")>("./scheduler");
    const scheduler = new TaskScheduler();
    const restored: TaskHandle<void>[] = [];
    vi.mocked(taskScheduler.reportDownloadFailure).mockImplementation((error, sourceId) => scheduler.reportDownloadFailure(error, sourceId));
    vi.mocked(taskScheduler.getSnapshot).mockImplementation(() => scheduler.getSnapshot());
    vi.mocked(taskScheduler.resumeSourceQueue).mockImplementation(sourceId => scheduler.resumeSourceQueue(sourceId));
    schedulerMocks.enqueueSource.mockImplementation((spec: SourceTaskSpec<void>) => {
      const handle = scheduler.enqueueSource({ ...spec, sourceCooldownMs: 0 });
      restored.push(handle);
      return handle;
    });
    vi.mocked(listExistingChapterIds).mockResolvedValue([7]);
    pluginMocks.loadInstalledFromDb.mockResolvedValue(undefined);
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const job = { id: 7, pluginId: "source-a", chapterPath: "/chapter/7", title: "Preserved chapter" };
    backendQueueValues.set(7, job);
    failureMocks.refresh.mockRejectedValueOnce(new Error("Database unavailable"));
    downloads.startChapterDownloadQueueExecutor();
    await downloads.waitForChapterDownloadQueueRestoration();
    expect(scheduler.getDownloadFailureStops().globalError).toContain("Database unavailable");
    expect(backendQueueValues.get(7)).toEqual(job);
    expect(schedulerMocks.enqueueSource).not.toHaveBeenCalled();

    expect(await downloads.resumeChapterDownloadQueueAfterFailure()).toBe(true);
    expect(restored).toHaveLength(1);
    await restored[0]!.promise;
    await downloads.waitForChapterDownloadQueueMutations();
    expect(scheduler.getDownloadFailureStops()).toEqual({ sourceErrors: {} });
    expect(scheduler.getTask(restored[0]!.id)?.status).toBe("succeeded");
    expect(backendQueueValues.has(7)).toBe(false);
    const requests = tauriMocks.invoke.mock.calls.length;
    expect(await downloads.resumeChapterDownloadQueueAfterFailure()).toBe(true);
    expect(tauriMocks.invoke).toHaveBeenCalledTimes(requests);
  });

  it("retains the storage hold and durable jobs when an explicit queue restart fails again", async () => {
    vi.resetModules();
    const downloads = await import("./chapter-download");
    const { TaskScheduler } = await vi.importActual<typeof import("./scheduler")>("./scheduler");
    const scheduler = new TaskScheduler();
    vi.mocked(taskScheduler.reportDownloadFailure).mockImplementation((error, sourceId) => scheduler.reportDownloadFailure(error, sourceId));
    vi.mocked(taskScheduler.getSnapshot).mockImplementation(() => scheduler.getSnapshot());
    vi.mocked(taskScheduler.resumeSourceQueue).mockImplementation(sourceId => scheduler.resumeSourceQueue(sourceId));
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const job = { id: 7, pluginId: "source-a", chapterPath: "/chapter/7", title: "Preserved chapter" };
    backendQueueValues.set(7, job);
    failureMocks.refresh.mockRejectedValue(new Error("Database still unavailable"));
    downloads.startChapterDownloadQueueExecutor();
    await downloads.waitForChapterDownloadQueueRestoration();

    expect(await downloads.resumeChapterDownloadQueueAfterFailure()).toBe(false);
    expect(taskScheduler.resumeSourceQueue).not.toHaveBeenCalled();
    expect(scheduler.getSnapshot().sourceQueuesPaused).toBe(true);
    expect(scheduler.getDownloadFailureStops().globalError).toContain("Database still unavailable");
    expect(backendQueueValues.get(7)).toEqual(job);
    expect(schedulerMocks.enqueueSource).not.toHaveBeenCalled();
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it("allows explicit source resume outside the native runtime without queue calls", async () => {
    vi.resetModules();
    const downloads = await import("./chapter-download");
    const { TaskScheduler } = await vi.importActual<typeof import("./scheduler")>("./scheduler");
    const scheduler = new TaskScheduler();
    scheduler.reportDownloadFailure(new Error("HTTP 503"), "source-a");
    vi.mocked(taskScheduler.resumeSourceQueue).mockImplementation(sourceId => scheduler.resumeSourceQueue(sourceId));

    expect(await downloads.resumeChapterDownloadQueueAfterFailure("source-a")).toBe(true);
    expect(scheduler.getDownloadFailureStops()).toEqual({ sourceErrors: {} });
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it("does not restore an acknowledged source or storage stop from retained manual failure rows", async () => {
    vi.resetModules();
    const downloads = await import("./chapter-download");
    const { TaskScheduler } = await vi.importActual<typeof import("./scheduler")>("./scheduler");
    const scheduler = new TaskScheduler();
    scheduler.hydrateDownloadFailureStops({ sourceErrors: {} });
    vi.mocked(taskScheduler.reportDownloadFailure).mockImplementation((error, sourceId) => scheduler.reportDownloadFailure(error, sourceId));
    failureMocks.snapshot.mockReturnValue([failureRow(7, null), failureRow(8, null, { failureClass: "storage", messageSummary: "Disk is full" })]);
    vi.mocked(isTauriRuntime).mockReturnValue(true);

    downloads.startChapterDownloadQueueExecutor();
    await downloads.waitForChapterDownloadQueueRestoration();

    expect(scheduler.getDownloadFailureStops()).toEqual({ sourceErrors: {} });
    expect(scheduler.getSnapshot().sourceQueuesPaused).toBe(false);
    expect(taskScheduler.reportDownloadFailure).not.toHaveBeenCalled();
    expect(failureMocks.snapshot()).toHaveLength(2);
    expect(schedulerMocks.enqueueSource).not.toHaveBeenCalled();
  });

  it("converts legacy scheduled failures into holds and clears their deadlines before queue leasing", async () => {
    vi.resetModules();
    const downloads = await import("./chapter-download");
    const { TaskScheduler } = await vi.importActual<typeof import("./scheduler")>("./scheduler");
    const scheduler = new TaskScheduler();
    vi.mocked(taskScheduler.reportDownloadFailure).mockImplementation((error, sourceId) => scheduler.reportDownloadFailure(error, sourceId));
    scheduler.hydrateSourceAccessBlocks([{ sourceId: "blocked", scopeKey: "plugin:blocked:site:source.test", revision: 1, detectedAt: 1,
      verificationRequested: false, challenge: { kind: "forbidden", url: "https://source.test/" } }]);
    vi.mocked(taskScheduler.getSnapshot).mockImplementation(() => scheduler.getSnapshot());
    let rows = [failureRow(7, Date.now() + 30_000), failureRow(8, Date.now() + 30_000, { pluginId: "blocked", failureClass: "storage", messageSummary: "Disk is full" }),
      failureRow(9, Date.now() + 30_000, { pluginId: "missing", messageSummary: "HTTP 404 Not Found" }),
      failureRow(10, Date.now() + 30_000, { pluginId: "blocked", jobJson: JSON.stringify({ id: 10, pluginId: "blocked", chapterPath: "/chapter/10", title: "Blocked chapter" }) })];
    failureMocks.snapshot.mockImplementation(() => rows);
    failureQueryMocks.clearScheduledRetries.mockImplementationOnce(async () => {
      rows = rows.map(row => ({ ...row, nextRetryAt: null }));
      return 4;
    });
    const failuresRefreshed = createDeferred<void>();
    failureMocks.refresh.mockResolvedValueOnce(undefined).mockReturnValueOnce(failuresRefreshed.promise);
    vi.mocked(isTauriRuntime).mockReturnValue(true);

    downloads.startChapterDownloadQueueExecutor();
    await flushMicrotasks(50);
    expect(scheduler.getDownloadFailureStops()).toMatchObject({ sourceErrors: { "source-a": "HTTP 503 Service Unavailable" }, globalError: expect.stringContaining("Disk is full") });
    expect(scheduler.getSnapshot().pausedSourceIds).not.toContain("missing");
    expect(scheduler.getDownloadFailureStops().sourceErrors).not.toHaveProperty("blocked");
    expect(scheduler.getSnapshot().sourceAccessBlocks).toHaveLength(1);
    expect(rows.every(row => row.nextRetryAt === null)).toBe(true);
    expect(tauriMocks.invoke.mock.calls.some(([command]) => command === "chapter_download_queue_lease")).toBe(false);
    failuresRefreshed.resolve();
    await downloads.waitForChapterDownloadQueueRestoration();

    expect(tauriMocks.invoke.mock.calls.filter(([command]) => command === "chapter_download_queue_lease")).toHaveLength(1);
    expect(taskScheduler.reportDownloadFailure).toHaveBeenCalledTimes(2);
    expect(schedulerMocks.enqueueSource).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ chapterId: 7, attempts: 2, messageSummary: "HTTP 503 Service Unavailable" });
  });

  it("restores every verification candidate after storage operations and deletion checks", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const { TaskScheduler } = await vi.importActual<typeof import("./scheduler")>("./scheduler");
    const restoredScheduler = new TaskScheduler();
    restoredScheduler.setBackgroundExecutionSuspended(true);
    const verificationScope = "plugin:source-b:site:source.test";
    restoredScheduler.hydrateSourceAccessBlocks([{
      sourceId: "source-b", scopeKey: verificationScope, revision: 1,
      detectedAt: 1, verificationRequested: false,
      challenge: { kind: "captcha", url: "https://source.test/chapter/1035" },
    }]);
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
        const handle = restoredScheduler.enqueueSource(spec);
        void handle.promise.catch(() => undefined);
        const deferred = createDeferred<void>();
        deferreds.push(deferred);
        return { id: handle.id, promise: deferred.promise };
      },
    );
    const invoke = tauriMocks.invoke.getMockImplementation()!;
    const restoreError = new Error("Download queue database is busy");
    let firstLease = true;
    tauriMocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "chapter_download_queue_lease" && firstLease) {
        firstLease = false;
        return Promise.reject(restoreError);
      }
      return invoke(command, args);
    });
    const onRestoreError = vi.fn();
    const restoredJobCount = 1_035;
    const jobs = Array.from({ length: restoredJobCount }, (_, index) => {
      const id = index + 1;
      return {
        id,
        pluginId: id === restoredJobCount ? "source-b" : "source-a",
        chapterPath: `/chapter/${id}`,
        chapterName: `Chapter ${id}`,
        novelId: 11,
        novelName: "Novel",
        sourceNovelId: "novel",
        title: `Chapter ${id}`,
      };
    });
    for (const job of jobs) backendQueueValues.set(job.id, job);
    vi.mocked(listExistingChapterIds).mockImplementation(async (chapterIds) => {
      discardQueuedChapterDownloads([3]);
      return chapterIds.filter((id) => id !== 2);
    });
    const initialFailuresRead = createDeferred<void>();
    const deadlinesCleared = createDeferred<number>();
    const failuresRefreshed = createDeferred<void>();
    failureQueryMocks.clearScheduledRetries.mockReturnValueOnce(deadlinesCleared.promise);
    failureMocks.refresh.mockReturnValueOnce(initialFailuresRead.promise).mockReturnValueOnce(failuresRefreshed.promise);
    startChapterDownloadQueueExecutor(onRestoreError);
    await flushMicrotasks();
    expect(failureMocks.refresh).toHaveBeenCalledOnce();
    expect(failureQueryMocks.clearScheduledRetries).not.toHaveBeenCalled();
    expect(tauriMocks.invoke.mock.calls.some(([command]) => command === "chapter_download_queue_lease")).toBe(false);
    initialFailuresRead.resolve();
    await flushMicrotasks();
    expect(failureQueryMocks.clearScheduledRetries).toHaveBeenCalledOnce();
    expect(failureMocks.refresh).toHaveBeenCalledOnce();
    deadlinesCleared.resolve(1);
    await flushMicrotasks();
    expect(failureMocks.refresh).toHaveBeenCalledTimes(2);

    expect(getChapterById).not.toHaveBeenCalled();
    expect(reconcileStoredChapterContent).not.toHaveBeenCalled();
    expect(schedulerMocks.enqueueSource).not.toHaveBeenCalled();

    backendQueueValues.delete(1);
    releaseStorageOperation.resolve();
    await storageOperation;
    await flushMicrotasks(100);
    expect(tauriMocks.invoke.mock.calls.some(([command]) => command === "chapter_download_queue_lease")).toBe(false);
    failuresRefreshed.resolve();
    await flushMicrotasks(100);
    expect(onRestoreError).toHaveBeenCalledExactlyOnceWith(restoreError);
    expect(schedulerMocks.enqueueSource).not.toHaveBeenCalled();
    startChapterDownloadQueueExecutor(onRestoreError);

    try {
      await waitForChapterDownloadQueueRestoration();
      expect(restoredScheduler.canBeginSourceAccessVerification(verificationScope)).toBe(true);
      expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(restoredJobCount - 3);
      await vi.waitFor(() => {
        expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(
          restoredJobCount - 3,
        );
      });
      expect(listExistingChapterIds).toHaveBeenCalledExactlyOnceWith(
        jobs.slice(1).map((job) => job.id),
      );
      expect(getChapterById).not.toHaveBeenCalled();
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
      restoredScheduler.cancelActiveTasks({ discardQueued: true });
      for (const deferred of deferreds) {
        deferred.reject(new Error("executor failed"));
      }
      await flushMicrotasks(100);
    }
  });
});

describe("enqueueChapterDownload", () => {
  it("marks goal work automatic, keeps the flag in its queue row and retries it manually as explicit work", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    enqueueChapterDownload({ id: 900030, pluginId: "source-a", chapterPath: "/chapter/30", title: "Goal job", goal: true });
    await waitForChapterDownloadQueueMutations();
    try {
      expect(capturedSpec?.automatic).toBe(true);
      expect(backendQueueValues.get(900030)).toMatchObject({ goal: true });
      capturedSpec!.retryManually!();
      expect(capturedSpec?.automatic).toBeUndefined();
    } finally {
      discardQueuedChapterDownloads([900030]);
      await waitForChapterDownloadQueueMutations();
    }
  });

  it("keeps a replacement queued job when an older cancellation settles late", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const previous = createDeferred<void>();
    const replacement = createDeferred<void>();
    schedulerMocks.enqueueSource
      .mockReturnValueOnce({ id: "previous", promise: previous.promise })
      .mockReturnValueOnce({ id: "replacement", promise: replacement.promise });
    const previousHandle = enqueueChapterDownload({
      id: 900010, pluginId: "source-a", chapterPath: "/chapter/10", title: "Previous job",
    });
    await waitForChapterDownloadQueueMutations();
    const replacementHandle = enqueueChapterDownload({
      id: 900010, pluginId: "source-a", chapterPath: "/chapter/10", title: "Replacement job",
    });
    await waitForChapterDownloadQueueMutations();
    const rejected = expect(previousHandle.promise).rejects.toMatchObject({ cancelledByUser: true });
    previous.reject(new TaskUserCancelledError());
    await rejected;
    await flushMicrotasks();
    await waitForChapterDownloadQueueMutations();
    try {
      expect(backendQueueValues.get(900010)).toMatchObject({ title: "Replacement job" });
    } finally {
      discardQueuedChapterDownloads([900010]);
      replacement.resolve();
      await replacementHandle.promise;
      await waitForChapterDownloadQueueMutations();
    }
  });

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

  it("keeps deduplicated handles waiting for their shared persistent queue write", async () => {
    const { TaskScheduler } = await vi.importActual<typeof import("./scheduler")>("./scheduler");
    const scheduler = new TaskScheduler({ sourceQueuesPaused: true });
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    schedulerMocks.enqueueSource.mockImplementation((spec: SourceTaskSpec<void>) => scheduler.enqueueSource(spec));
    vi.mocked(taskScheduler.getTaskByDedupeKey).mockImplementation((key) => scheduler.getTaskByDedupeKey(key));
    vi.mocked(getChapterById).mockRejectedValue(new Error("Chapter read ran before queue persistence"));
    const inserting = createDeferred<void>();
    const original = tauriMocks.invoke.getMockImplementation()!;
    tauriMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "chapter_download_queue_enqueue") await inserting.promise;
      return original(command, args);
    });
    const job = { id: 900015, pluginId: "source-a", chapterPath: "/chapter/15", title: "Shared queued job" };
    const first = enqueueChapterDownload(job);
    const second = enqueueChapterDownload(job);
    const settled = Promise.allSettled([first.promise, second.promise]);
    expect(second.id).toBe(first.id);
    scheduler.resumeSourceQueue();
    try {
      await flushMicrotasks();
      expect(getChapterById).not.toHaveBeenCalled();
    } finally {
      inserting.reject(new Error("Queue storage unavailable"));
    }
    const results = await settled;
    for (const result of results) {
      expect(result).toMatchObject({ status: "rejected", reason: { code: "chapter-storage-failed", cause: { message: "Queue storage unavailable" } } });
    }
    await waitForChapterDownloadQueueMutations();
  });

  it("waits for the replacement write when overlapping batches materialize a shared chapter", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(getChapterById).mockRejectedValue(new Error("Chapter read ran before queue persistence"));
    const completions = new Map<number, Deferred<void>>();
    const specs = new Map<number, SourceTaskSpec<void>>();
    schedulerMocks.enqueueSource.mockImplementation((spec: SourceTaskSpec<void>) => {
      const id = spec.subject!.chapterId!;
      const completion = createDeferred<void>();
      specs.set(id, spec);
      completions.set(id, completion);
      return { id: `overlap-${id}`, promise: completion.promise };
    });
    const inserting = createDeferred<void>();
    const original = tauriMocks.invoke.getMockImplementation()!;
    tauriMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "chapter_download_queue_enqueue" &&
        (args?.jobs as { id: number }[]).some((job) => job.id === 900017)) await inserting.promise;
      return original(command, args);
    });
    const job = (id: number) => ({ id, pluginId: "source-a", chapterPath: `/chapter/${id}`, title: `Overlap ${id}` });
    const first = enqueueChapterDownloadBatch({ jobs: [job(900016), job(900018)], title: "First overlap", windowSize: 1 });
    const second = enqueueChapterDownloadBatch({ jobs: [job(900017), job(900018)], title: "Second overlap", windowSize: 1 });
    const settled = Promise.allSettled([first.promise, second.promise]);
    let sharedRun: Promise<PromiseSettledResult<void>[]> | undefined;
    try {
      await flushMicrotasks();
      completions.get(900016)!.resolve();
      await flushMicrotasks();
      const shared = specs.get(900018);
      if (!shared) throw new Error("Shared chapter was not materialized");
      sharedRun = Promise.allSettled([shared.run({ setDetail: vi.fn(), setProgress: vi.fn(), signal: new AbortController().signal, taskId: "shared-overlap" })]);
      await flushMicrotasks();
      expect(getChapterById).not.toHaveBeenCalled();
      inserting.reject(new Error("Queue storage unavailable"));
      expect(await sharedRun).toMatchObject([{ status: "rejected", reason: { code: "chapter-storage-failed", cause: { message: "Queue storage unavailable" } } }]);
    } finally {
      inserting.reject(new Error("Queue storage unavailable"));
      cancelChapterDownloadBatches([first.id, second.id]);
      for (const completion of completions.values()) completion.reject(new TaskUserCancelledError());
      await settled;
      await sharedRun;
      await waitForChapterDownloadQueueMutations();
    }
  });

  it("keeps replacement jobs when an older batch is cancelled", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const previous = createDeferred<void>();
    const replacement = createDeferred<void>();
    schedulerMocks.enqueueSource
      .mockReturnValueOnce({ id: "previous-batch", promise: previous.promise })
      .mockReturnValueOnce({ id: "replacement-single", promise: replacement.promise });
    const job = { id: 900012, pluginId: "source-a", chapterPath: "/chapter/12", title: "Previous batch" };
    const batch = enqueueChapterDownloadBatch({ jobs: [job], title: "Previous batch" });
    await waitForChapterDownloadQueueMutations();
    const replacementHandle = enqueueChapterDownload({ ...job, title: "Replacement job" });
    expect(cancelChapterDownloadBatches([batch.id])).toBe(1);
    await waitForChapterDownloadQueueMutations();
    previous.reject(new TaskUserCancelledError());
    await expect(batch.promise).resolves.toMatchObject({ cancelled: 1 });
    await waitForChapterDownloadQueueMutations();
    try {
      expect(backendQueueValues.get(job.id)).toMatchObject({ title: "Replacement job" });
    } finally {
      discardQueuedChapterDownloads([job.id]);
      replacement.resolve();
      await replacementHandle.promise;
      await waitForChapterDownloadQueueMutations();
    }
  });

  it("keeps a failed batch write attached to all jobs after later queue mutations", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const original = tauriMocks.invoke.getMockImplementation()!;
    tauriMocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) =>
      command === "chapter_download_queue_enqueue"
        ? Promise.reject(new Error("Queue storage unavailable"))
        : original(command, args),
    );
    vi.mocked(getChapterById).mockRejectedValue(new Error("Chapter read ran before queue persistence"));
    const completions: Deferred<void>[] = [];
    schedulerMocks.enqueueSource.mockImplementation(() => {
      const completion = createDeferred<void>();
      completions.push(completion);
      return { id: `persist-failure-${completions.length}`, promise: completion.promise };
    });
    const batch = enqueueChapterDownloadBatch({
      jobs: [900013, 900014].map((id) => ({ id, pluginId: "source-a", chapterPath: `/chapter/${id}`, title: "Persist first" })),
      title: "Persist batch first", materializeAllTasks: true,
    });
    await flushMicrotasks();
    await expect(waitForChapterDownloadQueueMutations()).rejects.toThrow("Queue storage unavailable");
    await expect(waitForChapterDownloadQueueMutations()).resolves.toBeUndefined();
    discardQueuedChapterDownloads([900099]);
    await waitForChapterDownloadQueueMutations();
    const rejectedBatch = expect(batch.promise).rejects.toThrow("2 chapter downloads failed.");
    const specs = schedulerMocks.enqueueSource.mock.calls.map(([spec]) => spec as SourceTaskSpec<void>);
    expect(specs).toHaveLength(2);
    for (const [index, spec] of specs.entries()) {
      await expect(spec.run({ setDetail: vi.fn(), setProgress: vi.fn(), signal: new AbortController().signal, taskId: `persist-failure-${index}` }))
        .rejects.toThrow("Queue storage unavailable");
      completions[index]!.reject(new Error("Queue storage unavailable"));
    }
    await rejectedBatch;
    await waitForChapterDownloadQueueMutations();
    expect(getChapterById).not.toHaveBeenCalled();
  });

  it("rejects source work when its persistent queue write fails", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const original = tauriMocks.invoke.getMockImplementation()!;
    tauriMocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) =>
      command === "chapter_download_queue_enqueue"
        ? Promise.reject(new Error("Queue storage unavailable"))
        : original(command, args),
    );
    vi.mocked(getChapterById).mockRejectedValue(new Error("Chapter read ran before queue persistence"));
    enqueueChapterDownload({ id: 900011, pluginId: "source-a", chapterPath: "/chapter/11", title: "Persist first" });
    if (!capturedSpec) throw new Error("Missing task spec");
    const run = capturedSpec.run({ setDetail: vi.fn(), setProgress: vi.fn(), signal: new AbortController().signal, taskId: "persist-failure" });
    try {
      await expect(run).rejects.toThrow("Queue storage unavailable");
      expect(getChapterById).not.toHaveBeenCalled();
      expect(pluginMocks.getChapterResource).not.toHaveBeenCalled();
    } finally {
      discardQueuedChapterDownloads([900011]);
      await waitForChapterDownloadQueueMutations();
    }
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

  it("removes the backend queue job when media finalization fails", async () => {
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

    expect([...backendQueueValues.keys()]).toEqual([]);
    expect(
      tauriMocks.invoke.mock.calls.filter(
        ([command]) => command === "chapter_download_queue_remove",
      ),
    ).toHaveLength(1);
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

  it.each(["download", "repair"] as const)("allows manual retry without automatic retries for %s", (operation) => {
    if (operation === "download") {
      enqueueChapterDownload({ id: 7, pluginId: "source-a", chapterPath: "/chapter/7", title: "Chapter 7" });
    } else {
      enqueueChapterMediaRepair({ id: 7, pluginId: "source-a", title: "Chapter 7" });
    }
    expect(capturedSpec?.retryManually).toBeTypeOf("function");
    expect(capturedSpec?.retry).toBeUndefined();
  });

  it("removes a failed VPN job from the automatic restoration queue", async () => {
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

    expect([...backendQueueValues.keys()]).toEqual([]);
    expect(
      tauriMocks.invoke.mock.calls.filter(
        ([command]) => command === "chapter_download_queue_remove",
      ),
    ).toHaveLength(1);
  });

  it.each(["source", "server", "local"] as const)(
    "completes a manual retry of a failed VPN job from %s",
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
      expect(backendQueueValues.has(7)).toBe(false);
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

  it("persists a manual retry across suspension and removes it after another failure", async () => {
    const { TaskScheduler } = await vi.importActual<typeof import("./scheduler")>("./scheduler");
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    schedulerMocks.enqueueSource.mockImplementation((spec: SourceTaskSpec<void>) =>
      scheduler.enqueueSource({ ...spec, sourceCooldownMs: 0 }));
    vi.mocked(taskScheduler.getTaskByDedupeKey).mockImplementation((key) => scheduler.getTaskByDedupeKey(key));
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const error = new Error("Failed to fetch");
    const suspended = createDeferred<ChapterResource>();
    pluginMocks.getChapterResource.mockRejectedValueOnce(error)
      .mockImplementationOnce(() => suspended.promise).mockRejectedValueOnce(error);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const original = enqueueChapterDownload({ id: 7, pluginId: "source-a", chapterPath: "/chapter/7", title: "Chapter 7" });
    await expect(original.promise).rejects.toBe(error);
    await waitForChapterDownloadQueueMutations();
    expect(backendQueueValues.has(7)).toBe(false);

    const retried = scheduler.retry(original.id);
    if (!retried) throw new Error("Missing manual retry");
    await flushMicrotasks(100);
    await waitForChapterDownloadQueueMutations();
    expect(backendQueueValues.has(7)).toBe(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const interrupted = expect(retried.promise).rejects.toMatchObject({ name: "AbortError" });
    suspended.reject(new DOMException("WebView suspended", "AbortError"));
    await interrupted;
    await waitForChapterDownloadQueueMutations();
    expect(backendQueueValues.has(7)).toBe(true);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const failedAgain = scheduler.retry(retried.id);
    if (!failedAgain) throw new Error("Missing second manual retry");
    await expect(failedAgain.promise).rejects.toBe(error);
    await waitForChapterDownloadQueueMutations();
    expect(backendQueueValues.has(7)).toBe(false);
    expect(saveStoredChapterContent).not.toHaveBeenCalled();
  });

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
    ).rejects.toMatchObject({ code: "chapter-storage-failed", cause: storageError });

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

describe("explicit retries after a failed chapter download", () => {
  async function realScheduler() {
    const { TaskScheduler } = await vi.importActual<typeof import("./scheduler")>("./scheduler");
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    schedulerMocks.enqueueSource.mockImplementation((spec: SourceTaskSpec<void>) =>
      scheduler.enqueueSource({ ...spec, sourceCooldownMs: 0 }));
    vi.mocked(taskScheduler.getTaskByDedupeKey).mockImplementation((key) => scheduler.getTaskByDedupeKey(key));
    vi.mocked(taskScheduler.forgetSettledTask).mockImplementation((id) => scheduler.forgetSettledTask(id));
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    pluginMocks.loadInstalledFromDb.mockResolvedValue(undefined);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    return scheduler;
  }
  const job = { id: 7, pluginId: "source-a", chapterPath: "/chapter/7", title: "Chapter 7", batchId: "batch-a", batchTitle: "Batch" };

  it("retains the failed record and source hold until manual retry despite a legacy retry deadline", async () => {
    const scheduler = await realScheduler();
    const error = new Error("Failed to fetch");
    pluginMocks.getChapterResource.mockRejectedValueOnce(error);
    failureMocks.record.mockResolvedValueOnce({ nextRetryAt: Date.now() + 30_000 });
    const original = enqueueChapterDownload(job);
    try {
      await expect(original.promise).rejects.toBe(error);
      await waitForChapterDownloadQueueMutations();
      await flushMicrotasks(50);

      expect(failureMocks.record).toHaveBeenCalledWith(expect.objectContaining({ id: 7, pluginId: "source-a" }), error);
      expect(scheduler.getTask(original.id)).toMatchObject({ status: "failed", canRetry: true });
      expect(scheduler.getSnapshot().pausedSourceIds).toContain("source-a");
      expect(scheduler.getDownloadFailureStops()).toMatchObject({ sourceErrors: { "source-a": "Failed to fetch" } });
      expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(1);
      expect(backendQueueValues.has(7)).toBe(false);
      expect(pluginMocks.getChapterResource).toHaveBeenCalledTimes(1);

      const retry = scheduler.retry(original.id);
      if (!retry) throw new Error("Missing manual retry");
      await retry.promise;
      await waitForChapterDownloadQueueMutations();
      expect(scheduler.getTask(retry.id)).toMatchObject({ status: "succeeded" });
      expect(scheduler.getDownloadFailureStops()).toEqual({ sourceErrors: {} });
      expect(failureMocks.forget).toHaveBeenCalledWith([7]);
      expect(pluginMocks.getChapterResource).toHaveBeenCalledTimes(2);
      expect(backendQueueValues.has(7)).toBe(false);
    } finally {
      scheduler.cancelActiveTasks({ discardQueued: true });
    }
  });

  it("keeps a failure without retry budget as a failed record and removes its queue row", async () => {
    const scheduler = await realScheduler();
    const error = new Error("Failed to fetch novel data: (404)");
    pluginMocks.getChapterResource.mockRejectedValueOnce(error);
    failureMocks.record.mockResolvedValueOnce({ nextRetryAt: null });
    const original = enqueueChapterDownload(job);
    await expect(original.promise).rejects.toBe(error);
    await waitForChapterDownloadQueueMutations();

    expect(failureMocks.record).toHaveBeenCalledTimes(1);
    expect(scheduler.getTask(original.id)).toMatchObject({ status: "failed", canRetry: true });
    expect(backendQueueValues.has(7)).toBe(false);
  });

  it("clears the recorded failure when the chapter is already stored", async () => {
    await realScheduler();
    vi.mocked(getChapterById).mockResolvedValue({ id: 7, novelId: 1, isDownloaded: true } as never);
    await enqueueChapterDownload(job).promise;
    expect(failureMocks.forget).toHaveBeenCalledWith([7]);
  });

  it("restores a waiting attempt from its queue row and the failure table", () => {
    expect(failedChapterDownloadJob(JSON.stringify({ ...job, retryAt: 99 }))).toEqual(
      expect.objectContaining({ id: 7, pluginId: "source-a", chapterPath: "/chapter/7", title: "Chapter 7" }));
    expect(failedChapterDownloadJob(JSON.stringify({ ...job, retryAt: 99 }))?.retryAt).toBeUndefined();
    expect(failedChapterDownloadJob(JSON.stringify({ ...job, vpnPlanId: "plan", vpnRangeId: "range" }))).toBeNull();
    expect(failedChapterDownloadJob("not json")).toBeNull();
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

  it("clears the recorded failure once a repair stores every asset", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    pluginMocks.loadInstalledFromDb.mockResolvedValue(undefined);
    vi.mocked(readStoredChapterContentMirror).mockResolvedValueOnce("<p>Stored body</p>");
    vi.mocked(cacheHtmlChapterMedia).mockResolvedValueOnce({ html: "<p>Stored body</p>", mediaBytes: 25, mediaFailures: [], storedMediaCount: 1 });
    enqueueChapterMediaRepair({ id: 7, pluginId: "source-a", title: "Chapter 7" });
    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({ setDetail: vi.fn(), setProgress: vi.fn(), signal: new AbortController().signal, taskId: "task-1" });
    expect(failureMocks.forget).toHaveBeenCalledWith([7]);
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


describe("selected recovery in chapter acquisition", () => {
  it.each(["ordinary", "vpn"] as const)("waits for one origin reset before retrying a 403 on the same %s route", async route => {
    vi.useFakeTimers();
    const previousPolicy = getDownloadRecoveryPolicy();
    useDownloadRecoveryStore.getState().setPolicy({ forbiddenAction: "resetSite", maxRetries: 1, retryDelaySeconds: 5 });
    const reset = createDeferred<void>();
    siteRecoveryMocks.reset.mockReset().mockReturnValue(reset.promise);
    // Media-only fixtures deliberately leave unused one-shot server/source mocks.
    vi.mocked(tryDownloadServerChapter).mockReset().mockResolvedValue(false);
    pluginMocks.getChapterResource.mockReset().mockResolvedValue(contentResource("Recovered chapter", "text"))
      .mockRejectedValueOnce(new HttpStatusError(403, "Forbidden"));
    const worker = { rangeId: "recovery-range", slot: 0, generation: 8 } as const;
    const profile = { id: "profile-a", ip: "192.0.2.1", protocol: "tcp", hash: "a".repeat(64), approvedAt: 1, approvalSequence: 1 };
    const invoke = tauriMocks.invoke.getMockImplementation()!;
    tauriMocks.invoke.mockImplementation((command, args) => command === "plugin_vpn_download_worker_validate"
      ? Promise.resolve({ supported: true, worker, phase: "connected", proxyPort: 12000, error: null, profile }) : invoke(command, args));
    const job = { id: 7, pluginId: "source-a", novelId: 11, chapterPath: "/chapter/7", title: "Chapter 7" };
    const completed = vi.fn(async () => undefined);
    if (route === "vpn") enqueueVpnDownloadChapter({ ...job, vpnPlanId: "recovery-plan", vpnRangeId: worker.rangeId }, worker, completed, profile);
    else enqueueChapterDownload(job);
    const controller = new AbortController();
    const running = capturedSpec!.run({ executor: route === "vpn" ? "vpn:0:8" : "pool:0", setDetail: vi.fn(), setProgress: vi.fn(),
      signal: controller.signal, taskId: "recovery-task" });
    try {
      await flushMicrotasks(100);
      expect(pluginMocks.getChapterResource).toHaveBeenCalledOnce();
      expect(recoveryHarness.current.getSnapshot()).toMatchObject([{ action: "resetSite", status: "waiting", retries: 1, siteResetCount: 1 }]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(siteRecoveryMocks.reset).toHaveBeenCalledExactlyOnceWith("source-a", "https://source.test");
      expect(pluginMocks.getChapterResource).toHaveBeenCalledOnce();
      expect(saveStoredChapterContent).not.toHaveBeenCalled();
      expect(completed).not.toHaveBeenCalled();
      reset.resolve();
      await running;
      expect(pluginMocks.getChapterResource).toHaveBeenCalledTimes(2);
      expect(saveStoredChapterContent).toHaveBeenCalledOnce();
      expect(failureMocks.record).not.toHaveBeenCalled();
      expect(recoveryHarness.current.getSnapshot()).toEqual([]);
      if (route === "vpn") {
        expect(completed).toHaveBeenCalledOnce();
        const validations = tauriMocks.invoke.mock.calls.filter(([command]) => command === "plugin_vpn_download_worker_validate");
        expect(validations.length).toBeGreaterThanOrEqual(2);
        expect(validations.every(([, args]) => JSON.stringify(args) === JSON.stringify({ worker }))).toBe(true);
      }
    } finally {
      reset.resolve();
      controller.abort();
      await running.catch(() => undefined);
      useDownloadRecoveryStore.getState().setPolicy(previousPolicy);
      vi.useRealTimers();
    }
  });
});


describe("explicit content server requests", () => {
  const job: ChapterDownloadJob = {
    id: 7, novelId: 11, pluginId: "source-a", chapterPath: "/chapter/7", title: "Server chapter", serverOnly: true,
  };
  const context = () => ({
    executor: "server:0" as ScraperExecutorId, setDetail: vi.fn(), setProgress: vi.fn(),
    signal: new AbortController().signal, taskId: "task-1",
  });

  it("keeps server-only intent after durable failure restoration and bypasses source plugins and VPN admission", async () => {
    installChapterDownloadBatchInterceptor({ enqueue: () => null, cancel: () => false,
      enqueueChapter: () => { throw new Error("A server download must not enter the VPN queue"); } });
    const restored = failedChapterDownloadJob(JSON.stringify(job));
    expect(restored).toMatchObject({ serverOnly: true });
    vi.mocked(tryDownloadServerChapter).mockResolvedValueOnce(true);
    enqueueChapterDownload(restored!);
    expect(capturedSpec).toMatchObject({ serverLane: true, serverOnly: true });
    expect(capturedSpec?.resolveSourceAccessUrl).toBeUndefined();
    expect(capturedSpec?.sourceAccessVerificationKey).toBeUndefined();
    await capturedSpec!.run(context());
    expect(tryDownloadServerChapter).toHaveBeenCalledWith(expect.objectContaining({ serverOnly: true }),
      expect.any(AbortSignal), undefined, { requireComplete: true, serverOnly: true });
    expect(pluginMocks.getPlugin).not.toHaveBeenCalled();
    expect(pluginMocks.loadInstalledFromDb).not.toHaveBeenCalled();
    expect(pluginMocks.getPluginForExecutor).not.toHaveBeenCalled();
    expect(syncNovelFromSource).not.toHaveBeenCalled();
  });

  it("never resolves a source path when a server-only request finds no server copy", async () => {
    vi.mocked(getChapterById).mockResolvedValue({ id: 7, novelId: 11, path: "norea-folder:7", chapterNumber: "7", position: 7 } as never);
    enqueueChapterDownload({ ...job, chapterPath: "norea-folder:7" });
    await expect(capturedSpec!.run(context())).rejects.toThrow("not stored on the content server");
    expect(pluginMocks.getPluginForExecutor).not.toHaveBeenCalled();
    expect(syncNovelFromSource).not.toHaveBeenCalled();
  });

  it("can fetch a server copy despite a held source recovery episode", async () => {
    recoveryHarness.current.register([job]);
    recoveryHarness.current.networkLost("chapter:7", new Error("Source VPN offline"));
    expect(recoveryHarness.current.getSnapshot()).toMatchObject([{ key: "chapter:7", status: "held" }]);
    vi.mocked(tryDownloadServerChapter).mockResolvedValueOnce(true);
    enqueueChapterDownload(job);
    await capturedSpec!.run(context());
    expect(tryDownloadServerChapter).toHaveBeenCalledOnce();
    expect(recoveryHarness.current.getSnapshot()).toEqual([]);
    expect(siteRecoveryMocks.reset).not.toHaveBeenCalled();
  });

  it("retries a failed server request without resuming the plugin source queue", async () => {
    failureMocks.snapshot.mockReturnValue([{ chapterId: 7, pluginId: "source-a", failureClass: "transient", nextRetryAt: null,
      jobJson: JSON.stringify(job) } as StoredChapterDownloadFailure]);
    expect(await retryFailedChapterDownloads([7])).toBe(1);
    expect(capturedSpec).toMatchObject({ serverLane: true, serverOnly: true });
    expect(taskScheduler.resumeSourceQueue).not.toHaveBeenCalled();
  });

  it("still clears the storage hold when explicitly retrying a failed server write", async () => {
    failureMocks.snapshot.mockReturnValue([{ chapterId: 7, pluginId: "source-a", failureClass: "storage", nextRetryAt: null,
      jobJson: JSON.stringify(job) } as StoredChapterDownloadFailure]);
    expect(await retryFailedChapterDownloads([7])).toBe(1);
    expect(taskScheduler.resumeSourceQueue).toHaveBeenCalledExactlyOnceWith();
  });

  it("replaces a queued source task before persisting the strict request and keeps the new owner after cancellation", async () => {
    const { TaskScheduler } = await vi.importActual<typeof import("./scheduler")>("./scheduler");
    const scheduler = new TaskScheduler({ sourceQueuesPaused: true });
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    schedulerMocks.enqueueSource.mockImplementation((spec: SourceTaskSpec<void>) => scheduler.enqueueSource(spec));
    vi.mocked(taskScheduler.getTaskByDedupeKey).mockImplementation(key => scheduler.getTaskByDedupeKey(key));
    vi.mocked(taskScheduler.cancel).mockImplementation(id => scheduler.cancel(id));
    const request = { ...job, id: 900061 };
    const previous = enqueueChapterDownload({ ...request, serverOnly: undefined });
    const previousOutcome = previous.promise.catch(error => error);
    await waitForChapterDownloadQueueMutations();
    pluginMocks.getPlugin.mockClear();
    vi.mocked(tryDownloadServerChapter).mockResolvedValue(true);
    const strict = enqueueChapterDownload(request);
    try {
      expect(strict.id).not.toBe(previous.id);
      expect(await previousOutcome).toMatchObject({ cancelledByUser: true });
      await flushMicrotasks();
      await waitForChapterDownloadQueueMutations();
      expect(backendQueueValues.get(request.id)).toMatchObject({ serverOnly: true });
      expect(scheduler.getTask(strict.id)?.status).toBe("queued");
      expect(tryDownloadServerChapter).not.toHaveBeenCalled();
      scheduler.resumeSourceQueue();
      await strict.promise;
      expect(tryDownloadServerChapter).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ serverOnly: true }),
        expect.any(AbortSignal), expect.any(Function), { requireComplete: true, serverOnly: true });
      expect(pluginMocks.getPlugin).not.toHaveBeenCalled();
      expect(pluginMocks.getPluginForExecutor).not.toHaveBeenCalled();
    } finally {
      scheduler.cancelActiveTasks({ discardQueued: true });
      await strict.promise.catch(() => undefined);
      await waitForChapterDownloadQueueMutations();
    }
  });

  it.each(["running", "VPN-owned"])("rejects a strict request over a %s source task before changing its queue row", async route => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const original = { ...job, serverOnly: undefined, title: "Existing source request" };
    backendQueueValues.set(job.id, original);
    vi.mocked(taskScheduler.getTaskByDedupeKey).mockReturnValue({
      id: "existing-source", kind: "chapter.download", status: route === "running" ? "running" : "queued",
      ...(route === "VPN-owned" ? { vpnWorker: { rangeId: "range-a", slot: 0, generation: 1 } } : {}),
    } as never);
    expect(() => enqueueChapterDownload(job)).toThrow("already has an active source download");
    await waitForChapterDownloadQueueMutations();
    expect(backendQueueValues.get(job.id)).toBe(original);
    expect(taskScheduler.cancel).not.toHaveBeenCalled();
    expect(schedulerMocks.enqueueSource).not.toHaveBeenCalled();
    expect(tauriMocks.invoke.mock.calls.some(([command]) => command === "chapter_download_queue_enqueue")).toBe(false);
  });

  it("keeps a server-only batch out of automatic VPN admission", async () => {
    installChapterDownloadBatchInterceptor({ enqueue: () => { throw new Error("Unexpected source VPN admission"); }, cancel: () => false });
    schedulerMocks.enqueueSource.mockImplementation((spec: SourceTaskSpec<void>) => {
      capturedSpec = spec; return { id: "server-task", promise: Promise.resolve() };
    });
    const request = enqueueChapterDownloadBatch({ jobs: [job], title: "Server batch", materializeAllTasks: true });
    await request.materialized;
    await expect(request.promise).resolves.toMatchObject({ total: 1, succeeded: 1 });
    expect(capturedSpec?.serverLane).toBe(true);
  });
});
