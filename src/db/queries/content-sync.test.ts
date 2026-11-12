import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ getDb: vi.fn(), getReadOnlyDb: vi.fn(), runDatabaseTransaction: vi.fn() }));
import { getDb, getReadOnlyDb, runDatabaseTransaction } from "../client";
import { adoptStoredChapterContentMetadata, saveChapterContentMetadata } from "./chapter";
import { contentJournalHead, readContentJournal, importContentMetadata, listContentSyncChapters, listContentSyncWorkChapters, listUntrackedContentSyncChapters, markContentInstalled, readContentSyncCache, writeContentSyncCache, canUploadContentChapter } from "./content-sync";
import { cacheServerChapters, recordPendingNovelMergeInDb, listNovelMigrations, saveNovelMigration, isNovelMigrationSourceHeldInDb } from "./content-sync";
import { applyNovelMetadataToCache } from "../work-metadata";
import { syncNovelFromSource } from "../../lib/plugins/sync-novel";
import type { Plugin } from "../../lib/plugins/types";
import { clearAuthoritativeStorageDirs, rememberAuthoritativeChapterStorageDir, resolvedChapterStorageDir } from "../../lib/chapter-storage-resolution";

let sqlite: DatabaseSync;
beforeEach(() => {
  clearAuthoritativeStorageDirs();
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  sqlite.exec(readFileSync("src-tauri/src/migrations/0005_novel_download_goals.sql", "utf8"));
  sqlite.exec(readFileSync("src-tauri/src/migrations/0006_download_goal_opt_out.sql", "utf8"));
  sqlite.exec(readFileSync("src-tauri/src/migrations/0007_novel_freshness.sql", "utf8"));
  sqlite.exec(readFileSync("src-tauri/src/migrations/0010_novel_chapter_composition.sql", "utf8"));
  sqlite.exec("INSERT INTO novel(id,plugin_id,source_novel_id,path,name) VALUES(42,'source','work','/work','A work')");
  const db = {
    select: async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value])) as never),
    execute: async (sql: string, params: unknown[] = []) => {
      const result = sqlite.prepare(sql).run(Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value])) as never);
      return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
  };
  vi.mocked(getDb).mockResolvedValue(db as never);
  vi.mocked(getReadOnlyDb).mockResolvedValue(db as never);
  vi.mocked(runDatabaseTransaction).mockImplementation(async (run, remote) => {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      if (remote) sqlite.exec("UPDATE content_sync_origin SET remote=1");
      const result = await run(db as never);
      if (remote) sqlite.exec("UPDATE content_sync_origin SET remote=0");
      sqlite.exec("COMMIT");
      return result;
    } catch(error) { sqlite.exec("ROLLBACK"); throw error; }
  });
});
afterEach(() => { sqlite.close(); clearAuthoritativeStorageDirs(); });

const manifest = {
  packageVersion: 1 as const,
  layout: "chapter-files" as const,
  identity: { pluginId: "source", novelId: "work", novelPath: "/work", chapterPath: "/chapter" },
  novel: { name: "A work", isLocal: false },
  chapter: { name: "Opening", position: 1, contentType: "html" as const, complete: true, page: "1" },
  bodyPath: "content.html", files: [],
};

it("selects only stored chapters missing from one server's durable download cache", async () => {
  sqlite.exec("INSERT INTO chapter(id,novel_id,path,name,position,is_downloaded,content_bytes,media_repair_needed) VALUES " +
    "(1,42,'/known','Known',1,1,10,0)," +
    "(2,42,'/untracked','Untracked',2,1,20,0)," +
    "(3,42,'/unstored','Unstored',3,0,0,0)," +
    "(4,42,'/repair','Repair',4,0,30,1)");
  await writeContentSyncCache("norea-content-catalog:https://content.example", JSON.stringify({
    downloads: { [JSON.stringify(["source", "/work", "/known"])]: true },
    uploaded: {}, pendingUploads: [],
  }));

  const rows = await listUntrackedContentSyncChapters("https://content.example");

  expect(rows.map(row => row.chapterId)).toEqual([2, 4]);
  expect(rows).toMatchObject([
    { chapterPath: "/untracked", isDownloaded: true, contentBytes: 20, mediaRepairNeeded: false },
    { chapterPath: "/repair", isDownloaded: false, contentBytes: 30, mediaRepairNeeded: true },
  ]);
});

