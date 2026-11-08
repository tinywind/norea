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
import { createInitialComposition } from "./merge-composition-editor";

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
  const sources = [sourceChapter(1, "1", { isDownloaded: true }), sourceChapter(2, "2"), sourceChapter(3, "300")];
  const matching = {
    ambiguous: [],
    matched: [{ sourceChapterId: 1, targetChapterPath: "/t/1" }],
    unmatchedSourceChapterIds: [2, 3],
  };
  return render(
    <MergeMapStep
      canContinue
      composition={createInitialComposition(sources, targetChapters, matching)}
      matching={matching}
      onContinue={vi.fn()}
      onCompositionChange={vi.fn()}
      sourceChapters={sources}
      sourceName="Old Home"
      sourcePluginName="Source A"
      targetChapters={targetChapters}
      targetName="New Home"
      targetPluginName="Source B"
      {...overrides}
    />,
  );
}

beforeEach(() => {
  media.desktop = false;
});

describe("MergeMapStep", () => {
  it("shows both complete source lists and the final composition together on small screens", () => {
    const $ = renderMapStep();
    const panes = $(".norea-compose-panes > section");
    expect(panes).toHaveLength(3);
    expect(panes.map((_, pane) => $(pane).attr("data-side")).get()).toEqual(["source", "target", "final"]);
    expect(panes.eq(0).find("button.norea-compose-row")).toHaveLength(3);
    expect(panes.eq(1).find("button.norea-compose-row")).toHaveLength(2);
    expect(panes.eq(2).find("button.norea-compose-row")).toHaveLength(4);
    expect($("[aria-haspopup=dialog]")).toHaveLength(0);
    expect($("input[type=search]")).toHaveLength(3);
    expect(panes.eq(0).text()).toContain("Old Home");
    expect(panes.eq(1).text()).toContain("New Home");
  });

  it("provides bulk selection, range selection, and batch include/exclude controls for both catalogs", () => {
    const $ = renderMapStep();
    $(".norea-compose-pane").each((_, pane) => {
      const buttons = $(pane).find(".norea-compose-selection-tools button").map((_, button) => $(button).text()).get();
      expect(buttons).toContain("novelMerge.compose.selectAll");
      expect(buttons).toContain("novelMerge.compose.range");
      expect(buttons).toContain("novelMerge.compose.clearSelection");
    });
    $(".norea-compose-pane-footer").each((_, footer) => {
      expect($(footer).text()).toContain("novelMerge.compose.include");
      expect($(footer).text()).toContain("novelMerge.compose.exclude");
    });
    expect($(".norea-compose-link-bar").text()).toContain("novelMerge.compose.pairRanges");
    expect($(".norea-compose-history").text()).toContain("novelMerge.compose.undo");
  });

  it("shows final ordinals separately from raw source chapter numbers and titles", () => {
    const $ = renderMapStep();
    const finalRows = $("[data-side=final] .norea-compose-row");
    expect(finalRows.map((_, row) => $(row).find(".norea-compose-ordinal").text()).get()).toEqual(["1", "2", "3", "4"]);
    expect(finalRows.eq(2).find(".norea-compose-row-name").text()).toBe("Source 300");
    expect(finalRows.eq(2).find(".norea-compose-row-detail").text()).toBe("novelMerge.compose.originRow(A|300)");
    expect(finalRows.first().attr("data-origin")).toBe("A+B");
  });

  it("shows source exclusions without hiding rows and prevents confirming an empty final list", () => {
    const $ = renderMapStep({ composition: [] });
    expect($("[data-side=source] .norea-compose-row[data-excluded=true]")).toHaveLength(3);
    expect($("[data-side=target] .norea-compose-row[data-excluded=true]")).toHaveLength(2);
    expect($("[data-side=final] .norea-compose-empty")).toHaveLength(1);
    expect($(".norea-compose-footer button").attr("disabled")).toBeDefined();
    expect($(".norea-compose-footer").text()).toContain("novelMerge.compose.finalCount(0)");
  });

  it("virtualizes all three 2,000-chapter lists without hiding their total sizes", () => {
    const sources = Array.from({ length: 2000 }, (_, index) => sourceChapter(index + 1, String(index + 1)));
    const targets = sources.map(source => ({ chapterNumber: Number(source.chapterNumber), name: `Target ${source.chapterNumber}`, path: `/t/${source.id}` }));
    const matching = { ambiguous: [], matched: sources.map(source => ({ sourceChapterId: source.id, targetChapterPath: `/t/${source.id}` })), unmatchedSourceChapterIds: [] };
    const $ = renderMapStep({ sourceChapters: sources, targetChapters: targets, matching, composition: createInitialComposition(sources, targets, matching) });
    $(".norea-compose-pane").each((_, pane) => {
      expect($(pane).find("button.norea-compose-row").length).toBeGreaterThan(0);
      expect($(pane).find("button.norea-compose-row").length).toBeLessThan(60);
      expect($(pane).find("[role=listitem]").first().attr("aria-setsize")).toBe("2000");
      expect($(pane).find(".norea-compose-pane-count").text().replace(/[^0-9]/g, "")).toBe("2000");
    });
  });
});

describe("MergeConfirmStep", () => {
  it("offers a catalog reload and blocks migration when the reviewed list changed", () => {
    const $ = render(<MergeConfirmStep error="Catalog changed" onConfirm={vi.fn()} onReloadCatalog={vi.fn()} pending={false}
      sourceName="Old Home" sourcePluginName="Source A" targetName="New Home" targetPluginName="Source B"
      summary={{ copyChoices: 0, downloadsMoved: 0, downloadsRemoved: 0, excluded: 0, mapped: 1, readDropped: 0, readMoved: 0 }} />);
    expect($("[role=alert] button").text()).toBe("novelMerge.catalog.reload");
    expect($(".norea-merge-footer button").attr("disabled")).toBeDefined();
  });

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
