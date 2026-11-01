import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getDb, getReadOnlyDb } from "../client";
import { listChapterCleanupCandidates, reconcileCleanedChapter } from "./chapter-cleanup";
import { clearServerChapterDownloadProof, rememberServerChapterDownload } from "./content-sync";

vi.mock("../client", () => ({ getDb: vi.fn(), getReadOnlyDb: vi.fn() }));
let sqlite: DatabaseSync;
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  sqlite.exec(`INSERT INTO novel(id,plugin_id,source_novel_id,path,name,in_library,is_local) VALUES
    (1,'test','one','/one','One',1,0),(2,'test','two','/two','Two',1,0),
    (3,'test','three','/three','Three',0,0),(4,'local','four','/four','Import',1,1),
    (5,'local','five','/five','Server',1,1);
    INSERT INTO chapter(id,novel_id,path,name,position,chapter_number,unread,content_bytes,is_downloaded) VALUES
    (1,1,'/1','Read partial',1,'1',0,25,0),(2,1,'/2','Unread',2,'2',1,30,1),
    (3,2,'/3','Uncategorized',1,'1',0,40,1),(4,3,'/4','Outside',1,'1',0,50,1),
    (5,4,'/5','Original',1,'1',0,60,1),(6,5,'/6','Server',1,'1',0,70,1);
    INSERT INTO category(id,name,sort) VALUES (10,'A',10),(11,'B',11);
    INSERT INTO novel_category(novel_id,category_id) VALUES (1,10),(1,11);
    INSERT INTO content_sync_cache(cache_key,payload) VALUES ('norea-content-source:5','{"serverUrl":"https://example.com","workId":"five"}'),
    ('norea-content-chapter-source:6','{"chapterId":6,"novelId":5,"pluginId":"local","sourceNovelId":"five","novelPath":"/five","chapterPath":"/6","chapterNumber":"1","position":1,"serverUrl":"https://example.com","fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}');`);
  const db = {
    select: async (sql: string, values: unknown[] = []) => sqlite.prepare(sql).all(Object.fromEntries(values.map((value,i)=>[String(i+1),value])) as never),
    execute: async (sql: string, values: unknown[] = []) => ({ rowsAffected: Number(sqlite.prepare(sql).run(Object.fromEntries(values.map((value,i)=>[String(i+1),value])) as never).changes) }),
  };
  vi.mocked(getDb).mockResolvedValue(db as never);
  vi.mocked(getReadOnlyDb).mockResolvedValue(db as never);
});
afterEach(() => sqlite.close());
it("combines read/category conditions and deduplicates overlapping categories", async () => {
  const rows = await listChapterCleanupCandidates({ reading: "read", categories: { mode: "selected", ids: [10,11] } });
  expect(rows.map(row=>row.identity.chapter.id)).toEqual([1]);
});
it("includes partial and server-origin downloads but excludes imported originals", async () => {
  const rows = await listChapterCleanupCandidates({ reading: "all", categories: { mode: "all" } });
  expect(rows.map(row=>row.identity.chapter.id)).toEqual([1,2,3,4,6]);
});
it("keeps non-library works outside uncategorized and selected empty matches none", async () => {
  expect((await listChapterCleanupCandidates({ reading: "read", categories: { mode: "selected", ids: [-1] } })).map(row=>row.identity.chapter.id)).toEqual([3,6]);
  expect(await listChapterCleanupCandidates({ reading: "all", categories: { mode: "selected", ids: [] } })).toEqual([]);
});
it("uses a stable cursor and supports a queued per-ID eligibility recheck", async () => {
  const filters = { reading: "all", categories: { mode: "all" } } as const;
  expect((await listChapterCleanupCandidates(filters, { afterId: 2, limit: 2 })).map(row=>row.identity.chapter.id)).toEqual([3,4]);
  sqlite.exec("UPDATE chapter SET unread=1 WHERE id=1");
  expect(await listChapterCleanupCandidates({ ...filters, reading: "read" }, { chapterId: 1, readMode: "queued" })).toEqual([]);
});

