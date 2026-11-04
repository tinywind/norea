import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { CheckIcon } from "./ui/icons";

type ChipTone = "accent" | "danger";

type ChipButtonProps = Omit<ComponentPropsWithoutRef<"button">, "children" | "type"> & {
  children: ReactNode;
  /** Leading icon of an unselected or action chip; a selected chip shows a check instead. */
  icon?: ReactNode;
  /** Pressed state of a toggle chip. Leave it out for a chip that runs an action. */
  selected?: boolean;
  /** Soft fill for an action chip that reports an active state or a failure. */
  tone?: ChipTone;
  trailingIcon?: ReactNode;
};

/**
 * The app's one chip: a 2rem pill for filter toggles, scope choices and
 * chip-shaped actions. Selected and toned chips take a soft fill without a
 * border; the rest sit on the surface with the strong rule. On touch screens
 * a transparent pseudo-element grows the hit area to 44px instead of the chip.
 */
export function ChipButton({
  children,
  className,
  icon,
  selected,
  tone,
  trailingIcon,
  ...props
}: ChipButtonProps) {
  const leading = selected ? <CheckIcon /> : icon;
  return (
    <button
      {...props}
      aria-pressed={selected}
      className={`norea-chip norea-state-layer${className ? ` ${className}` : ""}`}
      data-leading={leading ? "true" : undefined}
      data-tone={tone}
      data-trailing={trailingIcon ? "true" : undefined}
      type="button"
    >
      {leading}
      <span className="norea-chip-label">{children}</span>
      {trailingIcon}
    </button>
  );
}
