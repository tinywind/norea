import { getDb } from "../client";

/** Automatic download ranges; stored per-novel positive goals are retained as legacy data, while `none` is an explicit pause. */
export type NovelDownloadGoal =
  | { kind: "keep_ahead"; count: number }
  | { kind: "all_remaining" }
  | { kind: "entire" }
  | { kind: "none" };

export interface StoredNovelDownloadGoal {
  novelId: number;
  goal: NovelDownloadGoal;
  updatedAt: number;
}

interface RawGoalRow {
  novelId: number;
  kind: string;
  count: number | null;
  updatedAt: number;
}

const columns = "novel_id AS novelId,kind,count,updated_at AS updatedAt";

function toGoal(row: RawGoalRow): NovelDownloadGoal | null {
  if (row.kind === "keep_ahead") {
    return row.count !== null && Number.isSafeInteger(row.count) && row.count > 0
      ? { kind: "keep_ahead", count: row.count }
      : null;
  }
  if (row.kind === "all_remaining" || row.kind === "entire" || row.kind === "none") return { kind: row.kind };
  return null;
}

function toStored(row: RawGoalRow): StoredNovelDownloadGoal | null {
  const goal = toGoal(row);
  return goal ? { novelId: row.novelId, goal, updatedAt: row.updatedAt } : null;
}

export async function getNovelDownloadGoal(novelId: number): Promise<StoredNovelDownloadGoal | null> {
  const db = await getDb();
  const [row] = await db.select<RawGoalRow[]>(
    `SELECT ${columns} FROM novel_download_goal WHERE novel_id=$1`, [novelId]);
  return row ? toStored(row) : null;
}

export async function listNovelDownloadGoals(): Promise<StoredNovelDownloadGoal[]> {
  const db = await getDb();
  const rows = await db.select<RawGoalRow[]>(`SELECT ${columns} FROM novel_download_goal ORDER BY novel_id`);
  return rows.flatMap((row) => toStored(row) ?? []);
}

/**
 * Stores the novel's goal, or removes it when `goal` is null so the default applies again.
 * Returns false when the novel row no longer exists.
 */
export async function setNovelDownloadGoal(
  novelId: number,
  goal: NovelDownloadGoal | null,
  now = Date.now(),
): Promise<boolean> {
  const db = await getDb();
  if (goal === null) {
    await db.execute("DELETE FROM novel_download_goal WHERE novel_id=$1", [novelId]);
    return true;
  }
  const result = await db.execute(
    `INSERT INTO novel_download_goal(novel_id,kind,count,updated_at)
     SELECT $1,$2,$3,$4 WHERE EXISTS(SELECT 1 FROM novel WHERE id=$1)
     ON CONFLICT(novel_id) DO UPDATE SET kind=excluded.kind,count=excluded.count,updated_at=excluded.updated_at`,
    [novelId, goal.kind, goal.kind === "keep_ahead" ? goal.count : null, now],
  );
  return result.rowsAffected === 1;
}

export interface DownloadGoalNovel {
  id: number;
  pluginId: string;
  path: string;
  name: string;
  /** Unix seconds of the latest chapter open, or null. */
  lastReadAt: number | null;
  /** Retained legacy intent; only the global policy determines the active download range. */
  goal: Exclude<NovelDownloadGoal, { kind: "none" }> | null;
}

/** Active library source novels covered by the global policy, except explicit pauses; most recently read first. */
export async function listDownloadGoalNovels(
  activeSince: number | null,
  novelIds?: readonly number[],
): Promise<DownloadGoalNovel[]> {
  const db = await getDb();
  const ids = novelIds ? [...new Set(novelIds)].filter(Number.isSafeInteger) : null;
  if (ids?.length === 0) return [];
  const rows = await db.select<(Omit<DownloadGoalNovel, "goal"> & { kind: string | null; count: number | null })[]>(
    `SELECT n.id,n.plugin_id AS pluginId,n.path,n.name,n.last_read_at AS lastReadAt,g.kind,g.count
     FROM novel n LEFT JOIN novel_download_goal g ON g.novel_id=n.id
     WHERE n.is_local=0 AND n.in_library=1 AND $1 IS NOT NULL AND n.last_read_at >= $1
       AND (g.novel_id IS NULL OR g.kind <> 'none')
       ${ids ? `AND n.id IN (${ids.map((_, index) => `$${index + 2}`).join(",")})` : ""}
     ORDER BY COALESCE(n.last_read_at,0) DESC,n.id`,
    [activeSince, ...(ids ?? [])],
  );
  return rows.flatMap(({ kind, count, ...novel }) => {
    const goal = kind === null ? null : toGoal({ novelId: novel.id, kind, count, updatedAt: 0 });
    return goal?.kind === "none" ? [] : [{ ...novel, goal }];
  });
}

