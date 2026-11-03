import { useMemo } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import {
  getCachedRepoIndex,
  setCachedRepoIndex,
} from "../../db/queries/repo-index-cache";
import {
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
}

export interface PluginUpdateOutcome {
  plugin: Plugin;
  error?: unknown;
}

const REPOSITORY_INDEX_MAX_AGE_SECONDS = 24 * 60 * 60;
let launchIndexRefresh: Promise<boolean> | null = null;

let forceRefreshNext = false;

function debugRepositoryFlow(message: string, data?: unknown): void {
  console.debug("[browse:repository]", message, data);
}

/**
 * Cache-first index loader. Without `forceRefresh`, each repository returns
 * its cached items and only a repository without a cache row is fetched once.
 * With `forceRefresh`, every repository is fetched and its cache overwritten.
 */
async function fetchAllAvailable(
  repos: readonly PluginRepository[],
  forceRefresh: boolean,
): Promise<AvailableResult> {
  debugRepositoryFlow("available fetch start", {
    forceRefresh,
    repositoryCount: repos.length,
  });
  const entries: AvailableEntry[] = [];
  const failures: RepoFetchFailure[] = [];
  for (const repo of repos) {
    try {
      let items: PluginItem[] | null = null;
      if (!forceRefresh) {
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

/** The repository index, read cache-first unless a refresh was requested. */
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
      if (!force) return fetchAllAvailable(repos ?? [], false);
      return enqueueMainTask({
        kind: "repository.refreshIndex",
        title: t("browse.repositoryIndex"),
        run: () => fetchAllAvailable(repos ?? [], true),
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

/** Refetches every repository index from the network on the next load. */
export function refreshAvailablePlugins(queryClient: QueryClient): void {
  forceRefreshNext = true;
  void queryClient.invalidateQueries({ queryKey: AVAILABLE_QUERY_KEY });
}

export function isMultiSourcePlugin(item: PluginItem): boolean {
  return item.installMode === "multiSource";
}

/**
 * The repository entry an installed plugin updates from: its own entry, or,
 * for a source instance (`<template id>:<slug>`), the multi-source template.
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

function pluginVersionMatches(
  installed: readonly Plugin[],
  entries: readonly AvailableEntry[],
  relation: "newer" | "different",
): PluginUpdate[] {
  const available = new Map(entries.map(({ item }) => [item.id, item]));
  return installed.flatMap((plugin) => {
    const item = repositoryEntryFor(plugin, available);
    return item && comparePluginVersions(item.version, plugin.version) === relation
      ? [{ item, plugin }]
      : [];
  });
}

/**
 * Installed plugins, source instances included, whose repository entry
 * carries a strictly newer version.
 */
export function findPluginUpdates(
  installed: readonly Plugin[],
  entries: readonly AvailableEntry[],
): PluginUpdate[] {
  return pluginVersionMatches(installed, entries, "newer");
}

/**
 * Installed plugins whose repository version is lower or cannot be ordered.
 * They are shown, never offered as updates.
 */
export function findDifferentPluginVersions(
  installed: readonly Plugin[],
  entries: readonly AvailableEntry[],
): PluginUpdate[] {
  return pluginVersionMatches(installed, entries, "different");
}

/** Update count from the cached index, for the Extensions entry badges. */
export function usePluginUpdateCount(active: boolean): number {
  const installed = useInstalledPlugins(active);
  const cachedAvailable = useCachedAvailablePlugins(active);
  return useMemo(
    () => findPluginUpdates(installed.data ?? [], cachedAvailable.data ?? []).length,
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
    const repos = await listRepositories();
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
