import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getChapterById } from "../db/queries/chapter";
import { getNovelById } from "../db/queries/novel";
import {
  androidStorageZipEntryExists,
  archiveAndroidStorageDirectory,
  androidStoragePathSize,
  clearAndroidStorageRoot,
  deleteAndroidStoragePath,
  extractAndroidStorageZip,
  readAndroidStorageDataUrl,
  readAndroidStorageText,
  readAndroidStorageZipEntryDataUrl,
  writeAndroidStorageBytes,
  writeAndroidStorageText,
} from "./android-storage";
import {
  chapterMediaArchiveRelativePath,
  chapterMediaDirectoryRelativePath,
  chapterMediaManifestRelativePath,
  chapterMediaRelativePath,
  type ChapterStorageChapterPathInput,
  type ChapterStorageNovelPathInput,
} from "./chapter-storage-path";
import { pluginMediaFetch, type HttpInit } from "./http";
import {
  cancelNativeStream,
  createNativeStream,
  finishNativeStream,
  writeNativeStream,
  type NativeStreamInfo,
} from "./native-stream";
import type { ScraperExecutorId } from "./tasks/scraper-queue";
import { isAndroidRuntime, isTauriRuntime } from "./tauri-runtime";

const LOCAL_MEDIA_SRC_PREFIX = "norea-media://chapter/";
const CHAPTER_MEDIA_STREAM_DOMAIN = "chapter-media";
const LOCAL_CHAPTER_MEDIA_SRC_PATTERN =
  /norea-media:\/\/chapter\/[1-9]\d*\/[A-Za-z0-9._-]+(?=$|[^A-Za-z0-9._/-])/g;
const LOCAL_CHAPTER_MEDIA_SRC_DETAIL_PATTERN =
  /^norea-media:\/\/chapter\/([1-9]\d*)\/([A-Za-z0-9._-]+)$/;
const MEDIA_SOURCE_URL_ATTRIBUTE = "data-norea-media-source-url";
const MEDIA_SRCSET_SOURCE_ATTRIBUTE = "data-norea-media-srcset-source";
const MEDIA_LAZY_SRC_ATTRIBUTES = [
  "data-src",
  "data-original",
  "data-lazy-src",
  "data-orig-src",
] as const;
const MEDIA_SRC_ATTRIBUTES = [
  "src",
  "poster",
  "data",
  "href",
  "xlink:href",
  ...MEDIA_LAZY_SRC_ATTRIBUTES,
] as const;
type MediaSrcAttribute = (typeof MEDIA_SRC_ATTRIBUTES)[number];
const MEDIA_PRIMARY_SOURCE_ELEMENTS = [
  "img",
  "video",
  "audio",
  "source",
  "embed",
  "track",
] as const;
const MEDIA_LAZY_SOURCE_ELEMENTS = ["img", "video", "audio", "source"] as const;
const MEDIA_SOURCE_TARGETS: Array<{
  attribute: MediaSrcAttribute;
  selector: string;
}> = [
  ...MEDIA_PRIMARY_SOURCE_ELEMENTS.map((element) => ({
    attribute: "src" as const,
    selector: `${element}[src]`,
  })),
  ...MEDIA_LAZY_SOURCE_ELEMENTS.flatMap((element) =>
    MEDIA_LAZY_SRC_ATTRIBUTES.map((attribute) => ({
      attribute,
      selector: `${element}[${attribute}]`,
    })),
  ),
  { attribute: "poster", selector: "video[poster]" },
  { attribute: "data", selector: "object[data]" },
  { attribute: "href", selector: 'link[href][rel~="preload"][as="image"]' },
  { attribute: "href", selector: 'link[href][rel~="preload"][as="video"]' },
  { attribute: "href", selector: 'link[href][rel~="preload"][as="audio"]' },
  { attribute: "href", selector: "image[href]" },
  { attribute: "xlink:href", selector: "image[xlink\\:href]" },
  { attribute: "href", selector: "use[href]" },
  { attribute: "xlink:href", selector: "use[xlink\\:href]" },
];
const MEDIA_SOURCE_SELECTOR = [
  ...MEDIA_SOURCE_TARGETS.map((target) => target.selector),
  "img[srcset]",
  "source[srcset]",
].join(",");
const MEDIA_STYLE_SELECTOR = "[style]";
const MEDIA_PATCH_SELECTOR = [MEDIA_SOURCE_SELECTOR, MEDIA_STYLE_SELECTOR].join(
  ",",
);
const MEDIA_PATCH_ATTRIBUTES = [
  "src",
  "srcset",
  "poster",
  "data",
  "href",
  "xlink:href",
  "data-src",
  "data-original",
  "data-lazy-src",
  "data-orig-src",
  "style",
] as const;
const STYLE_URL_PATTERN =
  /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*?))\s*\)/gi;
const DEFAULT_MEDIA_EXTENSION = "bin";
const DEFAULT_MEDIA_ACCEPT =
  "image/avif,image/webp,image/apng,image/svg+xml,image/*,video/*,audio/*,*/*;q=0.8";
const REMOTE_MEDIA_PENDING_PLACEHOLDER_SRC =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%221000%22%20height%3D%221400%22%20viewBox%3D%220%200%201000%201400%22%2F%3E";
const REMOTE_MEDIA_EMPTY_PLACEHOLDER_SRC =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%221%22%20height%3D%221%22%2F%3E";
const CHAPTER_MEDIA_MANIFEST_FILE = "manifest.json";
type ChapterMediaRequestInit = Pick<HttpInit, "body" | "headers" | "method">;

interface CacheChapterMediaOptions {
  baseUrl?: string | null;
  chapterId: number;
  chapterName?: string | null;
  chapterNumber?: string | null;
  chapterPosition?: number | null;
  contextUrl?: string;
  html: string;
  novelId?: number;
  novelName?: string | null;
  novelPath?: string | null;
  onHtmlUpdate?: (html: string) => Promise<void> | void;
  onMediaPatch?: (patches: ChapterMediaElementPatch[]) => Promise<void> | void;
  onProgress?: (progress: { current: number; total: number }) => void;
  previousHtml?: string | null;
  requestInit?: ChapterMediaRequestInit;
  repair?: boolean;
  scraperExecutor?: ScraperExecutorId;
  signal?: AbortSignal;
  sourceId?: string;
}

export interface ChapterMediaElementPatch {
  attributes: Record<string, string>;
  index: number;
  sourceAttributes?: Record<string, string>;
}

export interface ChapterMediaFailure {
  message: string;
  status?: number;
  url: string;
}

export interface CacheChapterMediaResult {
  archiveFailure?: string;
  html: string;
  mediaFailures: ChapterMediaFailure[];
  mediaBytes: number;
  storedMediaCount: number;
}

export interface EmbeddedChapterMediaResource {
  bytes: Uint8Array | readonly number[];
  contentType?: string | null;
  fileName: string;
  placeholder: string;
  sourcePath?: string;
}

interface ChapterMediaStoreInput {
  body: Uint8Array | readonly number[];
  chapterId: number;
  chapterName?: string | null;
  chapterNumber?: string | null;
  chapterPosition?: number | null;
  contentType?: string | null;
  fileName: string;
  novelId?: number;
  novelName?: string | null;
  novelPath?: string | null;
  sourceId?: string;
}

interface ChapterMediaArchiveInput {
  chapterId: number;
  chapterName?: string | null;
  chapterNumber?: string | null;
  chapterPosition?: number | null;
  novelId?: number;
  novelName?: string | null;
  novelPath?: string | null;
  sourceId?: string;
}

export interface ChapterMediaStorageContext {
  chapterId: number;
  chapterName?: string | null;
  chapterNumber?: string | null;
  chapterPosition?: number | null;
  novelId?: number | null;
  novelName?: string | null;
  novelPath?: string | null;
  sourceId?: string | null;
}

interface ChapterMediaManifestFile {
  bytes: number;
  contentType?: string;
  fileName: string;
  path: string;
  sourceUrl: string;
  status: "remote" | "stored";
  updatedAt: number;
}

interface ChapterMediaManifest {
  media: {
    files: ChapterMediaManifestFile[];
  };
  updatedAt: number;
  version: 1;
}

interface MediaSrcTarget {
  attribute: MediaSrcAttribute;
  element: Element;
  slotIndex: number;
  url: string;
}

interface MediaStyleUrl {
  source: string;
  url: string;
}

interface MediaStyleTarget {
  element: Element;
  slotIndex: number;
  style: string;
  urls: MediaStyleUrl[];
}

interface SrcsetCandidate {
  descriptor: string;
  source: string;
}

interface MediaSrcsetTarget {
  candidates: SrcsetCandidate[];
  element: Element;
  slotIndex: number;
}

interface ExistingMediaSlots {
  srcSlots: Array<string | null>;
  srcsetSlots: Array<Array<string | null>>;
  styleSlots: Array<Array<string | null>>;
}

function isSkippableMediaSource(src: string): boolean {
  return (
    src === "" ||
    src.startsWith("#") ||
    src.startsWith(LOCAL_MEDIA_SRC_PREFIX) ||
    /^(?:data|blob|file|asset):/i.test(src)
  );
}

