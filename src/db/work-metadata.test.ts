import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type Database from "@tauri-apps/plugin-sql";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ files: new Map<string, number[]>(), fail: false, failOncePath: "", failReadPath: "", lists: 0, reads: 0, chapters: new Map<string, string[]>(), writes: 0, directories: {} as Record<string, string> }));
const databaseClient = vi.hoisted(() => ({ transaction: vi.fn(), get: vi.fn() }));
vi.mock("./client", () => ({ runDatabaseTransaction: databaseClient.transaction, getDb: databaseClient.get }));
vi.mock("../lib/tauri-runtime", () => ({ isTauriRuntime: () => true, isAndroidRuntime: () => false }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (_command: string, { input }: { input: { operation: string; path: string; body: number[]; reset?: boolean; chapterDirectories?: Record<string, string> } }) => {
  if (input.operation === "list") { storage.lists++; return { paths: [...storage.files.keys()].filter((path) => path.endsWith("/novel.json")) }; }
  if (input.operation === "chapters") return { paths: storage.chapters.get(input.path) ?? [] };
  if (input.operation === "read") { if (storage.failReadPath === input.path) throw new Error("storage unavailable"); storage.reads++; return { body: storage.files.get(input.path) ?? null }; }
  if (input.operation === "register") storage.directories = { ...(input.reset ? {} : storage.directories), ...input.chapterDirectories };
  if (input.operation === "write") {
    if (storage.fail || storage.failOncePath === input.path) { storage.failOncePath = ""; throw new Error("disk full"); }
    storage.writes++; storage.files.set(input.path, input.body);
  }
  if (input.operation === "remove") storage.files.delete(input.path);
  return {};
} }));

import { applyNovelMetadataToCache, flushWorkMetadata, initializeWorkMetadata } from "./work-metadata";
import { installStoredNovelMetadata, listStoredNovelMetadata, persistNovelCover, subscribeWorkMetadataChanges, writeStoredNovelCover, writeStoredNovelMetadata, type NovelMetadataV1 } from "../lib/work-metadata";
import { getNovelCoverSnapshot, subscribeNovelCoverChanges } from "../lib/novel-cover-storage";
import { chapterStorageRelativeDir, novelStorageRelativeDir } from "../lib/chapter-storage-path";
import { clearResolvedChapterStorageDirs } from "../lib/chapter-storage-resolution";

let sqlite: DatabaseSync;
let db: Database;
const path = "contents/source/Original-book/novel.json";
function fixture(): NovelMetadataV1 { return {
  schemaVersion: 1, identity: { pluginId: "source", novelPath: "/book" },
  novel: { name: "Disk title", cover: null, author: "Writer", artist: null, summary: null, status: null, genres: null, rating: null, isLocal: false },
  cover: null,
}; }
function save(metadata: NovelMetadataV1) { storage.files.set(path, [...new TextEncoder().encode(JSON.stringify(metadata))]); }

beforeEach(() => {
  storage.files.clear(); storage.chapters.clear(); storage.chapters.set(path, ["contents/source/Original-book/1-Opening/content.html"]); storage.writes = 0; storage.fail = false; storage.failOncePath = ""; storage.failReadPath = ""; storage.lists = 0; storage.reads = 0; storage.directories = {};
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

it("rebuilds work metadata and completed chapter folders without a DB seed", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT name,in_library FROM novel").get()).toEqual({ name: "Disk title", in_library: 0 });
  expect(sqlite.prepare("SELECT path,is_downloaded FROM chapter").get()).toEqual({ path: "norea-folder:1", is_downloaded: 1 });
  expect(chapterStorageRelativeDir({ id: 1, name: "Renamed" }, { id: 1, name: "Renamed" })).toBe("contents/source/Original-book/1-Opening");
  clearResolvedChapterStorageDirs();
  expect(chapterStorageRelativeDir({ id: 1, name: "Renamed" }, { id: 1, name: "Renamed" })).toBe("contents/source/Original-book/1-Opening");
});

it("reopens the persisted cache without reading work files or rewriting chapters", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  sqlite.exec("CREATE TABLE chapter_updates (id integer); CREATE TRIGGER track_chapter_updates AFTER UPDATE ON chapter BEGIN INSERT INTO chapter_updates VALUES(NEW.id); END");
  storage.lists = 0; storage.reads = 0; storage.directories = {};
  await initializeWorkMetadata(db);
  expect(storage.lists).toBe(0);
  expect(storage.reads).toBe(0);
  expect(sqlite.prepare("SELECT * FROM chapter_updates").all()).toEqual([]);
  expect(novelStorageRelativeDir({ id: 1 })).toBe("contents/source/Original-book");
  expect(chapterStorageRelativeDir({ id: 1 }, { id: 1 })).toBe("contents/source/Original-book/1-Opening");
  expect(storage.directories).toEqual({ "1": "contents/source/Original-book/1-Opening" });
});

