import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountBackNavigationHarness, type BackNavigationHarness } from "../../lib/android-back-navigation.test-support";
import { useReaderProgress } from "./use-reader-progress";

let harness: BackNavigationHarness;
let preparing: boolean;
let initialProgress: number;
let layoutKey: string;
let reader: ReturnType<typeof useReaderProgress>;
let node: HTMLDivElement;
const onProgress = vi.fn();
const onPage = vi.fn();
const contentRef = { current: null as HTMLDivElement | null };
const completedRef = { current: false };
const animationRef = { current: false };
const virtualDocument = { contentClassName: "reader-content", segments: [], staticHtml: "" };
const noop = () => {};
const getNode = () => node;
function Probe() {
  reader = useReaderProgress({
    contentKey: "2:stored", preparing, initialProgress, isPagedReader: true,
    layoutRestoreKey: layoutKey, virtualDocument, segmentOffsets: [], completedForNavigationRef: completedRef,
    pageScrollAnimatingRef: animationRef, contentRef, getActiveScrollNode: getNode,
    enforceScrollStepFloor: noop, syncScrollVirtualRange: noop, cancelPagedScrollAnimation: noop,
    onProgressChange: preparing ? undefined : onProgress, onPageIndexChange: preparing ? undefined : onPage,
  });
  return null;
}
async function render() {
  await harness.render(<Probe />);
  await harness.run(() => vi.advanceTimersByTime(150));
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  harness = mountBackNavigationHarness();
  Object.assign(window, {
    setTimeout, clearTimeout,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    getComputedStyle: () => ({ columnGap: "0", paddingLeft: "0", paddingRight: "0" }),
  });
  preparing = true;
  initialProgress = 0;
  layoutKey = "layout";
  completedRef.current = false;
  node = {
    clientHeight: 600, clientWidth: 400, scrollHeight: 600, scrollWidth: 2000,
    scrollTop: 0, scrollLeft: 0,
    scrollTo: vi.fn(function(this: HTMLDivElement, options: ScrollToOptions) {
      if (options.left !== undefined) this.scrollLeft = options.left;
      if (options.top !== undefined) this.scrollTop = options.top;
    }),
  } as unknown as HTMLDivElement;
  contentRef.current = node;
  onProgress.mockClear(); onPage.mockClear();
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
