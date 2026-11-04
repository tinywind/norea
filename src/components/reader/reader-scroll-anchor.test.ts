import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  READER_PENDING_MEDIA_ATTRIBUTE,
  READER_SEGMENT_INDEX_ATTRIBUTE,
} from "../reader-document";
import {
  captureReaderScrollAnchor,
  chapterScrollAnchorForProgress,
  READER_RESTORE_SETTLE_MAX_MS,
  readerRestoreMediaSettled,
  readerScrollAnchorTop,
  startReaderRestoreSettle,
  type ReaderRestoreSettleEnd,
} from "./reader-scroll-anchor";

class FakeViewport extends EventTarget {
  scrollTop = 0;
  clientHeight = 1000;
  scrollHeight = 0;
  isConnected = true;
  getBoundingClientRect() {
    return { top: 0, height: this.clientHeight };
  }
}

class FakeElement extends EventTarget {
  top = 0;
  height = 0;
  complete = true;
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  constructor(
    readonly viewport: FakeViewport,
    readonly tagName: string,
  ) {
    super();
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  matches(selector: string) {
    return selector.split(",").includes(this.tagName);
  }
  getBoundingClientRect() {
    return { top: this.top - this.viewport.scrollTop, height: this.height };
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.children.filter((child) => child.matches(selector));
  }
}

/** A webtoon-like chapter: one block per image, laid out top to bottom. */
class FakeContent extends FakeElement {
  readonly segments: FakeElement[] = [];
  readonly images: FakeElement[] = [];
  canvas: FakeElement | null = null;
  constructor(viewport: FakeViewport, heights: number[]) {
    super(viewport, "div");
    heights.forEach((_, index) => {
      const segment = new FakeElement(viewport, "p");
      segment.attributes.set(READER_SEGMENT_INDEX_ATTRIBUTE, String(index));
      const image = new FakeElement(viewport, "img");
      segment.children.push(image);
      this.segments.push(segment);
      this.images.push(image);
    });
    this.setHeights(heights);
  }
  setHeights(heights: number[]) {
    let top = 0;
    heights.forEach((height, index) => {
      for (const element of [this.segments[index]!, this.images[index]!]) {
        element.top = top;
        element.height = height;
      }
      top += height;
    });
    this.viewport.scrollHeight = top;
  }
  override querySelectorAll(selector: string): FakeElement[] {
    if (selector === `[${READER_SEGMENT_INDEX_ATTRIBUTE}]`) return this.segments;
    if (selector === "img" || selector === "img,video") return this.images;
    return [];
  }
  querySelector(selector: string): FakeElement | null {
    if (selector === "[data-norea-reader-virtual-canvas]") return this.canvas;
    const match = /="(\d+)"\]$/.exec(selector);
    return match ? (this.segments[Number(match[1])] ?? null) : null;
  }
}

function webtoon(heights: number[]) {
  const viewport = new FakeViewport();
  const content = new FakeContent(viewport, heights);
  return {
    viewport,
    content,
    node: viewport as unknown as HTMLElement,
    root: content as unknown as HTMLElement,
  };
}

describe("reader scroll anchor geometry", () => {
  it("captures the image at the viewport top and the offset inside it", () => {
    const { viewport, node, root } = webtoon([800, 800, 800, 800]);
    viewport.scrollTop = 2000;

    expect(captureReaderScrollAnchor(node, root)).toEqual({
      segmentIndex: 2,
      mediaOrdinal: 0,
      offset: 0.5,
    });
  });

  it("returns to the same image after images above it change size", () => {
    const { viewport, content, node, root } = webtoon([800, 800, 800, 800]);
    viewport.scrollTop = 2000;
    const anchor = captureReaderScrollAnchor(node, root)!;

    content.setHeights([2400, 2400, 2400, 2400]);
    viewport.scrollTop = 0;

    expect(readerScrollAnchorTop(node, root, anchor)).toBe(2 * 2400 + 1200);
  });

  it("places an unmounted virtual segment from its measured offsets", () => {
    const { content, node, root } = webtoon([]);
    content.canvas = new FakeElement(content.viewport, "div");
    content.canvas.top = 40;

    expect(
      readerScrollAnchorTop(
        node,
        root,
        { segmentIndex: 2, offset: 0.25 },
        [0, 100, 300, 700],
      ),
    ).toBe(40 + 300 + 100);
    expect(readerScrollAnchorTop(node, root, { segmentIndex: 9, offset: 0 })).toBe(
      null,
    );
  });

  it("waits only for images at or above the anchor", () => {
    const { content, root } = webtoon([800, 800, 800]);
    content.images[2]!.complete = false;
    content.images[0]!.attributes.set(READER_PENDING_MEDIA_ATTRIBUTE, "true");

    expect(readerRestoreMediaSettled(root, 800)).toBe(false);
    content.images[0]!.attributes.delete(READER_PENDING_MEDIA_ATTRIBUTE);
    expect(readerRestoreMediaSettled(root, 800)).toBe(true);
    expect(readerRestoreMediaSettled(root, null)).toBe(false);
  });
});

