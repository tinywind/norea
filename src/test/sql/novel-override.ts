import type { TestSqliteDatabase as Database } from "./types";

/** `statusOverride` of the novel read models; a test database built without migration 13 has none. */
export async function statusOverrideInDb(
  db: Pick<Database, "select">,
  novelId: unknown,
): Promise<string | null> {
  const [schema] = await db.select<{ present: number }[]>(
    "SELECT COUNT(*) AS present FROM sqlite_master WHERE type='table' AND name='novel_override'",
  );
  if (schema?.present !== 1) return null;
  const [row] = await db.select<{ status: string | null }[]>(
    `SELECT CASE json_type(payload, '$.fields.status.value')
              WHEN 'text' THEN json_extract(payload, '$.fields.status.value')
              WHEN 'true' THEN NULL
              ELSE CASE json_type(payload, '$.fields.completed.value')
                     WHEN 'true' THEN 'Completed'
                     WHEN 'false' THEN 'Ongoing'
                   END
            END AS status
     FROM novel_override WHERE novel_id = $1`,
    [novelId],
  );
  return typeof row?.status === "string" ? row.status : null;
}

export async function coverOverrideInDb(
  db: Pick<Database, "select">,
  novelId: unknown,
): Promise<string | null> {
  const [schema] = await db.select<{ present: number }[]>(
    "SELECT COUNT(*) AS present FROM sqlite_master WHERE type='table' AND name='novel_override'",
  );
  if (schema?.present !== 1) return null;
  const [row] = await db.select<{ cover: string | null }[]>(
    `SELECT CASE WHEN json_type(payload, '$.fields.cover.value') = 'text'
                  AND json_extract(payload, '$.fields.cover.value') LIKE 'cover.override.%'
                 THEN json_extract(payload, '$.fields.cover.value')
            END AS cover
     FROM novel_override WHERE novel_id = $1`,
    [novelId],
  );
  return typeof row?.cover === "string" ? row.cover : null;
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
