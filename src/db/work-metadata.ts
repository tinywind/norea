import type Database from "@tauri-apps/plugin-sql";
import { base64ToBytes, bytesToBase64 } from "../lib/base64";
import { chapterStorageDirectoryName, chapterStorageRelativeDir } from "../lib/chapter-storage-path";
import { isTauriRuntime } from "../lib/tauri-runtime";
import { clearAuthoritativeStorageDirs, rememberAuthoritativeChapterStorageDir, rememberResolvedNovelStorageDir, resolvedNovelStorageDir } from "../lib/chapter-storage-resolution";
import { availableNovelMetadataDirectory, discoverStoredNovelCover, listStoredNovelChapters, listStoredNovelMetadata, scanStoredNovelMetadata, parseNovelMetadata, readStoredNovelCover, readStoredNovelMetadata, registerNativeWorkChapterDirectories, removeStoredNovelCover, withWorkMetadataRollback, workMetadataOperation, writeStoredNovelCover, writeStoredNovelMetadata, type NovelMetadataV1 } from "../lib/work-metadata";
import { isLocalCoverSource } from "../lib/local-cover";
import { runWorkContentStorageOperation } from "../lib/content-sync/storage-operation";
import { canAdoptChapterDownloadSnapshot, currentChapterDownloadRevision } from "../lib/chapter-download-writes";
import type { StoredNovelChapter } from "../lib/work-metadata";
import { LOCAL_PLUGIN_ID } from "../lib/plugins/types";
import { throwIfAborted } from "../lib/abort";

interface KnownMetadataFile { directory: string; fingerprint: string }
export interface WorkMetadataSyncFile extends KnownMetadataFile { pluginId: string; path: string; revision: number }
const knownFiles = new Map<string, KnownMetadataFile>();
const keyFor = (pluginId: string, path: string) => JSON.stringify([pluginId, path]);

