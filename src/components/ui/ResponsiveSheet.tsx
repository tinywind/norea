import { Box, Drawer, Modal } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "../../i18n";
import { useOverlayBackNavigation } from "../../lib/android-back-navigation";
import { OVERLAY_MOTION } from "../../theme/motion";

/** Resizable sheets open at this share of the viewport height. */
export const SHEET_DEFAULT_FRACTION = 0.55;
const SHEET_MIN_FRACTION = 0.3;
const SHEET_MAX_FRACTION = 0.9;
/** Releasing a drag below this share dismisses the sheet. */
const SHEET_DISMISS_FRACTION = 0.25;
const SHEET_KEY_STEP = 0.1;
const SHEET_FRACTION_VAR = "--norea-sheet-fraction";
/** A fixed-height sheet dismisses once dragged down this share of its height, and never under the floor. */
const SHEET_DRAG_DISMISS_SHARE = 0.25;
const SHEET_DRAG_DISMISS_MIN_PX = 48;

const SHEET_CLASS = "norea-responsive-sheet";
const SHEET_BODY_CLASS = "norea-responsive-sheet-body";

export type SheetSize = "sm" | "md" | "lg" | "xl";

/** Dialog widths from 768px up: confirm, form, manager, finder. */
export const SHEET_DIALOG_WIDTHS: Record<SheetSize, string> = {
  sm: "var(--norea-dialog-sm)",
  md: "var(--norea-dialog-md)",
  lg: "var(--norea-dialog-lg)",
  xl: "var(--norea-dialog-xl)",
};

/** The class names every sheet and dialog shares, so ConfirmDialog draws the same header, body and footer. */
export const SHEET_CLASS_NAMES = {
  body: SHEET_BODY_CLASS,
  close: "norea-responsive-sheet-close",
  content: SHEET_CLASS,
  header: "norea-responsive-sheet-header",
  title: "norea-responsive-sheet-title",
};

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

/** Whether releasing a fixed-height sheet `dragDownPx` below where it rests dismisses it. */
export function dismissesSheetDrag(dragDownPx: number, sheetHeightPx: number): boolean {
  return dragDownPx >= Math.max(SHEET_DRAG_DISMISS_MIN_PX, sheetHeightPx * SHEET_DRAG_DISMISS_SHARE);
}

interface SheetHandleProps {
  disabled: boolean;
  onDismiss: () => void;
  /** Whether the sheet is still open, read after a dismissing drag in case the owner kept it open. */
  openedRef: { readonly current: boolean };
  /** Present for a resizable sheet: the handle drags its height and answers arrow keys. */
  resize?: { fraction: number; onResize: (fraction: number) => void };
}

interface SheetDrag {
  current: number;
  pointerId: number;
  sheet: HTMLElement | null;
  start: number;
  startY: number;
}

/**
 * The pill and full-width touch strip on top of every bottom sheet. Dragging
 * a resizable sheet changes its height; dragging any other sheet down moves
 * it with the finger and dismisses it past a quarter of its height.
 */
