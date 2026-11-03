import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  novels: [] as unknown[],
  chapters: new Map<number, unknown[]>(),
  queued: new Set<number>(),
  failed: [] as { chapterId: number }[],
  budget: { metered: false, powerSave: false, freeBytes: null as number | null },
  submitted: [] as { key: string; novelIds: readonly number[]; prepare: (signal: AbortSignal) => Promise<{ jobs: unknown[] }> }[],
  records: [] as unknown[],
  downloadListener: null as ((event: unknown) => void) | null,
}));

vi.mock("../../db/queries/chapter", () => ({
  hasStoredChapterContent: (row: { isDownloaded: boolean; contentBytes: number }) => row.isDownloaded || row.contentBytes > 0,
  listLibraryDownloadChapters: vi.fn(async (novelId: number) => mocks.chapters.get(novelId) ?? []),
}));
vi.mock("../../db/queries/novel-download-goal", () => ({
  listDownloadGoalNovels: vi.fn(async (_since: number | null, ids?: readonly number[]) =>
    ids ? mocks.novels.filter((novel) => ids.includes((novel as { id: number }).id)) : mocks.novels),
  listGoalNovelIdsForDownloadScope: vi.fn(async () => [5]),
  setNovelDownloadGoal: vi.fn(async () => true),
}));
vi.mock("../../i18n", () => ({ translate: (_locale: string, key: string) => key }));
vi.mock("../../store/appearance", () => ({ useAppearanceStore: { getState: () => ({ appLocale: "en" }) } }));
vi.mock("../../store/reader", async () => {
  const { create: createStore } = await import("zustand");
  return { useReaderStore: createStore(() => ({ lastReadChapterByNovel: {} as Record<number, number> })) };
});
vi.mock("../content-sync/server-lane", () => ({
  planServerLaneJobs: async (_novel: unknown, jobs: unknown[]) => jobs,
}));
vi.mock("../network", async () => {
  const { create: createStore } = await import("zustand");
  return { useNetworkStore: createStore(() => ({ revision: 0 })) };
});
vi.mock("../plugins/manager", () => ({
  pluginManager: { loadInstalledFromDb: vi.fn(async () => undefined), getPlugin: (id: string) => ({ id, name: "Source" }) },
}));
vi.mock("../tasks/chapter-download", () => ({
  cancelChapterDownloadTasks: vi.fn(async () => undefined),
  discardQueuedChapterDownloads: vi.fn(async () => undefined),
  getChapterDownloadStatus: vi.fn(() => undefined),
  isChapterDownloadQueued: (id: number) => mocks.queued.has(id),
  subscribeChapterDownloads: (listener: (event: unknown) => void) => { mocks.downloadListener = listener; return () => undefined; },
  waitForChapterDownloadQueueRestoration: async () => undefined,
}));
vi.mock("../tasks/chapter-download-requests", () => ({
  cancelChapterDownloadRequest: vi.fn(),
  submitChapterDownloadRequest: vi.fn((input: (typeof mocks.submitted)[number]) => {
    mocks.submitted.push(input);
    return { id: `request-${mocks.submitted.length}`, materialized: Promise.resolve(), promise: Promise.resolve() };
  }),
}));
vi.mock("../tasks/chapter-download-failures", () => ({
  getChapterDownloadFailureSnapshot: () => mocks.failed,
  refreshChapterDownloadFailures: async () => undefined,
  subscribeChapterDownloadFailures: () => () => undefined,
}));
vi.mock("../tasks/scheduler", () => ({
  taskScheduler: {
    setAutomaticWorkPaused: vi.fn(), getSnapshot: () => ({ records: mocks.records }), subscribeEvents: () => () => undefined,
  },
}));
vi.mock("../updates/update-index-events", () => ({ subscribeUpdatesIndexChanges: () => () => undefined }));
vi.mock("./budget", async (importOriginal) => ({
  ...await importOriginal<typeof import("./budget")>(),
  readDownloadBudgetStatus: async () => mocks.budget,
}));

import { setNovelDownloadGoal } from "../../db/queries/novel-download-goal";
import { useDownloadGoalSettingsStore } from "../../store/download-goals";
import { useReaderStore } from "../../store/reader";
import { cancelChapterDownloadTasks, discardQueuedChapterDownloads } from "../tasks/chapter-download";
import { taskScheduler } from "../tasks/scheduler";
import { holdDownloadGoalsAfterRestore } from "./budget";
import {
  allowAutomaticDownloadsOnce,
  getDownloadGoalPauseSnapshot,
  noteDownloadDeletion,
  reconcileDownloadGoals,
  resetDownloadGoalsForTests,
  resumeDownloadGoalsAfterRestore,
  setDownloadGoal,
  startDownloadGoals,
  stopDownloadGoals,
  waitForDownloadGoalReconcile,
} from "./goal-service";