function absoluteMediaUrl(
  src: string,
  baseUrl?: string | null,
): string | null {
  const trimmed = src.trim();
  if (isSkippableMediaSource(trimmed)) return null;

  try {
    const url = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function mediaOutputAttribute(attribute: MediaSrcAttribute): string {
  return attribute.startsWith("data-") ? "src" : attribute;
}

function shouldCollectMediaAttribute(
  element: Element,
  attribute: MediaSrcAttribute,
): boolean {
  if (typeof element.matches !== "function") return true;
  return MEDIA_SOURCE_TARGETS.some(
    (target) =>
      target.attribute === attribute && element.matches(target.selector),
  );
}

function collectStyleMediaUrls(
  style: string,
  baseUrl?: string | null,
): MediaStyleUrl[] {
  const urls: MediaStyleUrl[] = [];

  for (const match of style.matchAll(STYLE_URL_PATTERN)) {
    const source = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    const url = absoluteMediaUrl(source, baseUrl);
    if (!url) continue;
    urls.push({ source, url });
  }

  return urls;
}

function localStyleMediaSources(style: string): string[] {
  return styleMediaSlots(style).filter((src): src is string => src !== null);
}

function styleMediaSlots(style: string): Array<string | null> {
  return [...style.matchAll(STYLE_URL_PATTERN)]
    .map((match) => (match[1] ?? match[2] ?? match[3] ?? "").trim())
    .map((source) => localMediaSrc(source));
}

function rewriteStyleMediaUrls(
  style: string,
  baseUrl: string | null | undefined,
  replacementForUrl: (url: string) => string | null,
): string {
  return style.replace(
    STYLE_URL_PATTERN,
    (match, doubleQuoted, singleQuoted, unquoted) => {
      const source = String(
        doubleQuoted ?? singleQuoted ?? unquoted ?? "",
      ).trim();
      const url = absoluteMediaUrl(source, baseUrl);
      if (!url) return match;
      const replacement = replacementForUrl(url);
      return replacement === null ? match : `url("${replacement}")`;
    },
  );
}

function extensionFromContentType(contentType: string | null): string | null {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  switch (mediaType) {
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
  try {
    const extension = new URL(url).pathname.match(
      /\.([a-z0-9]{1,8})$/i,
    )?.[1];
    return extension?.toLowerCase() ?? null;
  } catch {
    return null;
  }
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

function safeFileStem(value: string, fallback: string): string {
  const stem = value
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return stem === "" || stem === "." || stem === ".." ? fallback : stem;
}

function uniqueFileName(fileName: string, usedFileNames: Set<string>): string {
  if (!usedFileNames.has(fileName)) {
    usedFileNames.add(fileName);
    return fileName;
  }
  const extension = fileName.match(/\.([A-Za-z0-9]{1,8})$/)?.[0] ?? "";
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  for (let index = 2; ; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!usedFileNames.has(candidate)) {
      usedFileNames.add(candidate);
      return candidate;
    }
  }
}

function mediaFileName(
  index: number,
  url: string,
  contentType: string | null,
  usedFileNames: Set<string>,
) {
  let leaf = "";
  try {
    const segments = new URL(url).pathname.split("/");
    leaf = decodeURIComponent(segments[segments.length - 1] ?? "");
  } catch {
    leaf = "";
  }

  const extension =
    extensionFromUrl(url) ??
    extensionFromContentType(contentType) ??
    DEFAULT_MEDIA_EXTENSION;
  const order = String(index + 1).padStart(4, "0");
  const stem = safeFileStem(leaf, `image-${index + 1}`);
  return uniqueFileName(`${order}-${stem}.${extension}`, usedFileNames);
}

function bytesFromArrayBuffer(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer);
}

function chapterMediaByteLength(bytes: Uint8Array | readonly number[]): number {
  return bytes.length;
}

function chapterMediaBytesToArray(
  bytes: Uint8Array | readonly number[],
): number[] {
  return Array.from(bytes);
}

function localChapterMediaSrc(
  chapterId: number,
  fileName: string,
): string {
  return `${LOCAL_MEDIA_SRC_PREFIX}${chapterId}/${fileName}`;
}

function androidChapterMediaRelativePath(
  chapterId: number,
  fileName?: string,
): string {
  const base = `chapter-media/${chapterId}/media`;
  return fileName ? `${base}/${fileName}` : base;
}

function parseLocalChapterMediaSrc(src: string): {
  chapterId: number;
  fileName: string;
} | null {
  const match = src.match(LOCAL_CHAPTER_MEDIA_SRC_DETAIL_PATTERN);
  if (!match) return null;
  return {
    chapterId: Number(match[1]),
    fileName: match[2]!,
  };
}

function hasStorageContext(
  context: ChapterMediaStorageContext | null | undefined,
): context is ChapterMediaStorageContext & {
  novelPath: string;
  sourceId: string;
} {
  return !!context?.novelPath?.trim() && !!context.sourceId?.trim();
}

function storageNovelPathInput(
  context: ChapterMediaStorageContext,
): ChapterStorageNovelPathInput {
  return {
    id: context.novelId,
    name: context.novelName,
    path: context.novelPath,
    pluginId: context.sourceId,
  };
}

function storageChapterPathInput(
  context: ChapterMediaStorageContext,
): ChapterStorageChapterPathInput {
  return {
    chapterNumber: context.chapterNumber,
    id: context.chapterId,
    name: context.chapterName,
    position: context.chapterPosition,
  };
}

async function storageContextForChapter(
  chapterId: number,
): Promise<ChapterMediaStorageContext | null> {
  const chapter = await getChapterById(chapterId);
  if (!chapter) return null;
  const novel = await getNovelById(chapter.novelId);
  if (!novel) return null;
  return {
    chapterId,
    chapterName: chapter.name,
    chapterNumber: chapter.chapterNumber,
    chapterPosition: chapter.position,
    novelId: novel.id,
    novelName: novel.name,
    novelPath: novel.path,
    sourceId: novel.pluginId,
  };
}

function androidChapterMediaRelativePathForContext(
  context: ChapterMediaStorageContext | null | undefined,
  fileName?: string,
): string {
  if (!hasStorageContext(context)) {
    return androidChapterMediaRelativePath(
      context?.chapterId ?? 0,
      fileName,
    );
  }
  return chapterMediaRelativePath(
    storageNovelPathInput(context),
    storageChapterPathInput(context),
    fileName,
  );
}

function uniqueAndroidStoragePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function androidChapterMediaRelativePathCandidates(
  context: ChapterMediaStorageContext | null | undefined,
  fileName?: string,
): string[] {
  const preferred = androidChapterMediaRelativePathForContext(
    context,
    fileName,
  );
  if (!hasStorageContext(context)) return [preferred];
  return uniqueAndroidStoragePaths([
    preferred,
    androidChapterMediaRelativePath(context.chapterId, fileName),
  ]);
}

function androidChapterMediaArchiveRelativePathForContext(
  context: ChapterMediaStorageContext | null | undefined,
): string {
  if (!hasStorageContext(context)) {
    return `chapter-media/${context?.chapterId ?? 0}/media.zip`;
  }
  return chapterMediaArchiveRelativePath(
    storageNovelPathInput(context),
    storageChapterPathInput(context),
  );
}

function androidChapterMediaArchiveRelativePathCandidates(
  context: ChapterMediaStorageContext | null | undefined,
): string[] {
  const preferred = androidChapterMediaArchiveRelativePathForContext(context);
  if (!hasStorageContext(context)) return [preferred];
  return uniqueAndroidStoragePaths([
    preferred,
    `chapter-media/${context.chapterId}/media.zip`,
  ]);
}

function androidChapterMediaManifestRelativePath(
  context: ChapterMediaStorageContext | null | undefined,
): string {
  if (!hasStorageContext(context)) {
    return `chapter-media/${context?.chapterId ?? 0}/${CHAPTER_MEDIA_MANIFEST_FILE}`;
  }
  return chapterMediaManifestRelativePath(
    storageNovelPathInput(context),
    storageChapterPathInput(context),
  );
}

function androidChapterMediaManifestRelativePathCandidates(
  context: ChapterMediaStorageContext | null | undefined,
): string[] {
  const preferred = androidChapterMediaManifestRelativePath(context);
  if (!hasStorageContext(context)) return [preferred];
  return uniqueAndroidStoragePaths([
    preferred,
    `chapter-media/${context.chapterId}/${CHAPTER_MEDIA_MANIFEST_FILE}`,
  ]);
}

function emptyChapterMediaManifest(): ChapterMediaManifest {
  return {
    media: {
      files: [],
    },
    updatedAt: 0,
    version: 1,
  };
}

function parseChapterMediaManifest(raw: string | null): ChapterMediaManifest {
  if (!raw) return emptyChapterMediaManifest();
  try {
    const parsed = JSON.parse(raw) as Partial<ChapterMediaManifest>;
    const files = Array.isArray(parsed.media?.files)
      ? parsed.media.files
      : [];
    return {
      media: {
        files: files.filter(
          (file): file is ChapterMediaManifestFile =>
            typeof file === "object" &&
            file !== null &&
            typeof file.bytes === "number" &&
            typeof file.fileName === "string" &&
            typeof file.path === "string" &&
            typeof file.sourceUrl === "string" &&
            (file.status === "remote" || file.status === "stored") &&
            typeof file.updatedAt === "number",
        ),
      },
      updatedAt:
        typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      version: 1,
    };
  } catch {
    return emptyChapterMediaManifest();
  }
}

function serializeChapterMediaManifest(
  files: ChapterMediaManifestFile[],
): string {
  const now = Date.now();
  return `${JSON.stringify(
    {
      media: {
        files: [...files].sort((left, right) =>
          left.fileName.localeCompare(right.fileName),
        ),
      },
      updatedAt: now,
      version: 1,
    } satisfies ChapterMediaManifest,
    null,
    2,
  )}\n`;
}

async function writeChapterMediaManifest({
  context,
  files,
}: {
  context: ChapterMediaStorageContext;
  files: ChapterMediaManifestFile[];
}): Promise<void> {
  const manifestPath = androidChapterMediaManifestRelativePath(context);
  if (isAndroidRuntime()) {
    await writeAndroidStorageText(
      manifestPath,
      serializeChapterMediaManifest(files),
    );
    return;
  }
  await invoke("chapter_media_write_manifest", {
    files,
    ...(context.chapterId ? { chapterId: context.chapterId } : {}),
    ...(context.chapterName ? { chapterName: context.chapterName } : {}),
    ...(context.chapterNumber ? { chapterNumber: context.chapterNumber } : {}),
    ...(context.chapterPosition
      ? { chapterPosition: context.chapterPosition }
      : {}),
    ...(context.novelId ? { novelId: context.novelId } : {}),
    ...(context.novelName ? { novelName: context.novelName } : {}),
    ...(context.novelPath ? { novelPath: context.novelPath } : {}),
    ...(context.sourceId ? { sourceId: context.sourceId } : {}),
  });
}

async function readChapterMediaManifest(
  context: ChapterMediaStorageContext,
): Promise<ChapterMediaManifest> {
  if (isAndroidRuntime()) {
    for (const manifestPath of androidChapterMediaManifestRelativePathCandidates(
      context,
    )) {
      const raw = await readAndroidStorageText(manifestPath);
      if (raw !== null) return parseChapterMediaManifest(raw);
    }
    return emptyChapterMediaManifest();
  }
  const raw = await invoke<string | null>("chapter_media_read_manifest", {
    chapterId: context.chapterId,
    ...(context.chapterName ? { chapterName: context.chapterName } : {}),
    ...(context.chapterNumber ? { chapterNumber: context.chapterNumber } : {}),
    ...(context.chapterPosition
      ? { chapterPosition: context.chapterPosition }
      : {}),
    ...(context.novelId ? { novelId: context.novelId } : {}),
    ...(context.novelName ? { novelName: context.novelName } : {}),
    ...(context.novelPath ? { novelPath: context.novelPath } : {}),
    ...(context.sourceId ? { sourceId: context.sourceId } : {}),
  });
  return parseChapterMediaManifest(raw);
}

async function androidRelativePathsFromLocalMediaSrc(
  src: string,
  context?: ChapterMediaStorageContext,
): Promise<string[]> {
  const parsed = parseLocalChapterMediaSrc(src);
  if (!parsed) return [];
  const resolvedContext =
    context?.chapterId === parsed.chapterId
      ? context
      : await storageContextForChapter(parsed.chapterId);
  if (hasStorageContext(resolvedContext)) {
    return androidChapterMediaRelativePathCandidates(
      resolvedContext,
      parsed.fileName,
    );
  }
  return [androidChapterMediaRelativePath(parsed.chapterId, parsed.fileName)];
}

export function localChapterMediaSources(html: string): string[] {
  return [...new Set(html.match(LOCAL_CHAPTER_MEDIA_SRC_PATTERN) ?? [])];
}

export function hasRemoteChapterMedia(
  html: string,
  baseUrl?: string | null,
): boolean {
  if (typeof document === "undefined") return false;
  const template = document.createElement("template");
  template.innerHTML = html;
  return collectMediaTargets(template.content, baseUrl).urls.length > 0;
}

export async function getStoredChapterMediaBytes(
  html: string,
  context?: ChapterMediaStorageContext,
): Promise<number> {
  if (!isTauriRuntime()) return 0;
  const mediaSrcs = localChapterMediaSources(html);
  if (mediaSrcs.length === 0) return 0;
  const firstMedia = mediaSrcs[0]
    ? parseLocalChapterMediaSrc(mediaSrcs[0])
    : null;
  const resolvedContext =
    context ??
    (firstMedia
      ? await storageContextForChapter(firstMedia.chapterId)
      : undefined);
  if (isAndroidRuntime()) {
    let total = 0;
    const countedArchives = new Set<string>();
    for (const source of mediaSrcs) {
      const relativePaths = await androidRelativePathsFromLocalMediaSrc(
        source,
        resolvedContext ?? undefined,
      );
      let hasDirectMedia = false;
      for (const path of relativePaths) {
        const directSize = await androidStoragePathSize(path);
        if (directSize > 0) {
          total += directSize;
          hasDirectMedia = true;
          break;
        }
      }
      if (hasDirectMedia) continue;

      const parsed = parseLocalChapterMediaSrc(source);
      if (!parsed) continue;
      for (const archivePath of androidChapterMediaArchiveRelativePathCandidates(
        resolvedContext,
      )) {
        if (countedArchives.has(archivePath)) continue;
        if (!(await androidStorageZipEntryExists(archivePath, parsed.fileName))) {
          continue;
        }
        total += await androidStoragePathSize(archivePath);
        countedArchives.add(archivePath);
        break;
      }
    }
    return total;
  }
  return invoke<number>("chapter_media_total_size", {
    mediaSrcs,
    ...(resolvedContext?.chapterName
      ? { chapterName: resolvedContext.chapterName }
      : {}),
    ...(resolvedContext?.chapterNumber
      ? { chapterNumber: resolvedContext.chapterNumber }
      : {}),
    ...(resolvedContext?.chapterPosition
      ? { chapterPosition: resolvedContext.chapterPosition }
      : {}),
    ...(resolvedContext?.novelId ? { novelId: resolvedContext.novelId } : {}),
    ...(resolvedContext?.novelName
      ? { novelName: resolvedContext.novelName }
      : {}),
    ...(resolvedContext?.novelPath
      ? { novelPath: resolvedContext.novelPath }
      : {}),
    ...(resolvedContext?.sourceId ? { sourceId: resolvedContext.sourceId } : {}),
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException(
      "Chapter media download was cancelled.",
      "AbortError",
    );
  }
}

function chapterMediaStoreArgs({
  chapterId,
  chapterName,
  chapterNumber,
  chapterPosition,
  fileName,
  novelId,
  novelName,
  novelPath,
  sourceId,
}: Omit<ChapterMediaStoreInput, "body" | "contentType">): Record<string, unknown> {
  return {
    chapterId,
    ...(chapterName ? { chapterName } : {}),
    ...(chapterNumber ? { chapterNumber } : {}),
    ...(chapterPosition ? { chapterPosition } : {}),
    fileName,
    ...(novelId ? { novelId } : {}),
    ...(novelName ? { novelName } : {}),
    ...(novelPath ? { novelPath } : {}),
    ...(sourceId ? { sourceId } : {}),
  };
}

function isNativeStreamInfo(value: unknown): value is NativeStreamInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as NativeStreamInfo).handle === "string" &&
    (value as NativeStreamInfo).handle.trim() !== ""
  );
}

