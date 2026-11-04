import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { readFileSync } from "node:fs";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChapterListRow, RecentlyReadEntry } from "../../db/queries/chapter";
import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";

const next = vi.hoisted(() => ({ data: undefined as unknown }));

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
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { enabled: boolean }) => ({ data: options.enabled ? next.data : undefined }),
}));

import { HistoryRow } from "./HistoryRows";

const entry: RecentlyReadEntry = {
  chapterId: 52,
  chapterName: "Chapter 52",
  chapterNumber: null,
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
          onOpenNovel={vi.fn()}
          onRemove={vi.fn()}
          removing={false}
          {...overrides}
        />
      </MantineProvider>,
    ),
  );
}

afterEach(() => {
  next.data = undefined;
});

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

  it("names the chapter by its number, not its list position", () => {
    expect(render({ entry: { ...entry, chapterNumber: "7", position: 1 } }).text()).toContain("Ch. 7 · 45% · 3h ago");
  });

  it("names a chapter without a known number by its title and leaves out an unstarted 0%", () => {
    const unstarted = render({ entry: { ...entry, chapterName: "Prologue", chapterNumber: "0", position: 1, progress: 0 } });
    expect(unstarted.text()).toContain("Prologue · 3h ago");
    expect(unstarted.text()).not.toContain("Ch. 0");
    expect(unstarted.text()).not.toContain("0%");
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

describe("HistoryRow actions", () => {
  let harness: BackNavigationHarness | undefined;
  let tree: ReturnType<typeof HistoryRow> | undefined;
  const onContinue = vi.fn();
  const onOpenNovel = vi.fn();
  const onRemove = vi.fn();

  afterEach(async () => {
    await harness?.unmount();
    harness = undefined;
    vi.clearAllMocks();
  });

  async function mount(row: RecentlyReadEntry) {
    function Probe() {
      tree = HistoryRow({ entry: row, onContinue, onOpenNovel, onRemove, removing: false });
      return null;
    }
    harness = mountBackNavigationHarness();
    await harness.render(<Probe />);
    const elements = collectElements(tree);
    return {
      menu: elements.find((element) => Array.isArray(element.props.items))!.props.items as {
        danger?: boolean;
        label: string;
        onClick: () => void;
      }[],
      row: elements.find((element) => element.props.title === row.novelName)!,
    };
  }

  it("continues an unfinished chapter on tap", async () => {
    const { row } = await mount(entry);
    (row.props.onClick as () => void)();
    expect(onContinue).toHaveBeenCalledWith(undefined);
  });

  it("names the next chapter of a finished one and continues there", async () => {
    const nextChapter = { id: 53, position: 53 } as ChapterListRow;
    next.data = nextChapter;
    const finished = { ...entry, progress: 100 };
    expect(render({ entry: finished }).text()).toContain('history.nextChapter{"number":"53"} · 3h ago');
    const { row } = await mount(finished);
    (row.props.onClick as () => void)();
    expect(onContinue).toHaveBeenCalledWith(nextChapter);
  });

  it("keeps novel details and a danger removal in the overflow", async () => {
    const { menu } = await mount(entry);
    expect(menu.map((item) => [item.label, item.danger ?? false])).toEqual([
      ["history.novelDetails", false],
      ["history.remove", true],
    ]);
    menu[0]!.onClick();
    menu[1]!.onClick();
    expect(onOpenNovel).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
