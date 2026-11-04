import {
  type ReaderChapterScrollAnchor,
  type ReaderScrollAnchor,
} from "../../store/reader";
import {
  READER_PENDING_MEDIA_ATTRIBUTE,
  READER_SEGMENT_INDEX_ATTRIBUTE,
} from "../reader-document";

const READER_SEGMENT_SELECTOR = `[${READER_SEGMENT_INDEX_ATTRIBUTE}]`;
const READER_ANCHOR_MEDIA_SELECTOR = "img,video";
const READER_VIRTUAL_CANVAS_SELECTOR = "[data-norea-reader-virtual-canvas]";
const READER_RESTORE_SETTLE_MIN_MS = 250;
export const READER_RESTORE_SETTLE_MAX_MS = 3_000;
const READER_RESTORE_SETTLE_TICK_MS = 100;
const READER_RESTORE_USER_INPUT_WINDOW_MS = 800;
const READER_RESTORE_SCROLL_TOLERANCE_PX = 2;

export type ReaderScrollAnchorPosition = Omit<ReaderScrollAnchor, "segmentCount">;

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Index of the last element whose top edge is at or above `top`, or -1. */
function lastElementStartingAbove(
  elements: ArrayLike<Element>,
  top: number,
): number {
  let low = 0;
  let high = elements.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (elements[mid]!.getBoundingClientRect().top <= top + 0.5) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

function anchorMediaElements(segment: Element): ArrayLike<Element> {
  return segment.matches(READER_ANCHOR_MEDIA_SELECTOR)
    ? []
    : segment.querySelectorAll(READER_ANCHOR_MEDIA_SELECTOR);
}

/**
 * Finds the content block at the top of the scroll viewport and how far into it
 * the viewport top lies. When the top lies inside an image or video of that
 * block, the anchor narrows to that media element.
 */
export function captureReaderScrollAnchor(
  node: Element,
  content: Element,
): ReaderScrollAnchorPosition | null {
  const segments = content.querySelectorAll(READER_SEGMENT_SELECTOR);
  if (segments.length === 0) return null;
  const viewTop = node.getBoundingClientRect().top;
  const segment = segments[Math.max(0, lastElementStartingAbove(segments, viewTop))]!;
  const segmentIndex = Number.parseInt(
    segment.getAttribute(READER_SEGMENT_INDEX_ATTRIBUTE) ?? "",
    10,
  );
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0) return null;

  const media = anchorMediaElements(segment);
  const mediaOrdinal = lastElementStartingAbove(media, viewTop);
  const mediaRect =
    mediaOrdinal >= 0 ? media[mediaOrdinal]!.getBoundingClientRect() : null;
  if (mediaRect && mediaRect.top + mediaRect.height > viewTop) {
    return {
      segmentIndex,
      mediaOrdinal,
      offset: clampFraction((viewTop - mediaRect.top) / mediaRect.height),
    };
  }
  const rect = segment.getBoundingClientRect();
  return {
    segmentIndex,
    offset: rect.height > 0 ? clampFraction((viewTop - rect.top) / rect.height) : 0,
  };
}

/** The mounted element an anchor points at and the offset to apply inside it. */
export function readerScrollAnchorElement(
  content: Element,
  anchor: ReaderScrollAnchorPosition,
): { element: Element; offset: number } | null {
  const segment = content.querySelector(
    `[${READER_SEGMENT_INDEX_ATTRIBUTE}="${anchor.segmentIndex}"]`,
  );
  if (!segment) return null;
  if (anchor.mediaOrdinal === undefined) {
    return { element: segment, offset: anchor.offset };
  }
  const media = anchorMediaElements(segment)[anchor.mediaOrdinal];
  return media
    ? { element: media, offset: anchor.offset }
    : { element: segment, offset: 0 };
}

/**
 * The scrollTop that puts the anchor back at the viewport top. A virtualized
 * segment that is not mounted is placed from the measured segment offsets.
 */
export function readerScrollAnchorTop(
  node: Element & { scrollTop: number },
  content: Element,
  anchor: ReaderScrollAnchorPosition,
  segmentOffsets: readonly number[] = [],
): number | null {
  const viewTop = node.getBoundingClientRect().top;
  const target = readerScrollAnchorElement(content, anchor);
  if (target) {
    const rect = target.element.getBoundingClientRect();
    return node.scrollTop + rect.top - viewTop + target.offset * rect.height;
  }
  const canvas = content.querySelector(READER_VIRTUAL_CANVAS_SELECTOR);
  const start = segmentOffsets[anchor.segmentIndex];
  const end = segmentOffsets[anchor.segmentIndex + 1];
  if (!canvas || start === undefined || end === undefined) return null;
  return (
    node.scrollTop +
    canvas.getBoundingClientRect().top -
    viewTop +
    start +
    anchor.offset * (end - start)
  );
}

function readerImageSettled(image: Element): boolean {
  if (image.hasAttribute(READER_PENDING_MEDIA_ATTRIBUTE)) return false;
  return (image as HTMLImageElement).complete !== false;
}

/**
 * True when no image that starts at or above `limitTop` (viewport
 * coordinates; null means every image) is still waiting for its source or
 * decoding, and no web font is loading.
 */
export function readerRestoreMediaSettled(
  content: Element,
  limitTop: number | null,
): boolean {
  for (const image of content.querySelectorAll("img")) {
    if (limitTop !== null && image.getBoundingClientRect().top > limitTop + 1) {
      continue;
    }
    if (!readerImageSettled(image)) return false;
  }
  return (
    typeof document === "undefined" || document.fonts?.status !== "loading"
  );
}

