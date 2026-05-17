export interface VirtualRange {
  start: number;
  end: number;
}

function safeDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((values[mid] ?? 0) < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((values[mid] ?? 0) <= target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

export function prefixSegmentHeights(
  heights: readonly number[],
  gap = 0,
): number[] {
  const offsets = [0];
  const safeGap = safeDimension(gap);
  for (let index = 0; index < heights.length; index += 1) {
    offsets.push(
      offsets[offsets.length - 1]! +
        safeDimension(heights[index] ?? 0) +
        (index < heights.length - 1 ? safeGap : 0),
    );
  }
  return offsets;
}

export function virtualRangeForScroll(
  scrollTop: number,
  viewportHeight: number,
  offsets: readonly number[],
  overscanPx: number,
): VirtualRange {
  const count = Math.max(0, offsets.length - 1);
  if (count === 0) return { start: 0, end: -1 };

  const startY = Math.max(
    0,
    safeDimension(scrollTop) - safeDimension(overscanPx),
  );
  const endY =
    safeDimension(scrollTop) +
    safeDimension(viewportHeight) +
    safeDimension(overscanPx);
  const start = Math.min(
    count - 1,
    Math.max(0, lowerBound(offsets, startY) - 1),
  );
  const end = Math.min(count - 1, Math.max(start, upperBound(offsets, endY)));
  return { start, end };
}

export function pageNumbersForVirtualRange(
  range: VirtualRange,
  pageCount: number,
): number[] {
  const count = Math.max(0, Math.floor(pageCount));
  if (count === 0) return [];
  if (range.end < range.start) return [];
  const start = Math.max(0, Math.min(count - 1, Math.floor(range.start)));
  const end = Math.max(start, Math.min(count - 1, Math.floor(range.end)));
  return Array.from(
    { length: end - start + 1 },
    (_, index) => start + index + 1,
  );
}

export function virtualRangesEqual(
  left: VirtualRange,
  right: VirtualRange,
): boolean {
  return left.start === right.start && left.end === right.end;
}
