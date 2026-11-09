import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  READER_PENDING_MEDIA_ATTRIBUTE,
  READER_SEGMENT_INDEX_ATTRIBUTE,
} from "../reader-document";
import { type ReaderScrollAnchor } from "../../store/reader";
import { useReaderProgress } from "./use-reader-progress";

const reactHarness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T,>(callback: T) => callback,
  useEffect: (effect: () => void | (() => void)) => {
    reactHarness.effects.push(effect);
  },
  useLayoutEffect: (effect: () => void | (() => void)) => {
    reactHarness.effects.push(effect);
  },
  useRef: <T,>(current: T) => ({ current }),
  useState: <T,>(value: T) => [value, () => undefined],
}));

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

/** Ten webtoon images whose real heights are unknown until they load. */
class FakeWebtoon extends FakeElement {
  readonly segments: FakeElement[] = [];
  readonly images: FakeElement[] = [];
  constructor(viewport: FakeViewport) {
    super(viewport, "div");
    for (let index = 0; index < 10; index += 1) {
      const segment = new FakeElement(viewport, "p");
      segment.attributes.set(READER_SEGMENT_INDEX_ATTRIBUTE, String(index));
      const image = new FakeElement(viewport, "img");
      image.attributes.set(READER_PENDING_MEDIA_ATTRIBUTE, "true");
      segment.children.push(image);
      this.segments.push(segment);
      this.images.push(image);
    }
    this.layout(800);
  }
  layout(imageHeight: number) {
    this.segments.forEach((segment, index) => {
      for (const element of [segment, this.images[index]!]) {
        element.top = index * imageHeight;
        element.height = imageHeight;
      }
    });
    this.viewport.scrollHeight = imageHeight * this.segments.length;
  }
  loadImages() {
    for (const image of this.images) {
      image.attributes.delete(READER_PENDING_MEDIA_ATTRIBUTE);
    }
    this.layout(2400);
  }
  override querySelectorAll(selector: string): FakeElement[] {
    if (selector === `[${READER_SEGMENT_INDEX_ATTRIBUTE}]`) return this.segments;
    if (selector === "img" || selector === "img,video") return this.images;
    return [];
  }
  querySelector(selector: string): FakeElement | null {
    const match = /="(\d+)"\]$/.exec(selector);
    return match ? (this.segments[Number(match[1])] ?? null) : null;
  }
}

function openReader({
  initialProgress,
  initialScrollAnchor = null,
}: {
  initialProgress: number;
  initialScrollAnchor?: ReaderScrollAnchor | null;
}) {
  const viewport = new FakeViewport();
  const content = new FakeWebtoon(viewport);
  const onProgressChange = vi.fn();
  const onScrollAnchorChange = vi.fn();
  reactHarness.effects = [];
  const reader = useReaderProgress({
    contentKey: "7:stored",
    initialProgress,
    initialScrollAnchor,
    isPagedReader: false,
    layoutRestoreKey: "7:stored|layout",
    virtualDocument: {
      contentClassName: "reader-content",
      segments: content.segments.map((_, index) => ({
        estimatedHeight: 520,
        html: "",
        index,
      })),
      staticHtml: "",
    },
    segmentOffsets: [],
    completedForNavigationRef: { current: false },
    pageScrollAnimatingRef: { current: false },
    contentRef: { current: content as unknown as HTMLDivElement },
    getActiveScrollNode: () => viewport as unknown as HTMLDivElement,
    enforceScrollStepFloor: vi.fn(),
    syncScrollVirtualRange: vi.fn(),
    cancelPagedScrollAnimation: vi.fn(),
    onProgressChange,
    onScrollAnchorChange,
  });
  const cleanups = reactHarness.effects
    .map((effect) => effect())
    .filter((cleanup) => typeof cleanup === "function");
  return {
    viewport,
    content,
    reader,
    onProgressChange,
    onScrollAnchorChange,
    unmount: () => {
      for (const cleanup of cleanups) cleanup();
    },
  };
}

const SAVED_ANCHOR: ReaderScrollAnchor = {
  segmentIndex: 5,
  mediaOrdinal: 0,
  offset: 0.25,
  segmentCount: 10,
};

