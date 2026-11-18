import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../lib/observability", () => ({
  startPerformanceObservation: () => () => undefined,
  recordPerformanceObservation: () => undefined,
}));

import { MAX_ROUTE_QUERY_ROWS } from "../../lib/performance-budgets";
import { UNCATEGORIZED_CATEGORY_ID } from "./category";
import {
  countLibraryStoredChapters,
  countNovels,
  findNovelBySource,
  getLibraryNovelSummary,
  getNovelById,
  insertNovelIfAbsent,
  listLibraryNovelIdentities,
  listLibraryNovelIds,
  listLibraryNovelPage,
  listLibraryNovelRefreshTargets,
  listLibraryNovels,
  listLibrarySourceFilters,
  listLibraryStatusFilters,
  listLibraryTagFilters,
  renumberLocalNovelChapters,
  reorderLocalNovelChapters,
  setNovelInLibrary,
  updateLocalNovelMetadata,
  upsertLocalNovel,
} from "./novel";

const LOCAL_COVER = "data:image/png;base64,AQID";

beforeEach(() => {
  invokeMock.mockReset();
});

it.each([
  "/novel/123",
  "/webtoon/list?titleId=650305&q=%2f#info",
  'opaque:{"id":123}',
])("looks up the exact plugin identity %s", async (path) => {
  invokeMock.mockResolvedValueOnce(null);
  expect(await findNovelBySource("source", path)).toBeNull();
  expect(invokeMock).toHaveBeenCalledWith("db_novel_find_by_source", {
    pluginId: "source",
    path,
    mode: "queued",
  });
});

it.each([
  "/novel/123",
  "/webtoon/list?titleId=650305&q=%2f#info",
  'opaque:{"id":123}',
])("inserts the exact plugin identity %s", async (path) => {
  invokeMock.mockResolvedValueOnce({ value: null, effects: {} });
  await insertNovelIfAbsent({ pluginId: "source", path, name: "Novel" });
  expect(invokeMock).toHaveBeenCalledWith("db_novel_insert_if_absent", {
    input: {
      pluginId: "source",
      path,
      name: "Novel",
      cover: null,
      inLibrary: true,
    },
  });
});

describe("library queries", () => {
  it("lists library identities and ids with explicit read modes", async () => {
    invokeMock
      .mockResolvedValueOnce([
        { pluginId: "source-a", path: "/novel/1" },
        { pluginId: "source-b", path: "/novel/2" },
      ])
      .mockResolvedValueOnce([1, 2]);

    await expect(listLibraryNovelIdentities()).resolves.toEqual([
      { pluginId: "source-a", path: "/novel/1" },
      { pluginId: "source-b", path: "/novel/2" },
    ]);
    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "db_novel_list_library_identities",
      { mode: "queued" },
    );

    await expect(
      listLibraryNovelIds({ categoryId: UNCATEGORIZED_CATEGORY_ID }),
    ).resolves.toEqual([1, 2]);
    expect(invokeMock).toHaveBeenNthCalledWith(2, "db_novel_list_library_ids", {
      filter: { categoryId: UNCATEGORIZED_CATEGORY_ID },
      mode: "queued",
    });
  });

  it("clamps oversized route limits before invoking db_novel_list_library", async () => {
    invokeMock.mockResolvedValueOnce([]);

    await listLibraryNovels({
      limit: MAX_ROUTE_QUERY_ROWS + 25,
      search: "abc",
    });

    expect(invokeMock).toHaveBeenCalledWith("db_novel_list_library", {
      filter: {
        limit: MAX_ROUTE_QUERY_ROWS,
        search: "abc",
      },
      mode: "queued",
    });
  });

  it("forwards cursor pagination and clamps page limits", async () => {
    const pagePayload = {
      hasMore: true,
      nextCursor: { id: 8, name: "Eight", sortValue: 8 },
      novels: [
        {
          id: 9,
          pluginId: "demo",
          path: "p9",
          name: "Nine",
          sourceNovelId: null,
          cover: null,
          author: null,
          inLibrary: true,
          isLocal: false,
          totalChapters: 12,
          chaptersDownloaded: 3,
          chaptersUnread: 4,
          readingProgress: 25,
          lastReadAt: null,
          lastUpdatedAt: 1_700_000_009,
        },
      ],
    };
    invokeMock.mockResolvedValueOnce(pagePayload);

    const page = await listLibraryNovelPage(
      {
        cursor: { id: 10, name: "Ten", sortValue: 10 },
        limit: 2,
        sortOrder: "dateAddedDesc",
      },
      "committed",
    );

    expect(invokeMock).toHaveBeenCalledWith("db_novel_list_library_page", {
      filter: {
        cursor: { id: 10, name: "Ten", sortValue: 10 },
        limit: 2,
        sortOrder: "dateAddedDesc",
      },
      mode: "committed",
    });
    expect(page).toEqual(pagePayload);
  });

  it("queries library summary, stored chapter counts, source filters, and refresh targets", async () => {
    const summary = {
      completeNovels: 2,
      downloadedChapters: 25,
      downloadedNovels: 3,
      lastUpdatedAt: 1_700_000_099,
      localNovels: 1,
      repairNeededNovels: 2,
      totalChapters: 40,
      totalNovels: 4,
      unreadChapters: 6,
      unreadNovels: 2,
    };
    invokeMock
      .mockResolvedValueOnce(summary)
      .mockResolvedValueOnce(14)
      .mockResolvedValueOnce([
        { pluginId: "source", pluginName: "Source", totalNovels: 4 },
      ])
      .mockResolvedValueOnce([
        {
          id: 2,
          pluginId: "demo",
          path: "/novel",
          name: "Demo",
          cover: null,
          isLocal: false,
        },
      ]);

    await expect(
      getLibraryNovelSummary({ categoryId: 7, unreadOnly: true }, "committed"),
    ).resolves.toEqual(summary);
    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "db_novel_get_library_summary",
      {
        filter: { categoryId: 7, unreadOnly: true },
        mode: "committed",
      },
    );

    await expect(countLibraryStoredChapters([])).resolves.toBe(0);
    await expect(
      countLibraryStoredChapters([1, 2, 1, Number.NaN], "committed"),
    ).resolves.toBe(14);
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "db_novel_count_library_stored_chapters",
      {
        novelIds: [1, 2],
        mode: "committed",
      },
    );

    await expect(
      listLibrarySourceFilters({ downloadedOnly: true }, "committed"),
    ).resolves.toEqual([
      { pluginId: "source", pluginName: "Source", totalNovels: 4 },
    ]);
    await expect(
      listLibraryNovelRefreshTargets({ search: "Hero" }),
    ).resolves.toHaveLength(1);

    invokeMock
      .mockResolvedValueOnce([{ status: "Completed", totalNovels: 3 }])
      .mockResolvedValueOnce([{ tag: "Fantasy", totalNovels: 2 }]);
    await expect(
      listLibraryStatusFilters({ tags: ["Fantasy"] }, "committed"),
    ).resolves.toEqual([{ status: "Completed", totalNovels: 3 }]);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "db_novel_list_library_status_filters",
      { filter: { tags: ["Fantasy"] }, mode: "committed" },
    );
    await expect(
      listLibraryTagFilters({ statuses: ["Completed"] }, "committed"),
    ).resolves.toEqual([{ tag: "Fantasy", totalNovels: 2 }]);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "db_novel_list_library_tag_filters",
      { filter: { statuses: ["Completed"] }, mode: "committed" },
    );
  });
});

