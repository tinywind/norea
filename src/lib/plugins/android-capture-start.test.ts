import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const template = readFileSync(
  "src-tauri/gen/android/app/src/main/res/raw/norea_scraper_extract_start.js",
  "utf8",
);

function startCapture(protocol: string, topFrame = true) {
  const post = vi.fn();
  const window: Record<string, unknown> = { location: { protocol } };
  window.top = topFrame ? window : {};
  const script = template
    .replaceAll("__NOREA_REQUEST_ID_JSON__", JSON.stringify("capture-1"))
    .replaceAll("__NOREA_REQUEST_NONCE_JSON__", JSON.stringify("nonce-1"))
    .replace("__NOREA_BEFORE_SCRIPT__", "window.ReactNativeWebView.postMessage('captured');");
  runInNewContext(script, { window, AndroidScraper: { postExtractResultWithNonce: post } });
  return post;
}

describe("Android per-request capture script", () => {
  it.each(["https:", "http:"])("runs in a redirected top-level %s document", protocol => {
    expect(startCapture(protocol)).toHaveBeenCalledExactlyOnceWith("capture-1", "nonce-1", "captured");
  });

  it("does not expose the capture bridge to an iframe", () => {
    expect(startCapture("https:", false)).not.toHaveBeenCalled();
  });

  it.each(["about:", "file:", "data:"])("does not run in a %s document", protocol => {
    expect(startCapture(protocol)).not.toHaveBeenCalled();
  });
});
