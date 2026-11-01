import type { TranslationKey } from "../../i18n";
import {
  getChapterDownloadBatchProgress,
  type ChapterDownloadBatchProgress,
  type ChapterDownloadBatchProgressEvent,
  type ChapterDownloadBatchResult,
} from "./chapter-download";
import { taskNotificationGroupForKind } from "./task-types";
import type {
  TaskEvent,
  TaskNotificationGroupKey,
  TaskProgress,
  TaskRecord,
  TaskSnapshot,
  TaskStatus,
} from "./task-types";

export type { TaskNotificationGroupKey } from "./task-types";
export type TaskNotificationRoute = "/downloads" | "/tasks" | "/updates";
export type TaskNotificationTranslate = (
  key: TranslationKey,
  params?: Record<string, number | string>,
) => string;

export interface ActiveTaskNotificationPayload {
  body: string;
  progress?: TaskProgress;
  title: string;
}

export interface ActiveTaskNotificationGroup extends ActiveTaskNotificationPayload {
  key: TaskNotificationGroupKey;
  paused: boolean;
  route: TaskNotificationRoute;
}

export interface TaskNotificationCompletion extends ActiveTaskNotificationPayload, ChapterDownloadBatchResult {
  key: TaskNotificationGroupKey;
  route: TaskNotificationRoute;
}

export interface TrayTaskProgressPayload {
  items: Array<{ label: string }>;
  summary: string;
}

const TASK_GROUP_ORDER: TaskNotificationGroupKey[] = [
  "downloads", "search", "libraryUpdates", "libraryMetadata",
];

interface ProgressTotals {
  current: number;
  total: number;
  unknown: number;
}

interface NotificationGroupState {
  taskIds: Set<string>;
  running: Map<string, TaskRecord>;
  queued: Map<string, TaskRecord>;
  runningAggregates: Map<string, TaskRecord>;
  queuedAggregates: Map<string, TaskRecord>;
  activeTasks: number;
  activeBatches: number;
  aggregateResults: ChapterDownloadBatchResult;
  taskResults: ChapterDownloadBatchResult;
  aggregateProgress: ProgressTotals;
  taskProgress: ProgressTotals;
  batches: Map<string, ChapterDownloadBatchProgressEvent>;
  batchProgress: ChapterDownloadBatchProgress;
}

function emptyResults(): ChapterDownloadBatchResult {
  return { succeeded: 0, failed: 0, cancelled: 0, total: 0 };
}

function emptyProgress(): ProgressTotals {
  return { current: 0, total: 0, unknown: 0 };
}

function newGroupState(): NotificationGroupState {
  return {
    taskIds: new Set(), running: new Map(), queued: new Map(),
    runningAggregates: new Map(), queuedAggregates: new Map(),
    activeTasks: 0, activeBatches: 0,
    aggregateResults: emptyResults(), taskResults: emptyResults(),
    aggregateProgress: emptyProgress(), taskProgress: emptyProgress(),
    batches: new Map(), batchProgress: { ...emptyResults(), current: 0 },
  };
}

/** Tracks each task once and applies subsequent task and batch events incrementally. */
export class TaskNotificationTracker {
  private readonly records = new Map<string, TaskRecord>();
  private readonly states = new Map<TaskNotificationGroupKey, NotificationGroupState>();
  private pausedGroups = new Set<TaskNotificationGroupKey>();

  constructor(
    snapshot: TaskSnapshot,
    batches: readonly ChapterDownloadBatchProgressEvent[] = getChapterDownloadBatchProgress(),
  ) {
    this.pausedGroups = new Set(snapshot.pausedTaskGroups ?? []);
    for (const event of batches) this.updateBatch(event);
    const activeSince = new Map<TaskNotificationGroupKey, number>();
    for (const task of snapshot.records) {
      const key = taskNotificationGroupKey(task);
      if (!key || !isActiveTaskNotificationCandidate(task)) continue;
      this.update({ task, previousStatus: null });
      activeSince.set(key, Math.min(activeSince.get(key) ?? task.createdAt, task.createdAt));
    }
    for (const task of snapshot.records) {
      const key = taskNotificationGroupKey(task);
      const since = key ? activeSince.get(key) : undefined;
      if (!key || since === undefined || !isTerminalTaskStatus(task.status) ||
          task.finishedAt === undefined || task.finishedAt < since ||
          (isChapterDownloadNotificationTask(task) && task.subject?.batchId)) continue;
      const state = this.state(key);
      state.taskIds.add(task.id);
      this.records.set(task.id, task);
      updateTaskContribution(state, task, 1);
    }
  }

