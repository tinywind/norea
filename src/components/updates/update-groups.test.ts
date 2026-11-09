import { describe, expect, it } from "vitest";
import type { LibraryUpdateEntry } from "../../db/queries/chapter";
import { daysBefore, groupUpdatesByDate } from "./update-groups";

const day = (year: number, month: number, date: number, hour = 12) =>
  new Date(year, month, date, hour).getTime() / 1000;

function entry(
  chapterId: number,
  novelId: number,
  sortAt: number,
  position = chapterId,
): LibraryUpdateEntry {
  return {
    chapterId,
    chapterName: `Chapter ${chapterId}`,
    chapterPath: `/c/${chapterId}`,
    contentType: "html",
    sortAt,
    isDownloaded: false,
    novelCover: null,
    novelId,
    novelIsLocal: false,
    novelName: `Novel ${novelId}`,
    novelPath: `/n/${novelId}`,
    pluginId: "source",
    novelSourceNovelId: "book-" + novelId,
    position,
  };
}

describe("groupUpdatesByDate", () => {
  it("splits rows by local day in incoming order", () => {
    const sections = groupUpdatesByDate([
      entry(3, 1, day(2026, 10, 3, 18)),
      entry(2, 2, day(2026, 10, 3, 8)),
      entry(1, 1, day(2026, 10, 2)),
    ]);
    expect(sections.map((section) => section.dayStart)).toEqual([
      new Date(2026, 10, 3).getTime(),
      new Date(2026, 10, 2).getTime(),
    ]);
    expect(sections[0]!.items.map((item) => item.kind)).toEqual(["chapter", "chapter"]);
  });

  it("keeps three chapters of one novel as individual rows", () => {
    const found = day(2026, 10, 3);
    const [section] = groupUpdatesByDate([entry(3, 1, found), entry(2, 1, found), entry(1, 1, found)]);
    expect(section!.items).toHaveLength(3);
    expect(section!.items.every((item) => item.kind === "chapter")).toBe(true);
  });

  it("collapses more than three chapters of one novel into a run at its first row", () => {
    const found = day(2026, 10, 3);
    const [section] = groupUpdatesByDate([
      entry(10, 1, found, 13),
      entry(20, 2, found),
      entry(11, 1, found, 12),
      entry(12, 1, found, 11),
      entry(13, 1, found, 10),
    ]);
    expect(section!.items.map((item) => item.kind)).toEqual(["run", "chapter"]);
    const run = section!.items[0]!;
    if (run.kind !== "run") throw new Error("expected a run");
    expect(run.entries.map((item) => item.chapterId)).toEqual([10, 11, 12, 13]);
    expect(run.earliest.chapterId).toBe(13);
  });

  it("merges a day that reappears later in the list into one section", () => {
    const sections = groupUpdatesByDate([
      entry(1, 1, day(2026, 10, 3)),
      entry(2, 1, day(2026, 10, 2)),
      entry(3, 2, day(2026, 10, 3)),
    ]);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.items).toHaveLength(2);
  });
});

it("counts whole local days back from now", () => {
  const now = new Date(2026, 10, 3, 9);
  expect(daysBefore(new Date(2026, 10, 3).getTime(), now)).toBe(0);
  expect(daysBefore(new Date(2026, 10, 2).getTime(), now)).toBe(1);
  expect(daysBefore(new Date(2026, 9, 27).getTime(), now)).toBe(7);
});
