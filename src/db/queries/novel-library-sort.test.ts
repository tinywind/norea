import { beforeEach, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../lib/observability", () => ({
  startPerformanceObservation: () => () => undefined,
  recordPerformanceObservation: () => undefined,
}));

import {
  countLibraryStoredChapters,
  getLibraryNovelSummary,
  listLibraryNovelIds,
  listLibraryNovelPage,
  listLibraryNovelRefreshTargets,
  listLibraryNovels,
} from "./novel";

beforeEach(() => {
  invokeMock.mockReset();
});

it("forwards identical filter predicates to listLibraryNovelIds, listLibraryNovelPage, and listLibraryNovelRefreshTargets", async () => {
  const filter = {
    completedOnly: true,
    categoryId: 1,
    repairNeededOnly: true,
    search: "alpha",
    sourceId: "source",
  };
  invokeMock
    .mockResolvedValueOnce([1, 3])
    .mockResolvedValueOnce({
      hasMore: true,
      nextCursor: { id: 1, name: "Alpha", sortValue: "Alpha" },
      novels: [],
    })
    .mockResolvedValueOnce({
      completeNovels: 2,
      downloadedChapters: 4,
      downloadedNovels: 2,
      lastUpdatedAt: 100,
      localNovels: 0,
      repairNeededNovels: 2,
      totalChapters: 6,
      totalNovels: 2,
      unreadChapters: 0,
      unreadNovels: 0,
    })
    .mockResolvedValueOnce([]);

  await expect(listLibraryNovelIds(filter)).resolves.toEqual([1, 3]);
  const page = await listLibraryNovelPage({
    ...filter,
    limit: 1,
    sortOrder: "nameAsc",
  });
  expect(page.nextCursor).toEqual({ id: 1, name: "Alpha", sortValue: "Alpha" });
  await expect(getLibraryNovelSummary(filter)).resolves.toMatchObject({
    totalNovels: 2,
    repairNeededNovels: 2,
  });
  await expect(listLibraryNovelRefreshTargets(filter)).resolves.toEqual([]);

  expect(invokeMock).toHaveBeenNthCalledWith(1, "db_novel_list_library_ids", {
    filter,
    mode: "queued",
  });
  expect(invokeMock).toHaveBeenNthCalledWith(2, "db_novel_list_library_page", {
    filter: { ...filter, limit: 1, sortOrder: "nameAsc" },
    mode: "queued",
  });
  expect(invokeMock).toHaveBeenNthCalledWith(3, "db_novel_get_library_summary", {
    filter,
    mode: "queued",
  });
  expect(invokeMock).toHaveBeenNthCalledWith(
    4,
    "db_novel_list_library_refresh_targets",
    {
      filter,
      mode: "queued",
    },
  );
});

it.each(["undownloadedAsc", "undownloadedDesc"] as const)(
  "forwards %s sort order and cursor pagination to Rust",
  async (sortOrder) => {
    invokeMock
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce({
        hasMore: false,
        nextCursor: null,
        novels: [{ id: 2 }],
      });

    await listLibraryNovels({ sortOrder });
    await listLibraryNovelPage({
      cursor: { id: 1, name: "Alpha", sortValue: 3 },
      limit: 1,
      sortOrder,
    });

    expect(invokeMock).toHaveBeenNthCalledWith(1, "db_novel_list_library", {
      filter: { sortOrder },
      mode: "queued",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "db_novel_list_library_page", {
      filter: {
        cursor: { id: 1, name: "Alpha", sortValue: 3 },
        limit: 1,
        sortOrder,
      },
      mode: "queued",
    });
  },
);

it("deduplicates novel IDs and handles multi-chunk batches in countLibraryStoredChapters", async () => {
  await expect(countLibraryStoredChapters([])).resolves.toBe(0);
  expect(invokeMock).not.toHaveBeenCalled();

  const largeIds = [2, 2, ...Array.from({ length: 620 }, (_, index) => index + 1)];
  invokeMock.mockResolvedValueOnce(622);

  await expect(countLibraryStoredChapters(largeIds)).resolves.toBe(622);
  expect(invokeMock).toHaveBeenCalledWith(
    "db_novel_count_library_stored_chapters",
    {
      novelIds: [2, 1, ...Array.from({ length: 618 }, (_, index) => index + 3)],
      mode: "queued",
    },
  );
});
