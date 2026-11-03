import { Box } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BlockingLoadingOverlay, StateView } from "../components/AppFrame";
import { PdfReaderContent } from "../components/PdfReaderContent";
import {
  ReaderBottomBar,
  ReaderChapterPanel,
  ReaderChapterSheet,
  ReaderSettingsOverlay,
  ReaderTopBar,
} from "../components/reader/ReaderChrome";
import { useNextReaderChapter } from "../components/reader/use-next-reader-chapter";
import { useReaderChapterDocument } from "../components/reader/use-reader-chapter-document";
import { useReaderChapterNavigation } from "../components/reader/use-reader-chapter-navigation";
import { useReaderChrome } from "../components/reader/use-reader-chrome";
import { useReaderKeyboard } from "../components/reader/use-reader-keyboard";
import { useReaderPersistence } from "../components/reader/use-reader-persistence";
import { useReaderSettings } from "../components/reader/use-reader-settings";
import {
  ReaderContent,
  type ReaderContentHandle,
} from "../components/ReaderContent";
import { hasStoredChapterContent, listChaptersByNovel, setChapterBookmark } from "../db/queries/chapter";
import { getNovelById } from "../db/queries/novel";
import { useTranslation } from "../i18n";
import { usePageActivity } from "../lib/page-activity";
import { pluginManager } from "../lib/plugins/manager";
import { readerChapterQueryOptions } from "../lib/reader-chapter";
import {
  chapterDetailQueryKey,
  chapterListQueryKey,
  invalidateReaderContentQueries,
  novelDetailQueryKey,
} from "../lib/reader-query-invalidation";
import { enqueueChapterMediaRepair } from "../lib/tasks/chapter-download";
import { useLibraryStore } from "../store/library";
import { useReaderStore } from "../store/reader";
import { useReaderLayoutStore } from "../store/reader-layout";
import "../styles/reader.css";

interface ReaderPageProps {
  chapterId: number;
}

