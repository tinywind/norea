import { MAX_SCHEDULER_MATERIALIZED_TASKS } from "../performance-budgets";
import type { TaskRecord } from "./task-types";

const HISTORY_LIMIT = Math.min(200, MAX_SCHEDULER_MATERIALIZED_TASKS);
const TERMINAL_TASK_RETENTION_MS = 2_000;

type TaskHistoryRecord = Pick<TaskRecord, "id" | "status" | "createdAt">;

export class TaskHistory {
  private readonly latestByDedupeKey = new Map<string, string>();
  private readonly cleanupTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly retentionMs: number;

  constructor(
    retentionMs: number | undefined,
    private readonly expire: (id: string) => void,
  ) {
    this.retentionMs = Math.max(0, retentionMs ?? TERMINAL_TASK_RETENTION_MS);
  }

  rememberLatest(key: string, id: string): void {
    this.latestByDedupeKey.set(key, id);
  }

  latestId(key: string): string | undefined {
    return this.latestByDedupeKey.get(key);
  }

  scheduleCleanup(id: string): void {
    this.clearCleanup(id);
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(id);
      this.expire(id);
    }, this.retentionMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    this.cleanupTimers.set(id, timer);
  }

  forget(id: string, dedupeKey: string | undefined): void {
    this.clearCleanup(id);
    if (dedupeKey && this.latestByDedupeKey.get(dedupeKey) === id) {
      this.latestByDedupeKey.delete(dedupeKey);
    }
  }

  overflowTaskIds(
    records: Iterable<TaskHistoryRecord>,
    totalCount: number,
  ): string[] {
    if (totalCount <= HISTORY_LIMIT) return [];
    return [...records]
      .filter(
        (record) => record.status !== "queued" && record.status !== "running",
      )
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, totalCount - HISTORY_LIMIT)
      .map((record) => record.id);
  }

  private clearCleanup(id: string): void {
    const timer = this.cleanupTimers.get(id);
    if (timer) clearTimeout(timer);
    this.cleanupTimers.delete(id);
  }
}
