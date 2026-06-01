import { invoke } from "@tauri-apps/api/core";
import {
  androidStoragePathSize,
  deleteAndroidStoragePath,
  readAndroidStorageText,
  writeAndroidStorageBytes,
  writeAndroidStorageText,
} from "./android-storage";
import {
  novelCoverRelativePath,
  novelStorageRelativeDir,
  type ChapterStorageNovelPathInput,
} from "./chapter-storage-path";
import { pluginMediaFetch } from "./http";
import { getPluginBaseUrl } from "./plugins/base-url";
import type { Plugin } from "./plugins/types";
import {
  isAndroidRuntime,
  isTauriRuntime,
  isWindowsRuntime,
} from "./tauri-runtime";

const NOVEL_COVER_MANIFEST_FILE = "cover.json";
const NOVEL_COVER_BASENAME = "cover";
const DEFAULT_COVER_EXTENSION = "img";
const NOREA_MEDIA_SRC_PREFIX = "norea-media://reader-asset/";
const WINDOWS_NOREA_MEDIA_SRC_PREFIX = "http://norea-media.localhost/";

type NovelCoverChangeListener = (novelId: number) => void;

const novelCoverChangeListeners = new Set<NovelCoverChangeListener>();
const novelCoverSnapshots = new Map<number, number>();

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
  sourceUrl: string;
  updatedAt: number;
  version: 1;
}

export interface NovelCoverStorageInput extends ChapterStorageNovelPathInput {
  id: number;
  name: string;
  path: string;
  pluginId: string;
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

export async function saveNovelCoverFromSource(
  plugin: Plugin,
  novel: NovelCoverStorageInput,
  cover: string | null | undefined,
): Promise<void> {
  if (!isTauriRuntime()) return;

  const sourceUrl = absolutePluginCoverUrl(plugin, cover);
  if (!sourceUrl) return;

  const existing = await readStoredNovelCoverManifest(novel);
  if (existing?.sourceUrl === sourceUrl) {
    notifyNovelCoverChanged(novel.id);
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
  notifyNovelCoverChanged(novel.id);
}

export async function resolveStoredNovelCoverSrc(
  novel: NovelCoverStorageInput,
): Promise<string | null> {
  if (!isTauriRuntime()) return null;

  const manifest = await readStoredNovelCoverManifest(novel);
  if (!manifest) return null;

  return noreaMediaSrc(novelCoverRelativePath(novel, manifest.fileName));
}

async function readStoredNovelCoverManifest(
  novel: NovelCoverStorageInput,
): Promise<NovelCoverManifest | null> {
  if (isAndroidRuntime()) {
    const manifest = parseNovelCoverManifest(
      await readAndroidStorageText(novelCoverManifestRelativePath(novel)),
    );
    if (!manifest) return null;
    const size = await androidStoragePathSize(
      novelCoverRelativePath(novel, manifest.fileName),
    ).catch(() => 0);
    return size > 0 ? manifest : null;
  }

  const raw = await invoke<string | null>("novel_cover_read_manifest", {
    ...novelCoverInvokeArgs(novel),
  });
  return parseNovelCoverManifest(raw);
}

async function storeNovelCover(
  novel: NovelCoverStorageInput,
  input: {
    body: Uint8Array;
    contentType: string;
    fileName: string;
    sourceUrl: string;
  },
  previous: NovelCoverManifest | null,
): Promise<void> {
  const manifest = serializeNovelCoverManifest({
    contentType: input.contentType,
    fileName: input.fileName,
    sourceUrl: input.sourceUrl,
    updatedAt: Date.now(),
    version: 1,
  });

  if (isAndroidRuntime()) {
    await writeAndroidStorageBytes(
      novelCoverRelativePath(novel, input.fileName),
      input.body,
      input.contentType,
    );
    await writeAndroidStorageText(novelCoverManifestRelativePath(novel), manifest);
    if (previous?.fileName && previous.fileName !== input.fileName) {
      await deleteAndroidStoragePath(
        novelCoverRelativePath(novel, previous.fileName),
      ).catch(() => undefined);
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

function notifyNovelCoverChanged(novelId: number): void {
  novelCoverSnapshots.set(novelId, getNovelCoverSnapshot(novelId) + 1);
  for (const listener of novelCoverChangeListeners) {
    listener(novelId);
  }
}

function novelCoverManifestRelativePath(
  novel: ChapterStorageNovelPathInput,
): string {
  return `${novelStorageRelativeDir(novel)}/${NOVEL_COVER_MANIFEST_FILE}`;
}

function noreaMediaSrc(relativePath: string): string {
  const prefix = isWindowsRuntime()
    ? WINDOWS_NOREA_MEDIA_SRC_PREFIX
    : NOREA_MEDIA_SRC_PREFIX;
  return `${prefix}${relativePath
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
