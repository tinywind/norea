import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./chapter-storage-transfer", () => ({
  finalizeChapterStorageTransfer: vi.fn(),
  rollbackChapterStorageTransfer: vi.fn(),
  removeChapterStorageDirectory: vi.fn(),
}));
vi.mock("./work-metadata", () => ({ workMetadataOperation: vi.fn() }));
vi.mock("../db/work-metadata", () => ({ flushWorkMetadata: vi.fn() }));

import { finalizeChapterStorageTransfer, rollbackChapterStorageTransfer, removeChapterStorageDirectory } from "./chapter-storage-transfer";
import { workMetadataOperation } from "./work-metadata";
import { commitNovelMergeStorageInDb, createNovelMergeStorageJournal, recoverNovelMergeStorageInDb, saveNovelMergeStoragePreparation } from "./novel-merge-storage";
import type { ChapterCompositionV1 } from "./chapter-composition";

let sql: DatabaseSync;
let db: Parameters<typeof recoverNovelMergeStorageInDb>[0];
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
  } as typeof db;
  files = new Map([["contents/source-a/a/novel.json", "source-before"], ["contents/source-b/b/novel.json", "target-before"]]);
  vi.mocked(workMetadataOperation).mockImplementation(async input => {
    if (input.operation === "write") files.set(input.path!, input.body!);
    if (input.operation === "remove") files.delete(input.path!);
    return { body: files.get(input.path!) ?? null };
  });
});
afterEach(() => sql.close());

it("recovers a process stopped after a folder move but before the native receipt was saved", async () => {
  await createNovelMergeStorageJournal(db, source, target, entries, ["contents/source-a/a"]);
  files.delete("contents/source-a/a/novel.json");
  await recoverNovelMergeStorageInDb(db);
  expect(rollbackChapterStorageTransfer).toHaveBeenCalledWith(expect.objectContaining({
    entries: [expect.objectContaining({ ...entries[0], outcome: "movedSource", replacedTarget: true })],
  }));
  expect(files.get("contents/source-a/a/novel.json")).toBe("source-before");
  expect(files.get("contents/source-b/b/novel.json")).toBe("target-before");
  expect(sql.prepare("SELECT * FROM content_sync_cache").all()).toEqual([]);
  expect(removeChapterStorageDirectory).not.toHaveBeenCalled();
});

it("finalizes a committed move after restart and removes only source work roots", async () => {
  const job = await createNovelMergeStorageJournal(db, source, target, entries, ["contents/source-a/a/1", "contents/source-a/a"]);
  const preparation = { token: job.token, entries: [{ ...entries[0]!, outcome: "movedSource" as const, replacedTarget: false,
    contentFile: "contents/source-b/b/2/content.html", contentBytes: 12, mediaBytes: 0 }] };
  await saveNovelMergeStoragePreparation(db, job, preparation);
  sql.exec("BEGIN");
  await commitNovelMergeStorageInDb(db, job.token);
  sql.exec("DELETE FROM novel WHERE id=1; COMMIT");
  files.set("contents/source-b/b/novel.json", "committed-target");
  await recoverNovelMergeStorageInDb(db);
  await recoverNovelMergeStorageInDb(db);
  expect(finalizeChapterStorageTransfer).toHaveBeenCalledExactlyOnceWith(preparation);
  expect(rollbackChapterStorageTransfer).not.toHaveBeenCalled();
  expect(removeChapterStorageDirectory).toHaveBeenCalledExactlyOnceWith("contents/source-a/a");
  expect(files.get("contents/source-b/b/novel.json")).toBe("committed-target");
});

it("retains the recovery journal when folder restoration fails", async () => {
  await createNovelMergeStorageJournal(db, source, target, entries, ["contents/source-a/a"]);
  vi.mocked(rollbackChapterStorageTransfer).mockRejectedValueOnce(new Error("Source path is occupied"));
  await expect(recoverNovelMergeStorageInDb(db)).rejects.toThrow("Source path is occupied");
  expect(sql.prepare("SELECT count(*) AS count FROM content_sync_cache").get()).toEqual({ count: 1 });
  expect(removeChapterStorageDirectory).not.toHaveBeenCalled();
  await recoverNovelMergeStorageInDb(db);
  expect(sql.prepare("SELECT * FROM content_sync_cache").all()).toEqual([]);
});

it("recovers only the locked work before a retry in the same process", async () => {
  await createNovelMergeStorageJournal(db, source, target, entries, ["contents/source-a/a"]);
  await recoverNovelMergeStorageInDb(db, [99]);
  expect(rollbackChapterStorageTransfer).not.toHaveBeenCalled();
  await recoverNovelMergeStorageInDb(db, [1]);
  expect(rollbackChapterStorageTransfer).toHaveBeenCalledOnce();
});

it("keeps the preparing phase when the merge transaction rolls back", async () => {
  const job = await createNovelMergeStorageJournal(db, source, target, entries, ["contents/source-a/a"]);
  sql.exec("BEGIN");
  await commitNovelMergeStorageInDb(db, job.token);
  sql.exec("ROLLBACK");
  await recoverNovelMergeStorageInDb(db);
  expect(rollbackChapterStorageTransfer).toHaveBeenCalledOnce();
  expect(finalizeChapterStorageTransfer).not.toHaveBeenCalled();
});

it("refuses recovery after the original work identity or metadata changed", async () => {
  await createNovelMergeStorageJournal(db, source, target, entries, ["contents/source-a/a"]);
  sql.exec("UPDATE work_metadata_file_cache SET fingerprint='outside-edit' WHERE novel_id=2");
  await expect(recoverNovelMergeStorageInDb(db)).rejects.toThrow(/changed/);
  expect(rollbackChapterStorageTransfer).not.toHaveBeenCalled();
});

it("retains files and the journal when metadata was edited outside the interrupted merge", async () => {
  await createNovelMergeStorageJournal(db, source, target, entries, ["contents/source-a/a"]);
  files.set("contents/source-b/b/novel.json", "outside-edit");
  await expect(recoverNovelMergeStorageInDb(db)).rejects.toThrow(/metadata changed/);
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
  const job = await createNovelMergeStorageJournal(db, source, target, entries, ["contents/source-a/a"], composition);
  const published = JSON.parse(Buffer.from(job.target.nextMetadataBody!, "base64").toString("utf8"));
  files.set("contents/source-b/b/novel.json", Buffer.from(JSON.stringify(published, null, 2)).toString("base64"));
  files.delete("contents/source-a/a/novel.json");
  await recoverNovelMergeStorageInDb(db);
  expect(files.get("contents/source-b/b/novel.json")).toBe(baseline);
  expect(files.get("contents/source-a/a/novel.json")).toBe("source-before");
});
