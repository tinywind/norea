import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type PreparedReaderDocument } from "../reader-document";
import {
  clampProgress,
  getPageInfo,
  getProgress,
  isAtReadingEnd,
  scrollToProgress,
  type PageInfo,
} from "./reader-content-metrics";
interface ReaderInitialProgressRestore {
  contentKey: number | string | undefined;
  progress: number;
}
const PROGRESS_RENDER_DELTA = 0.1;
const PROGRESS_SAVE_DELAY_MS = 350;

interface ReaderProgressOptions {
  contentKey?: number | string;
  initialProgress: number;
  isPagedReader: boolean;
  layoutRestoreKey: string;
  virtualDocument: PreparedReaderDocument["virtualDocument"];
  completedForNavigationRef: RefObject<boolean>;
  pageScrollAnimatingRef: RefObject<boolean>;
  getActiveScrollNode: () => HTMLDivElement | null;
  enforceScrollStepFloor: () => void;
  syncScrollVirtualRange: (scrollTop: number, clientHeight: number) => void;
  cancelPagedScrollAnimation: () => void;
  onProgressChange?: (progress: number) => void;
  onPageIndexChange?: (pageIndex: number) => void;
}
export function useReaderProgress({
  contentKey,
  initialProgress,
  isPagedReader,
  layoutRestoreKey,
  virtualDocument,
  completedForNavigationRef,
  pageScrollAnimatingRef,
  getActiveScrollNode,
  enforceScrollStepFloor,
  syncScrollVirtualRange,
  cancelPagedScrollAnimation,
  onProgressChange,
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
        progressTimerRef.current = null;
      }, PROGRESS_SAVE_DELAY_MS);
    },
    [flushProgress],
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

  const updateProgressFromScroll = useCallback(() => {
    const node = getActiveScrollNode();
    if (!node) return;
    if (completedForNavigationRef.current) return;
    if (isPagedReader && pageScrollAnimatingRef.current) return;
    if (!isPagedReader) {
      enforceScrollStepFloor();
    }
    scrollActivityVersionRef.current += 1;
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
    };
    latestPageInfoRef.current = { current: -1, total: -1 };
    latestProgressRef.current = nextProgress;
    setRenderedProgress(nextProgress, { force: true });
    lastSavedProgressRef.current = Math.round(nextProgress);
    if (nextProgress < 97) {
      completedForNavigationRef.current = false;
    }
  }, [contentKey, initialProgress, setRenderedProgress]);

  useEffect(() => {
    restoredLayoutKeyRef.current = null;
  }, [virtualDocument]);

  useEffect(() => {
    const node = getActiveScrollNode();
    if (!node) return;
    if (restoredLayoutKeyRef.current === layoutRestoreKey) return;
    restoredLayoutKeyRef.current = layoutRestoreKey;
    const pendingInitialProgress = pendingInitialProgressRestoreRef.current;
    const progressToRestore =
      pendingInitialProgress && pendingInitialProgress.contentKey === contentKey
        ? pendingInitialProgress.progress
        : latestProgressRef.current;
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
  }, [contentKey, getActiveScrollNode, layoutRestoreKey, virtualDocument]);

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

  const seekToProgress = useCallback(
    (value: number) => {
      const node = getActiveScrollNode();
      if (!node) return;
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
  }, [flushProgress]);

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
    flushProgress(100);
    return true;
  }, [flushProgress, getActiveScrollNode, isPagedReader, setRenderedProgress]);

  return {
    progress,
    pageInfo,
    updateProgressFromScroll,
    completeIfAtEnd,
    seekToProgress,
    commitSeekProgress,
  };
}
