import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client", () => ({
  getDb: vi.fn(),
  runDatabaseTransaction: vi.fn(),
}));

import { getDb, runDatabaseTransaction } from "../client";
import { MAX_ROUTE_QUERY_ROWS } from "../../lib/performance-budgets";
import {
  clearChapterContent,
  clearNovelHistory,
  getAdjacentChapter,
  getChapterById,
  getChapterContent,
  getLatestSourceChapterAnchor,
  insertChapterIfAbsent,
  listChaptersByNovel,
  listLibraryUpdates,
  listLibraryUpdatesPage,
  listRecentlyRead,
  markChapterOpened,
  saveChapterContent,
  setChapterBookmark,
  updateChapterProgress,
  upsertChapter,
  upsertDownloadedChapters,
  upsertSourceChapters,
} from "./chapter";

const mockedGetDb = vi.mocked(getDb);
const mockedRunDatabaseTransaction = vi.mocked(runDatabaseTransaction);
let mockSelect: ReturnType<typeof vi.fn>;
let mockExecute: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockSelect = vi.fn();
  mockExecute = vi.fn();
  mockedGetDb.mockResolvedValue({
    select: mockSelect,
    execute: mockExecute,
  } as never);
  mockedRunDatabaseTransaction.mockImplementation(async (run) =>
    run({
      select: mockSelect,
      execute: mockExecute,
    } as never),
  );
});

describe("listChaptersByNovel", () => {
  it("filters by novel_id and orders by position", async () => {
    mockSelect.mockResolvedValueOnce([]);
    await listChaptersByNovel(42);

    const [sql, params] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("FROM chapter");
    expect(sql).toContain("WHERE novel_id = $1");
    expect(sql).toContain("ORDER BY position");
    expect(sql).not.toMatch(/\bcontent\b/);
    expect(params).toEqual([42]);
  });
});

describe("getChapterById", () => {
  it("returns the row when present", async () => {
    mockSelect.mockResolvedValueOnce([{ id: 7, novelId: 1 }]);
    const row = await getChapterById(7);
    const [sql] = mockSelect.mock.calls[0]!;
    expect(sql).toMatch(/\bcontent\b/);
    expect(row).toMatchObject({ id: 7, novelId: 1 });
  });

  it("returns null on miss", async () => {
    mockSelect.mockResolvedValueOnce([]);
    expect(await getChapterById(999)).toBeNull();
  });
});

describe("insertChapterIfAbsent", () => {
  it("uses INSERT OR IGNORE with the expected params in order", async () => {
    mockExecute.mockResolvedValueOnce(undefined);
    await insertChapterIfAbsent({
      novelId: 1,
      path: "/c/1",
      name: "Chapter One",
      position: 1,
      chapterNumber: "1",
      page: "1",
      releaseTime: "2025-12-31",
    });

    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("INSERT OR IGNORE INTO chapter");
    expect(sql).toContain("created_at");
    expect(sql).toContain("found_at");
    expect(params).toEqual([
      1,
      "/c/1",
      "Chapter One",
      1,
      "1",
      "1",
      "2025-12-31",
      "html",
    ]);
  });

  it("defaults page to '1' and nullable fields to null", async () => {
    mockExecute.mockResolvedValueOnce(undefined);
    await insertChapterIfAbsent({
      novelId: 2,
      path: "/c/x",
      name: "Untitled",
      position: 0,
    });
    const [, params] = mockExecute.mock.calls[0]!;
    expect(params).toEqual([
      2,
      "/c/x",
      "Untitled",
      0,
      null,
      "1",
      null,
      "html",
    ]);
  });
});

describe("getLatestSourceChapterAnchor", () => {
  it("returns the greatest numeric chapter number and its position", async () => {
    mockSelect.mockResolvedValueOnce([
      { chapterNumber: "1", position: 1 },
      { chapterNumber: "3", position: 3 },
      { chapterNumber: "2", position: 2 },
    ]);

    const result = await getLatestSourceChapterAnchor(7);

    const [sql, params] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("chapter_number AS chapterNumber");
    expect(sql).toContain("WHERE novel_id = $1");
    expect(params).toEqual([7]);
    expect(result).toEqual({
      novelId: 7,
      chapterNumber: 3,
      position: 3,
    });
  });

  it("returns null when any existing chapter is missing a usable chapter number", async () => {
    mockSelect.mockResolvedValueOnce([
      { chapterNumber: "1", position: 1 },
      { chapterNumber: null, position: 2 },
    ]);

    await expect(getLatestSourceChapterAnchor(7)).resolves.toBeNull();
  });
});

