import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ChapterListRow } from "../../db/queries/chapter";

vi.mock("../../i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.read !== undefined
        ? `${key}:${values.read}/${values.total}`
        : values?.number === undefined ? key : `${key}:${values.number}`,
  }),
}));
vi.mock("../../lib/plugins/manager", () => ({ pluginManager: { getPlugin: () => ({ id: "source-a" }) } }));
vi.mock("../../lib/use-novel-cover-source", () => ({ useNovelCoverSource: (_novel: unknown, options: { allowSourceFallback: boolean }) => options.allowSourceFallback ? "https://original.test/cover.jpg" : null }));

import { NovelWorkspace } from "./NovelWorkspace";

const chapter: ChapterListRow = {
  id: 1, novelId: 3, name: "One", path: "/1", chapterNumber: "1", position: 1, page: "1",
  bookmark: false, unread: true, progress: 0, isDownloaded: false, sourceContentType: "html", contentType: "html",
  contentBytes: 0, mediaBytes: 0, mediaRepairNeeded: false, releaseTime: null, readAt: null,
  createdAt: null, foundAt: 1, updatedAt: 1,
};

const props: ComponentProps<typeof NovelWorkspace> = {
  allowSourceAccess: false,
  novel: {
    id: 3, pluginId: "source-a", sourceNovelId: "novel", path: "/novel", name: "Novel", cover: "https://original.test/cover.jpg",
    summary: null, author: null, artist: null, status: null, genres: null, rating: null, inLibrary: false, isLocal: false,
    createdAt: 1, updatedAt: 1, libraryAddedAt: null, lastReadAt: null,
  },
  chapters: [], downloadStatuses: new Map(), lastReadChapterId: undefined, libraryBusy: false,
  onRead: vi.fn(), onSelectChapters: vi.fn(), onToggleLibrary: vi.fn(), sourceName: "Source",
};

function render(overrides: Partial<ComponentProps<typeof NovelWorkspace>> = {}) {
  return load(renderToStaticMarkup(<MantineProvider><NovelWorkspace {...props} {...overrides} /></MantineProvider>));
}

const buttonTexts = ($: ReturnType<typeof render>) =>
  $("button").map((_, button) => $(button).text()).get();

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

it("continues at the last read chapter by number and offers From start", () => {
  const $ = render({
    chapters: [{ ...chapter, unread: false, progress: 100 }, { ...chapter, id: 2, position: 2, chapterNumber: "52" }],
    lastReadChapterId: 1,
  });
  expect(buttonTexts($)).toContain("novel.continueChapter:52");
  expect(buttonTexts($)).toContain("novel.fromStart");
});

it("disables the primary action only when there is no chapter", () => {
  const $ = render();
  const primary = $("button").filter((_, button) => $(button).text() === "novel.startReading");
  expect(primary.prop("disabled")).toBe(true);
});

it("labels the library toggle with its state and hides Download for local works", () => {
  const inLibrary = render({ novel: { ...props.novel, inLibrary: true } });
  const toggle = inLibrary("button[aria-pressed]");
  expect(toggle.text()).toBe("novel.inLibraryAction");
  expect(toggle.attr("aria-pressed")).toBe("true");
  expect(buttonTexts(inLibrary)).toContain("novel.download");

  const local = render({ novel: { ...props.novel, isLocal: true } });
  expect(local("button[aria-pressed]").text()).toBe("novel.addToLibrary");
  expect(buttonTexts(local)).not.toContain("novel.download");
});

it("shows a known status in the app language and omits Unknown", () => {
  expect(render({ novel: { ...props.novel, status: "Ongoing" } }).text()).toContain("novel.status.ongoing · Source");
  expect(render({ novel: { ...props.novel, status: "Unknown" } }).text()).not.toContain("Unknown");
});

it("names a goal novel's offline state in the header, as its library card does", () => {
  expect(render()(".norea-novel-offline").length).toBe(0);
  const $ = render({ offlineState: "attention" });
  expect($(".norea-novel-offline").attr("data-goal-state")).toBe("attention");
  expect($(".norea-novel-offline").text()).toBe("novel.offline.attention");
});

it("counts read chapters instead of averaging progress over every chapter", () => {
  const unreadOnly = render({ chapters: [{ ...chapter, progress: 40 }], lastReadChapterId: 1 });
  expect(unreadOnly.text()).not.toContain("novel.chaptersRead");

  const $ = render({
    chapters: [
      { ...chapter, unread: false, progress: 100 },
      { ...chapter, id: 2, position: 2, progress: 30 },
      { ...chapter, id: 3, position: 3 },
    ],
    lastReadChapterId: 2,
  });
  expect($.text()).toContain("novel.chaptersRead:1/3");
  expect($.text()).not.toContain("percentRead");
});

it("lays the secondary actions out in equal columns under the Continue button", () => {
  const css = readFileSync(new URL("../../styles/novel.css", import.meta.url), "utf8");
  const actions = /\.norea-novel-actions \{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(actions).toContain("display: grid");
  expect(actions).toContain("grid-auto-columns: minmax(0, 1fr)");
  expect(actions).toContain("grid-auto-flow: column");
  const meta = /\.norea-novel-meta \{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(meta).toContain("line-height: var(--norea-leading-normal)");
});
