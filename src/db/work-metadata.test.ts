import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type Database from "@tauri-apps/plugin-sql";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ files: new Map<string, number[]>(), fail: false, failOncePath: "" }));
const databaseClient = vi.hoisted(() => ({ transaction: vi.fn(), get: vi.fn() }));
vi.mock("./client", () => ({ runDatabaseTransaction: databaseClient.transaction, getDb: databaseClient.get }));
vi.mock("../lib/tauri-runtime", () => ({ isTauriRuntime: () => true, isAndroidRuntime: () => false }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (_command: string, { input }: { input: { operation: string; path: string; body: number[] } }) => {
  if (input.operation === "list") return { paths: [...storage.files.keys()].filter((path) => path.endsWith("/novel.json")) };
  if (input.operation === "read") return { body: storage.files.get(input.path) ?? null };
  if (input.operation === "write") {
    if (storage.fail || storage.failOncePath === input.path) { storage.failOncePath = ""; throw new Error("disk full"); }
    storage.files.set(input.path, input.body);
  }
  if (input.operation === "remove") storage.files.delete(input.path);
  return {};
} }));

import { applyNovelMetadataToCache, flushWorkMetadata, initializeWorkMetadata } from "./work-metadata";
import { installStoredNovelMetadata, listStoredNovelMetadata, persistNovelCover, writeStoredNovelCover, type NovelMetadataV1 } from "../lib/work-metadata";
import { chapterStorageRelativeDir, novelStorageRelativeDir } from "../lib/chapter-storage-path";
import { clearResolvedChapterStorageDirs } from "../lib/chapter-storage-resolution";

let sqlite: DatabaseSync;
let db: Database;
const path = "contents/source/Original-book/novel.json";
function fixture(): NovelMetadataV1 { return {
  schemaVersion: 1, identity: { pluginId: "source", novelPath: "/book" },
  novel: { name: "Disk title", cover: null, author: "Writer", artist: null, summary: null, status: null, genres: null, isLocal: false },
  chapters: [{ path: "/chapter?exact=1", name: "Opening", chapterNumber: "1", position: 1, page: "1", contentType: "html", releaseTime: null, directory: "exact-folder" }],
  cover: null, updatedAt: 1,
}; }
function save(metadata: NovelMetadataV1) { storage.files.set(path, [...new TextEncoder().encode(JSON.stringify(metadata))]); }

beforeEach(() => {
  storage.files.clear(); storage.fail = false; storage.failOncePath = "";
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

it("rebuilds a metadata-only work and its complete chapter catalog without a DB seed", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT name,in_library FROM novel").get()).toEqual({ name: "Disk title", in_library: 0 });
  expect(sqlite.prepare("SELECT path,is_downloaded FROM chapter").get()).toEqual({ path: "/chapter?exact=1", is_downloaded: 0 });
  expect(chapterStorageRelativeDir({ id: 1, name: "Renamed" }, { id: 1, name: "Renamed" })).toBe("contents/source/Original-book/exact-folder");
  clearResolvedChapterStorageDirs();
  expect(chapterStorageRelativeDir({ id: 1, name: "Renamed" }, { id: 1, name: "Renamed" })).toBe("contents/source/Original-book/exact-folder");
});
it("files replace stale metadata while matching local reading state survives", async () => {
  sqlite.exec("INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/book','Old',1)");
  sqlite.exec("INSERT INTO chapter(novel_id,path,name,position,progress,bookmark,unread) VALUES(1,'/chapter?exact=1','Old',1,72,1,0)");
  save(fixture()); await initializeWorkMetadata(db);
  expect(sqlite.prepare("SELECT name,progress,bookmark,unread FROM chapter").get()).toEqual({ name: "Opening", progress: 72, bookmark: 1, unread: 0 });
  expect(sqlite.prepare("SELECT in_library FROM novel").get()).toEqual({ in_library: 1 });
});
it("does not export old DB records on startup or when only reading state changes", async () => {
  sqlite.exec("INSERT INTO novel(id,plugin_id,path,name) VALUES(5,'source','/legacy','Legacy')");
  await initializeWorkMetadata(db); await flushWorkMetadata(db);
  expect(storage.files.size).toBe(0);
  await db.execute("UPDATE novel SET last_read_at=100 WHERE id=5"); await flushWorkMetadata(db);
  expect(storage.files.size).toBe(0);
});
it("publishes new undownloaded chapters, retains directory on rename, and removes deleted chapter metadata", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  await db.execute("UPDATE novel SET name='Renamed' WHERE id=1");
  await db.execute("INSERT INTO chapter(novel_id,path,name,position) VALUES(1,'/second','Second',2)");
  await flushWorkMetadata(db);
  expect(novelStorageRelativeDir({ id: 1, name: "Renamed" })).toBe("contents/source/Original-book");
  expect((await listStoredNovelMetadata())[0]!.metadata.chapters).toHaveLength(2);
  await db.execute("DELETE FROM chapter WHERE path='/second'"); await flushWorkMetadata(db);
  expect((await listStoredNovelMetadata())[0]!.metadata.chapters).toHaveLength(1);
});
it("rejects malformed authoritative files and prevents stale cache overwrites", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  const changed = fixture(); changed.novel.name = "External edit"; save(changed);
  await db.execute("UPDATE novel SET name='Stale mutation' WHERE id=1");
  await expect(flushWorkMetadata(db)).rejects.toThrow("file changed");
  expect((await listStoredNovelMetadata())[0]!.metadata.novel.name).toBe("External edit");
  storage.files.set(path, [123]);
  await expect(initializeWorkMetadata(db)).rejects.toThrow("invalid");
});
it("keeps the previous document when publication fails and removes the document on explicit work deletion", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  await db.execute("UPDATE novel SET name='New' WHERE id=1"); storage.fail = true;
  await expect(flushWorkMetadata(db)).rejects.toThrow("disk full");
  expect((await listStoredNovelMetadata())[0]!.metadata.novel.name).toBe("Disk title");
  storage.fail = false; await db.execute("DELETE FROM novel WHERE id=1"); await flushWorkMetadata(db);
  expect(storage.files.has(path)).toBe(false);
});

it("retains reading state when a chapter disappears and later returns in the authoritative catalog", async () => {
  save(fixture()); await initializeWorkMetadata(db);
  await db.execute("UPDATE chapter SET progress=83,bookmark=1,unread=0,read_at=900 WHERE id=1");
  const removed = fixture(); removed.chapters = [];
  await applyNovelMetadataToCache(db, removed);
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter").get()).toEqual({ count: 0 });
  await applyNovelMetadataToCache(db, fixture());
  expect(sqlite.prepare("SELECT progress,bookmark,unread,read_at FROM chapter").get()).toEqual({ progress: 83, bookmark: 1, unread: 0, read_at: 900 });
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
