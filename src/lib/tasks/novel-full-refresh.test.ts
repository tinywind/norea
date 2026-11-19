import { beforeEach, expect, it, vi } from "vitest";
import type { MainTaskSpec, SourceTaskSpec, TaskProgress, TaskRunContext } from "./task-types";

const mocks = vi.hoisted(() => ({
  getNovel: vi.fn(),
  serverSource: vi.fn(),
  refreshServerSource: vi.fn(),
  syncServer: vi.fn(),
  plugin: vi.fn(),
  loadPlugins: vi.fn(),
  syncNovel: vi.fn(),
  enqueueSourceTask: vi.fn(),
  enqueueMain: vi.fn(),
  enqueueSource: vi.fn(),
  cancel: vi.fn(),
  isTauri: false,
}));

vi.mock("../../db/queries/novel", () => ({ getNovelById: mocks.getNovel }));
vi.mock("../content-sync/novel-source", () => ({ readServerNovelSource: mocks.serverSource }));
vi.mock("../content-sync/work-refresh", () => ({
  refreshServerNovelFromSource: mocks.refreshServerSource,
  syncServerNovelOnOpen: mocks.syncServer,
}));
vi.mock("../plugins/manager", () => ({
  pluginManager: {
    getPlugin: mocks.plugin,
    getPluginForExecutor: mocks.plugin,
    loadInstalledFromDb: mocks.loadPlugins,
  },
}));
vi.mock("../plugins/sync-novel", () => ({ syncNovelFromSource: mocks.syncNovel }));
vi.mock("../tauri-runtime", () => ({ isTauriRuntime: () => mocks.isTauri }));
vi.mock("./source-tasks", () => ({ enqueueSourceTask: mocks.enqueueSourceTask }));
vi.mock("./scheduler", () => ({
  taskScheduler: {
    cancel: mocks.cancel,
    enqueueMain: mocks.enqueueMain,
    enqueueSource: mocks.enqueueSource,
  },
}));

import { refreshSelectedNovelsMetadata } from "./novel-full-refresh";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isTauri = false;
  mocks.loadPlugins.mockResolvedValue(undefined);
  mocks.serverSource.mockResolvedValue(null);
  mocks.refreshServerSource.mockResolvedValue(true);
  mocks.syncServer.mockResolvedValue(true);
  mocks.plugin.mockReturnValue({ id: "source", name: "Source" });
  mocks.syncNovel.mockResolvedValue({ duplicateChapters: [] });
  mocks.getNovel.mockImplementation(async (id: number) => ({
    id,
    name: `Novel ${id}`,
    pluginId: "source",
    pluginName: "Source",
    path: `/work/${id}`,
    cover: null,
    isLocal: false,
  }));
  mocks.enqueueSourceTask.mockImplementation((options: { run: (ctx: TaskRunContext) => Promise<unknown> }) => ({
    id: `src-${Math.random().toString(36).slice(2)}`,
    promise: options.run({
      signal: new AbortController().signal,
      executor: "pool:0",
      taskId: "src",
      setDetail: vi.fn(),
      setProgress: vi.fn(),
    }),
  }));
  mocks.enqueueSource.mockImplementation((spec: SourceTaskSpec<boolean>) => ({
    id: `srv-${Math.random().toString(36).slice(2)}`,
    promise: spec.run({
      signal: new AbortController().signal,
      executor: "server:0",
      taskId: "srv",
      setDetail: vi.fn(),
      setProgress: vi.fn(),
    }),
  }));
  mocks.enqueueMain.mockImplementation((spec: MainTaskSpec<unknown>) => {
    const controller = new AbortController();
    const progress: Array<TaskProgress | undefined> = [];
    const details: string[] = [];
    const promise = spec.run({
      signal: controller.signal,
      taskId: "main-1",
      setDetail: (detail) => details.push(detail),
      setProgress: (value) => progress.push(value),
    });
    return { id: "main-1", promise, controller, progress, details };
  });
});

