import { invoke } from "@tauri-apps/api/core";
import {
  deleteAndroidStoragePath,
  inspectAndroidNovelCover,
  writeAndroidStorageBytes,
  writeAndroidStorageText,
} from "./android-storage";
import {
  novelStorageIdentitySuffix,
  novelStorageRelativeDir,
  sourceStorageRelativeDir,
  type ChapterStorageNovelPathInput,
} from "./chapter-storage-path";
import { pluginMediaFetch } from "./http";
import { getPluginBaseUrl } from "./plugins/base-url";
import type { Plugin } from "./plugins/types";
import { isAndroidRuntime, isTauriRuntime } from "./tauri-runtime";

const NOVEL_COVER_MANIFEST_FILE = "cover.json";
const NOVEL_COVER_BASENAME = "cover";
const DEFAULT_COVER_EXTENSION = "img";
const ANDROID_LOCAL_MEDIA_SRC_PREFIX = "/__norea_android_media__/file/";
const WINDOWS_NOREA_MEDIA_SRC_PREFIX = "http://norea-media.localhost/";

type NovelCoverChangeListener = (novelId: number) => void;

const novelCoverChangeListeners = new Set<NovelCoverChangeListener>();
const novelCoverSnapshots = new Map<number, number>();
const novelCoverSaveQueues = new Map<string, NovelCoverSaveQueue>();

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

interface NovelCoverManifest {
  contentType: string | null;
  fileName: string;
  novelPath: string | null;
  sourceId: string | null;
  sourceUrl: string;
  updatedAt: number;
  version: 1;
}

interface NovelCoverReadResultWire {
  manifest: string;
  relativePath: string;
}

interface StoredNovelCover {
  manifest: NovelCoverManifest;
  relativePath: string;
}

