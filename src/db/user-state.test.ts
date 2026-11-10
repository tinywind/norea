import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type Database from "@tauri-apps/plugin-sql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client", () => ({
  getDb: vi.fn(), getReadOnlyDb: vi.fn(), runDatabaseTransaction: vi.fn(), runExclusiveDatabaseOperation: vi.fn(),
}));
import { getDb, getReadOnlyDb, runDatabaseTransaction, runExclusiveDatabaseOperation } from "./client";
import {
  acknowledgeUserStateOperationsInDb, applyUserStateReadPageInDb, bindUserStateWorkspaceInDb,
  listUserStateConflictsInDb, listUserStateDeferredInDb, prepareUserStateOperationsInDb, resolveUserStateLedgerConflictInDb,
} from "./user-state-ledger";
import {
  discardUserStateNotifications, notifyUserStateCommitted,
  recordUserStateChangesInDb, stableCategoryIdInDb, subscribeUserStateChanges, waitForUserStateDeferredApply,
} from "./user-state-core";
import { materializeUserStateRecordInDb, refreshUnattemptedUserStateIdentitiesInDb } from "./user-state-materialize";
import {
  applyUserStateReadPage, deferUserStateForNovelInDb, materializePendingUserState, recordUserResume, resumeUserStateAfterRestore, setUserStateActiveServer,
} from "./user-state";
import { applyNovelMergeInDb } from "./queries/novel-merge";
import { deleteLocalNovelRecords } from "./queries/content-deletion";
import { remapPendingUserStateInDb } from "./user-state-migration";
import {
  canonicalUserStateJson, userStateEntityKey, type UserStateBinding, type UserStateEntity,
  type UserStateOperation, type UserStateRecord, type UserStateValue, type UserStateValueMap, type UserStateWorkReference,
} from "../lib/user-state/types";
import { clearNovelHistory, setChapterBookmark, setChaptersReadState, setNovelsReadState, setRelativeChaptersReadState, restoreChapterReadStates, updateChapterProgress, upsertSourceChapters } from "./queries/chapter";
import { setNovelInLibrary } from "./queries/novel";
import { deleteCategory, insertCategory, setNovelCategories, updateCategory } from "./queries/category";
import { clearLibraryMembership, clearReadingProgress, clearUpdatesTab } from "./queries/maintenance";
import { setChapterComposition } from "./chapter-composition";
import type { ChapterCompositionV1 } from "../lib/chapter-composition";

