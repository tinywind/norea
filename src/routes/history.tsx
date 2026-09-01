import { useMemo, useState, type ReactNode } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Box,
  Group,
  Loader,
  Paper,
  Skeleton,
  Stack,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  PageFrame,
  PageHeader,
} from "../components/AppFrame";
import { DetailsGlyph, PlayGlyph } from "../components/ActionGlyphs";
import { ConsoleCover } from "../components/ConsolePrimitives";
import { IconButton } from "../components/IconButton";
import { SearchBar } from "../components/SearchBar";
import { SegmentedToggle } from "../components/SegmentedToggle";
import {
  clearNovelHistory,
  getAdjacentChapter,
  listRecentlyRead,
  type RecentlyReadEntry,
} from "../db/queries/chapter";
import {
  formatTimeForLocale,
  useTranslation,
  type AppLocale,
  type TranslationKey,
} from "../i18n";
import { pluginManager } from "../lib/plugins/manager";
import { useNovelCoverSource } from "../lib/use-novel-cover-source";

const HISTORY_LIMIT = 100;
const FINISHED_PROGRESS = 100;

type ProgressFilter = "all" | "inProgress" | "finished";
type DateBucket = "today" | "thisWeek" | "older";

interface HistoryDateSection {
  label: DateBucket;
  entries: RecentlyReadEntry[];
}

const DATE_BUCKETS: DateBucket[] = ["today", "thisWeek", "older"];
const DATE_BUCKET_LABEL_KEYS: Record<DateBucket, TranslationKey> = {
  today: "history.bucket.today",
  thisWeek: "history.bucket.thisWeek",
  older: "history.bucket.older",
};

function getDateBucketLabel(
  bucket: DateBucket,
  t: (key: TranslationKey) => string,
): string {
  return t(DATE_BUCKET_LABEL_KEYS[bucket]);
}

