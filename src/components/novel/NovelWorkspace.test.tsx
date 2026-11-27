import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ChapterListRow } from "../../db/queries/chapter";
import {
  collectElements,
  mountBackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";

vi.mock("../../i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.number === undefined ? key : `${key}:${values.number}`,
  }),
}));
vi.mock("../../lib/plugins/manager", () => ({ pluginManager: { getPlugin: () => ({ id: "source-a" }) } }));
vi.mock("../../lib/use-novel-cover-source", () => ({ useNovelCoverSource: (_novel: unknown, options: { allowSourceFallback: boolean }) => options.allowSourceFallback ? "https://original.test/cover.jpg" : null }));

import { NovelWorkspace } from "./NovelWorkspace";
import { getNovelChapterStats } from "./novel-detail-model";

const chapter: ChapterListRow = {
  id: 1, novelId: 3, name: "One", path: "/1", chapterNumber: "1", position: 1, page: "1",
  bookmark: false, progress: 0, isDownloaded: false, sourceContentType: "html", contentType: "html",
  contentBytes: 0, mediaBytes: 0, mediaRepairNeeded: false, releaseTime: null, readAt: null,
  createdAt: null, foundAt: 1, updatedAt: 1,
};

const props: ComponentProps<typeof NovelWorkspace> = {
  allowSourceAccess: false,
  novel: {
    id: 3, pluginId: "source-a", sourceNovelId: "novel", path: "/novel", name: "Novel", cover: "https://original.test/cover.jpg",
    summary: null, author: null, artist: null, status: null, genres: null, rating: null, inLibrary: false, isLocal: false,
    createdAt: 1, updatedAt: 1, libraryAddedAt: null, lastReadAt: null, statusOverride: null,
  },
  chapters: [], chapterStats: undefined, downloadStatuses: new Map(), lastReadChapterId: undefined, libraryBusy: false,
  onRead: vi.fn(), onSelectChapters: vi.fn(), onSelectGenre: vi.fn(), onToggleLibrary: vi.fn(), sourceName: "Source",
};

function render(overrides: Partial<ComponentProps<typeof NovelWorkspace>> = {}) {
  const chapterStats = getNovelChapterStats(overrides.chapters ?? props.chapters);
  return load(renderToStaticMarkup(<MantineProvider><NovelWorkspace {...props} chapterStats={chapterStats} {...overrides} /></MantineProvider>));
}

const buttonTexts = ($: ReturnType<typeof render>) =>
  $("button").map((_, button) => $(button).text()).get();

it("renders the work's tags as buttons beneath its summary", () => {
  const $ = render({ novel: { ...props.novel, summary: "Synopsis", genres: "#Fantasy, #Romance" } });
  const summary = $(".norea-novel-summary-text");
  expect(summary.text()).toBe("Synopsis");
  expect(summary.parent().prev().hasClass("norea-novel-info-row")).toBe(true);
  expect($(".norea-novel-info-row > .norea-novel-category-slot")).toHaveLength(1);
  expect(summary.closest(".norea-novel-identity-text").children().map((_, el) => $(el).attr("class")).get()).toEqual([
    "norea-novel-title", "norea-novel-info-row", "norea-novel-summary",
  ]);
  expect(summary.next().find("li > button").map((_, button) => $(button).text()).get())
    .toEqual(["Fantasy", "Romance"]);
});

it("does not expose original-site covers for a server-bound work", () => {
  expect(render().html()).not.toContain("https://original.test/cover.jpg");
});

it("keeps source-site cover fallback available for unbound source works", () => {
  expect(render({ allowSourceAccess: true }).html()).toContain("https://original.test/cover.jpg");
});

it("loads a library work cover when its local cover has not been saved", () => {
  const $ = render({ allowSourceAccess: true, novel: { ...props.novel, inLibrary: true } });
  expect($.html()).toContain("https://original.test/cover.jpg");
});

it("keeps source cover access disabled for server-only library works", () => {
  expect(render({ novel: { ...props.novel, inLibrary: true } }).html()).not.toContain("https://original.test/cover.jpg");
});

it("starts reading without history and offers no separate From start", () => {
  const $ = render({ chapters: [chapter, { ...chapter, id: 2, position: 2 }] });
  expect(buttonTexts($)).toContain("novel.startReading");
  expect(buttonTexts($)).not.toContain("novel.fromStart");
});

it("continues at the downloaded next chapter by number and offers From start", async () => {
  const chapters = [
    { ...chapter, progress: 100 },
    { ...chapter, id: 2, position: 2, chapterNumber: "52", isDownloaded: true },
  ];
  const $ = render({
    chapters,
    lastReadChapterId: 1,
  });
  expect(buttonTexts($)).toContain("novel.continueChapter:52");
  expect(buttonTexts($)).toContain("novel.fromStart");

  const onRead = vi.fn();
  let tree: ReactNode = null;
  function Probe() {
    tree = NovelWorkspace({ ...props, chapters, lastReadChapterId: 1, onRead });
    return null;
  }
  const harness = mountBackNavigationHarness();
  try {
    await harness.render(<Probe />);
    const fromStartButton = collectElements(tree).find((el) => el.props.children === "novel.fromStart")!;
    (fromStartButton.props.onClick as () => void)();
    expect(onRead).toHaveBeenCalledExactlyOnceWith(chapters[0], { fromStart: true });
  } finally {
    await harness.unmount();
  }
});

