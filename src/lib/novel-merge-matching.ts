import type { NovelMergeChapterDecision } from "../db/queries/novel-merge";
import { parseChapterTitle, type ChapterTitleIdentity } from "./chapter-title";

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
  /** Chapters suggested by title or number evidence, in target order. */
  candidateTargetPaths: string[];
}

export interface NovelMergeChapterMatching {
  matched: NovelMergeAutoMatch[];
  ambiguous: NovelMergeAmbiguousChapter[];
  /** Source chapters without a title or number candidate. */
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

interface ChapterMatchIdentity extends ChapterTitleIdentity {
  storedNumber: string | null;
}

function chapterMatchIdentity(
  chapter: Pick<NovelMergeMatchSourceChapter, "name"> & {
    chapterNumber: string | number | null;
  },
): ChapterMatchIdentity {
  return {
    ...parseChapterTitle(chapter.name),
    storedNumber: chapterNumberKey(chapter.chapterNumber),
  };
}

function compatibleChapterIdentities(
  source: ChapterMatchIdentity,
  target: ChapterMatchIdentity,
  displayedMatch = false,
): boolean {
  if (
    source.uncertain || target.uncertain ||
    source.scope !== target.scope ||
    source.exactTitle === null || target.exactTitle === null
  ) return false;
  if (source.displayNumber !== null && target.displayNumber !== null) {
    if (source.displayNumber !== target.displayNumber) return false;
    // A provider may omit a subtitle entirely. When both include additional
    // numbers, keep contradictory subparts for review even under the same label.
    return source.remainingNumbers === target.remainingNumbers ||
      (displayedMatch && (!source.remainingNumbers || !target.remainingNumbers));
  }
  if (source.remainingNumbers !== target.remainingNumbers) return false;
  // A stored value may be a provider's row ID. It cannot override a displayed
  // episode number, even when both providers happened to reuse the same ID.
  if (source.displayNumber !== null) return target.storedNumber === source.displayNumber;
  if (target.displayNumber !== null) return source.storedNumber === target.displayNumber;
  return true;
}

function groupByMatchKey<T>(
  values: readonly T[],
  key: (value: T) => string | null,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const matchKey = key(value);
    if (matchKey === null) continue;
    const group = groups.get(matchKey) ?? [];
    group.push(value);
    groups.set(matchKey, group);
  }
  return groups;
}

/**
 * Prefer unique displayed episode labels, including season/part/story kind,
 * then unique exact titles that retain numbers. Stored numbers are only a
 * fallback when title evidence agrees. Conflicts and duplicates stay manual;
 * list positions are never used as episode identities.
 */
export function matchNovelMergeChapters(
  sourceChapters: readonly NovelMergeMatchSourceChapter[],
  targetChapters: readonly NovelMergeMatchTargetChapter[],
): NovelMergeChapterMatching {
  const sources = sourceChapters.map(chapter => ({ chapter, identity: chapterMatchIdentity(chapter) }));
  const targets = targetChapters.map(chapter => ({ chapter, identity: chapterMatchIdentity(chapter) }));
  const sourceDisplay = groupByMatchKey(sources, item => item.identity.displayKey);
  const targetDisplay = groupByMatchKey(targets, item => item.identity.displayKey);
  const sourceTitles = groupByMatchKey(sources, item => item.identity.exactTitle);
  const targetTitles = groupByMatchKey(targets, item => item.identity.exactTitle);
  const sourceStored = groupByMatchKey(sources, item => item.identity.storedNumber);
  const targetStored = groupByMatchKey(targets, item => item.identity.storedNumber);
  type Outcome =
    | { kind: "match"; targetChapterPath: string }
    | { kind: "ambiguous"; reason: NovelMergeAmbiguityReason; candidateTargetPaths: string[] }
    | { kind: "unmatched" };
  const outcomes = new Map<number, Outcome>();
  const choose = (
    source: typeof sources[number],
    candidates: typeof targets,
    sourceCount: number,
    repeatedReason: NovelMergeAmbiguityReason = "repeatedNumber",
    displayedMatch = false,
  ) => {
    const candidateTargetPaths = candidates.map(item => item.chapter.path);
    if (sourceCount > 1 || candidates.length > 1) {
      outcomes.set(source.chapter.id, { kind: "ambiguous", reason: repeatedReason, candidateTargetPaths });
      return;
    }
    const target = candidates[0]!;
    if (
      !compatibleChapterIdentities(source.identity, target.identity, displayedMatch) ||
      (!displayedMatch && chapterTitleSimilarity(source.chapter.name, target.chapter.name) < CHAPTER_TITLE_SIMILARITY_THRESHOLD)
    ) {
      outcomes.set(source.chapter.id, { kind: "ambiguous", reason: "titleMismatch", candidateTargetPaths });
      return;
    }
    outcomes.set(source.chapter.id, { kind: "match", targetChapterPath: target.chapter.path });
  };

  for (const source of sources) {
    const { displayKey, exactTitle, storedNumber } = source.identity;
    const displayed = displayKey === null ? [] : targetDisplay.get(displayKey) ?? [];
    if (displayed.length) {
      choose(source, displayed, sourceDisplay.get(displayKey!)!.length, "repeatedNumber", true);
      continue;
    }
    const titled = exactTitle === null ? [] : targetTitles.get(exactTitle) ?? [];
    if (titled.length) {
      choose(source, titled, sourceTitles.get(exactTitle!)!.length, "titleMismatch");
      continue;
    }
    if (storedNumber === null) {
      outcomes.set(source.chapter.id, { kind: "ambiguous", reason: "missingNumber", candidateTargetPaths: [] });
      continue;
    }
    const stored = targetStored.get(storedNumber) ?? [];
    if (!stored.length) {
      outcomes.set(source.chapter.id, { kind: "unmatched" });
      continue;
    }
    choose(source, stored, sourceStored.get(storedNumber)!.length);
  }

  const proposedCounts = new Map<string, number>();
  for (const outcome of outcomes.values()) {
    if (outcome.kind === "match") {
      proposedCounts.set(outcome.targetChapterPath, (proposedCounts.get(outcome.targetChapterPath) ?? 0) + 1);
    }
  }
  const matching: NovelMergeChapterMatching = {
    matched: [],
    ambiguous: [],
    unmatchedSourceChapterIds: [],
  };
  for (const source of sources) {
    const sourceChapterId = source.chapter.id;
    const outcome = outcomes.get(sourceChapterId)!;
    if (outcome.kind === "unmatched") matching.unmatchedSourceChapterIds.push(sourceChapterId);
    else if (outcome.kind === "ambiguous") {
      matching.ambiguous.push({ sourceChapterId, reason: outcome.reason, candidateTargetPaths: outcome.candidateTargetPaths });
    } else if (proposedCounts.get(outcome.targetChapterPath)! > 1) {
      matching.ambiguous.push({ sourceChapterId, reason: "repeatedNumber", candidateTargetPaths: [outcome.targetChapterPath] });
    } else {
      matching.matched.push({ sourceChapterId, targetChapterPath: outcome.targetChapterPath });
    }
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
