import { Drawer, Loader, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckGlyph,
  CloseGlyph,
  DownloadedGlyph,
  DownloadGlyph,
  PlusGlyph,
  UnreadGlyph,
} from "../components/ActionGlyphs";
import { PageFrame, StateView } from "../components/AppFrame";
import {
  ConsolePanel,
  ConsoleSectionHeader,
} from "../components/ConsolePrimitives";
import { IconButton } from "../components/IconButton";
import {
  buildBatchDownloadTargets,
  chaptersKey,
  EMPTY_CHAPTERS,
  FINISHED_PROGRESS,
  novelKey,
  resolveNovelSourceUrl,
  sourceDuplicateChapterCountsById,
} from "../components/novel/novel-detail-model";
import {
  ChapterRelativeReadMenu,
  ChapterSortPicker,
  SelectionClearIcon,
} from "../components/novel/NovelActions";
import {
  ReadIcon,
  VirtualChapterList,
} from "../components/novel/NovelChapterList";
import { NovelWorkspace } from "../components/novel/NovelWorkspace";
import { useLocalNovelEditor } from "../components/novel/use-local-novel-editor";
import { useNovelChapterActions } from "../components/novel/use-novel-chapter-actions";
import { useNovelDownloadStatuses } from "../components/novel/use-novel-download-statuses";
import { useNovelMetadata } from "../components/novel/use-novel-metadata";
import { ReaderSettingsPanel } from "../components/ReaderSettingsPanel";
import {
  listChaptersByNovel,
  type ChapterListRow,
} from "../db/queries/chapter";
import { getNovelById } from "../db/queries/novel";
import { useTranslation } from "../i18n";
import { usePageBackNavigation } from "../lib/android-back-navigation";
import {
  findPreviousAppHistoryEntry,
  trimAppNavigationHistoryTo,
} from "../lib/navigation-history";
import { pluginManager } from "../lib/plugins/manager";
import { enqueueOpenSiteTask } from "../lib/tasks/source-tasks";
import { useLibraryStore } from "../store/library";
import { useReaderStore } from "../store/reader";
import "../styles/novel.css";
interface NovelDetailPageProps {
  id: number;
}