it("does not repeatedly scan an initialized empty library", async () => {
  await initializeWorkMetadata(db);
  storage.lists = 0;
  await initializeWorkMetadata(db);
  expect(storage.lists).toBe(0);
});

it("restores download directories beyond the first startup cache batch", async () => {
  const metadata = fixture();
  storage.chapters.set(path, Array.from({ length: 1001 }, (_, index) => `contents/source/Original-book/${index + 1}-Opening/content.html`));
  save(metadata); await initializeWorkMetadata(db);
  storage.lists = 0; storage.reads = 0; storage.directories = {};
  await initializeWorkMetadata(db);
  expect(storage.lists).toBe(0);
  expect(storage.reads).toBe(0);
  expect(chapterStorageRelativeDir({ id: 1 }, { id: 1001 })).toBe("contents/source/Original-book/1001-Opening");
  expect(storage.directories["1001"]).toBe("contents/source/Original-book/1001-Opening");
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

it("recovers interrupted dirty cache writes from authoritative files on startup", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  await db.execute("UPDATE novel SET name='Unpublished edit' WHERE id=1");
  await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT name FROM novel").get()).toEqual({ name: "Disk title" });
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
  await persistNovelCover("contents/source/Original-book", { fileName: "cover.png", sourceUrl: "https://source/new", contentType: "image/png", body: new Uint8Array([8, 9]) });
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

it.each(["source", "server"])("replaces same-work legacy metadata from fresh %s metadata without touching chapter files", async (origin) => {
  const metadata = fixture();
  const directory = novelStorageRelativeDir({ pluginId: "source", path: "/book", name: metadata.novel.name });
  const legacy = { ...metadata, novel: { ...metadata.novel, rating: undefined, summary: "Old summary" }, chapters: [{ path: "/old", name: "Old chapter" }], updatedAt: 1 };
  storage.files.set(`${directory}/novel.json`, [...new TextEncoder().encode(JSON.stringify(legacy))]);
  const contentPath = `${directory}/1-Opening/content.html`;
  const mediaPath = `${directory}/1-Opening/media.zip`;
  storage.files.set(contentPath, [1, 2, 3]);
  storage.files.set(mediaPath, [4, 5, 6]);
  await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM novel").get()).toEqual({ count: 0 });
  if (origin === "source") {
    await applyNovelMetadataToCache(db, metadata);
    await flushWorkMetadata(db);
  } else {
    await installStoredNovelMetadata(metadata);
  }
  expect(JSON.parse(new TextDecoder().decode(new Uint8Array(storage.files.get(`${directory}/novel.json`)!)))).toEqual(metadata);
  expect(storage.files.get(contentPath)).toEqual([1, 2, 3]);
  expect(storage.files.get(mediaPath)).toEqual([4, 5, 6]);
  expect([...storage.files.keys()].filter(file => file.endsWith("/novel.json"))).toEqual([`${directory}/novel.json`]);
});

it("does not overwrite another work when replacing an obsolete metadata document", async () => {
  const legacy = { ...fixture(), identity: { pluginId: "other", novelPath: "/other" }, chapters: [], updatedAt: 1 };
  const bytes = [...new TextEncoder().encode(JSON.stringify(legacy))];
  storage.files.set(path, bytes);
  await expect(writeStoredNovelMetadata("contents/source/Original-book", fixture())).rejects.toThrow("identity");
  expect(storage.files.get(path)).toEqual(bytes);
});
it("keeps plugin chapter lists in the DB while retaining directories on rename", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  await db.execute("UPDATE novel SET name='Renamed' WHERE id=1");
  await db.execute("INSERT INTO chapter(novel_id,path,name,position) VALUES(1,'/second','Second',2)");
  await flushWorkMetadata(db);
  expect(novelStorageRelativeDir({ id: 1, name: "Renamed" })).toBe("contents/source/Original-book");
  expect((await listStoredNovelMetadata())[0]!.metadata).not.toHaveProperty("chapters");
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter").get()).toEqual({ count: 2 });
  await db.execute("DELETE FROM chapter WHERE path='/second'"); await flushWorkMetadata(db);
  expect((await listStoredNovelMetadata())[0]!.metadata).not.toHaveProperty("chapters");
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
  expect(storage.directories["2"]).toBe("contents/source/Original-book/2-Source-chapter");
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
  const second = fixture(); second.identity.novelPath = "/second"; second.novel.name = "Second";
  const secondPath = "contents/source/Second-source/novel.json";
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
  await db.execute("UPDATE novel SET cover='data:image/png;base64,AQID' WHERE id=1");
  await flushWorkMetadata(db);
  expect(storage.files.get("contents/source/Original-book/cover.png")).toEqual([1, 2, 3]);
  expect((await listStoredNovelMetadata())[0]!.metadata.cover?.fileName).toBe("cover.png");
  await db.execute("UPDATE novel SET cover=NULL WHERE id=1"); await flushWorkMetadata(db);
  expect(storage.files.has("contents/source/Original-book/cover.png")).toBe(false);
  expect(storage.files.has("contents/source/Original-book/cover.json")).toBe(false);
});

it("remote metadata with no cover bytes removes an older cover even if its descriptor remains", async () => {
  const metadata = fixture(); metadata.cover = { fileName: "cover.png", sourceUrl: "https://source/cover", contentType: "image/png" };
  save(metadata); await writeStoredNovelCover("contents/source/Original-book", metadata, new Uint8Array([1,2]));
  await initializeWorkMetadata(db);
  await installStoredNovelMetadata(metadata);
  expect(storage.files.has("contents/source/Original-book/cover.png")).toBe(false);
  expect(storage.files.has("contents/source/Original-book/cover.json")).toBe(false);
  expect((await listStoredNovelMetadata())[0]!.metadata.cover).toEqual(metadata.cover);
});

it("restores the previous cover after the local metadata publication fails", async () => {
  const metadata = fixture(); metadata.cover = { fileName: "cover.png", sourceUrl: "https://source/old", contentType: "image/png" };
  save(metadata); await writeStoredNovelCover("contents/source/Original-book", metadata, new Uint8Array([1,2]));
  await initializeWorkMetadata(db);
  storage.failOncePath = path;
  await expect(persistNovelCover("contents/source/Original-book", { fileName: "cover.png", sourceUrl: "https://source/new", contentType: "image/png", body: new Uint8Array([8,9]) })).rejects.toThrow("disk full");
  expect(storage.files.get("contents/source/Original-book/cover.png")).toEqual([1,2]);
  expect((await listStoredNovelMetadata())[0]!.metadata.cover?.sourceUrl).toBe("https://source/old");
});

it("checks the caller conflict guard inside the installation transaction before touching files", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  const previous = storage.files.get(path);
  await expect(installStoredNovelMetadata(fixture(), undefined, async () => { throw new Error("local edit"); })).rejects.toThrow("local edit");
  expect(storage.files.get(path)).toEqual(previous);
});

it("publishes a complete remote work without scanning unrelated work files or changing library ownership", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  await db.execute("UPDATE novel SET in_library=1 WHERE id=1");
  storage.lists = 0;
  const incoming = fixture(); incoming.novel.name = "Updated remote title";
  const guard = vi.fn(async (current) => {
    expect(current?.directory).toBe("contents/source/Original-book");
    expect(current?.metadata.novel.name).toBe("Disk title");
  });
  await installStoredNovelMetadata(incoming, undefined, guard);
  expect(storage.lists).toBe(0);
  expect(guard).toHaveBeenCalledOnce();
  expect(sqlite.prepare("SELECT name,in_library FROM novel").get()).toEqual({ name: "Updated remote title", in_library: 1 });
});

