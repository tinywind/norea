import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  source: { data: null as null | { serverUrl: string; workId: string }, isPending: false, error: null },
  available: { data: { paths: new Set<string>(), numbers: new Set<number>() } as { paths: Set<string>; numbers: Set<number> } | undefined, isLoading: false, error: null },
  installed: false,
  queries: [] as { queryKey: unknown[]; enabled?: boolean }[],
  chapters: [] as { id: number; name: string; path: string; chapterNumber?: string; isDownloaded: boolean }[],
  novel: { id: 3, name: "Novel", path: "/novel", pluginId: "source-a", isLocal: true, inLibrary: false },
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
  mocks.queries.push(options);
  return options.queryKey[0] === "content-server"
  ? options.queryKey[1] === "novel-chapters" ? mocks.available : mocks.source
  : { data: options.queryKey.includes("chapters") ? mocks.chapters : mocks.novel, isLoading: false };
} }));
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
vi.mock("../components/novel/use-server-novel-sync", () => ({ useServerNovelSync: () => ({ serverError: null, sourceError: null }) }));
vi.mock("../components/novel/use-novel-chapter-actions", () => ({ useNovelChapterActions: () => ({ clearDownload: {}, clearSelectedDownloads: {}, setSelectedChapterReadState: {}, setRelativeChapterReadState: {}, repairMedia: {} }) }));
vi.mock("../components/novel/use-novel-download-statuses", () => ({ useNovelDownloadStatuses: () => new Map() }));
vi.mock("../components/novel/use-local-novel-editor", () => ({ useLocalNovelEditor: () => ({ addLocalChapters: {}, reorderLocalChapters: {} }) }));
vi.mock("../components/novel/NovelChapterList", () => ({ ReadIcon: () => null, VirtualChapterList: ({ chapters }: { chapters: { id: number; name: string }[] }) => <div>{chapters.map((chapter) => <p key={chapter.id}>{chapter.name}</p>)}</div> }));
vi.mock("../components/ReaderSettingsPanel", () => ({ ReaderSettingsPanel: () => null }));
vi.mock("../lib/plugins/manager", () => ({ pluginManager: { getPlugin: () => mocks.installed ? { id: "source-a", name: "Source", getBaseUrl: () => "https://source.example" } : undefined } }));
vi.mock("../lib/tasks/source-tasks", () => ({ enqueueOpenSiteTask: vi.fn() }));
vi.mock("../lib/content-sync/novel-source", () => ({ readServerNovelSource: vi.fn(), listServerChapterAvailability: vi.fn() }));

import { NovelDetailPage } from "./novel";

beforeEach(() => {
  mocks.queries.length = 0;
  mocks.source.data = null;
  mocks.source.isPending = false;
  mocks.novel.isLocal = true;
  mocks.chapters = [];
  mocks.available.data = { paths: new Set(), numbers: new Set() };
  mocks.available.isLoading = false;
  mocks.installed = false;
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
  mocks.available.data = { paths: new Set(["/available"]), numbers: new Set() };
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

it("shows saved chapters immediately while server availability is still pending", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  mocks.available.data = undefined;
  mocks.available.isLoading = true;
  mocks.chapters = [{ id: 1, name: "Saved chapter", path: "/chapter", isDownloaded: false }];
  expect(renderToStaticMarkup(<NovelDetailPage id={3} />)).toContain("Saved chapter");
});

it("shows a server folder chapter matching the cached source chapter number without a plugin", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  mocks.available.data = { paths: new Set(["norea-folder:1"]), numbers: new Set([1]) };
  mocks.chapters = [{ id: 1, name: "Server chapter", path: "/chapter/1", chapterNumber: "1.0", isDownloaded: false }];
  expect(renderToStaticMarkup(<NovelDetailPage id={3} />)).toContain("Server chapter");
});

it("shows source-only chapters and source controls for a bound work with its original path and installed plugin", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  mocks.novel.isLocal = false;
  mocks.installed = true;
  mocks.chapters = [{ id: 1, name: "New source chapter", path: "/chapter", isDownloaded: false }];
  const html = renderToStaticMarkup(<NovelDetailPage id={3} />);
  expect(html).toContain("New source chapter");
  expect(html).toContain('data-source-access="true"');
  expect(mocks.queries.find(query => query.queryKey[1] === "novel-chapters")?.enabled).toBe(false);
});

it("still queries server availability when the source plugin cannot provide chapters", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  renderToStaticMarkup(<NovelDetailPage id={3} />);
  expect(mocks.queries.find(query => query.queryKey[1] === "novel-chapters")?.enabled).toBe(true);
});
