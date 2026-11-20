import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountBackNavigationHarness, type BackNavigationHarness } from "../../lib/android-back-navigation.test-support";

const setPendingReaderProgressSpy = vi.hoisted(() => vi.fn());
vi.mock("../../lib/tasks/sync-runtime", async (original) => ({
  ...(await original<typeof import("../../lib/tasks/sync-runtime")>()),
  setPendingReaderProgress: setPendingReaderProgressSpy,
}));

import { useReaderLayoutRevision } from "./use-reader-layout-revision";
import { useReaderProgress } from "./use-reader-progress";

let harness: BackNavigationHarness;
let preparing: boolean;
let isPagedReader: boolean;
let initialProgress: number;
let layoutKey: string;
let reader: ReturnType<typeof useReaderProgress>;
let node: HTMLDivElement;
const onProgress = vi.fn();
const onAnchor = vi.fn();
const onPage = vi.fn();
const contentRef = { current: null as HTMLDivElement | null };
const completedRef = { current: false };
const animationRef = { current: false };
const virtualDocument = { contentClassName: "reader-content", segments: [], staticHtml: "" };
const noop = () => {};
const getNode = () => node;
function Probe() {
  reader = useReaderProgress({
    contentKey: "2:stored", preparing, initialProgress, isPagedReader,
    layoutRestoreKey: layoutKey, virtualDocument, segmentOffsets: [], completedForNavigationRef: completedRef,
    pageScrollAnimatingRef: animationRef, contentRef, getActiveScrollNode: getNode,
    enforceScrollStepFloor: noop, syncScrollVirtualRange: noop, cancelPagedScrollAnimation: noop,
    onProgressChange: preparing ? undefined : onProgress,
    onScrollAnchorChange: preparing ? undefined : onAnchor,
    onPageIndexChange: preparing ? undefined : onPage,
  });
  return null;
}
async function render() {
  await harness.render(<Probe />);
  await harness.run(() => vi.advanceTimersByTime(150));
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
  harness = mountBackNavigationHarness();
  Object.assign(window, {
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    getComputedStyle: () => ({ columnGap: "0", paddingLeft: "0", paddingRight: "0" }),
  });
  preparing = true;
  isPagedReader = true;
  initialProgress = 0;
  layoutKey = "layout";
  completedRef.current = false;
  node = {
    clientHeight: 600, clientWidth: 400, scrollHeight: 600, scrollWidth: 2000,
    scrollTop: 0, scrollLeft: 0,
    querySelectorAll: () => [],
    scrollTo: vi.fn(function(this: HTMLDivElement, options: ScrollToOptions) {
      if (options.left !== undefined) this.scrollLeft = options.left;
      if (options.top !== undefined) this.scrollTop = options.top;
    }),
  } as unknown as HTMLDivElement;
  contentRef.current = node;
  onProgress.mockClear(); onAnchor.mockClear(); onPage.mockClear();
  setPendingReaderProgressSpy.mockClear();
});
afterEach(async () => { await harness.unmount(); vi.useRealTimers(); });

it("prepares pagination without saving and retains the first-page layout on ordinary next navigation", async () => {
  await render();
  expect(reader.pageInfo).toEqual({ current: 1, total: 5 });
  expect(onProgress).not.toHaveBeenCalled();
  expect(onPage).not.toHaveBeenCalled();
  const restores = vi.mocked(node.scrollTo).mock.calls.length;
  preparing = false;
  await render();
  expect(reader.pageInfo).toEqual({ current: 1, total: 5 });
  expect(vi.mocked(node.scrollTo).mock.calls.length).toBe(restores);
  expect(onProgress).not.toHaveBeenCalled();
});

it("restores the saved position when the prepared chapter is opened from the chapter list", async () => {
  await render();
  preparing = false;
  initialProgress = 50;
  await render();
  expect(node.scrollLeft).toBe(800);
  expect(reader.pageInfo).toEqual({ current: 3, total: 5 });
  expect(onProgress).not.toHaveBeenCalled();
});

