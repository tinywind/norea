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
 * - All executor WebViews must use the same browser profile so cookies,
 *   storage, and authenticated sessions are shared without copying cookies.
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
import { recordPerformanceObservation } from "../observability";
import { MAX_SCHEDULER_MATERIALIZED_TASKS } from "../performance-budgets";

export type TaskLane = "main" | "source";

export type TaskPriority =
  | "interactive"
  | "user"
  | "normal"
  | "deferred"
  | "background";

export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type MainTaskKind =
  | "backup.export"
  | "backup.restore"
  | "library.checkUpdates"
  | "library.refreshMetadata"
  | "maintenance.clearLibraryMembership"
  | "maintenance.clearDownloadedContent"
  | "maintenance.clearReadingProgress"
  | "maintenance.clearUpdates"
  | "repository.add"
  | "repository.remove"
  | "repository.refreshIndex"
  | "plugin.install"
  | "plugin.uninstall";

export type MainLaneTaskKind = MainTaskKind;

export type SourceTaskKind =
  | "source.openSite"
  | "source.openNovel"
  | "source.listPopular"
  | "source.listLatest"
  | "source.search"
  | "source.refreshNovel"
  | "source.checkLibraryUpdates"
  | "source.globalSearch";

export type ChapterTaskKind =
  | "chapter.download"
  | "chapter.repairMedia"
  | "chapter.deleteDownload";

export type TaskKind = MainLaneTaskKind | SourceTaskKind | ChapterTaskKind;

export interface TaskSource {
  id: string;
  name: string;
}

export interface TaskSubject {
  batchId?: string;
  batchTitle?: string;
  chapterId?: number;
  chapterName?: string;
  contentType?: string;
  categoryId?: number | null;
  novelId?: number;
  novelName?: string;
  novelPath?: string;
  path?: string;
  pluginId?: string;
  url?: string;
}

export interface TaskProgress {
  current: number;
  total?: number;
}

export interface TaskRecord {
  id: string;
  lane: TaskLane;
  kind: TaskKind;
  priority: TaskPriority;
  title: string;
  source?: TaskSource;
  subject?: TaskSubject;
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  progress?: TaskProgress;
  queueIndex?: number;
  queueSize?: number;
  detail?: string;
  error?: string;
  canCancel: boolean;
  canRetry: boolean;
}

export type TaskMoveTarget = "top" | "up" | "down" | "bottom";

export type TaskQueueSortMode =
  | "oldest"
  | "newest"
  | "priority"
  | "title";

export type SourceQueueSortMode =
  | "sourceName"
  | "oldestTask"
  | "newestTask"
  | "queuedCount";

export interface TaskSnapshot {
  pausedSourceIds: string[];
  records: TaskRecord[];
  recordLimit: number;
  recordsTruncated: boolean;
  sourceQueueLimit: number;
  sourceQueueOrder: string[];
  sourceQueuesTotal: number;
  sourceQueuesTruncated: boolean;
  sourceQueuesPaused: boolean;
  total: number;
  running: number;
  queued: number;
  failed: number;
  succeeded: number;
  cancelled: number;
}

export interface TaskEvent {
  task: TaskRecord;
  previousStatus: TaskStatus | null;
}

export interface TaskRunContext {
  executor?: ScraperExecutorId;
  signal: AbortSignal;
  taskId: string;
  setDetail: (detail: string) => void;
  setProgress: (progress: TaskProgress | undefined) => void;
}

export interface TaskSpec<T> {
  lane: TaskLane;
  kind: TaskKind;
  title: string;
  priority?: TaskPriority;
  source?: TaskSource;
  subject?: TaskSubject;
  dedupeKey?: string;
  exclusive?: boolean;
  sourceCooldownKey?: string;
  sourceCooldownMs?: number;
  run: (context: TaskRunContext) => Promise<T>;
}

export interface MainTaskSpec<T>
  extends Omit<TaskSpec<T>, "lane" | "source"> {
  kind: MainLaneTaskKind;
}

