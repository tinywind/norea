import {
  parseChapterComposition, type ChapterCompositionV1, type ChapterSourceSnapshot,
} from "../../lib/chapter-composition";
import { getChapterComposition, materializeChapterComposition, setChapterComposition } from "./chapter-composition";
import type { ChapterContentType } from "../../lib/chapter-content";
import type { HoldChapterDownloadSnapshot } from "../../lib/chapter-download-writes";
import { mergeUserStateComposition } from "../../lib/user-state/composition";
import { parseStoredChapterPath, storedChapterDigest, storedChapterNumber, storedChapterPath } from "../../lib/user-state/stored-chapter";
import {
  canonicalUserStateJson, parseUserStateEntity, parseUserStateValue, userStateEntityKey, userStateWorkKey,
  type UserStateBinding, type UserStateChapterReference, type UserStateValueMap, type UserStateWorkReference,
} from "../../lib/user-state/types";
import {
  mergeUserStateCurrentReading, mergeUserStateCurrentResume, parseUserStateCurrentItem,
  type UserStateCurrentApplyResult, type UserStateCurrentItem, type UserStateCurrentSnapshot,
} from "../../lib/user-state/current-types";
import { assertUserStateAvailableInDb, namespaceFor, requireBinding, type UserStateDb } from "./user-state-core";

export interface CurrentWork extends UserStateWorkReference {
  id: number; inLibrary: number; addedAt: number | null;
}
export interface CurrentChapter {
  id: number; novelId: number; path: string; name: string; progress: number; unread: number; readAt: number | null; bookmark: number;
  chapterNumber: string | null; position: number; contentType: ChapterContentType;
}
export interface CurrentCategory { id: number; name: string; sort: number; isSystem: number }
export interface CurrentPrivateValue { entityKey: string; value: UserStateValueMap["reading"] }
export interface CurrentData {
  works: CurrentWork[];
  heldSources: CurrentHeldSources;
  chapters: CurrentChapter[];
  categories: CurrentCategory[];
  memberships: { novelId: number; categoryId: number }[];
  categoryIdentities: { categoryId: string; localId: number | null }[];
  privateValues: Map<string, CurrentPrivateValue>;
  compositions: Map<number, ChapterCompositionV1>;
  resumes: UserStateCurrentItem[];
  appliedResumes: UserStateCurrentItem[];
  storedChapterPaths: Map<number, string>;
}
export const currentCacheKey = (binding: UserStateBinding): string => "user-state-current:" + namespaceFor(binding);
export const currentStatusKey = (binding: UserStateBinding): string => "user-state-current-status:" + namespaceFor(binding);
export const currentExportKey = (binding: UserStateBinding): string => "user-state-current-export:" + namespaceFor(binding);
export const currentWorkReference = (work: CurrentWork): UserStateWorkReference => ({
  pluginId: work.pluginId, sourceNovelId: work.sourceNovelId, novelPath: work.novelPath, name: work.name,
});
export async function currentCategoryId(name: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name.trim()));
  return "name-" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export interface CurrentHeldSources { ids: Set<string>; paths: Set<string> }
export function isCurrentWorkHeld(held: CurrentHeldSources, work: UserStateWorkReference): boolean {
  return held.ids.has(userStateWorkKey(work)) || held.paths.has(JSON.stringify([work.pluginId, work.novelPath]));
}
/** Match the existing import holds in bulk, honoring explicit revocation of a bound legacy operation. */
export async function loadCurrentHeldSourcesInDb(db: UserStateDb, serverUrl: string): Promise<CurrentHeldSources> {
  const rows = await db.select<{ type: string; status: string; operationId: string | null; legacyOperationId: string | null; pluginId: string | null; sourceNovelId: string | null; novelPath: string | null }[]>(`
    SELECT CASE WHEN cache_key LIKE 'norea-content-novel-migration:%' THEN 'outgoing'
      WHEN cache_key LIKE 'norea-content-incoming-migration:%' THEN 'incoming' ELSE 'number' END AS type,
      json_extract(payload,'$.status') AS status,json_extract(payload,'$.operationId') AS operationId,
      json_extract(payload,'$.lineage.legacyOperationId') AS legacyOperationId,
      COALESCE(json_extract(payload,'$.source.pluginId'),json_extract(payload,'$.identity.pluginId')) AS pluginId,
      COALESCE(json_extract(payload,'$.source.novelId'),json_extract(payload,'$.identity.novelId')) AS sourceNovelId,
      COALESCE(json_extract(payload,'$.source.novelPath'),json_extract(payload,'$.identity.novelPath')) AS novelPath
    FROM content_sync_cache WHERE CASE WHEN
      cache_key LIKE 'norea-content-novel-migration:%' OR cache_key LIKE 'norea-content-incoming-migration:%'
        OR cache_key LIKE 'norea-content-chapter-number-reconciliation:%'
      THEN json_extract(payload,'$.serverUrl')=$1 ELSE 0 END`, [serverUrl]);
  const revoked = new Set(rows.filter(row => row.type === "incoming" && row.status === "inactive").flatMap(row =>
    [row.operationId, row.legacyOperationId].filter((id): id is string => typeof id === "string")));
  const result: CurrentHeldSources = { ids: new Set(), paths: new Set() };
  for (const row of rows) {
    if (!row.pluginId || row.type === "number" && row.status !== "pending" || row.type === "incoming" && row.status === "inactive" ||
        row.operationId && revoked.has(row.operationId) || row.legacyOperationId && revoked.has(row.legacyOperationId)) continue;
    if (row.sourceNovelId) result.ids.add(userStateWorkKey({ pluginId: row.pluginId, sourceNovelId: row.sourceNovelId, novelPath: row.novelPath ?? "", name: "" }));
    if (row.novelPath) result.paths.add(JSON.stringify([row.pluginId, row.novelPath]));
  }
  return result;
}

