import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type Database from "@tauri-apps/plugin-sql";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ files: new Map<string, number[]>(), readGates: new Map<string, Promise<void>>(), fail: false, failOncePath: "", failReadPath: "", lists: 0, reads: 0, chapterLists: 0, skippedDirectories: [] as string[], chapterScan: undefined as Promise<void> | undefined, chapters: new Map<string, string[]>(), writes: 0, directories: {} as Record<string, string> }));
const mediaInspections = vi.hoisted(() => new Map<string, boolean>());
const mediaInspectionHooks = vi.hoisted(() => new Map<string, () => Promise<void>>());
vi.mock("../lib/chapter-content/storage-platform", () => ({ inspectChapterContentArtifacts: async (input: { preferredChapterDir: string; preferredContentFileName: string }) => {
  const mediaComplete = mediaInspections.get(input.preferredChapterDir) ?? true;
  await mediaInspectionHooks.get(input.preferredChapterDir)?.();
  return { status: "present", contentFile: `${input.preferredChapterDir}/${input.preferredContentFileName}`, contentBytes: 1, mediaBytes: 0, mediaComplete };
} }));
const databaseClient = vi.hoisted(() => ({ transaction: vi.fn(), get: vi.fn() }));
vi.mock("./client", () => ({ runDatabaseTransaction: databaseClient.transaction, getDb: databaseClient.get }));
vi.mock("../lib/tauri-runtime", () => ({ isTauriRuntime: () => true, isAndroidRuntime: () => false }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (_command: string, { input }: { input: { operation: string; path: string; body: number[]; reset?: boolean; chapterDirectories?: Record<string, string>; skipChapterDirectories?: string[] } }) => {
  if (input.operation === "list") { storage.lists++; return { paths: [...storage.files.keys()].filter((path) => path.endsWith("/novel.json")) }; }
  if (input.operation === "chapters") { storage.chapterLists++; storage.skippedDirectories = input.skipChapterDirectories ?? []; const skipped = new Set(storage.skippedDirectories); const paths = (storage.chapters.get(input.path) ?? []).filter(path => !skipped.has(path.slice(0, path.lastIndexOf("/")))); await storage.chapterScan; return { paths }; }
  if (input.operation === "cover") {
    const directory = input.path.slice(0, -"novel.json".length);
    const document = storage.files.get(input.path);
    const preferred = document ? JSON.parse(new TextDecoder().decode(new Uint8Array(document))).cover?.fileName : undefined;
    const candidates = [...storage.files.keys()].filter(path => path.startsWith(directory) && /^cover\.(avif|bmp|gif|img|jpe?g|png|svg|webp)$/.test(path.slice(directory.length)) && storage.files.get(path)!.length > 0).sort();
    const file = candidates.find(path => path === directory + preferred) ?? candidates[0];
    return { cover: file ? { fileName: file.slice(directory.length), modifiedAt: 1 } : null };
  }
  if (input.operation === "read") { if (storage.failReadPath === input.path) throw new Error("storage unavailable"); storage.reads++; await storage.readGates.get(input.path); return { body: storage.files.get(input.path) ?? null }; }
  if (input.operation === "register") storage.directories = { ...(input.reset ? {} : storage.directories), ...input.chapterDirectories };
  if (input.operation === "write") {
    if (storage.fail || storage.failOncePath === input.path) { storage.failOncePath = ""; throw new Error("disk full"); }
    storage.writes++; storage.files.set(input.path, input.body);
  }
  if (input.operation === "remove") storage.files.delete(input.path);
  return {};
} }));

import { applyNovelMetadataToCache, flushWorkMetadata, initializeWorkMetadata, knownNovelMetadataDirectory, readWorkMetadataSyncFiles, refreshStoredNovelChapterDownloads, restoreWorkMetadataDirectories, storedNovelMetadataFingerprint } from "./work-metadata";
import { withChapterDownloadDeletion, withChapterDownloadWrite } from "../lib/chapter-download-writes";
import { adoptStoredChapterContentMetadata } from "./queries/chapter";
import { installStoredNovelMetadata, listStoredNovelChapters, listStoredNovelMetadata, persistNovelCover, subscribeWorkMetadataChanges, writeStoredNovelCover, writeStoredNovelMetadata, type NovelMetadataV1 } from "../lib/work-metadata";
import { clearNovelCoverDisplayCache, getNovelCoverSnapshot, peekCachedNovelCoverSrc, persistCachedNovelCoverSource, resolveCachedNovelCoverSrc, subscribeNovelCoverChanges } from "../lib/novel-cover-storage";
import * as http from "../lib/http";
import { chapterStorageRelativeDir, novelStorageRelativeDir } from "../lib/chapter-storage-path";
import { clearResolvedChapterStorageDirs } from "../lib/chapter-storage-resolution";
import { syncNovelFromSource } from "../lib/plugins/sync-novel";
import type { Plugin } from "../lib/plugins/types";

import { gatherBackupSnapshot } from "../lib/backup/snapshot";
import { encodeBackupManifest, parseBackupManifest } from "../lib/backup/format";
import { prepareBackupRestore } from "../lib/backup/restore-plan";
import { listContentSyncChapters } from "./queries/content-sync";

let sqlite: DatabaseSync;
let db: Database;
const path = "contents/source/book/novel.json";
function fixture(): NovelMetadataV1 { return {
  schemaVersion: 1, identity: { pluginId: "source", novelId: "book", novelPath: "/book" },
  novel: { name: "Disk title", author: "Writer", artist: null, summary: null, status: null, genres: null, rating: null, isLocal: false },
  cover: null, chapters: {},
}; }
function save(metadata: NovelMetadataV1) { storage.files.set(path, [...new TextEncoder().encode(JSON.stringify(metadata))]); }

