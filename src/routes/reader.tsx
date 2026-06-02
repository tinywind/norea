import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Box } from "@mantine/core";
import { StateView } from "../components/AppFrame";
import {
  ReaderContent,
  type ReaderContentHandle,
} from "../components/ReaderContent";
import { PdfReaderContent } from "../components/PdfReaderContent";
import { BackIconButton } from "../components/BackIconButton";
import { IconButton } from "../components/IconButton";
import { ReaderSettingsPanel } from "../components/ReaderSettingsPanel";
import { ReaderSettingsGlyph, RetryGlyph } from "../components/ActionGlyphs";
import {
  getAdjacentChapter,
  getChapterById,
  listChaptersByNovel,
  markChapterOpened,
  setChapterBookmark,
  type ChapterListRow,
  type ChapterRow,
  updateChapterProgress,
} from "../db/queries/chapter";
import { getNovelById } from "../db/queries/novel";
import {
  hasRemoteChapterMedia,
  resolveLocalChapterMediaPatches,
  type ChapterMediaStorageContext,
  type ChapterMediaElementPatch,
} from "../lib/chapter-media";
import { isHtmlLikeChapterContentType } from "../lib/chapter-content";
import { readStoredChapterContentMirror } from "../lib/chapter-content-storage";
import {
  findPreviousAppHistoryEntry,
  trimAppNavigationHistoryTo,
} from "../lib/navigation-history";
import {
  chapterDetailQueryKey,
  chapterListQueryKey,
  invalidateReaderContentQueries,
  invalidateReaderOpenedQueries,
  invalidateReaderProgressQueries,
  novelChaptersQueryKey,
  novelDetailQueryKey,
  novelLibraryQueryKey,
} from "../lib/reader-query-invalidation";
import { pluginManager } from "../lib/plugins/manager";
import { LOCAL_PLUGIN_ID } from "../lib/plugins/types";
import {
  enqueueChapterDownload,
  enqueueChapterMediaRepair,
  subscribeChapterDownloads,
  subscribeChapterMediaPatches,
  subscribeChapterPartialContentUpdates,
} from "../lib/tasks/chapter-download";
import { markUpdatesIndexDirty } from "../lib/updates/update-index-events";
import { readerRoute } from "../router";
import { useLibraryStore } from "../store/library";
import {
  getEffectiveReaderAppearanceSettings,
  getEffectiveReaderGeneralSettings,
  useReaderStore,
} from "../store/reader";
import { useTranslation, type TranslationKey } from "../i18n";
import "../styles/reader.css";

const FINISHED_PROGRESS = 100;
const FULL_PAGE_CHROME_HIDE_DELAY_MS = 5000;
const READER_SEEKBAR_HIDE_DELAY_MS = 2000;
const READER_SEEKBAR_FADE_OUT_MS = 500;
const READER_ACTIVITY_THROTTLE_MS = 250;
const READER_FULL_MEDIA_PATCH_MAX_HTML_LENGTH = 350_000;
const READER_CHAPTER_ROW_HEIGHT = 30;
const READER_CHAPTER_PANEL_FALLBACK_ROWS = 36;
const READER_CHAPTER_PANEL_OVERSCAN = 12;

type ReaderDocumentState = {
  chapterId: number;
  contentType: ChapterRow["contentType"];
  html: string;
};

type ReaderChapterRow = ChapterRow & {
  content: string | null;
};

function shouldReadStoredReaderContent(
  chapter: Pick<ChapterRow, "contentBytes" | "isDownloaded">,
): boolean {
  return chapter.isDownloaded || chapter.contentBytes > 0;
}

const READER_RENDERABLE_MEDIA_SELECTOR =
  "img,video,audio,source,embed,track,object,iframe,link[rel~='preload']";

function hasRenderableReaderHtml(html: string): boolean {
  if (html.length > READER_FULL_MEDIA_PATCH_MAX_HTML_LENGTH) {
    return html.trim().length > 0;
  }
  if (typeof document === "undefined") return html.trim().length > 0;
  const template = document.createElement("template");
  template.innerHTML = html;
  if ((template.content.textContent ?? "").trim().length > 0) return true;
  return Boolean(
    template.content.querySelector(READER_RENDERABLE_MEDIA_SELECTOR),
  );
}

function logReaderRouteInput(event: string, details: Record<string, unknown>) {
  if (!import.meta.env.DEV) return;
  console.warn("[reader-input:route]", event, details);
}

function logReaderMediaPipeline(
  event: string,
  details: Record<string, unknown>,
) {
  console.warn("[reader-media:route]", event, details);
}

const SAMPLE_CHAPTER_HTML = `
<h1>Chapter 1 - A long road begins</h1>
<p>
  The wind carried the scent of pine and old rain across the road, and
  for a moment the boy thought he could hear the river even before he
  could see it. He paused at the crest of the hill and looked back the
  way he had come. The village was already a smudge of slate against
  the morning grey. He had not expected leaving to feel this small.
</p>
<p>
  His father had said only that the journey would not be a kind one.
  His mother, who had no patience for either drama or doubt, had
  packed his satchel with practical things: flatbread wrapped in
  oiled paper, three apples, a little sealed pot of honey, the knife
  he had been allowed to whet but not yet to keep, and three coins of
  middling worth.
</p>
<p>
  The road wound down into the valley between elms. He had been told
  they would change colour soon. He had also been told that the wolves
  this year were thin and bold. He hoped neither would inconvenience
  him before sundown.
</p>
<h2>I.</h2>
<p>
  The river crossing came at noon, exactly when his father had said
  it would. There was a stone bridge with a moss-furred handrail and
  a toll-house, and the toll-keeper was asleep against the doorpost
  with a long-stemmed pipe gone cold in his hand. The boy laid one of
  his middling coins on the windowsill and walked across without
  waking him.
</p>
`;

function getChapterLabel(
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
  return [t("reader.novelMeta", { id: chapter.novelId }), indexLabel, status].join(" / ");
}

