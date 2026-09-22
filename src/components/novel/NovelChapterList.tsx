import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Text, Tooltip } from "@mantine/core";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { type ChapterListRow } from "../../db/queries/chapter";
import { useTranslation } from "../../i18n";
import { type ChapterDownloadStatus } from "../../lib/tasks/chapter-download";
import {
  normalizeFontScalePercent,
  useAppearanceStore,
} from "../../store/appearance";
import {
  ClockGlyph,
  DownloadedGlyph,
  DownloadGlyph,
  DragHandleGlyph,
  RetryGlyph,
  SpinnerGlyph,
  TrashGlyph,
} from "../ActionGlyphs";
import { ConsoleProgress } from "../ConsolePrimitives";
import { IconButton } from "../IconButton";
import {
  beforeChapterIdForMove,
  chapterDndId,
  EMPTY_CHAPTER_DND_IDS,
  FINISHED_PROGRESS,
  formatChapterPosition,
  getChapterReadingProgress,
  normalizeDateText,
  parseChapterDndId,
} from "./novel-detail-model";
const CHAPTER_ROW_HEIGHT = 54;

const CHAPTER_LIST_OVERSCAN = 8;

const CHAPTER_LIST_FALLBACK_ROWS = 14;

interface ChapterListItemProps {
  chapter: ChapterListRow;
  canDeleteDownload: boolean;
  canMoveDown: boolean;
  canMoveUp: boolean;
  duplicateSourceChapterCount: number;
  isCurrent: boolean;
  isSelected: boolean;
  selectionMode: boolean;
  status: ChapterDownloadStatus | undefined;
  deleteBusy: boolean;
  repairBusy: boolean;
  reorderBusy: boolean;
  onOpen: () => void;
  onDownload: () => void;
  onDeleteDownload: () => void;
  onRepairMedia: () => void;
  onToggleSelected: () => void;
}

