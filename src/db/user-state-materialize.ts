import { getChapterComposition, materializeChapterComposition, setChapterComposition } from "./chapter-composition";
import {
  canonicalEntity, intentFromRow, resolveCategoryAlias, USER_STATE_PRELINK_BASE_REVISION,
  type IntentRow, type UserStateDb, promotePrivateWorkIdentitiesInDb,
} from "./user-state-core";
import {
  parseUserStateRecord, userStateEntityKey, type UserStateApplyEffects, type UserStateChapterReference,
  type UserStateRecord, type UserStateValueMap, type UserStateWorkReference,
} from "../lib/user-state/types";
import { mergeUserStateComposition } from "../lib/user-state/composition";
import { parseStoredChapterPath } from "../lib/user-state/stored-chapter";
import { resolveStoredChapterReferenceInDb } from "./user-state-stored-chapter";
import type { ChapterCompositionV1 } from "../lib/chapter-composition";

export class DeferredUserState extends Error {
  constructor(readonly reason: string, detail?: string) { super(detail ?? reason); }
}
interface LocalWork { id: number; pluginId: string; sourceNovelId: string | null; path: string }
export async function findUserStateWorkInDb(db: UserStateDb, work: UserStateWorkReference): Promise<LocalWork | null> {
  const rows = work.sourceNovelId === null
    ? await db.select<LocalWork[]>(
      "SELECT id,plugin_id AS pluginId,source_novel_id AS sourceNovelId,path FROM novel WHERE plugin_id=$1 AND path=$2",
      [work.pluginId, work.novelPath])
    : await db.select<LocalWork[]>(
      "SELECT id,plugin_id AS pluginId,source_novel_id AS sourceNovelId,path FROM novel WHERE plugin_id=$1 AND lower(source_novel_id)=lower($2)",
      [work.pluginId, work.sourceNovelId]);
  if (rows.length > 1) throw new DeferredUserState("ambiguous-work-identity");
  return rows[0] ?? null;
}
async function findChapter(db: UserStateDb, novelId: number, chapter: UserStateChapterReference): Promise<number> {
  if (parseStoredChapterPath(chapter.chapterPath)) {
    const id = await resolveStoredChapterReferenceInDb(db, novelId, chapter);
    if (id === null) throw new DeferredUserState("stored-chapter-mismatch");
    return id;
  }
  if (/^(?:norea|local)-folder:/.test(chapter.chapterPath)) throw new DeferredUserState("missing-chapter-identity");
  const [row] = await db.select<{ id: number }[]>("SELECT id FROM chapter WHERE novel_id=$1 AND path=$2", [novelId, chapter.chapterPath]);
  if (!row) throw new DeferredUserState("missing-chapter");
  if (/^norea-(?:composed|source):/.test(chapter.chapterPath)) {
    const [entry] = await db.select<{ id: string }[]>(`SELECT json_extract(entry.value,'$.id') AS id
      FROM novel_chapter_composition c,json_each(c.payload,'$.entries') entry
      WHERE c.novel_id=$1 AND json_extract(entry.value,'$.path')=$2`, [novelId, chapter.chapterPath]);
    if (!chapter.compositionEntryId || entry?.id !== chapter.compositionEntryId) throw new DeferredUserState("chapter-ownership-mismatch");
  }
  return row.id;
}

/** Kept separate so source refresh and a personal document can be combined before ownership validation. */
export async function applySharedCompositionInDb(db: UserStateDb, novelId: number, shared: ChapterCompositionV1, namespace = ""): Promise<UserStateApplyEffects> {
  const current = await getChapterComposition(db, novelId);
  const [work] = await db.select<{ pluginId: string; sourceNovelId: string | null }[]>("SELECT plugin_id AS pluginId,source_novel_id AS sourceNovelId FROM novel WHERE id=$1", [novelId]);
  if (!work?.sourceNovelId) throw new DeferredUserState("missing-work-identity");
  const composition = mergeUserStateComposition(shared, current, { pluginId: work.pluginId, sourceNovelId: work.sourceNovelId });
  await materializeChapterComposition(db, novelId, composition);
  await setChapterComposition(db, novelId, composition);
  return reapplyComposedChapterUserStateInDb(db, namespace, { pluginId: work.pluginId, sourceNovelId: work.sourceNovelId });
}

