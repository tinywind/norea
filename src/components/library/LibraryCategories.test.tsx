import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import en from "../../../strings/languages/en/app.json";
import ko from "../../../strings/languages/ko/app.json";
import type { LibraryNovelSummary } from "../../db/queries/novel";
import { CategorySubpanel, getLibraryTags, LibraryTagFilters } from "./LibraryCategories";
import { LibraryCommandSearch } from "./LibraryFilters";

const summary: LibraryNovelSummary = {
  completeNovels: 0,
  downloadedChapters: 0,
  downloadedNovels: 0,
  lastUpdatedAt: null,
  localNovels: 0,
  repairNeededNovels: 2,
  totalChapters: 4,
  totalNovels: 3,
  unreadChapters: 4,
  unreadNovels: 3,
};

it.each([en, ko])("renders the localized repair tag with its work count and selected state", (strings) => {
  const t = (key: string) => strings[key as keyof typeof strings] ?? key;
  const tags = getLibraryTags(summary, t);
  const html = renderToStaticMarkup(
    <MantineProvider>
      <LibraryTagFilters activeTags={["repairNeeded"]} onToggle={vi.fn()} tags={tags} t={t} />
    </MantineProvider>,
  );
  const $ = load(html);
  const repair = $("button").filter((_, button) =>
    $(button).find("span").first().text() === "#" + strings["library.tags.repairNeeded"],
  );
  expect(repair).toHaveLength(1);
  expect(repair.attr("aria-pressed")).toBe("true");
  expect(repair.find("span").last().text()).toBe("2");
  expect($("button[aria-pressed=true]")).toHaveLength(1);
});

it("renders no keyboard shortcut hints without matching handlers", () => {
  const t = (key: string) => key;
  const html = renderToStaticMarkup(
    <MantineProvider>
      <LibraryCommandSearch onChange={vi.fn()} value="" />
      <CategorySubpanel
        activeId={null} activeTags={[]} allCount={0} categories={[]} error={null} loading={false}
        onCreate={vi.fn()} onDelete={vi.fn()} onOpenDrawer={vi.fn()} onRename={vi.fn()} onSelect={vi.fn()}
        onToggleTag={vi.fn()} t={t} tags={[]} uncategorizedCount={0}
      />
    </MantineProvider>,
  );
  const $ = load(html);
  expect($("kbd")).toHaveLength(0);
  expect($(".norea-library-subpanel-footer").text()).toBe("library.manageCategories");
  expect(en["library.search.placeholder"]).not.toMatch(/jump/i);
});
