import { beforeEach, expect, it, vi } from "vitest";
import type { ServerWorkSummary } from "../../lib/content-sync/browse";
import type { MainTaskSpec, TaskRunContext } from "../../lib/tasks/scheduler";

const mocks = vi.hoisted(() => ({
  addNovelsToCategory: vi.fn(),
  addToLibrary: vi.fn(),
  enqueueMain: vi.fn(),
  findNovelBySource: vi.fn(),
  listAllServerWorks: vi.fn(),
  openServerNovel: vi.fn(),
  resolveServerNovelTarget: vi.fn(),
}));
vi.mock("../../db/queries/category", () => ({ addNovelsToCategory: mocks.addNovelsToCategory }));
vi.mock("../../db/queries/novel", () => ({ findNovelBySource: mocks.findNovelBySource }));
vi.mock("../../lib/content-sync/browse", () => ({
  listAllServerWorks: mocks.listAllServerWorks, openServerNovel: mocks.openServerNovel, resolveServerNovelTarget: mocks.resolveServerNovelTarget,
}));
vi.mock("../../lib/content-sync/device", () => ({ registerContentDevice: vi.fn(async () => "device") }));
vi.mock("../../lib/tasks/scheduler", () => ({ taskScheduler: { enqueueMain: mocks.enqueueMain } }));
vi.mock("../../store/content-sync", () => ({ useContentSyncStore: { getState: () => ({ deviceName: "Phone" }) } }));
vi.mock("./use-quick-add", () => ({ addQuickAddTargetToLibrary: mocks.addToLibrary }));

import {
  addServerWorksToLibrary,
  enqueueServerLibraryAdd,
  SERVER_LIBRARY_ADD_CONCURRENCY,
  ServerLibraryAddError,
  type ServerLibraryAddResult,
} from "./server-library-add";

