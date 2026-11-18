import { isRecord } from "../type-guards";

export const PluginInputTypes = {
  Text: "Text",
  Url: "Url",
  Password: "Password",
  Number: "Number",
  Switch: "Switch",
  Select: "Select",
} as const;

export type PluginInputType =
  (typeof PluginInputTypes)[keyof typeof PluginInputTypes];

const PLUGIN_INPUT_TYPE_SET: ReadonlySet<string> = new Set(
  Object.values(PluginInputTypes),
);

export function isPluginInputType(value: unknown): value is PluginInputType {
  return typeof value === "string" && PLUGIN_INPUT_TYPE_SET.has(value);
}

export type PluginInputValue = string | boolean;

export interface PluginInputOption {
  label: string;
  value: string;
}

export interface PluginInputDefinition {
  value?: PluginInputValue;
  label?: string;
  type?: PluginInputType;
  placeholder?: string;
  required?: boolean;
  private?: boolean;
  options?: PluginInputOption[];
}

function isPluginInputOptionsArray(
  value: unknown,
): value is PluginInputOption[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.label === "string" &&
        typeof entry.value === "string",
    )
  );
}

export function assertPluginInputSchema(
  schema: unknown,
  fieldName: "pluginInputs" | "pluginSettings",
  sourceLabel: string,
): void {
  if (schema === undefined) return;
  if (!isRecord(schema)) {
    throw new Error(`Plugin ${sourceLabel} ${fieldName} must be an object.`);
  }
  for (const [key, entry] of Object.entries(schema)) {
    if (!isRecord(entry)) {
      throw new Error(
        `Plugin ${sourceLabel} ${fieldName}.${key} must be an object.`,
      );
    }
    if (entry.type !== undefined && !isPluginInputType(entry.type)) {
      throw new Error(
        `Plugin ${sourceLabel} ${fieldName}.${key} has unsupported type '${String(entry.type)}'.`,
      );
    }
    if (entry.label !== undefined && typeof entry.label !== "string") {
      throw new Error(
        `Plugin ${sourceLabel} ${fieldName}.${key}.label must be a string.`,
      );
    }
    if (
      entry.placeholder !== undefined &&
      typeof entry.placeholder !== "string"
    ) {
      throw new Error(
        `Plugin ${sourceLabel} ${fieldName}.${key}.placeholder must be a string.`,
      );
    }
    if (entry.required !== undefined && typeof entry.required !== "boolean") {
      throw new Error(
        `Plugin ${sourceLabel} ${fieldName}.${key}.required must be a boolean.`,
      );
    }
    if (entry.private !== undefined && typeof entry.private !== "boolean") {
      throw new Error(
        `Plugin ${sourceLabel} ${fieldName}.${key}.private must be a boolean.`,
      );
    }
    if (entry.options !== undefined && !isPluginInputOptionsArray(entry.options)) {
      throw new Error(
        `Plugin ${sourceLabel} ${fieldName}.${key}.options must be an array of { label, value }.`,
      );
    }
    if (entry.type === PluginInputTypes.Switch) {
      if (entry.value !== undefined && typeof entry.value !== "boolean") {
        throw new Error(
          `Plugin ${sourceLabel} Switch ${fieldName}.${key}.value must be a boolean.`,
        );
      }
      if (entry.options !== undefined) {
        throw new Error(
          `Plugin ${sourceLabel} Switch ${fieldName}.${key} must not declare options.`,
        );
      }
    } else if (entry.type === PluginInputTypes.Select) {
      if (!isPluginInputOptionsArray(entry.options) || entry.options.length === 0) {
        throw new Error(
          `Plugin ${sourceLabel} Select ${fieldName}.${key} must declare non-empty options.`,
        );
      }
      if (entry.value !== undefined && typeof entry.value !== "string") {
        throw new Error(
          `Plugin ${sourceLabel} Select ${fieldName}.${key}.value must be a string.`,
        );
      }
    } else if (entry.value !== undefined && typeof entry.value !== "string") {
      throw new Error(
        `Plugin ${sourceLabel} ${fieldName}.${key}.value must be a string.`,
      );
    }
  }
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

export function getPluginInputPrefix(pluginId: string): string {
  return `${PLUGIN_INPUT_STORAGE_PREFIX}${encodeURIComponent(pluginId)}:`;
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
