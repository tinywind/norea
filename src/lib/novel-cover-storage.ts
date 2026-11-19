import { novelStorageRelativeDir, type ChapterStorageNovelPathInput } from "./chapter-storage-path";
import { pluginMediaFetch } from "./http";
import { getPluginBaseUrl } from "./plugins/base-url";
import type { Plugin } from "./plugins/types";
import { isTauriRuntime } from "./tauri-runtime";
import { resolvedNovelStorageDir } from "./chapter-storage-resolution";
import { coverContentType, MAX_NOVEL_COVER_BYTES } from "./work-metadata/schema";
import { runWorkContentStorageOperation } from "./content-sync/storage-operation";

const NOVEL_COVER_BASENAME = "cover";
const DEFAULT_COVER_EXTENSION = "img";
const NOREA_MEDIA_SRC_PREFIX = "http://norea-media.localhost/";
const PERSISTENT_SOURCE_COVER_CACHE_NAME = "norea-source-covers-v1";
const PERSISTENT_SOURCE_COVER_PATH_PREFIX = "/__norea-source-cover-cache__/v1/";
const MAX_PERSISTENT_SOURCE_COVERS = 1000;
// Object URLs pin fetched image bytes, while stored covers are plain URL strings
// that let remounted cards render without another native lookup.
const MAX_UNUSED_COVER_OBJECT_URLS = 100;
const MAX_UNUSED_COVER_URLS = 1000;

type NovelCoverChangeListener = (novelId: number) => void;
type NovelCoverIdentity = Pick<NovelCoverStorageInput, "pluginId" | "path">;

interface NovelCoverChangeSubscription {
  filter?: {
    novelId: number;
    pluginId: string;
    path: string;
  };
  listener: NovelCoverChangeListener;
}

const novelCoverChangeSubscriptions = new Set<NovelCoverChangeSubscription>();
const novelCoverSnapshots = new Map<number, number>();
const novelCoverIdentityOnlySnapshots = new Map<string, number>();
const novelCoverSourceIdentitySnapshots = new Map<string, number>();
const novelCoverSaveQueues = new Map<string, NovelCoverSaveQueue>();
const novelCoverDisplayCache = new Map<string, NovelCoverDisplayCacheEntry>();
let novelCoverStorageEpoch = 0;
let novelCoverUnscopedEpoch = 0;
let persistentCoverTrimPromise: Promise<void> | null = null;

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "jpg",
  "jpeg",
  "png",
  "svg",
  "webp",
]);

interface StoredNovelCover {
  relativePath: string;
  modifiedAt: number;
}

interface NovelCoverSaveQueue {
  generations: Map<string, number>;
  latestRequests: Map<string, Promise<void>>;
  pending: number;
  tail: Promise<void>;
}

interface NovelCoverDisplayCacheEntry {
  novelIds: Set<number>;
  identity: Pick<NovelCoverStorageInput, "pluginId" | "path">;
  consumers: number;
  controller: AbortController;
  promise: Promise<string | null>;
  resolved: boolean;
  source: NovelCoverDisplaySource | null;
}

export interface NovelCoverStorageInput extends ChapterStorageNovelPathInput {
  id: number;
  name: string;
  path: string;
  pluginId: string;
  sourceNovelId: string | null;
  coverOverride?: string | null;
}

export interface NovelCoverDisplayInput extends NovelCoverStorageInput {
  cover: string | null;
  coverOverride?: string | null;
}

export interface NovelCoverDisplaySource {
  dispose: () => void;
  persist?: (novel: NovelCoverStorageInput) => Promise<void>;
  src: string;
}

export interface NovelCoverDisplayCacheOptions {
  allowSourceFallback?: boolean;
  plugin?: Plugin | null;
}

export interface NovelCoverSaveOptions {
  refresh?: boolean;
  /** A complete source result explicitly has no cover. */
  clearMissing?: boolean;
}

function novelCoverIdentityKey(identity: NovelCoverIdentity): string {
  return JSON.stringify([identity.pluginId, identity.path]);
}

export function subscribeNovelCoverChanges(
  listener: NovelCoverChangeListener,
  filter?: { novelId: number; pluginId: string; path: string },
): () => void {
  const subscription: NovelCoverChangeSubscription = { filter, listener };
  novelCoverChangeSubscriptions.add(subscription);
  return () => {
    novelCoverChangeSubscriptions.delete(subscription);
  };
}

