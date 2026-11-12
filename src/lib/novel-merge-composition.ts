import { listChaptersByNovel, type ChapterListRow } from "../db/queries/chapter";
import type { NovelMergeChapterDecision } from "../db/queries/novel-merge";
import type { NovelDetailRecord } from "../db/queries/novel";
import type { ChapterCompositionV1, ChapterCompositionEntry, ChapterSourceSnapshot } from "./chapter-composition";
import { includedChapterCompositionEntries, parseChapterComposition } from "./chapter-composition";
import { refreshChapterComposition } from "./chapter-composition-refresh";
import { getDb } from "../db/client";
import { getChapterComposition } from "../db/chapter-composition";
import type { SourceNovel } from "./plugins/types";

/** The array order is the reading order; provider numbers never identify a selection. */
export interface NovelMergeCompositionEntry {
  key: string;
  sourceChapterIds: number[];
  targetChapterPath?: string;
  primary: "source" | "target";
  name?: string;
}

export interface ReviewedNovelMergeChapterCatalog {
  sourceChapterIds: readonly number[];
  targetChapterPaths: readonly string[];
}

export function validateReviewedNovelMergeCatalog(
  reviewed: ReviewedNovelMergeChapterCatalog | undefined,
  source: readonly Pick<ChapterListRow, "id">[],
  target: readonly Pick<ChapterListRow, "path">[],
): void {
  const same = <T,>(expected: readonly T[], actual: readonly T[]) => {
    const values = new Set(expected);
    return values.size === expected.length && values.size === actual.length && actual.every(value => values.has(value));
  };
  if (!reviewed || !same(reviewed.sourceChapterIds, source.map(row => row.id)) ||
      !same(reviewed.targetChapterPaths, target.map(row => row.path))) {
    throw new Error("NOVEL_MERGE_CATALOG_CHANGED");
  }
}

export interface CompiledNovelMergeComposition {
  composition: ChapterCompositionV1;
  decisions: NovelMergeChapterDecision[];
  targetChapters: ChapterListRow[];
  artifactSourceChapterIdByTargetPath: Record<string, number>;
  /** Seed reading state when a selected A edition replaces an existing B edition. */
  readingStateSourcePathByTargetPath: Record<string, string>;
  skipSourceContentChapterIds: number[];
}

/** Preserve an existing B arrangement while previewing fresh provider metadata. */
export async function resolveNovelMergeTargetPreview(pluginId: string, detail: SourceNovel): Promise<SourceNovel> {
  const db = await getDb();
  const [novel] = await db.select<{ id: number }[]>(
    "SELECT id FROM novel WHERE plugin_id=$1 AND (path=$2 OR source_novel_id=$3) ORDER BY CASE WHEN path=$2 THEN 0 ELSE 1 END LIMIT 1",
    [pluginId, detail.path, detail.novelId],
  );
  if (!novel) return detail;
  const previous = await getChapterComposition(db, novel.id);
  if (!previous) {
    // A provider can temporarily omit an episode that is still stored locally.
    // Show it in the editor so absence from the provider never means user exclusion.
    const paths = new Set(detail.chapters.map(chapter => chapter.path));
    const stored = await listChaptersByNovel(novel.id);
    const missing = stored.filter(chapter => !paths.has(chapter.path)).map(chapter => ({
      path: chapter.path, name: chapter.name, chapterNumber: Number(chapter.chapterNumber ?? chapter.position),
      page: chapter.page, releaseTime: chapter.releaseTime ?? undefined, contentType: chapter.sourceContentType,
    }));
    return missing.length ? { ...detail, chapters: [...detail.chapters, ...missing].sort((a, b) => a.chapterNumber - b.chapterNumber) } : detail;
  }
  const composition = refreshChapterComposition(previous,
    { pluginId, novelId: detail.novelId, novelPath: detail.path }, detail.chapters);
  return { ...detail, chapters: includedChapterCompositionEntries(composition).map(entry => {
    const primary = entry.sources[entry.primarySource];
    return { path: entry.path, chapterNumber: Number(entry.user.chapterNumber ?? entry.user.order),
      name: entry.user.name ?? primary.name, page: primary.page, releaseTime: primary.releaseTime ?? undefined,
      contentType: primary.contentType };
  }) };
}

function originKey(source: ChapterSourceSnapshot): string {
  return JSON.stringify([source.pluginId, source.novelId, source.chapterPath]);
}

function sourceSnapshot(novel: NovelDetailRecord, chapter: ChapterListRow): ChapterSourceSnapshot {
  if (!novel.sourceNovelId) throw new Error("A composition requires the source's stable work ID.");
  return {
    pluginId: novel.pluginId, novelId: novel.sourceNovelId, novelPath: novel.path,
    chapterPath: chapter.path, chapterNumber: chapter.chapterNumber, name: chapter.name,
    position: chapter.position, page: chapter.page, contentType: chapter.sourceContentType,
    releaseTime: chapter.releaseTime,
  };
}

