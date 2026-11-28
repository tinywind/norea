import { describe, expect, it } from "vitest";
import { ChapterMediaFinalizationError, ChapterMediaHttpRetryError, ChapterMediaIncompleteError } from "../chapter-media/errors";
import { ChapterStorageError } from "../chapter-storage-error";
import { cloudflareAccessError } from "../http/response";
import { PluginVpnUnavailableError } from "../plugin-vpn-traffic";
import { PluginVpnTransportError } from "../plugin-vpn-transport";
import { SourceAccessRequiredError } from "../plugins/source-access";
import { ContentServerError, ContentServerTransportError } from "../content-sync/client";
import {
  automaticRetryDelayMs, classifyDownloadFailure, isChapterMediaVerificationFailure, isContentRejectedFailure,
  isImmediateSourceStopFailure, isIncompleteMediaFailure, isServerChapterMissingFailure,
  isServerChapterMissingWithoutSourceFailure, isSkippableIncompleteMediaFailure, isSourceForbiddenFailure,
  isSourceSiteMovedFailure, ServerChapterMissingError,
} from "./download-failure";
import { DownloadRecoveryHoldError } from "./download-recovery";

const cdnChallenge = cloudflareAccessError(
  { status: 403, statusText: "Forbidden", headers: { "cf-mitigated": "challenge" }, finalUrl: "https://cdn.example.net/a.jpg", body: "" },
  "https://cdn.example.net/a.jpg",
  "https://source.example.com/chapter/1",
);

describe("classifyDownloadFailure", () => {
  it.each([
    ["timeout", new Error("webview_fetch: timeout after 30000ms")],
    ["connection reset", new Error("Failed to fetch")],
    ["service unavailable", new Error("Request failed (HTTP 503)")],
    ["rate limit", new Error("Too many requests: status 429")],
    ["server error", new Error("Bad gateway (502)")],
    ["unknown plugin error", new Error("Something went wrong")],
  ])("treats %s as transient", (_, error) => {
    expect(classifyDownloadFailure(error).failureClass).toBe("transient");
  });

  it("never automatically retries HTTP 403 without a resolvable source scope", () => {
    const failure = classifyDownloadFailure(new Error("Forbidden (HTTP 403)"));
    expect(failure.failureClass).toBe("content");
    expect(automaticRetryDelayMs(failure, 1)).toBeNull();
    expect(failure.summary).toContain("403");
  });

  it("honors Retry-After recorded for a throttled media host", () => {
    const error = new ChapterMediaIncompleteError([
      { message: "Media server temporarily unavailable (HTTP 429).", status: 429, retryAfterMs: 900_000, url: "https://img.example/a.png" },
    ]);
    expect(classifyDownloadFailure(error)).toMatchObject({ failureClass: "transient", retryAfterMs: 900_000 });
    expect(classifyDownloadFailure(new ChapterMediaHttpRetryError(503, 45_000)))
      .toMatchObject({ failureClass: "transient", retryAfterMs: 45_000 });
  });

  it("treats a source-host challenge as a challenge for that host", () => {
    const error = new SourceAccessRequiredError("Cloudflare verification is required.", {
      kind: "cloudflare", url: "https://source.example.com/chapter/1",
    });
    expect(classifyDownloadFailure(error))
      .toMatchObject({ failureClass: "challenge", challengeUrl: "https://source.example.com/chapter/1" });
  });

  it("treats a CDN challenge as a challenge for the CDN host", () => {
    expect(cdnChallenge).toBeInstanceOf(Error);
    expect(classifyDownloadFailure(cdnChallenge))
      .toMatchObject({ failureClass: "challenge", challengeUrl: "https://cdn.example.net/" });
    const media = new ChapterMediaIncompleteError([
      { message: cdnChallenge!.message, status: 403, url: "https://cdn.example.net/a.jpg" },
    ]);
    expect(classifyDownloadFailure(media))
      .toMatchObject({ failureClass: "challenge", challengeUrl: "https://cdn.example.net/" });
  });

  it.each([
    ["missing chapter on the source", new Error("Failed to fetch novel data: (404)")],
    ["gone page", new Error("Request failed with status code 410")],
    ["plugin parse error", new TypeError("Cannot read properties of undefined (reading 'text')")],
    ["missing local chapter", new Error('chapter-download: local chapter 7 was not found for "C" from plugin "p" at path "/c".')],
    ["recovered folder chapter without a source match", new Error("This chapter is not on the content server, and its source has no matching chapter.")],
    ["invalid acquisition plan", new Error("Chapter acquisition page URL must be absolute.")],
    ["missing page content", new Error("content-not-found: The chapter body was not found.")],
  ])("treats %s as a content failure", (_, error) => {
    expect(classifyDownloadFailure(error).failureClass).toBe("content");
  });

  it.each([
    new Error("chapter_content_save: write failed: No space left on device (os error 28)"),
    new Error("error returned from database: (code: 13) database or disk is full"),
    new ChapterMediaFinalizationError(new Error("rename failed")),
  ])("treats %s as a storage failure", (error) => {
    expect(classifyDownloadFailure(error).failureClass).toBe("storage");
  });

  it("keeps missing images that will not heal as incomplete media", () => {
    const error = new ChapterMediaIncompleteError([
      { message: "Not found", status: 404, url: "https://img.example/a.png" },
      { message: "Media server temporarily unavailable (HTTP 503).", status: 503, url: "https://img.example/b.png" },
    ]);
    expect(classifyDownloadFailure(error).failureClass).toBe("media-incomplete");
  });

  it("redacts URLs and bounds the summary", () => {
    const summary = classifyDownloadFailure(new Error(`Failed at https://source.example.com/secret?token=1 ${"x".repeat(400)}`)).summary;
    expect(summary).toContain("https://source.example.com");
    expect(summary).not.toContain("token");
    expect(summary.length).toBeLessThanOrEqual(300);
  });
});

