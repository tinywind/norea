import {
  canonicalUserStateJson, isLocalUserStateEntity, parseUserStateEntity, parseUserStateMergeResult, parseUserStateOperation, parseUserStateReadResponse, parseUserStateRecord,
  USER_STATE_CLIENT_BATCH_BYTES, userStateEntityKey, userStateJsonBytes,
  type UserStateApplyEffects, type UserStateBinding, type UserStateConflict, type UserStateDeferred, type UserStateEntity,
  type UserStateMergeResult, type UserStateOperation, type UserStateReadResponse, type UserStateRebindMode, type UserStateRecord, type UserStateValue, type UserStateValueMap,
} from "../../lib/user-state/types";
import {
  assertUserStateAvailableInDb, canonicalEntity, chapterReference, chapterWork, hasUserStateSchema, intentFromRow, isBeforeSeedCutoff, namespaceFor, nonEmptySourceId, promotePrivateWorkIdentitiesInDb, recordChapterRowsInDb, recordResumeClearedInDb, recordUserStateChangesInDb, requireBinding,
  resolveCategoryAlias, seedUserStateInDb, USER_CHAPTER_SELECT, USER_STATE_PRELINK_BASE_REVISION, userStateRestorePausedInDb, workspaceRows,
  type IntentRow, type UserChapterRow, type UserStateDb,
} from "./user-state-core";
import { isCurrentWorkHeld, loadCurrentHeldSourcesInDb } from "./user-state-current-data";
import { DeferredUserState, hasPendingUserStateForRecordInDb, materializeUserStateRecordInDb } from "./user-state-materialize";
import { portableStoredUserStateIntentInDb } from "./user-state-stored-chapter";

interface PendingRow extends IntentRow { baseRevision: number; acknowledgedSequence: number }
interface OperationRow { operationId: string; entityKey: string; intentSequence: number; payload: string; status: string; receipt: string | null }
interface StoredRecordRow { entityKey: string; revision: number; appliedRevision: number; payload: string; deletionRevision: number }
const USER_STATE_DB_BATCH_BYTES = 8 * 1024 * 1024;

export async function purgeAndSettleLocalUserStateInDb(db: UserStateDb): Promise<void> {
  await db.execute(`DELETE FROM user_state_operation
    WHERE json_extract(payload,'$.entity.work.pluginId')='local'
      OR (json_extract(payload,'$.entity.kind')='composition'
          AND EXISTS (SELECT 1 FROM json_each(payload,'$.value.composition.entries') e,json_each(e.value,'$.sources') s
                      WHERE json_extract(s.value,'$.pluginId')='local'))`);
  await db.execute(`DELETE FROM user_state_conflict WHERE entity_key IN (
    SELECT entity_key FROM user_state_intent
    WHERE json_extract(entity_json,'$.work.pluginId')='local'
      OR (json_extract(entity_json,'$.kind')='composition'
          AND EXISTS (SELECT 1 FROM json_each(value_json,'$.composition.entries') e,json_each(e.value,'$.sources') s
                      WHERE json_extract(s.value,'$.pluginId')='local')))`);
  await db.execute(`DELETE FROM user_state_progress WHERE entity_key IN (
    SELECT entity_key FROM user_state_intent
    WHERE json_extract(entity_json,'$.work.pluginId')='local'
      OR (json_extract(entity_json,'$.kind')='composition'
          AND EXISTS (SELECT 1 FROM json_each(value_json,'$.composition.entries') e,json_each(e.value,'$.sources') s
                      WHERE json_extract(s.value,'$.pluginId')='local')))`);
  await db.execute(`DELETE FROM user_state_intent
    WHERE json_extract(entity_json,'$.work.pluginId')='local'
      OR (json_extract(entity_json,'$.kind')='composition'
          AND EXISTS (SELECT 1 FROM json_each(value_json,'$.composition.entries') e,json_each(e.value,'$.sources') s
                      WHERE json_extract(s.value,'$.pluginId')='local'))`);
  await db.execute(`UPDATE user_state_record
    SET applied_revision=revision,deferred_reason=NULL,deferred_detail=NULL
    WHERE (applied_revision<revision OR deferred_reason IS NOT NULL)
      AND (json_extract(payload,'$.entity.work.pluginId')='local'
        OR (json_extract(payload,'$.entity.kind')='composition'
            AND EXISTS (SELECT 1 FROM json_each(payload,'$.value.composition.entries') e,json_each(e.value,'$.sources') s
                        WHERE json_extract(s.value,'$.pluginId')='local')))`);
}

export async function settleHeldSourceRecordsInDb(db: UserStateDb, namespace: string, serverUrl: string): Promise<number> {
  const held = await loadCurrentHeldSourcesInDb(db, serverUrl);
  if (!held.idPairs.length && !held.pathPairs.length) return 0;
  const result = await db.execute(`UPDATE user_state_record
    SET applied_revision=revision,deferred_reason=NULL,deferred_detail=NULL
    WHERE namespace=$1
      AND (applied_revision<revision OR deferred_reason IS NOT NULL)
      AND json_extract(payload,'$.entity.kind')<>'category'
      AND (
        (json_extract(payload,'$.entity.work.sourceNovelId') IS NOT NULL
         AND EXISTS (SELECT 1 FROM json_each($2) h
           WHERE json_extract(h.value,'$.pluginId')=json_extract(user_state_record.payload,'$.entity.work.pluginId')
             AND json_extract(h.value,'$.sourceNovelId')=lower(json_extract(user_state_record.payload,'$.entity.work.sourceNovelId'))))
        OR EXISTS (SELECT 1 FROM json_each($3) hp
          WHERE json_extract(hp.value,'$.pluginId')=json_extract(user_state_record.payload,'$.entity.work.pluginId')
            AND json_extract(hp.value,'$.novelPath')=json_extract(user_state_record.payload,'$.entity.work.novelPath'))
      )`, [namespace, JSON.stringify(held.idPairs), JSON.stringify(held.pathPairs)]);
  return result.rowsAffected;
}

