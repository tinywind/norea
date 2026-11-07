import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { load } from "cheerio";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { ChapterListRow } from "../../db/queries/chapter";
import type { NovelDetailRecord } from "../../db/queries/novel";

const mocks = vi.hoisted(() => ({ plugin: true, serverUrl: "" }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({
  t: (key: string, values?: Record<string, unknown>) => values ? `${key}(${JSON.stringify(values)})` : key,
}) }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../ui/ResponsiveSheet", () => ({
  ResponsiveSheet: ({ children, opened }: { children: ReactNode; opened: boolean }) => opened ? <section>{children}</section> : null,
}));
vi.mock("../../lib/plugins/manager", () => ({ pluginManager: { getPlugin: () => mocks.plugin ? { id: "source" } : undefined } }));

vi.mock("../../store/content-sync", () => ({ useContentSyncStore: (select: (state: { serverUrl: string }) => unknown) => select({ serverUrl: mocks.serverUrl }) }));

import { NovelDownloadSheet } from "./NovelActions";
const chapter = (id: number, extra: Partial<ChapterListRow> = {}) => ({
  id, novelId: 3, name: `Chapter ${id}`, path: `/${id}`, chapterNumber: String(id), position: id, page: "1",
  bookmark: false, unread: true, progress: 0, isDownloaded: false, sourceContentType: "html", contentType: "html",
  contentBytes: 0, mediaBytes: 0, mediaRepairNeeded: false, releaseTime: null, readAt: null, createdAt: null, foundAt: 1, updatedAt: 1,
  ...extra,
}) as ChapterListRow;
const novel = { id: 3, pluginId: "source", name: "Novel", path: "/novel", isLocal: false } as NovelDetailRecord;
function render(chapters: ChapterListRow[], statuses = new Map(), hasServerSource = false) {
  return load(renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}><MantineProvider>
      <NovelDownloadSheet chapters={chapters} downloadStatuses={statuses} novel={novel} hasServerSource={hasServerSource}
        onClose={vi.fn()} onSelectChapters={vi.fn()} opened />
    </MantineProvider></QueryClientProvider>,
  ));
}
beforeEach(() => { mocks.plugin = true; mocks.serverUrl = ""; });

it("shows stored and queued counts without presenting a persistent automatic policy", () => {
  const $ = render([chapter(1, { isDownloaded: true, contentBytes: 1 }), chapter(2), chapter(3)], new Map([[3, { kind: "queued" }]]));
  expect($("[role='status']").text()).toBe('downloadOnce.status({"stored":1,"total":3,"queued":1})');
  expect($("[role='radio'], [role='radiogroup'][aria-label='downloadGoals.section.goal']")).toHaveLength(0);
  expect($.text()).toContain("downloadOnce.remaining");
  expect($.text()).toContain("downloadOnce.all");
  expect($.text()).toContain("downloadGoals.once.selected");
  expect($.text()).toContain("downloadOnce.settings");
  expect($.text()).not.toContain("downloadGoals.kind");
});

it("counts a partial stored body without silently requesting its images again", () => {
  const $ = render([chapter(1, { contentBytes: 4, mediaRepairNeeded: true }), chapter(2)]);
  expect($("[role='status']").text()).toBe('downloadOnce.status({"stored":1,"total":2,"queued":0}) · downloadGoals.status.missingImages({"count":1})');
});

it("keeps global settings accessible when the source cannot download now", () => {
  mocks.plugin = false;
  const $ = render([chapter(1)]);
  expect($.text()).toContain("downloadGoals.status.sourceUnavailable");
  const action = $("button").filter((_, button) => $(button).text().includes("downloadOnce.all"));
  const settings = $("button").filter((_, button) => $(button).text().includes("downloadOnce.settings"));
  expect(action).toHaveLength(1);
  expect(action.prop("disabled")).toBe(true);
  expect(settings).toHaveLength(1);
  expect(settings.prop("disabled")).not.toBe(true);
});

it.each(["configured", "remembered"])("keeps immediate downloads available through the %s content server without a plugin", server => {
  mocks.plugin = false;
  mocks.serverUrl = server === "configured" ? "https://content.example.test" : "";
  const $ = render([chapter(1)], new Map(), server === "remembered");
  const action = $("button").filter((_, button) => $(button).text().includes("downloadOnce.all"));
  expect(action.prop("disabled")).not.toBe(true);
  expect($.text()).not.toContain("downloadGoals.status.sourceUnavailable");
});
