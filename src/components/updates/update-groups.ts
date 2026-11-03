import type { LibraryUpdateEntry } from "../../db/queries/chapter";

/** A novel with more new chapters than this on one day collapses into one row. */
export const UPDATE_RUN_COLLAPSE_LIMIT = 3;

export type UpdateListItem =
  | { kind: "chapter"; entry: LibraryUpdateEntry }
  | {
      kind: "run";
      /** The run's chapters in list order. */
      entries: LibraryUpdateEntry[];
      /** The lowest-position chapter, which a tap on the run opens. */
      earliest: LibraryUpdateEntry;
      key: string;
    };

export interface UpdateDateSection {
  /** Local midnight of the day, in milliseconds. */
  dayStart: number;
  items: UpdateListItem[];
}

function localDayStart(epochSeconds: number): number {
  const date = new Date(epochSeconds * 1000);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function collapseNovelRuns(
  dayStart: number,
  entries: readonly LibraryUpdateEntry[],
): UpdateListItem[] {
  const byNovel = new Map<number, LibraryUpdateEntry[]>();
  for (const entry of entries) {
    const novelEntries = byNovel.get(entry.novelId);
    if (novelEntries) novelEntries.push(entry);
    else byNovel.set(entry.novelId, [entry]);
  }

  const items: UpdateListItem[] = [];
  const emittedRuns = new Set<number>();
  for (const entry of entries) {
    const novelEntries = byNovel.get(entry.novelId)!;
    if (novelEntries.length <= UPDATE_RUN_COLLAPSE_LIMIT) {
      items.push({ kind: "chapter", entry });
      continue;
    }
    if (emittedRuns.has(entry.novelId)) continue;
    emittedRuns.add(entry.novelId);
    items.push({
      kind: "run",
      earliest: novelEntries.reduce((earliest, candidate) =>
        candidate.position < earliest.position ? candidate : earliest,
      ),
      entries: novelEntries,
      key: `${dayStart}:${entry.novelId}`,
    });
  }
  return items;
}

/**
 * Groups update rows by the local day they were found, keeping the incoming
 * order. Within a day, a novel's chapters stay individual rows unless it has
 * more than `UPDATE_RUN_COLLAPSE_LIMIT`, which become one run at its first row.
 */
export function groupUpdatesByDate(
  entries: readonly LibraryUpdateEntry[],
): UpdateDateSection[] {
  const days = new Map<number, LibraryUpdateEntry[]>();
  for (const entry of entries) {
    const dayStart = localDayStart(entry.foundAt);
    const dayEntries = days.get(dayStart);
    if (dayEntries) dayEntries.push(entry);
    else days.set(dayStart, [entry]);
  }
  return [...days].map(([dayStart, dayEntries]) => ({
    dayStart,
    items: collapseNovelRuns(dayStart, dayEntries),
  }));
}

/** Whole local days between `dayStart` and the day containing `now`. */
export function daysBefore(dayStart: number, now: Date): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((today - dayStart) / (24 * 60 * 60 * 1000));
}
