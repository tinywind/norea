import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(() => true),
  records: [] as { id: string; kind: string; status: string }[],
  enqueueMain: vi.fn(),
  novels: [] as unknown[],
  recent: new Map<string, number>(),
  latest: undefined as { status: string } | undefined,
  activeChecks: new Map<string, Promise<unknown>>(),
  task: undefined as { startedAt: number; finishedAt: number } | undefined,
}));

vi.mock("../../db/client", () => ({ getDb: vi.fn(async () => ({ select: async () => mocks.novels })) }));
vi.mock("../../db/queries/chapter", () => ({
  listLibraryUpdatesPage: vi.fn(async () => ({ hasMore: false, nextCursor: null, updates: [] })),
}));
vi.mock("../../db/queries/novel", () => ({ listLibraryNovelRefreshTargets: vi.fn(async () => mocks.novels) }));
vi.mock("../../db/queries/novel-freshness", () => ({
  countRecentChecksBySource: vi.fn(async () => new Map(mocks.recent)),
  recordNovelCheck: vi.fn(async () => undefined),
}));
vi.mock("../plugins/manager", () => ({
  pluginManager: {
    getPlugin: (id: string) => (id === "gone" ? undefined : { id, name: `Source ${id}`, getBaseUrl: () => "https://example.test" }),
    getPluginForExecutor: (id: string) => ({ id }),
  },
}));
vi.mock("../plugins/sync-novel", () => ({ syncNovelFromSource: vi.fn() }));
vi.mock("../tasks/batch-window", () => ({
  runBoundedTaskBatch: async ({ items, materialize }: { items: unknown[]; materialize: (item: unknown) => Promise<void> }) => {
    for (const item of items) await materialize(item);
  },
}));
vi.mock("../tasks/source-tasks", () => ({
  enqueueSourceTask: vi.fn((task: { dedupeKey: string; run: (context: unknown) => Promise<unknown> }) => {
    const active = mocks.activeChecks.get(task.dedupeKey);
    if (active) return { id: "task", promise: active };
    const promise = task.run({ executor: "immediate", signal: new AbortController().signal })
      .finally(() => mocks.activeChecks.delete(task.dedupeKey));
    mocks.activeChecks.set(task.dedupeKey, promise);
    return { id: "task", promise };
  }),
}));
vi.mock("../tasks/scheduler", () => ({
  taskScheduler: {
    cancel: mocks.cancel,
    getTaskByDedupeKey: () => mocks.latest,
    getTask: () => mocks.task,
    getSnapshot: () => ({ records: mocks.records }),
    enqueueMain: mocks.enqueueMain.mockImplementation((task: { run: (context: unknown) => Promise<unknown> }) => ({
      id: "main",
      promise: task.run({ signal: new AbortController().signal, setProgress: vi.fn(), setDetail: vi.fn() }),
    })),
  },
}));

import { recordNovelCheck } from "../../db/queries/novel-freshness";
import { syncNovelFromSource } from "../plugins/sync-novel";
import { enqueueSourceTask } from "../tasks/source-tasks";
import { SOURCE_CHECKS_PER_HOUR } from "./check-cadence";
import { cancelLibraryUpdateCheck, checkForNewChapters, newChapterCheckDedupeKey } from "./check-library-updates";

const novel = (id: number, pluginId = "source") => ({ id, pluginId, path: `/n/${id}`, name: `Novel ${id}` });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.records = [];
  mocks.recent = new Map();
  mocks.latest = undefined;
  mocks.task = undefined;
  mocks.novels = [novel(1), novel(2), novel(3, "gone")];
  vi.mocked(syncNovelFromSource).mockImplementation(async (_plugin, item) => {
    if (item.path === "/n/2") throw new Error("Timed out");
    return { changed: true, changedChapters: 2, newChapters: 2, novelId: 1, chapterCount: 5, duplicateChapters: [] };
  });
});

it("checks each novel once per source path as a check and records every outcome", async () => {
  const result = await checkForNewChapters({ limit: 10 });

  expect(vi.mocked(enqueueSourceTask).mock.calls.map(([task]) => task.dedupeKey)).toEqual([
    newChapterCheckDedupeKey("source", "/n/1"), newChapterCheckDedupeKey("source", "/n/2"),
  ]);
  expect(vi.mocked(syncNovelFromSource).mock.calls[0]![2]).toMatchObject({ chapterRefreshMode: "since", markFoundByCheck: true });
  expect(vi.mocked(recordNovelCheck).mock.calls).toEqual([[1, { ok: true, newChapters: 2 }], [2, { ok: false }]]);
  expect(result).toMatchObject({ checkedNovels: 1, newChapters: 2 });
  expect(result.failures.map((failure) => [failure.novelId, failure.reason.kind])).toEqual([[2, "error"], [3, "plugin-missing"]]);
  expect(mocks.enqueueMain.mock.calls[0]![0].dedupeKey).toBe("library.checkUpdates");
});

