import {
  contentIdentity, importContentMetadata, listContentSyncChapters, listContentSyncWorkChapters, listUntrackedContentSyncChapters,
  markContentInstalled, readContentSyncCache, writeContentSyncCache, type ContentSyncChapter,
  contentJournalHead, readContentJournal, canUploadContentChapter, clearServerChapterDownloadProof, rememberServerChapterDownload,
} from "../../db/queries/content-sync";
import { hasStoredChapterContent } from "../../db/queries/chapter";
import { useContentSyncStore } from "../../store/content-sync";
import { finalizePendingNovelMigrations } from "./novel-migration";
import { reconcileCompletedNovelMigrations } from "./completed-novel-migration";
import { syncIncomingNovelMigrations, PendingIncomingMigrationError, type IncomingMigrationSyncResult } from "./migration-feed";
import { reconcilePendingChapterNumbers } from "./chapter-number-reconciliation";
import { chapterStorageRelativeDir } from "../chapter-storage-path";
import { inspectChapterPayloadInventory } from "../chapter-content/storage-platform";
import { resolvedChapterStorageDir } from "../chapter-storage-resolution";
import {
  contentServerRequest, normalizeContentServerUrl, ContentServerError,
} from "./client";
import { withDownloadedContentChapter, fingerprintContentChapter, uploadContentChapter, withContentChapterStage, type CatalogEntry, type ContentIdentity, type UploadConflictPolicy } from "./native";
import { currentChapterDownloadRevision, withChapterDownloadWrite } from "../chapter-download-writes";
import { watchChapterDownloadActivity } from "../tasks/chapter-download-activity";
import { registerContentDevice } from "./device";
import { runWorkContentStorageOperation } from "./storage-operation";
import { contentWorkId, getWorkSyncCursor, syncWorkMetadata, WorkMetadataChangedOutsideCacheError } from "./works";
import { readServerChapterDeletionExclusions, serverChapterDeletionKey, serverWorkDeletionKey, setServerChapterDeletionExclusion, withServerWorkDeletionExclusions, waitForServerWorkDeletion } from "./deletion-exclusions";

const LOCAL_CONTENT_DISCOVERY_VERSION = 1;

interface CatalogCache {
  cursor: number;
  tombstones: Record<string, boolean>;
  uploaded: Record<string, string>;
  downloads: Record<string, boolean>;
  excluded: string[];
  pendingUploads: string[];
  localCursor?: number;
  uploadConflictPolicy?: UploadConflictPolicy;
  includesIncompleteChapters?: boolean;
  localDiscoveryVersion?: number;
}
interface CatalogChangesPage { items: { identity: ContentIdentity; deleted: boolean; complete: boolean; sequence: number }[]; cursor: number; hasMore: boolean }
function saveCache(key: string, value: unknown): Promise<void> { return writeContentSyncCache(key, JSON.stringify(value)); }
async function catalogCache(server: string): Promise<CatalogCache> {
  const saved = await readContentSyncCache(`norea-content-catalog:${server}`);
  return saved ? JSON.parse(saved) as CatalogCache : { cursor: 0, tombstones: {}, uploaded: {}, downloads: {}, excluded: [], pendingUploads: [] };
}
function saveCatalog(server: string, cache: CatalogCache): Promise<void> { return saveCache(`norea-content-catalog:${server}`, cache); }
const UPLOADED_FINGERPRINT_DIGEST = /^[0-9a-f]{64}$/;
async function digestHex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
/**
 * The catalog is parsed and rewritten whole several times per synchronization pass. A stored
 * package fingerprint lists every chapter file and repeats the novel summary, so keep its digest.
 */
