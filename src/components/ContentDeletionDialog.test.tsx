import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { collectElements, mountBackNavigationHarness } from "../lib/android-back-navigation.test-support";
import { prepareContentDeletion, runContentDeletion, type ContentDeletionRequest } from "../lib/content-deletion";

const mocks = vi.hoisted(() => ({
  request: null as ContentDeletionRequest | null,
  captureFooter: undefined as ((footer: ReactNode) => void) | undefined,
  cancelQueries: vi.fn(async (): Promise<void> => undefined),
  invalidateQueries: vi.fn(async () => undefined),
}));
vi.mock("@mantine/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@mantine/core")>(),
  Drawer: ({ children, title }: { children: ReactNode; title: ReactNode }) => <section><h2>{title}</h2>{children}</section>,
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({
  cancelQueries: mocks.cancelQueries, invalidateQueries: mocks.invalidateQueries,
}) }));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ state: { location: { pathname: "/novel", search: { id: 3 } } } }),
}));
vi.mock("../i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => values?.count === undefined ? key : `${key}:${values.count}`,
  }),
}));
vi.mock("../lib/android-back-navigation", async original => ({
  ...await original<typeof import("../lib/android-back-navigation")>(), useOverlayBackNavigation: vi.fn(),
}));
vi.mock("../lib/content-deletion", () => ({ prepareContentDeletion: vi.fn(), runContentDeletion: vi.fn() }));
vi.mock("../lib/content-sync/management-query-cache", () => ({ removeDeletedServerWorkFromQueries: vi.fn() }));
vi.mock("../lib/updates/update-index-events", () => ({ markUpdatesIndexDirty: vi.fn() }));
vi.mock("../db/queries/novel", () => ({ getNovelById: vi.fn() }));
vi.mock("./use-stop-download-goals-offer", () => ({ useStopDownloadGoalsOffer: () => vi.fn() }));
vi.mock("./ui/ResponsiveSheet", async original => {
  const actual = await original<typeof import("./ui/ResponsiveSheet")>();
  return { ...actual, ResponsiveSheet: (props: Parameters<typeof actual.ResponsiveSheet>[0]) => {
    if (!mocks.captureFooter) return <actual.ResponsiveSheet {...props} />;
    mocks.captureFooter(props.footer);
    return null;
  } };
});
vi.mock("../store/content-deletion", () => ({
  finishContentDeletion: vi.fn(),
  useContentDeletionStore: (select: (state: unknown) => unknown) =>
    select({ pending: mocks.request ? { id: 1, request: mocks.request, resolve: vi.fn() } : null }),
}));

import { ContentDeletionDialog } from "./ContentDeletionDialog";

function render(request: ContentDeletionRequest) {
  mocks.request = request;
  return load(renderToStaticMarkup(<MantineProvider><ContentDeletionDialog /></MantineProvider>));
}

const unshelve = { kind: "library", ids: [3], title: "Novel", serverUrl: "http://server.test" } as const;
const optionLabels = ($: ReturnType<typeof render>) =>
  $("input[type='checkbox']").map((_, input) => $(`label[for='${$(input).attr("id")}']`).text()).get();

it("asks to remove a novel from the library with optional download and server deletion", () => {
  const $ = render({ ...unshelve, downloadedCount: 4, serverWork: true });
  expect($("h2 .norea-responsive-sheet-title-text").text()).toBe("contentDeletion.unshelveTitle");
  expect($.text()).toContain("contentDeletion.summary.library:1");
  expect(optionLabels($)).toEqual([
    "contentDeletion.alsoDeleteDownloads:4",
    "contentDeletion.alsoDeleteFromServer",
  ]);
  expect($("input[type='checkbox']:checked")).toHaveLength(0);
  expect($("button").last().text()).toBe("common.remove");
});

it("hides the server address and states the default action as text", () => {
  const $ = render({ ...unshelve, downloadedCount: 4, serverWork: true });
  expect($.html()).not.toContain("http://server.test");
  expect($("input[disabled]")).toHaveLength(0);
});

it("keeps server deletion available until absence is confirmed", () => {
  expect(optionLabels(render({ ...unshelve, downloadedCount: 4 })))
    .toEqual(["contentDeletion.alsoDeleteDownloads:4", "contentDeletion.alsoDeleteFromServer"]);
  expect(optionLabels(render({ ...unshelve, downloadedCount: 4, serverWork: false })))
    .toEqual(["contentDeletion.alsoDeleteDownloads:4"]);
  expect(optionLabels(render({ ...unshelve, serverUrl: "", downloadedCount: 4 })))
    .toEqual(["contentDeletion.alsoDeleteDownloads:4"]);
});

it("drops the download option when nothing is downloaded", () => {
  expect(optionLabels(render({ ...unshelve, downloadedCount: 0, serverWork: false }))).toEqual([]);
});

it("keeps the device and server choices for deleting downloads", () => {
  const $ = render({ kind: "downloads", scope: "chapter", ids: [7, 8], title: "Downloads", serverUrl: "http://server.test" });
  expect($("h2 .norea-responsive-sheet-title-text").text()).toBe("contentDeletion.title");
  expect(optionLabels($)).toEqual(["contentDeletion.serverChapters"]);
  expect($("button").last().text()).toBe("contentDeletion.confirm");
});

it("cancels active server reads before initiating deletion", async () => {
  const harness = mountBackNavigationHarness();
  let footer: ReactNode;
  let release!: () => void;
  const cancellation = new Promise<void>(resolve => { release = resolve; });
  mocks.request = { kind: "server-work", title: "Novel", source: { serverUrl: "http://server.test", workId: "work" } };
  mocks.captureFooter = value => { footer = value; };
  mocks.cancelQueries.mockClear().mockImplementationOnce(() => cancellation);
  vi.mocked(prepareContentDeletion).mockResolvedValue([{ id: "server-work", side: "server", name: "Novel", run: async () => undefined }]);
  vi.mocked(runContentDeletion).mockResolvedValue([{ id: "server-work", status: "failed", error: "Server unavailable" }]);
  try {
    await harness.render(<ContentDeletionDialog />);
    const confirm = collectElements(footer).find(element => element.props.children === "contentDeletion.confirm");
    await harness.run(() => (confirm?.props.onClick as () => void)());
    expect(mocks.cancelQueries.mock.calls.slice(0, 3)).toEqual([
      [{ queryKey: ["content-server", "chapter-differences"] }],
      [{ queryKey: ["content-server", "manage-work"] }],
      [{ queryKey: ["content-server", "novel-chapters"] }],
    ]);
    expect(runContentDeletion).not.toHaveBeenCalled();
    await harness.run(release);
    expect(runContentDeletion).toHaveBeenCalledOnce();
  } finally {
    release();
    mocks.captureFooter = undefined;
    await harness.unmount();
  }
});

it("states the deletion in one sentence ahead of the optional checkboxes", () => {
  const $ = render({ kind: "downloads", scope: "chapter", ids: [7, 8], title: "Downloads", serverUrl: "http://server.test" });
  expect($("p").map((_, element) => $(element).text()).get()).toEqual(["contentDeletion.summary.chapterDownloads:2"]);
  expect($.text()).not.toContain("contentDeletion.hint");
  expect(render({ kind: "downloads", scope: "all", title: "Downloads", serverUrl: "" })("p").text())
    .toBe("contentDeletion.summary.allDownloads");
});
