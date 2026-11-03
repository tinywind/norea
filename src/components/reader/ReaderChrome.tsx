import { Popover, Switch } from "@mantine/core";
import { useEffect, useRef, useState, type FocusEvent } from "react";
import { type ChapterListRow } from "../../db/queries/chapter";
import { useTranslation, type TranslationKey } from "../../i18n";
import {
  normalizeFontScalePercent,
  useAppearanceStore,
} from "../../store/appearance";
import { BackIconButton } from "../BackIconButton";
import { IconButton } from "../IconButton";
import {
  type ReaderSettingsContentContext,
  type ReaderSettingsPanelTarget,
} from "../ReaderSettingsPanel";
import {
  BookmarkIcon,
  ChapterListIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  OverflowIcon,
  ReaderSettingsIcon,
  RepairIcon,
} from "../ui/icons";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";
import { ReaderQuickSettings } from "./ReaderQuickSettings";

const FINISHED_PROGRESS = 100;
const READER_CHAPTER_ROW_HEIGHT = 36;

const READER_CHAPTER_PANEL_FALLBACK_ROWS = 36;

const READER_CHAPTER_PANEL_OVERSCAN = 12;

interface ReaderChromeFocusHandlers {
  onFocus: () => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
}

export function getChapterLabel(
  chapter: Pick<ChapterListRow, "chapterNumber" | "position">,
  t: (key: TranslationKey) => string,
) {
  const prefix = t("history.chapterPrefix");
  return chapter.chapterNumber
    ? `${prefix} ${chapter.chapterNumber}`
    : `${prefix} ${chapter.position}`;
}

export function ReaderTopBar({
  chapterName,
  bookmarked,
  bookmarkDisabled,
  bookmarkLoading,
  focusHandlers,
  incognitoMode,
  novelName,
  onBack,
  onIncognitoModeChange,
  onOpenSettings,
  onRepairMedia,
  onToggleBookmark,
  repairMediaDisabled,
  repairMediaLoading,
  repairMediaAttention,
  settingsOpen,
  showMediaRepair,
}: {
  chapterName: string | undefined;
  bookmarked: boolean;
  bookmarkDisabled: boolean;
  bookmarkLoading: boolean;
  focusHandlers: ReaderChromeFocusHandlers;
  incognitoMode: boolean;
  novelName?: string;
  onBack: () => void;
  onIncognitoModeChange: (incognitoMode: boolean) => void;
  onOpenSettings: () => void;
  onRepairMedia: () => void;
  onToggleBookmark: () => void;
  repairMediaDisabled: boolean;
  repairMediaLoading: boolean;
  repairMediaAttention: boolean;
  settingsOpen: boolean;
  showMediaRepair: boolean;
}) {
  const { t } = useTranslation();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const trimmedNovelName = novelName?.trim();
  const title = trimmedNovelName || chapterName || t("reader.title");
  const subtitle = trimmedNovelName ? chapterName : undefined;

  return (
    <header className="norea-reader-topbar" {...focusHandlers}>
      <BackIconButton
        className="norea-reader-icon-button norea-state-layer"
        label={t("reader.backToNovel")}
        onClick={onBack}
      />
      <div className="norea-reader-topbar-title">
        <div className="norea-reader-title" title={title}>
          {title}
        </div>
        {subtitle ? (
          <div className="norea-reader-subtitle" title={subtitle}>
            {subtitle}
          </div>
        ) : null}
      </div>
      {incognitoMode ? (
        <span className="norea-reader-status" data-status="muted">
          {t("reader.incognito")}
        </span>
      ) : null}
      {showMediaRepair ? (
        <IconButton
          className="norea-reader-icon-button norea-state-layer"
          disabled={repairMediaDisabled || repairMediaLoading}
          label={t("reader.repairMedia")}
          onClick={onRepairMedia}
          size="sm"
          tone={repairMediaAttention ? "warning" : "default"}
        >
          <RepairIcon />
        </IconButton>
      ) : null}
      <IconButton
        active={bookmarked}
        aria-pressed={bookmarked}
        className="norea-reader-icon-button norea-state-layer"
        disabled={bookmarkDisabled || bookmarkLoading}
        label={
          bookmarked ? t("reader.removeBookmark") : t("reader.bookmarkChapter")
        }
        onClick={onToggleBookmark}
        size="sm"
      >
        <BookmarkIcon />
      </IconButton>
      <IconButton
        active={settingsOpen}
        aria-expanded={settingsOpen}
        className="norea-reader-icon-button norea-state-layer"
        label={t("reader.openSettings")}
        onClick={onOpenSettings}
        size="sm"
      >
        <ReaderSettingsIcon />
      </IconButton>
      <Popover
        opened={overflowOpen}
        onChange={setOverflowOpen}
        position="bottom-end"
        shadow="md"
      >
        <Popover.Target>
          <IconButton
            aria-expanded={overflowOpen}
            className="norea-reader-icon-button norea-state-layer"
            label={t("reader.moreActions")}
            onClick={() => setOverflowOpen((current) => !current)}
            size="sm"
          >
            <OverflowIcon />
          </IconButton>
        </Popover.Target>
        <Popover.Dropdown className="norea-reader-overflow">
          <Switch
            checked={incognitoMode}
            description={t("more.pauseHistory.description")}
            label={t("more.pauseHistory")}
            labelPosition="left"
            onChange={(event) =>
              onIncognitoModeChange(event.currentTarget.checked)
            }
          />
        </Popover.Dropdown>
      </Popover>
    </header>
  );
}

