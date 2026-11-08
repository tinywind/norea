import { invoke } from "@tauri-apps/api/core";
import type Database from "@tauri-apps/plugin-sql";
import type { WorkMetadataSyncFile } from "../db/work-metadata";
import { androidWorkMetadataOperation } from "./android-storage";
import { bytesToBase64, base64ToBytes } from "./base64";
import { inspectChapterContentArtifacts } from "./chapter-content/storage-platform";
import { novelStorageRelativeDir } from "./chapter-storage-path";
import { isAndroidRuntime, isTauriRuntime } from "./tauri-runtime";
import { runWorkContentStorageOperation } from "./content-sync/storage-operation";
import { canonicalMetadataValue, coverContentType, MAX_NOVEL_COVER_BYTES, parseNovelMetadata, safeMetadataChild, type NovelMetadataV1 } from "./work-metadata/schema";
import { throwIfAborted } from "./abort";
import { mergeIncomingNovelMetadata } from "./work-metadata/merge";
export { parseNovelMetadata, type NovelMetadataV1 } from "./work-metadata/schema";

export interface StoredNovelMetadata { directory: string; metadata: NovelMetadataV1 }
export interface InstalledNovelMetadata extends StoredNovelMetadata { syncFile: WorkMetadataSyncFile; coverBytes: Uint8Array | null }
export interface WorkMetadataOperation {
  operation: "list" | "chapters" | "cover" | "read" | "write" | "remove" | "register";
  path?: string;
  body?: string;
  chapterDirectories?: Record<string, string>;
  skipChapterDirectories?: string[];
  reset?: boolean;
}
export interface WorkMetadataOperationResult { paths?: string[]; body?: string | null; changed?: boolean; cover?: { fileName: string; modifiedAt: number } | null }
export type WorkMetadataChange = Pick<NovelMetadataV1["identity"], "pluginId" | "novelPath">;
const listeners = new Set<(identity?: WorkMetadataChange) => void>();
let publicationSnapshots: Map<string, string | null> | null = null;
let publicationChanges: Array<WorkMetadataChange | undefined> | null = null;
let publicationRollbackGuards: Map<string, () => Promise<void>> | null = null;
export function subscribeWorkMetadataChanges(listener: (identity?: WorkMetadataChange) => void): () => void {
  listeners.add(listener); return () => listeners.delete(listener);
}
export function notifyWorkMetadataChanges(identity?: WorkMetadataChange): void {
  if (publicationChanges) { publicationChanges.push(identity); return; }
  for (const listener of listeners) listener(identity);
}

export async function registerNativeWorkChapterDirectories(directories: Record<string, string>, reset = false): Promise<void> {
  if (!reset && Object.keys(directories).length === 0) return;
  if (isTauriRuntime() && !isAndroidRuntime()) await workMetadataOperation({ operation: "register", chapterDirectories: directories, reset });
}

export async function availableNovelMetadataDirectory(metadata: Pick<NovelMetadataV1, "identity" | "novel">): Promise<string> {
  const preferred = novelStorageRelativeDir({ pluginId: metadata.identity.pluginId, sourceNovelId: metadata.identity.novelId, path: metadata.identity.novelPath, name: metadata.novel.name });
  const { body } = await workMetadataOperation({ operation: "read", path: `${preferred}/novel.json` });
  if (!body) return preferred;
  const existing: unknown = JSON.parse(new TextDecoder().decode(base64ToBytes(body)));
  if (hasWorkIdentity(existing, metadata.identity)) return preferred;
  throw new Error("work metadata: plugin-owned novel ID is already assigned to another work");
}

function hasWorkIdentity(value: unknown, expected: NovelMetadataV1["identity"]): boolean {
  if (!value || typeof value !== "object" || !("identity" in value)) return false;
  const identity = value.identity;
  return Boolean(identity && typeof identity === "object" && "pluginId" in identity && "novelPath" in identity &&
    identity.pluginId === expected.pluginId && identity.novelPath === expected.novelPath &&
    "novelId" in identity && identity.novelId === expected.novelId);
}

