import { Alert, type AlertProps } from "@mantine/core";
import type { ReactNode } from "react";
import type { StatusRoleName } from "../../theme/palette-roles";
import { CheckIcon, InfoIcon, WarningIcon } from "./icons";

export interface StatusAlertProps extends Omit<AlertProps, "color" | "variant"> {
  color?: StatusRoleName;
  trailing?: ReactNode;
}

function defaultAlertIcon(color: StatusRoleName): ReactNode {
  if (color === "ok") return <CheckIcon size="1.25rem" />;
  if (color === "info") return <InfoIcon size="1.25rem" />;
  return <WarningIcon size="1.25rem" />;
}

/** Shared inline alert with a soft semantic surface, hairline border, and leading status icon. */
export function StatusAlert({
  children,
  className,
  color = "danger",
  icon,
  radius,
  trailing,
  ...rest
}: StatusAlertProps) {
  const resolvedIcon = icon === undefined ? defaultAlertIcon(color) : icon;
  return (
    <Alert
      {...rest}
      className={className ? `norea-alert ${className}` : "norea-alert"}
      color={color}
      data-tone={color}
      icon={resolvedIcon}
      radius={radius ?? "md"}
      variant="light"
    >
      {trailing ? (
        <div className="norea-alert-trailing-row">
          <div className="norea-alert-trailing-copy">{children}</div>
          <div className="norea-alert-trailing-actions">{trailing}</div>
        </div>
      ) : (
        children
      )}
    </Alert>
  );
}