it("runs selected novel refreshes inside one aggregate main task, tracks progress, skips locals, and queues server fallbacks", async () => {
  mocks.isTauri = true;
  mocks.getNovel.mockImplementation(async (id: number) => ({
    id,
    name: `Novel ${id}`,
    pluginId: "source",
    pluginName: "Source",
    path: `/work/${id}`,
    cover: null,
    isLocal: id === 2,
  }));
  mocks.serverSource.mockImplementation(async (id: number) =>
    id === 4 ? { serverUrl: "http://server", workId: "work-4" } : null,
  );
  mocks.refreshServerSource.mockResolvedValueOnce(false);
  mocks.enqueueSourceTask.mockImplementation((options: { subject?: { novelId?: number } }) => ({
    id: `src-${options.subject?.novelId}`,
    promise: options.subject?.novelId === 3
      ? Promise.reject(new Error("Source unavailable"))
      : Promise.resolve({ duplicateChapters: [] }),
  }));

  const settled: number[] = [];
  const handle = refreshSelectedNovelsMetadata({
    novelIds: [1, 2, 3, 4, 1],
    aggregateTaskTitle: "Refresh all details",
    pluginNotLoadedMessage: "Plugin not loaded",
    taskTitle: (novel) => `Refresh ${novel.name}`,
    onNovelSettled: (id) => settled.push(id),
  }) as unknown as {
    promise: Promise<{ refreshed: number; skippedLocal: number; failedIds: number[] }>;
    progress: Array<TaskProgress | undefined>;
    details: string[];
  };

  const result = await handle.promise;
  expect(mocks.loadPlugins).toHaveBeenCalledOnce();
  expect(mocks.enqueueMain).toHaveBeenCalledWith(expect.objectContaining({
    kind: "library.refreshNovels",
    priority: "deferred",
    title: "Refresh all details",
    dedupeKey: "library.refreshNovels:[1,2,3,4]",
  }));
  expect(mocks.enqueueSourceTask).toHaveBeenCalledWith(expect.objectContaining({
    kind: "source.refreshNovel",
    priority: "deferred",
    title: "Refresh Novel 1",
  }));
  expect(mocks.refreshServerSource).toHaveBeenCalledWith(
    4,
    "Refresh Novel 4",
    expect.any(AbortSignal),
    { priority: "deferred", refreshCover: true },
  );
  expect(mocks.enqueueSource).toHaveBeenCalledWith(expect.objectContaining({
    kind: "source.refreshNovel",
    priority: "deferred",
    serverLane: true,
    title: "Refresh Novel 4",
  }));
  expect(mocks.syncServer).toHaveBeenCalledWith(4, expect.any(AbortSignal));
  expect(result).toEqual({ refreshed: 2, skippedLocal: 1, failedIds: [3] });
  expect(settled.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  expect(handle.progress[0]).toEqual({ current: 0, total: 4 });
  expect(handle.progress.at(-1)).toEqual({ current: 4, total: 4 });
});

it("cancels active child tasks when the aggregate batch task is aborted", async () => {
  let rejectChild!: (error: unknown) => void;
  mocks.enqueueSourceTask.mockReturnValueOnce({
    id: "child-1",
    promise: new Promise((_resolve, reject) => { rejectChild = reject; }),
  });

  const handle = refreshSelectedNovelsMetadata({
    novelIds: [1],
    aggregateTaskTitle: "Refresh all details",
    pluginNotLoadedMessage: "Plugin not loaded",
    taskTitle: (novel) => `Refresh ${novel.name}`,
  }) as unknown as {
    promise: Promise<{ refreshed: number; skippedLocal: number; failedIds: number[] }>;
    controller: AbortController;
  };

  await vi.waitFor(() => expect(mocks.enqueueSourceTask).toHaveBeenCalledOnce());
  handle.controller.abort();
  expect(mocks.cancel).toHaveBeenCalledWith("child-1");
  rejectChild(new DOMException("Task was cancelled.", "AbortError"));
  expect(await handle.promise).toEqual({ refreshed: 0, skippedLocal: 0, failedIds: [] });
});
