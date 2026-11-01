import { useEffect, useState } from "react";
import { type ChapterListRow } from "../../db/queries/chapter";
import {
  getChapterDownloadStatus,
  subscribeChapterDownloads,
  type ChapterDownloadStatus,
} from "../../lib/tasks/chapter-download";

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
) {
  const [statuses, setStatuses] = useState<
    ReadonlyMap<number, ChapterDownloadStatus>
  >(() => new Map());

  useEffect(() => {
    if (!active) return;
    let animationFrame: number | null = null;
    let pendingStatuses = new Map<number, ChapterDownloadStatus | null>();

    const flushStatuses = () => {
      animationFrame = null;
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
      animationFrame ??= requestAnimationFrame(flushStatuses);
    });

    return () => {
      unsubscribe();
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
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

  return statuses;
}
