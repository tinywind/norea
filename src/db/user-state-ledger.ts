import {
  canonicalUserStateJson, parseUserStateMergeResult, parseUserStateOperation, parseUserStateReadResponse, parseUserStateRecord,
  USER_STATE_CLIENT_BATCH_BYTES, USER_STATE_MAX_BATCH, userStateEntityKey, userStateJsonBytes,
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
export interface UserStateLedgerStatus { cursor: number; through: number | null; pending: number; conflicts: number; deferred: number; lastSuccessAt: number | null; pausedAfterRestore: boolean }

export async function bindUserStateWorkspaceInDb(db: UserStateDb, binding: UserStateBinding): Promise<void> {
  await assertUserStateAvailableInDb(db);
  if (!binding.serverUrl || !binding.workspaceId || !binding.epoch) throw new Error("A complete personal state workspace is required.");
  const existing = (await workspaceRows(db)).find(row => row.serverUrl === binding.serverUrl);
  if (existing) { await requireBinding(db, binding); return; }
  await db.execute("INSERT INTO user_state_workspace(server_url,namespace,workspace_id,epoch) VALUES($1,$2,$3,$4)",
    [binding.serverUrl, namespaceFor(binding), binding.workspaceId, binding.epoch]);
  await seedUserStateInDb(db);
  await db.execute(`INSERT INTO user_state_progress(namespace,entity_key,local_sequence)
    SELECT $1,entity_key,sequence FROM user_state_intent WHERE true ON CONFLICT(namespace,entity_key) DO NOTHING`, [namespaceFor(binding)]);
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
  db: UserStateDb, binding: UserStateBinding, limits: { limit?: number; maxBytes?: number } = {},
): Promise<UserStateOperation[]> {
  await assertUserStateAvailableInDb(db);
  const { namespace } = await requireBinding(db, binding);
  const limit = Math.max(1, Math.min(USER_STATE_MAX_BATCH, limits.limit ?? USER_STATE_MAX_BATCH));
  const maxBytes = Math.min(USER_STATE_CLIENT_BATCH_BYTES, limits.maxBytes ?? USER_STATE_CLIENT_BATCH_BYTES);
  const result: UserStateOperation[] = [];
  let bytes = userStateJsonBytes({ workspaceId: binding.workspaceId, epoch: binding.epoch, operations: [] });
  const include = (operation: UserStateOperation): boolean => {
    const size = userStateJsonBytes(operation) + 1;
    if (result.length >= limit || bytes + size > maxBytes) return false;
    result.push(operation); bytes += size; return true;
  };
  const retries = await db.select<OperationRow[]>("SELECT operation_id AS operationId,entity_key AS entityKey,intent_sequence AS intentSequence,payload,status,receipt FROM user_state_operation WHERE namespace=$1 AND status='pending' ORDER BY intent_sequence,operation_id", [namespace]);
  for (const row of retries) {
    if (!include(parseUserStateOperation(JSON.parse(row.payload)))) return result;
  }
  const intents = await db.select<PendingRow[]>(`SELECT i.sequence,i.entity_key AS entityKey,i.entity_json AS entityJson,i.value_json AS valueJson,i.seed,
    p.base_revision AS baseRevision,p.acknowledged_sequence AS acknowledgedSequence
    FROM user_state_intent i JOIN user_state_progress p ON p.entity_key=i.entity_key AND p.namespace=$1
    WHERE i.sequence>p.acknowledged_sequence
      AND NOT EXISTS(SELECT 1 FROM user_state_operation o WHERE o.namespace=$1 AND o.entity_key=i.entity_key AND o.status='pending')
      AND NOT EXISTS(SELECT 1 FROM user_state_conflict c WHERE c.namespace=$1 AND c.entity_key=i.entity_key)
      AND (json_type(i.entity_json,'$.work') IS NULL OR json_extract(i.entity_json,'$.work.sourceNovelId') IS NOT NULL)
      AND COALESCE(json_extract(i.entity_json,'$.chapter.chapterPath'),json_extract(i.value_json,'$.chapter.chapterPath'),'') NOT LIKE 'norea-folder:%'
      AND COALESCE(json_extract(i.entity_json,'$.chapter.chapterPath'),json_extract(i.value_json,'$.chapter.chapterPath'),'') NOT LIKE 'local-folder:%'
    ORDER BY CASE json_extract(i.entity_json,'$.kind') WHEN 'category' THEN 0 ELSE 1 END,i.sequence LIMIT $2`, [namespace, limit]);
  for (const row of intents) {
    const intent = intentFromRow(row);
    if (unresolvedIntent(intent.entity, intent.value)) continue;
    const operation = parseUserStateOperation({
      operationId: crypto.randomUUID(), entity: await canonicalEntity(db, namespace, intent.entity),
      value: intent.value, baseRevision: row.seed ? 0 : row.baseRevision, ...(row.seed ? { seed: true } : {}),
    });
    if (!include(operation)) break;
    await db.execute("INSERT INTO user_state_operation(operation_id,namespace,entity_key,intent_sequence,payload) VALUES($1,$2,$3,$4,$5)",
      [operation.operationId, namespace, row.entityKey, row.sequence, canonicalUserStateJson(operation)]);
  }
  return result;
}

export async function storeUserStateRecordInDb(db: UserStateDb, namespace: string, raw: UserStateRecord): Promise<void> {
  const record = parseUserStateRecord(raw);
  const key = userStateEntityKey(record.entity);
  const [existing] = await db.select<{ revision: number; payload: string }[]>("SELECT revision,payload FROM user_state_record WHERE namespace=$1 AND entity_key=$2", [namespace, key]);
  const payload = canonicalUserStateJson(record);
  if (existing?.revision === record.revision && existing.payload !== payload) throw new Error("The shared state revision changed its contents.");
  const deleted = record.entity.kind === "category" && (record.value as UserStateValueMap["category"]).deleted;
  await db.execute(`INSERT INTO user_state_record(namespace,entity_key,revision,payload,deletion_revision)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(namespace,entity_key) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,
    deletion_revision=MAX(deletion_revision,excluded.deletion_revision),deferred_reason=NULL,deferred_detail=NULL
    WHERE excluded.revision>revision`, [namespace, key, record.revision, payload, deleted ? record.revision : 0]);
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
  for (const record of page.records) await storeUserStateRecordInDb(db, workspace.namespace, record);
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
  if (raws.length > USER_STATE_MAX_BATCH) throw new Error("Too many personal state acknowledgements.");
  const results = raws.map(parseUserStateMergeResult);
  if (new Set(results.map(result => result.operationId)).size !== results.length) throw new Error("Duplicate personal state acknowledgements.");
  for (const result of results) {
    const [attempt] = await db.select<OperationRow[]>("SELECT operation_id AS operationId,entity_key AS entityKey,intent_sequence AS intentSequence,payload,status,receipt FROM user_state_operation WHERE namespace=$1 AND operation_id=$2", [namespace, result.operationId]);
    if (!attempt) throw new Error("The personal state receipt does not belong to a pending operation.");
    const receipt = canonicalUserStateJson(result);
    if (attempt.receipt) {
      if (attempt.receipt !== receipt) throw new Error("The personal state receipt changed after acknowledgement.");
      continue;
    }
    const operation = parseUserStateOperation(JSON.parse(attempt.payload));
    if (result.categoryAlias) {
      if (!("categoryId" in operation.entity) || result.categoryAlias.from !== operation.entity.categoryId) throw new Error("The category alias does not match its operation.");
      await rememberAlias(db, namespace, result.categoryAlias);
    }
    const effective = await canonicalEntity(db, namespace, operation.entity);
    if (result.current && userStateEntityKey(result.current.entity) !== userStateEntityKey(effective)) throw new Error("The receipt has a different personal state identity.");
    if (result.current) await storeUserStateRecordInDb(db, namespace, result.current);
    await db.execute("UPDATE user_state_operation SET status=$2,receipt=$3 WHERE operation_id=$1",
      [attempt.operationId, result.status === "conflict" ? "conflict" : "acknowledged", receipt]);
    if (result.status === "conflict") {
      await db.execute("INSERT INTO user_state_conflict(id,namespace,entity_key,reason) VALUES($1,$2,$3,$4) ON CONFLICT(namespace,entity_key) DO UPDATE SET id=excluded.id,reason=excluded.reason",
        [attempt.operationId, namespace, attempt.entityKey, result.reason ?? "revision-mismatch"]);
      continue;
    }
    const [latest] = await db.select<{ revision: number }[]>("SELECT revision FROM user_state_record WHERE namespace=$1 AND entity_key=$2", [namespace, userStateEntityKey(effective)]);
    const equivalentAlias = result.status !== "aliased" || result.current &&
      canonicalUserStateJson(operation.value) === canonicalUserStateJson(result.current.value);
    const canRebase = result.status !== "seed-skipped" && equivalentAlias && result.current && (latest?.revision ?? 0) <= result.current.revision;
    await db.execute(`UPDATE user_state_progress SET acknowledged_sequence=MAX(acknowledged_sequence,$3),
      base_revision=CASE WHEN $4 IS NULL THEN base_revision ELSE $4 END WHERE namespace=$1 AND entity_key=$2`,
    [namespace, attempt.entityKey, attempt.intentSequence, canRebase ? result.current!.revision : null]);
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
  const rows = await db.select<{ entityKey: string; payload: string; reason: string; detail: string | null }[]>(
    "SELECT entity_key AS entityKey,payload,deferred_reason AS reason,deferred_detail AS detail FROM user_state_record WHERE namespace=$1 AND deferred_reason IS NOT NULL", [namespace]);
  const result: UserStateDeferred[] = rows.map(row => ({ id: row.entityKey, entity: parseUserStateRecord(JSON.parse(row.payload)).entity, reason: row.reason, ...(row.detail ? { detail: row.detail } : {}) }));
  const intents = await db.select<IntentRow[]>("SELECT i.sequence,i.entity_key AS entityKey,i.entity_json AS entityJson,i.value_json AS valueJson,i.seed FROM user_state_intent i JOIN user_state_progress p ON p.entity_key=i.entity_key WHERE p.namespace=$1 AND i.sequence>p.acknowledged_sequence", [namespace]);
  for (const row of intents) {
    const intent = intentFromRow(row);
    const reason = unresolvedIntent(intent.entity, intent.value);
    if (reason) result.push({ id: row.entityKey, entity: intent.entity, reason });
  }
  for (const item of result) {
    const name = await categoryNameInDb(db, namespace, item.entity);
    if (name) item.categoryName = name;
  }
  return result;
}
export async function getUserStateLedgerStatusInDb(db: UserStateDb, binding: UserStateBinding): Promise<UserStateLedgerStatus> {
  const workspace = await requireBinding(db, binding);
  const [count] = await db.select<{ pending: number }[]>("SELECT COUNT(*) AS pending FROM user_state_intent i JOIN user_state_progress p ON p.entity_key=i.entity_key WHERE p.namespace=$1 AND i.sequence>p.acknowledged_sequence", [workspace.namespace]);
  return { cursor: workspace.cursor, through: workspace.through, pending: count?.pending ?? 0,
    conflicts: (await listUserStateConflictsInDb(db, binding)).length,
    deferred: (await listUserStateDeferredInDb(db, binding)).length, lastSuccessAt: workspace.lastSuccessAt, pausedAfterRestore: await userStateRestorePausedInDb(db) };
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
