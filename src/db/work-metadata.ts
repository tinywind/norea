import type Database from "@tauri-apps/plugin-sql";
import { base64ToBytes, bytesToBase64 } from "../lib/base64";
import { chapterStorageRelativeDir } from "../lib/chapter-storage-path";
import { isTauriRuntime } from "../lib/tauri-runtime";
import { clearAuthoritativeStorageDirs, rememberAuthoritativeChapterStorageDir, rememberResolvedNovelStorageDir } from "../lib/chapter-storage-resolution";
import { availableNovelMetadataDirectory, discoverStoredNovelCover, listStoredNovelChapters, listStoredNovelMetadata, scanStoredNovelMetadata, parseNovelMetadata, readStoredNovelCover, readStoredNovelMetadata, registerNativeWorkChapterDirectories, removeStoredNovelCover, withWorkMetadataRollback, workMetadataOperation, writeStoredNovelCover, writeStoredNovelMetadata, type NovelMetadataV1 } from "../lib/work-metadata";
import { isLocalCoverSource } from "../lib/local-cover";
import { runWorkContentStorageOperation } from "../lib/content-sync/storage-operation";
import { canAdoptChapterDownloadSnapshot, currentChapterDeletionRevision } from "../lib/chapter-download-writes";
import type { StoredNovelChapter } from "../lib/work-metadata";
import { LOCAL_PLUGIN_ID } from "../lib/plugins/types";
import { throwIfAborted } from "../lib/abort";

interface KnownMetadataFile { directory: string; fingerprint: string }
export interface WorkMetadataSyncFile extends KnownMetadataFile { pluginId: string; path: string; revision: number }
const knownFiles = new Map<string, KnownMetadataFile>();
const keyFor = (pluginId: string, path: string) => JSON.stringify([pluginId, path]);

export async function applyNovelMetadataToCache(db: Database, metadata: NovelMetadataV1, directory?: string, options?: { storedCover: Uint8Array | null; addToLibrary: boolean }): Promise<number> {
  parseNovelMetadata(metadata);
  const n = metadata.novel;
  const localCover = options ? options.storedCover : n.isLocal && directory ? await readStoredNovelCover(directory, metadata) : null;
  const cover = localCover && metadata.cover?.contentType ? `data:${metadata.cover.contentType};base64,${bytesToBase64(localCover)}` : null;
  await db.execute(`INSERT INTO novel (plugin_id,path,name,cover,author,artist,summary,status,genres,rating,is_local,in_library,library_added_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT(plugin_id,path) DO UPDATE SET name=excluded.name,cover=CASE WHEN excluded.is_local=1 THEN excluded.cover ELSE novel.cover END,author=excluded.author,
    artist=excluded.artist,summary=excluded.summary,status=excluded.status,genres=excluded.genres,rating=excluded.rating,is_local=excluded.is_local`,
  [metadata.identity.pluginId, metadata.identity.novelPath, n.name, cover, n.author, n.artist, n.summary, n.status, n.genres, n.rating, n.isLocal ? 1 : 0, options?.addToLibrary ? 1 : 0, options?.addToLibrary ? Date.now() : null]);
  const [row] = await db.select<{ id: number }[]>("SELECT id FROM novel WHERE plugin_id=$1 AND path=$2", [metadata.identity.pluginId, metadata.identity.novelPath]);
  if (!row) throw new Error("work metadata: cache identity missing");
  if (directory) rememberResolvedNovelStorageDir(row.id, directory);
  return row.id;
}