async function compactUploadedFingerprints(cache: CatalogCache): Promise<boolean> {
  const expanded = Object.entries(cache.uploaded).filter(([, fingerprint]) => !UPLOADED_FINGERPRINT_DIGEST.test(fingerprint));
  await Promise.all(expanded.map(async ([id, fingerprint]) => { cache.uploaded[id] = await digestHex(fingerprint); }));
  return expanded.length > 0;
}
function identity(row: ContentSyncChapter): string { return contentIdentity(row.pluginId, row.novelPath, row.chapterPath); }
function storageDir(row: ContentSyncChapter): string {
  return resolvedChapterStorageDir(row.chapterId) ?? chapterStorageRelativeDir(
    { id: row.novelId, pluginId: row.pluginId, path: row.novelPath, sourceNovelId: row.sourceNovelId, name: row.novelName },
    { id: row.chapterId, name: row.chapterName, chapterNumber: row.chapterNumber, position: row.position },
  );
}
async function contentFingerprint(row: ContentSyncChapter, stagePath: string): Promise<string> {
  return digestHex(JSON.stringify([await fingerprintContentChapter({ storageDir: storageDir(row), stagePath }),
    row.novelName, row.author, row.summary, row.chapterName, row.chapterNumber, row.position, row.page, row.contentType]));
}
interface UploadChapterLookup {
  entry: CatalogEntry;
  available: boolean;
}
async function findUploadedChapter(server: string, token: string, row: Pick<ContentSyncChapter, "pluginId" | "novelPath" | "chapterPath" | "chapterNumber" | "sourceNovelId">, signal?: AbortSignal): Promise<UploadChapterLookup | null> {
  const local = { pluginId: row.pluginId, novelPath: row.novelPath, chapterPath: row.chapterPath };
  const recovered = /^norea-folder:(\d+(?:\.\d+)?)$/.exec(row.chapterPath);
  const chapterNumber = row.chapterNumber ?? recovered?.[1];
  const query = new URLSearchParams({ ...local, ...(chapterNumber && /^\d+(?:\.\d+)?$/.test(chapterNumber) ? { chapterNumber } : {}) });
  let entry: CatalogEntry;
  let available = true;
  try {
    entry = await contentServerRequest<CatalogEntry>(server, `/catalog/chapter?${query}`, token, "GET", undefined, signal);
  } catch (error) {
    if (!(error instanceof ContentServerError) || error.status !== 404) throw error;
    query.set("includeUnavailable", "true");
    try {
      entry = await contentServerRequest<CatalogEntry>(server, `/catalog/chapter?${query}`, token, "GET", undefined, signal);
    } catch (lookupError) {
      if (lookupError instanceof ContentServerError && lookupError.status === 404) return null;
      throw lookupError;
    }
    available = false;
  }
  const remote = entry.manifest.identity;
  const sameChapter = remote.chapterPath === row.chapterPath ||
    ((recovered || /^norea-folder:\d+(?:\.\d+)?$/.test(remote.chapterPath)) &&
      entry.manifest.chapter.chapterNumber != null && Number(entry.manifest.chapter.chapterNumber) === Number(chapterNumber));
  // Unavailable lookups exclude explicit deletions but may retain a missing-file catalog marker.
  if ((available && entry.deleted) || remote.pluginId !== row.pluginId || remote.novelPath !== row.novelPath || remote.novelId !== row.sourceNovelId ||
    !remote.chapterPath || !sameChapter) {
    throw new Error("Content server upload identity does not match the requested chapter.");
  }
  return { entry, available };
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
  return withServerWorkDeletionExclusions(server, async deletedDirectories => {
    const isDeletedWork = (row: ContentSyncChapter) => row.sourceNovelId != null && deletedDirectories.has(serverWorkDeletionKey({ pluginId: row.pluginId, novelId: row.sourceNovelId }));
    const deletions = await readServerChapterDeletionExclusions(server);
    const head = await contentJournalHead();
    // Delta journaling can only see mutations that happened after the journal existed
    // and while its triggers were enabled. Older installs, recovered storage, and past
    // remote-origin repairs may therefore contain durable chapter files with no journal
    // row at all. Each discovery-version bump performs one full, byte-independent local
    // reconciliation, then returns to journal-only discovery on subsequent syncs.
    const needsLocalDiscovery = cache.localDiscoveryVersion !== LOCAL_CONTENT_DISCOVERY_VERSION;
    const canUseJournal = cache.includesIncompleteChapters && cache.localCursor !== undefined &&
      !rescan && cache.uploadConflictPolicy === conflictPolicy;
    const changes = canUseJournal ? await readContentJournal(cache.localCursor!, head) : null;
    const changedIds = changes?.filter((entry) => entry.key.startsWith("content:")).map((entry) => entry.key.slice(8));
    const requested = changedIds ? [...new Set([...changedIds, ...cache.pendingUploads])] : undefined;
    // A local discovery-version upgrade only needs chapters absent from this
    // server's durable download cache. Resolve that set in SQLite: on a large
    // library this avoids serializing tens of thousands of already-known rows
    // over the native bridge before discarding them in JavaScript. Journal
    // changes and durable retries are still loaded explicitly so an upgrade
    // cannot hide a fresh mutation of an already-known chapter.
    const discoveryOnly = needsLocalDiscovery && canUseJournal;
    const changedRows = discoveryOnly
      ? await listUntrackedContentSyncChapters(server)
      : await listContentSyncChapters(requested, requested === undefined);
    const targetedRows = discoveryOnly && requested?.length
      ? await listContentSyncChapters(requested)
      : [];
    const discoveredRows = [...new Map([...changedRows, ...targetedRows].map(row => [identity(row), row])).values()];
    const deletedIds = Object.keys(cache.tombstones);
    // Deletion deltas omit chapter numbers, so recheck the work to resolve folder aliases.
    const recheckWorks = [...new Set(deletedIds.map(id => JSON.stringify((JSON.parse(id) as string[]).slice(0, 2))))];
    const recheckRows = recheckWorks.length ? await listContentSyncWorkChapters(recheckWorks) : [];
    const rows = [...discoveredRows, ...recheckRows];
    const rowsByIdentity = new Map(rows.map(row => [identity(row), row]));
    const deletedLocalWorks = new Set<string>();
    if (deletedWorks.size) {
      for (const row of new Map(rows.map(row => [JSON.stringify([row.pluginId, row.novelPath]), row])).values()) {
        if (deletedWorks.has(await contentWorkId({ pluginId: row.pluginId, novelPath: row.novelPath }))) deletedLocalWorks.add(JSON.stringify([row.pluginId, row.novelPath]));
      }
    }
    const pending = new Set([
      ...cache.pendingUploads,
      ...(discoveryOnly ? discoveredRows.map(identity) : (requested ?? rowsByIdentity.keys())),
      ...recheckRows.map(identity),
    ]);
    if (!pending.size && cache.includesIncompleteChapters && cache.localCursor === head && !deletedIds.length) {
      if (needsLocalDiscovery) {
        cache.localDiscoveryVersion = LOCAL_CONTENT_DISCOVERY_VERSION;
        await saveCatalog(server, cache);
      }
      return;
    }
    cache.pendingUploads = [...pending];
    cache.localCursor = head;
    cache.uploadConflictPolicy = conflictPolicy;
    cache.includesIncompleteChapters = true;
    cache.localDiscoveryVersion = LOCAL_CONTENT_DISCOVERY_VERSION;
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
        const workId = row ? await contentWorkId({ pluginId: row.pluginId, novelPath: row.novelPath }) : null;
        if (workId) await waitForServerWorkDeletion(server, workId);
        if (row?.isDownloadQueued && !isDeletedWork(row)) {
          processed++;
          reportProgress();
          continue;
        }
        if (!row || !hasStoredChapterContent(row) || isDeletedWork(row) || deletedLocalWorks.has(JSON.stringify([row.pluginId, row.novelPath]))
          || (row.sourceNovelId != null && deletions.has(serverChapterDeletionKey({ pluginId: row.pluginId, novelId: row.sourceNovelId, chapterPath: row.chapterPath }, row.chapterNumber)))) {
          if (cache.downloads[id] && (!row || !hasStoredChapterContent(row)) && !cache.excluded.includes(id)) cache.excluded.push(id);
          delete cache.downloads[id];
          if (row && isDeletedWork(row)) delete cache.uploaded[id];
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
          const lookup = await findUploadedChapter(server, token, row, activity.signal);
          const existing = lookup?.entry;
          activity.signal.throwIfAborted();
          assertDevice(server, token);
          await waitForServerWorkDeletion(server, workId!);
          if (isDeletedWork(row)) continue;
          if (lookup?.available && existing && (conflictPolicy === "keep-server" || (conflictPolicy === "prefer-complete" && existing.complete))) {
            cache.downloads[id] = true;
            pending.delete(id);
            continue;
          }
          await withContentChapterStage({ storageDir: storageDir(row), identity: { pluginId: row.pluginId, novelPath: row.novelPath }, signal: activity.signal }, async stagePath => {
            activity.signal.throwIfAborted();
            const fingerprint = await contentFingerprint(row, stagePath);
            assertDevice(server, token);
            await waitForServerWorkDeletion(server, workId!);
            if (!await canUploadContentChapter(row.chapterId) || isDeletedWork(row)) return;
            activity.signal.throwIfAborted();
            await uploadContentChapter({
              serverUrl: server, token, chapterId: row.chapterId, storageDir: storageDir(row), stagePath, signal: activity.signal, conflictPolicy,
              manifest: { packageVersion: 1, identity: { pluginId: row.pluginId, novelId: row.sourceNovelId!, novelPath: row.novelPath,
                  chapterPath: existing?.manifest.identity.chapterPath.startsWith("norea-folder:") ? existing.manifest.identity.chapterPath : row.chapterPath },
                novel: { name: row.novelName, author: row.author, summary: row.summary, isLocal: row.isLocal },
                chapter: { name: row.chapterName, position: row.position, chapterNumber: row.chapterNumber, page: row.page, contentType: row.contentType } },
            });
            activity.signal.throwIfAborted();
            assertDevice(server, token);
            await waitForServerWorkDeletion(server, workId!);
            if (isDeletedWork(row)) return;
            cache.uploaded[id] = fingerprint;
            uploaded++;
            cache.downloads[id] = true;
            pending.delete(id);
          });
        } catch (error) {
          if (error instanceof ContentServerError && (error.status === 401 || error.status === 403)) throw error;
          await waitForServerWorkDeletion(server, workId!);
          if (activity.signal.aborted || isDeletedWork(row)) continue;
          assertDevice(server, token);
          failures.push(`${row.novelName} / ${row.chapterName}: ${error instanceof Error ? error.message : String(error)}`);
          useContentSyncStore.setState({ error: failures.at(-1) });
        } finally {
          activity.dispose();
          if (isDeletedWork(row)) {
            pending.delete(id);
            delete cache.downloads[id];
            delete cache.uploaded[id];
          }
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
  });
}

let running: Promise<void> | null = null;
let pendingSync: {
  uploadContent: boolean;
  rescan: boolean;
  retryBlockedMigrations: boolean;
  promise: Promise<void>;
} | null = null;

export function runContentSyncOperation<T>(operation: () => Promise<T>): Promise<T> {
  const waiting = new AbortController();
  const timer = setTimeout(() => waiting.abort(new Error("Timed out waiting for content synchronization. Retry after synchronization finishes.")), 30_000);
  let rejectWait: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    rejectWait = () => reject(waiting.signal.reason);
    waiting.signal.addEventListener("abort", rejectWait, { once: true });
  });
  const result = (running ?? Promise.resolve()).catch(() => undefined).then(() => {
    clearTimeout(timer);
    waiting.signal.removeEventListener("abort", rejectWait);
    waiting.signal.throwIfAborted();
    return operation();
  });
  const reserved = result.then(() => undefined, () => undefined).finally(() => {
    if (running === reserved) running = null;
  });
  running = reserved;
  return Promise.race([result, interrupted]);
}

