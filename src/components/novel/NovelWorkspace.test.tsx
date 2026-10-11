import { MantineProvider } from "@mantine/core";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../lib/plugins/manager", () => ({ pluginManager: { getPlugin: () => ({ id: "source-a" }) } }));
vi.mock("../../lib/use-novel-cover-source", () => ({ useNovelCoverSource: (_novel: unknown, options: { allowSourceFallback: boolean }) => options.allowSourceFallback ? "https://original.test/cover.jpg" : null }));

import { NovelWorkspace } from "./NovelWorkspace";

const props: ComponentProps<typeof NovelWorkspace> = {
  allowSourceAccess: false,
  novel: {
    id: 3, pluginId: "source-a", path: "/novel", name: "Novel", cover: "https://original.test/cover.jpg",
    summary: null, author: null, artist: null, status: null, genres: null, inLibrary: false, isLocal: false,
    createdAt: 1, updatedAt: 1, libraryAddedAt: null, lastReadAt: null,
  },
  chapters: [], downloadStatuses: new Map(), lastReadChapterId: undefined,
  localChapterAdding: false, fullMetadataRefreshing: false, metadataRefreshing: false,
  onBack: vi.fn(), onAddLocalChapters: vi.fn(), onBatchDownload: vi.fn(), onEditLocalMetadata: vi.fn(),
  onOpenReaderSettings: vi.fn(), onOpenSource: vi.fn(), onRead: vi.fn(), onRefreshFullMetadata: vi.fn(),
  onRefreshMetadata: vi.fn(), onToggleLibrary: vi.fn(), sourceName: "Source", sourceUrl: null, toggleBusy: false,
};

it("does not expose original-site covers or site actions for a server-bound work", () => {
  const html = renderToStaticMarkup(<MantineProvider><NovelWorkspace {...props} /></MantineProvider>);
  expect(html).not.toContain("https://original.test/cover.jpg");
  expect(html).not.toContain("novel.openSource");
  expect(html).not.toContain("novel.local.addChapters");
});

it("keeps source-site cover fallback available for unbound source works", () => {
  const html = renderToStaticMarkup(<MantineProvider><NovelWorkspace {...props} allowSourceAccess /></MantineProvider>);
  expect(html).toContain("https://original.test/cover.jpg");
  expect(html).toContain("novel.openSource");
});
