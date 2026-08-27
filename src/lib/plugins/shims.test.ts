import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  FilterTypes,
  bytesToUtf8,
  captureChapterWebView,
  createShimResolver,
  defaultCover,
  isUrlAbsolute,
  parseCsv,
  utf8ToBytes,
} from "./shims";
import { NovelStatus } from "./types";
import { useBrowseStore } from "../../store/browse";

const invokeMock = vi.mocked(invoke);

function installMemoryStorage(): void {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  } as Storage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
}

beforeEach(() => {
  installMemoryStorage();
  invokeMock.mockReset();
  useBrowseStore.setState({ sourceRequestTimeoutSeconds: 30 });
});

describe("FilterTypes", () => {
  it("matches the upstream string discriminators", () => {
    expect(FilterTypes).toEqual({
      TextInput: "Text",
      Picker: "Picker",
      CheckboxGroup: "Checkbox",
      Switch: "Switch",
      ExcludableCheckboxGroup: "XCheckbox",
    });
  });
});

describe("isUrlAbsolute", () => {
  it("returns true for http/https URLs", () => {
    expect(isUrlAbsolute("https://example.com/x")).toBe(true);
    expect(isUrlAbsolute("http://example.com/x")).toBe(true);
  });

  it("returns true for any custom scheme", () => {
    expect(isUrlAbsolute("data:text/plain,hi")).toBe(true);
    expect(isUrlAbsolute("norea://repo/add")).toBe(true);
  });

  it("returns false for relative paths", () => {
    expect(isUrlAbsolute("/foo/bar")).toBe(false);
    expect(isUrlAbsolute("./relative")).toBe(false);
    expect(isUrlAbsolute("plain")).toBe(false);
  });
});

describe("captureChapterWebView", () => {
  it("enables native response capture for chapter navigation", async () => {
    invokeMock.mockResolvedValueOnce("captured");

    await expect(
      captureChapterWebView("https://source.test/chapter/1", {
        scraperExecutor: "pool:1",
        sourceId: "source-a",
      }),
    ).resolves.toBe("captured");

    expect(invokeMock).toHaveBeenCalledWith("webview_extract", {
      url: "https://source.test/chapter/1",
      beforeScript: null,
      captureResources: true,
      sourceId: "source-a",
      timeoutMs: 30_000,
      userAgent: globalThis.navigator?.userAgent ?? null,
      queue: "pool:1",
    });
  });
});

describe("utf8ToBytes / bytesToUtf8", () => {
  it("round-trips ASCII", () => {
    expect(bytesToUtf8(utf8ToBytes("hello"))).toBe("hello");
  });

  it("round-trips multibyte text", () => {
    const input = "hello \u2603";
    expect(bytesToUtf8(utf8ToBytes(input))).toBe(input);
  });
});

