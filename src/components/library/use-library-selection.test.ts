import { beforeEach, expect, it, vi } from "vitest";
import type { LibraryDownloadChapter } from "../../db/queries/chapter";

interface Mutation {
  mutationFn: (input: string) => Promise<number>;
  onSettled?: () => void;
}
const mocks = vi.hoisted(() => ({
  mutations: [] as Mutation[],
  selected: new Set([1]),
  listChapters: vi.fn(),
  getNovel: vi.fn(),
  queued: new Set<number>(),
  enqueue: vi.fn(),
  invalidate: vi.fn(async () => undefined),
  availability: vi.fn(() => ({ data: true, isPending: false })),
}));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: vi.fn(),
  useState: () => [mocks.selected, vi.fn()],
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
  useMutation: (mutation: Mutation) => {
    mocks.mutations.push(mutation);
    return mutation;
  },
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../db/queries/category", () => ({ addNovelsToCategory: vi.fn() }));
vi.mock("../../db/queries/chapter", () => ({ listLibraryDownloadChapters: mocks.listChapters, listUnqueuedChapterDownloadIds: vi.fn() }));
vi.mock("../../db/queries/novel", () => ({ getNovelById: mocks.getNovel, setNovelInLibrary: vi.fn() }));
vi.mock("../../lib/tasks/chapter-download", () => ({
  enqueueChapterDownloadBatch: mocks.enqueue,
  isChapterDownloadQueued: (id: number) => mocks.queued.has(id),
}));
vi.mock("../../store/content-deletion", () => ({ confirmContentDeletion: vi.fn() }));
vi.mock("../../store/reader", () => ({ useReaderStore: { getState: () => ({ lastReadChapterByNovel: {} }) } }));
vi.mock("./use-library-download-availability", () => ({ useLibraryDownloadAvailability: mocks.availability }));
import { useLibrarySelection } from "./use-library-selection";

function chapter(id: number, overrides: Partial<LibraryDownloadChapter> = {}): LibraryDownloadChapter {
  return { id, position: id, path: `/chapter/${id}`, name: `Chapter ${id}`, isDownloaded: false, isDownloadQueued: false, ...overrides } as LibraryDownloadChapter;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mutations.length = 0;
  mocks.selected = new Set([1]);
  mocks.queued.clear();
  mocks.listChapters.mockReset().mockImplementation(async (id: number) => [chapter(id)]);
  mocks.getNovel.mockReset().mockImplementation(async (id: number) => ({ id, name: `Novel ${id}`, pluginId: "source", path: `/work/${id}`, isLocal: false }));
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
  await expect(mocks.mutations[5]!.mutationFn("all")).resolves.toBe(1);
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
