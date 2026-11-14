import { invokeDbMutation, invokeDbQuery } from "../ipc";

function debugRepositoryQuery(message: string, data?: unknown): void {
  console.debug(`[repository-db] ${message}`, data);
}

export interface PluginRepository {
  id: number;
  url: string;
  name: string | null;
  addedAt: number;
  /** 1 is first. The first enabled repository listing a plugin id wins. */
  priority: number;
  enabled: boolean;
}

/** Every repository, in priority order. */
export async function listRepositories(): Promise<PluginRepository[]> {
  const rows = await invokeDbQuery<PluginRepository[]>("db_repo_list");
  debugRepositoryQuery("list complete", { count: rows.length });
  return rows;
}

export interface AddRepositoryInput {
  url: string;
  name?: string | null;
}

/**
 * Appends a repository after the others, enabled. Resolves false when the
 * URL is already in the list, which is left unchanged.
 */
export async function addRepository(
  input: AddRepositoryInput,
): Promise<boolean> {
  debugRepositoryQuery("add start", { url: input.url });
  const added = await invokeDbMutation<boolean>("db_repo_add", {
    input: {
      url: input.url,
      name: input.name ?? null,
    },
  });
  debugRepositoryQuery("add complete", { url: input.url, added });
  return added;
}

export async function setRepositoryEnabled(
  id: number,
  enabled: boolean,
): Promise<void> {
  await invokeDbMutation("db_repo_set_enabled", { id, enabled });
}

/** Stores `orderedIds` as priorities 1..n in one transaction. */
export async function reorderRepositories(
  orderedIds: readonly number[],
): Promise<void> {
  if (orderedIds.length === 0) return;
  await invokeDbMutation("db_repo_reorder", { orderedIds: [...orderedIds] });
}

export async function removeRepository(id: number): Promise<void> {
  debugRepositoryQuery("remove start", { id });
  await invokeDbMutation("db_repo_remove", { id });
  debugRepositoryQuery("delete repository complete", { id });
}
