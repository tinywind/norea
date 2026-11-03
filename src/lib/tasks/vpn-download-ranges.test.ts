import { describe, expect, it } from "vitest";
import {
  planVpnDownloadRanges,
  VPN_DOWNLOAD_CHUNK_CHAPTERS,
  vpnDownloadChunkCount,
} from "./vpn-download-ranges";

const catalog = (count: number) => Array.from({ length: count }, (_, index) => ({ id: index + 1 }));

describe("VPN download chunks", () => {
  it("splits a selection into chunks of at most 50 chapters, whatever the worker count", () => {
    expect(VPN_DOWNLOAD_CHUNK_CHAPTERS).toBe(50);
    expect([1, 50, 51, 120, 1450].map(vpnDownloadChunkCount)).toEqual([1, 1, 2, 3, 29]);
    expect(vpnDownloadChunkCount(0)).toBe(1);
  });

  it("plans contiguous chunks that never exceed the chunk size", () => {
    const selected = catalog(120).map(({ id }) => id);
    const ranges = planVpnDownloadRanges(catalog(120), selected, vpnDownloadChunkCount(selected.length));

    expect(ranges.map(({ startChapterId, endChapterId }) => [startChapterId, endChapterId]))
      .toEqual([[1, 40], [41, 80], [81, 120]]);
    expect(ranges.every(range => range.selectedChapterIds.length <= VPN_DOWNLOAD_CHUNK_CHAPTERS)).toBe(true);
  });
});

describe("VPN download range planning", () => {
  it("assigns fixed contiguous thirds rather than alternating chapters", () => {
    const ranges = planVpnDownloadRanges(catalog(300), catalog(300).map(({ id }) => id), 3);
    expect(ranges.map(({ startChapterId, endChapterId }) => [startChapterId, endChapterId]))
      .toEqual([[1, 100], [101, 200], [201, 300]]);
    expect(ranges.every(range => !("profileId" in range))).toBe(true);
    expect(ranges[0]?.chapterIds).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
  });

  it("balances requested chapters into fixed intervals while retaining unselected gaps", () => {
    const ranges = planVpnDownloadRanges(catalog(6), [1, 2, 4, 6], 3);
    expect(ranges.map(({ startChapterId, endChapterId, selectedChapterIds }) => [startChapterId, endChapterId, selectedChapterIds]))
      .toEqual([[1, 3, [1, 2]], [4, 5, [4]], [6, 6, [6]]]);
  });

  it("never allocates an empty worker range when requested chapters are far apart", () => {
    const ranges = planVpnDownloadRanges(catalog(100), [100, 3, 1, 2], 6);
    expect(ranges.map(range => range.selectedChapterIds)).toEqual([[1], [2], [3], [100]]);
    expect(ranges.map(range => [range.startChapterId, range.endChapterId])).toEqual([[1, 1], [2, 2], [3, 99], [100, 100]]);
  });

  it("uses catalog identities and order instead of display labels or numeric ID order", () => {
    const chapters = [{ id: 90 }, { id: 2 }, { id: 35 }, { id: 1 }, { id: 70 }];
    const ranges = planVpnDownloadRanges(chapters, [70, 1, 35, 2, 90], 2);
    expect(ranges.map(({ chapterIds }) => chapterIds)).toEqual([[90, 2, 35], [1, 70]]);
  });

  it("bounds automatic workers by the number of chapters in the selected span", () => {
    expect(planVpnDownloadRanges(catalog(4), [2], 3))
      .toEqual([{ startChapterId: 2, endChapterId: 2, chapterIds: [2], selectedChapterIds: [2] }]);
  });

  it("accepts editable contiguous ranges and freezes a copy of membership", () => {
    const chapters = catalog(6);
    const selected = [2, 3, 4, 5];
    const ranges = planVpnDownloadRanges(chapters, selected, 2, [
      { startChapterId: 2, endChapterId: 4 },
      { startChapterId: 5, endChapterId: 5 },
    ]);
    chapters.reverse();
    selected.reverse();
    expect(ranges.map(({ chapterIds }) => chapterIds)).toEqual([[2, 3, 4], [5]]);
  });

  it.each([
    [[{ startChapterId: 1, endChapterId: 3 }, { startChapterId: 3, endChapterId: 5 }], /overlap/i],
    [[{ startChapterId: 1, endChapterId: 2 }, { startChapterId: 4, endChapterId: 5 }], /unassigned/i],
    [[{ startChapterId: 3, endChapterId: 1 }], /reversed/i],
    [[{ startChapterId: 1, endChapterId: 9 }], /chapter/i],
  ])("rejects invalid manual assignments %#", (assignments, error) => {
    expect(() => planVpnDownloadRanges(catalog(5), [1, 2, 3, 4, 5], 2, assignments)).toThrow(error);
  });

  it("rejects unknown or repeated requested chapters instead of silently dropping them", () => {
    expect(() => planVpnDownloadRanges(catalog(3), [1, 9], 1)).toThrow(/chapter/i);
    expect(() => planVpnDownloadRanges(catalog(3), [1, 1], 1)).toThrow(/duplicate/i);
    expect(() => planVpnDownloadRanges([{ id: 1 }, { id: 1 }], [1], 1)).toThrow(/duplicate/i);
    expect(() => planVpnDownloadRanges(catalog(3), [], 1)).toThrow(/chapter/i);
    expect(() => planVpnDownloadRanges(catalog(3), [1], 0)).toThrow(/range count/i);
  });
});