export interface SourceTaskSpec<T> extends Omit<TaskSpec<T>, "lane"> {
  kind: SourceTaskKind | ChapterTaskKind;
  source: TaskSource;
}

export interface TaskHandle<T> {
  id: string;
  promise: Promise<T>;
}

export interface TaskCancelOptions {
  sourceId?: string;
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
  spec: TaskSpec<unknown>;
}

const DEFAULT_SOURCE_FOREGROUND_CONCURRENCY = 3;
const HISTORY_LIMIT = Math.min(200, MAX_SCHEDULER_MATERIALIZED_TASKS);
const TERMINAL_TASK_RETENTION_MS = 2_000;
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

function isImmediateBrowseSourceKind(kind: TaskKind): boolean {
  return (
    kind === "source.openNovel" ||
    kind === "source.listPopular" ||
    kind === "source.listLatest" ||
    kind === "source.search"
  );
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
  if (isOpenSiteSourceKind(entry.record.kind)) return true;
  return (
    entry.record.priority === "interactive" &&
    isImmediateBrowseSourceKind(entry.record.kind)
  );
}

function poolExecutorId(index: number): ScraperExecutorId {
  return `pool:${index}`;
}

const commonSecondLevelDomainLabels = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "go",
  "gov",
  "net",
  "ne",
  "or",
  "org",
  "re",
]);

function poolExecutorIndex(executorId: ScraperExecutorId): number | null {
  const match = /^pool:(\d+)$/.exec(executorId);
  return match ? Number(match[1]) : null;
}

export function sourceBaseDomainKey(baseUrl: string | undefined): string | null {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return null;
  }

  let hostname: string;
  try {
    const normalizedUrl = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    hostname = new URL(normalizedUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }

  const withoutWww = hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  if (!withoutWww || withoutWww === "localhost" || withoutWww.includes(":")) {
    return withoutWww || null;
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(withoutWww)) {
    return withoutWww;
  }

  const labels = withoutWww.split(".").filter(Boolean);
  if (labels.length <= 2) {
    return withoutWww;
  }

  const topLevel = labels[labels.length - 1]!;
  const secondLevel = labels[labels.length - 2]!;
  if (
    topLevel.length === 2 &&
    commonSecondLevelDomainLabels.has(secondLevel) &&
    labels.length >= 3
  ) {
    return labels.slice(-3).join(".");
  }

  return labels.slice(-2).join(".");
}

