import { hasStoredChapterContent, type ChapterListRow } from "../../db/queries/chapter";
import type { NovelDownloadGoal } from "../../db/queries/novel-download-goal";

/** Automatic policies apply to library novels opened within this window. */
export const ACTIVE_NOVEL_WINDOW_SECONDS = 14 * 24 * 60 * 60;

export function automaticDownloadActiveSince(goal: NovelDownloadGoal, nowSeconds = Math.floor(Date.now() / 1000)): number | null {
  return goal.kind === "none" ? null : nowSeconds - ACTIVE_NOVEL_WINDOW_SECONDS;
}

/** The global automatic policy applies to every active library source novel except an explicit pause. */
export function effectiveDownloadGoal(
  own: NovelDownloadGoal | null,
  novel: { inLibrary: boolean; isLocal: boolean; lastReadAt: number | null },
  automaticGoal: NovelDownloadGoal,
  nowSeconds: number,
): { goal: NovelDownloadGoal | null; isDefault: boolean } {
  const activeSince = automaticDownloadActiveSince(automaticGoal, nowSeconds);
  const active = activeSince !== null && novel.inLibrary && !novel.isLocal && novel.lastReadAt !== null &&
    novel.lastReadAt >= activeSince;
  return active && own?.kind !== "none"
    ? { goal: automaticGoal, isDefault: true }
    : { goal: null, isDefault: false };
}

export type GoalChapter = Pick<ChapterListRow, "id" | "isDownloaded" | "contentBytes" | "mediaRepairNeeded" | "readAt">;

export interface GoalTargets<C extends GoalChapter> {
  /** Every chapter the goal covers, in reading order. */
  targets: C[];
  /** Covered chapters with a stored body, including those still missing images. */
  stored: number;
  /** Covered chapters whose body is stored but whose images are incomplete; reported, not requested again. */
  missingMedia: C[];
  /** Covered chapters without a body that queued or running work already owns. */
  inFlight: number;
  /** Covered chapters left out on purpose: user-deleted, cancelled or failed until cleared. */
  excluded: number;
  /** Covered chapters the goal should request now. */
  pending: C[];
}

/** The chapter the reader last opened, or the most recently read chapter when no position is remembered. */
export function goalReadingChapterId(
  chapters: readonly GoalChapter[],
  rememberedChapterId: number | undefined,
): number | undefined {
  if (rememberedChapterId !== undefined && chapters.some((chapter) => chapter.id === rememberedChapterId)) {
    return rememberedChapterId;
  }
  let latest: GoalChapter | undefined;
  for (const chapter of chapters) {
    if (chapter.readAt !== null && (latest === undefined || chapter.readAt > (latest.readAt ?? 0))) latest = chapter;
  }
  return latest?.id;
}

/** Chapters a goal covers: after the reading position for keep-ahead and all-remaining, or every chapter. */
export function goalTargetChapters<C extends GoalChapter>(
  goal: NovelDownloadGoal,
  readingOrder: readonly C[],
  readingChapterId: number | undefined,
): C[] {
  if (goal.kind === "none") return [];
  if (goal.kind === "entire") return [...readingOrder];
  const current = readingChapterId === undefined ? -1 : readingOrder.findIndex((chapter) => chapter.id === readingChapterId);
  const after = readingOrder.slice(current + 1);
  return goal.kind === "keep_ahead" ? after.slice(0, goal.count) : after;
}

/**
 * Splits a goal's chapters into what is satisfied, already owned by queued work,
 * deliberately excluded and still to request, keeping reading order.
 */
export function resolveGoalTargets<C extends GoalChapter>(
  goal: NovelDownloadGoal,
  readingOrder: readonly C[],
  readingChapterId: number | undefined,
  isOwned: (chapter: C) => boolean,
  isExcluded: (chapter: C) => boolean,
): GoalTargets<C> {
  const targets = goalTargetChapters(goal, readingOrder, readingChapterId);
  const result: GoalTargets<C> = { targets, stored: 0, missingMedia: [], inFlight: 0, excluded: 0, pending: [] };
  for (const chapter of targets) {
    if (hasStoredChapterContent(chapter)) {
      result.stored += 1;
      if (chapter.mediaRepairNeeded) result.missingMedia.push(chapter);
    } else if (isOwned(chapter)) {
      result.inFlight += 1;
    } else if (isExcluded(chapter)) {
      result.excluded += 1;
    } else {
      result.pending.push(chapter);
    }
  }
  return result;
}