export async function scanStoredNovelChaptersToCache(db: Database, novelId: number, directory: string, snapshot?: { chapters: StoredNovelChapter[]; deletionRevision: number; deferNativeRegistration?: boolean }): Promise<void> {
  const discovered = snapshot?.chapters ?? await listStoredNovelChapters(directory);
  const [novel] = await db.select<{ pluginId: string }[]>("SELECT plugin_id AS pluginId FROM novel WHERE id=$1", [novelId]);
  const isLocal = novel?.pluginId === LOCAL_PLUGIN_ID;
  const cached = await db.select<{ id: number; path: string; name: string; chapterNumber: string | null; position: number; directory: string | null; isDownloaded: number; storedContentType: string | null }[]>(
    `SELECT c.id,c.path,c.name,c.chapter_number AS chapterNumber,c.position,d.directory,c.is_downloaded AS isDownloaded,c.stored_content_type AS storedContentType FROM chapter c
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
  const updates = new Map<StoredNovelChapter["contentType"], number[]>();
  const inserts: { path: string; chapter: StoredNovelChapter; position: number; directory: string }[] = [];
  const insertedPaths = new Set<string>();
  for (const [index, chapter] of discovered.entries()) {
    const absoluteDirectory = `${directory}/${chapter.directory}`;
    const recoveredPath = isLocal ? `local-folder:${chapter.directory}` : `norea-folder:${chapter.chapterNumber}`;
    const exact = byDirectory.get(absoluteDirectory) ?? byPath.get(recoveredPath);
    const number = Number(chapter.chapterNumber);
    const numbered = byNumber.get(number) ?? [];
    const candidates = isLocal ? numbered.filter((row) => !row.directory && chapterStorageRelativeDir({}, {
      name: row.name, chapterNumber: row.chapterNumber, position: row.position,
    }).endsWith(`/${chapter.directory}`)) : numbered;
    const matched = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (isLocal && !exact && candidates.length > 1) continue;
    if ((matched && used.has(matched.id)) || (!isLocal && !exact && (numbered.length > 1 || discoveredCounts.get(number)! > 1))) continue;
    if (snapshot && matched?.isDownloaded && matched.directory && matched.directory !== absoluteDirectory) continue;
    const id = matched?.id;
    if (id !== undefined && snapshot && !canAdoptChapterDownloadSnapshot(id, snapshot.deletionRevision)) continue;
    if (id === undefined) {
      if (!insertedPaths.has(recoveredPath)) {
        inserts.push({ path: recoveredPath, chapter, position: index + 1, directory: absoluteDirectory });
        insertedPaths.add(recoveredPath);
      }
      continue;
    } else if (!matched?.isDownloaded || matched.storedContentType !== chapter.contentType) {
      const ids = updates.get(chapter.contentType) ?? [];
      ids.push(id); updates.set(chapter.contentType, ids);
    }
    used.add(id);
    directories.push({ id, directory: absoluteDirectory });
  }
  for (let offset = 0; offset < inserts.length; offset += 100) {
    const batch = inserts.slice(offset, offset + 100);
    const params: unknown[] = [novelId];
    const values = batch.map(({ path, chapter, position }) => {
      const first = params.length + 1;
      params.push(path, chapter.name, chapter.chapterNumber, position, chapter.contentType);
      return `(${Array.from({ length: 5 }, (_, index) => `$${first + index}`).join(",")})`;
    });
    await db.execute(`WITH discovered(path,name,number,position,type) AS (VALUES ${values.join(",")})
      INSERT INTO chapter(novel_id,path,name,chapter_number,position,content_type,stored_content_type,is_downloaded,progress,bookmark,unread,read_at)
      SELECT n.id,d.path,d.name,d.number,d.position,d.type,d.type,1,COALESCE(state.progress,0),COALESCE(state.bookmark,0),COALESCE(state.unread,1),state.read_at
      FROM discovered d JOIN novel n ON n.id=$1 LEFT JOIN work_metadata_reading_state state
      ON state.plugin_id=n.plugin_id AND state.novel_path=n.path AND state.chapter_path=d.path`, params);
  }
  if (inserts.length) {
    const rows = await db.select<{ id: number; path: string }[]>("SELECT id,path FROM chapter WHERE novel_id=$1", [novelId]);
    const ids = new Map(rows.map(row => [row.path, row.id]));
    for (const inserted of inserts) {
      const id = ids.get(inserted.path);
      if (!id) throw new Error("work metadata: discovered chapter identity missing");
      used.add(id);
      directories.push({ id, directory: inserted.directory });
    }
  }
  for (const [contentType, ids] of updates) {
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100).filter((id) => !snapshot || canAdoptChapterDownloadSnapshot(id, snapshot.deletionRevision));
      if (batch.length === 0) continue;
      await db.execute(`UPDATE chapter SET is_downloaded=1,stored_content_type=$1 WHERE id IN (${batch.map((_, index) => `$${index + 2}`).join(",")})`, [contentType, ...batch]);
    }
  }
  const retained = cached.filter((row) => row.directory && !used.has(row.id)).map((row) => ({ id: row.id, directory: row.directory! }));
  if (!snapshot || directories.some((chapter) => byDirectory.get(chapter.directory)?.id !== chapter.id)) {
    await persistWorkChapterDirectories(db, novelId, [...retained, ...directories], !snapshot?.deferNativeRegistration);
  }
}

export async function refreshStoredNovelChapterDownloads(novelId: number): Promise<void> {
  if (!isTauriRuntime()) return;
  const { getDb, runDatabaseTransaction } = await import("./client");
  const db = await getDb();
  const [work] = await db.select<{ directory: string }[]>(
    "SELECT directory FROM work_metadata_file_cache WHERE novel_id=$1", [novelId]);
  if (!work) return;
  const deletionRevision = currentChapterDeletionRevision();
  const completed = await db.select<{ id: number; name: string; chapterNumber: string | null; position: number; directory: string | null; contentType: "html" | "pdf" }[]>(
    `SELECT c.id,c.name,c.chapter_number AS chapterNumber,c.position,d.directory,c.stored_content_type AS contentType
    FROM chapter c LEFT JOIN work_metadata_directory_cache d ON d.chapter_id=c.id
    WHERE c.novel_id=$1 AND c.is_downloaded=1 AND c.stored_content_type IN ('html','pdf')`, [novelId]);
  rememberResolvedNovelStorageDir(novelId, work.directory);
  const cachedFiles = completed.map((chapter) => ({
    ...chapter,
    directory: chapter.directory ?? chapterStorageRelativeDir({ id: novelId }, chapter),
  })).filter((chapter) => chapter.directory.startsWith(`${work.directory}/`))
    .map((chapter) => `${chapter.directory}/content.${chapter.contentType}`);
  const chapters = await listStoredNovelChapters(work.directory, cachedFiles);
  await runDatabaseTransaction(async (transaction) => {
    const [current] = await transaction.select<{ directory: string }[]>(
      "SELECT f.directory FROM work_metadata_file_cache f JOIN novel n ON n.id=f.novel_id WHERE n.id=$1", [novelId]);
    if (current?.directory !== work.directory) return;
    await scanStoredNovelChaptersToCache(transaction, novelId, work.directory, { chapters, deletionRevision });
  });
}

export interface WorkMetadataRecoveryProgress {
  totalWorks: number;
  completedWorks: number;
  recoveredWorks: number;
  recoveredChapters: number;
  skippedWorks: number;
  currentWork: string | null;
}

type ExclusiveMetadataOperation = <T>(run: () => Promise<T>) => Promise<T>;
const runMetadataOperation: ExclusiveMetadataOperation = run => run();

export async function initializeWorkMetadata(db: Database, options: {
  rebuild?: boolean;
  runExclusive?: ExclusiveMetadataOperation;
  signal?: AbortSignal;
  onProgress?: (progress: WorkMetadataRecoveryProgress) => void;
} = {}): Promise<void> {
  if (!isTauriRuntime()) return;
  const run = options.runExclusive ?? runMetadataOperation;
  const checkCancelled = () => throwIfAborted(options.signal, "Storage recovery cancelled.");
  const [initialized] = await run(() => db.select<{ id: number }[]>("SELECT id FROM work_metadata_cache_state WHERE id=1"));
  const [pending] = await run(() => db.select<{ pending: number }[]>("SELECT 1 AS pending FROM work_metadata_dirty LIMIT 1"));
  checkCancelled();
  if (initialized && !pending && !options.rebuild) {
    await restoreWorkMetadataDirectories(db, true, run, options.signal);
    return;
  }
  const progress: WorkMetadataRecoveryProgress = {
    totalWorks: 0, completedWorks: 0, recoveredWorks: 0, recoveredChapters: 0, skippedWorks: 0, currentWork: null,
  };
  const report = () => options.onProgress?.({ ...progress });
  report();
  await restoreWorkMetadataDirectories(db, false, run, options.signal);
  const baselines = new Map(knownFiles);
  await run(async () => {
    checkCancelled();
    await db.execute("DELETE FROM work_metadata_cache_state");
    await db.execute("DELETE FROM work_metadata_dirty");
    await db.execute("DELETE FROM work_metadata_directory_cache WHERE chapter_id NOT IN (SELECT id FROM chapter)");
  });
  await registerNativeWorkChapterDirectories({}, true);
  const entries = scanStoredNovelMetadata(
    total => { progress.totalWorks = total; report(); },
    (_path, skipped) => {
      if (skipped) { progress.completedWorks++; progress.skippedWorks++; report(); }
    },
    options.signal,
  );
  for await (const entry of entries) {
    checkCancelled();
    progress.currentWork = entry.metadata.novel.name;
    report();
    const previous = baselines.get(keyFor(entry.metadata.identity.pluginId, entry.metadata.identity.novelPath));
    const deletionRevision = currentChapterDeletionRevision();
    const chapters = await listStoredNovelChapters(entry.directory);
    const cover = entry.metadata.novel.isLocal ? await readStoredNovelCover(entry.directory, entry.metadata) : null;
    const directories = await run(async () => {
      checkCancelled();
      const current = knownFiles.get(keyFor(entry.metadata.identity.pluginId, entry.metadata.identity.novelPath));
      const metadataChanged = current !== previous;
      if (metadataChanged && current?.directory !== entry.directory) return null;
      const [existing] = metadataChanged ? await db.select<{ id: number }[]>("SELECT id FROM novel WHERE plugin_id=$1 AND path=$2", [entry.metadata.identity.pluginId, entry.metadata.identity.novelPath]) : [];
      if (metadataChanged && !existing) return null;
      await db.execute("BEGIN IMMEDIATE");
      try {
        const novelId = existing?.id ?? await applyNovelMetadataToCache(db, entry.metadata, entry.directory, { storedCover: cover, addToLibrary: true });
        await scanStoredNovelChaptersToCache(db, novelId, entry.directory, { chapters, deletionRevision, deferNativeRegistration: true });
        if (!metadataChanged) await rememberStoredNovelMetadata(db, entry.directory, entry.metadata, options.rebuild);
        await db.execute("DELETE FROM work_metadata_dirty WHERE plugin_id=$1 AND path=$2", [entry.metadata.identity.pluginId, entry.metadata.identity.novelPath]);
        const mapped = await db.select<{ id: number; directory: string }[]>("SELECT chapter_id AS id,directory FROM work_metadata_directory_cache WHERE novel_id=$1", [novelId]);
        checkCancelled();
        await db.execute("COMMIT");
        return mapped;
      } catch (error) {
        await db.execute("ROLLBACK");
        await restoreWorkMetadataDirectories(db, false);
        throw error;
      }
    });
    if (directories) {
      for (const row of directories) rememberAuthoritativeChapterStorageDir(row.id, row.directory);
      for (let offset = 0; offset < directories.length; offset += 1000) {
        checkCancelled();
        await registerNativeWorkChapterDirectories(Object.fromEntries(directories.slice(offset, offset + 1000).map(row => [String(row.id), row.directory])));
      }
      progress.recoveredWorks++;
      progress.recoveredChapters += chapters.length;
    }
    checkCancelled();
    progress.completedWorks++;
    report();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  await run(async () => {
    checkCancelled();
    await db.execute("INSERT OR IGNORE INTO work_metadata_cache_state(id) VALUES(1)");
  });
  progress.currentWork = null;
  report();
}

export async function storedNovelMetadataFingerprint(metadata: NovelMetadataV1): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parseNovelMetadata(metadata))));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function restoreWorkMetadataDirectories(db: Database, registerNative = true, run: ExclusiveMetadataOperation = runMetadataOperation, signal?: AbortSignal): Promise<void> {
  knownFiles.clear();
  clearAuthoritativeStorageDirs();
  const files = await run(() => db.select<{ pluginId: string; path: string; novelId: number; directory: string; fingerprint: string }[]>(
    "SELECT plugin_id AS pluginId,path,novel_id AS novelId,directory,fingerprint FROM work_metadata_file_cache"));
  throwIfAborted(signal, "Storage recovery cancelled.");
  for (const file of files) {
    knownFiles.set(keyFor(file.pluginId, file.path), { directory: file.directory, fingerprint: file.fingerprint });
    rememberResolvedNovelStorageDir(file.novelId, file.directory);
  }
  if (registerNative) await registerNativeWorkChapterDirectories({}, true);
  let afterId = 0;
  for (;;) {
    const chapters = await run(() => db.select<{ id: number; directory: string }[]>(
      "SELECT chapter_id AS id,directory FROM work_metadata_directory_cache WHERE chapter_id>$1 ORDER BY chapter_id LIMIT 1000", [afterId]));
    throwIfAborted(signal, "Storage recovery cancelled.");
    if (!chapters.length) break;
    for (const chapter of chapters) rememberAuthoritativeChapterStorageDir(chapter.id, chapter.directory);
    if (registerNative) await registerNativeWorkChapterDirectories(Object.fromEntries(chapters.map((chapter) => [String(chapter.id), chapter.directory])));
    afterId = chapters.at(-1)!.id;
  }
}

export async function rememberStoredNovelMetadata(db: Database, directory: string, metadata: NovelMetadataV1, coverChanged = false): Promise<void> {
  const [novel] = await db.select<{ id: number }[]>("SELECT id FROM novel WHERE plugin_id=$1 AND path=$2", [metadata.identity.pluginId, metadata.identity.novelPath]);
  if (!novel) throw new Error("work metadata: cache identity missing");
  const fingerprint = await storedNovelMetadataFingerprint(metadata);
  const key = keyFor(metadata.identity.pluginId, metadata.identity.novelPath);
  const previous = knownFiles.get(key);
  await db.execute(`INSERT INTO work_metadata_file_cache(plugin_id,path,novel_id,directory,fingerprint) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(plugin_id,path) DO UPDATE SET novel_id=excluded.novel_id,directory=excluded.directory,fingerprint=excluded.fingerprint`,
  [metadata.identity.pluginId, metadata.identity.novelPath, novel.id, directory, fingerprint]);
  if (coverChanged || previous?.directory !== directory || previous.fingerprint !== fingerprint) {
    await db.execute(`INSERT INTO work_metadata_sync_journal(plugin_id,path,revision) VALUES($1,$2,1)
      ON CONFLICT(plugin_id,path) DO UPDATE SET revision=revision+1`, [metadata.identity.pluginId, metadata.identity.novelPath]);
  }
  knownFiles.set(key, { directory, fingerprint });
}

export async function readWorkMetadataSyncFiles(rescan = false): Promise<WorkMetadataSyncFile[]> {
  if (!isTauriRuntime()) return [];
  const { getDb, runDatabaseTransaction } = await import("./client");
  const db = await getDb();
  if (rescan) {
    const entries = await listStoredNovelMetadata();
    for (const entry of entries) {
      await runWorkContentStorageOperation(entry.metadata.identity.pluginId, entry.metadata.identity.novelPath, () => runDatabaseTransaction(async transaction => {
        const current = await readStoredNovelMetadata(entry.directory);
        if (!current) return;
        await applyNovelMetadataToCache(transaction, current.metadata, current.directory);
        await rememberStoredNovelMetadata(transaction, current.directory, current.metadata, true);
        await transaction.execute("DELETE FROM work_metadata_dirty WHERE plugin_id=$1 AND path=$2", [current.metadata.identity.pluginId, current.metadata.identity.novelPath]);
      }, true));
    }
  }
  return db.select<WorkMetadataSyncFile[]>(`SELECT f.plugin_id AS pluginId,f.path,f.directory,f.fingerprint,COALESCE(j.revision,0) AS revision
    FROM work_metadata_file_cache f LEFT JOIN work_metadata_sync_journal j ON j.plugin_id=f.plugin_id AND j.path=f.path`);
}

async function persistWorkChapterDirectories(db: Database, novelId: number, chapters: { id: number; directory: string }[], registerNative = true): Promise<void> {
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
    if (registerNative) await registerNativeWorkChapterDirectories(Object.fromEntries(batch.map((chapter) => [String(chapter.id), chapter.directory])));
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
      previous.cover = await discoverStoredNovelCover(known.directory, previous.cover);
      if (await storedNovelMetadataFingerprint(previous) !== known.fingerprint) throw new Error("work metadata: file changed outside the cache; reload before editing");
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
    let cover = await discoverStoredNovelCover(directory, previous?.cover);
    if (novel.isLocal && !novel.cover) cover = null;
    let localCoverBytes: Uint8Array | null = null;
    if (isLocalCoverSource(novel.cover)) {
      const [prefix, encoded] = novel.cover.split(",", 2);
      const contentType = prefix!.slice(5).split(";")[0]!;
      const extension = contentType.split("/")[1]!.replace("jpeg", "jpg");
      cover = { fileName: `cover.${extension}`, contentType };
      localCoverBytes = base64ToBytes(encoded!);
    }
    const metadata = parseNovelMetadata({ schemaVersion: 1, identity: { pluginId: novel.pluginId, novelPath: novel.path },
      novel: { name: novel.name, author: novel.author, artist: novel.artist, summary: novel.summary, status: novel.status, genres: novel.genres, rating: novel.rating, isLocal: Boolean(novel.isLocal) },
      cover });
    const coverChanged = localCoverBytes ? await writeStoredNovelCover(directory, metadata, localCoverBytes) : false;
    await writeStoredNovelMetadata(directory, metadata);
    if (!cover && previous?.cover) await removeStoredNovelCover(directory, previous.cover);
    rememberResolvedNovelStorageDir(novel.id, directory);
    await persistWorkChapterDirectories(db, novel.id, mapped);
    await rememberStoredNovelMetadata(db, directory, metadata, coverChanged);
  }
  if (dirty.length) await db.execute("DELETE FROM work_metadata_dirty");
}
