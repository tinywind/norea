import { useMemo } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import {
  getCachedRepoIndex,
  setCachedRepoIndex,
} from "../../db/queries/repo-index-cache";
import {
  addRepository,
  listRepositories,
  type PluginRepository,
} from "../../db/queries/repository";
import { translate, useTranslation } from "../../i18n";
import {
  isPluginSourceInstanceOf,
  isValidPluginItem,
  pluginManager,
} from "../../lib/plugins/manager";
import type { Plugin, PluginItem } from "../../lib/plugins/types";
import { comparePluginVersions } from "../../lib/plugins/version";
import { enqueueMainTask } from "../../lib/tasks/main-tasks";
import { isTauriRuntime } from "../../lib/tauri-runtime";
import { useAppearanceStore } from "../../store/appearance";

export const REPO_QUERY_KEY = ["repository", "list"] as const;
export const AVAILABLE_QUERY_KEY = ["plugin", "available"] as const;
export const INSTALLED_QUERY_KEY = ["plugin", "installed"] as const;

export interface AvailableEntry {
  item: PluginItem;
  repoUrl: string;
}

export interface RepoFetchFailure {
  repoUrl: string;
  message: string;
}

export interface AvailableResult {
  entries: AvailableEntry[];
  failures: RepoFetchFailure[];
}

export interface PluginUpdate {
  /** The plugin's own index entry, or the template of a source instance. */
  item: PluginItem;
  plugin: Plugin;
  /** The repository listing `item`. */
  repoUrl: string;
}

/** The repository an installed plugin updates from; null when unknown. */
export type PluginPublisherLookup = (pluginId: string) => string | null;

export const installedPluginPublisher: PluginPublisherLookup = (pluginId) =>
  pluginManager.getPluginRepositoryUrl(pluginId);

export interface PluginUpdateOutcome {
  plugin: Plugin;
  error?: unknown;
}

const REPOSITORY_INDEX_MAX_AGE_SECONDS = 24 * 60 * 60;
let launchIndexRefresh: Promise<boolean> | null = null;

/** `true` refetches every repository; a URL refetches only that one. */
let forceRefreshNext: boolean | string = false;

function debugRepositoryFlow(message: string, data?: unknown): void {
  console.debug("[browse:repository]", message, data);
}

/**
 * Cache-first index loader over the enabled repositories, in priority order.
 * Without `forceRefresh`, each repository returns its cached items and only a
 * repository without a cache row is fetched once. `true` refetches every
 * repository and a repository URL refetches that one, overwriting the cache.
 */
