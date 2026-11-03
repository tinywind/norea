import { getDb } from "../client";
import { sqliteBoolean } from "../sqlite-value";

function debugRepositoryQuery(message: string, data?: unknown): void {
  console.debug(`[repository-db] ${message}`, data);
}

export interface PluginRepository {
  id: number;
  url: string;
  name: string | null;
  addedAt: number;
  /** 1 is first. The first enabled repository listing a plugin id wins. */
  priority: number;
  enabled: boolean;
}

interface RawRepositoryRow extends Omit<PluginRepository, "enabled"> {
  enabled: unknown;
}

/** Every repository, in priority order. */
export async function listRepositories(): Promise<PluginRepository[]> {
  const db = await getDb();
  const rows = await db.select<RawRepositoryRow[]>(`
    SELECT
      id,
      url,
      name,
      added_at AS addedAt,
      priority,
      enabled
    FROM repository
    ORDER BY priority, id
  `);
  debugRepositoryQuery("list complete", { count: rows.length });
  return rows.map((row) => ({ ...row, enabled: sqliteBoolean(row.enabled) }));
}

export interface AddRepositoryInput {
  url: string;
  name?: string | null;
}

/**
 * Appends a repository after the others, enabled. Resolves false when the
 * URL is already in the list, which is left unchanged.
 */
export async function addRepository(input: AddRepositoryInput): Promise<boolean> {
  debugRepositoryQuery("add start", { url: input.url });
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO repository (url, name, priority, enabled)
     VALUES ($1, $2, (SELECT COALESCE(MAX(priority), 0) + 1 FROM repository), 1)
     ON CONFLICT(url) DO NOTHING`,
    [input.url, input.name ?? null],
  );
  debugRepositoryQuery("add complete", { url: input.url, added: result.rowsAffected > 0 });
  return result.rowsAffected > 0;
}

export async function setRepositoryEnabled(id: number, enabled: boolean): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE repository SET enabled = $1 WHERE id = $2`, [enabled ? 1 : 0, id]);
}

/** Stores `orderedIds` as priorities 1..n in one statement. */
export async function reorderRepositories(orderedIds: readonly number[]): Promise<void> {
  if (orderedIds.length === 0) return;
  const db = await getDb();
  const cases = orderedIds.map((_, index) => `WHEN $${index + 1} THEN ${index + 1}`).join(" ");
  const ids = orderedIds.map((_, index) => `$${index + 1}`).join(", ");
  await db.execute(
    `UPDATE repository SET priority = CASE id ${cases} END WHERE id IN (${ids})`,
    [...orderedIds],
  );
}

export async function removeRepository(id: number): Promise<void> {
  debugRepositoryQuery("remove start", { id });
  const db = await getDb();
  debugRepositoryQuery("delete cache start", { id });
  await db.execute(
    `DELETE FROM repository_index_cache
     WHERE repo_url = (SELECT url FROM repository WHERE id = $1)`,
    [id],
  );
  debugRepositoryQuery("delete cache complete", { id });
  debugRepositoryQuery("delete repository start", { id });
  await db.execute(`DELETE FROM repository WHERE id = $1`, [id]);
  debugRepositoryQuery("delete repository complete", { id });
}
