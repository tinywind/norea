import { parseChapterComposition, type ChapterCompositionV1 } from "../lib/chapter-composition";
import type { ChapterContentType } from "../lib/chapter-content";
import type { HoldChapterDownloadSnapshot } from "../lib/chapter-download-writes";
import { parseStoredChapterPath, storedChapterDigest, storedChapterNumber, storedChapterPath } from "../lib/user-state/stored-chapter";
import {
  canonicalUserStateJson, parseUserStateEntity, parseUserStateValue, userStateEntityKey, userStateWorkKey,
  type UserStateBinding, type UserStateChapterReference, type UserStateValueMap, type UserStateWorkReference,
} from "../lib/user-state/types";
import {
  mergeUserStateCurrentResume, parseUserStateCurrentItem,
  type UserStateCurrentItem, type UserStateCurrentSnapshot,
} from "../lib/user-state/current-types";
import { namespaceFor, type UserStateDb } from "./user-state-core";

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
      const { inspectChapterPayloadInventory } = await import("../lib/chapter-content/storage-platform");
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
