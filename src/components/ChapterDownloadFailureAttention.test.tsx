import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { StoredChapterDownloadFailure } from "../db/queries/chapter-download-failure";
import type { OverflowMenu } from "./ui/OverflowMenu";

const state = vi.hoisted(() => ({
  rows: [] as StoredChapterDownloadFailure[],
  menus: [] as Parameters<typeof OverflowMenu>[0][],
  forget: vi.fn<(...args: [readonly number[]]) => Promise<void>>().mockResolvedValue(undefined),
}));
vi.mock("../lib/tasks/hooks", () => ({ useChapterDownloadFailureSnapshot: () => state.rows }));
vi.mock("../lib/tasks/chapter-download", () => ({ retryFailedChapterDownloads: vi.fn() }));
vi.mock("../lib/tasks/chapter-download-failures", () => ({ forgetChapterDownloadFailures: state.forget }));
vi.mock("../lib/tasks/source-tasks", () => ({ enqueueOpenSiteTask: vi.fn() }));
vi.mock("../lib/tasks/vpn-download-runtime", () => ({ resumeVpnDownloadRange: vi.fn() }));
vi.mock("../lib/plugins/manager", () => ({ pluginManager: { getPlugin: (id: string) => ({ id, name: "Foo" }) } }));
vi.mock("./ui/OverflowMenu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui/OverflowMenu")>();
  return {
    ...actual,
    OverflowMenu: (props: Parameters<typeof actual.OverflowMenu>[0]) => {
      state.menus.push(props);
      return <actual.OverflowMenu {...props} />;
    },
  };
});
import { ChapterDownloadFailureAttention, ChapterDownloadRetryingStatus } from "./ChapterDownloadFailureAttention";

function row(chapterId: number, patch: Partial<StoredChapterDownloadFailure>): StoredChapterDownloadFailure {
  return {
    chapterId, pluginId: "foo", failureClass: "content", messageSummary: "Failed to fetch novel data: (404)", challengeUrl: null,
    attempts: 1, nextRetryAt: null, jobJson: "{}", updatedAt: chapterId, ...patch,
  };
}

function render() {
  state.menus = [];
  return load(renderToStaticMarkup(<MantineProvider><ChapterDownloadFailureAttention /><ChapterDownloadRetryingStatus /></MantineProvider>));
}

function buttonLabels($: ReturnType<typeof load>, selector: string): string[] {
  return $(`${selector} button`).map((_, element) => $(element).attr("aria-label") ?? "").get();
}

beforeEach(() => {
  state.rows = [];
  state.menus = [];
  state.forget.mockClear();
});

it("renders nothing without persisted failures", () => {
  state.rows = [];
  expect(render()("[data-download-failures]")).toHaveLength(0);
});

it("shows grouped failures with recovery and more actions and waiting retries as a status line", () => {
  state.rows = [
    row(1, {}), row(2, {}),
    row(3, { failureClass: "challenge", challengeUrl: "https://cdn.example/" }),
    row(4, { failureClass: "media-incomplete" }),
    row(5, { failureClass: "transient", nextRetryAt: 10 }),
  ];
  const $ = render();
  expect($('[data-download-failures="retrying"]').attr("role")).toBe("status");
  expect($('[data-download-failures="retrying"]').text()).toBe("1 chapters are waiting to retry.");
  expect($('[data-download-failures="content"]').text()).toContain("Foo: 2 chapters failed (couldn't read the page).");
  expect(buttonLabels($, '[data-download-failures="content"]')).toEqual(["Retry all", "More"]);
  expect($('[data-download-failures="challenge"]').text()).toContain("Foo: 1 chapters need verification at cdn.example.");
  expect(buttonLabels($, '[data-download-failures="challenge"]')).toEqual(["Verify", "More"]);
  expect(buttonLabels($, '[data-download-failures="media-incomplete"]')).toEqual(["Repair all", "More"]);
  expect($('[data-download-failures="transient"]')).toHaveLength(0);
  expect($('[data-download-failures="retrying"]').closest("[role=alert]")).toHaveLength(0);
});

it("keeps waiting retries out of Needs attention", () => {
  state.rows = [row(5, { failureClass: "transient", nextRetryAt: 10 })];
  const $ = load(renderToStaticMarkup(<MantineProvider><ChapterDownloadFailureAttention /></MantineProvider>));
  expect($("[data-download-failures]")).toHaveLength(0);
});

it("renders transient incomplete-media rows as missing images with Repair all and a record menu", () => {
  state.rows = [
    row(6, { failureClass: "transient", messageSummary: "Offline download is incomplete: 2 media assets unavailable." }),
  ];
  const $ = render();
  expect($('[data-download-failures="media-incomplete"]').text()).toContain("Foo: 1 chapters are missing images.");
  expect(buttonLabels($, '[data-download-failures="media-incomplete"]')).toEqual(["Repair all", "More"]);
  expect($('[data-download-failures="transient"]')).toHaveLength(0);
});

it("offers original-site download for retryable serverMissing and only record removal when no original source exists", async () => {
  state.rows = [
    row(10, { messageSummary: "This chapter is not on the content server." }),
    row(11, { messageSummary: "This chapter is not on the content server, and no original source is available." }),
    row(12, { messageSummary: "This chapter is not on the content server, and no original source is available." }),
  ];
  const $ = render();
  const sections = $('[data-download-failures="content"]');
  expect(sections).toHaveLength(2);
  expect(sections.eq(0).text()).toContain("Foo: 1 chapters are not on the content server.");
  expect(sections.eq(0).find("button").map((_, el) => $(el).attr("aria-label")).get())
    .toEqual(["More"]);
  expect(state.menus[0]!.items.map((item) => item.label)).toEqual(["Download from original site (1)", "Clear failure records (1)"]);
  expect(sections.eq(1).text()).toContain("Foo: 2 chapters are not on the content server, and no original source is available.");
  expect(sections.eq(1).find("button").map((_, el) => $(el).attr("aria-label")).get())
    .toEqual(["More"]);

  const records = state.menus[1]!.items;
  expect(records.map((item) => item.label)).toEqual(["Clear failure records (2)"]);
  await records[0]!.onClick();
  expect(state.forget).toHaveBeenCalledWith([11, 12]);
});
