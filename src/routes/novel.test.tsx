import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { ChapterListRow } from "../db/queries/chapter";
import type { NovelDetailRecord } from "../db/queries/novel";

const mocks = vi.hoisted(() => ({
  source: { data: null as null | { serverUrl: string; workId: string }, isPending: false, isFetching: false, error: null as unknown },
  available: { data: { paths: new Set<string>(), numbers: new Set<number>() } as { paths: Set<string>; numbers: Set<number> } | undefined, isLoading: false, error: null as unknown },
  sync: { serverError: null as unknown, sourceError: null as unknown },
  metadataError: null as unknown,
  novelQuery: { isLoading: false, error: null as unknown },
  installed: false,
  queries: [] as { queryKey: unknown[]; enabled?: boolean }[],
  chapters: [] as ChapterListRow[],
  novel: {
    id: 3, name: "Saved novel", path: "/novel", pluginId: "source-a", isLocal: true, inLibrary: false,
    cover: null, summary: "Saved summary", author: null, artist: null, status: null, genres: null, rating: null,
    createdAt: 1, updatedAt: 1, libraryAddedAt: null, lastReadAt: null,
  } as NovelDetailRecord,
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
  mocks.queries.push(options);
  return options.queryKey[0] === "content-server"
  ? options.queryKey[1] === "novel-chapters" ? mocks.available : mocks.source
  : options.queryKey.includes("chapters")
    ? { data: mocks.chapters, isLoading: false }
    : { ...mocks.novelQuery, data: mocks.novel };
} }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouterState: () => "/novel?id=3" }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../lib/android-back-navigation", () => ({ usePageBackNavigation: vi.fn() }));
vi.mock("../store/library", () => ({ useLibraryStore: (selector: (state: unknown) => unknown) => selector({ defaultChapterSort: "asc", setDefaultChapterSort: vi.fn() }) }));
vi.mock("../store/reader", () => ({ useReaderStore: (selector: (state: unknown) => unknown) => selector({ lastReadChapterByNovel: {} }) }));
vi.mock("../components/novel/use-novel-metadata", () => ({ useNovelMetadata: () => ({ sourceDuplicateChapters: [], toggle: {}, refreshMetadata: { error: mocks.metadataError }, fullRefreshMetadata: {} }) }));
vi.mock("../components/novel/use-server-novel-sync", () => ({ useServerNovelSync: () => mocks.sync }));
vi.mock("../components/novel/use-novel-chapter-actions", () => ({ useNovelChapterActions: () => ({ clearDownload: {}, clearSelectedDownloads: {}, setSelectedChapterReadState: {}, setRelativeChapterReadState: {}, repairMedia: {} }) }));
vi.mock("../components/novel/use-novel-download-statuses", () => ({ useNovelDownloadStatuses: () => new Map() }));
vi.mock("../components/novel/use-local-novel-editor", () => ({ useLocalNovelEditor: () => ({ addLocalChapters: {}, reorderLocalChapters: {} }) }));
vi.mock("../components/ReaderSettingsPanel", () => ({ ReaderSettingsPanel: () => null }));
vi.mock("../lib/plugins/manager", () => ({ pluginManager: { getPlugin: () => mocks.installed ? { id: "source-a", name: "Source", getBaseUrl: () => "https://source.example" } : undefined } }));
vi.mock("../lib/tasks/source-tasks", () => ({ enqueueOpenSiteTask: vi.fn() }));
vi.mock("../lib/content-sync/novel-source", () => ({ readServerNovelSource: vi.fn(), listServerChapterAvailability: vi.fn() }));

import { NovelDetailPage } from "./novel";

const chapter: ChapterListRow = {
  id: 1, novelId: 3, name: "Saved chapter", path: "/chapter", chapterNumber: "1", position: 1, page: "1",
  bookmark: false, unread: true, progress: 0, isDownloaded: false, sourceContentType: "html", contentType: "html",
  contentBytes: 0, mediaBytes: 0, mediaRepairNeeded: false, releaseTime: null, readAt: null,
  createdAt: null, foundAt: 1, updatedAt: 1,
};

function renderPage() {
  return load(renderToStaticMarkup(<MantineProvider><NovelDetailPage id={3} /></MantineProvider>));
}

beforeEach(() => {
  mocks.queries.length = 0;
  mocks.source.data = null;
  mocks.source.isPending = false;
  mocks.source.isFetching = false;
  mocks.source.error = null;
  mocks.novel.isLocal = true;
  mocks.novel.path = "/novel";
  mocks.novelQuery.isLoading = false;
  mocks.novelQuery.error = null;
  mocks.chapters = [];
  mocks.available.data = { paths: new Set(), numbers: new Set() };
  mocks.available.isLoading = false;
  mocks.available.error = null;
  mocks.sync.serverError = null;
  mocks.sync.sourceError = null;
  mocks.metadataError = null;
  mocks.installed = false;
});

it("presents server-published local works as downloadable without changing stored metadata", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  const $ = renderPage();
  expect($("button[aria-label='novel.batchDownload.open']")).toHaveLength(1);
  expect($("button[aria-label='novel.local.addChapters']")).toHaveLength(0);
  expect($("button[aria-label='novel.openSource']")).toHaveLength(0);
  expect(mocks.novel.isLocal).toBe(true);
});

