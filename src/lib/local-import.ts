import { load } from "cheerio";
import {
  chapterContentToHtml,
  type ChapterContentType,
} from "./chapter-content";
import {
  convertEpubToHtml,
  mergeEpubHtmlSections,
  type EpubHtmlResource,
} from "./epub-html";
import type { ChapterItem, SourceNovel } from "./plugins/types";

export const LOCAL_IMPORT_LIMITS = {
  cachedFileBytes: 8 * 1024 * 1024,
  fileBytes: 25 * 1024 * 1024,
  fileReadConcurrency: 2,
  textBytes: 8 * 1024 * 1024,
  htmlBytes: 8 * 1024 * 1024,
  markdownBytes: 8 * 1024 * 1024,
  pdfBytes: 25 * 1024 * 1024,
} as const;

export type LocalImportFormat = "txt" | "html" | "markdown" | "epub" | "pdf";

interface SanitizableElement {
  attribs?: Record<string, string>;
  tagName: string;
}

export interface LocalImportDuplicateMetadata {
  strategy: "content-hash";
  key: string;
  pathKey: string;
  contentHash: string;
  fileName: string;
  fileSize: number;
  format: LocalImportFormat;
}

export interface LocalImportAnalysis {
  fileName: string;
  fileSize: number;
  mimeType: string;
  format: LocalImportFormat;
  title: string;
  contentHash: string;
  pathKey: string;
  duplicate: LocalImportDuplicateMetadata;
}

export interface LocalImportConvertedChapter extends ChapterItem {
  binaryResource?: LocalImportBinaryResource;
  content: string;
  contentBytes: number;
  mediaResources?: EpubHtmlResource[];
}

export interface LocalImportConversion {
  analysis: LocalImportAnalysis;
  novel: SourceNovel;
  chapters: LocalImportConvertedChapter[];
  duplicate: LocalImportDuplicateMetadata;
}

interface LocalImportConversionOptions {
  analysis?: LocalImportAnalysis;
}

export interface LocalImportBinaryResource {
  bytes: Uint8Array;
  fileName: string;
  locator: LocalImportContentLocator;
  mediaType: string;
}

export interface LocalImportContentLocator {
  byteLength: number;
  fileName: string;
  mediaType: string;
  placeholder: string;
  sourcePath: string;
  storage: "chapter-media";
}

const DATA_IMAGE_SOURCE_PATTERN =
  /^data:image\/(?:avif|gif|jpeg|jpg|png|webp);base64,[a-z\d+/]+=*$/i;

const UNSAFE_TAGS = new Set([
  "applet",
  "base",
  "button",
  "embed",
  "form",
  "frame",
  "frameset",
  "iframe",
  "input",
  "link",
  "meta",
  "object",
  "script",
  "select",
  "style",
  "textarea",
]);

const ALLOWED_TAGS = new Set([
  "a",
  "abbr",
  "article",
  "aside",
  "b",
  "blockquote",
  "body",
  "br",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "hr",
  "html",
  "i",
  "img",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "u",
  "ul",
]);

const GLOBAL_ALLOWED_ATTRIBUTES = new Set([
  "aria-label",
  "dir",
  "lang",
  "title",
]);

const TAG_ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(["href"]),
  img: new Set(["alt", "height", "src", "width"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
};

export class LocalImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalImportError";
  }
}

function createConcurrencyLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const drain = () => {
    if (active >= concurrency) return;
    const next = queue.shift();
    if (!next) return;
    active += 1;
    next();
  };

  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      queue.push(resolve);
      drain();
    });

    try {
      return await task();
    } finally {
      active -= 1;
      drain();
    }
  };
}

const limitLocalImportFileRead = createConcurrencyLimiter(
  LOCAL_IMPORT_LIMITS.fileReadConcurrency,
);
const localImportByteCache = new WeakMap<
  File,
  { analysis: LocalImportAnalysis; bytes: Uint8Array<ArrayBuffer> }
