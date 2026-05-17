import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Group,
  Loader,
  Stack,
  Text,
} from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ConsoleChip,
  ConsoleCover,
  ConsoleSectionHeader,
  ConsoleStatusDot,
  ConsoleStatusStrip,
} from "../components/ConsolePrimitives";
import {
  ChevronDownGlyph,
  ChevronUpGlyph,
  DetailsGlyph,
  ExternalLinkGlyph,
  PinGlyph,
  RefreshGlyph,
  RetryGlyph,
  UnpinGlyph,
} from "../components/ActionGlyphs";
import { IconButton } from "../components/IconButton";
import { SearchBar } from "../components/SearchBar";
import { SegmentedToggle } from "../components/SegmentedToggle";
import { TextButton } from "../components/TextButton";
import { useTranslation } from "../i18n";
import {
  globalSearch,
  type GlobalSearchResult,
} from "../lib/plugins/global-search";
import { getPluginBaseUrl } from "../lib/plugins/base-url";
import { enqueueOpenNovelFromSourceTask } from "../lib/plugins/open-novel-task";
import { pluginManager } from "../lib/plugins/manager";
import type { NovelItem, Plugin } from "../lib/plugins/types";
import { enqueueOpenSiteTask } from "../lib/tasks/source-tasks";
import { useBrowseStore } from "../store/browse";
import "../styles/browse.css";

const PREVIEW_RESULT_COUNT = 20;
const activeSearchControllers = new Map<string, Set<AbortController>>();
const activeSearchControllerPluginIds = new Map<AbortController, Set<string>>();
const activeSearchPluginIds = new Map<string, Set<string>>();

type ScopeMode = "all" | "pinned" | "selected";
type ResultSortMode = "pinned" | "count" | "source";

interface ResultViewRow {
  pending: boolean;
  plugin: Plugin;
  result: GlobalSearchResult | null;
}

