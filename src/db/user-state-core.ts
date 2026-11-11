import type Database from "@tauri-apps/plugin-sql";
import {
  canonicalUserStateJson, parseUserStateEntity, parseUserStateValue, userStateEntityKey,
  type UserStateApplyEffects, type UserStateBinding, type UserStateEntity,
  type UserStateValue, type UserStateWorkReference, type UserStateChapterReference,
} from "../lib/user-state/types";
import { getChapterComposition } from "./chapter-composition";

export type UserStateDb = Pick<Database, "select" | "execute">;
export interface UserStateIntent { entity: UserStateEntity; value: UserStateValue }
export interface IntentRow { sequence: number; entityKey: string; entityJson: string; valueJson: string; seed: number }
export interface WorkspaceRow extends UserStateBinding { namespace: string; cursor: number; through: number | null; lastSuccessAt: number | null }
const schemas = new WeakMap<object, boolean>();
/** Pre-link local edits are a baseline, not server-ordered offline commands. */
export const USER_STATE_PRELINK_BASE_REVISION = -1;
export type UserStateChangePriority = "reading" | "normal";
const changed = new WeakMap<object, UserStateChangePriority>();
const ready = new WeakSet<object>();
const changes = new Set<(priority: UserStateChangePriority) => void>();
const ledgerChanges = new Set<() => void>();
export function subscribeUserStateLedgerChanges(listener: () => void): () => void { ledgerChanges.add(listener); return () => ledgerChanges.delete(listener); }
export function emitUserStateLedgerChanged(): void { for (const listener of ledgerChanges) listener(); }
const applied = new Set<(effects: UserStateApplyEffects) => void>();
let deferredRunner: (() => Promise<void>) | undefined;
let runningDeferred = false;
let deferredRequestedWhileRunning = false;
let deferredTask: Promise<void> | null = null;
export async function waitForUserStateDeferredApply(): Promise<void> { await deferredTask; }

export const namespaceFor = (binding: UserStateBinding): string =>
  canonicalUserStateJson([binding.serverUrl, binding.workspaceId, binding.epoch]);
export const intentFromRow = (row: IntentRow): UserStateIntent => ({
  entity: parseUserStateEntity(JSON.parse(row.entityJson)),
  value: parseUserStateValue(JSON.parse(row.entityJson).kind, JSON.parse(row.valueJson)),
});
export function subscribeUserStateChanges(listener: (priority: UserStateChangePriority) => void): () => void { changes.add(listener); return () => changes.delete(listener); }
export function subscribeUserStateApplied(listener: (effects: UserStateApplyEffects) => void): () => void { applied.add(listener); return () => applied.delete(listener); }
export function emitUserStateApplied(effects: UserStateApplyEffects): void { for (const listener of applied) listener(effects); }
export function installUserStateDeferredRunner(run: () => Promise<void>): void { deferredRunner = run; }
export function requestUserStateDeferredApply(db: UserStateDb): void { ready.add(db); }
export function discardUserStateNotifications(db: UserStateDb): void { changed.delete(db); ready.delete(db); }
export function notifyUserStateCommitted(db: UserStateDb): void {
  const priority = changed.get(db);
  if (priority) {
    changed.delete(db);
    for (const listener of changes) listener(priority);
    emitUserStateLedgerChanged();
  }
  if (!ready.delete(db)) return;
  if (runningDeferred) {
    deferredRequestedWhileRunning = true;
    return;
  }
  runningDeferred = true;
  // The writer queue must be released before projection starts. If another
  // transaction requests projection while this run is active, loop once more
  // rather than dropping that request.
  deferredTask = Promise.resolve().then(async () => {
    do {
      deferredRequestedWhileRunning = false;
      await (deferredRunner ?? (() => import("./user-state").then(module => module.applyDeferredUserState())))();
    } while (deferredRequestedWhileRunning);
  }).catch(error => {
    console.warn("[user-state] deferred state could not be applied", error);
  }).finally(() => {
    runningDeferred = false;
    deferredRequestedWhileRunning = false;
    deferredTask = null;
  });
}

