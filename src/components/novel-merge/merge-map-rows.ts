import type { NovelMergeChapterDecision } from "../../db/queries/novel-merge";
import type {
  NovelMergeAmbiguityReason,
  NovelMergeChapterMatching,
  NovelMergeCopyConflict,
} from "../../lib/novel-merge-matching";

export type NovelMergeDecisionMap = Readonly<
  Record<number, NovelMergeChapterDecision | undefined>
>;

export type MergeMapSection = "conflicts" | "unmatched" | "ambiguous" | "matched";

export type MergeMapRow =
  | { key: string; kind: "header"; count: number; section: MergeMapSection }
  | { key: string; kind: "conflict"; conflict: NovelMergeCopyConflict }
  | {
      key: string;
      kind: "chapter";
      reason?: NovelMergeAmbiguityReason;
      section: Exclude<MergeMapSection, "conflicts">;
      sourceChapterId: number;
    };

interface BuildMergeMapRowsOptions {
  conflicts: readonly NovelMergeCopyConflict[];
  copyChoices: Readonly<Record<string, number>>;
  decisions: NovelMergeDecisionMap;
  matchedExpanded: boolean;
  matching: NovelMergeChapterMatching;
  undecidedOnly: boolean;
}

export function sourceChapterRowKey(sourceChapterId: number): string {
  return `chapter:${sourceChapterId}`;
}

function isConflictResolved(
  conflict: NovelMergeCopyConflict,
  copyChoices: Readonly<Record<string, number>>,
): boolean {
  const choice = copyChoices[conflict.targetChapterPath];
  return choice !== undefined && conflict.sourceChapterIds.includes(choice);
}

/** Source chapter ids in the order the map step lists them. */
export function mergeMapSourceOrder(matching: NovelMergeChapterMatching): number[] {
  return [
    ...matching.unmatchedSourceChapterIds,
    ...matching.ambiguous.map((item) => item.sourceChapterId),
    ...matching.matched.map((item) => item.sourceChapterId),
  ];
}

/**
 * Flattens the map step into section headers and rows: copy conflicts,
 * unmatched, ambiguous, then matched. Matched rows show only when expanded.
 * "Undecided only" hides decided rows and resolved conflicts, and always shows
 * matched rows whose mapping was cleared.
 */
export function buildMergeMapRows({
  conflicts,
  copyChoices,
  decisions,
  matchedExpanded,
  matching,
  undecidedOnly,
}: BuildMergeMapRowsOptions): MergeMapRow[] {
  const rows: MergeMapRow[] = [];
  const visible = (sourceChapterId: number) =>
    !undecidedOnly || decisions[sourceChapterId] === undefined;

  const shownConflicts = conflicts.filter(
    (conflict) => !undecidedOnly || !isConflictResolved(conflict, copyChoices),
  );
  if (shownConflicts.length > 0) {
    rows.push({
      count: conflicts.length,
      key: "header:conflicts",
      kind: "header",
      section: "conflicts",
    });
    for (const conflict of shownConflicts) {
      rows.push({
        conflict,
        key: `conflict:${conflict.targetChapterPath}`,
        kind: "conflict",
      });
    }
  }

  const pushSection = (
    section: "unmatched" | "ambiguous",
    items: readonly { reason?: NovelMergeAmbiguityReason; sourceChapterId: number }[],
  ) => {
    const shown = items.filter((item) => visible(item.sourceChapterId));
    if (shown.length === 0) return;
    rows.push({ count: items.length, key: `header:${section}`, kind: "header", section });
    for (const item of shown) {
      rows.push({
        key: sourceChapterRowKey(item.sourceChapterId),
        kind: "chapter",
        reason: item.reason,
        section,
        sourceChapterId: item.sourceChapterId,
      });
    }
  };
  pushSection(
    "unmatched",
    matching.unmatchedSourceChapterIds.map((sourceChapterId) => ({ sourceChapterId })),
  );
  pushSection("ambiguous", matching.ambiguous);

  if (matching.matched.length > 0) {
    const shownMatched = matching.matched.filter((item) =>
      undecidedOnly
        ? decisions[item.sourceChapterId] === undefined
        : matchedExpanded,
    );
    if (!undecidedOnly || shownMatched.length > 0) {
      rows.push({
        count: matching.matched.length,
        key: "header:matched",
        kind: "header",
        section: "matched",
      });
    }
    for (const item of shownMatched) {
      rows.push({
        key: sourceChapterRowKey(item.sourceChapterId),
        kind: "chapter",
        section: "matched",
        sourceChapterId: item.sourceChapterId,
      });
    }
  }
  return rows;
}

/**
 * The next undecided source chapter after `currentId` in list order, wrapping
 * around; null when every chapter is decided.
 */
export function nextUndecidedSourceChapterId(
  order: readonly number[],
  decisions: NovelMergeDecisionMap,
  currentId: number | null,
): number | null {
  const start = currentId === null ? -1 : order.indexOf(currentId);
  for (let step = 1; step <= order.length; step += 1) {
    const candidate = order[(start + step + order.length) % order.length]!;
    if (decisions[candidate] === undefined) return candidate;
  }
  return null;
}

export interface NovelMergeSummarySourceChapter {
  id: number;
  isDownloaded: boolean;
  progress: number;
  unread: boolean;
}

export interface NovelMergeDecisionSummary {
  copyChoices: number;
  downloadsMoved: number;
  downloadsRemoved: number;
  excluded: number;
  mapped: number;
  readDropped: number;
  readMoved: number;
}

/** Counts shown before execution, because the migration moves real data. */
export function summarizeNovelMergeDecisions(
  sourceChapters: readonly NovelMergeSummarySourceChapter[],
  decisions: NovelMergeDecisionMap,
  conflicts: readonly NovelMergeCopyConflict[],
): NovelMergeDecisionSummary {
  const summary: NovelMergeDecisionSummary = {
    copyChoices: conflicts.length,
    downloadsMoved: 0,
    downloadsRemoved: 0,
    excluded: 0,
    mapped: 0,
    readDropped: 0,
    readMoved: 0,
  };
  const movedTargetPaths = new Set<string>();
  let downloaded = 0;
  for (const chapter of sourceChapters) {
    const decision = decisions[chapter.id];
    if (!decision) continue;
    const hasProgress = !chapter.unread || chapter.progress > 0;
    if (chapter.isDownloaded) downloaded += 1;
    if (decision.kind === "map") {
      summary.mapped += 1;
      if (hasProgress) summary.readMoved += 1;
      if (chapter.isDownloaded) movedTargetPaths.add(decision.targetChapterPath);
    } else {
      summary.excluded += 1;
      if (hasProgress) summary.readDropped += 1;
    }
  }
  summary.downloadsMoved = movedTargetPaths.size;
  summary.downloadsRemoved = downloaded - movedTargetPaths.size;
  return summary;
}
