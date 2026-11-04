import { type MouseEventHandler } from "react";
import { useTranslation } from "../i18n";
import { IconButton } from "./IconButton";
import { BackIcon, CloseIcon } from "./ui/icons";

interface BackIconButtonProps {
  className?: string;
  disabled?: boolean;
  /** `close` leaves a mode, such as selection, rather than the page. */
  icon?: "back" | "close";
  label?: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
}

/** The single leading affordance: page headers, the reader bar and sub-panels share it. */
export function BackIconButton({
  className,
  disabled,
  icon = "back",
  label,
  onClick,
}: BackIconButtonProps) {
  const { t } = useTranslation();
  const resolvedLabel = label ?? t("common.back");

  return (
    <IconButton
      className={
        className
          ? `norea-back-icon-button ${className}`
          : "norea-back-icon-button"
      }
      disabled={disabled}
      label={resolvedLabel}
      onClick={onClick}
      size="sm"
      type="button"
    >
      {icon === "close" ? <CloseIcon /> : <BackIcon />}
    </IconButton>
  );
}