/** Old fixture databases and interrupted bootstrap do not pretend to support the new protocol. */
export async function hasUserStateSchema(db: UserStateDb): Promise<boolean> {
  const known = schemas.get(db);
  if (known !== undefined) return known;
  const rows = await db.select<{ userStateSchema: number }[]>(
    "SELECT COUNT(*) AS userStateSchema FROM sqlite_master WHERE type='table' AND name='user_state_intent'",
  );
  const exists = rows?.[0]?.userStateSchema === 1;
  schemas.set(db, exists);
  return exists;
}
export async function requireUserStateSchema(db: UserStateDb): Promise<void> {
  if (!await hasUserStateSchema(db)) throw new Error("Personal state sharing requires database migration 11.");
}
export async function workspaceRows(db: UserStateDb): Promise<WorkspaceRow[]> {
  return db.select<WorkspaceRow[]>("SELECT server_url AS serverUrl,namespace,workspace_id AS workspaceId,epoch,cursor,read_through AS through,last_success_at AS lastSuccessAt FROM user_state_workspace");
}
export async function requireBinding(db: UserStateDb, binding: UserStateBinding): Promise<WorkspaceRow> {
  await requireUserStateSchema(db);
  const [row] = await db.select<WorkspaceRow[]>("SELECT server_url AS serverUrl,namespace,workspace_id AS workspaceId,epoch,cursor,read_through AS through,last_success_at AS lastSuccessAt FROM user_state_workspace WHERE server_url=$1", [binding.serverUrl]);
  if (!row || row.namespace !== namespaceFor(binding)) throw new Error("The personal state workspace changed. Pending changes were retained.");
  return row;
}
export async function resolveCategoryAlias(db: UserStateDb, namespace: string, categoryId: string): Promise<string> {
  const visited = new Set<string>();
  for (;;) {
    if (visited.has(categoryId)) throw new Error("Personal state category alias cycle.");
    visited.add(categoryId);
    const [alias] = await db.select<{ canonicalId: string }[]>("SELECT canonical_id AS canonicalId FROM user_state_alias WHERE namespace=$1 AND alias_id=$2", [namespace, categoryId]);
    if (!alias) return categoryId;
    categoryId = alias.canonicalId;
  }
}
export async function canonicalEntity(db: UserStateDb, namespace: string, entity: UserStateEntity): Promise<UserStateEntity> {
  return "categoryId" in entity ? { ...entity, categoryId: await resolveCategoryAlias(db, namespace, entity.categoryId) } : entity;
}

export async function recordUserStateChangesInDb(db: UserStateDb, input: readonly UserStateIntent[], seed = false): Promise<void> {
  if (!input.length || !await hasUserStateSchema(db)) return;
  const entries = input.map(entry => {
    const entity = parseUserStateEntity(entry.entity);
    return { entity, value: parseUserStateValue(entity.kind, entry.value) };
  });
  for (let start = 0; start < entries.length; start += 80) {
    const params: unknown[] = [];
    const batch = entries.slice(start, start + 80);
    const values = batch.map(({ entity, value }) => {
      const offset = params.length;
      params.push(userStateEntityKey(entity), canonicalUserStateJson(entity), canonicalUserStateJson(value), seed ? 1 : 0);
      return "(" + [1, 2, 3, 4].map(index => "$" + (offset + index)).join(",") + ")";
    });
    await db.execute("INSERT INTO user_state_intent(entity_key,entity_json,value_json,seed) VALUES " + values.join(",") +
      (seed ? " ON CONFLICT(entity_key) DO NOTHING" :
        " ON CONFLICT(entity_key) DO UPDATE SET sequence=excluded.sequence,entity_json=excluded.entity_json,value_json=excluded.value_json,seed=0"), params);
  }
  const workspaces = await workspaceRows(db);
  for (const workspace of workspaces) {
    const aliases = new Map<string, string>();
    for (let start = 0; start < entries.length; start += 150) {
      const params: unknown[] = [workspace.namespace];
      const keys: string[] = [];
      for (const entry of entries.slice(start, start + 150)) {
        let entity = entry.entity;
        if ("categoryId" in entity) {
          let categoryId = aliases.get(entity.categoryId);
          if (!categoryId) { categoryId = await resolveCategoryAlias(db, workspace.namespace, entity.categoryId); aliases.set(entity.categoryId, categoryId); }
          entity = { ...entity, categoryId };
        }
        const offset = params.length;
        params.push(userStateEntityKey(entry.entity), userStateEntityKey(entity));
        keys.push("($" + (offset + 1) + ",$" + (offset + 2) + ")");
      }
      await db.execute(`WITH intent_keys(local_key,record_key) AS (VALUES ${keys.join(",")})
        INSERT INTO user_state_progress(namespace,entity_key,local_sequence,base_revision)
        SELECT $1,i.entity_key,i.sequence,COALESCE(r.revision,0) FROM intent_keys k
        JOIN user_state_intent i ON i.entity_key=k.local_key
        LEFT JOIN user_state_record r ON r.namespace=$1 AND r.entity_key=k.record_key WHERE true
        ON CONFLICT(namespace,entity_key) DO UPDATE SET local_sequence=excluded.local_sequence,
        base_revision=CASE WHEN ${seed ? "0" : "user_state_progress.base_revision=-1"} THEN excluded.base_revision
          WHEN acknowledged_sequence>=local_sequence THEN excluded.base_revision ELSE base_revision END`, params);
    }
  }
  const priority: UserStateChangePriority = entries.every(({ entity }) => entity.kind === "reading" || entity.kind === "resume")
    ? "reading" : "normal";
  if (changed.get(db) !== "normal") changed.set(db, priority);
}