export async function loadCurrentWorksInDb(db: UserStateDb): Promise<CurrentWork[]> {
  return db.select<CurrentWork[]>("SELECT id,plugin_id AS pluginId,source_novel_id AS sourceNovelId,path AS novelPath,name,in_library AS inLibrary,library_added_at AS addedAt FROM novel");
}
export async function loadCurrentDataInDb(
  db: UserStateDb, binding: UserStateBinding, hold: HoldChapterDownloadSnapshot, requested?: readonly UserStateCurrentItem[],
): Promise<CurrentData> {
  const works = await loadCurrentWorksInDb(db);
  const heldSources = await loadCurrentHeldSourcesInDb(db, binding.serverUrl);
  const categories = await db.select<CurrentCategory[]>("SELECT id,name,sort,is_system AS isSystem FROM category");
  const memberships = await db.select<{ novelId: number; categoryId: number }[]>("SELECT novel_id AS novelId,category_id AS categoryId FROM novel_category");
  const categoryIdentities = await db.select<{ categoryId: string; localId: number | null }[]>("SELECT category_id AS categoryId,local_id AS localId FROM user_state_category");
  const rawPrivate = await db.select<{ entityKey: string; value: string }[]>("SELECT entity_key AS entityKey,public_value_json AS value FROM user_state_private");
  const privateValues = new Map(rawPrivate.map(row => [row.entityKey, { entityKey: row.entityKey, value: parseUserStateValue("reading", JSON.parse(row.value)) as UserStateValueMap["reading"] }]));
  const rawCompositions = await db.select<{ novelId: number; payload: string }[]>("SELECT novel_id AS novelId,payload FROM novel_chapter_composition");
  const compositions = new Map(rawCompositions.map(row => [row.novelId, parseChapterComposition(JSON.parse(row.payload))]));
  const rawResumes = await db.select<{ entity: string; value: string }[]>("SELECT entity_json AS entity,value_json AS value FROM user_state_intent WHERE json_extract(entity_json,'$.kind')='resume'");
  const worksByPath = new Map(works.map(work => [JSON.stringify([work.pluginId, work.novelPath]), work]));
  const resumes = rawResumes.map(row => {
    let entity = parseUserStateEntity(JSON.parse(row.entity));
    if (entity.kind === "resume" && entity.work.sourceNovelId === null) {
      const work = worksByPath.get(JSON.stringify([entity.work.pluginId, entity.work.novelPath]));
      if (work?.sourceNovelId) entity = { kind: "resume", work: currentWorkReference(work) };
    }
    return { entity, value: parseUserStateValue("resume", JSON.parse(row.value)) };
  });
  const [cached] = await db.select<{ resumes: string | null }[]>("SELECT json_extract(payload,'$.resumes') AS resumes FROM content_sync_cache WHERE cache_key=$1", [currentStatusKey(binding)]);
  const appliedResumes: UserStateCurrentItem[] = cached?.resumes ? (JSON.parse(cached.resumes) as unknown[]).map(parseUserStateCurrentItem) : [];
  const chapterRefs = (requested ?? [...resumes, ...appliedResumes]).flatMap(item => {
    if (!("work" in item.entity)) return [];
    const chapter = item.entity.kind === "reading" || item.entity.kind === "bookmark" ? item.entity.chapter :
      item.entity.kind === "resume" ? (item.value as UserStateValueMap["resume"]).chapter : null;
    const stored = chapter ? parseStoredChapterPath(chapter.chapterPath) : null;
    return chapter ? [{ pluginId: item.entity.work.pluginId, sourceNovelId: item.entity.work.sourceNovelId,
      path: stored?.folderPath ?? chapter.chapterPath, storageNumber: stored?.chapterNumber ?? null }] : [];
  });
  const columns = "c.id,c.novel_id AS novelId,c.path,c.name,c.progress,c.unread,c.read_at AS readAt,c.bookmark,c.chapter_number AS chapterNumber,c.position,COALESCE(c.stored_content_type,c.content_type) AS contentType";
  const requestedFrom = " FROM json_each($1) r JOIN novel n ON json_extract(r.value,'$.pluginId')=n.plugin_id AND lower(json_extract(r.value,'$.sourceNovelId'))=lower(n.source_novel_id) JOIN chapter c ON c.novel_id=n.id";
  const requestedChapters = "SELECT " + columns + requestedFrom + " AND json_extract(r.value,'$.path')=c.path" +
    " UNION SELECT " + columns + requestedFrom + " AND CAST(json_extract(r.value,'$.storageNumber') AS REAL)=CAST(c.chapter_number AS REAL) WHERE json_extract(r.value,'$.storageNumber') IS NOT NULL";
  const positive = "c.progress>0 OR c.unread=0 OR c.read_at IS NOT NULL OR c.bookmark=1 OR EXISTS(SELECT 1 FROM user_state_private p WHERE p.entity_key=json_array('reading',(CASE WHEN n.source_novel_id IS NULL THEN json_array(n.plugin_id,'path',n.path) ELSE json_array(n.plugin_id,'id',lower(n.source_novel_id)) END)||'',c.path) OR p.entity_key=json_array('reading',json_array(n.plugin_id,'path',n.path)||'',c.path))";
  const resumeWorks = new Set(requested?.flatMap(item =>
    item.entity.kind === "resume" ? [userStateWorkKey(item.entity.work)] : []) ?? []);
  const resumeNovelIds = works.filter(work => resumeWorks.has(userStateWorkKey(work))).map(work => work.id);
  const chapters = await db.select<CurrentChapter[]>(requested ? requestedChapters +
    " UNION SELECT " + columns + " FROM chapter c WHERE c.novel_id IN (SELECT value FROM json_each($2)) AND c.read_at IS NOT NULL" :
    "SELECT " + columns + " FROM chapter c JOIN novel n ON n.id=c.novel_id WHERE " + positive + " UNION " + requestedChapters,
  requested ? [JSON.stringify(chapterRefs), JSON.stringify(resumeNovelIds)] : [JSON.stringify(chapterRefs)]);
  const data: CurrentData = { works, heldSources, chapters, categories, memberships, categoryIdentities, privateValues,
    compositions, resumes, appliedResumes, storedChapterPaths: new Map() };
  const storedRequests = new Set(chapterRefs.filter(row => row.storageNumber !== null).map(row =>
    JSON.stringify([row.pluginId, row.sourceNovelId?.toLowerCase(), row.storageNumber])));
  await loadStoredChapterPathsInDb(db, data, storedRequests, hold);
  return data;
}

