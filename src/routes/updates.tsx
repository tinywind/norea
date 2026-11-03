import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button, Group, Loader, Stack, Text } from "@mantine/core";
import { DetailsGlyph } from "../components/ActionGlyphs";
import {
  ConsolePanel,
  ConsoleStatusDot,
} from "../components/ConsolePrimitives";
import { PageFrame, StateView } from "../components/AppFrame";
import { IconButton } from "../components/IconButton";
import { RefreshIcon } from "../components/ui/icons";
import {
  daysBefore,
  groupUpdatesByDate,
  type UpdateListItem,
} from "../components/updates/update-groups";
import {
  UpdateRow,
  UpdateRowsSkeleton,
  UpdateRunRow,
} from "../components/updates/UpdateRows";
import {
  listLibraryUpdatesPage,
  type LibraryUpdateEntry,
  type LibraryUpdatesCursor,
} from "../db/queries/chapter";
import {
  enqueueChapterDownload,
  listChapterDownloadStatuses,
  subscribeChapterDownloads,
  type ChapterDownloadStatus,
} from "../lib/tasks/chapter-download";
import {
  checkLibraryUpdates,
  type UpdateCheckFailure,
} from "../lib/updates/check-library-updates";
import {
  getUpdatesIndexRevision,
  subscribeUpdatesIndexChanges,
} from "../lib/updates/update-index-events";
import { describeError } from "../lib/errors";
import { useTranslation, type AppLocale } from "../i18n";
import { useUpdatesStore } from "../store/updates";
import "../styles/updates.css";

const UPDATES_PAGE_SIZE = 100;
const UPDATES_INDEX_REFRESH_DEBOUNCE_MS = 500;
const UPDATES_INDEX_REFRESH_LIMIT = UPDATES_PAGE_SIZE;
const LOAD_MORE_THRESHOLD_PX = 480;
const APP_SCROLL_SELECTOR = ".norea-app-scroll";

function getUpdatesScrollElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(APP_SCROLL_SELECTOR);
}

function getUpdatesScrollMetrics(): {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
} {
  const scrollContainer = getUpdatesScrollElement();
  if (scrollContainer) {
    return {
      clientHeight: scrollContainer.clientHeight,
      scrollHeight: scrollContainer.scrollHeight,
      scrollTop: scrollContainer.scrollTop,
    };
  }

  const scrollElement = document.scrollingElement ?? document.documentElement;
  return {
    clientHeight: window.innerHeight,
    scrollHeight: scrollElement.scrollHeight,
    scrollTop: scrollElement.scrollTop,
  };
}

function formatUpdateDay(
  dayStart: number,
  locale: AppLocale,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const now = new Date();
  const delta = daysBefore(dayStart, now);
  if (delta === 0) return t("time.today");
  if (delta === 1) return t("time.yesterday");
  const date = new Date(dayStart);
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    weekday: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
}

interface FailureRowProps {
  failure: UpdateCheckFailure;
  onOpenNovel: () => void;
}

function FailureRow({ failure, onOpenNovel }: FailureRowProps) {
  const { t } = useTranslation();
  const sourceName = failure.pluginName ?? failure.pluginId;
  const reason =
    failure.reason.kind === "plugin-missing"
      ? t("updates.pluginMissing", { id: failure.reason.pluginId })
      : failure.reason.message;

  return (
    <div className="norea-updates-failure-row">
      <div className="norea-updates-failure-main">
        <Group gap="xs" wrap="nowrap">
          <ConsoleStatusDot status="error" label={t("common.failed")} />
          <button
            className="norea-updates-link"
            type="button"
            onClick={onOpenNovel}
          >
            {failure.novelName}
          </button>
        </Group>
        <Text className="norea-updates-row-meta" title={reason}>
          {sourceName} / {reason}
        </Text>
      </div>
      <IconButton label={t("updates.details")} onClick={onOpenNovel} size="lg">
        <DetailsGlyph />
      </IconButton>
    </div>
  );
}

interface UpdatesPageProps {
  active?: boolean;
}

