import { getDb, runDatabaseTransaction } from "../client";
import { sqliteBoolean } from "../sqlite-value";
import type { PackageManifest } from "../../lib/content-sync/native";
import type { ServerChapterSummary } from "../../lib/content-sync/chapters";
import { LOCAL_PLUGIN_ID } from "../../lib/plugins/types";
import { reconcileImportedNovelIdentityInDb } from "./novel-identity";

export async function cacheServerChapters(novelId: number, chapters: readonly ServerChapterSummary[], signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const changed = await runDatabaseTransaction(async db => {
    if (signal?.aborted) return false;
    const [novel] = await db.select<{ pluginId: string }[]>(
      "SELECT plugin_id AS pluginId FROM novel WHERE id=$1", [novelId]);
    const existing = await db.select<{ path: string; chapterNumber: string | null }[]>(
      "SELECT path,chapter_number AS chapterNumber FROM chapter WHERE novel_id=$1", [novelId]);
    if (signal?.aborted) return false;
    const paths = new Set(existing.map(chapter => chapter.path));
    const numbers = new Map<string, string[]>();
    for (const chapter of existing) {
      if (!chapter.chapterNumber?.trim() || !Number.isFinite(Number(chapter.chapterNumber))) continue;
      const number = String(Number(chapter.chapterNumber));
      numbers.set(number, [...(numbers.get(number) ?? []), chapter.path]);
    }
    const incoming: ServerChapterSummary[] = [];
    for (const chapter of chapters) {
      if (paths.has(chapter.chapterPath)) continue;
      const number = novel?.pluginId !== LOCAL_PLUGIN_ID && chapter.chapterNumber?.trim() && Number.isFinite(Number(chapter.chapterNumber)) ? String(Number(chapter.chapterNumber)) : null;
      const matches = number === null ? [] : numbers.get(number) ?? [];
      if (matches.length) {
        if (matches.length > 1) throw new Error("Server chapter number matches multiple local chapters.");
        continue;
      }
      incoming.push(chapter);
      paths.add(chapter.chapterPath);
      if (number !== null) numbers.set(number, [chapter.chapterPath]);
    }
    let inserted = false;
    for (let offset = 0; offset < incoming.length; offset += 100) {
      if (signal?.aborted) break;
      const batch = incoming.slice(offset, offset + 100);
      const result = await db.execute(`INSERT INTO chapter(novel_id,path,name,chapter_number,position,page,content_type)
        VALUES ${batch.map((_, index) => `(${Array.from({ length: 7 }, (_, column) => `$${index * 7 + column + 1}`).join(",")})`).join(",")}
        ON CONFLICT(novel_id,path) DO NOTHING`, batch.flatMap(chapter => [novelId, chapter.chapterPath, chapter.name, chapter.chapterNumber ?? null, chapter.position, chapter.page, chapter.contentType]));
      inserted ||= result.rowsAffected > 0;
    }
    return inserted;
  }, true);
  // Report navigation cancellation after committing already cached chapters.
  signal?.throwIfAborted();
  return changed;
}

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
  isDownloadQueued: boolean;
  contentBytes: number;
  mediaBytes: number;
}

export async function listContentSyncChapters(identities?: string[], downloadedOnly = false): Promise<ContentSyncChapter[]> {
  return selectContentSyncChapters(identities, downloadedOnly, false);
}

export async function listContentSyncWorkChapters(workIdentities: string[]): Promise<ContentSyncChapter[]> {
  return selectContentSyncChapters(workIdentities, true, true);
}