export async function applyNovelMetadataToCache(db: Database, metadata: NovelMetadataV1, directory?: string, options?: { storedCover?: Uint8Array | null; addToLibrary?: boolean; preserveMissingMetadata?: boolean; preserveCachedNovel?: boolean }): Promise<number> {
  metadata = parseNovelMetadata(metadata);
  const [storedIdentity] = await db.select<{ sourceNovelId: string | null }[]>(
    "SELECT source_novel_id AS sourceNovelId FROM novel WHERE plugin_id=$1 AND path=$2", [metadata.identity.pluginId, metadata.identity.novelPath]);
  if (storedIdentity?.sourceNovelId && storedIdentity.sourceNovelId !== metadata.identity.novelId) {
    throw new Error("work metadata: plugin-owned novel ID changed");
  }
  const n = metadata.novel;
  const localCover = options?.storedCover !== undefined ? options.storedCover : n.isLocal && directory ? await readStoredNovelCover(directory, metadata) : null;
  const cover = localCover && metadata.cover?.contentType ? `data:${metadata.cover.contentType};base64,${bytesToBase64(localCover)}` : null;
  const optionalText = (value: string | null) => options?.preserveMissingMetadata && !value?.trim() ? null : value;
  await db.execute(`INSERT INTO novel (plugin_id,path,name,cover,author,artist,summary,status,genres,rating,is_local,in_library,library_added_at,source_novel_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$16)
    ON CONFLICT(plugin_id,path) DO UPDATE SET name=excluded.name,source_novel_id=excluded.source_novel_id,
    cover=CASE WHEN excluded.is_local=1 THEN CASE WHEN $14=1 THEN COALESCE(excluded.cover,novel.cover) ELSE excluded.cover END ELSE novel.cover END,
    author=CASE WHEN $14=1 THEN COALESCE(excluded.author,novel.author) ELSE excluded.author END,
    artist=CASE WHEN $14=1 THEN COALESCE(excluded.artist,novel.artist) ELSE excluded.artist END,
    summary=CASE WHEN $14=1 THEN COALESCE(excluded.summary,novel.summary) ELSE excluded.summary END,
    status=CASE WHEN $14=1 THEN COALESCE(excluded.status,novel.status) ELSE excluded.status END,
    genres=CASE WHEN $14=1 THEN COALESCE(excluded.genres,novel.genres) ELSE excluded.genres END,
    rating=CASE WHEN $14=1 THEN COALESCE(excluded.rating,novel.rating) ELSE excluded.rating END,is_local=excluded.is_local WHERE $15=0`,
  [metadata.identity.pluginId, metadata.identity.novelPath, n.name, cover, optionalText(n.author), optionalText(n.artist), optionalText(n.summary), optionalText(n.status), optionalText(n.genres), n.rating, n.isLocal ? 1 : 0, options?.addToLibrary ? 1 : 0, options?.addToLibrary ? Date.now() : null, options?.preserveMissingMetadata ? 1 : 0, options?.preserveCachedNovel ? 1 : 0, metadata.identity.novelId]);
  const [row] = await db.select<{ id: number }[]>("SELECT id FROM novel WHERE plugin_id=$1 AND path=$2", [metadata.identity.pluginId, metadata.identity.novelPath]);
  if (!row) throw new Error("work metadata: cache identity missing");
  if (!options?.preserveCachedNovel && Object.keys(metadata.chapters).length) {
    const existing = await db.select<{ path: string; chapterNumber: string | null }[]>("SELECT path,chapter_number AS chapterNumber FROM chapter WHERE novel_id=$1", [row.id]);
    const pathsByNumber = new Map<string, string[]>();
    for (const chapter of existing) {
      if (chapter.chapterNumber === null) continue;
      const number = String(Number(chapter.chapterNumber));
      pathsByNumber.set(number, [...(pathsByNumber.get(number) ?? []), chapter.path]);
    }
    const chapters = Object.entries(metadata.chapters).sort(([a], [b]) => Number(a) - Number(b))
      .map(([number, name], index) => ({ number, name, position: index + 1, paths: pathsByNumber.get(number) ?? [] }))
      .filter(chapter => chapter.paths.length <= 1);
    for (let offset = 0; offset < chapters.length; offset += 100) {
      const batch = chapters.slice(offset, offset + 100);
      const params = batch.flatMap(chapter => [row.id, chapter.paths[0] ?? `${n.isLocal ? "local-folder" : "norea-folder"}:${chapter.number}`, chapter.name, chapter.number, chapter.position]);
      await db.execute(`WITH catalog(novel_id,path,name,number,position) AS (VALUES
        ${batch.map((_, index) => `(${Array.from({ length: 5 }, (_, column) => `$${index * 5 + column + 1}`).join(",")})`).join(",")})
        INSERT INTO chapter(novel_id,path,name,chapter_number,position,progress,bookmark,unread,read_at)
        SELECT c.novel_id,c.path,c.name,c.number,c.position,COALESCE(state.progress,0),COALESCE(state.bookmark,0),COALESCE(state.unread,1),state.read_at
        FROM catalog c JOIN novel n ON n.id=c.novel_id LEFT JOIN work_metadata_reading_state state
        ON state.plugin_id=n.plugin_id AND state.novel_path=n.path AND state.chapter_path=c.path WHERE true
        ON CONFLICT(novel_id,path) DO UPDATE SET name=excluded.name,position=excluded.position
        WHERE chapter.name IS NOT excluded.name OR chapter.position IS NOT excluded.position`, params);
    }
  }
  if (directory) rememberResolvedNovelStorageDir(row.id, directory);
  return row.id;
}

