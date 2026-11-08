import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type Database from "@tauri-apps/plugin-sql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  metadata: new Map<string, number[]>(),
  payloads: new Map<string, string>(),
  markers: new Map<string, string>(),
  failPrepareResponse: false,
  failCommit: false,
}));
const client = vi.hoisted(() => ({ getDb: vi.fn(), runDatabaseTransaction: vi.fn(), runExclusiveDatabaseOperation: vi.fn() }));
vi.mock("../db/client", () => client);
vi.mock("./tauri-runtime", () => ({ isTauriRuntime: () => true, isAndroidRuntime: () => false }));
vi.mock("./novel-cover-storage", () => ({ saveNovelCoverFromSource: vi.fn(), invalidateAllNovelCoverSources: vi.fn() }));
vi.mock("./tasks/download-cache-delete", () => ({ cancelNovelChapterDownloadWork: vi.fn(async () => undefined) }));
vi.mock("./content-sync/sync", () => ({ runContentSyncOperation: (run: () => Promise<unknown>) => run() }));
vi.mock("../store/content-sync", () => ({ useContentSyncStore: { getState: () => ({ serverUrl: "https://content.test" }) } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: { input?: { operation: string; path?: string; body?: number[] } }) => {
  if (command !== "work_metadata_operation" || !args.input) throw new Error("Unexpected native call: " + command);
  const input = args.input;
  if (input.operation === "read") return { body: state.metadata.get(input.path!) ?? null };
  if (input.operation === "write") state.metadata.set(input.path!, [...input.body!]);
  if (input.operation === "remove") state.metadata.delete(input.path!);
  if (input.operation === "cover") return { cover: null };
  return {};
} }));
vi.mock("./chapter-storage-transfer", () => ({
  prepareChapterStorageTransfer: vi.fn(async (entries, options) => {
    const prepared = entries.map((entry: { sourceRelativeDir: string; targetRelativeDir: string }) => {
      if (state.payloads.has(entry.targetRelativeDir)) throw new Error("Target collision");
      const body = state.payloads.get(entry.sourceRelativeDir);
      if (body !== undefined) {
        state.payloads.set(entry.targetRelativeDir, body);
        state.markers.set(entry.targetRelativeDir, options.token);
      }
      return { ...entry, outcome: body === undefined ? "sourceNotDownloaded" : "copiedSource",
        replacedTarget: false, contentFile: body === undefined ? null : entry.targetRelativeDir + "/content.html",
        contentBytes: body?.length ?? 0, mediaBytes: 0 };
    });
    if (state.failPrepareResponse) throw new Error("Application stopped before the native response");
    return { token: options.token, entries: prepared };
  }),
  rollbackChapterStorageTransfer: vi.fn(async preparation => {
    for (const entry of preparation.entries) {
      if (state.markers.get(entry.targetRelativeDir) === preparation.token) {
        state.payloads.delete(entry.targetRelativeDir);
        state.markers.delete(entry.targetRelativeDir);
      }
    }
  }),
  finalizeChapterStorageTransfer: vi.fn(async preparation => {
    for (const entry of preparation.entries) {
      if (entry.outcome !== "copiedSource") continue;
      if (!state.payloads.has(entry.targetRelativeDir)) throw new Error("Missing target payload");
      state.payloads.delete(entry.sourceRelativeDir);
      state.markers.delete(entry.targetRelativeDir);
    }
  }),
}));

import {
  applySourceChapterNumberChangesInDb,
  assertSourceChapterNumberChangesSupported,
  commitSourceChapterRenumberInDb,
  createSourceChapterRenumberJournal,
  planSourceChapterNumberChanges,
  readRenumberChapters,
  recoverSourceChapterRenumbersInDb,
  saveSourceChapterRenumberJournal,
  validateRenumberPreparation,
  type RenumberWork,
  type SourceChapterRenumberJournal,
  type StoredRenumberChapter,
} from "./source-chapter-renumber";
import { flushWorkMetadata, restoreWorkMetadataDirectories, scanStoredNovelChaptersToCache } from "../db/work-metadata";
import { withWorkMetadataRollback } from "./work-metadata";
import { prepareChapterStorageTransfer, finalizeChapterStorageTransfer, rollbackChapterStorageTransfer } from "./chapter-storage-transfer";
import { syncNovelFromSource } from "./plugins/sync-novel";
import { isNovelMigrationSourceHeldInDb } from "../db/queries/content-sync";
import type { ChapterItem, Plugin } from "./plugins/types";

