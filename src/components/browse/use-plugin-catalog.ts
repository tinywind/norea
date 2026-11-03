import { useQuery, type QueryClient } from "@tanstack/react-query";
import {
  getCachedRepoIndex,
  setCachedRepoIndex,
} from "../../db/queries/repo-index-cache";
import {
  listRepositories,
  type PluginRepository,
} from "../../db/queries/repository";
import { useTranslation } from "../../i18n";
import { isValidPluginItem, pluginManager } from "../../lib/plugins/manager";
import type { Plugin, PluginItem } from "../../lib/plugins/types";
import { isNewerPluginVersion } from "../../lib/plugins/version";
import { enqueueMainTask } from "../../lib/tasks/main-tasks";
import { isTauriRuntime } from "../../lib/tauri-runtime";

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
  item: PluginItem;
  plugin: Plugin;
}

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

/** Installed plugins whose repository entry carries a strictly newer version. */
export function findPluginUpdates(
  installed: readonly Plugin[],
  entries: readonly AvailableEntry[],
): PluginUpdate[] {
  const available = new Map(entries.map(({ item }) => [item.id, item]));
  return installed.flatMap((plugin) => {
    const item = available.get(plugin.id);
    return item && !isMultiSourcePlugin(item) && isNewerPluginVersion(item.version, plugin.version)
      ? [{ item, plugin }]
      : [];
  });
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