function formatHistoryTimestamp(
  epochSeconds: number,
  locale: AppLocale,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const now = new Date();
  const date = new Date(epochSeconds * 1000);
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const dateStart = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const dayDelta = Math.floor(
    (todayStart - dateStart) / (24 * 60 * 60 * 1000),
  );

  if (dayDelta === 0) {
    return `${t("time.today")} - ${formatTimeForLocale(locale, date)}`;
  }
  if (dayDelta === 1) {
    return `${t("time.yesterday")} - ${formatTimeForLocale(locale, date)}`;
  }
  if (dayDelta < 7) {
    return `${new Intl.DateTimeFormat(locale, {
      weekday: "short",
    }).format(date)} - ${formatTimeForLocale(locale, date)}`;
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatDateBucket(epochSeconds: number): DateBucket {
  const now = new Date();
  const date = new Date(epochSeconds * 1000);
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const dateStart = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();

  if (dateStart === todayStart) return "today";
  if (todayStart - dateStart < 7 * 24 * 60 * 60 * 1000) {
    return "thisWeek";
  }
  return "older";
}

function getProgressStatus(entry: RecentlyReadEntry): "finished" | "active" {
  return entry.progress >= FINISHED_PROGRESS ? "finished" : "active";
}

function matchesProgressFilter(
  entry: RecentlyReadEntry,
  filter: ProgressFilter,
): boolean {
  if (filter === "finished") return entry.progress >= FINISHED_PROGRESS;
  if (filter === "inProgress") return entry.progress < FINISHED_PROGRESS;
  return true;
}

function matchesSearch(entry: RecentlyReadEntry, search: string): boolean {
  const normalized = search.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return (
    entry.novelName.toLocaleLowerCase().includes(normalized) ||
    entry.chapterName.toLocaleLowerCase().includes(normalized) ||
    String(entry.position).includes(normalized)
  );
}

function groupByDateBucket(
  entries: readonly RecentlyReadEntry[],
): HistoryDateSection[] {
  return DATE_BUCKETS.map((label) => ({
    label,
    entries: entries.filter(
      (entry) => formatDateBucket(entry.readAt) === label,
    ),
  })).filter((section) => section.entries.length > 0);
}

function HistoryCover({
  entry,
  size = "row",
}: {
  entry: RecentlyReadEntry;
  size?: "resume" | "row" | "dense";
}) {
  const plugin =
    entry.novelIsLocal || entry.novelInLibrary
      ? null
      : pluginManager.getPlugin(entry.pluginId);
  const coverSource = useNovelCoverSource(
    {
      cover: entry.novelCover,
      id: entry.novelId,
      isLocal: entry.novelIsLocal,
      name: entry.novelName,
      path: entry.novelPath,
      pluginId: entry.pluginId,
    },
    {
      allowSourceFallback: Boolean(plugin),
      plugin,
    },
  );
  const dimensions =
    size === "resume"
      ? { w: 88, h: 130 }
      : size === "dense"
        ? { w: 44, h: 66 }
        : { w: 46, h: 68 };

  return (
    <ConsoleCover
      alt={entry.novelName}
      height={dimensions.h}
      src={coverSource}
      width={dimensions.w}
    />
  );
}

function HistoryProgress({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  const status = clamped >= FINISHED_PROGRESS ? "finished" : "active";

  return (
    <div
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={clamped}
      className="lnr-history-progress"
      role="progressbar"
    >
      <div
        className="lnr-history-progress-bar"
        data-status={status}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function StatusFlag({ entry }: { entry: RecentlyReadEntry }) {
  const { t } = useTranslation();
  const status = getProgressStatus(entry);
  const label =
    status === "finished" ? t("common.finished") : t("common.inProgress");

  return (
    <HistoryIconFlag
      className="lnr-history-status-flag"
      label={label}
      tone={status === "finished" ? "done" : "accent"}
    >
      {status === "finished" ? <CheckIcon /> : <ClockIcon />}
    </HistoryIconFlag>
  );
}

interface HistoryIconButtonProps {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  tone?: "default" | "accent" | "danger";
}

function HistoryIconButton({
  children,
  className,
  disabled = false,
  label,
  onClick,
  tone = "default",
}: HistoryIconButtonProps) {
  const classNames = `lnr-history-icon-button${
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
      type="button"
    >
      {children}
    </IconButton>
  );
}

interface HistoryIconFlagProps {
  children: ReactNode;
  className?: string;
  count?: number;
  label: string;
  tone?: "accent" | "default" | "done" | "danger";
}

function HistoryIconFlag({
  children,
  className,
  count,
  label,
  tone = "default",
}: HistoryIconFlagProps) {
  const hasCount = count != null;
  const classNames = `lnr-history-icon-flag${
    className ? ` ${className}` : ""
  }`;

  return (
    <Tooltip label={label} openDelay={350} withArrow>
      <span
        aria-label={label}
        className={classNames}
        data-count={hasCount ? "true" : undefined}
        data-tone={tone}
        role="img"
        title={label}
      >
        {children}
        {hasCount ? (
          <span className="lnr-history-icon-count">{count}</span>
        ) : null}
      </span>
    </Tooltip>
  );
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M7 7l1 13h8l1-13" />
      <path d="M10 11v5" />
      <path d="M14 11v5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 12l5 5L20 6" />
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

function CalendarIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M5 5h14v15H5z" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
      <path d="M5 9h14" />
      <path d="M8 13h3" />
      <path d="M8 16h5" />
    </svg>
  );
}

function HistoryArchiveIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 5h16v4H4z" />
      <path d="M6 9v10h12V9" />
      <path d="M9 13h6" />
    </svg>
  );
}

function LibraryIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 4h4v16H4z" />
      <path d="M10 4h4v16h-4z" />
      <path d="m16 6 4-1 3 15-4 1z" />
    </svg>
  );
}

function RetryIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v6h-6" />
    </svg>
  );
}

interface HistoryRowProps {
  entry: RecentlyReadEntry;
  removingNovelId: number | null;
  onContinueReading: () => void;
  onOpenNovel: () => void;
  onRemoveNovel: () => void;
}

function HistoryRow({
  entry,
  removingNovelId,
  onContinueReading,
  onOpenNovel,
  onRemoveNovel,
}: HistoryRowProps) {
  const { locale, t } = useTranslation();
  const removing = removingNovelId === entry.novelId;
  const continueLabel = `${t("novel.continueReading")} - ${entry.novelName}`;
  const detailsLabel = `${t("common.details")} - ${entry.novelName}`;
  const removeLabel = `${t("common.remove")} - ${entry.novelName}`;

  return (
    <Paper
      aria-label={t("history.row.aria", {
        novel: entry.novelName,
        progress: entry.progress,
        position: entry.position,
      })}
      className="lnr-history-row"
      component="article"
      data-removing={removing ? "true" : "false"}
      onClick={onOpenNovel}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenNovel();
        }
      }}
      role="button"
      tabIndex={0}
      withBorder
    >
      <HistoryCover entry={entry} />
      <Box className="lnr-history-row-main">
        <Group gap="xs" mb={2} wrap="nowrap">
          <Text
            className="lnr-history-row-title"
            component="span"
            lineClamp={1}
            title={entry.novelName}
          >
            {entry.novelName}
          </Text>
          <StatusFlag entry={entry} />
        </Group>
        <Text
          className="lnr-history-row-chapter"
          component="div"
          lineClamp={1}
          title={entry.chapterName}
        >
          <span>
            {t("history.chapterPrefix")}
            {entry.position}
          </span>{" "}
          - <em>{entry.chapterName}</em>
        </Text>
        <Group className="lnr-history-row-meta" gap="xs" wrap="nowrap">
          <Box className="lnr-history-row-progress">
            <HistoryProgress value={entry.progress} />
          </Box>
          <Text component="span">
            {entry.progress}% -{" "}
            {formatHistoryTimestamp(entry.readAt, locale, t)}
          </Text>
        </Group>
      </Box>
      <Group
        className="lnr-history-row-actions"
        gap={6}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        wrap="nowrap"
      >
        {removing ? (
          <span className="lnr-history-removing">
            <Loader size={10} />
            {t("history.removing")}
          </span>
        ) : (
          <>
            <HistoryIconButton
              label={continueLabel}
              onClick={onContinueReading}
              tone="accent"
            >
              <PlayGlyph />
            </HistoryIconButton>
            <HistoryIconButton
              label={detailsLabel}
              onClick={onOpenNovel}
            >
              <DetailsGlyph />
            </HistoryIconButton>
            <HistoryIconButton
              label={removeLabel}
              onClick={onRemoveNovel}
              tone="danger"
            >
              <TrashIcon />
            </HistoryIconButton>
          </>
        )}
      </Group>
    </Paper>
  );
}

interface ResumePanelProps {
  checkingNextChapter: boolean;
  entry: RecentlyReadEntry;
  nextChapterName: string | null;
  nextChapterPosition: number | null;
  onContinueReading: () => void;
  onOpenNovel: () => void;
}

function ResumePanel({
  checkingNextChapter,
  entry,
  nextChapterName,
  nextChapterPosition,
  onContinueReading,
  onOpenNovel,
}: ResumePanelProps) {
  const { t } = useTranslation();
  const continueLabel = `${t("novel.continueReading")} - ${entry.novelName}`;
  const detailsLabel = `${t("common.details")} - ${entry.novelName}`;
  const nextLabel =
    entry.progress < FINISHED_PROGRESS
      ? `${t("history.currentChapter")} - ${t("history.chapterPrefix")}${entry.position} ${entry.chapterName}`
      : checkingNextChapter
        ? t("history.checkingNextChapter")
        : nextChapterName
          ? `${t("history.nextChapter")} - ${t("history.chapterPrefix")}${nextChapterPosition} ${nextChapterName}`
          : t("history.nextChapterMissing");

  return (
    <Paper className="lnr-history-resume" withBorder>
      <HistoryCover entry={entry} size="resume" />
      <Box className="lnr-history-resume-main">
        <Text className="lnr-history-kicker">{t("history.resume")}</Text>
        <Title className="lnr-history-resume-title" order={2} lineClamp={1}>
          {entry.novelName}
        </Title>
        <Text className="lnr-history-resume-last" lineClamp={1}>
          {t("history.lastRead")} -{" "}
          <span>
            {t("history.chapterPrefix")}
            {entry.position}
          </span>{" "}
          <em>{entry.chapterName}</em>
        </Text>
        <Group className="lnr-history-resume-meta" gap="xs" mt={8} wrap="nowrap">
          <Box style={{ flex: 1 }}>
            <HistoryProgress value={entry.progress} />
          </Box>
          <Text className="lnr-history-percent">{entry.progress}%</Text>
        </Group>
        <Text className="lnr-history-next" lineClamp={1}>
          {nextLabel}
        </Text>
        <Group className="lnr-history-resume-actions" gap="xs" mt="auto">
          <HistoryIconButton
            label={continueLabel}
            onClick={onContinueReading}
            tone="accent"
          >
            <PlayGlyph />
          </HistoryIconButton>
          <HistoryIconButton
            label={detailsLabel}
            onClick={onOpenNovel}
          >
            <DetailsGlyph />
          </HistoryIconButton>
        </Group>
      </Box>
    </Paper>
  );
}

function HistorySummaryPanel({
  entries,
  sections,
}: {
  entries: RecentlyReadEntry[];
  sections: HistoryDateSection[];
}) {
  const { t } = useTranslation();
  const thisWeekCount = entries.filter(
    (entry) => formatDateBucket(entry.readAt) !== "older",
  ).length;
  const finishedCount = entries.filter(
    (entry) => entry.progress >= FINISHED_PROGRESS,
  ).length;
  const averageProgress =
    entries.length === 0
      ? 0
      : Math.round(
          entries.reduce((sum, entry) => sum + entry.progress, 0) /
            entries.length,
        );
  const countFor = (label: DateBucket) =>
    sections.find((section) => section.label === label)?.entries.length ?? 0;
  const todayCount = countFor("today");
  const weekCount = countFor("thisWeek");
  const olderCount = countFor("older");

  return (
    <Paper className="lnr-history-summary" withBorder>
      <Box>
        <Text className="lnr-history-kicker">{t("history.summary.week")}</Text>
        <Title className="lnr-history-summary-title" order={2}>
          {t("history.summary.title", {
            novels: thisWeekCount,
            finished: finishedCount,
          })}
        </Title>
        <Text className="lnr-history-summary-copy">
          {t("history.summary.copy", { progress: averageProgress })}
        </Text>
      </Box>
      <Group gap="xs" wrap="wrap">
        <HistoryIconFlag
          count={todayCount}
          label={`${getDateBucketLabel("today", t)} - ${todayCount}`}
          tone="accent"
        >
          <ClockIcon />
        </HistoryIconFlag>
        <HistoryIconFlag
          count={weekCount}
          label={`${getDateBucketLabel("thisWeek", t)} - ${weekCount}`}
        >
          <CalendarIcon />
        </HistoryIconFlag>
        <HistoryIconFlag
          count={olderCount}
          label={`${getDateBucketLabel("older", t)} - ${olderCount}`}
        >
          <HistoryArchiveIcon />
        </HistoryIconFlag>
      </Group>
    </Paper>
  );
}

function FilterBar({
  progressFilter,
  searchInput,
  onProgressFilterChange,
  onSearchInputChange,
  onSearchSubmit,
}: {
  progressFilter: ProgressFilter;
  searchInput: string;
  onProgressFilterChange: (filter: ProgressFilter) => void;
  onSearchInputChange: (search: string) => void;
  onSearchSubmit: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="lnr-history-filter">
      <SegmentedToggle
        className="lnr-history-segments"
        data={[
          { value: "all", label: t("history.filter.all") },
          { value: "inProgress", label: t("common.inProgress") },
          { value: "finished", label: t("common.finished") },
        ]}
        onChange={(value) => onProgressFilterChange(value as ProgressFilter)}
        value={progressFilter}
      />
      <div className="lnr-history-search">
        <SearchBar
          value={searchInput}
          onChange={onSearchInputChange}
          onSubmit={onSearchSubmit}
          placeholder={t("history.filter.placeholder")}
        />
      </div>
    </div>
  );
}

function HistorySection({
  children,
  count,
  title,
}: {
  children: ReactNode;
  count: number;
  title: DateBucket;
}) {
  const { t } = useTranslation();

  return (
    <section className="lnr-history-section">
      <Group align="baseline" gap="xs" mb={8}>
        <Title className="lnr-history-section-title" order={3}>
          {getDateBucketLabel(title, t)}
        </Title>
        <Text className="lnr-history-section-count">- {count}</Text>
      </Group>
      <Stack gap={6}>{children}</Stack>
    </section>
  );
}

function HistoryLoadingState() {
  const { t } = useTranslation();

  return (
    <Stack className="lnr-history-loading" gap={6}>
      {[0, 1, 2].map((item) => (
        <Paper className="lnr-history-row" key={item} withBorder>
          <Skeleton height={68} radius={3} width={46} />
          <Box style={{ flex: 1 }}>
            <Skeleton height={12} radius={3} width="40%" />
            <Skeleton height={10} mt={8} radius={3} width="70%" />
            <Skeleton height={4} mt={12} radius={2} width="50%" />
          </Box>
        </Paper>
      ))}
      <Text className="lnr-history-loading-label">{t("history.loading")}</Text>
    </Stack>
  );
}

function HistoryEmptyState({
  hasSearch,
  onOpenLibrary,
}: {
  hasSearch: boolean;
  onOpenLibrary: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Paper className="lnr-history-empty" withBorder>
      <Title order={3}>
        {hasSearch ? t("common.noMatches") : t("history.empty.noHistory.title")}
      </Title>
      <Text>
        {hasSearch
          ? t("history.empty.noMatches.message")
          : t("history.empty.noHistory.message")}
      </Text>
      {!hasSearch ? (
        <Group justify="center" mt="md">
          <HistoryIconButton
            label={t("history.empty.openLibrary")}
            onClick={onOpenLibrary}
            tone="accent"
          >
            <LibraryIcon />
          </HistoryIconButton>
        </Group>
      ) : null}
    </Paper>
  );
}

function HistoryErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Paper className="lnr-history-empty" withBorder>
      <Title order={3}>{t("history.loadError")}</Title>
      <Text>
        {error instanceof Error ? error.message : String(error)}
      </Text>
      <Group justify="center" mt="md">
        <HistoryIconButton
          label={t("common.retry")}
          onClick={onRetry}
          tone="accent"
        >
          <RetryIcon />
        </HistoryIconButton>
      </Group>
    </Paper>
  );
}

export function HistoryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [progressFilter, setProgressFilter] =
    useState<ProgressFilter>("all");

  const query = useQuery({
    queryKey: ["chapter", "history", HISTORY_LIMIT] as const,
    queryFn: () => listRecentlyRead(HISTORY_LIMIT),
  });
  const latestEntry = query.data?.[0] ?? null;
  const nextChapterQuery = useQuery({
    queryKey: [
      "chapter",
      "history",
      "next",
      latestEntry?.chapterId ?? 0,
    ] as const,
    queryFn: () => {
      if (!latestEntry) return null;
      return getAdjacentChapter(latestEntry.novelId, latestEntry.position, 1);
    },
    enabled: !!latestEntry && latestEntry.progress >= FINISHED_PROGRESS,
  });
  const removeHistory = useMutation({
    mutationFn: clearNovelHistory,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["chapter", "history"] });
      void queryClient.invalidateQueries({ queryKey: ["novel"] });
    },
  });

  const visibleEntries = useMemo(
    () =>
      (query.data ?? []).filter(
        (entry) =>
          matchesSearch(entry, search) &&
          matchesProgressFilter(entry, progressFilter),
      ),
    [progressFilter, query.data, search],
  );
  const sections = useMemo(
    () => groupByDateBucket(visibleEntries),
    [visibleEntries],
  );
  const hasActiveFilter = search.trim() !== "" || progressFilter !== "all";

  const openChapter = (chapterId: number) => {
    void navigate({ to: "/reader", search: { chapterId } });
  };
  const openNovel = (novelId: number) => {
    void navigate({ to: "/novel", search: { id: novelId } });
  };
  const continueReading = (entry: RecentlyReadEntry) => {
    if (entry.progress < FINISHED_PROGRESS) {
      openChapter(entry.chapterId);
      return;
    }

    void getAdjacentChapter(entry.novelId, entry.position, 1)
      .then((nextChapter) => openChapter(nextChapter?.id ?? entry.chapterId))
      .catch(() => openChapter(entry.chapterId));
  };

  return (
    <PageFrame className="lnr-history-page" size="wide">
      <PageHeader
        title={
          <span className="lnr-history-header-title">
            <span>{t("history.title")}</span>
            <span className="lnr-history-header-description">
              {t("history.description")}
            </span>
          </span>
        }
      />

      <FilterBar
        progressFilter={progressFilter}
        searchInput={searchInput}
        onProgressFilterChange={setProgressFilter}
        onSearchInputChange={setSearchInput}
        onSearchSubmit={() => setSearch(searchInput)}
      />

      {latestEntry ? (
        <div className="lnr-history-top-grid">
          <ResumePanel
            entry={latestEntry}
            nextChapterName={nextChapterQuery.data?.name ?? null}
            nextChapterPosition={nextChapterQuery.data?.position ?? null}
            checkingNextChapter={nextChapterQuery.isFetching}
            onOpenNovel={() => openNovel(latestEntry.novelId)}
            onContinueReading={() => {
              if (
                latestEntry.progress >= FINISHED_PROGRESS &&
                nextChapterQuery.data?.id
              ) {
                openChapter(nextChapterQuery.data.id);
                return;
              }
              continueReading(latestEntry);
            }}
          />
          <HistorySummaryPanel entries={visibleEntries} sections={sections} />
        </div>
      ) : null}

      {query.isLoading ? (
        <HistoryLoadingState />
      ) : query.error ? (
        <HistoryErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : sections.length > 0 ? (
        <Stack gap="lg">
          {sections.map((section) => (
            <HistorySection
              count={section.entries.length}
              key={section.label}
              title={section.label}
            >
              {section.entries.map((entry) => (
                <HistoryRow
                  key={entry.novelId}
                  entry={entry}
                  removingNovelId={
                    removeHistory.isPending
                      ? (removeHistory.variables ?? null)
                      : null
                  }
                  onOpenNovel={() => openNovel(entry.novelId)}
                  onContinueReading={() => continueReading(entry)}
                  onRemoveNovel={() => removeHistory.mutate(entry.novelId)}
                />
              ))}
            </HistorySection>
          ))}
        </Stack>
      ) : (
        <HistoryEmptyState
          hasSearch={hasActiveFilter}
          onOpenLibrary={() => void navigate({ to: "/" })}
        />
      )}
    </PageFrame>
  );
}