describe("source site moved", () => {
  it("keeps both addresses and is not retried as a transient timeout", () => {
    const error = new Error("webview_extract: timeout after 35000ms; the page moved to https://www.goodtoon012.com, outside the source site https://www.goodtoon011.com");
    expect(classifyDownloadFailure(error)).toMatchObject({ failureClass: "content", summary: error.message });
    expect(classifyDownloadFailure(new Error("webview_extract: timeout after 35000ms")).failureClass).toBe("transient");
  });
});

describe("isSourceForbiddenFailure", () => {
  it("recognizes a plain 403 but not a challenge or another status", () => {
    expect(isSourceForbiddenFailure(new Error("HTTP 403 Forbidden on https://source.example.com/chapter/1"))).toBe(true);
    expect(isSourceForbiddenFailure(new SourceAccessRequiredError("Cloudflare verification is required.", {
      kind: "cloudflare", url: "https://source.example.com/chapter/1",
    }))).toBe(false);
    expect(isSourceForbiddenFailure(new Error("HTTP 404 Not Found on https://source.example.com/chapter/1"))).toBe(false);
    expect(isSourceForbiddenFailure(new Error("webview_extract: timeout after 35000ms"))).toBe(false);
  });
});

describe("isServerChapterMissingFailure", () => {
  it("recognizes the error and its stored summary, but not a chapter the source also lacks", () => {
    const error = new ServerChapterMissingError();
    expect(isServerChapterMissingFailure(error)).toBe(true);
    expect(isServerChapterMissingWithoutSourceFailure(error)).toBe(false);
    expect(classifyDownloadFailure(error)).toMatchObject({ failureClass: "content", summary: error.message });
    expect(isServerChapterMissingFailure(classifyDownloadFailure(error).summary)).toBe(true);
    expect(isServerChapterMissingWithoutSourceFailure(classifyDownloadFailure(error).summary)).toBe(false);

    const noSource = new ServerChapterMissingError({ sourceUnavailable: true });
    expect(isServerChapterMissingFailure(noSource)).toBe(true);
    expect(isServerChapterMissingWithoutSourceFailure(noSource)).toBe(true);
    expect(classifyDownloadFailure(noSource)).toMatchObject({ failureClass: "content", summary: noSource.message });
    expect(isServerChapterMissingWithoutSourceFailure(classifyDownloadFailure(noSource).summary)).toBe(true);

    expect(isServerChapterMissingFailure(new Error("This chapter is not on the content server, and its source has no matching chapter."))).toBe(false);
    expect(isServerChapterMissingFailure(new Error("webview_extract: timeout after 35000ms"))).toBe(false);
    expect(classifyDownloadFailure(new Error("The composed chapter has no original source chapter path.")).failureClass).toBe("content");
    expect(classifyDownloadFailure(new Error("The composed chapter's original source metadata is missing.")).failureClass).toBe("content");
  });
});

describe("automaticRetryDelayMs", () => {
  it.each(["transient", "content", "storage", "challenge", "media-incomplete"] as const)("requires explicit retry after every %s failure", failureClass => {
    for (const attempts of [1,2,3,4]) {
      expect(automaticRetryDelayMs({failureClass, retryAfterMs:900_000}, attempts)).toBeNull();
    }
  });
});

it.each([401, 403, 404, 429, 500, 503])("keeps content server HTTP %i separate from source access failures", status => {
  const error = new ContentServerError(status, `Content server request failed (HTTP ${status}) at https://server.test/chapter`);
  const failure = classifyDownloadFailure(error);
  expect(failure.failureClass).toBe(status >= 500 || status === 429 ? "transient" : "content");
  expect(failure.challengeUrl).toBeUndefined();
  expect(isSourceForbiddenFailure(error)).toBe(false);
});

