import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutations: [] as { mutationFn: () => Promise<unknown>; onSuccess: (result: never) => Promise<void> | void }[],
  queryClient: { setQueryData: vi.fn(), invalidateQueries: vi.fn() },
  source: vi.fn(), refresh: vi.fn(), cover: vi.fn(), plugin: vi.fn(), library: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => mocks.queryClient,
  useMutation: (options: (typeof mocks.mutations)[number]) => { mocks.mutations.push(options); return options; },
}));
vi.mock("react", () => ({ useState: (value: () => unknown) => [value(), vi.fn()], useEffect: vi.fn() }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../db/queries/novel", () => ({ setNovelInLibrary: mocks.library }));
vi.mock("../../lib/content-sync/novel-source", () => ({ readServerNovelSource: mocks.source }));
vi.mock("../../lib/content-sync/browse", () => ({ refreshServerNovel: mocks.refresh }));
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
  mocks.refresh.mockResolvedValue(3);
  mocks.cover.mockResolvedValue(undefined);
  mocks.plugin.mockReturnValue(undefined);
});

it("refreshes a bound work on its server without requiring an installed source plugin", async () => {
  useNovelMetadata(3, novel);
  await mocks.mutations[1]!.mutationFn();
  expect(mocks.refresh).toHaveBeenCalledWith({ serverUrl: "http://original", workId: "work-a" });
  expect(mocks.plugin).not.toHaveBeenCalled();
});

it("refreshes server-published local metadata through its server binding", async () => {
  useNovelMetadata(3, { ...novel, isLocal: true });
  await mocks.mutations[1]!.mutationFn();
  expect(mocks.refresh).toHaveBeenCalledWith({ serverUrl: "http://original", workId: "work-a" });
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

it("reports a server refresh failure without falling back to the source plugin", async () => {
  mocks.refresh.mockRejectedValueOnce(new Error("Server offline"));
  useNovelMetadata(3, novel);
  await expect(mocks.mutations[2]!.mutationFn()).rejects.toThrow("Server offline");
  expect(mocks.plugin).not.toHaveBeenCalled();
});
