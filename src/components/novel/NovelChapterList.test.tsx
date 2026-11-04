import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ChapterListRow } from "../../db/queries/chapter";
import type { ChapterDownloadStatus } from "../../lib/tasks/chapter-download";
import { CHAPTER_ROW_HEIGHT, VirtualChapterList } from "./NovelChapterList";

const chapter: ChapterListRow = {
  id: 1,
  novelId: 1,
  path: "/chapter/1",
  name: "First chapter",
  chapterNumber: "1",
  position: 1,
  page: "1",
  bookmark: false,
  unread: true,
  progress: 0,
  isDownloaded: false,
  sourceContentType: "html",
  contentType: "html",
  contentBytes: 0,
  mediaBytes: 0,
  mediaRepairNeeded: false,
  releaseTime: null,
  readAt: null,
  createdAt: null,
  foundAt: 1,
  updatedAt: 1,
};

type ListProps = ComponentProps<typeof VirtualChapterList>;
type Row = ListProps["chapters"][number];

function renderList(overrides: Partial<ListProps> = {}) {
  const props: ListProps = {
    chapters: [chapter],
    canDeleteDownloads: true,
    deleteBusyChapterId: undefined,
    duplicateSourceChapterCounts: new Map(),
    deletePending: false,
    jumpRequest: null,
    lastReadChapterId: undefined,
    rangeStartChapterId: null,
    repairBusyChapterId: undefined,
    repairPending: false,
    reorderMode: false,
    reorderPending: false,
    scrollElement: null,
    selectedChapterIds: new Set(),
    selectionMode: false,
    statuses: new Map(),
    onDeleteDownload: vi.fn(),
    onDownload: vi.fn(),
    onExtendSelection: vi.fn(),
    onOpen: vi.fn(),
    onRepairMedia: vi.fn(),
    onReorderChapter: vi.fn(),
    onToggleSelected: vi.fn(),
    ...overrides,
  };
  return load(renderToStaticMarkup(
    <MantineProvider>
      <VirtualChapterList {...props} />
    </MantineProvider>,
  ));
}

function renderRow(row: Partial<Row> = {}, status?: ChapterDownloadStatus, overrides: Partial<ListProps> = {}) {
  return renderList({
    chapters: [{ ...chapter, ...row }],
    statuses: status ? new Map([[chapter.id, status]]) : new Map(),
    ...overrides,
  });
}

const openButton = ($: ReturnType<typeof renderList>) => $("button[aria-label='Open First chapter']");
const describedText = ($: ReturnType<typeof renderList>) => {
  const button = openButton($).length ? openButton($) : $("button[aria-pressed]");
  return $(`#${button.attr("aria-describedby")}`).text();
};
const siblingButtons = ($: ReturnType<typeof renderList>) =>
  openButton($).parent().children("div").find("button");

