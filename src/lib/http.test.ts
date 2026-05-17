import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("./tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(() => false),
}));
import { invoke } from "@tauri-apps/api/core";
import { isAndroidRuntime } from "./tauri-runtime";
import {
  appFetchText,
  pluginFetch,
  pluginFetchText,
  pluginMediaFetch,
} from "./http";

const invokeMock = vi.mocked(invoke);
const isAndroidRuntimeMock = vi.mocked(isAndroidRuntime);

beforeEach(() => {
  invokeMock.mockReset();
  isAndroidRuntimeMock.mockReturnValue(false);
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
      /HTTP 404 Not Found on https:\/\/example\.test\/missing\.js/,
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
});

describe("pluginMediaFetch", () => {
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
          sanitizedUrl: "https://novel-phinf.pstatic.net/page.png",
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
          sanitizedUrl: "https://cdn.test/page.png",
        }),
      );
      expect(debugSpy).toHaveBeenCalledWith(
        "[plugin-media-fetch] native fallback started",
        expect.objectContaining({
          host: "cdn.test",
          sanitizedUrl: "https://cdn.test/page.png",
        }),
      );
      expect(debugSpy).toHaveBeenCalledWith(
        "[plugin-media-fetch] native fallback finished",
        expect.objectContaining({
          host: "cdn.test",
          sanitizedUrl: "https://cdn.test/page.png",
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
        "Media fetch failed for https://cdn.test/page.png; browser: browser failed; native: native failed",
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "[plugin-media-fetch] native fallback failed",
        expect.objectContaining({
          browserError: "browser failed",
          nativeError: "native failed",
          sanitizedUrl: "https://cdn.test/page.png",
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
      /HTTP 503 Service Unavailable on https:\/\/ok\.test\//,
    );
  });
});