export async function workReferenceInDb(db: UserStateDb, novelId: number): Promise<UserStateWorkReference | null> {
  const [row] = await db.select<UserStateWorkReference[]>(
    "SELECT plugin_id AS pluginId,source_novel_id AS sourceNovelId,path AS novelPath,name FROM novel WHERE id=$1", [novelId]);
  return row ?? null;
}
export interface UserChapterRow extends UserStateWorkReference {
  id: number; novelId: number; chapterPath: string; chapterName: string; compositionEntryId: string | null;
  progress: number; unread: number; readAt: number | null; bookmark: number;
}
export const USER_CHAPTER_SELECT = `SELECT c.id,c.novel_id AS novelId,n.plugin_id AS pluginId,n.source_novel_id AS sourceNovelId,n.path AS novelPath,n.name,
  c.path AS chapterPath,c.name AS chapterName,c.progress,c.unread,c.read_at AS readAt,c.bookmark,
  (SELECT json_extract(entry.value,'$.id') FROM novel_chapter_composition comp,json_each(comp.payload,'$.entries') entry
   WHERE comp.novel_id=n.id AND json_extract(entry.value,'$.path')=c.path LIMIT 1) AS compositionEntryId
  FROM chapter c JOIN novel n ON n.id=c.novel_id`;
