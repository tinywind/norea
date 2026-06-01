import { Progress, Text } from "@mantine/core";
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
import { useTranslation, type TranslationKey } from "../i18n";
import { useTaskSnapshot } from "../lib/tasks/hooks";
import {
  taskWorkQueueKey,
  taskScheduler,
  type SourceQueueSortMode,
  type TaskPriority,
  type TaskQueueSortMode,
  type TaskRecord,
  type TaskSnapshot,
  type TaskStatus,
} from "../lib/tasks/scheduler";
import "../styles/tasks.css";

const TASK_ROW_HEIGHT = 64;
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
      group.tasks.push(task);
    } else {
      const nextGroup = {
        tasks: [task],
        title: sourceWorkTaskTitle(task),
        workKey,
      };
      groupsByKey.set(workKey, nextGroup);
      items.push({ type: "work", group: nextGroup });
    }
  }

  return items;
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
    <div className="lnr-task-sort-menu">
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
        <div className="lnr-task-sort-popover" role="menu">
          <div className="lnr-task-sort-section">
            <span className="lnr-task-sort-heading">
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
          <div className="lnr-task-sort-section">
            <span className="lnr-task-sort-heading">
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
      className="lnr-task-row"
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
      <div className="lnr-task-row-main">
        <div className="lnr-task-row-heading">
          {chapterHeading ? (
            <div
              className="lnr-task-row-title lnr-task-row-download-title"
              title={chapterHeading.title}
            >
              <span className="lnr-task-row-download-novel">
                {chapterHeading.novelName}
              </span>
              <span className="lnr-task-row-download-chapter">
                {chapterHeading.chapterLabel}
              </span>
            </div>
          ) : (
            <Text className="lnr-task-row-title" lineClamp={1}>
              {currentTask.title}
            </Text>
          )}
          {label ? <span className="lnr-task-progress-text">{label}</span> : null}
        </div>
        <Text className="lnr-task-row-meta" lineClamp={1}>
          {taskMeta(t, currentTask)}
        </Text>
        {sourcePaused ? (
          <Text className="lnr-task-row-detail" lineClamp={1}>
            {sourceQueuesPaused
              ? t("tasks.allSourcesPaused")
              : t("tasks.sourcePaused")}
          </Text>
        ) : blockingSourceTask ? (
          <Text className="lnr-task-row-detail" lineClamp={1}>
            {t("tasks.downloadWaiting")}
          </Text>
        ) : currentTask.detail ? (
          <Text className="lnr-task-row-detail" lineClamp={1}>
            {currentTask.detail}
          </Text>
        ) : null}
        {currentTask.error ? (
          <Text className="lnr-task-row-error" lineClamp={1}>
            {currentTask.error}
          </Text>
        ) : null}
        {currentTask.progress ? (
          <Progress
            className="lnr-task-row-progress"
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
      <div className="lnr-task-row-actions">
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
  const canMove = hasQueuedTask(group.tasks);
  const canCancel = hasCancellableActiveTask(group.tasks);

  return (
    <div
      className="lnr-task-work-group"
      data-collapsed={open ? undefined : "true"}
    >
      <div className="lnr-task-work-header">
        <div className="lnr-task-work-copy">
          <Text className="lnr-task-work-title" lineClamp={1}>
            {group.title}
          </Text>
          <span className="lnr-task-group-count">
            {t("tasks.count", { count: group.tasks.length })}
          </span>
        </div>
        <div className="lnr-task-group-actions">
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
              onClick={() =>
                taskScheduler.cancelActiveTasks({
                  sourceId,
                  workKey: group.workKey,
                })
              }
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
          className="lnr-task-work-rows"
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
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(
    TASK_ROW_HEIGHT * TASK_VIRTUAL_FALLBACK_ROWS,
  );
  const totalHeight = tasks.length * TASK_ROW_HEIGHT;
  const startIndex = Math.max(
    0,
    Math.floor(scrollTop / TASK_ROW_HEIGHT) - TASK_ROW_OVERSCAN,
  );
  const endIndex = Math.min(
    tasks.length,
    Math.ceil((scrollTop + viewportHeight) / TASK_ROW_HEIGHT) +
      TASK_ROW_OVERSCAN,
  );
  const visibleTasks = tasks.slice(startIndex, endIndex);
  const offsetY = startIndex * TASK_ROW_HEIGHT;

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
      className={`${className} lnr-task-virtual-viewport`}
      onScroll={handleScroll}
      ref={viewportRef}
    >
      <div
        className="lnr-task-virtual-spacer"
        style={{ height: totalHeight }}
      >
        <div
          className="lnr-task-virtual-window"
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
  tone?: "error";
}) {
  return (
    <span className="lnr-task-summary-pill" data-tone={tone}>
      {children}
    </span>
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
  const hasCancellableTasks = hasCancellableActiveTask(tasks);
  const sourceCollapsed = Boolean(sourceId && collapsed);
  const sourceItems = sourceId ? groupSourceTasksByWork(tasks) : [];

  return (
    <section
      className="lnr-task-group"
      data-collapsed={sourceCollapsed ? "true" : undefined}
      data-source-group={sourceId ? "true" : undefined}
    >
      <header className="lnr-task-group-header">
        <div className="lnr-task-group-copy">
          <Text className="lnr-task-group-title" lineClamp={1}>
            {title}
          </Text>
          <span className="lnr-task-group-count">
            {t("tasks.count", { count: tasks.length })}
          </span>
        </div>
        <div className="lnr-task-group-actions">
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
              onClick={() =>
                taskScheduler.cancelActiveTasks({
                  sourceId,
                })
              }
              size="lg"
              tone="danger"
            >
              <CloseGlyph />
            </IconButton>
          ) : null}
        </div>
      </header>
      {sourceCollapsed ? null : sourceId ? (
        <div className="lnr-task-rows">
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
          className="lnr-task-rows"
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

interface TasksPageProps {
  active?: boolean;
}

export function TasksPage({ active = true }: TasksPageProps = {}) {
  const { t } = useTranslation();
  const snapshot = useTaskSnapshot(active);
  const [collapsedSourceIds, setCollapsedSourceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [openWorkGroupKey, setOpenWorkGroupKey] = useState<string | null>(
    null,
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const tasks = useMemo(
    () => [...snapshot.records].sort(compareTaskQueueOrder),
    [snapshot.records],
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
  const taskStats = useMemo(
    () => ({
      running: tasks.filter((task) => task.status === "running").length,
      queued: tasks.filter((task) => task.status === "queued").length,
      failed: tasks.filter((task) => task.status === "failed").length,
      succeeded: tasks.filter((task) => task.status === "succeeded").length,
    }),
    [tasks],
  );
  const hasCancellableTasks = useMemo(
    () => hasCancellableActiveTask(tasks),
    [tasks],
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

  return (
    <PageFrame className="lnr-tasks-page" size="wide">
      <PageHeader
        title={
          <span className="lnr-task-page-title">
            {t("tasks.title")}
            <span className="lnr-task-title-count">{tasks.length}</span>
          </span>
        }
        actions={
          <div className="lnr-task-header-actions">
            <TaskSortMenu />
            <IconButton
              active={snapshot.sourceQueuesPaused}
              disabled={sourceTasks.length === 0}
              label={
                snapshot.sourceQueuesPaused
                  ? t("tasks.resumeAll")
                  : t("tasks.pauseAll")
              }
              onClick={() => {
                if (snapshot.sourceQueuesPaused) {
                  taskScheduler.resumeSourceQueue();
                } else {
                  taskScheduler.pauseSourceQueue();
                }
              }}
              size="lg"
            >
              {snapshot.sourceQueuesPaused ? <PlayGlyph /> : <PauseGlyph />}
            </IconButton>
            <IconButton
              disabled={!hasCancellableTasks}
              label={t("tasks.cancelAllCurrent")}
              onClick={() => taskScheduler.cancelActiveTasks()}
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
          </div>
        }
        meta={
          <div className="lnr-task-summary-strip">
            <SummaryPill>
              {t("tasks.summary.running", { count: taskStats.running })}
            </SummaryPill>
            <SummaryPill>
              {t("tasks.summary.queued", { count: taskStats.queued })}
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

      {tasks.length === 0 ? (
        <StateView
          color="blue"
          title={t("tasks.empty.title")}
          message={t("tasks.empty.message")}
        />
      ) : (
        <div className="lnr-task-shell">
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
