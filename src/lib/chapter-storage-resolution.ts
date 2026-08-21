const resolvedChapterStorageDirs = new Map<number, string>();

function chapterDirectoryFromContentFile(contentFile: string): string | null {
  const segments = contentFile.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  segments.pop();
  return segments.join("/");
}

export function rememberResolvedChapterStorageDir(
  chapterId: number,
  contentFile: string,
): void {
  const chapterDir = chapterDirectoryFromContentFile(contentFile);
  if (chapterId > 0 && chapterDir) {
    resolvedChapterStorageDirs.set(chapterId, chapterDir);
  }
}

export function forgetResolvedChapterStorageDir(chapterId: number): void {
  resolvedChapterStorageDirs.delete(chapterId);
}

export function clearResolvedChapterStorageDirs(): void {
  resolvedChapterStorageDirs.clear();
}

export function resolvedChapterStorageDir(
  chapterId: number | null | undefined,
): string | null {
  if (!chapterId || chapterId <= 0) return null;
  return resolvedChapterStorageDirs.get(chapterId) ?? null;
}