function isNativeStoreFallbackError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /native stream unavailable|chapter media handle store unavailable|unknown command|command .*not found|not found.*command|not registered/i.test(
    message,
  );
}

async function storeChapterMediaLegacy(
  input: ChapterMediaStoreInput,
): Promise<string> {
  return invoke<string>("chapter_media_store", {
    body: chapterMediaBytesToArray(input.body),
    ...chapterMediaStoreArgs(input),
  });
}

async function storeChapterMediaHandle(
  input: ChapterMediaStoreInput,
): Promise<string> {
  let handle: string | null = null;
  try {
    const stream = await createNativeStream({
      domain: CHAPTER_MEDIA_STREAM_DOMAIN,
      maxBytes: Math.max(chapterMediaByteLength(input.body), 1),
    });
    if (!isNativeStreamInfo(stream)) {
      throw new Error("native stream unavailable");
    }
    handle = stream.handle;
    await writeNativeStream(handle, input.body);
    await finishNativeStream(handle);
    const storedSrc = await invoke<string>("chapter_media_store_handle", {
      handle,
      ...chapterMediaStoreArgs(input),
    });
    if (typeof storedSrc !== "string" || storedSrc.trim() === "") {
      throw new Error("chapter media handle store unavailable");
    }
    handle = null;
    return storedSrc;
  } catch (error) {
    if (handle) {
      await cancelNativeStream(handle).catch(() => undefined);
    }
    if (isNativeStoreFallbackError(error)) {
      return storeChapterMediaLegacy(input);
    }
    throw error;
  }
}

async function storeChapterMedia({
  body,
  chapterId,
  chapterName,
  chapterNumber,
  chapterPosition,
  contentType,
  fileName,
  novelId,
  novelName,
  novelPath,
  sourceId,
}: ChapterMediaStoreInput): Promise<string> {
  if (isAndroidRuntime()) {
    const src = localChapterMediaSrc(chapterId, fileName);
    const context = {
      chapterId,
      chapterName,
      chapterNumber,
      chapterPosition,
      novelId,
      novelName,
      novelPath,
      sourceId,
    };
    const relativePath = androidChapterMediaRelativePathForContext(
      context,
      fileName,
    );
    await writeAndroidStorageBytes(
      relativePath,
      body,
      contentType ?? mimeTypeFromFileName(fileName),
    );
    return src;
  }
  return storeChapterMediaHandle({
    body,
    chapterId,
    chapterName,
    chapterNumber,
    chapterPosition,
    contentType,
    fileName,
    novelId,
    novelName,
    novelPath,
    sourceId,
  });
}

async function archiveChapterMediaCache({
  chapterId,
  chapterName,
  chapterNumber,
  chapterPosition,
  novelId,
  novelName,
  novelPath,
  sourceId,
}: ChapterMediaArchiveInput): Promise<number> {
  if (isAndroidRuntime()) {
    const context = {
      chapterId,
      chapterName,
      chapterNumber,
      chapterPosition,
      novelId,
      novelName,
      novelPath,
      sourceId,
    };
    return archiveAndroidStorageDirectory(
      androidChapterMediaRelativePathForContext(context),
      androidChapterMediaArchiveRelativePathForContext(context),
    );
  }
  return invoke<number>("chapter_media_archive_cache", {
    chapterId,
    ...(chapterName ? { chapterName } : {}),
    ...(chapterNumber ? { chapterNumber } : {}),
    ...(chapterPosition ? { chapterPosition } : {}),
    ...(novelId ? { novelId } : {}),
    ...(novelName ? { novelName } : {}),
    ...(novelPath ? { novelPath } : {}),
    ...(sourceId ? { sourceId } : {}),
  });
}

