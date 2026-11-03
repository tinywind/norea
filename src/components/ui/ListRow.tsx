import type { ComponentPropsWithoutRef, ReactNode } from "react";

interface ListRowProps
  extends Omit<ComponentPropsWithoutRef<"button">, "children" | "title"> {
  leading?: ReactNode;
  selected?: boolean;
  subtitle?: ReactNode;
  title: ReactNode;
  trailing?: ReactNode;
}

/**
 * A list row whose whole surface is one button. Row actions, when a caller
 * needs them, sit beside the row instead of inside it.
 */
export function ListRow({
  className,
  leading,
  selected,
  subtitle,
  title,
  trailing,
  type = "button",
  ...props
}: ListRowProps) {
  return (
    <button
      className={`norea-list-item norea-state-layer${className ? ` ${className}` : ""}`}
      data-selected={selected ? "true" : undefined}
      type={type}
      {...props}
    >
      {leading ? <span className="norea-list-item-leading">{leading}</span> : null}
      <span className="norea-list-item-text">
        <span className="norea-list-item-title">{title}</span>
        {subtitle ? (
          <span className="norea-list-item-subtitle">{subtitle}</span>
        ) : null}
      </span>
      {trailing ? <span className="norea-list-item-trailing">{trailing}</span> : null}
    </button>
  );
}
