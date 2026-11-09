import { getDb, runDatabaseTransaction } from "./client";
import { materializeChapterComposition, setChapterComposition } from "./chapter-composition";
import { getChapterComposition } from "./chapter-composition";
import {
  assertUserStateAvailableInDb, emitUserStateApplied, emitUserStateLedgerChanged, hasUserStateSchema,
  namespaceFor, requestUserStateDeferredApply, requireBinding, type UserStateDb,
} from "./user-state-core";
import { setUserStateActiveServer } from "./user-state";
import {
  buildCurrentSnapshotInDb, currentCacheKey, currentExportKey, currentResumeValues, currentStatusKey,
  currentWorkReference, isCurrentWorkHeld, loadCurrentDataInDb, loadCurrentHeldSourcesInDb, loadCurrentWorksInDb, matchingCurrentChapter, privateValueForChapter, sameCurrentValue,
  type CurrentCategory, type CurrentHeldSources, type CurrentWork,
} from "./user-state-current-data";
import { mergeUserStateComposition } from "../lib/user-state/composition";
import {
  mergeUserStateCurrentReading, mergeUserStateCurrentResume, parseUserStateCurrentSnapshot,
  type UserStateCurrentApplyResult, type UserStateCurrentItem, type UserStateCurrentSnapshot, type UserStateCurrentStatus,
} from "../lib/user-state/current-types";
import {
  canonicalUserStateJson, userStateEntityKey, userStateWorkKey,
  type UserStateBinding, type UserStateValueMap,
} from "../lib/user-state/types";

let currentServer: string | null = null;
let generation = 0;
let currentMode = false;
const pendingNovelIds = new Set<number>();
let currentApplyTail: Promise<void> = Promise.resolve();
async function serializeCurrentApply<T>(run: () => Promise<T>): Promise<T> {
  const previous = currentApplyTail;
  let release: () => void = () => undefined;
  currentApplyTail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await run(); } finally { release(); }
}

export function isUserStateCurrentMode(): boolean { return currentMode; }
export function setUserStateCurrentServer(serverUrl: string | null): void {
  currentMode = true;
  setUserStateActiveServer(null);
  if (serverUrl !== currentServer) { currentServer = serverUrl; generation++; pendingNovelIds.clear(); }
}
export async function bindUserStateCurrentWorkspace(binding: UserStateBinding): Promise<void> {
  await runDatabaseTransaction(async db => {
    await assertUserStateAvailableInDb(db);
    if (!binding.serverUrl || !binding.workspaceId || !binding.epoch) throw new Error("A complete personal state workspace is required.");
    const [existing] = await db.select<{ namespace: string }[]>("SELECT namespace FROM user_state_workspace WHERE server_url=$1", [binding.serverUrl]);
    if (existing) { await requireBinding(db, binding); return; }
    await db.execute("INSERT INTO user_state_workspace(server_url,namespace,workspace_id,epoch) VALUES($1,$2,$3,$4)",
      [binding.serverUrl, namespaceFor(binding), binding.workspaceId, binding.epoch]);
  });
  emitUserStateLedgerChanged();
}
export async function getUserStateCurrentStatus(serverUrl?: string): Promise<UserStateCurrentStatus> {
  const db = await getDb();
  const empty: UserStateCurrentStatus = { workspaceId: null, epoch: null, lastSuccessAt: null, pausedAfterRestore: false, missingMetadataCount: 0 };
  if (!await hasUserStateSchema(db)) return empty;
  const [row] = await db.select<{ workspaceId: string | null; epoch: string | null; lastSuccessAt: number | null; paused: number; missingMetadataCount: number }[]>(`
    SELECT w.workspace_id AS workspaceId,w.epoch,w.last_success_at AS lastSuccessAt,r.paused,
      COALESCE(json_extract(c.payload,'$.missingMetadataCount'),0)+COALESCE(json_extract(e.payload,'$.missingMetadataCount'),0) AS missingMetadataCount
    FROM user_state_restore_state r LEFT JOIN user_state_workspace w ON w.server_url=$1
    LEFT JOIN content_sync_cache c ON c.cache_key='user-state-current-status:'||w.namespace
    LEFT JOIN content_sync_cache e ON e.cache_key='user-state-current-export:'||w.namespace WHERE r.id=1`, [serverUrl ?? currentServer]);
  return row ? { workspaceId: row.workspaceId, epoch: row.epoch, lastSuccessAt: row.lastSuccessAt, pausedAfterRestore: !!row.paused, missingMetadataCount: row.missingMetadataCount } : empty;
}
export async function exportUserStateCurrentSnapshot(binding: UserStateBinding): Promise<UserStateCurrentSnapshot> {
  return runDatabaseTransaction(async db => {
    await assertUserStateAvailableInDb(db);
    await requireBinding(db, binding);
    const result = await buildCurrentSnapshotInDb(db, binding, await loadCurrentDataInDb(db, binding));
    const snapshot = parseUserStateCurrentSnapshot(result.snapshot);
    await db.execute("INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload",
      [currentExportKey(binding), JSON.stringify({ missingMetadataCount: result.missingMetadataCount })]);
    return snapshot;
  });
}
const minimumTime = (left: number | null, right: number | null): number | null => left === null ? right : right === null ? left : Math.min(left, right);

