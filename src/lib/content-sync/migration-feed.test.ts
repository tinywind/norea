import type Database from "@tauri-apps/plugin-sql";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, runDatabaseTransaction } from "../../db/client";
import { contentServerRequest, ContentServerError, ContentServerTransportError } from "./client";
import { publishNovelMigrationSourceHold } from "./deletion-exclusions";
import { applyIncomingNovelMigration } from "./incoming-novel-migration";
import { getIncomingMigrationCursor, incomingMigrationFromLineage, listIncomingMigrations, saveIncomingMigration, type WorkMigrationLineage } from "./migration-feed-state";
import { resolveIncomingNovelMigration, syncIncomingNovelMigrations } from "./migration-feed";

vi.mock("../../db/client", () => ({ getDb: vi.fn(), runDatabaseTransaction: vi.fn() }));
vi.mock("./client", async original => ({ ...await original<typeof import("./client")>(), contentServerRequest: vi.fn() }));
vi.mock("./deletion-exclusions", () => ({ publishNovelMigrationSourceHold: vi.fn() }));
vi.mock("./incoming-novel-migration", () => ({ applyIncomingNovelMigration: vi.fn(), IncomingNovelMigrationRetryableError: class extends Error {} }));
vi.mock("./works", () => ({ recordInstalledWorkMetadata: vi.fn(), releaseMigratedTargetMetadataInDb: vi.fn() }));
vi.mock("../../store/reader", () => ({ useReaderStore: { getState: () => ({ mergeNovelReaderState: vi.fn() }) } }));

const server = "https://content.test";
const hash = (value: string) => value.repeat(64);
const ids: Record<string, string> = { a: "1", b: "2", c: "3", d: "4" };
const bodyIds: Record<string, string> = { a: "5", b: "6", c: "7", d: "8" };
function edge(from = "a", to = "b", sequence = 1): WorkMigrationLineage {
  const identity = (pluginId: string) => ({ pluginId, novelId: "work", novelPath: "/work" });
  const metadata = (pluginId: string) => ({ schemaVersion: 1 as const, identity: identity(pluginId),
    novel: { name: "Work", author: "Writer", artist: null, summary: null, status: null, genres: null, rating: null, isLocal: false },
    cover: null, chapters: { "1": "Chapter one" } });
  const work = (pluginId: string) => ({ id: hash(ids[pluginId]!), revision: hash("a"), identity: identity(pluginId), metadata: metadata(pluginId), coverSha256: null });
  const chapter = (pluginId: string) => ({ id: hash(bodyIds[pluginId]!), revision: hash("b"), chapterPath: `/${pluginId}/1`, chapterNumber: "1", position: 1, name: "Chapter one", complete: true, available: true });
  return { sequence, operationId: `11111111-2222-3333-4444-${String(sequence).padStart(12, "0")}`,
    sourceWork: work(from), targetWork: work(to), deletedSource: { revision: hash("a"), sequence: sequence + 10 },
    mappings: [{ source: chapter(from), target: chapter(to), decision: "copy-source", targetInventory: { body: { bytes: 100, sha256: hash("f") }, expectedAssetKeys: [], storedAssets: [] } }],
    chapterDecisions: [{ sourceChapterPath: `/${from}/1`, sourceChapterNumber: "1", targetChapterPath: `/${to}/1`, targetChapterNumber: "1", sourceMetadataVerified: true, targetMetadataVerified: true }],
    fullDecisionCoverage: true, active: true };
}

function deleteDecision(value: WorkMigrationLineage): WorkMigrationLineage {
  value.chapterDecisions[0] = { ...value.chapterDecisions[0]!, targetChapterPath: null, targetChapterNumber: null, targetMetadataVerified: false };
  value.mappings[0] = { source: value.mappings[0]!.source, decision: "delete-source", target: null, targetInventory: null };
  return value;
}