it.each([
  "Content server transport failed (HTTP 403).",
  "External resource at content.test requires Cloudflare verification.",
])("keeps retryable server transport details separate from source challenge policies", message => {
  const error = new ContentServerTransportError(message);
  expect(classifyDownloadFailure(error)).toMatchObject({ failureClass: "transient", retryAfterMs: 0 });
  expect(classifyDownloadFailure(error).challengeUrl).toBeUndefined();
  expect(isSourceForbiddenFailure(error)).toBe(false);
});

describe("isSkippableIncompleteMediaFailure", () => {
  it("allows continuing past per-asset timeouts, 5xx, network errors, and 404s", () => {
    expect(isSkippableIncompleteMediaFailure(new ChapterMediaIncompleteError([
      { fileName: "0009.jpg", message: "scraper: browser fetch to https://img.goodtoon9001.top timed out after 30000ms", url: "https://img.goodtoon9001.top/0009.jpg" },
    ]))).toBe(true);
    expect(isSkippableIncompleteMediaFailure(new ChapterMediaIncompleteError([
      { status: 503, message: "HTTP 503", url: "https://img.example/a.jpg" },
      { status: 404, message: "HTTP 404", url: "https://img.example/b.jpg" },
    ]))).toBe(true);
  });

  it("blocks skipping for challenges, 403, any 429 rate limit (including mixed 404+429), or non-media errors", () => {
    expect(isSkippableIncompleteMediaFailure(new ChapterMediaIncompleteError([
      { status: 403, message: "HTTP 403", url: "https://img.example/a.jpg" },
    ]))).toBe(false);
    expect(isSkippableIncompleteMediaFailure(new ChapterMediaIncompleteError([
      { status: 429, message: "HTTP 429", url: "https://img.example/a.jpg" },
    ]))).toBe(false);
    expect(isSkippableIncompleteMediaFailure(new ChapterMediaIncompleteError([
      { status: 404, message: "HTTP 404", url: "https://img.example/missing.jpg" },
      { status: 429, message: "HTTP 429", url: "https://img.example/limited.jpg" },
    ]))).toBe(false);
    expect(isSkippableIncompleteMediaFailure(new ChapterMediaIncompleteError([
      { status: 503, message: "HTTP 503", url: "https://img.example/unavailable.jpg" },
      { status: 429, message: "HTTP 429", url: "https://img.example/limited.jpg" },
    ]))).toBe(false);
    expect(isSkippableIncompleteMediaFailure(new ChapterMediaIncompleteError([
      { status: 503, message: cdnChallenge!.message, url: "https://cdn.example.net/a.jpg" },
    ]))).toBe(false);
    expect(isSkippableIncompleteMediaFailure(new Error("webview_extract: timeout after 35000ms"))).toBe(false);
  });
});

