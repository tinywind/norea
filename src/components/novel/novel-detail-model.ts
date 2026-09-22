import { type ChapterListRow } from "../../db/queries/chapter";
import { type NovelDetailRecord } from "../../db/queries/novel";
import { getPluginBaseUrl } from "../../lib/plugins/base-url";
import { pluginManager } from "../../lib/plugins/manager";
import { type SourceDuplicateChapterInfo } from "../../lib/plugins/sync-novel";
import { type ChapterDownloadStatus } from "../../lib/tasks/chapter-download";
export const FINISHED_PROGRESS = 100;

const CHAPTER_DND_PREFIX = "chapter:";

export const EMPTY_CHAPTERS: ChapterListRow[] = [];

export const EMPTY_CHAPTER_DND_IDS: string[] = [];

const EMPTY_SOURCE_DUPLICATE_CHAPTER_COUNTS = new Map<number, number>();

export type NovelMetadataRefreshMode = "since" | "full";

interface BatchDownloadTargets {
  all: ChapterListRow[];
  next10: ChapterListRow[];
  next30: ChapterListRow[];
  unread: ChapterListRow[];
}

export interface BatchDownloadOption {
  chapters: ChapterListRow[];
  description: string;
  key: string;
  label: string;
}

export function novelKey(id: number) {
  return ["novel", "detail", id] as const;
}

export function chaptersKey(id: number) {
  return ["novel", "detail", id, "chapters"] as const;
}

export function sourceDuplicateChapterCountsById(
  chapters: readonly ChapterListRow[],
  duplicates: readonly SourceDuplicateChapterInfo[],
): ReadonlyMap<number, number> {
  if (chapters.length === 0 || duplicates.length === 0) {
    return EMPTY_SOURCE_DUPLICATE_CHAPTER_COUNTS;
  }

  const duplicatesByChapter = new Map(
    duplicates.map((duplicate) => [String(duplicate.chapterNumber), duplicate]),
  );
  const counts = new Map<number, number>();
  for (const chapter of chapters) {
    if (!chapter.chapterNumber) continue;
    const duplicate = duplicatesByChapter.get(chapter.chapterNumber);
    if (!duplicate || duplicate.keptPath !== chapter.path) continue;
    counts.set(chapter.id, duplicate.discardedCount);
  }
  return counts;
}

export function normalizeDateText(value: string): string {
  return value.replace(/,/g, "").replace(/\s+/g, " ").trim();
}

export function formatChapterPosition(position: number): string {
  return `#${String(position).padStart(2, "0")}`;
}

export function chapterDndId(chapterId: number): string {
  return `${CHAPTER_DND_PREFIX}${chapterId}`;
}

export function parseChapterDndId(id: unknown): number | null {
  const value = String(id);
  if (!value.startsWith(CHAPTER_DND_PREFIX)) return null;
  const chapterId = Number(value.slice(CHAPTER_DND_PREFIX.length));
  return Number.isInteger(chapterId) ? chapterId : null;
}

export function beforeChapterIdForMove(
  orderedIds: number[],
  activeId: number,
  overId: number,
): number | null {
  const activeIndex = orderedIds.indexOf(activeId);
  const overIndex = orderedIds.indexOf(overId);
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) {
    return activeId;
  }
  return activeIndex < overIndex ? (orderedIds[overIndex + 1] ?? null) : overId;
}

export function splitGenres(genres: string | null): string[] {
  if (!genres) return [];
  return genres
    .split(/[|,]/)
    .map((genre) => genre.trim())
    .filter(Boolean);
}

function isActiveDownloadStatus(
  status: ChapterDownloadStatus | undefined,
): boolean {
  return (
    status?.kind === "queued" ||
    status?.kind === "running" ||
    status?.kind === "done"
  );
}

function getReadingOrderChapters(
  chapters: readonly ChapterListRow[],
): readonly ChapterListRow[] {
  let asc = true;
  let desc = true;

  for (let index = 1; index < chapters.length; index += 1) {
    const previous = chapters[index - 1]!;
    const current = chapters[index]!;
    if (previous.position > current.position) asc = false;
    if (previous.position < current.position) desc = false;
  }

  if (asc) return chapters;
  if (desc) return [...chapters].reverse();
  return [...chapters].sort((left, right) => left.position - right.position);
}

export function buildBatchDownloadTargets(
  chapters: readonly ChapterListRow[],
  lastReadChapterId: number | undefined,
  downloadStatuses: ReadonlyMap<number, ChapterDownloadStatus>,
): BatchDownloadTargets {
  const readingOrder = getReadingOrderChapters(chapters);
  const candidates = readingOrder.filter(
    (chapter) =>
      !chapter.isDownloaded &&
      !isActiveDownloadStatus(downloadStatuses.get(chapter.id)),
  );
  const currentIndex =
    lastReadChapterId === undefined
      ? -1
      : readingOrder.findIndex((chapter) => chapter.id === lastReadChapterId);
  const nextStartIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
  const nextCandidates = readingOrder
    .slice(nextStartIndex)
    .filter(
      (chapter) =>
        !chapter.isDownloaded &&
        !isActiveDownloadStatus(downloadStatuses.get(chapter.id)),
    );

  return {
    all: candidates,
    next10: nextCandidates.slice(0, 10),
    next30: nextCandidates.slice(0, 30),
    unread: candidates.filter((chapter) => chapter.unread),
  };
}

export function getChapterReadingProgress(chapter: ChapterListRow): number {
  if (chapter.progress >= FINISHED_PROGRESS) return 100;
  return Math.max(0, Math.min(100, Math.round(chapter.progress)));
}

export function getNovelReadingPercent(
  chapters: readonly ChapterListRow[],
): number {
  if (chapters.length === 0) return 0;
  const total = chapters.reduce(
    (sum, chapter) => sum + getChapterReadingProgress(chapter),
    0,
  );
  return Math.round(total / chapters.length);
}

export function findFirstChapter(
  chapters: ChapterListRow[],
): ChapterListRow | null {
  return chapters.reduce<ChapterListRow | null>((first, chapter) => {
    if (!first || chapter.position < first.position) return chapter;
    return first;
  }, null);
}

export function findLastReadChapter(
  chapters: ChapterListRow[],
  lastReadChapterId: number | undefined,
): ChapterListRow | null {
  if (lastReadChapterId === undefined) return null;
  return chapters.find((chapter) => chapter.id === lastReadChapterId) ?? null;
}

export function resolveNovelSourceUrl(novel: NovelDetailRecord): string | null {
  if (novel.isLocal) return null;

  const plugin = pluginManager.getPlugin(novel.pluginId);
  if (!plugin) return null;

  if (plugin.resolveUrl) {
    try {
      const resolved = plugin.resolveUrl(novel.path, true);
      if (resolved) return resolved;
    } catch {
      // Fall back to resolving the path against the plugin base URL below.
    }
  }

  try {
    return new URL(novel.path, getPluginBaseUrl(plugin)).toString();
  } catch {
    return getPluginBaseUrl(plugin);
  }
}
