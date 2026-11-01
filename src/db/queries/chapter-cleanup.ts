import { getDb, getReadOnlyDb, type DatabaseReadMode } from "../client";
import { normalizeChapterContentType } from "../../lib/chapter-content";
import type { ChapterContentStorageIdentity } from "../../lib/chapter-content/storage-platform";
import { UNCATEGORIZED_CATEGORY_ID } from "./category";

export interface ChapterCleanupSelection {
  reading: "read" | "all";
  categories: { mode: "all" } | { mode: "selected"; ids: readonly number[] };
}

export interface ChapterCleanupCandidate {
  identity: ChapterContentStorageIdentity;
  novelPath: string;
  chapterPath: string;
  novelName: string;
  chapterName: string;
  serverSource: string | null;
  storageAmbiguous: boolean;
  localServerFingerprint: string | null;
}

export async function reconcileCleanedChapter(candidate: ChapterCleanupCandidate, snapshot: { contentBytes: number; mediaBytes: number; mediaComplete: boolean }): Promise<number> {
  const db = await getDb();
  const { identity } = candidate;
  const hasBody = snapshot.contentBytes > 0;
  const result = await db.execute(`UPDATE chapter SET content_bytes=$1,media_bytes=$2,
    is_downloaded=$3,media_repair_needed=$4,media_bytes_checked_at=unixepoch()
    WHERE id=$5 AND novel_id=$6 AND path=$7
    AND EXISTS (SELECT 1 FROM novel n WHERE n.id=chapter.novel_id AND n.plugin_id=$8 AND n.path=$9 AND n.source_novel_id IS $10)`,
    [snapshot.contentBytes,snapshot.mediaBytes,hasBody && snapshot.mediaComplete ? 1 : 0,
      hasBody && !snapshot.mediaComplete ? 1 : 0,identity.chapter.id,identity.novel.id,candidate.chapterPath,
      identity.novel.pluginId,candidate.novelPath,identity.novel.sourceNovelId]);
  return result.rowsAffected;
}

interface CandidateRow {
  id: number;
  novelId: number;
  pluginId: string;
  sourceNovelId: string | null;
  novelPath: string;
  chapterPath: string;
  novelName: string;
  chapterName: string;
  chapterNumber: string | null;
  position: number;
  contentType: string;
  serverSource: string | null;
  storageAmbiguous: number;
  localServerFingerprint: string | null;
}

export async function listChapterCleanupCandidates(
  selection: ChapterCleanupSelection,
  options: { afterId?: number; limit?: number; chapterId?: number; readMode?: DatabaseReadMode } = {},
): Promise<ChapterCleanupCandidate[]> {
  const values: (string | number)[] = [];
  const bind = (value: string | number) => { values.push(value); return `$${values.length}`; };
  const predicates = [`(n.is_local=0 OR CASE WHEN json_valid(proof.payload) THEN
    json_extract(proof.payload,'$.chapterId')=c.id AND json_extract(proof.payload,'$.novelId')=n.id
    AND json_extract(proof.payload,'$.pluginId')=n.plugin_id AND json_extract(proof.payload,'$.sourceNovelId') IS n.source_novel_id
    AND json_extract(proof.payload,'$.novelPath')=n.path AND json_extract(proof.payload,'$.chapterPath')=c.path
    AND json_extract(proof.payload,'$.chapterNumber') IS c.chapter_number AND json_extract(proof.payload,'$.position')=c.position
    AND json_type(proof.payload,'$.serverUrl')='text' AND length(json_extract(proof.payload,'$.serverUrl'))>0
    AND json_type(proof.payload,'$.fingerprint')='text' AND length(json_extract(proof.payload,'$.fingerprint'))=64
    ELSE 0 END)`];
  if (selection.reading === "read") predicates.push("c.unread=0");
  if (selection.categories.mode === "selected") {
    const ids = [...new Set(selection.categories.ids.filter(Number.isInteger))];
    if (!ids.length) return [];
    const categorized = ids.filter(id => id !== UNCATEGORIZED_CATEGORY_ID);
    const categoryConditions: string[] = [];
    if (categorized.length) categoryConditions.push(`EXISTS (SELECT 1 FROM novel_category nc WHERE nc.novel_id=n.id AND nc.category_id IN (${categorized.map(bind).join(",")}))`);
    if (ids.includes(UNCATEGORIZED_CATEGORY_ID)) categoryConditions.push("NOT EXISTS (SELECT 1 FROM novel_category nc WHERE nc.novel_id=n.id)");
    predicates.push(`n.in_library=1 AND (${categoryConditions.join(" OR ")})`);
  }
  if (options.chapterId !== undefined) predicates.push(`c.id=${bind(options.chapterId)}`);
  else predicates.push(`c.id>${bind(options.afterId ?? 0)}`);
  const limit = Math.max(1, Math.min(100, options.limit ?? 100));
  const db = options.readMode === "queued" ? await getDb() : await getReadOnlyDb();
  const rows = await db.select<CandidateRow[]>(`SELECT c.id,c.novel_id AS novelId,
    n.plugin_id AS pluginId,n.source_novel_id AS sourceNovelId,n.path AS novelPath,
    c.path AS chapterPath,n.name AS novelName,c.name AS chapterName,
    c.chapter_number AS chapterNumber,c.position,COALESCE(c.stored_content_type,c.content_type) AS contentType,
    source.payload AS serverSource,
    CASE WHEN n.is_local=1 THEN json_extract(proof.payload,'$.fingerprint') ELSE NULL END AS localServerFingerprint,
    EXISTS (SELECT 1 FROM chapter other INDEXED BY chapter_novel_position_idx
      WHERE other.novel_id=c.novel_id AND other.id<>c.id
        AND CAST(COALESCE(other.chapter_number, CASE WHEN other.position>0 THEN other.position END) AS REAL)
          = CAST(COALESCE(c.chapter_number, CASE WHEN c.position>0 THEN c.position END) AS REAL)) AS storageAmbiguous
    FROM chapter c JOIN novel n ON n.id=c.novel_id
    LEFT JOIN content_sync_cache source ON source.cache_key='norea-content-source:' || n.id
    LEFT JOIN content_sync_cache proof ON proof.cache_key='norea-content-chapter-source:' || c.id
    WHERE ${predicates.join(" AND ")} ORDER BY c.id LIMIT ${bind(limit)}`, values);
  return rows.map(row => ({
    identity: {
      novel: { id: row.novelId, pluginId: row.pluginId, sourceNovelId: row.sourceNovelId, path: row.novelPath, name: row.novelName },
      chapter: { id: row.id, name: row.chapterName, position: row.position, chapterNumber: row.chapterNumber, contentType: normalizeChapterContentType(row.contentType) },
    },
    novelPath: row.novelPath, chapterPath: row.chapterPath, novelName: row.novelName,
    chapterName: row.chapterName, serverSource: row.serverSource, storageAmbiguous: !!row.storageAmbiguous, localServerFingerprint: row.localServerFingerprint,
  }));
}