async function readNovelMetadataForReplacement(directory: string, identity: NovelMetadataV1["identity"]): Promise<(StoredNovelMetadata & { document: unknown }) | null> {
  const { body } = await workMetadataOperation({ operation: "read", path: `${directory}/novel.json` });
  if (!body) return null;
  const value: unknown = JSON.parse(new TextDecoder().decode(base64ToBytes(body)));
  if (!hasWorkIdentity(value, identity)) throw new Error("work metadata: replacement identity does not match the existing file");
  return { directory, metadata: parseNovelMetadata(value), document: value };
}

export async function workMetadataOperation(input: WorkMetadataOperation): Promise<WorkMetadataOperationResult> {
  if (input.path) {
    const segments = input.path.split("/");
    if (segments.length !== 4 || segments[0] !== "contents" || !segments.every(safeMetadataChild)) throw new Error("work metadata: invalid storage path");
  }
  if (input.operation === "write" && input.path) {
    const current = await rawWorkMetadataOperation({ operation: "read", path: input.path });
    if (current.body === input.body) return { changed: false };
  }
  if (publicationSnapshots && input.path && (input.operation === "write" || input.operation === "remove") && !publicationSnapshots.has(input.path)) {
    const previous = await rawWorkMetadataOperation({ operation: "read", path: input.path });
    publicationSnapshots.set(input.path, previous.body ?? null);
  }
  const result = await rawWorkMetadataOperation(input);
  return input.operation === "write" ? { ...result, changed: true } : result;
}

async function rawWorkMetadataOperation(input: WorkMetadataOperation): Promise<WorkMetadataOperationResult> {
  if (isAndroidRuntime()) return androidWorkMetadataOperation(input);
  const result = await invoke<Omit<WorkMetadataOperationResult, "body"> & { body?: number[] | null }>("work_metadata_operation", {
    input: { ...input, body: input.body === undefined ? undefined : Array.from(base64ToBytes(input.body)) },
  });
  return { ...result, body: result.body ? bytesToBase64(new Uint8Array(result.body)) : null };
}

export async function withWorkMetadataRollback<T>(run: () => Promise<T>, options: { preserveCoverSourcesOnRollback?: boolean } = {}): Promise<T> {
  if (publicationSnapshots) return run();
  const snapshots = new Map<string, string | null>();
  const changes: Array<WorkMetadataChange | undefined> = [];
  publicationSnapshots = snapshots;
  publicationChanges = changes;
  publicationRollbackGuards = new Map();
  let result: T;
  try { result = await run(); }
  catch (error) {
    const failures: unknown[] = [error];
    for (const [path, body] of [...snapshots].reverse()) {
      try {
        const current = await rawWorkMetadataOperation({ operation: "read", path });
        if ((current.body ?? null) === body) continue;
        await publicationRollbackGuards?.get(path)?.();
        await rawWorkMetadataOperation(body === null ? { operation: "remove", path } : { operation: "write", path, body });
      } catch (restoreError) { failures.push(restoreError); }
    }
    if (snapshots.size && (!options.preserveCoverSourcesOnRollback || failures.length > 1)) {
      const { invalidateAllNovelCoverSources } = await import("./novel-cover-storage");
      invalidateAllNovelCoverSources();
    }
    if (failures.length > 1) throw new AggregateError(failures, "work metadata: publication and rollback failed");
    throw error;
  } finally { publicationSnapshots = null; publicationChanges = null; publicationRollbackGuards = null; }
  for (const identity of changes) notifyWorkMetadataChanges(identity);
  return result;
}

export async function listStoredNovelMetadata(): Promise<StoredNovelMetadata[]> {
  const entries: StoredNovelMetadata[] = [];
  for await (const entry of scanStoredNovelMetadata()) entries.push(entry);
  return entries;
}

