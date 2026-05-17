import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type Ref,
  type WheelEvent,
} from "react";
import { Box } from "@mantine/core";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { useTranslation } from "../i18n";
import {
  resolveLocalChapterMediaSrc,
  type ChapterMediaStorageContext,
} from "../lib/chapter-media";
import {
  useReaderStore,
  type ReaderAppearanceSettings,
  type ReaderGeneralSettings,
  type ReaderPdfPageFitMode,
  type ReaderTapZone,
  type ReaderTapZoneMap,
} from "../store/reader";
import type { ReaderContentHandle } from "./ReaderContent";
import { ReaderSeekbars } from "./ReaderSeekbars";
import {
  prefixSegmentHeights,
  virtualRangeForScroll,
  virtualRangesEqual,
} from "./reader-virtualization";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfReaderContentProps {
  appearanceSettings?: ReaderAppearanceSettings;
  bottomOverlayOffset?: number | string;
  dataUrl: string;
  generalSettings?: ReaderGeneralSettings;
  initialProgress?: number;
  localMediaContext?: ChapterMediaStorageContext;
  onBoundaryPage?: (direction: 1 | -1) => void;
  onPageIndexChange?: (pageIndex: number) => void;
  onProgressChange?: (progress: number) => void;
  onSeekbarActivity?: () => void;
  onSeekbarActiveChange?: (active: boolean) => void;
  onToggleChrome?: () => void;
  viewportHeight?: string;
}

interface PdfPageCanvasProps {
  active: boolean;
  estimatedHeight: number;
  pageNumber: number;
  pdfDocument: PDFDocumentProxy;
  renderBounds: PdfRenderBounds;
  onRenderError: (error: unknown) => void;
  onRendered: (pageNumber: number, height: number) => void;
}

interface PdfRenderBounds {
  width: number;
  height: number;
  fitMode: ReaderPdfPageFitMode;
}

const MAX_CANVAS_SCALE = 3;
const MIN_RENDER_BOUND_PX = 1;
const PDF_PAGE_GAP_PX = 16;
const PDF_SCROLL_DEFAULT_ASPECT_RATIO = 1.414;
const PDF_SCROLL_OVERSCAN_PX = 1800;
const SCROLL_PAGE_FRACTION = 0.9;
const TWO_PAGE_MEDIA_QUERY = "(min-width: 992px)";
const PROGRESS_SAVE_DELAY_MS = 350;
const WHEEL_PAGE_COOLDOWN_MS = 220;
const WHEEL_PAGE_DELTA_THRESHOLD = 20;
const NATIVE_WHEEL_ACTION_LOCK_MS = 240;
const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;
const PDF_READER_MEDIA_EVENT_SELECTOR =
  "canvas,img,picture,svg,video,audio,iframe,figure";
const INITIAL_PDF_RENDER_BOUNDS: PdfRenderBounds = {
  width: 0,
  height: 0,
  fitMode: "width",
};

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, progress));
}

function getTwoPageMediaMatches(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia(TWO_PAGE_MEDIA_QUERY).matches
  );
}

function alignPageToSpread(
  pageNumber: number,
  pageCount: number,
  visiblePageCount: number,
): number {
  if (pageCount <= 0) return 1;
  const clamped = Math.max(1, Math.min(pageCount, pageNumber));
  if (visiblePageCount <= 1) return clamped;
  return clamped - ((clamped - 1) % visiblePageCount);
}

function getVisiblePageCount(
  pageNumber: number,
  pageCount: number,
  spreadSize: number,
): number {
  if (pageCount <= 0) return 1;
  return Math.max(1, Math.min(spreadSize, pageCount - pageNumber + 1));
}

function getPageFromProgress(
  progress: number,
  pageCount: number,
  visiblePageCount: number,
): number {
  if (pageCount <= 0) return 1;
  const clamped = clampProgress(progress);
  if (clamped >= 100) {
    return alignPageToSpread(pageCount, pageCount, visiblePageCount);
  }
  const page = Math.floor((clamped / 100) * pageCount) + 1;
  return alignPageToSpread(page, pageCount, visiblePageCount);
}

function getPagedProgressOffset(
  progress: number,
  pageNumber: number,
  pageCount: number,
  visiblePageCount: number,
): number {
  if (pageCount <= 0) return 0;
  const rawPosition = (clampProgress(progress) / 100) * pageCount;
  const visibleCount = getVisiblePageCount(
    pageNumber,
    pageCount,
    visiblePageCount,
  );
  return Math.max(0, Math.min(1, (rawPosition - (pageNumber - 1)) / visibleCount));
}

function getVerticalScrollMax(node: HTMLElement): number {
  return Math.max(0, node.scrollHeight - node.clientHeight);
}

function canScrollVertically(node: HTMLElement, direction: 1 | -1): boolean {
  const maxTop = getVerticalScrollMax(node);
  if (maxTop <= 2) return false;
  return direction === 1 ? node.scrollTop < maxTop - 2 : node.scrollTop > 2;
}

function getPdfReaderDebugSnapshot(node: HTMLElement | null) {
  if (!node) return null;
  const maxTop = getVerticalScrollMax(node);
  return {
    scrollTop: Math.round(node.scrollTop),
    maxTop: Math.round(maxTop),
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  };
}

function logPdfReaderInput(
  event: string,
  details: Record<string, unknown>,
): void {
  if (!import.meta.env.DEV) return;
  console.warn("[reader-input:pdf]", event, details);
}

function getScrollProgress(node: HTMLElement): number {
  const maxTop = getVerticalScrollMax(node);
  return maxTop <= 0 ? 100 : (node.scrollTop / maxTop) * 100;
}

