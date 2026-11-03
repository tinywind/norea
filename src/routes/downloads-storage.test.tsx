import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { load } from "cheerio";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DownloadCacheChapter, DownloadCacheNovel } from "../db/queries/download-cache";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../components/ChapterCleanupPanel", () => ({ ChapterCleanupPanel: () => null }));
vi.mock("../lib/download-cache-media", () => ({ scheduleDownloadCacheMediaBytesBackfill: vi.fn() }));
vi.mock("../lib/download-cache-loaders", () => ({ loadDownloadCacheNovels: vi.fn(), loadDownloadCacheChapters: vi.fn() }));
vi.mock("../lib/use-novel-cover-source", () => ({ useNovelCoverSource: () => null }));
vi.mock("../lib/plugins/manager", () => ({ pluginManager: { getPlugin: () => undefined } }));

import { DownloadsStorageView, downloadedChapterToRead } from "./downloads-storage";

function novel(patch: Partial<DownloadCacheNovel> = {}): DownloadCacheNovel {
  return {
    novelId: 1, novelName: "Novel", novelCover: null, novelPath: "/novel", pluginId: "source", pluginName: "Source",
    inLibrary: true, chaptersDownloaded: 120, totalChapters: 300, unreadDownloaded: 20, readDownloaded: 100,
    mediaRepairNeededChapters: 0, totalBytes: 340 * 1024 * 1024, lastDownloadedAt: null, ...patch,
  };
}

function chapter(id: number, position: number, unread: boolean): DownloadCacheChapter {
  return {
    id, novelId: 1, name: `Chapter ${position}`, position, unread, progress: unread ? 0 : 100, readAt: null,
    downloadedAt: null, contentBytes: 1, mediaBytes: 0, mediaRepairNeeded: false, totalBytes: 1,
  };
}

function render(rows: DownloadCacheNovel[]) {
  const client = new QueryClient();
  client.setQueryData(["download-cache"], rows);
  return load(renderToStaticMarkup(
    <QueryClientProvider client={client}><MantineProvider><DownloadsStorageView /></MantineProvider></QueryClientProvider>,
  ));
}

describe("Downloads storage", () => {
  it("shows each novel's count and size on its own line that phones keep", () => {
    const $ = render([novel()]);
    expect($(".norea-downloads-novel-count").text()).toBe("120/300 cached · 340 MB");
    const css = readFileSync(new URL("../styles/downloads.css", import.meta.url), "utf8");
    const phone = css.slice(css.indexOf("@media (max-width: 767px)"));
    expect(phone).not.toMatch(/\.norea-downloads-novel-count[^{]*\{\s*display: none/);
    expect(phone).toMatch(/\.norea-downloads-novel-status \{\s*display: none/);
  });

  it("scrolls with the page instead of an inner scroller", () => {
    const css = readFileSync(new URL("../styles/downloads.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/\.norea-downloads-body \{[^}]*overflow/);
    expect(css).not.toMatch(/\.norea-downloads-page \{[^}]*overflow: hidden/);
  });

  it("gives each novel a Read action and keeps clean up labeled in the header", () => {
    const $ = render([novel()]);
    expect($('button[aria-label="Read Novel"]')).toHaveLength(1);
    expect($('button[aria-label="Novel options"]')).toHaveLength(1);
    expect($(".norea-page-header button").first().text()).toBe("Clean up");
    expect($('.norea-page-header button[aria-label="More"]')).toHaveLength(1);
    expect($(".norea-page-title").text()).toBe("Downloads");
  });
});

describe("automatic removal row", () => {
  it("shows the setting's state on top of a non-empty list", () => {
    expect(render([novel()])(".norea-downloads-auto-cleanup").text()).toBe("Auto-remove read chapters: Off");
    expect(render([])(".norea-downloads-auto-cleanup")).toHaveLength(0);
  });
});

describe("downloadedChapterToRead", () => {
  const chapters = [chapter(30, 3, true), chapter(10, 1, false), chapter(20, 2, true)];

  it("opens the remembered chapter when it is downloaded", () => {
    expect(downloadedChapterToRead(chapters, 10)?.id).toBe(10);
  });

  it("falls back to the first unread downloaded chapter, then the first one", () => {
    expect(downloadedChapterToRead(chapters, 99)?.id).toBe(20);
    expect(downloadedChapterToRead([chapter(10, 1, false), chapter(5, 0, false)], undefined)?.id).toBe(5);
    expect(downloadedChapterToRead([], undefined)).toBeUndefined();
  });
});
