import { describe, expect, it } from "vitest";
import {
  pageNumbersForVirtualRange,
  prefixSegmentHeights,
  readerHtmlHasMedia,
  shouldVirtualizeReaderScroll,
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

  it.each([
    {
      hasMediaSegments: false,
      isPagedReader: false,
      expected: true,
      scenario: "a media-free scroll chapter",
    },
    {
      hasMediaSegments: true,
      isPagedReader: false,
      expected: false,
      scenario: "a media-heavy scroll chapter",
    },
    {
      hasMediaSegments: false,
      isPagedReader: true,
      expected: false,
      scenario: "a media-free paged chapter",
    },
    {
      hasMediaSegments: true,
      isPagedReader: true,
      expected: false,
      scenario: "a media-heavy paged chapter",
    },
  ])("enables virtual range work only for $scenario", (reader) => {
    expect(
      shouldVirtualizeReaderScroll({
        hasMediaSegments: reader.hasMediaSegments,
        isPagedReader: reader.isPagedReader,
      }),
    ).toBe(reader.expected);
  });

  it.each([
    ["an image", '<img src="page.jpg">'],
    ["an object", '<object data="page.svg"></object>'],
    ["audio", '<audio src="chapter.mp3"></audio>'],
    [
      "a double-quoted background image",
      '<div style="background-image: url(\'page.jpg\')"></div>',
    ],
    [
      "a single-quoted background image",
      '<div style=\'background-image: url("page.jpg")\'></div>',
    ],
  ])("recognizes $0 as reader media", (_scenario, html) => {
    expect(readerHtmlHasMedia(html)).toBe(true);
  });

  it("does not classify ordinary styled text as reader media", () => {
    expect(readerHtmlHasMedia('<p style="color: red">Chapter</p>')).toBe(false);
  });
});
