import type { ReactElement, ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { LibraryCategory } from "../../db/queries/category";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";

const mocks = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mocks.data, isError: false, isFetching: false, isLoading: false }),
}));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../store/reader", () => ({ useReaderStore: { getState: () => ({ lastReadChapterByNovel: {} }) } }));
vi.mock("../ui/ResponsiveSheet", () => ({ ResponsiveSheet: () => null }));

import {
  LibraryCategorySheet,
  LibraryDownloadSheet,
  nextCategoryMembership,
} from "./LibrarySelectionSheets";

let harness: BackNavigationHarness | undefined;
let tree: ReactElement<Record<string, unknown>>;

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
});

const elements = () => [
  ...collectElements(tree.props.children as ReactNode),
  ...collectElements(tree.props.footer as ReactNode),
];

it("cycles a partly assigned category through some, all and none, and others only between all and none", () => {
  expect(nextCategoryMembership("some", "some")).toBe("all");
  expect(nextCategoryMembership("some", "all")).toBe("none");
  expect(nextCategoryMembership("some", "none")).toBe("some");
  expect(nextCategoryMembership("all", "all")).toBe("none");
  expect(nextCategoryMembership("all", "none")).toBe("all");
  expect(nextCategoryMembership("none", "none")).toBe("all");
});

const categories = [
  { id: 4, name: "Reading" },
  { id: 5, name: "Done" },
  { id: 6, name: "Later" },
] as LibraryCategory[];
const onApply = vi.fn();

function CategoryProbe() {
  tree = LibraryCategorySheet({
    applying: false, categories, novelIds: [1, 2, 3], onApply, onClose: vi.fn(),
    onCreateCategory: vi.fn(), opened: true,
  }) as ReactElement<Record<string, unknown>>;
  return null;
}

it("shows all, some or none per category and applies only the explicit changes", async () => {
  mocks.data = new Map([[4, 3], [5, 1]]);
  harness = mountBackNavigationHarness();
  await harness.render(<CategoryProbe />);
  const box = (label: string) => elements().find((element) => element.props.label === label)!;
  expect(box("Reading").props).toMatchObject({ checked: true, indeterminate: false, description: "library.categoryAction.inAll" });
  expect(box("Done").props).toMatchObject({ checked: false, indeterminate: true, description: "library.categoryAction.inSome" });
  expect(box("Later").props).toMatchObject({ checked: false, indeterminate: false });
  const apply = () => elements().find((element) => element.props.children === "common.apply")!;
  expect(apply().props.disabled).toBe(true);

  await harness.run(() => (box("Reading").props.onChange as () => void)());
  await harness.run(() => (box("Done").props.onChange as () => void)());
  await harness.run(() => (box("Later").props.onChange as () => void)());
  expect(box("Reading").props.description).toBe("library.categoryAction.willRemove");
  expect(box("Done").props.description).toBe("library.categoryAction.willAdd");
  expect(apply().props.disabled).toBe(false);

  await harness.run(() => (apply().props.onClick as () => void)());
  expect(onApply).toHaveBeenCalledWith({ add: [5, 6], remove: [4] });
});

it("offers each download mode with its chapter count and disables the empty ones", async () => {
  mocks.data = { all: 12, unread: 4, next10: 0, next30: 0 };
  const onDownload = vi.fn();
  const onClose = vi.fn();
  function DownloadProbe() {
    tree = LibraryDownloadSheet({ novelIds: [1, 2], onClose, onDownload, opened: true }) as ReactElement<Record<string, unknown>>;
    return null;
  }
  harness = mountBackNavigationHarness();
  await harness.render(<DownloadProbe />);
  const rows = elements().filter((element) => typeof element.props.title === "string" && "subtitle" in element.props);
  expect(rows.map((row) => [row.props.title, row.props.disabled])).toEqual([
    ["novel.batchDownload.all", false],
    ["novel.batchDownload.unread", false],
    ["novel.batchDownload.next10", true],
    ["novel.batchDownload.next30", true],
  ]);
  await harness.run(() => (rows[1]!.props.onClick as () => void)());
  expect(onDownload).toHaveBeenCalledWith("unread");
  expect(onClose).toHaveBeenCalled();
});
