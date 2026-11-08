import { parseChapterComposition, type ChapterCompositionEntry, type ChapterCompositionV1, type ChapterSourceSnapshot } from "../chapter-composition";

export interface UserStateCompositionOwner { pluginId: string; sourceNovelId: string }

function fold(value: string): string {
  return value.replace(/[A-Z]/g, character => character.toLowerCase());
}
function workKey(source: ChapterSourceSnapshot): string {
  return JSON.stringify([source.pluginId, fold(source.novelId)]);
}
function pathKey(source: ChapterSourceSnapshot): string {
  return JSON.stringify([workKey(source), source.chapterPath]);
}
function idKey(source: ChapterSourceSnapshot): string | undefined {
  return source.sourceChapterId === undefined ? undefined : JSON.stringify([workKey(source), source.sourceChapterId]);
}
function sameSource(left: ChapterSourceSnapshot, right: ChapterSourceSnapshot): boolean {
  return workKey(left) === workKey(right) && (left.sourceChapterId && right.sourceChapterId
    ? left.sourceChapterId === right.sourceChapterId : left.chapterPath === right.chapterPath);
}

function sourceIndex(composition: ChapterCompositionV1): (source: ChapterSourceSnapshot) => ChapterSourceSnapshot | undefined {
  const byId = new Map<string, ChapterSourceSnapshot | null>();
  const byPath = new Map<string, ChapterSourceSnapshot | null>();
  const insert = (map: Map<string, ChapterSourceSnapshot | null>, key: string, source: ChapterSourceSnapshot) => {
    const previous = map.get(key);
    if (previous === undefined) map.set(key, source);
    else if (previous !== null && JSON.stringify(previous) !== JSON.stringify(source)) map.set(key, null);
  };
  for (const entry of composition.entries) for (const source of entry.sources) {
    const key = idKey(source);
    if (key !== undefined) insert(byId, key, source);
    insert(byPath, pathKey(source), source);
  }
  return source => {
    const key = idKey(source);
    if (key !== undefined && byId.has(key)) return byId.get(key) ?? undefined;
    const candidate = byPath.get(pathKey(source));
    return candidate && sameSource(source, candidate) ? candidate : undefined;
  };
}

function originIndex(composition: ChapterCompositionV1): {
  has: (source: ChapterSourceSnapshot) => boolean;
  add: (source: ChapterSourceSnapshot) => void;
} {
  const ids = new Set<string>();
  const paths = new Map<string, Set<string | undefined>>();
  const add = (source: ChapterSourceSnapshot) => {
    const id = idKey(source);
    if (id !== undefined) ids.add(id);
    const path = pathKey(source);
    const known = paths.get(path) ?? new Set<string | undefined>();
    known.add(source.sourceChapterId); paths.set(path, known);
  };
  for (const entry of composition.entries) for (const source of entry.sources) add(source);
  return { add, has: source => {
    const id = idKey(source);
    if (id !== undefined && ids.has(id)) return true;
    const known = paths.get(pathKey(source));
    return !!known && (source.sourceChapterId === undefined || known.has(undefined) || known.has(source.sourceChapterId));
  } };
}

function isProviderAddition(entry: ChapterCompositionEntry, owner: UserStateCompositionOwner): boolean {
  if (entry.sources.length !== 1 || entry.primarySource !== 0 || !entry.user.included ||
    entry.user.name !== null || entry.user.chapterNumber !== String(entry.user.order)) return false;
  const source = entry.sources[0];
  if (source.pluginId !== owner.pluginId || fold(source.novelId) !== fold(owner.sourceNovelId)) return false;
  const recoveredPath = `norea-source:${encodeURIComponent(source.pluginId)}:${encodeURIComponent(source.novelId)}:${encodeURIComponent(source.chapterPath)}`;
  return entry.path === source.chapterPath || entry.path === recoveredPath;
}

/**
 * The shared CAS document owns user choices. A later provider snapshot may only
 * refresh exact origins or append unedited chapters of the target provider work.
 * Clock values select source facts, never a winner between manual edits.
 */
export function mergeUserStateComposition(
  sharedValue: ChapterCompositionV1,
  currentValue: ChapterCompositionV1 | null,
  owner: UserStateCompositionOwner,
): ChapterCompositionV1 {
  const shared = parseChapterComposition(sharedValue);
  if (currentValue === null) return shared;
  const current = parseChapterComposition(currentValue);
  if (current.updatedAt <= shared.updatedAt) return shared;
  const currentSource = sourceIndex(current);
  const retainedOrigins = originIndex(shared);
  const result = structuredClone(shared);
  const ids = new Set(result.entries.map(entry => entry.id));
  const paths = new Set(result.entries.map(entry => entry.path));
  const storage = new Set(result.entries.map(entry => entry.storageChapterNumber));
  for (const entry of result.entries) {
    entry.sources = entry.sources.map(source => structuredClone(currentSource(source) ?? source));
    for (const source of entry.sources) retainedOrigins.add(source);
  }
  let order = result.entries.filter(entry => entry.user.included).length;
  for (const entry of current.entries) {
    if (!isProviderAddition(entry, owner) || retainedOrigins.has(entry.sources[0])) continue;
    // A reused identifier or physical key cannot prove that an existing body belongs here.
    if (ids.has(entry.id) || paths.has(entry.path) || storage.has(entry.storageChapterNumber)) {
      throw new Error("User state: a newly discovered chapter conflicts with retained composition storage");
    }
    const added = structuredClone(entry);
    added.user.order = ++order;
    added.user.chapterNumber = String(order);
    result.entries.push(added);
    for (const source of added.sources) retainedOrigins.add(source);
    ids.add(added.id); paths.add(added.path); storage.add(added.storageChapterNumber);
  }
  if (JSON.stringify(result.entries) !== JSON.stringify(shared.entries)) result.updatedAt = current.updatedAt;
  return parseChapterComposition(result);
}