async function initializeDevice(serverUrl: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const deviceKey = await registerContentDevice(serverUrl, useContentSyncStore.getState().deviceName, signal);
  signal?.throwIfAborted();
  if (useContentSyncStore.getState().serverUrl !== serverUrl) throw new Error("Content server changed during device registration.");
  useContentSyncStore.setState({ deviceKey });
  return deviceKey;
}

async function performSync(uploadContent = true, rescan = false, retryBlockedMigrations = true): Promise<void> {
  const { serverUrl, uploadConflictPolicy } = useContentSyncStore.getState();
  if (!serverUrl) return;
  useContentSyncStore.setState({ status: "syncing", error: null, blocked: false, progress: null });
  try {
    normalizeContentServerUrl(serverUrl);
    const token = await initializeDevice(serverUrl);
    await reconcileCompletedNovelMigrations(serverUrl, token, () => assertDevice(serverUrl, token));
    let incoming = await syncIncomingNovelMigrations(serverUrl, token, () => assertDevice(serverUrl, token), retryBlockedMigrations);
    await reconcilePendingChapterNumbers(serverUrl, token, () => assertDevice(serverUrl, token), uploadContent);
    const cache = await catalogCache(serverUrl);
    assertDevice(serverUrl, token);
    if (await compactUploadedFingerprints(cache)) await saveCatalog(serverUrl, cache);
    const { deletedWorks, changedOutsideCache } = await syncWorkMetadata(serverUrl, token, uploadContent, () => assertDevice(serverUrl, token), rescan);
    await pullCatalog(serverUrl, token, cache);
    if (uploadContent) {
      await uploadLocalContent(serverUrl, token, cache, rescan, deletedWorks, uploadConflictPolicy);
      await pullCatalog(serverUrl, token, cache);
      if (Object.keys(cache.tombstones).length) {
        // Handle deletions consumed after the first upload phase without another catalog loop.
        await uploadLocalContent(serverUrl, token, cache, false, deletedWorks, uploadConflictPolicy);
      }
    }
    assertDevice(serverUrl, token);
    if (changedOutsideCache.length) throw new WorkMetadataChangedOutsideCacheError(changedOutsideCache);
    if (uploadContent && await finalizePendingNovelMigrations(serverUrl, token, () => assertDevice(serverUrl, token), retryBlockedMigrations)) {
      incoming = await syncIncomingNovelMigrations(serverUrl, token, () => assertDevice(serverUrl, token), retryBlockedMigrations);
      await pullCatalog(serverUrl, token, cache);
    }
    if (incoming.pending) throw new PendingIncomingMigrationError(incoming.pending, incoming.error, incoming.retryable);
    useContentSyncStore.setState({ status: "idle" });
  } catch (error) {
    if (useContentSyncStore.getState().serverUrl === serverUrl) {
      useContentSyncStore.setState({ status: "error", error: error instanceof Error ? error.message : String(error), blocked: error instanceof ContentServerError && error.status === 403 });
    }
    throw error;
  }
}