export function ReaderBottomBar({
  focusHandlers,
  hasNextChapter,
  hasPreviousChapter,
  chapterListExpanded,
  onNextChapter,
  onOpenChapters,
  onOpenSettings,
  onPreviousChapter,
  seekSlotRef,
  settingsOpen,
}: {
  focusHandlers: ReaderChromeFocusHandlers;
  hasNextChapter: boolean;
  hasPreviousChapter: boolean;
  chapterListExpanded: boolean;
  onNextChapter: () => void;
  onOpenChapters: () => void;
  onOpenSettings: () => void;
  onPreviousChapter: () => void;
  seekSlotRef: (element: HTMLDivElement | null) => void;
  settingsOpen: boolean;
}) {
  const { t } = useTranslation();

  return (
    <footer className="norea-reader-bottombar" {...focusHandlers}>
      <IconButton
        className="norea-reader-icon-button norea-reader-bottombar-previous norea-state-layer"
        disabled={!hasPreviousChapter}
        label={t("reader.previousChapter")}
        onClick={onPreviousChapter}
        size="sm"
      >
        <ChevronLeftIcon />
      </IconButton>
      <div className="norea-reader-seek-slot" ref={seekSlotRef} />
      <IconButton
        className="norea-reader-icon-button norea-reader-bottombar-next norea-state-layer"
        disabled={!hasNextChapter}
        label={t("reader.nextChapter")}
        onClick={onNextChapter}
        size="sm"
      >
        <ChevronRightIcon />
      </IconButton>
      <IconButton
        active={chapterListExpanded}
        aria-expanded={chapterListExpanded}
        className="norea-reader-icon-button norea-reader-bottombar-chapters norea-state-layer"
        label={t("reader.chapters")}
        onClick={onOpenChapters}
        size="sm"
      >
        <ChapterListIcon />
      </IconButton>
      <IconButton
        active={settingsOpen}
        aria-expanded={settingsOpen}
        className="norea-reader-icon-button norea-reader-bottombar-settings norea-state-layer"
        label={t("reader.openSettings")}
        onClick={onOpenSettings}
        size="sm"
      >
        <ReaderSettingsIcon />
      </IconButton>
    </footer>
  );
}

interface ReaderSettingsSurfaceProps {
  content: ReaderSettingsContentContext;
  novelId?: number;
  novelName?: string;
  onClose: () => void;
  sourceId?: string | null;
  sourceName?: string | null;
}

function getReaderSettingsTarget({
  novelId,
  novelName,
  sourceId,
  sourceName,
}: Omit<ReaderSettingsSurfaceProps, "content" | "onClose">):
  ReaderSettingsPanelTarget {
  return novelId && novelId > 0
    ? {
        kind: "novel",
        novelId,
        sourceId,
        sourceLabel: sourceName,
        label: novelName,
      }
    : { kind: "global" };
}

/** "Aa" below 1200px: a bottom sheet on phones and a modal on tablets. */
export function ReaderSettingsSheet({
  content,
  onClose,
  opened,
  ...target
}: ReaderSettingsSurfaceProps & { opened: boolean }) {
  const { t } = useTranslation();

  return (
    <ResponsiveSheet
      className="norea-reader-quick-sheet"
      onClose={onClose}
      opened={opened}
      title={t("settings.category.reader.title")}
    >
      <ReaderQuickSettings
        content={content}
        target={getReaderSettingsTarget(target)}
      />
    </ResponsiveSheet>
  );
}

/** "Aa" from 1200px: a non-modal side panel, so the text reflows beside it. */
export function ReaderSettingsSidePanel({
  content,
  onClose,
  ...target
}: ReaderSettingsSurfaceProps) {
  const { t } = useTranslation();

  return (
    <aside
      aria-labelledby="reader-settings-panel-title"
      className="norea-reader-settings-panel"
    >
      <header className="norea-reader-settings-panel-header">
        <h2
          className="norea-reader-settings-panel-title"
          id="reader-settings-panel-title"
        >
          {t("settings.category.reader.title")}
        </h2>
        <IconButton
          className="norea-reader-icon-button norea-state-layer"
          label={t("reader.closeSettings")}
          onClick={onClose}
          size="sm"
        >
          <CloseIcon />
        </IconButton>
      </header>
      <ReaderQuickSettings
        content={content}
        target={getReaderSettingsTarget(target)}
      />
    </aside>
  );
}

