import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { load } from "cheerio";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
  invoke: vi.fn(),
}));
vi.mock("./http", () => ({
  pluginMediaFetch: vi.fn(),
}));
const androidStorageMocks = vi.hoisted(() => ({
  androidStoragePathSize: vi.fn(),
  androidStorageZipEntryExists: vi.fn(),
  archiveAndroidStorageDirectory: vi.fn(),
  clearAndroidStorageRoot: vi.fn(),
  deleteAndroidStoragePath: vi.fn(),
  extractAndroidStorageZip: vi.fn(),
  prepareAndroidReaderMediaCache: vi.fn(),
  readAndroidStorageDataUrl: vi.fn(),
  readAndroidStorageText: vi.fn(),
  readAndroidStorageZipEntriesDataUrls: vi.fn(),
  readAndroidStorageZipEntryDataUrl: vi.fn(),
  renameAndroidStoragePath: vi.fn(),
  writeAndroidStorageBytes: vi.fn(),
  writeAndroidStorageText: vi.fn(),
}));
vi.mock("./android-storage", () => androidStorageMocks);
vi.mock("../db/queries/chapter", () => ({
  getChapterById: vi.fn(),
}));
vi.mock("../db/queries/novel", () => ({
  getNovelById: vi.fn(),
}));

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { pluginMediaFetch } from "./http";
import { getChapterById } from "../db/queries/chapter";
import { getNovelById } from "../db/queries/novel";
import {
  cacheHtmlChapterMedia,
  getStoredChapterMediaBytes,
  localChapterMediaSources,
  protectRemoteChapterMediaForPartialHtml,
  resolveLocalChapterMedia,
  resolveLocalChapterMediaPatches,
  restoreProtectedRemoteChapterMediaSources,
} from "./chapter-media";

const invokeMock = vi.mocked(invoke);
const convertFileSrcMock = vi.mocked(convertFileSrc);
const pluginMediaFetchMock = vi.mocked(pluginMediaFetch);
const getChapterByIdMock = vi.mocked(getChapterById);
const getNovelByIdMock = vi.mocked(getNovelById);

function nativeStreamInfo(handle: string, size = 0, finished = false) {
  return {
    createdAtMs: 1,
    domain: "chapter-media",
    expiresAtMs: 2,
    finished,
    handle,
    maxBytes: 100,
    size,
  };
}

