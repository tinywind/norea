import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { ContentDeletionRequest } from "../lib/content-deletion";

const mocks = vi.hoisted(() => ({ request: null as ContentDeletionRequest | null }));
vi.mock("@mantine/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@mantine/core")>(),
  Modal: ({ children, title }: { children: ReactNode; title: ReactNode }) => <section><h2>{title}</h2>{children}</section>,
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ state: { location: { pathname: "/novel", search: { id: 3 } } } }),
}));
vi.mock("../i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => values?.count === undefined ? key : `${key}:${values.count}`,
  }),
}));
vi.mock("../lib/android-back-navigation", () => ({ usePageBackNavigation: vi.fn() }));
vi.mock("../lib/content-deletion", () => ({ prepareContentDeletion: vi.fn(), runContentDeletion: vi.fn() }));
vi.mock("../lib/content-sync/management-query-cache", () => ({ removeDeletedServerWorkFromQueries: vi.fn() }));
vi.mock("../lib/updates/update-index-events", () => ({ markUpdatesIndexDirty: vi.fn() }));
vi.mock("../db/queries/novel", () => ({ getNovelById: vi.fn() }));
vi.mock("./use-stop-download-goals-offer", () => ({ useStopDownloadGoalsOffer: () => vi.fn() }));
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
  expect($("h2").text()).toBe("contentDeletion.unshelveTitle");
  expect($.text()).toContain("contentDeletion.unregister");
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

it("offers server deletion only for a work the server holds", () => {
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
  expect($("h2").text()).toBe("contentDeletion.title");
  expect(optionLabels($)).toEqual(["contentDeletion.serverChapters"]);
  expect($("button").last().text()).toBe("contentDeletion.confirm");
});
