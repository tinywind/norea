import {
  deleteInstalledPlugin,
  listInstalledPlugins,
  upsertInstalledPlugin,
} from "../../db/queries/installed-plugin";
import {
  appFetchText,
  createPluginFetchShim,
} from "../http";
import type { ScraperExecutorId } from "../tasks/scraper-queue";
import { getPluginBaseUrl } from "./base-url";
import { clearPluginInputValues, setPluginInputValue } from "./inputs";
import {
  createLazyPluginProxy,
  createPluginRuntimeHandle,
  type PluginRuntimeHandle,
} from "./runtime";
import { loadPlugin } from "./sandbox";
import { createShimResolver } from "./shims";
import type { Plugin, PluginInstallMode, PluginItem } from "./types";

export class PluginValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginValidationError";
  }
}

const REQUIRED_PLUGIN_METADATA_FIELDS = [
  "id",
  "name",
  "lang",
  "version",
] as const;

const REQUIRED_PLUGIN_METHOD_FIELDS = [
  "popularNovels",
  "parseNovel",
  "parseNovelSince",
  "parseChapter",
  "searchNovels",
  "getBaseUrl",
] as const;

const LOCAL_PLUGIN_LANGUAGE = "multi";

function readRequiredPluginString(
  value: unknown,
  field: string,
  sourceLabel: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PluginValidationError(
      `Plugin ${sourceLabel} is missing required string field '${field}'.`,
    );
  }
  return value;
}

function readOptionalPluginString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value
    : undefined;
}

function readOptionalPluginInstallMode(
  value: unknown,
): PluginInstallMode | undefined {
  return value === "single" || value === "multiSource" ? value : undefined;
}

function slugifyPluginInstanceId(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "source";
}

function assertPluginContract(plugin: Plugin, sourceLabel: string): void {
  const value = plugin as unknown as Record<string, unknown>;
  for (const field of [...REQUIRED_PLUGIN_METADATA_FIELDS, "url"] as const) {
    readRequiredPluginString(value[field], field, sourceLabel);
  }
  if (typeof value.iconUrl !== "string") {
    throw new PluginValidationError(
      `Plugin ${sourceLabel} is missing required string field 'iconUrl'.`,
    );
  }
  for (const field of REQUIRED_PLUGIN_METHOD_FIELDS) {
    if (typeof value[field] !== "function") {
      throw new PluginValidationError(
        `Plugin ${sourceLabel} is missing required function '${field}'.`,
      );
    }
  }
}

function pluginItemFromLocalSource(
  plugin: Plugin,
  sourceUrl: string,
): PluginItem {
  const value = plugin as unknown as Record<string, unknown>;
  return {
    id: readRequiredPluginString(value.id, "id", sourceUrl),
    name: readRequiredPluginString(value.name, "name", sourceUrl),
    lang: readOptionalPluginString(value.lang) ?? LOCAL_PLUGIN_LANGUAGE,
    version: readRequiredPluginString(value.version, "version", sourceUrl),
    url: sourceUrl,
    iconUrl: readOptionalPluginString(value.iconUrl) ?? "",
    installMode: readOptionalPluginInstallMode(value.installMode),
  };
}

/**
 * Type-guard for the loose JSON shape upstream `repository.json`
 * indexes carry. We only require the fields the host actually
 * uses; any extras pass through.
 */
export function isValidPluginItem(value: unknown): value is PluginItem {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.url === "string" &&
    typeof v.lang === "string" &&
    typeof v.version === "string" &&
    typeof v.iconUrl === "string"
  );
}

function withPluginMetadata(
  plugin: Plugin,
  item: PluginItem,
  options: { overrideIdentity?: boolean } = {},
): Plugin {
  const target = plugin as Plugin & Partial<PluginItem>;
  if (options.overrideIdentity) {
    target.id = item.id;
    target.name = item.name;
    target.lang = item.lang;
    target.version = item.version;
    target.url = item.url;
    target.iconUrl = item.iconUrl;
    target.installMode = item.installMode;
    return plugin;
  }

  target.id = typeof target.id === "string" ? target.id : item.id;
  target.name = typeof target.name === "string" ? target.name : item.name;
  target.lang = typeof target.lang === "string" ? target.lang : item.lang;
  target.version =
    typeof target.version === "string" ? target.version : item.version;
  target.url = typeof target.url === "string" ? target.url : item.url;
  target.iconUrl =
    typeof target.iconUrl === "string" ? target.iconUrl : item.iconUrl;
  target.installMode =
    readOptionalPluginInstallMode(target.installMode) ?? item.installMode;
  return plugin;
}

function pluginItemFromPlugin(plugin: Plugin, sourceUrl: string): PluginItem {
  return {
    id: plugin.id,
    name: plugin.name,
    lang: plugin.lang,
    version: plugin.version,
    iconUrl: plugin.iconUrl,
    url: sourceUrl,
    installMode: plugin.installMode,
  };
}

