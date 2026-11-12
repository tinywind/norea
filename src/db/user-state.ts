import { getDb, runDatabaseTransaction, runExclusiveDatabaseOperation } from "./client";
import {
  assertUserStateAvailableInDb, chapterReference, chapterWork, emitUserStateApplied, hasUserStateSchema,
  recordUserStateChangesInDb, recordResumeClearedInDb, requestUserStateDeferredApply, requireBinding, workspaceRows,
  USER_CHAPTER_SELECT, userStateRestorePausedInDb, type UserChapterRow, type UserStateDb,
} from "./user-state-core";
import {
  acknowledgeUserStateOperationsInDb, applyUserStateReadPageInDb, bindUserStateWorkspaceInDb,
  getUserStateLedgerStatusInDb, listUserStateConflictsInDb, listUserStateDeferredInDb,
  prepareUserStateOperationsInDb, resolveUserStateLedgerConflictInDb, type UserStateLedgerStatus,
} from "./user-state-ledger";
import { DeferredUserState, materializeUserStateRecordInDb, hasPendingUserStateForRecordInDb, refreshUnattemptedUserStateIdentitiesInDb } from "./user-state-materialize";
import {
  parsePortableReaderAnchor, parseUserStateRecord, userStateEntityKey,
  type PortableReaderAnchor, type UserStateApplyEffects, type UserStateBinding, type UserStateConflict,
  type UserStateDeferred, type UserStateMergeResult, type UserStateOperation, type UserStateReadResponse, type UserStateRecord,
} from "../lib/user-state/types";

export { subscribeUserStateApplied, subscribeUserStateChanges, subscribeUserStateLedgerChanges } from "./user-state-core";
export type { UserStateLedgerStatus } from "./user-state-ledger";
export type { UserStateChangePriority } from "./user-state-core";
import { emitUserStateLedgerChanged } from "./user-state-core";
let activeServer: string | null = null;
let activeGeneration = 0;
const USER_STATE_BUSY_RETRIES = 3;
const USER_STATE_LEDGER_TX_OPTIONS = {
  publishMetadata: false,
  notifyContentSync: false,
  busyBeginRetries: USER_STATE_BUSY_RETRIES,
} as const;

function isUserStateDatabaseBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:code:\s*(?:5|6)\b|database is (?:locked|busy)|SQLITE_(?:BUSY|LOCKED))/i.test(message);
}

async function retryUserStateExclusive<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await run(); }
    catch (error) {
      if (!isUserStateDatabaseBusy(error) || attempt >= USER_STATE_BUSY_RETRIES) throw error;
      await new Promise<void>(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}
export function setUserStateActiveServer(serverUrl: string | null): void {
  if (activeServer !== serverUrl) { activeServer = serverUrl; activeGeneration++; }
}
export async function getUserStateBinding(serverUrl?: string): Promise<UserStateBinding | null> {
  const db = await getDb();
  if (!await hasUserStateSchema(db)) return null;
  const rows = await workspaceRows(db);
  const row = rows.find(candidate => candidate.serverUrl === (serverUrl ?? activeServer));
  return row ? { serverUrl: row.serverUrl, workspaceId: row.workspaceId, epoch: row.epoch } : null;
}
export async function bindUserStateWorkspace(binding: UserStateBinding): Promise<void> {
  await runDatabaseTransaction(db => bindUserStateWorkspaceInDb(db, binding), false, USER_STATE_LEDGER_TX_OPTIONS);
  emitUserStateLedgerChanged();
}
export async function prepareUserStateOperations(binding: UserStateBinding, limits?: { limit?: number; maxBytes?: number; allowOpaqueIdentity?: boolean }): Promise<UserStateOperation[]> {
  const result = await runDatabaseTransaction(async db => {
    await refreshUnattemptedUserStateIdentitiesInDb(db);
    return prepareUserStateOperationsInDb(db, binding, limits);
  }, false, USER_STATE_LEDGER_TX_OPTIONS);
  emitUserStateLedgerChanged();
  return result;
}
export async function getUserStateLedgerStatus(binding?: UserStateBinding | null): Promise<UserStateLedgerStatus> {
  const db = await getDb();
  const current = binding === undefined ? await getUserStateBinding() : binding;
  if (current) return getUserStateLedgerStatusInDb(db, current);
  if (!await hasUserStateSchema(db)) return { cursor: 0, through: null, pending: 0, conflicts: 0, deferred: 0,
    projectionPending: 0, projectionParked: 0, projectionFailed: 0,
    lastSuccessAt: null, pausedAfterRestore: await userStateRestorePausedInDb(db) };
  const [row] = await db.select<{ pending: number }[]>("SELECT COUNT(*) AS pending FROM user_state_intent");
  return { cursor: 0, through: null, pending: row?.pending ?? 0, conflicts: 0, deferred: 0,
    projectionPending: 0, projectionParked: 0, projectionFailed: 0,
    lastSuccessAt: null, pausedAfterRestore: await userStateRestorePausedInDb(db) };
}
export async function listUserStateConflicts(binding: UserStateBinding): Promise<UserStateConflict[]> {
  return listUserStateConflictsInDb(await getDb(), binding);
}
export async function listUserStateDeferred(binding: UserStateBinding): Promise<UserStateDeferred[]> {
  return listUserStateDeferredInDb(await getDb(), binding);
}

const USER_STATE_LOCAL_ACK_CHUNK = 128;
const USER_STATE_LOCAL_ACK_YIELD_MS = 0;

async function yieldUserStateAck(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, USER_STATE_LOCAL_ACK_YIELD_MS));
}

