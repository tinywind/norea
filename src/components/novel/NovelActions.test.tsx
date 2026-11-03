import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { load } from "cheerio";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { ChapterListRow } from "../../db/queries/chapter";
import type { NovelDetailRecord } from "../../db/queries/novel";
import type { TaskRecord } from "../../lib/tasks/task-types";

const mocks = vi.hoisted(() => ({ records: [] as unknown[], pause: null as string | null, plugin: true }));
vi.mock("../../i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => values ? `${key}(${JSON.stringify(values)})` : key,
  }),
}));
vi.mock("../ui/ResponsiveSheet", () => ({
  ResponsiveSheet: ({ children, opened }: { children: ReactNode; opened: boolean }) => opened ? <section>{children}</section> : null,
}));
vi.mock("../../lib/download-goals/goal-service", () => ({
  getDownloadGoalPauseSnapshot: () => ({ pause: mocks.pause }),
  subscribeDownloadGoalPause: () => () => undefined,
  setDownloadGoal: vi.fn(),
}));
vi.mock("../../lib/tasks/hooks", () => ({ useTaskSnapshot: () => ({ records: mocks.records }) }));
vi.mock("../../lib/plugins/manager", () => ({ pluginManager: { getPlugin: () => mocks.plugin ? { id: "source" } : undefined } }));

import { recordChapterDownloadDuration, resetDownloadEtaForTests } from "../../lib/download-goals/download-eta";
import { NovelDownloadGoalSheet, novelDownloadGoalQueryKey } from "./NovelActions";

const chapter = (id: number, extra: Partial<ChapterListRow> = {}) => ({
  id, novelId: 3, name: `Chapter ${id}`, path: `/${id}`, chapterNumber: String(id), position: id, page: "1",
  bookmark: false, unread: true, progress: 0, isDownloaded: false, sourceContentType: "html", contentType: "html",
  contentBytes: 0, mediaBytes: 0, mediaRepairNeeded: false, releaseTime: null, readAt: null, createdAt: null, foundAt: 1, updatedAt: 1,
  ...extra,
}) as ChapterListRow;
const novel = {
  id: 3, pluginId: "source", sourceNovelId: "n", path: "/novel", name: "Novel", cover: null, summary: null, author: null,
  artist: null, status: null, genres: null, rating: null, inLibrary: true, isLocal: false, createdAt: 1, updatedAt: 1,
  libraryAddedAt: 1, lastReadAt: Math.floor(Date.now() / 1000),
} as NovelDetailRecord;
const task = (extra: Partial<TaskRecord>): TaskRecord => ({
  id: "t", lane: "source", kind: "chapter.download", priority: "background", title: "t", source: { id: "source", name: "Source" },
  subject: { novelId: 3 }, status: "queued", createdAt: 0, canCancel: true, canRetry: false, ...extra,
});

function render(chapters: ChapterListRow[], goal: unknown, statuses = new Map()) {
  const client = new QueryClient();
  client.setQueryData(novelDownloadGoalQueryKey(3), goal ? { novelId: 3, goal, updatedAt: 1 } : null);
  return load(renderToStaticMarkup(
    <QueryClientProvider client={client}><MantineProvider>
      <NovelDownloadGoalSheet chapters={chapters} downloadStatuses={statuses} lastReadChapterId={1} novel={novel}
        onClose={vi.fn()} onSelectChapters={vi.fn()} opened />
    </MantineProvider></QueryClientProvider>,
  ));
}

beforeEach(() => {
  mocks.records = []; mocks.pause = null; mocks.plugin = true;
  resetDownloadEtaForTests();
});

it("shows progress, an estimate and the route while the goal downloads", () => {
  recordChapterDownloadDuration({ task: task({ status: "succeeded", startedAt: 0, finishedAt: 299_000 }), previousStatus: "running" });
  mocks.records = [task({ status: "running", chapterDownloadPhase: "server-download" }), task({ id: "q", queueIndex: 4 })];
  const chapters = [chapter(1, { isDownloaded: true, contentBytes: 1 }), chapter(2, { isDownloaded: true, contentBytes: 1 }), chapter(3), chapter(4)];
  const $ = render(chapters, { kind: "entire" }, new Map([[3, { kind: "running" }], [4, { kind: "queued" }]]));

  expect($("[role='status']").text()).toBe(
    'downloadGoals.status.downloading({"done":2,"total":4}) · downloadGoals.eta.minutes({"count":25}) · downloadGoals.route.server');
  expect($("button[aria-pressed='true']").text()).toContain("downloadGoals.kind.entire");
});

it("says the novel is set and lists missing images once the goal is met", () => {
  const chapters = [chapter(1), chapter(2, { contentBytes: 4, mediaRepairNeeded: true }), chapter(3, { isDownloaded: true, contentBytes: 2 })];
  const $ = render(chapters, { kind: "keep_ahead", count: 5 });
  expect($("[role='status']").text()).toBe(
    'downloadGoals.status.satisfied({"count":2}) · downloadGoals.status.missingImages({"count":1})');
  expect($("button[aria-pressed='true']").text()).toContain('downloadGoals.kind.keepAhead.description({"count":5})');
});

it("explains the default for an active library novel without its own goal and reports paused work", () => {
  mocks.pause = "metered";
  const $ = render([chapter(1), chapter(2)], null);
  expect($("[role='status']").text()).toBe("downloadGoals.status.paused");
  expect($("button[aria-pressed='true']").text()).toContain('downloadGoals.kind.none.default({"count":3})');
  expect($.text()).toContain('downloadGoals.status.defaultApplies({"count":3})');
});

it("reports an uninstalled source for a goal", () => {
  mocks.plugin = false;
  expect(render([chapter(1)], { kind: "entire" })("[role='status']").text()).toBe("downloadGoals.status.sourceUnavailable");
});
