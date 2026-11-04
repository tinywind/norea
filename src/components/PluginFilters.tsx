import {
  Checkbox,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { CheckIcon, MinusIcon } from "./ui/icons";
import { ChipButton } from "./ChipButton";
import { useTranslation } from "../i18n";
import { FilterTypes, type Filters } from "../lib/plugins/filterTypes";

/**
 * Resolved filter values keyed by filter id. Shape matches
 * `FilterToValues<Filters>` — each entry carries `{ type, value }`.
 * Plain object so React state can do shallow-equal comparisons.
 */
export type ResolvedFilterValues = Record<
  string,
  { type: FilterTypes; value: unknown }
>;

interface PluginFiltersProps {
  schema: Filters;
  values: ResolvedFilterValues;
  onChange: (next: ResolvedFilterValues) => void;
}

function emptyFilterValue(def: Filters[string]): unknown {
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

type ExcludableState = "" | "+" | "-";

const NEXT_EXCLUDABLE_STATE: Record<ExcludableState, ExcludableState> = {
  "": "+",
  "+": "-",
  "-": "",
};

/** The state a tri-state option chip moves to when tapped: off, include, exclude, off. */
export function nextExcludableState(state: ExcludableState): ExcludableState {
  return NEXT_EXCLUDABLE_STATE[state];
}

function setEntry(
  values: ResolvedFilterValues,
  key: string,
  type: FilterTypes,
  value: unknown,
): ResolvedFilterValues {
  return { ...values, [key]: { type, value } };
}

export function PluginFilters({
  schema,
  values,
  onChange,
}: PluginFiltersProps) {
  const { t } = useTranslation();
  const entries = Object.entries(schema);
  if (entries.length === 0) {
    return <Text c="dimmed">{t("pluginFilters.empty")}</Text>;
  }

  return (
    <Stack gap="md">
      {entries.map(([key, def]) => {
        const current = values[key];
        switch (def.type) {
          case FilterTypes.TextInput: {
            const v = (current?.value ?? emptyFilterValue(def)) as string;
            return (
              <TextInput
                key={key}
                label={def.label}
                value={v}
                onChange={(event) =>
                  onChange(
                    setEntry(values, key, def.type, event.currentTarget.value),
                  )
                }
              />
            );
          }
          case FilterTypes.Switch: {
            const v = (current?.value ?? emptyFilterValue(def)) as boolean;
            return (
              <Switch
                key={key}
                label={def.label}
                checked={v}
                onChange={(event) =>
                  onChange(
                    setEntry(
                      values,
                      key,
                      def.type,
                      event.currentTarget.checked,
                    ),
                  )
                }
              />
            );
          }
          case FilterTypes.Picker: {
            const v = (current?.value ?? emptyFilterValue(def)) as string;
            return (
              <Select
                key={key}
                label={def.label}
                value={v}
                data={def.options.map((o) => ({
                  value: o.value,
                  label: o.label,
                }))}
                onChange={(next) =>
                  onChange(setEntry(values, key, def.type, next ?? ""))
                }
                clearable
              />
            );
          }
          case FilterTypes.CheckboxGroup: {
            const v = (current?.value ?? emptyFilterValue(def)) as string[];
            return (
              <Stack gap={4} key={key}>
                <Text size="sm" fw="var(--norea-weight-medium)">
                  {def.label}
                </Text>
                <Checkbox.Group
                  value={v}
                  onChange={(next) =>
                    onChange(setEntry(values, key, def.type, next))
                  }
                >
                  <Stack gap={4}>
                    {def.options.map((o) => (
                      <Checkbox
                        key={o.value}
                        value={o.value}
                        label={o.label}
                      />
                    ))}
                  </Stack>
                </Checkbox.Group>
              </Stack>
            );
          }
          case FilterTypes.ExcludableCheckboxGroup: {
            const v =
              (current?.value as
                | { include?: string[]; exclude?: string[] }
                | undefined) ??
              (emptyFilterValue(def) as {
                include?: string[];
                exclude?: string[];
              });
            const include = v.include ?? [];
            const exclude = v.exclude ?? [];

            const setOption = (option: string, state: ExcludableState) => {
              const nextInclude = include.filter((x) => x !== option);
              const nextExclude = exclude.filter((x) => x !== option);
              if (state === "+") nextInclude.push(option);
              else if (state === "-") nextExclude.push(option);
              onChange(
                setEntry(values, key, def.type, {
                  include: nextInclude,
                  exclude: nextExclude,
                }),
              );
            };
            const stateLabels: Record<ExcludableState, string> = {
              "": t("pluginFilters.off"),
              "+": t("pluginFilters.include"),
              "-": t("pluginFilters.exclude"),
            };
            const labelId = `norea-plugin-filter-${key}`;

            return (
              <Stack gap={4} key={key}>
                <Text fw="var(--norea-weight-medium)" id={labelId} size="sm">
                  {def.label}
                </Text>
                <Text c="dimmed" size="xs">
                  {t("pluginFilters.triStateHint")}
                </Text>
                <div aria-labelledby={labelId} className="norea-filter-chips" role="group">
                  {def.options.map((o) => {
                    const state: ExcludableState = include.includes(o.value)
                      ? "+"
                      : exclude.includes(o.value)
                        ? "-"
                        : "";
                    return (
                      <ChipButton
                        aria-label={t("pluginFilters.optionState", {
                          option: o.label,
                          state: stateLabels[state],
                        })}
                        data-state={state === "+" ? "include" : state === "-" ? "exclude" : "off"}
                        icon={state === "+" ? <CheckIcon /> : state === "-" ? <MinusIcon /> : undefined}
                        key={o.value}
                        onClick={() => setOption(o.value, nextExcludableState(state))}
                        tone={state === "+" ? "accent" : state === "-" ? "danger" : undefined}
                      >
                        {o.label}
                      </ChipButton>
                    );
                  })}
                </div>
              </Stack>
            );
          }
          default:
            return null;
        }
      })}
    </Stack>
  );
}
