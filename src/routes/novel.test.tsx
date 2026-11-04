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
  fullRefresh: vi.fn(),
  clearDownloadMutate: vi.fn(),
  confirm: vi.fn(),
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
    : key,
}) }));
vi.mock("../store/library", () => ({ useLibraryStore: (selector: (state: unknown) => unknown) => selector({ defaultChapterSort: "asc", setDefaultChapterSort: vi.fn() }) }));
vi.mock("../store/reader", () => ({ useReaderStore: (selector: (state: unknown) => unknown) => selector({ lastReadChapterByNovel: {} }) }));
vi.mock("../components/novel/use-novel-metadata", () => ({ useNovelMetadata: () => ({ sourceDuplicateChapters: [], toggle: { mutate: mocks.toggleMutate }, refreshMetadata: { error: mocks.metadataError }, fullRefreshMetadata: { mutate: mocks.fullRefresh } }) }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.toast, hide: vi.fn() } }));
vi.mock("@mantine/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@mantine/core")>(),
  Drawer: () => null,
  Modal: () => null,
}));
vi.mock("../components/novel/use-server-novel-sync", () => ({ useServerNovelSync: () => mocks.sync }));
vi.mock("../components/novel/use-novel-chapter-actions", () => ({ useNovelChapterActions: () => ({ clearDownload: { mutate: mocks.clearDownloadMutate }, clearSelectedDownloads: {}, setSelectedChapterReadState: {}, setRelativeChapterReadState: {}, repairMedia: {} }) }));
vi.mock("../components/ui/ConfirmDialog", () => ({ useConfirm: () => mocks.confirm }));
vi.mock("../components/novel/use-novel-download-statuses", () => ({ useNovelDownloadStatuses: () => new Map() }));
vi.mock("../components/novel/use-local-novel-editor", () => ({ useLocalNovelEditor: () => ({ addLocalChapters: {}, reorderLocalChapters: {} }) }));
vi.mock("../components/ReaderSettingsPanel", () => ({ ReaderSettingsPanel: () => null }));
vi.mock("../components/library/use-download-goal-offline-states", () => ({ useDownloadGoalOfflineStates: () => undefined }));
vi.mock("../components/novel/NovelCheckPausedNotice", () => ({ NovelCheckPausedNotice: () => null }));
vi.mock("../lib/plugins/manager", () => ({ pluginManager: { getPlugin: () => mocks.installed ? { id: "source-a", name: "Source", getBaseUrl: () => "https://source.example" } : undefined } }));
vi.mock("../lib/tasks/source-tasks", () => ({ enqueueOpenSiteTask: vi.fn() }));
vi.mock("../lib/content-sync/novel-source", () => ({ readServerNovelSource: vi.fn(), listServerChapterAvailability: vi.fn() }));

import { NovelDetailPage } from "./novel";
import { PageActivityContext } from "../lib/page-activity";
import { buildMissingChapterDownloadTargets, buildPreviousChapterDownloadTargets } from "../components/novel/novel-detail-model";
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
  const targets = buildMissingChapterDownloadTargets([
    { ...chapter, isDownloaded: true }, partial, missing,
  ], new Map());
  expect(targets.map((row) => row.id)).toEqual([3]);
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
  mocks.fullRefresh.mockReset();
  mocks.clearDownloadMutate.mockReset();
  mocks.confirm.mockReset();
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
  expect($("button[aria-label='novel.openChapter']").text()).toContain("Saved chapter");
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
  expect($("button[aria-label='novel.openChapter']").text()).toContain("Saved chapter");
  expect($.text()).not.toContain("Server unavailable");
  expect($.text()).not.toContain("novel.syncFailed");
  expect($.text()).not.toContain("contentSync.workRefreshFailed");
});

it("keeps saved chapters visible beside a retryable source refresh notice", () => {
  mocks.sync.sourceError = new Error("Source refresh failed");
  mocks.chapters = [{ ...chapter }];
  const $ = renderPage();
  expect($("button[aria-label='novel.openChapter']").text()).toContain("Saved chapter");
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
  const text = renderPage()("button[aria-label='novel.openChapter']").text();
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
  expect($("button[aria-label='novel.openChapter']").text()).toContain("Saved chapter");
  expect($("button[aria-label='novel.openChapter']").text()).toContain("novel.serverIncomplete");
  expect($("button[aria-label='novel.downloadChapter']")).toHaveLength(1);
  expect($("button").filter((_, button) => $(button).text() === "novel.repair")).toHaveLength(0);
  expect(mocks.chapters[0]).toMatchObject({ isDownloaded: false, mediaRepairNeeded: false });
});

