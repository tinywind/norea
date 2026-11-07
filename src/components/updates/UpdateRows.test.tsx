import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LibraryUpdateEntry } from "../../db/queries/chapter";

vi.mock("../../i18n", () => ({
  formatRelativeTimeForLocale: () => "2h ago",
  useTranslation: () => ({
    locale: "en",
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}${JSON.stringify(values)}` : key,
  }),
}));
vi.mock("../../lib/use-novel-cover-source", () => ({ useNovelCoverSource: () => null }));

import { UpdateRow, UpdateRunRow } from "./UpdateRows";

const entry: LibraryUpdateEntry = {
  chapterId: 7,
  chapterName: "The Return",
  chapterPath: "/c/7",
  contentType: "html",
  sortAt: 1,
  isDownloaded: false,
  novelCover: null,
  novelId: 3,
  novelIsLocal: false,
  novelName: "Novel A",
  novelPath: "/n/3",
  pluginId: "source-foo",
  pluginName: "Source Foo",
  position: 120,
};

const render = (node: ReactElement) =>
  load(renderToStaticMarkup(<MantineProvider>{node}</MantineProvider>));

const rowProps = {
  downloadStatus: undefined,
  entry,
  onDownload: vi.fn(),
  onOpen: vi.fn(),
  onOpenNovel: vi.fn(),
};

describe("UpdateRow", () => {
  it("puts the cover, the row body and the row actions side by side with no nested controls", () => {
    const $ = render(<UpdateRow {...rowProps} />);
    expect($("button button, button a, button input")).toHaveLength(0);
    const buttons = $("button").toArray().map((button) => $(button).attr("aria-label") ?? $(button).text());
    expect(buttons).toEqual([
      'updates.openNovel{"name":"Novel A"}',
      "Novel AThe ReturnSource Foo · 2h ago",
      "novel.downloadChapter",
      "updates.openNovelAction",
    ]);
  });

  it("names the source as text and drops the always-on unread flag", () => {
    const $ = render(<UpdateRow {...rowProps} />);
    expect($.text()).toContain("Source Foo");
    expect($('[role="img"]').toArray().map((node) => $(node).attr("aria-label"))).toEqual([]);
  });

  it("shows one download state at a time", () => {
    expect(render(<UpdateRow {...rowProps} entry={{ ...entry, isDownloaded: true }} />)(
      '[role="img"][aria-label="novel.downloaded"]',
    )).toHaveLength(1);
    expect(render(<UpdateRow {...rowProps} downloadStatus={{ kind: "running" }} />)(
      '[role="status"][aria-label="common.downloading"]',
    )).toHaveLength(1);
    const failed = render(<UpdateRow {...rowProps} downloadStatus={{ error: "Timed out", kind: "failed" }} />);
    expect(failed('button[aria-label="novel.retryDownload"]').attr("title")).toBe("novel.retryDownload: Timed out");
    expect(failed('button[aria-label="novel.downloadChapter"]')).toHaveLength(0);
  });

  it("leaves the cover and the novel name to the run row when nested", () => {
    const $ = render(<UpdateRow {...rowProps} nested />);
    expect($('button[aria-label^="updates.openNovel{"]')).toHaveLength(0);
    expect($("button").first().text()).toBe("The ReturnSource Foo · 2h ago");
  });
});

it("collapses a run into one row that names the count and toggles its chapters", () => {
  const props = {
    count: 8,
    earliest: entry,
    onOpenEarliest: vi.fn(),
    onOpenNovel: vi.fn(),
    onToggle: vi.fn(),
  };
  const collapsed = render(<UpdateRunRow {...props} expanded={false} />);
  expect(collapsed.text()).toContain('updates.runTitle{"count":8,"name":"Novel A"}');
  expect(collapsed("button[aria-expanded]").attr("aria-expanded")).toBe("false");
  expect(collapsed("button button")).toHaveLength(0);
  expect(render(<UpdateRunRow {...props} expanded />)("button[aria-expanded]").attr("aria-label")).toBe(
    'updates.collapseRun{"name":"Novel A"}',
  );
});
