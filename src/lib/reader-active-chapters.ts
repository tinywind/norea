const activeIds = new Set<number>();
const listeners = new Set<(removedIds: readonly number[]) => void>();

/** Records the chapters currently displayed or pre-rendered by the active reader page. */
export function setActiveReaderChapters(ids: readonly number[]): void {
  const next = new Set<number>();
  for (const id of ids) {
    if (Number.isInteger(id) && id > 0) next.add(id);
  }
  const removed: number[] = [];
  for (const id of activeIds) {
    if (!next.has(id)) removed.push(id);
  }
  activeIds.clear();
  for (const id of next) activeIds.add(id);
  if (removed.length > 0) {
    for (const listener of listeners) listener(removed);
  }
}

export function clearActiveReaderChapters(): void {
  setActiveReaderChapters([]);
}

export function getActiveReaderChapterIds(): ReadonlySet<number> {
  return new Set(activeIds);
}

/** Notifies listeners whenever one or more chapters leave the active reader protection set. */
export function subscribeActiveReaderChapters(
  listener: (removedIds: readonly number[]) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
