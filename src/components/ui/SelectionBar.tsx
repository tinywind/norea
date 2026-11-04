import { Button, Loader } from "@mantine/core";
import { useId, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { useBodyFlag } from "../../lib/use-body-flag";
import { PageHeader } from "../AppFrame";
import { type AppIcon } from "./icons";

interface SelectionBarProps {
  /** Labeled actions: a bottom bar below 768px, inline in the bar above. */
  actions: ReactNode;
  /** Every selectable item is selected, so the toggle offers to deselect them all. */
  allSelected: boolean;
  /** The page header's sub-row, kept so selecting does not move the content. */
  below?: ReactNode;
  /** A one-line usage hint shown on its own line under the bar. */
  hint?: string;
  label: string;
  onDeselectAll: () => void;
  /** Leaves selection mode; selecting nothing keeps the bar open. */
  onExit: () => void;
  onSelectAll: () => void;
  selectAllDisabled: boolean;
  selectAllPending: boolean;
}

/**
 * The page header in its selection state: it takes the app bar's place at the
 * same height and padding, with close where back sits and the count where the
 * title sits, so entering or leaving selection never moves the content. On
 * phones its actions sit in a bottom bar in place of the navigation.
 */
export function SelectionBar({
  actions,
  allSelected,
  below,
  hint,
  label,
  onDeselectAll,
  onExit,
  onSelectAll,
  selectAllDisabled,
  selectAllPending,
}: SelectionBarProps) {
  const { t } = useTranslation();
  const hintId = useId();
  useBodyFlag("selection-bar", true);

  return (
    <PageHeader
      actions={
        <>
          {allSelected ? (
            <Button onClick={onDeselectAll} variant="subtle">
              {t("selection.deselectAll")}
            </Button>
          ) : (
            <Button
              disabled={selectAllDisabled}
              leftSection={selectAllPending ? <Loader size="xs" /> : undefined}
              onClick={onSelectAll}
              variant="subtle"
            >
              {t("selection.selectAll")}
            </Button>
          )}
          <div className="norea-selection-bar-actions">{actions}</div>
        </>
      }
      aria-describedby={hint ? hintId : undefined}
      aria-label={label}
      backIcon="close"
      backLabel={t("selection.exit")}
      below={below}
      className="norea-selection-bar"
      onBack={onExit}
      role="toolbar"
      title={
        <>
          <span aria-live="polite" className="norea-selection-bar-count">
            {label}
          </span>
          {hint ? (
            <span className="norea-selection-bar-hint" id={hintId} role="status">
              {hint}
            </span>
          ) : null}
        </>
      }
      titleElement="span"
    />
  );
}

interface SelectionActionProps {
  disabled?: boolean;
  icon: AppIcon;
  label: string;
  onClick?: () => void;
}

/** A labeled selection action: icon over label on phones, inline above. */
export function SelectionAction({
  disabled,
  icon: Icon,
  label,
  onClick,
  ...props
}: SelectionActionProps) {
  return (
    <Button
      className="norea-selection-action"
      disabled={disabled}
      leftSection={<Icon size="1.25rem" />}
      onClick={onClick}
      variant="subtle"
      {...props}
    >
      {label}
    </Button>
  );
}