interface NovelCoverSaveQueue {
  generations: Map<string, number>;
  latestRequests: Map<string, Promise<void>>;
  pending: number;
  tail: Promise<void>;
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

export function subscribeNovelCoverChanges(
  listener: NovelCoverChangeListener,
): () => void {
  novelCoverChangeListeners.add(listener);
  return () => {
    novelCoverChangeListeners.delete(listener);
  };
}

export function getNovelCoverSnapshot(novelId: number): number {
  return novelCoverSnapshots.get(novelId) ?? 0;
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

  const existing = await readStoredNovelCover(novel, sourceUrl).catch(
    (error: unknown) => {
      console.debug("[novel-cover] stored cover unavailable", {
        error,
        novelId: novel.id,
        pluginId: novel.pluginId,
      });
      return null;
    },
  );
  throwIfCoverRequestAborted(signal);
  if (existing) {
    return {
      dispose: () => undefined,
      src: storedNovelCoverSrc(existing),
    };
  }
  if (!sourceUrl) return null;

  const baseUrl = safePluginBaseUrl(plugin);
  const response = await pluginMediaFetch(sourceUrl, {
    ...(plugin.imageRequestInit ?? {}),
    ...(baseUrl ? { contextUrl: baseUrl } : {}),
    sourceId: plugin.id,
  });
  throwIfCoverRequestAborted(signal);
  if (!response.ok) {
    throw new Error(
      `novel cover: failed to fetch cover image (${response.status} ${response.statusText})`,
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
): Promise<void> {
  if (!isTauriRuntime()) return;

  const sourceUrl = absolutePluginCoverUrl(plugin, cover);
  if (!sourceUrl) return;

  await enqueueNovelCoverSave(plugin, novel, sourceUrl);
  notifyNovelCoverChanged(novel.id);
}

async function enqueueNovelCoverSave(
  plugin: Plugin,
  novel: NovelCoverStorageInput,
  sourceUrl: string,
): Promise<void> {
  const cacheKey = novelCoverSaveQueueKey(novel);
  const requestIdentity = novelCoverSaveRequestIdentity(novel);
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
    await storeNovelCoverFromSource(plugin, novel, sourceUrl);
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

function novelCoverSaveRequestIdentity(novel: NovelCoverStorageInput): string {
  const path = novel.path.trim();
  return JSON.stringify([
    novel.pluginId,
    novel.path,
    path ? null : novel.id,
  ]);
}

function novelCoverSaveQueueKey(novel: NovelCoverStorageInput): string {
  return `${sourceStorageRelativeDir(novel)}/${novelStorageIdentitySuffix(novel)}`;
}

async function storeNovelCoverFromSource(
  plugin: Plugin,
  novel: NovelCoverStorageInput,
  sourceUrl: string,
): Promise<void> {
  const existing = await readStoredNovelCover(novel, null);
  if (
    existing?.manifest.sourceId === novel.pluginId &&
    existing.manifest.novelPath === novel.path &&
    existing.manifest.sourceUrl === sourceUrl
  ) {
    return;
  }

  const baseUrl = safePluginBaseUrl(plugin);
  const response = await pluginMediaFetch(sourceUrl, {
    ...(plugin.imageRequestInit ?? {}),
    ...(baseUrl ? { contextUrl: baseUrl } : {}),
    sourceId: plugin.id,
  });
  if (!response.ok) {
    throw new Error(
      `novel cover: failed to fetch cover image (${response.status} ${response.statusText})`,
    );
  }

  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength === 0) {
    throw new Error("novel cover: fetched cover image is empty");
  }

  const contentType = normalizeContentType(response.headers.get("content-type"));
  const fileName = `${NOVEL_COVER_BASENAME}.${coverExtension(
    sourceUrl,
    contentType,
  )}`;
  await storeNovelCover(
    novel,
    {
      body,
      contentType: contentType ?? mimeTypeFromFileName(fileName),
      fileName,
      sourceUrl,
    },
    existing,
  );
}

export async function resolveStoredNovelCoverSrc(
  novel: NovelCoverStorageInput & { cover?: string | null },
  plugin?: Plugin | null,
): Promise<string | null> {
  if (!isTauriRuntime()) return null;

  const stored = await readStoredNovelCover(
    novel,
    plugin
      ? absolutePluginCoverUrl(plugin, novel.cover)
      : novel.cover?.trim() || null,
  );
  if (!stored) return null;

  return storedNovelCoverSrc(stored);
}

function storedNovelCoverSrc(stored: StoredNovelCover): string {
  return isAndroidRuntime()
    ? androidLocalMediaSrc(stored.relativePath)
    : noreaMediaSrc(stored.relativePath);
}

async function readStoredNovelCover(
  novel: NovelCoverStorageInput,
  expectedSourceUrl: string | null,
): Promise<StoredNovelCover | null> {
  if (isAndroidRuntime()) {
    const result = await inspectAndroidNovelCover({
      expectedSourceUrl,
      novelPath: novel.path,
      novelIdentitySuffix: novelStorageIdentitySuffix(novel),
      preferredNovelDir: novelStorageRelativeDir(novel),
      sourceId: novel.pluginId,
      sourceDir: sourceStorageRelativeDir(novel),
    });
    const manifest = parseNovelCoverManifest(result?.manifest ?? null);
    const relativePath = result?.relativePath.trim();
    return manifest && relativePath ? { manifest, relativePath } : null;
  }

  const result = await invoke<NovelCoverReadResultWire | null>(
    "novel_cover_read_manifest",
    {
      expectedSourceUrl,
      ...novelCoverInvokeArgs(novel),
    },
  );
  const manifest = parseNovelCoverManifest(result?.manifest ?? null);
  const relativePath = result?.relativePath.trim();
  return manifest && relativePath ? { manifest, relativePath } : null;
}

async function storeNovelCover(
  novel: NovelCoverStorageInput,
  input: {
    body: Uint8Array;
    contentType: string;
    fileName: string;
    sourceUrl: string;
  },
  previous: StoredNovelCover | null,
): Promise<void> {
  const manifest = serializeNovelCoverManifest({
    contentType: input.contentType,
    fileName: input.fileName,
    novelPath: novel.path,
    sourceId: novel.pluginId,
    sourceUrl: input.sourceUrl,
    updatedAt: Date.now(),
    version: 1,
  });

  if (isAndroidRuntime()) {
    const targetDir = storedNovelCoverRelativeDir(novel, previous);
    const relativePath = `${targetDir}/${input.fileName}`;
    await writeAndroidStorageBytes(
      relativePath,
      input.body,
      input.contentType,
    );
    await writeAndroidStorageText(
      `${targetDir}/${NOVEL_COVER_MANIFEST_FILE}`,
      manifest,
    );
    if (
      previous &&
      previous.relativePath !== relativePath &&
      previous.manifest.fileName !== input.fileName
    ) {
      await deleteAndroidStoragePath(previous.relativePath).catch(
        () => undefined,
      );
    }
    return;
  }

  await invoke("novel_cover_store", {
    body: Array.from(input.body),
    fileName: input.fileName,
    manifest,
    ...novelCoverInvokeArgs(novel),
  });
}

function storedNovelCoverRelativeDir(
  novel: NovelCoverStorageInput,
  previous: StoredNovelCover | null,
): string {
  if (!previous) return novelStorageRelativeDir(novel);
  if (
    previous.manifest.sourceId !== novel.pluginId ||
    previous.manifest.novelPath !== novel.path
  ) {
    return novelStorageRelativeDir(novel);
  }
  const separator = previous.relativePath.lastIndexOf("/");
  if (separator <= 0) return novelStorageRelativeDir(novel);
  const relativeDir = previous.relativePath.slice(0, separator);
  const sourcePrefix = `${sourceStorageRelativeDir(novel)}/`;
  return relativeDir.startsWith(sourcePrefix) &&
    relativeDir.endsWith(novelStorageIdentitySuffix(novel))
    ? relativeDir
    : novelStorageRelativeDir(novel);
}

function notifyNovelCoverChanged(novelId: number): void {
  if (novelId <= 0) return;
  novelCoverSnapshots.set(novelId, getNovelCoverSnapshot(novelId) + 1);
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

function novelCoverInvokeArgs(
  novel: NovelCoverStorageInput,
): Record<string, unknown> {
  return {
    novelId: novel.id,
    novelName: novel.name,
    novelPath: novel.path,
    sourceId: novel.pluginId,
  };
}

function absolutePluginCoverUrl(
  plugin: Plugin,
  cover: string | null | undefined,
): string | null {
  const trimmed = cover?.trim();
  if (!trimmed) return null;

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

function mimeTypeFromFileName(fileName: string): string {
  const extension = fileName.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
  switch (extension) {
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "gif":
      return "image/gif";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function normalizeContentType(contentType: string | null): string | null {
  return contentType?.split(";")[0]?.trim().toLowerCase() || null;
}

function parseNovelCoverManifest(raw: string | null): NovelCoverManifest | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<NovelCoverManifest>;
    if (
      parsed.version !== 1 ||
      typeof parsed.sourceUrl !== "string" ||
      typeof parsed.fileName !== "string"
    ) {
      return null;
    }
    return {
      contentType:
        typeof parsed.contentType === "string" ? parsed.contentType : null,
      fileName: parsed.fileName,
      novelPath:
        typeof parsed.novelPath === "string" ? parsed.novelPath : null,
      sourceId: typeof parsed.sourceId === "string" ? parsed.sourceId : null,
      sourceUrl: parsed.sourceUrl,
      updatedAt:
        typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      version: 1,
    };
  } catch {
    return null;
  }
}

function serializeNovelCoverManifest(manifest: NovelCoverManifest): string {
  return JSON.stringify(manifest);
}
