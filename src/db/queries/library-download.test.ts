import { beforeEach, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../lib/observability", () => ({
  startPerformanceObservation: () => () => undefined,
  recordPerformanceObservation: () => undefined,
}));

import {
  listExistingChapterIds,
  listLibraryDownloadChapters,
  listUnqueuedChapterDownloads,
} from "./chapter";

beforeEach(() => {
  invokeMock.mockReset();
});

it("deduplicates chapter IDs and skips empty lists in listExistingChapterIds", async () => {
  await expect(listExistingChapterIds([])).resolves.toEqual([]);
  expect(invokeMock).not.toHaveBeenCalled();

  invokeMock.mockResolvedValueOnce([1000, 1001]);
  await expect(listExistingChapterIds([1000, 1001, 1000])).resolves.toEqual([
    1000, 1001,
  ]);
  expect(invokeMock).toHaveBeenCalledWith("db_chapter_list_existing_ids", {
    chapterIds: [1000, 1001],
  });
});

it("forwards novelId and cursor to library download queries", async () => {
  invokeMock
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);

  await listLibraryDownloadChapters(1);
  expect(invokeMock).toHaveBeenNthCalledWith(
    1,
    "db_chapter_list_library_download",
    { novelId: 1 },
  );

  await listUnqueuedChapterDownloads(2);
  expect(invokeMock).toHaveBeenNthCalledWith(
    2,
    "db_chapter_list_unqueued_downloads",
    { novelId: 2, afterChapterId: 0 },
  );

  await listUnqueuedChapterDownloads(2, 1498);
  expect(invokeMock).toHaveBeenNthCalledWith(
    3,
    "db_chapter_list_unqueued_downloads",
    { novelId: 2, afterChapterId: 1498 },
  );
});
