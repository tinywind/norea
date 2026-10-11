import type Database from "@tauri-apps/plugin-sql";
import { base64ToBytes } from "../lib/base64";
import { chapterStorageRelativeDir } from "../lib/chapter-storage-path";
import { isTauriRuntime } from "../lib/tauri-runtime";
import { clearAuthoritativeStorageDirs, rememberAuthoritativeChapterStorageDir, rememberResolvedNovelStorageDir } from "../lib/chapter-storage-resolution";
import { availableNovelMetadataDirectory, listStoredNovelMetadata, parseNovelMetadata, registerNativeWorkChapterDirectories, removeStoredNovelCover, withWorkMetadataRollback, workMetadataOperation, writeStoredNovelCover, writeStoredNovelMetadata, type NovelMetadataV1 } from "../lib/work-metadata";
import { isLocalCoverSource } from "../lib/local-cover";

const knownFiles = new Map<string, { directory: string; serialized: string }>();
const novelColumns = ["plugin_id", "path", "name", "cover", "author", "artist", "summary", "status", "genres", "is_local"];
const chapterColumns = ["novel_id", "path", "name", "chapter_number", "position", "page", "content_type", "release_time"];
const keyFor = (pluginId: string, path: string) => JSON.stringify([pluginId, path]);

export async function applyNovelMetadataToCache(db: Database, metadata: NovelMetadataV1, directory?: string): Promise<number> {
  parseNovelMetadata(metadata);
  const n = metadata.novel;
  await db.execute(`INSERT INTO novel (plugin_id,path,name,cover,author,artist,summary,status,genres,is_local)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT(plugin_id,path) DO UPDATE SET name=excluded.name,cover=excluded.cover,author=excluded.author,
    artist=excluded.artist,summary=excluded.summary,status=excluded.status,genres=excluded.genres,is_local=excluded.is_local`,
  [metadata.identity.pluginId, metadata.identity.novelPath, n.name, n.cover, n.author, n.artist, n.summary, n.status, n.genres, n.isLocal ? 1 : 0]);
  const [row] = await db.select<{ id: number }[]>("SELECT id FROM novel WHERE plugin_id=$1 AND path=$2", [metadata.identity.pluginId, metadata.identity.novelPath]);
  if (!row) throw new Error("work metadata: cache identity missing");
  if (directory) rememberResolvedNovelStorageDir(row.id, directory);
  const existing = await db.select<{ id: number; path: string }[]>("SELECT id,path FROM chapter WHERE novel_id=$1", [row.id]);
  const keep = new Set(metadata.chapters.map((chapter) => chapter.path));
  for (const chapter of existing) {
    if (!keep.has(chapter.path)) await db.execute("DELETE FROM chapter WHERE id=$1", [chapter.id]);
  }
  for (let offset = 0; offset < metadata.chapters.length; offset += 100) {
    const chapters = metadata.chapters.slice(offset, offset + 100);
    const params: unknown[] = [row.id, metadata.identity.pluginId, metadata.identity.novelPath];
    const values = chapters.map((c) => {
      const first = params.length + 1;
      params.push(c.path, c.name, c.chapterNumber, c.position, c.page, c.contentType, c.releaseTime);
      return `(${Array.from({ length: 7 }, (_, index) => `$${first + index}`).join(",")})`;
    });
    await db.execute(`WITH incoming(path,name,chapter_number,position,page,content_type,release_time) AS (VALUES ${values.join(",")})
      INSERT INTO chapter (novel_id,path,name,chapter_number,position,page,content_type,release_time,progress,bookmark,unread,read_at)
      SELECT $1,incoming.path,incoming.name,incoming.chapter_number,incoming.position,incoming.page,incoming.content_type,incoming.release_time,
        COALESCE(state.progress,0),COALESCE(state.bookmark,0),COALESCE(state.unread,1),state.read_at
      FROM incoming LEFT JOIN work_metadata_reading_state state ON state.plugin_id=$2 AND state.novel_path=$3 AND state.chapter_path=incoming.path WHERE true
      ON CONFLICT(novel_id,path) DO UPDATE SET name=excluded.name,chapter_number=excluded.chapter_number,
      position=excluded.position,page=excluded.page,content_type=excluded.content_type,release_time=excluded.release_time`, params);
  }
  if (directory) {
    const rows = await db.select<{ id: number; path: string }[]>("SELECT id,path FROM chapter WHERE novel_id=$1", [row.id]);
    const byPath = new Map(metadata.chapters.map((chapter) => [chapter.path, chapter.directory]));
    for (const chapter of rows) rememberAuthoritativeChapterStorageDir(chapter.id, `${directory}/${byPath.get(chapter.path)}`);
    await registerNativeWorkChapterDirectories(Object.fromEntries(rows.map((chapter) => [String(chapter.id), `${directory}/${byPath.get(chapter.path)}`])));
  }
  return row.id;
}

