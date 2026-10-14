import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type Database from "@tauri-apps/plugin-sql";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ getDb: vi.fn(), transaction: vi.fn() }));
vi.mock("../db/client", () => ({ getDb: client.getDb, runDatabaseTransaction: client.transaction }));
vi.mock("../db/queries/novel-identity", () => ({ reconcileImportedNovelIdentityInDb: vi.fn(async () => null), findMatchingNovelIdentityInDb: vi.fn(async () => null) }));
vi.mock("./local-import-media", () => ({ cacheLocalImportedChapterMedia: vi.fn() }));
import { importLocalFileToLibrary } from "./local-import-library";
import { importSystemOpenedFile } from "./system-file-import";
import { cacheLocalImportedChapterMedia } from "./local-import-media";

let sqlite: DatabaseSync;
let queue: Promise<unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  const bind = (params: unknown[]) => Object.fromEntries(params.map((value, i) => [`$${i + 1}`, value]));
  const db = {
    select: async (query: string, params: unknown[] = []) => sqlite.prepare(query).all(bind(params) as never),
    execute: async (query: string, params: unknown[] = []) => {
      const result = sqlite.prepare(query).run(bind(params) as never);
      return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
  } as Database;
  queue = Promise.resolve();
  client.getDb.mockResolvedValue(db);
  client.transaction.mockImplementation((run: (db: Database) => Promise<unknown>) => {
    const result = queue.then(async () => {
      sqlite.exec("BEGIN IMMEDIATE");
      try { const value = await run(db); sqlite.exec("COMMIT"); return value; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    });
    queue = result.catch(() => undefined);
    return result;
  });
});
afterEach(() => sqlite.close());

it("puts files from library and system open in one local work and selects the opened file", async () => {
  await importLocalFileToLibrary(new File(["First body"], "First.txt"));
  const opened = await importSystemOpenedFile(new File(["# Second body"], "Second.md"));
  expect(sqlite.prepare("SELECT plugin_id,path,name FROM novel").all()).toEqual([{ plugin_id: "local", path: "local", name: "local" }]);
  const chapters = sqlite.prepare("SELECT id,novel_id,name,position,chapter_number FROM chapter ORDER BY position").all();
  expect(chapters).toEqual([
    { id: expect.any(Number), novel_id: opened.novelId, name: "First", position: 1, chapter_number: "1" },
    { id: opened.chapterId, novel_id: opened.novelId, name: "Second", position: 2, chapter_number: "2" },
  ]);
  expect(cacheLocalImportedChapterMedia).toHaveBeenLastCalledWith(expect.objectContaining({ novelName: "local", novelPath: "local" }));
});

it("reopens the same file without duplicating it, changing its order or resetting reading state", async () => {
  const first = await importSystemOpenedFile(new File(["First body"], "First.txt"));
  await importSystemOpenedFile(new File(["Second body"], "Second.txt"));
  sqlite.prepare("UPDATE chapter SET progress=43,bookmark=1,unread=0,read_at=123 WHERE id=?").run(first.chapterId);
  expect(await importSystemOpenedFile(new File(["First body"], "First.txt"))).toEqual(first);
  expect(sqlite.prepare("SELECT COUNT(*) AS total FROM chapter").get()).toEqual({ total: 2 });
  expect(sqlite.prepare("SELECT position,chapter_number,progress,bookmark,unread,read_at FROM chapter WHERE id=?").get(first.chapterId)).toEqual({ position: 1, chapter_number: "1", progress: 43, bookmark: 1, unread: 0, read_at: 123 });
});

it("allocates distinct positions when two entry points import together", async () => {
  const results = await Promise.all([
    importSystemOpenedFile(new File(["First body"], "First.txt")),
    importSystemOpenedFile(new File(["Second body"], "Second.md")),
  ]);
  expect(results[0].novelId).toBe(results[1].novelId);
  expect(results[0].chapterId).not.toBe(results[1].chapterId);
  expect(sqlite.prepare("SELECT position FROM chapter ORDER BY position").all()).toEqual([{ position: 1 }, { position: 2 }]);
});

it("keeps local home metadata when another file is added", async () => {
  const first = await importSystemOpenedFile(new File(["First body"], "First.txt"));
  sqlite.prepare("UPDATE novel SET summary='My local files',author='Owner' WHERE id=?").run(first.novelId);
  await importLocalFileToLibrary(new File(["Another body"], "Another.txt"));
  expect(sqlite.prepare("SELECT name,summary,author FROM novel WHERE id=?").get(first.novelId)).toEqual({ name: "local", summary: "My local files", author: "Owner" });
});