beforeEach(() => {
  mediaInspections.clear();
  mediaInspectionHooks.clear();
  storage.readGates.clear();
  storage.chapterLists = 0; storage.skippedDirectories = []; storage.chapterScan = undefined;
  storage.files.clear(); storage.chapters.clear(); storage.chapters.set(path, ["contents/source/book/1/content.html"]); storage.writes = 0; storage.fail = false; storage.failOncePath = ""; storage.failReadPath = ""; storage.lists = 0; storage.reads = 0; storage.directories = {};
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  db = {
    select: async (query: string, params: unknown[] = []) => sqlite.prepare(query).all(Object.fromEntries(params.map((value, i) => [`$${i + 1}`, value])) as never),
    execute: async (query: string, params: unknown[] = []) => {
      const result = sqlite.prepare(query).run(Object.fromEntries(params.map((value, i) => [`$${i + 1}`, value])) as never);
      return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
  } as Database;
  databaseClient.get.mockResolvedValue(db);
  databaseClient.transaction.mockImplementation(async (run: (db: Database) => Promise<unknown>) => {
    sqlite.exec("BEGIN IMMEDIATE");
    try { const result = await run(db); sqlite.exec("COMMIT"); return result; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  });
});
afterEach(() => sqlite.close());

it("inspects a bounded group of chapters concurrently and preserves ordered completeness", async () => {
  const numbers = ["9", "2", "4", "1", "3", "5", "6", "7", "8"];
  storage.chapters.set(path, numbers.map(number => `contents/source/book/${number}/content.html`));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let active = 0;
  let peak = 0;
  for (const number of numbers) {
    mediaInspections.set(`contents/source/book/${number}`, number !== "2");
    mediaInspectionHooks.set(`contents/source/book/${number}`, async () => {
      active++; peak = Math.max(peak, active);
      await gate;
      active--;
    });
  }
  const recovery = listStoredNovelChapters("contents/source/book");
  try { await vi.waitFor(() => expect(active).toBe(4)); }
  finally { release(); await recovery; }
  expect(peak).toBe(4);
  expect((await recovery).map(chapter => [chapter.chapterNumber, chapter.mediaComplete]))
    .toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(number => [number, number !== "2"]));
});

it.each(["cancel", "failure"])("drains in-flight chapter inspections before reporting %s", async (reason) => {
  storage.chapters.set(path, Array.from({ length: 8 }, (_, index) => `contents/source/book/${index + 1}/content.html`));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  let finished = 0;
  const controller = new AbortController();
  for (let index = 1; index <= 8; index++) {
    mediaInspectionHooks.set(`contents/source/book/${index}`, async () => {
      started++;
      if (reason === "failure" && index === 1) throw new Error("Unreadable archive");
      await gate;
      finished++;
    });
  }
  let settled = false;
  const recovery = listStoredNovelChapters("contents/source/book", controller.signal);
  const outcome = recovery.then(() => { settled = true; return null; }, error => { settled = true; return error as Error; });
  try {
    await vi.waitFor(() => expect(started).toBe(4));
    if (reason === "cancel") controller.abort();
    expect(settled).toBe(false);
  } finally { release(); await outcome; }
  expect(started).toBe(4);
  expect(finished).toBe(reason === "cancel" ? 4 : 3);
  expect((await outcome)?.message).toBe(reason === "cancel" ? "Storage recovery cancelled." : "Unreadable archive");
});

it("keeps refreshed work details durable when a later server document omits them", async () => {
  await initializeWorkMetadata(db);
  const plugin = { id: "source", parseNovel: async () => ({
    novelId: "book", name: "Refreshed book", path: "/book", author: "Current author",
    artist: "Current artist", summary: "Complete summary", status: "Ongoing", genres: "Fantasy", rating: 4.5,
    chapters: [
      { chapterNumber: 1, name: "Complete opening", path: "/chapter/1" },
      { chapterNumber: 2, name: "Complete second chapter", path: "/chapter/2" },
    ],
  }) } as unknown as Plugin;
  await syncNovelFromSource(plugin, { name: "Refreshed book", path: "/book" });
  const sparse = fixture();
  sparse.novel = { ...sparse.novel, name: "Refreshed book", author: null, artist: " " };
  await installStoredNovelMetadata(sparse);

  const persisted = (await listStoredNovelMetadata())[0]!.metadata;
  expect(persisted.novel).toMatchObject({
    author: "Current author", artist: "Current artist", summary: "Complete summary",
    status: "Ongoing", genres: "Fantasy", rating: 4.5,
  });
  expect(persisted.chapters).toEqual({ "1": "Complete opening", "2": "Complete second chapter" });

  sqlite.close();
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT author,artist,summary,status,genres,rating FROM novel").get())
    .toEqual({ author: "Current author", artist: "Current artist", summary: "Complete summary", status: "Ongoing", genres: "Fantasy", rating: 4.5 });
  expect(sqlite.prepare("SELECT name FROM chapter ORDER BY position").all())
    .toEqual([{ name: "Complete opening" }, { name: "Complete second chapter" }]);
});

it("republishes recovered work details on an unchanged full source refresh", async () => {
  await initializeWorkMetadata(db);
  const plugin = { id: "source", parseNovel: async () => ({
    novelId: "book", name: "Complete book", path: "/book", author: "Writer", summary: "Full summary",
    chapters: [{ chapterNumber: 1, name: "Full opening", path: "/chapter/1" }],
  }) } as unknown as Plugin;
  await syncNovelFromSource(plugin, { name: "Complete book", path: "/book" });
  const full = (await listStoredNovelMetadata())[0]!.metadata;
  save({ ...full, novel: { ...full.novel, summary: null } });
  await initializeWorkMetadata(db, { rebuild: true });
  expect(sqlite.prepare("SELECT summary FROM novel").get()).toEqual({ summary: "Full summary" });
  expect((await listStoredNovelMetadata())[0]!.metadata.novel.summary).toBeNull();

  await syncNovelFromSource(plugin, { name: "Complete book", path: "/book" });
  expect((await listStoredNovelMetadata())[0]!.metadata).toEqual(full);
  const writes = storage.writes;
  await syncNovelFromSource(plugin, { name: "Complete book", path: "/book" });
  expect(storage.writes).toBe(writes);
});

it.each([false, true])("uses the current work document after a slow recovery scan (rebuild: %s)", async (rebuild) => {
  const initial = { ...fixture(), chapters: { "1": "Old opening" } };
  save(initial);
  if (rebuild) await initializeWorkMetadata(db);
  let release!: () => void;
  storage.chapterScan = new Promise<void>(resolve => { release = resolve; });
  storage.chapterLists = 0;
  const recovery = initializeWorkMetadata(db, { rebuild });
  await vi.waitFor(() => expect(storage.chapterLists).toBe(1));
  const current = {
    ...initial, novel: { ...initial.novel, name: "Current title", summary: "Current summary" },
    chapters: { "1": "Current opening", "2": "Current second chapter" },
  };
  save(current);
  release();
  await recovery;

  expect(sqlite.prepare("SELECT name,summary FROM novel").get()).toEqual({ name: "Current title", summary: "Current summary" });
  expect(sqlite.prepare("SELECT name,is_downloaded FROM chapter ORDER BY position").all()).toEqual([
    { name: "Current opening", is_downloaded: 1 }, { name: "Current second chapter", is_downloaded: 0 },
  ]);
  const [file] = await readWorkMetadataSyncFiles();
  expect(file!.fingerprint).toBe(await storedNovelMetadataFingerprint(current));
  expect(storage.writes).toBe(0);
});

it("preserves a plugin novel ID through source sync, work files, upload discovery, and backup restore", async () => {
  const plugin = { id: "source", parseNovel: async () => ({
    novelId: "literal-42", name: "A title unrelated to the ID", path: "/source-route?book=42",
    chapters: [{ chapterNumber: 1.5, name: "Side story", path: "/chapter/side-story" }],
  }) } as unknown as Plugin;
  await syncNovelFromSource(plugin, { name: "A title unrelated to the ID", path: "/source-route?book=42" });
  expect(sqlite.prepare("SELECT source_novel_id FROM novel").get()).toEqual({ source_novel_id: "literal-42" });
  const file = "contents/source/literal-42/novel.json";
  const written = JSON.parse(new TextDecoder().decode(new Uint8Array(storage.files.get(file)!)));
  expect(written.identity).toEqual({ pluginId: "source", novelId: "literal-42", novelPath: "/source-route?book=42" });
  expect(written.chapters).toEqual({ "1.5": "Side story" });
  expect((await listContentSyncChapters())[0]).toMatchObject({ sourceNovelId: "literal-42", novelPath: "/source-route?book=42" });
  const backup = parseBackupManifest(encodeBackupManifest(await gatherBackupSnapshot()));
  expect(backup.novels[0]!.sourceNovelId).toBe("literal-42");
  const restored = await prepareBackupRestore(db, backup);
  expect(restored.manifest.novels[0]!.sourceNovelId).toBe("literal-42");
});

it("rejects source novel ID reuse by another path and ID changes for an existing path", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  const original = storage.files.get(path);
  const differentPath = { ...fixture(), identity: { ...fixture().identity, novelPath: "/another-source-route" } };
  await expect(applyNovelMetadataToCache(db, differentPath)).rejects.toThrow();
  const changedId = { ...fixture(), identity: { ...fixture().identity, novelId: "replacement-id" } };
  await expect(applyNovelMetadataToCache(db, changedId)).rejects.toThrow("novel ID changed");
  const plugin = { id: "source", parseNovel: async () => ({
    novelId: "book", name: "Book", path: "/another-source-route", chapters: [],
  }) } as unknown as Plugin;
  await expect(syncNovelFromSource(plugin, { name: "Book", path: "/another-source-route" })).rejects.toThrow();
  plugin.parseNovel = async () => ({ novelId: "replacement-id", name: "Book", path: "/book", chapters: [] });
  await expect(syncNovelFromSource(plugin, { name: "Book", path: "/book" })).rejects.toThrow("changed a stored novel ID");
  expect(sqlite.prepare("SELECT path,source_novel_id FROM novel").all()).toEqual([{ path: "/book", source_novel_id: "book" }]);
  expect(storage.files.get(path)).toEqual(original);
});

it("persists local chapter titles for file-only recovery from numeric directories", async () => {
  const metadata = fixture();
  metadata.identity = { pluginId: "local", novelId: "local", novelPath: "local" };
  metadata.novel.isLocal = true;
  const novelId = await applyNovelMetadataToCache(db, metadata);
  await db.execute(`INSERT INTO chapter(novel_id,path,name,chapter_number,position,is_downloaded)
    VALUES($1,'local:first','First imported file','1',1,1),($1,'local:second','Second imported file','2',2,1)`, [novelId]);
  await flushWorkMetadata(db);
  const localPath = "contents/local/local/novel.json";
  const original = storage.files.get(localPath)!;
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(original)));
  expect(document.chapters).toEqual({ "1": "First imported file", "2": "Second imported file" });
  storage.chapters.set(localPath, ["contents/local/local/1/content.html", "contents/local/local/2/content.html"]);
  sqlite.exec(`DELETE FROM chapter; DELETE FROM novel; DELETE FROM work_metadata_dirty;
    DELETE FROM work_metadata_file_cache; DELETE FROM work_metadata_directory_cache; DELETE FROM work_metadata_cache_state`);
  await initializeWorkMetadata(db, { rebuild: true });
  expect(sqlite.prepare("SELECT chapter_number,name FROM chapter ORDER BY position").all()).toEqual([
    { chapter_number: "1", name: "First imported file" },
    { chapter_number: "2", name: "Second imported file" },
  ]);
  expect(storage.files.get(localPath)).toEqual(original);
});

it("rebuilds work metadata and completed chapter folders without a DB seed", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT name,in_library FROM novel").get()).toEqual({ name: "Disk title", in_library: 1 });
  expect(sqlite.prepare("SELECT path,is_downloaded FROM chapter").get()).toEqual({ path: "norea-folder:1", is_downloaded: 1 });
  expect(chapterStorageRelativeDir({ id: 1, name: "Renamed" }, { id: 1, name: "Renamed" })).toBe("contents/source/book/1");
  clearResolvedChapterStorageDirs();
  expect(chapterStorageRelativeDir({ id: 1, name: "Renamed" }, { id: 1, name: "Renamed" })).toBe("contents/source/book/1");
});

it("recovers identical plugin-owned IDs in separate sources with complete catalogs and media states", async () => {
  const works = ["source-one", "source-two"].map((pluginId): NovelMetadataV1 => ({
    ...fixture(),
    identity: { pluginId, novelId: "123-%42ook", novelPath: "/works/123" },
    novel: { ...fixture().novel, name: pluginId, artist: "Artist", summary: "Full summary", status: "Completed", genres: "Fantasy", rating: 0 },
    chapters: { "1": `${pluginId}: opening`, "2.5": `${pluginId}: interlude`, "3": `${pluginId}: not downloaded` },
  }));
  for (const metadata of works) {
    const directory = `contents/${metadata.identity.pluginId}/${metadata.identity.novelId}`;
    storage.files.set(`${directory}/novel.json`, [...new TextEncoder().encode(JSON.stringify(metadata))]);
    storage.chapters.set(`${directory}/novel.json`, [`${directory}/1/content.html`, `${directory}/2.5/content.html`]);
    mediaInspections.set(`${directory}/2.5`, false);
  }
  await initializeWorkMetadata(db);
  for (const metadata of works) {
    const novel = sqlite.prepare("SELECT * FROM novel WHERE plugin_id=?").get(metadata.identity.pluginId) as { id: number };
    expect(novel).toMatchObject({ source_novel_id: metadata.identity.novelId, path: metadata.identity.novelPath,
      name: metadata.novel.name, author: "Writer", artist: "Artist", summary: "Full summary", status: "Completed", genres: "Fantasy", rating: 0, in_library: 1 });
    expect(sqlite.prepare(`SELECT chapter_number,name,is_downloaded,media_repair_needed FROM chapter
      WHERE novel_id=? ORDER BY position`).all(novel.id)).toEqual([
      { chapter_number: "1", name: metadata.chapters["1"], is_downloaded: 1, media_repair_needed: 0 },
      { chapter_number: "2.5", name: metadata.chapters["2.5"], is_downloaded: 0, media_repair_needed: 1 },
      { chapter_number: "3", name: metadata.chapters["3"], is_downloaded: 0, media_repair_needed: 0 },
    ]);
    expect(sqlite.prepare("SELECT directory FROM work_metadata_directory_cache WHERE novel_id=? ORDER BY directory").all(novel.id)).toEqual([
      { directory: `contents/${metadata.identity.pluginId}/${metadata.identity.novelId}/1` },
      { directory: `contents/${metadata.identity.pluginId}/${metadata.identity.novelId}/2.5` },
    ]);
  }
  expect(storage.writes).toBe(0);
});