/** Receive server-approved work moves while ordinary manual content synchronization stays manual. */
export function syncReceivedWorkMigrations(signal = new AbortController().signal): Promise<IncomingMigrationSyncResult> {
  const { serverUrl } = useContentSyncStore.getState();
  if (!serverUrl) return Promise.resolve({ applied: 0, pending: 0 });
  return runContentSyncOperation(async () => {
    signal.throwIfAborted();
    if (useContentSyncStore.getState().serverUrl !== serverUrl) throw new Error("Content server changed before receiving work migrations.");
    const token = await initializeDevice(serverUrl, signal);
    await reconcileCompletedNovelMigrations(serverUrl, token, () => {
      signal.throwIfAborted(); assertDevice(serverUrl, token);
    }, signal);
    const result = await syncIncomingNovelMigrations(serverUrl, token, () => {
      signal.throwIfAborted(); assertDevice(serverUrl, token);
    }, false, signal);
    signal.throwIfAborted(); assertDevice(serverUrl, token);
    return result;
  });
}

export function syncContentServer(uploadContent = true, rescan = false, retryBlockedMigrations = true): Promise<void> {
  if (pendingSync) {
    pendingSync.uploadContent ||= uploadContent;
    pendingSync.rescan ||= rescan;
    pendingSync.retryBlockedMigrations ||= retryBlockedMigrations;
    return pendingSync.promise;
  }
  const previous = running ?? Promise.resolve();
  const requested = {
    uploadContent,
    rescan,
    retryBlockedMigrations,
    promise: Promise.resolve(),
  };
  const promise = previous.catch(() => undefined).then(() => {
    if (pendingSync === requested) pendingSync = null;
    return performSync(requested.uploadContent, requested.rescan, requested.retryBlockedMigrations);
  });
  requested.promise = promise;
  pendingSync = requested;
  const reserved = promise.then(() => undefined, () => undefined).finally(() => {
    if (running === reserved) running = null;
  });
  running = reserved;
  return promise;
}