function ReaderTopChrome({
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
    <header className="lnr-reader-topbar">
      <BackIconButton
        className="lnr-reader-icon-button"
        label={t("reader.backToNovel")}
        onClick={onBack}
      />
      <div className="lnr-reader-topbar-title">
        <div className="lnr-reader-title" title={getReaderTitle(chapter, t)}>
          {getReaderTitle(chapter, t)}
        </div>
        <div className="lnr-reader-meta">
          {getReaderMeta(chapter, chapterIndex, chapterCount, t)}
        </div>
      </div>
      <div className="lnr-reader-topbar-spacer" />
      {incognitoMode ? (
        <span className="lnr-reader-status" data-status="muted">
          {t("reader.incognito")}
        </span>
      ) : null}
      <span className="lnr-reader-status">{Math.round(progress)}%</span>
      {showMediaRepair ? (
        <IconButton
          className="lnr-reader-icon-button"
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
        className="lnr-reader-icon-button"
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
        className="lnr-reader-icon-button"
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

function ReaderSettingsOverlay({
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
      className="lnr-reader-settings-overlay"
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
        className="lnr-reader-settings-sheet"
        role="dialog"
      >
        <header className="lnr-reader-settings-header">
          <h2
            className="lnr-reader-settings-title"
            id="reader-settings-overlay-title"
          >
            {t("settings.category.reader.title")}
          </h2>
          <div className="lnr-reader-settings-actions">
            <IconButton
              className="lnr-reader-icon-button"
              label={t("reader.openFullSettings")}
              onClick={onOpenSettingsPage}
              size="sm"
            >
              <ReaderSettingsGlyph />
            </IconButton>
            <IconButton
              className="lnr-reader-icon-button"
              label={t("reader.closeSettings")}
              onClick={onClose}
              size="sm"
            >
              <CloseIcon />
            </IconButton>
          </div>
        </header>
        <div className="lnr-reader-settings-scroll">
          <ReaderSettingsPanel
            inlineAutomation
            target={settingsTarget}
          />
        </div>
      </section>
    </div>
  );
}

function ReaderChapterPanel({
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
      className="lnr-reader-chapter-panel"
      aria-label={t("reader.chapters")}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      ref={panelRef}
    >
      <div className="lnr-reader-panel-kicker">{t("reader.chapters")}</div>
      {loading ? (
        <div className="lnr-reader-panel-empty">{t("reader.loadingIndex")}</div>
      ) : chapters.length === 0 ? (
        <div className="lnr-reader-panel-empty">
          {t("reader.noIndexedChapters")}
        </div>
      ) : (
        <div
          className="lnr-reader-chapter-list"
          style={{ display: "block", height: totalHeight, position: "relative" }}
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
                  className="lnr-reader-chapter-row"
                  data-current={current}
                  data-status={status}
                  key={item.id}
                  onClick={() => onOpenChapter(item)}
                  style={{ height: READER_CHAPTER_ROW_HEIGHT }}
                  title={item.name}
                  type="button"
                >
                  <span className="lnr-reader-chapter-number">
                    {getChapterLabel(item, t)}
                  </span>
                  <span className="lnr-reader-chapter-name">{item.name}</span>
                  <span className="lnr-reader-chapter-dot" aria-hidden />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </aside>
  );
}

function ReaderBottomStrip({
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
    <footer className="lnr-reader-bottom-strip">
      <button
        className="lnr-reader-strip-link"
        disabled={!hasPreviousChapter}
        onClick={onPreviousChapter}
        type="button"
      >
        {previousLabel}
      </button>
      <div className="lnr-reader-strip-progress">
        <div className="lnr-reader-strip-current">{currentLabel}</div>
        <div
          aria-label={t("reader.progressAria", { progress: roundedProgress })}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={roundedProgress}
          className="lnr-reader-progress-track"
          role="meter"
        >
          <span
            className="lnr-reader-progress-bar"
            style={{ width: `${roundedProgress}%` }}
          />
        </div>
      </div>
      <button
        className="lnr-reader-strip-link"
        disabled={!hasNextChapter}
        onClick={onNextChapter}
        type="button"
      >
        {nextLabel}
      </button>
    </footer>
  );
}

export function ReaderPage() {
  const { t } = useTranslation();
  const { chapterId } = readerRoute.useSearch();
  const navigate = useNavigate();
  const currentHref = useRouterState({
    select: (state) => state.location.href,
  });
  const queryClient = useQueryClient();
  const contentRef = useRef<ReaderContentHandle | null>(null);
  const pendingMediaPatchesRef = useRef<
    Map<number, ChapterMediaElementPatch[]>
  >(new Map());
  const openedChapterRef = useRef<number | null>(null);
  const openRequestRef = useRef(0);
  const autoDownloadingChapterRef = useRef<number | null>(null);
  const chromeHideTimerRef = useRef<number | null>(null);
  const readerSeekbarHideTimerRef = useRef<number | null>(null);
  const readerSeekbarFadeTimerRef = useRef<number | null>(null);
  const readerSeekbarEnabledRef = useRef(false);
  const readerSeekbarPinnedByChromeRef = useRef(false);
  const readerSeekbarActiveRef = useRef(false);
  const lastReaderActivityAtRef = useRef(-READER_ACTIVITY_THROTTLE_MS);
  const readerWriteQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const [fullPageChromeVisible, setFullPageChromeVisible] = useState(false);
  const [readerSeekbarActivityVisible, setReaderSeekbarActivityVisible] =
    useState(false);
  const [readerSeekbarRenderMounted, setReaderSeekbarRenderMounted] =
    useState(false);
  const [readerSettingsOpen, setReaderSettingsOpen] = useState(false);
  const [autoDownloadingChapterId, setAutoDownloadingChapterId] = useState<
    number | null
  >(null);
  const [readerDocument, setReaderDocument] =
    useState<ReaderDocumentState | null>(null);
  const [initialProgressOverride, setInitialProgressOverride] = useState<{
    chapterId: number;
    progress: number;
  } | null>(null);
  const [remoteMediaError, setRemoteMediaError] = useState(false);

  const chapterQuery = useQuery({
    queryKey: chapterDetailQueryKey(chapterId),
    queryFn: async () => {
      const chapter = await getChapterById(chapterId);
      if (!chapter) return null;
      const content = shouldReadStoredReaderContent(chapter)
        ? await readStoredChapterContentMirror(chapter.id)
        : null;
      return { ...chapter, content } satisfies ReaderChapterRow;
    },
    enabled: chapterId > 0,
  });
  const rawChapter = chapterQuery.data;
  const chapter = rawChapter?.id === chapterId ? rawChapter : undefined;
  const currentNovelId = chapter?.novelId ?? 0;
  const currentNovelQuery = useQuery({
    queryKey: novelDetailQueryKey(currentNovelId),
    queryFn: () => getNovelById(currentNovelId),
    enabled: currentNovelId > 0,
  });
  const currentNovel = currentNovelQuery.data ?? null;
  const currentSourceId = currentNovel?.pluginId ?? null;
  const currentSourceName = useMemo(
    () =>
      currentSourceId
        ? (pluginManager.getPlugin(currentSourceId)?.name ?? currentSourceId)
        : null,
    [currentSourceId],
  );

  useEffect(() => {
    if (!chapter || !isHtmlLikeChapterContentType(chapter.contentType)) return;
    const unsubscribe = subscribeChapterPartialContentUpdates((event) => {
      if (event.chapterId !== chapter.id) return;
      logReaderMediaPipeline("partial-html", {
        chapterId: chapter.id,
        htmlLength: event.html.length,
      });
      setReaderDocument((current) =>
        current?.chapterId === chapter.id
          ? current
          : {
              chapterId: chapter.id,
              contentType: chapter.contentType,
              html: event.html,
            },
      );
    });

    return unsubscribe;
  }, [chapter?.contentType, chapter?.id]);

  useEffect(() => {
    if (!chapter || !isHtmlLikeChapterContentType(chapter.contentType)) return;
    let cancelled = false;
    const unsubscribe = subscribeChapterMediaPatches((event) => {
      if (event.chapterId !== chapter.id) return;
      void (async () => {
        logReaderMediaPipeline("media-patch-raw", {
          chapterId: chapter.id,
          patchCount: event.patches.length,
          firstIndexes: event.patches.slice(0, 8).map((patch) => patch.index),
        });
        const patches = await resolveLocalChapterMediaPatches(event.patches, {
          chapterId: chapter.id,
          chapterName: chapter.name,
          chapterNumber: chapter.chapterNumber,
          chapterPosition: chapter.position,
          novelId: currentNovel?.id ?? chapter.novelId,
          novelName: currentNovel?.name,
          novelPath: currentNovel?.path,
          sourceId: currentNovel?.pluginId,
        });
        logReaderMediaPipeline("media-patch-resolved", {
          chapterId: chapter.id,
          patchCount: patches.length,
          firstIndexes: patches.slice(0, 8).map((patch) => patch.index),
          hasDataUrl: patches.some((patch) =>
            Object.values(patch.attributes).some((value) =>
              value.startsWith("data:"),
            ),
          ),
          hasBlank: patches.some((patch) =>
            Object.values(patch.attributes).some((value) => value === ""),
          ),
        });
        if (cancelled) return;
        const content =
          readerDocument?.chapterId === chapter.id ? contentRef.current : null;
        if (content) {
          content.patchMediaElements(patches);
          return;
        }
        const pending = pendingMediaPatchesRef.current.get(chapter.id) ?? [];
        pendingMediaPatchesRef.current.set(chapter.id, [
          ...pending,
          ...patches,
        ]);
        window.requestAnimationFrame(() => {
          const queued = pendingMediaPatchesRef.current.get(chapter.id);
          const nextContent = contentRef.current;
          if (!queued?.length || !nextContent) return;
          pendingMediaPatchesRef.current.delete(chapter.id);
          nextContent.patchMediaElements(queued);
        });
      })();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    chapter?.chapterNumber,
    chapter?.contentType,
    chapter?.id,
    chapter?.name,
    chapter?.novelId,
    chapter?.position,
    currentNovel?.id,
    currentNovel?.name,
    currentNovel?.path,
    currentNovel?.pluginId,
    readerDocument?.chapterId,
  ]);

  useEffect(() => {
    if (chapterId <= 0) return;
    return subscribeChapterDownloads((event) => {
      if (event.job.id !== chapterId) return;
      if (event.status.kind === "done") {
        void queryClient.invalidateQueries({
          queryKey: chapterDetailQueryKey(chapterId),
        });
        if (event.job.novelId) {
          void queryClient.invalidateQueries({
            queryKey: chapterListQueryKey(event.job.novelId),
          });
          void queryClient.invalidateQueries({
            queryKey: novelChaptersQueryKey(event.job.novelId),
          });
        }
      }
    });
  }, [chapterId, queryClient]);

  const incognitoMode = useLibraryStore((state) => state.incognitoMode);
  const globalReaderGeneral = useReaderStore((state) => state.general);
  const globalReaderAppearance = useReaderStore((state) => state.appearance);
  const sourceReaderSettingsOverride = useReaderStore((state) =>
    currentSourceId ? state.readerSettingsBySource[currentSourceId] : undefined,
  );
  const novelReaderSettingsOverride = useReaderStore((state) =>
    currentNovelId > 0
      ? state.readerSettingsByNovel[currentNovelId]
      : undefined,
  );
  const effectiveReaderGeneral = useMemo(
    () =>
      getEffectiveReaderGeneralSettings(
        globalReaderGeneral,
        sourceReaderSettingsOverride,
        novelReaderSettingsOverride,
      ),
    [
      globalReaderGeneral,
      sourceReaderSettingsOverride,
      novelReaderSettingsOverride,
    ],
  );
  const effectiveReaderAppearance = useMemo(
    () =>
      getEffectiveReaderAppearanceSettings(
        globalReaderAppearance,
        sourceReaderSettingsOverride,
        novelReaderSettingsOverride,
      ),
    [
      globalReaderAppearance,
      sourceReaderSettingsOverride,
      novelReaderSettingsOverride,
    ],
  );
  const fullPageReader = effectiveReaderGeneral.fullPageReader;
  const setFullPageReaderActive = useReaderStore(
    (state) => state.setFullPageReaderActive,
  );
  const setFullPageReaderChromeVisible = useReaderStore(
    (state) => state.setFullPageReaderChromeVisible,
  );
  const setLastReadChapter = useReaderStore(
    (state) => state.setLastReadChapter,
  );
  const setNovelPageIndex = useReaderStore((state) => state.setNovelPageIndex);

  const clearFullPageChromeTimer = useCallback(() => {
    if (chromeHideTimerRef.current !== null) {
      window.clearTimeout(chromeHideTimerRef.current);
      chromeHideTimerRef.current = null;
    }
  }, []);

  const scheduleFullPageChromeHide = useCallback(() => {
    if (!fullPageReader) return;
    clearFullPageChromeTimer();
    chromeHideTimerRef.current = window.setTimeout(() => {
      setFullPageChromeVisible(false);
      chromeHideTimerRef.current = null;
    }, FULL_PAGE_CHROME_HIDE_DELAY_MS);
  }, [clearFullPageChromeTimer, fullPageReader]);

  const clearReaderSeekbarHideTimer = useCallback(() => {
    if (readerSeekbarHideTimerRef.current !== null) {
      window.clearTimeout(readerSeekbarHideTimerRef.current);
      readerSeekbarHideTimerRef.current = null;
    }
  }, []);

  const clearReaderSeekbarFadeTimer = useCallback(() => {
    if (readerSeekbarFadeTimerRef.current !== null) {
      window.clearTimeout(readerSeekbarFadeTimerRef.current);
      readerSeekbarFadeTimerRef.current = null;
    }
  }, []);

  const fadeOutReaderSeekbar = useCallback(() => {
    clearReaderSeekbarFadeTimer();
    setReaderSeekbarActivityVisible(false);
    readerSeekbarFadeTimerRef.current = window.setTimeout(() => {
      readerSeekbarFadeTimerRef.current = null;
      if (
        !readerSeekbarEnabledRef.current ||
        (!readerSeekbarActiveRef.current &&
          !readerSeekbarPinnedByChromeRef.current)
      ) {
        setReaderSeekbarRenderMounted(false);
      }
    }, READER_SEEKBAR_FADE_OUT_MS);
  }, [clearReaderSeekbarFadeTimer]);

  const scheduleReaderSeekbarHide = useCallback(() => {
    clearReaderSeekbarHideTimer();
    readerSeekbarHideTimerRef.current = window.setTimeout(() => {
      readerSeekbarHideTimerRef.current = null;
      if (
        readerSeekbarActiveRef.current ||
        readerSeekbarPinnedByChromeRef.current
      ) {
        return;
      }
      fadeOutReaderSeekbar();
    }, READER_SEEKBAR_HIDE_DELAY_MS);
  }, [clearReaderSeekbarHideTimer, fadeOutReaderSeekbar]);

  const showReaderSeekbarForActivity = useCallback(() => {
    if (!readerSeekbarEnabledRef.current) return;
    clearReaderSeekbarFadeTimer();
    setReaderSeekbarRenderMounted(true);
    setReaderSeekbarActivityVisible(true);
    if (readerSeekbarPinnedByChromeRef.current) {
      clearReaderSeekbarHideTimer();
      return;
    }
    scheduleReaderSeekbarHide();
  }, [
    clearReaderSeekbarFadeTimer,
    clearReaderSeekbarHideTimer,
    scheduleReaderSeekbarHide,
  ]);

  const handleFullPageActivity = useCallback(() => {
    if (fullPageReader && fullPageChromeVisible) {
      scheduleFullPageChromeHide();
    }
  }, [fullPageChromeVisible, fullPageReader, scheduleFullPageChromeHide]);

  const handleReaderActivity = useCallback(() => {
    lastReaderActivityAtRef.current = performance.now();
    handleFullPageActivity();
  }, [handleFullPageActivity]);

  const handleFrequentReaderActivity = useCallback(() => {
    const now = performance.now();
    if (now - lastReaderActivityAtRef.current < READER_ACTIVITY_THROTTLE_MS) {
      return;
    }
    handleReaderActivity();
  }, [handleReaderActivity]);

  const handleReaderSeekbarActiveChange = useCallback(
    (active: boolean) => {
      readerSeekbarActiveRef.current = active;
      if (active) {
        clearReaderSeekbarFadeTimer();
        clearReaderSeekbarHideTimer();
        setReaderSeekbarRenderMounted(true);
        setReaderSeekbarActivityVisible(true);
        return;
      }
      showReaderSeekbarForActivity();
    },
    [
      clearReaderSeekbarFadeTimer,
      clearReaderSeekbarHideTimer,
      showReaderSeekbarForActivity,
    ],
  );

  const handleReaderMenuTap = useCallback(() => {
    showReaderSeekbarForActivity();
    if (!fullPageReader) return;
    if (fullPageChromeVisible) {
      clearFullPageChromeTimer();
      setFullPageChromeVisible(false);
      return;
    }
    setFullPageChromeVisible(true);
    scheduleFullPageChromeHide();
  }, [
    clearFullPageChromeTimer,
    fullPageChromeVisible,
    fullPageReader,
    scheduleFullPageChromeHide,
    showReaderSeekbarForActivity,
  ]);

  const openReaderSettingsPanel = useCallback(() => {
    clearFullPageChromeTimer();
    setFullPageChromeVisible(true);
    setReaderSettingsOpen(true);
  }, [clearFullPageChromeTimer]);

  const closeReaderSettingsPanel = useCallback(() => {
    setReaderSettingsOpen(false);
  }, []);

  const openReaderSettingsPage = useCallback(() => {
    void navigate({ to: "/settings", search: { section: "reader" } });
  }, [navigate]);

  useEffect(() => {
    clearFullPageChromeTimer();
    setFullPageChromeVisible(false);
    return clearFullPageChromeTimer;
  }, [chapterId, clearFullPageChromeTimer, fullPageReader]);

  const enqueueReaderWrite = useCallback(<T,>(write: () => Promise<T>) => {
    const run = readerWriteQueueRef.current
      .catch(() => undefined)
      .then(write);
    readerWriteQueueRef.current = run.catch(() => undefined);
    return run;
  }, []);

  const chapterListQuery = useQuery({
    queryKey: chapterListQueryKey(currentNovelId),
    queryFn: () => listChaptersByNovel(currentNovelId),
    enabled: currentNovelId > 0,
  });
  const progressMutation = useMutation({
    mutationFn: (progress: number) =>
      enqueueReaderWrite(() =>
        updateChapterProgress(chapterId, progress, {
          recordHistory: !incognitoMode,
        }),
      ),
    onMutate: (progress) => {
      const applyProgress = <T extends ChapterListRow>(chapter: T): T => ({
        ...chapter,
        progress,
        unread: progress >= FINISHED_PROGRESS ? false : chapter.unread,
        readAt:
          incognitoMode || progress <= 0
            ? chapter.readAt
            : Math.floor(Date.now() / 1000),
      });
      queryClient.setQueryData<Awaited<ReturnType<typeof getChapterById>>>(
        chapterDetailQueryKey(chapterId),
        (chapter) => (chapter ? applyProgress(chapter) : chapter),
      );
      if (currentNovelId > 0) {
        const updateChapterList = (chapters: ChapterListRow[] | undefined) =>
          chapters?.map((chapter) =>
            chapter.id === chapterId ? applyProgress(chapter) : chapter,
          );
        queryClient.setQueryData<ChapterListRow[]>(
          chapterListQueryKey(currentNovelId),
          updateChapterList,
        );
        queryClient.setQueryData<ChapterListRow[]>(
          novelChaptersQueryKey(currentNovelId),
          updateChapterList,
        );
      }
    },
    onSuccess: (_result, progress) => {
      void invalidateReaderProgressQueries(queryClient, {
        novelId: currentNovelId,
        progress,
        recordHistory: !incognitoMode,
      });
      if (progress >= FINISHED_PROGRESS) {
        markUpdatesIndexDirty("read-progress");
      }
    },
  });
  const progressMutateRef = useRef(progressMutation.mutate);

  useEffect(() => {
    progressMutateRef.current = progressMutation.mutate;
  }, [progressMutation.mutate]);

  const bookmarkMutation = useMutation({
    mutationFn: async () => {
      if (!chapter) return;
      await setChapterBookmark(chapter.id, !chapter.bookmark);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: chapterDetailQueryKey(chapterId),
      });
    },
  });

  const repairMediaMutation = useMutation({
    mutationFn: async () => {
      if (!chapter || !currentNovel) return;
      await enqueueChapterMediaRepair({
        id: chapter.id,
        pluginId: currentNovel.pluginId,
        pluginName: currentSourceName ?? currentNovel.pluginId,
        priority: "user",
        title: t("tasks.task.repairChapterMedia", { name: chapter.name }),
      }).promise;
    },
    onSuccess: () => {
      setRemoteMediaError(false);
      void invalidateReaderContentQueries(queryClient, {
        chapterId,
        includeDownloadCache: true,
        novelId: currentNovelId,
      });
    },
  });

  const openChapter = useCallback(
    (
      targetChapter: ChapterListRow,
      options?: { initialProgress?: number },
    ) => {
      if (options?.initialProgress !== undefined) {
        setInitialProgressOverride({
          chapterId: targetChapter.id,
          progress: options.initialProgress,
        });
      } else if (targetChapter.id !== chapterId) {
        setInitialProgressOverride(null);
      }

      if (
        targetChapter.id === chapterId &&
        (targetChapter.isDownloaded ||
          autoDownloadingChapterRef.current === targetChapter.id)
      ) {
        return;
      }
      const requestId = openRequestRef.current + 1;
      openRequestRef.current = requestId;
      if (targetChapter.id !== chapterId) {
        openedChapterRef.current = null;
        void navigate({
          to: "/reader",
          search: { chapterId: targetChapter.id },
          replace: true,
        });
      }

      if (targetChapter.isDownloaded) {
        return;
      }

      autoDownloadingChapterRef.current = targetChapter.id;
      setAutoDownloadingChapterId(targetChapter.id);
      void (async () => {
        try {
          const novel = await queryClient.fetchQuery({
            queryKey: novelDetailQueryKey(targetChapter.novelId),
            queryFn: () => getNovelById(targetChapter.novelId),
          });
          if (!novel) return;

          await enqueueChapterDownload({
            id: targetChapter.id,
            pluginId: novel.pluginId,
            chapterPath: targetChapter.path,
            chapterName: targetChapter.name,
            chapterNumber: targetChapter.chapterNumber ?? undefined,
            contentType: targetChapter.contentType,
            novelId: novel.id,
            novelName: novel.name,
            novelPath: novel.path,
            priority: "interactive",
            title: t("tasks.task.downloadChapter", { name: targetChapter.name }),
          }).promise;
          if (openRequestRef.current !== requestId) return;
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: chapterDetailQueryKey(targetChapter.id),
            }),
            queryClient.invalidateQueries({
              queryKey: chapterListQueryKey(targetChapter.novelId),
            }),
            queryClient.invalidateQueries({
              queryKey: novelChaptersQueryKey(targetChapter.novelId),
            }),
          ]);
          void queryClient.invalidateQueries({ queryKey: novelLibraryQueryKey });
        } catch {
          // The reader stays open and continues showing any partial content.
        } finally {
          if (autoDownloadingChapterRef.current === targetChapter.id) {
            autoDownloadingChapterRef.current = null;
          }
          setAutoDownloadingChapterId((current) =>
            current === targetChapter.id ? null : current,
          );
        }
      })();
    },
    [chapterId, navigate, queryClient, t],
  );

  useEffect(() => {
    if (!chapter || chapter.isDownloaded) return;
    if (autoDownloadingChapterRef.current === chapter.id) return;

    void openChapter(chapter);
  }, [chapter, openChapter]);

  const openAdjacent = useCallback(
    async (direction: 1 | -1) => {
      if (!chapter?.novelId || chapter.position === undefined) return;
      const adjacent = await getAdjacentChapter(
        chapter.novelId,
        chapter.position,
        direction,
      );
      if (!adjacent) return;
      if (direction === 1) {
        contentRef.current?.completeIfAtEnd();
      }
      openChapter(
        adjacent,
        direction === 1 ? { initialProgress: 0 } : undefined,
      );
    },
    [chapter?.novelId, chapter?.position, openChapter],
  );

  const handleReaderBack = useCallback(() => {
    const target = findPreviousAppHistoryEntry(currentHref, ["/reader"]);
    if (target) {
      trimAppNavigationHistoryTo(target);
      window.history.go(-target.steps);
      return;
    }

    const novelId = chapter?.novelId;
    if (novelId) {
      void navigate({ to: "/novel", search: { id: novelId }, replace: true });
      return;
    }
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [chapter?.novelId, currentHref, navigate]);

  useEffect(() => {
    window.addEventListener("norea:android-back", handleReaderBack);
    return () => {
      window.removeEventListener("norea:android-back", handleReaderBack);
    };
  }, [handleReaderBack]);

  useEffect(() => {
    const novelId = chapter?.novelId;
    if (!novelId) return;

    const handleReaderPopState = () => {
      window.setTimeout(() => {
        if (window.location.pathname !== "/reader") return;

        const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        const target = findPreviousAppHistoryEntry(currentHref, ["/reader"]);
        if (target) {
          trimAppNavigationHistoryTo(target);
          window.history.go(-target.steps);
          return;
        }

        void navigate({ to: "/novel", search: { id: novelId }, replace: true });
      }, 0);
    };

    window.addEventListener("popstate", handleReaderPopState);
    return () => {
      window.removeEventListener("popstate", handleReaderPopState);
    };
  }, [chapter?.novelId, navigate]);

  const readerBusy =
    autoDownloadingChapterId === chapter?.id && !chapter?.isDownloaded;

  useEffect(() => {
    if (
      !chapter ||
      !chapter.isDownloaded ||
      openedChapterRef.current === chapter.id
    ) {
      return;
    }
    openedChapterRef.current = chapter.id;
    setLastReadChapter(chapter.novelId, chapter.id);
    if (!incognitoMode) {
      void enqueueReaderWrite(() => markChapterOpened(chapter.id)).then(() => {
        void invalidateReaderOpenedQueries(queryClient, {
          novelId: chapter.novelId,
        });
      });
    }
  }, [
    chapter,
    enqueueReaderWrite,
    incognitoMode,
    queryClient,
    setLastReadChapter,
  ]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (readerSettingsOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeReaderSettingsPanel();
        }
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "BUTTON" ||
          target.tagName === "A" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          handleReaderActivity();
          handleReaderBack();
          break;
        case "PageDown":
        case "ArrowDown":
        case " ":
        case "ArrowRight":
          event.preventDefault();
          handleReaderActivity();
          logReaderRouteInput("key-page-step", {
            key: event.key,
            direction: 1,
            hasContentRef: Boolean(contentRef.current),
          });
          contentRef.current?.scrollByPage(1, `key-${event.key}`);
          break;
        case "PageUp":
        case "ArrowUp":
        case "ArrowLeft":
          event.preventDefault();
          handleReaderActivity();
          logReaderRouteInput("key-page-step", {
            key: event.key,
            direction: -1,
            hasContentRef: Boolean(contentRef.current),
          });
          contentRef.current?.scrollByPage(-1, `key-${event.key}`);
          break;
        case "Home":
          event.preventDefault();
          handleReaderActivity();
          contentRef.current?.scrollToStart();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [
    closeReaderSettingsPanel,
    handleReaderActivity,
    handleReaderBack,
    readerSettingsOpen,
  ]);

  const chapters = chapterListQuery.data ?? [];
  const chapterIndex = chapter
    ? chapters.findIndex((item) => item.id === chapter.id)
    : -1;
  const previousChapter =
    chapterIndex > 0 ? chapters[chapterIndex - 1] : undefined;
  const nextChapter =
    chapterIndex >= 0 && chapterIndex < chapters.length - 1
      ? chapters[chapterIndex + 1]
      : undefined;
  const chapterContentHtml = chapter?.content ?? null;

  useEffect(() => {
    if (!chapter || !chapterContentHtml) {
      setReaderDocument((current) =>
        current?.chapterId === chapterId ? current : null,
      );
      return;
    }
    setReaderDocument((current) => {
      const htmlLikeContent = isHtmlLikeChapterContentType(chapter.contentType);
      if (htmlLikeContent && !hasRenderableReaderHtml(chapterContentHtml)) {
        return current?.chapterId === chapter.id ? current : null;
      }
      if (
        htmlLikeContent &&
        current?.chapterId === chapter.id &&
        !chapter.isDownloaded
      ) {
        return current;
      }
      if (!current || current.chapterId !== chapter.id) {
        return {
          chapterId: chapter.id,
          contentType: chapter.contentType,
          html: chapterContentHtml,
        };
      }
      if (htmlLikeContent && !chapter.isDownloaded) {
        return current;
      }
      if (
        current.contentType === chapter.contentType &&
        current.html === chapterContentHtml
      ) {
        return current;
      }
      return {
        chapterId: chapter.id,
        contentType: chapter.contentType,
        html: chapterContentHtml,
      };
    });
  }, [
    chapter?.id,
    chapter?.contentType,
    chapter?.isDownloaded,
    chapterContentHtml,
    chapterId,
  ]);

  const activeReaderDocument =
    readerDocument && readerDocument.chapterId === chapterId
      ? readerDocument
      : null;
  const activeReaderHtml =
    activeReaderDocument
      ? activeReaderDocument.html
      : chapterContentHtml;
  const activeContentType =
    chapter?.contentType ?? activeReaderDocument?.contentType;
  const activeChapterId = chapter?.id ?? activeReaderDocument?.chapterId;
  const readerContentKey =
    chapterId > 0 ? chapterId : (activeChapterId ?? "sample");
  const readerLocalMediaContext = useMemo<
    ChapterMediaStorageContext | undefined
  >(
    () =>
      chapter && currentNovel
        ? {
            chapterId: chapter.id,
            chapterName: chapter.name,
            chapterNumber: chapter.chapterNumber,
            chapterPosition: chapter.position,
            novelId: currentNovel.id,
            novelName: currentNovel.name,
            novelPath: currentNovel.path,
            sourceId: currentNovel.pluginId,
          }
        : undefined,
    [
      chapter?.chapterNumber,
      chapter?.id,
      chapter?.name,
      chapter?.novelId,
      chapter?.position,
      currentNovel?.id,
      currentNovel?.name,
      currentNovel?.path,
      currentNovel?.pluginId,
    ],
  );
  useEffect(() => {
    setRemoteMediaError(false);
  }, [activeChapterId]);
  const showMediaRepair = useMemo(
    () =>
      Boolean(
        chapter?.isDownloaded &&
          currentNovel?.pluginId !== LOCAL_PLUGIN_ID &&
          activeContentType &&
          isHtmlLikeChapterContentType(activeContentType) &&
          (chapter.mediaRepairNeeded ||
            remoteMediaError ||
            (activeReaderHtml &&
              activeReaderHtml.length <=
                READER_FULL_MEDIA_PATCH_MAX_HTML_LENGTH &&
              hasRemoteChapterMedia(activeReaderHtml, "https://norea.invalid/"))),
      ),
    [
      activeContentType,
      activeReaderHtml,
      chapter?.isDownloaded,
      chapter?.mediaRepairNeeded,
      currentNovel?.pluginId,
      remoteMediaError,
    ],
  );

  useEffect(() => {
    if (!activeReaderDocument) return;
    const patches = pendingMediaPatchesRef.current.get(
      activeReaderDocument.chapterId,
    );
    if (!patches?.length) return;
    pendingMediaPatchesRef.current.delete(activeReaderDocument.chapterId);
    window.requestAnimationFrame(() => {
      contentRef.current?.patchMediaElements(patches);
    });
  }, [activeReaderDocument?.chapterId, activeReaderDocument?.html]);

  const hasChapterContent = Boolean(activeReaderHtml);
  const content = activeReaderHtml ?? SAMPLE_CHAPTER_HTML;
  const isPdfChapter = hasChapterContent && activeContentType === "pdf";
  const progress = chapter?.progress ?? 0;
  const activeInitialProgressOverride =
    initialProgressOverride &&
    initialProgressOverride.chapterId === activeChapterId
      ? initialProgressOverride.progress
      : null;
  const readerProgress = activeInitialProgressOverride ?? progress;
  const chapterNovelId = chapter?.novelId;
  const readerStateVisible =
    chapterId > 0 &&
    !hasChapterContent &&
    (chapterQuery.isLoading ||
      Boolean(chapterQuery.error) ||
      chapterQuery.data === null ||
      Boolean(chapter));
  const readerChromeAutoHide = fullPageReader && !readerStateVisible;
  const readerChromeVisible = !readerChromeAutoHide || fullPageChromeVisible;
  const readerSeekbarEnabled =
    effectiveReaderGeneral.showSeekbar && !readerStateVisible;
  const readerSeekbarPinnedByChrome =
    readerSeekbarEnabled && readerChromeAutoHide && readerChromeVisible;
  const readerSeekbarVisible =
    readerSeekbarEnabled &&
    (readerSeekbarActivityVisible || readerSeekbarPinnedByChrome);
  const readerSeekbarMounted =
    readerSeekbarEnabled &&
    (readerSeekbarRenderMounted || readerSeekbarVisible);
  useEffect(() => {
    if (
      !chapter ||
      chapter.isDownloaded ||
      hasChapterContent ||
      autoDownloadingChapterId !== chapter.id
    ) {
      return;
    }

    const interval = window.setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: chapterDetailQueryKey(chapter.id),
      });
    }, 1_000);

    return () => window.clearInterval(interval);
  }, [
    autoDownloadingChapterId,
    chapter?.id,
    chapter?.isDownloaded,
    hasChapterContent,
    queryClient,
  ]);
  const readerContentGeneral = useMemo(
    () =>
      effectiveReaderGeneral.showSeekbar === readerSeekbarMounted
        ? effectiveReaderGeneral
        : {
            ...effectiveReaderGeneral,
            showSeekbar: readerSeekbarMounted,
          },
    [effectiveReaderGeneral, readerSeekbarMounted],
  );
  const readerOverlayBottom = fullPageReader
    ? "calc(var(--lnr-safe-area-bottom) + 0.5rem)"
    : "calc(var(--lnr-app-bottom-inset) + 2rem)";
  const sharedFullPageReaderChromeVisible =
    fullPageReader && readerChromeVisible;
  const handleRemoteMediaError = useCallback(() => {
    setRemoteMediaError(true);
  }, []);

  useEffect(() => {
    readerSeekbarEnabledRef.current = readerSeekbarEnabled;
    readerSeekbarPinnedByChromeRef.current = readerSeekbarPinnedByChrome;
    if (!readerSeekbarEnabled) {
      clearReaderSeekbarHideTimer();
      clearReaderSeekbarFadeTimer();
      readerSeekbarActiveRef.current = false;
      setReaderSeekbarActivityVisible(false);
      setReaderSeekbarRenderMounted(false);
      return;
    }
    if (readerSeekbarPinnedByChrome) {
      clearReaderSeekbarHideTimer();
      clearReaderSeekbarFadeTimer();
      setReaderSeekbarRenderMounted(true);
      setReaderSeekbarActivityVisible(true);
      return;
    }
    if (readerSeekbarActivityVisible) {
      scheduleReaderSeekbarHide();
    }
  }, [
    clearReaderSeekbarFadeTimer,
    clearReaderSeekbarHideTimer,
    readerSeekbarActivityVisible,
    readerSeekbarEnabled,
    readerSeekbarPinnedByChrome,
    scheduleReaderSeekbarHide,
  ]);

  useEffect(() => {
    if (!readerSeekbarEnabled) {
      return;
    }
    clearReaderSeekbarFadeTimer();
    setReaderSeekbarRenderMounted(true);
    setReaderSeekbarActivityVisible(true);
    if (readerSeekbarPinnedByChromeRef.current) {
      clearReaderSeekbarHideTimer();
      return;
    }
    scheduleReaderSeekbarHide();
  }, [
    chapterId,
    clearReaderSeekbarFadeTimer,
    clearReaderSeekbarHideTimer,
    readerSeekbarEnabled,
    scheduleReaderSeekbarHide,
  ]);

  useEffect(
    () => () => {
      clearReaderSeekbarHideTimer();
      clearReaderSeekbarFadeTimer();
    },
    [clearReaderSeekbarFadeTimer, clearReaderSeekbarHideTimer],
  );

  useEffect(() => {
    setFullPageReaderChromeVisible(sharedFullPageReaderChromeVisible);
  }, [
    setFullPageReaderChromeVisible,
    sharedFullPageReaderChromeVisible,
  ]);

  useEffect(() => {
    setFullPageReaderActive(fullPageReader);
    return () => setFullPageReaderActive(false);
  }, [fullPageReader, setFullPageReaderActive]);

  useEffect(
    () => () => {
      setFullPageReaderChromeVisible(false);
    },
    [setFullPageReaderChromeVisible],
  );

  const handleProgressChange = useCallback(
    (nextProgress: number) => {
      if (chapterId > 0) {
        setInitialProgressOverride((current) =>
          current?.chapterId === chapterId
            ? { ...current, progress: nextProgress }
            : current,
        );
        progressMutateRef.current(nextProgress);
      }
    },
    [chapterId],
  );
  const handlePageIndexChange = useCallback(
    (pageIndex: number) => {
      if (chapterNovelId) setNovelPageIndex(chapterNovelId, pageIndex);
    },
    [chapterNovelId, setNovelPageIndex],
  );
  const handleBoundaryPage = useCallback(
    (direction: 1 | -1) => {
      void openAdjacent(direction);
    },
    [openAdjacent],
  );

  const readerContent =
    chapterId > 0 && !hasChapterContent && chapterQuery.isLoading ? (
      <Box className="lnr-reader-state-frame">
        <StateView
          color="blue"
          title={t("reader.loadingChapter")}
          message={t("reader.loadingContent")}
        />
      </Box>
    ) : chapterId > 0 && !hasChapterContent && chapterQuery.error ? (
      <Box className="lnr-reader-state-frame">
        <StateView
          color="red"
          title={t("reader.loadFailed")}
          message={
            chapterQuery.error instanceof Error
              ? chapterQuery.error.message
              : String(chapterQuery.error)
          }
        />
      </Box>
    ) : chapterId > 0 && !hasChapterContent && chapterQuery.data === null ? (
      <Box className="lnr-reader-state-frame">
        <StateView
          color="orange"
          title={t("reader.chapterNotFound")}
          message={t("reader.chapterNotFoundMessage", { id: chapterId })}
        />
      </Box>
    ) : chapterId > 0 && chapter && !hasChapterContent ? (
      <Box className="lnr-reader-state-frame">
        <StateView
          color="blue"
          title={
            autoDownloadingChapterId === chapter.id
              ? t("reader.downloadingChapter")
              : t("reader.notDownloadedYet")
          }
          message={
            autoDownloadingChapterId === chapter.id
              ? t("reader.downloadingChapterMessage")
              : t("reader.notDownloadedMessage")
          }
        />
      </Box>
    ) : isPdfChapter ? (
      <PdfReaderContent
        key={readerContentKey}
        ref={contentRef}
        appearanceSettings={effectiveReaderAppearance}
        bottomOverlayOffset={readerOverlayBottom}
        dataUrl={content}
        generalSettings={readerContentGeneral}
        initialProgress={readerProgress}
        localMediaContext={readerLocalMediaContext}
        onToggleChrome={handleReaderMenuTap}
        onProgressChange={handleProgressChange}
        onPageIndexChange={handlePageIndexChange}
        onBoundaryPage={handleBoundaryPage}
        onSeekbarActivity={showReaderSeekbarForActivity}
        onSeekbarActiveChange={handleReaderSeekbarActiveChange}
        seekbarVisible={readerSeekbarVisible}
        viewportHeight="100%"
      />
    ) : (
      <ReaderContent
        key={readerContentKey}
        ref={contentRef}
        appearanceSettings={effectiveReaderAppearance}
        bottomOverlayOffset={readerOverlayBottom}
        contentKey={readerContentKey}
        generalSettings={readerContentGeneral}
        html={content}
        initialProgress={readerProgress}
        localMediaContext={readerLocalMediaContext}
        onToggleChrome={handleReaderMenuTap}
        onProgressChange={handleProgressChange}
        onPageIndexChange={handlePageIndexChange}
        onBoundaryPage={handleBoundaryPage}
        onMediaError={handleRemoteMediaError}
        onSeekbarActivity={showReaderSeekbarForActivity}
        onSeekbarActiveChange={handleReaderSeekbarActiveChange}
        seekbarVisible={readerSeekbarVisible}
        viewportHeight="100%"
      />
    );

  return (
    <Box
      className="lnr-reader-shell"
      data-chrome-visible={readerChromeVisible}
      data-full-page={fullPageReader}
      data-seekbar-visible={readerSeekbarVisible}
      aria-busy={readerBusy}
      onPointerDown={handleReaderActivity}
      onPointerMove={handleFrequentReaderActivity}
      onWheel={handleFrequentReaderActivity}
    >
      <ReaderTopChrome
        chapter={chapter}
        chapterCount={chapters.length}
        chapterIndex={chapterIndex}
        bookmarkDisabled={!chapter}
        bookmarkLoading={bookmarkMutation.isPending}
        incognitoMode={incognitoMode}
        onBack={handleReaderBack}
        onOpenSettings={openReaderSettingsPanel}
        onRepairMedia={() => repairMediaMutation.mutate()}
        onToggleBookmark={() => bookmarkMutation.mutate()}
        progress={readerProgress}
        repairMediaDisabled={!chapter || !currentNovel}
        repairMediaLoading={repairMediaMutation.isPending}
        repairMediaAttention={remoteMediaError}
        settingsOpen={readerSettingsOpen}
        showMediaRepair={showMediaRepair}
      />
      <Box className="lnr-reader-body">
        <ReaderChapterPanel
          chapters={chapters}
          currentChapterId={chapter?.id}
          loading={chapterListQuery.isLoading}
          onOpenChapter={openChapter}
        />
        <Box className="lnr-reader-content-frame">{readerContent}</Box>
      </Box>
      {readerSettingsOpen ? (
        <ReaderSettingsOverlay
          novelId={chapterNovelId}
          novelName={currentNovel?.name}
          onClose={closeReaderSettingsPanel}
          onOpenSettingsPage={openReaderSettingsPage}
          sourceId={currentSourceId}
          sourceName={currentSourceName}
        />
      ) : null}
      <ReaderBottomStrip
        currentLabel={chapter ? getChapterLabel(chapter, t) : t("reader.sample")}
        hasNextChapter={!!nextChapter}
        hasPreviousChapter={!!previousChapter}
        nextLabel={nextChapter ? getChapterLabel(nextChapter, t) : t("reader.next")}
        onNextChapter={() => {
          void openAdjacent(1);
        }}
        onPreviousChapter={() => {
          void openAdjacent(-1);
        }}
        previousLabel={
          previousChapter ? getChapterLabel(previousChapter, t) : t("common.previous")
        }
        progress={readerProgress}
      />

    </Box>
  );
}
