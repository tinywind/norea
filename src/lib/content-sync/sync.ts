import {
  applyContentState, contentIdentity, importContentMetadata, listContentSyncChapters,
  markContentInstalled, readContentState, readContentSyncCache, writeContentSyncCache, type ContentSyncChapter,
} from "../../db/queries/content-sync";
import { useContentSyncStore } from "../../store/content-sync";
import { useReaderStore } from "../../store/reader";
import { chapterStorageRelativeDir } from "../chapter-storage-path";
import { resolvedChapterStorageDir } from "../chapter-storage-resolution";
import { taskScheduler } from "../tasks/scheduler";
import {
  contentServerRequest, normalizeContentServerUrl, ContentServerError,
  type ContentCatalogPage, type ContentSession, type ContentStateEntry,
  type ContentStateMutation, type ContentStateValue,
} from "./client";
import { downloadContentChapter, fingerprintContentChapter, uploadContentChapter, type CatalogEntry } from "./native";

interface CatalogCache {
  cursor: number;
  entries: Record<string, CatalogEntry>;
  uploaded: Record<string, string>;
  downloads: Record<string, boolean>;
  excluded: string[];
  pendingUploads: string[];
}
interface AccountCache {
  baseline: Record<string, ContentStateValue>;
  remote: Record<string, ContentStateEntry>;
  pending: Record<string, ContentStateMutation>;
  initialized: boolean;
  initialMode?: "merge" | "server";
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
function accountCache(server: string, user: string): Promise<AccountCache> {
  return readCache(`norea-content-account:${server}:${user}`, { baseline: {}, remote: {}, pending: {}, initialized: false });
}
function saveCatalog(server: string, cache: CatalogCache): Promise<void> { return saveCache(`norea-content-catalog:${server}`, cache); }
function sameValue(left: ContentStateValue | undefined, right: ContentStateValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function readLocalState(): Promise<Record<string, ContentStateValue>> {
  return readContentState(useReaderStore.getState().lastReadChapterByNovel);
}
function meaningful(value: ContentStateValue): boolean {
  return "deleted" in value ? !value.deleted : "unread" in value ? !value.unread || value.progress > 0 : true;
}
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
function assertSession(server: string, token: string | null): void {
  const current = useContentSyncStore.getState();
  if (current.serverUrl !== server || current.token !== token) throw new Error("Content server session changed during synchronization.");
}
async function publishCatalog(server: string, cache: CatalogCache): Promise<void> {
  await saveCatalog(server, cache);
  if (useContentSyncStore.getState().serverUrl === server) useContentSyncStore.setState({ catalog: Object.values(cache.entries) });
}
async function pullCatalog(server: string, token: string | null, cache: CatalogCache): Promise<void> {
  let more = true;
  while (more) {
    const page = await contentServerRequest<ContentCatalogPage>(server, `/chapters?after=${cache.cursor}&limit=100`, token ?? undefined);
    assertSession(server, token);
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

async function applyRemote(entry: ContentStateEntry): Promise<boolean> {
  if (entry.conflicts.length > 0 || useReaderStore.getState().fullPageReaderActive) return false;
  const local = await applyContentState(entry.key, entry.value);
  if (entry.key.startsWith("position:") && local?.chapterId) {
    if ("readAt" in entry.value && entry.value.readAt === null) {
      const positions = { ...useReaderStore.getState().lastReadChapterByNovel };
      delete positions[local.novelId];
      useReaderStore.setState({ lastReadChapterByNovel: positions });
    } else useReaderStore.getState().setLastReadChapter(local.novelId, local.chapterId);
  }
  return local !== null;
}

async function syncAccount(server: string, token: string, user: string, initialMode?: "merge" | "server"): Promise<void> {
  const key = `norea-content-account:${server}:${user}`;
  const cache = await accountCache(server, user);
  const local = await readLocalState();
  assertSession(server, token);
  if (initialMode) cache.initialMode = initialMode;
  const mode = cache.initialMode;
  if (mode === "server") {
    cache.pending = {};
    cache.baseline = { ...local };
  } else {
    const changes = { ...local };
    for (const [stateKey, value] of Object.entries(cache.baseline)) {
      if (stateKey.startsWith("position:") && !(stateKey in local) && "chapterPath" in value && value.readAt !== null) {
        changes[stateKey] = { chapterPath: value.chapterPath, progress: 0, readAt: null };
      }
    }
    for (const [stateKey, value] of Object.entries(changes)) {
      if (cache.pending[stateKey] || cache.remote[stateKey]?.conflicts.length) continue;
      const previous = cache.baseline[stateKey];
      if (sameValue(previous, value) || (previous === undefined && !meaningful(value))) continue;
      cache.pending[stateKey] = { key: stateKey, value, baseVersion: cache.remote[stateKey]?.version ?? 0, operationId: crypto.randomUUID(), deviceName: useContentSyncStore.getState().deviceName };
    }
  }
  await saveCache(key, cache);
  if (useReaderStore.getState().fullPageReaderActive) return;
  const result = await contentServerRequest<{ items: ContentStateEntry[] }>(server, "/state", token);
  assertSession(server, token);
  cache.remote = Object.fromEntries(result.items.map((entry) => [entry.key, entry]));
  if (mode === "server" && !useReaderStore.getState().fullPageReaderActive) {
    for (const [stateKey, value] of Object.entries(local)) {
      if (cache.remote[stateKey]) continue;
      const reset: ContentStateValue = "deleted" in value ? { deleted: true }
        : "unread" in value ? { unread: true, progress: 0 }
        : { chapterPath: value.chapterPath, progress: 0, readAt: null };
      await applyRemote({ key: stateKey, value: reset, version: 0, conflicts: [] });
      cache.baseline[stateKey] = reset;
    }
  }
  const acknowledged: Record<string, ContentStateValue> = {};
  for (const mutation of Object.values(cache.pending)) {
    assertSession(server, token);
    try {
      const entry = await contentServerRequest<ContentStateEntry>(server, "/state", token, "PUT", mutation);
      assertSession(server, token);
      cache.remote[entry.key] = entry;
      cache.baseline[entry.key] = mutation.value;
      acknowledged[entry.key] = mutation.value;
      delete cache.pending[entry.key];
    } catch (error) {
      if (!(error instanceof ContentServerError) || error.status !== 409 || !error.current) throw error;
      cache.remote[mutation.key] = error.current;
      cache.baseline[mutation.key] = mutation.value;
      acknowledged[mutation.key] = mutation.value;
      delete cache.pending[mutation.key];
    } finally { await saveCache(key, cache); }
  }
  const latestLocal = await readLocalState();
  for (const entry of Object.values(cache.remote)) {
    assertSession(server, token);
    const latest = latestLocal[entry.key];
    const changedDuringSync = !sameValue(latest, local[entry.key]);
    const newerThanPending = acknowledged[entry.key] !== undefined && !sameValue(local[entry.key], acknowledged[entry.key]);
    if (!cache.pending[entry.key] && !changedDuringSync && !newerThanPending && await applyRemote(entry)) {
      cache.baseline[entry.key] = entry.value;
    }
  }
  for (const [stateKey, value] of Object.entries(local)) {
    if (cache.baseline[stateKey] === undefined && !meaningful(value)) cache.baseline[stateKey] = value;
  }
  cache.initialized = true;
  delete cache.initialMode;
  await saveCache(key, cache);
  assertSession(server, token);
  useContentSyncStore.setState({ conflicts: Object.values(cache.remote).filter((entry) => entry.conflicts.length > 0) });
  window.dispatchEvent(new Event("norea-content-state-changed"));
}

async function uploadLocalContent(server: string, token: string, cache: CatalogCache): Promise<void> {
  const rows = await listContentSyncChapters();
  const remoteByIdentity = new Map(Object.values(cache.entries).map((entry) => [entryIdentity(entry), entry]));
  const available = new Set<string>();
  const fingerprints = new Map<string, string>();
  for (const row of rows) {
    const id = identity(row);
    if (row.isDownloaded) available.add(id);
    if (cache.downloads[id] && !row.isDownloaded && !cache.excluded.includes(id)) cache.excluded.push(id);
    if (!row.isDownloaded || row.mediaRepairNeeded || remoteByIdentity.get(id)?.deleted) continue;
    const fingerprint = JSON.stringify([await fingerprintContentChapter({ storageDir: storageDir(row) }),
      row.novelName, row.author, row.summary, row.chapterName, row.chapterNumber, row.position, row.page, row.contentType]);
    assertSession(server, token);
    if (cache.uploaded[id] === fingerprint) continue;
    fingerprints.set(id, fingerprint);
    if (!cache.pendingUploads.includes(id)) cache.pendingUploads.push(id);
  }
  await saveCatalog(server, cache);
  for (const id of [...cache.pendingUploads]) {
    assertSession(server, token);
    const row = rows.find((item) => identity(item) === id);
    if (!row || !available.has(id) || row.mediaRepairNeeded || remoteByIdentity.get(id)?.deleted) {
      cache.pendingUploads = cache.pendingUploads.filter((item) => item !== id);
      continue;
    }
    await uploadContentChapter({
      serverUrl: server, token, chapterId: row.chapterId, storageDir: storageDir(row),
      manifest: { packageVersion: 1, identity: { pluginId: row.pluginId, novelPath: row.novelPath, chapterPath: row.chapterPath },
        novel: { name: row.novelName, author: row.author, summary: row.summary, isLocal: row.isLocal },
        chapter: { name: row.chapterName, position: row.position, chapterNumber: row.chapterNumber, page: row.page, contentType: row.contentType } },
    });
    assertSession(server, token);
    cache.uploaded[id] = fingerprints.get(id)!;
    cache.pendingUploads = cache.pendingUploads.filter((item) => item !== id);
    await saveCatalog(server, cache);
  }
  cache.downloads = Object.fromEntries([...available].map((id) => [id, true]));
  await saveCatalog(server, cache);
}

let running: Promise<void> | null = null;
async function performSync(initialMode?: "merge" | "server", uploadContent = true): Promise<void> {
  const { serverUrl, token, user } = useContentSyncStore.getState();
  if (!serverUrl) return;
  useContentSyncStore.setState({ status: "syncing", error: null });
  try {
    normalizeContentServerUrl(serverUrl);
    const cache = await catalogCache(serverUrl);
    assertSession(serverUrl, token);
    useContentSyncStore.setState({ catalog: Object.values(cache.entries) });
    await pullCatalog(serverUrl, token, cache);
    if (token && user) {
      await syncAccount(serverUrl, token, String(user.id), initialMode);
      if (uploadContent) {
        await uploadLocalContent(serverUrl, token, cache);
        await pullCatalog(serverUrl, token, cache);
      }
    }
    assertSession(serverUrl, token);
    useContentSyncStore.setState({ status: "idle" });
  } catch (error) {
    if (useContentSyncStore.getState().serverUrl === serverUrl && useContentSyncStore.getState().token === token) {
      useContentSyncStore.setState({ status: "error", error: error instanceof Error ? error.message : String(error) });
      if (error instanceof ContentServerError && error.status === 401) useContentSyncStore.setState({ token: null, user: null, conflicts: [] });
    }
    throw error;
  }
}

export function syncContentServer(uploadContent = true): Promise<void> {
  if (running) return running;
  running = performSync(undefined, uploadContent).finally(() => { running = null; });
  return running;
}

export async function loginContentServer(username: string, password: string, mergeMode: "merge" | "server"): Promise<void> {
  if (useReaderStore.getState().fullPageReaderActive) throw new Error("Close the reader before changing the content server account.");
  if (running) await running.catch(() => undefined);
  const { serverUrl, deviceName } = useContentSyncStore.getState();
  const session = await contentServerRequest<ContentSession>(serverUrl, "/sessions", undefined, "POST", { username, password, deviceName });
  if (useContentSyncStore.getState().serverUrl !== serverUrl) throw new Error("Content server changed during sign-in.");
  const cache = await accountCache(serverUrl, String(session.user.id));
  cache.initialMode = mergeMode;
  await saveCache(`norea-content-account:${serverUrl}:${session.user.id}`, cache);
  useContentSyncStore.setState({ ...session, conflicts: [], error: null });
  running = performSync(mergeMode).finally(() => { running = null; });
  return running;
}

export async function logoutContentServer(): Promise<void> {
  const { serverUrl, token } = useContentSyncStore.getState();
  useContentSyncStore.setState({ token: null, user: null, conflicts: [], status: "idle", error: null });
  if (token) await contentServerRequest(serverUrl, "/sessions/current", token, "DELETE");
}

export async function downloadServerChapter(entry: CatalogEntry): Promise<{ novelId: number; chapterId: number }> {
  if (entry.deleted) throw new Error("Deleted server chapters cannot be downloaded.");
  const { serverUrl, token } = useContentSyncStore.getState();
  const mapping = await importContentMetadata(entry.manifest);
  const row = (await listContentSyncChapters()).find((item) => item.chapterId === mapping.chapterId);
  if (!row) throw new Error("Downloaded chapter metadata is missing.");
  const result = await downloadContentChapter({ serverUrl, token: token ?? undefined, entry, storageDir: storageDir(row), chapterId: mapping.chapterId });
  await markContentInstalled(mapping.chapterId, entry.manifest.chapter.contentType, result.contentBytes, result.mediaBytes);
  const cache = await catalogCache(serverUrl);
  const id = entryIdentity(entry);
  cache.excluded = cache.excluded.filter((item) => item !== id);
  cache.downloads[id] = true;
  await saveCatalog(serverUrl, cache);
  window.dispatchEvent(new Event("norea-content-state-changed"));
  return mapping;
}

async function mutateServerChapter(entry: CatalogEntry, restore: boolean): Promise<void> {
  const { serverUrl, token } = useContentSyncStore.getState();
  if (!token) throw new Error("Sign in to manage server chapters.");
  await contentServerRequest(serverUrl, `/chapters/${encodeURIComponent(entry.id)}${restore ? "/restore" : ""}`, token, restore ? "POST" : "DELETE");
  await syncContentServer();
}
export function deleteServerChapter(entry: CatalogEntry): Promise<void> { return mutateServerChapter(entry, false); }
export function restoreServerChapter(entry: CatalogEntry): Promise<void> { return mutateServerChapter(entry, true); }

export async function resolveContentState(key: string, value: ContentStateValue): Promise<void> {
  const { serverUrl, token, user, deviceName } = useContentSyncStore.getState();
  if (!token || !user) throw new Error("Sign in to resolve reading state.");
  const cache = await accountCache(serverUrl, String(user.id));
  const current = cache.remote[key];
  if (!current) throw new Error("Refresh the content server before resolving this state.");
  cache.pending[key] = { key, value, baseVersion: current.version, operationId: crypto.randomUUID(), deviceName };
  await saveCache(`norea-content-account:${serverUrl}:${user.id}`, cache);
  await syncContentServer();
}

export function startContentServerSync(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let includeContent = false;
  const schedule = (uploadContent: boolean) => {
    includeContent ||= uploadContent;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const transferContent = includeContent;
      includeContent = false;
      const state = useContentSyncStore.getState();
      if (state.autoSync && state.serverUrl && document.visibilityState !== "hidden") {
        void (running ?? Promise.resolve()).catch(() => undefined).then(() => syncContentServer(transferContent)).catch(() => undefined);
      }
    }, 1500);
  };
  const run = () => {
    const state = useContentSyncStore.getState();
    if (state.autoSync && state.serverUrl && document.visibilityState !== "hidden") schedule(true);
  };
  window.addEventListener("online", run);
  document.addEventListener("visibilitychange", run);
  const unsubscribe = useContentSyncStore.subscribe((state, previous) => {
    if (state.autoSync !== previous.autoSync || state.serverUrl !== previous.serverUrl) run();
  });
  const unsubscribeReader = useReaderStore.subscribe((state, previous) => {
    if (previous.fullPageReaderActive && !state.fullPageReaderActive) schedule(false);
  });
  const unsubscribeTasks = taskScheduler.subscribeEvents(({ task }) => {
    if (task.status === "succeeded" && (task.kind === "chapter.download" || task.kind === "chapter.repairMedia")) schedule(true);
  });
  run();
  return () => { window.removeEventListener("online", run); document.removeEventListener("visibilitychange", run); if (timer) clearTimeout(timer); unsubscribe(); unsubscribeReader(); unsubscribeTasks(); };
}