export function getNovelCoverSnapshot(
  novelId: number,
  identity?: NovelCoverIdentity,
): number {
  if (!identity) {
    return novelCoverStorageEpoch + (novelCoverSnapshots.get(novelId) ?? 0);
  }
  const key = novelCoverIdentityKey(identity);
  if (novelId > 0) {
    return (
      novelCoverStorageEpoch +
      (novelCoverSnapshots.get(novelId) ?? 0) +
      (novelCoverIdentityOnlySnapshots.get(key) ?? 0)
    );
  }
  return (
    novelCoverStorageEpoch +
    novelCoverUnscopedEpoch +
    (novelCoverSourceIdentitySnapshots.get(key) ?? 0)
  );
}

export function peekCachedNovelCoverSrc(
  novel: NovelCoverDisplayInput,
  options: NovelCoverDisplayCacheOptions = {},
): string | null | undefined {
  const entry = novelCoverDisplayCache.get(
    selectNovelCoverDisplayCacheKey(novel, options),
  );
  return entry?.resolved ? entry.source?.src ?? null : undefined;
}

export function resolveCachedNovelCoverSrc(
  novel: NovelCoverDisplayInput,
  options: NovelCoverDisplayCacheOptions = {},
): Promise<string | null> {
  return getOrCreateNovelCoverCacheEntry(novel, options).promise;
}

export async function persistCachedNovelCoverSource(
  novel: NovelCoverDisplayInput,
  options: NovelCoverDisplayCacheOptions = {},
): Promise<void> {
  if (novel.id <= 0 || !resolvedNovelStorageDir(novel.id)) return;
  const entry = novelCoverDisplayCache.get(selectNovelCoverDisplayCacheKey(novel, options));
  if (entry?.resolved) await entry.source?.persist?.(novel);
}

export function acquireCachedNovelCoverSource(
  novel: NovelCoverDisplayInput,
  options: NovelCoverDisplayCacheOptions = {},
): { promise: Promise<string | null>; release: () => void } {
  const cacheKey = selectNovelCoverDisplayCacheKey(novel, options);
  const entry = getOrCreateNovelCoverCacheEntry(novel, options);
  entry.consumers += 1;
  let released = false;
  return {
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      entry.consumers -= 1;
      if (entry.consumers === 0 && !entry.resolved) {
        if (novelCoverDisplayCache.get(cacheKey) === entry) {
          novelCoverDisplayCache.delete(cacheKey);
        }
        entry.controller.abort();
      }
      trimUnusedNovelCoverSources();
    },
  };
}

function getOrCreateNovelCoverCacheEntry(
  novel: NovelCoverDisplayInput,
  options: NovelCoverDisplayCacheOptions,
): NovelCoverDisplayCacheEntry {
  const cacheKey = selectNovelCoverDisplayCacheKey(novel, options);
  const cached = novelCoverDisplayCache.get(cacheKey);
  if (cached) {
    if (novel.id > 0) cached.novelIds.add(novel.id);
    novelCoverDisplayCache.delete(cacheKey);
    novelCoverDisplayCache.set(cacheKey, cached);
    return cached;
  }

  const entry: NovelCoverDisplayCacheEntry = {
    novelIds: new Set(novel.id > 0 ? [novel.id] : []),
    identity: { pluginId: novel.pluginId, path: novel.path },
    consumers: 0,
    controller: new AbortController(),
    promise: Promise.resolve(null),
    resolved: false,
    source: null,
  };
  const request = resolveNovelCoverDisplaySourceForCache(novel, options, entry.controller.signal).then(
    (source) => {
      if (novelCoverDisplayCache.get(cacheKey) !== entry) {
        source?.dispose();
        return null;
      }
      entry.resolved = true;
      entry.source = source;
      if (!source) novelCoverDisplayCache.delete(cacheKey);
      trimUnusedNovelCoverSources();
      return source?.src ?? null;
    },
    (error: unknown) => {
      if (novelCoverDisplayCache.get(cacheKey) === entry) {
        novelCoverDisplayCache.delete(cacheKey);
      }
      throw error;
    },
  );
  entry.promise = request;
  novelCoverDisplayCache.set(cacheKey, entry);
  return entry;
}