it("keeps persisted and leased downloads out of upload readiness even before scheduler restoration", async () => {
  sqlite.exec(`INSERT INTO chapter(id,novel_id,path,name,position,is_downloaded,media_repair_needed) VALUES
    (1,42,'/one','One',1,1,0), (2,42,'/two','Two',2,1,0), (3,42,'/three','Three',3,1,0),
    (4,42,'/four','Four',4,0,0), (5,42,'/five','Five',5,1,1);
    INSERT INTO chapter_download_queue(chapter_id,job_json,created_at_ms,updated_at_ms,leased_at_ms)
    VALUES (1,'{}',1,1,NULL), (2,'{}',1,1,1)`);
  const rows = await listContentSyncChapters(undefined, true);
  expect(rows.filter(row => row.isDownloadQueued).map(row => row.chapterId)).toEqual([1, 2]);
  expect(await Promise.all([1, 2, 3, 4, 5, 999].map(canUploadContentChapter))).toEqual([false, false, true, false, true, false]);
  sqlite.exec("DELETE FROM chapter_download_queue WHERE chapter_id=1");
  expect(await canUploadContentChapter(1)).toBe(true);
});

it("caches a server chapter list without duplicating a source chapter or changing reading state", async () => {
  sqlite.exec("INSERT INTO novel(id,plugin_id,path,name) VALUES(1,'source','/cache-work','Book')");
  sqlite.exec("INSERT INTO chapter(novel_id,path,name,chapter_number,position,progress,is_downloaded) VALUES(1,'/chapter/1','Source title','1',1,75,1)");
  const one = { id: "one", chapterPath: "norea-folder:1", name: "Folder-title", chapterNumber: "1", position: 1, page: "1", contentType: "html" as const, complete: true };
  expect(await cacheServerChapters(1, [one, { ...one, id: "two", chapterPath: "norea-folder:2", name: "Two", chapterNumber: "2", position: 2 }])).toBe(true);
  expect(sqlite.prepare("SELECT path,name,progress,is_downloaded FROM chapter ORDER BY position").all()).toEqual([
    { path: "/chapter/1", name: "Source title", progress: 75, is_downloaded: 1 },
    { path: "norea-folder:2", name: "Two", progress: 0, is_downloaded: 0 },
  ]);
  expect(await cacheServerChapters(1, [one])).toBe(false);
  expect(await cacheServerChapters(1, [])).toBe(false);
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter").get()?.count).toBe(2);
});

it("retains different local files with the same chapter number", async () => {
  sqlite.exec("INSERT INTO novel(id,plugin_id,path,name,is_local) VALUES(1,'local','local','local',1)");
  sqlite.exec("INSERT INTO chapter(novel_id,path,name,chapter_number,position,is_downloaded) VALUES(1,'local:file-a','A','1',1,1)");
  const incoming = { id: "b", chapterPath: "local:file-b", name: "B", chapterNumber: "1", position: 1, page: "1", contentType: "html" as const, complete: true };
  expect(await cacheServerChapters(1, [incoming])).toBe(true);
  expect(sqlite.prepare("SELECT path,is_downloaded FROM chapter ORDER BY path").all()).toEqual([
    { path: "local:file-a", is_downloaded: 1 },
    { path: "local:file-b", is_downloaded: 0 },
  ]);
  expect(await cacheServerChapters(1, [incoming])).toBe(false);
});

