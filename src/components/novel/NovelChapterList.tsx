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
import { Button, Loader, Skeleton, VisuallyHidden } from "@mantine/core";
import {
  type CSSProperties,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { type ChapterListRow } from "../../db/queries/chapter";
import { useTranslation, type TranslationKey } from "../../i18n";
import { useLongPress } from "../../lib/use-long-press";
import { type ChapterDownloadStatus } from "../../lib/tasks/chapter-download";
import { type ChapterDownloadPhase } from "../../lib/tasks/task-types";
import {
  normalizeFontScalePercent,
  useAppearanceStore,
} from "../../store/appearance";
import { IconButton } from "../IconButton";
import {
  BookmarkedIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  DeleteDownloadIcon,
  DownloadedIcon,
  DownloadIcon,
  DragIcon,
  RepairIcon,
  RetryIcon,
} from "../ui/icons";
import { ListRow } from "../ui/ListRow";
import { OverflowMenu } from "../ui/OverflowMenu";
import {
  beforeChapterIdForMove,
  chapterDndId,
  EMPTY_CHAPTER_DND_IDS,
  FINISHED_PROGRESS,
  formatChapterNumber,
  getChapterReadingProgress,
  normalizeDateText,
  parseChapterDndId,
} from "./novel-detail-model";

/** Row height in px at 100% UI scale; `.norea-novel-chapter` sets the same height in rem. */
export const CHAPTER_ROW_HEIGHT = 52;

const CHAPTER_LIST_OVERSCAN = 8;

const CHAPTER_LIST_FALLBACK_ROWS = 14;

const JUMP_HIGHLIGHT_MS = 2000;

const CHAPTER_DOWNLOAD_LABELS: Record<
  "queued" | "running",
  Record<ChapterDownloadPhase, TranslationKey>
> = {
  queued: {
    local: "novel.downloadQueued.local",
    "server-lookup": "novel.downloadQueued.serverLookup",
    "server-download": "novel.downloadQueued.serverDownload",
    "source-download": "novel.downloadQueued.sourceDownload",
  },
  running: {
    local: "novel.downloadPhase.local",
    "server-lookup": "novel.downloadPhase.serverLookup",
    "server-download": "novel.downloadPhase.serverDownload",
    "source-download": "novel.downloadPhase.sourceDownload",
  },
};

type ServerAwareChapterListRow = ChapterListRow & { serverComplete?: boolean };

interface ChapterListItemProps {
  chapter: ServerAwareChapterListRow;
  canDeleteDownload: boolean;
  canMoveDown: boolean;
  canMoveUp: boolean;
  duplicateSourceChapterCount: number;
  highlighted: boolean;
  isCurrent: boolean;
  isSelected: boolean;
  reorderMode: boolean;
  selectionMode: boolean;
  status: ChapterDownloadStatus | undefined;
  deleteBusy: boolean;
  repairBusy: boolean;
  reorderBusy: boolean;
  onOpen: () => void;
  onDownload: () => void;
  onDeleteDownload: () => void;
  onExtendSelection: () => void;
  onMoveDown: () => void;
  onMoveUp: () => void;
  onRepairMedia: () => void;
  onToggleSelected: () => void;
}

function ChapterListItem({
  chapter,
  canDeleteDownload,
  canMoveDown,
  canMoveUp,
  duplicateSourceChapterCount,
  highlighted,
  isCurrent,
  isSelected,
  reorderMode,
  selectionMode,
  status,
  deleteBusy,
  repairBusy,
  reorderBusy,
  onOpen,
  onDownload,
  onDeleteDownload,
  onExtendSelection,
  onMoveDown,
  onMoveUp,
  onRepairMedia,
  onToggleSelected,
}: ChapterListItemProps) {
  const { t } = useTranslation();
  const metaId = useId();
  const canDrag = reorderMode && (canMoveUp || canMoveDown) && !reorderBusy;
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
  const progress = getChapterReadingProgress(chapter);
  const partlyRead = progress > 0 && progress < FINISHED_PROGRESS;
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(partlyRead
      ? { "--norea-chapter-progress": `${progress}%` }
      : undefined),
  } as CSSProperties;
  const downloadActive = status?.kind === "queued" || status?.kind === "running";
  const failedMessage = status?.kind === "failed" ? status.error : null;
  const longPress = useLongPress(reorderMode ? undefined : onExtendSelection, 450);
  const releaseTime = chapter.releaseTime
    ? normalizeDateText(chapter.releaseTime)
    : null;
  const details = [
    downloadActive && status.phase
      ? t(CHAPTER_DOWNLOAD_LABELS[status.kind][status.phase])
      : null,
    failedMessage,
    chapter.serverComplete === true ? t("novel.serverComplete") : null,
    duplicateSourceChapterCount > 0
      ? t("novel.sourceDuplicateChapters", { count: duplicateSourceChapterCount })
      : null,
  ].filter(Boolean).join("\n");
  const renderStatus = () => {
    if (downloadActive) {
      return (
        <span className="norea-novel-chapter-status">
          {t(status.kind === "running" ? "common.downloading" : status.retryAt ? "novel.downloadRetrying" : "common.queued")}
        </span>
      );
    }
    if (failedMessage) {
      return (
        <span className="norea-novel-chapter-status" data-tone="danger">
          {t("novel.downloadFailed")}
          <VisuallyHidden>{`: ${failedMessage}`}</VisuallyHidden>
        </span>
      );
    }
    if (chapter.mediaRepairNeeded) {
      return (
        <span className="norea-novel-chapter-status" data-tone="warn">
          {t("novel.mediaRepairNeeded")}
        </span>
      );
    }
    return null;
  };

  const renderTrailing = () => {
    if (reorderMode) return null;
    if (downloadActive) {
      return (
        <span className="norea-novel-chapter-progress-slot">
          <Loader aria-hidden="true" size="xs" />
        </span>
      );
    }
    if (chapter.mediaRepairNeeded && canDeleteDownload) {
      return (
        <Button
          disabled={deleteBusy}
          leftSection={<RepairIcon size="1rem" />}
          loading={repairBusy}
          onClick={onRepairMedia}
          size="compact-sm"
          variant="subtle"
        >
          {t("novel.repair")}
        </Button>
      );
    }
    if (failedMessage) {
      return (
        <Button
          aria-label={t("novel.retryDownload")}
          leftSection={<RetryIcon size="1rem" />}
          onClick={onDownload}
          size="compact-sm"
          variant="subtle"
        >
          {t("common.retry")}
        </Button>
      );
    }
    if (chapter.isDownloaded) {
      if (!canDeleteDownload) return null;
      return (
        <OverflowMenu
          items={[{
            danger: true,
            disabled: deleteBusy,
            icon: DeleteDownloadIcon,
            label: t("novel.deleteDownload"),
            onClick: onDeleteDownload,
          }]}
          label={t("novel.downloaded")}
          trigger={
            <IconButton
              className="norea-novel-chapter-state-button"
              data-state="downloaded"
              disabled={deleteBusy}
              label={t("novel.downloaded")}
              size="lg"
            >
              {deleteBusy ? <Loader size="xs" /> : <DownloadedIcon size="1.25rem" />}
            </IconButton>
          }
        />
      );
    }
    return (
      <IconButton
        className="norea-novel-chapter-state-button"
        label={t("novel.downloadChapter")}
        onClick={onDownload}
        size="lg"
      >
        <DownloadIcon size="1.25rem" />
      </IconButton>
    );
  };

  const trailing = renderTrailing();

  return (
    <div
      ref={setNodeRef}
      className="norea-novel-chapter"
      data-current={isCurrent ? "true" : undefined}
      data-dragging={isDragging ? "true" : undefined}
      data-highlighted={highlighted ? "true" : undefined}
      data-progress={partlyRead ? "partial" : undefined}
      data-selected={isSelected ? "true" : undefined}
      style={style}
    >
      {reorderMode ? (
        <div className="norea-novel-chapter-reorder">
          <IconButton
            {...(canDrag ? attributes : undefined)}
            {...(canDrag ? listeners : undefined)}
            className="norea-novel-chapter-drag-handle"
            disabled={!canDrag}
            label={t("novel.local.dragChapter")}
            size="lg"
          >
            <DragIcon size="1.25rem" />
          </IconButton>
          <IconButton
            disabled={!canMoveUp || reorderBusy}
            label={t("novel.local.moveChapterUp")}
            onClick={onMoveUp}
            size="lg"
          >
            <ChevronUpIcon size="1.25rem" />
          </IconButton>
          <IconButton
            disabled={!canMoveDown || reorderBusy}
            label={t("novel.local.moveChapterDown")}
            onClick={onMoveDown}
            size="lg"
          >
            <ChevronDownIcon size="1.25rem" />
          </IconButton>
        </div>
      ) : null}
      <ListRow
        aria-busy={downloadActive || undefined}
        aria-current={isCurrent ? "true" : undefined}
        aria-describedby={metaId}
        aria-label={
          selectionMode
            ? t("novel.toggleChapterSelection", { name: chapter.name })
            : t("novel.openChapter", { name: chapter.name })
        }
        aria-pressed={selectionMode ? isSelected : undefined}
        className="norea-novel-chapter-open"
        leading={
          selectionMode ? (
            <span
              aria-hidden="true"
              className="norea-novel-chapter-check"
              data-checked={isSelected ? "true" : undefined}
            >
              {isSelected ? <CheckIcon size="1rem" /> : null}
            </span>
          ) : undefined
        }
        data-pressing={longPress.pressing ? "true" : undefined}
        onClick={(event) => {
          if (longPress.consumeFired()) return;
          if (reorderMode) return;
          if (event.shiftKey) {
            onExtendSelection();
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
          if (!reorderMode && !longPress.fired()) onToggleSelected();
        }}
        {...longPress.handlers}
        selected={isSelected}
        subtitle={
          <span
            className="norea-novel-chapter-meta"
            id={metaId}
            title={details || undefined}
          >
            <span>{t("novel.chapterShort", { number: formatChapterNumber(chapter) })}</span>
            {releaseTime ? <span>{releaseTime}</span> : null}
            {partlyRead ? (
              <VisuallyHidden>{t("novel.percentRead", { progress })}</VisuallyHidden>
            ) : null}
            {chapter.serverComplete === false ? (
              <span className="norea-novel-chapter-badge">{t("novel.serverIncomplete")}</span>
            ) : null}
            {renderStatus()}
          </span>
        }
        title={
          <>
            <span className="norea-novel-chapter-title" data-read={chapter.unread ? undefined : "true"}>
              {chapter.name}
            </span>
            {chapter.bookmark ? (
              <>
                <BookmarkedIcon className="norea-novel-chapter-bookmark" size="1rem" />
                <VisuallyHidden>{t("novel.bookmarked")}</VisuallyHidden>
              </>
            ) : null}
            {isCurrent ? <VisuallyHidden>{t("novel.currentChapter")}</VisuallyHidden> : null}
          </>
        }
      />
      {trailing ? <div className="norea-novel-chapter-trailing">{trailing}</div> : null}
    </div>
  );
}

interface VirtualChapterListProps {
  chapters: ServerAwareChapterListRow[];
  canDeleteDownloads: boolean;
  deleteBusyChapterId: number | undefined;
  duplicateSourceChapterCounts: ReadonlyMap<number, number>;
  deletePending: boolean;
  /** Scrolls the row into view and highlights it briefly; each new object is a new jump. */
  jumpRequest: { chapterId: number } | null;
  lastReadChapterId: number | undefined;
  repairBusyChapterId: number | undefined;
  repairPending: boolean;
  /** Shows drag handles and move buttons in place of the row actions. */
  reorderMode: boolean;
  reorderPending: boolean;
  /** The page's scroll container; the list renders only the rows inside its viewport. */
  scrollElement: HTMLElement | null;
  selectedChapterIds: ReadonlySet<number>;
  selectionMode: boolean;
  statuses: ReadonlyMap<number, ChapterDownloadStatus>;
  onDeleteDownload: (chapterId: number) => void;
  onDownload: (chapter: ChapterListRow) => void;
  /** Long-press or Shift-click: selects the rows from the selection anchor to this one. */
  onExtendSelection: (chapterId: number) => void;
  onOpen: (chapter: ChapterListRow) => void;
  onRepairMedia: (chapter: ChapterListRow) => void;
  onReorderChapter: (chapterId: number, beforeChapterId: number | null) => void;
  onToggleSelected: (chapterId: number) => void;
}

export function VirtualChapterList({
  chapters,
  canDeleteDownloads,
  deleteBusyChapterId,
  duplicateSourceChapterCounts,
  deletePending,
  jumpRequest,
  lastReadChapterId,
  repairBusyChapterId,
  repairPending,
  reorderMode,
  reorderPending,
  scrollElement,
  selectedChapterIds,
  selectionMode,
  statuses,
  onDeleteDownload,
  onDownload,
  onExtendSelection,
  onOpen,
  onRepairMedia,
  onReorderChapter,
  onToggleSelected,
}: VirtualChapterListProps) {
  const listRef = useRef<HTMLDivElement>(null);
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
      reorderMode
        ? chapters.map((chapter) => chapterDndId(chapter.id))
        : EMPTY_CHAPTER_DND_IDS,
    [reorderMode, chapters],
  );
  useEffect(() => {
    const list = listRef.current;
    if (!list || !scrollElement) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      // How far the list's top has scrolled above the page viewport's top.
      const offset =
        scrollElement.getBoundingClientRect().top - list.getBoundingClientRect().top;
      setScrollTop(Math.max(0, offset));
      setViewportHeight(scrollElement.clientHeight || chapterRowHeight);
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };

    measure();
    scrollElement.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resizeObserver?.observe(scrollElement);
    // Content above the list, such as an expanded summary, moves it without a scroll.
    for (const child of Array.from(scrollElement.children)) resizeObserver?.observe(child);

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      scrollElement.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      resizeObserver?.disconnect();
    };
  }, [chapterRowHeight, scrollElement]);

  const [highlightedChapterId, setHighlightedChapterId] = useState<number | null>(null);
  const chaptersRef = useRef(chapters);
  chaptersRef.current = chapters;
  useEffect(() => {
    const list = listRef.current;
    if (!jumpRequest || !list || !scrollElement) return;
    const index = chaptersRef.current.findIndex((chapter) => chapter.id === jumpRequest.chapterId);
    if (index < 0) return;
    const listTop =
      list.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop;
    // Centered, so the sticky app bar and list header never cover the row.
    scrollElement.scrollTop = Math.max(
      0,
      listTop + index * chapterRowHeight - (scrollElement.clientHeight - chapterRowHeight) / 2,
    );
    setHighlightedChapterId(jumpRequest.chapterId);
    const timer = window.setTimeout(() => setHighlightedChapterId(null), JUMP_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [chapterRowHeight, jumpRequest, scrollElement]);

  const handleDragEnd = (event: DragEndEvent) => {
    if (!reorderMode || reorderPending) return;
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
    <div className="norea-novel-chapter-list" ref={listRef}>
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
                  reorderMode && displayIndex < chapters.length - 1
                }
                canMoveUp={reorderMode && displayIndex > 0}
                duplicateSourceChapterCount={
                  duplicateSourceChapterCounts.get(chapter.id) ?? 0
                }
                highlighted={chapter.id === highlightedChapterId}
                isCurrent={chapter.id === lastReadChapterId}
                isSelected={selectedChapterIds.has(chapter.id)}
                reorderMode={reorderMode}
                selectionMode={selectionMode}
                status={statuses.get(chapter.id)}
                deleteBusy={deletePending && deleteBusyChapterId === chapter.id}
                repairBusy={repairPending && repairBusyChapterId === chapter.id}
                reorderBusy={reorderPending}
                onOpen={() => onOpen(chapter)}
                onDownload={() => onDownload(chapter)}
                onDeleteDownload={() => onDeleteDownload(chapter.id)}
                onExtendSelection={() => onExtendSelection(chapter.id)}
                onMoveDown={() =>
                  onReorderChapter(chapter.id, chapters[displayIndex + 2]?.id ?? null)
                }
                onMoveUp={() => {
                  const previous = chapters[displayIndex - 1];
                  if (previous) onReorderChapter(chapter.id, previous.id);
                }}
                onRepairMedia={() => onRepairMedia(chapter)}
                onToggleSelected={() => onToggleSelected(chapter.id)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );

  if (!reorderMode) return chapterList;

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

const SKELETON_ROWS = 8;

/** Placeholder chapter rows at the real row height while chapters load. */
export function ChapterRowsSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div className="norea-novel-chapter norea-novel-chapter-skeleton" key={index}>
          <Skeleton height="0.875rem" radius="sm" width="55%" />
          <Skeleton height="0.75rem" radius="sm" width="30%" />
        </div>
      ))}
    </div>
  );
}