it("restores the full catalog with exact titles and only marks discovered bodies downloaded", async () => {
  save({ ...fixture(), chapters: { "1": "Opening: a question?", "2": "Not downloaded", "3": "The final chapter" } });
  storage.chapters.set(path, ["contents/source/book/1/content.html", "contents/source/book/3/content.html", "contents/source/book/4/content.html"]);
  await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT chapter_number,name,is_downloaded FROM chapter ORDER BY CAST(chapter_number AS REAL)").all()).toEqual([
    { chapter_number: "1", name: "Opening: a question?", is_downloaded: 1 },
    { chapter_number: "2", name: "Not downloaded", is_downloaded: 0 },
    { chapter_number: "3", name: "The final chapter", is_downloaded: 1 },
    { chapter_number: "4", name: "4", is_downloaded: 1 },
  ]);
  const third = sqlite.prepare("SELECT id FROM chapter WHERE chapter_number='3'").get() as { id: number };
  expect(chapterStorageRelativeDir({ id: 1 }, { id: third.id })).toBe("contents/source/book/3");
  expect(storage.writes).toBe(0);
});

it("merges fetched chapter titles and preserves them across download changes and file rescans", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  const read = () => JSON.parse(new TextDecoder().decode(new Uint8Array(storage.files.get(path)!)));
  await flushWorkMetadata(db, { novelId: 1, chapters: { "1": "Opening", "2": "Second", "3": "Third" } });
  expect(read().chapters).toEqual({ "1": "Opening", "2": "Second", "3": "Third" });
  await flushWorkMetadata(db, { novelId: 1, chapters: { "3": "Renamed third", "4": "Fourth" } });
  const expected = { "1": "Opening", "2": "Second", "3": "Renamed third", "4": "Fourth" };
  expect(read().chapters).toEqual(expected);
  const writes = storage.writes;
  await flushWorkMetadata(db, { novelId: 1, chapters: { "4": "Fourth" } });
  await db.execute("UPDATE chapter SET is_downloaded=0"); await flushWorkMetadata(db);
  await db.execute("DELETE FROM chapter"); await flushWorkMetadata(db);
  expect(read().chapters).toEqual(expected);
  expect(storage.writes).toBe(writes);
  await initializeWorkMetadata(db, { rebuild: true });
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter").get()).toEqual({ count: 4 });
});

it("fetches a full catalog before incremental refreshes and publishes source titles to the work file", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  const detail = (numbers: number[]) => ({ novelId: "book", name: "Disk title", path: "/book", chapters: numbers.map(chapterNumber => ({ chapterNumber, name: `Title ${chapterNumber}`, path: `/chapter/${chapterNumber}` })) });
  const plugin = { id: "source", parseNovel: vi.fn(async () => detail([1, 2, 3])), parseNovelSince: vi.fn(async () => detail([3, 4])) } as unknown as Plugin;
  const item = { name: "Disk title", path: "/book" };
  await syncNovelFromSource(plugin, item, { novelId: 1, chapterRefreshMode: "since" });
  expect(plugin.parseNovel).toHaveBeenCalledOnce();
  expect(plugin.parseNovelSince).not.toHaveBeenCalled();
  await syncNovelFromSource(plugin, item, { novelId: 1, chapterRefreshMode: "since" });
  expect(plugin.parseNovelSince).toHaveBeenCalledWith("/book", 3);
  expect(JSON.parse(new TextDecoder().decode(new Uint8Array(storage.files.get(path)!))).chapters).toEqual({ "1": "Title 1", "2": "Title 2", "3": "Title 3", "4": "Title 4" });
  expect(sqlite.prepare("SELECT path,is_downloaded FROM chapter ORDER BY position").all()).toEqual([
    { path: "/chapter/1", is_downloaded: 1 }, { path: "/chapter/2", is_downloaded: 0 }, { path: "/chapter/3", is_downloaded: 0 }, { path: "/chapter/4", is_downloaded: 0 },
  ]);
  vi.mocked(plugin.parseNovelSince).mockResolvedValue(detail([4]));
  const before = sqlite.prepare("SELECT revision FROM work_metadata_sync_journal WHERE plugin_id='source' AND path='/book'").get() as { revision: number };
  const writes = storage.writes;
  await syncNovelFromSource(plugin, item, { novelId: 1, chapterRefreshMode: "since" });
  expect(sqlite.prepare("SELECT revision FROM work_metadata_sync_journal WHERE plugin_id='source' AND path='/book'").get()).toEqual({ revision: before.revision + 1 });
  expect(storage.writes).toBe(writes);
});

it("installs a backed-up catalog without marking unavailable chapters downloaded or dropping known titles", async () => {
  save({ ...fixture(), chapters: { "1": "Opening", "2": "Second" } }); await initializeWorkMetadata(db);
  await installStoredNovelMetadata({ ...fixture(), chapters: { "2": "Corrected second", "3": "Third" } });
  expect(sqlite.prepare("SELECT name,is_downloaded FROM chapter ORDER BY position").all()).toEqual([
    { name: "Opening", is_downloaded: 1 }, { name: "Corrected second", is_downloaded: 0 }, { name: "Third", is_downloaded: 0 },
  ]);
  expect(JSON.parse(new TextDecoder().decode(new Uint8Array(storage.files.get(path)!))).chapters).toEqual({ "1": "Opening", "2": "Corrected second", "3": "Third" });
});

it("restores local reading state when a saved catalog rebuilds deleted cache rows", async () => {
  save({ ...fixture(), chapters: { "1": "Opening", "2": "Second" } }); await initializeWorkMetadata(db);
  await db.execute("UPDATE chapter SET progress=72,bookmark=1,unread=0,read_at=900 WHERE chapter_number='1'");
  await db.execute("DELETE FROM chapter");
  await initializeWorkMetadata(db, { rebuild: true });
  expect(sqlite.prepare("SELECT progress,bookmark,unread,read_at,is_downloaded FROM chapter WHERE chapter_number='1'").get()).toEqual({ progress: 72, bookmark: 1, unread: 0, read_at: 900, is_downloaded: 1 });
  expect(storage.writes).toBe(0);
});

it("refreshes the complete source list after restoring a catalog without source chapter paths", async () => {
  save({ ...fixture(), chapters: { "1": "Opening", "2": "Second", "3": "Third" } }); await initializeWorkMetadata(db);
  const detail = { novelId: "book", name: "Disk title", path: "/book", chapters: [1, 2, 3].map(chapterNumber => ({ chapterNumber, name: `Title ${chapterNumber}`, path: `/chapter/${chapterNumber}` })) };
  const plugin = { id: "source", parseNovel: vi.fn(async () => detail), parseNovelSince: vi.fn(async () => ({ ...detail, chapters: [detail.chapters[2]!] })) } as unknown as Plugin;
  await syncNovelFromSource(plugin, { name: "Disk title", path: "/book" }, { novelId: 1, chapterRefreshMode: "since" });
  expect(plugin.parseNovel).toHaveBeenCalledOnce();
  expect(sqlite.prepare("SELECT path FROM chapter ORDER BY position").all()).toEqual([{ path: "/chapter/1" }, { path: "/chapter/2" }, { path: "/chapter/3" }]);
});

it("resumes incremental fetches after a full refresh leaves archived source chapters unresolved", async () => {
  save({ ...fixture(), chapters: { "1": "Opening", "2": "Removed from the source", "3": "Third" } }); await initializeWorkMetadata(db);
  const detail = { novelId: "book", name: "Disk title", path: "/book", chapters: [1, 3].map(chapterNumber => ({ chapterNumber, name: `Title ${chapterNumber}`, path: `/chapter/${chapterNumber}` })) };
  const plugin = { id: "source", parseNovel: vi.fn(async () => detail), parseNovelSince: vi.fn(async () => ({ ...detail, chapters: [detail.chapters[1]!] })) } as unknown as Plugin;
  const options = { novelId: 1, chapterRefreshMode: "since" as const };
  await syncNovelFromSource(plugin, { name: "Disk title", path: "/book" }, options);
  await syncNovelFromSource(plugin, { name: "Disk title", path: "/book" }, options);
  expect(plugin.parseNovel).toHaveBeenCalledOnce();
  expect(plugin.parseNovelSince).toHaveBeenCalledWith("/book", 3);
  expect(JSON.parse(new TextDecoder().decode(new Uint8Array(storage.files.get(path)!))).chapters['2']).toBe("Removed from the source");
});

it("publishes the first recovered work before reading the next work", async () => {
  save(fixture());
  const secondPath = "contents/source/second/novel.json";
  const second = fixture(); second.identity.novelPath = "/second"; second.identity.novelId = "second";
  storage.files.set(secondPath, [...new TextEncoder().encode(JSON.stringify(second))]);
  let release!: () => void;
  storage.readGates.set(secondPath, new Promise<void>(resolve => { release = resolve; }));
  const recovery = initializeWorkMetadata(db);
  try {
    await vi.waitFor(() => {
      expect(sqlite.prepare("SELECT name FROM novel").all()).toEqual([{ name: "Disk title" }]);
      expect(sqlite.prepare("SELECT is_downloaded FROM chapter").get()).toEqual({ is_downloaded: 1 });
      expect(sqlite.isTransaction).toBe(false);
    });
  } finally {
    release();
    await recovery;
  }
  expect(storage.writes).toBe(0);
});

it("batches a cold recovery of a thousand chapters without per-chapter database calls", async () => {
  save({ ...fixture(), chapters: Object.fromEntries(Array.from({ length: 2001 }, (_, index) => [String(index + 1), `Chapter ${index + 1}`])) });
  storage.chapters.set(path, Array.from({ length: 1001 }, (_, index) => `contents/source/book/${index + 1}/content.html`));
  const execute = vi.spyOn(db, "execute");
  await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter WHERE is_downloaded=1").get()).toEqual({ count: 1001 });
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter").get()).toEqual({ count: 2001 });
  expect(execute.mock.calls.length).toBeLessThan(100);
  expect(storage.writes).toBe(0);
});

it("keeps a newer metadata edit while recovering chapters from an in-flight scan", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  storage.chapters.set(path, ["contents/source/book/1/content.html", "contents/source/book/2/content.html"]);
  let release!: () => void;
  storage.chapterScan = new Promise<void>(resolve => { release = resolve; });
  storage.chapterLists = 0;
  const recovery = initializeWorkMetadata(db, { rebuild: true });
  await vi.waitFor(() => expect(storage.chapterLists).toBe(1));
  await db.execute("UPDATE novel SET name='Edited during recovery' WHERE id=1");
  await flushWorkMetadata(db);
  release();
  await recovery;
  expect(sqlite.prepare("SELECT name FROM novel").get()).toEqual({ name: "Edited during recovery" });
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter WHERE is_downloaded=1").get()).toEqual({ count: 2 });
});

