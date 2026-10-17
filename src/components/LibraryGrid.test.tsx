import { MantineProvider } from "@mantine/core";
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
  "recovers and displays the entire cover in library %s mode",
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
    expect(html).toContain('style="object-fit:contain"');
  },
);
