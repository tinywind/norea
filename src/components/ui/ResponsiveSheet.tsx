import { Box, Drawer, Modal } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "../../i18n";
import { useOverlayBackNavigation } from "../../lib/android-back-navigation";

/** Resizable sheets open at this share of the viewport height. */
export const SHEET_DEFAULT_FRACTION = 0.55;
const SHEET_MIN_FRACTION = 0.3;
const SHEET_MAX_FRACTION = 0.9;
/** Releasing a drag below this share dismisses the sheet. */
const SHEET_DISMISS_FRACTION = 0.25;
const SHEET_KEY_STEP = 0.1;
const SHEET_FRACTION_VAR = "--norea-sheet-fraction";

function clampSheetFraction(fraction: number, min = SHEET_MIN_FRACTION): number {
  return Math.min(SHEET_MAX_FRACTION, Math.max(min, fraction));
}

/** The sheet height while a drag moves `dragUpPx` from where it started. */
export function dragSheetFraction(start: number, dragUpPx: number, viewportPx: number): number {
  if (viewportPx <= 0) return start;
  return clampSheetFraction(start + dragUpPx / viewportPx, 0);
}

/** Where a released drag settles, or `null` when it dismisses the sheet. */
export function settleSheetFraction(fraction: number): number | null {
  return fraction < SHEET_DISMISS_FRACTION ? null : clampSheetFraction(fraction);
}

interface SheetResizeHandleProps {
  fraction: number;
  onDismiss: () => void;
  onResize: (fraction: number) => void;
}

function SheetResizeHandle({ fraction, onDismiss, onResize }: SheetResizeHandleProps) {
  const { t } = useTranslation();
  const dragRef = useRef<{
    current: number;
    pointerId: number;
    sheet: HTMLElement | null;
    start: number;
    startY: number;
  } | null>(null);

  const endDrag = (event: PointerEvent<HTMLDivElement>, settle: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const settled = settle ? settleSheetFraction(drag.current) : drag.start;
    drag.sheet?.style.setProperty(SHEET_FRACTION_VAR, String(settled ?? drag.start));
    if (settled === null) onDismiss();
    else onResize(settled);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === "ArrowUp" ? fraction + SHEET_KEY_STEP
      : event.key === "ArrowDown" ? fraction - SHEET_KEY_STEP
      : event.key === "Home" ? SHEET_MAX_FRACTION
      : event.key === "End" ? SHEET_MIN_FRACTION
      : null;
    if (next === null) return;
    event.preventDefault();
    onResize(clampSheetFraction(next));
  };

  return (
    <div
      aria-label={t("sheet.resize")}
      aria-orientation="horizontal"
      aria-valuemax={Math.round(SHEET_MAX_FRACTION * 100)}
      aria-valuemin={Math.round(SHEET_MIN_FRACTION * 100)}
      aria-valuenow={Math.round(fraction * 100)}
      className="norea-responsive-sheet-handle"
      onKeyDown={onKeyDown}
      onPointerCancel={(event) => endDrag(event, false)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        dragRef.current = {
          current: fraction,
          pointerId: event.pointerId,
          sheet: event.currentTarget.closest<HTMLElement>(".norea-responsive-sheet"),
          start: fraction,
          startY: event.clientY,
        };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        drag.current = dragSheetFraction(drag.start, drag.startY - event.clientY, window.innerHeight);
        drag.sheet?.style.setProperty(SHEET_FRACTION_VAR, String(drag.current));
      }}
      onPointerUp={(event) => endDrag(event, true)}
      role="separator"
      tabIndex={0}
    />
  );
}

interface ResponsiveSheetProps {
  children: ReactNode;
  /** Added to the sheet surface, for a caller that sizes its own layout. */
  className?: string;
  /**
   * From 768px up: a centered modal, a 24rem drawer on the right edge that
   * keeps the page content beside it visible, or the same bottom sheet as on
   * phones (centered, at most 40rem wide) when the content above must stay visible.
   */
  desktopVariant?: "modal" | "side" | "bottom";
  /** Below 768px, a full-screen dialog instead of a bottom sheet (long forms). */
  fullScreenOnPhone?: boolean;
  /** Stays pinned to the bottom edge while the body scrolls. */
  footer?: ReactNode;
  onClose: () => void;
  opened: boolean;
  /**
   * Bottom sheet only: opens at 55% of the viewport and its top handle drags
   * it between 30% and 90%; releasing below 25% closes it.
   */
  resizable?: boolean;
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
  resizable = false,
  title,
}: ResponsiveSheetProps) {
  const desktop = useMediaQuery("(min-width: 768px)", undefined, {
    getInitialValueInEffect: false,
  });
  const [fraction, setFraction] = useState(SHEET_DEFAULT_FRACTION);
  useOverlayBackNavigation(opened, onClose);
  const bottomSheet = desktop ? desktopVariant === "bottom" : !fullScreenOnPhone;
  const resizableSheet = resizable && bottomSheet;

  const classNames = {
    body: footer
      ? "norea-responsive-sheet-body norea-responsive-sheet-body--with-footer"
      : "norea-responsive-sheet-body",
    content: [
      "norea-responsive-sheet",
      bottomSheet
        ? "norea-responsive-sheet--drawer"
        : desktop
          ? desktopVariant === "side"
            ? "norea-responsive-sheet--side"
            : undefined
          : "norea-responsive-sheet--full",
      resizableSheet ? "norea-responsive-sheet--resizable" : undefined,
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

  return bottomSheet ? (
    <Drawer
      classNames={classNames}
      opened={opened}
      onClose={onClose}
      position="bottom"
      styles={
        resizableSheet
          ? { content: { [SHEET_FRACTION_VAR]: String(fraction) } as CSSProperties }
          : undefined
      }
      title={
        resizableSheet ? (
          <>
            <SheetResizeHandle
              fraction={fraction}
              onDismiss={() => {
                setFraction(SHEET_DEFAULT_FRACTION);
                onClose();
              }}
              onResize={setFraction}
            />
            {title}
          </>
        ) : (
          title
        )
      }
    >
      {body}
    </Drawer>
  ) : (
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
  );
}
