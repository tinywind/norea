import type Database from "@tauri-apps/plugin-sql";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, runDatabaseTransaction } from "../../db/client";
import {
  getIncomingMigrationCursor, incomingMigrationFromLineage, INCOMING_MIGRATION_CACHE_PREFIX,
  listIncomingMigrations, parseWorkMigrationLineage, saveIncomingMigration, saveIncomingMigrationCursor,
  type IncomingMigration, type WorkMigrationLineage,
} from "./migration-feed-state";

vi.mock("../../db/client", () => ({ getDb: vi.fn(), runDatabaseTransaction: vi.fn() }));

const server = "https://content.test";
const hash = (character: string) => character.repeat(64);
function lineage(): WorkMigrationLineage {
  const identity = (pluginId: string) => ({ pluginId, novelId: "work", novelPath: "/work" });
  const metadata = (pluginId: string) => ({
    schemaVersion: 1 as const, identity: identity(pluginId),
    novel: { name: "Work", author: "Writer", artist: null, summary: null, status: null, genres: null, rating: null, isLocal: false },
    cover: null, chapters: { "1": "First chapter" },
  });
  return {
    sequence: 17, operationId: "11111111-2222-3333-4444-555555555555",
    sourceWork: { id: hash("1"), revision: hash("a"), identity: identity("source"), metadata: metadata("source"), coverSha256: null },
    targetWork: { id: hash("2"), revision: hash("b"), identity: identity("target"), metadata: metadata("target"), coverSha256: null },
    deletedSource: { revision: hash("a"), sequence: 42 },
    mappings: [{
      source: { id: hash("3"), revision: hash("c"), chapterPath: "/source/1", chapterNumber: "1", name: "First chapter", position: 1, complete: true, available: true },
      decision: "copy-source",
      target: { id: hash("4"), revision: hash("d"), chapterPath: "/target/1", chapterNumber: "1", name: "First chapter", position: 1, complete: true, available: true },
      targetInventory: { body: { sha256: hash("e"), bytes: 100 }, expectedAssetKeys: [], storedAssets: [] },
    }],
    chapterDecisions: [{
      sourceChapterPath: "/source/1", sourceChapterNumber: "1", targetChapterPath: "/target/1", targetChapterNumber: "1",
      sourceMetadataVerified: true, targetMetadataVerified: true,
    }],
    fullDecisionCoverage: true, active: true,
  };
}