it("reopens the persisted cache without reading work files or rewriting chapters", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  sqlite.exec("CREATE TABLE chapter_updates (id integer); CREATE TRIGGER track_chapter_updates AFTER UPDATE ON chapter BEGIN INSERT INTO chapter_updates VALUES(NEW.id); END");
  storage.lists = 0; storage.reads = 0; storage.directories = {};
  await initializeWorkMetadata(db);
  expect(storage.lists).toBe(0);
  expect(storage.reads).toBe(0);
  expect(sqlite.prepare("SELECT * FROM chapter_updates").all()).toEqual([]);
  expect(novelStorageRelativeDir({ id: 1 })).toBe("contents/source/book");
  expect(chapterStorageRelativeDir({ id: 1 }, { id: 1 })).toBe("contents/source/book/1");
  expect(storage.directories).toEqual({ "1": "contents/source/book/1" });
});

it("keeps authoritative directories available until the complete startup cache is ready", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  const oldDirectory = "contents/source/book";
  const newDirectory = "contents/source/Moved-book";
  await db.execute("UPDATE work_metadata_file_cache SET directory=$1", [newDirectory]);
  await db.execute("UPDATE work_metadata_directory_cache SET directory=$1", [`${newDirectory}/1`]);
  let releaseFiles!: () => void;
  let releaseChapters!: () => void;
  let readingChapters!: () => void;
  const filesGate = new Promise<void>(resolve => { releaseFiles = resolve; });
  const chaptersGate = new Promise<void>(resolve => { releaseChapters = resolve; });
  const chaptersStarted = new Promise<void>(resolve => { readingChapters = resolve; });
  const select = db.select.bind(db);
  const reload = vi.spyOn(db, "select").mockImplementation(async <T>(query: string, params?: unknown[]): Promise<T> => {
    if (query.includes("FROM work_metadata_file_cache")) await filesGate;
    if (query.includes("FROM work_metadata_directory_cache")) { readingChapters(); await chaptersGate; }
    return select<T>(query, params);
  });
  const restore = restoreWorkMetadataDirectories(db, false);
  const expectOriginalPaths = () => {
    expect(knownNovelMetadataDirectory(fixture().identity)).toBe(oldDirectory);
    expect(novelStorageRelativeDir({ id: 1, name: "A later title" })).toBe(oldDirectory);
    expect(chapterStorageRelativeDir({ id: 1 }, { id: 1 })).toBe(`${oldDirectory}/1`);
  };
  try {
    expectOriginalPaths();
    releaseFiles();
    await chaptersStarted;
    expectOriginalPaths();
  } finally {
    releaseFiles();
    releaseChapters();
    await restore;
    reload.mockRestore();
  }
  expect(knownNovelMetadataDirectory(fixture().identity)).toBe(newDirectory);
  expect(novelStorageRelativeDir({ id: 1, name: "A later title" })).toBe(newDirectory);
  expect(chapterStorageRelativeDir({ id: 1 }, { id: 1 })).toBe(`${newDirectory}/1`);
  expect(storage.writes).toBe(0);
});

it("notifies existing cover consumers only when restored work directories change", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  const changed = vi.fn(() => { expect(sqlite.isTransaction).toBe(false); });
  const unsubscribe = subscribeNovelCoverChanges(changed);
  try {
    await restoreWorkMetadataDirectories(db, false);
    expect(changed).not.toHaveBeenCalled();
    await db.execute("UPDATE work_metadata_file_cache SET directory='contents/source/Moved-book'");
    await restoreWorkMetadataDirectories(db, false);
    expect(changed).toHaveBeenCalledExactlyOnceWith(1);
    expect(knownNovelMetadataDirectory(fixture().identity)).toBe("contents/source/Moved-book");
    await restoreWorkMetadataDirectories(db, false);
    expect(changed).toHaveBeenCalledOnce();
  } finally { unsubscribe(); }
});

it("notifies an existing work card after recovery commits its first storage directory", async () => {
  sqlite.exec("INSERT INTO novel(id,plugin_id,path,name) VALUES(1,'source','/book','Disk title')");
  save(fixture());
  const changed = vi.fn(() => {
    expect(sqlite.isTransaction).toBe(false);
    expect(knownNovelMetadataDirectory(fixture().identity)).toBe("contents/source/book");
  });
  const unsubscribe = subscribeNovelCoverChanges(changed);
  try {
    await initializeWorkMetadata(db);
    expect(changed).toHaveBeenCalledExactlyOnceWith(1);
    expect(storage.writes).toBe(0);
  } finally { unsubscribe(); }
});

it("recovers incomplete stored metadata without erasing richer existing fields", async () => {
  sqlite.exec(`INSERT INTO novel(id,plugin_id,path,name,cover,author,artist,summary,status,genres,rating,in_library)
    VALUES(1,'source','/book','Cached title','https://source.test/cover.jpg','Writer','Illustrator','Full summary','Ongoing','Fantasy',4.5,1)`);
  const minimal = { identity: fixture().identity, novel: { name: "Recovered title", artist: " \t\n", summary: "" } };
  const original = [...new TextEncoder().encode(JSON.stringify(minimal))];
  storage.files.set(path, original);
  await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT name,cover,author,artist,summary,status,genres,rating,in_library FROM novel").get()).toEqual({
    name: "Recovered title", cover: "https://source.test/cover.jpg", author: "Writer", artist: "Illustrator",
    summary: "Full summary", status: "Ongoing", genres: "Fantasy", rating: 4.5, in_library: 1,
  });
  expect(storage.files.get(path)).toEqual(original);
  expect(storage.writes).toBe(0);
});

it.each(["rebuild", "rescan"])("preserves populated fields during a partial metadata %s while accepting real updates", async (mode) => {
  const original = fixture();
  original.novel = { ...original.novel, artist: "Illustrator", summary: "Full summary", status: "Ongoing", genres: "Fantasy", rating: 4.5 };
  save(original); await initializeWorkMetadata(db);
  const incoming = fixture();
  incoming.novel = { ...incoming.novel, name: "New title", author: "New writer", artist: " \t\n", rating: 0 };
  save(incoming);
  const bytes = storage.files.get(path);
  if (mode === "rebuild") await initializeWorkMetadata(db, { rebuild: true });
  else await readWorkMetadataSyncFiles(true);
  expect(sqlite.prepare("SELECT name,author,artist,summary,status,genres,rating FROM novel").get()).toEqual({
    name: "New title", author: "New writer", artist: "Illustrator", summary: "Full summary", status: "Ongoing", genres: "Fantasy", rating: 0,
  });
  expect(storage.files.get(path)).toEqual(bytes);
  expect(storage.writes).toBe(0);
});

it("publishes pending metadata after reopening instead of replacing it with the older file", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  const [before] = await readWorkMetadataSyncFiles();
  await db.execute("UPDATE novel SET name='Pending title',author=NULL,summary='Pending summary' WHERE id=1");
  storage.lists = 0;
  await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT name,author,summary FROM novel").get()).toEqual({ name: "Pending title", author: null, summary: "Pending summary" });
  expect(JSON.parse(new TextDecoder().decode(new Uint8Array(storage.files.get(path)!))).novel).toMatchObject({ name: "Pending title", author: null, summary: "Pending summary" });
  expect(sqlite.prepare("SELECT * FROM work_metadata_dirty").all()).toEqual([]);
  expect((await readWorkMetadataSyncFiles())[0]!.revision).toBeGreaterThan(before!.revision);
  expect(storage.lists).toBe(0);
});

it("keeps pending metadata and the external file when restart publication detects a conflict", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  await db.execute("UPDATE novel SET name='Pending title',summary='Pending summary' WHERE id=1");
  save({ ...fixture(), novel: { ...fixture().novel, name: "External title" } });
  const bytes = storage.files.get(path);
  await expect(initializeWorkMetadata(db)).rejects.toThrow("file changed");
  expect(sqlite.prepare("SELECT name,summary FROM novel").get()).toEqual({ name: "Pending title", summary: "Pending summary" });
  expect(sqlite.prepare("SELECT plugin_id,path FROM work_metadata_dirty").all()).toEqual([{ plugin_id: "source", path: "/book" }]);
  expect(storage.files.get(path)).toEqual(bytes);
  expect(storage.writes).toBe(0);
  expect(sqlite.isTransaction).toBe(false);
});

it("retains pending edits during folder recovery and publishes them before the sync snapshot", async () => {
  save({ ...fixture(), chapters: { "1": "Opening", "2": "Second" } }); await initializeWorkMetadata(db);
  const [before] = await readWorkMetadataSyncFiles();
  const bytes = storage.files.get(path);
  await db.execute("UPDATE novel SET name='Pending title',author=NULL,summary='Pending summary' WHERE id=1");
  await db.execute("DELETE FROM chapter WHERE chapter_number='2'");
  await initializeWorkMetadata(db, { rebuild: true });
  expect(sqlite.prepare("SELECT name,author,summary FROM novel").get()).toEqual({ name: "Pending title", author: null, summary: "Pending summary" });
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter").get()).toEqual({ count: 2 });
  expect(sqlite.prepare("SELECT plugin_id,path FROM work_metadata_dirty").all()).toEqual([{ plugin_id: "source", path: "/book" }]);
  expect(storage.files.get(path)).toEqual(bytes);
  expect(storage.writes).toBe(0);
  const [after] = await readWorkMetadataSyncFiles();
  expect(after!.revision).toBeGreaterThan(before!.revision);
  expect(JSON.parse(new TextDecoder().decode(new Uint8Array(storage.files.get(path)!))).novel).toMatchObject({ name: "Pending title", author: null, summary: "Pending summary" });
  expect(sqlite.prepare("SELECT * FROM work_metadata_dirty").all()).toEqual([]);
});

it("still applies an explicit metadata clear outside file recovery", async () => {
  const original = fixture();
  original.novel = { ...original.novel, artist: "Illustrator", summary: "Full summary", status: "Ongoing", genres: "Fantasy", rating: 4.5 };
  save(original); await initializeWorkMetadata(db);
  await applyNovelMetadataToCache(db, { ...fixture(), novel: { ...fixture().novel, author: null } });
  await flushWorkMetadata(db);
  expect(sqlite.prepare("SELECT author,artist,summary,status,genres,rating FROM novel").get()).toEqual({ author: null, artist: null, summary: null, status: null, genres: null, rating: null });
  expect(JSON.parse(new TextDecoder().decode(new Uint8Array(storage.files.get(path)!))).novel.author).toBeNull();
});