export async function scanStoredNovelChaptersToCache(db: Database, novelId: number, directory: string, snapshot?: { chapters: StoredNovelChapter[]; downloadRevision: number; deferNativeRegistration?: boolean }): Promise<void> {
  const downloadRevision = snapshot?.downloadRevision ?? currentChapterDownloadRevision();
  const discovered = snapshot?.chapters ?? await listStoredNovelChapters(directory);
  const [novel] = await db.select<{ pluginId: string }[]>("SELECT plugin_id AS pluginId FROM novel WHERE id=$1", [novelId]);
  const isLocal = novel?.pluginId === LOCAL_PLUGIN_ID;
  const cached = await db.select<{ id: number; path: string; name: string; chapterNumber: string | null; position: number; directory: string | null; isDownloaded: number; storedContentType: string | null; mediaRepairNeeded: number; contentBytes: number; mediaBytes: number }[]>(
    `SELECT c.id,c.path,c.name,c.chapter_number AS chapterNumber,c.position,d.directory,c.is_downloaded AS isDownloaded,c.stored_content_type AS storedContentType,c.media_repair_needed AS mediaRepairNeeded,c.content_bytes AS contentBytes,c.media_bytes AS mediaBytes FROM chapter c
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
  const updates = new Map<string, { contentType: StoredNovelChapter["contentType"]; mediaComplete: boolean; chapters: { id: number; contentBytes: number; mediaBytes: number }[] }>();
  const inserts: { path: string; chapter: StoredNovelChapter; position: number; directory: string }[] = [];
  const insertedPaths = new Set<string>();
  for (const [index, chapter] of discovered.entries()) {
    const absoluteDirectory = `${directory}/${chapter.directory}`;
    const recoveredPath = isLocal ? `local-folder:${chapter.directory}` : `norea-folder:${chapter.chapterNumber}`;
    const exact = byDirectory.get(absoluteDirectory) ?? byPath.get(recoveredPath);
    const number = Number(chapter.chapterNumber);
    const numbered = byNumber.get(number) ?? [];
    const candidates = isLocal ? numbered.filter((row) => !row.directory && chapterStorageDirectoryName({ chapterNumber: row.chapterNumber, position: row.position }) === chapter.directory) : numbered;
    const matched = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (isLocal && !exact && candidates.length > 1) continue;
    if ((matched && used.has(matched.id)) || (!isLocal && !exact && (numbered.length > 1 || discoveredCounts.get(number)! > 1))) continue;
    if (snapshot && matched?.isDownloaded && matched.directory && matched.directory !== absoluteDirectory) continue;
    const id = matched?.id;
    if (id !== undefined && snapshot && !canAdoptChapterDownloadSnapshot(id, snapshot.downloadRevision)) continue;
    if (id === undefined) {
      if (!insertedPaths.has(recoveredPath)) {
        inserts.push({ path: recoveredPath, chapter, position: index + 1, directory: absoluteDirectory });
        insertedPaths.add(recoveredPath);
      }
      continue;
    } else if (Boolean(matched?.isDownloaded) !== chapter.mediaComplete || matched?.storedContentType !== chapter.contentType
      || Boolean(matched?.mediaRepairNeeded) === chapter.mediaComplete
      || matched?.contentBytes !== chapter.contentBytes || matched?.mediaBytes !== chapter.mediaBytes) {
      const key = `${chapter.contentType}:${chapter.mediaComplete}`;
      const update = updates.get(key) ?? { contentType: chapter.contentType, mediaComplete: chapter.mediaComplete, chapters: [] };
      update.chapters.push({ id, contentBytes: chapter.contentBytes, mediaBytes: chapter.mediaBytes }); updates.set(key, update);
    }
    used.add(id);
    directories.push({ id, directory: absoluteDirectory });
  }
  for (let offset = 0; offset < inserts.length; offset += 100) {
    const batch = inserts.slice(offset, offset + 100);
    const params: unknown[] = [novelId];
    const values = batch.map(({ path, chapter, position }) => {
      const first = params.length + 1;
      params.push(path, chapter.name, chapter.chapterNumber, position, chapter.contentType, chapter.mediaComplete ? 1 : 0, chapter.contentBytes, chapter.mediaBytes);
      return `(${Array.from({ length: 8 }, (_, index) => `$${first + index}`).join(",")})`;
    });
    await db.execute(`WITH discovered(path,name,number,position,type,complete,content_bytes,media_bytes) AS (VALUES ${values.join(",")})
      INSERT INTO chapter(novel_id,path,name,chapter_number,position,content_type,stored_content_type,is_downloaded,media_repair_needed,content_bytes,media_bytes,media_bytes_checked_at,progress,bookmark,unread,read_at)
      SELECT n.id,d.path,d.name,d.number,d.position,d.type,d.type,d.complete,1-d.complete,d.content_bytes,d.media_bytes,unixepoch(),COALESCE(state.progress,0),COALESCE(state.bookmark,0),COALESCE(state.unread,1),state.read_at
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
  for (const { contentType, mediaComplete, chapters } of updates.values()) {
    for (let offset = 0; offset < chapters.length; offset += 100) {
      const batch = chapters.slice(offset, offset + 100).filter(({ id }) => !snapshot || canAdoptChapterDownloadSnapshot(id, snapshot.downloadRevision));
      if (batch.length === 0) continue;
      const values = batch.map((_, index) => `($${index * 3 + 3},$${index * 3 + 4},$${index * 3 + 5})`);
      await db.execute(`WITH inspected(id,content_bytes,media_bytes) AS (VALUES ${values.join(",")})
        UPDATE chapter SET is_downloaded=$2,media_repair_needed=1-$2,stored_content_type=$1,
          content_bytes=(SELECT content_bytes FROM inspected WHERE inspected.id=chapter.id),
          media_bytes=(SELECT media_bytes FROM inspected WHERE inspected.id=chapter.id),media_bytes_checked_at=unixepoch()
        WHERE id IN (SELECT id FROM inspected)`,
      [contentType, mediaComplete ? 1 : 0, ...batch.flatMap(({ id, contentBytes, mediaBytes }) => [id, contentBytes, mediaBytes])]);
    }
  }
  const discoveredDirectories = new Set(discovered.map(chapter => `${directory}/${chapter.directory}`));
  const missing = cached.filter(row => !used.has(row.id) && row.directory?.startsWith(`${directory}/`) && !discoveredDirectories.has(row.directory)).map(row => row.id);
  for (let offset = 0; offset < missing.length; offset += 100) {
    const batch = missing.slice(offset, offset + 100).filter(id => canAdoptChapterDownloadSnapshot(id, downloadRevision));
    if (!batch.length) continue;
    await db.execute(`UPDATE chapter SET is_downloaded=0,media_repair_needed=0,stored_content_type=NULL,
      content_bytes=0,media_bytes=0,media_bytes_checked_at=NULL
      WHERE id IN (${batch.map((_, index) => `$${index + 1}`).join(",")})
      AND (is_downloaded<>0 OR media_repair_needed<>0 OR stored_content_type IS NOT NULL
        OR content_bytes<>0 OR media_bytes<>0 OR media_bytes_checked_at IS NOT NULL)`, batch);
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
  const downloadRevision = currentChapterDownloadRevision();
  rememberResolvedNovelStorageDir(novelId, work.directory);
  const chapters = await listStoredNovelChapters(work.directory);
  await runDatabaseTransaction(async (transaction) => {
    const [current] = await transaction.select<{ directory: string }[]>(
      "SELECT f.directory FROM work_metadata_file_cache f JOIN novel n ON n.id=f.novel_id WHERE n.id=$1", [novelId]);
    if (current?.directory !== work.directory) return;
    await scanStoredNovelChaptersToCache(transaction, novelId, work.directory, { chapters, downloadRevision });
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
  if (initialized && !options.rebuild) {
    await restoreWorkMetadataDirectories(db, true, run, options.signal);
    if (pending) await run(() => withWorkMetadataRollback(async () => {
      checkCancelled();
      await db.execute("BEGIN IMMEDIATE");
      try {
        await flushWorkMetadata(db);
        checkCancelled();
        await db.execute("COMMIT");
      } catch (error) {
        await db.execute("ROLLBACK");
        await restoreWorkMetadataDirectories(db, false);
        throw error;
      }
    }));
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
    if (!initialized) await db.execute(`DELETE FROM work_metadata_dirty WHERE NOT EXISTS (
      SELECT 1 FROM work_metadata_file_cache f WHERE f.plugin_id=work_metadata_dirty.plugin_id AND f.path=work_metadata_dirty.path)`);
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
    const downloadRevision = currentChapterDownloadRevision();
    const chapters = await listStoredNovelChapters(entry.directory, options.signal);
    const restored = await run(async () => {
      checkCancelled();
      const current = knownFiles.get(keyFor(entry.metadata.identity.pluginId, entry.metadata.identity.novelPath));
      const metadataChanged = current !== previous;
      if (metadataChanged && current?.directory !== entry.directory) return null;
      let metadata = entry.metadata;
      if (!metadataChanged) {
        const latest = await readStoredNovelMetadata(entry.directory);
        if (!latest) return null;
        if (latest.metadata.identity.pluginId !== metadata.identity.pluginId || latest.metadata.identity.novelId !== metadata.identity.novelId ||
          latest.metadata.identity.novelPath !== metadata.identity.novelPath) throw new Error("work metadata: recovery identity changed during inspection");
        metadata = latest.metadata;
      }
      const fileConflict = !metadataChanged && await hasWorkMetadataConflict(entry.directory, metadata);
      const preserveCached = metadataChanged || fileConflict;
      const cover = !preserveCached && metadata.novel.isLocal ? await readStoredNovelCover(entry.directory, metadata) : null;
      const [pendingWork] = await db.select<{ pending: number }[]>("SELECT 1 AS pending FROM work_metadata_dirty WHERE plugin_id=$1 AND path=$2", [entry.metadata.identity.pluginId, entry.metadata.identity.novelPath]);
      const [existing] = preserveCached || pendingWork ? await db.select<{ id: number }[]>("SELECT id FROM novel WHERE plugin_id=$1 AND path=$2", [entry.metadata.identity.pluginId, entry.metadata.identity.novelPath]) : [];
      if ((preserveCached || pendingWork) && !existing) return null;
      await db.execute("BEGIN IMMEDIATE");
      try {
        const novelId = preserveCached && existing ? existing.id : await applyNovelMetadataToCache(db, metadata, entry.directory, {
          storedCover: cover, addToLibrary: true, preserveMissingMetadata: true, preserveCachedNovel: Boolean(pendingWork),
        });
        await scanStoredNovelChaptersToCache(db, novelId, entry.directory, { chapters, downloadRevision, deferNativeRegistration: true });
        if (!preserveCached && !pendingWork) await rememberStoredNovelMetadata(db, entry.directory, metadata, options.rebuild);
        if (!pendingWork) await db.execute("DELETE FROM work_metadata_dirty WHERE plugin_id=$1 AND path=$2", [entry.metadata.identity.pluginId, entry.metadata.identity.novelPath]);
        const mapped = await db.select<{ id: number; directory: string }[]>("SELECT chapter_id AS id,directory FROM work_metadata_directory_cache WHERE novel_id=$1", [novelId]);
        checkCancelled();
        await db.execute("COMMIT");
        return { novelId, directories: mapped, coverDirectoryChanged: current?.directory !== entry.directory };
      } catch (error) {
        await db.execute("ROLLBACK");
        await restoreWorkMetadataDirectories(db, false);
        throw error;
      }
    });
    if (restored) {
      const { directories } = restored;
      for (const row of directories) rememberAuthoritativeChapterStorageDir(row.id, row.directory);
      for (let offset = 0; offset < directories.length; offset += 1000) {
        checkCancelled();
        await registerNativeWorkChapterDirectories(Object.fromEntries(directories.slice(offset, offset + 1000).map(row => [String(row.id), row.directory])));
      }
      if (restored.coverDirectoryChanged) {
        const { notifyNovelCoverChanged } = await import("../lib/novel-cover-storage");
        notifyNovelCoverChanged(restored.novelId, { pluginId: entry.metadata.identity.pluginId, path: entry.metadata.identity.novelPath });
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

export async function hasWorkMetadataConflict(directory: string, metadata: NovelMetadataV1): Promise<boolean> {
  const known = knownFiles.get(keyFor(metadata.identity.pluginId, metadata.identity.novelPath));
  return Boolean(known && (known.directory !== directory || known.fingerprint !== await storedNovelMetadataFingerprint(metadata)));
}

export async function restoreWorkMetadataDirectories(db: Database, registerNative = true, run: ExclusiveMetadataOperation = runMetadataOperation, signal?: AbortSignal): Promise<void> {
  const { chapters, changedFiles } = await run(async () => {
    const files = await db.select<{ pluginId: string; path: string; novelId: number; directory: string; fingerprint: string }[]>(
      "SELECT plugin_id AS pluginId,path,novel_id AS novelId,directory,fingerprint FROM work_metadata_file_cache");
    throwIfAborted(signal, "Storage recovery cancelled.");
    const chapters: { id: number; directory: string }[] = [];
    let afterId = 0;
    for (;;) {
      const batch = await db.select<{ id: number; directory: string }[]>(
        "SELECT chapter_id AS id,directory FROM work_metadata_directory_cache WHERE chapter_id>$1 ORDER BY chapter_id LIMIT 1000", [afterId]);
      throwIfAborted(signal, "Storage recovery cancelled.");
      if (!batch.length) break;
      chapters.push(...batch);
      afterId = batch.at(-1)!.id;
    }
    const changedFiles = files.filter(file => resolvedNovelStorageDir(file.novelId) !== file.directory);
    knownFiles.clear();
    clearAuthoritativeStorageDirs();
    for (const file of files) {
      knownFiles.set(keyFor(file.pluginId, file.path), { directory: file.directory, fingerprint: file.fingerprint });
      rememberResolvedNovelStorageDir(file.novelId, file.directory);
    }
    for (const chapter of chapters) rememberAuthoritativeChapterStorageDir(chapter.id, chapter.directory);
    return { chapters, changedFiles };
  });
  if (changedFiles.length) {
    const { notifyNovelCoverChanged } = await import("../lib/novel-cover-storage");
    for (const file of changedFiles) notifyNovelCoverChanged(file.novelId, { pluginId: file.pluginId, path: file.path });
  }
  if (registerNative) await registerNativeWorkChapterDirectories({}, true);
  for (let offset = 0; registerNative && offset < chapters.length; offset += 1000) {
    throwIfAborted(signal, "Storage recovery cancelled.");
    await registerNativeWorkChapterDirectories(Object.fromEntries(chapters.slice(offset, offset + 1000).map((chapter) => [String(chapter.id), chapter.directory])));
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
  const [pending] = await db.select<{ pending: number }[]>("SELECT 1 AS pending FROM work_metadata_dirty LIMIT 1");
  if (pending) await runDatabaseTransaction(async transaction => { await flushWorkMetadata(transaction); });
  if (rescan) {
    const entries = await listStoredNovelMetadata();
    for (const entry of entries) {
      await runWorkContentStorageOperation(entry.metadata.identity.pluginId, entry.metadata.identity.novelPath, async () => {
        const downloadRevision = currentChapterDownloadRevision();
        const chapters = await listStoredNovelChapters(entry.directory);
        await runDatabaseTransaction(async transaction => {
          const current = await readStoredNovelMetadata(entry.directory);
          if (!current) return;
          const fileConflict = await hasWorkMetadataConflict(current.directory, current.metadata);
          const [existing] = fileConflict ? await transaction.select<{ id: number }[]>(
            "SELECT id FROM novel WHERE plugin_id=$1 AND path=$2", [current.metadata.identity.pluginId, current.metadata.identity.novelPath]) : [];
          if (fileConflict && !existing) return;
          const novelId = existing?.id ?? await applyNovelMetadataToCache(transaction, current.metadata, current.directory, { preserveMissingMetadata: true });
          await scanStoredNovelChaptersToCache(transaction, novelId, current.directory, { chapters, downloadRevision });
          if (!fileConflict) await rememberStoredNovelMetadata(transaction, current.directory, current.metadata, true);
          await transaction.execute("DELETE FROM work_metadata_dirty WHERE plugin_id=$1 AND path=$2", [current.metadata.identity.pluginId, current.metadata.identity.novelPath]);
        }, true);
      });
    }
  }
  return db.select<WorkMetadataSyncFile[]>(`SELECT f.plugin_id AS pluginId,f.path,f.directory,f.fingerprint,COALESCE(j.revision,0) AS revision
    FROM work_metadata_file_cache f LEFT JOIN work_metadata_sync_journal j ON j.plugin_id=f.plugin_id AND j.path=f.path`);
}

export async function markWorkMetadataRefreshed(db: Database, identity: Pick<NovelMetadataV1["identity"], "pluginId" | "novelPath">): Promise<void> {
  await db.execute(`INSERT INTO work_metadata_sync_journal(plugin_id,path,revision) VALUES($1,$2,1)
    ON CONFLICT(plugin_id,path) DO UPDATE SET revision=revision+1`, [identity.pluginId, identity.novelPath]);
}

export async function readWorkMetadataSyncFile(identity: Pick<NovelMetadataV1["identity"], "pluginId" | "novelPath">, db?: Database): Promise<WorkMetadataSyncFile | null> {
  if (!isTauriRuntime()) return null;
  const database = db ?? await (await import("./client")).getDb();
  const [file] = await database.select<WorkMetadataSyncFile[]>(`SELECT f.plugin_id AS pluginId,f.path,f.directory,f.fingerprint,COALESCE(j.revision,0) AS revision
    FROM work_metadata_file_cache f LEFT JOIN work_metadata_sync_journal j ON j.plugin_id=f.plugin_id AND j.path=f.path
    WHERE f.plugin_id=$1 AND f.path=$2`, [identity.pluginId, identity.novelPath]);
  return file ?? null;
}

export async function persistWorkChapterDirectories(db: Database, novelId: number, chapters: { id: number; directory: string }[], registerNative = true): Promise<void> {
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

export function knownNovelMetadataDirectory(identity: Pick<NovelMetadataV1["identity"], "pluginId" | "novelPath">): string | undefined {
  return knownFiles.get(keyFor(identity.pluginId, identity.novelPath))?.directory;
}

interface CachedNovel {
  id: number; pluginId: string; sourceNovelId: string | null; path: string; name: string; cover: string | null;
  author: string | null; artist: string | null; summary: string | null; status: string | null; genres: string | null; rating: number | null; isLocal: number;
}

interface FetchedChapterCatalog { novelId: number; chapters: NovelMetadataV1["chapters"] }

export async function flushWorkMetadata(db: Database, fetched?: FetchedChapterCatalog): Promise<void> {
  if (!isTauriRuntime()) return;
  if (fetched) {
    const [work] = await db.select<(Pick<NovelMetadataV1["novel"], "name" | "author" | "artist" | "summary" | "status" | "genres" | "rating"> & { directory: string | null; dirty: number })[]>(`SELECT f.directory,n.name,n.author,n.artist,n.summary,n.status,n.genres,n.rating,
      EXISTS(SELECT 1 FROM work_metadata_dirty d WHERE d.plugin_id=n.plugin_id AND d.path=n.path) AS dirty
      FROM novel n LEFT JOIN work_metadata_file_cache f ON f.novel_id=n.id WHERE n.id=$1`, [fetched.novelId]);
    if (work && !work.dirty) {
      const stored = work.directory ? await readStoredNovelMetadata(work.directory) : null;
      const fields = ["name", "author", "artist", "summary", "status", "genres", "rating"] as const;
      if (!stored || fields.some(field => stored.metadata.novel[field] !== work[field]) ||
        Object.entries(fetched.chapters).some(([number, name]) => stored.metadata.chapters[number] !== name)) {
        await db.execute(`INSERT INTO work_metadata_dirty(plugin_id,path)
          SELECT plugin_id,path FROM novel WHERE id=$1 ON CONFLICT(plugin_id,path) DO NOTHING`, [fetched.novelId]);
      }
    }
  }
  const previousKnownFiles = new Map(knownFiles);
  try { await withWorkMetadataRollback(() => flushDirtyWorkMetadata(db, fetched)); }
  catch (error) {
    knownFiles.clear();
    for (const [key, value] of previousKnownFiles) knownFiles.set(key, value);
    throw error;
  }
}

async function flushDirtyWorkMetadata(db: Database, fetched?: FetchedChapterCatalog): Promise<void> {
  const dirty = await db.select<{ pluginId: string; path: string }[]>("SELECT plugin_id AS pluginId,path FROM work_metadata_dirty");
  for (const identity of dirty) {
    const key = keyFor(identity.pluginId, identity.path);
    const known = knownFiles.get(key);
    let previous: NovelMetadataV1 | undefined;
    let fileChanged = false;
    if (known) {
      const { body } = await workMetadataOperation({ operation: "read", path: `${known.directory}/novel.json` });
      if (!body) throw new Error("work metadata: authoritative file disappeared; reload before editing");
      previous = parseNovelMetadata(JSON.parse(new TextDecoder().decode(base64ToBytes(body))));
      previous.cover = await discoverStoredNovelCover(known.directory, previous.cover);
      fileChanged = await storedNovelMetadataFingerprint(previous) !== known.fingerprint;
    }
    const [novel] = await db.select<CachedNovel[]>(`SELECT id,plugin_id AS pluginId,source_novel_id AS sourceNovelId,path,name,cover,author,artist,summary,status,genres,rating,is_local AS isLocal FROM novel WHERE plugin_id=$1 AND path=$2`, [identity.pluginId, identity.path]);
    if (fileChanged && (!novel || fetched?.novelId !== novel.id)) throw new Error("work metadata: file changed outside the cache; refresh from the source before editing");
    if (!novel) {
      if (known) await workMetadataOperation({ operation: "remove", path: `${known.directory}/novel.json` });
      await db.execute("DELETE FROM work_metadata_directory_cache WHERE novel_id IN (SELECT novel_id FROM work_metadata_file_cache WHERE plugin_id=$1 AND path=$2)", [identity.pluginId, identity.path]);
      await db.execute("DELETE FROM work_metadata_file_cache WHERE plugin_id=$1 AND path=$2", [identity.pluginId, identity.path]);
      knownFiles.delete(key); continue;
    }
    const directory = known?.directory ?? await availableNovelMetadataDirectory({ identity: { pluginId: novel.pluginId, novelId: novel.sourceNovelId!, novelPath: novel.path }, novel: { ...novel, isLocal: Boolean(novel.isLocal) } });
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
      const target = preferred;
      if (used.has(target.toLowerCase())) throw new Error("work metadata: chapter sequence is already assigned");
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
    const sourceCatalog = fileChanged
      ? Object.fromEntries(chapters.filter(chapter => chapter.chapterNumber !== null).map(chapter => [String(Number(chapter.chapterNumber)), chapter.name]))
      : previous?.chapters;
    const metadata = parseNovelMetadata({ schemaVersion: 1, identity: { pluginId: novel.pluginId, novelId: novel.sourceNovelId!, novelPath: novel.path },
      novel: { name: novel.name, author: novel.author, artist: novel.artist, summary: novel.summary, status: novel.status, genres: novel.genres, rating: novel.rating, isLocal: Boolean(novel.isLocal) },
      cover, chapters: novel.isLocal
        ? Object.fromEntries(chapters.map(chapter => [chapterStorageDirectoryName(chapter), chapter.name]))
        : { ...sourceCatalog, ...(fetched?.novelId === novel.id ? fetched.chapters : {}) } });
    const coverChanged = localCoverBytes ? await writeStoredNovelCover(directory, metadata, localCoverBytes) : false;
    await writeStoredNovelMetadata(directory, metadata);
    if (!cover && previous?.cover) await removeStoredNovelCover(directory, previous.cover);
    rememberResolvedNovelStorageDir(novel.id, directory);
    await persistWorkChapterDirectories(db, novel.id, mapped);
    await rememberStoredNovelMetadata(db, directory, metadata, coverChanged);
  }
  if (dirty.length) await db.execute("DELETE FROM work_metadata_dirty");
}
