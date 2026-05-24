import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Anchor,
  Badge,
  Box,
  Drawer,
  Group,
  Loader,
  Stack,
  Text,
} from "@mantine/core";
import { PageFrame, PageHeader, StateView } from "../components/AppFrame";
import {
  ChevronDownGlyph,
  ExternalLinkGlyph,
  ReaderSettingsGlyph,
  SettingsGlyph,
} from "../components/ActionGlyphs";
import { SegmentedToggle } from "../components/SegmentedToggle";
import { TextButton } from "../components/TextButton";
import {
  ConsoleChip,
  ConsoleCover,
  ConsolePanel,
  ConsoleSectionHeader,
  ConsoleStatusDot,
  ConsoleStatusStrip,
} from "../components/ConsolePrimitives";
import {
  PluginFilters,
  type ResolvedFilterValues,
} from "../components/PluginFilters";
import { IconButton } from "../components/IconButton";
import { PluginSettingsEditor } from "../components/PluginSettingsEditor";
import { ReaderSettingsPanel } from "../components/ReaderSettingsPanel";
import { SearchBar } from "../components/SearchBar";
import { getPluginBaseUrl } from "../lib/plugins/base-url";
import { enqueueOpenNovelFromSourceTask } from "../lib/plugins/open-novel-task";
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
import {
  enqueueOpenSiteTask,
  enqueueSourceTask,
} from "../lib/tasks/source-tasks";
import { isTauriRuntime } from "../lib/tauri-runtime";
import { useTranslation } from "../i18n";
import { sourceRoute } from "../router";
import "../styles/browse.css";

const INSTALLED_QUERY_KEY = ["plugin", "installed"] as const;

type SourceFilterMode = "keyword" | "filters";

interface ListingPage {
  items: NovelItem[];
  page: number;
  scopeKey: string;
}

interface AccumulatedNovel {
  item: NovelItem;
  key: string;
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

function getActiveFilterLabels(
  schema: Filters,
  filters: ResolvedFilterValues,
): Array<{ key: string; label: string }> {
  return Object.entries(schema).flatMap(([key, filter]) => {
    const label = formatActiveFilter(filter, filters[key]?.value);
    return label ? [{ key, label }] : [];
  });
}

function hasPluginInputs(plugin: Plugin | null | undefined): boolean {
  if (!plugin) return false;
  return (
    Object.keys(plugin.pluginInputs ?? {}).length > 0 ||
    Object.keys(plugin.pluginSettings ?? {}).length > 0
  );
}

interface SourceNovelButtonProps {
  disabled: boolean;
  item: NovelItem;
  onOpen: (item: NovelItem) => void;
}

function SourceNovelButton({
  disabled,
  item,
  onOpen,
}: SourceNovelButtonProps) {
  return (
    <button
      type="button"
      className="lnr-source-card"
      disabled={disabled}
      onClick={() => onOpen(item)}
    >
      <ConsoleCover
        alt={item.name}
        src={item.cover ?? null}
        width={104}
        height={152}
      />
      <span className="lnr-source-card-title" title={item.name}>
        {item.name}
      </span>
      <span className="lnr-source-card-path" title={item.path}>
        {item.path}
      </span>
    </button>
  );
}

function BackGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M15 18l-6-6 6-6" />
      <path d="M9 12h11" />
    </svg>
  );
}

