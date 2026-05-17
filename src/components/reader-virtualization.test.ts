import { describe, expect, it } from "vitest";
import {
  pageNumbersForVirtualRange,
  prefixSegmentHeights,
  virtualRangeForScroll,
  virtualRangesEqual,
} from "./reader-virtualization";

describe("reader virtualization helpers", () => {
  it("keeps legacy boundary behavior while using bounded range lookup", () => {
    const offsets = prefixSegmentHeights([100, 100, 100, 100]);

    expect(virtualRangeForScroll(0, 50, offsets, 0)).toEqual({
      start: 0,
      end: 1,
    });
    expect(virtualRangeForScroll(101, 50, offsets, 0)).toEqual({
      start: 1,
      end: 2,
    });
    expect(virtualRangeForScroll(999, 50, offsets, 0)).toEqual({
      start: 3,
      end: 3,
    });
  });

  it("includes CSS gaps in scroll offsets for PDF page slots", () => {
    expect(prefixSegmentHeights([200, 300, 400], 16)).toEqual([
      0,
      216,
      532,
      932,
    ]);
  });

  it("returns a bounded one-based page window from a virtual range", () => {
    expect(pageNumbersForVirtualRange({ start: 7, end: 9 }, 200)).toEqual([
      8,
      9,
      10,
    ]);
    expect(pageNumbersForVirtualRange({ start: 198, end: 250 }, 200)).toEqual([
      199,
      200,
    ]);
  });

  it("keeps large scroll lookups bounded to the viewport window", () => {
    const offsets = prefixSegmentHeights(
      Array.from({ length: 10_000 }, () => 1_000),
    );

    expect(virtualRangeForScroll(5_000_000, 800, offsets, 1_600)).toEqual({
      start: 4998,
      end: 5003,
    });
  });

  it("compares virtual ranges without reallocating callers", () => {
    expect(
      virtualRangesEqual({ start: 2, end: 4 }, { start: 2, end: 4 }),
    ).toBe(true);
    expect(
      virtualRangesEqual({ start: 2, end: 4 }, { start: 2, end: 5 }),
    ).toBe(false);
  });
});
