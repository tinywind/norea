import { listChaptersByNovel } from "../db/queries/chapter";
import {
  findLocalNovelByPath,
  getNovelById,
  upsertLocalNovel,
  type LocalNovelImportResult,
} from "../db/queries/novel";
import { syncLocalChapterStorageAfterOrderChange } from "./local-chapter-storage";
import {
  convertLocalImportFile,
  type LocalImportAnalysis,
} from "./local-import";
import { cacheLocalImportedChapterMedia } from "./local-import-media";

export interface LocalFileLibraryImportOptions {
  analysis?: LocalImportAnalysis;
  novelName?: string;
}

export async function importLocalFileToLibrary(
  file: File,
  options: LocalFileLibraryImportOptions = {},
): Promise<LocalNovelImportResult> {
  const conversion = await convertLocalImportFile(file, {
    analysis: options.analysis,
  });
  const novelName = options.novelName ?? conversion.novel.name;
  const chapters = conversion.chapters.map((chapter, index) => ({
    chapterNumber:
      chapter.chapterNumber == null ? null : String(chapter.chapterNumber),
    content: chapter.content,
    binaryResource: chapter.binaryResource,
    contentBytes: chapter.contentBytes,
    contentType: chapter.contentType,
    mediaResources: chapter.mediaResources,
    name: chapter.name,
    page: chapter.page,
    path: chapter.path,
    position: index + 1,
    releaseTime: chapter.releaseTime ?? null,
  }));

  const previousNovel = await findLocalNovelByPath(conversion.novel.path);
  const previousChapters = previousNovel
    ? await listChaptersByNovel(previousNovel.id)
    : [];
  const result = await upsertLocalNovel({
    artist: conversion.novel.artist ?? null,
    author: conversion.novel.author ?? null,
    chapters,
    cover: conversion.novel.cover ?? null,
    genres: conversion.novel.genres ?? null,
    name: novelName,
    path: conversion.novel.path,
    status: conversion.novel.status ?? null,
    summary: conversion.novel.summary ?? null,
  });
  const nextNovel = await getNovelById(result.novelId);
  if (previousNovel && nextNovel?.isLocal) {
    const nextChapters = await listChaptersByNovel(result.novelId);
    await syncLocalChapterStorageAfterOrderChange({
      nextChapters,
      novel: nextNovel,
      previousChapters,
      previousNovel,
    });
  }
  await cacheLocalImportedChapterMedia({
    chapters,
    novelId: result.novelId,
    novelName,
    novelPath: conversion.novel.path,
  });
  return result;
}
