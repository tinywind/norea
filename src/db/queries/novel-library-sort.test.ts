import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../client", () => ({
  getDb: vi.fn(),
  runDatabaseTransaction: vi.fn(),
}));

import { getDb } from "../client";
import {
  listLibraryNovelPage,
  getLibraryNovelSummary,
  listLibraryNovelRefreshTargets,
  listLibraryNovels,
  type LibraryNovelCursor,
} from "./novel";

let sqlite: DatabaseSync;

function addNovel(
  id: number,
  name: string,
  total: number,
  downloaded: number,
  unread: number,
  inLibrary = true,
) {
  sqlite.prepare(
    "INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(?,'source',?,?,?)",
  ).run(id, `/work/${id}`, name, Number(inLibrary));
  const insertChapter = sqlite.prepare(
    `INSERT INTO chapter(id,novel_id,path,name,position,is_downloaded,unread)
     VALUES(?,?,?,?,?,?,?)`,
  );
  for (let position = 1; position <= total; position++) {
    insertChapter.run(
      id * 100 + position,
      id,
      `/chapter/${position}`,
      `Chapter ${position}`,
      position,
      Number(position <= downloaded),
      Number(position <= unread),
    );
  }
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  vi.mocked(getDb).mockResolvedValue({
    select: async (sql: string, params: unknown[] = []) =>
      sqlite.prepare(sql).all(
        Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value])) as never,
      ),
  } as never);

  addNovel(1, "Alpha", 4, 1, 0);
  addNovel(2, "Beta", 5, 3, 5);
  addNovel(3, "ALPHA", 2, 0, 0);
  addNovel(4, "alpha", 4, 2, 4);
  addNovel(5, "Complete", 2, 2, 2);
  addNovel(6, "Empty", 0, 0, 0);
  addNovel(7, "Outside library", 8, 0, 8, false);
});

afterEach(() => sqlite.close());

it.each([
  { sortOrder: "undownloadedAsc" as const, expected: [5, 6, 3, 4, 2, 1] },
  { sortOrder: "undownloadedDesc" as const, expected: [1, 3, 4, 2, 5, 6] },
])("sorts and paginates $sortOrder by missing downloads with stable ties", async ({ sortOrder, expected }) => {
  expect((await listLibraryNovels({ sortOrder })).map((novel) => novel.id)).toEqual(expected);

  const ids: number[] = [];
  let cursor: LibraryNovelCursor | null = null;
  const missingByNovel: Record<number, number> = { 1: 3, 2: 2, 3: 2, 4: 2, 5: 0, 6: 0 };
  for (let pageIndex = 0; pageIndex < expected.length; pageIndex++) {
    const page = await listLibraryNovelPage({ cursor, limit: 1, sortOrder });
    expect(page.novels).toHaveLength(1);
    const novel = page.novels[0]!;
    ids.push(novel.id);
    const hasMore = pageIndex < expected.length - 1;
    expect(page.hasMore).toBe(hasMore);
    expect(page.nextCursor).toEqual(hasMore ? {
      id: novel.id,
      name: novel.name,
      sortValue: missingByNovel[novel.id],
    } : null);
    cursor = page.nextCursor;
  }
  expect(ids).toEqual(expected);
});

it("counts queued and leased chapters as undownloaded regardless of reading state", async () => {
  sqlite.exec(`
    INSERT INTO chapter_download_queue(chapter_id,job_json,created_at_ms,updated_at_ms,leased_at_ms)
    VALUES(102,'{}',1,1,NULL),(103,'{}',1,1,1);
    UPDATE chapter SET unread=0,progress=100 WHERE novel_id=2;
  `);

  const rows = await listLibraryNovels({ sortOrder: "undownloadedDesc" });
  expect(rows.map((novel) => novel.id)).toEqual([1, 3, 4, 2, 5, 6]);
  expect(rows[0]).toMatchObject({ totalChapters: 4, chaptersDownloaded: 1, chaptersUnread: 0 });
  expect(rows.find((novel) => novel.id === 2)).toMatchObject({
    totalChapters: 5,
    chaptersDownloaded: 3,
    chaptersUnread: 0,
  });
});

it("reorders when downloads finish, downloaded files are removed, and new chapters arrive", async () => {
  sqlite.exec(`
    UPDATE chapter SET is_downloaded=1 WHERE novel_id=1;
    UPDATE chapter SET is_downloaded=0 WHERE novel_id=5;
    INSERT INTO chapter(novel_id,path,name,position,is_downloaded)
    VALUES(2,'/chapter/6','New chapter',6,0);
  `);

  const rows = await listLibraryNovels({ sortOrder: "undownloadedDesc" });
  expect(rows.map((novel) => novel.id)).toEqual([2, 3, 4, 5, 1, 6]);
  expect(rows[0]).toMatchObject({ totalChapters: 6, chaptersDownloaded: 3 });
  expect(rows.find((novel) => novel.id === 1)).toMatchObject({ totalChapters: 4, chaptersDownloaded: 4 });
  expect(rows.find((novel) => novel.id === 5)).toMatchObject({ totalChapters: 2, chaptersDownloaded: 0 });
});


it("filters complete and local tags without including empty or non-library works", async () => {
  sqlite.exec("UPDATE novel SET plugin_id='local',is_local=1 WHERE id=3");
  expect((await listLibraryNovels({ completedOnly: true, sortOrder: "nameAsc" })).map((row) => row.id)).toEqual([1, 3]);
  expect((await listLibraryNovels({ localOnly: true })).map((row) => row.id)).toEqual([3]);
  expect((await listLibraryNovels({ localOnly: true, unreadOnly: true }))).toEqual([]);
  const summary = await getLibraryNovelSummary({});
  expect(summary.localNovels).toBe(1);
  expect(summary.completeNovels).toBe(2);
  expect(summary.downloadedNovels).toBe(5);
  expect((await listLibraryNovels({ downloadedOnly: true }))).toHaveLength(summary.downloadedNovels);
});

it("combines tag, category, source and search filters across pages and refresh targets", async () => {
  sqlite.exec("INSERT INTO category(id,name,sort) VALUES(1,'Shelf',0); INSERT INTO novel_category(novel_id,category_id) VALUES(1,1),(3,1),(4,1)");
  const filter = { completedOnly: true, categoryId: 1, search: "alpha", sourceId: "source" };
  const first = await listLibraryNovelPage({ ...filter, limit: 1, sortOrder: "nameAsc" });
  expect(first.novels.map((row) => row.id)).toEqual([1]);
  expect(first.hasMore).toBe(true);
  const second = await listLibraryNovelPage({ ...filter, cursor: first.nextCursor, limit: 1, sortOrder: "nameAsc" });
  expect(second.novels.map((row) => row.id)).toEqual([3]);
  expect(second.hasMore).toBe(false);
  expect((await getLibraryNovelSummary(filter)).totalNovels).toBe(2);
  expect((await listLibraryNovelRefreshTargets(filter)).map((row) => row.id).sort()).toEqual([1, 3]);
});
