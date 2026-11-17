import type { TestSqliteDatabase as Database } from "./types";

/** `completedOverride` of the novel read models; a test database built without migration 13 has none. */
export async function completedOverrideInDb(
  db: Pick<Database, "select">,
  novelId: unknown,
): Promise<boolean | null> {
  const [schema] = await db.select<{ present: number }[]>(
    "SELECT COUNT(*) AS present FROM sqlite_master WHERE type='table' AND name='novel_override'",
  );
  if (schema?.present !== 1) return null;
  const [row] = await db.select<{ completed: number | null }[]>(
    `SELECT CASE json_type(payload, '$.fields.completed.value')
              WHEN 'true' THEN 1 WHEN 'false' THEN 0 END AS completed
     FROM novel_override WHERE novel_id = $1`,
    [novelId],
  );
  return typeof row?.completed === "number" ? row.completed !== 0 : null;
}

/** The stored `novel_override.payload` of each novel, keyed by novel id. */
export async function overridePayloadsInDb(
  db: Pick<Database, "select">,
): Promise<Map<number, string>> {
  const [schema] = await db.select<{ present: number }[]>(
    "SELECT COUNT(*) AS present FROM sqlite_master WHERE type='table' AND name='novel_override'",
  );
  if (schema?.present !== 1) return new Map();
  const rows = await db.select<{ novelId: number; payload: string }[]>(
    "SELECT novel_id AS novelId, payload FROM novel_override",
  );
  return new Map(rows.map((row) => [row.novelId, row.payload]));
}
