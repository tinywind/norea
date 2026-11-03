import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(() => true),
  records: [] as { id: string; kind: string; status: string }[],
  enqueueMain: vi.fn(),
  novels: [] as unknown[],
}));

vi.mock("../../db/client", () => ({ getDb: vi.fn(async () => ({ select: async () => mocks.novels })) }));
vi.mock("../../db/queries/chapter", () => ({
  listLibraryUpdatesPage: vi.fn(async () => ({ hasMore: false, nextCursor: null, updates: [] })),
}));
vi.mock("../../db/queries/novel", () => ({ listLibraryNovelRefreshTargets: vi.fn(async () => mocks.novels) }));
vi.mock("../../db/queries/novel-freshness", () => ({ recordNovelCheck: vi.fn(async () => undefined) }));
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
  enqueueSourceTask: vi.fn((task: { run: (context: unknown) => Promise<unknown> }) => ({
    id: "task",
    promise: task.run({ executor: "immediate", signal: new AbortController().signal }),
  })),
}));
vi.mock("../tasks/scheduler", () => ({
  taskScheduler: {
    cancel: mocks.cancel,
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
import { cancelLibraryUpdateCheck, checkForNewChapters, newChapterCheckDedupeKey } from "./check-library-updates";

const novel = (id: number, pluginId = "source") => ({ id, pluginId, path: `/n/${id}`, name: `Novel ${id}` });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.records = [];
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
