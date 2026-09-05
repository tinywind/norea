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
import { recordPerformanceObservation } from "../observability";
import { MAX_SCHEDULER_MATERIALIZED_TASKS } from "../performance-budgets";
import {
  isSourceAccessRequiredError,
  normalizeSourceAccessRequiredError,
  sourceAccessScopeKey,
  type SourceAccessChallenge,
  type SourceAccessRequiredErrorShape,
} from "../plugins/source-access";
import { redactUrlsForLog } from "../url-log";

const TASK_BULK_EVENT_CHUNK_SIZE = 250;

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
  | "maintenance.clearWebViewCache"
  | "maintenance.clearReadingProgress"
  | "maintenance.clearUpdates"
  | "repository.add"
  | "repository.remove"
  | "repository.refreshIndex"
  | "plugin.install"
  | "plugin.uninstall";

export type MainLaneTaskKind = MainTaskKind;

export type SourceTaskKind =
  | "source.clearCookies"
  | "source.openSite"
  | "source.openNovel"
  | "source.previewNovel"
  | "source.mergeNovel"
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
  chapterNumber?: string;
  contentType?: string;
  categoryId?: number | null;
  novelId?: number;
  novelName?: string;
  novelPath?: string;
  path?: string;
  pluginId?: string;
  url?: string;
}

export function taskWorkQueueKey(subject: TaskSubject | undefined): string | null {
  if (!subject) return null;
  if (subject.novelId !== undefined) return `novel:${subject.novelId}`;
  const novelPath = subject.novelPath?.trim();
  if (novelPath) return `path:${novelPath}`;
  const novelName = subject.novelName?.trim();
  if (novelName) return `name:${novelName}`;
  return null;
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

export interface SourceAccessBlock {
  challenge: SourceAccessChallenge;
  challengeUrlRedacted?: boolean;
  detectedAt: number;
  originTaskId?: string;
  originTaskKey?: string;
  revision: number;
  scopeKey: string;
  sourceIds: string[];
  verificationError?: string;
  verificationRequested: boolean;
  verificationTaskId?: string;
}

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
  sourceAccessBlocks: SourceAccessBlock[];
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
  confirmSourceAccess?: () => boolean;
  executor?: ScraperExecutorId;
  setSourceAccessUrl?: (url: string) => boolean;
  shouldYield?: () => boolean;
  signal: AbortSignal;
  sourceAccessVerification?: boolean;
  taskId: string;
  setDetail: (detail: string) => void;
  setProgress: (progress: TaskProgress | undefined) => void;
  /** Returns false when the task must return so the scheduler can requeue it behind source gates. */
  tryStartSourceAccess?: () => boolean;
}

export interface TaskSpec<T> {
  lane: TaskLane;
  kind: TaskKind;
  title: string;
  priority?: TaskPriority;
  source?: TaskSource;
  subject?: TaskSubject;
  dedupeKey?: string;
  canCancel?: boolean;
  canCompleteWithoutSourceAccess?: boolean;
  exclusive?: boolean;
  requiresForegroundExecutor?: boolean;
  resolveSourceAccessUrl?: () => string | Promise<string>;
  sourceAccessScopeKey?: string;
  sourceAccessVerificationKey?: string;
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
  discardQueued?: boolean;
  sourceId?: string;
  workKey?: string;
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

interface SourceAccessBlockState
  extends Omit<SourceAccessBlock, "sourceIds"> {
  sourceIds: Set<string>;
}

const DEFAULT_SOURCE_FOREGROUND_CONCURRENCY = 3;
const HISTORY_LIMIT = Math.min(200, MAX_SCHEDULER_MATERIALIZED_TASKS);

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

function normalizedSourceAccessUrl(
  value: string,
  scopeKey: string,
): string | null {
  try {
    if (sourceAccessScopeKey(value) !== scopeKey) return null;
    return new URL(value).href;
  } catch {
    return null;
  }
}

function normalizedSourceAccessTaskKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  return key && key.length <= 512 ? key : undefined;
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
  return redactUrlsForLog(
    error instanceof Error ? error.message : String(error),
  );
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
  private readonly sourceTaskSettlementWaiters = new Map<
    string,
    Set<() => void>
  >();
  private readonly sourceCooldownTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly sourceCooldownUntilByKey = new Map<string, number>();
  private readonly sourceAccessBlocks = new Map<
    string,
    SourceAccessBlockState
  >();
  private readonly sourceQueueOrder: string[] = [];
  private readonly sourceQueues = new Map<string, string[]>();
  private sourceForegroundConcurrency: number;
  private sourceBackgroundConcurrency: number;
  private readonly sourceBackgroundConcurrencyFollowsForeground: boolean;
  private readonly terminalTaskRetentionMs: number;
  private sourceQueuesPaused: boolean;
  private sourceAccessRevision = 0;
  private activeBackgroundCount = 0;
  private activeImmediateTaskId: string | null = null;
  private activeMainTaskId: string | null = null;
  private batchDepth = 0;
  private drainAfterBatch = false;
  private publishSnapshotAfterBatch = false;
  private taskEventsAfterBatch: TaskEvent[] = [];
  private snapshotDirty = false;
  private snapshotFlushScheduled = false;
  private snapshotRafHandle: number | null = null;
  private readonly activePoolTaskIdsByExecutor = new Map<ScraperExecutorId, string>();
  private readonly sourceExecutorBySource = new Map<string, ScraperExecutorId>();
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
    this.sourceBackgroundConcurrency =
      this.sourceBackgroundConcurrencyFollowsForeground
        ? reservedBackgroundConcurrency(this.sourceForegroundConcurrency)
        : Math.max(1, options.sourceBackgroundConcurrency ?? 1);
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
      sourceAccessScopeKey: entry?.spec.sourceAccessScopeKey,
      sourceAccessScopesBlocked: this.sourceAccessBlocks.size,
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

