import { Alert, Button, Group, Progress, Text } from "@mantine/core";
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";
import { PageFrame, PageHeader, StateView } from "../components/AppFrame";
import {
  ArrowDownGlyph,
  ArrowUpGlyph,
  ChevronDownGlyph,
  ChevronUpGlyph,
  CloseGlyph,
  PauseGlyph,
  PlayGlyph,
  RetryGlyph,
  SortGlyph,
  TrashGlyph,
} from "../components/ActionGlyphs";
import { ConsoleStatusDot } from "../components/ConsolePrimitives";
import { IconButton } from "../components/IconButton";
import { ChapterDownloadFailureAttention } from "../components/ChapterDownloadFailureAttention";
import { DownloadGoalAttention } from "../components/DownloadGoalAttention";
import { DownloadGoalWorkLine } from "../components/DownloadGoalWorkLine";
import { VpnDownloadAttention } from "../components/VpnDownloadAttention";
import { VpnDownloadLaunchDialog } from "../components/VpnDownloadLaunchDialog";
import { VpnDownloadWorkRow, vpnDownloadWorks } from "../components/VpnDownloadWorks";
import { TextButton } from "../components/TextButton";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { VpnIcon } from "../components/ui/icons";
import { OverflowMenu } from "../components/ui/OverflowMenu";
import { useTranslation, type TranslationKey } from "../i18n";
import { describeError } from "../lib/errors";
import { cancelChapterDownloadBatches } from "../lib/tasks/chapter-download";
import { cancelChapterDownloadRequest } from "../lib/tasks/chapter-download-requests";
import { useTaskSnapshot, useVpnDownloadRuntimeSnapshot, useChapterDownloadRequestSnapshot } from "../lib/tasks/hooks";
import { pauseVpnDownloadRun, resumeVpnDownloadRun, cancelVpnDownloadRun } from "../lib/tasks/vpn-download-runtime";
import {
  applySourceAccessBrowserOutcome,
  cancelSourceAccessWait,
  openSourceAccessBrowser,
  sourceAccessBlockSourceNames,
} from "../lib/tasks/source-access-coordinator";
import {
  taskWorkQueueKey,
  taskScheduler,
  type SourceAccessBlock,
  type SourceQueueSortMode,
  type TaskPriority,
  type TaskQueueSortMode,
  type TaskRecord,
  type TaskSnapshot,
  type TaskStatus,
} from "../lib/tasks/scheduler";
import {
  normalizeFontScalePercent,
  useAppearanceStore,
} from "../store/appearance";
import { useSiteBrowserStore } from "../store/site-browser";
import "../styles/tasks.css";

const TASK_ROW_HEIGHT = 72;
const TASK_ROW_OVERSCAN = 8;
const TASK_VIRTUAL_FALLBACK_ROWS = 14;
const TASK_VIRTUALIZATION_THRESHOLD = 80;

const ACTIVE_STATUSES = new Set<TaskStatus>(["queued", "running"]);

type SourceTaskGroup = {
  sourceId: string;
  sourceName: string;
  tasks: TaskRecord[];
};

type SourceWorkTaskGroup = {
  queueIndex: number;
  tasks: TaskRecord[];
  title: string;
  workKey: string;
};

type SourceTaskGroupItem =
  | { type: "task"; task: TaskRecord }
  | { type: "work"; group: SourceWorkTaskGroup };

type ChapterDownloadTaskHeading = {
  chapterLabel: string;
  novelName: string;
  title: string;
};

function isRetryWaiting(task: TaskRecord): boolean {
  return task.status === "queued" && task.retryAt !== undefined;
}

function RetryCountdown({ retryAt }: { retryAt: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [retryAt]);
  const seconds = Math.max(1, Math.ceil((retryAt - now) / 1_000));
  const time = seconds < 60
    ? t("time.secondsShort", { count: seconds })
    : t("time.minutesShort", { count: Math.ceil(seconds / 60) });
  return (
    <Text className="norea-task-row-detail" lineClamp={1} role="status">
      {t("tasks.retryingIn", { time })}
    </Text>
  );
}

function isActiveTask(task: TaskRecord): boolean {
  return ACTIVE_STATUSES.has(task.status);
}

function taskQueueStatusRank(status: TaskStatus): number {
  switch (status) {
    case "running":
      return 0;
    case "queued":
      return 1;
    case "failed":
      return 2;
    case "cancelled":
      return 3;
    case "succeeded":
      return 4;
  }
}