const work = (id: string) => ({ id, novel: { name: `Book ${id}` }, identity: { pluginId: "source", novelPath: `/${id}` } }) as ServerWorkSummary;
const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}(${Object.entries(values).map(([name, value]) => `${name}=${value}`).join(",")})` : key;
const run = (works: ServerWorkSummary[], signal = new AbortController().signal, categoryIds: number[] = []) =>
  addServerWorksToLibrary({ categoryIds, onProgress: vi.fn(), server: "http://server", signal, taskTitle: "Add", works });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  mocks.findNovelBySource.mockResolvedValue(null);
  mocks.resolveServerNovelTarget.mockImplementation(async (_server: string, selected: ServerWorkSummary) => ({
    novel: await mocks.findNovelBySource(selected.identity.pluginId, selected.identity.novelPath), migrated: false,
  }));
  mocks.openServerNovel.mockResolvedValue(900);
  let nextId = 100;
  mocks.addToLibrary.mockImplementation(async () => nextId++);
});

it("adds through the quick-add server install path, skipping duplicates and works already in the library", async () => {
  mocks.findNovelBySource.mockImplementation(async (_plugin: string, path: string) =>
    path === "/b" ? { id: 5, inLibrary: true } : path === "/c" ? { id: 6, inLibrary: false } : null);
  const result = await run([work("a"), work("b"), work("a"), work("c")], undefined, [7]);
  expect(result).toEqual({ added: 2, failed: [], pending: [], skipped: 1 });
  expect(mocks.addToLibrary.mock.calls.map(call => call[0])).toEqual([
    { kind: "server", server: "http://server", work: work("a") },
    { kind: "server", server: "http://server", work: work("c") },
  ]);
  expect(mocks.addNovelsToCategory.mock.calls).toEqual([[[100], 7], [[101], 7]]);
});

it("keeps at most three installs in flight and reports progress for every work", async () => {
  let inFlight = 0;
  let peak = 0;
  mocks.addToLibrary.mockImplementation(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise(resolve => setTimeout(resolve, 1));
    inFlight -= 1;
    return 1;
  });
  const onProgress = vi.fn();
  const works = Array.from({ length: 10 }, (_, index) => work(String(index)));
  const result = await addServerWorksToLibrary({ categoryIds: [], onProgress, server: "http://server", signal: new AbortController().signal, taskTitle: "Add", works });
  expect(result.added).toBe(10);
  expect(peak).toBe(SERVER_LIBRARY_ADD_CONCURRENCY);
  expect(onProgress).toHaveBeenNthCalledWith(1, 0, 10);
  expect(onProgress).toHaveBeenLastCalledWith(10, 10);
});

it("lists failures without stopping the other works", async () => {
  mocks.addToLibrary.mockImplementation(async ({ work: target }: { work: ServerWorkSummary }) => {
    if (target.id === "b") throw new Error("offline");
    return 1;
  });
  const result = await run([work("a"), work("b"), work("c")]);
  expect(result.added).toBe(2);
  expect(result.failed).toEqual([{ error: "offline", work: work("b") }]);
});

it("stops starting installs once cancelled and reports the unreached works", async () => {
  const controller = new AbortController();
  mocks.addToLibrary.mockImplementation(async () => { controller.abort(); return 1; });
  const result = await run([work("a"), work("b"), work("c"), work("d"), work("e")], controller.signal);
  expect(result.added).toBe(SERVER_LIBRARY_ADD_CONCURRENCY);
  expect(result.pending.map(item => item.id)).toEqual(["d", "e"]);
});

function enqueuedSpec(): MainTaskSpec<ServerLibraryAddResult> {
  return mocks.enqueueMain.mock.calls.at(-1)![0] as MainTaskSpec<ServerLibraryAddResult>;
}
function context(signal = new AbortController().signal) {
  return { setDetail: vi.fn(), setProgress: vi.fn(), signal, taskId: "task" } as unknown as TaskRunContext & {
    setDetail: ReturnType<typeof vi.fn>; setProgress: ReturnType<typeof vi.fn>;
  };
}

it("runs one main-lane task with progress and retries only the failed works", async () => {
  mocks.enqueueMain.mockReturnValue({ id: "task", promise: Promise.resolve() });
  mocks.addToLibrary.mockImplementation(async ({ work: target }: { work: ServerWorkSummary }) => {
    if (target.id === "b") throw new Error("offline");
    return 1;
  });
  const retry = vi.fn();
  enqueueServerLibraryAdd({ categoryIds: [], count: 3, server: "http://server", works: [work("a"), work("b"), work("c")] }, t, retry);
  const spec = enqueuedSpec();
  expect(spec).toMatchObject({ kind: "library.addServerWorks", priority: "user", title: "serverLibraryAdd.taskTitle(count=3)" });
  const taskContext = context();
  const failure = await spec.run(taskContext).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ServerLibraryAddError);
  expect((failure as ServerLibraryAddError).message).toBe(
    "serverLibraryAdd.added(count=2) · serverLibraryAdd.failedCount(count=1): Book b",
  );
  expect(taskContext.setProgress).toHaveBeenLastCalledWith({ current: 3, total: 3 });
  expect(taskContext.setDetail).toHaveBeenLastCalledWith("serverLibraryAdd.progress(current=3,total=3)");
  spec.retryManually!();
  expect(retry).toHaveBeenCalledWith([work("b")]);
});

it("gathers every work of a listing when the task starts", async () => {
  mocks.enqueueMain.mockReturnValue({ id: "task", promise: Promise.resolve() });
  mocks.listAllServerWorks.mockImplementation(async (_server, _token, _query, _source, onPage: (loaded: number, total: number) => void) => {
    onPage(2, 2);
    return [work("a"), work("b")];
  });
  const retry = vi.fn();
  enqueueServerLibraryAdd({ categoryIds: [], count: 2, server: "http://server", works: { query: "Book", source: "source" } }, t, retry);
  const taskContext = context();
  await expect(enqueuedSpec().run(taskContext)).resolves.toEqual({ added: 2, failed: [], pending: [], skipped: 0 });
  expect(mocks.listAllServerWorks).toHaveBeenCalledWith("http://server", "device", "Book", "source", expect.any(Function), taskContext.signal);
  expect(taskContext.setDetail).toHaveBeenCalledWith("serverLibraryAdd.gathering(loaded=2,total=2)");
});

it("resumes a cancelled run with the works it did not reach", async () => {
  mocks.enqueueMain.mockReturnValue({ id: "task", promise: Promise.resolve() });
  const controller = new AbortController();
  mocks.addToLibrary.mockImplementation(async () => { controller.abort(); return 1; });
  const retry = vi.fn();
  const works = ["a", "b", "c", "d"].map(work);
  enqueueServerLibraryAdd({ categoryIds: [], count: 4, server: "http://server", works }, t, retry);
  const spec = enqueuedSpec();
  await expect(spec.run(context(controller.signal))).rejects.toBeDefined();
  spec.retryManually!();
  expect(retry).toHaveBeenCalledWith([work("d")]);
});

it("counts a retired source whose exact migration target is already in the library as skipped after refreshing that target", async () => {
  const retired = work("retired-source");
  mocks.resolveServerNovelTarget.mockResolvedValue({ novel: { id: 900, inLibrary: true }, migrated: true });
  const result = await run([retired], undefined, [7]);
  expect(result).toEqual({ added: 0, failed: [], pending: [], skipped: 1 });
  expect(mocks.openServerNovel).toHaveBeenCalledWith("http://server", retired);
  expect(mocks.addToLibrary).not.toHaveBeenCalled();
  expect(mocks.addNovelsToCategory).not.toHaveBeenCalled();
});

it("adds an out-of-library migration target through the normal server quick-add path and categorizes the returned target ID", async () => {
  const retired = work("retired-source");
  mocks.resolveServerNovelTarget.mockResolvedValue({ novel: { id: 902, inLibrary: false }, migrated: true });
  mocks.addToLibrary.mockResolvedValue(902);
  const result = await run([retired], undefined, [7]);
  expect(result).toEqual({ added: 1, failed: [], pending: [], skipped: 0 });
  expect(mocks.addToLibrary).toHaveBeenCalledWith({ kind: "server", server: "http://server", work: retired }, "Add");
  expect(mocks.addNovelsToCategory).toHaveBeenCalledWith([902], 7);
});

it("reports an ambiguous migration without marking the source as added or mutating library categories", async () => {
  const retired = work("retired-source");
  mocks.resolveServerNovelTarget.mockRejectedValue(new Error("The saved work migration history has conflicting targets."));
  const result = await run([retired], undefined, [7]);
  expect(result).toMatchObject({ added: 0, skipped: 0, pending: [], failed: [{ work: retired }] });
  expect(mocks.openServerNovel).not.toHaveBeenCalled();
  expect(mocks.addToLibrary).not.toHaveBeenCalled();
  expect(mocks.addNovelsToCategory).not.toHaveBeenCalled();
});
