import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Collapse,
  Group,
  Loader,
  Stack,
  Text,
} from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { BlockingLoadingOverlay, StateView } from "../AppFrame";
import { ChipButton } from "../ChipButton";
import { IconButton } from "../IconButton";
import { SearchBar } from "../SearchBar";
import {
  SourceAccessNotice,
  SourceAccessVerifyButton,
  useSourceAccessBlocks,
} from "../SourceAccessVerifyButton";
import { SourceNovelCover } from "../SourceNovelCover";
import { QuickAddCard } from "./QuickAddCard";
import { useQuickAddToLibrary, type QuickAddTarget } from "./use-quick-add";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DeselectIcon,
  PinIcon,
  RetryIcon,
  SelectAllIcon,
  SourceIcon,
  SortIcon,
  UnpinIcon,
  VerifyIcon,
  WarningIcon,
} from "../ui/icons";
import { OverflowMenu, type OverflowMenuItem } from "../ui/OverflowMenu";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";
import { PluginIcon } from "./PluginIcon";
import { useTranslation } from "../../i18n";
import { registerPageBackNavigationHandler } from "../../lib/android-back-navigation";
import {
  globalSearch,
  type GlobalSearchResult,
} from "../../lib/plugins/global-search";
import { enqueueOpenNovelFromSourceTask } from "../../lib/plugins/open-novel-task";
import { pluginManager } from "../../lib/plugins/manager";
import type { NovelItem, Plugin } from "../../lib/plugins/types";
import {
  taskScheduler,
  type TaskHandle,
  type TaskScheduler,
} from "../../lib/tasks/scheduler";
import { openPluginSite } from "../../lib/plugins/open-plugin-site";
import { isAbortError } from "../../lib/abort";
import { describeError } from "../../lib/errors";
import { useLibraryNovelMembership } from "../../lib/use-library-novel-membership";
import { useBrowseStore, type GlobalSearchSort } from "../../store/browse";
import "../../styles/browse.css";

const PREVIEW_RESULT_COUNT = 20;
const activeSearchControllers = new Map<string, Set<AbortController>>();
const activeSearchControllerPluginIds = new Map<AbortController, Set<string>>();
const activeSearchPluginIds = new Map<string, Set<string>>();

interface SourceResult {
  plugin: Plugin;
  result: GlobalSearchResult;
}

function resultKey(pluginId: string, novelPath: string): string {
  return `${pluginId}::${novelPath}`;
}

/**
 * Whether a source error reads as a site access check. A bare HTTP 403 or
 * "Forbidden" is an ordinary failure: Retry, not Verify.
 */
export function isCloudflareError(message: string): boolean {
  return /\bcloudflare\b|\bcaptcha\b|\bchallenge\b|\bcf-chl|just a moment|attention required|verification (?:is )?required/i.test(
    message,
  );
}

/** Whether a source's search ended on an access check, so verifying it should search it again. */
export function isAccessFailure(result: GlobalSearchResult): boolean {
  return Boolean(result.error) && (result.accessRequired === true || isCloudflareError(result.error!));
}

/**
 * Retries the failed search of each listed source when the source-access
 * coordinator confirms access to that source, whichever surface verified it.
 */
export function retryOnSourceAccessConfirmed(
  scheduler: Pick<TaskScheduler, "subscribeSourceAccessConfirmed">,
  pluginIds: readonly string[],
  retry: (pluginId: string) => void,
): () => void {
  const failed = new Set(pluginIds);
  return scheduler.subscribeSourceAccessConfirmed(({ rangeId, sourceId }) => {
    if (rangeId === undefined && failed.has(sourceId)) retry(sourceId);
  });
}

function sortPluginsByName(plugins: readonly Plugin[]): Plugin[] {
  return [...plugins].sort((a, b) => a.name.localeCompare(b.name));
}