it("preserves a complete local chapter when its server copy is incomplete", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  mocks.available.data = { paths: new Map([[chapter.path, false]]), numbers: new Map() };
  mocks.chapters = [{ ...chapter, isDownloaded: true, contentBytes: 100 }];

  const $ = renderPage();
  expect($("button[aria-label='novel.openChapter']").text()).toContain("novel.serverIncomplete");
  expect($("button[aria-label='novel.downloaded']")).toHaveLength(1);
  expect($.text()).not.toContain("novel.mediaRepairNeeded");
  expect($("button[aria-label='novel.downloadChapter']")).toHaveLength(0);
  expect($("button").filter((_, button) => $(button).text() === "novel.repair")).toHaveLength(0);
  expect(mocks.chapters[0]).toMatchObject({ isDownloaded: true, mediaRepairNeeded: false });
});

it("shows and counts a stored partial body even when its server package is unavailable", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  mocks.chapters = [{ ...chapter, contentBytes: 100, mediaRepairNeeded: true }];
  const $ = renderPage();
  expect($("button[aria-label='novel.openChapter']").text()).toContain("Saved chapter");
  expect($.text()).toContain("1/1 stored");
  expect(mocks.chapters[0]).toMatchObject({ isDownloaded: false, mediaRepairNeeded: true });
});

it("shows saved chapters immediately while server availability is still pending", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  mocks.available.data = undefined;
  mocks.available.isLoading = true;
  mocks.chapters = [{ ...chapter }];
  expect(renderPage()("button[aria-label='novel.openChapter']").text()).toContain("Saved chapter");
});

it("shows a server folder chapter matching the cached source chapter number without a plugin", () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  mocks.available.data = { paths: new Map([["norea-folder:1", false]]), numbers: new Map([[1, false]]) };
  mocks.chapters = [{ ...chapter, name: "Server chapter", path: "/chapter/1", chapterNumber: "1.0" }];
  expect(renderPage()("button[aria-label='novel.openChapter']").text()).toContain("Server chapter");
});