it("resets a previously read chapter when back navigation makes it the next prepared chapter again", async () => {
  preparing = false;
  initialProgress = 50;
  await render();
  expect(node.scrollLeft).toBe(800);
  preparing = true;
  initialProgress = 0;
  await render();
  expect(node.scrollLeft).toBe(0);
  preparing = false;
  await render();
  expect(node.scrollLeft).toBe(0);
  expect(reader.pageInfo.current).toBe(1);
});

it("updates hidden pagination when the prepared viewport or media layout changes", async () => {
  await render();
  Object.defineProperty(node, "scrollWidth", { value: 2800 });
  layoutKey = "layout-after-fonts";
  await render();
  expect(reader.pageInfo).toEqual({ current: 1, total: 7 });
  expect(onProgress).not.toHaveBeenCalled();
  expect(onPage).not.toHaveBeenCalled();
});

it("ignores scroll events and never touches global pending progress while preparing, and resets background drift on promotion", async () => {
  isPagedReader = false;
  Object.defineProperty(node, "scrollHeight", { configurable: true, value: 4000 });
  await render();

  node.scrollTop = 1200;
  reader.updateProgressFromScroll();
  await harness.run(() => vi.advanceTimersByTime(400));
  expect(onProgress).not.toHaveBeenCalled();
  expect(onAnchor).not.toHaveBeenCalled();
  expect(setPendingReaderProgressSpy).not.toHaveBeenCalled();

  preparing = false;
  await render();
  expect(node.scrollTop).toBe(0);
  expect(reader.progress).toBe(0);
  expect(setPendingReaderProgressSpy).not.toHaveBeenCalled();
  expect(onProgress).not.toHaveBeenCalled();
  expect(onAnchor).not.toHaveBeenCalled();
});

it("keeps clean scroll-mode promotion at 0% without extra scrollTo or progress drift after collapsed layout", async () => {
  isPagedReader = false;
  Object.defineProperty(node, "scrollHeight", { configurable: true, value: 600 });
  await render();
  expect(reader.progress).toBe(0);

  Object.defineProperty(node, "scrollHeight", { configurable: true, value: 6000 });
  const restores = vi.mocked(node.scrollTo).mock.calls.length;
  preparing = false;
  await render();

  expect(node.scrollTop).toBe(0);
  expect(reader.progress).toBe(0);
  expect(vi.mocked(node.scrollTo).mock.calls.length).toBe(restores);
  expect(onProgress).not.toHaveBeenCalled();
});

it("still runs initial restore and measures pagination if promoted before the prepared frame fires", async () => {
  await harness.render(<Probe />);
  // Promote before the 16ms rAF fires.
  preparing = false;
  await render();

  expect(reader.pageInfo).toEqual({ current: 1, total: 5 });
  expect(node.scrollLeft).toBe(0);
  expect(onProgress).not.toHaveBeenCalled();
});

it("resets drifted background scrollTop synchronously before paint so an immediate pre-rAF scroll event cannot poison progress", async () => {
  isPagedReader = false;
  Object.defineProperty(node, "scrollHeight", { configurable: true, value: 4000 });
  await render();

  node.scrollTop = 3400;
  preparing = false;
  await harness.render(<Probe />);
  // Reset happened synchronously in useLayoutEffect before the 16ms rAF.
  expect(node.scrollTop).toBe(0);

  // Programmatic reset scroll or layout reflow scroll firing before rAF must not save progress or dirty anchor.
  await harness.run(() => {
    reader.updateProgressFromScroll();
  });
  await harness.run(() => vi.advanceTimersByTime(500));

  expect(node.scrollTop).toBe(0);
  expect(reader.progress).toBe(0);
  expect(onProgress).not.toHaveBeenCalled();
  expect(onAnchor).not.toHaveBeenCalled();
  expect(setPendingReaderProgressSpy).not.toHaveBeenCalled();

  // Subsequent genuine user scroll after promotion is still tracked normally.
  node.scrollTop = 1700;
  await harness.run(() => {
    reader.updateProgressFromScroll();
  });
  await harness.run(() => vi.advanceTimersByTime(400));
  expect(reader.progress).toBe(50);
  expect(onProgress).toHaveBeenCalledExactlyOnceWith(50);
});

