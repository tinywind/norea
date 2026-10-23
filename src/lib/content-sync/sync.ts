import {
  contentIdentity, importContentMetadata, listContentSyncChapters, listContentSyncWorkChapters,
  markContentInstalled, readContentSyncCache, writeContentSyncCache, type ContentSyncChapter,
  contentJournalHead, readContentJournal, canUploadContentChapter,
} from "../../db/queries/content-sync";
import { useContentSyncStore } from "../../store/content-sync";
import { chapterStorageRelativeDir } from "../chapter-storage-path";
import { resolvedChapterStorageDir } from "../chapter-storage-resolution";
import {
  contentServerRequest, normalizeContentServerUrl, ContentServerError,
} from "./client";
import { withDownloadedContentChapter, fingerprintContentChapter, uploadContentChapter, withContentChapterStage, type CatalogEntry, type ContentIdentity, type UploadConflictPolicy } from "./native";
import { withChapterDownloadWrite } from "../chapter-download-writes";
import { watchChapterDownloadActivity } from "../tasks/chapter-download-activity";
import { registerContentDevice } from "./device";
import { runWorkContentStorageOperation } from "./storage-operation";
import { contentWorkId, getWorkSyncCursor, syncWorkMetadata } from "./works";

interface CatalogCache {
  cursor: number;
  tombstones: Record<string, boolean>;
  uploaded: Record<string, string>;
  downloads: Record<string, boolean>;
  excluded: string[];
  pendingUploads: string[];
  localCursor?: number;
  uploadConflictPolicy?: UploadConflictPolicy;
}
interface CatalogChangesPage { items: { identity: ContentIdentity; deleted: boolean; complete: boolean; sequence: number }[]; cursor: number; hasMore: boolean }
function saveCache(key: string, value: unknown): Promise<void> { return writeContentSyncCache(key, JSON.stringify(value)); }
async function catalogCache(server: string): Promise<CatalogCache> {
  const saved = await readContentSyncCache(`norea-content-catalog:${server}`);
  return saved ? JSON.parse(saved) as CatalogCache : { cursor: 0, tombstones: {}, uploaded: {}, downloads: {}, excluded: [], pendingUploads: [] };
}
function saveCatalog(server: string, cache: CatalogCache): Promise<void> { return saveCache(`norea-content-catalog:${server}`, cache); }
function identity(row: ContentSyncChapter): string { return contentIdentity(row.pluginId, row.novelPath, row.chapterPath); }
function storageDir(row: ContentSyncChapter): string {
  return resolvedChapterStorageDir(row.chapterId) ?? chapterStorageRelativeDir(
    { id: row.novelId, pluginId: row.pluginId, path: row.novelPath, sourceNovelId: row.sourceNovelId, name: row.novelName },
    { id: row.chapterId, name: row.chapterName, chapterNumber: row.chapterNumber, position: row.position },
  );
}
async function contentFingerprint(row: ContentSyncChapter, stagePath: string): Promise<string> {
  return JSON.stringify([await fingerprintContentChapter({ storageDir: storageDir(row), stagePath }),
    row.novelName, row.author, row.summary, row.chapterName, row.chapterNumber, row.position, row.page, row.contentType]);
}
async function findUploadedChapter(server: string, token: string, row: Pick<ContentSyncChapter, "pluginId" | "novelPath" | "chapterPath" | "chapterNumber" | "sourceNovelId">, signal?: AbortSignal): Promise<CatalogEntry | null> {
  const local = { pluginId: row.pluginId, novelPath: row.novelPath, chapterPath: row.chapterPath };
  const recovered = /^norea-folder:(\d+(?:\.\d+)?)$/.exec(row.chapterPath);
  const chapterNumber = row.chapterNumber ?? recovered?.[1];
  let entry: CatalogEntry;
  try {
    const query = new URLSearchParams({ ...local, ...(chapterNumber && /^\d+(?:\.\d+)?$/.test(chapterNumber) ? { chapterNumber } : {}) });
    entry = await contentServerRequest<CatalogEntry>(server, `/catalog/chapter?${query}`, token, "GET", undefined, signal);
  } catch (error) {
    if (error instanceof ContentServerError && error.status === 404) return null;
    throw error;
  }
  const remote = entry.manifest.identity;
  const sameChapter = remote.chapterPath === row.chapterPath ||
    ((recovered || /^norea-folder:\d+(?:\.\d+)?$/.test(remote.chapterPath)) &&
      entry.manifest.chapter.chapterNumber != null && Number(entry.manifest.chapter.chapterNumber) === Number(chapterNumber));
  if (entry.deleted || remote.pluginId !== row.pluginId || remote.novelPath !== row.novelPath || remote.novelId !== row.sourceNovelId ||
    !remote.chapterPath || !sameChapter) {
    throw new Error("Content server upload identity does not match the requested chapter.");
  }
  return entry;
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

async function uploadLocalContent(server: string, token: string, cache: CatalogCache, rescan: boolean, deletedWorks: ReadonlySet<string>, conflictPolicy: UploadConflictPolicy): Promise<void> {
  const head = await contentJournalHead();
  const changes = cache.localCursor === undefined || rescan || cache.uploadConflictPolicy !== conflictPolicy ? null
    : await readContentJournal(cache.localCursor, head);
  const changedIds = changes?.filter((entry) => entry.key.startsWith("content:")).map((entry) => entry.key.slice(8));
  const requested = changedIds ? [...new Set([...changedIds, ...cache.pendingUploads])] : undefined;
  const changedRows = await listContentSyncChapters(requested, requested === undefined);
  const deletedIds = Object.keys(cache.tombstones);
  // Deletion deltas omit chapter numbers, so recheck the work to resolve folder aliases.
  const recheckWorks = [...new Set(deletedIds.map(id => JSON.stringify((JSON.parse(id) as string[]).slice(0, 2))))];
  const recheckRows = recheckWorks.length ? await listContentSyncWorkChapters(recheckWorks) : [];
  const rows = [...changedRows, ...recheckRows];
  const rowsByIdentity = new Map(rows.map(row => [identity(row), row]));
  const deletedLocalWorks = new Set<string>();
  if (deletedWorks.size) {
    for (const row of new Map(rows.map(row => [JSON.stringify([row.pluginId, row.novelPath]), row])).values()) {
      if (deletedWorks.has(await contentWorkId({ pluginId: row.pluginId, novelPath: row.novelPath }))) deletedLocalWorks.add(JSON.stringify([row.pluginId, row.novelPath]));
    }
  }
  const pending = new Set([...cache.pendingUploads, ...(requested ?? rowsByIdentity.keys()), ...recheckRows.map(identity)]);
  if (!pending.size && cache.localCursor === head && !deletedIds.length) return;
  cache.pendingUploads = [...pending];
  cache.localCursor = head;
  cache.uploadConflictPolicy = conflictPolicy;
  cache.tombstones = {};
  await saveCatalog(server, cache);
  let processed = 0;
  let uploaded = 0;
  const total = pending.size;
  const failures: string[] = [];
  const reportProgress = () => useContentSyncStore.setState({ progress: { completed: processed, total, uploaded, failed: failures.length } });
  reportProgress();
  try {
    for (const id of pending) {
      assertDevice(server, token);
      const row = rowsByIdentity.get(id);
      if (row?.isDownloadQueued) {
        processed++;
        reportProgress();
        continue;
      }
      if (!row || !row.isDownloaded || row.mediaRepairNeeded || deletedLocalWorks.has(JSON.stringify([row.pluginId, row.novelPath]))) {
        if (cache.downloads[id] && !row?.isDownloaded && !cache.excluded.includes(id)) cache.excluded.push(id);
        delete cache.downloads[id];
        pending.delete(id);
        processed++;
        reportProgress();
        continue;
      }
      const activity = watchChapterDownloadActivity(row.chapterId);
      try {
        activity.signal.throwIfAborted();
        if (!await canUploadContentChapter(row.chapterId)) continue;
        activity.signal.throwIfAborted();
        const existing = await findUploadedChapter(server, token, row, activity.signal);
        activity.signal.throwIfAborted();
        assertDevice(server, token);
        if (existing && (conflictPolicy === "keep-server" || (conflictPolicy === "prefer-complete" && existing.complete))) {
          cache.downloads[id] = true;
          pending.delete(id);
          continue;
        }
        await withContentChapterStage({ storageDir: storageDir(row), identity: { pluginId: row.pluginId, novelPath: row.novelPath }, signal: activity.signal }, async stagePath => {
          activity.signal.throwIfAborted();
          const fingerprint = await contentFingerprint(row, stagePath);
          assertDevice(server, token);
          if (!await canUploadContentChapter(row.chapterId)) return;
          activity.signal.throwIfAborted();
          await uploadContentChapter({
            serverUrl: server, token, chapterId: row.chapterId, storageDir: storageDir(row), stagePath, signal: activity.signal, conflictPolicy,
            manifest: { packageVersion: 1, identity: { pluginId: row.pluginId, novelId: row.sourceNovelId!, novelPath: row.novelPath, chapterPath: row.chapterPath },
              novel: { name: row.novelName, author: row.author, summary: row.summary, isLocal: row.isLocal },
              chapter: { name: row.chapterName, position: row.position, chapterNumber: row.chapterNumber, page: row.page, contentType: row.contentType } },
          });
          activity.signal.throwIfAborted();
          assertDevice(server, token);
          cache.uploaded[id] = fingerprint;
          uploaded++;
          cache.downloads[id] = true;
          pending.delete(id);
        });
      } catch (error) {
        if (error instanceof ContentServerError && (error.status === 401 || error.status === 403)) throw error;
        if (activity.signal.aborted) continue;
        assertDevice(server, token);
        failures.push(`${row.novelName} / ${row.chapterName}: ${error instanceof Error ? error.message : String(error)}`);
        useContentSyncStore.setState({ error: failures.at(-1) });
      } finally {
        activity.dispose();
        processed++;
        reportProgress();
        if (processed % 25 === 0) {
          cache.pendingUploads = [...pending];
          await saveCatalog(server, cache);
        }
      }
    }
  } finally {
    cache.pendingUploads = [...pending];
    await saveCatalog(server, cache);
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

let running: Promise<void> | null = null;
let pendingSync: { uploadContent: boolean; rescan: boolean } | null = null;

async function initializeDevice(serverUrl: string): Promise<string> {
  const deviceKey = await registerContentDevice(serverUrl, useContentSyncStore.getState().deviceName);
  if (useContentSyncStore.getState().serverUrl !== serverUrl) throw new Error("Content server changed during device registration.");
  useContentSyncStore.setState({ deviceKey });
  return deviceKey;
}

async function performSync(uploadContent = true, rescan = false): Promise<void> {
  const { serverUrl, uploadConflictPolicy } = useContentSyncStore.getState();
  if (!serverUrl) return;
  useContentSyncStore.setState({ status: "syncing", error: null, blocked: false, progress: null });
  try {
    normalizeContentServerUrl(serverUrl);
    const token = await initializeDevice(serverUrl);
    const cache = await catalogCache(serverUrl);
    assertDevice(serverUrl, token);
    const deletedWorks = await syncWorkMetadata(serverUrl, token, uploadContent, () => assertDevice(serverUrl, token), rescan);
    await pullCatalog(serverUrl, token, cache);
    if (uploadContent) {
      await uploadLocalContent(serverUrl, token, cache, rescan, deletedWorks ?? new Set(), uploadConflictPolicy);
      await pullCatalog(serverUrl, token, cache);
      if (Object.keys(cache.tombstones).length) {
        // Handle deletions consumed after the first upload phase without another catalog loop.
        await uploadLocalContent(serverUrl, token, cache, false, deletedWorks ?? new Set(), uploadConflictPolicy);
      }
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
  if (pendingSync && running) {
    pendingSync.uploadContent ||= uploadContent;
    pendingSync.rescan ||= rescan;
    return running;
  }
  const requested = { uploadContent, rescan };
  pendingSync = requested;
  const previous = running ?? Promise.resolve();
  const reserved = previous.catch(() => undefined).then(() => {
    pendingSync = null;
    return performSync(requested.uploadContent, requested.rescan);
  }).finally(() => {
    if (running === reserved) running = null;
  });
  running = reserved;
  return reserved;
}

export async function downloadServerChapter(entry: CatalogEntry): Promise<{ novelId: number; chapterId: number }> {
  return downloadServerChapterFromServer(entry, useContentSyncStore.getState().serverUrl);
}

export async function downloadServerChapterFromServer(entry: CatalogEntry, serverUrl: string, options?: { token: string; target: ContentIdentity; signal?: AbortSignal }): Promise<{ novelId: number; chapterId: number }> {
  options?.signal?.throwIfAborted();
  if (entry.deleted) throw new Error("Deleted server chapters cannot be downloaded.");
  if (!entry.complete) throw new Error("Incomplete server chapters cannot be downloaded.");
  const token = options?.token ?? await registerContentDevice(serverUrl, useContentSyncStore.getState().deviceName);
  const target = options?.target ?? entry.manifest.identity;
  const imported = options ? undefined : await importContentMetadata(entry.manifest);
  const findTarget = async () => {
    const row = (await listContentSyncChapters([contentIdentity(target.pluginId, target.novelPath, target.chapterPath)]))
      .find((item) => !imported || item.chapterId === imported.chapterId);
    if (!row) throw new Error("Downloaded chapter metadata is missing.");
    if (entry.manifest.identity.novelId !== row.sourceNovelId) throw new Error("Server chapter novel ID does not match the local work.");
    return row;
  };
  const row = await findTarget();
  return withDownloadedContentChapter({ serverUrl, token, entry, storageDir: storageDir(row), chapterId: row.chapterId, ...(options?.signal ? { signal: options.signal } : {}) }, (result, install) =>
    runWorkContentStorageOperation(target.pluginId, target.novelPath, async () => {
      options?.signal?.throwIfAborted();
      const current = await findTarget();
      options?.signal?.throwIfAborted();
      await withChapterDownloadWrite(current.chapterId, options?.signal, async () => {
        await install(storageDir(current));
        await markContentInstalled(current.chapterId, entry.manifest.chapter.contentType, result.contentBytes, result.mediaBytes);
      });
      return { novelId: current.novelId, chapterId: current.chapterId };
    }));
}

async function mutateServerChapter(entry: CatalogEntry, restore: boolean): Promise<void> {
  const { serverUrl } = useContentSyncStore.getState();
  const token = await initializeDevice(serverUrl);
  await contentServerRequest(serverUrl, `/chapters/${encodeURIComponent(entry.id)}${restore ? "/restore" : ""}`, token, restore ? "POST" : "DELETE");
}
export function deleteServerChapter(entry: CatalogEntry): Promise<void> { return mutateServerChapter(entry, false); }
export function restoreServerChapter(entry: CatalogEntry): Promise<void> { return mutateServerChapter(entry, true); }

export async function getContentSyncCursors(): Promise<{ catalogCursor: number; workCursor: number }> {
  const { serverUrl } = useContentSyncStore.getState();
  return { catalogCursor: (await catalogCache(serverUrl)).cursor, workCursor: await getWorkSyncCursor(serverUrl) };
}
