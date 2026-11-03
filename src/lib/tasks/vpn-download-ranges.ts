import type { ChapterRow } from "../../db/queries/chapter";

export interface VpnDownloadRangeAssignment {
  profileId: string;
  startChapterId: number;
  endChapterId: number;
}

export interface VpnDownloadRangePlan extends VpnDownloadRangeAssignment {
  chapterIds: number[];
  selectedChapterIds: number[];
}

export function planVpnDownloadRanges(
  orderedChapters: readonly Pick<ChapterRow, "id">[],
  selectedChapterIds: readonly number[],
  profileIds: readonly string[],
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
  const profiles = new Set(profileIds);
  if (!profiles.size || profiles.size !== profileIds.length || profileIds.some((id) => !id.trim())) {
    throw new Error("VPN profiles must be nonempty and distinct.");
  }
  const orderedSelected = orderedChapters.filter(chapter => selected.has(chapter.id));
  const count = Math.min(orderedSelected.length, profileIds.length);
  let next = first;
  let nextSelected = 0;
  const defaults = (): VpnDownloadRangeAssignment[] => Array.from({ length: count }, (_, index) => {
    const size = Math.floor(orderedSelected.length / count) + (index < orderedSelected.length % count ? 1 : 0);
    const startChapterId = orderedChapters[next]!.id;
    nextSelected += size;
    const end = index === count - 1 ? last : positions.get(orderedSelected[nextSelected]!.id)! - 1;
    next = end + 1;
    return { profileId: profileIds[index]!, startChapterId, endChapterId: orderedChapters[end]!.id };
  });
  const assignedProfiles = new Set<string>();
  const covered = new Set<number>();
  const ranges = (assignments ?? defaults()).map((assignment) => {
    if (!profiles.has(assignment.profileId) || assignedProfiles.has(assignment.profileId)) {
      throw new Error("Each range requires a distinct available VPN profile.");
    }
    assignedProfiles.add(assignment.profileId);
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
    return { ...assignment, chapterIds, selectedChapterIds: chapterIds.filter((id) => selected.has(id)) };
  });
  if (selectedChapterIds.some((id) => !covered.has(id))) throw new Error("Requested chapters are unassigned.");
  return ranges.sort((left, right) => positions.get(left.startChapterId)! - positions.get(right.startChapterId)!);
}
