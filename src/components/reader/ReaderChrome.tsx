import { useEffect, useRef, useState } from "react";
import { type ChapterListRow, type ChapterRow } from "../../db/queries/chapter";
import { useTranslation, type TranslationKey } from "../../i18n";
import { ReaderSettingsGlyph, RetryGlyph } from "../ActionGlyphs";
import { BackIconButton } from "../BackIconButton";
import { IconButton } from "../IconButton";
import { ReaderSettingsPanel } from "../ReaderSettingsPanel";

const FINISHED_PROGRESS = 100;
const READER_CHAPTER_ROW_HEIGHT = 30;

const READER_CHAPTER_PANEL_FALLBACK_ROWS = 36;

const READER_CHAPTER_PANEL_OVERSCAN = 12;

export function getChapterLabel(
  chapter: Pick<ChapterListRow, "chapterNumber" | "position">,
  t: (key: TranslationKey) => string,
) {
  const prefix = t("history.chapterPrefix");
  return chapter.chapterNumber
    ? `${prefix} ${chapter.chapterNumber}`
    : `${prefix} ${chapter.position}`;
}

function getReaderTitle(
  chapter: ChapterRow | null | undefined,
  t: (key: TranslationKey) => string,
): string {
  return chapter?.name ?? t("reader.title");
}

function getReaderMeta(
  chapter: ChapterRow | null | undefined,
  chapterIndex: number,
  chapterCount: number,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (!chapter) return t("reader.sampleContent");
  const indexLabel =
    chapterIndex >= 0 && chapterCount > 0
      ? `${chapterIndex + 1} / ${chapterCount}`
      : getChapterLabel(chapter, t);
  const status = chapter.isDownloaded
    ? t("reader.offline")
    : t("reader.notDownloaded");
  return [
    t("reader.novelMeta", { id: chapter.novelId }),
    indexLabel,
    status,
  ].join(" / ");
}

export function ReaderTopChrome({
  chapter,
  chapterCount,
  chapterIndex,
  bookmarkDisabled,
  bookmarkLoading,
  incognitoMode,
  onBack,
  onOpenSettings,
  onRepairMedia,
  onToggleBookmark,
  progress,
  repairMediaDisabled,
  repairMediaLoading,
  repairMediaAttention,
  settingsOpen,
  showMediaRepair,
}: {
  chapter: ChapterRow | null | undefined;
  chapterCount: number;
  chapterIndex: number;
  bookmarkDisabled: boolean;
  bookmarkLoading: boolean;
  incognitoMode: boolean;
  onBack: () => void;
  onOpenSettings: () => void;
  onRepairMedia: () => void;
  onToggleBookmark: () => void;
  progress: number;
  repairMediaDisabled: boolean;
  repairMediaLoading: boolean;
  repairMediaAttention: boolean;
  settingsOpen: boolean;
  showMediaRepair: boolean;
}) {
  const { t } = useTranslation();

  return (
    <header className="norea-reader-topbar">
      <BackIconButton
        className="norea-reader-icon-button"
        label={t("reader.backToNovel")}
        onClick={onBack}
      />
      <div className="norea-reader-topbar-title">
        <div className="norea-reader-title" title={getReaderTitle(chapter, t)}>
          {getReaderTitle(chapter, t)}
        </div>
        <div className="norea-reader-meta">
          {getReaderMeta(chapter, chapterIndex, chapterCount, t)}
        </div>
      </div>
      <div className="norea-reader-topbar-spacer" />
      {incognitoMode ? (
        <span className="norea-reader-status" data-status="muted">
          {t("reader.incognito")}
        </span>
      ) : null}
      <span className="norea-reader-status">{Math.round(progress)}%</span>
      {showMediaRepair ? (
        <IconButton
          className="norea-reader-icon-button"
          disabled={repairMediaDisabled || repairMediaLoading}
          label={t("reader.repairMedia")}
          onClick={onRepairMedia}
          size="sm"
          tone={repairMediaAttention ? "warning" : "default"}
        >
          <RetryGlyph />
        </IconButton>
      ) : null}
      <IconButton
        active={Boolean(chapter?.bookmark)}
        className="norea-reader-icon-button"
        disabled={bookmarkDisabled || bookmarkLoading}
        label={
          chapter?.bookmark
            ? t("reader.removeBookmark")
            : t("reader.bookmarkChapter")
        }
        onClick={onToggleBookmark}
        size="sm"
      >
        <BookmarkIcon />
      </IconButton>
      <IconButton
        active={settingsOpen}
        className="norea-reader-icon-button"
        label={t("reader.openSettings")}
        onClick={onOpenSettings}
        size="sm"
      >
        <ReaderSettingsGlyph />
      </IconButton>
    </header>
  );
}

function BookmarkIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M6 4h12v16l-6-3.5L6 20V4z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </svg>
  );
}