async function loadStoredChapterPathsInDb(db: UserStateDb, data: CurrentData, requested: Set<string>, hold: HoldChapterDownloadSnapshot): Promise<void> {
  const works = new Map(data.works.map(work => [work.id, work]));
  const candidates = data.chapters.flatMap(chapter => {
    const work = works.get(chapter.novelId);
    const number = storedChapterNumber(chapter.chapterNumber);
    if (!work?.sourceNovelId || work.pluginId === "local" || number === null || data.compositions.has(work.id) ||
        /^(?:local-folder|norea-composed|norea-source|norea-stored):/.test(chapter.path) ||
        isCurrentWorkHeld(data.heldSources, work)) return [];
    const folder = chapter.path.startsWith("norea-folder:");
    if (folder && storedChapterNumber(chapter.path.slice("norea-folder:".length)) !== number) return [];
    if (!folder && !requested.has(JSON.stringify([work.pluginId, work.sourceNovelId.toLowerCase(), number]))) return [];
    return [{ chapter, work, number }];
  });
  if (!candidates.length) return;
  const targets = new Map(candidates.map(({ work, number }) => [JSON.stringify([work.id, number]), { novelId: work.id, number }]));
  // Include unread/unexported rows when checking ownership of a physical directory.
  const counts = await db.select<{ novelId: number; number: string; count: number }[]>(`SELECT
    json_extract(t.value,'$.novelId') AS novelId,json_extract(t.value,'$.number') AS number,COUNT(*) AS count
    FROM json_each($1) t JOIN chapter c ON c.novel_id=json_extract(t.value,'$.novelId')
      AND CAST(c.chapter_number AS REAL)=CAST(json_extract(t.value,'$.number') AS REAL)
    GROUP BY t.value`, [JSON.stringify([...targets.values()])]);
  const unique = new Set(counts.filter(row => row.count === 1).map(row => JSON.stringify([row.novelId, row.number])));
  for (const { chapter, work, number } of candidates) {
    if (!unique.has(JSON.stringify([work.id, number])) || !hold(chapter.id)) continue;
    try {
      const { inspectChapterPayloadInventory } = await import("../../lib/chapter-content/storage-platform");
      const inventory = await inspectChapterPayloadInventory({ novel: { ...work, path: work.novelPath }, chapter });
      const digest = await storedChapterDigest(inventory);
      if (!digest) continue;
      const path = storedChapterPath(number, digest);
      if (path) data.storedChapterPaths.set(chapter.id, path);
    } catch {
      // Missing, inaccessible or invalid storage keeps the original state pending.
    }
  }
}
export function privateValueForChapter(data: CurrentData, work: CurrentWork, chapter: CurrentChapter): CurrentPrivateValue | undefined {
  const reference = currentWorkReference(work);
  return data.privateValues.get(userStateEntityKey({ kind: "reading", work: reference, chapter: { chapterPath: chapter.path } })) ??
    data.privateValues.get(userStateEntityKey({ kind: "reading", work: { ...reference, sourceNovelId: null }, chapter: { chapterPath: chapter.path } }));
}
export function currentReadingValue(data: CurrentData, work: CurrentWork, chapter: CurrentChapter): UserStateValueMap["reading"] {
  return privateValueForChapter(data, work, chapter)?.value ?? { progress: chapter.progress, unread: !!chapter.unread, readAt: chapter.readAt };
}
const compositionEntryIds = new WeakMap<CurrentData, Map<string, string>>();
export function currentChapterReference(data: CurrentData, chapter: CurrentChapter): UserStateChapterReference | null {
  if (chapter.path.startsWith("local-folder:")) return null;
  if (chapter.path.startsWith("norea-folder:")) {
    const chapterPath = data.storedChapterPaths.get(chapter.id);
    return chapterPath ? { chapterPath, name: chapter.name } : null;
  }
  if (/^norea-(?:composed|source):/.test(chapter.path)) {
    let entries = compositionEntryIds.get(data);
    if (!entries) {
      entries = new Map();
      for (const [novelId, composition] of data.compositions) for (const entry of composition.entries)
        entries.set(JSON.stringify([novelId, entry.path]), entry.id);
      compositionEntryIds.set(data, entries);
    }
    const entryId = entries.get(JSON.stringify([chapter.novelId, chapter.path]));
    return entryId ? { chapterPath: chapter.path, name: chapter.name, compositionEntryId: entryId } : null;
  }
  return { chapterPath: chapter.path, name: chapter.name };
}
const storedChapterIndexes = new WeakMap<CurrentData, Map<string, CurrentChapter | null>>();
export function matchingCurrentChapter(
  data: CurrentData, work: CurrentWork, reference: UserStateChapterReference,
  chapters: Map<string, CurrentChapter>,
): CurrentChapter | null {
  if (parseStoredChapterPath(reference.chapterPath)) {
    let index = storedChapterIndexes.get(data);
    if (!index) {
      index = new Map();
      for (const chapter of data.chapters) {
        const path = data.storedChapterPaths.get(chapter.id);
        if (!path) continue;
        const key = JSON.stringify([chapter.novelId, path]);
        index.set(key, index.has(key) ? null : chapter);
      }
      storedChapterIndexes.set(data, index);
    }
    return index.get(JSON.stringify([work.id, reference.chapterPath])) ?? null;
  }
  const chapter = chapters.get(JSON.stringify([work.id, reference.chapterPath]));
  if (!chapter) return null;
  const local = currentChapterReference(data, chapter);
  return local && (!local.compositionEntryId || local.compositionEntryId === reference.compositionEntryId) ? chapter : null;
}

