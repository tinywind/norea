import type { ChapterStorageNovelPathInput } from "./chapter-storage-path";
import { pluginMediaFetch } from "./http";
import { getPluginBaseUrl } from "./plugins/base-url";
import type { Plugin } from "./plugins/types";
import { isAndroidRuntime, isTauriRuntime } from "./tauri-runtime";
import { resolvedNovelStorageDir } from "./chapter-storage-resolution";
import { coverContentType } from "./work-metadata/schema";

const NOVEL_COVER_BASENAME = "cover";
const DEFAULT_COVER_EXTENSION = "img";
const ANDROID_LOCAL_MEDIA_SRC_PREFIX = "/__norea_android_media__/file/";
const WINDOWS_NOREA_MEDIA_SRC_PREFIX = "http://norea-media.localhost/";
const MAX_UNUSED_COVER_SOURCES = 100;

type NovelCoverChangeListener = (novelId: number) => void;

const novelCoverChangeListeners = new Set<NovelCoverChangeListener>();
const novelCoverSnapshots = new Map<number, number>();
const novelCoverSaveQueues = new Map<string, NovelCoverSaveQueue>();
const novelCoverDisplayCache = new Map<string, NovelCoverDisplayCacheEntry>();
let novelCoverStorageEpoch = 0;

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
}

export interface NovelCoverDisplayInput extends NovelCoverStorageInput {
  cover: string | null;
}

export interface NovelCoverDisplaySource {
  dispose: () => void;
  src: string;
}

export interface NovelCoverDisplayCacheOptions {
  allowSourceFallback?: boolean;
  plugin?: Plugin | null;
}

export interface NovelCoverSaveOptions {
  refresh?: boolean;
}

export function subscribeNovelCoverChanges(
  listener: NovelCoverChangeListener,
): () => void {
  novelCoverChangeListeners.add(listener);
  return () => {
    novelCoverChangeListeners.delete(listener);
  };
}

export function getNovelCoverSnapshot(novelId: number): number {
  return novelCoverStorageEpoch + (novelCoverSnapshots.get(novelId) ?? 0);
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
    cached.novelIds.add(novel.id);
    novelCoverDisplayCache.delete(cacheKey);
    novelCoverDisplayCache.set(cacheKey, cached);
    return cached;
  }

  const entry: NovelCoverDisplayCacheEntry = {
    novelIds: new Set([novel.id]),
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
  for (const [key, entry] of unused.slice(0, Math.max(0, unused.length - MAX_UNUSED_COVER_SOURCES))) {
    novelCoverDisplayCache.delete(key);
    entry.source?.dispose();
  }
}

export function clearNovelCoverDisplayCache(
  novelId?: number,
  identity?: Pick<NovelCoverStorageInput, "pluginId" | "path">,
): void {
  for (const [cacheKey, entry] of novelCoverDisplayCache) {
    const sameIdentity = identity && identity.pluginId === entry.identity.pluginId && identity.path === entry.identity.path;
    if (novelId !== undefined && !entry.novelIds.has(novelId) && !sameIdentity) continue;
    novelCoverDisplayCache.delete(cacheKey);
    entry.controller.abort();
    if (entry.resolved) entry.source?.dispose();
  }
}

export function invalidateAllNovelCoverSources(): void {
  clearNovelCoverDisplayCache();
  novelCoverStorageEpoch += 1;
  for (const listener of novelCoverChangeListeners) {
    listener(0);
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
  const identity = [novel.pluginId, novel.path, novel.path.trim() ? null : novel.id];
  const storedKey = JSON.stringify(["stored", ...identity]);
  if (!options.allowSourceFallback || !plugin || novelCoverDisplayCache.get(storedKey)?.source) {
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
  throwIfCoverRequestAborted(signal);

  const src = URL.createObjectURL(body);
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      URL.revokeObjectURL(src);
    },
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
  if (!sourceUrl) return;

  await enqueueNovelCoverSave(plugin, novel, sourceUrl, options.refresh ?? false);
}

async function enqueueNovelCoverSave(
  plugin: Plugin,
  novel: NovelCoverStorageInput,
  sourceUrl: string,
  refresh: boolean,
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
    const stored = await storeNovelCoverFromSource(plugin, novel, sourceUrl, refresh);
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
  sourceUrl: string,
  refresh: boolean,
): Promise<boolean> {
  if (!refresh && (peekCachedNovelCoverSrc({ ...novel, cover: sourceUrl }) || await readStoredNovelCover(novel))) return false;

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

  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength === 0) {
    throw new Error("novel cover: fetched cover image is empty");
  }

  const fileName = `${NOVEL_COVER_BASENAME}.${coverExtension(
    sourceUrl,
    contentType,
  )}`;
  await storeNovelCover(
    novel,
    {
      body,
      contentType: contentType?.startsWith("image/") ? contentType : coverContentType(fileName),
      fileName,
    },
  );
  return true;
}