function taskQueuePriorityRank(priority: TaskPriority): number {
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

function taskQueueKey(task: TaskRecord): string {
  return task.lane === "main"
    ? "main"
    : `source:${task.source?.id ?? "unknown"}`;
}

function compareTaskQueueOrder(left: TaskRecord, right: TaskRecord): number {
  const status =
    taskQueueStatusRank(left.status) - taskQueueStatusRank(right.status);
  if (status !== 0) return status;

  if (
    left.status === "queued" &&
    right.status === "queued" &&
    taskQueueKey(left) === taskQueueKey(right) &&
    left.queueIndex !== undefined &&
    right.queueIndex !== undefined
  ) {
    return left.queueIndex - right.queueIndex;
  }

  if (isActiveTask(left) && isActiveTask(right)) {
    const priority =
      taskQueuePriorityRank(left.priority) -
      taskQueuePriorityRank(right.priority);
    if (priority !== 0) return priority;
    return left.createdAt - right.createdAt;
  }

  return right.createdAt - left.createdAt;
}

function taskStatusKey(status: TaskStatus): TranslationKey {
  switch (status) {
    case "queued":
      return "tasks.status.queued";
    case "running":
      return "tasks.status.running";
    case "succeeded":
      return "tasks.status.succeeded";
    case "failed":
      return "tasks.status.failed";
    case "cancelled":
      return "tasks.status.cancelled";
  }
}

function taskPriorityKey(priority: TaskPriority): TranslationKey {
  switch (priority) {
    case "interactive":
      return "tasks.priority.interactive";
    case "user":
      return "tasks.priority.user";
    case "normal":
      return "tasks.priority.normal";
    case "deferred":
      return "tasks.priority.deferred";
    case "background":
      return "tasks.priority.background";
  }
}

function statusTone(
  status: TaskStatus,
): "active" | "done" | "error" | "idle" | "warning" {
  switch (status) {
    case "queued":
      return "idle";
    case "running":
      return "active";
    case "succeeded":
      return "done";
    case "failed":
      return "error";
    case "cancelled":
      return "warning";
  }
}

function taskMeta(
  t: ReturnType<typeof useTranslation>["t"],
  task: TaskRecord,
): string {
  const lane =
    task.lane === "main" ? t("tasks.lane.main") : t("tasks.lane.source");
  return [task.source?.name, lane, t(taskPriorityKey(task.priority))]
    .filter(Boolean)
    .join(" / ");
}

function progressLabel(task: TaskRecord): string | null {
  const progress = task.progress;
  if (!progress?.total) return null;
  return `${progress.current}/${progress.total}`;
}

function chapterDownloadTaskHeading(
  task: TaskRecord,
): ChapterDownloadTaskHeading | null {
  if (task.kind !== "chapter.download") return null;
  const novelName = task.subject?.novelName?.trim();
  const chapterNumber = task.subject?.chapterNumber?.trim();
  const chapterName = task.subject?.chapterName?.trim();
  const chapterLabelSource = chapterNumber || chapterName;
  if (!novelName || !chapterLabelSource) return null;
  const chapterLabel = chapterNumber
    ? chapterNumber.startsWith("#")
      ? chapterNumber
      : `#${chapterNumber}`
    : chapterLabelSource;
  return {
    chapterLabel,
    novelName,
    title: `${novelName} - ${chapterLabel}`,
  };
}

function sourceWorkTaskTitle(task: TaskRecord): string {
  const novelName = task.subject?.novelName?.trim();
  if (novelName) return novelName;
  const novelPath = task.subject?.novelPath?.trim();
  if (novelPath) return novelPath;
  return task.title;
}

function groupSourceTasksByWork(tasks: TaskRecord[]): SourceTaskGroupItem[] {
  const items: SourceTaskGroupItem[] = [];
  const groupsByKey = new Map<string, SourceWorkTaskGroup>();

  for (const task of tasks) {
    const workKey = taskWorkQueueKey(task.subject);
    if (!workKey) {
      items.push({ type: "task", task });
      continue;
    }

    const group = groupsByKey.get(workKey);
    if (group) {
      group.queueIndex = Math.min(group.queueIndex, task.queueIndex ?? Infinity);
      group.tasks.push(task);
    } else {
      const nextGroup = {
        queueIndex: task.queueIndex ?? Infinity,
        tasks: [task],
        title: sourceWorkTaskTitle(task),
        workKey,
      };
      groupsByKey.set(workKey, nextGroup);
      items.push({ type: "work", group: nextGroup });
    }
  }

  return items.sort((left, right) => {
    const leftIndex = left.type === "work" ? left.group.queueIndex : left.task.queueIndex ?? Infinity;
    const rightIndex = right.type === "work" ? right.group.queueIndex : right.task.queueIndex ?? Infinity;
    return leftIndex - rightIndex;
  });
}

function sourceWorkOpenKey(sourceId: string, workKey: string): string {
  return `${sourceId}::${workKey}`;
}

function TaskSortMenu() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const sortTasks = (mode: TaskQueueSortMode) => {
    taskScheduler.sortQueuedTasks(mode);
    setOpen(false);
  };
  const sortSources = (mode: SourceQueueSortMode) => {
    taskScheduler.sortSourceQueues(mode);
    setOpen(false);
  };

  return (
    <div className="norea-task-sort-menu">
      <IconButton
        active={open}
        aria-expanded={open}
        label={t("tasks.sort")}
        onClick={() => setOpen((value) => !value)}
        size="lg"
      >
        <SortGlyph />
      </IconButton>
      {open ? (
        <div className="norea-task-sort-popover" role="menu">
          <div className="norea-task-sort-section">
            <span className="norea-task-sort-heading">
              {t("tasks.sortTasks")}
            </span>
            <button type="button" onClick={() => sortTasks("oldest")}>
              {t("tasks.sortTasksOldest")}
            </button>
            <button type="button" onClick={() => sortTasks("newest")}>
              {t("tasks.sortTasksNewest")}
            </button>
            <button type="button" onClick={() => sortTasks("priority")}>
              {t("tasks.sortTasksPriority")}
            </button>
            <button type="button" onClick={() => sortTasks("title")}>
              {t("tasks.sortTasksTitle")}
            </button>
          </div>
          <div className="norea-task-sort-section">
            <span className="norea-task-sort-heading">
              {t("tasks.sortSources")}
            </span>
            <button type="button" onClick={() => sortSources("sourceName")}>
              {t("tasks.sortSourcesName")}
            </button>
            <button type="button" onClick={() => sortSources("oldestTask")}>
              {t("tasks.sortSourcesOldest")}
            </button>
            <button type="button" onClick={() => sortSources("newestTask")}>
              {t("tasks.sortSourcesNewest")}
            </button>
            <button type="button" onClick={() => sortSources("queuedCount")}>
              {t("tasks.sortSourcesCount")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function activeSourceTaskCounts(records: TaskRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of records) {
    const sourceId = task.source?.id;
    if (task.lane !== "source" || !sourceId || !isActiveTask(task)) continue;
    counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
  }
  return counts;
}

function hasBlockingSourceTask(
  task: TaskRecord,
  sourceActiveTaskCounts: Map<string, number>,
): boolean {
  if (task.priority !== "background" || task.status !== "queued") {
    return false;
  }
  const sourceId = task.source?.id;
  if (!sourceId) return false;
  return (sourceActiveTaskCounts.get(sourceId) ?? 0) > 1;
}

function isSourceQueuePaused(task: TaskRecord, snapshot: TaskSnapshot): boolean {
  if (task.kind === "source.openSite") return false;
  return Boolean(
    task.source &&
      isActiveTask(task) &&
      (snapshot.sourceQueuesPaused ||
        snapshot.pausedSourceIds.includes(task.source.id)),
  );
}

function hasCancellableActiveTask(records: TaskRecord[]): boolean {
  return records.some((task) => task.canCancel && isActiveTask(task));
}

function cancellableActiveTaskCount(records: TaskRecord[]): number {
  return records.filter((task) => task.canCancel && isActiveTask(task)).length;
}

function activeChapterDownloadBatchIds(records: TaskRecord[]): string[] {
  const batchIds = new Set<string>();
  for (const task of records) {
    if (task.kind !== "chapter.download" || !isActiveTask(task)) continue;
    const batchId = task.subject?.batchId;
    if (batchId) batchIds.add(batchId);
  }
  return [...batchIds];
}

function hasQueuedTask(records: TaskRecord[]): boolean {
  return records.some((task) => task.status === "queued");
}

function useLiveTaskRecord(task: TaskRecord): TaskRecord {
  const [liveTask, setLiveTask] = useState(task);

  useEffect(() => {
    setLiveTask(task);
  }, [task]);

  useEffect(
    () =>
      taskScheduler.subscribeEvents((event) => {
        if (event.task.id === task.id) {
          setLiveTask(event.task);
        }
      }),
    [task.id],
  );

  return liveTask.id === task.id ? liveTask : task;
}

const TaskRow = memo(function TaskRow({
  blockingSourceTask,
  onSelect,
  selected,
  sourcePaused,
  sourceQueuesPaused,
  task,
}: {
  blockingSourceTask: boolean;
  onSelect: () => void;
  selected: boolean;
  sourcePaused: boolean;
  sourceQueuesPaused: boolean;
  task: TaskRecord;
}) {
  const { t } = useTranslation();
  const currentTask = useLiveTaskRecord(task);
  const label = progressLabel(currentTask);
  const chapterHeading = chapterDownloadTaskHeading(currentTask);
  const canMove =
    currentTask.status === "queued" &&
    currentTask.queueIndex !== undefined &&
    currentTask.queueSize !== undefined &&
    currentTask.queueSize > 1;
  const showActions = selected || currentTask.status !== "queued";
  const retry = () => {
    const handle = taskScheduler.retry(currentTask.id);
    if (handle) void handle.promise.catch(() => undefined);
  };

  return (
    <div
      aria-selected={selected}
      className="norea-task-row"
      data-selected={selected ? "true" : undefined}
      data-status={currentTask.status}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <ConsoleStatusDot
        status={statusTone(currentTask.status)}
        label={t(taskStatusKey(currentTask.status))}
      />
      <div className="norea-task-row-main">
        <div className="norea-task-row-heading">
          {chapterHeading ? (
            <div
              className="norea-task-row-title norea-task-row-download-title"
              title={chapterHeading.title}
            >
              <span className="norea-task-row-download-novel">
                {chapterHeading.novelName}
              </span>
              <span className="norea-task-row-download-chapter">
                {chapterHeading.chapterLabel}
              </span>
            </div>
          ) : (
            <Text className="norea-task-row-title" lineClamp={1}>
              {currentTask.title}
            </Text>
          )}
          {label ? <span className="norea-task-progress-text">{label}</span> : null}
        </div>
        <Text className="norea-task-row-meta" lineClamp={1}>
          {taskMeta(t, currentTask)}
        </Text>
        {isRetryWaiting(currentTask) ? (
          <RetryCountdown retryAt={currentTask.retryAt!} />
        ) : sourcePaused ? (
          <Text className="norea-task-row-detail" lineClamp={1}>
            {sourceQueuesPaused
              ? t("tasks.allSourcesPaused")
              : t("tasks.sourcePaused")}
          </Text>
        ) : currentTask.waitingForNetwork ? (
          <Text className="norea-task-row-detail" lineClamp={1}>
            {t("network.waiting")}
          </Text>
        ) : blockingSourceTask ? (
          <Text className="norea-task-row-detail" lineClamp={1}>
            {t("tasks.downloadWaiting")}
          </Text>
        ) : currentTask.detail ? (
          <Text className="norea-task-row-detail" lineClamp={1}>
            {currentTask.detail}
          </Text>
        ) : null}
        {currentTask.error ? (
          <Text className="norea-task-row-error" lineClamp={1}>
            {currentTask.error}
          </Text>
        ) : null}
        {currentTask.progress ? (
          <Progress
            className="norea-task-row-progress"
            size="xs"
            value={
              currentTask.progress.total
                ? Math.min(
                    100,
                    (currentTask.progress.current /
                      currentTask.progress.total) *
                      100,
                  )
                : 100
            }
            animated={!currentTask.progress.total}
          />
        ) : null}
      </div>
      <div className="norea-task-row-actions">
        {showActions && canMove ? (
          <>
            <IconButton
              disabled={currentTask.queueIndex === 0}
              label={t("tasks.moveTaskTop")}
              onClick={() =>
                taskScheduler.moveQueuedTask(currentTask.id, "top")
              }
              size="lg"
            >
              <ArrowUpGlyph />
            </IconButton>
            <IconButton
              disabled={currentTask.queueIndex === currentTask.queueSize! - 1}
              label={t("tasks.moveTaskBottom")}
              onClick={() =>
                taskScheduler.moveQueuedTask(currentTask.id, "bottom")
              }
              size="lg"
            >
              <ArrowDownGlyph />
            </IconButton>
          </>
        ) : null}
        {showActions && currentTask.canCancel ? (
          <IconButton
            label={t("common.cancel")}
            onClick={() => taskScheduler.cancel(currentTask.id)}
            size="lg"
            tone="danger"
          >
            <CloseGlyph />
          </IconButton>
        ) : null}
        {showActions && currentTask.canRetry ? (
          <IconButton label={t("common.retry")} onClick={retry} size="lg">
            <RetryGlyph />
          </IconButton>
        ) : null}
      </div>
    </div>
  );
});

function TaskWorkGroup({
  group,
  open,
  onSelectTask,
  onToggleOpen,
  selectedTaskId,
  sourceActiveTaskCounts,
  snapshot,
  sourceId,
}: {
  group: SourceWorkTaskGroup;
  open: boolean;
  onSelectTask: (taskId: string) => void;
  onToggleOpen: () => void;
  selectedTaskId: string | null;
  sourceActiveTaskCounts: Map<string, number>;
  snapshot: TaskSnapshot;
  sourceId: string;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const canMove = hasQueuedTask(group.tasks);
  const canCancel = hasCancellableActiveTask(group.tasks);
  const retryWaits = group.tasks.filter(isRetryWaiting).map((task) => task.retryAt!);
  const nextRetryAt = retryWaits.length > 0 ? Math.min(...retryWaits) : null;

  return (
    <div
      className="norea-task-work-group"
      data-collapsed={open ? undefined : "true"}
    >
      <div className="norea-task-work-header">
        <div className="norea-task-work-copy">
          <Text className="norea-task-work-title" lineClamp={1}>
            {group.title}
          </Text>
          <span className="norea-task-group-count">
            {t("tasks.count", { count: group.tasks.length })}
          </span>
          {nextRetryAt !== null ? <RetryCountdown retryAt={nextRetryAt} /> : null}
          <DownloadGoalWorkLine records={snapshot.records} tasks={group.tasks} />
        </div>
        <div className="norea-task-group-actions">
          <IconButton
            active={!open}
            label={open ? t("tasks.collapse") : t("tasks.expand")}
            onClick={onToggleOpen}
            size="lg"
          >
            {open ? <ChevronUpGlyph /> : <ChevronDownGlyph />}
          </IconButton>
          <IconButton
            disabled={!canMove}
            label={t("tasks.moveWorkTop")}
            onClick={() =>
              taskScheduler.moveSourceWorkQueue(
                sourceId,
                group.workKey,
                "top",
              )
            }
            size="lg"
          >
            <ArrowUpGlyph />
          </IconButton>
          <IconButton
            disabled={!canMove}
            label={t("tasks.moveWorkBottom")}
            onClick={() =>
              taskScheduler.moveSourceWorkQueue(
                sourceId,
                group.workKey,
                "bottom",
              )
            }
            size="lg"
          >
            <ArrowDownGlyph />
          </IconButton>
          {canCancel ? (
            <IconButton
              label={t("tasks.cancelWorkCurrent")}
              onClick={async () => {
                const confirmed = await confirm({
                  title: t("tasks.cancelGroupConfirm.title", { name: group.title }),
                  message: t("tasks.cancelWorkConfirm.message", {
                    count: cancellableActiveTaskCount(group.tasks),
                  }),
                  confirmLabel: t("tasks.cancelWorkCurrent"),
                  cancelLabel: t("common.keep"),
                  danger: true,
                });
                if (!confirmed) return;
                cancelChapterDownloadBatches(
                  activeChapterDownloadBatchIds(group.tasks),
                );
                taskScheduler.cancelActiveTasks({
                  discardQueued: true,
                  sourceId,
                  workKey: group.workKey,
                });
              }}
              size="lg"
              tone="danger"
            >
              <CloseGlyph />
            </IconButton>
          ) : null}
        </div>
      </div>
      {open ? (
        <TaskRows
          className="norea-task-work-rows"
          renderTask={(task) => (
            <TaskRow
              blockingSourceTask={hasBlockingSourceTask(
                task,
                sourceActiveTaskCounts,
              )}
              key={task.id}
              onSelect={() => onSelectTask(task.id)}
              selected={selectedTaskId === task.id}
              sourcePaused={isSourceQueuePaused(task, snapshot)}
              sourceQueuesPaused={snapshot.sourceQueuesPaused}
              task={task}
            />
          )}
          tasks={group.tasks}
        />
      ) : null}
    </div>
  );
}

function TaskRows({
  className,
  renderTask,
  tasks,
}: {
  className: string;
  renderTask: (task: TaskRecord) => ReactNode;
  tasks: TaskRecord[];
}) {
  if (tasks.length <= TASK_VIRTUALIZATION_THRESHOLD) {
    return <div className={className}>{tasks.map(renderTask)}</div>;
  }

  return (
    <VirtualTaskRows
      className={className}
      renderTask={renderTask}
      tasks={tasks}
    />
  );
}

function VirtualTaskRows({
  className,
  renderTask,
  tasks,
}: {
  className: string;
  renderTask: (task: TaskRecord) => ReactNode;
  tasks: TaskRecord[];
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const pendingScrollTopRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const fontScalePercent = useAppearanceStore(
    (state) => state.fontScalePercent,
  );
  const taskRowHeight =
    TASK_ROW_HEIGHT * (normalizeFontScalePercent(fontScalePercent) / 100);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(
    taskRowHeight * TASK_VIRTUAL_FALLBACK_ROWS,
  );
  const totalHeight = tasks.length * taskRowHeight;
  const startIndex = Math.max(
    0,
    Math.floor(scrollTop / taskRowHeight) - TASK_ROW_OVERSCAN,
  );
  const endIndex = Math.min(
    tasks.length,
    Math.ceil((scrollTop + viewportHeight) / taskRowHeight) +
      TASK_ROW_OVERSCAN,
  );
  const visibleTasks = tasks.slice(startIndex, endIndex);
  const offsetY = startIndex * taskRowHeight;

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    const updateViewportHeight = () => {
      setViewportHeight(element.clientHeight || TASK_ROW_HEIGHT);
    };

    updateViewportHeight();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateViewportHeight);

    resizeObserver?.observe(element);
    window.addEventListener("resize", updateViewportHeight);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateViewportHeight);
    };
  }, []);

  useEffect(() => {
    const maxScrollTop = Math.max(0, totalHeight - viewportHeight);
    setScrollTop((current) => Math.min(current, maxScrollTop));
  }, [totalHeight, viewportHeight]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    },
    [],
  );

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    pendingScrollTopRef.current = event.currentTarget.scrollTop;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      setScrollTop(pendingScrollTopRef.current);
    });
  };

  return (
    <div
      className={`${className} norea-task-virtual-viewport`}
      onScroll={handleScroll}
      ref={viewportRef}
    >
      <div
        className="norea-task-virtual-spacer"
        style={{ height: totalHeight }}
      >
        <div
          className="norea-task-virtual-window"
          style={{ transform: `translateY(${offsetY}px)` }}
        >
          {visibleTasks.map(renderTask)}
        </div>
      </div>
    </div>
  );
}