  update({ task }: TaskEvent): void {
    const key = taskNotificationGroupKey(task);
    if (!key) return;
    const previous = this.records.get(task.id);
    if (!previous && isTerminalTaskStatus(task.status)) return;
    const state = this.state(key);
    if (previous) updateTaskContribution(state, previous, -1);
    else state.taskIds.add(task.id);
    this.records.set(task.id, task);
    updateTaskContribution(state, task, 1);
  }

  updateBatch(event: ChapterDownloadBatchProgressEvent): void {
    const existing = this.states.get("downloads");
    if (!event.active && !existing?.batches.has(event.batchId)) return;
    const state = existing ?? this.state("downloads");
    const previous = state.batches.get(event.batchId);
    if (previous) updateBatchContribution(state, previous, -1);
    state.batches.set(event.batchId, event);
    updateBatchContribution(state, event, 1);
  }

  groups(t: TaskNotificationTranslate, snapshot: TaskSnapshot): ActiveTaskNotificationGroup[] {
    this.pausedGroups = new Set(snapshot.pausedTaskGroups ?? []);
    return TASK_GROUP_ORDER.flatMap(key => {
      const state = this.states.get(key);
      if (!state || !hasActiveWork(state)) return [];
      const progress = groupProgress(key, state);
      const results = groupResults(state);
      const detail = groupDetail(state);
      return [{
        key,
        title: taskNotificationGroupTitle(t, key),
        body: groupBody(t, key, state, progress, detail, results),
        paused: this.pausedGroups.has(key),
        progress,
        route: taskNotificationGroupRoute(key),
      }];
    });
  }

  hasRunningWork(): boolean {
    for (const state of this.states.values()) {
      if (state.running.size > 0) return true;
    }
    return false;
  }

  takeCompletions(t: TaskNotificationTranslate): TaskNotificationCompletion[] {
    const completions: TaskNotificationCompletion[] = [];
    for (const key of TASK_GROUP_ORDER) {
      const state = this.states.get(key);
      if (!state || hasActiveWork(state) || this.pausedGroups.has(key)) continue;
      const results = groupResults(state);
      if (results.total > 0) {
        completions.push({
          key, ...results,
          title: taskNotificationGroupTitle(t, key),
          body: t("tasks.notification.results", { ...results }),
          route: taskNotificationGroupRoute(key),
        });
      }
      for (const id of state.taskIds) this.records.delete(id);
      this.states.delete(key);
    }
    return completions;
  }

  tray(t: TaskNotificationTranslate, snapshot: TaskSnapshot): TrayTaskProgressPayload {
    return trayPayload(this.groups(t, snapshot), t);
  }

  private state(key: TaskNotificationGroupKey): NotificationGroupState {
    let state = this.states.get(key);
    if (!state) {
      state = newGroupState();
      this.states.set(key, state);
    }
    return state;
  }
}

function hasActiveWork(state: NotificationGroupState): boolean {
  return state.activeTasks > 0 || state.activeBatches > 0;
}

function updateTaskContribution(state: NotificationGroupState, task: TaskRecord, direction: 1 | -1): void {
  const aggregate = isAggregateTaskNotification(task);
  const running = aggregate ? state.runningAggregates : state.running;
  const queued = aggregate ? state.queuedAggregates : state.queued;
  if (task.status === "running" || task.status === "queued") {
    state.activeTasks += direction;
    const details = task.status === "running" ? running : queued;
    if (direction > 0) details.set(task.id, task);
    else details.delete(task.id);
  }
  if (isChapterDownloadNotificationTask(task) && task.subject?.batchId) return;
  const results = aggregate ? state.aggregateResults : state.taskResults;
  results.total += direction;
  if (isTerminalTaskStatus(task.status)) results[task.status] += direction;
  const progress = aggregate ? state.aggregateProgress : state.taskProgress;
  const taskProgress = task.progress;
  if (taskProgress?.total !== undefined && taskProgress.total > 0) {
    progress.total += direction * taskProgress.total;
    progress.current += direction * Math.max(0, Math.min(taskProgress.current, taskProgress.total));
  } else progress.unknown += direction;
}

