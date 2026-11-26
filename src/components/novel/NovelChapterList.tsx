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
import { Loader, Skeleton, VisuallyHidden } from "@mantine/core";
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
import {
  isServerChapterMissingFailure,
  isServerChapterMissingWithoutSourceFailure,
} from "../../lib/tasks/download-failure";
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
  TrashIcon,
  DownloadedIcon,
  DownloadIcon,
  DragIcon,
  QueuedIcon,
  RepairIcon,
  RetryIcon,
} from "../ui/icons";
import { ChapterDownloadProgress } from "./ChapterDownloadProgress";
import { ListRow } from "../ui/ListRow";
import { OverflowMenu } from "../ui/OverflowMenu";
import {
  beforeChapterIdForMove,
  chapterDndId,
  chapterNameShowsNumber,
  chapterRowClickAction,
  EMPTY_CHAPTER_DND_IDS,
  FINISHED_PROGRESS,
  formatChapterNumber,
  getChapterReadingProgress,
  getReadingOrderChapters,
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

export type ServerAwareChapterListRow = ChapterListRow & {
  ordinal?: number;
  serverAvailable?: boolean;
  serverComplete?: boolean;
  serverDifferent?: boolean;
};

interface ChapterListItemProps {
  chapter: ServerAwareChapterListRow;
  ordinal: number;
  canDeleteDownload: boolean;
  canMoveDown: boolean;
  canMoveUp: boolean;
  duplicateSourceChapterCount: number;
  highlighted: boolean;
  /** The chapter Continue opens next, marked so read and unread chapters meet visibly. */
  isNext: boolean;
  isRangeStart: boolean;
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
  ordinal,
  canDeleteDownload,
  canMoveDown,
  canMoveUp,
  duplicateSourceChapterCount,
  highlighted,
  isNext,
  isRangeStart,
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
  const finished = progress >= FINISHED_PROGRESS;
  const partlyRead = !finished && progress > 0;
  const readFill = finished ? "100%" : partlyRead ? `${progress}%` : null;
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(readFill ? { "--norea-chapter-progress": readFill } : undefined),
  } as CSSProperties;
  const effectiveStatus: ChapterDownloadStatus | undefined =
    status ?? (repairBusy ? { kind: "queued" } : undefined);
  const downloadActive = effectiveStatus?.kind === "queued" || effectiveStatus?.kind === "running";
  const failedMessage = effectiveStatus?.kind === "failed" ? effectiveStatus.error : null;
  const serverMissingNoSource =
    failedMessage !== null && isServerChapterMissingWithoutSourceFailure(failedMessage);
  const serverMissingFailure =
    failedMessage !== null && isServerChapterMissingFailure(failedMessage) && !serverMissingNoSource;
  const longPress = useLongPress(reorderMode ? undefined : onExtendSelection, 450);
  const releaseTime = chapter.releaseTime
    ? normalizeDateText(chapter.releaseTime)
    : null;
  const details = [
    downloadActive && effectiveStatus.phase
      ? t(CHAPTER_DOWNLOAD_LABELS[effectiveStatus.kind][effectiveStatus.phase])
      : null,
    failedMessage,
    duplicateSourceChapterCount > 0
      ? t("novel.sourceDuplicateChapters", { count: duplicateSourceChapterCount })
      : null,
  ].filter(Boolean).join("\n");
  const onServer = !chapter.isDownloaded && effectiveStatus?.kind !== "done" && chapter.serverAvailable === true;
  // The trailing icon shows the state; the row description still names it for screen readers.
  const renderStatus = () => {
    const state = downloadActive
      ? t(effectiveStatus.kind === "running" ? "common.downloading" : effectiveStatus.retryAt ? "novel.downloadRetrying" : "common.queued")
      : serverMissingFailure
        ? t("novel.serverMissing")
        : failedMessage
          ? `${t("novel.downloadFailed")}: ${failedMessage}`
          : chapter.mediaRepairNeeded && effectiveStatus?.kind !== "done"
            ? t("novel.mediaRepairNeeded")
            : onServer
              ? t("novel.serverAvailable")
              : null;
    return state ? <VisuallyHidden>{state}</VisuallyHidden> : null;
  };
  const downloadIcon = (Icon: typeof DownloadIcon) => (
    <span className="norea-novel-chapter-download-icon" data-on-server={onServer ? "true" : undefined}>
      <Icon size="1.25rem" />
    </span>
  );

  const renderTrailing = () => {
    if (reorderMode) return null;
    if (effectiveStatus?.kind === "running") {
      return <ChapterDownloadProgress chapterId={chapter.id} label={t("common.downloading")} />;
    }
    if (effectiveStatus?.kind === "queued") {
      return (
        <span
          aria-label={t(effectiveStatus.retryAt ? "novel.downloadRetrying" : "common.queued")}
          className="norea-novel-chapter-progress-slot norea-novel-chapter-queued"
          role="img"
        >
          <QueuedIcon size="1.25rem" />
        </span>
      );
    }
    // While selecting, a tap anywhere on the row toggles it, so the row offers no other buttons.
    if (selectionMode) {
      return chapter.isDownloaded || effectiveStatus?.kind === "done" ? (
        <span
          aria-label={t("novel.downloaded")}
          className="norea-novel-chapter-progress-slot norea-novel-chapter-state-button"
          data-state="downloaded"
          role="img"
        >
          <DownloadedIcon size="1.25rem" />
        </span>
      ) : null;
    }
    if (chapter.mediaRepairNeeded && canDeleteDownload && effectiveStatus?.kind !== "done") {
      return (
        <IconButton
          className="norea-novel-chapter-state-button"
          disabled={deleteBusy}
          label={t("novel.repair")}
          onClick={onRepairMedia}
          size="lg"
        >
          <RepairIcon size="1.25rem" />
        </IconButton>
      );
    }
    if (serverMissingFailure) {
      return (
        <IconButton
          className="norea-novel-chapter-state-button"
          label={t("novel.downloadFromSource")}
          onClick={onDownload}
          size="lg"
        >
          <DownloadIcon size="1.25rem" />
        </IconButton>
      );
    }
    if (failedMessage) {
      return (
        <IconButton
          className="norea-novel-chapter-state-button"
          label={t("novel.retryDownload")}
          onClick={onDownload}
          size="lg"
          tone="danger"
        >
          {downloadIcon(RetryIcon)}
        </IconButton>
      );
    }
    if (chapter.isDownloaded) {
      if (!canDeleteDownload) return null;
      return (
        <OverflowMenu
          items={[{
            danger: true,
            disabled: deleteBusy,
            icon: TrashIcon,
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
    if (effectiveStatus?.kind === "done") {
      return (
        <span
          aria-label={t("novel.downloaded")}
          className="norea-novel-chapter-progress-slot norea-novel-chapter-state-button"
          data-state="downloaded"
          role="img"
        >
          <DownloadedIcon size="1.25rem" />
        </span>
      );
    }
    return (
      <IconButton
        className="norea-novel-chapter-state-button"
        label={t(onServer ? "novel.downloadChapterFromServer" : "novel.downloadChapter")}
        onClick={onDownload}
        size="lg"
      >
        {downloadIcon(DownloadIcon)}
      </IconButton>
    );
  };

  const trailing = renderTrailing();

  return (
    <div
      ref={setNodeRef}
      className="norea-novel-chapter"
      data-busy={downloadActive ? "true" : undefined}
      data-next={isNext ? "true" : undefined}
      data-dragging={isDragging ? "true" : undefined}
      data-highlighted={highlighted ? "true" : undefined}
      data-progress={readFill === null ? undefined : finished ? "read" : "partial"}
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
        aria-current={isNext ? "step" : undefined}
        aria-describedby={metaId}
        aria-label={
          selectionMode
            ? t("novel.toggleChapterSelection", { name: chapter.name })
            : t("novel.openChapter", { name: chapter.name })
        }
        aria-pressed={selectionMode ? isSelected : undefined}
        className="norea-novel-chapter-open"
        leading={
          <>
            {selectionMode ? (
              <span
                aria-hidden="true"
                className="norea-novel-chapter-check"
                data-checked={isSelected ? "true" : undefined}
                data-range-start={isRangeStart ? "true" : undefined}
              >
                {isSelected ? <CheckIcon size="1rem" /> : null}
              </span>
            ) : null}
            <span
              className="norea-novel-chapter-ordinal"
              title={t("novel.chapterOrdinal", { number: ordinal })}
            >
              {ordinal}
            </span>
          </>
        }
        data-pressing={longPress.pressing ? "true" : undefined}
        onClick={(event) => {
          if (longPress.consumeFired()) return;
          if (reorderMode) return;
          const action = chapterRowClickAction(selectionMode, event.shiftKey);
          if (action === "select-range") onExtendSelection();
          else if (action === "toggle") onToggleSelected();
          else onOpen();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (!reorderMode && !longPress.fired()) onExtendSelection();
        }}
        {...longPress.handlers}
        selected={isSelected}
        subtitle={
          <span
            className="norea-novel-chapter-meta"
            id={metaId}
            title={details || undefined}
          >
            {chapterNameShowsNumber(chapter) ? null : (
              <span>{t("novel.chapterShort", { number: formatChapterNumber(chapter) })}</span>
            )}
            {releaseTime ? <span>{releaseTime}</span> : null}
            {partlyRead ? (
              <VisuallyHidden>{t("novel.percentRead", { progress })}</VisuallyHidden>
            ) : null}
            {chapter.serverDifferent ? <span className="norea-novel-chapter-badge">{t("chapterDifference.rowBadge")}</span> : null}
            {renderStatus()}
          </span>
        }
        title={
          <>
            <span className="norea-novel-chapter-title" data-read={finished ? "true" : undefined}>
              {chapter.name}
            </span>
            {chapter.bookmark ? (
              <>
                <BookmarkedIcon className="norea-novel-chapter-bookmark" size="1rem" />
                <VisuallyHidden>{t("novel.bookmarked")}</VisuallyHidden>
              </>
            ) : null}
            {isNext ? <span className="norea-novel-chapter-next">{t("novel.upNext")}</span> : null}
            {selectionMode && isRangeStart ? (
              <VisuallyHidden>{t("novel.selection.rangeStart")}</VisuallyHidden>
            ) : null}
          </>
        }
      />
      {trailing ? <div className="norea-novel-chapter-trailing">{trailing}</div> : null}
    </div>
  );
}

interface VirtualChapterListProps {
  chapters: readonly ServerAwareChapterListRow[];
  canDeleteDownloads: boolean;
  deleteBusyChapterId: number | undefined;
  duplicateSourceChapterCounts: ReadonlyMap<number, number>;
  deletePending: boolean;
  /** Scrolls the row into view and highlights it briefly; each new object is a new jump. */
  jumpRequest: { chapterId: number } | null;
  continueChapterId: number | undefined;
  /** The last toggled row, where a long press starts its range; marked while selecting. */
  rangeStartChapterId: number | null;
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
  onDownload: (chapter: ChapterListRow, retryAfterFailure?: boolean, sourceFallback?: boolean) => void;
  /**
   * Long press, right-click or Shift-click: starts a selection with this row,
   * or, while selecting, selects the rows from the range start to this one.
   */
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
  continueChapterId,
  rangeStartChapterId,
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
  const fallbackOrdinals = useMemo(() => {
    if (chapters.every((chapter) => chapter.ordinal !== undefined)) return null;
    return new Map(
      getReadingOrderChapters(chapters).map((chapter, index) => [chapter.id, index + 1] as const),
    );
  }, [chapters]);
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
                ordinal={chapter.ordinal ?? fallbackOrdinals?.get(chapter.id) ?? displayIndex + 1}
                canDeleteDownload={canDeleteDownloads}
                canMoveDown={
                  reorderMode && displayIndex < chapters.length - 1
                }
                canMoveUp={reorderMode && displayIndex > 0}
                duplicateSourceChapterCount={
                  duplicateSourceChapterCounts.get(chapter.id) ?? 0
                }
                highlighted={chapter.id === highlightedChapterId}
                isNext={chapter.id === continueChapterId}
                isRangeStart={chapter.id === rangeStartChapterId}
                isSelected={selectedChapterIds.has(chapter.id)}
                reorderMode={reorderMode}
                selectionMode={selectionMode}
                status={statuses.get(chapter.id)}
                deleteBusy={deletePending && deleteBusyChapterId === chapter.id}
                repairBusy={repairPending && repairBusyChapterId === chapter.id}
                reorderBusy={reorderPending}
                onOpen={() => onOpen(chapter)}
                onDownload={() => {
                  const status = statuses.get(chapter.id);
                  const error = status?.kind === "failed" ? status.error : null;
                  const retryFromSource =
                    error !== null &&
                    isServerChapterMissingFailure(error) &&
                    !isServerChapterMissingWithoutSourceFailure(error);
                  onDownload(chapter, error !== null, retryFromSource);
                }}
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
