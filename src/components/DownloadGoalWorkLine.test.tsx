import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { TaskRecord } from "../lib/tasks/task-types";

vi.mock("../i18n", () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values ? `${key}(${JSON.stringify(values)})` : key }),
}));
vi.mock("../db/queries/novel-download-goal", () => ({ listNovelDownloadGoals: vi.fn() }));

import { recordChapterDownloadDuration, resetDownloadEtaForTests } from "../lib/download-goals/download-eta";
import { DOWNLOAD_GOALS_QUERY_KEY, DownloadGoalWorkLine } from "./DownloadGoalWorkLine";

const task = (extra: Partial<TaskRecord>): TaskRecord => ({
  id: "t", lane: "source", kind: "chapter.download", priority: "background", title: "t", source: { id: "source", name: "Source" },
  subject: { novelId: 4 }, status: "queued", createdAt: 0, canCancel: true, canRetry: false, ...extra,
});

function render(tasks: TaskRecord[], goals: unknown[]) {
  const client = new QueryClient();
  client.setQueryData(DOWNLOAD_GOALS_QUERY_KEY, goals);
  return load(renderToStaticMarkup(<QueryClientProvider client={client}><MantineProvider>
    <DownloadGoalWorkLine records={tasks} tasks={tasks} />
  </MantineProvider></QueryClientProvider>))("[data-download-goal-work]").text();
}

beforeEach(() => {
  resetDownloadEtaForTests();
});

it("names the goal and its estimate on a work's queued goal downloads", () => {
  // Server rendering reads the stores' initial state: default keep-ahead 3 and a 1 second cooldown.
  recordChapterDownloadDuration({ task: task({ status: "succeeded", startedAt: 0, finishedAt: 59_000 }), previousStatus: "running" });
  const tasks = [task({ automatic: true, queueIndex: 9 })];
  expect(render(tasks, [{ novelId: 4, goal: { kind: "keep_ahead", count: 10 }, updatedAt: 1 }]))
    .toBe('downloadGoals.goal.keepAhead({"count":10}) · downloadGoals.eta.minutes({"count":10})');
  expect(render(tasks, [])).toBe('downloadGoals.goal.defaultKeepAhead({"count":3}) · downloadGoals.eta.minutes({"count":10})');
});

it("shows only the estimate for work that no goal queued, and nothing before a chapter is measured", () => {
  expect(render([task({})], [])).toBe("");
  recordChapterDownloadDuration({ task: task({ status: "succeeded", startedAt: 0, finishedAt: 59_000 }), previousStatus: "running" });
  expect(render([task({ queueIndex: 4 })], [{ novelId: 4, goal: { kind: "entire" }, updatedAt: 1 }]))
    .toBe('downloadGoals.eta.minutes({"count":5})');
});
