import {
  chapterReference, chapterWork, hasUserStateSchema, intentFromRow, recordUserStateChangesInDb,
  USER_CHAPTER_SELECT, workReferenceInDb, type IntentRow, type UserChapterRow, type UserStateDb, type UserStateIntent,
} from "./user-state-core";
import { currentResumeValues } from "./user-state-current-data";
import { mergeUserStateCurrentResume, parseUserStateCurrentItem } from "../lib/user-state/current-types";
import { DeferredUserState, materializeUserStateRecordInDb } from "./user-state-materialize";
import { userStateEntityKey, userStateWorkKey, type UserStateApplyEffects, type UserStateValueMap } from "../lib/user-state/types";

async function pendingIntents(db: UserStateDb): Promise<IntentRow[]> {
  return db.select<IntentRow[]>(`SELECT i.sequence,i.entity_key AS entityKey,i.entity_json AS entityJson,i.value_json AS valueJson,i.seed FROM user_state_intent i
    WHERE i.seed=0 AND (NOT EXISTS(SELECT 1 FROM user_state_workspace) OR EXISTS(
      SELECT 1 FROM user_state_progress p WHERE p.entity_key=i.entity_key AND i.sequence>p.acknowledged_sequence)) ORDER BY i.sequence`);
}

/** An approved source migration supplies exact source/target row mappings, never a title/number heuristic. */
export async function remapPendingUserStateInDb(db: UserStateDb, sourceNovelId: number, targetNovelId: number, chapterIdMap: Record<number, number>, targetPathSources: Readonly<Record<string, string>> = {}): Promise<UserStateApplyEffects> {
  const effects: UserStateApplyEffects = { resumes: [] };
  if (!await hasUserStateSchema(db)) return effects;
  const source = await workReferenceInDb(db, sourceNovelId);
  const target = await workReferenceInDb(db, targetNovelId);
  if (!source || !target) return effects;
  const chapters = await db.select<UserChapterRow[]>(USER_CHAPTER_SELECT + " WHERE c.novel_id IN ($1,$2)", [sourceNovelId, targetNovelId]);
  const byId = new Map(chapters.map(row => [row.id, row]));
  const bySourcePath = new Map(chapters.filter(row => row.novelId === sourceNovelId).map(row => [row.chapterPath, row]));
  const remapChapter = (path: string) => {
    const original = bySourcePath.get(path);
    return original ? byId.get(chapterIdMap[original.id]) : undefined;
  };
  for (const [sourceId, targetId] of Object.entries(chapterIdMap)) {
    const from = byId.get(Number(sourceId)); const to = byId.get(targetId);
    if (!from || !to) continue;
    await db.execute("INSERT OR IGNORE INTO user_state_private(entity_key,public_value_json) SELECT $2,public_value_json FROM user_state_private WHERE entity_key=$1",
      [userStateEntityKey({ kind: "reading", work: chapterWork(from), chapter: chapterReference(from) }), userStateEntityKey({ kind: "reading", work: chapterWork(to), chapter: chapterReference(to) })]);
  }
  const targetByPath = new Map(chapters.filter(row => row.novelId === targetNovelId).map(row => [row.chapterPath, row]));
  const targetPathsByOldPath = new Map<string, string>();
  for (const [nextPath, oldPath] of Object.entries(targetPathSources)) {
    if (targetPathsByOldPath.has(oldPath) && targetPathsByOldPath.get(oldPath) !== nextPath) throw new Error("The target chapter mapping is ambiguous.");
    const next = targetByPath.get(nextPath);
    if (!next) throw new Error("The approved target chapter mapping no longer exists.");
    targetPathsByOldPath.set(oldPath, nextPath);
    await db.execute("INSERT OR IGNORE INTO user_state_private(entity_key,public_value_json) SELECT $2,public_value_json FROM user_state_private WHERE entity_key=$1",
      [userStateEntityKey({ kind: "reading", work: target, chapter: { chapterPath: oldPath } }), userStateEntityKey({ kind: "reading", work: target, chapter: chapterReference(next) })]);
  }
  const sourceKey = userStateWorkKey(source);
  const targetKey = userStateWorkKey(target);
  if ((await import("./user-state-current")).isUserStateCurrentMode()) {
    const local = await db.select<IntentRow[]>("SELECT sequence,entity_key AS entityKey,entity_json AS entityJson,value_json AS valueJson,seed FROM user_state_intent WHERE json_extract(entity_json,'$.kind')='resume'");
    const shared = await db.select<{ resumes: string | null }[]>("SELECT json_extract(payload,'$.resumes') AS resumes FROM content_sync_cache WHERE cache_key LIKE 'user-state-current-status:%'");
    const publicResumes = currentResumeValues({
      resumes: local.map(row => {
        const intent = intentFromRow(row);
        if (intent.entity.kind === "resume" && intent.entity.work.sourceNovelId === null) {
          const previousWork = intent.entity.work;
          const owner = [source, target].find(work => work.pluginId === previousWork.pluginId && work.novelPath === previousWork.novelPath);
          if (owner) return { ...intent, entity: { kind: "resume" as const, work: owner } };
        }
        return intent;
      }),
      appliedResumes: shared.flatMap(row => row.resumes ? (JSON.parse(row.resumes) as unknown[]).map(parseUserStateCurrentItem) : []),
    });
    let selected: { chapter: UserChapterRow; value: UserStateValueMap["resume"] } | null = null;
    for (const [key, isSource] of [[targetKey, false], [sourceKey, true]] as const) {
      const item = publicResumes.get(key);
      if (!item) continue;
      const value = item.value as UserStateValueMap["resume"];
      if (!value.chapter) continue;
      const original = isSource ? bySourcePath.get(value.chapter.chapterPath) : null;
      const originalReference = original && chapterReference(original);
      if (originalReference?.compositionEntryId && originalReference.compositionEntryId !== value.chapter.compositionEntryId) continue;
      const mapped = isSource ? remapChapter(value.chapter.chapterPath) :
        targetByPath.get(targetPathsByOldPath.get(value.chapter.chapterPath) ?? value.chapter.chapterPath);
      if (!mapped) continue;
      const reference = chapterReference(mapped);
      const unchangedPath = !isSource && reference.chapterPath === value.chapter.chapterPath;
      if (unchangedPath && reference.compositionEntryId && reference.compositionEntryId !== value.chapter.compositionEntryId) continue;
      // Chapter correspondence alone does not prove that A and B retained the same body.
      const next = { ...value, chapter: reference, anchor: isSource ? null : value.anchor };
      if (!selected || mergeUserStateCurrentResume(selected.value, next) === next) selected = { chapter: mapped, value: next };
    }
    if (selected) {
      await recordUserStateChangesInDb(db, [{ entity: { kind: "resume", work: target }, value: selected.value }]);
      effects.resumes.push({ novelId: targetNovelId, chapterId: selected.chapter.id, anchor: selected.value.anchor, openedAt: selected.value.openedAt });
    }
    return effects;
  }
  const latest = new Map<string, { intent: UserStateIntent; sequence: number; from: string | null; rewrite: boolean }>();
  for (const row of await pendingIntents(db)) {
    const intent = intentFromRow(row);
    if (!("work" in intent.entity)) continue;
    const workKey = userStateWorkKey(intent.entity.work);
    if (workKey !== sourceKey && workKey !== targetKey) continue;
    if (intent.entity.kind === "composition") continue;
    let mapped = intent;
    if (workKey === sourceKey) {
      if (intent.entity.kind === "reading" || intent.entity.kind === "bookmark") {
        const chapter = remapChapter(intent.entity.chapter.chapterPath);
        if (!chapter) continue; // A genuinely unmapped change remains in the ledger.
        mapped = { ...intent, entity: { ...intent.entity, work: target, chapter: chapterReference(chapter) } };
      } else if (intent.entity.kind === "resume") {
        const value = intent.value as UserStateValueMap["resume"];
        const chapter = value.chapter ? remapChapter(value.chapter.chapterPath) : null;
        if (value.chapter && !chapter) continue;
        mapped = { entity: { kind: "resume", work: target }, value: { ...value, chapter: chapter ? chapterReference(chapter) : null } };
      } else mapped = { ...intent, entity: { ...intent.entity, work: target } };
    } else if (intent.entity.kind === "reading" || intent.entity.kind === "bookmark") {
      const path = targetPathsByOldPath.get(intent.entity.chapter.chapterPath);
      if (path) mapped = { ...intent, entity: { ...intent.entity, chapter: chapterReference(targetByPath.get(path)!) } };
    } else if (intent.entity.kind === "resume") {
      const value = intent.value as UserStateValueMap["resume"];
      const path = value.chapter && targetPathsByOldPath.get(value.chapter.chapterPath);
      if (path) mapped = { ...intent, value: { ...value, chapter: chapterReference(targetByPath.get(path)!) } };
    }
    const key = userStateEntityKey(mapped.entity);
    const previous = latest.get(key);
    if (!previous || previous.sequence < row.sequence) latest.set(key, { intent: mapped, sequence: row.sequence, from: key === row.entityKey ? null : row.entityKey, rewrite: mapped !== intent });
  }
  for (const item of latest.values()) {
    // Replay the actual pending value after the legacy preservation MAX/OR merge.
    try {
      const result = await materializeUserStateRecordInDb(db, "", {
        ...item.intent, revision: Number.MAX_SAFE_INTEGER, operationId: "local-migration", updatedAt: 0, deviceId: "local", deviceName: "",
      });
      effects.resumes.push(...result.resumes);
    } catch (error) {
      if (!(error instanceof DeferredUserState)) throw error;
      // The intent remains durable even if a category or chapter is still unavailable.
    }
    if (item.intent.entity.kind === "reading") await db.execute("DELETE FROM user_state_private WHERE entity_key=$1", [userStateEntityKey(item.intent.entity)]);
    if (item.rewrite) await recordUserStateChangesInDb(db, [item.intent]);
    // Frozen operations remain retryable under their original IDs and payloads.
    if (item.from) await db.execute("DELETE FROM user_state_intent WHERE entity_key=$1", [item.from]);
  }
  return effects;
}

