import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../lib/observability", () => ({
  startPerformanceObservation: () => () => undefined,
  recordPerformanceObservation: () => undefined,
}));

import {
  MAX_CHAPTER_BULK_INPUT_ROWS,
  MAX_INLINE_IPC_BYTES,
  MAX_ROUTE_QUERY_ROWS,
} from "../../lib/performance-budgets";
import {
  adoptStoredChapterContentMetadata,
  clearChapterContent,
  clearNovelHistory,
  findLocalImportedChapter,
  getAdjacentChapter,
  getChapterById,
  getLatestSourceChapterAnchor,
  hasStoredChapterContent,
  insertChapterIfAbsent,
  listChaptersByNovel,
  listLibraryUpdates,
  listLibraryUpdatesPage,
  listRecentlyRead,
  markChapterOpened,
  markStoredChapterContentMissing,
  saveChapterContentMetadata,
  saveChapterPartialContentMetadata,
  setChapterBookmark,
  setRelativeChaptersReadState,
  updateChapterProgress,
  upsertChapter,
  upsertDownloadedChapters,
  upsertSourceChapters,
} from "./chapter";

beforeEach(() => {
  invokeMock.mockReset();
});

describe("findLocalImportedChapter & hasStoredChapterContent", () => {
  it("forwards pathKey to db_chapter_find_local_imported", async () => {
    invokeMock.mockResolvedValueOnce({ id: 9, novelId: 3 });
    await expect(findLocalImportedChapter("local:txt:abc")).resolves.toEqual({
      id: 9,
      novelId: 3,
    });
    expect(invokeMock).toHaveBeenCalledWith("db_chapter_find_local_imported", {
      pathKey: "local:txt:abc",
    });
  });

  it("identifies stored content from either isDownloaded or positive contentBytes", () => {
    expect(hasStoredChapterContent({ isDownloaded: true, contentBytes: 0 })).toBe(
      true,
    );
    expect(
      hasStoredChapterContent({ isDownloaded: false, contentBytes: 12 }),
    ).toBe(true);
    expect(
      hasStoredChapterContent({ isDownloaded: false, contentBytes: 0 }),
    ).toBe(false);
  });
});

describe("listChaptersByNovel & getChapterById", () => {
  it("passes novelId and explicit readMode to db_chapter_list_by_novel", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await listChaptersByNovel(42);
    expect(invokeMock).toHaveBeenCalledWith("db_chapter_list_by_novel", {
      novelId: 42,
      readMode: "queued",
    });

    invokeMock.mockResolvedValueOnce([]);
    await listChaptersByNovel(42, "committed");
    expect(invokeMock).toHaveBeenLastCalledWith("db_chapter_list_by_novel", {
      novelId: 42,
      readMode: "committed",
    });
  });

  it("passes chapterId and readMode to db_chapter_get_by_id", async () => {
    const sample = {
      id: 7,
      novelId: 1,
      sourceContentType: "text",
      contentType: "html",
    };
    invokeMock.mockResolvedValueOnce(sample);
    await expect(getChapterById(7)).resolves.toEqual(sample);
    expect(invokeMock).toHaveBeenCalledWith("db_chapter_get_by_id", {
      chapterId: 7,
      readMode: "queued",
    });

    invokeMock.mockResolvedValueOnce(null);
    await expect(getChapterById(999, "committed")).resolves.toBeNull();
    expect(invokeMock).toHaveBeenLastCalledWith("db_chapter_get_by_id", {
      chapterId: 999,
      readMode: "committed",
    });
  });
});

