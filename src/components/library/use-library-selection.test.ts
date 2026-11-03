import { beforeEach, expect, it, vi } from "vitest";
import type { LibraryDownloadChapter } from "../../db/queries/chapter";

interface Mutation {
  mutationFn: (input: string) => Promise<number>;
  onSettled?: () => void;
}
const mocks = vi.hoisted(() => ({
  mutations: [] as Mutation[],
  selected: new Set([1]),
  setSelected: vi.fn(),
  selecting: false,
  setSelecting: vi.fn(),
  listIds: vi.fn(),
  listChapters: vi.fn(),
  getNovel: vi.fn(),
  queued: new Set<number>(),
  enqueue: vi.fn(),
  invalidate: vi.fn(async () => undefined),
  addCategory: vi.fn(async () => undefined),
  removeCategory: vi.fn(async () => undefined),
  availability: vi.fn(() => ({ data: true, isPending: false })),
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
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../db/queries/category", () => ({ addNovelsToCategory: mocks.addCategory, removeNovelsFromCategory: mocks.removeCategory }));
vi.mock("../../db/queries/chapter", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../db/queries/chapter")>(),
  listLibraryDownloadChapters: mocks.listChapters, listUnqueuedChapterDownloadIds: vi.fn(),
}));
vi.mock("../../db/queries/novel", () => ({ getNovelById: mocks.getNovel, listLibraryNovelIds: mocks.listIds, setNovelInLibrary: vi.fn() }));
vi.mock("../../lib/tasks/chapter-download", () => ({
  enqueueChapterDownloadBatch: mocks.enqueue,
  cancelChapterDownloadBatches: vi.fn(),
  isChapterDownloadQueued: (id: number) => mocks.queued.has(id),
}));
vi.mock("../../store/content-deletion", () => ({ confirmContentDeletion: vi.fn() }));
vi.mock("../../store/reader", () => ({ useReaderStore: { getState: () => ({ lastReadChapterByNovel: {} }) } }));
vi.mock("./use-library-download-availability", () => ({ useLibraryDownloadAvailability: mocks.availability }));
import { useLibrarySelection } from "./use-library-selection";
import { notifications } from "@mantine/notifications";
import { useOverlayBackNavigation } from "../../lib/android-back-navigation";
import { cancelChapterDownloadRequest, getChapterDownloadRequestSnapshot } from "../../lib/tasks/chapter-download-requests";

function chapter(id: number, overrides: Partial<LibraryDownloadChapter> = {}): LibraryDownloadChapter {
  return { id, position: id, path: `/chapter/${id}`, name: `Chapter ${id}`, isDownloaded: false, isDownloadQueued: false, ...overrides } as LibraryDownloadChapter;
}

beforeEach(() => {
  for (const request of getChapterDownloadRequestSnapshot()) cancelChapterDownloadRequest(request.id);
  vi.clearAllMocks();
  mocks.mutations.length = 0;
  mocks.selected = new Set([1]);
  mocks.selecting = false;
  mocks.listIds.mockReset().mockResolvedValue([]);
  mocks.queued.clear();
  mocks.listChapters.mockReset().mockImplementation(async (id: number) => [chapter(id)]);
  mocks.getNovel.mockReset().mockImplementation(async (id: number) => ({ id, name: `Novel ${id}`, pluginId: "source", path: `/work/${id}`, isLocal: false }));
});

it("shows a pending library request before chapter selection finishes", async () => {
  let release!: (chapters: LibraryDownloadChapter[]) => void;
  mocks.listChapters.mockReturnValue(new Promise<LibraryDownloadChapter[]>(resolve => { release = resolve; }));
  mocks.enqueue.mockReturnValue({ id: "held-library", materialized: Promise.resolve(), promise: Promise.resolve({ total: 1, succeeded: 1, failed: 0, cancelled: 0 }) });
  useLibrarySelection({}, "nameAsc");
  const pending = mocks.mutations[1]!.mutationFn("all");
  try {
    expect(getChapterDownloadRequestSnapshot()).toMatchObject([{ novelIds: [1], phase: "preparing", total: null }]);
    await vi.waitFor(() => expect(mocks.listChapters).toHaveBeenCalled());
    expect(mocks.enqueue).not.toHaveBeenCalled();
  } finally {
    await vi.waitFor(() => expect(mocks.listChapters).toHaveBeenCalled());
    release([chapter(1)]);
    await pending;
  }
  await vi.waitFor(() => expect(getChapterDownloadRequestSnapshot()).toEqual([]));
});

it("finishes preparation when jobs are queued and accepts another selection while downloads continue", async () => {
  let finish!: () => void;
  const running = new Promise<void>((resolve) => { finish = resolve; });
  mocks.enqueue.mockReturnValue({ id: "batch", promise: running });
  const first = useLibrarySelection({}, "nameAsc");
  expect(first.batchDownloadAvailability).toEqual({ data: true, isPending: false });
  const firstMutation = mocks.mutations[1]!;
  await expect(firstMutation.mutationFn("all")).resolves.toBe(1);
  firstMutation.onSettled!();
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["novel", "library", "batch-download"] });

  mocks.selected = new Set([2]);
  useLibrarySelection({}, "nameAsc");
  await expect(mocks.mutations[6]!.mutationFn("all")).resolves.toBe(1);
  expect(mocks.enqueue).toHaveBeenCalledTimes(2);
  expect(mocks.enqueue.mock.calls[1]![0].jobs[0].novelId).toBe(2);

  finish();
  await vi.waitFor(() => expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["novel", "library"] }));
});