it("recovers distinct local chapter sequences and keeps their directory identities", async () => {
  const metadata = fixture();
  metadata.identity = { pluginId: "local", novelId: "local", novelPath: "local" };
  metadata.novel.isLocal = true;
  const localPath = "contents/local/local/novel.json";
  storage.files.set(localPath, [...new TextEncoder().encode(JSON.stringify(metadata))]);
  storage.chapters.set(localPath, [
    "contents/local/local/1/content.html",
    "contents/local/local/2/content.pdf",
  ]);
  await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT path,is_downloaded,stored_content_type FROM chapter ORDER BY id").all()).toEqual([
    { path: "local-folder:1", is_downloaded: 1, stored_content_type: "html" },
    { path: "local-folder:2", is_downloaded: 1, stored_content_type: "pdf" },
  ]);
  await refreshStoredNovelChapterDownloads(1);
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter").get()).toEqual({ count: 2 });
  expect(storage.writes).toBe(0);
});

it("discovers uncached chapter files in one work without reading bodies or other works", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  sqlite.exec("INSERT INTO chapter(novel_id,path,name,chapter_number,position) VALUES(1,'/source-2','Second','2',2)");
  storage.chapters.set(path, [
    "contents/source/book/1/content.html",
    "contents/source/book/2/content.html",
    "contents/source/book/3/content.pdf",
  ]);
  storage.lists = 0; storage.reads = 0; storage.chapterLists = 0;

  await refreshStoredNovelChapterDownloads(1);

  expect(sqlite.prepare("SELECT path,is_downloaded,stored_content_type,position FROM chapter ORDER BY id").all()).toEqual([
    { path: "norea-folder:1", is_downloaded: 1, stored_content_type: "html", position: 1 },
    { path: "/source-2", is_downloaded: 1, stored_content_type: "html", position: 2 },
    { path: "norea-folder:3", is_downloaded: 1, stored_content_type: "pdf", position: 3 },
  ]);
  expect(storage.chapterLists).toBe(1);
  expect(storage.skippedDirectories).toEqual([]);
  expect(storage.lists).toBe(0);
  expect(storage.reads).toBe(0);
  expect(storage.writes).toBe(0);
  expect(chapterStorageRelativeDir({ id: 1 }, { id: 3 })).toBe("contents/source/book/3");
});

it.each(["work", "sync"])("does not restore a downloaded flag after deletion during a %s scan", async (scan) => {
  save(fixture()); await initializeWorkMetadata(db);
  sqlite.exec("UPDATE chapter SET is_downloaded=0 WHERE id=1");
  let finishScan!: () => void;
  storage.chapterScan = new Promise<void>((resolve) => { finishScan = resolve; });
  storage.chapterLists = 0;
  const refresh = scan === "work" ? refreshStoredNovelChapterDownloads(1) : readWorkMetadataSyncFiles(true);
  await vi.waitFor(() => expect(storage.chapterLists).toBe(1));
  await withChapterDownloadDeletion([1], async () => {
    sqlite.exec("UPDATE chapter SET is_downloaded=0 WHERE id=1");
    storage.chapters.set(path, []);
  });
  finishScan();
  await refresh;

  expect(sqlite.prepare("SELECT is_downloaded FROM chapter WHERE id=1").get()).toEqual({ is_downloaded: 0 });
});

it.each(["work", "sync"])("keeps a repair completed after an incomplete snapshot during a %s scan", async (scan) => {
  mediaInspections.set("contents/source/book/1", false);
  save(fixture()); await initializeWorkMetadata(db);
  storage.chapters.set(path, ["contents/source/book/1/content.html", "contents/source/book/2/content.html"]);
  let finishScan!: () => void;
  let inspectingSecondChapter!: () => void;
  const scanGate = new Promise<void>(resolve => { finishScan = resolve; });
  const scanStarted = new Promise<void>(resolve => { inspectingSecondChapter = resolve; });
  mediaInspectionHooks.set("contents/source/book/2", async () => {
    inspectingSecondChapter();
    await scanGate;
  });
  const refresh = scan === "work" ? refreshStoredNovelChapterDownloads(1) : readWorkMetadataSyncFiles(true);
  await scanStarted;

  await withChapterDownloadWrite(1, undefined, async () => {
    mediaInspections.set("contents/source/book/1", true);
    await adoptStoredChapterContentMetadata(1, 1, 8, "html", false);
  });
  finishScan();
  await refresh;

  expect(sqlite.prepare("SELECT is_downloaded,media_repair_needed,media_bytes FROM chapter WHERE id=1").get())
    .toEqual({ is_downloaded: 1, media_repair_needed: 0, media_bytes: 8 });
});

it("reinspects completed app downloads without requiring a previous folder discovery", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  const add = sqlite.prepare("INSERT INTO chapter(novel_id,path,name,chapter_number,position,is_downloaded,stored_content_type) VALUES(1,?,?,?, ?,1,'html')");
  const files = ["contents/source/book/1/content.html"];
  for (let number = 2; number <= 1001; number++) {
    add.run(`/chapter/${number}`, `Chapter ${number}`, String(number), number);
    files.push(`contents/source/book/${number}/content.html`);
  }
  files.push("contents/source/book/1002/content.html");
  storage.chapters.set(path, files);
  storage.chapterLists = 0;
  await refreshStoredNovelChapterDownloads(1);
  expect(storage.chapterLists).toBe(1);
  expect(storage.skippedDirectories).toEqual([]);
  expect(sqlite.prepare("SELECT is_downloaded FROM chapter WHERE chapter_number='1002'").get()).toEqual({ is_downloaded: 1 });
});

it.each(["work", "sync"])("updates completeness on every %s scan while preserving chapter identity and originals", async (scan) => {
  save(fixture()); await initializeWorkMetadata(db);
  const originalFiles = structuredClone(storage.files);
  const rescan = () => scan === "work" ? refreshStoredNovelChapterDownloads(1) : readWorkMetadataSyncFiles(true);
  const current = () => sqlite.prepare("SELECT id,is_downloaded,media_repair_needed,stored_content_type FROM chapter WHERE id=1").get();
  expect(current()).toEqual({ id: 1, is_downloaded: 1, media_repair_needed: 0, stored_content_type: "html" });

  mediaInspections.set("contents/source/book/1", false);
  await rescan();
  expect(current()).toEqual({ id: 1, is_downloaded: 0, media_repair_needed: 1, stored_content_type: "html" });

  mediaInspections.set("contents/source/book/1", true);
  await rescan();
  expect(current()).toEqual({ id: 1, is_downloaded: 1, media_repair_needed: 0, stored_content_type: "html" });
  expect(storage.files).toEqual(originalFiles);
  expect(storage.writes).toBe(0);
});

it("recovers incomplete chapter bodies with a repair flag", async () => {
  mediaInspections.set("contents/source/book/1", false);
  save(fixture()); await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT is_downloaded,media_repair_needed,stored_content_type FROM chapter").get())
    .toEqual({ is_downloaded: 0, media_repair_needed: 1, stored_content_type: "html" });
  expect(sqlite.prepare("SELECT directory FROM work_metadata_directory_cache").get())
    .toEqual({ directory: "contents/source/book/1" });
});

it("restores a thousand cached download flags with bounded database round trips", async () => {
  storage.chapters.set(path, Array.from({ length: 1000 }, (_, index) => `contents/source/book/${index + 1}/content.html`));
  save(fixture()); await initializeWorkMetadata(db);
  sqlite.exec("UPDATE chapter SET is_downloaded=0");
  const execute = vi.spyOn(db, "execute");

  await refreshStoredNovelChapterDownloads(1);

  expect(sqlite.prepare("SELECT SUM(is_downloaded) AS downloaded FROM chapter").get()).toEqual({ downloaded: 1000 });
  expect(execute.mock.calls.filter(([query]) => query.startsWith("UPDATE chapter SET is_downloaded"))).toHaveLength(10);
});

it("does not replace a completed chapter with an uncached folder sharing its number", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  storage.chapters.set(path, [
    "contents/source/book/1/content.html",
    "contents/source/book/1.0/content.html",
  ]);
  await refreshStoredNovelChapterDownloads(1);
  expect(sqlite.prepare("SELECT directory FROM work_metadata_directory_cache WHERE chapter_id=1").get()).toEqual({ directory: "contents/source/book/1" });
});

it("discards a scan after its work was removed from the cache", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  let finishScan!: () => void;
  storage.chapterScan = new Promise<void>((resolve) => { finishScan = resolve; });
  storage.chapterLists = 0;
  const refresh = refreshStoredNovelChapterDownloads(1);
  await vi.waitFor(() => expect(storage.chapterLists).toBe(1));
  sqlite.exec("DELETE FROM chapter; DELETE FROM novel; DELETE FROM work_metadata_file_cache; DELETE FROM work_metadata_directory_cache");
  finishScan();
  await refresh;
  expect(sqlite.prepare("SELECT * FROM work_metadata_directory_cache").all()).toEqual([]);
});

it("keeps work sync revisions across restart without reading unchanged files", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  const before = await readWorkMetadataSyncFiles();
  await initializeWorkMetadata(db);
  storage.lists = 0; storage.reads = 0;
  expect(await readWorkMetadataSyncFiles()).toEqual(before);
  expect(storage.lists).toBe(0);
  expect(storage.reads).toBe(0);
});

it("tracks changed cover bytes even when the metadata descriptor is unchanged", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  const cover = { fileName: "cover.png", contentType: "image/png", body: new Uint8Array([1, 2]) };
  await persistNovelCover("contents/source/book", cover);
  const [before] = await readWorkMetadataSyncFiles();
  await persistNovelCover("contents/source/book", { ...cover, body: new Uint8Array([3, 4]) });
  const [after] = await readWorkMetadataSyncFiles();
  expect(after.fingerprint).toBe(before.fingerprint);
  expect(after.revision).toBeGreaterThan(before.revision);
  await persistNovelCover("contents/source/book", { ...cover, body: new Uint8Array([3, 4]) });
  expect(await readWorkMetadataSyncFiles()).toEqual([after]);
});

it("preserves existing cover bytes and metadata when recovering a display fallback", async () => {
  save(fixture());
  await initializeWorkMetadata(db);
  const directory = "contents/source/book";
  const original = new Uint8Array([8, 9]);
  await persistNovelCover(directory, { fileName: "cover.png", contentType: "image/png", body: original });
  const metadata = [...storage.files.get(path)!];
  const writes = storage.writes;
  const journal = sqlite.prepare("SELECT * FROM work_metadata_sync_journal").all();

  await persistNovelCover(directory, { fileName: "cover.jpg", contentType: "image/jpeg", body: new Uint8Array([1, 2]) }, { preserveExisting: true });

  expect(storage.files.get(`${directory}/cover.png`)).toEqual([...original]);
  expect(storage.files.has(`${directory}/cover.jpg`)).toBe(false);
  expect(storage.files.get(path)).toEqual(metadata);
  expect(storage.writes).toBe(writes);
  expect(sqlite.prepare("SELECT * FROM work_metadata_sync_journal").all()).toEqual(journal);
});

