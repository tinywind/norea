import { getDb, runDatabaseTransaction } from "./client";
import {
  assertUserStateAvailableInDb, chapterReference, chapterWork, emitUserStateApplied, hasUserStateSchema,
  namespaceFor, recordUserStateChangesInDb, recordResumeClearedInDb, requireBinding, workspaceRows,
  USER_CHAPTER_SELECT, userStateRestorePausedInDb, type UserChapterRow, type UserStateDb,
} from "./user-state-core";
import {
  acknowledgeUserStateOperationsInDb, applyUserStateReadPageInDb, bindUserStateWorkspaceInDb,
  getUserStateLedgerStatusInDb, listUserStateConflictsInDb, listUserStateDeferredInDb,
  prepareUserStateOperationsInDb, resolveUserStateLedgerConflictInDb, type UserStateLedgerStatus,
} from "./user-state-ledger";
import { DeferredUserState, materializeUserStateRecordInDb, hasPendingUserStateForRecordInDb, refreshUnattemptedUserStateIdentitiesInDb } from "./user-state-materialize";
import {
  parsePortableReaderAnchor, parseUserStateRecord,
  type PortableReaderAnchor, type UserStateApplyEffects, type UserStateBinding, type UserStateConflict,
  type UserStateDeferred, type UserStateMergeResult, type UserStateOperation, type UserStateReadResponse,
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

export async function materializePendingUserState(binding: UserStateBinding): Promise<UserStateApplyEffects> {
  const generation = activeGeneration;
  const allowed = () => activeGeneration === generation && (activeServer === null || activeServer === binding.serverUrl);
  const db = await getDb();
  await requireBinding(db, binding);
  await assertUserStateAvailableInDb(db);
  const namespace = namespaceFor(binding);
  const candidates = await db.select<{ entityKey: string; payload: string }[]>(`SELECT entity_key AS entityKey,payload FROM user_state_record
    WHERE namespace=$1 AND (applied_revision<revision OR deferred_reason IS NOT NULL OR json_extract(payload,'$.entity.kind')='resume')
    ORDER BY CASE json_extract(payload,'$.entity.kind') WHEN 'category' THEN 0 WHEN 'library' THEN 1 WHEN 'composition' THEN 2 ELSE 3 END,revision`, [namespace]);
  const effects: UserStateApplyEffects = { resumes: [] };
  for (const candidate of candidates) {
    if (!allowed()) break;
    const record = parseUserStateRecord(JSON.parse(candidate.payload));
    try {
      const next = await runDatabaseTransaction(async transaction => {
        await requireBinding(transaction, binding);
        await assertUserStateAvailableInDb(transaction);
        if (!allowed()) return { resumes: [] };
        const [latest] = await transaction.select<{ revision: number }[]>("SELECT revision FROM user_state_record WHERE namespace=$1 AND entity_key=$2", [namespace, candidate.entityKey]);
        if (latest?.revision !== record.revision) return { resumes: [] };
        if (await hasPendingUserStateForRecordInDb(transaction, namespace, record)) throw new DeferredUserState("pending-local-change");
        const result = await materializeUserStateRecordInDb(transaction, namespace, record);
        await transaction.execute("UPDATE user_state_record SET applied_revision=revision,deferred_reason=NULL,deferred_detail=NULL WHERE namespace=$1 AND entity_key=$2 AND revision=$3",
          [namespace, candidate.entityKey, record.revision]);
        return result;
      }, true);
      effects.resumes.push(...next.resumes);
    } catch (error) {
      if (!allowed()) break;
      await runDatabaseTransaction(async transaction => {
        await requireBinding(transaction, binding);
        await assertUserStateAvailableInDb(transaction);
        if (!allowed()) return;
        await transaction.execute("UPDATE user_state_record SET deferred_reason=$4,deferred_detail=$5 WHERE namespace=$1 AND entity_key=$2 AND revision=$3",
          [namespace, candidate.entityKey, record.revision, error instanceof DeferredUserState ? error.reason : "application-failed",
            error instanceof Error ? error.message : String(error)]);
      });
    }
  }
  if (allowed()) { emitUserStateApplied(effects); emitUserStateLedgerChanged(); }
  return effects;
}
export async function applyUserStateReadPage(binding: UserStateBinding, page: UserStateReadResponse): Promise<UserStateApplyEffects> {
  await runDatabaseTransaction(db => applyUserStateReadPageInDb(db, binding, page));
  emitUserStateLedgerChanged();
  return materializePendingUserState(binding);
}
export async function acknowledgeUserStateOperations(binding: UserStateBinding, results: UserStateMergeResult[]): Promise<UserStateApplyEffects> {
  await runDatabaseTransaction(db => acknowledgeUserStateOperationsInDb(db, binding, results));
  emitUserStateLedgerChanged();
  return materializePendingUserState(binding);
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
