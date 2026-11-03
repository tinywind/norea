import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { readFileSync } from "node:fs";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RecentlyReadEntry } from "../../db/queries/chapter";

vi.mock("../../i18n", () => ({
  formatRelativeTimeForLocale: () => "3h ago",
  useTranslation: () => ({
    locale: "en",
    t: (key: string, values?: Record<string, unknown>) =>
      key === "history.chapterNumber"
        ? `Ch. ${values?.number}`
        : values
          ? `${key}${JSON.stringify(values)}`
          : key,
  }),
}));
vi.mock("../../lib/use-novel-cover-source", () => ({ useNovelCoverSource: () => null }));
vi.mock("../../lib/plugins/manager", () => ({ pluginManager: { getPlugin: () => undefined } }));

import { HistoryRow } from "./HistoryRows";

const entry: RecentlyReadEntry = {
  chapterId: 52,
  chapterName: "Chapter 52",
  novelCover: null,
  novelId: 4,
  novelInLibrary: true,
  novelIsLocal: false,
  novelName: "Novel Title",
  novelPath: "/n/4",
  pluginId: "source",
  position: 52,
  progress: 45,
  readAt: 1,
};

function render(overrides: Partial<ComponentProps<typeof HistoryRow>> = {}) {
  return load(
    renderToStaticMarkup(
      <MantineProvider>
        <HistoryRow
          entry={entry}
          onContinue={vi.fn()}
          onOpen={vi.fn()}
          onRemove={vi.fn()}
          removing={false}
          {...overrides}
        />
      </MantineProvider>,
    ),
  );
}

describe("HistoryRow", () => {
  it("keeps the row body and its actions as sibling controls", () => {
    const $ = render();
    expect($("button button, button a, button input")).toHaveLength(0);
    const row = $("button").first();
    row.find('[aria-hidden="true"]').remove();
    expect(row.text()).toBe("Novel TitleCh. 52 · 45% · 3h ago");
  });

  it("shows progress and time as one meta line with a thin bar", () => {
    const $ = render();
    expect($('[aria-hidden="true"] [style="--norea-history-progress:45%"]')).toHaveLength(1);
    expect(render({ entry: { ...entry, progress: 100 } }).text()).toContain("Ch. 52 · common.finished · 3h ago");
  });

  it("replaces the row actions with a status while the novel is being removed", () => {
    const $ = render({ removing: true });
    expect($('[role="status"]').attr("aria-label")).toBe("history.removing");
    expect($("button")).toHaveLength(1);
  });
});

it("keeps the meta line and progress bar visible on phones", () => {
  const css = readFileSync(new URL("../../styles/history.css", import.meta.url), "utf8");
  expect(css).not.toMatch(/display:\s*none/);
});