function jsonBatches<T>(rows: readonly T[], size: (row: T) => number): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [], bytes = 2;
  for (const row of rows) {
    const rowBytes = size(row) + 1;
    if (batch.length && bytes + rowBytes > USER_STATE_DB_BATCH_BYTES) {
      batches.push(batch); batch = []; bytes = 2;
    }
    batch.push(row); bytes += rowBytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
export interface UserStateLedgerStatus { cursor: number; through: number | null; pending: number; conflicts: number; deferred: number;
  projectionPending: number; projectionFailed: number;
  lastSuccessAt: number | null; pausedAfterRestore: boolean }

function intentTimestampForCutoff(entity: UserStateEntity, value: UserStateValue): number | null {
  if (entity.kind === "reading") return (value as UserStateValueMap["reading"]).readAt;
  if (entity.kind === "resume") {
    const resume = value as UserStateValueMap["resume"];
    if (resume.openedAt !== null && resume.anchor?.savedAt !== undefined) return Math.max(resume.openedAt, resume.anchor.savedAt);
    return resume.openedAt ?? resume.anchor?.savedAt ?? null;
  }
  return null;
}

async function insertSeedProgressForIntentsInDb(db: UserStateDb, namespace: string, seedCutoffMs: number | null): Promise<void> {
  if (seedCutoffMs === null) {
    await db.execute(`INSERT INTO user_state_progress(namespace,entity_key,local_sequence,base_revision)
      SELECT $1,entity_key,sequence,CASE WHEN seed=0 THEN $2 ELSE 0 END
      FROM user_state_intent WHERE true ON CONFLICT(namespace,entity_key) DO NOTHING`, [namespace, USER_STATE_PRELINK_BASE_REVISION]);
    return;
  }
  const rows = await db.select<IntentRow[]>(
    "SELECT sequence,entity_key AS entityKey,entity_json AS entityJson,value_json AS valueJson,seed FROM user_state_intent",
  );
  const eligible: { entityKey: string; sequence: number; baseRevision: number }[] = [];
  for (const row of rows) {
    try {
      const intent = intentFromRow(row);
      if (isBeforeSeedCutoff(intentTimestampForCutoff(intent.entity, intent.value), seedCutoffMs)) continue;
    } catch {
      // Ignore malformed legacy intent timestamp checks.
    }
    eligible.push({
      entityKey: row.entityKey,
      sequence: row.sequence,
      baseRevision: row.seed === 0 ? USER_STATE_PRELINK_BASE_REVISION : 0,
    });
  }
  for (const batch of jsonBatches(eligible, row => row.entityKey.length + 64)) {
    await db.execute(
      `INSERT INTO user_state_progress(namespace,entity_key,local_sequence,base_revision)
       SELECT $1,json_extract(value,'$.entityKey'),json_extract(value,'$.sequence'),json_extract(value,'$.baseRevision')
       FROM json_each($2) WHERE true
       ON CONFLICT(namespace,entity_key) DO NOTHING`,
      [namespace, JSON.stringify(batch)],
    );
  }
}

export async function bindUserStateWorkspaceInDb(
  db: UserStateDb,
  binding: UserStateBinding,
  options: { seedAllowed?: boolean; seedCutoffMs?: number | null } = {},
): Promise<void> {
  await assertUserStateAvailableInDb(db);
  if (!binding.serverUrl || !binding.workspaceId || !binding.epoch) throw new Error("A complete personal state workspace is required.");
  const seedCutoffMs = options.seedCutoffMs ?? null;
  if (seedCutoffMs !== null && seedCutoffMs < 0) throw new Error("Seed cutoff time must be non-negative.");
  const namespace = namespaceFor(binding);
  const existing = (await workspaceRows(db)).find(row => row.serverUrl === binding.serverUrl);
  let seedSuppressed = false;
  if (existing) {
    const ws = await requireBinding(db, binding);
    seedSuppressed = ws.seedSuppressed !== 0;
    if (options.seedAllowed !== undefined) {
      await db.execute("UPDATE user_state_workspace SET seed_cutoff_at=$2 WHERE namespace=$1", [namespace, seedCutoffMs]);
    }
  } else {
    await db.execute(
      "INSERT INTO user_state_workspace(server_url,namespace,workspace_id,epoch,seed_suppressed,seed_cutoff_at) VALUES($1,$2,$3,$4,0,$5)",
      [binding.serverUrl, namespace, binding.workspaceId, binding.epoch, seedCutoffMs],
    );
  }

  // Pre-LWW clients could leave compare-and-swap conflicts that permanently block
  // the next explicit edit. The workspace is single-user now, so retry those intents.
  await db.execute("DELETE FROM user_state_conflict WHERE namespace=$1 AND reason='revision-mismatch'", [namespace]);
  await purgeAndSettleLocalUserStateInDb(db);

  // Current-snapshot clients created only the workspace row. Seed the durable delta
  // outbox once when such a database upgrades, then use record-level intents only.
  const readyKey = "user-state-delta-ready:" + namespace;
  const [ready] = await db.select<{ ready: number }[]>(
    "SELECT COUNT(*) AS ready FROM content_sync_cache WHERE cache_key=$1", [readyKey]);
  if (ready?.ready || seedSuppressed) {
    if (!ready?.ready && seedSuppressed) {
      await db.execute("INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO NOTHING",
        [readyKey, JSON.stringify({ version: 1 })]);
    }
    return;
  }
  if (options.seedAllowed !== false) {
    if (seedCutoffMs === null) {
      // Local explicit intents predating the first workspace binding have no server
      // order. Treat them as soft baselines; later offline edits remain explicit.
      await db.execute(`INSERT INTO user_state_progress(namespace,entity_key,local_sequence,base_revision)
        SELECT $1,entity_key,sequence,$2 FROM user_state_intent WHERE seed=0 AND true
        ON CONFLICT(namespace,entity_key) DO NOTHING`, [namespace, USER_STATE_PRELINK_BASE_REVISION]);
    }
    await seedUserStateInDb(db, { seedAllowed: true, seedCutoffMs });
    await insertSeedProgressForIntentsInDb(db, namespace, seedCutoffMs);
  }
  await db.execute("INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO NOTHING",
    [readyKey, JSON.stringify({ version: 1 })]);
}

export function unresolvedIntent(entity: UserStateEntity, value?: unknown): string | null {
  if ("work" in entity && !entity.work.sourceNovelId) return "missing-work-identity";
  if ((entity.kind === "reading" || entity.kind === "bookmark") && /^(?:norea|local)-folder:/.test(entity.chapter.chapterPath)) return "missing-chapter-identity";
  if (entity.kind === "resume") {
    const chapter = (value as UserStateValueMap["resume"] | undefined)?.chapter;
    if (chapter && /^(?:norea|local)-folder:/.test(chapter.chapterPath)) return "missing-chapter-identity";
  }
  return null;
}
export async function prepareUserStateOperationsInDb(
  db: UserStateDb, binding: UserStateBinding, limits: { limit?: number; maxBytes?: number; allowOpaqueIdentity?: boolean } = {},
): Promise<UserStateOperation[]> {
  await assertUserStateAvailableInDb(db);
  const { namespace } = await requireBinding(db, binding);
  await purgeAndSettleLocalUserStateInDb(db);
  const limit = limits.limit === undefined ? null : Math.max(1, Math.floor(limits.limit));
  const maxBytes = Math.min(USER_STATE_CLIENT_BATCH_BYTES, limits.maxBytes ?? USER_STATE_CLIENT_BATCH_BYTES);
  const allowOpaqueIdentity = limits.allowOpaqueIdentity === true;
  const result: UserStateOperation[] = [];
  const newAttempts: { operationId: string; entityKey: string; intentSequence: number; payload: string }[] = [];
  let bytes = userStateJsonBytes({ workspaceId: binding.workspaceId, epoch: binding.epoch, operations: [] });
  const include = (operation: UserStateOperation): boolean => {
    const size = userStateJsonBytes(operation) + 1;
    if ((limit !== null && result.length >= limit) || bytes + size > maxBytes) return false;
    result.push(operation); bytes += size; return true;
  };
  const retries = await db.select<OperationRow[]>(
    "SELECT operation_id AS operationId,entity_key AS entityKey,intent_sequence AS intentSequence,payload,status,receipt FROM user_state_operation " +
    "WHERE namespace=$1 AND status='pending' ORDER BY CASE json_extract(payload,'$.entity.kind') WHEN 'category' THEN 0 ELSE 1 END,intent_sequence,operation_id",
    [namespace],
  );
  for (const row of retries) {
    const operation = parseUserStateOperation(JSON.parse(row.payload));
    if (!allowOpaqueIdentity && unresolvedIntent(operation.entity, operation.value)) continue;
    if (!include(operation)) return result;
  }
  const opaqueFilter = allowOpaqueIdentity ? "" : `
      AND (json_type(i.entity_json,'$.work') IS NULL OR json_extract(i.entity_json,'$.work.sourceNovelId') IS NOT NULL)
      AND COALESCE(json_extract(i.entity_json,'$.chapter.chapterPath'),json_extract(i.value_json,'$.chapter.chapterPath'),'') NOT LIKE 'norea-folder:%'
      AND COALESCE(json_extract(i.entity_json,'$.chapter.chapterPath'),json_extract(i.value_json,'$.chapter.chapterPath'),'') NOT LIKE 'local-folder:%'`;
  const intentSql = `SELECT i.sequence,i.entity_key AS entityKey,i.entity_json AS entityJson,i.value_json AS valueJson,i.seed,
    p.base_revision AS baseRevision,p.acknowledged_sequence AS acknowledgedSequence
    FROM user_state_intent i JOIN user_state_progress p ON p.entity_key=i.entity_key AND p.namespace=$1
    WHERE i.sequence>p.acknowledged_sequence
      AND NOT EXISTS(SELECT 1 FROM user_state_operation o WHERE o.namespace=$1 AND o.entity_key=i.entity_key AND o.status='pending')
      AND NOT EXISTS(SELECT 1 FROM user_state_conflict c WHERE c.namespace=$1 AND c.entity_key=i.entity_key)` +
    opaqueFilter +
    ` ORDER BY CASE json_extract(i.entity_json,'$.kind') WHEN 'category' THEN 0 ELSE 1 END,i.sequence` +
    (limit === null ? "" : " LIMIT $2");
  const intents = await db.select<PendingRow[]>(intentSql, limit === null ? [namespace] : [namespace, limit]);
  for (const row of intents) {
    const localIntent = intentFromRow(row);
    const intent = await portableStoredUserStateIntentInDb(db, localIntent);
    if (!allowOpaqueIdentity && unresolvedIntent(intent.entity, intent.value)) continue;
    const baseline = row.seed === 1 || row.baseRevision === USER_STATE_PRELINK_BASE_REVISION;
    const operation = parseUserStateOperation({
      operationId: crypto.randomUUID(), entity: await canonicalEntity(db, namespace, intent.entity),
      value: intent.value, baseRevision: baseline ? 0 : row.baseRevision, ...(baseline ? { seed: true } : {}),
    });
    if (!include(operation)) break;
    newAttempts.push({ operationId: operation.operationId, entityKey: row.entityKey, intentSequence: row.sequence,
      payload: canonicalUserStateJson(operation) });
  }
  for (const batch of jsonBatches(newAttempts, row => row.payload.length + row.entityKey.length + 128)) {
    await db.execute(`INSERT INTO user_state_operation(operation_id,namespace,entity_key,intent_sequence,payload)
      SELECT json_extract(value,'$.operationId'),$1,json_extract(value,'$.entityKey'),
        json_extract(value,'$.intentSequence'),json_extract(value,'$.payload')
      FROM json_each($2)`, [namespace, JSON.stringify(batch)]);
  }
  return result;
}

export async function storeUserStateRecordsInDb(db: UserStateDb, namespace: string, raws: readonly UserStateRecord[]): Promise<void> {
  const rows: StoredRecordRow[] = raws.map(raw => {
    const record = parseUserStateRecord(raw);
    const payload = canonicalUserStateJson(record);
    return {
      entityKey: userStateEntityKey(record.entity), revision: record.revision,
      appliedRevision: isLocalUserStateEntity(record.entity, record.value) ? record.revision : 0,
      payload,
      deletionRevision: record.entity.kind === "category" && (record.value as UserStateValueMap["category"]).deleted ? record.revision : 0,
    };
  });
  for (const batch of jsonBatches(rows, row => row.payload.length + row.entityKey.length + 96)) {
    const encoded = JSON.stringify(batch);
    const existing = await db.select<{ entityKey: string; revision: number; payload: string }[]>(`
      SELECT r.entity_key AS entityKey,r.revision,r.payload
      FROM json_each($2) incoming CROSS JOIN user_state_record r
        ON r.entity_key=json_extract(incoming.value,'$.entityKey')
      WHERE r.namespace=$1`, [namespace, encoded]);
    const incoming = new Map(batch.map(row => [JSON.stringify([row.entityKey, row.revision]), row.payload]));
    for (const row of existing) {
      const payload = incoming.get(JSON.stringify([row.entityKey, row.revision]));
      if (payload !== undefined && payload !== row.payload) throw new Error("The shared state revision changed its contents.");
    }
    await db.execute(`INSERT INTO user_state_record(namespace,entity_key,revision,applied_revision,payload,deletion_revision)
      SELECT $1,json_extract(value,'$.entityKey'),json_extract(value,'$.revision'),
        json_extract(value,'$.appliedRevision'),json_extract(value,'$.payload'),json_extract(value,'$.deletionRevision')
      FROM json_each($2) WHERE true
      ON CONFLICT(namespace,entity_key) DO UPDATE SET revision=excluded.revision,
        applied_revision=MAX(user_state_record.applied_revision,excluded.applied_revision),payload=excluded.payload,
        deletion_revision=MAX(user_state_record.deletion_revision,excluded.deletion_revision),deferred_reason=NULL,deferred_detail=NULL
      WHERE excluded.revision>user_state_record.revision`, [namespace, encoded]);
  }
}
export async function storeUserStateRecordInDb(db: UserStateDb, namespace: string, raw: UserStateRecord): Promise<void> {
  await storeUserStateRecordsInDb(db, namespace, [raw]);
}

export async function applyUserStateReadPageInDb(db: UserStateDb, binding: UserStateBinding, raw: UserStateReadResponse): Promise<void> {
  await assertUserStateAvailableInDb(db);
  const workspace = await requireBinding(db, binding);
  const page = parseUserStateReadResponse(raw);
  if (page.workspaceId !== binding.workspaceId || page.epoch !== binding.epoch ||
      page.nextCursor < workspace.cursor || (workspace.through !== null && workspace.through !== page.through) ||
      page.records.some(record => record.revision <= workspace.cursor)) {
    throw new Error("The personal state page does not continue this workspace cursor.");
  }
  await storeUserStateRecordsInDb(db, workspace.namespace, page.records);
  await db.execute("UPDATE user_state_workspace SET cursor=$2,read_through=$3,last_success_at=$4 WHERE namespace=$1",
    [workspace.namespace, page.nextCursor, page.hasMore ? page.through : null, Date.now()]);
}

async function rememberAlias(db: UserStateDb, namespace: string, alias: { from: string; to: string }): Promise<void> {
  const canonical = await resolveCategoryAlias(db, namespace, alias.to);
  const [previous] = await db.select<{ canonicalId: string }[]>("SELECT canonical_id AS canonicalId FROM user_state_alias WHERE namespace=$1 AND alias_id=$2", [namespace, alias.from]);
  if (previous && await resolveCategoryAlias(db, namespace, previous.canonicalId) !== canonical) throw new Error("The shared category alias changed ownership.");
  if (canonical === alias.from) throw new Error("The shared category alias is cyclic.");
  await db.execute("INSERT INTO user_state_alias(namespace,alias_id,canonical_id) VALUES($1,$2,$3) ON CONFLICT(namespace,alias_id) DO NOTHING", [namespace, alias.from, canonical]);
  const [local] = await db.select<{ localId: number | null }[]>("SELECT local_id AS localId FROM user_state_category WHERE category_id=$1", [alias.from]);
  if (local?.localId) {
    const [target] = await db.select<{ localId: number | null }[]>("SELECT local_id AS localId FROM user_state_category WHERE category_id=$1", [canonical]);
    if (target?.localId && target.localId !== local.localId) {
      await db.execute("INSERT OR IGNORE INTO novel_category(novel_id,category_id) SELECT novel_id,$2 FROM novel_category WHERE category_id=$1", [local.localId, target.localId]);
      await db.execute("UPDATE user_state_category SET local_id=$2 WHERE local_id=$1 OR category_id=$3", [local.localId, target.localId, alias.from]);
      await db.execute("DELETE FROM category WHERE id=$1", [local.localId]);
    } else await db.execute("INSERT INTO user_state_category(category_id,local_id) VALUES($1,$2) ON CONFLICT(category_id) DO UPDATE SET local_id=excluded.local_id", [canonical, local.localId]);
  }
}

export async function acknowledgeUserStateOperationsInDb(db: UserStateDb, binding: UserStateBinding, raws: readonly UserStateMergeResult[]): Promise<void> {
  await assertUserStateAvailableInDb(db);
  const { namespace } = await requireBinding(db, binding);
  const results = raws.map(parseUserStateMergeResult);
  if (new Set(results.map(result => result.operationId)).size !== results.length) throw new Error("Duplicate personal state acknowledgements.");

  const attempts = new Map<string, OperationRow>();
  for (const batch of jsonBatches(results.map(result => result.operationId), value => value.length + 4)) {
    const rows = await db.select<OperationRow[]>(`SELECT operation_id AS operationId,entity_key AS entityKey,
      intent_sequence AS intentSequence,payload,status,receipt FROM user_state_operation
      WHERE namespace=$1 AND operation_id IN (SELECT value FROM json_each($2))`, [namespace, JSON.stringify(batch)]);
    for (const row of rows) attempts.set(row.operationId, row);
  }
  if (attempts.size !== results.length) throw new Error("The personal state receipt does not belong to a pending operation.");

  type PendingAck = {
    result: UserStateMergeResult; attempt: OperationRow; operation: UserStateOperation;
    receipt: string; effectiveKey: string; equivalentAlias: boolean;
  };
  const pending: PendingAck[] = [];
  const currentRecords: UserStateRecord[] = [];
  for (const result of results) {
    const attempt = attempts.get(result.operationId)!;
    const receipt = canonicalUserStateJson(result);
    if (attempt.receipt && attempt.receipt !== receipt) {
      throw new Error("The personal state receipt changed after acknowledgement.");
    }
    // A previous non-transactional ACK may have stored the immutable receipt before
    // it advanced user_state_progress. Replaying the same receipt is intentional:
    // every following write is idempotent and completes the interrupted ACK.
    const operation = parseUserStateOperation(JSON.parse(attempt.payload));
    if (result.categoryAlias) {
      if (!("categoryId" in operation.entity) || result.categoryAlias.from !== operation.entity.categoryId) {
        throw new Error("The category alias does not match its operation.");
      }
      await rememberAlias(db, namespace, result.categoryAlias);
      const categoryId = await resolveCategoryAlias(db, namespace, result.categoryAlias.to);
      await db.execute("UPDATE user_state_record SET applied_revision=0,deferred_reason=NULL,deferred_detail=NULL WHERE namespace=$1 AND entity_key=$2",
        [namespace, userStateEntityKey({ kind: "category", categoryId })]);
    }
    const effective = await canonicalEntity(db, namespace, operation.entity);
    const effectiveKey = userStateEntityKey(effective);
    if (result.current && userStateEntityKey(result.current.entity) !== effectiveKey) {
      throw new Error("The receipt has a different personal state identity.");
    }
    if (result.current) currentRecords.push(result.current);
    pending.push({
      result, attempt, operation, receipt, effectiveKey,
      equivalentAlias: result.status !== "aliased" || !!result.current &&
        canonicalUserStateJson(operation.value) === canonicalUserStateJson(result.current.value),
    });
  }

  await storeUserStateRecordsInDb(db, namespace, currentRecords);

  const alreadyProjected = pending.flatMap(row => {
    const current = row.result.current;
    if (!current || row.result.status === "conflict" ||
        canonicalUserStateJson(row.operation.value) !== canonicalUserStateJson(current.value)) return [];
    return [{ entityKey: row.effectiveKey, revision: current.revision }];
  });
  for (const batch of jsonBatches(alreadyProjected, row => row.entityKey.length + 48)) {
    await db.execute(`WITH incoming AS (
      SELECT json_extract(value,'$.entityKey') AS entity_key,
        json_extract(value,'$.revision') AS revision FROM json_each($2)
    )
    UPDATE user_state_record AS record SET
      applied_revision=MAX(record.applied_revision,incoming.revision),
      deferred_reason=NULL,deferred_detail=NULL
    FROM incoming
    WHERE record.namespace=$1 AND record.entity_key=incoming.entity_key AND record.revision=incoming.revision`,
    [namespace, JSON.stringify(batch)]);
  }

  const revisions = new Map<string, number>();
  const keys = [...new Set(pending.map(row => row.effectiveKey))];
  for (const batch of jsonBatches(keys, value => value.length + 4)) {
    const rows = await db.select<{ entityKey: string; revision: number }[]>(`SELECT entity_key AS entityKey,revision
      FROM user_state_record WHERE namespace=$1 AND entity_key IN (SELECT value FROM json_each($2))`,
    [namespace, JSON.stringify(batch)]);
    for (const row of rows) revisions.set(row.entityKey, row.revision);
  }

  const operationUpdates = pending.map(row => ({
    operationId: row.attempt.operationId,
    status: row.result.status === "conflict" ? "conflict" : "acknowledged",
    receipt: row.receipt,
  }));
  for (const batch of jsonBatches(operationUpdates, row => row.receipt.length + row.operationId.length + 64)) {
    await db.execute(`WITH incoming AS (
      SELECT json_extract(value,'$.operationId') AS operation_id,
        json_extract(value,'$.status') AS status,json_extract(value,'$.receipt') AS receipt
      FROM json_each($1)
    )
    UPDATE user_state_operation AS operation
    SET status=incoming.status,
      receipt=incoming.receipt,
      acknowledged_at=CASE
        WHEN incoming.status='acknowledged' THEN COALESCE(operation.acknowledged_at, unixepoch())
        ELSE NULL
      END
    FROM incoming WHERE operation.operation_id=incoming.operation_id`, [JSON.stringify(batch)]);
  }

  const conflicts = pending.filter(row => row.result.status === "conflict").map(row => ({
    id: row.attempt.operationId, entityKey: row.attempt.entityKey, reason: row.result.reason ?? "revision-mismatch",
  }));
  for (const batch of jsonBatches(conflicts, row => row.id.length + row.entityKey.length + row.reason.length + 64)) {
    await db.execute(`INSERT INTO user_state_conflict(id,namespace,entity_key,reason)
      SELECT json_extract(value,'$.id'),$1,json_extract(value,'$.entityKey'),json_extract(value,'$.reason')
      FROM json_each($2) WHERE true
      ON CONFLICT(namespace,entity_key) DO UPDATE SET id=excluded.id,reason=excluded.reason`,
    [namespace, JSON.stringify(batch)]);
  }

  const progress = pending.filter(row => row.result.status !== "conflict").map(row => {
    const current = row.result.current;
    const canRebase = row.result.status !== "seed-skipped" && row.equivalentAlias && current &&
      (revisions.get(row.effectiveKey) ?? 0) <= current.revision;
    return {
      entityKey: row.attempt.entityKey, intentSequence: row.attempt.intentSequence,
      baseRevision: canRebase ? current!.revision : null,
    };
  });
  for (const batch of jsonBatches(progress, row => row.entityKey.length + 80)) {
    await db.execute(`WITH incoming AS (
      SELECT json_extract(value,'$.entityKey') AS entity_key,
        json_extract(value,'$.intentSequence') AS intent_sequence,
        json_extract(value,'$.baseRevision') AS base_revision FROM json_each($2)
    )
    UPDATE user_state_progress AS progress SET
      acknowledged_sequence=MAX(progress.acknowledged_sequence,incoming.intent_sequence),
      base_revision=CASE WHEN incoming.base_revision IS NULL THEN progress.base_revision ELSE incoming.base_revision END
    FROM incoming WHERE progress.namespace=$1 AND progress.entity_key=incoming.entity_key`,
    [namespace, JSON.stringify(batch)]);
  }
  await db.execute("UPDATE user_state_workspace SET last_success_at=$2 WHERE namespace=$1", [namespace, Date.now()]);
}

export async function pruneAcknowledgedUserStateOperationsInDb(
  db: UserStateDb,
  binding: UserStateBinding,
  olderThanSecs = 7 * 24 * 60 * 60,
): Promise<number> {
  if (!Number.isSafeInteger(olderThanSecs) || olderThanSecs < 0) {
    throw new Error("Operation retention age must be a non-negative number of seconds.");
  }
  await assertUserStateAvailableInDb(db);
  const { namespace } = await requireBinding(db, binding);
  const nowSecs = Math.floor(Date.now() / 1000);
  const cutoff = Math.max(0, nowSecs - olderThanSecs);
  const result = await db.execute(
    `DELETE FROM user_state_operation
     WHERE namespace=$1
       AND status='acknowledged'
       AND (acknowledged_at IS NULL OR acknowledged_at<=$2)`,
    [namespace, cutoff],
  );
  return result.rowsAffected;
}

async function categoryNameInDb(db: UserStateDb, namespace: string, entity: UserStateEntity): Promise<string | undefined> {
  if (!("categoryId" in entity)) return undefined;
  const categoryId = await resolveCategoryAlias(db, namespace, entity.categoryId);
  const [record] = await db.select<{ payload: string }[]>("SELECT payload FROM user_state_record WHERE namespace=$1 AND entity_key=$2", [namespace, userStateEntityKey({ kind: "category", categoryId })]);
  if (record) return (parseUserStateRecord(JSON.parse(record.payload)).value as UserStateValueMap["category"]).name;
  const [local] = await db.select<{ name: string }[]>("SELECT c.name FROM category c JOIN user_state_category m ON m.local_id=c.id WHERE m.category_id=$1", [categoryId]);
  return local?.name;
}
export async function listUserStateConflictsInDb(db: UserStateDb, binding: UserStateBinding): Promise<UserStateConflict[]> {
  const { namespace } = await requireBinding(db, binding);
  const rows = await db.select<(IntentRow & { id: string; reason: string })[]>(`SELECT c.id,c.reason,i.sequence,i.entity_key AS entityKey,i.entity_json AS entityJson,i.value_json AS valueJson,i.seed
    FROM user_state_conflict c JOIN user_state_intent i ON i.entity_key=c.entity_key WHERE c.namespace=$1 ORDER BY i.sequence`, [namespace]);
  const result: UserStateConflict[] = [];
  for (const row of rows) {
    const intent = intentFromRow(row);
    if (isLocalUserStateEntity(intent.entity, intent.value)) continue;
    const effective = await canonicalEntity(db, namespace, intent.entity);
    const [shared] = await db.select<{ payload: string }[]>("SELECT payload FROM user_state_record WHERE namespace=$1 AND entity_key=$2", [namespace, userStateEntityKey(effective)]);
    const record = shared ? parseUserStateRecord(JSON.parse(shared.payload)) : null;
    const categoryName = await categoryNameInDb(db, namespace, intent.entity);
    result.push({ id: row.id, ...(categoryName ? { categoryName } : {}), entity: intent.entity, local: intent.value, shared: record, reason: row.reason,
      version: canonicalUserStateJson([row.id, row.sequence, record?.revision ?? 0]) });
  }
  return result;
}
export async function listUserStateDeferredInDb(db: UserStateDb, binding: UserStateBinding): Promise<UserStateDeferred[]> {
  const { namespace } = await requireBinding(db, binding);
  const intents = await db.select<IntentRow[]>("SELECT i.sequence,i.entity_key AS entityKey,i.entity_json AS entityJson,i.value_json AS valueJson,i.seed FROM user_state_intent i JOIN user_state_progress p ON p.entity_key=i.entity_key WHERE p.namespace=$1 AND i.sequence>p.acknowledged_sequence", [namespace]);
  const result: UserStateDeferred[] = [];
  for (const row of intents) {
    const intent = intentFromRow(row);
    if (isLocalUserStateEntity(intent.entity, intent.value)) continue;
    const reason = unresolvedIntent(intent.entity, intent.value);
    if (reason) result.push({ id: row.entityKey, entity: intent.entity, reason });
  }
  return result;
}
export async function getUserStateLedgerStatusInDb(db: UserStateDb, binding: UserStateBinding): Promise<UserStateLedgerStatus> {
  const workspace = await requireBinding(db, binding);
  const [count] = await db.select<{ pending: number }[]>(
    "SELECT COUNT(*) AS pending FROM user_state_intent i JOIN user_state_progress p ON p.entity_key=i.entity_key WHERE p.namespace=$1 AND i.sequence>p.acknowledged_sequence AND COALESCE(json_extract(i.entity_json,'$.work.pluginId'),'')<>'local'",
    [workspace.namespace],
  );
  const [held] = await db.select<{ deferred: number }[]>(
    "SELECT COUNT(*) AS deferred FROM user_state_intent i JOIN user_state_progress p ON p.entity_key=i.entity_key AND p.namespace=$1 WHERE i.sequence>p.acknowledged_sequence AND COALESCE(json_extract(i.entity_json,'$.work.pluginId'),'')<>'local' AND ((json_type(i.entity_json,'$.work')='object' AND json_extract(i.entity_json,'$.work.sourceNovelId') IS NULL) OR COALESCE(json_extract(i.entity_json,'$.chapter.chapterPath'),json_extract(i.value_json,'$.chapter.chapterPath'),'') LIKE 'norea-folder:%' OR COALESCE(json_extract(i.entity_json,'$.chapter.chapterPath'),json_extract(i.value_json,'$.chapter.chapterPath'),'') LIKE 'local-folder:%')",
    [workspace.namespace],
  );
  const heldIntents = await db.select<{ entityKey: string; entityJson: string }[]>(`SELECT i.entity_key AS entityKey,i.entity_json AS entityJson
    FROM user_state_intent i JOIN user_state_progress p ON p.entity_key=i.entity_key AND p.namespace=$1
    WHERE i.seed=0 AND p.base_revision<>$2 AND i.sequence>p.acknowledged_sequence
      AND COALESCE(json_extract(i.entity_json,'$.work.pluginId'),'')<>'local'`,
    [workspace.namespace, USER_STATE_PRELINK_BASE_REVISION]);
  const heldKeys = new Set<string>();
  for (const row of heldIntents) {
    const entity = parseUserStateEntity(JSON.parse(row.entityJson));
    heldKeys.add(userStateEntityKey(entity));
    heldKeys.add(userStateEntityKey(await canonicalEntity(db, workspace.namespace, entity)));
  }
  const heldSources = await loadCurrentHeldSourcesInDb(db, binding.serverUrl);
  const projRows = await db.select<{
    entityKey: string;
    waiting: number;
    deferredReason: string | null;
    pluginId: string | null;
    novelId: string | null;
    novelPath: string | null;
    applicable: number;
  }[]>(`SELECT entity_key AS entityKey,applied_revision<revision AS waiting,deferred_reason AS deferredReason,
      json_extract(payload,'$.entity.work.pluginId') AS pluginId,
      json_extract(payload,'$.entity.work.sourceNovelId') AS novelId,
      json_extract(payload,'$.entity.work.novelPath') AS novelPath,
      (json_extract(payload,'$.entity.kind')='category' OR EXISTS (
        SELECT 1 FROM novel n WHERE n.plugin_id=json_extract(user_state_record.payload,'$.entity.work.pluginId')
          AND n.plugin_id<>'local' AND n.is_local=0
          AND (CASE WHEN json_extract(user_state_record.payload,'$.entity.work.sourceNovelId') IS NULL
            THEN n.path=json_extract(user_state_record.payload,'$.entity.work.novelPath')
            ELSE lower(n.source_novel_id)=lower(json_extract(user_state_record.payload,'$.entity.work.sourceNovelId')) END)
      )) AS applicable
    FROM user_state_record WHERE namespace=$1
      AND (applied_revision<revision OR deferred_reason='projection-error')
      AND COALESCE(json_extract(payload,'$.entity.work.pluginId'),'')<>'local'`, [workspace.namespace]);
  let projectionPending = 0;
  let projectionFailed = 0;
  for (const row of projRows) {
    if (row.pluginId && isCurrentWorkHeld(heldSources, {
      pluginId: row.pluginId,
      sourceNovelId: row.novelId,
      novelPath: row.novelPath ?? "",
      name: "",
    })) {
      continue;
    }
    if (row.deferredReason === "projection-error") {
      projectionFailed += 1;
      continue;
    }
    if (row.waiting && row.deferredReason === null && row.applicable && !heldKeys.has(row.entityKey)) {
      projectionPending += 1;
    }
  }
  return { cursor: workspace.cursor, through: workspace.through, pending: count?.pending ?? 0,
    conflicts: (await listUserStateConflictsInDb(db, binding)).length,
    deferred: held?.deferred ?? 0,
    projectionPending, projectionFailed,
    lastSuccessAt: workspace.lastSuccessAt, pausedAfterRestore: await userStateRestorePausedInDb(db) };
}

export async function resolveUserStateLedgerConflictInDb(db: UserStateDb, binding: UserStateBinding, input: { id: string; version: string; choice: "local" | "shared"; categoryName?: string }): Promise<void> {
  await assertUserStateAvailableInDb(db);
  const { namespace } = await requireBinding(db, binding);
  const conflict = (await listUserStateConflictsInDb(db, binding)).find(row => row.id === input.id);
  if (!conflict || conflict.version !== input.version) throw new Error("This conflict changed. Review its current values before resolving it.");
  const key = userStateEntityKey(conflict.entity);
  if (input.choice === "local") {
    const trimmedCategoryName = conflict.entity.kind === "category" && input.categoryName !== undefined
      ? input.categoryName.trim()
      : undefined;
    if (trimmedCategoryName !== undefined && !trimmedCategoryName) {
      throw new Error("Provide a category name before resolving this conflict.");
    }
    const value = trimmedCategoryName !== undefined
      ? { ...conflict.local as UserStateValueMap["category"], name: trimmedCategoryName } : conflict.local;
    let entity = conflict.entity;
    if (conflict.entity.kind === "category" && trimmedCategoryName !== undefined) {
      const categoryId = await resolveCategoryAlias(db, namespace, conflict.entity.categoryId);
      await db.execute(
        "UPDATE category SET name=$2 WHERE is_system=0 AND id=(SELECT local_id FROM user_state_category WHERE category_id IN ($1,$3) ORDER BY rowid LIMIT 1) AND NOT EXISTS(SELECT 1 FROM category existing WHERE lower(existing.name)=lower($2) AND existing.id<>category.id)",
        [categoryId, trimmedCategoryName, conflict.entity.categoryId],
      );
    } else if (conflict.entity.kind === "membership" && conflict.reason === "category-deleted") {
      const categoryId = await resolveCategoryAlias(db, namespace, conflict.entity.categoryId);
      const categoryKey = userStateEntityKey({ kind: "category", categoryId });
      const [category] = await db.select<{ payload: string }[]>("SELECT payload FROM user_state_record WHERE namespace=$1 AND entity_key=$2", [namespace, categoryKey]);
      if (!category) throw new Error("The deleted category must be downloaded before it can be restored.");
      const record = parseUserStateRecord(JSON.parse(category.payload));
      await recordUserStateChangesInDb(db, [{ entity: record.entity, value: { ...record.value as UserStateValueMap["category"], ...(input.categoryName === undefined ? {} : { name: input.categoryName.trim() }), deleted: false } }]);
      await db.execute("UPDATE user_state_progress SET base_revision=$3 WHERE namespace=$1 AND entity_key=$2", [namespace, categoryKey, record.revision]);
    } else if (conflict.entity.kind === "membership" && conflict.reason === "category-missing") {
      const categoryId = await resolveCategoryAlias(db, namespace, conflict.entity.categoryId);
      const [localCategory] = await db.select<{ name: string; sort: number }[]>(
        "SELECT c.name,c.sort FROM category c JOIN user_state_category m ON m.local_id=c.id WHERE m.category_id IN ($1,$2) ORDER BY m.rowid LIMIT 1",
        [categoryId, conflict.entity.categoryId],
      );
      const name = (input.categoryName ?? localCategory?.name ?? conflict.categoryName ?? "").trim();
      if (!name) throw new Error("Provide a category name before recreating the missing category.");
      const categoryEntity: UserStateEntity = { kind: "category", categoryId };
      await recordUserStateChangesInDb(db, [{ entity: categoryEntity, value: { name, sort: localCategory?.sort ?? 0, deleted: false } }]);
      await db.execute("UPDATE user_state_progress SET base_revision=0 WHERE namespace=$1 AND entity_key=$2", [namespace, userStateEntityKey(categoryEntity)]);
    } else if ((conflict.entity.kind === "reading" || conflict.entity.kind === "bookmark") && conflict.reason === "chapter-ownership-conflict") {
      const [localChapter] = await db.select<UserChapterRow[]>(
        USER_CHAPTER_SELECT + " WHERE n.plugin_id=$1 AND (CASE WHEN $2 IS NULL THEN n.path=$3 ELSE lower(n.source_novel_id)=lower($2) END) AND c.path=$4 LIMIT 1",
        [conflict.entity.work.pluginId, conflict.entity.work.sourceNovelId, conflict.entity.work.novelPath, conflict.entity.chapter.chapterPath],
      );
      if (localChapter) {
        entity = { ...conflict.entity, work: chapterWork(localChapter), chapter: chapterReference(localChapter) };
      } else if (conflict.shared && (conflict.shared.entity.kind === "reading" || conflict.shared.entity.kind === "bookmark")) {
        entity = { ...conflict.entity, chapter: conflict.shared.entity.chapter };
      }
    }
    await recordUserStateChangesInDb(db, [{ entity, value }]);
    await db.execute("UPDATE user_state_progress SET base_revision=$3 WHERE namespace=$1 AND entity_key=$2", [namespace, userStateEntityKey(entity), conflict.shared?.revision ?? 0]);
  } else {
    if (conflict.entity.kind === "category" && conflict.shared?.entity.kind === "category") {
      const categoryId = await resolveCategoryAlias(db, namespace, conflict.entity.categoryId);
      const sharedValue = conflict.shared.value as UserStateValueMap["category"];
      if (sharedValue.deleted) {
        await db.execute("DELETE FROM category WHERE is_system=0 AND id=(SELECT local_id FROM user_state_category WHERE category_id IN ($1,$2) ORDER BY rowid LIMIT 1)", [categoryId, conflict.entity.categoryId]);
      } else {
        await db.execute(
          "UPDATE category SET name=$2,sort=$3 WHERE is_system=0 AND id=(SELECT local_id FROM user_state_category WHERE category_id IN ($1,$4) ORDER BY rowid LIMIT 1) AND NOT EXISTS(SELECT 1 FROM category existing WHERE lower(existing.name)=lower($2) AND existing.id<>category.id)",
          [categoryId, sharedValue.name, sharedValue.sort, conflict.entity.categoryId],
        );
      }
    }
    await db.execute("UPDATE user_state_progress SET acknowledged_sequence=local_sequence,base_revision=$3 WHERE namespace=$1 AND entity_key=$2", [namespace, key, conflict.shared?.revision ?? 0]);
    if (conflict.shared) await db.execute("UPDATE user_state_record SET applied_revision=0,deferred_reason=NULL,deferred_detail=NULL WHERE namespace=$1 AND entity_key=$2", [namespace, userStateEntityKey(conflict.shared.entity)]);
  }
  if (conflict.entity.kind === "category" || conflict.entity.kind === "membership") {
    await db.execute("UPDATE user_state_record SET applied_revision=0,deferred_reason=NULL,deferred_detail=NULL WHERE namespace=$1 AND deferred_reason IN ('category-name-conflict','missing-category')", [namespace]);
  }
  await db.execute("DELETE FROM user_state_conflict WHERE namespace=$1 AND id=$2", [namespace, input.id]);
}

async function clearNamespaceLedgerInDb(db: UserStateDb, namespace: string): Promise<void> {
  for (const table of [
    "user_state_conflict",
    "user_state_operation",
    "user_state_record",
    "user_state_progress",
    "user_state_alias",
  ]) {
    await db.execute(`DELETE FROM ${table} WHERE namespace=$1`, [namespace]);
  }
}

export async function rebindUserStateWorkspaceInDb(
  db: UserStateDb,
  binding: UserStateBinding,
  mode: UserStateRebindMode,
  options: { headRevision?: number; seedCutoffMs?: number | null; seedAllowed?: boolean } = {},
): Promise<void> {
  await assertUserStateAvailableInDb(db);
  if (!binding.serverUrl || !binding.workspaceId || !binding.epoch) {
    throw new Error("A complete personal state workspace is required.");
  }
  if (options.headRevision !== undefined && options.headRevision < 0) {
    throw new Error("Workspace head revision must be non-negative.");
  }
  const seedCutoffMs = options.seedCutoffMs ?? null;
  if (seedCutoffMs !== null && seedCutoffMs < 0) {
    throw new Error("Seed cutoff time must be non-negative.");
  }

  const newNs = namespaceFor(binding);
  const existing = (await workspaceRows(db)).find(row => row.serverUrl === binding.serverUrl);
  const readyKey = "user-state-delta-ready:" + newNs;

  if (mode === "reseed" && existing && existing.namespace === newNs && existing.seedSuppressed === 0) {
    const [ready] = await db.select<{ ready: number }[]>(
      "SELECT COUNT(*) AS ready FROM content_sync_cache WHERE cache_key=$1",
      [readyKey],
    );
    if (ready?.ready) {
      if (options.seedAllowed !== undefined || options.seedCutoffMs !== undefined) {
        await db.execute("UPDATE user_state_workspace SET seed_cutoff_at=$2 WHERE namespace=$1", [newNs, seedCutoffMs]);
      }
      return;
    }
  }

  const namespacesToClear = [newNs];
  if (existing && existing.namespace !== newNs) namespacesToClear.push(existing.namespace);
  for (const ns of namespacesToClear) {
    await clearNamespaceLedgerInDb(db, ns);
    await db.execute("DELETE FROM content_sync_cache WHERE cache_key=$1", ["user-state-delta-ready:" + ns]);
  }

  await db.execute(
    "DELETE FROM user_state_intent WHERE NOT EXISTS (SELECT 1 FROM user_state_progress p WHERE p.entity_key=user_state_intent.entity_key)",
  );

  const cursor = mode === "reseed" ? 0 : (options.headRevision ?? 0);
  const seedSuppressed = mode === "start_fresh" ? 1 : 0;
  await db.execute(
    `INSERT INTO user_state_workspace(server_url,namespace,workspace_id,epoch,cursor,read_through,last_success_at,seed_suppressed,seed_cutoff_at)
     VALUES($1,$2,$3,$4,$5,NULL,NULL,$6,$7)
     ON CONFLICT(server_url) DO UPDATE SET
       namespace=excluded.namespace,
       workspace_id=excluded.workspace_id,
       epoch=excluded.epoch,
       cursor=excluded.cursor,
       read_through=NULL,
       last_success_at=NULL,
       seed_suppressed=excluded.seed_suppressed,
       seed_cutoff_at=excluded.seed_cutoff_at`,
    [binding.serverUrl, newNs, binding.workspaceId, binding.epoch, cursor, seedSuppressed, seedCutoffMs],
  );

  await purgeAndSettleLocalUserStateInDb(db);

  if (mode === "reseed" && options.seedAllowed !== false) {
    await seedUserStateInDb(db, { seedAllowed: true, seedCutoffMs });
    await insertSeedProgressForIntentsInDb(db, newNs, seedCutoffMs);
  }

  await db.execute("INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO NOTHING", [
    readyKey,
    JSON.stringify({ version: 1 }),
  ]);
}

function canonicalTombstoneForEntity(entity: UserStateEntity, prevValue: UserStateValue): UserStateValue | null {
  switch (entity.kind) {
    case "library":
      return { inLibrary: false, addedAt: null };
    case "category": {
      const prevName = (prevValue as UserStateValueMap["category"]).name;
      return { name: prevName?.trim() ? prevName : "Deleted", sort: 0, deleted: true };
    }
    case "membership":
      return { included: false };
    case "reading":
      return { progress: 0, unread: true, readAt: null };
    case "bookmark":
      return { bookmarked: false };
    case "resume":
      return { chapter: null, anchor: null, openedAt: null };
    default:
      return null;
  }
}

async function rebasePendingProgressToZeroInDb(db: UserStateDb, namespace: string, record: UserStateRecord): Promise<void> {
  const key = userStateEntityKey(record.entity);
  await db.execute("UPDATE user_state_progress SET base_revision=0 WHERE namespace=$1 AND entity_key=$2", [namespace, key]);
  await db.execute("DELETE FROM user_state_operation WHERE namespace=$1 AND entity_key=$2 AND status='pending'", [namespace, key]);
  if ("categoryId" in record.entity) {
    const rows = await db.select<IntentRow[]>(
      `SELECT i.sequence,i.entity_key AS entityKey,i.entity_json AS entityJson,i.value_json AS valueJson,i.seed
       FROM user_state_intent i JOIN user_state_progress p ON p.entity_key=i.entity_key AND p.namespace=$1
       WHERE i.seed=0 AND p.base_revision<>$3 AND i.sequence>p.acknowledged_sequence
         AND json_extract(i.entity_json,'$.kind')=$2`,
      [namespace, record.entity.kind, USER_STATE_PRELINK_BASE_REVISION],
    );
    for (const row of rows) {
      const intent = intentFromRow(row);
      const canonical = await canonicalEntity(db, namespace, intent.entity);
      if (userStateEntityKey(canonical) === key) {
        await db.execute("UPDATE user_state_progress SET base_revision=0 WHERE namespace=$1 AND entity_key=$2", [
          namespace,
          row.entityKey,
        ]);
        await db.execute("DELETE FROM user_state_operation WHERE namespace=$1 AND entity_key=$2 AND status='pending'", [
          namespace,
          row.entityKey,
        ]);
      }
    }
  }
}

async function clearNonPendingOrSeedIntentInDb(
  db: UserStateDb,
  namespace: string,
  entityKey: string,
  removeAnySeed: boolean,
): Promise<void> {
  await db.execute(
    `DELETE FROM user_state_operation
     WHERE namespace=$1 AND entity_key=$2
       AND (status<>'pending' OR ($3=1 AND json_extract(payload,'$.seed')=1))`,
    [namespace, entityKey, removeAnySeed ? 1 : 0],
  );
  await db.execute(
    `DELETE FROM user_state_progress
     WHERE namespace=$1 AND entity_key=$2
       AND (
         base_revision=$3
         OR acknowledged_sequence>=local_sequence
         OR ($4=1 AND EXISTS (SELECT 1 FROM user_state_intent i WHERE i.entity_key=user_state_progress.entity_key AND i.seed=1))
       )`,
    [namespace, entityKey, USER_STATE_PRELINK_BASE_REVISION, removeAnySeed ? 1 : 0],
  );
  await db.execute(
    "DELETE FROM user_state_intent WHERE entity_key=$1 AND NOT EXISTS (SELECT 1 FROM user_state_progress p WHERE p.entity_key=user_state_intent.entity_key)",
    [entityKey],
  );
}

export async function reconcileUserStateSnapshotInDb(
  db: UserStateDb,
  binding: UserStateBinding,
  input: {
    records: readonly UserStateRecord[];
    snapshotRevision: number;
    seedAllowed?: boolean;
    seedCutoffMs?: number | null;
  },
): Promise<UserStateApplyEffects> {
  await assertUserStateAvailableInDb(db);
  if (!Number.isSafeInteger(input.snapshotRevision) || input.snapshotRevision < 0) {
    throw new Error("Snapshot revision must be non-negative.");
  }
  const seedCutoffMs = input.seedCutoffMs ?? null;
  if (seedCutoffMs !== null && seedCutoffMs < 0) {
    throw new Error("Seed cutoff time must be non-negative.");
  }
  const ws = await requireBinding(db, binding);

  const snapshotRecords = input.records.map(parseUserStateRecord);
  const snapshotKeys = new Set(snapshotRecords.map(rec => userStateEntityKey(rec.entity)));

  const heldSources = await loadCurrentHeldSourcesInDb(db, binding.serverUrl);
  const dirtyBefore = await db.select<{ pluginId: string; path: string }[]>(
    "SELECT plugin_id AS pluginId,path FROM work_metadata_dirty ORDER BY plugin_id,path",
  );
  const existingRows = await db.select<{ entityKey: string; payload: string }[]>(
    "SELECT entity_key AS entityKey,payload FROM user_state_record WHERE namespace=$1",
    [ws.namespace],
  );
  await promotePrivateWorkIdentitiesInDb(db);
  const privateKeys = new Set(
    (await db.select<{ entityKey: string }[]>("SELECT entity_key AS entityKey FROM user_state_private")).map(
      row => row.entityKey,
    ),
  );

  const effects: UserStateApplyEffects = { resumes: [] };

  for (const row of existingRows) {
    if (snapshotKeys.has(row.entityKey)) continue;
    await db.execute("DELETE FROM user_state_record WHERE namespace=$1 AND entity_key=$2", [ws.namespace, row.entityKey]);
    const rec = parseUserStateRecord(JSON.parse(row.payload));

    if (isLocalUserStateEntity(rec.entity, rec.value)) continue;
    if ("work" in rec.entity && isCurrentWorkHeld(heldSources, rec.entity.work)) {
      await clearNonPendingOrSeedIntentInDb(db, ws.namespace, row.entityKey, true);
      continue;
    }
    if (await hasPendingUserStateForRecordInDb(db, ws.namespace, rec)) {
      await rebasePendingProgressToZeroInDb(db, ws.namespace, rec);
      continue;
    }

    let isPrivateReading = rec.entity.kind === "reading" && (
      privateKeys.has(row.entityKey) ||
      (rec.entity.work.sourceNovelId !== null && privateKeys.has(userStateEntityKey({
        kind: "reading",
        work: { ...rec.entity.work, sourceNovelId: null },
        chapter: rec.entity.chapter,
      })))
    );
    if (!isPrivateReading && rec.entity.kind === "reading" && rec.entity.work.sourceNovelId === null && privateKeys.size > 0) {
      const [localNovel] = await db.select<{ sourceNovelId: string | null }[]>(
        "SELECT source_novel_id AS sourceNovelId FROM novel WHERE plugin_id=$1 AND path=$2 LIMIT 1",
        [rec.entity.work.pluginId, rec.entity.work.novelPath],
      );
      const sourceNovelId = nonEmptySourceId(localNovel?.sourceNovelId);
      if (sourceNovelId) {
        isPrivateReading = privateKeys.has(userStateEntityKey({
          kind: "reading",
          work: { ...rec.entity.work, sourceNovelId },
          chapter: rec.entity.chapter,
        }));
      }
    }
    const preserveLocal =
      (seedCutoffMs !== null && isBeforeSeedCutoff(intentTimestampForCutoff(rec.entity, rec.value), seedCutoffMs)) ||
      isPrivateReading;

    if (!preserveLocal) {
      const tombstoneValue = canonicalTombstoneForEntity(rec.entity, rec.value);
      if (tombstoneValue) {
        try {
          const next = await materializeUserStateRecordInDb(db, ws.namespace, {
            entity: rec.entity,
            value: tombstoneValue,
            revision: Math.max(1, rec.revision),
            operationId: "snapshot-gc-tombstone",
            updatedAt: rec.updatedAt,
            deviceId: rec.deviceId,
            deviceName: rec.deviceName,
          });
          effects.resumes.push(...next.resumes);
        } catch (error) {
          if (!(error instanceof DeferredUserState)) {
            console.warn("[user-state] failed to materialize GC tombstone", error);
          }
        }
      }
    }

    await db.execute("DELETE FROM user_state_conflict WHERE namespace=$1 AND entity_key=$2", [ws.namespace, row.entityKey]);
    await clearNonPendingOrSeedIntentInDb(db, ws.namespace, row.entityKey, true);
  }

  await storeUserStateRecordsInDb(db, ws.namespace, snapshotRecords);

  if (input.seedAllowed === false) {
    await db.execute(
      "DELETE FROM user_state_operation WHERE namespace=$1 AND json_extract(payload,'$.seed')=1",
      [ws.namespace],
    );
    await db.execute(
      `DELETE FROM user_state_progress
       WHERE namespace=$1
         AND (base_revision=$2 OR EXISTS (SELECT 1 FROM user_state_intent i WHERE i.entity_key=user_state_progress.entity_key AND i.seed=1))`,
      [ws.namespace, USER_STATE_PRELINK_BASE_REVISION],
    );
    await db.execute(
      "DELETE FROM user_state_intent WHERE seed=1 AND NOT EXISTS (SELECT 1 FROM user_state_progress p WHERE p.entity_key=user_state_intent.entity_key)",
    );
  }

  await db.execute(
    `DELETE FROM user_state_alias
     WHERE namespace=$1
       AND NOT EXISTS (
         SELECT 1 FROM user_state_record r
         WHERE r.namespace=$1 AND r.entity_key=json_array('category',user_state_alias.canonical_id)
       )`,
    [ws.namespace],
  );

  await db.execute(
    "UPDATE user_state_workspace SET cursor=$2,read_through=NULL,last_success_at=$3,seed_cutoff_at=$4 WHERE namespace=$1",
    [ws.namespace, input.snapshotRevision, Date.now(), seedCutoffMs],
  );

  await db.execute("DELETE FROM work_metadata_dirty");
  if (dirtyBefore.length) {
    await db.execute(
      `INSERT INTO work_metadata_dirty(plugin_id,path)
       SELECT json_extract(value,'$.pluginId'),json_extract(value,'$.path') FROM json_each($1) WHERE true
       ON CONFLICT(plugin_id,path) DO NOTHING`,
      [JSON.stringify(dirtyBefore)],
    );
  }

  return effects;
}

export async function applyLocalUserStateRetentionInDb(
  db: UserStateDb,
  options: { pruneNonLibraryDays?: number | null; stripTimestampsDays?: number | null; nowMs?: number } = {},
): Promise<number> {
  const pruneDays = options.pruneNonLibraryDays ?? null;
  const stripDays = options.stripTimestampsDays ?? null;
  if (pruneDays !== null && (!Number.isSafeInteger(pruneDays) || pruneDays < 1)) {
    throw new Error("Non-library retention days must be at least 1.");
  }
  if (stripDays !== null && (!Number.isSafeInteger(stripDays) || stripDays < 1)) {
    throw new Error("Reading timestamp retention days must be at least 1.");
  }
  if (pruneDays === null && stripDays === null) return 0;

  const hasSchema = await hasUserStateSchema(db);
  let privateKeys = new Set<string>();
  if (hasSchema) {
    await promotePrivateWorkIdentitiesInDb(db);
    privateKeys = new Set(
      (await db.select<{ entityKey: string }[]>("SELECT entity_key AS entityKey FROM user_state_private")).map(
        row => row.entityKey,
      ),
    );
  }

  const nowMs = options.nowMs ?? Date.now();
  let affected = 0;
  const touchedNovels = new Set<number>();
  const publicTouchedNovels = new Set<number>();

  // Run 2-A (prune non-library) before 2-B (strip timestamps) so 2-B does not clear read_at
  // before 2-A checks older non-library chapters when both policies are enabled together.
  if (pruneDays !== null) {
    const cutoffMs = nowMs - pruneDays * 86_400_000;
    const rows = await db.select<UserChapterRow[]>(
      USER_CHAPTER_SELECT + " WHERE n.in_library=0 AND n.plugin_id<>'local' AND n.is_local=0 AND c.read_at IS NOT NULL",
    );
    const targetRows = rows.filter(row => isBeforeSeedCutoff(row.readAt, cutoffMs));
    if (targetRows.length) {
      const ids = targetRows.map(row => row.id);
      const publicRows: UserChapterRow[] = [];
      for (const row of targetRows) {
        touchedNovels.add(row.novelId);
        const key = hasSchema
          ? userStateEntityKey({ kind: "reading", work: chapterWork(row), chapter: chapterReference(row) })
          : "";
        if (!hasSchema || !privateKeys.has(key)) {
          publicTouchedNovels.add(row.novelId);
          publicRows.push({ ...row, progress: 0, unread: 1, readAt: null });
        }
      }
      const res = await db.execute(
        "UPDATE chapter SET progress=0,unread=1,read_at=NULL,updated_at=unixepoch() WHERE id IN (SELECT value FROM json_each($1))",
        [JSON.stringify(ids)],
      );
      affected += res.rowsAffected;
      if (hasSchema && publicRows.length) {
        await recordChapterRowsInDb(db, publicRows, "reading", false);
      }
    }
  }

  if (stripDays !== null) {
    const cutoffMs = nowMs - stripDays * 86_400_000;
    const rows = await db.select<UserChapterRow[]>(
      USER_CHAPTER_SELECT + " WHERE n.plugin_id<>'local' AND n.is_local=0 AND c.read_at IS NOT NULL",
    );
    const targetRows = rows.filter(row => isBeforeSeedCutoff(row.readAt, cutoffMs));
    if (targetRows.length) {
      const ids = targetRows.map(row => row.id);
      const publicRows: UserChapterRow[] = [];
      for (const row of targetRows) {
        touchedNovels.add(row.novelId);
        const key = hasSchema
          ? userStateEntityKey({ kind: "reading", work: chapterWork(row), chapter: chapterReference(row) })
          : "";
        if (!hasSchema || !privateKeys.has(key)) {
          publicTouchedNovels.add(row.novelId);
          publicRows.push({ ...row, readAt: null });
        }
      }
      const res = await db.execute(
        "UPDATE chapter SET read_at=NULL,updated_at=unixepoch() WHERE id IN (SELECT value FROM json_each($1))",
        [JSON.stringify(ids)],
      );
      affected += res.rowsAffected;
      if (hasSchema && publicRows.length) {
        await recordChapterRowsInDb(db, publicRows, "reading", false);
      }
    }
  }

  if (touchedNovels.size) {
    const novelIds = [...touchedNovels];
    const encoded = JSON.stringify(novelIds);
    await db.execute(
      "UPDATE novel SET last_read_at=(SELECT MAX(read_at) FROM chapter WHERE novel_id=novel.id),updated_at=unixepoch() WHERE id IN (SELECT value FROM json_each($1))",
      [encoded],
    );
    if (hasSchema && publicTouchedNovels.size) {
      const publicIds = [...publicTouchedNovels];
      const encodedPublic = JSON.stringify(publicIds);
      let clearedIds: number[];
      if (privateKeys.size === 0) {
        const cleared = await db.select<{ id: number }[]>(
          "SELECT id FROM novel WHERE id IN (SELECT value FROM json_each($1)) AND last_read_at IS NULL",
          [encodedPublic],
        );
        clearedIds = cleared.map(r => r.id);
      } else {
        const remaining = await db.select<UserChapterRow[]>(
          USER_CHAPTER_SELECT + " WHERE c.novel_id IN (SELECT value FROM json_each($1)) AND c.read_at IS NOT NULL",
          [encodedPublic],
        );
        const novelsWithPublicReadAt = new Set<number>();
        for (const row of remaining) {
          const key = userStateEntityKey({
            kind: "reading",
            work: chapterWork(row),
            chapter: chapterReference(row),
          });
          if (!privateKeys.has(key)) {
            novelsWithPublicReadAt.add(row.novelId);
          }
        }
        clearedIds = publicIds.filter(id => !novelsWithPublicReadAt.has(id));
      }
      if (clearedIds.length) {
        await recordResumeClearedInDb(db, clearedIds);
      }
    }
  }

  return affected;
}