export function ReaderSettingsOverlay({
  novelId,
  novelName,
  onClose,
  onOpenSettingsPage,
  sourceId,
  sourceName,
}: {
  novelId?: number;
  novelName?: string;
  onClose: () => void;
  onOpenSettingsPage: () => void;
  sourceId?: string | null;
  sourceName?: string | null;
}) {
  const { t } = useTranslation();
  const settingsTarget =
    novelId && novelId > 0
      ? {
          kind: "novel" as const,
          novelId,
          sourceId,
          sourceLabel: sourceName,
          label: novelName,
        }
      : { kind: "global" as const };

  return (
    <div
      className="norea-reader-settings-overlay"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
      onWheel={(event) => event.stopPropagation()}
    >
      <section
        aria-labelledby="reader-settings-overlay-title"
        className="norea-reader-settings-sheet"
        role="dialog"
      >
        <header className="norea-reader-settings-header">
          <h2
            className="norea-reader-settings-title"
            id="reader-settings-overlay-title"
          >
            {t("settings.category.reader.title")}
          </h2>
          <div className="norea-reader-settings-actions">
            <IconButton
              className="norea-reader-icon-button"
              label={t("reader.openFullSettings")}
              onClick={onOpenSettingsPage}
              size="sm"
            >
              <ReaderSettingsGlyph />
            </IconButton>
            <IconButton
              className="norea-reader-icon-button"
              label={t("reader.closeSettings")}
              onClick={onClose}
              size="sm"
            >
              <CloseIcon />
            </IconButton>
          </div>
        </header>
        <div className="norea-reader-settings-scroll">
          <ReaderSettingsPanel inlineAutomation target={settingsTarget} />
        </div>
      </section>
    </div>
  );
}

export function ReaderChapterPanel({
  chapters,
  currentChapterId,
  loading,
  onOpenChapter,
}: {
  chapters: ChapterListRow[];
  currentChapterId: number | undefined;
  loading: boolean;
  onOpenChapter: (chapter: ChapterListRow) => void;
}) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(
    READER_CHAPTER_ROW_HEIGHT * READER_CHAPTER_PANEL_FALLBACK_ROWS,
  );
  const totalHeight = chapters.length * READER_CHAPTER_ROW_HEIGHT;
  const startIndex = Math.max(
    0,
    Math.floor(scrollTop / READER_CHAPTER_ROW_HEIGHT) -
      READER_CHAPTER_PANEL_OVERSCAN,
  );
  const endIndex = Math.min(
    chapters.length,
    Math.ceil((scrollTop + viewportHeight) / READER_CHAPTER_ROW_HEIGHT) +
      READER_CHAPTER_PANEL_OVERSCAN,
  );
  const visibleChapters = chapters.slice(startIndex, endIndex);
  const offsetY = startIndex * READER_CHAPTER_ROW_HEIGHT;

  useEffect(() => {
    const element = panelRef.current;
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

  return (
    <aside
      className="norea-reader-chapter-panel"
      aria-label={t("reader.chapters")}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      ref={panelRef}
    >
      <div className="norea-reader-panel-kicker">{t("reader.chapters")}</div>
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
                  className="norea-reader-chapter-row"
                  data-current={current}
                  data-status={status}
                  key={item.id}
                  onClick={() => onOpenChapter(item)}
                  style={{ height: READER_CHAPTER_ROW_HEIGHT }}
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
    </aside>
  );
}

export function ReaderBottomStrip({
  currentLabel,
  hasNextChapter,
  hasPreviousChapter,
  nextLabel,
  onNextChapter,
  onPreviousChapter,
  previousLabel,
  progress,
}: {
  currentLabel: string;
  hasNextChapter: boolean;
  hasPreviousChapter: boolean;
  nextLabel: string;
  onNextChapter: () => void;
  onPreviousChapter: () => void;
  previousLabel: string;
  progress: number;
}) {
  const { t } = useTranslation();
  const roundedProgress = Math.round(progress);

  return (
    <footer className="norea-reader-bottom-strip">
      <button
        className="norea-reader-strip-link"
        disabled={!hasPreviousChapter}
        onClick={onPreviousChapter}
        type="button"
      >
        {previousLabel}
      </button>
      <div className="norea-reader-strip-progress">
        <div className="norea-reader-strip-current">{currentLabel}</div>
        <div
          aria-label={t("reader.progressAria", { progress: roundedProgress })}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={roundedProgress}
          className="norea-reader-progress-track"
          role="meter"
        >
          <span
            className="norea-reader-progress-bar"
            style={{ width: `${roundedProgress}%` }}
          />
        </div>
      </div>
      <button
        className="norea-reader-strip-link"
        disabled={!hasNextChapter}
        onClick={onNextChapter}
        type="button"
      >
        {nextLabel}
      </button>
    </footer>
  );
}