function trimUnusedNovelCoverSources(): void {
  const unused = [...novelCoverDisplayCache].filter(([, entry]) => entry.resolved && entry.consumers === 0);
  const ownsObjectUrl = ([, entry]: (typeof unused)[number]) => entry.source?.src.startsWith("blob:") ?? false;
  evictOldestNovelCoverSources(unused.filter(ownsObjectUrl), MAX_UNUSED_COVER_OBJECT_URLS);
  evictOldestNovelCoverSources(unused.filter((item) => !ownsObjectUrl(item)), MAX_UNUSED_COVER_URLS);
}

function evictOldestNovelCoverSources(
  entries: [string, NovelCoverDisplayCacheEntry][],
  limit: number,
): void {
  for (const [key, entry] of entries.slice(0, Math.max(0, entries.length - limit))) {
    novelCoverDisplayCache.delete(key);
    entry.source?.dispose();
  }
}

export function clearNovelCoverDisplayCache(
  novelId?: number,
  identity?: Pick<NovelCoverStorageInput, "pluginId" | "path">,
): void {
  const targeted = novelId !== undefined || identity !== undefined;
  for (const [cacheKey, entry] of novelCoverDisplayCache) {
    const sameNovelId =
      novelId !== undefined && novelId > 0 && entry.novelIds.has(novelId);
    const sameIdentity = Boolean(
      identity &&
        identity.pluginId === entry.identity.pluginId &&
        identity.path === entry.identity.path,
    );
    if (targeted && !sameNovelId && !sameIdentity) continue;
    novelCoverDisplayCache.delete(cacheKey);
    entry.controller.abort();
    if (entry.resolved) entry.source?.dispose();
  }
}

export function invalidateAllNovelCoverSources(): void {
  clearNovelCoverDisplayCache();
  novelCoverStorageEpoch += 1;
  notifyNovelCoverSubscriptions(0);
}

function notifyNovelCoverSubscriptions(
  changedNovelId: number,
  changedIdentity?: NovelCoverIdentity,
): void {
  for (const { filter, listener } of novelCoverChangeSubscriptions) {
    if (!filter) {
      listener(changedNovelId);
      continue;
    }
    const sameIdentity = Boolean(
      changedIdentity &&
        changedIdentity.pluginId === filter.pluginId &&
        changedIdentity.path === filter.path,
    );
    if (changedNovelId === 0) {
      if (!changedIdentity || sameIdentity) listener(0);
      continue;
    }
    if (filter.novelId > 0) {
      if (filter.novelId === changedNovelId || sameIdentity) {
        listener(changedNovelId);
      }
      continue;
    }
    if (!changedIdentity || sameIdentity) {
      listener(changedNovelId);
    }
  }
}

async function resolveNovelCoverDisplaySourceForCache(
  novel: NovelCoverDisplayInput,
  options: NovelCoverDisplayCacheOptions,
  signal: AbortSignal,
): Promise<NovelCoverDisplaySource | null> {
  const plugin = options.plugin ?? null;
  if (options.allowSourceFallback && plugin) {
    return resolveNovelCoverDisplaySource(plugin, novel, signal);
  }

  const src = await resolveStoredNovelCoverSrc(novel);
  return src ? { dispose: () => undefined, src } : null;
}

function selectNovelCoverDisplayCacheKey(
  novel: NovelCoverDisplayInput,
  options: NovelCoverDisplayCacheOptions,
): string {
  const plugin = options.plugin ?? null;
  const coverOverride = novel.coverOverride?.trim() || null;
  const identity = [novel.pluginId, novel.path, novel.path.trim() ? null : novel.id, coverOverride];
  const storedKey = JSON.stringify(["stored", ...identity]);
  if (!options.allowSourceFallback || !plugin || coverOverride || novelCoverDisplayCache.get(storedKey)?.source) {
    return storedKey;
  }
  return JSON.stringify([
    "source",
    ...identity,
    novel.cover?.trim() || null,
    plugin?.version ?? null,
    plugin?.url ?? null,
  ]);
}

