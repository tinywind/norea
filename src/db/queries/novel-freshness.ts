import { getDb, getReadOnlyDb, type DatabaseReadMode } from "../client";

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

export async function getNovelFreshness(
  novelId: number,
  readMode: DatabaseReadMode = "queued",
): Promise<NovelFreshness | null> {
  const db = await (readMode === "committed" ? getReadOnlyDb() : getDb());
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

/** Notes when the novel's cover was last fetched, or the baseline for a cover stored before tracking. */
export async function recordNovelCoverFetched(novelId: number, nowSeconds = Math.floor(Date.now() / 1000)): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO novel_freshness(novel_id,cover_fetched_at) SELECT $1,$2 WHERE EXISTS(SELECT 1 FROM novel WHERE id=$1)
     ON CONFLICT(novel_id) DO UPDATE SET cover_fetched_at=excluded.cover_fetched_at`,
    [novelId, nowSeconds]);
}

/** A library source novel with what the check cadence needs. */
export interface CheckCandidate {
  novelId: number;
  pluginId: string;
  /** The source's status text, such as "Completed". */
  status: string | null;
  lastReadAt: number | null;
  lastCheckedAt: number | null;
  consecutiveFailures: number;
  totalChapters: number;
  unreadChapters: number;
  /** The novel has its own goal other than None. */
  hasGoal: boolean;
}

export async function listCheckCandidates(): Promise<CheckCandidate[]> {
  const db = await getDb();
  const rows = await db.select<(Omit<CheckCandidate, "hasGoal"> & { hasGoal: unknown })[]>(
    `SELECT n.id AS novelId,n.plugin_id AS pluginId,n.status,n.last_read_at AS lastReadAt,
       f.last_checked_at AS lastCheckedAt,COALESCE(f.consecutive_failures,0) AS consecutiveFailures,
       COALESCE(s.total_chapters,0) AS totalChapters,COALESCE(s.chapters_unread,0) AS unreadChapters,
       (g.novel_id IS NOT NULL AND g.kind <> 'none') AS hasGoal
     FROM novel n
     LEFT JOIN novel_freshness f ON f.novel_id=n.id
     LEFT JOIN novel_stats s ON s.novel_id=n.id
     LEFT JOIN novel_download_goal g ON g.novel_id=n.id
     WHERE n.in_library=1 AND n.is_local=0
     ORDER BY n.id`);
  return rows.map((row) => ({ ...row, hasGoal: row.hasGoal === 1 || row.hasGoal === true }));
}

/** Checks each source started since `sinceSeconds`, for the per-source hourly budget. */
export async function countRecentChecksBySource(sinceSeconds: number): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db.select<{ pluginId: string; count: number }[]>(
    `SELECT n.plugin_id AS pluginId,COUNT(*) AS count FROM novel_freshness f JOIN novel n ON n.id=f.novel_id
     WHERE f.last_checked_at >= $1 GROUP BY n.plugin_id`, [sinceSeconds]);
  return new Map(rows.map((row) => [row.pluginId, row.count]));
}

/** When any library novel was last checked for new chapters, for "Last checked" on Updates. */
export async function getLatestLibraryCheckAt(readMode: DatabaseReadMode = "queued"): Promise<number | null> {
  const db = await (readMode === "committed" ? getReadOnlyDb() : getDb());
  const [row] = await db.select<{ checkedAt: number | null }[]>(
    `SELECT MAX(f.last_checked_at) AS checkedAt FROM novel_freshness f JOIN novel n ON n.id=f.novel_id WHERE n.in_library=1`);
  return row?.checkedAt ?? null;
}
