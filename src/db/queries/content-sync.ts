import { getDb, runDatabaseTransaction } from "../client";
import { sqliteBoolean } from "../sqlite-value";
import type { PackageManifest } from "../../lib/content-sync/native";
import type { ContentStateValue } from "../../lib/content-sync/client";

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
  inLibrary: boolean;
  chapterName: string;
  chapterNumber: string | null;
  position: number;
  page: string;
  contentType: PackageManifest["chapter"]["contentType"];
  isDownloaded: boolean;
  mediaRepairNeeded: boolean;
  contentBytes: number;
  mediaBytes: number;
  unread: boolean;
  bookmark: boolean;
  progress: number;
  readAt: number | null;
}

export async function listContentSyncChapters(): Promise<ContentSyncChapter[]> {
  const db = await getDb();
  const rows = await db.select<ContentSyncChapter[]>(`SELECT
    c.id AS chapterId, n.id AS novelId, n.plugin_id AS pluginId, n.path AS novelPath,
    c.path AS chapterPath, n.name AS novelName, n.author, n.summary,
    n.is_local AS isLocal, n.in_library AS inLibrary,
    c.name AS chapterName, c.chapter_number AS chapterNumber, c.position, c.page,
    COALESCE(c.stored_content_type,c.content_type) AS contentType,
    c.is_downloaded AS isDownloaded, c.media_repair_needed AS mediaRepairNeeded,
    c.content_bytes AS contentBytes, c.media_bytes AS mediaBytes,
    c.unread, c.bookmark, c.progress, c.read_at AS readAt
    FROM chapter c JOIN novel n ON n.id=c.novel_id ORDER BY n.id,c.position,c.id`);
  return rows.map((row) => ({ ...row, isLocal: sqliteBoolean(row.isLocal), inLibrary: sqliteBoolean(row.inLibrary),
    isDownloaded: sqliteBoolean(row.isDownloaded), mediaRepairNeeded: sqliteBoolean(row.mediaRepairNeeded),
    unread: sqliteBoolean(row.unread), bookmark: sqliteBoolean(row.bookmark) }));
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
  });
}

export async function markContentInstalled(chapterId: number, contentType: string, contentBytes: number, mediaBytes: number): Promise<void> {
  const db = await getDb();
  const result = await db.execute(`UPDATE chapter SET is_downloaded=1,stored_content_type=$2,content_bytes=$3,
    media_bytes=$4,media_repair_needed=0,media_bytes_checked_at=unixepoch(),updated_at=unixepoch() WHERE id=$1`,
  [chapterId, contentType, contentBytes, mediaBytes]);
  if (result.rowsAffected !== 1) throw new Error("Downloaded chapter no longer exists locally.");
}

export function contentIdentity(pluginId: string, novelPath: string, chapterPath = ""): string {
  return JSON.stringify([pluginId, novelPath, chapterPath]);
}

export async function readContentState(lastReadChapterByNovel: Readonly<Record<number, number>> = {}): Promise<Record<string, ContentStateValue>> {
  const db = await getDb();
  const novels = await db.select<{ pluginId: string; path: string; inLibrary: unknown }[]>("SELECT plugin_id AS pluginId,path,in_library AS inLibrary FROM novel");
  const state: Record<string, ContentStateValue> = {};
  for (const novel of novels) state[`library:${contentIdentity(novel.pluginId, novel.path)}`] = { deleted: !sqliteBoolean(novel.inLibrary) };
  const positions = new Map<string, ContentSyncChapter>();
  const selectedPositions = new Map<string, ContentSyncChapter>();
  for (const row of await listContentSyncChapters()) {
    const identity = contentIdentity(row.pluginId, row.novelPath, row.chapterPath);
    state[`read:${identity}`] = { unread: row.unread, progress: row.progress };
    state[`bookmark:${identity}`] = { deleted: !row.bookmark };
    const work = contentIdentity(row.pluginId, row.novelPath);
    if (row.chapterId === lastReadChapterByNovel[row.novelId] && row.readAt !== null) selectedPositions.set(work, row);
    if (row.readAt && row.readAt >= (positions.get(work)?.readAt ?? 0)) positions.set(work, row);
  }
  for (const [identity, row] of selectedPositions) positions.set(identity, row);
  for (const [identity, row] of positions) state[`position:${identity}`] = { chapterPath: row.chapterPath, progress: row.progress, readAt: row.readAt };
  return state;
}

export async function applyContentState(key: string, value: ContentStateValue): Promise<{ novelId: number; chapterId?: number } | null> {
  const separator = key.indexOf(":");
  const kind = key.slice(0, separator);
  const [pluginId, novelPath, chapterPath] = JSON.parse(key.slice(separator + 1)) as string[];
  const db = await getDb();
  const novels = await db.select<{ id: number }[]>("SELECT id FROM novel WHERE plugin_id=$1 AND path=$2", [pluginId, novelPath]);
  const novelId = novels[0]?.id;
  if (!novelId) return null;
  if (kind === "library" && "deleted" in value) {
    await db.execute("UPDATE novel SET in_library=$2,library_added_at=CASE WHEN $2=1 THEN COALESCE(library_added_at,unixepoch()) ELSE NULL END WHERE id=$1", [novelId, value.deleted ? 0 : 1]);
    return { novelId };
  }
  const targetPath = kind === "position" && "chapterPath" in value ? value.chapterPath : chapterPath;
  const chapters = await db.select<{ id: number }[]>("SELECT id FROM chapter WHERE novel_id=$1 AND path=$2", [novelId, targetPath]);
  const chapterId = chapters[0]?.id;
  if (!chapterId) return null;
  if (kind === "bookmark" && "deleted" in value) await db.execute("UPDATE chapter SET bookmark=$2 WHERE id=$1", [chapterId, value.deleted ? 0 : 1]);
  if (kind === "read" && "unread" in value) await db.execute("UPDATE chapter SET unread=$2,progress=$3 WHERE id=$1", [chapterId, value.unread ? 1 : 0, value.progress]);
  if (kind === "position" && "chapterPath" in value) {
    if (value.readAt === null) await db.execute("UPDATE chapter SET read_at=NULL WHERE novel_id=$1", [novelId]);
    await db.execute("UPDATE chapter SET progress=$2,read_at=$3 WHERE id=$1", [chapterId, value.progress, value.readAt]);
    await db.execute("UPDATE novel SET last_read_at=$2 WHERE id=$1", [novelId, value.readAt]);
  }
  return { novelId, chapterId };
}