>();

export function clearLocalImportFileCache(file: File): void {
  localImportByteCache.delete(file);
}

function getExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === fileName.length - 1) return "";
  return fileName.slice(dotIndex + 1).toLowerCase();
}

function titleFromFileName(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  const baseName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  return baseName.trim() || "Untitled";
}

function safeLocalImportFileName(
  fileName: string,
  fallbackExtension: string,
): string {
  const leaf = fileName.split(/[\\/]/).pop() ?? "";
  const sanitized = leaf
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const fallback = `local-import.${fallbackExtension}`;
  const candidate = sanitized || fallback;
  return candidate.includes(".")
    ? candidate
    : `${candidate}.${fallbackExtension}`;
}

function formatFromFile(file: File): LocalImportFormat {
  const extension = getExtension(file.name);
  const mimeType = file.type.toLowerCase();

  if (extension === "txt") return "txt";
  if (extension === "html" || extension === "htm") return "html";
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "epub") return "epub";
  if (extension === "pdf") return "pdf";

  if (mimeType === "text/plain") return "txt";
  if (mimeType === "text/html") return "html";
  if (mimeType === "text/markdown" || mimeType === "text/x-markdown") {
    return "markdown";
  }
  if (mimeType === "application/epub+zip") return "epub";
  if (mimeType === "application/pdf") return "pdf";

  throw new LocalImportError(`Unsupported local import format: ${file.name}`);
}

function formatLimit(format: LocalImportFormat): number {
  if (format === "txt") return LOCAL_IMPORT_LIMITS.textBytes;
  if (format === "html") return LOCAL_IMPORT_LIMITS.htmlBytes;
  if (format === "markdown") return LOCAL_IMPORT_LIMITS.markdownBytes;
  if (format === "pdf") return LOCAL_IMPORT_LIMITS.pdfBytes;
  return LOCAL_IMPORT_LIMITS.fileBytes;
}

function assertFileWithinLimit(file: File, format: LocalImportFormat): void {
  const limit = Math.min(LOCAL_IMPORT_LIMITS.fileBytes, formatLimit(format));
  if (file.size > limit) {
    throw new LocalImportError(
      `${file.name} is larger than the ${format} import limit.`,
    );
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "function") {
    throw new LocalImportError("Base64 encoding is not available.");
  }

  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hexFromBytes(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new LocalImportError("SHA-256 hashing is not available.");
  }
  const source = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  return hexFromBytes(await subtle.digest("SHA-256", source));
}

function pathKeyForHash(format: LocalImportFormat, contentHash: string): string {
  return `local:${format}:${contentHash}`;
}

function duplicateMetadata(
  analysis: Omit<LocalImportAnalysis, "duplicate">,
): LocalImportDuplicateMetadata {
  return {
    strategy: "content-hash",
    key: analysis.contentHash,
    pathKey: analysis.pathKey,
    contentHash: analysis.contentHash,
    fileName: analysis.fileName,
    fileSize: analysis.fileSize,
    format: analysis.format,
  };
}

function cachedLocalImportBytes(
  file: File,
): { analysis: LocalImportAnalysis; bytes: Uint8Array<ArrayBuffer> } | null {
  const cached = localImportByteCache.get(file);
  if (!cached) return null;
  return canReuseLocalImportAnalysis(
    file,
    cached.analysis.format,
    cached.analysis,
  )
    ? cached
    : null;
}

function rememberLocalImportBytes(
  file: File,
  analysis: LocalImportAnalysis,
  bytes: Uint8Array<ArrayBuffer>,
): void {
  if (bytes.byteLength > LOCAL_IMPORT_LIMITS.cachedFileBytes) return;
  localImportByteCache.set(file, { analysis, bytes });
}

async function readFileBytes(file: File): Promise<Uint8Array<ArrayBuffer>> {
  const cached = cachedLocalImportBytes(file);
  if (cached) return cached.bytes;
  return new Uint8Array(
    await limitLocalImportFileRead(() => file.arrayBuffer()),
  );
}

