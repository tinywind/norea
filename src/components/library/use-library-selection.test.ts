import { beforeEach, expect, it, vi } from "vitest";
import type { NovelDownloadGoal } from "../../db/queries/novel-download-goal";

interface Mutation {
  mutationFn: (input: string) => Promise<number>;
  onSettled?: () => void;
}
interface GoalOutcome { applied: number; skippedLocal: number }
interface GoalMutation {
  mutationFn: (input: { goal: NovelDownloadGoal | null; novelIds: number[] }) => Promise<GoalOutcome>;
  onSuccess: (outcome: GoalOutcome) => void;
  onSettled: () => void;
}
const mocks = vi.hoisted(() => ({
  mutations: [] as Mutation[],
  selected: new Set([1]),
  setSelected: vi.fn(),
  selecting: false,
  setSelecting: vi.fn(),
  listIds: vi.fn(),
  getNovel: vi.fn(),
  setGoal: vi.fn(async () => undefined),
  t: vi.fn((key: string) => key),
  invalidate: vi.fn(async () => undefined),
  addCategory: vi.fn(async () => undefined),
  removeCategory: vi.fn(async () => undefined),
  listUnqueued: vi.fn(),
  queued: new Set<number>(),
  submit: vi.fn(() => ({ id: "request", materialized: Promise.resolve(), promise: Promise.resolve() })),
}));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: vi.fn(),
  useState: (initial: unknown) => typeof initial === "function"
    ? [mocks.selected, mocks.setSelected]
    : [mocks.selecting, mocks.setSelecting],
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
  useMutation: (mutation: Mutation) => {
    mocks.mutations.push(mutation);
    return mutation;
  },
}));
vi.mock("../../lib/android-back-navigation", () => ({ useOverlayBackNavigation: vi.fn() }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock("../../db/queries/category", () => ({ addNovelsToCategory: mocks.addCategory, removeNovelsFromCategory: mocks.removeCategory }));
vi.mock("../../db/queries/novel", () => ({ getNovelById: mocks.getNovel, listLibraryNovelIds: mocks.listIds, setNovelInLibrary: vi.fn() }));
vi.mock("../../lib/download-goals/goal-service", () => ({ setDownloadGoal: mocks.setGoal }));
vi.mock("../DownloadGoalWorkLine", () => ({ DOWNLOAD_GOALS_QUERY_KEY: ["download-goals"] }));
vi.mock("../../store/content-deletion", () => ({ confirmContentDeletion: vi.fn() }));
vi.mock("../../db/queries/chapter", () => ({ listUnqueuedChapterDownloads: mocks.listUnqueued }));
vi.mock("../../lib/tasks/chapter-download", () => ({ isChapterDownloadQueued: (id: number) => mocks.queued.has(id) }));
vi.mock("../../lib/tasks/chapter-download-requests", () => ({ submitChapterDownloadRequest: mocks.submit }));
import { useLibrarySelection } from "./use-library-selection";
import { notifications } from "@mantine/notifications";
import { useOverlayBackNavigation } from "../../lib/android-back-navigation";
import { confirmContentDeletion } from "../../store/content-deletion";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mutations.length = 0;
  mocks.selected = new Set([1]);
  mocks.selecting = false;
  mocks.listIds.mockReset().mockResolvedValue([]);
  mocks.listUnqueued.mockReset().mockResolvedValue([]);
  mocks.queued = new Set();
  mocks.getNovel.mockReset().mockImplementation(async (id: number) => ({ id, name: `Novel ${id}`, pluginId: "source", path: `/work/${id}`, isLocal: false }));
});

it("sets the chosen download goal for every selected source novel and leaves local works alone", async () => {
  mocks.getNovel.mockImplementation(async (id: number) => (id === 9 ? null : { id, isLocal: id === 3 }));
  useLibrarySelection({}, "nameAsc");
  const mutation = mocks.mutations[1] as unknown as GoalMutation;
  await expect(mutation.mutationFn({ goal: { kind: "entire" }, novelIds: [1, 2, 3, 9] })).resolves.toEqual({ applied: 2, skippedLocal: 1 });
  expect(mocks.setGoal.mock.calls).toEqual([[1, { kind: "entire" }], [2, { kind: "entire" }]]);

  await mutation.mutationFn({ goal: null, novelIds: [4] });
  expect(mocks.setGoal).toHaveBeenLastCalledWith(4, null);
  mutation.onSettled();
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["download-goals"] });
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["download-goal"] });
});

