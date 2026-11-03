import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  back: null as null | (() => boolean),
  navigate: vi.fn(),
  wide: false,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useState: (initial: unknown) => [initial, () => undefined],
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@mantine/hooks", () => ({ useMediaQuery: () => mocks.wide }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../lib/android-back-navigation", () => ({
  usePageBackNavigation: (onBack: () => boolean) => {
    mocks.back = onBack;
  },
}));

import { SettingsIndex } from "../components/settings/SettingsIndex";
import { SettingsPage } from "./settings";

interface ElementProps {
  activeId?: string;
  children?: ReactNode;
  id?: string;
  onBack?: () => void;
  onSelect?: (id: string) => void;
}

function elements(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<ElementProps>;
  return [element, ...elements(element.props.children)];
}

function render(section?: string) {
  mocks.back = null;
  return elements(SettingsPage({ section }));
}

const index = (tree: ReactElement<ElementProps>[]) =>
  tree.find((element) => element.type === SettingsIndex);
const detail = (tree: ReactElement<ElementProps>[]) =>
  tree.find((element) => typeof element.type === "function" && element.type.name === "SettingsDetail");

beforeEach(() => {
  mocks.navigate.mockClear();
  mocks.wide = false;
});

describe("phone settings navigation", () => {
  it("shows only the section index at /settings and opens a section from it", () => {
    const tree = render();
    expect(detail(tree)).toBeUndefined();
    const list = index(tree)!;
    expect(list.props.activeId).toBeUndefined();

    list.props.onSelect!("network");
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/settings", search: { section: "network" }, replace: true });
    expect(mocks.back!()).toBe(false);
  });

  it("shows a section as its own page whose Back returns to the index", () => {
    const tree = render("network");
    expect(index(tree)).toBeUndefined();
    const page = detail(tree)!;
    expect(page.props.id).toBe("network");

    page.props.onBack!();
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: "/settings", search: { section: undefined }, replace: true });
  });

  it("returns to the index on Android back from a section", () => {
    render("reader");
    expect(mocks.back!()).toBe(true);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/settings", search: { section: undefined }, replace: true });
  });
});

describe("desktop settings navigation", () => {
  it("shows the index as a side nav beside the first section by default", () => {
    mocks.wide = true;
    const tree = render();
    expect(index(tree)!.props.activeId).toBe("appearance");
    const page = detail(tree)!;
    expect(page.props.id).toBe("appearance");
    expect(page.props.onBack).toBeUndefined();
    expect(mocks.back!()).toBe(false);
  });

  it("marks a renamed deep link's section as active", () => {
    mocks.wide = true;
    const tree = render("data");
    expect(index(tree)!.props.activeId).toBe("backup");
    expect(detail(tree)!.props.id).toBe("backup");
  });
});
