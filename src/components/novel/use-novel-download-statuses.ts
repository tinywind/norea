import { useEffect, useMemo, useState } from "react";
import { type ChapterListRow } from "../../db/queries/chapter";
import {
  getChapterDownloadStatus,
  subscribeChapterDownloads,
  type ChapterDownloadStatus,
} from "../../lib/tasks/chapter-download";
import { useChapterDownloadFailureSnapshot } from "../../lib/tasks/hooks";

// Big batches change several chapters per frame; each flush re-renders the whole novel page.
export const STATUS_FLUSH_MIN_INTERVAL_MS = 250;

function sameStatus(current: ChapterDownloadStatus | undefined, next: ChapterDownloadStatus) {
  return current?.kind === next.kind &&
    ((current.kind !== "queued" && current.kind !== "running") ||
      ((next.kind === "queued" || next.kind === "running") && current.phase === next.phase)) &&
    (current.kind !== "failed" || (next.kind === "failed" && current.error === next.error));
}

export function useNovelDownloadStatuses(
  id: number,
  rows: readonly ChapterListRow[],
  active = true,
  pluginId?: string,
) {
  const failures = useChapterDownloadFailureSnapshot(active);
  const [statuses, setStatuses] = useState<
    ReadonlyMap<number, ChapterDownloadStatus>
  >(() => new Map());

  useEffect(() => {
    if (!active) return;
    let animationFrame: number | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let lastFlushAt = Number.NEGATIVE_INFINITY;
    let pendingStatuses = new Map<number, ChapterDownloadStatus | null>();

    const flushStatuses = () => {
      animationFrame = null;
      flushTimer = undefined;
      lastFlushAt = performance.now();
      if (pendingStatuses.size === 0) return;
      const updates = pendingStatuses;
      pendingStatuses = new Map();
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
        return next ?? prev;
      });
    };

    const unsubscribe = subscribeChapterDownloads((event) => {
      if (event.job.novelId !== undefined && event.job.novelId !== id) return;
      pendingStatuses.set(
        event.job.id,
        event.status.kind === "cancelled" ? null : event.status,
      );
      if (animationFrame !== null || flushTimer !== undefined) return;
      const waitMs = lastFlushAt + STATUS_FLUSH_MIN_INTERVAL_MS - performance.now();
      if (waitMs > 0) flushTimer = setTimeout(flushStatuses, waitMs);
      else animationFrame = requestAnimationFrame(flushStatuses);
    });

    return () => {
      unsubscribe();
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      clearTimeout(flushTimer);
    };
  }, [id, active]);

  useEffect(() => {
    if (!active) return;
    const currentStatuses = new Map<number, ChapterDownloadStatus>();
    for (const row of rows) {
      const status = getChapterDownloadStatus(row.id);
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
    if (!active || !pluginId || failures.length === 0) return statuses;
    const chapterIds = new Set(rows.filter(row => row.novelId === id).map(row => row.id));
    let merged: Map<number, ChapterDownloadStatus> | null = null;
    for (const failure of failures) {
      if (failure.pluginId !== pluginId || !chapterIds.has(failure.chapterId) ||
          statuses.has(failure.chapterId) || getChapterDownloadStatus(failure.chapterId)) continue;
      merged ??= new Map(statuses);
      merged.set(failure.chapterId, { kind: "failed", error: failure.messageSummary });
    }
    return merged ?? statuses;
  }, [active, failures, id, pluginId, rows, statuses]);
}
