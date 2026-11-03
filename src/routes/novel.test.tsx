import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { ChapterListRow } from "../db/queries/chapter";
import type { NovelDetailRecord } from "../db/queries/novel";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  source: { data: null as null | { serverUrl: string; workId: string }, isPending: false, isFetching: false, error: null as unknown },
  available: { data: { paths: new Map<string, boolean>(), numbers: new Map<number, boolean>() } as { paths: Map<string, boolean>; numbers: Map<number, boolean> } | undefined, isLoading: false, error: null as unknown },
  sync: { serverError: null as unknown, sourceError: null as unknown, retry: vi.fn() },
  metadataError: null as unknown,
  toggleMutate: vi.fn(),
  toast: vi.fn(),
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
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate, useRouterState: () => "/novel?id=3" }));
vi.mock("../i18n", () => ({ useTranslation: () => ({
  t: (key: string, values?: Record<string, unknown>) => key === "novel.chapterSummary"
    ? `${values?.downloaded}/${values?.total} stored`
    : key === "novel.serverChapterStatus" ? `Server: ${values?.status}` : key,
}) }));
vi.mock("../store/library", () => ({ useLibraryStore: (selector: (state: unknown) => unknown) => selector({ defaultChapterSort: "asc", setDefaultChapterSort: vi.fn() }) }));
vi.mock("../store/reader", () => ({ useReaderStore: (selector: (state: unknown) => unknown) => selector({ lastReadChapterByNovel: {} }) }));
vi.mock("../components/novel/use-novel-metadata", () => ({ useNovelMetadata: () => ({ sourceDuplicateChapters: [], toggle: { mutate: mocks.toggleMutate }, refreshMetadata: { error: mocks.metadataError }, fullRefreshMetadata: {} }) }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.toast, hide: vi.fn() } }));
vi.mock("../components/novel/use-server-novel-sync", () => ({ useServerNovelSync: () => mocks.sync }));
vi.mock("../components/novel/use-novel-chapter-actions", () => ({ useNovelChapterActions: () => ({ clearDownload: {}, clearSelectedDownloads: {}, setSelectedChapterReadState: {}, setRelativeChapterReadState: {}, repairMedia: {} }) }));
vi.mock("../components/novel/use-novel-download-statuses", () => ({ useNovelDownloadStatuses: () => new Map() }));
vi.mock("../components/novel/use-local-novel-editor", () => ({ useLocalNovelEditor: () => ({ addLocalChapters: {}, reorderLocalChapters: {} }) }));
vi.mock("../components/ReaderSettingsPanel", () => ({ ReaderSettingsPanel: () => null }));
vi.mock("../lib/plugins/manager", () => ({ pluginManager: { getPlugin: () => mocks.installed ? { id: "source-a", name: "Source", getBaseUrl: () => "https://source.example" } : undefined } }));
vi.mock("../lib/tasks/source-tasks", () => ({ enqueueOpenSiteTask: vi.fn() }));
vi.mock("../lib/content-sync/novel-source", () => ({ readServerNovelSource: vi.fn(), listServerChapterAvailability: vi.fn() }));

import { NovelDetailPage } from "./novel";
import { PageActivityContext } from "../lib/page-activity";
import { buildBatchDownloadTargets, buildPreviousChapterDownloadTargets } from "../components/novel/novel-detail-model";
import { collectElements, mountBackNavigationHarness } from "../lib/android-back-navigation.test-support";

const chapter: ChapterListRow = {
  id: 1, novelId: 3, name: "Saved chapter", path: "/chapter", chapterNumber: "1", position: 1, page: "1",
  bookmark: false, unread: true, progress: 0, isDownloaded: false, sourceContentType: "html", contentType: "html",
  contentBytes: 0, mediaBytes: 0, mediaRepairNeeded: false, releaseTime: null, readAt: null,
  createdAt: null, foundAt: 1, updatedAt: 1,
};