export interface PluginInstanceInstallInput {
  name: string;
  inputs?: Record<string, string>;
}

export interface InstalledPluginMetadata extends PluginItem {
  sourceHash: string;
  loadedExecutors: ScraperExecutorId[];
}

/**
 * Manages installed plugins for the running session.
 *
 * Plugins are kept in memory and persisted to SQLite. App startup
 * rehydrates installed plugin metadata from the DB without hitting
 * the repository network path or evaluating plugin source.
 */
export class PluginManager {
  private readonly installed = new Map<string, Plugin>();
  private readonly runtimeHandles = new Map<string, PluginRuntimeHandle>();
  private installedLoadPromise: Promise<void> | null = null;

  /**
   * Fetch a repository index URL and return the PluginItem[] list.
   * Drops malformed entries silently. Throws PluginValidationError
   * if the response isn't valid JSON or isn't an array.
   */
  async fetchRepository(repositoryUrl: string): Promise<PluginItem[]> {
    const text = await appFetchText(repositoryUrl);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new PluginValidationError(
        `Repository ${repositoryUrl} returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new PluginValidationError(
        `Repository ${repositoryUrl} did not return a JSON array.`,
      );
    }
    return parsed.filter(isValidPluginItem);
  }

  /**
   * Download `item.url`, sandbox-load it, register the result keyed
   * by the loaded plugin's `id`, and persist the source to DB so
   * the next app start rehydrates it without re-fetching. Throws if
   * the loaded plugin's `id` doesn't match `item.id`.
   */
  async installPlugin(item: PluginItem): Promise<Plugin> {
    if (item.installMode === "multiSource") {
      throw new PluginValidationError(
        `Plugin '${item.id}' must be installed as a source instance.`,
      );
    }
    const source = await appFetchText(item.url);
    const plugin = this.loadRuntimePlugin(source, item, "immediate");
    if (plugin.id !== item.id) {
      throw new PluginValidationError(
        `Plugin id mismatch: repository index says '${item.id}', source says '${plugin.id}'.`,
      );
    }
    await this.registerInstalledPlugin(plugin, item.url, source);
    return plugin;
  }

  async installPluginInstance(
    item: PluginItem,
    input: PluginInstanceInstallInput,
  ): Promise<Plugin> {
    const name = input.name.trim();
    if (name === "") {
      throw new PluginValidationError("Source name is required.");
    }

    const source = await appFetchText(item.url);
    const provider = this.loadRuntimePlugin(source, item, "immediate");
    if (provider.id !== item.id) {
      throw new PluginValidationError(
        `Plugin id mismatch: repository index says '${item.id}', source says '${provider.id}'.`,
      );
    }

    const idHint = input.inputs?.repository ?? name;
    const instanceItem: PluginItem = {
      ...item,
      id: this.nextAvailablePluginId(
        `${item.id}:${slugifyPluginInstanceId(idHint)}`,
      ),
      name,
      installMode: "single",
    };
    const plugin = this.loadRuntimePlugin(source, instanceItem, "immediate", {
      overrideIdentity: true,
    });
    await this.registerInstalledPlugin(plugin, item.url, source);

    for (const [key, value] of Object.entries(input.inputs ?? {})) {
      setPluginInputValue(plugin.id, key, value);
    }

    return plugin;
  }

  /**
   * Install a local plugin source file. Repository-only metadata is
   * synthesized when absent, but the runtime methods must be present
   * before the plugin is persisted.
   */
  async installPluginFromSource(
    source: string,
    sourceUrl: string,
  ): Promise<Plugin> {
    const item = pluginItemFromLocalSource(
      loadPlugin(source, {
        resolveRequire: createShimResolver(
          sourceUrl,
          undefined,
          "immediate",
        ),
        fetch: createPluginFetchShim(
          undefined,
          undefined,
          "immediate",
        ),
      }),
      sourceUrl,
    );
    const plugin = this.loadRuntimePlugin(source, item, "immediate");
    await this.registerInstalledPlugin(plugin, sourceUrl, source);
    return plugin;
  }

  private loadRuntimePlugin(
    source: string,
    item: PluginItem,
    executor: ScraperExecutorId,
    options: { overrideIdentity?: boolean } = {},
  ): Plugin {
    let plugin: Plugin | undefined;
    const baseUrl = () => {
      if (!plugin) {
        throw new PluginValidationError(
          `Plugin '${item.id}' accessed its base URL during module load.`,
        );
      }
      return getPluginBaseUrl(plugin);
    };
    plugin = withPluginMetadata(
      loadPlugin(source, {
        resolveRequire: createShimResolver(item.id, baseUrl, executor),
        fetch: createPluginFetchShim(baseUrl, item.id, executor),
      }),
      item,
      options,
    );
    assertPluginContract(plugin, item.url);
    try {
      getPluginBaseUrl(plugin);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Plugin '${item.id}' returned an invalid base URL.`;
      throw new PluginValidationError(message);
    }
    return plugin;
  }

