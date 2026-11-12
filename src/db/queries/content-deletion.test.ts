import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ getDb: vi.fn(), runDatabaseTransaction: vi.fn() }));
import { getDb, runDatabaseTransaction } from "../client";
import { userStateEntityKey } from "../../lib/user-state/types";
import { deleteLocalNovelRecords, findLocalDeletionNovel, listDeletionDownloadedChapterIds, clearNovelDownloadFiles } from "./content-deletion";

let sqlite: DatabaseSync;
const identity = { id: 12, pluginId: "source", sourceNovelId: "42", path: "/book" };
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  sqlite.exec("PRAGMA foreign_keys=ON");
  sqlite.exec("INSERT INTO novel(id,plugin_id,source_novel_id,path,name,in_library) VALUES(12,'source','42','/book','Book',1),(13,'other','42','/book','Other',1)");
  sqlite.exec("INSERT INTO chapter(id,novel_id,path,name,position,progress,bookmark) VALUES(91,12,'/chapter','One',1,75,1),(92,13,'/chapter','Other one',1,50,1)");
  sqlite.exec("INSERT INTO work_metadata_reading_state(plugin_id,novel_path,chapter_path,progress,bookmark,unread) VALUES('source','/book','old',50,1,0)");
  sqlite.exec("INSERT INTO content_sync_cache(cache_key,payload) VALUES('norea-content-source:12','deleted-source'),('norea-content-source:13','retained-source'),('norea-content-chapter-source:91','removed-proof'),('norea-content-chapter-source:92','retained-proof'),('norea-content-catalog:http://server','catalog')");
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
    { cache_key: "norea-content-chapter-source:92", payload: "retained-proof" },
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

it("lists the stored chapters a device download deletion removes, skipping local works", async () => {
  sqlite.exec("INSERT INTO novel(id,plugin_id,path,name,is_local) VALUES(14,'local','/local','Local',1)");
  sqlite.exec(`INSERT INTO chapter(id,novel_id,path,name,position,is_downloaded,content_bytes,media_repair_needed) VALUES
    (93,12,'/downloaded','Downloaded',2,1,10,0),(94,12,'/partial','Partial',3,0,5,0),(95,12,'/repair','Repair',4,0,0,1),
    (96,12,'/missing','Missing',5,0,0,0),(97,13,'/other','Other',2,1,10,0),(98,14,'/local','Local',1,1,10,0)`);
  expect(await listDeletionDownloadedChapterIds([12])).toEqual([93, 94, 95]);
  expect(await listDeletionDownloadedChapterIds([12, 13, 14])).toEqual([93, 94, 95, 97]);
  expect(await listDeletionDownloadedChapterIds()).toEqual([93, 94, 95, 97]);
  expect(await listDeletionDownloadedChapterIds([])).toEqual([]);
});

it("records library, category, resume, and public chapter user-state removals when requested", async () => {
  const registration = readFileSync("src-tauri/src/database.rs", "utf8");
  for (const match of registration.matchAll(/version:\s*(\d+),\s*description:[\s\S]*?sql:\s*include_str!\("([^"]+)"\)/g)) {
    if (Number(match[1]) > 1) sqlite.exec(readFileSync(`src-tauri/src/${match[2]}`, "utf8"));
  }
  sqlite.exec(`INSERT INTO category(id,name,sort,is_system) VALUES(5,'Shelf',1,0);
    INSERT INTO novel_category(novel_id,category_id) VALUES(12,5);
    UPDATE novel SET last_read_at=100 WHERE id=12;
    UPDATE chapter SET unread=0,read_at=100 WHERE id=91;
    INSERT INTO chapter(id,novel_id,path,name,position,progress,unread,read_at,bookmark)
    VALUES(99,12,'/private','Private',2,80,0,120,0)`);
  const privateKey = userStateEntityKey({
    kind: "reading",
    work: { pluginId: "source", sourceNovelId: "42", novelPath: "/book", name: "Book" },
    chapter: { chapterPath: "/private", name: "Private" },
  });
  sqlite.prepare("INSERT INTO user_state_private(entity_key,public_value_json) VALUES(?,?)")
    .run(privateKey, '{"progress":0,"unread":true,"readAt":null}');

  await deleteLocalNovelRecords(identity, { recordUserStateRemoval: true });

  const intents = sqlite.prepare("SELECT entity_json AS entity,value_json AS value FROM user_state_intent ORDER BY sequence").all()
    .map(row => ({ entity: JSON.parse(String(row.entity)), value: JSON.parse(String(row.value)) }));
  expect(intents).toEqual([
    {
      entity: expect.objectContaining({ kind: "membership", work: expect.objectContaining({ pluginId: "source", sourceNovelId: "42" }) }),
      value: { included: false },
    },
    {
      entity: { kind: "library", work: { name: "Book", novelPath: "/book", pluginId: "source", sourceNovelId: "42" } },
      value: { addedAt: null, inLibrary: false },
    },
    {
      entity: { kind: "resume", work: { name: "Book", novelPath: "/book", pluginId: "source", sourceNovelId: "42" } },
      value: { anchor: null, chapter: null, openedAt: null },
    },
    {
      entity: { chapter: { chapterPath: "/chapter", name: "One" }, kind: "reading", work: { name: "Book", novelPath: "/book", pluginId: "source", sourceNovelId: "42" } },
      value: { progress: 0, readAt: null, unread: true },
    },
    {
      entity: { chapter: { chapterPath: "/chapter", name: "One" }, kind: "bookmark", work: { name: "Book", novelPath: "/book", pluginId: "source", sourceNovelId: "42" } },
      value: { bookmarked: false },
    },
  ]);
});


