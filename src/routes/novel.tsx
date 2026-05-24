import {
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Drawer,
  Group,
  Loader,
  Modal,
  Popover,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  DetailsGlyph,
  DownloadGlyph,
  DownloadedGlyph,
  DragHandleGlyph,
  LibraryAddGlyph,
  LibraryAddedGlyph,
  PlayFromStartGlyph,
  PlayGlyph,
  PlusGlyph,
  ReaderSettingsGlyph,
  RefreshGlyph,
  RetryGlyph,
  SortGlyph,
} from "../components/ActionGlyphs";
import {
  ConsoleChip,
  ConsoleCover,
  ConsolePanel,
  ConsoleProgress,
  ConsoleSectionHeader,
} from "../components/ConsolePrimitives";
import { PageFrame, StateView } from "../components/AppFrame";
import { BackIconButton } from "../components/BackIconButton";
import { IconButton } from "../components/IconButton";
import { LocalCoverPicker } from "../components/LocalCoverPicker";
import { ReaderSettingsPanel } from "../components/ReaderSettingsPanel";
import { TextButton } from "../components/TextButton";
import {
  clearChapterContent,
  listChaptersByNovel,
  type ChapterListRow,
} from "../db/queries/chapter";
import {
  getNovelById,
  reorderLocalNovelChapters,
  setNovelInLibrary,
  updateLocalNovelMetadata,
  upsertLocalNovelChapters,
  type LocalNovelImportChapterInput,
  type LocalNovelMetadataInput,
  type NovelDetailRecord,
} from "../db/queries/novel";
import {
  clearLocalImportFileCache,
  convertLocalImportFile,
} from "../lib/local-import";
import { syncLocalChapterStorageAfterOrderChange } from "../lib/local-chapter-storage";
import { cacheLocalImportedChapterMedia } from "../lib/local-import-media";
import {
  getSourceDuplicateChapterInfo,
  syncNovelFromSource,
  type SourceDuplicateChapterInfo,
} from "../lib/plugins/sync-novel";
import { clearChapterMedia } from "../lib/chapter-media";
import {
  clearStoredChapterContentMirror,
  mirrorStoredNovelChapters,
} from "../lib/chapter-content-storage";
import {
  findPreviousAppHistoryEntry,
  trimAppNavigationHistoryTo,
} from "../lib/navigation-history";
import {
  enqueueChapterDownload,
  enqueueChapterDownloadBatch,
  enqueueChapterMediaRepair,
  listChapterDownloadStatuses,
  subscribeChapterDownloads,
  type ChapterDownloadStatus,
} from "../lib/tasks/chapter-download";
import { markUpdatesIndexDirty } from "../lib/updates/update-index-events";
import {
  enqueueOpenSiteTask,
  enqueueSourceTask,
} from "../lib/tasks/source-tasks";
import { getPluginBaseUrl } from "../lib/plugins/base-url";
import { pluginManager } from "../lib/plugins/manager";
import {
  DEFAULT_CHAPTER_SORT_LABEL_KEYS,
} from "../lib/library-settings-options";
import { novelRoute } from "../router";
import { useTranslation } from "../i18n";
import {
  normalizeFontScalePercent,
  useAppearanceStore,
} from "../store/appearance";
import { useLibraryStore, type DefaultChapterSort } from "../store/library";
import { useReaderStore } from "../store/reader";
import "../styles/novel.css";

const FINISHED_PROGRESS = 100;
const CHAPTER_ROW_HEIGHT = 54;
const CHAPTER_LIST_OVERSCAN = 8;
const CHAPTER_LIST_FALLBACK_ROWS = 14;
const CHAPTER_DND_PREFIX = "chapter:";
const LOCAL_IMPORT_ACCEPT = ".txt,.html,.htm,.md,.markdown,.epub,.pdf";
const EMPTY_CHAPTERS: ChapterListRow[] = [];
const EMPTY_CHAPTER_DND_IDS: string[] = [];
const EMPTY_SOURCE_DUPLICATE_CHAPTER_COUNTS = new Map<number, number>();
const EMPTY_LOCAL_NOVEL_FORM: LocalNovelMetadataInput = {
  name: "",
  cover: "",
  summary: "",
  author: "",
  artist: "",
  status: "",
  genres: "",
};
const NOVEL_TITLE_FONT_SIZES = [
  "1.55rem",
  "1.42rem",
  "1.3rem",
  "1.18rem",
  "1.05rem",
] as const;

type NovelTitleFontSize = (typeof NOVEL_TITLE_FONT_SIZES)[number];
type NovelMetadataRefreshMode = "since" | "full";

interface BatchDownloadTargets {
  all: ChapterListRow[];
  next10: ChapterListRow[];
  next30: ChapterListRow[];
  unread: ChapterListRow[];
}

interface BatchDownloadOption {
  chapters: ChapterListRow[];
  description: string;
  key: string;
  label: string;
}

function novelKey(id: number) {
  return ["novel", "detail", id] as const;
}

function chaptersKey(id: number) {
  return ["novel", "detail", id, "chapters"] as const;
}

function sourceDuplicateChapterCountsById(
  chapters: readonly ChapterListRow[],
  duplicates: readonly SourceDuplicateChapterInfo[],
): ReadonlyMap<number, number> {
  if (chapters.length === 0 || duplicates.length === 0) {
    return EMPTY_SOURCE_DUPLICATE_CHAPTER_COUNTS;
  }

  const duplicatesByChapter = new Map(
    duplicates.map((duplicate) => [String(duplicate.chapterNumber), duplicate]),
  );
  const counts = new Map<number, number>();
  for (const chapter of chapters) {
    if (!chapter.chapterNumber) continue;
    const duplicate = duplicatesByChapter.get(chapter.chapterNumber);
    if (!duplicate || duplicate.keptPath !== chapter.path) continue;
    counts.set(chapter.id, duplicate.discardedCount);
  }
  return counts;
}

function normalizeDateText(value: string): string {
  return value.replace(/,/g, "").replace(/\s+/g, " ").trim();
}

function formatChapterPosition(position: number): string {
  return `#${String(position).padStart(2, "0")}`;
}

function chapterDndId(chapterId: number): string {
  return `${CHAPTER_DND_PREFIX}${chapterId}`;
}

function parseChapterDndId(id: unknown): number | null {
  const value = String(id);
  if (!value.startsWith(CHAPTER_DND_PREFIX)) return null;
  const chapterId = Number(value.slice(CHAPTER_DND_PREFIX.length));
  return Number.isInteger(chapterId) ? chapterId : null;
}

function beforeChapterIdForMove(
  orderedIds: number[],
  activeId: number,
  overId: number,
): number | null {
  const activeIndex = orderedIds.indexOf(activeId);
  const overIndex = orderedIds.indexOf(overId);
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) {
    return activeId;
  }
  return activeIndex < overIndex ? orderedIds[overIndex + 1] ?? null : overId;
}

function splitGenres(genres: string | null): string[] {
  if (!genres) return [];
  return genres
    .split(/[|,]/)
    .map((genre) => genre.trim())
    .filter(Boolean);
}

function localMetadataFromNovel(
  novel: NovelDetailRecord,
): LocalNovelMetadataInput {
  return {
    name: novel.name,
    cover: novel.cover ?? "",
    summary: novel.summary ?? "",
    author: novel.author ?? "",
    artist: novel.artist ?? "",
    status: novel.status ?? "",
    genres: novel.genres ?? "",
  };
}