export async function resolveStoredNovelCoverSrc(
  novel: NovelCoverStorageInput & { cover?: string | null },
): Promise<string | null> {
  if (!isTauriRuntime()) return null;

  const stored = await readStoredNovelCover(novel);
  if (!stored) return null;

  return storedNovelCoverSrc(stored, novel.id);
}

function storedNovelCoverSrc(stored: StoredNovelCover, novelId: number): string {
  const src = isAndroidRuntime()
    ? androidLocalMediaSrc(stored.relativePath)
    : noreaMediaSrc(stored.relativePath);
  const updatedAt = Math.max(0, Math.trunc(stored.modifiedAt));
  const snapshot = getNovelCoverSnapshot(novelId);
  const storageVersion = snapshot
    ? `${updatedAt}-${snapshot}`
    : String(updatedAt);
  return `${src}?v=${storageVersion}`;
}

async function readStoredNovelCover(
  novel: NovelCoverStorageInput,
): Promise<StoredNovelCover | null> {
  let metadataDirectory = resolvedNovelStorageDir(novel.id);
  if (novel.id <= 0) {
    const { knownNovelMetadataDirectory } = await import("../db/work-metadata");
    metadataDirectory = knownNovelMetadataDirectory({ pluginId: novel.pluginId, novelPath: novel.path }) ?? null;
    // Browse results only inspect indexed work paths; recovery belongs to work discovery.
    if (!metadataDirectory) return null;
  }
  if (!metadataDirectory) return null;
  const { workMetadataOperation } = await import("./work-metadata");
  const { cover } = await workMetadataOperation({ operation: "cover", path: `${metadataDirectory}/novel.json` });
  return cover ? { relativePath: `${metadataDirectory}/${cover.fileName}`, modifiedAt: cover.modifiedAt } : null;
}

async function storeNovelCover(
  novel: NovelCoverStorageInput,
  input: { body: Uint8Array; contentType: string | null; fileName: string },
): Promise<void> {
  const metadataDirectory = resolvedNovelStorageDir(novel.id);
  if (!metadataDirectory) throw new Error("novel cover: work metadata directory is not registered");
  const { persistNovelCover } = await import("./work-metadata");
  await persistNovelCover(metadataDirectory, input);
}

export function notifyNovelCoverChanged(
  novelId: number,
  identity?: Pick<NovelCoverStorageInput, "pluginId" | "path">,
): void {
  if (novelId <= 0) return;
  clearNovelCoverDisplayCache(novelId, identity);
  novelCoverSnapshots.set(novelId, (novelCoverSnapshots.get(novelId) ?? 0) + 1);
  novelCoverSnapshots.set(0, (novelCoverSnapshots.get(0) ?? 0) + 1);
  for (const listener of novelCoverChangeListeners) {
    listener(novelId);
  }
}

function androidLocalMediaSrc(relativePath: string): string {
  const binaryPath = String.fromCharCode(
    ...new TextEncoder().encode(relativePath),
  );
  const encodedPath = btoa(binaryPath)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `${ANDROID_LOCAL_MEDIA_SRC_PREFIX}${encodedPath}`;
}

function noreaMediaSrc(relativePath: string): string {
  return `${WINDOWS_NOREA_MEDIA_SRC_PREFIX}${relativePath
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
