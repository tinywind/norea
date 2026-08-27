import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("./tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(() => false),
  isWindowsRuntime: vi.fn(() => true),
}));
import { invoke } from "@tauri-apps/api/core";
import { isAndroidRuntime, isWindowsRuntime } from "./tauri-runtime";
import {
  appFetchText,
  pluginFetch,
  pluginFetchText,
  pluginMediaFetch,
  takeCapturedMediaHandle,
} from "./http";
import { isSourceAccessRequiredError } from "./plugins/source-access";

const invokeMock = vi.mocked(invoke);
const isAndroidRuntimeMock = vi.mocked(isAndroidRuntime);
const isWindowsRuntimeMock = vi.mocked(isWindowsRuntime);

beforeEach(() => {
  invokeMock.mockReset();
  isAndroidRuntimeMock.mockReturnValue(false);
  isWindowsRuntimeMock.mockReturnValue(true);
});

function wireOk(
  body: string,
  overrides: Partial<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    finalUrl: string;
  }> = {},
): unknown {
  return {
    status: overrides.status ?? 200,
    statusText: overrides.statusText ?? "OK",
    bodyBase64: btoa(body),
    headers: overrides.headers ?? { "content-type": "text/plain" },
    finalUrl: overrides.finalUrl ?? "https://ok.test/",
  };
}

function appFetchBody(body: string): number[] {
  return [...new TextEncoder().encode(body), 1];
}

function mockAppFetch(
  body: string,
  overrides: Partial<{
    status: number;
    statusText: string;
    headers: HeadersInit;
    url: string;
  }> = {},
): void {
  invokeMock
    .mockResolvedValueOnce(100)
    .mockResolvedValueOnce({
      status: overrides.status ?? 200,
      statusText: overrides.statusText ?? "OK",
      url: overrides.url ?? "https://ok.test/",
      headers: overrides.headers ?? { "content-type": "text/plain" },
      rid: 101,
    })
    .mockResolvedValueOnce(appFetchBody(body));
}

