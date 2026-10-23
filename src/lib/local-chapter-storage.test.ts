import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type Database from "@tauri-apps/plugin-sql";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ files: new Map<string, string>(), android: false }));
const database = vi.hoisted(() => ({ get: vi.fn(), transaction: vi.fn() }));
vi.mock("../db/client", () => ({ getDb: database.get, runDatabaseTransaction: database.transaction }));
vi.mock("./tauri-runtime", () => ({ isTauriRuntime: () => true, isAndroidRuntime: () => storage.android }));
vi.mock("./android-storage", () => ({
  deleteAndroidStoragePath: async (directory: string) => {
    for (const path of storage.files.keys()) if (path.startsWith(directory + "/")) storage.files.delete(path);
  },
  renameAndroidStoragePath: async (directory: string, newName: string, allowMissing = false) => {
    const entries = [...storage.files].filter(([path]) => path.startsWith(directory + "/"));
    if (!entries.length) {
      if (allowMissing) return;
      throw new Error("Android storage rename source does not exist");
    }
    const target = directory.slice(0, directory.lastIndexOf("/") + 1) + newName;
    for (const [path, body] of entries) {
      storage.files.delete(path);
      storage.files.set(target + path.slice(directory.length), body);
    }
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, input: {
  oldRelativeDir?: string; newRelativeDir?: string; relativeDir?: string; keepNames?: string[];
  input?: { operation: string };
}) => {
  const remove = (directory: string) => {
    for (const path of storage.files.keys()) if (path.startsWith(directory + "/")) storage.files.delete(path);
  };
  if (command === "chapter_storage_relocate_dir") {
    const entries = [...storage.files].filter(([path]) => path.startsWith(input.oldRelativeDir! + "/"));
    if (!entries.length) return;
    remove(input.newRelativeDir!);
    for (const [path, body] of entries) {
      storage.files.delete(path);
      storage.files.set(input.newRelativeDir! + path.slice(input.oldRelativeDir!.length), body);
    }
    return;
  }
  if (command === "chapter_storage_remove_dir") { remove(input.relativeDir!); return; }
  if (command === "chapter_storage_prune_dir_children") {
    const prefix = input.relativeDir! + "/";
    for (const path of storage.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const child = path.slice(prefix.length).split("/");
      if (child.length > 1 && !input.keepNames!.includes(child[0]!)) storage.files.delete(path);
    }
    return;
  }
  if (input.input?.operation === "register") return {};
  throw new Error(`Unexpected native command: ${command}`);
} }));

import { syncLocalChapterStorageAfterOrderChange } from "./local-chapter-storage";
import { clearAuthoritativeStorageDirs, rememberAuthoritativeChapterStorageDir, resolvedChapterStorageDir } from "./chapter-storage-resolution";

let sqlite: DatabaseSync;
const novel = { id: 1, pluginId: "local", sourceNovelId: "local", name: "Local work", path: "local" };
const previous = [
  { id: 1, name: "First body", chapterNumber: "1", position: 1 },
  { id: 2, name: "Second body", chapterNumber: "2", position: 2 },
];

beforeEach(() => {
  clearAuthoritativeStorageDirs();
  storage.android = false;
  storage.files.clear();
  storage.files.set("contents/local/local/1/content.html", "<p>First chapter bytes</p>");
  storage.files.set("contents/local/local/2/content.html", "<p>Second chapter bytes</p>");
  storage.files.set("contents/local/local/novel.json", "Original metadata bytes");
  rememberAuthoritativeChapterStorageDir(1, "contents/local/local/1");
  rememberAuthoritativeChapterStorageDir(2, "contents/local/local/2");
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  sqlite.exec(`INSERT INTO novel(id,plugin_id,source_novel_id,path,name,is_local) VALUES(1,'local','local','local','Local work',1);
    INSERT INTO chapter(id,novel_id,path,name,chapter_number,position,is_downloaded) VALUES
      (1,1,'local:first','First body','2',2,1), (2,1,'local:second','Second body','1',1,1);
    INSERT INTO work_metadata_directory_cache(chapter_id,novel_id,directory) VALUES
      (1,1,'contents/local/local/1'), (2,1,'contents/local/local/2')`);
  const db = {
    select: async (query: string, params: unknown[] = []) => sqlite.prepare(query).all(Object.fromEntries(params.map((value, i) => [`$${i + 1}`, value])) as never),
    execute: async (query: string, params: unknown[] = []) => {
      const result = sqlite.prepare(query).run(Object.fromEntries(params.map((value, i) => [`$${i + 1}`, value])) as never);
      return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
  } as Database;
  database.get.mockResolvedValue(db);
  database.transaction.mockImplementation(async (run: (db: Database) => Promise<unknown>) => {
    sqlite.exec("BEGIN IMMEDIATE");
    try { const result = await run(db); sqlite.exec("COMMIT"); return result; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  });
});
afterEach(() => { sqlite.close(); clearAuthoritativeStorageDirs(); });

it("moves a downloaded Android chapter past a metadata-only chapter without deleting or stranding its body", async () => {
  storage.android = true;
  storage.files.delete("contents/local/local/2/content.html");
  sqlite.exec("UPDATE chapter SET is_downloaded=0 WHERE id=2");
  await syncLocalChapterStorageAfterOrderChange({
    novel, previousChapters: previous,
    nextChapters: [
      { ...previous[1]!, chapterNumber: "1", position: 1 },
      { ...previous[0]!, chapterNumber: "2", position: 2 },
    ],
  });
  expect(storage.files.get("contents/local/local/2/content.html")).toBe("<p>First chapter bytes</p>");
  expect(storage.files.has("contents/local/local/1/content.html")).toBe(false);
  expect([...storage.files.keys()].some(path => path.includes(".__norea-moving-"))).toBe(false);
  expect(resolvedChapterStorageDir(1)).toBe("contents/local/local/2");
  expect(sqlite.prepare("SELECT chapter_id,directory FROM work_metadata_directory_cache ORDER BY chapter_id").all()).toEqual([
    { chapter_id: 1, directory: "contents/local/local/2" },
    { chapter_id: 2, directory: "contents/local/local/1" },
  ]);
});

it("keeps bodies paired with chapter IDs and updates persistent directories when local chapter numbers swap", async () => {
  await syncLocalChapterStorageAfterOrderChange({
    novel, previousChapters: previous,
    nextChapters: [
      { ...previous[1]!, chapterNumber: "1", position: 1 },
      { ...previous[0]!, chapterNumber: "2", position: 2 },
    ],
  });
  expect(storage.files.get("contents/local/local/1/content.html")).toBe("<p>Second chapter bytes</p>");
  expect(storage.files.get("contents/local/local/2/content.html")).toBe("<p>First chapter bytes</p>");
  expect(storage.files.get("contents/local/local/novel.json")).toBe("Original metadata bytes");
  expect([...storage.files.keys()].some(path => path.includes(".__norea-moving-"))).toBe(false);
  expect(resolvedChapterStorageDir(1)).toBe("contents/local/local/2");
  expect(resolvedChapterStorageDir(2)).toBe("contents/local/local/1");
  expect(sqlite.prepare("SELECT chapter_id,directory FROM work_metadata_directory_cache ORDER BY chapter_id").all()).toEqual([
    { chapter_id: 1, directory: "contents/local/local/2" },
    { chapter_id: 2, directory: "contents/local/local/1" },
  ]);
});
