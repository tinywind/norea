import { describe, expect, it } from "vitest";
import { downloadRetryDecision, isRetryableDownloadError } from "./download-retry";
import { TaskUserCancelledError } from "./task-errors";
import { PluginVpnUnavailableError } from "../plugin-vpn-traffic";
import { ChapterMediaHttpRetryError, ChapterMediaIncompleteError, mediaRetryAfterMs } from "../chapter-media/errors";

describe("download recovery policy", () => {
  it.each([
    "Failed to fetch", "scraper: browser fetch failed: network error", "net::ERR_INTERNET_DISCONNECTED",
    "scraper: browser fetch to https://source.test timed out after 30000ms",
    "scraper: timed out preparing fetch context https://source.test",
  ])("retries transport failure: %s", message => {
    expect(isRetryableDownloadError(new Error(message))).toBe(true);
  });
  it.each([
    new TaskUserCancelledError(), new DOMException("Task was paused.", "AbortError"),
    new Error("HTTP 404 Not Found"), new Error("disk timed out"), new Error("Invalid plugin response"),
    new PluginVpnUnavailableError(false),
    new ChapterMediaIncompleteError([{ status: 404, message: "not found", url: "https://source.test/1" }]),
  ])("does not retry cancellation, configuration or permanent content errors", error => {
    expect(downloadRetryDecision(error, 1)).toBeNull();
  });
  it("caps recovery backoff rather than giving up after a short outage", () => {
    const delays = Array.from({ length: 7 }, (_, i) => downloadRetryDecision(new PluginVpnUnavailableError(), i+1)?.delayMs);
    expect(delays).toEqual([5000, 15000, 30000, 60000, 60000, 60000, 60000]);
  });
  it("respects a server Retry-After longer than the default backoff", () => {
    expect(downloadRetryDecision(new ChapterMediaHttpRetryError(429, 120_000), 1)?.delayMs).toBe(120_000);
    expect(mediaRetryAfterMs("120")).toBe(120_000);
    expect(mediaRetryAfterMs("Sat, 26 Sep 2026 00:02:00 GMT", Date.parse("2026-09-26T00:00:00Z"))).toBe(120_000);
    expect(mediaRetryAfterMs("nonsense")).toBe(0);
    expect(mediaRetryAfterMs("-1")).toBe(0);
  });

  it("recognizes explicitly temporary HTTP failures", () => {
    expect(downloadRetryDecision(new ChapterMediaHttpRetryError(503), 1)?.delayMs).toBe(5000);
  });
});
