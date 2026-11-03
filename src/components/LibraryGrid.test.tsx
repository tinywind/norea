import { MantineProvider } from "@mantine/core";
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

import { LibraryGrid } from "./LibraryGrid";

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

it("shows the title only on the cover in covers-only mode", () => {
  const $ = renderGrid("cover-only");
  expect($("li > button").first().find("[aria-hidden=true] .norea-console-cover")).toHaveLength(0);
  expect($("li > button").first().text()).not.toContain("Author");
});
