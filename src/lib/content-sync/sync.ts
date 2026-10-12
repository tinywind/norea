import {
  contentIdentity, importContentMetadata, listContentSyncChapters,
  markContentInstalled, readContentSyncStateCache, writeContentSyncCache, type ContentSyncChapter,
  contentJournalHead, readContentJournal,
} from "../../db/queries/content-sync";
import { useContentSyncStore } from "../../store/content-sync";
import { chapterStorageRelativeDir } from "../chapter-storage-path";
import { resolvedChapterStorageDir } from "../chapter-storage-resolution";
import {
  contentServerRequest, normalizeContentServerUrl, ContentServerError,
} from "./client";
import { downloadContentChapter, fingerprintContentChapter, uploadContentChapter, type CatalogEntry, type ContentIdentity } from "./native";
import { registerContentDevice } from "./device";
import { runWorkContentStorageOperation } from "./storage-operation";
import { getWorkSyncCursor, syncWorkMetadata } from "./works";

interface CatalogCache {
  cursor: number;
  tombstones: Record<string, boolean>;
  uploaded: Record<string, string>;
  downloads: Record<string, boolean>;
  excluded: string[];
  pendingUploads: string[];
  localCursor?: number;
}
interface CatalogChangesPage { items: { identity: ContentIdentity; deleted: boolean; sequence: number }[]; cursor: number; hasMore: boolean }
function saveCache(key: string, value: unknown): Promise<void> { return writeContentSyncCache(key, JSON.stringify(value)); }
async function catalogCache(server: string): Promise<CatalogCache> {
  const saved = await readContentSyncStateCache(`norea-content-catalog:${server}`, "catalog");
  const parsed = saved ? JSON.parse(saved) as Partial<CatalogCache> : {};
  return { cursor: parsed.cursor ?? 0, tombstones: parsed.tombstones ?? {}, uploaded: parsed.uploaded ?? {},
    downloads: parsed.downloads ?? {}, excluded: parsed.excluded ?? [], pendingUploads: parsed.pendingUploads ?? [], localCursor: parsed.localCursor ?? undefined };
}
function saveCatalog(server: string, cache: CatalogCache): Promise<void> { return saveCache(`norea-content-catalog:${server}`, cache); }
function identity(row: ContentSyncChapter): string { return contentIdentity(row.pluginId, row.novelPath, row.chapterPath); }
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
async function uploadIdentity(server: string, token: string, row: ContentSyncChapter): Promise<ContentIdentity> {
  const local = { pluginId: row.pluginId, novelPath: row.novelPath, chapterPath: row.chapterPath };
  const recovered = /^norea-folder:(\d+(?:\.\d+)?)$/.exec(row.chapterPath);
  const chapterNumber = row.chapterNumber ?? recovered?.[1];
  if (!chapterNumber || !/^\d+(?:\.\d+)?$/.test(chapterNumber)) return local;
  let entry: CatalogEntry;
  try {
    const query = new URLSearchParams({ ...local, chapterNumber });
    entry = await contentServerRequest<CatalogEntry>(server, `/catalog/chapter?${query}`, token);
  } catch (error) {
    if (error instanceof ContentServerError && error.status === 404) return local;
    throw error;
  }
  const remote = entry.manifest.identity;
  const sameChapter = remote.chapterPath === row.chapterPath ||
    ((recovered || /^norea-folder:\d+(?:\.\d+)?$/.test(remote.chapterPath)) &&
      entry.manifest.chapter.chapterNumber != null && Number(entry.manifest.chapter.chapterNumber) === Number(chapterNumber));
  if (entry.deleted || remote.pluginId !== row.pluginId || remote.novelPath !== row.novelPath ||
    !remote.chapterPath || !sameChapter) {
    throw new Error("Content server upload identity does not match the requested chapter.");
  }
  return remote;
}
function assertDevice(server: string, token: string | null): void {
  const current = useContentSyncStore.getState();
  if (current.serverUrl !== server || current.deviceKey !== token) throw new Error("Content server changed during synchronization.");
}
async function pullCatalog(server: string, token: string | null, cache: CatalogCache): Promise<void> {
  let more = true;
  let pending = 0;
  let changed = false;
  try {
    while (more) {
      const page = await contentServerRequest<CatalogChangesPage>(server, `/catalog/changes?after=${cache.cursor}&limit=100`, token ?? undefined);
      assertDevice(server, token);
      if (page.hasMore && page.cursor <= cache.cursor) throw new Error("Content catalog cursor did not advance.");
      changed ||= page.items.length > 0 || cache.cursor !== page.cursor;
      for (const entry of page.items) {
        const id = contentIdentity(entry.identity.pluginId, entry.identity.novelPath, entry.identity.chapterPath);
        if (entry.deleted) cache.tombstones[id] = true;
        else delete cache.tombstones[id];
      }
      cache.cursor = page.cursor;
      pending += page.items.length;
      if (pending >= 5000) { await saveCatalog(server, cache); pending = 0; }
      more = page.hasMore;
    }
  } finally {
    if (changed) await saveCatalog(server, cache);
  }
}

