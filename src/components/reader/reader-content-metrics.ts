import { type WheelEvent } from "react";
import { type ReaderTapZone } from "../../store/reader";
import { isReaderMediaEventTarget } from "./reader-content-media";
export interface PageInfo {
  current: number;
  total: number;
}

export const SCROLL_PAGE_FRACTION = 0.9;

export const PAGED_SCROLL_COMPLETION_BUFFER_MS = 80;

const WHEEL_DELTA_LINE = 1;

const WHEEL_DELTA_PAGE = 2;

const PAGED_SCROLL_POSITION_TOLERANCE_PX = 2;

const PAGED_TRAILING_PAGE_TOLERANCE_MAX_PX = 32;

const PAGED_TRAILING_PAGE_TOLERANCE_FRACTION = 0.03;

export function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, progress));
}

export function getReaderDebugSnapshot(node: HTMLElement | null) {
  if (!node) return null;
  const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
  return {
    scrollTop: Math.round(node.scrollTop),
    maxTop: Math.round(maxTop),
    scrollLeft: Math.round(node.scrollLeft),
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  };
}

export function logReaderInput(
  event: string,
  details: Record<string, unknown> | (() => Record<string, unknown>),
): void {
  if (!import.meta.env.DEV) return;
  console.warn(
    "[reader-input:html]",
    event,
    typeof details === "function" ? details() : details,
  );
}

export function dispatchReaderScrollEvent(node: HTMLElement): void {
  node.dispatchEvent(new Event("scroll", { bubbles: true }));
}

export function easeOutCubic(progress: number): number {
  return 1 - Math.pow(1 - progress, 3);
}

export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (isReaderMediaEventTarget(target)) return true;
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest(
    "button,a,input,select,textarea,[role='button'],[role='slider']",
  );
}

export function getProgress(node: HTMLElement, pageReader: boolean): number {
  if (pageReader) {
    const total = getPagedPageCount(node);
    if (total <= 1) return 0;
    return ((getPagedPageIndex(node) - 1) / (total - 1)) * 100;
  }
  const maxTop = node.scrollHeight - node.clientHeight;
  return maxTop <= 0 ? 100 : (node.scrollTop / maxTop) * 100;
}

function getPagedStep(node: HTMLElement): number {
  return Math.max(1, node.clientWidth);
}

function getPagedMaxLeft(node: HTMLElement): number {
  return Math.max(0, node.scrollWidth - node.clientWidth);
}

function getPagedTrailingTolerance(step: number): number {
  return Math.max(
    PAGED_SCROLL_POSITION_TOLERANCE_PX,
    Math.min(
      PAGED_TRAILING_PAGE_TOLERANCE_MAX_PX,
      step * PAGED_TRAILING_PAGE_TOLERANCE_FRACTION,
    ),
  );
}

export function getPagedPageCount(node: HTMLElement): number {
  const maxLeft = getPagedMaxLeft(node);
  if (maxLeft <= PAGED_SCROLL_POSITION_TOLERANCE_PX) return 1;
  const step = getPagedStep(node);
  const fullSteps = Math.floor(maxLeft / step);
  const remainder = maxLeft - fullSteps * step;
  const hasDistinctTrailingPage = remainder > getPagedTrailingTolerance(step);
  return Math.max(1, fullSteps + 1 + (hasDistinctTrailingPage ? 1 : 0));
}

export function getPagedPageIndex(node: HTMLElement): number {
  const total = getPagedPageCount(node);
  const maxLeft = getPagedMaxLeft(node);
  if (maxLeft <= PAGED_SCROLL_POSITION_TOLERANCE_PX) return 1;
  if (node.scrollLeft >= maxLeft - PAGED_SCROLL_POSITION_TOLERANCE_PX) {
    return total;
  }
  const current = Math.round(node.scrollLeft / getPagedStep(node)) + 1;
  return Math.max(1, Math.min(total, current));
}

export function getPagedLeft(node: HTMLElement, pageIndex: number): number {
  const total = getPagedPageCount(node);
  const maxLeft = getPagedMaxLeft(node);
  if (total <= 1) return 0;
  const clampedPageIndex = Math.max(1, Math.min(total, pageIndex));
  if (clampedPageIndex >= total) return maxLeft;
  return Math.max(
    0,
    Math.min(maxLeft, (clampedPageIndex - 1) * getPagedStep(node)),
  );
}

function getProgressPageIndex(node: HTMLElement, progress: number): number {
  const total = getPagedPageCount(node);
  if (total <= 1) return 1;
  const ratio = clampProgress(progress) / 100;
  if (ratio >= 1) return total;
  return Math.max(1, Math.min(total, Math.round(ratio * (total - 1)) + 1));
}

export function isAtReadingEnd(
  node: HTMLElement,
  pageReader: boolean,
): boolean {
  if (pageReader) {
    return getPagedPageIndex(node) >= getPagedPageCount(node);
  }
  const maxTop = node.scrollHeight - node.clientHeight;
  return maxTop <= 2 || node.scrollTop >= maxTop - 2;
}

function getPageIndex(node: HTMLElement, pageReader: boolean): number {
  if (pageReader) {
    return getPagedPageIndex(node);
  }
  return Math.floor(node.scrollTop / Math.max(1, node.clientHeight)) + 1;
}

export function getPageInfo(node: HTMLElement, pageReader: boolean): PageInfo {
  if (pageReader) {
    const total = getPagedPageCount(node);
    return {
      current: Math.max(1, Math.min(total, getPagedPageIndex(node))),
      total,
    };
  }
  const total = Math.max(
    1,
    Math.ceil(node.scrollHeight / Math.max(1, node.clientHeight)),
  );
  return {
    current: Math.max(1, Math.min(total, getPageIndex(node, false))),
    total,
  };
}

export function scrollToProgress(
  node: HTMLElement,
  progress: number,
  pageReader: boolean,
  behavior: ScrollBehavior,
): void {
  const ratio = clampProgress(progress) / 100;
  if (pageReader) {
    const pageIndex = getProgressPageIndex(node, progress);
    node.scrollTo({ left: getPagedLeft(node, pageIndex), behavior });
    return;
  }
  const maxTop = node.scrollHeight - node.clientHeight;
  node.scrollTo({ top: maxTop * ratio, behavior });
}

export function getNormalizedWheelDelta(
  event: WheelEvent<HTMLElement>,
): number {
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

function virtualScrollAnchorIndex(
  scrollTop: number,
  offsets: readonly number[],
): number {
  const count = Math.max(0, offsets.length - 1);
  if (count === 0) return 0;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((offsets[mid] ?? 0) <= scrollTop) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

export function virtualScrollAnchorDelta(
  scrollTop: number,
  currentOffsets: readonly number[],
  nextOffsets: readonly number[],
): number {
  const anchorIndex = virtualScrollAnchorIndex(scrollTop, currentOffsets);
  return (nextOffsets[anchorIndex] ?? 0) - (currentOffsets[anchorIndex] ?? 0);
}

export function getTapZone(
  rect: DOMRect,
  clientX: number,
  clientY: number,
): ReaderTapZone {
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
  return `${row}${column}` as ReaderTapZone;
}