function makeTaskId(): string {
  return `task-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 9)}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (error instanceof Error && error.name === "AbortError");
}

export class TaskScheduler {
  private readonly activeDedupeByKey = new Map<string, string>();
  private readonly activeSourceTaskIdsById = new Map<string, Set<string>>();
  private readonly entries = new Map<string, TaskEntry>();
  private readonly eventListeners = new Set<(event: TaskEvent) => void>();
  private readonly latestByDedupeKey = new Map<string, string>();
  private readonly mainQueue: string[] = [];
  private readonly pausedSourceIds = new Set<string>();
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly snapshotListeners = new Set<() => void>();
  private readonly sourceCooldownTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly sourceCooldownUntilByKey = new Map<string, number>();
  private readonly sourceQueueOrder: string[] = [];
  private readonly sourceQueues = new Map<string, string[]>();
  private sourceForegroundConcurrency: number;
  private sourceBackgroundConcurrency: number;
  private readonly sourceBackgroundConcurrencyFollowsForeground: boolean;
  private readonly terminalTaskRetentionMs: number;
  private sourceQueuesPaused: boolean;
  private activeBackgroundCount = 0;
  private activeImmediateTaskId: string | null = null;
  private activeMainTaskId: string | null = null;
  private readonly activePoolTaskIdsByExecutor = new Map<ScraperExecutorId, string>();
  private readonly sourceExecutorBySource = new Map<string, ScraperExecutorId>();
  private readonly sourceLastServedAt = new Map<string, number>();
  private snapshot: TaskSnapshot = {
    pausedSourceIds: [],
    records: [],
    recordLimit: MAX_SCHEDULER_MATERIALIZED_TASKS,
    recordsTruncated: false,
    sourceQueueLimit: MAX_SCHEDULER_MATERIALIZED_TASKS,
    sourceQueueOrder: [],
    sourceQueuesTotal: 0,
    sourceQueuesTruncated: false,
    sourceQueuesPaused: false,
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
    this.terminalTaskRetentionMs = Math.max(
      0,
      options.terminalTaskRetentionMs ?? TERMINAL_TASK_RETENTION_MS,
    );
    this.sourceForegroundConcurrency = Math.max(
      1,
      options.sourceForegroundConcurrency ??
        DEFAULT_SOURCE_FOREGROUND_CONCURRENCY,
    );
    this.sourceBackgroundConcurrencyFollowsForeground =
      options.sourceBackgroundConcurrency === undefined;
    this.sourceBackgroundConcurrency = Math.max(
      1,
      options.sourceBackgroundConcurrency ??
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
      activeBackgroundCount: this.activeBackgroundCount,
      activeImmediateTaskId: this.activeImmediateTaskId,
      activePoolTaskIdsByExecutor: Object.fromEntries(
        this.activePoolTaskIdsByExecutor,
      ),
      activeMainTaskId: this.activeMainTaskId,
      exclusive: entry?.exclusive,
      kind: entry?.record.kind,
      lane: entry?.record.lane,
      mainQueueLength: this.mainQueue.length,
      pausedSourceIds: [...this.pausedSourceIds].sort(),
      priority: entry?.record.priority,
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
          this.drain();
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
        canCancel: true,
        canRetry: false,
      },
    };

    this.entries.set(id, entry);
    if (spec.dedupeKey) {
      this.activeDedupeByKey.set(spec.dedupeKey, id);
      this.latestByDedupeKey.set(spec.dedupeKey, id);
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
    this.drain();
    return { id, promise: promise as Promise<T> };
  }

  cancel(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.debug("cancel requested", entry);

    if (entry.record.status === "running") {
      entry.pauseRequested = false;
      entry.controller.abort();
      this.cancelRunning(entry);
      return true;
    }

    if (entry.record.status !== "queued") return false;

    if (entry.record.lane === "main") {
      this.removeQueuedId(this.mainQueue, id);
    } else if (entry.record.source) {
      const queue = this.sourceQueues.get(entry.record.source.id);
      if (queue) this.removeQueuedId(queue, id);
    }

    this.finishQueuedAsCancelled(entry);
    this.drain();
    return true;
  }

  cancelActiveTasks(options: TaskCancelOptions = {}): number {
    const cancellableTaskIds = [...this.entries.values()]
      .filter((entry) => this.isCancellableActiveEntry(entry, options))
      .sort((left, right) => {
        const leftRank = left.record.status === "queued" ? 0 : 1;
        const rightRank = right.record.status === "queued" ? 0 : 1;
        return leftRank - rightRank;
      })
      .map((entry) => entry.record.id);
    let cancelled = 0;

    for (const taskId of cancellableTaskIds) {
      if (this.cancel(taskId)) cancelled += 1;
    }

    return cancelled;
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

  private pauseRunningSourceTasks(
    sourceId?: string,
    shouldPause: (entry: TaskEntry) => boolean = () => true,
  ): number {
    let paused = 0;
    for (const entry of this.entries.values()) {
      if (
        !entry.record.canCancel ||
        entry.record.lane !== "source" ||
        entry.record.status !== "running" ||
        entry.record.kind === "source.openSite" ||
        (sourceId && entry.record.source?.id !== sourceId) ||
        !shouldPause(entry)
      ) {
        continue;
      }
      if (!entry.pauseRequested) {
        paused += 1;
      }
      entry.pauseRequested = true;
      entry.controller.abort(
        new DOMException(TASK_PAUSE_ABORT_MESSAGE, "AbortError"),
      );
    }
    return paused;
  }

  private pauseRunningInterruptibleDownloadsForUi(entry: TaskEntry): number {
    if (!this.shouldPromoteForUiResponsiveness(entry)) return 0;
    const paused = this.pauseRunningSourceTasks(undefined, (candidate) =>
      isInterruptibleDownloadKind(candidate.record.kind),
    );
    if (paused > 0) {
      this.debug("paused interruptible downloads for UI work", entry, {
        paused,
      });
    }
    return paused;
  }

  private handleUiResponsiveSourceEnqueue(entry: TaskEntry): void {
    if (!this.shouldPromoteForUiResponsiveness(entry)) return;
    this.promoteQueuedUiSourceEntry(entry);
    this.promoteSourceQueue(entry.record.source?.id);
    this.pauseRunningInterruptibleDownloadsForUi(entry);
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
    if (!options.sourceId) return true;
    return (
      entry.record.lane === "source" &&
      entry.record.source?.id === options.sourceId
    );
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

  setSourceForegroundConcurrency(concurrency: number): void {
    const nextConcurrency = Number.isFinite(concurrency)
      ? Math.max(1, Math.round(concurrency))
      : DEFAULT_SOURCE_FOREGROUND_CONCURRENCY;
    if (nextConcurrency === this.sourceForegroundConcurrency) return;
    this.sourceForegroundConcurrency = nextConcurrency;
    if (this.sourceBackgroundConcurrencyFollowsForeground) {
      this.sourceBackgroundConcurrency = nextConcurrency;
    }
    this.dropDisabledSourceExecutors();
    this.debug("source foreground concurrency changed", undefined, {
      sourceForegroundConcurrency: nextConcurrency,
      sourceBackgroundConcurrency: this.sourceBackgroundConcurrency,
    });
    this.drain();
  }

  getSnapshot = (): TaskSnapshot => this.snapshot;

  getTask(id: string): TaskRecord | undefined {
    const entry = this.entries.get(id);
    return entry ? { ...entry.record } : undefined;
  }

  getTaskByDedupeKey(key: string): TaskRecord | undefined {
    const id = this.latestByDedupeKey.get(key);
    return id ? this.getTask(id) : undefined;
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

  private drain(): void {
    this.drainMain();
    this.drainImmediateExecutor();
    this.drainSourcePool();
  }

  private drainMain(): void {
    if (this.activeMainTaskId || this.mainQueue.length === 0) return;
    let nextIndex = -1;
    let entry: TaskEntry | undefined;
    for (let index = 0; index < this.mainQueue.length; index += 1) {
      const candidate = this.entries.get(this.mainQueue[index]);
      if (!candidate || candidate.record.status !== "queued") continue;
      entry = candidate;
      nextIndex = index;
      break;
    }
    if (!entry || nextIndex < 0) return;
    this.mainQueue.splice(nextIndex, 1);
    this.activeMainTaskId = entry.record.id;
    this.start(entry);
  }

  private drainImmediateExecutor(): void {
    if (this.activeImmediateTaskId) return;
    const next = this.pickSourceTask(
      (entry) => isOpenSiteSourceKind(entry.record.kind),
      { allowPaused: true, allowActiveSource: true },
    );
    if (next) {
      this.startSource(next, "immediate");
      return;
    }
    const browse = this.pickSourceTask(
      (entry) =>
        entry.record.priority === "interactive" &&
        isImmediateBrowseSourceKind(entry.record.kind),
      { allowActiveSource: true },
    );
    if (browse) this.startSource(browse, "immediate");
  }

  private drainSourcePool(): void {
    const freeExecutorIds = this.freePoolExecutorIds();
    if (freeExecutorIds.length === 0) return;

    for (const sourceId of this.orderedSourceQueueIds()) {
      if (freeExecutorIds.length === 0) return;

      for (let index = 0; index < freeExecutorIds.length; index += 1) {
        const executorId = freeExecutorIds[index]!;
        const next = this.pickSourceTaskFromQueue(sourceId, (entry) => {
          if (shouldUseImmediateExecutor(entry)) return false;
          if (!this.canUseExecutorForSource(entry, executorId)) return false;
          if (
            isBackgroundPriority(entry.record.priority) &&
            this.activeBackgroundCount >= this.sourceBackgroundConcurrency
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

  private freePoolExecutorIds(): ScraperExecutorId[] {
    const ids: ScraperExecutorId[] = [];
    for (let index = 0; index < this.sourceForegroundConcurrency; index += 1) {
      const executorId = poolExecutorId(index);
      if (!this.activePoolTaskIdsByExecutor.has(executorId)) ids.push(executorId);
    }
    return ids;
  }

  private isEnabledPoolExecutor(executorId: ScraperExecutorId): boolean {
    const index = poolExecutorIndex(executorId);
    return index !== null && index < this.sourceForegroundConcurrency;
  }

  private assignedSourceExecutor(
    sourceId: string,
  ): ScraperExecutorId | undefined {
    const executorId = this.sourceExecutorBySource.get(sourceId);
    if (!executorId) return undefined;
    if (this.isEnabledPoolExecutor(executorId)) return executorId;
    this.sourceExecutorBySource.delete(sourceId);
    return undefined;
  }

  private dropDisabledSourceExecutors(): void {
    for (const [sourceId, executorId] of this.sourceExecutorBySource) {
      if (!this.isEnabledPoolExecutor(executorId)) {
        this.sourceExecutorBySource.delete(sourceId);
      }
    }
  }

  private canUseExecutorForSource(
    entry: TaskEntry,
    executorId: ScraperExecutorId,
  ): boolean {
    const sourceId = entry.record.source?.id;
    if (sourceId) {
      const assignedExecutor = this.assignedSourceExecutor(sourceId);
      if (assignedExecutor) return assignedExecutor === executorId;
    }
    return !this.isExecutorReservedForQueuedSource(
      executorId,
      sourceId ?? null,
    );
  }

  private isExecutorReservedForQueuedSource(
    executorId: ScraperExecutorId,
    candidateSourceId: string | null,
  ): boolean {
    for (const [sourceId, assignedExecutor] of this.sourceExecutorBySource) {
      if (sourceId === candidateSourceId) continue;
      if (assignedExecutor !== executorId) continue;
      if (!this.isEnabledPoolExecutor(assignedExecutor)) {
        this.sourceExecutorBySource.delete(sourceId);
        continue;
      }
      if (this.hasQueuedSource(sourceId)) return true;
    }
    return false;
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
    const activeIds = this.activeSourceTaskIdsById.get(sourceId) ?? new Set();
    activeIds.add(entry.record.id);
    this.activeSourceTaskIdsById.set(sourceId, activeIds);
    if (executorId !== "immediate" && !this.assignedSourceExecutor(sourceId)) {
      this.sourceExecutorBySource.set(sourceId, executorId);
    }
    entry.sourceExecutorId = executorId;
    entry.activeReleased = false;
    if (executorId === "immediate") {
      this.activeImmediateTaskId = entry.record.id;
    } else {
      this.activePoolTaskIdsByExecutor.set(executorId, entry.record.id);
    }
    if (isBackgroundPriority(entry.record.priority)) {
      this.activeBackgroundCount += 1;
    }
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
        if (!options.allowPaused && this.isSourceTaskPaused(entry)) continue;
        const cooldownDelay = this.sourceCooldownDelay(entry);
        if (cooldownDelay > 0) {
          this.scheduleSourceCooldownDrain(
            entry.spec.sourceCooldownKey!,
            cooldownDelay,
          );
          continue;
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
      if (!options.allowPaused && this.isSourceTaskPaused(entry)) continue;
      const cooldownDelay = this.sourceCooldownDelay(entry);
      if (cooldownDelay > 0) {
        this.scheduleSourceCooldownDrain(
          entry.spec.sourceCooldownKey!,
          cooldownDelay,
        );
        continue;
      }
      if (predicate(entry)) return entry;
    }

    return null;
  }

  private isSourceTaskPaused(entry: TaskEntry): boolean {
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
    const activeIds = this.activeSourceTaskIdsById.get(sourceId);
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

  private sourceCooldownDelay(entry: TaskEntry): number {
    const key = entry.spec.sourceCooldownKey;
    if (!key) return 0;
    const until = this.sourceCooldownUntilByKey.get(key);
    if (!until) return 0;

    const delay = until - Date.now();
    if (delay > 0) return delay;

    this.clearSourceCooldown(key);
    return 0;
  }

  private setSourceCooldown(entry: TaskEntry): void {
    const key = entry.spec.sourceCooldownKey;
    const cooldownMs = entry.spec.sourceCooldownMs ?? 0;
    if (!key || cooldownMs <= 0) return;

    const delayMs = Math.max(0, Math.round(cooldownMs));
    const until = Date.now() + delayMs;
    this.clearSourceCooldown(key);
    this.sourceCooldownUntilByKey.set(key, until);
    this.scheduleSourceCooldownDrain(key, delayMs);
  }

  private clearSourceCooldown(key: string): void {
    const timer = this.sourceCooldownTimers.get(key);
    if (timer) clearTimeout(timer);
    this.sourceCooldownTimers.delete(key);
    this.sourceCooldownUntilByKey.delete(key);
  }

  private scheduleSourceCooldownDrain(key: string, delayMs: number): void {
    if (this.sourceCooldownTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.sourceCooldownTimers.delete(key);
      const until = this.sourceCooldownUntilByKey.get(key);
      if (until !== undefined && until <= Date.now()) {
        this.sourceCooldownUntilByKey.delete(key);
      }
      this.drain();
    }, Math.max(0, delayMs));
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
    this.sourceCooldownTimers.set(key, timer);
  }

  private start(entry: TaskEntry): void {
    this.setStatus(entry, "running", {
      canCancel: true,
      canRetry: false,
      startedAt: Date.now(),
    });
    this.debug("started", entry);

    const context: TaskRunContext = {
      executor: entry.sourceExecutorId,
      signal: entry.controller.signal,
      taskId: entry.record.id,
      setDetail: (detail) => {
        entry.record = { ...entry.record, detail };
        this.publish(entry, entry.record.status);
      },
      setProgress: (progress) => {
        entry.record = { ...entry.record, progress };
        this.publish(entry, entry.record.status);
      },
    };

    Promise.resolve()
      .then(() => this.runWithScraperExecutorContext(entry, context))
      .then((value) => {
        if (entry.controller.signal.aborted) {
          if (entry.pauseRequested && entry.record.lane === "source") {
            this.requeuePausedRunningAfterSettlement(entry);
            return;
          }
          this.finishCancelledRunningAfterSettlement(entry);
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
        if (entry.pauseRequested && entry.record.lane === "source" && cancelled) {
          this.requeuePausedRunningAfterSettlement(entry);
          return;
        }
        if (cancelled && entry.record.status === "cancelled") {
          this.finishCancelledRunningAfterSettlement(entry);
          return;
        }
        if (!cancelled) {
          console.error("[task-scheduler] task failed", {
            error: describeError(error),
            kind: entry.record.kind,
            sourceId: entry.record.source?.id,
            taskId: entry.record.id,
            title: entry.record.title,
          });
        }
        this.finishRunning(entry, cancelled ? "cancelled" : "failed", {
          canCancel: false,
          canRetry: cancelled,
          error: cancelled ? undefined : describeError(error),
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
    this.debug("paused task settled", entry);
    this.releaseActive(entry);
    if (sourceCooldownKey) {
      this.clearSourceCooldown(sourceCooldownKey);
    }
    if (entry.dedupeKey) {
      this.activeDedupeByKey.set(entry.dedupeKey, entry.record.id);
    }
    entry.controller = new AbortController();
    entry.pauseRequested = false;

    const nextRecord = { ...entry.record };
    delete nextRecord.startedAt;
    delete nextRecord.finishedAt;
    delete nextRecord.error;
    entry.record = {
      ...nextRecord,
      status: "queued",
      canCancel: true,
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
      const insertIndex = isInterruptibleDownloadKind(entry.record.kind)
        ? this.sourceQueueUiInsertIndex(queue)
        : 0;
      queue.splice(insertIndex, 0, entry.record.id);
    }
    this.sourceQueues.set(sourceId, queue);
  }

  private releaseActive(entry: TaskEntry): void {
    if (entry.record.lane === "main") {
      if (this.activeMainTaskId === entry.record.id) this.activeMainTaskId = null;
    } else {
      const sourceId = entry.record.source?.id;
      if (sourceId) {
        const activeIds = this.activeSourceTaskIdsById.get(sourceId);
        activeIds?.delete(entry.record.id);
        const hasActiveSource = (activeIds?.size ?? 0) > 0;
        if (!hasActiveSource) {
          this.activeSourceTaskIdsById.delete(sourceId);
          if (!this.hasQueuedSource(sourceId)) {
            this.sourceExecutorBySource.delete(sourceId);
          }
        }
      }
      const fairnessKey = this.sourceFairnessKey(entry);
      if (fairnessKey) {
        this.sourceLastServedAt.set(fairnessKey, Date.now());
      }
      if (entry.sourceExecutorId === "immediate") {
        if (this.activeImmediateTaskId === entry.record.id) {
          this.activeImmediateTaskId = null;
        }
      } else if (entry.sourceExecutorId) {
        if (this.activePoolTaskIdsByExecutor.get(entry.sourceExecutorId) === entry.record.id) {
          this.activePoolTaskIdsByExecutor.delete(entry.sourceExecutorId);
        }
      }
      if (isBackgroundPriority(entry.record.priority)) {
        this.activeBackgroundCount = Math.max(
          0,
          this.activeBackgroundCount - 1,
        );
      }
      entry.sourceExecutorId = undefined;
      entry.activeReleased = true;
      this.setSourceCooldown(entry);
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

    const existingTimer = this.cleanupTimers.get(entry.record.id);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      this.cleanupTimers.delete(entry.record.id);
      const current = this.entries.get(entry.record.id);
      if (
        !current ||
        (current.record.status !== "succeeded" &&
          current.record.status !== "cancelled")
      ) {
        return;
      }
      this.deleteEntry(current);
      this.publishSnapshot();
    }, this.terminalTaskRetentionMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
    this.cleanupTimers.set(entry.record.id, timer);
  }

  private publish(entry: TaskEntry, previousStatus: TaskStatus | null): void {
    this.publishSnapshot();
    const event = { task: { ...entry.record }, previousStatus };
    for (const listener of this.eventListeners) listener(event);
  }

  private publishSnapshot(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.snapshotListeners) listener();
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
    const remainingMaterializedCapacity = () =>
      MAX_SCHEDULER_MATERIALIZED_TASKS - materializedEntries.length;
    const addMaterializedEntry = (
      entry: TaskEntry | undefined,
      queuePosition?: Pick<TaskRecord, "queueIndex" | "queueSize">,
    ): boolean => {
      if (
        !entry ||
        materializedTaskIds.has(entry.record.id) ||
        materializedEntries.length >= MAX_SCHEDULER_MATERIALIZED_TASKS
      ) {
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
      const capacity = remainingMaterializedCapacity();
      if (capacity <= 0) return;
      const insertIndex = terminalCandidates.findIndex(
        (candidate) => candidate.record.createdAt < entry.record.createdAt,
      );
      if (insertIndex < 0) {
        if (terminalCandidates.length < capacity) {
          terminalCandidates.push(entry);
        }
      } else {
        terminalCandidates.splice(insertIndex, 0, entry);
        if (terminalCandidates.length > capacity) terminalCandidates.pop();
      }
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
      queueIndex < this.mainQueue.length &&
      remainingMaterializedCapacity() > 0;
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
      if (remainingMaterializedCapacity() <= 0) return;
      const queue = this.sourceQueues.get(sourceId);
      if (!queue) return;
      for (
        let queueIndex = 0;
        queueIndex < queue.length &&
        remainingMaterializedCapacity() > 0;
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
      if (remainingMaterializedCapacity() <= 0) break;
    }
    if (remainingMaterializedCapacity() > 0) {
      const unorderedSourceIds = [...this.sourceQueues.keys()]
        .filter((sourceId) => !sourceQueueOrderSet.has(sourceId))
        .sort();
      for (const sourceId of unorderedSourceIds) {
        materializeSourceQueue(sourceId);
        if (remainingMaterializedCapacity() <= 0) break;
      }
    }
    for (const entry of terminalCandidates) {
      if (!addMaterializedEntry(entry)) break;
    }

    const records = materializedEntries.map((entry) => ({
      ...entry.record,
      ...queuePositions.get(entry.record.id),
    }));
    const sourceQueueOrder: string[] = [];
    const sourceQueueOrderWindowIds = new Set<string>();
    const addSourceQueueId = (sourceId: string): void => {
      if (
        sourceQueueOrder.length >= MAX_SCHEDULER_MATERIALIZED_TASKS ||
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
      if (sourceQueueOrder.length >= MAX_SCHEDULER_MATERIALIZED_TASKS) break;
    }
    if (sourceQueueOrder.length < MAX_SCHEDULER_MATERIALIZED_TASKS) {
      const unorderedSourceIds = [...sourceIdsInActiveEntries]
        .filter((sourceId) => !sourceQueueOrderSet.has(sourceId))
        .sort();
      for (const sourceId of unorderedSourceIds) {
        addSourceQueueId(sourceId);
        if (sourceQueueOrder.length >= MAX_SCHEDULER_MATERIALIZED_TASKS) break;
      }
    }
    const total = this.entries.size;
    const sourceQueuesTotal = sourceIdsInActiveEntries.size;
    const snapshot = {
      pausedSourceIds: [...this.pausedSourceIds].sort(),
      records,
      recordLimit: MAX_SCHEDULER_MATERIALIZED_TASKS,
      recordsTruncated: total > records.length,
      sourceQueueLimit: MAX_SCHEDULER_MATERIALIZED_TASKS,
      sourceQueueOrder,
      sourceQueuesTotal,
      sourceQueuesTruncated: sourceQueuesTotal > sourceQueueOrder.length,
      sourceQueuesPaused: this.sourceQueuesPaused,
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
    entry.reject(new Error("Task was cancelled."));
  }

  private removeFromSourceQueue(entry: TaskEntry): void {
    const sourceId = entry.record.source?.id;
    if (!sourceId) return;
    const queue = this.sourceQueues.get(sourceId);
    if (queue) this.removeQueuedId(queue, entry.record.id);
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
    if (this.entries.size <= HISTORY_LIMIT) return;
    const removable = [...this.entries.values()]
      .filter(
        (entry) =>
          entry.record.status !== "queued" && entry.record.status !== "running",
      )
      .sort((a, b) => a.record.createdAt - b.record.createdAt);
    for (const entry of removable) {
      if (this.entries.size <= HISTORY_LIMIT) return;
      this.deleteEntry(entry);
    }
    this.snapshot = this.buildSnapshot();
  }

  private deleteEntry(entry: TaskEntry): void {
    const timer = this.cleanupTimers.get(entry.record.id);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(entry.record.id);
    }
    const sourceId = entry.record.source?.id;
    this.entries.delete(entry.record.id);
    this.pruneSourceQueueOrder(sourceId);
    if (
      entry.dedupeKey &&
      this.latestByDedupeKey.get(entry.dedupeKey) === entry.record.id
    ) {
      this.latestByDedupeKey.delete(entry.dedupeKey);
    }
  }
}

export const taskScheduler = new TaskScheduler();