describe("migration chain decisions", () => {
  it("resolves a retired intermediate work directly to the current work", () => {
    const first = edge(); const second = edge("b", "c", 2);
    expect(resolveIncomingNovelMigration(first, [first, second])).toMatchObject({ sourceWork: first.sourceWork, targetWork: second.targetWork,
      targetMappings: second.mappings, chapterDecisions: [{ sourceChapterPath: "/a/1", targetChapterPath: "/c/1" }], chain: [first, second] });
  });

  it("propagates an explicit later deletion and preserves an earlier deletion", () => {
    const first = edge(); const second = deleteDecision(edge("b", "c", 2));
    expect(resolveIncomingNovelMigration(first, [first, second]).chapterDecisions[0]).toMatchObject({ sourceChapterPath: "/a/1", targetChapterPath: null, targetChapterNumber: null });
    deleteDecision(first);
    expect(resolveIncomingNovelMigration(first, [first, second]).chapterDecisions[0]?.targetChapterPath).toBeNull();
  });

  it("uses a stable package and verified unique number for a recovered folder alias", () => {
    const first = edge(); const second = edge("b", "c", 2);
    second.chapterDecisions[0]!.sourceChapterPath = "norea-folder:1";
    second.mappings[0]!.source.chapterPath = "norea-folder:1";
    expect(resolveIncomingNovelMigration(first, [first, second]).chapterDecisions[0]?.targetChapterPath).toBe("/c/1");
    second.mappings[0]!.source.id = hash("9");
    expect(() => resolveIncomingNovelMigration(first, [first, second])).toThrow("does not explain");
  });

  it("does not guess a changed intermediate number or metadata mapping", () => {
    const first = edge(); const second = edge("b", "c", 2);
    second.chapterDecisions[0]!.sourceChapterPath = "norea-folder:1";
    second.sourceWork.metadata.chapters["1"] = "A different chapter";
    expect(() => resolveIncomingNovelMigration(first, [first, second])).toThrow("does not explain");
  });

  it("ignores revoked successors and rejects cycles, branching, and incomplete decisions", () => {
    const first = edge(); const second = edge("b", "c", 2);
    expect(resolveIncomingNovelMigration(first, [first, { ...second, active: false }]).targetWork).toEqual(first.targetWork);
    expect(() => resolveIncomingNovelMigration(first, [first, edge("b", "a", 2)])).toThrow("cycle");
    expect(() => resolveIncomingNovelMigration(first, [first, second, edge("b", "d", 3)])).toThrow("conflicting");
    expect(() => resolveIncomingNovelMigration(first, [first, { ...second, fullDecisionCoverage: false }])).toThrow("complete chapter");
  });
});

