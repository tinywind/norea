import type { ScraperExecutorId } from "./scraper-queue";

interface SourceExecutorLease {
  sourceId: string;
  executorId: ScraperExecutorId;
  background: boolean;
}

function poolExecutorIndex(executorId: ScraperExecutorId): number | null {
  const match = /^pool:(\d+)$/.exec(executorId);
  return match ? Number(match[1]) : null;
}

export class SourceExecutorLeases {
  private readonly leasesByTaskId = new Map<string, SourceExecutorLease>();
  private readonly activeTaskIdsBySource = new Map<string, Set<string>>();
  private readonly poolTaskIdsByExecutor = new Map<ScraperExecutorId, string>();
  private readonly executorBySource = new Map<string, ScraperExecutorId>();
  private immediateTaskId: string | null = null;
  private backgroundCount = 0;

  constructor(private poolConcurrency: number) {}

  get activeImmediateTaskId(): string | null {
    return this.immediateTaskId;
  }

  get activeBackgroundCount(): number {
    return this.backgroundCount;
  }

  get activePoolTasks(): ReadonlyMap<ScraperExecutorId, string> {
    return this.poolTaskIdsByExecutor;
  }

  get hasActiveExecutor(): boolean {
    return this.immediateTaskId !== null || this.poolTaskIdsByExecutor.size > 0;
  }

  activeTaskIds(sourceId: string): ReadonlySet<string> | undefined {
    return this.activeTaskIdsBySource.get(sourceId);
  }

  resize(poolConcurrency: number): void {
    this.poolConcurrency = poolConcurrency;
    for (const [sourceId, executorId] of this.executorBySource) {
      if (!this.isEnabled(executorId)) this.executorBySource.delete(sourceId);
    }
  }

  freePoolExecutorIds(): ScraperExecutorId[] {
    const ids: ScraperExecutorId[] = [];
    for (let index = 0; index < this.poolConcurrency; index += 1) {
      const executorId: ScraperExecutorId = `pool:${index}`;
      if (!this.poolTaskIdsByExecutor.has(executorId)) ids.push(executorId);
    }
    return ids;
  }

  canUseExecutor(
    sourceId: string | undefined,
    executorId: ScraperExecutorId,
    hasQueuedSource: (sourceId: string) => boolean,
  ): boolean {
    if (sourceId) {
      const assignedExecutor = this.assignedExecutor(sourceId);
      if (assignedExecutor) return assignedExecutor === executorId;
    }
    for (const [reservedSourceId, assignedExecutor] of this.executorBySource) {
      if (reservedSourceId === sourceId || assignedExecutor !== executorId)
        continue;
      if (!this.isEnabled(assignedExecutor)) {
        this.executorBySource.delete(reservedSourceId);
        continue;
      }
      if (hasQueuedSource(reservedSourceId)) return false;
    }
    return true;
  }

  acquire(taskId: string, lease: Readonly<SourceExecutorLease>): void {
    this.leasesByTaskId.set(taskId, lease);
    const activeIds =
      this.activeTaskIdsBySource.get(lease.sourceId) ?? new Set();
    activeIds.add(taskId);
    this.activeTaskIdsBySource.set(lease.sourceId, activeIds);
    if (
      lease.executorId !== "immediate" &&
      !this.assignedExecutor(lease.sourceId)
    ) {
      this.executorBySource.set(lease.sourceId, lease.executorId);
    }
    if (lease.executorId === "immediate") {
      this.immediateTaskId = taskId;
    } else {
      this.poolTaskIdsByExecutor.set(lease.executorId, taskId);
    }
    if (lease.background) this.backgroundCount += 1;
  }

  release(taskId: string, sourceHasQueuedWork: boolean): void {
    const lease = this.leasesByTaskId.get(taskId);
    if (!lease) return;
    this.leasesByTaskId.delete(taskId);
    const activeIds = this.activeTaskIdsBySource.get(lease.sourceId);
    activeIds?.delete(taskId);
    if (!activeIds?.size) {
      this.activeTaskIdsBySource.delete(lease.sourceId);
      if (!sourceHasQueuedWork) this.executorBySource.delete(lease.sourceId);
    }
    if (lease.executorId === "immediate") {
      if (this.immediateTaskId === taskId) this.immediateTaskId = null;
    } else if (this.poolTaskIdsByExecutor.get(lease.executorId) === taskId) {
      this.poolTaskIdsByExecutor.delete(lease.executorId);
    }
    if (lease.background)
      this.backgroundCount = Math.max(0, this.backgroundCount - 1);
  }

  private isEnabled(executorId: ScraperExecutorId): boolean {
    const index = poolExecutorIndex(executorId);
    return index !== null && index < this.poolConcurrency;
  }

  private assignedExecutor(sourceId: string): ScraperExecutorId | undefined {
    const executorId = this.executorBySource.get(sourceId);
    if (!executorId) return undefined;
    if (this.isEnabled(executorId)) return executorId;
    this.executorBySource.delete(sourceId);
    return undefined;
  }
}