const work: RenumberWork = { id: 7, pluginId: "source", sourceNovelId: "book", path: "/book" };
const directory = "contents/source/book";
const metadataPath = directory + "/novel.json";
const chapters: ChapterItem[] = [
  { path: "/chapter/1000", chapterNumber: 1, sourceChapterId: "1000", name: "First" },
  { path: "/chapter/2000", chapterNumber: 2, sourceChapterId: "2000", name: "Second" },
  { path: "/chapter/3000", chapterNumber: 3, sourceChapterId: "3000", name: "Third" },
];
let sqlite: DatabaseSync;
let db: Database;
const metadata = () => JSON.parse(new TextDecoder().decode(new Uint8Array(state.metadata.get(metadataPath)!)));
const personalState = () => sqlite.prepare("SELECT id,progress,bookmark,unread,read_at,is_downloaded,stored_content_type,content_bytes,media_bytes FROM chapter ORDER BY id").all();

beforeEach(async () => {
  vi.clearAllMocks();
  state.metadata.clear(); state.payloads.clear(); state.markers.clear();
  state.failPrepareResponse = false; state.failCommit = false;
  sqlite = new DatabaseSync(":memory:");
  for (const match of readFileSync("src-tauri/src/database.rs", "utf8").matchAll(/include_str!\("([^"]+)"\)/g)) {
    sqlite.exec(readFileSync("src-tauri/src/" + match[1], "utf8"));
  }
  db = {
    select: async (query: string, values: unknown[] = []) => sqlite.prepare(query).all(Object.fromEntries(values.map((value, i) => ["$" + (i + 1), value])) as never),
    execute: async (query: string, values: unknown[] = []) => {
      const result = sqlite.prepare(query).run(Object.fromEntries(values.map((value, i) => ["$" + (i + 1), value])) as never);
      return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
  } as Database;
  client.getDb.mockResolvedValue(db);
  client.runExclusiveDatabaseOperation.mockImplementation(async run => run(db));
  client.runDatabaseTransaction.mockImplementation(async run => {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      return await withWorkMetadataRollback(async () => {
        const result = await run(db);
        await flushWorkMetadata(db);
        const committed = sqlite.prepare("SELECT 1 FROM content_sync_cache WHERE cache_key LIKE 'norea-source-chapter-renumber:%' AND json_extract(payload,'$.phase')='committed'").get();
        if (state.failCommit && committed) throw new Error("Simulated SQLite commit failure");
        sqlite.exec("COMMIT");
        return result;
      });
    } catch (error) {
      sqlite.exec("ROLLBACK");
      await restoreWorkMetadataDirectories(db, false);
      throw error;
    }
  });
  sqlite.exec("INSERT INTO novel(id,plugin_id,source_novel_id,path,name,in_library) VALUES(7,'source','book','/book','Book',1)");
  sqlite.exec("INSERT INTO chapter(id,novel_id,path,name,position,chapter_number,progress,bookmark,unread,read_at,is_downloaded,stored_content_type,content_bytes) VALUES " +
    "(11,7,'/chapter/1000','First',1,'1000',0.75,1,0,123,1,'html',11)," +
    "(12,7,'/chapter/2000','Second',2,'2000',0,0,1,NULL,0,NULL,0)," +
    "(13,7,'norea-folder:3000','Third',3,'3000',1,1,0,456,1,'html',13)");
  state.payloads.set(directory + "/1000", "first body with retained media");
  state.payloads.set(directory + "/3000", "third body with retained media");
  await restoreWorkMetadataDirectories(db, false);
  await flushWorkMetadata(db, { novelId: 7, chapters: { "1000": "First", "2000": "Second", "3000": "Third" } });
  sqlite.prepare("INSERT INTO content_sync_cache(cache_key,payload) VALUES(?,?)").run(
    "norea-content-deletions:https://content.test", JSON.stringify([JSON.stringify(["source", "book", ["number", 2000]])]));
});
afterEach(() => sqlite.close());