const USER_STATE_PROJECTION_CHUNK = 16;

function projectionPriority(record: UserStateRecord): number {
  switch (record.entity.kind) {
    case "category": return 0;
    case "library": return 1;
    case "composition": return 2;
    default: return 3;
  }
}

async function projectUserStateRecordsInDb(
  db: UserStateDb, binding: UserStateBinding, raws: readonly UserStateRecord[],
): Promise<UserStateApplyEffects> {
  const { namespace } = await requireBinding(db, binding);
  await assertUserStateAvailableInDb(db);
  const effects: UserStateApplyEffects = { resumes: [] };
  const records = raws.map(parseUserStateRecord).sort((a, b) => projectionPriority(a) - projectionPriority(b) || a.revision - b.revision);
  if (!records.length) return effects;

  const dirtyBefore = await db.select<{ pluginId: string; path: string }[]>(
    "SELECT plugin_id AS pluginId,path FROM work_metadata_dirty ORDER BY plugin_id,path",
  );
  const identities = records.map(record => ({ entityKey: userStateEntityKey(record.entity), revision: record.revision }));
  const stored = await db.select<{ entityKey: string; revision: number; appliedRevision: number }[]>(`
    SELECT r.entity_key AS entityKey,r.revision,r.applied_revision AS appliedRevision
    FROM json_each($2) incoming CROSS JOIN user_state_record r
      ON r.entity_key=json_extract(incoming.value,'$.entityKey')
    WHERE r.namespace=$1`, [namespace, JSON.stringify(identities)]);
  const state = new Map(stored.map(row => [row.entityKey, row]));

  for (const record of records) {
    const key = userStateEntityKey(record.entity);
    const current = state.get(key);
    if (!current || current.revision !== record.revision || current.appliedRevision >= record.revision) continue;
    if (await hasPendingUserStateForRecordInDb(db, namespace, record)) continue;
    try {
      const next = await materializeUserStateRecordInDb(db, namespace, record);
      effects.resumes.push(...next.resumes);
      await db.execute("UPDATE user_state_record SET applied_revision=revision,deferred_reason=NULL,deferred_detail=NULL WHERE namespace=$1 AND entity_key=$2 AND revision=$3",
        [namespace, key, record.revision]);
    } catch (error) {
      // Missing content is parked until its metadata changes. Real projection
      // failures remain retryable and visible; neither loses the shared value.
      if (error instanceof DeferredUserState) {
        await db.execute("UPDATE user_state_record SET applied_revision=revision,deferred_reason=$4,deferred_detail=$5 WHERE namespace=$1 AND entity_key=$2 AND revision=$3",
          [namespace, key, record.revision, error.reason, error.message.slice(0, 500)]);
      } else {
        await db.execute("UPDATE user_state_record SET deferred_reason='projection-error',deferred_detail=$4 WHERE namespace=$1 AND entity_key=$2 AND revision=$3",
          [namespace, key, record.revision, String(error).slice(0, 500)]);
        console.warn("[user-state] stored shared state but could not project it into local content", error);
      }
    }
  }

  // Personal state is independent of content metadata files. Composition/library
  // projections may trip generic metadata-dirty triggers, but those files must not
  // be rewritten merely because shared user state arrived.
  await db.execute("DELETE FROM work_metadata_dirty");
  if (dirtyBefore.length) {
    await db.execute(`INSERT INTO work_metadata_dirty(plugin_id,path)
      SELECT json_extract(value,'$.pluginId'),json_extract(value,'$.path') FROM json_each($1) WHERE true
      ON CONFLICT(plugin_id,path) DO NOTHING`, [JSON.stringify(dirtyBefore)]);
  }
  return effects;
}

