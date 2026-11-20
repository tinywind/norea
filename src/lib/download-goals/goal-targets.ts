import { hasStoredChapterContent, type ChapterListRow } from "../../db/queries/chapter";
import type { DownloadGoalActiveFilter, NovelDownloadGoal } from "../../db/queries/novel-download-goal";
import { DEFAULT_AUTOMATIC_ACTIVE_WINDOW, type AutomaticActiveWindowChoice } from "../../store/download-goals";

const DAY_SECONDS = 24 * 60 * 60;

/** Fixed active window for source freshness checks (decoupled from automatic download active window). */
export const ACTIVE_NOVEL_WINDOW_SECONDS = 14 * DAY_SECONDS;

export function automaticDownloadActiveSince(goal: NovelDownloadGoal, nowSeconds = Math.floor(Date.now() / 1000)): number | null {
  return goal.kind === "none" ? null : nowSeconds - ACTIVE_NOVEL_WINDOW_SECONDS;
}

export function automaticDownloadActiveFilter(
  goal: NovelDownloadGoal,
  activeWindow: AutomaticActiveWindowChoice = DEFAULT_AUTOMATIC_ACTIVE_WINDOW,
  nowSeconds = Math.floor(Date.now() / 1000),
): DownloadGoalActiveFilter {
  if (goal.kind === "none") return { kind: "none" };
  if (activeWindow === "unlimited") return { kind: "all" };
  return { kind: "since", seconds: nowSeconds - activeWindow * DAY_SECONDS };
}

/** The global automatic policy applies to every active library source novel except an explicit pause. */
export function effectiveDownloadGoal(
  own: NovelDownloadGoal | null,
  novel: { inLibrary: boolean; isLocal: boolean; lastReadAt: number | null },
  automaticGoal: NovelDownloadGoal,
  nowSeconds: number,
  activeWindow: AutomaticActiveWindowChoice = DEFAULT_AUTOMATIC_ACTIVE_WINDOW,
): { goal: NovelDownloadGoal | null; isDefault: boolean } {
  const filter = automaticDownloadActiveFilter(automaticGoal, activeWindow, nowSeconds);
  const withinWindow = filter.kind === "all" ||
    (filter.kind === "since" && novel.lastReadAt !== null && novel.lastReadAt >= filter.seconds);
  const active = filter.kind !== "none" && novel.inLibrary && !novel.isLocal && withinWindow;
  return active && own?.kind !== "none"
    ? { goal: automaticGoal, isDefault: true }
    : { goal: null, isDefault: false };
}

export type GoalChapter = Pick<ChapterListRow, "id" | "isDownloaded" | "contentBytes" | "mediaRepairNeeded" | "readAt" | "progress">;

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

/**
 * The chapter the reader last opened, else the most recently read chapter by `readAt`,
 * else the furthest finished chapter (`progress >= 100`) when chapters lack `readAt`.
 */
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
  if (latest !== undefined) return latest.id;
  let furthestFinished: GoalChapter | undefined;
  for (const chapter of chapters) {
    if (chapter.progress >= 100) furthestFinished = chapter;
  }
  return furthestFinished?.id;
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
