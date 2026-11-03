import { useState, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../lib/android-back-navigation.test-support";

vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { CategoriesDrawer } from "./CategoriesDrawer";

let harness: BackNavigationHarness | undefined;
let tree: ReactNode;

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
});

function DrawerProbe() {
  const [opened, setOpened] = useState(true);
  tree = CategoriesDrawer({
    allCount: 0, categories: [], error: null, loading: false,
    onCreate: vi.fn(), onDelete: vi.fn(), onRename: vi.fn(), onSelect: vi.fn(),
    opened, onClose: () => setOpened(false),
    selectedCategoryId: null, uncategorizedCount: 0,
  });
  return null;
}

const drawer = () => collectElements(tree).find((element) => element.props.title === "categories.title")!;

it("closes the library categories drawer on back and then leaves back to the system", async () => {
  harness = mountBackNavigationHarness();
  await harness.render(<DrawerProbe />);
  expect(drawer().props.opened).toBe(true);

  expect(harness.pressBack()).toBe(true);
  expect(drawer().props.opened).toBe(false);
  expect(harness.pressBack()).toBe(false);
});
