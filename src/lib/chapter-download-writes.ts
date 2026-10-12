import { throwIfAborted } from "./abort";

const activeWrites = new Map<number, Set<Promise<void>>>();
const activeDeletions = new Map<number, Set<Promise<void>>>();

/** Tracks local filesystem or database writes; keep network waits outside. */
export async function withChapterDownloadWrite<T>(
  chapterId: number,
  signal: AbortSignal | undefined,
  write: () => Promise<T>,
): Promise<T> {
  throwIfAborted(signal, "Chapter download was cancelled.");
  for (;;) {
    const deletions = activeDeletions.get(chapterId);
    if (!deletions) break;
    await Promise.all(deletions);
    throwIfAborted(signal, "Chapter download was cancelled.");
  }
  const writes = activeWrites.get(chapterId) ?? new Set<Promise<void>>();
  activeWrites.set(chapterId, writes);
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  writes.add(settled);
  try {
    const result = await write();
    throwIfAborted(signal, "Chapter download was cancelled.");
    return result;
  } finally {
    writes.delete(settled);
    if (writes.size === 0) activeWrites.delete(chapterId);
    settle();
  }
}

/** Blocks new local writes while removal cancels and drains existing writes. */
export async function withChapterDownloadDeletion<T>(
  chapterIds: readonly number[],
  remove: () => Promise<T>,
): Promise<T> {
  const selectedChapterIds = new Set(chapterIds);
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  for (const chapterId of selectedChapterIds) {
    const deletions = activeDeletions.get(chapterId) ?? new Set<Promise<void>>();
    activeDeletions.set(chapterId, deletions);
    deletions.add(settled);
  }
  try {
    return await remove();
  } finally {
    for (const chapterId of selectedChapterIds) {
      const deletions = activeDeletions.get(chapterId)!;
      deletions.delete(settled);
      if (deletions.size === 0) activeDeletions.delete(chapterId);
    }
    settle();
  }
}

/** Abort selected downloads first, inside a chapter download deletion scope. */
export async function waitForChapterDownloadWrites(
  chapterIds: readonly number[],
): Promise<void> {
  await Promise.all(chapterIds.flatMap((chapterId) => [
    ...(activeWrites.get(chapterId) ?? []),
  ]));
}