it("offers the first chapter again only when it opens at a different position", () => {
  expect(buttonTexts(render({ chapters: [chapter], lastReadChapterId: 1 }))).not.toContain("novel.fromStart");
  expect(buttonTexts(render({ chapters: [{ ...chapter, progress: 25 }], lastReadChapterId: 1 }))).toContain("novel.fromStart");
});

it("shows nothing to continue when finished with no downloaded next chapter", () => {
  const caughtUp = render({
    chapters: [{ ...chapter, progress: 100 }],
    lastReadChapterId: 1,
  });
  const caughtUpButton = caughtUp("button").filter(
    (_, button) => caughtUp(button).text() === "novel.nothingToContinue",
  );
  expect(caughtUpButton).toHaveLength(1);
  expect(caughtUpButton.prop("disabled")).toBe(true);
  expect(buttonTexts(caughtUp)).toContain("novel.fromStart");

  const undownloaded = render({
    chapters: [
      { ...chapter, progress: 100 },
      { ...chapter, id: 2, position: 2, chapterNumber: "52", isDownloaded: false },
    ],
    lastReadChapterId: 1,
  });
  expect(
    undownloaded("button")
      .filter((_, button) => undownloaded(button).text() === "novel.nothingToContinue")
      .prop("disabled"),
  ).toBe(true);
});

it("disables the primary action only when there is no chapter", () => {
  const $ = render();
  const primary = $("button").filter((_, button) => $(button).text() === "novel.startReading");
  expect(primary.prop("disabled")).toBe(true);
});

it("offers Add only outside the library and hides Download for local works", () => {
  const inLibrary = render({ novel: { ...props.novel, inLibrary: true } });
  expect(buttonTexts(inLibrary)).not.toContain("novel.addToLibrary");
  expect(buttonTexts(inLibrary)).not.toContain("novel.inLibraryAction");
  expect(buttonTexts(inLibrary)).toContain("novel.download");

  const local = render({ novel: { ...props.novel, isLocal: true } });
  expect(buttonTexts(local)).toContain("novel.addToLibrary");
  expect(buttonTexts(local)).not.toContain("novel.download");
});

it.each(["Ongoing", "Unknown"])("shows the source and localized ongoing status separately for %s", (status) => {
  const $ = render({ novel: { ...props.novel, status } });
  const statusLine = $(".norea-novel-metadata > .norea-novel-status");
  expect(statusLine.text()).toBe("novel.status.ongoing");
  expect(statusLine.prev(".norea-novel-meta").text()).toBe("Source");
  expect($(".norea-novel-identity-text").text()).not.toContain("Unknown");
});

it("reserves the badge row without reporting zero downloads before chapters load", () => {
  const pending = render({ chapterStats: undefined, offlineState: "ready" });
  expect(pending(".norea-novel-reading-status")).toHaveLength(1);
  expect(pending(".norea-novel-reading-status [data-kind]")).toHaveLength(0);

  const ready = render({ offlineState: "attention" });
  const badge = ready(".norea-novel-reading-status [data-kind=downloaded]");
  expect(badge.attr("data-goal-state")).toBe("attention");
  expect(badge.attr("title")).toContain("library.grid.offline.attention");
});

it("shows stored and unread chapter counts and the cover progress used on library cards", () => {
  const $ = render({
    chapters: [
      { ...chapter, progress: 100, isDownloaded: true },
      { ...chapter, id: 2, position: 2, progress: 30, contentBytes: 450 },
      { ...chapter, id: 3, position: 3 },
      { ...chapter, id: 4, position: 4 },
    ],
    offlineState: "ready",
    categoryChips: <span>Reading</span>,
  });
  const status = $(".norea-novel-info-row > .norea-novel-reading-status");
  expect(status.prev(".norea-novel-category-slot").text()).toBe("Reading");
  expect(status.find("[data-kind]").map((_, badge) => [$(badge).attr("data-kind")]).get()).toEqual(["downloaded", "unread"]);
  expect(status.find("[data-kind=downloaded] span[aria-hidden=true]").text()).toBe("2");
  expect(status.find("[data-kind=unread] span[aria-hidden=true]").text()).toBe("3");
  expect($(".norea-novel-cover .norea-library-card-progress").attr("style")).toContain("33%");
});

it("hides the unread and downloaded badges under the same conditions as the library", () => {
  const $ = render({ chapters: [{ ...chapter, progress: 100 }] });
  expect($(".norea-novel-reading-status [data-kind]")).toHaveLength(0);
  expect($(".norea-novel-cover .norea-library-card-progress").attr("style")).toContain("100%");
});

it("places borderless secondary actions beneath the primary action and lets long labels wrap", () => {
  const $ = render({ chapters: [chapter] });
  const secondary = $(".norea-novel-actions button");
  expect(secondary).toHaveLength(2);
  expect(secondary.map((_, button) => $(button).attr("data-variant")).get()).toEqual(["subtle", "subtle"]);
  expect($(".norea-novel-continue + .norea-novel-actions")).toHaveLength(1);
  const css = readFileSync(new URL("../../styles/novel.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.norea-novel-continue \{[^}]*min-height: max\(3rem, var\(--norea-control-md\)\)/);
  expect(css).toMatch(/\.norea-novel-actions \.mantine-Button-root \{[^}]*min-height: var\(--norea-control-md\)/);
  expect(css).toMatch(/\.norea-novel-actions \.mantine-Button-label,[^{]+\{[^}]*white-space: normal/);
});
