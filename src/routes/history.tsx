import { useMemo, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@mantine/core";
import { PageFrame, PageHeader, StateView } from "../components/AppFrame";
import {
  FINISHED_PROGRESS,
  HistoryRow,
  HistoryRowsSkeleton,
} from "../components/history/HistoryRows";
import { NearEndSentinel } from "../components/NearEndSentinel";
import { SearchBar } from "../components/SearchBar";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { CheckIcon, TrashIcon } from "../components/ui/icons";
import { OverflowMenu } from "../components/ui/OverflowMenu";
import {
  clearNovelHistory,
  getAdjacentChapter,
  listRecentlyRead,
  type ChapterListRow,
  type RecentlyReadEntry,
} from "../db/queries/chapter";
import {
  listReadingHistoryPage,
  type HistoryCursor,
  type HistoryProgressFilter,
} from "../db/queries/history-search";
import { useTranslation, type TranslationKey } from "../i18n";
import { describeError } from "../lib/errors";
import "../styles/history.css";

const HISTORY_LIMIT = 100;

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
const PROGRESS_FILTERS: { label: TranslationKey; value: HistoryProgressFilter }[] = [
  { label: "history.filter.all", value: "all" },
  { label: "common.inProgress", value: "inProgress" },
  { label: "common.finished", value: "finished" },
];

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

/** Pages can overlap when a novel is read while older pages load. */
function uniqueByNovel(entries: readonly RecentlyReadEntry[]): RecentlyReadEntry[] {
  const seen = new Set<number>();
  return entries.filter((entry) => {
    if (seen.has(entry.novelId)) return false;
    seen.add(entry.novelId);
    return true;
  });
}

/** Clears every novel's history, one novel at a time, until none is left. */
async function clearAllHistory(): Promise<void> {
  const cleared = new Set<number>();
  for (;;) {
    const pending = (await listRecentlyRead(HISTORY_LIMIT)).filter(
      (entry) => !cleared.has(entry.novelId),
    );
    if (pending.length === 0) return;
    for (const entry of pending) {
      await clearNovelHistory(entry.novelId);
      cleared.add(entry.novelId);
    }
  }
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

export function HistoryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [progressFilter, setProgressFilter] =
    useState<HistoryProgressFilter>("all");
  const appliedSearch = search.trim();

  const query = useInfiniteQuery({
    meta: { errorPresentation: "inline" },
    queryKey: ["chapter", "history", "page", appliedSearch, progressFilter] as const,
    queryFn: ({ pageParam }) =>
      listReadingHistoryPage({
        cursor: pageParam,
        progress: progressFilter,
        readMode: "committed",
        search: appliedSearch,
      }),
    initialPageParam: null as HistoryCursor | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
  const invalidateHistory = () => {
    void queryClient.invalidateQueries({ queryKey: ["chapter", "history"] });
    void queryClient.invalidateQueries({ queryKey: ["novel"] });
  };
  const removeHistory = useMutation({
    mutationFn: clearNovelHistory,
    onSuccess: invalidateHistory,
  });
  const clearHistory = useMutation({
    mutationFn: clearAllHistory,
    onSettled: invalidateHistory,
  });

  const visibleEntries = useMemo(
    () => uniqueByNovel(query.data?.pages.flatMap((page) => page.entries) ?? []),
    [query.data],
  );
  const sections = useMemo(
    () => groupByDateBucket(visibleEntries),
    [visibleEntries],
  );
  const hasActiveFilter = appliedSearch !== "" || progressFilter !== "all";
  const clearFilters = () => {
    setSearchInput("");
    setSearch("");
    setProgressFilter("all");
  };

  const openChapter = (chapterId: number) => {
    void navigate({ to: "/reader", search: { chapterId } });
  };
  const openNovel = (novelId: number) => {
    void navigate({ to: "/novel", search: { id: novelId } });
  };
  const continueReading = (
    entry: RecentlyReadEntry,
    nextChapter: ChapterListRow | null | undefined,
  ) => {
    if (entry.progress < FINISHED_PROGRESS) {
      openChapter(entry.chapterId);
      return;
    }
    if (nextChapter !== undefined) {
      openChapter(nextChapter?.id ?? entry.chapterId);
      return;
    }

    void getAdjacentChapter(entry.novelId, entry.position, 1)
      .then((nextChapter) => openChapter(nextChapter?.id ?? entry.chapterId))
      .catch(() => openChapter(entry.chapterId));
  };
  const confirmRemove = async (entry: RecentlyReadEntry) => {
    const confirmed = await confirm({
      confirmLabel: t("common.remove"),
      danger: true,
      message: t("history.removeConfirm.message", { name: entry.novelName }),
      title: t("history.removeConfirm.title"),
    });
    if (confirmed) removeHistory.mutate(entry.novelId);
  };
  const confirmClearAll = async () => {
    const confirmed = await confirm({
      confirmLabel: t("history.clearAll.confirm"),
      danger: true,
      message: t("history.clearAll.message"),
      title: t("history.clearAll.title"),
    });
    if (confirmed) clearHistory.mutate();
  };

  return (
    <div className="norea-history-page">
      <PageHeader
        actions={
          <OverflowMenu
            items={[
              {
                danger: true,
                disabled:
                  (!hasActiveFilter && visibleEntries.length === 0) ||
                  clearHistory.isPending,
                icon: TrashIcon,
                label: t("history.clearAll.action"),
                onClick: () => void confirmClearAll(),
              },
            ]}
            label={t("common.more")}
          />
        }
        title={t("history.title")}
      >
        <SearchBar
          value={searchInput}
          onChange={setSearchInput}
          onClear={() => setSearch("")}
          onSubmit={() => setSearch(searchInput)}
          placeholder={t("history.filter.placeholder")}
        />
      </PageHeader>

      <PageFrame className="norea-history-frame" size="wide">
        <div className="norea-history-filters">
          <div
            aria-label={t("history.filter.label")}
            className="norea-history-chips"
            role="group"
          >
            {PROGRESS_FILTERS.map((filter) => {
              const active = progressFilter === filter.value;
              return (
                <Button
                  aria-pressed={active}
                  key={filter.value}
                  leftSection={active ? <CheckIcon size="1rem" /> : undefined}
                  onClick={() => setProgressFilter(filter.value)}
                  radius="xl"
                  size="compact-sm"
                  variant={active ? "light" : "default"}
                >
                  {t(filter.label)}
                </Button>
              );
            })}
          </div>
        </div>

        {query.isLoading ? (
          <HistoryRowsSkeleton label={t("history.loading")} />
        ) : query.error && visibleEntries.length === 0 ? (
          <StateView
            action={{
              label: t("common.retry"),
              onClick: () => {
                void query.refetch();
              },
            }}
            color="danger"
            details={{
              content: describeError(query.error),
              label: t("common.details"),
            }}
            title={t("history.loadError")}
          />
        ) : sections.length > 0 ? (
          <div className="norea-history-sections">
            {sections.map((section) => (
              <section
                aria-labelledby={`norea-history-${section.label}`}
                className="norea-history-section"
                key={section.label}
              >
                <h2
                  className="norea-history-section-title"
                  id={`norea-history-${section.label}`}
                >
                  {t(DATE_BUCKET_LABEL_KEYS[section.label])}
                </h2>
                {section.entries.map((entry) => (
                  <HistoryRow
                    key={entry.novelId}
                    entry={entry}
                    onContinue={(nextChapter) => continueReading(entry, nextChapter)}
                    onOpenNovel={() => openNovel(entry.novelId)}
                    onRemove={() => void confirmRemove(entry)}
                    removing={
                      clearHistory.isPending ||
                      (removeHistory.isPending &&
                        removeHistory.variables === entry.novelId)
                    }
                  />
                ))}
              </section>
            ))}
            <NearEndSentinel
              className="norea-history-near-end"
              enabled={query.hasNextPage && !query.isFetchingNextPage && !query.error}
              onNearEnd={() => void query.fetchNextPage()}
            />
            {query.hasNextPage ? (
              <Button
                className="norea-history-load-more"
                loading={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
                variant="default"
              >
                {t("common.loadMore")}
              </Button>
            ) : null}
          </div>
        ) : hasActiveFilter ? (
          <StateView
            action={{ label: t("history.filter.clear"), onClick: clearFilters }}
            message={t("history.empty.noMatches.message")}
            title={t("common.noMatches")}
          />
        ) : (
          <StateView
            action={{
              label: t("history.empty.openLibrary"),
              onClick: () => void navigate({ to: "/" }),
            }}
            message={t("history.empty.noHistory.message")}
            title={t("history.empty.noHistory.title")}
          />
        )}
      </PageFrame>
    </div>
  );
}