export interface UserStateChapterPathBefore { id: number; novelId: number; path: string }
/** Called only after the source importer has preserved the existing row and resolved its actual path. */
export async function remapUnattemptedChapterPathsInDb(db: UserStateDb, before: readonly UserStateChapterPathBefore[]): Promise<void> {
  if (!before.length || !await hasUserStateSchema(db)) return;
  const previous = new Map(before.map(row => [row.id, row]));
  const rows = await db.select<UserChapterRow[]>(USER_CHAPTER_SELECT + " WHERE c.id IN (" + before.map((_, index) => "$" + (index + 1)).join(",") + ")", before.map(row => row.id));
  const oldPaths = [...new Set(before.map(row => row.path))];
  const paths = oldPaths.map((_, index) => "$" + (index + 1)).join(",");
  const intents = await db.select<IntentRow[]>("SELECT sequence,entity_key AS entityKey,entity_json AS entityJson,value_json AS valueJson,seed FROM user_state_intent WHERE json_extract(entity_json,'$.chapter.chapterPath') IN (" + paths + ") OR json_extract(value_json,'$.chapter.chapterPath') IN (" + paths + ")", oldPaths);
  for (const chapter of rows) {
    const oldPath = previous.get(chapter.id)!.path;
    if (oldPath === chapter.chapterPath) continue;
    const work = chapterWork(chapter);
    const oldReadingKey = userStateEntityKey({ kind: "reading", work, chapter: { chapterPath: oldPath } });
    const newReadingKey = userStateEntityKey({ kind: "reading", work, chapter: chapterReference(chapter) });
    await db.execute("INSERT OR IGNORE INTO user_state_private(entity_key,public_value_json) SELECT $2,public_value_json FROM user_state_private WHERE entity_key=$1", [oldReadingKey, newReadingKey]);
    for (const row of intents) {
      const intent = intentFromRow(row);
      if (!("work" in intent.entity) || userStateWorkKey(intent.entity.work) !== userStateWorkKey(work)) continue;
      let next: UserStateIntent | null = null;
      if ((intent.entity.kind === "reading" || intent.entity.kind === "bookmark") && intent.entity.chapter.chapterPath === oldPath) {
        next = { ...intent, entity: { ...intent.entity, chapter: chapterReference(chapter) } };
      } else if (intent.entity.kind === "resume") {
        const value = intent.value as UserStateValueMap["resume"];
        if (value.chapter?.chapterPath === oldPath) next = { ...intent, value: { ...value, chapter: chapterReference(chapter) } };
      }
      if (!next) continue;
      const [attempt] = await db.select<{ present: number }[]>("SELECT 1 AS present FROM user_state_operation WHERE entity_key=$1 AND intent_sequence=$2 LIMIT 1", [row.entityKey, row.sequence]);
      if (attempt) continue;
      const nextKey = userStateEntityKey(next.entity);
      await db.execute("UPDATE user_state_intent SET entity_json=$2,value_json=$3 WHERE entity_key=$1", [row.entityKey, JSON.stringify(next.entity), JSON.stringify(next.value)]);
      if (nextKey !== row.entityKey) {
        const [collision] = await db.select<{ sequence: number }[]>("SELECT sequence FROM user_state_intent WHERE entity_key=$1", [nextKey]);
        if (collision && collision.sequence >= row.sequence) { await db.execute("DELETE FROM user_state_intent WHERE entity_key=$1", [row.entityKey]); continue; }
        if (collision) await db.execute("DELETE FROM user_state_intent WHERE entity_key=$1", [nextKey]);
        await db.execute("UPDATE user_state_intent SET entity_key=$2 WHERE entity_key=$1", [row.entityKey, nextKey]);
        await db.execute("UPDATE OR REPLACE user_state_progress SET entity_key=$2,base_revision=0,acknowledged_sequence=0 WHERE entity_key=$1", [row.entityKey, nextKey]);
      }
    }
  }
}
