import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ActionIcon,
  Button,
  Group,
  Indicator,
  TextInput,
} from "@mantine/core";
import {
  BlockingLoadingOverlay,
  PageFrame,
  PageHeader,
  StateView,
} from "../components/AppFrame";
import { CoverGridSkeleton } from "../components/browse/CoverGridSkeleton";
import { PluginSettingsDialog } from "../components/browse/PluginSettingsDialog";
import { QuickAddCard } from "../components/browse/QuickAddCard";
import { useQuickAddToLibrary } from "../components/browse/use-quick-add";
import {
  hasPluginInputs,
  useInstalledPlugins,
} from "../components/browse/use-plugin-catalog";
import { IconButton } from "../components/IconButton";
import { NearEndSentinel } from "../components/NearEndSentinel";
import {
  PluginFilters,
  type ResolvedFilterValues,
} from "../components/PluginFilters";
import { ReaderSettingsPanel } from "../components/ReaderSettingsPanel";
import { SourceAccessNotice } from "../components/SourceAccessVerifyButton";
import { SourceNovelCover } from "../components/SourceNovelCover";
import {
  CloseIcon,
  FilterIcon,
  ReaderSettingsIcon,
  SearchIcon,
  SettingsIcon,
  SourceIcon,
} from "../components/ui/icons";
import { OverflowMenu, type OverflowMenuItem } from "../components/ui/OverflowMenu";
import { ResponsiveSheet } from "../components/ui/ResponsiveSheet";
import { usePageBackNavigation } from "../lib/android-back-navigation";
import { describeError } from "../lib/errors";
import { enqueueOpenNovelFromSourceTask } from "../lib/plugins/open-novel-task";
import { openPluginSite } from "../lib/plugins/open-plugin-site";
import { FilterTypes, type Filters } from "../lib/plugins/filterTypes";
import { pluginManager } from "../lib/plugins/manager";
import {
  emptySourceFilterValues,
  readSourceFilters,
  writeSourceFilters,
} from "../lib/plugins/source-filter-storage";
import type { NovelItem, Plugin } from "../lib/plugins/types";
import {
  findPreviousAppHistoryEntry,
  trimAppNavigationHistoryTo,
} from "../lib/navigation-history";
import { useLibraryNovelMembership } from "../lib/use-library-novel-membership";
import { enqueueSourceTask } from "../lib/tasks/source-tasks";
import {
  taskScheduler,
  type TaskHandle,
} from "../lib/tasks/scheduler";
import { isAbortError } from "../lib/abort";
import { useTranslation } from "../i18n";
import "../styles/browse.css";

/** More text fields than this open the filter form full screen on phones. */
const MAX_SHEET_TEXT_FILTERS = 2;

interface ListingPage {
  items: NovelItem[];
  page: number;
  scopeKey: string;
}

interface AccumulatedNovel {
  item: NovelItem;
  key: string;
}

export function canLoadSourceListing(
  plugin: Plugin | undefined,
  filterOwner: Plugin | undefined,
  pluginId: string,
  shouldLoadListing: boolean,
): boolean {
  return Boolean(
    plugin &&
      plugin === filterOwner &&
      pluginId.length > 0 &&
      shouldLoadListing,
  );
}

function countActiveFilters(filters: ResolvedFilterValues): number {
  return Object.values(filters).filter((entry) => {
    const value = entry.value;
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === "object") {
      const choices = value as { exclude?: unknown[]; include?: unknown[] };
      return (
        (choices.include?.length ?? 0) > 0 ||
        (choices.exclude?.length ?? 0) > 0
      );
    }
    return value !== null && value !== undefined && value !== "" && value !== false;
  }).length;
}