async function prepareChapterMediaWorkspace(
  context: ChapterMediaStorageContext,
  repair: boolean,
): Promise<void> {
  if (isAndroidRuntime()) {
    const mediaPath = androidChapterMediaRelativePathForContext(context);
    if (repair) {
      for (const archivePath of androidChapterMediaArchiveRelativePathCandidates(
        context,
      )) {
        await extractAndroidStorageZip(archivePath, mediaPath);
      }
    } else {
      for (const path of androidChapterMediaRelativePathCandidates(context)) {
        await deleteAndroidStoragePath(path);
      }
      for (const archivePath of androidChapterMediaArchiveRelativePathCandidates(
        context,
      )) {
        await deleteAndroidStoragePath(archivePath);
      }
      for (const manifestPath of androidChapterMediaManifestRelativePathCandidates(
        context,
      )) {
        await deleteAndroidStoragePath(manifestPath);
      }
    }
    return;
  }
  await invoke("chapter_media_prepare_workspace", {
    repair,
    chapterId: context.chapterId,
    ...(context.chapterName ? { chapterName: context.chapterName } : {}),
    ...(context.chapterNumber ? { chapterNumber: context.chapterNumber } : {}),
    ...(context.chapterPosition
      ? { chapterPosition: context.chapterPosition }
      : {}),
    ...(context.novelId ? { novelId: context.novelId } : {}),
    ...(context.novelName ? { novelName: context.novelName } : {}),
    ...(context.novelPath ? { novelPath: context.novelPath } : {}),
    ...(context.sourceId ? { sourceId: context.sourceId } : {}),
  });
}

async function cleanupChapterMediaWorkspace(
  context: ChapterMediaStorageContext,
): Promise<void> {
  if (isAndroidRuntime()) {
    for (const path of androidChapterMediaRelativePathCandidates(context)) {
      await deleteAndroidStoragePath(path);
    }
    return;
  }
  await invoke("chapter_media_cleanup_workspace", {
    chapterId: context.chapterId,
    ...(context.chapterName ? { chapterName: context.chapterName } : {}),
    ...(context.chapterNumber ? { chapterNumber: context.chapterNumber } : {}),
    ...(context.chapterPosition
      ? { chapterPosition: context.chapterPosition }
      : {}),
    ...(context.novelId ? { novelId: context.novelId } : {}),
    ...(context.novelName ? { novelName: context.novelName } : {}),
    ...(context.novelPath ? { novelPath: context.novelPath } : {}),
    ...(context.sourceId ? { sourceId: context.sourceId } : {}),
  });
}

function parseSrcset(srcset: string): SrcsetCandidate[] {
  return srcset
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .map((candidate) => {
      const [source = "", ...descriptor] = candidate.split(/\s+/);
      return {
        source,
        descriptor: descriptor.join(" "),
      };
    })
    .filter((candidate) => candidate.source !== "");
}

function formatSrcset(candidates: SrcsetCandidate[]): string {
  return candidates
    .map((candidate) =>
      candidate.descriptor
        ? `${candidate.source} ${candidate.descriptor}`
        : candidate.source,
    )
    .join(", ");
}

function addUniqueUrl(urls: string[], url: string): void {
  if (!urls.includes(url)) {
    urls.push(url);
  }
}

function localMediaSrc(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed?.startsWith(LOCAL_MEDIA_SRC_PREFIX) ? trimmed : null;
}

function fileNameFromLocalMediaSrc(
  src: string,
  chapterId: number,
): string | null {
  const match = src.match(LOCAL_CHAPTER_MEDIA_SRC_DETAIL_PATTERN);
  if (!match || Number(match[1]) !== chapterId) return null;
  return match[2] ?? null;
}

function collectMediaTargets(
  root: DocumentFragment,
  baseUrl?: string | null,
): {
  srcTargets: MediaSrcTarget[];
  srcsetTargets: MediaSrcsetTarget[];
  styleTargets: MediaStyleTarget[];
  urls: string[];
} {
  const srcTargets: MediaSrcTarget[] = [];
  const srcsetTargets: MediaSrcsetTarget[] = [];
  const styleTargets: MediaStyleTarget[] = [];
  const urls: string[] = [];
  let srcSlotIndex = 0;
  let srcsetSlotIndex = 0;
  let styleSlotIndex = 0;

  for (const element of root.querySelectorAll<Element>(MEDIA_SOURCE_SELECTOR)) {
    for (const attribute of MEDIA_SRC_ATTRIBUTES) {
      if (!shouldCollectMediaAttribute(element, attribute)) continue;
      const rawSource = element.getAttribute(attribute);
      if (rawSource === null) continue;
      const url = absoluteMediaUrl(rawSource, baseUrl);
      const slotIndex = srcSlotIndex;
      srcSlotIndex += 1;
      if (url) {
        srcTargets.push({ attribute, element, slotIndex, url });
        addUniqueUrl(urls, url);
      }
    }

    const rawSrcset = element.getAttribute("srcset");
    const slotIndex = srcsetSlotIndex;
    if (rawSrcset === null) continue;
    srcsetSlotIndex += 1;
    if (!rawSrcset) continue;
    const candidates = parseSrcset(rawSrcset);
    let hasRemoteCandidate = false;
    for (const candidate of candidates) {
      const url = absoluteMediaUrl(candidate.source, baseUrl);
      if (!url) continue;
      hasRemoteCandidate = true;
      addUniqueUrl(urls, url);
    }
    if (hasRemoteCandidate) {
      srcsetTargets.push({ candidates, element, slotIndex });
    }
  }

  for (const element of root.querySelectorAll<Element>(MEDIA_STYLE_SELECTOR)) {
    const style = element.getAttribute("style") ?? "";
    const slotIndex = styleSlotIndex;
    styleSlotIndex += 1;
    const styleUrls = collectStyleMediaUrls(style, baseUrl);
    if (styleUrls.length === 0) continue;
    styleTargets.push({ element, slotIndex, style, urls: styleUrls });
    for (const { url } of styleUrls) {
      addUniqueUrl(urls, url);
    }
  }

  return { srcTargets, srcsetTargets, styleTargets, urls };
}

export function protectRemoteChapterMediaForPartialHtml(
  html: string,
  baseUrl?: string | null,
): string {
  if (typeof document === "undefined") return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  const { srcTargets, srcsetTargets, styleTargets, urls } = collectMediaTargets(
    template.content,
    baseUrl,
  );
  if (urls.length === 0) return html;

  for (const target of srcTargets) {
    target.element.setAttribute(MEDIA_SOURCE_URL_ATTRIBUTE, target.url);
    target.element.setAttribute(
      target.attribute,
      target.attribute === "src" && target.element instanceof HTMLImageElement
        ? REMOTE_MEDIA_PENDING_PLACEHOLDER_SRC
        : REMOTE_MEDIA_EMPTY_PLACEHOLDER_SRC,
    );
  }
  for (const target of srcsetTargets) {
    const rawSrcset = target.element.getAttribute("srcset");
    if (rawSrcset) {
      target.element.setAttribute(MEDIA_SRCSET_SOURCE_ATTRIBUTE, rawSrcset);
    }
    target.element.setAttribute("srcset", REMOTE_MEDIA_EMPTY_PLACEHOLDER_SRC);
  }
  for (const target of styleTargets) {
    target.element.setAttribute(
      "style",
      target.style.replace(
        STYLE_URL_PATTERN,
        `url("${REMOTE_MEDIA_EMPTY_PLACEHOLDER_SRC}")`,
      ),
    );
  }

  return template.innerHTML;
}

function collectExistingMediaSlots(root: DocumentFragment): ExistingMediaSlots {
  const srcSlots: Array<string | null> = [];
  const srcsetSlots: Array<Array<string | null>> = [];
  const styleSlots: Array<Array<string | null>> = [];

  for (const element of root.querySelectorAll<Element>(MEDIA_SOURCE_SELECTOR)) {
    for (const attribute of MEDIA_SRC_ATTRIBUTES) {
      const rawSource = element.getAttribute(attribute);
      if (rawSource === null) continue;
      srcSlots.push(localMediaSrc(rawSource));
    }

    const rawSrcset = element.getAttribute("srcset");
    if (rawSrcset === null) continue;
    srcsetSlots.push(
      parseSrcset(rawSrcset).map((candidate) => localMediaSrc(candidate.source)),
    );
  }

  for (const element of root.querySelectorAll<Element>(MEDIA_STYLE_SELECTOR)) {
    styleSlots.push(styleMediaSlots(element.getAttribute("style") ?? ""));
  }

  return { srcSlots, srcsetSlots, styleSlots };
}

function tagCollectedMediaTargets(
  srcTargets: MediaSrcTarget[],
  srcsetTargets: MediaSrcsetTarget[],
): void {
  for (const target of srcTargets) {
    target.element.setAttribute(MEDIA_SOURCE_URL_ATTRIBUTE, target.url);
  }
  for (const target of srcsetTargets) {
    target.element.setAttribute(
      MEDIA_SRCSET_SOURCE_ATTRIBUTE,
      formatSrcset(target.candidates),
    );
  }
}

function clearMediaSourceMetadata(root: DocumentFragment): void {
  for (const element of root.querySelectorAll<Element>(
    `[${MEDIA_SOURCE_URL_ATTRIBUTE}],[${MEDIA_SRCSET_SOURCE_ATTRIBUTE}]`,
  )) {
    element.removeAttribute(MEDIA_SOURCE_URL_ATTRIBUTE);
    element.removeAttribute(MEDIA_SRCSET_SOURCE_ATTRIBUTE);
  }
}

