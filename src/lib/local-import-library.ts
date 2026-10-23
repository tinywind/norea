import {
  upsertLocalNovel,
  type LocalNovelImportResult,
} from "../db/queries/novel";
import {
  convertLocalImportFile,
  type LocalImportAnalysis,
} from "./local-import";
import { cacheLocalImportedChapterMedia } from "./local-import-media";
import { LOCAL_NOVEL_NAME, LOCAL_NOVEL_PATH } from "./local-library-identity";

export interface LocalFileLibraryImportOptions {
  analysis?: LocalImportAnalysis;
}

export async function importLocalFileToLibrary(
  file: File,
  options: LocalFileLibraryImportOptions = {},
): Promise<LocalNovelImportResult> {
  const conversion = await convertLocalImportFile(file, {
    analysis: options.analysis,
  });
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

  const result = await upsertLocalNovel({
    chapters,
    name: LOCAL_NOVEL_NAME,
    path: LOCAL_NOVEL_PATH,
  });
  await cacheLocalImportedChapterMedia({
    chapters,
    novelId: result.novelId,
    novelName: LOCAL_NOVEL_NAME,
    sourceNovelId: LOCAL_NOVEL_PATH,
  });
  return result;
}
