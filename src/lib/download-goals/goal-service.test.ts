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
  excluded: new Set<number>(),
  stopped: new Set<number>(),
  remoteApply: false,
}));

vi.mock("../../db/queries/chapter", () => ({
  hasStoredChapterContent: (row: { isDownloaded: boolean; contentBytes: number }) => row.isDownloaded || row.contentBytes > 0,
  listLibraryDownloadChapters: vi.fn(async (novelId: number) => mocks.chapters.get(novelId) ?? []),
}));
vi.mock("../../db/queries/novel-download-goal", () => ({
  listDownloadGoalNovels: vi.fn(async (_since: number | null, ids?: readonly number[]) =>
    mocks.novels.filter(novel => !mocks.stopped.has((novel as { id: number }).id) && (!ids || ids.includes((novel as { id: number }).id)))),
  listGoalNovelIdsForDownloadScope: vi.fn(async () => [5]),
  setNovelDownloadGoal: vi.fn(async (id: number, goal: { kind: string } | null) => {
    if (goal?.kind === "none") mocks.stopped.add(id);
    else mocks.stopped.delete(id);
    return true;
  }),
  resumeStoppedNovelDownloadGoal: vi.fn(async (id: number) => mocks.stopped.delete(id)),
  excludeChaptersFromDownloadGoals: vi.fn(async (ids: readonly number[]) => { for (const id of ids) mocks.excluded.add(id); }),
  listDownloadGoalExcludedChapterIds: vi.fn(async () => [...mocks.excluded]),
}));
vi.mock("../../i18n", () => ({ translate: (_locale: string, key: string) => key }));
vi.mock("../../store/appearance", () => ({ useAppearanceStore: { getState: () => ({ appLocale: "en" }) } }));
vi.mock("../../store/reader", async () => {
  const { create: createStore } = await import("zustand");
  return { isApplyingSharedReaderResume: () => mocks.remoteApply, useReaderStore: createStore(() => ({ lastReadChapterByNovel: {} as Record<number, number> })) };
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
  cancelChapterDownloadTasks: vi.fn(async (ids: readonly number[]) => {
    for (const id of ids) mocks.downloadListener?.({ job: { id, goal: true }, status: { kind: "cancelled" } });
  }),
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
vi.mock("./legacy-read-ahead", () => ({ migrateLegacyReadAhead: vi.fn(async () => undefined) }));
vi.mock("./budget", async (importOriginal) => ({
  ...await importOriginal<typeof import("./budget")>(),
  readDownloadBudgetStatus: async () => mocks.budget,
}));

import { listLibraryDownloadChapters } from "../../db/queries/chapter";
import { listGoalNovelIdsForDownloadScope, resumeStoppedNovelDownloadGoal, setNovelDownloadGoal } from "../../db/queries/novel-download-goal";
import { useDownloadGoalSettingsStore } from "../../store/download-goals";
import { useReaderStore } from "../../store/reader";
import { cancelChapterDownloadTasks, discardQueuedChapterDownloads } from "../tasks/chapter-download";
import { taskScheduler } from "../tasks/scheduler";
import { cancelChapterDownloadRequest } from "../tasks/chapter-download-requests";
import { holdDownloadGoalsAfterRestore } from "./budget";
import {
  allowAutomaticDownloadsOnce,
  getDownloadGoalPauseSnapshot,
  noteDownloadDeletion,
  reconcileDownloadGoals,
  resetDownloadGoalsForTests,
  resumeDownloadGoalsAfterRestore,
  removeDownloadGoals,
  resumeStoppedDownloadGoals,
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
    [2, [row(20), row(21, { isDownloadQueued: true }), row(22), row(23)]],
  ]);
  mocks.queued = new Set([14]);
  mocks.failed = [{ chapterId: 22 }];
  mocks.budget = { metered: false, powerSave: false, freeBytes: null };
  mocks.submitted = [];
  mocks.records = [];
  mocks.excluded = new Set();
  mocks.stopped = new Set();
  mocks.remoteApply = false;
  useDownloadGoalSettingsStore.setState({ automaticGoal: { kind: "keep_ahead", count: 3 }, automaticOnMobileData: false });
  useReaderStore.setState({ lastReadChapterByNovel: {} });
  vi.clearAllMocks();
});

