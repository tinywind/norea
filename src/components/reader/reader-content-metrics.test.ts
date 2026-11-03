import { afterEach, describe, expect, it, vi } from "vitest";
import {
  animateScrollTop,
  getPageInfo,
  getProgress,
  isAtReadingEnd,
  readerScrollAnimationDuration,
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

describe("reader scroll animation", () => {
  let now = 0;
  let frames: FrameRequestCallback[] = [];

  function stubWindow(reducedMotion: boolean) {
    now = 0;
    frames = [];
    vi.stubGlobal("performance", { now: () => now });
    vi.stubGlobal("window", {
      matchMedia: (query: string) => ({
        matches: reducedMotion && query === "(prefers-reduced-motion: reduce)",
      }),
      requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
      cancelAnimationFrame: (id: number) => {
        frames[id - 1] = () => undefined;
      },
    });
  }

  function frame(at: number) {
    now = at;
    const callback = frames[frames.length - 1]!;
    callback(at);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("jumps instead of animating when reduced motion is on", () => {
    stubWindow(true);
    expect(readerScrollAnimationDuration(200)).toBe(0);
    stubWindow(false);
    expect(readerScrollAnimationDuration(200)).toBe(200);
    expect(readerScrollAnimationDuration(-5)).toBe(0);
  });

  it("eases scrollTop to the target and completes on the last frame", () => {
    stubWindow(false);
    const node = { scrollTop: 100 } as HTMLElement;
    const onComplete = vi.fn();
    animateScrollTop(node, 500, 200, onComplete);
    frame(100);
    expect(node.scrollTop).toBeGreaterThan(100);
    expect(node.scrollTop).toBeLessThan(600);
    expect(onComplete).not.toHaveBeenCalled();
    frame(200);
    expect(node.scrollTop).toBe(600);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("keeps a scroll anchoring shift made while it runs", () => {
    stubWindow(false);
    const node = { scrollTop: 0 } as HTMLElement;
    animateScrollTop(node, 400, 200, () => undefined);
    frame(100);
    node.scrollTop += 50;
    frame(200);
    expect(node.scrollTop).toBe(450);
  });

  it("stops when cancelled", () => {
    stubWindow(false);
    const node = { scrollTop: 0 } as HTMLElement;
    const onComplete = vi.fn();
    const cancel = animateScrollTop(node, 400, 200, onComplete);
    cancel();
    frame(200);
    expect(node.scrollTop).toBe(0);
    expect(onComplete).not.toHaveBeenCalled();
  });
});