it("downloads chapters before the lowest selected position regardless of selection or display order", () => {
  const chapters = Array.from({ length: 8 }, (_, index) => ({ ...chapter, id: 80 - index, position: index + 1 }));
  const selected = new Set([73, 76]);
  for (const ordered of [chapters, [...chapters].reverse()]) {
    expect(buildPreviousChapterDownloadTargets(ordered, selected, new Map()).map(row => row.position)).toEqual([1, 2, 3, 4]);
  }
  expect(buildPreviousChapterDownloadTargets(chapters, new Set(), new Map())).toEqual([]);
  expect(buildPreviousChapterDownloadTargets(chapters, new Set([80, 73]), new Map())).toEqual([]);
});

it("skips stored and active chapters before a multi-selection download anchor", () => {
  const chapters = Array.from({ length: 7 }, (_, index) => ({ ...chapter, id: index + 1, position: index + 1 }));
  chapters[0]!.isDownloaded = true;
  chapters[1]!.contentBytes = 100;
  chapters[1]!.mediaRepairNeeded = true;
  const statuses = new Map([[3, { kind: "queued" as const }]]);
  expect(buildPreviousChapterDownloadTargets(chapters, new Set([6, 7]), statuses).map(row => row.id)).toEqual([4, 5]);
});

it("excludes stored partial bodies from missing-chapter batch scopes", () => {
  const partial = { ...chapter, id: 2, position: 2, contentBytes: 100, mediaRepairNeeded: true };
  const missing = { ...chapter, id: 3, position: 3 };
  const targets = buildBatchDownloadTargets([
    { ...chapter, isDownloaded: true }, partial, missing,
  ], 1, new Map());
  for (const scope of ["all", "unread", "next10", "next30"] as const) {
    expect(targets[scope].map((row) => row.id)).toEqual([3]);
  }
  expect(partial.isDownloaded).toBe(false);
  expect(partial.mediaRepairNeeded).toBe(true);
});

interface MenuItem { disabled?: boolean; label: string; onClick: () => void }

/** Mounts the page and returns its overflow menu items. */
async function withOverflowItems(check: (items: MenuItem[]) => Promise<void> | void) {
  const harness = mountBackNavigationHarness();
  let tree: ReturnType<typeof NovelDetailPage> | undefined;
  function PageProbe() {
    tree = NovelDetailPage({ id: 3 });
    return null;
  }
  try {
    await harness.render(<PageProbe />);
    const menu = collectElements(tree).find((element) => Array.isArray(element.props.items))!;
    await check(menu.props.items as MenuItem[]);
  } finally {
    await harness.unmount();
  }
}

const overflowLabels = async () => {
  let labels: string[] = [];
  await withOverflowItems((items) => { labels = items.map((item) => item.label); });
  return labels;
};

function renderPage(active = true) {
  return load(renderToStaticMarkup(<MantineProvider><PageActivityContext.Provider value={active}><NovelDetailPage id={3} /></PageActivityContext.Provider></MantineProvider>));
}

beforeEach(() => {
  mocks.navigate.mockReset();
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
  mocks.available.data = { paths: new Map(), numbers: new Map() };
  mocks.available.isLoading = false;
  mocks.available.error = null;
  mocks.sync.serverError = null;
  mocks.sync.sourceError = null;
  mocks.sync.retry.mockReset();
  mocks.metadataError = null;
  mocks.installed = false;
  mocks.toggleMutate.mockReset();
  mocks.toast.mockReset();
});

it("pauses detail, chapter, and server queries while its page slot is hidden", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  renderPage(false);
  const pageQueries = () => mocks.queries.filter(query => query.queryKey[1] === "detail" || query.queryKey[1] === "novel-source" || query.queryKey[1] === "novel-chapters");
  expect(pageQueries()).toHaveLength(4);
  expect(pageQueries().every(query => query.enabled === false)).toBe(true);
  mocks.queries.length = 0;
  renderPage();
  expect(pageQueries().every(query => query.enabled === true)).toBe(true);
});

