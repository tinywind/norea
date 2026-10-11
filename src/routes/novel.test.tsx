import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  source: { data: null as null | { serverUrl: string; workId: string }, isPending: false, error: null },
  available: { data: new Set<string>(), isLoading: false, error: null },
  chapters: [] as { id: number; name: string; path: string; isDownloaded: boolean }[],
  novel: { id: 3, name: "Novel", path: "/novel", pluginId: "source-a", isLocal: true, inLibrary: false },
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: (options: { queryKey: unknown[] }) => options.queryKey[0] === "content-server"
  ? options.queryKey[1] === "novel-chapters" ? mocks.available : mocks.source
  : { data: options.queryKey.includes("chapters") ? mocks.chapters : mocks.novel, isLoading: false } }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouterState: () => "/novel?id=3" }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../lib/android-back-navigation", () => ({ usePageBackNavigation: vi.fn() }));
vi.mock("../store/library", () => ({ useLibraryStore: (selector: (state: unknown) => unknown) => selector({ defaultChapterSort: "asc", setDefaultChapterSort: vi.fn() }) }));
vi.mock("../store/reader", () => ({ useReaderStore: (selector: (state: unknown) => unknown) => selector({ lastReadChapterByNovel: {} }) }));
vi.mock("../components/AppFrame", () => ({ PageFrame: ({ children }: { children: ReactNode }) => <main>{children}</main>, StateView: ({ title }: { title: string }) => <p>{title}</p> }));
vi.mock("../components/ConsolePrimitives", () => ({ ConsolePanel: ({ children }: { children: ReactNode }) => <section>{children}</section>, ConsoleSectionHeader: () => null }));
vi.mock("@mantine/core", () => ({ Drawer: () => null, Loader: () => null, Text: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock("../components/novel/NovelWorkspace", () => ({ NovelWorkspace: ({ novel, allowSourceAccess, sourceUrl }: { novel: { isLocal: boolean }; allowSourceAccess: boolean; sourceUrl: string | null }) => <div data-local={String(novel.isLocal)} data-source-access={String(allowSourceAccess)} data-source-url={sourceUrl ?? ""} /> }));
vi.mock("../components/novel/NovelActions", () => ({ ChapterRelativeReadMenu: () => null, ChapterSortPicker: () => null, SelectionClearIcon: () => null }));
vi.mock("../components/novel/use-novel-metadata", () => ({ useNovelMetadata: () => ({ sourceDuplicateChapters: [], toggle: {}, refreshMetadata: {}, fullRefreshMetadata: {} }) }));
vi.mock("../components/novel/use-novel-chapter-actions", () => ({ useNovelChapterActions: () => ({ clearDownload: {}, clearSelectedDownloads: {}, setSelectedChapterReadState: {}, setRelativeChapterReadState: {}, repairMedia: {} }) }));
vi.mock("../components/novel/use-novel-download-statuses", () => ({ useNovelDownloadStatuses: () => new Map() }));
vi.mock("../components/novel/use-local-novel-editor", () => ({ useLocalNovelEditor: () => ({ addLocalChapters: {}, reorderLocalChapters: {} }) }));
vi.mock("../components/novel/NovelChapterList", () => ({ ReadIcon: () => null, VirtualChapterList: ({ chapters }: { chapters: { id: number; name: string }[] }) => <div>{chapters.map((chapter) => <p key={chapter.id}>{chapter.name}</p>)}</div> }));
vi.mock("../components/ReaderSettingsPanel", () => ({ ReaderSettingsPanel: () => null }));
vi.mock("../lib/plugins/manager", () => ({ pluginManager: { getPlugin: () => undefined } }));
vi.mock("../lib/tasks/source-tasks", () => ({ enqueueOpenSiteTask: vi.fn() }));
vi.mock("../lib/content-sync/novel-source", () => ({ readServerNovelSource: vi.fn(), listServerChapterPaths: vi.fn() }));

import { NovelDetailPage } from "./novel";

beforeEach(() => {
  mocks.source.data = null;
  mocks.source.isPending = false;
  mocks.novel.isLocal = true;
  mocks.chapters = [];
  mocks.available.data = new Set();
});

it("presents server-published local works as downloadable without changing stored metadata", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  const html = renderToStaticMarkup(<NovelDetailPage id={3} />);
  expect(html).toContain('data-local="false"');
  expect(html).toContain('data-source-access="false"');
  expect(mocks.novel.isLocal).toBe(true);
});

it("does not mount source cover or source controls until binding lookup completes", () => {
  mocks.novel.isLocal = false;
  mocks.source.isPending = true;
  const html = renderToStaticMarkup(<NovelDetailPage id={3} />);
  expect(html).toContain("novel.loading");
  expect(html).not.toContain("data-source-access");
});

it("retains local editing presentation for unbound local works", () => {
  expect(renderToStaticMarkup(<NovelDetailPage id={3} />)).toContain('data-local="true"');
});

it("shows available packages and downloaded chapters without deleting canonical metadata chapters", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  mocks.available.data = new Set(["/available"]);
  mocks.chapters = [
    { id: 1, name: "Available package", path: "/available", isDownloaded: false },
    { id: 2, name: "Local downloaded chapter", path: "/local", isDownloaded: true },
    { id: 3, name: "Metadata without a package", path: "/missing", isDownloaded: false },
  ];
  const html = renderToStaticMarkup(<NovelDetailPage id={3} />);
  expect(html).toContain("Available package");
  expect(html).toContain("Local downloaded chapter");
  expect(html).not.toContain("Metadata without a package");
  expect(mocks.chapters).toHaveLength(3);
});
