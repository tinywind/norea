import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TaskRecord, TaskSnapshot } from "../lib/tasks/task-types";
import type { VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";
import type { ChapterDownloadRequestState } from "../lib/tasks/chapter-download-requests";
import type { VpnDownloadWork } from "../components/VpnDownloadWorks";

const state = vi.hoisted(() => ({ snapshot: undefined as TaskSnapshot | undefined,
  vpn: { drafts: [], plans: [], loading: false, error: null, capabilities: { supported: true, parallelSupported: true, maxWorkers: 10 }, chapterLabels: {}, ownedChapterIds: [] } as VpnDownloadRuntimeSnapshot,
  requests: [] as ChapterDownloadRequestState[],
  vpnWorks: [] as VpnDownloadWork[],
  fontScalePercent: 100,
  focus: undefined as string | undefined,
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useRouterState: ({ select }: { select: (value: unknown) => unknown }) =>
    select({ location: { pathname: "/downloads", search: { view: "queue", focus: state.focus } } }),
}));
vi.mock("../lib/tasks/hooks", () => ({ useTaskSnapshot: () => state.snapshot, useVpnDownloadRuntimeSnapshot: () => state.vpn,
  useChapterDownloadRequestSnapshot: () => state.requests, useChapterDownloadFailureSnapshot: () => [] }));
vi.mock("../lib/tasks/chapter-download", () => ({ cancelChapterDownloadBatches: vi.fn() }));
vi.mock("../lib/tasks/chapter-download-requests", () => ({ cancelChapterDownloadRequest: vi.fn() }));
vi.mock("../lib/tasks/vpn-download-runtime", () => ({ pauseVpnDownloadRun: vi.fn(), resumeVpnDownloadRun: vi.fn(), cancelVpnDownloadRun: vi.fn() }));
vi.mock("../components/VpnDownloadAttention", () => ({ VpnDownloadAttention: () => null }));
vi.mock("../components/ChapterDownloadFailureAttention", () => ({ ChapterDownloadFailureAttention: () => null, ChapterDownloadRetryingStatus: () => null }));
vi.mock("../components/DownloadGoalAttention", () => ({ DownloadGoalAttention: () => null }));
vi.mock("../components/BackupFolderAttention", () => ({ BackupFolderAttention: () => null, useBackupFolderUnavailable: () => false }));
vi.mock("../components/DownloadGoalWorkLine", () => ({ DownloadGoalWorkLine: () => null }));
vi.mock("../components/VpnDownloadLaunchDialog", () => ({ VpnDownloadLaunchDialog: () => null }));
vi.mock("../components/VpnDownloadWorks", () => ({
  VpnDownloadWorkRow: ({ work }: { work: VpnDownloadWork }) => <div data-vpn-work={work.key}>{work.completed}/{work.total}</div>,
  vpnDownloadWorks: () => state.vpnWorks,
}));
vi.mock("../store/appearance", async (importOriginal) => ({
  ...await importOriginal<typeof import("../store/appearance")>(),
  useAppearanceStore: (selector: (appearance: { fontScalePercent: number }) => unknown) => selector({ fontScalePercent: state.fontScalePercent }),
}));
vi.mock("../lib/tasks/source-access-coordinator", () => ({
  applySourceAccessBrowserOutcome: vi.fn(), cancelSourceAccessWait: vi.fn(),
  openSourceAccessBrowser: vi.fn(), sourceAccessBlockSourceNames: () => [],
}));

import { TaskScheduler } from "../lib/tasks/scheduler";
import { DownloadsQueueView } from "./downloads-queue";

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
  const $ = load(renderToStaticMarkup(<MantineProvider><DownloadsQueueView /></MantineProvider>));
  return $(".norea-task-work-title").map((_, element) => $(element).text()).get();
}