export function NovelDetailPage({ id }: NovelDetailPageProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const currentHref = useRouterState({
    select: (state) => state.location.href,
  });
  const defaultChapterSort = useLibraryStore((s) => s.defaultChapterSort);
  const setDefaultChapterSort = useLibraryStore((s) => s.setDefaultChapterSort);
  const lastReadChapterId = useReaderStore(
    (state) => state.lastReadChapterByNovel[id],
  );
  const [readerSettingsOpen, setReaderSettingsOpen] = useState(false);
  const [chapterSelectionMode, setChapterSelectionMode] = useState(false);
  const [selectedChapterIds, setSelectedChapterIds] = useState<
    ReadonlySet<number>
  >(() => new Set());
  const chapterSelectionGuardRef = useRef(false);

  const novelQuery = useQuery({
    queryKey: novelKey(id),
    queryFn: () => getNovelById(id),
    enabled: id > 0,
    staleTime: Infinity,
  });

  const chaptersQuery = useQuery({
    queryKey: chaptersKey(id),
    queryFn: () => listChaptersByNovel(id),
    enabled: id > 0,
    staleTime: Infinity,
  });

  const rows = chaptersQuery.data ?? EMPTY_CHAPTERS;
  const chapters = useMemo(
    () => (defaultChapterSort === "desc" ? [...rows].reverse() : rows),
    [defaultChapterSort, rows],
  );
  const {
    sourceDuplicateChapters,
    toggle,
    refreshMetadata,
    fullRefreshMetadata,
  } = useNovelMetadata(id, novelQuery.data);
  const {
    clearDownload,
    clearSelectedDownloads,
    setSelectedChapterReadState,
    setRelativeChapterReadState,
    repairMedia,
    downloadChapter,
    downloadChapters,
  } = useNovelChapterActions(id, novelQuery.data, chapters);
  const statuses = useNovelDownloadStatuses(id, rows);
  const {
    addLocalChapters,
    reorderLocalChapters,
    localChapterError,
    openLocalChapterInput,
    openLocalMetadataEditor,
    reorderLocalChapter,
    editor: localNovelEditor,
  } = useLocalNovelEditor(id, novelQuery.data, chapters, defaultChapterSort);
  const sourceDuplicateChapterCounts = useMemo(
    () => sourceDuplicateChapterCountsById(chapters, sourceDuplicateChapters),
    [chapters, sourceDuplicateChapters],
  );
  const chapterStats = useMemo(() => {
    let downloaded = 0;
    let unread = 0;
    for (const chapter of rows) {
      if (chapter.isDownloaded) downloaded += 1;
      if (chapter.unread) unread += 1;
    }
    return { downloaded, unread };
  }, [rows]);
  const selectedChapters = useMemo(
    () => chapters.filter((chapter) => selectedChapterIds.has(chapter.id)),
    [chapters, selectedChapterIds],
  );
  const selectedChapterIdList = useMemo(
    () => selectedChapters.map((chapter) => chapter.id),
    [selectedChapters],
  );
  const selectedDownloadTargets = useMemo(
    () =>
      buildBatchDownloadTargets(selectedChapters, lastReadChapterId, statuses)
        .all,
    [lastReadChapterId, selectedChapters, statuses],
  );
  const selectedDownloadedChapterIds = useMemo(
    () =>
      selectedChapters
        .filter((chapter) => chapter.isDownloaded)
        .map((chapter) => chapter.id),
    [selectedChapters],
  );
  const selectedUnreadCount = selectedChapters.filter(
    (chapter) => chapter.unread || chapter.progress < FINISHED_PROGRESS,
  ).length;
  const selectedReadCount = selectedChapters.filter(
    (chapter) => !chapter.unread || chapter.progress > 0,
  ).length;
  const selectedChapterCount = selectedChapters.length;
  const selectedAnchorChapter =
    selectedChapterCount === 1 ? selectedChapters[0] : undefined;
  const selectedAnchorIndex = selectedAnchorChapter
    ? rows.findIndex((chapter) => chapter.id === selectedAnchorChapter.id)
    : -1;
  const selectedAnchorBeforeCount = Math.max(0, selectedAnchorIndex);
  const selectedAnchorAfterCount =
    selectedAnchorIndex < 0
      ? 0
      : Math.max(0, rows.length - selectedAnchorIndex - 1);
  const allChaptersSelected =
    chapters.length > 0 && selectedChapterCount === chapters.length;
  const chapterSelectionBusy =
    clearSelectedDownloads.isPending ||
    setSelectedChapterReadState.isPending ||
    setRelativeChapterReadState.isPending;

  useEffect(() => {
    setChapterSelectionMode(false);
    setSelectedChapterIds(new Set());
    chapterSelectionGuardRef.current = false;
  }, [id]);

  useEffect(() => {
    if (rows.length === 0) {
      setChapterSelectionMode(false);
      setSelectedChapterIds(new Set());
      return;
    }

    const availableChapterIds = new Set(rows.map((chapter) => chapter.id));
    setSelectedChapterIds((current) => {
      let changed = false;
      const next = new Set<number>();
      for (const chapterId of current) {
        if (availableChapterIds.has(chapterId)) {
          next.add(chapterId);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [rows]);

  useEffect(() => {
    if (!chapterSelectionMode) return;

    if (!chapterSelectionGuardRef.current) {
      const currentState =
        window.history.state && typeof window.history.state === "object"
          ? window.history.state
          : {};
      window.history.pushState(
        { ...currentState, noreaChapterSelection: true },
        "",
        currentHref,
      );
      chapterSelectionGuardRef.current = true;
    }

    const handlePopState = () => {
      if (!chapterSelectionGuardRef.current) return;
      chapterSelectionGuardRef.current = false;
      setSelectedChapterIds(new Set());
      setChapterSelectionMode(false);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [chapterSelectionMode, currentHref]);

  function clearChapterSelectionState(): void {
    setSelectedChapterIds(new Set());
    setChapterSelectionMode(false);
  }

  function closeChapterSelectionMode(): void {
    if (chapterSelectionGuardRef.current) {
      window.history.back();
      return;
    }
    clearChapterSelectionState();
  }

  function toggleChapterSelected(chapterId: number): void {
    setChapterSelectionMode(true);
    setSelectedChapterIds((current) => {
      const next = new Set(current);
      if (next.has(chapterId)) {
        next.delete(chapterId);
      } else {
        next.add(chapterId);
      }
      return next;
    });
  }

  function selectAllChapters(): void {
    setChapterSelectionMode(true);
    setSelectedChapterIds(new Set(chapters.map((chapter) => chapter.id)));
  }

  function clearSelectedChapters(): void {
    setSelectedChapterIds(new Set());
  }

  function goBack(): boolean {
    if (chapterSelectionMode) {
      closeChapterSelectionMode();
      return true;
    }

    const target = findPreviousAppHistoryEntry(currentHref, ["/reader"]);
    if (target) {
      trimAppNavigationHistoryTo(target);
      window.history.go(-target.steps);
      return true;
    }

    void navigate({ to: "/", replace: true });
    return true;
  }

  usePageBackNavigation(goBack);

  function openChapter(chapter: ChapterListRow): void {
    void navigate({ to: "/reader", search: { chapterId: chapter.id } });
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
      <PageFrame className="norea-novel-page" size="wide">
        <div className="norea-novel-layout">
          <NovelWorkspace
            key={novel.id}
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

          <ConsolePanel className="norea-novel-chapters-panel">
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

            {chapterSelectionMode ? (
              <div className="norea-novel-selection-strip">
                <span>
                  {t("novel.selection.selectedCount", {
                    count: selectedChapterCount,
                  })}
                </span>
                <div className="norea-novel-selection-actions">
                  <IconButton
                    className="norea-novel-selection-icon"
                    disabled={allChaptersSelected}
                    label={t("novel.selection.selectAll")}
                    onClick={selectAllChapters}
                    size="sm"
                    title={t("novel.selection.selectAll")}
                  >
                    <CheckGlyph />
                  </IconButton>
                  <IconButton
                    className="norea-novel-selection-icon"
                    disabled={selectedChapterCount === 0}
                    label={t("novel.selection.clearSelected")}
                    onClick={clearSelectedChapters}
                    size="sm"
                    title={t("novel.selection.clearSelected")}
                  >
                    <SelectionClearIcon />
                  </IconButton>
                  <IconButton
                    className="norea-novel-selection-icon"
                    disabled={
                      selectedDownloadTargets.length === 0 ||
                      chapterSelectionBusy
                    }
                    label={
                      selectedDownloadTargets.length > 0
                        ? t("novel.selection.downloadSelected")
                        : t("novel.selection.downloadSelectedUnavailable")
                    }
                    onClick={() => downloadChapters(selectedDownloadTargets)}
                    size="sm"
                    title={
                      selectedDownloadTargets.length > 0
                        ? t("novel.selection.downloadSelected")
                        : t("novel.selection.downloadSelectedUnavailable")
                    }
                  >
                    <DownloadGlyph />
                  </IconButton>
                  <IconButton
                    className="norea-novel-selection-icon"
                    disabled={
                      novel.isLocal ||
                      selectedDownloadedChapterIds.length === 0 ||
                      chapterSelectionBusy
                    }
                    label={
                      selectedDownloadedChapterIds.length > 0
                        ? t("novel.selection.deleteDownloads")
                        : t("novel.selection.deleteDownloadsUnavailable")
                    }
                    onClick={() => {
                      if (
                        !window.confirm(
                          t("novel.selection.deleteDownloadsConfirm", {
                            count: selectedDownloadedChapterIds.length,
                          }),
                        )
                      ) {
                        return;
                      }
                      clearSelectedDownloads.mutate(
                        selectedDownloadedChapterIds,
                      );
                    }}
                    size="sm"
                    title={
                      selectedDownloadedChapterIds.length > 0
                        ? t("novel.selection.deleteDownloads")
                        : t("novel.selection.deleteDownloadsUnavailable")
                    }
                    tone="danger"
                  >
                    {clearSelectedDownloads.isPending ? (
                      <Loader size={14} />
                    ) : (
                      <DownloadedGlyph />
                    )}
                  </IconButton>
                  <IconButton
                    className="norea-novel-selection-icon"
                    disabled={selectedUnreadCount === 0 || chapterSelectionBusy}
                    label={t("novel.selection.markRead")}
                    onClick={() =>
                      setSelectedChapterReadState.mutate({
                        chapterIds: selectedChapterIdList,
                        unread: false,
                      })
                    }
                    size="sm"
                    title={t("novel.selection.markRead")}
                  >
                    {setSelectedChapterReadState.isPending &&
                    setSelectedChapterReadState.variables?.unread === false ? (
                      <Loader size={14} />
                    ) : (
                      <ReadIcon />
                    )}
                  </IconButton>
                  <IconButton
                    className="norea-novel-selection-icon"
                    disabled={selectedReadCount === 0 || chapterSelectionBusy}
                    label={t("novel.selection.markUnread")}
                    onClick={() =>
                      setSelectedChapterReadState.mutate({
                        chapterIds: selectedChapterIdList,
                        unread: true,
                      })
                    }
                    size="sm"
                    title={t("novel.selection.markUnread")}
                  >
                    {setSelectedChapterReadState.isPending &&
                    setSelectedChapterReadState.variables?.unread === true ? (
                      <Loader size={14} />
                    ) : (
                      <UnreadGlyph />
                    )}
                  </IconButton>
                  {selectedAnchorChapter ? (
                    <ChapterRelativeReadMenu
                      afterCount={selectedAnchorAfterCount}
                      beforeCount={selectedAnchorBeforeCount}
                      busy={chapterSelectionBusy}
                      onMarkFollowingUnread={() =>
                        setRelativeChapterReadState.mutate({
                          anchorChapterId: selectedAnchorChapter.id,
                          direction: "after",
                          unread: true,
                        })
                      }
                      onMarkPreviousRead={() =>
                        setRelativeChapterReadState.mutate({
                          anchorChapterId: selectedAnchorChapter.id,
                          direction: "before",
                          unread: false,
                        })
                      }
                    />
                  ) : null}
                  <IconButton
                    className="norea-novel-selection-icon"
                    label={t("novel.selection.close")}
                    onClick={closeChapterSelectionMode}
                    size="sm"
                    title={t("novel.selection.close")}
                  >
                    <CloseGlyph />
                  </IconButton>
                </div>
              </div>
            ) : null}

            {localChapterError ? (
              <Text c="red" className="norea-novel-local-error" size="sm">
                {localChapterError}
              </Text>
            ) : null}

            {metadataRefreshError ? (
              <Text c="red" className="norea-novel-local-error" size="sm">
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
                repairBusyChapterId={repairMedia.variables?.id}
                repairPending={repairMedia.isPending}
                reorderPending={reorderLocalChapters.isPending}
                selectedChapterIds={selectedChapterIds}
                selectionMode={chapterSelectionMode}
                statuses={statuses}
                onOpen={(chapter) => {
                  void openChapter(chapter);
                }}
                onDownload={downloadChapter}
                onRepairMedia={(chapter) => repairMedia.mutate(chapter)}
                onReorderChapter={reorderLocalChapter}
                onToggleSelected={toggleChapterSelected}
                onDeleteDownload={(chapterId) => {
                  if (novel.isLocal) return;
                  clearDownload.mutate(chapterId);
                }}
              />
            )}
          </ConsolePanel>
        </div>
      </PageFrame>

      <Drawer
        classNames={{
          body: "norea-reader-settings-drawer-body",
          content: "norea-reader-settings-drawer-content",
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

      {localNovelEditor}
    </>
  );
}