function ChapterListItem({
  chapter,
  canDeleteDownload,
  canMoveDown,
  canMoveUp,
  duplicateSourceChapterCount,
  isCurrent,
  isSelected,
  selectionMode,
  status,
  deleteBusy,
  repairBusy,
  reorderBusy,
  onOpen,
  onDownload,
  onDeleteDownload,
  onRepairMedia,
  onToggleSelected,
}: ChapterListItemProps) {
  const { t } = useTranslation();
  const canDrag = (canMoveUp || canMoveDown) && !reorderBusy;
  const hasReorderControls = canMoveUp || canMoveDown;
  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: chapterDndId(chapter.id),
    disabled: !canDrag,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const isQueued = status?.kind === "queued";
  const isRunning = status?.kind === "running";
  const failedMessage = status?.kind === "failed" ? status.error : null;
  const downloadActionLabel = failedMessage
    ? t("novel.retryDownload")
    : t("novel.downloadChapter");
  const showDownloadButton = !chapter.isDownloaded && !isQueued && !isRunning;
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const progress = getChapterReadingProgress(chapter);
  const progressStatus =
    progress >= FINISHED_PROGRESS
      ? "done"
      : chapter.progress > 0
        ? "active"
        : "idle";
  const releaseTime = chapter.releaseTime
    ? normalizeDateText(chapter.releaseTime)
    : null;
  const hasSourceDuplicateChapter = duplicateSourceChapterCount > 0;
  const hasChapterFlags =
    chapter.bookmark ||
    !chapter.unread ||
    chapter.isDownloaded ||
    chapter.mediaRepairNeeded ||
    hasSourceDuplicateChapter ||
    Boolean(status);
  const renderChapterFlags = () => (
    <>
      {chapter.bookmark ? (
        <ChapterFlag label={t("novel.bookmarked")} tone="warning">
          <BookmarkIcon />
        </ChapterFlag>
      ) : null}
      {!chapter.unread ? (
        <ChapterFlag label={t("common.read")} tone="done">
          <ReadIcon />
        </ChapterFlag>
      ) : null}
      {chapter.isDownloaded ? (
        <ChapterFlag label={t("novel.downloaded")} tone="done">
          <DownloadedGlyph />
        </ChapterFlag>
      ) : null}
      {chapter.mediaRepairNeeded ? (
        <ChapterFlag label={t("novel.mediaRepairNeeded")} tone="warning">
          <RetryGlyph />
        </ChapterFlag>
      ) : null}
      {hasSourceDuplicateChapter ? (
        <ChapterFlag
          label={t("novel.sourceDuplicateChapters", {
            count: duplicateSourceChapterCount,
          })}
          tone="warning"
        >
          <AlertIcon />
        </ChapterFlag>
      ) : null}
      {status ? <ChapterDownloadStatusIcon status={status} /> : null}
    </>
  );
  const clearLongPressTimer = () => {
    if (longPressTimerRef.current === null) return;
    window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };
  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    clearLongPressTimer();
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      onToggleSelected();
    }, 450);
  };
  const handlePointerEnd = () => {
    clearLongPressTimer();
  };

  useEffect(() => clearLongPressTimer, []);

  return (
    <div
      ref={setNodeRef}
      className={`norea-novel-chapter-row${
        isCurrent ? " norea-novel-chapter-row--current" : ""
      }`}
      data-dragging={isDragging ? "true" : undefined}
      data-has-drag={hasReorderControls ? "true" : undefined}
      data-selected={isSelected ? "true" : undefined}
      data-selection-mode={selectionMode ? "true" : undefined}
      style={style}
    >
      <label
        className="norea-novel-chapter-selection"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          aria-label={t("novel.toggleChapterSelection", {
            name: chapter.name,
          })}
          checked={isSelected}
          onChange={onToggleSelected}
          type="checkbox"
        />
      </label>
      {hasReorderControls ? (
        <button
          {...(canDrag ? attributes : undefined)}
          {...(canDrag ? listeners : undefined)}
          aria-label={t("novel.local.dragChapter")}
          className="norea-novel-chapter-drag-handle"
          data-disabled={canDrag ? undefined : "true"}
          disabled={!canDrag}
          title={t("novel.local.dragChapter")}
          type="button"
        >
          <DragHandleGlyph />
        </button>
      ) : null}
      <button
        aria-busy={isRunning}
        aria-label={
          selectionMode
            ? t("novel.toggleChapterSelection", { name: chapter.name })
            : t("novel.openChapter", { name: chapter.name })
        }
        aria-pressed={selectionMode ? isSelected : undefined}
        className="norea-novel-chapter-open"
        onClick={() => {
          if (longPressTriggeredRef.current) {
            longPressTriggeredRef.current = false;
            return;
          }
          if (selectionMode) {
            onToggleSelected();
            return;
          }
          onOpen();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (!longPressTriggeredRef.current) onToggleSelected();
        }}
        onPointerCancel={handlePointerEnd}
        onPointerDown={handlePointerDown}
        onPointerLeave={handlePointerEnd}
        onPointerUp={handlePointerEnd}
        type="button"
      >
        <span className="norea-novel-chapter-position">
          <span>{formatChapterPosition(chapter.position)}</span>
          {isCurrent ? (
            <span
              aria-label={t("common.current")}
              className="norea-novel-chapter-current-dot"
              role="img"
              title={t("common.current")}
            />
          ) : null}
        </span>

        <span className="norea-novel-chapter-main">
          <span className="norea-novel-chapter-title-line">
            <Text
              component="span"
              className="norea-novel-chapter-title"
              data-read={!chapter.unread}
              title={chapter.name}
            >
              {chapter.name}
            </Text>
          </span>
          <span className="norea-novel-chapter-meta-row">
            {releaseTime ? (
              <Text component="span" className="norea-novel-chapter-meta">
                {releaseTime}
              </Text>
            ) : null}
            <span className="norea-novel-chapter-percent norea-novel-chapter-percent--inline">
              {progress}%
            </span>
            {hasChapterFlags ? (
              <span
                className="norea-novel-chapter-flags norea-novel-chapter-flags--inline"
                aria-label={t("novel.chapterStatus")}
              >
                {renderChapterFlags()}
              </span>
            ) : null}
          </span>
        </span>

        {hasChapterFlags ? (
          <span
            className="norea-novel-chapter-flags norea-novel-chapter-flags--desktop"
            aria-label={t("novel.chapterStatus")}
          >
            {renderChapterFlags()}
          </span>
        ) : null}

        <span className="norea-novel-chapter-progress">
          <ConsoleProgress value={progress} status={progressStatus} />
          <span>{progress}%</span>
        </span>
      </button>

      <div className="norea-novel-chapter-actions">
        {showDownloadButton ? (
          <IconButton
            className="norea-novel-icon-button"
            label={downloadActionLabel}
            size="lg"
            title={failedMessage ?? downloadActionLabel}
            tone={failedMessage ? "danger" : "default"}
            onClick={(event) => {
              event.stopPropagation();
              onDownload();
            }}
          >
            <DownloadGlyph />
          </IconButton>
        ) : null}
        {chapter.isDownloaded && chapter.mediaRepairNeeded ? (
          <IconButton
            className="norea-novel-icon-button"
            data-busy={repairBusy ? "true" : undefined}
            disabled={repairBusy}
            label={t("novel.repairChapterMedia")}
            size="lg"
            onClick={(event) => {
              event.stopPropagation();
              onRepairMedia();
            }}
          >
            {repairBusy ? (
              <SpinnerGlyph className="norea-novel-spin-icon" />
            ) : (
              <RetryGlyph />
            )}
          </IconButton>
        ) : null}
        {chapter.isDownloaded && canDeleteDownload ? (
          <IconButton
            className="norea-novel-icon-button"
            data-busy={deleteBusy ? "true" : undefined}
            disabled={deleteBusy}
            label={t("novel.deleteDownloadedChapter")}
            size="lg"
            onClick={(event) => {
              event.stopPropagation();
              onDeleteDownload();
            }}
          >
            <TrashGlyph />
          </IconButton>
        ) : null}
      </div>
    </div>
  );
}