function updateBatchContribution(state: NotificationGroupState, event: ChapterDownloadBatchProgressEvent, direction: 1 | -1): void {
  if (event.active) state.activeBatches += direction;
  for (const key of ["current", "total", "succeeded", "failed", "cancelled"] as const) {
    state.batchProgress[key] += direction * event.progress[key];
  }
}

function groupResults(state: NotificationGroupState): ChapterDownloadBatchResult {
  const tasks = state.taskResults.total > 0 ? state.taskResults : state.aggregateResults;
  return {
    succeeded: tasks.succeeded + state.batchProgress.succeeded,
    failed: tasks.failed + state.batchProgress.failed,
    cancelled: tasks.cancelled + state.batchProgress.cancelled,
    total: tasks.total + state.batchProgress.total,
  };
}

function groupProgress(key: TaskNotificationGroupKey, state: NotificationGroupState): TaskProgress | undefined {
  if (key === "downloads") {
    const tasks = state.taskResults;
    const total = tasks.total + state.batchProgress.total;
    return total > 0 ? {
      current: tasks.succeeded + tasks.failed + tasks.cancelled + state.batchProgress.current,
      total,
    } : undefined;
  }
  const progress = state.aggregateResults.total > 0 ? state.aggregateProgress : state.taskProgress;
  return progress.total > 0 && progress.unknown === 0
    ? { current: progress.current, total: progress.total }
    : undefined;
}

function groupDetail(state: NotificationGroupState): string | undefined {
  const task = state.running.values().next().value ?? state.queued.values().next().value ??
    state.runningAggregates.values().next().value ?? state.queuedAggregates.values().next().value;
  return task ? task.detail ?? task.subject?.novelName ?? task.subject?.chapterName ?? task.source?.name ?? task.title : undefined;
}

function groupBody(
  t: TaskNotificationTranslate,
  key: TaskNotificationGroupKey,
  state: NotificationGroupState,
  progress: TaskProgress | undefined,
  detail: string | undefined,
  results: ChapterDownloadBatchResult,
): string {
  if (key === "downloads" && progress?.total) {
    return results.failed > 0 || results.cancelled > 0
      ? t("tasks.notification.results", { ...results })
      : t("tasks.notification.downloadTitleProgress", { current: results.succeeded, total: progress.total });
  }
  if (progress?.total) {
    const params = { current: progress.current, total: progress.total, percent: Math.min(100, Math.round(progress.current / progress.total * 100)) };
    return detail ? t("tasks.notification.detailProgress", { ...params, detail }) : t("tasks.notification.progress", params);
  }
  const active = t("tasks.notification.active", {
    running: state.running.size + state.runningAggregates.size,
    queued: state.queued.size + state.queuedAggregates.size,
  });
  return detail && key !== "downloads" ? `${detail} - ${active}` : active;
}