function ReaderChapterList({
  chapters,
  className,
  currentChapterId,
  loading,
  onOpenChapter,
}: {
  chapters: ChapterListRow[];
  className: string;
  currentChapterId: number | undefined;
  loading: boolean;
  onOpenChapter: (chapter: ChapterListRow) => void;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrolledToCurrentRef = useRef(false);
  const fontScalePercent = useAppearanceStore(
    (state) => state.fontScalePercent,
  );
  const chapterRowHeight =
    READER_CHAPTER_ROW_HEIGHT *
    (normalizeFontScalePercent(fontScalePercent) / 100);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(
    chapterRowHeight * READER_CHAPTER_PANEL_FALLBACK_ROWS,
  );
  const currentIndex = chapters.findIndex(
    (item) => item.id === currentChapterId,
  );
  const totalHeight = chapters.length * chapterRowHeight;
  const startIndex = Math.max(
    0,
    Math.floor(scrollTop / chapterRowHeight) - READER_CHAPTER_PANEL_OVERSCAN,
  );
  const endIndex = Math.min(
    chapters.length,
    Math.ceil((scrollTop + viewportHeight) / chapterRowHeight) +
      READER_CHAPTER_PANEL_OVERSCAN,
  );
  const visibleChapters = chapters.slice(startIndex, endIndex);
  const offsetY = startIndex * chapterRowHeight;

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;

    const updateViewportHeight = () => {
      setViewportHeight(element.clientHeight);
    };

    updateViewportHeight();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(updateViewportHeight);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const element = listRef.current;
    if (!element || scrolledToCurrentRef.current || currentIndex < 0) return;
    scrolledToCurrentRef.current = true;
    const target = Math.max(
      0,
      currentIndex * chapterRowHeight -
        element.clientHeight / 2 +
        chapterRowHeight / 2,
    );
    element.scrollTop = target;
    setScrollTop(element.scrollTop);
  }, [chapterRowHeight, currentIndex]);

  return (
    <div
      className={className}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      ref={listRef}
    >
      {loading ? (
        <div className="norea-reader-panel-empty">
          {t("reader.loadingIndex")}
        </div>
      ) : chapters.length === 0 ? (
        <div className="norea-reader-panel-empty">
          {t("reader.noIndexedChapters")}
        </div>
      ) : (
        <div
          className="norea-reader-chapter-list"
          style={{
            display: "block",
            height: totalHeight,
            position: "relative",
          }}
        >
          <div
            style={{
              left: 0,
              position: "absolute",
              right: 0,
              top: offsetY,
            }}
          >
            {visibleChapters.map((item) => {
              const current = item.id === currentChapterId;
              const status =
                item.progress >= FINISHED_PROGRESS
                  ? "done"
                  : item.unread
                    ? "unread"
                    : "idle";
              return (
                <button
                  aria-current={current ? "true" : undefined}
                  className="norea-reader-chapter-row norea-state-layer"
                  data-current={current}
                  data-status={status}
                  key={item.id}
                  onClick={() => onOpenChapter(item)}
                  style={{ height: chapterRowHeight }}
                  title={item.name}
                  type="button"
                >
                  <span className="norea-reader-chapter-number">
                    {getChapterLabel(item, t)}
                  </span>
                  <span className="norea-reader-chapter-name">{item.name}</span>
                  <span className="norea-reader-chapter-dot" aria-hidden />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

interface ReaderChapterListProps {
  chapters: ChapterListRow[];
  currentChapterId: number | undefined;
  loading: boolean;
  onOpenChapter: (chapter: ChapterListRow) => void;
}

export function ReaderChapterPanel(props: ReaderChapterListProps) {
  const { t } = useTranslation();

  return (
    <aside
      className="norea-reader-chapter-panel"
      aria-label={t("reader.chapters")}
    >
      <h2 className="norea-reader-panel-kicker">{t("reader.chapters")}</h2>
      <ReaderChapterList {...props} className="norea-reader-chapter-scroll" />
    </aside>
  );
}

export function ReaderChapterSheet({
  onClose,
  opened,
  ...props
}: ReaderChapterListProps & { onClose: () => void; opened: boolean }) {
  const { t } = useTranslation();

  return (
    <ResponsiveSheet
      onClose={onClose}
      opened={opened}
      title={t("reader.chapters")}
    >
      <ReaderChapterList
        {...props}
        className="norea-reader-chapter-scroll norea-reader-chapter-scroll--sheet"
      />
    </ResponsiveSheet>
  );
}