export async function initializeWorkMetadata(db: Database): Promise<void> {
  if (!isTauriRuntime()) return;
  // The dirty queue is rebuildable bookkeeping, never a second metadata authority.
  await db.execute("CREATE TABLE IF NOT EXISTS work_metadata_dirty (plugin_id text NOT NULL, path text NOT NULL, PRIMARY KEY(plugin_id,path))");
  await db.execute(`CREATE TABLE IF NOT EXISTS work_metadata_reading_state (
    plugin_id text NOT NULL, novel_path text NOT NULL, chapter_path text NOT NULL,
    progress integer NOT NULL, bookmark integer NOT NULL, unread integer NOT NULL, read_at integer,
    PRIMARY KEY(plugin_id,novel_path,chapter_path))`);
  await db.execute(`CREATE TRIGGER IF NOT EXISTS work_metadata_preserve_reading BEFORE DELETE ON chapter BEGIN
    INSERT INTO work_metadata_reading_state(plugin_id,novel_path,chapter_path,progress,bookmark,unread,read_at)
    SELECT plugin_id,path,OLD.path,OLD.progress,OLD.bookmark,OLD.unread,OLD.read_at FROM novel WHERE id=OLD.novel_id
    ON CONFLICT(plugin_id,novel_path,chapter_path) DO UPDATE SET progress=excluded.progress,bookmark=excluded.bookmark,unread=excluded.unread,read_at=excluded.read_at;
    END`);
  for (const [table, columns] of [["novel", novelColumns], ["chapter", chapterColumns]] as const) {
    for (const action of ["INSERT", "UPDATE", "DELETE"]) {
      const ref = action === "DELETE" ? "OLD" : "NEW";
      const condition = action === "UPDATE" ? `WHEN ${columns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ")}` : "";
      const selection = table === "novel" ? `SELECT ${ref}.plugin_id,${ref}.path WHERE true` : `SELECT plugin_id,path FROM novel WHERE id=${ref}.novel_id`;
      await db.execute(`CREATE TRIGGER IF NOT EXISTS work_metadata_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} ${condition}
        BEGIN INSERT INTO work_metadata_dirty(plugin_id,path) ${selection} ON CONFLICT(plugin_id,path) DO NOTHING; END`);
    }
  }
  const entries = await listStoredNovelMetadata();
  knownFiles.clear();
  clearAuthoritativeStorageDirs();
  await registerNativeWorkChapterDirectories({}, true);
  await db.execute("BEGIN IMMEDIATE");
  try {
    for (const entry of entries) {
      await applyNovelMetadataToCache(db, entry.metadata, entry.directory);
      rememberStoredNovelMetadata(entry.directory, entry.metadata);
    }
    await db.execute("DELETE FROM work_metadata_dirty");
    await db.execute("COMMIT");
  } catch (error) { await db.execute("ROLLBACK"); throw error; }
}

export function rememberStoredNovelMetadata(directory: string, metadata: NovelMetadataV1): void {
  knownFiles.set(keyFor(metadata.identity.pluginId, metadata.identity.novelPath), { directory, serialized: JSON.stringify(metadata) });
}

export function knownNovelMetadataDirectory(identity: NovelMetadataV1["identity"]): string | undefined {
  return knownFiles.get(keyFor(identity.pluginId, identity.novelPath))?.directory;
}

interface CachedNovel {
  id: number; pluginId: string; path: string; name: string; cover: string | null;
  author: string | null; artist: string | null; summary: string | null; status: string | null; genres: string | null; isLocal: number;
}

export async function flushWorkMetadata(db: Database): Promise<void> {
  if (!isTauriRuntime()) return;
  const previousKnownFiles = new Map(knownFiles);
  try { await withWorkMetadataRollback(() => flushDirtyWorkMetadata(db)); }
  catch (error) {
    knownFiles.clear();
    for (const [key, value] of previousKnownFiles) knownFiles.set(key, value);
    throw error;
  }
}

