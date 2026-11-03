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

import { CategoryList, CategoryTabs, getLibraryCategoryEntries } from "./LibraryCategories";

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
