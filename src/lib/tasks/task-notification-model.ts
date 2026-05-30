import type { TranslationKey } from "../../i18n";
import type {
  TaskKind,
  TaskProgress,
  TaskRecord,
  TaskSnapshot,
  TaskStatus,
} from "./scheduler";
import { getActiveChapterDownloadBatchProgress } from "./chapter-download";

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

export interface ActiveTaskNotificationGroup
  extends ActiveTaskNotificationPayload {
  key: TaskNotificationGroupKey;
  route: TaskNotificationRoute;
}

export interface TrayTaskProgressPayload {
  items: Array<{ label: string }>;
  summary: string;
}

type TaskNotificationGroupKey =
  | "downloads"
  | "libraryMetadata"
  | "libraryUpdates"
  | "search";

const ACTIVE_STATUSES = new Set<TaskStatus>(["queued", "running"]);
const TERMINAL_STATUSES = new Set<TaskStatus>([
  "cancelled",
  "failed",
  "succeeded",
]);
const AGGREGATE_TASK_KINDS = new Set<TaskKind>([
  "library.checkUpdates",
  "library.refreshMetadata",
]);
const TASK_GROUP_ORDER: TaskNotificationGroupKey[] = [
  "downloads",
  "search",
  "libraryUpdates",
  "libraryMetadata",
];

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isChapterDownloadNotificationTask(
  task: TaskRecord,
): boolean {
  return (
    task.kind === "chapter.download" || task.kind === "chapter.repairMedia"
  );
}

export function isTaskEventNotificationCandidate(
  task: TaskRecord,
): boolean {
  if (isChapterDownloadNotificationTask(task)) {
    return ACTIVE_STATUSES.has(task.status) || isTerminalTaskStatus(task.status);
  }
  return AGGREGATE_TASK_KINDS.has(task.kind);
}

export function isActiveTaskNotificationCandidate(
  task: TaskRecord,
): boolean {
  return (
    ACTIVE_STATUSES.has(task.status) &&
    taskNotificationGroupKey(task) !== null
  );
}

export function isAggregateTaskNotification(task: TaskRecord): boolean {
  return AGGREGATE_TASK_KINDS.has(task.kind);
}

export function taskNotificationRouteForTask(
  task: TaskRecord,
): TaskNotificationRoute {
  switch (task.kind) {
    case "chapter.download":
    case "chapter.repairMedia":
      return "/downloads";
    case "library.checkUpdates":
    case "library.refreshMetadata":
    case "source.checkLibraryUpdates":
    case "source.refreshNovel":
      return "/updates";
    default:
      return "/tasks";
  }
}

export function taskNotificationKey(task: TaskRecord): string {
  const groupKey = taskNotificationGroupKey(task);
  if (groupKey) return `group:${groupKey}`;
  return task.id;
}

export function taskNotificationTitleForTask(
  t: TaskNotificationTranslate,
  task: TaskRecord,
): string {
  const groupKey = taskNotificationGroupKey(task);
  return groupKey
    ? taskNotificationGroupTitle(t, groupKey, task.progress)
    : task.title;
}

export function taskNotificationProgressPercent(
  task: TaskRecord,
): number | undefined {
  const { progress } = task;
  if (!progress?.total || progress.total <= 0) return undefined;
  return Math.min(
    100,
    Math.round((progress.current / progress.total) * 100),
  );
}

export function sumTaskNotificationProgress(
  tasks: readonly TaskRecord[],
): TaskProgress | undefined {
  const progressTasks = tasks.filter(
    (task) => task.progress?.total !== undefined && task.progress.total > 0,
  );
  if (progressTasks.length === 0) return undefined;

  return progressTasks.reduce<TaskProgress>(
    (sum, task) => {
      const total = task.progress?.total ?? 0;
      const current = task.progress?.current ?? 0;
      return {
        current: sum.current + Math.min(current, total),
        total: (sum.total ?? 0) + total,
      };
    },
    { current: 0, total: 0 },
  );
}

export function buildTaskEventNotificationBody(
  t: TaskNotificationTranslate,
  task: TaskRecord,
): string {
  if (task.status === "succeeded") {
    return t("notifications.task.completed");
  }
  if (task.status === "failed") {
    return t("notifications.task.failed", {
      error: task.error ?? t("common.actionFailed"),
    });
  }
  if (task.status === "cancelled") {
    return t("notifications.task.cancelled");
  }

  const { progress } = task;
  if (progress?.total !== undefined) {
    return t("notifications.task.progress", {
      current: progress.current,
      percent: taskNotificationProgressPercent(task) ?? 0,
      total: progress.total,
    });
  }

  return t("notifications.task.running");
}

