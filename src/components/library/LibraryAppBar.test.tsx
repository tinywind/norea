import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";

vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { LibraryAppBar } from "./LibraryAppBar";

let harness: BackNavigationHarness | undefined;
let tree: ReactNode;
const onSearchChange = vi.fn();

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  onSearchChange.mockClear();
});

function AppBarProbe({ wide, search = "" }: { wide: boolean; search?: string }) {
  tree = LibraryAppBar({
    onOpenViewOptions: vi.fn(), onRefresh: vi.fn(), onSearchChange,
    overflowItems: [], refreshDisabled: false, refreshing: false, search, wide,
  });
  return null;
}

const searchField = () => collectElements(tree).find((element) => element.props.onChange === onSearchChange);
const labeled = (label: string) =>
  collectElements(tree).filter((element) => element.props.label === label || element.props["aria-label"] === label);

it("keeps the phone bar to search, view options and the overflow, and expands search into a field", async () => {
  harness = mountBackNavigationHarness();
  await harness.render(<AppBarProbe wide={false} />);
  expect(searchField()).toBeUndefined();
  expect(labeled("library.search.aria")).toHaveLength(1);
  expect(labeled("library.viewOptions.title")).toHaveLength(1);
  expect(labeled("common.more")).toHaveLength(1);
  expect(labeled("library.refresh")).toHaveLength(0);

  await harness.run(() => (labeled("library.search.aria")[0]!.props.onClick as () => void)());
  expect(searchField()?.props.autoFocus).toBe(true);
  expect(labeled("common.more")).toHaveLength(0);

  const header = collectElements(tree).find((element) => element.props.backLabel === "library.search.close");
  await harness.run(() => (header!.props.onBack as () => void)());
  expect(onSearchChange).toHaveBeenLastCalledWith("");
  expect(labeled("library.search.aria")).toHaveLength(1);
});

it("shows the inline search field, Refresh and the view options icon on wide screens", async () => {
  harness = mountBackNavigationHarness();
  await harness.render(<AppBarProbe wide />);
  expect(searchField()).toBeDefined();
  expect(labeled("library.refresh")).toHaveLength(1);
  expect(labeled("library.viewOptions.title")).toHaveLength(1);
});