describe("received migration synchronization", () => {
  const databases: DatabaseSync[] = [];
  let sqlite: DatabaseSync;
  let db: Database;
  let remote: WorkMigrationLineage[];
  function connectDevice() {
    sqlite = new DatabaseSync(":memory:"); databases.push(sqlite);
    sqlite.exec("CREATE TABLE content_sync_cache(cache_key TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE local_merge(operation TEXT PRIMARY KEY)");
    db = {
      select: async (query: string, values: unknown[] = []) => sqlite.prepare(query).all(Object.fromEntries(values.map((value, index) => ["$" + (index + 1), value])) as never),
      execute: async (query: string, values: unknown[] = []) => {
        const result = sqlite.prepare(query).run(Object.fromEntries(values.map((value, index) => ["$" + (index + 1), value])) as never);
        return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
      },
    } as Database;
    vi.mocked(getDb).mockResolvedValue(db);
    vi.mocked(runDatabaseTransaction).mockImplementation(async run => {
      sqlite.exec("BEGIN IMMEDIATE");
      try { const result = await run(db); sqlite.exec("COMMIT"); return result; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    });
  }
  beforeEach(() => {
    vi.clearAllMocks(); remote = [edge()]; connectDevice();
    vi.mocked(contentServerRequest).mockImplementation(async (_server, path) => {
      if (path === "/capabilities") return { workMigrationLineageVersion: 1 } as never;
      if (path.startsWith("/work-migrations?")) {
        const after = Number(new URL("https://content.test" + path).searchParams.get("after"));
        const items = remote.filter(item => item.sequence > after).sort((left, right) => left.sequence - right.sequence);
        return { items: structuredClone(items), cursor: Math.max(after, ...remote.map(item => item.sequence)), hasMore: false } as never;
      }
      const operation = decodeURIComponent(path.slice("/work-migrations/".length));
      const entry = remote.find(item => item.operationId === operation);
      if (!entry) throw new ContentServerError(404);
      return structuredClone(entry) as never;
    });
    vi.mocked(applyIncomingNovelMigration).mockImplementation(async (_server, _token, resolved, options) => {
      await options.assertCurrent();
      await options.beforeCommit?.();
      await runDatabaseTransaction(async raw => {
        await raw.execute("INSERT INTO local_merge(operation) VALUES($1)", [resolved.chain[0]!.operationId]);
        await options.recordIncomingMigration(raw);
      });
      return null;
    });
  });
  afterEach(() => { for (const database of databases.splice(0)) database.close(); });

  it("persists source holds and cursor before applying, then skips completed replay after restart", async () => {
    const actual = vi.mocked(applyIncomingNovelMigration).getMockImplementation()!;
    vi.mocked(applyIncomingNovelMigration).mockImplementationOnce(async (...args) => {
      expect(await getIncomingMigrationCursor(server)).toBe(1);
      expect((await listIncomingMigrations(server))[0]?.status).toBe("pending");
      expect(publishNovelMigrationSourceHold).toHaveBeenCalledWith(server, remote[0]!.sourceWork.identity);
      return actual(...args);
    });
    expect(await syncIncomingNovelMigrations(server, "token")).toEqual({ applied: 1, pending: 0 });
    expect(await syncIncomingNovelMigrations(server, "token")).toEqual({ applied: 0, pending: 0 });
    expect(applyIncomingNovelMigration).toHaveBeenCalledOnce();
    expect(sqlite.prepare("SELECT count(*) AS count FROM local_merge").get()?.count).toBe(1);
  });

  it("replays the same server history independently on another device", async () => {
    await syncIncomingNovelMigrations(server, "first-device");
    const firstDatabase = sqlite;
    connectDevice();
    expect(await getIncomingMigrationCursor(server)).toBe(0);
    expect(await syncIncomingNovelMigrations(server, "second-device")).toEqual({ applied: 1, pending: 0 });
    expect(firstDatabase.prepare("SELECT count(*) AS count FROM local_merge").get()?.count).toBe(1);
    expect(sqlite.prepare("SELECT count(*) AS count FROM local_merge").get()?.count).toBe(1);
  });

  it("saves the whole chain before either receipt is applied", async () => {
    remote.push(edge("b", "c", 2));
    expect(await syncIncomingNovelMigrations(server, "token")).toEqual({ applied: 2, pending: 0 });
    expect(vi.mocked(applyIncomingNovelMigration).mock.calls[0]?.[2]).toMatchObject({ targetWork: remote[1]!.targetWork, chain: remote });
    expect((await listIncomingMigrations(server, true)).map(item => item.status)).toEqual(["completed", "completed"]);
  });

  it("keeps a blocked migration durable and retries only when requested", async () => {
    vi.mocked(applyIncomingNovelMigration).mockRejectedValueOnce(new Error("Unknown local chapter"));
    expect(await syncIncomingNovelMigrations(server, "token")).toMatchObject({ applied: 0, pending: 1, error: "Unknown local chapter" });
    expect(await getIncomingMigrationCursor(server)).toBe(1);
    await syncIncomingNovelMigrations(server, "token", undefined, false);
    expect(applyIncomingNovelMigration).toHaveBeenCalledOnce();
    expect(await syncIncomingNovelMigrations(server, "token")).toEqual({ applied: 1, pending: 0 });
  });

  it("reconsiders a blocked predecessor automatically when a later migration arrives", async () => {
    vi.mocked(applyIncomingNovelMigration).mockRejectedValueOnce(new ContentServerError(404));
    expect(await syncIncomingNovelMigrations(server, "token")).toMatchObject({ pending: 1 });
    expect((await listIncomingMigrations(server))[0]?.status).toBe("blocked");
    remote.push(edge("b", "c", 2));
    expect(await syncIncomingNovelMigrations(server, "token", undefined, false)).toEqual({ applied: 2, pending: 0 });
    expect(vi.mocked(applyIncomingNovelMigration).mock.calls[1]?.[2]).toMatchObject({ targetWork: remote[1]!.targetWork });
  });

  it("records a retryable server error without deleting local state", async () => {
    vi.mocked(applyIncomingNovelMigration).mockRejectedValueOnce(new ContentServerError(503));
    expect(await syncIncomingNovelMigrations(server, "token")).toMatchObject({ pending: 1 });
    expect((await listIncomingMigrations(server))[0]?.status).toBe("failed");
    expect(sqlite.prepare("SELECT count(*) AS count FROM local_merge").get()?.count).toBe(0);
    expect(await syncIncomingNovelMigrations(server, "token", undefined, false)).toEqual({ applied: 1, pending: 0 });
  });

  it("automatically retries a transport failure after connectivity returns", async () => {
    vi.mocked(applyIncomingNovelMigration).mockRejectedValueOnce(new ContentServerTransportError("Connection unavailable"));
    expect(await syncIncomingNovelMigrations(server, "token")).toMatchObject({ applied: 0, pending: 1 });
    expect((await listIncomingMigrations(server))[0]?.status).toBe("failed");
    expect(await syncIncomingNovelMigrations(server, "token", undefined, false)).toEqual({ applied: 1, pending: 0 });
  });

  it("revalidates remote history once before commit instead of fetching it for every chapter", async () => {
    const actual = vi.mocked(applyIncomingNovelMigration).getMockImplementation()!;
    vi.mocked(applyIncomingNovelMigration).mockImplementationOnce(async (...args) => {
      for (let index = 0; index < 100; index++) await args[3].assertCurrent();
      return actual(...args);
    });
    await syncIncomingNovelMigrations(server, "token");
    const reads = vi.mocked(contentServerRequest).mock.calls.filter(call => call[1] === `/work-migrations/${remote[0]!.operationId}`);
    expect(reads).toHaveLength(2);
  });

  it("accepts a newer revocation without applying the historical active event", async () => {
    await saveIncomingMigration(incomingMigrationFromLineage(server, remote[0]!));
    remote[0] = { ...remote[0]!, sequence: 2, active: false };
    expect(await syncIncomingNovelMigrations(server, "token")).toEqual({ applied: 0, pending: 0 });
    expect(applyIncomingNovelMigration).not.toHaveBeenCalled();
    expect((await listIncomingMigrations(server, true))[0]?.status).toBe("inactive");
  });

  it("rolls back the local commit if any saved successor was revoked after HTTP validation", async () => {
    remote.push(edge("b", "c", 2));
    vi.mocked(applyIncomingNovelMigration).mockImplementationOnce(async (_server, _token, resolved, options) => {
      await options.assertCurrent();
      await options.beforeCommit?.();
      const successor = { ...remote[1]!, sequence: 3, active: false };
      remote[1] = successor;
      const previous = (await listIncomingMigrations(server, true)).find(item => item.operationId === successor.operationId);
      await saveIncomingMigration(incomingMigrationFromLineage(server, successor, previous));
      await runDatabaseTransaction(async raw => {
        await raw.execute("INSERT INTO local_merge(operation) VALUES($1)", [resolved.chain[0]!.operationId]);
        await options.recordIncomingMigration(raw);
      });
      return null;
    });
    const result = await syncIncomingNovelMigrations(server, "token");
    expect(result).toMatchObject({ applied: 0, pending: 1, error: expect.stringContaining("chain changed") });
    expect(sqlite.prepare("SELECT count(*) AS count FROM local_merge").get()?.count).toBe(0);
  });

  it("does not advance the cursor or apply a malformed page", async () => {
    remote[0]!.deletedSource.revision = hash("c");
    await expect(syncIncomingNovelMigrations(server, "token")).rejects.toThrow();
    expect(await getIncomingMigrationCursor(server)).toBe(0);
    expect(await listIncomingMigrations(server, true)).toEqual([]);
    expect(applyIncomingNovelMigration).not.toHaveBeenCalled();
  });

  it("stops before changes when server capability or current connection validation fails", async () => {
    const actual = vi.mocked(contentServerRequest).getMockImplementation()!;
    vi.mocked(contentServerRequest).mockImplementationOnce(async () => ({}) as never);
    await expect(syncIncomingNovelMigrations(server, "token")).rejects.toThrow("Update the content server");
    vi.mocked(contentServerRequest).mockImplementation(actual);
    await expect(syncIncomingNovelMigrations(server, "token", () => { throw new Error("Connection changed"); })).rejects.toThrow("Connection changed");
    expect(applyIncomingNovelMigration).not.toHaveBeenCalled();
  });
});

it("preserves a later target-primary body choice through the full migration chain", () => {
  const first = edge();
  const second = edge("b", "c", 2);
  second.chapterDecisions[0]!.discardSourceContent = true;
  second.mappings = [{ source: second.mappings[0]!.source, decision: "delete-source", target: null, targetInventory: null }];
  expect(resolveIncomingNovelMigration(first, [first, second]).chapterDecisions[0]).toMatchObject({
    sourceChapterPath: "/a/1", targetChapterPath: "/c/1", discardSourceContent: true,
  });
});
