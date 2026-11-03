import { getDb } from "../client";

export interface NovelFreshness {
  novelId: number;
  /** Unix seconds of the last check for new chapters, successful or not. */
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  lastNewChapterAt: number | null;
  coverFetchedAt: number | null;
}

const columns = `novel_id AS novelId,last_checked_at AS lastCheckedAt,last_success_at AS lastSuccessAt,
  consecutive_failures AS consecutiveFailures,last_new_chapter_at AS lastNewChapterAt,cover_fetched_at AS coverFetchedAt`;

export async function getNovelFreshness(novelId: number): Promise<NovelFreshness | null> {
  const db = await getDb();
  const [row] = await db.select<NovelFreshness[]>(`SELECT ${columns} FROM novel_freshness WHERE novel_id=$1`, [novelId]);
  return row ?? null;
}

/**
 * Records a finished check for new chapters: a success resets the failure count and notes
 * when chapters were found; a failure counts toward the check backoff. Missing novels are skipped.
 */
export async function recordNovelCheck(
  novelId: number,
  outcome: { ok: true; newChapters: number } | { ok: false },
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<void> {
  const db = await getDb();
  if (outcome.ok) {
    await db.execute(
      `INSERT INTO novel_freshness(novel_id,last_checked_at,last_success_at,consecutive_failures,last_new_chapter_at)
       SELECT $1,$2,$2,0,CASE WHEN $3>0 THEN $2 END WHERE EXISTS(SELECT 1 FROM novel WHERE id=$1)
       ON CONFLICT(novel_id) DO UPDATE SET last_checked_at=excluded.last_checked_at,last_success_at=excluded.last_success_at,
         consecutive_failures=0,last_new_chapter_at=COALESCE(excluded.last_new_chapter_at,last_new_chapter_at)`,
      [novelId, nowSeconds, outcome.newChapters]);
    return;
  }
  await db.execute(
    `INSERT INTO novel_freshness(novel_id,last_checked_at,consecutive_failures)
     SELECT $1,$2,1 WHERE EXISTS(SELECT 1 FROM novel WHERE id=$1)
     ON CONFLICT(novel_id) DO UPDATE SET last_checked_at=excluded.last_checked_at,consecutive_failures=consecutive_failures+1`,
    [novelId, nowSeconds]);
}