export function currentResumeValue(
  data: CurrentData, work: CurrentWork, value: UserStateValueMap["resume"], chapters: Map<string, CurrentChapter>,
): UserStateValueMap["resume"] {
  const chapter = value.chapter ? matchingCurrentChapter(data, work, value.chapter, chapters) : null;
  const reference = chapter ? currentChapterReference(data, chapter) : null;
  return reference && reference.chapterPath !== value.chapter?.chapterPath ? { ...value, chapter: reference } : value;
}
export function currentResumeValues(data: Pick<CurrentData, "resumes" | "appliedResumes">): Map<string, UserStateCurrentItem> {
  const result = new Map<string, UserStateCurrentItem>();
  for (const item of [...data.appliedResumes, ...data.resumes]) {
    if (item.entity.kind !== "resume") continue;
    const key = userStateWorkKey(item.entity.work);
    const previous = result.get(key);
    const value = item.value as UserStateValueMap["resume"];
    if (!value.chapter) { result.set(key, item); continue; }
    const merged = previous ? mergeUserStateCurrentResume(previous.value as UserStateValueMap["resume"], value) : value;
    result.set(key, { entity: item.entity, value: merged });
  }
  return result;
}

/** The same public DB position is the baseline for export and for recognizing its incoming echo. */
export function currentPublicResumeValues(data: CurrentData): Map<string, UserStateCurrentItem> {
  const chapters = new Map(data.chapters.map(chapter => [JSON.stringify([chapter.novelId, chapter.path]), chapter]));
  const byKey = new Map(data.works.map(work => [userStateWorkKey(work), work]));
  const normalize = (item: UserStateCurrentItem): UserStateCurrentItem => {
    if (item.entity.kind !== "resume") return item;
    const work = byKey.get(userStateWorkKey(item.entity.work));
    return work ? { ...item, value: currentResumeValue(data, work, item.value as UserStateValueMap["resume"], chapters) } : item;
  };
  const result = currentResumeValues({ resumes: data.resumes.map(normalize), appliedResumes: data.appliedResumes.map(normalize) });
  const works = new Map(data.works.map(work => [work.id, work]));
  for (const chapter of data.chapters) {
    const work = works.get(chapter.novelId);
    if (!work?.sourceNovelId || chapter.readAt === null || isCurrentWorkHeld(data.heldSources, work) || privateValueForChapter(data, work, chapter)) continue;
    const reference = currentChapterReference(data, chapter);
    if (!reference) continue;
    const key = userStateWorkKey(work);
    const previous = result.get(key);
    if (previous && !(previous.value as UserStateValueMap["resume"]).chapter) continue;
    const next: UserStateValueMap["resume"] = { chapter: reference, anchor: null, openedAt: chapter.readAt };
    result.set(key, { entity: { kind: "resume", work: currentWorkReference(work) },
      value: previous ? mergeUserStateCurrentResume(previous.value as UserStateValueMap["resume"], next) : next });
  }
  return result;
}

