import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TaskRecord, TaskSnapshot } from "../lib/tasks/task-types";

const state = vi.hoisted(() => ({ snapshot: undefined as TaskSnapshot | undefined }));
vi.mock("../lib/tasks/hooks", () => ({ useTaskSnapshot: () => state.snapshot }));
vi.mock("../lib/tasks/chapter-download", () => ({ cancelChapterDownloadBatches: vi.fn() }));
vi.mock("../lib/tasks/source-access-coordinator", () => ({
  applySourceAccessBrowserOutcome: vi.fn(), cancelSourceAccessWait: vi.fn(),
  openSourceAccessBrowser: vi.fn(), sourceAccessBlockSourceNames: () => [],
}));

import { TaskScheduler } from "../lib/tasks/scheduler";
import { TasksPage } from "./tasks";

function chapter(id: number, novelId: number, status: TaskRecord["status"], queueIndex?: number): TaskRecord {
  return {
    id: String(id), lane: "source", kind: "chapter.download", priority: "background",
    title: `Chapter ${id}`, source: { id: "source", name: "Source" },
    subject: { novelId, novelName: `Novel ${novelId}` }, status,
    createdAt: id, canCancel: status === "queued" || status === "running", canRetry: false,
    ...(queueIndex === undefined ? {} : { queueIndex, queueSize: 4 }),
  };
}

function workTitles(records: TaskRecord[]): string[] {
  state.snapshot = {
    ...new TaskScheduler().getSnapshot(), records, total: records.length,
    sourceQueueOrder: ["source"], sourceQueuesTotal: 1,
  };
  const $ = load(renderToStaticMarkup(<MantineProvider><TasksPage /></MantineProvider>));
  return $(".norea-task-work-title").map((_, element) => $(element).text()).get();
}

describe("task work group order", () => {
  it("shows mandatory CAPTCHA verification instead of a network retry", () => {
    state.snapshot = { ...new TaskScheduler().getSnapshot(), sourceAccessBlocks: [{
      challenge: { kind: "captcha", url: "https://source.test/chapter/16" },
      detectedAt: 1, revision: 1, scopeKey: "site:source.test", sourceId: "source", sourceIds: ["source"],
      verificationRequested: false,
    }] };
    const $ = load(renderToStaticMarkup(<MantineProvider><TasksPage /></MantineProvider>));
    const banner = $(".norea-source-access-banner");
    expect(banner.attr("role")).toBe("alert");
    expect(banner.text()).toContain("CAPTCHA");
    expect(banner.find("button").length).toBe(3);
  });
  it("shows a promoted work above the work whose transfer is still running", () => {
    expect(workTitles([
      chapter(1, 1, "running", 2), chapter(2, 1, "queued", 3),
      chapter(3, 2, "queued", 0), chapter(4, 2, "queued", 1),
    ])).toEqual(["Novel 2", "Novel 1"]);
  });

  it("places completed history after pending work", () => {
    expect(workTitles([
      chapter(1, 1, "succeeded"), chapter(2, 2, "queued", 0), chapter(3, 3, "failed"),
    ])).toEqual(["Novel 2", "Novel 3", "Novel 1"]);
  });
});
