import { describe, expect, it } from "vitest";
import {
  CHAPTER_TITLE_SIMILARITY_THRESHOLD,
  chapterTitleSimilarity,
  findNovelMergeCopyConflicts,
  matchNovelMergeChapters,
  normalizeChapterTitle,
  type NovelMergeMatchSourceChapter,
  type NovelMergeMatchTargetChapter,
} from "./novel-merge-matching";

function source(
  id: number,
  chapterNumber: string | null,
  name = `Chapter ${chapterNumber ?? "?"}`,
  isDownloaded = false,
): NovelMergeMatchSourceChapter {
  return { chapterNumber, id, isDownloaded, name };
}

function target(
  chapterNumber: number,
  name = `Chapter ${chapterNumber}`,
  path = `/target/${chapterNumber}`,
): NovelMergeMatchTargetChapter {
  return { chapterNumber, name, path };
}

describe("normalizeChapterTitle", () => {
  it("drops English chapter labels, digits, punctuation and case", () => {
    expect(normalizeChapterTitle("Chapter 12: The Fall")).toBe("thefall");
    expect(normalizeChapterTitle("Ch. 12 - The Fall!")).toBe("thefall");
    expect(normalizeChapterTitle("Episode 3.5 (Part 2)")).toBe("part");
  });

  it("drops Korean, Japanese and Chinese chapter labels", () => {
    expect(normalizeChapterTitle("제12화 몰락")).toBe("몰락");
    expect(normalizeChapterTitle("12화. 몰락")).toBe("몰락");
    expect(normalizeChapterTitle("제 3 장")).toBe("");
    expect(normalizeChapterTitle("第12話 崩壊")).toBe("崩壊");
    expect(normalizeChapterTitle("第3章")).toBe("");
  });

  it("keeps words that only start like a chapter label", () => {
    expect(normalizeChapterTitle("Change of Heart")).toBe("changeofheart");
    expect(normalizeChapterTitle("Epilogue")).toBe("epilogue");
  });

  it("folds full-width characters before comparing", () => {
    expect(normalizeChapterTitle("Ｃｈａｐｔｅｒ １２ Ｆａｌｌ")).toBe("fall");
  });
});

describe("chapterTitleSimilarity", () => {
  it("treats titles without a descriptive part as fully similar", () => {
    expect(chapterTitleSimilarity("Chapter 12", "Chapter 12 - The Fall")).toBe(1);
    expect(chapterTitleSimilarity("12", "제12화")).toBe(1);
  });

  it("treats a title contained in the other as fully similar", () => {
    expect(chapterTitleSimilarity("The Fall", "The Fall of Rome")).toBe(1);
    expect(chapterTitleSimilarity("몰락", "제12화 몰락 (1)")).toBe(1);
  });

  it("scores reworded titles above the threshold", () => {
    expect(
      chapterTitleSimilarity("Battle at Dawn", "The Dawn Battle"),
    ).toBeGreaterThanOrEqual(CHAPTER_TITLE_SIMILARITY_THRESHOLD);
    expect(
      chapterTitleSimilarity("Return of the King", "King's Return"),
    ).toBeGreaterThanOrEqual(CHAPTER_TITLE_SIMILARITY_THRESHOLD);
  });

  it("scores unrelated titles below the threshold", () => {
    expect(chapterTitleSimilarity("Prologue", "The Beginning")).toBeLessThan(
      CHAPTER_TITLE_SIMILARITY_THRESHOLD,
    );
    expect(chapterTitleSimilarity("몰락", "새로운 시작")).toBeLessThan(
      CHAPTER_TITLE_SIMILARITY_THRESHOLD,
    );
    expect(chapterTitleSimilarity("가", "나")).toBe(0);
  });

  it("is symmetric", () => {
    expect(chapterTitleSimilarity("Battle at Dawn", "Dawn Battle")).toBe(
      chapterTitleSimilarity("Dawn Battle", "Battle at Dawn"),
    );
  });
});

