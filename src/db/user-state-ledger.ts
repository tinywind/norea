import {
  canonicalUserStateJson, parseUserStateMergeResult, parseUserStateOperation, parseUserStateReadResponse, parseUserStateRecord,
  USER_STATE_CLIENT_BATCH_BYTES, userStateEntityKey, userStateJsonBytes,
  type UserStateBinding, type UserStateConflict, type UserStateDeferred, type UserStateEntity,
  type UserStateMergeResult, type UserStateOperation, type UserStateReadResponse, type UserStateRecord, type UserStateValueMap,
} from "../lib/user-state/types";
import {
  assertUserStateAvailableInDb, canonicalEntity, intentFromRow, namespaceFor, recordUserStateChangesInDb, requireBinding,
  resolveCategoryAlias, seedUserStateInDb, userStateRestorePausedInDb, workspaceRows,
  type IntentRow, type UserStateDb,
} from "./user-state-core";

interface PendingRow extends IntentRow { baseRevision: number; acknowledgedSequence: number }
interface OperationRow { operationId: string; entityKey: string; intentSequence: number; payload: string; status: string; receipt: string | null }
interface StoredRecordRow { entityKey: string; revision: number; payload: string; deletionRevision: number }
const USER_STATE_DB_BATCH_BYTES = 8 * 1024 * 1024;

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
export interface UserStateLedgerStatus { cursor: number; through: number | null; pending: number; conflicts: number; deferred: number; lastSuccessAt: number | null; pausedAfterRestore: boolean }

