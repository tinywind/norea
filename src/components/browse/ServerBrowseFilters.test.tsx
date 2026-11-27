import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import en from "../../../strings/languages/en/app.json";
import ko from "../../../strings/languages/ko/app.json";

const locale = vi.hoisted(() => ({ strings: {} as Record<string, string> }));
vi.mock("../../i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) =>
      Object.entries(values).reduce(
        (message, [name, value]) => message.replace(`{${name}}`, String(value)),
        locale.strings[key] ?? key,
      ),
  }),
}));

import { Checkbox, Radio, TextInput } from "@mantine/core";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";
import { ChipButton } from "../ChipButton";
import { UserCategoryName } from "../UserCategoryName";
import { ResponsiveSheet } from "../ui/ResponsiveSheet";
import { ServerBrowseFilters, type ServerBrowseFilterSelection } from "./ServerBrowseFilters";

let harness: BackNavigationHarness | undefined;
let tree: ReactNode;
const onChange = vi.fn();
const sources = [{ id: "source-a", workCount: 1200 }, { id: "source-b", workCount: 3 }];
const statuses = [
  { status: "Ongoing" as const, workCount: 40 },
  { status: "Completed" as const, workCount: 12 },
  { status: "On Hiatus" as const, workCount: 2 },
];
const categories = [
  { id: "cat-reading", name: "Reading", workCount: 25 },
  { id: "cat-done", name: "Finished", workCount: 10 },
];
const tags = [
  { tag: "Fantasy", workCount: 30 },
  { tag: "Drama", workCount: 8 },
];

const EMPTY_SELECTION: ServerBrowseFilterSelection = {
  categories: [],
  source: "",
  statuses: [],
  tags: [],
  uncategorized: false,
};

function Probe({ filter }: { filter: ServerBrowseFilterSelection }) {
  tree = ServerBrowseFilters({
    categories,
    filter,
    filtersLoading: false,
    onChange,
    sourceName: id => id === "source-a" ? "Source A" : id,
    sources,
    statuses,
    tags,
    uncategorizedCount: 4,
  });
  return null;
}

async function render(filter: Partial<ServerBrowseFilterSelection> = {}) {
  harness = mountBackNavigationHarness();
  await harness.render(<Probe filter={{ ...EMPTY_SELECTION, ...filter }} />);
  const elements = collectElements(tree);
  return {
    chip: (label: string) => elements.filter(element => {
      if (element.type !== ChipButton) return false;
      const children = element.props.children as ReactNode;
      return children === label || collectElements(children).some(
        child => child.type === UserCategoryName && child.props.name === label,
      );
    }),
    elements,
  };
}

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
});

beforeEach(() => onChange.mockClear());

it.each([en, ko])("offers Ongoing and Completed as pressable status chips beside the filter sheet, without Clear when nothing is filtered", async (strings) => {
  locale.strings = strings;
  const { chip } = await render();
  expect(chip(strings["novel.status.ongoing"])[0]!.props.selected).toBe(false);
  expect(chip(strings["novel.status.completed"])[0]!.props.selected).toBe(false);
  expect(chip(strings["contentSync.filters.more"])).toHaveLength(1);
  expect(chip(strings["common.clear"])).toHaveLength(0);
  (chip(strings["novel.status.completed"])[0]!.props.onClick as () => void)();
  expect(onChange).toHaveBeenLastCalledWith({ statuses: ["Completed"] });
});

