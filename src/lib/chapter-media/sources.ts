import { type ChapterMediaStorageContext } from "./types";

export const LOCAL_MEDIA_SRC_PREFIX = "norea-media://reader-asset/";

export const LOCAL_CHAPTER_MEDIA_SRC_PATTERN =
  /norea-media:\/\/reader-asset\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*(?=$|[^A-Za-z0-9._/-])/g;

const DEFAULT_MEDIA_EXTENSION = "bin";
const MEDIA_EXTENSION_PATTERN = /\.([a-z0-9]{1,8})$/i;

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
    const extension = new URL(url).pathname.match(MEDIA_EXTENSION_PATTERN)?.[1];
    return extension?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export function mimeTypeFromFileName(fileName: string): string {
  const extension = fileName.match(MEDIA_EXTENSION_PATTERN)?.[1]?.toLowerCase();
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

export function uniqueFileName(
  fileName: string,
  usedFileNames: Set<string>,
): string {
  if (!usedFileNames.has(fileName)) {
    usedFileNames.add(fileName);
    return fileName;
  }
  const extension = fileName.match(MEDIA_EXTENSION_PATTERN)?.[0] ?? "";
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  for (let index = 2; ; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!usedFileNames.has(candidate)) {
      usedFileNames.add(candidate);
      return candidate;
    }
  }
}

export function mediaFileName(
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

export function bytesFromArrayBuffer(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer);
}

export function chapterMediaByteLength(
  bytes: Uint8Array | readonly number[],
): number {
  return bytes.length;
}

export function chapterMediaBytesToArray(
  bytes: Uint8Array | readonly number[],
): number[] {
  return Array.from(bytes);
}

export function localChapterMediaSrc(fileName: string): string {
  return `${LOCAL_MEDIA_SRC_PREFIX}${fileName}`;
}

const ANDROID_READER_MEDIA_CACHE_SCOPE_SEGMENT = "~cache";

export function androidReaderMediaCacheToken(archivePath: string): string {
  let hash = 2166136261;
  for (let index = 0; index < archivePath.length; index += 1) {
    hash ^= archivePath.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${archivePath.length}-${(hash >>> 0).toString(36)}`;
}

export function androidReaderLocalChapterMediaSrc(
  fileName: string,
  archivePath: string,
): string {
  const token = androidReaderMediaCacheToken(archivePath);
  return [
    `${LOCAL_MEDIA_SRC_PREFIX}${ANDROID_READER_MEDIA_CACHE_SCOPE_SEGMENT}`,
    token,
    fileName,
  ].join("/");
}

export function localChapterMediaOutputSrc(fileName: string): string {
  return localChapterMediaSrc(fileName);
}

export function relativeChapterMediaFileName(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (
    trimmed.startsWith(".") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("#") ||
    trimmed.includes("\\") ||
    trimmed.includes(":") ||
    trimmed.includes("?") ||
    trimmed.includes("&") ||
    trimmed.includes("=")
  ) {
    return null;
  }
  const parts = trimmed.split("/");
  return parts.every(
    (part) =>
      part !== "" &&
      part !== "." &&
      part !== ".." &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part),
  )
    ? trimmed
    : null;
}

export function androidChapterMediaRelativePath(
  chapterId: number,
  fileName?: string,
): string {
  const base = `chapter-media/${chapterId}/media`;
  return fileName ? `${base}/${fileName}` : base;
}

export function parseLocalChapterMediaSrc(src: string): {
  fileName: string;
} | null {
  if (!src.startsWith(LOCAL_MEDIA_SRC_PREFIX)) return null;
  const fileName = relativeChapterMediaFileName(
    src.slice(LOCAL_MEDIA_SRC_PREFIX.length),
  );
  return fileName ? { fileName } : null;
}

export function localChapterMediaFileName(
  src: string,
  context?: ChapterMediaStorageContext,
): string | null {
  const parsed = parseLocalChapterMediaSrc(src);
  if (parsed) return parsed.fileName;
  return context ? relativeChapterMediaFileName(src) : null;
}

export function localChapterMediaSourceForContext(
  src: string,
  context?: ChapterMediaStorageContext,
): string | null {
  const fileName = localChapterMediaFileName(src, context);
  if (!fileName) return null;
  return localChapterMediaSrc(fileName);
}