export function ReaderPage({ chapterId }: ReaderPageProps) {
  const { t } = useTranslation();
  const active = usePageActivity();
  const queryClient = useQueryClient();
  const contentRef = useRef<ReaderContentHandle | null>(null);
  const openedChapterRef = useRef<number | null>(null);
  const chapterQuery = useQuery({
    meta: { errorPresentation: "inline" },
    ...readerChapterQueryOptions(chapterId),
    enabled: chapterId > 0,
  });
  const rawChapter = chapterQuery.data;
  const chapter = rawChapter?.id === chapterId ? rawChapter : undefined;
  const currentNovelId = chapter?.novelId ?? 0;
  const currentNovelQuery = useQuery({
    queryKey: novelDetailQueryKey(currentNovelId),
    queryFn: () => getNovelById(currentNovelId, "committed"),
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

  const { effectiveReaderGeneral, effectiveReaderAppearance } =
    useReaderSettings(currentSourceId, currentNovelId);
  const { incognitoMode, persistProgress } = useReaderPersistence(
    chapter,
    openedChapterRef,
  );
  const {
    activeChapterId,
    readerProgressPersistenceReady,
    readerContentKey,
    readerLocalMediaContext,
    hasChapterContent,
    content,
    isPdfChapter,
    readerPreparation,
    showMediaRepair,
    remoteMediaError,
    setRemoteMediaError,
    handleRemoteMediaError,
  } = useReaderChapterDocument({
    chapterId,
    chapter,
    currentNovel,
    bionicReading: effectiveReaderGeneral.bionicReading,
    contentRef,
  });
  const fullPageReader = effectiveReaderGeneral.fullPageReader;
  const setNovelPageIndex = useReaderStore((state) => state.setNovelPageIndex);

  const chapterListQuery = useQuery({
    queryKey: chapterListQueryKey(currentNovelId),
    queryFn: () => listChaptersByNovel(currentNovelId, "committed"),
    enabled: currentNovelId > 0,
  });
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

  const {
    autoDownloadingChapterId,
    awaitingChapterDownload,
    chapterUnavailable,
    retryChapterDownload,
    initialProgressOverride,
    setInitialProgressOverride,
    openChapter,
    openAdjacent,
    handleReaderBack,
  } = useReaderChapterNavigation({
    chapterId,
    chapter,
    previousChapter,
    nextChapter,
    readerProgressPersistenceReady,
    contentRef,
    openedChapterRef,
  });
  useNextReaderChapter({
    nextChapter,
    currentNovel,
    currentNovelId,
    currentSourceName,
    autoDownloadNextChapter: effectiveReaderGeneral.autoDownloadNextChapter,
    bionicReading: effectiveReaderGeneral.bionicReading,
    currentChapterReady:
      Boolean(chapter && hasStoredChapterContent(chapter)) &&
      (isPdfChapter || Boolean(readerPreparation.document)),
  });
  const readerBusy =
    readerPreparation.isPending ||
    (chapterId > 0 &&
      !hasChapterContent &&
      (chapterQuery.isLoading || awaitingChapterDownload));
  const progress = chapter?.progress ?? 0;
  const activeInitialProgressOverride =
    initialProgressOverride &&
    initialProgressOverride.chapterId === activeChapterId
      ? initialProgressOverride.progress
      : null;
  const readerProgress = activeInitialProgressOverride ?? progress;
  const chapterNovelId = chapter?.novelId;
  const readerStateVisible =
    readerPreparation.isPending ||
    Boolean(readerPreparation.error) ||
    (chapterId > 0 &&
      !hasChapterContent &&
      (chapterQuery.isLoading ||
        Boolean(chapterQuery.error) ||
        chapterQuery.data === null ||
        Boolean(chapter)));
  const {
    readerChromeVisible,
    readerChromeDismissible,
    readerSettingsOpen,
    chapterListOpen,
    openReaderSettingsPanel,
    closeReaderSettingsPanel,
    openChapterList,
    closeChapterList,
    closeTopReaderOverlay,
    openReaderSettingsPage,
    handleReaderMenuTap,
    hideReaderChrome,
    handleReaderActivity,
    handleFrequentReaderActivity,
    handleReaderSeekbarActiveChange,
    chromeFocusHandlers,
  } = useReaderChrome({
    chapterId,
    fullPageReader,
    readerStateVisible,
  });
  const openAdjacentChapter = useCallback(
    (direction: 1 | -1) => {
      void openAdjacent(direction);
    },
    [openAdjacent],
  );
  useReaderKeyboard({
    active,
    contentRef,
    closeTopReaderOverlay,
    modalOverlayOpen: readerSettingsOpen || chapterListOpen,
    readerChromeDismissible,
    hideReaderChrome,
    handleReaderActivity,
    handleReaderBack,
    openAdjacentChapter,
  });
  const chapterPanelAvailable = useMediaQuery("(min-width: 1200px)", undefined, {
    getInitialValueInEffect: false,
  });
  const chapterPanelOpen = useReaderLayoutStore(
    (state) => state.chapterPanelOpen,
  );
  const setChapterPanelOpen = useReaderLayoutStore(
    (state) => state.setChapterPanelOpen,
  );
  const showChapterPanel = chapterPanelAvailable && chapterPanelOpen;
  const toggleChapters = useCallback(() => {
    if (chapterPanelAvailable) {
      setChapterPanelOpen(!chapterPanelOpen);
      return;
    }
    openChapterList();
  }, [
    chapterPanelAvailable,
    chapterPanelOpen,
    openChapterList,
    setChapterPanelOpen,
  ]);
  const openChapterFromList = useCallback(
    (target: (typeof chapters)[number]) => {
      closeChapterList();
      openChapter(target);
    },
    [closeChapterList, openChapter],
  );
  const setIncognitoMode = useLibraryStore((state) => state.setIncognitoMode);
  const [seekbarContainer, setSeekbarContainer] =
    useState<HTMLElement | null>(null);
  useEffect(() => {
    if (
      !chapter ||
      hasStoredChapterContent(chapter) ||
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
    chapter?.contentBytes,
    hasChapterContent,
    queryClient,
  ]);
  const handleProgressChange = useCallback(
    (nextProgress: number) => {
      const targetChapterId = chapter?.id;
      if (
        !readerProgressPersistenceReady ||
        !targetChapterId ||
        currentNovelId <= 0
      ) {
        return;
      }
      setInitialProgressOverride((current) =>
        current?.chapterId === targetChapterId
          ? { ...current, progress: nextProgress }
          : current,
      );
      persistProgress({
        chapterId: targetChapterId,
        novelId: currentNovelId,
        progress: nextProgress,
      });
    },
    [
      chapter?.id,
      currentNovelId,
      readerProgressPersistenceReady,
      persistProgress,
    ],
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

  const readerContent = readerPreparation.error ? (
    <Box className="norea-reader-state-frame">
      <StateView
        color="danger"
        title={t("reader.loadFailed")}
        message={readerPreparation.error.message}
      />
    </Box>
  ) : readerPreparation.isPending ||
    (chapterId > 0 && !hasChapterContent && chapterQuery.isLoading) ? (
    <Box className="norea-reader-state-frame">
      <StateView
        color="info"
        title={t("reader.loadingChapter")}
        message={t("reader.loadingContent")}
      />
    </Box>
  ) : chapterId > 0 && !hasChapterContent && chapterQuery.error ? (
    <Box className="norea-reader-state-frame">
      <StateView
        color="danger"
        title={t("reader.loadFailed")}
        message={
          chapterQuery.error instanceof Error
            ? chapterQuery.error.message
            : String(chapterQuery.error)
        }
      />
    </Box>
  ) : chapterId > 0 && !hasChapterContent && chapterQuery.data === null ? (
    <Box className="norea-reader-state-frame">
      <StateView
        color="warn"
        title={t("reader.chapterNotFound")}
        message={t("reader.chapterNotFoundMessage", { id: chapterId })}
      />
    </Box>
  ) : chapterId > 0 &&
    !hasChapterContent &&
    chapterUnavailable?.reason === "failed" ? (
    <Box className="norea-reader-state-frame">
      <StateView
        action={{ label: t("common.retry"), onClick: retryChapterDownload }}
        color="danger"
        title={t("reader.downloadFailed")}
        message={chapterUnavailable.message}
      />
    </Box>
  ) : chapterId > 0 &&
    !hasChapterContent &&
    chapterUnavailable?.reason === "offline" ? (
    <Box className="norea-reader-state-frame">
      <StateView
        color="warn"
        title={t("reader.offline")}
        message={t("network.waiting")}
      />
    </Box>
  ) : chapterId > 0 && chapter && !hasChapterContent ? (
    <Box className="norea-reader-state-frame">
      <StateView
        color="info"
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
      chromeDismissible={readerChromeDismissible}
      chromeVisible={readerChromeVisible}
      dataUrl={content}
      generalSettings={effectiveReaderGeneral}
      initialProgress={readerProgress}
      localMediaContext={readerLocalMediaContext}
      onToggleChrome={handleReaderMenuTap}
      onProgressChange={
        readerProgressPersistenceReady ? handleProgressChange : undefined
      }
      onPageIndexChange={handlePageIndexChange}
      onBoundaryPage={handleBoundaryPage}
      onSeekbarActivity={handleReaderActivity}
      onSeekbarActiveChange={handleReaderSeekbarActiveChange}
      seekbarContainer={seekbarContainer}
      viewportHeight="100%"
    />
  ) : (
    <ReaderContent
      key={readerContentKey}
      ref={contentRef}
      appearanceSettings={effectiveReaderAppearance}
      chromeDismissible={readerChromeDismissible}
      chromeVisible={readerChromeVisible}
      contentKey={readerContentKey}
      generalSettings={effectiveReaderGeneral}
      html={content}
      preparedDocument={readerPreparation.document}
      initialProgress={readerProgress}
      localMediaContext={readerLocalMediaContext}
      onToggleChrome={handleReaderMenuTap}
      onProgressChange={
        readerProgressPersistenceReady ? handleProgressChange : undefined
      }
      onPageIndexChange={handlePageIndexChange}
      onBoundaryPage={handleBoundaryPage}
      onMediaError={handleRemoteMediaError}
      onSeekbarActivity={handleReaderActivity}
      onSeekbarActiveChange={handleReaderSeekbarActiveChange}
      seekbarContainer={seekbarContainer}
      viewportHeight="100%"
    />
  );

  return (
    <Box
      className="norea-reader-shell"
      data-chrome-visible={readerChromeVisible}
      data-full-page={fullPageReader}
      aria-busy={readerBusy}
      onPointerDown={handleReaderActivity}
      onPointerMove={handleFrequentReaderActivity}
      onWheel={handleFrequentReaderActivity}
    >
      <ReaderTopBar
        bookmarked={Boolean(chapter?.bookmark)}
        bookmarkDisabled={!chapter}
        bookmarkLoading={bookmarkMutation.isPending}
        chapterName={chapter?.name}
        focusHandlers={chromeFocusHandlers}
        incognitoMode={incognitoMode}
        novelName={currentNovel?.name}
        onBack={handleReaderBack}
        onIncognitoModeChange={setIncognitoMode}
        onOpenSettings={openReaderSettingsPanel}
        onRepairMedia={() => repairMediaMutation.mutate()}
        onToggleBookmark={() => bookmarkMutation.mutate()}
        repairMediaDisabled={!chapter || !currentNovel}
        repairMediaLoading={repairMediaMutation.isPending}
        repairMediaAttention={remoteMediaError}
        settingsOpen={readerSettingsOpen}
        showMediaRepair={showMediaRepair}
      />
      <Box className="norea-reader-body">
        {showChapterPanel ? (
          <ReaderChapterPanel
            chapters={chapters}
            currentChapterId={chapter?.id}
            loading={chapterListQuery.isLoading}
            onOpenChapter={openChapter}
          />
        ) : null}
        <Box className="norea-reader-content-frame">{readerContent}</Box>
      </Box>
      <ReaderBottomBar
        chapterListExpanded={showChapterPanel || chapterListOpen}
        focusHandlers={chromeFocusHandlers}
        hasNextChapter={!!nextChapter}
        hasPreviousChapter={!!previousChapter}
        onNextChapter={() => openAdjacentChapter(1)}
        onOpenChapters={toggleChapters}
        onOpenSettings={openReaderSettingsPanel}
        onPreviousChapter={() => openAdjacentChapter(-1)}
        seekSlotRef={setSeekbarContainer}
        settingsOpen={readerSettingsOpen}
      />
      <ReaderChapterSheet
        chapters={chapters}
        currentChapterId={chapter?.id}
        loading={chapterListQuery.isLoading}
        onClose={closeChapterList}
        onOpenChapter={openChapterFromList}
        opened={chapterListOpen && !chapterPanelAvailable}
      />
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
      {readerBusy ? (
        <BlockingLoadingOverlay
          cancelLabel={t("common.back")}
          label={t("reader.loadingContent")}
          onCancel={handleReaderBack}
        />
      ) : null}
    </Box>
  );
}