async function analyzeLocalImportBytes(
  file: File,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<LocalImportAnalysis> {
  const format = formatFromFile(file);
  assertFileWithinLimit(file, format);

  const contentHash = await sha256Hex(bytes);
  const analysisWithoutDuplicate = {
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type,
    format,
    title: titleFromFileName(file.name),
    contentHash,
    pathKey: pathKeyForHash(format, contentHash),
  };
  const analysis = {
    ...analysisWithoutDuplicate,
    duplicate: duplicateMetadata(analysisWithoutDuplicate),
  };
  rememberLocalImportBytes(file, analysis, bytes);
  return analysis;
}

export async function analyzeLocalImportFile(
  file: File,
): Promise<LocalImportAnalysis> {
  const format = formatFromFile(file);
  assertFileWithinLimit(file, format);
  return analyzeLocalImportBytes(file, await readFileBytes(file));
}

function canReuseLocalImportAnalysis(
  file: File,
  format: LocalImportFormat,
  analysis: LocalImportAnalysis | undefined,
): analysis is LocalImportAnalysis {
  return (
    analysis !== undefined &&
    analysis.fileName === file.name &&
    analysis.fileSize === file.size &&
    analysis.mimeType === file.type &&
    analysis.format === format
  );
}

function isAllowedUrl(value: string, allowDataImages: boolean): boolean {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return true;
  if (allowDataImages && DATA_IMAGE_SOURCE_PATTERN.test(trimmed)) return true;

  try {
    const url = new URL(trimmed);
    return (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "mailto:"
    );
  } catch {
    return false;
  }
}

function isAllowedAttribute(
  tagName: string,
  attributeName: string,
  value: string,
): boolean {
  const normalizedName = attributeName.toLowerCase();
  if (normalizedName.startsWith("on")) return false;
  if (normalizedName === "style" || normalizedName === "srcdoc") return false;
  if (
    !GLOBAL_ALLOWED_ATTRIBUTES.has(normalizedName) &&
    !TAG_ALLOWED_ATTRIBUTES[tagName]?.has(normalizedName)
  ) {
    return false;
  }

  if (tagName === "a" && normalizedName === "href") {
    return isAllowedUrl(value, false);
  }
  if (tagName === "img" && normalizedName === "src") {
    return isAllowedUrl(value, true);
  }
  if (
    (tagName === "img" &&
      (normalizedName === "width" || normalizedName === "height")) ||
    ((tagName === "td" || tagName === "th") &&
      (normalizedName === "colspan" || normalizedName === "rowspan"))
  ) {
    return /^\d{1,4}$/.test(value.trim());
  }

  return true;
}

export function sanitizeLocalImportHtml(html: string): string {
  const $ = load(html, {}, false);

  $([...UNSAFE_TAGS].join(",")).remove();

  $("*").each((_, element) => {
    const node = element as SanitizableElement;
    const tagName = node.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tagName)) {
      $(element).replaceWith($(element).contents());
      return;
    }

    for (const attribute of Object.keys(node.attribs ?? {})) {
      const value = $(element).attr(attribute) ?? "";
      if (!isAllowedAttribute(tagName, attribute, value)) {
        $(element).removeAttr(attribute);
      }
    }
  });

  return $.root().html() ?? "";
}

function chapterPath(pathKey: string, index: number): string {
  return `${pathKey}/chapter-${String(index + 1).padStart(4, "0")}`;
}