export function UpdatesPage({ active = true }: UpdatesPageProps) {
  const { locale, t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const hasLoaded = useUpdatesStore((state) => state.hasLoaded);
  const hasMoreUpdates = useUpdatesStore((state) => state.hasMoreUpdates);
  const lastCheckResult = useUpdatesStore((state) => state.lastCheckResult);
  const nextUpdateCursor = useUpdatesStore(
    (state) => state.nextUpdateCursor,
  );
  const updates = useUpdatesStore((state) => state.updates);
  const appendPage = useUpdatesStore((state) => state.appendPage);
  const applyCheckResult = useUpdatesStore(
    (state) => state.applyCheckResult,
  );
  const markChaptersDownloaded = useUpdatesStore(
    (state) => state.markChaptersDownloaded,
  );
  const mergeFirstPage = useUpdatesStore((state) => state.mergeFirstPage);
  const replaceWindow = useUpdatesStore((state) => state.replaceWindow);
  const initialLocalLoadRequested = useRef(false);
  const observedUpdatesIndexRevision = useRef(getUpdatesIndexRevision());
  const [downloadStatuses, setDownloadStatuses] = useState<
    ReadonlyMap<number, ChapterDownloadStatus>
  >(() => new Map());

  const refresh = useMutation({
    meta: { errorPresentation: hasLoaded ? "toast" : "inline" },
    mutationFn: () => listLibraryUpdatesPage(UPDATES_PAGE_SIZE),
    onSuccess: mergeFirstPage,
  });

  const check = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: () => {
      const loadedWindowSize = useUpdatesStore.getState().updates.length;
      return checkLibraryUpdates(Math.max(UPDATES_PAGE_SIZE, loadedWindowSize), {
        aggregateTaskTitle: t("tasks.task.checkLibraryUpdates"),
        taskTitle: (novel) =>
          t("tasks.task.checkUpdates", { name: novel.name }),
      });
    },
    onSuccess: (result) => {
      applyCheckResult(result);
      void queryClient.invalidateQueries({
        queryKey: ["novel"],
        refetchType: "active",
      });
    },
  });

  const loadMore = useMutation({
    mutationFn: (cursor: LibraryUpdatesCursor) =>
      listLibraryUpdatesPage(UPDATES_PAGE_SIZE, cursor),
    onSuccess: appendPage,
  });
  const isInitialLoading = refresh.isPending && !hasLoaded;
  const isLoadingMore = loadMore.isPending;
  const refreshFirstPage = refresh.mutate;
  const loadMorePage = loadMore.mutate;

  const loadMoreIfNeeded = useCallback(() => {
    if (
      !hasLoaded ||
      !active ||
      refresh.isPending ||
      check.isPending ||
      isLoadingMore ||
      !hasMoreUpdates ||
      !nextUpdateCursor
    ) {
      return;
    }

    const scrollMetrics = getUpdatesScrollMetrics();
    const distanceToBottom =
      scrollMetrics.scrollHeight -
      scrollMetrics.clientHeight -
      scrollMetrics.scrollTop;

    if (distanceToBottom <= LOAD_MORE_THRESHOLD_PX) {
      loadMorePage(nextUpdateCursor);
    }
  }, [
    active,
    check.isPending,
    hasLoaded,
    hasMoreUpdates,
    isLoadingMore,
    loadMorePage,
    nextUpdateCursor,
    refresh.isPending,
  ]);

  useEffect(() => {
    if (!active || hasLoaded || initialLocalLoadRequested.current) return;
    initialLocalLoadRequested.current = true;
    refreshFirstPage();
  }, [active, hasLoaded, refreshFirstPage]);

  useEffect(() => {
    if (!active) return;

    let disposed = false;
    let refreshRunning = false;
    let dirtyWhileRefreshing = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function clearRefreshTimer() {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
    }

    function scheduleRefresh() {
      if (disposed || !useUpdatesStore.getState().hasLoaded) return;
      clearRefreshTimer();
      timer = setTimeout(() => {
        timer = null;
        void refreshLoadedWindow();
      }, UPDATES_INDEX_REFRESH_DEBOUNCE_MS);
    }

    async function refreshLoadedWindow() {
      if (disposed || !useUpdatesStore.getState().hasLoaded) return;
      if (refreshRunning) {
        dirtyWhileRefreshing = true;
        return;
      }

      refreshRunning = true;
      const startedAtRevision = getUpdatesIndexRevision();
      try {
        const page = await listLibraryUpdatesPage(UPDATES_INDEX_REFRESH_LIMIT);
        if (disposed) return;
        if (getUpdatesIndexRevision() === startedAtRevision) {
          replaceWindow(page);
          observedUpdatesIndexRevision.current = startedAtRevision;
        } else {
          dirtyWhileRefreshing = true;
        }
      } catch {
        return;
      } finally {
        refreshRunning = false;
        if (!disposed && dirtyWhileRefreshing) {
          dirtyWhileRefreshing = false;
          scheduleRefresh();
        }
      }
    }

    if (
      hasLoaded &&
      observedUpdatesIndexRevision.current !== getUpdatesIndexRevision()
    ) {
      scheduleRefresh();
    }

    const unsubscribe = subscribeUpdatesIndexChanges(scheduleRefresh);
    return () => {
      disposed = true;
      clearRefreshTimer();
      unsubscribe();
    };
  }, [active, hasLoaded, replaceWindow]);

  useEffect(() => {
    let animationFrame: number | null = null;
    let pendingStatuses = new Map<number, ChapterDownloadStatus | null>();
    let pendingDownloadedChapterIds = new Set<number>();

    const flushUpdates = () => {
      animationFrame = null;
      const statuses = pendingStatuses;
      const downloadedChapterIds = pendingDownloadedChapterIds;
      pendingStatuses = new Map();
      pendingDownloadedChapterIds = new Set();
      if (statuses.size > 0) {
        setDownloadStatuses((current) => {
          let next: Map<number, ChapterDownloadStatus> | null = null;
          for (const [chapterId, status] of statuses) {
            if (status === null) {
              if (!(next ?? current).has(chapterId)) continue;
              next ??= new Map(current);
              next.delete(chapterId);
              continue;
            }
            const previous = (next ?? current).get(chapterId);
            if (
              previous?.kind === status.kind &&
              (previous.kind !== "failed" ||
                (status.kind === "failed" && previous.error === status.error))
            ) {
              continue;
            }
            next ??= new Map(current);
            next.set(chapterId, status);
          }
          return next ?? current;
        });
      }
      if (downloadedChapterIds.size > 0) {
        markChaptersDownloaded(downloadedChapterIds);
      }
    };

    const unsubscribe = subscribeChapterDownloads((event) => {
      if (active) {
        pendingStatuses.set(
          event.job.id,
          event.status.kind === "cancelled" ? null : event.status,
        );
      }
      if (event.status.kind === "done") {
        pendingDownloadedChapterIds.add(event.job.id);
      }
      if (pendingStatuses.size > 0 || pendingDownloadedChapterIds.size > 0) {
        animationFrame ??= requestAnimationFrame(flushUpdates);
      }
    });

    return () => {
      unsubscribe();
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      if (pendingDownloadedChapterIds.size > 0) {
        markChaptersDownloaded(pendingDownloadedChapterIds);
      }
    };
  }, [active, markChaptersDownloaded]);

  useEffect(() => {
    if (!active) return;
    const currentStatuses = listChapterDownloadStatuses();

    const downloadedChapterIds: number[] = [];
    for (const entry of updates) {
      const status = currentStatuses.get(entry.chapterId);
      if (status?.kind === "done" && !entry.isDownloaded) {
        downloadedChapterIds.push(entry.chapterId);
      }
    }
    markChaptersDownloaded(downloadedChapterIds);

    setDownloadStatuses((current) => {
      let changed = false;
      const next = new Map(current);
      for (const entry of updates) {
        const status = currentStatuses.get(entry.chapterId);
        if (status?.kind === "cancelled") {
          if (next.delete(entry.chapterId)) changed = true;
          continue;
        }
        if (status && next.get(entry.chapterId) !== status) {
          next.set(entry.chapterId, status);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [active, markChaptersDownloaded, updates]);

  useEffect(() => {
    if (!active) return;
    const scrollTarget = getUpdatesScrollElement() ?? window;
    scrollTarget.addEventListener("scroll", loadMoreIfNeeded, {
      passive: true,
    });
    window.addEventListener("resize", loadMoreIfNeeded);
    return () => {
      scrollTarget.removeEventListener("scroll", loadMoreIfNeeded);
      window.removeEventListener("resize", loadMoreIfNeeded);
    };
  }, [active, loadMoreIfNeeded]);

  const openChapter = (chapterId: number) => {
    void navigate({ to: "/reader", search: { chapterId } });
  };
  const openNovel = (novelId: number) => {
    void navigate({ to: "/novel", search: { id: novelId } });
  };
  const downloadChapter = (entry: LibraryUpdateEntry) => {
    void enqueueChapterDownload({
      id: entry.chapterId,
      pluginId: entry.pluginId,
      chapterPath: entry.chapterPath,
      chapterName: entry.chapterName,
      chapterNumber: String(entry.position),
      contentType: entry.contentType,
      novelId: entry.novelId,
      novelName: entry.novelName,
      novelPath: entry.novelPath,
      priority: "user",
      title: t("tasks.task.downloadChapter", { name: entry.chapterName }),
    }).promise.catch(() => undefined);
  };

  const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const sections = useMemo(() => groupUpdatesByDate(updates), [updates]);
  const toggleRun = (key: string) => {
    setExpandedRuns((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };
  const renderChapterRow = (entry: LibraryUpdateEntry, nested = false) => (
    <UpdateRow
      key={entry.chapterId}
      downloadStatus={downloadStatuses.get(entry.chapterId)}
      entry={entry}
      nested={nested}
      onDownload={() => downloadChapter(entry)}
      onOpen={() => openChapter(entry.chapterId)}
      onOpenNovel={() => openNovel(entry.novelId)}
    />
  );
  const renderItem = (item: UpdateListItem) => {
    if (item.kind === "chapter") return renderChapterRow(item.entry);
    const expanded = expandedRuns.has(item.key);
    return (
      <div className="norea-updates-run" key={item.key}>
        <UpdateRunRow
          count={item.entries.length}
          earliest={item.earliest}
          expanded={expanded}
          onOpenEarliest={() => openChapter(item.earliest.chapterId)}
          onOpenNovel={() => openNovel(item.earliest.novelId)}
          onToggle={() => toggleRun(item.key)}
        />
        {expanded ? (
          <div
            aria-label={item.earliest.novelName}
            className="norea-updates-run-chapters"
            role="group"
          >
            {item.entries.map((entry) => renderChapterRow(entry, true))}
          </div>
        ) : null}
      </div>
    );
  };

  const result = lastCheckResult ?? undefined;

  return (
    <div className="norea-updates-page">
      <header className="norea-updates-app-bar">
        <div className="norea-updates-app-bar-text">
          <h1 className="norea-updates-app-bar-title">{t("updates.title")}</h1>
        </div>
        <IconButton
          disabled={check.isPending}
          label={t("updates.check")}
          onClick={() => check.mutate()}
          size="lg"
        >
          {check.isPending ? <Loader size="sm" /> : <RefreshIcon />}
        </IconButton>
      </header>

      <PageFrame className="norea-updates-frame" size="wide">
        {isInitialLoading ? (
          <UpdateRowsSkeleton label={t("updates.loadingRecent")} />
        ) : refresh.error && !hasLoaded ? (
          <StateView
            action={{
              label: t("common.retry"),
              onClick: () => refreshFirstPage(),
            }}
            color="danger"
            details={{
              content: describeError(refresh.error),
              label: t("common.details"),
            }}
            title={t("updates.loadFailed")}
          />
        ) : (
          <Stack gap="md">
            {check.isPending ? (
              <StateView
                title={
                  <Group gap="sm">
                    <Loader size="sm" />
                    <Text c="dimmed">{t("updates.checkingLibrarySources")}</Text>
                  </Group>
                }
              />
            ) : check.error ? (
              <StateView
                action={{
                  label: t("common.retry"),
                  onClick: () => check.mutate(),
                }}
                color="danger"
                details={{
                  content: describeError(check.error),
                  label: t("common.details"),
                }}
                title={t("updates.checkFailed")}
              />
            ) : result && result.failures.length > 0 ? (
              <ConsolePanel
                className="norea-updates-failures"
                title={t("updates.sourceFailures")}
              >
                <Stack gap={0}>
                  {result.failures.map((failure) => (
                    <FailureRow
                      key={failure.novelId}
                      failure={failure}
                      onOpenNovel={() => openNovel(failure.novelId)}
                    />
                  ))}
                </Stack>
                <div className="norea-updates-failure-footer">
                  <Text className="norea-updates-row-meta">
                    {t("updates.failureFooter")}
                  </Text>
                  <Button onClick={() => check.mutate()} variant="light">
                    {t("updates.retryFailedCheck")}
                  </Button>
                </div>
              </ConsolePanel>
            ) : null}

            {updates.length > 0 ? (
              <div className="norea-updates-list">
                {sections.map((section) => (
                  <section
                    aria-labelledby={`norea-updates-day-${section.dayStart}`}
                    className="norea-updates-day"
                    key={section.dayStart}
                  >
                    <h2
                      className="norea-updates-day-title"
                      id={`norea-updates-day-${section.dayStart}`}
                    >
                      {formatUpdateDay(section.dayStart, locale, t)}
                    </h2>
                    {section.items.map(renderItem)}
                  </section>
                ))}
                {hasMoreUpdates ? (
                  <div className="norea-updates-load-more">
                    <Button
                      disabled={!nextUpdateCursor}
                      loading={isLoadingMore}
                      onClick={() => {
                        if (nextUpdateCursor) loadMorePage(nextUpdateCursor);
                      }}
                      variant="light"
                    >
                      {t("updates.loadMore")}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <StateView
                action={{
                  label: t("updates.check"),
                  onClick: () => check.mutate(),
                }}
                message={t("updates.caughtUpCurrentMessage")}
                title={t("updates.caughtUp")}
              />
            )}
          </Stack>
        )}
      </PageFrame>
    </div>
  );
}