function getOptionLabel(
  options: readonly { label: string; value: string }[],
  value: string,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

function formatActiveFilter(
  filter: Filters[string],
  value: unknown,
): string | null {
  switch (filter.type) {
    case FilterTypes.TextInput: {
      const text = typeof value === "string" ? value.trim() : "";
      return text ? `${filter.label}: ${text}` : null;
    }
    case FilterTypes.Switch:
      return value === true ? filter.label : null;
    case FilterTypes.Picker: {
      const selected = typeof value === "string" ? value : "";
      return selected
        ? `${filter.label}: ${getOptionLabel(filter.options, selected)}`
        : null;
    }
    case FilterTypes.CheckboxGroup: {
      const selected = Array.isArray(value) ? value : [];
      if (selected.length === 0) return null;
      const labels = selected.map((item) => getOptionLabel(filter.options, item));
      return `${filter.label}: ${labels.join(", ")}`;
    }
    case FilterTypes.ExcludableCheckboxGroup: {
      const selected =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as { exclude?: string[]; include?: string[] })
          : {};
      const include = selected.include ?? [];
      const exclude = selected.exclude ?? [];
      const labels = [
        ...include.map((item) => `+${getOptionLabel(filter.options, item)}`),
        ...exclude.map((item) => `-${getOptionLabel(filter.options, item)}`),
      ];
      return labels.length > 0 ? `${filter.label}: ${labels.join(", ")}` : null;
    }
    default:
      return null;
  }
}

export function getActiveFilterLabels(
  schema: Filters,
  filters: ResolvedFilterValues,
): Array<{ key: string; label: string }> {
  return Object.entries(schema).flatMap(([key, filter]) => {
    const label = formatActiveFilter(filter, filters[key]?.value);
    return label ? [{ key, label }] : [];
  });
}

function countTextFilters(schema: Filters): number {
  return Object.values(schema).filter((filter) => filter.type === FilterTypes.TextInput).length;
}

interface SourceNovelButtonProps {
  disabled: boolean;
  inLibrary: boolean;
  item: NovelItem;
  onAdd: (item: NovelItem) => void;
  onOpen: (item: NovelItem) => void;
  pending: boolean;
  plugin: Plugin;
}

function SourceNovelButton({
  disabled,
  inLibrary,
  item,
  onAdd,
  onOpen,
  pending,
  plugin,
}: SourceNovelButtonProps) {
  return (
    <QuickAddCard
      className="norea-source-card norea-state-layer"
      disabled={disabled}
      inLibrary={inLibrary}
      name={item.name}
      onAdd={() => onAdd(item)}
      onOpen={() => onOpen(item)}
      pending={pending}
    >
      <SourceNovelCover
        height={152}
        inLibrary={inLibrary}
        item={item}
        plugin={plugin}
        width={104}
      />
      <span className="norea-source-card-title" title={item.name}>
        {item.name}
      </span>
    </QuickAddCard>
  );
}

interface SourcePageProps {
  pluginId: string;
  query: string;
}

