import { Box } from "@mantine/core";
import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type Ref,
} from "react";
import { useTranslation } from "../i18n";
import {
  type ChapterMediaElementPatch,
  type ChapterMediaStorageContext,
} from "../lib/chapter-media";
import {
  useReaderStore,
  type ReaderAppearanceSettings,
  type ReaderGeneralSettings,
} from "../store/reader";
import { ReaderSeekbars } from "./ReaderSeekbars";
import {
  prepareReaderDocument,
  type PreparedReaderDocument,
} from "./reader-document";
import { ReaderStatusOverlay } from "./reader/ReaderStatusOverlay";
import {
  protectLocalReaderMediaCached,
  stopReaderMediaClick,
  stripLocalMediaFontFaces,
} from "./reader/reader-content-media";
import { dispatchReaderScrollEvent } from "./reader/reader-content-metrics";
import { useReaderAutoScroll } from "./reader/use-reader-auto-scroll";
import { useReaderContentMedia } from "./reader/use-reader-content-media";
import { useReaderContentStyle } from "./reader/use-reader-content-style";
import { useReaderGestures } from "./reader/use-reader-gestures";
import { useReaderProgress } from "./reader/use-reader-progress";
import { useReaderScrollLayout } from "./reader/use-reader-scroll-layout";
import { useReaderWakeLock } from "./reader/use-reader-wake-lock";

export interface ReaderContentHandle {
  completeIfAtEnd: () => boolean;
  patchMediaElements: (patches: ChapterMediaElementPatch[]) => void;
  scrollByPage: (direction: 1 | -1, source?: string) => void;
  scrollToStart: () => void;
}

interface ReaderContentProps {
  appearanceSettings?: ReaderAppearanceSettings;
  bottomOverlayOffset?: number | string;
  contentKey?: number | string;
  generalSettings?: ReaderGeneralSettings;
  html: string;
  preparedDocument?: PreparedReaderDocument;
  initialProgress?: number;
  interactionBlocked?: boolean;
  localMediaContext?: ChapterMediaStorageContext;
  onProgressChange?: (progress: number) => void;
  onPageIndexChange?: (pageIndex: number) => void;
  onMediaError?: (source: string | null) => void;
  onSeekbarActivity?: () => void;
  onSeekbarActiveChange?: (active: boolean) => void;
  onToggleChrome?: () => void;
  onBoundaryPage?: (direction: 1 | -1) => void;
  seekbarVisible?: boolean;
  viewportHeight?: string;
}