it("checks for a newly installed cover after entering the recovery write transaction", async () => {
  save(fixture());
  await initializeWorkMetadata(db);
  const directory = "contents/source/book";
  databaseClient.transaction.mockImplementationOnce(async (run: (database: Database) => Promise<unknown>) => {
    storage.files.set(`${directory}/cover.png`, [7, 8, 9]);
    sqlite.exec("BEGIN IMMEDIATE");
    try { const result = await run(db); sqlite.exec("COMMIT"); return result; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  });
  const metadata = [...storage.files.get(path)!];
  const writes = storage.writes;

  await persistNovelCover(directory, { fileName: "cover.jpg", contentType: "image/jpeg", body: new Uint8Array([1, 2]) }, { preserveExisting: true });

  expect(storage.files.get(`${directory}/cover.png`)).toEqual([7, 8, 9]);
  expect(storage.files.has(`${directory}/cover.jpg`)).toBe(false);
  expect(storage.files.get(path)).toEqual(metadata);
  expect(storage.writes).toBe(writes);
});

it("installs a missing recovered cover and still permits an explicit cover refresh", async () => {
  save(fixture());
  await initializeWorkMetadata(db);
  const directory = "contents/source/book";
  const cover = { fileName: "cover.jpg", contentType: "image/jpeg", body: new Uint8Array([1, 2]) };
  await persistNovelCover(directory, cover, { preserveExisting: true });
  expect(storage.files.get(`${directory}/cover.jpg`)).toEqual([1, 2]);

  await persistNovelCover(directory, { ...cover, body: new Uint8Array([3, 4]) });
  expect(storage.files.get(`${directory}/cover.jpg`)).toEqual([3, 4]);
});

it("keeps a recovered cover visible when its real publication is rolled back", async () => {
  save(fixture());
  await initializeWorkMetadata(db);
  clearNovelCoverDisplayCache();
  const metadata = [...storage.files.get(path)!];
  const displayNovel = { id: 1, pluginId: "source", path: "/book", name: "Disk title", cover: "https://source.test/cover.jpg" };
  const plugin = { id: "source", version: "1.0.0", url: "https://source.test/plugin.js", getBaseUrl: () => "https://source.test/" } as Plugin;
  const options = { allowSourceFallback: true, plugin };
  const fetch = vi.spyOn(http, "pluginMediaFetch").mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }));
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  try {
    const source = await resolveCachedNovelCoverSrc(displayNovel, options);
    expect(source).toMatch(/^blob:/);
    const snapshot = getNovelCoverSnapshot(1);
    storage.failOncePath = path;

    await expect(persistCachedNovelCoverSource(displayNovel, options)).rejects.toThrow("disk full");

    expect(storage.files.get(path)).toEqual(metadata);
    expect(storage.files.has("contents/source/book/cover.jpg")).toBe(false);
    expect(getNovelCoverSnapshot(1)).toBe(snapshot);
    expect(peekCachedNovelCoverSrc(displayNovel, options)).toBe(source);
    expect(revoke).not.toHaveBeenCalledWith(source);

    await persistCachedNovelCoverSource(displayNovel, options);
    expect(storage.files.get("contents/source/book/cover.jpg")).toEqual([1, 2, 3]);
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    clearNovelCoverDisplayCache();
    fetch.mockRestore();
    revoke.mockRestore();
  }
});

it("bootstraps work tracking before the frontend opens the database", () => {
  sqlite.exec("INSERT INTO novel(id,plugin_id,path,name) VALUES(1,'source','/book','Book')");
  expect(sqlite.prepare("SELECT plugin_id,path FROM work_metadata_dirty").all()).toEqual([{ plugin_id: "source", path: "/book" }]);
  expect(sqlite.prepare("SELECT * FROM work_metadata_file_cache").all()).toEqual([]);
  expect(sqlite.prepare("SELECT * FROM work_metadata_sync_journal").all()).toEqual([]);
  expect(sqlite.prepare("SELECT * FROM work_metadata_directory_cache").all()).toEqual([]);
  expect(sqlite.prepare("SELECT * FROM work_metadata_cache_state").all()).toEqual([]);
});

it("advances work revisions when rebuilding from authoritative files", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  const [before] = await readWorkMetadataSyncFiles();
  await initializeWorkMetadata(db, { rebuild: true });
  const [after] = await readWorkMetadataSyncFiles();
  expect(after.fingerprint).toBe(before.fingerprint);
  expect(after.revision).toBeGreaterThan(before.revision);
  expect(chapterStorageRelativeDir({ id: 1, name: "Renamed" }, { id: 1, name: "Renamed" })).toBe("contents/source/book/1");
  expect(storage.directories["1"]).toBe("contents/source/book/1");
});

it("discovers external work files and metadata changes only on an explicit sync rescan", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  const changed = fixture(); changed.novel.name = "External edit"; save(changed);
  const other = fixture(); other.identity.novelPath = "/other"; other.identity.novelId = "other";
  storage.files.set("contents/source/other/novel.json", [...new TextEncoder().encode(JSON.stringify(other))]);
  expect(await readWorkMetadataSyncFiles()).toHaveLength(1);
  const files = await readWorkMetadataSyncFiles(true);
  expect(files).toHaveLength(2);
  expect(sqlite.prepare("SELECT name FROM novel WHERE path='/book'").get()).toEqual({ name: "External edit" });
  expect(storage.writes).toBe(0);
});

it("recovers incomplete chapter bodies in newly discovered works during a sync rescan", async () => {
  await initializeWorkMetadata(db);
  save(fixture());
  mediaInspections.set("contents/source/book/1", false);

  expect(await readWorkMetadataSyncFiles()).toEqual([]);
  expect(await readWorkMetadataSyncFiles(true)).toHaveLength(1);

  expect(sqlite.prepare("SELECT is_downloaded,media_repair_needed,stored_content_type FROM chapter").get())
    .toEqual({ is_downloaded: 0, media_repair_needed: 1, stored_content_type: "html" });
  expect(sqlite.prepare("SELECT directory FROM work_metadata_directory_cache").get())
    .toEqual({ directory: "contents/source/book/1" });
  expect(storage.directories["1"]).toBe("contents/source/book/1");
  expect(storage.writes).toBe(0);
});

it("keeps metadata edits published while an explicit sync rescan inspects chapter files", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  let finishScan!: () => void;
  storage.chapterScan = new Promise<void>(resolve => { finishScan = resolve; });
  storage.chapterLists = 0;
  const rescan = readWorkMetadataSyncFiles(true);
  await vi.waitFor(() => expect(storage.chapterLists).toBe(1));

  await db.execute("UPDATE novel SET name='Edited while scanning' WHERE id=1");
  await flushWorkMetadata(db);
  finishScan();
  await rescan;

  expect(sqlite.prepare("SELECT name FROM novel").get()).toEqual({ name: "Edited while scanning" });
  await db.execute("UPDATE novel SET name='Edited after scanning' WHERE id=1");
  await expect(flushWorkMetadata(db)).resolves.toBeUndefined();
  expect(JSON.parse(new TextDecoder().decode(new Uint8Array(storage.files.get(path)!))).novel.name)
    .toBe("Edited after scanning");
});

it("does not repeatedly scan an initialized empty library", async () => {
  await initializeWorkMetadata(db);
  storage.lists = 0;
  await initializeWorkMetadata(db);
  expect(storage.lists).toBe(0);
});

it("restores download directories beyond the first startup cache batch", async () => {
  const metadata = fixture();
  storage.chapters.set(path, Array.from({ length: 1001 }, (_, index) => `contents/source/book/${index + 1}/content.html`));
  save(metadata); await initializeWorkMetadata(db);
  storage.lists = 0; storage.reads = 0; storage.directories = {};
  await initializeWorkMetadata(db);
  expect(storage.lists).toBe(0);
  expect(storage.reads).toBe(0);
  expect(chapterStorageRelativeDir({ id: 1 }, { id: 1001 })).toBe("contents/source/book/1001");
  expect(storage.directories["1001"]).toBe("contents/source/book/1001");
});

it("keeps the persisted conflict baseline when files change while the app is closed", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  const changed = fixture(); changed.novel.name = "External edit"; save(changed);
  await initializeWorkMetadata(db);
  sqlite.exec("BEGIN IMMEDIATE");
  await db.execute("UPDATE novel SET name='Local edit' WHERE id=1");
  await expect(flushWorkMetadata(db)).rejects.toThrow("file changed");
  sqlite.exec("ROLLBACK");
  expect(sqlite.prepare("SELECT name FROM novel").get()).toEqual({ name: "Disk title" });
  expect(JSON.parse(new TextDecoder().decode(new Uint8Array(storage.files.get(path)!))).novel.name).toBe("External edit");
});

it("retries interrupted metadata publication without discarding the persisted edit", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  await db.execute("UPDATE novel SET name='Unpublished edit' WHERE id=1");
  storage.failOncePath = path;
  await expect(initializeWorkMetadata(db)).rejects.toThrow("disk full");
  expect(sqlite.prepare("SELECT name FROM novel").get()).toEqual({ name: "Unpublished edit" });
  expect(JSON.parse(new TextDecoder().decode(new Uint8Array(storage.files.get(path)!))).novel.name).toBe("Disk title");
  expect(sqlite.prepare("SELECT plugin_id,path FROM work_metadata_dirty").all()).toEqual([{ plugin_id: "source", path: "/book" }]);
  await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT name FROM novel").get()).toEqual({ name: "Unpublished edit" });
  expect(JSON.parse(new TextDecoder().decode(new Uint8Array(storage.files.get(path)!))).novel.name).toBe("Unpublished edit");
  expect(sqlite.prepare("SELECT * FROM work_metadata_dirty").all()).toEqual([]);
});

it("rescans authoritative metadata only when explicitly rebuilding an existing cache", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  const changed = fixture(); changed.novel.name = "External edit"; save(changed);
  await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT name FROM novel").get()).toEqual({ name: "Disk title" });
  await initializeWorkMetadata(db, { rebuild: true });
  expect(sqlite.prepare("SELECT name FROM novel").get()).toEqual({ name: "External edit" });
});