async function selectContentSyncChapters(identities: string[] | undefined, downloadedOnly: boolean, matchWorks: boolean): Promise<ContentSyncChapter[]> {
  if (identities?.length === 0) return [];
  if (identities && identities.length > 100) {
    const rows: ContentSyncChapter[] = [];
    for (let offset = 0; offset < identities.length; offset += 100) rows.push(...await selectContentSyncChapters(identities.slice(offset, offset + 100), downloadedOnly, matchWorks));
    return rows;
  }
  const db = await getDb();
  const targets = identities?.flatMap((identity) => JSON.parse(identity) as string[]);
  const columns = matchWorks ? ["plugin_id", "novel_path"] : ["plugin_id", "novel_path", "chapter_path"];
  const prefix = identities ? `WITH targets(${columns.join(",")}) AS (VALUES ${identities.map((_, i) => `(${columns.map((_, column) => `$${i * columns.length + column + 1}`).join(",")})`).join(",")})` : "";
  const from = identities ? `targets t JOIN novel n ON n.plugin_id=t.plugin_id AND n.path=t.novel_path JOIN chapter c ON c.novel_id=n.id${matchWorks ? "" : " AND c.path=t.chapter_path"}` : "chapter c JOIN novel n ON n.id=c.novel_id";
  const rows = await db.select<ContentSyncChapter[]>(`${prefix} SELECT
    c.id AS chapterId, n.id AS novelId, n.plugin_id AS pluginId, n.path AS novelPath,
    c.path AS chapterPath, n.name AS novelName, n.author, n.summary,
    n.is_local AS isLocal,
    c.name AS chapterName, c.chapter_number AS chapterNumber, c.position, c.page,
    COALESCE(c.stored_content_type,c.content_type) AS contentType,
    c.is_downloaded AS isDownloaded, c.media_repair_needed AS mediaRepairNeeded,
    c.content_bytes AS contentBytes, c.media_bytes AS mediaBytes,
    EXISTS(SELECT 1 FROM chapter_download_queue q WHERE q.chapter_id=c.id) AS isDownloadQueued
    FROM ${from} ${downloadedOnly ? "WHERE c.is_downloaded=1" : ""} ORDER BY n.id,c.position,c.id`, targets);
  return rows.map((row) => ({ ...row, isLocal: sqliteBoolean(row.isLocal),
    isDownloaded: sqliteBoolean(row.isDownloaded), mediaRepairNeeded: sqliteBoolean(row.mediaRepairNeeded),
    isDownloadQueued: sqliteBoolean(row.isDownloadQueued) }));
}

export async function canUploadContentChapter(chapterId: number): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<{ ready: boolean }[]>(`SELECT EXISTS(
    SELECT 1 FROM chapter c WHERE c.id=$1 AND c.is_downloaded=1 AND c.media_repair_needed=0
    AND NOT EXISTS(SELECT 1 FROM chapter_download_queue q WHERE q.chapter_id=c.id)
  ) AS ready`, [chapterId]);
  return sqliteBoolean(rows[0]?.ready);
}

export async function importContentMetadata(manifest: PackageManifest): Promise<{ novelId: number; chapterId: number }> {
  return runDatabaseTransaction(async (db) => {
    const { identity, chapter } = manifest;
    const novels = await db.select<{ id: number }[]>("SELECT id FROM novel WHERE plugin_id=$1 AND path=$2", [identity.pluginId, identity.novelPath]);
    if (!novels.length) throw new Error("Install the work metadata before downloading its chapters.");
    const novelId = novels[0]!.id;
    const chapterNumber = chapter.chapterNumber?.trim();
    if (identity.pluginId !== LOCAL_PLUGIN_ID && !identity.chapterPath.startsWith("norea-folder:") && chapterNumber && Number.isFinite(Number(chapterNumber))) {
      await reconcileImportedNovelIdentityInDb(db, { pluginId: identity.pluginId, path: identity.novelPath }, [
        { path: identity.chapterPath, chapterNumber },
      ]);
    }
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

export interface ContentJournalEntry { sequence: number; key: string }

export async function contentJournalHead(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ sequence: number }[]>("SELECT COALESCE(MAX(sequence),0) AS sequence FROM content_sync_journal");
  return rows[0]?.sequence ?? 0;
}

export async function readContentJournal(after: number, through: number): Promise<ContentJournalEntry[]> {
  const db = await getDb();
  return db.select<ContentJournalEntry[]>(`SELECT j.sequence,j.state_key AS key
    FROM content_sync_journal j JOIN (SELECT MAX(sequence) AS sequence FROM content_sync_journal
    WHERE sequence>$1 AND sequence<=$2 GROUP BY state_key) latest ON latest.sequence=j.sequence ORDER BY j.sequence`, [after, through]);
}
