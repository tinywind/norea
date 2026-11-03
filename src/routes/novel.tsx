import { Button, Drawer, Loader, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CheckGlyph,
  CloseGlyph,
  DownloadedGlyph,
  DownloadGlyph,
  PlusGlyph,
  UnreadGlyph,
} from "../components/ActionGlyphs";
import { PageFrame, StateView } from "../components/AppFrame";
import { IconButton } from "../components/IconButton";
import {
  BackIcon,
  DragIcon,
  EditIcon,
  ImportIcon,
  MigrateIcon,
  ReaderSettingsIcon,
  RefreshAllIcon,
  RefreshIcon,
  SelectIcon,
  ServerIcon,
  SourceIcon,
} from "../components/ui/icons";
import { OverflowMenu, type OverflowMenuItem } from "../components/ui/OverflowMenu";
import {
  buildBatchDownloadTargets,
  buildPreviousChapterDownloadTargets,
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
import { NovelCategoryEditor } from "../components/novel/NovelCategoryEditor";
import {
  ServerChapterManager,
  useManagedServerWork,
} from "../components/novel/ServerChapterManager";
import type { ServerNovelSource } from "../lib/content-sync/novel-source";
import { useLocalNovelEditor } from "../components/novel/use-local-novel-editor";
import { useNovelChapterActions } from "../components/novel/use-novel-chapter-actions";
import { useNovelDownloadStatuses } from "../components/novel/use-novel-download-statuses";
import { useNovelMetadata } from "../components/novel/use-novel-metadata";
import { useServerNovelSync } from "../components/novel/use-server-novel-sync";
import { ReaderSettingsPanel } from "../components/ReaderSettingsPanel";
import {
  hasStoredChapterContent,
  listChaptersByNovel,
  type ChapterListRow,
} from "../db/queries/chapter";
import { getNovelById } from "../db/queries/novel";
import { useTranslation } from "../i18n";
import { describeError } from "../lib/errors";
import { isAbortError } from "../lib/abort";
import { isNetworkUnavailableError } from "../lib/network";
import { normalizeSourceAccessRequiredError } from "../lib/plugins/source-access";
import { listServerChapterAvailability, readServerNovelSource } from "../lib/content-sync/novel-source";
import { useOverlayBackNavigation, usePageBackNavigation } from "../lib/android-back-navigation";
import {
  findPreviousAppHistoryEntry,
  trimAppNavigationHistoryTo,
} from "../lib/navigation-history";
import { pluginManager } from "../lib/plugins/manager";
import { usePageActivity } from "../lib/page-activity";
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
  const currentHref = useRouterState({ select: (state) => state.location.href });
  const active = usePageActivity();
  const defaultChapterSort = useLibraryStore((s) => s.defaultChapterSort);
  const setDefaultChapterSort = useLibraryStore((s) => s.setDefaultChapterSort);
  const lastReadChapterId = useReaderStore(
    (state) => state.lastReadChapterByNovel[id],
  );
  const [readerSettingsOpen, setReaderSettingsOpen] = useState(false);
  const [serverManagerSource, setServerManagerSource] =
    useState<ServerNovelSource | null>(null);
  const [reorderMode, setReorderMode] = useState(false);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const chaptersHeadingId = useId();
  const [titleScrolledAway, setTitleScrolledAway] = useState(false);
  const [chapterSelectionMode, setChapterSelectionMode] = useState(false);
  const [selectedChapterIds, setSelectedChapterIds] = useState<
    ReadonlySet<number>
  >(() => new Set());
  const chapterSelectionGuardRef = useRef(false);

  const novelQuery = useQuery({
    meta: { errorPresentation: "inline" },
    queryKey: novelKey(id),
    queryFn: () => getNovelById(id, "committed"),
    enabled: active && id > 0,
    staleTime: Infinity,
  });

  const chaptersQuery = useQuery({
    queryKey: chaptersKey(id),
    queryFn: () => listChaptersByNovel(id, "committed"),
    enabled: active && id > 0,
    staleTime: Infinity,
  });
  const serverSourceQuery = useQuery({
    queryKey: ["content-server", "novel-source", id],
    queryFn: () => readServerNovelSource(id),
    enabled: active && id > 0,
    networkMode: "always",
    staleTime: Infinity,
  });
  const displayNovel = useMemo(
    () => serverSourceQuery.data && novelQuery.data
      ? { ...novelQuery.data, isLocal: false }
      : novelQuery.data,
    [novelQuery.data, serverSourceQuery.data],
  );
  const hasSourcePlugin = Boolean(novelQuery.data && !novelQuery.data.isLocal &&
    !novelQuery.data.path.startsWith("norea-folder:") && pluginManager.getPlugin(novelQuery.data.pluginId));
  const serverChaptersQuery = useQuery({
    queryKey: ["content-server", "novel-chapters", serverSourceQuery.data?.serverUrl, serverSourceQuery.data?.workId],
    queryFn: ({ signal }) => serverSourceQuery.data
      ? listServerChapterAvailability(serverSourceQuery.data, signal)
      : Promise.resolve({ paths: new Map<string, boolean>(), numbers: new Map<number, boolean>() }),
    enabled: active && Boolean(serverSourceQuery.data && novelQuery.data),
    staleTime: 30_000,
  });
  const serverSync = useServerNovelSync(id, active, novelQuery.data?.name ?? "");
  const managedServerWork = useManagedServerWork(
    novelQuery.data ?? undefined,
    serverSourceQuery.data,
    active,
  );

  const rows = useMemo(() => {
    const storedRows = chaptersQuery.data ?? EMPTY_CHAPTERS;
    if (!serverSourceQuery.data || !serverChaptersQuery.data) return storedRows;
    const available = serverChaptersQuery.data;
    return storedRows.flatMap((chapter) => {
      const serverComplete = available.paths.get(chapter.path)
        ?? (chapter.chapterNumber != null && /^\d+(?:\.\d+)?$/.test(chapter.chapterNumber)
          ? available.numbers.get(Number(chapter.chapterNumber)) : undefined);
      return hasSourcePlugin || hasStoredChapterContent(chapter) || serverComplete !== undefined
        ? [{ ...chapter, serverComplete }]
        : [];
    });
  }, [chaptersQuery.data, serverChaptersQuery.data, serverSourceQuery.data, hasSourcePlugin]);
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
  } = useNovelChapterActions(id, displayNovel, chapters);
  const statuses = useNovelDownloadStatuses(id, rows, active);
  const {
    addLocalChapters,
    reorderLocalChapters,
    localChapterError,
    openLocalChapterInput,
    openLocalMetadataEditor,
    reorderLocalChapter,
    editor: localNovelEditor,
  } = useLocalNovelEditor(id, displayNovel, chapters, defaultChapterSort);
  const sourceDuplicateChapterCounts = useMemo(
    () => sourceDuplicateChapterCountsById(chapters, sourceDuplicateChapters),
    [chapters, sourceDuplicateChapters],
  );
  const chapterStats = useMemo(() => {
    let downloaded = 0;
    let unread = 0;
    for (const chapter of rows) {
      if (hasStoredChapterContent(chapter)) downloaded += 1;
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
        .filter(hasStoredChapterContent)
        .map((chapter) => chapter.id),
    [selectedChapters],
  );
  const previousDownloadTargets = useMemo(
    () => buildPreviousChapterDownloadTargets(chapters, selectedChapterIds, statuses),
    [chapters, selectedChapterIds, statuses],
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
    setReorderMode(false);
    chapterSelectionGuardRef.current = false;
  }, [id]);

  useEffect(() => {
    const title = titleRef.current;
    if (!title || !scrollElement || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setTitleScrolledAway(entry ? !entry.isIntersecting : false),
      { root: scrollElement },
    );
    observer.observe(title);
    return () => observer.disconnect();
  }, [scrollElement, novelQuery.data?.id]);

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
  const closeReaderSettings = () => setReaderSettingsOpen(false);
  useOverlayBackNavigation(readerSettingsOpen, closeReaderSettings);

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
          color="warn"
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
          color="info"
          title={t("novel.loading")}
          message={t("novel.loadingMessage")}
        />
      </PageFrame>
    );
  }

  const loadError = novelQuery.error;
  if (loadError) {
    return (
      <PageFrame>
        <StateView
          color="danger"
          title={t("novel.loadFailed")}
          message={
            loadError instanceof Error
              ? loadError.message
              : String(loadError)
          }
        />
      </PageFrame>
    );
  }

  const novel = displayNovel;
  if (!novel) {
    return (
      <PageFrame>
        <StateView
          color="warn"
          title={t("novel.notFound")}
          message={t("novel.notFoundMessage", { id })}
        />
      </PageFrame>
    );
  }

  const allowSourceAccess = hasSourcePlugin;
  const sourceUrl = allowSourceAccess ? resolveNovelSourceUrl(novel) : null;
  const sourcePlugin = novel.isLocal || !allowSourceAccess
    ? null
    : pluginManager.getPlugin(novel.pluginId);
  const sourceName = novel.isLocal
    ? t("novel.localSource")
    : (novel.pluginName ?? sourcePlugin?.name ?? novel.pluginId);
  const metadataRefreshError =
    refreshMetadata.error ?? fullRefreshMetadata.error;
  // Automatic content-server lookups stay silent on normal pages (docs/content-sync.md);
  // offline and challenge failures are already surfaced by the task queue.
  const sourceRefreshFailure = serverSync.sourceError &&
    !isAbortError(serverSync.sourceError) &&
    !isNetworkUnavailableError(serverSync.sourceError) &&
    normalizeSourceAccessRequiredError(serverSync.sourceError) === null
    ? serverSync.sourceError
    : null;

  const overflowItems: OverflowMenuItem[] = [];
  if (!novel.isLocal) {
    overflowItems.push(
      {
        disabled: refreshMetadata.isPending || fullRefreshMetadata.isPending,
        icon: RefreshIcon,
        label: t("novel.checkNewChapters"),
        onClick: () => refreshMetadata.mutate(),
      },
      {
        disabled: refreshMetadata.isPending || fullRefreshMetadata.isPending,
        icon: RefreshAllIcon,
        label: t("novel.refreshAllDetails"),
        onClick: () => fullRefreshMetadata.mutate(),
      },
    );
  }
  if (novel.inLibrary && allowSourceAccess && !novel.isLocal) {
    overflowItems.push({
      icon: MigrateIcon,
      label: t("novel.mergeSource"),
      onClick: () =>
        void navigate({
          replace: true,
          search: { sourceNovelId: novel.id },
          to: "/novel-merge",
        }),
    });
  }
  if (allowSourceAccess && !novel.isLocal) {
    overflowItems.push({
      disabled: !sourceUrl,
      icon: SourceIcon,
      label: t("novel.openInWebView"),
      onClick: () => openSourceNovel(novel.pluginId, sourceUrl),
    });
  }
  overflowItems.push({
    icon: ReaderSettingsIcon,
    label: t("novel.readerSettingsForNovel"),
    onClick: () => setReaderSettingsOpen(true),
  });
  if (managedServerWork) {
    overflowItems.push({
      icon: ServerIcon,
      label: t("contentSync.manageChapters"),
      onClick: () => setServerManagerSource({ ...managedServerWork }),
    });
  }
  if (novel.isLocal) {
    overflowItems.push(
      {
        icon: EditIcon,
        label: t("novel.local.editMetadata"),
        onClick: openLocalMetadataEditor,
      },
      {
        disabled: addLocalChapters.isPending,
        icon: ImportIcon,
        label: t("novel.local.addChapters"),
        onClick: openLocalChapterInput,
      },
      {
        disabled: chapters.length < 2,
        icon: DragIcon,
        label: t("novel.local.reorderChapters"),
        onClick: () => {
          clearChapterSelectionState();
          setReorderMode(true);
        },
      },
    );
  }

  return (
    <>
      <div className="norea-novel-page" ref={setScrollElement}>
        <header
          className="norea-novel-app-bar"
          data-title-visible={titleScrolledAway ? "true" : undefined}
        >
          <IconButton label={t("common.back")} onClick={goBack} size="lg">
            <BackIcon />
          </IconButton>
          <span aria-hidden="true" className="norea-novel-app-bar-title">
            {novel.name}
          </span>
          <OverflowMenu items={overflowItems} label={t("novel.moreOptions")} />
        </header>
        <PageFrame className="norea-novel-frame" size="wide">
          <div className="norea-novel-layout">
            <aside className="norea-novel-info-pane">
              <NovelWorkspace
                key={novel.id}
                allowSourceAccess={allowSourceAccess}
                categoryChips={novel.inLibrary ? <NovelCategoryEditor key={novel.id}
                  active={active} novelId={novel.id} novelName={novel.name} /> : null}
                chapters={chapters}
                downloadStatuses={statuses}
                lastReadChapterId={lastReadChapterId}
                libraryBusy={toggle.isPending}
                novel={novel}
                onBatchDownload={downloadChapters}
                onRead={openChapter}
                onToggleLibrary={() => toggle.mutate()}
                sourceName={sourceName}
                titleRef={titleRef}
              />
            </aside>

            <section aria-labelledby={chaptersHeadingId} className="norea-novel-chapters">
              <div className="norea-novel-chapters-header">
                <h2 className="norea-novel-chapters-title" id={chaptersHeadingId}>
                  {t("novel.chapterSummary", {
                    total: chapters.length,
                    downloaded: chapterStats.downloaded,
                    unread: chapterStats.unread,
                  })}
                </h2>
                {reorderMode ? (
                  <Button onClick={() => setReorderMode(false)} variant="light">
                    {t("common.done")}
                  </Button>
                ) : (
                  <>
                    <ChapterSortPicker
                      onChange={setDefaultChapterSort}
                      value={defaultChapterSort}
                    />
                    {chapters.length > 0 && !chapterSelectionMode ? (
                      <Button
                        leftSection={<SelectIcon size="1.125rem" />}
                        onClick={() => setChapterSelectionMode(true)}
                        variant="subtle"
                      >
                        {t("novel.select")}
                      </Button>
                    ) : null}
                  </>
                )}
              </div>

              {chapterSelectionMode ? (
                <div className="norea-novel-selection-strip">
                  <span>
                    {t("novel.selection.selectedCount", {
                      count: selectedChapterCount,
                    })}
                  </span>
                  <div className="norea-novel-selection-actions">
                    <IconButton
                      className="norea-novel-selection-icon norea-state-layer"
                      disabled={allChaptersSelected}
                      label={t("novel.selection.selectAll")}
                      onClick={selectAllChapters}
                      size="sm"
                      title={t("novel.selection.selectAll")}
                    >
                      <CheckGlyph />
                    </IconButton>
                    <IconButton
                      className="norea-novel-selection-icon norea-state-layer"
                      disabled={selectedChapterCount === 0}
                      label={t("novel.selection.clearSelected")}
                      onClick={clearSelectedChapters}
                      size="sm"
                      title={t("novel.selection.clearSelected")}
                    >
                      <SelectionClearIcon />
                    </IconButton>
                    <IconButton
                      className="norea-novel-selection-icon norea-state-layer"
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
                      className="norea-novel-selection-icon norea-state-layer"
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
                      className="norea-novel-selection-icon norea-state-layer"
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
                      className="norea-novel-selection-icon norea-state-layer"
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
                    {selectedChapterCount > 0 ? (
                      <ChapterRelativeReadMenu
                        afterCount={selectedAnchorAfterCount}
                        beforeCount={selectedAnchorBeforeCount}
                        busy={chapterSelectionBusy}
                        previousDownloadCount={novel.isLocal ? 0 : previousDownloadTargets.length}
                        onDownloadPrevious={() => downloadChapters(previousDownloadTargets)}
                        showReadActions={selectedAnchorChapter !== undefined}
                        onMarkFollowingUnread={() =>
                          selectedAnchorChapter && setRelativeChapterReadState.mutate({
                            anchorChapterId: selectedAnchorChapter.id,
                            direction: "after",
                            unread: true,
                          })
                        }
                        onMarkPreviousRead={() =>
                          selectedAnchorChapter && setRelativeChapterReadState.mutate({
                            anchorChapterId: selectedAnchorChapter.id,
                            direction: "before",
                            unread: false,
                          })
                        }
                      />
                    ) : null}
                    <IconButton
                      className="norea-novel-selection-icon norea-state-layer"
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
                <Text c="danger" className="norea-novel-local-error" size="sm">
                  {localChapterError}
                </Text>
              ) : null}

              {metadataRefreshError ? (
                <Text c="danger" className="norea-novel-local-error" size="sm">
                  {metadataRefreshError instanceof Error
                    ? metadataRefreshError.message
                    : String(metadataRefreshError)}
                </Text>
              ) : null}

              {sourceRefreshFailure ? (
                <StateView
                  action={{ label: t("common.retry"), onClick: serverSync.retry }}
                  color="warn"
                  title={t("novel.syncFailed")}
                  message={
                    <span title={describeError(sourceRefreshFailure)}>
                      {t("contentSync.sourceRefreshFailed")}
                    </span>
                  }
                />
              ) : null}

              {chaptersQuery.isLoading ? (
                <StateView
                  color="info"
                  title={t("novel.loadingChapters")}
                  message={t("novel.loadingChaptersMessage")}
                />
              ) : chapters.length === 0 ? (
                <StateView
                  color="info"
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
                  canReorderChapters={novel.isLocal && reorderMode}
                  deleteBusyChapterId={clearDownload.variables}
                  duplicateSourceChapterCounts={sourceDuplicateChapterCounts}
                  deletePending={clearDownload.isPending}
                  lastReadChapterId={lastReadChapterId}
                  repairBusyChapterId={repairMedia.variables?.id}
                  repairPending={repairMedia.isPending}
                  reorderPending={reorderLocalChapters.isPending}
                  scrollElement={scrollElement}
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
            </section>
          </div>
        </PageFrame>
      </div>

      {serverManagerSource ? (
        <ServerChapterManager
          name={novel.name}
          onClose={() => setServerManagerSource(null)}
          source={serverManagerSource}
        />
      ) : null}

      <Drawer
        classNames={{
          body: "norea-reader-settings-drawer-body",
          content: "norea-reader-settings-drawer-content",
        }}
        opened={readerSettingsOpen}
        onClose={closeReaderSettings}
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