describe("upsertChapter", () => {
  it("updates source metadata without touching progress fields", async () => {
    mockExecute.mockResolvedValueOnce({ rowsAffected: 1 });

    const result = await upsertChapter({
      novelId: 7,
      path: "/c/1",
      name: "Chapter One",
      position: 1,
      chapterNumber: "1",
      page: "2",
      releaseTime: "2026-05-01",
    });

    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("ON CONFLICT(novel_id, path) DO UPDATE");
    expect(sql).toContain("name           = excluded.name");
    expect(sql).toContain("content_type   = excluded.content_type");
    expect(sql).toContain("created_at");
    expect(sql).toContain("found_at");
    expect(sql).not.toContain("found_at       = excluded.found_at");
    expect(sql).toContain("updated_at     = unixepoch()");
    expect(sql).toContain("WHERE");
    expect(sql).toContain("name IS NOT excluded.name");
    expect(sql).not.toContain("progress");
    expect(sql).not.toContain("content        =");
    expect(sql).not.toContain("media_bytes");
    expect(sql).not.toContain("is_downloaded");
    expect(params).toEqual([
      7,
      "/c/1",
      "Chapter One",
      1,
      "1",
      "2",
      "2026-05-01",
      "html",
    ]);
    expect(result).toEqual({ rowsAffected: 1 });
  });
});