export function SourcePage({ pluginId, query }: SourcePageProps) {
  const { t } = useTranslation();
  const currentHref = useRouterState({
    select: (state) => state.location.href,
  });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isInLibrary = useLibraryNovelMembership();
  const quickAdd = useQuickAddToLibrary();

  const installed = useInstalledPlugins(true);
  const plugin = useMemo(
    () =>
      installed.data?.find((entry) => entry.id === pluginId) ??
      pluginManager.getPlugin(pluginId),
    [installed.data, pluginId],
  );

  const [page, setPage] = useState(1);
  const [loadedPages, setLoadedPages] = useState<ListingPage[]>([]);
  const [searchOpen, setSearchOpen] = useState(() => query.trim().length > 0);
  const [search, setSearch] = useState(query);
  const [submittedSearch, setSubmittedSearch] = useState(query);

  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [readerSettingsOpen, setReaderSettingsOpen] = useState(false);
  const openTaskRef = useRef<TaskHandle<number> | null>(null);
  const initialFilters = useMemo<ResolvedFilterValues>(
    () => (plugin?.filters ? readSourceFilters(plugin, plugin.filters) : {}),
    [plugin],
  );
  const [pendingFilters, setPendingFilters] =
    useState<ResolvedFilterValues>(initialFilters);
  const [activeFilters, setActiveFilters] =
    useState<ResolvedFilterValues>(initialFilters);
  const [filterOwner, setFilterOwner] = useState<Plugin | undefined>(plugin);

  useEffect(() => {
    setPendingFilters(initialFilters);
    setActiveFilters(initialFilters);
    setFilterOwner(plugin);
  }, [initialFilters, plugin]);

  useEffect(() => {
    setSearch(query);
    setSubmittedSearch(query);
    setSearchOpen(query.trim().length > 0);
  }, [query]);

  const trimmedSearch = submittedSearch.trim();
  const isKeywordMode = trimmedSearch.length > 0;
  const popularModeLabel = t("source.popular");
  const activeFilterScope = JSON.stringify(activeFilters);
  const listingScopeKey = [
    isKeywordMode ? "keyword" : "filters",
    isKeywordMode ? trimmedSearch : "",
    isKeywordMode ? "" : activeFilterScope,
    pluginId,
  ].join("|");

  const lastKey = useRef("");
  useEffect(() => {
    if (listingScopeKey !== lastKey.current) {
      lastKey.current = listingScopeKey;
      setPage(1);
      setLoadedPages([]);
    }
  }, [listingScopeKey]);

  const listing = useQuery({
    meta: { errorPresentation: "inline" },
    enabled: canLoadSourceListing(plugin, filterOwner, pluginId, true),
    // Source failures (blocked sites, parser errors) are not transient, and
    // the default three retries only delay the visible error by ~7 seconds.
    retry: false,
    queryKey: [
      "plugin",
      "source",
      pluginId,
      listingScopeKey,
      page,
    ] as const,
    queryFn: async ({ signal }) => {
      if (!plugin) {
        return {
          items: [],
          page,
          scopeKey: listingScopeKey,
        } satisfies ListingPage;
      }
      const taskKind = isKeywordMode ? "source.search" : "source.listPopular";
      const title = isKeywordMode
        ? t("tasks.task.sourceSearch", {
            query: trimmedSearch,
            source: plugin.name,
          })
        : t("tasks.task.sourceList", {
            mode: popularModeLabel,
            source: plugin.name,
          });
      const task = enqueueSourceTask<NovelItem[]>({
        plugin,
        kind: taskKind,
        priority: "interactive",
        title,
        subject: {
          path: isKeywordMode
            ? `keyword:${trimmedSearch}:${page}`
            : `popular:${page}`,
        },
        dedupeKey: isKeywordMode
          ? `source.search:${plugin.id}:${trimmedSearch}:${page}`
          : `source.list:${plugin.id}:popular:${activeFilterScope}:${page}`,
        run: async (context) => {
          const runtimePlugin = pluginManager.getPluginForExecutor(
            plugin.id,
            context.executor ?? "immediate",
          );
          if (isKeywordMode) {
            return runtimePlugin.searchNovels(trimmedSearch, page);
          }
          return runtimePlugin.popularNovels(page, {
            showLatestNovels: false,
            filters: activeFilters as never,
          });
        },
      });
      const cancelTask = () => taskScheduler.cancel(task.id);
      signal.addEventListener("abort", cancelTask, { once: true });
      if (signal.aborted) cancelTask();

      try {
        const items = await task.promise;
        return { items, page, scopeKey: listingScopeKey };
      } finally {
        signal.removeEventListener("abort", cancelTask);
      }
    },
  });

  const openSite = useCallback((): void => {
    if (!plugin) return;
    openPluginSite(plugin, t("tasks.task.openSite", { source: plugin.name }));
  }, [plugin, t]);

  useEffect(() => {
    const data = listing.data;
    if (!data || data.page !== page || data.scopeKey !== listingScopeKey) {
      return;
    }
    setLoadedPages((prev) => {
      const next =
        data.page === 1
          ? [data]
          : [...prev.filter((entry) => entry.page !== data.page), data];
      return next.sort((a, b) => a.page - b.page);
    });
  }, [listing.data, listingScopeKey, page]);

  const accumulatedNovels = useMemo<AccumulatedNovel[]>(
    () =>
      loadedPages.flatMap((entry) =>
        entry.items.map((item, index) => ({
          item,
          key: `${entry.scopeKey}:${entry.page}:${index}:${item.path}`,
        })),
      ),
    [loadedPages],
  );

  const open = useMutation({
    meta: { errorPresentation: "inline" },
    mutationFn: async (item: NovelItem) => {
      if (!plugin) throw new Error(t("source.pluginNotLoaded"));
      const task = enqueueOpenNovelFromSourceTask({
        plugin,
        item,
        title: t("tasks.task.openNovel", { name: item.name }),
      });
      openTaskRef.current = task;
      const novelId = await task.promise;
      if (openTaskRef.current?.id !== task.id) {
        throw new DOMException("Task was cancelled.", "AbortError");
      }
      return novelId;
    },
    onError: () => {
      openTaskRef.current = null;
    },
    onSuccess: async (novelId) => {
      const task = openTaskRef.current;
      if (!task) return;
      await queryClient.invalidateQueries({ queryKey: ["novel"] });
      if (openTaskRef.current?.id !== task.id) return;
      await navigate({ to: "/novel", search: { id: novelId } });
      if (openTaskRef.current?.id === task.id) {
        openTaskRef.current = null;
      }
    },
  });

  const cancelOpenNovel = useCallback((): boolean => {
    const task = openTaskRef.current;
    if (!task) return false;
    openTaskRef.current = null;
    taskScheduler.cancel(task.id);
    return true;
  }, []);

  const goBack = useCallback((): boolean => {
    if (cancelOpenNovel()) return true;

    void queryClient.cancelQueries({
      queryKey: ["plugin", "source", pluginId],
    });
    const target = findPreviousAppHistoryEntry(currentHref, ["/source"]);
    if (target) {
      trimAppNavigationHistoryTo(target);
      window.history.go(-target.steps);
      return true;
    }

    void navigate({
      to: "/browse",
      search: { q: "", tab: "search" },
      replace: true,
    });
    return true;
  }, [cancelOpenNovel, currentHref, navigate, pluginId, queryClient]);

  usePageBackNavigation(goBack);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearch("");
    setSubmittedSearch("");
  }, []);

  useEffect(
    () => () => {
      cancelOpenNovel();
    },
    [cancelOpenNovel],
  );

  if (!plugin && installed.isLoading) {
    return (
      <>
        <PageHeader onBack={goBack} />
        <PageFrame size="wide">
          <CoverGridSkeleton label={t("common.loading")} />
        </PageFrame>
      </>
    );
  }

  if (!plugin) {
    return (
      <>
        <PageHeader onBack={goBack} />
        <PageFrame>
          <StateView
            action={{ label: t("common.back"), onClick: () => void goBack() }}
            color={installed.error ? "danger" : "warn"}
            details={
              installed.error
                ? { content: describeError(installed.error), label: t("common.details") }
                : undefined
            }
            title={t("source.pluginNotLoaded")}
            message={t("source.pluginNotLoadedMessage", { id: pluginId })}
          />
        </PageFrame>
      </>
    );
  }

  const sourceFilters = plugin.filters;
  const hasFilters = !!sourceFilters && Object.keys(sourceFilters).length > 0;
  const activeFilterCount = countActiveFilters(activeFilters);
  const hasNextPage =
    !listing.isFetching &&
    !!listing.data &&
    listing.data.page === page &&
    listing.data.scopeKey === listingScopeKey &&
    listing.data.items.length > 0;
  const showLoadMoreButton = hasNextPage || (listing.isFetching && page > 1);
  const loadNextPage = () => setPage((current) => current + 1);
  const activeFilterLabels =
    !isKeywordMode && sourceFilters
      ? getActiveFilterLabels(sourceFilters, activeFilters)
      : [];
  const currentPage =
    listing.data?.scopeKey === listingScopeKey ? listing.data : undefined;
  const noResults =
    !listing.isFetching &&
    accumulatedNovels.length === 0 &&
    currentPage?.page === 1 &&
    currentPage.items.length === 0;
  const firstPageLoading =
    accumulatedNovels.length === 0 && !listing.error && !noResults;

  const applyFilters = (filters: ResolvedFilterValues) => {
    closeSearch();
    setActiveFilters(filters);
    writeSourceFilters(plugin, filters);
  };
  const removeFilter = (key: string) => {
    if (!sourceFilters) return;
    const empty = emptySourceFilterValues(sourceFilters)[key];
    if (!empty) return;
    applyFilters({ ...activeFilters, [key]: empty });
  };
  const overflowItems: OverflowMenuItem[] = [
    { icon: SourceIcon, label: t("common.openSite"), onClick: openSite },
    ...(hasPluginInputs(plugin)
      ? [{ icon: SettingsIcon, label: t("source.sourceSettings"), onClick: () => setSettingsOpen(true) }]
      : []),
    {
      icon: ReaderSettingsIcon,
      label: t("source.readerSettings"),
      onClick: () => setReaderSettingsOpen(true),
    },
  ];

  return (
    <div className="norea-source-page">
      {open.isPending ? (
        <BlockingLoadingOverlay
          cancelLabel={t("common.cancel")}
          label={t("globalSearch.openingNovel")}
          onCancel={cancelOpenNovel}
        >
          <SourceAccessNotice active sourceId={plugin.id} sourceName={plugin.name} />
        </BlockingLoadingOverlay>
      ) : null}
      <PageHeader
        actions={
          <>
            {searchOpen ? null : (
              <>
                <IconButton
                  label={t("source.searchPlaceholder", { name: plugin.name })}
                  onClick={() => setSearchOpen(true)}
                  size="lg"
                >
                  <SearchIcon />
                </IconButton>
                {hasFilters ? (
                  <Indicator
                    disabled={activeFilterCount === 0}
                    label={activeFilterCount}
                    offset={6}
                    size={16}
                  >
                    <IconButton
                      label={
                        activeFilterCount > 0
                          ? t("source.filtersActive", { count: activeFilterCount })
                          : t("source.filters")
                      }
                      onClick={() => {
                        setPendingFilters(activeFilters);
                        setFilterSheetOpen(true);
                      }}
                      size="lg"
                    >
                      <FilterIcon />
                    </IconButton>
                  </Indicator>
                ) : null}
              </>
            )}
            <OverflowMenu items={overflowItems} label={t("common.more")} />
          </>
        }
        onBack={goBack}
        title={plugin.name}
      >
        {searchOpen ? (
          <form
            className="norea-source-search"
            onSubmit={(event) => {
              event.preventDefault();
              setSubmittedSearch(search.trim());
            }}
            role="search"
          >
            <TextInput
              aria-label={t("source.searchPlaceholder", { name: plugin.name })}
              autoFocus
              leftSection={<SearchIcon size="1.125rem" />}
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder={t("source.searchPlaceholder", { name: plugin.name })}
              rightSection={
                <ActionIcon
                  aria-label={t("source.closeSearch")}
                  onClick={closeSearch}
                  variant="subtle"
                >
                  <CloseIcon size="1.125rem" />
                </ActionIcon>
              }
              type="search"
              value={search}
            />
          </form>
        ) : null}
      </PageHeader>

      {activeFilterLabels.length > 0 ? (
        <div
          aria-label={t("source.appliedFilters")}
          className="norea-source-applied-filters"
          role="group"
        >
          {activeFilterLabels.map((filter) => (
            <Button
              aria-label={t("source.removeFilter", { filter: filter.label })}
              className="norea-source-applied-filter"
              key={filter.key}
              onClick={() => removeFilter(filter.key)}
              radius="xl"
              rightSection={<CloseIcon size="0.875rem" />}
              size="compact-sm"
              variant="light"
            >
              {filter.label}
            </Button>
          ))}
        </div>
      ) : null}

      <PageFrame className="norea-source-frame" size="wide">
        <SourceAccessNotice active sourceId={plugin.id} sourceName={plugin.name} />
        {firstPageLoading ? (
          <CoverGridSkeleton
            label={
              isKeywordMode
                ? t("source.searching", { name: plugin.name, query: trimmedSearch })
                : t("source.loadingMode", { mode: popularModeLabel })
            }
          />
        ) : listing.error && accumulatedNovels.length === 0 ? (
          <StateView
            action={{ label: t("common.retry"), onClick: () => void listing.refetch() }}
            color="danger"
            details={{ content: describeError(listing.error), label: t("common.details") }}
            secondaryAction={{ label: t("common.openSite"), onClick: openSite }}
            title={t("source.error")}
          />
        ) : noResults ? (
          <StateView title={t("source.noResults")} />
        ) : (
          <>
            <div className="norea-source-grid">
              {accumulatedNovels.map(({ item, key }) => (
                <SourceNovelButton
                  key={key}
                  item={item}
                  disabled={open.isPending}
                  inLibrary={isInLibrary(plugin.id, item.path)}
                  pending={quickAdd.isPending({ kind: "source", item, plugin })}
                  plugin={plugin}
                  onAdd={(novel) => quickAdd.add({ kind: "source", item: novel, plugin })}
                  onOpen={(novel) => {
                    if (!open.isPending) open.mutate(novel);
                  }}
                />
              ))}
            </div>
            <NearEndSentinel
              className="norea-source-near-end"
              enabled={hasNextPage && !listing.error}
              onNearEnd={loadNextPage}
            />
            {listing.error ? (
              <StateView
                action={{ label: t("common.retry"), onClick: () => void listing.refetch() }}
                color="danger"
                details={{ content: describeError(listing.error), label: t("common.details") }}
                secondaryAction={{ label: t("common.openSite"), onClick: openSite }}
                title={t("source.error")}
              />
            ) : showLoadMoreButton ? (
              <Button
                className="norea-source-load-more"
                disabled={!hasNextPage}
                loading={listing.isFetching && page > 1}
                onClick={loadNextPage}
                variant="default"
              >
                {t("common.loadMore")}
              </Button>
            ) : null}
          </>
        )}

        {open.error && !isAbortError(open.error) ? (
          <StateView
            color="danger"
            details={{ content: describeError(open.error), label: t("common.details") }}
            title={t("common.openFailed")}
          />
        ) : null}
      </PageFrame>

      {sourceFilters && hasFilters ? (
        <ResponsiveSheet
          desktopVariant="side"
          fullScreenOnPhone={countTextFilters(sourceFilters) > MAX_SHEET_TEXT_FILTERS}
          opened={filterSheetOpen}
          onClose={() => setFilterSheetOpen(false)}
          title={t("source.drawerTitle", { name: plugin.name })}
          footer={
            <Group justify="space-between">
              <Button
                variant="subtle"
                onClick={() => setPendingFilters(emptySourceFilterValues(sourceFilters))}
              >
                {t("common.reset")}
              </Button>
              <Group gap="xs">
                <Button variant="default" onClick={() => setFilterSheetOpen(false)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  onClick={() => {
                    applyFilters(pendingFilters);
                    setFilterSheetOpen(false);
                  }}
                >
                  {t("common.apply")}
                </Button>
              </Group>
            </Group>
          }
        >
          <PluginFilters
            schema={sourceFilters}
            values={pendingFilters}
            onChange={setPendingFilters}
          />
        </ResponsiveSheet>
      ) : null}
      <PluginSettingsDialog
        onClose={() => setSettingsOpen(false)}
        onSaved={() => void listing.refetch()}
        plugin={settingsOpen ? plugin : null}
      />
      {quickAdd.categorySheet}
      <ResponsiveSheet
        desktopVariant="side"
        fullScreenOnPhone
        opened={readerSettingsOpen}
        onClose={() => setReaderSettingsOpen(false)}
        title={t("readerSettings.source.title", { name: plugin.name })}
      >
        <ReaderSettingsPanel
          target={{
            kind: "source",
            sourceId: plugin.id,
            label: plugin.name,
          }}
        />
      </ResponsiveSheet>
    </div>
  );
}
