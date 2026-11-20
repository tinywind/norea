import { taskScheduler, taskWorkQueueKey } from "./scheduler";
import type { TaskRecord, TaskSnapshot } from "./task-types";

interface WorkProgressState {
  unfinished: number;
  total: number;
  seenCancelledIds: Set<string>;
}

const ACTIVE_STATUSES = new Set<TaskRecord["status"]>(["queued", "running"]);
const progressByWork = new Map<string, WorkProgressState>();

/** Chapter download and media repair tasks belong to a novel's download progress group. */
export function isDownloadWorkTask(task: Pick<TaskRecord, "kind">): boolean {
  return task.kind === "chapter.download" || task.kind === "chapter.repairMedia";
}

function chapterProgressKey(record: Pick<TaskRecord, "id" | "subject">): string {
  const chapterId = record.subject?.chapterId;
  return chapterId !== undefined ? `chapter:${chapterId}` : `task:${record.id}`;
}

function recordOrderTimestamp(record: Pick<TaskRecord, "createdAt" | "finishedAt">): number {
  return record.finishedAt ?? record.createdAt ?? -1;
}

function summarizeWorkTasks(tasks: readonly TaskRecord[]): {
  active: number;
  failed: number;
  nonCancelled: number;
  cancelledOnlyIds: string[];
} {
  const nonCancelledByChapter = new Map<string, TaskRecord>();
  const cancelledRecords: TaskRecord[] = [];
  for (const record of tasks) {
    if (record.status === "cancelled") {
      cancelledRecords.push(record);
      continue;
    }
    const chapterKey = chapterProgressKey(record);
    const existing = nonCancelledByChapter.get(chapterKey);
    if (!existing) {
      nonCancelledByChapter.set(chapterKey, record);
      continue;
    }
    const existingActive = ACTIVE_STATUSES.has(existing.status);
    const candidateActive = ACTIVE_STATUSES.has(record.status);
    if (candidateActive && !existingActive) {
      nonCancelledByChapter.set(chapterKey, record);
    } else if (!existingActive && !candidateActive) {
      const existingTs = recordOrderTimestamp(existing);
      const candidateTs = recordOrderTimestamp(record);
      if (candidateTs > existingTs || (candidateTs === existingTs && record.status === "succeeded")) {
        nonCancelledByChapter.set(chapterKey, record);
      }
    }
  }
  let active = 0;
  let failed = 0;
  for (const record of nonCancelledByChapter.values()) {
    if (ACTIVE_STATUSES.has(record.status)) active += 1;
    else if (record.status === "failed") failed += 1;
  }
  const cancelledOnlyIds: string[] = [];
  for (const record of cancelledRecords) {
    if (!nonCancelledByChapter.has(chapterProgressKey(record))) {
      cancelledOnlyIds.push(record.id);
    }
  }
  return {
    active,
    failed,
    nonCancelled: nonCancelledByChapter.size,
    cancelledOnlyIds,
  };
}

/**
 * Follows every scheduler snapshot, so a work's total survives finished tasks leaving the
 * snapshot even while the Downloads page is closed, and stays intact after the last task
 * settles as failed until the work leaves the snapshot. The total grows when work is added.
 */
export function updateWorkProgress(snapshot: Pick<TaskSnapshot, "records">): void {
  const tasksByWork = new Map<string, TaskRecord[]>();
  for (const record of snapshot.records) {
    if (!isDownloadWorkTask(record)) continue;
    const key = taskWorkQueueKey(record.subject);
    if (!key) continue;
    const list = tasksByWork.get(key);
    if (list) list.push(record);
    else tasksByWork.set(key, [record]);
  }
  const counts = new Map<string, ReturnType<typeof summarizeWorkTasks>>();
  for (const [key, records] of tasksByWork) {
    counts.set(key, summarizeWorkTasks(records));
  }
  for (const key of progressByWork.keys()) {
    const count = counts.get(key);
    if (!count || count.nonCancelled === 0) progressByWork.delete(key);
  }
  for (const [key, count] of counts) {
    if (count.nonCancelled === 0) continue;
    const previous = progressByWork.get(key);
    const unfinished = count.active + count.failed;
    const seenCancelledIds = previous ? previous.seenCancelledIds : new Set<string>();
    let newlyCancelled = 0;
    for (const id of count.cancelledOnlyIds) {
      if (!seenCancelledIds.has(id)) {
        seenCancelledIds.add(id);
        newlyCancelled += 1;
      }
    }
    const baseTotal = previous
      ? Math.max(0, previous.total - newlyCancelled) + Math.max(0, unfinished - previous.unfinished)
      : count.nonCancelled;
    const total = Math.max(count.nonCancelled, baseTotal);
    progressByWork.set(key, { unfinished, total, seenCancelledIds });
  }
}

/** Done and total chapters for one work's listed tasks; failures count as not done. */
export function workProgress(
  workKey: string,
  tasks: readonly TaskRecord[],
): { done: number; total: number } {
  const summary = summarizeWorkTasks(tasks);
  const remembered = summary.nonCancelled > 0 ? (progressByWork.get(workKey)?.total ?? 0) : 0;
  const total = Math.max(summary.nonCancelled, remembered);
  return { done: Math.max(0, total - summary.active - summary.failed), total };
}

export function resetWorkProgressForTests(): void {
  progressByWork.clear();
}

updateWorkProgress(taskScheduler.getSnapshot());
taskScheduler.subscribe(() => updateWorkProgress(taskScheduler.getSnapshot()));