interface VirtualChapterListProps {
  chapters: ChapterListRow[];
  canDeleteDownloads: boolean;
  canReorderChapters: boolean;
  deleteBusyChapterId: number | undefined;
  duplicateSourceChapterCounts: ReadonlyMap<number, number>;
  deletePending: boolean;
  lastReadChapterId: number | undefined;
  repairBusyChapterId: number | undefined;
  repairPending: boolean;
  reorderPending: boolean;
  selectedChapterIds: ReadonlySet<number>;
  selectionMode: boolean;
  statuses: ReadonlyMap<number, ChapterDownloadStatus>;
  onDeleteDownload: (chapterId: number) => void;
  onDownload: (chapter: ChapterListRow) => void;
  onOpen: (chapter: ChapterListRow) => void;
  onRepairMedia: (chapter: ChapterListRow) => void;
  onReorderChapter: (chapterId: number, beforeChapterId: number | null) => void;
  onToggleSelected: (chapterId: number) => void;
}

export function VirtualChapterList({
  chapters,
  canDeleteDownloads,
  canReorderChapters,
  deleteBusyChapterId,
  duplicateSourceChapterCounts,
  deletePending,
  lastReadChapterId,
  repairBusyChapterId,
  repairPending,
  reorderPending,
  selectedChapterIds,
  selectionMode,
  statuses,
  onDeleteDownload,
  onDownload,
  onOpen,
  onRepairMedia,
  onReorderChapter,
  onToggleSelected,
}: VirtualChapterListProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const fontScalePercent = useAppearanceStore(
    (state) => state.fontScalePercent,
  );
  const chapterRowHeight =
    CHAPTER_ROW_HEIGHT * (normalizeFontScalePercent(fontScalePercent) / 100);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(
    chapterRowHeight * CHAPTER_LIST_FALLBACK_ROWS,
  );
  const totalHeight = chapters.length * chapterRowHeight;
  const startIndex = Math.max(
    0,
    Math.floor(scrollTop / chapterRowHeight) - CHAPTER_LIST_OVERSCAN,
  );
  const endIndex = Math.min(
    chapters.length,
    Math.ceil((scrollTop + viewportHeight) / chapterRowHeight) +
      CHAPTER_LIST_OVERSCAN,
  );
  const visibleChapters = chapters.slice(startIndex, endIndex);
  const offsetY = startIndex * chapterRowHeight;
  const sortableChapterIds = useMemo(
    () =>
      canReorderChapters
        ? chapters.map((chapter) => chapterDndId(chapter.id))
        : EMPTY_CHAPTER_DND_IDS,
    [canReorderChapters, chapters],
  );
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    const updateViewportHeight = () => {
      setViewportHeight(element.clientHeight || chapterRowHeight);
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
  }, [chapterRowHeight]);

  useEffect(() => {
    const maxScrollTop = Math.max(0, totalHeight - viewportHeight);
    setScrollTop((current) => Math.min(current, maxScrollTop));
  }, [totalHeight, viewportHeight]);

  const handleDragEnd = (event: DragEndEvent) => {
    if (!canReorderChapters || reorderPending) return;
    const overId = event.over?.id;
    if (!overId) return;

    const activeChapterId = parseChapterDndId(event.active.id);
    const overChapterId = parseChapterDndId(overId);
    if (activeChapterId === null || overChapterId === null) return;

    const chapterIds = chapters.map((chapter) => chapter.id);
    const beforeChapterId = beforeChapterIdForMove(
      chapterIds,
      activeChapterId,
      overChapterId,
    );
    if (beforeChapterId === activeChapterId) return;
    onReorderChapter(activeChapterId, beforeChapterId);
  };

  const chapterList = (
    <div
      className="norea-novel-chapter-list"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      ref={viewportRef}
    >
      <div
        className="norea-novel-chapter-list-spacer"
        style={{ height: totalHeight }}
      >
        <div
          className="norea-novel-chapter-list-window"
          style={{ transform: `translateY(${offsetY}px)` }}
        >
          {visibleChapters.map((chapter, index) => {
            const displayIndex = startIndex + index;
            return (
              <ChapterListItem
                key={chapter.id}
                chapter={chapter}
                canDeleteDownload={canDeleteDownloads}
                canMoveDown={
                  canReorderChapters && displayIndex < chapters.length - 1
                }
                canMoveUp={canReorderChapters && displayIndex > 0}
                duplicateSourceChapterCount={
                  duplicateSourceChapterCounts.get(chapter.id) ?? 0
                }
                isCurrent={chapter.id === lastReadChapterId}
                isSelected={selectedChapterIds.has(chapter.id)}
                selectionMode={selectionMode}
                status={statuses.get(chapter.id)}
                deleteBusy={deletePending && deleteBusyChapterId === chapter.id}
                repairBusy={repairPending && repairBusyChapterId === chapter.id}
                reorderBusy={reorderPending}
                onOpen={() => onOpen(chapter)}
                onDownload={() => onDownload(chapter)}
                onDeleteDownload={() => onDeleteDownload(chapter.id)}
                onRepairMedia={() => onRepairMedia(chapter)}
                onToggleSelected={() => onToggleSelected(chapter.id)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );

  if (!canReorderChapters) return chapterList;

  return (
    <DndContext
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
      sensors={sensors}
    >
      <SortableContext
        items={sortableChapterIds}
        strategy={verticalListSortingStrategy}
      >
        {chapterList}
      </SortableContext>
    </DndContext>
  );
}

interface ChapterFlagProps {
  children: ReactNode;
  label: string;
  tone?: "default" | "done" | "warning" | "error";
}

function ChapterFlag({ children, label, tone = "default" }: ChapterFlagProps) {
  return (
    <Tooltip label={label} openDelay={350} withArrow>
      <span
        aria-label={label}
        className="norea-novel-chapter-flag"
        data-tone={tone}
        role="img"
        title={label}
      >
        {children}
      </span>
    </Tooltip>
  );
}

function ChapterDownloadStatusIcon({
  status,
}: {
  status: ChapterDownloadStatus;
}) {
  const { t } = useTranslation();

  if (status.kind === "done" || status.kind === "cancelled") return null;

  if (status.kind === "failed") {
    return (
      <ChapterFlag label={status.error} tone="error">
        <AlertIcon />
      </ChapterFlag>
    );
  }

  if (status.kind === "running") {
    return (
      <ChapterFlag label={t("common.downloading")}>
        <SpinnerGlyph className="norea-novel-spin-icon" />
      </ChapterFlag>
    );
  }

  return (
    <ChapterFlag label={t("common.queued")}>
      <ClockGlyph />
    </ChapterFlag>
  );
}

function BookmarkIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M7 4h10v16l-5-3-5 3z" />
    </svg>
  );
}

export function ReadIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 12l5 5L20 6" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 4l9 16H3z" />
      <path d="M12 9v5" />
      <path d="M12 18h.01" />
    </svg>
  );
}