function SummaryPill({
  children,
  tone,
}: {
  children: string;
  tone?: "error" | "warning";
}) {
  return (
    <span className="norea-task-summary-pill" data-tone={tone}>
      {children}
    </span>
  );
}

function SourceAccessBanner({
  block,
  snapshot,
}: {
  block: SourceAccessBlock;
  snapshot: TaskSnapshot;
}) {
  const { t } = useTranslation();
  const browserVisible = useSiteBrowserStore((state) => state.visible);
  const sourceNames = sourceAccessBlockSourceNames(block, snapshot);
  const hostname = (() => {
    try {
      return new URL(block.challenge.url).hostname;
    } catch {
      return block.sourceId;
    }
  })();
  const sourceLabel = sourceNames.length > 0 ? sourceNames.join(", ") : hostname;
  const title =
    block.challenge.kind === "captcha"
      ? t("sourceAccess.captchaTitle")
      : t("sourceAccess.cloudflareTitle");
  const verifying =
    block.verificationRequested || block.verificationTaskId !== undefined;
  const canOpenVerification =
    taskScheduler.canBeginSourceAccessVerification(block.scopeKey);

  return (
    <section className="norea-source-access-banner" role="alert">
      <div className="norea-source-access-copy">
        <Text component="h2" fw={700} size="sm">
          {title} · {hostname}
        </Text>
        <Text c="dimmed" component="p" size="sm">
          {t("sourceAccess.scopeBlocked", { sources: sourceLabel })}
        </Text>
        {block.verificationError ? (
          <Text c="danger" component="p" size="sm">
            {t("sourceAccess.verificationFailed", {
              error: block.verificationError,
            })}
          </Text>
        ) : null}
        {!verifying && !canOpenVerification ? (
          <Text c="dimmed" component="p" size="sm">
            {t("sourceAccess.queueTaskToVerify")}
          </Text>
        ) : null}
        <Text c="dimmed" component="p" size="sm">
          {t("sourceAccess.forceStopHelp")}
        </Text>
      </div>
      <Group gap="xs" justify="flex-end">
        <Button
          disabled={browserVisible || verifying || !canOpenVerification}
          onClick={() => {
            void openSourceAccessBrowser(block, {
              sourceName: sourceLabel,
              title,
            });
          }}
          size="xs"
          variant="light"
        >
          {t("sourceAccess.openVerification")}
        </Button>
        <Button
          disabled={browserVisible || verifying || !canOpenVerification}
          loading={verifying}
          onClick={() =>
            applySourceAccessBrowserOutcome(taskScheduler, block, "verify")
          }
          size="xs"
          variant="light"
        >
          {verifying
            ? t("sourceAccess.verifying")
            : t("sourceAccess.verifyAndResume")}
        </Button>
        <Button
          color="danger"
          onClick={() => cancelSourceAccessWait(block.scopeKey, block.revision)}
          size="xs"
          variant="light"
        >
          {t("sourceAccess.forceStopAndContinue")}
        </Button>
      </Group>
    </section>
  );
}