describe("matchNovelMergeChapters", () => {
  it("auto-matches chapters whose numbers are unique on both sides", () => {
    const result = matchNovelMergeChapters(
      [source(1, "1"), source(2, "2"), source(3, "3")],
      [target(3), target(1), target(2)],
    );

    expect(result.matched).toEqual([
      { sourceChapterId: 1, targetChapterPath: "/target/1" },
      { sourceChapterId: 2, targetChapterPath: "/target/2" },
      { sourceChapterId: 3, targetChapterPath: "/target/3" },
    ]);
    expect(result.ambiguous).toEqual([]);
    expect(result.unmatchedSourceChapterIds).toEqual([]);
  });

  it("compares numbers numerically, including fractions", () => {
    const result = matchNovelMergeChapters(
      [source(1, "12.0"), source(2, "12.5"), source(3, "007")],
      [target(12), target(12.5), target(7)],
    );

    expect(result.matched).toEqual([
      { sourceChapterId: 1, targetChapterPath: "/target/12" },
      { sourceChapterId: 2, targetChapterPath: "/target/12.5" },
      { sourceChapterId: 3, targetChapterPath: "/target/7" },
    ]);
  });

  it("marks chapters without a usable number as ambiguous with no candidates", () => {
    const result = matchNovelMergeChapters(
      [source(1, null), source(2, ""), source(3, "abc")],
      [target(1)],
    );

    expect(result.matched).toEqual([]);
    expect(result.ambiguous).toEqual([
      { candidateTargetPaths: [], reason: "missingNumber", sourceChapterId: 1 },
      { candidateTargetPaths: [], reason: "missingNumber", sourceChapterId: 2 },
      { candidateTargetPaths: [], reason: "missingNumber", sourceChapterId: 3 },
    ]);
  });

  it("marks every source chapter that repeats a number as ambiguous", () => {
    const result = matchNovelMergeChapters(
      [source(1, "4", "Chapter 4"), source(2, "4", "Chapter 4 (2)"), source(3, "5")],
      [target(4), target(5)],
    );

    expect(result.matched).toEqual([
      { sourceChapterId: 3, targetChapterPath: "/target/5" },
    ]);
    expect(result.ambiguous).toEqual([
      { candidateTargetPaths: ["/target/4"], reason: "repeatedNumber", sourceChapterId: 1 },
      { candidateTargetPaths: ["/target/4"], reason: "repeatedNumber", sourceChapterId: 2 },
    ]);
  });

  it("marks a source chapter as ambiguous when the target repeats its number", () => {
    const result = matchNovelMergeChapters(
      [source(1, "4")],
      [target(4, "Part A", "/a"), target(4, "Part B", "/b")],
    );

    expect(result.matched).toEqual([]);
    expect(result.ambiguous).toEqual([
      { candidateTargetPaths: ["/a", "/b"], reason: "repeatedNumber", sourceChapterId: 1 },
    ]);
  });

  it("marks a number match with a very different title as ambiguous", () => {
    const result = matchNovelMergeChapters(
      [source(1, "0", "Prologue"), source(2, "1", "Battle at Dawn")],
      [target(0, "Character Introductions"), target(1, "Ch. 1 - The Dawn Battle")],
    );

    expect(result.matched).toEqual([
      { sourceChapterId: 2, targetChapterPath: "/target/1" },
    ]);
    expect(result.ambiguous).toEqual([
      { candidateTargetPaths: ["/target/0"], reason: "titleMismatch", sourceChapterId: 1 },
    ]);
  });

  it("lists source chapters with no target number as unmatched, in source order", () => {
    const result = matchNovelMergeChapters(
      [source(9, "300"), source(1, "1"), source(5, "301")],
      [target(1)],
    );

    expect(result.unmatchedSourceChapterIds).toEqual([9, 5]);
    expect(result.matched).toEqual([
      { sourceChapterId: 1, targetChapterPath: "/target/1" },
    ]);
  });

  it("treats a repeated source number with no target as unmatched", () => {
    const result = matchNovelMergeChapters([source(1, "7"), source(2, "7")], []);

    expect(result.unmatchedSourceChapterIds).toEqual([1, 2]);
    expect(result.ambiguous).toEqual([]);
  });

  it("puts every source chapter in exactly one group", () => {
    const sources = [
      source(1, "1"),
      source(2, "2"),
      source(3, "2"),
      source(4, null),
      source(5, "9"),
      source(6, "3", "Prologue"),
    ];
    const result = matchNovelMergeChapters(sources, [
      target(1),
      target(2),
      target(3, "Something Else Entirely"),
    ]);
    const grouped = [
      ...result.matched.map((match) => match.sourceChapterId),
      ...result.ambiguous.map((item) => item.sourceChapterId),
      ...result.unmatchedSourceChapterIds,
    ].sort((a, b) => a - b);

    expect(grouped).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("returns empty groups for empty inputs", () => {
    expect(matchNovelMergeChapters([], [target(1)])).toEqual({
      ambiguous: [],
      matched: [],
      unmatchedSourceChapterIds: [],
    });
  });
});

describe("findNovelMergeCopyConflicts", () => {
  const sources = [
    source(1, "1", "One", true),
    source(2, "1", "One again", true),
    source(3, "2", "Two", false),
    source(4, "2", "Two again", true),
    source(5, "3", "Three", true),
  ];

  it("reports targets that several downloaded source chapters map to", () => {
    expect(
      findNovelMergeCopyConflicts(sources, [
        { kind: "map", sourceChapterId: 2, targetChapterPath: "/t/1" },
        { kind: "map", sourceChapterId: 1, targetChapterPath: "/t/1" },
        { kind: "map", sourceChapterId: 5, targetChapterPath: "/t/1" },
      ]),
    ).toEqual([{ sourceChapterIds: [1, 2, 5], targetChapterPath: "/t/1" }]);
  });

  it("ignores chapters that are not downloaded", () => {
    expect(
      findNovelMergeCopyConflicts(sources, [
        { kind: "map", sourceChapterId: 3, targetChapterPath: "/t/2" },
        { kind: "map", sourceChapterId: 4, targetChapterPath: "/t/2" },
      ]),
    ).toEqual([]);
  });

  it("ignores excluded chapters and targets with one download", () => {
    expect(
      findNovelMergeCopyConflicts(sources, [
        { kind: "exclude", sourceChapterId: 1 },
        { kind: "map", sourceChapterId: 2, targetChapterPath: "/t/1" },
        { kind: "map", sourceChapterId: 5, targetChapterPath: "/t/3" },
      ]),
    ).toEqual([]);
  });

  it("ignores decisions for unknown source chapters", () => {
    expect(
      findNovelMergeCopyConflicts(sources, [
        { kind: "map", sourceChapterId: 1, targetChapterPath: "/t/1" },
        { kind: "map", sourceChapterId: 99, targetChapterPath: "/t/1" },
      ]),
    ).toEqual([]);
  });
});
