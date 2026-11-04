import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Collapse,
  Group,
  Loader,
  Paper,
  Skeleton,
  Stack,
  Text,
} from "@mantine/core";
import { PageFrame, PageHeader, StateView } from "../components/AppFrame";
import { ChapterCleanupPanel } from "../components/ChapterCleanupPanel";
import { ConsoleCover } from "../components/ConsolePrimitives";
import { IconButton } from "../components/IconButton";
import { ListRow } from "../components/ui/ListRow";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  DeleteDownloadIcon,
  FilterIcon,
  OpenWorkIcon,
  PlayIcon,
  RefreshIcon,
  RepairIcon,
  SelectIcon,
} from "../components/ui/icons";
import { OverflowMenu, type OverflowMenuItem } from "../components/ui/OverflowMenu";
import { SelectionAction, SelectionBar } from "../components/ui/SelectionBar";
import {
  type DownloadCacheChapter,
  type DownloadCacheNovel,
} from "../db/queries/download-cache";
import { scheduleDownloadCacheMediaBytesBackfill } from "../lib/download-cache-media";
import {
  loadDownloadCacheChapters,
  loadDownloadCacheNovels,
} from "../lib/download-cache-loaders";
import { enqueueChapterMediaRepair } from "../lib/tasks/chapter-download";
import { confirmContentDeletion } from "../store/content-deletion";
import { showErrorToast } from "../lib/runtime/error-toast";
import { pluginManager } from "../lib/plugins/manager";
import { useNovelCoverSource } from "../lib/use-novel-cover-source";
import { useFinishedChapterCleanupStore } from "../lib/finished-chapter-cleanup";
import { useDownloadGoalSettingsStore } from "../store/download-goals";
import { useReaderStore } from "../store/reader";
import {
  formatRelativeTimeForLocale,
  useTranslation,
  type AppLocale,
} from "../i18n";
import "../styles/downloads.css";

const DOWNLOAD_CACHE_QUERY_KEY = ["download-cache"] as const;

function invalidateDownloadCache(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: DOWNLOAD_CACHE_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: ["chapter"] });
  void queryClient.invalidateQueries({ queryKey: ["novel"] });
}

function showDownloadCacheDeleteError(error: Error, title: string): void {
  showErrorToast(title, error, `downloads:delete:${title}`);
}

