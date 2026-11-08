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
  replaceCoverBeforeCommit: false,
}));
const client = vi.hoisted(() => ({
  getDb: vi.fn(), getReadOnlyDb: vi.fn(), runDatabaseTransaction: vi.fn(), runExclusiveDatabaseOperation: vi.fn(),
}));
const globalSync = vi.hoisted(() => vi.fn((run: () => Promise<unknown>) => run()));
vi.mock("../../db/client", () => client);
vi.mock("../tauri-runtime", () => ({ isTauriRuntime: () => true, isAndroidRuntime: () => false }));
vi.mock("../novel-cover-storage", () => ({
  saveNovelCoverFromSource: vi.fn(), invalidateAllNovelCoverSources: vi.fn(), notifyNovelCoverChanged: vi.fn(),
}));
vi.mock("../tasks/download-cache-delete", () => ({ cancelNovelChapterDownloadWork: vi.fn(async () => undefined) }));
vi.mock("./sync", () => ({ runContentSyncOperation: globalSync }));
vi.mock("./device", () => ({ registerContentDevice: vi.fn(async () => "test-device"), forgetContentDeviceRegistration: vi.fn() }));
vi.mock("../plugins/manager", () => ({ pluginManager: { getPlugin: vi.fn(), loadInstalledFromDb: vi.fn() } }));
vi.mock("../tasks/source-tasks", () => ({ enqueueSourceTask: vi.fn() }));
vi.mock("../tasks/scheduler", () => ({ taskScheduler: { cancel: vi.fn() } }));
vi.mock("../../store/content-sync", () => ({
  useContentSyncStore: { getState: () => ({ serverUrl: "https://content.test", deviceName: "Fixture", lookupTimeoutSeconds: 30 }) },
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: { input?: { operation: string; path?: string; body?: number[] } }) => {
    if (command !== "work_metadata_operation" || !args.input) throw new Error("Unexpected native call: " + command);
    const input = args.input;
    if (input.operation === "read") return { body: state.metadata.get(input.path!) ?? null };
    if (input.operation === "write") state.metadata.set(input.path!, [...input.body!]);
    if (input.operation === "remove") state.metadata.delete(input.path!);
    if (input.operation === "list") return { paths: [...state.metadata.keys()].filter(path => path.endsWith("/novel.json")) };
    if (input.operation === "cover") {
      const root = input.path!.slice(0, -"/novel.json".length);
      const document = state.metadata.get(input.path!);
      const preferred = document && JSON.parse(new TextDecoder().decode(new Uint8Array(document))).cover?.fileName;
      const file = preferred && state.metadata.has(root + "/" + preferred) ? root + "/" + preferred
        : [...state.metadata.keys()].find(path => path.startsWith(root + "/cover."));
      return { cover: file ? { fileName: file.slice(root.length + 1), modifiedAt: 1 } : null };
    }
    return {};
  },
}));
vi.mock("../chapter-storage-transfer", () => ({
  prepareChapterStorageTransfer: vi.fn(async (entries, options) => {
    if (!options.requireEmptyTargets || !options.token) throw new Error("Missing strict durable transfer intent");
    for (const entry of entries) {
      if (state.payloads.has(entry.targetRelativeDir)) throw new Error("Target collision");
    }
    const prepared = entries.map((entry: { sourceRelativeDir: string; targetRelativeDir: string }) => {
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

import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import {
  applySourceChapterNumberChangesInDb, commitSourceChapterRenumberInDb, createSourceChapterRenumberJournal,
  parseSourceChapterRenumberJournal, planServerChapterNumberChanges, readRenumberChapters,
  recoverSourceChapterRenumbersInDb, saveSourceChapterRenumberJournal, validateRenumberPreparation,
  type ChapterNumberMapping, type RenumberWork, type SourceChapterRenumberJournal,
} from "../source-chapter-renumber";
import {
  flushWorkMetadata, readWorkMetadataSyncFile, restoreWorkMetadataDirectories, scanStoredNovelChaptersToCache,
} from "../../db/work-metadata";
import { readStoredNovelCover, readStoredNovelMetadata, withWorkMetadataRollback, type NovelMetadataV1 } from "../work-metadata";
import { prepareChapterStorageTransfer, finalizeChapterStorageTransfer, rollbackChapterStorageTransfer } from "../chapter-storage-transfer";
import { cacheServerChapters } from "../../db/queries/content-sync";
import { contentWorkId, getWorkSyncCursor, recordInstalledWorkMetadata, syncWorkMetadata, type WorkCatalogEntry } from "./works";
import { syncServerNovelOnOpen } from "./work-refresh";
import { refreshServerNovel } from "./browse";
import type { ServerChapterSummary } from "./chapters";

const server = "https://content.test";
const work: RenumberWork = { id: 7, pluginId: "source", sourceNovelId: "book", path: "/book" };
const directory = "contents/source/book";
const metadataPath = directory + "/novel.json";
const coverPath = directory + "/cover.png";
const oldCover = [1, 2, 3];
const nextCover = [4, 5, 6];
const canonicalCatalog = { "1": "First", "2": "Second", "3": "Third" };
const originalCatalog = { "1000": "First", "2000": "Second", "3000": "Third" };
const allMappings: ChapterNumberMapping[] = [
  { chapterPath: "/chapter/1000", from: "1000", to: "1" },
  { chapterPath: "/chapter/2000", from: "2000", to: "2" },
  { chapterPath: "/chapter/3000", from: "3000", to: "3" },
];
let sqlite: DatabaseSync;
let db: Database;
let remote: WorkCatalogEntry;
let mappings: ChapterNumberMapping[];
let capabilities: Record<string, unknown> | null;
let revision: string;
let serverCover: number[] | null;
let proofReads: number;
let proofTransform: ((value: unknown) => unknown) | undefined;
const metadata = (): NovelMetadataV1 => JSON.parse(new TextDecoder().decode(new Uint8Array(state.metadata.get(metadataPath)!)));
const personalState = () => sqlite.prepare("SELECT id,progress,bookmark,unread,read_at,is_downloaded,stored_content_type,content_bytes,media_bytes FROM chapter ORDER BY id").all();
const numbers = () => sqlite.prepare("SELECT id,path,chapter_number,position FROM chapter ORDER BY id").all();
const journals = () => sqlite.prepare("SELECT cache_key,payload FROM content_sync_cache WHERE cache_key LIKE 'norea-source-chapter-renumber:%'").all();
const sha256 = async (body: number[]) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(body))), byte => byte.toString(16).padStart(2, "0")).join("");
const serverChapters = (): ServerChapterSummary[] => allMappings.map((mapping, index) => ({
  id: "stable-" + index, chapterPath: mapping.chapterPath, chapterNumber: mapping.to,
  position: index + 1, name: ["First", "Second", "Third"][index]!, complete: index !== 1,
  contentType: "html", page: "0",
}));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("window", new EventTarget());
  state.metadata.clear(); state.payloads.clear(); state.markers.clear();
  state.failPrepareResponse = false; state.failCommit = false; state.replaceCoverBeforeCommit = false;
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
  client.getDb.mockResolvedValue(db); client.getReadOnlyDb.mockResolvedValue(db);
  client.runExclusiveDatabaseOperation.mockImplementation(async run => run(db));
  client.runDatabaseTransaction.mockImplementation(async run => {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      return await withWorkMetadataRollback(async () => {
        const result = await run(db);
        await flushWorkMetadata(db);
        const committed = sqlite.prepare("SELECT 1 FROM content_sync_cache WHERE cache_key LIKE 'norea-source-chapter-renumber:%' AND json_extract(payload,'$.phase')='committed'").get();
        if (state.failCommit && committed) {
          if (state.replaceCoverBeforeCommit) state.metadata.set(coverPath, [99, 99, 99]);
          throw new Error("Simulated SQLite commit failure");
        }
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
  state.metadata.set(coverPath, [...oldCover]);
  await restoreWorkMetadataDirectories(db, false);
  await flushWorkMetadata(db, { novelId: 7, chapters: originalCatalog });
  await rememberLocalBaseline();
  mappings = structuredClone(allMappings);
  capabilities = { chapterNumberReconciliationVersion: 1, chapterNumberMappingsVersion: 1 };
  revision = "a".repeat(64); serverCover = [...oldCover]; proofReads = 0; proofTransform = undefined;
  remote = { id: await contentWorkId(metadata().identity), sequence: 1, hasCover: true,
    metadata: { ...metadata(), chapters: { ...canonicalCatalog } } };
  vi.mocked(nativeFetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (init?.method && init.method !== "GET") throw new Error("Unexpected server mutation: " + init.method + " " + url.pathname);
    if (url.pathname.endsWith("/capabilities")) return capabilities === null ? new Response(null, { status: 404 }) : Response.json(capabilities);
    if (url.pathname.endsWith("/chapter-number-mappings")) {
      proofReads++;
      const proof = { work: { ...remote, revision }, mappings };
      return Response.json(proofTransform?.(proof) ?? proof);
    }
    if (url.pathname.endsWith("/cover")) return serverCover ? new Response(new Uint8Array(serverCover), { headers: { "Content-Type": "image/png" } }) : new Response(null, { status: 404 });
    if (url.pathname.endsWith("/chapters")) return Response.json({ items: serverChapters(), total: 3, hasMore: false });
    if (url.pathname.endsWith("/works")) return Response.json({ items: Number(url.searchParams.get("after")) < remote.sequence ? [remote] : [], cursor: remote.sequence, hasMore: false });
    if (url.pathname.endsWith("/works/" + remote.id)) return Response.json(remote);
    throw new Error("Unexpected request: " + url.pathname);
  });
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); });

async function rememberLocalBaseline(): Promise<void> {
  const local = (await readStoredNovelMetadata(directory))!;
  await recordInstalledWorkMetadata(server, {
    ...local, syncFile: (await readWorkMetadataSyncFile(local.metadata.identity))!,
    coverBytes: await readStoredNovelCover(directory, local.metadata),
  }, Boolean(local.metadata.cover));
}

async function pull() { return syncWorkMetadata(server, "test-device", false); }

function expectCanonical(before: unknown): void {
  expect(personalState()).toEqual(before);
  expect(numbers()).toEqual([
    { id: 11, path: "/chapter/1000", chapter_number: "1", position: 1 },
    { id: 12, path: "/chapter/2000", chapter_number: "2", position: 2 },
    { id: 13, path: "/chapter/3000", chapter_number: "3", position: 3 },
  ]);
  expect(metadata().chapters).toEqual(canonicalCatalog);
  expect([...state.payloads]).toEqual([
    [directory + "/1", "first body with retained media"],
    [directory + "/3", "third body with retained media"],
  ]);
  expect(journals()).toEqual([]);
  expect(sqlite.prepare("SELECT cache_key FROM content_sync_cache WHERE cache_key LIKE 'norea-content-chapter-number-reconciliation:%'").all()).toEqual([]);
  expect(globalSync).not.toHaveBeenCalled();
}

describe("production incoming metadata paths", () => {
  it.each(["changes", "open", "browse"] as const)("renumbers through %s before catalog union and keeps every local identity and payload", async route => {
    const before = personalState();
    if (route === "changes") await pull();
    else if (route === "open") expect(await syncServerNovelOnOpen(7)).toBe(true);
    else expect(await refreshServerNovel({ serverUrl: server, workId: remote.id })).toBe(7);
    expectCanonical(before);
    expect(proofReads).toBe(2);
    expect(state.metadata.get(coverPath)).toEqual(oldCover);
  });

  it("keeps an ordinary partial catalog merge when the server explicitly has no mappings", async () => {
    mappings = [];
    remote.metadata.chapters = { "1000": "First", "4000": "Fourth" };
    await pull();
    expect(metadata().chapters).toEqual({ ...originalCatalog, "4000": "Fourth" });
    expect(prepareChapterStorageTransfer).not.toHaveBeenCalled();
    expect(state.payloads.has(directory + "/1000")).toBe(true);
  });

  it.each([null, {}])("retains the ordinary partial-catalog behavior of a legacy server (%j)", async value => {
    capabilities = value;
    remote.metadata.chapters = { "1000": "First", "4000": "Fourth" };
    await pull();
    expect(metadata().chapters).toEqual({ ...originalCatalog, "4000": "Fourth" });
    expect(proofReads).toBe(0);
    expect(prepareChapterStorageTransfer).not.toHaveBeenCalled();
  });

  it("requires no proof request for an ordinary addition", async () => {
    remote.metadata.chapters = { ...originalCatalog, "4000": "Fourth" };
    await pull();
    expect(metadata().chapters).toEqual(remote.metadata.chapters);
    expect(nativeFetch).not.toHaveBeenCalledWith(expect.stringContaining("/capabilities"), expect.anything());
  });

  it("holds a corrected catalog from a server without readable mapping proof", async () => {
    capabilities = { chapterNumberReconciliationVersion: 1 };
    const before = metadata();
    await expect(pull()).rejects.toThrow("Update the content server");
    expect(metadata()).toEqual(before);
    expect(prepareChapterStorageTransfer).not.toHaveBeenCalled();
    expect(await getWorkSyncCursor(server)).toBe(0);
  });

  it("rejects a partial map before files or catalog can change", async () => {
    mappings = mappings.slice(0, 2);
    const before = metadata();
    await expect(pull()).rejects.toThrow("incomplete");
    expect(metadata()).toEqual(before);
    expect(prepareChapterStorageTransfer).not.toHaveBeenCalled();
    expect(await getWorkSyncCursor(server)).toBe(0);
  });

  it("rejects a proof for a different server revision snapshot before preparing storage", async () => {
    proofTransform = proof => ({ ...(proof as object), work: { ...remote, sequence: 2, revision } });
    await expect(pull()).rejects.toThrow("does not match");
    expect(prepareChapterStorageTransfer).not.toHaveBeenCalled();
    expect(metadata().chapters).toEqual(originalCatalog);
  });

  it("rolls back copies if the server revision changes during storage preparation", async () => {
    proofTransform = proof => proofReads < 2 ? proof : { ...(proof as object), work: { ...remote, revision: "b".repeat(64) } };
    await expect(pull()).rejects.toThrow("proof changed");
    expect(metadata().chapters).toEqual(originalCatalog);
    expect([...state.payloads.keys()]).toEqual([directory + "/1000", directory + "/3000"]);
    expect(journals()).toEqual([]);
  });

  it("does not retry a completed local renumber or create an outbound POST after the next catalog update", async () => {
    await pull();
    const before = personalState();
    remote.sequence++;
    remote.metadata.novel.name = "Updated title";
    await pull();
    expectCanonical(before);
    expect(prepareChapterStorageTransfer).toHaveBeenCalledOnce();
    expect(metadata().novel.name).toBe("Updated title");
  });

  it("preserves all source and target files when a destination is occupied", async () => {
    state.payloads.set(directory + "/1", "unrelated target");
    const before = personalState();
    await expect(pull()).rejects.toThrow("Target collision");
    expect(personalState()).toEqual(before);
    expect(metadata().chapters).toEqual(originalCatalog);
    expect(state.payloads.get(directory + "/1")).toBe("unrelated target");
    expect(state.payloads.has(directory + "/1000")).toBe(true);
  });

  it("recovers copied targets after the native prepare response is lost", async () => {
    state.failPrepareResponse = true;
    await expect(pull()).rejects.toThrow("before the native response");
    expect(metadata().chapters).toEqual(originalCatalog);
    expect([...state.payloads.keys()]).toEqual([directory + "/1000", directory + "/3000"]);
    expect(journals()).toEqual([]);
  });

  it("restores the previous cover, metadata and numbers after a failed DB commit", async () => {
    serverCover = [...nextCover]; state.failCommit = true;
    const before = personalState();
    await expect(pull()).rejects.toThrow("SQLite commit failure");
    expect(personalState()).toEqual(before);
    expect(state.metadata.get(coverPath)).toEqual(oldCover);
    expect(metadata().chapters).toEqual(originalCatalog);
    expect([...state.payloads.keys()]).toEqual([directory + "/1000", directory + "/3000"]);
    expect(journals()).toEqual([]);
  });

  it("does not overwrite unrelated cover bytes during the ordinary exception rollback", async () => {
    serverCover = [...nextCover]; state.failCommit = true; state.replaceCoverBeforeCommit = true;
    await expect(pull()).rejects.toThrow();
    expect(state.metadata.get(coverPath)).toEqual([99, 99, 99]);
    expect(journals()).toHaveLength(1);
    expect(state.payloads.has(directory + "/1000")).toBe(true);
    expect(state.payloads.has(directory + "/1")).toBe(true);
    expect(rollbackChapterStorageTransfer).not.toHaveBeenCalled();
  });

  it("retains a committed journal on storage failure and completes it safely after restart", async () => {
    serverCover = [...nextCover];
    const before = personalState();
    vi.mocked(finalizeChapterStorageTransfer).mockRejectedValueOnce(new Error("Storage disconnected"));
    await expect(pull()).rejects.toThrow("Storage disconnected");
    expect(journals()).toHaveLength(1);
    expect(state.metadata.get(coverPath)).toEqual(nextCover);
    await expect(scanStoredNovelChaptersToCache(db, 7, directory, { chapters: [], downloadRevision: 0 })).rejects.toThrow("reconciliation is pending");
    await recoverSourceChapterRenumbersInDb(db);
    await recoverSourceChapterRenumbersInDb(db);
    expectCanonical(before);
    await pull();
    expect(prepareChapterStorageTransfer).toHaveBeenCalledOnce();
  });

  it("does not cache new server chapter identities when on-open installation is declined", async () => {
    let permit = true;
    proofTransform = proof => { if (proofReads === 2) permit = false; return proof; };
    await expect(syncServerNovelOnOpen(7, undefined, () => permit)).rejects.toThrow("changed");
    expect(metadata().chapters).toEqual(originalCatalog);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter").get()).toEqual({ count: 3 });
    expect(numbers()[2]).toMatchObject({ path: "norea-folder:3000", chapter_number: "3000" });
  });

  it("skips chapter caching when on-open loses installation permission after proof lookup", async () => {
    const permit = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
    expect(await syncServerNovelOnOpen(7, undefined, permit)).toBe(false);
    expect(prepareChapterStorageTransfer).not.toHaveBeenCalled();
    expect(metadata().chapters).toEqual(originalCatalog);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter").get()).toEqual({ count: 3 });
    expect(numbers()[2]).toMatchObject({ path: "norea-folder:3000", chapter_number: "3000" });
  });

  it("retains existing work files when browse explicitly requires a new work", async () => {
    const before = personalState();
    expect(await refreshServerNovel({ serverUrl: server, workId: remote.id }, true)).toBe(7);
    expect(personalState()).toEqual(before);
    expect(metadata().chapters).toEqual(originalCatalog);
    expect(prepareChapterStorageTransfer).not.toHaveBeenCalled();
    expect(proofReads).toBe(0);
  });
});

async function preparedCoverJob(fileName = "cover.png"): Promise<SourceChapterRenumberJournal> {
  const changes = planServerChapterNumberChanges(work, await readRenumberChapters(db, 7), mappings);
  const job = await createSourceChapterRenumberJournal(db, work, changes, null,
    [{ fileName, sha256: await sha256(nextCover) }]);
  job.preparation = await prepareChapterStorageTransfer(changes.map(change => ({
    entryId: String(change.id), sourceRelativeDir: change.sourceRelativeDir, targetRelativeDir: change.targetRelativeDir,
  })), { token: job.operationId, requireEmptyTargets: true });
  validateRenumberPreparation(job, job.preparation);
  await saveSourceChapterRenumberJournal(db, job);
  return job;
}

describe("durable cover recovery", () => {
  it("restores a changed same-name cover after a process exit before the DB commit", async () => {
    const originalDocument = metadata();
    const job = await preparedCoverJob();
    expect(job.version).toBe(2);
    state.metadata.set(coverPath, [...nextCover]);
    await recoverSourceChapterRenumbersInDb(db);
    expect(state.metadata.get(coverPath)).toEqual(oldCover);
    expect(metadata()).toEqual(originalDocument);
    expect([...state.payloads.keys()]).toEqual([directory + "/1000", directory + "/3000"]);
  });

  it("keeps the new cover after a committed process exit", async () => {
    const before = personalState();
    const job = await preparedCoverJob();
    sqlite.exec("BEGIN IMMEDIATE");
    await applySourceChapterNumberChangesInDb(db, 7, job);
    state.metadata.set(coverPath, [...nextCover]);
    await flushWorkMetadata(db, { novelId: 7, chapters: canonicalCatalog, replacedChapterNumbers: mappings.map(item => item.from) });
    await commitSourceChapterRenumberInDb(db, job);
    sqlite.exec("COMMIT");
    await recoverSourceChapterRenumbersInDb(db);
    expectCanonical(before);
    expect(state.metadata.get(coverPath)).toEqual(nextCover);
  });

  it("removes a newly created target on rollback and retains a differently named old cover", async () => {
    await preparedCoverJob("cover.webp");
    state.metadata.set(directory + "/cover.webp", [...nextCover]);
    await recoverSourceChapterRenumbersInDb(db);
    expect(state.metadata.has(directory + "/cover.webp")).toBe(false);
    expect(state.metadata.get(coverPath)).toEqual(oldCover);
  });

  it("retains both payload copies and the journal if an unrelated cover replaced the intended file", async () => {
    await preparedCoverJob();
    state.metadata.set(coverPath, [9, 9, 9]);
    await expect(recoverSourceChapterRenumbersInDb(db)).rejects.toThrow("cover changed outside");
    expect(state.metadata.get(coverPath)).toEqual([9, 9, 9]);
    expect(journals()).toHaveLength(1);
    expect(rollbackChapterStorageTransfer).not.toHaveBeenCalled();
    expect(finalizeChapterStorageTransfer).not.toHaveBeenCalled();
    expect(state.payloads.has(directory + "/1000")).toBe(true);
    expect(state.payloads.has(directory + "/1")).toBe(true);
  });

  it.each(["../cover.png", "novel.json", "contents/other/book/cover.png"])("rejects a cover target outside its owned work filename (%s)", async fileName => {
    const changes = planServerChapterNumberChanges(work, await readRenumberChapters(db, 7), mappings);
    await expect(createSourceChapterRenumberJournal(db, work, changes, null, [{ fileName, sha256: await sha256(nextCover) }])).rejects.toThrow("cover is invalid");
    expect(journals()).toEqual([]);
  });

  it("validates backup path, canonical encoding and digest before any recovery mutation", async () => {
    const job = await preparedCoverJob();
    expect(() => parseSourceChapterRenumberJournal(JSON.stringify({
      ...job, metadataFiles: [{ ...job.metadataFiles![0], path: "contents/other/book/cover.png" }],
    }))).toThrow("identity");
    expect(() => parseSourceChapterRenumberJournal(JSON.stringify({
      ...job, metadataFiles: [{ ...job.metadataFiles![0], body: "AQID\n" }],
    }))).toThrow("encoding");
    const corrupted = { ...job, metadataFiles: [{ ...job.metadataFiles![0], sha256: "0".repeat(64) }] };
    await saveSourceChapterRenumberJournal(db, corrupted);
    await expect(recoverSourceChapterRenumbersInDb(db)).rejects.toThrow("does not match its digest");
    expect(rollbackChapterStorageTransfer).not.toHaveBeenCalled();
    expect(journals()).toHaveLength(1);
  });

  it("uses v1 for an unchanged source journal and rejects cover backups disguised as v1", async () => {
    const changes = planServerChapterNumberChanges(work, await readRenumberChapters(db, 7), mappings);
    const old = await createSourceChapterRenumberJournal(db, work, changes, null);
    expect(old.version).toBe(1);
    expect(parseSourceChapterRenumberJournal(JSON.stringify(old))).toEqual(old);
    const next = await preparedCoverJob();
    expect(() => parseSourceChapterRenumberJournal(JSON.stringify({ ...next, version: 1 }))).toThrow("backup is invalid");
  });
});

it("uses explicit unique server aliases to rebind an in-range recovered old number", () => {
  const rows = [
    { id: 11, path: "norea-folder:100", chapterNumber: "100", position: 1, directory: null, isDownloaded: 0 },
    { id: 12, path: "/chapter/200", chapterNumber: "200", position: 2, directory: null, isDownloaded: 0 },
  ];
  const planned = planServerChapterNumberChanges(work, rows, [
    { chapterPath: "/chapter/100", from: "100", to: "90" }, { chapterPath: "/chapter/200", from: "200", to: "110" },
  ]);
  expect(planned.map(change => [change.id, change.path, change.nextPath, change.nextChapterNumber])).toEqual([
    [11, "norea-folder:100", "/chapter/100", "90"], [12, "/chapter/200", "/chapter/200", "110"],
  ]);
});

it("rejects a direct cache import with an explicit same-path number mismatch", async () => {
  await expect(cacheServerChapters(7, serverChapters())).rejects.toThrow("Synchronize the corrected work metadata");
  expect(metadata().chapters).toEqual(originalCatalog);
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM chapter").get()).toEqual({ count: 3 });
});
