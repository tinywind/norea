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
const onRefresh = vi.fn();

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  onSearchChange.mockClear();
  onRefresh.mockClear();
});

function AppBarProbe({ wide, search = "", refreshDisabled = false, refreshing = false }: {
  wide: boolean; search?: string; refreshDisabled?: boolean; refreshing?: boolean;
}) {
  tree = LibraryAppBar({
    onOpenViewOptions: vi.fn(), onRefresh, onSearchChange,
    overflowItems: [], refreshDisabled, refreshing, search, wide,
  });
  return null;
}

const searchField = () => collectElements(tree).find((element) => element.props.onChange === onSearchChange);
const labeled = (label: string) =>
  collectElements(tree).filter((element) => element.props.label === label || element.props["aria-label"] === label);

it("offers search, refresh and view options directly on phones and expands search into a field", async () => {
  harness = mountBackNavigationHarness();
  await harness.render(<AppBarProbe wide={false} />);
  expect(searchField()).toBeUndefined();
  expect(labeled("library.search.aria")).toHaveLength(1);
  expect(labeled("library.viewOptions.title")).toHaveLength(1);
  expect(labeled("common.more")).toHaveLength(1);
  expect(labeled("library.refresh")).toHaveLength(1);

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

it("refreshes from the phone action and disables it while unavailable or already refreshing", async () => {
  harness = mountBackNavigationHarness();
  await harness.render(<AppBarProbe wide={false} />);
  const refresh = () => labeled("library.refresh")[0]!;
  expect(refresh().props.disabled).toBe(false);
  await harness.run(() => (refresh().props.onClick as () => void)());
  expect(onRefresh).toHaveBeenCalledTimes(1);

  await harness.render(<AppBarProbe refreshDisabled wide={false} />);
  expect(refresh().props.disabled).toBe(true);
  await harness.render(<AppBarProbe refreshing wide={false} />);
  expect(refresh().props.disabled).toBe(true);
});
