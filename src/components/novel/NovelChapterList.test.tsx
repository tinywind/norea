import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ChapterListRow } from "../../db/queries/chapter";
import type { ChapterDownloadStatus } from "../../lib/tasks/chapter-download";
import { CHAPTER_ROW_HEIGHT, VirtualChapterList } from "./NovelChapterList";

const rowClickHandlers = vi.hoisted(() => new Map<string, (() => void) | undefined>());
vi.mock("../IconButton", async importOriginal => {
  const actual = await importOriginal<typeof import("../IconButton")>();
  return {
    ...actual,
    IconButton: (props: ComponentProps<typeof actual.IconButton>) => {
      rowClickHandlers.set(props.label, props.onClick as (() => void) | undefined);
      return <actual.IconButton {...props} />;
    },
  };
});

vi.mock("../ui/ListRow", async importOriginal => {
  const actual = await importOriginal<typeof import("../ui/ListRow")>();
  return { ...actual, ListRow: (props: ComponentProps<typeof actual.ListRow>) => {
    rowClickHandlers.set(String(props["aria-label"]), () => props.onClick?.({ shiftKey: false } as never));
    return <actual.ListRow {...props} />;
  } };
});

const chapter: ChapterListRow = {
  id: 1,
  novelId: 1,
  path: "/chapter/1",
  name: "First chapter",
  chapterNumber: "1",
  position: 1,
  page: "1",
  bookmark: false,
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
  rowClickHandlers.clear();
  const props: ListProps = {
    chapters: [chapter],
    canDeleteDownloads: true,
    deleteBusyChapterId: undefined,
    duplicateSourceChapterCounts: new Map(),
    deletePending: false,
    jumpRequest: null,
    continueChapterId: undefined,
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

  it("leads each row with its 1-based chapter sequence number instead of the internal chapterNumber or id", () => {
    const $ = renderRow({ id: 99, chapterNumber: "255", position: 1, name: "Chapter 126", isDownloaded: true });
    const row = $(".norea-novel-chapter");
    const leading = row.find(".norea-list-item-leading");
    const ordinal = leading.find(".norea-novel-chapter-ordinal");
    expect(ordinal).toHaveLength(1);
    expect(ordinal.text()).toBe("1");
    expect(ordinal.attr("title")).toBe("Chapter no. 1");
    expect(row.find(".norea-novel-chapter-system-number")).toHaveLength(0);

    const desc = renderList({
      chapters: [
        { ...chapter, id: 71, chapterNumber: "71", ordinal: 36, position: 36, name: "36화" },
        { ...chapter, id: 70, chapterNumber: "70", ordinal: 35, position: 35, name: "35화" },
      ],
    });
    expect(desc(".norea-novel-chapter-ordinal").map((_, el) => desc(el).text()).get()).toEqual(["36", "35"]);
    expect(desc(".norea-novel-chapter-ordinal").first().attr("title")).toBe("Chapter no. 36");
  });

  it("places the check ring before the ordinal inside the row leading slot while selecting", () => {
    const $ = renderRow({}, undefined, { selectedChapterIds: new Set([1]), selectionMode: true });
    const children = $(".norea-novel-chapter .norea-list-item-leading").children();
    expect(children).toHaveLength(2);
    expect(children.eq(0).hasClass("norea-novel-chapter-check")).toBe(true);
    expect(children.eq(1).hasClass("norea-novel-chapter-ordinal")).toBe(true);
    expect(children.eq(1).text()).toBe("1");
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

  it("marks a finished row read when progress reaches 100%", () => {
    const $ = renderRow({ progress: 100 });
    const finished = $(".norea-novel-chapter");
    expect(finished.attr("data-progress")).toBe("read");
    expect(finished.attr("style")).toContain("--norea-chapter-progress:100%");
    expect($(".norea-novel-chapter-title").attr("data-read")).toBe("true");
  });

  it("visually de-emphasizes read chapters more strongly while keeping the next chapter at full contrast", () => {
    const css = readFileSync(new URL("../../styles/novel.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.norea-novel-chapter-title\[data-read="true"\]\s*\{[^}]*opacity:\s*0\.5;/);
    expect(css).toMatch(
      /\.norea-novel-chapter\[data-progress="read"\]:not\(\[data-next="true"\]\)\s+\.norea-novel-chapter-ordinal,\s*\.norea-novel-chapter\[data-progress="read"\]:not\(\[data-next="true"\]\)\s+\.norea-novel-chapter-meta\s*\{[^}]*opacity:\s*0\.5;/,
    );
    expect(css).toMatch(/\.norea-novel-chapter\[data-next="true"\]\s+\.norea-novel-chapter-title\s*\{[^}]*opacity:\s*1;/);
  });

  it("marks the chapter Continue opens with a visible Up next label and dims read titles", () => {
    const $ = renderList({
      chapters: [{ ...chapter, progress: 100 }, { ...chapter, id: 2, name: "Second chapter", position: 2 }],
      continueChapterId: 2,
    });
    const next = $("button[aria-current='step']");
    expect(next.attr("aria-label")).toBe("Open Second chapter");
    expect(next.find(".norea-novel-chapter-next").text()).toBe("Up next");
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
  it.each([false, true])("marks only a failed row's download action as an explicit retry (failed: %s)", failed => {
    const onDownload = vi.fn();
    renderRow({}, failed ? { kind: "failed", error: "Previous source failure" } : undefined, { onDownload });
    const click = rowClickHandlers.get(failed ? "Retry download" : "Download chapter");
    expect(click).toBeTypeOf("function");
    click!();
    expect(onDownload).toHaveBeenCalledExactlyOnceWith(chapter, failed, false);
  });

  it("marks the retry of a chapter the server lacks as accepting the source", () => {
    const onDownload = vi.fn();
    renderRow({}, { kind: "failed", error: "This chapter is not on the content server." }, { onDownload });
    rowClickHandlers.get("Download from the original site")!();
    expect(onDownload).toHaveBeenCalledExactlyOnceWith(chapter, true, true);
  });

  it.each<[string, Partial<Row>, ChapterDownloadStatus | undefined, string[]]>([
    ["not downloaded", {}, undefined, ["Download chapter"]],
    ["downloaded", { isDownloaded: true }, undefined, ["Downloaded"]],
    ["failed", {}, { kind: "failed", error: "Timed out" }, ["Retry download"]],
    ["missing media", { contentBytes: 10, mediaRepairNeeded: true }, undefined, ["Repair"]],
    ["queued", {}, { kind: "queued", phase: "server-lookup" }, []],
  ])("shows one trailing control when %s", (_name, row, status, labels) => {
    const $ = renderRow(row, status);
    expect(siblingButtons($).map((_, button) => $(button).attr("aria-label")).get().filter(Boolean)).toEqual(labels);
  });

  it("shows a queued chapter with a clock and a running one with a progress ring instead of words", () => {
    const queued = renderRow({}, { kind: "queued", phase: "source-download" });
    expect(queued("[role='img'][aria-label='Queued'].norea-novel-chapter-queued svg")).toHaveLength(1);
    expect(queued("[role='progressbar']")).toHaveLength(0);
    const visible = (row: ReturnType<typeof renderList>) => row(".norea-novel-chapter-meta").children(":not(.mantine-VisuallyHidden-root)").text();
    expect(visible(queued)).not.toContain("Queued");
    const running = renderRow({}, { kind: "running", phase: "source-download" });
    const ring = running("[role='progressbar'][aria-label='Downloading']");
    expect(ring).toHaveLength(1);
    expect(ring.attr("data-indeterminate")).toBe("true");
    expect(visible(running)).not.toContain("Downloading");
    for (const $ of [renderRow({}, { kind: "failed", error: "Timed out" }), renderRow({ contentBytes: 10, mediaRepairNeeded: true })]) {
      expect(visible($)).toBe("Ch. 1");
    }
  });

  it("repairs missing media in place with a named icon button", () => {
    const $ = renderRow({ contentBytes: 10, mediaRepairNeeded: true });
    expect(describedText($)).toContain("Missing images");
    expect(siblingButtons($).attr("aria-label")).toBe("Repair");
    expect(siblingButtons($).text()).toBe("");
  });

  it("shows normal queued, running, and done download indicators instead of the repair icon while repair is active or finished", () => {
    for (const $ of [
      renderRow({ contentBytes: 10, mediaRepairNeeded: true }, { kind: "queued" }),
      renderRow({ contentBytes: 10, mediaRepairNeeded: true }, undefined, { repairPending: true, repairBusyChapterId: 1 }),
    ]) {
      expect($("[role='img'][aria-label='Queued'].norea-novel-chapter-queued svg")).toHaveLength(1);
      expect($("button[aria-label='Repair']")).toHaveLength(0);
      expect($(".norea-novel-chapter").attr("data-busy")).toBe("true");
    }

    const running = renderRow({ contentBytes: 10, mediaRepairNeeded: true }, { kind: "running" });
    expect(running("[role='progressbar'][aria-label='Downloading']")).toHaveLength(1);
    expect(running("button[aria-label='Repair']")).toHaveLength(0);
    expect(running(".norea-novel-chapter").attr("data-busy")).toBe("true");

    const done = renderRow({ contentBytes: 10, mediaRepairNeeded: true }, { kind: "done" });
    expect(done("[role='img'][aria-label='Downloaded']")).toHaveLength(1);
    expect(done("button[aria-label='Repair']")).toHaveLength(0);
  });

  it("shows a failure reason inline and keeps the raw error out of the visible text", () => {
    const $ = renderRow({}, { kind: "failed", error: "Timed out" });
    const description = $(`#${openButton($).attr("aria-describedby")}`);
    expect(description.text()).toContain("Download failed");
    expect(description.attr("title")).toBe("Timed out");
    expect(siblingButtons($).attr("aria-label")).toBe("Retry download");
    expect(siblingButtons($).text()).toBe("");
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

describe("server chapter availability", () => {
  const dot = ($: ReturnType<typeof renderList>) => $(".norea-novel-chapter-download-icon").attr("data-on-server");

  it("marks the download icon with a dot for a chapter the server holds, in full or in part, with no visible text", () => {
    for (const serverComplete of [true, false]) {
      const $ = renderRow({ serverAvailable: true, serverComplete });
      expect(dot($)).toBe("true");
      expect(siblingButtons($).attr("aria-label")).toBe("Download chapter from the server");
      expect($(".norea-novel-chapter-meta").children(":not(.mantine-VisuallyHidden-root)").text()).not.toContain("server");
      expect(describedText($)).toContain("On the server");
    }
    const css = readFileSync(new URL("../../styles/novel.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.norea-novel-chapter-download-icon\[data-on-server="true"\]::after \{[^}]*border-radius: 50%;/);
  });

  it("drops the dot once the chapter is downloaded", () => {
    const $ = renderRow({ serverAvailable: true, serverComplete: false, isDownloaded: true });
    expect(siblingButtons($).attr("aria-label")).toBe("Downloaded");
    expect(dot($)).toBeUndefined();
    expect(describedText($)).not.toContain("server");
  });

  it("offers a plain download for a chapter the server lacks and the source only after that failure", () => {
    const absent = renderRow({ serverAvailable: false });
    expect(dot(absent)).toBeUndefined();
    expect(siblingButtons(absent).attr("aria-label")).toBe("Download chapter");
    const failed = renderRow({ serverAvailable: false }, { kind: "failed", error: "This chapter is not on the content server." });
    expect(describedText(failed)).toContain("Not on server");
    expect(describedText(failed)).not.toContain("Download failed");
    expect(siblingButtons(failed).attr("aria-label")).toBe("Download from the original site");
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

  it("keeps the reading progress while selecting and marks selected rows with a tint and an accent ring", () => {
    for (const row of [{ progress: 45 }, { unread: false }]) {
      const browsing = renderRow(row)(".norea-novel-chapter");
      const selectingRow = renderRow(row, undefined, selecting())(".norea-novel-chapter");
      expect(selectingRow.attr("data-progress")).toBe(browsing.attr("data-progress"));
      expect(selectingRow.attr("style")).toBe(browsing.attr("style"));
    }
    const css = readFileSync(new URL("../../styles/novel.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.norea-novel-chapter\[data-progress="partial"\]::before \{[^}]*background: var\(--norea-color-accent\);/);
    expect(css).not.toMatch(/\.norea-novel-chapter\[data-progress(="read")?\]::before/);
    const selected = /\.norea-novel-chapter\[data-selected="true"\] \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(selected).toContain("background: var(--norea-color-selected)");
    expect(selected).toContain("outline: 1px solid var(--norea-color-accent)");
  });

  it("pins the chapter list header flush under the page header with an opaque background", () => {
    const css = readFileSync(new URL("../../styles/novel.css", import.meta.url), "utf8");
    const header = /\.norea-novel-chapters-header \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(header).toContain("top: var(--norea-app-bar-height)");
    expect(header).toContain("background: var(--norea-color-bg)");
    expect(css).not.toContain("3.5rem");
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


describe("server chapter availability", () => {
  it("allows reading and downloading a chapter absent from the server through the common downloader", () => {
    const onOpen = vi.fn();
    const onDownload = vi.fn();
    const $ = renderRow({ serverAvailable: false }, undefined, { onOpen, onDownload });
    expect(openButton($).attr("aria-disabled")).toBeUndefined();
    expect(siblingButtons($).attr("aria-label")).toBe("Download chapter");
    expect(siblingButtons($).prop("disabled")).toBe(false);
    rowClickHandlers.get("Open First chapter")?.();
    rowClickHandlers.get("Download chapter")?.();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onDownload).toHaveBeenCalledOnce();
  });

  it("keeps an existing local body readable when no server package is available", () => {
    const onOpen = vi.fn();
    const $ = renderRow({ serverAvailable: false, isDownloaded: true, contentBytes: 100 }, undefined, { onOpen });
    expect(describedText($)).not.toContain("Not stored on the content server");
    expect(openButton($).attr("aria-disabled")).toBeUndefined();
    expect(siblingButtons($).attr("aria-label")).toBe("Downloaded");
    rowClickHandlers.get("Open First chapter")?.();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
