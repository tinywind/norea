/**
 * Filter type system for plugin source screens. Mirrors upstream
 * `src/plugins/types/filterTypes.ts` so existing community plugins
 * declare their filter schema verbatim and the host renders the
 * matching form controls.
 *
 * The host hands the resolved values back to the plugin via
 * `popularNovels(pageNo, { filters })` — see `types.ts`.
 */

import { isRecord } from "../type-guards";

export interface FilterOption {
  readonly label: string;
  readonly value: string;
}

export enum FilterTypes {
  TextInput = "Text",
  Picker = "Picker",
  CheckboxGroup = "Checkbox",
  Switch = "Switch",
  ExcludableCheckboxGroup = "XCheckbox",
}

export const FILTER_TYPE_VALUES: readonly FilterTypes[] = Object.values(FilterTypes);

const FILTER_TYPE_SET: ReadonlySet<string> = new Set(FILTER_TYPE_VALUES);

export function isFilterType(value: unknown): value is FilterTypes {
  return typeof value === "string" && FILTER_TYPE_SET.has(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isFilterOptionsArray(value: unknown): value is FilterOption[] {
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

export function assertPluginFilters(
  filters: unknown,
  sourceLabel: string,
): void {
  if (filters === undefined) return;
  if (!isRecord(filters)) {
    throw new Error(`Plugin ${sourceLabel} filters must be an object.`);
  }
  for (const [key, entry] of Object.entries(filters)) {
    if (!isRecord(entry)) {
      throw new Error(`Plugin ${sourceLabel} filter '${key}' must be an object.`);
    }
    if (typeof entry.label !== "string" || entry.label.trim() === "") {
      throw new Error(
        `Plugin ${sourceLabel} filter '${key}' must declare a non-empty label.`,
      );
    }
    if (!isFilterType(entry.type)) {
      throw new Error(
        `Plugin ${sourceLabel} filter '${key}' has unsupported type '${String(entry.type)}'.`,
      );
    }
    switch (entry.type) {
      case FilterTypes.Switch:
        if (typeof entry.value !== "boolean") {
          throw new Error(
            `Plugin ${sourceLabel} Switch filter '${key}' must have a boolean default value.`,
          );
        }
        break;
      case FilterTypes.TextInput:
        if (typeof entry.value !== "string") {
          throw new Error(
            `Plugin ${sourceLabel} Text filter '${key}' must have a string default value.`,
          );
        }
        break;
      case FilterTypes.Picker:
        if (typeof entry.value !== "string") {
          throw new Error(
            `Plugin ${sourceLabel} Picker filter '${key}' must have a string default value.`,
          );
        }
        if (!isFilterOptionsArray(entry.options)) {
          throw new Error(
            `Plugin ${sourceLabel} Picker filter '${key}' must have a valid options array.`,
          );
        }
        break;
      case FilterTypes.CheckboxGroup:
        if (!isStringArray(entry.value)) {
          throw new Error(
            `Plugin ${sourceLabel} Checkbox filter '${key}' must have a string[] default value.`,
          );
        }
        if (!isFilterOptionsArray(entry.options)) {
          throw new Error(
            `Plugin ${sourceLabel} Checkbox filter '${key}' must have a valid options array.`,
          );
        }
        break;
      case FilterTypes.ExcludableCheckboxGroup:
        if (
          !isRecord(entry.value) ||
          (entry.value.include !== undefined && !isStringArray(entry.value.include)) ||
          (entry.value.exclude !== undefined && !isStringArray(entry.value.exclude))
        ) {
          throw new Error(
            `Plugin ${sourceLabel} XCheckbox filter '${key}' must have an { include?, exclude? } default value.`,
          );
        }
        if (!isFilterOptionsArray(entry.options)) {
          throw new Error(
            `Plugin ${sourceLabel} XCheckbox filter '${key}' must have a valid options array.`,
          );
        }
        break;
    }
  }
}

interface SwitchFilter {
  type: FilterTypes.Switch;
  value: boolean;
}

interface TextFilter {
  type: FilterTypes.TextInput;
  value: string;
}

interface CheckboxFilter {
  type: FilterTypes.CheckboxGroup;
  options: readonly FilterOption[];
  value: string[];
}

interface PickerFilter {
  type: FilterTypes.Picker;
  options: readonly FilterOption[];
  value: string;
}

interface ExcludableCheckboxFilter {
  type: FilterTypes.ExcludableCheckboxGroup;
  options: readonly FilterOption[];
  value: { include?: string[]; exclude?: string[] };
}

export type FilterShape =
  | SwitchFilter
  | TextFilter
  | CheckboxFilter
  | PickerFilter
  | ExcludableCheckboxFilter;

export type Filters = Record<string, { label: string } & FilterShape>;

/** What the plugin receives back in `popularNovels` options. */
export type FilterToValues<
  T extends Record<string, { type: FilterTypes }> | undefined,
> = T extends undefined
  ? undefined
  : {
      [K in keyof T]: Omit<
        { type: NonNullable<T>[K]["type"] } & Filters[string],
        "label" | "options"
      >;
    };

export function isPickerValue(v: FilterShape): v is PickerFilter {
  return v.type === FilterTypes.Picker && typeof v.value === "string";
}

export function isCheckboxValue(v: FilterShape): v is CheckboxFilter {
  return v.type === FilterTypes.CheckboxGroup && Array.isArray(v.value);
}

export function isSwitchValue(v: FilterShape): v is SwitchFilter {
  return v.type === FilterTypes.Switch && typeof v.value === "boolean";
}

export function isTextValue(v: FilterShape): v is TextFilter {
  return v.type === FilterTypes.TextInput && typeof v.value === "string";
}

export function isXCheckboxValue(
  v: FilterShape,
): v is ExcludableCheckboxFilter {
  return (
    v.type === FilterTypes.ExcludableCheckboxGroup &&
    typeof v.value === "object" &&
    !Array.isArray(v.value)
  );
}
