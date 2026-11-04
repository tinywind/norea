import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterListRow } from "../../db/queries/chapter";
import type { ChapterItem } from "../../lib/plugins/types";

const media = vi.hoisted(() => ({ desktop: false }));

vi.mock("@mantine/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mantine/hooks")>()),
  useMediaQuery: () => media.desktop,
}));
vi.mock("../../i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      values ? `${key}(${Object.values(values).join("|")})` : key,
  }),
}));
vi.mock("../SourceNovelCover", () => ({ SourceNovelCover: () => null }));
vi.mock("../../lib/plugins/manager", () => ({
  pluginManager: { getPlugin: () => undefined },
}));

import { MergeChooseStep } from "./MergeChooseStep";
import { MergeConfirmStep } from "./MergeConfirmStep";
import { MergeMapStep } from "./MergeMapStep";

function sourceChapter(
  id: number,
  chapterNumber: string,
  overrides: Partial<ChapterListRow> = {},
): ChapterListRow {
  return {
    bookmark: false,
    chapterNumber,
    contentBytes: 0,
    contentType: "html",
    createdAt: null,
    foundAt: 0,
    id,
    isDownloaded: false,
    mediaBytes: 0,
    mediaRepairNeeded: false,
    name: `Source ${chapterNumber}`,
    novelId: 1,
    page: "1",
    path: `/s/${id}`,
    position: id,
    progress: 0,
    readAt: null,
    releaseTime: null,
    sourceContentType: "html",
    unread: true,
    updatedAt: 0,
    ...overrides,
  };
}

const targetChapters: ChapterItem[] = [
  { chapterNumber: 1, name: "Target 1", path: "/t/1" },
  { chapterNumber: 2, name: "Target 2", path: "/t/2" },
];

function render(node: ReactElement) {
  return load(renderToStaticMarkup(<MantineProvider>{node}</MantineProvider>));
}

function renderMapStep(overrides: Partial<Parameters<typeof MergeMapStep>[0]> = {}) {
  return render(
    <MergeMapStep
      canContinue={false}
      conflicts={[{ sourceChapterIds: [1, 2], targetChapterPath: "/t/1" }]}
      copyChoices={{}}
      decisions={{
        1: { kind: "map", sourceChapterId: 1, targetChapterPath: "/t/1" },
        2: { kind: "map", sourceChapterId: 2, targetChapterPath: "/t/1" },
      }}
      matching={{
        ambiguous: [
          { candidateTargetPaths: ["/t/1"], reason: "repeatedNumber", sourceChapterId: 2 },
        ],
        matched: [{ sourceChapterId: 1, targetChapterPath: "/t/1" }],
        unmatchedSourceChapterIds: [3],
      }}
      onContinue={vi.fn()}
      onCopyChoiceChange={vi.fn()}
      onDecisionChange={vi.fn()}
      onExcludeRemaining={vi.fn()}
      sourceChapters={[
        sourceChapter(1, "1", { isDownloaded: true }),
        sourceChapter(2, "1", { isDownloaded: true }),
        sourceChapter(3, "300"),
      ]}
      targetChapters={targetChapters}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  media.desktop = false;
});

