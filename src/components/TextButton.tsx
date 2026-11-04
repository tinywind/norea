import { Button, type ButtonProps } from "@mantine/core";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

type TextButtonSize = "sm" | "lg";
type TextButtonTone =
  | "default"
  | "accent"
  | "danger"
  | "error"
  | "success"
  | "warning";

type TextButtonProps = Omit<ButtonProps, "children" | "size"> &
  Omit<
    ComponentPropsWithoutRef<"button">,
    keyof ButtonProps | "children" | "color" | "size"
  > & {
  active?: boolean;
  children: ReactNode;
  size?: TextButtonSize;
  tone?: TextButtonTone;
};

const TONE_COLORS: Record<TextButtonTone, string | undefined> = {
  accent: undefined,
  danger: "danger",
  default: undefined,
  error: "danger",
  success: "ok",
  warning: "warn",
};

function joinClassNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}

/**
 * A compact labeled action for settings and console rows. D10: the default
 * `default` variant is the outline secondary action, `filled` the region's one
 * primary action (`tone="danger"` makes it destructive) and `subtle` a text link.
 */
export function TextButton({
  active = false,
  children,
  className,
  size = "lg",
  tone = "default",
  type = "button",
  variant = "default",
  ...props
}: TextButtonProps) {
  return (
    <Button
      {...props}
      className={joinClassNames(
        "norea-text-button",
        `norea-text-button--${size}`,
        className,
      )}
      color={variant === "default" ? undefined : TONE_COLORS[tone]}
      data-active={active ? "true" : undefined}
      data-tone={tone === "default" ? undefined : tone}
      size="xs"
      type={type}
      variant={variant}
    >
      {children}
    </Button>
  );
}
