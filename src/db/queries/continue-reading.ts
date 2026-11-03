import { getDb } from "../client";
import { sqliteBoolean } from "../sqlite-value";

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
  novelIsLocal: boolean;
  novelPath: string;
  pluginId: string;
  chapterId: number;
  position: number;
  progress: number;
  readAt: number;
  nextChapterId: number | null;
  nextChapterPosition: number | null;
}

interface RawContinueReadingEntry
  extends Omit<ContinueReadingEntry, "novelIsLocal"> {
  novelIsLocal: unknown;
}

/** The chapter a tap resumes, following History's rule. */
export function getContinueReadingTarget(entry: ContinueReadingEntry): {
  chapterId: number;
  next: boolean;
  position: number;
} {
  if (entry.progress < FINISHED_PROGRESS || entry.nextChapterId === null) {
    return { chapterId: entry.chapterId, next: false, position: entry.position };
  }
  return {
    chapterId: entry.nextChapterId,
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
  const db = await getDb();
  const normalizedLimit = Math.max(1, Math.min(CONTINUE_READING_LIMIT, Math.floor(limit)));
  const rows = await db.select<RawContinueReadingEntry[]>(
    `WITH latest AS (
       SELECT
         n.id          AS novelId,
         n.name        AS novelName,
         n.cover       AS novelCover,
         n.is_local    AS novelIsLocal,
         n.path        AS novelPath,
         n.plugin_id   AS pluginId,
         c.id          AS chapterId,
         c.position    AS position,
         c.progress    AS progress,
         c.read_at     AS readAt,
         (SELECT nc.id FROM chapter nc
           WHERE nc.novel_id = n.id AND nc.position > c.position
           ORDER BY nc.position ASC, nc.id ASC LIMIT 1) AS nextChapterId,
         (SELECT nc.position FROM chapter nc
           WHERE nc.novel_id = n.id AND nc.position > c.position
           ORDER BY nc.position ASC, nc.id ASC LIMIT 1) AS nextChapterPosition
       FROM novel n
       JOIN chapter c ON c.id = (
         SELECT c2.id
         FROM chapter c2
         WHERE c2.novel_id = n.id AND c2.read_at IS NOT NULL
         ORDER BY c2.read_at DESC, c2.position DESC, c2.id DESC
         LIMIT 1
       )
       WHERE n.in_library = 1
     )
     SELECT * FROM latest
     WHERE progress < ${FINISHED_PROGRESS} OR nextChapterId IS NOT NULL
     ORDER BY readAt DESC, position DESC, chapterId DESC
     LIMIT $1`,
    [normalizedLimit],
  );
  return rows.map((row) => ({
    ...row,
    novelIsLocal: sqliteBoolean(row.novelIsLocal),
  }));
}