it.each([en, ko])("counts categories, uncategorized, statuses, source, and tags, toggles active chips off, and clears all filters", async (strings) => {
  locale.strings = strings;
  const { chip } = await render({
    categories: ["cat-reading"],
    source: "source-a",
    statuses: ["Ongoing", "On Hiatus"],
    tags: ["Fantasy"],
    uncategorized: true,
  });
  expect(chip(strings["novel.status.ongoing"])[0]!.props.selected).toBe(true);
  expect(chip(strings["novel.status.onHiatus"])[0]!.props.selected).toBe(true);
  expect(chip("Reading")[0]!.props.selected).toBe(true);
  expect(chip(strings["categories.uncategorized"])[0]!.props.selected).toBe(true);
  expect(chip("Fantasy")[0]!.props.selected).toBe(true);
  expect(chip(strings["contentSync.filters.moreActive"].replace("{count}", "6"))).toHaveLength(1);

  (chip(strings["novel.status.ongoing"])[0]!.props.onClick as () => void)();
  expect(onChange).toHaveBeenLastCalledWith({ statuses: ["On Hiatus"] });

  (chip("Reading")[0]!.props.onClick as () => void)();
  expect(onChange).toHaveBeenLastCalledWith({ categories: [] });

  (chip(strings["categories.uncategorized"])[0]!.props.onClick as () => void)();
  expect(onChange).toHaveBeenLastCalledWith({ uncategorized: false });

  (chip("Fantasy")[0]!.props.onClick as () => void)();
  expect(onChange).toHaveBeenLastCalledWith({ tags: [] });

  (chip(strings["common.clear"])[0]!.props.onClick as () => void)();
  expect(onChange).toHaveBeenLastCalledWith({
    categories: [],
    source: "",
    statuses: [],
    tags: [],
    uncategorized: false,
  });
});

it("renders categories, canonical statuses, sources, and searchable tags with the library filter grid classes", async () => {
  locale.strings = en;
  const { elements } = await render({ statuses: ["Completed"], source: "" });
  const sheet = elements.find(element => element.type === ResponsiveSheet)!;
  expect(sheet.props.className).toBe("norea-library-view-options");
  const sheetElements = collectElements(sheet.props.children as ReactNode);

  const grids = sheetElements.filter(
    element => typeof element.props.className === "string" && element.props.className.includes("norea-library-filter-grid"),
  );
  expect(grids).toHaveLength(4);

  const checkboxGroups = sheetElements.filter(element => element.type === Checkbox.Group);
  expect(checkboxGroups.map(group => group.props.label)).toEqual([
    en["categories.title"],
    en["library.statusFilters.title"],
  ]);

  const categoryCheckboxes = collectElements(checkboxGroups[0]!.props.children as ReactNode).filter(element => element.type === Checkbox);
  expect(categoryCheckboxes.map(box => box.props.value)).toEqual(["cat-reading", "cat-done", "$uncategorized"]);
  (checkboxGroups[0]!.props.onChange as (values: string[]) => void)(["cat-reading", "$uncategorized"]);
  expect(onChange).toHaveBeenLastCalledWith({ categories: ["cat-reading"], uncategorized: true });

  const statusCheckboxes = collectElements(checkboxGroups[1]!.props.children as ReactNode).filter(element => element.type === Checkbox);
  expect(statusCheckboxes.map(box => box.props.value)).toEqual(["Ongoing", "Completed", "On Hiatus"]);
  (checkboxGroups[1]!.props.onChange as (values: string[]) => void)(["Completed", "On Hiatus"]);
  expect(onChange).toHaveBeenLastCalledWith({ statuses: ["Completed", "On Hiatus"] });

  const sourceGroup = sheetElements.find(element => element.type === Radio.Group)!;
  expect(sourceGroup.props.label).toBe(en["library.sources.title"]);
  const sourceRadios = collectElements(sourceGroup.props.children as ReactNode).filter(element => element.type === Radio);
  expect(sourceRadios.map(radio => radio.props.value)).toEqual(["", "source-a", "source-b"]);
  const counts = collectElements(sourceRadios[1]!.props.label as ReactNode).filter(element => element.props.className === "norea-library-option-count");
  expect(counts[0]!.props.children).toBe((1200).toLocaleString());
  (sourceGroup.props.onChange as (value: string) => void)("source-b");
  expect(onChange).toHaveBeenLastCalledWith({ source: "source-b" });

  const tagInput = sheetElements.find(element => element.type === TextInput)!;
  expect(tagInput.props.placeholder).toBe(en["library.tagFilters.searchPlaceholder"]);
  const tagList = sheetElements.find(
    element => typeof element.props.className === "string" && element.props.className.includes("norea-library-tag-list"),
  )!;
  const tagCheckboxes = collectElements(tagList.props.children as ReactNode).filter(element => element.type === Checkbox);
  expect(tagCheckboxes).toHaveLength(2);
  (tagCheckboxes[0]!.props.onChange as () => void)();
  expect(onChange).toHaveBeenLastCalledWith({ tags: ["Fantasy"] });
});