export function chapterReference(row: UserChapterRow): UserStateChapterReference {
  return { chapterPath: row.chapterPath, name: row.chapterName, ...(row.compositionEntryId && /^norea-(?:composed|source):/.test(row.chapterPath) ? { compositionEntryId: row.compositionEntryId } : {}) };
}
export function chapterWork(row: UserChapterRow): UserStateWorkReference {
  return { pluginId: row.pluginId, sourceNovelId: row.sourceNovelId, novelPath: row.novelPath, name: row.name };
}
export async function recordChaptersInDb(db: UserStateDb, ids: readonly number[], kind: "reading" | "bookmark" = "reading"): Promise<void> {
  if (!ids.length || !await hasUserStateSchema(db)) return;
  for (let start = 0; start < ids.length; start += 400) {
    const chunk = ids.slice(start, start + 400);
    const rows = await db.select<UserChapterRow[]>(USER_CHAPTER_SELECT + " WHERE c.id IN (" + chunk.map((_, index) => "$" + (index + 1)).join(",") + ")", [...chunk]);
    await recordChapterRowsInDb(db, rows, kind);
  }
}
export async function markPrivateChapterProgressInDb(db: UserStateDb, chapterId: number): Promise<void> {
  if (!await hasUserStateSchema(db)) return;
  const [row] = await db.select<UserChapterRow[]>(USER_CHAPTER_SELECT + " WHERE c.id=$1", [chapterId]);
  if (row) await db.execute("INSERT OR IGNORE INTO user_state_private(entity_key,public_value_json) VALUES($1,$2)",
    [userStateEntityKey({ kind: "reading", work: chapterWork(row), chapter: chapterReference(row) }), JSON.stringify({ progress: row.progress, unread: !!row.unread, readAt: row.readAt })]);
}
export async function recordChapterRowsInDb(db: UserStateDb, rows: readonly UserChapterRow[], kind: "reading" | "bookmark" = "reading", seed = false): Promise<void> {
  if (kind === "reading" && !seed && await hasUserStateSchema(db)) {
    for (let start = 0; start < rows.length; start += 400) {
      const keys = rows.slice(start, start + 400).map(row => userStateEntityKey({ kind, work: chapterWork(row), chapter: chapterReference(row) }));
      await db.execute("DELETE FROM user_state_private WHERE entity_key IN (" + keys.map((_, index) => "$" + (index + 1)).join(",") + ")", keys);
    }
  }
  await recordUserStateChangesInDb(db, rows.map(row => ({
    entity: { kind, work: chapterWork(row), chapter: chapterReference(row) },
    value: kind === "reading" ? { progress: row.progress, unread: !!row.unread, readAt: row.readAt } : { bookmarked: !!row.bookmark },
  })), seed);
}
export async function recordNovelChaptersInDb(db: UserStateDb, novelIds?: readonly number[]): Promise<void> {
  if (novelIds && novelIds.length > 400) {
    for (let start = 0; start < novelIds.length; start += 400) await recordNovelChaptersInDb(db, novelIds.slice(start, start + 400));
    return;
  }
  if (!await hasUserStateSchema(db)) return;
  if (novelIds?.length === 0) return;
  const where = novelIds ? " WHERE c.novel_id IN (" + novelIds.map((_, index) => "$" + (index + 1)).join(",") + ")" : "";
  await recordChapterRowsInDb(db, await db.select<UserChapterRow[]>(USER_CHAPTER_SELECT + where, novelIds ? [...novelIds] : []));
}
export async function recordLibraryInDb(db: UserStateDb, novelIds?: readonly number[], removed = false): Promise<void> {
  if (novelIds && novelIds.length > 400) {
    for (let start = 0; start < novelIds.length; start += 400) await recordLibraryInDb(db, novelIds.slice(start, start + 400), removed);
    return;
  }
  if (!await hasUserStateSchema(db) || novelIds?.length === 0) return;
  const rows = await db.select<(UserStateWorkReference & { inLibrary: number; addedAt: number | null })[]>(
    "SELECT plugin_id AS pluginId,source_novel_id AS sourceNovelId,path AS novelPath,name,in_library AS inLibrary,library_added_at AS addedAt FROM novel" +
    (novelIds ? " WHERE id IN (" + novelIds.map((_, index) => "$" + (index + 1)).join(",") + ")" : ""), novelIds ? [...novelIds] : []);
  await recordUserStateChangesInDb(db, rows.map(row => ({
    entity: { kind: "library", work: { pluginId: row.pluginId, sourceNovelId: row.sourceNovelId, novelPath: row.novelPath, name: row.name } },
    value: { inLibrary: removed ? false : !!row.inLibrary, addedAt: removed ? null : row.addedAt },
  })));
}
export async function stableCategoryIdInDb(db: UserStateDb, id: number, create = false): Promise<string | null> {
  if (!await hasUserStateSchema(db)) return null;
  const [existing] = await db.select<{ categoryId: string }[]>("SELECT category_id AS categoryId FROM user_state_category WHERE local_id=$1 ORDER BY rowid LIMIT 1", [id]);
  if (existing) return existing.categoryId;
  const [category] = await db.select<{ name: string }[]>("SELECT name FROM category WHERE id=$1 AND is_system=0", [id]);
  if (!category) return null;
  const digest = create ? null : new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(category.name)));
  const categoryId = create ? crypto.randomUUID() : "legacy-" + [...digest!].map(byte => byte.toString(16).padStart(2, "0")).join("");
  await db.execute("INSERT INTO user_state_category(category_id,local_id) VALUES($1,$2) ON CONFLICT(category_id) DO UPDATE SET local_id=excluded.local_id WHERE local_id IS NULL", [categoryId, id]);
  return categoryId;
}
export async function recordCategoryInDb(db: UserStateDb, id: number, options: { create?: boolean; deleted?: boolean; seed?: boolean } = {}): Promise<void> {
  const categoryId = await stableCategoryIdInDb(db, id, options.create);
  if (!categoryId) return;
  const [row] = await db.select<{ name: string; sort: number }[]>("SELECT name,sort FROM category WHERE id=$1 AND is_system=0", [id]);
  if (row) await recordUserStateChangesInDb(db, [{ entity: { kind: "category", categoryId }, value: { ...row, deleted: !!options.deleted } }], options.seed);
  if (!options.seed && !options.create) {
    await db.execute("UPDATE user_state_record SET applied_revision=0,deferred_reason=NULL,deferred_detail=NULL WHERE deferred_reason IN ('category-name-conflict','missing-category')");
    requestUserStateDeferredApply(db);
  }
}
export async function recordMembershipInDb(db: UserStateDb, novelIds: readonly number[], categoryId: number, included: boolean, seed = false): Promise<void> {
  const stableId = await stableCategoryIdInDb(db, categoryId);
  if (!stableId) return;
  if (!seed && included) {
    const categoryKey = userStateEntityKey({ kind: "category", categoryId: stableId });
    const [intent] = await db.select<{ present: number }[]>("SELECT 1 AS present FROM user_state_intent WHERE entity_key=$1 LIMIT 1", [categoryKey]);
    if (!intent) {
      const workspaces = await workspaceRows(db);
      let knownEverywhere = workspaces.length > 0;
      for (const workspace of workspaces) {
        const canonicalCategoryId = await resolveCategoryAlias(db, workspace.namespace, stableId);
        const [record] = await db.select<{ present: number }[]>(
          "SELECT 1 AS present FROM user_state_record WHERE namespace=$1 AND entity_key=$2 LIMIT 1",
          [workspace.namespace, userStateEntityKey({ kind: "category", categoryId: canonicalCategoryId })],
        );
        if (!record) { knownEverywhere = false; break; }
      }
      if (!knownEverywhere) await recordCategoryInDb(db, categoryId);
    }
  }
  for (let start = 0; start < novelIds.length; start += 400) {
    const ids = novelIds.slice(start, start + 400);
    const works = await db.select<UserStateWorkReference[]>("SELECT plugin_id AS pluginId,source_novel_id AS sourceNovelId,path AS novelPath,name FROM novel WHERE id IN (" + ids.map((_, index) => "$" + (index + 1)).join(",") + ")", [...ids]);
    await recordUserStateChangesInDb(db, works.map(work => ({ entity: { kind: "membership", work, categoryId: stableId }, value: { included } })), seed);
  }
}
export async function recordResumeClearedInDb(db: UserStateDb, novelIds?: readonly number[]): Promise<void> {
  if (novelIds && novelIds.length > 400) {
    for (let start = 0; start < novelIds.length; start += 400) await recordResumeClearedInDb(db, novelIds.slice(start, start + 400));
    return;
  }
  if (!await hasUserStateSchema(db) || novelIds?.length === 0) return;
  const rows = await db.select<(UserStateWorkReference & { id: number })[]>(
    "SELECT id,plugin_id AS pluginId,source_novel_id AS sourceNovelId,path AS novelPath,name FROM novel" +
    (novelIds ? " WHERE id IN (" + novelIds.map((_, index) => "$" + (index + 1)).join(",") + ")" : ""), novelIds ? [...novelIds] : []);
  await recordUserStateChangesInDb(db, rows.map(({ id: _id, ...work }) => ({
    entity: { kind: "resume", work }, value: { chapter: null, anchor: null, openedAt: null },
  })));
}
export async function recordCompositionInDb(db: UserStateDb, novelId: number): Promise<void> {
  if (!await hasUserStateSchema(db)) return;
  const work = await workReferenceInDb(db, novelId);
  const composition = await getChapterComposition(db, novelId);
  if (work && composition) await recordUserStateChangesInDb(db, [{ entity: { kind: "composition", work }, value: { composition } }]);
}