export async function* scanStoredNovelMetadata(
  onDiscovered?: (total: number) => void,
  onInspected?: (path: string, skipped: boolean) => void,
  signal?: AbortSignal,
): AsyncGenerator<StoredNovelMetadata> {
  if (!isTauriRuntime()) return;
  const { paths = [] } = await workMetadataOperation({ operation: "list" });
  throwIfAborted(signal, "Storage recovery cancelled.");
  onDiscovered?.(paths.length);
  const identities = new Set<string>();
  for (const path of paths) {
    throwIfAborted(signal, "Storage recovery cancelled.");
    const { body } = await workMetadataOperation({ operation: "read", path });
    throwIfAborted(signal, "Storage recovery cancelled.");
    if (!body) { onInspected?.(path, true); continue; }
    let metadata: NovelMetadataV1;
    try { metadata = parseNovelMetadata(JSON.parse(new TextDecoder().decode(base64ToBytes(body)))); }
    catch {
      // eslint-disable-next-line no-console -- Report skipped input paths without logging document contents.
      console.warn("[work-metadata] skipped invalid metadata", path);
      onInspected?.(path, true);
      continue;
    }
    const directory = path.slice(0, -"/novel.json".length);
    if (directory !== `contents/${metadata.identity.pluginId}/${metadata.identity.novelId}`) { onInspected?.(path, true); continue; }
    const identity = JSON.stringify([metadata.identity.pluginId, metadata.identity.novelPath]);
    if (identities.has(identity)) throw new Error(`work metadata: duplicate work ${path}`);
    identities.add(identity);
    metadata.cover = await discoverStoredNovelCover(directory, metadata.cover);
    throwIfAborted(signal, "Storage recovery cancelled.");
    onInspected?.(path, false);
    yield { directory, metadata };
  }
}

export interface StoredNovelChapter {
  directory: string;
  chapterNumber: string;
  name: string;
  contentType: "html" | "pdf";
  contentBytes: number;
  mediaBytes: number;
  mediaComplete: boolean;
}

export async function listStoredNovelChapters(directory: string, signal?: AbortSignal): Promise<StoredNovelChapter[]> {
  throwIfAborted(signal, "Storage recovery cancelled.");
  const { paths = [] } = await workMetadataOperation({ operation: "chapters", path: `${directory}/novel.json` });
  const chapters: StoredNovelChapter[] = [];
  const seen = new Set<string>();
  const inspect = async (path: string): Promise<StoredNovelChapter | null> => {
    if (!path.startsWith(`${directory}/`)) throw new Error("work metadata: invalid chapter location");
    const parts = path.slice(directory.length + 1).split("/");
    const [child, fileName] = parts;
    if (parts.length !== 2 || !safeMetadataChild(child!) || !["content.html", "content.pdf", ".chapter-content.partial"].includes(fileName!)) throw new Error("work metadata: invalid chapter file");
    const match = /^(\d+(?:\.\d+)?)$/.exec(child!);
    if (!match || String(Number(match[1])) !== child || seen.has(child!)) return null;
    seen.add(child!);
    const artifacts = await inspectChapterContentArtifacts({
      preferredChapterDir: `${directory}/${child}`,
      sourceDir: directory.slice(0, directory.lastIndexOf("/")),
      novelDirectoryName: directory.slice(directory.lastIndexOf("/") + 1),
      chapterDirectoryName: child!,
      preferredContentFileName: fileName!,
    });
    if (artifacts.status !== "present") return null;
    return { directory: child!, chapterNumber: match[1]!, name: match[1]!,
      contentType: artifacts.contentFile?.endsWith(".pdf") ? "pdf" : "html",
      contentBytes: artifacts.contentBytes, mediaBytes: artifacts.mediaBytes, mediaComplete: artifacts.mediaComplete === true };
  };
  for (let offset = 0; offset < paths.length; offset += 4) {
    throwIfAborted(signal, "Storage recovery cancelled.");
    // Drain native reads before cancellation or failure releases the recovery operation.
    const results = await Promise.allSettled(paths.slice(offset, offset + 4).map(inspect));
    throwIfAborted(signal, "Storage recovery cancelled.");
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      if (result.value) chapters.push(result.value);
    }
  }
  throwIfAborted(signal, "Storage recovery cancelled.");
  return chapters.sort((a, b) => Number(a.chapterNumber) - Number(b.chapterNumber) || a.directory.localeCompare(b.directory));
}

export async function readStoredNovelMetadata(directory: string): Promise<StoredNovelMetadata | null> {
  const { body } = await workMetadataOperation({ operation: "read", path: `${directory}/novel.json` });
  if (!body) return null;
  const metadata = parseNovelMetadata(JSON.parse(new TextDecoder().decode(base64ToBytes(body))));
  metadata.cover = await discoverStoredNovelCover(directory, metadata.cover);
  return { directory, metadata };
}

