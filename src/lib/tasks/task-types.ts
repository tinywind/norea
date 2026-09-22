import type { ScraperExecutorId } from "./scraper-queue";
import type { SourceAccessBlock } from "./source-access-gate";

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

export type TaskQueueSortMode = "oldest" | "newest" | "priority" | "title";

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

export interface MainTaskSpec<T> extends Omit<TaskSpec<T>, "lane" | "source"> {
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