it.each([true, false])("invalidates only the committed remote cover without scheduling another metadata sync (cover: %s)", async (hasCover) => {
  const metadata = fixture();
  metadata.cover = { fileName: "cover.png", sourceUrl: "https://source/cover", contentType: "image/png" };
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
  await writeStoredNovelMetadata("contents/source/Original-book", metadata);
  expect(storage.writes).toBe(0);
});

it("does not rewrite an unchanged cover or sidecar", async () => {
  const metadata = fixture(); metadata.cover = { fileName: "cover.png", sourceUrl: "https://source/cover", contentType: "image/png" };
  await writeStoredNovelCover("contents/source/Original-book", metadata, new Uint8Array([1, 2]));
  storage.writes = 0;
  await writeStoredNovelCover("contents/source/Original-book", metadata, new Uint8Array([1, 2]));
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
  JSON.stringify({ ...fixture(), chapters: [], updatedAt: 1 }),
  JSON.stringify({ ...fixture(), identity: { pluginId: "source", novelPath: "norea-folder:Legacy" } }),
])("skips invalid legacy metadata while rebuilding valid works: %s", async (invalid) => {
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

it("rejects duplicate valid work identities instead of silently choosing one", async () => {
  save(fixture());
  storage.files.set("contents/source/Duplicate/novel.json", storage.files.get(path)!);
  await expect(initializeWorkMetadata(db)).rejects.toThrow("duplicate work");
});
