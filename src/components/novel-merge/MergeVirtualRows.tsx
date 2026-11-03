import {
  type ReactNode,
  type UIEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const OVERSCAN_PX = 480;
const FALLBACK_ROOT_FONT_PX = 16;
const FALLBACK_VIEWPORT_PX = 640;

interface MergeVirtualRowsProps<T> {
  "aria-label": string;
  className?: string;
  itemKey: (item: T) => string;
  items: readonly T[];
  renderItem: (item: T) => ReactNode;
  /** Fixed row height in rem, so rows scale with the UI font size. */
  rowHeightRem: (item: T) => number;
  /** Scrolls this row into view whenever it changes. */
  scrollToKey?: string | null;
}

function rootFontPx(): number {
  if (typeof window === "undefined") return FALLBACK_ROOT_FONT_PX;
  const size = parseFloat(window.getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) && size > 0 ? size : FALLBACK_ROOT_FONT_PX;
}

function firstOffsetAtOrAfter(offsets: readonly number[], value: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (offsets[middle + 1]! <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * A scroll viewport that renders only the fixed-height rows near the visible
 * range. Row heights come from rem values so they follow the UI font scale.
 */
export function MergeVirtualRows<T>({
  "aria-label": ariaLabel,
  className,
  itemKey,
  items,
  renderItem,
  rowHeightRem,
  scrollToKey,
}: MergeVirtualRowsProps<T>) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const [remPx, setRemPx] = useState(rootFontPx);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(FALLBACK_VIEWPORT_PX);

  const offsets = useMemo(() => {
    const result = [0];
    for (const item of items) {
      result.push(result[result.length - 1]! + rowHeightRem(item) * remPx);
    }
    return result;
  }, [items, remPx, rowHeightRem]);
  const totalHeight = offsets[offsets.length - 1]!;

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      setRemPx(rootFontPx());
      setViewportHeight(element.clientHeight || FALLBACK_VIEWPORT_PX);
    };
    measure();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resizeObserver?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, []);

  const scrollIndex =
    scrollToKey == null ? -1 : items.findIndex((item) => itemKey(item) === scrollToKey);
  useEffect(() => {
    const element = viewportRef.current;
    if (!element || scrollIndex < 0) return;
    const top = offsets[scrollIndex]!;
    const bottom = offsets[scrollIndex + 1]!;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = bottom - element.clientHeight;
    }
    setScrollTop(element.scrollTop);
    // Offsets are read but not tracked, so ordinary edits never move the list.
  }, [scrollIndex, scrollToKey]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      setScrollTop(element.scrollTop);
    });
  };

  const start = items.length === 0
    ? 0
    : firstOffsetAtOrAfter(offsets, Math.max(0, scrollTop - OVERSCAN_PX));
  let end = start;
  const limit = scrollTop + viewportHeight + OVERSCAN_PX;
  while (end < items.length && offsets[end]! < limit) end += 1;

  return (
    <div
      aria-label={ariaLabel}
      className={`norea-merge-virtual-viewport${className ? ` ${className}` : ""}`}
      onScroll={handleScroll}
      ref={viewportRef}
      role="list"
    >
      <div className="norea-merge-virtual-spacer" style={{ height: totalHeight }}>
        {items.slice(start, end).map((item, index) => (
          <div
            className="norea-merge-virtual-row"
            key={itemKey(item)}
            role="listitem"
            style={{
              height: `${rowHeightRem(item)}rem`,
              transform: `translateY(${offsets[start + index]!}px)`,
            }}
          >
            {renderItem(item)}
          </div>
        ))}
      </div>
    </div>
  );
}