describe("task work group order", () => {
  it("does not present ordinary task counts as the total while VPN works are visible", () => {
    state.vpnWorks = [{ key: "vpn-work", completed: 12, total: 20 } as VpnDownloadWork];
    try {
      workTitles([chapter(1, 1, "running")]);
      const $ = load(renderToStaticMarkup(<MantineProvider><DownloadsQueueView /></MantineProvider>));
      expect($("[data-vpn-work]").text()).toBe("12/20");
      expect($(".norea-downloads-summary").length).toBe(0);
      expect($(".norea-downloads-warning").length).toBe(0);
    } finally {
      state.vpnWorks = [];
    }
  });

  it("omits VPN-owned chapter rows and their authentication banners from the ordinary queue", () => {
    state.vpn.ownedChapterIds = [1];
    const records = [chapter(1, 1, "queued", 0), { ...chapter(2, 2, "running", 1), vpnWorker: { rangeId: "range", slot: 9 as const, generation: 1 } }, chapter(3, 3, "queued", 2)];
    expect(workTitles(records)).toEqual(["Novel 3"]);
    state.vpn.ownedChapterIds = [];
  });

  it("counts the header summary line from the same tasks as the visible list, leaving zeros out", () => {
    state.vpn.ownedChapterIds = [1];
    workTitles([
      chapter(1, 1, "queued", 0), { ...chapter(2, 2, "running", 1), vpnWorker: { rangeId: "range", slot: 9 as const, generation: 1 } },
      chapter(3, 3, "queued", 2), chapter(4, 4, "failed"), chapter(5, 5, "succeeded"),
    ]);
    const $ = load(renderToStaticMarkup(<MantineProvider><DownloadsQueueView /></MantineProvider>));
    expect($(".norea-downloads-summary").text()).toBe("Queued 1 · Done 1 · Failed 1");
    expect($(".norea-downloads-warning")).toHaveLength(0);
    state.vpn.ownedChapterIds = [];
  });

  it("shows a waiting automatic retry with its countdown and Cancel, counted as retrying instead of queued", () => {
    const waiting = { ...chapter(1, 1, "queued"), retryAt: Date.now() + 90_000 };
    state.snapshot = {
      ...new TaskScheduler().getSnapshot(), records: [waiting, chapter(2, 2, "queued")], total: 2,
      sourceQueueOrder: ["source"], sourceQueuesTotal: 1,
    };
    const $ = load(renderToStaticMarkup(<MantineProvider><DownloadsQueueView /></MantineProvider>));
    expect($(".norea-downloads-summary").text()).toBe("Queued 1 · Retrying 1");
    expect($.text()).toContain("Retrying in 2m");
  });

  it("shows a newly accepted request before chapter tasks or catalogs are ready", () => {
    state.snapshot = new TaskScheduler().getSnapshot();
    state.requests = [{ id: "request", title: "Newly requested work", novelIds: [42], total: null, phase: "preparing", error: null }];
    const $ = load(renderToStaticMarkup(<MantineProvider><DownloadsQueueView /></MantineProvider>));
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
    const $ = load(renderToStaticMarkup(<MantineProvider><DownloadsQueueView /></MantineProvider>));
    const banner = $(".norea-source-access-banner");
    expect(banner.attr("role")).toBe("alert");
    expect(banner.text()).toContain("CAPTCHA");
    expect(banner.closest("#norea-downloads-attention-title, .norea-downloads-attention").find("h2").text()).toBe("Needs attention");
    expect(banner.find("button").map((_, element) => $(element).text() || $(element).attr("aria-label")).get())
      .toEqual(["Verify", "More options for source.test"]);
  });
  it("keeps a warning the user can act on as the one header pill, which jumps to Needs attention", () => {
    state.snapshot = { ...new TaskScheduler().getSnapshot(), sourceAccessBlocks: [{
      challenge: { kind: "captcha", url: "https://source.test/chapter/16" },
      detectedAt: 1, revision: 1, scopeKey: "plugin:source:site:source.test", sourceId: "source",
      verificationRequested: false,
    }] };
    const $ = load(renderToStaticMarkup(<MantineProvider><DownloadsQueueView /></MantineProvider>));
    expect($(".norea-downloads-summary")).toHaveLength(0);
    const warning = $("button.norea-downloads-warning");
    expect(warning.text()).toBe("Blocked 1");
    expect(warning.attr("aria-label")).toBe("Show what needs attention: Blocked 1");
  });
  it("states a failed chapter in plain words and keeps the raw error behind Details", () => {
    const failed = { ...chapter(4, 3, "failed"), error: "scraper: browser fetch failed: Failed to fetch" };
    state.snapshot = {
      ...new TaskScheduler().getSnapshot(), sourceQueueOrder: ["source"], sourceQueuesTotal: 1,
      records: [failed],
    };
    const $ = load(renderToStaticMarkup(<MantineProvider><DownloadsQueueView /></MantineProvider>));
    const error = $(".norea-task-row[data-status='failed'] .norea-task-row-error");
    expect(error.find(".norea-task-row-error-text").text()).toBe("Couldn't reach the site. Check your network or the site's status.");
    expect(error.find("button.norea-task-row-error-details").text()).toBe("Details");
    expect($.text()).not.toContain("browser fetch failed");
  });
  it("shows a promoted work above the work whose transfer is still running", () => {
    expect(workTitles([
      chapter(1, 1, "running", 2), chapter(2, 1, "queued", 3),
      chapter(3, 2, "queued", 0), chapter(4, 2, "queued", 1),
    ])).toEqual(["Novel 2", "Novel 1"]);
  });

  it("gives each novel one status, its progress and starts a novel with failures expanded", () => {
    state.snapshot = {
      ...new TaskScheduler().getSnapshot(), sourceQueueOrder: ["source"], sourceQueuesTotal: 1,
      records: [
        chapter(1, 1, "running", 0), chapter(2, 1, "succeeded"), chapter(3, 2, "queued", 1),
        chapter(4, 3, "failed"), chapter(5, 3, "succeeded"),
      ],
    };
    const $ = load(renderToStaticMarkup(<MantineProvider><DownloadsQueueView /></MantineProvider>));
    const rows = $(".norea-task-work-group").map((_, element) => ({
      title: $(element).find(".norea-task-work-title").text(),
      status: $(element).find(".norea-task-work-status").text(),
      count: $(element).find(".norea-task-group-count").first().text(),
      open: $(element).attr("data-collapsed") === undefined,
    })).get();
    expect(rows).toEqual([
      { title: "Novel 1", status: "Downloading", count: "1 / 2", open: false },
      { title: "Novel 2", status: "Waiting", count: "0 / 1", open: false },
      { title: "Novel 3", status: "Needs attention", count: "1 / 2", open: true },
    ]);
  });

  it("lists a group's chapters by chapter only, without repeating the novel, source or waiting line", () => {
    const failed = { ...chapter(4, 3, "failed"), subject: { chapterId: 4, novelId: 3, novelName: "Novel 3", chapterNumber: "72", chapterName: "Harvest" } };
    state.snapshot = {
      ...new TaskScheduler().getSnapshot(), sourceQueueOrder: ["source"], sourceQueuesTotal: 1,
      records: [failed],
    };
    const $ = load(renderToStaticMarkup(<MantineProvider><DownloadsQueueView /></MantineProvider>));
    const row = $(".norea-task-work-rows .norea-task-row").first();
    expect(row.find(".norea-task-row-title").text()).toBe("Ch. 72 · Harvest");
    expect(row.find(".norea-task-row-meta")).toHaveLength(0);
    expect(row.text()).not.toContain("Novel 3");
  });

  it("drops the empty progress bar from a group's waiting chapters", () => {
    const waiting = { ...chapter(5, 3, "queued", 0), progress: { current: 0, total: 1 } };
    state.snapshot = {
      ...new TaskScheduler().getSnapshot(), sourceQueueOrder: ["source"], sourceQueuesTotal: 1,
      records: [{ ...chapter(4, 3, "failed") }, waiting],
    };
    const $ = load(renderToStaticMarkup(<MantineProvider><DownloadsQueueView /></MantineProvider>));
    const row = $(".norea-task-work-rows .norea-task-row[data-status='queued']").first();
    expect(row).toHaveLength(1);
    expect(row.find(".norea-task-row-progress")).toHaveLength(0);
  });

  it("shows a paused source's novels as paused and keeps non-download work under Other activity", () => {
    const scheduler = new TaskScheduler();
    scheduler.pauseSourceQueue();
    state.snapshot = {
      ...scheduler.getSnapshot(), sourceQueueOrder: ["source"], sourceQueuesTotal: 1,
      records: [chapter(1, 1, "queued", 0), {
        id: "install", lane: "main", kind: "plugin.install", priority: "user", title: "Install Foo",
        status: "running", createdAt: 1, canCancel: true, canRetry: false,
      }],
    };
    const $ = load(renderToStaticMarkup(<MantineProvider><DownloadsQueueView /></MantineProvider>));
    expect($(".norea-task-work-status").text()).toBe("Paused");
    expect($("#norea-downloads-other-title").text()).toBe("Other activity");
    expect($(".norea-downloads-other .norea-task-row-title").text()).toBe("Install Foo");
    expect($("button").filter((_, element) => $(element).text() === "Resume downloads")).toHaveLength(1);
  });

  it("labels the pause control and moves rare queue actions into the page overflow", () => {
    state.snapshot = { ...new TaskScheduler().getSnapshot(), sourceQueueOrder: ["source"], sourceQueuesTotal: 1, records: [chapter(1, 1, "queued", 0)] };
    const $ = load(renderToStaticMarkup(<MantineProvider><DownloadsQueueView /></MantineProvider>));
    const header = $(".norea-app-bar-actions");
    expect(header.find("button").first().text()).toBe("Pause downloads");
    expect(header.find('button[aria-label="More"]')).toHaveLength(1);
    expect($("h1.norea-app-bar-title").text()).toContain("Downloads");
  });

  it("omits Needs attention when nothing needs the user", () => {
    state.snapshot = { ...new TaskScheduler().getSnapshot(), records: [chapter(1, 1, "queued", 0)], sourceQueueOrder: ["source"], sourceQueuesTotal: 1 };
    const $ = load(renderToStaticMarkup(<MantineProvider><DownloadsQueueView /></MantineProvider>));
    expect($(".norea-downloads-attention")).toHaveLength(0);
  });

  it("places completed history after pending work", () => {
    expect(workTitles([
      chapter(1, 1, "succeeded"), chapter(2, 2, "queued", 0), chapter(3, 3, "failed"),
    ])).toEqual(["Novel 2", "Novel 3", "Novel 1"]);
  });
});

describe("virtual task row geometry", () => {
  it.each([[100, 72], [125, 90], [75, 54]])("sizes rows from the %i%% root font scale", (fontScalePercent, rowHeight) => {
    state.fontScalePercent = fontScalePercent;
    const records: TaskRecord[] = Array.from({ length: 81 }, (_, index) => ({
      id: `main-${index}`, lane: "main", kind: "plugin.install", priority: "user",
      title: `Install ${index}`, status: index === 0 ? "running" : "queued", createdAt: index, canCancel: true, canRetry: false,
    }));
    state.snapshot = { ...new TaskScheduler().getSnapshot(), records, total: records.length };
    try {
      const $ = load(renderToStaticMarkup(<MantineProvider><DownloadsQueueView /></MantineProvider>));
      expect($(".norea-task-virtual-spacer").attr("style")).toBe(`height:${81 * rowHeight}px`);
    } finally {
      state.fontScalePercent = 100;
    }
  });
});