it("presents server-published local works as downloadable without changing stored metadata", async () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  const $ = renderPage();
  expect($("button").filter((_, button) => $(button).text() === "novel.download")).toHaveLength(1);
  expect($.text()).not.toContain("contentSync.deleteServer");
  const labels = await overflowLabels();
  expect(labels).toContain("contentSync.manageChapters");
  expect(labels).not.toContain("novel.local.addChapters");
  expect(labels).not.toContain("novel.openInWebView");
  expect(mocks.novel.isLocal).toBe(true);
});

it.each([true, false])("shows saved work details and chapters while server binding is pending (local: %s)", async (isLocal) => {
  mocks.novel.isLocal = isLocal;
  mocks.source.isPending = true;
  mocks.chapters = [{ ...chapter, isDownloaded: true }];
  const $ = renderPage();
  expect($("h1").text()).toBe("Saved novel");
  expect($("p").filter((_, paragraph) => $(paragraph).text() === "Saved summary")).toHaveLength(1);
  expect($(".norea-novel-chapter-open").text()).toContain("Saved chapter");
  expect($("button").filter((_, button) => $(button).text() === "novel.startReading").prop("disabled")).toBe(false);
  expect($.text()).not.toContain("novel.loading");
  expect(await overflowLabels()).not.toContain("novel.openInWebView");
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

it("keeps automatic content-server failures off the work page", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  mocks.available.data = undefined;
  mocks.available.error = new Error("Server unavailable");
  mocks.sync.serverError = new Error("Server refresh failed");
  mocks.chapters = [{ ...chapter }];
  const $ = renderPage();
  expect($(".norea-novel-chapter-open").text()).toContain("Saved chapter");
  expect($.text()).not.toContain("Server unavailable");
  expect($.text()).not.toContain("novel.syncFailed");
  expect($.text()).not.toContain("contentSync.workRefreshFailed");
});

it("keeps saved chapters visible beside a retryable source refresh notice", () => {
  mocks.sync.sourceError = new Error("Source refresh failed");
  mocks.chapters = [{ ...chapter }];
  const $ = renderPage();
  expect($(".norea-novel-chapter-open").text()).toContain("Saved chapter");
  expect($.text()).toContain("novel.syncFailed");
  expect($.text()).toContain("contentSync.sourceRefreshFailed");
  expect($("button").filter((_, button) => $(button).text() === "common.retry")).toHaveLength(1);
  expect($.text()).not.toContain("Source refresh failed");
  expect($("[title='Source refresh failed']")).toHaveLength(1);
});

it("leaves offline and verification source failures to the task queue", () => {
  mocks.chapters = [{ ...chapter }];
  mocks.sync.sourceError = Object.assign(new Error("offline"), { code: "network-unavailable" });
  expect(renderPage().text()).not.toContain("novel.syncFailed");
  mocks.sync.sourceError = {
    code: "source-access-required",
    message: "Verify",
    challenge: { kind: "cloudflare", url: "https://example.com/" },
  };
  expect(renderPage().text()).not.toContain("novel.syncFailed");
});

it("shows no refresh notice when automatic refresh succeeds", () => {
  mocks.chapters = [{ ...chapter }];
  expect(renderPage().text()).not.toContain("novel.syncFailed");
});

it("runs the automatic refresh again from the notice", async () => {
  mocks.sync.sourceError = new Error("Source refresh failed");
  const harness = mountBackNavigationHarness();
  let tree: ReturnType<typeof NovelDetailPage> | undefined;
  function PageProbe() {
    tree = NovelDetailPage({ id: 3 });
    return null;
  }
  try {
    await harness.render(<PageProbe />);
    const notice = collectElements(tree).find((element) => element.props.title === "novel.syncFailed")!;
    expect(notice.props.message).toBeTruthy();
    await harness.run(() => (notice.props.action as { onClick: () => void }).onClick());
    expect(mocks.sync.retry).toHaveBeenCalledTimes(1);
  } finally {
    await harness.unmount();
  }
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

it("keeps installed source actions available while server binding is pending", async () => {
  mocks.novel.isLocal = false;
  mocks.source.isPending = true;
  mocks.installed = true;
  await withOverflowItems((items) => {
    expect(items.find((item) => item.label === "novel.openInWebView")?.disabled).toBe(false);
  });
});

it("does not expose source actions for a server folder path before binding lookup finishes", async () => {
  mocks.novel.isLocal = false;
  mocks.novel.path = "norea-folder:work";
  mocks.source.isPending = true;
  mocks.installed = true;
  const $ = renderPage();
  expect($("h1").text()).toBe("Saved novel");
  expect(await overflowLabels()).not.toContain("novel.openInWebView");
});

it("retains local editing presentation for unbound local works", async () => {
  const labels = await overflowLabels();
  expect(labels).toEqual(expect.arrayContaining(["novel.local.editMetadata", "novel.local.addChapters", "novel.local.reorderChapters"]));
  expect(labels).not.toContain("contentSync.manageChapters");
  expect(labels).not.toContain("novel.checkNewChapters");
  expect(renderPage().text()).not.toContain("contentSync.deleteServer");
});

it("offers the source refresh, migration and reader actions in the overflow for library source works", async () => {
  mocks.novel.isLocal = false;
  mocks.novel.inLibrary = true;
  mocks.installed = true;
  try {
    expect(await overflowLabels()).toEqual([
      "novel.checkNewChapters",
      "novel.refreshAllDetails",
      "categories.editWork",
      "novel.mergeSource",
      "novel.openInWebView",
      "novel.readerSettingsForNovel",
    ]);
  } finally {
    mocks.novel.inLibrary = false;
  }
});

it("shows available packages and downloaded chapters without deleting canonical metadata chapters", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  mocks.available.data = { paths: new Map([["/available", true]]), numbers: new Map() };
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

it("keeps an incomplete server chapter visible and downloadable without a source plugin", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  mocks.available.data = { paths: new Map([[chapter.path, false]]), numbers: new Map() };
  mocks.chapters = [{ ...chapter }];

  const $ = renderPage();
  expect($(".norea-novel-chapter-open").text()).toContain("Saved chapter");
  expect($(".norea-novel-chapter-meta-row").text()).toContain("Server: contentSync.incomplete");
  expect($("button[aria-label='novel.downloadChapter']")).toHaveLength(1);
  expect($("button[aria-label='novel.repairChapterMedia']")).toHaveLength(0);
  expect(mocks.chapters[0]).toMatchObject({ isDownloaded: false, mediaRepairNeeded: false });
});

it("preserves a complete local chapter when its server copy is incomplete", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  mocks.available.data = { paths: new Map([[chapter.path, false]]), numbers: new Map() };
  mocks.chapters = [{ ...chapter, isDownloaded: true, contentBytes: 100 }];

  const $ = renderPage();
  expect($(".norea-novel-chapter-meta-row").text()).toContain("Server: contentSync.incomplete");
  expect($(".norea-novel-chapter-flags--desktop [aria-label='novel.downloaded']")).toHaveLength(1);
  expect($(".norea-novel-chapter-flags--desktop [aria-label='novel.mediaRepairNeeded']")).toHaveLength(0);
  expect($("button[aria-label='novel.downloadChapter']")).toHaveLength(0);
  expect($("button[aria-label='novel.repairChapterMedia']")).toHaveLength(0);
  expect(mocks.chapters[0]).toMatchObject({ isDownloaded: true, mediaRepairNeeded: false });
});

it("shows and counts a stored partial body even when its server package is unavailable", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  mocks.chapters = [{ ...chapter, contentBytes: 100, mediaRepairNeeded: true }];
  const $ = renderPage();
  expect($(".norea-novel-chapter-open").text()).toContain("Saved chapter");
  expect($.text()).toContain("1/1 stored");
  expect(mocks.chapters[0]).toMatchObject({ isDownloaded: false, mediaRepairNeeded: true });
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
  mocks.available.data = { paths: new Map([["norea-folder:1", false]]), numbers: new Map([[1, false]]) };
  mocks.chapters = [{ ...chapter, name: "Server chapter", path: "/chapter/1", chapterNumber: "1.0" }];
  expect(renderPage()(".norea-novel-chapter-open").text()).toContain("Server chapter");
});

it("shows source-only chapters and source controls for a bound work with its original path and installed plugin", async () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  mocks.novel.isLocal = false;
  mocks.installed = true;
  mocks.chapters = [{ ...chapter, name: "New source chapter" }];
  const $ = renderPage();
  expect($(".norea-novel-chapter-open").text()).toContain("New source chapter");
  expect(await overflowLabels()).toContain("novel.openInWebView");
  expect(mocks.queries.find(query => query.queryKey[1] === "novel-chapters")?.enabled).toBe(true);
});

