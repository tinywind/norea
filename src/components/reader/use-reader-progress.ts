import type { RefObject } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type ReaderChapterScrollAnchor,
  type ReaderScrollAnchor,
} from "../../store/reader";
import { type PreparedReaderDocument } from "../reader-document";
import {
  clampProgress,
  getPageInfo,
  getProgress,
  isAtReadingEnd,
  scrollToProgress,
  type PageInfo,
} from "./reader-content-metrics";
import {
  captureReaderScrollAnchor,
  readerRestoreMediaSettled,
  readerScrollAnchorElement,
  readerScrollAnchorTop,
  startReaderRestoreSettle,
  type ReaderRestoreSettle,
} from "./reader-scroll-anchor";
interface ReaderInitialProgressRestore {
  contentKey: number | string | undefined;
  progress: number;
  anchor: ReaderScrollAnchor | null;
}

export type ReaderSavedScrollAnchor = Omit<
  ReaderChapterScrollAnchor,
  "novelId" | "savedAt"
>;
const PROGRESS_RENDER_DELTA = 0.1;
const PROGRESS_SAVE_DELAY_MS = 350;

interface ReaderProgressOptions {
  contentKey?: number | string;
  initialProgress: number;
  /** Scroll-mode position to reopen at; used when it matches the document. */
  initialScrollAnchor?: ReaderScrollAnchor | null;
  isPagedReader: boolean;
  layoutRestoreKey: string;
  virtualDocument: PreparedReaderDocument["virtualDocument"];
  segmentOffsets: readonly number[];
  completedForNavigationRef: RefObject<boolean>;
  pageScrollAnimatingRef: RefObject<boolean>;
  contentRef: RefObject<HTMLDivElement | null>;
  getActiveScrollNode: () => HTMLDivElement | null;
  enforceScrollStepFloor: () => void;
  syncScrollVirtualRange: (scrollTop: number, clientHeight: number) => void;
  cancelPagedScrollAnimation: () => void;
  onProgressChange?: (progress: number) => void;
  /** Receives the position saved with each progress save; `null` forgets it. */
  onScrollAnchorChange?: (anchor: ReaderSavedScrollAnchor | null) => void;
  onPageIndexChange?: (pageIndex: number) => void;
}
export function useReaderProgress({
  contentKey,
  initialProgress,
  initialScrollAnchor = null,
  isPagedReader,
  layoutRestoreKey,
  virtualDocument,
  segmentOffsets,
  completedForNavigationRef,
  pageScrollAnimatingRef,
  contentRef,
  getActiveScrollNode,
  enforceScrollStepFloor,
  syncScrollVirtualRange,
  cancelPagedScrollAnimation,
  onProgressChange,
  onScrollAnchorChange,
  onPageIndexChange,
}: ReaderProgressOptions) {
  const latestProgressRef = useRef(clampProgress(initialProgress));
  const renderedProgressRef = useRef(clampProgress(initialProgress));
  const lastSavedProgressRef = useRef(
    Math.round(clampProgress(initialProgress)),
  );
  const pendingProgressSaveRef = useRef<number | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const appliedInitialContentKeyRef = useRef<
    number | string | undefined | null
  >(null);
  const pendingInitialProgressRestoreRef =
    useRef<ReaderInitialProgressRestore | null>(null);
  const restoredLayoutKeyRef = useRef<string | null>(null);
  const scrollActivityVersionRef = useRef(0);
  const restoreSettleRef = useRef<ReaderRestoreSettle | null>(null);
  const scrollAnchorDirtyRef = useRef(false);
  const segmentOffsetsRef = useRef(segmentOffsets);
  useLayoutEffect(() => {
    segmentOffsetsRef.current = segmentOffsets;
  }, [segmentOffsets]);
  const [progress, setProgress] = useState(clampProgress(initialProgress));
  const setRenderedProgress = useCallback(
    (value: number, options: { force?: boolean } = {}) => {
      const nextProgress = clampProgress(value);
      const shouldCommit =
        options.force ||
        nextProgress <= 0 ||
        nextProgress >= 100 ||
        Math.abs(nextProgress - renderedProgressRef.current) >=
          PROGRESS_RENDER_DELTA;
      if (!shouldCommit) return;
      renderedProgressRef.current = nextProgress;
      setProgress(nextProgress);
    },
    [],
  );
  const [pageInfo, setPageInfo] = useState<PageInfo>({
    current: 1,
    total: 1,
  });
  const latestPageInfoRef = useRef<PageInfo>({ current: 1, total: 1 });
  const flushProgress = useCallback(
    (value: number) => {
      if (!onProgressChange) return;
      const rounded = Math.round(clampProgress(value));
      if (
        rounded >= 97 ||
        Math.abs(rounded - lastSavedProgressRef.current) >= 1
      ) {
        lastSavedProgressRef.current = rounded;
        onProgressChange(rounded);
      }
    },
    [onProgressChange],
  );

  const persistScrollAnchor = useCallback(() => {
    if (!onScrollAnchorChange || !scrollAnchorDirtyRef.current) return;
    if (restoreSettleRef.current?.active) return;
    scrollAnchorDirtyRef.current = false;
    if (isPagedReader) {
      onScrollAnchorChange(null);
      return;
    }
    const node = getActiveScrollNode();
    const content = contentRef.current;
    const anchor = node && content ? captureReaderScrollAnchor(node, content) : null;
    onScrollAnchorChange(
      anchor
        ? {
            ...anchor,
            segmentCount: virtualDocument.segments.length,
            progress: lastSavedProgressRef.current,
          }
        : null,
    );
  }, [
    getActiveScrollNode,
    isPagedReader,
    onScrollAnchorChange,
    virtualDocument.segments.length,
  ]);

  const scheduleProgressSave = useCallback(
    (value: number) => {
      const rounded = Math.round(clampProgress(value));
      if (
        progressTimerRef.current !== null &&
        pendingProgressSaveRef.current === rounded
      ) {
        return;
      }
      pendingProgressSaveRef.current = rounded;
      if (progressTimerRef.current !== null) {
        window.clearTimeout(progressTimerRef.current);
      }
      progressTimerRef.current = window.setTimeout(() => {
        pendingProgressSaveRef.current = null;
        flushProgress(value);
        persistScrollAnchor();
        progressTimerRef.current = null;
      }, PROGRESS_SAVE_DELAY_MS);
    },
    [flushProgress, persistScrollAnchor],
  );

  const applyPageInfo = useCallback(
    (nextPageInfo: PageInfo) => {
      const current = latestPageInfoRef.current;
      if (
        current.current === nextPageInfo.current &&
        current.total === nextPageInfo.total
      ) {
        return;
      }
      latestPageInfoRef.current = nextPageInfo;
      setPageInfo(nextPageInfo);
      onPageIndexChange?.(nextPageInfo.current);
    },
    [onPageIndexChange],
  );

  const restoreProgressPosition = useCallback(
    (value: number) => {
      const node = getActiveScrollNode();
      if (!node) return;
      if (isPagedReader) {
        scrollToProgress(node, value, true, "auto");
        if (!completedForNavigationRef.current) {
          const restoredProgress = clampProgress(getProgress(node, true));
          latestProgressRef.current = restoredProgress;
          setRenderedProgress(restoredProgress, { force: true });
        }
        applyPageInfo(getPageInfo(node, true));
        return;
      }
      scrollToProgress(node, value, false, "auto");
      syncScrollVirtualRange(node.scrollTop, node.clientHeight);
      if (!completedForNavigationRef.current) {
        const restoredProgress = clampProgress(getProgress(node, false));
        latestProgressRef.current = restoredProgress;
        setRenderedProgress(restoredProgress, { force: true });
      }
      applyPageInfo(getPageInfo(node, false));
    },
    [
      applyPageInfo,
      getActiveScrollNode,
      isPagedReader,
      setRenderedProgress,
      syncScrollVirtualRange,
    ],
  );
  const restoreProgressPositionRef = useRef(restoreProgressPosition);

  useEffect(() => {
    restoreProgressPositionRef.current = restoreProgressPosition;
  }, [restoreProgressPosition]);

  const startRestoreSettle = useCallback(
    (
      node: HTMLDivElement,
      content: HTMLDivElement,
      anchor: ReaderScrollAnchor | null,
      progressToRestore: number,
    ) => {
      restoreSettleRef.current?.cancel();
      restoreSettleRef.current = startReaderRestoreSettle({
        node,
        content,
        targetTop: anchor
          ? () =>
              readerScrollAnchorTop(
                node,
                content,
                anchor,
                segmentOffsetsRef.current,
              )
          : () =>
              (Math.max(0, node.scrollHeight - node.clientHeight) *
                clampProgress(progressToRestore)) /
              100,
        isSettled: () => {
          if (!anchor) return readerRestoreMediaSettled(content, null);
          const target = readerScrollAnchorElement(content, anchor);
          return target
            ? readerRestoreMediaSettled(
                content,
                target.element.getBoundingClientRect().top,
              )
            : false;
        },
        onApply: () => {
          syncScrollVirtualRange(node.scrollTop, node.clientHeight);
          if (!completedForNavigationRef.current) {
            setRenderedProgress(getProgress(node, false), { force: true });
          }
          applyPageInfo(getPageInfo(node, false));
        },
        onEnd: (reason) => {
          if (reason !== "settled" && reason !== "timeout") return;
          if (completedForNavigationRef.current) return;
          latestProgressRef.current = clampProgress(getProgress(node, false));
          scrollAnchorDirtyRef.current = true;
        },
      });
    },
    [applyPageInfo, setRenderedProgress, syncScrollVirtualRange],
  );
  const startRestoreSettleRef = useRef(startRestoreSettle);

  useEffect(() => {
    startRestoreSettleRef.current = startRestoreSettle;
  }, [startRestoreSettle]);

  const updateProgressFromScroll = useCallback(() => {
    const node = getActiveScrollNode();
    if (!node) return;
    if (completedForNavigationRef.current) return;
    if (isPagedReader && pageScrollAnimatingRef.current) return;
    const restoreSettle = restoreSettleRef.current;
    restoreSettle?.noteScroll();
    if (restoreSettle?.active) {
      // The restore moved the page or content above it changed size; neither is reading.
      syncScrollVirtualRange(node.scrollTop, node.clientHeight);
      setRenderedProgress(getProgress(node, false));
      applyPageInfo(getPageInfo(node, false));
      return;
    }
    if (!isPagedReader) {
      enforceScrollStepFloor();
    }
    scrollActivityVersionRef.current += 1;
    scrollAnchorDirtyRef.current = true;
    if (pendingInitialProgressRestoreRef.current?.contentKey === contentKey) {
      pendingInitialProgressRestoreRef.current = null;
    }
    if (!isPagedReader) {
      syncScrollVirtualRange(node.scrollTop, node.clientHeight);
    }
    const nextProgress = clampProgress(getProgress(node, isPagedReader));
    latestProgressRef.current = nextProgress;
    setRenderedProgress(nextProgress);
    applyPageInfo(getPageInfo(node, isPagedReader));
    scheduleProgressSave(nextProgress);
  }, [
    applyPageInfo,
    contentKey,
    enforceScrollStepFloor,
    getActiveScrollNode,
    isPagedReader,
    scheduleProgressSave,
    setRenderedProgress,
    syncScrollVirtualRange,
  ]);

  useEffect(() => {
    if (appliedInitialContentKeyRef.current === contentKey) return;
    appliedInitialContentKeyRef.current = contentKey;
    const nextProgress = clampProgress(initialProgress);
    pendingInitialProgressRestoreRef.current = {
      contentKey,
      progress: nextProgress,
      anchor:
        initialScrollAnchor?.segmentCount === virtualDocument.segments.length
          ? initialScrollAnchor
          : null,
    };
    restoreSettleRef.current?.cancel();
    scrollAnchorDirtyRef.current = false;
    latestPageInfoRef.current = { current: -1, total: -1 };
    latestProgressRef.current = nextProgress;
    setRenderedProgress(nextProgress, { force: true });
    lastSavedProgressRef.current = Math.round(nextProgress);
    if (nextProgress < 97) {
      completedForNavigationRef.current = false;
    }
  }, [
    contentKey,
    initialProgress,
    initialScrollAnchor,
    setRenderedProgress,
    virtualDocument.segments.length,
  ]);

  useEffect(() => {
    restoredLayoutKeyRef.current = null;
  }, [virtualDocument]);

  useEffect(() => {
    const node = getActiveScrollNode();
    if (!node) return;
    if (restoredLayoutKeyRef.current === layoutRestoreKey) return;
    restoredLayoutKeyRef.current = layoutRestoreKey;
    if (restoreSettleRef.current?.active) {
      // A running scroll-mode restore follows layout changes by itself.
      if (!isPagedReader) return;
      restoreSettleRef.current.cancel();
    }
    const pendingInitialProgress = pendingInitialProgressRestoreRef.current;
    const isInitialRestore = pendingInitialProgress?.contentKey === contentKey;
    const progressToRestore =
      pendingInitialProgress && isInitialRestore
        ? pendingInitialProgress.progress
        : latestProgressRef.current;
    const content = contentRef.current;
    if (
      pendingInitialProgress &&
      isInitialRestore &&
      !isPagedReader &&
      content &&
      (pendingInitialProgress.anchor || progressToRestore > 0)
    ) {
      pendingInitialProgressRestoreRef.current = null;
      startRestoreSettleRef.current(
        node,
        content,
        pendingInitialProgress.anchor,
        progressToRestore,
      );
      return;
    }
    const restoreActivityVersion = scrollActivityVersionRef.current;
    let disposed = false;
    const restore = () => {
      if (disposed) return;
      if (scrollActivityVersionRef.current !== restoreActivityVersion) return;
      restoreProgressPositionRef.current(progressToRestore);
      if (pendingInitialProgressRestoreRef.current?.contentKey === contentKey) {
        pendingInitialProgressRestoreRef.current = null;
      }
    };
    const frame = window.requestAnimationFrame(restore);
    const timeout = window.setTimeout(restore, 120);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [
    contentKey,
    getActiveScrollNode,
    isPagedReader,
    layoutRestoreKey,
    virtualDocument,
  ]);

  useEffect(
    () => () => {
      if (progressTimerRef.current !== null) {
        window.clearTimeout(progressTimerRef.current);
      }
      pendingProgressSaveRef.current = null;
      cancelPagedScrollAnimation();
      flushProgress(latestProgressRef.current);
    },
    [cancelPagedScrollAnimation, flushProgress],
  );

  const persistOnUnmountRef = useRef(() => {});
  useLayoutEffect(() => {
    persistOnUnmountRef.current = () => {
      if (!scrollAnchorDirtyRef.current) return;
      flushProgress(latestProgressRef.current);
      persistScrollAnchor();
    };
  }, [flushProgress, persistScrollAnchor]);
  // Layout cleanup still sees the mounted content, which the anchor is measured from.
  useLayoutEffect(() => () => persistOnUnmountRef.current(), []);

  const seekToProgress = useCallback(
    (value: number) => {
      const node = getActiveScrollNode();
      if (!node) return;
      restoreSettleRef.current?.cancel();
      scrollAnchorDirtyRef.current = true;
      const clamped = clampProgress(value);
      if (clamped < 97) {
        completedForNavigationRef.current = false;
      }
      if (isPagedReader) {
        scrollToProgress(node, clamped, true, "auto");
        const nextProgress = clampProgress(getProgress(node, true));
        latestProgressRef.current = nextProgress;
        setRenderedProgress(nextProgress, { force: true });
        applyPageInfo(getPageInfo(node, true));
        scheduleProgressSave(nextProgress);
        return;
      }
      scrollToProgress(node, clamped, false, "auto");
      syncScrollVirtualRange(node.scrollTop, node.clientHeight);
      const nextProgress = clampProgress(getProgress(node, false));
      latestProgressRef.current = nextProgress;
      setRenderedProgress(nextProgress, { force: true });
      applyPageInfo(getPageInfo(node, false));
      scheduleProgressSave(nextProgress);
    },
    [
      applyPageInfo,
      getActiveScrollNode,
      isPagedReader,
      scheduleProgressSave,
      setRenderedProgress,
      syncScrollVirtualRange,
    ],
  );

  const commitSeekProgress = useCallback(() => {
    flushProgress(latestProgressRef.current);
    persistScrollAnchor();
  }, [flushProgress, persistScrollAnchor]);

  const completeIfAtEnd = useCallback(() => {
    const node = getActiveScrollNode();
    if (!node || !isAtReadingEnd(node, isPagedReader)) return false;
    completedForNavigationRef.current = true;
    latestProgressRef.current = 100;
    setRenderedProgress(100, { force: true });
    if (progressTimerRef.current !== null) {
      window.clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    pendingProgressSaveRef.current = null;
    restoreSettleRef.current?.cancel();
    flushProgress(100);
    scrollAnchorDirtyRef.current = true;
    persistScrollAnchor();
    return true;
  }, [
    flushProgress,
    getActiveScrollNode,
    isPagedReader,
    persistScrollAnchor,
    setRenderedProgress,
  ]);

  return {
    progress,
    pageInfo,
    updateProgressFromScroll,
    completeIfAtEnd,
    seekToProgress,
    commitSeekProgress,
  };
}
