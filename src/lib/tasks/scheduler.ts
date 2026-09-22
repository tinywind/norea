/**
 * Source task dispatch design
 *
 * Keep logical source queues separate from physical scraper executors.
 *
 * Logical source queues protect sites from noisy access patterns:
 * - Keep one queue per source id.
 * - Gate each source with pause, cooldown, backoff, and an active lease.
 * - Dispatch source queues through a source lane so queued work for one source
 *   does not spread across multiple hidden WebViews.
 * - Default to one active task per source. Queue order can be changed by the
 *   user, but it must not bypass source rate limits unless a future task
 *   explicitly opts into that policy.
 *
 * Physical scraper executors own WebViews:
 * - `immediate` owns the foreground/site-browser WebView and is reserved for
 *   UI-responsive work such as opening a site or manual challenge clearing.
 * - `pool:0..N-1` own hidden worker WebViews. N is the user-configured
 *   concurrent source work setting.
 * - WebViews assigned to the same source id use one browser profile across
 *   executors. Different source ids use isolated cookies, storage, and cache.
 *
 * Dispatcher loop:
 * 1. Drain main app work.
 * 2. Drain the immediate executor with UI-responsive eligible work only.
 * 3. For each free pool executor, walk source queues in the user-visible
 *    order and assign the first eligible queued task from each source.
 * 4. Mark a task running only after assigning an executor. Pass that executor
 *    id through TaskRunContext so plugin fetch/extract calls use the same
 *    WebView for the task lifetime.
 * 5. Release the executor and source lease only after the task and its native
 *    scraper work have actually settled. Cancellation must stop or settle the
 *    native scraper request before the WebView is reused.
 *
 * Route affinity is an optimization, not a queue type. A source that benefits
 * from repeated access through the same WebView may request a short sticky
 * executor lease via a route key, but executors should return to the shared
 * pool when that lease expires.
 */
import {
  runWithScraperExecutor,
  type ScraperExecutorId,
} from "./scraper-queue";
import { isAbortError } from "../abort";
import { describeError } from "../errors";
import { recordPerformanceObservation } from "../observability";
import {
  normalizeSourceAccessRequiredError,
  sourceAccessScopeKey,
  type SourceAccessRequiredErrorShape,
} from "../plugins/source-access";
import { redactUrlsForLog } from "../url-log";
import { SourceExecutorLeases } from "./source-executor-leases";
import { TaskHistory } from "./task-history";
import { SourceCooldowns } from "./source-cooldown";
import {
  SourceAccessGate,
  normalizedSourceAccessTaskKey,
  normalizedSourceAccessUrl,
  type SourceAccessBlock,
  type SourceAccessBlockState,
} from "./source-access-gate";
import type {
  MainTaskSpec,
  SourceQueueSortMode,
  SourceTaskSpec,
  TaskCancelOptions,
  TaskEvent,
  TaskHandle,
  TaskKind,
  TaskMoveTarget,
  TaskPriority,
  TaskQueueSortMode,
  TaskRecord,
  TaskRunContext,
  TaskSnapshot,
  TaskSpec,
  TaskStatus,
  TaskSubject,
} from "./task-types";

export type { SourceAccessBlock } from "./source-access-gate";
export type * from "./task-types";
export { sourceBaseDomainKey } from "./source-cooldown";

const TASK_BULK_EVENT_CHUNK_SIZE = 250;

export function taskWorkQueueKey(subject: TaskSubject | undefined): string | null {
  if (!subject) return null;
  if (subject.novelId !== undefined) return `novel:${subject.novelId}`;
  const novelPath = subject.novelPath?.trim();
  if (novelPath) return `path:${novelPath}`;
  const novelName = subject.novelName?.trim();
  if (novelName) return `name:${novelName}`;
  return null;
}

interface TaskEntry {
  activeReleased: boolean;
  controller: AbortController;
  dedupeKey?: string;
  exclusive: boolean;
  pauseRequested?: boolean;
  promise: Promise<unknown>;
  record: TaskRecord;
  reject: (error: unknown) => void;
  resolve: (value: unknown) => void;
  sourceExecutorId?: ScraperExecutorId;
  sourceAccessDeferred?: boolean;
  sourceAccessPauseRequested?: boolean;
  sourceAccessStarted?: boolean;
  sourceAccessVerificationRevision?: number;
  spec: TaskSpec<unknown>;
}

const DEFAULT_SOURCE_FOREGROUND_CONCURRENCY = 3;

/**
 * When background concurrency follows the foreground setting, reserve one pool
 * executor for foreground work so a batch of background downloads cannot occupy
 * every executor and stall interactive search, novel-home refresh, or
 * "read now" chapter downloads. With a single executor (N=1) this collapses to
 * 1 because reservation is impossible; interactive work escapes to the
 * dedicated immediate executor regardless.
 */
function reservedBackgroundConcurrency(foregroundConcurrency: number): number {
  return Math.max(1, foregroundConcurrency - 1);
}
export const TASK_PAUSE_ABORT_MESSAGE = "Task was paused.";

function priorityRank(priority: TaskPriority): number {
  switch (priority) {
    case "interactive":
      return 0;
    case "user":
      return 1;
    case "normal":
      return 2;
    case "deferred":
      return 3;
    case "background":
      return 4;
  }
}

function isBackgroundPriority(priority: TaskPriority): boolean {
  return priority === "background";
}

function isOpenSiteSourceKind(kind: TaskKind): boolean {
  return kind === "source.openSite";
}

function isSourceBarrierMainKind(kind: TaskKind): boolean {
  return kind === "maintenance.clearWebViewCache";
}

function taskCanCancel(kind: TaskKind, requested: boolean | undefined): boolean {
  return !isSourceBarrierMainKind(kind) && (requested ?? true);
}

function canVerifySourceAccess(kind: TaskKind, isOriginTask: boolean): boolean {
  return (
    !isOpenSiteSourceKind(kind) &&
    kind !== "source.clearCookies" &&
    (kind !== "chapter.repairMedia" || isOriginTask)
  );
}

function isImmediateBrowseSourceKind(kind: TaskKind): boolean {
  return (
    kind === "source.openNovel" ||
    kind === "source.previewNovel" ||
    kind === "source.mergeNovel" ||
    kind === "source.listPopular" ||
    kind === "source.listLatest" ||
    kind === "source.search"
  );
}

function isImmediateInteractionSourceKind(kind: TaskKind): boolean {
  return isImmediateBrowseSourceKind(kind) || kind === "chapter.download";
}

function isUiResponsiveSourceKind(kind: TaskKind): boolean {
  return (
    isOpenSiteSourceKind(kind) ||
    isImmediateBrowseSourceKind(kind) ||
    kind === "source.globalSearch" ||
    kind === "source.refreshNovel"
  );
}

function isInterruptibleDownloadKind(kind: TaskKind): boolean {
  return kind === "chapter.download" || kind === "chapter.repairMedia";
}

function shouldUseImmediateExecutor(entry: TaskEntry): boolean {
  if (entry.spec.requiresForegroundExecutor) return true;
  if (isOpenSiteSourceKind(entry.record.kind)) return true;
  return (
    entry.record.priority === "interactive" &&
    isImmediateInteractionSourceKind(entry.record.kind)
  );
}

function canUsePoolExecutorForImmediateInteraction(entry: TaskEntry): boolean {
  return (
    entry.spec.requiresForegroundExecutor !== true &&
    entry.record.priority === "interactive" &&
    isImmediateInteractionSourceKind(entry.record.kind)
  );
}

function makeTaskId(): string {
  return `task-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 9)}`;
}

function describeTaskError(error: unknown): string {
  return redactUrlsForLog(describeError(error));
}

export class TaskScheduler {
  private readonly activeDedupeByKey = new Map<string, string>();
  private readonly entries = new Map<string, TaskEntry>();
  private readonly eventListeners = new Set<(event: TaskEvent) => void>();
  private readonly history: TaskHistory;
  private readonly mainQueue: string[] = [];
  private readonly pausedSourceIds = new Set<string>();
  private readonly snapshotListeners = new Set<() => void>();
  private readonly sourceTaskSettlementWaiters = new Map<
    string,
    Set<() => void>
  >();
  private readonly sourceCooldowns = new SourceCooldowns(() => this.drain());
  private readonly sourceAccess = new SourceAccessGate();
  private readonly sourceExecutors: SourceExecutorLeases;
  private readonly sourceQueueOrder: string[] = [];
  private readonly sourceQueues = new Map<string, string[]>();
  private sourceForegroundConcurrency: number;
  private sourceBackgroundConcurrency: number;
  private readonly sourceBackgroundConcurrencyFollowsForeground: boolean;
  private sourceQueuesPaused: boolean;
  private activeMainTaskId: string | null = null;
  private batchDepth = 0;
  private drainAfterBatch = false;
  private publishSnapshotAfterBatch = false;
  private taskEventsAfterBatch: TaskEvent[] = [];
  private snapshotDirty = false;
  private snapshotFlushScheduled = false;
  private snapshotRafHandle: number | null = null;
  private readonly sourceLastServedAt = new Map<string, number>();
  private snapshotRecordIndexes = new Map<string, number>();
  private snapshot: TaskSnapshot = {
    pausedSourceIds: [],
    records: [],
    recordLimit: 0,
    recordsTruncated: false,
    sourceQueueLimit: 0,
    sourceQueueOrder: [],
    sourceQueuesTotal: 0,
    sourceQueuesTruncated: false,
    sourceQueuesPaused: false,
    sourceAccessBlocks: [],
    total: 0,
    running: 0,
    queued: 0,
    failed: 0,
    succeeded: 0,
    cancelled: 0,
  };

  constructor(options: {
    sourceForegroundConcurrency?: number;
    sourceBackgroundConcurrency?: number;
    sourceQueuesPaused?: boolean;
    terminalTaskRetentionMs?: number;
  } = {}) {
    this.sourceQueuesPaused = options.sourceQueuesPaused ?? false;
    this.history = new TaskHistory(options.terminalTaskRetentionMs, (id) => {
      const current = this.entries.get(id);
      if (
        !current ||
        (current.record.status !== "succeeded" && current.record.status !== "cancelled")
      ) {
        return;
      }
      this.deleteEntry(current);
      this.publishSnapshot();
    });
    this.sourceForegroundConcurrency = Math.max(
      1,
      options.sourceForegroundConcurrency ??
        DEFAULT_SOURCE_FOREGROUND_CONCURRENCY,
    );
    this.sourceBackgroundConcurrencyFollowsForeground =
      options.sourceBackgroundConcurrency === undefined;
    this.sourceBackgroundConcurrency =
      this.sourceBackgroundConcurrencyFollowsForeground
        ? reservedBackgroundConcurrency(this.sourceForegroundConcurrency)
        : Math.max(1, options.sourceBackgroundConcurrency ?? 1);
    this.sourceExecutors = new SourceExecutorLeases(
      this.sourceForegroundConcurrency,
    );
    this.snapshot = this.buildSnapshot();
  }