function resultKey(pluginId: string, novelPath: string): string {
  return `${pluginId}::${novelPath}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCloudflareError(message: string): boolean {
  return /cloudflare|challenge|captcha|403|forbidden/i.test(message);
}

function sortPluginsByName(plugins: readonly Plugin[]): Plugin[] {
  return [...plugins].sort((a, b) => a.name.localeCompare(b.name));
}

function pluginInitial(plugin: Plugin): string {
  return (plugin.name.trim()[0] ?? "?").toUpperCase();
}

function rowResultCount(row: ResultViewRow): number {
  return row.result?.novels.length ?? 0;
}

function hasSameStringItems(
  current: readonly string[],
  next: readonly string[],
): boolean {
  if (current.length !== next.length) return false;
  const nextItems = new Set(next);
  return current.every((item) => nextItems.has(item));
}

function getActivePluginIds(searchKey: string): string[] {
  return [...(activeSearchPluginIds.get(searchKey) ?? new Set<string>())];
}

function registerActiveSearch(
  searchKey: string,
  controller: AbortController,
  pluginIds: readonly string[],
): void {
  const controllers =
    activeSearchControllers.get(searchKey) ?? new Set<AbortController>();
  controllers.add(controller);
  activeSearchControllers.set(searchKey, controllers);
  activeSearchControllerPluginIds.set(controller, new Set(pluginIds));

  const activeIds =
    activeSearchPluginIds.get(searchKey) ?? new Set<string>();
  for (const pluginId of pluginIds) {
    activeIds.add(pluginId);
  }
  activeSearchPluginIds.set(searchKey, activeIds);
}

function completeActiveSearchPlugin(
  searchKey: string,
  controller: AbortController,
  pluginId: string,
): string[] {
  activeSearchControllerPluginIds.get(controller)?.delete(pluginId);
  const activeIds = activeSearchPluginIds.get(searchKey);
  if (!activeIds) return [];
  activeIds.delete(pluginId);
  if (activeIds.size === 0) {
    activeSearchPluginIds.delete(searchKey);
    return [];
  }
  return [...activeIds];
}

function completeActiveSearch(
  searchKey: string,
  controller: AbortController,
): string[] {
  const controllers = activeSearchControllers.get(searchKey);
  controllers?.delete(controller);
  if (controllers?.size === 0) {
    activeSearchControllers.delete(searchKey);
  }

  const activeIds = activeSearchPluginIds.get(searchKey);
  const pluginIds = activeSearchControllerPluginIds.get(controller) ?? new Set();
  activeSearchControllerPluginIds.delete(controller);
  if (!activeIds) return [];
  for (const pluginId of pluginIds) {
    activeIds.delete(pluginId);
  }
  if (activeIds.size === 0) {
    activeSearchPluginIds.delete(searchKey);
    return [];
  }
  return [...activeIds];
}

function abortSearchesExcept(searchKey: string): void {
  for (const [activeKey, controllers] of activeSearchControllers) {
    if (activeKey === searchKey) continue;
    for (const controller of controllers) {
      controller.abort();
      activeSearchControllerPluginIds.delete(controller);
    }
    activeSearchControllers.delete(activeKey);
    activeSearchPluginIds.delete(activeKey);
  }
}

interface ScopePanelProps {
  installedPlugins: readonly Plugin[];
  lastUsedPlugin: Plugin | null;
  pinnedPluginIds: readonly string[];
  scopeMode: ScopeMode;
  scopedCount: number;
  selectedPluginIds: readonly string[];
  onClearSelected: () => void;
  onOpenSite: (plugin: Plugin) => void;
  onOpenSource: (plugin: Plugin) => void;
  onScopeModeChange: (mode: ScopeMode) => void;
  onTogglePinnedPlugin: (pluginId: string) => void;
  onToggleSelectedPlugin: (pluginId: string) => void;
}

function ScopePanel({
  installedPlugins,
  lastUsedPlugin,
  pinnedPluginIds,
  scopeMode,
  scopedCount,
  selectedPluginIds,
  onClearSelected,
  onOpenSite,
  onOpenSource,
  onScopeModeChange,
  onTogglePinnedPlugin,
  onToggleSelectedPlugin,
}: ScopePanelProps) {
  const { t } = useTranslation();
  const [sourceListOpen, setSourceListOpen] = useState(false);
  const pinnedPlugins = installedPlugins.filter((plugin) =>
    pinnedPluginIds.includes(plugin.id),
  );
  const visiblePinnedPlugins = pinnedPlugins.filter(
    (plugin) => plugin.id !== lastUsedPlugin?.id,
  );
  const unpinnedPlugins = installedPlugins.filter(
    (plugin) => !pinnedPluginIds.includes(plugin.id),
  );
  const renderSourceChip = (
    plugin: Plugin,
    options?: { onSelect?: () => void },
  ) => {
    const active = selectedPluginIds.includes(plugin.id);
    const pinned = pinnedPluginIds.includes(plugin.id);

    return (
      <div
        key={plugin.id}
        className="lnr-search-source-chip lnr-search-source-chip--with-actions"
        data-active={active}
        data-pinned={pinned ? "true" : "false"}
      >
        <button
          type="button"
          className="lnr-search-source-select"
          aria-pressed={active}
          onClick={
            options?.onSelect ?? (() => onToggleSelectedPlugin(plugin.id))
          }
        >
          <span className="lnr-search-source-icon">
            {pluginInitial(plugin)}
          </span>
          <span className="lnr-search-source-name">{plugin.name}</span>
        </button>
        <span className="lnr-search-source-actions">
          <IconButton
            active={pinned}
            label={`${pinned ? t("browse.unpin") : t("browse.pin")}: ${plugin.name}`}
            size="lg"
            variant={pinned ? "light" : "subtle"}
            aria-pressed={pinned}
            title={pinned ? t("browse.unpin") : t("browse.pin")}
            onClick={() => onTogglePinnedPlugin(plugin.id)}
          >
            {pinned ? <UnpinGlyph /> : <PinGlyph />}
          </IconButton>
          <IconButton
            label={`${t("common.source")}: ${plugin.name}`}
            size="lg"
            variant="subtle"
            title={t("common.source")}
            onClick={() => onOpenSource(plugin)}
          >
            <DetailsGlyph />
          </IconButton>
          <IconButton
            label={`${t("common.openSite")}: ${plugin.name}`}
            size="lg"
            variant="subtle"
            title={t("common.openSite")}
            onClick={() => onOpenSite(plugin)}
          >
            <ExternalLinkGlyph />
          </IconButton>
        </span>
      </div>
    );
  };

  return (
    <aside className="lnr-search-scope">
      <ConsoleSectionHeader
        eyebrow={t("globalSearch.scope.eyebrow")}
        title={t("globalSearch.scope.title")}
        count={`${scopedCount}/${installedPlugins.length}`}
      />

      <div className="lnr-search-scope-mode-row">
        <SegmentedToggle
          value={scopeMode}
          onChange={(value) => onScopeModeChange(value as ScopeMode)}
          data={[
            {
              value: "all",
              label: t("globalSearch.scope.all", {
                count: installedPlugins.length,
              }),
            },
            {
              value: "pinned",
              label: t("globalSearch.scope.pinned", {
                count: pinnedPlugins.length,
              }),
            },
            {
              value: "selected",
              label: t("globalSearch.scope.selected", {
                count: selectedPluginIds.length,
              }),
            },
          ]}
          fullWidth
          className="lnr-search-scope-mode"
        />
        <IconButton
          label={t("globalSearch.clearSelected")}
          disabled={selectedPluginIds.length === 0}
          size="lg"
          variant="subtle"
          onClick={onClearSelected}
        >
          <RefreshGlyph />
        </IconButton>
      </div>

      {lastUsedPlugin ? (
        <div className="lnr-search-scope-block">
          <Text className="lnr-console-kicker">{t("globalSearch.recentlyUsed")}</Text>
          {renderSourceChip(lastUsedPlugin, {
            onSelect: () => {
              if (!selectedPluginIds.includes(lastUsedPlugin.id)) {
                onToggleSelectedPlugin(lastUsedPlugin.id);
              }
              onScopeModeChange("selected");
            },
          })}
        </div>
      ) : null}

      {visiblePinnedPlugins.length > 0 ? (
        <div className="lnr-search-scope-block lnr-search-pinned-source-block">
          <div className="lnr-search-pinned-source-list">
            {visiblePinnedPlugins.map((plugin) => renderSourceChip(plugin))}
          </div>
        </div>
      ) : null}

      <div className="lnr-search-scope-block lnr-search-scope-source-block">
        <div className="lnr-search-source-heading">
          <span className="lnr-search-source-heading-actions">
            <IconButton
              size="lg"
              variant="subtle"
              className="lnr-search-source-toggle"
              aria-expanded={sourceListOpen}
              label={
                sourceListOpen
                  ? t("globalSearch.hideSources")
                  : t("globalSearch.showSources")
              }
              aria-controls="lnr-search-source-list"
              title={
                sourceListOpen
                  ? t("globalSearch.hideSources")
                  : t("globalSearch.showSources")
              }
              onClick={() => setSourceListOpen((open) => !open)}
            >
              {sourceListOpen ? <ChevronUpGlyph /> : <ChevronDownGlyph />}
            </IconButton>
          </span>
        </div>
        <div
          id="lnr-search-source-list"
          className="lnr-search-source-list"
          data-open={sourceListOpen ? "true" : "false"}
        >
          {unpinnedPlugins.map((plugin) => renderSourceChip(plugin))}
        </div>
      </div>

    </aside>
  );
}

interface ActiveScopeRowProps {
  scopeMode: ScopeMode;
  scopedCount: number;
  selectedCount: number;
}

function ActiveScopeRow({
  scopeMode,
  scopedCount,
  selectedCount,
}: ActiveScopeRowProps) {
  const { t } = useTranslation();
  const scopeLabel =
    scopeMode === "all"
      ? t("common.all")
      : scopeMode === "pinned"
        ? t("common.pinned")
        : t("common.selected");

  return (
    <Group className="lnr-search-active-row" gap={6} wrap="wrap">
      <Text className="lnr-console-kicker">{t("globalSearch.active")}</Text>
      <ConsoleChip active>{scopeLabel}</ConsoleChip>
      <ConsoleChip active>
        {t("globalSearch.sourcesCount", { count: scopedCount })}
      </ConsoleChip>
      {scopeMode === "selected" ? (
        <ConsoleChip active>
          {t("globalSearch.selectedCount", { count: selectedCount })}
        </ConsoleChip>
      ) : null}
    </Group>
  );
}

interface ResultFiltersProps {
  failedCount: number;
  hideEmpty: boolean;
  onHideEmptyChange: (hideEmpty: boolean) => void;
  onRetryFailed: () => void;
  onShowFailuresChange: (showFailures: boolean) => void;
  onSortModeChange: (sortMode: ResultSortMode) => void;
  showFailures: boolean;
  sortMode: ResultSortMode;
}

function ResultFilters({
  failedCount,
  hideEmpty,
  onHideEmptyChange,
  onRetryFailed,
  onShowFailuresChange,
  onSortModeChange,
  showFailures,
  sortMode,
}: ResultFiltersProps) {
  const { t } = useTranslation();

  return (
    <Group className="lnr-search-result-filters" gap={6} wrap="wrap">
      <TextButton
        aria-pressed={hideEmpty}
        active={hideEmpty}
        size="lg"
        variant={hideEmpty ? "light" : "default"}
        onClick={() => onHideEmptyChange(!hideEmpty)}
      >
        {t("globalSearch.hideEmpty")}
      </TextButton>
      <TextButton
        aria-pressed={showFailures}
        active={showFailures}
        size="lg"
        tone="danger"
        variant={showFailures ? "light" : "default"}
        onClick={() => onShowFailuresChange(!showFailures)}
      >
        {t("globalSearch.failuresCount", { count: failedCount })}
      </TextButton>
      <SegmentedToggle
        value={sortMode}
        onChange={(value) => onSortModeChange(value as ResultSortMode)}
        data={[
          { value: "pinned", label: t("common.pinned") },
          { value: "count", label: t("globalSearch.sort.count") },
          { value: "source", label: t("common.source") },
        ]}
        className="lnr-search-sort"
      />
      {failedCount > 0 ? (
        <TextButton
          size="lg"
          tone="danger"
          variant="subtle"
          onClick={onRetryFailed}
        >
          {t("globalSearch.retryFailed")}
        </TextButton>
      ) : null}
    </Group>
  );
}

interface SearchSummaryProps {
  emptyCount: number;
  failedCount: number;
  pendingCount: number;
  query: string;
  searchedCount: number;
  totalPluginCount: number;
  withResultsCount: number;
}

function SearchSummary({
  emptyCount,
  failedCount,
  pendingCount,
  query,
  searchedCount,
  totalPluginCount,
  withResultsCount,
}: SearchSummaryProps) {
  const { t } = useTranslation();

  return (
    <ConsoleStatusStrip className="lnr-search-summary">
      <span className="lnr-search-summary-query">"{query}"</span>
      <span>
        {t("globalSearch.summary.searched", {
          searched: searchedCount,
          total: totalPluginCount,
        })}
      </span>
      <span>
        {t("globalSearch.summary.withResults", { count: withResultsCount })}
      </span>
      <span>{t("globalSearch.summary.empty", { count: emptyCount })}</span>
      <span data-tone={failedCount > 0 ? "error" : undefined}>
        {t("globalSearch.summary.failed", { count: failedCount })}
      </span>
      {pendingCount > 0 ? (
        <span>{t("globalSearch.summary.pending", { count: pendingCount })}</span>
      ) : null}
    </ConsoleStatusStrip>
  );
}

interface SearchResultSectionProps {
  openingKey: string | null;
  pinned: boolean;
  row: ResultViewRow;
  onMore: (row: GlobalSearchResult) => void;
  onOpen: (row: GlobalSearchResult, novel: NovelItem) => void;
  onOpenWebView: (plugin: Plugin) => void;
  onRetry: () => void;
}

function SearchResultSection({
  openingKey,
  pinned,
  row,
  onMore,
  onOpen,
  onOpenWebView,
  onRetry,
}: SearchResultSectionProps) {
  const { t } = useTranslation();
  const { plugin, result } = row;
  const previewNovels = result?.novels.slice(0, PREVIEW_RESULT_COUNT) ?? [];
  const error = result?.error;
  const cloudflare = error ? isCloudflareError(error) : false;
  const status: "active" | "done" | "idle" | "warning" | "error" = row.pending
    ? "active"
    : error
      ? cloudflare
        ? "warning"
        : "error"
      : previewNovels.length > 0
        ? "done"
        : "idle";
  const statusLabel = row.pending
    ? t("common.searching")
    : error
      ? cloudflare
        ? t("globalSearch.status.webviewNeeded")
        : t("common.failed")
      : t("globalSearch.status.results", {
          count: result?.novels.length ?? 0,
        });

  return (
    <section className="lnr-search-result-row">
      <Group className="lnr-search-result-head" gap="sm" wrap="nowrap">
        <span className="lnr-search-source-icon">{pluginInitial(plugin)}</span>
        <Box className="lnr-search-result-title">
          <Group gap={6} wrap="nowrap">
            <Text size="sm" fw={700} truncate>
              {plugin.name}
            </Text>
            {pinned ? (
              <span
                className="lnr-icon-state"
                data-active="true"
                role="img"
                aria-label={t("common.pinned")}
                title={t("common.pinned")}
              >
                <UnpinGlyph />
              </span>
            ) : null}
            <ConsoleChip>{plugin.lang.toUpperCase()}</ConsoleChip>
          </Group>
          <Text size="xs" c="dimmed" truncate>
            {getPluginBaseUrl(plugin)}
          </Text>
        </Box>
        <ConsoleStatusDot status={status} label={statusLabel} />
        <Group className="lnr-search-result-actions" gap={6} wrap="nowrap">
          {error ? (
            <>
              <IconButton
                label={t("common.retry")}
                size="lg"
                variant="subtle"
                onClick={onRetry}
              >
                <RetryGlyph />
              </IconButton>
              <IconButton
                label={t("common.openWebView")}
                size="lg"
                variant="light"
                onClick={() => onOpenWebView(plugin)}
              >
                <ExternalLinkGlyph />
              </IconButton>
            </>
          ) : result && result.novels.length > 0 ? (
            <IconButton
              label={t("globalSearch.openSourceResults")}
              size="lg"
              variant="light"
              onClick={() => onMore(result)}
            >
              <DetailsGlyph />
            </IconButton>
          ) : null}
        </Group>
      </Group>

      {error ? (
        <Alert
          color={cloudflare ? "yellow" : "red"}
          variant="light"
          className="lnr-search-diagnostic"
        >
          {error}
        </Alert>
      ) : previewNovels.length > 0 && result ? (
        <div className="lnr-search-preview-strip">
          {previewNovels.map((novel, index) => {
            const key = resultKey(result.pluginId, novel.path);
            return (
              <button
                key={`${key}::${index}`}
                type="button"
                className="lnr-search-preview-card"
                data-selected={openingKey === key}
                onClick={() => onOpen(result, novel)}
              >
                <ConsoleCover
                  alt={novel.name}
                  src={novel.cover ?? null}
                  width={74}
                  height={108}
                />
                <span title={novel.name}>{novel.name}</span>
              </button>
            );
          })}
        </div>
      ) : row.pending ? (
        <Group gap="sm" className="lnr-search-pending">
          <Loader size="xs" />
          <Text size="xs" c="dimmed">
            {t("globalSearch.waiting")}
          </Text>
        </Group>
      ) : (
        <Text className="lnr-search-empty-row" size="sm" c="dimmed">
          {t("globalSearch.noResultsFromSource")}
        </Text>
      )}
    </section>
  );
}

interface PluginSearchSectionProps {
  installedPlugins?: readonly Plugin[];
  query: string;
  onSearch: (query: string) => void;
}

export function PluginSearchSection({
  installedPlugins: installedPluginSnapshot,
  query,
  onSearch,
}: PluginSearchSectionProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const openSite = (plugin: Plugin) => {
    const url = getPluginBaseUrl(plugin);
    void enqueueOpenSiteTask(
      plugin,
      url,
      t("tasks.task.openSite", { source: plugin.name }),
    ).promise.catch(() => undefined);
  };
  const sourceWorkConcurrency = useBrowseStore(
    (s) => s.sourceWorkConcurrency,
  );
  const setLastUsedPluginId = useBrowseStore((s) => s.setLastUsedPluginId);
  const pinnedPluginIds = useBrowseStore((s) => s.pinnedPluginIds);
  const togglePinnedPlugin = useBrowseStore((s) => s.togglePinnedPlugin);
  const lastUsedPluginId = useBrowseStore((s) => s.lastUsedPluginId);
  const currentSearchKey = useBrowseStore((s) => s.globalSearch.searchKey);
  const globalSearchState = useBrowseStore((s) => s.globalSearch);
  const beginGlobalSearch = useBrowseStore((s) => s.beginGlobalSearch);
  const appendGlobalSearchResult = useBrowseStore(
    (s) => s.appendGlobalSearchResult,
  );
  const finishGlobalSearch = useBrowseStore((s) => s.finishGlobalSearch);
  const clearGlobalSearch = useBrowseStore((s) => s.clearGlobalSearch);
  const [suppressedRouteQuery, setSuppressedRouteQuery] = useState<
    string | null
  >(null);
  const routeQuery = query.trim();
  const restoreSuppressed =
    suppressedRouteQuery !== null &&
    (routeQuery === "" || routeQuery === suppressedRouteQuery);
  const restoredQuery = restoreSuppressed
    ? ""
    : routeQuery === ""
      ? globalSearchState.query
      : query;
  const [search, setSearch] = useState(restoredQuery);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [scopeMode, setScopeMode] = useState<ScopeMode>("all");
  const [selectedPluginIds, setSelectedPluginIds] = useState<string[]>([]);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [showFailures, setShowFailures] = useState(true);
  const [sortMode, setSortMode] = useState<ResultSortMode>("pinned");
  const [retryPluginIds, setRetryPluginIds] = useState<string[]>([]);
  const [activePluginIds, setActivePluginIds] = useState<string[]>([]);
  const trimmedQuery = restoredQuery.trim();
  const installedPlugins = useMemo(
    () => sortPluginsByName(installedPluginSnapshot ?? pluginManager.list()),
    [installedPluginSnapshot],
  );
  const scopedPlugins = useMemo(() => {
    if (scopeMode === "pinned") {
      return installedPlugins.filter((plugin) =>
        pinnedPluginIds.includes(plugin.id),
      );
    }
    if (scopeMode === "selected") {
      return installedPlugins.filter((plugin) =>
        selectedPluginIds.includes(plugin.id),
      );
    }
    return installedPlugins;
  }, [installedPlugins, pinnedPluginIds, scopeMode, selectedPluginIds]);
  const lastUsedPlugin =
    installedPlugins.find((plugin) => plugin.id === lastUsedPluginId) ?? null;
  const searchKey = trimmedQuery;
  const isCurrentSearch =
    trimmedQuery !== "" && globalSearchState.searchKey === searchKey;
  const results = isCurrentSearch ? globalSearchState.results : [];
  const activePluginIdSet = useMemo(
    () => new Set(isCurrentSearch ? activePluginIds : []),
    [activePluginIds, isCurrentSearch],
  );
  const retryPluginIdSet = useMemo(
    () => new Set(isCurrentSearch ? retryPluginIds : []),
    [isCurrentSearch, retryPluginIds],
  );
  const resultMap = useMemo(
    () => new Map(results.map((row) => [row.pluginId, row])),
    [results],
  );
  const searching =
    isCurrentSearch &&
    scopedPlugins.some(
      (plugin) =>
        activePluginIdSet.has(plugin.id) && !resultMap.has(plugin.id),
    );
  const resultPluginIds = useMemo(
    () =>
      new Set(
        results
          .filter((row) => !retryPluginIdSet.has(row.pluginId))
          .map((row) => row.pluginId),
      ),
    [results, retryPluginIdSet],
  );
  const rows = useMemo<ResultViewRow[]>(
    () =>
      trimmedQuery === ""
        ? []
        : scopedPlugins.map((plugin) => {
            const result = resultMap.get(plugin.id) ?? null;
            return {
              plugin,
              result,
              pending: !result && activePluginIdSet.has(plugin.id),
            };
          }),
    [activePluginIdSet, resultMap, scopedPlugins, trimmedQuery],
  );
  const filteredRows = useMemo(() => {
    const next = rows.filter((row) => {
      if (row.pending) return true;
      if (!row.result) return false;
      if (row.result.error) return showFailures;
      if (row.result.novels.length === 0) return !hideEmpty;
      return true;
    });

    return next.sort((a, b) => {
      if (sortMode === "count") {
        return rowResultCount(b) - rowResultCount(a);
      }
      if (sortMode === "source") {
        return a.plugin.name.localeCompare(b.plugin.name);
      }
      const aPinned = pinnedPluginIds.includes(a.plugin.id) ? 1 : 0;
      const bPinned = pinnedPluginIds.includes(b.plugin.id) ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      return rowResultCount(b) - rowResultCount(a);
    });
  }, [hideEmpty, pinnedPluginIds, rows, showFailures, sortMode]);
  const installedCount = installedPlugins.length;
  const hasSearchTerm = trimmedQuery !== "";
  const scopedPluginIdSet = useMemo(
    () => new Set(scopedPlugins.map((plugin) => plugin.id)),
    [scopedPlugins],
  );
  const scopedResults = useMemo(
    () => results.filter((row) => scopedPluginIdSet.has(row.pluginId)),
    [results, scopedPluginIdSet],
  );
  const failedPluginIds = useMemo(
    () => scopedResults.filter((row) => row.error).map((row) => row.pluginId),
    [scopedResults],
  );
  const searchedCount = scopedResults.length;
  const failedCount = scopedResults.filter((row) => row.error).length;
  const withResultsCount = scopedResults.filter(
    (row) => row.novels.length > 0,
  ).length;
  const emptyCount = scopedResults.filter(
    (row) => !row.error && row.novels.length === 0,
  ).length;
  const pendingCount = scopedPlugins.filter(
    (plugin) =>
      activePluginIdSet.has(plugin.id) && !resultMap.has(plugin.id),
  ).length;
  const totalPluginCount = scopedPlugins.length;
  const hasOnlyEmptyResults =
    hasSearchTerm &&
    !searching &&
    scopedResults.length > 0 &&
    scopedResults.length === scopedPlugins.length &&
    scopedResults.every((row) => row.novels.length === 0 && !row.error);
  const pluginsToSearch = useMemo(
    () =>
      hasSearchTerm
        ? scopedPlugins.filter(
            (plugin) =>
              !resultPluginIds.has(plugin.id) &&
              !activePluginIdSet.has(plugin.id),
          )
        : [],
    [activePluginIdSet, hasSearchTerm, resultPluginIds, scopedPlugins],
  );

  useEffect(() => {
    setSearch(restoredQuery);
  }, [restoredQuery]);

  useEffect(() => {
    if (
      suppressedRouteQuery !== null &&
      routeQuery !== "" &&
      routeQuery !== suppressedRouteQuery
    ) {
      setSuppressedRouteQuery(null);
    }
  }, [routeQuery, suppressedRouteQuery]);

  useEffect(() => {
    const pluginIds = new Set(installedPlugins.map((plugin) => plugin.id));
    setSelectedPluginIds((current) =>
      current.filter((pluginId) => pluginIds.has(pluginId)),
    );
  }, [installedPlugins]);

  useEffect(() => {
    setOpenError(null);

    if (trimmedQuery === "") {
      abortSearchesExcept("");
      setActivePluginIds((current) => (current.length === 0 ? current : []));
      setRetryPluginIds((current) => (current.length === 0 ? current : []));
      clearGlobalSearch();
      return;
    }

    abortSearchesExcept(searchKey);
    setActivePluginIds((current) => {
      const next = getActivePluginIds(searchKey);
      return hasSameStringItems(current, next) ? current : next;
    });

    if (currentSearchKey !== searchKey) {
      beginGlobalSearch({
        query: trimmedQuery,
        searchKey,
        results: [],
        searching: pluginsToSearch.length > 0,
        totalPluginCount: scopedPlugins.length,
      });
    } else if (pluginsToSearch.length > 0 && !globalSearchState.searching) {
      beginGlobalSearch({
        ...globalSearchState,
        searching: true,
        totalPluginCount: Math.max(
          globalSearchState.totalPluginCount,
          scopedPlugins.length,
        ),
      });
    }

    const activeIdsNow = new Set(getActivePluginIds(searchKey));
    const resultIdsNow = new Set(
      (currentSearchKey === searchKey ? globalSearchState.results : [])
        .filter((row) => !retryPluginIdSet.has(row.pluginId))
        .map((row) => row.pluginId),
    );
    const pluginsToStart = pluginsToSearch.filter(
      (plugin) =>
        !activeIdsNow.has(plugin.id) && !resultIdsNow.has(plugin.id),
    );
    if (pluginsToStart.length === 0) return;

    const controller = new AbortController();
    const pluginIds = pluginsToStart.map((plugin) => plugin.id);
    registerActiveSearch(searchKey, controller, pluginIds);
    setActivePluginIds((current) => {
      const next = getActivePluginIds(searchKey);
      return hasSameStringItems(current, next) ? current : next;
    });
    setRetryPluginIds((current) => {
      const next = current.filter((pluginId) => !pluginIds.includes(pluginId));
      return hasSameStringItems(current, next) ? current : next;
    });

    globalSearch(pluginManager, trimmedQuery, {
      concurrency: sourceWorkConcurrency,
      plugins: pluginsToStart,
      signal: controller.signal,
      taskTitle: (plugin) =>
        t("tasks.task.globalSearch", {
          query: trimmedQuery,
          source: plugin.name,
        }),
      onResult: (result) => {
        if (controller.signal.aborted) return;
        appendGlobalSearchResult(searchKey, result);
        const remainingPluginIds = completeActiveSearchPlugin(
          searchKey,
          controller,
          result.pluginId,
        );
        setActivePluginIds((current) =>
          hasSameStringItems(current, remainingPluginIds)
            ? current
            : remainingPluginIds,
        );
        if (remainingPluginIds.length === 0) {
          finishGlobalSearch(searchKey);
        }
      },
    })
      .catch(() => {
        // Per-plugin errors fold into GlobalSearchResult rows.
      })
      .finally(() => {
        const remainingPluginIds = completeActiveSearch(
          searchKey,
          controller,
        );
        setActivePluginIds((current) =>
          hasSameStringItems(current, remainingPluginIds)
            ? current
            : remainingPluginIds,
        );
        if (!controller.signal.aborted && remainingPluginIds.length === 0) {
          finishGlobalSearch(searchKey);
        }
      });
  }, [
    appendGlobalSearchResult,
    beginGlobalSearch,
    clearGlobalSearch,
    currentSearchKey,
    finishGlobalSearch,
    sourceWorkConcurrency,
    globalSearchState,
    pluginsToSearch,
    retryPluginIdSet,
    scopedPlugins.length,
    searchKey,
    trimmedQuery,
  ]);

  const handleOpenNovel = useCallback(
    async (row: GlobalSearchResult, novel: NovelItem) => {
      if (openingKey !== null) return;

      const plugin = pluginManager.getPlugin(row.pluginId);
      if (!plugin) {
        setOpenError(t("globalSearch.pluginMissing", { name: row.pluginName }));
        return;
      }

      const key = resultKey(row.pluginId, novel.path);
      setLastUsedPluginId(row.pluginId);
      setOpeningKey(key);
      setOpenError(null);
      try {
        const id = await enqueueOpenNovelFromSourceTask({
          plugin,
          item: novel,
          title: t("tasks.task.openNovel", { name: novel.name }),
        }).promise;
        await queryClient.invalidateQueries({ queryKey: ["novel"] });
        await navigate({ to: "/novel", search: { id } });
      } catch (error) {
        setOpenError(
          t("globalSearch.openNovelFailed", {
            name: novel.name,
            error: describeError(error),
          }),
        );
      } finally {
        setOpeningKey((current) => (current === key ? null : current));
      }
    },
    [navigate, openingKey, queryClient, setLastUsedPluginId, t],
  );

  const submitSearch = () => {
    const nextQuery = search.trim();
    if (nextQuery === "") {
      setSuppressedRouteQuery(routeQuery || globalSearchState.query || null);
      clearGlobalSearch();
    } else {
      setSuppressedRouteQuery(null);
    }
    onSearch(nextQuery);
  };

  const openPluginResults = useCallback(
    (row: GlobalSearchResult) => {
      setLastUsedPluginId(row.pluginId);
      void navigate({
        to: "/source",
        search: {
          from: "browse-search",
          pluginId: row.pluginId,
          query: trimmedQuery,
        },
      });
    },
    [navigate, setLastUsedPluginId, trimmedQuery],
  );

  const retryFailed = useCallback(() => {
    setRetryPluginIds((current) =>
      hasSameStringItems(current, failedPluginIds) ? current : failedPluginIds,
    );
  }, [failedPluginIds]);

  const toggleSelectedPlugin = useCallback((pluginId: string) => {
    setSelectedPluginIds((current) =>
      current.includes(pluginId)
        ? current.filter((id) => id !== pluginId)
        : [...current, pluginId],
    );
  }, []);

  return (
    <div className="lnr-search-console">
      <ScopePanel
        installedPlugins={installedPlugins}
        lastUsedPlugin={lastUsedPlugin}
        pinnedPluginIds={pinnedPluginIds}
        scopeMode={scopeMode}
        scopedCount={scopedPlugins.length}
        selectedPluginIds={selectedPluginIds}
        onClearSelected={() => setSelectedPluginIds([])}
        onOpenSite={openSite}
        onOpenSource={(plugin) => {
          setLastUsedPluginId(plugin.id);
          void navigate({
            to: "/source",
            search: {
              from: "browse-search",
              pluginId: plugin.id,
              query: trimmedQuery,
            },
          });
        }}
        onScopeModeChange={setScopeMode}
        onTogglePinnedPlugin={togglePinnedPlugin}
        onToggleSelectedPlugin={toggleSelectedPlugin}
      />

      <section className="lnr-search-results">
        <div className="lnr-search-result-heading">
          <ConsoleSectionHeader
            title={t("globalSearch.searchInstalledSources")}
            count={t("globalSearch.eligibleCount", { count: installedCount })}
          />
        </div>

        <SearchBar
          value={search}
          onChange={setSearch}
          onSubmit={submitSearch}
          placeholder={t("globalSearch.placeholder")}
        />

        <ActiveScopeRow
          scopeMode={scopeMode}
          scopedCount={scopedPlugins.length}
          selectedCount={selectedPluginIds.length}
        />

        {installedCount === 0 ? (
          <Alert color="blue" title={t("globalSearch.noPlugins.title")}>
            {t("globalSearch.noPlugins.message")}
          </Alert>
        ) : null}

        {hasSearchTerm && scopedPlugins.length === 0 ? (
          <Alert color="yellow" title={t("globalSearch.noSources.title")}>
            {t("globalSearch.noSources.message")}
          </Alert>
        ) : null}

        {hasSearchTerm ? (
          <>
            <SearchSummary
              emptyCount={emptyCount}
              failedCount={failedCount}
              pendingCount={pendingCount}
              query={trimmedQuery}
              searchedCount={searchedCount}
              totalPluginCount={totalPluginCount}
              withResultsCount={withResultsCount}
            />
            <ResultFilters
              failedCount={failedCount}
              hideEmpty={hideEmpty}
              onHideEmptyChange={setHideEmpty}
              onRetryFailed={retryFailed}
              onShowFailuresChange={setShowFailures}
              onSortModeChange={setSortMode}
              showFailures={showFailures}
              sortMode={sortMode}
            />
          </>
        ) : null}

        {openingKey !== null ? (
          <Group gap="sm" className="lnr-search-inline-state">
            <Loader size="sm" />
            <Text c="dimmed">{t("globalSearch.openingNovel")}</Text>
          </Group>
        ) : null}

        {openError ? (
          <Alert color="red" variant="light" title={t("common.openFailed")}>
            {openError}
          </Alert>
        ) : null}

        {!searching && hasOnlyEmptyResults ? (
          <Alert color="yellow" title={t("common.noMatches")}>
            {t("globalSearch.noMatches.message", { query })}
          </Alert>
        ) : null}

        <Stack gap="xs">
          {filteredRows.map((row) => (
            <SearchResultSection
              key={row.plugin.id}
              row={row}
              pinned={pinnedPluginIds.includes(row.plugin.id)}
              openingKey={openingKey}
              onOpen={(resultRow, novel) => {
                void handleOpenNovel(resultRow, novel);
              }}
              onMore={openPluginResults}
              onOpenWebView={openSite}
              onRetry={retryFailed}
            />
          ))}
        </Stack>
      </section>
    </div>
  );
}
