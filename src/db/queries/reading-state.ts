import { getDb, runDatabaseTransaction } from "../client";
import { sqliteBoolean } from "../sqlite-value";
import { isReadingStateEntry, mergeReadingState, sameReadingState, type ReadingStateEntry } from "../../lib/content-sync/reading-state-model";

export const READING_STATE_BATCH_SIZE = 200;

interface StoredReadingState extends Omit<ReadingStateEntry, "unread" | "bookmark"> {
  id: number;
  novelId: number;
  unread: unknown;
  bookmark: unknown;
}

function normalizeRow(row: StoredReadingState): ReadingStateEntry {
  return {
    pluginId: row.pluginId, sourceNovelId: row.sourceNovelId || null, novelPath: row.novelPath,
    chapterPath: row.chapterPath, chapterNumber: row.chapterNumber || null, page: row.page || "1",
    unread: sqliteBoolean(row.unread), bookmark: sqliteBoolean(row.bookmark),
    progress: row.progress, readAt: row.readAt,
  };
}

export async function listReadingStatePage(afterId = 0): Promise<{ entries: ReadingStateEntry[]; nextId: number | null }> {
  const db = await getDb();
  const rows = await db.select<StoredReadingState[]>(
    `WITH selected AS (
       SELECT id,novel_id,path,chapter_number,page,unread,progress,bookmark,read_at
       FROM chapter WHERE id>$1 AND (unread=0 OR progress>0 OR bookmark=1 OR read_at IS NOT NULL)
       ORDER BY id LIMIT $2
     ), identities AS (
       SELECT novel_id,chapter_number,COALESCE(NULLIF(page,''),'1') AS page,COUNT(*) AS matches
       FROM chapter WHERE novel_id IN (SELECT novel_id FROM selected) AND chapter_number IS NOT NULL
       GROUP BY novel_id,chapter_number,COALESCE(NULLIF(page,''),'1')
     )
     SELECT c.id, c.novel_id AS novelId, n.plugin_id AS pluginId,
       n.source_novel_id AS sourceNovelId, n.path AS novelPath,
       c.path AS chapterPath, CASE WHEN identity.matches=1 THEN c.chapter_number ELSE NULL END AS chapterNumber, c.page,
       c.unread, c.progress, c.bookmark, c.read_at AS readAt
     FROM selected c JOIN novel n ON n.id=c.novel_id
     LEFT JOIN identities identity ON identity.novel_id=c.novel_id AND identity.chapter_number=c.chapter_number
       AND identity.page=COALESCE(NULLIF(c.page,''),'1')
     ORDER BY c.id`, [afterId, READING_STATE_BATCH_SIZE],
  );
  const entries = rows.map(normalizeRow);
  if (!entries.every(isReadingStateEntry)) throw new Error("Local reading state contains an unsupported identity or value.");
  return { entries, nextId: rows.length === READING_STATE_BATCH_SIZE ? rows[rows.length - 1]!.id : null };
}

export interface AppliedReadingState {
  updated: number;
  skipped: number;
  lastReadChapters: Array<{ novelId: number; chapterId: number }>;
}

/** Apply only unambiguous source identities; never match works by a display title. */
export async function applyReadingStateBatch(entries: readonly ReadingStateEntry[], assertCurrent: () => void = () => undefined): Promise<AppliedReadingState> {
  if (entries.length > READING_STATE_BATCH_SIZE || !entries.every(isReadingStateEntry)) {
    throw new Error("Invalid reading-state batch.");
  }
  return runDatabaseTransaction(async db => {
    assertCurrent();
    let updated = 0;
    let skipped = 0;
    const touchedNovels = new Set<number>();
    for (const entry of entries) {
      assertCurrent();
      // A conflicting stable source ID must never fall back to a reused URL.
      const novels = await db.select<{ id: number }[]>(
        `SELECT id FROM novel WHERE plugin_id=$1 AND
          (($2 IS NOT NULL AND lower(source_novel_id)=lower($2))
           OR (path=$3 AND ($2 IS NULL OR NULLIF(source_novel_id,'') IS NULL))) LIMIT 2`,
        [entry.pluginId, entry.sourceNovelId, entry.novelPath],
      );
      if (novels.length !== 1) { skipped += 1; continue; }
      const novelId = novels[0]!.id;
      let chapters = await db.select<StoredReadingState[]>(
        `SELECT id, chapter_number AS chapterNumber, page, unread, progress, bookmark, read_at AS readAt
         FROM chapter WHERE novel_id=$1 AND path=$2 LIMIT 2`,
        [novelId, entry.chapterPath],
      );
      if (chapters[0] && entry.chapterNumber !== null && chapters[0].chapterNumber
        && (chapters[0].chapterNumber !== entry.chapterNumber || (chapters[0].page || "1") !== entry.page)) {
        skipped += 1; continue;
      }
      if (chapters.length === 0 && entry.chapterNumber !== null) {
        chapters = await db.select<StoredReadingState[]>(
          `SELECT id, unread, progress, bookmark, read_at AS readAt FROM chapter
           WHERE novel_id=$1 AND chapter_number=$2 AND COALESCE(NULLIF(page,''),'1')=$3 LIMIT 2`,
          [novelId, entry.chapterNumber, entry.page],
        );
      }
      if (chapters.length !== 1) { skipped += 1; continue; }
      const chapter = chapters[0]!;
      const current = { unread: sqliteBoolean(chapter.unread), progress: chapter.progress,
        bookmark: sqliteBoolean(chapter.bookmark), readAt: chapter.readAt };
      const merged = mergeReadingState(current, entry);
      if (!sameReadingState(current, merged)) {
        await db.execute(
          `UPDATE chapter SET unread=$2,progress=$3,bookmark=$4,read_at=$5,updated_at=unixepoch() WHERE id=$1`,
          [chapter.id, merged.unread ? 1 : 0, merged.progress, merged.bookmark ? 1 : 0, merged.readAt],
        );
        updated += 1;
      }
      touchedNovels.add(novelId);
    }
    const lastReadChapters: AppliedReadingState["lastReadChapters"] = [];
    for (const novelId of touchedNovels) {
      await db.execute(
        `UPDATE novel SET last_read_at=MAX(COALESCE(last_read_at,0),
           (SELECT MAX(read_at) FROM chapter WHERE novel_id=$1)), updated_at=unixepoch()
         WHERE id=$1 AND (SELECT MAX(read_at) FROM chapter WHERE novel_id=$1) IS NOT NULL
           AND COALESCE(last_read_at,0)<(SELECT MAX(read_at) FROM chapter WHERE novel_id=$1)`, [novelId],
      );
      const latest = await db.select<{ id: number }[]>(
        `SELECT id FROM chapter WHERE novel_id=$1 AND read_at IS NOT NULL
         ORDER BY read_at DESC,position DESC,id DESC LIMIT 1`, [novelId],
      );
      if (latest[0]) lastReadChapters.push({ novelId, chapterId: latest[0].id });
    }
    assertCurrent();
    return { updated, skipped, lastReadChapters };
  }, true);
}