function originalSources(novel: NovelDetailRecord, chapter: ChapterListRow, composition?: ChapterCompositionV1 | null): {
  sources: ChapterSourceSnapshot[]; primary: ChapterSourceSnapshot; entry?: ChapterCompositionEntry;
} {
  const entry = composition?.entries.find(row => row.path === chapter.path);
  const sources = entry ? entry.sources.map(source => ({ ...source })) : [sourceSnapshot(novel, chapter)];
  const primary = sources[entry?.primarySource ?? 0];
  if (!primary) throw new Error("A composition chapter has no primary source.");
  return { sources, primary, ...(entry ? { entry } : {}) };
}

export function validateNovelMergeComposition(
  entries: readonly NovelMergeCompositionEntry[],
  sourceChapters: readonly Pick<ChapterListRow, "id">[],
  targetChapters: readonly Pick<ChapterListRow, "path">[],
): void {
  if (!entries.length) throw new Error("The final chapter list must contain at least one chapter.");
  if (entries.length > 100_000) throw new Error("The final chapter list exceeds the supported chapter limit.");
  const sources = new Set(sourceChapters.map(chapter => chapter.id));
  const targets = new Set(targetChapters.map(chapter => chapter.path));
  const usedSources = new Set<number>(), usedTargets = new Set<string>(), keys = new Set<string>();
  for (const entry of entries) {
    if (!entry.key || keys.has(entry.key)) throw new Error("Every final chapter must have a unique editor identity.");
    keys.add(entry.key);
    if (!entry.sourceChapterIds.length && !entry.targetChapterPath) throw new Error("A final chapter must retain an original source.");
    if (entry.sourceChapterIds.length > 1) throw new Error("Pair one chapter from each source in each final row.");
    if (entry.primary === "source" && !entry.sourceChapterIds.length || entry.primary === "target" && !entry.targetChapterPath) {
      throw new Error("The selected primary source is not part of its final chapter.");
    }
    if (entry.primary !== "source" && entry.primary !== "target") throw new Error("Invalid primary chapter source.");
    if (entry.name !== undefined && (!entry.name.trim() || entry.name.length > 4096)) throw new Error("Invalid custom chapter title.");
    for (const id of entry.sourceChapterIds) {
      if (!sources.has(id) || usedSources.has(id)) throw new Error("An original chapter is missing or appears more than once in the final list.");
      usedSources.add(id);
    }
    if (entry.targetChapterPath) {
      if (!targets.has(entry.targetChapterPath) || usedTargets.has(entry.targetChapterPath)) {
        throw new Error("A destination chapter is missing or appears more than once in the final list.");
      }
      usedTargets.add(entry.targetChapterPath);
    }
  }
}

