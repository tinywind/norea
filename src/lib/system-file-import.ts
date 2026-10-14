import { findLocalImportedChapter } from "../db/queries/chapter";
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
  });
  const importedChapter = await findLocalImportedChapter(analysis.pathKey);
  if (!importedChapter) {
    throw new Error(
      "System-opened file import created no readable chapter.",
    );
  }
  return {
    chapterId: importedChapter.id,
    novelId: result.novelId,
  };
}
