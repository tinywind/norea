import { MantineProvider } from "@mantine/core";
import { readFileSync } from "node:fs";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { LibraryNovel } from "../db/queries/novel";
import type { LibraryDisplayMode } from "../store/library";

vi.mock("../i18n", () => ({
  useTranslation: () => ({ locale: "en", t: (key: string) => key }),
  formatRelativeTimeForLocale: () => "now",
}));
vi.mock("../lib/use-novel-cover-source", () => ({
  useNovelCoverSource: (_novel: unknown, options?: { allowSourceFallback?: boolean }) =>
    options?.allowSourceFallback ? "https://source.test/landscape-cover.png" : null,
}));

import { LibraryGrid, LibraryGridSkeleton } from "./LibraryGrid";

const novel: LibraryNovel = {
  id: 7, pluginId: "demo", path: "/book", name: "Book", cover: "/landscape-cover.png",
  author: "Author", inLibrary: true, isLocal: false, totalChapters: 10,
  chaptersDownloaded: 2, chaptersUnread: 8, readingProgress: 2,
  lastReadAt: null, lastUpdatedAt: 1,
};

it.each<LibraryDisplayMode>(["comfortable", "compact", "cover-only", "list"])(
  "recovers and fills the thumbnail with the cover in library %s mode",
  (displayMode) => {
    const html = renderToStaticMarkup(
      <MantineProvider>
        <LibraryGrid
          displayMode={displayMode}
          novels={[novel]}
          novelsPerRow={3}
          showDownloadBadges
          showNumberBadges={false}
          showUnreadBadges
        />
      </MantineProvider>,
    );
    expect(html).toContain('src="https://source.test/landscape-cover.png"');
    expect(html).toContain('style="object-fit:cover"');
  },
);

function renderGrid(displayMode: LibraryDisplayMode) {
  return load(renderToStaticMarkup(
    <MantineProvider>
      <LibraryGrid
        displayMode={displayMode}
        novels={[novel, { ...novel, id: 8, name: "Other", chaptersUnread: 0, chaptersDownloaded: 0 }]}
        novelsPerRow={3}
        showDownloadBadges
        showNumberBadges={false}
        showUnreadBadges
      />
    </MantineProvider>,
  ));
}

it.each<LibraryDisplayMode>(["comfortable", "compact", "cover-only", "list"])(
  "makes each %s item one button with no nested controls",
  (displayMode) => {
    const $ = renderGrid(displayMode);
    expect($("li > button")).toHaveLength(2);
    expect($("button button, button a, button input")).toHaveLength(0);
    expect($("[role=button]")).toHaveLength(0);
  },
);

it("names unread and downloaded badges for screen readers and drops the status dot", () => {
  const $ = renderGrid("comfortable");
  const first = $("li > button").first();
  expect(first.text()).toContain("library.grid.unreadBadge");
  expect(first.text()).toContain("library.grid.downloadedBadge");
  expect(first.text()).toContain("Author");
  expect($("li > button").last().text()).not.toContain("library.grid.unreadBadge");
  expect($.root().text()).not.toMatch(/common\.(synced|saved)/);
});

it("tells the unread and downloaded badges apart by icon and hover label", () => {
  const $ = renderGrid("comfortable");
  const unread = $('[data-kind="unread"]').first();
  const downloaded = $('[data-kind="downloaded"]').first();
  expect(unread.attr("title")).toBe("library.grid.unreadBadge");
  expect(downloaded.attr("title")).toBe("library.grid.downloadedBadge");
  expect(unread.find("svg").attr("class")).toContain("tabler-icon-point-filled");
  expect(downloaded.find("svg").attr("class")).toContain("tabler-icon-cloud-check");
});

it("keeps the downloaded and unread counts in one pill that never wraps", () => {
  const $ = renderGrid("comfortable");
  const group = $(".norea-library-badge-group").first();
  expect(group.children('[data-kind="downloaded"]')).toHaveLength(1);
  expect(group.children('[data-kind="unread"]')).toHaveLength(1);
  const css = readFileSync(new URL("../styles/library.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.norea-library-badges \{[^}]*flex-wrap: nowrap;/);
  expect(css).toMatch(/\.norea-library-badge-group \{[^}]*display: inline-flex;/);
});

it("keeps the counts at the top while selecting and draws the check as a ring that reads on any cover", () => {
  const css = readFileSync(new URL("../styles/library.css", import.meta.url), "utf8");
  const selecting = /\.norea-library-card\[aria-pressed\] \.norea-library-card-cover \.norea-library-badges \{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(selecting).toContain("left: calc(var(--norea-space-1) * 2 + 1.5rem)");
  expect(selecting).not.toContain("bottom");
  expect(css).toMatch(/\.norea-library-badge-group > \.norea-library-badge\[data-kind="downloaded"\] \{[^}]*flex-shrink: 1;/);
  const check = /\.norea-library-check \{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(check).toContain("background: rgb(0 0 0 / 0.25)");
  expect(check).toContain("border: 0.125rem solid #fff");
  expect(check).toContain("box-shadow: 0 1px 3px rgb(0 0 0 / 0.35)");
  expect(/\.norea-library-card-title \{([^}]*)\}/.exec(css)?.[1]).toContain("line-height: var(--norea-leading-normal)");
});

it("shows a goal novel's offline state on its downloaded badge, even before anything is downloaded", () => {
  const $ = load(renderToStaticMarkup(
    <MantineProvider>
      <LibraryGrid
        displayMode="comfortable"
        novels={[novel, { ...novel, id: 8, chaptersDownloaded: 0 }, { ...novel, id: 9 }, { ...novel, id: 10, chaptersDownloaded: 0 }]}
        novelsPerRow={3}
        offlineStates={new Map([[7, "ready"], [8, "downloading"], [9, "attention"]])}
        showDownloadBadges
        showNumberBadges={false}
        showUnreadBadges={false}
      />
    </MantineProvider>,
  ));
  const badges = $('[data-kind="downloaded"]');
  expect(badges.map((_, badge) => $(badge).attr("data-goal-state")).get()).toEqual(["ready", "downloading", "attention"]);
  expect(badges.eq(0).attr("title")).toBe("library.grid.downloadedBadge · library.grid.offline.ready");
  expect(badges.eq(0).find("svg").attr("class")).toContain("tabler-icon-cloud-check");
  expect(badges.eq(1).find("svg").attr("class")).toContain("tabler-icon-download");
  expect(badges.eq(2).find("svg").attr("class")).toContain("tabler-icon-alert-triangle");
});

it("shows the title only on the cover in covers-only mode", () => {
  const $ = renderGrid("cover-only");
  expect($("li > button").first().find("[aria-hidden=true] .norea-console-cover")).toHaveLength(0);
  expect($("li > button").first().text()).not.toContain("Author");
});

it.each<LibraryDisplayMode>(["comfortable", "list"])("announces one busy status for the %s loading skeleton", (displayMode) => {
  const $ = load(renderToStaticMarkup(
    <MantineProvider>
      <LibraryGridSkeleton displayMode={displayMode} label="Loading library" novelsPerRow={3} />
    </MantineProvider>,
  ));
  expect($("[role=status]").attr("aria-busy")).toBe("true");
  expect($("[role=status]").attr("aria-label")).toBe("Loading library");
  expect($("[role=status] > ul").attr("aria-hidden")).toBe("true");
  expect($("button")).toHaveLength(0);
});