function singleChapterConversion(
  analysis: LocalImportAnalysis,
  content: string,
  contentType: ChapterContentType,
  binaryResource?: LocalImportBinaryResource,
): LocalImportConversion {
  const chapter: LocalImportConvertedChapter = {
    ...(binaryResource ? { binaryResource } : {}),
    name: analysis.title,
    path: chapterPath(analysis.pathKey, 0),
    chapterNumber: 1,
    contentType,
    content,
    contentBytes: utf8ByteLength(content),
  };

  return {
    analysis,
    novel: {
      name: analysis.title,
      path: analysis.pathKey,
      chapters: [
        {
          name: chapter.name,
          path: chapter.path,
          chapterNumber: chapter.chapterNumber,
          contentType,
        },
      ],
    },
    chapters: [chapter],
    duplicate: analysis.duplicate,
  };
}

function pdfBinaryResource(
  analysis: LocalImportAnalysis,
  bytes: Uint8Array,
  legacyDataUrl: string,
): LocalImportBinaryResource {
  const fileName = safeLocalImportFileName(analysis.fileName, "pdf");
  return {
    bytes,
    fileName,
    locator: {
      byteLength: bytes.byteLength,
      fileName,
      mediaType: "application/pdf",
      placeholder: legacyDataUrl,
      sourcePath: `local-import://pdf/${analysis.contentHash}`,
      storage: "chapter-media",
    },
    mediaType: "application/pdf",
  };
}

function bodyOrRootHtml(html: string): string {
  const $ = load(html);
  const bodyHtml = $("body").first().html();
  return bodyHtml ?? ($.root().html() || html);
}

async function convertEpub(
  analysis: LocalImportAnalysis,
  bytes: Uint8Array,
): Promise<LocalImportConversion> {
  try {
    const epub = await convertEpubToHtml(bytes, {
      fallbackTitle: analysis.title,
    });
    const content = mergeEpubHtmlSections(epub.sections, {
      ...(epub.direction ? { direction: epub.direction } : {}),
      ...(epub.language ? { language: epub.language } : {}),
    });
    const chapter: LocalImportConvertedChapter = {
      name: epub.title,
      path: chapterPath(analysis.pathKey, 0),
      chapterNumber: 1,
      contentType: "epub",
      content,
      contentBytes: utf8ByteLength(content),
      mediaResources: epub.sections.flatMap((section) => section.resources),
    };

    return {
      analysis: {
        ...analysis,
        title: epub.title,
      },
      novel: {
        name: epub.title,
        path: analysis.pathKey,
        author: epub.author,
        chapters: [
          {
            name: chapter.name,
            path: chapter.path,
            chapterNumber: chapter.chapterNumber,
            contentType: chapter.contentType,
          },
        ],
      },
      chapters: [chapter],
      duplicate: analysis.duplicate,
    };
  } catch (error) {
    throw new LocalImportError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function convertLocalImportFile(
  file: File,
  options: LocalImportConversionOptions = {},
): Promise<LocalImportConversion> {
  const format = formatFromFile(file);
  assertFileWithinLimit(file, format);
  const bytes = await readFileBytes(file);
  const analysis = canReuseLocalImportAnalysis(file, format, options.analysis)
    ? options.analysis
    : await analyzeLocalImportBytes(file, bytes);
  rememberLocalImportBytes(file, analysis, bytes);

  if (analysis.format === "txt") {
    return singleChapterConversion(
      analysis,
      chapterContentToHtml(utf8Decode(bytes), "text"),
      "html",
    );
  }

  if (analysis.format === "html") {
    return singleChapterConversion(
      analysis,
      sanitizeLocalImportHtml(bodyOrRootHtml(utf8Decode(bytes))),
      "html",
    );
  }

  if (analysis.format === "markdown") {
    return singleChapterConversion(
      analysis,
      chapterContentToHtml(utf8Decode(bytes), "markdown"),
      "html",
    );
  }

  if (analysis.format === "pdf") {
    const legacyDataUrl = `data:application/pdf;base64,${bytesToBase64(bytes)}`;
    return singleChapterConversion(
      analysis,
      legacyDataUrl,
      "pdf",
      pdfBinaryResource(analysis, bytes, legacyDataUrl),
    );
  }

  return convertEpub(analysis, bytes);
}