function collectMetadataReusableMediaSources(
  root: DocumentFragment,
  baseUrl: string | null | undefined,
  urls: Set<string>,
): Map<string, string> {
  const reusable = new Map<string, string>();

  for (const element of root.querySelectorAll<Element>(
    `[${MEDIA_SOURCE_URL_ATTRIBUTE}]`,
  )) {
    const sourceUrl = absoluteMediaUrl(
      element.getAttribute(MEDIA_SOURCE_URL_ATTRIBUTE) ?? "",
      baseUrl,
    );
    const src = localMediaSrc(element.getAttribute("src"));
    if (sourceUrl && src && urls.has(sourceUrl)) {
      reusable.set(sourceUrl, src);
    }
  }

  for (const element of root.querySelectorAll<Element>(
    `[${MEDIA_SRCSET_SOURCE_ATTRIBUTE}]`,
  )) {
    const sourceCandidates = parseSrcset(
      element.getAttribute(MEDIA_SRCSET_SOURCE_ATTRIBUTE) ?? "",
    );
    const localCandidates = parseSrcset(
      element.getAttribute("srcset") ?? "",
    ).map((candidate) => localMediaSrc(candidate.source));
    for (
      let index = 0;
      index < sourceCandidates.length && index < localCandidates.length;
      index += 1
    ) {
      const sourceUrl = absoluteMediaUrl(
        sourceCandidates[index]!.source,
        baseUrl,
      );
      const src = localCandidates[index];
      if (sourceUrl && src && urls.has(sourceUrl)) {
        reusable.set(sourceUrl, src);
      }
    }
  }

  return reusable;
}

function collectSlotReusableMediaSources({
  baseUrl,
  root,
  srcTargets,
  srcsetTargets,
  styleTargets,
}: {
  baseUrl: string | null | undefined;
  root: DocumentFragment;
  srcTargets: MediaSrcTarget[];
  srcsetTargets: MediaSrcsetTarget[];
  styleTargets: MediaStyleTarget[];
}): Map<string, string> {
  const reusable = new Map<string, string>();
  const existingSlots = collectExistingMediaSlots(root);

  for (const target of srcTargets) {
    const src = existingSlots.srcSlots[target.slotIndex];
    if (src) reusable.set(target.url, src);
  }

  for (const target of srcsetTargets) {
    const localCandidates = existingSlots.srcsetSlots[target.slotIndex] ?? [];
    for (
      let candidateIndex = 0;
      candidateIndex < target.candidates.length &&
      candidateIndex < localCandidates.length;
      candidateIndex += 1
    ) {
      const sourceUrl = absoluteMediaUrl(
        target.candidates[candidateIndex]!.source,
        baseUrl,
      );
      const src = localCandidates[candidateIndex];
      if (sourceUrl && src) reusable.set(sourceUrl, src);
    }
  }

  for (const target of styleTargets) {
    const localSources = existingSlots.styleSlots[target.slotIndex] ?? [];
    for (
      let styleIndex = 0;
      styleIndex < target.urls.length && styleIndex < localSources.length;
      styleIndex += 1
    ) {
      const src = localSources[styleIndex];
      if (src) reusable.set(target.urls[styleIndex]!.url, src);
    }
  }

  return reusable;
}

function collectReusableMediaSources({
  baseUrl,
  chapterId,
  previousHtml,
  srcTargets,
  srcsetTargets,
  styleTargets,
  urls,
}: {
  baseUrl: string | null | undefined;
  chapterId: number;
  previousHtml: string | null | undefined;
  srcTargets: MediaSrcTarget[];
  srcsetTargets: MediaSrcsetTarget[];
  styleTargets: MediaStyleTarget[];
  urls: string[];
}): Map<string, string> {
  if (!previousHtml?.includes(LOCAL_MEDIA_SRC_PREFIX)) {
    return new Map();
  }

  const template = document.createElement("template");
  template.innerHTML = previousHtml;
  const urlSet = new Set(urls);
  const reusable = collectMetadataReusableMediaSources(
    template.content,
    baseUrl,
    urlSet,
  );
  const slotReusable = collectSlotReusableMediaSources({
    baseUrl,
    root: template.content,
    srcTargets,
    srcsetTargets,
    styleTargets,
  });
  for (const [url, src] of slotReusable) {
    if (!reusable.has(url)) reusable.set(url, src);
  }

  for (const [url, src] of reusable) {
    if (!urlSet.has(url) || !fileNameFromLocalMediaSrc(src, chapterId)) {
      reusable.delete(url);
    }
  }
  return reusable;
}

async function filterExistingReusableMediaSources(
  reusableSources: Map<string, string>,
  context: ChapterMediaStorageContext,
): Promise<Map<string, string>> {
  const existing = new Map<string, string>();
  for (const [url, src] of reusableSources) {
    if ((await getStoredChapterMediaBytes(src, context)) > 0) {
      existing.set(url, src);
    }
  }
  return existing;
}

async function collectStoredManifestMediaSources({
  chapterId,
  context,
  manifest,
  urls,
}: {
  chapterId: number;
  context: ChapterMediaStorageContext;
  manifest: ChapterMediaManifest;
  urls: string[];
}): Promise<Map<string, string>> {
  const requestedUrls = new Set(urls);
  const existing = new Map<string, string>();
  for (const file of manifest.media.files) {
    if (
      !requestedUrls.has(file.sourceUrl) ||
      !isFetchableMediaUrl(file.sourceUrl)
    ) {
      continue;
    }
    const src = localChapterMediaSrc(chapterId, file.fileName);
    if ((await getStoredChapterMediaBytes(src, context)) > 0) {
      existing.set(file.sourceUrl, src);
    }
  }
  return existing;
}

function isFetchableMediaUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

async function collectMissingManifestMediaSources({
  chapterId,
  context,
  html,
  manifest,
}: {
  chapterId: number;
  context: ChapterMediaStorageContext;
  html: string;
  manifest: ChapterMediaManifest;
}): Promise<Map<string, string>> {
  const filesByName = new Map(
    manifest.media.files.map((file) => [file.fileName, file]),
  );
  const missing = new Map<string, string>();
  for (const src of localChapterMediaSources(html)) {
    const fileName = fileNameFromLocalMediaSrc(src, chapterId);
    if (!fileName) continue;
    const manifestFile = filesByName.get(fileName);
    if (
      !manifestFile ||
      !isFetchableMediaUrl(manifestFile.sourceUrl)
    ) {
      continue;
    }
    if ((await getStoredChapterMediaBytes(src, context)) <= 0) {
      missing.set(manifestFile.sourceUrl, src);
    }
  }
  return missing;
}

function outputMediaSourceForUrl(
  localSources: Map<string, string>,
  url: string,
): string {
  return localSources.get(url) ?? url;
}

function applyRemoteMediaFallback({
  baseUrl,
  srcTargets,
  srcsetTargets,
  styleTargets,
  url,
}: {
  baseUrl: string | null | undefined;
  srcTargets: MediaSrcTarget[];
  srcsetTargets: MediaSrcsetTarget[];
  styleTargets: MediaStyleTarget[];
  url: string;
}): void {
  for (const target of srcTargets) {
    if (target.url === url) {
      const outputAttribute = mediaOutputAttribute(target.attribute);
      target.element.setAttribute(outputAttribute, url);
      if (target.attribute !== outputAttribute) {
        target.element.removeAttribute(target.attribute);
      }
    }
  }

  for (const target of srcsetTargets) {
    const currentCandidates = parseSrcset(
      target.element.getAttribute("srcset") ?? "",
    );
    let changed = false;
    const candidates = currentCandidates.map((candidate, index) => {
      const sourceCandidate = target.candidates[index];
      if (
        sourceCandidate &&
        absoluteMediaUrl(sourceCandidate.source, baseUrl) === url
      ) {
        changed = true;
        return { ...candidate, source: url };
      }
      return candidate;
    });
    if (!changed) continue;
    target.element.setAttribute("srcset", formatSrcset(candidates));
  }

  for (const target of styleTargets) {
    if (!target.urls.some((styleUrl) => styleUrl.url === url)) continue;
    const currentStyle = target.element.getAttribute("style") ?? "";
    target.element.setAttribute(
      "style",
      rewriteStyleMediaUrls(currentStyle, baseUrl, (styleUrl) =>
        styleUrl === url ? url : null,
      ),
    );
  }
}

function applyResolvedMediaSource({
  baseUrl,
  localSources,
  srcTargets,
  srcsetTargets,
  styleTargets,
  url,
}: {
  baseUrl: string | null | undefined;
  localSources: Map<string, string>;
  srcTargets: MediaSrcTarget[];
  srcsetTargets: MediaSrcsetTarget[];
  styleTargets: MediaStyleTarget[];
  url: string;
}): Set<Element> {
  const changedElements = new Set<Element>();
  for (const target of srcTargets) {
    if (target.url !== url) continue;
    const outputAttribute = mediaOutputAttribute(target.attribute);
    target.element.setAttribute(
      outputAttribute,
      outputMediaSourceForUrl(localSources, target.url),
    );
    if (target.attribute !== outputAttribute) {
      target.element.removeAttribute(target.attribute);
    }
    changedElements.add(target.element);
  }

  for (const target of srcsetTargets) {
    if (
      !target.candidates.some(
        (candidate) => absoluteMediaUrl(candidate.source, baseUrl) === url,
      )
    ) {
      continue;
    }
    const candidates = target.candidates
      .map((candidate) => {
        const candidateUrl = absoluteMediaUrl(candidate.source, baseUrl);
        if (!candidateUrl) return candidate;
        return {
          ...candidate,
          source: outputMediaSourceForUrl(localSources, candidateUrl),
        };
      })
      .filter((candidate) => candidate.source !== "");
    target.element.setAttribute("srcset", formatSrcset(candidates));
    changedElements.add(target.element);
  }

  for (const target of styleTargets) {
    if (!target.urls.some((styleUrl) => styleUrl.url === url)) continue;
    target.element.setAttribute(
      "style",
      rewriteStyleMediaUrls(
        target.style,
        baseUrl,
        (styleUrl) => outputMediaSourceForUrl(localSources, styleUrl),
      ),
    );
    changedElements.add(target.element);
  }
  return changedElements;
}

