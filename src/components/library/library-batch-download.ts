import { type ChapterListRow } from "../../db/queries/chapter";
import {
  getChapterDownloadStatus,
  type ChapterDownloadStatus,
} from "../../lib/tasks/chapter-download";
export type LibraryBatchDownloadMode = "all" | "unread" | "next10" | "next30";

function isActiveChapterDownloadStatus(
  status: ChapterDownloadStatus | undefined,
): boolean {
  return (
    status?.kind === "queued" ||
    status?.kind === "running" ||
    status?.kind === "done"
  );
}

function canQueueChapterDownload(chapter: ChapterListRow): boolean {
  return (
    !chapter.isDownloaded &&
    !isActiveChapterDownloadStatus(getChapterDownloadStatus(chapter.id))
  );
}

export function getLibraryBatchDownloadTargets(
  mode: LibraryBatchDownloadMode,
  chapters: readonly ChapterListRow[],
  lastReadChapterId: number | undefined,
): ChapterListRow[] {
  const readingOrder = [...chapters].sort(
    (left, right) => left.position - right.position,
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
