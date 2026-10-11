import type Database from "@tauri-apps/plugin-sql";
import { base64ToBytes, bytesToBase64 } from "../lib/base64";
import { chapterStorageRelativeDir } from "../lib/chapter-storage-path";
import { isTauriRuntime } from "../lib/tauri-runtime";
import { clearAuthoritativeStorageDirs, rememberAuthoritativeChapterStorageDir, rememberResolvedNovelStorageDir } from "../lib/chapter-storage-resolution";
import { availableNovelMetadataDirectory, listStoredNovelChapters, listStoredNovelMetadata, parseNovelMetadata, registerNativeWorkChapterDirectories, removeStoredNovelCover, withWorkMetadataRollback, workMetadataOperation, writeStoredNovelCover, writeStoredNovelMetadata, type NovelMetadataV1 } from "../lib/work-metadata";
import { isLocalCoverSource } from "../lib/local-cover";

interface KnownMetadataFile { directory: string; fingerprint: string }
const knownFiles = new Map<string, KnownMetadataFile>();
const novelColumns = ["plugin_id", "path", "name", "cover", "author", "artist", "summary", "status", "genres", "rating", "is_local"];
const chapterColumns = ["novel_id", "path", "name", "chapter_number", "position", "page", "content_type", "release_time"];
const keyFor = (pluginId: string, path: string) => JSON.stringify([pluginId, path]);

export async function applyNovelMetadataToCache(db: Database, metadata: NovelMetadataV1, directory?: string): Promise<number> {
  parseNovelMetadata(metadata);
  const n = metadata.novel;
  await db.execute(`INSERT INTO novel (plugin_id,path,name,cover,author,artist,summary,status,genres,rating,is_local)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT(plugin_id,path) DO UPDATE SET name=excluded.name,cover=excluded.cover,author=excluded.author,
    artist=excluded.artist,summary=excluded.summary,status=excluded.status,genres=excluded.genres,rating=excluded.rating,is_local=excluded.is_local`,
  [metadata.identity.pluginId, metadata.identity.novelPath, n.name, n.cover, n.author, n.artist, n.summary, n.status, n.genres, n.rating, n.isLocal ? 1 : 0]);
  const [row] = await db.select<{ id: number }[]>("SELECT id FROM novel WHERE plugin_id=$1 AND path=$2", [metadata.identity.pluginId, metadata.identity.novelPath]);
  if (!row) throw new Error("work metadata: cache identity missing");
  if (directory) rememberResolvedNovelStorageDir(row.id, directory);
  return row.id;
}

