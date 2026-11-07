import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tauri-runtime", () => ({
  isAndroidRuntime: () => true,
}));

import {
  androidScraperClearCache,
  androidScraperClearCookies,
  androidScraperCurrentOrigin,
  androidScraperCurrentUrl,
  androidScraperNavigate,
  androidScraperResetSiteData,
  androidWebviewFetch,
  androidWebviewExtract,
} from "./android-scraper";

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);

interface NavigatePayload {
  id: string;
  sourceId: string;
  timeoutMs: number;
  url: string;
  userAgent: string | null;
  forceNavigation: boolean;
}

function installScraperBridge() {
  const navigate = vi.fn();
  const cancel = vi.fn();
  vi.stubGlobal("window", {
    __NoreaAndroidScraper: {
      cancel,
      clearCache: vi.fn(),
      clearCookies: vi.fn(),
      resetSiteData: vi.fn(),
      canResetSiteData: () => true,
      currentOrigin: vi.fn(),
      currentUrl: vi.fn(),
      extract: vi.fn(),
      fetch: vi.fn(),
      hide: vi.fn(),
      navigate,
      setBounds: vi.fn(),
    },
    clearTimeout: nativeClearTimeout,
    setTimeout: nativeSetTimeout,
  });
  return { cancel, navigate };
}

function navigatePayload(navigate: ReturnType<typeof vi.fn>): NavigatePayload {
  return JSON.parse(navigate.mock.calls[0][0] as string) as NavigatePayload;
}