/** Pinned sources first, then by result count; or by source name. */
export function sortSourceResults(
  rows: readonly SourceResult[],
  sort: GlobalSearchSort,
  pinnedPluginIds: readonly string[],
): SourceResult[] {
  return [...rows].sort((a, b) => {
    if (sort === "name") return a.plugin.name.localeCompare(b.plugin.name);
    const pinned =
      Number(pinnedPluginIds.includes(b.plugin.id)) - Number(pinnedPluginIds.includes(a.plugin.id));
    return pinned || b.result.novels.length - a.result.novels.length;
  });
}

function hasSameStringItems(
  current: readonly string[],
  next: readonly string[],
): boolean {
  if (current.length !== next.length) return false;
  const nextItems = new Set(next);
  return current.every((item) => nextItems.has(item));
}

export function withRetryPluginId(
  current: string[],
  pluginId: string,
): string[] {
  return current.includes(pluginId) ? current : [...current, pluginId];
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

type ScopeMode = "all" | "pinned" | "selected";

interface SearchScopeChipsProps {
  installedPlugins: readonly Plugin[];
  pinnedCount: number;
  scopeMode: ScopeMode;
  selectedPluginIds: readonly string[];
  onScopeModeChange: (mode: ScopeMode) => void;
  onSelectedPluginIdsChange: (pluginIds: string[]) => void;
}

function SearchScopeChips({
  installedPlugins,
  pinnedCount,
  scopeMode,
  selectedPluginIds,
  onScopeModeChange,
  onSelectedPluginIdsChange,
}: SearchScopeChipsProps) {
  const { t } = useTranslation();
  const [sheetOpen, setSheetOpen] = useState(false);
  const chip = (mode: ScopeMode, label: string, onClick: () => void) => (
    <ChipButton
      aria-haspopup={mode === "selected" ? "dialog" : undefined}
      onClick={onClick}
      selected={scopeMode === mode}
      trailingIcon={mode === "selected" ? <ChevronRightIcon /> : undefined}
    >
      {label}
    </ChipButton>
  );

  return (
    <>
      <div aria-label={t("globalSearch.scope.label")} className="norea-browse-chips" role="group">
        {chip("all", t("globalSearch.scope.all", { count: installedPlugins.length }), () =>
          onScopeModeChange("all"),
        )}
        {chip("pinned", t("globalSearch.scope.pinned", { count: pinnedCount }), () =>
          onScopeModeChange("pinned"),
        )}
        {chip(
          "selected",
          scopeMode === "selected"
            ? t("globalSearch.scope.custom", { count: selectedPluginIds.length })
            : t("globalSearch.scope.customEdit"),
          () => {
            onScopeModeChange("selected");
            setSheetOpen(true);
          },
        )}
      </div>
      <ResponsiveSheet
        footer={
          <Button fullWidth onClick={() => setSheetOpen(false)}>
            {t("common.done")}
          </Button>
        }
        onClose={() => setSheetOpen(false)}
        opened={sheetOpen}
        title={t("globalSearch.scope.sheetTitle")}
      >
        <div className="norea-search-scope-sheet">
          <Group gap="xs">
            <IconButton
              label={t("globalSearch.scope.selectAll")}
              onClick={() => onSelectedPluginIdsChange(installedPlugins.map((plugin) => plugin.id))}
              size="lg"
            >
              <SelectAllIcon />
            </IconButton>
            <IconButton
              disabled={selectedPluginIds.length === 0}
              label={t("globalSearch.scope.clear")}
              onClick={() => onSelectedPluginIdsChange([])}
              size="lg"
            >
              <DeselectIcon />
            </IconButton>
          </Group>
          <Checkbox.Group
            label={t("globalSearch.scope.sources")}
            onChange={onSelectedPluginIdsChange}
            value={[...selectedPluginIds]}
          >
            <Stack className="norea-search-scope-options" gap={0}>
              {installedPlugins.map((plugin) => (
                <Checkbox key={plugin.id} label={plugin.name} value={plugin.id} />
              ))}
            </Stack>
          </Checkbox.Group>
        </div>
      </ResponsiveSheet>
    </>
  );
}

interface SearchResultSectionProps {
  isInLibrary: (pluginId: string, path: string) => boolean;
  isQuickAddPending: (target: QuickAddTarget) => boolean;
  openingKey: string | null;
  pinned: boolean;
  plugin: Plugin;
  result: GlobalSearchResult;
  onMore: (row: GlobalSearchResult) => void;
  onOpen: (row: GlobalSearchResult, novel: NovelItem) => void;
  onQuickAdd: (target: QuickAddTarget) => void;
  onOpenSite: (plugin: Plugin) => void;
  onOpenSource: (plugin: Plugin) => void;
  onTogglePinned: (pluginId: string) => void;
}

function SearchResultSection({
  isInLibrary,
  isQuickAddPending,
  openingKey,
  pinned,
  plugin,
  result,
  onMore,
  onOpen,
  onQuickAdd,
  onOpenSite,
  onOpenSource,
  onTogglePinned,
}: SearchResultSectionProps) {
  const { t } = useTranslation();
  const headingId = `norea-search-result-${plugin.id}`;

  return (
    <section aria-labelledby={headingId} className="norea-search-result-row">
      <div className="norea-search-result-head">
        <PluginIcon plugin={plugin} />
        <h3 className="norea-search-result-title" id={headingId}>
          <button
            aria-label={`${t("globalSearch.openSource")}: ${plugin.name}`}
            className="norea-search-result-source norea-state-layer"
            onClick={() => onOpenSource(plugin)}
            title={t("globalSearch.openSource")}
            type="button"
          >
            <span className="norea-search-result-name">{plugin.name}</span>
            <span className="norea-search-result-count">
              {t("globalSearch.status.results", { count: result.novels.length })}
            </span>
          </button>
        </h3>
        <div className="norea-browse-actions">
          <IconButton
            active={pinned}
            aria-pressed={pinned}
            label={`${pinned ? t("browse.unpin") : t("browse.pin")}: ${plugin.name}`}
            onClick={() => onTogglePinned(plugin.id)}
            size="lg"
          >
            {pinned ? <UnpinIcon /> : <PinIcon />}
          </IconButton>
          <IconButton label={`${t("common.openSite")}: ${plugin.name}`} onClick={() => onOpenSite(plugin)} size="lg">
            <SourceIcon />
          </IconButton>
          <IconButton
            label={t("globalSearch.openSourceResultsFor", { name: plugin.name })}
            onClick={() => onMore(result)}
            size="lg"
          >
            <ChevronRightIcon />
          </IconButton>
        </div>
      </div>
      <div className="norea-search-preview-strip">
        {result.novels.slice(0, PREVIEW_RESULT_COUNT).map((novel, index) => {
          const key = resultKey(result.pluginId, novel.path);
          const inLibrary = isInLibrary(result.pluginId, novel.path);
          const target: QuickAddTarget = { kind: "source", item: novel, plugin };
          return (
            <QuickAddCard
              key={`${key}::${index}`}
              className="norea-search-preview-card norea-state-layer"
              inLibrary={inLibrary}
              name={novel.name}
              onAdd={() => onQuickAdd(target)}
              onOpen={() => onOpen(result, novel)}
              pending={isQuickAddPending(target)}
              selected={openingKey === key}
            >
              <SourceNovelCover
                height={108}
                inLibrary={inLibrary}
                item={novel}
                plugin={plugin}
                width={74}
              />
              <span className="norea-search-preview-title" title={novel.name}>
                {novel.name}
              </span>
            </QuickAddCard>
          );
        })}
      </div>
    </section>
  );
}

function EmptySources({ plugins }: { plugins: readonly Plugin[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (plugins.length === 0) return null;

  return (
    <div className="norea-search-empty-sources">
      <Button
        aria-controls="norea-search-empty-source-list"
        aria-expanded={open}
        justify="flex-start"
        onClick={() => setOpen((current) => !current)}
        rightSection={open ? <ChevronDownIcon size="1rem" /> : <ChevronRightIcon size="1rem" />}
        size="compact-sm"
        variant="subtle"
      >
        {t("globalSearch.emptySources", { count: plugins.length })}
      </Button>
      <Collapse expanded={open} id="norea-search-empty-source-list" keepMountedMode="display-none">
        <ul>
          {plugins.map((plugin) => (
            <li key={plugin.id}>{plugin.name}</li>
          ))}
        </ul>
      </Collapse>
    </div>
  );
}

export interface FailedSearchSource {
  error: string;
  plugin: Plugin;
}

interface SearchFailuresProps {
  active: boolean;
  failures: readonly FailedSearchSource[];
  onOpenSite: (plugin: Plugin) => void;
  onRetry: (pluginId: string) => void;
  onRetryAll: () => void;
}

/**
 * Recovery for failed sources. One failure shows Retry and, for an access
 * check, Verify in place; more collapse into a chip that opens a sheet.
 */
export function SearchFailures({
  active,
  failures,
  onOpenSite,
  onRetry,
  onRetryAll,
}: SearchFailuresProps) {
  const { t } = useTranslation();
  const [sheetOpen, setSheetOpen] = useState(false);
  const blockFor = useSourceAccessBlocks(active);
  if (failures.length === 0) return null;

  const verifyAction = ({ error, plugin }: FailedSearchSource) => {
    const block = blockFor(plugin.id);
    if (block) {
      return (
        <SourceAccessVerifyButton
          block={block}
          iconOnly
          label={t("globalSearch.verifySource", { name: plugin.name })}
          sourceName={plugin.name}
        />
      );
    }
    if (!isCloudflareError(error)) return null;
    return (
      <IconButton
        label={t("globalSearch.verifySource", { name: plugin.name })}
        onClick={() => onOpenSite(plugin)}
        size="lg"
      >
        <VerifyIcon />
      </IconButton>
    );
  };
  const retryButton = (plugin: Plugin) => (
    <IconButton
      label={t("globalSearch.retrySource", { name: plugin.name })}
      onClick={() => onRetry(plugin.id)}
      size="lg"
    >
      <RetryIcon />
    </IconButton>
  );
  const reason = ({ error, plugin }: FailedSearchSource) =>
    blockFor(plugin.id) || isCloudflareError(error)
      ? t("updates.failure.verification")
      : t("updates.failure.error");
  const single = failures.length === 1 ? failures[0]! : null;

  return (
    <>
      {single ? (
        <section className="norea-search-failure-notice" role="status">
          <WarningIcon className="norea-search-failure-icon" size="1.25rem" />
          <div className="norea-search-failure-copy">
            <Text fw="var(--norea-weight-bold)" size="sm">
              {t("globalSearch.failure.oneSource", { name: single.plugin.name })}
            </Text>
            <Text c="dimmed" size="sm">
              {reason(single)}
            </Text>
            <details className="norea-state-details">
              <summary>{t("common.details")}</summary>
              <Text c="dimmed" component="div" size="xs">
                {single.error}
              </Text>
            </details>
          </div>
          <div className="norea-search-failure-actions">
            {retryButton(single.plugin)}
            {verifyAction(single)}
          </div>
        </section>
      ) : (
        <div className="norea-search-failure-chip-bar">
          <ChipButton
            aria-haspopup="dialog"
            onClick={() => setSheetOpen(true)}
            tone="danger"
            trailingIcon={<ChevronRightIcon />}
          >
            {t("globalSearch.failure.chip", { count: failures.length })}
          </ChipButton>
        </div>
      )}

      <ResponsiveSheet
        footer={
          <Button
            fullWidth
            onClick={() => {
              setSheetOpen(false);
              onRetryAll();
            }}
          >
            {t("updates.failure.retryAll")}
          </Button>
        }
        onClose={() => setSheetOpen(false)}
        opened={sheetOpen && failures.length > 1}
        title={t("updates.failure.sheetTitle")}
      >
        <div className="norea-search-failure-sources">
          {failures.map((failure) => (
            <section
              aria-labelledby={`norea-search-failed-${failure.plugin.id}`}
              className="norea-search-failure-source"
              key={failure.plugin.id}
            >
              <div className="norea-search-failure-source-header">
                <Text component="h3" fw="var(--norea-weight-bold)" id={`norea-search-failed-${failure.plugin.id}`} size="sm">
                  {failure.plugin.name}
                </Text>
                <Group gap="xs">
                  {retryButton(failure.plugin)}
                  {verifyAction(failure)}
                </Group>
              </div>
              <Text c="dimmed" size="sm">
                {reason(failure)}
              </Text>
              <details className="norea-state-details">
                <summary>{t("common.details")}</summary>
                <Text c="dimmed" component="div" size="xs">
                  {failure.error}
                </Text>
              </details>
            </section>
          ))}
        </div>
      </ResponsiveSheet>
    </>
  );
}

interface BrowseSearchTabProps {
  installedPlugins?: readonly Plugin[];
  query: string;
  onSearch: (query: string) => void;
}

export function BrowseSearchTab({
  installedPlugins: installedPluginSnapshot,
  query,
  onSearch,
}: BrowseSearchTabProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isInLibrary = useLibraryNovelMembership();
  const quickAdd = useQuickAddToLibrary();
  const openSite = (plugin: Plugin) =>
    openPluginSite(plugin, t("tasks.task.openSite", { source: plugin.name }));
  const setLastUsedPluginId = useBrowseStore((s) => s.setLastUsedPluginId);
  const pinnedPluginIds = useBrowseStore((s) => s.pinnedPluginIds);
  const togglePinnedPlugin = useBrowseStore((s) => s.togglePinnedPlugin);
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
  const [openingSource, setOpeningSource] = useState<Pick<Plugin, "id" | "name"> | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const openTaskRef = useRef<TaskHandle<number> | null>(null);
  const [scopeMode, setScopeMode] = useState<ScopeMode>("all");
  const [selectedPluginIds, setSelectedPluginIds] = useState<string[]>([]);
  const sort = useBrowseStore((s) => s.globalSearchSort);
  const setSort = useBrowseStore((s) => s.setGlobalSearchSort);
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
  const searchKey = JSON.stringify([
    trimmedQuery,
    scopedPlugins.map((plugin) => plugin.id).sort(),
  ]);
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
  const resultPluginIds = useMemo(
    () =>
      new Set(
        results
          .filter((row) => !retryPluginIdSet.has(row.pluginId))
          .map((row) => row.pluginId),
      ),
    [results, retryPluginIdSet],
  );
  const hasSearchTerm = trimmedQuery !== "";
  const pendingPlugins = hasSearchTerm
    ? scopedPlugins.filter(
        (plugin) => activePluginIdSet.has(plugin.id) || retryPluginIdSet.has(plugin.id),
      )
    : [];
  const pendingCount = pendingPlugins.length;
  const settledResults = useMemo<SourceResult[]>(
    () =>
      hasSearchTerm
        ? scopedPlugins.flatMap((plugin) => {
            const result = resultMap.get(plugin.id);
            return result &&
              !activePluginIdSet.has(plugin.id) &&
              !retryPluginIdSet.has(plugin.id)
              ? [{ plugin, result }]
              : [];
          })
        : [],
    [activePluginIdSet, hasSearchTerm, resultMap, retryPluginIdSet, scopedPlugins],
  );
  const sourcesWithResults = useMemo(
    () =>
      sortSourceResults(
        settledResults.filter(({ result }) => !result.error && result.novels.length > 0),
        sort,
        pinnedPluginIds,
      ),
    [pinnedPluginIds, settledResults, sort],
  );
  const emptySources = settledResults
    .filter(({ result }) => !result.error && result.novels.length === 0)
    .map(({ plugin }) => plugin);
  const failures = useMemo<FailedSearchSource[]>(
    () =>
      settledResults.flatMap(({ plugin, result }) =>
        result.error ? [{ error: result.error, plugin }] : [],
      ),
    [settledResults],
  );
  const failedPluginIds = useMemo(
    () => failures.map(({ plugin }) => plugin.id),
    [failures],
  );
  const accessFailedPluginIds = useMemo(
    () => settledResults.flatMap(({ plugin, result }) => (isAccessFailure(result) ? [plugin.id] : [])),
    [settledResults],
  );
  const hasOnlyEmptyResults =
    hasSearchTerm &&
    scopedPlugins.length > 0 &&
    pendingCount === 0 &&
    settledResults.length === scopedPlugins.length &&
    sourcesWithResults.length === 0 &&
    failures.length === 0;
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
        if (controller.signal.aborted) return;
        setActivePluginIds((current) =>
          hasSameStringItems(current, remainingPluginIds)
            ? current
            : remainingPluginIds,
        );
        if (remainingPluginIds.length === 0) {
          finishGlobalSearch(searchKey);
        }
      });
  }, [
    appendGlobalSearchResult,
    beginGlobalSearch,
    clearGlobalSearch,
    currentSearchKey,
    finishGlobalSearch,
    globalSearchState,
    pluginsToSearch,
    retryPluginIdSet,
    scopedPlugins.length,
    searchKey,
    trimmedQuery,
  ]);

  const cancelOpenNovel = useCallback((): boolean => {
    const task = openTaskRef.current;
    if (!task) return false;
    openTaskRef.current = null;
    taskScheduler.cancel(task.id);
    setOpeningKey(null);
    return true;
  }, []);

  useEffect(() => {
    if (openingKey === null) return;
    return registerPageBackNavigationHandler({ back: cancelOpenNovel });
  }, [cancelOpenNovel, openingKey]);

  useEffect(
    () => () => {
      const task = openTaskRef.current;
      openTaskRef.current = null;
      if (task) taskScheduler.cancel(task.id);
    },
    [],
  );

  const handleOpenNovel = useCallback(
    async (row: GlobalSearchResult, novel: NovelItem) => {
      if (openTaskRef.current) return;

      const plugin = pluginManager.getPlugin(row.pluginId);
      if (!plugin) {
        setOpenError(t("globalSearch.pluginMissing", { name: row.pluginName }));
        return;
      }

      const key = resultKey(row.pluginId, novel.path);
      setLastUsedPluginId(row.pluginId);
      setOpeningKey(key);
      setOpeningSource({ id: plugin.id, name: plugin.name });
      setOpenError(null);
      const task = enqueueOpenNovelFromSourceTask({
        plugin,
        item: novel,
        title: t("tasks.task.openNovel", { name: novel.name }),
      });
      openTaskRef.current = task;
      try {
        const id = await task.promise;
        if (openTaskRef.current?.id !== task.id) return;
        await queryClient.invalidateQueries({ queryKey: ["novel"] });
        if (openTaskRef.current?.id !== task.id) return;
        await navigate({ to: "/novel", search: { id } });
      } catch (error) {
        if (!isAbortError(error)) {
          setOpenError(
            t("globalSearch.openNovelFailed", {
              name: novel.name,
              error: describeError(error),
            }),
          );
        }
      } finally {
        if (openTaskRef.current?.id === task.id) {
          openTaskRef.current = null;
        }
        setOpeningKey((current) => (current === key ? null : current));
      }
    },
    [navigate, queryClient, setLastUsedPluginId, t],
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

  const retrySource = useCallback((pluginId: string) => {
    setRetryPluginIds((current) => withRetryPluginId(current, pluginId));
  }, []);

  useEffect(() => {
    if (accessFailedPluginIds.length === 0) return;
    return retryOnSourceAccessConfirmed(taskScheduler, accessFailedPluginIds, retrySource);
  }, [accessFailedPluginIds, retrySource]);

  const openSource = (plugin: Plugin) => {
    setLastUsedPluginId(plugin.id);
    void navigate({ to: "/source", search: { pluginId: plugin.id, query: "" } });
  };
  const sortItems: OverflowMenuItem[] = [
    {
      icon: sort === "pinned" ? CheckIcon : undefined,
      label: t("globalSearch.sort.pinned"),
      onClick: () => setSort("pinned"),
    },
    {
      icon: sort === "name" ? CheckIcon : undefined,
      label: t("globalSearch.sort.name"),
      onClick: () => setSort("name"),
    },
  ];

  return (
    <div className="norea-search-console">
      {openingKey !== null ? (
        <BlockingLoadingOverlay
          cancelLabel={t("common.cancel")}
          label={t("globalSearch.openingNovel")}
          onCancel={cancelOpenNovel}
        >
          {openingSource ? (
            <SourceAccessNotice
              active
              sourceId={openingSource.id}
              sourceName={openingSource.name}
            />
          ) : null}
        </BlockingLoadingOverlay>
      ) : null}

      <SearchBar
        value={search}
        onChange={setSearch}
        onSubmit={submitSearch}
        placeholder={t("globalSearch.placeholder")}
      />

      {installedPlugins.length === 0 ? (
        <StateView
          action={{
            label: t("browse.sources.openExtensions"),
            onClick: () => {
              void navigate({ to: "/browse/extensions", search: {} });
            },
          }}
          message={t("globalSearch.noPlugins.message")}
          title={t("globalSearch.noPlugins.title")}
        />
      ) : (
        <div className="norea-search-toolbar">
          <SearchScopeChips
            installedPlugins={installedPlugins}
            onScopeModeChange={setScopeMode}
            onSelectedPluginIdsChange={setSelectedPluginIds}
            pinnedCount={installedPlugins.filter((plugin) => pinnedPluginIds.includes(plugin.id)).length}
            scopeMode={scopeMode}
            selectedPluginIds={selectedPluginIds}
          />
          {hasSearchTerm ? (
            <OverflowMenu
              items={sortItems}
              label={t("globalSearch.resultOptions")}
              trigger={<IconButton label={t("globalSearch.resultOptions")} size="lg"><SortIcon /></IconButton>}
            />
          ) : null}
        </div>
      )}

      {hasSearchTerm && installedPlugins.length > 0 && scopedPlugins.length === 0 ? (
        <StateView
          action={{ label: t("globalSearch.searchAllSources"), onClick: () => setScopeMode("all") }}
          color="warn"
          message={t("globalSearch.noSources.message")}
          title={t("globalSearch.noSources.title")}
        />
      ) : null}

      {pendingCount > 0 ? (
        <div className="norea-search-progress" role="status">
          <Loader size="xs" />
          {t("globalSearch.searchingCount", { count: pendingCount })}
        </div>
      ) : null}

      {pendingPlugins.map((plugin) => (
        <SourceAccessNotice
          active
          key={plugin.id}
          sourceId={plugin.id}
          sourceName={plugin.name}
        />
      ))}

      {hasSearchTerm ? (
        <SearchFailures
          active
          failures={failures}
          onOpenSite={openSite}
          onRetry={retrySource}
          onRetryAll={retryFailed}
        />
      ) : null}

      {openError ? (
        <StateView
          color="danger"
          details={{ content: openError, label: t("common.details") }}
          title={t("common.openFailed")}
        />
      ) : null}

      {hasOnlyEmptyResults ? (
        <StateView
          message={t("globalSearch.noMatches.message", { query: trimmedQuery })}
          title={t("common.noMatches")}
        />
      ) : null}

      {sourcesWithResults.map(({ plugin, result }) => (
        <SearchResultSection
          isInLibrary={isInLibrary}
          isQuickAddPending={quickAdd.isPending}
          key={plugin.id}
          onMore={openPluginResults}
          onOpen={(resultRow, novel) => {
            void handleOpenNovel(resultRow, novel);
          }}
          onQuickAdd={quickAdd.add}
          onOpenSite={openSite}
          onOpenSource={openSource}
          onTogglePinned={togglePinnedPlugin}
          openingKey={openingKey}
          pinned={pinnedPluginIds.includes(plugin.id)}
          plugin={plugin}
          result={result}
        />
      ))}

      {hasSearchTerm && !hasOnlyEmptyResults ? <EmptySources plugins={emptySources} /> : null}
      {quickAdd.categorySheet}
    </div>
  );
}