export function compileNovelMergeComposition(input: {
  entries: readonly NovelMergeCompositionEntry[];
  sourceNovel: NovelDetailRecord;
  targetNovel: NovelDetailRecord;
  sourceChapters: readonly ChapterListRow[];
  targetChapters: readonly ChapterListRow[];
  sourceComposition?: ChapterCompositionV1 | null;
  targetComposition?: ChapterCompositionV1 | null;
  newId?: () => string;
  now?: number;
}): CompiledNovelMergeComposition {
  validateNovelMergeComposition(input.entries, input.sourceChapters, input.targetChapters);
  const sourceById = new Map(input.sourceChapters.map(chapter => [chapter.id, chapter]));
  const targetByPath = new Map(input.targetChapters.map(chapter => [chapter.path, chapter]));
  const newId = input.newId ?? (() => crypto.randomUUID());
  const allNumbers = [...input.targetChapters.map(row => Number(row.chapterNumber)),
    ...(input.targetComposition?.entries.map(row => Number(row.storageChapterNumber)) ?? [])];
  let nextStorageNumber = allNumbers.reduce((maximum, value) => Number.isFinite(value) ? Math.max(maximum, Math.ceil(value)) : maximum, 0);
  const usedSources = new Set<number>();
  const entries: ChapterCompositionEntry[] = [];
  const targetChapters: ChapterListRow[] = [];
  const decisions: NovelMergeChapterDecision[] = [];
  const artifactSourceChapterIdByTargetPath: Record<string, number> = {};
  const readingStateSourcePathByTargetPath: Record<string, string> = {};
  const skipSourceContentChapterIds: number[] = [];

  for (const [index, choice] of input.entries.entries()) {
    const originalChapters = choice.sourceChapterIds.map(id => sourceById.get(id)!);
    const target = choice.targetChapterPath ? targetByPath.get(choice.targetChapterPath)! : undefined;
    const a = originalChapters.map(chapter => originalSources(input.sourceNovel, chapter, input.sourceComposition));
    const b = target ? originalSources(input.targetNovel, target, input.targetComposition) : undefined;
    const primary = choice.primary === "target" ? b!.primary : a[0]!.primary;
    const sources = [...new Map([...a.flatMap(value => value.sources), ...(b?.sources ?? [])]
      .map(source => [originKey(source), source])).values()];
    // A chosen A edition receives a distinct storage identity. An existing B download
    // can therefore never satisfy a later server-first request for the chosen A body.
    const retainTarget = choice.primary === "target" && target;
    const id = retainTarget && b?.entry ? b.entry.id : newId();
    const path = retainTarget ? target.path : `norea-composed:${id}`;
    const storageChapterNumber = retainTarget && target.chapterNumber !== null
      ? target.chapterNumber : String(++nextStorageNumber);
    if (!/^\d+(?:\.\d+)?$/.test(storageChapterNumber) || !Number.isSafeInteger(nextStorageNumber)) {
      throw new Error("The composition cannot allocate a safe chapter storage identity.");
    }
    const entry: ChapterCompositionEntry = {
      id, path, storageChapterNumber, sources,
      primarySource: sources.findIndex(source => originKey(source) === originKey(primary)),
      user: { included: true, order: index + 1, name: choice.name ?? (choice.primary === "source" ? a[0]?.entry?.user.name : b?.entry?.user.name) ?? b?.entry?.user.name ?? a[0]?.entry?.user.name ?? null, chapterNumber: String(index + 1) },
    };
    entries.push(entry);
    const template = target ?? originalChapters[0]!;
    targetChapters.push({
      ...template, id: retainTarget ? target.id : -(index + 1), novelId: input.targetNovel.id,
      path, chapterNumber: storageChapterNumber, position: index + 1, name: entry.user.name ?? primary.name,
      page: primary.page, releaseTime: primary.releaseTime, sourceContentType: primary.contentType,
      ...(retainTarget ? {} : { isDownloaded: false, contentBytes: 0, mediaBytes: 0, mediaRepairNeeded: false,
        contentType: primary.contentType, bookmark: false, unread: true, progress: 0, readAt: null }),
    });
    if (target) {
      if (!retainTarget) readingStateSourcePathByTargetPath[path] = target.path;
    }
    for (const source of originalChapters) {
      usedSources.add(source.id);
      decisions.push({ sourceChapterId: source.id, kind: "map", targetChapterPath: path });
      if (choice.primary === "target" && (source.isDownloaded || source.contentBytes > 0)) {
        skipSourceContentChapterIds.push(source.id);
      }
    }
    const downloaded = originalChapters.filter(chapter => chapter.isDownloaded || chapter.contentBytes > 0);
    if (downloaded.length && choice.primary === "source") {
      const selected = originalChapters[0]!;
      if (selected.isDownloaded || selected.contentBytes > 0) artifactSourceChapterIdByTargetPath[path] = selected.id;
    }
  }

  const finalPaths = new Set(entries.map(entry => entry.path));
  for (const target of input.targetChapters) {
    if (finalPaths.has(target.path)) continue;
    const saved = originalSources(input.targetNovel, target, input.targetComposition);
    entries.push({ id: saved.entry?.id ?? newId(), path: target.path,
      storageChapterNumber: saved.entry?.storageChapterNumber ?? target.chapterNumber ?? String(++nextStorageNumber),
      sources: saved.sources, primarySource: saved.sources.findIndex(source => originKey(source) === originKey(saved.primary)),
      user: { included: false, order: 0, name: saved.entry?.user.name ?? null, chapterNumber: saved.entry?.user.chapterNumber ?? null } });
    finalPaths.add(target.path);
  }
  // An excluded A chapter still retains its provenance, so a later refresh cannot
  // silently append a chapter the user deliberately omitted.
  for (const source of input.sourceChapters) {
    if (usedSources.has(source.id)) continue;
    decisions.push({ sourceChapterId: source.id, kind: "exclude" });
    const saved = originalSources(input.sourceNovel, source, input.sourceComposition);
    const id = newId();
    entries.push({ id, path: `norea-composed:${id}`, storageChapterNumber: String(++nextStorageNumber),
      sources: saved.sources, primarySource: saved.sources.findIndex(item => originKey(item) === originKey(saved.primary)),
      user: { included: false, order: 0, name: saved.entry?.user.name ?? null, chapterNumber: saved.entry?.user.chapterNumber ?? null } });
  }
  for (const previous of input.targetComposition?.entries ?? []) {
    if (!previous.user.included && !finalPaths.has(previous.path)) entries.push(structuredClone(previous));
  }
  // Carry prior exclusions from A as well: deleting the source work must not delete
  // the user's decisions about chapters that were already omitted there.
  const recordedOrigins = new Set(entries.flatMap(entry => entry.sources.map(originKey)));
  for (const previous of input.sourceComposition?.entries ?? []) {
    if (previous.user.included || previous.sources.every(source => recordedOrigins.has(originKey(source)))) continue;
    const id = newId();
    entries.push({ ...structuredClone(previous), id, path: `norea-composed:${id}`,
      storageChapterNumber: String(++nextStorageNumber), user: { ...previous.user, included: false, order: 0 } });
  }
  const updatedAt = Math.max(input.now ?? Date.now(), (input.targetComposition?.updatedAt ?? 0) + 1, (input.sourceComposition?.updatedAt ?? 0) + 1);
  return { composition: parseChapterComposition({ version: 1, updatedAt, entries }), decisions,
    targetChapters, artifactSourceChapterIdByTargetPath, readingStateSourcePathByTargetPath, skipSourceContentChapterIds };
}
