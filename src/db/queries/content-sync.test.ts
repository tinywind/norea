import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ getDb: vi.fn(), runDatabaseTransaction: vi.fn() }));
import { getDb, runDatabaseTransaction } from "../client";
import { CONTENT_SYNC_JOURNAL_SCHEMA } from "../content-sync-journal";
import { adoptStoredChapterContentMetadata, saveChapterContentMetadata } from "./chapter";
import { contentJournalHead, readContentJournal, importContentMetadata, listContentSyncChapters, readContentSyncCache, readContentSyncStateCache, writeContentSyncCache } from "./content-sync";

let sqlite: DatabaseSync;
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  for (const sql of CONTENT_SYNC_JOURNAL_SCHEMA) sqlite.exec(sql);
  const db = {
    select: async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value])) as never),
    execute: async (sql: string, params: unknown[] = []) => {
      const result = sqlite.prepare(sql).run(Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value])) as never);
      return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
  };
  vi.mocked(getDb).mockResolvedValue(db as never);
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
afterEach(() => sqlite.close());

const manifest = {
  packageVersion: 1 as const,
  identity: { pluginId: "source", novelPath: "/work", chapterPath: "/chapter" },
  novel: { name: "A work", isLocal: false },
  chapter: { name: "Opening", position: 1, contentType: "html" as const, page: "1" },
  bodyPath: "content.html", files: [],
};

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

it("stores catalog data larger than WebView localStorage without crossing account keys", async () => {
  const payload = JSON.stringify({ items: "a".repeat(6 * 1024 * 1024) });
  await writeContentSyncCache("catalog:one", payload);
  expect(await readContentSyncCache("catalog:one")).toBe(payload);
  expect(await readContentSyncCache("catalog:two")).toBeNull();
});

it("projects legacy work snapshots before returning them across the database bridge", async () => {
  await writeContentSyncCache("works", JSON.stringify({ cursor: 45, fingerprints: { work: "hash" }, entries: { work: { metadata: "a".repeat(6 * 1024 * 1024) } } }));
  const compact = await readContentSyncStateCache("works", "works");
  expect(JSON.parse(compact!)).toEqual({ cursor: 45, fingerprints: { work: "hash" } });
  expect(await readContentSyncCache("works")).toBe(compact);
  expect(compact!.length).toBeLessThan(100);
});

it("compacts legacy chapter inventories while retaining tombstones and local checkpoints", async () => {
  await writeContentSyncCache("catalog", JSON.stringify({ cursor: 72, localCursor: 9,
    entries: { deleted: { deleted: true, manifest }, active: { deleted: false, manifest: { ...manifest, identity: { ...manifest.identity, chapterPath: "/active" } } } },
    uploaded: { local: "hash" }, downloads: { local: true }, excluded: ["excluded"], pendingUploads: ["pending"],
  }));
  const compact = await readContentSyncStateCache("catalog", "catalog");
  expect(JSON.parse(compact!)).toEqual({ cursor: 72, localCursor: 9,
    tombstones: { '["source","/work","/chapter"]': true },
    uploaded: { local: "hash" }, downloads: { local: true }, excluded: ["excluded"], pendingUploads: ["pending"],
  });
  expect(await readContentSyncCache("catalog")).toBe(compact);
});

it("preserves compact tombstones without introducing an initial local checkpoint", async () => {
  await writeContentSyncCache("catalog", JSON.stringify({ cursor: 12, tombstones: { removed: true } }));
  expect(JSON.parse((await readContentSyncStateCache("catalog", "catalog"))!)).toEqual({
    cursor: 12, tombstones: { removed: true }, uploaded: {}, downloads: {}, excluded: [], pendingUploads: [],
  });
  await writeContentSyncCache("broken", "invalid-json");
  expect(await readContentSyncStateCache("broken", "catalog")).toBeNull();
  expect(await readContentSyncStateCache("missing", "works")).toBeNull();
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
  await writeContentSyncCache("norea-content-account:legacy", "preserved");
  sqlite.exec(`UPDATE novel SET in_library=1,last_read_at=123; UPDATE chapter SET unread=0,progress=60,bookmark=1,read_at=123 WHERE id=${chapterId}`);
  expect(await contentJournalHead()).toBe(0);
  await importContentMetadata(manifest);
  expect(sqlite.prepare("SELECT unread,progress,bookmark,read_at FROM chapter").get()).toEqual({ unread: 0, progress: 60, bookmark: 1, read_at: 123 });
  expect(sqlite.prepare("SELECT in_library,last_read_at FROM novel").get()).toEqual({ in_library: 1, last_read_at: 123 });
  expect(await readContentSyncCache("norea-content-account:legacy")).toBe("preserved");
  sqlite.exec("UPDATE chapter SET is_downloaded=1");
  const changes = await readContentJournal(0, await contentJournalHead());
  expect(changes).toHaveLength(1);
  expect(changes[0]?.key).toBe('content:["source","/work","/chapter"]');
});

it("retires legacy personal-state triggers while preserving their rows and selected position", async () => {
  const { novelId, chapterId } = await importContentMetadata(manifest);
  sqlite.exec(`INSERT INTO content_sync_position VALUES(${novelId},${chapterId});
    INSERT INTO content_sync_journal(state_key,payload) VALUES('position:legacy','{}');
    CREATE TRIGGER content_sync_chapter_read AFTER UPDATE OF progress ON chapter BEGIN
      INSERT INTO content_sync_journal(state_key,payload) VALUES('read:legacy','{}'); END;`);
  for (const sql of CONTENT_SYNC_JOURNAL_SCHEMA) sqlite.exec(sql);
  const head = await contentJournalHead();
  sqlite.exec("UPDATE chapter SET progress=77");
  expect(await contentJournalHead()).toBe(head);
  expect(sqlite.prepare("SELECT * FROM content_sync_position").get()).toEqual({ novel_id: novelId, chapter_id: chapterId });
  expect(sqlite.prepare("SELECT count(*) AS count FROM content_sync_journal").get()).toEqual({ count: 1 });
  expect(await readContentJournal(0, head)).toEqual([]);
});

it("retains content deletion events without personal-state tombstones", async () => {
  const { novelId } = await importContentMetadata(manifest);
  sqlite.exec("PRAGMA foreign_keys=ON");
  sqlite.exec(`DELETE FROM novel WHERE id=${novelId}`);
  const changes = await readContentJournal(0, await contentJournalHead());
  expect(changes).toHaveLength(1);
  expect(changes[0]?.key).toBe('content:["source","/work","/chapter"]');
});
