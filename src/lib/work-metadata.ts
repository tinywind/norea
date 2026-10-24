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
const listeners = new Set<() => void>();
let publicationSnapshots: Map<string, string | null> | null = null;
export function subscribeWorkMetadataChanges(listener: () => void): () => void {
  listeners.add(listener); return () => listeners.delete(listener);
}
export function notifyWorkMetadataChanges(): void { for (const listener of listeners) listener(); }

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
  publicationSnapshots = snapshots;
  try { return await run(); }
  catch (error) {
    const failures: unknown[] = [error];
    for (const [path, body] of [...snapshots].reverse()) {
      try {
        const current = await rawWorkMetadataOperation({ operation: "read", path });
        if ((current.body ?? null) === body) continue;
        await rawWorkMetadataOperation(body === null ? { operation: "remove", path } : { operation: "write", path, body });
      } catch (restoreError) { failures.push(restoreError); }
    }
    if (snapshots.size && (!options.preserveCoverSourcesOnRollback || failures.length > 1)) {
      const { invalidateAllNovelCoverSources } = await import("./novel-cover-storage");
      invalidateAllNovelCoverSources();
    }
    if (failures.length > 1) throw new AggregateError(failures, "work metadata: publication and rollback failed");
    throw error;
  } finally { publicationSnapshots = null; }
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
    if (parts.length !== 2 || !safeMetadataChild(child!) || !["content.html", "content.pdf"].includes(fileName!)) throw new Error("work metadata: invalid chapter file");
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
    return { directory: child!, chapterNumber: match[1]!, name: match[1]!, contentType: artifacts.contentFile?.endsWith(".pdf") ? "pdf" : "html", mediaComplete: artifacts.mediaComplete === true };
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
  if (notifyChanges && changed) notifyWorkMetadataChanges();
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
    notifyWorkMetadataChanges();
  }
  return changed;
}

export async function installStoredNovelMetadata(input: NovelMetadataV1, coverBytes?: Uint8Array, beforeInstall?: (current: StoredNovelMetadata | null, db?: Database) => Promise<void | false>): Promise<InstalledNovelMetadata | null> {
  let metadata = parseNovelMetadata(input);
  const { runDatabaseTransaction } = await import("../db/client");
  const { applyNovelMetadataToCache, knownNovelMetadataDirectory, readWorkMetadataSyncFile, rememberStoredNovelMetadata } = await import("../db/work-metadata");
  return runWorkContentStorageOperation(metadata.identity.pluginId, metadata.identity.novelPath, async () => {
    const preferred = knownNovelMetadataDirectory(metadata.identity) ?? await availableNovelMetadataDirectory(metadata);
    const installed = await runDatabaseTransaction(async (db) => {
      const directory = knownNovelMetadataDirectory(metadata.identity) ?? preferred;
      const existing = await readNovelMetadataForReplacement(directory, metadata.identity);
      if (existing) existing.metadata.cover = await discoverStoredNovelCover(directory, existing.metadata.cover);
      if (await beforeInstall?.(existing, db) === false) return null;
      return withWorkMetadataRollback(async () => {
        metadata = mergeIncomingNovelMetadata(existing?.metadata, metadata);
        if (coverBytes) await writeStoredNovelCover(directory, metadata, coverBytes, false);
        else metadata.cover = existing?.metadata.cover ?? null;
        const installedNovelId = await applyNovelMetadataToCache(db, metadata, directory, { preserveMissingMetadata: true });
        const [cached] = await db.select<Pick<NovelMetadataV1["novel"], "author" | "artist" | "summary" | "status" | "genres" | "rating">[]>(
          "SELECT author,artist,summary,status,genres,rating FROM novel WHERE id=$1", [installedNovelId]);
        if (!cached) throw new Error("Installed work metadata is missing from the local cache.");
        metadata.novel = { ...metadata.novel, ...cached };
        await writeStoredNovelMetadata(directory, metadata, false);
        await db.execute("DELETE FROM work_metadata_dirty WHERE plugin_id=$1 AND path=$2", [metadata.identity.pluginId, metadata.identity.novelPath]);
        await rememberStoredNovelMetadata(db, directory, metadata, true);
        const syncFile = await readWorkMetadataSyncFile(metadata.identity, db);
        if (!syncFile) throw new Error("Installed work metadata is missing from the local index.");
        return { novelId: installedNovelId, directory, syncFile, coverBytes: await readStoredNovelCover(directory, metadata) };
      });
    }, true);
    if (!installed) return null;
    const { notifyNovelCoverChanged } = await import("./novel-cover-storage");
    notifyNovelCoverChanged(installed.novelId, { pluginId: metadata.identity.pluginId, path: metadata.identity.novelPath });
    return { directory: installed.directory, metadata, syncFile: installed.syncFile, coverBytes: installed.coverBytes };
  });
}

export async function removeStoredNovelCover(directory: string, cover: NovelMetadataV1["cover"], notifyChanges = true): Promise<void> {
  if (cover) await workMetadataOperation({ operation: "remove", path: `${directory}/${cover.fileName}` });
  if (notifyChanges) {
    const { invalidateAllNovelCoverSources } = await import("./novel-cover-storage");
    invalidateAllNovelCoverSources();
    notifyWorkMetadataChanges();
  }
}

export async function persistNovelCover(directory: string, cover: { body: Uint8Array; fileName: string; contentType: string | null }, options: { preserveExisting?: boolean } = {}): Promise<void> {
  const { runDatabaseTransaction } = await import("../db/client");
  const { hasWorkMetadataConflict, rememberStoredNovelMetadata } = await import("../db/work-metadata");
  await runDatabaseTransaction((db) => withWorkMetadataRollback(async () => {
    if (options.preserveExisting) {
      const { cover: existing } = await workMetadataOperation({ operation: "cover", path: `${directory}/novel.json` });
      if (existing) return;
    }
    const { body } = await workMetadataOperation({ operation: "read", path: `${directory}/novel.json` });
    if (!body) throw new Error("work metadata: missing work for cover");
    const metadata = parseNovelMetadata(JSON.parse(new TextDecoder().decode(base64ToBytes(body))));
    metadata.cover = await discoverStoredNovelCover(directory, metadata.cover);
    if (await hasWorkMetadataConflict(directory, metadata)) throw new Error("work metadata: file changed outside the cache; refresh from the source before editing");
    const previousCover = metadata.cover;
    metadata.cover = { fileName: cover.fileName, contentType: cover.contentType };
    const coverChanged = await writeStoredNovelCover(directory, metadata, cover.body, false);
    if (previousCover && previousCover.fileName !== cover.fileName) await removeStoredNovelCover(directory, previousCover, false);
    await writeStoredNovelMetadata(directory, metadata, false);
    await rememberStoredNovelMetadata(db, directory, metadata, coverChanged);
  }, { preserveCoverSourcesOnRollback: options.preserveExisting }));
  notifyWorkMetadataChanges();
}