export async function resolveNovelCoverDisplaySource(
  plugin: Plugin,
  novel: NovelCoverDisplayInput,
  signal?: AbortSignal,
): Promise<NovelCoverDisplaySource | null> {
  throwIfCoverRequestAborted(signal);
  const sourceUrl = absolutePluginCoverUrl(plugin, novel.cover);
  if (!isTauriRuntime()) {
    return sourceUrl ? { dispose: () => undefined, src: sourceUrl } : null;
  }

  const stored = acquireCachedNovelCoverSource(novel);
  const existing = await stored.promise.catch(
    (error: unknown) => {
      console.debug("[novel-cover] stored cover unavailable", {
        error,
        novelId: novel.id,
        pluginId: novel.pluginId,
      });
      return null;
    },
  ).finally(stored.release);
  throwIfCoverRequestAborted(signal);
  if (existing) {
    return {
      dispose: () => undefined,
      src: existing,
    };
  }
  if (!sourceUrl) return null;

  const cached = await readPersistentSourceCover(plugin.id, sourceUrl);
  throwIfCoverRequestAborted(signal);
  if (cached) {
    return createObjectUrlCoverDisplaySource(
      plugin,
      sourceUrl,
      cached.body,
      cached.contentType,
    );
  }

  const baseUrl = safePluginBaseUrl(plugin);
  const response = await pluginMediaFetch(sourceUrl, {
    ...(plugin.imageRequestInit ?? {}),
    ...(baseUrl ? { contextUrl: baseUrl } : {}),
    priority: "deferred",
    // Display work must not inherit a source task's executor ownership.
    signal: signal ?? new AbortController().signal,
    sourceId: plugin.id,
  });
  throwIfCoverRequestAborted(signal);
  if (!response.ok) {
    throw new Error(
      `novel cover: failed to fetch cover image (${response.status} ${response.statusText})`,
    );
  }
  const contentType = normalizeContentType(
    response.headers.get("content-type"),
  );
  if (contentType && isCoverDocumentContentType(contentType)) {
    throw new Error(
      `novel cover: fetched cover has a non-image content type (${contentType})`,
    );
  }
  const body = await response.blob();
  if (body.size === 0) {
    throw new Error("novel cover: fetched cover image is empty");
  }
  await writePersistentSourceCover(plugin.id, sourceUrl, body, contentType);
  throwIfCoverRequestAborted(signal);

  return createObjectUrlCoverDisplaySource(plugin, sourceUrl, body, contentType);
}

function createObjectUrlCoverDisplaySource(
  plugin: Plugin,
  sourceUrl: string,
  body: Blob,
  contentType: string | null,
): NovelCoverDisplaySource {
  const src = URL.createObjectURL(body);
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      URL.revokeObjectURL(src);
    },
    persist: (storedNovel) =>
      enqueueNovelCoverSave(plugin, storedNovel, sourceUrl, false, {
        body,
        contentType,
      }),
    src,
  };
}

export async function saveNovelCoverFromSource(
  plugin: Plugin,
  novel: NovelCoverStorageInput,
  cover: string | null | undefined,
  options: NovelCoverSaveOptions = {},
): Promise<void> {
  if (!isTauriRuntime()) return;

  const sourceUrl = absolutePluginCoverUrl(plugin, cover);
  if (!sourceUrl) {
    if (!options.clearMissing) return;
    if (cover?.trim()) throw new Error("novel cover: source returned an invalid cover URL");
    await enqueueNovelCoverSave(plugin, novel, null, true);
    return;
  }

  await enqueueNovelCoverSave(plugin, novel, sourceUrl, options.refresh ?? false);
}