export function SourcePage() {
  const { t } = useTranslation();
  const { pluginId, query } = sourceRoute.useSearch();
  const currentHref = useRouterState({
    select: (state) => state.location.href,
  });
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const installed = useQuery({
    queryKey: INSTALLED_QUERY_KEY,
    queryFn: async () => {
      if (isTauriRuntime()) {
        await pluginManager.loadInstalledFromDb();
      }
      return pluginManager.list();
    },
    staleTime: 0,
  });
  const plugin = useMemo(
    () =>
      installed.data?.find((entry) => entry.id === pluginId) ??
      pluginManager.getPlugin(pluginId),
    [installed.data, pluginId],
  );

  const [page, setPage] = useState(1);
  const [loadedPages, setLoadedPages] = useState<ListingPage[]>([]);
  const [filterMode, setFilterMode] = useState<SourceFilterMode>(() =>
    query.trim().length > 0 ? "keyword" : "filters",
  );
  const [search, setSearch] = useState(query);
  const [submittedSearch, setSubmittedSearch] = useState(query);

  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
  const [settingsDrawerOpen, setSettingsDrawerOpen] = useState(false);
  const [readerSettingsDrawerOpen, setReaderSettingsDrawerOpen] =
    useState(false);
  const initialFilters = useMemo<ResolvedFilterValues>(
    () => (plugin?.filters ? readSourceFilters(plugin, plugin.filters) : {}),
    [plugin],
  );
  const [pendingFilters, setPendingFilters] =
    useState<ResolvedFilterValues>(initialFilters);
  const [activeFilters, setActiveFilters] =
    useState<ResolvedFilterValues>(initialFilters);

  useEffect(() => {
    setPendingFilters(initialFilters);
    setActiveFilters(initialFilters);
  }, [initialFilters]);

  useEffect(() => {
    setSearch(query);
    setSubmittedSearch(query);
    setFilterMode(query.trim().length > 0 ? "keyword" : "filters");
  }, [query]);

  const trimmedSearch = submittedSearch.trim();
  const isKeywordMode = filterMode === "keyword";
  const isFilterMode = filterMode === "filters";
  const hasKeywordSearch = isKeywordMode && trimmedSearch.length > 0;
  const shouldLoadListing = isFilterMode || hasKeywordSearch;
  const popularModeLabel = t("source.popular");
  const activeFilterScope = JSON.stringify(activeFilters);
  const listingScopeKey = [
    filterMode,
    isKeywordMode ? trimmedSearch : "",
    isFilterMode ? activeFilterScope : "",
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
    enabled: !!plugin && pluginId.length > 0 && shouldLoadListing,
    queryKey: [
      "plugin",
      "source",
      pluginId,
      listingScopeKey,
      page,
    ] as const,
    queryFn: async () => {
      if (!plugin || !shouldLoadListing) {
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
      const items = await enqueueSourceTask<NovelItem[]>({
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
      }).promise;
      return { items, page, scopeKey: listingScopeKey };
    },
  });

  function openPluginSite(): void {
    if (!plugin) return;
    const url = getPluginBaseUrl(plugin);
    void enqueueOpenSiteTask(
      plugin,
      url,
      t("tasks.task.openSite", { source: plugin.name }),
    ).promise.catch(() => undefined);
  }

  const goBack = useCallback((): void => {
    const target = findPreviousAppHistoryEntry(currentHref, ["/source"]);
    if (target) {
      trimAppNavigationHistoryTo(target);
      window.history.go(-target.steps);
      return;
    }

    void navigate({
      to: "/browse",
      search: { q: "", tab: "search" },
      replace: true,
    });
  }, [currentHref, navigate]);

  useEffect(() => {
    window.addEventListener("norea:android-back", goBack);
    return () => {
      window.removeEventListener("norea:android-back", goBack);
    };
  }, [goBack]);

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

  const accumulated = useMemo(
    () => loadedPages.flatMap((entry) => entry.items),
    [loadedPages],
  );
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
    mutationFn: async (item: NovelItem) => {
      if (!plugin) throw new Error(t("source.pluginNotLoaded"));
      return enqueueOpenNovelFromSourceTask({
        plugin,
        item,
        title: t("tasks.task.openNovel", { name: item.name }),
      }).promise;
    },
    onSuccess: (novelId) => {
      void queryClient.invalidateQueries({ queryKey: ["novel"] });
      void navigate({ to: "/novel", search: { id: novelId } });
    },
  });

  if (!plugin && installed.isLoading) {
    return (
      <PageFrame>
        <StateView
          title={
            <Group gap="sm">
              <Loader size="sm" />
              {t("common.loading")}
            </Group>
          }
        />
      </PageFrame>
    );
  }

  if (!plugin) {
    return (
      <PageFrame>
        <StateView
          color={installed.error ? "red" : "orange"}
          title={t("source.pluginNotLoaded")}
          message={
            installed.error instanceof Error
              ? installed.error.message
              : t("source.pluginNotLoadedMessage", { id: pluginId })
          }
        />
      </PageFrame>
    );
  }

  const sourceFilters = plugin.filters;
  const filterCount = sourceFilters
    ? Object.keys(sourceFilters).length
    : 0;
  const hasPluginSettings = hasPluginInputs(plugin);
  const activeFilterCount = countActiveFilters(activeFilters);
  const hasNextPage =
    shouldLoadListing &&
    !listing.isFetching &&
    !!listing.data &&
    listing.data.page === page &&
    listing.data.scopeKey === listingScopeKey &&
    listing.data.items.length > 0;
  const showLoadMoreButton =
    hasNextPage || (listing.isFetching && page > 1);
  const sourceStatus: "active" | "done" | "error" = listing.error
    ? "error"
    : listing.isFetching
      ? "active"
      : "done";
  const activeFilterLabels = isFilterMode && sourceFilters
    ? getActiveFilterLabels(sourceFilters, activeFilters)
    : [];

  return (
    <PageFrame size="wide" className="lnr-source-page">
      <PageHeader
        title={plugin.name}
        description={
          <Anchor
            size="xs"
            c="dimmed"
            onClick={(event) => {
              event.preventDefault();
              openPluginSite();
            }}
          >
            {getPluginBaseUrl(plugin)}
          </Anchor>
        }
        actions={
          <>
            <IconButton
              label={t("common.back")}
              size="lg"
              onClick={goBack}
            >
              <BackGlyph />
            </IconButton>
            <span className="lnr-source-header-action-divider" aria-hidden />
            <IconButton
              active={readerSettingsDrawerOpen}
              label={t("readerSettings.source.open", { name: plugin.name })}
              size="lg"
              variant="subtle"
              onClick={() => setReaderSettingsDrawerOpen(true)}
            >
              <ReaderSettingsGlyph />
            </IconButton>
            <span className="lnr-source-header-action-divider" aria-hidden />
            {hasPluginSettings ? (
              <IconButton
                active={settingsDrawerOpen}
                label={t("pluginSettings.open", { name: plugin.name })}
                size="lg"
                variant="subtle"
                onClick={() => setSettingsDrawerOpen(true)}
              >
                <SettingsGlyph />
              </IconButton>
            ) : null}
            <Badge variant="light">{plugin.lang}</Badge>
            <Badge variant="light" color="gray">
              v{plugin.version}
            </Badge>
          </>
        }
      />

      <div className="lnr-source-workbench">
        <aside className="lnr-source-tools">
          <ConsolePanel title={t("source.controls")}>
            <Stack gap="sm" p="sm">
              <SegmentedToggle
                value={filterMode}
                onChange={(value) => setFilterMode(value as SourceFilterMode)}
                data={[
                  {
                    value: "keyword",
                    label: t("source.filterMode.keyword"),
                  },
                  {
                    value: "filters",
                    label: t("source.filterMode.filters"),
                  },
                ]}
              />

              {isKeywordMode ? (
                <SearchBar
                  value={search}
                  onChange={setSearch}
                  onSubmit={() => {
                    setFilterMode("keyword");
                    setSubmittedSearch(search);
                  }}
                  placeholder={t("source.searchPlaceholder", {
                    name: plugin.name,
                  })}
                />
              ) : null}

              {isFilterMode && filterCount > 0 ? (
                <div className="lnr-source-filter-row">
                  <TextButton
                    className="lnr-source-filter-trigger"
                    variant="light"
                    size="sm"
                    onClick={() => {
                      setPendingFilters(activeFilters);
                      setFilterDrawerOpen(true);
                    }}
                  >
                    {t("source.filtersButton", {
                      active: activeFilterCount,
                      total: filterCount,
                    })}
                  </TextButton>
                  {activeFilterLabels.map((filter) => (
                    <span
                      className="lnr-source-active-filter"
                      key={filter.key}
                      title={filter.label}
                    >
                      {filter.label}
                    </span>
                  ))}
                </div>
              ) : null}
            </Stack>
          </ConsolePanel>

          <ConsolePanel title={t("source.state")}>
            <div className="lnr-source-state-body">
              <Stack className="lnr-source-state-copy" gap="sm">
                <Group gap={6} wrap="wrap">
                  <ConsoleStatusDot
                    status={sourceStatus}
                    label={
                      listing.error
                        ? t("source.error")
                        : listing.isFetching
                          ? t("common.fetching")
                          : t("common.ready")
                    }
                  />
                  <ConsoleChip>{plugin.lang.toUpperCase()}</ConsoleChip>
                  <ConsoleChip>v{plugin.version}</ConsoleChip>
                  {isKeywordMode ? (
                    <ConsoleChip active>{t("source.searchMode")}</ConsoleChip>
                  ) : (
                    <ConsoleChip active>{popularModeLabel}</ConsoleChip>
                  )}
                </Group>
                <Box style={{ minWidth: 0 }}>
                  <Text className="lnr-console-kicker">
                    {t("source.preparedOrigin")}
                  </Text>
                  <Anchor
                    size="sm"
                    truncate
                    onClick={(event) => {
                      event.preventDefault();
                      openPluginSite();
                    }}
                  >
                    {getPluginBaseUrl(plugin)}
                  </Anchor>
                </Box>
              </Stack>
              <IconButton
                label={t("common.openWebView")}
                size="lg"
                variant="default"
                onClick={openPluginSite}
              >
                <ExternalLinkGlyph />
              </IconButton>
            </div>
          </ConsolePanel>
        </aside>


        <section className="lnr-source-results-panel">
          <ConsoleSectionHeader
            eyebrow={
              isKeywordMode
                ? t("source.searchEyebrow")
                : t("source.catalogEyebrow")
            }
            title={
              isKeywordMode
                ? hasKeywordSearch
                  ? `"${trimmedSearch}"`
                  : t("source.filterMode.keyword")
                : popularModeLabel
            }
            count={t("source.loadedCount", { count: accumulated.length })}
          />

          {isKeywordMode && !hasKeywordSearch ? (
            <StateView color="blue" title={t("source.keywordPrompt")} />
          ) : listing.isLoading && page === 1 ? (
            <StateView
              title={
                <Group gap="sm">
                  <Loader size="sm" />
                  {isKeywordMode
                    ? t("source.searching", {
                        name: plugin.name,
                        query: trimmedSearch,
                      })
                    : t("source.loadingMode", { mode: popularModeLabel })}
                </Group>
              }
            />
          ) : listing.error ? (
            <StateView
              color="red"
              title={t("source.error")}
              message={
                listing.error instanceof Error
                  ? listing.error.message
                  : String(listing.error)
              }
            />
          ) : accumulated.length === 0 ? (
            <StateView
              color="blue"
              title={t("source.noResults")}
            />
          ) : (
            <>
              <div className="lnr-source-grid">
                {accumulatedNovels.map(({ item, key }) => (
                  <SourceNovelButton
                    key={key}
                    item={item}
                    disabled={open.isPending}
                    onOpen={(novel) => {
                      if (!open.isPending) open.mutate(novel);
                    }}
                  />
                ))}
              </div>
              {showLoadMoreButton ? (
                <div className="lnr-source-load-more">
                  <IconButton
                    className="lnr-source-load-more-action"
                    label={t("common.loadMore")}
                    variant="default"
                    size="lg"
                    onClick={() => setPage((p) => p + 1)}
                    loading={listing.isFetching && page > 1}
                    disabled={!hasNextPage}
                  >
                    <ChevronDownGlyph />
                  </IconButton>
                </div>
              ) : null}
            </>
          )}

          {open.error ? (
            <StateView
              color="red"
              title={t("common.openFailed")}
              message={
                open.error instanceof Error
                  ? open.error.message
                  : String(open.error)
              }
            />
          ) : null}
        </section>
      </div>

      <ConsoleStatusStrip>
        <span>{plugin.name}</span>
        <span>
          {isKeywordMode
            ? hasKeywordSearch
              ? t("source.status.search", { query: trimmedSearch })
              : t("source.status.mode", {
                  mode: t("source.filterMode.keyword"),
                })
            : t("source.status.mode", { mode: popularModeLabel })}
        </span>
        <span>{t("source.status.page", { page })}</span>
        <span>{t("source.status.loadedNovels", { count: accumulated.length })}</span>
        <span>
          {t("source.status.activeFilters", {
            count: isFilterMode ? activeFilterCount : 0,
          })}
        </span>
      </ConsoleStatusStrip>

      {sourceFilters && (
        <Drawer
          opened={filterDrawerOpen}
          onClose={() => setFilterDrawerOpen(false)}
          title={t("source.drawerTitle", { name: plugin.name })}
          position="right"
          size="md"
        >
          <Stack gap="md">
            <PluginFilters
              schema={sourceFilters}
              values={pendingFilters}
              onChange={setPendingFilters}
            />
            <Group justify="space-between">
              <TextButton
                variant="subtle"
                onClick={() => {
                  setPendingFilters(emptySourceFilterValues(sourceFilters));
                }}
              >
                {t("common.reset")}
              </TextButton>
              <Group gap="xs">
                <TextButton
                  variant="default"
                  onClick={() => setFilterDrawerOpen(false)}
                >
                  {t("common.cancel")}
                </TextButton>
                <TextButton
                  onClick={() => {
                    setFilterMode("filters");
                    setActiveFilters(pendingFilters);
                    writeSourceFilters(plugin, pendingFilters);
                    setFilterDrawerOpen(false);
                  }}
                >
                  {t("common.apply")}
                </TextButton>
              </Group>
            </Group>
          </Stack>
        </Drawer>
      )}
      {hasPluginSettings ? (
        <Drawer
          opened={settingsDrawerOpen}
          onClose={() => setSettingsDrawerOpen(false)}
          title={t("pluginSettings.title", { name: plugin.name })}
          position="right"
          size="md"
        >
          <PluginSettingsEditor
            key={plugin.id}
            plugin={plugin}
            onSaved={() => {
              setSettingsDrawerOpen(false);
              void listing.refetch();
            }}
          />
        </Drawer>
      ) : null}
      <Drawer
        classNames={{
          body: "lnr-reader-settings-drawer-body",
          content: "lnr-reader-settings-drawer-content",
        }}
        opened={readerSettingsDrawerOpen}
        onClose={() => setReaderSettingsDrawerOpen(false)}
        title={t("readerSettings.source.title", { name: plugin.name })}
        position="right"
        size="lg"
      >
        <ReaderSettingsPanel
          target={{
            kind: "source",
            sourceId: plugin.id,
            label: plugin.name,
          }}
        />
      </Drawer>
    </PageFrame>
  );
}
