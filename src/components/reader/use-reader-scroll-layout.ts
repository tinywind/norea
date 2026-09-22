import type { RefObject } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { READER_PAGE_TRANSITION_DURATION_DEFAULT_MS } from "../../store/reader";
import {
  READER_SEGMENT_INDEX_ATTRIBUTE,
  type PreparedReaderDocument,
} from "../reader-document";
import {
  prefixSegmentHeights,
  shouldVirtualizeReaderScroll,
  virtualRangeForScroll,
} from "../reader-virtualization";
import { readerVirtualSegmentHasMedia } from "./reader-content-media";
import {
  dispatchReaderScrollEvent,
  easeOutCubic,
  getPagedLeft,
  getPagedPageCount,
  getPagedPageIndex,
  getReaderDebugSnapshot,
  logReaderInput,
  PAGED_SCROLL_COMPLETION_BUFFER_MS,
  SCROLL_PAGE_FRACTION,
  virtualScrollAnchorDelta,
} from "./reader-content-metrics";
interface ReaderViewportSize {
  width: number;
  height: number;
}

const READER_SCROLL_OVERSCAN_PX = 1800;

interface ReaderScrollLayoutOptions {
  viewportRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  isPagedReader: boolean;
  pageTransitionDuration: number;
  virtualDocument: PreparedReaderDocument["virtualDocument"];
  completedForNavigationRef: RefObject<boolean>;
  onBoundaryPage?: (direction: 1 | -1) => void;
}
export function useReaderScrollLayout({
  viewportRef,
  contentRef,
  isPagedReader,
  pageTransitionDuration,
  virtualDocument,
  completedForNavigationRef,
  onBoundaryPage,
}: ReaderScrollLayoutOptions) {
  const pageScrollCompletionTimerRef = useRef<number | null>(null);
  const pageScrollCompletionFrameRef = useRef<number | null>(null);
  const pageScrollAnimatingRef = useRef(false);
  const nativeWheelActionLockedUntilRef = useRef(0);
  const pendingVirtualScrollAdjustmentRef = useRef(0);
  const scrollStepFloorRef = useRef<{ expiresAt: number; top: number } | null>(
    null,
  );
  const [viewportSize, setViewportSize] = useState<ReaderViewportSize>({
    width: 0,
    height: 0,
  });
  const [segmentHeights, setSegmentHeights] = useState<number[]>([]);
  const segmentHeightsRef = useRef<number[]>([]);
  const [virtualRange, setVirtualRange] = useState({ start: 0, end: -1 });
  const hasMediaSegments = useMemo(
    () => virtualDocument.segments.some(readerVirtualSegmentHasMedia),
    [virtualDocument.segments],
  );
  const shouldVirtualizeScrollContent = shouldVirtualizeReaderScroll({
    hasMediaSegments,
    isPagedReader,
  });
  const activeVirtualRangeStart = shouldVirtualizeScrollContent
    ? virtualRange.start
    : 0;
  const activeVirtualRangeEnd = shouldVirtualizeScrollContent
    ? virtualRange.end
    : -1;
  const getActiveScrollNode = useCallback(
    () => (isPagedReader ? contentRef.current : viewportRef.current),
    [isPagedReader],
  );
  const effectiveSegmentHeights = useMemo(
    () =>
      virtualDocument.segments.map(
        (segment) => segmentHeights[segment.index] ?? segment.estimatedHeight,
      ),
    [segmentHeights, virtualDocument.segments],
  );
  const segmentOffsets = useMemo(
    () => prefixSegmentHeights(effectiveSegmentHeights),
    [effectiveSegmentHeights],
  );
  const virtualContentHeight = segmentOffsets[segmentOffsets.length - 1] ?? 0;

  useEffect(() => {
    segmentHeightsRef.current = segmentHeights;
  }, [segmentHeights]);

  const cancelPagedScrollAnimation = useCallback(() => {
    if (pageScrollCompletionTimerRef.current !== null) {
      window.clearTimeout(pageScrollCompletionTimerRef.current);
      pageScrollCompletionTimerRef.current = null;
    }
    if (pageScrollCompletionFrameRef.current !== null) {
      window.cancelAnimationFrame(pageScrollCompletionFrameRef.current);
      pageScrollCompletionFrameRef.current = null;
    }
    pageScrollAnimatingRef.current = false;
  }, []);

  const enforceScrollStepFloor = useCallback(() => {
    const floor = scrollStepFloorRef.current;
    if (!floor) return;
    if (performance.now() > floor.expiresAt) {
      scrollStepFloorRef.current = null;
      return;
    }
    const node = viewportRef.current;
    if (!node) return;
    const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
    const targetTop = Math.min(floor.top, maxTop);
    if (node.scrollTop + 1 < targetTop) {
      node.scrollTop = targetTop;
    }
  }, []);

  useLayoutEffect(() => {
    if (!shouldVirtualizeScrollContent) {
      pendingVirtualScrollAdjustmentRef.current = 0;
      if (!isPagedReader) enforceScrollStepFloor();
      return;
    }
    const adjustment = pendingVirtualScrollAdjustmentRef.current;
    pendingVirtualScrollAdjustmentRef.current = 0;
    if (Math.abs(adjustment) < 0.5) {
      enforceScrollStepFloor();
      return;
    }
    const node = viewportRef.current;
    if (!node) return;
    const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
    node.scrollTop = Math.max(0, Math.min(maxTop, node.scrollTop + adjustment));
    enforceScrollStepFloor();
  }, [
    enforceScrollStepFloor,
    isPagedReader,
    segmentOffsets,
    shouldVirtualizeScrollContent,
  ]);

  const syncScrollVirtualRange = useCallback(
    (scrollTop: number, clientHeight: number) => {
      if (!shouldVirtualizeScrollContent) return;
      const nextRange = virtualRangeForScroll(
        scrollTop,
        clientHeight,
        segmentOffsets,
        READER_SCROLL_OVERSCAN_PX,
      );
      setVirtualRange((current) =>
        current.start === nextRange.start && current.end === nextRange.end
          ? current
          : nextRange,
      );
    },
    [segmentOffsets, shouldVirtualizeScrollContent],
  );

  const scrollPagedTo = useCallback(
    (targetLeft: number) => {
      const node = getActiveScrollNode();
      if (!node) return;
      cancelPagedScrollAnimation();
      pageScrollAnimatingRef.current = true;
      const startLeft = node.scrollLeft;
      const distance = targetLeft - startLeft;
      logReaderInput("page-scroll-start", () => ({
        startLeft: Math.round(startLeft),
        targetLeft: Math.round(targetLeft),
        distance: Math.round(distance),
        snapshot: getReaderDebugSnapshot(node),
      }));
      if (Math.abs(distance) <= 1) {
        node.scrollTo({ left: targetLeft, behavior: "auto" });
        pageScrollAnimatingRef.current = false;
        dispatchReaderScrollEvent(node);
        logReaderInput("page-scroll-complete", () => ({
          targetLeft: Math.round(targetLeft),
          snapshot: getReaderDebugSnapshot(node),
        }));
        return;
      }

      const duration = Math.max(
        0,
        Math.round(
          pageTransitionDuration ?? READER_PAGE_TRANSITION_DURATION_DEFAULT_MS,
        ),
      );
      if (duration <= 0) {
        node.scrollTo({ left: targetLeft, behavior: "auto" });
        pageScrollAnimatingRef.current = false;
        dispatchReaderScrollEvent(node);
        logReaderInput("page-scroll-complete", () => ({
          targetLeft: Math.round(targetLeft),
          snapshot: getReaderDebugSnapshot(node),
        }));
        return;
      }

      const startedAt = performance.now();
      const step = (now: number) => {
        const elapsed = now - startedAt;
        const progress = Math.min(1, elapsed / duration);
        node.scrollLeft = startLeft + distance * easeOutCubic(progress);
        if (progress < 1) {
          pageScrollCompletionFrameRef.current =
            window.requestAnimationFrame(step);
          return;
        }

        pageScrollAnimatingRef.current = false;
        pageScrollCompletionFrameRef.current = null;
        pageScrollCompletionTimerRef.current = window.setTimeout(() => {
          pageScrollCompletionTimerRef.current = null;
          dispatchReaderScrollEvent(node);
          logReaderInput("page-scroll-complete", () => ({
            targetLeft: Math.round(targetLeft),
            snapshot: getReaderDebugSnapshot(node),
          }));
        }, PAGED_SCROLL_COMPLETION_BUFFER_MS);
      };

      pageScrollCompletionFrameRef.current = window.requestAnimationFrame(step);
    },
    [cancelPagedScrollAnimation, pageTransitionDuration, getActiveScrollNode],
  );

  const scrollByPage = useCallback(
    (direction: 1 | -1, source = "imperative") => {
      const node = getActiveScrollNode();
      if (!node) return;
      if (direction === -1) {
        completedForNavigationRef.current = false;
      }
      if (isPagedReader) {
        const currentPage = getPagedPageIndex(node);
        const targetPage = currentPage + direction;
        logReaderInput("page-step-request", () => ({
          source,
          direction,
          mode: "paged",
          currentPage,
          targetPage,
          snapshot: getReaderDebugSnapshot(node),
        }));
        if (targetPage < 1 || targetPage > getPagedPageCount(node)) {
          logReaderInput("page-step-boundary", () => ({
            source,
            direction,
            snapshot: getReaderDebugSnapshot(node),
          }));
          onBoundaryPage?.(direction);
          return;
        }
        scrollPagedTo(getPagedLeft(node, targetPage));
        return;
      }
      if (performance.now() < nativeWheelActionLockedUntilRef.current) {
        logReaderInput("page-step-suppressed", () => ({
          source,
          direction,
          reason: "native-wheel-active",
          snapshot: getReaderDebugSnapshot(node),
        }));
        return;
      }
      const axisMax = node.scrollHeight - node.clientHeight;
      const current = node.scrollTop;
      logReaderInput("page-step-request", () => ({
        source,
        direction,
        mode: "scroll",
        axisMax: Math.round(axisMax),
        snapshot: getReaderDebugSnapshot(node),
      }));
      if (
        (direction === 1 && current >= axisMax - 2) ||
        (direction === -1 && current <= 2)
      ) {
        logReaderInput("page-step-boundary", () => ({
          source,
          direction,
          snapshot: getReaderDebugSnapshot(node),
        }));
        onBoundaryPage?.(direction);
        return;
      }
      const amount = node.clientHeight * SCROLL_PAGE_FRACTION;
      const targetTop = Math.max(
        0,
        Math.min(axisMax, current + amount * direction),
      );
      logReaderInput("page-step-scroll", () => ({
        source,
        direction,
        amount: Math.round(amount),
        targetTop: Math.round(targetTop),
        snapshot: getReaderDebugSnapshot(node),
      }));
      node.scrollTo({ top: targetTop, behavior: "auto" });
      syncScrollVirtualRange(targetTop, node.clientHeight);
      if (direction === 1) {
        scrollStepFloorRef.current = {
          expiresAt: performance.now() + 250,
          top: targetTop,
        };
        window.requestAnimationFrame(enforceScrollStepFloor);
      } else {
        scrollStepFloorRef.current = null;
      }
    },
    [
      enforceScrollStepFloor,
      isPagedReader,
      onBoundaryPage,
      getActiveScrollNode,
      scrollPagedTo,
      syncScrollVirtualRange,
    ],
  );

  useEffect(() => {
    segmentHeightsRef.current = [];
    pendingVirtualScrollAdjustmentRef.current = 0;
    setSegmentHeights([]);
    setVirtualRange({ start: 0, end: -1 });
  }, [virtualDocument]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const syncViewportSize = () => {
      const next = {
        width: node.clientWidth,
        height: node.clientHeight,
      };
      setViewportSize((current) =>
        current.width === next.width && current.height === next.height
          ? current
          : next,
      );
    };
    syncViewportSize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      syncViewportSize();
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [isPagedReader, viewportRef, virtualDocument]);

  useEffect(() => {
    if (!shouldVirtualizeScrollContent) return;
    const content = contentRef.current;
    if (!content) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const scrollNode = viewportRef.current;
      const scrollTop = scrollNode?.scrollTop ?? 0;
      const measurements = [
        ...content.querySelectorAll<HTMLElement>(
          `[${READER_SEGMENT_INDEX_ATTRIBUTE}]`,
        ),
      ].map((element) => {
        const index = Number.parseInt(
          element.getAttribute(READER_SEGMENT_INDEX_ATTRIBUTE) ?? "",
          10,
        );
        if (!Number.isFinite(index) || index < 0) return null;
        const style = window.getComputedStyle(element);
        const marginTop = Number.parseFloat(style.marginTop) || 0;
        const marginBottom = Number.parseFloat(style.marginBottom) || 0;
        const height = Math.ceil(
          element.getBoundingClientRect().height + marginTop + marginBottom,
        );
        return height > 0 ? { height, index } : null;
      });
      const currentHeights = segmentHeightsRef.current;
      const nextHeights = [...currentHeights];
      let changed = false;
      for (const measurement of measurements) {
        if (
          !measurement ||
          nextHeights[measurement.index] === measurement.height
        ) {
          continue;
        }
        nextHeights[measurement.index] = measurement.height;
        changed = true;
      }
      if (!changed) return;

      if (scrollNode) {
        const currentEffectiveHeights = virtualDocument.segments.map(
          (segment) => currentHeights[segment.index] ?? segment.estimatedHeight,
        );
        const nextEffectiveHeights = virtualDocument.segments.map(
          (segment) => nextHeights[segment.index] ?? segment.estimatedHeight,
        );
        const currentOffsets = prefixSegmentHeights(currentEffectiveHeights);
        const nextOffsets = prefixSegmentHeights(nextEffectiveHeights);
        const adjustment = virtualScrollAnchorDelta(
          scrollTop,
          currentOffsets,
          nextOffsets,
        );
        if (adjustment >= 0.5) {
          pendingVirtualScrollAdjustmentRef.current += adjustment;
        }
      }

      segmentHeightsRef.current = nextHeights;
      setSegmentHeights(nextHeights);
    };
    const scheduleMeasure = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(measure);
    };

    scheduleMeasure();
    if (typeof ResizeObserver === "undefined") {
      return () => {
        if (frame !== 0) window.cancelAnimationFrame(frame);
      };
    }
    const observer = new ResizeObserver(scheduleMeasure);
    for (const element of content.querySelectorAll<HTMLElement>(
      `[${READER_SEGMENT_INDEX_ATTRIBUTE}]`,
    )) {
      observer.observe(element);
    }
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [
    activeVirtualRangeEnd,
    activeVirtualRangeStart,
    shouldVirtualizeScrollContent,
    viewportSize.width,
    virtualDocument.segments,
  ]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node || !shouldVirtualizeScrollContent) return;
    syncScrollVirtualRange(node.scrollTop, node.clientHeight);
  }, [
    shouldVirtualizeScrollContent,
    syncScrollVirtualRange,
    viewportSize.height,
  ]);

  return {
    viewportSize,
    activeVirtualRangeStart,
    activeVirtualRangeEnd,
    shouldVirtualizeScrollContent,
    segmentOffsets,
    virtualContentHeight,
    getActiveScrollNode,
    pageScrollAnimatingRef,
    nativeWheelActionLockedUntilRef,
    cancelPagedScrollAnimation,
    enforceScrollStepFloor,
    syncScrollVirtualRange,
    scrollByPage,
  };
}
