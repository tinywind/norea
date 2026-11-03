import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";

const mocks = vi.hoisted(() => ({
  assigned: [4] as number[],
  mutate: vi.fn(),
  saveError: null as unknown,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => ({
    data: queryKey[1] === "list"
      ? [{ id: 4, name: "Favorites", isSystem: false }, { id: 5, name: "Later", isSystem: false }]
      : mocks.assigned,
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
  useMutation: () => ({ isPending: false, error: mocks.saveError, reset: vi.fn(), mutate: mocks.mutate }),
}));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../db/queries/category", () => ({
  getNovelCategoryIds: vi.fn(),
  listCategories: vi.fn(),
  NovelCategoryError: class extends Error {},
  setNovelCategories: vi.fn(),
}));
vi.mock("../ui/ResponsiveSheet", () => ({ ResponsiveSheet: () => null }));

import { NovelCategoryEditor } from "./NovelCategoryEditor";

let harness: BackNavigationHarness | undefined;
let tree: ReactNode;
const onOpenSheet = vi.fn();
const onCloseSheet = vi.fn();

beforeEach(() => {
  mocks.assigned = [4];
  mocks.saveError = null;
});

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  vi.clearAllMocks();
});

function EditorProbe({ sheetOpen }: { sheetOpen: boolean }) {
  tree = NovelCategoryEditor({ active: true, novelId: 3, novelName: "Saved novel", onCloseSheet, onOpenSheet, sheetOpen });
  return null;
}

async function render(sheetOpen: boolean) {
  harness ??= mountBackNavigationHarness();
  await harness.render(<EditorProbe sheetOpen={sheetOpen} />);
}

const elements = () => collectElements(tree);
const sheet = () => elements().find((element) => element.props.title === "categories.editWork")!;
const sheetElements = () => [
  ...collectElements(sheet().props.children as ReactNode),
  ...collectElements(sheet().props.footer as ReactNode),
];
const chips = () => elements().filter((element) => element.type === "button");
const text = (element: { props: Record<string, unknown> }) =>
  collectElements(element.props.children as ReactNode).length === 0
    ? String(element.props.children)
    : (element.props.children as ReactNode[]).filter((child) => typeof child === "string").join("");

it("shows assigned categories as chips that open the category sheet", async () => {
  await render(false);
  expect(chips().map(text)).toEqual(["Favorites"]);
  expect(sheet().props.opened).toBe(false);

  await harness!.run(() => (chips()[0]!.props.onClick as () => void)());
  expect(onOpenSheet).toHaveBeenCalledTimes(1);
});

it("offers a + Category chip when the novel has no category", async () => {
  mocks.assigned = [];
  await render(false);
  expect(chips()).toHaveLength(1);
  expect(text(chips()[0]!)).toBe("categories.addToWork");
});

it("starts the sheet from the saved assignment and applies the edited choice", async () => {
  await render(true);
  expect(sheet().props.opened).toBe(true);
  const checkbox = (label: string) => sheetElements().find((element) => element.props.label === label)!;
  expect(checkbox("Favorites").props.checked).toBe(true);
  expect(checkbox("Later").props.checked).toBe(false);

  await harness!.run(() => (checkbox("Later").props.onChange as (event: unknown) => void)({ currentTarget: { checked: true } }));
  const apply = sheetElements().find((element) => element.props.children === "common.apply")!;
  await harness!.run(() => (apply.props.onClick as () => void)());
  expect(mocks.mutate).toHaveBeenCalledWith([4, 5]);
});

it("clears the choice without saving until Apply and closes on Cancel", async () => {
  await render(true);
  const clear = sheetElements().find((element) => element.props.children === "categories.clearWork")!;
  await harness!.run(() => (clear.props.onClick as () => void)());
  expect(sheetElements().find((element) => element.props.label === "Favorites")!.props.checked).toBe(false);
  expect(mocks.mutate).not.toHaveBeenCalled();

  const cancel = sheetElements().find((element) => element.props.children === "common.cancel")!;
  await harness!.run(() => (cancel.props.onClick as () => void)());
  expect(onCloseSheet).toHaveBeenCalledTimes(1);
});

it("shows a save failure inline in the sheet", async () => {
  mocks.saveError = new Error("Disk full");
  await render(true);
  const alert = sheetElements().find((element) => element.props.role === "alert")!;
  expect(alert.props.children).toBe("Disk full");
});
