import { taskScheduler, taskWorkQueueKey } from "./scheduler";
import type { TaskRecord, TaskSnapshot } from "./task-types";

interface WorkProgressState {
  active: number;
  total: number;
}

const ACTIVE_STATUSES = new Set<TaskRecord["status"]>(["queued", "running"]);
const progressByWork = new Map<string, WorkProgressState>();

/**
 * Follows every scheduler snapshot, so a work's total survives finished tasks leaving the
 * snapshot even while the Downloads page is closed. The total grows when work is added.
 */
export function updateWorkProgress(snapshot: Pick<TaskSnapshot, "records">): void {
  const counts = new Map<string, { active: number; all: number }>();
  for (const record of snapshot.records) {
    const key = taskWorkQueueKey(record.subject);
    if (!key) continue;
    const count = counts.get(key) ?? { active: 0, all: 0 };
    count.all += 1;
    if (ACTIVE_STATUSES.has(record.status)) count.active += 1;
    counts.set(key, count);
  }
  for (const key of progressByWork.keys()) {
    if (!counts.get(key)?.active) progressByWork.delete(key);
  }
  for (const [key, count] of counts) {
    if (count.active === 0) continue;
    const previous = progressByWork.get(key);
    const total = previous
      ? Math.max(count.all, previous.total + Math.max(0, count.active - previous.active))
      : count.all;
    progressByWork.set(key, { active: count.active, total });
  }
}

/** Done and total chapters for one work's listed tasks; failures count as not done. */
export function workProgress(
  workKey: string,
  tasks: readonly TaskRecord[],
): { done: number; total: number } {
  const active = tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const total = Math.max(tasks.length, active > 0 ? (progressByWork.get(workKey)?.total ?? 0) : 0);
  return { done: total - active - failed, total };
}

export function resetWorkProgressForTests(): void {
  progressByWork.clear();
}

updateWorkProgress(taskScheduler.getSnapshot());
taskScheduler.subscribe(() => updateWorkProgress(taskScheduler.getSnapshot()));
