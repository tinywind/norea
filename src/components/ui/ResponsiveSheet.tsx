import { Box, Drawer, Modal } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import type { ReactNode } from "react";
import { useOverlayBackNavigation } from "../../lib/android-back-navigation";

interface ResponsiveSheetProps {
  children: ReactNode;
  /** Added to the sheet surface, for a caller that sizes its own layout. */
  className?: string;
  /**
   * From 768px up: a centered modal, or a 24rem drawer on the right edge
   * that keeps the page content beside it visible.
   */
  desktopVariant?: "modal" | "side";
  /** Below 768px, a full-screen dialog instead of a bottom sheet (long forms). */
  fullScreenOnPhone?: boolean;
  /** Stays pinned to the bottom edge while the body scrolls. */
  footer?: ReactNode;
  onClose: () => void;
  opened: boolean;
  title: ReactNode;
}

/**
 * A bottom sheet below 768px and a centered modal (or right side drawer) from
 * 768px up. Android back closes it while open; Mantine owns the focus trap and
 * focus return.
 */
export function ResponsiveSheet({
  children,
  className,
  desktopVariant = "modal",
  fullScreenOnPhone = false,
  footer,
  onClose,
  opened,
  title,
}: ResponsiveSheetProps) {
  const desktop = useMediaQuery("(min-width: 768px)", undefined, {
    getInitialValueInEffect: false,
  });
  useOverlayBackNavigation(opened, onClose);

  const classNames = {
    body: footer
      ? "norea-responsive-sheet-body norea-responsive-sheet-body--with-footer"
      : "norea-responsive-sheet-body",
    content: [
      "norea-responsive-sheet",
      desktop
        ? desktopVariant === "side"
          ? "norea-responsive-sheet--side"
          : undefined
        : fullScreenOnPhone
          ? "norea-responsive-sheet--full"
          : "norea-responsive-sheet--drawer",
      className,
    ]
      .filter(Boolean)
      .join(" "),
    header: "norea-responsive-sheet-header",
  };
  const body = (
    <>
      {children}
      {footer ? <Box className="norea-responsive-sheet-footer">{footer}</Box> : null}
    </>
  );

  if (desktop && desktopVariant === "side") {
    return (
      <Drawer
        classNames={classNames}
        opened={opened}
        onClose={onClose}
        position="right"
        size="24rem"
        title={title}
      >
        {body}
      </Drawer>
    );
  }

  return desktop || fullScreenOnPhone ? (
    <Modal
      centered
      classNames={classNames}
      fullScreen={!desktop}
      opened={opened}
      onClose={onClose}
      title={title}
    >
      {body}
    </Modal>
  ) : (
    <Drawer
      classNames={classNames}
      opened={opened}
      onClose={onClose}
      position="bottom"
      title={title}
    >
      {body}
    </Drawer>
  );
}