interface Fixture { sql: DatabaseSync; db: Database }
const fixtures: Fixture[] = [];
let active: Fixture;
const binding: UserStateBinding = { serverUrl: "https://state.example", workspaceId: "workspace-1", epoch: "epoch-1" };
const work: UserStateWorkReference = { pluginId: "source", sourceNovelId: "book", novelPath: "/book", name: "Book" };
const reading: UserStateEntity = { kind: "reading", work, chapter: { chapterPath: "/chapter/1", name: "One" } };
const readingValue = (progress: number, unread = progress < 100): UserStateValueMap["reading"] => ({ progress, unread, readAt: null });
function fixture(): Fixture {
  const sql = new DatabaseSync(":memory:");
  sql.exec("PRAGMA foreign_keys=ON");
  for (const match of readFileSync("src-tauri/src/database.rs", "utf8").matchAll(/version:\s*(\d+),\s*description:[\s\S]*?sql:\s*include_str!\("([^"]+)"\)/g)) {
    sql.exec(readFileSync("src-tauri/src/" + match[2], "utf8"));
  }
  const params = (values: unknown[]) => Object.fromEntries(values.map((value, index) => ["$" + (index + 1), value]));
  const db = {
    select: async (query: string, values: unknown[] = []) => sql.prepare(query).all(params(values) as never),
    execute: async (query: string, values: unknown[] = []) => {
      const result = sql.prepare(query).run(params(values) as never);
      return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
  } as Database;
  const result = { sql, db }; fixtures.push(result); return result;
}
function addWork(target: Fixture, id = 1, chapterId = 11, reference = work): void {
  target.sql.prepare("INSERT INTO novel(id,plugin_id,source_novel_id,path,name) VALUES(?,?,?,?,?)").run(id, reference.pluginId, reference.sourceNovelId, reference.novelPath, reference.name);
  target.sql.prepare("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position) VALUES(?,?,'/chapter/1','One','1',1)").run(chapterId, id);
}
async function tx<T>(target: Fixture, run: (db: Database) => Promise<T>): Promise<T> {
  target.sql.exec("BEGIN IMMEDIATE");
  try { const result = await run(target.db); target.sql.exec("COMMIT"); notifyUserStateCommitted(target.db); return result; }
  catch (error) { target.sql.exec("ROLLBACK"); discardUserStateNotifications(target.db); throw error; }
}
function shared(entity: UserStateEntity, value: UserStateValue, revision: number, operationId = "remote-" + revision): UserStateRecord {
  return { entity, value, revision, operationId, updatedAt: revision, deviceId: "other-device", deviceName: "Other device" };
}
async function bind(target = active): Promise<void> { await tx(target, db => bindUserStateWorkspaceInDb(db, binding)); }
async function capture(value: UserStateValue, entity = reading, target = active): Promise<void> {
  await tx(target, db => recordUserStateChangesInDb(db, [{ entity, value }]));
}
async function prepare(target = active): Promise<UserStateOperation[]> { return tx(target, db => prepareUserStateOperationsInDb(db, binding)); }
async function ack(operation: UserStateOperation, revision: number, target = active): Promise<void> {
  await tx(target, db => acknowledgeUserStateOperationsInDb(db, binding, [{ operationId: operation.operationId, status: "applied",
    current: shared(operation.entity, operation.value, revision, operation.operationId) }]));
}
beforeEach(() => {
  active = fixture(); addWork(active);
  vi.mocked(getDb).mockImplementation(async () => active.db);
  vi.mocked(getReadOnlyDb).mockImplementation(async () => active.db);
  vi.mocked(runDatabaseTransaction).mockImplementation(run => tx(active, run));
  vi.mocked(runExclusiveDatabaseOperation).mockImplementation(async run => run(active.db));
  setUserStateActiveServer(binding.serverUrl);
});
afterEach(async () => { setUserStateActiveServer(null); await waitForUserStateDeferredApply(); while (fixtures.length) fixtures.pop()!.sql.close(); });

describe("durable personal-state ledger", () => {
  it("uses stable identities when two devices have colliding local integer IDs", async () => {
    const recipient = fixture();
    addWork(recipient, 1, 11, { ...work, sourceNovelId: "unrelated", novelPath: "/other" });
    addWork(recipient, 99, 88, { ...work, sourceNovelId: "BOOK", novelPath: "/redirected" });
    await bind(); await capture(readingValue(73)); const [operation] = await prepare();
    await bind(recipient); active = recipient;
    await applyUserStateReadPage(binding, { version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch,
      headRevision: 1, through: 1, nextCursor: 1, hasMore: false, records: [shared(operation.entity, operation.value, 1)] });
    expect(recipient.sql.prepare("SELECT id,progress FROM chapter ORDER BY id").all()).toEqual([{ id: 11, progress: 0 }, { id: 88, progress: 0 }]);
    await waitForUserStateDeferredApply();
    expect(recipient.sql.prepare("SELECT id,progress FROM chapter ORDER BY id").all()).toEqual([{ id: 11, progress: 0 }, { id: 88, progress: 73 }]);
    expect(recipient.sql.prepare("SELECT count(*) AS count FROM user_state_intent").get()).toEqual({ count: 0 });
  });

  it("does not lose a projection request that arrives while the background runner is active", async () => {
    await bind();
    active.sql.exec("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position) VALUES(12,1,'/chapter/2','Two','2',2)");
    const secondEntity: UserStateEntity = { kind: "reading", work, chapter: { chapterPath: "/chapter/2", name: "Two" } };
    await applyUserStateReadPage(binding, { version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch,
      headRevision: 1, through: 1, nextCursor: 1, hasMore: false, records: [shared(reading, readingValue(31), 1)] });
    await applyUserStateReadPage(binding, { version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch,
      headRevision: 2, through: 2, nextCursor: 2, hasMore: false, records: [shared(secondEntity, readingValue(47), 2)] });
    await waitForUserStateDeferredApply();
    expect(active.sql.prepare("SELECT id,progress FROM chapter WHERE id IN (11,12) ORDER BY id").all())
      .toEqual([{ id: 11, progress: 31 }, { id: 12, progress: 47 }]);
  });

  it("stores five thousand received records with a bounded number of SQLite bridge calls", async () => {
    await bind();
    let selects = 0, executes = 0;
    const counted = {
      select: async (query: string, values: unknown[] = []) => { selects++; return active.db.select(query, values); },
      execute: async (query: string, values: unknown[] = []) => { executes++; return active.db.execute(query, values); },
    } as Database;
    const records = Array.from({ length: 5000 }, (_, index) => shared(
      { kind: "category", categoryId: "received-" + index },
      { name: "Received " + index, sort: index, deleted: false },
      index + 1,
    ));
    await applyUserStateReadPageInDb(counted, binding, {
      version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch,
      headRevision: records.length, through: records.length, nextCursor: records.length, hasMore: false, records,
    });
    expect(active.sql.prepare("SELECT COUNT(*) AS count FROM user_state_record").get()).toEqual({ count: 5000 });
    expect(selects).toBeLessThan(10);
    expect(executes).toBeLessThan(10);
  });

  it("migrates a current-snapshot workspace into the delta outbox exactly once", async () => {
    const namespace = canonicalUserStateJson([binding.serverUrl, binding.workspaceId, binding.epoch]);
    active.sql.prepare("INSERT INTO user_state_workspace(server_url,namespace,workspace_id,epoch) VALUES(?,?,?,?)")
      .run(binding.serverUrl, namespace, binding.workspaceId, binding.epoch);
    active.sql.exec("UPDATE chapter SET bookmark=1,progress=64,unread=0,read_at=10");
    await bind();
    const first = await prepare();
    expect(first.map(operation => operation.entity.kind).sort()).toEqual(["bookmark", "reading", "resume"]);
    expect(first.every(operation => operation.seed && operation.baseRevision === 0)).toBe(true);
    const before = active.sql.prepare("SELECT sequence,entity_key FROM user_state_intent ORDER BY sequence").all();
    await bind();
    expect(active.sql.prepare("SELECT sequence,entity_key FROM user_state_intent ORDER BY sequence").all()).toEqual(before);
    expect(active.sql.prepare("SELECT COUNT(*) AS count FROM content_sync_cache WHERE cache_key=?")
      .get("user-state-delta-ready:" + namespace)).toEqual({ count: 1 });
  });

  it("seeds only positive state and never fabricates default resets", async () => {
    await bind();
    expect(await prepare()).toEqual([]);
    active.sql.exec("UPDATE chapter SET bookmark=1,progress=100,unread=0,read_at=10");
    const second = { ...binding, serverUrl: "https://second.example" };
    await tx(active, db => bindUserStateWorkspaceInDb(db, second));
    const operations = await tx(active, db => prepareUserStateOperationsInDb(db, second));
    expect(operations.map(operation => operation.entity.kind).sort()).toEqual(["bookmark", "reading", "resume"]);
    expect(operations.every(operation => operation.seed && operation.baseRevision === 0)).toBe(true);
  });

  it("prepares every pending operation that fits the byte budget instead of stopping at 200 items", async () => {
    await bind();
    const entries = Array.from({ length: 1681 }, (_, index) => ({
      entity: { kind: "category" as const, categoryId: "bulk-" + index },
      value: { name: "Bulk " + index, sort: index, deleted: false },
    }));
    await tx(active, db => recordUserStateChangesInDb(db, entries));
    const operations = await prepareUserStateOperationsInDb(active.db, binding, { maxBytes: 30 * 1024 * 1024 });
    expect(operations).toHaveLength(1681);
  });

  it("acknowledges 1681 receipts with bounded SQLite bridge calls", async () => {
    await bind();
    const entries = Array.from({ length: 1681 }, (_, index) => ({
      entity: { kind: "reading" as const, work, chapter: { chapterPath: "/bulk/" + index, name: "Bulk " + index } },
      value: readingValue(index % 101),
    }));
    await tx(active, db => recordUserStateChangesInDb(db, entries));
    const operations = await tx(active, db => prepareUserStateOperationsInDb(db, binding, { maxBytes: 30 * 1024 * 1024 }));
    expect(operations).toHaveLength(1681);
    const results = operations.map((operation, index) => ({
      operationId: operation.operationId, status: "applied" as const,
      current: shared(operation.entity, operation.value, index + 1, operation.operationId),
    }));
    let selects = 0, executes = 0;
    const counted = {
      select: async (query: string, values: unknown[] = []) => { selects++; return active.db.select(query, values); },
      execute: async (query: string, values: unknown[] = []) => { executes++; return active.db.execute(query, values); },
    } as Database;
    await acknowledgeUserStateOperationsInDb(counted, binding, results);
    expect(active.sql.prepare("SELECT COUNT(*) AS count FROM user_state_operation WHERE status='acknowledged'").get())
      .toEqual({ count: 1681 });
    expect(active.sql.prepare("SELECT COUNT(*) AS count FROM user_state_progress WHERE acknowledged_sequence=local_sequence").get())
      .toEqual({ count: 1681 });
    expect(selects).toBeLessThan(12);
    expect(executes).toBeLessThan(12);
  }, 15_000);

  it("replays a matching stored receipt to finish progress after an interrupted acknowledgement", async () => {
    await bind(); await capture(readingValue(61));
    const [operation] = await prepare();
    const result = {
      operationId: operation.operationId, status: "applied" as const,
      current: shared(operation.entity, operation.value, 7, operation.operationId),
    };
    active.sql.prepare("UPDATE user_state_operation SET status='acknowledged',receipt=? WHERE operation_id=?")
      .run(canonicalUserStateJson(result), operation.operationId);
    expect(active.sql.prepare("SELECT acknowledged_sequence,local_sequence FROM user_state_progress").get())
      .toEqual({ acknowledged_sequence: 0, local_sequence: 1 });

    await acknowledgeUserStateOperationsInDb(active.db, binding, [result]);

    expect(active.sql.prepare("SELECT status,receipt IS NOT NULL AS hasReceipt FROM user_state_operation").get())
      .toEqual({ status: "acknowledged", hasReceipt: 1 });
    expect(active.sql.prepare("SELECT acknowledged_sequence,local_sequence FROM user_state_progress").get())
      .toEqual({ acknowledged_sequence: 1, local_sequence: 1 });
    expect((await prepareUserStateOperationsInDb(active.db, binding))).toEqual([]);
  });

  it("marks equivalent acknowledgements as already projected so the following pull does not rewrite local state", async () => {
    await bind(); await capture(readingValue(61));
    const [operation] = await prepare();
    await ack(operation, 7);
    expect(active.sql.prepare("SELECT revision,applied_revision FROM user_state_record").get())
      .toEqual({ revision: 7, applied_revision: 7 });
    active.sql.prepare("UPDATE chapter SET progress=62 WHERE id=11").run();
    await applyUserStateReadPage(binding, { version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch,
      headRevision: 7, through: 7, nextCursor: 7, hasMore: false,
      records: [shared(operation.entity, operation.value, 7, operation.operationId)] });
    expect(active.sql.prepare("SELECT progress FROM chapter WHERE id=11").get()).toEqual({ progress: 62 });
  });

  it("freezes attempted bytes across retries and preserves a newer edit while acknowledging its ancestor", async () => {
    await bind(); await capture(readingValue(60));
    const [first] = await prepare();
    await capture(readingValue(0, true));
    expect(canonicalUserStateJson(await prepare())).toBe(canonicalUserStateJson([first]));
    await ack(first, 1);
    const [second] = await prepare();
    expect(second.operationId).not.toBe(first.operationId);
    expect(second.baseRevision).toBe(1);
    expect(second.value).toEqual(readingValue(0, true));
    const attempted = active.sql.prepare("SELECT payload FROM user_state_operation WHERE operation_id=?").get(first.operationId) as { payload: string };
    expect(attempted.payload).toBe(canonicalUserStateJson(first));
  });

  it("does not rebase a newer edit onto a competing record observed before an old receipt", async () => {
    await bind(); await capture(readingValue(60)); const [first] = await prepare();
    await capture(readingValue(0));
    await tx(active, db => applyUserStateReadPageInDb(db, binding, { version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch,
      headRevision: 2, through: 2, nextCursor: 2, hasMore: false, records: [shared(reading, readingValue(90), 2)] }));
    await ack(first, 1);
    const [second] = await prepare();
    expect(second.baseRevision).toBe(0);
    expect(second.value).toEqual(readingValue(0));
  });

  it("keeps read records and the frozen cursor boundary in one rollback-safe transaction", async () => {
    await bind();
    await tx(active, db => applyUserStateReadPageInDb(db, binding, { version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch,
      headRevision: 3, through: 3, nextCursor: 1, hasMore: true, records: [shared(reading, readingValue(10), 1)] }));
    await expect(tx(active, db => applyUserStateReadPageInDb(db, binding, { version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch,
      headRevision: 4, through: 4, nextCursor: 4, hasMore: false, records: [shared(reading, readingValue(20), 4)] }))).rejects.toThrow(/cursor/);
    expect(active.sql.prepare("SELECT cursor,read_through FROM user_state_workspace").get()).toEqual({ cursor: 1, read_through: 3 });
    expect(active.sql.prepare("SELECT revision FROM user_state_record").get()).toEqual({ revision: 1 });
    await expect(tx(active, db => bindUserStateWorkspaceInDb(db, { ...binding, epoch: "replaced-epoch" }))).rejects.toThrow(/workspace changed/);
  });

  it("retains conflicting values and rejects a stale conflict resolution after another local edit", async () => {
    await bind(); await capture(readingValue(0)); const [operation] = await prepare();
    await tx(active, db => acknowledgeUserStateOperationsInDb(db, binding, [{ operationId: operation.operationId,
      status: "conflict", current: shared(reading, readingValue(100, false), 8), reason: "revision-mismatch" }]));
    const [conflict] = await listUserStateConflictsInDb(active.db, binding);
    await capture(readingValue(20));
    await expect(tx(active, db => resolveUserStateLedgerConflictInDb(db, binding, { id: conflict.id, version: conflict.version, choice: "shared" }))).rejects.toThrow(/conflict changed/);
    const [current] = await listUserStateConflictsInDb(active.db, binding);
    await tx(active, db => resolveUserStateLedgerConflictInDb(db, binding, { id: current.id, version: current.version, choice: "local" }));
    const [next] = await prepare();
    expect(next.baseRevision).toBe(8); expect(next.value).toEqual(readingValue(20));
  });

  it("publishes unresolved work and recovered chapter identities only when the server advertises opaque retention", async () => {
    await bind();
    const opaqueWork = { ...work, sourceNovelId: null };
    const opaqueReading: UserStateEntity = {
      kind: "reading", work: opaqueWork, chapter: { chapterPath: "norea-folder:1", name: "Recovered one" },
    };
    const opaqueResume: UserStateEntity = { kind: "resume", work: opaqueWork };
    await tx(active, db => recordUserStateChangesInDb(db, [
      { entity: opaqueReading, value: readingValue(63, false) },
      { entity: opaqueResume, value: { chapter: { chapterPath: "local-folder:7", name: "Recovered local" }, anchor: null, openedAt: 77 } },
    ]));
    expect(await prepare()).toEqual([]);
    const operations = await tx(active, db => prepareUserStateOperationsInDb(db, binding, { allowOpaqueIdentity: true }));
    expect(operations).toHaveLength(2);
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: opaqueReading, value: readingValue(63, false) }),
      expect.objectContaining({ entity: opaqueResume, value: { chapter: { chapterPath: "local-folder:7", name: "Recovered local" }, anchor: null, openedAt: 77 } }),
    ]));
  });

  it("projects an opaque work only through the same plugin and exact work path", async () => {
    active.sql.exec("UPDATE novel SET source_novel_id=NULL WHERE id=1");
    await bind();
    const opaqueWork = { ...work, sourceNovelId: null };
    const opaque: UserStateEntity = { kind: "reading", work: opaqueWork, chapter: { chapterPath: "/chapter/1", name: "One" } };
    await applyUserStateReadPage(binding, { version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch,
      headRevision: 1, through: 1, nextCursor: 1, hasMore: false, records: [shared(opaque, readingValue(54, false), 1)] });
    await waitForUserStateDeferredApply();
    expect(active.sql.prepare("SELECT progress,unread FROM chapter WHERE id=11").get()).toEqual({ progress: 54, unread: 0 });
  });

  it("never creates a content row from a shared library record, even with a resolved source ID", async () => {
    await bind();
    active.sql.exec("DELETE FROM chapter; DELETE FROM novel");
    await applyUserStateReadPage(binding, { version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch,
      headRevision: 1, through: 1, nextCursor: 1, hasMore: false,
      records: [shared({ kind: "library", work }, { inLibrary: true, addedAt: 3 }, 1)] });
    await waitForUserStateDeferredApply();
    expect(active.sql.prepare("SELECT COUNT(*) AS count FROM novel").get()).toEqual({ count: 0 });
    expect(active.sql.prepare("SELECT revision,applied_revision FROM user_state_record").get()).toEqual({ revision: 1, applied_revision: 1 });
  });

  it("stores opaque library and recovered-chapter state without inventing missing content or matching by number", async () => {
    await bind();
    active.sql.exec("DELETE FROM chapter; DELETE FROM novel");
    const opaqueWork = { ...work, sourceNovelId: null };
    const library: UserStateEntity = { kind: "library", work: opaqueWork };
    await applyUserStateReadPage(binding, { version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch,
      headRevision: 1, through: 1, nextCursor: 1, hasMore: false,
      records: [shared(library, { inLibrary: true, addedAt: 3 }, 1)] });
    await waitForUserStateDeferredApply();
    expect(active.sql.prepare("SELECT COUNT(*) AS count FROM novel").get()).toEqual({ count: 0 });
    expect(active.sql.prepare("SELECT revision,applied_revision FROM user_state_record").get()).toEqual({ revision: 1, applied_revision: 1 });

    addWork(active, 1, 11, work);
    active.sql.exec("UPDATE chapter SET path='norea-folder:1'");
    const recovered: UserStateEntity = { kind: "reading", work, chapter: { chapterPath: "norea-folder:1", name: "Recovered" } };
    await applyUserStateReadPage(binding, { version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch,
      headRevision: 2, through: 2, nextCursor: 2, hasMore: false,
      records: [shared(recovered, readingValue(88, false), 2)] });
    await waitForUserStateDeferredApply();
    expect(active.sql.prepare("SELECT progress FROM chapter WHERE id=11").get()).toEqual({ progress: 0 });
    expect(active.sql.prepare("SELECT revision,applied_revision FROM user_state_record WHERE revision=2").get()).toEqual({ revision: 2, applied_revision: 2 });
  });

  it("holds unknown work identity without attempting it, then resolves only the exact imported work", async () => {
    active.sql.exec("UPDATE novel SET source_novel_id=NULL");
    await bind(); await setChapterBookmark(11, true);
    expect(await prepare()).toEqual([]);
    expect(await listUserStateDeferredInDb(active.db, binding)).toEqual([expect.objectContaining({ reason: "missing-work-identity" })]);
    active.sql.exec("UPDATE novel SET source_novel_id='book'");
    await tx(active, refreshUnattemptedUserStateIdentitiesInDb);
    const [operation] = await prepare();
    expect(operation.entity).toMatchObject({ kind: "bookmark", work: { sourceNovelId: "book" } });
  });

  it("stores shared state independently of missing content, then projects only after that content changes", async () => {
    active.sql.exec("DELETE FROM chapter"); await bind();
    await applyUserStateReadPage(binding, { version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch,
      headRevision: 1, through: 1, nextCursor: 1, hasMore: false, records: [shared(reading, readingValue(87), 1)] });
    await waitForUserStateDeferredApply();
    expect(await listUserStateDeferredInDb(active.db, binding)).toEqual([]);
    expect(active.sql.prepare("SELECT revision,applied_revision,payload FROM user_state_record").get()).toMatchObject({
      revision: 1, applied_revision: 1,
    });
    active.sql.exec("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position) VALUES(44,1,'/chapter/1','One','1',1)");
    await tx(active, db => deferUserStateForNovelInDb(db, 1));
    await waitForUserStateDeferredApply();
    expect(active.sql.prepare("SELECT progress FROM chapter").get()).toEqual({ progress: 87 });
    expect(await prepare()).toEqual([]);
    expect(await listUserStateDeferredInDb(active.db, binding)).toEqual([]);
  });
});