describe("chapter row structure", () => {
  it("makes the whole row one button with its actions beside it, not inside it", () => {
    const $ = renderRow({ isDownloaded: true });
    const primary = openButton($);

    expect(primary).toHaveLength(1);
    expect(primary.attr("type")).toBe("button");
    expect(primary.find("button, input, a, [tabindex]")).toHaveLength(0);
    expect(siblingButtons($).map((_, button) => $(button).attr("aria-label")).get()).toEqual(["Downloaded"]);
  });

  it("toggles selection with a pressed state and no extra checkbox control in selection mode", () => {
    const $ = renderRow({}, undefined, { selectedChapterIds: new Set([1]), selectionMode: true });
    const primary = $("button[aria-label='Select First chapter']");

    expect(primary.attr("aria-pressed")).toBe("true");
    expect($("input")).toHaveLength(0);
  });

  it("shows the chapter number, date and partial reading progress in the description", () => {
    const $ = renderRow({ chapterNumber: "12", releaseTime: "2026-10-12", progress: 45 });
    expect(describedText($)).toBe("Ch. 122026-10-1245% read");
  });

  it("omits the chapter number when the name already shows it", () => {
    const $ = renderRow({ chapterNumber: "1895", name: "Novel 1895", releaseTime: "2026-10-12" });
    expect($("[id]").filter((_, element) => $(element).hasClass("norea-novel-chapter-meta")).text()).toBe("2026-10-12");
  });

  it("separates shown meta parts with one spaced dot and skips screen-reader-only parts", () => {
    const css = readFileSync(new URL("../../styles/novel.css", import.meta.url), "utf8");
    const meta = /\.norea-novel-chapter-meta \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(meta).not.toContain("gap:");
    expect(css).toContain(
      '.norea-novel-chapter-meta > span:not(.mantine-VisuallyHidden-root) ~ span:not(.mantine-VisuallyHidden-root)::before {\n  content: "·";\n  margin-inline: var(--norea-space-1);',
    );
    const $ = renderRow({ progress: 45 });
    expect($(".norea-novel-chapter-meta .mantine-VisuallyHidden-root")).toHaveLength(1);
  });

  it("fills a partly read row from the left as far as it was read", () => {
    const partial = renderRow({ progress: 45 })(".norea-novel-chapter");
    expect(partial.attr("data-progress")).toBe("partial");
    expect(partial.attr("style")).toContain("--norea-chapter-progress:45%");

    const unread = renderRow({ progress: 0 })(".norea-novel-chapter");
    expect(unread.attr("data-progress")).toBeUndefined();
    expect(unread.attr("style") ?? "").not.toContain("--norea-chapter-progress");
  });

  it.each([
    ["marked read", { unread: false, progress: 0 }],
    ["read to the end", { unread: true, progress: 100 }],
  ])("fills a finished row completely when %s", (_label, row) => {
    const finished = renderRow(row)(".norea-novel-chapter");
    expect(finished.attr("data-progress")).toBe("read");
    expect(finished.attr("style")).toContain("--norea-chapter-progress:100%");
  });

  it("marks the current chapter and dims read titles", () => {
    const $ = renderList({
      chapters: [{ ...chapter, unread: false }, { ...chapter, id: 2, name: "Second chapter", position: 2 }],
      lastReadChapterId: 2,
    });
    expect($("button[aria-current='true']").attr("aria-label")).toBe("Open Second chapter");
    expect(openButton($).find("[data-read='true']").text()).toBe("First chapter");
  });

  it("announces a bookmark without a separate flag control", () => {
    const $ = renderRow({ bookmark: true });
    expect(openButton($).text()).toContain("Bookmarked");
  });

  it("offers drag and move buttons in reorder mode instead of the download state", () => {
    const $ = renderList({
      chapters: [chapter, { ...chapter, id: 2, name: "Second chapter", position: 2 }],
      reorderMode: true,
    });
    const labels = $("button").map((_, button) => $(button).attr("aria-label")).get();
    expect(labels.filter((label) => label === "Reorder chapter")).toHaveLength(2);
    expect(labels).toContain("Move chapter up");
    expect(labels).not.toContain("Download chapter");
    expect($("button[aria-label='Move chapter up']").first().prop("disabled")).toBe(true);
  });
});

describe("download state", () => {
  it.each<[string, Partial<Row>, ChapterDownloadStatus | undefined, string[]]>([
    ["not downloaded", {}, undefined, ["Download chapter"]],
    ["downloaded", { isDownloaded: true }, undefined, ["Downloaded"]],
    ["failed", {}, { kind: "failed", error: "Timed out" }, ["Retry download"]],
    ["missing media", { contentBytes: 10, mediaRepairNeeded: true }, undefined, []],
    ["queued", {}, { kind: "queued", phase: "server-lookup" }, []],
  ])("shows one trailing control when %s", (_name, row, status, labels) => {
    const $ = renderRow(row, status);
    expect(siblingButtons($).map((_, button) => $(button).attr("aria-label")).get().filter(Boolean)).toEqual(labels);
  });

  it("repairs missing media in place with a labeled button", () => {
    const $ = renderRow({ contentBytes: 10, mediaRepairNeeded: true });
    expect(describedText($)).toContain("Missing images");
    expect(siblingButtons($).text()).toBe("Repair");
  });

  it("shows a failure reason inline and keeps the raw error out of the visible text", () => {
    const $ = renderRow({}, { kind: "failed", error: "Timed out" });
    const description = $(`#${openButton($).attr("aria-describedby")}`);
    expect(description.text()).toContain("Download failed");
    expect(description.attr("title")).toBe("Timed out");
    expect(siblingButtons($).text()).toBe("Retry");
  });

  it.each<[ChapterDownloadStatus, string, string]>([
    [{ kind: "running", phase: "server-download" }, "Downloading", "Content server: downloading"],
    [{ kind: "queued", phase: "source-download" }, "Queued", "Original site download queued"],
  ])("keeps the download phase as detail behind %j", (status, visible, detail) => {
    const $ = renderRow({}, status);
    const description = $(`#${openButton($).attr("aria-describedby")}`);
    expect(description.text()).toContain(visible);
    expect(description.text()).not.toContain(detail);
    expect(description.attr("title")).toBe(detail);
    expect(openButton($).attr("aria-busy")).toBe("true");
  });

  it("keeps duplicate-source detail out of the default view", () => {
    const $ = renderList({ duplicateSourceChapterCounts: new Map([[1, 2]]) });
    const description = $(`#${openButton($).attr("aria-describedby")}`);
    expect(description.text()).not.toContain("duplicate");
    expect(description.attr("title")).toBe("2 duplicate source chapters skipped");
  });

  it("shows no download control for chapters of a local work", () => {
    const $ = renderRow({ isDownloaded: true }, undefined, { canDeleteDownloads: false });
    expect(siblingButtons($)).toHaveLength(0);
  });
});

