import type { NovelMergeCompositionEntry } from "../../lib/novel-merge-composition";
import type { NovelMergeChapterMatching } from "../../lib/novel-merge-matching";

export type CompositionSide = "source" | "target";

export interface CompositionSourceChapter {
  id: number;
  name: string;
  chapterNumber: string | null;
  isDownloaded: boolean;
  contentBytes?: number;
  unread: boolean;
  progress: number;
}

export interface CompositionTargetChapter {
  path: string;
  name: string;
  chapterNumber: number;
}

export interface CompositionSummary {
  total: number;
  paired: number;
  sourceOnly: number;
  targetOnly: number;
  excludedSource: number;
  excludedTarget: number;
}

function entryKey(sourceChapterIds: readonly number[], targetChapterPath?: string): string {
  return targetChapterPath === undefined
    ? `source:${sourceChapterIds.join(",")}`
    : `target:${targetChapterPath}`;
}

function normalizeEntry(entry: NovelMergeCompositionEntry): NovelMergeCompositionEntry | null {
  if (entry.sourceChapterIds.length === 0 && entry.targetChapterPath === undefined) return null;
  return {
    ...entry,
    key: entryKey(entry.sourceChapterIds, entry.targetChapterPath),
    primary: entry.targetChapterPath === undefined
      ? "source"
      : entry.sourceChapterIds.length === 0
        ? "target"
        : entry.primary,
  };
}

/** Keep both catalogs. Only established matches share a final chapter. */
export function createInitialComposition(
  sourceChapters: readonly (Pick<CompositionSourceChapter, "id"> & Partial<Pick<CompositionSourceChapter, "isDownloaded" | "contentBytes">>)[],
  targetChapters: readonly Pick<CompositionTargetChapter, "path">[],
  matching: NovelMergeChapterMatching,
): NovelMergeCompositionEntry[] {
  const knownSources = new Set(sourceChapters.map(chapter => chapter.id));
  const downloadedSources = new Set(sourceChapters.filter(chapter => chapter.isDownloaded || (chapter.contentBytes ?? 0) > 0).map(chapter => chapter.id));
  const knownTargets = new Set(targetChapters.map(chapter => chapter.path));
  const sourceByTarget = new Map<string, number>();
  const targetBySource = new Map<number, string>();
  for (const match of matching.matched) {
    if (!knownSources.has(match.sourceChapterId) || !knownTargets.has(match.targetChapterPath)) continue;
    if (sourceByTarget.has(match.targetChapterPath) || targetBySource.has(match.sourceChapterId)) continue;
    sourceByTarget.set(match.targetChapterPath, match.sourceChapterId);
    targetBySource.set(match.sourceChapterId, match.targetChapterPath);
  }

  const before = new Map<string, NovelMergeCompositionEntry[]>();
  const after = new Map<string, NovelMergeCompositionEntry[]>();
  let previousTarget: string | undefined;
  let pending: NovelMergeCompositionEntry[] = [];
  for (const chapter of sourceChapters) {
    const target = targetBySource.get(chapter.id);
    if (target === undefined) {
      pending.push({
        key: entryKey([chapter.id]),
        sourceChapterIds: [chapter.id],
        primary: "source",
      });
      continue;
    }
    if (pending.length > 0) {
      const bucket = previousTarget === undefined ? before : after;
      const anchor = previousTarget ?? target;
      bucket.set(anchor, [...(bucket.get(anchor) ?? []), ...pending]);
      pending = [];
    }
    previousTarget = target;
  }
  if (previousTarget !== undefined && pending.length > 0) {
    after.set(previousTarget, [...(after.get(previousTarget) ?? []), ...pending]);
    pending = [];
  }

  const entries = targetChapters.flatMap((chapter): NovelMergeCompositionEntry[] => {
    const source = sourceByTarget.get(chapter.path);
    return [
      ...(before.get(chapter.path) ?? []),
      {
        key: entryKey([], chapter.path),
        sourceChapterIds: source === undefined ? [] : [source],
        targetChapterPath: chapter.path,
        primary: source !== undefined && downloadedSources.has(source) ? "source" : "target",
      },
      ...(after.get(chapter.path) ?? []),
    ];
  });
  return [...entries, ...pending];
}