export async function seedUserStateInDb(db: UserStateDb): Promise<void> {
  const [restore] = await db.select<{ restored: number }[]>("SELECT restored FROM user_state_restore_state WHERE id=1");
  if (restore?.restored) return;
  await promotePrivateWorkIdentitiesInDb(db);
  const novels = await db.select<(UserStateWorkReference & { id: number; inLibrary: number; addedAt: number | null })[]>(
    "SELECT id,plugin_id AS pluginId,source_novel_id AS sourceNovelId,path AS novelPath,name,in_library AS inLibrary,library_added_at AS addedAt FROM novel");
  await recordUserStateChangesInDb(db, novels.filter(row => row.inLibrary).map(({ id: _id, inLibrary: _inLibrary, addedAt, ...work }) => ({
    entity: { kind: "library", work }, value: { inLibrary: true, addedAt },
  })), true);
  const composed = new Set((await db.select<{ id: number }[]>("SELECT novel_id AS id FROM novel_chapter_composition")).map(row => row.id));
  for (const { id, inLibrary: _inLibrary, addedAt: _addedAt, ...work } of novels) {
    if (!composed.has(id)) continue;
    const composition = await getChapterComposition(db, id);
    if (composition) await recordUserStateChangesInDb(db, [{ entity: { kind: "composition", work }, value: { composition } }], true);
  }
  const categories = await db.select<{ id: number }[]>("SELECT id FROM category WHERE is_system=0");
  for (const category of categories) {
    await recordCategoryInDb(db, category.id, { seed: true });
    const members = await db.select<{ id: number }[]>("SELECT novel_id AS id FROM novel_category WHERE category_id=$1", [category.id]);
    await recordMembershipInDb(db, members.map(row => row.id), category.id, true, true);
  }
  const chapters = await db.select<UserChapterRow[]>(USER_CHAPTER_SELECT + " WHERE c.progress>0 OR c.unread=0 OR c.read_at IS NOT NULL OR c.bookmark=1");
  const privateRows = await db.select<{ entityKey: string }[]>("SELECT entity_key AS entityKey FROM user_state_private");
  const privateKeys = new Set(privateRows.map(row => row.entityKey));
  await recordChapterRowsInDb(db, chapters.filter(row => (row.progress > 0 || !row.unread || row.readAt !== null) &&
    !privateKeys.has(userStateEntityKey({ kind: "reading", work: chapterWork(row), chapter: chapterReference(row) }))), "reading", true);
  await recordChapterRowsInDb(db, chapters.filter(row => !!row.bookmark), "bookmark", true);
  const resumes = new Map<number, UserChapterRow>();
  for (const chapter of chapters) if (chapter.readAt !== null && !privateKeys.has(userStateEntityKey({ kind: "reading", work: chapterWork(chapter), chapter: chapterReference(chapter) })) && (resumes.get(chapter.novelId)?.readAt ?? -1) < chapter.readAt) resumes.set(chapter.novelId, chapter);
  await recordUserStateChangesInDb(db, [...resumes.values()].map(row => ({
    entity: { kind: "resume", work: chapterWork(row) }, value: { chapter: chapterReference(row), anchor: null, openedAt: row.readAt },
  })), true);
}