it("rechecks live tasks after preparing multiple works and skips persisted jobs", async () => {
  mocks.selected = new Set([1, 2, 3]);
  mocks.getNovel.mockImplementation(async (id: number) => ({ id, name: "Work", pluginId: "source", path: "/work", isLocal: id === 3 }));
  mocks.listChapters.mockImplementation(async (id: number) => {
    if (id === 2) mocks.queued.add(1);
    return [chapter(id), chapter(id + 10, { isDownloadQueued: true })];
  });
  mocks.enqueue.mockReturnValue({ id: "batch", promise: Promise.resolve() });
  useLibrarySelection({}, "nameAsc");
  await expect(mocks.mutations[1]!.mutationFn("all")).resolves.toBe(1);
  expect(mocks.enqueue.mock.calls[0]![0].jobs.map((job: { id: number }) => job.id)).toEqual([2]);
  expect(mocks.listChapters).not.toHaveBeenCalledWith(3);
});

it("skips empty batches and handles a later background batch failure", async () => {
  mocks.listChapters.mockResolvedValueOnce([chapter(1, { isDownloaded: true })]);
  useLibrarySelection({}, "nameAsc");
  await expect(mocks.mutations[1]!.mutationFn("all")).resolves.toBe(0);
  expect(mocks.enqueue).not.toHaveBeenCalled();

  mocks.enqueue.mockReturnValue({ id: "batch", promise: Promise.reject(new Error("Source failed")) });
  await expect(mocks.mutations[1]!.mutationFn("all")).resolves.toBe(1);
  await vi.waitFor(() => expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["novel", "library"] }));
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

it("confirms a queued batch download with its chapter count", () => {
  useLibrarySelection({}, "nameAsc");
  const batch = mocks.mutations[1] as unknown as { onSuccess: (total: number) => void };
  batch.onSuccess(12);
  expect(vi.mocked(notifications.show)).toHaveBeenLastCalledWith(expect.objectContaining({ message: "library.batchDownload.queued" }));
  batch.onSuccess(0);
  expect(vi.mocked(notifications.show)).toHaveBeenLastCalledWith(expect.objectContaining({ message: "library.batchDownload.nothingQueued" }));
});
