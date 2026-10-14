import { beforeEach, expect, it, vi } from "vitest";

interface ChapterActionMutation {
  mutationFn: (input: number | readonly number[]) => Promise<unknown>;
  onSettled?: () => void;
  onError?: (error: Error) => void;
}

const mocks = vi.hoisted(() => ({
  mutations: [] as ChapterActionMutation[],
  deleteCache: vi.fn(),
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
}));
vi.mock("../../lib/tasks/download-cache-delete", () => ({
  deleteDownloadCache: mocks.deleteCache,
}));
vi.mock("../../lib/updates/update-index-events", () => ({ markUpdatesIndexDirty: vi.fn() }));

import { useNovelChapterActions } from "./use-novel-chapter-actions";
import { enqueueChapterDownload, enqueueChapterDownloadBatch } from "../../lib/tasks/chapter-download";
import type { ChapterListRow } from "../../db/queries/chapter";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mutations.length = 0;
});

it.each([
  { action: 0, input: 7, expectedIds: [7] },
  { action: 1, input: [7, 8, 7, -1], expectedIds: [7, 8] },
])("keeps deletion action $action pending until the files and records are deleted", async ({ action, input, expectedIds }) => {
  let complete!: (result: unknown) => void;
  mocks.deleteCache.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  useNovelChapterActions(3, null, [{ id: 7, name: "Opening" }]);
  const mutation = mocks.mutations[action]!;
  const settled = vi.fn();
  const pending = mutation.mutationFn(input).then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  expect(mocks.deleteCache).toHaveBeenCalledWith(expect.objectContaining({ scope: "chapter", targetIds: expectedIds }));
  const result = { workId: "delete-7", total: expectedIds.length, deleted: expectedIds.length, failed: 0, cancelled: false };
  complete(result);
  await pending;
  expect(settled).toHaveBeenCalledWith(result);
  mutation.onSettled?.();
  expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["novel", "detail", 3, "chapters"] });
  expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["download-cache"] });
});

it("reports a failed deletion and refreshes the affected chapter state", async () => {
  const failure = new Error("Storage permission was revoked");
  mocks.deleteCache.mockRejectedValue(failure);
  useNovelChapterActions(3, null, [{ id: 7, name: "Opening" }]);
  const mutation = mocks.mutations[0]!;
  await expect(mutation.mutationFn(7)).rejects.toBe(failure);
  mutation.onError?.(failure);
  mutation.onSettled?.();
  expect(mocks.showNotification).toHaveBeenCalledWith(expect.objectContaining({
    color: "red", message: "Storage permission was revoked",
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