async function yieldUserStateProjection(): Promise<void> {
  // Projection is a convenience view over durable user-state records. Yield a
  // frame between small write transactions so library queries, cover reads and
  // other native bridge work stay responsive while a large history catches up.
  await new Promise<void>(resolve => setTimeout(resolve, 16));
}

async function projectUserStateRecords(binding: UserStateBinding, records: readonly UserStateRecord[]): Promise<UserStateApplyEffects> {
  if (!records.length) return { resumes: [] };
  const effects: UserStateApplyEffects = { resumes: [] };
  for (let start = 0; start < records.length; start += USER_STATE_PROJECTION_CHUNK) {
    await yieldUserStateProjection();
    const next = await runDatabaseTransaction(
      db => projectUserStateRecordsInDb(db, binding, records.slice(start, start + USER_STATE_PROJECTION_CHUNK)),
      true,
      { publishMetadata: false, notifyContentSync: false },
    );
    effects.resumes.push(...next.resumes);
  }
  emitUserStateApplied(effects);
  emitUserStateLedgerChanged();
  return effects;
}

export async function materializePendingUserState(binding: UserStateBinding): Promise<UserStateApplyEffects> {
  const generation = activeGeneration;
  const allowed = () => activeGeneration === generation && (activeServer === null || activeServer === binding.serverUrl);
  if (!allowed()) return { resumes: [] };
  const db = await getDb();
  const { namespace } = await requireBinding(db, binding);
  await assertUserStateAvailableInDb(db);
  const rows = await db.select<{ payload: string }[]>(`SELECT payload FROM user_state_record r
    WHERE namespace=$1 AND applied_revision<revision AND (deferred_reason IS NULL OR deferred_reason='projection-error') AND (
      json_extract(payload,'$.entity.kind') IN ('category','library')
      OR EXISTS (
        SELECT 1 FROM novel n
        WHERE n.plugin_id=json_extract(r.payload,'$.entity.work.pluginId')
          AND (CASE WHEN json_extract(r.payload,'$.entity.work.sourceNovelId') IS NULL
            THEN n.path=json_extract(r.payload,'$.entity.work.novelPath')
            ELSE lower(n.source_novel_id)=lower(json_extract(r.payload,'$.entity.work.sourceNovelId')) END)
      )
    )
    ORDER BY CASE json_extract(payload,'$.entity.kind') WHEN 'category' THEN 0 WHEN 'library' THEN 1 WHEN 'composition' THEN 2 ELSE 3 END,revision`, [namespace]);
  if (!allowed()) return { resumes: [] };
  return projectUserStateRecords(binding, rows.map(row => parseUserStateRecord(JSON.parse(row.payload))));
}
export async function applyUserStateReadPage(binding: UserStateBinding, page: UserStateReadResponse): Promise<UserStateApplyEffects> {
  await runDatabaseTransaction(async db => {
    await applyUserStateReadPageInDb(db, binding, page);
    requestUserStateDeferredApply(db);
  }, false, USER_STATE_LEDGER_TX_OPTIONS);
  emitUserStateLedgerChanged();
  return { resumes: [] };
}
export async function acknowledgeUserStateOperations(binding: UserStateBinding, results: UserStateMergeResult[]): Promise<UserStateApplyEffects> {
  // Network merge requests remain byte-bounded bulk messages. Only local receipt
  // application is chunked so a large replay cannot monopolize Android's SQLite
  // bridge for tens of seconds and starve library/cover reads.
  //
  // Server receipts are immutable and all ACK writes are idempotent/monotonic, so
  // a crash between chunks is safe: the next synchronization replays the exact
  // receipts and resumes at the remaining local progress rows.
  for (let start = 0; start < results.length; start += USER_STATE_LOCAL_ACK_CHUNK) {
    if (start > 0) await yieldUserStateAck();
    const batch = results.slice(start, start + USER_STATE_LOCAL_ACK_CHUNK);
    await retryUserStateExclusive(() => runExclusiveDatabaseOperation(async db => {
      await acknowledgeUserStateOperationsInDb(db, binding, batch);
      requestUserStateDeferredApply(db);
    }, { publishMetadata: false }));
  }
  emitUserStateLedgerChanged();
  return { resumes: [] };
}
export async function resolveUserStateLedgerConflict(binding: UserStateBinding, input: { id: string; version: string; choice: "local" | "shared"; categoryName?: string }): Promise<UserStateApplyEffects> {
  await runDatabaseTransaction(async db => {
    await resolveUserStateLedgerConflictInDb(db, binding, input);
    requestUserStateDeferredApply(db);
  }, false, USER_STATE_LEDGER_TX_OPTIONS);
  emitUserStateLedgerChanged();
  return { resumes: [] };
}