function getPdfDisplayScale(
  baseViewport: { width: number; height: number },
  renderBounds: PdfRenderBounds,
): number {
  const widthScale = renderBounds.width / baseViewport.width;
  if (renderBounds.fitMode === "width" || renderBounds.height <= 0) {
    return widthScale;
  }

  const heightScale = renderBounds.height / baseViewport.height;
  return renderBounds.fitMode === "height"
    ? heightScale
    : Math.min(widthScale, heightScale);
}

function estimatePdfScrollPageFrameHeight(
  renderBounds: PdfRenderBounds,
): number {
  return Math.max(
    MIN_RENDER_BOUND_PX,
    Math.ceil(renderBounds.width * PDF_SCROLL_DEFAULT_ASPECT_RATIO),
  );
}

function getPdfProgress(
  node: HTMLElement,
  pageNumber: number,
  pageCount: number,
  pageReader: boolean,
  visiblePageCount: number,
): number {
  if (!pageReader) return getScrollProgress(node);
  if (pageCount <= 0) return 0;
  const visibleCount = getVisiblePageCount(
    pageNumber,
    pageCount,
    visiblePageCount,
  );
  const maxTop = getVerticalScrollMax(node);
  const pageOffset = maxTop <= 2 ? 0 : node.scrollTop / maxTop;
  return clampProgress(
    ((pageNumber - 1 + pageOffset * visibleCount) / pageCount) * 100,
  );
}

function getScrollPageIndex(progress: number, pageCount: number): number {
  if (pageCount <= 0) return 1;
  if (progress >= 100) return pageCount;
  return Math.max(
    1,
    Math.min(pageCount, Math.floor((clampProgress(progress) / 100) * pageCount) + 1),
  );
}

function decodeBase64Payload(payload: string): Uint8Array {
  const binary = window.atob(decodeURIComponent(payload).replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodePercentPayload(payload: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < payload.length; index += 1) {
    const char = payload[index];
    if (char === "%" && index + 2 < payload.length) {
      const value = Number.parseInt(payload.slice(index + 1, index + 3), 16);
      if (!Number.isNaN(value)) {
        bytes.push(value);
        index += 2;
        continue;
      }
    }
    bytes.push(char.charCodeAt(0));
  }
  return new Uint8Array(bytes);
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const commaIndex = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || commaIndex < 0) {
    throw new Error("Invalid PDF data URL.");
  }

  const header = dataUrl.slice(0, commaIndex).toLowerCase();
  const payload = dataUrl.slice(commaIndex + 1);
  return header.includes(";base64")
    ? decodeBase64Payload(payload)
    : decodePercentPayload(payload);
}

async function pdfDocumentSourceFromContent(
  content: string,
  localMediaContext: ChapterMediaStorageContext | undefined,
) {
  const resolved = content.startsWith("data:")
    ? content
    : await resolveLocalChapterMediaSrc(content, localMediaContext);
  if (!resolved) {
    throw new Error("PDF content is not available.");
  }
  return resolved.startsWith("data:")
    ? { data: dataUrlToBytes(resolved) }
    : { url: resolved };
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (isPdfReaderMediaEventTarget(target)) return true;
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest(
    "button,a,input,select,textarea,[role='button'],[role='slider']",
  );
}

function getPdfReaderEventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function isPdfReaderMediaEventTarget(target: EventTarget | null): boolean {
  const element = getPdfReaderEventElement(target);
  if (!element) return false;
  if (element.closest(PDF_READER_MEDIA_EVENT_SELECTOR)) return true;
  const link = element.closest("a");
  return !!link?.querySelector(PDF_READER_MEDIA_EVENT_SELECTOR);
}

