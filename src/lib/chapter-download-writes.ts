import { isAbortError, throwIfAborted } from "./abort";
import { ChapterStorageError, isChapterStorageError } from "./chapter-storage-error";

const activeWrites = new Map<number, Set<Promise<void>>>();
const activeDeletions = new Map<number, Set<Promise<void>>>();
const activeSnapshotReads = new Map<number, Set<Promise<void>>>();
const downloadRevisions = new Map<number, number>();
let downloadRevision = 0;

export function currentChapterDownloadRevision(): number {
  return downloadRevision;
}

export function canAdoptChapterDownloadSnapshot(chapterId: number, revision: number): boolean {
  return !activeWrites.has(chapterId) && !activeDeletions.has(chapterId)
    && (downloadRevisions.get(chapterId) ?? 0) <= revision;
}

export type HoldChapterDownloadSnapshot = (chapterId: number) => boolean;

/** Hold verified files through a database commit; skip busy chapters without waiting inside SQLite. */
export async function withChapterDownloadSnapshotReads<T>(
  read: (hold: HoldChapterDownloadSnapshot) => Promise<T>,
): Promise<T> {
  const held = new Set<number>();
  let settle!: () => void;
  const settled = new Promise<void>(resolve => { settle = resolve; });
  const hold: HoldChapterDownloadSnapshot = chapterId => {
    if (held.has(chapterId)) return true;
    if (activeWrites.has(chapterId) || activeDeletions.has(chapterId)) return false;
    const reads = activeSnapshotReads.get(chapterId) ?? new Set<Promise<void>>();
    activeSnapshotReads.set(chapterId, reads);
    reads.add(settled);
    held.add(chapterId);
    return true;
  };
  try {
    return await read(hold);
  } finally {
    for (const chapterId of held) {
      const reads = activeSnapshotReads.get(chapterId)!;
      reads.delete(settled);
      if (!reads.size) activeSnapshotReads.delete(chapterId);
    }
    settle();
  }
}

/** Tracks local filesystem or database writes; keep network waits outside. */
export async function withChapterDownloadWrite<T>(
  chapterId: number,
  signal: AbortSignal | undefined,
  write: () => Promise<T>,
  expectedRevision?: number,
): Promise<T> {
  throwIfAborted(signal, "Chapter download was cancelled.");
  for (;;) {
    const pending = [...(activeDeletions.get(chapterId) ?? []), ...(activeSnapshotReads.get(chapterId) ?? [])];
    if (!pending.length) break;
    await Promise.all(pending);
    throwIfAborted(signal, "Chapter download was cancelled.");
  }
  if (expectedRevision !== undefined && (activeWrites.has(chapterId) || (downloadRevisions.get(chapterId) ?? 0) > expectedRevision)) {
    throw new Error("Chapter download changed during transfer.");
  }
  downloadRevisions.set(chapterId, ++downloadRevision);
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
  } catch (error) {
    if (isAbortError(error) || isChapterStorageError(error)) throw error;
    throw new ChapterStorageError("Read or write chapter storage", error);
  } finally {
    downloadRevisions.set(chapterId, ++downloadRevision);
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
    downloadRevisions.set(chapterId, ++downloadRevision);
    const deletions = activeDeletions.get(chapterId) ?? new Set<Promise<void>>();
    activeDeletions.set(chapterId, deletions);
    deletions.add(settled);
  }
  try {
    const reads = [...selectedChapterIds].flatMap(chapterId => [...(activeSnapshotReads.get(chapterId) ?? [])]);
    if (reads.length) await Promise.all(reads);
    return await remove();
  } finally {
    for (const chapterId of selectedChapterIds) {
      downloadRevisions.set(chapterId, ++downloadRevision);
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