  private nextSourceAccessRevision(): number {
    this.sourceAccessRevision += 1;
    return this.sourceAccessRevision;
  }

  private isSourceAccessScopeBlocked(scopeKey: string | undefined): boolean {
    return Boolean(scopeKey && this.sourceAccessBlocks.has(scopeKey));
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
    if (this.isSourceAccessScopeBlocked(entry.spec.sourceAccessScopeKey)) {
      return true;
    }
    for (const block of this.sourceAccessBlocks.values()) {
      if (this.matchesSourceAccessBlock(entry, block)) return true;
    }
    return false;
  }

  private registerSourceAccessScopeEntry(entry: TaskEntry): void {
    const scopeKey = entry.spec.sourceAccessScopeKey;
    const sourceId = entry.record.source?.id;
    if (!scopeKey || !sourceId) return;
    this.sourceAccessBlocks.get(scopeKey)?.sourceIds.add(sourceId);
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

    const block = this.sourceAccessBlocks.get(scopeKey);
    if (!block || entry.sourceAccessVerificationRevision !== undefined) {
      return true;
    }
    const sourceId = entry.record.source?.id;
    if (sourceId) block.sourceIds.add(sourceId);
    entry.sourceAccessPauseRequested = true;
    entry.pauseRequested = true;
    entry.controller.abort(
      new DOMException(TASK_PAUSE_ABORT_MESSAGE, "AbortError"),
    );
    this.publishSnapshot();
    return false;
  }