export function isTerminalTaskStatus(
  status: TaskStatus,
): status is "succeeded" | "failed" | "cancelled" {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function isChapterDownloadNotificationTask(task: TaskRecord): boolean {
  return task.kind === "chapter.download" || task.kind === "chapter.repairMedia";
}

export function isTaskEventNotificationCandidate(task: TaskRecord): boolean {
  return taskNotificationGroupKey(task) !== null;
}

export function isActiveTaskNotificationCandidate(task: TaskRecord): boolean {
  return (task.status === "queued" || task.status === "running") && taskNotificationGroupKey(task) !== null;
}

export function isAggregateTaskNotification(task: TaskRecord): boolean {
  return task.kind === "library.checkUpdates" || task.kind === "library.refreshMetadata";
}

export function taskNotificationGroupKey(task: TaskRecord): TaskNotificationGroupKey | null {
  return taskNotificationGroupForKind(task.kind);
}

export function taskNotificationRouteForTask(task: TaskRecord): TaskNotificationRoute {
  const key = taskNotificationGroupKey(task);
  return key ? taskNotificationGroupRoute(key) : "/tasks";
}

export function taskNotificationKey(task: TaskRecord): string {
  const key = taskNotificationGroupKey(task);
  return key ? `group:${key}` : task.id;
}

export function taskNotificationTitleForTask(t: TaskNotificationTranslate, task: TaskRecord): string {
  const key = taskNotificationGroupKey(task);
  return key ? taskNotificationGroupTitle(t, key) : task.title;
}

export function taskNotificationProgressPercent(task: TaskRecord): number | undefined {
  const progress = task.progress;
  if (!progress?.total || progress.total <= 0) return undefined;
  return Math.max(0, Math.min(100, Math.round(progress.current / progress.total * 100)));
}

export function sumTaskNotificationProgress(
  tasks: readonly Pick<TaskRecord, "progress">[],
): TaskProgress | undefined {
  if (tasks.length === 0) return undefined;
  let current = 0;
  let total = 0;
  for (const task of tasks) {
    const progress = task.progress;
    if (!progress?.total || progress.total <= 0) return undefined;
    current += Math.max(0, Math.min(progress.current, progress.total));
    total += progress.total;
  }
  return { current, total };
}

export function buildTaskEventNotificationBody(t: TaskNotificationTranslate, task: TaskRecord): string {
  if (task.status === "succeeded") return t("notifications.task.completed");
  if (task.status === "failed") return t("notifications.task.failed", { error: task.error ?? t("common.actionFailed") });
  if (task.status === "cancelled") return t("notifications.task.cancelled");
  const percent = taskNotificationProgressPercent(task);
  const progress = task.progress;
  return percent !== undefined && progress?.total !== undefined
    ? t("notifications.task.progress", { current: progress.current, percent, total: progress.total })
    : t("notifications.task.running");
}

export function buildActiveTaskNotificationGroups(snapshot: TaskSnapshot, t: TaskNotificationTranslate): ActiveTaskNotificationGroup[] {
  return new TaskNotificationTracker(snapshot).groups(t, snapshot);
}

export function buildActiveTaskNotificationPayload(snapshot: TaskSnapshot, t: TaskNotificationTranslate): ActiveTaskNotificationPayload | null {
  const groups = buildActiveTaskNotificationGroups(snapshot, t);
  if (groups.length === 0) return null;
  if (groups.length === 1) return groups[0];
  const visible = groups.slice(0, 2);
  const remaining = groups.length - visible.length;
  const progress = sumTaskNotificationProgress(groups);
  return {
    title: t("tasks.notification.title"), progress,
    body: [...visible.map(group => `${group.title}: ${group.body}`),
      ...(remaining > 0 ? [t("tasks.notification.moreGroups", { count: remaining })] : []),
    ].join(" | "),
  };
}

export function buildTrayTaskProgressPayload(snapshot: TaskSnapshot, t: TaskNotificationTranslate): TrayTaskProgressPayload {
  return trayPayload(buildActiveTaskNotificationGroups(snapshot, t), t);
}

function trayPayload(groups: readonly ActiveTaskNotificationGroup[], t: TaskNotificationTranslate): TrayTaskProgressPayload {
  return {
    items: groups.map(group => ({ label: group.key === "downloads" ? group.body : `${group.title} - ${group.body}` })),
    summary: groups.length === 0 ? t("tasks.tray.none") : groups.length === 1 ? groups[0].title : t("tasks.notification.title"),
  };
}

function taskNotificationGroupRoute(key: TaskNotificationGroupKey): TaskNotificationRoute {
  return key === "downloads" ? "/downloads" : key === "search" ? "/tasks" : "/updates";
}

function taskNotificationGroupTitle(t: TaskNotificationTranslate, key: TaskNotificationGroupKey): string {
  switch (key) {
    case "downloads": return t("tasks.notification.downloads");
    case "libraryMetadata": return t("tasks.notification.libraryMetadata");
    case "libraryUpdates": return t("tasks.notification.libraryUpdates");
    case "search": return t("tasks.notification.search");
  }
}
