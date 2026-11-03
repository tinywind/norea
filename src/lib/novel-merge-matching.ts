import type { NovelMergeChapterDecision } from "../db/queries/novel-merge";

export interface NovelMergeMatchSourceChapter {
  id: number;
  name: string;
  chapterNumber: string | null;
  isDownloaded: boolean;
}

export interface NovelMergeMatchTargetChapter {
  path: string;
  name: string;
  chapterNumber: number;
}

export interface NovelMergeAutoMatch {
  sourceChapterId: number;
  targetChapterPath: string;
}

export type NovelMergeAmbiguityReason =
  | "missingNumber"
  | "repeatedNumber"
  | "titleMismatch";

export interface NovelMergeAmbiguousChapter {
  sourceChapterId: number;
  reason: NovelMergeAmbiguityReason;
  /** Target chapters that share the source chapter's number, in target order. */
  candidateTargetPaths: string[];
}

export interface NovelMergeChapterMatching {
  matched: NovelMergeAutoMatch[];
  ambiguous: NovelMergeAmbiguousChapter[];
  /** Source chapters whose number no target chapter has. */
  unmatchedSourceChapterIds: number[];
}

export interface NovelMergeCopyConflict {
  targetChapterPath: string;
  /** Downloaded source chapters mapped to the same target, in source order. */
  sourceChapterIds: number[];
}

/**
 * Below this bigram similarity, two titles with the same chapter number are
 * treated as different chapters that need review.
 */
export const CHAPTER_TITLE_SIMILARITY_THRESHOLD = 0.3;

const CHAPTER_LABEL_PATTERNS = [
  /\b(?:chapter|chap|ch|episode|ep)\.?\s*\d+(?:\.\d+)?/gu,
  /(?:第|제)?\s*\d+(?:\.\d+)?\s*(?:話|话|章|回|화|장|회)/gu,
  /제\s*\d+(?:\.\d+)?/gu,
];

function chapterNumberKey(value: number | string | null): string | null {
  if (value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(numeric) : null;
}

/**
 * Lowercases a chapter title and removes its chapter-number label, digits,
 * punctuation and whitespace, so only the descriptive part is compared.
 */
export function normalizeChapterTitle(title: string): string {
  let normalized = title.normalize("NFKC").toLowerCase();
  for (const pattern of CHAPTER_LABEL_PATTERNS) {
    normalized = normalized.replace(pattern, " ");
  }
  return normalized
    .replace(/\d+(?:\.\d+)?/gu, " ")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function bigrams(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  const characters = [...value];
  for (let index = 0; index < characters.length - 1; index += 1) {
    const pair = characters[index]! + characters[index + 1]!;
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/**
 * Dice similarity of the normalized titles' character bigrams, from 0 to 1.
 * A title with no descriptive part (such as "Chapter 12"), or one contained in
 * the other, counts as fully similar.
 */
export function chapterTitleSimilarity(left: string, right: string): number {
  const a = normalizeChapterTitle(left);
  const b = normalizeChapterTitle(right);
  if (a === "" || b === "" || a.includes(b) || b.includes(a)) return 1;
  const leftPairs = bigrams(a);
  const rightPairs = bigrams(b);
  let leftTotal = 0;
  let rightTotal = 0;
  let shared = 0;
  for (const count of leftPairs.values()) leftTotal += count;
  for (const [pair, count] of rightPairs) {
    rightTotal += count;
    shared += Math.min(count, leftPairs.get(pair) ?? 0);
  }
  if (leftTotal + rightTotal === 0) return 0;
  return (2 * shared) / (leftTotal + rightTotal);
}

/**
 * Matches source chapters to target chapters by chapter number. A pair is
 * auto-matched only when its number is unique on both sides and the titles are
 * not very different; every other source chapter with a number match is
 * ambiguous, and one with no number match is unmatched.
 */
export function matchNovelMergeChapters(
  sourceChapters: readonly NovelMergeMatchSourceChapter[],
  targetChapters: readonly NovelMergeMatchTargetChapter[],
): NovelMergeChapterMatching {
  const sourceCountByKey = new Map<string, number>();
  for (const chapter of sourceChapters) {
    const key = chapterNumberKey(chapter.chapterNumber);
    if (key !== null) sourceCountByKey.set(key, (sourceCountByKey.get(key) ?? 0) + 1);
  }
  const targetsByKey = new Map<string, NovelMergeMatchTargetChapter[]>();
  for (const chapter of targetChapters) {
    const key = chapterNumberKey(chapter.chapterNumber);
    if (key === null) continue;
    const targets = targetsByKey.get(key) ?? [];
    targets.push(chapter);
    targetsByKey.set(key, targets);
  }

  const matching: NovelMergeChapterMatching = {
    matched: [],
    ambiguous: [],
    unmatchedSourceChapterIds: [],
  };
  for (const chapter of sourceChapters) {
    const key = chapterNumberKey(chapter.chapterNumber);
    if (key === null) {
      matching.ambiguous.push({
        sourceChapterId: chapter.id,
        reason: "missingNumber",
        candidateTargetPaths: [],
      });
      continue;
    }
    const targets = targetsByKey.get(key) ?? [];
    if (targets.length === 0) {
      matching.unmatchedSourceChapterIds.push(chapter.id);
      continue;
    }
    const candidateTargetPaths = targets.map((target) => target.path);
    if (targets.length > 1 || sourceCountByKey.get(key)! > 1) {
      matching.ambiguous.push({
        sourceChapterId: chapter.id,
        reason: "repeatedNumber",
        candidateTargetPaths,
      });
      continue;
    }
    const target = targets[0]!;
    if (
      chapterTitleSimilarity(chapter.name, target.name) <
      CHAPTER_TITLE_SIMILARITY_THRESHOLD
    ) {
      matching.ambiguous.push({
        sourceChapterId: chapter.id,
        reason: "titleMismatch",
        candidateTargetPaths,
      });
      continue;
    }
    matching.matched.push({
      sourceChapterId: chapter.id,
      targetChapterPath: target.path,
    });
  }
  return matching;
}

/**
 * Targets that several downloaded source chapters map to. Only one download
 * can move to a target chapter, so each conflict needs a copy choice.
 */
export function findNovelMergeCopyConflicts(
  sourceChapters: readonly Pick<NovelMergeMatchSourceChapter, "id" | "isDownloaded">[],
  decisions: readonly NovelMergeChapterDecision[],
): NovelMergeCopyConflict[] {
  const decisionBySourceId = new Map(
    decisions.map((decision) => [decision.sourceChapterId, decision]),
  );
  const sourceIdsByTargetPath = new Map<string, number[]>();
  for (const chapter of sourceChapters) {
    if (!chapter.isDownloaded) continue;
    const decision = decisionBySourceId.get(chapter.id);
    if (decision?.kind !== "map") continue;
    const sourceIds = sourceIdsByTargetPath.get(decision.targetChapterPath) ?? [];
    sourceIds.push(chapter.id);
    sourceIdsByTargetPath.set(decision.targetChapterPath, sourceIds);
  }
  return [...sourceIdsByTargetPath]
    .filter(([, sourceIds]) => sourceIds.length > 1)
    .map(([targetChapterPath, sourceChapterIds]) => ({
      targetChapterPath,
      sourceChapterIds,
    }));
}
