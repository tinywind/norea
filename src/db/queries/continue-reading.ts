import { invokeDbQuery } from "../ipc";

const FINISHED_PROGRESS = 100;
export const CONTINUE_READING_LIMIT = 6;

/**
 * A library novel whose latest read chapter has a resume target: the chapter
 * itself while it is unfinished, or the next indexed chapter once it is
 * finished.
 */
export interface ContinueReadingEntry {
  novelId: number;
  novelName: string;
  novelCover: string | null;
  novelCoverOverride?: string | null;
  novelIsLocal: boolean;
  novelPath: string;
  pluginId: string;
  novelSourceNovelId: string | null;
  chapterId: number;
  chapterName: string;
  chapterNumber: string | null;
  position: number;
  progress: number;
  readAt: number;
  nextChapterId: number | null;
  nextChapterName: string | null;
  nextChapterNumber: string | null;
  nextChapterPosition: number | null;
}

/** The chapter a tap resumes, following History's rule. */
export function getContinueReadingTarget(entry: ContinueReadingEntry): {
  chapterId: number;
  chapterName: string | null;
  chapterNumber: string | null;
  next: boolean;
  position: number;
} {
  if (entry.progress < FINISHED_PROGRESS || entry.nextChapterId === null) {
    return {
      chapterId: entry.chapterId,
      chapterName: entry.chapterName,
      chapterNumber: entry.chapterNumber,
      next: false,
      position: entry.position,
    };
  }
  return {
    chapterId: entry.nextChapterId,
    chapterName: entry.nextChapterName,
    chapterNumber: entry.nextChapterNumber,
    next: true,
    position: entry.nextChapterPosition ?? entry.position,
  };
}

/**
 * Library novels with a resume target, most recently read first. The latest
 * read chapter and its next chapter are resolved in one query.
 */
export async function listContinueReading(
  limit: number = CONTINUE_READING_LIMIT,
): Promise<ContinueReadingEntry[]> {
  const normalizedLimit = Math.max(
    1,
    Math.min(CONTINUE_READING_LIMIT, Math.floor(limit)),
  );
  return invokeDbQuery<ContinueReadingEntry[]>(
    "db_chapter_list_continue_reading",
    { limit: normalizedLimit },
  );
}
