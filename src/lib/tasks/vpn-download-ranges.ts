import type { ChapterRow } from "../../db/queries/chapter";

export interface VpnDownloadRangeAssignment {
  startChapterId: number;
  endChapterId: number;
}

/**
 * Selected chapters per VPN download chunk. Spec V3 starts at 50; it is a
 * fixed app value, not a user setting, until device measurement revises it.
 */
export const VPN_DOWNLOAD_CHUNK_CHAPTERS = 50;

/**
 * How many contiguous chunks a work's selection splits into. Each chunk is a
 * frozen range that leases a server only when a free worker takes it, so
 * parallelism grows with the servers available instead of being fixed by
 * the worker count at enrollment.
 */
export function vpnDownloadChunkCount(selectedChapterCount: number): number {
  return Math.max(1, Math.ceil(selectedChapterCount / VPN_DOWNLOAD_CHUNK_CHAPTERS));
}

export interface VpnDownloadRangePlan extends VpnDownloadRangeAssignment {
  chapterIds: number[];
  selectedChapterIds: number[];
}

export function planVpnDownloadRanges(
  orderedChapters: readonly Pick<ChapterRow, "id">[],
  selectedChapterIds: readonly number[],
  rangeCount: number,
  assignments?: readonly VpnDownloadRangeAssignment[],
): VpnDownloadRangePlan[] {
  const positions = new Map<number, number>();
  for (const [position, chapter] of orderedChapters.entries()) {
    if (!Number.isSafeInteger(chapter.id) || chapter.id <= 0) {
      throw new Error("Invalid chapter identity in VPN download catalog.");
    }
    if (positions.has(chapter.id)) throw new Error("Duplicate chapter in VPN download catalog.");
    positions.set(chapter.id, position);
  }
  const selected = new Set(selectedChapterIds);
  if (selected.size !== selectedChapterIds.length) throw new Error("Duplicate selected chapter.");
  if (!selected.size) throw new Error("Select at least one chapter.");
  let first = orderedChapters.length;
  let last = -1;
  for (const id of selected) {
    const position = positions.get(id);
    if (position === undefined) throw new Error("Selected chapter is not in the ordered catalog.");
    first = Math.min(first, position);
    last = Math.max(last, position);
  }
  if (!Number.isSafeInteger(rangeCount) || rangeCount < 1) throw new Error("VPN range count must be a positive integer.");
  const orderedSelected = orderedChapters.filter(chapter => selected.has(chapter.id));
  const count = Math.min(orderedSelected.length, rangeCount);
  let next = first;
  let nextSelected = 0;
  const defaults = (): VpnDownloadRangeAssignment[] => Array.from({ length: count }, (_, index) => {
    const size = Math.floor(orderedSelected.length / count) + (index < orderedSelected.length % count ? 1 : 0);
    const startChapterId = orderedChapters[next]!.id;
    nextSelected += size;
    const end = index === count - 1 ? last : positions.get(orderedSelected[nextSelected]!.id)! - 1;
    next = end + 1;
    return { startChapterId, endChapterId: orderedChapters[end]!.id };
  });
  const covered = new Set<number>();
  const ranges = (assignments ?? defaults()).map((assignment) => {
    const start = positions.get(assignment.startChapterId);
    const end = positions.get(assignment.endChapterId);
    if (start === undefined || end === undefined || start < first || end > last) {
      throw new Error("Range boundary is outside the selected chapter span.");
    }
    if (start > end) throw new Error("VPN download range is reversed.");
    const chapterIds = orderedChapters.slice(start, end + 1).map(({ id }) => id);
    for (const id of chapterIds) {
      if (covered.has(id)) throw new Error("VPN download ranges overlap.");
      covered.add(id);
    }
    return { startChapterId: assignment.startChapterId, endChapterId: assignment.endChapterId, chapterIds, selectedChapterIds: chapterIds.filter((id) => selected.has(id)) };
  });
  if (selectedChapterIds.some((id) => !covered.has(id))) throw new Error("Requested chapters are unassigned.");
  return ranges.sort((left, right) => positions.get(left.startChapterId)! - positions.get(right.startChapterId)!);
}
