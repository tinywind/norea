import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TaskRecord, TaskSnapshot } from "../lib/tasks/task-types";
import type { VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";
import type { ChapterDownloadRequestState } from "../lib/tasks/chapter-download-requests";

const state = vi.hoisted(() => ({ snapshot: undefined as TaskSnapshot | undefined,
  vpn: { drafts: [], plans: [], loading: false, error: null, capabilities: { supported: true, parallelSupported: true, maxWorkers: 10 }, chapterLabels: {}, ownedChapterIds: [] } as VpnDownloadRuntimeSnapshot,
  requests: [] as ChapterDownloadRequestState[],
  fontScalePercent: 100,
}));
vi.mock("../lib/tasks/hooks", () => ({ useTaskSnapshot: () => state.snapshot, useVpnDownloadRuntimeSnapshot: () => state.vpn, useChapterDownloadRequestSnapshot: () => state.requests }));
vi.mock("../lib/tasks/chapter-download", () => ({ cancelChapterDownloadBatches: vi.fn() }));
vi.mock("../lib/tasks/chapter-download-requests", () => ({ cancelChapterDownloadRequest: vi.fn() }));
vi.mock("../lib/tasks/vpn-download-runtime", () => ({ pauseVpnDownloadRun: vi.fn(), resumeVpnDownloadRun: vi.fn(), cancelVpnDownloadRun: vi.fn() }));
vi.mock("../components/VpnDownloadPanel", () => ({ VpnDownloadPanel: () => null }));
vi.mock("../store/appearance", async (importOriginal) => ({
  ...await importOriginal<typeof import("../store/appearance")>(),
  useAppearanceStore: (selector: (appearance: { fontScalePercent: number }) => unknown) => selector({ fontScalePercent: state.fontScalePercent }),
}));
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
    subject: { chapterId: id, novelId, novelName: `Novel ${novelId}` }, status,
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
  it("omits VPN-owned chapter rows and their authentication banners from the ordinary queue", () => {
    state.vpn.ownedChapterIds = [1];
    const records = [chapter(1, 1, "queued", 0), { ...chapter(2, 2, "running", 1), vpnWorker: { rangeId: "range", slot: 9 as const, generation: 1 } }, chapter(3, 3, "queued", 2)];
    expect(workTitles(records)).toEqual(["Novel 3"]);
    state.vpn.ownedChapterIds = [];
  });

  it("counts the header total and summary pills from the same tasks as the visible list", () => {
    state.vpn.ownedChapterIds = [1];
    workTitles([
      chapter(1, 1, "queued", 0), { ...chapter(2, 2, "running", 1), vpnWorker: { rangeId: "range", slot: 9 as const, generation: 1 } },
      chapter(3, 3, "queued", 2), chapter(4, 4, "failed"), chapter(5, 5, "succeeded"),
    ]);
    const $ = load(renderToStaticMarkup(<MantineProvider><TasksPage /></MantineProvider>));
    expect($(".norea-task-title-count").text()).toBe("3");
    expect($(".norea-task-summary-pill").map((_, element) => $(element).text()).get())
      .toEqual(["Running 0", "Queued 1", "Blocked 0", "Failed 1", "Done 1"]);
    state.vpn.ownedChapterIds = [];
  });

  it("shows a newly accepted request before chapter tasks or catalogs are ready", () => {
    state.snapshot = new TaskScheduler().getSnapshot();
    state.requests = [{ id: "request", title: "Newly requested work", novelIds: [42], total: null, phase: "preparing", error: null }];
    const $ = load(renderToStaticMarkup(<MantineProvider><TasksPage /></MantineProvider>));
    expect($.text()).toContain("Newly requested work");
    expect($('[data-download-request="request"]').text()).toContain("Preparing downloads");
    expect($.text()).not.toContain("Nothing in the queue");
    state.requests = [];
  });
  it("shows mandatory CAPTCHA verification instead of a network retry", () => {
    state.snapshot = { ...new TaskScheduler().getSnapshot(), sourceAccessBlocks: [{
      challenge: { kind: "captcha", url: "https://source.test/chapter/16" },
      detectedAt: 1, revision: 1, scopeKey: "plugin:source:site:source.test", sourceId: "source",
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

describe("virtual task row geometry", () => {
  it.each([[100, 64], [125, 80], [75, 48]])("sizes rows from the %i%% root font scale", (fontScalePercent, rowHeight) => {
    state.fontScalePercent = fontScalePercent;
    const records: TaskRecord[] = Array.from({ length: 81 }, (_, index) => ({
      id: `main-${index}`, lane: "main", kind: "plugin.install", priority: "user",
      title: `Install ${index}`, status: "queued", createdAt: index, canCancel: true, canRetry: false,
    }));
    state.snapshot = { ...new TaskScheduler().getSnapshot(), records, total: records.length };
    try {
      const $ = load(renderToStaticMarkup(<MantineProvider><TasksPage /></MantineProvider>));
      expect($(".norea-task-virtual-spacer").attr("style")).toBe(`height:${81 * rowHeight}px`);
    } finally {
      state.fontScalePercent = 100;
    }
  });
});
