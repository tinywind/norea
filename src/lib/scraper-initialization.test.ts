import { readFileSync } from "node:fs";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

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
  return source.replaceAll("__NOREA_APP_ORIGIN_JSON__", JSON.stringify(new URL(appUrl).origin));
}

describe.each([
  ["desktop", desktopInitialization],
  ["Android", androidInitialization],
  ["Android document-start", androidDocumentStart],
])("%s before-script origin boundary", (platform, source) => {
  const appUrl = "https://dev-norea.test:3000/";
  const script = 'globalThis.executed = true; window.ReactNativeWebView.postMessage("page-result")';

  function runHandoff(url: string, handoff: "fragment" | "window.name") {
    const location = new URL(url);
    const encoded = encodeURIComponent(script);
    const authority = platform === "Android"
      ? "&__norea_request_id__=expected-request&__norea_nonce__=expected-nonce"
      : "";
    if (handoff === "fragment") location.hash = "__norea_script__=" + encoded + authority;
    const results: unknown[][] = [];
    const context = createContext({
      URL,
      location,
      name: handoff === "window.name"
        ? "__norea_script__=" + encoded + (platform === "Android"
          ? authority + "&__norea_origin__=" + encodeURIComponent(location.origin)
          : "")
        : "",
      AndroidScraper: {
        postExtractResultWithNonce(...args: unknown[]) { results.push(args); },
        postExtractResult(...args: unknown[]) { results.push(args); },
      },
      results,
      document: { readyState: "loading", addEventListener() {} },
      history: { replaceState() {} },
      executed: false,
    });
    context.window = context;
    context.top = context;
    const filled = withAppUrl(source, appUrl)
      .replaceAll("__NOREA_REQUEST_ID_JSON__", JSON.stringify("expected-request"))
      .replaceAll("__NOREA_REQUEST_NONCE_JSON__", JSON.stringify("expected-nonce"))
      .replaceAll("__NOREA_BEFORE_SCRIPT__", script);
    runInContext(filled, context);
    return context;
  }

  it.each([
    "tauri://localhost/scraper.html",
    "http://tauri.localhost/scraper.html",
    "https://tauri.localhost/scraper.html",
    "http://asset.localhost/scraper.html",
    "https://norea-media.localhost/reader-asset/probe.html",
    "https://dev-norea.test:3000/scraper.html",
  ])("does not run a handoff inside application origins: %s", (url) => {
    for (const handoff of ["fragment", "window.name"] as const) {
      const context = runHandoff(url, handoff);
      expect(context.executed).toBe(false);
      expect(context.results).toHaveLength(0);
      if (handoff === "window.name") expect(context.name).toBe("");
      if (platform !== "Android document-start") {
        expect(typeof context.ReactNativeWebView.postMessage).toBe("function");
      }
    }
  });

  it("preserves ordinary website hooks across remote redirects", () => {
    for (const url of ["https://source.test/chapter", "https://redirected.test/chapter"]) {
      for (const handoff of ["fragment", "window.name"] as const) {
        const context = runHandoff(url, handoff);
        expect(context.executed).toBe(true);
        if (platform === "desktop") {
          expect(context.__noreaExtractResult).toBe("page-result");
        } else {
          expect(context.results).toEqual([["expected-request", "expected-nonce", "page-result"]]);
        }
      }
    }
  });
});

describe("Android scraper initialization parameters", () => {
  it("keeps adversarial parameter names as strings without changing prototypes", () => {
    const parser = androidInitialization.slice(
      androidInitialization.indexOf("function parseParams(raw)"),
      androidInitialization.indexOf("function hashParams()"),
    );
    const result = JSON.parse(runInNewContext(`${parser}
      var params = parseParams(input);
      JSON.stringify({
        samePrototype: Object.getPrototypeOf(params) === Object.prototype,
        hasPrototypeProperty: Object.hasOwn(params, '__proto__'),
        polluted: Object.hasOwn(Object.prototype, 'polluted'),
        constructor: params.constructor,
        toString: params.toString,
        malformed: params['%ZZ'],
        requestId: params.__norea_request_id__,
        nonce: params.__norea_nonce__
      });`, {
      input: [
        "__proto__=" + encodeURIComponent('{"polluted":true}'),
        "constructor=string-value",
        "toString=another-string",
        "%ZZ=malformed-key",
        "__norea_request_id__=expected-request",
        "__norea_nonce__=expected-nonce",
      ].join("&"),
    }));

    expect(result).toEqual({
      samePrototype: true,
      hasPrototypeProperty: false,
      polluted: false,
      constructor: "string-value",
      toString: "another-string",
      malformed: "malformed-key",
      requestId: "expected-request",
      nonce: "expected-nonce",
    });
  });

  it("clears a stored before-script from a different page origin", () => {
    const context = createContext({
      URL,
      location: new URL("https://source.test"),
      name: "__norea_script__=" + encodeURIComponent("globalThis.executed = true") +
        "&__norea_origin__=" + encodeURIComponent("https://foreign.test"),
      document: { readyState: "loading", addEventListener() {} },
      executed: false,
    });
    context.window = context;
    runInContext(withAppUrl(androidInitialization), context);
    expect(context.executed).toBe(false);
    expect(context.name).toBe("");
  });

  it("runs a same-origin stored before-script in the page realm", () => {
    const context = createContext({
      URL,
      location: new URL("https://source.test"),
      name: "__norea_script__=" + encodeURIComponent("globalThis.executed = true") +
        "&__norea_origin__=" + encodeURIComponent("https://source.test"),
      document: { readyState: "loading", addEventListener() {} },
      executed: false,
    });
    context.window = context;
    runInContext(withAppUrl(androidInitialization), context);
    expect(context.executed).toBe(true);
    expect(context.__TAURI_INTERNALS__).toBeUndefined();
  });
});
