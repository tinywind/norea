import { useEffect, useMemo, useRef, useState } from "react";
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
  Group,
  Loader,
  Paper,
  Skeleton,
  Stack,
  Text,
} from "@mantine/core";
import { DetailsGlyph, RetryGlyph } from "../components/ActionGlyphs";
import { PageFrame, PageHeader, StateView } from "../components/AppFrame";
import { ConsoleCover } from "../components/ConsolePrimitives";
import { IconButton } from "../components/IconButton";
import {
  deleteAllDownloadCache,
  deleteDownloadCacheChapter,
  deleteDownloadCacheNovel,
  listDownloadCacheChapters,
  type DownloadCacheChapter,
  type DownloadCacheNovel,
} from "../db/queries/download-cache";
import {
  clearAllChapterMedia,
  clearChapterMedia,
} from "../lib/chapter-media";
import { scheduleDownloadCacheMediaBytesBackfill } from "../lib/download-cache-media";
import {
  loadDownloadCacheChapters,
  loadDownloadCacheNovels,
} from "../lib/download-cache-loaders";
import { enqueueChapterMediaRepair } from "../lib/tasks/chapter-download";
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

function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={spinning ? "lnr-downloads-spin-icon" : undefined}
      viewBox="0 0 24 24"
    >
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v6h-6" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 7h16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M6 7l1 14h10l1-14" />
      <path d="M9 7V4h6v3" />
    </svg>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d={expanded ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} />
    </svg>
  );
}

