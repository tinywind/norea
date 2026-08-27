export type PluginInputValue = string | boolean;

export interface PluginInputOption {
  label: string;
  value: string;
}

export interface PluginInputDefinition {
  value?: PluginInputValue;
  label?: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  private?: boolean;
  options?: PluginInputOption[];
}

export type PluginInputSchema = Record<string, PluginInputDefinition>;
export type PluginInputValues = Record<string, string>;

export interface PluginInputsApi {
  get(key: string): string | null;
  getAll(): PluginInputValues;
  has(key: string): boolean;
  require(key: string): string;
}

const PLUGIN_INPUT_STORAGE_PREFIX = "plugin-v2:";
const LEGACY_PLUGIN_INPUT_STORAGE_PREFIX = "plugin:";

export function getPluginInputPrefix(pluginId: string): string {
  return `${PLUGIN_INPUT_STORAGE_PREFIX}${encodeURIComponent(pluginId)}:`;
}

function getLegacyPluginInputPrefix(pluginId: string): string {
  return `${LEGACY_PLUGIN_INPUT_STORAGE_PREFIX}${pluginId}:`;
}

export function migrateLegacyPluginStorageValues(
  pluginIds: readonly string[],
): number {
  const { localStorage } = globalThis;
  if (!localStorage) return 0;

  const candidates = pluginIds
    .filter(
      (pluginId) =>
        getPluginInputPrefix(pluginId) !== getLegacyPluginInputPrefix(pluginId),
    )
    .sort((left, right) => right.length - left.length);
  if (candidates.length === 0) return 0;

  const legacyKeys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(LEGACY_PLUGIN_INPUT_STORAGE_PREFIX)) {
      legacyKeys.push(key);
    }
  }

  let migrated = 0;
  for (const legacyKey of legacyKeys) {
    const pluginId = candidates.find((candidate) =>
      legacyKey.startsWith(getLegacyPluginInputPrefix(candidate)),
    );
    if (!pluginId) continue;
    const legacyPrefix = getLegacyPluginInputPrefix(pluginId);
    const value = localStorage.getItem(legacyKey);
    if (value === null) continue;
    const nextKey = `${getPluginInputPrefix(pluginId)}${legacyKey.slice(legacyPrefix.length)}`;
    if (localStorage.getItem(nextKey) === null) {
      localStorage.setItem(nextKey, value);
    }
    localStorage.removeItem(legacyKey);
    migrated += 1;
  }
  return migrated;
}

export function getPluginInputValue(
  pluginId: string,
  key: string,
): string | null {
  const { localStorage } = globalThis;
  if (!localStorage) return null;
  return localStorage.getItem(`${getPluginInputPrefix(pluginId)}${key}`);
}

export function setPluginInputValue(
  pluginId: string,
  key: string,
  value: string,
): void {
  const { localStorage } = globalThis;
  if (!localStorage) return;
  localStorage.setItem(`${getPluginInputPrefix(pluginId)}${key}`, value);
}

export function deletePluginInputValue(pluginId: string, key: string): void {
  const { localStorage } = globalThis;
  if (!localStorage) return;
  localStorage.removeItem(`${getPluginInputPrefix(pluginId)}${key}`);
}

export function getPluginInputValues(pluginId: string): PluginInputValues {
  const prefix = getPluginInputPrefix(pluginId);
  const values: PluginInputValues = {};
  const { localStorage } = globalThis;
  if (!localStorage) return values;
  for (let index = 0; index < localStorage.length; index += 1) {
    const fullKey = localStorage.key(index);
    if (fullKey?.startsWith(prefix)) {
      values[fullKey.slice(prefix.length)] =
        localStorage.getItem(fullKey) ?? "";
    }
  }
  return values;
}

export function clearPluginInputValues(pluginId: string): number {
  const prefix = getPluginInputPrefix(pluginId);
  const keys: string[] = [];
  const { localStorage } = globalThis;
  if (!localStorage) return 0;
  for (let index = 0; index < localStorage.length; index += 1) {
    const fullKey = localStorage.key(index);
    if (fullKey?.startsWith(prefix)) {
      keys.push(fullKey);
    }
  }
  for (const key of keys) {
    localStorage.removeItem(key);
  }
  return keys.length;
}

export function createPluginInputsApi(pluginId: string): PluginInputsApi {
  return {
    get(key) {
      return getPluginInputValue(pluginId, key);
    },
    getAll() {
      return getPluginInputValues(pluginId);
    },
    has(key) {
      return getPluginInputValue(pluginId, key) !== null;
    },
    require(key) {
      const value = getPluginInputValue(pluginId, key);
      if (value === null || value.trim() === "") {
        throw new Error(`Plugin input '${key}' is not configured.`);
      }
      return value;
    },
  };
}
