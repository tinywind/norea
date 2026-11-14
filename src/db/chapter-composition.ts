import type { DatabaseReadMode } from "./client";
import { invokeDbQuery } from "./ipc";
import {
  parseChapterComposition,
  type ChapterCompositionV1,
} from "../lib/chapter-composition";

export async function readChapterComposition(
  novelId: number,
  readMode?: DatabaseReadMode,
): Promise<ChapterCompositionV1 | null> {
  const row = await invokeDbQuery<ChapterCompositionV1 | null>(
    "db_chapter_composition_get",
    { novelId, ...(readMode ? { readMode } : {}) },
  );
  return row ? parseChapterComposition(row) : null;
}
