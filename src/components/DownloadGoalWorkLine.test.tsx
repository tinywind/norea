import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { TaskRecord } from "../lib/tasks/task-types";
import type { NovelDownloadGoal } from "../db/queries/novel-download-goal";

const mocks = vi.hoisted(() => ({ automaticGoal: { kind: "keep_ahead", count: 3 } as NovelDownloadGoal }));
vi.mock("../store/download-goals", () => ({
  useDownloadGoalSettingsStore: (selector: (state: { automaticGoal: NovelDownloadGoal }) => unknown) => selector(mocks),
}));

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
  mocks.automaticGoal = { kind: "keep_ahead", count: 3 };
});

it("names the global policy and estimate without presenting a retained per-work override", () => {
  // The shared policy keeps 3 ahead and the source uses a 1 second cooldown.
  recordChapterDownloadDuration({ task: task({ status: "succeeded", startedAt: 0, finishedAt: 59_000 }), previousStatus: "running" });
  const tasks = [task({ automatic: true, queueIndex: 9 })];
  expect(render(tasks, [{ novelId: 4, goal: { kind: "keep_ahead", count: 10 }, updatedAt: 1 }]))
    .toBe('downloadGoals.goal.keepAhead({"count":3}) · downloadGoals.eta.minutes({"count":10})');
  expect(render(tasks, [])).toBe('downloadGoals.goal.keepAhead({"count":3}) · downloadGoals.eta.minutes({"count":10})');
});

it("shows only the estimate for work that no goal queued, and nothing before a chapter is measured", () => {
  expect(render([task({})], [])).toBe("");
  recordChapterDownloadDuration({ task: task({ status: "succeeded", startedAt: 0, finishedAt: 59_000 }), previousStatus: "running" });
  expect(render([task({ queueIndex: 4 })], [{ novelId: 4, goal: { kind: "entire" }, updatedAt: 1 }]))
    .toBe('downloadGoals.eta.minutes({"count":5})');
});

it.each([
  { goal: { kind: "all_remaining" } as const, label: "downloadGoals.goal.allRemaining" },
  { goal: { kind: "entire" } as const, label: "downloadGoals.goal.entire" },
])("shows the current global $goal.kind range without a per-work choice", ({ goal, label }) => {
  mocks.automaticGoal = goal;
  expect(render([task({ automatic: true })], [{ novelId: 4, goal: { kind: "keep_ahead", count: 30 }, updatedAt: 1 }])).toBe(label);
});

it("does not label queued work with an active policy while the work or the global policy is paused", () => {
  expect(render([task({ automatic: true })], [{ novelId: 4, goal: { kind: "none" }, updatedAt: 1 }])).toBe("");
  mocks.automaticGoal = { kind: "none" };
  expect(render([task({ automatic: true })], [{ novelId: 4, goal: { kind: "entire" }, updatedAt: 1 }])).toBe("");
});