export async function hasPendingUserStateForRecordInDb(db: UserStateDb, namespace: string, record: UserStateRecord): Promise<boolean> {
  const key = userStateEntityKey(record.entity);
  const [direct] = await db.select<{ present: number }[]>(`SELECT 1 AS present FROM user_state_intent i
    JOIN user_state_progress p ON p.entity_key=i.entity_key AND p.namespace=$1
    WHERE i.entity_key=$2 AND i.seed=0 AND p.base_revision<>$3
      AND i.sequence>p.acknowledged_sequence`, [namespace, key, USER_STATE_PRELINK_BASE_REVISION]);
  if (direct) return true;
  if (!("categoryId" in record.entity)) return false;
  const rows = await db.select<IntentRow[]>(`SELECT i.sequence,i.entity_key AS entityKey,i.entity_json AS entityJson,i.value_json AS valueJson,i.seed
    FROM user_state_intent i JOIN user_state_progress p ON p.entity_key=i.entity_key AND p.namespace=$1
    WHERE i.seed=0 AND p.base_revision<>$3 AND i.sequence>p.acknowledged_sequence
      AND json_extract(i.entity_json,'$.kind')=$2`, [namespace, record.entity.kind, USER_STATE_PRELINK_BASE_REVISION]);
  for (const row of rows) if (userStateEntityKey(await canonicalEntity(db, namespace, intentFromRow(row).entity)) === key) return true;
  return false;
}

async function categoryLocalIdInDb(db: UserStateDb, namespace: string, categoryId: string): Promise<number | null> {
  const canonical = await resolveCategoryAlias(db, namespace, categoryId);
  const owners = await db.select<{ localId: number }[]>(`WITH RECURSIVE owners(category_id) AS (
    SELECT $2 UNION SELECT a.alias_id FROM user_state_alias a JOIN owners o ON a.canonical_id=o.category_id WHERE a.namespace=$1)
    SELECT DISTINCT m.local_id AS localId FROM user_state_category m JOIN owners o ON o.category_id=m.category_id
    JOIN category c ON c.id=m.local_id`, [namespace, canonical]);
  if (owners.length > 1) throw new DeferredUserState("ambiguous-category-identity");
  const localId = owners[0]?.localId ?? null;
  if (localId !== null) await db.execute("INSERT INTO user_state_category(category_id,local_id) VALUES($1,$2) ON CONFLICT(category_id) DO UPDATE SET local_id=excluded.local_id WHERE local_id IS NULL", [canonical, localId]);
  return localId;
}

