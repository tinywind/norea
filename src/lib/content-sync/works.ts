import { canonicalMetadataValue } from "../work-metadata/schema";
import { mergeIncomingNovelMetadata } from "../work-metadata/merge";
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { readContentSyncCache, writeContentSyncCache } from "../../db/queries/content-sync";
import { readWorkMetadataSyncFile, readWorkMetadataSyncFiles, type WorkMetadataSyncFile } from "../../db/work-metadata";
import { installStoredNovelMetadata, parseNovelMetadata, readStoredNovelMetadata, readStoredNovelCover, type InstalledNovelMetadata, type NovelMetadataV1 } from "../work-metadata";
import { contentServerRequest, ContentServerError, normalizeContentServerUrl } from "./client";

export interface WorkCatalogEntry { id: string; sequence: number; metadata: NovelMetadataV1; hasCover: boolean; deleted?: boolean }
interface WorkCatalogPage { items: WorkCatalogEntry[]; cursor: number; hasMore: boolean }
interface WorkSyncCache { cursor: number; fingerprints: Record<string, string>; fileVersions: Record<string, string>; deleted: Record<string, boolean> }
const MAX_COVER_BYTES = 10 * 1024 * 1024;
const workSyncQueues = new Map<string, Promise<unknown>>();
const cacheKey = (server: string) => `norea-content-works:${server}`;
const identityKey = (identity: NovelMetadataV1["identity"]) => JSON.stringify([identity.pluginId, identity.novelPath]);
export const workMetadataFileVersion = (file: WorkMetadataSyncFile | null | undefined): string | null => file ? JSON.stringify([file.directory, file.fingerprint, file.revision]) : null;

function matchesSyncedWork(cache: WorkSyncCache, id: string, file: WorkMetadataSyncFile, fingerprint: string): boolean {
  return cache.fingerprints[id] === fingerprint && cache.fileVersions[JSON.stringify([file.pluginId, file.path])] === workMetadataFileVersion(file);
}

export async function canPullWorkMetadata(server: string, file: WorkMetadataSyncFile | null, fingerprint: string): Promise<boolean> {
  if (!file) return false;
  return matchesSyncedWork(await readCache(server), await contentWorkId({ pluginId: file.pluginId, novelPath: file.path }), file, fingerprint);
}

