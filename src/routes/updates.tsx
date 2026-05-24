import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Group,
  Loader,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  DetailsGlyph,
  DownloadGlyph,
  DownloadedGlyph,
} from "../components/ActionGlyphs";
import {
  ConsoleCover,
  ConsolePanel,
  ConsoleSectionHeader,
  ConsoleStatusDot,
} from "../components/ConsolePrimitives";
import { PageFrame, PageHeader, StateView } from "../components/AppFrame";
import { IconButton } from "../components/IconButton";
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
  type UpdateCheckResult,
} from "../lib/updates/check-library-updates";
import {
  getUpdatesIndexRevision,
  subscribeUpdatesIndexChanges,
} from "../lib/updates/update-index-events";
import {
  formatDateTimeForLocale,
  useTranslation,
  type AppLocale,
  type TranslationKey,
} from "../i18n";
import { useUpdatesStore } from "../store/updates";
import "../styles/updates.css";

const UPDATES_PAGE_SIZE = 100;
const UPDATES_INDEX_REFRESH_DEBOUNCE_MS = 500;
const UPDATES_INDEX_REFRESH_LIMIT = UPDATES_PAGE_SIZE;
const LOAD_MORE_THRESHOLD_PX = 480;

function formatDateTime(epochSeconds: number, locale: AppLocale): string {
  return formatDateTimeForLocale(locale, epochSeconds * 1000);
}

function countLabel(
  t: ReturnType<typeof useTranslation>["t"],
  value: number,
  singularKey: TranslationKey,
  pluralKey: TranslationKey,
): string {
  return t(value === 1 ? singularKey : pluralKey, { count: value });
}

interface UpdateSummaryProps {
  hasMoreUpdates: boolean;
  loadedUpdates: number;
  result: UpdateCheckResult | undefined;
  running: boolean;
}

function UpdateSummary({
  hasMoreUpdates,
  loadedUpdates,
  result,
  running,
}: UpdateSummaryProps) {
  const { t } = useTranslation();
  const failures = result?.failures.length ?? 0;

  return (
    <ConsolePanel className="lnr-updates-summary">
      <div className="lnr-updates-summary-row">
        <Group gap="xs" wrap="wrap">
          <ConsoleStatusDot
            status={running ? "active" : failures > 0 ? "warning" : "idle"}
            label={
              running
                ? t("common.checking")
                : result
                  ? t("common.ready")
                  : t("settings.idle")
            }
          />
          <UpdateFlag
            count={loadedUpdates}
            label={countLabel(
              t,
              loadedUpdates,
              "updates.newChapterCount",
              "updates.newChapterCountPlural",
            )}
            tone={loadedUpdates > 0 ? "accent" : "default"}
          >
            <UnreadIcon />
          </UpdateFlag>
          {failures > 0 ? (
            <UpdateFlag
              count={failures}
              label={countLabel(
                t,
                failures,
                "updates.failureCount",
                "updates.failureCountPlural",
              )}
              tone="warning"
            >
              <AlertIcon />
            </UpdateFlag>
          ) : null}
          {hasMoreUpdates ? (
            <UpdateFlag label={t("updates.moreAvailable")} tone="accent">
              <PlusIcon />
            </UpdateFlag>
          ) : null}
        </Group>
      </div>
    </ConsolePanel>
  );
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
    <div className="lnr-updates-failure-row">
      <div className="lnr-updates-failure-main">
        <Group gap="xs" wrap="nowrap">
          <ConsoleStatusDot status="error" label={t("common.failed")} />
          <button
            className="lnr-updates-link"
            type="button"
            onClick={onOpenNovel}
          >
            {failure.novelName}
          </button>
        </Group>
        <Text className="lnr-updates-row-meta" title={reason}>
          {sourceName} / {reason}
        </Text>
      </div>
      <UpdateIconButton label={t("updates.details")} onClick={onOpenNovel}>
        <DetailsGlyph />
      </UpdateIconButton>
    </div>
  );
}

interface UpdateIconButtonProps {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  tone?: "default" | "accent" | "danger";
}

function UpdateIconButton({
  children,
  className,
  disabled = false,
  label,
  onClick,
  tone = "default",
}: UpdateIconButtonProps) {
  const classNames = `lnr-updates-icon-button${
    className ? ` ${className}` : ""
  }`;

  return (
    <IconButton
      className={classNames}
      disabled={disabled}
      label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      size="lg"
      tone={tone}
    >
      {children}
    </IconButton>
  );
}

