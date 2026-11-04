import { ActionIcon, Tooltip, type ActionIconProps } from "@mantine/core";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

type IconButtonSize = "sm" | "lg";
type IconButtonTone = "default" | "accent" | "danger" | "success" | "warning";

type IconButtonProps = Omit<
  ActionIconProps,
  "aria-label" | "children" | "size" | "variant"
> &
  Omit<
    ComponentPropsWithoutRef<"button">,
    keyof ActionIconProps | "aria-label" | "children" | "color" | "size"
  > & {
  active?: boolean;
  children: ReactNode;
  label: string;
  size?: IconButtonSize;
  tone?: IconButtonTone;
};

/**
 * An icon-only action with its accessible name shown as a tooltip. D10: it is
 * always borderless (Mantine `subtle` plus the shared state layer), in bars,
 * list rows and cards alike; an action that must read as a button in a
 * content body takes a labeled `Button` instead.
 */
export function IconButton({
  active = false,
  children,
  className,
  label,
  size = "sm",
  title,
  tone = "default",
  ...props
}: IconButtonProps) {
  const classNames = `norea-icon-button norea-icon-button--${size}${
    className ? ` ${className}` : ""
  }`;

  return (
    <Tooltip label={title ?? label} openDelay={350} withArrow>
      <ActionIcon
        aria-label={label}
        className={classNames}
        data-active={active ? "true" : undefined}
        data-tone={tone === "default" ? undefined : tone}
        size={size === "sm" ? 28 : 40}
        title={title ?? label}
        variant="subtle"
        {...props}
      >
        {children}
      </ActionIcon>
    </Tooltip>
  );
}
