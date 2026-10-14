import { invoke } from "@tauri-apps/api/core";
import { androidWorkMetadataOperation } from "./android-storage";
import { bytesToBase64, base64ToBytes } from "./base64";
import { novelStorageRelativeDir } from "./chapter-storage-path";
import { isAndroidRuntime, isTauriRuntime } from "./tauri-runtime";
import { runWorkContentStorageOperation } from "./content-sync/storage-operation";
import { MAX_NOVEL_COVER_BYTES, parseNovelMetadata, safeMetadataChild, type NovelMetadataV1 } from "./work-metadata/schema";
export { parseNovelMetadata, type NovelMetadataV1 } from "./work-metadata/schema";

export interface StoredNovelMetadata { directory: string; metadata: NovelMetadataV1 }
export interface WorkMetadataOperation {
  operation: "list" | "chapters" | "read" | "write" | "remove" | "register";
  path?: string;
  body?: string;
  chapterDirectories?: Record<string, string>;
  reset?: boolean;
}
export interface WorkMetadataOperationResult { paths?: string[]; body?: string | null; changed?: boolean }
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
  const preferred = novelStorageRelativeDir({ pluginId: metadata.identity.pluginId, path: metadata.identity.novelPath, name: metadata.novel.name });
  const { body } = await workMetadataOperation({ operation: "read", path: `${preferred}/novel.json` });
  if (!body) return preferred;
  const existing: unknown = JSON.parse(new TextDecoder().decode(base64ToBytes(body)));
  if (hasWorkIdentity(existing, metadata.identity)) return preferred;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([metadata.identity.pluginId, metadata.identity.novelPath])));
  const segments = preferred.split("/");
  segments[2] = `${segments[2]!.slice(0, 150)}-${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return segments.join("/");
}

function hasWorkIdentity(value: unknown, expected: NovelMetadataV1["identity"]): boolean {
  if (!value || typeof value !== "object" || !("identity" in value)) return false;
  const identity = value.identity;
  return Boolean(identity && typeof identity === "object" && "pluginId" in identity && "novelPath" in identity &&
    identity.pluginId === expected.pluginId && identity.novelPath === expected.novelPath);
}

async function readNovelMetadataForReplacement(directory: string, identity: NovelMetadataV1["identity"]): Promise<StoredNovelMetadata | null> {
  const { body } = await workMetadataOperation({ operation: "read", path: `${directory}/novel.json` });
  if (!body) return null;
  const value: unknown = JSON.parse(new TextDecoder().decode(base64ToBytes(body)));
  if (!hasWorkIdentity(value, identity)) throw new Error("work metadata: replacement identity does not match the existing file");
  return { directory, metadata: parseNovelMetadata(value) };
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
  const result = await invoke<{ paths?: string[]; body?: number[] | null }>("work_metadata_operation", {
    input: { ...input, body: input.body === undefined ? undefined : Array.from(base64ToBytes(input.body)) },
  });
  return { paths: result.paths, body: result.body ? bytesToBase64(new Uint8Array(result.body)) : null };
}

export async function withWorkMetadataRollback<T>(run: () => Promise<T>): Promise<T> {
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
    const { invalidateAllNovelCoverSources } = await import("./novel-cover-storage");
    invalidateAllNovelCoverSources();
    if (failures.length > 1) throw new AggregateError(failures, "work metadata: publication and rollback failed");
    throw error;
  } finally { publicationSnapshots = null; }
}

export async function listStoredNovelMetadata(): Promise<StoredNovelMetadata[]> {
  if (!isTauriRuntime()) return [];
  const { paths = [] } = await workMetadataOperation({ operation: "list" });
  const entries: StoredNovelMetadata[] = [];
  const identities = new Set<string>();
  for (const path of paths) {
    const { body } = await workMetadataOperation({ operation: "read", path });
    if (!body) throw new Error(`work metadata: missing listed file ${path}`);
    let metadata: NovelMetadataV1;
    try { metadata = parseNovelMetadata(JSON.parse(new TextDecoder().decode(base64ToBytes(body)))); }
    catch {
      // eslint-disable-next-line no-console -- Report skipped input paths without logging document contents.
      console.warn("[work-metadata] skipped invalid metadata", path);
      continue;
    }
    const identity = JSON.stringify(metadata.identity);
    if (identities.has(identity)) throw new Error(`work metadata: duplicate work ${path}`);
    identities.add(identity);
    entries.push({ directory: path.slice(0, -"/novel.json".length), metadata });
  }
  return entries;
}

export interface StoredNovelChapter {
  directory: string;
  chapterNumber: string;
  name: string;
  contentType: "html" | "pdf";
}

export async function listStoredNovelChapters(directory: string): Promise<StoredNovelChapter[]> {
  const { paths = [] } = await workMetadataOperation({ operation: "chapters", path: `${directory}/novel.json` });
  const chapters: StoredNovelChapter[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(`${directory}/`)) throw new Error("work metadata: invalid chapter location");
    const parts = path.slice(directory.length + 1).split("/");
    const [child, fileName] = parts;
    if (parts.length !== 2 || !safeMetadataChild(child!) || !["content.html", "content.pdf"].includes(fileName!)) throw new Error("work metadata: invalid chapter file");
    const match = /^(\d+(?:\.\d+)?)-(.+)$/.exec(child!);
    if (!match || seen.has(child!)) continue;
    seen.add(child!);
    chapters.push({ directory: child!, chapterNumber: match[1]!, name: match[2]!, contentType: fileName === "content.pdf" ? "pdf" : "html" });
  }
  return chapters.sort((a, b) => Number(a.chapterNumber) - Number(b.chapterNumber) || a.directory.localeCompare(b.directory));
}

export async function readStoredNovelMetadata(directory: string): Promise<StoredNovelMetadata | null> {
  const { body } = await workMetadataOperation({ operation: "read", path: `${directory}/novel.json` });
  if (!body) return null;
  return { directory, metadata: parseNovelMetadata(JSON.parse(new TextDecoder().decode(base64ToBytes(body)))) };
}

export async function writeStoredNovelMetadata(directory: string, input: NovelMetadataV1, notifyChanges = true): Promise<void> {
  const metadata = parseNovelMetadata(input);
  const current = await readNovelMetadataForReplacement(directory, metadata.identity);
  if (current && JSON.stringify(current.metadata) === JSON.stringify(metadata)) return;
  await workMetadataOperation({ operation: "write", path: `${directory}/novel.json`, body: bytesToBase64(new TextEncoder().encode(JSON.stringify(metadata, null, 2))) });
  if (notifyChanges) notifyWorkMetadataChanges();
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
  const manifest = { ...metadata.cover, version: 1, sourceId: metadata.identity.pluginId, novelPath: metadata.identity.novelPath };
  const sidecar = await workMetadataOperation({ operation: "write", path: `${directory}/cover.json`, body: bytesToBase64(new TextEncoder().encode(JSON.stringify(manifest))) });
  const changed = Boolean(cover.changed || sidecar.changed);
  if (notifyChanges && changed) {
    const { invalidateAllNovelCoverSources } = await import("./novel-cover-storage");
    invalidateAllNovelCoverSources();
    notifyWorkMetadataChanges();
  }
  return changed;
}

export async function installStoredNovelMetadata(input: NovelMetadataV1, coverBytes?: Uint8Array, beforeInstall?: (current: StoredNovelMetadata | null) => Promise<void | false>): Promise<StoredNovelMetadata | null> {
  const metadata = parseNovelMetadata(input);
  const { runDatabaseTransaction } = await import("../db/client");
  const { applyNovelMetadataToCache, knownNovelMetadataDirectory, rememberStoredNovelMetadata } = await import("../db/work-metadata");
  return runWorkContentStorageOperation(metadata.identity.pluginId, metadata.identity.novelPath, async () => {
    const preferred = knownNovelMetadataDirectory(metadata.identity) ?? await availableNovelMetadataDirectory(metadata);
    const installed = await runDatabaseTransaction(async (db) => {
      const directory = knownNovelMetadataDirectory(metadata.identity) ?? preferred;
      const existing = await readNovelMetadataForReplacement(directory, metadata.identity);
      if (await beforeInstall?.(existing) === false) return null;
      return withWorkMetadataRollback(async () => {
        if (coverBytes) await writeStoredNovelCover(directory, metadata, coverBytes, false);
        else await removeStoredNovelCover(directory, existing?.metadata.cover ?? metadata.cover, false);
        await writeStoredNovelMetadata(directory, metadata, false);
        const installedNovelId = await applyNovelMetadataToCache(db, metadata, directory);
        await db.execute("DELETE FROM work_metadata_dirty WHERE plugin_id=$1 AND path=$2", [metadata.identity.pluginId, metadata.identity.novelPath]);
        await rememberStoredNovelMetadata(db, directory, metadata, true);
        return { novelId: installedNovelId, directory };
      });
    }, true);
    if (!installed) return null;
    const { notifyNovelCoverChanged } = await import("./novel-cover-storage");
    notifyNovelCoverChanged(installed.novelId);
    return { directory: installed.directory, metadata };
  });
}

export async function removeStoredNovelCover(directory: string, cover: NovelMetadataV1["cover"], notifyChanges = true): Promise<void> {
  await workMetadataOperation({ operation: "remove", path: `${directory}/cover.json` });
  if (cover) await workMetadataOperation({ operation: "remove", path: `${directory}/${cover.fileName}` });
  if (notifyChanges) {
    const { invalidateAllNovelCoverSources } = await import("./novel-cover-storage");
    invalidateAllNovelCoverSources();
    notifyWorkMetadataChanges();
  }
}

export async function persistNovelCover(directory: string, cover: { body: Uint8Array; fileName: string; sourceUrl: string; contentType: string }): Promise<void> {
  const { runDatabaseTransaction } = await import("../db/client");
  const { rememberStoredNovelMetadata } = await import("../db/work-metadata");
  await runDatabaseTransaction((db) => withWorkMetadataRollback(async () => {
    const { body } = await workMetadataOperation({ operation: "read", path: `${directory}/novel.json` });
    if (!body) throw new Error("work metadata: missing work for cover");
    const metadata = parseNovelMetadata(JSON.parse(new TextDecoder().decode(base64ToBytes(body))));
    metadata.cover = { fileName: cover.fileName, sourceUrl: cover.sourceUrl, contentType: cover.contentType };
    const coverChanged = await writeStoredNovelCover(directory, metadata, cover.body);
    await writeStoredNovelMetadata(directory, metadata);
    await rememberStoredNovelMetadata(db, directory, metadata, coverChanged);
  }));
}