describe("insertChapterIfAbsent & upsertChapter", () => {
  it("normalizes optional chapter fields before invoking db_chapter_insert_if_absent", async () => {
    invokeMock.mockResolvedValueOnce({ value: null, effects: {} });
    await insertChapterIfAbsent({
      novelId: 2,
      path: "/c/x",
      name: "Untitled",
      position: 0,
    });
    expect(invokeMock).toHaveBeenCalledWith("db_chapter_insert_if_absent", {
      input: {
        novelId: 2,
        path: "/c/x",
        name: "Untitled",
        position: 0,
        chapterNumber: null,
        page: "1",
        releaseTime: null,
        contentType: "html",
      },
    });
  });

  it("forwards explicit fields to db_chapter_upsert", async () => {
    invokeMock.mockResolvedValueOnce({
      value: { rowsAffected: 1 },
      effects: {},
    });
    const result = await upsertChapter({
      novelId: 7,
      path: "/c/1",
      name: "Chapter One",
      position: 1,
      chapterNumber: "1",
      page: "2",
      releaseTime: "2026-05-01",
      contentType: "epub",
    });
    expect(invokeMock).toHaveBeenCalledWith("db_chapter_upsert", {
      input: {
        novelId: 7,
        path: "/c/1",
        name: "Chapter One",
        position: 1,
        chapterNumber: "1",
        page: "2",
        releaseTime: "2026-05-01",
        contentType: "epub",
      },
    });
    expect(result).toEqual({ rowsAffected: 1 });
  });
});