describe("appFetchText", () => {
  it("passes credential URLs to low-level app fetch without rewriting them", async () => {
    const url =
      "https://x-access-token:ghp_secret@raw.githubusercontent.com/owner/repo/branch/plugins.json";
    mockAppFetch("[]", {
      headers: { "content-type": "application/json" },
      url,
    });

    await expect(appFetchText(url)).resolves.toBe("[]");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "plugin:http|fetch", {
      clientConfig: {
        data: null,
        headers: [],
        method: "GET",
        url,
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "plugin:http|fetch_send", {
      rid: 100,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(
      3,
      "plugin:http|fetch_read_body",
      { rid: 101 },
    );
  });

  it("rebuilds the app fetch response and preserves the final URL", async () => {
    mockAppFetch("ok", { url: "https://example.test/after.js" });

    await expect(appFetchText("https://example.test/plugin.js")).resolves.toBe(
      "ok",
    );

    expect(invokeMock).toHaveBeenNthCalledWith(1, "plugin:http|fetch", {
      clientConfig: {
        data: null,
        headers: [],
        method: "GET",
        url: "https://example.test/plugin.js",
      },
    });
  });

  it("throws on a non-2xx app fetch response with a status-aware message", async () => {
    mockAppFetch("missing", {
      status: 404,
      statusText: "Not Found",
      headers: { "content-type": "text/plain" },
      url: "https://example.test/missing.js",
    });

    await expect(
      appFetchText("https://example.test/missing.js"),
    ).rejects.toThrow(
      /HTTP 404 Not Found on https:\/\/example\.test$/,
    );
  });
});

describe("pluginFetch", () => {
  it("forwards url + init to the webview_fetch IPC and rebuilds a Response", async () => {
    invokeMock.mockResolvedValueOnce(wireOk("hello"));

    const response = await pluginFetch("https://ok.test/", {
      method: "POST",
      headers: { "X-Custom": "1" },
      body: "payload",
      sourceId: "source-a",
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, args] = invokeMock.mock.calls[0]!;
    expect(command).toBe("webview_fetch");
    expect(args).toEqual({
      url: "https://ok.test/",
      init: {
        method: "POST",
        headers: expect.objectContaining({ "X-Custom": "1" }),
        body: "payload",
      },
      contextUrl: null,
      queue: "immediate",
      sourceId: "source-a",
      timeoutMs: 30_000,
      userAgent: globalThis.navigator?.userAgent ?? null,
    });

    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    expect(await response.text()).toBe("hello");
  });

  it("preserves binary response bodies from webview_fetch", async () => {
    invokeMock.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      bodyBase64: "AP9QSwME",
      headers: { "content-type": "application/zip" },
      finalUrl: "https://ok.test/archive.zip",
    });

    const response = await pluginFetch("https://ok.test/archive.zip");

    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
      0, 255, 80, 75, 3, 4,
    ]);
  });

  it("preserves the final URL on the rebuilt Response", async () => {
    invokeMock.mockResolvedValueOnce(
      wireOk("redirected", { finalUrl: "https://ok.test/after-redirect" }),
    );

    const response = await pluginFetch("https://ok.test/before");
    expect(response.url).toBe("https://ok.test/after-redirect");
  });

  it("forwards the optional scraper context URL", async () => {
    invokeMock.mockResolvedValueOnce(wireOk("hello"));

    await pluginFetch("https://ok.test/path", {
      contextUrl: "https://ok.test",
    });

    expect(invokeMock).toHaveBeenCalledWith("webview_fetch", {
      url: "https://ok.test/path",
      init: {
        headers: undefined,
        method: undefined,
        body: undefined,
      },
      contextUrl: "https://ok.test",
      queue: "immediate",
      timeoutMs: 30_000,
      userAgent: globalThis.navigator?.userAgent ?? null,
    });
  });

  it("uses an explicit User-Agent header as the scraper user agent", async () => {
    invokeMock.mockResolvedValueOnce(wireOk("hello"));

    await pluginFetch("https://ok.test/path", {
      headers: { "User-Agent": "Plugin UA" },
    });

    expect(invokeMock).toHaveBeenCalledWith("webview_fetch", {
      url: "https://ok.test/path",
      init: {
        headers: { "User-Agent": "Plugin UA" },
        method: undefined,
        body: undefined,
      },
      contextUrl: null,
      queue: "immediate",
      timeoutMs: 30_000,
      userAgent: "Plugin UA",
    });
  });

  it("forwards an explicit source request timeout to the scraper IPC", async () => {
    invokeMock.mockResolvedValueOnce(wireOk("hello"));

    await pluginFetch("https://ok.test/path", {
      timeoutMs: 12_345,
    });

    expect(invokeMock).toHaveBeenCalledWith("webview_fetch", {
      url: "https://ok.test/path",
      init: {
        headers: undefined,
        method: undefined,
        body: undefined,
      },
      contextUrl: null,
      queue: "immediate",
      timeoutMs: 12_345,
      userAgent: globalThis.navigator?.userAgent ?? null,
    });
  });

  it("surfaces non-2xx status as a Response with ok=false", async () => {
    invokeMock.mockResolvedValueOnce(
      wireOk("not found", { status: 404, statusText: "Not Found" }),
    );

    const response = await pluginFetch("https://ok.test/missing");
    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
  });

  it("turns an explicit Cloudflare mitigation response into an access challenge", async () => {
    invokeMock.mockResolvedValueOnce(
      wireOk("Just a moment...", {
        status: 403,
        statusText: "Forbidden",
        headers: {
          "cf-mitigated": "challenge",
          "content-type": "text/html",
        },
        finalUrl: "https://ok.test/cdn-cgi/challenge-platform/",
      }),
    );

    const request = pluginFetch("https://ok.test/chapter/1");

    await expect(request).rejects.toSatisfy(
      (error: unknown) =>
        isSourceAccessRequiredError(error) &&
        error.challenge.kind === "cloudflare" &&
        error.challenge.url ===
          "https://ok.test/cdn-cgi/challenge-platform/",
    );
  });

  it("recognizes a Cloudflare browser challenge page without relying on status alone", async () => {
    invokeMock.mockResolvedValueOnce(
      wireOk(
        '<html><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script></html>',
        {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "content-type": "text/html" },
        },
      ),
    );

    await expect(pluginFetch("https://ok.test/chapter/1")).rejects.toSatisfy(
      isSourceAccessRequiredError,
    );
  });

  it("does not classify a bare 403 response as Cloudflare verification", async () => {
    invokeMock.mockResolvedValueOnce(
      wireOk("forbidden", { status: 403, statusText: "Forbidden" }),
    );

    const response = await pluginFetch("https://ok.test/private");

    expect(response.status).toBe(403);
  });

  it("cancels the desktop scraper executor when the request signal aborts", async () => {
    const controller = new AbortController();
    invokeMock.mockImplementation(async (command) => {
      if (command === "webview_fetch") {
        return await new Promise<never>(() => undefined);
      }
      if (command === "scraper_cancel_executor") return true;
      throw new Error(`Unexpected command: ${String(command)}`);
    });

    const request = pluginFetch("https://ok.test/slow", {
      scraperExecutor: "pool:0",
      signal: controller.signal,
    });
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(invokeMock).toHaveBeenCalledWith("scraper_cancel_executor", {
      message: "Request cancelled",
      queue: "pool:0",
    });
  });

  it("propagates an IPC rejection so the global toast can fire", async () => {
    invokeMock.mockRejectedValueOnce(new Error("scraper not ready"));
    await expect(pluginFetch("https://ok.test/")).rejects.toThrow(
      "scraper not ready",
    );
  });

  it("redacts request secrets from persisted fetch failure logs", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockRejectedValueOnce(
      new Error(
        "scraper failed for https://source.test/chapter/1?errorToken=secret#proof",
      ),
    );

    try {
      await expect(
        pluginFetch(
          "https://user:password@source.test/chapter/1?requestToken=secret#proof",
          {
            contextUrl:
              "https://source.test/novel/1?contextToken=secret#proof",
          },
        ),
      ).rejects.toThrow("scraper failed");

      expect(errorSpy).toHaveBeenCalledWith("[plugin-fetch] failed", {
        contextUrl: "https://source.test",
        error: "scraper failed for https://source.test",
        scraperExecutor: "immediate",
        sourceId: undefined,
        url: "https://source.test",
      });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("pluginMediaFetch", () => {
  it("propagates a Cloudflare challenge from captured media without falling back", async () => {
    invokeMock.mockResolvedValueOnce(
      wireOk("Just a moment...", {
        status: 403,
        statusText: "Forbidden",
        headers: {
          "cf-mitigated": "challenge",
          "content-type": "text/html",
        },
        finalUrl: "https://cdn.test/cdn-cgi/challenge-platform/",
      }),
    );

    const request = pluginMediaFetch("https://cdn.test/page.png", {
      contextUrl: "https://source.test/chapter/1",
      preferBrowserCache: true,
      scraperExecutor: "pool:1",
      sourceId: "source-a",
    });

    await expect(request).rejects.toSatisfy(
      (error: unknown) =>
        isSourceAccessRequiredError(error) &&
        error.challenge.kind === "cloudflare" &&
        error.challenge.url === "https://source.test/chapter/1",
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      "scraper_take_captured_resource",
      {
        queue: "pool:1",
        sourceId: "source-a",
        url: "https://cdn.test/page.png",
      },
    );
  });

  it("propagates a Cloudflare challenge from native-first media without falling back", async () => {
    invokeMock.mockResolvedValueOnce(
      wireOk("Just a moment...", {
        status: 403,
        statusText: "Forbidden",
        headers: {
          "cf-mitigated": "challenge",
          "content-type": "text/html",
        },
        finalUrl: "https://cdn.test/cdn-cgi/challenge-platform/",
      }),
    );

    const request = pluginMediaFetch("https://cdn.test/page.png", {
      contextUrl: "https://source.test/chapter/1",
      scraperExecutor: "pool:1",
      sourceId: "source-a",
    });

    await expect(request).rejects.toSatisfy(isSourceAccessRequiredError);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      "scraper_media_fetch",
      expect.objectContaining({ url: "https://cdn.test/page.png" }),
    );
  });

  it("propagates a Cloudflare challenge from browser-first media without falling back", async () => {
    invokeMock.mockResolvedValueOnce(
      wireOk("Just a moment...", {
        status: 403,
        statusText: "Forbidden",
        headers: {
          "cf-mitigated": "challenge",
          "content-type": "text/html",
        },
        finalUrl: "https://cdn.test/cdn-cgi/challenge-platform/",
      }),
    );

    const request = pluginMediaFetch("https://cdn.test/page.png", {
      contextUrl: "https://cdn.test/assets/",
      scraperExecutor: "pool:1",
      sourceId: "source-a",
      sourceAccessUrl: "https://source.test/chapter/1",
    });

    await expect(request).rejects.toSatisfy(
      (error: unknown) =>
        isSourceAccessRequiredError(error) &&
        error.challenge.url === "https://source.test/chapter/1",
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      "webview_fetch",
      expect.objectContaining({
        contextUrl: "https://cdn.test/assets/",
        url: "https://cdn.test/page.png",
      }),
    );
  });

  it("propagates a Cloudflare challenge from the native media fallback", async () => {
    invokeMock
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce(
        wireOk("Just a moment...", {
          status: 403,
          statusText: "Forbidden",
          headers: {
            "cf-mitigated": "challenge",
            "content-type": "text/html",
          },
          finalUrl: "https://source.test/cdn-cgi/challenge-platform/",
        }),
      );

    const request = pluginMediaFetch("https://source.test/page.png", {
      contextUrl: "https://source.test/chapter/1",
      scraperExecutor: "pool:1",
      sourceId: "source-a",
    });

    await expect(request).rejects.toSatisfy(isSourceAccessRequiredError);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "scraper_media_fetch",
      expect.objectContaining({ url: "https://source.test/page.png" }),
    );
  });

  it("takes a captured Windows response as a native body handle", async () => {
    invokeMock.mockResolvedValueOnce({
      bodyBytes: 3,
      bodyHandle: "captured-media-1",
      finalUrl: "https://cdn.test/page.png",
      headers: { "content-type": "image/png" },
      status: 200,
      statusText: "OK",
    });

    await expect(
      takeCapturedMediaHandle("https://cdn.test/page.png", {
        contextUrl: "https://source.test/chapter/1",
        preferBrowserCache: true,
        scraperExecutor: "pool:1",
        sourceId: "source-a",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        bodyBytes: 3,
        bodyHandle: "captured-media-1",
      }),
    );

    expect(invokeMock).toHaveBeenCalledWith(
      "scraper_take_captured_resource_handle",
      {
        queue: "pool:1",
        sourceId: "source-a",
        url: "https://cdn.test/page.png",
      },
    );
  });

  it("propagates an explicit Cloudflare challenge from a captured body handle", async () => {
    invokeMock.mockResolvedValueOnce({
      bodyBytes: 20,
      bodyHandle: "captured-media-1",
      finalUrl: "https://cdn.test/cdn-cgi/challenge-platform/",
      headers: {
        "cf-mitigated": "challenge",
        "content-type": "text/html",
      },
      status: 403,
      statusText: "Forbidden",
    });

    const request = takeCapturedMediaHandle("https://cdn.test/page.png", {
      contextUrl: "https://source.test/chapter/1",
      preferBrowserCache: true,
      scraperExecutor: "pool:1",
      sourceId: "source-a",
    });

    await expect(request).rejects.toSatisfy(
      (error: unknown) =>
        isSourceAccessRequiredError(error) &&
        error.challenge.url === "https://source.test/chapter/1",
    );
    expect(invokeMock).toHaveBeenNthCalledWith(2, "native_stream_cancel", {
      handle: "captured-media-1",
    });
  });

  it("propagates a sniffed Cloudflare challenge from a captured body handle", async () => {
    invokeMock.mockResolvedValueOnce({
      bodyBytes: 20,
      bodyHandle: "captured-media-2",
      cloudflareChallenge: true,
      finalUrl: "https://cdn.test/page.png",
      headers: {},
      status: 200,
      statusText: "OK",
    });

    const request = takeCapturedMediaHandle("https://cdn.test/page.png", {
      contextUrl: "https://source.test/chapter/1",
      preferBrowserCache: true,
      scraperExecutor: "pool:1",
      sourceId: "source-a",
    });

    await expect(request).rejects.toSatisfy(
      (error: unknown) =>
        isSourceAccessRequiredError(error) &&
        error.challenge.url === "https://source.test/chapter/1",
    );
    expect(invokeMock).toHaveBeenNthCalledWith(2, "native_stream_cancel", {
      handle: "captured-media-2",
    });
  });

  it("uses native media fetch first when media and context hosts differ", async () => {
    const debugSpy = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);
    invokeMock.mockResolvedValueOnce(
      wireOk("image", {
        finalUrl: "https://novel-phinf.pstatic.net/page.png",
        headers: { "content-type": "image/png" },
      }),
    );

    try {
      const response = await pluginMediaFetch(
        "https://novel-phinf.pstatic.net/page.png",
        {
          contextUrl: "https://novel.naver.com/webnovel/detail",
          headers: {
            Referer: "https://novel.naver.com/",
          },
          timeoutMs: 12_345,
        },
      );

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock).toHaveBeenCalledWith("scraper_media_fetch", {
        url: "https://novel-phinf.pstatic.net/page.png",
        init: {
          headers: {
            Referer: "https://novel.naver.com/",
          },
          method: undefined,
          body: undefined,
        },
        timeoutMs: 12_345,
        userAgent: globalThis.navigator?.userAgent ?? null,
      });
      expect(debugSpy).toHaveBeenCalledWith(
        "[plugin-media-fetch] native fetch started",
        expect.objectContaining({
          contextHost: "novel.naver.com",
          host: "novel-phinf.pstatic.net",
          sanitizedUrl: "https://novel-phinf.pstatic.net",
        }),
      );
      expect(debugSpy).toHaveBeenCalledWith(
        "[plugin-media-fetch] native fetch finished",
        expect.objectContaining({
          host: "novel-phinf.pstatic.net",
          status: 200,
        }),
      );
      expect(await response.text()).toBe("image");
    } finally {
      debugSpy.mockRestore();
    }
  });

  it("uses the page WebView cache first for captured cross-host media", async () => {
    invokeMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        wireOk("image", {
          finalUrl: "https://cdn.test/page.png?accessKey=signed",
          headers: { "content-type": "image/png" },
        }),
      );

    const response = await pluginMediaFetch(
      "https://cdn.test/page.png?accessKey=signed",
      {
        contextUrl: "https://source.test/chapter/1",
        preferBrowserCache: true,
        scraperExecutor: "pool:1",
        sourceId: "source-a",
      },
    );

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "scraper_take_captured_resource",
      {
        url: "https://cdn.test/page.png?accessKey=signed",
        queue: "pool:1",
        sourceId: "source-a",
      },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(2, "webview_fetch", {
      url: "https://cdn.test/page.png?accessKey=signed",
      init: {
        headers: undefined,
        method: undefined,
        body: undefined,
        preferBrowserCache: true,
      },
      contextUrl: "https://source.test/chapter/1",
      queue: "pool:1",
      sourceId: "source-a",
      timeoutMs: 30_000,
      userAgent: globalThis.navigator?.userAgent ?? null,
    });
    expect(await response.text()).toBe("image");
  });

  it("falls back to native media after a Windows cache fetch is rejected", async () => {
    invokeMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        wireOk("blocked", {
          status: 403,
          statusText: "Forbidden",
          finalUrl: "https://newtoki-cdn.test/page.css",
        }),
      )
      .mockResolvedValueOnce(
        wireOk("image", {
          finalUrl: "https://newtoki-cdn.test/page.css",
          headers: { "content-type": "image/webp" },
        }),
      );

    const response = await pluginMediaFetch(
      "https://newtoki-cdn.test/page.css",
      {
        contextUrl: "https://source.test/webtoon/1",
        headers: { Referer: "https://source.test/" },
        preferBrowserCache: true,
        scraperExecutor: "pool:1",
        sourceId: "newtoki-webtoon",
      },
    );

    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(invokeMock).toHaveBeenNthCalledWith(3, "scraper_media_fetch", {
      url: "https://newtoki-cdn.test/page.css",
      init: {
        headers: { Referer: "https://source.test/" },
        method: undefined,
        body: undefined,
        preferBrowserCache: true,
      },
      timeoutMs: 30_000,
      userAgent: globalThis.navigator?.userAgent ?? null,
    });
    expect(await response.text()).toBe("image");
  });

  it("uses the response body captured during chapter navigation", async () => {
    const debugSpy = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);
    invokeMock.mockResolvedValueOnce(
      wireOk("captured-image", {
        finalUrl: "https://cdn.test/page.png?accessKey=signed",
        headers: { "content-type": "image/png" },
      }),
    );

    try {
      const response = await pluginMediaFetch(
        "https://cdn.test/page.png?accessKey=signed",
        {
          contextUrl: "https://source.test/chapter/1",
          preferBrowserCache: true,
          scraperExecutor: "pool:1",
          sourceId: "source-a",
        },
      );

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock).toHaveBeenCalledWith(
        "scraper_take_captured_resource",
        {
          url: "https://cdn.test/page.png?accessKey=signed",
          queue: "pool:1",
          sourceId: "source-a",
        },
      );
      expect(debugSpy).toHaveBeenCalledWith(
        "[plugin-media-fetch] captured response used",
        expect.objectContaining({
          host: "cdn.test",
          sanitizedUrl: "https://cdn.test",
          status: 200,
        }),
      );
      expect(await response.text()).toBe("captured-image");
    } finally {
      debugSpy.mockRestore();
    }
  });

  it("retries native-first media fetches in the WebView on session-sensitive HTTP errors", async () => {
    const debugSpy = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    invokeMock
      .mockResolvedValueOnce(
        wireOk("blocked", {
          status: 403,
          statusText: "Forbidden",
          finalUrl: "https://image-comic.pstatic.net/page.jpg",
        }),
      )
      .mockResolvedValueOnce(
        wireOk("image", {
          finalUrl: "https://image-comic.pstatic.net/page.jpg",
          headers: { "content-type": "image/jpeg" },
        }),
      );

    try {
      const response = await pluginMediaFetch(
        "https://image-comic.pstatic.net/page.jpg",
        {
          contextUrl: "https://m.comic.naver.com/webtoon/detail",
          headers: {
            Referer: "https://m.comic.naver.com/",
          },
          scraperExecutor: "pool:0",
          sourceId: "naverwebtoon",
        },
      );

      expect(invokeMock).toHaveBeenNthCalledWith(1, "scraper_media_fetch", {
        url: "https://image-comic.pstatic.net/page.jpg",
        init: {
          headers: {
            Referer: "https://m.comic.naver.com/",
          },
          method: undefined,
          body: undefined,
        },
        timeoutMs: 30_000,
        userAgent: globalThis.navigator?.userAgent ?? null,
      });
      expect(invokeMock).toHaveBeenNthCalledWith(2, "webview_fetch", {
        url: "https://image-comic.pstatic.net/page.jpg",
        init: {
          headers: {
            Referer: "https://m.comic.naver.com/",
          },
          method: undefined,
          body: undefined,
        },
        contextUrl: "https://m.comic.naver.com/webtoon/detail",
        queue: "pool:0",
        sourceId: "naverwebtoon",
        timeoutMs: 30_000,
        userAgent: globalThis.navigator?.userAgent ?? null,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        "[plugin-media-fetch] native fetch returned retryable status; trying WebView",
        expect.objectContaining({
          host: "image-comic.pstatic.net",
          nativeError: "HTTP 403 Forbidden",
          scraperExecutor: "pool:0",
          sourceId: "naverwebtoon",
          status: 403,
        }),
      );
      expect(await response.text()).toBe("image");
    } finally {
      debugSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("falls back to native media fetch when the WebView cannot read media bytes", async () => {
    const debugSpy = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    invokeMock
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce(
        wireOk("image", {
          finalUrl: "https://cdn.test/page.png",
          headers: { "content-type": "image/png" },
        }),
      );

    try {
      const response = await pluginMediaFetch("https://cdn.test/page.png", {
        contextUrl: "https://cdn.test/chapter/1",
        headers: {
          Referer: "https://cdn.test/chapter/1",
          "User-Agent": "Plugin UA",
        },
        timeoutMs: 12_345,
      });

      expect(invokeMock).toHaveBeenNthCalledWith(1, "webview_fetch", {
        url: "https://cdn.test/page.png",
        init: {
          headers: {
            Referer: "https://cdn.test/chapter/1",
            "User-Agent": "Plugin UA",
          },
          method: undefined,
          body: undefined,
        },
        contextUrl: "https://cdn.test/chapter/1",
        queue: "immediate",
        timeoutMs: 12_345,
        userAgent: "Plugin UA",
      });
      expect(invokeMock).toHaveBeenNthCalledWith(2, "scraper_media_fetch", {
        url: "https://cdn.test/page.png",
        init: {
          headers: {
            Referer: "https://cdn.test/chapter/1",
            "User-Agent": "Plugin UA",
          },
          method: undefined,
          body: undefined,
        },
        timeoutMs: 12_345,
        userAgent: "Plugin UA",
      });
      expect(debugSpy).toHaveBeenCalledWith(
        "[plugin-media-fetch] browser fetch failed; using native media fetch",
        expect.objectContaining({
          host: "cdn.test",
          sanitizedUrl: "https://cdn.test",
        }),
      );
      expect(debugSpy).toHaveBeenCalledWith(
        "[plugin-media-fetch] native fallback started",
        expect.objectContaining({
          host: "cdn.test",
          sanitizedUrl: "https://cdn.test",
        }),
      );
      expect(debugSpy).toHaveBeenCalledWith(
        "[plugin-media-fetch] native fallback finished",
        expect.objectContaining({
          host: "cdn.test",
          sanitizedUrl: "https://cdn.test",
          status: 200,
        }),
      );
      expect(response.url).toBe("https://cdn.test/page.png");
      expect(await response.text()).toBe("image");
      expect(errorSpy).not.toHaveBeenCalledWith(
        "[plugin-fetch] failed",
        expect.anything(),
      );
    } finally {
      debugSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("includes browser and native failure causes when both media paths fail", async () => {
    const debugSpy = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    invokeMock
      .mockRejectedValueOnce(new Error("browser failed"))
      .mockRejectedValueOnce(new Error("native failed"));

    try {
      await expect(
        pluginMediaFetch("https://cdn.test/page.png?token=secret", {
          contextUrl: "https://cdn.test/chapter",
          sourceId: "source-a",
          scraperExecutor: "pool:1",
        }),
      ).rejects.toThrow(
        "Media fetch failed for https://cdn.test; browser: browser failed; native: native failed",
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "[plugin-media-fetch] native fallback failed",
        expect.objectContaining({
          browserError: "browser failed",
          nativeError: "native failed",
          sanitizedUrl: "https://cdn.test",
          scraperExecutor: "pool:1",
          sourceId: "source-a",
        }),
      );
    } finally {
      debugSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe("pluginFetchText", () => {
  it("returns the body text on a 2xx response", async () => {
    invokeMock.mockResolvedValueOnce(wireOk("body"));
    expect(await pluginFetchText("https://ok.test/")).toBe("body");
  });

  it("throws on a non-2xx response with a status-aware message", async () => {
    invokeMock.mockResolvedValueOnce(
      wireOk("nope", { status: 503, statusText: "Service Unavailable" }),
    );
    await expect(pluginFetchText("https://ok.test/")).rejects.toThrow(
      /HTTP 503 Service Unavailable on https:\/\/ok\.test$/,
    );
  });
});
