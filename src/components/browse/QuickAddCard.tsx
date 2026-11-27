import { Loader, Menu } from "@mantine/core";
import { useState, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { useLongPress } from "../../lib/use-long-press";
import { OverflowIcon } from "../ui/icons";

const LONG_PRESS_MS = 450;

interface QuickAddCardProps {
  /** The cover and title inside the card's open button. */
  children: ReactNode;
  /** The open button's class, so each grid keeps its own card look. */
  className: string;
  disabled?: boolean;
  inLibrary: boolean;
  name: string;
  onAdd: () => void;
  onOpen: () => void;
  /** Adds "Select" to the long-press menu, for a grid with selection mode. */
  onSelect?: () => void;
  pending: boolean;
  selected?: boolean;
}

/** A catalog card with a shared action menu on tap, long-press or right-click. */
export function QuickAddCard({
  children,
  className,
  disabled = false,
  inLibrary,
  name,
  onAdd,
  onOpen,
  onSelect,
  pending,
  selected,
}: QuickAddCardProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const longPress = useLongPress(disabled ? undefined : () => setMenuOpen(true), LONG_PRESS_MS);

  const openMenu = (event: MouseEvent) => {
    event.preventDefault();
    if (!disabled) setMenuOpen(true);
  };

  return (
    <div className="norea-quick-add-card" data-pending={pending ? "true" : undefined}>
      <button
        {...longPress.handlers}
        aria-busy={pending || undefined}
        className={className}
        data-pressing={longPress.pressing ? "true" : undefined}
        data-selected={selected}
        disabled={disabled}
        onClick={() => {
          if (longPress.consumeFired()) return;
          onOpen();
        }}
        onContextMenu={openMenu}
        type="button"
      >
        {children}
      </button>
      {pending ? (
        <span aria-label={t("quickAdd.adding", { name })} className="norea-quick-add-pending" role="status">
          <Loader color="currentColor" size="sm" />
        </span>
      ) : null}
      <Menu onChange={setMenuOpen} opened={menuOpen} position="bottom-end" returnFocus withinPortal>
        <Menu.Target>
          <button
            aria-label={t("quickAdd.actionsNamed", { name })}
            className="norea-quick-add-button norea-state-layer"
            disabled={disabled || pending}
            title={t("common.more")}
            type="button"
          >
            <OverflowIcon />
          </button>
        </Menu.Target>
        <Menu.Dropdown aria-label={name}>
          <Menu.Item disabled={inLibrary || pending} onClick={onAdd}>
            {inLibrary ? t("quickAdd.inLibrary") : t("quickAdd.add")}
          </Menu.Item>
          <Menu.Item onClick={onOpen}>{t("quickAdd.open")}</Menu.Item>
          {onSelect ? <Menu.Item onClick={onSelect}>{t("library.selection.start")}</Menu.Item> : null}
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}