async function uploadLocalContent(server: string, token: string, cache: CatalogCache, rescan: boolean): Promise<void> {
  const head = await contentJournalHead();
  const changes = cache.localCursor === undefined || rescan ? null
    : await readContentJournal(cache.localCursor, head);
  const changedIds = changes?.filter((entry) => entry.key.startsWith("content:")).map((entry) => entry.key.slice(8));
  const requested = changedIds ? [...new Set([...changedIds, ...cache.pendingUploads])] : undefined;
  const rows = await listContentSyncChapters(requested, requested === undefined);
  const rowsByIdentity = new Map(rows.map(row => [identity(row), row]));
  const pending = new Set([...cache.pendingUploads, ...(requested ?? rowsByIdentity.keys())]);
  if (!pending.size && cache.localCursor === head) return;
  cache.pendingUploads = [...pending];
  cache.localCursor = head;
  await saveCatalog(server, cache);
  let processed = 0;
  const failures: string[] = [];
  try {
    for (const id of pending) {
      assertDevice(server, token);
      const row = rowsByIdentity.get(id);
      if (!row || !row.isDownloaded || row.mediaRepairNeeded || cache.tombstones[id]) {
        if (cache.downloads[id] && !row?.isDownloaded && !cache.excluded.includes(id)) cache.excluded.push(id);
        delete cache.downloads[id];
        pending.delete(id);
        continue;
      }
      try {
        await runWorkContentStorageOperation(row.pluginId, row.novelPath, async () => {
          const target = await uploadIdentity(server, token, row);
          assertDevice(server, token);
          const fingerprint = await contentFingerprint(row);
          assertDevice(server, token);
          if (cache.uploaded[id] !== fingerprint) {
            await uploadContentChapter({
              serverUrl: server, token, chapterId: row.chapterId, storageDir: storageDir(row),
              manifest: { packageVersion: 1, identity: target,
                novel: { name: row.novelName, author: row.author, summary: row.summary, isLocal: row.isLocal },
                chapter: { name: row.chapterName, position: row.position, chapterNumber: row.chapterNumber, page: row.page, contentType: row.contentType } },
            });
            assertDevice(server, token);
            cache.uploaded[id] = fingerprint;
          }
          cache.downloads[id] = true;
          pending.delete(id);
        });
      } catch (error) {
        assertDevice(server, token);
        if (error instanceof ContentServerError && (error.status === 401 || error.status === 403)) throw error;
        failures.push(`${row.novelName} / ${row.chapterName}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (++processed % 5000 === 0) {
        cache.pendingUploads = [...pending];
        await saveCatalog(server, cache);
      }
    }
  } finally {
    cache.pendingUploads = [...pending];
    await saveCatalog(server, cache);
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

let running: Promise<void> | null = null;
function reserveContentSync(operation: () => Promise<void>): Promise<void> {
  const previous = running ?? Promise.resolve();
  const reserved = previous.catch(() => undefined).then(operation).finally(() => {
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

async function performSync(uploadContent = true, rescan = false): Promise<void> {
  const { serverUrl } = useContentSyncStore.getState();
  if (!serverUrl) return;
  useContentSyncStore.setState({ status: "syncing", error: null, blocked: false });
  try {
    normalizeContentServerUrl(serverUrl);
    const token = await initializeDevice(serverUrl);
    const cache = await catalogCache(serverUrl);
    assertDevice(serverUrl, token);
    await syncWorkMetadata(serverUrl, token, uploadContent, () => assertDevice(serverUrl, token));
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
  return reserveContentSync(() => performSync(uploadContent, rescan));
}

export async function downloadServerChapter(entry: CatalogEntry): Promise<{ novelId: number; chapterId: number }> {
  return downloadServerChapterFromServer(entry, useContentSyncStore.getState().serverUrl);
}

export async function downloadServerChapterFromServer(entry: CatalogEntry, serverUrl: string, options?: { token: string; target: ContentIdentity }): Promise<{ novelId: number; chapterId: number }> {
  if (entry.deleted) throw new Error("Deleted server chapters cannot be downloaded.");
  const token = options?.token ?? await registerContentDevice(serverUrl, useContentSyncStore.getState().deviceName);
  const target = options?.target ?? entry.manifest.identity;
  return runWorkContentStorageOperation(target.pluginId, target.novelPath, async () => {
    const imported = options ? undefined : await importContentMetadata(entry.manifest);
    const row = (await listContentSyncChapters([contentIdentity(target.pluginId, target.novelPath, target.chapterPath)]))
      .find((item) => !imported || item.chapterId === imported.chapterId);
    if (!row) throw new Error("Downloaded chapter metadata is missing.");
    const mapping = { novelId: row.novelId, chapterId: row.chapterId };
    const result = await downloadContentChapter({ serverUrl, token, entry, storageDir: storageDir(row), chapterId: mapping.chapterId });
    await markContentInstalled(mapping.chapterId, entry.manifest.chapter.contentType, result.contentBytes, result.mediaBytes);
    return mapping;
  });
}

async function mutateServerChapter(entry: CatalogEntry, restore: boolean): Promise<void> {
  const { serverUrl } = useContentSyncStore.getState();
  const token = await initializeDevice(serverUrl);
  await contentServerRequest(serverUrl, `/chapters/${encodeURIComponent(entry.id)}${restore ? "/restore" : ""}`, token, restore ? "POST" : "DELETE");
  await syncContentServer();
}
export function deleteServerChapter(entry: CatalogEntry): Promise<void> { return mutateServerChapter(entry, false); }
export function restoreServerChapter(entry: CatalogEntry): Promise<void> { return mutateServerChapter(entry, true); }

export async function getContentSyncCursors(): Promise<{ catalogCursor: number; workCursor: number }> {
  const { serverUrl } = useContentSyncStore.getState();
  return { catalogCursor: (await catalogCache(serverUrl)).cursor, workCursor: await getWorkSyncCursor(serverUrl) };
}
