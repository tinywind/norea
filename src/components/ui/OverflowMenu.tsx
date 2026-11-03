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
export function OverflowMenu({ items, label, trigger }: OverflowMenuProps) {
  return (
    <Menu position="bottom-end" returnFocus shadow="md" withinPortal>
      <Menu.Target>
        {trigger ?? (
          <IconButton label={label} size="lg">
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