describe("single-chapter verification and immediate stop classification", () => {
  it("separates single-chapter archive/manifest verification failures and metadata mismatches from global storage stops", () => {
    const verification = new ChapterMediaFinalizationError(
      new ChapterStorageError(
        "archive chapter media",
        "chapter media: media archive finalization incomplete: loose media file '0007-7.jpg' has 0 bytes, expected 183222",
      ),
    );
    expect(isChapterMediaVerificationFailure(verification)).toBe(true);
    expect(classifyDownloadFailure(verification).failureClass).toBe("media-incomplete");

    const diskFullFinalization = new ChapterMediaFinalizationError(
      new ChapterStorageError("archive chapter media", "chapter media: media archive finalization incomplete: No space left on device (os error 28)"),
    );
    expect(isChapterMediaVerificationFailure(diskFullFinalization)).toBe(false);
    expect(classifyDownloadFailure(diskFullFinalization).failureClass).toBe("storage");

    const ioErrorFinalization = new ChapterMediaFinalizationError(
      new ChapterStorageError("archive chapter media", "chapter media: media archive finalization incomplete: cannot read media archive entry '001.jpg': Input/output error (os error 5)"),
    );
    expect(isChapterMediaVerificationFailure(ioErrorFinalization)).toBe(false);
    expect(classifyDownloadFailure(ioErrorFinalization).failureClass).toBe("storage");

    const permissionFinalization = new ChapterMediaFinalizationError(
      new ChapterStorageError("archive chapter media", "chapter media: media archive finalization incomplete: Permission denied (os error 13)"),
    );
    expect(isChapterMediaVerificationFailure(permissionFinalization)).toBe(false);
    expect(classifyDownloadFailure(permissionFinalization).failureClass).toBe("storage");

    expect(classifyDownloadFailure(new Error("Downloaded chapter metadata is missing.")).failureClass).toBe("content");
    expect(classifyDownloadFailure(new Error("Server chapter novel ID does not match the local work.")).failureClass).toBe("content");
  });

  it("identifies immediate source stops vs isolated chapter failures", () => {
    expect(isImmediateSourceStopFailure(new Error("HTTP 403 Forbidden"))).toBe(true);
    expect(isImmediateSourceStopFailure(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isImmediateSourceStopFailure(new Error("HTTP 401 Unauthorized"))).toBe(true);
    expect(isImmediateSourceStopFailure(new Error("webview_extract: timeout after 35000ms; the page moved to https://new.example, outside the source site https://old.example"))).toBe(true);
    expect(isImmediateSourceStopFailure(new Error("manual-action-required: Solve challenge"))).toBe(true);
    const rejected = new Error("content-rejected: Captured chapter content contains text the plugin rejects.");
    expect(isImmediateSourceStopFailure(rejected)).toBe(true);
    expect(classifyDownloadFailure(rejected).failureClass).toBe("transient");
    expect(isImmediateSourceStopFailure(new PluginVpnUnavailableError())).toBe(true);
    expect(isImmediateSourceStopFailure(new ChapterMediaIncompleteError([
      { status: 404, message: "HTTP 404", url: "https://img.example/a.jpg" },
      { status: 429, message: "HTTP 429", url: "https://img.example/b.jpg" },
    ]))).toBe(true);

    expect(isImmediateSourceStopFailure(new Error("HTTP 503 Service Unavailable"))).toBe(false);
    expect(isImmediateSourceStopFailure(new Error("webview_extract: timeout after 35000ms"))).toBe(false);
    expect(isImmediateSourceStopFailure(new TypeError("Failed to fetch"))).toBe(false);
    expect(isImmediateSourceStopFailure(new Error("content-not-found: Empty chapter body"))).toBe(false);
    expect(isImmediateSourceStopFailure(new Error("Downloaded chapter metadata is missing."))).toBe(false);
  });

  it("recognizes incomplete media errors and stored failure summaries", () => {
    const error = new ChapterMediaIncompleteError([
      { fileName: "0009.jpg", message: "scraper: browser fetch timed out", url: "https://img.example/0009.jpg" },
    ]);
    expect(isIncompleteMediaFailure(error)).toBe(true);
    expect(isIncompleteMediaFailure(classifyDownloadFailure(error).summary)).toBe(true);
    expect(isIncompleteMediaFailure("HTTP 404: Offline download is incomplete: 1 media assets unavailable (HTTP 404).")).toBe(true);
    expect(isIncompleteMediaFailure("Failed to fetch")).toBe(false);
  });

  it("matches source site moves and content rejections directly and through cause chains", () => {
    const moved = new Error("webview_extract: timeout after 35000ms; the page moved to https://new.example.test, outside the source site https://old.example.test");
    const wrappedMoved = new PluginVpnTransportError({
      routeGeneration: 1,
      requestId: 1,
      host: "old.example.test",
      port: 443,
      kind: "tcp",
      message: "timed out waiting for response",
    }, moved);
    const heldMoved = new DownloadRecoveryHoldError("Download held", moved);
    expect(isSourceSiteMovedFailure(moved)).toBe(true);
    expect(isSourceSiteMovedFailure(wrappedMoved)).toBe(true);
    expect(isSourceSiteMovedFailure(heldMoved)).toBe(true);
    expect(classifyDownloadFailure(wrappedMoved).failureClass).toBe("content");
    expect(isSourceSiteMovedFailure(new Error("webview_extract: timeout after 35000ms"))).toBe(false);

    const rejected = new Error("content-rejected: Captured chapter content contains text the plugin rejects.");
    const wrappedRejected = new DownloadRecoveryHoldError("Recovery paused after retry budget", rejected);
    const codedRejected = Object.assign(new Error("Plugin refused substitute content"), { code: "content-rejected" });
    expect(isContentRejectedFailure(rejected)).toBe(true);
    expect(isContentRejectedFailure(wrappedRejected)).toBe(true);
    expect(isContentRejectedFailure(codedRejected)).toBe(true);
    expect(isImmediateSourceStopFailure(wrappedRejected)).toBe(true);
    expect(isContentRejectedFailure(new Error("content-not-found: Empty chapter body"))).toBe(false);

    const cyclic: Error & { cause?: unknown } = new Error("cyclic error");
    cyclic.cause = cyclic;
    expect(isSourceSiteMovedFailure(cyclic)).toBe(false);
    expect(isContentRejectedFailure(cyclic)).toBe(false);
  });
});
