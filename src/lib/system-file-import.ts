import { listChaptersByNovel } from "../db/queries/chapter";
import { analyzeLocalImportFile } from "./local-import";
import { importLocalFileToLibrary } from "./local-import-library";

export interface SystemOpenedFileImportResult {
  chapterId: number;
  novelId: number;
}

export async function importSystemOpenedFile(
  file: File,
): Promise<SystemOpenedFileImportResult> {
  const analysis = await analyzeLocalImportFile(file);
  const result = await importLocalFileToLibrary(file, {
    analysis,
    novelName: analysis.title,
  });
  const firstChapter = (await listChaptersByNovel(result.novelId))[0];
  if (!firstChapter) {
    throw new Error(
      "System-opened file import created no readable chapter.",
    );
  }
  return {
    chapterId: firstChapter.id,
    novelId: result.novelId,
  };
}