async function enqueueNovelCoverSave(
  plugin: Plugin,
  novel: NovelCoverStorageInput,
  sourceUrl: string | null,
  refresh: boolean,
  fetched?: { body: Blob; contentType: string | null },
): Promise<void> {
  const cacheKey = novelCoverSaveQueueKey(novel);
  const requestIdentity = novelCoverSaveRequestIdentity(novel, refresh);
  let queue = novelCoverSaveQueues.get(cacheKey);
  if (!queue) {
    queue = {
      generations: new Map(),
      latestRequests: new Map(),
      pending: 0,
      tail: Promise.resolve(),
    };
    novelCoverSaveQueues.set(cacheKey, queue);
  }

  const generation = (queue.generations.get(requestIdentity) ?? 0) + 1;
  queue.generations.set(requestIdentity, generation);
  queue.pending += 1;
  const request = queue.tail.catch(() => undefined).then(async () => {
    if (queue.generations.get(requestIdentity) !== generation) return;
    const stored = await storeNovelCoverFromSource(plugin, novel, sourceUrl, refresh, fetched);
    if (stored) notifyNovelCoverChanged(novel.id, novel);
  });
  queue.tail = request;
  queue.latestRequests.set(requestIdentity, request);
  void request
    .finally(() => {
      if (queue.generations.get(requestIdentity) === generation) {
        queue.generations.delete(requestIdentity);
        queue.latestRequests.delete(requestIdentity);
      }
      queue.pending -= 1;
      if (queue.pending === 0 && novelCoverSaveQueues.get(cacheKey) === queue) {
        novelCoverSaveQueues.delete(cacheKey);
      }
    })
    .catch(() => undefined);
  return waitForLatestNovelCoverSave(queue, requestIdentity, request);
}

async function waitForLatestNovelCoverSave(
  queue: NovelCoverSaveQueue,
  requestIdentity: string,
  initialRequest: Promise<void>,
): Promise<void> {
  let request = initialRequest;
  while (true) {
    try {
      await request;
    } catch (error) {
      const latestRequest = queue.latestRequests.get(requestIdentity);
      if (!latestRequest || latestRequest === request) throw error;
      request = latestRequest;
      continue;
    }

    const latestRequest = queue.latestRequests.get(requestIdentity);
    if (!latestRequest || latestRequest === request) return;
    request = latestRequest;
  }
}

function novelCoverSaveRequestIdentity(novel: NovelCoverStorageInput, refresh: boolean): string {
  const path = novel.path.trim();
  return JSON.stringify([
    novel.pluginId,
    novel.path,
    path ? null : novel.id,
    refresh,
  ]);
}

function novelCoverSaveQueueKey(novel: NovelCoverStorageInput): string {
  return JSON.stringify([novel.pluginId, novel.path]);
}

async function storeNovelCoverFromSource(
  plugin: Plugin,
  novel: NovelCoverStorageInput,
  sourceUrl: string | null,
  refresh: boolean,
  fetched?: { body: Blob; contentType: string | null },
): Promise<boolean> {
  if (sourceUrl === null) {
    await storeNovelCover(novel, null);
    return true;
  }
  if (
    !refresh &&
    (peekCachedNovelCoverSrc({ ...novel, cover: sourceUrl, coverOverride: null }) ||
      (await readStoredNovelCover(novel, false)))
  ) {
    return false;
  }

  const image = fetched ?? await fetchNovelCoverForStorage(plugin, sourceUrl, refresh);
  const body = new Uint8Array(await image.body.arrayBuffer());
  const contentType = image.contentType;
  const fileName = `${NOVEL_COVER_BASENAME}.${coverExtension(sourceUrl, contentType)}`;
  await storeNovelCover(novel, {
    body,
    contentType: contentType?.startsWith("image/") ? contentType : coverContentType(fileName),
    fileName,
  }, Boolean(fetched));
  return true;
}

async function fetchNovelCoverForStorage(
  plugin: Plugin,
  sourceUrl: string,
  refresh: boolean,
): Promise<{ body: Blob; contentType: string | null }> {
  if (!refresh) {
    const cached = await readPersistentSourceCover(plugin.id, sourceUrl);
    if (cached) return cached;
  }
  const baseUrl = safePluginBaseUrl(plugin);
  const response = await pluginMediaFetch(sourceUrl, {
    ...(plugin.imageRequestInit ?? {}),
    ...(refresh ? { headers: { ...plugin.imageRequestInit?.headers, "Cache-Control": "no-cache" } } : {}),
    ...(baseUrl ? { contextUrl: baseUrl } : {}),
    sourceId: plugin.id,
  });
  if (!response.ok) {
    throw new Error(
      `novel cover: failed to fetch cover image (${response.status} ${response.statusText})`,
    );
  }

  const contentType = normalizeContentType(
    response.headers.get("content-type"),
  );
  if (contentType && isCoverDocumentContentType(contentType)) {
    throw new Error(
      `novel cover: fetched cover has a non-image content type (${contentType})`,
    );
  }

  const body = await response.blob();
  if (body.size === 0) {
    throw new Error("novel cover: fetched cover image is empty");
  }
  await writePersistentSourceCover(plugin.id, sourceUrl, body, contentType);
  return { body, contentType };
}