describe("incoming work migration validation", () => {
  it("keeps captured metadata, body decisions, and retirement identity without sharing mutable input", () => {
    const input = lineage();
    const parsed = parseWorkMigrationLineage(input);
    expect(parsed).toEqual(input);
    input.sourceWork.metadata.novel.author = "Changed later";
    input.mappings[0]!.source.chapterPath = "/changed";
    expect(parsed.sourceWork.metadata.novel.author).toBe("Writer");
    expect(parsed.mappings[0]!.source.chapterPath).toBe("/source/1");
  });

  it("accepts explicit deletion of a missing source body without inventing a target payload", () => {
    const input = lineage();
    input.mappings = [{ source: { ...input.mappings[0]!.source, available: false }, decision: "delete-source", target: null, targetInventory: null }];
    input.chapterDecisions[0] = { ...input.chapterDecisions[0]!, targetChapterPath: null, targetChapterNumber: null, targetMetadataVerified: false };
    expect(parseWorkMigrationLineage(input).mappings[0]).toMatchObject({ decision: "delete-source", target: null, source: { available: false } });
  });

  it("accepts metadata-only decisions and a legacy proof without claiming full decision coverage", () => {
    const metadataOnly = lineage();
    metadataOnly.mappings = [];
    expect(parseWorkMigrationLineage(metadataOnly).chapterDecisions).toEqual(metadataOnly.chapterDecisions);
    const legacy = lineage();
    legacy.fullDecisionCoverage = false;
    legacy.chapterDecisions = [];
    expect(parseWorkMigrationLineage(legacy).fullDecisionCoverage).toBe(false);
  });

  it("matches folder aliases by unambiguous chapter number and preserves body-only target inventories", () => {
    const input = lineage();
    const mapping = input.mappings[0]!;
    if (!mapping.target) throw new Error("Fixture needs a target");
    mapping.source.chapterPath = "norea-folder:1";
    mapping.target.chapterPath = "norea-folder:1";
    mapping.targetInventory.expectedAssetKeys = null;
    expect(parseWorkMigrationLineage(input)).toEqual(input);
  });

  it("verifies omitted decision numbers from their exact package paths", () => {
    const input = lineage();
    input.chapterDecisions[0]!.sourceChapterNumber = null;
    input.chapterDecisions[0]!.targetChapterNumber = null;
    expect(parseWorkMigrationLineage(input)).toEqual(input);
  });

  it.each([
    ["missing source metadata", (value: WorkMigrationLineage) => { delete (value.sourceWork as Partial<typeof value.sourceWork>).metadata; }],
    ["wrong metadata identity", (value: WorkMigrationLineage) => { value.targetWork.metadata.identity.novelId = "other"; }],
    ["local identity", (value: WorkMigrationLineage) => { value.sourceWork.metadata.novel.isLocal = true; }],
    ["same source and target", (value: WorkMigrationLineage) => { value.targetWork = structuredClone(value.sourceWork); }],
    ["invalid operation", (value: WorkMigrationLineage) => { value.operationId = "../other"; }],
    ["invalid legacy operation", (value: WorkMigrationLineage) => { value.legacyOperationId = "../other"; }],
    ["invalid sequence", (value: WorkMigrationLineage) => { value.sequence = 1.5; }],
    ["retirement mismatch", (value: WorkMigrationLineage) => { value.deletedSource.revision = hash("f"); }],
    ["unavailable source body", (value: WorkMigrationLineage) => { value.mappings[0]!.source.available = false; }],
    ["incomplete target body", (value: WorkMigrationLineage) => { value.mappings[0]!.target!.complete = false; }],
    ["missing target body", (value: WorkMigrationLineage) => { value.mappings[0]!.targetInventory!.body = null; }],
    ["empty target body", (value: WorkMigrationLineage) => { value.mappings[0]!.targetInventory!.body!.bytes = 0; }],
    ["missing declared asset", (value: WorkMigrationLineage) => { value.mappings[0]!.targetInventory!.expectedAssetKeys = ["media/page.png"]; }],
    ["unsafe asset key", (value: WorkMigrationLineage) => { value.mappings[0]!.targetInventory!.expectedAssetKeys = ["media/../page.png"]; }],
    ["repeated source package", (value: WorkMigrationLineage) => { value.mappings.push(structuredClone(value.mappings[0]!)); }],
    ["path and number mismatch", (value: WorkMigrationLineage) => { value.chapterDecisions[0]!.sourceChapterNumber = "2"; }],
    ["invalid chapter number", (value: WorkMigrationLineage) => { value.mappings[0]!.source.chapterNumber = "NaN"; }],
    ["invalid path", (value: WorkMigrationLineage) => { value.chapterDecisions[0]!.sourceChapterPath = "\u0000/one"; }],
    ["invalid position", (value: WorkMigrationLineage) => { value.mappings[0]!.source.position = Number.NaN; }],
    ["wrong source metadata flag", (value: WorkMigrationLineage) => { value.chapterDecisions[0]!.sourceMetadataVerified = false; }],
    ["wrong target metadata flag", (value: WorkMigrationLineage) => { value.chapterDecisions[0]!.targetMetadataVerified = false; }],
    ["missing source metadata decision", (value: WorkMigrationLineage) => { value.sourceWork.metadata.chapters["2"] = "Second chapter"; }],
    ["missing package decision", (value: WorkMigrationLineage) => { value.chapterDecisions = []; }],
    ["mapping target differs", (value: WorkMigrationLineage) => { value.chapterDecisions[0]!.targetChapterPath = "/other"; value.chapterDecisions[0]!.targetChapterNumber = "2"; }],
    ["deleted decision has target number", (value: WorkMigrationLineage) => { value.chapterDecisions[0]!.targetChapterPath = null; }],
    ["deletion without full coverage", (value: WorkMigrationLineage) => {
      value.fullDecisionCoverage = false; value.chapterDecisions = [];
      value.mappings = [{ source: value.mappings[0]!.source, decision: "delete-source", target: null, targetInventory: null }];
    }],
    ["deletion contradicts selected target", (value: WorkMigrationLineage) => {
      value.mappings = [{ source: value.mappings[0]!.source, decision: "delete-source", target: null, targetInventory: null }];
    }],
  ] as const)("rejects %s before a local migration can apply", (_name, mutate) => {
    const input = lineage();
    mutate(input);
    expect(() => parseWorkMigrationLineage(input)).toThrow();
  });
});

