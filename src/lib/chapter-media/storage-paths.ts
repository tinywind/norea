import { getChapterById } from "../../db/queries/chapter";
import { getNovelById } from "../../db/queries/novel";
import {
  type ChapterStorageChapterPathInput,
  type ChapterStorageNovelPathInput,
  chapterMediaArchiveRelativePath,
  chapterMediaRelativePath,
  chapterStorageRelativeDir,
} from "../chapter-storage-path";
import { resolvedChapterStorageDir } from "../chapter-storage-resolution";
import { type ChapterMediaStorageContext } from "./types";

export function hasStorageContext(
  context: ChapterMediaStorageContext | null | undefined,
): context is ChapterMediaStorageContext & {
  sourceNovelId: string;
  sourceId: string;
} {
  return !!context?.sourceNovelId?.trim() && !!context.sourceId?.trim();
}

export function storageNovelPathInput(
  context: ChapterMediaStorageContext,
): ChapterStorageNovelPathInput {
  return {
    id: context.novelId,
    name: context.novelName,
    pluginId: context.sourceId,
    sourceNovelId: context.sourceNovelId,
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
    sourceNovelId: novel.sourceNovelId,
    sourceId: novel.pluginId,
  };
}

export function androidChapterMediaRelativePathForContext(
  context: ChapterMediaStorageContext | null | undefined,
  fileName?: string,
): string {
  if (!hasStorageContext(context)) {
    throw new Error("Chapter media storage identity is required.");
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

export function androidChapterMediaArchiveRelativePathForContext(
  context: ChapterMediaStorageContext | null | undefined,
): string {
  if (!hasStorageContext(context)) {
    throw new Error("Chapter media storage identity is required.");
  }
  return resolvedAndroidChapterStoragePath(
    context,
    chapterMediaArchiveRelativePath(
      storageNovelPathInput(context),
      storageChapterPathInput(context),
    ),
  );
}
