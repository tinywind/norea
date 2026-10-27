import { describe, expect, it } from "vitest";
import { downloadRetryDecision, isRetryableDownloadError } from "./download-retry";
import { TaskUserCancelledError } from "./task-errors";
import { PluginVpnUnavailableError } from "../plugin-vpn-traffic";
import { SourceAccessRequiredError } from "../plugins/source-access";
import { ChapterMediaHttpRetryError, ChapterMediaIncompleteError, mediaRetryAfterMs } from "../chapter-media/errors";

describe("download recovery policy", () => {
  it.each([
    "Failed to fetch", "scraper: browser fetch failed: network error", "net::ERR_INTERNET_DISCONNECTED",
    "scraper: browser fetch to https://source.test timed out after 30000ms",
    "scraper: timed out preparing fetch context https://source.test",
    "scraper: navigation failed (-1): net::ERR_EMPTY_RESPONSE at https://source.test",
    "webview_extract: timeout after 30000ms",
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
  it("stops retrying the same unavailable media asset after four delayed attempts", () => {
    const error = new ChapterMediaIncompleteError([
      { message: "Failed to fetch", url: "https://media.test/missing.jpg" },
    ]);
    expect(Array.from({ length: 5 }, (_, index) =>
      downloadRetryDecision(error, index + 1)?.delayMs,
    )).toEqual([5000, 15000, 30000, 60000, undefined]);
  });

  it("retries temporary asset HTTP failures with their Retry-After budget", () => {
    const error = new ChapterMediaIncompleteError([
      { status: 503, retryAfterMs: 120_000, message: "HTTP 503", url: "https://media.test/slow.jpg" },
      { message: "Failed to fetch", url: "https://media.test/other.jpg" },
    ]);
    expect(downloadRetryDecision(error, 1)?.delayMs).toBe(120_000);
    expect(downloadRetryDecision(error, 5)).toBeNull();
  });

  it("identifies missing assets without disclosing URL credentials or query tokens", () => {
    const error = new ChapterMediaIncompleteError([
      { fileName: "0056-missing.jpg", message: "Failed to fetch", url: "https://user:password@media.test/missing.jpg?token=secret" },
    ]);
    expect(error.message).toContain("0056-missing.jpg");
    expect(error.message).toContain("media.test");
    expect(error.message).not.toMatch(/password|token=|secret/);
  });

  it("does not retry a mixed network failure and permanently missing asset", () => {
    const error = new ChapterMediaIncompleteError([
      { message: "Failed to fetch", url: "https://media.test/slow.jpg" },
      { status: 404, message: "Not Found", url: "https://media.test/missing.jpg" },
    ]);
    expect(downloadRetryDecision(error, 1)).toBeNull();
  });

  it("caps recovery backoff rather than giving up after a short outage", () => {
    const delays = Array.from({ length: 7 }, (_, i) => downloadRetryDecision(new PluginVpnUnavailableError(), i+1)?.delayMs);
    expect(delays).toEqual([5000, 15000, 30000, 60000, 60000, 60000, 60000]);
  });
  it("never schedules network retries for a CAPTCHA even if its message mentions a timeout", () => {
    expect(downloadRetryDecision(new SourceAccessRequiredError("webview_extract: timeout", {
      kind: "captcha", url: "https://source.test/chapter/15",
    }), 1)).toBeNull();
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
