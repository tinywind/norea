import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ getDb: vi.fn(), runDatabaseTransaction: vi.fn() }));
import { getDb, runDatabaseTransaction } from "../client";
import { applyReadingStateBatch, listReadingStatePage } from "./reading-state";
import type { ReadingStateEntry } from "../../lib/content-sync/reading-state-model";

let sqlite: DatabaseSync;
const entry: ReadingStateEntry = { pluginId: "source", sourceNovelId: "book-1", novelPath: "/book", chapterPath: "/chapter/1",
  chapterNumber: "1", page: "1", progress: 70, unread: true, bookmark: true, readAt: 200 };

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  sqlite.exec(`INSERT INTO novel(id,plugin_id,source_novel_id,path,name,in_library,last_read_at) VALUES(1,'source','book-1','/book','Book',1,100);
    INSERT INTO chapter(id,novel_id,path,name,chapter_number,page,position,unread,progress,bookmark,read_at,is_downloaded)
    VALUES(1,1,'/chapter/1','Chapter 1','1','1',1,1,20,0,100,1),
      (2,1,'/chapter/2','Chapter 2','2','1',2,1,0,0,NULL,0)`);
  const parameters = (params: unknown[]) => Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value]));
  const db = {
    select: async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(parameters(params) as never),
    execute: async (sql: string, params: unknown[] = []) => ({ rowsAffected: Number(sqlite.prepare(sql).run(parameters(params) as never).changes) }),
  };
  vi.mocked(getDb).mockResolvedValue(db as never);
  vi.mocked(runDatabaseTransaction).mockImplementation(async run => {
    sqlite.exec("BEGIN IMMEDIATE");
    try { const result = await run(db as never); sqlite.exec("COMMIT"); return result; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  });
});
afterEach(() => sqlite.close());

it("imports history and bookmarks, refreshes counters and latest chapter, and preserves downloaded content", async () => {
  expect(await applyReadingStateBatch([{ ...entry, unread: false, progress: 100 }])).toEqual({
    updated: 1, skipped: 0, lastReadChapters: [{ novelId: 1, chapterId: 1 }],
  });
  expect(sqlite.prepare("SELECT unread,progress,bookmark,read_at,is_downloaded,name FROM chapter WHERE id=1").get()).toEqual({
    unread: 0, progress: 100, bookmark: 1, read_at: 200, is_downloaded: 1, name: "Chapter 1",
  });
  expect(sqlite.prepare("SELECT last_read_at FROM novel WHERE id=1").get()?.last_read_at).toBe(200);
  expect(sqlite.prepare("SELECT chapters_unread FROM novel_stats WHERE novel_id=1").get()?.chapters_unread).toBe(1);
  expect((await applyReadingStateBatch([{ ...entry, unread: false, progress: 100 }])).updated).toBe(0);
});

it("keeps more advanced local progress and recent history when importing an older record", async () => {
  sqlite.exec("UPDATE chapter SET unread=0,progress=100,bookmark=1,read_at=500 WHERE id=1");
  const result = await applyReadingStateBatch([{ ...entry, progress: 10, bookmark: false }]);
  expect(result.updated).toBe(0);
  expect(sqlite.prepare("SELECT unread,progress,bookmark,read_at FROM chapter WHERE id=1").get()).toEqual({ unread: 0, progress: 100, bookmark: 1, read_at: 500 });
  expect(sqlite.prepare("SELECT last_read_at FROM novel WHERE id=1").get()?.last_read_at).toBe(500);
});

it("matches a stable source ID and unique chapter number after source URLs change", async () => {
  const result = await applyReadingStateBatch([{ ...entry, sourceNovelId: "BOOK-1", novelPath: "/old-book", chapterPath: "/old-chapter" }]);
  expect(result.updated).toBe(1);
  expect(result.skipped).toBe(0);
});

it("skips other sources, conflicting stable work IDs, reused chapter URLs and ambiguous chapter numbers", async () => {
  sqlite.exec(`INSERT INTO chapter(id,novel_id,path,name,chapter_number,page,position) VALUES(3,1,'/duplicate','Duplicate','1','1',3)`);
  const result = await applyReadingStateBatch([
    { ...entry, pluginId: "other" }, { ...entry, sourceNovelId: "different" },
    { ...entry, chapterNumber: "99" }, { ...entry, chapterPath: "/old-chapter" },
  ]);
  expect(result).toEqual({ updated: 0, skipped: 4, lastReadChapters: [] });
  expect(sqlite.prepare("SELECT progress FROM chapter WHERE id=1").get()?.progress).toBe(20);
});

it("rolls back a batch if cancellation or a profile change occurs inside the queued transaction", async () => {
  let checks = 0;
  await expect(applyReadingStateBatch([entry], () => { if (++checks === 3) throw new Error("Profile changed"); })).rejects.toThrow("Profile changed");
  expect(sqlite.prepare("SELECT progress FROM chapter WHERE id=1").get()?.progress).toBe(20);
});

it("exports distinct paths when multiple local chapters share the same source number and page", async () => {
  sqlite.exec(`INSERT INTO chapter(id,novel_id,path,name,chapter_number,page,position,progress)
    VALUES(3,1,'/duplicate','Duplicate','1','1',3,10)`);
  const page = await listReadingStatePage();
  expect(page.entries.map(item => [item.chapterPath, item.chapterNumber])).toEqual([
    ["/chapter/1", null], ["/duplicate", null],
  ]);
});

it("exports only meaningful personal state in bounded pages without content or local IDs", async () => {
  const page = await listReadingStatePage();
  expect(page).toEqual({ entries: [{ ...entry, progress: 20, bookmark: false, readAt: 100 }], nextId: null });
  const insert = sqlite.prepare("INSERT INTO chapter(novel_id,path,name,position,progress) VALUES(1,?,?,?,1)");
  for (let index = 3; index < 205; index += 1) insert.run(`/chapter/${index}`, `Chapter ${index}`, index);
  const first = await listReadingStatePage();
  expect(first.entries).toHaveLength(200);
  expect(first.nextId).not.toBeNull();
  const second = await listReadingStatePage(first.nextId!);
  expect(second.entries).toHaveLength(3);
  expect(second.nextId).toBeNull();
});
