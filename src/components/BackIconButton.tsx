import { type MouseEventHandler } from "react";
import { useTranslation } from "../i18n";
import { IconButton } from "./IconButton";

interface BackIconButtonProps {
  className?: string;
  label?: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
}

export function BackIconButton({
  className,
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
      label={resolvedLabel}
      onClick={onClick}
      size="sm"
      type="button"
    >
      <BackIcon />
    </IconButton>
  );
}

function BackIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M15 18l-6-6 6-6" />
      <path d="M9 12h11" />
    </svg>
  );
}
