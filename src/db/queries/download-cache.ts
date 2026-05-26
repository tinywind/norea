import { getDb } from "../client";
import {
  MAX_BACKFILL_PER_RUN,
  clampBackfillLimit,
} from "../../lib/performance-budgets";

export interface DownloadCacheResult {
  rowsAffected: number;
}

export interface DownloadCacheNovel {
  novelId: number;
  novelName: string;
  novelCover: string | null;
  pluginId: string;
  pluginName?: string | null;
  inLibrary: boolean;
  chaptersDownloaded: number;
  totalChapters: number;
  unreadDownloaded: number;
  readDownloaded: number;
  mediaRepairNeededChapters: number;
  totalBytes: number;
  lastDownloadedAt: number | null;
}

interface RawDownloadCacheNovel
  extends Omit<DownloadCacheNovel, "inLibrary"> {
  inLibrary: number;
}

export interface DownloadCacheChapter {
  id: number;
  novelId: number;
  name: string;
  position: number;
  unread: boolean;
  progress: number;
  readAt: number | null;
  downloadedAt: number | null;
  contentBytes: number;
  mediaBytes: number;
  mediaRepairNeeded: boolean;
  totalBytes: number;
}

interface RawDownloadCacheChapter
  extends Omit<DownloadCacheChapter, "unread" | "mediaRepairNeeded"> {
  unread: number;
  mediaRepairNeeded: unknown;
}

function sqliteBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true";
  }
  return false;
}

export interface DownloadCacheMediaBackfillCandidate {
  id: number;
  chapterName: string;
  chapterNumber: string | null;
  novelId: number;
  novelName: string;
  novelPath: string;
  pluginId: string;
  position: number;
  updatedAt: number;
}

export async function listDownloadCacheNovels(): Promise<DownloadCacheNovel[]> {
  const db = await getDb();
  const rows = await db.select<RawDownloadCacheNovel[]>(
    `SELECT
       n.id             AS novelId,
       n.name           AS novelName,
       n.cover          AS novelCover,
       n.plugin_id      AS pluginId,
       ip.name          AS pluginName,
       n.in_library     AS inLibrary,
       COUNT(c.id)      AS chaptersDownloaded,
       (
         SELECT COUNT(*)
         FROM chapter all_chapters
         WHERE all_chapters.novel_id = n.id
       )                AS totalChapters,
       COALESCE(SUM(CASE WHEN c.unread = 1 THEN 1 ELSE 0 END), 0)
                        AS unreadDownloaded,
       COALESCE(SUM(CASE WHEN c.unread = 0 THEN 1 ELSE 0 END), 0)
                        AS readDownloaded,
       COALESCE(SUM(CASE WHEN c.media_repair_needed = 1 THEN 1 ELSE 0 END), 0)
                        AS mediaRepairNeededChapters,
       COALESCE(SUM(c.content_bytes + c.media_bytes), 0) AS totalBytes,
       MAX(c.updated_at) AS lastDownloadedAt
     FROM novel n
     JOIN chapter c ON c.novel_id = n.id
     LEFT JOIN installed_plugin ip ON ip.id = n.plugin_id
     WHERE c.is_downloaded = 1
       AND n.is_local = 0
     GROUP BY n.id
     ORDER BY lastDownloadedAt DESC, n.name COLLATE NOCASE ASC`,
  );

  return rows.map((row) => ({
    ...row,
    inLibrary: !!row.inLibrary,
  }));
}

export async function listDownloadCacheChapters(
  novelId: number,
): Promise<DownloadCacheChapter[]> {
  const db = await getDb();
  const rows = await db.select<RawDownloadCacheChapter[]>(
    `SELECT
       c.id,
       c.novel_id AS novelId,
       c.name,
       c.position,
       c.unread,
       c.progress,
       c.read_at AS readAt,
       c.updated_at AS downloadedAt,
       c.content_bytes AS contentBytes,
       c.media_bytes AS mediaBytes,
       c.media_repair_needed AS mediaRepairNeeded,
       c.content_bytes + c.media_bytes AS totalBytes
     FROM chapter c
     JOIN novel n ON n.id = c.novel_id
     WHERE c.novel_id = $1
       AND c.is_downloaded = 1
       AND n.is_local = 0
     ORDER BY c.position ASC, c.id ASC`,
    [novelId],
  );

  return rows.map((row) => ({
    ...row,
    unread: !!row.unread,
    mediaRepairNeeded: sqliteBoolean(row.mediaRepairNeeded),
  }));
}

