import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface CapturedOverlay {
  classNames: { content: string };
  closeButtonProps: Record<string, unknown>;
  kind: string;
  size?: string;
  styles?: { content: Record<string, string> };
  title: ReactNode;
  transitionProps?: unknown;
  zIndex?: string;
}

const rendered = vi.hoisted(() => ({ desktop: false, overlay: null as CapturedOverlay | null }));

vi.mock("@mantine/core", () => {
  const overlay = (kind: string) => (props: Omit<CapturedOverlay, "kind"> & { children?: ReactNode }) => {
    rendered.overlay = { ...props, kind };
    return <>{props.title}{props.children}</>;
  };
  return { Box: ({ children }: { children?: ReactNode }) => children, Drawer: overlay("drawer"), Modal: overlay("modal") };
});
vi.mock("@mantine/hooks", () => ({ useMediaQuery: () => rendered.desktop }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../lib/android-back-navigation", () => ({ useOverlayBackNavigation: vi.fn() }));

import { OVERLAY_MOTION } from "../../theme/motion";
import {
  dismissesSheetDrag,
  dragSheetFraction,
  ResponsiveSheet,
  settleSheetFraction,
  SHEET_DEFAULT_FRACTION,
} from "./ResponsiveSheet";

type SheetProps = Partial<Parameters<typeof ResponsiveSheet>[0]>;

function render(props: SheetProps) {
  const markup = renderToStaticMarkup(
    <ResponsiveSheet onClose={vi.fn()} opened title="Reader" {...props}>body</ResponsiveSheet>,
  );
  return { markup, overlay: rendered.overlay! };
}

beforeEach(() => {
  rendered.desktop = false;
  rendered.overlay = null;
});

describe("resizable bottom sheet", () => {
  it("opens at the default height with a keyboard-operable resize handle", () => {
    const { markup, overlay } = render({ resizable: true });
    expect(overlay.kind).toBe("drawer");
    expect(overlay.classNames.content).toContain("norea-responsive-sheet--resizable");
    expect(overlay.styles?.content["--norea-sheet-fraction"]).toBe(String(SHEET_DEFAULT_FRACTION));
    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-valuenow="55"');
    expect(markup).toContain('tabindex="0"');
  });

  it("stays a bottom sheet from 768px up when the caller asks for it", () => {
    rendered.desktop = true;
    expect(render({ desktopVariant: "bottom", resizable: true }).overlay.kind).toBe("drawer");
    expect(render({}).overlay.kind).toBe("modal");
  });

  it("follows a drag and settles inside 30-90%, closing below 25%", () => {
    expect(dragSheetFraction(0.55, 200, 1000)).toBeCloseTo(0.75);
    expect(dragSheetFraction(0.55, 900, 1000)).toBe(0.9);
    expect(dragSheetFraction(0.55, -400, 1000)).toBeCloseTo(0.15);
    expect(settleSheetFraction(0.27)).toBe(0.3);
    expect(settleSheetFraction(0.62)).toBe(0.62);
    expect(settleSheetFraction(0.2)).toBeNull();
  });
});

describe("bottom sheet handle", () => {
  it("gives every bottom sheet a drag handle that only resizable sheets expose to keyboards", () => {
    const { markup, overlay } = render({});
    expect(overlay.classNames.content).not.toContain("resizable");
    expect(markup).toContain('class="norea-responsive-sheet-handle"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('role="separator"');
  });

  it("has no handle on a dialog", () => {
    rendered.desktop = true;
    expect(render({}).markup).not.toContain("norea-responsive-sheet-handle");
  });

  it("dismisses a fixed-height sheet dragged a quarter of its height, never under 48px", () => {
    expect(dismissesSheetDrag(100, 400)).toBe(true);
    expect(dismissesSheetDrag(99, 400)).toBe(false);
    expect(dismissesSheetDrag(47, 120)).toBe(false);
    expect(dismissesSheetDrag(48, 120)).toBe(true);
  });

  it("locks the handle while busy", () => {
    const fixed = render({ busy: true }).markup;
    expect(fixed).toContain("data-disabled");
    const resizable = render({ busy: true, resizable: true }).markup;
    expect(resizable).toContain('aria-disabled="true"');
  });
});

describe("sheet anatomy", () => {
  it("puts a muted subtitle under the title", () => {
    const { markup } = render({ subtitle: "Volume 2" });
    expect(markup).toContain('<span class="norea-responsive-sheet-title-text">Reader</span>');
    expect(markup).toContain('<span class="norea-responsive-sheet-subtitle">Volume 2</span>');
  });

  it("keeps a plain title when there is no subtitle", () => {
    rendered.desktop = true;
    expect(render({}).overlay.title).toBe("Reader");
  });

  it("sizes dialogs from the width scale, defaulting to the form width", () => {
    rendered.desktop = true;
    expect(render({}).overlay.size).toBe("var(--norea-dialog-md)");
    expect(render({ size: "sm" }).overlay.size).toBe("var(--norea-dialog-sm)");
    expect(render({ size: "xl" }).overlay.size).toBe("var(--norea-dialog-xl)");
  });

  it("takes the nested layer only when it opens over another overlay", () => {
    expect(render({}).overlay.zIndex).toBeUndefined();
    expect(render({ nested: true }).overlay.zIndex).toBe("var(--norea-z-overlay-nested)");
  });

  it("names the close button and lets a caller rename it", () => {
    expect(render({}).overlay.closeButtonProps).toMatchObject({ "aria-label": "common.close", disabled: false });
    expect(render({ closeLabel: "Close finder" }).overlay.closeButtonProps["aria-label"]).toBe("Close finder");
  });

  it("slides sheets and drawers from their edge and keeps the theme's dialog motion", () => {
    expect(render({}).overlay.transitionProps).toBe(OVERLAY_MOTION.sheetBottom);
    expect(render({ fullScreenOnPhone: true }).overlay.transitionProps).toBe(OVERLAY_MOTION.sheetBottom);
    rendered.desktop = true;
    expect(render({ desktopVariant: "side" }).overlay.transitionProps).toBe(OVERLAY_MOTION.sheetSide);
    expect(render({}).overlay.transitionProps).toBeUndefined();
  });
});