export async function discoverStoredNovelCover(directory: string, preferred: NovelMetadataV1["cover"] = null): Promise<NovelMetadataV1["cover"]> {
  const { cover } = await workMetadataOperation({ operation: "cover", path: `${directory}/novel.json` });
  if (!cover) return null;
  return { fileName: cover.fileName, contentType: cover.fileName === preferred?.fileName ? preferred.contentType : coverContentType(cover.fileName) };
}

export async function writeStoredNovelMetadata(directory: string, input: NovelMetadataV1, notifyChanges = true): Promise<void> {
  const metadata = parseNovelMetadata(input);
  const current = await readNovelMetadataForReplacement(directory, metadata.identity);
  if (current && JSON.stringify(canonicalMetadataValue(current.document)) === JSON.stringify(canonicalMetadataValue(metadata))) return;
  const { changed } = await workMetadataOperation({ operation: "write", path: `${directory}/novel.json`, body: bytesToBase64(new TextEncoder().encode(JSON.stringify(metadata, null, 2))) });
  if (notifyChanges && changed) notifyWorkMetadataChanges(metadata.identity);
}

export async function readStoredNovelCover(directory: string, metadata: NovelMetadataV1): Promise<Uint8Array | null> {
  if (!metadata.cover) return null;
  const { body } = await workMetadataOperation({ operation: "read", path: `${directory}/${metadata.cover.fileName}` });
  if (!body) return null;
  const bytes = base64ToBytes(body);
  if (bytes.length > MAX_NOVEL_COVER_BYTES) throw new Error("work metadata: cover exceeds size limit");
  return bytes;
}

export async function writeStoredNovelCover(directory: string, metadata: NovelMetadataV1, bytes: Uint8Array, notifyChanges = true): Promise<boolean> {
  parseNovelMetadata(metadata);
  if (!metadata.cover || !bytes.length || bytes.length > MAX_NOVEL_COVER_BYTES) throw new Error("work metadata: invalid cover bytes");
  const cover = await workMetadataOperation({ operation: "write", path: `${directory}/${metadata.cover.fileName}`, body: bytesToBase64(bytes) });
  const changed = Boolean(cover.changed);
  if (notifyChanges && changed) {
    const { invalidateAllNovelCoverSources } = await import("./novel-cover-storage");
    invalidateAllNovelCoverSources();
    notifyWorkMetadataChanges(metadata.identity);
  }
  return changed;
}

export interface StoredNovelNumberReconciliation {
  journal: import("./source-chapter-renumber").SourceChapterRenumberJournal | null;
  mappings: readonly import("./source-chapter-renumber").ChapterNumberMapping[];
}

export interface InstallStoredNovelMetadataOptions {
  /** A migration target snapshot owns every novel field, including explicit absence. */
  authoritative?: boolean;
}

export async function installStoredNovelMetadata(input: NovelMetadataV1, coverBytes?: Uint8Array, beforeInstall?: (current: StoredNovelMetadata | null, db?: Database) => Promise<void | false>, options: InstallStoredNovelMetadataOptions = {}): Promise<InstalledNovelMetadata | null> {
  const metadata = parseNovelMetadata(input);
  return runWorkContentStorageOperation(metadata.identity.pluginId, metadata.identity.novelPath,
    () => installStoredNovelMetadataInWorkOperation(metadata, coverBytes, beforeInstall, undefined, options));
}

/** Called only inside withServerChapterNumberReconciliation, which owns the work storage lock. */
export async function installReconciledStoredNovelMetadata(
  input: NovelMetadataV1,
  coverBytes: Uint8Array | undefined,
  beforeInstall: (current: StoredNovelMetadata | null, db?: Database) => Promise<void | false>,
  reconciliation: StoredNovelNumberReconciliation,
): Promise<InstalledNovelMetadata | null> {
  return installStoredNovelMetadataInWorkOperation(input, coverBytes, beforeInstall, reconciliation);
}

