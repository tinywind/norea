import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type Database from "@tauri-apps/plugin-sql";
import { afterEach, beforeEach, expect, it } from "vitest";
import { getChapterComposition, materializeChapterComposition, setChapterComposition } from "./chapter-composition";
import type { ChapterCompositionV1 } from "../lib/chapter-composition";

let sqlite: DatabaseSync;
let db: Database;
function fixture(): ChapterCompositionV1 {
  return { version: 1, updatedAt: 20, entries: [1, 2, 3].map(number => ({
    id: "entry-" + number, path: "/chapter/" + number, storageChapterNumber: String(number),
    sources: [{ pluginId: "source", novelId: "book", novelPath: "/book", chapterPath: "/raw/" + number,
      chapterNumber: String(number + 10), name: "Source " + number, position: number,
      page: "3", contentType: "text", releaseTime: null }],
    primarySource: 0,
    user: { included: number !== 3, order: number === 3 ? 0 : 3 - number, name: number === 2 ? "My opening" : null,
      chapterNumber: number === 3 ? null : String(3 - number) },
  })) };
}
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const registration = readFileSync("src-tauri/src/database.rs", "utf8");
  for (const match of registration.matchAll(/version:\s*(\d+),\s*description:[\s\S]*?sql:\s*include_str!\("([^"]+)"\)/g)) {
    sqlite.exec(readFileSync("src-tauri/src/" + match[2], "utf8"));
  }
  db = {
    select: async (query: string, params: unknown[] = []) => sqlite.prepare(query).all(Object.fromEntries(params.map((value, i) => ["$" + (i + 1), value])) as never),
    execute: async (query: string, params: unknown[] = []) => {
      const result = sqlite.prepare(query).run(Object.fromEntries(params.map((value, i) => ["$" + (i + 1), value])) as never);
      return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
  } as Database;
  sqlite.exec("INSERT INTO novel(id,plugin_id,source_novel_id,path,name) VALUES(1,'source','book','/book','Book')");
  sqlite.exec("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position,progress,bookmark,unread,is_downloaded,stored_content_type,content_bytes,media_bytes) " +
    "VALUES(11,1,'/chapter/1','Old 1','1',1,67,1,0,1,'html',123,45),(13,1,'/chapter/3','Old 3','3',3,92,1,0,1,'html',333,7)");
});
afterEach(() => sqlite.close());

it("materializes exact final order while preserving downloaded content, row IDs and reading state", async () => {
  await materializeChapterComposition(db, 1, fixture());
  await setChapterComposition(db, 1, fixture());
  expect(await getChapterComposition(db, 1)).toEqual(fixture());
  const rows = sqlite.prepare("SELECT id,path,name,chapter_number,position,progress,bookmark,unread,is_downloaded,stored_content_type,content_bytes,media_bytes FROM chapter ORDER BY position").all();
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ path: "/chapter/2", name: "My opening", chapter_number: "2", position: 1 });
  expect(rows[1]).toEqual({ id: 11, path: "/chapter/1", name: "Source 1", chapter_number: "1", position: 2,
    progress: 67, bookmark: 1, unread: 0, is_downloaded: 1, stored_content_type: "html", content_bytes: 123, media_bytes: 45 });
  expect(sqlite.prepare("SELECT progress,bookmark,unread FROM work_metadata_reading_state WHERE chapter_path='/chapter/3'").get())
    .toEqual({ progress: 92, bookmark: 1, unread: 0 });
});

it("restores saved reading state when an excluded entry is included again", async () => {
  await materializeChapterComposition(db, 1, fixture());
  const next = fixture();
  next.entries[2]!.user = { included: true, order: 3, name: null, chapterNumber: "3" };
  await materializeChapterComposition(db, 1, next);
  expect(sqlite.prepare("SELECT progress,bookmark,unread FROM chapter WHERE path='/chapter/3'").get())
    .toEqual({ progress: 92, bookmark: 1, unread: 0 });
});

it("refuses to repoint a retained chapter at another physical storage number", async () => {
  const next = fixture(); next.entries[0]!.storageChapterNumber = "50";
  await expect(materializeChapterComposition(db, 1, next)).rejects.toThrow(/storage chapter number cannot change/);
  expect(sqlite.prepare("SELECT count(*) AS count FROM chapter").get()).toEqual({ count: 2 });
});