export async function bindUserStateWorkspaceInDb(db: UserStateDb, binding: UserStateBinding): Promise<void> {
  await assertUserStateAvailableInDb(db);
  if (!binding.serverUrl || !binding.workspaceId || !binding.epoch) throw new Error("A complete personal state workspace is required.");
  const namespace = namespaceFor(binding);
  const existing = (await workspaceRows(db)).find(row => row.serverUrl === binding.serverUrl);
  if (existing) await requireBinding(db, binding);
  else await db.execute("INSERT INTO user_state_workspace(server_url,namespace,workspace_id,epoch) VALUES($1,$2,$3,$4)",
    [binding.serverUrl, namespace, binding.workspaceId, binding.epoch]);

  // Pre-LWW clients could leave compare-and-swap conflicts that permanently block
  // the next explicit edit. The workspace is single-user now, so retry those intents.
  await db.execute("DELETE FROM user_state_conflict WHERE namespace=$1", [namespace]);

  // Current-snapshot clients created only the workspace row. Seed the durable delta
  // outbox once when such a database upgrades, then use record-level intents only.
  const readyKey = "user-state-delta-ready:" + namespace;
  const [ready] = await db.select<{ ready: number }[]>(
    "SELECT COUNT(*) AS ready FROM content_sync_cache WHERE cache_key=$1", [readyKey]);
  if (ready?.ready) return;
  await seedUserStateInDb(db);
  await db.execute(`INSERT INTO user_state_progress(namespace,entity_key,local_sequence)
    SELECT $1,entity_key,sequence FROM user_state_intent WHERE true ON CONFLICT(namespace,entity_key) DO NOTHING`, [namespace]);
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
  const retries = await db.select<OperationRow[]>("SELECT operation_id AS operationId,entity_key AS entityKey,intent_sequence AS intentSequence,payload,status,receipt FROM user_state_operation WHERE namespace=$1 AND status='pending' ORDER BY intent_sequence,operation_id", [namespace]);
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
    const intent = intentFromRow(row);
    if (!allowOpaqueIdentity && unresolvedIntent(intent.entity, intent.value)) continue;
    const operation = parseUserStateOperation({
      operationId: crypto.randomUUID(), entity: await canonicalEntity(db, namespace, intent.entity),
      value: intent.value, baseRevision: row.seed ? 0 : row.baseRevision, ...(row.seed ? { seed: true } : {}),
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
      entityKey: userStateEntityKey(record.entity), revision: record.revision, payload,
      deletionRevision: record.entity.kind === "category" && (record.value as UserStateValueMap["category"]).deleted ? record.revision : 0,
    };
  });
  for (const batch of jsonBatches(rows, row => row.payload.length + row.entityKey.length + 96)) {
    const encoded = JSON.stringify(batch);
    const existing = await db.select<{ entityKey: string; revision: number; payload: string }[]>(`
      SELECT r.entity_key AS entityKey,r.revision,r.payload
      FROM user_state_record r JOIN json_each($2) incoming
        ON r.entity_key=json_extract(incoming.value,'$.entityKey')
      WHERE r.namespace=$1`, [namespace, encoded]);
    const incoming = new Map(batch.map(row => [JSON.stringify([row.entityKey, row.revision]), row.payload]));
    for (const row of existing) {
      const payload = incoming.get(JSON.stringify([row.entityKey, row.revision]));
      if (payload !== undefined && payload !== row.payload) throw new Error("The shared state revision changed its contents.");
    }
    await db.execute(`INSERT INTO user_state_record(namespace,entity_key,revision,payload,deletion_revision)
      SELECT $1,json_extract(value,'$.entityKey'),json_extract(value,'$.revision'),
        json_extract(value,'$.payload'),json_extract(value,'$.deletionRevision')
      FROM json_each($2) WHERE true
      ON CONFLICT(namespace,entity_key) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,
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
      await db.execute("DELETE FROM category WHERE id=$1", [local.localId]);
      await db.execute("UPDATE user_state_category SET local_id=$2 WHERE category_id=$1", [alias.from, target.localId]);
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
    UPDATE user_state_operation AS operation SET status=incoming.status,receipt=incoming.receipt
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
    const reason = unresolvedIntent(intent.entity, intent.value);
    if (reason) result.push({ id: row.entityKey, entity: intent.entity, reason });
  }
  return result;
}
export async function getUserStateLedgerStatusInDb(db: UserStateDb, binding: UserStateBinding): Promise<UserStateLedgerStatus> {
  const workspace = await requireBinding(db, binding);
  const [count] = await db.select<{ pending: number }[]>("SELECT COUNT(*) AS pending FROM user_state_intent i JOIN user_state_progress p ON p.entity_key=i.entity_key WHERE p.namespace=$1 AND i.sequence>p.acknowledged_sequence", [workspace.namespace]);
  const [held] = await db.select<{ deferred: number }[]>("SELECT COUNT(*) AS deferred FROM user_state_intent i JOIN user_state_progress p ON p.entity_key=i.entity_key AND p.namespace=$1 WHERE i.sequence>p.acknowledged_sequence AND ((json_type(i.entity_json,'$.work')='object' AND json_extract(i.entity_json,'$.work.sourceNovelId') IS NULL) OR COALESCE(json_extract(i.entity_json,'$.chapter.chapterPath'),json_extract(i.value_json,'$.chapter.chapterPath'),'') LIKE 'norea-folder:%' OR COALESCE(json_extract(i.entity_json,'$.chapter.chapterPath'),json_extract(i.value_json,'$.chapter.chapterPath'),'') LIKE 'local-folder:%')", [workspace.namespace]);
  return { cursor: workspace.cursor, through: workspace.through, pending: count?.pending ?? 0,
    conflicts: (await listUserStateConflictsInDb(db, binding)).length,
    deferred: held?.deferred ?? 0, lastSuccessAt: workspace.lastSuccessAt, pausedAfterRestore: await userStateRestorePausedInDb(db) };
}

export async function resolveUserStateLedgerConflictInDb(db: UserStateDb, binding: UserStateBinding, input: { id: string; version: string; choice: "local" | "shared"; categoryName?: string }): Promise<void> {
  await assertUserStateAvailableInDb(db);
  const { namespace } = await requireBinding(db, binding);
  const conflict = (await listUserStateConflictsInDb(db, binding)).find(row => row.id === input.id);
  if (!conflict || conflict.version !== input.version) throw new Error("This conflict changed. Review its current values before resolving it.");
  const key = userStateEntityKey(conflict.entity);
  if (input.choice === "local") {
    const value = conflict.entity.kind === "category" && input.categoryName !== undefined
      ? { ...conflict.local as UserStateValueMap["category"], name: input.categoryName.trim() } : conflict.local;
    if (conflict.entity.kind === "membership" && conflict.reason === "category-deleted") {
      const categoryId = await resolveCategoryAlias(db, namespace, conflict.entity.categoryId);
      const categoryKey = userStateEntityKey({ kind: "category", categoryId });
      const [category] = await db.select<{ payload: string }[]>("SELECT payload FROM user_state_record WHERE namespace=$1 AND entity_key=$2", [namespace, categoryKey]);
      if (!category) throw new Error("The deleted category must be downloaded before it can be restored.");
      const record = parseUserStateRecord(JSON.parse(category.payload));
      await recordUserStateChangesInDb(db, [{ entity: record.entity, value: { ...record.value as UserStateValueMap["category"], ...(input.categoryName === undefined ? {} : { name: input.categoryName.trim() }), deleted: false } }]);
      await db.execute("UPDATE user_state_progress SET base_revision=$3 WHERE namespace=$1 AND entity_key=$2", [namespace, categoryKey, record.revision]);
    }
    await recordUserStateChangesInDb(db, [{ entity: conflict.entity, value }]);
    await db.execute("UPDATE user_state_progress SET base_revision=$3 WHERE namespace=$1 AND entity_key=$2", [namespace, key, conflict.shared?.revision ?? 0]);
  } else {
    await db.execute("UPDATE user_state_progress SET acknowledged_sequence=local_sequence,base_revision=$3 WHERE namespace=$1 AND entity_key=$2", [namespace, key, conflict.shared?.revision ?? 0]);
    if (conflict.shared) await db.execute("UPDATE user_state_record SET applied_revision=0,deferred_reason=NULL WHERE namespace=$1 AND entity_key=$2", [namespace, userStateEntityKey(conflict.shared.entity)]);
  }
  await db.execute("DELETE FROM user_state_conflict WHERE namespace=$1 AND id=$2", [namespace, input.id]);
}
