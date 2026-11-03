import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { DownloadIcon } from "./icons";
import { SelectionAction, SelectionBar } from "./SelectionBar";

it("labels the toolbar with the count and offers exit, select all, clear and the actions", () => {
  const $ = load(renderToStaticMarkup(
    <MantineProvider>
      <SelectionBar
        actions={<SelectionAction icon={DownloadIcon} label="Download" onClick={vi.fn()} />}
        clearDisabled={false}
        label="3 selected"
        onClear={vi.fn()}
        onExit={vi.fn()}
        onSelectAll={vi.fn()}
        selectAllDisabled={false}
        selectAllPending={false}
      />
    </MantineProvider>,
  ));
  const toolbar = $("[role=toolbar]");
  expect(toolbar.attr("aria-label")).toBe("3 selected");
  expect(toolbar.find("button[aria-label='selection.exit']")).toHaveLength(1);
  const labels = toolbar.find("button").map((_, button) => $(button).text()).get();
  expect(labels).toEqual(expect.arrayContaining(["selection.selectAll", "common.clear", "Download"]));
});

it("hides the phone navigation while the selection bar is shown", () => {
  const css = readFileSync(new URL("../../styles/ui.css", import.meta.url), "utf8");
  const phone = css.slice(css.lastIndexOf("@media (max-width: 767px)"));
  expect(phone).toMatch(/body\[data-norea-selection-bar\] \.norea-mobile-nav \{\s*visibility: hidden;/);
});
