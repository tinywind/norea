import { useEffect, useState } from "react";
import { taskScheduler } from "../../lib/tasks/scheduler";
import type { TaskProgress, TaskRecord } from "../../lib/tasks/task-types";

const RADIUS = 9;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function isChapterDownloadTask(task: TaskRecord, chapterId: number): boolean {
  return (task.kind === "chapter.download" || task.kind === "chapter.repairMedia") && task.subject?.chapterId === chapterId;
}

function runningProgress(chapterId: number): TaskProgress | undefined {
  return taskScheduler.getSnapshot().records.find(task => task.status === "running" && isChapterDownloadTask(task, chapterId))?.progress;
}

interface ChapterDownloadProgressProps {
  chapterId: number;
  label: string;
}

/** A ring filled as far as the running download of a chapter got; it spins until the download knows its size. */
export function ChapterDownloadProgress({ chapterId, label }: ChapterDownloadProgressProps) {
  const [progress, setProgress] = useState(() => runningProgress(chapterId));
  useEffect(() => {
    setProgress(runningProgress(chapterId));
    return taskScheduler.subscribeEvents(({ task }) => {
      if (task.status === "running" && isChapterDownloadTask(task, chapterId)) setProgress(task.progress);
    });
  }, [chapterId]);
  const fraction = progress?.total ? Math.min(1, Math.max(0, progress.current / progress.total)) : null;

  return (
    <span
      aria-label={label}
      aria-valuemax={fraction === null ? undefined : 100}
      aria-valuemin={fraction === null ? undefined : 0}
      aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
      className="norea-novel-chapter-progress-slot norea-chapter-download-ring"
      data-indeterminate={fraction === null ? "true" : undefined}
      role="progressbar"
    >
      <svg aria-hidden="true" height="22" viewBox="0 0 24 24" width="22">
        <circle className="norea-chapter-download-ring-track" cx="12" cy="12" r={RADIUS} />
        <circle
          className="norea-chapter-download-ring-value"
          cx="12"
          cy="12"
          r={RADIUS}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - (fraction ?? 0.25))}
        />
      </svg>
    </span>
  );
}
