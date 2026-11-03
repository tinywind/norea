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
