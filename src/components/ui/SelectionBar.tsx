import { Button, Loader } from "@mantine/core";
import type { ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { useBodyFlag } from "../../lib/use-body-flag";
import { IconButton } from "../IconButton";
import { CloseIcon, type AppIcon } from "./icons";

interface SelectionBarProps {
  /** Labeled actions: a bottom bar below 768px, inline in the bar above. */
  actions: ReactNode;
  clearDisabled: boolean;
  label: string;
  onClear: () => void;
  onExit: () => void;
  onSelectAll: () => void;
  selectAllDisabled: boolean;
  selectAllPending: boolean;
}

/**
 * Replaces a page's app bar while items are selected. On phones its actions
 * sit in a bottom bar in place of the navigation.
 */
export function SelectionBar({
  actions,
  clearDisabled,
  label,
  onClear,
  onExit,
  onSelectAll,
  selectAllDisabled,
  selectAllPending,
}: SelectionBarProps) {
  const { t } = useTranslation();
  useBodyFlag("selection-bar", true);

  return (
    <div aria-label={label} className="norea-selection-bar" role="toolbar">
      <IconButton label={t("selection.exit")} onClick={onExit} size="lg">
        <CloseIcon />
      </IconButton>
      <span aria-live="polite" className="norea-selection-bar-count">
        {label}
      </span>
      <Button
        disabled={selectAllDisabled}
        leftSection={selectAllPending ? <Loader size="xs" /> : undefined}
        onClick={onSelectAll}
        variant="subtle"
      >
        {t("selection.selectAll")}
      </Button>
      <Button disabled={clearDisabled} onClick={onClear} variant="subtle">
        {t("common.clear")}
      </Button>
      <div className="norea-selection-bar-actions">{actions}</div>
    </div>
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