function plugin(): Plugin {
  return { id: "source", parseNovel: async () => ({ novelId: "book", path: "/book", name: "Book", chapters }) } as unknown as Plugin;
}

async function preparedJob(): Promise<SourceChapterRenumberJournal> {
  const changes = planSourceChapterNumberChanges(work, await readRenumberChapters(db, 7), chapters);
  const job = await createSourceChapterRenumberJournal(db, work, changes, "https://content.test");
  job.preparation = await prepareChapterStorageTransfer(changes.map(change => ({
    entryId: String(change.id), sourceRelativeDir: change.sourceRelativeDir, targetRelativeDir: change.targetRelativeDir,
  })), { token: job.operationId, requireEmptyTargets: true });
  validateRenumberPreparation(job, job.preparation);
  await saveSourceChapterRenumberJournal(db, job);
  return job;
}

async function publish(job: SourceChapterRenumberJournal): Promise<void> {
  await applySourceChapterNumberChangesInDb(db, 7, job);
  await flushWorkMetadata(db, { novelId: 7, chapters: { "1": "First", "2": "Second", "3": "Third" },
    replacedChapterNumbers: job.changes.map(change => change.chapterNumber) });
  await commitSourceChapterRenumberInDb(db, job);
}

it("reconciles a full refresh without replacing IDs, reading state, downloads, or payload bytes", async () => {
  const before = personalState();
  const firstBody = state.payloads.get(directory + "/1000");
  const thirdBody = state.payloads.get(directory + "/3000");
  const result = await syncNovelFromSource(plugin(), { path: "/book", name: "Book" }, { chapterRefreshMode: "full" });
  expect(result.chapterCount).toBe(3);
  expect(personalState()).toEqual(before);
  expect(sqlite.prepare("SELECT id,path,chapter_number,position FROM chapter ORDER BY id").all()).toEqual([
    { id: 11, path: "/chapter/1000", chapter_number: "1", position: 1 },
    { id: 12, path: "/chapter/2000", chapter_number: "2", position: 2 },
    { id: 13, path: "/chapter/3000", chapter_number: "3", position: 3 },
  ]);
  expect([...state.payloads]).toEqual([[directory + "/1", firstBody], [directory + "/3", thirdBody]]);
  expect(metadata().chapters).toEqual({ "1": "First", "2": "Second", "3": "Third" });
  expect(sqlite.prepare("SELECT directory FROM work_metadata_directory_cache ORDER BY chapter_id").all()).toEqual([
    { directory: directory + "/1" }, { directory: directory + "/2" }, { directory: directory + "/3" },
  ]);
  const deletion = sqlite.prepare("SELECT payload FROM content_sync_cache WHERE cache_key LIKE 'norea-content-deletions:%'").get()!;
  expect(JSON.parse(deletion.payload as string)).toEqual([JSON.stringify(["source", "book", ["number", 2]])]);
  expect(sqlite.prepare("SELECT 1 FROM content_sync_cache WHERE cache_key LIKE 'norea-source-chapter-renumber:%'").get()).toBeUndefined();
  expect(await isNovelMigrationSourceHeldInDb(db, "https://content.test",
    { pluginId: "source", novelId: "book", novelPath: "/book" })).toBe(true);
});

it("rolls back copied folders even if the native response never arrives", async () => {
  const before = personalState();
  const beforeMetadata = metadata();
  state.failPrepareResponse = true;
  await expect(syncNovelFromSource(plugin(), { path: "/book", name: "Book" })).rejects.toThrow("before the native response");
  expect(personalState()).toEqual(before);
  expect(metadata()).toEqual(beforeMetadata);
  expect([...state.payloads.keys()]).toEqual([directory + "/1000", directory + "/3000"]);
  expect(rollbackChapterStorageTransfer).toHaveBeenCalledOnce();
  expect(sqlite.prepare("SELECT 1 FROM content_sync_cache WHERE cache_key LIKE 'norea-source-chapter-renumber:%'").get()).toBeUndefined();
});