async function installCurrentStructureInDb(
  db: UserStateDb, binding: UserStateBinding, items: readonly UserStateCurrentItem[],
): Promise<{ works: CurrentWork[]; heldSources: CurrentHeldSources; missing: Set<string>; changed: boolean }> {
  await requireBinding(db, binding);
  await assertUserStateAvailableInDb(db);
  const heldSources = await loadCurrentHeldSourcesInDb(db, binding.serverUrl);
  const heldItems = items.filter(item => "work" in item.entity && isCurrentWorkHeld(heldSources, item.entity.work));
  items = items.filter(item => !("work" in item.entity) || !isCurrentWorkHeld(heldSources, item.entity.work));
  let works = await loadCurrentWorksInDb(db);
  let byKey = new Map(works.filter(work => work.sourceNovelId).map(work => [userStateWorkKey(work), work]));
  const occupiedPaths = new Set(works.map(work => JSON.stringify([work.pluginId, work.novelPath])));
  const planned = new Set<string>();
  const additions: { pluginId: string; sourceNovelId: string; novelPath: string; name: string; isLocal: number }[] = [];
  const missing = new Set(heldItems.map(item => userStateEntityKey(item.entity)));
  let changed = false;
  for (const item of items) {
    if (item.entity.kind !== "library") continue;
    const work = item.entity.work;
    const key = userStateWorkKey(work);
    if (byKey.has(key) || planned.has(key)) continue;
    const pathKey = JSON.stringify([work.pluginId, work.novelPath]);
    if (!work.sourceNovelId || occupiedPaths.has(pathKey)) { missing.add(userStateEntityKey(item.entity)); continue; }
    additions.push({ pluginId: work.pluginId, sourceNovelId: work.sourceNovelId, novelPath: work.novelPath, name: work.name, isLocal: work.pluginId === "local" ? 1 : 0 });
    occupiedPaths.add(pathKey); planned.add(key);
  }
  if (additions.length) {
    await db.execute(`INSERT INTO novel(plugin_id,source_novel_id,path,name,is_local)
      SELECT json_extract(value,'$.pluginId'),json_extract(value,'$.sourceNovelId'),json_extract(value,'$.novelPath'),json_extract(value,'$.name'),json_extract(value,'$.isLocal') FROM json_each($1)`, [JSON.stringify(additions)]);
    works = await loadCurrentWorksInDb(db);
    byKey = new Map(works.filter(work => work.sourceNovelId).map(work => [userStateWorkKey(work), work]));
    changed = true;
  }
  const libraryUpdates: { id: number; addedAt: number | null }[] = [];
  for (const item of items) {
    if (item.entity.kind !== "library") continue;
    const work = byKey.get(userStateWorkKey(item.entity.work));
    if (!work) { missing.add(userStateEntityKey(item.entity)); continue; }
    const value = item.value as UserStateValueMap["library"];
    const addedAt = minimumTime(work.addedAt, value.addedAt);
    if (!work.inLibrary || work.addedAt !== addedAt) libraryUpdates.push({ id: work.id, addedAt });
  }
  if (libraryUpdates.length) {
    await db.execute(`WITH incoming AS (SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.addedAt') AS added_at FROM json_each($1))
      UPDATE novel SET in_library=1,library_added_at=incoming.added_at FROM incoming WHERE novel.id=incoming.id`, [JSON.stringify(libraryUpdates)]);
    changed = true;
  }
  let categories = await db.select<CurrentCategory[]>("SELECT id,name,sort,is_system AS isSystem FROM category");
  const categoriesByName = () => {
    const map = new Map<string, CurrentCategory>();
    for (const category of categories) if (!category.isSystem && !map.has(category.name.trim())) map.set(category.name.trim(), category);
    return map;
  };
  let names = categoriesByName();
  const exactNames = new Set(categories.map(category => category.name));
  const categoryAdditions = new Map<string, { name: string; sort: number }>();
  for (const item of items) if (item.entity.kind === "category") {
    const value = item.value as UserStateValueMap["category"];
    if (!names.has(value.name) && !exactNames.has(value.name)) categoryAdditions.set(value.name, { name: value.name, sort: value.sort });
  }
  if (categoryAdditions.size) {
    await db.execute("INSERT INTO category(name,sort,is_system) SELECT json_extract(value,'$.name'),json_extract(value,'$.sort'),0 FROM json_each($1)", [JSON.stringify([...categoryAdditions.values()])]);
    categories = await db.select<CurrentCategory[]>("SELECT id,name,sort,is_system AS isSystem FROM category");
    names = categoriesByName(); changed = true;
  }
  const knownMaps = await db.select<{ categoryId: string; localId: number | null }[]>("SELECT category_id AS categoryId,local_id AS localId FROM user_state_category");
  const localCategories = new Map(knownMaps.filter(row => row.localId !== null).map(row => [row.categoryId, row.localId!]));
  const categoryMappings: { categoryId: string; localId: number }[] = [];
  const sortUpdates: { id: number; sort: number }[] = [];
  for (const item of items) if (item.entity.kind === "category") {
    const value = item.value as UserStateValueMap["category"];
    const category = names.get(value.name);
    if (!category) { missing.add(userStateEntityKey(item.entity)); continue; }
    if (localCategories.get(item.entity.categoryId) !== category.id) categoryMappings.push({ categoryId: item.entity.categoryId, localId: category.id });
    localCategories.set(item.entity.categoryId, category.id);
    if (category.sort > value.sort) sortUpdates.push({ id: category.id, sort: value.sort });
  }
  if (categoryMappings.length) await db.execute(`INSERT INTO user_state_category(category_id,local_id)
    SELECT json_extract(value,'$.categoryId'),json_extract(value,'$.localId') FROM json_each($1) WHERE true
    ON CONFLICT(category_id) DO UPDATE SET local_id=excluded.local_id`, [JSON.stringify(categoryMappings)]);
  if (sortUpdates.length) {
    await db.execute(`WITH incoming AS (SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.sort') AS sort FROM json_each($1))
      UPDATE category SET sort=MIN(category.sort,incoming.sort) FROM incoming WHERE category.id=incoming.id`, [JSON.stringify(sortUpdates)]);
    changed = true;
  }
  const memberships: { novelId: number; categoryId: number }[] = [];
  for (const item of items) if (item.entity.kind === "membership") {
    const work = byKey.get(userStateWorkKey(item.entity.work));
    const categoryId = localCategories.get(item.entity.categoryId);
    if (!work || !categoryId) { missing.add(userStateEntityKey(item.entity)); continue; }
    memberships.push({ novelId: work.id, categoryId });
  }
  if (memberships.length) {
    const result = await db.execute("INSERT OR IGNORE INTO novel_category(novel_id,category_id) SELECT json_extract(value,'$.novelId'),json_extract(value,'$.categoryId') FROM json_each($1)", [JSON.stringify(memberships)]);
    changed ||= result.rowsAffected > 0;
  }
  return { works, heldSources, missing, changed };
}

