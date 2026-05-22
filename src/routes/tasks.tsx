import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Progress, Text } from "@mantine/core";
import { useState, type CSSProperties } from "react";
import { PageFrame, PageHeader, StateView } from "../components/AppFrame";
import {
  ChevronDownGlyph,
  ChevronUpGlyph,
  CloseGlyph,
  DragHandleGlyph,
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
  taskScheduler,
  type SourceQueueSortMode,
  type TaskPriority,
  type TaskQueueSortMode,
  type TaskRecord,
  type TaskSnapshot,
  type TaskStatus,
} from "../lib/tasks/scheduler";
import "../styles/tasks.css";

const ACTIVE_STATUSES = new Set<TaskStatus>(["queued", "running"]);

type SourceTaskGroup = {
  sourceId: string;
  sourceName: string;
  tasks: TaskRecord[];
};

type SortableGroupState = {
  attributes: DraggableAttributes;
  isDragging: boolean;
  listeners?: DraggableSyntheticListeners;
  setNodeRef: (element: HTMLElement | null) => void;
  style: CSSProperties;
};

const SOURCE_DND_PREFIX = "source:";
const TASK_DND_PREFIX = "task:";

function sourceDndId(sourceId: string): string {
  return `${SOURCE_DND_PREFIX}${sourceId}`;
}

function taskDndId(taskId: string): string {
  return `${TASK_DND_PREFIX}${taskId}`;
}

function parseSourceDndId(id: unknown): string | null {
  const value = String(id);
  return value.startsWith(SOURCE_DND_PREFIX)
    ? value.slice(SOURCE_DND_PREFIX.length)
    : null;
}

function parseTaskDndId(id: unknown): string | null {
  const value = String(id);
  return value.startsWith(TASK_DND_PREFIX)
    ? value.slice(TASK_DND_PREFIX.length)
    : null;
}

function beforeIdForMove(
  orderedIds: string[],
  activeId: string,
  overId: string,
): string | null {
  const activeIndex = orderedIds.indexOf(activeId);
  const overIndex = orderedIds.indexOf(overId);
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) {
    return activeId;
  }
  return activeIndex < overIndex ? orderedIds[overIndex + 1] ?? null : overId;
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

