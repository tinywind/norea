import type { ChapterContentType } from "../chapter-content";

export const MAX_NOVEL_METADATA_BYTES = 16 * 1024 * 1024;
export const MAX_NOVEL_COVER_BYTES = 10 * 1024 * 1024;

export interface NovelMetadataV1 {
  schemaVersion: 1;
  identity: { pluginId: string; novelPath: string };
  novel: {
    name: string;
    cover: string | null;
    author: string | null;
    artist: string | null;
    summary: string | null;
    status: string | null;
    genres: string | null;
    isLocal: boolean;
  };
  chapters: {
    path: string;
    name: string;
    chapterNumber: string | null;
    position: number;
    page: string;
    contentType: ChapterContentType;
    releaseTime: string | null;
    directory: string;
  }[];
  cover: { fileName: string; contentType: string | null; sourceUrl: string } | null;
  updatedAt: number;
}

export function safeMetadataChild(value: string): boolean {
  return value.length > 0 && value.length <= 240 && value !== "." && value !== ".." &&
    !/[\u0000-\u001f<>:"/\\|?*]/.test(value) && !/[. ]$/.test(value) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("work metadata: expected object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key)) || keys.some((key) => !(key in result))) {
    throw new Error("work metadata: unexpected or missing fields");
  }
  return result;
}

function text(value: unknown, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length > (nullable ? MAX_NOVEL_METADATA_BYTES : 4096) || (!nullable && !value.trim()) ||
    Array.from(value).some((character) => { const code = character.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; })) {
    throw new Error("work metadata: invalid text");
  }
}

export function parseNovelMetadata(raw: unknown): NovelMetadataV1 {
  const value = record(raw, ["schemaVersion", "identity", "novel", "chapters", "cover", "updatedAt"]);
  if (value.schemaVersion !== 1 || typeof value.updatedAt !== "number" || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) {
    throw new Error("work metadata: invalid version or timestamp");
  }
  const identity = record(value.identity, ["pluginId", "novelPath"]);
  text(identity.pluginId); text(identity.novelPath);
  const novel = record(value.novel, ["name", "cover", "author", "artist", "summary", "status", "genres", "isLocal"]);
  text(novel.name);
  for (const key of ["cover", "author", "artist", "summary", "status", "genres"]) text(novel[key], true);
  if (typeof novel.isLocal !== "boolean") throw new Error("work metadata: invalid local flag");
  if (!Array.isArray(value.chapters) || value.chapters.length > 100000) throw new Error("work metadata: invalid chapters");
  const paths = new Set<string>(); const directories = new Set<string>();
  for (const rawChapter of value.chapters) {
    const chapter = record(rawChapter, ["path", "name", "chapterNumber", "position", "page", "contentType", "releaseTime", "directory"]);
    for (const key of ["path", "name", "page", "directory"]) text(chapter[key]);
    text(chapter.chapterNumber, true); text(chapter.releaseTime, true);
    if (typeof chapter.position !== "number" || !Number.isSafeInteger(chapter.position) || chapter.position < 0 ||
      !["html", "text", "markdown", "pdf", "epub"].includes(String(chapter.contentType))) throw new Error("work metadata: invalid chapter fields");
    const path = chapter.path as string; const directory = chapter.directory as string;
    if (!safeMetadataChild(directory) || /^(novel\.json|cover(?:\.|$))/i.test(directory) || paths.has(path) || directories.has(directory.toLowerCase())) throw new Error("work metadata: unsafe or duplicate chapter identity");
    paths.add(path); directories.add(directory.toLowerCase());
  }
  if (value.cover !== null) {
    const cover = record(value.cover, ["fileName", "contentType", "sourceUrl"]);
    text(cover.fileName); text(cover.sourceUrl); text(cover.contentType, true);
    if (cover.contentType !== null && !/^image\/[a-zA-Z0-9.+-]+$/.test(cover.contentType as string)) throw new Error("work metadata: invalid cover content type");
    if (!/^cover\.(avif|bmp|gif|img|jpe?g|png|svg|webp)$/.test(cover.fileName as string)) throw new Error("work metadata: unsafe cover filename");
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_NOVEL_METADATA_BYTES) throw new Error("work metadata: document exceeds size limit");
  return value as unknown as NovelMetadataV1;
}
