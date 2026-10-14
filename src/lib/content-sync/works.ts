import { canonicalMetadataValue } from "../work-metadata/schema";
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { readContentSyncCache, writeContentSyncCache } from "../../db/queries/content-sync";
import { readWorkMetadataSyncFiles, storedNovelMetadataFingerprint, type WorkMetadataSyncFile } from "../../db/work-metadata";
import { installStoredNovelMetadata, parseNovelMetadata, readStoredNovelMetadata, readStoredNovelCover, type NovelMetadataV1 } from "../work-metadata";
import { contentServerRequest, ContentServerError, normalizeContentServerUrl } from "./client";

export interface WorkCatalogEntry { id: string; sequence: number; metadata: NovelMetadataV1; hasCover: boolean; deleted?: boolean }
interface WorkCatalogPage { items: WorkCatalogEntry[]; cursor: number; hasMore: boolean }
interface WorkSyncCache { cursor: number; fingerprints: Record<string, string>; fileVersions: Record<string, string>; deleted: Record<string, boolean> }
const MAX_COVER_BYTES = 10 * 1024 * 1024;
const cacheKey = (server: string) => `norea-content-works:${server}`;
const identityKey = (identity: NovelMetadataV1["identity"]) => JSON.stringify([identity.pluginId, identity.novelPath]);
const fileVersion = (file: WorkMetadataSyncFile) => JSON.stringify([file.directory, file.fingerprint, file.revision]);

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
    let more = true;
    while (more) {
      const page = await contentServerRequest<WorkCatalogPage>(server, `/works?after=${cache.cursor}&limit=100`, token);
      assertCurrent();
      if (page.hasMore && page.cursor <= cache.cursor) throw new Error("Work catalog cursor did not advance.");
      for (const entry of page.items) {
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
          if (cache.fingerprints[entry.id] !== expectedFingerprint) continue;
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
        const installedMetadata = metadata;
        assertCurrent();
        const incomingFingerprint = await workMetadataFingerprint(installedMetadata, cover);
        if (incomingFingerprint === expectedFingerprint) {
          if (file) cache.fileVersions[identity] = fileVersion(file);
          continue;
        }
        const stored = await installStoredNovelMetadata(installedMetadata, cover ?? undefined, async (latest) => {
          if (!isCurrent()) return false;
          const latestFingerprint = latest ? await workMetadataFingerprint(latest.metadata, await readStoredNovelCover(latest.directory, latest.metadata)) : null;
          if (!isCurrent() || latestFingerprint !== expectedFingerprint) return false;
        });
        assertCurrent();
        if (!stored) continue;
        // Installation advances this revision once; a concurrent local write remains newer.
        const installedFile = { pluginId: metadata.identity.pluginId, path: metadata.identity.novelPath, directory: stored.directory,
          fingerprint: await storedNovelMetadataFingerprint(stored.metadata), revision: (file?.revision ?? 0) + 1 };
        byIdentity.set(identity, installedFile);
        cache.fileVersions[identity] = fileVersion(installedFile);
        if (!entry.hasCover && stored.metadata.cover) delete cache.fileVersions[identity];
        installed = true;
        cache.fingerprints[entry.id] = incomingFingerprint;
      }
      dirty ||= cache.cursor !== page.cursor;
      cache.cursor = page.cursor;
      await checkpoint();
      more = page.hasMore;
    }
    if (!upload) return new Set(Object.keys(cache.deleted));
    let uploaded = 0;
    for (const [identity, file] of byIdentity) {
      const version = fileVersion(file);
      const id = await contentWorkId({ pluginId: file.pluginId, novelPath: file.path });
      if (cache.deleted[id] && !rescan) continue;
      if (!rescan && cache.fileVersions[identity] === version) continue;
      const latest = await readStoredNovelMetadata(file.directory);
      if (!latest) { cache.fileVersions[identity] = version; dirty = true; continue; }
      const { metadata } = latest;
      const cover = await readStoredNovelCover(file.directory, metadata);
      const current = await workMetadataFingerprint(metadata, cover);
      if (!rescan && cache.fingerprints[id] === current) { cache.fileVersions[identity] = version; dirty = true; continue; }
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
