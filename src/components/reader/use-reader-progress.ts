import type { RefObject } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  registerBeforeAppSuspend,
  subscribeAppLifecycle,
} from "../../lib/app-lifecycle";
import { setPendingReaderProgress } from "../../lib/tasks/sync-runtime";
import {
  type ReaderChapterScrollAnchor,
  type ReaderScrollAnchor,
} from "../../store/reader";
import { type PreparedReaderDocument } from "../reader-document";
import { hasPendingReaderMedia } from "./reader-content-media";
import {
  clampProgress,
  getPageInfo,
  getPagedPageCount,
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
  preparing?: boolean;
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
  preparing = false,
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
  const hasPendingProgressSaveRef = useRef(false);
  const preparationPositionRef = useRef({ preparing, progress: initialProgress, anchor: initialScrollAnchor });
  const appliedInitialContentKeyRef = useRef<
    number | string | undefined | null
  >(null);
  const pendingInitialProgressRestoreRef =
    useRef<ReaderInitialProgressRestore | null>(null);
  const restoredLayoutKeyRef = useRef<string | null>(null);
  const scrollActivityVersionRef = useRef(0);
  const restoreSettleRef = useRef<ReaderRestoreSettle | null>(null);
  const scrollAnchorDirtyRef = useRef(false);
  const suppressProgrammaticResetScrollRef = useRef(false);
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

  const setOwnedPendingReaderProgress = useCallback((pending: boolean) => {
    if (pending) {
      hasPendingProgressSaveRef.current = true;
      setPendingReaderProgress(true);
      return;
    }
    if (!hasPendingProgressSaveRef.current) return;
    hasPendingProgressSaveRef.current = false;
    setPendingReaderProgress(false);
  }, []);

  const scheduleProgressSave = useCallback(
    (value: number) => {
      if (preparing || (!onProgressChange && !onScrollAnchorChange)) return;
      const rounded = Math.round(clampProgress(value));
      if (
        progressTimerRef.current !== null &&
        pendingProgressSaveRef.current === rounded
      ) {
        return;
      }
      pendingProgressSaveRef.current = rounded;
      setOwnedPendingReaderProgress(true);
      if (progressTimerRef.current !== null) {
        window.clearTimeout(progressTimerRef.current);
      }
      progressTimerRef.current = window.setTimeout(() => {
        pendingProgressSaveRef.current = null;
        flushProgress(value);
        persistScrollAnchor();
        progressTimerRef.current = null;
        setOwnedPendingReaderProgress(false);
      }, PROGRESS_SAVE_DELAY_MS);
    },
    [
      flushProgress,
      onProgressChange,
      onScrollAnchorChange,
      persistScrollAnchor,
      preparing,
      setOwnedPendingReaderProgress,
    ],
  );

  useEffect(() => {
    if (preparing) return;
    const persistBeforeSuspension = () => {
      if (progressTimerRef.current !== null) {
        window.clearTimeout(progressTimerRef.current);
        progressTimerRef.current = null;
      }
      pendingProgressSaveRef.current = null;
      flushProgress(latestProgressRef.current);
      persistScrollAnchor();
      setOwnedPendingReaderProgress(false);
    };
    const unsubscribeLifecycle = subscribeAppLifecycle((active) => {
      if (!active) persistBeforeSuspension();
    });
    const unregisterSuspend = registerBeforeAppSuspend(
      persistBeforeSuspension,
      "flush",
    );
    window.addEventListener("pagehide", persistBeforeSuspension);
    return () => {
      unsubscribeLifecycle();
      unregisterSuspend();
      window.removeEventListener("pagehide", persistBeforeSuspension);
      setOwnedPendingReaderProgress(false);
    };
  }, [
    flushProgress,
    persistScrollAnchor,
    preparing,
    setOwnedPendingReaderProgress,
  ]);

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
      const targetProgress = clampProgress(value);
      if (isPagedReader) {
        scrollToProgress(node, targetProgress, true, "auto");
        if (!completedForNavigationRef.current) {
          const restoredProgress =
            node.clientWidth <= 0 || getPagedPageCount(node) <= 1
              ? targetProgress
              : clampProgress(getProgress(node, true));
          latestProgressRef.current = restoredProgress;
          setRenderedProgress(restoredProgress, { force: true });
        }
        applyPageInfo(getPageInfo(node, true));
        return;
      }
      scrollToProgress(node, targetProgress, false, "auto");
      syncScrollVirtualRange(node.scrollTop, node.clientHeight);
      if (!completedForNavigationRef.current) {
        const hasScrollableHeight =
          node.clientHeight > 0 && node.scrollHeight - node.clientHeight > 0;
        const restoredProgress = hasScrollableHeight
          ? clampProgress(getProgress(node, false))
          : targetProgress;
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
          if (node.clientHeight <= 0) return false;
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
            const hasScrollableHeight =
              node.clientHeight > 0 && node.scrollHeight - node.clientHeight > 0;
            const nextProgress = hasScrollableHeight
              ? clampProgress(getProgress(node, false))
              : clampProgress(progressToRestore);
            setRenderedProgress(nextProgress, { force: true });
          }
          applyPageInfo(getPageInfo(node, false));
        },
        onEnd: (reason) => {
          if (reason !== "settled" && reason !== "timeout") return;
          if (completedForNavigationRef.current) return;
          const hasScrollableHeight =
            node.clientHeight > 0 && node.scrollHeight - node.clientHeight > 0;
          latestProgressRef.current = hasScrollableHeight
            ? clampProgress(getProgress(node, false))
            : clampProgress(progressToRestore);
          if (hasScrollableHeight) {
            scrollAnchorDirtyRef.current = true;
          }
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
    if (preparing) return;
    const node = getActiveScrollNode();
    if (!node) return;
    if (completedForNavigationRef.current) return;
    if (isPagedReader && pageScrollAnimatingRef.current) return;
    const restoreSettle = restoreSettleRef.current;
    restoreSettle?.noteScroll();
    if (restoreSettle?.active) {
      // The restore moved the page or content above it changed size; neither is reading.
      syncScrollVirtualRange(node.scrollTop, node.clientHeight);
      if (node.clientHeight > 0 && node.scrollHeight - node.clientHeight > 0) {
        setRenderedProgress(getProgress(node, false));
      }
      applyPageInfo(getPageInfo(node, false));
      return;
    }
    if (isPagedReader) {
      if (node.clientWidth <= 0) {
        return;
      }
    } else {
      if (node.clientHeight <= 0 || node.scrollHeight - node.clientHeight <= 0) {
        // Ignore scroll-clamp events when the viewport is not scrollable (e.g. unloaded images).
        return;
      }
      enforceScrollStepFloor();
    }
    if (suppressProgrammaticResetScrollRef.current) {
      suppressProgrammaticResetScrollRef.current = false;
      const atResetOrigin = isPagedReader
        ? node.scrollLeft <= 2
        : node.scrollTop <= 2;
      if (atResetOrigin) {
        if (!isPagedReader) {
          syncScrollVirtualRange(node.scrollTop, node.clientHeight);
        }
        applyPageInfo(getPageInfo(node, isPagedReader));
        return;
      }
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
    preparing,
    scheduleProgressSave,
    setRenderedProgress,
    syncScrollVirtualRange,
  ]);

  useLayoutEffect(() => {
    const previous = preparationPositionRef.current;
    const preparationChanged = previous.preparing !== preparing;
    preparationPositionRef.current = { preparing, progress: initialProgress, anchor: initialScrollAnchor };
    const nextProgress = clampProgress(initialProgress);
    const activeNode = getActiveScrollNode();
    const driftedScrollOffset =
      preparationChanged &&
      !preparing &&
      nextProgress === 0 &&
      !initialScrollAnchor &&
      activeNode !== null &&
      (isPagedReader ? activeNode.scrollLeft > 0 : activeNode.scrollTop > 0);
    const preparedPositionDrifted =
      preparationChanged &&
      !preparing &&
      (latestProgressRef.current !== nextProgress || driftedScrollOffset);
    const deferredScrollSettle =
      preparationChanged &&
      !preparing &&
      !isPagedReader &&
      (nextProgress > 0 || Boolean(initialScrollAnchor));
    const restorePreparedPosition =
      preparationChanged &&
      (preparing ||
        previous.progress !== initialProgress ||
        previous.anchor !== initialScrollAnchor ||
        preparedPositionDrifted ||
        deferredScrollSettle);
    if (driftedScrollOffset && activeNode) {
      suppressProgrammaticResetScrollRef.current = true;
      activeNode.scrollTo(
        isPagedReader
          ? { left: 0, behavior: "auto" }
          : { top: 0, behavior: "auto" },
      );
    } else if (preparationChanged || appliedInitialContentKeyRef.current !== contentKey) {
      suppressProgrammaticResetScrollRef.current = false;
    }
    if (preparationChanged && !preparing) {
      scrollAnchorDirtyRef.current = false;
      if (nextProgress < 97) {
        completedForNavigationRef.current = false;
      }
    }
    if (appliedInitialContentKeyRef.current === contentKey && !restorePreparedPosition) return;
    appliedInitialContentKeyRef.current = contentKey;
    restoredLayoutKeyRef.current = null;
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
    getActiveScrollNode,
    initialProgress,
    initialScrollAnchor,
    isPagedReader,
    preparing,
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
      !preparing &&
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
    let completed = false;
    let frame: number | null = null;
    let timeout: number | null = null;
    const cancelPending = () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
        frame = null;
      }
      if (timeout !== null) {
        window.clearTimeout(timeout);
        timeout = null;
      }
    };
    const restore = (trigger: "frame" | "timeout") => {
      if (trigger === "frame") {
        frame = null;
      } else {
        timeout = null;
      }
      if (disposed) return;
      if (scrollActivityVersionRef.current !== restoreActivityVersion) {
        disposed = true;
        completed = true;
        suppressProgrammaticResetScrollRef.current = false;
        cancelPending();
        return;
      }
      const activeNode = getActiveScrollNode();
      const viewportMeasured =
        activeNode !== null &&
        (isPagedReader ? activeNode.clientWidth > 0 : activeNode.clientHeight > 0);
      if (!viewportMeasured) {
        if (trigger === "frame" && timeout !== null) {
          // Wait for the fallback timeout if layout has not measured on the first frame.
          return;
        }
        disposed = true;
        cancelPending();
        if (restoredLayoutKeyRef.current === layoutRestoreKey) {
          restoredLayoutKeyRef.current = null;
        }
        return;
      }
      disposed = true;
      completed = true;
      cancelPending();
      restoreProgressPositionRef.current(progressToRestore);
      suppressProgrammaticResetScrollRef.current = false;
      const scrollSettleDeferredWhilePreparing =
        preparing &&
        !isPagedReader &&
        (Boolean(pendingInitialProgressRestoreRef.current?.anchor) ||
          progressToRestore > 0);
      if (
        !scrollSettleDeferredWhilePreparing &&
        pendingInitialProgressRestoreRef.current?.contentKey === contentKey
      ) {
        pendingInitialProgressRestoreRef.current = null;
      }
    };
    frame = window.requestAnimationFrame(() => restore("frame"));
    timeout = window.setTimeout(() => restore("timeout"), 120);
    return () => {
      disposed = true;
      cancelPending();
      if (!completed && restoredLayoutKeyRef.current === layoutRestoreKey) {
        restoredLayoutKeyRef.current = null;
      }
    };
  }, [
    contentKey,
    getActiveScrollNode,
    isPagedReader,
    layoutRestoreKey,
    preparing,
    virtualDocument,
  ]);

  useEffect(
    () => () => {
      if (progressTimerRef.current !== null) {
        window.clearTimeout(progressTimerRef.current);
        progressTimerRef.current = null;
      }
      pendingProgressSaveRef.current = null;
      setOwnedPendingReaderProgress(false);
      cancelPagedScrollAnimation();
      flushProgress(latestProgressRef.current);
    },
    [cancelPagedScrollAnimation, flushProgress, setOwnedPendingReaderProgress],
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
      suppressProgrammaticResetScrollRef.current = false;
      scrollActivityVersionRef.current += 1;
      if (pendingInitialProgressRestoreRef.current?.contentKey === contentKey) {
        pendingInitialProgressRestoreRef.current = null;
      }
      scrollAnchorDirtyRef.current = true;
      const clamped = clampProgress(value);
      if (clamped < 97) {
        completedForNavigationRef.current = false;
      }
      if (isPagedReader) {
        scrollToProgress(node, clamped, true, "auto");
        const nextProgress =
          node.clientWidth <= 0
            ? clamped
            : clampProgress(getProgress(node, true));
        latestProgressRef.current = nextProgress;
        setRenderedProgress(nextProgress, { force: true });
        applyPageInfo(getPageInfo(node, true));
        scheduleProgressSave(nextProgress);
        return;
      }
      scrollToProgress(node, clamped, false, "auto");
      syncScrollVirtualRange(node.scrollTop, node.clientHeight);
      const nextProgress =
        node.clientHeight > 0 && node.scrollHeight - node.clientHeight > 0
          ? clampProgress(getProgress(node, false))
          : clamped;
      latestProgressRef.current = nextProgress;
      setRenderedProgress(nextProgress, { force: true });
      applyPageInfo(getPageInfo(node, false));
      scheduleProgressSave(nextProgress);
    },
    [
      applyPageInfo,
      contentKey,
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

  const completeIfAtEnd = useCallback(
    (options?: { force?: boolean }) => {
      const node = getActiveScrollNode();
      if (
        !options?.force &&
        (!node ||
          !isAtReadingEnd(node, isPagedReader) ||
          (!isPagedReader &&
            node.scrollHeight - node.clientHeight <= 2 &&
            hasPendingReaderMedia(contentRef.current)))
      ) {
        return false;
      }
      completedForNavigationRef.current = true;
      latestProgressRef.current = 100;
      setRenderedProgress(100, { force: true });
      if (progressTimerRef.current !== null) {
        window.clearTimeout(progressTimerRef.current);
        progressTimerRef.current = null;
      }
      pendingProgressSaveRef.current = null;
      setOwnedPendingReaderProgress(false);
      restoreSettleRef.current?.cancel();
      if (!onProgressChange) {
        return false;
      }
      flushProgress(100);
      scrollAnchorDirtyRef.current = true;
      persistScrollAnchor();
      return true;
    },
    [
      contentRef,
      flushProgress,
      getActiveScrollNode,
      isPagedReader,
      onProgressChange,
      persistScrollAnchor,
      setOwnedPendingReaderProgress,
      setRenderedProgress,
    ],
  );

  return {
    progress,
    pageInfo,
    updateProgressFromScroll,
    completeIfAtEnd,
    seekToProgress,
    commitSeekProgress,
  };
}