  private async registerInstalledPlugin(
    plugin: Plugin,
    sourceUrl: string,
    source: string,
  ): Promise<void> {
    const item = pluginItemFromPlugin(plugin, sourceUrl);
    this.installed.set(plugin.id, plugin);
    this.runtimeHandles.set(
      plugin.id,
      createPluginRuntimeHandle({
        item,
        source,
        initialRuntime: plugin,
        compiler: ({ executor, item, overrideIdentity, source }) =>
          this.loadRuntimePlugin(source, item, executor, {
            overrideIdentity,
          }),
      }),
    );
    await upsertInstalledPlugin({
      id: plugin.id,
      name: plugin.name,
      lang: plugin.lang,
      version: plugin.version,
      iconUrl: plugin.iconUrl,
      sourceUrl,
      sourceCode: source,
    });
  }

  /**
   * Rehydrate every previously-installed plugin from the DB as metadata-backed
   * lazy handles. Stored source compiles only when a runtime method is used.
   */
  async loadInstalledFromDb(): Promise<void> {
    if (this.installedLoadPromise) {
      return this.installedLoadPromise;
    }
    const load = this.loadInstalledFromDbOnce().catch((error) => {
      this.installedLoadPromise = null;
      throw error;
    });
    this.installedLoadPromise = load;
    return load;
  }

  async reloadInstalledFromDb(): Promise<void> {
    this.installedLoadPromise = null;
    this.installed.clear();
    this.runtimeHandles.clear();
    await this.loadInstalledFromDb();
  }

  private async loadInstalledFromDbOnce(): Promise<void> {
    const rows = await listInstalledPlugins();
    for (const row of rows) {
      try {
        const item: PluginItem = {
          id: readRequiredPluginString(row.id, "id", row.sourceUrl),
          name: readRequiredPluginString(row.name, "name", row.sourceUrl),
          lang: readRequiredPluginString(row.lang, "lang", row.sourceUrl),
          version: readRequiredPluginString(
            row.version,
            "version",
            row.sourceUrl,
          ),
          iconUrl: typeof row.iconUrl === "string" ? row.iconUrl : "",
          url: readRequiredPluginString(
            row.sourceUrl,
            "url",
            row.sourceUrl,
          ),
        };
        const handle = createPluginRuntimeHandle({
          item,
          source: row.sourceCode,
          compiler: ({ executor, item, overrideIdentity, source }) =>
            this.loadRuntimePlugin(source, item, executor, {
              overrideIdentity,
            }),
        });
        this.runtimeHandles.set(row.id, handle);
        this.installed.set(row.id, createLazyPluginProxy(handle));
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(
          `[PluginManager] failed to reload '${row.id}' from DB:`,
          error,
        );
      }
    }
  }

  getPlugin(id: string): Plugin | undefined {
    return this.installed.get(id);
  }

  getInstalledPluginMetadata(id: string): InstalledPluginMetadata | undefined {
    const handle = this.runtimeHandles.get(id);
    if (!handle) return undefined;
    return {
      ...handle.item,
      sourceHash: handle.sourceHash,
      loadedExecutors: handle.loadedExecutors(),
    };
  }

  listInstalledPluginMetadata(): InstalledPluginMetadata[] {
    return [...this.runtimeHandles.values()].map((handle) => ({
      ...handle.item,
      sourceHash: handle.sourceHash,
      loadedExecutors: handle.loadedExecutors(),
    }));
  }

  getPluginForExecutor(id: string, executor: ScraperExecutorId): Plugin {
    const base = this.installed.get(id);
    if (!base) {
      throw new PluginValidationError(`Plugin '${id}' is not installed.`);
    }
    if (executor === "immediate") return base;

    return this.runtimeHandles.get(id)?.getRuntime(executor) ?? base;
  }

  async uninstallPlugin(id: string): Promise<boolean> {
    if (!this.installed.has(id)) return false;
    try {
      await deleteInstalledPlugin(id);
    } catch (error) {
      throw new Error(
        `Failed to delete installed plugin '${id}' during uninstall.`,
        { cause: error },
      );
    }
    this.installed.delete(id);
    this.runtimeHandles.delete(id);
    clearPluginInputValues(id);
    return true;
  }

  list(): Plugin[] {
    return [...this.installed.values()];
  }

  has(id: string): boolean {
    return this.installed.has(id);
  }

  size(): number {
    return this.installed.size;
  }

  private nextAvailablePluginId(baseId: string): string {
    if (!this.installed.has(baseId)) return baseId;
    for (let index = 2; ; index += 1) {
      const candidate = `${baseId}-${index}`;
      if (!this.installed.has(candidate)) return candidate;
    }
  }
}

/** Process-global singleton for the running session. */
export const pluginManager = new PluginManager();