  private debug(
    message: string,
    entry?: TaskEntry,
    extra?: Record<string, unknown>,
  ): void {
    recordPerformanceObservation("scheduler.event", {
      activeBackgroundCount: this.sourceExecutors.activeBackgroundCount,
      activeImmediateTaskId: this.sourceExecutors.activeImmediateTaskId,
      activePoolTaskIdsByExecutor: Object.fromEntries(
        this.sourceExecutors.activePoolTasks,
      ),
      activeMainTaskId: this.activeMainTaskId,
      exclusive: entry?.exclusive,
      kind: entry?.record.kind,
      lane: entry?.record.lane,
      mainQueueLength: this.mainQueue.length,
      pausedSourceIds: [...this.pausedSourceIds].sort(),
      priority: entry?.record.priority,
      sourceAccessScopeKey: entry?.spec.sourceAccessScopeKey,
      sourceAccessScopesBlocked: this.sourceAccess.size,
      sourceId: entry?.record.source?.id,
      sourceName: entry?.record.source?.name,
      sourceQueueLength: entry?.record.source
        ? this.sourceQueues.get(entry.record.source.id)?.length ?? 0
        : undefined,
      sourceQueuesPaused: this.sourceQueuesPaused,
      status: entry?.record.status,
      taskId: entry?.record.id,
      message,
      ...extra,
    });
  }

  enqueueMain<T>(spec: MainTaskSpec<T>): TaskHandle<T> {
    return this.enqueue({ ...spec, lane: "main" });
  }

  enqueueSource<T>(spec: SourceTaskSpec<T>): TaskHandle<T> {
    return this.enqueue({ ...spec, lane: "source" });
  }

  enqueue<T>(spec: TaskSpec<T>): TaskHandle<T> {
    if (spec.lane === "source" && !spec.source?.id) {
      throw new Error("Source tasks require a source id.");
    }

    if (spec.dedupeKey && spec.kind !== "source.openSite") {
      const activeId = this.activeDedupeByKey.get(spec.dedupeKey);
      const activeEntry = activeId ? this.entries.get(activeId) : undefined;
      if (activeEntry) {
        const requestedPriority = spec.priority ?? "normal";
        if (
          activeEntry.record.status === "queued" &&
          priorityRank(requestedPriority) <
            priorityRank(activeEntry.record.priority)
        ) {
          activeEntry.spec = { ...activeEntry.spec, priority: requestedPriority };
          activeEntry.record = {
            ...activeEntry.record,
            priority: requestedPriority,
          };
          this.publishSnapshot();
          this.requestDrain();
        }
        return {
          id: activeEntry.record.id,
          promise: activeEntry.promise as Promise<T>,
        };
      }
    }

    const id = makeTaskId();
    const controller = new AbortController();
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    const entry: TaskEntry = {
      controller,
      dedupeKey: spec.dedupeKey,
      exclusive: spec.exclusive ?? false,
      activeReleased: true,
      promise,
      reject,
      resolve,
      spec: spec as TaskSpec<unknown>,
      record: {
        id,
        lane: spec.lane,
        kind: spec.kind,
        priority: spec.priority ?? "normal",
        title: spec.title,
        source: spec.source,
        subject: spec.subject,
        status: "queued",
        createdAt: Date.now(),
        canCancel: taskCanCancel(spec.kind, spec.canCancel),
        canRetry: false,
      },
    };

    this.entries.set(id, entry);
    this.registerSourceAccessScopeEntry(entry);
    if (spec.dedupeKey) {
      this.activeDedupeByKey.set(spec.dedupeKey, id);
      this.history.rememberLatest(spec.dedupeKey, id);
    }

    if (spec.lane === "main") {
      this.mainQueue.push(id);
    } else {
      const sourceId = spec.source!.id;
      this.ensureSourceQueueOrder(sourceId);
      const queue = this.sourceQueues.get(sourceId) ?? [];
      queue.push(id);
      this.sourceQueues.set(sourceId, queue);
      this.handleUiResponsiveSourceEnqueue(entry);
    }

    if (spec.kind === "source.openSite") {
      this.cancelOtherOpenSiteTasks(id);
    }

    this.debug("queued", entry, { dedupeKey: entry.dedupeKey });
    this.publish(entry, null);
    this.requestDrain();
    return { id, promise: promise as Promise<T> };
  }

  cancel(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || !entry.record.canCancel) return false;

    if (entry.record.status === "running") {
      return this.cancelRunningEntry(entry);
    }

    if (entry.record.status !== "queued") return false;
    this.debug("cancel requested", entry);

    if (entry.record.lane === "main") {
      this.removeQueuedId(this.mainQueue, id);
    } else if (entry.record.source) {
      const queue = this.sourceQueues.get(entry.record.source.id);
      if (queue) this.removeQueuedId(queue, id);
    }