describe("Android scraper navigation", () => {
  beforeEach(() => {
    installScraperBridge();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("waits for the native page-finished result", async () => {
    const navigate = vi.mocked(window.__NoreaAndroidScraper!.navigate);
    let settled = false;
    const navigation = androidScraperNavigate(
      "source-a",
      "https://example.com/chapter",
      "Norea/Test",
      { timeoutMs: 12_000 },
    ).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();

    expect(settled).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
    const payload = navigatePayload(navigate);
    expect(payload).toMatchObject({
      sourceId: "source-a",
      timeoutMs: 12_000,
      url: "https://example.com/chapter",
      userAgent: "Norea/Test",
      forceNavigation: false,
    });
    expect(payload).not.toHaveProperty("resetHistory");

    window.__noreaAndroidScraperResolve?.(
      payload.id,
      JSON.stringify({ ok: true, result: true }),
    );

    await expect(navigation).resolves.toBe(true);
  });

  it("passes explicit navigation intent to the native bridge without another action", async () => {
    const navigate = vi.mocked(window.__NoreaAndroidScraper!.navigate);
    const navigation = androidScraperNavigate(
      "source-a", "https://example.com/chapter", null, { forceNavigation: true },
    );
    expect(navigate).toHaveBeenCalledOnce();
    const payload = navigatePayload(navigate);
    expect(payload.forceNavigation).toBe(true);
    window.__noreaAndroidScraperResolve?.(payload.id, JSON.stringify({ ok: true, result: true }));
    await expect(navigation).resolves.toBe(true);
  });

  it("cancels the native navigation when its signal is aborted", async () => {
    const bridge = window.__NoreaAndroidScraper!;
    const navigate = vi.mocked(bridge.navigate);
    const cancel = vi.mocked(bridge.cancel!);
    const controller = new AbortController();
    const navigation = androidScraperNavigate(
      "source-a",
      "https://example.com/chapter",
      null,
      { signal: controller.signal },
    );
    const rejection = expect(navigation).rejects.toMatchObject({
      name: "AbortError",
    });
    const payload = navigatePayload(navigate);

    controller.abort();
    // The global dispatch lease remains held until native cancellation settles.
    window.__noreaAndroidScraperResolve?.(payload.id, JSON.stringify({ ok: false, error: "cancelled" }));

    await rejection;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(JSON.parse(cancel.mock.calls[0][0] as string)).toMatchObject({
      id: payload.id,
    });
  });
});

describe("shared-profile site dispatch", () => {
  beforeEach(() => { installScraperBridge(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("serializes different queues and sources through native completion", async () => {
    const native = window.__NoreaAndroidScraper!;
    const first = androidWebviewExtract("https://one.test/1", null, 1_000, null, "one", "pool:0");
    const second = androidWebviewFetch("https://two.test/2", {}, null, null, "two", "search:0", 1_000);
    expect(native.extract).toHaveBeenCalledOnce();
    expect(native.fetch).not.toHaveBeenCalled();
    const firstId = JSON.parse(vi.mocked(native.extract).mock.calls[0][0]).id;
    window.__noreaAndroidScraperResolve?.(firstId, JSON.stringify({ ok: true, result: "chapter" }));
    await expect(first).resolves.toBe("chapter");
    expect(native.fetch).toHaveBeenCalledOnce();
    const secondId = JSON.parse(vi.mocked(native.fetch).mock.calls[0][0]).id;
    window.__noreaAndroidScraperResolve?.(secondId, JSON.stringify({ ok: true, result: { status: 200 } }));
    await expect(second).resolves.toMatchObject({ status: 200 });
  });

  it("cancels a queued operation without issuing it or cancelling the active operation", async () => {
    const native = window.__NoreaAndroidScraper!;
    const first = androidWebviewExtract("https://one.test/1", null, 1_000, null, "one", "pool:0");
    const controller = new AbortController();
    const second = androidScraperNavigate("two", "https://two.test", null, { signal: controller.signal });
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(native.navigate).not.toHaveBeenCalled();
    expect(native.cancel).not.toHaveBeenCalled();
    window.__noreaAndroidScraperResolve?.(JSON.parse(vi.mocked(native.extract).mock.calls[0][0]).id,
      JSON.stringify({ ok: true, result: "chapter" }));
    await first;
  });

  it("waits for active cancellation cleanup before dispatching another source", async () => {
    const native = window.__NoreaAndroidScraper!;
    const controller = new AbortController();
    const first = androidScraperNavigate("one", "https://one.test", null, { signal: controller.signal });
    const rejection = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = androidWebviewExtract("https://two.test", null, 1_000, null, "two", "pool:0");
    controller.abort();
    expect(native.cancel).toHaveBeenCalledOnce();
    expect(native.extract).not.toHaveBeenCalled();
    window.__noreaAndroidScraperResolve?.(JSON.parse(vi.mocked(native.navigate).mock.calls[0][0]).id,
      JSON.stringify({ ok: false, error: "native cleanup complete" }));
    await rejection;
    expect(native.extract).toHaveBeenCalledOnce();
    window.__noreaAndroidScraperResolve?.(JSON.parse(vi.mocked(native.extract).mock.calls[0][0]).id,
      JSON.stringify({ ok: true, result: "chapter" }));
    await second;
  });

  it("gates site-data reset behind the previous request and awaits its callback", async () => {
    const native = window.__NoreaAndroidScraper!;
    const first = androidWebviewExtract("https://one.test", null, 1_000, null, "one", "pool:0");
    const reset = androidScraperResetSiteData("https://one.test", "one");
    expect(native.resetSiteData).not.toHaveBeenCalled();
    window.__noreaAndroidScraperResolve?.(JSON.parse(vi.mocked(native.extract).mock.calls[0][0]).id,
      JSON.stringify({ ok: true, result: "chapter" }));
    await first;
    expect(native.resetSiteData).toHaveBeenCalledOnce();
    const payload = JSON.parse(vi.mocked(native.resetSiteData!).mock.calls[0][0]);
    expect(payload).toMatchObject({ url: "https://one.test", sourceId: "one" });
    window.__noreaAndroidScraperResolve?.(payload.id, JSON.stringify({ ok: true, result: true }));
    await reset;
  });
});

describe("Android scraper browser state", () => {
  beforeEach(() => {
    installScraperBridge();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the current address from the source-owned native WebView", async () => {
    const currentUrl = vi.mocked(window.__NoreaAndroidScraper!.currentUrl);
    const reading = androidScraperCurrentUrl("source-a");
    const payload = JSON.parse(currentUrl.mock.calls[0][0] as string) as {
      id: string;
      sourceId: string;
    };
    expect(payload.sourceId).toBe("source-a");
    window.__noreaAndroidScraperResolve?.(
      payload.id,
      JSON.stringify({ ok: true, result: "https://example.com/chapter/2#part" }),
    );
    await expect(reading).resolves.toBe("https://example.com/chapter/2#part");
  });

  it("reads the current origin from the native WebView", async () => {
    const currentOrigin = vi.mocked(
      window.__NoreaAndroidScraper!.currentOrigin,
    );
    const reading = androidScraperCurrentOrigin("source-a");
    const payload = JSON.parse(currentOrigin.mock.calls[0][0] as string) as {
      id: string;
      sourceId: string;
    };
    expect(payload.sourceId).toBe("source-a");

    window.__noreaAndroidScraperResolve?.(
      payload.id,
      JSON.stringify({
        ok: true,
        result: "https://redirected.example:8443",
      }),
    );

    await expect(reading).resolves.toBe("https://redirected.example:8443");
  });
});

describe("Android scraper cookie clearing", () => {
  beforeEach(() => {
    installScraperBridge();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the plugin URL and resolves the deleted cookie count", async () => {
    const clearCookies = vi.mocked(
      window.__NoreaAndroidScraper!.clearCookies,
    );
    const clearing = androidScraperClearCookies(
      "source-a",
      "https://example.com/",
      "pool:0",
    );
    const payload = JSON.parse(
      clearCookies.mock.calls[0][0] as string,
    ) as { id: string; queue: string; sourceId: string; url: string };

    expect(payload).toMatchObject({
      queue: "pool:0",
      sourceId: "source-a",
      url: "https://example.com/",
    });
    window.__noreaAndroidScraperResolve?.(
      payload.id,
      JSON.stringify({ ok: true, result: 3 }),
    );

    await expect(clearing).resolves.toBe(3);
  });
});

describe("Android scraper cache clearing", () => {
  beforeEach(() => {
    installScraperBridge();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves after the native WebView cache is cleared", async () => {
    const clearCache = vi.mocked(window.__NoreaAndroidScraper!.clearCache);
    const clearing = androidScraperClearCache();
    const payload = JSON.parse(clearCache.mock.calls[0][0] as string) as {
      id: string;
    };

    window.__noreaAndroidScraperResolve?.(
      payload.id,
      JSON.stringify({ ok: true, result: null }),
    );

    await expect(clearing).resolves.toBeUndefined();
  });

});

describe("Android scraper extraction", () => {
  beforeEach(() => {
    installScraperBridge();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards chapter extraction without a host cache policy", async () => {
    const extract = vi.mocked(window.__NoreaAndroidScraper!.extract);
    const extraction = androidWebviewExtract(
      "https://example.com/chapter/1",
      "window.prepareChapter();",
      12_000,
      "Norea/Test",
      "source-a",
      "pool:1",
    );
    const payload = JSON.parse(extract.mock.calls[0][0] as string) as {
      beforeScript: string;
      id: string;
      sourceId: string;
      url: string;
    };

    expect(payload).toMatchObject({
      beforeScript: "window.prepareChapter();",
      sourceId: "source-a",
      url: "https://example.com/chapter/1",
    });
    expect(payload).not.toHaveProperty("pageCachePolicy");
    window.__noreaAndroidScraperResolve?.(
      payload.id,
      JSON.stringify({ ok: true, result: "captured" }),
    );

    await expect(extraction).resolves.toBe("captured");
  });

});

const ANDROID_SCRAPER_SCRIPT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src-tauri/gen/android/app/src/main/res/raw",
);

function androidBridgeScript(name: string): string {
  return readFileSync(path.join(ANDROID_SCRAPER_SCRIPT_DIR, `${name}.js`), "utf8");
}

interface BridgeDocument {
  hash?: string;
  name?: string;
  origin?: string;
}

function loadBridgeDocument(document: BridgeDocument) {
  const posts: Array<{ id: string; nonce: string; payload: string }> = [];
  const legacyPosts: string[] = [];
  const evaluated: string[] = [];
  const replacedUrls: string[] = [];
  const location = {
    hash: document.hash ?? "",
    origin: document.origin ?? "https://source.test",
    protocol: new URL(document.origin ?? "https://source.test").protocol,
    hostname: new URL(document.origin ?? "https://source.test").hostname,
    pathname: "/novel/1",
    search: "?p=2",
  };
  const window: Record<string, unknown> = { name: document.name ?? "" };
  const init = androidBridgeScript("norea_scraper_init").replaceAll(
    "__NOREA_APP_ORIGIN_JSON__", JSON.stringify("https://tauri.localhost"),
  );
  runInNewContext(init, {
    AndroidScraper: {
      postExtractResult: (payload: string) => {
        legacyPosts.push(payload);
      },
      postExtractResultWithNonce: (id: string, nonce: string, payload: string) => {
        posts.push({ id, nonce, payload });
      },
    },
    __evaluated: evaluated,
    decodeURIComponent,
    encodeURIComponent,
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        location.hash = "";
        replacedUrls.push(url);
      },
    },
    location,
    window,
  });
  const postMessage = (
    window.ReactNativeWebView as { postMessage: (payload: string) => void }
  ).postMessage;
  return { evaluated, legacyPosts, postMessage, posts, replacedUrls, window };
}

describe("Android scraper bridge init script", () => {
  const script =
    '__evaluated.push(location.pathname); window.ReactNativeWebView.postMessage("result:" + location.pathname);';
  const hash =
    `#__norea_script__=${encodeURIComponent(script)}` +
    "&__norea_request_id__=android-scraper-7&__norea_nonce__=nonce-7";

  it("arms the request from the URL hash and keeps it for later same-site documents", () => {
    const first = loadBridgeDocument({ hash });

    expect(first.evaluated).toEqual(["/novel/1"]);
    expect(first.posts).toEqual([
      { id: "android-scraper-7", nonce: "nonce-7", payload: "result:/novel/1" },
    ]);
    expect(first.replacedUrls).toEqual(["/novel/1?p=2"]);
    expect(String(first.window.name)).toMatch(/^__norea_script__=/);
    expect(String(first.window.name)).toContain(
      `&__norea_origin__=${encodeURIComponent("https://source.test")}`,
    );

    const second = loadBridgeDocument({ name: String(first.window.name) });

    expect(second.evaluated).toEqual(["/novel/1"]);
    expect(second.posts).toEqual([
      { id: "android-scraper-7", nonce: "nonce-7", payload: "result:/novel/1" },
    ]);
    expect(second.replacedUrls).toEqual([]);
    expect(second.window.name).toBe(first.window.name);
  });

  it("drops the armed request before a foreign-origin document can use it", () => {
    const armed = loadBridgeDocument({ hash });

    const foreign = loadBridgeDocument({
      name: String(armed.window.name),
      origin: "https://evil.test",
    });

    expect(foreign.evaluated).toEqual([]);
    expect(foreign.posts).toEqual([]);
    expect(foreign.window.name).toBe("");
    foreign.postMessage("forged");
    expect(foreign.posts).toEqual([]);
    expect(foreign.legacyPosts).toEqual(["forged"]);
  });

  it("ignores unrelated window names and falls back to the legacy result bridge", () => {
    const document = loadBridgeDocument({ name: "adframe" });

    expect(document.evaluated).toEqual([]);
    expect(document.window.name).toBe("adframe");
    document.postMessage("late");
    expect(document.posts).toEqual([]);
    expect(document.legacyPosts).toEqual(["late"]);
  });

  it("clears only bridge-owned window names when an extract finishes", () => {
    const armed: Record<string, unknown> = { name: "__norea_script__=abc&__norea_request_id__=x" };
    runInNewContext(androidBridgeScript("norea_scraper_clear_extract"), { window: armed });
    expect(armed.name).toBe("");

    const unrelated: Record<string, unknown> = { name: "adframe" };
    runInNewContext(androidBridgeScript("norea_scraper_clear_extract"), { window: unrelated });
    expect(unrelated.name).toBe("adframe");
  });
});
