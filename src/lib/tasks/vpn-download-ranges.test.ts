import { describe, expect, it } from "vitest";
import { planVpnDownloadRanges } from "./vpn-download-ranges";

const catalog = (count: number) => Array.from({ length: count }, (_, index) => ({ id: index + 1 }));

describe("VPN download range planning", () => {
  it("assigns fixed contiguous thirds rather than alternating chapters", () => {
    const ranges = planVpnDownloadRanges(catalog(300), catalog(300).map(({ id }) => id), ["a", "b", "c"]);
    expect(ranges.map(({ startChapterId, endChapterId, profileId }) => [startChapterId, endChapterId, profileId]))
      .toEqual([[1, 100, "a"], [101, 200, "b"], [201, 300, "c"]]);
    expect(ranges[0]?.chapterIds).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
  });

  it("keeps holes in their original intervals without rebalancing remaining chapters", () => {
    const ranges = planVpnDownloadRanges(catalog(6), [1, 2, 4, 6], ["a", "b", "c"]);
    expect(ranges.map(({ startChapterId, endChapterId, selectedChapterIds }) => [startChapterId, endChapterId, selectedChapterIds]))
      .toEqual([[1, 2, [1, 2]], [3, 4, [4]], [5, 6, [6]]]);
  });

  it("uses catalog identities and order instead of display labels or numeric ID order", () => {
    const chapters = [{ id: 90 }, { id: 2 }, { id: 35 }, { id: 1 }, { id: 70 }];
    const ranges = planVpnDownloadRanges(chapters, [70, 1, 35, 2, 90], ["a", "b"]);
    expect(ranges.map(({ chapterIds }) => chapterIds)).toEqual([[90, 2, 35], [1, 70]]);
  });

  it("bounds automatic workers by the number of chapters in the selected span", () => {
    expect(planVpnDownloadRanges(catalog(4), [2], ["a", "b", "c"]))
      .toEqual([{ profileId: "a", startChapterId: 2, endChapterId: 2, chapterIds: [2], selectedChapterIds: [2] }]);
  });

  it("accepts editable contiguous ranges and freezes a copy of membership", () => {
    const chapters = catalog(6);
    const selected = [2, 3, 4, 5];
    const ranges = planVpnDownloadRanges(chapters, selected, ["a", "b"], [
      { profileId: "b", startChapterId: 2, endChapterId: 4 },
      { profileId: "a", startChapterId: 5, endChapterId: 5 },
    ]);
    chapters.reverse();
    selected.reverse();
    expect(ranges.map(({ chapterIds }) => chapterIds)).toEqual([[2, 3, 4], [5]]);
  });

  it.each([
    [[{ profileId: "a", startChapterId: 1, endChapterId: 3 }, { profileId: "b", startChapterId: 3, endChapterId: 5 }], /overlap/i],
    [[{ profileId: "a", startChapterId: 1, endChapterId: 2 }, { profileId: "b", startChapterId: 4, endChapterId: 5 }], /unassigned/i],
    [[{ profileId: "a", startChapterId: 3, endChapterId: 1 }], /reversed/i],
    [[{ profileId: "missing", startChapterId: 1, endChapterId: 5 }], /profile/i],
    [[{ profileId: "a", startChapterId: 1, endChapterId: 2 }, { profileId: "a", startChapterId: 3, endChapterId: 5 }], /profile/i],
    [[{ profileId: "a", startChapterId: 1, endChapterId: 9 }], /chapter/i],
  ])("rejects invalid manual assignments %#", (assignments, error) => {
    expect(() => planVpnDownloadRanges(catalog(5), [1, 2, 3, 4, 5], ["a", "b"], assignments)).toThrow(error);
  });

  it("rejects unknown or repeated requested chapters instead of silently dropping them", () => {
    expect(() => planVpnDownloadRanges(catalog(3), [1, 9], ["a"])).toThrow(/chapter/i);
    expect(() => planVpnDownloadRanges(catalog(3), [1, 1], ["a"])).toThrow(/duplicate/i);
    expect(() => planVpnDownloadRanges([{ id: 1 }, { id: 1 }], [1], ["a"])).toThrow(/duplicate/i);
    expect(() => planVpnDownloadRanges(catalog(3), [], ["a"])).toThrow(/chapter/i);
    expect(() => planVpnDownloadRanges(catalog(3), [1], [])).toThrow(/profile/i);
  });
});
