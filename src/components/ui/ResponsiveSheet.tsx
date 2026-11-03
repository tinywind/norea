import { Box, Drawer, Modal } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import type { ReactNode } from "react";
import { useOverlayBackNavigation } from "../../lib/android-back-navigation";

interface ResponsiveSheetProps {
  children: ReactNode;
  /** Stays pinned to the bottom edge while the body scrolls. */
  footer?: ReactNode;
  onClose: () => void;
  opened: boolean;
  title: ReactNode;
}

/**
 * A bottom sheet below 768px and a centered modal from 768px up. Android back
 * closes it while open; Mantine owns the focus trap and focus return.
 */
export function ResponsiveSheet({
  children,
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
    content: desktop
      ? "norea-responsive-sheet"
      : "norea-responsive-sheet norea-responsive-sheet--drawer",
    header: "norea-responsive-sheet-header",
  };
  const body = (
    <>
      {children}
      {footer ? <Box className="norea-responsive-sheet-footer">{footer}</Box> : null}
    </>
  );

  return desktop ? (
    <Modal
      centered
      classNames={classNames}
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
