import {
  ColorInput,
  Collapse,
  NumberInput,
  PasswordInput,
  Popover,
  Select,
  Slider,
  Switch,
  Text,
  TextInput,
  VisuallyHidden,
} from "@mantine/core";
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "../i18n";
import { settingsRowSelector, useSettingsRevealStore } from "./settings/settings-reveal";
import { IconButton } from "./IconButton";
import { ChevronDownIcon, InfoIcon } from "./ui/icons";

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
  error?: ReactNode;
  label?: string;
  layout?: "inline" | "stacked";
  /** Inline status for this row, such as progress or a required restart. */
  status?: string | null;
}

interface LabelledControlProps {
  "aria-label"?: string;
  "aria-labelledby"?: string;
  label?: ReactNode;
}

/** Form controls that take their accessible name from the row label when they have none. */
const ROW_LABELLED_CONTROLS = new Set<unknown>([
  ColorInput,
  NumberInput,
  PasswordInput,
  Select,
  Switch,
  TextInput,
]);

function labelRowControl(children: ReactNode, labelId: string): ReactNode {
  if (!isValidElement<LabelledControlProps>(children)) return children;
  if (!ROW_LABELLED_CONTROLS.has(children.type)) return children;
  const props = children.props;
  if (props["aria-label"] || props["aria-labelledby"] || props.label) return children;
  return cloneElement(children, { "aria-labelledby": labelId });
}

interface SettingsInlineControlsProps {
  children: ReactNode;
  /** Keeps a short value or small field with its actions on the label's line on phones. */
  compact?: boolean;
}

export function SettingsSection({
  children,
  description,
  title,
}: SettingsSectionProps) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={title ? titleId : undefined}
      className="norea-settings-group"
      data-titled={title ? "true" : undefined}
    >
      {title ? (
        <div className="norea-settings-group-header">
          <Text className="norea-settings-group-title" component="h2" id={titleId}>
            {title}
          </Text>
          {description ? (
            <Text className="norea-settings-group-description">{description}</Text>
          ) : null}
        </div>
      ) : null}
      <div className="norea-settings-group-body">{children}</div>
    </section>
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
  const labelId = useId();
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const hasCopy = Boolean(label || description || error || status);
  const infoDescription = Boolean(label && description);

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
              <Text className="norea-settings-form-label" id={labelId}>
                {label}
              </Text>
              {infoDescription ? (
                <Popover
                  onChange={setDescriptionOpen}
                  opened={descriptionOpen}
                  position="bottom-start"
                  width="min(20rem, calc(100vw - 2rem))"
                  withArrow
                >
                  <Popover.Target>
                    <IconButton
                      active={descriptionOpen}
                      aria-describedby={descriptionId}
                      aria-expanded={descriptionOpen}
                      className="norea-settings-form-info"
                      label={t("settings.row.moreInfo", { label })}
                      onClick={() => setDescriptionOpen((open) => !open)}
                    >
                      <InfoIcon />
                    </IconButton>
                  </Popover.Target>
                  <Popover.Dropdown className="norea-settings-form-tooltip">{description}</Popover.Dropdown>
                </Popover>
              ) : null}
            </div>
          ) : null}
          {infoDescription ? (
            <VisuallyHidden id={descriptionId}>{description}</VisuallyHidden>
          ) : description ? (
            <Text className="norea-settings-form-description" id={descriptionId}>
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
        <div className="norea-settings-form-control">
          {label ? labelRowControl(children, labelId) : children}
        </div>
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
  compact = false,
}: SettingsInlineControlsProps) {
  const items = Children.toArray(children);
  const iconsOnly = items.length > 0 &&
    items.every((child) => isValidElement(child) && child.type === IconButton);
  return (
    <div className="norea-settings-inline-controls" data-compact={compact || iconsOnly ? "true" : undefined}>
      {children}
    </div>
  );
}

export function SettingsWideField({ children }: { children: ReactNode }) {
  return <div className="norea-settings-wide-field">{children}</div>;
}
