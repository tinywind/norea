export const CONTENTS_ROOT_DIR = "contents";

export interface ChapterStorageNovelPathInput {
  id?: number | null;
  name?: string | null;
  path?: string | null;
  pluginId?: string | null;
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

function isUnsafeUnicodeFormat(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    code === 0x180e ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff
  );
}

function safeLabelSegment(value: string | null | undefined, fallback: string) {
  const raw = value?.trim() || fallback;
  const sanitized = [...raw]
    .map((ch) =>
      /[\s/:*?"<>|\\]/.test(ch) || isUnsafeUnicodeFormat(ch) ? "-" : ch,
    )
    .join("")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 96);
  return sanitized === "" || sanitized === "." || sanitized === ".."
    ? fallback
    : sanitized;
}

function chapterNumberSegment(chapter: ChapterStorageChapterPathInput): string {
  const fallback =
    chapter.position && chapter.position > 0
      ? String(chapter.position)
      : String(chapter.id ?? "chapter");
  return safeSegment(chapter.chapterNumber, fallback);
}

export function chapterStorageIdentityPrefix(
  chapter: ChapterStorageChapterPathInput,
): string {
  return `${chapterNumberSegment(chapter)}-`;
}

export function novelStorageIdentitySuffix(
  novel: ChapterStorageNovelPathInput,
): string {
  const novelAddress = safeSegment(novel.path, String(novel.id ?? "novel"));
  return `-${novelAddress}`;
}

export function sourceStorageRelativeDir(
  novel: ChapterStorageNovelPathInput,
): string {
  return `${CONTENTS_ROOT_DIR}/${safeSegment(novel.pluginId, "source")}`;
}

export function chapterStorageRelativeDir(
  novel: ChapterStorageNovelPathInput,
  chapter: ChapterStorageChapterPathInput,
): string {
  const chapterSegment = `${chapterNumberSegment(chapter)}-${safeLabelSegment(
    chapter.name,
    "chapter",
  )}`;
  return `${novelStorageRelativeDir(novel)}/${chapterSegment}`;
}

export function novelStorageRelativeDir(
  novel: ChapterStorageNovelPathInput,
): string {
  const novelAddress = safeSegment(novel.path, String(novel.id ?? "novel"));
  const novelSegment = `${safeLabelSegment(novel.name, "novel")}-${novelAddress}`;
  return `${sourceStorageRelativeDir(novel)}/${novelSegment}`;
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