function stopPdfReaderMediaClick(event: MouseEvent<HTMLDivElement>): void {
  if (!isPdfReaderMediaEventTarget(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
}

function getNormalizedWheelDelta(event: WheelEvent<HTMLElement>): number {
  const primaryDelta =
    Math.abs(event.deltaY) >= Math.abs(event.deltaX)
      ? event.deltaY
      : event.deltaX;
  if (event.deltaMode === WHEEL_DELTA_LINE) return primaryDelta * 16;
  if (event.deltaMode === WHEEL_DELTA_PAGE) {
    return primaryDelta * window.innerHeight;
  }
  return primaryDelta;
}

function getTapZoneAction(
  rect: DOMRect,
  clientX: number,
  clientY: number,
  tapZones: ReaderTapZoneMap,
) {
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const column =
    x < rect.width / 3 ? "Left" : x > (rect.width * 2) / 3 ? "Right" : "Center";
  const row =
    y < rect.height / 3
      ? "top"
      : y > (rect.height * 2) / 3
        ? "bottom"
        : "middle";
  const zone = `${row}${column}` as ReaderTapZone;
  return zone === "middleCenter" ? "menu" : tapZones[zone];
}

function PdfPageCanvas({
  active,
  estimatedHeight,
  pageNumber,
  pdfDocument,
  renderBounds,
  onRenderError,
  onRendered,
}: PdfPageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const [rendering, setRendering] = useState(false);
  const frameStyle = useMemo<CSSProperties>(
    () => ({ minHeight: `${Math.max(1, Math.ceil(estimatedHeight))}px` }),
    [estimatedHeight],
  );

  useEffect(
    () => () => {
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!active) {
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      setRendering(false);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas || renderBounds.width <= 0) return;

    let disposed = false;
    let renderedHeight = 0;
    setRendering(true);
    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;

    void pdfDocument
      .getPage(pageNumber)
      .then((page) => {
        if (disposed) return undefined;
        const baseViewport = page.getViewport({ scale: 1 });
        const displayScale = getPdfDisplayScale(baseViewport, renderBounds);
        const outputScale = Math.min(
          MAX_CANVAS_SCALE,
          Math.max(1, window.devicePixelRatio || 1),
        );
        const viewport = page.getViewport({ scale: displayScale * outputScale });
        const cssViewport = page.getViewport({ scale: displayScale });

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(cssViewport.width)}px`;
        canvas.style.height = `${Math.floor(cssViewport.height)}px`;
        renderedHeight = Math.ceil(cssViewport.height);

        const renderTask = page.render({ canvas, viewport });
        renderTaskRef.current = renderTask;
        return renderTask.promise;
      })
      .then(() => {
        if (disposed) return;
        renderTaskRef.current = null;
        setRendering(false);
        onRendered(pageNumber, renderedHeight);
      })
      .catch((nextError: unknown) => {
        if (disposed) return;
        renderTaskRef.current = null;
        setRendering(false);
        if (
          nextError instanceof Error &&
          nextError.name === "RenderingCancelledException"
        ) {
          return;
        }
        onRenderError(nextError);
      });

    return () => {
      disposed = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
  }, [
    active,
    onRenderError,
    onRendered,
    pageNumber,
    pdfDocument,
    renderBounds,
  ]);

  return (
    <div
      aria-hidden={active ? undefined : "true"}
      className="lnr-pdf-reader-page-frame"
      data-virtualized={active ? undefined : "true"}
      style={frameStyle}
    >
      {active ? (
        <canvas
          ref={canvasRef}
          aria-label={`${pageNumber}`}
          className="lnr-pdf-reader-canvas"
          data-rendering={rendering}
        />
      ) : null}
    </div>
  );
}

function PdfReaderContentInner(
  props: PdfReaderContentProps,
  ref: Ref<ReaderContentHandle>,
) {
  const {
    dataUrl,
    bottomOverlayOffset = "1rem",
    initialProgress = 0,
    onBoundaryPage,
    onPageIndexChange,
    onProgressChange,
    onSeekbarActivity,
    onSeekbarActiveChange,
    onToggleChrome,
    localMediaContext,
    viewportHeight: requestedViewportHeight,
    appearanceSettings,
    generalSettings,
  } = props;
  const { t } = useTranslation();
  const storedGeneral = useReaderStore((state) => state.general);
  const storedAppearance = useReaderStore((state) => state.appearance);
  const general = generalSettings ?? storedGeneral;
  const appearance = appearanceSettings ?? storedAppearance;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const pageNumberRef = useRef(1);
  const pageCountRef = useRef(0);
  const visiblePageCountRef = useRef(1);
  const initialProgressRef = useRef(clampProgress(initialProgress));
  const latestProgressRef = useRef(clampProgress(initialProgress));
  const lastSavedProgressRef = useRef(Math.round(clampProgress(initialProgress)));
  const progressTimerRef = useRef<number | null>(null);
  const restorePendingRef = useRef(true);
  const completedForNavigationRef = useRef(false);
  const pendingPageScrollRef = useRef<"start" | "end" | null>(null);
  const renderedPagesRef = useRef<Set<number>>(new Set());
  const wheelDeltaRef = useRef(0);
  const wheelCooldownTimerRef = useRef<number | null>(null);
  const wheelPagingLockedRef = useRef(false);
  const nativeWheelActionLockedUntilRef = useRef(0);
  const scrollDebugLastAtRef = useRef(0);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const onBoundaryPageRef = useRef(onBoundaryPage);
  const onPageIndexChangeRef = useRef(onPageIndexChange);
  const onProgressChangeRef = useRef(onProgressChange);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [progress, setProgress] = useState(clampProgress(initialProgress));
  const [renderBounds, setRenderBounds] = useState<PdfRenderBounds>(
    INITIAL_PDF_RENDER_BOUNDS,
  );
  const [scrollCanvasRange, setScrollCanvasRange] = useState({
    start: 0,
    end: -1,
  });
  const [scrollPageHeights, setScrollPageHeights] = useState<number[]>([]);
  const renderBoundsRef = useRef<PdfRenderBounds>(INITIAL_PDF_RENDER_BOUNDS);
  const [twoPageMediaMatches, setTwoPageMediaMatches] = useState(
    getTwoPageMediaMatches,
  );
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const viewportHeight =
    requestedViewportHeight ?? "calc(var(--lnr-app-content-height) - 3.75rem)";
  const isPagedReader = general.pageReader;
  const isTwoPageReader =
    isPagedReader && general.twoPageReader && twoPageMediaMatches;
  const visiblePageCount = isTwoPageReader ? 2 : 1;
  const pdfPageFitMode: ReaderPdfPageFitMode = isPagedReader
    ? general.pdfPageFitMode
    : "width";
  const estimatedScrollPageFrameHeight = useMemo(
    () => estimatePdfScrollPageFrameHeight(renderBounds),
    [renderBounds],
  );
  const effectiveScrollPageHeights = useMemo(
    () =>
      Array.from(
        { length: pageCount },
        (_, index) =>
          scrollPageHeights[index] ?? estimatedScrollPageFrameHeight,
      ),
    [estimatedScrollPageFrameHeight, pageCount, scrollPageHeights],
  );
  const scrollPageOffsets = useMemo(
    () =>
      prefixSegmentHeights(
        effectiveScrollPageHeights.map((height, index) =>
          index < effectiveScrollPageHeights.length - 1
            ? height + PDF_PAGE_GAP_PX
            : height,
        ),
      ),
    [effectiveScrollPageHeights],
  );
  const normalizedScrollCanvasRange = useMemo(() => {
    if (pageCount <= 0) return { start: 0, end: -1 };
    if (scrollCanvasRange.end < scrollCanvasRange.start) {
      return { start: 0, end: Math.min(pageCount - 1, 2) };
    }
    return {
      start: Math.max(0, Math.min(pageCount - 1, scrollCanvasRange.start)),
      end: Math.max(
        0,
        Math.min(pageCount - 1, scrollCanvasRange.end),
      ),
    };
  }, [pageCount, scrollCanvasRange.end, scrollCanvasRange.start]);
  const pageNumbers = useMemo(() => {
    if (pageCount <= 0) return [];
    if (!isPagedReader) {
      return Array.from({ length: pageCount }, (_, index) => index + 1);
    }
    return Array.from(
      {
        length: getVisiblePageCount(pageNumber, pageCount, visiblePageCount),
      },
      (_, index) => pageNumber + index,
    );
  }, [isPagedReader, pageCount, pageNumber, visiblePageCount]);
  const showTrailingPageSlot =
    isTwoPageReader && pageNumbers.length === 1 && renderBounds.width > 0;
  const pageWrapStyle = useMemo<CSSProperties>(
    () =>
      isTwoPageReader && renderBounds.width > 0
        ? ({
            "--lnr-pdf-page-slot-width": `${renderBounds.width}px`,
          } as CSSProperties)
        : {},
    [isTwoPageReader, renderBounds.width],
  );

  useEffect(() => {
    const nextProgress = clampProgress(initialProgress);
    initialProgressRef.current = nextProgress;
    if (pageCountRef.current > 0) return;
    latestProgressRef.current = nextProgress;
    lastSavedProgressRef.current = Math.round(nextProgress);
    setProgress(nextProgress);
    if (nextProgress < 97) {
      completedForNavigationRef.current = false;
    }
  }, [initialProgress]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia(TWO_PAGE_MEDIA_QUERY);
    const syncMedia = () => setTwoPageMediaMatches(media.matches);
    syncMedia();
    media.addEventListener("change", syncMedia);
    return () => media.removeEventListener("change", syncMedia);
  }, []);

  useEffect(() => {
    onBoundaryPageRef.current = onBoundaryPage;
  }, [onBoundaryPage]);

  useEffect(() => {
    onPageIndexChangeRef.current = onPageIndexChange;
  }, [onPageIndexChange]);

  useEffect(() => {
    onProgressChangeRef.current = onProgressChange;
  }, [onProgressChange]);

  useEffect(() => {
    pageNumberRef.current = pageNumber;
  }, [pageNumber]);

  useEffect(() => {
    pageCountRef.current = pageCount;
  }, [pageCount]);

  useEffect(() => {
    visiblePageCountRef.current = visiblePageCount;
  }, [visiblePageCount]);

  const flushProgress = useCallback((value: number) => {
    const callback = onProgressChangeRef.current;
    if (!callback) return;
    const rounded = Math.round(clampProgress(value));
    if (
      rounded >= 97 ||
      Math.abs(rounded - lastSavedProgressRef.current) >= 1
    ) {
      lastSavedProgressRef.current = rounded;
      callback(rounded);
    }
  }, []);

  const cancelPendingScrollRestore = useCallback((source: string) => {
    if (isPagedReader || !restorePendingRef.current) return false;
    logPdfReaderInput("restore-cancel", {
      source,
      snapshot: getPdfReaderDebugSnapshot(viewportRef.current),
    });
    restorePendingRef.current = false;
    return true;
  }, [isPagedReader]);

  const scheduleProgressSave = useCallback(
    (value: number) => {
      if (progressTimerRef.current !== null) {
        window.clearTimeout(progressTimerRef.current);
      }
      progressTimerRef.current = window.setTimeout(() => {
        flushProgress(value);
        progressTimerRef.current = null;
      }, PROGRESS_SAVE_DELAY_MS);
    },
    [flushProgress],
  );

  const syncScrollCanvasRange = useCallback(() => {
    if (isPagedReader || pageCountRef.current <= 0) return;
    const node = viewportRef.current;
    if (!node) return;
    const nextRange = virtualRangeForScroll(
      node.scrollTop,
      node.clientHeight,
      scrollPageOffsets,
      Math.max(PDF_SCROLL_OVERSCAN_PX, node.clientHeight),
    );
    setScrollCanvasRange((current) =>
      virtualRangesEqual(current, nextRange) ? current : nextRange,
    );
  }, [isPagedReader, scrollPageOffsets]);

  const updateProgressFromScroll = useCallback(() => {
    const node = viewportRef.current;
    const currentPageCount = pageCountRef.current;
    if (!isPagedReader) {
      syncScrollCanvasRange();
    }
    if (
      !node ||
      currentPageCount <= 0 ||
      completedForNavigationRef.current
    ) {
      return;
    }
    if (restorePendingRef.current) {
      if (isPagedReader || node.scrollTop <= 2) {
        logPdfReaderInput("scroll-suppressed", {
          reason: "restore-pending",
          mode: isPagedReader ? "paged" : "scroll",
          snapshot: getPdfReaderDebugSnapshot(node),
        });
        return;
      }
      logPdfReaderInput("restore-cancel", {
        source: "native-scroll",
        snapshot: getPdfReaderDebugSnapshot(node),
      });
      restorePendingRef.current = false;
    }
    const currentPageNumber = pageNumberRef.current;
    const currentVisiblePageCount = visiblePageCountRef.current;
    const nextProgress = getPdfProgress(
      node,
      currentPageNumber,
      currentPageCount,
      isPagedReader,
      currentVisiblePageCount,
    );
    latestProgressRef.current = nextProgress;
    setProgress(nextProgress);
    const now = performance.now();
    if (now - scrollDebugLastAtRef.current >= 120) {
      scrollDebugLastAtRef.current = now;
      logPdfReaderInput("scroll-progress", {
        mode: isPagedReader ? "paged" : "scroll",
        progress: Math.round(nextProgress * 100) / 100,
        pageIndex: isPagedReader
          ? currentPageNumber
          : getScrollPageIndex(nextProgress, currentPageCount),
        pageCount: currentPageCount,
        snapshot: getPdfReaderDebugSnapshot(node),
      });
    }
    onPageIndexChangeRef.current?.(
      isPagedReader
        ? currentPageNumber
        : getScrollPageIndex(nextProgress, currentPageCount),
    );
    scheduleProgressSave(nextProgress);
  }, [isPagedReader, scheduleProgressSave, syncScrollCanvasRange]);

  const applyPagedScrollPosition = useCallback((position: "start" | "end") => {
    const node = viewportRef.current;
    if (!node) return;
    const maxTop = getVerticalScrollMax(node);
    logPdfReaderInput("paged-inner-scroll-apply", {
      position,
      targetTop: position === "end" ? Math.round(maxTop) : 0,
      snapshot: getPdfReaderDebugSnapshot(node),
    });
    node.scrollTo({
      top: position === "end" ? maxTop : 0,
      left: 0,
      behavior: "auto",
    });
  }, []);

  const moveToPage = useCallback(
    (nextPageNumber: number, position: "start" | "end" = "start") => {
      const currentPageCount = pageCountRef.current;
      if (currentPageCount <= 0) return;
      const currentPageNumber = pageNumberRef.current;
      const nextPage = alignPageToSpread(
        nextPageNumber,
        currentPageCount,
        visiblePageCountRef.current,
      );
      if (nextPage !== currentPageNumber) {
        renderedPagesRef.current = new Set();
        setLayoutVersion((current) => current + 1);
      }
      logPdfReaderInput("move-to-page", {
        requestedPage: nextPageNumber,
        nextPage,
        currentPageNumber,
        position,
        pageCount: currentPageCount,
        visiblePageCount: visiblePageCountRef.current,
      });
      pendingPageScrollRef.current = position;
      pageNumberRef.current = nextPage;
      setPageNumber(nextPage);
      if (nextPage === currentPageNumber) {
        pendingPageScrollRef.current = null;
        applyPagedScrollPosition(position);
        updateProgressFromScroll();
      }
    },
    [applyPagedScrollPosition, updateProgressFromScroll],
  );

  const scrollByPage = useCallback(
    (direction: 1 | -1, source = "imperative") => {
      const node = viewportRef.current;
      const currentPageCount = pageCountRef.current;
      if (!node || currentPageCount <= 0) return;
      if (isPagedReader && pendingPageScrollRef.current) {
        logPdfReaderInput("page-step-suppressed", {
          source,
          direction,
          reason: "pending-page-scroll",
          pageNumber: pageNumberRef.current,
          snapshot: getPdfReaderDebugSnapshot(node),
        });
        return;
      }
      if (
        !isPagedReader &&
        performance.now() < nativeWheelActionLockedUntilRef.current
      ) {
        logPdfReaderInput("page-step-suppressed", {
          source,
          direction,
          reason: "native-wheel-active",
          snapshot: getPdfReaderDebugSnapshot(node),
        });
        return;
      }
      cancelPendingScrollRestore(source);
      if (direction === -1) {
        completedForNavigationRef.current = false;
      }

      if (canScrollVertically(node, direction)) {
        logPdfReaderInput("page-step-scroll", {
          source,
          direction,
          mode: isPagedReader ? "paged-inner-scroll" : "scroll",
          snapshot: getPdfReaderDebugSnapshot(node),
        });
        node.scrollBy({
          top: node.clientHeight * SCROLL_PAGE_FRACTION * direction,
          behavior: "auto",
        });
        return;
      }

      if (!isPagedReader) {
        logPdfReaderInput("page-step-boundary", {
          source,
          direction,
          snapshot: getPdfReaderDebugSnapshot(node),
        });
        onBoundaryPageRef.current?.(direction);
        return;
      }

      const step = visiblePageCountRef.current;
      const targetPage = pageNumberRef.current + step * direction;
      logPdfReaderInput("page-step-request", {
        source,
        direction,
        mode: "paged",
        pageNumber: pageNumberRef.current,
        targetPage,
        pageCount: currentPageCount,
        snapshot: getPdfReaderDebugSnapshot(node),
      });
      if (targetPage < 1 || targetPage > currentPageCount) {
        logPdfReaderInput("page-step-boundary", {
          source,
          direction,
          pageNumber: pageNumberRef.current,
          targetPage,
          pageCount: currentPageCount,
          snapshot: getPdfReaderDebugSnapshot(node),
        });
        onBoundaryPageRef.current?.(direction);
        return;
      }
      moveToPage(targetPage, direction === -1 ? "end" : "start");
    },
    [cancelPendingScrollRestore, isPagedReader, moveToPage],
  );

  useImperativeHandle(
    ref,
    () => ({
      completeIfAtEnd() {
        const node = viewportRef.current;
        const currentPageCount = pageCountRef.current;
        if (!node || currentPageCount <= 0) return false;
        if (canScrollVertically(node, 1)) return false;
        if (
          isPagedReader &&
          pageNumberRef.current +
            getVisiblePageCount(
              pageNumberRef.current,
              currentPageCount,
              visiblePageCountRef.current,
            ) -
            1 <
            currentPageCount
        ) {
          return false;
        }
        completedForNavigationRef.current = true;
        latestProgressRef.current = 100;
        setProgress(100);
        if (progressTimerRef.current !== null) {
          window.clearTimeout(progressTimerRef.current);
          progressTimerRef.current = null;
        }
        flushProgress(100);
        return true;
      },
      patchMediaElements() {},
      scrollByPage,
      scrollToStart() {
        completedForNavigationRef.current = false;
        if (isPagedReader) {
          moveToPage(1);
          return;
        }
        viewportRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
        syncScrollCanvasRange();
      },
    }),
    [flushProgress, isPagedReader, moveToPage, scrollByPage, syncScrollCanvasRange],
  );

  useEffect(() => {
    let disposed = false;
    let loadingTask: ReturnType<typeof getDocument> | null = null;

    setPdfDocument(null);
    setPageCount(0);
    setPageNumber(1);
    pageCountRef.current = 0;
    pageNumberRef.current = 1;
    latestProgressRef.current = initialProgressRef.current;
    lastSavedProgressRef.current = Math.round(initialProgressRef.current);
    setProgress(initialProgressRef.current);
    setError(null);
    setLoading(true);
    restorePendingRef.current = true;
    renderedPagesRef.current = new Set();
    setScrollCanvasRange({ start: 0, end: -1 });
    setScrollPageHeights([]);
    setLayoutVersion((current) => current + 1);
    void (async () => {
      try {
        const source = await pdfDocumentSourceFromContent(
          dataUrl,
          localMediaContext,
        );
        if (disposed) return;
        loadingTask = getDocument(source);
        const nextDocument = await loadingTask.promise;
        if (disposed) {
          void nextDocument.destroy();
          return;
        }
        const nextPageCount = nextDocument.numPages;
        const restoredPage = getPageFromProgress(
          initialProgressRef.current,
          nextPageCount,
          visiblePageCountRef.current,
        );
        setPdfDocument(nextDocument);
        setPageCount(nextPageCount);
        setPageNumber(restoredPage);
        setLoading(false);
      } catch (nextError) {
        if (disposed) return;
        setError(nextError instanceof Error ? nextError.message : String(nextError));
        setLoading(false);
      }
    })();

    return () => {
      disposed = true;
      void loadingTask?.destroy();
    };
  }, [dataUrl, localMediaContext]);

  useEffect(() => {
    if (pageCount <= 0) return;
    setPageNumber((current) =>
      alignPageToSpread(current, pageCount, visiblePageCount),
    );
    restorePendingRef.current = true;
    renderedPagesRef.current = new Set();
    setScrollCanvasRange({ start: 0, end: -1 });
    setLayoutVersion((current) => current + 1);
  }, [pageCount, visiblePageCount]);

  useEffect(() => {
    const wrapNode = canvasWrapRef.current;
    const viewportNode = viewportRef.current;
    if (!wrapNode || !viewportNode) return;

    const syncRenderBounds = () => {
      const style = window.getComputedStyle(wrapNode);
      const horizontalPadding =
        (Number.parseFloat(style.paddingLeft) || 0) +
        (Number.parseFloat(style.paddingRight) || 0);
      const verticalPadding =
        (Number.parseFloat(style.paddingTop) || 0) +
        (Number.parseFloat(style.paddingBottom) || 0);
      const gap = Number.parseFloat(style.columnGap) || PDF_PAGE_GAP_PX;
      const columns = isTwoPageReader ? 2 : 1;
      const availableWidth = Math.max(
        MIN_RENDER_BOUND_PX,
        wrapNode.clientWidth - horizontalPadding,
      );
      const nextHeight =
        pdfPageFitMode === "width"
          ? 0
          : Math.max(
              MIN_RENDER_BOUND_PX,
              Math.floor(viewportNode.clientHeight - verticalPadding),
            );
      const nextBounds: PdfRenderBounds = {
        width: Math.max(
          MIN_RENDER_BOUND_PX,
          Math.floor((availableWidth - gap * (columns - 1)) / columns),
        ),
        height: nextHeight,
        fitMode: pdfPageFitMode,
      };
      const current = renderBoundsRef.current;
      if (
        current.width === nextBounds.width &&
        current.height === nextBounds.height &&
        current.fitMode === nextBounds.fitMode
      ) {
        return;
      }
      renderBoundsRef.current = nextBounds;
      restorePendingRef.current = true;
      renderedPagesRef.current = new Set();
      setScrollCanvasRange({ start: 0, end: -1 });
      setScrollPageHeights([]);
      setLayoutVersion((version) => version + 1);
      setRenderBounds(nextBounds);
    };
    syncRenderBounds();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncRenderBounds);
    observer.observe(wrapNode);
    observer.observe(viewportNode);
    return () => observer.disconnect();
  }, [isPagedReader, isTwoPageReader, pdfPageFitMode]);

  useEffect(() => {
    restorePendingRef.current = true;
    renderedPagesRef.current = new Set();
    setScrollCanvasRange({ start: 0, end: -1 });
    setLayoutVersion((current) => current + 1);
  }, [isPagedReader, visiblePageCount]);

  useEffect(() => {
    if (isPagedReader || pageCount <= 0 || renderBounds.width <= 0) return;
    syncScrollCanvasRange();
  }, [
    isPagedReader,
    pageCount,
    renderBounds.width,
    scrollPageOffsets,
    syncScrollCanvasRange,
  ]);

  const handleRenderError = useCallback((nextError: unknown) => {
    setError(nextError instanceof Error ? nextError.message : String(nextError));
  }, []);

  const handlePageRendered = useCallback(
    (renderedPageNumber: number, height: number) => {
      renderedPagesRef.current.add(renderedPageNumber);
      if (!isPagedReader && height > 0) {
        setScrollPageHeights((current) => {
          const index = renderedPageNumber - 1;
          if (index < 0 || current[index] === height) return current;
          const next = [...current];
          next[index] = height;
          return next;
        });
      }
      if (restorePendingRef.current) {
        logPdfReaderInput("page-rendered-while-restore-pending", {
          renderedPageNumber,
          renderedPageCount: renderedPagesRef.current.size,
          expectedPages: pageNumbers,
          snapshot: getPdfReaderDebugSnapshot(viewportRef.current),
        });
      }
      setLayoutVersion((current) => current + 1);
    },
    [isPagedReader, pageNumbers],
  );

  useEffect(() => {
    if (
      !restorePendingRef.current ||
      !pdfDocument ||
      pageCount <= 0 ||
      renderBounds.width <= 0 ||
      pageNumbers.length === 0 ||
      (isPagedReader &&
        !pageNumbers.every((item) => renderedPagesRef.current.has(item)))
    ) {
      return;
    }

    const node = viewportRef.current;
    if (!node) return;
    const value = latestProgressRef.current;
    const applyRestore = () => {
      if (!restorePendingRef.current) {
        logPdfReaderInput("restore-suppressed", {
          reason: "canceled-before-frame",
          snapshot: getPdfReaderDebugSnapshot(node),
        });
        return;
      }
      if (isPagedReader) {
        const restoredPage = getPageFromProgress(
          value,
          pageCount,
          visiblePageCount,
        );
        if (restoredPage !== pageNumberRef.current) {
          logPdfReaderInput("restore-page-switch", {
            progress: Math.round(value * 100) / 100,
            restoredPage,
            currentPage: pageNumberRef.current,
            pageCount,
            visiblePageCount,
            snapshot: getPdfReaderDebugSnapshot(node),
          });
          renderedPagesRef.current = new Set();
          setLayoutVersion((current) => current + 1);
          pageNumberRef.current = restoredPage;
          setPageNumber(restoredPage);
          return;
        }
        const offset = getPagedProgressOffset(
          value,
          restoredPage,
          pageCount,
          visiblePageCount,
        );
        const targetTop = getVerticalScrollMax(node) * offset;
        logPdfReaderInput("restore-apply", {
          mode: "paged",
          progress: Math.round(value * 100) / 100,
          targetTop: Math.round(targetTop),
          restoredPage,
          snapshot: getPdfReaderDebugSnapshot(node),
        });
        node.scrollTo({
          top: targetTop,
          left: 0,
          behavior: "auto",
        });
      } else {
        const targetTop =
          getVerticalScrollMax(node) * (clampProgress(value) / 100);
        logPdfReaderInput("restore-apply", {
          mode: "scroll",
          progress: Math.round(value * 100) / 100,
          targetTop: Math.round(targetTop),
          snapshot: getPdfReaderDebugSnapshot(node),
        });
        node.scrollTo({
          top: targetTop,
          left: 0,
          behavior: "auto",
        });
      }
      restorePendingRef.current = false;
      syncScrollCanvasRange();
      updateProgressFromScroll();
    };
    window.requestAnimationFrame(applyRestore);
  }, [
    isPagedReader,
    layoutVersion,
    pageCount,
    pageNumbers,
    pdfDocument,
    renderBounds,
    syncScrollCanvasRange,
    updateProgressFromScroll,
    visiblePageCount,
  ]);

  useEffect(() => {
    if (
      restorePendingRef.current ||
      !isPagedReader ||
      !pendingPageScrollRef.current ||
      pageNumbers.length === 0 ||
      !pageNumbers.every((item) => renderedPagesRef.current.has(item))
    ) {
      return;
    }

    const position = pendingPageScrollRef.current;
    pendingPageScrollRef.current = null;
    window.requestAnimationFrame(() => {
      applyPagedScrollPosition(position);
      updateProgressFromScroll();
    });
  }, [
    applyPagedScrollPosition,
    isPagedReader,
    layoutVersion,
    pageNumbers,
    updateProgressFromScroll,
  ]);

  useEffect(
    () => () => {
      if (progressTimerRef.current !== null) {
        window.clearTimeout(progressTimerRef.current);
      }
      if (wheelCooldownTimerRef.current !== null) {
        window.clearTimeout(wheelCooldownTimerRef.current);
      }
      flushProgress(latestProgressRef.current);
    },
    [flushProgress],
  );

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (isInteractiveTarget(event.target)) return;
    const node = viewportRef.current;
    if (!node) return;
    const action = getTapZoneAction(
      node.getBoundingClientRect(),
      event.clientX,
      event.clientY,
      general.tapZones,
    );
    const resolvedAction =
      general.tapToScroll || action === "menu" ? action : "none";
    logPdfReaderInput("tap-action", {
      action,
      resolvedAction,
      mode: isPagedReader ? "paged" : "scroll",
      snapshot: getPdfReaderDebugSnapshot(node),
    });

    switch (resolvedAction) {
      case "previous":
        scrollByPage(-1, "tap-previous");
        break;
      case "next":
        scrollByPage(1, "tap-next");
        break;
      case "menu":
        onToggleChrome?.();
        break;
      case "none":
        break;
    }
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey || isInteractiveTarget(event.target)) return;
    const delta = getNormalizedWheelDelta(event);
    if (Math.abs(delta) < 1) return;

    const node = viewportRef.current;
    if (!node) return;
    if (!isPagedReader) {
      nativeWheelActionLockedUntilRef.current =
        performance.now() + NATIVE_WHEEL_ACTION_LOCK_MS;
      const canceledRestore = cancelPendingScrollRestore("wheel-native-scroll");
      logPdfReaderInput("wheel-native-scroll", {
        delta: Math.round(delta),
        canceledRestore,
        snapshot: getPdfReaderDebugSnapshot(node),
      });
      return;
    }

    const direction: 1 | -1 = delta > 0 ? 1 : -1;
    if (canScrollVertically(node, direction)) {
      wheelDeltaRef.current = 0;
      logPdfReaderInput("wheel-inner-scroll", {
        delta: Math.round(delta),
        direction,
        snapshot: getPdfReaderDebugSnapshot(node),
      });
      return;
    }

    event.preventDefault();
    if (wheelPagingLockedRef.current) {
      logPdfReaderInput("wheel-suppressed", {
        delta: Math.round(delta),
        direction,
        reason: "wheel-cooldown",
        snapshot: getPdfReaderDebugSnapshot(node),
      });
      return;
    }

    wheelDeltaRef.current += delta;
    if (Math.abs(wheelDeltaRef.current) < WHEEL_PAGE_DELTA_THRESHOLD) {
      logPdfReaderInput("wheel-accumulate", {
        delta: Math.round(delta),
        accumulated: Math.round(wheelDeltaRef.current),
        snapshot: getPdfReaderDebugSnapshot(node),
      });
      return;
    }

    wheelDeltaRef.current = 0;
    wheelPagingLockedRef.current = true;
    logPdfReaderInput("wheel-page-step", {
      direction,
      snapshot: getPdfReaderDebugSnapshot(node),
    });
    scrollByPage(direction, "wheel-page-step");

    if (wheelCooldownTimerRef.current !== null) {
      window.clearTimeout(wheelCooldownTimerRef.current);
    }
    wheelCooldownTimerRef.current = window.setTimeout(() => {
      wheelPagingLockedRef.current = false;
      wheelCooldownTimerRef.current = null;
    }, WHEEL_PAGE_COOLDOWN_MS);
  };

  const seekToProgress = useCallback(
    (value: number) => {
      const node = viewportRef.current;
      const currentPageCount = pageCountRef.current;
      if (!node || currentPageCount <= 0) return;
      const clamped = clampProgress(value);
      if (clamped < 97) {
        completedForNavigationRef.current = false;
      }
      latestProgressRef.current = clamped;
      setProgress(clamped);

      if (isPagedReader) {
        const nextPage = getPageFromProgress(
          clamped,
          currentPageCount,
          visiblePageCountRef.current,
        );
        if (nextPage !== pageNumberRef.current) {
          pendingPageScrollRef.current = null;
          restorePendingRef.current = true;
          renderedPagesRef.current = new Set();
          pageNumberRef.current = nextPage;
          setPageNumber(nextPage);
          setLayoutVersion((current) => current + 1);
        } else {
          const offset = getPagedProgressOffset(
            clamped,
            nextPage,
            currentPageCount,
            visiblePageCountRef.current,
          );
          node.scrollTo({
            top: getVerticalScrollMax(node) * offset,
            left: 0,
            behavior: "auto",
          });
          restorePendingRef.current = false;
          onPageIndexChangeRef.current?.(nextPage);
        }
      } else {
        node.scrollTo({
          top: getVerticalScrollMax(node) * (clamped / 100),
          left: 0,
          behavior: "auto",
        });
        syncScrollCanvasRange();
        onPageIndexChangeRef.current?.(
          getScrollPageIndex(clamped, currentPageCount),
        );
      }

      scheduleProgressSave(clamped);
    },
    [isPagedReader, scheduleProgressSave, syncScrollCanvasRange],
  );

  const commitSeekProgress = useCallback(() => {
    flushProgress(latestProgressRef.current);
  }, [flushProgress]);

  return (
    <Box
      className="lnr-pdf-reader-stage"
      style={{
        height: viewportHeight,
        background: appearance.backgroundColor,
        color: appearance.textColor,
      }}
    >
      <div
        ref={viewportRef}
        className={`lnr-pdf-reader-viewport${
          isTwoPageReader ? " reader-viewport-two-page" : ""
        }`}
        data-fit-mode={pdfPageFitMode}
        data-mode={isPagedReader ? "paged" : "scroll"}
        data-two-page={isTwoPageReader}
        onClickCapture={stopPdfReaderMediaClick}
        onDoubleClickCapture={stopPdfReaderMediaClick}
        onClick={handleClick}
        onScroll={updateProgressFromScroll}
        onTouchStart={(event) => {
          const touch = event.changedTouches[0];
          if (touch) {
            touchStartRef.current = { x: touch.clientX, y: touch.clientY };
          }
        }}
        onTouchMove={() => {
          nativeWheelActionLockedUntilRef.current =
            performance.now() + NATIVE_WHEEL_ACTION_LOCK_MS;
          cancelPendingScrollRestore("touch-native-scroll");
        }}
        onTouchEnd={(event) => {
          if (!general.swipeGestures || !touchStartRef.current) {
            touchStartRef.current = null;
            return;
          }
          const touch = event.changedTouches[0];
          if (!touch) return;
          const dx = touch.clientX - touchStartRef.current.x;
          const dy = touch.clientY - touchStartRef.current.y;
          touchStartRef.current = null;
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
            scrollByPage(dx < 0 ? 1 : -1, "swipe");
          }
        }}
        onWheel={handleWheel}
      >
        <div
          ref={canvasWrapRef}
          className="lnr-pdf-reader-page-wrap"
          data-fit-mode={pdfPageFitMode}
          data-mode={isPagedReader ? "paged" : "scroll"}
          data-two-page={isTwoPageReader}
          style={pageWrapStyle}
        >
          {loading ? (
            <div className="lnr-pdf-reader-state">
              {t("reader.loadingContent")}
            </div>
          ) : error ? (
            <div className="lnr-pdf-reader-state" role="alert">
              <span>{t("reader.loadFailed")}</span>
              <span>{error}</span>
            </div>
          ) : null}
          {pdfDocument && renderBounds.width > 0
            ? pageNumbers.map((item) => {
                const pageIndex = item - 1;
                const active =
                  isPagedReader ||
                  (pageIndex >= normalizedScrollCanvasRange.start &&
                    pageIndex <= normalizedScrollCanvasRange.end);
                return (
                  <PdfPageCanvas
                    key={item}
                    active={active}
                    estimatedHeight={
                      effectiveScrollPageHeights[pageIndex] ??
                      estimatedScrollPageFrameHeight
                    }
                    pageNumber={item}
                    pdfDocument={pdfDocument}
                    renderBounds={renderBounds}
                    onRenderError={handleRenderError}
                    onRendered={handlePageRendered}
                  />
                );
              })
            : null}
          {showTrailingPageSlot ? (
            <div
              aria-hidden="true"
              className="lnr-pdf-reader-page-frame lnr-pdf-reader-page-frame--placeholder"
            />
          ) : null}
        </div>
      </div>
      <ReaderSeekbars
        bottomOffset={bottomOverlayOffset}
        label={t("reader.progressAria", { progress: Math.round(progress) })}
        onActivity={onSeekbarActivity}
        onActiveChange={onSeekbarActiveChange}
        onCommit={commitSeekProgress}
        onSeek={seekToProgress}
        progress={progress}
        showHorizontal={general.showSeekbar}
        showVertical={general.showSeekbar && general.verticalSeekbar}
      />
    </Box>
  );
}

export const PdfReaderContent = forwardRef(PdfReaderContentInner);