it("confirms the goal and leaves selection mode", () => {
  useLibrarySelection({}, "nameAsc");
  const mutation = mocks.mutations[1] as unknown as GoalMutation;
  mutation.onSuccess({ applied: 2, skippedLocal: 0 });
  expect(vi.mocked(notifications.show)).toHaveBeenLastCalledWith(expect.objectContaining({ message: "library.downloadGoal.done" }));
  expect(mocks.setSelected).toHaveBeenLastCalledWith(new Set());
  expect(mocks.setSelecting).toHaveBeenLastCalledWith(false);
});

it("says how many local works the goal skipped", () => {
  useLibrarySelection({}, "nameAsc");
  const mutation = mocks.mutations[1] as unknown as GoalMutation;
  mutation.onSuccess({ applied: 2, skippedLocal: 3 });
  expect(mocks.t).toHaveBeenCalledWith("library.downloadGoal.doneSkippedLocal", { count: 2, skipped: 3 });
  expect(vi.mocked(notifications.show)).toHaveBeenLastCalledWith({ color: "ok", message: "library.downloadGoal.doneSkippedLocal" });
});

it("explains that nothing changed when only local works were selected", () => {
  useLibrarySelection({}, "nameAsc");
  const mutation = mocks.mutations[1] as unknown as GoalMutation;
  mutation.onSuccess({ applied: 0, skippedLocal: 2 });
  expect(mocks.t).toHaveBeenCalledWith("library.downloadGoal.noneApplied", { skipped: 2 });
  expect(vi.mocked(notifications.show)).toHaveBeenLastCalledWith({ color: "warn", message: "library.downloadGoal.noneApplied" });
  expect(mocks.t).not.toHaveBeenCalledWith("library.downloadGoal.done", expect.anything());
});

it("applies category additions and removals without removing novels from the library", async () => {
  const selection = useLibrarySelection({}, "nameAsc");
  type Input = { add: number[]; novelIds: number[]; remove: number[] };
  const change = selection.assignCategoryMutation as unknown as {
    mutationFn: (input: Input) => Promise<void>;
    onSuccess: (result: void, input: Input) => void;
  };
  const input = { add: [3], novelIds: [1, 2], remove: [7] };
  await change.mutationFn(input);
  expect(mocks.addCategory).toHaveBeenCalledWith([1, 2], 3);
  expect(mocks.removeCategory).toHaveBeenCalledWith([1, 2], 7);
  change.onSuccess(undefined, input);
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["category"] });
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["novel", "library"] });
  expect(mocks.setSelected).toHaveBeenLastCalledWith(new Set());
  expect(mocks.setSelecting).toHaveBeenLastCalledWith(false);
  expect(vi.mocked(notifications.show)).toHaveBeenCalledWith(expect.objectContaining({ message: "library.categoryAction.done" }));
});

it("selects every matching work beyond the visible library page", async () => {
  const filter = { search: "series", sourceId: "source", categoryId: 4, unreadOnly: true };
  const ids = Array.from({ length: 250 }, (_, index) => index + 10);
  mocks.listIds.mockResolvedValue(ids);
  useLibrarySelection(filter, "nameAsc");
  await expect(mocks.mutations[4]!.mutationFn("")).resolves.toBe(250);
  expect(mocks.listIds).toHaveBeenCalledWith(filter);
  expect(mocks.setSelected).toHaveBeenLastCalledWith(new Set(ids));
});

it("does not restore a selection cleared while the full list was loading", async () => {
  let resolve!: (ids: number[]) => void;
  mocks.listIds.mockReturnValue(new Promise<number[]>(done => { resolve = done; }));
  const selection = useLibrarySelection({}, "nameAsc");
  const pending = mocks.mutations[4]!.mutationFn("");
  selection.clearSelection();
  resolve([1, 2, 3]);
  await pending;
  expect(mocks.setSelected).toHaveBeenCalledTimes(1);
  expect(mocks.setSelected).toHaveBeenCalledWith(new Set());
});

it("clears a stale selection when the filtered result is empty", async () => {
  useLibrarySelection({ search: "missing" }, "nameAsc");
  await mocks.mutations[4]!.mutationFn("");
  expect(mocks.setSelected).toHaveBeenLastCalledWith(new Set());
});

it("exits selection mode on back only while selection mode is on", () => {
  const selection = useLibrarySelection({}, "nameAsc");
  expect(useOverlayBackNavigation).toHaveBeenLastCalledWith(true, selection.exitSelection);
  vi.mocked(useOverlayBackNavigation).mock.lastCall![1]();
  expect(mocks.setSelected).toHaveBeenLastCalledWith(new Set());
  expect(mocks.setSelecting).toHaveBeenLastCalledWith(false);

  mocks.selected = new Set();
  useLibrarySelection({}, "nameAsc");
  expect(useOverlayBackNavigation).toHaveBeenLastCalledWith(false, expect.any(Function));
  mocks.selecting = true;
  expect(useLibrarySelection({}, "nameAsc").selectionMode).toBe(true);
  expect(useOverlayBackNavigation).toHaveBeenLastCalledWith(true, expect.any(Function));
  mocks.selecting = false;
  mocks.selected = new Set([1]);
  useLibrarySelection({}, "nameAsc", false);
  expect(useOverlayBackNavigation).toHaveBeenLastCalledWith(false, expect.any(Function));
});