it("runs scroll restore settle on promotion when a prepared scroll chapter already has non-zero initialProgress", async () => {
  isPagedReader = false;
  initialProgress = 50;
  Object.defineProperty(node, "scrollHeight", { configurable: true, value: 600 });
  Object.assign(node, {
    isConnected: true,
    addEventListener: noop,
    removeEventListener: noop,
    querySelectorAll: () => [],
  });
  await render();
  expect(node.scrollTop).toBe(0);

  Object.defineProperty(node, "scrollHeight", { configurable: true, value: 4600 });
  preparing = false;
  await harness.render(<Probe />);
  await harness.run(() => vi.advanceTimersByTime(400));

  expect(node.scrollTop).toBe(2000);
  expect(onProgress).not.toHaveBeenCalled();
});

it("keeps scroll-mode webtoon position stable when late images fire load events after initial collapsed layout", async () => {
  isPagedReader = false;
  preparing = false;
  initialProgress = 0;
  const contentTarget = new EventTarget();
  Object.assign(node, {
    scrollHeight: 600,
    addEventListener: contentTarget.addEventListener.bind(contentTarget),
    removeEventListener: contentTarget.removeEventListener.bind(contentTarget),
    dispatchEvent: contentTarget.dispatchEvent.bind(contentTarget),
  });

  function IntegratedProbe() {
    const layoutRevision = useReaderLayoutRevision(
      contentRef,
      '<img src="a.jpg" /><img src="b.jpg" />',
      isPagedReader,
    );
    const effectiveLayoutKey = `2:stored|${isPagedReader ? layoutRevision : ""}`;
    reader = useReaderProgress({
      contentKey: "2:stored",
      preparing,
      initialProgress,
      isPagedReader,
      layoutRestoreKey: effectiveLayoutKey,
      virtualDocument,
      segmentOffsets: [],
      completedForNavigationRef: completedRef,
      pageScrollAnimatingRef: animationRef,
      contentRef,
      getActiveScrollNode: getNode,
      enforceScrollStepFloor: noop,
      syncScrollVirtualRange: noop,
      cancelPagedScrollAnimation: noop,
      onProgressChange: onProgress,
      onScrollAnchorChange: onAnchor,
      onPageIndexChange: onPage,
    });
    return null;
  }

  await harness.render(<IntegratedProbe />);
  await harness.run(() => vi.advanceTimersByTime(200));
  expect(node.scrollTop).toBe(0);
  expect(reader.progress).toBe(0);
  const initialScrollToCalls = vi.mocked(node.scrollTo).mock.calls.length;
  expect(initialScrollToCalls).toBe(1);

  // Images finish loading: scrollHeight grows and multiple image load events fire.
  Object.defineProperty(node, "scrollHeight", { configurable: true, value: 4600 });
  await harness.run(() => {
    node.dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(100);
  });
  expect(node.scrollTop).toBe(0);
  expect(reader.progress).toBe(0);
  expect(vi.mocked(node.scrollTo).mock.calls.length).toBe(initialScrollToCalls);

  // User reads partway down, then another late image loads and grows scrollHeight.
  node.scrollTop = 400;
  await harness.run(() => {
    reader.updateProgressFromScroll();
  });
  Object.defineProperty(node, "scrollHeight", { configurable: true, value: 12600 });
  await harness.run(() => {
    node.dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(400);
  });

  expect(node.scrollTop).toBe(400);
  expect(vi.mocked(node.scrollTo).mock.calls.length).toBe(initialScrollToCalls);
  expect(onProgress).not.toHaveBeenCalledWith(100);
});