describe("chapterScrollAnchorForProgress", () => {
  const saved = {
    novelId: 1,
    progress: 48,
    savedAt: 1,
    segmentCount: 4,
    segmentIndex: 2,
    mediaOrdinal: 0,
    offset: 0.5,
  };

  it("uses the anchor saved with the stored progress", () => {
    expect(chapterScrollAnchorForProgress(saved, 48)).toEqual({
      segmentCount: 4,
      segmentIndex: 2,
      mediaOrdinal: 0,
      offset: 0.5,
    });
  });

  it("ignores an anchor when the progress changed elsewhere, such as marked unread", () => {
    expect(chapterScrollAnchorForProgress(saved, 0)).toBeNull();
    expect(chapterScrollAnchorForProgress(undefined, 48)).toBeNull();
  });

  it("keeps the anchor of a finished chapter whose stored progress stays 100", () => {
    expect(chapterScrollAnchorForProgress(saved, 100)?.segmentIndex).toBe(2);
  });
});

describe("startReaderRestoreSettle", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "performance",
      ],
    });
    vi.stubGlobal("window", {
      setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
      clearTimeout: (id: number) => clearTimeout(id),
      setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
      clearInterval: (id: number) => clearInterval(id),
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16),
      cancelAnimationFrame: (id: number) => clearTimeout(id),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function startPinned(heights: number[], anchorTop = 2000) {
    const scene = webtoon(heights);
    scene.viewport.scrollTop = anchorTop;
    const anchor = captureReaderScrollAnchor(scene.node, scene.root)!;
    scene.viewport.scrollTop = 0;
    for (const image of scene.content.images) {
      image.attributes.set(READER_PENDING_MEDIA_ATTRIBUTE, "true");
    }
    const ends: ReaderRestoreSettleEnd[] = [];
    const settle = startReaderRestoreSettle({
      node: scene.node,
      content: scene.root,
      targetTop: () => readerScrollAnchorTop(scene.node, scene.root, anchor),
      isSettled: () => readerRestoreMediaSettled(scene.root, null),
      onApply: () => undefined,
      onEnd: (reason) => ends.push(reason),
    });
    return { ...scene, ends, settle };
  }

  function loadImages(content: FakeContent, heights: number[]) {
    for (const image of content.images) {
      image.attributes.delete(READER_PENDING_MEDIA_ATTRIBUTE);
    }
    content.setHeights(heights);
  }

  it("keeps the anchored image in view while images above it load", () => {
    const { content, viewport, ends, settle } = startPinned([800, 800, 800, 800]);
    expect(viewport.scrollTop).toBe(2000);

    loadImages(content, [2400, 2400, 2400, 2400]);
    vi.advanceTimersByTime(100);
    expect(viewport.scrollTop).toBe(6000);
    expect(settle.active).toBe(true);

    vi.advanceTimersByTime(200);
    expect(ends).toEqual(["settled"]);
    expect(settle.active).toBe(false);
  });

  it("treats a scroll without user input as layout and keeps pinning", () => {
    const { content, viewport, settle } = startPinned([800, 800, 800, 800]);
    viewport.clientHeight = 200;
    content.setHeights([400, 400, 400, 400]);
    viewport.scrollTop = 600;

    settle.noteScroll();
    vi.advanceTimersByTime(20);

    expect(settle.active).toBe(true);
    expect(viewport.scrollTop).toBe(1000);
  });

  it("ends as soon as the user scrolls and stops moving the page", () => {
    const { content, viewport, ends, settle } = startPinned([800, 800, 800, 800]);
    viewport.dispatchEvent(new Event("touchstart"));
    viewport.scrollTop = 2300;
    settle.noteScroll();

    expect(ends).toEqual(["user"]);
    loadImages(content, [2400, 2400, 2400, 2400]);
    vi.advanceTimersByTime(500);
    expect(viewport.scrollTop).toBe(2300);
  });

  it("does not move the page while a finger rests on it", () => {
    const { content, viewport, settle } = startPinned([800, 800, 800, 800]);
    viewport.dispatchEvent(new Event("touchstart"));
    loadImages(content, [2400, 2400, 2400, 2400]);
    vi.advanceTimersByTime(300);
    expect(viewport.scrollTop).toBe(2000);
    expect(settle.active).toBe(true);

    viewport.dispatchEvent(new Event("touchend"));
    vi.advanceTimersByTime(100);
    expect(viewport.scrollTop).toBe(6000);
  });

  it("gives up after the settle limit when images never finish", () => {
    const { ends } = startPinned([800, 800, 800, 800]);
    vi.advanceTimersByTime(READER_RESTORE_SETTLE_MAX_MS + 100);
    expect(ends).toEqual(["timeout"]);
  });
});