describe("detail, count, and membership mutations", () => {
  it("loads novel detail by id and counts novels", async () => {
    invokeMock.mockResolvedValueOnce(null).mockResolvedValueOnce(7);
    await expect(getNovelById(999, "committed")).resolves.toBeNull();
    await expect(countNovels()).resolves.toBe(7);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "db_novel_get_by_id", {
      id: 999,
      mode: "committed",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "db_novel_count", {
      mode: "queued",
    });
  });

  it("toggles library membership through db_novel_set_in_library", async () => {
    invokeMock
      .mockResolvedValueOnce({ value: null, effects: {} })
      .mockResolvedValueOnce({ value: null, effects: {} });

    await setNovelInLibrary(7, true);
    await setNovelInLibrary(7, false);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "db_novel_set_in_library", {
      id: 7,
      inLibrary: true,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "db_novel_set_in_library", {
      id: 7,
      inLibrary: false,
    });
  });
});

describe("local novel mutations", () => {
  it("validates local metadata name and forwards normalized fields", async () => {
    await expect(
      updateLocalNovelMetadata(12, { name: "   " }),
    ).rejects.toThrow("local novel: name is required");
    expect(invokeMock).not.toHaveBeenCalled();

    invokeMock.mockResolvedValueOnce({ value: null, effects: {} });
    await updateLocalNovelMetadata(12, {
      name: "  Manual Book  ",
      cover: LOCAL_COVER,
      summary: "",
      author: "Writer",
    });
    expect(invokeMock).toHaveBeenCalledWith("db_novel_update_local_metadata", {
      novelId: 12,
      input: {
        name: "Manual Book",
        cover: LOCAL_COVER,
        summary: "",
        author: "Writer",
        artist: null,
        status: null,
        genres: null,
      },
    });
  });

  it("routes chapter reorder and renumber commands", async () => {
    invokeMock
      .mockResolvedValueOnce({ value: null, effects: {} })
      .mockResolvedValueOnce({ value: { rowsAffected: 2 }, effects: {} });

    await reorderLocalNovelChapters(42, [9, 8]);
    await expect(renumberLocalNovelChapters(42)).resolves.toEqual({
      rowsAffected: 2,
    });

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "db_novel_reorder_local_chapters",
      {
        novelId: 42,
        chapterIds: [9, 8],
      },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "db_novel_renumber_local_chapters",
      { novelId: 42 },
    );
  });

  it("strips heavy chapter bodies and preserves tri-state metadata flags in upsertLocalNovel", async () => {
    invokeMock.mockResolvedValueOnce({
      value: {
        changed: true,
        changedChapters: 1,
        novelId: 42,
        chapterCount: 1,
      },
      effects: {},
    });

    const result = await upsertLocalNovel({
      path: "local",
      name: "local",
      cover: LOCAL_COVER,
      summary: null,
      chapters: [
        {
          path: "chapter-1",
          name: "Chapter 1",
          position: 1,
          chapterNumber: "1",
          contentType: "text",
          content: "Large body that must not cross DB IPC",
          contentBytes: 12,
        },
      ],
    });

    expect(invokeMock).toHaveBeenCalledWith("db_novel_upsert_local", {
      input: {
        path: "local",
        name: "local",
        cover: LOCAL_COVER,
        hasCover: true,
        summary: null,
        hasSummary: true,
        author: null,
        hasAuthor: false,
        artist: null,
        hasArtist: false,
        status: null,
        hasStatus: false,
        genres: null,
        hasGenres: false,
        chapters: [
          {
            path: "chapter-1",
            name: "Chapter 1",
            position: 1,
            contentType: "text",
            contentBytes: 12,
            chapterNumber: "1",
            page: "1",
            releaseTime: null,
          },
        ],
      },
    });
    expect(result).toEqual({
      changed: true,
      changedChapters: 1,
      novelId: 42,
      chapterCount: 1,
    });
  });
});