export function buildActiveTaskNotificationPayload(
  snapshot: TaskSnapshot,
  t: TaskNotificationTranslate,
): ActiveTaskNotificationPayload | null {
  const groups = buildActiveTaskNotificationGroups(snapshot, t);
  if (groups.length === 0) return null;
  if (groups.length === 1) return groups[0];

  const progress = combineGroupProgress(groups);
  const visibleGroups = groups.slice(0, 2);
  const remainingGroups = groups.length - visibleGroups.length;
  const body = [
    ...visibleGroups.map((group) => `${group.title}: ${group.body}`),
    ...(remainingGroups > 0
      ? [t("tasks.notification.moreGroups", { count: remainingGroups })]
      : []),
  ].join(" | ");

  return {
    body,
    progress,
    title: t("tasks.notification.title"),
  };
}

export function buildActiveTaskNotificationGroups(
  snapshot: TaskSnapshot,
  t: TaskNotificationTranslate,
): ActiveTaskNotificationGroup[] {
  const grouped = new Map<TaskNotificationGroupKey, TaskRecord[]>();

  for (const task of snapshot.records) {
    if (!isActiveTaskNotificationCandidate(task)) continue;
    const groupKey = taskNotificationGroupKey(task);
    if (!groupKey) continue;
    grouped.set(groupKey, [...(grouped.get(groupKey) ?? []), task]);
  }

  if (!grouped.has("downloads") && getActiveChapterDownloadBatchProgress()) {
    grouped.set("downloads", []);
  }

  return TASK_GROUP_ORDER.flatMap((groupKey) => {
    const tasks = grouped.get(groupKey);
    if (!tasks) return [];
    return [buildTaskNotificationGroup(t, groupKey, tasks)];
  });
}

export function buildTrayTaskProgressPayload(
  snapshot: TaskSnapshot,
  t: TaskNotificationTranslate,
): TrayTaskProgressPayload {
  const groups = buildActiveTaskNotificationGroups(snapshot, t);
  if (groups.length === 0) {
    return { items: [], summary: t("tasks.tray.none") };
  }

  return {
    items: groups.map((group) => ({
      label: trayTaskGroupLabel(group),
    })),
    summary:
      groups.length === 1 ? groups[0].title : t("tasks.notification.title"),
  };
}

function trayTaskGroupLabel(group: ActiveTaskNotificationGroup): string {
  if (group.key === "downloads") return group.body;
  return `${group.title} - ${group.body}`;
}

function taskNotificationGroupKey(
  task: TaskRecord,
): TaskNotificationGroupKey | null {
  switch (task.kind) {
    case "chapter.download":
    case "chapter.repairMedia":
      return "downloads";
    case "source.globalSearch":
    case "source.search":
      return "search";
    case "library.checkUpdates":
    case "source.checkLibraryUpdates":
      return "libraryUpdates";
    case "library.refreshMetadata":
    case "source.refreshNovel":
      return "libraryMetadata";
    default:
      return null;
  }
}

function taskNotificationGroupRoute(
  groupKey: TaskNotificationGroupKey,
): TaskNotificationRoute {
  switch (groupKey) {
    case "downloads":
      return "/downloads";
    case "libraryMetadata":
    case "libraryUpdates":
      return "/updates";
    case "search":
      return "/tasks";
  }
}

function taskNotificationGroupTitle(
  t: TaskNotificationTranslate,
  groupKey: TaskNotificationGroupKey,
  _progress?: TaskProgress,
): string {
  switch (groupKey) {
    case "downloads":
      return t("tasks.notification.downloads");
    case "libraryMetadata":
      return t("tasks.notification.libraryMetadata");
    case "libraryUpdates":
      return t("tasks.notification.libraryUpdates");
    case "search":
      return t("tasks.notification.search");
  }
}

function buildTaskNotificationGroup(
  t: TaskNotificationTranslate,
  groupKey: TaskNotificationGroupKey,
  tasks: readonly TaskRecord[],
): ActiveTaskNotificationGroup {
  const progress = taskNotificationGroupProgress(groupKey, tasks);
  return {
    body: activeTaskNotificationBody(t, groupKey, tasks, progress),
    key: groupKey,
    progress,
    route: taskNotificationGroupRoute(groupKey),
    title: taskNotificationGroupTitle(t, groupKey, progress),
  };
}

