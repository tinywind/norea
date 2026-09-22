import { useEffect, useState } from "react";
import { type ChapterListRow } from "../../db/queries/chapter";
import {
  listChapterDownloadStatuses,
  subscribeChapterDownloads,
  type ChapterDownloadStatus,
} from "../../lib/tasks/chapter-download";

export function useNovelDownloadStatuses(
  id: number,
  rows: readonly ChapterListRow[],
) {
  const [statuses, setStatuses] = useState<
    ReadonlyMap<number, ChapterDownloadStatus>
  >(() => new Map());

  useEffect(() => {
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
            if (
              current?.kind === status.kind &&
              (current.kind !== "failed" ||
                (status.kind === "failed" && current.error === status.error))
            ) {
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
  }, [id]);

  useEffect(() => {
    if (rows.length === 0) return;
    const currentStatuses = listChapterDownloadStatuses();

    setStatuses((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [chapterId, status] of currentStatuses) {
        if (status?.kind === "cancelled") {
          if (next.delete(chapterId)) changed = true;
          continue;
        }
        if (next.get(chapterId) !== status) {
          next.set(chapterId, status);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rows]);

  return statuses;
}