export async function scanStoredNovelChaptersToCache(db: Database, novelId: number, directory: string): Promise<void> {
  const discovered = await listStoredNovelChapters(directory);
  const cached = await db.select<{ id: number; path: string; chapterNumber: string | null; position: number; directory: string | null }[]>(
    `SELECT c.id,c.path,c.chapter_number AS chapterNumber,c.position,d.directory FROM chapter c
    LEFT JOIN work_metadata_directory_cache d ON d.chapter_id=c.id WHERE c.novel_id=$1`, [novelId]);
  const byDirectory = new Map(cached.filter((row) => row.directory).map((row) => [row.directory, row]));
  const byPath = new Map(cached.map((row) => [row.path, row]));
  const byNumber = new Map<number, typeof cached>();
  for (const row of cached) {
    const number = Number(row.chapterNumber ?? row.position);
    const rows = byNumber.get(number) ?? [];
    rows.push(row); byNumber.set(number, rows);
  }
  const discoveredCounts = new Map<number, number>();
  for (const chapter of discovered) {
    const number = Number(chapter.chapterNumber);
    discoveredCounts.set(number, (discoveredCounts.get(number) ?? 0) + 1);
  }
  const directories: { id: number; directory: string }[] = [];
  const used = new Set<number>();
  for (const [index, chapter] of discovered.entries()) {
    const absoluteDirectory = `${directory}/${chapter.directory}`;
    const recoveredPath = `norea-folder:${chapter.chapterNumber}`;
    const exact = byDirectory.get(absoluteDirectory) ?? byPath.get(recoveredPath);
    const number = Number(chapter.chapterNumber);
    const numbered = byNumber.get(number) ?? [];
    const matched = exact ?? (numbered.length === 1 ? numbered[0] : undefined);
    if ((matched && used.has(matched.id)) || (!exact && (numbered.length > 1 || discoveredCounts.get(number)! > 1))) continue;
    let id = matched?.id;
    if (id === undefined) {
      const result = await db.execute(`INSERT INTO chapter(novel_id,path,name,chapter_number,position,content_type,stored_content_type,is_downloaded,progress,bookmark,unread,read_at)
        SELECT $1,$2,$3,$4,$5,$6,$6,1,COALESCE(state.progress,0),COALESCE(state.bookmark,0),COALESCE(state.unread,1),state.read_at
        FROM novel n LEFT JOIN work_metadata_reading_state state ON state.plugin_id=n.plugin_id AND state.novel_path=n.path AND state.chapter_path=$2 WHERE n.id=$1`,
      [novelId, recoveredPath, chapter.name, chapter.chapterNumber, index + 1, chapter.contentType]);
      id = result.lastInsertId;
      if (!id) throw new Error("work metadata: discovered chapter identity missing");
    } else {
      await db.execute("UPDATE chapter SET is_downloaded=1,stored_content_type=$1 WHERE id=$2", [chapter.contentType, id]);
    }
    used.add(id);
    directories.push({ id, directory: absoluteDirectory });
  }
  const retained = cached.filter((row) => row.directory && !used.has(row.id)).map((row) => ({ id: row.id, directory: row.directory! }));
  await persistWorkChapterDirectories(db, novelId, [...retained, ...directories]);
}

export async function initializeWorkMetadata(db: Database, options: { rebuild?: boolean } = {}): Promise<void> {
  if (!isTauriRuntime()) return;
  // The dirty queue is rebuildable bookkeeping, never a second metadata authority.
  await db.execute("CREATE TABLE IF NOT EXISTS work_metadata_dirty (plugin_id text NOT NULL, path text NOT NULL, PRIMARY KEY(plugin_id,path))");
  await db.execute("CREATE TABLE IF NOT EXISTS work_metadata_cache_state (id integer PRIMARY KEY CHECK(id=1))");
  await db.execute(`CREATE TABLE IF NOT EXISTS work_metadata_file_cache (
    plugin_id text NOT NULL, path text NOT NULL, novel_id integer NOT NULL,
    directory text NOT NULL, fingerprint text NOT NULL, PRIMARY KEY(plugin_id,path))`);
  await db.execute(`CREATE TABLE IF NOT EXISTS work_metadata_directory_cache (
    chapter_id integer PRIMARY KEY, novel_id integer NOT NULL, directory text NOT NULL)`);
  await db.execute("CREATE INDEX IF NOT EXISTS work_metadata_directory_novel ON work_metadata_directory_cache(novel_id)");
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
  const [initialized] = await db.select<{ id: number }[]>("SELECT id FROM work_metadata_cache_state WHERE id=1");
  const [pending] = await db.select<{ pending: number }[]>("SELECT 1 AS pending FROM work_metadata_dirty LIMIT 1");
  if (initialized && !pending && !options.rebuild) {
    await restoreWorkMetadataDirectories(db);
    return;
  }
  const entries = await listStoredNovelMetadata();
  knownFiles.clear();
  clearAuthoritativeStorageDirs();
  await registerNativeWorkChapterDirectories({}, true);
  await db.execute("BEGIN IMMEDIATE");
  try {
    await db.execute("DELETE FROM work_metadata_file_cache");
    await db.execute("DELETE FROM work_metadata_directory_cache WHERE chapter_id NOT IN (SELECT id FROM chapter)");
    for (const entry of entries) {
      const novelId = await applyNovelMetadataToCache(db, entry.metadata, entry.directory);
      await scanStoredNovelChaptersToCache(db, novelId, entry.directory);
      await rememberStoredNovelMetadata(db, entry.directory, entry.metadata);
    }
    await db.execute("DELETE FROM work_metadata_dirty");
    await db.execute("INSERT OR IGNORE INTO work_metadata_cache_state(id) VALUES(1)");
    await db.execute("COMMIT");
  } catch (error) {
    await db.execute("ROLLBACK");
    await restoreWorkMetadataDirectories(db);
    throw error;
  }
}