  private sourceAccessBlockRecords(): SourceAccessBlock[] {
    return [...this.sourceAccessBlocks.values()]
      .map((block) => ({
        challenge: { ...block.challenge },
        ...(block.challengeUrlRedacted
          ? { challengeUrlRedacted: true }
          : {}),
        detectedAt: block.detectedAt,
        ...(block.originTaskId ? { originTaskId: block.originTaskId } : {}),
        ...(block.originTaskKey ? { originTaskKey: block.originTaskKey } : {}),
        revision: block.revision,
        scopeKey: block.scopeKey,
        sourceIds: [...block.sourceIds].sort(),
        ...(block.verificationError
          ? { verificationError: block.verificationError }
          : {}),
        verificationRequested: block.verificationRequested,
        ...(block.verificationTaskId
          ? { verificationTaskId: block.verificationTaskId }
          : {}),
      }))
      .sort((left, right) => left.detectedAt - right.detectedAt);
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

    const existing = this.sourceAccessBlocks.get(scopeKey);
    const invalidatesVerification = Boolean(
      existing?.verificationRequested || existing?.verificationTaskId,
    );
    const challengeChanged = Boolean(
      existing &&
        (existing.challenge.kind !== error.challenge.kind ||
          existing.challenge.url !== error.challenge.url),
    );
    const replacesChallenge = invalidatesVerification || challengeChanged;
    const originTaskKey = replacesChallenge || !existing
      ? normalizedSourceAccessTaskKey(entry.spec.sourceAccessVerificationKey)
      : existing.originTaskKey;
    if (existing?.verificationTaskId) {
      const verificationEntry = this.entries.get(existing.verificationTaskId);
      if (verificationEntry) {
        verificationEntry.sourceAccessVerificationRevision = undefined;
      }
    }
    const revision =
      !existing || replacesChallenge
        ? this.nextSourceAccessRevision()
        : existing.revision;
    const sourceId = entry.record.source?.id;
    const sourceIds = new Set(existing?.sourceIds ?? []);
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

    const block: SourceAccessBlockState = {
      challenge: { ...error.challenge },
      detectedAt: Date.now(),
      originTaskId:
        !existing || replacesChallenge
          ? entry.record.id
          : existing.originTaskId,
      ...(originTaskKey ? { originTaskKey } : {}),
      revision,
      scopeKey,
      sourceIds,
      ...(invalidatesVerification
        ? { verificationError: describeError(error) }
        : !challengeChanged && existing?.verificationError
          ? { verificationError: existing.verificationError }
          : {}),
      verificationRequested: false,
    };
    this.sourceAccessBlocks.set(scopeKey, block);
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
      sourceAccessRevision: revision,
    });
    this.requeuePausedRunningAfterSettlement(entry);
    return true;
  }

  private hasRunningSourceAccessTask(scopeKey: string): boolean {
    const block = this.sourceAccessBlocks.get(scopeKey);
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
    for (const [scopeKey, block] of this.sourceAccessBlocks) {
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
        this.sourceAccessBlocks.set(scopeKey, {
          ...block,
          verificationRequested: false,
        });
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
      this.sourceAccessBlocks.set(scopeKey, {
        ...block,
        verificationRequested: false,
        verificationTaskId: entry.record.id,
      });
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
    if (!scopeKey || expectedRevision === undefined) return false;
    const block = this.sourceAccessBlocks.get(scopeKey);
    if (
      !block ||
      block.revision !== expectedRevision ||
      entry.sourceAccessVerificationRevision !== expectedRevision ||
      block.verificationTaskId !== entry.record.id
    ) {
      return false;
    }

    return true;
  }

  private completeSourceAccessVerificationForEntry(
    entry: TaskEntry,
    expectedRevision: number,
  ): boolean {
    const scopeKey = entry.spec.sourceAccessScopeKey;
    if (!scopeKey) return false;
    const block = this.sourceAccessBlocks.get(scopeKey);
    if (
      !block ||
      block.revision !== expectedRevision ||
      entry.sourceAccessVerificationRevision !== expectedRevision ||
      block.verificationTaskId !== entry.record.id
    ) {
      return false;
    }

    entry.sourceAccessVerificationRevision = undefined;
    this.sourceAccessBlocks.delete(scopeKey);
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
    const block = this.sourceAccessBlocks.get(scopeKey);
    if (
      !block ||
      block.revision !== revision ||
      block.verificationTaskId !== entry.record.id
    ) {
      return false;
    }

    const nextRevision = this.nextSourceAccessRevision();
    entry.sourceAccessVerificationRevision = undefined;
    this.sourceAccessBlocks.set(scopeKey, {
      ...block,
      revision: nextRevision,
      verificationError: describeError(error),
      verificationRequested: false,
      verificationTaskId: undefined,
    });
    entry.pauseRequested = true;
    this.debug("source access verification failed", entry, {
      error: describeError(error),
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
    const block = this.sourceAccessBlocks.get(scopeKey);
    if (
      !block ||
      block.revision !== revision ||
      block.verificationTaskId !== entry.record.id
    ) {
      return;
    }

    this.sourceAccessBlocks.set(scopeKey, {
      ...block,
      revision: this.nextSourceAccessRevision(),
      verificationRequested: false,
      verificationTaskId: undefined,
    });
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
    const hydrated = new Map<string, SourceAccessBlockState>();
    let highestRevision = this.sourceAccessRevision;

    for (const block of blocks) {
      const scopeKey = block.scopeKey?.trim();
      const revision = Math.floor(block.revision);
      if (
        !scopeKey ||
        !Number.isFinite(block.detectedAt) ||
        !Number.isFinite(revision) ||
        revision <= 0 ||
        !isSourceAccessRequiredError({
          challenge: block.challenge,
          code: "source-access-required",
        })
      ) {
        continue;
      }

      try {
        if (sourceAccessScopeKey(block.challenge.url) !== scopeKey) continue;
      } catch {
        continue;
      }

      const sourceIds = new Set(
        Array.isArray(block.sourceIds)
          ? block.sourceIds
              .filter((sourceId) => typeof sourceId === "string")
              .map((sourceId) => sourceId.trim())
              .filter(Boolean)
          : [],
      );
      const current = hydrated.get(scopeKey);
      if (current && current.revision > revision) continue;
      hydrated.set(scopeKey, {
        challenge: { ...block.challenge },
        ...(block.challengeUrlRedacted
          ? { challengeUrlRedacted: true }
          : {}),
        detectedAt: block.detectedAt,
        ...(normalizedSourceAccessTaskKey(block.originTaskKey)
          ? { originTaskKey: normalizedSourceAccessTaskKey(block.originTaskKey) }
          : {}),
        revision,
        scopeKey,
        sourceIds,
        ...(typeof block.verificationError === "string" &&
        block.verificationError.trim()
          ? { verificationError: block.verificationError }
          : {}),
        verificationRequested: false,
      });
      highestRevision = Math.max(highestRevision, revision);
    }

    this.sourceAccessBlocks.clear();
    for (const [scopeKey, block] of hydrated) {
      this.sourceAccessBlocks.set(scopeKey, block);
    }
    this.sourceAccessRevision = highestRevision;
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
      sourceAccessScopesBlocked: this.sourceAccessBlocks.size,
    });
    this.publishSnapshot();
    this.drain();
  }

  canBeginSourceAccessVerification(scopeKey: string): boolean {
    const block = this.sourceAccessBlocks.get(scopeKey);
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
    const block = this.sourceAccessBlocks.get(scopeKey);
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

    const current = this.sourceAccessBlocks.get(scopeKey);
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
      this.sourceAccessBlocks.set(scopeKey, {
        ...current,
        challenge: { ...current.challenge, url: rebuiltUrl },
        challengeUrlRedacted: undefined,
        originTaskId: entry.record.id,
        originTaskKey: normalizedSourceAccessTaskKey(
          entry.spec.sourceAccessVerificationKey,
        ),
      });
      this.publishSnapshot();
    }
    return { revision: current.revision, scopeKey, url: resolvedUrl };
  }

  beginSourceAccessVerification(scopeKey: string): boolean {
    if (!this.canBeginSourceAccessVerification(scopeKey)) return false;
    const block = this.sourceAccessBlocks.get(scopeKey);
    if (!block) return false;

    this.sourceAccessBlocks.set(scopeKey, {
      ...block,
      verificationError: undefined,
      verificationRequested: true,
    });
    this.debug("source access verification requested", undefined, {
      scopeKey,
      sourceAccessRevision: block.revision,
    });
    this.publishSnapshot();
    this.drain();
    return true;
  }

  keepSourceAccessBlocked(scopeKey: string): boolean {
    const block = this.sourceAccessBlocks.get(scopeKey);
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
    const revision = this.nextSourceAccessRevision();
    this.sourceAccessBlocks.set(scopeKey, {
      ...block,
      revision,
      verificationRequested: false,
      verificationTaskId: undefined,
    });
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
    this.dropDisabledSourceExecutors();
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
    const id = this.latestByDedupeKey.get(key);
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
    return (
      this.activeImmediateTaskId !== null ||
      this.activePoolTaskIdsByExecutor.size > 0
    );
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
    if (this.activeImmediateTaskId) return;
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
    const freeExecutorIds = this.freePoolExecutorIds();
    if (freeExecutorIds.length === 0) return;
    const activeImmediateEntry = this.activeImmediateTaskId
      ? this.entries.get(this.activeImmediateTaskId)
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
        const canRunBeforeSourceGates = this.canRunBeforeSourceGates(entry);
        if (
          !options.allowPaused &&
          (this.isSourceQueuePaused(entry) ||
            (this.isSourceAccessBlocked(entry) && !canRunBeforeSourceGates))
        ) {
          continue;
        }
        if (!canRunBeforeSourceGates) {
          const cooldownDelay = this.sourceCooldownDelay(entry);
          if (cooldownDelay > 0) {
            this.scheduleSourceCooldownDrain(
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
        const cooldownDelay = this.sourceCooldownDelay(entry);
        if (cooldownDelay > 0) {
          this.scheduleSourceCooldownDrain(
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

    const cooldownDelay = this.sourceCooldownDelay(entry);
    if (cooldownDelay > 0) {
      this.scheduleSourceCooldownDrain(
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
        if (
          sourceAccessVerificationRevision !== undefined &&
          sourceAccessConfirmed &&
          !this.completeSourceAccessVerificationForEntry(
            entry,
            sourceAccessVerificationRevision,
          )
        ) {
          entry.pauseRequested = true;
          this.requeuePausedRunningAfterSettlement(entry);
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
      this.clearSourceCooldown(sourceCooldownKey);
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
        this.setSourceCooldown(entry);
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
      sourceAccessBlocks: this.sourceAccessBlockRecords(),
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
      entry.reject(new Error("Task was cancelled."));
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
    const timer = this.cleanupTimers.get(entry.record.id);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(entry.record.id);
    }
    const sourceId = entry.record.source?.id;
    this.entries.delete(entry.record.id);
    if (
      entry.dedupeKey &&
      this.latestByDedupeKey.get(entry.dedupeKey) === entry.record.id
    ) {
      this.latestByDedupeKey.delete(entry.dedupeKey);
    }
    return sourceId;
  }
}

export const taskScheduler = new TaskScheduler();