/** A merge or history-only action must not publish progress previously saved in incognito. */
export async function recordPublicNovelReadingInDb(db: UserStateDb, novelIds: readonly number[], clearHistory = false): Promise<void> {
  if (novelIds.length > 400) {
    for (let start = 0; start < novelIds.length; start += 400) await recordPublicNovelReadingInDb(db, novelIds.slice(start, start + 400), clearHistory);
    return;
  }
  if (!await hasUserStateSchema(db) || !novelIds.length) return;
  const privateRows = await db.select<{ entityKey: string; publicValueJson: string }[]>("SELECT entity_key AS entityKey,public_value_json AS publicValueJson FROM user_state_private");
  const privateValues = new Map(privateRows.map(row => [row.entityKey, JSON.parse(row.publicValueJson) as { progress: number; unread: boolean; readAt: number | null }]));
  const rows = await db.select<UserChapterRow[]>(USER_CHAPTER_SELECT + " WHERE c.novel_id IN (" + novelIds.map((_, index) => "$" + (index + 1)).join(",") + ")", [...novelIds]);
  const entries: UserStateIntent[] = [];
  for (const row of rows) {
    const entity = { kind: "reading" as const, work: chapterWork(row), chapter: chapterReference(row) };
    const key = userStateEntityKey(entity);
    const previous = privateValues.get(key);
    if (previous && !clearHistory) continue;
    const value = previous ? { ...previous, readAt: null } : { progress: row.progress, unread: !!row.unread, readAt: row.readAt };
    entries.push({ entity, value });
    if (previous) await db.execute("UPDATE user_state_private SET public_value_json=$2 WHERE entity_key=$1", [key, JSON.stringify(value)]);
  }
  await recordUserStateChangesInDb(db, entries);
}

