import { listLibraryDownloadChapters } from "../../db/queries/chapter";
import { listDownloadGoalNovels } from "../../db/queries/novel-download-goal";
import { useDownloadGoalSettingsStore } from "../../store/download-goals";
import { useReaderStore } from "../../store/reader";
import { ACTIVE_NOVEL_WINDOW_SECONDS, goalReadingChapterId, goalTargetChapters } from "./goal-targets";

/**
 * Chapters of these novels that a download goal in effect keeps downloaded: the
 * keep-ahead window or every remaining chapter after the reading position, or the
 * whole novel. Deleting one of them is something a goal would undo.
 */
export async function listGoalProtectedChapterIds(novelIds: readonly number[]): Promise<Set<number>> {
  const protectedIds = new Set<number>();
  if (novelIds.length === 0) return protectedIds;
  const defaultKeepAhead = useDownloadGoalSettingsStore.getState().defaultKeepAhead;
  const activeSince = defaultKeepAhead > 0 ? Math.floor(Date.now() / 1000) - ACTIVE_NOVEL_WINDOW_SECONDS : null;
  const lastRead = useReaderStore.getState().lastReadChapterByNovel;
  for (const novel of await listDownloadGoalNovels(activeSince, novelIds)) {
    const goal = novel.goal ?? { kind: "keep_ahead" as const, count: defaultKeepAhead };
    const chapters = await listLibraryDownloadChapters(novel.id);
    const readingChapterId = goalReadingChapterId(chapters, lastRead[novel.id]);
    for (const chapter of goalTargetChapters(goal, chapters, readingChapterId)) protectedIds.add(chapter.id);
  }
  return protectedIds;
}
