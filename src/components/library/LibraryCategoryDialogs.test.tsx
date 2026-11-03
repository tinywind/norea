import { createRef, type ReactNode, type Ref } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { LibraryCategory } from "../../db/queries/category";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";

const mocks = vi.hoisted(() => ({ pending: false }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ isPending: mocks.pending, error: null, reset: vi.fn(), mutate: vi.fn() }),
}));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../db/queries/category", () => ({ deleteCategory: vi.fn(), insertCategory: vi.fn(), updateCategory: vi.fn() }));
vi.mock("../../store/library", () => ({
  useLibraryStore: (selector: (state: unknown) => unknown) => selector({ selectedCategoryId: null, setSelectedCategoryId: vi.fn() }),
}));

import { LibraryCategoryDialogs, type LibraryCategoryDialogsHandle } from "./LibraryCategoryDialogs";

type DialogsRender = (props: { active: boolean }, ref: Ref<LibraryCategoryDialogsHandle>) => ReactNode;

let harness: BackNavigationHarness | undefined;
let tree: ReactNode;
const handle = createRef<LibraryCategoryDialogsHandle>();
const category = { id: 4, name: "Favorites" } as LibraryCategory;

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  mocks.pending = false;
});

function DialogsProbe() {
  tree = (LibraryCategoryDialogs as unknown as { render: DialogsRender }).render({ active: true }, handle);
  return null;
}

const dialogs = () => collectElements(tree).filter((element) => "opened" in element.props);

it.each([
  ["categories.add", 0, () => handle.current!.createCategory()],
  ["categories.rename", 0, () => handle.current!.renameCategory(category)],
  ["categories.delete", 1, () => handle.current!.deleteCategory(category)],
] as const)("closes the %s dialog on back without leaving the library", async (title, index, open) => {
  harness = mountBackNavigationHarness();
  await harness.render(<DialogsProbe />);
  await harness.run(open);
  expect(dialogs()[index]!.props).toMatchObject({ opened: true, title });

  expect(harness.pressBack()).toBe(true);
  expect(dialogs()[index]!.props.opened).toBe(false);
  expect(harness.pressBack()).toBe(false);
});

it.each([
  ["categories.add", 0, () => handle.current!.createCategory()],
  ["categories.delete", 1, () => handle.current!.deleteCategory(category)],
] as const)("keeps the %s dialog open and its controls locked while the change is saving", async (_title, index, open) => {
  harness = mountBackNavigationHarness();
  await harness.render(<DialogsProbe />);
  await harness.run(open);
  mocks.pending = true;
  await harness.render(<DialogsProbe />);
  const dialog = dialogs()[index]!;
  expect(dialog.props).toMatchObject({ closeOnClickOutside: false, closeOnEscape: false, withCloseButton: false });

  await harness.run(() => (dialog.props.onClose as () => void)());
  harness.pressBack();
  expect(dialogs()[index]!.props.opened).toBe(true);
  const cancel = collectElements(tree).find((element) => element.props.children === "common.cancel" && element.props.disabled === true);
  expect(cancel).toBeDefined();
});
