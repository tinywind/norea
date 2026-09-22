import { FilterTypes, type Filters } from "./filterTypes";
import type { Plugin } from "./types";
import { isRecord } from "../type-guards";

export const SOURCE_FILTER_STORAGE_PREFIX = "source-filters:";

export type SourceFilterValues = Record<
  string,
  { type: FilterTypes; value: unknown }
>;

function browserLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function emptySourceFilterValue(def: Filters[string]): unknown {
  switch (def.type) {
    case FilterTypes.TextInput:
    case FilterTypes.Picker:
      return "";
    case FilterTypes.Switch:
      return false;
    case FilterTypes.CheckboxGroup:
      return [];
    case FilterTypes.ExcludableCheckboxGroup:
      return { include: [], exclude: [] };
    default:
      return "";
  }
}

export function emptySourceFilterValues(schema: Filters): SourceFilterValues {
  const values: SourceFilterValues = {};
  for (const [key, def] of Object.entries(schema)) {
    values[key] = { type: def.type, value: emptySourceFilterValue(def) };
  }
  return values;
}

function sourceFilterStorageKey(pluginId: string): string {
  return `${SOURCE_FILTER_STORAGE_PREFIX}${pluginId}`;
}

function sourceFilterSchemaSignature(schema: Filters | undefined): unknown {
  if (!schema) return [];
  return Object.entries(schema).map(([key, filter]) => [
    key,
    filter.label,
    filter.type,
    "options" in filter
      ? filter.options.map((option) => [option.label, option.value])
      : [],
  ]);
}

function sourceFilterSignature(plugin: Plugin): string {
  return JSON.stringify({
    filters: sourceFilterSchemaSignature(plugin.filters),
    iconUrl: plugin.iconUrl,
    lang: plugin.lang,
    name: plugin.name,
    url: plugin.url,
    version: plugin.version,
  });
}

function normalizeSourceFilterValue(
  filter: Filters[string],
  value: unknown,
): unknown {
  switch (filter.type) {
    case FilterTypes.TextInput:
      return typeof value === "string" ? value : "";
    case FilterTypes.Switch:
      return typeof value === "boolean" ? value : false;
    case FilterTypes.Picker:
      return typeof value === "string" &&
        filter.options.some((option) => option.value === value)
        ? value
        : "";
    case FilterTypes.CheckboxGroup: {
      const allowed = new Set(filter.options.map((option) => option.value));
      return Array.isArray(value)
        ? value.filter(
            (item): item is string =>
              typeof item === "string" && allowed.has(item),
          )
        : [];
    }
    case FilterTypes.ExcludableCheckboxGroup: {
      const allowed = new Set(filter.options.map((option) => option.value));
      const selected = isRecord(value) ? value : {};
      const normalize = (items: unknown): string[] =>
        Array.isArray(items)
          ? items.filter(
              (item): item is string =>
                typeof item === "string" && allowed.has(item),
            )
          : [];
      return {
        exclude: normalize(selected.exclude),
        include: normalize(selected.include),
      };
    }
    default:
      return "";
  }
}

function normalizeSourceFilters(
  schema: Filters,
  raw: unknown,
): SourceFilterValues {
  const filters = emptySourceFilterValues(schema);
  if (!isRecord(raw)) return filters;

  for (const [key, filter] of Object.entries(schema)) {
    const stored = raw[key];
    if (!isRecord(stored) || stored.type !== filter.type) continue;
    filters[key] = {
      type: filter.type,
      value: normalizeSourceFilterValue(filter, stored.value),
    };
  }
  return filters;
}

interface StoredSourceFilters {
  filters?: unknown;
  signature?: string;
}

export function readSourceFilters(
  plugin: Plugin,
  schema: Filters,
): SourceFilterValues {
  const storage = browserLocalStorage();
  if (!storage) return emptySourceFilterValues(schema);

  const key = sourceFilterStorageKey(plugin.id);
  const raw = storage.getItem(key);
  if (!raw) return emptySourceFilterValues(schema);

  try {
    const parsed = JSON.parse(raw) as StoredSourceFilters;
    if (
      !isRecord(parsed) ||
      parsed.signature !== sourceFilterSignature(plugin)
    ) {
      storage.removeItem(key);
      return emptySourceFilterValues(schema);
    }
    return normalizeSourceFilters(schema, parsed.filters);
  } catch {
    storage.removeItem(key);
    return emptySourceFilterValues(schema);
  }
}

function hasActiveSourceFilters(filters: SourceFilterValues): boolean {
  return Object.values(filters).some((entry) => {
    const value = entry.value;
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === "object") {
      const choices = value as { exclude?: unknown[]; include?: unknown[] };
      return (
        (choices.include?.length ?? 0) > 0 ||
        (choices.exclude?.length ?? 0) > 0
      );
    }
    return (
      value !== null &&
      value !== undefined &&
      value !== "" &&
      value !== false
    );
  });
}

export function writeSourceFilters(
  plugin: Plugin,
  filters: SourceFilterValues,
): void {
  const storage = browserLocalStorage();
  if (!storage) return;

  const key = sourceFilterStorageKey(plugin.id);
  if (!hasActiveSourceFilters(filters)) {
    storage.removeItem(key);
    return;
  }

  storage.setItem(
    key,
    JSON.stringify({
      filters,
      signature: sourceFilterSignature(plugin),
    }),
  );
}

export function clearSourceFilterStorage(): void {
  const storage = browserLocalStorage();
  if (!storage) return;

  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(SOURCE_FILTER_STORAGE_PREFIX)) {
      keys.push(key);
    }
  }

  for (const key of keys) {
    storage.removeItem(key);
  }
}