it("reconciles partial payloads without changing reading state or catalog metadata, including null source IDs", async () => {
  sqlite.exec(`UPDATE novel SET source_novel_id=NULL,cover='cover.jpg',last_read_at=123 WHERE id=1;
    UPDATE chapter SET bookmark=1,progress=42,page='7',read_at=123,media_bytes=20,media_repair_needed=1 WHERE id=1;
    INSERT INTO work_metadata_reading_state(plugin_id,novel_path,chapter_path,progress,bookmark,unread,read_at)
      VALUES ('test','/one','/1',42,1,0,123)`);
  const [candidate] = await listChapterCleanupCandidates({ reading: "all", categories: { mode: "all" } }, { chapterId: 1 });
  const tables = ["novel", "novel_category", "category", "work_metadata_reading_state"];
  const before = tables.map(table => sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const chapterBefore = sqlite.prepare("SELECT id,novel_id,path,name,position,chapter_number,page,bookmark,unread,progress,read_at FROM chapter WHERE id=1").get();
  expect(await reconcileCleanedChapter(candidate!, { contentBytes: 0, mediaBytes: 7, mediaComplete: false })).toBe(1);
  expect(tables.map(table => sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
  expect(sqlite.prepare("SELECT id,novel_id,path,name,position,chapter_number,page,bookmark,unread,progress,read_at FROM chapter WHERE id=1").get()).toEqual(chapterBefore);
  expect(sqlite.prepare("SELECT content_bytes,media_bytes,is_downloaded,media_repair_needed FROM chapter WHERE id=1").get()).toMatchObject({ content_bytes: 0, media_bytes: 7, is_downloaded: 0, media_repair_needed: 0 });
});

it("flags shared normalized chapter directories even when the other row is unread", async () => {
  sqlite.exec("INSERT INTO chapter(id,novel_id,path,name,position,chapter_number,unread) VALUES (7,1,'/alias','Alias',7,'1.0',1)");
  const rows = await listChapterCleanupCandidates({ reading: "read", categories: { mode: "all" } });
  expect(rows.find(row => row.identity.chapter.id === 1)?.storageAmbiguous).toBe(true);
  expect(rows.find(row => row.identity.chapter.id === 3)?.storageAmbiguous).toBe(false);
  sqlite.exec("UPDATE chapter SET chapter_number=NULL,position=1 WHERE id=7");
  expect((await listChapterCleanupCandidates({ reading: "read", categories: { mode: "all" } }, { chapterId: 1, readMode: "queued" }))[0]?.storageAmbiguous).toBe(true);
  const plan = sqlite.prepare("EXPLAIN QUERY PLAN SELECT id FROM chapter INDEXED BY chapter_novel_position_idx WHERE novel_id=?").all(1) as { detail: string }[];
  expect(plan.some(row => row.detail.includes("chapter_novel_position_idx"))).toBe(true);
});

it("requires matching chapter-specific proof for local works and rejects stale or malformed records", async () => {
  const selection = { reading: "all", categories: { mode: "all" } } as const;
  sqlite.exec("INSERT INTO chapter(id,novel_id,path,name,position,chapter_number,unread) VALUES (7,5,'/original','Original',2,'2',0)");
  expect((await listChapterCleanupCandidates(selection)).map(row => row.identity.chapter.id)).toContain(6);
  expect((await listChapterCleanupCandidates(selection)).map(row => row.identity.chapter.id)).not.toContain(7);
  sqlite.exec("UPDATE content_sync_cache SET payload='broken' WHERE cache_key='norea-content-chapter-source:6'");
  expect((await listChapterCleanupCandidates(selection)).map(row => row.identity.chapter.id)).not.toContain(6);
  sqlite.exec(`UPDATE content_sync_cache SET payload='{"chapterId":6,"novelId":5,"pluginId":"local","sourceNovelId":"five","novelPath":"/five","chapterPath":"/wrong","chapterNumber":"1","position":1,"serverUrl":"https://example.com","fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' WHERE cache_key='norea-content-chapter-source:6'`);
  expect((await listChapterCleanupCandidates(selection)).map(row => row.identity.chapter.id)).not.toContain(6);
});

it("records chapter-specific proof only when explicitly installed and keeps it through cleanup", async () => {
  const selection = { reading: "all", categories: { mode: "all" } } as const;
  await clearServerChapterDownloadProof(6);
  expect((await listChapterCleanupCandidates(selection)).some(row => row.identity.chapter.id === 6)).toBe(false);
  const row = { chapterId: 6, novelId: 5, pluginId: "local", sourceNovelId: "five", novelPath: "/five", chapterPath: "/6", chapterNumber: "1", position: 1 };
  await rememberServerChapterDownload(row as never, "https://example.com", "a".repeat(64));
  const candidate = (await listChapterCleanupCandidates(selection)).find(item => item.identity.chapter.id === 6)!;
  expect(candidate.localServerFingerprint).toBe("a".repeat(64));
  await reconcileCleanedChapter(candidate, { contentBytes: 0, mediaBytes: 0, mediaComplete: false });
  expect(sqlite.prepare("SELECT payload FROM content_sync_cache WHERE cache_key='norea-content-chapter-source:6'").get()).toBeDefined();
});