export async function downloadServerChapter(entry: CatalogEntry): Promise<{ novelId: number; chapterId: number }> {
  return downloadServerChapterFromServer(entry, useContentSyncStore.getState().serverUrl);
}

export async function downloadServerChapterFromServer(entry: CatalogEntry, serverUrl: string, options?: { token: string; target: ContentIdentity; signal?: AbortSignal }): Promise<{ novelId: number; chapterId: number }> {
  options?.signal?.throwIfAborted();
  const downloadRevision = currentChapterDownloadRevision();
  if (entry.deleted) throw new Error("Deleted server chapters cannot be downloaded.");
  const token = options?.token ?? await registerContentDevice(serverUrl, useContentSyncStore.getState().deviceName);
  const target = options?.target ?? entry.manifest.identity;
  const imported = options ? undefined : await importContentMetadata(entry.manifest, normalizeContentServerUrl(serverUrl));
  const findTarget = async () => {
    const row = (await listContentSyncChapters([contentIdentity(target.pluginId, target.novelPath, target.chapterPath)]))
      .find((item) => !imported || item.chapterId === imported.chapterId);
    if (!row) throw new Error("Downloaded chapter metadata is missing.");
    if (entry.manifest.identity.novelId !== row.sourceNovelId) throw new Error("Server chapter novel ID does not match the local work.");
    return row;
  };
  const row = await findTarget();
  return withDownloadedContentChapter({ serverUrl, token, entry, storageDir: storageDir(row), chapterId: row.chapterId, ...(options?.signal ? { signal: options.signal } : {}) }, (result, install) => {
    options?.signal?.throwIfAborted();
    return withChapterDownloadWrite(row.chapterId, options?.signal, () =>
      runWorkContentStorageOperation(target.pluginId, target.novelPath, async () => {
        options?.signal?.throwIfAborted();
        const current = await findTarget();
        if (current.chapterId !== row.chapterId) throw new Error("Downloaded chapter identity changed during transfer.");
        options?.signal?.throwIfAborted();
        if (current.isLocal) await clearServerChapterDownloadProof(current.chapterId);
        options?.signal?.throwIfAborted();
        await install(storageDir(current));
        await markContentInstalled(current.chapterId, entry.manifest.chapter.contentType, result.contentBytes, result.mediaBytes, result.mediaComplete);
        if (current.isLocal) {
          const snapshot = await inspectChapterPayloadInventory({
            novel: { id: current.novelId, pluginId: current.pluginId, sourceNovelId: current.sourceNovelId, path: current.novelPath, name: current.novelName },
            chapter: { id: current.chapterId, chapterNumber: current.chapterNumber, position: current.position, name: current.chapterName, contentType: current.contentType },
          });
          await rememberServerChapterDownload(current, normalizeContentServerUrl(serverUrl), snapshot.fingerprint);
        }
        return { novelId: current.novelId, chapterId: current.chapterId };
      }), downloadRevision);
  });
}