/**
 * The saved anchor of a chapter, when it still describes the stored progress.
 * A finished chapter keeps progress 100 while the reader saves lower positions,
 * so any anchor of a finished chapter is accepted.
 */
export function chapterScrollAnchorForProgress(
  anchor: ReaderChapterScrollAnchor | undefined,
  chapterProgress: number,
): ReaderScrollAnchor | null {
  if (!anchor) return null;
  const progress = Math.round(chapterProgress);
  if (progress < 100 && progress !== anchor.progress) return null;
  return {
    segmentIndex: anchor.segmentIndex,
    ...(anchor.mediaOrdinal === undefined
      ? {}
      : { mediaOrdinal: anchor.mediaOrdinal }),
    offset: anchor.offset,
    segmentCount: anchor.segmentCount,
  };
}

export type ReaderRestoreSettleEnd = "settled" | "timeout" | "user" | "cancelled";

export interface ReaderRestoreSettle {
  readonly active: boolean;
  /** Reports a scroll event; a scroll that follows user input ends the settle. */
  noteScroll: () => void;
  cancel: () => void;
}

interface ReaderRestoreSettleOptions {
  node: HTMLElement;
  content: HTMLElement;
  targetTop: () => number | null;
  isSettled: () => boolean;
  onApply: () => void;
  onEnd: (reason: ReaderRestoreSettleEnd) => void;
}

/**
 * Keeps a restored scroll position pinned while content above it changes size,
 * such as images that load after the first layout. It ends once that content
 * has settled, after a time limit, or as soon as the user scrolls.
 */
export function startReaderRestoreSettle({
  node,
  content,
  targetTop,
  isSettled,
  onApply,
  onEnd,
}: ReaderRestoreSettleOptions): ReaderRestoreSettle {
  const startedAt = performance.now();
  let active = true;
  let pointerHeld = false;
  let touchHeld = false;
  let lastInputAt = Number.NEGATIVE_INFINITY;
  let lastAppliedTop = node.scrollTop;
  let frame: number | null = null;
  let observer: ResizeObserver | null = null;
  const inputHeld = () => pointerHeld || touchHeld;

  const end = (reason: ReaderRestoreSettleEnd) => {
    if (!active) return;
    active = false;
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    window.clearInterval(interval);
    observer?.disconnect();
    node.removeEventListener("wheel", handleWheel);
    node.removeEventListener("pointerdown", handlePointerDown);
    node.removeEventListener("pointerup", handlePointerUp);
    node.removeEventListener("pointercancel", handlePointerUp);
    node.removeEventListener("touchstart", handleTouchStart);
    node.removeEventListener("touchend", handleTouchEnd);
    node.removeEventListener("touchcancel", handleTouchEnd);
    window.removeEventListener("keydown", markInput, true);
    content.removeEventListener("load", scheduleApply, true);
    content.removeEventListener("error", scheduleApply, true);
    onEnd(reason);
  };

  const apply = () => {
    frame = null;
    if (!active) return;
    if (!node.isConnected) {
      end("cancelled");
      return;
    }
    if (!inputHeld()) {
      const target = targetTop();
      if (target !== null) {
        const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
        const top = Math.max(0, Math.min(maxTop, target));
        if (Math.abs(node.scrollTop - top) > 1) node.scrollTop = top;
      }
      lastAppliedTop = node.scrollTop;
      onApply();
    }
    const elapsed = performance.now() - startedAt;
    if (elapsed >= READER_RESTORE_SETTLE_MAX_MS) {
      end("timeout");
    } else if (
      elapsed >= READER_RESTORE_SETTLE_MIN_MS &&
      !inputHeld() &&
      isSettled()
    ) {
      end("settled");
    }
  };
  function scheduleApply() {
    if (!active || frame !== null) return;
    frame = window.requestAnimationFrame(apply);
  }
  function markInput() {
    lastInputAt = performance.now();
  }
  function handleWheel() {
    end("user");
  }
  function handlePointerDown() {
    pointerHeld = true;
    markInput();
  }
  function handlePointerUp() {
    pointerHeld = false;
    markInput();
  }
  function handleTouchStart() {
    touchHeld = true;
    markInput();
  }
  function handleTouchEnd() {
    touchHeld = false;
    markInput();
  }

  node.addEventListener("wheel", handleWheel, { passive: true });
  node.addEventListener("pointerdown", handlePointerDown);
  node.addEventListener("pointerup", handlePointerUp);
  node.addEventListener("pointercancel", handlePointerUp);
  node.addEventListener("touchstart", handleTouchStart, { passive: true });
  node.addEventListener("touchend", handleTouchEnd);
  node.addEventListener("touchcancel", handleTouchEnd);
  window.addEventListener("keydown", markInput, true);
  content.addEventListener("load", scheduleApply, true);
  content.addEventListener("error", scheduleApply, true);
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(scheduleApply);
    observer.observe(content);
  }
  const interval = window.setInterval(apply, READER_RESTORE_SETTLE_TICK_MS);
  apply();

  return {
    get active() {
      return active;
    },
    noteScroll() {
      if (!active) return;
      if (
        Math.abs(node.scrollTop - lastAppliedTop) <=
        READER_RESTORE_SCROLL_TOLERANCE_PX
      ) {
        return;
      }
      if (
        inputHeld() ||
        performance.now() - lastInputAt <= READER_RESTORE_USER_INPUT_WINDOW_MS
      ) {
        end("user");
        return;
      }
      scheduleApply();
    },
    cancel() {
      end("cancelled");
    },
  };
}