describe("getLatestSourceChapterAnchor", () => {
  it("queries db_chapter_get_latest_source_anchor", async () => {
    invokeMock.mockResolvedValueOnce({
      novelId: 7,
      chapterNumber: 3,
      position: 3,
    });
    await expect(getLatestSourceChapterAnchor(7)).resolves.toEqual({
      novelId: 7,
      chapterNumber: 3,
      position: 3,
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "db_chapter_get_latest_source_anchor",
      { novelId: 7 },
    );
  });
});

describe("upsertSourceChapters & upsertDownloadedChapters", () => {
  it("short-circuits empty source chapter arrays without invoking IPC", async () => {
    await expect(upsertSourceChapters([])).resolves.toEqual({
      rowsAffected: 0,
      chunks: 0,
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("normalizes inputs and forwards remoteContentSync to db_chapter_upsert_source", async () => {
    invokeMock.mockResolvedValueOnce({
      value: { rowsAffected: 2, chunks: 1 },
      effects: {},
    });
    const result = await upsertSourceChapters(
      [
        {
          novelId: 7,
          path: "/c/1",
          name: "Chapter One",
          position: 1,
          chapterNumber: "1",
        },
        {
          novelId: 7,
          path: "/c/2",
          name: "Chapter Two",
          position: 2,
          chapterNumber: "2",
          contentType: "text",
        },
      ],
      { remoteContentSync: true },
    );
    expect(invokeMock).toHaveBeenCalledWith("db_chapter_upsert_source", {
      inputs: [
        {
          novelId: 7,
          path: "/c/1",
          name: "Chapter One",
          position: 1,
          chapterNumber: "1",
          page: "1",
          releaseTime: null,
          contentType: "html",
        },
        {
          novelId: 7,
          path: "/c/2",
          name: "Chapter Two",
          position: 2,
          chapterNumber: "2",
          page: "1",
          releaseTime: null,
          contentType: "text",
        },
      ],
      remoteContentSync: true,
    });
    expect(result).toEqual({ rowsAffected: 2, chunks: 1 });
  });

  it("rejects chapter titles, URLs, and bulk counts over budget before invoking IPC", async () => {
    await expect(
      upsertSourceChapters([
        {
          novelId: 7,
          path: "/c/1",
          name: "x".repeat(8 * 1024 + 1),
          position: 1,
        },
      ]),
    ).rejects.toThrow("Chapter title");
    await expect(
      upsertSourceChapters(
        Array.from({ length: MAX_CHAPTER_BULK_INPUT_ROWS + 1 }, (_, index) => ({
          novelId: 7,
          path: `/c/${index}`,
          name: "Title",
          position: index + 1,
        })),
      ),
    ).rejects.toThrow("exceeds");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("validates downloaded chapter content byte budgets and invokes db_chapter_upsert_downloaded", async () => {
    await expect(
      upsertDownloadedChapters([
        {
          novelId: 7,
          path: "/c/1",
          name: "Chapter 1",
          position: 1,
          contentBytes: MAX_INLINE_IPC_BYTES + 1,
        },
      ]),
    ).rejects.toThrow("Downloaded chapter content");
    expect(invokeMock).not.toHaveBeenCalled();

    invokeMock.mockResolvedValueOnce({
      value: { rowsAffected: 1, chunks: 1 },
      effects: {},
    });
    await expect(
      upsertDownloadedChapters([
        {
          novelId: 7,
          path: "local:txt:hash/chapter-0001",
          name: "Chapter 1",
          position: 1,
          contentBytes: 12,
          contentType: "text",
        },
      ]),
    ).resolves.toEqual({ rowsAffected: 1, chunks: 1 });
    expect(invokeMock).toHaveBeenCalledWith("db_chapter_upsert_downloaded", {
      inputs: [
        {
          novelId: 7,
          path: "local:txt:hash/chapter-0001",
          name: "Chapter 1",
          position: 1,
          chapterNumber: null,
          page: "1",
          releaseTime: null,
          contentType: "text",
          contentBytes: 12,
        },
      ],
    });
  });
});

describe("progress, history, relative read state, and bookmark mutations", () => {
  it("forwards progress and recordHistory defaults to db_chapter_update_progress", async () => {
    invokeMock.mockResolvedValue({ value: null, effects: {} });
    await updateChapterProgress(5, 33.7);
    expect(invokeMock).toHaveBeenCalledWith("db_chapter_update_progress", {
      input: { chapterId: 5, progress: 33.7, recordHistory: true },
    });

    await updateChapterProgress(5, 90, { recordHistory: false });
    expect(invokeMock).toHaveBeenLastCalledWith("db_chapter_update_progress", {
      input: { chapterId: 5, progress: 90, recordHistory: false },
    });
  });

  it("ignores invalid anchor ids and forwards valid relative read-state requests", async () => {
    await expect(
      setRelativeChaptersReadState(0, "after", true),
    ).resolves.toEqual({ rowsAffected: 0, previous: [] });
    expect(invokeMock).not.toHaveBeenCalled();

    invokeMock.mockResolvedValueOnce({
      value: { rowsAffected: 3, previous: [] },
      effects: {},
    });
    await expect(
      setRelativeChaptersReadState(17, "before", false),
    ).resolves.toEqual({ rowsAffected: 3, previous: [] });
    expect(invokeMock).toHaveBeenCalledWith(
      "db_chapter_set_relative_read_state",
      {
        input: { anchorChapterId: 17, direction: "before", unread: false },
      },
    );
  });

  it("invokes markChapterOpened, clearNovelHistory, and setChapterBookmark", async () => {
    invokeMock.mockResolvedValue({ value: null, effects: {} });
    await markChapterOpened(17);
    expect(invokeMock).toHaveBeenCalledWith("db_chapter_mark_opened", {
      chapterId: 17,
    });

    await clearNovelHistory(7);
    expect(invokeMock).toHaveBeenCalledWith("db_chapter_clear_novel_history", {
      novelId: 7,
    });

    await setChapterBookmark(11, false);
    expect(invokeMock).toHaveBeenCalledWith("db_chapter_set_bookmark", {
      chapterId: 11,
      bookmarked: false,
    });
  });
});

describe("stored content metadata mutations", () => {
  it("computes UTF-8 contentBytes, physical contentType, and mediaRepairNeeded before invoking IPC", async () => {
    invokeMock.mockResolvedValue({
      value: { rowsAffected: 1 },
      effects: {},
    });

    await saveChapterContentMetadata(7, "<p>hello</p>");
    expect(invokeMock).toHaveBeenLastCalledWith(
      "db_chapter_save_content_metadata",
      {
        input: {
          chapterId: 7,
          contentBytes: 12,
          contentType: "html",
          mediaRepairNeeded: false,
        },
      },
    );

    await saveChapterContentMetadata(
      7,
      '<img src="https://cdn.example/a.jpg">',
      "text",
      { mediaBytes: 64 },
    );
    expect(invokeMock).toHaveBeenLastCalledWith(
      "db_chapter_save_content_metadata",
      {
        input: {
          chapterId: 7,
          contentBytes: 37,
          contentType: "html",
          mediaBytes: 64,
          mediaRepairNeeded: true,
        },
      },
    );

    await saveChapterContentMetadata(
      7,
      '<img src="norea-media://reader-asset/page.png">',
    );
    expect(invokeMock).toHaveBeenLastCalledWith(
      "db_chapter_save_content_metadata",
      expect.objectContaining({
        input: expect.objectContaining({ mediaRepairNeeded: false }),
      }),
    );
  });

  it("records partial, adopted, missing, and cleared stored content metadata", async () => {
    invokeMock.mockResolvedValue({
      value: { rowsAffected: 1 },
      effects: {},
    });

    await saveChapterPartialContentMetadata(7, "partial", "markdown");
    expect(invokeMock).toHaveBeenLastCalledWith(
      "db_chapter_save_partial_content_metadata",
      {
        input: {
          chapterId: 7,
          contentBytes: 7,
          contentType: "html",
          mediaRepairNeeded: false,
        },
      },
    );

    await adoptStoredChapterContentMetadata(7, 120, 48, "pdf", true);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "db_chapter_adopt_stored_content_metadata",
      {
        input: {
          chapterId: 7,
          contentBytes: 120,
          mediaBytes: 48,
          contentType: "pdf",
          mediaRepairNeeded: true,
        },
      },
    );

    await markStoredChapterContentMissing(7);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "db_chapter_mark_stored_content_missing",
      { chapterId: 7 },
    );

    invokeMock.mockResolvedValueOnce({ value: null, effects: {} });
    await clearChapterContent(7);
    expect(invokeMock).toHaveBeenLastCalledWith("db_chapter_clear_content", {
      chapterId: 7,
    });
  });
});

describe("getAdjacentChapter, listLibraryUpdates, and listRecentlyRead", () => {
  it("passes novelId, position, and direction to db_chapter_get_adjacent", async () => {
    invokeMock.mockResolvedValueOnce(null);
    await expect(getAdjacentChapter(1, 5, 1)).resolves.toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("db_chapter_get_adjacent", {
      novelId: 1,
      position: 5,
      direction: 1,
    });

    invokeMock.mockResolvedValueOnce(null);
    await getAdjacentChapter(1, 5, -1);
    expect(invokeMock).toHaveBeenLastCalledWith("db_chapter_get_adjacent", {
      novelId: 1,
      position: 5,
      direction: -1,
    });
  });

  it("clamps update limits and computes nextCursor when an extra row exists", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await listLibraryUpdates(0);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "db_chapter_list_library_updates",
      {
        input: { limit: 1, cursor: null, scope: "new" },
        readMode: "queued",
      },
    );

    invokeMock.mockResolvedValueOnce([]);
    await listLibraryUpdates(MAX_ROUTE_QUERY_ROWS + 25);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "db_chapter_list_library_updates",
      {
        input: { limit: MAX_ROUTE_QUERY_ROWS, cursor: null, scope: "new" },
        readMode: "queued",
      },
    );

    invokeMock.mockResolvedValueOnce(
      Array.from({ length: 101 }, (_, index) => ({
        chapterId: index + 1,
        chapterPath: `/c/${index + 1}`,
        novelId: 1,
        pluginId: "source-a",
        novelSourceNovelId: "book-1",
        novelPath: "/book-1",
        chapterName: `Ch${index + 1}`,
        contentType: "html",
        position: index + 1,
        sortAt: 1_700_000_000 - index,
        isDownloaded: false,
        novelName: "Sample",
        novelCover: null,
        novelIsLocal: false,
      })),
    );
    const page = await listLibraryUpdatesPage(100);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "db_chapter_list_library_updates",
      {
        input: { limit: 101, cursor: null, scope: "new" },
        readMode: "queued",
      },
    );
    expect(page.updates).toHaveLength(100);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual({
      chapterId: 100,
      sortAt: 1_700_000_000 - 99,
      position: 100,
    });
  });

  it("clamps history limits before invoking db_chapter_list_recently_read", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await listRecentlyRead();
    expect(invokeMock).toHaveBeenCalledWith("db_chapter_list_recently_read", {
      limit: 100,
    });

    invokeMock.mockResolvedValueOnce([]);
    await listRecentlyRead(MAX_ROUTE_QUERY_ROWS + 50);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "db_chapter_list_recently_read",
      { limit: MAX_ROUTE_QUERY_ROWS },
    );
  });
});