it("restores the persisted baseline after a transaction and file publication roll back", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  sqlite.exec("BEGIN IMMEDIATE");
  await db.execute("UPDATE novel SET name='Updated title' WHERE id=1");
  storage.failOncePath = path;
  await expect(flushWorkMetadata(db)).rejects.toThrow("disk full");
  sqlite.exec("ROLLBACK");
  await initializeWorkMetadata(db);
  await db.execute("UPDATE novel SET name='After rollback' WHERE id=1");
  await flushWorkMetadata(db);
  expect([...storage.files.keys()]).toEqual([path]);
  expect((await listStoredNovelMetadata())[0]!.metadata).toMatchObject({ identity: fixture().identity, novel: { name: "After rollback" } });
});

it("persists the conflict baseline after changing a cover without dirty novel rows", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  await persistNovelCover("contents/source/book", { fileName: "cover.png", contentType: "image/png", body: new Uint8Array([8, 9]) });
  await initializeWorkMetadata(db);
  await db.execute("UPDATE novel SET name='After cover' WHERE id=1");
  await flushWorkMetadata(db);
  expect((await listStoredNovelMetadata())[0]!.metadata.novel.name).toBe("After cover");
});

it("files replace stale metadata while matching local reading state survives", async () => {
  sqlite.exec("INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/book','Old',1)");
  sqlite.exec("INSERT INTO chapter(novel_id,path,name,position,progress,bookmark,unread) VALUES(1,'norea-folder:1','Old',1,72,1,0)");
  save(fixture()); await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT name,progress,bookmark,unread FROM chapter").get()).toEqual({ name: "Old", progress: 72, bookmark: 1, unread: 0 });
  expect(sqlite.prepare("SELECT in_library FROM novel").get()).toEqual({ in_library: 1 });
});
it("does not export old DB records on startup or when only reading state changes", async () => {
  sqlite.exec("INSERT INTO novel(id,plugin_id,path,name) VALUES(5,'source','/legacy','Legacy')");
  await initializeWorkMetadata(db); await flushWorkMetadata(db);
  expect(storage.files.size).toBe(0);
  await db.execute("UPDATE novel SET last_read_at=100 WHERE id=5"); await flushWorkMetadata(db);
  expect(storage.files.size).toBe(0);
});

it.each(["source", "server"])("restores extensible metadata during %s publication without modifying chapter files", async (origin) => {
  const metadata = fixture();
  const directory = novelStorageRelativeDir({ pluginId: "source", sourceNovelId: metadata.identity.novelId, path: "/book", name: metadata.novel.name });
  const legacy = { ...metadata, novel: { ...metadata.novel, rating: undefined, summary: "Old summary" }, extra: [{ name: "Unrelated field" }], updatedAt: 1 };
  storage.files.set(`${directory}/novel.json`, [...new TextEncoder().encode(JSON.stringify(legacy))]);
  const contentPath = `${directory}/1/content.html`;
  const mediaPath = `${directory}/1/media.zip`;
  storage.files.set(contentPath, [1, 2, 3]);
  storage.files.set(mediaPath, [4, 5, 6]);
  await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM novel").get()).toEqual({ count: 1 });
  expect(JSON.parse(new TextDecoder().decode(new Uint8Array(storage.files.get(`${directory}/novel.json`)!)))).toEqual(JSON.parse(JSON.stringify(legacy)));
  if (origin === "source") {
    await applyNovelMetadataToCache(db, metadata);
    await flushWorkMetadata(db);
  } else {
    await installStoredNovelMetadata(metadata);
  }
  expect(JSON.parse(new TextDecoder().decode(new Uint8Array(storage.files.get(`${directory}/novel.json`)!)))).toEqual({
    ...metadata, novel: { ...metadata.novel, summary: origin === "server" ? "Old summary" : null },
  });
  expect(storage.files.get(contentPath)).toEqual([1, 2, 3]);
  expect(storage.files.get(mediaPath)).toEqual([4, 5, 6]);
  expect([...storage.files.keys()].filter(file => file.endsWith("/novel.json"))).toEqual([`${directory}/novel.json`]);
});

it("does not overwrite a metadata document for another work", async () => {
  const other = { ...fixture(), identity: { pluginId: "other", novelId: "other", novelPath: "/other" } };
  const bytes = [...new TextEncoder().encode(JSON.stringify(other))];
  storage.files.set(path, bytes);
  await expect(writeStoredNovelMetadata("contents/source/book", fixture())).rejects.toThrow("identity");
  expect(storage.files.get(path)).toEqual(bytes);
});
it("does not publish arbitrary chapter cache mutations while retaining directories on rename", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  await db.execute("UPDATE novel SET name='Renamed' WHERE id=1");
  await db.execute("INSERT INTO chapter(novel_id,path,name,position) VALUES(1,'/second','Second',2)");
  await flushWorkMetadata(db);
  expect(novelStorageRelativeDir({ id: 1, name: "Renamed" })).toBe("contents/source/book");
  expect((await listStoredNovelMetadata())[0]!.metadata.chapters).toEqual({});
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter").get()).toEqual({ count: 2 });
  await db.execute("DELETE FROM chapter WHERE path='/second'"); await flushWorkMetadata(db);
  expect((await listStoredNovelMetadata())[0]!.metadata.chapters).toEqual({});
});
it("prevents stale cache overwrites", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  const changed = fixture(); changed.novel.name = "External edit"; save(changed);
  await db.execute("UPDATE novel SET name='Stale mutation' WHERE id=1");
  await expect(flushWorkMetadata(db)).rejects.toThrow("file changed");
  expect((await listStoredNovelMetadata())[0]!.metadata.novel.name).toBe("External edit");
});
it("keeps the previous document when publication fails and removes the document on explicit work deletion", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  await db.execute("UPDATE novel SET name='New' WHERE id=1"); storage.fail = true;
  await expect(flushWorkMetadata(db)).rejects.toThrow("disk full");
  expect((await listStoredNovelMetadata())[0]!.metadata.novel.name).toBe("Disk title");
  storage.fail = false; await db.execute("DELETE FROM novel WHERE id=1"); await flushWorkMetadata(db);
  expect(storage.files.has(path)).toBe(false);
});

it("refreshes work metadata without deleting source chapters or reading state", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  await db.execute("UPDATE chapter SET progress=83,bookmark=1,unread=0,read_at=900 WHERE id=1");
  await db.execute("INSERT INTO chapter(novel_id,path,name,position) VALUES(1,'/undownloaded','Source chapter',2)");
  await applyNovelMetadataToCache(db, fixture());
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter").get()).toEqual({ count: 2 });
  expect(sqlite.prepare("SELECT progress,bookmark,unread,read_at FROM chapter WHERE id=1").get()).toEqual({ progress: 83, bookmark: 1, unread: 0, read_at: 900 });
});

it("does not rewrite identical metadata for chapter-only cache changes", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  const previous = storage.files.get(path);
  await db.execute("INSERT INTO chapter(novel_id,path,name,position) VALUES(1,'/undownloaded','Source chapter',2)");
  await flushWorkMetadata(db);
  expect(storage.writes).toBe(0);
  expect(storage.files.get(path)).toEqual(previous);
  expect(storage.directories["2"]).toBe("contents/source/book/2");
});

it("discovers chapters using unambiguous cached source numbers and preserves undiscovered chapters", async () => {
  sqlite.exec("INSERT INTO novel(id,plugin_id,path,name) VALUES(1,'source','/book','Old')");
  sqlite.exec("INSERT INTO chapter(novel_id,path,name,chapter_number,position,progress) VALUES(1,'/source-1','Source title','1',1,72),(1,'/source-2','Unfinished','2',2,0)");
  save(fixture()); await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT path,name,progress,is_downloaded FROM chapter ORDER BY id").all()).toEqual([
    { path: "/source-1", name: "Source title", progress: 72, is_downloaded: 1 },
    { path: "/source-2", name: "Unfinished", progress: 0, is_downloaded: 0 },
  ]);
});

it("restores an earlier deleted work file when publication of a later work fails", async () => {
  save(fixture());
  const second = fixture(); second.identity.novelPath = "/second"; second.identity.novelId = "second"; second.novel.name = "Second";
  const secondPath = "contents/source/second/novel.json";
  storage.files.set(secondPath, [...new TextEncoder().encode(JSON.stringify(second))]);
  await initializeWorkMetadata(db);
  const original = storage.files.get(path);
  sqlite.exec("BEGIN IMMEDIATE");
  await db.execute("DELETE FROM novel WHERE path='/book'");
  await db.execute("UPDATE novel SET name='Changed' WHERE path='/second'");
  storage.failOncePath = secondPath;
  await expect(flushWorkMetadata(db)).rejects.toThrow("disk full");
  sqlite.exec("ROLLBACK");
  expect(storage.files.get(path)).toEqual(original);
  await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT name FROM novel ORDER BY id").all()).toEqual([{ name: "Disk title" }, { name: "Second" }]);
});

it("materializes local cover bytes and removes the owned cover on an explicit clear", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  await db.execute("UPDATE novel SET is_local=1,cover='data:image/png;base64,AQID' WHERE id=1");
  await flushWorkMetadata(db);
  expect(storage.files.get("contents/source/book/cover.png")).toEqual([1, 2, 3]);
  expect((await listStoredNovelMetadata())[0]!.metadata.cover?.fileName).toBe("cover.png");
  await db.execute("UPDATE novel SET cover=NULL WHERE id=1"); await flushWorkMetadata(db);
  expect(storage.files.has("contents/source/book/cover.png")).toBe(false);
  expect(storage.files.has("contents/source/book/cover.json")).toBe(false);
});

it("minimal remote metadata without cover bytes preserves the stored cover", async () => {
  const metadata = fixture(); metadata.cover = { fileName: "cover.png", contentType: "image/png" };
  save(metadata); await writeStoredNovelCover("contents/source/book", metadata, new Uint8Array([1,2]));
  await initializeWorkMetadata(db);
  await installStoredNovelMetadata({ ...metadata, cover: null });
  expect(storage.files.has("contents/source/book/cover.png")).toBe(true);
  expect(storage.files.has("contents/source/book/cover.json")).toBe(false);
  expect((await listStoredNovelMetadata())[0]!.metadata.cover).toEqual(metadata.cover);
});