describe("incoming migration events", () => {
  it("retains an explicit legacy operation binding through persistence and revocation", () => {
    const input = { ...lineage(), legacyOperationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
    expect(parseWorkMigrationLineage(input)).toEqual(input);
    const previous = JSON.parse(JSON.stringify(incomingMigrationFromLineage(server, input))) as IncomingMigration;
    const revoked = incomingMigrationFromLineage(server, { ...input, sequence: 18, active: false }, previous);
    expect(revoked).toMatchObject({ status: "inactive", lineage: { legacyOperationId: input.legacyOperationId } });
    expect(() => incomingMigrationFromLineage(server, {
      ...input, sequence: 19, legacyOperationId: "99999999-bbbb-cccc-dddd-eeeeeeeeeeee",
    }, revoked)).toThrow("immutable lineage");
  });

  it("preserves completed receipts across identical replays and newer active events", () => {
    const completed = { ...incomingMigrationFromLineage(server + "/", lineage()), status: "completed" as const };
    expect(completed.serverUrl).toBe(server);
    expect(incomingMigrationFromLineage(server, lineage(), completed)).toEqual(completed);
    expect(incomingMigrationFromLineage(server, { ...lineage(), sequence: 18 }, completed)).toMatchObject({ sequence: 18, status: "completed" });
  });

  it("accepts revocation and ignores an older active event without reviving the source hold", () => {
    const completed = { ...incomingMigrationFromLineage(server, lineage()), status: "completed" as const };
    const inactive = incomingMigrationFromLineage(server, { ...lineage(), sequence: 18, active: false }, completed);
    expect(inactive).toMatchObject({ sequence: 18, status: "inactive", lineage: { active: false } });
    expect(incomingMigrationFromLineage(server, lineage(), inactive)).toEqual(inactive);
  });

  it("rejects an immutable rewrite and an active-state change without a new event", () => {
    const previous = incomingMigrationFromLineage(server, lineage());
    const changed = lineage();
    changed.targetWork.metadata.novel.author = "Another author";
    expect(() => incomingMigrationFromLineage(server, changed, previous)).toThrow("immutable lineage");
    expect(() => incomingMigrationFromLineage(server, { ...lineage(), active: false }, previous)).toThrow("new sequence");
    expect(() => incomingMigrationFromLineage("https://another.test", lineage(), previous)).toThrow("immutable lineage");
  });
});

describe("incoming migration receipts", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE content_sync_cache(cache_key TEXT PRIMARY KEY NOT NULL,payload TEXT NOT NULL)");
    db = {
      select: async (query: string, values: unknown[] = []) => sqlite.prepare(query).all(
        Object.fromEntries(values.map((value, index) => ["$" + (index + 1), value])) as never),
      execute: async (query: string, values: unknown[] = []) => {
        const result = sqlite.prepare(query).run(Object.fromEntries(values.map((value, index) => ["$" + (index + 1), value])) as never);
        return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
      },
    } as Database;
    vi.mocked(getDb).mockReset().mockResolvedValue(db);
    vi.mocked(runDatabaseTransaction).mockReset().mockImplementation(async run => {
      sqlite.exec("BEGIN IMMEDIATE");
      try { const result = await run(db); sqlite.exec("COMMIT"); return result; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    });
  });
  afterEach(() => sqlite.close());

  it("partitions receipts and cursors by normalized server identity", async () => {
    const first = incomingMigrationFromLineage(server, lineage());
    const second = incomingMigrationFromLineage("https://another.test", { ...lineage(), sequence: 2 });
    await saveIncomingMigration(first);
    await saveIncomingMigration(second);
    expect(await listIncomingMigrations(server + "/")).toEqual([first]);
    expect(await listIncomingMigrations("https://another.test")).toEqual([second]);
    expect(await getIncomingMigrationCursor(server)).toBe(0);
    await saveIncomingMigrationCursor(server + "/", 17);
    await saveIncomingMigrationCursor("https://another.test", 2);
    await saveIncomingMigrationCursor(server, 5);
    expect(await getIncomingMigrationCursor(server)).toBe(17);
    expect(await getIncomingMigrationCursor("https://another.test/")).toBe(2);
  });

  it("commits a receipt and cursor inside the caller's transaction and rolls both back with it", async () => {
    const record = incomingMigrationFromLineage(server, lineage());
    sqlite.exec("BEGIN");
    await saveIncomingMigration(record, db);
    await saveIncomingMigrationCursor(server, 17, db);
    expect(await listIncomingMigrations(server, false, db)).toEqual([record]);
    expect(await getIncomingMigrationCursor(server, db)).toBe(17);
    expect(getDb).not.toHaveBeenCalled();
    expect(runDatabaseTransaction).not.toHaveBeenCalled();
    sqlite.exec("ROLLBACK");
    expect(await listIncomingMigrations(server)).toEqual([]);
    expect(await getIncomingMigrationCursor(server)).toBe(0);
  });

  it("preserves completed work against a late failure and releases it after a newer inactive event", async () => {
    const pending = incomingMigrationFromLineage(server, lineage());
    const completed: IncomingMigration = { ...pending, status: "completed" };
    await saveIncomingMigration(pending);
    await saveIncomingMigration(completed);
    await saveIncomingMigration({ ...pending, status: "failed", error: "Late network failure" });
    expect(await listIncomingMigrations(server)).toEqual([]);
    expect(await listIncomingMigrations(server, true)).toEqual([completed]);
    const inactive = incomingMigrationFromLineage(server, { ...lineage(), sequence: 18, active: false }, completed);
    await saveIncomingMigration(inactive);
    await saveIncomingMigration(completed);
    expect(await listIncomingMigrations(server)).toEqual([]);
    expect(await listIncomingMigrations(server, true)).toEqual([inactive]);
  });

  it("rejects a changed proof without overwriting the durable receipt", async () => {
    const record = incomingMigrationFromLineage(server, lineage());
    await saveIncomingMigration(record);
    const changed = lineage();
    changed.targetWork.metadata.novel.author = "Changed";
    await expect(saveIncomingMigration(incomingMigrationFromLineage(server, changed))).rejects.toThrow("immutable lineage");
    expect(await listIncomingMigrations(server, true)).toEqual([record]);
  });

  it("does not match another server whose URL only differs at a SQL wildcard", async () => {
    const first = incomingMigrationFromLineage("https://content.test/a_b", lineage());
    const second = incomingMigrationFromLineage("https://content.test/axb", lineage());
    await saveIncomingMigration(first);
    await saveIncomingMigration(second);
    expect(await listIncomingMigrations(first.serverUrl)).toEqual([first]);
  });

  it("fails closed when a cache key and payload describe different operations", async () => {
    const record = incomingMigrationFromLineage(server, lineage());
    const key = INCOMING_MIGRATION_CACHE_PREFIX + JSON.stringify([server, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"]);
    sqlite.prepare("INSERT INTO content_sync_cache VALUES(?,?)").run(key, JSON.stringify(record));
    await expect(listIncomingMigrations(server)).rejects.toThrow("cache identity");
  });

  it("rejects corrupt cursor payloads and invalid cursor values without silently resetting progress", async () => {
    sqlite.prepare("INSERT INTO content_sync_cache VALUES(?,?)").run("norea-content-incoming-migration-cursor:" + server,
      JSON.stringify({ version: 1, serverUrl: "https://wrong.test", cursor: 12 }));
    await expect(getIncomingMigrationCursor(server)).rejects.toThrow("cursor");
    await expect(saveIncomingMigrationCursor(server, -1)).rejects.toThrow("sequence");
  });
});

it("preserves an explicit source-body discard with a live reading-state target", () => {
  const input = lineage();
  input.chapterDecisions[0]!.discardSourceContent = true;
  input.mappings = [{ source: input.mappings[0]!.source, decision: "delete-source", target: null, targetInventory: null }];
  expect(parseWorkMigrationLineage(input).chapterDecisions[0]).toMatchObject({
    targetChapterPath: "/target/1", discardSourceContent: true,
  });
  delete input.chapterDecisions[0]!.discardSourceContent;
  expect(() => parseWorkMigrationLineage(input)).toThrow(/contradicts/);
});