const TWO_PAGE_MIN_COLUMN_WIDTH = 320;
function ReaderContentInner(
  props: ReaderContentProps,
  ref: Ref<ReaderContentHandle>,
) {
  const {
    html,
    preparedDocument,
    bottomOverlayOffset,
    contentKey,
    initialProgress = 0,
    interactionBlocked = false,
    localMediaContext,
    onProgressChange,
    onPageIndexChange,
    onMediaError,
    onSeekbarActivity,
    onSeekbarActiveChange,
    onToggleChrome,
    onBoundaryPage,
    seekbarVisible = true,
    viewportHeight: requestedViewportHeight,
    appearanceSettings,
    generalSettings,
  } = props;
  const storedGeneral = useReaderStore((state) => state.general);
  const storedAppearance = useReaderStore((state) => state.appearance);
  const general = generalSettings ?? storedGeneral;
  const appearance = appearanceSettings ?? storedAppearance;
  const { t } = useTranslation();
  useReaderWakeLock(general.keepScreenOn);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const completedForNavigationRef = useRef(false);
  const readerDocument = useMemo(
    () =>
      preparedDocument ?? prepareReaderDocument(html, general.bionicReading),
    [general.bionicReading, html, preparedDocument],
  );
  const renderedHtml = readerDocument.html;
  const virtualDocument = readerDocument.virtualDocument;
  const displayStaticHtml = useMemo(
    () => stripLocalMediaFontFaces(virtualDocument.staticHtml),
    [virtualDocument.staticHtml],
  );

  const isPagedReader = general.pageReader;
  const {
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
  } = useReaderScrollLayout({
    viewportRef,
    contentRef,
    isPagedReader,
    pageTransitionDuration: general.pageTransitionDuration,
    virtualDocument,
    completedForNavigationRef,
    onBoundaryPage,
  });
  useReaderAutoScroll(
    viewportRef,
    general.autoScroll && !isPagedReader,
    general.autoScrollInterval,
    general.autoScrollOffset,
  );
  const viewportHeight =
    requestedViewportHeight ??
    "calc(var(--norea-app-content-height) - 3.75rem)";
  const viewportWidth = viewportSize.width;
  const viewportHeightPx =
    viewportSize.height > 0
      ? viewportSize.height
      : typeof window !== "undefined"
        ? window.innerHeight
        : 0;
  const overlayBottom = bottomOverlayOffset ?? "0.5rem";
  const requestedPageColumnsPerSpread = general.twoPageReader ? 2 : 1;
  const {
    patchMediaElements,
    restoreMediaPatches,
    resolvedLocalMediaMap,
    hasLocalMediaContext,
  } = useReaderContentMedia({
    contentKey,
    renderedHtml,
    localMediaContext,
    contentRef,
    activeVirtualRangeStart,
    activeVirtualRangeEnd,
    isPagedReader,
    onMediaError,
  });
  const availablePageColumnsPerSpread = Math.max(
    1,
    Math.floor(viewportWidth / TWO_PAGE_MIN_COLUMN_WIDTH),
  );
  const pageColumnsPerSpread = isPagedReader
    ? Math.max(
        1,
        Math.min(requestedPageColumnsPerSpread, availablePageColumnsPerSpread),
      )
    : 1;
  const isMultiPageReader = isPagedReader && pageColumnsPerSpread > 1;
  const layoutRestoreKey = useMemo(
    () =>
      [
        contentKey ?? "",
        appearance.fontFamily,
        appearance.lineHeight,
        appearance.padding,
        appearance.textSize,
        general.bionicReading,
        general.pageReader,
        general.htmlImagePagingMode,
        viewportSize.width,
        isPagedReader ? viewportSize.height : "",
        pageColumnsPerSpread,
      ].join("|"),
    [
      appearance.fontFamily,
      appearance.lineHeight,
      appearance.padding,
      appearance.textSize,
      contentKey,
      general.bionicReading,
      general.pageReader,
      general.htmlImagePagingMode,
      isPagedReader,
      viewportSize.height,
      viewportSize.width,
      pageColumnsPerSpread,
    ],
  );

  const {
    progress,
    pageInfo,
    updateProgressFromScroll,
    completeIfAtEnd,
    seekToProgress,
    commitSeekProgress,
  } = useReaderProgress({
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
  });
  useImperativeHandle(
    ref,
    () => ({
      completeIfAtEnd,
      patchMediaElements,
      scrollByPage,
      scrollToStart() {
        const node = getActiveScrollNode();
        if (!node) return;
        cancelPagedScrollAnimation();
        node.scrollTo({ top: 0, left: 0, behavior: "auto" });
        syncScrollVirtualRange(0, node.clientHeight);
        dispatchReaderScrollEvent(node);
      },
    }),
    [
      cancelPagedScrollAnimation,
      completeIfAtEnd,
      getActiveScrollNode,
      patchMediaElements,
      scrollByPage,
      syncScrollVirtualRange,
    ],
  );

  useEffect(() => {
    const content = contentRef.current;
    if (!content || appearance.customJs.trim() === "") return;
    try {
      const run = new Function("container", appearance.customJs);
      run(content);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[reader] custom JS failed", error);
    }
  }, [
    activeVirtualRangeEnd,
    activeVirtualRangeStart,
    appearance.customJs,
    isPagedReader,
    renderedHtml,
  ]);

  const { handleClick, handleWheel, handleTouchStart, handleTouchEnd } =
    useReaderGestures({
      interactionBlocked,
      isPagedReader,
      general,
      viewportRef,
      getActiveScrollNode,
      scrollByPage,
      onToggleChrome,
      nativeWheelActionLockedUntilRef,
    });

  const { contentBoxStyle, readerContentRuntimeCss } = useReaderContentStyle({
    appearance,
    viewportWidth,
    viewportHeightPx,
    pageColumnsPerSpread,
    isPagedReader,
    removeExtraParagraphSpacing: general.removeExtraParagraphSpacing,
  });
  const viewportClassName = `reader-viewport ${
    isPagedReader ? "reader-viewport-paged" : "reader-viewport-scroll"
  }${isMultiPageReader ? " reader-viewport-multi-page reader-viewport-two-page" : ""}`;
  const normalizedVirtualRange = {
    start: Math.max(0, activeVirtualRangeStart),
    end: Math.min(virtualDocument.segments.length - 1, activeVirtualRangeEnd),
  };
  const visibleSegments =
    normalizedVirtualRange.end >= normalizedVirtualRange.start
      ? virtualDocument.segments.slice(
          normalizedVirtualRange.start,
          normalizedVirtualRange.end + 1,
        )
      : virtualDocument.segments.slice(
          0,
          Math.min(8, virtualDocument.segments.length),
        );
  const firstVisibleIndex = visibleSegments[0]?.index ?? 0;
  const lastVisibleIndex =
    visibleSegments[visibleSegments.length - 1]?.index ?? -1;
  const topSpacerHeight = segmentOffsets[firstVisibleIndex] ?? 0;
  const bottomSpacerHeight =
    lastVisibleIndex >= 0
      ? Math.max(
          0,
          virtualContentHeight - (segmentOffsets[lastVisibleIndex + 1] ?? 0),
        )
      : 0;
  const visibleSegmentsHtml = useMemo(
    () =>
      shouldVirtualizeScrollContent
        ? visibleSegments.map((segment) => segment.html).join("")
        : "",
    [
      firstVisibleIndex,
      lastVisibleIndex,
      shouldVirtualizeScrollContent,
      virtualDocument.segments,
    ],
  );
  const virtualSpacerStyle = useMemo(
    () =>
      ({
        "--norea-reader-bottom-spacer-height": `${bottomSpacerHeight}px`,
        "--norea-reader-content-height": `${virtualContentHeight}px`,
        "--norea-reader-top-spacer-height": `${topSpacerHeight}px`,
      }) as CSSProperties,
    [bottomSpacerHeight, topSpacerHeight, virtualContentHeight],
  );
  const scrollVirtualHtml = useMemo(() => {
    if (!shouldVirtualizeScrollContent) return "";
    return protectLocalReaderMediaCached(
      [
        displayStaticHtml,
        '<div data-norea-reader-virtual-canvas style="height:var(--norea-reader-content-height,0px);overflow-anchor:none;position:relative;width:100%">',
        '<div data-norea-reader-virtual-window style="left:0;overflow-anchor:none;position:absolute;right:0;top:var(--norea-reader-top-spacer-height,0px)">',
        visibleSegmentsHtml,
        "</div></div>",
      ].join(""),
      resolvedLocalMediaMap,
      hasLocalMediaContext,
    );
  }, [
    displayStaticHtml,
    resolvedLocalMediaMap,
    shouldVirtualizeScrollContent,
    hasLocalMediaContext,
    visibleSegmentsHtml,
  ]);
  const fullReaderHtml = useMemo(() => {
    if (shouldVirtualizeScrollContent) return "";
    return protectLocalReaderMediaCached(
      displayStaticHtml +
        virtualDocument.segments.map((segment) => segment.html).join(""),
      resolvedLocalMediaMap,
      hasLocalMediaContext,
    );
  }, [
    displayStaticHtml,
    resolvedLocalMediaMap,
    shouldVirtualizeScrollContent,
    hasLocalMediaContext,
    virtualDocument.segments,
  ]);
  const readerContentHtml = shouldVirtualizeScrollContent
    ? scrollVirtualHtml
    : fullReaderHtml;
  const readerContentInnerHtml = useMemo(
    () => ({ __html: readerContentHtml }),
    [readerContentHtml],
  );
  const readerContentStyle = useMemo<CSSProperties>(
    () =>
      shouldVirtualizeScrollContent
        ? { ...contentBoxStyle, ...virtualSpacerStyle }
        : contentBoxStyle,
    [contentBoxStyle, shouldVirtualizeScrollContent, virtualSpacerStyle],
  );

  useLayoutEffect(() => {
    restoreMediaPatches(readerContentHtml);
  }, [readerContentHtml, restoreMediaPatches]);

  return (
    <Box
      className="norea-reader-content-stage"
      style={{
        height: viewportHeight,
        background: appearance.backgroundColor,
        color: appearance.textColor,
      }}
    >
      <Box
        ref={viewportRef}
        className={viewportClassName}
        data-page-columns={isPagedReader ? pageColumnsPerSpread : undefined}
        data-paged-renderer={isPagedReader ? "columns" : undefined}
        onClickCapture={stopReaderMediaClick}
        onDoubleClickCapture={stopReaderMediaClick}
        onClick={handleClick}
        onScroll={isPagedReader ? undefined : updateProgressFromScroll}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        style={{
          position: "relative",
          height: "100%",
          overflowX: "hidden",
          overflowY: isPagedReader ? "hidden" : "auto",
          overflowAnchor: "none",
          color: appearance.textColor,
          cursor: "pointer",
          scrollBehavior: "auto",
        }}
      >
        <Box
          ref={contentRef}
          className={virtualDocument.contentClassName}
          data-image-paging={
            isPagedReader ? general.htmlImagePagingMode : undefined
          }
          dir={virtualDocument.contentDirection}
          lang={virtualDocument.contentLanguage}
          onScroll={isPagedReader ? updateProgressFromScroll : undefined}
          style={readerContentStyle}
          dangerouslySetInnerHTML={readerContentInnerHtml}
        />
        <style>{readerContentRuntimeCss}</style>
        {appearance.customCss.trim() ? (
          <style>{appearance.customCss}</style>
        ) : null}
        <ReaderStatusOverlay
          showScrollPercentage={general.showScrollPercentage}
          showBatteryAndTime={general.showBatteryAndTime}
          isPagedReader={isPagedReader}
          progress={progress}
          pageInfo={pageInfo}
          textColor={appearance.textColor}
          bottom={overlayBottom}
        />
      </Box>
      <ReaderSeekbars
        bottomOffset={overlayBottom}
        label={t("reader.progressAria", { progress: Math.round(progress) })}
        onActivity={onSeekbarActivity}
        onActiveChange={onSeekbarActiveChange}
        onCommit={commitSeekProgress}
        onSeek={seekToProgress}
        progress={progress}
        showHorizontal={general.showSeekbar}
        showVertical={general.showSeekbar && general.verticalSeekbar}
        visible={seekbarVisible}
      />
    </Box>
  );
}

export const ReaderContent = memo(forwardRef(ReaderContentInner));
