import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";

const mocks = vi.hoisted(() => ({
  assigned: [4] as number[] | undefined,
  mutate: vi.fn(),
  mutationOptions: null as null | { onSuccess: (data: unknown, ids: number[]) => Promise<void> },
  saveError: null as unknown,
  showToast: vi.fn(),
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.showToast } }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => ({
    data: queryKey[1] === "list"
      ? [
        { id: 4, name: "Favorites", isSystem: false },
        { id: 5, name: "Later", isSystem: false },
        { id: 6, name: "\u2b50".repeat(5), isSystem: false },
      ]
      : mocks.assigned,
    isPending: queryKey[1] !== "list" && mocks.assigned === undefined,
    error: null,
    refetch: vi.fn(),
  }),
  useMutation: (options: NonNullable<typeof mocks.mutationOptions>) => {
    mocks.mutationOptions = options;
    return { isPending: false, error: mocks.saveError, reset: vi.fn(), mutate: mocks.mutate };
  },
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
  tree = NovelCategoryEditor({ active: true, initialCategories: [{ id: 12, name: "Current assignment" }], novelId: 3, novelName: "Saved novel", onCloseSheet, onOpenSheet, sheetOpen });
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
const editButtons = () => elements().filter((element) => element.props["aria-haspopup"] === "dialog");
const checkbox = (name: string) => sheetElements().find((element) =>
  isValidElement<{ name: string }>(element.props.label) && element.props.label.props.name === name)!;

it("shows assigned categories as text next to one edit action", async () => {
  mocks.assigned = [4, 6];
  await render(false);
  const labels = elements().filter(element => element.type === "li")
    .map(element => collectElements(element.props.children as ReactNode)[0]!.props);
  expect(labels.map(label => label.children)).toEqual(["Favorites", "\u2605".repeat(5)]);
  expect(labels[1]!.title).toBe("\u2b50".repeat(5));
  expect(sheet().props.opened).toBe(false);
  expect(editButtons()).toHaveLength(1);
  await harness!.run(() => (editButtons()[0]!.props.onClick as () => void)());
  expect(onOpenSheet).toHaveBeenCalledTimes(1);
});

it("shows the detail assignment and its pencil before editor membership loads", async () => {
  mocks.assigned = undefined;
  await render(true);
  expect(elements().some(element => element.props.title === "Current assignment")).toBe(true);
  expect(editButtons()).toHaveLength(1);
  expect(sheetElements().find(element => element.props.children === "common.apply")!.props.disabled).toBe(true);

  mocks.assigned = [];
  await render(true);
  expect(elements().some(element => element.props.title === "Current assignment")).toBe(false);
  expect(editButtons()).toHaveLength(1);
});

it("offers the same edit action for an uncategorized novel", async () => {
  mocks.assigned = [];
  await render(false);
  expect(editButtons()).toHaveLength(1);
  expect(editButtons()[0]!.props.label).toBe("categories.editWork");
});

it("starts the sheet from the saved assignment and applies the edited choice", async () => {
  await render(true);
  expect(sheet().props.opened).toBe(true);
  expect(checkbox("Favorites").props.checked).toBe(true);
  expect(checkbox("Later").props.checked).toBe(false);

  await harness!.run(() => (checkbox("Later").props.onChange as (event: unknown) => void)({ currentTarget: { checked: true } }));
  const apply = sheetElements().find((element) => element.props.children === "common.apply")!;
  await harness!.run(() => (apply.props.onClick as () => void)());
  expect(mocks.mutate).toHaveBeenCalledWith([4, 5]);
});

it("closes the sheet and confirms with a toast once the assignment is saved", async () => {
  await render(true);
  await mocks.mutationOptions!.onSuccess(undefined, [4, 5]);
  expect(onCloseSheet).toHaveBeenCalledTimes(1);
  expect(mocks.showToast).toHaveBeenCalledWith({ color: "ok", message: "categories.workSaved" });
});

it("clears the choice without saving until Apply and closes on Cancel", async () => {
  await render(true);
  const clear = sheetElements().find((element) => element.props.children === "categories.clearWork")!;
  await harness!.run(() => (clear.props.onClick as () => void)());
  expect(checkbox("Favorites").props.checked).toBe(false);
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