export async function resolveStoredNovelCoverSrc(
  novel: NovelCoverStorageInput & { cover?: string | null },
): Promise<string | null> {
  if (!isTauriRuntime()) return null;

  const stored = await runWorkContentStorageOperation(
    novel.pluginId, novel.path, () => readStoredNovelCover(novel),
  );
  if (!stored) return null;

  return storedNovelCoverSrc(stored, novel.id, {
    pluginId: novel.pluginId,
    path: novel.path,
  });
}

function storedNovelCoverSrc(
  stored: StoredNovelCover,
  novelId: number,
  identity?: NovelCoverIdentity,
): string {
  const src = noreaMediaSrc(stored.relativePath);
  const updatedAt = Math.max(0, Math.trunc(stored.modifiedAt));
  const snapshot = getNovelCoverSnapshot(novelId, identity);
  const storageVersion = snapshot
    ? `${updatedAt}-${snapshot}`
    : String(updatedAt);
  return `${src}?v=${storageVersion}`;
}

async function readStoredNovelCover(
  novel: NovelCoverStorageInput,
  includeOverride = true,
): Promise<StoredNovelCover | null> {
  let metadataDirectory = resolvedNovelStorageDir(novel.id);
  if (!metadataDirectory) {
    const { knownNovelMetadataDirectory, readWorkMetadataSyncFile } = await import("../db/work-metadata");
    const identity = { pluginId: novel.pluginId, novelPath: novel.path };
    metadataDirectory = knownNovelMetadataDirectory(identity)
      ?? (await readWorkMetadataSyncFile(identity))?.directory
      ?? null;
  }
  if (!metadataDirectory && novel.sourceNovelId) {
    // The normal plugin-owned directory is deterministic. If an interrupted
    // recovery lost only the DB index, inspect that one exact folder and accept
    // it only when all portable identity fields match. Never scan or guess by title.
    try {
      const directory = novelStorageRelativeDir(novel);
      const { readStoredNovelMetadata } = await import("./work-metadata");
      const stored = await readStoredNovelMetadata(directory);
      if (stored &&
          stored.metadata.identity.pluginId === novel.pluginId &&
          stored.metadata.identity.novelId.toLowerCase() === novel.sourceNovelId.toLowerCase() &&
          stored.metadata.identity.novelPath === novel.path) {
        metadataDirectory = directory;
      }
    } catch {
      // Missing/unindexable storage falls through to source cover recovery.
    }
  }
  // Cover display may consult exact indexed/deterministic paths, but never scans storage.
  if (!metadataDirectory) return null;
  const { workMetadataOperation } = await import("./work-metadata");
  if (includeOverride && novel.coverOverride?.trim()) {
    const { cover: overrideCover } = await workMetadataOperation({ operation: "cover", path: `${metadataDirectory}/override.json` });
    if (overrideCover) {
      return { relativePath: `${metadataDirectory}/${overrideCover.fileName}`, modifiedAt: overrideCover.modifiedAt };
    }
  }
  const { cover } = await workMetadataOperation({ operation: "cover", path: `${metadataDirectory}/novel.json` });
  return cover ? { relativePath: `${metadataDirectory}/${cover.fileName}`, modifiedAt: cover.modifiedAt } : null;
}

async function storeNovelCover(
  novel: NovelCoverStorageInput,
  input: { body: Uint8Array; contentType: string | null; fileName: string } | null,
  preserveExisting = false,
): Promise<void> {
  const metadataDirectory = resolvedNovelStorageDir(novel.id);
  if (!metadataDirectory) throw new Error("novel cover: work metadata directory is not registered");
  const { persistNovelCover } = await import("./work-metadata");
  if (preserveExisting) await persistNovelCover(metadataDirectory, input, { preserveExisting: true });
  else await persistNovelCover(metadataDirectory, input);
}