interface UpdateFlagProps {
  children: ReactNode;
  count?: number;
  label: string;
  tone?: "accent" | "default" | "done" | "error" | "warning";
}

function UpdateFlag({
  children,
  count,
  label,
  tone = "default",
}: UpdateFlagProps) {
  const hasCount = count != null;

  return (
    <Tooltip label={label} openDelay={350} withArrow>
      <span
        aria-label={label}
        className="lnr-updates-icon-flag"
        data-count={hasCount ? "true" : undefined}
        data-tone={tone}
        role="img"
        title={label}
      >
        {children}
        {hasCount ? (
          <span className="lnr-updates-icon-count">{count}</span>
        ) : null}
      </span>
    </Tooltip>
  );
}

function UpdateDownloadStatusFlag({
  status,
}: {
  status: ChapterDownloadStatus | undefined;
}) {
  const { t } = useTranslation();

  if (!status || status.kind === "done" || status.kind === "cancelled") {
    return null;
  }

  if (status.kind === "failed") {
    return (
      <UpdateFlag label={status.error} tone="error">
        <AlertIcon />
      </UpdateFlag>
    );
  }

  if (status.kind === "running") {
    return (
      <UpdateFlag label={t("common.downloading")}>
        <SpinnerIcon />
      </UpdateFlag>
    );
  }

  return (
    <UpdateFlag label={t("common.queued")}>
      <ClockIcon />
    </UpdateFlag>
  );
}

interface UpdateRowProps {
  downloadStatus: ChapterDownloadStatus | undefined;
  entry: LibraryUpdateEntry;
  onDownload: () => void;
  onOpen: () => void;
  onOpenNovel: () => void;
}

function UpdateRow({
  downloadStatus,
  entry,
  onDownload,
  onOpen,
  onOpenNovel,
}: UpdateRowProps) {
  const { locale, t } = useTranslation();
  const isQueued = downloadStatus?.kind === "queued";
  const isRunning = downloadStatus?.kind === "running";
  const failedMessage =
    downloadStatus?.kind === "failed" ? downloadStatus.error : null;
  const status = entry.isDownloaded ? "done" : "active";
  const downloadLabel = failedMessage
    ? `${t("novel.retryDownload")}: ${failedMessage}`
    : isRunning
      ? t("common.downloading")
      : isQueued
        ? t("common.queued")
        : t("novel.downloadChapter");

  return (
    <div
      className="lnr-updates-row"
      role="button"
      tabIndex={0}
      aria-label={t("updates.openChapter", { name: entry.chapterName })}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
    >
      <ConsoleCover
        alt={entry.novelName}
        height={72}
        src={entry.novelCover}
        width={48}
      />

      <div className="lnr-updates-row-main">
        <Group gap="xs" wrap="nowrap">
          <ConsoleStatusDot
            status={status}
            label={entry.isDownloaded ? t("common.downloaded") : t("common.new")}
          />
          <button
            className="lnr-updates-link"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpenNovel();
            }}
          >
            {entry.novelName}
          </button>
        </Group>
        <Text className="lnr-updates-row-title" title={entry.chapterName}>
          #{entry.position} - {entry.chapterName}
        </Text>
        <Group gap="xs" mt={6} wrap="wrap">
          <span className="lnr-updates-row-flags" aria-label={t("novel.chapterStatus")}>
            <UpdateFlag label={entry.pluginName ?? entry.pluginId}>
              <SourceIcon />
            </UpdateFlag>
            <UpdateFlag label={t("library.grid.unread")} tone="accent">
              <UnreadIcon />
            </UpdateFlag>
            {entry.isDownloaded ? (
              <UpdateFlag label={t("novel.downloaded")} tone="done">
                <DownloadedGlyph />
              </UpdateFlag>
            ) : null}
            <UpdateDownloadStatusFlag status={downloadStatus} />
          </span>
          <Text className="lnr-updates-row-meta">
            {formatDateTime(entry.foundAt, locale)}
          </Text>
        </Group>
      </div>

      <div className="lnr-updates-row-actions">
        <UpdateIconButton label={t("common.read")} onClick={onOpen} tone="accent">
          <ReadForwardIcon />
        </UpdateIconButton>
        {!entry.isDownloaded ? (
          <UpdateIconButton
            disabled={isQueued || isRunning}
            label={downloadLabel}
            onClick={onDownload}
            tone={failedMessage ? "danger" : "default"}
          >
            {isRunning ? (
              <SpinnerIcon />
            ) : isQueued ? (
              <ClockIcon />
            ) : (
              <DownloadGlyph />
            )}
          </UpdateIconButton>
        ) : null}
        <UpdateIconButton label={t("updates.details")} onClick={onOpenNovel}>
          <DetailsGlyph />
        </UpdateIconButton>
      </div>
    </div>
  );
}

function ReadForwardIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M5 5h9a4 4 0 0 1 4 4v10H9a4 4 0 0 0-4 4z" />
      <path d="M9 9h5" />
      <path d="M9 13h4" />
    </svg>
  );
}

function UnreadIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M5 5h14v14H5z" />
      <path d="M8 10h6" />
      <path d="M8 14h5" />
      <circle cx="17" cy="7" r="2" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 4l9 16H3z" />
      <path d="M12 9v5" />
      <path d="M12 18h.01" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      className="lnr-updates-spin-icon"
      aria-hidden="true"
      viewBox="0 0 24 24"
    >
      <path d="M12 3a9 9 0 1 1-8.49 6" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v5l3 2" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

function SourceIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18" />
      <path d="M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

interface UpdatesPageProps {
  active?: boolean;
}

export function UpdatesPage({ active = true }: UpdatesPageProps) {
  const { t } = useTranslation();
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
  const markChapterDownloaded = useUpdatesStore(
    (state) => state.markChapterDownloaded,
  );
  const mergeFirstPage = useUpdatesStore((state) => state.mergeFirstPage);
  const replaceWindow = useUpdatesStore((state) => state.replaceWindow);
  const initialLocalLoadRequested = useRef(false);
  const [downloadStatuses, setDownloadStatuses] = useState<
    ReadonlyMap<number, ChapterDownloadStatus>
  >(() => new Map());

  const refresh = useMutation({
    mutationFn: () => listLibraryUpdatesPage(UPDATES_PAGE_SIZE),
    onSuccess: mergeFirstPage,
  });

  const check = useMutation({
    mutationFn: () => {
      const loadedWindowSize = useUpdatesStore.getState().updates.length;
      return checkLibraryUpdates(Math.max(UPDATES_PAGE_SIZE, loadedWindowSize), {
        aggregateTaskTitle: t("tasks.task.checkLibraryUpdates"),
        taskTitle: (novel) =>
          t("tasks.task.checkUpdates", { name: novel.name }),
      });
    },
    onSuccess: applyCheckResult,
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

    const scrollElement = document.scrollingElement ?? document.documentElement;
    const distanceToBottom =
      scrollElement.scrollHeight - window.innerHeight - scrollElement.scrollTop;

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

    const unsubscribe = subscribeUpdatesIndexChanges(scheduleRefresh);
    return () => {
      disposed = true;
      clearRefreshTimer();
      unsubscribe();
    };
  }, [replaceWindow]);

  useEffect(() => {
    return subscribeChapterDownloads((event) => {
      setDownloadStatuses((current) => {
        const next = new Map(current);
        if (event.status.kind === "cancelled") {
          next.delete(event.job.id);
        } else {
          next.set(event.job.id, event.status);
        }
        return next;
      });
      if (event.status.kind === "done") {
        markChapterDownloaded(event.job.id);
        void queryClient.invalidateQueries({ queryKey: ["novel"] });
      }
    });
  }, [markChapterDownloaded, queryClient]);

  useEffect(() => {
    const currentStatuses = listChapterDownloadStatuses();

    for (const entry of updates) {
      const status = currentStatuses.get(entry.chapterId);
      if (status?.kind === "done" && !entry.isDownloaded) {
        markChapterDownloaded(entry.chapterId);
      }
    }

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
  }, [markChapterDownloaded, updates]);

  useEffect(() => {
    if (!active) return;
    window.addEventListener("scroll", loadMoreIfNeeded, { passive: true });
    window.addEventListener("resize", loadMoreIfNeeded);
    return () => {
      window.removeEventListener("scroll", loadMoreIfNeeded);
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
      contentType: entry.contentType,
      novelId: entry.novelId,
      novelName: entry.novelName,
      novelPath: entry.novelPath,
      priority: "user",
      title: t("tasks.task.downloadChapter", { name: entry.chapterName }),
    }).promise.catch(() => undefined);
  };

  const result = lastCheckResult ?? undefined;

  return (
    <PageFrame className="lnr-updates-page" size="wide">
      <PageHeader
        title={
          <span className="lnr-updates-title-line">
            <span>{t("updates.title")}</span>
            <span className="lnr-updates-title-description">
              {t("updates.description")}
            </span>
          </span>
        }
        actions={
          <UpdateIconButton
            className="lnr-updates-check-button"
            disabled={check.isPending}
            label={t("updates.check")}
            onClick={() => check.mutate()}
            tone="accent"
          >
            {check.isPending ? <SpinnerIcon /> : <RefreshIcon />}
          </UpdateIconButton>
        }
      />

      <UpdateSummary
        hasMoreUpdates={hasMoreUpdates}
        loadedUpdates={updates.length}
        result={result}
        running={check.isPending || refresh.isPending}
      />

      {isInitialLoading ? (
        <StateView
          title={
            <Group gap="sm">
              <Loader size="sm" />
              <Text c="dimmed">{t("updates.loadingRecent")}</Text>
            </Group>
          }
        />
      ) : refresh.error && !hasLoaded ? (
        <StateView
          action={{
            icon: <RefreshIcon />,
            iconOnly: true,
            label: t("common.retry"),
            onClick: () => refreshFirstPage(),
          }}
          color="red"
          title={t("updates.loadFailed")}
          message={
            refresh.error instanceof Error
              ? refresh.error.message
              : String(refresh.error)
          }
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
                icon: <RefreshIcon />,
                iconOnly: true,
                label: t("common.retry"),
                onClick: () => check.mutate(),
              }}
              color="red"
              title={t("updates.checkFailed")}
              message={
                check.error instanceof Error
                  ? check.error.message
                  : String(check.error)
              }
            />
          ) : result && result.failures.length > 0 ? (
            <ConsolePanel
              className="lnr-updates-failures"
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
              <div className="lnr-updates-failure-footer">
                <Text className="lnr-updates-row-meta">
                  {t("updates.failureFooter")}
                </Text>
                <UpdateIconButton
                  className="lnr-updates-footer-action"
                  disabled={check.isPending}
                  label={t("updates.retryFailedCheck")}
                  onClick={() => check.mutate()}
                  tone="accent"
                >
                  {check.isPending ? <SpinnerIcon /> : <RefreshIcon />}
                </UpdateIconButton>
              </div>
            </ConsolePanel>
          ) : null}

          <ConsolePanel className="lnr-updates-queue">
            <ConsoleSectionHeader
              title={t("updates.newChapters")}
              count={`${countLabel(
                t,
                updates.length,
                "updates.newChapterCount",
                "updates.newChapterCountPlural",
              )}${hasMoreUpdates ? ` / ${t("updates.moreAvailable")}` : ""}`}
            />

            {updates.length > 0 ? (
              <Stack gap={0} mt="sm">
                {updates.map((entry) => (
                  <UpdateRow
                    key={entry.chapterId}
                    downloadStatus={downloadStatuses.get(entry.chapterId)}
                    entry={entry}
                    onDownload={() => downloadChapter(entry)}
                    onOpen={() => openChapter(entry.chapterId)}
                    onOpenNovel={() => openNovel(entry.novelId)}
                  />
                ))}
                {hasMoreUpdates ? (
                  <div className="lnr-updates-load-more">
                    <UpdateIconButton
                      className="lnr-updates-load-more-action"
                      disabled={isLoadingMore || !nextUpdateCursor}
                      label={t("updates.loadMore")}
                      onClick={() => {
                        if (nextUpdateCursor) loadMorePage(nextUpdateCursor);
                      }}
                      tone="accent"
                    >
                      {isLoadingMore ? <SpinnerIcon /> : <PlusIcon />}
                    </UpdateIconButton>
                    <Text className="lnr-updates-row-meta">
                      {t("updates.autoLoadMore")}
                    </Text>
                  </div>
                ) : null}
              </Stack>
            ) : (
              <StateView
                color="blue"
                title={t("updates.caughtUp")}
                message={t("updates.caughtUpCurrentMessage")}
              />
            )}
          </ConsolePanel>
        </Stack>
      )}
    </PageFrame>
  );
}