it("clears 1500 chapter downloads after one folder removal while preserving reading state", async () => {
  for (let index = 0; index < 1500; index++) sqlite.prepare("INSERT INTO chapter(novel_id,path,name,position,is_downloaded,content_bytes) VALUES(12,?,?,?,1,100)").run(`/bulk/${index}`, "Chapter", index + 2);
  sqlite.exec("INSERT INTO work_metadata_file_cache VALUES('source','/book',12,'contents/source/42','fingerprint'); INSERT INTO work_metadata_directory_cache VALUES(91,12,'contents/source/42/1')");
  const remove = vi.fn(async () => {
    expect(sqlite.isTransaction).toBe(false);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter WHERE is_downloaded=1").get()).toEqual({ count: 1500 });
  });
  await clearNovelDownloadFiles(identity, remove);
  expect(remove).toHaveBeenCalledOnce();
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter WHERE is_downloaded=1 OR content_bytes>0").get()).toEqual({ count: 0 });
  expect(sqlite.prepare("SELECT progress,bookmark FROM chapter WHERE id=91").get()).toEqual({ progress: 75, bookmark: 1 });
  expect(sqlite.prepare("SELECT progress,bookmark FROM chapter WHERE id=92").get()).toEqual({ progress: 50, bookmark: 1 });
  expect(sqlite.prepare("SELECT * FROM work_metadata_file_cache").all()).toEqual([]);
  expect(sqlite.prepare("SELECT * FROM work_metadata_directory_cache").all()).toEqual([]);
  expect(sqlite.prepare("SELECT * FROM work_metadata_dirty WHERE plugin_id='source'").all()).toEqual([]);
  expect(sqlite.prepare("SELECT progress FROM work_metadata_reading_state WHERE plugin_id='source'").get()).toEqual({ progress: 50 });
});

it("keeps download records when folder removal fails and allows a retry", async () => {
  sqlite.exec("UPDATE chapter SET is_downloaded=1,content_bytes=100 WHERE id=91");
  await expect(clearNovelDownloadFiles(identity, async () => { throw new Error("Cannot remove folder"); })).rejects.toThrow("Cannot remove folder");
  expect(sqlite.prepare("SELECT is_downloaded FROM chapter WHERE id=91").get()).toEqual({ is_downloaded: 1 });
  await clearNovelDownloadFiles(identity, async () => undefined);
  expect(sqlite.prepare("SELECT is_downloaded FROM chapter WHERE id=91").get()).toEqual({ is_downloaded: 0 });
});

it("refuses folder removal when the work identity has changed", async () => {
  sqlite.exec("UPDATE novel SET source_novel_id='changed' WHERE id=12");
  const remove = vi.fn();
  await expect(clearNovelDownloadFiles(identity, remove)).rejects.toThrow("identity changed");
  expect(remove).not.toHaveBeenCalled();
});
