import { useEffect, useMemo, useRef, useState } from "react";
import { type ChapterListRow } from "../../db/queries/chapter";
import type { StoredChapterDownloadFailure } from "../../db/queries/chapter-download-failure";
import {
  getChapterDownloadStatus,
  getChapterMediaRepairStatus,
  isChapterDownloadQueued,
  subscribeChapterDownloadBatchProgress,
  subscribeChapterDownloads,
  subscribeChapterMediaRepairs,
  type ChapterDownloadStatus,
} from "../../lib/tasks/chapter-download";
import { useChapterDownloadFailureSnapshot } from "../../lib/tasks/hooks";
import { subscribeVpnDownloadRuntime } from "../../lib/tasks/vpn-download-runtime";

// Big batches change several chapters per frame; each flush re-renders the whole novel page.
export const STATUS_FLUSH_MIN_INTERVAL_MS = 250;

const EMPTY_CHAPTER_IDS: ReadonlySet<number> = new Set();

function sameStatus(current: ChapterDownloadStatus | undefined, next: ChapterDownloadStatus) {
  return current?.kind === next.kind &&
    ((current.kind !== "queued" && current.kind !== "running") ||
      ((next.kind === "queued" || next.kind === "running") &&
        current.phase === next.phase &&
        (current.kind !== "queued" || (next.kind === "queued" && current.retryAt === next.retryAt)))) &&
    (current.kind !== "failed" || (next.kind === "failed" && current.error === next.error));
}

function resolveHeldFailureIds(
  id: number,
  rows: readonly ChapterListRow[],
  failures: readonly StoredChapterDownloadFailure[],
  pluginId: string | undefined,
): ReadonlySet<number> {
  if (!pluginId || failures.length === 0) return EMPTY_CHAPTER_IDS;
  const chapterIds = new Set(rows.filter((row) => row.novelId === id).map((row) => row.id));
  if (chapterIds.size === 0) return EMPTY_CHAPTER_IDS;
  const held = new Set<number>();
  for (const failure of failures) {
    if (failure.pluginId === pluginId && chapterIds.has(failure.chapterId)) {
      held.add(failure.chapterId);
    }
  }
  return held;
}

function resolveChapterStatus(
  chapterId: number,
  heldFailureIds: ReadonlySet<number>,
): ChapterDownloadStatus | undefined {
  const download = getChapterDownloadStatus(chapterId);
  const repair = getChapterMediaRepairStatus(chapterId);
  if (download?.kind === "running") return download;
  if (repair?.kind === "running") return repair;
  if (download?.kind === "queued") return download;
  if (repair?.kind === "queued") return repair;
  if (!heldFailureIds.has(chapterId) && isChapterDownloadQueued(chapterId)) {
    return { kind: "queued" };
  }
  const validRepair = repair && repair.kind !== "cancelled" ? repair : undefined;
  const validDownload = download && download.kind !== "cancelled" ? download : undefined;
  return validRepair ?? validDownload;
}

