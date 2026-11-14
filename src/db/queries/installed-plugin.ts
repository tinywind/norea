import { invokeDbMutation, invokeDbQuery } from "../ipc";

export interface InstalledPluginRow {
  id: string;
  name: string;
  lang: string;
  version: string;
  iconUrl: string;
  sourceUrl: string;
  sourceCode: string;
  installedAt: number;
  /** The publishing repository updates come from; null when unknown. */
  repositoryUrl: string | null;
}

export interface UpsertInstalledPluginInput {
  id: string;
  name: string;
  lang: string;
  version: string;
  iconUrl: string;
  sourceUrl: string;
  sourceCode: string;
  repositoryUrl: string | null;
}

export async function listInstalledPlugins(): Promise<InstalledPluginRow[]> {
  return invokeDbQuery<InstalledPluginRow[]>("db_plugin_list_installed");
}

/**
 * Upsert by primary key (`id`). Reinstalling a plugin overwrites the
 * stored source so a freshly published version replaces the old.
 */
export async function upsertInstalledPlugin(
  input: UpsertInstalledPluginInput,
): Promise<void> {
  await invokeDbMutation("db_plugin_upsert_installed", { input });
}

export async function deleteInstalledPlugin(id: string): Promise<void> {
  await invokeDbMutation("db_plugin_delete_installed", { id });
}
