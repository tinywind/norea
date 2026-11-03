import { useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@mantine/core";
import { PageFrame, StateView } from "../components/AppFrame";
import {
  FINISHED_PROGRESS,
  HistoryRow,
  HistoryRowsSkeleton,
} from "../components/history/HistoryRows";
import { SearchBar } from "../components/SearchBar";
import { CheckIcon } from "../components/ui/icons";
import {
  clearNovelHistory,
  getAdjacentChapter,
  listRecentlyRead,
  type RecentlyReadEntry,
} from "../db/queries/chapter";
import { useTranslation, type TranslationKey } from "../i18n";
import { describeError } from "../lib/errors";
import "../styles/history.css";

const HISTORY_LIMIT = 100;

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
const PROGRESS_FILTERS: { label: TranslationKey; value: ProgressFilter }[] = [
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

export function HistoryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [progressFilter, setProgressFilter] =
    useState<ProgressFilter>("all");

  const query = useQuery({
    meta: { errorPresentation: "inline" },
    queryKey: ["chapter", "history", HISTORY_LIMIT] as const,
    queryFn: () => listRecentlyRead(HISTORY_LIMIT),
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
    <div className="norea-history-page">
      <header className="norea-history-app-bar">
        <h1 className="norea-history-app-bar-title">{t("history.title")}</h1>
      </header>

      <PageFrame className="norea-history-frame" size="wide">
        <div className="norea-history-filters">
          <SearchBar
            value={searchInput}
            onChange={setSearchInput}
            onClear={() => setSearch("")}
            onSubmit={() => setSearch(searchInput)}
            placeholder={t("history.filter.placeholder")}
          />
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
        ) : query.error ? (
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
                    onContinue={() => continueReading(entry)}
                    onOpen={() => openNovel(entry.novelId)}
                    onRemove={() => removeHistory.mutate(entry.novelId)}
                    removing={
                      removeHistory.isPending &&
                      removeHistory.variables === entry.novelId
                    }
                  />
                ))}
              </section>
            ))}
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