async function fetchAllAvailable(
  allRepos: readonly PluginRepository[],
  forceRefresh: boolean | string,
): Promise<AvailableResult> {
  const repos = allRepos.filter((repo) => repo.enabled);
  debugRepositoryFlow("available fetch start", {
    forceRefresh,
    repositoryCount: repos.length,
  });
  const entries: AvailableEntry[] = [];
  const failures: RepoFetchFailure[] = [];
  for (const repo of repos) {
    try {
      let items: PluginItem[] | null = null;
      if (forceRefresh !== true && forceRefresh !== repo.url) {
        const cached = await getCachedRepoIndex(repo.url);
        if (cached) items = cached.items.filter(isValidPluginItem);
        debugRepositoryFlow(cached ? "available repo cache hit" : "available repo cache miss", {
          repoId: repo.id,
          repoUrl: repo.url,
        });
      }
      if (items === null) {
        items = await pluginManager.fetchRepository(repo.url);
        await setCachedRepoIndex(repo.url, items);
        debugRepositoryFlow("available repo network fetch complete", {
          repoId: repo.id,
          repoUrl: repo.url,
          itemCount: items.length,
        });
      }
      for (const item of items) entries.push({ item, repoUrl: repo.url });
    } catch (error) {
      console.warn("[browse:repository] available repo failed", {
        repoId: repo.id,
        repoUrl: repo.url,
        error,
      });
      failures.push({
        repoUrl: repo.url,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  debugRepositoryFlow("available fetch complete", {
    entryCount: entries.length,
    failureCount: failures.length,
  });
  return { entries, failures };
}

export function useInstalledPlugins(enabled: boolean) {
  return useQuery({
    meta: { errorPresentation: "inline" },
    queryKey: INSTALLED_QUERY_KEY,
    queryFn: async () => {
      if (isTauriRuntime()) {
        await pluginManager.loadInstalledFromDb();
      }
      return pluginManager.list();
    },
    staleTime: 0,
    enabled,
  });
}

export function useRepositories(enabled: boolean) {
  return useQuery({
    meta: { errorPresentation: "inline" },
    queryKey: REPO_QUERY_KEY,
    queryFn: listRepositories,
    enabled,
  });
}

/**
 * The enabled repositories' indexes in priority order, read cache-first
 * unless a refresh was requested. The repository list is read when the query
 * runs, so a list change and its invalidation never race.
 */
export function useAvailablePlugins(
  repos: readonly PluginRepository[] | undefined,
  enabled: boolean,
) {
  const { t } = useTranslation();
  return useQuery({
    meta: { errorPresentation: "inline" },
    queryKey: AVAILABLE_QUERY_KEY,
    queryFn: async () => {
      const force = forceRefreshNext;
      forceRefreshNext = false;
      const current = await listRepositories();
      if (force === false) return fetchAllAvailable(current, false);
      return enqueueMainTask({
        kind: "repository.refreshIndex",
        title: t("browse.repositoryIndex"),
        run: () => fetchAllAvailable(current, force),
      }).promise;
    },
    enabled: enabled && !!repos && repos.length > 0,
  });
}

/**
 * Repository entries already in the local index cache, without any network
 * request, for surfaces that only hint at updates.
 */
export function useCachedAvailablePlugins(enabled: boolean) {
  return useQuery({
    queryKey: [...AVAILABLE_QUERY_KEY, "cached"] as const,
    queryFn: async (): Promise<AvailableEntry[]> => {
      const entries: AvailableEntry[] = [];
      for (const repo of await listRepositories()) {
        if (!repo.enabled) continue;
        const cached = await getCachedRepoIndex(repo.url);
        for (const item of cached?.items.filter(isValidPluginItem) ?? []) {
          entries.push({ item, repoUrl: repo.url });
        }
      }
      return entries;
    },
    enabled,
  });
}

/**
 * Refetches every repository index, or only `repoUrl`'s, from the network on
 * the next load.
 */
export function refreshAvailablePlugins(queryClient: QueryClient, repoUrl?: string): void {
  forceRefreshNext = repoUrl ?? true;
  void queryClient.invalidateQueries({ queryKey: AVAILABLE_QUERY_KEY });
}

export interface AddedRepository {
  /** False when the URL was already in the list. */
  added: boolean;
  items: PluginItem[];
}

/**
 * Fetches a repository index and, only once it is valid, appends the
 * repository to the list and caches the index.
 */
export async function addPluginRepository(url: string): Promise<AddedRepository> {
  const items = await pluginManager.fetchRepository(url);
  const added = await addRepository({ url });
  await setCachedRepoIndex(url, items);
  return { added, items };
}

export function isMultiSourcePlugin(item: PluginItem): boolean {
  return item.installMode === "multiSource";
}

/**
 * The entry an installed plugin matches in one repository's listing: its own
 * entry, or, for a source instance (`<template id>:<slug>`), the multi-source
 * template it was created from.
 */
function repositoryEntryFor(
  plugin: Plugin,
  available: ReadonlyMap<string, PluginItem>,
): PluginItem | undefined {
  const own = available.get(plugin.id);
  if (own) return isMultiSourcePlugin(own) ? undefined : own;
  const separator = plugin.id.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const template = available.get(plugin.id.slice(0, separator));
  return template && isPluginSourceInstanceOf(plugin.id, template) ? template : undefined;
}

function entriesByRepository(
  entries: readonly AvailableEntry[],
): Map<string, Map<string, PluginItem>> {
  const byRepository = new Map<string, Map<string, PluginItem>>();
  for (const { item, repoUrl } of entries) {
    const items = byRepository.get(repoUrl) ?? new Map<string, PluginItem>();
    if (!items.has(item.id)) items.set(item.id, item);
    byRepository.set(repoUrl, items);
  }
  return byRepository;
}

/**
 * Every repository listing that offers an installed plugin, in the order of
 * `entries` (repository priority).
 */
function offersFor(
  plugin: Plugin,
  byRepository: ReadonlyMap<string, ReadonlyMap<string, PluginItem>>,
): AvailableEntry[] {
  const offers: AvailableEntry[] = [];
  for (const [repoUrl, items] of byRepository) {
    const item = repositoryEntryFor(plugin, items);
    if (item) offers.push({ item, repoUrl });
  }
  return offers;
}

function pluginVersionMatches(
  installed: readonly Plugin[],
  entries: readonly AvailableEntry[],
  publisherOf: PluginPublisherLookup,
  relation: "newer" | "different",
): PluginUpdate[] {
  const byRepository = entriesByRepository(entries);
  return installed.flatMap((plugin) => {
    const publisher = publisherOf(plugin.id);
    const listing = publisher === null ? undefined : byRepository.get(publisher);
    const item = listing ? repositoryEntryFor(plugin, listing) : undefined;
    return item && publisher !== null && comparePluginVersions(item.version, plugin.version) === relation
      ? [{ item, plugin, repoUrl: publisher }]
      : [];
  });
}

/**
 * Installed plugins, source instances included, whose publishing repository
 * lists a strictly newer version. Other repositories never update a plugin,
 * and a plugin with an unknown publisher is never updated.
 */
export function findPluginUpdates(
  installed: readonly Plugin[],
  entries: readonly AvailableEntry[],
  publisherOf: PluginPublisherLookup,
): PluginUpdate[] {
  return pluginVersionMatches(installed, entries, publisherOf, "newer");
}

/**
 * Installed plugins whose publishing repository lists a lower version or one
 * that cannot be ordered. They are shown, never offered as updates.
 */
export function findDifferentPluginVersions(
  installed: readonly Plugin[],
  entries: readonly AvailableEntry[],
  publisherOf: PluginPublisherLookup,
): PluginUpdate[] {
  return pluginVersionMatches(installed, entries, publisherOf, "different");
}

/**
 * Other repositories that offer an installed plugin, by plugin id. For a
 * plugin with an unknown publisher every offer is listed so the user can
 * choose one; switching publisher is always an explicit action.
 */
export function findPublisherOffers(
  installed: readonly Plugin[],
  entries: readonly AvailableEntry[],
  publisherOf: PluginPublisherLookup,
): Map<string, AvailableEntry[]> {
  const byRepository = entriesByRepository(entries);
  const offers = new Map<string, AvailableEntry[]>();
  for (const plugin of installed) {
    const publisher = publisherOf(plugin.id);
    const others = offersFor(plugin, byRepository).filter(({ repoUrl }) => repoUrl !== publisher);
    if (others.length > 0) offers.set(plugin.id, others);
  }
  return offers;
}

/**
 * The installable catalog: one entry per plugin id, from the highest-priority
 * repository that lists it. `entries` arrive in repository priority order.
 */
export function mergeCatalogEntries(entries: readonly AvailableEntry[]): AvailableEntry[] {
  const seen = new Set<string>();
  return entries.filter(({ item }) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/** Update count from the cached index, for the Extensions entry badges. */
export function usePluginUpdateCount(active: boolean): number {
  const installed = useInstalledPlugins(active);
  const cachedAvailable = useCachedAvailablePlugins(active);
  return useMemo(
    () =>
      findPluginUpdates(installed.data ?? [], cachedAvailable.data ?? [], installedPluginPublisher)
        .length,
    [cachedAvailable.data, installed.data],
  );
}

/**
 * Updates each plugin in turn and reports every outcome. A failed update
 * leaves that plugin as it was and does not stop the others.
 */
export async function updatePlugins(
  updates: readonly PluginUpdate[],
  update: (pluginUpdate: PluginUpdate) => Promise<unknown>,
): Promise<PluginUpdateOutcome[]> {
  const outcomes: PluginUpdateOutcome[] = [];
  for (const pluginUpdate of updates) {
    try {
      await update(pluginUpdate);
      outcomes.push({ plugin: pluginUpdate.plugin });
    } catch (error) {
      outcomes.push({ plugin: pluginUpdate.plugin, error });
    }
  }
  return outcomes;
}

async function hasStaleRepositoryIndex(
  repos: readonly PluginRepository[],
  nowSeconds: number,
): Promise<boolean> {
  for (const repo of repos) {
    const cached = await getCachedRepoIndex(repo.url);
    if (!cached || nowSeconds - cached.fetchedAt >= REPOSITORY_INDEX_MAX_AGE_SECONDS) {
      return true;
    }
  }
  return false;
}

/**
 * Refetches the repository indexes at launch when any cached index is a day
 * old or missing, so the update counts stay current without a manual
 * refresh. Runs once per session; resolves whether a refresh ran.
 */
export function refreshStaleRepositoryIndexesAtLaunch(
  queryClient: QueryClient,
  nowSeconds: number = Date.now() / 1000,
): Promise<boolean> {
  launchIndexRefresh ??= (async () => {
    const repos = (await listRepositories()).filter((repo) => repo.enabled);
    if (repos.length === 0 || !(await hasStaleRepositoryIndex(repos, nowSeconds))) {
      return false;
    }
    const result = await enqueueMainTask({
      kind: "repository.refreshIndex",
      title: translate(useAppearanceStore.getState().appLocale, "browse.repositoryIndex"),
      run: () => fetchAllAvailable(repos, true),
    }).promise;
    queryClient.setQueryData<AvailableResult>(AVAILABLE_QUERY_KEY, result);
    void queryClient.invalidateQueries({ queryKey: [...AVAILABLE_QUERY_KEY, "cached"] });
    return true;
  })();
  return launchIndexRefresh;
}

export function resetLaunchRepositoryIndexRefreshForTests(): void {
  launchIndexRefresh = null;
}

export function hasPluginInputs(plugin: Plugin | null | undefined): boolean {
  if (!plugin) return false;
  return (
    Object.keys(plugin.pluginInputs ?? {}).length > 0 ||
    Object.keys(plugin.pluginSettings ?? {}).length > 0
  );
}

export function sortPluginsByName<T extends PluginItem>(plugins: readonly T[]): T[] {
  return [...plugins].sort((a, b) =>
    (a.name ?? a.id).localeCompare(b.name ?? b.id),
  );
}
