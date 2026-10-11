const resolvedChapterStorageDirs = new Map<number, string>();
const authoritativeChapterStorageDirs = new Map<number, string>();
const resolvedNovelStorageDirs = new Map<number, string>();

export function rememberAuthoritativeChapterStorageDir(chapterId: number, directory: string): void {
  authoritativeChapterStorageDirs.set(chapterId, directory);
}

export function clearAuthoritativeStorageDirs(): void {
  authoritativeChapterStorageDirs.clear();
  resolvedNovelStorageDirs.clear();
  resolvedChapterStorageDirs.clear();
}

export function rememberResolvedNovelStorageDir(novelId: number, directory: string): void {
  resolvedNovelStorageDirs.set(novelId, directory);
}

export function resolvedNovelStorageDir(novelId?: number | null): string | null {
  return novelId ? resolvedNovelStorageDirs.get(novelId) ?? null : null;
}

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
  return authoritativeChapterStorageDirs.get(chapterId) ?? resolvedChapterStorageDirs.get(chapterId) ?? null;
}
