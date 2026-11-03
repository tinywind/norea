import { listLibraryDownloadChapters } from "../../db/queries/chapter";
import { listDownloadGoalExcludedChapterIds, listDownloadGoalNovels } from "../../db/queries/novel-download-goal";
import { useDownloadGoalSettingsStore } from "../../store/download-goals";
import { useReaderStore } from "../../store/reader";
import { pluginManager } from "../plugins/manager";
import { isChapterDownloadQueued } from "../tasks/chapter-download";
import { getChapterDownloadFailureSnapshot } from "../tasks/chapter-download-failures";
import { ACTIVE_NOVEL_WINDOW_SECONDS, goalReadingChapterId, resolveGoalTargets } from "./goal-targets";

/**
 * A goal novel's offline state for its library card: every covered chapter on the device,
 * chapters still to download, or something the user must fix (a failure, missing images,
 * or an uninstalled source).
 */
export type DownloadGoalOfflineState = "ready" | "downloading" | "attention";

/** Offline state per novel with a goal in effect; novels without one are absent. */
export async function describeDownloadGoalOfflineStates(nowSeconds = Math.floor(Date.now() / 1000)): Promise<
  Map<number, DownloadGoalOfflineState>
> {
  const defaultKeepAhead = useDownloadGoalSettingsStore.getState().defaultKeepAhead;
  const activeSince = defaultKeepAhead > 0 ? nowSeconds - ACTIVE_NOVEL_WINDOW_SECONDS : null;
  const states = new Map<number, DownloadGoalOfflineState>();
  const novels = await listDownloadGoalNovels(activeSince);
  if (novels.length === 0) return states;
  await pluginManager.loadInstalledFromDb();
  const failed = new Set(getChapterDownloadFailureSnapshot().map((row) => row.chapterId));
  for (const novel of novels) {
    const goal = novel.goal ?? { kind: "keep_ahead" as const, count: defaultKeepAhead };
    if (!pluginManager.getPlugin(novel.pluginId)) {
      states.set(novel.id, "attention");
      continue;
    }
    const chapters = await listLibraryDownloadChapters(novel.id);
    const excluded = new Set(await listDownloadGoalExcludedChapterIds(novel.id));
    const readingChapterId = goalReadingChapterId(chapters, useReaderStore.getState().lastReadChapterByNovel[novel.id]);
    let failures = 0;
    const targets = resolveGoalTargets(goal, chapters, readingChapterId,
      (chapter) => chapter.isDownloadQueued || isChapterDownloadQueued(chapter.id),
      (chapter) => {
        if (excluded.has(chapter.id)) return true;
        if (!failed.has(chapter.id)) return false;
        failures += 1;
        return true;
      });
    states.set(novel.id, failures > 0 || targets.missingMedia.length > 0
      ? "attention"
      : targets.inFlight > 0 || targets.pending.length > 0 ? "downloading" : "ready");
  }
  return states;
}