function TaskGroup({
  collapsed,
  onSelectTask,
  onToggleCollapsed,
  onToggleWorkGroup,
  openWorkGroupKey,
  selectedTaskId,
  snapshot,
  sourceActiveTaskCounts,
  sourceId,
  sourcePaused,
  tasks,
  title,
}: {
  collapsed?: boolean;
  onSelectTask: (taskId: string) => void;
  onToggleCollapsed?: () => void;
  onToggleWorkGroup?: (key: string) => void;
  openWorkGroupKey?: string | null;
  selectedTaskId: string | null;
  snapshot: TaskSnapshot;
  sourceActiveTaskCounts: Map<string, number>;
  sourceId?: string;
  sourcePaused?: boolean;
  tasks: TaskRecord[];
  title: string;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const hasCancellableTasks = hasCancellableActiveTask(tasks);
  const sourceCollapsed = Boolean(sourceId && collapsed);
  const sourceItems = sourceId ? groupSourceTasksByWork(tasks) : [];

  return (
    <section
      className="norea-task-group"
      data-collapsed={sourceCollapsed ? "true" : undefined}
      data-source-group={sourceId ? "true" : undefined}
    >
      <header className="norea-task-group-header">
        <div className="norea-task-group-copy">
          <Text className="norea-task-group-title" lineClamp={1}>
            {title}
          </Text>
          <span className="norea-task-group-count">
            {t("tasks.count", { count: tasks.length })}
          </span>
        </div>
        <div className="norea-task-group-actions">
          {sourceId ? (
            <IconButton
              active={sourceCollapsed}
              label={
                sourceCollapsed ? t("tasks.expand") : t("tasks.collapse")
              }
              onClick={onToggleCollapsed}
              size="lg"
            >
              {sourceCollapsed ? <ChevronDownGlyph /> : <ChevronUpGlyph />}
            </IconButton>
          ) : null}
          {sourceId && !snapshot.sourceQueuesPaused ? (
            <IconButton
              active={sourcePaused}
              label={
                sourcePaused ? t("tasks.resumeSource") : t("tasks.pauseSource")
              }
              onClick={() => {
                if (sourcePaused) {
                  taskScheduler.resumeSourceQueue(sourceId);
                } else {
                  taskScheduler.pauseSourceQueue(sourceId);
                }
              }}
              size="lg"
            >
              {sourcePaused ? <PlayGlyph /> : <PauseGlyph />}
            </IconButton>
          ) : null}
          {sourceId && hasCancellableTasks ? (
            <IconButton
              label={t("tasks.cancelSourceCurrent")}
              onClick={async () => {
                const confirmed = await confirm({
                  title: t("tasks.cancelGroupConfirm.title", { name: title }),
                  message: t("tasks.cancelSourceConfirm.message", {
                    count: cancellableActiveTaskCount(tasks),
                  }),
                  confirmLabel: t("tasks.cancelSourceCurrent"),
                  cancelLabel: t("common.keep"),
                  danger: true,
                });
                if (!confirmed) return;
                cancelChapterDownloadBatches(
                  activeChapterDownloadBatchIds(tasks),
                );
                taskScheduler.cancelActiveTasks({
                  discardQueued: true,
                  sourceId,
                });
              }}
              size="lg"
              tone="danger"
            >
              <CloseGlyph />
            </IconButton>
          ) : null}
        </div>
      </header>
      {sourceCollapsed ? null : sourceId ? (
        <div className="norea-task-rows">
          {sourceItems.map((item) =>
            item.type === "work" ? (
              <TaskWorkGroup
                group={item.group}
                key={`work:${item.group.workKey}`}
                onToggleOpen={() =>
                  onToggleWorkGroup?.(
                    sourceWorkOpenKey(sourceId, item.group.workKey),
                  )
                }
                open={
                  openWorkGroupKey ===
                  sourceWorkOpenKey(sourceId, item.group.workKey)
                }
                onSelectTask={onSelectTask}
                selectedTaskId={selectedTaskId}
                sourceActiveTaskCounts={sourceActiveTaskCounts}
                snapshot={snapshot}
                sourceId={sourceId}
              />
            ) : (
              <TaskRow
                blockingSourceTask={hasBlockingSourceTask(
                  item.task,
                  sourceActiveTaskCounts,
                )}
                key={item.task.id}
                onSelect={() => onSelectTask(item.task.id)}
                selected={selectedTaskId === item.task.id}
                sourcePaused={isSourceQueuePaused(item.task, snapshot)}
                sourceQueuesPaused={snapshot.sourceQueuesPaused}
                task={item.task}
              />
            ),
          )}
        </div>
      ) : (
        <TaskRows
          className="norea-task-rows"
          renderTask={(task) => (
            <TaskRow
              blockingSourceTask={hasBlockingSourceTask(
                task,
                sourceActiveTaskCounts,
              )}
              key={task.id}
              onSelect={() => onSelectTask(task.id)}
              selected={selectedTaskId === task.id}
              sourcePaused={isSourceQueuePaused(task, snapshot)}
              sourceQueuesPaused={snapshot.sourceQueuesPaused}
              task={task}
            />
          )}
          tasks={tasks}
        />
      )}
    </section>
  );
}

interface DownloadsQueueViewProps {
  active?: boolean;
  viewSwitcher?: ReactNode;
}

export function DownloadsQueueView({
  active = true,
  viewSwitcher,
}: DownloadsQueueViewProps = {}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const snapshot = useTaskSnapshot(active);
  const vpn = useVpnDownloadRuntimeSnapshot(active);
  const requests = useChapterDownloadRequestSnapshot(active);
  const [queueActionPending, setQueueActionPending] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const queueAction = useRef(false);
  const [collapsedSourceIds, setCollapsedSourceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [openWorkGroupKey, setOpenWorkGroupKey] = useState<string | null>(
    null,
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [vpnLaunchOpened, setVpnLaunchOpened] = useState(false);
  const vpnWorks = useMemo(() => vpnDownloadWorks(vpn), [vpn]);
  const tasks = useMemo(
    () => {
      const owned = new Set(vpn.ownedChapterIds ?? []);
      return snapshot.records.filter(task => !task.vpnWorker &&
        !(task.kind === "chapter.download" && task.subject?.chapterId !== undefined && owned.has(task.subject.chapterId)))
        .sort(compareTaskQueueOrder);
    },
    [snapshot.records, vpn.ownedChapterIds],
  );
  useEffect(() => {
    if (selectedTaskId && !tasks.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(null);
    }
  }, [selectedTaskId, tasks]);
  const sourceActiveTaskCounts = useMemo(
    () => activeSourceTaskCounts(tasks),
    [tasks],
  );
  const mainTasks = useMemo(
    () => tasks.filter((task) => task.lane === "main"),
    [tasks],
  );
  const sourceTasks = useMemo(
    () => tasks.filter((task) => task.lane === "source"),
    [tasks],
  );
  const hasVpnRun = Boolean(vpn.run && vpn.run.status !== "completed" && vpn.run.status !== "cancelled");
  const allPaused = hasVpnRun ? (vpn.run?.status === "paused" || vpn.run?.status === "interrupted") &&
    (!sourceTasks.length || snapshot.sourceQueuesPaused) : snapshot.sourceQueuesPaused;
  const ordinaryBlocks = snapshot.sourceAccessBlocks.filter(block => !block.rangeId);
  const taskStats = useMemo(() => {
    const count = (status: TaskRecord["status"]) =>
      tasks.filter((task) => task.status === status).length;
    const retrying = tasks.filter(isRetryWaiting).length;
    return {
      running: count("running"),
      queued: count("queued") - retrying,
      retrying,
      failed: count("failed"),
      succeeded: count("succeeded"),
    };
  }, [tasks]);
  const hasCancellableTasks = useMemo(
    () => hasCancellableActiveTask(tasks) || hasVpnRun || requests.length > 0,
    [tasks, hasVpnRun, requests.length],
  );
  const sourceGroups = useMemo(() => {
    const sourceGroupsById = new Map<string, SourceTaskGroup>();
    for (const task of sourceTasks) {
      const sourceId = task.source?.id;
      if (!sourceId) continue;
      const group = sourceGroupsById.get(sourceId);
      if (group) {
        group.tasks.push(task);
      } else {
        sourceGroupsById.set(sourceId, {
          sourceId,
          sourceName: task.source?.name ?? sourceId,
          tasks: [task],
        });
      }
    }

    const sourceQueueOrderSet = new Set(snapshot.sourceQueueOrder);
    const sourceOrder = [
      ...snapshot.sourceQueueOrder.filter((sourceId) =>
        sourceGroupsById.has(sourceId),
      ),
      ...[...sourceGroupsById.keys()]
        .filter((sourceId) => !sourceQueueOrderSet.has(sourceId))
        .sort((left, right) => {
          const leftGroup = sourceGroupsById.get(left);
          const rightGroup = sourceGroupsById.get(right);
          const sourceName = (leftGroup?.sourceName ?? left).localeCompare(
            rightGroup?.sourceName ?? right,
            undefined,
            { sensitivity: "base" },
          );
          if (sourceName !== 0) return sourceName;
          return left.localeCompare(right);
        }),
    ];

    return sourceOrder
      .map((sourceId) => sourceGroupsById.get(sourceId))
      .filter((group): group is SourceTaskGroup => Boolean(group));
  }, [snapshot.sourceQueueOrder, sourceTasks]);
  const visibleWorkGroupKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const sourceGroup of sourceGroups) {
      for (const item of groupSourceTasksByWork(sourceGroup.tasks)) {
        if (item.type === "work") {
          keys.add(sourceWorkOpenKey(sourceGroup.sourceId, item.group.workKey));
        }
      }
    }
    return keys;
  }, [sourceGroups]);
  useEffect(() => {
    if (openWorkGroupKey && !visibleWorkGroupKeys.has(openWorkGroupKey)) {
      setOpenWorkGroupKey(null);
    }
  }, [openWorkGroupKey, visibleWorkGroupKeys]);
  const toggleSourceCollapsed = (sourceId: string) => {
    setCollapsedSourceIds((current) => {
      const next = new Set(current);
      if (next.has(sourceId)) {
        next.delete(sourceId);
      } else {
        next.add(sourceId);
      }
      return next;
    });
  };
  const toggleWorkGroup = (key: string) => {
    setOpenWorkGroupKey((current) => (current === key ? null : key));
  };

  async function runQueueAction(action: () => void | Promise<void>): Promise<void> {
    if (queueAction.current) return;
    queueAction.current = true; setQueueActionPending(true); setQueueError(null);
    try { await action(); }
    catch (error) { setQueueError(describeError(error)); }
    finally { queueAction.current = false; setQueueActionPending(false); }
  }

  return (
    <PageFrame className="norea-tasks-page" size="wide">
      <PageHeader
        title={
          <span className="norea-task-page-title">
            {t("downloads.title")}
            <span className="norea-task-title-count">{tasks.length}</span>
          </span>
        }
        actions={
          <div className="norea-task-header-actions">
            <TaskSortMenu />
            <IconButton
              active={allPaused}
              disabled={queueActionPending || (!sourceTasks.length && !hasVpnRun && !requests.length)}
              label={
                allPaused
                  ? t("tasks.resumeAll")
                  : t("tasks.pauseAll")
              }
              onClick={() => runQueueAction(async () => {
                if (allPaused) {
                  taskScheduler.resumeSourceQueue();
                  if (hasVpnRun) await resumeVpnDownloadRun();
                } else {
                  taskScheduler.pauseSourceQueue();
                  if (hasVpnRun) await pauseVpnDownloadRun();
                }
              })}
              size="lg"
            >
              {allPaused ? <PlayGlyph /> : <PauseGlyph />}
            </IconButton>
            <IconButton
              disabled={!hasCancellableTasks || queueActionPending}
              label={t("tasks.cancelAllCurrent")}
              onClick={async () => {
                const count = cancellableActiveTaskCount(tasks) + requests.length;
                const message = [
                  count > 0 ? t("tasks.cancelAllConfirm.message", { count }) : null,
                  hasVpnRun ? t("tasks.cancelAllConfirm.vpnRun") : null,
                ].filter(Boolean).join(" ");
                const confirmed = await confirm({
                  title: t("tasks.cancelAllConfirm.title"),
                  message,
                  confirmLabel: t("tasks.cancelAllCurrent"),
                  cancelLabel: t("common.keep"),
                  danger: true,
                });
                if (!confirmed) return;
                await runQueueAction(async () => {
                  const cancellingVpn = hasVpnRun ? cancelVpnDownloadRun() : Promise.resolve();
                  for (const request of requests) cancelChapterDownloadRequest(request.id);
                  cancelChapterDownloadBatches(
                    activeChapterDownloadBatchIds(tasks),
                  );
                  taskScheduler.cancelActiveTasks({ discardQueued: true });
                  await cancellingVpn;
                });
              }}
              size="lg"
              tone="danger"
            >
              <CloseGlyph />
            </IconButton>
            <IconButton
              disabled={taskStats.failed === 0}
              label={t("tasks.clearErrors")}
              onClick={() => taskScheduler.clearFailedTasks()}
              size="lg"
              tone="danger"
            >
              <TrashGlyph />
            </IconButton>
            {vpn.capabilities.supported && !hasVpnRun ? (
              <OverflowMenu
                items={[{ icon: VpnIcon, label: t("vpnDownload.launchMenu"), onClick: () => setVpnLaunchOpened(true) }]}
                label={t("common.more")}
              />
            ) : null}
          </div>
        }
        meta={
          <div className="norea-task-summary-strip">
            <SummaryPill>
              {t("tasks.summary.running", { count: taskStats.running })}
            </SummaryPill>
            <SummaryPill>
              {t("tasks.summary.queued", { count: taskStats.queued })}
            </SummaryPill>
            {taskStats.retrying > 0 ? (
              <SummaryPill>
                {t("tasks.summary.retrying", { count: taskStats.retrying })}
              </SummaryPill>
            ) : null}
            <SummaryPill
              tone={
                snapshot.sourceAccessBlocks.length > 0 ? "warning" : undefined
              }
            >
              {t("tasks.summary.blocked", {
                count: snapshot.sourceAccessBlocks.length,
              })}
            </SummaryPill>
            <SummaryPill tone={taskStats.failed > 0 ? "error" : undefined}>
              {t("tasks.summary.failed", { count: taskStats.failed })}
            </SummaryPill>
            <SummaryPill>
              {t("tasks.summary.done", { count: taskStats.succeeded })}
            </SummaryPill>
          </div>
        }
      />
      {viewSwitcher}

      {queueError ? <Alert color="danger" role="alert">{queueError}</Alert> : null}

      {active ? <VpnDownloadAttention snapshot={vpn} /> : null}
      {active ? <ChapterDownloadFailureAttention /> : null}
      {active ? <DownloadGoalAttention /> : null}
      {vpnLaunchOpened ? <VpnDownloadLaunchDialog snapshot={vpn} onClose={() => setVpnLaunchOpened(false)} /> : null}

      {requests.length ? <section className="norea-download-requests" aria-label={t("tasks.downloadRequests")}>
        {requests.map(request => <div className="norea-vpn-download-work" key={request.id} data-download-request={request.id}>
          <Group justify="space-between" gap="sm" align="flex-start">
            <div className="norea-vpn-download-heading">
              <Text component="h3" size="sm" fw={600}>{request.title}</Text>
              <Text size="sm" role="status">{t(request.phase === "failed" ? "vpnDownload.phase.failed" :
                request.phase === "publishing" ? "tasks.downloadPublishing" : "vpnDownload.phase.preparing")}</Text>
            </div>
            <TextButton tone="danger" aria-label={t("tasks.cancelDownloadRequest", { title: request.title })}
              onClick={() => cancelChapterDownloadRequest(request.id)}>{t("vpnDownload.cancelDraft")}</TextButton>
          </Group>
          {request.error ? <Alert color="danger" role="alert">{request.error}</Alert> : null}
        </div>)}
      </section> : null}

      {ordinaryBlocks.length > 0 ? (
        <div className="norea-source-access-banners">
          {ordinaryBlocks.map((block) => (
            <SourceAccessBanner
              block={block}
              key={block.scopeKey}
              snapshot={snapshot}
            />
          ))}
        </div>
      ) : null}

      {tasks.length === 0 && !requests.length && !vpnWorks.length ? (
        <StateView
          color="info"
          title={t("tasks.empty.title")}
          message={t("tasks.empty.message")}
        />
      ) : (
        <div className="norea-task-shell">
          {mainTasks.length > 0 ? (
            <TaskGroup
              onSelectTask={setSelectedTaskId}
              selectedTaskId={selectedTaskId}
              snapshot={snapshot}
              sourceActiveTaskCounts={sourceActiveTaskCounts}
              tasks={mainTasks}
              title={t("tasks.mainQueue")}
            />
          ) : null}
          {vpnWorks.map((work) => (
            <VpnDownloadWorkRow key={work.key} snapshot={vpn} work={work} />
          ))}
          {sourceGroups.map((group) => (
            <TaskGroup
              collapsed={collapsedSourceIds.has(group.sourceId)}
              key={group.sourceId}
              onSelectTask={setSelectedTaskId}
              onToggleCollapsed={() => toggleSourceCollapsed(group.sourceId)}
              onToggleWorkGroup={toggleWorkGroup}
              openWorkGroupKey={openWorkGroupKey}
              selectedTaskId={selectedTaskId}
              snapshot={snapshot}
              sourceActiveTaskCounts={sourceActiveTaskCounts}
              sourceId={group.sourceId}
              sourcePaused={snapshot.pausedSourceIds.includes(group.sourceId)}
              tasks={group.tasks}
              title={group.sourceName}
            />
          ))}
        </div>
      )}
    </PageFrame>
  );
}
