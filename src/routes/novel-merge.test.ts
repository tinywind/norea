import { describe, expect, it, vi } from "vitest";

vi.mock("../components/PdfReaderContent", () => ({
  PdfReaderContent: vi.fn(),
}));

import {
  validateNovelMergeDecisions,
  type NovelMergeChapterDecision,
  type NovelMergeDecisionSourceChapter,
} from "./novel-merge";

const sourceChapters: NovelMergeDecisionSourceChapter[] = [
  { id: 11, isDownloaded: false },
  { id: 12, isDownloaded: true },
  { id: 13, isDownloaded: true },
];
const targetChapterPaths = ["/target/1", "/target/2"];

function validate(
  decisions: NovelMergeChapterDecision[],
  artifactSourceChapterIdByTargetPath: Record<string, number> = {},
) {
  return validateNovelMergeDecisions({
    artifactSourceChapterIdByTargetPath,
    decisions,
    sourceChapters,
    targetChapterPaths,
  });
}

describe("validateNovelMergeDecisions", () => {
  it("keeps every source chapter undecided until the user explicitly decides", () => {
    const result = validate([]);

    expect(result.canConfirm).toBe(false);
    expect(result.undecidedSourceChapterIds).toEqual([11, 12, 13]);
  });

  it("accepts exclusions as explicit decisions", () => {
    const result = validate([
      { kind: "exclude", sourceChapterId: 11 },
      { kind: "map", sourceChapterId: 12, targetChapterPath: "/target/1" },
      { kind: "exclude", sourceChapterId: 13 },
    ]);

    expect(result.canConfirm).toBe(true);
    expect(result.undecidedSourceChapterIds).toEqual([]);
  });

  it("allows multiple source chapters to map to one target chapter", () => {
    const decisions: NovelMergeChapterDecision[] = [
      { kind: "exclude", sourceChapterId: 11 },
      { kind: "map", sourceChapterId: 12, targetChapterPath: "/target/1" },
      { kind: "map", sourceChapterId: 13, targetChapterPath: "/target/1" },
    ];

    expect(validate(decisions).artifactChoiceRequiredTargetPaths).toEqual([
      "/target/1",
    ]);
    expect(validate(decisions, { "/target/1": 13 }).canConfirm).toBe(true);
  });

  it("does not require an artifact choice when only one mapped source is downloaded", () => {
    const result = validate([
      { kind: "map", sourceChapterId: 11, targetChapterPath: "/target/1" },
      { kind: "map", sourceChapterId: 12, targetChapterPath: "/target/1" },
      { kind: "exclude", sourceChapterId: 13 },
    ]);

    expect(result.canConfirm).toBe(true);
    expect(result.artifactChoiceRequiredTargetPaths).toEqual([]);
  });

  it("rejects an artifact source that is not a downloaded chapter mapped to that target", () => {
    const result = validate(
      [
        { kind: "exclude", sourceChapterId: 11 },
        { kind: "map", sourceChapterId: 12, targetChapterPath: "/target/1" },
        { kind: "map", sourceChapterId: 13, targetChapterPath: "/target/1" },
      ],
      { "/target/1": 11 },
    );

    expect(result.canConfirm).toBe(false);
    expect(result.invalidArtifactChoiceTargetPaths).toEqual(["/target/1"]);
  });

  it("rejects missing source chapters, duplicate decisions, and unknown targets", () => {
    const result = validate([
      { kind: "exclude", sourceChapterId: 11 },
      { kind: "map", sourceChapterId: 11, targetChapterPath: "/target/1" },
      { kind: "map", sourceChapterId: 12, targetChapterPath: "/missing" },
      { kind: "exclude", sourceChapterId: 99 },
    ]);

    expect(result.canConfirm).toBe(false);
    expect(result.duplicateSourceChapterIds).toEqual([11]);
    expect(result.unknownSourceChapterIds).toEqual([99]);
    expect(result.unknownTargetPathSourceChapterIds).toEqual([12]);
    expect(result.undecidedSourceChapterIds).toEqual([13]);
  });
});