function installTemplateDocument(): void {
  vi.stubGlobal("document", {
    createElement(tagName: string) {
      if (tagName !== "template") {
        throw new Error(`Unexpected test element: ${tagName}`);
      }

      let $ = load("", null, false);
      let wrappers = new Map<object, Element>();
      const asCheerioInput = (node: object): Parameters<typeof $>[0] =>
        node as Parameters<typeof $>[0];
      const wrap = (node: object | undefined): Element | null => {
        if (!node) return null;
        const existing = wrappers.get(node);
        if (existing) return existing;
        const element = {
          get tagName() {
            return (
              (node as { name?: string; tagName?: string }).tagName ??
              (node as { name?: string }).name ??
              ""
            );
          },
          get parentElement() {
            return wrap((node as { parent?: object }).parent);
          },
          getAttribute(name: string) {
            return $(asCheerioInput(node)).attr(name) ?? null;
          },
          hasAttribute(name: string) {
            return $(asCheerioInput(node)).attr(name) !== undefined;
          },
          querySelector(selector: string) {
            return wrap(
              $(asCheerioInput(node)).find(selector).get(0) as
                | object
                | undefined,
            );
          },
          get textContent() {
            return $(asCheerioInput(node)).text();
          },
          set textContent(value: string) {
            $(asCheerioInput(node)).text(value);
          },
          removeAttribute(name: string) {
            $(asCheerioInput(node)).removeAttr(name);
          },
          setAttribute(name: string, value: string) {
            $(asCheerioInput(node)).attr(name, value);
          },
        } as Element;
        wrappers.set(node, element);
        return element;
      };

      return {
        get innerHTML() {
          return $.root().html() ?? "";
        },
        set innerHTML(value: string) {
          $ = load(value, null, false);
          wrappers = new Map<object, Element>();
        },
        content: {
          querySelectorAll(selector: string) {
            return $(selector)
              .toArray()
              .map((node) => wrap(node))
              .filter((node): node is Element => node !== null);
          },
        },
      };
    },
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  convertFileSrcMock.mockReset();
  convertFileSrcMock.mockImplementation((path) => `asset://localhost/${path}`);
  pluginMediaFetchMock.mockReset();
  getChapterByIdMock.mockReset();
  getNovelByIdMock.mockReset();
  Object.values(androidStorageMocks).forEach((mock) => mock.mockReset());
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  installTemplateDocument();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cacheHtmlChapterMedia", () => {
  it("rewrites remote images through the media cache and skips local sources", async () => {
    pluginMediaFetchMock.mockImplementation(async (url) => {
      const contentType = String(url).endsWith(".webp")
        ? "image/webp"
        : "image/png";

      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": contentType },
        status: 200,
        statusText: "OK",
      });
    });
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_archive_cache") return 6;
      const input = args as {
        chapterId: number;
        fileName: string;
      };
      return `norea-media://reader-asset/${input.fileName}`;
    });

    const result = await cacheHtmlChapterMedia({
      baseUrl: "https://source.test/novel/chapter/1.html",
      chapterId: 42,
      chapterName: "Opening",
      chapterNumber: "1",
      chapterPosition: 1,
      html: [
        `<img src="../images/page.png">`,
        `<img src="/covers/cover.webp">`,
        `<img src="data:image/png;base64,abc">`,
        `<img src="blob:https://source.test/image">`,
        `<img src="norea-media://reader-asset/old-page.png">`,
        `<img src="file:///tmp/page.png">`,
      ].join(""),
      novelId: 9,
      novelName: "Sample Novel",
      novelPath: "/novel/sample",
      sourceId: "demo",
    });

    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(2);
    expect(pluginMediaFetchMock).toHaveBeenNthCalledWith(
      1,
      "https://source.test/novel/images/page.png",
      expect.objectContaining({
        contextUrl: "https://source.test/novel/chapter/1.html",
        headers: expect.objectContaining({ Accept: expect.any(String) }),
        signal: undefined,
        sourceId: "demo",
      }),
    );
    expect(pluginMediaFetchMock).toHaveBeenNthCalledWith(
      2,
      "https://source.test/covers/cover.webp",
      expect.objectContaining({
        contextUrl: "https://source.test/novel/chapter/1.html",
        headers: expect.objectContaining({ Accept: expect.any(String) }),
        signal: undefined,
        sourceId: "demo",
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "chapter_media_store",
      expect.objectContaining({
        body: [1, 2, 3],
        chapterId: 42,
        chapterName: "Opening",
        chapterNumber: "1",
        chapterPosition: 1,
        fileName: "0001-page.png",
        novelId: 9,
        novelName: "Sample Novel",
        novelPath: "/novel/sample",
        sourceId: "demo",
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "chapter_media_store",
      expect.objectContaining({
        body: [1, 2, 3],
        chapterId: 42,
        chapterName: "Opening",
        chapterNumber: "1",
        chapterPosition: 1,
        fileName: "0002-cover.webp",
        novelId: 9,
        novelName: "Sample Novel",
        novelPath: "/novel/sample",
        sourceId: "demo",
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "chapter_media_archive_cache",
      expect.objectContaining({
        chapterId: 42,
        chapterName: "Opening",
        chapterNumber: "1",
        chapterPosition: 1,
        novelId: 9,
        novelName: "Sample Novel",
        novelPath: "/novel/sample",
        sourceId: "demo",
      }),
    );
    expect(result.mediaBytes).toBe(6);
    expect(result.html).toContain(
      'src="norea-media://reader-asset/0001-page.png"',
    );
    expect(result.html).toContain(
      'src="norea-media://reader-asset/0002-cover.webp"',
    );
    expect(result.html).toContain("data:image/png;base64,abc");
    expect(result.html).toContain("blob:https://source.test/image");
    expect(result.html).toContain(
      'src="norea-media://reader-asset/old-page.png"',
    );
    expect(result.html).toContain("file:///tmp/page.png");
    expect(result.html).not.toMatch(/000\d-[^"]+-[0-9a-f]{8}\./);
  });

  it("stores desktop media through a native stream handle when available", async () => {
    pluginMediaFetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      }),
    );
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_read_manifest") return null;
      if (command === "native_stream_create") return nativeStreamInfo("media-1");
      if (command === "native_stream_write_chunk") {
        const chunk = (args as { chunk: number[] }).chunk;
        return nativeStreamInfo("media-1", chunk.length);
      }
      if (command === "native_stream_finish") {
        return nativeStreamInfo("media-1", 3, true);
      }
      if (command === "chapter_media_store_handle") {
        const input = args as {
          chapterId: number;
          fileName: string;
        };
        return `norea-media://reader-asset/${input.fileName}`;
      }
      if (command === "chapter_media_archive_cache") return 3;
      if (command === "chapter_media_write_manifest") return null;
      if (command === "chapter_media_total_size") return 0;
      throw new Error(`unexpected command: ${command}`);
    });

    const result = await cacheHtmlChapterMedia({
      baseUrl: "https://source.test/chapter/1",
      chapterId: 42,
      html: `<img src="/page.png">`,
      novelId: 9,
      novelPath: "/novel/sample",
      sourceId: "demo",
    });

    expect(invokeMock).toHaveBeenCalledWith("native_stream_create", {
      domain: "chapter-media",
      maxBytes: 3,
      ttlMs: undefined,
    });
    expect(invokeMock).toHaveBeenCalledWith("native_stream_write_chunk", {
      chunk: [1, 2, 3],
      handle: "media-1",
      offset: 0,
    });
    expect(invokeMock).toHaveBeenCalledWith("chapter_media_store_handle", {
      chapterId: 42,
      fileName: "0001-page.png",
      handle: "media-1",
      novelId: 9,
      novelPath: "/novel/sample",
      sourceId: "demo",
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "chapter_media_store",
      expect.anything(),
    );
    expect(result.html).toContain(
      'src="norea-media://reader-asset/0001-page.png"',
    );
  });

  it("falls back to legacy desktop media store when the handle command is missing", async () => {
    pluginMediaFetchMock.mockImplementation(async () => {
      return new Response(new Uint8Array([4, 5]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      });
    });
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_read_manifest") return null;
      if (command === "native_stream_create") return nativeStreamInfo("media-1");
      if (command === "native_stream_write_chunk") {
        return nativeStreamInfo("media-1", 2);
      }
      if (command === "native_stream_finish") {
        return nativeStreamInfo("media-1", 2, true);
      }
      if (command === "chapter_media_store_handle") {
        throw new Error("unknown command: chapter_media_store_handle");
      }
      if (command === "native_stream_cancel") return null;
      if (command === "chapter_media_store") {
        const input = args as {
          chapterId: number;
          fileName: string;
        };
        return `norea-media://reader-asset/${input.fileName}`;
      }
      if (command === "chapter_media_archive_cache") return 2;
      if (command === "chapter_media_write_manifest") return null;
      if (command === "chapter_media_total_size") return 0;
      throw new Error(`unexpected command: ${command}`);
    });

    const result = await cacheHtmlChapterMedia({
      baseUrl: "https://source.test/chapter/1",
      chapterId: 42,
      html: `<img src="/page.png">`,
    });

    expect(invokeMock).toHaveBeenCalledWith("native_stream_cancel", {
      handle: "media-1",
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "chapter_media_store",
      expect.objectContaining({
        body: [4, 5],
        fileName: "0001-page.png",
      }),
    );
    expect(result.html).toContain(
      'src="norea-media://reader-asset/0001-page.png"',
    );
  });

  it("rewrites lazy and responsive image sources through the media cache", async () => {
    pluginMediaFetchMock.mockImplementation(async () => {
      return new Response(new Uint8Array([4, 5, 6]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      });
    });
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_archive_cache") return 15;
      const input = args as {
        chapterId: number;
        fileName: string;
      };
      return `norea-media://reader-asset/${input.fileName}`;
    });

    const result = await cacheHtmlChapterMedia({
      baseUrl: "https://source.test/topic/1",
      chapterId: 7,
      html: [
        `<img data-src="./lazy.png">`,
        `<img srcset="./small.png 1x, ./large.png 2x">`,
        `<picture>`,
        `<source srcset="/wide.png 800w">`,
        `<img src="/fallback.png">`,
        `</picture>`,
      ].join(""),
    });

    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(5);
    expect(result.mediaBytes).toBe(15);
    expect(result.html).toContain(
      "norea-media://reader-asset/0001-lazy.png",
    );
    expect(result.html).not.toContain("data-src=");
    expect(result.html).toContain(" 1x");
    expect(result.html).toContain(" 2x");
    expect(result.html).toContain(" 800w");
  });

  it("rewrites external media attributes and style urls through the media cache", async () => {
    pluginMediaFetchMock.mockImplementation(async (url) => {
      const contentType = String(url).endsWith(".mp4")
        ? "video/mp4"
        : "image/png";

      return new Response(new Uint8Array([8, 9]), {
        headers: { "content-type": contentType },
        status: 200,
        statusText: "OK",
      });
    });
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_archive_cache") return 10;
      const input = args as {
        chapterId: number;
        fileName: string;
      };
      return `norea-media://reader-asset/${input.fileName}`;
    });

    const result = await cacheHtmlChapterMedia({
      baseUrl: "https://source.test/topic/1",
      chapterId: 13,
      html: [
        `<video poster="./poster.png"></video>`,
        `<object data="./panel.svg"></object>`,
        `<embed src="./clip.mp4">`,
        `<link rel="preload" as="image" href="./preload.png">`,
        `<div style="background-image:url('./background.png');"></div>`,
      ].join(""),
    });

    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(5);
    expect(pluginMediaFetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://source.test/topic/poster.png",
      "https://source.test/topic/panel.svg",
      "https://source.test/topic/clip.mp4",
      "https://source.test/topic/preload.png",
      "https://source.test/topic/background.png",
    ]);
    expect(result.mediaBytes).toBe(10);
    expect(result.html).toContain(
      "norea-media://reader-asset/0001-poster.png",
    );
    expect(result.html).toContain("poster=");
    expect(result.html).toContain("data=");
    expect(result.html).toContain("href=");
    expect(result.html).not.toContain("https://source.test/topic/poster.png");
    expect(result.html).not.toContain("https://source.test/topic/background.png");
  });

  it("caches absolute rendered media without rewriting normal links", async () => {
    pluginMediaFetchMock.mockImplementation(async () => {
      return new Response(new Uint8Array([5]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      });
    });
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_archive_cache") return 1;
      const input = args as {
        chapterId: number;
        fileName: string;
      };
      return `norea-media://reader-asset/${input.fileName}`;
    });

    const result = await cacheHtmlChapterMedia({
      chapterId: 15,
      html: [
        `<a href="https://source.test/read">link</a>`,
        `<img src="https://source.test/page.png">`,
        `<img srcset="https://source.test/small.png 1x, ./large.png 2x">`,
        `<video poster="https://source.test/poster.png"></video>`,
        `<div style="background-image:url('https://source.test/bg.png')"></div>`,
        `<img src="./relative.png">`,
      ].join(""),
    });

    expect(pluginMediaFetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://source.test/page.png",
      "https://source.test/small.png",
      "https://source.test/poster.png",
      "https://source.test/bg.png",
    ]);
    expect(result.html).toContain(
      '<a href="https://source.test/read">link</a>',
    );
    expect(result.html).toContain(
      'src="norea-media://reader-asset/0001-page.png"',
    );
    expect(result.html).toContain(
      "norea-media://reader-asset/0002-small.png 1x",
    );
    expect(result.html).toContain("./large.png 2x");
    expect(result.html).toContain(
      'poster="norea-media://reader-asset/0003-poster.png"',
    );
    expect(result.html).toContain(
      "norea-media://reader-asset/0004-bg.png",
    );
    expect(result.html).toContain('src="./relative.png"');
  });

  it("emits safe media markup while progressively restoring local sources", async () => {
    pluginMediaFetchMock.mockImplementation(async () => {
      return new Response(new Uint8Array([7, 8, 9]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      });
    });
    const htmlUpdates: string[] = [];
    const events: string[] = [];
    const mediaPatches: Array<
      Array<{ attributes: Record<string, string>; index: number }>
    > = [];
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") {
        events.push("prepare");
        return null;
      }
      if (command === "chapter_media_archive_cache") return 6;
      const input = args as {
        chapterId: number;
        fileName: string;
      };
      return `norea-media://reader-asset/${input.fileName}`;
    });

    const result = await cacheHtmlChapterMedia({
      baseUrl: "https://source.test/topic/1",
      chapterId: 7,
      html: `<img src="./page.png"><video src="./clip.png"></video>`,
      onHtmlUpdate: (html) => {
        events.push("html");
        htmlUpdates.push(html);
      },
      onMediaPatch: (patches) => {
        mediaPatches.push(patches);
      },
    });

    expect(htmlUpdates).toHaveLength(2);
    expect(events[0]).toBe("prepare");
    expect(events[1]).toBe("html");
    for (const update of htmlUpdates) {
      expect(update).not.toContain('src=""');
      expect(update).not.toContain("data-norea-media");
    }
    expect(htmlUpdates[0]).toContain(
      'src="norea-media://reader-asset/0001-page.png"',
    );
    expect(htmlUpdates[0]).toContain('src="./clip.png"');
    expect(mediaPatches).toHaveLength(2);
    expect(mediaPatches[0]).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({
          src: "norea-media://reader-asset/0001-page.png",
        }),
        index: 0,
      }),
    ]);
    expect(mediaPatches[1]).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({
          src: "norea-media://reader-asset/0002-clip.png",
        }),
        index: 1,
      }),
    ]);
    expect(result.mediaFailures).toEqual([]);
    expect(result.storedMediaCount).toBe(2);
  });

  it("keeps failed image assets on remote URLs while storing successful assets", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    pluginMediaFetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/missing.png")) {
        throw new Error("CDN blocked");
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      });
    });
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_archive_cache") return 3;
      if (command === "chapter_media_write_manifest") return null;
      if (command === "chapter_media_write_manifest") return null;
      const input = args as {
        chapterId: number;
        fileName: string;
      };
      return `norea-media://reader-asset/${input.fileName}`;
    });

    try {
      const result = await cacheHtmlChapterMedia({
        baseUrl: "https://source.test/chapter/1",
        chapterId: 42,
        html: `<img src="./ok.png"><img src="./missing.png">`,
      });

      expect(result.mediaFailures).toEqual([
        expect.objectContaining({
          message: "CDN blocked",
          url: "https://source.test/chapter/missing.png",
        }),
      ]);
      expect(result.storedMediaCount).toBe(1);
      expect(result.mediaBytes).toBe(3);
      expect(result.html).toContain(
        'src="norea-media://reader-asset/0001-ok.png"',
      );
      expect(result.html).toContain(
        'src="https://source.test/chapter/missing.png"',
      );
      expect(result.html).not.toContain('src=""');
      expect(result.html).not.toContain("data-norea-media");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("mixes local and remote fallbacks inside srcset and inline style", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    pluginMediaFetchMock.mockImplementation(async (url) => {
      if (
        String(url).endsWith("/large.png") ||
        String(url).endsWith("/bg.png")
      ) {
        return new Response("nope", {
          status: 403,
          statusText: "Forbidden",
        });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      });
    });
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_archive_cache") return 3;
      const input = args as {
        chapterId: number;
        fileName: string;
      };
      return `norea-media://reader-asset/${input.fileName}`;
    });

    try {
      const result = await cacheHtmlChapterMedia({
        baseUrl: "https://source.test/chapter/1",
        chapterId: 42,
        html: [
          `<img srcset="./small.png 1x, ./large.png 2x">`,
          `<div style="background-image:url('./bg.png')"></div>`,
        ].join(""),
      });

      expect(result.mediaFailures).toHaveLength(2);
      expect(result.html).toMatch(
        /srcset="norea-media:\/\/reader-asset\/0001-small\.png 1x, https:\/\/source\.test\/chapter\/large\.png 2x"/,
      );
      expect(result.html).toContain(
        'style="background-image:url(&quot;https://source.test/chapter/bg.png&quot;)"',
      );
      expect(result.html).not.toContain('srcset=""');
      expect(result.html).not.toContain("data-norea-media");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("falls back to the remote URL when storing one fetched media asset fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    pluginMediaFetchMock.mockImplementation(async () => {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      });
    });
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_read_manifest") return null;
      if (command === "native_stream_create") {
        throw new Error("unknown command: native_stream_create");
      }
      if (command === "chapter_media_archive_cache") return 3;
      if (command === "chapter_media_write_manifest") return null;
      if (command === "chapter_media_total_size") return 0;
      const input = args as {
        chapterId: number;
        fileName: string;
      };
      if (input.fileName.includes("broken")) {
        throw new Error("write failed");
      }
      return `norea-media://reader-asset/${input.fileName}`;
    });

    try {
      const result = await cacheHtmlChapterMedia({
        baseUrl: "https://source.test/chapter/1",
        chapterId: 42,
        html: `<img src="./ok.png"><img src="./broken.png">`,
      });

      expect(result.mediaFailures).toEqual([
        expect.objectContaining({
          message: "write failed",
          url: "https://source.test/chapter/broken.png",
        }),
      ]);
      expect(result.html).toContain(
        'src="norea-media://reader-asset/0001-ok.png"',
      );
      expect(result.html).toContain(
        'src="https://source.test/chapter/broken.png"',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("skips archive creation when every media asset falls back to remote", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    pluginMediaFetchMock.mockRejectedValue(new Error("offline"));

    try {
      const result = await cacheHtmlChapterMedia({
        baseUrl: "https://source.test/chapter/1",
        chapterId: 42,
        html: `<img src="./one.png"><img src="./two.png">`,
      });

      expect(result.mediaBytes).toBe(0);
      expect(result.mediaFailures).toHaveLength(2);
      expect(result.html).toContain('src="https://source.test/chapter/one.png"');
      expect(result.html).toContain('src="https://source.test/chapter/two.png"');
      expect(invokeMock).not.toHaveBeenCalledWith(
        "chapter_media_archive_cache",
        expect.anything(),
      );
      expect(invokeMock).toHaveBeenCalledWith(
        "chapter_media_write_manifest",
        expect.objectContaining({
          files: expect.arrayContaining([
            expect.objectContaining({
              fileName: "0001-one.png",
              sourceUrl: "https://source.test/chapter/one.png",
              status: "remote",
            }),
            expect.objectContaining({
              fileName: "0002-two.png",
              sourceUrl: "https://source.test/chapter/two.png",
              status: "remote",
            }),
          ]),
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("throws cancellation while keeping the last partial HTML safe", async () => {
    const controller = new AbortController();
    const htmlUpdates: string[] = [];
    controller.abort();

    await expect(
      cacheHtmlChapterMedia({
        baseUrl: "https://source.test/chapter/1",
        chapterId: 42,
        html: `<img src="./one.png">`,
        onHtmlUpdate: (html) => {
          htmlUpdates.push(html);
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(htmlUpdates).toHaveLength(0);
  });

  it("reuses stored local media during media repair", async () => {
    pluginMediaFetchMock.mockImplementation(async () => {
      return new Response(new Uint8Array([4, 5]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      });
    });
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_total_size") return 7;
      if (command === "chapter_media_archive_cache") return 5;
      if (command === "chapter_media_read_manifest") return null;
      const input = args as {
        chapterId: number;
        fileName: string;
      };
      return `norea-media://reader-asset/${input.fileName}`;
    });

    const result = await cacheHtmlChapterMedia({
      baseUrl: "https://source.test/chapter/1",
      chapterId: 42,
      html: `<img src="/page-1.png"><img src="/page-2.png">`,
      previousHtml: [
        `<img src="norea-media://reader-asset/page-1.png">`,
        `<img src="">`,
      ].join(""),
      repair: true,
    });

    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
    expect(pluginMediaFetchMock).toHaveBeenCalledWith(
      "https://source.test/page-2.png",
      expect.objectContaining({
        contextUrl: "https://source.test/chapter/1",
        headers: expect.objectContaining({ Accept: expect.any(String) }),
        signal: undefined,
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "chapter_media_store",
      expect.objectContaining({
        fileName: "0002-page-2.png",
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith("chapter_media_archive_cache", {
      chapterId: 42,
    });
    expect(result.mediaBytes).toBe(5);
    expect(result.html).toContain(
      'src="norea-media://reader-asset/page-1.png"',
    );
    expect(result.html).toContain(
      'src="norea-media://reader-asset/0002-page-2.png"',
    );
    expect(result.html).not.toContain("data-norea-media-source-url");
  });

  it("uses the manifest to fetch only missing repair assets when HTML still has remote URLs", async () => {
    const manifest = {
      media: {
        files: [
          {
            bytes: 3,
            fileName: "0001-page-1.png",
            path: "media/0001-page-1.png",
            sourceUrl: "https://source.test/page-1.png",
            status: "stored",
            updatedAt: 1,
          },
          {
            bytes: 0,
            fileName: "0002-page-2.png",
            path: "media/0002-page-2.png",
            sourceUrl: "https://source.test/page-2.png",
            status: "stored",
            updatedAt: 1,
          },
          {
            bytes: 3,
            fileName: "0003-page-3.png",
            path: "media/0003-page-3.png",
            sourceUrl: "https://source.test/page-3.png",
            status: "stored",
            updatedAt: 1,
          },
        ],
      },
      updatedAt: 1,
      version: 1,
    };
    pluginMediaFetchMock.mockResolvedValue(
      new Response(new Uint8Array([4, 5]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      }),
    );
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_read_manifest") {
        return JSON.stringify(manifest);
      }
      if (command === "chapter_media_total_size") {
        const [mediaSrc] = (args as { mediaSrcs: string[] }).mediaSrcs;
        return (mediaSrc ?? "").includes("0002-page-2.png") ? 0 : 7;
      }
      if (command === "chapter_media_archive_cache") return 15;
      if (command === "chapter_media_write_manifest") return null;
      if (command === "chapter_media_store") {
        const input = args as {
          chapterId: number;
          fileName: string;
        };
        return `norea-media://reader-asset/${input.fileName}`;
      }
      return null;
    });

    const result = await cacheHtmlChapterMedia({
      baseUrl: "https://source.test/chapter/1",
      chapterId: 42,
      html: [
        `<img src="https://source.test/page-1.png">`,
        `<img src="https://source.test/page-2.png">`,
        `<img src="https://source.test/page-3.png">`,
      ].join(""),
      previousHtml: [
        `<img src="https://source.test/page-1.png">`,
        `<img src="https://source.test/page-2.png">`,
        `<img src="https://source.test/page-3.png">`,
      ].join(""),
      repair: true,
    });

    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
    expect(pluginMediaFetchMock).toHaveBeenCalledWith(
      "https://source.test/page-2.png",
      expect.objectContaining({
        contextUrl: "https://source.test/chapter/1",
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "chapter_media_store",
      expect.objectContaining({
        fileName: "0002-page-2.png",
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "chapter_media_write_manifest",
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({
            fileName: "0001-page-1.png",
            status: "stored",
          }),
          expect.objectContaining({
            bytes: 2,
            fileName: "0002-page-2.png",
            sourceUrl: "https://source.test/page-2.png",
            status: "stored",
          }),
          expect.objectContaining({
            fileName: "0003-page-3.png",
            status: "stored",
          }),
        ]),
      }),
    );
    expect(result.storedMediaCount).toBe(1);
    expect(result.mediaBytes).toBe(15);
    expect(result.html).toContain(
      "norea-media://reader-asset/0001-page-1.png",
    );
    expect(result.html).toContain("0002-page-2.png");
    expect(result.html).toContain("0003-page-3.png");
  });

  it("trusts existing files over stale manifest status during media repair", async () => {
    const manifest = {
      media: {
        files: [
          {
            bytes: 3,
            fileName: "0001-page-1.png",
            path: "media/0001-page-1.png",
            sourceUrl: "https://source.test/page-1.png",
            status: "remote",
            updatedAt: 1,
          },
          {
            bytes: 0,
            fileName: "0002-page-2.png",
            path: "media/0002-page-2.png",
            sourceUrl: "https://source.test/page-2.png",
            status: "remote",
            updatedAt: 1,
          },
          {
            bytes: 3,
            fileName: "0003-page-3.png",
            path: "media/0003-page-3.png",
            sourceUrl: "https://source.test/page-3.png",
            status: "remote",
            updatedAt: 1,
          },
        ],
      },
      updatedAt: 1,
      version: 1,
    };
    pluginMediaFetchMock.mockResolvedValue(
      new Response(new Uint8Array([4, 5]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      }),
    );
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_read_manifest") {
        return JSON.stringify(manifest);
      }
      if (command === "chapter_media_total_size") {
        const [mediaSrc] = (args as { mediaSrcs: string[] }).mediaSrcs;
        return (mediaSrc ?? "").includes("0002-page-2.png") ? 0 : 7;
      }
      if (command === "chapter_media_archive_cache") return 15;
      if (command === "chapter_media_write_manifest") return null;
      if (command === "chapter_media_store") {
        const input = args as {
          chapterId: number;
          fileName: string;
        };
        return `norea-media://reader-asset/${input.fileName}`;
      }
      return null;
    });

    const result = await cacheHtmlChapterMedia({
      baseUrl: "https://source.test/chapter/1",
      chapterId: 42,
      html: [
        `<img src="https://source.test/page-1.png">`,
        `<img src="https://source.test/page-2.png">`,
        `<img src="https://source.test/page-3.png">`,
      ].join(""),
      previousHtml: [
        `<img src="https://source.test/page-1.png">`,
        `<img src="https://source.test/page-2.png">`,
        `<img src="https://source.test/page-3.png">`,
      ].join(""),
      repair: true,
    });

    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
    expect(pluginMediaFetchMock).toHaveBeenCalledWith(
      "https://source.test/page-2.png",
      expect.anything(),
    );
    expect(result.storedMediaCount).toBe(1);
    expect(result.html).toContain("0001-page-1.png");
    expect(result.html).toContain("0002-page-2.png");
    expect(result.html).toContain("0003-page-3.png");
  });

  it("starts chapter downloads without scanning every target file", async () => {
    pluginMediaFetchMock.mockImplementation(async () => {
      return new Response(new Uint8Array([4, 5]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      });
    });
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_read_manifest") return null;
      if (command === "chapter_media_total_size") {
        throw new Error("chapter downloads must not scan every target file");
      }
      if (command === "chapter_media_archive_cache") return 12;
      if (command === "chapter_media_write_manifest") return null;
      if (command === "chapter_media_store") {
        const input = args as {
          chapterId: number;
          fileName: string;
        };
        return `norea-media://reader-asset/${input.fileName}`;
      }
      return null;
    });

    const result = await cacheHtmlChapterMedia({
      baseUrl: "https://source.test/chapter/1",
      chapterId: 42,
      html: [
        `<img src="https://source.test/page-1.png">`,
        `<img src="https://source.test/page-2.png">`,
      ].join(""),
    });

    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(2);
    expect(pluginMediaFetchMock).toHaveBeenCalledWith(
      "https://source.test/page-1.png",
      expect.anything(),
    );
    expect(pluginMediaFetchMock).toHaveBeenCalledWith(
      "https://source.test/page-2.png",
      expect.anything(),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "chapter_media_store",
      expect.objectContaining({
        fileName: "0001-page-1.png",
      }),
    );
    expect(result.storedMediaCount).toBe(2);
    expect(result.mediaBytes).toBe(12);
    expect(result.html).toContain("0001-page-1.png");
    expect(result.html).toContain("0002-page-2.png");
  });

  it("reuses stored manifest media during chapter downloads", async () => {
    const manifest = {
      complete: true,
      media: {
        files: [
          {
            bytes: 3,
            fileName: "0001-page-1.png",
            path: "media/0001-page-1.png",
            sourceUrl: "https://source.test/page-1.png",
            status: "stored",
            updatedAt: 1,
          },
          {
            bytes: 0,
            fileName: "0002-page-2.png",
            path: "media/0002-page-2.png",
            sourceUrl: "https://source.test/page-2.png",
            status: "remote",
            updatedAt: 1,
          },
          {
            bytes: 3,
            fileName: "0003-page-3.png",
            path: "media/0003-page-3.png",
            sourceUrl: "https://source.test/page-3.png",
            status: "stored",
            updatedAt: 1,
          },
        ],
      },
      updatedAt: 1,
      version: 1,
    };
    pluginMediaFetchMock.mockResolvedValue(
      new Response(new Uint8Array([4, 5]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      }),
    );
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_read_manifest") {
        return JSON.stringify(manifest);
      }
      if (command === "chapter_media_total_size") {
        const [mediaSrc] = (args as { mediaSrcs: string[] }).mediaSrcs;
        return (mediaSrc ?? "").includes("0002-page-2.png") ? 0 : 7;
      }
      if (command === "chapter_media_archive_cache") return 15;
      if (command === "chapter_media_write_manifest") return null;
      if (command === "chapter_media_store") {
        const input = args as {
          chapterId: number;
          fileName: string;
        };
        return `norea-media://reader-asset/${input.fileName}`;
      }
      return null;
    });

    const result = await cacheHtmlChapterMedia({
      baseUrl: "https://source.test/chapter/1",
      chapterId: 42,
      html: [
        `<img src="https://source.test/page-1.png">`,
        `<img src="https://source.test/page-2.png">`,
        `<img src="https://source.test/page-3.png">`,
      ].join(""),
      repair: false,
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "chapter_media_prepare_workspace",
      expect.objectContaining({
        chapterId: 42,
        preserveExisting: true,
        repair: false,
      }),
    );
    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
    expect(pluginMediaFetchMock).toHaveBeenCalledWith(
      "https://source.test/page-2.png",
      expect.anything(),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "chapter_media_store",
      expect.objectContaining({
        fileName: "0002-page-2.png",
      }),
    );
    const manifestWrites = invokeMock.mock.calls.filter(
      ([command]) => command === "chapter_media_write_manifest",
    );
    expect(manifestWrites.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        complete: true,
        files: expect.arrayContaining([
          expect.objectContaining({
            fileName: "0001-page-1.png",
            status: "stored",
          }),
          expect.objectContaining({
            bytes: 2,
            fileName: "0002-page-2.png",
            sourceUrl: "https://source.test/page-2.png",
            status: "stored",
          }),
          expect.objectContaining({
            fileName: "0003-page-3.png",
            status: "stored",
          }),
        ]),
      }),
    );
    expect(result.storedMediaCount).toBe(1);
    expect(result.mediaBytes).toBe(15);
    expect(result.html).toContain("0001-page-1.png");
    expect(result.html).toContain("0002-page-2.png");
    expect(result.html).toContain("0003-page-3.png");
  });

  it("reuses existing files from incomplete manifests while downloading missing media", async () => {
    const manifest = {
      complete: false,
      media: {
        files: [
          {
            bytes: 3,
            fileName: "0001-page-1.png",
            path: "media/0001-page-1.png",
            sourceUrl: "https://source.test/page-1.png",
            status: "stored",
            updatedAt: 1,
          },
          {
            bytes: 3,
            fileName: "0002-page-2.png",
            path: "media/0002-page-2.png",
            sourceUrl: "https://source.test/page-2.png",
            status: "stored",
            updatedAt: 1,
          },
        ],
      },
      updatedAt: 1,
      version: 1,
    };
    pluginMediaFetchMock.mockImplementation(async () => {
      return new Response(new Uint8Array([4, 5]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      });
    });
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_read_manifest") {
        return JSON.stringify(manifest);
      }
      if (command === "chapter_media_total_size") {
        const [mediaSrc] = (args as { mediaSrcs: string[] }).mediaSrcs;
        return (mediaSrc ?? "").includes("0001-page-1.png") ? 7 : 0;
      }
      if (command === "chapter_media_archive_cache") return 12;
      if (command === "chapter_media_write_manifest") return null;
      if (command === "chapter_media_store") {
        const input = args as {
          chapterId: number;
          fileName: string;
        };
        return `norea-media://reader-asset/${input.fileName}`;
      }
      return null;
    });

    const result = await cacheHtmlChapterMedia({
      baseUrl: "https://source.test/chapter/1",
      chapterId: 42,
      html: [
        `<img src="https://source.test/page-1.png">`,
        `<img src="https://source.test/page-2.png">`,
      ].join(""),
    });

    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
    expect(pluginMediaFetchMock).toHaveBeenCalledWith(
      "https://source.test/page-2.png",
      expect.anything(),
    );
    expect(result.storedMediaCount).toBe(1);
    expect(result.mediaBytes).toBe(12);
    expect(result.html).toContain("0001-page-1.png");
    expect(result.html).toContain("0002-page-2.png");
  });

  it("writes a resumable manifest before aborted chapter downloads stop", async () => {
    const controller = new AbortController();
    pluginMediaFetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      }),
    );
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_read_manifest") return null;
      if (command === "chapter_media_write_manifest") return null;
      if (command === "chapter_media_store") {
        const input = args as {
          chapterId: number;
          fileName: string;
        };
        controller.abort();
        return `norea-media://reader-asset/${input.fileName}`;
      }
      return null;
    });

    await expect(
      cacheHtmlChapterMedia({
        baseUrl: "https://source.test/chapter/1",
        chapterId: 42,
        html: [
          `<img src="https://source.test/page-1.png">`,
          `<img src="https://source.test/page-2.png">`,
        ].join(""),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
    const manifestWrites = invokeMock.mock.calls.filter(
      ([command]) => command === "chapter_media_write_manifest",
    );
    expect(manifestWrites).toHaveLength(2);
    expect(manifestWrites[0]?.[1]).toEqual(
      expect.objectContaining({
        complete: false,
        files: expect.arrayContaining([
          expect.objectContaining({
            fileName: "0001-page-1.png",
            status: "remote",
          }),
          expect.objectContaining({
            fileName: "0002-page-2.png",
            status: "remote",
          }),
        ]),
      }),
    );
    expect(manifestWrites[1]?.[1]).toEqual(
      expect.objectContaining({
        complete: false,
        files: expect.arrayContaining([
          expect.objectContaining({
            bytes: 3,
            fileName: "0001-page-1.png",
            status: "stored",
          }),
          expect.objectContaining({
            fileName: "0002-page-2.png",
            status: "remote",
          }),
        ]),
      }),
    );
  });

  it("reuses legacy Android media archives during contextual media repair", async () => {
    vi.stubGlobal("navigator", { userAgent: "Android" });
    const manifest = {
      media: {
        files: [
          {
            bytes: 3,
            fileName: "0001-page-1.png",
            path: "media/0001-page-1.png",
            sourceUrl: "https://source.test/page-1.png",
            status: "stored",
            updatedAt: 1,
          },
          {
            bytes: 4,
            fileName: "0002-page-2.png",
            path: "media/0002-page-2.png",
            sourceUrl: "https://source.test/page-2.png",
            status: "stored",
            updatedAt: 1,
          },
        ],
      },
      updatedAt: 1,
      version: 1,
    };
    const preferredDir = "contents/source-a/Novel-novel-path/1-Chapter/media";
    const preferredArchive =
      "contents/source-a/Novel-novel-path/1-Chapter/media.zip";

    androidStorageMocks.readAndroidStorageText.mockImplementation(
      async (path: string) =>
        path === "chapter-media/42/manifest.json"
          ? JSON.stringify(manifest)
          : null,
    );
    androidStorageMocks.androidStoragePathSize.mockImplementation(
      async (path: string) => (path === preferredArchive ? 14 : 0),
    );
    androidStorageMocks.androidStorageZipEntryExists.mockImplementation(
      async (_archivePath: string, entryName: string) =>
        entryName === "0001-page-1.png" || entryName === "0002-page-2.png",
    );
    androidStorageMocks.archiveAndroidStorageDirectory.mockResolvedValue(14);
    androidStorageMocks.writeAndroidStorageText.mockResolvedValue(undefined);

    const result = await cacheHtmlChapterMedia({
      baseUrl: "https://source.test/chapter/1",
      chapterId: 42,
      chapterName: "Chapter",
      chapterNumber: "1",
      chapterPosition: 1,
      html: [
        `<img src="https://source.test/page-1.png">`,
        `<img src="https://source.test/page-2.png">`,
      ].join(""),
      novelId: 7,
      novelName: "Novel",
      novelPath: "novel/path",
      repair: true,
      sourceId: "source-a",
    });

    expect(pluginMediaFetchMock).not.toHaveBeenCalled();
    expect(androidStorageMocks.readAndroidStorageText).toHaveBeenCalledWith(
      preferredArchive.replace("media.zip", "manifest.json"),
    );
    expect(androidStorageMocks.readAndroidStorageText).toHaveBeenCalledWith(
      "chapter-media/42/manifest.json",
    );
    expect(androidStorageMocks.extractAndroidStorageZip).not.toHaveBeenCalled();
    expect(
      androidStorageMocks.archiveAndroidStorageDirectory,
    ).toHaveBeenCalledWith(preferredDir, preferredArchive);
    expect(result.html).toContain("0001-page-1.png");
    expect(result.html).toContain("0002-page-2.png");
    expect(result.mediaBytes).toBe(14);
  });

  it("stores Android media directly at the final path", async () => {
    vi.stubGlobal("navigator", { userAgent: "Android" });
    pluginMediaFetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/jpeg" },
        status: 200,
        statusText: "OK",
      }),
    );
    androidStorageMocks.readAndroidStorageText.mockResolvedValue(null);
    androidStorageMocks.writeAndroidStorageBytes.mockResolvedValue(undefined);
    androidStorageMocks.writeAndroidStorageText.mockResolvedValue(undefined);
    androidStorageMocks.archiveAndroidStorageDirectory.mockResolvedValue(3);

    const result = await cacheHtmlChapterMedia({
      baseUrl: "https://source.test/chapter/1",
      chapterId: 42,
      chapterName: "Chapter",
      chapterNumber: "1",
      chapterPosition: 1,
      html: `<img src="https://source.test/page-1.jpg">`,
      novelId: 7,
      novelName: "Novel",
      novelPath: "novel/path",
      sourceId: "source-a",
    });

    expect(androidStorageMocks.writeAndroidStorageBytes).toHaveBeenCalledWith(
      "contents/source-a/Novel-novel-path/1-Chapter/media/0001-page-1.jpg",
      new Uint8Array([1, 2, 3]),
      "image/jpeg",
    );
    expect(androidStorageMocks.renameAndroidStoragePath).not.toHaveBeenCalled();
    expect(androidStorageMocks.deleteAndroidStoragePath).not.toHaveBeenCalled();
    expect(androidStorageMocks.extractAndroidStorageZip).not.toHaveBeenCalled();
    expect(result.storedMediaCount).toBe(1);
    expect(result.html).toContain(
      'src="norea-media://reader-asset/0001-page-1.jpg"',
    );
  });

  it("refetches reusable repair media after preparing the workspace", async () => {
    let workspacePrepared = false;
    pluginMediaFetchMock.mockResolvedValue(
      new Response(new Uint8Array([4, 5]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      }),
    );
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") {
        workspacePrepared = true;
        return null;
      }
      if (command === "chapter_media_total_size") {
        return workspacePrepared ? 0 : 7;
      }
      if (command === "chapter_media_archive_cache") return 5;
      if (command === "chapter_media_read_manifest") return null;
      const input = args as {
        chapterId: number;
        fileName: string;
      };
      return `norea-media://reader-asset/${input.fileName}`;
    });

    const result = await cacheHtmlChapterMedia({
      baseUrl: "https://source.test/chapter/1",
      chapterId: 42,
      html: `<img src="/page-1.png">`,
      previousHtml: `<img src="norea-media://reader-asset/page-1.png">`,
      repair: true,
    });

    expect(pluginMediaFetchMock).toHaveBeenCalledWith(
      "https://source.test/page-1.png",
      expect.anything(),
    );
    expect(result.html).toContain("0001-page-1.png");
  });

  it("preserves mixed srcset candidate positions when reusing partial media", async () => {
    pluginMediaFetchMock.mockImplementation(async () => {
      return new Response(new Uint8Array([4, 5]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      });
    });
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_total_size") return 7;
      if (command === "chapter_media_archive_cache") return 5;
      if (command === "chapter_media_read_manifest") return null;
      const input = args as {
        chapterId: number;
        fileName: string;
      };
      return `norea-media://reader-asset/${input.fileName}`;
    });

    const result = await cacheHtmlChapterMedia({
      baseUrl: "https://source.test/chapter/1",
      chapterId: 42,
      html: `<img srcset="/small.png 1x, /large.png 2x">`,
      previousHtml:
        `<img srcset="https://source.test/small.png 1x, ` +
        `norea-media://reader-asset/large.png 2x">`,
      repair: true,
    });

    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
    expect(pluginMediaFetchMock).toHaveBeenCalledWith(
      "https://source.test/small.png",
      expect.objectContaining({
        contextUrl: "https://source.test/chapter/1",
      }),
    );
    expect(result.html).toContain(
      "norea-media://reader-asset/large.png 2x",
    );
    expect(result.html).toContain(
      "norea-media://reader-asset/0001-small.png 1x",
    );
  });

  it("refetches reusable media when the stored local file is missing", async () => {
    pluginMediaFetchMock.mockImplementation(async () => {
      return new Response(new Uint8Array([4, 5]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      });
    });
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_total_size") return 0;
      if (command === "chapter_media_archive_cache") return 5;
      if (command === "chapter_media_read_manifest") return null;
      const input = args as {
        chapterId: number;
        fileName: string;
      };
      return `norea-media://reader-asset/${input.fileName}`;
    });

    const result = await cacheHtmlChapterMedia({
      baseUrl: "https://source.test/chapter/1",
      chapterId: 42,
      html: `<img src="/page-1.png">`,
      previousHtml: `<img src="norea-media://reader-asset/page-1.png">`,
      repair: true,
    });

    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
    expect(pluginMediaFetchMock).toHaveBeenCalledWith(
      "https://source.test/page-1.png",
      expect.objectContaining({
        contextUrl: "https://source.test/chapter/1",
        headers: expect.objectContaining({ Accept: expect.any(String) }),
        signal: undefined,
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "chapter_media_store",
      expect.objectContaining({
        fileName: "0001-page-1.png",
      }),
    );
    expect(result.html).toContain("0001-page-1.png");
    expect(result.html).not.toContain("norea-media://reader-asset/page-1.png");
  });

  it("keeps reader asset prefixes in stored repair HTML", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_read_manifest") return null;
      if (command === "chapter_media_write_manifest") return null;
      throw new Error(`unexpected command: ${command}`);
    });

    const result = await cacheHtmlChapterMedia({
      chapterId: 27,
      html: [
        `<img src="norea-media://reader-asset/page.png">`,
        [
          `<div style="background:url('`,
          `norea-media://reader-asset/cover.png`,
          `')"></div>`,
        ].join(""),
      ].join(""),
      repair: true,
    });

    expect(pluginMediaFetchMock).not.toHaveBeenCalled();
    expect(result.html).toContain(
      'src="norea-media://reader-asset/page.png"',
    );
    expect(result.html).toContain("norea-media://reader-asset/cover.png");
  });
});