export async function runWorkMetadataSyncOperation<T>(server: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const key = normalizeContentServerUrl(server);
  const queued: Promise<T> = (workSyncQueues.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => {
    signal?.throwIfAborted();
    return operation();
  }).finally(() => { if (workSyncQueues.get(key) === queued) workSyncQueues.delete(key); });
  workSyncQueues.set(key, queued);
  if (!signal) return queued;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    queued.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

async function hash(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function contentWorkId(identity: NovelMetadataV1["identity"]): Promise<string> {
  return hash(new TextEncoder().encode(JSON.stringify([identity.pluginId, identity.novelPath])));
}

export async function workMetadataFingerprint(metadata: NovelMetadataV1, cover: Uint8Array | null): Promise<string> {
  return hash(new TextEncoder().encode(JSON.stringify([canonicalMetadataValue(metadata), cover ? await hash(cover) : null])));
}
async function readCache(server: string): Promise<WorkSyncCache> {
  const saved = await readContentSyncCache(cacheKey(server));
  return saved ? JSON.parse(saved) as WorkSyncCache : { cursor: 0, fingerprints: {}, fileVersions: {}, deleted: {} };
}
async function saveCache(server: string, cache: WorkSyncCache): Promise<void> {
  await writeContentSyncCache(cacheKey(server), JSON.stringify(cache));
}
export async function getWorkSyncCursor(server: string): Promise<number> { return (await readCache(server)).cursor; }

export async function recordDeletedWorkMetadata(server: string, entry: WorkCatalogEntry): Promise<void> {
  const metadata = parseNovelMetadata(entry.metadata);
  if (!entry.deleted || await contentWorkId(metadata.identity) !== entry.id) {
    throw new Error("Server work deletion does not match its metadata.");
  }
  const cache = await readCache(server);
  cache.deleted[entry.id] = true;
  delete cache.fingerprints[entry.id];
  delete cache.fileVersions[identityKey(metadata.identity)];
  await saveCache(server, cache);
}

async function rememberInstalledWork(cache: WorkSyncCache, stored: InstalledNovelMetadata, hasServerCover: boolean): Promise<void> {
  const id = await contentWorkId(stored.metadata.identity);
  const identity = identityKey(stored.metadata.identity);
  cache.fingerprints[id] = await workMetadataFingerprint(stored.metadata, stored.coverBytes);
  if (!hasServerCover && stored.coverBytes) delete cache.fileVersions[identity];
  else cache.fileVersions[identity] = workMetadataFileVersion(stored.syncFile)!;
  delete cache.deleted[id];
}

export async function recordInstalledWorkMetadata(server: string, stored: InstalledNovelMetadata, hasServerCover: boolean): Promise<void> {
  const cache = await readCache(server);
  await rememberInstalledWork(cache, stored, hasServerCover);
  await saveCache(server, cache);
}

async function coverRequest(server: string, id: string, token: string, body?: Uint8Array, contentType?: string | null): Promise<Uint8Array | null> {
  if (body && body.byteLength > MAX_COVER_BYTES) throw new Error("Work cover exceeds the 10 MiB limit.");
  const response = await nativeFetch(`${normalizeContentServerUrl(server)}/api/v1/works/${encodeURIComponent(id)}/cover`, {
    method: body ? "PUT" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": contentType || "application/octet-stream" } : {}) },
    ...(body ? { body: Uint8Array.from(body).buffer } : {}),
    maxRedirections: 0, connectTimeout: 10_000, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new ContentServerError(response.status);
  if (body) return null;
  if (Number(response.headers.get("content-length")) > MAX_COVER_BYTES) throw new Error("Work cover exceeds the 10 MiB limit.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_COVER_BYTES) throw new Error("Work cover is empty or exceeds the 10 MiB limit.");
  return bytes;
}

export async function syncWorkMetadata(server: string, token: string, upload: boolean, assertCurrent: () => void = () => undefined, rescan = false): Promise<ReadonlySet<string>> {
  return runWorkMetadataSyncOperation(server, () => performWorkMetadataSync(server, token, upload, assertCurrent, rescan));
}

async function performWorkMetadataSync(server: string, token: string, upload: boolean, assertCurrent: () => void, rescan: boolean): Promise<ReadonlySet<string>> {
  assertCurrent();
  let installed = false;
  const cache = await readCache(server);
  let dirty = false;
  const checkpoint = async () => {
    if (!dirty) return;
    await saveCache(server, cache);
    dirty = false;
  };
  const isCurrent = () => {
    try { assertCurrent(); return true; }
    catch { return false; }
  };
  try {
    const local = await readWorkMetadataSyncFiles(rescan);
    const byIdentity = new Map(local.map(entry => [JSON.stringify([entry.pluginId, entry.path]), entry]));
    const latestById = new Map<string, WorkCatalogEntry>();
    let cursor = cache.cursor;
    let more = true;
    while (more) {
      const page = await contentServerRequest<WorkCatalogPage>(server, `/works?after=${cursor}&limit=100`, token);
      assertCurrent();
      if (page.hasMore && page.cursor <= cursor) throw new Error("Work catalog cursor did not advance.");
      for (const entry of page.items) latestById.set(entry.id, entry);
      cursor = page.cursor;
      more = page.hasMore;
    }
    for (const entry of latestById.values()) {
      const metadata = parseNovelMetadata(entry.metadata);
      if (await contentWorkId(metadata.identity) !== entry.id) throw new Error("Server work identity does not match its metadata.");
      dirty = true;
      const identity = identityKey(metadata.identity);
      if (entry.deleted) {
        cache.deleted[entry.id] = true;
        delete cache.fingerprints[entry.id];
        delete cache.fileVersions[identity];
        continue;
      }
      delete cache.deleted[entry.id];
      const file = byIdentity.get(identity);
      const current = file ? await readStoredNovelMetadata(file.directory) : null;
      let expectedFingerprint: string | null = null;
      if (current) {
        expectedFingerprint = await workMetadataFingerprint(current.metadata, await readStoredNovelCover(current.directory, current.metadata));
        if (!file || !matchesSyncedWork(cache, entry.id, file, expectedFingerprint)) continue;
      }
      let cover: Uint8Array | null;
      try { cover = entry.hasCover ? await coverRequest(server, entry.id, token) : null; }
      catch (error) {
        if (error instanceof ContentServerError && error.status === 404) {
          try { await contentServerRequest<WorkCatalogEntry>(server, `/works/${entry.id}`, token); }
          catch (currentError) {
            if (currentError instanceof ContentServerError && currentError.status === 404) {
              cache.deleted[entry.id] = true;
              delete cache.fingerprints[entry.id]; delete cache.fileVersions[identity];
              continue;
            }
            throw currentError;
          }
        }
        throw error;
      }
      const installedMetadata = mergeIncomingNovelMetadata(current?.metadata, metadata);
      assertCurrent();
      const incomingFingerprint = await workMetadataFingerprint(installedMetadata, cover);
      if (incomingFingerprint === expectedFingerprint) {
        if (file) cache.fileVersions[identity] = workMetadataFileVersion(file)!;
        continue;
      }
      const stored = await installStoredNovelMetadata(installedMetadata, cover ?? undefined, async (latest, db) => {
        if (!isCurrent()) return false;
        const latestFingerprint = latest ? await workMetadataFingerprint(latest.metadata, await readStoredNovelCover(latest.directory, latest.metadata)) : null;
        if (!isCurrent() || latestFingerprint !== expectedFingerprint) return false;
        const latestFile = await readWorkMetadataSyncFile(metadata.identity, db);
        if (!isCurrent() || workMetadataFileVersion(latestFile) !== workMetadataFileVersion(file)) return false;
      });
      assertCurrent();
      if (!stored) continue;
      byIdentity.set(identity, stored.syncFile);
      await rememberInstalledWork(cache, stored, entry.hasCover);
      installed = true;
    }
    dirty ||= cache.cursor !== cursor;
    cache.cursor = cursor;
    await checkpoint();
    if (!upload) return new Set(Object.keys(cache.deleted));
    let uploaded = 0;
    for (const [identity, file] of byIdentity) {
      const version = workMetadataFileVersion(file)!;
      const id = await contentWorkId({ pluginId: file.pluginId, novelPath: file.path });
      if (cache.deleted[id] && !rescan) continue;
      if (!rescan && cache.fileVersions[identity] === version) continue;
      const latest = await readStoredNovelMetadata(file.directory);
      if (!latest) { cache.fileVersions[identity] = version; dirty = true; continue; }
      const { metadata } = latest;
      const cover = await readStoredNovelCover(file.directory, metadata);
      const current = await workMetadataFingerprint(metadata, cover);
      assertCurrent();
      try {
        await contentServerRequest<WorkCatalogEntry>(server, `/works/${id}${rescan && cache.deleted[id] ? "?restore=true" : ""}`, token, "PUT", metadata);
      } catch (error) {
        if (error instanceof ContentServerError && error.status === 410) { cache.deleted[id] = true; dirty = true; continue; }
        throw error;
      }
      assertCurrent();
      if (cover) await coverRequest(server, id, token, cover, metadata.cover?.contentType);
      assertCurrent();
      cache.fingerprints[id] = current;
      delete cache.deleted[id];
      cache.fileVersions[identity] = version;
      dirty = true;
      if (++uploaded % 25 === 0) await checkpoint();
    }
    return new Set(Object.keys(cache.deleted));
  } finally {
    await checkpoint();
    if (installed && typeof window !== "undefined") window.dispatchEvent(new Event("norea-content-state-changed"));
  }
}