async function convertLocalChapterFiles(
  files: readonly File[],
  startPosition: number,
): Promise<LocalNovelImportChapterInput[]> {
  const chapters: LocalNovelImportChapterInput[] = [];

  for (const file of files) {
    try {
      const conversion = await convertLocalImportFile(file);
      for (const chapter of conversion.chapters) {
        chapters.push({
          binaryResource: chapter.binaryResource,
          chapterNumber:
            chapter.chapterNumber == null
              ? null
              : String(chapter.chapterNumber),
          content: chapter.content,
          contentBytes: chapter.contentBytes,
          contentType: chapter.contentType,
          mediaResources: chapter.mediaResources,
          name: chapter.name,
          page: chapter.page,
          path: chapter.path,
          position: startPosition + chapters.length + 1,
          releaseTime: chapter.releaseTime ?? null,
        });
      }
    } finally {
      clearLocalImportFileCache(file);
    }
  }

  return chapters;
}

function isActiveDownloadStatus(
  status: ChapterDownloadStatus | undefined,
): boolean {
  return (
    status?.kind === "queued" ||
    status?.kind === "running" ||
    status?.kind === "done"
  );
}

function getReadingOrderChapters(
  chapters: readonly ChapterListRow[],
): readonly ChapterListRow[] {
  let asc = true;
  let desc = true;

  for (let index = 1; index < chapters.length; index += 1) {
    const previous = chapters[index - 1]!;
    const current = chapters[index]!;
    if (previous.position > current.position) asc = false;
    if (previous.position < current.position) desc = false;
  }

  if (asc) return chapters;
  if (desc) return [...chapters].reverse();
  return [...chapters].sort((left, right) => left.position - right.position);
}

function buildBatchDownloadTargets(
  chapters: readonly ChapterListRow[],
  lastReadChapterId: number | undefined,
  downloadStatuses: ReadonlyMap<number, ChapterDownloadStatus>,
): BatchDownloadTargets {
  const readingOrder = getReadingOrderChapters(chapters);
  const candidates = readingOrder.filter(
    (chapter) =>
      !chapter.isDownloaded &&
      !isActiveDownloadStatus(downloadStatuses.get(chapter.id)),
  );
  const currentIndex =
    lastReadChapterId === undefined
      ? -1
      : readingOrder.findIndex((chapter) => chapter.id === lastReadChapterId);
  const nextStartIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
  const nextCandidates = readingOrder
    .slice(nextStartIndex)
    .filter(
      (chapter) =>
        !chapter.isDownloaded &&
        !isActiveDownloadStatus(downloadStatuses.get(chapter.id)),
    );

  return {
    all: candidates,
    next10: nextCandidates.slice(0, 10),
    next30: nextCandidates.slice(0, 30),
    unread: candidates.filter((chapter) => chapter.unread),
  };
}

function useAutoFitNovelTitle(title: string) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [fontSize, setFontSize] = useState<NovelTitleFontSize>(
    NOVEL_TITLE_FONT_SIZES[0],
  );

  useEffect(() => {
    const element = titleRef.current;
    if (!element || typeof window === "undefined") return;

    let frame = 0;

    const overflows = () =>
      element.scrollHeight > element.clientHeight + 1 ||
      element.scrollWidth > element.clientWidth + 1;

    const fitTitle = () => {
      let nextFontSize =
        NOVEL_TITLE_FONT_SIZES[NOVEL_TITLE_FONT_SIZES.length - 1];

      for (const size of NOVEL_TITLE_FONT_SIZES) {
        element.style.setProperty("--lnr-novel-title-font-size", size);
        if (!overflows()) {
          nextFontSize = size;
          break;
        }
      }

      element.style.setProperty(
        "--lnr-novel-title-font-size",
        nextFontSize,
      );
      setFontSize((currentFontSize) =>
        currentFontSize === nextFontSize ? currentFontSize : nextFontSize,
      );
    };

    const scheduleFit = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(fitTitle);
    };

    scheduleFit();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleFit);

    resizeObserver?.observe(element);
    if (element.parentElement) resizeObserver?.observe(element.parentElement);
    window.addEventListener("resize", scheduleFit);

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleFit);
    };
  }, [title]);

  return {
    titleRef,
    titleStyle: {
      "--lnr-novel-title-font-size": fontSize,
    } as CSSProperties,
  };
}

function getChapterReadingProgress(chapter: ChapterListRow): number {
  if (chapter.progress >= FINISHED_PROGRESS) return 100;
  return Math.max(0, Math.min(100, Math.round(chapter.progress)));
}

function getNovelReadingPercent(chapters: readonly ChapterListRow[]): number {
  if (chapters.length === 0) return 0;
  const total = chapters.reduce(
    (sum, chapter) => sum + getChapterReadingProgress(chapter),
    0,
  );
  return Math.round(total / chapters.length);
}

function findFirstChapter(chapters: ChapterListRow[]): ChapterListRow | null {
  return chapters.reduce<ChapterListRow | null>((first, chapter) => {
    if (!first || chapter.position < first.position) return chapter;
    return first;
  }, null);
}

function findLastReadChapter(
  chapters: ChapterListRow[],
  lastReadChapterId: number | undefined,
): ChapterListRow | null {
  if (lastReadChapterId === undefined) return null;
  return chapters.find((chapter) => chapter.id === lastReadChapterId) ?? null;
}

function resolveNovelSourceUrl(novel: NovelDetailRecord): string | null {
  if (novel.isLocal) return null;

  const plugin = pluginManager.getPlugin(novel.pluginId);
  if (!plugin) return null;

  if (plugin.resolveUrl) {
    try {
      const resolved = plugin.resolveUrl(novel.path, true);
      if (resolved) return resolved;
    } catch {
      // Fall back to resolving the path against the plugin base URL below.
    }
  }

  try {
    return new URL(novel.path, getPluginBaseUrl(plugin)).toString();
  } catch {
    return getPluginBaseUrl(plugin);
  }
}

interface ChapterListItemProps {
  chapter: ChapterListRow;
  canDeleteDownload: boolean;
  canMoveDown: boolean;
  canMoveUp: boolean;
  duplicateSourceChapterCount: number;
  isCurrent: boolean;
  status: ChapterDownloadStatus | undefined;
  deleteBusy: boolean;
  opening: boolean;
  repairBusy: boolean;
  reorderBusy: boolean;
  onOpen: () => void;
  onDownload: () => void;
  onDeleteDownload: () => void;
  onRepairMedia: () => void;
}