async function metadataFingerprint(metadata: NovelMetadataV1): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parseNovelMetadata(metadata))));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function restoreWorkMetadataDirectories(db: Database): Promise<void> {
  knownFiles.clear();
  clearAuthoritativeStorageDirs();
  const files = await db.select<{ pluginId: string; path: string; novelId: number; directory: string; fingerprint: string }[]>(
    "SELECT plugin_id AS pluginId,path,novel_id AS novelId,directory,fingerprint FROM work_metadata_file_cache");
  for (const file of files) {
    knownFiles.set(keyFor(file.pluginId, file.path), { directory: file.directory, fingerprint: file.fingerprint });
    rememberResolvedNovelStorageDir(file.novelId, file.directory);
  }
  await registerNativeWorkChapterDirectories({}, true);
  let afterId = 0;
  for (;;) {
    const chapters = await db.select<{ id: number; directory: string }[]>(
      "SELECT chapter_id AS id,directory FROM work_metadata_directory_cache WHERE chapter_id>$1 ORDER BY chapter_id LIMIT 1000", [afterId]);
    if (!chapters.length) break;
    for (const chapter of chapters) rememberAuthoritativeChapterStorageDir(chapter.id, chapter.directory);
    await registerNativeWorkChapterDirectories(Object.fromEntries(chapters.map((chapter) => [String(chapter.id), chapter.directory])));
    afterId = chapters.at(-1)!.id;
  }
}

export async function rememberStoredNovelMetadata(db: Database, directory: string, metadata: NovelMetadataV1): Promise<void> {
  const [novel] = await db.select<{ id: number }[]>("SELECT id FROM novel WHERE plugin_id=$1 AND path=$2", [metadata.identity.pluginId, metadata.identity.novelPath]);
  if (!novel) throw new Error("work metadata: cache identity missing");
  const fingerprint = await metadataFingerprint(metadata);
  await db.execute(`INSERT INTO work_metadata_file_cache(plugin_id,path,novel_id,directory,fingerprint) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(plugin_id,path) DO UPDATE SET novel_id=excluded.novel_id,directory=excluded.directory,fingerprint=excluded.fingerprint`,
  [metadata.identity.pluginId, metadata.identity.novelPath, novel.id, directory, fingerprint]);
  knownFiles.set(keyFor(metadata.identity.pluginId, metadata.identity.novelPath), { directory, fingerprint });
}

async function persistWorkChapterDirectories(db: Database, novelId: number, chapters: { id: number; directory: string }[]): Promise<void> {
  await db.execute("DELETE FROM work_metadata_directory_cache WHERE novel_id=$1", [novelId]);
  for (let offset = 0; offset < chapters.length; offset += 100) {
    const params: unknown[] = [];
    const batch = chapters.slice(offset, offset + 100);
    const values = batch.map((chapter) => {
      const first = params.length + 1;
      params.push(chapter.id, novelId, chapter.directory);
      return `($${first},$${first + 1},$${first + 2})`;
    });
    await db.execute(`INSERT INTO work_metadata_directory_cache(chapter_id,novel_id,directory) VALUES ${values.join(",")}`, params);
  }
  for (let offset = 0; offset < chapters.length; offset += 1000) {
    const batch = chapters.slice(offset, offset + 1000);
    for (const chapter of batch) rememberAuthoritativeChapterStorageDir(chapter.id, chapter.directory);
    await registerNativeWorkChapterDirectories(Object.fromEntries(batch.map((chapter) => [String(chapter.id), chapter.directory])));
  }
}

export function knownNovelMetadataDirectory(identity: NovelMetadataV1["identity"]): string | undefined {
  return knownFiles.get(keyFor(identity.pluginId, identity.novelPath))?.directory;
}

