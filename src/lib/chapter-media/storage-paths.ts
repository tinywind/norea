import { getChapterById } from "../../db/queries/chapter";
import { getNovelById } from "../../db/queries/novel";
import {
  type ChapterStorageChapterPathInput,
  type ChapterStorageNovelPathInput,
  chapterMediaArchiveRelativePath,
  chapterMediaManifestRelativePath,
  chapterMediaRelativePath,
  chapterStorageRelativeDir,
} from "../chapter-storage-path";
import { resolvedChapterStorageDir } from "../chapter-storage-resolution";
import { androidChapterMediaRelativePath } from "./sources";
import { type ChapterMediaStorageContext } from "./types";

const CHAPTER_MEDIA_MANIFEST_FILE = "manifest.json";

export function hasStorageContext(
  context: ChapterMediaStorageContext | null | undefined,
): context is ChapterMediaStorageContext & {
  novelPath: string;
  sourceId: string;
} {
  return !!context?.novelPath?.trim() && !!context.sourceId?.trim();
}

export function storageNovelPathInput(
  context: ChapterMediaStorageContext,
): ChapterStorageNovelPathInput {
  return {
    id: context.novelId,
    name: context.novelName,
    path: context.novelPath,
    pluginId: context.sourceId,
  };
}

export function storageChapterPathInput(
  context: ChapterMediaStorageContext,
): ChapterStorageChapterPathInput {
  return {
    chapterNumber: context.chapterNumber,
    id: context.chapterId,
    name: context.chapterName,
    position: context.chapterPosition,
  };
}

export async function storageContextForChapter(
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

export function androidChapterMediaRelativePathForContext(
  context: ChapterMediaStorageContext | null | undefined,
  fileName?: string,
): string {
  if (!hasStorageContext(context)) {
    return androidChapterMediaRelativePath(context?.chapterId ?? 0, fileName);
  }
  return resolvedAndroidChapterStoragePath(
    context,
    chapterMediaRelativePath(
      storageNovelPathInput(context),
      storageChapterPathInput(context),
      fileName,
    ),
  );
}

export function resolvedAndroidChapterStoragePath(
  context: ChapterMediaStorageContext,
  preferredPath: string,
): string {
  const resolvedDir = resolvedChapterStorageDir(context.chapterId);
  if (!resolvedDir) return preferredPath;
  const preferredDir = chapterStorageRelativeDir(
    storageNovelPathInput(context),
    storageChapterPathInput(context),
  );
  if (preferredPath === preferredDir) return resolvedDir;
  if (!preferredPath.startsWith(`${preferredDir}/`)) return preferredPath;
  return `${resolvedDir}${preferredPath.slice(preferredDir.length)}`;
}

function uniqueAndroidStoragePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

export function androidChapterMediaRelativePathCandidates(
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

export function androidChapterMediaArchiveRelativePathForContext(
  context: ChapterMediaStorageContext | null | undefined,
): string {
  if (!hasStorageContext(context)) {
    return `chapter-media/${context?.chapterId ?? 0}/media.zip`;
  }
  return resolvedAndroidChapterStoragePath(
    context,
    chapterMediaArchiveRelativePath(
      storageNovelPathInput(context),
      storageChapterPathInput(context),
    ),
  );
}

export function androidChapterMediaArchiveRelativePathCandidates(
  context: ChapterMediaStorageContext | null | undefined,
): string[] {
  const preferred = androidChapterMediaArchiveRelativePathForContext(context);
  if (!hasStorageContext(context)) return [preferred];
  return uniqueAndroidStoragePaths([
    preferred,
    `chapter-media/${context.chapterId}/media.zip`,
  ]);
}

export function androidChapterMediaSourceCandidates(
  context: ChapterMediaStorageContext | null | undefined,
): Array<{ archivePath: string; mediaPath: string }> {
  const preferred = {
    archivePath: androidChapterMediaArchiveRelativePathForContext(context),
    mediaPath: androidChapterMediaRelativePathForContext(context),
  };
  if (!hasStorageContext(context)) return [preferred];
  const legacy = {
    archivePath: `chapter-media/${context.chapterId}/media.zip`,
    mediaPath: androidChapterMediaRelativePath(context.chapterId),
  };
  const unique = new Map<string, { archivePath: string; mediaPath: string }>();
  for (const candidate of [preferred, legacy]) {
    unique.set(
      `${candidate.mediaPath}\u0000${candidate.archivePath}`,
      candidate,
    );
  }
  return [...unique.values()];
}

export function androidChapterMediaManifestRelativePath(
  context: ChapterMediaStorageContext | null | undefined,
): string {
  if (!hasStorageContext(context)) {
    return `chapter-media/${context?.chapterId ?? 0}/${CHAPTER_MEDIA_MANIFEST_FILE}`;
  }
  return resolvedAndroidChapterStoragePath(
    context,
    chapterMediaManifestRelativePath(
      storageNovelPathInput(context),
      storageChapterPathInput(context),
    ),
  );
}

export function androidChapterMediaManifestRelativePathCandidates(
  context: ChapterMediaStorageContext | null | undefined,
): string[] {
  const preferred = androidChapterMediaManifestRelativePath(context);
  if (!hasStorageContext(context)) return [preferred];
  return uniqueAndroidStoragePaths([
    preferred,
    `chapter-media/${context.chapterId}/${CHAPTER_MEDIA_MANIFEST_FILE}`,
  ]);
}

export function androidChapterMediaTransactionPaths({
  archivePaths,
  manifestPaths,
}: {
  archivePaths: string[];
  manifestPaths: string[];
}): string[] {
  return uniqueAndroidStoragePaths([
    ...archivePaths.flatMap((path) => [
      path,
      `${path}.tmp.zip`,
      `${path}.bak`,
      `${path}.rollback`,
    ]),
    ...manifestPaths.flatMap((path) => [path, `${path}.tmp`, `${path}.bak`]),
  ]);
}

export function chapterMediaManifestLogContext(
  context: ChapterMediaStorageContext,
) {
  return {
    chapterId: context.chapterId,
    chapterName: context.chapterName,
    chapterNumber: context.chapterNumber,
    chapterPosition: context.chapterPosition,
    hasStorageContext: hasStorageContext(context),
    manifestPaths: androidChapterMediaManifestRelativePathCandidates(context),
    novelId: context.novelId,
    novelName: context.novelName,
    novelPath: context.novelPath,
    sourceId: context.sourceId,
  };
}
