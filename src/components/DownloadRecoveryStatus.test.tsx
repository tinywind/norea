import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DownloadRecoveryState } from "../lib/tasks/download-recovery";

const state = vi.hoisted(() => ({ episodes: [] as DownloadRecoveryState[] }));
vi.mock("../lib/tasks/download-recovery", () => ({
  getDownloadRecoverySnapshot: () => state.episodes,
  subscribeDownloadRecovery: () => () => undefined,
}));
import { DownloadRecoveryStatus } from "./DownloadRecoveryStatus";

const episode: DownloadRecoveryState = {
  key: "chapter:1", sourceId: "source", title: "Chapter 1", origin: "https://source.test",
  status: "waiting", action: "retry", retries: 1, maxRetries: 2, nextRetryAt: 31_000,
  profileChanges: 0, maxProfileChanges: 1, siteResetCount: 0, error: "HTTP 503",
};
function render() {
  return load(renderToStaticMarkup(<MantineProvider><DownloadRecoveryStatus /></MantineProvider>));
}
beforeEach(() => {
  state.episodes = [];
  vi.spyOn(Date, "now").mockReturnValue(1_000);
});
afterEach(() => vi.restoreAllMocks());

it("has no status for a queue without an active recovery episode", () => {
  expect(render()("[data-download-recovery]")).toHaveLength(0);
});

it("shows the remaining wait and actual attempt budget for a waiting download", () => {
  state.episodes = [episode];
  const $ = render();
  const status = $('[data-download-recovery="chapter:1"]');
  expect(status.attr("role")).toBe("status");
  expect(status.text()).toContain("Chapter 1");
  expect(status.text()).toContain("Recovery in 30s");
  expect(status.text()).toContain("Recovery attempts: 1/2");
  expect(status.text()).not.toContain("VPN changes");
});

it.each([
  ["resetting", "Resetting site data"],
  ["retrying", "Retrying download"],
  ["switching-profile", "Switching VPN profile"],
  ["held", "Recovery paused"],
] as const)("shows %s from the runtime rather than an assumed next step", (status, text) => {
  state.episodes = [{ ...episode, status, nextRetryAt: null, action: "nextProfile", profileChanges: 1, siteResetCount: 1 }];
  const content = render()("[data-download-recovery]").text();
  expect(content).toContain(text);
  expect(content).toContain("VPN changes: 1/1");
  expect(content).toContain("Site resets: 1/1");
  expect(content).not.toContain("Recovery in");
});

it("never displays a negative countdown after a deadline", () => {
  state.episodes = [{ ...episode, nextRetryAt: 0 }];
  expect(render()("[data-download-recovery]").text()).toContain("Recovery in 0s");
});