describe("explicit command boundaries", () => {
  it("classifies reading-position commits separately from user commands", async () => {
    await bind();
    const onChange = vi.fn(); const unsubscribe = subscribeUserStateChanges(onChange);
    await capture(readingValue(12));
    expect(onChange).toHaveBeenLastCalledWith("reading");
    await setChapterBookmark(11, true);
    expect(onChange).toHaveBeenLastCalledWith("normal");
    await tx(active, db => recordUserStateChangesInDb(db, [
      { entity: reading, value: readingValue(13) },
      { entity: { kind: "bookmark", work, chapter: reading.chapter }, value: { bookmarked: false } },
    ]));
    expect(onChange).toHaveBeenLastCalledWith("normal");
    unsubscribe();
  });

  it("records default no-op unread, bookmark removal and library removal as explicit changes", async () => {
    await bind(); await setChaptersReadState([11], true); await setChapterBookmark(11, false); await setNovelInLibrary(1, false);
    const operations = await prepare();
    expect(operations).toHaveLength(3);
    expect(operations.every(operation => !operation.seed)).toBe(true);
    expect(operations.find(operation => operation.entity.kind === "reading")!.value).toEqual(readingValue(0));
    expect(operations.find(operation => operation.entity.kind === "bookmark")!.value).toEqual({ bookmarked: false });
    expect(operations.find(operation => operation.entity.kind === "library")!.value).toEqual({ inLibrary: false, addedAt: null });
  });

  it("rolls back the user mutation when its durable intent cannot be recorded", async () => {
    await bind();
    active.sql.exec("CREATE TRIGGER reject_intent BEFORE INSERT ON user_state_intent BEGIN SELECT RAISE(ABORT,'journal failure'); END");
    const onChange = vi.fn(); const unsubscribe = subscribeUserStateChanges(onChange);
    await expect(setChapterBookmark(11, true)).rejects.toThrow(/journal failure/);
    unsubscribe();
    expect(active.sql.prepare("SELECT bookmark FROM chapter").get()).toEqual({ bookmark: 0 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("records bulk, relative, undo and maintenance resets even when their selected values already match", async () => {
    active.sql.exec("INSERT INTO chapter(id,novel_id,path,name,chapter_number,position) VALUES(12,1,'/chapter/2','Two','2',2)");
    await bind(); await setNovelsReadState([1], true);
    const first = active.sql.prepare("SELECT COUNT(*) AS count FROM user_state_intent").get();
    expect(first).toEqual({ count: 2 });
    await setRelativeChaptersReadState(11, "after", true);
    await restoreChapterReadStates([{ id: 11, progress: 0, unread: true }]);
    await clearReadingProgress(); await clearLibraryMembership();
    const operations = await prepare();
    expect(operations.filter(operation => operation.entity.kind === "reading")).toHaveLength(2);
    expect(operations.find(operation => operation.entity.kind === "resume")!.value).toEqual({ chapter: null, anchor: null, openedAt: null });
    expect(operations.find(operation => operation.entity.kind === "library")!.value).toEqual({ inLibrary: false, addedAt: null });
  });

  it("never seeds a new private progress value, including a chapter with older public history", async () => {
    active.sql.exec("UPDATE chapter SET progress=15,read_at=20");
    await updateChapterProgress(11, 90, { recordHistory: false });
    await bind();
    const operations = await prepare();
    expect(operations.some(operation => operation.entity.kind === "reading")).toBe(false);
    expect(operations.some(operation => operation.entity.kind === "resume")).toBe(false);
    expect(active.sql.prepare("SELECT progress FROM chapter").get()).toEqual({ progress: 90 });
  });

  it("keeps private seed exclusion when metadata fills a previously unknown source ID", async () => {
    active.sql.exec("UPDATE novel SET source_novel_id=NULL");
    await updateChapterProgress(11, 80, { recordHistory: false });
    active.sql.exec("UPDATE novel SET source_novel_id='book'");
    await bind();
    expect(await prepare()).toEqual([]);
  });

  it("does not leak private progress when clearing only public history later", async () => {
    active.sql.exec("UPDATE chapter SET progress=15,read_at=20");
    await updateChapterProgress(11, 90, { recordHistory: false });
    await clearNovelHistory(1); await bind();
    const operation = (await prepare()).find(item => item.entity.kind === "reading")!;
    expect(operation.value).toEqual({ progress: 15, unread: true, readAt: null });
  });

  it("records portable resume anchors without local integer IDs or reader settings", async () => {
    await bind();
    await recordUserResume(11, { segmentIndex: 2, segmentCount: 8, offset: 0.4, progress: 30, savedAt: 1000 }, 22);
    const [operation] = await prepare();
    expect(operation.entity).toEqual({ kind: "resume", work });
    expect(operation.value).toEqual({ chapter: { chapterPath: "/chapter/1", name: "One" },
      anchor: { segmentIndex: 2, segmentCount: 8, offset: 0.4, progress: 30, savedAt: 1000 }, openedAt: 22 });
    expect(JSON.stringify(operation)).not.toMatch(/chapterId|novelId|fontSize|scrollTop|token/);
  });
});

describe("categories and source migration", () => {
  it("retains a stable category identity across rename, deletion and local integer-ID reuse", async () => {
    active.sql.exec("INSERT INTO category(id,name,sort,is_system) VALUES(7,'Old',0,0)");
    const stableId = await stableCategoryIdInDb(active.db, 7);
    await updateCategory(7, { name: "New" }); await deleteCategory(7);
    active.sql.exec("INSERT INTO category(id,name,sort,is_system) VALUES(7,'Unrelated',0,0)");
    const replacement = await stableCategoryIdInDb(active.db, 7, true);
    expect(replacement).not.toBe(stableId);
    const original = active.sql.prepare("SELECT value_json FROM user_state_intent WHERE entity_key=?").get(userStateEntityKey({ kind: "category", categoryId: stableId! })) as { value_json: string };
    expect(JSON.parse(original.value_json)).toEqual({ name: "New", sort: 0, deleted: true });
    await bind();
    await materializeUserStateRecordInDb(active.db, canonicalUserStateJson([binding.serverUrl, binding.workspaceId, binding.epoch]),
      shared({ kind: "category", categoryId: stableId! }, { name: "New", sort: 0, deleted: true }, 1));
    expect(active.sql.prepare("SELECT name FROM category WHERE id=7").get()).toEqual({ name: "Unrelated" });
  });

  it("remembers create aliases and retries already attempted membership payloads unchanged", async () => {
    await bind(); await insertCategory({ name: "Favorites" });
    await setNovelInLibrary(1, true);
    const category = active.sql.prepare("SELECT id FROM category").get() as { id: number };
    await setNovelCategories(1, [category.id]);
    const operations = await prepare();
    const create = operations.find(operation => operation.entity.kind === "category")!;
    const membership = operations.find(operation => operation.entity.kind === "membership")!;
    if (create.entity.kind !== "category") throw new Error("Expected category");
    const createdCategoryId = create.entity.categoryId;
    await tx(active, db => acknowledgeUserStateOperationsInDb(db, binding, [{
      operationId: create.operationId, status: "aliased", current: shared({ kind: "category", categoryId: "canonical" }, create.value, 1),
      categoryAlias: { from: createdCategoryId, to: "canonical" },
    }]));
    expect((await prepare()).find(operation => operation.operationId === membership.operationId)).toEqual(membership);
    const mapping = active.sql.prepare("SELECT local_id FROM user_state_category WHERE category_id='canonical'").get();
    expect(mapping).toEqual({ local_id: category.id });
  });

  it("deleting a category records the membership removals before its cascading local deletion", async () => {
    await bind(); await insertCategory({ name: "Favorites" }); await setNovelInLibrary(1, true);
    const category = active.sql.prepare("SELECT id FROM category").get() as { id: number };
    await setNovelCategories(1, [category.id]); await deleteCategory(category.id);
    const operations = await prepare();
    expect(operations.find(operation => operation.entity.kind === "category")!.value).toMatchObject({ deleted: true });
    expect(operations.find(operation => operation.entity.kind === "membership")!.value).toEqual({ included: false });
    expect(active.sql.prepare("SELECT COUNT(*) AS count FROM novel_category").get()).toEqual({ count: 0 });
  });

  it("replays an explicit pending reset after an A-to-B MAX/OR preservation merge", async () => {
    const targetWork = { ...work, pluginId: "target", sourceNovelId: "other-book", novelPath: "/target" };
    addWork(active, 2, 21, targetWork);
    active.sql.exec("UPDATE chapter SET progress=100,bookmark=1,unread=0,read_at=10");
    await bind();
    await setChaptersReadState([11], true); await setChapterBookmark(11, false);
    const frozen = await prepare();
    await tx(active, db => remapPendingUserStateInDb(db, 1, 2, { 11: 21 }));
    expect(active.sql.prepare("SELECT progress,unread,bookmark FROM chapter WHERE id=21").get()).toEqual({ progress: 0, unread: 1, bookmark: 0 });
    expect(active.sql.prepare("SELECT payload FROM user_state_operation WHERE operation_id=?").get(frozen[0].operationId)).toEqual({ payload: canonicalUserStateJson(frozen[0]) });
    const targetIntent = active.sql.prepare("SELECT entity_json,value_json FROM user_state_intent WHERE json_extract(entity_json,'$.work.pluginId')='target' AND json_extract(entity_json,'$.kind')='reading'").get() as { value_json: string };
    expect(JSON.parse(targetIntent.value_json)).toMatchObject({ progress: 0, unread: true });
  });

  it("retains a newer target reset when an older source progress change is remapped", async () => {
    addWork(active, 2, 21, { ...work, pluginId: "target", sourceNovelId: "other", novelPath: "/target" });
    await bind(); await updateChapterProgress(11, 70); await setChaptersReadState([21], true);
    active.sql.exec("UPDATE chapter SET progress=70,unread=0 WHERE id=21");
    await tx(active, db => remapPendingUserStateInDb(db, 1, 2, { 11: 21 }));
    expect(active.sql.prepare("SELECT progress,unread FROM chapter WHERE id=21").get()).toEqual({ progress: 0, unread: 1 });
  });

  it("preserves source snapshots and discovered chapters when shared composition choices are reapplied", async () => {
    const composition: ChapterCompositionV1 = { version: 1, updatedAt: 1, entries: [{
      id: "entry-1", path: "/chapter/1", storageChapterNumber: "1", primarySource: 0,
      user: { included: true, order: 1, name: "My title", chapterNumber: null },
      sources: [{ pluginId: "source", novelId: "book", novelPath: "/book", chapterPath: "/chapter/1", chapterNumber: "1", name: "One", position: 1, page: "1", contentType: "text", releaseTime: null }],
    }] };
    await bind();
    await materializeUserStateRecordInDb(active.db, "", shared({ kind: "composition", work }, { composition }, 1));
    const current = structuredClone(composition); current.updatedAt = 2; current.entries[0].sources[0].name = "Updated source";
    current.entries.push({ ...structuredClone(current.entries[0]), id: "entry-2", path: "/chapter/2", storageChapterNumber: "2",
      user: { included: true, order: 2, name: null, chapterNumber: "2" },
      sources: [{ ...current.entries[0].sources[0], chapterPath: "/chapter/2", chapterNumber: "2", position: 2, name: "Two" }] });
    active.sql.prepare("UPDATE novel_chapter_composition SET payload=? WHERE novel_id=1").run(JSON.stringify(current));
    await materializeUserStateRecordInDb(active.db, "", shared({ kind: "composition", work }, { composition }, 3));
    const stored = JSON.parse((active.sql.prepare("SELECT payload FROM novel_chapter_composition").get() as { payload: string }).payload) as ChapterCompositionV1;
    expect(stored.entries).toHaveLength(2); expect(stored.entries[0].user.name).toBe("My title"); expect(stored.entries[0].sources[0].name).toBe("Updated source");
  });
});


describe("archive recovery and exact command integration", () => {
  it("pauses old operations after restore, retains edits, and resumes without seeding the restored snapshot", async () => {
    await bind(); await capture(readingValue(60)); const [attempted] = await prepare();
    active.sql.exec("UPDATE user_state_restore_state SET paused=1,restored=1; UPDATE chapter SET progress=5; UPDATE novel SET in_library=1");
    await setChapterBookmark(11, true);
    await expect(prepare()).rejects.toThrow(/paused after restoring/);
    await expect(materializePendingUserState(binding)).rejects.toThrow(/paused after restoring/);
    await expect(tx(active, db => applyUserStateReadPageInDb(db, binding, { version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch,
      headRevision: 1, through: 1, nextCursor: 1, hasMore: false, records: [shared(reading, readingValue(90), 1)] }))).rejects.toThrow(/paused after restoring/);
    await resumeUserStateAfterRestore();
    expect((await prepare()).find(operation => operation.operationId === attempted.operationId)).toEqual(attempted);
    const other = { ...binding, serverUrl: "https://after-restore.example" };
    await tx(active, db => bindUserStateWorkspaceInDb(db, other));
    const operations = await tx(active, db => prepareUserStateOperationsInDb(db, other));
    expect(operations.some(operation => operation.entity.kind === "library")).toBe(false);
    expect(operations.find(operation => operation.entity.kind === "reading")!.value).toEqual(readingValue(60));
    expect(active.sql.prepare("SELECT paused,restored FROM user_state_restore_state").get()).toEqual({ paused: 0, restored: 1 });
  });

  it("clears update flags without exposing a private position or losing its marker", async () => {
    active.sql.exec("UPDATE novel SET in_library=1,library_added_at=0; UPDATE chapter SET progress=15,read_at=20");
    await updateChapterProgress(11, 90, { recordHistory: false });
    await clearUpdatesTab(); await bind();
    expect((await prepare()).find(operation => operation.entity.kind === "reading")!.value).toEqual({ progress: 15, unread: false, readAt: 20 });
    expect(active.sql.prepare("SELECT COUNT(*) AS count FROM user_state_private").get()).toEqual({ count: 1 });
    expect(active.sql.prepare("SELECT progress,unread FROM chapter").get()).toEqual({ progress: 90, unread: 0 });
  });

  it("does not publish a personal deletion when the device-only content cleanup removes its cached work row", async () => {
    await bind();
    await deleteLocalNovelRecords({ id: 1, pluginId: work.pluginId, sourceNovelId: work.sourceNovelId, path: work.novelPath });
    expect(active.sql.prepare("SELECT COUNT(*) AS count FROM novel").get()).toEqual({ count: 0 });
    expect(await prepare()).toEqual([]);
  });

  it("preserves an unread reset through the actual source-merge transaction and records the intentional library migration", async () => {
    addWork(active, 2, 21, { ...work, pluginId: "target", sourceNovelId: "other-book", novelPath: "/target" });
    active.sql.exec("UPDATE chapter SET progress=100,unread=0,bookmark=1");
    await bind(); await setChaptersReadState([11], true); await setChapterBookmark(11, false);
    await applyNovelMergeInDb({ sourceNovelId: 1, targetNovelId: 2,
      decisions: [{ kind: "map", sourceChapterId: 11, targetChapterPath: "/chapter/1" }], preparedDownloads: [] });
    expect(active.sql.prepare("SELECT id,progress,unread,bookmark FROM chapter").get()).toEqual({ id: 21, progress: 0, unread: 1, bookmark: 0 });
    const operations = await prepare();
    expect(operations.find(operation => operation.entity.kind === "library" && operation.entity.work.pluginId === "source")!.value).toEqual({ inLibrary: false, addedAt: null });
    expect(operations.find(operation => operation.entity.kind === "reading" && operation.entity.work.pluginId === "target")!.value).toMatchObject({ progress: 0, unread: true });
  });

  it("does not echo an incoming migration as new manual library or reading commands", async () => {
    addWork(active, 2, 21, { ...work, pluginId: "target", sourceNovelId: "other-book", novelPath: "/target" });
    await bind();
    await applyNovelMergeInDb({ sourceNovelId: 1, targetNovelId: 2,
      decisions: [{ kind: "map", sourceChapterId: 11, targetChapterPath: "/chapter/1" }], preparedDownloads: [], recordIncomingMigration: async () => undefined });
    expect(await prepare()).toEqual([]);
  });
});


describe("category alias ownership", () => {
  it("does not rebase a queued rename onto an alias with an unseen category order", async () => {
    await bind(); await insertCategory({ name: "Favorites", sort: 10 });
    const category = active.sql.prepare("SELECT id FROM category").get() as { id: number };
    const [create] = await prepare();
    if (create.entity.kind !== "category") throw new Error("Expected category");
    const aliasId = create.entity.categoryId;
    await updateCategory(category.id, { name: "Renamed while offline" });
    await tx(active, db => acknowledgeUserStateOperationsInDb(db, binding, [{ operationId: create.operationId, status: "aliased",
      current: shared({ kind: "category", categoryId: "canonical-category" }, { name: "Favorites", sort: 1, deleted: false }, 4),
      categoryAlias: { from: aliasId, to: "canonical-category" } }]));
    const [rename] = await prepare();
    expect(rename.entity).toEqual({ kind: "category", categoryId: "canonical-category" });
    expect(rename.baseRevision).toBe(0);
    expect(rename.value).toEqual({ name: "Renamed while offline", sort: 10, deleted: false });
  });

  it("reconnects restored canonical category maps only through the same workspace's durable alias", async () => {
    await bind(); await insertCategory({ name: "Favorites", sort: 10 });
    const [create] = await prepare();
    if (create.entity.kind !== "category") throw new Error("Expected category");
    const aliasId = create.entity.categoryId;
    const current = shared({ kind: "category", categoryId: "canonical-category" }, { name: "Favorites", sort: 1, deleted: false }, 4);
    await tx(active, db => acknowledgeUserStateOperationsInDb(db, binding, [{ operationId: create.operationId, status: "aliased", current,
      categoryAlias: { from: aliasId, to: "canonical-category" } }]));
    active.sql.exec("DELETE FROM category; INSERT INTO category(id,name,sort,is_system) VALUES(70,'Favorites',99,0)");
    active.sql.prepare("UPDATE user_state_category SET local_id=70 WHERE category_id=?").run(aliasId);
    const namespace = canonicalUserStateJson([binding.serverUrl, binding.workspaceId, binding.epoch]);
    await tx(active, db => materializeUserStateRecordInDb(db, namespace, current));
    await tx(active, db => materializeUserStateRecordInDb(db, namespace,
      shared({ kind: "membership", work, categoryId: "canonical-category" }, { included: true }, 5)));
    expect(active.sql.prepare("SELECT id,name,sort FROM category").all()).toEqual([{ id: 70, name: "Favorites", sort: 1 }]);
    expect(active.sql.prepare("SELECT local_id FROM user_state_category WHERE category_id='canonical-category'").get()).toEqual({ local_id: 70 });
    expect(active.sql.prepare("SELECT novel_id,category_id FROM novel_category").get()).toEqual({ novel_id: 1, category_id: 70 });
  });

  it("applies the shared category order when an exact-name legacy baseline is linked", async () => {
    active.sql.exec("INSERT INTO category(id,name,sort,is_system) VALUES(7,'Favorites',99,0)");
    await bind();
    await tx(active, db => materializeUserStateRecordInDb(db, canonicalUserStateJson([binding.serverUrl, binding.workspaceId, binding.epoch]),
      shared({ kind: "category", categoryId: "canonical-category" }, { name: "Favorites", sort: 1, deleted: false }, 1)));
    expect(active.sql.prepare("SELECT id,sort FROM category").get()).toEqual({ id: 7, sort: 1 });
  });
});


describe("source changes after settled personal state", () => {
  it("remaps a new unattempted path edit despite an older acknowledged receipt without changing that receipt", async () => {
    await bind(); await updateChapterProgress(11, 30); const [old] = await prepare(); await ack(old, 1);
    await updateChapterProgress(11, 45);
    await upsertSourceChapters([{ novelId: 1, path: "/chapter/new", name: "One", chapterNumber: "1", position: 1 }]);
    const [current] = await prepare();
    expect(current.entity).toMatchObject({ kind: "reading", chapter: { chapterPath: "/chapter/new" } });
    expect(current.value).toMatchObject({ progress: 45 }); expect(current.baseRevision).toBe(0);
    expect(active.sql.prepare("SELECT payload FROM user_state_operation WHERE operation_id=?").get(old.operationId)).toEqual({ payload: canonicalUserStateJson(old) });
  });

  it("projects shared composition without publishing work metadata files", async () => {
    await bind();
    active.sql.exec("DELETE FROM work_metadata_dirty");
    const composition: ChapterCompositionV1 = { version: 1, updatedAt: 2, entries: [{
      id: "entry-1", path: "/chapter/1", storageChapterNumber: "1", primarySource: 0,
      user: { included: true, order: 1, name: null, chapterNumber: "1" },
      sources: [{ pluginId: "source", novelId: "book", novelPath: "/book", chapterPath: "/chapter/1",
        chapterNumber: "1", name: "One", position: 1, page: "1", contentType: "text", releaseTime: null }],
    }] };
    await applyUserStateReadPage(binding, { version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch,
      headRevision: 1, through: 1, nextCursor: 1, hasMore: false,
      records: [shared({ kind: "composition", work }, { composition }, 1)] });
    await waitForUserStateDeferredApply();
    expect(active.sql.prepare("SELECT * FROM work_metadata_dirty").all()).toEqual([]);
    expect(active.sql.prepare("SELECT applied_revision FROM user_state_record").get()).toEqual({ applied_revision: 1 });
  });

  it("reapplies the latest explicit reset when shared composition reincludes a chapter with older positive provenance", async () => {
    const composition: ChapterCompositionV1 = { version: 1, updatedAt: 1, entries: [{
      id: "entry-1", path: "/chapter/1", storageChapterNumber: "1", primarySource: 0,
      user: { included: true, order: 1, name: null, chapterNumber: "1" },
      sources: ["/chapter/1", "/old-path"].map(chapterPath => ({ pluginId: "source", novelId: "book", novelPath: "/book", chapterPath,
        chapterNumber: "1", name: "One", position: 1, page: "1", contentType: "text", releaseTime: null })),
    }] };
    await setChapterComposition(active.db, 1, composition);
    active.sql.exec("INSERT INTO work_metadata_reading_state(plugin_id,novel_path,chapter_path,progress,bookmark,unread,read_at) VALUES('source','/book','/old-path',100,1,0,90)");
    await bind();
    const readPage = async (record: UserStateRecord) => {
      await applyUserStateReadPage(binding, { version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch,
        headRevision: record.revision, through: record.revision, nextCursor: record.revision, hasMore: false, records: [record] });
      await waitForUserStateDeferredApply();
    };
    await readPage(shared(reading, readingValue(0, true), 1));
    const excluded = structuredClone(composition); excluded.updatedAt = 2; excluded.entries[0].user = { included: false, order: 0, name: null, chapterNumber: null };
    await readPage(shared({ kind: "composition", work }, { composition: excluded }, 2));
    const restored = structuredClone(composition); restored.updatedAt = 3;
    await readPage(shared({ kind: "composition", work }, { composition: restored }, 3));
    expect(active.sql.prepare("SELECT progress,unread,read_at FROM chapter").get()).toEqual({ progress: 0, unread: 1, read_at: null });
  });
});


it("does not use an old baseline name match to silently alias an explicit rename", async () => {
  active.sql.exec("INSERT INTO category(id,name,sort,is_system) VALUES(7,'Original',1,0)");
  await bind(); const [seed] = await prepare(); await ack(seed, 1);
  await updateCategory(7, { name: "Occupied" });
  await expect(tx(active, db => materializeUserStateRecordInDb(db, canonicalUserStateJson([binding.serverUrl, binding.workspaceId, binding.epoch]),
    shared({ kind: "category", categoryId: "other-category" }, { name: "Occupied", sort: 2, deleted: false }, 2)))).rejects.toMatchObject({ reason: "category-name-conflict" });
  expect(active.sql.prepare("SELECT category_id FROM user_state_category WHERE category_id='other-category'").get()).toBeUndefined();
});


it("remaps B's own pending reset when an approved merge replaces its path with a composed entry", async () => {
  const targetWork = { ...work, pluginId: "target", sourceNovelId: "other-book", novelPath: "/target" };
  addWork(active, 2, 21, targetWork);
  active.sql.exec("UPDATE chapter SET progress=100,unread=0");
  await bind(); await setChaptersReadState([21], true);
  const source = (reference: UserStateWorkReference) => ({ pluginId: reference.pluginId, novelId: reference.sourceNovelId!, novelPath: reference.novelPath,
    chapterPath: "/chapter/1", chapterNumber: "1", name: "One", position: 1, page: "1", contentType: "text" as const, releaseTime: null });
  const composition: ChapterCompositionV1 = { version: 1, updatedAt: 1, entries: [
    { id: "old-target", path: "/chapter/1", storageChapterNumber: "1", sources: [source(targetWork)], primarySource: 0,
      user: { included: false, order: 0, name: null, chapterNumber: null } },
    { id: "new-target", path: "norea-composed:new-target", storageChapterNumber: "2", sources: [source(work), source(targetWork)], primarySource: 0,
      user: { included: true, order: 1, name: null, chapterNumber: "1" } },
  ] };
  await applyNovelMergeInDb({ sourceNovelId: 1, targetNovelId: 2, composition,
    decisions: [{ kind: "map", sourceChapterId: 11, targetChapterPath: "norea-composed:new-target" }], preparedDownloads: [],
    readingStateSourcePathByTargetPath: { "norea-composed:new-target": "/chapter/1" } });
  expect(active.sql.prepare("SELECT path,progress,unread FROM chapter").get()).toEqual({ path: "norea-composed:new-target", progress: 0, unread: 1 });
  const operation = (await prepare()).find(item => item.entity.kind === "reading" && item.entity.work.pluginId === "target")!;
  expect(operation.entity).toMatchObject({ chapter: { chapterPath: "norea-composed:new-target", compositionEntryId: "new-target" } });
  expect(operation.value).toMatchObject({ progress: 0, unread: true });
});