it("restores metadata and files when the database publication cannot commit", async () => {
  const before = personalState();
  const beforeMetadata = metadata();
  state.failCommit = true;
  await expect(syncNovelFromSource(plugin(), { path: "/book", name: "Book" })).rejects.toThrow("SQLite commit failure");
  expect(personalState()).toEqual(before);
  expect(metadata()).toEqual(beforeMetadata);
  expect(sqlite.prepare("SELECT chapter_number FROM chapter ORDER BY id").all()).toEqual([
    { chapter_number: "1000" }, { chapter_number: "2000" }, { chapter_number: "3000" },
  ]);
  expect([...state.payloads.keys()]).toEqual([directory + "/1000", directory + "/3000"]);
});

it("recovers a process exit after metadata was written but before SQLite committed", async () => {
  const beforeMetadata = metadata();
  const job = await preparedJob();
  sqlite.exec("BEGIN IMMEDIATE");
  await publish(job);
  sqlite.exec("ROLLBACK");
  expect(metadata().chapters).toHaveProperty("1");
  await recoverSourceChapterRenumbersInDb(db);
  expect(metadata()).toEqual(beforeMetadata);
  expect([...state.payloads.keys()]).toEqual([directory + "/1000", directory + "/3000"]);
  expect(sqlite.prepare("SELECT chapter_number FROM chapter WHERE id=11").get()).toEqual({ chapter_number: "1000" });
});

it("finishes a committed transfer after reopening and is idempotent on the next reopen", async () => {
  const before = personalState();
  const job = await preparedJob();
  sqlite.exec("BEGIN IMMEDIATE");
  await publish(job);
  sqlite.exec("COMMIT");
  await recoverSourceChapterRenumbersInDb(db);
  await recoverSourceChapterRenumbersInDb(db);
  expect(finalizeChapterStorageTransfer).toHaveBeenCalledOnce();
  expect(personalState()).toEqual(before);
  expect([...state.payloads.keys()]).toEqual([directory + "/1", directory + "/3"]);
});

it("retains its journal and blocks storage recovery when committed cleanup fails", async () => {
  const job = await preparedJob();
  await publish(job);
  vi.mocked(finalizeChapterStorageTransfer).mockRejectedValueOnce(new Error("Storage disconnected"));
  await expect(recoverSourceChapterRenumbersInDb(db)).rejects.toThrow("Storage disconnected");
  await expect(scanStoredNovelChaptersToCache(db, 7, directory, { chapters: [], downloadRevision: 0 })).rejects.toThrow("reconciliation is pending");
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter").get()).toEqual({ count: 3 });
  await recoverSourceChapterRenumbersInDb(db);
  expect([...state.payloads.keys()]).toEqual([directory + "/1", directory + "/3"]);
});

it("refuses a target collision without changing either chapter's content or state", async () => {
  state.payloads.set(directory + "/1", "unrelated target");
  const before = personalState();
  await expect(syncNovelFromSource(plugin(), { path: "/book", name: "Book" })).rejects.toThrow("Target collision");
  expect(personalState()).toEqual(before);
  expect(state.payloads.get(directory + "/1")).toBe("unrelated target");
  expect(state.payloads.has(directory + "/1000")).toBe(true);
});

describe("chapter identity planning", () => {
  const row = (id: number, path: string, number: string): StoredRenumberChapter =>
    ({ id, path, chapterNumber: number, position: id, directory: null, isDownloaded: 0 });

  it("prefers an exact source path over a numeric source-ID placeholder", () => {
    const result = planSourceChapterNumberChanges(work,
      [row(1, "/real", "1000"), row(2, "norea-folder:9000", "9000")],
      [{ path: "/real", chapterNumber: 1, sourceChapterId: "9000" }]);
    expect(result.map(change => change.id)).toEqual([1]);
  });

  it("prefers a placeholder at the current number over a legacy source ID", () => {
    const result = planSourceChapterNumberChanges(work,
      [row(1, "norea-folder:1", "1"), row(2, "norea-folder:9000", "9000")],
      [{ path: "/real", chapterNumber: 1, sourceChapterId: "9000" }]);
    expect(result).toEqual([]);
  });

  it("does not reinterpret an in-range source ID as a different chapter", () => {
    const result = planSourceChapterNumberChanges(work, [row(1, "norea-folder:2", "2")],
      [{ path: "/first", chapterNumber: 1, sourceChapterId: "2" }, { path: "/last", chapterNumber: 3, sourceChapterId: "4" }]);
    expect(result).toEqual([]);
  });

  it("rejects ambiguous legacy source IDs", () => {
    expect(() => planSourceChapterNumberChanges(work, [row(1, "norea-folder:1000", "1000")],
      [{ path: "/first", chapterNumber: 1, sourceChapterId: "1000" }, { path: "/last", chapterNumber: 2, sourceChapterId: "1000" }])).toThrow("ambiguous");
  });

  it("rejects crossed numbering and an occupied destination", () => {
    expect(() => planSourceChapterNumberChanges(work, [row(1, "/first", "2"), row(2, "/second", "1")],
      [{ path: "/first", chapterNumber: 1 }, { path: "/second", chapterNumber: 2 }])).toThrow("overlap");
    expect(() => planSourceChapterNumberChanges(work, [row(1, "/first", "1000"), row(2, "/other", "1")],
      [{ path: "/first", chapterNumber: 1 }])).toThrow("already assigned");
  });
});

