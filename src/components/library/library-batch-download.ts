import {
  hasStoredChapterContent,
  listLibraryDownloadChapters,
  listUnqueuedChapterDownloadIds,
  type LibraryDownloadChapter,
} from "../../db/queries/chapter";
import { getNovelById } from "../../db/queries/novel";
import { MAX_ROUTE_QUERY_ROWS } from "../../lib/performance-budgets";
import { isChapterDownloadQueued } from "../../lib/tasks/chapter-download";
export type LibraryBatchDownloadMode = "all" | "unread" | "next10" | "next30";

export const LIBRARY_BATCH_DOWNLOAD_MODES: readonly LibraryBatchDownloadMode[] = [
  "all",
  "unread",
  "next10",
  "next30",
];

export type LibraryBatchDownloadCounts = Record<LibraryBatchDownloadMode, number>;

function canQueueChapterDownload(chapter: LibraryDownloadChapter): boolean {
  return (
    !hasStoredChapterContent(chapter) &&
    !chapter.isDownloadQueued &&
    !isChapterDownloadQueued(chapter.id)
  );
}

export async function hasLibraryBatchDownloadTargets(
  novelIds: Iterable<number>,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  for (const novelId of novelIds) {
    let afterChapterId = 0;
    for (;;) {
      const chapterIds = await listUnqueuedChapterDownloadIds(
        novelId,
        afterChapterId,
      );
      signal?.throwIfAborted();
      if (chapterIds.some((id) => !isChapterDownloadQueued(id))) return true;
      if (chapterIds.length < MAX_ROUTE_QUERY_ROWS) break;
      afterChapterId = chapterIds[chapterIds.length - 1]!;
    }
  }
  return false;
}

export function getLibraryBatchDownloadTargets(
  mode: LibraryBatchDownloadMode,
  chapters: readonly LibraryDownloadChapter[],
  lastReadChapterId: number | undefined,
): LibraryDownloadChapter[] {
  const readingOrder = [...chapters].sort(
    (left, right) => left.position - right.position || left.id - right.id,
  );
  const candidates = readingOrder.filter(canQueueChapterDownload);

  switch (mode) {
    case "all":
      return candidates;
    case "unread":
      return candidates.filter((chapter) => chapter.unread);
    case "next10":
    case "next30": {
      const currentIndex =
        lastReadChapterId === undefined
          ? -1
          : readingOrder.findIndex(
              (chapter) => chapter.id === lastReadChapterId,
            );
      if (currentIndex < 0) return [];

      const limit = mode === "next10" ? 10 : 30;
      return readingOrder
        .slice(currentIndex + 1)
        .filter(canQueueChapterDownload)
        .slice(0, limit);
    }
  }
}

/** How many chapters each batch download mode would queue for the novels. */
export async function countLibraryBatchDownloadTargets(
  novelIds: Iterable<number>,
  lastReadChapterByNovel: Readonly<Record<number, number | undefined>>,
  signal?: AbortSignal,
): Promise<LibraryBatchDownloadCounts> {
  const counts: LibraryBatchDownloadCounts = { all: 0, unread: 0, next10: 0, next30: 0 };
  for (const novelId of novelIds) {
    signal?.throwIfAborted();
    const novel = await getNovelById(novelId);
    if (!novel || novel.isLocal) continue;
    const chapters = await listLibraryDownloadChapters(novelId);
    signal?.throwIfAborted();
    for (const mode of LIBRARY_BATCH_DOWNLOAD_MODES) {
      counts[mode] += getLibraryBatchDownloadTargets(
        mode,
        chapters,
        lastReadChapterByNovel[novelId],
      ).length;
    }
  }
  return counts;
}
