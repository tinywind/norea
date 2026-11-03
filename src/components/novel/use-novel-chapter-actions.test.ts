import { beforeEach, expect, it, vi } from "vitest";

interface ChapterActionMutation {
  mutationFn: (input: number | readonly number[]) => Promise<unknown>;
  onSettled?: () => void;
  onError?: (error: Error) => void;
}

const mocks = vi.hoisted(() => ({
  mutations: [] as ChapterActionMutation[],
  deleteCache: vi.fn(),
  prepareDeletion: vi.fn(),
  runDeletion: vi.fn(),
  invalidateQueries: vi.fn(),
  showNotification: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
  useMutation: (options: ChapterActionMutation) => {
    mocks.mutations.push(options);
    return options;
  },
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.showNotification },
}));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../db/queries/chapter", () => ({
  setChaptersReadState: vi.fn(), setRelativeChaptersReadState: vi.fn(),
}));
vi.mock("../../lib/reader-query-invalidation", () => ({ invalidateChapterReadStateQueries: vi.fn() }));
vi.mock("../../lib/tasks/chapter-download", () => ({
  enqueueChapterDownload: vi.fn(), enqueueChapterDownloadBatch: vi.fn(), enqueueChapterMediaRepair: vi.fn(),
  cancelChapterDownloadBatches: vi.fn(),
}));
vi.mock("../../store/content-deletion", () => ({
  confirmContentDeletion: mocks.deleteCache,
}));
vi.mock("../../lib/content-deletion", () => ({
  prepareContentDeletion: mocks.prepareDeletion,
  runContentDeletion: mocks.runDeletion,
}));
vi.mock("../../store/content-sync", () => ({
  useContentSyncStore: { getState: () => ({ serverUrl: "http://server" }) },
}));
vi.mock("../../lib/updates/update-index-events", () => ({ markUpdatesIndexDirty: vi.fn() }));

import { useNovelChapterActions } from "./use-novel-chapter-actions";
import { enqueueChapterDownload, enqueueChapterDownloadBatch } from "../../lib/tasks/chapter-download";
import { cancelChapterDownloadRequest, getChapterDownloadRequestSnapshot } from "../../lib/tasks/chapter-download-requests";
import type { ChapterListRow } from "../../db/queries/chapter";

beforeEach(() => {
  for (const request of getChapterDownloadRequestSnapshot()) cancelChapterDownloadRequest(request.id);
  vi.clearAllMocks();
  mocks.mutations.length = 0;
});

it.each([false, true])("admits the chapter request before its queue is materialized (batch: %s)", async batch => {
  let release!: () => void;
  const materialized = new Promise<void>(resolve => { release = resolve; });
  const handle = { id: "held-novel", materialized, promise: materialized.then(() => ({ total: 1, succeeded: 1, failed: 0, cancelled: 0 })) };
  vi.mocked(enqueueChapterDownload).mockReturnValue(handle as never);
  vi.mocked(enqueueChapterDownloadBatch).mockReturnValue(handle);
  const chapter = { id: 7, name: "Opening", path: "/chapter/1", chapterNumber: "1", contentType: "html" } as ChapterListRow;
  const actions = useNovelChapterActions(3, { id: 3, pluginId: "source", name: "Book", path: "/book", isLocal: false }, [chapter]);
  if (batch) actions.downloadChapters([chapter]);
  else actions.downloadChapter(chapter);
  try {
    expect(getChapterDownloadRequestSnapshot()).toMatchObject([{ novelIds: [3], total: 1, phase: "preparing" }]);
  } finally { release(); }
  await vi.waitFor(() => expect(getChapterDownloadRequestSnapshot()).toEqual([]));
  expect(vi.mocked(enqueueChapterDownloadBatch).mock.calls[0]?.[0].jobs).toEqual([expect.objectContaining({ id: 7, novelId: 3 })]);
});

it("keeps the batch deletion pending until the files and records are deleted", async () => {
  let complete!: (result: unknown) => void;
  mocks.deleteCache.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  useNovelChapterActions(3, null, [{ id: 7, name: "Opening" }]);
  const mutation = mocks.mutations[1]!;
  const settled = vi.fn();
  const pending = mutation.mutationFn([7, 8, 7, -1]).then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  expect(mocks.deleteCache).toHaveBeenCalledWith(expect.objectContaining({ kind: "downloads", scope: "chapter", ids: [7, 8] }));
  complete(true);
  await pending;
  expect(settled).toHaveBeenCalledWith(true);
  mutation.onSettled?.();
  expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["novel", "detail", 3, "chapters"] });
  expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["download-cache"] });
});

it("deletes one confirmed chapter's files on this device only, without the deletion dialog", async () => {
  let complete!: (results: unknown) => void;
  const actions = [{ id: "device:7" }];
  mocks.prepareDeletion.mockResolvedValue(actions);
  mocks.runDeletion.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  useNovelChapterActions(3, null, [{ id: 7, name: "Opening" }]);
  const mutation = mocks.mutations[0]!;
  const settled = vi.fn();
  const pending = mutation.mutationFn(7).then(settled);
  await vi.waitFor(() => expect(mocks.runDeletion).toHaveBeenCalledWith(actions));
  expect(mocks.prepareDeletion).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "downloads", scope: "chapter", ids: [7], serverUrl: "http://server" }),
    { local: false, server: false },
  );
  expect(settled).not.toHaveBeenCalled();
  complete([{ id: "device:7", status: "succeeded" }]);
  await pending;
  expect(settled).toHaveBeenCalled();
  expect(mocks.deleteCache).not.toHaveBeenCalled();
});

it("reports a failed deletion and refreshes the affected chapter state", async () => {
  mocks.prepareDeletion.mockResolvedValue([{ id: "device:7" }]);
  mocks.runDeletion.mockResolvedValue([{ id: "device:7", status: "failed", error: "Storage permission was revoked" }]);
  useNovelChapterActions(3, null, [{ id: 7, name: "Opening" }]);
  const mutation = mocks.mutations[0]!;
  const failure = await mutation.mutationFn(7).catch((error: Error) => error);
  expect(failure).toBeInstanceOf(Error);
  mutation.onError?.(failure as Error);
  mutation.onSettled?.();
  expect(mocks.showNotification).toHaveBeenCalledWith(expect.objectContaining({
    color: "danger", message: "Storage permission was revoked",
  }));
  expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["download-cache"] });
});

it.each([false, true])("reloads only the chapter list after local discovery (batch: %s)", async (batch) => {
  let complete!: () => void;
  const promise = new Promise<void>((resolve) => { complete = resolve; });
  const handle = { id: "download", promise };
  vi.mocked(enqueueChapterDownload).mockReturnValue(handle);
  vi.mocked(enqueueChapterDownloadBatch).mockReturnValue(handle as never);
  const chapter = { id: 7, name: "Opening", path: "/chapter/1", chapterNumber: "1", contentType: "html" } as ChapterListRow;
  const actions = useNovelChapterActions(3, { id: 3, pluginId: "source", name: "Book", path: "/book", isLocal: false }, [chapter]);
  if (batch) actions.downloadChapters([chapter]);
  else actions.downloadChapter(chapter);
  expect(mocks.invalidateQueries).not.toHaveBeenCalled();

  complete();

  await vi.waitFor(() => expect(mocks.invalidateQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: ["novel", "detail", 3, "chapters"], exact: true }));
});