export function notifyNovelCoverChanged(
  novelId: number,
  identity?: Pick<NovelCoverStorageInput, "pluginId" | "path">,
): void {
  if (novelId <= 0) return;
  clearNovelCoverDisplayCache(novelId, identity);
  novelCoverSnapshots.set(novelId, (novelCoverSnapshots.get(novelId) ?? 0) + 1);
  novelCoverSnapshots.set(0, (novelCoverSnapshots.get(0) ?? 0) + 1);
  if (identity) {
    const key = novelCoverIdentityKey(identity);
    novelCoverSourceIdentitySnapshots.set(
      key,
      (novelCoverSourceIdentitySnapshots.get(key) ?? 0) + 1,
    );
  } else {
    novelCoverUnscopedEpoch += 1;
  }
  notifyNovelCoverSubscriptions(novelId, identity);
}

export function notifyNovelCoverChangedByIdentity(
  identity: Pick<NovelCoverStorageInput, "pluginId" | "path">,
): void {
  clearNovelCoverDisplayCache(undefined, identity);
  const key = novelCoverIdentityKey(identity);
  novelCoverIdentityOnlySnapshots.set(
    key,
    (novelCoverIdentityOnlySnapshots.get(key) ?? 0) + 1,
  );
  novelCoverSourceIdentitySnapshots.set(
    key,
    (novelCoverSourceIdentitySnapshots.get(key) ?? 0) + 1,
  );
  novelCoverSnapshots.set(0, (novelCoverSnapshots.get(0) ?? 0) + 1);
  notifyNovelCoverSubscriptions(0, identity);
}

function getPersistentCoverCacheStorage(): CacheStorage | null {
  try {
    return typeof globalThis.caches !== "undefined" ? globalThis.caches : null;
  } catch {
    return null;
  }
}

function persistentSourceCoverCacheUrl(
  pluginId: string,
  sourceUrl: string,
): string {
  const origin =
    typeof globalThis.location?.origin === "string" &&
    /^https?:\/\//i.test(globalThis.location.origin)
      ? globalThis.location.origin
      : "https://norea-cover-cache.local";
  return `${origin}${PERSISTENT_SOURCE_COVER_PATH_PREFIX}${encodeURIComponent(pluginId)}?url=${encodeURIComponent(sourceUrl)}`;
}

async function openPersistentSourceCoverCache(): Promise<Cache | null> {
  const storage = getPersistentCoverCacheStorage();
  if (!storage) return null;
  try {
    return await storage.open(PERSISTENT_SOURCE_COVER_CACHE_NAME);
  } catch (error) {
    console.debug("[novel-cover] persistent source cover cache unavailable", {
      error,
    });
    return null;
  }
}

async function readPersistentSourceCover(
  pluginId: string,
  sourceUrl: string,
): Promise<{ body: Blob; contentType: string | null } | null> {
  const cache = await openPersistentSourceCoverCache();
  if (!cache) return null;
  const cacheUrl = persistentSourceCoverCacheUrl(pluginId, sourceUrl);
  try {
    const matched = await cache.match(cacheUrl);
    if (!matched) return null;
    const contentType = normalizeContentType(
      matched.headers.get("content-type"),
    );
    if (contentType && isCoverDocumentContentType(contentType)) {
      await cache.delete(cacheUrl).catch(() => undefined);
      return null;
    }
    const body = await matched.blob();
    if (body.size === 0 || body.size > MAX_NOVEL_COVER_BYTES) {
      await cache.delete(cacheUrl).catch(() => undefined);
      return null;
    }
    return { body, contentType };
  } catch (error) {
    console.debug("[novel-cover] persistent source cover read failed", {
      error,
      pluginId,
    });
    return null;
  }
}

async function writePersistentSourceCover(
  pluginId: string,
  sourceUrl: string,
  body: Blob,
  contentType: string | null,
): Promise<void> {
  if (body.size === 0 || body.size > MAX_NOVEL_COVER_BYTES) return;
  const cache = await openPersistentSourceCoverCache();
  if (!cache) return;
  const cacheUrl = persistentSourceCoverCacheUrl(pluginId, sourceUrl);
  try {
    const response = new Response(body, {
      headers: contentType ? { "content-type": contentType } : undefined,
      status: 200,
    });
    await cache.put(cacheUrl, response);
    await trimPersistentSourceCoverCache(cache);
  } catch (error) {
    console.debug("[novel-cover] persistent source cover write failed", {
      error,
      pluginId,
    });
  }
}

