import { describe, expect, it } from "vitest";
import { ChapterMediaFinalizationError, ChapterMediaHttpRetryError, ChapterMediaIncompleteError } from "../chapter-media/errors";
import { cloudflareAccessError } from "../http/response";
import { SourceAccessRequiredError } from "../plugins/source-access";
import { ContentServerError, ContentServerTransportError } from "../content-sync/client";
import { automaticRetryDelayMs, classifyDownloadFailure, isSourceForbiddenFailure } from "./download-failure";

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
