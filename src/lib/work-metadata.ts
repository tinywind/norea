import { invoke } from "@tauri-apps/api/core";
import { androidWorkMetadataOperation } from "./android-storage";
import { bytesToBase64, base64ToBytes } from "./base64";
import { novelStorageRelativeDir } from "./chapter-storage-path";
import { isAndroidRuntime, isTauriRuntime } from "./tauri-runtime";
import { MAX_NOVEL_COVER_BYTES, parseNovelMetadata, safeMetadataChild, type NovelMetadataV1 } from "./work-metadata/schema";
export { parseNovelMetadata, type NovelMetadataV1 } from "./work-metadata/schema";

export interface StoredNovelMetadata { directory: string; metadata: NovelMetadataV1 }
export interface WorkMetadataOperation {
  operation: "list" | "read" | "write" | "remove" | "register";
  path?: string;
  body?: string;
  chapterDirectories?: Record<string, string>;
  reset?: boolean;
}
export interface WorkMetadataOperationResult { paths?: string[]; body?: string | null }
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
  const existing = parseNovelMetadata(JSON.parse(new TextDecoder().decode(base64ToBytes(body))));
  if (existing.identity.pluginId === metadata.identity.pluginId && existing.identity.novelPath === metadata.identity.novelPath) return preferred;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([metadata.identity.pluginId, metadata.identity.novelPath])));
  const segments = preferred.split("/");
  segments[2] = `${segments[2]!.slice(0, 150)}-${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return segments.join("/");
}

export async function workMetadataOperation(input: WorkMetadataOperation): Promise<WorkMetadataOperationResult> {
  if (input.path) {
    const segments = input.path.split("/");
    if (segments.length !== 4 || segments[0] !== "contents" || !segments.every(safeMetadataChild)) throw new Error("work metadata: invalid storage path");
  }
  if (publicationSnapshots && input.path && (input.operation === "write" || input.operation === "remove") && !publicationSnapshots.has(input.path)) {
    const previous = await rawWorkMetadataOperation({ operation: "read", path: input.path });
    publicationSnapshots.set(input.path, previous.body ?? null);
  }
  return rawWorkMetadataOperation(input);
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
    catch (error) { throw new Error(`work metadata: invalid ${path}`, { cause: error }); }
    const identity = JSON.stringify(metadata.identity);
    if (identities.has(identity)) throw new Error(`work metadata: duplicate work ${path}`);
    identities.add(identity);
    entries.push({ directory: path.slice(0, -"/novel.json".length), metadata });
  }
  return entries;
}

export async function writeStoredNovelMetadata(directory: string, input: NovelMetadataV1): Promise<void> {
  const metadata = parseNovelMetadata(input);
  await workMetadataOperation({ operation: "write", path: `${directory}/novel.json`, body: bytesToBase64(new TextEncoder().encode(JSON.stringify(metadata, null, 2))) });
  notifyWorkMetadataChanges();
}

export async function readStoredNovelCover(directory: string, metadata: NovelMetadataV1): Promise<Uint8Array | null> {
  if (!metadata.cover) return null;
  const { body } = await workMetadataOperation({ operation: "read", path: `${directory}/${metadata.cover.fileName}` });
  if (!body) return null;
  const bytes = base64ToBytes(body);
  if (bytes.length > MAX_NOVEL_COVER_BYTES) throw new Error("work metadata: cover exceeds size limit");
  return bytes;
}

export async function writeStoredNovelCover(directory: string, metadata: NovelMetadataV1, bytes: Uint8Array): Promise<void> {
  parseNovelMetadata(metadata);
  if (!metadata.cover || !bytes.length || bytes.length > MAX_NOVEL_COVER_BYTES) throw new Error("work metadata: invalid cover bytes");
  await workMetadataOperation({ operation: "write", path: `${directory}/${metadata.cover.fileName}`, body: bytesToBase64(bytes) });
  const manifest = { ...metadata.cover, version: 1, sourceId: metadata.identity.pluginId, novelPath: metadata.identity.novelPath, updatedAt: metadata.updatedAt };
  await workMetadataOperation({ operation: "write", path: `${directory}/cover.json`, body: bytesToBase64(new TextEncoder().encode(JSON.stringify(manifest))) });
  const { invalidateAllNovelCoverSources } = await import("./novel-cover-storage");
  invalidateAllNovelCoverSources();
  notifyWorkMetadataChanges();
}

export async function installStoredNovelMetadata(input: NovelMetadataV1, coverBytes?: Uint8Array, beforeInstall?: () => Promise<void>): Promise<void> {
  const metadata = parseNovelMetadata(input);
  const { runDatabaseTransaction } = await import("../db/client");
  const { applyNovelMetadataToCache, rememberStoredNovelMetadata } = await import("../db/work-metadata");
  await runDatabaseTransaction(async (db) => {
    await beforeInstall?.();
    const existing = (await listStoredNovelMetadata()).find((entry) => entry.metadata.identity.pluginId === metadata.identity.pluginId && entry.metadata.identity.novelPath === metadata.identity.novelPath);
    const directory = existing?.directory ?? await availableNovelMetadataDirectory(metadata);
    await withWorkMetadataRollback(async () => {
      if (coverBytes) await writeStoredNovelCover(directory, metadata, coverBytes);
      else await removeStoredNovelCover(directory, existing?.metadata.cover ?? metadata.cover);
      await writeStoredNovelMetadata(directory, metadata);
      await applyNovelMetadataToCache(db, metadata, directory);
      await db.execute("DELETE FROM work_metadata_dirty WHERE plugin_id=$1 AND path=$2", [metadata.identity.pluginId, metadata.identity.novelPath]);
      rememberStoredNovelMetadata(directory, metadata);
    });
  }, true);
}

export async function removeStoredNovelCover(directory: string, cover: NovelMetadataV1["cover"]): Promise<void> {
  await workMetadataOperation({ operation: "remove", path: `${directory}/cover.json` });
  if (cover) await workMetadataOperation({ operation: "remove", path: `${directory}/${cover.fileName}` });
  const { invalidateAllNovelCoverSources } = await import("./novel-cover-storage");
  invalidateAllNovelCoverSources();
  notifyWorkMetadataChanges();
}

export async function persistNovelCover(directory: string, cover: { body: Uint8Array; fileName: string; sourceUrl: string; contentType: string }): Promise<void> {
  const { runDatabaseTransaction } = await import("../db/client");
  const { rememberStoredNovelMetadata } = await import("../db/work-metadata");
  await runDatabaseTransaction(() => withWorkMetadataRollback(async () => {
    const { body } = await workMetadataOperation({ operation: "read", path: `${directory}/novel.json` });
    if (!body) throw new Error("work metadata: missing work for cover");
    const metadata = parseNovelMetadata(JSON.parse(new TextDecoder().decode(base64ToBytes(body))));
    metadata.cover = { fileName: cover.fileName, sourceUrl: cover.sourceUrl, contentType: cover.contentType };
    metadata.updatedAt = Date.now();
    await writeStoredNovelCover(directory, metadata, cover.body);
    await writeStoredNovelMetadata(directory, metadata);
    rememberStoredNovelMetadata(directory, metadata);
  }));
}
