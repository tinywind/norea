import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const androidInitialization = readFileSync(
  new URL(
    "../../src-tauri/gen/android/app/src/main/res/raw/norea_scraper_init.js",
    import.meta.url,
  ),
  "utf8",
);
const desktopInitialization = readFileSync(
  new URL("../../src-tauri/src/scraper/scripts/initialization.js", import.meta.url),
  "utf8",
);
const androidDocumentStart = readFileSync(
  new URL(
    "../../src-tauri/gen/android/app/src/main/res/raw/norea_scraper_extract_start.js",
    import.meta.url,
  ),
  "utf8",
);

function withAppUrl(source: string, appUrl = "http://localhost:1420/") {
  return source.replaceAll(
    "__NOREA_APP_ORIGIN_JSON__",
    JSON.stringify(new URL(appUrl).origin),
  );
}

function staticContext(
  source: string,
  url: string,
  name = "",
  appUrl = "https://dev-norea.test:3000/",
) {
  const results: unknown[][] = [];
  const location = new URL(url);
  const context = createContext({
    URL,
    location,
    name,
    AndroidScraper: {
      postExtractResult(...args: unknown[]) {
        results.push(args);
      },
      postDocumentReady: vi.fn(),
    },
    document: { readyState: "loading", addEventListener: vi.fn() },
    history: { replaceState: vi.fn() },
    results,
    executed: false,
  });
  context.window = context;
  context.top = context;
  runInContext(withAppUrl(source, appUrl), context);
  return context;
}

describe.each([
  ["desktop", desktopInitialization],
  ["Android", androidInitialization],
])("%s static scraper bridge", (platform, source) => {
  it.each([
    "tauri://localhost/scraper.html",
    "http://tauri.localhost/scraper.html",
    "https://tauri.localhost/scraper.html",
    "http://asset.localhost/scraper.html",
    "https://norea-media.localhost/reader-asset/probe.html",
    "https://dev-norea.test:3000/scraper.html",
  ])("does not expose a bridge inside application origins: %s", (url) => {
    const context = staticContext(source, url);
    expect(context.ReactNativeWebView).toBeUndefined();
  });

  it("never executes page-controlled fragment or window.name text", () => {
    const payload = encodeURIComponent("globalThis.executed = true");
    for (const url of [
      `https://source.test/chapter#__norea_script__=${payload}`,
      "https://redirected.test/chapter",
    ]) {
      const context = staticContext(source, url, `__norea_script__=${payload}`);
      expect(context.executed).toBe(false);
      expect(typeof context.ReactNativeWebView.postMessage).toBe("function");
    }
  });

  it("contains no dynamic-code execution primitive", () => {
    expect(source).not.toContain("__norea_script__=");
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toContain("new Function");
  });

  if (platform === "desktop") {
    it("accepts only an opaque request id from window.name", () => {
      const context = staticContext(
        source,
        "https://source.test/chapter",
        "__norea_request__=" + encodeURIComponent("request-123"),
      );
      expect(context.__noreaExtractRequestId).toBe("request-123");
      expect(context.name).toBe("");
      expect(context.executed).toBe(false);
    });
  }
});

function runAndroidDocumentStart(url: string, targetOrigin: string, topFrame = true) {
  const post = vi.fn();
  const location = new URL(url);
  const context = createContext({
    URL,
    location,
    AndroidScraper: { postExtractResultWithNonce: post },
    executed: false,
  });
  context.window = context;
  context.top = topFrame ? context : {};
  const source = withAppUrl(androidDocumentStart, "https://dev-norea.test:3000/")
    .replaceAll("__NOREA_TARGET_ORIGIN_JSON__", JSON.stringify(targetOrigin))
    .replaceAll("__NOREA_REQUEST_ID_JSON__", JSON.stringify("expected-request"))
    .replaceAll("__NOREA_REQUEST_NONCE_JSON__", JSON.stringify("expected-nonce"))
    .replace("__NOREA_BEFORE_SCRIPT__", 'globalThis.executed = true; window.ReactNativeWebView.postMessage("page-result");');
  runInContext(source, context);
  return { context, post };
}

describe("Android per-request document-start script", () => {
  it.each(["https://source.test/chapter", "http://source.test/chapter"])(
    "runs only in the exact target origin: %s",
    (url) => {
      const target = new URL(url).origin;
      const { context, post } = runAndroidDocumentStart(url, target);
      expect(context.executed).toBe(true);
      expect(post).toHaveBeenCalledExactlyOnceWith(
        "expected-request",
        "expected-nonce",
        "page-result",
      );
    },
  );

  it.each([
    "https://redirected.test/chapter",
    "https://tauri.localhost/scraper.html",
    "https://dev-norea.test:3000/scraper.html",
    "file:///tmp/chapter.html",
  ])("rejects a mismatched or protected document: %s", (url) => {
    const { context, post } = runAndroidDocumentStart(
      url,
      "https://source.test",
    );
    expect(context.executed).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it("does not expose the bridge to a subframe", () => {
    const { context, post } = runAndroidDocumentStart(
      "https://source.test/chapter",
      "https://source.test",
      false,
    );
    expect(context.executed).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
});