it("shows source-only chapters and source controls for a bound work with its original path and installed plugin", async () => {
  mocks.source.data = { serverUrl: "http://server", workId: "work" };
  mocks.novel.isLocal = false;
  mocks.installed = true;
  mocks.chapters = [{ ...chapter, name: "New source chapter" }];
  const $ = renderPage();
  expect($("button[aria-label='novel.openChapter']").text()).toContain("New source chapter");
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
  // Only the reader settings sheet mounts: it owns its back handler.
  function PageProbe() {
    tree = NovelDetailPage({ id: 3 });
    return collectElements(tree).find((element) => element.props.title === "readerSettings.novel.title") ?? null;
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

async function withPageTree(check: (find: (predicate: (props: Record<string, unknown>) => boolean) => ReturnType<typeof collectElements>[number] | undefined, run: (callback: () => void) => Promise<void>) => Promise<void>) {
  const harness = mountBackNavigationHarness();
  // Selection mode records a history entry so back leaves it first.
  Object.assign(window, { history: { state: null, pushState: vi.fn(), back: vi.fn() } });
  let tree: ReturnType<typeof NovelDetailPage> | undefined;
  function PageProbe() {
    tree = NovelDetailPage({ id: 3 });
    return null;
  }
  try {
    await harness.render(<PageProbe />);
    await check(
      (predicate) => collectElements(tree).find((element) => predicate(element.props)),
      (callback) => harness.run(callback),
    );
  } finally {
    await harness.unmount();
  }
}

it("replaces the app bar with a labeled selection bar from the visible Select entry", async () => {
  mocks.novel.isLocal = false;
  mocks.chapters = [{ ...chapter, unread: true }, { ...chapter, id: 2, position: 2, isDownloaded: true, unread: false }];
  await withPageTree(async (find, run) => {
    expect(find((props) => typeof props.onSelectAll === "function")).toBeUndefined();
    const select = find((props) => props.children === "novel.select")!;
    await run(() => (select.props.onClick as () => void)());
    const bar = find((props) => typeof props.onSelectAll === "function")!;
    const labels = collectElements(bar.props.actions as ReturnType<typeof NovelDetailPage>)
      .map((element) => element.props.label)
      .filter((label) => typeof label === "string");
    expect(labels).toEqual(expect.arrayContaining([
      "novel.selection.downloadSelected",
      "novel.selection.markRead",
      "novel.selection.markUnread",
      "novel.selection.deleteDownloads",
      "common.more",
    ]));
    expect(find((props) => props.className === "norea-novel-app-bar")).toBeUndefined();
  });
});

it("offers anchor-relative read actions only for a single selected chapter", async () => {
  mocks.novel.isLocal = false;
  mocks.chapters = [chapter, { ...chapter, id: 2, position: 2 }, { ...chapter, id: 3, position: 3 }];
  await withPageTree(async (find, run) => {
    const list = () => find((props) => typeof props.onToggleSelected === "function")!;
    await run(() => (list().props.onToggleSelected as (id: number) => void)(2));
    const moreLabels = () => {
      const bar = find((props) => typeof props.onSelectAll === "function")!;
      const menu = collectElements(bar.props.actions as ReturnType<typeof NovelDetailPage>)
        .find((element) => Array.isArray(element.props.items))!;
      return (menu.props.items as MenuItem[]).map((item) => item.label);
    };
    expect(moreLabels()).toEqual([
      "novel.selection.selectRange",
      "novel.selection.downloadPrevious",
      "novel.selection.markPreviousRead",
      "novel.selection.markFollowingUnread",
    ]);
    await run(() => (list().props.onToggleSelected as (id: number) => void)(3));
    expect(moreLabels()).toEqual(["novel.selection.selectRange", "novel.selection.downloadPrevious"]);
  });
});

const numberedChapters = () =>
  Array.from({ length: 6 }, (_, index) => ({
    ...chapter, id: index + 1, position: index + 1, chapterNumber: String(index + 1), name: `Chapter ${index + 1}`,
  }));

type FindElement = (predicate: (props: Record<string, unknown>) => boolean) => ReturnType<typeof collectElements>[number] | undefined;

const chapterList = (find: FindElement) => find((props) => typeof props.onExtendSelection === "function")!;
const selectedIds = (find: FindElement) =>
  [...(chapterList(find).props.selectedChapterIds as ReadonlySet<number>)].sort((left, right) => left - right);

it("starts a selection at the first long-pressed row and selects every row up to the next one", async () => {
  mocks.novel.isLocal = false;
  mocks.chapters = numberedChapters();
  await withPageTree(async (find, run) => {
    const extend = (id: number) => (chapterList(find).props.onExtendSelection as (id: number) => void)(id);
    await run(() => extend(2));
    expect(chapterList(find).props.selectionMode).toBe(true);
    expect(selectedIds(find)).toEqual([2]);
    await run(() => extend(4));
    expect(selectedIds(find)).toEqual([2, 3, 4]);
    await run(() => extend(1));
    expect(selectedIds(find)).toEqual([1, 2, 3, 4]);
  });
});

it("toggles the anchor itself and picks the next selected row as the new anchor", async () => {
  mocks.novel.isLocal = false;
  mocks.chapters = numberedChapters();
  await withPageTree(async (find, run) => {
    const list = () => chapterList(find).props;
    await run(() => (list().onToggleSelected as (id: number) => void)(2));
    await run(() => (list().onExtendSelection as (id: number) => void)(2));
    expect(selectedIds(find)).toEqual([]);
    await run(() => (list().onToggleSelected as (id: number) => void)(5));
    await run(() => (list().onExtendSelection as (id: number) => void)(6));
    expect(selectedIds(find)).toEqual([5, 6]);
  });
});

it("adds chapters chosen by number to the selection, prefilled from the anchor", async () => {
  mocks.novel.isLocal = false;
  mocks.chapters = numberedChapters();
  await withPageTree(async (find, run) => {
    await run(() => (chapterList(find).props.onToggleSelected as (id: number) => void)(2));
    const bar = find((props) => typeof props.onSelectAll === "function")!;
    const menu = collectElements(bar.props.actions as ReturnType<typeof NovelDetailPage>)
      .find((element) => Array.isArray(element.props.items))!;
    const selectRange = (menu.props.items as MenuItem[]).find((item) => item.label === "novel.selection.selectRange")!;
    await run(() => selectRange.onClick());
    const sheet = () => find((props) => typeof props.onSelect === "function" && "initialFrom" in props)!;
    expect(sheet().props.opened).toBe(true);
    expect(sheet().props.initialFrom).toBe(2);
    await run(() => (sheet().props.onSelect as (ids: number[]) => void)([4, 5]));
    expect(sheet().props.opened).toBe(false);
    expect(selectedIds(find)).toEqual([2, 4, 5]);
  });
});

it("jumps to a chapter by number or title and reports a miss inline", async () => {
  mocks.novel.isLocal = false;
  mocks.chapters = numberedChapters();
  await withPageTree(async (find, run) => {
    const open = find((props) => props.label === "novel.jump.open")!;
    await run(() => (open.props.onClick as () => void)());
    const input = () => find((props) => props.placeholder === "novel.jump.placeholder")!;
    const submit = () => (find((props) => props.role === "search")!.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
    const type = (value: string) => (input().props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value } });
    await run(() => type("5"));
    await run(submit);
    expect(chapterList(find).props.jumpRequest).toEqual({ chapterId: 5 });
    await run(() => type("chapter 3"));
    await run(submit);
    expect(chapterList(find).props.jumpRequest).toEqual({ chapterId: 3 });
    await run(() => type("99"));
    await run(submit);
    expect(input().props.error).toBe("novel.jump.noMatch");
    expect(chapterList(find).props.jumpRequest).toEqual({ chapterId: 3 });
  });
});

it("filters the chapter list and keeps select all, range selection and jump on the shown rows", async () => {
  mocks.novel.isLocal = false;
  mocks.chapters = numberedChapters().map((row) => ({ ...row, unread: row.id % 2 === 0 }));
  await withPageTree(async (find, run) => {
    const shownIds = () => (chapterList(find).props.chapters as ChapterListRow[]).map((row) => row.id);
    const title = () => find((props) => props.className === "norea-novel-chapters-title")!.props.children;
    expect(title()).toBe("0/6 stored");
    await run(() => (find((props) => props.label === "novel.filter.open")!.props.onClick as () => void)());
    const chip = (label: string) => find((props) => props.children === label && "aria-pressed" in props)!;
    await run(() => (chip("novel.filter.unread").props.onClick as () => void)());
    expect(chip("novel.filter.unread").props["aria-pressed"]).toBe(true);
    expect(shownIds()).toEqual([2, 4, 6]);
    expect(title()).toBe("novel.chapterSummaryFiltered");
    expect(find((props) => typeof props.onSelect === "function" && "initialFrom" in props)!.props.chapters)
      .toEqual(chapterList(find).props.chapters);

    await run(() => (chapterList(find).props.onExtendSelection as (id: number) => void)(2));
    await run(() => (chapterList(find).props.onExtendSelection as (id: number) => void)(6));
    expect(selectedIds(find)).toEqual([2, 4, 6]);
    const bar = () => find((props) => typeof props.onSelectAll === "function")!;
    expect(bar().props.selectAllDisabled).toBe(true);
    await run(() => (bar().props.onClear as () => void)());
    await run(() => (bar().props.onSelectAll as () => void)());
    expect(selectedIds(find)).toEqual([2, 4, 6]);
    expect(bar().props.label).toBe("novel.selection.selectedCount");

    await run(() => (find((props) => props.label === "novel.jump.open")!.props.onClick as () => void)());
    const type = (value: string) => (find((props) => props.placeholder === "novel.jump.placeholder")!.props.onChange as
      (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value } });
    const submit = () => (find((props) => props.role === "search")!.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
    await run(() => type("3"));
    await run(submit);
    expect(find((props) => props.placeholder === "novel.jump.placeholder")!.props.error).toBe("novel.jump.noMatch");
    await run(() => type("4"));
    await run(submit);
    expect(chapterList(find).props.jumpRequest).toEqual({ chapterId: 4 });

    await run(() => (chip("novel.filter.downloaded").props.onClick as () => void)());
    expect(find((props) => typeof props.onExtendSelection === "function")).toBeUndefined();
    expect(find((props) => props.title === "novel.filter.noMatch")).toBeDefined();
    await run(() => (find((props) => props.className === "norea-novel-chapter-filter" &&
      props.children === "common.clear")!.props.onClick as () => void)());
    expect(shownIds()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(selectedIds(find)).toEqual([]);
  });
});

it("deletes one chapter's download at once, without a confirmation", async () => {
  mocks.novel.isLocal = false;
  mocks.chapters = [{ ...chapter, isDownloaded: true }];
  await withPageTree(async (find, run) => {
    const list = find((props) => typeof props.onDeleteDownload === "function")!;
    await run(() => (list.props.onDeleteDownload as (id: number) => void)(1));
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.clearDownloadMutate).toHaveBeenCalledWith(1);
  });
});

it("shows the page shape with a back button while the novel loads", () => {
  mocks.novelQuery.isLoading = true;
  const $ = renderPage();
  expect($("[role='status']").text()).toBe("novel.loading");
  expect($("button[aria-label='common.back']")).toHaveLength(1);
  expect($(".mantine-Skeleton-root").length).toBeGreaterThan(8);
  expect($("h1")).toHaveLength(0);
});

it.each([
  [false, "common.refresh", () => mocks.fullRefresh],
  [true, "novel.local.addChapters", undefined],
] as const)("offers the next step from an empty chapter list (local: %s)", async (isLocal, label, called) => {
  mocks.novel.isLocal = isLocal;
  mocks.chapters = [];
  await withPageTree(async (find, run) => {
    const empty = find((props) => props.title === "novel.noChapters")!;
    const action = empty.props.action as { label: string; onClick: () => void };
    expect(action.label).toBe(label);
    if (called) {
      await run(() => action.onClick());
      expect(called()).toHaveBeenCalledTimes(1);
    }
  });
});
