import { Text } from "@mantine/core";
import type { ReactNode } from "react";
import { ConsolePanel } from "./ConsolePrimitives";

interface SettingsSectionProps {
  children: ReactNode;
  title: string;
}

interface SettingsFieldRowProps {
  children: ReactNode;
  description?: string;
  label?: string;
  layout?: "inline" | "stacked";
}

interface SettingsInlineControlsProps {
  children: ReactNode;
}

export function SettingsSection({
  children,
  title,
}: SettingsSectionProps) {
  return (
    <ConsolePanel
      className="norea-settings-group"
      title={<Text className="norea-settings-group-title">{title}</Text>}
    >
      <div className="norea-settings-group-body">{children}</div>
    </ConsolePanel>
  );
}

export function SettingsFieldRow({
  children,
  description,
  label,
  layout = "inline",
}: SettingsFieldRowProps) {
  const hasCopy = Boolean(label || description);

  return (
    <div
      className="norea-settings-form-row"
      data-copy={hasCopy ? "visible" : "empty"}
      data-layout={layout}
    >
      {hasCopy ? (
        <div className="norea-settings-form-copy">
          {label ? (
            <Text className="norea-settings-form-label">{label}</Text>
          ) : null}
          {description ? (
            <Text className="norea-settings-form-description">{description}</Text>
          ) : null}
        </div>
      ) : null}
      <div className="norea-settings-form-control">{children}</div>
    </div>
  );
}

export function SettingsInlineControls({
  children,
}: SettingsInlineControlsProps) {
  return <div className="norea-settings-inline-controls">{children}</div>;
}

export function SettingsWideField({ children }: { children: ReactNode }) {
  return <div className="norea-settings-wide-field">{children}</div>;
}