function safeChapterMediaHtml(template: HTMLTemplateElement): string {
  const safeTemplate = document.createElement("template");
  safeTemplate.innerHTML = template.innerHTML;
  clearMediaSourceMetadata(safeTemplate.content);
  return safeTemplate.innerHTML;
}

async function emitHtmlUpdate(
  onHtmlUpdate: CacheChapterMediaOptions["onHtmlUpdate"],
  template: HTMLTemplateElement,
): Promise<void> {
  await onHtmlUpdate?.(safeChapterMediaHtml(template));
}

function collectMediaElementPatches(
  root: DocumentFragment,
  changedElements: Set<Element>,
): ChapterMediaElementPatch[] {
  if (changedElements.size === 0) return [];
  const elements = [...root.querySelectorAll<Element>(MEDIA_PATCH_SELECTOR)];
  const patches: ChapterMediaElementPatch[] = [];
  elements.forEach((element, index) => {
    if (!changedElements.has(element)) return;
    const attributes: Record<string, string> = {};
    for (const attribute of MEDIA_PATCH_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value?.trim()) attributes[attribute] = value;
    }
    if (Object.keys(attributes).length > 0) {
      patches.push({ index, attributes });
    }
  });
  return patches;
}

export function collectChapterMediaElementPatches(
  html: string,
): ChapterMediaElementPatch[] {
  if (typeof document === "undefined") return [];
  const template = document.createElement("template");
  template.innerHTML = html;
  return collectMediaElementPatches(
    template.content,
    collectAllMediaPatchElements(template.content),
  );
}

function collectAllMediaPatchElements(root: DocumentFragment): Set<Element> {
  const changedElements = new Set<Element>();
  for (const element of root.querySelectorAll<Element>(MEDIA_PATCH_SELECTOR)) {
    if (
      MEDIA_PATCH_ATTRIBUTES.some(
        (attribute) => (element.getAttribute(attribute) ?? "").trim() !== "",
      )
    ) {
      changedElements.add(element);
    }
  }
  return changedElements;
}

async function emitMediaPatchUpdate(
  onMediaPatch: CacheChapterMediaOptions["onMediaPatch"],
  template: HTMLTemplateElement,
  changedElements: Set<Element>,
): Promise<void> {
  const patches = collectMediaElementPatches(template.content, changedElements);
  if (patches.length > 0) {
    await onMediaPatch?.(patches);
  }
}

function isMediaAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function mediaFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizedMediaUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/, 1)[0] ?? url;
  }
}

function mediaFailureHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function mediaFailureContextHost(contextUrl: string): string {
  try {
    return new URL(contextUrl).host;
  } catch {
    return "";
  }
}

function recordChapterMediaFailure(
  failures: ChapterMediaFailure[],
  input: {
    contextUrl: string;
    error: unknown;
    scraperExecutor?: ScraperExecutorId;
    sourceId?: string;
    status?: number;
    url: string;
  },
): void {
  const message = mediaFailureMessage(input.error);
  failures.push({
    message,
    ...(input.status ? { status: input.status } : {}),
    url: input.url,
  });
  console.warn("[chapter-media] media asset using remote fallback", {
    contextHost: mediaFailureContextHost(input.contextUrl),
    error: message,
    host: mediaFailureHost(input.url),
    sanitizedUrl: sanitizedMediaUrl(input.url),
    scraperExecutor: input.scraperExecutor,
    sourceId: input.sourceId,
    status: input.status,
  });
}

export async function cacheHtmlChapterMedia({
  baseUrl,
  chapterId,
  chapterName,
  chapterNumber,
  chapterPosition,
  contextUrl,
  html,
  novelId,
  novelName,
  novelPath,
  onHtmlUpdate,
  onMediaPatch,
  onProgress,
  previousHtml,
  requestInit,
  repair = false,
  scraperExecutor,
  signal,
  sourceId,
}: CacheChapterMediaOptions): Promise<CacheChapterMediaResult> {
  if (!isTauriRuntime() || typeof document === "undefined") {
    return {
      html,
      mediaBytes: 0,
      mediaFailures: [],
      storedMediaCount: 0,
    };
  }

  const template = document.createElement("template");
  template.innerHTML = html;
  const { srcTargets, srcsetTargets, styleTargets, urls } = collectMediaTargets(
    template.content,
    baseUrl,
  );

  if (urls.length === 0 && !repair) {
    return {
      html: template.innerHTML,
      mediaBytes: 0,
      mediaFailures: [],
      storedMediaCount: 0,
    };
  }

  const storageContext: ChapterMediaStorageContext = {
    chapterId,
    chapterName,
    chapterNumber,
    chapterPosition,
    novelId,
    novelName,
    novelPath,
    sourceId,
  };
  const mediaContextUrl = contextUrl ?? baseUrl ?? undefined;
  const reusableCandidates = repair
    ? collectReusableMediaSources({
          baseUrl,
          chapterId,
          previousHtml,
          srcTargets,
          srcsetTargets,
          styleTargets,
          urls,
        })
    : new Map<string, string>();
  const mediaFailures: ChapterMediaFailure[] = [];
  const previousManifest = repair
    ? await readChapterMediaManifest(storageContext)
    : emptyChapterMediaManifest();
  if (repair) {
    await prepareChapterMediaWorkspace(storageContext, repair);
  }
  const reusableSources = repair
    ? await filterExistingReusableMediaSources(
        reusableCandidates,
        storageContext,
      )
    : new Map<string, string>();
  const manifestSources = repair
    ? await collectStoredManifestMediaSources({
        chapterId,
        context: storageContext,
        manifest: previousManifest,
        urls,
      })
    : new Map<string, string>();
  const missingManifestSources = repair
    ? await collectMissingManifestMediaSources({
        chapterId,
        context: storageContext,
        html: template.innerHTML,
        manifest: previousManifest,
      })
    : new Map<string, string>();
  const localSources = new Map<string, string>(reusableSources);
  for (const [url, src] of manifestSources) {
    if (!localSources.has(url)) {
      localSources.set(url, src);
    }
  }
  const mediaFilesBySourceUrl = new Map(
    previousManifest.media.files.map((file) => [file.sourceUrl, file]),
  );
  const usedFileNames = new Set(
    previousManifest.media.files.map((file) => file.fileName),
  );
  for (const src of reusableSources.values()) {
    const fileName = fileNameFromLocalMediaSrc(src, chapterId);
    if (fileName) usedFileNames.add(fileName);
  }
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index]!;
    const existing = mediaFilesBySourceUrl.get(url);
    if (existing) {
      mediaFilesBySourceUrl.set(url, {
        ...existing,
        status: localSources.has(url) ? "stored" : "remote",
      });
      continue;
    }
    const fileName = mediaFileName(index, url, null, usedFileNames);
    mediaFilesBySourceUrl.set(url, {
      bytes: 0,
      fileName,
      path: `media/${fileName}`,
      sourceUrl: url,
      status: "remote",
      updatedAt: Date.now(),
    });
  }
  for (const url of missingManifestSources.keys()) {
    const existing = mediaFilesBySourceUrl.get(url);
    if (existing) {
      mediaFilesBySourceUrl.set(url, {
        ...existing,
        status: "remote",
        updatedAt: Date.now(),
      });
    }
  }
  const downloadUrls = [
    ...new Set(
      [
        ...urls.filter((url) => !localSources.has(url)),
        ...missingManifestSources.keys(),
      ].filter((url) => !localSources.has(url)),
    ),
  ];
  let storedMediaCount = 0;
  tagCollectedMediaTargets(srcTargets, srcsetTargets);
  const reusableChangedElements = new Set<Element>();
  for (const url of localSources.keys()) {
    const changedElements = applyResolvedMediaSource({
      baseUrl,
      localSources,
      srcTargets,
      srcsetTargets,
      styleTargets,
      url,
    });
    for (const element of changedElements) {
      reusableChangedElements.add(element);
    }
  }
  if (reusableChangedElements.size > 0) {
    await emitHtmlUpdate(onHtmlUpdate, template);
    await emitMediaPatchUpdate(onMediaPatch, template, reusableChangedElements);
  }
  if (!repair) {
    await prepareChapterMediaWorkspace(storageContext, repair);
  }

  for (let index = 0; index < downloadUrls.length; index += 1) {
    throwIfAborted(signal);
    const url = downloadUrls[index]!;
    const mediaIndex = urls.indexOf(url);
    if (localSources.has(url)) {
      onProgress?.({ current: index + 1, total: downloadUrls.length });
      continue;
    }
    try {
      const response = await pluginMediaFetch(url, {
        ...requestInit,
        headers: {
          Accept: DEFAULT_MEDIA_ACCEPT,
          ...(requestInit?.headers ?? {}),
        },
        ...(mediaContextUrl ? { contextUrl: mediaContextUrl } : {}),
        ...(scraperExecutor ? { scraperExecutor } : {}),
        signal,
        ...(sourceId ? { sourceId } : {}),
      });
      if (!response.ok) {
        recordChapterMediaFailure(mediaFailures, {
          contextUrl: mediaContextUrl ?? url,
          error: `HTTP ${response.status} ${response.statusText}`,
          scraperExecutor,
          sourceId,
          status: response.status,
          url,
        });
        applyRemoteMediaFallback({
          baseUrl,
          srcTargets,
          srcsetTargets,
          styleTargets,
          url,
        });
      } else {
        throwIfAborted(signal);
        const body = bytesFromArrayBuffer(await response.arrayBuffer());
        throwIfAborted(signal);
        const contentType = response.headers.get("content-type");
        const manifestFile =
          mediaFilesBySourceUrl.get(url) ??
          ({
            bytes: 0,
            fileName: mediaFileName(
              mediaIndex >= 0 ? mediaIndex : index,
              url,
              contentType,
              usedFileNames,
            ),
            path: "",
            sourceUrl: url,
            status: "remote",
            updatedAt: Date.now(),
          } satisfies ChapterMediaManifestFile);
        const fileName = manifestFile.fileName;
        const src = await storeChapterMedia({
          body,
          chapterId,
          contentType,
          fileName,
          chapterName,
          chapterNumber,
          chapterPosition,
          novelId,
          novelName,
          novelPath,
          sourceId,
        });
        localSources.set(url, src);
        mediaFilesBySourceUrl.set(url, {
          ...manifestFile,
          bytes: chapterMediaByteLength(body),
          ...(contentType ? { contentType } : {}),
          fileName,
          path: `media/${fileName}`,
          sourceUrl: url,
          status: "stored",
          updatedAt: Date.now(),
        });
        storedMediaCount += 1;
        const changedElements = applyResolvedMediaSource({
          baseUrl,
          localSources,
          srcTargets,
          srcsetTargets,
          styleTargets,
          url,
        });
        await emitHtmlUpdate(onHtmlUpdate, template);
        await emitMediaPatchUpdate(onMediaPatch, template, changedElements);
      }
    } catch (error) {
      if (signal?.aborted) {
        throw new DOMException("Task was cancelled.", "AbortError");
      }
      if (isMediaAbortError(error)) throw error;
      recordChapterMediaFailure(mediaFailures, {
        contextUrl: mediaContextUrl ?? url,
        error,
        scraperExecutor,
        sourceId,
        url,
      });
      applyRemoteMediaFallback({
        baseUrl,
        srcTargets,
        srcsetTargets,
        styleTargets,
        url,
      });
    }
    throwIfAborted(signal);
    onProgress?.({ current: index + 1, total: downloadUrls.length });
  }

  await writeChapterMediaManifest({
    context: storageContext,
    files: [...mediaFilesBySourceUrl.values()],
  });

  if (localSources.size === 0) {
    await cleanupChapterMediaWorkspace(storageContext).catch(() => undefined);
    clearMediaSourceMetadata(template.content);
    return {
      html: template.innerHTML,
      mediaBytes: 0,
      mediaFailures,
      storedMediaCount,
    };
  }

  let archiveFailure: string | undefined;
  let mediaBytes = 0;
  try {
    mediaBytes = await archiveChapterMediaCache({
      chapterId,
      chapterName,
      chapterNumber,
      chapterPosition,
      novelId,
      novelName,
      novelPath,
      sourceId,
    });
  } catch (error) {
    archiveFailure = mediaFailureMessage(error);
    console.warn("[chapter-media] media archive failed", {
      error: archiveFailure,
      sourceId,
    });
    mediaBytes = await getStoredChapterMediaBytes(template.innerHTML, storageContext);
  }
  clearMediaSourceMetadata(template.content);

  return {
    ...(archiveFailure ? { archiveFailure } : {}),
    html: template.innerHTML,
    mediaFailures,
    mediaBytes,
    storedMediaCount,
  };
}