it.each([true, false])("shows saved work details and chapters while server binding is pending (local: %s)", (isLocal) => {
  mocks.novel.isLocal = isLocal;
  mocks.source.isPending = true;
  mocks.chapters = [{ ...chapter, isDownloaded: true }];
  const $ = renderPage();
  expect($("h1").text()).toBe("Saved novel");
  expect($(".norea-novel-summary-content").text()).toContain("Saved summary");
  expect($(".norea-novel-chapter-open").text()).toContain("Saved chapter");
  expect($("button[aria-label='novel.startReading']").prop("disabled")).toBe(false);
  expect($.text()).not.toContain("novel.loading");
  expect($("button[aria-label='novel.openSource']")).toHaveLength(0);
});

it("keeps saved work details visible while an empty server binding is being rechecked", () => {
  mocks.source.isFetching = true;
  expect(renderPage()("h1").text()).toBe("Saved novel");
});

it("keeps saved work details visible when server binding cannot be read", () => {
  mocks.source.error = new Error("Invalid server binding");
  const $ = renderPage();
  expect($("h1").text()).toBe("Saved novel");
  expect($.text()).not.toContain("Invalid server binding");
  expect($.text()).not.toContain("novel.loadFailed");
});

it("keeps saved chapters visible without automatic server or source refresh errors", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  mocks.available.data = undefined;
  mocks.available.error = new Error("Server unavailable");
  mocks.sync.serverError = new Error("Server refresh failed");
  mocks.sync.sourceError = new Error("Source refresh failed");
  mocks.chapters = [{ ...chapter }];
  const $ = renderPage();
  expect($(".norea-novel-chapter-open").text()).toContain("Saved chapter");
  expect($.text()).not.toContain("Server unavailable");
  expect($.text()).not.toContain("contentSync.workRefreshFailed");
  expect($.text()).not.toContain("contentSync.sourceRefreshFailed");
});

it("still reports an explicit metadata refresh failure", () => {
  mocks.metadataError = new Error("Requested refresh failed");
  expect(renderPage().text()).toContain("Requested refresh failed");
});

it("still reports a local work loading failure", () => {
  mocks.novelQuery.error = new Error("Local work unavailable");
  const $ = renderPage();
  expect($.text()).toContain("novel.loadFailed");
  expect($.text()).toContain("Local work unavailable");
});

it("keeps installed source actions available while server binding is pending", () => {
  mocks.novel.isLocal = false;
  mocks.source.isPending = true;
  mocks.installed = true;
  const $ = renderPage();
  expect($("button[aria-label='novel.openSource']").prop("disabled")).toBe(false);
});

it("does not expose source actions for a server folder path before binding lookup finishes", () => {
  mocks.novel.isLocal = false;
  mocks.novel.path = "norea-folder:work";
  mocks.source.isPending = true;
  mocks.installed = true;
  const $ = renderPage();
  expect($("h1").text()).toBe("Saved novel");
  expect($("button[aria-label='novel.openSource']")).toHaveLength(0);
});

it("retains local editing presentation for unbound local works", () => {
  expect(renderPage()("button[aria-label='novel.local.editMetadata']")).toHaveLength(1);
});

it("shows available packages and downloaded chapters without deleting canonical metadata chapters", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  mocks.available.data = { paths: new Set(["/available"]), numbers: new Set() };
  mocks.chapters = [
    { ...chapter, name: "Available package", path: "/available" },
    { ...chapter, id: 2, name: "Local downloaded chapter", path: "/local", isDownloaded: true },
    { ...chapter, id: 3, name: "Metadata without a package", path: "/missing" },
  ];
  const text = renderPage()(".norea-novel-chapter-open").text();
  expect(text).toContain("Available package");
  expect(text).toContain("Local downloaded chapter");
  expect(text).not.toContain("Metadata without a package");
  expect(mocks.chapters).toHaveLength(3);
});

it("shows saved chapters immediately while server availability is still pending", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  mocks.available.data = undefined;
  mocks.available.isLoading = true;
  mocks.chapters = [{ ...chapter }];
  expect(renderPage()(".norea-novel-chapter-open").text()).toContain("Saved chapter");
});

it("shows a server folder chapter matching the cached source chapter number without a plugin", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  mocks.available.data = { paths: new Set(["norea-folder:1"]), numbers: new Set([1]) };
  mocks.chapters = [{ ...chapter, name: "Server chapter", path: "/chapter/1", chapterNumber: "1.0" }];
  expect(renderPage()(".norea-novel-chapter-open").text()).toContain("Server chapter");
});

it("shows source-only chapters and source controls for a bound work with its original path and installed plugin", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  mocks.novel.isLocal = false;
  mocks.installed = true;
  mocks.chapters = [{ ...chapter, name: "New source chapter" }];
  const $ = renderPage();
  expect($(".norea-novel-chapter-open").text()).toContain("New source chapter");
  expect($("button[aria-label='novel.openSource']")).toHaveLength(1);
  expect(mocks.queries.find(query => query.queryKey[1] === "novel-chapters")?.enabled).toBe(false);
});

it("still queries server availability when the source plugin cannot provide chapters", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  renderPage();
  expect(mocks.queries.find(query => query.queryKey[1] === "novel-chapters")?.enabled).toBe(true);
});
