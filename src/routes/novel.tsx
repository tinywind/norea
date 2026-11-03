import { Button, Drawer, Text, VisuallyHidden } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { PageFrame, StateView } from "../components/AppFrame";
import { IconButton } from "../components/IconButton";
import {
  BackIcon,
  CategoryIcon,
  DeleteDownloadIcon,
  DownloadIcon,
  DragIcon,
  EditIcon,
  ImportIcon,
  MarkReadIcon,
  MarkUnreadIcon,
  MigrateIcon,
  OverflowIcon,
  ReaderSettingsIcon,
  RefreshAllIcon,
  RefreshIcon,
  SelectIcon,
  ServerIcon,
  SourceIcon,
} from "../components/ui/icons";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { OverflowMenu, type OverflowMenuItem } from "../components/ui/OverflowMenu";
import { SelectionAction, SelectionBar } from "../components/ui/SelectionBar";
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
import { ChapterSortPicker } from "../components/novel/NovelActions";
import {
  ChapterRowsSkeleton,
  VirtualChapterList,
} from "../components/novel/NovelChapterList";
import { NovelHeroSkeleton, NovelWorkspace } from "../components/novel/NovelWorkspace";
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
  const confirm = useConfirm();
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
  const [categorySheetOpen, setCategorySheetOpen] = useState(false);
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
    setCategorySheetOpen(false);
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

  async function deleteChapterDownload(chapterId: number): Promise<void> {
    const chapter = chapters.find((row) => row.id === chapterId);
    const confirmed = await confirm({
      confirmLabel: t("common.delete"),
      danger: true,
      message: t("novel.deleteDownloadMessage", { name: chapter?.name ?? String(chapterId) }),
      title: t("novel.deleteDownload"),
    });
    if (confirmed) clearDownload.mutate(chapterId);
  }

  function showAddedToLibrary(novelId: number): void {
    const toastId = `novel-added-to-library:${novelId}`;
    notifications.show({
      color: "ok",
      id: toastId,
      message: (
        <span className="norea-novel-toast">
          <span>{t("novel.addedToLibrary")}</span>
          <Button
            onClick={() => {
              notifications.hide(toastId);
              setCategorySheetOpen(true);
            }}
            size="compact-sm"
            variant="subtle"
          >
            {t("novel.changeCategory")}
          </Button>
        </span>
      ),
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
      <div aria-busy="true" className="norea-novel-page">
        <header className="norea-novel-app-bar">
          <IconButton label={t("common.back")} onClick={goBack} size="lg">
            <BackIcon />
          </IconButton>
        </header>
        <PageFrame className="norea-novel-frame" size="wide">
          <div className="norea-novel-layout" role="status">
            <VisuallyHidden>{t("novel.loading")}</VisuallyHidden>
            <aside className="norea-novel-info-pane">
              <NovelHeroSkeleton />
            </aside>
            <section className="norea-novel-chapters">
              <ChapterRowsSkeleton />
            </section>
          </div>
        </PageFrame>
      </div>
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
  if (novel.inLibrary) {
    overflowItems.push({
      icon: CategoryIcon,
      label: t("categories.editWork"),
      onClick: () => setCategorySheetOpen(true),
    });
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

  const selectionMoreItems: OverflowMenuItem[] = [];
  if (!novel.isLocal) {
    selectionMoreItems.push({
      disabled: previousDownloadTargets.length === 0,
      icon: DownloadIcon,
      label: t("novel.selection.downloadPrevious", { count: previousDownloadTargets.length }),
      onClick: () => downloadChapters(previousDownloadTargets),
    });
  }
  if (selectedAnchorChapter) {
    const anchorChapterId = selectedAnchorChapter.id;
    selectionMoreItems.push(
      {
        disabled: selectedAnchorBeforeCount === 0,
        icon: MarkReadIcon,
        label: t("novel.selection.markPreviousRead", { count: selectedAnchorBeforeCount }),
        onClick: () =>
          setRelativeChapterReadState.mutate({ anchorChapterId, direction: "before", unread: false }),
      },
      {
        disabled: selectedAnchorAfterCount === 0,
        icon: MarkUnreadIcon,
        label: t("novel.selection.markFollowingUnread", { count: selectedAnchorAfterCount }),
        onClick: () =>
          setRelativeChapterReadState.mutate({ anchorChapterId, direction: "after", unread: true }),
      },
    );
  }

  return (
    <>
      <div className="norea-novel-page" ref={setScrollElement}>
        {chapterSelectionMode ? (
          <SelectionBar
            actions={
              <>
                <SelectionAction
                  disabled={selectedDownloadTargets.length === 0 || chapterSelectionBusy}
                  icon={DownloadIcon}
                  label={t("novel.selection.downloadSelected")}
                  onClick={() => downloadChapters(selectedDownloadTargets)}
                />
                <SelectionAction
                  disabled={selectedUnreadCount === 0 || chapterSelectionBusy}
                  icon={MarkReadIcon}
                  label={t("novel.selection.markRead")}
                  onClick={() =>
                    setSelectedChapterReadState.mutate({
                      chapterIds: selectedChapterIdList,
                      unread: false,
                    })
                  }
                />
                <SelectionAction
                  disabled={selectedReadCount === 0 || chapterSelectionBusy}
                  icon={MarkUnreadIcon}
                  label={t("novel.selection.markUnread")}
                  onClick={() =>
                    setSelectedChapterReadState.mutate({
                      chapterIds: selectedChapterIdList,
                      unread: true,
                    })
                  }
                />
                {novel.isLocal ? null : (
                  <SelectionAction
                    disabled={selectedDownloadedChapterIds.length === 0 || chapterSelectionBusy}
                    icon={DeleteDownloadIcon}
                    label={t("novel.selection.deleteDownloads")}
                    onClick={() => clearSelectedDownloads.mutate(selectedDownloadedChapterIds)}
                  />
                )}
                <OverflowMenu
                  items={selectionMoreItems}
                  label={t("common.more")}
                  trigger={
                    <SelectionAction
                      disabled={
                        chapterSelectionBusy ||
                        selectionMoreItems.every((item) => item.disabled)
                      }
                      icon={OverflowIcon}
                      label={t("common.more")}
                    />
                  }
                />
              </>
            }
            clearDisabled={selectedChapterCount === 0}
            label={t("novel.selection.selectedCount", { count: selectedChapterCount })}
            onClear={clearSelectedChapters}
            onExit={closeChapterSelectionMode}
            onSelectAll={selectAllChapters}
            selectAllDisabled={allChaptersSelected}
            selectAllPending={false}
          />
        ) : (
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
        )}
        <PageFrame className="norea-novel-frame" size="wide">
          <div className="norea-novel-layout">
            <aside className="norea-novel-info-pane">
              <NovelWorkspace
                key={novel.id}
                allowSourceAccess={allowSourceAccess}
                categoryChips={novel.inLibrary ? (
                  <NovelCategoryEditor
                    key={novel.id}
                    active={active}
                    novelId={novel.id}
                    novelName={novel.name}
                    onCloseSheet={() => setCategorySheetOpen(false)}
                    onOpenSheet={() => setCategorySheetOpen(true)}
                    sheetOpen={categorySheetOpen}
                  />
                ) : null}
                chapters={chapters}
                downloadStatuses={statuses}
                lastReadChapterId={lastReadChapterId}
                libraryBusy={toggle.isPending}
                novel={novel}
                onBatchDownload={downloadChapters}
                onRead={openChapter}
                onToggleLibrary={() =>
                  toggle.mutate(novel.inLibrary ? {
                    downloadedCount: chapterStats.downloaded,
                    serverWork: managedServerWork !== null,
                  } : undefined, {
                    onSuccess: (result) => {
                      if (result?.inLibrary) showAddedToLibrary(result.novel.id);
                    },
                  })
                }
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
                <div role="status">
                  <VisuallyHidden>{t("novel.loadingChapters")}</VisuallyHidden>
                  <ChapterRowsSkeleton />
                </div>
              ) : chapters.length === 0 ? (
                <StateView
                  title={t("novel.noChapters")}
                  message={t(novel.isLocal ? "novel.noLocalChaptersMessage" : "novel.noChaptersMessage")}
                  action={
                    novel.isLocal
                      ? {
                          label: t("novel.local.addChapters"),
                          onClick: openLocalChapterInput,
                        }
                      : {
                          label: t("common.refresh"),
                          onClick: () => fullRefreshMetadata.mutate(),
                        }
                  }
                />
              ) : (
                <VirtualChapterList
                  chapters={chapters}
                  canDeleteDownloads={!novel.isLocal}
                  reorderMode={novel.isLocal && reorderMode}
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
                    void deleteChapterDownload(chapterId);
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