it("marks novel.json dirty for composition-only edits and rolls the entire edit back atomically", async () => {
  await setChapterComposition(db, 1, fixture());
  sqlite.exec("DELETE FROM work_metadata_dirty; BEGIN");
  const next = fixture(); next.updatedAt++; next.entries[0]!.sources[0]!.name = "New raw title";
  await materializeChapterComposition(db, 1, next);
  await setChapterComposition(db, 1, next);
  expect(sqlite.prepare("SELECT * FROM work_metadata_dirty").all()).toEqual([{ plugin_id: "source", path: "/book" }]);
  sqlite.exec("ROLLBACK");
  expect(await getChapterComposition(db, 1)).toEqual(fixture());
  expect(sqlite.prepare("SELECT name FROM chapter WHERE id=11").get()).toEqual({ name: "Old 1" });
  sqlite.exec("DELETE FROM novel WHERE id=1");
  expect(await getChapterComposition(db, 1)).toBeNull();
});


it("inherits target-origin reading state and automatic exclusions without adopting the replaced edition's download", async () => {
  sqlite.exec("UPDATE chapter SET read_at=80 WHERE id=11; INSERT INTO chapter_download_goal_exclusion VALUES(11,123)");
  sqlite.exec("INSERT INTO work_metadata_reading_state(plugin_id,novel_path,chapter_path,progress,bookmark,unread,read_at) VALUES('source','/book','/chapter/1',84,0,1,100) ON CONFLICT(plugin_id,novel_path,chapter_path) DO UPDATE SET progress=84,bookmark=0,unread=1,read_at=100");
  const next = fixture();
  const original = next.entries[0]!;
  const targetOrigin = { ...original.sources[0]!, novelPath: "/book-redirect", chapterPath: original.path };
  original.sources = [targetOrigin];
  original.user = { included: false, order: 0, name: null, chapterNumber: null };
  next.entries.push({ id: "replacement", path: "norea-composed:replacement", storageChapterNumber: "4",
    sources: [{ ...targetOrigin, pluginId: "other", novelId: "other-book", novelPath: "/other", chapterPath: "/a/1" }, targetOrigin],
    primarySource: 0, user: { included: true, order: 2, name: null, chapterNumber: "2" } });
  await materializeChapterComposition(db, 1, next);
  expect(sqlite.prepare("SELECT c.progress,c.bookmark,c.unread,c.read_at,c.is_downloaded,c.stored_content_type,c.content_bytes,c.media_bytes,e.created_at FROM chapter c LEFT JOIN chapter_download_goal_exclusion e ON e.chapter_id=c.id WHERE c.path='norea-composed:replacement'").get())
    .toEqual({ progress: 84, bookmark: 1, unread: 0, read_at: 100, is_downloaded: 0, stored_content_type: null, content_bytes: 0, media_bytes: 0, created_at: 123 });
  expect(sqlite.prepare("SELECT id FROM chapter WHERE path='/chapter/1'").get()).toBeUndefined();
});

it("follows prior composition origins across synthetic paths and merges all inherited reading states", async () => {
  sqlite.exec("UPDATE chapter SET path='norea-composed:previous',read_at=80 WHERE id=11; UPDATE chapter SET read_at=120 WHERE id=13");
  sqlite.exec("INSERT INTO chapter_download_goal_exclusion VALUES(11,200),(13,123)");
  const previous = fixture();
  previous.entries[0]!.path = "norea-composed:previous";
  previous.entries[2]!.user = { included: true, order: 3, name: null, chapterNumber: "3" };
  for (const entry of [previous.entries[0]!, previous.entries[2]!]) {
    entry.sources[0] = { ...entry.sources[0]!, pluginId: "other", novelId: "other-book", novelPath: "/other" };
  }
  await setChapterComposition(db, 1, previous);
  const next = structuredClone(previous); next.updatedAt++;
  for (const entry of [next.entries[0]!, next.entries[2]!]) {
    entry.user = { included: false, order: 0, name: null, chapterNumber: null };
  }
  next.entries.push({ id: "replacement", path: "norea-composed:replacement", storageChapterNumber: "4",
    sources: [previous.entries[0]!.sources[0]!, previous.entries[2]!.sources[0]!].map(source => ({ ...source, novelPath: "/other-redirect" })), primarySource: 0,
    user: { included: true, order: 2, name: null, chapterNumber: "2" } });
  await materializeChapterComposition(db, 1, next);
  expect(sqlite.prepare("SELECT c.progress,c.bookmark,c.unread,c.read_at,c.is_downloaded,c.content_bytes,e.created_at FROM chapter c LEFT JOIN chapter_download_goal_exclusion e ON e.chapter_id=c.id WHERE c.path='norea-composed:replacement'").get())
    .toEqual({ progress: 92, bookmark: 1, unread: 0, read_at: 120, is_downloaded: 0, content_bytes: 0, created_at: 123 });
});