async function installStoredNovelMetadataInWorkOperation(input: NovelMetadataV1, coverBytes?: Uint8Array, beforeInstall?: (current: StoredNovelMetadata | null, db?: Database) => Promise<void | false>, reconciliation?: StoredNovelNumberReconciliation, options: InstallStoredNovelMetadataOptions = {}): Promise<InstalledNovelMetadata | null> {
  let metadata = parseNovelMetadata(input);
  if (options.authoritative && metadata.cover && !coverBytes?.length) throw new Error("A migration target cover requires verified cover bytes.");
  const { runDatabaseTransaction } = await import("../db/client");
  const { applyNovelMetadataToCache, knownNovelMetadataDirectory, readWorkMetadataSyncFile, rememberStoredNovelMetadata } = await import("../db/work-metadata");
    const preferred = knownNovelMetadataDirectory(metadata.identity) ?? await availableNovelMetadataDirectory(metadata);
    const installed = await runDatabaseTransaction(async (db) => {
      const directory = knownNovelMetadataDirectory(metadata.identity) ?? preferred;
      const existing = await readNovelMetadataForReplacement(directory, metadata.identity);
      if (existing) existing.metadata.cover = await discoverStoredNovelCover(directory, existing.metadata.cover);
      if (await beforeInstall?.(existing, db) === false) return null;
      return withWorkMetadataRollback(async () => {
        let previous = existing?.metadata;
        if (reconciliation) {
          const renumber = await import("./source-chapter-renumber");
          renumber.assertChapterNumberMappings(reconciliation.mappings);
          const [work] = await db.select<import("./source-chapter-renumber").RenumberWork[]>(
            "SELECT id,plugin_id AS pluginId,source_novel_id AS sourceNovelId,path FROM novel WHERE plugin_id=$1 AND path=$2",
            [metadata.identity.pluginId, metadata.identity.novelPath],
          );
          if (!work || work.sourceNovelId !== metadata.identity.novelId) throw new Error("Incoming chapter number identity changed.");
          const changes = renumber.planServerChapterNumberChanges(work, await renumber.readRenumberChapters(db, work.id), reconciliation.mappings);
          if (reconciliation.journal) {
            if (JSON.stringify(changes) !== JSON.stringify(reconciliation.journal.changes)) {
              throw new Error("Local chapter state changed while the server correction was prepared.");
            }
            await renumber.assertSourceChapterRenumberMetadataUnchanged(reconciliation.journal);
            const journal = reconciliation.journal;
            for (const file of journal.metadataFiles ?? []) {
              publicationRollbackGuards?.set(file.path, () => renumber.assertSourceChapterRenumberMetadataRecoverable(journal));
            }
            await renumber.applySourceChapterNumberChangesInDb(db, work.id, reconciliation.journal);
          } else if (changes.length) {
            throw new Error("Incoming chapter numbers changed before their storage could be prepared.");
          }
          const chapters = { ...previous?.chapters };
          for (const mapping of reconciliation.mappings) {
            delete chapters[mapping.from];
            if (Object.hasOwn(metadata.chapters, mapping.from)) throw new Error("Incoming catalog still contains a replaced chapter number.");
          }
          if (previous) previous = { ...previous, chapters };
          const { reconcileImportedNovelIdentityInDb } = await import("../db/queries/novel-identity");
          await reconcileImportedNovelIdentityInDb(db, {
            pluginId: metadata.identity.pluginId, path: metadata.identity.novelPath,
          }, reconciliation.mappings.map(mapping => ({ path: mapping.chapterPath, chapterNumber: mapping.to })));
        }
        const merged = mergeIncomingNovelMetadata(previous, metadata);
        metadata = options.authoritative ? { ...merged, novel: metadata.novel, cover: metadata.cover } : merged;
        if (options.authoritative) await removeAllStoredNovelCovers(directory, existing?.metadata.cover ?? null);
        if (coverBytes) await writeStoredNovelCover(directory, metadata, coverBytes, false);
        else if (!options.authoritative) metadata.cover = existing?.metadata.cover ?? null;
        const installedNovelId = await applyNovelMetadataToCache(db, metadata, directory, { preserveMissingMetadata: !options.authoritative });
        if (options.authoritative && !metadata.novel.isLocal) await db.execute("UPDATE novel SET cover=NULL WHERE id=$1", [installedNovelId]);
        const [cached] = await db.select<Pick<NovelMetadataV1["novel"], "author" | "artist" | "summary" | "status" | "genres" | "rating">[]>(
          "SELECT author,artist,summary,status,genres,rating FROM novel WHERE id=$1", [installedNovelId]);
        if (!cached) throw new Error("Installed work metadata is missing from the local cache.");
        metadata.novel = { ...metadata.novel, ...cached };
        await writeStoredNovelMetadata(directory, metadata, false);
        await db.execute("DELETE FROM work_metadata_dirty WHERE plugin_id=$1 AND path=$2", [metadata.identity.pluginId, metadata.identity.novelPath]);
        await rememberStoredNovelMetadata(db, directory, metadata, true);
        const syncFile = await readWorkMetadataSyncFile(metadata.identity, db);
        if (!syncFile) throw new Error("Installed work metadata is missing from the local index.");
        if (reconciliation?.journal) {
          const { commitSourceChapterRenumberInDb } = await import("./source-chapter-renumber");
          await commitSourceChapterRenumberInDb(db, reconciliation.journal);
        }
        return { novelId: installedNovelId, directory, syncFile, coverBytes: await readStoredNovelCover(directory, metadata) };
      });
    }, true);
    if (!installed) return null;
    const { notifyNovelCoverChanged } = await import("./novel-cover-storage");
    notifyNovelCoverChanged(installed.novelId, { pluginId: metadata.identity.pluginId, path: metadata.identity.novelPath });
    return { directory: installed.directory, metadata, syncFile: installed.syncFile, coverBytes: installed.coverBytes };
}