it("stops future chapter batches on navigation cancellation without rejecting the database transaction", async () => {
  const controller = new AbortController();
  const db = await getDb();
  const execute = db.execute;
  db.execute = async (...args) => {
    const result = await execute(...args);
    if (args[0].includes("INSERT INTO chapter(")) controller.abort();
    return result;
  };
  let transactionFailed = false;
  const transaction = vi.mocked(runDatabaseTransaction).getMockImplementation()!;
  vi.mocked(runDatabaseTransaction).mockImplementation(async (...args) => {
    try { return await transaction(...args); }
    catch (error) { transactionFailed = true; throw error; }
  });
  const chapters = Array.from({ length: 150 }, (_, index) => ({
    id: String(index), chapterPath: `/chapter/${index}`, name: `Chapter ${index}`, chapterNumber: String(index + 1),
    position: index + 1, page: "1", contentType: "html" as const, complete: true,
  }));
  await expect(cacheServerChapters(42, chapters, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(transactionFailed).toBe(false);
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter").get()?.count).toBe(100);
});

it("rejects an already cancelled chapter refresh before opening a transaction", async () => {
  const controller = new AbortController(); controller.abort();
  vi.mocked(runDatabaseTransaction).mockClear();
  await expect(cacheServerChapters(42, [], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(runDatabaseTransaction).not.toHaveBeenCalled();
});

it("refuses to reconstruct a missing work from a chapter package", async () => {
  await expect(importContentMetadata({ ...manifest, identity: { ...manifest.identity, novelPath: "/unknown" } })).rejects.toThrow("work metadata");
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM novel").get()?.count).toBe(1);
});

it("imports by source identity with new local IDs and preserves existing reading and downloads", async () => {
  sqlite.exec("INSERT INTO novel(id,plugin_id,path,name) VALUES(41,'other','/other','Other')");
  const imported = await importContentMetadata(manifest);
  expect(imported.novelId).toBe(42);
  sqlite.exec(`UPDATE chapter SET progress=73, bookmark=1, is_downloaded=1 WHERE id=${imported.chapterId}`);
  const second = await importContentMetadata({ ...manifest, chapter: { ...manifest.chapter, name: "New title" } });
  expect(second).toEqual(imported);
  const [row] = await listContentSyncChapters();
  expect(row).toMatchObject({ chapterId: imported.chapterId, isDownloaded: true });
  expect(sqlite.prepare("SELECT name,progress,bookmark FROM chapter").get()).toEqual({ name: "Opening", progress: 73, bookmark: 1 });
});

it("reuses a metadata catalog placeholder through server import and the next source refresh", async () => {
  const db = await getDb();
  await applyNovelMetadataToCache(db, {
    schemaVersion: 1, identity: { pluginId: "source", novelId: "work", novelPath: "/work" },
    novel: { name: "A work", author: null, artist: null, summary: null, status: null, genres: null, rating: null, isLocal: false },
    cover: null, chapters: { "1": "Opening" },
  });
  const placeholder = sqlite.prepare("SELECT id,path,is_downloaded FROM chapter").get()!;
  expect(placeholder).toMatchObject({ path: "norea-folder:1", is_downloaded: 0 });
  const chapterId = Number(placeholder.id);
  const directory = "contents/source/Original-work/1";
  sqlite.prepare("UPDATE chapter SET progress=73,bookmark=1,unread=0,read_at=123 WHERE id=?").run(chapterId);
  sqlite.prepare("INSERT INTO work_metadata_directory_cache(chapter_id,novel_id,directory) VALUES(?,42,?)").run(chapterId, directory);
  rememberAuthoritativeChapterStorageDir(chapterId, directory);

  const imported = await importContentMetadata({ ...manifest, chapter: { ...manifest.chapter, chapterNumber: "1" } });
  expect(imported).toEqual({ novelId: 42, chapterId });
  expect(sqlite.prepare("SELECT id,path,progress,bookmark,unread,read_at,is_downloaded FROM chapter").all()).toEqual([
    { id: chapterId, path: "/chapter", progress: 73, bookmark: 1, unread: 0, read_at: 123, is_downloaded: 0 },
  ]);
  await markContentInstalled(chapterId, "html", 512, 16, true);
  const plugin = {
    id: "source", parseNovel: async () => ({ novelId: "work", name: "A work", path: "/work", chapters: [{ path: "/chapter", name: "Opening", chapterNumber: 1 }] }),
  } as unknown as Plugin;
  await expect(syncNovelFromSource(plugin, { name: "A work", path: "/work" }, { novelId: 42, notifyUpdatesIndex: false })).resolves.toMatchObject({ novelId: 42, chapterCount: 1 });
  expect(sqlite.prepare("SELECT id,path,progress,bookmark,unread,read_at,is_downloaded,content_bytes,media_bytes FROM chapter").all()).toEqual([
    { id: chapterId, path: "/chapter", progress: 73, bookmark: 1, unread: 0, read_at: 123, is_downloaded: 1, content_bytes: 512, media_bytes: 16 },
  ]);
  expect(sqlite.prepare("SELECT chapter_id,novel_id,directory FROM work_metadata_directory_cache").all()).toEqual([
    { chapter_id: chapterId, novel_id: 42, directory },
  ]);
  expect(resolvedChapterStorageDir(chapterId)).toBe(directory);
});

it("retains downloaded placeholder state and its directory when adopting a source path", async () => {
  sqlite.exec(`INSERT INTO chapter(id,novel_id,path,name,chapter_number,position,progress,bookmark,is_downloaded,stored_content_type,content_bytes,media_bytes)
    VALUES(9,42,'norea-folder:1','Original','1',1,73,1,1,'html',512,16);
    INSERT INTO work_metadata_directory_cache(chapter_id,novel_id,directory) VALUES(9,42,'contents/source/work/1')`);
  expect(await importContentMetadata({ ...manifest, chapter: { ...manifest.chapter, chapterNumber: "1.0" } })).toEqual({ novelId: 42, chapterId: 9 });
  expect(sqlite.prepare("SELECT id,path,name,progress,bookmark,is_downloaded,stored_content_type,content_bytes,media_bytes FROM chapter").all()).toEqual([
    { id: 9, path: "/chapter", name: "Original", progress: 73, bookmark: 1, is_downloaded: 1, stored_content_type: "html", content_bytes: 512, media_bytes: 16 },
  ]);
  expect(sqlite.prepare("SELECT directory FROM work_metadata_directory_cache WHERE chapter_id=9").get()?.directory).toBe("contents/source/work/1");
});

it.each(["norea-folder:another", "/chapter"])("preserves ambiguous chapter candidates when a placeholder coexists with %s", async otherPath => {
  sqlite.exec("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position,progress,is_downloaded) VALUES(9,42,'norea-folder:1','Original','1',1,73,1)");
  sqlite.prepare("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position,bookmark) VALUES(10,42,?,'Another','1',2,1)").run(otherPath);
  const before = sqlite.prepare("SELECT * FROM chapter ORDER BY id").all();
  await expect(importContentMetadata({ ...manifest, chapter: { ...manifest.chapter, chapterNumber: "1" } })).rejects.toThrow("ambiguous");
  expect(sqlite.prepare("SELECT * FROM chapter ORDER BY id").all()).toEqual(before);
});

it("stores catalog data larger than WebView localStorage without crossing account keys", async () => {
  const payload = JSON.stringify({ items: "a".repeat(6 * 1024 * 1024) });
  await writeContentSyncCache("catalog:one", payload);
  expect(await readContentSyncCache("catalog:one")).toBe(payload);
  expect(await readContentSyncCache("catalog:two")).toBeNull();
});

it("retains work file revisions when reopening the compact sync cache", async () => {
  const value = { cursor: 45, fingerprints: { work: "content-hash" }, fileVersions: { '["source","/book"]': "file-revision" }, deleted: { removed: true } };
  await writeContentSyncCache("works", JSON.stringify(value));
  expect(JSON.parse((await readContentSyncCache("works"))!)).toEqual(value);
});

it("retains chapter tombstones and local checkpoints", async () => {
  const value = { cursor: 72, localCursor: 9, tombstones: { '["source","/work","/chapter"]': true },
    uploaded: { local: "hash" }, downloads: { local: true }, excluded: ["excluded"], pendingUploads: ["pending"],
  };
  await writeContentSyncCache("catalog", JSON.stringify(value));
  expect(JSON.parse((await readContentSyncCache("catalog"))!)).toEqual(value);
});

it("keeps an installed incomplete body readable with repair required", async () => {
  const { chapterId } = await importContentMetadata(manifest);
  await markContentInstalled(chapterId, "html", 512, 22, false);
  expect(sqlite.prepare("SELECT is_downloaded,media_repair_needed,content_bytes,media_bytes FROM chapter WHERE id=?").get(chapterId)).toEqual({
    is_downloaded: 0, media_repair_needed: 1, content_bytes: 512, media_bytes: 22,
  });
  await markContentInstalled(chapterId, "html", 512, 100, true);
  expect(sqlite.prepare("SELECT is_downloaded,media_repair_needed FROM chapter WHERE id=?").get(chapterId)).toEqual({ is_downloaded: 1, media_repair_needed: 0 });
});

it("returns no cached state before the first sync", async () => {
  expect(await readContentSyncCache("missing")).toBeNull();
});

it("discovers and permits stored incomplete chapters while excluding missing bodies and queued downloads", async () => {
  sqlite.exec(`INSERT INTO chapter(id,novel_id,path,name,position,is_downloaded,media_repair_needed,content_bytes) VALUES
    (1,42,'/partial','Partial',1,0,1,12), (2,42,'/missing','Missing',2,0,1,0),
    (3,42,'/queued','Queued',3,0,1,12);
    INSERT INTO chapter_download_queue(chapter_id,job_json,created_at_ms,updated_at_ms) VALUES (3,'{}',1,1)`);
  expect((await listContentSyncChapters(undefined, true)).map(row => row.chapterId)).toEqual([1, 3]);
  expect((await listContentSyncWorkChapters(['["source","/work"]'])).map(row => row.chapterId)).toEqual([1, 3]);
  expect(await Promise.all([1, 2, 3].map(canUploadContentChapter))).toEqual([true, false, false]);
});

it("limits initial upload discovery to downloaded chapters", async () => {
  const { chapterId } = await importContentMetadata(manifest);
  await importContentMetadata({ ...manifest, identity: { ...manifest.identity, chapterPath: "/metadata-only" } });
  sqlite.exec(`UPDATE chapter SET is_downloaded=1 WHERE id=${chapterId}`);
  expect((await listContentSyncChapters(undefined, true)).map(row => row.chapterPath)).toEqual(["/chapter"]);
  expect(await listContentSyncChapters(['["source","/work","/metadata-only"]'])).toHaveLength(1);
});


it("records equal-size completed replacements, repairs and metadata edits without progress-only content work", async () => {
  await importContentMetadata(manifest);
  sqlite.exec("UPDATE chapter SET is_downloaded=1,content_bytes=10,media_repair_needed=0");
  let head = await contentJournalHead();
  sqlite.exec("UPDATE chapter SET progress=10");
  expect((await readContentJournal(head, await contentJournalHead())).some((entry) => entry.key.startsWith("content:"))).toBe(false);
  head = await contentJournalHead();
  sqlite.exec("UPDATE chapter SET content_bytes=10,media_repair_needed=0");
  expect((await readContentJournal(head, await contentJournalHead())).some((entry) => entry.key.startsWith("content:"))).toBe(true);
  head = await contentJournalHead();
  sqlite.exec("UPDATE novel SET name='Changed title'");
  expect((await readContentJournal(head, await contentJournalHead())).some((entry) => entry.key.startsWith("content:"))).toBe(true);
});

it("selects only requested identities through indexed novel and chapter lookup", async () => {
  await importContentMetadata(manifest);
  await importContentMetadata({ ...manifest, identity: { ...manifest.identity, chapterPath: "/other" } });
  expect(await listContentSyncChapters([])).toEqual([]);
  const rows = await listContentSyncChapters(['["source","/work","/other"]']);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.chapterPath).toBe("/other");
});

it("selects completed chapters by exact work identity regardless of recovered chapter paths", async () => {
  sqlite.exec(`INSERT INTO novel(id,plugin_id,path,name) VALUES (43,'source','/other','Other'), (44,'another','/work','Same path');
    INSERT INTO chapter(novel_id,path,name,position,is_downloaded) VALUES
    (42,'/source/chapter/1','One',1,1), (42,'norea-folder:2','Two',2,1), (42,'/pending','Pending',3,0),
    (43,'norea-folder:1','Other',1,1), (44,'/source/chapter/1','Another source',1,1)`);
  expect(await listContentSyncWorkChapters([])).toEqual([]);
  expect((await listContentSyncWorkChapters(['["source","/work"]'])).map(row => row.chapterPath)).toEqual([
    "/source/chapter/1", "norea-folder:2",
  ]);
  expect((await listContentSyncWorkChapters(['["source","/work"]', '["source","/other"]'])).map(row => row.novelId)).toEqual([42, 42, 43]);
});

it("batches a large deleted-work recheck without including unrelated works", async () => {
  sqlite.exec("INSERT INTO chapter(novel_id,path,name,position,is_downloaded) VALUES(42,'/one','One',1,1)");
  const identities = Array.from({ length: 100 }, (_, index) => JSON.stringify(["source", `/missing/${index}`]));
  identities.push('["source","/work"]');
  expect((await listContentSyncWorkChapters(identities)).map(row => row.novelId)).toEqual([42]);
});


it("rechecking unchanged downloaded files does not journal content but equal-size saves do", async () => {
  const { chapterId } = await importContentMetadata(manifest);
  expect(await adoptStoredChapterContentMetadata(chapterId, 10, 0, "html")).toEqual({ rowsAffected: 1 });
  const head = await contentJournalHead();
  sqlite.exec("UPDATE chapter SET media_bytes_checked_at=0");
  expect(await adoptStoredChapterContentMetadata(chapterId, 10, 0, "html")).toEqual({ rowsAffected: 1 });
  expect(await adoptStoredChapterContentMetadata(chapterId, 10, 0, null)).toEqual({ rowsAffected: 1 });
  expect(await contentJournalHead()).toBe(head);
  expect(sqlite.prepare("SELECT media_bytes_checked_at AS checked FROM chapter").get()?.checked).toBeGreaterThan(0);
  await saveChapterContentMetadata(chapterId, "0123456789", "html", { mediaBytes: 0 });
  const changed = await readContentJournal(head, await contentJournalHead());
  expect(changed).toHaveLength(1);
  expect(changed[0]?.key).toBe('content:["source","/work","/chapter"]');
  const savedHead = await contentJournalHead();
  await adoptStoredChapterContentMetadata(chapterId, 10, 4, "html", true);
  expect(await contentJournalHead()).toBeGreaterThan(savedHead);
  expect(await adoptStoredChapterContentMetadata(chapterId + 999, 10, 0, "html")).toEqual({ rowsAffected: 0 });
});

it("keeps personal state local and only journals content changes", async () => {
  const { chapterId } = await importContentMetadata(manifest);
  sqlite.exec(`UPDATE novel SET in_library=1,last_read_at=123; UPDATE chapter SET unread=0,progress=60,bookmark=1,read_at=123 WHERE id=${chapterId}`);
  expect(await contentJournalHead()).toBe(0);
  await importContentMetadata(manifest);
  expect(sqlite.prepare("SELECT unread,progress,bookmark,read_at FROM chapter").get()).toEqual({ unread: 0, progress: 60, bookmark: 1, read_at: 123 });
  expect(sqlite.prepare("SELECT in_library,last_read_at FROM novel").get()).toEqual({ in_library: 1, last_read_at: 123 });
  sqlite.exec("UPDATE chapter SET is_downloaded=1");
  const changes = await readContentJournal(0, await contentJournalHead());
  expect(changes).toHaveLength(1);
  expect(changes[0]?.key).toBe('content:["source","/work","/chapter"]');
});

it("retains content deletion events without personal-state tombstones", async () => {
  const { novelId } = await importContentMetadata(manifest);
  sqlite.exec("PRAGMA foreign_keys=ON");
  sqlite.exec(`DELETE FROM novel WHERE id=${novelId}`);
  const changes = await readContentJournal(0, await contentJournalHead());
  expect(changes).toHaveLength(1);
  expect(changes[0]?.key).toBe('content:["source","/work","/chapter"]');
});

it("keeps a durable source hold scoped to the server, including after completion", async () => {
  sqlite.exec("INSERT INTO novel(id,plugin_id,source_novel_id,path,name) VALUES(43,'target','new-work','/new-work','Target')");
  sqlite.exec("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position,is_downloaded) VALUES(11,42,'/chapter','One','1',1,1),(21,43,'/new-chapter','One','9001',1,1)");
  const db = await getDb();
  const operationId = await recordPendingNovelMergeInDb(db, {
    serverUrl: "http://server/", sourceNovelId: 42, targetNovelId: 43, chapterIdMap: { 11: 21 },
    preparedDownloads: [{ sourceChapterId: 11, transferredFromSource: true }],
  });
  const [job] = await listNovelMigrations("http://server");
  expect(job).toMatchObject({
    operationId, source: { pluginId: "source", novelId: "work", novelPath: "/work" },
    target: { pluginId: "target", novelId: "new-work", novelPath: "/new-work" },
    chapters: [{ sourceChapterPath: "/chapter", targetChapterPath: "/new-chapter", sourceChapterNumber: "1", targetChapterNumber: "9001", decision: "copy-source" }],
  });
  expect(await isNovelMigrationSourceHeldInDb(db, "http://server", manifest.identity)).toBe(true);
  expect(await isNovelMigrationSourceHeldInDb(db, "http://other", manifest.identity)).toBe(false);
  await saveNovelMigration({ ...job!, status: "completed" });
  expect(await listNovelMigrations("http://server")).toEqual([]);
  expect(await listNovelMigrations("http://server", true)).toHaveLength(1);
  expect(await isNovelMigrationSourceHeldInDb(db, "http://server", manifest.identity)).toBe(true);
});

it("blocks a held source import within its raw metadata transaction", async () => {
  sqlite.exec("INSERT INTO novel(id,plugin_id,source_novel_id,path,name) VALUES(43,'target','new-work','/new-work','Target')");
  await recordPendingNovelMergeInDb(await getDb(), {
    serverUrl: "http://server", sourceNovelId: 42, targetNovelId: 43, chapterIdMap: {}, preparedDownloads: [],
  });
  await expect(importContentMetadata(manifest, "http://server")).rejects.toThrow("held");
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter").get()?.count).toBe(0);
});

it("refuses retained-target migration without the actual complete inventory", async () => {
  sqlite.exec("INSERT INTO novel(id,plugin_id,source_novel_id,path,name) VALUES(43,'target','new-work','/new-work','Target')");
  sqlite.exec("INSERT INTO chapter(id,novel_id,path,name,position) VALUES(11,42,'/chapter','One',1),(21,43,'/new-chapter','One',1)");
  await expect(recordPendingNovelMergeInDb(await getDb(), {
    serverUrl: "http://server", sourceNovelId: 42, targetNovelId: 43, chapterIdMap: { 11: 21 },
    preparedDownloads: [{ sourceChapterId: 11, transferredFromSource: false }],
  })).rejects.toThrow("complete verified inventory");
  expect(await listNovelMigrations("http://server")).toEqual([]);
});

it("accepts missing declarations only with explicit verified body-only proof", async () => {
  sqlite.exec("INSERT INTO novel(id,plugin_id,source_novel_id,path,name) VALUES(43,'target','new-work','/new-work','Target')");
  sqlite.exec("INSERT INTO chapter(id,novel_id,path,name,position) VALUES(11,42,'/chapter','One',1),(21,43,'/new-chapter','One',1)");
  const inventory = { body: { sha256: "a".repeat(64), bytes: 12 }, expectedAssetKeys: null, storedAssets: [] };
  const input = {
    serverUrl: "http://server", sourceNovelId: 42, targetNovelId: 43, chapterIdMap: { 11: 21 },
    preparedDownloads: [{ sourceChapterId: 11, transferredFromSource: false, targetInventory: inventory }],
  };
  await expect(recordPendingNovelMergeInDb(await getDb(), input)).rejects.toThrow("complete verified inventory");
  await recordPendingNovelMergeInDb(await getDb(), { ...input,
    preparedDownloads: [{ ...input.preparedDownloads[0]!, targetInventoryBodyOnly: true }],
  });
  const [job] = await listNovelMigrations("http://server");
  expect(job!.chapters[0]!.expectedTargetInventory).toEqual(inventory);
});


it("stores the captured target metadata independently of later caller or database changes", async () => {
  sqlite.exec("INSERT INTO novel(id,plugin_id,source_novel_id,path,name,author,rating) VALUES(43,'target','new-work','/new-work','Target','Fresh author',0)");
  const targetMetadata = {
    novel: { name: "Target", author: "Fresh author", artist: null, summary: null, status: null, genres: null, rating: 0, isLocal: false },
    cover: null, coverSha256: null,
  };
  await recordPendingNovelMergeInDb(await getDb(), {
    serverUrl: "http://server", sourceNovelId: 42, targetNovelId: 43, chapterIdMap: {}, preparedDownloads: [], targetMetadata,
  });
  targetMetadata.novel.author = "Changed caller";
  sqlite.exec("UPDATE novel SET author='Changed later' WHERE id=43");
  const [job] = await listNovelMigrations("http://server");
  expect(job!.targetMetadata).toEqual({ ...targetMetadata, novel: { ...targetMetadata.novel, author: "Fresh author" } });
});

it("refuses to record target metadata that changed before the merge transaction", async () => {
  sqlite.exec("INSERT INTO novel(id,plugin_id,source_novel_id,path,name,author) VALUES(43,'target','new-work','/new-work','Target','Changed author')");
  await expect(recordPendingNovelMergeInDb(await getDb(), {
    serverUrl: "http://server", sourceNovelId: 42, targetNovelId: 43, chapterIdMap: {}, preparedDownloads: [],
    targetMetadata: {
      novel: { name: "Target", author: "Fresh author", artist: null, summary: null, status: null, genres: null, rating: null, isLocal: false },
      cover: null, coverSha256: null,
    },
  })).rejects.toThrow("target metadata changed");
  expect(await listNovelMigrations("http://server")).toEqual([]);
});

it.each(["pending", "failed", "blocked", "completed", "inactive"] as const)("honors incoming migration holds while the durable state is %s", async status => {
  const key = "norea-content-incoming-migration:" + JSON.stringify(["http://server", "incoming-op"]);
  const payload = { version: 1, serverUrl: "http://server", operationId: "incoming-op", status, source: { pluginId: "source", novelId: "work", novelPath: "/work" } };
  sqlite.prepare("INSERT INTO content_sync_cache(cache_key,payload) VALUES(?,?)").run(key, JSON.stringify(payload));
  expect(await isNovelMigrationSourceHeldInDb(await getDb(), "http://server", manifest.identity)).toBe(status !== "inactive");
  expect(await isNovelMigrationSourceHeldInDb(await getDb(), "http://another", manifest.identity)).toBe(false);
});

it("never converts local skipSourceContentChapterIds into server discardSourceContent and requires explicit inventory-bound discard approval", async () => {
  sqlite.exec("INSERT INTO novel(id,plugin_id,source_novel_id,path,name) VALUES(43,'target','new-work','/new-work','Target')");
  sqlite.exec("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position) VALUES(11,42,'/chapter','Source','1',1),(21,43,'/new-chapter','Target','9001',1)");
  await recordPendingNovelMergeInDb(await getDb(), {
    serverUrl: "http://server", sourceNovelId: 42, targetNovelId: 43, chapterIdMap: { 11: 21 },
    skipSourceContentChapterIds: [11], preparedDownloads: [],
  });
  const preservedJob = (await listNovelMigrations("http://server"))[0]!;
  expect(preservedJob.chapters[0]).toMatchObject({
    sourceChapterPath: "/chapter", targetChapterPath: "/new-chapter", decision: "copy-source",
  });
  expect(preservedJob.chapters[0]!.discardSourceContent).toBeUndefined();

  await expect(recordPendingNovelMergeInDb(await getDb(), {
    serverUrl: "http://server", sourceNovelId: 42, targetNovelId: 43, chapterIdMap: { 11: 21 },
    skipSourceContentChapterIds: [11], preparedDownloads: [{ sourceChapterId: 11, transferredFromSource: true }],
  })).rejects.toThrow(/without copying/);

  sqlite.exec("DELETE FROM content_sync_cache");
  const sourceInv = { body: { sha256: "a".repeat(64), bytes: 50 }, expectedAssetKeys: null, storedAssets: [] };
  await recordPendingNovelMergeInDb(await getDb(), {
    serverUrl: "http://server", sourceNovelId: 42, targetNovelId: 43, chapterIdMap: { 11: 21 },
    explicitServerDiscardBySourceId: { 11: { approvedByUser: true, expectedSourceInventory: sourceInv } },
    preparedDownloads: [],
  });
  const explicitJob = (await listNovelMigrations("http://server"))[0]!;
  expect(explicitJob.chapters[0]).toMatchObject({
    sourceChapterPath: "/chapter", targetChapterPath: "/new-chapter", decision: null, discardSourceContent: true,
    explicitSourceDiscard: { approvedByUser: true, expectedSourceInventory: sourceInv },
  });
});

it("does not resurrect excluded chapters from server catalogs or imported packages", async () => {
  const { materializeChapterComposition, setChapterComposition } = await import("../chapter-composition");
  const composition = { version: 1 as const, updatedAt: 1, entries: [1, 2].map(number => ({
    id: "entry-" + number, path: "/chapter/" + number, storageChapterNumber: String(number),
    sources: [{ pluginId: "source", novelId: "work", novelPath: "/work", chapterPath: "/raw/" + number,
      chapterNumber: String(number), name: "Raw " + number, position: number, page: "1", contentType: "html" as const, releaseTime: null }],
    primarySource: 0, user: { included: number === 2, order: number === 2 ? 1 : 0, name: number === 2 ? "Custom" : null, chapterNumber: number === 2 ? "1" : null },
  })) };
  const db = await getDb();
  await materializeChapterComposition(db, 42, composition);
  await setChapterComposition(db, 42, composition);
  const summaries = [1, 2, 3].map(number => ({ id: "server-" + number, chapterPath: "/chapter/" + number,
    name: "Server " + number, chapterNumber: String(number), position: number, page: "1", contentType: "html" as const, complete: true }));
  expect(await cacheServerChapters(42, summaries)).toBe(false);
  expect(sqlite.prepare("SELECT path,name,position,chapter_number FROM chapter").all())
    .toEqual([{ path: "/chapter/2", name: "Custom", position: 1, chapter_number: "2" }]);
  await expect(importContentMetadata({
    ...manifest, identity: { ...manifest.identity, chapterPath: "/chapter/1" },
    chapter: { ...manifest.chapter, chapterNumber: "1" },
  })).rejects.toThrow(/excluded/);
});