export async function materializeUserStateRecordInDb(db: UserStateDb, namespace: string, record: UserStateRecord): Promise<UserStateApplyEffects> {
  const { entity } = record;
  const effects: UserStateApplyEffects = { resumes: [] };
  if (entity.kind === "category") {
    const value = record.value as UserStateValueMap["category"];
    const categoryId = await resolveCategoryAlias(db, namespace, entity.categoryId);
    const mappedId = await categoryLocalIdInDb(db, namespace, categoryId);
    if (value.deleted) {
      if (mappedId) await db.execute("DELETE FROM category WHERE id=$1 AND is_system=0", [mappedId]);
      await db.execute("INSERT INTO user_state_category(category_id) VALUES($1) ON CONFLICT(category_id) DO NOTHING", [categoryId]);
      return effects;
    }
    const [collision] = await db.select<{ id: number }[]>("SELECT id FROM category WHERE name=$1", [value.name]);
    if (collision && collision.id !== mappedId) {
      // Existing baselines can share the same exact-name category until their seed receipt supplies the alias.
      const [baseline] = await db.select<{ categoryId: string }[]>(`SELECT m.category_id AS categoryId FROM user_state_category m
        JOIN user_state_intent i ON json_extract(i.entity_json,'$.kind')='category' AND json_extract(i.entity_json,'$.categoryId')=m.category_id
        JOIN user_state_progress p ON p.entity_key=i.entity_key AND p.namespace=$2
        WHERE m.local_id=$1 AND m.category_id LIKE 'legacy-%' AND i.seed=1 AND i.sequence>p.acknowledged_sequence`, [collision.id, namespace]);
      if (!mappedId && baseline) {
        await db.execute("INSERT INTO user_state_category(category_id,local_id) VALUES($1,$2) ON CONFLICT(category_id) DO UPDATE SET local_id=excluded.local_id", [categoryId, collision.id]);
        await db.execute("UPDATE category SET sort=$2 WHERE id=$1", [collision.id, value.sort]);
        return effects;
      }
      throw new DeferredUserState("category-name-conflict", value.name);
    }
    if (mappedId) await db.execute("UPDATE category SET name=$2,sort=$3 WHERE id=$1 AND is_system=0", [mappedId, value.name, value.sort]);
    else {
      const result = await db.execute("INSERT INTO category(name,sort,is_system) VALUES($1,$2,0)", [value.name, value.sort]);
      await db.execute("INSERT INTO user_state_category(category_id,local_id) VALUES($1,$2) ON CONFLICT(category_id) DO UPDATE SET local_id=excluded.local_id", [categoryId, result.lastInsertId]);
    }
    return effects;
  }
  const work = await findUserStateWorkInDb(db, entity.work);
  // Shared user state is authoritative user data, not a content catalog. Never
  // invent a local novel/chapter just to project it. The durable record remains
  // stored and deferUserStateForNovelInDb() re-opens this projection when exact
  // content metadata later appears.
  if (!work) throw new DeferredUserState("missing-work");
  switch (entity.kind) {
    case "library": {
      const value = record.value as UserStateValueMap["library"];
      await db.execute("UPDATE novel SET in_library=$2,library_added_at=$3 WHERE id=$1", [work.id, value.inLibrary ? 1 : 0, value.inLibrary ? value.addedAt : null]);
      if (!value.inLibrary) await db.execute("DELETE FROM novel_download_goal WHERE novel_id=$1", [work.id]);
      break;
    }
    case "membership": {
      const value = record.value as UserStateValueMap["membership"];
      const categoryId = await resolveCategoryAlias(db, namespace, entity.categoryId);
      const categoryLocalId = await categoryLocalIdInDb(db, namespace, categoryId);
      const [state] = await db.select<{ payload: string; deletionRevision: number }[]>("SELECT payload,deletion_revision AS deletionRevision FROM user_state_record WHERE namespace=$1 AND entity_key=$2", [namespace, userStateEntityKey({ kind: "category", categoryId })]);
      const deleted = state && (parseUserStateRecord(JSON.parse(state.payload)).value as UserStateValueMap["category"]).deleted;
      if (value.included && (deleted || state && state.deletionRevision >= record.revision)) throw new DeferredUserState("category-deleted");
      if (!categoryLocalId) {
        if (!value.included) return effects;
        throw new DeferredUserState("category-missing");
      }
      if (value.included) await db.execute("INSERT OR IGNORE INTO novel_category(novel_id,category_id) VALUES($1,$2)", [work.id, categoryLocalId]);
      else await db.execute("DELETE FROM novel_category WHERE novel_id=$1 AND category_id=$2", [work.id, categoryLocalId]);
      break;
    }
    case "reading": {
      const chapterId = await findChapter(db, work.id, entity.chapter);
      const value = record.value as UserStateValueMap["reading"];
      await db.execute("UPDATE chapter SET progress=$2,unread=$3,read_at=$4 WHERE id=$1", [chapterId, value.progress, value.unread ? 1 : 0, value.readAt]);
      await db.execute("UPDATE novel SET last_read_at=(SELECT MAX(read_at) FROM chapter WHERE novel_id=$1) WHERE id=$1", [work.id]);
      break;
    }
    case "bookmark": {
      const chapterId = await findChapter(db, work.id, entity.chapter);
      await db.execute("UPDATE chapter SET bookmark=$2 WHERE id=$1", [chapterId, (record.value as UserStateValueMap["bookmark"]).bookmarked ? 1 : 0]);
      break;
    }
    case "resume": {
      const value = record.value as UserStateValueMap["resume"];
      const chapterId = value.chapter ? await findChapter(db, work.id, value.chapter) : null;
      effects.resumes.push({ novelId: work.id, chapterId, anchor: value.anchor, openedAt: value.openedAt });
      break;
    }
    case "composition":
      effects.resumes.push(...(await applySharedCompositionInDb(db, work.id, (record.value as UserStateValueMap["composition"]).composition, namespace)).resumes);
      break;
  }
  return effects;
}

