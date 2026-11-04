import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCROLL_PAGE_FRACTION } from "./reader-content-metrics";
import { useReaderScrollLayout } from "./use-reader-scroll-layout";

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useCallback: <T,>(callback: T) => callback,
  useEffect: vi.fn(),
  useLayoutEffect: vi.fn(),
  useMemo: <T,>(factory: () => T) => factory(),
  useRef: <T,>(current: T) => ({ current }),
  useState: <T,>(initial: T) => [initial, vi.fn()],
}));
vi.mock("./reader-content-metrics", async (importOriginal) => ({
  ...await importOriginal<typeof import("./reader-content-metrics")>(),
  logReaderInput: vi.fn(),
}));

const PAGE = 400;
let frames = new Map<number, (now: number) => void>();
let nextFrame = 1;
let now = 0;

function runFrames(untilMs: number) {
  while (frames.size > 0 && now < untilMs) {
    now += 16;
    const pending = [...frames.values()];
    frames = new Map();
    for (const frame of pending) frame(now);
  }
}

function fakeNode(init: Partial<HTMLDivElement>) {
  return {
    clientHeight: PAGE,
    clientWidth: PAGE,
    dispatchEvent: vi.fn(),
    scrollHeight: PAGE,
    scrollLeft: 0,
    scrollTo(this: { scrollLeft: number; scrollTop: number }, options: ScrollToOptions) {
      if (options.top !== undefined) this.scrollTop = options.top;
      if (options.left !== undefined) this.scrollLeft = options.left;
    },
    scrollTop: 0,
    scrollWidth: PAGE,
    ...init,
  } as unknown as HTMLDivElement;
}

function mountLayout(isPagedReader: boolean, node: HTMLDivElement) {
  const onBoundaryPage = vi.fn();
  const layout = useReaderScrollLayout({
    completedForNavigationRef: { current: false },
    contentRef: { current: isPagedReader ? node : null },
    isPagedReader,
    onBoundaryPage,
    pageTransitionDuration: 300,
    viewportRef: { current: isPagedReader ? null : node },
    virtualDocument: { segments: [] } as never,
  });
  return { layout, onBoundaryPage };
}

beforeEach(() => {
  frames = new Map();
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("window", {
    cancelAnimationFrame: (id: number) => frames.delete(id),
    clearTimeout,
    requestAnimationFrame: (callback: (time: number) => void) => {
      frames.set(nextFrame, callback);
      return nextFrame++;
    },
    setTimeout,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("quick page steps", () => {
  it("chains each scroll step from the previous step's target, not the animated position", () => {
    const node = fakeNode({ scrollHeight: PAGE * 20 });
    const { layout } = mountLayout(false, node);
    for (let tap = 0; tap < 5; tap += 1) {
      layout.scrollByPage(1, "tap-next");
      runFrames(now + 48);
    }
    runFrames(now + 2000);
    expect(node.scrollTop).toBeCloseTo(PAGE * SCROLL_PAGE_FRACTION * 5, 0);
  });

  it("advances one page per tap in paged mode while the previous turn still animates", () => {
    const node = fakeNode({ scrollWidth: PAGE * 10 });
    const { layout, onBoundaryPage } = mountLayout(true, node);
    for (let tap = 0; tap < 5; tap += 1) {
      layout.scrollByPage(1, "tap-next");
      runFrames(now + 48);
    }
    runFrames(now + 2000);
    expect(node.scrollLeft).toBe(PAGE * 5);
    expect(onBoundaryPage).not.toHaveBeenCalled();
  });
});