async function applyCurrentSnapshot(
  binding: UserStateBinding, snapshot: UserStateCurrentSnapshot, retry?: { keys: Set<string>; previousMissing: string[] },
): Promise<UserStateCurrentApplyResult> {
  const captured = generation;
  const allowed = () => captured === generation && (currentServer === null || currentServer === binding.serverUrl);
  const check = () => { if (!allowed()) throw new Error("The current personal state workspace changed during synchronization."); };
  if (snapshot.workspaceId !== binding.workspaceId || snapshot.epoch !== binding.epoch) throw new Error("The current personal state workspace does not match this device.");
  check();
  const items = retry ? snapshot.items.filter(item => item.entity.kind === "category" ||
    "work" in item.entity && retry.keys.has(userStateWorkKey(item.entity.work))) : snapshot.items;
  const structure = await runDatabaseTransaction(async db => { check(); return installCurrentStructureInDb(db, binding, items); }, true);
  const byKey = new Map(structure.works.filter(work => work.sourceNovelId).map(work => [userStateWorkKey(work), work]));
  const missing = structure.missing;
  let changed = structure.changed;
  for (const item of items) {
    if (item.entity.kind !== "composition") continue;
    if (isCurrentWorkHeld(structure.heldSources, item.entity.work)) { missing.add(userStateEntityKey(item.entity)); continue; }
    const work = byKey.get(userStateWorkKey(item.entity.work));
    if (!work) { missing.add(userStateEntityKey(item.entity)); continue; }
    try {
      const applied = await runDatabaseTransaction(async db => {
        check(); await requireBinding(db, binding); await assertUserStateAvailableInDb(db);
        if (isCurrentWorkHeld(await loadCurrentHeldSourcesInDb(db, binding.serverUrl), work)) throw new Error("The source work is held by its saved migration.");
        const current = await getChapterComposition(db, work.id);
        const shared = (item.value as UserStateValueMap["composition"]).composition;
        const incomingWins = !current || shared.updatedAt > current.updatedAt ||
          shared.updatedAt === current.updatedAt && canonicalUserStateJson(shared) < canonicalUserStateJson(current);
        if (!incomingWins) return false;
        const composition = mergeUserStateComposition(shared, current, { pluginId: work.pluginId, sourceNovelId: work.sourceNovelId! });
        if (sameCurrentValue(current, composition)) return false;
        await materializeChapterComposition(db, work.id, composition);
        await setChapterComposition(db, work.id, composition);
        return true;
      }, true);
      changed ||= applied;
    } catch (error) {
      check();
      missing.add(userStateEntityKey(item.entity));
      console.warn("[user-state] current composition is waiting for its original metadata", error);
    }
  }
  const result = await runDatabaseTransaction(async db => {
    check(); await requireBinding(db, binding); await assertUserStateAvailableInDb(db);
    const data = await loadCurrentDataInDb(db, binding, items);
    const works = new Map(data.works.filter(work => work.sourceNovelId).map(work => [userStateWorkKey(work), work]));
    const chapters = new Map(data.chapters.map(chapter => [JSON.stringify([chapter.novelId, chapter.path]), chapter]));
    const updates = new Map<number, { id: number; progress: number; unread: number; readAt: number | null; bookmark: number }>();
    const privateUpdates = new Map<string, UserStateValueMap["reading"]>();
    const affectedNovels = new Set<number>();
    const resumes = currentResumeValues(data);
    const effects: UserStateCurrentApplyResult = { resumes: [], changed, missingMetadataCount: 0 };
    for (const item of items) {
      if (item.entity.kind !== "reading" && item.entity.kind !== "bookmark" && item.entity.kind !== "resume") continue;
      if (isCurrentWorkHeld(data.heldSources, item.entity.work)) { missing.add(userStateEntityKey(item.entity)); continue; }
      const work = works.get(userStateWorkKey(item.entity.work));
      if (!work) { missing.add(userStateEntityKey(item.entity)); continue; }
      const reference = "chapter" in item.entity ? item.entity.chapter : (item.value as UserStateValueMap["resume"]).chapter;
      const chapter = reference ? matchingCurrentChapter(data, work, reference, chapters) : null;
      if (!chapter) { missing.add(userStateEntityKey(item.entity)); continue; }
      if (item.entity.kind === "resume") {
        const key = userStateWorkKey(work);
        const previous = resumes.get(key);
        const value = previous ? mergeUserStateCurrentResume(previous.value as UserStateValueMap["resume"], item.value as UserStateValueMap["resume"]) : item.value as UserStateValueMap["resume"];
        if (!previous || !sameCurrentValue(previous.value, value)) {
          const target = value.chapter ? matchingCurrentChapter(data, work, value.chapter, chapters) : null;
          if (!target) { missing.add(userStateEntityKey(item.entity)); continue; }
          effects.resumes.push({ novelId: work.id, chapterId: target.id, anchor: value.anchor, openedAt: value.openedAt });
          effects.changed = true;
        }
        resumes.set(key, { entity: { kind: "resume", work: currentWorkReference(work) }, value });
        continue;
      }
      const update = updates.get(chapter.id) ?? { id: chapter.id, progress: chapter.progress, unread: chapter.unread, readAt: chapter.readAt, bookmark: chapter.bookmark };
      if (item.entity.kind === "bookmark") {
        if (!update.bookmark) { update.bookmark = 1; updates.set(chapter.id, update); }
      } else {
        const privateValue = privateValueForChapter(data, work, chapter);
        const local = privateValue ? privateUpdates.get(privateValue.entityKey) ?? privateValue.value :
          { progress: update.progress, unread: !!update.unread, readAt: update.readAt };
        const value = mergeUserStateCurrentReading(local, item.value as UserStateValueMap["reading"]);
        if (!sameCurrentValue(local, value)) {
          if (privateValue) privateUpdates.set(privateValue.entityKey, value);
          else {
            update.progress = value.progress; update.unread = value.unread ? 1 : 0; update.readAt = value.readAt;
            updates.set(chapter.id, update); affectedNovels.add(work.id);
          }
        }
      }
    }
    if (updates.size) {
      await db.execute(`WITH incoming AS (SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.progress') AS progress,
        json_extract(value,'$.unread') AS unread,json_extract(value,'$.readAt') AS read_at,json_extract(value,'$.bookmark') AS bookmark FROM json_each($1))
        UPDATE chapter SET progress=incoming.progress,unread=incoming.unread,read_at=incoming.read_at,bookmark=incoming.bookmark
        FROM incoming WHERE chapter.id=incoming.id`, [JSON.stringify([...updates.values()])]);
      effects.changed = true;
    }
    if (privateUpdates.size) {
      await db.execute(`WITH incoming AS (SELECT json_extract(value,'$.key') AS entity_key,json_extract(value,'$.value') AS payload FROM json_each($1))
        UPDATE user_state_private SET public_value_json=incoming.payload FROM incoming WHERE user_state_private.entity_key=incoming.entity_key`,
      [JSON.stringify([...privateUpdates].map(([key, value]) => ({ key, value })))]);
      effects.changed = true;
    }
    if (affectedNovels.size) await db.execute(`UPDATE novel SET last_read_at=(SELECT MAX(read_at) FROM chapter WHERE novel_id=novel.id)
      WHERE id IN (SELECT value FROM json_each($1))`, [JSON.stringify([...affectedNovels])]);
    const handled = new Set(items.map(item => userStateEntityKey(item.entity)));
    const missingKeys = [...new Set([...(retry?.previousMissing ?? []).filter(key => !handled.has(key)), ...missing])];
    effects.missingMetadataCount = missingKeys.length;
    const currentResumes = [...resumes.values()].filter(item => (item.value as UserStateValueMap["resume"]).chapter !== null);
    await db.execute("INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2),($3,$4) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload",
      [currentCacheKey(binding), JSON.stringify({ snapshot, missingKeys }),
        currentStatusKey(binding), JSON.stringify({ resumes: currentResumes, missingMetadataCount: missingKeys.length })]);
    if (!retry) await db.execute("UPDATE user_state_workspace SET last_success_at=$2 WHERE server_url=$1", [binding.serverUrl, Date.now()]);
    return effects;
  }, true);
  check();
  if (result.changed) emitUserStateApplied(result);
  emitUserStateLedgerChanged();
  return result;
}