export async function refreshUnattemptedUserStateIdentitiesInDb(db: UserStateDb, novelId?: number): Promise<void> {
  await promotePrivateWorkIdentitiesInDb(db);
  const rows = await db.select<IntentRow[]>("SELECT sequence,entity_key AS entityKey,entity_json AS entityJson,value_json AS valueJson,seed FROM user_state_intent WHERE json_type(entity_json,'$.work')='object' AND json_extract(entity_json,'$.work.sourceNovelId') IS NULL" +
    (novelId === undefined ? "" : " AND json_extract(entity_json,'$.work.pluginId')=(SELECT plugin_id FROM novel WHERE id=$1) AND json_extract(entity_json,'$.work.novelPath')=(SELECT path FROM novel WHERE id=$1)"), novelId === undefined ? [] : [novelId]);
  const works = new Map<string, { sourceNovelId: string | null; name: string } | null>();
  for (const row of rows) {
    const intent = intentFromRow(row);
    if (!("work" in intent.entity)) continue;
    const workKey = JSON.stringify([intent.entity.work.pluginId, intent.entity.work.novelPath]);
    if (!works.has(workKey)) {
      const [row] = await db.select<{ sourceNovelId: string | null; name: string }[]>("SELECT source_novel_id AS sourceNovelId,name FROM novel WHERE plugin_id=$1 AND path=$2", [intent.entity.work.pluginId, intent.entity.work.novelPath]);
      works.set(workKey, row ?? null);
    }
    const work = works.get(workKey);
    if (!work?.sourceNovelId) continue;
    const [attempt] = await db.select<{ present: number }[]>("SELECT 1 AS present FROM user_state_operation WHERE entity_key=$1 LIMIT 1", [row.entityKey]);
    if (attempt) continue; // Null identities never enter the wire; retain unexpected imported data for inspection.
    const entity = { ...intent.entity, work: { ...intent.entity.work, sourceNovelId: work.sourceNovelId, name: work.name } };
    const nextKey = userStateEntityKey(entity);
    await db.execute("DELETE FROM user_state_intent WHERE entity_key=$1", [row.entityKey]);
    await db.execute(`INSERT INTO user_state_intent(sequence,entity_key,entity_json,value_json,seed) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(entity_key) DO UPDATE SET sequence=excluded.sequence,entity_json=excluded.entity_json,value_json=excluded.value_json,seed=excluded.seed
      WHERE excluded.sequence>sequence`, [row.sequence, nextKey, JSON.stringify(entity), row.valueJson, row.seed]);
    await db.execute(`INSERT INTO user_state_progress(namespace,entity_key,local_sequence,acknowledged_sequence,base_revision)
      SELECT namespace,$2,local_sequence,acknowledged_sequence,base_revision FROM user_state_progress WHERE entity_key=$1
      ON CONFLICT(namespace,entity_key) DO UPDATE SET local_sequence=MAX(local_sequence,excluded.local_sequence)`, [row.entityKey, nextKey]);
    await db.execute("DELETE FROM user_state_intent WHERE entity_key=$1", [row.entityKey]);
    await db.execute("DELETE FROM user_state_progress WHERE entity_key=$1", [row.entityKey]);
  }
}

/** The legacy provenance MAX/OR merge cannot override an explicit shared or pending personal reset. */
async function reapplyComposedChapterUserStateInDb(db: UserStateDb, namespace: string, work: { pluginId: string; sourceNovelId: string }): Promise<UserStateApplyEffects> {
  const effects: UserStateApplyEffects = { resumes: [] };
  const records = await db.select<{ payload: string }[]>(`SELECT payload FROM user_state_record WHERE namespace=$1
    AND json_extract(payload,'$.entity.work.pluginId')=$2 AND lower(json_extract(payload,'$.entity.work.sourceNovelId'))=lower($3)
    AND json_extract(payload,'$.entity.kind') IN ('reading','bookmark','resume') ORDER BY revision`, [namespace, work.pluginId, work.sourceNovelId]);
  const effective = new Map<string, { record: UserStateRecord; local: boolean }>();
  for (const row of records) {
    const record = parseUserStateRecord(JSON.parse(row.payload));
    effective.set(userStateEntityKey(record.entity), { record, local: false });
  }
  const intents = await db.select<IntentRow[]>(`SELECT i.sequence,i.entity_key AS entityKey,i.entity_json AS entityJson,i.value_json AS valueJson,i.seed
    FROM user_state_intent i JOIN user_state_progress p ON p.entity_key=i.entity_key AND p.namespace=$1
    WHERE i.seed=0 AND i.sequence>p.acknowledged_sequence AND json_extract(i.entity_json,'$.work.pluginId')=$2
    AND lower(json_extract(i.entity_json,'$.work.sourceNovelId'))=lower($3) AND json_extract(i.entity_json,'$.kind') IN ('reading','bookmark','resume')`, [namespace, work.pluginId, work.sourceNovelId]);
  for (const row of intents) {
    const intent = intentFromRow(row);
    effective.set(row.entityKey, { record: { ...intent, revision: 1, operationId: "local-pending", updatedAt: 0, deviceId: "local", deviceName: "" }, local: true });
  }
  for (const [key, item] of effective) {
    try {
      effects.resumes.push(...(await materializeUserStateRecordInDb(db, namespace, item.record)).resumes);
      if (!item.local) await db.execute("UPDATE user_state_record SET applied_revision=revision,deferred_reason=NULL,deferred_detail=NULL WHERE namespace=$1 AND entity_key=$2", [namespace, key]);
    } catch (error) {
      if (!(error instanceof DeferredUserState)) throw error;
      await db.execute("UPDATE user_state_record SET applied_revision=0,deferred_reason=$3,deferred_detail=$4 WHERE namespace=$1 AND entity_key=$2", [namespace, key, error.reason, error.message]);
    }
  }
  return effects;
}
