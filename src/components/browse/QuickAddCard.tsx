import { Loader, Menu } from "@mantine/core";
import { useState, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { useLongPress } from "../../lib/use-long-press";
import { AddToLibraryIcon, InLibraryIcon, OpenWorkIcon, PlusIcon } from "../ui/icons";

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
  pending: boolean;
  selected?: boolean;
}

/**
 * A cover-grid card with RD8 quick add. A tap opens the work. Long-press,
 * right-click or the context-menu key opens "Add to library" and "Open"; with
 * a fine pointer or keyboard focus, the "+" adds it in one step.
 */
export function QuickAddCard({
  children,
  className,
  disabled = false,
  inLibrary,
  name,
  onAdd,
  onOpen,
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
      {!inLibrary ? (
        <button
          aria-label={t("quickAdd.addNamed", { name })}
          className="norea-quick-add-button norea-state-layer"
          disabled={pending}
          onClick={onAdd}
          title={t("quickAdd.add")}
          type="button"
        >
          <PlusIcon size="1.125rem" />
        </button>
      ) : null}
      {pending ? (
        <span aria-label={t("quickAdd.adding", { name })} className="norea-quick-add-pending" role="status">
          <Loader size="sm" />
        </span>
      ) : null}
      {menuOpen ? (
        <Menu onChange={setMenuOpen} opened position="bottom" withinPortal>
          <Menu.Target>
            <span aria-hidden="true" className="norea-quick-add-anchor" />
          </Menu.Target>
          <Menu.Dropdown aria-label={name}>
            <Menu.Item
              disabled={inLibrary || pending}
              leftSection={inLibrary ? <InLibraryIcon size="1.125rem" /> : <AddToLibraryIcon size="1.125rem" />}
              onClick={onAdd}
            >
              {inLibrary ? t("quickAdd.inLibrary") : t("quickAdd.add")}
            </Menu.Item>
            <Menu.Item leftSection={<OpenWorkIcon size="1.125rem" />} onClick={onOpen}>
              {t("quickAdd.open")}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      ) : null}
    </div>
  );
}
