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

  it("matches displayed episodes to independent provider IDs", () => {
    const sources = Array.from({ length: 345 }, (_, index) => source(index + 1, String(index + 1), String(index + 1) + "화"));
    const targets = Array.from({ length: 345 }, (_, index) =>
      target(5_700_000 + index, "전능의 뇌를 얻었다 제" + (index + 1) + "화", "/bookkor/" + (5_700_000 + index)),
    ).reverse();

    const result = matchNovelMergeChapters(sources, targets);

    expect(result.matched).toHaveLength(345);
    expect(result.matched[0]).toEqual({ sourceChapterId: 1, targetChapterPath: "/bookkor/5700000" });
    expect(result.matched.at(-1)).toEqual({ sourceChapterId: 345, targetChapterPath: "/bookkor/5700344" });
    expect(result.ambiguous).toEqual([]);
    expect(result.unmatchedSourceChapterIds).toEqual([]);
  });

  it("recognizes a bare numeric title repeated after the same episode label", () => {
    const result = matchNovelMergeChapters(
      [source(1, "278", "278"), source(2, "279", "279")],
      [target(346655, "278화 278", "/278"), target(346656, "279화 279", "/279")],
    );
    expect(result.matched).toEqual([
      { sourceChapterId: 1, targetChapterPath: "/278" },
      { sourceChapterId: 2, targetChapterPath: "/279" },
    ]);
    expect(result.ambiguous).toEqual([]);
    expect(matchNovelMergeChapters(
      [source(1, "278", "278")],
      [target(278, "278화 279")],
    ).matched).toEqual([]);
  });

  it("uses displayed episodes through gaps and shifted stored numbers", () => {
    const result = matchNovelMergeChapters(
      [
        source(1, "44", "45화"),
        source(2, "45", "46화"),
        source(3, "46", "47화"),
        source(4, "48", "48화"),
        source(5, "66", "제66화"),
      ],
      [
        target(44, "44화", "/episode/44"),
        target(45, "45화", "/episode/45"),
        target(46, "46화", "/episode/46"),
        target(47, "47화", "/episode/47"),
        target(48, "48화", "/episode/48"),
        target(65, "66화", "/episode/66"),
      ],
    );

    expect(result.matched.map(item => item.targetChapterPath)).toEqual([
      "/episode/45", "/episode/46", "/episode/47", "/episode/48", "/episode/66",
    ]);
    expect(result.ambiguous).toEqual([]);
  });

  it("trusts unique explicit episodes when providers omit or replace subtitles", () => {
    const result = matchNovelMergeChapters(
      [source(1, "23", "24화 - The Unexpected Return"), source(2, "42", "43화 - Five minutes or 5 hours")],
      [target(23, "A Work Title 24화"), target(42, "제43화 - A Work Title")],
    );
    expect(result.matched).toEqual([
      { sourceChapterId: 1, targetChapterPath: "/target/23" },
      { sourceChapterId: 2, targetChapterPath: "/target/42" },
    ]);
    expect(result.ambiguous).toEqual([]);
  });

  it("reads a leading episode label when the provider concatenates its subtitle", () => {
    const result = matchNovelMergeChapters(
      [source(1, "52", "52화")],
      [target(9000, "52화자막없이이어지는부제")],
    );
    expect(result.matched).toEqual([{ sourceChapterId: 1, targetChapterPath: "/target/9000" }]);
  });

  it("never lets equal stored values override different displayed episodes", () => {
    const result = matchNovelMergeChapters(
      [source(1, "45", "46화 - The Return")],
      [target(45, "45화 - The Return")],
    );

    expect(result.matched).toEqual([]);
    expect(result.ambiguous).toEqual([
      { sourceChapterId: 1, reason: "titleMismatch", candidateTargetPaths: ["/target/45"] },
    ]);
  });

  it("distinguishes seasons, parts and side stories with repeated episode labels", () => {
    const labels = ["시즌 1 1화", "시즌 2 1화", "2부 1화", "외전 1화", "1화"];
    const result = matchNovelMergeChapters(
      labels.map((name, index) => source(index + 1, String(index + 1), name)),
      labels.map((name, index) => target(index + 700, name, "/scoped/" + index)).reverse(),
    );

    expect(result.matched.map(item => item.targetChapterPath)).toEqual([
      "/scoped/0", "/scoped/1", "/scoped/2", "/scoped/3", "/scoped/4",
    ]);
    expect(result.ambiguous).toEqual([]);
  });

  it.each([
    ["시즌 1 1화", "시즌 2 1화"],
    ["1부 1화", "2부 1화"],
    ["시즌 2 1화", "1화"],
    ["외전 1화", "1화"],
    ["특별화 1", "1화"],
    ["Volume 2 Chapter 1", "Volume 3 Chapter 1"],
    ["Chapter 1 - The Return (1)", "Chapter 1 - The Return (2)"],
    ["Room 12", "Room 1-2"],
  ])("leaves conflicting title identity manual: %s / %s", (left, right) => {
    const result = matchNovelMergeChapters([source(1, "1", left)], [target(1, right)]);
    expect(result.matched).toEqual([]);
    expect(result.ambiguous).toEqual([
      { sourceChapterId: 1, reason: "titleMismatch", candidateTargetPaths: ["/target/1"] },
    ]);
  });

  it("matches unique exact titles without erasing meaningful numbers", () => {
    const result = matchNovelMergeChapters(
      [source(1, null, "입성 (1)"), source(2, "2", "입성 (2)"), source(3, "3", "Epilogue")],
      [target(900, "입성 (2)", "/two"), target(901, "입성 (1)", "/one"), target(902, "Epilogue!", "/end")],
    );
    expect(result.matched).toEqual([
      { sourceChapterId: 1, targetChapterPath: "/one" },
      { sourceChapterId: 2, targetChapterPath: "/two" },
      { sourceChapterId: 3, targetChapterPath: "/end" },
    ]);
  });

  it("does not select between repeated exact titles by provider ID", () => {
    const result = matchNovelMergeChapters(
      [source(1, "1", "An Interlude"), source(2, "2", "An Interlude")],
      [target(1, "An Interlude"), target(2, "An Interlude")],
    );
    expect(result.matched).toEqual([]);
    expect(result.ambiguous).toHaveLength(2);
  });

  it("leaves titles containing several episode labels for manual review", () => {
    const result = matchNovelMergeChapters(
      [source(1, "1", "1화 - 2화")],
      [target(1, "1화 - 2화")],
    );
    expect(result.matched).toEqual([]);
    expect(result.ambiguous[0]?.reason).toBe("titleMismatch");
  });

  it("does not assign a target to two competing matching rules", () => {
    const result = matchNovelMergeChapters(
      [source(1, "1", "Arrival"), source(2, "900", "1화")],
      [target(1, "Chapter 1 Arrival")],
    );
    expect(result.matched).toEqual([]);
    expect(result.ambiguous).toEqual([
      { sourceChapterId: 1, reason: "repeatedNumber", candidateTargetPaths: ["/target/1"] },
      { sourceChapterId: 2, reason: "repeatedNumber", candidateTargetPaths: ["/target/1"] },
    ]);
  });

  it("does not infer an episode from an empty title and stored number alone", () => {
    const result = matchNovelMergeChapters([source(1, "1", "")], [target(1, "")]);
    expect(result.matched).toEqual([]);
    expect(result.ambiguous[0]?.reason).toBe("titleMismatch");
  });

  it("returns empty groups for empty inputs", () => {
    expect(matchNovelMergeChapters([], [target(1)])).toEqual({
      ambiguous: [],
      matched: [],
      unmatchedSourceChapterIds: [],
    });
  });

  it("does not auto-match chapters merely because the final chapter number matches when the episode identity differs", () => {
    const sources = [
      ...Array.from({ length: 9 }, (_, i) => source(i + 1, String(i + 1), `${i + 1}화`)),
      source(10, "10", "외전 1화"),
    ];
    const targets = Array.from({ length: 10 }, (_, i) => target(i + 1, `${i + 1}화`, `/target/${i + 1}`));
    const result = matchNovelMergeChapters(sources, targets);
    expect(result.matched).toHaveLength(9);
    expect(result.matched.some(item => item.sourceChapterId === 10)).toBe(false);
    expect(result.ambiguous).toEqual([
      { sourceChapterId: 10, reason: "titleMismatch", candidateTargetPaths: ["/target/10"] },
    ]);
  });

  it("keeps standalone Korean prologue unmerged while shifting subsequent episodes accurately", () => {
    const sources = [
      source(1, "1", "[서장]"),
      ...Array.from({ length: 10 }, (_, i) => source(i + 2, String(i + 2), `${i + 1}화`)),
    ];
    const targets = Array.from({ length: 10 }, (_, i) => target(i + 1, `${i + 1}화`, `/target/${i + 1}`));
    const result = matchNovelMergeChapters(sources, targets);
    expect(result.ambiguous).toEqual([
      { sourceChapterId: 1, reason: "titleMismatch", candidateTargetPaths: ["/target/1"] },
    ]);
    expect(result.matched).toEqual(
      Array.from({ length: 10 }, (_, i) => ({ sourceChapterId: i + 2, targetChapterPath: `/target/${i + 1}` })),
    );

    // Ensure a numbered episode with a bracketed prologue subtitle still matches episode 1.
    const numberedSubtitle = matchNovelMergeChapters(
      [source(1, "1", "각성자 김극 - [서장]")],
      [target(1, "1화 각성자 김극 - [서장]", "/bookkor/6951-ep-1")],
    );
    expect(numberedSubtitle.matched).toEqual([{ sourceChapterId: 1, targetChapterPath: "/bookkor/6951-ep-1" }]);
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