describe("stored chapter media byte stats", () => {
  it("deduplicates local media refs before measuring stored files", async () => {
    invokeMock.mockResolvedValueOnce(7);

    const html = [
      `<img src="norea-media://reader-asset/page.png">`,
      `<img data-src="norea-media://reader-asset/page.png">`,
      `<style>.cover{background:url("norea-media://reader-asset/cover.png")}</style>`,
      `<img src="https://source.test/page.png">`,
    ].join("");

    expect(localChapterMediaSources(html)).toEqual([
      "norea-media://reader-asset/page.png",
      "norea-media://reader-asset/cover.png",
    ]);
    await expect(getStoredChapterMediaBytes(html)).resolves.toBe(7);
    expect(invokeMock).toHaveBeenCalledWith("chapter_media_total_size", {
      mediaSrcs: [
        "norea-media://reader-asset/page.png",
        "norea-media://reader-asset/cover.png",
      ],
    });
  });

  it("canonicalizes relative and stale local refs with the current chapter context", async () => {
    const context = {
      chapterId: 27,
      chapterName: "Chapter 27",
      chapterNumber: "27",
      chapterPosition: 27,
    };
    const html = [
      `<img src="page.png">`,
      `<img src="norea-media://reader-asset/old.png">`,
      `<div style="background:url('cover.png')"></div>`,
    ].join("");

    expect(new Set(localChapterMediaSources(html, context))).toEqual(
      new Set([
        "norea-media://reader-asset/page.png",
        "norea-media://reader-asset/old.png",
        "norea-media://reader-asset/cover.png",
      ]),
    );

    invokeMock.mockResolvedValueOnce(11);
    await expect(getStoredChapterMediaBytes("page.png", context)).resolves.toBe(
      11,
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "chapter_media_total_size",
      expect.objectContaining({
        chapterId: 27,
        mediaSrcs: ["norea-media://reader-asset/page.png"],
      }),
    );
  });

  it("keeps nested reader asset paths intact", () => {
    const nestedSrc = "norea-media://reader-asset/panels/old/page.png";
    const html = `<img src="${nestedSrc}">`;

    expect(localChapterMediaSources(html)).toEqual([nestedSrc]);
  });
});

