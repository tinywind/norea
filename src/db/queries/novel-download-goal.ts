import { getDb } from "../client";

export type NovelDownloadGoal =
  | { kind: "keep_ahead"; count: number }
  | { kind: "all_remaining" }
  | { kind: "entire" };

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
  if (row.kind === "all_remaining" || row.kind === "entire") return { kind: row.kind };
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
 * Stores the novel's goal, or removes it when `goal` is null.
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
  /** The novel's own goal, or null when it qualifies only for the default keep-ahead. */
  goal: NovelDownloadGoal | null;
}

/**
 * Source novels with their own goal, plus library novels opened since `activeSince`
 * (Unix seconds) when a default keep-ahead applies. Most recently read first.
 */
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
     WHERE n.is_local=0
       AND (g.novel_id IS NOT NULL OR ($1 IS NOT NULL AND n.in_library=1 AND n.last_read_at >= $1))
       ${ids ? `AND n.id IN (${ids.map((_, index) => `$${index + 2}`).join(",")})` : ""}
     ORDER BY COALESCE(n.last_read_at,0) DESC,n.id`,
    [activeSince, ...(ids ?? [])],
  );
  return rows.map(({ kind, count, ...novel }) => ({
    ...novel,
    goal: kind === null ? null : toGoal({ novelId: novel.id, kind, count, updatedAt: 0 }),
  }));
}

/** Novels with their own goal among the novels, the chapters' novels, or every novel for "all". */
export async function listGoalNovelIdsForDownloadScope(
  scope: "chapter" | "novel" | "all",
  ids: readonly number[],
): Promise<number[]> {
  const db = await getDb();
  if (scope === "all") {
    return (await db.select<{ novelId: number }[]>("SELECT novel_id AS novelId FROM novel_download_goal ORDER BY novel_id"))
      .map((row) => row.novelId);
  }
  const unique = [...new Set(ids)].filter(Number.isSafeInteger);
  const found = new Set<number>();
  for (let index = 0; index < unique.length; index += 500) {
    const chunk = unique.slice(index, index + 500);
    const placeholders = chunk.map((_, offset) => `$${offset + 1}`).join(",");
    const rows = await db.select<{ novelId: number }[]>(scope === "novel"
      ? `SELECT novel_id AS novelId FROM novel_download_goal WHERE novel_id IN (${placeholders})`
      : `SELECT DISTINCT g.novel_id AS novelId FROM chapter c JOIN novel_download_goal g ON g.novel_id=c.novel_id
         WHERE c.id IN (${placeholders})`, chunk);
    for (const row of rows) found.add(row.novelId);
  }
  return [...found].sort((left, right) => left - right);
}