describe("server chapter completeness", () => {
  it("shows a partial server copy and keeps the download action", () => {
    const $ = renderRow({ serverComplete: false });
    expect(describedText($)).toContain("Partial copy on server");
    expect(siblingButtons($).attr("aria-label")).toBe("Download chapter");
  });

  it("preserves a complete local copy when the server copy is incomplete", () => {
    const $ = renderRow({ serverComplete: false, isDownloaded: true });
    expect(describedText($)).toContain("Partial copy on server");
    expect(siblingButtons($).attr("aria-label")).toBe("Downloaded");
  });

  it("moves a complete server copy into the details", () => {
    const $ = renderRow({ serverComplete: true });
    const description = $(`#${openButton($).attr("aria-describedby")}`);
    expect(description.text()).not.toContain("server");
    expect(description.attr("title")).toBe("Full copy on server");
  });
});

describe("selection visuals", () => {
  const selecting = (overrides: Partial<ListProps> = {}) => ({ selectionMode: true, ...overrides });

  it("leads each row with a round check that fills only when the row is selected", () => {
    const unselected = renderRow({}, undefined, selecting());
    expect(unselected(".norea-novel-chapter-check").attr("data-checked")).toBeUndefined();
    expect(unselected(".norea-novel-chapter-check svg")).toHaveLength(0);
    const selected = renderRow({}, undefined, selecting({ selectedChapterIds: new Set([1]) }));
    expect(selected(".norea-novel-chapter-check").attr("data-checked")).toBe("true");
    expect(selected(".norea-novel-chapter-check svg")).toHaveLength(1);
    expect(selected(".norea-novel-chapter").attr("data-selected")).toBe("true");

    const css = readFileSync(new URL("../../styles/novel.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.norea-novel-chapter-check \{[^}]*border-radius: 50%;/);
    expect(css).toMatch(/\.norea-novel-chapter-check\[data-checked="true"\] \{[^}]*background: var\(--norea-color-accent\);/);
    expect(css).toMatch(/\.norea-novel-chapter\[data-selected="true"\] \{[^}]*background: var\(--norea-color-selected\);/);
  });

  it("drops the grey reading fill while selecting so read rows never look selected", () => {
    for (const row of [{ progress: 45 }, { unread: false }]) {
      const browsing = renderRow(row)(".norea-novel-chapter");
      expect(browsing.attr("data-progress")).toBeDefined();
      const selectingRow = renderRow(row, undefined, selecting())(".norea-novel-chapter");
      expect(selectingRow.attr("data-progress")).toBeUndefined();
      expect(selectingRow.attr("style") ?? "").not.toContain("--norea-chapter-progress");
    }
    const css = readFileSync(new URL("../../styles/novel.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.norea-novel-chapter\[data-progress\]::before \{[^}]*background: var\(--norea-color-ink\);/);
  });

  it("marks and announces the range start only while selecting", () => {
    const marked = renderRow({}, undefined, selecting({ rangeStartChapterId: 1 }));
    expect(marked(".norea-novel-chapter-check").attr("data-range-start")).toBe("true");
    expect(marked("button[aria-pressed]").text()).toContain("Range start");
    const other = renderRow({}, undefined, selecting({ rangeStartChapterId: 2 }));
    expect(other(".norea-novel-chapter-check").attr("data-range-start")).toBeUndefined();
    expect(other("button[aria-pressed]").text()).not.toContain("Range start");
  });

  it("leaves the selecting row without other buttons, keeping the downloaded state visible", () => {
    for (const row of [{ isDownloaded: true }, { isDownloaded: false }]) {
      const $ = renderRow(row, undefined, selecting());
      expect($("button")).toHaveLength(1);
      expect($("button").attr("aria-pressed")).toBe("false");
    }
    const downloaded = renderRow({ isDownloaded: true }, undefined, selecting());
    expect(downloaded("[role=img][aria-label='Downloaded']")).toHaveLength(1);
  });
});

describe("row geometry", () => {
  it("windows rows at the height the stylesheet gives them", () => {
    const css = readFileSync(new URL("../../styles/novel.css", import.meta.url), "utf8");
    const rule = /\.norea-novel-chapter \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain(`height: ${CHAPTER_ROW_HEIGHT / 16}rem;`);
  });

  it("renders only a window of a long list", () => {
    const chapters = Array.from({ length: 500 }, (_, index) => ({ ...chapter, id: index + 1, position: index + 1, name: `Chapter ${index + 1}` }));
    const $ = renderList({ chapters });
    const rendered = $("button[aria-label^='Open Chapter']").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(40);
    expect($(`[style*='height:${500 * CHAPTER_ROW_HEIGHT}px']`)).toHaveLength(1);
  });
});