describe("restoreProtectedRemoteChapterMediaSources", () => {
  it("restores partial download media sources before repair", () => {
    const baseUrl = "https://source.test/chapter/1";
    const protectedHtml = protectRemoteChapterMediaForPartialHtml(
      [
        `<img src="/page.png">`,
        `<img srcset="/small.png 1x, /large.png 2x">`,
      ].join(""),
      baseUrl,
    );

    const restored = restoreProtectedRemoteChapterMediaSources(
      protectedHtml,
      baseUrl,
    );

    expect(restored).toContain('src="https://source.test/page.png"');
    expect(restored).toContain('srcset="/small.png 1x, /large.png 2x"');
  });
});

describe("resolveLocalChapterMedia", () => {
  it("loads Android archives from the current chapter context", async () => {
    vi.stubGlobal("navigator", { userAgent: "Android" });
    androidStorageMocks.prepareAndroidReaderMediaCache.mockResolvedValue(
      undefined,
    );

    const html = await resolveLocalChapterMedia(
      `<img src="norea-media://reader-asset/page.png">`,
      { chapterId: 95 },
    );

    expect(
      androidStorageMocks.prepareAndroidReaderMediaCache,
    ).toHaveBeenCalledWith(
      "chapter-media/95/media",
      "chapter-media/95/media.zip",
      expect.stringMatching(/^\d+-[a-z0-9]+$/),
    );
    expect(html).toMatch(
      /src="norea-media:\/\/reader-asset\/~cache\/[^/]+\/page\.png"/,
    );
  });

  it("prefers desktop asset URLs from stored media paths", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "chapter_media_path") {
        return "C:\\Users\\reader\\media\\page.png";
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const html = await resolveLocalChapterMedia(
      `<img src="norea-media://reader-asset/page.png">`,
    );

    expect(invokeMock).toHaveBeenCalledWith("chapter_media_path", {
      mediaSrc: "norea-media://reader-asset/page.png",
    });
    expect(convertFileSrcMock).toHaveBeenCalledWith(
      "C:\\Users\\reader\\media\\page.png",
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      "chapter_media_data_url",
      expect.anything(),
    );
    expect(html).toContain(
      'src="asset://localhost/C:\\Users\\reader\\media\\page.png"',
    );
  });

  it("rewrites cached chapter media to local data URLs", async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_path") {
        throw new Error("chapter media: file not found");
      }
      const { mediaSrc } = args as { mediaSrc: string };
      return `data:image/png;base64,${mediaSrc.split("/").pop()}`;
    });

    const html = await resolveLocalChapterMedia(
      [
        `<img src="norea-media://reader-asset/page.png">`,
        `<img data-src="norea-media://reader-asset/lazy.png">`,
        [
          `<img srcset="norea-media://reader-asset/small.png 1x, `,
          `norea-media://reader-asset/large.png 2x">`,
        ].join(""),
        `<video poster="norea-media://reader-asset/poster.png"></video>`,
        `<object data="norea-media://reader-asset/panel.svg"></object>`,
        `<link rel="preload" as="image" href="norea-media://reader-asset/preload.png">`,
        `<svg><image href="norea-media://reader-asset/svg-href.png"></image></svg>`,
        `<svg><image xlink:href="norea-media://reader-asset/svg-xlink.png"></image></svg>`,
        `<svg><use href="norea-media://reader-asset/svg-use.svg"></use></svg>`,
        `<div style="background-image:url('norea-media://reader-asset/bg.png')"></div>`,
        `<style>.cover{background:url("norea-media://reader-asset/cover.png")}</style>`,
        `<img src="https://source.test/page.png">`,
      ].join(""),
    );

    expect(invokeMock).toHaveBeenCalledWith("chapter_media_data_url", {
      mediaSrc: "norea-media://reader-asset/page.png",
    });
    expect(html).toContain('src="data:image/png;base64,page.png"');
    expect(html).toContain('src="data:image/png;base64,lazy.png"');
    expect(html).toContain("data:image/png;base64,small.png 1x");
    expect(html).toContain("data:image/png;base64,large.png 2x");
    expect(html).toContain('poster="data:image/png;base64,poster.png"');
    expect(html).toContain('data="data:image/png;base64,panel.svg"');
    expect(html).toContain('href="data:image/png;base64,preload.png"');
    expect(html).toContain('href="data:image/png;base64,svg-href.png"');
    expect(html).toContain('xlink:href="data:image/png;base64,svg-xlink.png"');
    expect(html).toContain('href="data:image/png;base64,svg-use.svg"');
    expect(html).toContain("data:image/png;base64,bg.png");
    expect(html).toContain("data:image/png;base64,cover.png");
    expect(html).not.toContain("data-src=");
    expect(html).toContain('src="https://source.test/page.png"');
  });

  it("deduplicates repeated cached media sources while resolving HTML", async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_path") {
        throw new Error("chapter media: file not found");
      }
      const { mediaSrc } = args as { mediaSrc: string };
      return `data:image/png;base64,${mediaSrc.split("/").pop()}`;
    });

    const repeated = "norea-media://reader-asset/page.png";
    const html = await resolveLocalChapterMedia(
      [
        `<img src="${repeated}">`,
        `<img data-src="${repeated}">`,
        `<img srcset="${repeated} 1x, norea-media://reader-asset/large.png 2x">`,
        `<div style="background-image:url('${repeated}')"></div>`,
      ].join(""),
    );

    const requestedSources = invokeMock.mock.calls
      .filter(([command]) => command === "chapter_media_data_url")
      .map(([, args]) => (args as { mediaSrc: string }).mediaSrc)
      .sort();
    expect(requestedSources).toEqual([
      "norea-media://reader-asset/large.png",
      repeated,
    ]);
    expect(html).toContain('src="data:image/png;base64,page.png"');
    expect(html).toContain("data:image/png;base64,page.png 1x");
    expect(html).toContain("data:image/png;base64,large.png 2x");
    expect(html).toContain("data:image/png;base64,page.png");
  });
});

