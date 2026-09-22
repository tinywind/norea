import { isRecord } from "./type-guards";

export interface AppNavigationEntry {
  historyIndex: number | null;
  href: string;
  pathname: string;
}

export interface AppNavigationBackTarget extends AppNavigationEntry {
  steps: number;
}

const STORAGE_KEY = "norea.appNavigationHistory.v1";
const MAX_ENTRIES = 80;
const TANSTACK_HISTORY_INDEX_KEY = "__TSR_index";

let cachedEntries: AppNavigationEntry[] | null = null;

function isNavigationEntry(value: unknown): value is AppNavigationEntry {
  return (
    isRecord(value) &&
    typeof value.href === "string" &&
    typeof value.pathname === "string" &&
    (typeof value.historyIndex === "number" || value.historyIndex === null)
  );
}

function readEntries(): AppNavigationEntry[] {
  if (cachedEntries) return cachedEntries;
  if (typeof window === "undefined") {
    cachedEntries = [];
    return cachedEntries;
  }

  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cachedEntries = Array.isArray(parsed)
      ? parsed.filter(isNavigationEntry)
      : [];
  } catch {
    cachedEntries = [];
  }

  return cachedEntries;
}

function writeEntries(entries: AppNavigationEntry[]): void {
  cachedEntries = entries;
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    cachedEntries = entries;
  }
}

function lastHistoryIndexEntryIndex(
  entries: readonly AppNavigationEntry[],
  historyIndex: number,
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.historyIndex === historyIndex) return index;
  }
  return -1;
}

function lastTargetEntryIndex(
  entries: readonly AppNavigationEntry[],
  target: Pick<AppNavigationEntry, "historyIndex" | "href">,
): number {
  if (target.historyIndex !== null) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (
        entry?.historyIndex === target.historyIndex &&
        entry.href === target.href
      ) {
        return index;
      }
    }
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.href === target.href) return index;
  }

  return -1;
}

export function getAppNavigationHistoryIndex(state: unknown): number | null {
  if (!isRecord(state)) return null;
  const value = state[TANSTACK_HISTORY_INDEX_KEY];
  return typeof value === "number" ? value : null;
}

export function recordAppNavigationEntry(entry: AppNavigationEntry): void {
  if (!entry.href || !entry.pathname) return;

  const entries = [...readEntries()];
  const lastEntry = entries.at(-1);
  if (
    lastEntry?.href === entry.href &&
    lastEntry.historyIndex === entry.historyIndex
  ) {
    return;
  }

  const historyIndex = entry.historyIndex;
  if (historyIndex !== null) {
    const sameHistoryIndex = lastHistoryIndexEntryIndex(
      entries,
      historyIndex,
    );
    if (sameHistoryIndex >= 0) {
      entries.splice(sameHistoryIndex, entries.length - sameHistoryIndex, entry);
      writeEntries(entries);
      return;
    }

    if (
      lastEntry?.historyIndex !== null &&
      lastEntry?.historyIndex !== undefined &&
      historyIndex <= lastEntry.historyIndex
    ) {
      const nextEntries = entries.filter(
        (current) =>
          current.historyIndex === null ||
          current.historyIndex < historyIndex,
      );
      nextEntries.push(entry);
      writeEntries(nextEntries.slice(-MAX_ENTRIES));
      return;
    }
  }

  entries.push(entry);
  writeEntries(entries.slice(-MAX_ENTRIES));
}

export function findPreviousAppHistoryEntry(
  currentHref: string,
  ignoredPathnames: readonly string[],
): AppNavigationBackTarget | null {
  const entries = readEntries();
  const currentEntryIndex = lastTargetEntryIndex(entries, {
    historyIndex: null,
    href: currentHref,
  });
  if (currentEntryIndex <= 0) return null;

  const currentEntry = entries[currentEntryIndex];
  const ignored = new Set(ignoredPathnames);

  for (let index = currentEntryIndex - 1; index >= 0; index -= 1) {
    const candidate = entries[index];
    if (!candidate) continue;
    if (ignored.has(candidate.pathname)) continue;
    if (candidate.href === currentHref) continue;

    const steps =
      currentEntry.historyIndex !== null && candidate.historyIndex !== null
        ? currentEntry.historyIndex - candidate.historyIndex
        : currentEntryIndex - index;

    if (steps <= 0) continue;

    return {
      ...candidate,
      steps,
    };
  }

  return null;
}

export function trimAppNavigationHistoryTo(
  target: Pick<AppNavigationEntry, "historyIndex" | "href">,
): void {
  const entries = readEntries();
  const targetIndex = lastTargetEntryIndex(entries, target);
  if (targetIndex < 0) return;
  writeEntries(entries.slice(0, targetIndex + 1));
}
