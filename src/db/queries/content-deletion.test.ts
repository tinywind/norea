import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ getDb: vi.fn(), runDatabaseTransaction: vi.fn() }));
import { getDb, runDatabaseTransaction } from "../client";
import { deleteLocalNovelRecords, findLocalDeletionNovel } from "./content-deletion";

let sqlite: DatabaseSync;
const identity = { id: 12, pluginId: "source", sourceNovelId: "42", path: "/book" };
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  sqlite.exec("PRAGMA foreign_keys=ON");
  sqlite.exec("INSERT INTO novel(id,plugin_id,source_novel_id,path,name,in_library) VALUES(12,'source','42','/book','Book',1),(13,'other','42','/book','Other',1)");
  sqlite.exec("INSERT INTO chapter(id,novel_id,path,name,position,progress,bookmark) VALUES(91,12,'/chapter','One',1,75,1),(92,13,'/chapter','Other one',1,50,1)");
  sqlite.exec("INSERT INTO work_metadata_reading_state(plugin_id,novel_path,chapter_path,progress,bookmark,unread) VALUES('source','/book','old',50,1,0)");
  sqlite.exec("INSERT INTO content_sync_cache(cache_key,payload) VALUES('norea-content-source:12','deleted-source'),('norea-content-source:13','retained-source'),('norea-content-catalog:http://server','catalog')");
  const parameters = (values: SQLInputValue[]) => Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value]));
  const db = {
    select: async (sql: string, values: SQLInputValue[] = []) => sqlite.prepare(sql).all(parameters(values)),
    execute: async (sql: string, values: SQLInputValue[] = []) => ({ rowsAffected: Number(sqlite.prepare(sql).run(parameters(values)).changes) }),
  };
  vi.mocked(getDb).mockResolvedValue(db as never);
  vi.mocked(runDatabaseTransaction).mockImplementation(async run => {
    sqlite.exec("BEGIN");
    try { const result = await run(db as never); sqlite.exec("COMMIT"); return result; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  });
});
afterEach(() => sqlite.close());

it("matches the plugin-owned work ID within the correct plugin", async () => {
  expect(await findLocalDeletionNovel({ pluginId: "source", novelId: "42", novelPath: "/changed-route" })).toMatchObject(identity);
  expect(await findLocalDeletionNovel({ pluginId: "missing", novelId: "42", novelPath: "/book" })).toBeNull();
});

it("removes work, chapters, statistics, membership, and saved reading state without touching another plugin", async () => {
  await deleteLocalNovelRecords(identity);
  expect(sqlite.prepare("SELECT id FROM novel").all()).toEqual([{ id: 13 }]);
  expect(sqlite.prepare("SELECT id,progress,bookmark FROM chapter").all()).toEqual([{ id: 92, progress: 50, bookmark: 1 }]);
  expect(sqlite.prepare("SELECT * FROM work_metadata_reading_state WHERE plugin_id='source'").all()).toEqual([]);
  expect(sqlite.prepare("SELECT novel_id FROM novel_stats").all()).toEqual([{ novel_id: 13 }]);
  expect(sqlite.prepare("SELECT cache_key,payload FROM content_sync_cache ORDER BY cache_key").all()).toEqual([
    { cache_key: "norea-content-catalog:http://server", payload: "catalog" },
    { cache_key: "norea-content-source:13", payload: "retained-source" },
  ]);
  await expect(deleteLocalNovelRecords(identity)).resolves.toBeUndefined();
});

it("rolls back work and reading-state deletion when its source-binding cleanup fails", async () => {
  sqlite.exec("CREATE TRIGGER refuse_source_delete BEFORE DELETE ON content_sync_cache WHEN OLD.cache_key='norea-content-source:12' BEGIN SELECT RAISE(ABORT,'Source cleanup failed'); END");
  await expect(deleteLocalNovelRecords(identity)).rejects.toThrow("Source cleanup failed");
  expect(sqlite.prepare("SELECT id FROM novel WHERE id=12").get()).toEqual({ id: 12 });
  expect(sqlite.prepare("SELECT id,progress,bookmark FROM chapter WHERE id=91").get()).toEqual({ id: 91, progress: 75, bookmark: 1 });
  expect(sqlite.prepare("SELECT progress FROM work_metadata_reading_state WHERE plugin_id='source'").get()).toEqual({ progress: 50 });
  expect(sqlite.prepare("SELECT payload FROM content_sync_cache WHERE cache_key='norea-content-source:12'").get()).toEqual({ payload: "deleted-source" });
});

it("preserves a work whose identity changed while the confirmation was open", async () => {
  sqlite.exec("UPDATE novel SET source_novel_id='different' WHERE id=12");
  await expect(deleteLocalNovelRecords(identity)).rejects.toThrow("identity changed");
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter").get()).toEqual({ count: 2 });
});