describe("resolveLocalChapterMediaPatches", () => {
  it("resolves Android archive media to local resource URLs", async () => {
    vi.stubGlobal("navigator", { userAgent: "Android" });
    androidStorageMocks.androidStoragePathSize.mockImplementation(
      async (path: string) => (path.endsWith("/media.zip") ? 12 : 0),
    );
    androidStorageMocks.androidStorageZipEntryExists.mockResolvedValue(true);

    const repeated = "norea-media://reader-asset/page.png";
    const patches = await resolveLocalChapterMediaPatches(
      [
        {
          attributes: {
            src: repeated,
          },
          index: 0,
          sourceAttributes: {
            src: repeated,
          },
        },
        {
          attributes: {
            srcset: `${repeated} 1x, norea-media://reader-asset/large.png 2x`,
            style: `background-image:url('${repeated}')`,
          },
          index: 1,
          sourceAttributes: {
            srcset: `${repeated} 1x, norea-media://reader-asset/large.png 2x`,
            style: `background-image:url('${repeated}')`,
          },
        },
      ],
      { chapterId: 42 },
    );

    expect(androidStorageMocks.readAndroidStorageDataUrl).not.toHaveBeenCalled();
    expect(
      androidStorageMocks.readAndroidStorageZipEntryDataUrl,
    ).not.toHaveBeenCalled();
    expect(
      androidStorageMocks.prepareAndroidReaderMediaCache,
    ).toHaveBeenCalledWith(
      "chapter-media/42/media",
      "chapter-media/42/media.zip",
      expect.stringMatching(/^\d+-[a-z0-9]+$/),
    );
    expect(patches).toHaveLength(2);
    expect(patches[0]?.attributes.src).toMatch(
      /^norea-media:\/\/reader-asset\/~cache\/[^/]+\/page\.png$/,
    );
    expect(patches[1]?.attributes.srcset).toMatch(
      /norea-media:\/\/reader-asset\/~cache\/[^/]+\/page\.png 1x/,
    );
    expect(patches[1]?.attributes.srcset).toMatch(
      /norea-media:\/\/reader-asset\/~cache\/[^/]+\/large\.png 2x/,
    );
    expect(patches[1]?.attributes.style).toMatch(
      /url\("norea-media:\/\/reader-asset\/~cache\/[^/]+\/page\.png"\)/,
    );
  });

  it("resolves relative and stale Android archive refs against the current context", async () => {
    vi.stubGlobal("navigator", { userAgent: "Android" });
    androidStorageMocks.androidStoragePathSize.mockImplementation(
      async (path: string) => (path.endsWith("/media.zip") ? 12 : 0),
    );
    androidStorageMocks.androidStorageZipEntryExists.mockResolvedValue(true);

    const patches = await resolveLocalChapterMediaPatches(
      [
        {
          attributes: {
            src: "page.png",
          },
          index: 0,
          sourceAttributes: {
            src: "page.png",
          },
        },
        {
          attributes: {
            srcset: "norea-media://reader-asset/large.png 2x",
          },
          index: 1,
          sourceAttributes: {
            srcset: "norea-media://reader-asset/large.png 2x",
          },
        },
      ],
      { chapterId: 27 },
    );

    expect(
      androidStorageMocks.prepareAndroidReaderMediaCache,
    ).toHaveBeenCalledWith(
      "chapter-media/27/media",
      "chapter-media/27/media.zip",
      expect.stringMatching(/^\d+-[a-z0-9]+$/),
    );
    expect(patches[0]?.attributes.src).toMatch(
      /^norea-media:\/\/reader-asset\/~cache\/[^/]+\/page\.png$/,
    );
    expect(patches[1]?.attributes.srcset).toMatch(
      /norea-media:\/\/reader-asset\/~cache\/[^/]+\/large\.png 2x/,
    );
  });

  it("prepares Android reader cache from the media directory before the archive", async () => {
    vi.stubGlobal("navigator", { userAgent: "Android" });

    const patches = await resolveLocalChapterMediaPatches(
      [
        {
          attributes: {
            src: "page.png",
          },
          index: 0,
          sourceAttributes: {
            src: "page.png",
          },
        },
      ],
      {
        chapterId: 42,
        chapterName: "Chapter",
        chapterNumber: "7",
        chapterPosition: 7,
        novelId: 1,
        novelName: "Novel",
        novelPath: "novel/path",
        sourceId: "source-a",
      },
    );

    expect(
      androidStorageMocks.prepareAndroidReaderMediaCache,
    ).toHaveBeenCalledWith(
      "contents/source-a/Novel-novel-path/7-Chapter/media",
      "contents/source-a/Novel-novel-path/7-Chapter/media.zip",
      expect.stringMatching(/^\d+-[a-z0-9]+$/),
    );
    expect(patches[0]?.attributes.src).toMatch(
      /^norea-media:\/\/reader-asset\/~cache\/[^/]+\/page\.png$/,
    );
  });

  it("leaves scoped Android reader media URLs as resolved resources", async () => {
    vi.stubGlobal("navigator", { userAgent: "Android" });

    const scoped = "norea-media://reader-asset/~cache/42-abcd/page.png";
    const patches = await resolveLocalChapterMediaPatches(
      [
        {
          attributes: { src: scoped },
          index: 0,
          sourceAttributes: { src: scoped },
        },
      ],
      { chapterId: 42 },
    );

    expect(
      androidStorageMocks.prepareAndroidReaderMediaCache,
    ).not.toHaveBeenCalled();
    expect(patches).toEqual([]);
  });

  it("deduplicates repeated cached media sources across a patch batch", async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "chapter_media_path") {
        throw new Error("chapter media: file not found");
      }
      const { mediaSrc } = args as { mediaSrc: string };
      return `data:image/png;base64,${mediaSrc.split("/").pop()}`;
    });

    const repeated = "norea-media://reader-asset/page.png";
    const patches = await resolveLocalChapterMediaPatches([
      {
        attributes: {
          src: repeated,
        },
        index: 0,
        sourceAttributes: {
          src: repeated,
        },
      },
      {
        attributes: {
          srcset: `${repeated} 1x, norea-media://reader-asset/large.png 2x`,
          style: `background-image:url('${repeated}')`,
        },
        index: 1,
        sourceAttributes: {
          srcset: `${repeated} 1x, norea-media://reader-asset/large.png 2x`,
          style: `background-image:url('${repeated}')`,
        },
      },
    ]);

    const requestedSources = invokeMock.mock.calls
      .filter(([command]) => command === "chapter_media_data_url")
      .map(([, args]) => (args as { mediaSrc: string }).mediaSrc)
      .sort();
    expect(requestedSources).toEqual([
      "norea-media://reader-asset/large.png",
      repeated,
    ]);
    expect(patches).toHaveLength(2);
    expect(patches[0]?.attributes.src).toBe(
      "data:image/png;base64,page.png",
    );
    expect(patches[1]?.attributes.srcset).toContain(
      "data:image/png;base64,page.png 1x",
    );
    expect(patches[1]?.attributes.srcset).toContain(
      "data:image/png;base64,large.png 2x",
    );
    expect(patches[1]?.attributes.style).toContain(
      'url("data:image/png;base64,page.png")',
    );
  });
});