async function mutateServerChapter(serverUrl: string, entry: CatalogEntry, restore: boolean): Promise<void> {
  const token = await registerContentDevice(serverUrl, useContentSyncStore.getState().deviceName);
  await contentServerRequest(serverUrl, `/chapters/${encodeURIComponent(entry.id)}${restore ? "/restore" : ""}`, token, restore ? "POST" : "DELETE");
}
export function deleteServerChapter(entry: CatalogEntry): Promise<void> {
  const server = useContentSyncStore.getState().serverUrl;
  return runContentSyncOperation(async () => {
    await mutateServerChapter(server, entry, false);
    await setServerChapterDeletionExclusion(server, entry.manifest.identity, entry.manifest.chapter.chapterNumber, true);
  });
}
export function restoreServerChapter(entry: CatalogEntry): Promise<void> {
  const server = useContentSyncStore.getState().serverUrl;
  return runContentSyncOperation(async () => {
    await mutateServerChapter(server, entry, true);
    await setServerChapterDeletionExclusion(server, entry.manifest.identity, entry.manifest.chapter.chapterNumber, false);
  });
}

export async function getContentSyncCursors(): Promise<{ catalogCursor: number; workCursor: number }> {
  const { serverUrl } = useContentSyncStore.getState();
  return { catalogCursor: (await catalogCache(serverUrl)).cursor, workCursor: await getWorkSyncCursor(serverUrl) };
}
