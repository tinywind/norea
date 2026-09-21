import { useMemo, useState, type ChangeEvent } from "react";
import {
  PasswordInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { useTranslation } from "../i18n";
import {
  deletePluginInputValue,
  getPluginInputValue,
  setPluginInputValue,
  type PluginInputDefinition,
} from "../lib/plugins/inputs";
import type { Plugin } from "../lib/plugins/types";
import {
  SettingsFieldRow,
  SettingsInlineControls,
} from "./SettingsPrimitives";
import { TextButton } from "./TextButton";

type PluginSettingValue = string | boolean;

interface PluginSettingsEditorProps {
  plugin: Plugin;
  onSaved?: () => void;
}

function inputSchema(plugin: Plugin): Record<string, unknown> {
  return plugin.pluginInputs ?? plugin.pluginSettings ?? {};
}

function asSettingDefinition(value: unknown): PluginInputDefinition | null {
  if (value === null || typeof value !== "object") return null;
  const setting = value as Record<string, unknown>;
  return {
    value:
      typeof setting.value === "boolean" || typeof setting.value === "string"
        ? setting.value
        : "",
    label: typeof setting.label === "string" ? setting.label : undefined,
    type: typeof setting.type === "string" ? setting.type : undefined,
    placeholder:
      typeof setting.placeholder === "string" ? setting.placeholder : undefined,
    required: typeof setting.required === "boolean" ? setting.required : undefined,
    private: typeof setting.private === "boolean" ? setting.private : undefined,
    options: Array.isArray(setting.options)
      ? setting.options
          .map((option) => {
            if (option === null || typeof option !== "object") return null;
            const entry = option as Record<string, unknown>;
            return typeof entry.label === "string" &&
              typeof entry.value === "string"
              ? { label: entry.label, value: entry.value }
              : null;
          })
          .filter((option): option is { label: string; value: string } =>
            option !== null,
          )
      : undefined,
  };
}

function inputType(definition: PluginInputDefinition): string {
  return definition.type?.toLowerCase() ?? "";
}

function isPasswordSetting(
  key: string,
  label: string,
  definition: PluginInputDefinition,
): boolean {
  if (definition.private || inputType(definition) === "password") return true;
  const text = `${key} ${label}`.toLowerCase();
  return text.includes("password") || text.includes("token");
}

function initialValue(
  pluginId: string,
  key: string,
  definition: PluginInputDefinition,
): PluginSettingValue {
  const stored = getPluginInputValue(pluginId, key);
  if (inputType(definition) === "switch") {
    if (stored === "true") return true;
    if (stored === "false") return false;
    return definition.value === true;
  }
  return stored ?? String(definition.value ?? "");
}

export function PluginSettingsEditor({
  plugin,
  onSaved,
}: PluginSettingsEditorProps) {
  const { t } = useTranslation();
  const settings = useMemo(
    () =>
      Object.entries(inputSchema(plugin))
        .map(([key, raw]) => {
          const definition = asSettingDefinition(raw);
          return definition ? { key, definition } : null;
        })
        .filter((entry): entry is {
          key: string;
          definition: PluginInputDefinition;
        } => entry !== null),
    [plugin],
  );
  const [values, setValues] = useState<Record<string, PluginSettingValue>>(
    () =>
      Object.fromEntries(
        settings.map(({ key, definition }) => [
          key,
          initialValue(plugin.id, key, definition),
        ]),
      ),
  );

  if (settings.length === 0) {
    return <Text c="dimmed">{t("pluginSettings.empty")}</Text>;
  }

  return (
    <Stack className="norea-plugin-settings-editor" gap={0}>
      {settings.map(({ key, definition }) => {
        const label = definition.label ?? key;
        const value = values[key] ?? "";

        if (inputType(definition) === "switch") {
          return (
            <SettingsFieldRow key={key} label={label}>
              <Switch
                aria-label={label}
                checked={value === true}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setValues((current) => ({
                    ...current,
                    [key]: checked,
                  }));
                }}
              />
            </SettingsFieldRow>
          );
        }

        const inputProps = {
          "aria-label": label,
          placeholder: definition.placeholder,
          required: definition.required,
          value: String(value),
          onChange: (event: ChangeEvent<HTMLInputElement>) => {
            const nextValue = event.currentTarget.value;
            setValues((current) => ({
              ...current,
              [key]: nextValue,
            }));
          },
        };

        if (inputType(definition) === "select" && definition.options?.length) {
          return (
            <SettingsFieldRow key={key} label={label}>
              <Select
                aria-label={label}
                data={definition.options}
                placeholder={definition.placeholder}
                required={definition.required}
                value={String(value)}
                onChange={(nextValue) => {
                  setValues((current) => ({
                    ...current,
                    [key]: nextValue ?? "",
                  }));
                }}
              />
            </SettingsFieldRow>
          );
        }

        return isPasswordSetting(key, label, definition) ? (
          <SettingsFieldRow key={key} label={label}>
            <PasswordInput {...inputProps} />
          </SettingsFieldRow>
        ) : (
          <SettingsFieldRow key={key} label={label}>
            <TextInput {...inputProps} />
          </SettingsFieldRow>
        );
      })}
      <SettingsFieldRow>
        <SettingsInlineControls>
          <TextButton
            onClick={() => {
              for (const [key, value] of Object.entries(values)) {
                if (value === "") {
                  deletePluginInputValue(plugin.id, key);
                } else {
                  setPluginInputValue(plugin.id, key, String(value));
                }
              }
              onSaved?.();
            }}
          >
            {t("common.save")}
          </TextButton>
        </SettingsInlineControls>
      </SettingsFieldRow>
    </Stack>
  );
}
