import { createRef, type ReactNode, type Ref } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LibraryCategory } from "../../db/queries/category";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";

const mocks = vi.hoisted(() => ({ pending: false, confirm: vi.fn(), mutate: vi.fn() }));
vi.mock("@mantine/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@mantine/core")>(),
  Drawer: () => null,
  Modal: () => null,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ isPending: mocks.pending, error: null, reset: vi.fn(), mutate: mocks.mutate }),
}));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../db/queries/category", () => ({ deleteCategory: vi.fn(), insertCategory: vi.fn(), updateCategory: vi.fn() }));
vi.mock("../../store/library", () => ({
  useLibraryStore: (selector: (state: unknown) => unknown) => selector({ selectedCategoryId: null, setSelectedCategoryId: vi.fn() }),
}));
vi.mock("../ui/ConfirmDialog", () => ({ useConfirm: () => mocks.confirm }));

import { LibraryCategoryDialogs, type LibraryCategoryDialogsHandle } from "./LibraryCategoryDialogs";

type DialogsRender = (props: { active: boolean }, ref: Ref<LibraryCategoryDialogsHandle>) => ReactNode;

let harness: BackNavigationHarness | undefined;
let tree: ReactNode;
const handle = createRef<LibraryCategoryDialogsHandle>();
const category = { id: 4, name: "Favorites" } as LibraryCategory;

beforeEach(() => {
  mocks.confirm.mockReset();
  mocks.mutate.mockReset();
});

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  mocks.pending = false;
});

function DialogsProbe() {
  tree = (LibraryCategoryDialogs as unknown as { render: DialogsRender }).render({ active: true }, handle);
  return tree;
}

const editor = () => collectElements(tree).find((element) => "opened" in element.props)!;

it.each([
  ["categories.add", () => handle.current!.createCategory()],
  ["categories.rename", () => handle.current!.renameCategory(category)],
] as const)("closes the %s dialog on back without leaving the library", async (title, open) => {
  harness = mountBackNavigationHarness();
  await harness.render(<DialogsProbe />);
  await harness.run(open);
  expect(editor().props).toMatchObject({ nested: true, opened: true, title });

  expect(harness.pressBack()).toBe(true);
  expect(editor().props.opened).toBe(false);
  expect(harness.pressBack()).toBe(false);
});

it("keeps the editor open and its controls locked while the change is saving", async () => {
  harness = mountBackNavigationHarness();
  await harness.render(<DialogsProbe />);
  await harness.run(() => handle.current!.createCategory());
  mocks.pending = true;
  await harness.render(<DialogsProbe />);
  expect(editor().props).toMatchObject({ busy: true });

  await harness.run(() => (editor().props.onClose as () => void)());
  harness.pressBack();
  expect(editor().props.opened).toBe(true);
  const cancel = collectElements(editor().props.footer as ReactNode)
    .find((element) => element.props.children === "common.cancel" && element.props.disabled === true);
  expect(cancel).toBeDefined();
});

it("deletes a category only after the shared confirmation accepts", async () => {
  harness = mountBackNavigationHarness();
  await harness.render(<DialogsProbe />);
  mocks.confirm.mockResolvedValueOnce(false);
  await harness.run(() => handle.current!.deleteCategory(category));
  expect(mocks.confirm).toHaveBeenCalledWith({
    title: "categories.delete",
    message: "library.deleteCategory.message",
    confirmLabel: "common.delete",
    danger: true,
  });
  expect(mocks.mutate).not.toHaveBeenCalled();

  mocks.confirm.mockResolvedValueOnce(true);
  await harness.run(() => handle.current!.deleteCategory(category));
  expect(mocks.mutate).toHaveBeenCalledWith(4);
});