function SheetHandle({ disabled, onDismiss, openedRef, resize }: SheetHandleProps) {
  const { t } = useTranslation();
  const dragRef = useRef<SheetDrag | null>(null);

  const move = (drag: SheetDrag, clientY: number) => {
    if (resize) {
      drag.current = dragSheetFraction(drag.start, drag.startY - clientY, window.innerHeight);
      drag.sheet?.style.setProperty(SHEET_FRACTION_VAR, String(drag.current));
    } else {
      drag.current = Math.max(0, clientY - drag.startY);
      if (drag.sheet) drag.sheet.style.translate = `0 ${drag.current}px`;
    }
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>, settle: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (resize) {
      const settled = settle ? settleSheetFraction(drag.current) : drag.start;
      drag.sheet?.style.setProperty(SHEET_FRACTION_VAR, String(settled ?? drag.start));
      if (settled === null) onDismiss();
      else resize.onResize(settled);
      return;
    }
    const { sheet } = drag;
    if (!settle || !dismissesSheetDrag(drag.current, sheet?.offsetHeight ?? 0)) {
      if (sheet) sheet.style.translate = "";
      return;
    }
    onDismiss();
    // A sheet that closes leaves from where the finger let go; one whose owner keeps it open snaps back.
    requestAnimationFrame(() => {
      if (sheet && openedRef.current) sheet.style.translate = "";
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!resize || disabled) return;
    const { fraction } = resize;
    const next =
      event.key === "ArrowUp" ? fraction + SHEET_KEY_STEP
      : event.key === "ArrowDown" ? fraction - SHEET_KEY_STEP
      : event.key === "Home" ? SHEET_MAX_FRACTION
      : event.key === "End" ? SHEET_MIN_FRACTION
      : null;
    if (next === null) return;
    event.preventDefault();
    resize.onResize(clampSheetFraction(next));
  };

  const pointerHandlers = disabled
    ? {}
    : {
        onPointerCancel: (event: PointerEvent<HTMLDivElement>) => endDrag(event, false),
        onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          const start = resize?.fraction ?? 0;
          dragRef.current = {
            current: start,
            pointerId: event.pointerId,
            sheet: event.currentTarget.closest<HTMLElement>(`.${SHEET_CLASS}`),
            start,
            startY: event.clientY,
          };
        },
        onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
          const drag = dragRef.current;
          if (drag && drag.pointerId === event.pointerId) move(drag, event.clientY);
        },
        onPointerUp: (event: PointerEvent<HTMLDivElement>) => endDrag(event, true),
      };

  if (!resize) {
    return (
      <div
        aria-hidden
        className="norea-responsive-sheet-handle"
        data-disabled={disabled || undefined}
        {...pointerHandlers}
      />
    );
  }
  return (
    <div
      aria-disabled={disabled || undefined}
      aria-label={t("sheet.resize")}
      aria-orientation="horizontal"
      aria-valuemax={Math.round(SHEET_MAX_FRACTION * 100)}
      aria-valuemin={Math.round(SHEET_MIN_FRACTION * 100)}
      aria-valuenow={Math.round(resize.fraction * 100)}
      className="norea-responsive-sheet-handle"
      data-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      role="separator"
      tabIndex={0}
      {...pointerHandlers}
    />
  );
}

/**
 * Marks the sheet surface `data-scrolled` while its body is scrolled, which
 * draws the header divider. Scroll events do not bubble, so the listener
 * captures them on the surface and ignores nested scrollers.
 */
function useScrollDivider() {
  return useCallback((sentinel: HTMLSpanElement | null) => {
    const surface = sentinel?.closest<HTMLElement>(`.${SHEET_CLASS}`);
    if (!surface) return;
    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target !== surface && !target.classList.contains(SHEET_BODY_CLASS)) return;
      if (target.scrollTop > 0) surface.dataset.scrolled = "true";
      else delete surface.dataset.scrolled;
    };
    surface.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => surface.removeEventListener("scroll", onScroll, { capture: true });
  }, []);
}

/** Lays out sheet and dialog footer buttons: right-aligned from 768px, equal-width below and stacked past two. */
export function SheetActions({ children }: { children: ReactNode }) {
  return <Box className="norea-sheet-actions">{children}</Box>;
}

interface ResponsiveSheetProps {
  /**
   * Locks the sheet while work runs: Escape, an outside click, Android back,
   * the close button and the drag handle no longer close it.
   */
  busy?: boolean;
  children: ReactNode;
  /** Added to the sheet surface, for a caller that sizes its own layout. */
  className?: string;
  /** Accessible name of the close button; defaults to "Close". */
  closeLabel?: string;
  /**
   * From 768px up: a centered dialog, a side drawer on the trailing edge that
   * keeps the page content beside it visible, or the same bottom sheet as on
   * phones (centered, at most 40rem wide) when the content above must stay visible.
   */
  desktopVariant?: "modal" | "side" | "bottom";
  /** Below 768px, a full-screen dialog instead of a bottom sheet (long forms and managers). */
  fullScreenOnPhone?: boolean;
  /** Stays pinned to the bottom edge while the body scrolls; wrap buttons in `SheetActions`. */
  footer?: ReactNode;
  /** Opens over another sheet or dialog, so it takes the nested overlay layer. */
  nested?: boolean;
  onClose: () => void;
  /** Runs once the exit transition ends, for a caller that returns focus itself. */
  onExitTransitionEnd?: () => void;
  opened: boolean;
  /**
   * Bottom sheet only: opens at 55% of the viewport and its top handle drags
   * it between 30% and 90%; releasing below 25% closes it.
   */
  resizable?: boolean;
  /** Leave false only when `onExitTransitionEnd` restores focus. */
  returnFocus?: boolean;
  /** Dialog width from 768px up. */
  size?: SheetSize;
  /** A muted line under the title, such as the item the sheet acts on. */
  subtitle?: ReactNode;
  title: ReactNode;
}