export async function deleteDownloadCacheChapter(
  chapterId: number,
): Promise<DownloadCacheResult> {
  const db = await getDb();
  const result = await db.execute(
    `UPDATE chapter
     SET
       content       = NULL,
       content_bytes = 0,
       media_bytes   = 0,
       media_repair_needed = 0,
       media_bytes_checked_at = NULL,
       is_downloaded = 0,
       updated_at    = unixepoch()
     WHERE id = $1
       AND is_downloaded = 1
       AND EXISTS (
         SELECT 1 FROM novel n
         WHERE n.id = chapter.novel_id
           AND n.is_local = 0
       )`,
    [chapterId],
  );
  return { rowsAffected: result.rowsAffected };
}

export async function deleteDownloadCacheNovel(
  novelId: number,
): Promise<DownloadCacheResult> {
  const db = await getDb();
  const result = await db.execute(
    `UPDATE chapter
     SET
       content       = NULL,
       content_bytes = 0,
       media_bytes   = 0,
       media_repair_needed = 0,
       media_bytes_checked_at = NULL,
       is_downloaded = 0,
       updated_at    = unixepoch()
     WHERE novel_id = $1
       AND is_downloaded = 1
       AND EXISTS (
         SELECT 1 FROM novel n
         WHERE n.id = chapter.novel_id
           AND n.is_local = 0
       )`,
    [novelId],
  );
  return { rowsAffected: result.rowsAffected };
}

export async function deleteAllDownloadCache(): Promise<DownloadCacheResult> {
  const db = await getDb();
  const result = await db.execute(
    `UPDATE chapter
     SET
       content       = NULL,
       content_bytes = 0,
       media_bytes   = 0,
       media_repair_needed = 0,
       media_bytes_checked_at = NULL,
       is_downloaded = 0,
       updated_at    = unixepoch()
     WHERE is_downloaded = 1
       AND EXISTS (
         SELECT 1 FROM novel n
         WHERE n.id = chapter.novel_id
           AND n.is_local = 0
       )`,
  );
  return { rowsAffected: result.rowsAffected };
}

export async function listDownloadCacheMediaBackfillCandidates(
  novelId?: number,
  limit: number = MAX_BACKFILL_PER_RUN,
): Promise<DownloadCacheMediaBackfillCandidate[]> {
  const db = await getDb();
  const novelFilter = novelId === undefined ? "" : "AND c.novel_id = $1";
  const normalizedLimit = clampBackfillLimit(limit);
  const limitParam = novelId === undefined ? "$1" : "$2";
  return db.select<DownloadCacheMediaBackfillCandidate[]>(
    `SELECT
       c.id,
       c.name           AS chapterName,
       c.chapter_number AS chapterNumber,
       c.novel_id       AS novelId,
       c.position,
       c.updated_at     AS updatedAt,
       n.name           AS novelName,
       n.path           AS novelPath,
       n.plugin_id      AS pluginId
     FROM chapter c
     JOIN novel n ON n.id = c.novel_id
     WHERE c.is_downloaded = 1
       AND c.media_bytes = 0
       AND c.media_bytes_checked_at IS NULL
       AND c.content LIKE '%norea-media://reader-asset/%'
       AND n.is_local = 0
       ${novelFilter}
     ORDER BY c.updated_at ASC, c.id ASC
     LIMIT ${limitParam}`,
    novelId === undefined ? [normalizedLimit] : [novelId, normalizedLimit],
  );
}

export async function getDownloadCacheMediaBackfillCandidateContent(
  chapterId: number,
): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<Array<{ content: string | null }>>(
    `SELECT c.content
     FROM chapter c
     JOIN novel n ON n.id = c.novel_id
     WHERE c.id = $1
       AND c.is_downloaded = 1
       AND c.media_bytes = 0
       AND c.media_bytes_checked_at IS NULL
       AND c.content LIKE '%norea-media://reader-asset/%'
       AND n.is_local = 0`,
    [chapterId],
  );
  return rows[0]?.content ?? null;
}

export async function updateDownloadCacheChapterMediaBytes(
  chapterId: number,
  mediaBytes: number,
): Promise<DownloadCacheResult> {
  const db = await getDb();
  const result = await db.execute(
    `UPDATE chapter
     SET
       media_bytes = $2,
       media_bytes_checked_at = unixepoch()
     WHERE id = $1
       AND (
         media_bytes IS NOT $2
         OR media_bytes_checked_at IS NULL
       )`,
    [chapterId, Math.max(0, Math.round(mediaBytes))],
  );
  return { rowsAffected: result.rowsAffected };
}
