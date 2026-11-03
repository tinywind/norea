import { hasStoredChapterContent, type ChapterListRow } from "../../db/queries/chapter";
import type { NovelDownloadGoal } from "../../db/queries/novel-download-goal";
import type { ChapterDownloadStatus } from "../tasks/chapter-download";
import { resolveGoalTargets } from "./goal-targets";

export type DownloadGoalProgress =
  | { kind: "none"; onDevice: number; missingImages: number }
  | { kind: "downloading"; done: number; total: number }
  | { kind: "waiting"; remaining: number }
  | { kind: "satisfied"; onDevice: number; missingImages: number };

const isActive = (status: ChapterDownloadStatus | undefined) => status?.kind === "queued" || status?.kind === "running";

/** What the novel page says about a goal: progress over its chapters, or what is already on the device. */
export function describeDownloadGoalProgress(
  goal: NovelDownloadGoal | null,
  readingOrder: readonly ChapterListRow[],
  readingChapterId: number | undefined,
  statuses: ReadonlyMap<number, ChapterDownloadStatus>,
): DownloadGoalProgress {
  const onDevice = readingOrder.filter(hasStoredChapterContent).length;
  const missingImages = readingOrder.filter((chapter) => hasStoredChapterContent(chapter) && chapter.mediaRepairNeeded).length;
  if (!goal) return { kind: "none", onDevice, missingImages };
  const targets = resolveGoalTargets(goal, readingOrder, readingChapterId,
    (chapter) => isActive(statuses.get(chapter.id)), () => false);
  if (targets.inFlight > 0) return { kind: "downloading", done: targets.stored, total: targets.targets.length };
  if (targets.pending.length > 0) return { kind: "waiting", remaining: targets.pending.length };
  return { kind: "satisfied", onDevice, missingImages };
}

/** "about 25 min", or "a few hours" past two hours. */
export function formatDownloadEta(ms: number): { key: "downloadGoals.eta.minutes" | "downloadGoals.eta.lessThanMinute" | "downloadGoals.eta.hours"; minutes: number } {
  if (ms > 2 * 60 * 60 * 1000) return { key: "downloadGoals.eta.hours", minutes: 0 };
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? { key: "downloadGoals.eta.lessThanMinute", minutes: 0 } : { key: "downloadGoals.eta.minutes", minutes };
}
