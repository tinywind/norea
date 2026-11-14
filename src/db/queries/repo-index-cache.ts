import type { PluginItem } from "../../lib/plugins/types";
import { invokeDbMutation, invokeDbQuery } from "../ipc";

export interface RepositoryIndexCacheRow {
  repoUrl: string;
  fetchedAt: number;
  items: PluginItem[];
}

/** Returns the cached index for `repoUrl`, or null on miss. */
export async function getCachedRepoIndex(
  repoUrl: string,
): Promise<RepositoryIndexCacheRow | null> {
  return invokeDbQuery<RepositoryIndexCacheRow | null>("db_repo_cache_get", {
    repoUrl,
  });
}

export async function listAllCachedRepoIndexes(): Promise<
  RepositoryIndexCacheRow[]
> {
  return invokeDbQuery<RepositoryIndexCacheRow[]>("db_repo_cache_list_all");
}

/** Upsert `items` under `repoUrl`, bumping fetched_at to now. */
export async function setCachedRepoIndex(
  repoUrl: string,
  items: readonly PluginItem[],
): Promise<void> {
  await invokeDbMutation("db_repo_cache_set", {
    repoUrl,
    items: [...items],
  });
}

export async function deleteCachedRepoIndex(repoUrl: string): Promise<void> {
  await invokeDbMutation("db_repo_cache_delete", { repoUrl });
}