export async function applyUserStateCurrentSnapshot(
  binding: UserStateBinding, raw: UserStateCurrentSnapshot,
): Promise<UserStateCurrentApplyResult> {
  const snapshot = parseUserStateCurrentSnapshot(raw);
  const captured = generation;
  return serializeCurrentApply(() => {
    if (captured !== generation) throw new Error("The current personal state workspace changed during synchronization.");
    return applyCurrentSnapshot(binding, snapshot);
  });
}
/** A metadata commit retries only the current snapshot entries for its exact work. */
export function deferUserStateCurrentForNovelInDb(db: UserStateDb, novelId: number): void {
  pendingNovelIds.add(novelId);
  requestUserStateDeferredApply(db);
}
export async function applyDeferredUserStateCurrent(): Promise<void> {
  const server = currentServer;
  const captured = generation;
  if (!server || !pendingNovelIds.size) return;
  await serializeCurrentApply(async () => {
    if (generation !== captured || currentServer !== server) return;
    const db = await getDb();
    const [binding] = await db.select<UserStateBinding[]>("SELECT server_url AS serverUrl,workspace_id AS workspaceId,epoch FROM user_state_workspace WHERE server_url=$1", [server]);
    if (!binding) return;
    while (pendingNovelIds.size && generation === captured && currentServer === server) {
      const ids = [...pendingNovelIds]; pendingNovelIds.clear();
      const [row] = await db.select<{ payload: string }[]>("SELECT payload FROM content_sync_cache WHERE cache_key=$1", [currentCacheKey(binding)]);
      if (!row) return;
      const cached = JSON.parse(row.payload) as { snapshot: unknown; missingKeys?: string[] };
      const snapshot = parseUserStateCurrentSnapshot(cached.snapshot);
      const works = await db.select<CurrentWork[]>("SELECT id,plugin_id AS pluginId,source_novel_id AS sourceNovelId,path AS novelPath,name,in_library AS inLibrary,library_added_at AS addedAt FROM novel WHERE id IN (SELECT value FROM json_each($1))", [JSON.stringify(ids)]);
      const keys = new Set(works.filter(work => work.sourceNovelId).map(userStateWorkKey));
      if (keys.size) await applyCurrentSnapshot(binding, snapshot, { keys, previousMissing: cached.missingKeys ?? [] });
    }
  });
}