function formatBytes(bytes: number, locale: AppLocale): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = Math.max(0, bytes);
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const maximumFractionDigits = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits,
  }).format(value)} ${units[unitIndex]}`;
}

function getCacheTotals(novels: readonly DownloadCacheNovel[]) {
  return novels.reduce(
    (totals, novel) => ({
      chapters: totals.chapters + novel.chaptersDownloaded,
      novels: totals.novels + 1,
      repairNeeded: totals.repairNeeded + novel.mediaRepairNeededChapters,
      bytes: totals.bytes + novel.totalBytes,
    }),
    { bytes: 0, chapters: 0, novels: 0, repairNeeded: 0 },
  );
}

/**
 * The downloaded chapter Read opens: where the reader left off when that chapter is
 * stored, else the first unread one, else the first stored chapter.
 */
export function downloadedChapterToRead(
  chapters: readonly DownloadCacheChapter[],
  rememberedChapterId: number | undefined,
): DownloadCacheChapter | undefined {
  const ordered = [...chapters].sort((left, right) => left.position - right.position);
  return ordered.find((chapter) => chapter.id === rememberedChapterId)
    ?? ordered.find((chapter) => chapter.unread)
    ?? ordered[0];
}

function DownloadCacheLoadingState() {
  return (
    <Stack className="norea-downloads-loading" gap="xs">
      {[0, 1, 2].map((item) => (
        <Paper className="norea-downloads-novel" key={item} withBorder>
          <div className="norea-downloads-novel-row">
            <Skeleton height={84} radius={3} width={56} />
            <Box className="norea-downloads-novel-main">
              <Skeleton height={14} radius={3} width="42%" />
              <Skeleton height={10} mt={10} radius={3} width="70%" />
              <Skeleton height={10} mt={8} radius={3} width="48%" />
            </Box>
          </div>
        </Paper>
      ))}
    </Stack>
  );
}

function DownloadCacheErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <StateView
      color="danger"
      title={t("downloads.loadFailed")}
      message={error instanceof Error ? error.message : String(error)}
      action={{ label: t("common.retry"), onClick: onRetry }}
    />
  );
}

function DownloadCacheChapterRow({
  chapter,
  deleting,
  onDelete,
  onRead,
  onRepair,
  repairing,
}: {
  chapter: DownloadCacheChapter;
  deleting: boolean;
  onDelete: () => void;
  onRead: () => void;
  onRepair: () => void;
  repairing: boolean;
}) {
  const { locale, t } = useTranslation();
  const size = formatBytes(chapter.totalBytes, locale);
  const readState = chapter.unread
    ? t("downloads.unreadState")
    : t("downloads.readState");
  const chapterStatusText = [
    t("downloads.chapterMeta", {
      position: chapter.position,
      size,
    }),
    readState,
    t("downloads.progress", { progress: chapter.progress }),
  ].join(" / ");

  return (
    <div className="norea-downloads-chapter-row">
      <Box className="norea-downloads-chapter-main">
        <Text className="norea-downloads-chapter-title" title={chapter.name}>
          {chapter.name}
        </Text>
        <Text
          className="norea-downloads-chapter-status"
          component="div"
          title={chapterStatusText}
        >
          {chapterStatusText}
        </Text>
      </Box>
      <Group className="norea-downloads-row-actions" gap={6} wrap="nowrap">
        {chapter.mediaRepairNeeded ? (
          <Badge color="warn" variant="light">
            {t("downloads.mediaFallback")}
          </Badge>
        ) : null}
        <IconButton
          className="norea-downloads-icon-button"
          disabled={deleting}
          label={t("downloads.readChapter", { name: chapter.name })}
          onClick={onRead}
          size="lg"
          title={t("downloads.readChapter", { name: chapter.name })}
        >
          <PlayIcon />
        </IconButton>
        {chapter.mediaRepairNeeded ? (
          <IconButton
            className="norea-downloads-icon-button"
            disabled={repairing || deleting}
            label={t("downloads.repairChapterMedia", { name: chapter.name })}
            onClick={onRepair}
            size="lg"
            title={t("downloads.repairChapterMedia", { name: chapter.name })}
          >
            {repairing ? <Loader size={14} /> : <RepairIcon />}
          </IconButton>
        ) : null}
        <IconButton
          className="norea-downloads-icon-button"
          disabled={deleting}
          label={t("downloads.deleteChapter", { name: chapter.name })}
          onClick={onDelete}
          size="lg"
          title={t("downloads.deleteChapter", { name: chapter.name })}
          tone="danger"
        >
          {deleting ? <Loader size={14} /> : <DeleteDownloadIcon />}
        </IconButton>
      </Group>
    </div>
  );
}

function DownloadCacheChapters({
  novel,
  novelDeleting,
  onReadChapter,
}: {
  novel: DownloadCacheNovel;
  novelDeleting: boolean;
  onReadChapter: (chapterId: number) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const chapters = useQuery({
    meta: { errorPresentation: "inline" },
    queryKey: [...DOWNLOAD_CACHE_QUERY_KEY, "chapters", novel.novelId] as const,
    queryFn: () => loadDownloadCacheChapters(novel.novelId),
  });
  const deleteChapter = useMutation({
    mutationFn: (chapter: DownloadCacheChapter) =>
      confirmContentDeletion({
        kind: "downloads", scope: "chapter",
        ids: [chapter.id],
        title: t("tasks.task.deleteDownloadCacheChapter", {
          name: chapter.name,
        }),
      }),
    onSettled: () => invalidateDownloadCache(queryClient),
    onError: (error) =>
      showDownloadCacheDeleteError(error, t("tasks.task.deleteDownloadCache")),
  });
  const repairChapter = useMutation({
    mutationFn: async (chapter: DownloadCacheChapter) => {
      await enqueueChapterMediaRepair({
        id: chapter.id,
        pluginId: novel.pluginId,
        priority: "user",
        title: t("tasks.task.repairChapterMedia", { name: chapter.name }),
      }).promise;
    },
    onSuccess: () => invalidateDownloadCache(queryClient),
  });

  if (chapters.isLoading) {
    return (
      <div className="norea-downloads-chapter-list">
        <Text className="norea-downloads-note">{t("downloads.chaptersLoading")}</Text>
      </div>
    );
  }

  if (chapters.error) {
    return (
      <div className="norea-downloads-chapter-list">
        <Text c="danger" size="sm">
          {chapters.error instanceof Error
            ? chapters.error.message
            : String(chapters.error)}
        </Text>
      </div>
    );
  }

  const rows = chapters.data ?? [];
  if (rows.length === 0) {
    return (
      <div className="norea-downloads-chapter-list">
        <Text className="norea-downloads-note">{t("downloads.chaptersEmpty")}</Text>
      </div>
    );
  }

  return (
    <div className="norea-downloads-chapter-list">
      {rows.map((chapter) => (
        <DownloadCacheChapterRow
          key={chapter.id}
          chapter={chapter}
          deleting={
            novelDeleting ||
            (deleteChapter.isPending && deleteChapter.variables?.id === chapter.id)
          }
          repairing={
            repairChapter.isPending &&
            repairChapter.variables?.id === chapter.id
          }
          onDelete={() => {
            deleteChapter.mutate(chapter);
          }}
          onRead={() => onReadChapter(chapter.id)}
          onRepair={() => repairChapter.mutate(chapter)}
        />
      ))}
    </div>
  );
}

function DownloadCacheNovelCard({
  allDeleting,
  novel,
  onOpenNovel,
  onReadChapter,
  onToggleSelected,
  selected,
  selectionMode,
}: {
  allDeleting: boolean;
  novel: DownloadCacheNovel;
  onOpenNovel: () => void;
  onReadChapter: (chapterId: number) => void;
  onToggleSelected: () => void;
  selected: boolean;
  selectionMode: boolean;
}) {
  const { locale, t } = useTranslation();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const plugin = novel.inLibrary
    ? null
    : pluginManager.getPlugin(novel.pluginId);
  const coverSource = useNovelCoverSource(
    {
      cover: novel.novelCover,
      id: novel.novelId,
      isLocal: false,
      name: novel.novelName,
      path: novel.novelPath,
      pluginId: novel.pluginId,
    },
    {
      allowSourceFallback: Boolean(plugin),
      plugin,
    },
  );
  const deleteNovel = useMutation({
    mutationFn: (novelId: number) =>
      confirmContentDeletion({
        kind: "downloads", scope: "novel",
        ids: [novelId],
        title: t("tasks.task.deleteDownloadCacheNovel", {
          name: novel.novelName,
        }),
      }),
    onSettled: () => invalidateDownloadCache(queryClient),
    onError: (error) =>
      showDownloadCacheDeleteError(error, t("tasks.task.deleteDownloadCache")),
  });
  const readNovel = useMutation({
    mutationFn: async () => {
      const chapters = await queryClient.fetchQuery({
        queryKey: [...DOWNLOAD_CACHE_QUERY_KEY, "chapters", novel.novelId] as const,
        queryFn: () => loadDownloadCacheChapters(novel.novelId),
      });
      const remembered = useReaderStore.getState().lastReadChapterByNovel[novel.novelId];
      return downloadedChapterToRead(chapters, remembered);
    },
    onMutate: () => setReadError(null),
    onSuccess: (chapter) => {
      if (chapter) onReadChapter(chapter.id);
      else setReadError(t("downloads.chaptersEmpty"));
    },
    onError: (error) => setReadError(error instanceof Error ? error.message : String(error)),
  });
  const size = formatBytes(novel.totalBytes, locale);
  const libraryLabel = novel.inLibrary
    ? t("downloads.inLibrary")
    : t("downloads.outsideLibrary");
  const updatedLabel = t("downloads.lastUpdated", {
    time: formatRelativeTimeForLocale(
      locale,
      novel.lastDownloadedAt,
      "compact",
    ),
  });
  const sourceName = novel.pluginName ?? novel.pluginId;
  const countText = [
    t("downloads.chapterCount", {
      cached: novel.chaptersDownloaded,
      total: novel.totalChapters,
    }),
    size,
  ].join(" · ");
  const detailText = [
    t("downloads.unreadRead", {
      read: novel.readDownloaded,
      unread: novel.unreadDownloaded,
    }),
    updatedLabel,
    sourceName,
  ].join(" / ");
  const novelDeleting = allDeleting || deleteNovel.isPending;
  const toggleLabel = expanded ? t("downloads.collapse") : t("downloads.expand");
  const menuItems: OverflowMenuItem[] = [
    { icon: OpenWorkIcon, label: t("downloads.openNovel"), disabled: novelDeleting, onClick: onOpenNovel },
    {
      icon: DeleteDownloadIcon,
      label: t("downloads.deleteNovel", { name: novel.novelName }),
      danger: true,
      disabled: novelDeleting,
      onClick: () => deleteNovel.mutate(novel.novelId),
    },
  ];

  return (
    <Paper
      className="norea-downloads-novel"
      component="article"
      data-selected={selected ? "true" : undefined}
      withBorder
    >
      <div
        className="norea-downloads-novel-row"
        data-selecting={selectionMode ? "true" : undefined}
        onClick={selectionMode ? onToggleSelected : undefined}
      >
        {selectionMode ? (
          <Checkbox
            aria-label={t("downloads.selectNovel", { name: novel.novelName })}
            checked={selected}
            className="norea-downloads-select"
            onChange={onToggleSelected}
            onClick={(event) => event.stopPropagation()}
          />
        ) : null}
        <ConsoleCover
          alt={novel.novelName}
          height={84}
          src={coverSource}
          width={56}
        />
        <Box className="norea-downloads-novel-main">
          <Text
            className="norea-downloads-novel-title"
            component="h2"
            title={novel.novelName}
          >
            {novel.novelName}
          </Text>
          <Text className="norea-downloads-novel-count" component="div" title={countText}>
            {countText}
          </Text>
          <Text
            className="norea-downloads-novel-status"
            component="div"
            title={detailText}
          >
            {detailText}
          </Text>
          <div className="norea-downloads-novel-badge-line">
            <Badge
              className="norea-downloads-library-badge"
              color="ok"
              title={libraryLabel}
              variant={novel.inLibrary ? "light" : "default"}
            >
              {libraryLabel}
            </Badge>
            {novel.mediaRepairNeededChapters > 0 ? (
              <Badge
                className="norea-downloads-library-badge"
                color="warn"
                title={t("downloads.mediaFallbackCount", { count: novel.mediaRepairNeededChapters })}
                variant="light"
              >
                {t("downloads.mediaFallbackCount", { count: novel.mediaRepairNeededChapters })}
              </Badge>
            ) : null}
          </div>
          {readError ? <Text c="danger" size="sm">{readError}</Text> : null}
        </Box>
        {selectionMode ? null : (
          <Group
            className="norea-downloads-row-actions"
            gap={6}
            wrap="nowrap"
          >
            <IconButton
              className="norea-downloads-icon-button"
              disabled={novelDeleting || readNovel.isPending}
              label={t("downloads.readNovel", { name: novel.novelName })}
              onClick={() => readNovel.mutate()}
              size="lg"
              title={t("downloads.readNovel", { name: novel.novelName })}
            >
              {readNovel.isPending ? <Loader size={14} /> : <PlayIcon />}
            </IconButton>
            <IconButton
              active={expanded}
              aria-expanded={expanded}
              className="norea-downloads-icon-button"
              disabled={novelDeleting}
              label={toggleLabel}
              onClick={() => setExpanded((current) => !current)}
              size="lg"
              title={toggleLabel}
            >
              {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
            </IconButton>
            {novelDeleting ? <Loader size={14} /> : (
              <OverflowMenu items={menuItems} label={t("vpnDownload.workOptions", { title: novel.novelName })} />
            )}
          </Group>
        )}
      </div>
      <Collapse expanded={expanded && !selectionMode} keepMounted={false}>
        <DownloadCacheChapters
          novel={novel}
          novelDeleting={novelDeleting}
          onReadChapter={onReadChapter}
        />
      </Collapse>
    </Paper>
  );
}

/** Where automatic removal of finished chapters stands, and the way to its setting. */
function FinishedChapterCleanupRow({ onOpenSetting }: { onOpenSetting: () => void }) {
  const { locale, t } = useTranslation();
  const queryClient = useQueryClient();
  const keep = useDownloadGoalSettingsStore((state) => state.finishedChapterKeep);
  const lastRemoval = useFinishedChapterCleanupStore((state) => state.lastRemoval);
  const removedAt = lastRemoval?.at;

  useEffect(() => {
    if (removedAt !== undefined) invalidateDownloadCache(queryClient);
  }, [queryClient, removedAt]);

  return (
    <ListRow
      className="norea-downloads-auto-cleanup"
      onClick={onOpenSetting}
      subtitle={lastRemoval ? t("finishedCleanup.lastRemoval", {
        count: lastRemoval.deleted,
        size: formatBytes(lastRemoval.bytesFreed, locale),
        time: formatRelativeTimeForLocale(locale, lastRemoval.at),
      }) : undefined}
      title={t("finishedCleanup.storageRow", {
        state: keep === 0
          ? t("settings.downloads.finishedCleanup.off")
          : t("settings.downloads.finishedCleanup.keep", { count: keep }),
      })}
      trailing={<ChevronRightIcon size="1.125rem" />}
    />
  );
}

interface DownloadsStorageViewProps {
  active?: boolean;
  /** Leaves Downloads; the page header's back button. */
  onBack?: () => void;
  viewSwitcher?: ReactNode;
}

export function DownloadsStorageView({
  active = true,
  onBack,
  viewSwitcher,
}: DownloadsStorageViewProps = {}) {
  const { locale, t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const scheduledBackfillRef = useRef(false);
  const query = useQuery({
    meta: { errorPresentation: "inline" },
    queryKey: DOWNLOAD_CACHE_QUERY_KEY,
    queryFn: loadDownloadCacheNovels,
  });

  useEffect(() => {
    if (!active || !query.data?.length || scheduledBackfillRef.current) return;
    scheduledBackfillRef.current = true;
    scheduleDownloadCacheMediaBytesBackfill(undefined, {
      onComplete: (result) => {
        if (result.processedChapters === 0) return;
        void queryClient.invalidateQueries({
          queryKey: DOWNLOAD_CACHE_QUERY_KEY,
        });
      },
      onSettled: () => {
        scheduledBackfillRef.current = false;
      },
    });
  }, [active, query.data, queryClient]);
  const [mediaFallbackOnly, setMediaFallbackOnly] = useState(false);
  const [cleanupOpened, setCleanupOpened] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(() => new Set());
  const deleteAll = useMutation({
    mutationFn: () =>
      confirmContentDeletion({
        kind: "downloads", scope: "all",
        title: t("tasks.task.deleteDownloadCache"),
      }),
    onSettled: () => invalidateDownloadCache(queryClient),
    onError: (error) =>
      showDownloadCacheDeleteError(error, t("tasks.task.deleteDownloadCache")),
  });
  const rows = query.data ?? [];
  const visibleRows = mediaFallbackOnly
    ? rows.filter((novel) => novel.mediaRepairNeededChapters > 0)
    : rows;
  const totals = useMemo(() => getCacheTotals(rows), [rows]);
  const totalSize = formatBytes(totals.bytes, locale);
  const selectedRows = visibleRows.filter((novel) => selectedIds.has(novel.novelId));
  const exitSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };
  const deleteSelected = useMutation({
    mutationFn: (novels: readonly DownloadCacheNovel[]) => {
      const selectedTotals = getCacheTotals(novels);
      return confirmContentDeletion({
        kind: "downloads", scope: "novel",
        ids: novels.map((novel) => novel.novelId),
        title: t("downloads.deleteSelectedTitle", {
          chapters: selectedTotals.chapters,
          count: selectedTotals.novels,
          size: formatBytes(selectedTotals.bytes, locale),
        }),
      });
    },
    onSuccess: (changed) => { if (changed) exitSelection(); },
    onSettled: () => invalidateDownloadCache(queryClient),
    onError: (error) =>
      showDownloadCacheDeleteError(error, t("tasks.task.deleteDownloadCache")),
  });

  useEffect(() => {
    if (!active && selectionMode) exitSelection();
  }, [active, selectionMode]);

  const toggleSelected = (novelId: number) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(novelId)) next.delete(novelId);
      else next.add(novelId);
      return next;
    });
  };
  const readChapter = (chapterId: number) => {
    void navigate({ to: "/reader", search: { chapterId } });
  };
  const headerItems: OverflowMenuItem[] = [
    { icon: SelectIcon, label: t("library.selection.start"), disabled: visibleRows.length === 0,
      onClick: () => setSelectionMode(true) },
    {
      icon: FilterIcon,
      label: mediaFallbackOnly ? t("downloads.showAllNovels") : t("downloads.filterMediaFallback"),
      disabled: !mediaFallbackOnly && totals.repairNeeded === 0,
      onClick: () => setMediaFallbackOnly((current) => !current),
    },
    { icon: RefreshIcon, label: t("downloads.refresh"), disabled: query.isFetching,
      onClick: () => { void query.refetch(); } },
    { icon: DeleteDownloadIcon, label: t("downloads.deleteAll"), danger: true,
      disabled: rows.length === 0 || deleteAll.isPending, onClick: () => deleteAll.mutate() },
  ];

  // Both header states keep this row, so selecting never moves the list.
  const subrow = (
    <div className="norea-downloads-subrow">
      {viewSwitcher}
      <div className="norea-task-summary-strip">
        <span className="norea-task-summary-pill">
          {t("downloads.summary.novels", { count: totals.novels })}
        </span>
        <span className="norea-task-summary-pill">
          {t("downloads.summary.chapters", { count: totals.chapters })}
        </span>
        <span className="norea-task-summary-pill">
          {t("downloads.summary.size", { size: totalSize })}
        </span>
        {totals.repairNeeded > 0 ? (
          <span className="norea-task-summary-pill" data-tone="warning">
            {t("downloads.mediaFallback")}
          </span>
        ) : null}
      </div>
    </div>
  );

  return (
    <PageFrame
      className="norea-downloads-page norea-downloads-hub"
      header={active && selectionMode ? (
        <SelectionBar
          actions={
            <SelectionAction
              disabled={selectedRows.length === 0 || deleteSelected.isPending}
              icon={DeleteDownloadIcon}
              label={t("downloads.deleteSelected")}
              onClick={() => deleteSelected.mutate(selectedRows)}
            />
          }
          allSelected={visibleRows.length > 0 && selectedRows.length === visibleRows.length}
          label={t("library.selectedCount", { count: selectedRows.length })}
          onDeselectAll={() => setSelectedIds(new Set())}
          onExit={exitSelection}
          onSelectAll={() => setSelectedIds(new Set(visibleRows.map((novel) => novel.novelId)))}
          selectAllDisabled={visibleRows.length === 0}
          selectAllPending={false}
        />
      ) : (
        <PageHeader
          actions={
            <>
              <Button
                disabled={rows.length === 0}
                leftSection={<DeleteDownloadIcon size="1.125rem" />}
                onClick={() => setCleanupOpened(true)}
                variant="subtle"
              >
                {t("downloads.cleanUp")}
              </Button>
              <OverflowMenu items={headerItems} label={t("common.more")} />
            </>
          }
          below={subrow}
          onBack={onBack}
          title={t("downloads.title")}
        />
      )}
      size="wide"
    >
      {active && selectionMode ? null : (
        <Text className="norea-downloads-description">{t("downloads.description")}</Text>
      )}
      <ChapterCleanupPanel opened={active && cleanupOpened} onClose={() => setCleanupOpened(false)} />
      {rows.length > 0 ? (
        <FinishedChapterCleanupRow
          onOpenSetting={() => { void navigate({ to: "/settings", search: { section: "downloads" } }); }}
        />
      ) : null}

      <div className="norea-downloads-body">
        {query.isLoading ? (
          <DownloadCacheLoadingState />
        ) : query.error ? (
          <DownloadCacheErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : rows.length === 0 ? (
          <StateView
            color="info"
            title={t("downloads.empty.title")}
            message={t("downloads.empty.message")}
          />
        ) : visibleRows.length === 0 ? (
          <StateView
            color="info"
            title={t("downloads.emptyFiltered.title")}
            message={t("downloads.emptyFiltered.message")}
          />
        ) : (
          <Stack gap="xs">
            {visibleRows.map((novel) => (
              <DownloadCacheNovelCard
                key={novel.novelId}
                allDeleting={deleteAll.isPending}
                novel={novel}
                onOpenNovel={() => {
                  void navigate({
                    to: "/novel",
                    search: { id: novel.novelId },
                  });
                }}
                onReadChapter={readChapter}
                onToggleSelected={() => toggleSelected(novel.novelId)}
                selected={selectedIds.has(novel.novelId)}
                selectionMode={selectionMode}
              />
            ))}
          </Stack>
        )}
      </div>
    </PageFrame>
  );
}
