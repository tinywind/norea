import { describe, expect, it } from "vitest";
import {
  getPageInfo,
  getProgress,
  isAtReadingEnd,
  scrollToProgress,
  virtualScrollAnchorDelta,
} from "./reader-content-metrics";

function viewport({
  width = 400,
  height = 600,
  scrollWidth = width,
  scrollHeight = height,
}: {
  width?: number;
  height?: number;
  scrollWidth?: number;
  scrollHeight?: number;
}): HTMLElement {
  const node = {
    clientWidth: width,
    clientHeight: height,
    scrollWidth,
    scrollHeight,
    scrollLeft: 0,
    scrollTop: 0,
    scrollTo({ left, top }: ScrollToOptions) {
      if (left !== undefined) this.scrollLeft = left;
      if (top !== undefined) this.scrollTop = top;
    },
  };
  return node as unknown as HTMLElement;
}

describe("reader progress geometry", () => {
  it("restores the middle and final page when the final spread is partial", () => {
    const node = viewport({ width: 400, scrollWidth: 1050 });

    scrollToProgress(node, 50, true, "auto");
    expect(node.scrollLeft).toBe(400);
    expect(getPageInfo(node, true)).toEqual({ current: 2, total: 3 });
    expect(getProgress(node, true)).toBe(50);
    expect(isAtReadingEnd(node, true)).toBe(false);

    scrollToProgress(node, 100, true, "auto");
    expect(node.scrollLeft).toBe(650);
    expect(getPageInfo(node, true)).toEqual({ current: 3, total: 3 });
    expect(getProgress(node, true)).toBe(100);
    expect(isAtReadingEnd(node, true)).toBe(true);
  });

  it("does not create a phantom page from trailing column whitespace", () => {
    const whitespace = viewport({ width: 1000, scrollWidth: 2025 });
    const actualPage = viewport({ width: 1000, scrollWidth: 2060 });

    expect(getPageInfo(whitespace, true).total).toBe(2);
    expect(getPageInfo(actualPage, true).total).toBe(3);
    scrollToProgress(whitespace, 100, true, "auto");
    expect(whitespace.scrollLeft).toBe(1025);
    expect(isAtReadingEnd(whitespace, true)).toBe(true);
  });

  it("keeps single-page progress distinct from explicit completion", () => {
    const node = viewport({});
    expect(getPageInfo(node, true)).toEqual({ current: 1, total: 1 });
    expect(getProgress(node, true)).toBe(0);
    expect(isAtReadingEnd(node, true)).toBe(true);
    expect(getProgress(node, false)).toBe(100);
  });

  it("restores scrolling progress and detects the end within pixel tolerance", () => {
    const node = viewport({ height: 600, scrollHeight: 1800 });
    scrollToProgress(node, 50, false, "auto");
    expect(node.scrollTop).toBe(600);
    expect(getProgress(node, false)).toBe(50);
    expect(isAtReadingEnd(node, false)).toBe(false);
    node.scrollTop = 1199;
    expect(isAtReadingEnd(node, false)).toBe(true);
  });

  it("keeps the visible segment anchored when preceding media gains height", () => {
    expect(
      virtualScrollAnchorDelta(150, [0, 100, 200, 300], [0, 160, 260, 360]),
    ).toBe(60);
    expect(
      virtualScrollAnchorDelta(150, [0, 100, 200, 300], [0, 100, 270, 400]),
    ).toBe(0);
  });
});