/** Active, unpaused library source novels in a deletion scope that the global automatic policy covers. */
export async function listGoalNovelIdsForDownloadScope(
  scope: "chapter" | "novel" | "all",
  ids: readonly number[],
  activeSince: number | null = null,
): Promise<number[]> {
  const db = await getDb();
  const covered = `($1 IS NOT NULL AND n.in_library=1 AND n.is_local=0 AND n.last_read_at >= $1
    AND (g.novel_id IS NULL OR g.kind <> 'none'))`;
  if (scope === "all") {
    return (await db.select<{ novelId: number }[]>(
      `SELECT n.id AS novelId FROM novel n LEFT JOIN novel_download_goal g ON g.novel_id=n.id
       WHERE ${covered} ORDER BY n.id`, [activeSince])).map((row) => row.novelId);
  }
  const unique = [...new Set(ids)].filter(Number.isSafeInteger);
  const found = new Set<number>();
  for (let index = 0; index < unique.length; index += 500) {
    const chunk = unique.slice(index, index + 500);
    const placeholders = chunk.map((_, offset) => `$${offset + 2}`).join(",");
    const rows = await db.select<{ novelId: number }[]>(scope === "novel"
      ? `SELECT n.id AS novelId FROM novel n LEFT JOIN novel_download_goal g ON g.novel_id=n.id
         WHERE ${covered} AND n.id IN (${placeholders})`
      : `SELECT DISTINCT n.id AS novelId FROM chapter c JOIN novel n ON n.id=c.novel_id
         LEFT JOIN novel_download_goal g ON g.novel_id=n.id
         WHERE ${covered} AND c.id IN (${placeholders})`, [activeSince, ...chunk]);
    for (const row of rows) found.add(row.novelId);
  }
  return [...found].sort((left, right) => left - right);
}

/**
 * Keeps chapters the user deleted or cancelled out of future automatic work, including after policy changes.
 * Chapters that no longer exist are skipped.
 */
export async function excludeChaptersFromDownloadGoals(chapterIds: readonly number[], now = Date.now()): Promise<void> {
  const db = await getDb();
  const unique = [...new Set(chapterIds)].filter(Number.isSafeInteger);
  for (let index = 0; index < unique.length; index += 500) {
    const chunk = unique.slice(index, index + 500);
    const placeholders = chunk.map((_, offset) => `$${offset + 2}`).join(",");
    await db.execute(
      `INSERT INTO chapter_download_goal_exclusion(chapter_id,created_at)
       SELECT id,$1 FROM chapter WHERE id IN (${placeholders}) ON CONFLICT(chapter_id) DO NOTHING`,
      [now, ...chunk],
    );
  }
}

export async function listDownloadGoalExcludedChapterIds(novelId: number): Promise<number[]> {
  const db = await getDb();
  const rows = await db.select<{ chapterId: number }[]>(
    `SELECT e.chapter_id AS chapterId FROM chapter_download_goal_exclusion e JOIN chapter c ON c.id=e.chapter_id
     WHERE c.novel_id=$1 ORDER BY e.chapter_id`, [novelId]);
  return rows.map((row) => row.chapterId);
}

/** Clears only an explicit per-novel pause; legacy positive goals, queues, failures and chapter exclusions stay intact. */
export async function resumeStoppedNovelDownloadGoal(novelId: number): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute("DELETE FROM novel_download_goal WHERE novel_id=$1 AND kind='none'", [novelId]);
  return result.rowsAffected > 0;
}

/** Library source novels without their own goal, which follow the default keep-ahead. */
export async function listLibraryNovelsWithoutDownloadGoal(): Promise<{ id: number; pluginId: string }[]> {
  const db = await getDb();
  return db.select<{ id: number; pluginId: string }[]>(
    `SELECT n.id,n.plugin_id AS pluginId FROM novel n LEFT JOIN novel_download_goal g ON g.novel_id=n.id
     WHERE n.in_library=1 AND n.is_local=0 AND g.novel_id IS NULL ORDER BY n.id`);
}
