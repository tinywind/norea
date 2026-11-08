import { describe, expect, it } from "vitest";
import type { ChapterListRow } from "../../db/queries/chapter";
import {
  chapterIdsBetween,
  chapterNameShowsNumber,
  chapterNumberValue,
  formatChapterNumber,
  chapterRowClickAction,
  chapterIdsInNumberRange,
  filterChapterList,
  findChapterForJump,
  findContinueReadingChapter,
  NO_CHAPTER_LIST_FILTERS,
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
      { ...chapter(1, 1), name: "One", chapterNumber: "10" },
      { ...chapter(2, 2), name: "Two", chapterNumber: "10.5" },
      { ...chapter(3, 3), name: "Three", chapterNumber: null },
      { ...chapter(4, 4), name: "Epilogue", chapterNumber: "Epilogue" },
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

describe("filterChapterList", () => {
  const rows = [
    chapter(1, 1, { unread: false }),
    { ...chapter(2, 2), isDownloaded: true },
    { ...chapter(3, 3), contentBytes: 40, mediaRepairNeeded: true },
    chapter(4, 4),
    { ...chapter(5, 5, { unread: false }), isDownloaded: true },
    chapter(6, 6),
  ];
  const statuses = new Map([
    [4, { kind: "queued" as const }],
    [5, { kind: "running" as const }],
    [6, { kind: "failed" as const, error: "offline" }],
  ]);
  const ids = (filters: Partial<typeof NO_CHAPTER_LIST_FILTERS>) =>
    filterChapterList(rows, { ...NO_CHAPTER_LIST_FILTERS, ...filters }, statuses).map((row) => row.id);

  it("returns the same rows when no filter is on", () => {
    expect(filterChapterList(rows, NO_CHAPTER_LIST_FILTERS, statuses)).toBe(rows);
  });

  it("keeps unread, stored-body and queued or running chapters, and combines the filters", () => {
    expect(ids({ unread: true })).toEqual([2, 3, 4, 6]);
    expect(ids({ downloaded: true })).toEqual([2, 3, 5]);
    expect(ids({ queued: true })).toEqual([4, 5]);
    expect(ids({ unread: true, downloaded: true })).toEqual([2, 3]);
    expect(ids({ downloaded: true, queued: true })).toEqual([5]);
    expect(ids({ unread: true, downloaded: true, queued: true })).toEqual([]);
  });

  it("keeps the given display order", () => {
    expect(filterChapterList([...rows].reverse(), { ...NO_CHAPTER_LIST_FILTERS, unread: true }, statuses)
      .map((row) => row.id)).toEqual([6, 4, 3, 2]);
  });
});

describe("chapterRowClickAction", () => {
  it("gives a tap one meaning per state and lets Shift-click select a range", () => {
    expect(chapterRowClickAction(false, false)).toBe("open");
    expect(chapterRowClickAction(true, false)).toBe("toggle");
    expect(chapterRowClickAction(false, true)).toBe("select-range");
    expect(chapterRowClickAction(true, true)).toBe("select-range");
  });
});

describe("chapterNameShowsNumber", () => {
  const named = (name: string, chapterNumber: string | null, position = 7) => ({ chapterNumber, name, position });

  it("finds the number as a whole number in the name", () => {
    expect(chapterNameShowsNumber(named("주술사는 초월을 원한다 1895화", "1895"))).toBe(true);
    expect(chapterNameShowsNumber(named("Chapter 0012 - Return", "12"))).toBe(true);
    expect(chapterNameShowsNumber(named("Episode 7", null))).toBe(true);
    expect(chapterNameShowsNumber(named("Side story 1.5", "1.5"))).toBe(true);
  });

  it("does not match a fallback number inside an unrelated numeric title", () => {
    expect(chapterNameShowsNumber(named("Room 18950", "1895"))).toBe(false);
    expect(chapterNameShowsNumber(named("Room 21", "1"))).toBe(false);
    expect(chapterNameShowsNumber(named("Room 1.5", "5"))).toBe(false);
    expect(chapterNameShowsNumber(named("Room 1.5", "1"))).toBe(false);
    expect(chapterNameShowsNumber(named("Prologue", "1"))).toBe(false);
  });
});

describe("reader-facing episode numbers", () => {
  it.each([
    ["1화", "346378", "1"],
    ["346화", "5677728", "346"],
    ["278화 278", "346655", "278"],
    ["Chapter 12.50", "9000", "12.5"],
    ["시즌 2 7화", "7777", "7"],
  ])("uses the explicit title %s instead of provider ID %s", (name, chapterNumber, expected) => {
    const row = Object.freeze({ ...chapter(1, 1), name, chapterNumber });
    expect(formatChapterNumber(row)).toBe(expected);
    expect(chapterNumberValue(row)).toBe(Number(expected));
    expect(chapterNameShowsNumber(row)).toBe(true);
    expect(row.chapterNumber).toBe(chapterNumber);
  });

  it("accepts a chapterName projection and retains existing fallbacks", () => {
    expect(formatChapterNumber({ chapterName: "1화", chapterNumber: "346378", position: 1 })).toBe("1");
    expect(formatChapterNumber({ chapterNumber: "346378", position: 1 })).toBe("346378");
    expect(formatChapterNumber({ chapterNumber: null, position: 7 })).toBe("7");
    expect(formatChapterNumber({ name: "Prologue", chapterNumber: "0", position: 1 })).toBe("0");
    expect(formatChapterNumber({ name: "1화 - 2화", chapterNumber: "999", position: 1 })).toBe("999");
    expect(formatChapterNumber({ name: "시즌 1 시즌 2 3화", chapterNumber: "999", position: 1 })).toBe("999");
    expect(chapterNumberValue({ name: "Epilogue", chapterNumber: "Epilogue", position: 3 })).toBeNull();
  });

  it("uses displayed episodes for jumps and number ranges without changing storage identity", () => {
    const rows = [
      { ...chapter(1, 1), name: "1화", chapterNumber: "346378" },
      { ...chapter(346, 346), name: "346화", chapterNumber: "5677728" },
    ];
    expect(findChapterForJump(rows, "1")?.id).toBe(1);
    expect(findChapterForJump(rows, "346")?.id).toBe(346);
    expect(findChapterForJump(rows, "346378")).toBeUndefined();
    expect(chapterIdsInNumberRange(rows, 1, 1)).toEqual([1]);
    expect(chapterIdsInNumberRange(rows, 346, 346)).toEqual([346]);
    expect(rows.map(row => row.chapterNumber)).toEqual(["346378", "5677728"]);
  });
});