describe("MergeMapStep", () => {
  it("lists copy conflicts, unmatched and ambiguous rows, and a collapsed matched toggle", () => {
    const $ = renderMapStep();
    const list = $("[role=list][aria-label='novelMerge.map.sourceChapters']");

    expect(list.find("h3").map((_, heading) => $(heading).text()).get()).toEqual([
      "novelMerge.map.section.conflicts(1)",
      "novelMerge.map.section.unmatched(1)",
      "novelMerge.map.section.ambiguous(1)",
    ]);
    const toggle = list.find("button[aria-expanded]");
    expect(toggle.attr("aria-expanded")).toBe("false");
    expect(toggle.text()).toBe("novelMerge.map.section.matched(1)");
    expect(list.text()).not.toContain("Source 1 ");
  });

  it("asks which download to keep for each copy conflict", () => {
    const $ = renderMapStep();
    const choice = $(".norea-merge-conflict-row");

    expect(choice.text()).toContain("novelMerge.conflict.keep");
    expect(choice.find("input[type=radio]")).toHaveLength(2);
    expect(choice.find("input[type=radio]:checked")).toHaveLength(0);
  });

  it("opens the target picker from each phone row as a dialog", () => {
    const $ = renderMapStep();
    const rows = $("button.norea-merge-source-row");

    expect(rows).toHaveLength(2);
    rows.each((_, row) => {
      expect($(row).attr("aria-haspopup")).toBe("dialog");
      expect($(row).attr("aria-pressed")).toBeUndefined();
    });
    expect($(".norea-merge-panes")).toHaveLength(0);
    expect(rows.first().text()).toContain("novelMerge.map.chooseTarget");
    expect(rows.last().text()).toContain("novelMerge.map.mappedTo");
  });

  it("marks each row's decision and each open conflict with a status icon", () => {
    const $ = renderMapStep();
    const rows = $("button.norea-merge-source-row");

    expect(rows.first().attr("data-undecided")).toBe("true");
    expect(rows.first().find(".norea-list-item-leading .norea-merge-row-status")).toHaveLength(1);
    expect(rows.last().find(".norea-list-item-leading .norea-merge-row-status")).toHaveLength(1);
    expect($(".norea-merge-conflict-row:not([data-resolved]) .norea-merge-conflict-title .norea-merge-row-status")).toHaveLength(1);
  });

  it("shows the source list and the target picker side by side on desktop", () => {
    media.desktop = true;
    const $ = renderMapStep();
    const panes = $(".norea-merge-panes > section");

    expect(panes).toHaveLength(2);
    expect(panes.last().find("input[type=search]")).toHaveLength(1);
    const targets = panes.last().find("button.norea-merge-target-row");
    expect(targets).toHaveLength(2);
    const active = $("button.norea-merge-source-row[aria-pressed=true]");
    expect(active).toHaveLength(1);
    expect(active.text()).toContain("Source 300");
  });

  it("offers to exclude remaining chapters and blocks Continue until every decision is valid", () => {
    const $ = renderMapStep();
    const buttons = $("button").map((_, button) => $(button).text()).get();

    expect(buttons).toContain("novelMerge.map.excludeRemaining(1)");
    expect(buttons).toContain("novelMerge.map.reviewNext");
    const continueButton = $("button").filter((_, button) => $(button).text() === "novelMerge.continue");
    expect(continueButton.attr("disabled")).toBeDefined();
    expect($(".norea-merge-footer").text()).toContain("novelMerge.map.undecidedRemaining(1)");
  });

  it("virtualizes long source lists", () => {
    const sources = Array.from({ length: 2000 }, (_, index) =>
      sourceChapter(index + 1, String(index + 1)),
    );
    const $ = renderMapStep({
      conflicts: [],
      decisions: {},
      matching: { ambiguous: [], matched: [], unmatchedSourceChapterIds: sources.map((s) => s.id) },
      sourceChapters: sources,
    });

    expect($("button.norea-merge-source-row").length).toBeLessThan(60);
  });
});

describe("MergeConfirmStep", () => {
  it("names both novels and lists the counts before execution", () => {
    const $ = render(
      <MergeConfirmStep
        error={null}
        onConfirm={vi.fn()}
        pending={false}
        sourceName="Old Home"
        sourcePluginName="Source A"
        summary={{
          copyChoices: 0,
          downloadsMoved: 3,
          downloadsRemoved: 1,
          excluded: 2,
          mapped: 10,
          readDropped: 0,
          readMoved: 4,
        }}
        targetName="New Home"
        targetPluginName="Source B"
      />,
    );
    const counts = $("dl div")
      .map((_, row) => `${$(row).find("dt").text()}=${$(row).find("dd").text()}`)
      .get();

    expect(counts).toEqual([
      "novelMerge.confirm.mapped=10",
      "novelMerge.confirm.excluded=2",
      "novelMerge.confirm.downloadsMoved=3",
      "novelMerge.confirm.downloadsRemoved=1",
      "novelMerge.confirm.readMoved=4",
    ]);
    expect($.text()).toContain("Old Home");
    expect($.text()).toContain("New Home");
    expect($.text()).toContain("novelMerge.confirm.warning(Old Home|New Home)");
  });
});

describe("MergeChooseStep", () => {
  const baseProps = {
    noTargetPlugins: false,
    onCancelSearch: vi.fn(),
    onContinue: vi.fn(),
    onPick: vi.fn(),
    onSearch: vi.fn(),
    onSearchTextChange: vi.fn(),
    pluginsError: null,
    previewError: null,
    previewingKey: null,
    results: [
      {
        novels: [{ name: "Same Novel", path: "/n/1" }],
        pluginId: "b",
        pluginName: "Source B",
      },
      { error: "timed out", novels: [], pluginId: "c", pluginName: "Source C" },
    ],
    searchError: null,
    searchSettled: true,
    searchText: "Same Novel",
    searching: false,
    selectedKey: null,
    sourceName: "Source A",
  };

  it("lists results as buttons and collapses failed sources", () => {
    const $ = render(<MergeChooseStep {...baseProps} />);

    expect($("button.norea-merge-result-row").text()).toContain("Same Novel");
    expect($("details.norea-merge-failed-sources").text()).toContain("Source C");
    expect($(".norea-merge-footer")).toHaveLength(0);
  });

  it("lets a running search be cancelled", () => {
    const $ = render(<MergeChooseStep {...baseProps} searchSettled={false} searching />);

    expect($("[role=status] button").text()).toBe("common.cancel");
  });

  it("marks the selected target and offers to continue with it", () => {
    const $ = render(<MergeChooseStep {...baseProps} selectedKey="b:/n/1" />);

    expect($("button.norea-merge-result-row").attr("aria-current")).toBe("true");
    expect($(".norea-merge-footer button").text()).toBe("novelMerge.continue");
  });
});