interface CachedNovel {
  id: number; pluginId: string; path: string; name: string; cover: string | null;
  author: string | null; artist: string | null; summary: string | null; status: string | null; genres: string | null; rating: number | null; isLocal: number;
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
      if (await metadataFingerprint(previous) !== known.fingerprint) throw new Error("work metadata: file changed outside the cache; reload before editing");
    }
    const [novel] = await db.select<CachedNovel[]>(`SELECT id,plugin_id AS pluginId,path,name,cover,author,artist,summary,status,genres,rating,is_local AS isLocal FROM novel WHERE plugin_id=$1 AND path=$2`, [identity.pluginId, identity.path]);
    if (!novel) {
      if (known) await workMetadataOperation({ operation: "remove", path: `${known.directory}/novel.json` });
      await db.execute("DELETE FROM work_metadata_directory_cache WHERE novel_id IN (SELECT novel_id FROM work_metadata_file_cache WHERE plugin_id=$1 AND path=$2)", [identity.pluginId, identity.path]);
      await db.execute("DELETE FROM work_metadata_file_cache WHERE plugin_id=$1 AND path=$2", [identity.pluginId, identity.path]);
      knownFiles.delete(key); continue;
    }
    const directory = known?.directory ?? await availableNovelMetadataDirectory({ identity: { pluginId: novel.pluginId, novelPath: novel.path }, novel: { ...novel, isLocal: Boolean(novel.isLocal) } });
    const chapters = await db.select<{ id: number; name: string; chapterNumber: string | null; position: number }[]>(
      "SELECT id,name,chapter_number AS chapterNumber,position FROM chapter WHERE novel_id=$1 ORDER BY position,id", [novel.id]);
    const cachedDirectories = await db.select<{ id: number; directory: string }[]>("SELECT chapter_id AS id,directory FROM work_metadata_directory_cache WHERE novel_id=$1", [novel.id]);
    const byId = new Map(cachedDirectories.map((chapter) => [chapter.id, chapter.directory]));
    const used = new Set(cachedDirectories.map((chapter) => chapter.directory.toLowerCase()));
    const mapped = chapters.map((chapter) => {
      const previousDirectory = byId.get(chapter.id);
      if (previousDirectory) return { id: chapter.id, directory: previousDirectory };
      const child = chapterStorageRelativeDir(novel, { ...chapter, id: undefined }).split("/").at(-1)!;
      const preferred = `${directory}/${child}`;
      let target = preferred; let suffix = 1;
      while (used.has(target.toLowerCase())) target = `${preferred}-${suffix++}`;
      used.add(target.toLowerCase());
      return { id: chapter.id, directory: target };
    });
    let cover = previous?.cover ?? null;
    const coverResult = await workMetadataOperation({ operation: "read", path: `${directory}/cover.json` });
    if (coverResult.body) {
      const manifest = JSON.parse(new TextDecoder().decode(base64ToBytes(coverResult.body))) as Record<string, unknown>;
      if (previous && (previous.identity.pluginId !== novel.pluginId || previous.identity.novelPath !== novel.path) &&
        manifest.sourceId === previous.identity.pluginId && manifest.novelPath === previous.identity.novelPath) {
        manifest.sourceId = novel.pluginId;
        manifest.novelPath = novel.path;
        await workMetadataOperation({ operation: "write", path: `${directory}/cover.json`, body: bytesToBase64(new TextEncoder().encode(JSON.stringify(manifest))) });
      }
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
      novel: { name: novel.name, cover: novel.cover, author: novel.author, artist: novel.artist, summary: novel.summary, status: novel.status, genres: novel.genres, rating: novel.rating, isLocal: Boolean(novel.isLocal) },
      cover });
    if (localCoverBytes) await writeStoredNovelCover(directory, metadata, localCoverBytes);
    await writeStoredNovelMetadata(directory, metadata);
    if (!cover && previous?.cover) await removeStoredNovelCover(directory, previous.cover);
    rememberResolvedNovelStorageDir(novel.id, directory);
    await persistWorkChapterDirectories(db, novel.id, mapped);
    await rememberStoredNovelMetadata(db, directory, metadata);
  }
  if (dirty.length) await db.execute("DELETE FROM work_metadata_dirty");
}
