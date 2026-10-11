import {
  contentIdentity, importContentMetadata, listContentSyncChapters,
  markContentInstalled, readContentSyncCache, writeContentSyncCache, type ContentSyncChapter,
  contentJournalHead, readContentJournal,
} from "../../db/queries/content-sync";
import { useContentSyncStore } from "../../store/content-sync";
import { chapterStorageRelativeDir } from "../chapter-storage-path";
import { resolvedChapterStorageDir } from "../chapter-storage-resolution";
import {
  contentServerRequest, normalizeContentServerUrl, ContentServerError, type ContentCatalogPage,
} from "./client";
import { downloadContentChapter, fingerprintContentChapter, uploadContentChapter, type CatalogEntry } from "./native";
import { registerContentDevice } from "./device";
import { runContentStorageOperation } from "./storage-operation";

interface CatalogCache {
  cursor: number;
  entries: Record<string, CatalogEntry>;
  uploaded: Record<string, string>;
  downloads: Record<string, boolean>;
  excluded: string[];
  pendingUploads: string[];
  localCursor?: number;
}
async function readCache<T>(key: string, fallback: T): Promise<T> {
  const value = await readContentSyncCache(key);
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
function saveCache(key: string, value: unknown): Promise<void> { return writeContentSyncCache(key, JSON.stringify(value)); }
function catalogCache(server: string): Promise<CatalogCache> {
  return readCache(`norea-content-catalog:${server}`, { cursor: 0, entries: {}, uploaded: {}, downloads: {}, excluded: [], pendingUploads: [] });
}
function saveCatalog(server: string, cache: CatalogCache): Promise<void> { return saveCache(`norea-content-catalog:${server}`, cache); }
function identity(row: ContentSyncChapter): string { return contentIdentity(row.pluginId, row.novelPath, row.chapterPath); }
function entryIdentity(entry: CatalogEntry): string {
  const { pluginId, novelPath, chapterPath } = entry.manifest.identity;
  return contentIdentity(pluginId, novelPath, chapterPath);
}
function storageDir(row: ContentSyncChapter): string {
  return resolvedChapterStorageDir(row.chapterId) ?? chapterStorageRelativeDir(
    { id: row.novelId, pluginId: row.pluginId, path: row.novelPath, name: row.novelName },
    { id: row.chapterId, name: row.chapterName, chapterNumber: row.chapterNumber, position: row.position },
  );
}
async function contentFingerprint(row: ContentSyncChapter): Promise<string> {
  return JSON.stringify([await fingerprintContentChapter({ storageDir: storageDir(row) }),
    row.novelName, row.author, row.summary, row.chapterName, row.chapterNumber, row.position, row.page, row.contentType]);
}
function assertDevice(server: string, token: string | null): void {
  const current = useContentSyncStore.getState();
  if (current.serverUrl !== server || current.deviceKey !== token) throw new Error("Content server changed during synchronization.");
}
async function publishCatalog(server: string, cache: CatalogCache): Promise<void> {
  await saveCatalog(server, cache);
  if (useContentSyncStore.getState().serverUrl === server) useContentSyncStore.setState({ catalog: Object.values(cache.entries) });
}
async function pullCatalog(server: string, token: string | null, cache: CatalogCache): Promise<void> {
  let more = true;
  while (more) {
    const page = await contentServerRequest<ContentCatalogPage>(server, `/chapters?after=${cache.cursor}&limit=100`, token ?? undefined);
    assertDevice(server, token);
    if (page.hasMore && page.cursor <= cache.cursor) throw new Error("Content catalog cursor did not advance.");
    for (const entry of page.items) {
      if (!entry.deleted) await importContentMetadata(entry.manifest);
      cache.entries[entry.id] = entry;
    }
    cache.cursor = page.cursor;
    await publishCatalog(server, cache);
    more = page.hasMore;
  }
}

async function uploadLocalContent(server: string, token: string, cache: CatalogCache, rescan: boolean): Promise<void> {
  const head = await contentJournalHead();
  const changes = cache.localCursor === undefined || rescan ? null
    : await readContentJournal(cache.localCursor, head);
  const changedIds = changes?.filter((entry) => entry.key.startsWith("content:")).map((entry) => entry.key.slice(8));
  const requested = changedIds ? [...new Set([...changedIds, ...cache.pendingUploads])] : undefined;
  const rows = await listContentSyncChapters(requested);
  const remoteByIdentity = new Map(Object.values(cache.entries).map((entry) => [entryIdentity(entry), entry]));
  for (const id of requested ?? rows.map(identity)) {
    if (!cache.pendingUploads.includes(id)) cache.pendingUploads.push(id);
  }
  cache.localCursor = head;
  await saveCatalog(server, cache);
  for (const id of [...cache.pendingUploads]) {
    assertDevice(server, token);
    const row = rows.find((item) => identity(item) === id);
    if (!row || !row.isDownloaded || row.mediaRepairNeeded || remoteByIdentity.get(id)?.deleted) {
      if (cache.downloads[id] && !row?.isDownloaded && !cache.excluded.includes(id)) cache.excluded.push(id);
      delete cache.downloads[id];
      cache.pendingUploads = cache.pendingUploads.filter((item) => item !== id);
      continue;
    }
    const fingerprint = await contentFingerprint(row);
    assertDevice(server, token);
    if (cache.uploaded[id] !== fingerprint) {
      await uploadContentChapter({
        serverUrl: server, token, chapterId: row.chapterId, storageDir: storageDir(row),
        manifest: { packageVersion: 1, identity: { pluginId: row.pluginId, novelPath: row.novelPath, chapterPath: row.chapterPath },
          novel: { name: row.novelName, author: row.author, summary: row.summary, isLocal: row.isLocal },
          chapter: { name: row.chapterName, position: row.position, chapterNumber: row.chapterNumber, page: row.page, contentType: row.contentType } },
      });
      assertDevice(server, token);
      cache.uploaded[id] = fingerprint;
    }
    cache.downloads[id] = true;
    cache.pendingUploads = cache.pendingUploads.filter((item) => item !== id);
    await saveCatalog(server, cache);
  }
  await saveCatalog(server, cache);
}

let running: Promise<void> | null = null;
function reserveContentSync(operation: () => Promise<void>): Promise<void> {
  const previous = running ?? Promise.resolve();
  const reserved = previous.catch(() => undefined).then(() => runContentStorageOperation(operation)).finally(() => {
    if (running === reserved) running = null;
  });
  running = reserved;
  return reserved;
}

async function initializeDevice(serverUrl: string): Promise<string> {
  const deviceKey = await registerContentDevice(serverUrl, useContentSyncStore.getState().deviceName);
  if (useContentSyncStore.getState().serverUrl !== serverUrl) throw new Error("Content server changed during device registration.");
  useContentSyncStore.setState({ deviceKey });
  return deviceKey;
}

async function performSyncWithStorage(uploadContent = true, rescan = false): Promise<void> {
  const { serverUrl } = useContentSyncStore.getState();
  if (!serverUrl) return;
  useContentSyncStore.setState({ status: "syncing", error: null, blocked: false });
  try {
    normalizeContentServerUrl(serverUrl);
    const token = await initializeDevice(serverUrl);
    const cache = await catalogCache(serverUrl);
    assertDevice(serverUrl, token);
    useContentSyncStore.setState({ catalog: Object.values(cache.entries) });
    await pullCatalog(serverUrl, token, cache);
    if (uploadContent) {
      await uploadLocalContent(serverUrl, token, cache, rescan);
      await pullCatalog(serverUrl, token, cache);
    }
    assertDevice(serverUrl, token);
    useContentSyncStore.setState({ status: "idle" });
  } catch (error) {
    if (useContentSyncStore.getState().serverUrl === serverUrl) {
      useContentSyncStore.setState({ status: "error", error: error instanceof Error ? error.message : String(error), blocked: error instanceof ContentServerError && error.status === 403 });
    }
    throw error;
  }
}

export function syncContentServer(uploadContent = true, rescan = false): Promise<void> {
  if (running) return running;
  return reserveContentSync(() => performSyncWithStorage(uploadContent, rescan));
}

export async function downloadServerChapter(entry: CatalogEntry): Promise<{ novelId: number; chapterId: number }> {
  return runContentStorageOperation(() => downloadServerChapterWithStorage(entry));
}

async function downloadServerChapterWithStorage(entry: CatalogEntry): Promise<{ novelId: number; chapterId: number }> {
  if (entry.deleted) throw new Error("Deleted server chapters cannot be downloaded.");
  const { serverUrl } = useContentSyncStore.getState();
  const token = await initializeDevice(serverUrl);
  const mapping = await importContentMetadata(entry.manifest);
  const row = (await listContentSyncChapters([entryIdentity(entry)])).find((item) => item.chapterId === mapping.chapterId);
  if (!row) throw new Error("Downloaded chapter metadata is missing.");
  const result = await downloadContentChapter({ serverUrl, token: token ?? undefined, entry, storageDir: storageDir(row), chapterId: mapping.chapterId });
  await markContentInstalled(mapping.chapterId, entry.manifest.chapter.contentType, result.contentBytes, result.mediaBytes);
  const cache = await catalogCache(serverUrl);
  const id = entryIdentity(entry);
  cache.excluded = cache.excluded.filter((item) => item !== id);
  cache.downloads[id] = true;
  cache.uploaded[id] = await contentFingerprint({ ...row, contentType: entry.manifest.chapter.contentType });
  await saveCatalog(serverUrl, cache);
  window.dispatchEvent(new Event("norea-content-state-changed"));
  return mapping;
}

async function mutateServerChapter(entry: CatalogEntry, restore: boolean): Promise<void> {
  const { serverUrl } = useContentSyncStore.getState();
  const token = await initializeDevice(serverUrl);
  await contentServerRequest(serverUrl, `/chapters/${encodeURIComponent(entry.id)}${restore ? "/restore" : ""}`, token, restore ? "POST" : "DELETE");
  await syncContentServer();
}
export function deleteServerChapter(entry: CatalogEntry): Promise<void> { return mutateServerChapter(entry, false); }
export function restoreServerChapter(entry: CatalogEntry): Promise<void> { return mutateServerChapter(entry, true); }

export async function getContentSyncCursors(): Promise<{ catalogCursor: number }> {
  const { serverUrl } = useContentSyncStore.getState();
  return { catalogCursor: (await catalogCache(serverUrl)).cursor };
}