describe("upsertSourceChapters", () => {
  it("bulk upserts source chapter metadata in one transaction", async () => {
    mockExecute.mockResolvedValueOnce({ rowsAffected: 2 });

    const result = await upsertSourceChapters([
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
    ]);

    expect(mockedRunDatabaseTransaction).toHaveBeenCalledOnce();
    expect(mockExecute).toHaveBeenCalledOnce();
    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO chapter");
    expect(sql).toContain("VALUES ($1, $2, $3, $4, $5, $6, $7, $8");
    expect(sql).toContain("($9, $10, $11, $12, $13, $14, $15, $16");
    expect(sql).toContain("ON CONFLICT(novel_id, path) DO UPDATE");
    expect(sql).not.toContain("content        =");
    expect(params).toEqual([
      7,
      "/c/1",
      "Chapter One",
      1,
      "1",
      "1",
      null,
      "html",
      7,
      "/c/2",
      "Chapter Two",
      2,
      "2",
      "1",
      null,
      "text",
    ]);
    expect(result).toEqual({ rowsAffected: 2, chunks: 1 });
  });

  it("chunks source chapter upserts by the SQLite bind budget", async () => {
    mockExecute
      .mockResolvedValueOnce({ rowsAffected: 112 })
      .mockResolvedValueOnce({ rowsAffected: 1 });

    const chapters = Array.from({ length: 113 }, (_, index) => ({
      novelId: 7,
      path: `/c/${index + 1}`,
      name: `Chapter ${index + 1}`,
      position: index + 1,
      chapterNumber: String(index + 1),
    }));

    await expect(upsertSourceChapters(chapters)).resolves.toEqual({
      rowsAffected: 113,
      chunks: 2,
    });
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("rejects chapter titles over the input budget before opening a transaction", async () => {
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

    expect(mockedRunDatabaseTransaction).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe("upsertDownloadedChapters", () => {
  it("bulk upserts downloaded chapter content and recomputes content bytes", async () => {
    mockExecute.mockResolvedValueOnce({ rowsAffected: 1 });

    const result = await upsertDownloadedChapters([
      {
        novelId: 7,
        path: "local:txt:hash/chapter-0001",
        name: "Chapter 1",
        position: 1,
        content: "Chapter body",
        contentBytes: 1,
        contentType: "text",
      },
    ]);

    expect(mockedRunDatabaseTransaction).toHaveBeenCalledOnce();
    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("content_bytes");
    expect(sql).toContain("media_repair_needed");
    expect(sql).toContain("media_bytes_checked_at = NULL");
    expect(sql).toContain("is_downloaded  = 1");
    expect(params).toEqual([
      7,
      "local:txt:hash/chapter-0001",
      "Chapter 1",
      1,
      null,
      "1",
      null,
      "html",
      "Chapter body",
      12,
    ]);
    expect(result).toEqual({ rowsAffected: 1, chunks: 1 });
  });
});

describe("updateChapterProgress", () => {
  it("clamps below zero to 0", async () => {
    mockExecute.mockResolvedValueOnce(undefined);
    await updateChapterProgress(5, -10);
    const [, params] = mockExecute.mock.calls[0]!;
    expect(params).toEqual([5, 0]);
  });

  it("clamps above 100 to 100", async () => {
    mockExecute.mockResolvedValueOnce(undefined);
    await updateChapterProgress(5, 250);
    const [, params] = mockExecute.mock.calls[0]!;
    expect(params).toEqual([5, 100]);
  });

  it("rounds floats", async () => {
    mockExecute.mockResolvedValueOnce(undefined);
    await updateChapterProgress(5, 33.7);
    const [, params] = mockExecute.mock.calls[0]!;
    expect(params).toEqual([5, 34]);
  });

  it("flips unread at 100 and records read_at for history", async () => {
    mockExecute.mockResolvedValueOnce(undefined);
    await updateChapterProgress(5, 100);
    const [sql] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("CASE WHEN $2 >= 100 THEN 0 ELSE unread END");
    expect(sql).toContain(
      "CASE WHEN $2 > 0 THEN unixepoch() ELSE read_at END",
    );
  });

  it("bumps the parent novel last_read_at", async () => {
    mockExecute.mockResolvedValue(undefined);
    await updateChapterProgress(5, 50);
    const [sql, params] = mockExecute.mock.calls[1]!;
    expect(sql).toContain("UPDATE novel");
    expect(sql).toContain("last_read_at = unixepoch()");
    expect(sql).toContain("SELECT novel_id FROM chapter WHERE id = $1");
    expect(params).toEqual([5]);
  });
});

describe("markChapterOpened", () => {
  it("updates chapter history and parent novel last_read_at", async () => {
    mockExecute.mockResolvedValue(undefined);
    await markChapterOpened(17);

    const [chapterSql, chapterParams] = mockExecute.mock.calls[0]!;
    expect(chapterSql).toContain("UPDATE chapter");
    expect(chapterSql).toContain("read_at = unixepoch()");
    expect(chapterParams).toEqual([17]);

    const [novelSql, novelParams] = mockExecute.mock.calls[1]!;
    expect(novelSql).toContain("UPDATE novel");
    expect(novelSql).toContain("last_read_at = unixepoch()");
    expect(novelParams).toEqual([17]);
  });
});

describe("clearNovelHistory", () => {
  it("removes a novel from history without touching progress", async () => {
    mockExecute.mockResolvedValue(undefined);
    await clearNovelHistory(7);

    const [chapterSql, chapterParams] = mockExecute.mock.calls[0]!;
    expect(chapterSql).toContain("UPDATE chapter");
    expect(chapterSql).toContain("read_at = NULL");
    expect(chapterSql).toContain("novel_id = $1");
    expect(chapterSql).not.toContain("progress");
    expect(chapterParams).toEqual([7]);

    const [novelSql, novelParams] = mockExecute.mock.calls[1]!;
    expect(novelSql).toContain("UPDATE novel");
    expect(novelSql).toContain("last_read_at = NULL");
    expect(novelParams).toEqual([7]);
  });
});

describe("setChapterBookmark", () => {
  it("toggles via a numeric SQLite flag", async () => {
    mockExecute.mockResolvedValueOnce(undefined);
    await setChapterBookmark(11, false);
    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("UPDATE chapter");
    expect(sql).toContain("bookmark = $2");
    expect(params).toEqual([11, 0]);
  });
});

describe("saveChapterContent", () => {
  it("UPDATEs content + flips is_downloaded=1 + bumps updated_at", async () => {
    mockExecute.mockResolvedValueOnce({ rowsAffected: 1 });
    const result = await saveChapterContent(7, "<p>hello</p>");
    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("UPDATE chapter");
    expect(sql).toContain("content");
    expect(sql).toContain("content_type   = $3");
    expect(sql).toContain("content_bytes  = $4");
    expect(sql).toContain("media_bytes    = $5");
    expect(sql).toContain("media_repair_needed = $6");
    expect(sql).toContain(
      "media_bytes_checked_at = CASE WHEN $7 = 1 THEN unixepoch() ELSE NULL END",
    );
    expect(sql).toContain("is_downloaded  = 1");
    expect(sql).toContain("updated_at     = unixepoch()");
    expect(params).toEqual([7, "<p>hello</p>", "html", 12, 0, 0, 0]);
    expect(result).toEqual({ rowsAffected: 1 });
  });

  it("stores converted text chapters as html", async () => {
    mockExecute.mockResolvedValueOnce({ rowsAffected: 1 });
    await saveChapterContent(
      7,
      '<section class="reader-text-content"><p>hello</p></section>',
      "text",
    );
    const [, params] = mockExecute.mock.calls[0]!;
    expect(params?.[2]).toBe("html");
  });

  it("marks HTML with remote media as repairable", async () => {
    mockExecute.mockResolvedValueOnce({ rowsAffected: 1 });
    await saveChapterContent(7, '<img src="https://cdn.example/a.jpg">');
    const [, params] = mockExecute.mock.calls[0]!;
    expect(params).toEqual([
      7,
      '<img src="https://cdn.example/a.jpg">',
      "html",
      37,
      0,
      1,
      0,
    ]);
  });

  it("does not mark local chapter media as repairable", async () => {
    mockExecute.mockResolvedValueOnce({ rowsAffected: 1 });
    await saveChapterContent(
      7,
      '<img src="norea-media://reader-asset/page.png">',
    );
    const [, params] = mockExecute.mock.calls[0]!;
    expect(params?.[5]).toBe(0);
  });
});

describe("getChapterContent", () => {
  it("returns the content string when row exists with content", async () => {
    mockSelect.mockResolvedValueOnce([{ content: "<p>x</p>" }]);
    expect(await getChapterContent(7)).toBe("<p>x</p>");
  });

  it("returns null when row content is null", async () => {
    mockSelect.mockResolvedValueOnce([{ content: null }]);
    expect(await getChapterContent(7)).toBeNull();
  });

  it("returns null when no row matches", async () => {
    mockSelect.mockResolvedValueOnce([]);
    expect(await getChapterContent(7)).toBeNull();
  });
});

describe("clearChapterContent", () => {
  it("nulls content and resets is_downloaded", async () => {
    mockExecute.mockResolvedValueOnce(undefined);
    await clearChapterContent(7);
    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("content        = NULL");
    expect(sql).toContain("content_bytes  = 0");
    expect(sql).toContain("media_bytes    = 0");
    expect(sql).toContain("media_repair_needed = 0");
    expect(sql).toContain("media_bytes_checked_at = NULL");
    expect(sql).toContain("is_downloaded  = 0");
    expect(sql).toContain("FROM novel");
    expect(sql).toContain("is_local = 0");
    expect(params).toEqual([7]);
  });
});

describe("getAdjacentChapter", () => {
  it("issues the next-chapter query when direction=1", async () => {
    mockSelect.mockResolvedValueOnce([]);
    await getAdjacentChapter(1, 5, 1);
    const [sql, params] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("position > $2");
    expect(sql).toContain("ORDER BY position ASC");
    expect(sql).not.toMatch(/\bcontent\b/);
    expect(params).toEqual([1, 5]);
  });

  it("issues the prev-chapter query when direction=-1", async () => {
    mockSelect.mockResolvedValueOnce([]);
    await getAdjacentChapter(1, 5, -1);
    const [sql, params] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("position < $2");
    expect(sql).toContain("ORDER BY position DESC");
    expect(sql).not.toMatch(/\bcontent\b/);
    expect(params).toEqual([1, 5]);
  });

  it("returns null on no adjacent row", async () => {
    mockSelect.mockResolvedValueOnce([]);
    expect(await getAdjacentChapter(1, 5, 1)).toBeNull();
  });
});

describe("listLibraryUpdates", () => {
  it("filters in-library + unread chapters and supports paging", async () => {
    mockSelect.mockResolvedValueOnce([]);

    await listLibraryUpdates();

    const [sql, params] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("n.in_library = 1");
    expect(sql).toContain("c.unread = 1");
    expect(sql).toContain("c.path");
    expect(sql).toContain("c.content_type    AS contentType");
    expect(sql).toContain("c.found_at        AS foundAt");
    expect(sql).toContain("ORDER BY foundAt DESC");
    expect(sql).not.toContain("OFFSET");
    expect(params).toEqual([100]);
  });

  it("coerces is_downloaded to a strict boolean", async () => {
    mockSelect.mockResolvedValueOnce([
      {
        chapterId: 1,
        chapterPath: "/c/1",
        novelId: 1,
        pluginId: "source-a",
        chapterName: "Ch1",
        contentType: "text",
        position: 1,
        foundAt: 1_700_000_000,
        isDownloaded: 1,
        novelName: "Sample",
        novelCover: null,
      },
    ]);

    const rows = await listLibraryUpdates();
    expect(rows[0]?.isDownloaded).toBe(true);
    expect(rows[0]?.contentType).toBe("text");
  });

  it("clamps limit to a minimum of 1", async () => {
    mockSelect.mockResolvedValueOnce([]);
    await listLibraryUpdates(0);
    const [, params] = mockSelect.mock.calls[0]!;
    expect(params).toEqual([1]);
  });

  it("caps oversized route query limits", async () => {
    mockSelect.mockResolvedValueOnce([]);
    await listLibraryUpdates(MAX_ROUTE_QUERY_ROWS + 25);
    const [, params] = mockSelect.mock.calls[0]!;
    expect(params).toEqual([MAX_ROUTE_QUERY_ROWS]);
  });

  it("uses keyset cursor params for the next page", async () => {
    mockSelect.mockResolvedValueOnce([]);
    await listLibraryUpdates(25, {
      chapterId: 9,
      foundAt: 1_700_000_000,
      position: 4,
    });
    const [sql, params] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("c.found_at < $1");
    expect(sql).toContain("c.position < $2");
    expect(sql).toContain("c.id < $3");
    expect(params).toEqual([1_700_000_000, 4, 9, 25]);
  });

  it("loads one extra row to report whether another page exists", async () => {
    mockSelect.mockResolvedValueOnce(
      Array.from({ length: 101 }, (_, index) => ({
        chapterId: index + 1,
        chapterPath: `/c/${index + 1}`,
        novelId: 1,
        pluginId: "source-a",
        chapterName: `Ch${index + 1}`,
        contentType: "html",
        position: index + 1,
        foundAt: 1_700_000_000 - index,
        isDownloaded: 0,
        novelName: "Sample",
        novelCover: null,
      })),
    );

    const page = await listLibraryUpdatesPage(100);

    const [, params] = mockSelect.mock.calls[0]!;
    expect(params).toEqual([101]);
    expect(page.updates).toHaveLength(100);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual({
      chapterId: 100,
      foundAt: 1_700_000_000 - 99,
      position: 100,
    });
  });
});

describe("listRecentlyRead", () => {
  it("joins chapter with novel and returns the latest chapter per novel", async () => {
    mockSelect.mockResolvedValueOnce([]);

    await listRecentlyRead();

    const [sql, params] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("FROM chapter c");
    expect(sql).toContain("JOIN novel n");
    expect(sql).toContain("WHERE c.id = (");
    expect(sql).toContain("c2.novel_id = c.novel_id");
    expect(sql).toContain("c2.read_at IS NOT NULL");
    expect(sql).toContain("ORDER BY c.read_at DESC");
    expect(sql).toContain("LIMIT $1");
    expect(params).toEqual([100]);
  });

  it("clamps limit to a minimum of 1 and floors fractional input", async () => {
    mockSelect.mockResolvedValueOnce([]);

    await listRecentlyRead(0.4);

    const [, params] = mockSelect.mock.calls[0]!;
    expect(params).toEqual([1]);
  });

  it("forwards a custom positive limit", async () => {
    mockSelect.mockResolvedValueOnce([]);

    await listRecentlyRead(25);

    const [, params] = mockSelect.mock.calls[0]!;
    expect(params).toEqual([25]);
  });

  it("caps oversized history limits to the route query budget", async () => {
    mockSelect.mockResolvedValueOnce([]);

    await listRecentlyRead(MAX_ROUTE_QUERY_ROWS + 1);

    const [, params] = mockSelect.mock.calls[0]!;
    expect(params).toEqual([MAX_ROUTE_QUERY_ROWS]);
  });
});
