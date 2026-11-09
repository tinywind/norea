import { getDb, runDatabaseTransaction } from "./client";
import {
  assertUserStateAvailableInDb, chapterReference, chapterWork, emitUserStateApplied, hasUserStateSchema,
  recordUserStateChangesInDb, recordResumeClearedInDb, requireBinding, workspaceRows,
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
  await runDatabaseTransaction(db => bindUserStateWorkspaceInDb(db, binding));
  emitUserStateLedgerChanged();
}
export async function prepareUserStateOperations(binding: UserStateBinding, limits?: { limit?: number; maxBytes?: number }): Promise<UserStateOperation[]> {
  const result = await runDatabaseTransaction(async db => {
    await refreshUnattemptedUserStateIdentitiesInDb(db);
    return prepareUserStateOperationsInDb(db, binding, limits);
  });
  emitUserStateLedgerChanged();
  return result;
}
export async function getUserStateLedgerStatus(binding?: UserStateBinding | null): Promise<UserStateLedgerStatus> {
  const db = await getDb();
  const current = binding === undefined ? await getUserStateBinding() : binding;
  if (current) return getUserStateLedgerStatusInDb(db, current);
  if (!await hasUserStateSchema(db)) return { cursor: 0, through: null, pending: 0, conflicts: 0, deferred: 0, lastSuccessAt: null, pausedAfterRestore: await userStateRestorePausedInDb(db) };
  const [row] = await db.select<{ pending: number }[]>("SELECT COUNT(*) AS pending FROM user_state_intent");
  return { cursor: 0, through: null, pending: row?.pending ?? 0, conflicts: 0, deferred: 0, lastSuccessAt: null, pausedAfterRestore: await userStateRestorePausedInDb(db) };
}
export async function listUserStateConflicts(binding: UserStateBinding): Promise<UserStateConflict[]> {
  return listUserStateConflictsInDb(await getDb(), binding);
}
export async function listUserStateDeferred(binding: UserStateBinding): Promise<UserStateDeferred[]> {
  return listUserStateDeferredInDb(await getDb(), binding);
}

const USER_STATE_PROJECTION_CHUNK = 64;

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
    FROM user_state_record r JOIN json_each($2) incoming
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
      // Projection is optional. The durable user_state_record remains the source of
      // truth even when matching local content is absent or temporarily inconsistent.
      // A later metadata mutation may make this exact record projectable.
      await db.execute("UPDATE user_state_record SET deferred_reason=NULL,deferred_detail=NULL WHERE namespace=$1 AND entity_key=$2 AND revision=$3",
        [namespace, key, record.revision]);
      if (!(error instanceof DeferredUserState)) {
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
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

async function projectUserStateRecords(binding: UserStateBinding, records: readonly UserStateRecord[]): Promise<UserStateApplyEffects> {
  if (!records.length) return { resumes: [] };
  const effects: UserStateApplyEffects = { resumes: [] };
  for (let start = 0; start < records.length; start += USER_STATE_PROJECTION_CHUNK) {
    const next = await runDatabaseTransaction(
      db => projectUserStateRecordsInDb(db, binding, records.slice(start, start + USER_STATE_PROJECTION_CHUNK)),
      true,
      { publishMetadata: false, notifyContentSync: false },
    );
    effects.resumes.push(...next.resumes);
    if (start + USER_STATE_PROJECTION_CHUNK < records.length) await yieldUserStateProjection();
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
    WHERE namespace=$1 AND applied_revision<revision AND (
      json_extract(payload,'$.entity.kind') IN ('category','library')
      OR EXISTS (
        SELECT 1 FROM novel n
        WHERE n.plugin_id=json_extract(r.payload,'$.entity.work.pluginId')
          AND lower(n.source_novel_id)=lower(json_extract(r.payload,'$.entity.work.sourceNovelId'))
      )
    )
    ORDER BY CASE json_extract(payload,'$.entity.kind') WHEN 'category' THEN 0 WHEN 'library' THEN 1 WHEN 'composition' THEN 2 ELSE 3 END,revision`, [namespace]);
  if (!allowed()) return { resumes: [] };
  return projectUserStateRecords(binding, rows.map(row => parseUserStateRecord(JSON.parse(row.payload))));
}
export async function applyUserStateReadPage(binding: UserStateBinding, page: UserStateReadResponse): Promise<UserStateApplyEffects> {
  await runDatabaseTransaction(db => applyUserStateReadPageInDb(db, binding, page));
  emitUserStateLedgerChanged();
  return projectUserStateRecords(binding, page.records);
}
export async function acknowledgeUserStateOperations(binding: UserStateBinding, results: UserStateMergeResult[]): Promise<UserStateApplyEffects> {
  await runDatabaseTransaction(db => acknowledgeUserStateOperationsInDb(db, binding, results));
  emitUserStateLedgerChanged();
  return projectUserStateRecords(binding, results.flatMap(result => result.current ? [result.current] : []));
}
export async function resolveUserStateLedgerConflict(binding: UserStateBinding, input: { id: string; version: string; choice: "local" | "shared"; categoryName?: string }): Promise<UserStateApplyEffects> {
  await runDatabaseTransaction(db => resolveUserStateLedgerConflictInDb(db, binding, input));
  emitUserStateLedgerChanged();
  return materializePendingUserState(binding);
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
  });
}
export async function recordUserResumeCleared(novelId: number): Promise<void> {
  await runDatabaseTransaction(db => recordResumeClearedInDb(db, [novelId]));
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
  const [work] = await db.select<{ pluginId: string; sourceNovelId: string | null }[]>("SELECT plugin_id AS pluginId,source_novel_id AS sourceNovelId FROM novel WHERE id=$1", [novelId]);
  if (work?.sourceNovelId) await db.execute(`UPDATE user_state_record SET applied_revision=0 WHERE
    json_extract(payload,'$.entity.work.pluginId')=$1 AND lower(json_extract(payload,'$.entity.work.sourceNovelId'))=lower($2)`, [work.pluginId, work.sourceNovelId]);
  const { requestUserStateDeferredApply } = await import("./user-state-core");
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
    await db.execute("UPDATE user_state_record SET applied_revision=0");
  });
  emitUserStateLedgerChanged();
}