it("restores the previous cover after the local metadata publication fails", async () => {
  const metadata = fixture(); metadata.cover = { fileName: "cover.png", contentType: "image/png" };
  save(metadata); await writeStoredNovelCover("contents/source/book", metadata, new Uint8Array([1,2]));
  await initializeWorkMetadata(db);
  storage.failOncePath = path;
  await expect(persistNovelCover("contents/source/book", { fileName: "cover.jpg", contentType: "image/jpeg", body: new Uint8Array([8,9]) })).rejects.toThrow("disk full");
  expect(storage.files.get("contents/source/book/cover.png")).toEqual([1,2]);
  expect((await listStoredNovelMetadata())[0]!.metadata.cover?.fileName).toBe("cover.png");
});

it("checks the caller conflict guard inside the installation transaction before touching files", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  const previous = storage.files.get(path);
  await expect(installStoredNovelMetadata(fixture(), undefined, async () => { throw new Error("local edit"); })).rejects.toThrow("local edit");
  expect(storage.files.get(path)).toEqual(previous);
});

it("skips a stale remote work without rolling back the transaction or reading unrelated files", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  const previous = storage.files.get(path);
  storage.lists = 0;
  const changed = vi.fn();
  const unsubscribe = subscribeWorkMetadataChanges(changed);
  try {
    expect(await installStoredNovelMetadata(fixture(), undefined, async () => false)).toBeNull();
    expect(storage.files.get(path)).toEqual(previous);
    expect(storage.writes).toBe(0);
    expect(storage.lists).toBe(0);
    expect(changed).not.toHaveBeenCalled();
  } finally { unsubscribe(); }
});

it("publishes a complete remote work without scanning unrelated work files or changing library ownership", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  await db.execute("UPDATE novel SET in_library=1 WHERE id=1");
  storage.lists = 0;
  const incoming = fixture(); incoming.novel.name = "Updated remote title";
  const guard = vi.fn(async (current) => {
    expect(current?.directory).toBe("contents/source/book");
    expect(current?.metadata.novel.name).toBe("Disk title");
  });
  await installStoredNovelMetadata(incoming, undefined, guard);
  expect(storage.lists).toBe(0);
  expect(guard).toHaveBeenCalledOnce();
  expect(sqlite.prepare("SELECT name,in_library FROM novel").get()).toEqual({ name: "Updated remote title", in_library: 1 });
});

it.each([true, false])("invalidates only the committed remote cover without scheduling another metadata sync (cover: %s)", async (hasCover) => {
  const metadata = fixture();
  metadata.cover = { fileName: "cover.png", contentType: "image/png" };
  save(metadata); await initializeWorkMetadata(db);
  const otherSnapshot = getNovelCoverSnapshot(999);
  let transactionOpen = false;
  const transaction = databaseClient.transaction.getMockImplementation()!;
  databaseClient.transaction.mockImplementation(async (...args) => {
    transactionOpen = true;
    try { return await transaction(...args); }
    finally { transactionOpen = false; }
  });
  const coverChanged = vi.fn(() => { expect(transactionOpen).toBe(false); });
  const metadataChanged = vi.fn();
  const unsubscribeCover = subscribeNovelCoverChanges(coverChanged);
  const unsubscribeMetadata = subscribeWorkMetadataChanges(metadataChanged);
  try {
    await installStoredNovelMetadata(metadata, hasCover ? new Uint8Array([7, 8]) : undefined);
    expect(coverChanged).toHaveBeenCalledExactlyOnceWith(1);
    expect(getNovelCoverSnapshot(999)).toBe(otherSnapshot);
    expect(metadataChanged).not.toHaveBeenCalled();
  } finally {
    unsubscribeCover();
    unsubscribeMetadata();
  }
});

it("does not rewrite semantically identical documents with different key ordering", async () => {
  const metadata = fixture();
  save({ ...metadata, novel: Object.fromEntries(Object.entries(metadata.novel).reverse()) as NovelMetadataV1["novel"] });
  await writeStoredNovelMetadata("contents/source/book", metadata);
  expect(storage.writes).toBe(0);
});

it("does not rewrite an unchanged cover", async () => {
  const metadata = fixture(); metadata.cover = { fileName: "cover.png", contentType: "image/png" };
  await writeStoredNovelCover("contents/source/book", metadata, new Uint8Array([1, 2]));
  storage.writes = 0;
  await writeStoredNovelCover("contents/source/book", metadata, new Uint8Array([1, 2]));
  expect(storage.writes).toBe(0);
});

it("does not guess chapter ownership when cached chapter numbers are ambiguous", async () => {
  sqlite.exec("INSERT INTO novel(id,plugin_id,path,name) VALUES(1,'source','/book','Old')");
  sqlite.exec("INSERT INTO chapter(novel_id,path,name,chapter_number,position) VALUES(1,'/volume1','First','1',1),(1,'/volume2','Second','1',2)");
  save(fixture()); await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter WHERE is_downloaded=1").get()).toEqual({ count: 0 });
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter").get()).toEqual({ count: 2 });
});

it.each([
  "{broken",
  JSON.stringify({ identity: { pluginId: "source" }, novel: { name: "Missing path" } }),
  JSON.stringify({ ...fixture(), identity: { pluginId: "source", novelPath: "norea-folder:Legacy" } }),
])("skips invalid metadata while rebuilding valid works: %s", async (invalid) => {
  const invalidPath = "contents/source/Invalid/novel.json";
  storage.files.set(invalidPath, [...new TextEncoder().encode(invalid)]);
  save(fixture());
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await initializeWorkMetadata(db);
    expect(sqlite.prepare("SELECT path,name FROM novel").all()).toEqual([{ path: "/book", name: "Disk title" }]);
    expect(warn).toHaveBeenCalledExactlyOnceWith("[work-metadata] skipped invalid metadata", invalidPath);
    expect(storage.writes).toBe(0);
    expect(storage.files.get(invalidPath)).toEqual([...new TextEncoder().encode(invalid)]);
  } finally { warn.mockRestore(); }
});

it("propagates metadata storage read errors", async () => {
  save(fixture()); storage.failReadPath = path;
  await expect(initializeWorkMetadata(db)).rejects.toThrow("storage unavailable");
});

it("skips a work document whose enclosing directory differs from its source novel ID", async () => {
  save(fixture());
  const duplicate = storage.files.get(path)!;
  storage.files.set("contents/source/different/novel.json", duplicate);
  await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT path,source_novel_id FROM novel").all()).toEqual([{ path: "/book", source_novel_id: "book" }]);
  expect(storage.files.get("contents/source/different/novel.json")).toEqual(duplicate);
});


it("restores minimal metadata and local cover files into the cache without rewriting the source", async () => {
  const minimal = { identity: fixture().identity, novel: { name: "Minimal", cover: "https://unused.test/cover.jpg" }, extra: true };
  const original = [...new TextEncoder().encode(JSON.stringify(minimal))];
  storage.files.set(path, original);
  storage.files.set("contents/source/book/cover.jpg", [7, 8]);
  await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT name,cover,author FROM novel").get()).toEqual({ name: "Minimal", cover: null, author: null });
  expect(sqlite.prepare("SELECT is_downloaded FROM chapter").get()).toEqual({ is_downloaded: 1 });
  const [work] = await listStoredNovelMetadata();
  expect(work!.metadata.cover).toEqual({ fileName: "cover.jpg", contentType: "image/jpeg" });
  expect(JSON.stringify(work!.metadata)).not.toContain("https://");
  expect(storage.files.get(path)).toEqual(original);
  expect(storage.writes).toBe(0);
});

it("keeps source cover URLs in the DB cache while omitting them from generated files", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  await db.execute("UPDATE novel SET cover='https://source.test/image.jpg' WHERE id=1");
  await flushWorkMetadata(db);
  await applyNovelMetadataToCache(db, fixture());
  expect(sqlite.prepare("SELECT cover FROM novel").get()).toEqual({ cover: "https://source.test/image.jpg" });
  expect(new TextDecoder().decode(new Uint8Array(storage.files.get(path)!))).not.toContain("https://");
  await persistNovelCover("contents/source/book", { fileName: "cover.jpg", contentType: "image/jpeg", body: new Uint8Array([1, 2]) });
  expect(storage.files.has("contents/source/book/cover.json")).toBe(false);
  expect(new TextDecoder().decode(new Uint8Array(storage.files.get(path)!))).not.toContain("sourceUrl");
});

it("rebuilds editable local cover cache from the cover file", async () => {
  const value = fixture(); value.novel.isLocal = true;
  save(value); storage.files.set("contents/source/book/cover.png", [1, 2, 3]);
  await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT cover FROM novel").get()).toEqual({ cover: "data:image/png;base64,AQID" });
  expect(storage.writes).toBe(0);
});


it("keeps recovered DB metadata through sparse server installation and reopening", async () => {
  const rich = fixture();
  rich.novel = {
    ...rich.novel, author: "Cached author", artist: "Cached artist", summary: "Cached summary",
    status: "Completed", genres: "Fantasy", rating: 4.5,
  };
  save(rich);
  await initializeWorkMetadata(db);
  const partial = fixture();
  partial.novel = { ...partial.novel, author: null };
  save(partial);
  const original = [...storage.files.get(path)!];
  await initializeWorkMetadata(db, { rebuild: true });
  expect(storage.files.get(path)).toEqual(original);
  expect(storage.writes).toBe(0);

  const incoming = {
    ...partial,
    novel: { ...partial.novel, name: "Server title", summary: " \t\n ", genres: "" },
    chapters: { "2": "New server chapter" },
  };
  await installStoredNovelMetadata(incoming);
  const readFields = () => sqlite.prepare("SELECT name,author,artist,summary,status,genres,rating FROM novel").get();
  expect(readFields()).toEqual({
    name: "Server title", author: "Cached author", artist: "Cached artist", summary: "Cached summary",
    status: "Completed", genres: "Fantasy", rating: 4.5,
  });
  expect(sqlite.prepare("SELECT name FROM chapter WHERE chapter_number='2'").get()).toEqual({ name: "New server chapter" });
  expect((await listStoredNovelMetadata())[0]!.metadata.novel).toMatchObject(readFields()!);
  const installedFile = [...storage.files.get(path)!];
  const writes = storage.writes;
  await initializeWorkMetadata(db, { rebuild: true });
  expect(readFields()).toEqual({
    name: "Server title", author: "Cached author", artist: "Cached artist", summary: "Cached summary",
    status: "Completed", genres: "Fantasy", rating: 4.5,
  });
  expect(storage.files.get(path)).toEqual(installedFile);
  expect(storage.writes).toBe(writes);

  await applyNovelMetadataToCache(db, partial);
  expect(readFields()).toEqual({
    name: "Disk title", author: null, artist: null, summary: null, status: null, genres: null, rating: null,
  });
});
