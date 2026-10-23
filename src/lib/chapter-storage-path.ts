import { isStorageId } from "./storage-id";
import { resolvedChapterStorageDir, resolvedNovelStorageDir } from "./chapter-storage-resolution";

export const CONTENTS_ROOT_DIR = "contents";

export interface ChapterStorageNovelPathInput {
  id?: number | null;
  name?: string | null;
  path?: string | null;
  pluginId?: string | null;
  sourceNovelId?: string | null;
}

export interface ChapterStorageChapterPathInput {
  chapterNumber?: string | null;
  id?: number | null;
  name?: string | null;
  position?: number | null;
}

function safeSegment(value: string | null | undefined, fallback: string): string {
  const sanitized = (value?.trim() || fallback)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return sanitized === "" || sanitized === "." || sanitized === ".."
    ? fallback
    : sanitized;
}

export function chapterStorageDirectoryName(chapter: ChapterStorageChapterPathInput): string {
  const value = chapter.chapterNumber ?? (chapter.position != null && chapter.position > 0 ? chapter.position : undefined);
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value)) throw new Error("Chapter storage sequence must be a decimal number.");
  const number = Number(value);
  if (value == null || String(value).trim() === "" || !Number.isFinite(number) || number < 0) {
    throw new Error("Chapter storage sequence must be a nonnegative number.");
  }
  const sequence = String(number);
  if (!/^\d+(?:\.\d+)?$/.test(sequence)) throw new Error("Chapter storage sequence must use decimal notation.");
  return sequence;
}

export function novelStorageDirectoryName(novel: ChapterStorageNovelPathInput): string {
  if (!isStorageId(novel.sourceNovelId)) throw new Error("Plugin-owned novel ID is required for storage.");
  return novel.sourceNovelId;
}

export function sourceStorageRelativeDir(
  novel: ChapterStorageNovelPathInput,
): string {
  if (!isStorageId(novel.pluginId) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(novel.pluginId)) throw new Error("Plugin ID is required for storage.");
  return `${CONTENTS_ROOT_DIR}/${novel.pluginId}`;
}

export function chapterStorageRelativeDir(
  novel: ChapterStorageNovelPathInput,
  chapter: ChapterStorageChapterPathInput,
): string {
  const resolved = resolvedChapterStorageDir(chapter.id);
  if (resolved) return resolved;
  return `${novelStorageRelativeDir(novel)}/${chapterStorageDirectoryName(chapter)}`;
}

export function novelStorageRelativeDir(
  novel: ChapterStorageNovelPathInput,
): string {
  const resolved = resolvedNovelStorageDir(novel.id);
  if (resolved) return resolved;
  return `${sourceStorageRelativeDir(novel)}/${novelStorageDirectoryName(novel)}`;
}

export function novelCoverRelativePath(
  novel: ChapterStorageNovelPathInput,
  fileName: string,
): string {
  return `${novelStorageRelativeDir(novel)}/${safeSegment(fileName, "cover")}`;
}

export function chapterContentRelativePath(
  novel: ChapterStorageNovelPathInput,
  chapter: ChapterStorageChapterPathInput,
  extension: string,
): string {
  return `${chapterStorageRelativeDir(novel, chapter)}/content.${extension}`;
}

export function chapterMediaRelativePath(
  novel: ChapterStorageNovelPathInput,
  chapter: ChapterStorageChapterPathInput,
  fileName?: string,
): string {
  const base = chapterMediaDirectoryRelativePath(novel, chapter);
  return fileName ? `${base}/${safeSegment(fileName, "media")}` : base;
}

export function chapterMediaDirectoryRelativePath(
  novel: ChapterStorageNovelPathInput,
  chapter: ChapterStorageChapterPathInput,
): string {
  return `${chapterStorageRelativeDir(novel, chapter)}/media`;
}

export function chapterMediaArchiveRelativePath(
  novel: ChapterStorageNovelPathInput,
  chapter: ChapterStorageChapterPathInput,
): string {
  return `${chapterStorageRelativeDir(novel, chapter)}/media.zip`;
}

export function chapterMediaManifestRelativePath(
  novel: ChapterStorageNovelPathInput,
  chapter: ChapterStorageChapterPathInput,
): string {
  return `${chapterStorageRelativeDir(novel, chapter)}/manifest.json`;
}
