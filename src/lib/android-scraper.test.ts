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
  androidScraperNavigate,
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
}

function installScraperBridge() {
  const navigate = vi.fn();
  const cancel = vi.fn();
  vi.stubGlobal("window", {
    __NoreaAndroidScraper: {
      cancel,
      clearCache: vi.fn(),
      clearCookies: vi.fn(),
      currentOrigin: vi.fn(),
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
    });
    expect(payload).not.toHaveProperty("resetHistory");

    window.__noreaAndroidScraperResolve?.(
      payload.id,
      JSON.stringify({ ok: true, result: true }),
    );

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

    await rejection;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(JSON.parse(cancel.mock.calls[0][0] as string)).toMatchObject({
      id: payload.id,
    });
  });
});

describe("Android scraper browser state", () => {
  beforeEach(() => {
    installScraperBridge();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

const ANDROID_BRIDGE_SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/AndroidScraperBridge.kt",
);

function androidBridgeScript(name: string): string {
  const source = readFileSync(ANDROID_BRIDGE_SOURCE, "utf8");
  const match = source.match(
    new RegExp(`private val ${name} = """\\n([\\s\\S]*?)\\n\\s*"""\\.trimIndent\\(\\)`),
  );
  if (!match?.[1]) throw new Error(`${name} was not found in AndroidScraperBridge.kt`);
  return match[1];
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
    pathname: "/novel/1",
    search: "?p=2",
  };
  const window: Record<string, unknown> = { name: document.name ?? "" };
  runInNewContext(androidBridgeScript("INIT_SCRIPT"), {
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
    runInNewContext(androidBridgeScript("CLEAR_EXTRACT_BRIDGE_SCRIPT"), { window: armed });
    expect(armed.name).toBe("");

    const unrelated: Record<string, unknown> = { name: "adframe" };
    runInNewContext(androidBridgeScript("CLEAR_EXTRACT_BRIDGE_SCRIPT"), { window: unrelated });
    expect(unrelated.name).toBe("adframe");
  });
});