it("still queries server availability when the source plugin cannot provide chapters", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  renderPage();
  expect(mocks.queries.find(query => query.queryKey[1] === "novel-chapters")?.enabled).toBe(true);
});

it("closes the novel reader settings drawer on back before leaving the page", async () => {
  const harness = mountBackNavigationHarness();
  let tree: ReturnType<typeof NovelDetailPage> | undefined;
  function PageProbe() {
    tree = NovelDetailPage({ id: 3 });
    return null;
  }
  const drawer = () => collectElements(tree).find((element) => element.props.title === "readerSettings.novel.title")!;
  const readerSettingsItem = () => (collectElements(tree).find((element) => Array.isArray(element.props.items))!
    .props.items as MenuItem[]).find((item) => item.label === "novel.readerSettingsForNovel")!;
  try {
    await harness.render(<PageProbe />);
    await harness.run(() => readerSettingsItem().onClick());
    expect(drawer().props.opened).toBe(true);

    expect(harness.pressBack()).toBe(true);
    expect(drawer().props.opened).toBe(false);
    expect(mocks.navigate).not.toHaveBeenCalled();

    harness.pressBack();
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/", replace: true });
  } finally {
    await harness.unmount();
  }
});

it("offers Change category in the added-to-library toast and opens the category sheet from it", async () => {
  mocks.novel.inLibrary = true;
  const harness = mountBackNavigationHarness();
  let tree: ReturnType<typeof NovelDetailPage> | undefined;
  function PageProbe() {
    tree = NovelDetailPage({ id: 3 });
    return null;
  }
  const find = (predicate: (props: Record<string, unknown>) => boolean) =>
    collectElements(tree).find((element) => predicate(element.props))!;
  try {
    await harness.render(<PageProbe />);
    await harness.run(() => (find((props) => typeof props.onToggleLibrary === "function").props.onToggleLibrary as () => void)());
    const options = mocks.toggleMutate.mock.calls[0]![1] as { onSuccess: (result: unknown) => void };
    await harness.run(() => options.onSuccess({ inLibrary: true, novel: { id: 3 } }));
    const message = (mocks.toast.mock.calls[0]![0] as { message: ReturnType<typeof NovelDetailPage> }).message;
    const changeCategory = collectElements(message).find((element) => element.props.children === "novel.changeCategory")!;
    const editor = () => collectElements(find((props) => props.categoryChips !== undefined).props.categoryChips as ReturnType<typeof NovelDetailPage>)[0]!;
    expect(editor().props.sheetOpen).toBe(false);
    await harness.run(() => (changeCategory.props.onClick as () => void)());
    expect(editor().props.sheetOpen).toBe(true);
  } finally {
    mocks.novel.inLibrary = false;
    await harness.unmount();
  }
});

it("shows no category toast when the library toggle removes the novel", async () => {
  const harness = mountBackNavigationHarness();
  let tree: ReturnType<typeof NovelDetailPage> | undefined;
  function PageProbe() {
    tree = NovelDetailPage({ id: 3 });
    return null;
  }
  try {
    await harness.render(<PageProbe />);
    const workspace = collectElements(tree).find((element) => typeof element.props.onToggleLibrary === "function")!;
    await harness.run(() => (workspace.props.onToggleLibrary as () => void)());
    const options = mocks.toggleMutate.mock.calls[0]![1] as { onSuccess: (result: unknown) => void };
    await harness.run(() => options.onSuccess(undefined));
    expect(mocks.toast).not.toHaveBeenCalled();
  } finally {
    await harness.unmount();
  }
});