async function trimPersistentSourceCoverCache(cache: Cache): Promise<void> {
  if (persistentCoverTrimPromise) {
    await persistentCoverTrimPromise;
    return;
  }
  const run = (async () => {
    const keys = await cache.keys();
    const excess = keys.length - MAX_PERSISTENT_SOURCE_COVERS;
    if (excess <= 0) return;
    for (const key of keys.slice(0, excess)) {
      await cache.delete(key);
    }
  })().finally(() => {
    if (persistentCoverTrimPromise === run) {
      persistentCoverTrimPromise = null;
    }
  });
  persistentCoverTrimPromise = run;
  await run;
}

export async function clearPersistentSourceCoverCache(
  pluginId?: string,
): Promise<void> {
  const storage = getPersistentCoverCacheStorage();
  if (!storage) return;
  try {
    if (!pluginId) {
      await storage.delete(PERSISTENT_SOURCE_COVER_CACHE_NAME);
      return;
    }
    const cache = await storage.open(PERSISTENT_SOURCE_COVER_CACHE_NAME);
    const targetPath = `${PERSISTENT_SOURCE_COVER_PATH_PREFIX}${encodeURIComponent(pluginId)}`;
    const keys = await cache.keys();
    for (const key of keys) {
      try {
        if (new URL(key.url).pathname === targetPath) {
          await cache.delete(key);
        }
      } catch {
        // Ignore malformed cache keys.
      }
    }
  } catch (error) {
    console.debug("[novel-cover] persistent source cover clear failed", {
      error,
      pluginId,
    });
  }
}

function noreaMediaSrc(relativePath: string): string {
  return `${NOREA_MEDIA_SRC_PREFIX}${relativePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function absolutePluginCoverUrl(
  plugin: Plugin,
  cover: string | null | undefined,
): string | null {
  const trimmed = cover?.trim();
  if (!trimmed) return null;

  const absolute = parseUrl(trimmed);
  if (absolute && isFetchableCoverUrl(absolute)) return absolute.href;

  const candidates: string[] = [];
  if (plugin.resolveUrl) {
    try {
      candidates.push(plugin.resolveUrl(trimmed, false));
    } catch {
      // Fall back to the provided cover value and plugin base URL below.
    }
  }
  candidates.push(trimmed);

  for (const candidate of candidates) {
    const parsed = parseUrl(candidate);
    if (parsed && isFetchableCoverUrl(parsed)) return parsed.href;

    const baseUrl = safePluginBaseUrl(plugin);
    if (!baseUrl) continue;
    const relative = parseUrl(candidate, baseUrl);
    if (relative && isFetchableCoverUrl(relative)) return relative.href;
  }
  return null;
}

function parseUrl(value: string, base?: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function isFetchableCoverUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function safePluginBaseUrl(plugin: Plugin): string | null {
  try {
    return getPluginBaseUrl(plugin);
  } catch {
    return null;
  }
}

function throwIfCoverRequestAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Request cancelled", "AbortError");
  }
}

function coverExtension(sourceUrl: string, contentType: string | null): string {
  return (
    extensionFromContentType(contentType) ??
    extensionFromUrl(sourceUrl) ??
    DEFAULT_COVER_EXTENSION
  );
}

function extensionFromContentType(contentType: string | null): string | null {
  switch (contentType) {
    case "image/avif":
      return "avif";
    case "image/bmp":
      return "bmp";
    case "image/gif":
      return "gif";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/svg+xml":
      return "svg";
    case "image/webp":
      return "webp";
    default:
      return null;
  }
}

function extensionFromUrl(url: string): string | null {
  const extension = parseUrl(url)?.pathname.match(/\.([a-z0-9]{1,8})$/i)?.[1];
  const normalized = extension?.toLowerCase() ?? null;
  return normalized && IMAGE_EXTENSIONS.has(normalized) ? normalized : null;
}

function normalizeContentType(contentType: string | null): string | null {
  return contentType?.split(";")[0]?.trim().toLowerCase() || null;
}

function isCoverDocumentContentType(contentType: string): boolean {
  return (
    contentType === "text/html" ||
    contentType === "application/xhtml+xml" ||
    contentType === "application/json"
  );
}