/** A private marker follows the same exact path-to-ID upgrade as its work, without becoming an outbox change. */
export async function promotePrivateWorkIdentitiesInDb(db: UserStateDb): Promise<void> {
  const markers = await db.select<{ entityKey: string; publicValueJson: string }[]>("SELECT entity_key AS entityKey,public_value_json AS publicValueJson FROM user_state_private");
  for (const marker of markers) {
    const [kind, encodedWork, chapterPath] = JSON.parse(marker.entityKey) as [string, string, string];
    const [pluginId, identityKind, novelPath] = JSON.parse(encodedWork) as [string, string, string];
    if (kind !== "reading" || identityKind !== "path") continue;
    const [work] = await db.select<UserStateWorkReference[]>("SELECT plugin_id AS pluginId,source_novel_id AS sourceNovelId,path AS novelPath,name FROM novel WHERE plugin_id=$1 AND path=$2", [pluginId, novelPath]);
    if (!work?.sourceNovelId) continue;
    const key = userStateEntityKey({ kind: "reading", work, chapter: { chapterPath } });
    await db.execute("INSERT OR IGNORE INTO user_state_private(entity_key,public_value_json) VALUES($1,$2)", [key, marker.publicValueJson]);
    await db.execute("DELETE FROM user_state_private WHERE entity_key=$1", [marker.entityKey]);
  }
}

export async function userStateRestorePausedInDb(db: UserStateDb): Promise<boolean> {
  if (!await hasUserStateSchema(db)) return false;
  const [row] = await db.select<{ paused: number }[]>("SELECT paused FROM user_state_restore_state WHERE id=1");
  return !!row?.paused;
}
export async function assertUserStateAvailableInDb(db: UserStateDb): Promise<void> {
  await requireUserStateSchema(db);
  if (await userStateRestorePausedInDb(db)) throw new Error("Personal state sharing is paused after restoring a backup. Reconnect to the existing shared state explicitly before synchronizing.");
}

/** Clearing the updates badge changes only unread; it must not expose an incognito position. */
export async function recordChapterUnreadFlagsInDb(db: UserStateDb, ids: readonly number[], unread: boolean): Promise<void> {
  if (!ids.length || !await hasUserStateSchema(db)) return;
  const privateRows = await db.select<{ entityKey: string; publicValueJson: string }[]>("SELECT entity_key AS entityKey,public_value_json AS publicValueJson FROM user_state_private");
  const privateValues = new Map(privateRows.map(row => [row.entityKey, row.publicValueJson]));
  for (let start = 0; start < ids.length; start += 400) {
    const chunk = ids.slice(start, start + 400);
    const rows = await db.select<UserChapterRow[]>(USER_CHAPTER_SELECT + " WHERE c.id IN (" + chunk.map((_, index) => "$" + (index + 1)).join(",") + ")", [...chunk]);
    const entries: UserStateIntent[] = [];
    for (const row of rows) {
      const entity = { kind: "reading" as const, work: chapterWork(row), chapter: chapterReference(row) };
      const key = userStateEntityKey(entity);
      const privateValue = privateValues.get(key);
      const value = { ...(privateValue ? JSON.parse(privateValue) as { progress: number; unread: boolean; readAt: number | null } :
        { progress: row.progress, unread: !!row.unread, readAt: row.readAt }), unread };
      entries.push({ entity, value });
      if (privateValue) await db.execute("UPDATE user_state_private SET public_value_json=$2 WHERE entity_key=$1", [key, JSON.stringify(value)]);
    }
    await recordUserStateChangesInDb(db, entries);
  }
}