function DragHandle({
  attributes,
  draggable,
  label,
  listeners,
}: {
  attributes?: DraggableAttributes;
  draggable: boolean;
  label: string;
  listeners?: DraggableSyntheticListeners;
}) {
  return (
    <span
      {...attributes}
      {...listeners}
      aria-disabled={!draggable}
      aria-label={label}
      className="lnr-task-drag-handle"
      data-disabled={draggable ? undefined : "true"}
      role="button"
      tabIndex={draggable ? 0 : -1}
      title={label}
    >
      <DragHandleGlyph />
    </span>
  );
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

function hasBlockingSourceTask(
  task: TaskRecord,
  records: TaskRecord[],
): boolean {
  if (task.priority !== "background" || task.status !== "queued") {
    return false;
  }
  return records.some(
    (candidate) =>
      candidate.id !== task.id &&
      candidate.lane === "source" &&
      candidate.source?.id === task.source?.id &&
      isActiveTask(candidate),
  );
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

function TaskRow({
  blockingSourceTask,
  snapshot,
  task,
}: {
  blockingSourceTask: boolean;
  snapshot: TaskSnapshot;
  task: TaskRecord;
}) {
  const { t } = useTranslation();
  const sourcePaused = isSourceQueuePaused(task, snapshot);
  const label = progressLabel(task);
  const canMove =
    task.status === "queued" &&
    task.queueIndex !== undefined &&
    task.queueSize !== undefined &&
    task.queueSize > 1;
  const retry = () => {
    const handle = taskScheduler.retry(task.id);
    if (handle) void handle.promise.catch(() => undefined);
  };
  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: taskDndId(task.id),
    disabled: !canMove,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      className="lnr-task-row"
      data-dragging={isDragging ? "true" : undefined}
      data-status={task.status}
      style={style}
    >
      <DragHandle
        attributes={canMove ? attributes : undefined}
        draggable={canMove}
        label={t("tasks.dragTask")}
        listeners={canMove ? listeners : undefined}
      />
      <ConsoleStatusDot
        status={statusTone(task.status)}
        label={t(taskStatusKey(task.status))}
      />
      <div className="lnr-task-row-main">
        <div className="lnr-task-row-heading">
          <Text className="lnr-task-row-title" lineClamp={1}>
            {task.title}
          </Text>
          {label ? <span className="lnr-task-progress-text">{label}</span> : null}
        </div>
        <Text className="lnr-task-row-meta" lineClamp={1}>
          {taskMeta(t, task)}
        </Text>
        {sourcePaused ? (
          <Text className="lnr-task-row-detail" lineClamp={1}>
            {snapshot.sourceQueuesPaused
              ? t("tasks.allSourcesPaused")
              : t("tasks.sourcePaused")}
          </Text>
        ) : blockingSourceTask ? (
          <Text className="lnr-task-row-detail" lineClamp={1}>
            {t("tasks.downloadWaiting")}
          </Text>
        ) : task.detail ? (
          <Text className="lnr-task-row-detail" lineClamp={1}>
            {task.detail}
          </Text>
        ) : null}
        {task.error ? (
          <Text className="lnr-task-row-error" lineClamp={1}>
            {task.error}
          </Text>
        ) : null}
        {task.progress ? (
          <Progress
            className="lnr-task-row-progress"
            size="xs"
            value={
              task.progress.total
                ? Math.min(
                    100,
                    (task.progress.current / task.progress.total) * 100,
                  )
                : 100
            }
            animated={!task.progress.total}
          />
        ) : null}
      </div>
      <div className="lnr-task-row-actions">
        {task.canCancel ? (
          <IconButton
            label={t("common.cancel")}
            onClick={() => taskScheduler.cancel(task.id)}
            size="lg"
            tone="danger"
          >
            <CloseGlyph />
          </IconButton>
        ) : null}
        {task.canRetry ? (
          <IconButton label={t("common.retry")} onClick={retry} size="lg">
            <RetryGlyph />
          </IconButton>
        ) : null}
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
  onToggleCollapsed,
  snapshot,
  sourceSortable,
  sourceId,
  sourcePaused,
  tasks,
  title,
}: {
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  snapshot: TaskSnapshot;
  sourceSortable?: SortableGroupState;
  sourceId?: string;
  sourcePaused?: boolean;
  tasks: TaskRecord[];
  title: string;
}) {
  const { t } = useTranslation();
  const hasCancellableTasks = hasCancellableActiveTask(tasks);
  const canDragSource = Boolean(
    sourceId && snapshot.sourceQueueOrder.length > 1,
  );
  const sourceCollapsed = Boolean(sourceId && collapsed);

  return (
    <section
      ref={sourceSortable?.setNodeRef}
      className="lnr-task-group"
      data-collapsed={sourceCollapsed ? "true" : undefined}
      data-dragging={sourceSortable?.isDragging ? "true" : undefined}
      style={sourceSortable?.style}
    >
      <header
        className="lnr-task-group-header"
        data-has-drag={sourceId ? "true" : undefined}
      >
        {sourceId ? (
          <DragHandle
            attributes={canDragSource ? sourceSortable?.attributes : undefined}
            draggable={canDragSource}
            label={t("tasks.dragSource")}
            listeners={canDragSource ? sourceSortable?.listeners : undefined}
          />
        ) : null}
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
      {sourceCollapsed ? null : (
        <SortableContext
          items={tasks.map((task) => taskDndId(task.id))}
          strategy={verticalListSortingStrategy}
        >
          <div className="lnr-task-rows">
            {tasks.map((task) => (
              <TaskRow
                blockingSourceTask={hasBlockingSourceTask(
                  task,
                  snapshot.records,
                )}
                key={task.id}
                snapshot={snapshot}
                task={task}
              />
            ))}
          </div>
        </SortableContext>
      )}
    </section>
  );
}

function SortableSourceTaskGroup({
  collapsed,
  group,
  onToggleCollapsed,
  snapshot,
}: {
  collapsed: boolean;
  group: SourceTaskGroup;
  onToggleCollapsed: () => void;
  snapshot: TaskSnapshot;
}) {
  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: sourceDndId(group.sourceId),
    disabled: snapshot.sourceQueueOrder.length <= 1,
  });
  const sourceSortable: SortableGroupState = {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    style: {
      transform: CSS.Transform.toString(transform),
      transition,
    },
  };

  return (
    <TaskGroup
      collapsed={collapsed}
      onToggleCollapsed={onToggleCollapsed}
      snapshot={snapshot}
      sourceId={group.sourceId}
      sourcePaused={snapshot.pausedSourceIds.includes(group.sourceId)}
      sourceSortable={sourceSortable}
      tasks={group.tasks}
      title={group.sourceName}
    />
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
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const tasks = [...snapshot.records].sort(compareTaskQueueOrder);
  const mainTasks = tasks.filter((task) => task.lane === "main");
  const sourceTasks = tasks.filter((task) => task.lane === "source");
  const taskStats = {
    running: tasks.filter((task) => task.status === "running").length,
    queued: tasks.filter((task) => task.status === "queued").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    succeeded: tasks.filter((task) => task.status === "succeeded").length,
  };
  const hasCancellableTasks = hasCancellableActiveTask(tasks);
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
  const sourceOrder = [
    ...snapshot.sourceQueueOrder.filter((sourceId) =>
      sourceGroupsById.has(sourceId),
    ),
    ...[...sourceGroupsById.keys()]
      .filter((sourceId) => !snapshot.sourceQueueOrder.includes(sourceId))
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
  const sourceGroups = sourceOrder
    .map((sourceId) => sourceGroupsById.get(sourceId))
    .filter((group): group is SourceTaskGroup => Boolean(group));
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
  const handleDragEnd = (event: DragEndEvent) => {
    const overId = event.over?.id;
    if (!overId) return;

    const activeSourceId = parseSourceDndId(event.active.id);
    const overSourceId = parseSourceDndId(overId);
    if (activeSourceId && overSourceId) {
      const sourceIds = sourceGroups.map((group) => group.sourceId);
      taskScheduler.moveSourceQueueBefore(
        activeSourceId,
        beforeIdForMove(sourceIds, activeSourceId, overSourceId),
      );
      return;
    }

    const activeTaskId = parseTaskDndId(event.active.id);
    const overTaskId = parseTaskDndId(overId);
    if (!activeTaskId || !overTaskId) return;

    const activeTask = snapshot.records.find((task) => task.id === activeTaskId);
    const overTask = snapshot.records.find((task) => task.id === overTaskId);
    if (
      !activeTask ||
      !overTask ||
      activeTask.status !== "queued" ||
      overTask.status !== "queued" ||
      taskQueueKey(activeTask) !== taskQueueKey(overTask)
    ) {
      return;
    }

    const queueTaskIds = tasks
      .filter(
        (task) =>
          task.status === "queued" &&
          taskQueueKey(task) === taskQueueKey(activeTask),
      )
      .map((task) => task.id);
    taskScheduler.moveQueuedTaskBefore(
      activeTaskId,
      beforeIdForMove(queueTaskIds, activeTaskId, overTaskId),
    );
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
        <DndContext
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
          sensors={sensors}
        >
          <div className="lnr-task-shell">
            {mainTasks.length > 0 ? (
              <TaskGroup
                snapshot={snapshot}
                tasks={mainTasks}
                title={t("tasks.mainQueue")}
              />
            ) : null}
            <SortableContext
              items={sourceGroups.map((group) => sourceDndId(group.sourceId))}
              strategy={verticalListSortingStrategy}
            >
              {sourceGroups.map((group) => (
                <SortableSourceTaskGroup
                  collapsed={collapsedSourceIds.has(group.sourceId)}
                  group={group}
                  key={group.sourceId}
                  onToggleCollapsed={() =>
                    toggleSourceCollapsed(group.sourceId)
                  }
                  snapshot={snapshot}
                />
              ))}
            </SortableContext>
          </div>
        </DndContext>
      )}
    </PageFrame>
  );
}
