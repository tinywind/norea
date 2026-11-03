import { describe, expect, it } from "vitest";
import type { NovelMergeChapterMatching } from "../../lib/novel-merge-matching";
import {
  buildMergeMapRows,
  mergeMapSourceOrder,
  nextUndecidedSourceChapterId,
  summarizeNovelMergeDecisions,
  type NovelMergeDecisionMap,
} from "./merge-map-rows";

const matching: NovelMergeChapterMatching = {
  ambiguous: [
    { candidateTargetPaths: ["/t/4a", "/t/4b"], reason: "repeatedNumber", sourceChapterId: 4 },
    { candidateTargetPaths: [], reason: "missingNumber", sourceChapterId: 5 },
  ],
  matched: [
    { sourceChapterId: 1, targetChapterPath: "/t/1" },
    { sourceChapterId: 2, targetChapterPath: "/t/2" },
  ],
  unmatchedSourceChapterIds: [9],
};

const autoDecisions: NovelMergeDecisionMap = {
  1: { kind: "map", sourceChapterId: 1, targetChapterPath: "/t/1" },
  2: { kind: "map", sourceChapterId: 2, targetChapterPath: "/t/2" },
};

function keys(options: Partial<Parameters<typeof buildMergeMapRows>[0]> = {}): string[] {
  return buildMergeMapRows({
    conflicts: [],
    copyChoices: {},
    decisions: autoDecisions,
    matchedExpanded: false,
    matching,
    undecidedOnly: false,
    ...options,
  }).map((row) => row.key);
}

describe("buildMergeMapRows", () => {
  it("orders unmatched, ambiguous, then a collapsed matched section", () => {
    expect(keys()).toEqual([
      "header:unmatched",
      "chapter:9",
      "header:ambiguous",
      "chapter:4",
      "chapter:5",
      "header:matched",
    ]);
  });

  it("lists matched rows when the section is expanded", () => {
    expect(keys({ matchedExpanded: true }).slice(-3)).toEqual([
      "header:matched",
      "chapter:1",
      "chapter:2",
    ]);
  });

  it("puts copy conflicts first", () => {
    const rows = buildMergeMapRows({
      conflicts: [{ sourceChapterIds: [1, 2], targetChapterPath: "/t/1" }],
      copyChoices: {},
      decisions: autoDecisions,
      matchedExpanded: false,
      matching,
      undecidedOnly: false,
    });

    expect(rows.slice(0, 2)).toEqual([
      { count: 1, key: "header:conflicts", kind: "header", section: "conflicts" },
      {
        conflict: { sourceChapterIds: [1, 2], targetChapterPath: "/t/1" },
        key: "conflict:/t/1",
        kind: "conflict",
      },
    ]);
  });

  it("carries the ambiguity reason on ambiguous rows", () => {
    const rows = buildMergeMapRows({
      conflicts: [],
      copyChoices: {},
      decisions: autoDecisions,
      matchedExpanded: false,
      matching,
      undecidedOnly: false,
    });

    expect(rows.find((row) => row.key === "chapter:4")).toMatchObject({
      reason: "repeatedNumber",
      section: "ambiguous",
    });
    expect(rows.find((row) => row.key === "chapter:9")).toMatchObject({
      reason: undefined,
      section: "unmatched",
    });
  });

  it("hides decided rows, resolved conflicts and empty sections when undecided only", () => {
    const decisions: NovelMergeDecisionMap = {
      ...autoDecisions,
      4: { kind: "exclude", sourceChapterId: 4 },
      9: { kind: "exclude", sourceChapterId: 9 },
    };

    expect(
      keys({
        conflicts: [
          { sourceChapterIds: [1, 2], targetChapterPath: "/t/1" },
          { sourceChapterIds: [6, 7], targetChapterPath: "/t/6" },
        ],
        copyChoices: { "/t/1": 2, "/t/6": 99 },
        decisions,
        undecidedOnly: true,
      }),
    ).toEqual([
      "header:conflicts",
      "conflict:/t/6",
      "header:ambiguous",
      "chapter:5",
    ]);
  });

  it("shows a cleared matched row even while the section is collapsed when undecided only", () => {
    expect(
      keys({
        decisions: { 1: autoDecisions[1] },
        undecidedOnly: true,
      }),
    ).toEqual([
      "header:unmatched",
      "chapter:9",
      "header:ambiguous",
      "chapter:4",
      "chapter:5",
      "header:matched",
      "chapter:2",
    ]);
  });

  it("keeps section counts at the section total while rows are filtered", () => {
    const rows = buildMergeMapRows({
      conflicts: [],
      copyChoices: {},
      decisions: { ...autoDecisions, 4: { kind: "exclude", sourceChapterId: 4 } },
      matchedExpanded: false,
      matching,
      undecidedOnly: true,
    });

    expect(rows.find((row) => row.key === "header:ambiguous")).toMatchObject({ count: 2 });
  });
});