export async function removeStoredNovelCover(directory: string, cover: NovelMetadataV1["cover"], notifyChanges = true, identity?: WorkMetadataChange): Promise<void> {
  if (cover) await workMetadataOperation({ operation: "remove", path: `${directory}/${cover.fileName}` });
  if (notifyChanges) {
    const { invalidateAllNovelCoverSources } = await import("./novel-cover-storage");
    invalidateAllNovelCoverSources();
    notifyWorkMetadataChanges(identity);
  }
}

async function removeAllStoredNovelCovers(directory: string, preferred: NovelMetadataV1["cover"]): Promise<void> {
  let cover = await discoverStoredNovelCover(directory, preferred);
  const removed = new Set<string>();
  while (cover) {
    if (removed.has(cover.fileName)) throw new Error("work metadata: cleared cover is still present");
    removed.add(cover.fileName);
    await removeStoredNovelCover(directory, cover, false);
    cover = await discoverStoredNovelCover(directory);
  }
}

export async function persistNovelCover(directory: string, cover: { body: Uint8Array; fileName: string; contentType: string | null } | null, options: { preserveExisting?: boolean } = {}): Promise<void> {
  const { runDatabaseTransaction } = await import("../db/client");
  const { hasWorkMetadataConflict, rememberStoredNovelMetadata } = await import("../db/work-metadata");
  const identity = await runDatabaseTransaction((db) => withWorkMetadataRollback(async () => {
    if (options.preserveExisting) {
      const { cover: existing } = await workMetadataOperation({ operation: "cover", path: `${directory}/novel.json` });
      if (existing) return;
    }
    const { body } = await workMetadataOperation({ operation: "read", path: `${directory}/novel.json` });
    if (!body) throw new Error("work metadata: missing work for cover");
    const metadata = parseNovelMetadata(JSON.parse(new TextDecoder().decode(base64ToBytes(body))));
    metadata.cover = await discoverStoredNovelCover(directory, metadata.cover);
    if (await hasWorkMetadataConflict(directory, metadata)) throw new Error("work metadata: file changed outside the cache; refresh from the source before editing");
    let coverChanged = false;
    if (cover) {
      const previousCover = metadata.cover;
      metadata.cover = { fileName: cover.fileName, contentType: cover.contentType };
      coverChanged = await writeStoredNovelCover(directory, metadata, cover.body, false);
      if (previousCover && previousCover.fileName !== cover.fileName) await removeStoredNovelCover(directory, previousCover, false);
    } else {
      const removed = new Set<string>();
      while (metadata.cover) {
        if (removed.has(metadata.cover.fileName)) throw new Error("work metadata: cleared cover is still present");
        removed.add(metadata.cover.fileName);
        await removeStoredNovelCover(directory, metadata.cover, false);
        coverChanged = true;
        metadata.cover = await discoverStoredNovelCover(directory);
      }
    }
    await writeStoredNovelMetadata(directory, metadata, false);
    await rememberStoredNovelMetadata(db, directory, metadata, coverChanged);
    return metadata.identity;
  }, { preserveCoverSourcesOnRollback: options.preserveExisting }));
  if (identity) notifyWorkMetadataChanges(identity);
}