export async function storeEmbeddedChapterMedia({
  chapterId,
  chapterName,
  chapterNumber,
  chapterPosition,
  html,
  novelId,
  novelName,
  novelPath,
  resources,
  sourceId,
}: {
  chapterId: number;
  chapterName?: string | null;
  chapterNumber?: string | null;
  chapterPosition?: number | null;
  html: string;
  novelId?: number | null;
  novelName?: string | null;
  novelPath?: string | null;
  resources: EmbeddedChapterMediaResource[];
  sourceId?: string | null;
}): Promise<Pick<CacheChapterMediaResult, "archiveFailure" | "html" | "mediaBytes" | "storedMediaCount">> {
  const uniqueResources = [
    ...new Map(resources.map((resource) => [resource.placeholder, resource])).values(),
  ].filter(
    (resource) =>
      resource.placeholder && chapterMediaByteLength(resource.bytes) > 0,
  );
  if (!isTauriRuntime() || uniqueResources.length === 0) {
    return {
      html,
      mediaBytes: 0,
      storedMediaCount: 0,
    };
  }

  const storageContext: ChapterMediaStorageContext = {
    chapterId,
    chapterName,
    chapterNumber,
    chapterPosition,
    novelId,
    novelName,
    novelPath,
    sourceId,
  };
  await prepareChapterMediaWorkspace(storageContext, false);

  let rewrittenHtml = html;
  const files: ChapterMediaManifestFile[] = [];
  const usedFileNames = new Set<string>();
  let storedMediaCount = 0;
  for (const resource of uniqueResources) {
    const fileName = uniqueFileName(resource.fileName, usedFileNames);
    const src = await storeChapterMedia({
      body: resource.bytes,
      chapterId,
      chapterName,
      chapterNumber,
      chapterPosition,
      contentType: resource.contentType,
      fileName,
      novelId: novelId ?? undefined,
      novelName,
      novelPath,
      sourceId: sourceId ?? undefined,
    });
    rewrittenHtml = rewrittenHtml.split(resource.placeholder).join(src);
    files.push({
      bytes: chapterMediaByteLength(resource.bytes),
      ...(resource.contentType ? { contentType: resource.contentType } : {}),
      fileName,
      path: `media/${fileName}`,
      sourceUrl: resource.sourcePath ?? resource.placeholder,
      status: "stored",
      updatedAt: Date.now(),
    });
    storedMediaCount += 1;
  }

  await writeChapterMediaManifest({ context: storageContext, files });

  let archiveFailure: string | undefined;
  let mediaBytes = 0;
  try {
    mediaBytes = await archiveChapterMediaCache({
      chapterId,
      chapterName,
      chapterNumber,
      chapterPosition,
      novelId: novelId ?? undefined,
      novelName,
      novelPath,
      sourceId: sourceId ?? undefined,
    });
  } catch (error) {
    archiveFailure = mediaFailureMessage(error);
    console.warn("[chapter-media] embedded media archive failed", {
      error: archiveFailure,
      sourceId,
    });
    mediaBytes = await getStoredChapterMediaBytes(
      rewrittenHtml,
      storageContext,
    );
  }

  return {
    ...(archiveFailure ? { archiveFailure } : {}),
    html: rewrittenHtml,
    mediaBytes,
    storedMediaCount,
  };
}

function chapterMediaInvokeArgs(
  mediaSrc: string,
  context?: ChapterMediaStorageContext,
): Record<string, unknown> {
  return {
    mediaSrc,
    ...(context?.chapterName ? { chapterName: context.chapterName } : {}),
    ...(context?.chapterNumber ? { chapterNumber: context.chapterNumber } : {}),
    ...(context?.chapterPosition
      ? { chapterPosition: context.chapterPosition }
      : {}),
    ...(context?.novelId ? { novelId: context.novelId } : {}),
    ...(context?.novelName ? { novelName: context.novelName } : {}),
    ...(context?.novelPath ? { novelPath: context.novelPath } : {}),
    ...(context?.sourceId ? { sourceId: context.sourceId } : {}),
  };
}

export async function resolveLocalChapterMediaSrc(
  src: string,
  context?: ChapterMediaStorageContext,
): Promise<string | null> {
  if (!src.startsWith(LOCAL_MEDIA_SRC_PREFIX)) return src;
  if (!isTauriRuntime()) return src;
  if (isAndroidRuntime()) {
    const parsed = parseLocalChapterMediaSrc(src);
    if (!parsed) return null;
    const resolvedContext =
      context?.chapterId === parsed.chapterId
        ? context
        : await storageContextForChapter(parsed.chapterId);
    const relativePaths = await androidRelativePathsFromLocalMediaSrc(
      src,
      resolvedContext ?? undefined,
    );
    for (const relativePath of relativePaths) {
      const directDataUrl = await readAndroidStorageDataUrl(relativePath);
      if (directDataUrl) return directDataUrl;
    }

    for (const archivePath of androidChapterMediaArchiveRelativePathCandidates(
      resolvedContext,
    )) {
      const archivedDataUrl = await readAndroidStorageZipEntryDataUrl(
        archivePath,
        parsed.fileName,
      );
      if (archivedDataUrl) return archivedDataUrl;
    }
    return null;
  }
  try {
    const path = await invoke<string>(
      "chapter_media_path",
      chapterMediaInvokeArgs(src, context),
    );
    if (typeof path === "string" && path.trim() !== "") {
      return convertFileSrc(path);
    }
  } catch {
    // Older native hosts and missing files continue through the legacy data URL path.
  }
  try {
    return await invoke<string>(
      "chapter_media_data_url",
      chapterMediaInvokeArgs(src, context),
    );
  } catch {
    return null;
  }
}

function resolveCachedLocalChapterMediaSrc(
  cache: Map<string, Promise<string | null>>,
  src: string,
  context?: ChapterMediaStorageContext,
): Promise<string | null> {
  if (!src.startsWith(LOCAL_MEDIA_SRC_PREFIX)) {
    return Promise.resolve(src);
  }
  const cached = cache.get(src);
  if (cached) return cached;
  const resolved = resolveLocalChapterMediaSrc(src, context);
  cache.set(src, resolved);
  return resolved;
}

