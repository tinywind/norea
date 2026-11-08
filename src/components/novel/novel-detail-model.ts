import { hasStoredChapterContent, type ChapterListRow } from "../../db/queries/chapter";
import { type NovelDetailRecord } from "../../db/queries/novel";
import { type TranslationKey } from "../../i18n";
import { displayedChapterNumber } from "../../lib/chapter-title";
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

type ChapterNumberLabel = Pick<ChapterListRow, "chapterNumber" | "position"> & {
  name?: string | null;
  chapterName?: string | null;
};

/** Prefer a clear title episode; stored values and positions remain fallbacks. */
export function formatChapterNumber(chapter: ChapterNumberLabel): string {
  return displayedChapterNumber(chapter.name ?? chapter.chapterName)
    ?? (chapter.chapterNumber?.trim() || String(chapter.position));
}

/** Whether the chapter name already shows its number, such as "Chapter 1895" for chapter 1895. */
export function chapterNameShowsNumber(
  chapter: Pick<ChapterListRow, "chapterNumber" | "name" | "position">,
): boolean {
  if (displayedChapterNumber(chapter.name) !== null) return true;
  const number = formatChapterNumber(chapter).replace(/^0+(?=\d)/, "");
  const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\d.])0*${escaped}(?!\\.?\\d)`).test(chapter.name);
}

/** The chapter's shown number as a value, or `null` when it is not numeric. */
export function chapterNumberValue(chapter: ChapterNumberLabel): number | null {
  const text = formatChapterNumber(chapter);
  return /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
}

/** Chapter list filters; each one on narrows the list, and they combine. */
export interface ChapterListFilters {
  downloaded: boolean;
  queued: boolean;
  unread: boolean;
}

export const NO_CHAPTER_LIST_FILTERS: ChapterListFilters = { downloaded: false, queued: false, unread: false };

export function hasChapterListFilters(filters: ChapterListFilters): boolean {
  return filters.downloaded || filters.queued || filters.unread;
}

/** The chapters every filter that is on keeps, in the given order; the same array when none is on. */
export function filterChapterList<T extends ChapterListRow>(
  chapters: readonly T[],
  filters: ChapterListFilters,
  downloadStatuses: ReadonlyMap<number, ChapterDownloadStatus>,
): readonly T[] {
  if (!hasChapterListFilters(filters)) return chapters;
  return chapters.filter((chapter) => {
    if (filters.unread && !chapter.unread) return false;
    if (filters.downloaded && !hasStoredChapterContent(chapter)) return false;
    if (filters.queued) {
      const kind = downloadStatuses.get(chapter.id)?.kind;
      if (kind !== "queued" && kind !== "running") return false;
    }
    return true;
  });
}

/**
 * What a click on a chapter row does. Each state gives a tap one meaning:
 * outside selection it opens the chapter, inside it toggles the row.
 * Shift-click selects like a long press.
 */
export function chapterRowClickAction(
  selectionMode: boolean,
  shiftKey: boolean,
): "open" | "toggle" | "select-range" {
  if (shiftKey) return "select-range";
  return selectionMode ? "toggle" : "open";
}

/** The ids from `anchorId` to `targetId`, both included, in list order. */
export function chapterIdsBetween(
  chapters: readonly ChapterListRow[],
  anchorId: number,
  targetId: number,
): number[] {
  const anchorIndex = chapters.findIndex((chapter) => chapter.id === anchorId);
  const targetIndex = chapters.findIndex((chapter) => chapter.id === targetId);
  if (anchorIndex < 0 || targetIndex < 0) return [];
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return chapters.slice(start, end + 1).map((chapter) => chapter.id);
}

/** The ids of chapters numbered from `from` to `to`, both included, in either order. */
export function chapterIdsInNumberRange(
  chapters: readonly ChapterListRow[],
  from: number,
  to: number,
): number[] {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  return chapters.flatMap((chapter) => {
    const value = chapterNumberValue(chapter);
    return value !== null && value >= low && value <= high ? [chapter.id] : [];
  });
}

/** The chapter a "Go to chapter" query names: an exact number first, else the first title containing it. */
export function findChapterForJump(
  chapters: readonly ChapterListRow[],
  query: string,
): ChapterListRow | undefined {
  const text = query.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const value = Number(text);
    const numbered = chapters.find((chapter) => chapterNumberValue(chapter) === value);
    if (numbered) return numbered;
  }
  const needle = text.toLocaleLowerCase();
  return chapters.find((chapter) => chapter.name.toLocaleLowerCase().includes(needle));
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

/** How many of the chapters are marked read. */
export function countReadChapters(chapters: readonly ChapterListRow[]): number {
  return chapters.reduce((count, chapter) => (chapter.unread ? count : count + 1), 0);
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
