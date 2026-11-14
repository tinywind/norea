import { DatabaseSync } from "node:sqlite";
import type { TestSqliteDatabase as Database } from "../test/sql/types";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./tauri-runtime", () => ({ isTauriRuntime: () => true, isAndroidRuntime: () => false }));
vi.mock("./chapter-storage-transfer", () => ({
  finalizeChapterStorageTransfer: vi.fn(),
  rollbackChapterStorageTransfer: vi.fn(),
  removeChapterStorageDirectory: vi.fn(),
}));
vi.mock("./work-metadata", () => ({ workMetadataOperation: vi.fn() }));
vi.mock("../db/work-metadata", () => ({ flushPendingWorkMetadata: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { createNovelMergeIpcHandler } from "../test/mock-novel-merge-ipc";
import { finalizeChapterStorageTransfer, rollbackChapterStorageTransfer, removeChapterStorageDirectory } from "./chapter-storage-transfer";
import { workMetadataOperation } from "./work-metadata";
import { commitNovelMergeStorage, createNovelMergeStorageJournal, recoverNovelMergeStorage, saveNovelMergeStoragePreparation } from "./novel-merge-storage";
import type { ChapterCompositionV1 } from "./chapter-composition";

let sql: DatabaseSync;
let db: Database;
const source = { id: 1, pluginId: "source-a", sourceNovelId: "a", path: "/a" };
const target = { id: 2, pluginId: "source-b", sourceNovelId: "b", path: "/b" };
const entries = [{ entryId: "11", sourceRelativeDir: "contents/source-a/a/1", targetRelativeDir: "contents/source-b/b/2" }];
let files: Map<string, string>;

beforeEach(() => {
  vi.resetAllMocks();
  sql = new DatabaseSync(":memory:");
  sql.exec(`CREATE TABLE novel(id INTEGER PRIMARY KEY,plugin_id TEXT,source_novel_id TEXT,path TEXT);
    INSERT INTO novel VALUES(1,'source-a','a','/a'),(2,'source-b','b','/b');
    CREATE TABLE content_sync_cache(cache_key TEXT PRIMARY KEY,payload TEXT);
    CREATE TABLE work_metadata_file_cache(novel_id INTEGER PRIMARY KEY,fingerprint TEXT);
    INSERT INTO work_metadata_file_cache VALUES(1,'source-fingerprint'),(2,'target-fingerprint');`);
  const bindings = (values: unknown[] = []) => Object.fromEntries(values.map((v, i) => ["$" + (i + 1), v]));
  db = {
    select: async (query: string, values?: unknown[]) => sql.prepare(query).all(bindings(values) as never),
    execute: async (query: string, values?: unknown[]) => ({ rowsAffected: Number(sql.prepare(query).run(bindings(values) as never).changes) }),
  } as Database;
  const ipc = createNovelMergeIpcHandler({
    getDb: async () => db,
    runTransaction: async (run) => run(db),
  });
  vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
    const handled = await ipc.handle(command, (args as Record<string, unknown>) ?? {});
    if (handled.handled) return handled.result as never;
    throw new Error(`Unexpected IPC command: ${command}`);
  });
  files = new Map([["contents/source-a/a/novel.json", "source-before"], ["contents/source-b/b/novel.json", "target-before"]]);
  vi.mocked(workMetadataOperation).mockImplementation(async input => {
    if (input.operation === "write") files.set(input.path!, input.body!);
    if (input.operation === "remove") files.delete(input.path!);
    return { body: files.get(input.path!) ?? null };
  });
});
afterEach(() => sql.close());

it("recovers a process stopped after a folder move but before the native receipt was saved", async () => {
  await createNovelMergeStorageJournal(source, target, entries, ["contents/source-a/a"]);
  files.delete("contents/source-a/a/novel.json");
  await recoverNovelMergeStorage();
  expect(rollbackChapterStorageTransfer).toHaveBeenCalledWith(expect.objectContaining({
    entries: [expect.objectContaining({ ...entries[0], outcome: "movedSource", replacedTarget: true })],
  }));
  expect(files.get("contents/source-a/a/novel.json")).toBe("source-before");
  expect(files.get("contents/source-b/b/novel.json")).toBe("target-before");
  expect(sql.prepare("SELECT * FROM content_sync_cache").all()).toEqual([]);
  expect(removeChapterStorageDirectory).not.toHaveBeenCalled();
});

it("finalizes a committed move after restart and removes only source work roots", async () => {
  const job = await createNovelMergeStorageJournal(source, target, entries, ["contents/source-a/a/1", "contents/source-a/a"]);
  const preparation = { token: job.token, entries: [{ ...entries[0]!, outcome: "movedSource" as const, replacedTarget: false,
    contentFile: "contents/source-b/b/2/content.html", contentBytes: 12, mediaBytes: 0 }] };
  await saveNovelMergeStoragePreparation(job, preparation);
  sql.exec("BEGIN");
  await commitNovelMergeStorage(job.token);
  sql.exec("DELETE FROM novel WHERE id=1; COMMIT");
  files.set("contents/source-b/b/novel.json", "committed-target");
  await recoverNovelMergeStorage();
  await recoverNovelMergeStorage();
  expect(finalizeChapterStorageTransfer).toHaveBeenCalledExactlyOnceWith(preparation);
  expect(rollbackChapterStorageTransfer).not.toHaveBeenCalled();
  expect(removeChapterStorageDirectory).toHaveBeenCalledExactlyOnceWith("contents/source-a/a");
  expect(files.get("contents/source-b/b/novel.json")).toBe("committed-target");
});

it("retains the recovery journal when folder restoration fails", async () => {
  await createNovelMergeStorageJournal(source, target, entries, ["contents/source-a/a"]);
  vi.mocked(rollbackChapterStorageTransfer).mockRejectedValueOnce(new Error("Source path is occupied"));
  await expect(recoverNovelMergeStorage()).rejects.toThrow("Source path is occupied");
  expect(sql.prepare("SELECT count(*) AS count FROM content_sync_cache").get()).toEqual({ count: 1 });
  expect(removeChapterStorageDirectory).not.toHaveBeenCalled();
  await recoverNovelMergeStorage();
  expect(sql.prepare("SELECT * FROM content_sync_cache").all()).toEqual([]);
});

it("recovers only the locked work before a retry in the same process", async () => {
  await createNovelMergeStorageJournal(source, target, entries, ["contents/source-a/a"]);
  await recoverNovelMergeStorage([99]);
  expect(rollbackChapterStorageTransfer).not.toHaveBeenCalled();
  await recoverNovelMergeStorage([1]);
  expect(rollbackChapterStorageTransfer).toHaveBeenCalledOnce();
});

it("keeps the preparing phase when the merge transaction rolls back", async () => {
  const job = await createNovelMergeStorageJournal(source, target, entries, ["contents/source-a/a"]);
  sql.exec("BEGIN");
  await commitNovelMergeStorage(job.token);
  sql.exec("ROLLBACK");
  await recoverNovelMergeStorage();
  expect(rollbackChapterStorageTransfer).toHaveBeenCalledOnce();
  expect(finalizeChapterStorageTransfer).not.toHaveBeenCalled();
});

it("refuses recovery after the original work identity or metadata changed", async () => {
  await createNovelMergeStorageJournal(source, target, entries, ["contents/source-a/a"]);
  sql.exec("UPDATE work_metadata_file_cache SET fingerprint='outside-edit' WHERE novel_id=2");
  await expect(recoverNovelMergeStorage()).rejects.toThrow(/changed/);
  expect(rollbackChapterStorageTransfer).not.toHaveBeenCalled();
});

it("retains files and the journal when metadata was edited outside the interrupted merge", async () => {
  await createNovelMergeStorageJournal(source, target, entries, ["contents/source-a/a"]);
  files.set("contents/source-b/b/novel.json", "outside-edit");
  await expect(recoverNovelMergeStorage()).rejects.toThrow(/metadata changed/);
  expect(rollbackChapterStorageTransfer).not.toHaveBeenCalled();
  expect(files.get("contents/source-b/b/novel.json")).toBe("outside-edit");
  expect(sql.prepare("SELECT count(*) AS count FROM content_sync_cache").get()).toEqual({ count: 1 });
});

it("restores the baseline after the planned chapter composition was published before commit", async () => {
  const baseline = Buffer.from(JSON.stringify({ schemaVersion: 1,
    identity: { pluginId: "source-b", novelId: "b", novelPath: "/b" },
    novel: { name: "Target", author: null, artist: null, summary: null, status: null, genres: null, rating: null, isLocal: false },
    cover: null, chapters: { "1": "Old chapter" },
  })).toString("base64");
  const composition: ChapterCompositionV1 = { version: 1, updatedAt: 100, entries: [{ id: "entry-1", path: "/b/2", storageChapterNumber: "2",
    sources: [{ pluginId: "source-b", novelId: "b", novelPath: "/b", chapterPath: "/b/2", chapterNumber: "2",
      name: "New chapter", position: 1, page: "1", contentType: "html", releaseTime: null }], primarySource: 0,
    user: { included: true, order: 1, name: null, chapterNumber: "2" },
  }] };
  files.set("contents/source-b/b/novel.json", baseline);
  const job = await createNovelMergeStorageJournal(source, target, entries, ["contents/source-a/a"], composition);
  const published = JSON.parse(Buffer.from(job.target.nextMetadataBody!, "base64").toString("utf8"));
  files.set("contents/source-b/b/novel.json", Buffer.from(JSON.stringify(published, null, 2)).toString("base64"));
  files.delete("contents/source-a/a/novel.json");
  await recoverNovelMergeStorage();
  expect(files.get("contents/source-b/b/novel.json")).toBe(baseline);
  expect(files.get("contents/source-a/a/novel.json")).toBe("source-before");
});