export async function resolveLocalChapterMediaPatches(
  patches: ChapterMediaElementPatch[],
  context?: ChapterMediaStorageContext,
): Promise<ChapterMediaElementPatch[]> {
  const resolvedMedia = new Map<string, Promise<string | null>>();
  const resolvedPatches = await Promise.all(
    patches.map(async (patch) => {
      const attributes: Record<string, string> = {};
      await Promise.all(
        Object.entries(patch.attributes).map(async ([attribute, value]) => {
          if (attribute === "srcset" && value.includes(LOCAL_MEDIA_SRC_PREFIX)) {
            const resolvedCandidates = (
              await Promise.all(
                parseSrcset(value).map(async (candidate) => {
                  const src = await resolveCachedLocalChapterMediaSrc(
                    resolvedMedia,
                    candidate.source,
                    context,
                  );
                  return src ? { ...candidate, source: src } : null;
                }),
              )
            ).filter(
              (candidate): candidate is SrcsetCandidate => candidate !== null,
            );
            if (resolvedCandidates.length > 0) {
              attributes[attribute] = formatSrcset(resolvedCandidates);
            }
            return;
          }
          if (attribute === "style" && value.includes(LOCAL_MEDIA_SRC_PREFIX)) {
            const localSources = localStyleMediaSources(value);
            const resolvedSources = new Map<string, string | null>();
            await Promise.all(
              localSources.map(async (source) => {
                if (!resolvedSources.has(source)) {
                  resolvedSources.set(
                    source,
                    await resolveCachedLocalChapterMediaSrc(
                      resolvedMedia,
                      source,
                      context,
                    ),
                  );
                }
              }),
            );
            attributes[attribute] = value.replace(
              STYLE_URL_PATTERN,
              (match, doubleQuoted, singleQuoted, unquoted) => {
                const source = String(
                  doubleQuoted ?? singleQuoted ?? unquoted ?? "",
                ).trim();
                if (!source.startsWith(LOCAL_MEDIA_SRC_PREFIX)) return match;
                return `url("${resolvedSources.get(source) ?? ""}")`;
              },
            );
            return;
          }
          if (!value.startsWith(LOCAL_MEDIA_SRC_PREFIX)) return;
          const src = await resolveCachedLocalChapterMediaSrc(
            resolvedMedia,
            value,
            context,
          );
          if (src) attributes[attribute] = src;
        }),
      );
      return { ...patch, attributes };
    }),
  );
  return resolvedPatches.filter(
    (patch) => Object.keys(patch.attributes).length > 0,
  );
}

export async function resolveLocalChapterMedia(
  html: string,
  context?: ChapterMediaStorageContext,
): Promise<string> {
  if (
    !isTauriRuntime() ||
    typeof document === "undefined" ||
    !html.includes(LOCAL_MEDIA_SRC_PREFIX)
  ) {
    return html;
  }

  const template = document.createElement("template");
  template.innerHTML = html;
  const mediaElements = [
    ...template.content.querySelectorAll<Element>(MEDIA_SOURCE_SELECTOR),
  ];
  const styleElements = [
    ...template.content.querySelectorAll<Element>(MEDIA_STYLE_SELECTOR),
  ];
  const styleSheetElements = [
    ...template.content.querySelectorAll<HTMLStyleElement>("style"),
  ];
  const resolvedMedia = new Map<string, Promise<string | null>>();

  await Promise.all(
    mediaElements.map(async (element) => {
      for (const attribute of MEDIA_SRC_ATTRIBUTES) {
        const rawSource = element.getAttribute(attribute);
        if (!rawSource?.startsWith(LOCAL_MEDIA_SRC_PREFIX)) continue;
        const src = await resolveCachedLocalChapterMediaSrc(
          resolvedMedia,
          rawSource,
          context,
        );
        const outputAttribute = mediaOutputAttribute(attribute);
        if (src) {
          element.setAttribute(outputAttribute, src);
        } else {
          element.removeAttribute(outputAttribute);
        }
        if (attribute !== outputAttribute) {
          element.removeAttribute(attribute);
        }
      }

      const rawSrcset = element.getAttribute("srcset");
      if (!rawSrcset?.includes(LOCAL_MEDIA_SRC_PREFIX)) return;
      const resolvedCandidates = (
        await Promise.all(
          parseSrcset(rawSrcset).map(async (candidate) => {
            const src = await resolveCachedLocalChapterMediaSrc(
              resolvedMedia,
              candidate.source,
              context,
            );
            return src ? { ...candidate, source: src } : null;
          }),
        )
      ).filter((candidate): candidate is SrcsetCandidate => candidate !== null);
      if (resolvedCandidates.length > 0) {
        element.setAttribute("srcset", formatSrcset(resolvedCandidates));
      } else {
        element.removeAttribute("srcset");
      }
    }),
  );

  await Promise.all(
    styleElements.map(async (element) => {
      const rawStyle = element.getAttribute("style");
      if (!rawStyle?.includes(LOCAL_MEDIA_SRC_PREFIX)) return;
      const localSources = localStyleMediaSources(rawStyle);
      const resolvedSources = new Map<string, string | null>();
      await Promise.all(
        localSources.map(async (source) => {
          if (!resolvedSources.has(source)) {
            resolvedSources.set(
              source,
              await resolveCachedLocalChapterMediaSrc(
                resolvedMedia,
                source,
                context,
              ),
            );
          }
        }),
      );
      const resolvedStyle = rawStyle.replace(
        STYLE_URL_PATTERN,
        (match, doubleQuoted, singleQuoted, unquoted) => {
          const source = String(
            doubleQuoted ?? singleQuoted ?? unquoted ?? "",
          ).trim();
          if (!source.startsWith(LOCAL_MEDIA_SRC_PREFIX)) return match;
          return `url("${resolvedSources.get(source) ?? ""}")`;
        },
      );
      element.setAttribute("style", resolvedStyle);
    }),
  );

  await Promise.all(
    styleSheetElements.map(async (element) => {
      const rawCss = element.textContent ?? "";
      if (!rawCss.includes(LOCAL_MEDIA_SRC_PREFIX)) return;
      const localSources = localStyleMediaSources(rawCss);
      const resolvedSources = new Map<string, string | null>();
      await Promise.all(
        localSources.map(async (source) => {
          if (!resolvedSources.has(source)) {
            resolvedSources.set(
              source,
              await resolveCachedLocalChapterMediaSrc(
                resolvedMedia,
                source,
                context,
              ),
            );
          }
        }),
      );
      element.textContent = rawCss.replace(
        STYLE_URL_PATTERN,
        (match, doubleQuoted, singleQuoted, unquoted) => {
          const source = String(
            doubleQuoted ?? singleQuoted ?? unquoted ?? "",
          ).trim();
          if (!source.startsWith(LOCAL_MEDIA_SRC_PREFIX)) return match;
          return `url("${resolvedSources.get(source) ?? ""}")`;
        },
      );
    }),
  );

  return template.innerHTML;
}

export async function pruneChapterMedia(
  chapterId: number,
  context?: ChapterMediaStorageContext,
): Promise<void> {
  if (!isTauriRuntime()) return;
  const resolvedContext = context ?? (await storageContextForChapter(chapterId));
  if (isAndroidRuntime()) {
    await deleteAndroidStoragePath(`chapter-media/${chapterId}`);
    return;
  }
  await invoke("chapter_media_prune", {
    chapterId,
    ...(resolvedContext?.chapterName
      ? { chapterName: resolvedContext.chapterName }
      : {}),
    ...(resolvedContext?.chapterNumber
      ? { chapterNumber: resolvedContext.chapterNumber }
      : {}),
    ...(resolvedContext?.chapterPosition
      ? { chapterPosition: resolvedContext.chapterPosition }
      : {}),
    ...(resolvedContext?.novelId ? { novelId: resolvedContext.novelId } : {}),
    ...(resolvedContext?.novelName
      ? { novelName: resolvedContext.novelName }
      : {}),
    ...(resolvedContext?.novelPath
      ? { novelPath: resolvedContext.novelPath }
      : {}),
    ...(resolvedContext?.sourceId
      ? { sourceId: resolvedContext.sourceId }
      : {}),
  });
}

export async function clearChapterMedia(
  chapterId: number,
  context?: ChapterMediaStorageContext,
): Promise<void> {
  if (!isTauriRuntime()) return;
  const resolvedContext = context ?? (await storageContextForChapter(chapterId));
  if (isAndroidRuntime()) {
    if (hasStorageContext(resolvedContext)) {
      await Promise.all([
        deleteAndroidStoragePath(
          chapterMediaDirectoryRelativePath(
            storageNovelPathInput(resolvedContext),
            storageChapterPathInput(resolvedContext),
          ),
        ),
        deleteAndroidStoragePath(
          chapterMediaArchiveRelativePath(
            storageNovelPathInput(resolvedContext),
            storageChapterPathInput(resolvedContext),
          ),
        ),
        deleteAndroidStoragePath(
          chapterMediaManifestRelativePath(
            storageNovelPathInput(resolvedContext),
            storageChapterPathInput(resolvedContext),
          ),
        ),
      ]);
    }
    await deleteAndroidStoragePath(`chapter-media/${chapterId}`);
    return;
  }
  await invoke("chapter_media_clear", {
    chapterId,
    ...(resolvedContext?.chapterName
      ? { chapterName: resolvedContext.chapterName }
      : {}),
    ...(resolvedContext?.chapterNumber
      ? { chapterNumber: resolvedContext.chapterNumber }
      : {}),
    ...(resolvedContext?.chapterPosition
      ? { chapterPosition: resolvedContext.chapterPosition }
      : {}),
    ...(resolvedContext?.novelId ? { novelId: resolvedContext.novelId } : {}),
    ...(resolvedContext?.novelName
      ? { novelName: resolvedContext.novelName }
      : {}),
    ...(resolvedContext?.novelPath
      ? { novelPath: resolvedContext.novelPath }
      : {}),
    ...(resolvedContext?.sourceId
      ? { sourceId: resolvedContext.sourceId }
      : {}),
  });
}

export async function clearAllChapterMedia(): Promise<void> {
  if (!isTauriRuntime()) return;
  if (isAndroidRuntime()) {
    await clearAndroidStorageRoot();
    return;
  }
  await invoke("chapter_media_clear_all");
}