function ChapterListItem({
  chapter,
  canDeleteDownload,
  canMoveDown,
  canMoveUp,
  duplicateSourceChapterCount,
  isCurrent,
  status,
  deleteBusy,
  opening,
  repairBusy,
  reorderBusy,
  onOpen,
  onDownload,
  onDeleteDownload,
  onRepairMedia,
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
  const showDownloadButton =
    !chapter.isDownloaded && !opening && !isQueued && !isRunning;
  const showOpeningSpinner =
    opening && !chapter.isDownloaded && !isQueued && !isRunning;
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
    showOpeningSpinner ||
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
      {showOpeningSpinner ? (
        <ChapterFlag label={t("common.downloading")}>
          <SpinnerIcon />
        </ChapterFlag>
      ) : null}
      {status ? <ChapterDownloadStatusIcon status={status} /> : null}
    </>
  );

  return (
    <div
      ref={setNodeRef}
      className={`lnr-novel-chapter-row${
        isCurrent ? " lnr-novel-chapter-row--current" : ""
      }`}
      role="button"
      tabIndex={0}
      aria-busy={opening || isRunning}
      aria-label={t("novel.openChapter", { name: chapter.name })}
      data-dragging={isDragging ? "true" : undefined}
      data-has-drag={hasReorderControls ? "true" : undefined}
      data-opening={opening}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (
          event.target instanceof HTMLElement &&
          event.target.closest(".lnr-novel-chapter-drag-handle")
        ) {
          return;
        }
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
      style={style}
    >
      {hasReorderControls ? (
        <span
          {...(canDrag ? attributes : undefined)}
          {...(canDrag ? listeners : undefined)}
          aria-disabled={!canDrag}
          aria-label={t("novel.local.dragChapter")}
          className="lnr-novel-chapter-drag-handle"
          data-disabled={canDrag ? undefined : "true"}
          onClick={(event) => event.stopPropagation()}
          role="button"
          tabIndex={canDrag ? 0 : -1}
          title={t("novel.local.dragChapter")}
        >
          <DragHandleGlyph />
        </span>
      ) : null}
      <div className="lnr-novel-chapter-position">
        <span>{formatChapterPosition(chapter.position)}</span>
        {isCurrent ? (
          <span
            aria-label={t("common.current")}
            className="lnr-novel-chapter-current-dot"
            role="img"
            title={t("common.current")}
          />
        ) : null}
      </div>

      <div className="lnr-novel-chapter-main">
        <div className="lnr-novel-chapter-title-line">
          <Text
            className="lnr-novel-chapter-title"
            data-read={!chapter.unread}
            title={chapter.name}
          >
            {chapter.name}
          </Text>
        </div>
        <div className="lnr-novel-chapter-meta-row">
          {releaseTime ? (
            <Text className="lnr-novel-chapter-meta">{releaseTime}</Text>
          ) : null}
          <span className="lnr-novel-chapter-percent lnr-novel-chapter-percent--inline">
            {progress}%
          </span>
          {hasChapterFlags ? (
            <span
              className="lnr-novel-chapter-flags lnr-novel-chapter-flags--inline"
              aria-label={t("novel.chapterStatus")}
            >
              {renderChapterFlags()}
            </span>
          ) : null}
        </div>
      </div>

      {hasChapterFlags ? (
        <div
          className="lnr-novel-chapter-flags lnr-novel-chapter-flags--desktop"
          aria-label={t("novel.chapterStatus")}
        >
          {renderChapterFlags()}
        </div>
      ) : null}

      <div className="lnr-novel-chapter-progress">
        <ConsoleProgress value={progress} status={progressStatus} />
        <span>{progress}%</span>
      </div>

      <div className="lnr-novel-chapter-actions">
        {showDownloadButton ? (
          <IconButton
            className="lnr-novel-icon-button"
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
            className="lnr-novel-icon-button"
            data-busy={repairBusy ? "true" : undefined}
            disabled={repairBusy}
            label={t("novel.repairChapterMedia")}
            size="lg"
            onClick={(event) => {
              event.stopPropagation();
              onRepairMedia();
            }}
          >
            {repairBusy ? <SpinnerIcon /> : <RetryGlyph />}
          </IconButton>
        ) : null}
        {chapter.isDownloaded && canDeleteDownload ? (
          <IconButton
            className="lnr-novel-icon-button"
            data-busy={deleteBusy ? "true" : undefined}
            disabled={deleteBusy}
            label={t("novel.deleteDownloadedChapter")}
            size="lg"
            onClick={(event) => {
              event.stopPropagation();
              onDeleteDownload();
            }}
          >
            <TrashIcon />
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
  openingChapterId: number | null;
  repairBusyChapterId: number | undefined;
  repairPending: boolean;
  reorderPending: boolean;
  statuses: ReadonlyMap<number, ChapterDownloadStatus>;
  onDeleteDownload: (chapterId: number) => void;
  onDownload: (chapter: ChapterListRow) => void;
  onOpen: (chapter: ChapterListRow) => void;
  onRepairMedia: (chapter: ChapterListRow) => void;
  onReorderChapter: (chapterId: number, beforeChapterId: number | null) => void;
}

function VirtualChapterList({
  chapters,
  canDeleteDownloads,
  canReorderChapters,
  deleteBusyChapterId,
  duplicateSourceChapterCounts,
  deletePending,
  lastReadChapterId,
  openingChapterId,
  repairBusyChapterId,
  repairPending,
  reorderPending,
  statuses,
  onDeleteDownload,
  onDownload,
  onOpen,
  onRepairMedia,
  onReorderChapter,
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
      className="lnr-novel-chapter-list"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      ref={viewportRef}
    >
      <div
        className="lnr-novel-chapter-list-spacer"
        style={{ height: totalHeight }}
      >
        <div
          className="lnr-novel-chapter-list-window"
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
                status={statuses.get(chapter.id)}
                deleteBusy={deletePending && deleteBusyChapterId === chapter.id}
                opening={openingChapterId === chapter.id}
                repairBusy={repairPending && repairBusyChapterId === chapter.id}
                reorderBusy={reorderPending}
                onOpen={() => onOpen(chapter)}
                onDownload={() => onDownload(chapter)}
                onDeleteDownload={() => onDeleteDownload(chapter.id)}
                onRepairMedia={() => onRepairMedia(chapter)}
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

function ChapterFlag({
  children,
  label,
  tone = "default",
}: ChapterFlagProps) {
  return (
    <Tooltip label={label} openDelay={350} withArrow>
      <span
        aria-label={label}
        className="lnr-novel-chapter-flag"
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
        <SpinnerIcon />
      </ChapterFlag>
    );
  }

  return (
    <ChapterFlag label={t("common.queued")}>
      <ClockIcon />
    </ChapterFlag>
  );
}

interface NovelActionButtonProps {
  active?: boolean;
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  tone?: "default" | "accent" | "success";
}

interface NovelBatchDownloadMenuProps {
  disabled: boolean;
  onDownload: (chapters: ChapterListRow[]) => void;
  options: BatchDownloadOption[];
}

interface NovelMetadataRefreshMenuProps {
  fullRefreshing: boolean;
  onFullRefresh: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}

function NovelActionButton({
  active = false,
  children,
  disabled = false,
  label,
  onClick,
  pressed,
  tone = "default",
}: NovelActionButtonProps) {
  return (
    <IconButton
      active={active}
      aria-pressed={pressed}
      className="lnr-novel-icon-button"
      disabled={disabled}
      label={label}
      onClick={onClick}
      size="lg"
      tone={tone}
    >
      {children}
    </IconButton>
  );
}

function NovelBatchDownloadMenu({
  disabled,
  onDownload,
  options,
}: NovelBatchDownloadMenuProps) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      shadow="md"
      width={260}
    >
      <Popover.Target>
        <IconButton
          className="lnr-novel-icon-button"
          disabled={disabled}
          label={t("novel.batchDownload.open")}
          onClick={() => setOpened((current) => !current)}
          size="lg"
        >
          <DownloadGlyph />
        </IconButton>
      </Popover.Target>
      <Popover.Dropdown className="lnr-novel-batch-download-menu">
        <div className="lnr-novel-batch-download-list">
          {options.map((option) => (
            <button
              className="lnr-novel-batch-download-option"
              disabled={option.chapters.length === 0}
              key={option.key}
              onClick={() => {
                onDownload(option.chapters);
                setOpened(false);
              }}
              type="button"
            >
              <span className="lnr-novel-batch-download-label">
                {option.label}
              </span>
              <span className="lnr-novel-batch-download-description">
                {option.description}
              </span>
            </button>
          ))}
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}

function NovelMetadataRefreshMenu({
  fullRefreshing,
  onFullRefresh,
  onRefresh,
  refreshing,
}: NovelMetadataRefreshMenuProps) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const busy = refreshing || fullRefreshing;

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      shadow="md"
      width={280}
    >
      <Popover.Target>
        <IconButton
          className="lnr-novel-icon-button"
          disabled={busy}
          label={t("novel.refreshMetadataMenu")}
          onClick={() => setOpened((current) => !current)}
          size="lg"
        >
          {busy ? <Loader size={14} /> : <RefreshGlyph />}
        </IconButton>
      </Popover.Target>
      <Popover.Dropdown className="lnr-novel-batch-download-menu">
        <div className="lnr-novel-batch-download-list">
          <button
            className="lnr-novel-batch-download-option"
            disabled={busy}
            onClick={() => {
              onRefresh();
              setOpened(false);
            }}
            type="button"
          >
            <span className="lnr-novel-batch-download-label">
              {t("novel.refreshMetadata")}
            </span>
            <span className="lnr-novel-batch-download-description">
              {t("novel.refreshMetadataDescription")}
            </span>
          </button>
          <button
            className="lnr-novel-batch-download-option"
            disabled={busy}
            onClick={() => {
              onFullRefresh();
              setOpened(false);
            }}
            type="button"
          >
            <span className="lnr-novel-batch-download-label">
              {t("novel.refreshMetadataFull")}
            </span>
            <span className="lnr-novel-batch-download-description">
              {t("novel.refreshMetadataFullDescription")}
            </span>
          </button>
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}

interface ChapterSortPickerProps {
  onChange: (value: DefaultChapterSort) => void;
  value: DefaultChapterSort;
}

function ChapterSortPicker({ onChange, value }: ChapterSortPickerProps) {
  const { t } = useTranslation();
  const activeLabel = t(DEFAULT_CHAPTER_SORT_LABEL_KEYS[value]);
  const nextValue: DefaultChapterSort = value === "desc" ? "asc" : "desc";

  return (
    <IconButton
      active={value === "desc"}
      className="lnr-novel-icon-button lnr-novel-chapter-sort-button"
      data-sort-direction={value}
      label={activeLabel}
      onClick={() => onChange(nextValue)}
      size="lg"
      title={`${t("librarySettings.defaultChapterSort")}: ${activeLabel}`}
    >
      <SortGlyph />
    </IconButton>
  );
}

interface NovelReadButtonProps {
  children: ReactNode;
  disabled: boolean;
  label: string;
  onClick: () => void;
  tone?: "default" | "accent";
}

function NovelReadButton({
  children,
  disabled,
  label,
  onClick,
  tone = "default",
}: NovelReadButtonProps) {
  return (
    <IconButton
      className="lnr-novel-read-icon-button"
      disabled={disabled}
      label={label}
      onClick={onClick}
      size="lg"
      tone={tone}
    >
      {children}
    </IconButton>
  );
}

function BookmarkIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M7 4h10v16l-5-3-5 3z" />
    </svg>
  );
}

function ReadIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 12l5 5L20 6" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M7 7l1 13h8l1-13" />
      <path d="M10 11v5" />
      <path d="M14 11v5" />
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

function SpinnerIcon() {
  return (
    <svg className="lnr-novel-spin-icon" aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 3a9 9 0 1 1-8.49 6" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v5l3 2" />
    </svg>
  );
}

interface NovelWorkspaceProps {
  chapters: ChapterListRow[];
  downloadStatuses: ReadonlyMap<number, ChapterDownloadStatus>;
  lastReadChapterId: number | undefined;
  localChapterAdding: boolean;
  fullMetadataRefreshing: boolean;
  metadataRefreshing: boolean;
  novel: NovelDetailRecord;
  onBack: () => void;
  onAddLocalChapters: () => void;
  onBatchDownload: (chapters: ChapterListRow[]) => void;
  onEditLocalMetadata: () => void;
  onOpenReaderSettings: () => void;
  onOpenSource: () => void;
  onRead: (chapter: ChapterListRow) => void;
  onRefreshFullMetadata: () => void;
  onRefreshMetadata: () => void;
  onToggleLibrary: () => void;
  sourceName: string;
  sourceUrl: string | null;
  toggleBusy: boolean;
}

function NovelWorkspace({
  chapters,
  downloadStatuses,
  lastReadChapterId,
  localChapterAdding,
  fullMetadataRefreshing,
  metadataRefreshing,
  novel,
  onBack,
  onAddLocalChapters,
  onBatchDownload,
  onEditLocalMetadata,
  onOpenReaderSettings,
  onOpenSource,
  onRead,
  onRefreshFullMetadata,
  onRefreshMetadata,
  onToggleLibrary,
  sourceName,
  sourceUrl,
  toggleBusy,
}: NovelWorkspaceProps) {
  const { t } = useTranslation();
  const { titleRef, titleStyle } = useAutoFitNovelTitle(novel.name);
  const genres = useMemo(() => splitGenres(novel.genres), [novel.genres]);
  const firstChapter = useMemo(() => findFirstChapter(chapters), [chapters]);
  const lastReadChapter = useMemo(
    () => findLastReadChapter(chapters, lastReadChapterId),
    [chapters, lastReadChapterId],
  );
  const readPercent = useMemo(() => getNovelReadingPercent(chapters), [chapters]);
  const libraryActionLabel = novel.inLibrary
    ? t("novel.removeFromLibrary")
    : t("novel.addToLibrary");
  const batchTargets = useMemo(
    () =>
      buildBatchDownloadTargets(
        chapters,
        lastReadChapterId,
        downloadStatuses,
      ),
    [chapters, downloadStatuses, lastReadChapterId],
  );
  const batchDownloadOptions: BatchDownloadOption[] = useMemo(
    () => [
      {
        chapters: batchTargets.all,
        description: t("novel.batchDownload.available", {
          count: batchTargets.all.length,
        }),
        key: "all",
        label: t("novel.batchDownload.all"),
      },
      {
        chapters: batchTargets.unread,
        description: t("novel.batchDownload.available", {
          count: batchTargets.unread.length,
        }),
        key: "unread",
        label: t("novel.batchDownload.unread"),
      },
      {
        chapters: batchTargets.next10,
        description: t("novel.batchDownload.available", {
          count: batchTargets.next10.length,
        }),
        key: "next10",
        label: t("novel.batchDownload.next10"),
      },
      {
        chapters: batchTargets.next30,
        description: t("novel.batchDownload.available", {
          count: batchTargets.next30.length,
        }),
        key: "next30",
        label: t("novel.batchDownload.next30"),
      },
    ],
    [batchTargets, t],
  );
  const hasBatchDownloadTargets = useMemo(
    () => batchDownloadOptions.some((option) => option.chapters.length > 0),
    [batchDownloadOptions],
  );
  const renderCoverPanel = () => (
    <ConsolePanel className="lnr-novel-cover-panel">
      <ConsoleCover
        alt={novel.name}
        height={204}
        src={novel.cover}
        width={136}
      />
    </ConsolePanel>
  );

  const renderGenreTags = () =>
    genres.length > 0 ? (
      <div className="lnr-novel-tags-row" aria-label={t("library.tags.title")}>
        {genres.map((genre) => (
          <span className="lnr-novel-genre-chip" key={genre}>
            <ConsoleChip>{genre}</ConsoleChip>
          </span>
        ))}
      </div>
    ) : null;

  const renderActionGroup = () => (
    <div className="lnr-novel-title-actions">
      {novel.isLocal ? (
        <>
          <NovelActionButton
            disabled={localChapterAdding}
            label={t("novel.local.addChapters")}
            onClick={onAddLocalChapters}
          >
            {localChapterAdding ? <Loader size={14} /> : <PlusGlyph />}
          </NovelActionButton>
          <NovelActionButton
            label={t("novel.local.editMetadata")}
            onClick={onEditLocalMetadata}
          >
            <DetailsGlyph />
          </NovelActionButton>
        </>
      ) : (
        <>
          <NovelBatchDownloadMenu
            disabled={!hasBatchDownloadTargets}
            onDownload={onBatchDownload}
            options={batchDownloadOptions}
          />
          <NovelMetadataRefreshMenu
            fullRefreshing={fullMetadataRefreshing}
            onFullRefresh={onRefreshFullMetadata}
            onRefresh={onRefreshMetadata}
            refreshing={metadataRefreshing}
          />
        </>
      )}
      <NovelActionButton
        label={t("novel.readerSettings")}
        onClick={onOpenReaderSettings}
      >
        <ReaderSettingsGlyph />
      </NovelActionButton>
      <NovelActionButton
        active={novel.inLibrary}
        disabled={toggleBusy}
        label={libraryActionLabel}
        onClick={onToggleLibrary}
        pressed={novel.inLibrary}
        tone={novel.inLibrary ? "success" : "accent"}
      >
        {novel.inLibrary ? <LibraryAddedGlyph /> : <LibraryAddGlyph />}
      </NovelActionButton>
      {novel.isLocal ? null : (
        <NovelActionButton
          disabled={!sourceUrl}
          label={t("novel.openSource")}
          onClick={onOpenSource}
        >
          <DetailsGlyph />
        </NovelActionButton>
      )}
    </div>
  );

  const renderInfoPanel = (isDesktop: boolean) => (
    <ConsolePanel className="lnr-novel-info-panel">
      <div className="lnr-novel-title-row">
        <BackIconButton className="lnr-novel-icon-button" onClick={onBack} />
        <div className="lnr-novel-title-copy">
          <Title
            className="lnr-novel-title"
            order={1}
            ref={isDesktop ? titleRef : undefined}
            style={isDesktop ? titleStyle : undefined}
          >
            {novel.name}
          </Title>
          <Group className="lnr-novel-meta-row" gap="xs" mt={6} wrap="wrap">
            {novel.author ? (
              <Text className="lnr-novel-meta">
                {t("novel.author", { name: novel.author })}
              </Text>
            ) : null}
            {novel.artist && novel.artist !== novel.author ? (
              <Text className="lnr-novel-meta">
                {t("novel.artist", { name: novel.artist })}
              </Text>
            ) : null}
            <Text className="lnr-novel-meta">
              {t("novel.source", {
                name: sourceName,
              })}
            </Text>
          </Group>
        </div>
        {isDesktop ? renderActionGroup() : null}
      </div>

      <div className="lnr-novel-status-block">
        <Group className="lnr-novel-identity-strip" gap="xs" wrap="wrap">
          {novel.status ? (
            <ConsoleChip tone="accent">{novel.status}</ConsoleChip>
          ) : null}
          {novel.isLocal ? <ConsoleChip>{t("common.local")}</ConsoleChip> : null}
        </Group>

        <div className="lnr-novel-progress-row">
          <div className="lnr-novel-progress-block">
            <div className="lnr-novel-progress-line">
              <ConsoleProgress
                value={readPercent}
                status={readPercent >= 100 ? "done" : "active"}
              />
              <span>{t("novel.percentRead", { progress: readPercent })}</span>
            </div>
            <div className="lnr-novel-read-actions">
              <NovelReadButton
                disabled={!lastReadChapter}
                label={t("novel.continueReading")}
                onClick={() => lastReadChapter && onRead(lastReadChapter)}
                tone="accent"
              >
                <PlayGlyph />
              </NovelReadButton>
              <NovelReadButton
                disabled={!firstChapter}
                label={t("novel.startReading")}
                onClick={() => firstChapter && onRead(firstChapter)}
              >
                <PlayFromStartGlyph />
              </NovelReadButton>
            </div>
          </div>
          {isDesktop ? null : renderActionGroup()}
        </div>
      </div>
    </ConsolePanel>
  );

  const renderSummaryPanel = () => (
    <ConsolePanel
      className="lnr-novel-summary-panel"
      title={t("common.summary")}
    >
      <div className="lnr-novel-summary-content">
        {novel.summary ? (
          <Text className="lnr-novel-summary-text">{novel.summary}</Text>
        ) : (
          <Text className="lnr-novel-empty-copy">{t("novel.noSummary")}</Text>
        )}
        {renderGenreTags()}
      </div>
    </ConsolePanel>
  );

  return (
    <div className="lnr-novel-workspace">
      <div className="lnr-novel-hero-desktop">
        {renderCoverPanel()}
        {renderInfoPanel(true)}
        {renderSummaryPanel()}
      </div>

      <div className="lnr-novel-hero-mobile">
        {renderInfoPanel(false)}
        <div className="lnr-novel-cover-summary-card">
          {renderCoverPanel()}
          {renderSummaryPanel()}
        </div>
      </div>
    </div>
  );
}