/**
 * A bottom sheet below 768px and a centered dialog (or trailing side drawer)
 * from 768px up. Android back closes it while open; Mantine owns the focus
 * trap and focus return.
 */
export function ResponsiveSheet({
  busy = false,
  children,
  className,
  closeLabel,
  desktopVariant = "modal",
  fullScreenOnPhone = false,
  footer,
  nested = false,
  onClose,
  onExitTransitionEnd,
  opened,
  resizable = false,
  returnFocus,
  size = "md",
  subtitle,
  title,
}: ResponsiveSheetProps) {
  const { t } = useTranslation();
  const desktop = useMediaQuery("(min-width: 768px)", undefined, {
    getInitialValueInEffect: false,
  });
  const [fraction, setFraction] = useState(SHEET_DEFAULT_FRACTION);
  const openedRef = useRef(opened);
  openedRef.current = opened;
  const scrollSentinel = useScrollDivider();
  const close = () => {
    if (!busy) onClose();
  };
  useOverlayBackNavigation(opened, close);
  const bottomSheet = desktop ? desktopVariant === "bottom" : !fullScreenOnPhone;
  const resizableSheet = resizable && bottomSheet;

  const classNames = {
    ...SHEET_CLASS_NAMES,
    body: footer ? `${SHEET_BODY_CLASS} norea-responsive-sheet-body--with-footer` : SHEET_BODY_CLASS,
    content: [
      SHEET_CLASS,
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
  };
  const heading = subtitle ? (
    <>
      <span className="norea-responsive-sheet-title-text">{title}</span>
      <span className="norea-responsive-sheet-subtitle">{subtitle}</span>
    </>
  ) : (
    title
  );
  const shared = {
    classNames,
    closeButtonProps: { "aria-label": closeLabel ?? t("common.close"), disabled: busy },
    closeOnClickOutside: !busy,
    closeOnEscape: !busy,
    onClose: close,
    onExitTransitionEnd,
    opened,
    returnFocus,
    zIndex: nested ? "var(--norea-z-overlay-nested)" : undefined,
  };
  const body = (
    <>
      <Box aria-hidden className="norea-responsive-sheet-scroll-sentinel" component="span" ref={scrollSentinel} />
      {children}
      {footer ? <Box className="norea-responsive-sheet-footer">{footer}</Box> : null}
    </>
  );

  if (desktop && desktopVariant === "side") {
    return (
      <Drawer
        {...shared}
        position="right"
        size="var(--norea-side-sheet-width)"
        title={heading}
        transitionProps={OVERLAY_MOTION.sheetSide}
      >
        {body}
      </Drawer>
    );
  }

  if (bottomSheet) {
    const dismiss = () => {
      if (busy) return;
      setFraction(SHEET_DEFAULT_FRACTION);
      onClose();
    };
    return (
      <Drawer
        {...shared}
        position="bottom"
        styles={
          resizableSheet
            ? { content: { [SHEET_FRACTION_VAR]: String(fraction) } as CSSProperties }
            : undefined
        }
        title={
          <>
            <SheetHandle
              disabled={busy}
              onDismiss={dismiss}
              openedRef={openedRef}
              resize={resizableSheet ? { fraction, onResize: setFraction } : undefined}
            />
            {heading}
          </>
        }
        transitionProps={OVERLAY_MOTION.sheetBottom}
      >
        {body}
      </Drawer>
    );
  }

  return (
    <Modal
      {...shared}
      centered
      fullScreen={!desktop}
      size={SHEET_DIALOG_WIDTHS[size]}
      title={heading}
      transitionProps={desktop ? undefined : OVERLAY_MOTION.sheetBottom}
    >
      {body}
    </Modal>
  );
}