/** A displayed chapter name is not a change to its saved position or body ownership. */
export function sameCurrentResumePosition(left: UserStateValueMap["resume"], right: UserStateValueMap["resume"]): boolean {
  const position = (value: UserStateValueMap["resume"]) => ({ ...value, chapter: value.chapter ? {
    chapterPath: value.chapter.chapterPath,
    ...(/^norea-(?:composed|source):/.test(value.chapter.chapterPath) ? { compositionEntryId: value.chapter.compositionEntryId } : {}),
  } : null });
  return sameCurrentValue(position(left), position(right));
}

export async function buildCurrentSnapshotInDb(
  db: UserStateDb, binding: UserStateBinding, data: CurrentData,
): Promise<{ snapshot: UserStateCurrentSnapshot; missingMetadataCount: number }> {
  const items = new Map<string, UserStateCurrentItem>();
  const missing = new Set<string>();
  const byId = new Map(data.works.map(work => [work.id, work]));
  const byKey = new Map(data.works.filter(work => work.sourceNovelId).map(work => [userStateWorkKey(work), work]));
  const categoryIds = new Map<number, string>();
  const categoryMappings: { categoryId: string; localId: number }[] = [];
  const add = (item: UserStateCurrentItem) => {
    const key = userStateEntityKey(item.entity);
    if ("work" in item.entity && (!item.entity.work.sourceNovelId || isCurrentWorkHeld(data.heldSources, item.entity.work))) { missing.add(key); return; }
    items.set(key, parseUserStateCurrentItem(item));
  };
  for (const work of data.works) if (work.inLibrary) add({ entity: { kind: "library", work: currentWorkReference(work) }, value: { inLibrary: true, addedAt: work.addedAt } });
  for (const category of data.categories) {
    if (category.isSystem || !category.name.trim()) continue;
    const categoryId = await currentCategoryId(category.name);
    categoryIds.set(category.id, categoryId);
    categoryMappings.push({ categoryId, localId: category.id });
    const previous = items.get(userStateEntityKey({ kind: "category", categoryId }));
    add({ entity: { kind: "category", categoryId }, value: { name: category.name.trim(),
      sort: previous ? Math.min((previous.value as UserStateValueMap["category"]).sort, category.sort) : category.sort, deleted: false } });
  }
  const knownMappings = new Set(data.categoryIdentities.filter(row => row.localId !== null).map(row => JSON.stringify([row.categoryId, row.localId])));
  const newMappings = categoryMappings.filter(row => !knownMappings.has(JSON.stringify([row.categoryId, row.localId])));
  if (newMappings.length) await db.execute(`INSERT INTO user_state_category(category_id,local_id)
    SELECT json_extract(value,'$.categoryId'),json_extract(value,'$.localId') FROM json_each($1) WHERE true
    ON CONFLICT(category_id) DO UPDATE SET local_id=excluded.local_id`, [JSON.stringify(newMappings)]);
  for (const membership of data.memberships) {
    const work = byId.get(membership.novelId);
    const categoryId = categoryIds.get(membership.categoryId);
    if (work && categoryId) add({ entity: { kind: "membership", work: currentWorkReference(work), categoryId }, value: { included: true } });
  }
  for (const [novelId, composition] of data.compositions) {
    const work = byId.get(novelId);
    if (work) add({ entity: { kind: "composition", work: currentWorkReference(work) }, value: { composition } });
  }
  const resumeValues = currentPublicResumeValues(data);
  const chapterIndex = new Map(data.chapters.map(chapter => [JSON.stringify([chapter.novelId, chapter.path]), chapter]));
  for (const chapter of data.chapters) {
    const work = byId.get(chapter.novelId);
    if (!work) continue;
    const value = currentReadingValue(data, work, chapter);
    const positiveReading = value.progress > 0 || !value.unread || value.readAt !== null;
    const reference = currentChapterReference(data, chapter);
    if (!reference || !work.sourceNovelId) {
      if (positiveReading) missing.add(userStateEntityKey({ kind: "reading", work, chapter: { chapterPath: chapter.path } }));
      if (chapter.bookmark) missing.add(userStateEntityKey({ kind: "bookmark", work, chapter: { chapterPath: chapter.path } }));
      continue;
    }
    const portableWork = currentWorkReference(work);
    if (positiveReading) add({ entity: { kind: "reading", work: portableWork, chapter: reference }, value });
    if (chapter.bookmark) add({ entity: { kind: "bookmark", work: portableWork, chapter: reference }, value: { bookmarked: true } });
  }
  for (const item of resumeValues.values()) {
    if (item.entity.kind !== "resume") continue;
    const value = item.value as UserStateValueMap["resume"];
    if (!value.chapter) continue;
    const work = byKey.get(userStateWorkKey(item.entity.work));
    if (!work || !matchingCurrentChapter(data, work, value.chapter, chapterIndex)) { missing.add(userStateEntityKey(item.entity)); continue; }
    add({ entity: { ...item.entity, work: currentWorkReference(work) }, value });
  }
  return { snapshot: { version: 2, workspaceId: binding.workspaceId, epoch: binding.epoch, items: [...items.values()] }, missingMetadataCount: missing.size };
}
export const sameCurrentValue = (left: unknown, right: unknown): boolean => canonicalUserStateJson(left) === canonicalUserStateJson(right);