it("recovers a removed target-origin reading journal but never matches a different work by chapter path alone", async () => {
  sqlite.exec("DELETE FROM chapter WHERE id=13");
  const next = fixture();
  next.entries[2]!.sources[0]!.chapterPath = "/chapter/3";
  next.entries.push({ id: "replacement", path: "norea-composed:replacement", storageChapterNumber: "4",
    sources: [next.entries[2]!.sources[0]!], primarySource: 0,
    user: { included: true, order: 3, name: null, chapterNumber: "3" } });
  next.entries.push({ id: "unrelated", path: "norea-composed:unrelated", storageChapterNumber: "5",
    sources: [{ ...next.entries[2]!.sources[0]!, novelId: "different-book" }], primarySource: 0,
    user: { included: true, order: 4, name: null, chapterNumber: "4" } });
  await materializeChapterComposition(db, 1, next);
  expect(sqlite.prepare("SELECT path,progress,bookmark,unread FROM chapter WHERE path LIKE 'norea-composed:%' ORDER BY position").all())
    .toEqual([{ path: "norea-composed:replacement", progress: 92, bookmark: 1, unread: 0 },
      { path: "norea-composed:unrelated", progress: 0, bookmark: 0, unread: 1 }]);
});

it("does not restore ancestor state over a retained row's explicit unread reset", async () => {
  sqlite.exec("UPDATE chapter SET progress=0,bookmark=0,unread=1,read_at=NULL WHERE id=11");
  sqlite.exec("INSERT INTO work_metadata_reading_state(plugin_id,novel_path,chapter_path,progress,bookmark,unread,read_at) VALUES('source','/book','/chapter/1',99,1,0,100) ON CONFLICT(plugin_id,novel_path,chapter_path) DO UPDATE SET progress=99,bookmark=1,unread=0,read_at=100");
  const next = fixture(); next.entries[0]!.sources[0]!.chapterPath = "/chapter/3";
  await materializeChapterComposition(db, 1, next);
  expect(sqlite.prepare("SELECT progress,bookmark,unread,read_at FROM chapter WHERE id=11").get())
    .toEqual({ progress: 0, bookmark: 0, unread: 1, read_at: null });
});


it("removes unlisted recipient chapters and queued downloads while retaining their reading state", async () => {
  sqlite.exec("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position,progress,bookmark,unread,read_at,is_downloaded,content_bytes) " +
    "VALUES(19,1,'/recipient-only','Recipient only','99',4,88,1,0,123,1,456)");
  sqlite.exec("INSERT INTO novel(id,plugin_id,source_novel_id,path,name) VALUES(2,'source','other','/other','Other')");
  sqlite.exec("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position) VALUES(21,2,'/recipient-only','Other chapter','99',1)");
  sqlite.exec("INSERT INTO chapter_download_queue(chapter_id,job_json,created_at_ms,updated_at_ms) " +
    "VALUES(11,'{}',1,1),(13,'{}',1,1),(19,'{}',1,1),(21,'{}',1,1)");

  await materializeChapterComposition(db, 1, fixture());
  expect(sqlite.prepare("SELECT path FROM chapter WHERE novel_id=1 ORDER BY position").all())
    .toEqual([{ path: "/chapter/2" }, { path: "/chapter/1" }]);
  expect(sqlite.prepare("SELECT chapter_id FROM chapter_download_queue ORDER BY chapter_id").all())
    .toEqual([{ chapter_id: 11 }, { chapter_id: 21 }]);
  expect(sqlite.prepare("SELECT progress,bookmark,unread,read_at FROM work_metadata_reading_state WHERE novel_path='/book' AND chapter_path='/recipient-only'").get())
    .toEqual({ progress: 88, bookmark: 1, unread: 0, read_at: 123 });
  expect(sqlite.prepare("SELECT path FROM chapter WHERE id=21").get()).toEqual({ path: "/recipient-only" });

  const next = fixture();
  next.entries.push({ ...structuredClone(next.entries[0]!), id: "recipient", path: "/recipient-only", storageChapterNumber: "99",
    user: { included: true, order: 3, name: "Retained chapter", chapterNumber: "3" } });
  await materializeChapterComposition(db, 1, next);
  expect(sqlite.prepare("SELECT progress,bookmark,unread,read_at FROM chapter WHERE novel_id=1 AND path='/recipient-only'").get())
    .toEqual({ progress: 88, bookmark: 1, unread: 0, read_at: 123 });
});