    this.finishQueuedAsCancelled(entry);
    this.requestDrain();
    return true;
  }

  cancelActiveTasks(options: TaskCancelOptions = {}): number {
    const cancellableEntries = this.cancellableActiveEntries(options);
    let cancelled = 0;

    this.batch(() => {
      cancelled += this.cancelQueuedEntries(
        cancellableEntries.queued,
        options.discardQueued === true,
      );
      for (const entry of cancellableEntries.running) {
        if (this.cancelRunningEntry(entry)) cancelled += 1;
      }
    });

    return cancelled;
  }

  requeueRunningInterruptibleDownloads(): number {
    const requeued = this.pauseRunningSourceTasks(undefined, (entry) =>
      isInterruptibleDownloadKind(entry.record.kind),
    );
    if (requeued > 0) {
      this.debug("requeued running interruptible downloads", undefined, {
        requeued,
      });
    }
    return requeued;
  }

  yieldRunningInterruptibleDownloads(): number {
    const yielded = this.yieldRunningSourceTasks(
      undefined,
      (entry) => isInterruptibleDownloadKind(entry.record.kind),
    );
    if (yielded > 0) {
      this.debug("yielded running interruptible downloads", undefined, {
        yielded,
      });
    }
    return yielded;
  }

  moveQueuedTask(id: string, target: TaskMoveTarget): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.record.status !== "queued") return false;
    const queue = this.queueForEntry(entry);
    if (!queue) return false;

    const currentIndex = queue.indexOf(id);
    if (currentIndex < 0) return false;

    const nextIndex = this.moveTargetIndex(currentIndex, queue.length, target);
    if (nextIndex === currentIndex) return false;

    queue.splice(currentIndex, 1);
    queue.splice(nextIndex, 0, id);
    this.debug("queued task moved", entry, {
      queueIndex: nextIndex,
      target,
    });
    this.publishSnapshot();
    this.drain();
    return true;
  }

  moveQueuedTaskBefore(id: string, beforeId: string | null): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.record.status !== "queued") return false;
    const queue = this.queueForEntry(entry);
    if (!queue) return false;

    const currentIndex = queue.indexOf(id);
    if (currentIndex < 0) return false;

    let nextIndex = queue.length - 1;
    if (beforeId !== null) {
      const beforeEntry = this.entries.get(beforeId);
      if (
        !beforeEntry ||
        beforeEntry.record.status !== "queued" ||
        this.queueForEntry(beforeEntry) !== queue
      ) {
        return false;
      }
      nextIndex = queue.indexOf(beforeId);
      if (nextIndex < 0) return false;
      if (currentIndex < nextIndex) nextIndex -= 1;
    }

    if (nextIndex === currentIndex) return false;
    queue.splice(currentIndex, 1);
    queue.splice(nextIndex, 0, id);
    this.debug("queued task reordered", entry, {
      beforeId,
      queueIndex: nextIndex,
    });
    this.publishSnapshot();
    this.drain();
    return true;
  }

  moveSourceQueue(sourceId: string, target: TaskMoveTarget): boolean {
    const currentIndex = this.sourceQueueOrder.indexOf(sourceId);
    if (currentIndex < 0) return false;
    const nextIndex = this.moveTargetIndex(
      currentIndex,
      this.sourceQueueOrder.length,
      target,
    );
    if (nextIndex === currentIndex) return false;
    this.sourceQueueOrder.splice(currentIndex, 1);
    this.sourceQueueOrder.splice(nextIndex, 0, sourceId);
    this.debug("source queue moved", undefined, { sourceId, target });
    this.publishSnapshot();
    this.drain();
    return true;
  }

  moveSourceQueueBefore(
    sourceId: string,
    beforeSourceId: string | null,
  ): boolean {
    const currentIndex = this.sourceQueueOrder.indexOf(sourceId);
    if (currentIndex < 0) return false;

    let nextIndex = this.sourceQueueOrder.length - 1;
    if (beforeSourceId !== null) {
      nextIndex = this.sourceQueueOrder.indexOf(beforeSourceId);
      if (nextIndex < 0) return false;
      if (currentIndex < nextIndex) nextIndex -= 1;
    }

    if (nextIndex === currentIndex) return false;
    this.sourceQueueOrder.splice(currentIndex, 1);
    this.sourceQueueOrder.splice(nextIndex, 0, sourceId);
    this.debug("source queue reordered", undefined, {
      beforeSourceId,
      sourceId,
    });
    this.publishSnapshot();
    this.drain();
    return true;
  }

  moveSourceWorkQueue(
    sourceId: string,
    workKey: string,
    target: TaskMoveTarget,
  ): boolean {
    const queue = this.sourceQueues.get(sourceId);
    if (!queue) return false;

    const selectedIds = new Set<string>();
    for (const id of queue) {
      const entry = this.entries.get(id);
      if (
        entry?.record.status === "queued" &&
        taskWorkQueueKey(entry.record.subject) === workKey
      ) {
        selectedIds.add(id);
      }
    }
    if (selectedIds.size === 0) return false;

    const selected = queue.filter((id) => selectedIds.has(id));
    const remaining = queue.filter((id) => !selectedIds.has(id));
    const firstSelectedIndex = queue.findIndex((id) => selectedIds.has(id));
    const currentIndex = queue
      .slice(0, firstSelectedIndex)
      .filter((id) => !selectedIds.has(id)).length;
    const nextIndex = this.moveTargetIndex(
      currentIndex,
      remaining.length + 1,
      target,
    );
    const reordered = [
      ...remaining.slice(0, nextIndex),
      ...selected,
      ...remaining.slice(nextIndex),
    ];
    if (
      queue.length === reordered.length &&
      queue.every((id, index) => id === reordered[index])
    ) {
      return false;
    }

    queue.splice(0, queue.length, ...reordered);
    this.debug("source work queue moved", undefined, {
      sourceId,
      target,
      workKey,
    });
    this.publishSnapshot();
    this.requestDrain();
    return true;
  }

  sortQueuedTasks(mode: TaskQueueSortMode): boolean {
    let changed = this.sortQueue(this.mainQueue, mode);
    for (const queue of this.sourceQueues.values()) {
      changed = this.sortQueue(queue, mode) || changed;
    }
    if (!changed) return false;
    this.debug("queued tasks sorted", undefined, { mode });
    this.publishSnapshot();
    this.drain();
    return true;
  }

  sortSourceQueues(mode: SourceQueueSortMode): boolean {
    const before = this.sourceQueueOrder.join("\u0000");
    this.sourceQueueOrder.sort((left, right) =>
      this.compareSourceQueueOrder(left, right, mode),
    );
    if (this.sourceQueueOrder.join("\u0000") === before) return false;
    this.debug("source queues sorted", undefined, { mode });
    this.publishSnapshot();
    this.drain();
    return true;
  }

  private matchesSourceAccessBlock(
    entry: TaskEntry,
    block: SourceAccessBlockState,
  ): boolean {
    const sourceId = entry.record.source?.id;
    return (
      entry.spec.sourceAccessScopeKey === block.scopeKey ||
      Boolean(sourceId && block.sourceIds.has(sourceId))
    );
  }

  private isSourceAccessBlocked(entry: TaskEntry): boolean {
    return this.sourceAccess.isBlocked(
      entry.spec.sourceAccessScopeKey,
      entry.record.source?.id,
    );
  }

  private registerSourceAccessScopeEntry(entry: TaskEntry): void {
    this.sourceAccess.registerSource(
      entry.spec.sourceAccessScopeKey,
      entry.record.source?.id,
    );
  }

  private setSourceAccessUrlForEntry(entry: TaskEntry, url: string): boolean {
    if (entry.record.status !== "running" || entry.pauseRequested) return false;
    let scopeKey: string;
    try {
      scopeKey = sourceAccessScopeKey(url);
    } catch {
      return false;
    }

    const configuredScopeKey = entry.spec.sourceAccessScopeKey?.trim();
    if (
      configuredScopeKey &&
      configuredScopeKey !== scopeKey &&
      entry.sourceAccessVerificationRevision !== undefined
    ) {
      return false;
    }
    if (configuredScopeKey !== scopeKey) {
      entry.spec = { ...entry.spec, sourceAccessScopeKey: scopeKey };
    }

    const block = this.sourceAccess.get(scopeKey);
    if (!block || entry.sourceAccessVerificationRevision !== undefined) {
      return true;
    }
    const sourceId = entry.record.source?.id;
    this.sourceAccess.registerSource(scopeKey, sourceId);
    entry.sourceAccessPauseRequested = true;
    entry.pauseRequested = true;
    entry.controller.abort(
      new DOMException(TASK_PAUSE_ABORT_MESSAGE, "AbortError"),
    );
    this.publishSnapshot();
    return false;
  }

  private recordSourceAccessChallenge(
    entry: TaskEntry,
    error: SourceAccessRequiredErrorShape,
  ): boolean {
    const challengeScopeKey = sourceAccessScopeKey(error.challenge.url);
    const configuredScopeKey = entry.spec.sourceAccessScopeKey?.trim();
    if (!configuredScopeKey || configuredScopeKey !== challengeScopeKey) {
      return false;
    }
    const scopeKey = configuredScopeKey;

    const sourceId = entry.record.source?.id;
    const sourceIds = new Set<string>();
    for (const candidate of this.entries.values()) {
      const candidateSourceId = candidate.record.source?.id;
      if (
        candidate.spec.sourceAccessScopeKey !== scopeKey &&
        (!sourceId || candidateSourceId !== sourceId)
      ) {
        continue;
      }
      if (candidateSourceId) sourceIds.add(candidateSourceId);
    }
    if (sourceId) sourceIds.add(sourceId);

    const { block, revokedVerificationTaskId } = this.sourceAccess.recordChallenge(
      scopeKey,
      error.challenge,
      {
        taskId: entry.record.id,
        taskKey: entry.spec.sourceAccessVerificationKey,
        sourceIds,
      },
      describeTaskError(error),
    );
    if (revokedVerificationTaskId) {
      const verificationEntry = this.entries.get(revokedVerificationTaskId);
      if (verificationEntry) {
        verificationEntry.sourceAccessVerificationRevision = undefined;
      }
    }
    this.publishSnapshot();

    this.pauseRunningSourceTasks(
      undefined,
      (candidate) => this.matchesSourceAccessBlock(candidate, block),
      { includeNonCancellable: true, sourceAccess: true },
    );
    if (!entry.pauseRequested) {
      entry.pauseRequested = true;
      entry.controller.abort(
        new DOMException(TASK_PAUSE_ABORT_MESSAGE, "AbortError"),
      );
    }
    this.debug("source access required", entry, {
      challengeKind: error.challenge.kind,
      scopeKey,
      sourceAccessRevision: block.revision,
    });
    this.requeuePausedRunningAfterSettlement(entry);
    return true;
  }

  private hasRunningSourceAccessTask(scopeKey: string): boolean {
    const block = this.sourceAccess.get(scopeKey);
    if (!block) return false;
    for (const entry of this.entries.values()) {
      if (
        entry.record.lane === "source" &&
        entry.record.status === "running" &&
        this.matchesSourceAccessBlock(entry, block)
      ) {
        return true;
      }
    }
    return false;
  }

  private sourceAccessVerificationCandidates(
    scopeKey: string,
    block: SourceAccessBlockState,
  ): TaskEntry[] {
    return [...this.entries.values()].filter(
      (entry) => {
        const entryScopeKey = entry.spec.sourceAccessScopeKey;
        return (
          entry.record.lane === "source" &&
          entry.record.status === "queued" &&
          (entry.record.canCancel || entry.record.id === block.originTaskId) &&
          canVerifySourceAccess(
            entry.record.kind,
            entry.record.id === block.originTaskId,
          ) &&
          this.matchesSourceAccessBlock(entry, block) &&
          (!entryScopeKey || entryScopeKey === scopeKey)
        );
      },
    );
  }

  private preferredSourceAccessVerificationCandidate(
    scopeKey: string,
    block: SourceAccessBlockState,
  ): TaskEntry | null {
    const candidates = this.sourceAccessVerificationCandidates(
      scopeKey,
      block,
    );
    const origin = block.originTaskId
      ? candidates.find((entry) => entry.record.id === block.originTaskId)
      : undefined;
    const persistedOrigin = block.originTaskKey
      ? candidates.find(
          (entry) =>
            normalizedSourceAccessTaskKey(
              entry.spec.sourceAccessVerificationKey,
            ) === block.originTaskKey,
        )
      : undefined;
    candidates.sort((left, right) => this.compareTaskOrder(left, right));
    return origin ?? persistedOrigin ?? candidates[0] ?? null;
  }

  private prepareSourceAccessVerificationTask(): TaskEntry | null {
    for (const block of this.sourceAccess.values()) {
      const { scopeKey } = block;
      if (
        !block.verificationRequested ||
        block.verificationTaskId ||
        this.hasRunningSourceAccessTask(scopeKey)
      ) {
        continue;
      }

      const entry = this.preferredSourceAccessVerificationCandidate(
        scopeKey,
        block,
      );
      if (!entry) {
        this.sourceAccess.prepareVerification(scopeKey, undefined);
        this.debug("source access verification request reset", undefined, {
          scopeKey,
          sourceAccessRevision: block.revision,
        });
        this.publishSnapshot();
        continue;
      }

      if (!entry.spec.sourceAccessScopeKey) {
        entry.spec = { ...entry.spec, sourceAccessScopeKey: scopeKey };
      }
      entry.sourceAccessVerificationRevision = block.revision;
      this.sourceAccess.prepareVerification(scopeKey, entry.record.id);
      this.debug("source access verification started", entry, {
        scopeKey,
        sourceAccessRevision: block.revision,
      });
      this.publishSnapshot();
      return entry;
    }
    return null;
  }

  private confirmSourceAccessForEntry(
    entry: TaskEntry,
    expectedRevision: number | undefined,
  ): boolean {
    const scopeKey = entry.spec.sourceAccessScopeKey;
    if (
      !scopeKey ||
      expectedRevision === undefined ||
      entry.record.status !== "running" ||
      entry.controller.signal.aborted ||
      entry.pauseRequested
    ) {
      return false;
    }
    if (
      entry.sourceAccessVerificationRevision !== expectedRevision ||
      !this.sourceAccess.matchesVerification(
        scopeKey,
        entry.record.id,
        expectedRevision,
      )
    ) {
      return false;
    }

    // Authentication is proven by the source response, not later media or
    // storage work. Keep the running canary pinned to its verified hostname.
    this.sourceAccess.clear(scopeKey);
    this.debug("source access verified", entry, {
      scopeKey,
      sourceAccessRevision: expectedRevision,
    });
    this.publishSnapshot();
    this.requestDrain();
    return true;
  }

  private requeueFailedSourceAccessVerification(
    entry: TaskEntry,
    error: unknown,
  ): boolean {
    const scopeKey = entry.spec.sourceAccessScopeKey;
    const revision = entry.sourceAccessVerificationRevision;
    if (!scopeKey || revision === undefined) return false;
    if (
      !this.sourceAccess.matchesVerification(scopeKey, entry.record.id, revision)
    ) {
      return false;
    }

    const nextRevision = this.sourceAccess.stopVerification(
      scopeKey,
      describeTaskError(error),
    );
    entry.sourceAccessVerificationRevision = undefined;
    entry.pauseRequested = true;
    this.debug("source access verification failed", entry, {
      error: describeTaskError(error),
      scopeKey,
      sourceAccessRevision: nextRevision,
    });
    this.publishSnapshot();
    this.requeuePausedRunningAfterSettlement(entry);
    return true;
  }

  private revokeSourceAccessVerificationForEntry(entry: TaskEntry): void {
    const scopeKey = entry.spec.sourceAccessScopeKey;
    const revision = entry.sourceAccessVerificationRevision;
    entry.sourceAccessVerificationRevision = undefined;
    if (!scopeKey || revision === undefined) return;
    if (
      !this.sourceAccess.matchesVerification(scopeKey, entry.record.id, revision)
    ) {
      return;
    }

    this.sourceAccess.stopVerification(scopeKey);
    this.publishSnapshot();
  }

  private pauseRunningSourceTasks(
    sourceId?: string,
    shouldPause: (entry: TaskEntry) => boolean = () => true,
    options: {
      includeNonCancellable?: boolean;
      sourceAccess?: boolean;
    } = {},
  ): number {
    let paused = 0;
    for (const entry of this.entries.values()) {
      if (
        (!options.includeNonCancellable && !entry.record.canCancel) ||
        entry.record.lane !== "source" ||
        entry.record.status !== "running" ||
        entry.record.kind === "source.openSite" ||
        (options.sourceAccess &&
          entry.spec.canCompleteWithoutSourceAccess === true &&
          entry.sourceAccessStarted !== true &&
          entry.sourceAccessVerificationRevision === undefined) ||
        (sourceId && entry.record.source?.id !== sourceId) ||
        !shouldPause(entry)
      ) {
        continue;
      }
      if (!entry.pauseRequested) {
        paused += 1;
      }
      if (options.sourceAccess) {
        entry.sourceAccessPauseRequested = true;
      }
      entry.pauseRequested = true;
      entry.controller.abort(
        new DOMException(TASK_PAUSE_ABORT_MESSAGE, "AbortError"),
      );
    }
    return paused;
  }

  private yieldRunningSourceTasks(
    sourceId?: string,
    shouldYield: (entry: TaskEntry) => boolean = () => true,
  ): number {
    let yielded = 0;
    for (const entry of this.entries.values()) {
      if (
        !entry.record.canCancel ||
        entry.record.lane !== "source" ||
        entry.record.status !== "running" ||
        entry.record.kind === "source.openSite" ||
        (sourceId && entry.record.source?.id !== sourceId) ||
        !shouldYield(entry)
      ) {
        continue;
      }
      if (!entry.pauseRequested) {
        yielded += 1;
      }
      entry.pauseRequested = true;
    }
    return yielded;
  }

  private yieldRunningInterruptibleDownloadsForUi(entry: TaskEntry): number {
    if (!this.shouldPromoteForUiResponsiveness(entry)) return 0;
    if (canUsePoolExecutorForImmediateInteraction(entry)) return 0;
    const requiresImmediateExecutor = shouldUseImmediateExecutor(entry);
    const yielded = this.yieldRunningSourceTasks(undefined, (candidate) => {
      if (!isInterruptibleDownloadKind(candidate.record.kind)) return false;
      return (
        !requiresImmediateExecutor ||
        candidate.sourceExecutorId === "immediate"
      );
    });
    if (yielded > 0) {
      this.debug("yielded interruptible downloads for UI work", entry, {
        yielded,
      });
    }
    return yielded;
  }

  private handleUiResponsiveSourceEnqueue(entry: TaskEntry): void {
    if (!this.shouldPromoteForUiResponsiveness(entry)) return;
    this.promoteQueuedUiSourceEntry(entry);
    this.promoteSourceQueue(entry.record.source?.id);
    this.yieldRunningInterruptibleDownloadsForUi(entry);
  }

  private shouldPromoteForUiResponsiveness(entry: TaskEntry): boolean {
    return (
      entry.record.lane === "source" &&
      entry.record.status === "queued" &&
      (entry.record.priority === "interactive" ||
        (entry.record.priority === "user" &&
          isUiResponsiveSourceKind(entry.record.kind)))
    );
  }

  private promoteQueuedUiSourceEntry(entry: TaskEntry): void {
    const queue = this.queueForEntry(entry);
    if (!queue) return;
    this.removeQueuedId(queue, entry.record.id);
    const insertIndex = this.sourceQueueUiInsertIndex(queue);
    queue.splice(insertIndex, 0, entry.record.id);
  }

  private promoteSourceQueue(sourceId: string | undefined): void {
    if (!sourceId) return;
    this.ensureSourceQueueOrder(sourceId);
    const currentIndex = this.sourceQueueOrder.indexOf(sourceId);
    if (currentIndex <= 0) return;
    this.sourceQueueOrder.splice(currentIndex, 1);
    this.sourceQueueOrder.unshift(sourceId);
  }

  private sourceQueueUiInsertIndex(queue: string[]): number {
    let index = 0;
    while (index < queue.length) {
      const entry = this.entries.get(queue[index]!);
      if (!entry || !this.shouldPromoteForUiResponsiveness(entry)) break;
      index += 1;
    }
    return index;
  }

  private cancelOtherOpenSiteTasks(taskId: string): void {
    for (const entry of [...this.entries.values()]) {
      if (
        entry.record.id !== taskId &&
        entry.record.kind === "source.openSite" &&
        (entry.record.status === "queued" || entry.record.status === "running")
      ) {
        this.cancel(entry.record.id);
      }
    }
  }

  private isCancellableActiveEntry(
    entry: TaskEntry,
    options: TaskCancelOptions,
  ): boolean {
    if (!entry.record.canCancel) return false;
    if (entry.record.status !== "queued" && entry.record.status !== "running") {
      return false;
    }
    if (options.sourceId) {
      if (
        entry.record.lane !== "source" ||
        entry.record.source?.id !== options.sourceId
      ) {
        return false;
      }
    }
    if (!options.workKey) return true;
    return taskWorkQueueKey(entry.record.subject) === options.workKey;
  }

  private cancellableActiveEntries(options: TaskCancelOptions): {
    queued: TaskEntry[];
    running: TaskEntry[];
  } {
    const queued: TaskEntry[] = [];
    const running: TaskEntry[] = [];

    for (const entry of this.entries.values()) {
      if (!this.isCancellableActiveEntry(entry, options)) continue;
      if (entry.record.status === "queued") {
        queued.push(entry);
      } else {
        running.push(entry);
      }
    }

    return { queued, running };
  }

  retry(id: string): TaskHandle<unknown> | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.record.status !== "failed" && entry.record.status !== "cancelled") {
      return null;
    }
    const { spec } = entry;
    return this.enqueue({ ...spec, dedupeKey: spec.dedupeKey });
  }

  clearFailedTasks(): number {
    const failedEntries = [...this.entries.values()].filter(
      (entry) => entry.record.status === "failed",
    );
    for (const entry of failedEntries) {
      this.deleteEntry(entry);
    }
    if (failedEntries.length > 0) this.publishSnapshot();
    return failedEntries.length;
  }

  pauseSourceQueue(sourceId?: string): boolean {
    const paused = this.pauseRunningSourceTasks(sourceId);
    if (!sourceId) {
      if (this.sourceQueuesPaused) return paused > 0;
      this.sourceQueuesPaused = true;
      this.debug("all source queues paused");
      this.publishSnapshot();
      return true;
    }

    if (this.pausedSourceIds.has(sourceId)) return paused > 0;
    this.pausedSourceIds.add(sourceId);
    this.debug("source queue paused", undefined, { sourceId });
    this.publishSnapshot();
    return true;
  }

  resumeSourceQueue(sourceId?: string): boolean {
    if (!sourceId) {
      if (!this.sourceQueuesPaused && this.pausedSourceIds.size === 0) {
        return false;
      }
      this.sourceQueuesPaused = false;
      this.pausedSourceIds.clear();
      this.debug("all source queues resumed");
      this.publishSnapshot();
      this.drain();
      return true;
    }

    if (!this.pausedSourceIds.delete(sourceId)) return false;
    this.debug("source queue resumed", undefined, { sourceId });
    this.publishSnapshot();
    this.drain();
    return true;
  }

  hydrateSourceAccessBlocks(blocks: Iterable<SourceAccessBlock>): void {
    this.sourceAccess.hydrate(blocks);
    for (const entry of this.entries.values()) {
      entry.sourceAccessVerificationRevision = undefined;
      this.registerSourceAccessScopeEntry(entry);
    }
    this.pauseRunningSourceTasks(
      undefined,
      (entry) => this.isSourceAccessBlocked(entry),
      { includeNonCancellable: true, sourceAccess: true },
    );
    this.debug("source access blocks hydrated", undefined, {
      sourceAccessScopesBlocked: this.sourceAccess.size,
    });
    this.publishSnapshot();
    this.drain();
  }

  canBeginSourceAccessVerification(scopeKey: string): boolean {
    const block = this.sourceAccess.get(scopeKey);
    return Boolean(
      block &&
        !block.verificationRequested &&
        block.verificationTaskId === undefined &&
        this.sourceAccessVerificationCandidates(scopeKey, block).length > 0,
    );
  }

  async resolveSourceAccessVerificationUrl(
    scopeKey: string,
    expectedRevision: number,
  ): Promise<{
    revision: number;
    scopeKey: string;
    url: string;
  } | null> {
    const block = this.sourceAccess.get(scopeKey);
    if (!block || block.revision !== expectedRevision) return null;
    const fallbackUrl = normalizedSourceAccessUrl(
      block.challenge.url,
      scopeKey,
    );

    const entry = this.preferredSourceAccessVerificationCandidate(
      scopeKey,
      block,
    );
    if (!entry) return null;
    let candidateScopeKey = entry.spec.sourceAccessScopeKey;
    if (!block.challengeUrlRedacted && candidateScopeKey === scopeKey) {
      return fallbackUrl
        ? { revision: block.revision, scopeKey, url: fallbackUrl }
        : null;
    }

    let rebuiltUrl: string | null = null;
    try {
      const value = await entry.spec.resolveSourceAccessUrl?.();
      if (typeof value === "string") {
        const resolvedScopeKey = candidateScopeKey ?? sourceAccessScopeKey(value);
        rebuiltUrl = normalizedSourceAccessUrl(value, resolvedScopeKey);
        if (rebuiltUrl && !candidateScopeKey) {
          candidateScopeKey = resolvedScopeKey;
        }
      }
    } catch {
      rebuiltUrl = null;
    }
    candidateScopeKey ??= scopeKey;

    const current = this.sourceAccess.get(scopeKey);
    if (
      !current ||
      current.revision !== expectedRevision ||
      current.verificationRequested ||
      current.verificationTaskId !== undefined ||
      !this.sourceAccessVerificationCandidates(scopeKey, current).some(
        (candidate) => candidate.record.id === entry.record.id,
      )
    ) {
      return null;
    }
    if (candidateScopeKey !== scopeKey) {
      if (!entry.spec.sourceAccessScopeKey) {
        entry.spec = { ...entry.spec, sourceAccessScopeKey: candidateScopeKey };
        this.registerSourceAccessScopeEntry(entry);
        this.publishSnapshot();
      }
      return null;
    }
    const resolvedUrl = rebuiltUrl ?? fallbackUrl;
    if (!resolvedUrl) return null;
    if (rebuiltUrl) {
      this.sourceAccess.refreshChallengeUrl(
        scopeKey,
        rebuiltUrl,
        entry.record.id,
        entry.spec.sourceAccessVerificationKey,
      );
      this.publishSnapshot();
    }
    return { revision: current.revision, scopeKey, url: resolvedUrl };
  }

  beginSourceAccessVerification(scopeKey: string): boolean {
    if (!this.canBeginSourceAccessVerification(scopeKey)) return false;
    const block = this.sourceAccess.get(scopeKey);
    if (!block) return false;

    this.sourceAccess.requestVerification(scopeKey);
    this.debug("source access verification requested", undefined, {
      scopeKey,
      sourceAccessRevision: block.revision,
    });
    this.publishSnapshot();
    this.drain();
    return true;
  }

  /** Cancel the blocked origin or active canary, then allow fresh source work. */
  cancelSourceAccessBlock(scopeKey: string, expectedRevision: number): boolean {
    const block = this.sourceAccess.get(scopeKey);
    if (!block || block.revision !== expectedRevision) return false;

    const taskId = block.verificationTaskId ?? block.originTaskId;
    const entry =
      (taskId ? this.entries.get(taskId) : undefined) ??
      (block.originTaskKey
        ? [...this.entries.values()].find((candidate) => (
            normalizedSourceAccessTaskKey(candidate.spec.sourceAccessVerificationKey) ===
              block.originTaskKey &&
            candidate.record.lane === "source" &&
            (candidate.record.status === "queued" || candidate.record.status === "running")
          ))
        : undefined);

    this.batch(() => {
      if (
        entry?.record.lane === "source" &&
        this.matchesSourceAccessBlock(entry, block)
      ) {
        if (entry.record.status === "running") {
          this.cancelRunningEntry(entry);
        } else {
          this.cancelQueuedEntries([entry], false);
        }
      }
      this.sourceAccess.clear(scopeKey);
      this.debug("source access wait cancelled", entry, {
        scopeKey,
        sourceAccessRevision: expectedRevision,
      });
      this.publishSnapshot();
      this.requestDrain();
    });
    return true;
  }

  keepSourceAccessBlocked(scopeKey: string): boolean {
    const block = this.sourceAccess.get(scopeKey);
    if (!block) return false;

    const verificationTaskId = block.verificationTaskId;
    if (!block.verificationRequested && verificationTaskId === undefined) {
      return true;
    }

    const verificationEntry = verificationTaskId
      ? this.entries.get(verificationTaskId)
      : undefined;
    if (verificationEntry) {
      verificationEntry.sourceAccessVerificationRevision = undefined;
    }
    const revision = this.sourceAccess.stopVerification(scopeKey);
    if (verificationTaskId) {
      this.pauseRunningSourceTasks(
        undefined,
        (entry) => entry.record.id === verificationTaskId,
        { includeNonCancellable: true, sourceAccess: true },
      );
    }
    this.debug("source access verification stopped", verificationEntry, {
      scopeKey,
      sourceAccessRevision: revision,
    });
    this.publishSnapshot();
    this.drain();
    return true;
  }

  setSourceForegroundConcurrency(concurrency: number): void {
    const nextConcurrency = Number.isFinite(concurrency)
      ? Math.max(1, Math.round(concurrency))
      : DEFAULT_SOURCE_FOREGROUND_CONCURRENCY;
    if (nextConcurrency === this.sourceForegroundConcurrency) return;
    this.sourceForegroundConcurrency = nextConcurrency;
    if (this.sourceBackgroundConcurrencyFollowsForeground) {
      this.sourceBackgroundConcurrency =
        reservedBackgroundConcurrency(nextConcurrency);
    }
    this.sourceExecutors.resize(nextConcurrency);
    this.debug("source foreground concurrency changed", undefined, {
      sourceForegroundConcurrency: nextConcurrency,
      sourceBackgroundConcurrency: this.sourceBackgroundConcurrency,
    });
    this.drain();
  }

  getSnapshot = (): TaskSnapshot => {
    this.materializeSnapshotIfDirty();
    return this.snapshot;
  };

  getTask(id: string): TaskRecord | undefined {
    const entry = this.entries.get(id);
    return entry ? { ...entry.record } : undefined;
  }

  getTaskByDedupeKey(key: string): TaskRecord | undefined {
    const id = this.history.latestId(key);
    return id ? this.getTask(id) : undefined;
  }

  /** Wait until the current source-task execution releases its executor. */
  waitForSourceTaskSettlement(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.record.lane !== "source" || entry.activeReleased) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiters =
        this.sourceTaskSettlementWaiters.get(id) ?? new Set<() => void>();
      waiters.add(resolve);
      this.sourceTaskSettlementWaiters.set(id, waiters);
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.snapshotListeners.add(listener);
    return () => {
      this.snapshotListeners.delete(listener);
    };
  };

  subscribeEvents(listener: (event: TaskEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  batch<T>(run: () => T): T {
    this.batchDepth += 1;
    try {
      return run();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0) {
        const shouldPublishSnapshot = this.publishSnapshotAfterBatch;
        const shouldDrain = this.drainAfterBatch;
        const taskEvents = this.taskEventsAfterBatch;
        this.publishSnapshotAfterBatch = false;
        this.drainAfterBatch = false;
        this.taskEventsAfterBatch = [];
        if (shouldPublishSnapshot) this.flushSnapshot();
        this.publishTaskEventsInChunks(taskEvents);
        if (shouldDrain) this.drain();
      }
    }
  }

  private drain(): void {
    this.drainMain();
    if (this.sourceDispatchBlockedByMainBarrier()) return;
    this.drainImmediateExecutor();
    this.drainSourcePool();
  }

  private drainMain(): void {
    if (this.activeMainTaskId || this.mainQueue.length === 0) return;
    const next = this.nextQueuedMainEntry();
    if (!next) return;
    if (
      isSourceBarrierMainKind(next.entry.record.kind) &&
      this.hasActiveSourceExecutor()
    ) {
      return;
    }
    this.mainQueue.splice(next.index, 1);
    this.activeMainTaskId = next.entry.record.id;
    this.start(next.entry);
  }

  private nextQueuedMainEntry(): { entry: TaskEntry; index: number } | null {
    for (let index = 0; index < this.mainQueue.length; index += 1) {
      const candidate = this.entries.get(this.mainQueue[index]);
      if (!candidate || candidate.record.status !== "queued") continue;
      return { entry: candidate, index };
    }
    return null;
  }

  private hasActiveSourceExecutor(): boolean {
    return this.sourceExecutors.hasActiveExecutor;
  }

  private sourceDispatchBlockedByMainBarrier(): boolean {
    if (this.activeMainTaskId) {
      const activeMain = this.entries.get(this.activeMainTaskId);
      return Boolean(
        activeMain && isSourceBarrierMainKind(activeMain.record.kind),
      );
    }
    const next = this.nextQueuedMainEntry();
    return Boolean(next && isSourceBarrierMainKind(next.entry.record.kind));
  }

  private drainImmediateExecutor(): void {
    if (this.sourceExecutors.activeImmediateTaskId) return;
    const next = this.pickSourceTask(
      (entry) => isOpenSiteSourceKind(entry.record.kind),
      { allowPaused: true, allowActiveSource: true },
    );
    if (next) {
      this.startSource(next, "immediate");
      return;
    }
    const verification = this.prepareSourceAccessVerificationTask();
    if (verification) {
      this.startSource(verification, "immediate");
      return;
    }
    const browse = this.pickSourceTask(
      (entry) =>
        entry.record.priority === "interactive" &&
        isImmediateInteractionSourceKind(entry.record.kind),
      { allowActiveSource: true },
    );
    if (browse) {
      this.startSource(browse, "immediate");
      return;
    }
    const foreground = this.pickSourceTask(
      (entry) => entry.spec.requiresForegroundExecutor === true,
    );
    if (foreground) this.startSource(foreground, "immediate");
  }

  private drainSourcePool(): void {
    const freeExecutorIds = this.sourceExecutors.freePoolExecutorIds();
    if (freeExecutorIds.length === 0) return;
    const activeImmediateEntry = this.sourceExecutors.activeImmediateTaskId
      ? this.entries.get(this.sourceExecutors.activeImmediateTaskId)
      : undefined;
    const immediateExecutorHasDownload =
      activeImmediateEntry !== undefined &&
      isInterruptibleDownloadKind(activeImmediateEntry.record.kind);

    for (const sourceId of this.orderedSourceQueueIds()) {
      if (freeExecutorIds.length === 0) return;

      for (let index = 0; index < freeExecutorIds.length; index += 1) {
        const executorId = freeExecutorIds[index]!;
        const immediateInteraction = immediateExecutorHasDownload
          ? this.pickSourceTaskFromQueue(
              sourceId,
              (entry) =>
                canUsePoolExecutorForImmediateInteraction(entry) &&
                this.canUseExecutorForSource(entry, executorId),
              { allowActiveSource: true },
            )
          : null;
        const next =
          immediateInteraction ??
          this.pickSourceTaskFromQueue(sourceId, (entry) => {
            if (shouldUseImmediateExecutor(entry)) return false;
            if (!this.canUseExecutorForSource(entry, executorId)) return false;
            if (
              isBackgroundPriority(entry.record.priority) &&
              this.sourceExecutors.activeBackgroundCount >=
                this.sourceBackgroundConcurrency
            ) {
              return false;
            }
            return true;
          });
        if (!next) continue;
        freeExecutorIds.splice(index, 1);
        this.startSource(next, executorId);
        break;
      }
    }
  }

  private canUseExecutorForSource(
    entry: TaskEntry,
    executorId: ScraperExecutorId,
  ): boolean {
    return this.sourceExecutors.canUseExecutor(
      entry.record.source?.id,
      executorId,
      (sourceId) => this.hasQueuedSource(sourceId),
    );
  }

  private hasQueuedSource(sourceId: string): boolean {
    const queue = this.sourceQueues.get(sourceId);
    if (!queue) return false;
    for (const id of queue) {
      const entry = this.entries.get(id);
      if (entry?.record.status === "queued") {
        return true;
      }
    }
    return false;
  }

  private startSource(entry: TaskEntry, executorId: ScraperExecutorId): void {
    this.removeFromSourceQueue(entry);
    const sourceId = entry.record.source!.id;
    this.sourceExecutors.acquire(entry.record.id, {
      sourceId,
      executorId,
      background: isBackgroundPriority(entry.record.priority),
    });
    entry.sourceExecutorId = executorId;
    entry.activeReleased = false;
    this.start(entry);
  }

  private pickSourceTask(
    predicate: (entry: TaskEntry) => boolean,
    options: {
      allowPaused?: boolean;
      allowActiveSource?: boolean;
    } = {},
  ): TaskEntry | null {
    const candidates: TaskEntry[] = [];
    for (const queue of this.sourceQueues.values()) {
      let sourceCandidate: TaskEntry | null = null;
      for (const id of queue) {
        const entry = this.entries.get(id);
        if (!entry || entry.record.status !== "queued" || !entry.record.source) {
          continue;
        }
        if (!this.canStartSourceTask(entry, options)) continue;
        const canRunBeforeSourceGates = this.canRunBeforeSourceGates(entry);
        if (
          !options.allowPaused &&
          (this.isSourceQueuePaused(entry) ||
            (this.isSourceAccessBlocked(entry) && !canRunBeforeSourceGates))
        ) {
          continue;
        }
        if (!canRunBeforeSourceGates) {
          const cooldownDelay = this.sourceCooldowns.delay(
            entry.spec.sourceCooldownKey,
          );
          if (cooldownDelay > 0) {
            this.sourceCooldowns.scheduleDrain(
              entry.spec.sourceCooldownKey!,
              cooldownDelay,
            );
            continue;
          }
        }
        if (!predicate(entry)) continue;
        sourceCandidate = entry;
        break;
      }
      if (sourceCandidate) candidates.push(sourceCandidate);
    }

    candidates.sort((a, b) => this.compareTaskOrder(a, b));
    return candidates[0] ?? null;
  }

  private pickSourceTaskFromQueue(
    sourceId: string,
    predicate: (entry: TaskEntry) => boolean,
    options: {
      allowPaused?: boolean;
      allowActiveSource?: boolean;
    } = {},
  ): TaskEntry | null {
    const queue = this.sourceQueues.get(sourceId);
    if (!queue) return null;

    for (const id of queue) {
      const entry = this.entries.get(id);
      if (!entry || entry.record.status !== "queued" || !entry.record.source) {
        continue;
      }
      if (!this.canStartSourceTask(entry, options)) continue;
      const canRunBeforeSourceGates = this.canRunBeforeSourceGates(entry);
      if (
        !options.allowPaused &&
        (this.isSourceQueuePaused(entry) ||
          (this.isSourceAccessBlocked(entry) && !canRunBeforeSourceGates))
      ) {
        continue;
      }
      if (!canRunBeforeSourceGates) {
        const cooldownDelay = this.sourceCooldowns.delay(
          entry.spec.sourceCooldownKey,
        );
        if (cooldownDelay > 0) {
          this.sourceCooldowns.scheduleDrain(
            entry.spec.sourceCooldownKey!,
            cooldownDelay,
          );
          continue;
        }
      }
      if (predicate(entry)) return entry;
    }

    return null;
  }

  private canRunBeforeSourceGates(entry: TaskEntry): boolean {
    return (
      entry.spec.canCompleteWithoutSourceAccess === true &&
      entry.sourceAccessDeferred !== true
    );
  }

  private isSourceQueuePaused(entry: TaskEntry): boolean {
    const sourceId = entry.record.source?.id;
    return (
      this.sourceQueuesPaused ||
      (sourceId !== undefined && this.pausedSourceIds.has(sourceId))
    );
  }

  private sourceFairnessKey(entry: TaskEntry): string | null {
    return entry.record.source?.id ?? null;
  }

  private canStartSourceTask(
    entry: TaskEntry,
    options: { allowActiveSource?: boolean } = {},
  ): boolean {
    if (options.allowActiveSource) return true;
    const sourceId = entry.record.source?.id;
    if (!sourceId) return true;
    return !this.hasActiveNonOpenSiteSourceTask(sourceId);
  }

  private hasActiveNonOpenSiteSourceTask(sourceId: string): boolean {
    const activeIds = this.sourceExecutors.activeTaskIds(sourceId);
    if (!activeIds) return false;
    for (const id of activeIds) {
      const activeEntry = this.entries.get(id);
      if (activeEntry && !isOpenSiteSourceKind(activeEntry.record.kind)) {
        return true;
      }
    }
    return false;
  }

  private compareTaskOrder(a: TaskEntry, b: TaskEntry): number {
    const priority = priorityRank(a.record.priority) - priorityRank(b.record.priority);
    if (priority !== 0) return priority;
    const aFairnessKey = this.sourceFairnessKey(a);
    const bFairnessKey = this.sourceFairnessKey(b);
    const aSourceLastServed = aFairnessKey
      ? this.sourceLastServedAt.get(aFairnessKey) ?? 0
      : 0;
    const bSourceLastServed = bFairnessKey
      ? this.sourceLastServedAt.get(bFairnessKey) ?? 0
      : 0;
    if (aSourceLastServed !== bSourceLastServed) {
      return aSourceLastServed - bSourceLastServed;
    }
    return a.record.createdAt - b.record.createdAt;
  }

  private tryStartSourceAccess(entry: TaskEntry): boolean {
    if (
      entry.record.status !== "running" ||
      entry.controller.signal.aborted ||
      entry.pauseRequested
    ) {
      entry.sourceAccessDeferred = true;
      return false;
    }
    if (entry.sourceAccessVerificationRevision !== undefined) {
      entry.sourceAccessStarted = true;
      return true;
    }

    const cooldownDelay = this.sourceCooldowns.delay(entry.spec.sourceCooldownKey);
    if (cooldownDelay > 0) {
      this.sourceCooldowns.scheduleDrain(
        entry.spec.sourceCooldownKey!,
        cooldownDelay,
      );
    }
    if (cooldownDelay > 0 || this.isSourceAccessBlocked(entry)) {
      entry.sourceAccessDeferred = true;
      return false;
    }

    entry.sourceAccessStarted = true;
    return true;
  }

  private start(entry: TaskEntry): void {
    entry.sourceAccessDeferred = false;
    entry.sourceAccessStarted = false;
    this.setStatus(entry, "running", {
      canCancel: taskCanCancel(entry.spec.kind, entry.spec.canCancel),
      canRetry: false,
      startedAt: Date.now(),
    });
    this.debug("started", entry);

    const sourceAccessVerificationRevision =
      entry.sourceAccessVerificationRevision;
    let sourceAccessConfirmed = false;
    const context: TaskRunContext = {
      confirmSourceAccess: () => {
        const confirmed = this.confirmSourceAccessForEntry(
          entry,
          sourceAccessVerificationRevision,
        );
        sourceAccessConfirmed ||= confirmed;
        return confirmed;
      },
      executor: entry.sourceExecutorId,
      setSourceAccessUrl: (url) =>
        this.setSourceAccessUrlForEntry(entry, url),
      shouldYield: () => entry.pauseRequested === true,
      signal: entry.controller.signal,
      sourceAccessVerification:
        sourceAccessVerificationRevision !== undefined,
      taskId: entry.record.id,
      setDetail: (detail) => {
        entry.record = { ...entry.record, detail };
        this.publishTaskEvent(entry, entry.record.status);
      },
      setProgress: (progress) => {
        entry.record = { ...entry.record, progress };
        this.publishTaskEvent(entry, entry.record.status);
      },
      ...(entry.spec.canCompleteWithoutSourceAccess === true
        ? {
            tryStartSourceAccess: () => this.tryStartSourceAccess(entry),
          }
        : {}),
    };

    Promise.resolve()
      .then(() => this.runWithScraperExecutorContext(entry, context))
      .then((value) => {
        if (entry.controller.signal.aborted) {
          if (entry.pauseRequested && entry.record.lane === "source") {
            if (
              entry.sourceAccessPauseRequested &&
              entry.spec.canCancel === false &&
              sourceAccessVerificationRevision === undefined
            ) {
              entry.sourceAccessPauseRequested = false;
              entry.pauseRequested = false;
            } else {
              this.requeuePausedRunningAfterSettlement(entry);
              return;
            }
          } else {
            this.finishCancelledRunningAfterSettlement(entry);
            return;
          }
        }
        if (entry.sourceAccessDeferred) {
          this.requeueDeferredSourceAccessAfterSettlement(entry);
          return;
        }
        if (
          sourceAccessVerificationRevision !== undefined &&
          !sourceAccessConfirmed &&
          this.requeueFailedSourceAccessVerification(
            entry,
            new Error("Source access verification was not confirmed."),
          )
        ) {
          return;
        }
        this.finishRunning(entry, "succeeded", {
          canCancel: false,
          canRetry: false,
          finishedAt: Date.now(),
        });
        if (entry.record.status === "succeeded") entry.resolve(value);
      })
      .catch((error) => {
        const cancelled = entry.controller.signal.aborted || isAbortError(error);
        const sourceAccessError = normalizeSourceAccessRequiredError(error);
        if (cancelled && entry.record.status === "cancelled") {
          this.finishCancelledRunningAfterSettlement(entry);
          return;
        }
        if (
          entry.record.lane === "source" &&
          entry.record.status === "running" &&
          sourceAccessError &&
          this.recordSourceAccessChallenge(entry, sourceAccessError)
        ) {
          return;
        }
        if (entry.pauseRequested && entry.record.lane === "source" && cancelled) {
          this.requeuePausedRunningAfterSettlement(entry);
          return;
        }
        if (
          entry.record.lane === "source" &&
          entry.record.status === "running" &&
          this.requeueFailedSourceAccessVerification(entry, error)
        ) {
          return;
        }
        if (!cancelled) {
          console.error("[task-scheduler] task failed", {
            error: describeTaskError(error),
            kind: entry.record.kind,
            sourceId: entry.record.source?.id,
            taskId: entry.record.id,
            title: entry.record.title,
          });
        }
        this.finishRunning(entry, cancelled ? "cancelled" : "failed", {
          canCancel: false,
          canRetry: cancelled,
          error: cancelled ? undefined : describeTaskError(error),
          finishedAt: Date.now(),
        });
        if (entry.record.status === "cancelled" || entry.record.status === "failed") {
          entry.reject(error);
        }
      });
  }

  private runWithScraperExecutorContext(
    entry: TaskEntry,
    context: TaskRunContext,
  ): Promise<unknown> {
    if (entry.record.lane !== "source" || !entry.record.source) {
      return entry.spec.run(context);
    }

    const executorId = entry.sourceExecutorId;
    if (!executorId) {
      return Promise.reject(new Error("Source task is missing a scraper executor."));
    }

    return runWithScraperExecutor(
      entry.record.source.id,
      entry.record.id,
      executorId,
      context.signal,
      () => entry.spec.run(context),
    );
  }

  private finishRunning(
    entry: TaskEntry,
    status: TaskStatus,
    patch: Partial<TaskRecord>,
  ): boolean {
    if (entry.record.status !== "running") return false;
    this.setStatus(entry, status, patch);
    this.debug("finished", entry);
    this.releaseActive(entry);
    this.trimHistory();
    this.drain();
    return true;
  }

  private cancelRunningEntry(entry: TaskEntry): boolean {
    if (entry.record.status !== "running") return false;
    this.debug("cancel requested", entry);
    this.revokeSourceAccessVerificationForEntry(entry);
    entry.sourceAccessPauseRequested = false;
    entry.pauseRequested = false;
    entry.controller.abort();
    this.cancelRunning(entry);
    return true;
  }

  private cancelRunning(entry: TaskEntry): void {
    this.setStatus(entry, "cancelled", {
      canCancel: false,
      canRetry: true,
      finishedAt: Date.now(),
    });
    if (
      entry.dedupeKey &&
      this.activeDedupeByKey.get(entry.dedupeKey) === entry.record.id
    ) {
      this.activeDedupeByKey.delete(entry.dedupeKey);
    }
    entry.reject(new DOMException("Task was cancelled.", "AbortError"));
    if (entry.record.lane === "main") {
      this.releaseActive(entry);
      this.trimHistory();
      this.drain();
    }
  }

  private finishCancelledRunningAfterSettlement(entry: TaskEntry): void {
    if (entry.activeReleased) return;
    this.debug("cancelled task settled", entry);
    this.releaseActive(entry);
    this.trimHistory();
    this.drain();
  }

  private requeuePausedRunningAfterSettlement(entry: TaskEntry): void {
    if (entry.activeReleased) return;
    const previousStatus = entry.record.status;
    const sourceCooldownKey = entry.spec.sourceCooldownKey;
    this.revokeSourceAccessVerificationForEntry(entry);
    this.debug("paused task settled", entry);
    this.releaseActive(entry);
    if (sourceCooldownKey) {
      this.sourceCooldowns.clear(sourceCooldownKey);
    }
    if (entry.dedupeKey) {
      this.activeDedupeByKey.set(entry.dedupeKey, entry.record.id);
    }
    entry.controller = new AbortController();
    entry.sourceAccessPauseRequested = false;
    entry.pauseRequested = false;

    const nextRecord = { ...entry.record };
    delete nextRecord.startedAt;
    delete nextRecord.finishedAt;
    delete nextRecord.error;
    entry.record = {
      ...nextRecord,
      status: "queued",
      canCancel: taskCanCancel(entry.spec.kind, entry.spec.canCancel),
      canRetry: false,
    };
    this.entries.set(entry.record.id, entry);
    this.requeueSourceEntry(entry);
    this.publish(entry, previousStatus);
    this.drain();
  }

  private requeueDeferredSourceAccessAfterSettlement(entry: TaskEntry): void {
    if (entry.activeReleased) return;
    const previousStatus = entry.record.status;
    this.debug("source access deferred", entry);
    this.releaseActive(entry);
    if (entry.dedupeKey) {
      this.activeDedupeByKey.set(entry.dedupeKey, entry.record.id);
    }
    entry.controller = new AbortController();
    entry.sourceAccessPauseRequested = false;
    entry.pauseRequested = false;
    entry.sourceAccessStarted = false;

    const nextRecord = { ...entry.record };
    delete nextRecord.startedAt;
    delete nextRecord.finishedAt;
    delete nextRecord.error;
    entry.record = {
      ...nextRecord,
      status: "queued",
      canCancel: taskCanCancel(entry.spec.kind, entry.spec.canCancel),
      canRetry: false,
    };
    this.entries.set(entry.record.id, entry);
    this.requeueSourceEntry(entry);
    this.publish(entry, previousStatus);
    this.drain();
  }

  private requeueSourceEntry(entry: TaskEntry): void {
    const sourceId = entry.record.source?.id;
    if (!sourceId) return;
    const queue = this.sourceQueues.get(sourceId) ?? [];
    if (!queue.includes(entry.record.id)) {
      queue.splice(
        this.sourceQueueRequeueIndex(queue, entry),
        0,
        entry.record.id,
      );
    }
    this.sourceQueues.set(sourceId, queue);
  }

  /**
   * Paused work resumes ahead of queued siblings, but a download that only
   * deferred its source access keeps its creation order. Inserting deferred
   * downloads at the front made a batch drain newest-first because every
   * fresh entry ran its local check during the source cooldown and then
   * jumped ahead of the entries deferred before it.
   */
  private sourceQueueRequeueIndex(queue: string[], entry: TaskEntry): number {
    if (!isInterruptibleDownloadKind(entry.record.kind)) return 0;
    let index = this.sourceQueueUiInsertIndex(queue);
    if (entry.sourceAccessDeferred !== true) return index;
    while (index < queue.length) {
      const candidate = this.entries.get(queue[index]!);
      if (!candidate || candidate.record.createdAt > entry.record.createdAt) {
        break;
      }
      index += 1;
    }
    return index;
  }

  private releaseActive(entry: TaskEntry): void {
    if (entry.record.lane === "main") {
      if (this.activeMainTaskId === entry.record.id) this.activeMainTaskId = null;
    } else {
      const sourceId = entry.record.source?.id;
      this.sourceExecutors.release(
        entry.record.id,
        Boolean(sourceId && this.hasQueuedSource(sourceId)),
      );
      const fairnessKey = this.sourceFairnessKey(entry);
      if (fairnessKey) {
        this.sourceLastServedAt.set(fairnessKey, Date.now());
      }
      entry.sourceExecutorId = undefined;
      entry.activeReleased = true;
      const settlementWaiters = this.sourceTaskSettlementWaiters.get(
        entry.record.id,
      );
      if (settlementWaiters) {
        this.sourceTaskSettlementWaiters.delete(entry.record.id);
        for (const resolve of settlementWaiters) resolve();
      }
      if (
        entry.spec.canCompleteWithoutSourceAccess !== true ||
        entry.sourceAccessStarted === true
      ) {
        this.sourceCooldowns.set(
          entry.spec.sourceCooldownKey,
          entry.spec.sourceCooldownMs ?? 0,
        );
      }
    }

    if (
      entry.dedupeKey &&
      this.activeDedupeByKey.get(entry.dedupeKey) === entry.record.id
    ) {
      this.activeDedupeByKey.delete(entry.dedupeKey);
    }
    this.scheduleTerminalCleanup(entry);
  }

  private setStatus(
    entry: TaskEntry,
    status: TaskStatus,
    patch: Partial<TaskRecord> = {},
  ): void {
    const previousStatus = entry.record.status;
    entry.record = {
      ...entry.record,
      ...patch,
      status,
    };
    this.entries.set(entry.record.id, entry);
    this.publish(entry, previousStatus);
    this.scheduleTerminalCleanup(entry);
  }

  private scheduleTerminalCleanup(entry: TaskEntry): void {
    if (entry.record.status !== "succeeded" && entry.record.status !== "cancelled") {
      return;
    }
    if (!entry.activeReleased) return;

    this.history.scheduleCleanup(entry.record.id);
  }

  private publish(entry: TaskEntry, previousStatus: TaskStatus | null): void {
    this.publishSnapshot();
    this.publishTaskEvent(entry, previousStatus);
  }

  private publishTaskEvent(
    entry: TaskEntry,
    previousStatus: TaskStatus | null,
  ): void {
    const event = { task: { ...entry.record }, previousStatus };
    if (this.batchDepth > 0) {
      this.taskEventsAfterBatch.push(event);
      return;
    }
    this.refreshSnapshotRecord(entry);
    this.publishTaskEventPayload(event);
  }

  private publishTaskEvents(events: TaskEvent[]): void {
    if (events.length === 0) return;
    if (this.batchDepth > 0) {
      this.taskEventsAfterBatch.push(...events);
      return;
    }
    this.materializeSnapshotIfDirty();
    this.publishTaskEventsInChunks(events);
  }

  private publishTaskEventsInChunks(events: TaskEvent[]): void {
    if (events.length === 0) return;
    if (events.length <= TASK_BULK_EVENT_CHUNK_SIZE) {
      for (const event of events) this.publishTaskEventPayload(event);
      return;
    }

    let index = 0;
    const publishNextChunk = (): void => {
      const end = Math.min(index + TASK_BULK_EVENT_CHUNK_SIZE, events.length);
      for (; index < end; index += 1) {
        this.publishTaskEventPayload(events[index]!);
      }
      if (index < events.length) {
        setTimeout(publishNextChunk, 0);
      }
    };

    setTimeout(publishNextChunk, 0);
  }

  private publishTaskEventPayload(event: TaskEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  private refreshSnapshotRecord(entry: TaskEntry): void {
    this.materializeSnapshotIfDirty();
    const index = this.snapshotRecordIndexes.get(entry.record.id);
    if (index === undefined) return;
    const current = this.snapshot.records[index];
    this.snapshot.records[index] = {
      ...entry.record,
      ...(current?.queueIndex !== undefined
        ? { queueIndex: current.queueIndex }
        : {}),
      ...(current?.queueSize !== undefined
        ? { queueSize: current.queueSize }
        : {}),
    };
  }

  private publishSnapshot(): void {
    this.snapshotDirty = true;
    if (this.batchDepth > 0) {
      this.publishSnapshotAfterBatch = true;
      return;
    }
    this.scheduleSnapshotFlush();
  }

  private materializeSnapshotIfDirty(): void {
    if (!this.snapshotDirty) return;
    this.snapshot = this.buildSnapshot();
    this.snapshotDirty = false;
  }

  /**
   * Rebuild (if dirty) and notify snapshot listeners once. Cancels any pending
   * coalesced flush so a burst of transitions produces a single rebuild and a
   * single fan-out instead of one per transition.
   */
  private flushSnapshot(): void {
    this.snapshotFlushScheduled = false;
    if (
      this.snapshotRafHandle !== null &&
      typeof cancelAnimationFrame === "function"
    ) {
      cancelAnimationFrame(this.snapshotRafHandle);
    }
    this.snapshotRafHandle = null;
    this.materializeSnapshotIfDirty();
    for (const listener of this.snapshotListeners) listener();
  }

  private scheduleSnapshotFlush(): void {
    if (this.snapshotFlushScheduled) return;
    this.snapshotFlushScheduled = true;
    // The webview coalesces to a frame; tests (node, no rAF) coalesce to a
    // microtask so synchronous bursts still collapse to one fan-out.
    if (typeof requestAnimationFrame === "function") {
      this.snapshotRafHandle = requestAnimationFrame(() => {
        this.snapshotRafHandle = null;
        this.runScheduledSnapshotFlush();
      });
      return;
    }
    queueMicrotask(() => this.runScheduledSnapshotFlush());
  }

  private runScheduledSnapshotFlush(): void {
    if (!this.snapshotFlushScheduled) return;
    this.flushSnapshot();
  }

  private requestDrain(): void {
    if (this.batchDepth > 0) {
      this.drainAfterBatch = true;
      return;
    }
    this.drain();
  }

  private buildSnapshot(): TaskSnapshot {
    const counts: Record<TaskStatus, number> = {
      cancelled: 0,
      failed: 0,
      queued: 0,
      running: 0,
      succeeded: 0,
    };
    const sourceIdsInActiveEntries = new Set<string>();
    const materializedEntries: TaskEntry[] = [];
    const materializedTaskIds = new Set<string>();
    const queuePositions = new Map<
      string,
      Pick<TaskRecord, "queueIndex" | "queueSize">
    >();
    const addMaterializedEntry = (
      entry: TaskEntry | undefined,
      queuePosition?: Pick<TaskRecord, "queueIndex" | "queueSize">,
    ): boolean => {
      if (!entry || materializedTaskIds.has(entry.record.id)) {
        return false;
      }
      materializedTaskIds.add(entry.record.id);
      materializedEntries.push(entry);
      if (queuePosition) {
        queuePositions.set(entry.record.id, queuePosition);
      }
      return true;
    };
    const terminalCandidates: TaskEntry[] = [];
    const addTerminalCandidate = (entry: TaskEntry): void => {
      terminalCandidates.push(entry);
    };

    for (const entry of this.entries.values()) {
      counts[entry.record.status] += 1;
      const sourceId = entry.record.source?.id;
      if (
        sourceId &&
        (entry.record.status === "queued" || entry.record.status === "running")
      ) {
        sourceIdsInActiveEntries.add(sourceId);
      }

      if (entry.record.status === "running") {
        addMaterializedEntry(entry);
      } else if (
        entry.record.status !== "queued" &&
        !materializedTaskIds.has(entry.record.id)
      ) {
        addTerminalCandidate(entry);
      }
    }

    for (
      let queueIndex = 0;
      queueIndex < this.mainQueue.length;
      queueIndex += 1
    ) {
      const id = this.mainQueue[queueIndex]!;
      const entry = this.entries.get(id);
      if (entry?.record.status === "queued") {
        addMaterializedEntry(entry, {
          queueIndex,
          queueSize: this.mainQueue.length,
        });
      }
    }
    const sourceQueueOrderSet = new Set(this.sourceQueueOrder);
    const materializeSourceQueue = (sourceId: string): void => {
      const queue = this.sourceQueues.get(sourceId);
      if (!queue) return;
      for (
        let queueIndex = 0;
        queueIndex < queue.length;
        queueIndex += 1
      ) {
        const id = queue[queueIndex]!;
        const entry = this.entries.get(id);
        if (entry?.record.status === "queued") {
          addMaterializedEntry(entry, {
            queueIndex,
            queueSize: queue.length,
          });
        }
      }
    };
    for (const sourceId of this.sourceQueueOrder) {
      materializeSourceQueue(sourceId);
    }
    const unorderedSourceIds = [...this.sourceQueues.keys()]
      .filter((sourceId) => !sourceQueueOrderSet.has(sourceId))
      .sort();
    for (const sourceId of unorderedSourceIds) {
      materializeSourceQueue(sourceId);
    }
    // Newest terminal entries first. The sort is stable (V8), so entries with
    // equal createdAt keep insertion order, matching the previous O(n^2)
    // insertion-sort while avoiding per-entry findIndex+splice.
    terminalCandidates.sort((a, b) => b.record.createdAt - a.record.createdAt);
    for (const entry of terminalCandidates) {
      addMaterializedEntry(entry);
    }

    const records = materializedEntries.map((entry) => ({
      ...entry.record,
      ...queuePositions.get(entry.record.id),
    }));
    this.snapshotRecordIndexes = new Map(
      records.map((record, index) => [record.id, index]),
    );
    const sourceQueueOrder: string[] = [];
    const sourceQueueOrderWindowIds = new Set<string>();
    const addSourceQueueId = (sourceId: string): void => {
      if (
        sourceQueueOrderWindowIds.has(sourceId) ||
        !sourceIdsInActiveEntries.has(sourceId)
      ) {
        return;
      }
      sourceQueueOrderWindowIds.add(sourceId);
      sourceQueueOrder.push(sourceId);
    };
    for (const sourceId of this.sourceQueueOrder) {
      addSourceQueueId(sourceId);
    }
    const unorderedActiveSourceIds = [...sourceIdsInActiveEntries]
      .filter((sourceId) => !sourceQueueOrderSet.has(sourceId))
      .sort();
    for (const sourceId of unorderedActiveSourceIds) {
      addSourceQueueId(sourceId);
    }
    const total = this.entries.size;
    const sourceQueuesTotal = sourceIdsInActiveEntries.size;
    const snapshot = {
      pausedSourceIds: [...this.pausedSourceIds].sort(),
      records,
      recordLimit: records.length,
      recordsTruncated: false,
      sourceQueueLimit: sourceQueueOrder.length,
      sourceQueueOrder,
      sourceQueuesTotal,
      sourceQueuesTruncated: false,
      sourceQueuesPaused: this.sourceQueuesPaused,
      sourceAccessBlocks: this.sourceAccess.snapshot(),
      total,
      running: counts.running,
      queued: counts.queued,
      failed: counts.failed,
      succeeded: counts.succeeded,
      cancelled: counts.cancelled,
    };
    recordPerformanceObservation("scheduler.snapshot", {
      materializedRecords: records.length,
      queued: snapshot.queued,
      recordLimit: snapshot.recordLimit,
      recordsTruncated: snapshot.recordsTruncated,
      running: snapshot.running,
      sourceQueueLimit: snapshot.sourceQueueLimit,
      sourceQueuesTotal: snapshot.sourceQueuesTotal,
      sourceQueuesTruncated: snapshot.sourceQueuesTruncated,
      total,
    });
    return snapshot;
  }

  private finishQueuedAsCancelled(entry: TaskEntry): void {
    this.setStatus(entry, "cancelled", {
      canCancel: false,
      canRetry: true,
      finishedAt: Date.now(),
    });
    this.debug("queued task cancelled", entry);
    if (
      entry.dedupeKey &&
      this.activeDedupeByKey.get(entry.dedupeKey) === entry.record.id
    ) {
      this.activeDedupeByKey.delete(entry.dedupeKey);
    }
    entry.reject(new DOMException("Task was cancelled.", "AbortError"));
  }

  private cancelQueuedEntries(
    entries: TaskEntry[],
    discardCancelled: boolean,
  ): number {
    const queuedEntries = entries.filter(
      (entry) => entry.record.status === "queued",
    );
    if (queuedEntries.length === 0) return 0;

    this.removeQueuedIds(
      new Set(queuedEntries.map((entry) => entry.record.id)),
    );

    const events: TaskEvent[] = [];
    const discardedEntries: TaskEntry[] = [];
    const finishedAt = Date.now();
    let cancelled = 0;
    for (const entry of queuedEntries) {
      if (entry.record.status !== "queued") continue;
      const previousStatus = entry.record.status;
      entry.record = {
        ...entry.record,
        status: "cancelled",
        canCancel: false,
        canRetry: true,
        finishedAt,
      };
      this.entries.set(entry.record.id, entry);
      this.debug("queued task cancelled", entry);
      if (
        entry.dedupeKey &&
        this.activeDedupeByKey.get(entry.dedupeKey) === entry.record.id
      ) {
        this.activeDedupeByKey.delete(entry.dedupeKey);
      }
      entry.reject(new DOMException("Task was cancelled.", "AbortError"));
      if (discardCancelled) {
        discardedEntries.push(entry);
      } else {
        this.scheduleTerminalCleanup(entry);
      }
      events.push({ task: { ...entry.record }, previousStatus });
      cancelled += 1;
    }
    if (discardedEntries.length > 0) {
      this.deleteEntries(discardedEntries);
    }
    this.publishSnapshot();
    this.publishTaskEvents(events);
    this.requestDrain();
    return cancelled;
  }

  private removeFromSourceQueue(entry: TaskEntry): void {
    const sourceId = entry.record.source?.id;
    if (!sourceId) return;
    const queue = this.sourceQueues.get(sourceId);
    if (queue) this.removeQueuedId(queue, entry.record.id);
  }

  private removeQueuedIds(ids: ReadonlySet<string>): void {
    if (ids.size === 0) return;
    this.removeQueuedIdsFromQueue(this.mainQueue, ids);
    for (const queue of this.sourceQueues.values()) {
      this.removeQueuedIdsFromQueue(queue, ids);
    }
  }

  private removeQueuedIdsFromQueue(
    queue: string[],
    ids: ReadonlySet<string>,
  ): void {
    let writeIndex = 0;
    for (let readIndex = 0; readIndex < queue.length; readIndex += 1) {
      const id = queue[readIndex]!;
      if (ids.has(id)) continue;
      queue[writeIndex] = id;
      writeIndex += 1;
    }
    queue.length = writeIndex;
  }

  private removeQueuedId(queue: string[], id: string): void {
    const index = queue.indexOf(id);
    if (index >= 0) queue.splice(index, 1);
  }

  private queueForEntry(entry: TaskEntry): string[] | null {
    if (entry.record.lane === "main") return this.mainQueue;
    const sourceId = entry.record.source?.id;
    if (!sourceId) return null;
    return this.sourceQueues.get(sourceId) ?? null;
  }

  private ensureSourceQueueOrder(sourceId: string): void {
    if (!this.sourceQueueOrder.includes(sourceId)) {
      this.sourceQueueOrder.push(sourceId);
    }
  }

  private pruneSourceQueueOrder(sourceId: string | undefined): void {
    if (!sourceId) return;
    for (const entry of this.entries.values()) {
      if (entry.record.source?.id === sourceId) return;
    }
    const index = this.sourceQueueOrder.indexOf(sourceId);
    if (index >= 0) this.sourceQueueOrder.splice(index, 1);
  }

  private orderedSourceQueueIds(): string[] {
    const activeSourceIds = new Set<string>();
    for (const entry of this.entries.values()) {
      const sourceId = entry.record.source?.id;
      if (
        sourceId &&
        (entry.record.status === "queued" || entry.record.status === "running")
      ) {
        activeSourceIds.add(sourceId);
        this.ensureSourceQueueOrder(sourceId);
      }
    }
    return this.sourceQueueOrder.filter((sourceId) =>
      activeSourceIds.has(sourceId),
    );
  }

  private moveTargetIndex(
    currentIndex: number,
    queueLength: number,
    target: TaskMoveTarget,
  ): number {
    switch (target) {
      case "top":
        return 0;
      case "up":
        return Math.max(0, currentIndex - 1);
      case "down":
        return Math.min(queueLength - 1, currentIndex + 1);
      case "bottom":
        return queueLength - 1;
    }
  }

  private sortQueue(queue: string[], mode: TaskQueueSortMode): boolean {
    const before = queue.join("\u0000");
    queue.sort((leftId, rightId) => {
      const left = this.entries.get(leftId);
      const right = this.entries.get(rightId);
      if (!left || !right) return 0;
      return this.compareQueuedTaskOrder(left, right, mode);
    });
    return queue.join("\u0000") !== before;
  }

  private compareQueuedTaskOrder(
    left: TaskEntry,
    right: TaskEntry,
    mode: TaskQueueSortMode,
  ): number {
    switch (mode) {
      case "oldest":
        return left.record.createdAt - right.record.createdAt;
      case "newest":
        return right.record.createdAt - left.record.createdAt;
      case "priority": {
        const priority =
          priorityRank(left.record.priority) -
          priorityRank(right.record.priority);
        return priority !== 0
          ? priority
          : left.record.createdAt - right.record.createdAt;
      }
      case "title": {
        const title = left.record.title.localeCompare(
          right.record.title,
          undefined,
          { sensitivity: "base" },
        );
        return title !== 0
          ? title
          : left.record.createdAt - right.record.createdAt;
      }
    }
  }

  private compareSourceQueueOrder(
    leftSourceId: string,
    rightSourceId: string,
    mode: SourceQueueSortMode,
  ): number {
    const left = this.sourceQueueStats(leftSourceId);
    const right = this.sourceQueueStats(rightSourceId);
    switch (mode) {
      case "sourceName": {
        const name = left.name.localeCompare(right.name, undefined, {
          sensitivity: "base",
        });
        return name !== 0 ? name : leftSourceId.localeCompare(rightSourceId);
      }
      case "oldestTask":
        return left.oldestCreatedAt - right.oldestCreatedAt;
      case "newestTask":
        return right.newestCreatedAt - left.newestCreatedAt;
      case "queuedCount": {
        const count = right.activeCount - left.activeCount;
        return count !== 0 ? count : left.name.localeCompare(right.name);
      }
    }
  }

  private sourceQueueStats(sourceId: string): {
    activeCount: number;
    name: string;
    newestCreatedAt: number;
    oldestCreatedAt: number;
  } {
    let activeCount = 0;
    let name = sourceId;
    let newestCreatedAt = 0;
    let oldestCreatedAt = Number.POSITIVE_INFINITY;

    for (const entry of this.entries.values()) {
      if (entry.record.source?.id !== sourceId) continue;
      name = entry.record.source.name || sourceId;
      if (
        entry.record.status !== "queued" &&
        entry.record.status !== "running"
      ) {
        continue;
      }
      activeCount += 1;
      newestCreatedAt = Math.max(newestCreatedAt, entry.record.createdAt);
      oldestCreatedAt = Math.min(oldestCreatedAt, entry.record.createdAt);
    }

    return {
      activeCount,
      name,
      newestCreatedAt,
      oldestCreatedAt:
        oldestCreatedAt === Number.POSITIVE_INFINITY ? 0 : oldestCreatedAt,
    };
  }

  private trimHistory(): void {
    const overflowIds = this.history.overflowTaskIds(
      [...this.entries.values()].map(({ record }) => ({
        id: record.id,
        status: record.status,
        createdAt: record.createdAt,
      })),
      this.entries.size,
    );
    for (const id of overflowIds) {
      const entry = this.entries.get(id);
      if (entry) this.deleteEntry(entry);
    }
    if (overflowIds.length > 0) this.snapshot = this.buildSnapshot();
  }

  private deleteEntry(entry: TaskEntry): void {
    const sourceId = this.deleteEntryRecord(entry);
    this.pruneSourceQueueOrder(sourceId);
  }

  private deleteEntries(entries: Iterable<TaskEntry>): void {
    const sourceIds = new Set<string>();
    for (const entry of entries) {
      const sourceId = this.deleteEntryRecord(entry);
      if (sourceId) sourceIds.add(sourceId);
    }
    for (const sourceId of sourceIds) {
      this.pruneSourceQueueOrder(sourceId);
    }
  }

  private deleteEntryRecord(entry: TaskEntry): string | undefined {
    this.history.forget(entry.record.id, entry.dedupeKey);
    const sourceId = entry.record.source?.id;
    this.entries.delete(entry.record.id);
    return sourceId;
  }
}

export const taskScheduler = new TaskScheduler();