it.each([["0", "1"], ["1.5", "2"], ["9007199254740992", "1"]])(
  "rejects unsupported changed numbering %s -> %s before storing a journal", (from, to) => {
    expect(() => assertSourceChapterNumberChangesSupported([
      { chapterNumber: from, nextChapterNumber: to, nextPath: "/actual/chapter" },
    ])).toThrow("positive safe integer");
  });

it("continues to accept an unchanged fractional source catalog", () => {
  const stored: StoredRenumberChapter[] = [
    { id: 1, path: "/preface", chapterNumber: "0", position: 1, directory: null, isDownloaded: 0 },
    { id: 2, path: "/extra", chapterNumber: "1.5", position: 2, directory: null, isDownloaded: 0 },
  ];
  expect(planSourceChapterNumberChanges(work, stored,
    [{ path: "/preface", chapterNumber: 0 }, { path: "/extra", chapterNumber: 1.5 }])).toEqual([]);
});

it("enforces the server mapping and actual-path boundaries before local file changes", () => {
  const change = { chapterNumber: "10001", nextChapterNumber: "1", nextPath: "/" + "x".repeat(4095) };
  expect(() => assertSourceChapterNumberChangesSupported([change])).not.toThrow();
  expect(() => assertSourceChapterNumberChangesSupported([{ ...change, nextPath: change.nextPath + "x" }])).toThrow("4096");
  expect(() => assertSourceChapterNumberChangesSupported([{ ...change, nextPath: "norea-folder:1" }])).toThrow("actual source path");
  const maximum = Array.from({ length: 10000 }, (_, index) =>
    ({ chapterNumber: String(100000 + index), nextChapterNumber: String(index + 1), nextPath: "/chapter/" + index }));
  expect(() => assertSourceChapterNumberChangesSupported(maximum)).not.toThrow();
  expect(() => assertSourceChapterNumberChangesSupported([...maximum, change])).toThrow("10000");
});

it("refuses to apply a retained journal to a different restored database state", async () => {
  await preparedJob();
  sqlite.prepare("UPDATE chapter SET chapter_number='5000' WHERE id=11").run();
  await expect(recoverSourceChapterRenumbersInDb(db)).rejects.toThrow("does not match the current database");
  expect(rollbackChapterStorageTransfer).not.toHaveBeenCalled();
  expect(finalizeChapterStorageTransfer).not.toHaveBeenCalled();
  expect(state.payloads.has(directory + "/1000")).toBe(true);
  expect(state.payloads.has(directory + "/1")).toBe(true);
});

it("retains both copies when an uncommitted journal has a different restored metadata baseline", async () => {
  await preparedJob();
  sqlite.prepare("UPDATE work_metadata_file_cache SET fingerprint='restored-document' WHERE novel_id=7").run();
  await expect(recoverSourceChapterRenumbersInDb(db)).rejects.toThrow("metadata changed");
  expect(rollbackChapterStorageTransfer).not.toHaveBeenCalled();
  expect(state.payloads.has(directory + "/1000")).toBe(true);
  expect(state.payloads.has(directory + "/1")).toBe(true);
});