function DownloadCacheLoadingState() {
  return (
    <Stack className="lnr-downloads-loading" gap="xs">
      {[0, 1, 2].map((item) => (
        <Paper className="lnr-downloads-novel" key={item} withBorder>
          <div className="lnr-downloads-novel-row">
            <Skeleton height={84} radius={3} width={56} />
            <Box className="lnr-downloads-novel-main">
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
      color="red"
      title={t("downloads.loadFailed")}
      message={error instanceof Error ? error.message : String(error)}
      action={{
        icon: <RefreshIcon />,
        iconOnly: true,
        label: t("common.retry"),
        onClick: onRetry,
        size: "lg",
      }}
    />
  );
}

function DownloadCacheChapterRow({
  chapter,
  deleting,
  onRepair,
  onDelete,
  repairing,
}: {
  chapter: DownloadCacheChapter;
  deleting: boolean;
  onRepair: () => void;
  onDelete: () => void;
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
    <div className="lnr-downloads-chapter-row">
      <Box className="lnr-downloads-chapter-main">
        <Text className="lnr-downloads-chapter-title" title={chapter.name}>
          {chapter.name}
        </Text>
        <Text
          className="lnr-downloads-chapter-status"
          component="div"
          title={chapterStatusText}
        >
          {chapterStatusText}
        </Text>
      </Box>
      <Group className="lnr-downloads-row-actions" gap={6} wrap="nowrap">
        {chapter.mediaRepairNeeded ? (
          <Badge color="yellow" variant="light">
            {t("downloads.mediaFallback")}
          </Badge>
        ) : null}
        {chapter.mediaRepairNeeded ? (
          <IconButton
            className="lnr-downloads-icon-button"
            disabled={repairing}
            label={t("downloads.repairChapterMedia", { name: chapter.name })}
            onClick={onRepair}
            size="lg"
            title={t("downloads.repairChapterMedia", { name: chapter.name })}
          >
            {repairing ? <Loader size={14} /> : <RetryGlyph />}
          </IconButton>
        ) : null}
        <IconButton
          className="lnr-downloads-icon-button"
          disabled={deleting}
          label={t("downloads.deleteChapter", { name: chapter.name })}
          onClick={onDelete}
          size="lg"
          title={t("downloads.deleteChapter", { name: chapter.name })}
          tone="danger"
        >
          {deleting ? <Loader size={14} /> : <TrashIcon />}
        </IconButton>
      </Group>
    </div>
  );
}

function DownloadCacheChapters({
  novel,
}: {
  novel: DownloadCacheNovel;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const chapters = useQuery({
    queryKey: [...DOWNLOAD_CACHE_QUERY_KEY, "chapters", novel.novelId] as const,
    queryFn: () => loadDownloadCacheChapters(novel.novelId),
  });
  const deleteChapter = useMutation({
    mutationFn: async (chapterId: number) => {
      const result = await deleteDownloadCacheChapter(chapterId);
      await clearChapterMedia(chapterId);
      return result;
    },
    onSuccess: () => invalidateDownloadCache(queryClient),
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
      <div className="lnr-downloads-chapter-list">
        <Text className="lnr-downloads-note">{t("downloads.chaptersLoading")}</Text>
      </div>
    );
  }

  if (chapters.error) {
    return (
      <div className="lnr-downloads-chapter-list">
        <Text c="red" size="sm">
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
      <div className="lnr-downloads-chapter-list">
        <Text className="lnr-downloads-note">{t("downloads.chaptersEmpty")}</Text>
      </div>
    );
  }

  return (
    <div className="lnr-downloads-chapter-list">
      {rows.map((chapter) => (
        <DownloadCacheChapterRow
          key={chapter.id}
          chapter={chapter}
          deleting={
            deleteChapter.isPending &&
            deleteChapter.variables === chapter.id
          }
          repairing={
            repairChapter.isPending &&
            repairChapter.variables?.id === chapter.id
          }
          onDelete={() => {
            if (!window.confirm(t("downloads.deleteChapterConfirm", {
              name: chapter.name,
            }))) {
              return;
            }
            deleteChapter.mutate(chapter.id);
          }}
          onRepair={() => repairChapter.mutate(chapter)}
        />
      ))}
    </div>
  );
}

function DownloadCacheNovelCard({
  novel,
  onOpenNovel,
}: {
  novel: DownloadCacheNovel;
  onOpenNovel: () => void;
}) {
  const { locale, t } = useTranslation();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const deleteNovel = useMutation({
    mutationFn: async (novelId: number) => {
      const chapters = await listDownloadCacheChapters(novelId);
      const result = await deleteDownloadCacheNovel(novelId);
      await Promise.all(
        chapters.map((chapter) => clearChapterMedia(chapter.id)),
      );
      return result;
    },
    onSuccess: () => invalidateDownloadCache(queryClient),
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
  const statusText = [
    t("downloads.chapterCount", {
      cached: novel.chaptersDownloaded,
      total: novel.totalChapters,
    }),
    t("downloads.unreadRead", {
      read: novel.readDownloaded,
      unread: novel.unreadDownloaded,
    }),
    size,
    updatedLabel,
    novel.pluginId,
  ].join(" / ");
  const deletingNovel =
    deleteNovel.isPending && deleteNovel.variables === novel.novelId;
  const toggleLabel = expanded ? t("downloads.collapse") : t("downloads.expand");

  return (
    <Paper className="lnr-downloads-novel" component="article" withBorder>
      <div className="lnr-downloads-novel-row">
        <ConsoleCover
          alt={novel.novelName}
          height={84}
          src={novel.novelCover}
          width={56}
        />
        <Box className="lnr-downloads-novel-main">
          <Text
            className="lnr-downloads-novel-title"
            component="h2"
            title={novel.novelName}
          >
            {novel.novelName}
          </Text>
          <Text
            className="lnr-downloads-novel-status"
            component="div"
            title={statusText}
          >
            {statusText}
          </Text>
          <div className="lnr-downloads-novel-badge-line">
            <Badge
              className="lnr-downloads-library-badge"
              color={novel.inLibrary ? "green" : "gray"}
              title={libraryLabel}
              variant="light"
            >
              {libraryLabel}
            </Badge>
            {novel.mediaRepairNeededChapters > 0 ? (
              <Badge
                className="lnr-downloads-library-badge"
                color="yellow"
                title={t("downloads.mediaFallback")}
                variant="light"
              >
                {t("downloads.mediaFallback")}
              </Badge>
            ) : null}
          </div>
        </Box>
        <Group
          className="lnr-downloads-row-actions"
          gap={6}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          wrap="nowrap"
        >
          <IconButton
            active={expanded}
            aria-expanded={expanded}
            className="lnr-downloads-icon-button"
            label={toggleLabel}
            onClick={() => setExpanded((current) => !current)}
            size="lg"
            title={toggleLabel}
          >
            <ChevronIcon expanded={expanded} />
          </IconButton>
          <IconButton
            className="lnr-downloads-icon-button"
            label={t("downloads.openNovel")}
            onClick={onOpenNovel}
            size="lg"
            title={t("downloads.openNovel")}
          >
            <DetailsGlyph />
          </IconButton>
          <IconButton
            className="lnr-downloads-icon-button"
            disabled={deletingNovel}
            label={t("downloads.deleteNovel", { name: novel.novelName })}
            onClick={() => {
              if (!window.confirm(t("downloads.deleteNovelConfirm", {
                count: novel.chaptersDownloaded,
                name: novel.novelName,
                size,
              }))) {
                return;
              }
              deleteNovel.mutate(novel.novelId);
            }}
            size="lg"
            title={t("downloads.deleteNovel", { name: novel.novelName })}
            tone="danger"
          >
            {deletingNovel ? <Loader size={14} /> : <TrashIcon />}
          </IconButton>
        </Group>
      </div>
      {expanded ? <DownloadCacheChapters novel={novel} /> : null}
    </Paper>
  );
}

export function DownloadsPage() {
  const { locale, t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const scheduledBackfillRef = useRef(false);
  const query = useQuery({
    queryKey: DOWNLOAD_CACHE_QUERY_KEY,
    queryFn: loadDownloadCacheNovels,
  });

  useEffect(() => {
    if (!query.data?.length || scheduledBackfillRef.current) return;
    scheduledBackfillRef.current = true;
    scheduleDownloadCacheMediaBytesBackfill(undefined, {
      onComplete: (result) => {
        if (result.updatedChapters === 0) return;
        void queryClient.invalidateQueries({
          queryKey: DOWNLOAD_CACHE_QUERY_KEY,
        });
      },
      onSettled: () => {
        scheduledBackfillRef.current = false;
      },
    });
  }, [query.data, queryClient]);
  const [mediaFallbackOnly, setMediaFallbackOnly] = useState(false);
  const deleteAll = useMutation({
    mutationFn: async () => {
      const result = await deleteAllDownloadCache();
      await clearAllChapterMedia();
      return result;
    },
    onSuccess: () => invalidateDownloadCache(queryClient),
  });
  const rows = query.data ?? [];
  const visibleRows = mediaFallbackOnly
    ? rows.filter((novel) => novel.mediaRepairNeededChapters > 0)
    : rows;
  const totals = useMemo(() => getCacheTotals(rows), [rows]);
  const totalSize = formatBytes(totals.bytes, locale);

  return (
    <PageFrame className="lnr-downloads-page" size="wide">
      <PageHeader
        title={t("downloads.title")}
        description={t("downloads.description")}
        meta={
          <>
            <Badge variant="light">
              {t("downloads.summary.novels", { count: totals.novels })}
            </Badge>
            <Badge variant="light">
              {t("downloads.summary.chapters", { count: totals.chapters })}
            </Badge>
            <Badge variant="light">
              {t("downloads.summary.size", { size: totalSize })}
            </Badge>
            {totals.repairNeeded > 0 ? (
              <Badge color="yellow" variant="light">
                {t("downloads.mediaFallback")}
              </Badge>
            ) : null}
          </>
        }
        actions={
          <>
            <IconButton
              active={mediaFallbackOnly}
              className="lnr-downloads-header-button"
              disabled={totals.repairNeeded === 0}
              label={t("downloads.filterMediaFallback")}
              onClick={() =>
                setMediaFallbackOnly((current) => !current)
              }
              size="lg"
              title={t("downloads.filterMediaFallback")}
            >
              <RetryGlyph />
            </IconButton>
            <IconButton
              className="lnr-downloads-header-button"
              disabled={query.isFetching}
              label={t("downloads.refresh")}
              onClick={() => {
                void query.refetch();
              }}
              size="lg"
              title={t("downloads.refresh")}
            >
              <RefreshIcon spinning={query.isFetching} />
            </IconButton>
            <IconButton
              className="lnr-downloads-header-button"
              disabled={rows.length === 0 || deleteAll.isPending}
              label={t("downloads.deleteAll")}
              onClick={() => {
                if (!window.confirm(t("downloads.deleteAllConfirm", {
                  chapters: totals.chapters,
                  size: totalSize,
                }))) {
                  return;
                }
                deleteAll.mutate();
              }}
              size="lg"
              title={t("downloads.deleteAll")}
              tone="danger"
            >
              {deleteAll.isPending ? <Loader size={14} /> : <TrashIcon />}
            </IconButton>
          </>
        }
      />

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
          color="blue"
          title={t("downloads.empty.title")}
          message={t("downloads.empty.message")}
        />
      ) : visibleRows.length === 0 ? (
        <StateView
          color="blue"
          title={t("downloads.emptyFiltered.title")}
          message={t("downloads.emptyFiltered.message")}
        />
      ) : (
        <Stack gap="xs">
          {visibleRows.map((novel) => (
            <DownloadCacheNovelCard
              key={novel.novelId}
              novel={novel}
              onOpenNovel={() => {
                void navigate({ to: "/novel", search: { id: novel.novelId } });
              }}
            />
          ))}
        </Stack>
      )}
    </PageFrame>
  );
}
