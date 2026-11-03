import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface CapturedOverlay {
  classNames: { content: string };
  kind: string;
  styles?: { content: Record<string, string> };
  title: ReactNode;
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

import {
  dragSheetFraction,
  ResponsiveSheet,
  settleSheetFraction,
  SHEET_DEFAULT_FRACTION,
} from "./ResponsiveSheet";

function render(props: { desktopVariant?: "modal" | "side" | "bottom"; resizable?: boolean }) {
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

  it("has no handle unless it is resizable", () => {
    const { markup, overlay } = render({});
    expect(overlay.classNames.content).not.toContain("resizable");
    expect(isValidElement(overlay.title)).toBe(false);
    expect(markup).not.toContain('role="separator"');
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