export function NovelDetailPage() {
  const { t } = useTranslation();
  const { id } = novelRoute.useSearch();
  const navigate = useNavigate();
  const currentHref = useRouterState({
    select: (state) => state.location.href,
  });
  const queryClient = useQueryClient();
  const defaultChapterSort = useLibraryStore((s) => s.defaultChapterSort);
  const setDefaultChapterSort = useLibraryStore(
    (s) => s.setDefaultChapterSort,
  );
  const lastReadChapterId = useReaderStore(
    (state) => state.lastReadChapterByNovel[id],
  );
  const localChapterInputRef = useRef<HTMLInputElement>(null);
  const [localChapterError, setLocalChapterError] = useState<string | null>(
    null,
  );
  const [localMetadataOpen, setLocalMetadataOpen] = useState(false);
  const [readerSettingsOpen, setReaderSettingsOpen] = useState(false);
  const [localMetadataForm, setLocalMetadataForm] =
    useState<LocalNovelMetadataInput>(EMPTY_LOCAL_NOVEL_FORM);
  const [sourceDuplicateChapters, setSourceDuplicateChapters] = useState<
    readonly SourceDuplicateChapterInfo[]
  >(() => getSourceDuplicateChapterInfo(id));

  const novelQuery = useQuery({
    queryKey: novelKey(id),
    queryFn: () => getNovelById(id),
    enabled: id > 0,
  });

  const chaptersQuery = useQuery({
    queryKey: chaptersKey(id),
    queryFn: () => listChaptersByNovel(id),
    enabled: id > 0,
  });

  useEffect(() => {
    setSourceDuplicateChapters(getSourceDuplicateChapterInfo(id));
  }, [id]);

  const toggle = useMutation({
    mutationFn: async () => {
      const novel = novelQuery.data;
      if (!novel) return;
      await setNovelInLibrary(novel.id, !novel.inLibrary);
    },
    onSuccess: () => {
      markUpdatesIndexDirty("library-membership");
      void queryClient.invalidateQueries({ queryKey: ["novel"] });
    },
  });

  const clearDownload = useMutation({
    mutationFn: async (chapterId: number) => {
      await clearChapterContent(chapterId);
      await clearChapterMedia(chapterId);
      await clearStoredChapterContentMirror(chapterId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: chaptersKey(id),
      });
      void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
    },
  });

  const repairMedia = useMutation({
    mutationFn: async (chapter: ChapterListRow) => {
      const novel = novelQuery.data;
      if (!novel || novel.isLocal) return;
      await enqueueChapterMediaRepair({
        id: chapter.id,
        pluginId: novel.pluginId,
        priority: "user",
        title: t("tasks.task.repairChapterMedia", { name: chapter.name }),
      }).promise;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: chaptersKey(id),
      });
      void queryClient.invalidateQueries({ queryKey: ["chapter"] });
      void queryClient.invalidateQueries({ queryKey: ["download-cache"] });
      void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
    },
  });

  const addLocalChapters = useMutation({
    mutationFn: async (files: readonly File[]) => {
      const startPosition =
        chaptersQuery.data?.reduce(
          (maxPosition, chapter) => Math.max(maxPosition, chapter.position),
          0,
        ) ?? 0;
      const chapters = await convertLocalChapterFiles(
        files,
        startPosition,
      );
      if (chapters.length === 0) return null;
      const previousChapters = await listChaptersByNovel(id);
      const result = await upsertLocalNovelChapters(id, chapters);
      const novel = novelQuery.data;
      if (novel) {
        const nextChapters = await listChaptersByNovel(id);
        await syncLocalChapterStorageAfterOrderChange({
          nextChapters,
          novel,
          previousChapters,
        });
        await cacheLocalImportedChapterMedia({
          chapters,
          novelId: id,
          novelName: novel.name,
          novelPath: novel.path,
        });
      }
      await mirrorStoredNovelChapters(id);
      return result;
    },
    onSuccess: () => {
      setLocalChapterError(null);
      void queryClient.invalidateQueries({ queryKey: chaptersKey(id) });
      void queryClient.invalidateQueries({ queryKey: novelKey(id) });
      void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
    },
    onError: (error) => {
      setLocalChapterError(
        error instanceof Error ? error.message : String(error),
      );
    },
  });

  const reorderLocalChapters = useMutation({
    mutationFn: async (chapterIds: number[]) => {
      const novel = novelQuery.data;
      if (!novel?.isLocal) return;
      const previousChapters = await listChaptersByNovel(id);
      await reorderLocalNovelChapters(id, chapterIds);
      const nextChapters = await listChaptersByNovel(id);
      await syncLocalChapterStorageAfterOrderChange({
        nextChapters,
        novel,
        previousChapters,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chaptersKey(id) });
      void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
    },
  });

  const updateLocalMetadata = useMutation({
    mutationFn: (input: LocalNovelMetadataInput) =>
      updateLocalNovelMetadata(id, input),
    onSuccess: () => {
      setLocalMetadataOpen(false);
      void queryClient.invalidateQueries({ queryKey: novelKey(id) });
      void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
    },
  });

  function invalidateNovelMetadataRefresh() {
    void queryClient.invalidateQueries({ queryKey: novelKey(id) });
    void queryClient.invalidateQueries({ queryKey: chaptersKey(id) });
    void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
  }

  function enqueueNovelMetadataRefresh(mode: NovelMetadataRefreshMode) {
    const novel = novelQuery.data;
    if (!novel || novel.isLocal) return Promise.resolve(null);
    const plugin = pluginManager.getPlugin(novel.pluginId);
    if (!plugin) {
      throw new Error(t("source.pluginNotLoaded"));
    }

    return enqueueSourceTask({
      plugin,
      kind: "source.refreshNovel",
      priority: "user",
      title: t(
        mode === "full"
          ? "tasks.task.refreshNovelMetadataFull"
          : "tasks.task.refreshNovelMetadata",
        { name: novel.name },
      ),
      subject: {
        novelId: novel.id,
        novelName: novel.name,
        path: novel.path,
      },
      dedupeKey:
        mode === "full"
          ? `source.refreshNovel:full:${novel.pluginId}:${novel.path}`
          : `source.refreshNovel:${novel.pluginId}:${novel.path}`,
      run: (context) =>
        syncNovelFromSource(
          pluginManager.getPluginForExecutor(
            novel.pluginId,
            context.executor ?? "immediate",
          ),
          {
            cover: novel.cover ?? undefined,
            name: novel.name,
            path: novel.path,
          },
          {
            chapterRefreshMode: mode,
            novelId: novel.id,
            preserveMissingMetadata: true,
          },
        ),
    }).promise;
  }

  const refreshMetadata = useMutation({
    mutationFn: () => enqueueNovelMetadataRefresh("since"),
    onSuccess: (result) => {
      if (result) setSourceDuplicateChapters(result.duplicateChapters);
      invalidateNovelMetadataRefresh();
    },
  });

  const fullRefreshMetadata = useMutation({
    mutationFn: () => enqueueNovelMetadataRefresh("full"),
    onSuccess: (result) => {
      if (result) setSourceDuplicateChapters(result.duplicateChapters);
      invalidateNovelMetadataRefresh();
    },
  });

  const [statuses, setStatuses] = useState<
    ReadonlyMap<number, ChapterDownloadStatus>
  >(() => new Map());
  const [openingChapterId, setOpeningChapterId] = useState<number | null>(null);
  const openRequestRef = useRef(0);

  useEffect(() => {
    return subscribeChapterDownloads((event) => {
      if (event.job.novelId !== undefined && event.job.novelId !== id) return;
      setStatuses((prev) => {
        const next = new Map(prev);
        if (event.status.kind === "cancelled") {
          next.delete(event.job.id);
        } else {
          next.set(event.job.id, event.status);
        }
        return next;
      });
      if (event.status.kind === "done") {
        void queryClient.invalidateQueries({
          queryKey: chaptersKey(id),
        });
      }
    });
  }, [id, queryClient]);

  const rows = chaptersQuery.data ?? EMPTY_CHAPTERS;
  const chapters = useMemo(
    () => (defaultChapterSort === "desc" ? [...rows].reverse() : rows),
    [defaultChapterSort, rows],
  );
  const sourceDuplicateChapterCounts = useMemo(
    () => sourceDuplicateChapterCountsById(chapters, sourceDuplicateChapters),
    [chapters, sourceDuplicateChapters],
  );
  const chapterStats = useMemo(
    () => {
      let downloaded = 0;
      let unread = 0;
      for (const chapter of rows) {
        if (chapter.isDownloaded) downloaded += 1;
        if (chapter.unread) unread += 1;
      }
      return { downloaded, unread };
    },
    [rows],
  );

  useEffect(() => {
    const novel = novelQuery.data;
    if (!novel?.isLocal) return;
    setLocalMetadataForm(localMetadataFromNovel(novel));
  }, [novelQuery.data]);

  useEffect(() => {
    if (rows.length === 0) return;
    const currentStatuses = listChapterDownloadStatuses();

    setStatuses((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [chapterId, status] of currentStatuses) {
        if (status?.kind === "cancelled") {
          if (next.delete(chapterId)) changed = true;
          continue;
        }
        if (next.get(chapterId) !== status) {
          next.set(chapterId, status);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rows]);

  function goBack() {
    const target = findPreviousAppHistoryEntry(currentHref, ["/reader"]);
    if (target) {
      trimAppNavigationHistoryTo(target);
      window.history.go(-target.steps);
      return;
    }

    void navigate({ to: "/", replace: true });
  }

  function openChapter(chapter: ChapterListRow): void {
    const requestId = openRequestRef.current + 1;
    openRequestRef.current = requestId;
    void navigate({ to: "/reader", search: { chapterId: chapter.id } });

    if (chapter.isDownloaded) {
      return;
    }

    const novel = novelQuery.data;
    if (!novel) return;

    setOpeningChapterId(chapter.id);
    void enqueueChapterDownload({
      id: chapter.id,
      pluginId: novel.pluginId,
      chapterPath: chapter.path,
      chapterName: chapter.name,
      contentType: chapter.contentType,
      novelId: novel.id,
      novelName: novel.name,
      novelPath: novel.path,
      priority: "interactive",
      title: t("tasks.task.downloadChapter", { name: chapter.name }),
    })
      .promise.then(async () => {
        if (openRequestRef.current !== requestId) return;
        await queryClient.invalidateQueries({
          queryKey: chaptersKey(id),
        });
        void queryClient.invalidateQueries({ queryKey: ["novel", "library"] });
      })
      .catch(() => {
        // The queue emits the failed status; the row renders that state.
      })
      .finally(() => {
        if (openRequestRef.current === requestId) {
          setOpeningChapterId(null);
        }
      });
  }

  function openSourceNovel(pluginId: string, url: string | null) {
    if (!url) return;
    const plugin = pluginManager.getPlugin(pluginId);
    if (!plugin) return;
    void enqueueOpenSiteTask(
      plugin,
      url,
      t("tasks.task.openSite", { source: plugin.name }),
    ).promise.catch(() => undefined);
  }

  function downloadChapter(chapter: ChapterListRow): void {
    const novel = novelQuery.data;
    if (!novel) return;
    void enqueueChapterDownload({
      id: chapter.id,
      pluginId: novel.pluginId,
      chapterPath: chapter.path,
      chapterName: chapter.name,
      contentType: chapter.contentType,
      novelId: novel.id,
      novelName: novel.name,
      novelPath: novel.path,
      priority: "user",
      title: t("tasks.task.downloadChapter", { name: chapter.name }),
    }).promise.catch(() => undefined);
  }

  function downloadChapters(chaptersToDownload: ChapterListRow[]): void {
    const novel = novelQuery.data;
    if (!novel || chaptersToDownload.length === 0) return;
    const batchNovel = novel;

    function* chapterDownloadJobs() {
      for (const chapter of chaptersToDownload) {
        yield {
          id: chapter.id,
          pluginId: batchNovel.pluginId,
          chapterPath: chapter.path,
          chapterName: chapter.name,
          contentType: chapter.contentType,
          novelId: batchNovel.id,
          novelName: batchNovel.name,
          novelPath: batchNovel.path,
          title: t("tasks.task.downloadChapter", { name: chapter.name }),
        };
      }
    }

    void enqueueChapterDownloadBatch({
      jobs: chapterDownloadJobs(),
      title: t("tasks.task.downloadChapterBatch", {
        count: chaptersToDownload.length,
      }),
      total: chaptersToDownload.length,
    }).promise.catch(() => undefined);
  }

  function openLocalChapterInput(): void {
    addLocalChapters.reset();
    setLocalChapterError(null);
    localChapterInputRef.current?.click();
  }

  function handleLocalChapterFilesSelected(
    event: ChangeEvent<HTMLInputElement>,
  ): void {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length === 0) return;

    const novel = novelQuery.data;
    if (!novel?.isLocal) return;
    addLocalChapters.mutate(files);
  }

  function openLocalMetadataEditor(): void {
    const novel = novelQuery.data;
    if (!novel?.isLocal) return;
    updateLocalMetadata.reset();
    setLocalMetadataForm(localMetadataFromNovel(novel));
    setLocalMetadataOpen(true);
  }

  function closeLocalMetadataEditor(): void {
    if (updateLocalMetadata.isPending) return;
    updateLocalMetadata.reset();
    setLocalMetadataOpen(false);
  }

  function handleLocalMetadataSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const novel = novelQuery.data;
    if (!novel?.isLocal || localMetadataForm.name.trim() === "") return;
    updateLocalMetadata.mutate(localMetadataForm);
  }

  function reorderLocalChapter(
    chapterId: number,
    beforeChapterId: number | null,
  ): void {
    const novel = novelQuery.data;
    if (!novel?.isLocal || reorderLocalChapters.isPending) return;

    const displayOrder = [...chapters];
    const currentIndex = displayOrder.findIndex(
      (chapter) => chapter.id === chapterId,
    );
    if (currentIndex < 0) return;

    const [chapter] = displayOrder.splice(currentIndex, 1);
    if (!chapter) return;

    if (beforeChapterId === null) {
      displayOrder.push(chapter);
    } else {
      const beforeIndex = displayOrder.findIndex(
        (candidate) => candidate.id === beforeChapterId,
      );
      if (beforeIndex < 0) return;
      displayOrder.splice(beforeIndex, 0, chapter);
    }

    const readingOrder =
      defaultChapterSort === "desc"
        ? [...displayOrder].reverse()
        : displayOrder;
    reorderLocalChapters.mutate(readingOrder.map((chapter) => chapter.id));
  }

  if (id <= 0) {
    return (
      <PageFrame>
        <StateView
          color="yellow"
          title={t("novel.missingId")}
          message={t("novel.missingIdMessage")}
        />
      </PageFrame>
    );
  }

  if (novelQuery.isLoading) {
    return (
      <PageFrame>
        <StateView
          color="blue"
          title={t("novel.loading")}
          message={t("novel.loadingMessage")}
        />
      </PageFrame>
    );
  }

  if (novelQuery.error) {
    return (
      <PageFrame>
        <StateView
          color="red"
          title={t("novel.loadFailed")}
          message={
            novelQuery.error instanceof Error
              ? novelQuery.error.message
              : String(novelQuery.error)
          }
        />
      </PageFrame>
    );
  }

  const novel = novelQuery.data;
  if (!novel) {
    return (
      <PageFrame>
        <StateView
          color="orange"
          title={t("novel.notFound")}
          message={t("novel.notFoundMessage", { id })}
        />
      </PageFrame>
    );
  }

  const sourceUrl = resolveNovelSourceUrl(novel);
  const sourcePlugin = novel.isLocal
    ? null
    : pluginManager.getPlugin(novel.pluginId);
  const sourceName = novel.isLocal
    ? t("common.local")
    : (novel.pluginName ?? sourcePlugin?.name ?? novel.pluginId);
  const metadataRefreshError =
    refreshMetadata.error ?? fullRefreshMetadata.error;

  return (
    <>
      <PageFrame className="lnr-novel-page" size="wide">
        <div className="lnr-novel-layout">
          <NovelWorkspace
            novel={novel}
            chapters={chapters}
            downloadStatuses={statuses}
            lastReadChapterId={lastReadChapterId}
            localChapterAdding={addLocalChapters.isPending}
            fullMetadataRefreshing={fullRefreshMetadata.isPending}
            metadataRefreshing={refreshMetadata.isPending}
            onBack={goBack}
            onAddLocalChapters={openLocalChapterInput}
            onBatchDownload={downloadChapters}
            onEditLocalMetadata={openLocalMetadataEditor}
            onOpenReaderSettings={() => setReaderSettingsOpen(true)}
            onRead={openChapter}
            onOpenSource={() => openSourceNovel(novel.pluginId, sourceUrl)}
            onRefreshFullMetadata={() => fullRefreshMetadata.mutate()}
            onRefreshMetadata={() => refreshMetadata.mutate()}
            onToggleLibrary={() => toggle.mutate()}
            sourceName={sourceName}
            sourceUrl={sourceUrl}
            toggleBusy={toggle.isPending}
          />

          <ConsolePanel className="lnr-novel-chapters-panel">
            <ConsoleSectionHeader
              actions={
                <ChapterSortPicker
                  onChange={setDefaultChapterSort}
                  value={defaultChapterSort}
                />
              }
              eyebrow={t("novel.chapterIndex")}
              title={t("novel.chapters")}
              count={t("novel.chapterCount", {
                total: chapters.length,
                cached: chapterStats.downloaded,
                unread: chapterStats.unread,
              })}
            />

            {localChapterError ? (
              <Text c="red" className="lnr-novel-local-error" size="sm">
                {localChapterError}
              </Text>
            ) : null}

            {metadataRefreshError ? (
              <Text c="red" className="lnr-novel-local-error" size="sm">
                {metadataRefreshError instanceof Error
                  ? metadataRefreshError.message
                  : String(metadataRefreshError)}
              </Text>
            ) : null}

            {chaptersQuery.isLoading ? (
              <StateView
                color="blue"
                title={t("novel.loadingChapters")}
                message={t("novel.loadingChaptersMessage")}
              />
            ) : chapters.length === 0 ? (
              <StateView
                color="blue"
                title={t("novel.noChapters")}
                message={t("novel.noChaptersMessage")}
                action={
                  novel.isLocal
                    ? {
                        icon: addLocalChapters.isPending ? (
                          <Loader size={14} />
                        ) : (
                          <PlusGlyph />
                        ),
                        label: t("novel.local.addChapters"),
                        onClick: openLocalChapterInput,
                      }
                    : undefined
                }
              />
            ) : (
              <VirtualChapterList
                chapters={chapters}
                canDeleteDownloads={!novel.isLocal}
                canReorderChapters={novel.isLocal}
                deleteBusyChapterId={clearDownload.variables}
                duplicateSourceChapterCounts={sourceDuplicateChapterCounts}
                deletePending={clearDownload.isPending}
                lastReadChapterId={lastReadChapterId}
                openingChapterId={openingChapterId}
                repairBusyChapterId={repairMedia.variables?.id}
                repairPending={repairMedia.isPending}
                reorderPending={reorderLocalChapters.isPending}
                statuses={statuses}
                onOpen={(chapter) => {
                  void openChapter(chapter);
                }}
                onDownload={downloadChapter}
                onRepairMedia={(chapter) => repairMedia.mutate(chapter)}
                onReorderChapter={reorderLocalChapter}
                onDeleteDownload={(chapterId) => {
                  if (novel.isLocal) return;
                  clearDownload.mutate(chapterId);
                }}
              />
            )}
          </ConsolePanel>
        </div>
      </PageFrame>

      <input
        ref={localChapterInputRef}
        accept={LOCAL_IMPORT_ACCEPT}
        className="lnr-novel-file-input"
        multiple
        onChange={handleLocalChapterFilesSelected}
        type="file"
      />

      <Drawer
        classNames={{
          body: "lnr-reader-settings-drawer-body",
          content: "lnr-reader-settings-drawer-content",
        }}
        opened={readerSettingsOpen}
        onClose={() => setReaderSettingsOpen(false)}
        position="right"
        size="lg"
        title={t("readerSettings.novel.title", { name: novel.name })}
      >
        <ReaderSettingsPanel
          target={{
            kind: "novel",
            novelId: novel.id,
            sourceId: novel.pluginId,
            sourceLabel: sourceName,
            label: novel.name,
          }}
        />
      </Drawer>

      <Modal
        opened={novel.isLocal && localMetadataOpen}
        onClose={closeLocalMetadataEditor}
        size="lg"
        title={t("novel.local.editMetadata")}
      >
        <form onSubmit={handleLocalMetadataSubmit}>
          <Stack gap="sm">
            <TextInput
              autoFocus
              label={t("library.localNovel.name")}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setLocalMetadataForm((current) => ({
                  ...current,
                  name: value,
                }));
              }}
              required
              value={localMetadataForm.name}
            />
            <Group grow>
              <TextInput
                label={t("library.localNovel.author")}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  setLocalMetadataForm((current) => ({
                    ...current,
                    author: value,
                  }));
                }}
                value={localMetadataForm.author ?? ""}
              />
              <TextInput
                label={t("library.localNovel.artist")}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  setLocalMetadataForm((current) => ({
                    ...current,
                    artist: value,
                  }));
                }}
                value={localMetadataForm.artist ?? ""}
              />
            </Group>
            <Group grow>
              <TextInput
                label={t("library.localNovel.status")}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  setLocalMetadataForm((current) => ({
                    ...current,
                    status: value,
                  }));
                }}
                value={localMetadataForm.status ?? ""}
              />
              <TextInput
                label={t("library.localNovel.genres")}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  setLocalMetadataForm((current) => ({
                    ...current,
                    genres: value,
                  }));
                }}
                value={localMetadataForm.genres ?? ""}
              />
            </Group>
            <LocalCoverPicker
              alt={localMetadataForm.name || t("library.localNovel.name")}
              disabled={updateLocalMetadata.isPending}
              onChange={(cover) =>
                setLocalMetadataForm((current) => ({
                  ...current,
                  cover,
                }))
              }
              value={localMetadataForm.cover}
            />
            <Textarea
              autosize
              label={t("library.localNovel.summary")}
              minRows={4}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setLocalMetadataForm((current) => ({
                  ...current,
                  summary: value,
                }));
              }}
              value={localMetadataForm.summary ?? ""}
            />
            {updateLocalMetadata.error ? (
              <Text c="red" size="sm">
                {updateLocalMetadata.error instanceof Error
                  ? updateLocalMetadata.error.message
                  : String(updateLocalMetadata.error)}
              </Text>
            ) : null}
            <Group justify="flex-end">
              <TextButton
                disabled={updateLocalMetadata.isPending}
                onClick={closeLocalMetadataEditor}
                type="button"
                variant="subtle"
              >
                {t("common.cancel")}
              </TextButton>
              <TextButton
                disabled={
                  localMetadataForm.name.trim() === "" ||
                  updateLocalMetadata.isPending
                }
                loading={updateLocalMetadata.isPending}
                type="submit"
              >
                {t("common.save")}
              </TextButton>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  );
}