it("sizes the remove-from-library download option with the exact stored chapter count", async () => {
  useLibrarySelection({}, "nameAsc");
  const remove = mocks.mutations[3] as unknown as {
    mutationFn: (input: { downloadedCount?: number; novelIds: number[] }) => Promise<boolean>;
  };
  await remove.mutationFn({ downloadedCount: 0, novelIds: [1, 2] });
  expect(confirmContentDeletion).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "library", ids: [1, 2], downloadedCount: 0 }));
  await remove.mutationFn({ downloadedCount: 12, novelIds: [3] });
  expect(confirmContentDeletion).toHaveBeenLastCalledWith(expect.objectContaining({ ids: [3], downloadedCount: 12 }));
});

interface DownloadOnceOutcome { queued: number; skippedLocal: number }
interface DownloadOnceMutation {
  mutationFn: (input: { novelIds: number[] }) => Promise<DownloadOnceOutcome>;
  onSuccess: (outcome: DownloadOnceOutcome) => void;
}
const chapterRow = (id: number, position: number) =>
  ({ id, position, path: `/c/${id}`, name: `Chapter ${id}`, chapterNumber: null, contentType: "html" });

it("queues every unqueued chapter of each selected source novel once at user priority", async () => {
  const fullPage = Array.from({ length: 500 }, (_, index) => chapterRow(index + 100, 600 - index));
  mocks.getNovel.mockImplementation(async (id: number) =>
    id === 9 ? null : { id, name: `Novel ${id}`, pluginId: "source", path: `/work/${id}`, isLocal: id === 3 });
  mocks.listUnqueued.mockImplementation(async (novelId: number, after: number) => {
    if (novelId === 1) return after === 0 ? fullPage : [chapterRow(700, 1)];
    return novelId === 2 ? [chapterRow(800, 2), chapterRow(801, 1)] : [];
  });
  mocks.queued = new Set([801]);
  useLibrarySelection({}, "nameAsc");
  const mutation = mocks.mutations[5] as unknown as DownloadOnceMutation;

  await expect(mutation.mutationFn({ novelIds: [1, 2, 3, 9] })).resolves.toEqual({ queued: 502, skippedLocal: 1 });
  expect(mocks.listUnqueued.mock.calls).toEqual([[1, 0], [1, 599], [2, 0]]);
  expect(mocks.submit).toHaveBeenCalledTimes(2);
  const calls = mocks.submit.mock.calls as unknown as [{ novelIds: number[]; prepare: () => Promise<{ jobs: Array<{ id: number; priority: string }>; materializeAllTasks?: boolean }> }][];
  const first = await calls[0]![0].prepare();
  expect(calls[0]![0].novelIds).toEqual([1]);
  expect(first.materializeAllTasks).toBe(true);
  expect(first.jobs).toHaveLength(501);
  expect(first.jobs[0]).toMatchObject({ id: 700, priority: "user", novelId: 1 });
  expect(first.jobs.every((job) => job.priority === "user")).toBe(true);
  expect((await calls[1]![0].prepare()).jobs.map((job) => job.id)).toEqual([800]);
});

it("reports the queued chapters, the local works skipped, and when nothing was left to queue", () => {
  useLibrarySelection({}, "nameAsc");
  const mutation = mocks.mutations[5] as unknown as DownloadOnceMutation;
  mutation.onSuccess({ queued: 12, skippedLocal: 0 });
  expect(vi.mocked(notifications.show)).toHaveBeenLastCalledWith({ color: "ok", message: "library.downloadOnce.done" });
  expect(mocks.t).toHaveBeenCalledWith("library.downloadOnce.done", { count: 12 });
  expect(mocks.setSelecting).toHaveBeenLastCalledWith(false);
  mutation.onSuccess({ queued: 4, skippedLocal: 2 });
  expect(mocks.t).toHaveBeenCalledWith("library.downloadOnce.doneSkippedLocal", { count: 4, skipped: 2 });
  mutation.onSuccess({ queued: 0, skippedLocal: 1 });
  expect(vi.mocked(notifications.show)).toHaveBeenLastCalledWith({ color: "warn", message: "library.downloadOnce.nothingSkippedLocal" });
  mutation.onSuccess({ queued: 0, skippedLocal: 0 });
  expect(vi.mocked(notifications.show)).toHaveBeenLastCalledWith({ color: "warn", message: "library.downloadOnce.nothing" });
});
