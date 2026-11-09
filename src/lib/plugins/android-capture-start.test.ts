import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const template = readFileSync(
  "src-tauri/gen/android/app/src/main/res/raw/norea_scraper_extract_start.js",
  "utf8",
);

function startCapture(url: string, targetOrigin = new URL(url).origin, topFrame = true) {
  const post = vi.fn();
  const location = new URL(url);
  const window: Record<string, unknown> = { location };
  window.top = topFrame ? window : {};
  const script = template
    .replaceAll("__NOREA_APP_ORIGIN_JSON__", JSON.stringify("https://tauri.localhost"))
    .replaceAll("__NOREA_TARGET_ORIGIN_JSON__", JSON.stringify(targetOrigin))
    .replaceAll("__NOREA_REQUEST_ID_JSON__", JSON.stringify("capture-1"))
    .replaceAll("__NOREA_REQUEST_NONCE_JSON__", JSON.stringify("nonce-1"))
    .replace("__NOREA_BEFORE_SCRIPT__", "window.ReactNativeWebView.postMessage('captured');");
  runInNewContext(script, {
    window,
    location,
    AndroidScraper: { postExtractResultWithNonce: post },
  });
  return post;
}

describe("Android per-request capture script", () => {
  it.each(["https://source.test/chapter", "http://source.test/chapter"])(
    "runs in the exact top-level target origin: %s",
    (url) => {
      expect(startCapture(url)).toHaveBeenCalledExactlyOnceWith(
        "capture-1",
        "nonce-1",
        "captured",
      );
    },
  );

  it("does not expose the capture bridge to an iframe", () => {
    expect(startCapture("https://source.test/chapter", undefined, false)).not.toHaveBeenCalled();
  });

  it("does not run after a cross-origin redirect", () => {
    expect(
      startCapture("https://redirected.test/chapter", "https://source.test"),
    ).not.toHaveBeenCalled();
  });

  it.each(["about:blank", "file:///tmp/chapter", "data:text/html,chapter"])(
    "does not run in a non-HTTP document: %s",
    (url) => {
      expect(startCapture(url, "https://source.test")).not.toHaveBeenCalled();
    },
  );
});