afterEach(() => {
  resetDownloadGoalsForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("queues the global range for each active novel, the most recently read first", async () => {
  startDownloadGoals();
  await settle();

  expect(mocks.submitted.map((request) => request.novelIds)).toEqual([[1], [2]]);
  expect((await jobsOf(0)).map((job) => [job.id, job.priority, job.goal])).toEqual([
    [11, "deferred", true], [13, "deferred", true],
  ]);
  expect((await jobsOf(1)).map((job) => [job.id, job.priority])).toEqual([[20, "background"]]);
  await expect(mocks.submitted[0]!.prepare(new AbortController().signal)).resolves.toMatchObject({ materializeAllTasks: true });
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

it("withdraws queued goal work when a novel leaves the library", async () => {
  startDownloadGoals();
  await settle();
  mocks.queued = new Set([11, 13]);

  const cleared = removeDownloadGoals([1]);
  await vi.advanceTimersByTimeAsync(10);
  await cleared;

  expect(setNovelDownloadGoal).toHaveBeenCalledWith(1, null);
  expect(discardQueuedChapterDownloads).toHaveBeenCalledWith([11, 13]);
  expect(cancelChapterDownloadTasks).toHaveBeenCalledWith([11, 13]);
  expect(mocks.excluded).toEqual(new Set());
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

  expect(await noteDownloadDeletion([11])).toEqual([5]);
  expect(listGoalNovelIdsForDownloadScope).toHaveBeenCalledWith("chapter", [11], expect.any(Number));
  mocks.downloadListener?.({ job: { id: 13, goal: true }, status: { kind: "cancelled" } });
  reconcileDownloadGoals([1]);
  await settle();

  expect(mocks.submitted).toEqual([]);
});

it("keeps deleted and cancelled chapters excluded after restart and an explicit work resume", async () => {
  startDownloadGoals();
  await settle();
  await noteDownloadDeletion([11]);
  mocks.downloadListener?.({ job: { id: 13, goal: true }, status: { kind: "cancelled" } });
  await settle();
  expect(mocks.excluded).toEqual(new Set([11, 13]));

  resetDownloadGoalsForTests();
  mocks.submitted = [];
  startDownloadGoals();
  await settle();
  expect(mocks.submitted.map((request) => request.novelIds)).toEqual([[2]]);

  mocks.submitted = [];
  await stopDownloadGoals([1]);
  expect(await resumeStoppedDownloadGoals([1, 1, 2, 99, Number.NaN])).toBe(1);
  await settle();
  expect(mocks.excluded).toEqual(new Set([11, 13]));
  expect(mocks.submitted).toEqual([]);
  expect(resumeStoppedNovelDownloadGoal).toHaveBeenCalledTimes(3);
});

it.each([
  { goal: { kind: "keep_ahead", count: 1 } as const, first: [11], second: [20] },
  { goal: { kind: "all_remaining" } as const, first: [11, 13, 15], second: [20, 23] },
  { goal: { kind: "entire" } as const, first: [10, 11, 13, 15], second: [20, 23] },
])("uses the global $goal.kind range instead of a retained per-novel policy", async ({ goal, first, second }) => {
  (mocks.novels[0] as { goal: unknown }).goal = { kind: "keep_ahead", count: 30 };
  useDownloadGoalSettingsStore.getState().setAutomaticGoal(goal);
  startDownloadGoals();
  await settle();
  expect((await jobsOf(0)).map(job => job.id)).toEqual(first);
  expect((await jobsOf(1)).map(job => job.id)).toEqual(second);
});

it("changes future automatic selection without cancelling queued requests or clearing failures and exclusions", async () => {
  startDownloadGoals();
  await settle();
  mocks.queued = new Set([11, 13, 14, 20]);
  mocks.records = [{ kind: "chapter.download", automatic: false, status: "queued", subject: { chapterId: 99, novelId: 1 } }];
  mocks.excluded.add(15);
  mocks.submitted = [];

  useDownloadGoalSettingsStore.getState().setAutomaticGoal({ kind: "entire" });
  await settle();
  expect((await jobsOf(0)).map(job => job.id)).toEqual([10]);
  expect((await jobsOf(1)).map(job => job.id)).toEqual([23]);
  mocks.submitted = [];
  useDownloadGoalSettingsStore.getState().setAutomaticGoal({ kind: "none" });
  await settle();

  expect(mocks.submitted).toEqual([]);
  expect(mocks.queued).toEqual(new Set([11, 13, 14, 20]));
  expect(mocks.records).toHaveLength(1);
  expect(mocks.failed).toEqual([{ chapterId: 22 }]);
  expect(mocks.excluded).toEqual(new Set([15]));
  expect(setNovelDownloadGoal).not.toHaveBeenCalled();
  expect(discardQueuedChapterDownloads).not.toHaveBeenCalled();
  expect(cancelChapterDownloadTasks).not.toHaveBeenCalled();
  expect(cancelChapterDownloadRequest).not.toHaveBeenCalled();
});

it("resumes a stopped work while global downloads are off without adding or clearing work", async () => {
  useDownloadGoalSettingsStore.getState().setAutomaticGoal({ kind: "none" });
  mocks.stopped.add(1);
  mocks.excluded.add(11);
  startDownloadGoals();
  await settle();

  expect(await resumeStoppedDownloadGoals([1, 2])).toBe(1);
  await settle();
  expect(mocks.stopped).toEqual(new Set());
  expect(mocks.submitted).toEqual([]);
  expect(mocks.queued).toEqual(new Set([14]));
  expect(mocks.failed).toEqual([{ chapterId: 22 }]);
  expect(mocks.excluded).toEqual(new Set([11]));
  expect(discardQueuedChapterDownloads).not.toHaveBeenCalled();
  expect(cancelChapterDownloadTasks).not.toHaveBeenCalled();
});

it("does not publish a stale automatic range after the global policy changes during a chapter read", async () => {
  let release!: () => void;
  vi.mocked(listLibraryDownloadChapters).mockImplementationOnce(() => new Promise(resolve => {
    release = () => resolve(mocks.chapters.get(1) as never);
  }));
  startDownloadGoals();
  await vi.advanceTimersByTimeAsync(600);
  useDownloadGoalSettingsStore.getState().setAutomaticGoal({ kind: "none" });
  release();
  await settle();
  expect(mocks.submitted).toEqual([]);
});


it("does not schedule source downloads for a shared resume but follows a later local read", async () => {
  startDownloadGoals();
  await settle();
  mocks.submitted = [];
  mocks.queued = new Set([11, 13, 14]);
  mocks.remoteApply = true;
  useReaderStore.setState({ lastReadChapterByNovel: { 1: 11 } });
  mocks.remoteApply = false;
  await settle();
  expect(mocks.submitted).toEqual([]);

  useReaderStore.setState({ lastReadChapterByNovel: { 1: 13 } });
  await settle();
  expect(mocks.submitted.map(request => request.novelIds)).toEqual([[1]]);
  expect((await jobsOf(0)).map(job => job.id)).toEqual([15]);
});
