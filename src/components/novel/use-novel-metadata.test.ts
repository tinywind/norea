import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutations: [] as { mutationFn: () => Promise<unknown>; onSuccess: (result: never) => Promise<void> | void }[],
  queryClient: { setQueryData: vi.fn(), invalidateQueries: vi.fn() },
  source: vi.fn(), refresh: vi.fn(), refreshSource: vi.fn(), cover: vi.fn(), plugin: vi.fn(), library: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => mocks.queryClient,
  useMutation: (options: (typeof mocks.mutations)[number]) => { mocks.mutations.push(options); return options; },
}));
vi.mock("react", () => ({ useState: (value: () => unknown) => [value(), vi.fn()], useEffect: vi.fn() }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../db/queries/novel", () => ({ setNovelInLibrary: mocks.library }));
vi.mock("../../lib/content-sync/novel-source", () => ({ readServerNovelSource: mocks.source }));
vi.mock("../../lib/content-sync/work-refresh", () => ({ syncServerNovelOnOpen: mocks.refresh, refreshServerNovelFromSource: mocks.refreshSource }));
vi.mock("../../lib/novel-cover-storage", () => ({ saveNovelCoverFromSource: mocks.cover }));
vi.mock("../../lib/plugins/manager", () => ({ pluginManager: { getPlugin: mocks.plugin } }));
vi.mock("../../lib/plugins/sync-novel", () => ({ getSourceDuplicateChapterInfo: () => [], syncNovelFromSource: vi.fn() }));
vi.mock("../../lib/tasks/source-tasks", () => ({ enqueueSourceTask: vi.fn() }));
vi.mock("../../lib/updates/update-index-events", () => ({ markUpdatesIndexDirty: vi.fn() }));

import { useNovelMetadata } from "./use-novel-metadata";

const novel = { id: 3, name: "Novel", path: "/novel", pluginId: "source-a", cover: "https://source/cover.jpg", isLocal: false, inLibrary: false };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.mutations.length = 0;
  mocks.source.mockResolvedValue({ serverUrl: "http://original", workId: "work-a" });
  mocks.refresh.mockReset().mockResolvedValue(true);
  mocks.refreshSource.mockReset().mockResolvedValue(false);
  mocks.cover.mockResolvedValue(undefined);
  mocks.plugin.mockReturnValue(undefined);
});

it("refreshes a bound work on its server without requiring an installed source plugin", async () => {
  useNovelMetadata(3, novel);
  await mocks.mutations[1]!.mutationFn();
  expect(mocks.refresh).toHaveBeenCalledWith(3, undefined, expect.any(Function));
  expect(mocks.refreshSource).toHaveBeenCalledWith(3, "tasks.task.refreshNovelMetadataFull", undefined, "user");
  expect(mocks.plugin).not.toHaveBeenCalled();
});

it("refreshes server-published local metadata through its server binding", async () => {
  useNovelMetadata(3, { ...novel, isLocal: true });
  await mocks.mutations[1]!.mutationFn();
  expect(mocks.refresh).toHaveBeenCalledWith(3, undefined, expect.any(Function));
  expect(mocks.plugin).not.toHaveBeenCalled();
});

it("adds a server work to the library without requesting a cover from the original site", async () => {
  mocks.plugin.mockReturnValue({ id: "source-a" });
  useNovelMetadata(3, novel);
  const mutation = mocks.mutations[0]!;
  const result = await mutation.mutationFn();
  await mutation.onSuccess(result as never);
  expect(mocks.library).toHaveBeenCalledWith(3, true);
  expect(mocks.cover).not.toHaveBeenCalled();
});

it("keeps source cover storage for unbound source-site novels", async () => {
  mocks.source.mockResolvedValue(null);
  mocks.plugin.mockReturnValue({ id: "source-a" });
  mocks.cover.mockResolvedValue(undefined);
  useNovelMetadata(3, novel);
  const mutation = mocks.mutations[0]!;
  const result = await mutation.mutationFn();
  await mutation.onSuccess(result as never);
  expect(mocks.cover).toHaveBeenCalledOnce();
});

it("attempts source metadata even when the server refresh fails", async () => {
  mocks.refresh.mockRejectedValueOnce(new Error("Server offline"));
  useNovelMetadata(3, novel);
  await expect(mocks.mutations[2]!.mutationFn()).rejects.toThrow("Server offline");
  expect(mocks.refreshSource).toHaveBeenCalledWith(3, "tasks.task.refreshNovelMetadataFull", undefined, "user");
  expect(mocks.plugin).not.toHaveBeenCalled();
});

it("finishes a source refresh before a delayed optional server refresh", async () => {
  let complete!: (value: boolean) => void;
  mocks.refresh.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  mocks.refreshSource.mockResolvedValue(true);
  useNovelMetadata(3, novel);
  const finished = vi.fn();
  const pending = mocks.mutations[1]!.mutationFn().then(finished);
  await vi.waitFor(() => expect(finished).toHaveBeenCalledWith({ duplicateChapters: [] }));
  expect(mocks.refreshSource).toHaveBeenCalledOnce();
  expect((mocks.refresh.mock.calls[0]![2] as () => boolean)()).toBe(false);
  complete(true);
  await pending;
  await vi.waitFor(() => expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["novel", "detail", 3] }));
});

it("reports a source failure before a delayed optional server refresh", async () => {
  let complete!: (value: boolean) => void;
  const failure = new Error("Source unavailable");
  mocks.refresh.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  mocks.refreshSource.mockRejectedValue(failure);
  useNovelMetadata(3, novel);
  const rejected = vi.fn();
  const pending = mocks.mutations[1]!.mutationFn().catch(rejected);
  await vi.waitFor(() => expect(rejected).toHaveBeenCalledWith(failure));
  complete(false);
  await pending;
});

it("keeps a successful source refresh successful when the optional server fails", async () => {
  mocks.refresh.mockRejectedValue(new Error("Server offline"));
  mocks.refreshSource.mockResolvedValue(true);
  useNovelMetadata(3, novel);
  await expect(mocks.mutations[1]!.mutationFn()).resolves.toEqual({ duplicateChapters: [] });
});