let browserWindow: EventTarget;
let documentTarget: EventTarget;
let visibilityState: "visible" | "hidden";

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
  browserWindow = new EventTarget();
  documentTarget = new EventTarget();
  visibilityState = "visible";
  vi.stubGlobal("window", Object.assign(browserWindow, {
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: number) => clearTimeout(id),
    setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
    clearInterval: (id: number) => clearInterval(id),
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 16),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  }));
  Object.defineProperty(documentTarget, "visibilityState", { configurable: true, get: () => visibilityState });
  vi.stubGlobal("document", documentTarget);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useReaderProgress scroll restore", () => {
  it("reopens at the saved image and keeps it there while images above it load", () => {
    const { viewport, content, reader, onProgressChange, onScrollAnchorChange } =
      openReader({ initialProgress: 48, initialScrollAnchor: SAVED_ANCHOR });
    expect(viewport.scrollTop).toBe(5 * 800 + 200);

    reader.updateProgressFromScroll();
    content.loadImages();
    vi.advanceTimersByTime(100);
    reader.updateProgressFromScroll();
    expect(viewport.scrollTop).toBe(5 * 2400 + 600);

    vi.advanceTimersByTime(1_000);
    expect(viewport.scrollTop).toBe(5 * 2400 + 600);
    expect(onProgressChange).not.toHaveBeenCalled();
    expect(onScrollAnchorChange).not.toHaveBeenCalled();
  });

  it("saves the user's position and its anchor once the user scrolls after the restore", () => {
    const { viewport, content, reader, onProgressChange, onScrollAnchorChange } =
      openReader({ initialProgress: 48, initialScrollAnchor: SAVED_ANCHOR });
    content.loadImages();
    vi.advanceTimersByTime(1_000);

    viewport.dispatchEvent(new Event("touchstart"));
    viewport.scrollTop = 5 * 2400 + 1800;
    reader.updateProgressFromScroll();
    vi.advanceTimersByTime(400);

    expect(onProgressChange).toHaveBeenCalledExactlyOnceWith(60);
    expect(onScrollAnchorChange).toHaveBeenCalledExactlyOnceWith({
      ...SAVED_ANCHOR,
      offset: 0.75,
      progress: 60,
    });
  });

  it("flushes the latest progress and anchor before the app is suspended", () => {
    const { viewport, content, reader, onProgressChange, onScrollAnchorChange } =
      openReader({ initialProgress: 48, initialScrollAnchor: SAVED_ANCHOR });
    content.loadImages();
    vi.advanceTimersByTime(1_000);

    viewport.dispatchEvent(new Event("touchstart"));
    viewport.scrollTop = 5 * 2400 + 1800;
    reader.updateProgressFromScroll();
    expect(onProgressChange).not.toHaveBeenCalled();

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(onProgressChange).toHaveBeenCalledExactlyOnceWith(60);
    expect(onScrollAnchorChange).toHaveBeenCalledExactlyOnceWith({
      ...SAVED_ANCHOR,
      offset: 0.75,
      progress: 60,
    });
  });

  it("writes nothing when the reader closes before the restore settles", () => {
    const { reader, unmount, onProgressChange, onScrollAnchorChange } = openReader(
      { initialProgress: 48, initialScrollAnchor: SAVED_ANCHOR },
    );
    reader.updateProgressFromScroll();
    vi.advanceTimersByTime(200);
    unmount();

    expect(onProgressChange).not.toHaveBeenCalled();
    expect(onScrollAnchorChange).not.toHaveBeenCalled();
  });

  it("falls back to the stored percentage and follows the loaded layout without an anchor", () => {
    const { viewport, content, reader, onProgressChange } = openReader({
      initialProgress: 50,
    });
    expect(viewport.scrollTop).toBe(3_500);

    content.loadImages();
    vi.advanceTimersByTime(100);
    reader.updateProgressFromScroll();
    vi.advanceTimersByTime(1_000);

    expect(viewport.scrollTop).toBe(11_500);
    expect(onProgressChange).not.toHaveBeenCalled();
  });

  it("ignores an anchor taken from a different document", () => {
    const { viewport } = openReader({
      initialProgress: 50,
      initialScrollAnchor: { ...SAVED_ANCHOR, segmentCount: 12 },
    });
    expect(viewport.scrollTop).toBe(3_500);
  });

  it("opens a finished chapter without an anchor at its real end", () => {
    const { viewport, content, reader, onProgressChange } = openReader({
      initialProgress: 100,
    });
    expect(viewport.scrollTop).toBe(7_000);

    content.loadImages();
    vi.advanceTimersByTime(100);
    reader.updateProgressFromScroll();
    vi.advanceTimersByTime(1_000);

    expect(viewport.scrollTop).toBe(23_000);
    expect(onProgressChange).not.toHaveBeenCalled();
  });

  it("opens a finished chapter at the position the reader left it", () => {
    const { viewport, content } = openReader({
      initialProgress: 100,
      initialScrollAnchor: SAVED_ANCHOR,
    });
    content.loadImages();
    vi.advanceTimersByTime(1_000);
    expect(viewport.scrollTop).toBe(5 * 2400 + 600);
  });
});
