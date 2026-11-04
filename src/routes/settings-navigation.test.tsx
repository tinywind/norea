import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  back: null as null | (() => boolean),
  goBackInAppHistory: vi.fn((_href: string, _ignored?: readonly string[]) => false),
  href: "/settings",
  navigate: vi.fn(),
  wide: false,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useState: (initial: unknown) => [initial, () => undefined],
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ state: { location: { href: mocks.href } } }),
}));
vi.mock("../lib/navigation-history", () => ({ goBackInAppHistory: mocks.goBackInAppHistory }));
vi.mock("@mantine/hooks", () => ({ useMediaQuery: () => mocks.wide }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../lib/android-back-navigation", () => ({
  usePageBackNavigation: (onBack: () => boolean) => {
    mocks.back = onBack;
  },
}));

import { PageHeader } from "../components/AppFrame";
import { SettingsIndex } from "../components/settings/SettingsIndex";
import { SettingsSearch } from "../components/settings/SettingsSearch";
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
  mocks.href = section ? `/settings?section=${section}` : "/settings";
  return elements(SettingsPage({ section }));
}

const pageHeader = (tree: ReactElement<ElementProps>[]) =>
  tree.find((element) => element.type === PageHeader);
const index = (tree: ReactElement<ElementProps>[]) =>
  tree.find((element) => element.type === SettingsIndex);
const detail = (tree: ReactElement<ElementProps>[]) =>
  tree.find((element) => typeof element.type === "function" && element.type.name === "SettingsDetail");

beforeEach(() => {
  mocks.navigate.mockClear();
  mocks.goBackInAppHistory.mockReset().mockReturnValue(false);
  mocks.wide = false;
});

describe("phone settings navigation", () => {
  it("shows only the section index at /settings and opens a section as a new history entry", () => {
    const tree = render();
    expect(detail(tree)).toBeUndefined();
    const list = index(tree)!;
    expect(list.props.activeId).toBeUndefined();

    list.props.onSelect!("network");
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/settings", search: { section: "network" }, replace: false });
  });

  it("goes back from a section to the page it was opened from", () => {
    mocks.goBackInAppHistory.mockReturnValue(true);
    const page = detail(render("about"))!;
    expect(page.props.id).toBe("about");

    page.props.onBack!();
    expect(mocks.goBackInAppHistory).toHaveBeenCalledWith("/settings?section=about");
    expect(mocks.navigate).not.toHaveBeenCalled();

    expect(mocks.back!()).toBe(true);
    expect(mocks.goBackInAppHistory).toHaveBeenCalledTimes(2);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("closes a section with no earlier in-app entry to the index", () => {
    const page = detail(render("reader"))!;

    page.props.onBack!();
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: "/settings", search: { section: undefined }, replace: true });

    mocks.navigate.mockClear();
    expect(mocks.back!()).toBe(true);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/settings", search: { section: undefined }, replace: true });
  });

  it("leaves Settings from the index, falling back to More after a cold start", () => {
    render();
    expect(mocks.back!()).toBe(true);
    expect(mocks.goBackInAppHistory).toHaveBeenCalledWith("/settings", ["/settings"]);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/more", replace: true });

    mocks.navigate.mockClear();
    mocks.goBackInAppHistory.mockReturnValue(true);
    expect(mocks.back!()).toBe(true);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});

describe("settings page header", () => {
  it("gives the phone index header the same back as Android back", () => {
    const header = pageHeader(render())!;
    header.props.onBack!();
    expect(mocks.goBackInAppHistory).toHaveBeenLastCalledWith("/settings", ["/settings"]);
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: "/more", replace: true });

    mocks.navigate.mockClear();
    mocks.goBackInAppHistory.mockReturnValue(true);
    header.props.onBack!();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("puts the desktop back on the nav column header and none on the section pane", () => {
    mocks.wide = true;
    const tree = render("about");
    const header = pageHeader(tree)!;
    expect(detail(tree)!.props.onBack).toBeUndefined();

    header.props.onBack!();
    expect(mocks.goBackInAppHistory).toHaveBeenLastCalledWith("/settings?section=about", ["/settings"]);
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: "/more", replace: true });
  });
});

describe("settings search placement", () => {
  it("puts the search field above the section list on phones and in the desktop side nav", () => {
    for (const wide of [false, true]) {
      mocks.wide = wide;
      const tree = render();
      const searchIndex = tree.findIndex((element) => element.type === SettingsSearch);
      expect(searchIndex, `wide: ${wide}`).toBeGreaterThanOrEqual(0);
      expect(searchIndex).toBeLessThan(tree.findIndex((element) => element.type === SettingsIndex));
    }
  });

  it("offers no search inside an open phone section", () => {
    expect(render("network").some((element) => element.type === SettingsSearch)).toBe(false);
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
  });

  it("switches sections in place and leaves Settings on back", () => {
    mocks.wide = true;
    mocks.goBackInAppHistory.mockReturnValue(true);
    const tree = render("reader");

    index(tree)!.props.onSelect!("network");
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/settings", search: { section: "network" }, replace: true });

    mocks.navigate.mockClear();
    expect(mocks.back!()).toBe(true);
    expect(mocks.goBackInAppHistory).toHaveBeenCalledWith("/settings?section=reader", ["/settings"]);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("marks a renamed deep link's section as active", () => {
    mocks.wide = true;
    const tree = render("data");
    expect(index(tree)!.props.activeId).toBe("backup");
    expect(detail(tree)!.props.id).toBe("backup");
  });
});
