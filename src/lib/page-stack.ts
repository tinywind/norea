export interface PageStackLocation {
  historyIndex: number;
  historyKey: string;
  pathname: string;
  search: Record<string, unknown>;
}

export interface PageStackEntry {
  historyIndex: number;
  instanceKey: string;
  pathname: string;
  search: Record<string, unknown>;
}

export interface PageStackOptions {
  maxHiddenEntries: number;
  /** Pathnames whose page keeps one instance across history entries. */
  singleInstancePathnames: ReadonlySet<string>;
  stackedPathnames: ReadonlySet<string>;
}

const HISTORY_KEY_FIELDS = ["__TSR_key", "key"] as const;

export function readHistoryEntryKey(state: unknown): string | null {
  if (state === null || typeof state !== "object") return null;
  const record = state as Record<string, unknown>;
  for (const field of HISTORY_KEY_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

export function pageInstanceKey(
  location: Pick<PageStackLocation, "historyKey" | "pathname">,
  options: Pick<PageStackOptions, "singleInstancePathnames">,
): string {
  return options.singleInstancePathnames.has(location.pathname)
    ? location.pathname
    : `${location.pathname}#${location.historyKey}`;
}

function isSameStack(
  previous: readonly PageStackEntry[],
  next: readonly PageStackEntry[],
): boolean {
  return (
    previous.length === next.length &&
    previous.every((entry, index) => entry === next[index])
  );
}

function trimHiddenEntries(
  entries: readonly PageStackEntry[],
  currentKey: string | null,
  maxHiddenEntries: number,
): readonly PageStackEntry[] {
  const hiddenCount = entries.filter(
    (entry) => entry.instanceKey !== currentKey,
  ).length;
  if (hiddenCount <= maxHiddenEntries) return entries;

  let remainingDrops = hiddenCount - maxHiddenEntries;
  return entries.filter((entry) => {
    if (entry.instanceKey === currentKey || remainingDrops === 0) return true;
    remainingDrops -= 1;
    return false;
  });
}

/**
 * Advances the stack of mounted page instances for a new location. Entries
 * stay ordered by ascending history index; entries at or above the current
 * index that are not the current page were replaced or discarded by history.
 */
export function reducePageStack(
  stack: readonly PageStackEntry[],
  location: PageStackLocation,
  options: PageStackOptions,
): readonly PageStackEntry[] {
  const currentKey = options.stackedPathnames.has(location.pathname)
    ? pageInstanceKey(location, options)
    : null;

  const retained = stack.filter(
    (entry) =>
      entry.instanceKey === currentKey ||
      entry.historyIndex < location.historyIndex,
  );

  let next: readonly PageStackEntry[] = retained;
  if (currentKey !== null) {
    const existing = retained.find((entry) => entry.instanceKey === currentKey);
    if (!existing) {
      next = [
        ...retained,
        {
          historyIndex: location.historyIndex,
          instanceKey: currentKey,
          pathname: location.pathname,
          search: location.search,
        },
      ];
    } else if (
      existing.search !== location.search ||
      existing.historyIndex > location.historyIndex
    ) {
      next = retained.map((entry) =>
        entry === existing
          ? {
              ...entry,
              historyIndex: Math.min(entry.historyIndex, location.historyIndex),
              search: location.search,
            }
          : entry,
      );
    }
  }

  next = trimHiddenEntries(next, currentKey, options.maxHiddenEntries);
  return isSameStack(stack, next) ? stack : next;
}