function taskNotificationProgressTasks(
  groupKey: TaskNotificationGroupKey,
  tasks: readonly TaskRecord[],
): readonly TaskRecord[] {
  if (groupKey === "libraryUpdates") {
    const aggregateTask = tasks.find(
      (task) => task.kind === "library.checkUpdates",
    );
    if (aggregateTask) return [aggregateTask];
  }

  if (groupKey === "libraryMetadata") {
    const aggregateTask = tasks.find(
      (task) => task.kind === "library.refreshMetadata",
    );
    if (aggregateTask) return [aggregateTask];
  }

  return tasks;
}

function taskNotificationGroupProgress(
  groupKey: TaskNotificationGroupKey,
  tasks: readonly TaskRecord[],
): TaskProgress | undefined {
  if (groupKey === "downloads") {
    const batchProgress = getActiveChapterDownloadBatchProgress();
    const standaloneTasks = tasks.filter((task) => !task.subject?.batchId);
    const standaloneProgress =
      standaloneTasks.length > 0
        ? { current: 0, total: standaloneTasks.length }
        : undefined;
    if (batchProgress && standaloneProgress) {
      return {
        current: batchProgress.current + standaloneProgress.current,
        total: batchProgress.total + (standaloneProgress.total ?? 0),
      };
    }
    return batchProgress ?? standaloneProgress;
  }

  return sumTaskNotificationProgress(
    taskNotificationProgressTasks(groupKey, tasks),
  );
}

function combineGroupProgress(
  groups: readonly ActiveTaskNotificationGroup[],
): TaskProgress | undefined {
  const progressGroups = groups.filter((group) => group.progress?.total);
  if (progressGroups.length === 0) return undefined;

  return progressGroups.reduce<TaskProgress>(
    (sum, group) => ({
      current: sum.current + (group.progress?.current ?? 0),
      total: (sum.total ?? 0) + (group.progress?.total ?? 0),
    }),
    { current: 0, total: 0 },
  );
}

function activeTaskNotificationBody(
  t: TaskNotificationTranslate,
  groupKey: TaskNotificationGroupKey,
  tasks: readonly TaskRecord[],
  progress: TaskProgress | undefined,
): string {
  if (groupKey === "downloads") {
    const progressLabel = downloadProgressLabel(t, progress);
    if (progressLabel) return progressLabel;
    return t("tasks.notification.active", {
      queued: tasks.filter((task) => task.status === "queued").length,
      running: tasks.filter((task) => task.status === "running").length,
    });
  }

  const detail = activeTaskNotificationDetail(tasks);
  if (progress?.total) {
    const current = Math.min(progress.current, progress.total);
    const percent = Math.min(100, Math.round((current / progress.total) * 100));
    const params = {
      current,
      percent,
      total: progress.total,
    };
    if (detail) {
      return t("tasks.notification.detailProgress", {
        ...params,
        detail,
      });
    }
    return t("tasks.notification.progress", params);
  }

  const activeSummary = t("tasks.notification.active", {
    queued: tasks.filter((task) => task.status === "queued").length,
    running: tasks.filter((task) => task.status === "running").length,
  });
  if (detail) return `${detail} - ${activeSummary}`;

  return activeSummary;
}

function activeTaskNotificationDetail(
  tasks: readonly TaskRecord[],
): string | undefined {
  const task = [...tasks]
    .filter((item) => !isAggregateTaskNotification(item))
    .sort(activeTaskDetailOrder)[0];
  const fallbackTask = [...tasks].sort(activeTaskDetailOrder)[0];
  return taskDetail(task) ?? taskDetail(fallbackTask);
}

function activeTaskDetailOrder(a: TaskRecord, b: TaskRecord): number {
  if (a.status !== b.status) {
    return a.status === "running" ? -1 : 1;
  }
  return (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt);
}

function taskDetail(task: TaskRecord | undefined): string | undefined {
  if (!task) return undefined;
  return (
    task.detail ??
    task.subject?.novelName ??
    task.subject?.chapterName ??
    task.source?.name ??
    task.title
  );
}

function downloadProgressLabel(
  t: TaskNotificationTranslate,
  progress: TaskProgress | undefined,
): string {
  if (!progress?.total) return "";
  return t("tasks.notification.downloadTitleProgress", {
    current: Math.min(progress.current, progress.total),
    total: progress.total,
  });
}
