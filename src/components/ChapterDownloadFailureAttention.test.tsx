import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { StoredChapterDownloadFailure } from "../db/queries/chapter-download-failure";

const state = vi.hoisted(() => ({ rows: [] as StoredChapterDownloadFailure[] }));
vi.mock("../lib/tasks/hooks", () => ({ useChapterDownloadFailureSnapshot: () => state.rows }));
vi.mock("../lib/tasks/chapter-download", () => ({ retryFailedChapterDownloads: vi.fn() }));
vi.mock("../lib/tasks/chapter-download-failures", () => ({ forgetChapterDownloadFailures: vi.fn() }));
vi.mock("../lib/tasks/source-tasks", () => ({ enqueueOpenSiteTask: vi.fn() }));
vi.mock("../lib/tasks/vpn-download-runtime", () => ({ resumeVpnDownloadRange: vi.fn() }));
vi.mock("../lib/plugins/manager", () => ({ pluginManager: { getPlugin: (id: string) => ({ id, name: "Foo" }) } }));
import { ChapterDownloadFailureAttention, ChapterDownloadRetryingStatus } from "./ChapterDownloadFailureAttention";

function row(chapterId: number, patch: Partial<StoredChapterDownloadFailure>): StoredChapterDownloadFailure {
  return {
    chapterId, pluginId: "foo", failureClass: "content", messageSummary: "Failed to fetch novel data: (404)", challengeUrl: null,
    attempts: 1, nextRetryAt: null, jobJson: "{}", updatedAt: chapterId, ...patch,
  };
}

function render() {
  return load(renderToStaticMarkup(<MantineProvider><ChapterDownloadFailureAttention /><ChapterDownloadRetryingStatus /></MantineProvider>));
}

it("renders nothing without persisted failures", () => {
  state.rows = [];
  expect(render()("[data-download-failures]")).toHaveLength(0);
});

it("shows grouped failures with one action and waiting retries as a status line", () => {
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
  expect($('[data-download-failures="content"] button').attr("aria-label")).toBe("Retry all");
  expect($('[data-download-failures="challenge"]').text()).toContain("Foo: 1 chapters need verification at cdn.example.");
  expect($('[data-download-failures="challenge"] button').attr("aria-label")).toBe("Verify");
  expect($('[data-download-failures="media-incomplete"] button').attr("aria-label")).toBe("Repair all");
  expect($('[data-download-failures="transient"]')).toHaveLength(0);
  expect($('[data-download-failures="retrying"]').closest("[role=alert]")).toHaveLength(0);
});

it("keeps waiting retries out of Needs attention", () => {
  state.rows = [row(5, { failureClass: "transient", nextRetryAt: 10 })];
  const $ = load(renderToStaticMarkup(<MantineProvider><ChapterDownloadFailureAttention /></MantineProvider>));
  expect($("[data-download-failures]")).toHaveLength(0);
});