describe("nextUndecidedSourceChapterId", () => {
  const order = mergeMapSourceOrder(matching);

  it("lists sources in section order", () => {
    expect(order).toEqual([9, 4, 5, 1, 2]);
  });

  it("finds the next undecided row after the current one", () => {
    expect(nextUndecidedSourceChapterId(order, autoDecisions, 9)).toBe(4);
    expect(nextUndecidedSourceChapterId(order, autoDecisions, 4)).toBe(5);
  });

  it("wraps around to the start", () => {
    expect(nextUndecidedSourceChapterId(order, autoDecisions, 5)).toBe(9);
    expect(nextUndecidedSourceChapterId(order, autoDecisions, 2)).toBe(9);
  });

  it("starts from the first row without a current row", () => {
    expect(nextUndecidedSourceChapterId(order, autoDecisions, null)).toBe(9);
  });

  it("returns the current row when it is the only undecided one", () => {
    expect(
      nextUndecidedSourceChapterId(
        order,
        {
          ...autoDecisions,
          4: { kind: "exclude", sourceChapterId: 4 },
          9: { kind: "exclude", sourceChapterId: 9 },
        },
        5,
      ),
    ).toBe(5);
  });

  it("returns null when everything is decided", () => {
    const decided = Object.fromEntries(
      order.map((id) => [id, { kind: "exclude", sourceChapterId: id } as const]),
    );
    expect(nextUndecidedSourceChapterId(order, decided, 4)).toBeNull();
  });
});

describe("summarizeNovelMergeDecisions", () => {
  const chapters = [
    { id: 1, isDownloaded: true, progress: 0, unread: false },
    { id: 2, isDownloaded: true, progress: 40, unread: true },
    { id: 3, isDownloaded: true, progress: 0, unread: true },
    { id: 4, isDownloaded: false, progress: 0, unread: false },
    { id: 5, isDownloaded: true, progress: 0, unread: true },
  ];

  it("counts mapped and excluded chapters, moved and removed downloads, and progress", () => {
    const summary = summarizeNovelMergeDecisions(
      chapters,
      {
        1: { kind: "map", sourceChapterId: 1, targetChapterPath: "/t/1" },
        2: { kind: "map", sourceChapterId: 2, targetChapterPath: "/t/1" },
        3: { kind: "map", sourceChapterId: 3, targetChapterPath: "/t/3" },
        4: { kind: "exclude", sourceChapterId: 4 },
        5: { kind: "exclude", sourceChapterId: 5 },
      },
      [{ sourceChapterIds: [1, 2], targetChapterPath: "/t/1" }],
    );

    expect(summary).toEqual({
      copyChoices: 1,
      downloadsMoved: 2,
      downloadsRemoved: 2,
      excluded: 2,
      mapped: 3,
      readDropped: 1,
      readMoved: 2,
    });
  });

  it("ignores undecided chapters", () => {
    expect(summarizeNovelMergeDecisions(chapters, {}, [])).toEqual({
      copyChoices: 0,
      downloadsMoved: 0,
      downloadsRemoved: 0,
      excluded: 0,
      mapped: 0,
      readDropped: 0,
      readMoved: 0,
    });
  });
});
