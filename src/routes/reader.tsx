import { Box } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { BlockingLoadingOverlay, StateView } from "../components/AppFrame";
import { PdfReaderContent } from "../components/PdfReaderContent";
import {
  getChapterLabel,
  ReaderBottomStrip,
  ReaderChapterPanel,
  ReaderSettingsOverlay,
  ReaderTopChrome,
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
import { listChaptersByNovel, setChapterBookmark } from "../db/queries/chapter";
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
import { useReaderStore } from "../store/reader";
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
    ...readerChapterQueryOptions(chapterId),
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
    queryFn: () => listChaptersByNovel(currentNovelId),
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
      chapter?.isDownloaded === true &&
      (isPdfChapter || Boolean(readerPreparation.document)),
  });
  const readerBusy =
    readerPreparation.isPending ||
    (chapterId > 0 &&
      !hasChapterContent &&
      (chapterQuery.isLoading || Boolean(chapter && !chapter.isDownloaded)));
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
    readerSeekbarVisible,
    readerSeekbarMounted,
    readerSettingsOpen,
    openReaderSettingsPanel,
    closeReaderSettingsPanel,
    openReaderSettingsPage,
    handleReaderMenuTap,
    handleReaderActivity,
    handleFrequentReaderActivity,
    showReaderSeekbarForActivity,
    handleReaderSeekbarActiveChange,
  } = useReaderChrome({
    active,
    chapterId,
    fullPageReader,
    showSeekbar: effectiveReaderGeneral.showSeekbar,
    readerStateVisible,
  });
  useReaderKeyboard({
    active,
    readerSettingsOpen,
    contentRef,
    closeReaderSettingsPanel,
    handleReaderActivity,
    handleReaderBack,
  });
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
    ? "calc(var(--norea-safe-area-bottom) + 0.5rem)"
    : "calc(var(--norea-app-bottom-inset) + 2rem)";
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
        color="red"
        title={t("reader.loadFailed")}
        message={readerPreparation.error.message}
      />
    </Box>
  ) : readerPreparation.isPending ||
    (chapterId > 0 && !hasChapterContent && chapterQuery.isLoading) ? (
    <Box className="norea-reader-state-frame">
      <StateView
        color="blue"
        title={t("reader.loadingChapter")}
        message={t("reader.loadingContent")}
      />
    </Box>
  ) : chapterId > 0 && !hasChapterContent && chapterQuery.error ? (
    <Box className="norea-reader-state-frame">
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
    <Box className="norea-reader-state-frame">
      <StateView
        color="orange"
        title={t("reader.chapterNotFound")}
        message={t("reader.chapterNotFoundMessage", { id: chapterId })}
      />
    </Box>
  ) : chapterId > 0 && chapter && !hasChapterContent ? (
    <Box className="norea-reader-state-frame">
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
      onProgressChange={
        readerProgressPersistenceReady ? handleProgressChange : undefined
      }
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
      onSeekbarActivity={showReaderSeekbarForActivity}
      onSeekbarActiveChange={handleReaderSeekbarActiveChange}
      seekbarVisible={readerSeekbarVisible}
      viewportHeight="100%"
    />
  );

  return (
    <Box
      className="norea-reader-shell"
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
      <Box className="norea-reader-body">
        <ReaderChapterPanel
          chapters={chapters}
          currentChapterId={chapter?.id}
          loading={chapterListQuery.isLoading}
          onOpenChapter={openChapter}
        />
        <Box className="norea-reader-content-frame">{readerContent}</Box>
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
        currentLabel={
          chapter ? getChapterLabel(chapter, t) : t("reader.sample")
        }
        hasNextChapter={!!nextChapter}
        hasPreviousChapter={!!previousChapter}
        nextLabel={
          nextChapter ? getChapterLabel(nextChapter, t) : t("reader.next")
        }
        onNextChapter={() => {
          void openAdjacent(1);
        }}
        onPreviousChapter={() => {
          void openAdjacent(-1);
        }}
        previousLabel={
          previousChapter
            ? getChapterLabel(previousChapter, t)
            : t("common.previous")
        }
        progress={readerProgress}
      />
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
