import { Menu } from "@mantine/core";
import type { ReactElement } from "react";
import { IconButton } from "../IconButton";
import { OverflowIcon, type AppIcon } from "./icons";

export interface OverflowMenuItem {
  danger?: boolean;
  disabled?: boolean;
  icon?: AppIcon;
  label: string;
  onClick: () => void;
}

interface OverflowMenuProps {
  /** Disables the default icon trigger. */
  disabled?: boolean;
  items: readonly OverflowMenuItem[];
  /** Accessible name of the default "more" trigger. */
  label: string;
  /** Replaces the default icon trigger, for a labeled button. */
  trigger?: ReactElement;
}

/**
 * Occasional and rare actions behind one trigger. Mantine owns arrow-key
 * roving, Escape and returning focus to the trigger.
 */
export function OverflowMenu({ disabled, items, label, trigger }: OverflowMenuProps) {
  return (
    <Menu position="bottom-end" returnFocus withinPortal>
      <Menu.Target>
        {trigger ?? (
          <IconButton disabled={disabled} label={label} size="lg">
            <OverflowIcon />
          </IconButton>
        )}
      </Menu.Target>
      <Menu.Dropdown aria-label={label}>
        {items.map(({ danger, disabled, icon: Icon, label: itemLabel, onClick }) => (
          <Menu.Item
            color={danger ? "danger" : undefined}
            disabled={disabled}
            key={itemLabel}
            leftSection={Icon ? <Icon size="1.125rem" /> : undefined}
            onClick={onClick}
          >
            {itemLabel}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * The element that should take focus back once a dialog opened from `element`
 * closes. A menu item unmounts with its menu, so its menu trigger stands in.
 */
export function getFocusReturnTarget(element: Element | null): HTMLElement | null {
  if (!element || !(element instanceof HTMLElement)) return null;
  const menu = element.closest<HTMLElement>("[role='menu']");
  if (!menu?.id) return element;
  return document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"]`);
}
