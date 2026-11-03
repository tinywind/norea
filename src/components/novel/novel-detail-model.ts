import { hasStoredChapterContent, type ChapterListRow } from "../../db/queries/chapter";
import { type NovelDetailRecord } from "../../db/queries/novel";
import { type TranslationKey } from "../../i18n";
import { getPluginBaseUrl } from "../../lib/plugins/base-url";
import { pluginManager } from "../../lib/plugins/manager";
import { NovelStatus } from "../../lib/plugins/types";
import { type SourceDuplicateChapterInfo } from "../../lib/plugins/sync-novel";
import { type ChapterDownloadStatus } from "../../lib/tasks/chapter-download";
export const FINISHED_PROGRESS = 100;

const CHAPTER_DND_PREFIX = "chapter:";

export const EMPTY_CHAPTERS: ChapterListRow[] = [];

export const EMPTY_CHAPTER_DND_IDS: string[] = [];

const EMPTY_SOURCE_DUPLICATE_CHAPTER_COUNTS = new Map<number, number>();

export type NovelMetadataRefreshMode = "since" | "full";

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

/** The number a reader knows the chapter by: its source number, else its position. */
export function formatChapterNumber(
  chapter: Pick<ChapterListRow, "chapterNumber" | "position">,
): string {
  return chapter.chapterNumber?.trim() || String(chapter.position);
}

const NOVEL_STATUS_LABEL_KEYS: Partial<Record<string, TranslationKey>> = {
  [NovelStatus.Ongoing]: "novel.status.ongoing",
  [NovelStatus.Completed]: "novel.status.completed",
  [NovelStatus.Licensed]: "novel.status.licensed",
  [NovelStatus.PublishingFinished]: "novel.status.publishingFinished",
  [NovelStatus.Cancelled]: "novel.status.cancelled",
  [NovelStatus.OnHiatus]: "novel.status.onHiatus",
};

/**
 * The status to show for a novel: a known plugin value in the app language,
 * free text as written, and nothing for an empty or "Unknown" status.
 */
export function novelStatusLabel(
  status: string | null,
  translate: (key: TranslationKey) => string,
): string | null {
  const value = status?.trim();
  if (!value || value === NovelStatus.Unknown) return null;
  const key = NOVEL_STATUS_LABEL_KEYS[value];
  return key ? translate(key) : value;
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

/** Chapters without a stored body and without active download work, in reading order. */
export function buildMissingChapterDownloadTargets(
  chapters: readonly ChapterListRow[],
  downloadStatuses: ReadonlyMap<number, ChapterDownloadStatus>,
): ChapterListRow[] {
  return getReadingOrderChapters(chapters).filter(
    (chapter) =>
      !hasStoredChapterContent(chapter) &&
      !isActiveDownloadStatus(downloadStatuses.get(chapter.id)),
  );
}

export function buildPreviousChapterDownloadTargets(
  chapters: readonly ChapterListRow[],
  selectedChapterIds: ReadonlySet<number>,
  downloadStatuses: ReadonlyMap<number, ChapterDownloadStatus>,
): ChapterListRow[] {
  const anchor = findFirstChapter(chapters.filter(chapter => selectedChapterIds.has(chapter.id)));
  if (!anchor) return [];
  return buildMissingChapterDownloadTargets(
    chapters.filter(chapter => chapter.position < anchor.position),
    downloadStatuses,
  );
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

export function findContinueReadingChapter(
  chapters: readonly ChapterListRow[],
  lastReadChapterId: number | undefined,
): ChapterListRow | null {
  const readingOrder = getReadingOrderChapters(chapters);
  const lastReadIndex =
    lastReadChapterId === undefined
      ? -1
      : readingOrder.findIndex((chapter) => chapter.id === lastReadChapterId);
  if (lastReadIndex >= 0) {
    const lastRead = readingOrder[lastReadIndex]!;
    if (lastRead.progress < FINISHED_PROGRESS) return lastRead;
    return readingOrder[lastReadIndex + 1] ?? lastRead;
  }
  return readingOrder.find((chapter) => chapter.unread) ?? readingOrder[0] ?? null;
}

/** Whether the user has opened one of these chapters before. */
export function hasReadingHistory(
  chapters: readonly ChapterListRow[],
  lastReadChapterId: number | undefined,
): boolean {
  return (
    lastReadChapterId !== undefined &&
    chapters.some((chapter) => chapter.id === lastReadChapterId)
  );
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
