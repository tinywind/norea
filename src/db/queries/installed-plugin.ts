import { getDb } from "../client";

export interface InstalledPluginRow {
  id: string;
  name: string;
  lang: string;
  version: string;
  iconUrl: string;
  sourceUrl: string;
  sourceCode: string;
  installedAt: number;
  /** The publishing repository updates come from; null when unknown. */
  repositoryUrl: string | null;
}

export interface UpsertInstalledPluginInput {
  id: string;
  name: string;
  lang: string;
  version: string;
  iconUrl: string;
  sourceUrl: string;
  sourceCode: string;
  repositoryUrl: string | null;
}

const SELECT_ALL = `
  SELECT
    id,
    name,
    lang,
    version,
    icon_url    AS iconUrl,
    source_url  AS sourceUrl,
    source_code AS sourceCode,
    installed_at AS installedAt,
    repository_url AS repositoryUrl
  FROM installed_plugin
  ORDER BY installed_at DESC, id ASC
`;

export async function listInstalledPlugins(): Promise<InstalledPluginRow[]> {
  const db = await getDb();
  return db.select<InstalledPluginRow[]>(SELECT_ALL);
}

/**
 * Upsert by primary key (`id`). Reinstalling a plugin overwrites the
 * stored source so a freshly published version replaces the old.
 */
export async function upsertInstalledPlugin(
  input: UpsertInstalledPluginInput,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO installed_plugin (
       id, name, lang, version, icon_url, source_url, source_code, repository_url
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       lang = excluded.lang,
       version = excluded.version,
       icon_url = excluded.icon_url,
       source_url = excluded.source_url,
       source_code = excluded.source_code,
       repository_url = excluded.repository_url,
       installed_at = unixepoch()`,
    [
      input.id,
      input.name,
      input.lang,
      input.version,
      input.iconUrl,
      input.sourceUrl,
      input.sourceCode,
      input.repositoryUrl,
    ],
  );
}

export async function deleteInstalledPlugin(id: string): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM installed_plugin WHERE id = $1`, [id]);
}
