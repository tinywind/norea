import { parseChapterComposition, type ChapterCompositionV1, type ChapterSourceSnapshot } from "./chapter-composition";
import type { ChapterItem } from "./plugins/types";
import { normalizeChapterContentType } from "./chapter-content";

export interface ChapterCompositionSourceIdentity { pluginId: string; novelId: string; novelPath: string }

/** Source refreshes replace source facts, never the user's reading arrangement. */
export function refreshChapterComposition(
  previous: ChapterCompositionV1,
  identity: ChapterCompositionSourceIdentity,
  chapters: readonly ChapterItem[],
  options: { newId?: () => string; now?: number; startPosition?: number } = {},
): ChapterCompositionV1 {
  const composition = structuredClone(previous);
  const byPath = new Map(chapters.map(chapter => [chapter.path, chapter]));
  const positions = new Map(chapters.map((chapter, index) => [chapter.path, (options.startPosition ?? 1) + index]));
  const byStableId = new Map<string, ChapterItem>();
  const duplicateStableIds = new Set<string>();
  for (const chapter of chapters) {
    if (!chapter.sourceChapterId) continue;
    if (byStableId.has(chapter.sourceChapterId)) duplicateStableIds.add(chapter.sourceChapterId);
    byStableId.set(chapter.sourceChapterId, chapter);
  }
  const seen = new Set<string>();
  const matchesWork = (source: ChapterSourceSnapshot) => source.pluginId === identity.pluginId && source.novelId === identity.novelId;
  const update = (old: ChapterSourceSnapshot, chapter: ChapterItem): ChapterSourceSnapshot => ({
    ...old, ...identity, chapterPath: chapter.path, sourceChapterId: chapter.sourceChapterId ?? old.sourceChapterId,
    chapterNumber: String(chapter.chapterNumber), name: chapter.name,
    position: positions.get(chapter.path)!, page: chapter.page ?? "1", releaseTime: chapter.releaseTime ?? null,
    contentType: normalizeChapterContentType(chapter.contentType),
  });
  for (const entry of composition.entries) {
    entry.sources = entry.sources.map(source => {
      if (!matchesWork(source)) return source;
      const exact = byPath.get(source.chapterPath);
      const stable = source.sourceChapterId && !duplicateStableIds.has(source.sourceChapterId)
        ? byStableId.get(source.sourceChapterId) : undefined;
      const chapter = stable ?? (exact && (!source.sourceChapterId || !exact.sourceChapterId || exact.sourceChapterId === source.sourceChapterId)
        ? exact : undefined);
      // A missing provider row does not discard the user's retained chapter or files.
      if (!chapter) return source;
      seen.add(chapter.path);
      return update(source, chapter);
    });
  }
  let storageNumber = composition.entries.reduce((maximum, entry) => Math.max(maximum, Math.ceil(Number(entry.storageChapterNumber))), 0);
  let order = composition.entries.filter(entry => entry.user.included).length;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const paths = new Set(composition.entries.map(entry => entry.path));
  for (const chapter of chapters) {
    if (seen.has(chapter.path)) continue;
    const id = newId();
    const source = update({ ...identity, chapterPath: chapter.path, chapterNumber: String(chapter.chapterNumber),
      name: chapter.name, position: chapter.chapterNumber, page: chapter.page ?? "1",
      contentType: normalizeChapterContentType(chapter.contentType), releaseTime: chapter.releaseTime ?? null }, chapter);
    order += 1;
    // The path must be deterministic across a read-only preview and its later refresh.
    // The package number is independent of the provider's numbering.
    const path = paths.has(chapter.path)
      ? `norea-source:${encodeURIComponent(identity.pluginId)}:${encodeURIComponent(identity.novelId)}:${encodeURIComponent(chapter.path)}`
      : chapter.path;
    paths.add(path);
    composition.entries.push({ id, path, storageChapterNumber: String(++storageNumber),
      sources: [source], primarySource: 0,
      user: { included: true, order, name: null, chapterNumber: String(order) } });
  }
  // A no-op source check must not create an endless metadata upload loop.
  if (JSON.stringify(composition.entries) !== JSON.stringify(previous.entries)) {
    composition.updatedAt = Math.max(previous.updatedAt + 1, options.now ?? Date.now());
  }
  return parseChapterComposition(composition);
}

export function compositionSourceAnchor(composition: ChapterCompositionV1, identity: Pick<ChapterCompositionSourceIdentity, "pluginId" | "novelId">): {
  chapterNumber: number; position: number;
} | null {
  const sources = composition.entries.flatMap(entry => entry.sources)
    .filter(source => source.pluginId === identity.pluginId && source.novelId === identity.novelId && source.chapterNumber !== null)
    .filter(source => Number.isFinite(Number(source.chapterNumber)));
  const latest = sources.sort((a, b) => Number(b.chapterNumber) - Number(a.chapterNumber))[0];
  return latest ? { chapterNumber: Number(latest.chapterNumber), position: latest.position } : null;
}