export function selectCompositionRange<T extends string | number>(
  orderedKeys: readonly T[],
  from: number,
  to: number,
): Set<T> {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || orderedKeys.length === 0) return new Set();
  const start = Math.max(1, Math.min(from, to));
  const end = Math.min(orderedKeys.length, Math.max(from, to));
  return new Set(start <= end ? orderedKeys.slice(start - 1, end) : []);
}

export function toggleCompositionSelection<T extends string | number>(
  selection: ReadonlySet<T>,
  orderedKeys: readonly T[],
  key: T,
  anchor: T | null,
  extend: boolean,
): Set<T> {
  const next = new Set(selection);
  const targetIndex = orderedKeys.indexOf(key);
  const anchorIndex = anchor === null ? -1 : orderedKeys.indexOf(anchor);
  if (extend && anchorIndex >= 0 && targetIndex >= 0) {
    const selected = selectCompositionRange(orderedKeys, anchorIndex + 1, targetIndex + 1);
    for (const item of selected) next.add(item);
  } else if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function insertEntries(
  entries: readonly NovelMergeCompositionEntry[],
  additions: readonly NovelMergeCompositionEntry[],
  beforeKey?: string,
): NovelMergeCompositionEntry[] {
  if (additions.length === 0) return [...entries];
  const beforeIndex = beforeKey === undefined ? -1 : entries.findIndex(entry => entry.key === beforeKey);
  const index = beforeIndex < 0 ? entries.length : beforeIndex;
  return [...entries.slice(0, index), ...additions, ...entries.slice(index)];
}

export function includeSourceChapters(
  entries: readonly NovelMergeCompositionEntry[],
  sourceChapterIds: readonly number[],
  beforeKey?: string,
): NovelMergeCompositionEntry[] {
  const included = new Set(entries.flatMap(entry => entry.sourceChapterIds));
  const additions: NovelMergeCompositionEntry[] = [];
  for (const id of sourceChapterIds) {
    if (included.has(id)) continue;
    included.add(id);
    additions.push({ key: entryKey([id]), sourceChapterIds: [id], primary: "source" });
  }
  return insertEntries(entries, additions, beforeKey);
}

export function includeTargetChapters(
  entries: readonly NovelMergeCompositionEntry[],
  targetChapterPaths: readonly string[],
  beforeKey?: string,
): NovelMergeCompositionEntry[] {
  const included = new Set(entries.flatMap(entry => entry.targetChapterPath === undefined ? [] : [entry.targetChapterPath]));
  const additions: NovelMergeCompositionEntry[] = [];
  for (const path of targetChapterPaths) {
    if (included.has(path)) continue;
    included.add(path);
    additions.push({ key: entryKey([], path), sourceChapterIds: [], targetChapterPath: path, primary: "target" });
  }
  return insertEntries(entries, additions, beforeKey);
}

/** Excluding one side of a pair must preserve the other side. */
export function excludeCompositionOrigins(
  entries: readonly NovelMergeCompositionEntry[],
  sourceIds: ReadonlySet<number>,
  targetPaths: ReadonlySet<string>,
): NovelMergeCompositionEntry[] {
  return entries.flatMap(entry => {
    const next = normalizeEntry({
      ...entry,
      sourceChapterIds: entry.sourceChapterIds.filter(id => !sourceIds.has(id)),
      targetChapterPath: entry.targetChapterPath !== undefined && targetPaths.has(entry.targetChapterPath)
        ? undefined
        : entry.targetChapterPath,
    });
    return next ? [next] : [];
  });
}

/** Selected catalog ranges pair in catalog order, without discarding former partners. */
export function pairCompositionRanges(
  entries: readonly NovelMergeCompositionEntry[],
  sourceIds: readonly number[],
  targetPaths: readonly string[],
  preferredSourceIds: ReadonlySet<number> = new Set(),
): NovelMergeCompositionEntry[] {
  if (sourceIds.length === 0 || sourceIds.length !== targetPaths.length) return [...entries];
  if (new Set(sourceIds).size !== sourceIds.length || new Set(targetPaths).size !== targetPaths.length) return [...entries];
  const selectedSources = new Set(sourceIds);
  const pairByTarget = new Map(targetPaths.map((path, index) => [path, sourceIds[index]!]));
  const placed = new Set<string>();
  const result: NovelMergeCompositionEntry[] = [];
  for (const entry of entries) {
    const path = entry.targetChapterPath;
    const pairedSource = path === undefined ? undefined : pairByTarget.get(path);
    const retained = normalizeEntry({
      ...entry,
      sourceChapterIds: entry.sourceChapterIds.filter(id => !selectedSources.has(id)),
      targetChapterPath: pairedSource === undefined ? path : undefined,
    });
    if (pairedSource !== undefined && path !== undefined) {
      result.push({
        key: entryKey([], path),
        sourceChapterIds: [pairedSource],
        targetChapterPath: path,
        primary: preferredSourceIds.has(pairedSource) ? "source" : "target",
        ...(entry.name === undefined ? {} : { name: entry.name }),
      });
      placed.add(path);
    }
    if (retained) result.push(retained);
  }
  for (const path of targetPaths) {
    if (placed.has(path)) continue;
    result.push({
      key: entryKey([], path),
      sourceChapterIds: [pairByTarget.get(path)!],
      targetChapterPath: path,
      primary: preferredSourceIds.has(pairByTarget.get(path)!) ? "source" : "target",
    });
  }
  return result;
}

export function splitCompositionEntries(
  entries: readonly NovelMergeCompositionEntry[],
  selection: ReadonlySet<string>,
): NovelMergeCompositionEntry[] {
  return entries.flatMap(entry => {
    if (!selection.has(entry.key) || entry.sourceChapterIds.length === 0 || entry.targetChapterPath === undefined) return [entry];
    return [
      ...entry.sourceChapterIds.map(id => ({
        key: entryKey([id]), sourceChapterIds: [id], primary: "source" as const,
      })),
      { ...entry, sourceChapterIds: [], primary: "target" as const },
    ];
  });
}

/** Position is one-based in the final result, after the selected block is removed. */
export function moveCompositionEntries(
  entries: readonly NovelMergeCompositionEntry[],
  selection: ReadonlySet<string>,
  position: number,
): NovelMergeCompositionEntry[] {
  if (!Number.isSafeInteger(position) || selection.size === 0) return [...entries];
  const moving = entries.filter(entry => selection.has(entry.key));
  const remaining = entries.filter(entry => !selection.has(entry.key));
  const index = Math.min(remaining.length, Math.max(0, position - 1));
  return [...remaining.slice(0, index), ...moving, ...remaining.slice(index)];
}

export function summarizeComposition(
  entries: readonly NovelMergeCompositionEntry[],
  sourceChapters: readonly Pick<CompositionSourceChapter, "id">[],
  targetChapters: readonly Pick<CompositionTargetChapter, "path">[],
): CompositionSummary {
  const sources = new Set(entries.flatMap(entry => entry.sourceChapterIds));
  const targets = new Set(entries.flatMap(entry => entry.targetChapterPath === undefined ? [] : [entry.targetChapterPath]));
  return {
    total: entries.length,
    paired: entries.filter(entry => entry.sourceChapterIds.length > 0 && entry.targetChapterPath !== undefined).length,
    sourceOnly: entries.filter(entry => entry.targetChapterPath === undefined).length,
    targetOnly: entries.filter(entry => entry.sourceChapterIds.length === 0).length,
    excludedSource: sourceChapters.filter(chapter => !sources.has(chapter.id)).length,
    excludedTarget: targetChapters.filter(chapter => !targets.has(chapter.path)).length,
  };
}

/** Re-review changed catalogs without reviving exclusions or discarding an edited order. */
export function refreshCompositionCatalog(input: {
  composition: readonly NovelMergeCompositionEntry[];
  previousSourceChapterIds: readonly number[];
  previousTargetChapterPaths: readonly string[];
  sourceChapterIds: readonly number[];
  targetChapterPaths: readonly string[];
}): NovelMergeCompositionEntry[] {
  const sources = new Set(input.sourceChapterIds);
  const targets = new Set(input.targetChapterPaths);
  const previousSources = new Set(input.previousSourceChapterIds);
  const previousTargets = new Set(input.previousTargetChapterPaths);
  const retained = excludeCompositionOrigins(input.composition,
    new Set(input.composition.flatMap(entry => entry.sourceChapterIds).filter(id => !sources.has(id))),
    new Set(input.composition.flatMap(entry => entry.targetChapterPath === undefined ? [] : [entry.targetChapterPath]).filter(path => !targets.has(path))),
  );
  return includeTargetChapters(
    includeSourceChapters(retained, input.sourceChapterIds.filter(id => !previousSources.has(id))),
    input.targetChapterPaths.filter(path => !previousTargets.has(path)),
  );
}
