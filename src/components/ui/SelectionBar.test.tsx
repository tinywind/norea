import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { readFileSync } from "node:fs";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { DownloadIcon } from "./icons";
import { SelectionAction, SelectionBar, SelectionOverflowMenu } from "./SelectionBar";

function renderBar(props: Partial<ComponentProps<typeof SelectionBar>> = {}) {
  return load(renderToStaticMarkup(
    <MantineProvider>
      <SelectionBar
        actions={<SelectionAction icon={DownloadIcon} label="Download" onClick={vi.fn()} />}
        allSelected={false}
        label="3 selected"
        onDeselectAll={vi.fn()}
        onExit={vi.fn()}
        onSelectAll={vi.fn()}
        selectAllDisabled={false}
        selectAllPending={false}
        {...props}
      />
    </MantineProvider>,
  ));
}

const buttonLabels = ($: ReturnType<typeof renderBar>) =>
  $("[role=toolbar] button").map((_, button) => $(button).attr("aria-label") ?? $(button).text()).get();

it("labels the toolbar with the count and offers done, one select-all toggle and the actions", () => {
  const $ = renderBar();
  const toolbar = $("[role=toolbar]");
  expect(toolbar.attr("aria-label")).toBe("3 selected");
  expect(toolbar.find("button[aria-label='selection.exit']")).toHaveLength(1);
  expect(buttonLabels($)).toEqual(expect.arrayContaining(["selection.selectAll", "Download"]));
  expect(buttonLabels($)).not.toContain("selection.deselectAll");
  expect(buttonLabels($)).not.toContain("common.clear");
});

it("turns the toggle into deselect all once everything is selected", () => {
  const labels = buttonLabels(renderBar({ allSelected: true }));
  expect(labels).toContain("selection.deselectAll");
  expect(labels).not.toContain("selection.selectAll");
});

it("announces a hint under the count inside the title slot and describes the toolbar with it", () => {
  const $ = renderBar({ hint: "Tap to select" });
  const hint = $("[role=status]");
  expect(hint.text()).toBe("Tap to select");
  expect(hint.parent().hasClass("norea-app-bar-title")).toBe(true);
  expect($("[role=toolbar]").attr("aria-describedby")).toBe(hint.attr("id"));
  expect(renderBar()("[role=status]")).toHaveLength(0);
  expect($(".norea-app-bar-subrow")).toHaveLength(0);
});

it("is the page header in its selection state, with close where back sits", () => {
  const $ = renderBar();
  const header = $("header.norea-app-bar.norea-selection-bar");
  expect(header.attr("role")).toBe("toolbar");
  expect(header.attr("data-has-back")).toBe("true");
  const row = header.children(".norea-app-bar-row");
  expect(row.children().first().attr("aria-label")).toBe("selection.exit");
  expect(row.children(".norea-app-bar-title").text()).toBe("3 selected");
  expect(row.find(".norea-app-bar-actions .norea-selection-bar-actions")).toHaveLength(1);
});

it("keeps the header's sub-row so selecting does not move the content", () => {
  const $ = renderBar({ below: <span data-subrow="true" /> });
  expect($(".norea-app-bar-subrow [data-subrow]")).toHaveLength(1);
});

it("draws the phone action bar as the bottom navigation's twin, with the safe area added once", () => {
  const css = readFileSync(new URL("../../styles/ui.css", import.meta.url), "utf8");
  const app = readFileSync(new URL("../../styles/app.css", import.meta.url), "utf8");
  const phone = css.slice(css.lastIndexOf("@media (max-width: 767px)"));
  const bar = /\.norea-selection-bar-actions \{([^}]*)\}/.exec(phone)![1]!;
  const nav = /^\.norea-mobile-nav \{([^}]*)\}/m.exec(app)![1]!;
  const declaration = (body: string, property: string) =>
    new RegExp(`(?:^|;)\\s*${property}: ([^;]+);`).exec(body)?.[1]?.replace(/\s+/g, " ");
  for (const property of ["height", "padding", "box-sizing", "background", "border-top"]) {
    expect(declaration(bar, property), property).toBe(declaration(nav, property));
  }
  expect(bar.match(/safe-area-bottom/g)).toHaveLength(1);
  expect(phone).not.toMatch(/\.norea-selection-bar-actions \{[^}]*margin/);
});

it("gives every bottom action, including overflow, a visible label", () => {
  const $ = renderBar({
    actions: (
      <>
        <SelectionAction icon={DownloadIcon} label="Download" onClick={vi.fn()} />
        <SelectionOverflowMenu items={[]} label="More" />
      </>
    ),
  });
  const actions = $(".norea-selection-bar-actions").children();
  expect(actions.map((_, action) => $(action).text()).get()).toEqual(["Download", "More"]);
  expect(actions.last().attr("aria-haspopup")).toBe("menu");
  expect(actions.last().attr("aria-expanded")).toBe("false");
});

it("hides the phone navigation while the selection bar is shown", () => {
  const css = readFileSync(new URL("../../styles/ui.css", import.meta.url), "utf8");
  const phone = css.slice(css.lastIndexOf("@media (max-width: 767px)"));
  expect(phone).toMatch(/body\[data-norea-selection-bar\] \.norea-mobile-nav \{\s*visibility: hidden;/);
});

it("preserves a short visible label, descriptive accessible name and disabled menu trigger", () => {
  const $ = renderBar({
    actions: (
      <>
        <SelectionAction aria-label="Mark selected novels read" icon={DownloadIcon} label="Read" />
        <SelectionOverflowMenu disabled items={[]} label="More" />
      </>
    ),
  });
  const actions = $(".norea-selection-bar-actions button");
  expect(actions.first().text()).toBe("Read");
  expect(actions.first().attr("aria-label")).toBe("Mark selected novels read");
  expect(actions.last().text()).toBe("More");
  expect(actions.last().attr("disabled")).toBeDefined();
});
