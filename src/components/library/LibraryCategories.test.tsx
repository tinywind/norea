import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { LibraryCategory } from "../../db/queries/category";

vi.mock("../../i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) =>
      Object.entries(values).reduce((message, [, value]) => `${message}:${String(value)}`, key),
  }),
}));

import { collectElements, mountBackNavigationHarness } from "../../lib/android-back-navigation.test-support";
import { CategoryList, CategoryTabs, getLibraryCategoryEntries, type LibraryCategoryEntry } from "./LibraryCategories";

const categories: LibraryCategory[] = [
  { id: 1, name: "Default", sort: 0, isSystem: true, novelCount: 2 },
  { id: 4, name: "Reading", sort: 1, isSystem: false, novelCount: 8 },
];
const entries = getLibraryCategoryEntries(categories, { all: 120, uncategorized: 4 }, (key) => key);

it("orders All, the user's categories and Uncategorized, each with its count", () => {
  expect(entries.map((entry) => [entry.label, entry.count])).toEqual([
    ["categories.all", 120], ["Default", 2], ["Reading", 8], ["categories.uncategorized", 4],
  ]);
});

it("marks only the active category tab as pressed", () => {
  const $ = load(renderToStaticMarkup(
    <MantineProvider>
      <CategoryTabs activeId={4} entries={entries} onSelect={vi.fn()} />
    </MantineProvider>,
  ));
  const pressed = $("button[aria-pressed=true]");
  expect(pressed).toHaveLength(1);
  expect(pressed.text()).toBe("Reading8");
  expect($("button")).toHaveLength(4);
});

it("offers rename and delete only for categories the user created, beside the row button", () => {
  const $ = load(renderToStaticMarkup(
    <MantineProvider>
      <CategoryList
        activeId={null} entries={entries} error={new Error("SQLITE_BUSY")} loading={false}
        onCreate={vi.fn()} onDelete={vi.fn()} onRename={vi.fn()} onSelect={vi.fn()}
      />
    </MantineProvider>,
  ));
  expect($("button[aria-label^='categories.actionsFor']").map((_, button) => $(button).attr("aria-label")).get())
    .toEqual(["categories.actionsFor:Reading"]);
  expect($("button button")).toHaveLength(0);
  expect($("button[aria-current=true]").text()).toBe("categories.all120");
  expect($("[role=alert]").text()).toBe("categories.loadFailed");
  expect($("[role=alert]").text()).not.toContain("SQLITE_BUSY");
});

function categoryTabsHarness() {
  const harness = mountBackNavigationHarness();
  const scrollBy = vi.fn();
  const scrollIntoView = vi.fn();
  let bounds = { left: 280, right: 400 };
  const tab = { getBoundingClientRect: () => bounds, scrollIntoView } as unknown as HTMLButtonElement;
  const strip = {
    clientLeft: 0, clientWidth: 160, getBoundingClientRect: () => ({ left: 100 }), scrollBy,
  };
  let resize: (() => void) | undefined;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  let tree: ReturnType<typeof CategoryTabs>;
  const onSelect = vi.fn();
  function Probe({ activeId, values }: { activeId: number | null; values: readonly LibraryCategoryEntry[] }) {
    tree = CategoryTabs({ activeId, entries: values, onSelect });
    (tree.props.ref as { current: unknown }).current = strip;
    const active = collectElements(tree).find((element) => element.props["aria-pressed"] === true);
    if (active) (active.props.ref as { current: unknown }).current = tab;
    return null;
  }
  const buttons = () => collectElements(tree).filter((element) => "aria-pressed" in element.props);
  return {
    onSelect, scrollBy, scrollIntoView,
    render: (activeId: number | null, values = entries) => harness.render(<Probe activeId={activeId} values={values} />),
    resize: () => resize?.(),
    setBounds: (left: number, right: number) => { bounds = { left, right }; },
    focusFirst: () => (buttons()[0]!.props.onFocus as (event: { currentTarget: HTMLButtonElement }) => void)({ currentTarget: tab }),
    selectLast: () => (buttons().at(-1)!.props.onClick as () => void)(),
    unmount: harness.unmount,
  };
}

it("reveals active and keyboard-focused categories by moving only their horizontal strip", async () => {
  const harness = categoryTabsHarness();
  try {
    await harness.render(4);
    expect(harness.scrollBy).toHaveBeenLastCalledWith({ left: 140 });
    expect(harness.scrollIntoView).not.toHaveBeenCalled();

    harness.scrollBy.mockClear();
    harness.setBounds(140, 230);
    harness.resize();
    expect(harness.scrollBy).not.toHaveBeenCalled();
    harness.setBounds(70, 180);
    harness.resize();
    expect(harness.scrollBy).toHaveBeenLastCalledWith({ left: -30 });

    harness.setBounds(280, 400);
    harness.focusFirst();
    expect(harness.scrollBy).toHaveBeenLastCalledWith({ left: 140 });
    expect(harness.onSelect).not.toHaveBeenCalled();
    expect(harness.scrollIntoView).not.toHaveBeenCalled();
  } finally {
    await harness.unmount();
  }
});

it("reveals a restored last category after its entries load and preserves its selection callback", async () => {
  const harness = categoryTabsHarness();
  const manyEntries = [...entries, ...Array.from({ length: 6 }, (_, index) => ({
    id: index + 10, count: index, label: `Category ${index + 10}`,
  }))];
  try {
    await harness.render(15);
    expect(harness.scrollBy).not.toHaveBeenCalled();
    await harness.render(15, manyEntries);
    expect(harness.scrollBy).toHaveBeenCalledExactlyOnceWith({ left: 140 });
    harness.selectLast();
    expect(harness.onSelect).toHaveBeenCalledExactlyOnceWith(15);

    harness.scrollBy.mockClear();
    await harness.render(15, manyEntries.map((entry) => ({ ...entry, count: entry.count + 1 })));
    expect(harness.scrollBy).not.toHaveBeenCalled();
  } finally {
    await harness.unmount();
  }
});
