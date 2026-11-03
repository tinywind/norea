import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { translate, type TranslationKey } from "../../i18n";

vi.mock("../../i18n", async (original) => {
  const actual = await original<typeof import("../../i18n")>();
  return { ...actual, useTranslation: () => ({ locale: "en", t: (key: TranslationKey, values?: Record<string, string>) => actual.translate("en", key, values) }) };
});

import { openSettingsSearchResult, SettingsSearch } from "./SettingsSearch";
import { searchSettings } from "./settings-search-index";
import { useSettingsRevealStore } from "./settings-reveal";

function render(query: string) {
  return load(renderToStaticMarkup(
    <MantineProvider>
      <SettingsSearch onQueryChange={vi.fn()} onSelect={vi.fn()} query={query} />
    </MantineProvider>,
  ));
}

describe("SettingsSearch", () => {
  it("shows only the field while the query is empty", () => {
    const $ = render("");
    expect($("input").attr("placeholder")).toBe("Search settings");
    expect($("ul")).toHaveLength(0);
  });

  it("lists matching rows as Section › Row with their notes", () => {
    const $ = render("custom css");
    const rows = $("ul button").map((_, row) => $(row).text()).get();
    expect(rows.some((text) => text.includes(`Reader › ${translate("en", "readerSettings.customCss")}`))).toBe(true);
    expect(rows.some((text) => text.includes("Global default · Under Advanced"))).toBe(true);
  });

  it("says when nothing matches", () => {
    expect(render("zzzz-no-such-setting").text()).toContain("No settings match");
  });
});

it("opens the result's section and asks its row to show itself", () => {
  const result = searchSettings("cooldown", (key) => translate("en", key))[0]!;
  const selectSection = vi.fn();
  openSettingsSearchResult(result, selectSection);
  expect(selectSection).toHaveBeenCalledWith("downloads");
  expect(useSettingsRevealStore.getState().target).toEqual(expect.objectContaining({ label: result.label, section: "downloads" }));
});