export function useNovelDownloadStatuses(
  id: number,
  rows: readonly ChapterListRow[],
  active = true,
  pluginId?: string,
) {
  const failures = useChapterDownloadFailureSnapshot(active);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const pluginIdRef = useRef(pluginId);
  pluginIdRef.current = pluginId;
  const failuresRef = useRef(failures);
  failuresRef.current = failures;
  const [statuses, setStatuses] = useState<
    ReadonlyMap<number, ChapterDownloadStatus>
  >(() => new Map());

  useEffect(() => {
    if (!active) return;
    let animationFrame: number | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let lastFlushAt = Number.NEGATIVE_INFINITY;
    let pendingStatuses = new Map<number, ChapterDownloadStatus | null>();
    let needsQueueResync = false;

    const flushStatuses = () => {
      animationFrame = null;
      flushTimer = undefined;
      lastFlushAt = performance.now();
      const shouldResyncQueue = needsQueueResync;
      needsQueueResync = false;
      if (pendingStatuses.size === 0 && !shouldResyncQueue) return;
      const updates = pendingStatuses;
      pendingStatuses = new Map();
      const heldFailureIds = shouldResyncQueue
        ? resolveHeldFailureIds(id, rowsRef.current, failuresRef.current, pluginIdRef.current)
        : EMPTY_CHAPTER_IDS;
      setStatuses((prev) => {
        let next: Map<number, ChapterDownloadStatus> | null = null;
        for (const [chapterId, status] of updates) {
          if (status === null) {
            if (!(next ?? prev).has(chapterId)) continue;
            next ??= new Map(prev);
            next.delete(chapterId);
          } else {
            const current = (next ?? prev).get(chapterId);
            if (sameStatus(current, status)) {
              continue;
            }
            next ??= new Map(prev);
            next.set(chapterId, status);
          }
        }
        if (shouldResyncQueue) {
          for (const row of rowsRef.current) {
            if (updates.has(row.id)) continue;
            const resolved = resolveChapterStatus(row.id, heldFailureIds);
            const current = (next ?? prev).get(row.id);
            if (resolved) {
              if (!sameStatus(current, resolved)) {
                next ??= new Map(prev);
                next.set(row.id, resolved);
              }
            } else if (current?.kind === "queued") {
              next ??= new Map(prev);
              next.delete(row.id);
            }
          }
        }
        return next ?? prev;
      });
    };

    const scheduleFlush = () => {
      if (animationFrame !== null || flushTimer !== undefined) return;
      const waitMs = lastFlushAt + STATUS_FLUSH_MIN_INTERVAL_MS - performance.now();
      if (waitMs > 0) flushTimer = setTimeout(flushStatuses, waitMs);
      else animationFrame = requestAnimationFrame(flushStatuses);
    };

    const enqueueStatusUpdate = (chapterId: number, status: ChapterDownloadStatus) => {
      if (status.kind === "cancelled") {
        const heldFailureIds = resolveHeldFailureIds(id, rowsRef.current, failuresRef.current, pluginIdRef.current);
        pendingStatuses.set(chapterId, resolveChapterStatus(chapterId, heldFailureIds) ?? null);
      } else {
        pendingStatuses.set(chapterId, status);
      }
      scheduleFlush();
    };

    const unsubscribeDownload = subscribeChapterDownloads((event) => {
      if (event.job.novelId !== undefined && event.job.novelId !== id) return;
      enqueueStatusUpdate(event.job.id, event.status);
    });
    const unsubscribeRepair = subscribeChapterMediaRepairs((event) => {
      if (event.novelId !== undefined ? event.novelId !== id : !rowsRef.current.some((row) => row.id === event.chapterId)) {
        return;
      }
      enqueueStatusUpdate(event.chapterId, event.status);
    });
    const scheduleQueueResync = () => {
      needsQueueResync = true;
      scheduleFlush();
    };
    const unsubscribeBatch = subscribeChapterDownloadBatchProgress(scheduleQueueResync);
    const unsubscribeVpn = subscribeVpnDownloadRuntime(scheduleQueueResync);

    return () => {
      unsubscribeDownload();
      unsubscribeRepair();
      unsubscribeBatch();
      unsubscribeVpn();
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      clearTimeout(flushTimer);
    };
  }, [id, active]);

  useEffect(() => {
    if (!active) return;
    const heldFailureIds = resolveHeldFailureIds(id, rows, failuresRef.current, pluginIdRef.current);
    const currentStatuses = new Map<number, ChapterDownloadStatus>();
    for (const row of rows) {
      const status = resolveChapterStatus(row.id, heldFailureIds);
      if (status && status.kind !== "cancelled") currentStatuses.set(row.id, status);
    }

    setStatuses((prev) => {
      if (prev.size !== currentStatuses.size) return currentStatuses;
      for (const [chapterId, status] of currentStatuses) {
        if (!sameStatus(prev.get(chapterId), status)) return currentStatuses;
      }
      return prev;
    });
  }, [id, rows, active]);

  return useMemo(() => {
    if (!active) return statuses;
    let merged: Map<number, ChapterDownloadStatus> | null = null;
    const heldFailureIds = new Set<number>();

    if (pluginId && failures.length > 0) {
      const chapterIds = new Set(rows.filter((row) => row.novelId === id).map((row) => row.id));
      for (const failure of failures) {
        if (failure.pluginId !== pluginId || !chapterIds.has(failure.chapterId)) continue;
        heldFailureIds.add(failure.chapterId);
        if (
          statuses.has(failure.chapterId) ||
          getChapterDownloadStatus(failure.chapterId) ||
          getChapterMediaRepairStatus(failure.chapterId)
        ) {
          continue;
        }
        merged ??= new Map(statuses);
        merged.set(failure.chapterId, { kind: "failed", error: failure.messageSummary });
      }
    }

    for (const row of rows) {
      const current = (merged ?? statuses).get(row.id);
      if (current || heldFailureIds.has(row.id)) continue;
      if (isChapterDownloadQueued(row.id)) {
        merged ??= new Map(statuses);
        merged.set(row.id, { kind: "queued" });
      }
    }

    return merged ?? statuses;
  }, [active, failures, id, pluginId, rows, statuses]);
}