const row = (id: number, extra: Record<string, unknown> = {}) => ({
  id, path: `/c/${id}`, name: `Chapter ${id}`, chapterNumber: String(id), contentType: "html",
  isDownloaded: false, contentBytes: 0, mediaRepairNeeded: false, readAt: null, isDownloadQueued: false, ...extra,
});

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(600);
  const done = waitForDownloadGoalReconcile();
  await vi.advanceTimersByTimeAsync(600);
  await done;
}

async function jobsOf(index: number) {
  return (await mocks.submitted[index]!.prepare(new AbortController().signal)).jobs as Record<string, unknown>[];
}

beforeEach(() => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  mocks.novels = [
    { id: 1, pluginId: "source", path: "/one", name: "One", lastReadAt: 900, goal: null },
    { id: 2, pluginId: "source", path: "/two", name: "Two", lastReadAt: 100, goal: { kind: "entire" } },
  ];
  mocks.chapters = new Map([
    [1, [row(10, { readAt: 50 }), row(11), row(12, { isDownloaded: true, contentBytes: 5 }), row(13), row(14), row(15)]],
    [2, [row(20), row(21, { isDownloadQueued: true }), row(22)]],
  ]);
  mocks.queued = new Set([14]);
  mocks.failed = [{ chapterId: 22 }];
  mocks.budget = { metered: false, powerSave: false, freeBytes: null };
  mocks.submitted = [];
  mocks.records = [];
  useDownloadGoalSettingsStore.setState({ defaultKeepAhead: 3, automaticOnMobileData: false });
  useReaderStore.setState({ lastReadChapterByNovel: {} });
  vi.clearAllMocks();
});

afterEach(() => {
  resetDownloadGoalsForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("queues each goal's missing chapters at start, the most recently read novel first", async () => {
  startDownloadGoals();
  await settle();

  expect(mocks.submitted.map((request) => request.novelIds)).toEqual([[1], [2]]);
  expect((await jobsOf(0)).map((job) => [job.id, job.priority, job.goal])).toEqual([
    [11, "deferred", true], [13, "deferred", true],
  ]);
  expect((await jobsOf(1)).map((job) => [job.id, job.priority])).toEqual([[20, "background"]]);
  expect(getDownloadGoalPauseSnapshot().pause).toBeNull();
  expect(taskScheduler.setAutomaticWorkPaused).toHaveBeenLastCalledWith(false);
});

it("follows the reading position when the reader opens another chapter", async () => {
  startDownloadGoals();
  await settle();
  mocks.submitted = [];
  mocks.queued = new Set([11, 13, 14]);

  useReaderStore.setState({ lastReadChapterByNovel: { 1: 13 } });
  await settle();

  expect(mocks.submitted.map((request) => request.novelIds)).toEqual([[1]]);
  expect((await jobsOf(0)).map((job) => job.id)).toEqual([15]);
});

it("pauses goal work on mobile data until Allow once", async () => {
  mocks.budget = { metered: true, powerSave: false, freeBytes: null };
  startDownloadGoals();
  await settle();

  expect(mocks.submitted).toEqual([]);
  expect(getDownloadGoalPauseSnapshot().pause).toBe("metered");
  expect(taskScheduler.setAutomaticWorkPaused).toHaveBeenLastCalledWith(true);

  allowAutomaticDownloadsOnce();
  await settle();
  expect(getDownloadGoalPauseSnapshot().pause).toBeNull();
  expect(mocks.submitted).toHaveLength(2);
});

it("holds restored goals until the user resumes", async () => {
  holdDownloadGoalsAfterRestore();
  startDownloadGoals();
  await settle();
  expect(getDownloadGoalPauseSnapshot().pause).toBe("restore");
  expect(mocks.submitted).toEqual([]);

  resumeDownloadGoalsAfterRestore();
  await settle();
  expect(mocks.submitted).toHaveLength(2);
});

it("withdraws queued goal work when the goal is cleared", async () => {
  startDownloadGoals();
  await settle();
  mocks.queued = new Set([11, 13]);

  const cleared = setDownloadGoal(1, null);
  await vi.advanceTimersByTimeAsync(10);
  await cleared;

  expect(setNovelDownloadGoal).toHaveBeenCalledWith(1, null);
  expect(discardQueuedChapterDownloads).toHaveBeenCalledWith([11, 13]);
  expect(cancelChapterDownloadTasks).toHaveBeenCalledWith([11, 13]);
});

it("stores an explicit None when the user stops keeping a novel downloaded", async () => {
  startDownloadGoals();
  await settle();
  mocks.queued = new Set([11, 13]);

  await stopDownloadGoals([1]);

  expect(setNovelDownloadGoal).toHaveBeenCalledWith(1, { kind: "none" });
  expect(discardQueuedChapterDownloads).toHaveBeenCalledWith([11, 13]);
});

it("keeps deleted and cancelled chapters out of later goal work", async () => {
  startDownloadGoals();
  await settle();
  mocks.submitted = [];

  expect(await noteDownloadDeletion("chapter", [11])).toEqual([5]);
  mocks.downloadListener?.({ job: { id: 13, goal: true }, status: { kind: "cancelled" } });
  reconcileDownloadGoals([1]);
  await settle();

  expect(mocks.submitted).toEqual([]);
});