it.each(["99", "099.0"])("rejects another recipient chapter's storage number %s without changing rows or queues", async number => {
  await materializeChapterComposition(db, 1, fixture());
  await setChapterComposition(db, 1, fixture());
  sqlite.prepare("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position,progress,bookmark,unread,read_at,is_downloaded,content_bytes) " +
    "VALUES(19,1,'/recipient-only','Recipient only',?,3,88,1,0,123,1,456)").run(number);
  sqlite.exec("INSERT INTO chapter_download_queue(chapter_id,job_json,created_at_ms,updated_at_ms) VALUES(19,'{}',1,1)");
  const before = sqlite.prepare("SELECT * FROM chapter ORDER BY id").all();
  const incoming = fixture();
  incoming.updatedAt++;
  incoming.entries.push({ ...structuredClone(incoming.entries[0]!), id: "replacement", path: "norea-composed:replacement", storageChapterNumber: "99",
    user: { included: true, order: 3, name: "Different source", chapterNumber: "3" } });
  sqlite.exec("BEGIN");
  await expect(materializeChapterComposition(db, 1, incoming)).rejects.toThrow(/storage chapter number belongs to another chapter/);
  sqlite.exec("ROLLBACK");
  expect(sqlite.prepare("SELECT * FROM chapter ORDER BY id").all()).toEqual(before);
  expect(await getChapterComposition(db, 1)).toEqual(fixture());
  expect(sqlite.prepare("SELECT chapter_id FROM chapter_download_queue").all()).toEqual([{ chapter_id: 19 }]);
});

it("keeps excluded entries' storage numbers reserved after their chapter rows are removed", async () => {
  await materializeChapterComposition(db, 1, fixture());
  await setChapterComposition(db, 1, fixture());
  const incoming = fixture();
  incoming.updatedAt++;
  incoming.entries = incoming.entries.filter(entry => entry.user.included);
  incoming.entries.push({ ...structuredClone(incoming.entries[0]!), id: "replacement", path: "norea-composed:replacement", storageChapterNumber: "3",
    user: { included: true, order: 3, name: "Different source", chapterNumber: "3" } });
  await expect(materializeChapterComposition(db, 1, incoming)).rejects.toThrow(/storage chapter number belongs to another chapter/);
  expect(await getChapterComposition(db, 1)).toEqual(fixture());
  expect(sqlite.prepare("SELECT path FROM chapter ORDER BY position").all()).toEqual([{ path: "/chapter/2" }, { path: "/chapter/1" }]);
});


it("binds an empty recovered catalog row to its verified provider origin without losing its ID or reading state", async () => {
  sqlite.exec("UPDATE chapter SET path='norea-folder:1',is_downloaded=0,content_bytes=0,media_bytes=0 WHERE id=11");
  const next = fixture();
  next.entries[0]!.sources[0] = { ...next.entries[0]!.sources[0]!, chapterPath: '/chapter/1', chapterNumber: '1' };
  await materializeChapterComposition(db, 1, next);
  expect(sqlite.prepare("SELECT id,path,progress,bookmark FROM chapter WHERE id=11").get())
    .toEqual({ id: 11, path: '/chapter/1', progress: 67, bookmark: 1 });
});

it("keeps a recovered row with downloaded content protected from alias adoption", async () => {
  sqlite.exec("UPDATE chapter SET path='norea-folder:1' WHERE id=11");
  const next = fixture();
  next.entries[0]!.sources[0] = { ...next.entries[0]!.sources[0]!, chapterPath: '/chapter/1', chapterNumber: '1' };
  await expect(materializeChapterComposition(db, 1, next)).rejects.toThrow(/belongs to another chapter/);
  expect(sqlite.prepare("SELECT path FROM chapter WHERE id=11").get()).toEqual({ path: 'norea-folder:1' });
});

it.each(["foreign source", "ambiguous number"])("rejects recovered alias adoption with %s", async kind => {
  sqlite.exec("UPDATE chapter SET path='norea-folder:1',is_downloaded=0,content_bytes=0,media_bytes=0 WHERE id=11");
  const next = fixture();
  next.entries[0]!.sources[0] = { ...next.entries[0]!.sources[0]!, chapterPath: '/chapter/1', chapterNumber: '1' };
  if (kind === 'foreign source') next.entries[0]!.sources[0]!.novelId = 'another-book';
  else sqlite.exec("INSERT INTO chapter(novel_id,path,name,chapter_number,position) VALUES(1,'/different','Other','1',4)");
  await expect(materializeChapterComposition(db, 1, next)).rejects.toThrow(/belongs to another chapter/);
  expect(sqlite.prepare("SELECT path FROM chapter WHERE id=11").get()).toEqual({ path: 'norea-folder:1' });
});
