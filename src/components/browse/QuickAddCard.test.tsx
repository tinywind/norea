import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { QuickAddCard } from "./QuickAddCard";

function render(props: { inLibrary?: boolean; pending?: boolean } = {}) {
  return load(renderToStaticMarkup(
    <MantineProvider>
      <QuickAddCard className="norea-source-card" inLibrary={props.inLibrary ?? false} name="Book" onAdd={vi.fn()} onOpen={vi.fn()} pending={props.pending ?? false}>
        <span>Book</span>
      </QuickAddCard>
    </MantineProvider>,
  ));
}

it("keeps the card one open button with a sibling + for works outside the library", () => {
  const $ = render();
  expect($(".norea-quick-add-card > button.norea-source-card")).toHaveLength(1);
  expect($("button button")).toHaveLength(0);
  expect($(".norea-quick-add-button").attr("aria-label")).toBe("quickAdd.addNamed");
});

it("drops the + once the work is in the library", () => {
  expect(render({ inLibrary: true })(".norea-quick-add-button")).toHaveLength(0);
});

it("shows a pending state and disables the + while the add runs", () => {
  const $ = render({ pending: true });
  expect($(".norea-quick-add-card").attr("data-pending")).toBe("true");
  expect($("[role=status]").attr("aria-label")).toBe("quickAdd.adding");
  expect($(".norea-quick-add-button").attr("disabled")).toBeDefined();
  expect($(".norea-source-card").attr("aria-busy")).toBe("true");
});

it("keeps a long-press from selecting the card's title text", () => {
  const css = readFileSync(new URL("../../styles/browse.css", import.meta.url), "utf8");
  const rule = /\.norea-quick-add-card \{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(rule).toContain("user-select: none;");
  expect(rule).toContain("-webkit-touch-callout: none;");
});