export async function recordUserResume(chapterId: number, anchor: PortableReaderAnchor | null, openedAt: number): Promise<void> {
  if (!Number.isSafeInteger(openedAt) || openedAt < 0) throw new Error("Reader opened time must be in whole seconds.");
  const portable = anchor === null ? null : parsePortableReaderAnchor(anchor);
  await runDatabaseTransaction(async db => {
    if (!await hasUserStateSchema(db)) return;
    const [row] = await db.select<UserChapterRow[]>(USER_CHAPTER_SELECT + " WHERE c.id=$1", [chapterId]);
    if (!row) return;
    await recordUserStateChangesInDb(db, [{ entity: { kind: "resume", work: chapterWork(row) },
      value: { chapter: chapterReference(row), anchor: portable, openedAt } }]);
  }, false, USER_STATE_LEDGER_TX_OPTIONS);
}
export async function recordUserResumeCleared(novelId: number): Promise<void> {
  await runDatabaseTransaction(db => recordResumeClearedInDb(db, [novelId]), false, USER_STATE_LEDGER_TX_OPTIONS);
}

/** Metadata/import callers use this inside their existing transaction. */
export async function deferUserStateForNovelInDb(db: UserStateDb, novelId: number): Promise<void> {
  if (!await hasUserStateSchema(db)) return;
  const current = await import("./user-state-current");
  if (current.isUserStateCurrentMode()) {
    current.deferUserStateCurrentForNovelInDb(db, novelId);
    return;
  }
  await refreshUnattemptedUserStateIdentitiesInDb(db, novelId);
  const [work] = await db.select<{ pluginId: string; sourceNovelId: string | null; novelPath: string }[]>(
    "SELECT plugin_id AS pluginId,source_novel_id AS sourceNovelId,path AS novelPath FROM novel WHERE id=$1", [novelId]);
  if (work) await db.execute(`UPDATE user_state_record SET applied_revision=0,deferred_reason=NULL,deferred_detail=NULL WHERE
    json_extract(payload,'$.entity.work.pluginId')=$1 AND
    (json_extract(payload,'$.entity.work.novelPath')=$3 OR
      ($2 IS NOT NULL AND lower(json_extract(payload,'$.entity.work.sourceNovelId'))=lower($2)))`,
    [work.pluginId, work.sourceNovelId, work.novelPath]);
  requestUserStateDeferredApply(db);
}
export async function applyDeferredUserState(): Promise<void> {
  const current = await import("./user-state-current");
  if (current.isUserStateCurrentMode()) {
    if (!await getUserStateRestorePaused()) await current.applyDeferredUserStateCurrent();
    return;
  }
  const server = activeServer;
  const generation = activeGeneration;
  if (server === null) return;
  const binding = await getUserStateBinding(server);
  if (!binding || generation !== activeGeneration || server !== activeServer) return;
  const paused = await getUserStateRestorePaused();
  if (!paused && generation === activeGeneration && server === activeServer) await materializePendingUserState(binding);
}

export async function getUserStateRestorePaused(): Promise<boolean> { return userStateRestorePausedInDb(await getDb()); }
export async function assertUserStateAvailable(): Promise<void> { await assertUserStateAvailableInDb(await getDb()); }
export async function resumeUserStateAfterRestore(): Promise<void> {
  await runDatabaseTransaction(async db => {
    await db.execute("UPDATE user_state_restore_state SET paused=0 WHERE id=1");
    await db.execute("UPDATE user_state_record SET applied_revision=0,deferred_reason=NULL,deferred_detail=NULL");
  }, false, USER_STATE_LEDGER_TX_OPTIONS);
  emitUserStateLedgerChanged();
}
