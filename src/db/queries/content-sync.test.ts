import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ getDb: vi.fn(), runDatabaseTransaction: vi.fn() }));
import { getDb, runDatabaseTransaction } from "../client";
import { importContentMetadata, listContentSyncChapters, readContentState, applyContentState, readContentSyncCache, writeContentSyncCache } from "./content-sync";

let sqlite: DatabaseSync;
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
  sqlite.exec("ALTER TABLE chapter ADD COLUMN stored_content_type text");
  sqlite.exec("CREATE TABLE content_sync_cache(cache_key text PRIMARY KEY NOT NULL,payload text NOT NULL)");
  const db = {
    select: async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value])) as never),
    execute: async (sql: string, params: unknown[] = []) => {
      const result = sqlite.prepare(sql).run(Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value])) as never);
      return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
  };
  vi.mocked(getDb).mockResolvedValue(db as never);
  vi.mocked(runDatabaseTransaction).mockImplementation(async (run) => run(db as never));
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
  expect(row).toMatchObject({ chapterId: imported.chapterId, progress: 73, bookmark: true, isDownloaded: true });
  expect(sqlite.prepare("SELECT name FROM chapter").get()).toEqual({ name: "Opening" });
});

it("applies account state without deleting files or changing numeric identity", async () => {
  const { chapterId } = await importContentMetadata(manifest);
  sqlite.exec(`UPDATE chapter SET is_downloaded=1 WHERE id=${chapterId}`);
  await applyContentState('library:["source","/work",""]', { deleted: false });
  await applyContentState('read:["source","/work","/chapter"]', { unread: false, progress: 100 });
  await applyContentState('bookmark:["source","/work","/chapter"]', { deleted: false });
  const state = await readContentState();
  expect(state['library:["source","/work",""]']).toEqual({ deleted: false });
  expect(state['read:["source","/work","/chapter"]']).toEqual({ unread: false, progress: 100 });
  expect(state['bookmark:["source","/work","/chapter"]']).toEqual({ deleted: false });
  expect(sqlite.prepare("SELECT id,is_downloaded FROM chapter").get()).toEqual({ id: chapterId, is_downloaded: 1 });
});

it("keeps an intentional older server position while preserving chapter history", async () => {
  const first = await importContentMetadata(manifest);
  await importContentMetadata({ ...manifest, identity: { ...manifest.identity, chapterPath: "/later" }, chapter: { ...manifest.chapter, position: 2 } });
  sqlite.exec("UPDATE chapter SET read_at=200,progress=90 WHERE path='/later'");
  await applyContentState('position:["source","/work",""]', { chapterPath: "/chapter", progress: 20, readAt: 150 });
  const state = await readContentState({ [first.novelId]: first.chapterId });
  expect(state['position:["source","/work",""]']).toEqual({ chapterPath: "/chapter", progress: 20, readAt: 150 });
  expect(sqlite.prepare("SELECT read_at FROM chapter WHERE path='/later'").get()).toEqual({ read_at: 200 });
});

it("clears all previous-account reading history for an empty server position", async () => {
  await importContentMetadata(manifest);
  await importContentMetadata({ ...manifest, identity: { ...manifest.identity, chapterPath: "/later" }, chapter: { ...manifest.chapter, position: 2 } });
  sqlite.exec("UPDATE chapter SET read_at=200");
  await applyContentState('position:["source","/work",""]', { chapterPath: "/later", progress: 0, readAt: null });
  expect((await readContentState())['position:["source","/work",""]']).toBeUndefined();
});

it("stores catalog data larger than WebView localStorage without crossing account keys", async () => {
  const payload = JSON.stringify({ items: "a".repeat(6 * 1024 * 1024) });
  await writeContentSyncCache("catalog:one", payload);
  expect(await readContentSyncCache("catalog:one")).toBe(payload);
  expect(await readContentSyncCache("catalog:two")).toBeNull();
});