it("retries only the chosen novels under their own check", async () => {
  await checkForNewChapters({ limit: 10, novelIds: [2, 1] });
  expect(vi.mocked(enqueueSourceTask).mock.calls.map(([task]) => task.subject?.novelId)).toEqual([1, 2]);
  expect(mocks.enqueueMain.mock.calls[0]![0].dedupeKey).toBe('library.checkUpdates:{"novelIds":[1,2]}');
});

it("cancels every running check for new chapters", () => {
  mocks.records = [
    { id: "a", kind: "library.checkUpdates", status: "running" },
    { id: "b", kind: "library.checkUpdates", status: "succeeded" },
    { id: "c", kind: "chapter.download", status: "running" },
  ];
  expect(cancelLibraryUpdateCheck()).toBe(true);
  expect(mocks.cancel.mock.calls).toEqual([["a"]]);
});

it("does nothing when no check is running", () => {
  expect(cancelLibraryUpdateCheck()).toBe(false);
  expect(mocks.cancel).not.toHaveBeenCalled();
});

it("leaves novels beyond their source's hourly budget for later", async () => {
  mocks.recent = new Map([["source", SOURCE_CHECKS_PER_HOUR - 1]]);
  const result = await checkForNewChapters({ limit: 10 });
  expect(vi.mocked(enqueueSourceTask).mock.calls.map(([task]) => [task.subject?.novelId, task.priority])).toEqual([[1, "user"]]);
  expect(result.deferredNovels).toBe(1);
});

it("joins a manual check to the running automatic one instead of checking its novels again", async () => {
  mocks.novels = [novel(1), novel(2), novel(4)];
  let releaseFirst!: () => void;
  const firstStarted = new Promise<void>((started) => {
    vi.mocked(syncNovelFromSource).mockImplementation(async (_plugin, item) => {
      if (item.path === "/n/1") {
        started();
        await new Promise<void>((release) => { releaseFirst = release; });
      }
      return { changed: true, changedChapters: 1, newChapters: 1, novelId: 1, chapterCount: 5, duplicateChapters: [] };
    });
  });
  const automatic = checkForNewChapters({ automatic: true, limit: 1, novelIds: [1, 2] });
  await firstStarted;
  mocks.latest = { status: "queued" };
  const progress = vi.fn();
  const manual = checkForNewChapters({ limit: 10, onProgress: progress });
  await vi.waitFor(() => expect(vi.mocked(enqueueSourceTask).mock.calls.length).toBe(2));
  releaseFirst();

  const [automaticResult, manualResult] = await Promise.all([automatic, manual]);
  expect(mocks.enqueueMain).toHaveBeenCalledTimes(1);
  expect(vi.mocked(enqueueSourceTask).mock.calls.map(([task]) => [task.subject?.novelId, task.priority])).toEqual([
    [1, "deferred"], [1, "user"], [2, "user"], [4, "user"],
  ]);
  expect(vi.mocked(syncNovelFromSource).mock.calls.map(([, item]) => item.path)).toEqual(["/n/1", "/n/2", "/n/4"]);
  expect(manualResult).toMatchObject({ checkedNovels: 3, newChapters: 3 });
  expect(automaticResult.checkedNovels).toBe(3);
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ current: 3, total: 3 }));
});

it("leaves a source for later after three failed checks in a row in an automatic run", async () => {
  mocks.novels = [novel(1), novel(2), novel(4), novel(5), novel(6, "other")];
  vi.mocked(syncNovelFromSource).mockRejectedValue(new Error("Timed out"));

  const result = await checkForNewChapters({ automatic: true, limit: 1, novelIds: [1, 2, 4, 5, 6] });

  expect(vi.mocked(syncNovelFromSource).mock.calls.map(([, item]) => item.path)).toEqual(["/n/1", "/n/2", "/n/4", "/n/6"]);
  expect(result).toMatchObject({ deferredNovels: 1 });
  expect(result.failures).toHaveLength(4);
});

it("counts slow checks toward the backoff, and a manual check keeps going", async () => {
  mocks.novels = [novel(1), novel(2), novel(4), novel(5)];
  mocks.task = { startedAt: 0, finishedAt: 31_000 };

  const automatic = await checkForNewChapters({ automatic: true, limit: 1, novelIds: [1, 2, 4, 5] });
  expect(automatic).toMatchObject({ checkedNovels: 2, deferredNovels: 1 });

  vi.mocked(syncNovelFromSource).mockClear();
  await checkForNewChapters({ limit: 1 });
  expect(vi.mocked(syncNovelFromSource)).toHaveBeenCalledTimes(4);
});