async function flushDirtyWorkMetadata(db: Database): Promise<void> {
  const dirty = await db.select<{ pluginId: string; path: string }[]>("SELECT plugin_id AS pluginId,path FROM work_metadata_dirty");
  for (const identity of dirty) {
    const key = keyFor(identity.pluginId, identity.path);
    const known = knownFiles.get(key);
    let previous: NovelMetadataV1 | undefined;
    if (known) {
      const { body } = await workMetadataOperation({ operation: "read", path: `${known.directory}/novel.json` });
      if (!body) throw new Error("work metadata: authoritative file disappeared; reload before editing");
      previous = parseNovelMetadata(JSON.parse(new TextDecoder().decode(base64ToBytes(body))));
      if (JSON.stringify(previous) !== known.serialized) throw new Error("work metadata: file changed outside the cache; reload before editing");
    }
    const [novel] = await db.select<CachedNovel[]>(`SELECT id,plugin_id AS pluginId,path,name,cover,author,artist,summary,status,genres,is_local AS isLocal FROM novel WHERE plugin_id=$1 AND path=$2`, [identity.pluginId, identity.path]);
    if (!novel) {
      if (known) await workMetadataOperation({ operation: "remove", path: `${known.directory}/novel.json` });
      knownFiles.delete(key); continue;
    }
    const directory = known?.directory ?? await availableNovelMetadataDirectory({ identity: { pluginId: novel.pluginId, novelPath: novel.path }, novel: { ...novel, isLocal: Boolean(novel.isLocal) } });
    const chapters = await db.select<(Omit<NovelMetadataV1["chapters"][number], "directory"> & { id: number })[]>(`SELECT id,path,name,chapter_number AS chapterNumber,position,page,content_type AS contentType,release_time AS releaseTime FROM chapter WHERE novel_id=$1 ORDER BY position,id`, [novel.id]);
    const used = new Set<string>();
    const previousChapters = new Map(previous?.chapters.map((chapter) => [chapter.path, chapter]));
    const mapped = chapters.map((chapter) => {
      const old = previousChapters.get(chapter.path);
      const preferred = old?.directory ?? chapterStorageRelativeDir(novel, { ...chapter, id: undefined }).split("/").at(-1)!;
      let child = preferred; let suffix = 1;
      while (used.has(child.toLowerCase())) child = `${preferred}-${suffix++}`;
      used.add(child.toLowerCase());
      const { id, ...portable } = chapter;
      rememberAuthoritativeChapterStorageDir(id, `${directory}/${child}`);
      return { ...portable, directory: child };
    });
    let cover = previous?.cover ?? null;
    const coverResult = await workMetadataOperation({ operation: "read", path: `${directory}/cover.json` });
    if (coverResult.body) {
      const manifest = JSON.parse(new TextDecoder().decode(base64ToBytes(coverResult.body))) as Record<string, unknown>;
      if (manifest.sourceId === novel.pluginId && manifest.novelPath === novel.path && typeof manifest.fileName === "string" && typeof manifest.sourceUrl === "string") {
        cover = { fileName: manifest.fileName, sourceUrl: manifest.sourceUrl, contentType: typeof manifest.contentType === "string" ? manifest.contentType : null };
      }
    }
    if (!novel.cover && previous?.novel.cover !== null) cover = null;
    let localCoverBytes: Uint8Array | null = null;
    if (isLocalCoverSource(novel.cover)) {
      const [prefix, encoded] = novel.cover.split(",", 2);
      const contentType = prefix!.slice(5).split(";")[0]!;
      const extension = contentType.split("/")[1]!.replace("jpeg", "jpg");
      cover = { fileName: `cover.${extension}`, contentType, sourceUrl: "local:cover" };
      localCoverBytes = base64ToBytes(encoded!);
    }
    const metadata = parseNovelMetadata({ schemaVersion: 1, identity: { pluginId: novel.pluginId, novelPath: novel.path },
      novel: { name: novel.name, cover: novel.cover, author: novel.author, artist: novel.artist, summary: novel.summary, status: novel.status, genres: novel.genres, isLocal: Boolean(novel.isLocal) },
      chapters: mapped, cover, updatedAt: Date.now() });
    if (localCoverBytes) await writeStoredNovelCover(directory, metadata, localCoverBytes);
    await writeStoredNovelMetadata(directory, metadata);
    if (!cover && previous?.cover) await removeStoredNovelCover(directory, previous.cover);
    rememberResolvedNovelStorageDir(novel.id, directory);
    await registerNativeWorkChapterDirectories(Object.fromEntries(chapters.map((chapter, index) => [String(chapter.id), `${directory}/${mapped[index]!.directory}`])));
    rememberStoredNovelMetadata(directory, metadata);
  }
  if (dirty.length) await db.execute("DELETE FROM work_metadata_dirty");
}
