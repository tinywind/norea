import { getDb, runDatabaseTransaction } from "../client";
import { sqliteBoolean } from "../sqlite-value";
import type { PackageManifest } from "../../lib/content-sync/native";

export async function readContentSyncCache(key: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ payload: string }[]>("SELECT payload FROM content_sync_cache WHERE cache_key=$1", [key]);
  return rows[0]?.payload ?? null;
}

export async function writeContentSyncCache(key: string, payload: string): Promise<void> {
  const db = await getDb();
  await db.execute("INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload", [key, payload]);
}

export interface ContentSyncChapter {
  chapterId: number;
  novelId: number;
  pluginId: string;
  novelPath: string;
  chapterPath: string;
  novelName: string;
  author: string | null;
  summary: string | null;
  isLocal: boolean;
  chapterName: string;
  chapterNumber: string | null;
  position: number;
  page: string;
  contentType: PackageManifest["chapter"]["contentType"];
  isDownloaded: boolean;
  mediaRepairNeeded: boolean;
  contentBytes: number;
  mediaBytes: number;
}

export async function listContentSyncChapters(identities?: string[]): Promise<ContentSyncChapter[]> {
  if (identities?.length === 0) return [];
  if (identities && identities.length > 100) {
    const rows: ContentSyncChapter[] = [];
    for (let offset = 0; offset < identities.length; offset += 100) rows.push(...await listContentSyncChapters(identities.slice(offset, offset + 100)));
    return rows;
  }
  const db = await getDb();
  const targets = identities?.flatMap((identity) => JSON.parse(identity) as string[]);
  const prefix = identities ? `WITH targets(plugin_id,novel_path,chapter_path) AS (VALUES ${identities.map((_, i) => `($${i * 3 + 1},$${i * 3 + 2},$${i * 3 + 3})`).join(",")})` : "";
  const from = identities ? "targets t JOIN novel n ON n.plugin_id=t.plugin_id AND n.path=t.novel_path JOIN chapter c ON c.novel_id=n.id AND c.path=t.chapter_path" : "chapter c JOIN novel n ON n.id=c.novel_id";
  const rows = await db.select<ContentSyncChapter[]>(`${prefix} SELECT
    c.id AS chapterId, n.id AS novelId, n.plugin_id AS pluginId, n.path AS novelPath,
    c.path AS chapterPath, n.name AS novelName, n.author, n.summary,
    n.is_local AS isLocal,
    c.name AS chapterName, c.chapter_number AS chapterNumber, c.position, c.page,
    COALESCE(c.stored_content_type,c.content_type) AS contentType,
    c.is_downloaded AS isDownloaded, c.media_repair_needed AS mediaRepairNeeded,
    c.content_bytes AS contentBytes, c.media_bytes AS mediaBytes
    FROM ${from} ORDER BY n.id,c.position,c.id`, targets);
  return rows.map((row) => ({ ...row, isLocal: sqliteBoolean(row.isLocal),
    isDownloaded: sqliteBoolean(row.isDownloaded), mediaRepairNeeded: sqliteBoolean(row.mediaRepairNeeded) }));
}

export async function importContentMetadata(manifest: PackageManifest): Promise<{ novelId: number; chapterId: number }> {
  return runDatabaseTransaction(async (db) => {
    const { identity, novel, chapter } = manifest;
    await db.execute(`INSERT INTO novel(plugin_id,path,name,author,summary,is_local)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(plugin_id,path) DO NOTHING`,
    [identity.pluginId, identity.novelPath, novel.name, novel.author ?? null, novel.summary ?? null, novel.isLocal ? 1 : 0]);
    const novels = await db.select<{ id: number }[]>("SELECT id FROM novel WHERE plugin_id=$1 AND path=$2", [identity.pluginId, identity.novelPath]);
    const novelId = novels[0]!.id;
    await db.execute(`INSERT INTO chapter(novel_id,path,name,chapter_number,position,page,content_type)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(novel_id,path) DO NOTHING`,
    [novelId, identity.chapterPath, chapter.name, chapter.chapterNumber ?? null, chapter.position, chapter.page, chapter.contentType]);
    const chapters = await db.select<{ id: number }[]>("SELECT id FROM chapter WHERE novel_id=$1 AND path=$2", [novelId, identity.chapterPath]);
    return { novelId, chapterId: chapters[0]!.id };
  }, true);
}

export async function markContentInstalled(chapterId: number, contentType: string, contentBytes: number, mediaBytes: number): Promise<void> {
  await runDatabaseTransaction(async (db) => {
    const result = await db.execute(`UPDATE chapter SET is_downloaded=1,stored_content_type=$2,content_bytes=$3,
      media_bytes=$4,media_repair_needed=0,media_bytes_checked_at=unixepoch(),updated_at=unixepoch() WHERE id=$1`,
    [chapterId, contentType, contentBytes, mediaBytes]);
    if (result.rowsAffected !== 1) throw new Error("Downloaded chapter no longer exists locally.");
  }, true);
}

export function contentIdentity(pluginId: string, novelPath: string, chapterPath = ""): string {
  return JSON.stringify([pluginId, novelPath, chapterPath]);
}

export interface ContentJournalEntry { sequence: number; key: string; value: null }

export async function contentJournalHead(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ sequence: number }[]>("SELECT COALESCE(MAX(sequence),0) AS sequence FROM content_sync_journal");
  return rows[0]?.sequence ?? 0;
}

export async function readContentJournal(after: number, through: number): Promise<ContentJournalEntry[]> {
  const db = await getDb();
  const rows = await db.select<{ sequence: number; key: string; payload: string }[]>(`SELECT j.sequence,j.state_key AS key,j.payload
    FROM content_sync_journal j JOIN (SELECT MAX(sequence) AS sequence FROM content_sync_journal
    WHERE sequence>$1 AND sequence<=$2 AND state_key LIKE 'content:%' GROUP BY state_key) latest ON latest.sequence=j.sequence ORDER BY j.sequence`, [after, through]);
  return rows.map((row) => ({ sequence: row.sequence, key: row.key, value: null }));
}