describe("defaultCover", () => {
  it("is a placeholder image URL", () => {
    expect(defaultCover).toMatch(/^https:\/\//);
  });
});

describe("parseCsv", () => {
  it("parses quoted CSV rows", () => {
    expect(parseCsv('name,value\n"A, B","one ""two"""')).toEqual([
      ["name", "value"],
      ["A, B", 'one "two"'],
    ]);
  });

  it("maps rows to records when header is enabled", () => {
    expect(parseCsv("name,value\nA,1", { header: true })).toEqual([
      { name: "A", value: "1" },
    ]);
  });
});

describe("createShimResolver", () => {
  const resolve = createShimResolver("test-plugin");

  it("resolves the upstream-whitelisted module ids", () => {
    expect(typeof resolve("htmlparser2")).toBe("object");
    expect(typeof resolve("cheerio")).toBe("object");
    expect(typeof resolve("dayjs")).toBe("function");
    expect(typeof resolve("urlencode")).toBe("object");
    expect(typeof resolve("@libs/fetch")).toBe("object");
    expect(resolve("@libs/novelStatus")).toEqual({ NovelStatus });
    expect(resolve("@libs/filterInputs")).toEqual({ FilterTypes });
    expect(typeof resolve("@libs/defaultCover")).toBe("object");
    expect(typeof resolve("@libs/isAbsoluteUrl")).toBe("object");
    expect(typeof resolve("@libs/utils")).toBe("object");
    expect(typeof resolve("@libs/archive")).toBe("object");
    expect(typeof resolve("@libs/csv")).toBe("object");
    expect(typeof resolve("@libs/storage")).toBe("object");
    expect(typeof resolve("@libs/pluginInputs")).toBe("object");
    expect(typeof resolve("@libs/webView")).toBe("object");
  });

  it("throws for any module outside the whitelist", () => {
    expect(() => resolve("fs")).toThrow(/whitelisted/);
    expect(() => resolve("react")).toThrow(/whitelisted/);
    expect(() => resolve("@libs/cookies")).toThrow(/whitelisted/);
  });

  it("@libs/fetch surfaces the host fetch wrappers", () => {
    const lib = resolve("@libs/fetch") as {
      appFetch: unknown;
      fetchApi: unknown;
      fetchFile: unknown;
      fetchText: unknown;
      fetchProto: unknown;
    };
    expect(typeof lib.appFetch).toBe("function");
    expect(typeof lib.fetchApi).toBe("function");
    expect(typeof lib.fetchFile).toBe("function");
    expect(typeof lib.fetchText).toBe("function");
    expect(typeof lib.fetchProto).toBe("function");
  });

  it("@libs/fetch appFetch uses the native app HTTP path", async () => {
    invokeMock.mockImplementation(async (command, payload) => {
      if (command === "plugin:http|fetch") {
        expect(payload).toEqual({
          clientConfig: {
            method: "GET",
            url: "https://api.example.test/repos/demo/project",
            headers: [["Accept", "application/json"]],
            data: null,
          },
        });
        return 7;
      }
      if (command === "plugin:http|fetch_send") {
        expect(payload).toEqual({ rid: 7 });
        return {
          status: 204,
          statusText: "No Content",
          url: "https://api.example.test/repos/demo/project",
          headers: {},
          rid: 7,
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });
    const lib = resolve("@libs/fetch") as {
      appFetch: (
        url: string,
        init?: { headers?: Record<string, string> },
      ) => Promise<Response>;
    };

    const response = await lib.appFetch(
      "https://api.example.test/repos/demo/project",
      { headers: { Accept: "application/json" } },
    );

    expect(response.status).toBe(204);
    expect(response.url).toBe("https://api.example.test/repos/demo/project");
  });

  it("@libs/fetch fetchFile uses the native media fallback after browser fetch failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    invokeMock.mockImplementation(async (command) => {
      if (command === "webview_fetch") {
        throw new Error("scraper: eval browser fetch script timed out");
      }
      if (command === "scraper_media_fetch") {
        return {
          status: 200,
          statusText: "OK",
          bodyBase64: "AQID",
          headers: {},
          finalUrl: "https://files.test/chapter.pdf",
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });
    const lib = resolve("@libs/fetch") as {
      fetchFile: (url: string) => Promise<string>;
    };

    try {
      await expect(
        lib.fetchFile("https://files.test/chapter.pdf"),
      ).resolves.toBe("AQID");

      expect(invokeMock).toHaveBeenCalledWith(
        "webview_fetch",
        expect.objectContaining({
          url: "https://files.test/chapter.pdf",
        }),
      );
      expect(invokeMock).toHaveBeenCalledWith(
        "scraper_media_fetch",
        expect.objectContaining({
          url: "https://files.test/chapter.pdf",
        }),
      );
    } finally {
      errorSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  it("@libs/webView uses the configured source request timeout by default", async () => {
    invokeMock.mockResolvedValueOnce("html");
    useBrowseStore.setState({ sourceRequestTimeoutSeconds: 45 });
    const lib = resolve("@libs/webView") as {
      webViewFetch: (url: string) => Promise<string>;
    };

    await expect(lib.webViewFetch("https://source.test/page")).resolves.toBe(
      "html",
    );

    expect(invokeMock).toHaveBeenCalledWith("webview_extract", {
      url: "https://source.test/page",
      beforeScript: null,
      sourceId: "test-plugin",
      timeoutMs: 45_000,
      userAgent: globalThis.navigator?.userAgent ?? null,
      queue: "immediate",
    });
  });

  it("@libs/webView exposes a high-level page load helper", async () => {
    invokeMock.mockResolvedValueOnce(
      JSON.stringify({
        ok: true,
        result: {
          html: "<html><body>Loaded</body></html>",
          text: "Loaded",
          title: "Loaded title",
          url: "https://source.test/page",
        },
      }),
    );
    const lib = resolve("@libs/webView") as {
      webViewLoad: (url: string) => Promise<{
        html: string;
        text: string;
        title: string;
        url: string;
      }>;
    };

    await expect(lib.webViewLoad("https://source.test/page")).resolves.toEqual({
      html: "<html><body>Loaded</body></html>",
      text: "Loaded",
      title: "Loaded title",
      url: "https://source.test/page",
    });

    expect(invokeMock).toHaveBeenCalledWith("webview_extract", {
      url: "https://source.test/page",
      beforeScript: expect.stringContaining("document.documentElement.outerHTML"),
      sourceId: "test-plugin",
      timeoutMs: 30_000,
      userAgent: globalThis.navigator?.userAgent ?? null,
      queue: "immediate",
    });
    expect(invokeMock.mock.calls[0]?.[1]).toMatchObject({
      beforeScript: expect.stringContaining("manual-action-required"),
    });
    const beforeScript = String(
      (invokeMock.mock.calls[0]?.[1] as { beforeScript?: unknown })
        ?.beforeScript ?? "",
    );
    expect(beforeScript).toContain(
      "hasCloudflareEvidence && hasChallengeText",
    );
    expect(beforeScript).not.toContain('".cf-challenge",');
  });

  it("@libs/webView preserves a manual source access challenge", async () => {
    invokeMock.mockResolvedValueOnce(
      JSON.stringify({
        ok: false,
        code: "manual-action-required",
        error: "Complete the Cloudflare verification.",
        challenge: {
          kind: "cloudflare",
          url: "https://attacker.test/challenge",
        },
      }),
    );
    const lib = resolve("@libs/webView") as {
      webViewLoad: (url: string) => Promise<unknown>;
    };

    await expect(
      lib.webViewLoad("https://source.test/page"),
    ).rejects.toMatchObject({
      code: "source-access-required",
      challenge: {
        kind: "cloudflare",
        url: "https://source.test/page",
      },
    });
  });

  it("@libs/webView exposes executor-bound navigation", async () => {
    invokeMock.mockResolvedValueOnce(
      JSON.stringify({
        ok: true,
        result: {
          title: "Target",
          url: "https://source.test/target",
        },
      }),
    );
    const resolveForPool = createShimResolver(
      "test-plugin",
      undefined,
      "pool:2",
    );
    const lib = resolveForPool("@libs/webView") as {
      webViewNavigate: (url: string) => Promise<{ title?: string; url: string }>;
    };

    await expect(
      lib.webViewNavigate("https://source.test/target"),
    ).resolves.toEqual({
      title: "Target",
      url: "https://source.test/target",
    });

    expect(invokeMock).toHaveBeenCalledWith("webview_extract", {
      url: "https://source.test/target",
      beforeScript: expect.stringContaining("if (false)"),
      sourceId: "test-plugin",
      timeoutMs: 30_000,
      userAgent: globalThis.navigator?.userAgent ?? null,
      queue: "pool:2",
    });
  });

  it("@libs/pluginInputs reads app-managed plugin input values", () => {
    const values = new Map<string, string>([
      ["plugin-v2:test-plugin:url", "https://komga.test/"],
    ]);
    const storage = {
      get length() {
        return values.size;
      },
      key(index: number) {
        return [...values.keys()][index] ?? null;
      },
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
      removeItem(key: string) {
        values.delete(key);
      },
    } as Storage;
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
    try {
      const lib = resolve("@libs/pluginInputs") as {
        inputs: {
          get(key: string): string | null;
          getAll(): Record<string, string>;
          require(key: string): string;
        };
      };
      expect(lib.inputs.get("url")).toBe("https://komga.test/");
      expect(lib.inputs.getAll()).toEqual({ url: "https://komga.test/" });
      expect(lib.inputs.require("url")).toBe("https://komga.test/");
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: original,
      });
    }
  });
});
