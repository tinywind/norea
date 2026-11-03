import { describe, expect, it } from "vitest";
import type { ChapterListRow } from "../../db/queries/chapter";
import {
  chapterIdsBetween,
  chapterIdsInNumberRange,
  findChapterForJump,
  findContinueReadingChapter,
} from "./novel-detail-model";

function chapter(
  id: number,
  position: number,
  state: { progress?: number; unread?: boolean } = {},
): ChapterListRow {
  const progress = state.progress ?? 0;
  return {
    id, novelId: 1, path: `/chapter/${id}`, name: `Chapter ${id}`,
    chapterNumber: String(position), position, page: "1", bookmark: false,
    unread: state.unread ?? progress < 100, progress, isDownloaded: false,
    sourceContentType: "html", contentType: "html", contentBytes: 0,
    mediaBytes: 0, mediaRepairNeeded: false, releaseTime: null, readAt: null,
    createdAt: null, foundAt: 0, updatedAt: 0,
  };
}

function targetId(
  chapters: ChapterListRow[],
  lastReadChapterId: number | undefined,
): number | undefined {
  return findContinueReadingChapter(chapters, lastReadChapterId)?.id;
}

describe("findContinueReadingChapter", () => {
  it("returns nothing without chapters", () => {
    expect(findContinueReadingChapter([], undefined)).toBeNull();
    expect(findContinueReadingChapter([], 4)).toBeNull();
  });

  it("resumes the last-read chapter while it is unfinished", () => {
    const chapters = [chapter(1, 1, { progress: 100 }), chapter(2, 2, { progress: 40 }), chapter(3, 3)];
    expect(targetId(chapters, 2)).toBe(2);
  });

  it("opens the next chapter in reading order when the last-read chapter is finished", () => {
    const chapters = [chapter(1, 1, { progress: 100 }), chapter(2, 2, { progress: 100 }), chapter(3, 3)];
    expect(targetId(chapters, 2)).toBe(3);
  });

  it("follows reading order when chapters are listed newest first", () => {
    const chapters = [chapter(3, 3), chapter(2, 2), chapter(1, 1, { progress: 100 })];
    expect(targetId(chapters, 1)).toBe(2);
  });

  it("follows chapter positions rather than ids", () => {
    const chapters = [chapter(10, 1, { progress: 100 }), chapter(5, 2), chapter(7, 3)];
    expect(targetId(chapters, 10)).toBe(5);
  });

  it("keeps the finished last chapter when no next chapter exists", () => {
    const chapters = [chapter(1, 1, { progress: 100 }), chapter(2, 2, { progress: 100 })];
    expect(targetId(chapters, 2)).toBe(2);
  });

  it("opens the first unread chapter in reading order without history", () => {
    const chapters = [chapter(4, 4), chapter(3, 3), chapter(2, 2), chapter(1, 1, { progress: 100 })];
    expect(targetId(chapters, undefined)).toBe(2);
  });

  it("treats a last-read chapter missing from the list as no history", () => {
    const chapters = [chapter(1, 1, { progress: 100 }), chapter(2, 2)];
    expect(targetId(chapters, 99)).toBe(2);
  });

  it("opens the first chapter without history when every chapter is read", () => {
    const chapters = [chapter(2, 2, { progress: 100 }), chapter(1, 1, { progress: 100 })];
    expect(targetId(chapters, undefined)).toBe(1);
  });
});

describe("chapter ranges", () => {
  const chapters = [chapter(1, 1), chapter(2, 2), chapter(3, 3), chapter(4, 4), chapter(5, 5)];

  it("selects every row between the anchor and the target in list order, both included", () => {
    expect(chapterIdsBetween(chapters, 2, 4)).toEqual([2, 3, 4]);
    expect(chapterIdsBetween(chapters, 4, 2)).toEqual([2, 3, 4]);
    expect(chapterIdsBetween([...chapters].reverse(), 2, 4)).toEqual([4, 3, 2]);
    expect(chapterIdsBetween(chapters, 3, 3)).toEqual([3]);
  });

  it("selects nothing when an endpoint is not listed", () => {
    expect(chapterIdsBetween(chapters, 2, 9)).toEqual([]);
  });

  it("selects chapters by their shown number in either direction", () => {
    expect(chapterIdsInNumberRange(chapters, 2, 4)).toEqual([2, 3, 4]);
    expect(chapterIdsInNumberRange(chapters, 4, 2)).toEqual([2, 3, 4]);
    expect(chapterIdsInNumberRange(chapters, 6, 9)).toEqual([]);
  });

  it("uses the source number, falls back to the position and skips text numbers", () => {
    const rows = [
      { ...chapter(1, 1), chapterNumber: "10" },
      { ...chapter(2, 2), chapterNumber: "10.5" },
      { ...chapter(3, 3), chapterNumber: null },
      { ...chapter(4, 4), chapterNumber: "Epilogue" },
    ];
    expect(chapterIdsInNumberRange(rows, 3, 11)).toEqual([1, 2, 3]);
  });
});

describe("findChapterForJump", () => {
  const chapters = [
    { ...chapter(1, 1), name: "Prologue" },
    { ...chapter(2, 2), name: "Storm 12" },
    { ...chapter(12, 12), name: "Aftermath" },
  ];

  it("prefers an exact chapter number", () => {
    expect(findChapterForJump(chapters, " 12 ")?.id).toBe(12);
  });

  it("falls back to the first title containing the text, ignoring case", () => {
    expect(findChapterForJump(chapters, "storm")?.id).toBe(2);
    expect(findChapterForJump(chapters, "99")).toBeUndefined();
    expect(findChapterForJump(chapters, "  ")).toBeUndefined();
  });
});