const minimumTime = (left: number | null, right: number | null): number | null =>
  left === null ? right : right === null ? left : Math.min(left, right);

export async function installCurrentStructureInDb(
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

type ResumeBodyOwner = Pick<ChapterSourceSnapshot, "pluginId" | "novelId" | "chapterPath" | "sourceChapterId">;
function sameResumeBodyOwner(left: ResumeBodyOwner, right: ResumeBodyOwner): boolean {
  const fold = (id: string) => id.replace(/[A-Z]/g, letter => letter.toLowerCase());
  return left.pluginId === right.pluginId && fold(left.novelId) === fold(right.novelId) &&
    (left.sourceChapterId && right.sourceChapterId ? left.sourceChapterId === right.sourceChapterId : left.chapterPath === right.chapterPath);
}

export async function applyCurrentSnapshotWithTransactionsInDb<TDb extends UserStateDb>(
  binding: UserStateBinding,
  snapshot: UserStateCurrentSnapshot,
  runTransaction: <T>(run: (db: TDb) => Promise<T>, remoteContentSync?: boolean) => Promise<T>,
  hold: HoldChapterDownloadSnapshot,
  retry?: { workKeys: readonly string[]; previousMissing: readonly string[] } | null,
): Promise<UserStateCurrentApplyResult> {
  if (snapshot.workspaceId !== binding.workspaceId || snapshot.epoch !== binding.epoch) {
    throw new Error("The current personal state workspace does not match this device.");
  }
  const retryKeys = retry ? new Set(retry.workKeys) : null;
  const items = retryKeys ? snapshot.items.filter(item => item.entity.kind === "category" ||
    "work" in item.entity && retryKeys.has(userStateWorkKey(item.entity.work))) : snapshot.items;
  const compositionKeys = new Set(items.flatMap(item => item.entity.kind === "composition" ? [userStateWorkKey(item.entity.work)] : []));
  const structure = await runTransaction(async db => {
    const result = await installCurrentStructureInDb(db, binding, items);
    const novelIds = result.works.filter(work => compositionKeys.has(userStateWorkKey(work))).map(work => work.id);
    const chapters = novelIds.length ? await db.select<{ id: number; novelId: number; path: string }[]>(
      "SELECT id,novel_id AS novelId,path FROM chapter WHERE novel_id IN (SELECT value FROM json_each($1))", [JSON.stringify(novelIds)],
    ) : [];
    return { ...result, chapters };
  }, true);
  const previousChapterIds = new Map(structure.chapters.map(chapter => [JSON.stringify([chapter.novelId, chapter.path]), chapter.id]));
  const previousCompositionEntryIds = new Map<string, string>();
  const previousCompositionOwners = new Map<string, ResumeBodyOwner>();
  const changedCompositionNovels = new Set<number>();
  const byKey = new Map(structure.works.filter(work => work.sourceNovelId).map(work => [userStateWorkKey(work), work]));
  const missing = structure.missing;
  let changed = structure.changed;
  for (const item of items) {
    if (item.entity.kind !== "composition") continue;
    if (isCurrentWorkHeld(structure.heldSources, item.entity.work)) { missing.add(userStateEntityKey(item.entity)); continue; }
    const work = byKey.get(userStateWorkKey(item.entity.work));
    if (!work) { missing.add(userStateEntityKey(item.entity)); continue; }
    try {
      const applied = await runTransaction(async db => {
        await requireBinding(db, binding); await assertUserStateAvailableInDb(db);
        if (isCurrentWorkHeld(await loadCurrentHeldSourcesInDb(db, binding.serverUrl), work)) throw new Error("The source work is held by its saved migration.");
        const current = await getChapterComposition(db, work.id);
        const shared = (item.value as UserStateValueMap["composition"]).composition;
        const incomingWins = !current || shared.updatedAt > current.updatedAt ||
          shared.updatedAt === current.updatedAt && canonicalUserStateJson(shared) < canonicalUserStateJson(current);
        if (!incomingWins) return false;
        const composition = mergeUserStateComposition(shared, current, { pluginId: work.pluginId, sourceNovelId: work.sourceNovelId! });
        if (sameCurrentValue(current, composition)) return false;
        for (const entry of current?.entries ?? []) {
          const key = JSON.stringify([work.id, entry.path]);
          previousCompositionEntryIds.set(key, entry.id);
          previousCompositionOwners.set(key, entry.sources[entry.primarySource]);
        }
        await materializeChapterComposition(db, work.id, composition);
        await setChapterComposition(db, work.id, composition);
        return true;
      }, true);
      changed ||= applied;
      if (applied) changedCompositionNovels.add(work.id);
    } catch (error) {
      missing.add(userStateEntityKey(item.entity));
      console.warn("[user-state] current composition is waiting for its original metadata", error);
    }
  }
  return runTransaction(async db => {
    await requireBinding(db, binding); await assertUserStateAvailableInDb(db);
    const data = await loadCurrentDataInDb(db, binding, hold, items);
    const works = new Map(data.works.filter(work => work.sourceNovelId).map(work => [userStateWorkKey(work), work]));
    const chapters = new Map(data.chapters.map(chapter => [JSON.stringify([chapter.novelId, chapter.path]), chapter]));
    const updates = new Map<number, { id: number; progress: number; unread: number; readAt: number | null; bookmark: number }>();
    const privateUpdates = new Map<string, UserStateValueMap["reading"]>();
    const affectedNovels = new Set<number>();
    const changedBodyPaths = new Set<string>();
    for (const novelId of changedCompositionNovels) {
      const work = data.works.find(work => work.id === novelId)!;
      for (const entry of data.compositions.get(novelId)?.entries ?? []) {
        const key = JSON.stringify([novelId, entry.path]);
        const previousOwner = previousCompositionOwners.get(key) ??
          { pluginId: work.pluginId, novelId: work.sourceNovelId!, chapterPath: entry.path };
        if (!sameResumeBodyOwner(previousOwner, entry.sources[entry.primarySource]))
          changedBodyPaths.add(JSON.stringify([userStateWorkKey(work), entry.path]));
      }
    }
    const clearedResumeReferences = new Map<string, { entityKey: string; chapterPath: string }>();
    const localResumeItems = new Set(data.resumes);
    for (const item of [...data.appliedResumes, ...data.resumes]) {
      if (item.entity.kind !== "resume") continue;
      const value = item.value as UserStateValueMap["resume"];
      if (!value.chapter || !value.anchor || !changedBodyPaths.has(JSON.stringify([userStateWorkKey(item.entity.work), value.chapter.chapterPath]))) continue;
      item.value = { ...value, anchor: null };
      if (localResumeItems.has(item)) {
        for (const entityKey of [userStateEntityKey(item.entity),
          userStateEntityKey({ ...item.entity, work: { ...item.entity.work, sourceNovelId: null } })]) {
          const reference = { entityKey, chapterPath: value.chapter.chapterPath };
          clearedResumeReferences.set(JSON.stringify(reference), reference);
        }
      }
    }
    if (clearedResumeReferences.size) await db.execute(
      `UPDATE user_state_intent SET value_json=json_set(value_json,'$.anchor',NULL)
        WHERE json_extract(entity_json,'$.kind')='resume'
          AND entity_key IN (SELECT json_extract(value,'$.entityKey') FROM json_each($1))
          AND EXISTS (SELECT 1 FROM json_each($1) changed
            WHERE user_state_intent.entity_key=json_extract(changed.value,'$.entityKey')
              AND json_extract(user_state_intent.value_json,'$.chapter.chapterPath')=json_extract(changed.value,'$.chapterPath'))`,
      [JSON.stringify([...clearedResumeReferences.values()])],
    );
    const resumes = currentPublicResumeValues(data);
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
        const incoming = currentResumeValue(data, work, item.value as UserStateValueMap["resume"], chapters);
        const value = previous ? mergeUserStateCurrentResume(previous.value as UserStateValueMap["resume"], incoming) : incoming;
        const target = value.chapter ? matchingCurrentChapter(data, work, value.chapter, chapters) : null;
        const targetKey = target ? JSON.stringify([work.id, target.path]) : "";
        const nextEntry = target && changedCompositionNovels.has(work.id)
          ? data.compositions.get(work.id)?.entries.find(entry => entry.path === target.path) : undefined;
        const previousOwner = previousCompositionOwners.get(targetKey) ??
          { pluginId: work.pluginId, novelId: work.sourceNovelId!, chapterPath: target?.path ?? "" };
        const retargeted = target && changedCompositionNovels.has(work.id) &&
          (previousChapterIds.get(targetKey) !== target.id || /^norea-(?:composed|source):/.test(target.path) &&
            previousCompositionEntryIds.get(targetKey) !== value.chapter?.compositionEntryId ||
            nextEntry && !sameResumeBodyOwner(previousOwner, nextEntry.sources[nextEntry.primarySource]));
        if (!previous || !sameCurrentResumePosition(previous.value as UserStateValueMap["resume"], value) || retargeted) {
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
    const currentResumes = [...resumes.values()].filter(item => {
      if (!(item.value as UserStateValueMap["resume"]).chapter) return false;
      try { parseUserStateCurrentItem(item); return true; }
      catch { missing.add(userStateEntityKey(item.entity)); return false; }
    });
    const missingKeys = [...new Set([...(retry?.previousMissing ?? []).filter(key => !handled.has(key)), ...missing])];
    effects.missingMetadataCount = missingKeys.length;
    await db.execute("INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2),($3,$4) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload",
      [currentCacheKey(binding), JSON.stringify({ snapshot, missingKeys }),
        currentStatusKey(binding), JSON.stringify({ resumes: currentResumes, missingMetadataCount: missingKeys.length })]);
    if (!retry) await db.execute("UPDATE user_state_workspace SET last_success_at=$2 WHERE server_url=$1", [binding.serverUrl, Date.now()]);
    return effects;
  }, true);
}
