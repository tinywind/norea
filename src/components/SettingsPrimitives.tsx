import { Collapse, Slider, Text } from "@mantine/core";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "../i18n";
import { settingsRowSelector, useSettingsRevealStore } from "./settings/settings-reveal";
import { ConsolePanel } from "./ConsolePrimitives";
import { IconButton } from "./IconButton";
import { ChevronDownIcon, InfoIcon } from "./ui/icons";

/** Longer descriptions move behind the row's info toggle to keep one short line. */
const INLINE_DESCRIPTION_MAX_LENGTH = 90;

interface SettingsSectionProps {
  children: ReactNode;
  description?: string;
  /** Omit when a surrounding tab or sheet already names the section. */
  title?: string;
}

interface SettingsFieldRowProps {
  children?: ReactNode;
  description?: string;
  /** Inline error for this row; async outcomes also show a notification. */
  error?: string | null;
  label?: string;
  layout?: "inline" | "stacked";
  /** Inline status for this row, such as progress or a required restart. */
  status?: string | null;
}

interface SettingsInlineControlsProps {
  children: ReactNode;
}

export function SettingsSection({
  children,
  description,
  title,
}: SettingsSectionProps) {
  return (
    <ConsolePanel
      className="norea-settings-group"
      title={
        title ? (
          <>
            <Text className="norea-settings-group-title">{title}</Text>
            {description ? (
              <Text className="norea-settings-group-description">{description}</Text>
            ) : null}
          </>
        ) : undefined
      }
    >
      <div className="norea-settings-group-body">{children}</div>
    </ConsolePanel>
  );
}

export function SettingsFieldRow({
  children,
  description,
  error,
  label,
  layout = "inline",
  status,
}: SettingsFieldRowProps) {
  const { t } = useTranslation();
  const descriptionId = useId();
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const hasCopy = Boolean(label || description || error || status);
  const collapsibleDescription = Boolean(
    label && description && description.length > INLINE_DESCRIPTION_MAX_LENGTH,
  );

  return (
    <div
      className="norea-settings-form-row"
      data-copy={hasCopy ? "visible" : "empty"}
      data-layout={layout}
      data-settings-label={label}
    >
      {hasCopy ? (
        <div className="norea-settings-form-copy">
          {label ? (
            <div className="norea-settings-form-label-row">
              <Text className="norea-settings-form-label">{label}</Text>
              {collapsibleDescription ? (
                <IconButton
                  active={descriptionOpen}
                  aria-controls={descriptionId}
                  aria-expanded={descriptionOpen}
                  className="norea-settings-form-info"
                  label={t("settings.row.moreInfo", { label })}
                  onClick={() => setDescriptionOpen((open) => !open)}
                >
                  <InfoIcon />
                </IconButton>
              ) : null}
            </div>
          ) : null}
          {description ? (
            <Text
              className="norea-settings-form-description"
              hidden={collapsibleDescription && !descriptionOpen}
              id={descriptionId}
            >
              {description}
            </Text>
          ) : null}
          {status ? (
            <Text className="norea-settings-form-status" role="status">
              {status}
            </Text>
          ) : null}
          {error ? (
            <Text className="norea-settings-form-error" role="alert">
              {error}
            </Text>
          ) : null}
        </div>
      ) : null}
      {children ? (
        <div className="norea-settings-form-control">{children}</div>
      ) : null}
    </div>
  );
}

interface SettingsAdvancedGroupProps {
  children: ReactNode;
  /** Opens the group, for example when a row inside needs input or shows an error. */
  forceOpen?: boolean;
  /** Defaults to "Advanced". */
  label?: string;
}

/** A collapsed group for rows most people never change. */
export function SettingsAdvancedGroup({
  children,
  forceOpen = false,
  label,
}: SettingsAdvancedGroupProps) {
  const { t } = useTranslation();
  const bodyId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [opened, setOpened] = useState(forceOpen);
  const revealTarget = useSettingsRevealStore((state) => state.target);

  useEffect(() => {
    if (forceOpen) setOpened(true);
  }, [forceOpen]);

  useEffect(() => {
    const root = rootRef.current;
    if (!revealTarget || !root) return;
    if (root.matches(settingsRowSelector(revealTarget.label)) || root.querySelector(settingsRowSelector(revealTarget.label))) {
      setOpened(true);
    }
  }, [revealTarget]);

  return (
    <div
      className="norea-settings-advanced"
      data-expanded={opened}
      data-settings-label={label}
      ref={rootRef}
    >
      <button
        aria-controls={bodyId}
        aria-expanded={opened}
        className="norea-settings-advanced-toggle norea-state-layer"
        onClick={() => setOpened((open) => !open)}
        type="button"
      >
        <span className="norea-settings-advanced-label">
          {label ?? t("settings.advanced")}
        </span>
        <ChevronDownIcon className="norea-settings-advanced-chevron" />
      </button>
      <Collapse expanded={opened} id={bodyId} keepMountedMode="display-none">
        <div className="norea-settings-advanced-body">{children}</div>
      </Collapse>
    </div>
  );
}

interface SettingsSliderProps {
  description?: string;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  value: number;
}

/** A percent slider row with its current value beside it. */
export function SettingsPercentSlider({
  description,
  label,
  max,
  min,
  onChange,
  step,
  value,
}: SettingsSliderProps) {
  return (
    <SettingsFieldRow label={label} description={description}>
      <div className="norea-settings-slider-control">
        <Text className="norea-settings-slider-value">{value}%</Text>
        <Slider
          thumbLabel={label}
          value={value}
          min={min}
          max={max}
          step={step}
          label={(next) => `${next}%`}
          marks={[
            { value: min, label: `${min}%` },
            { value: max, label: `${max}%` },
          ]}
          onChange={onChange}
        />
      </div>
    </SettingsFieldRow>
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
