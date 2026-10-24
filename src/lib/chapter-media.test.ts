import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { load } from "cheerio";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("./http", () => ({
  pluginMediaFetch: vi.fn(),
  takeCapturedMediaHandle: vi.fn(),
}));
const androidStorageMocks = vi.hoisted(() => ({
  androidStoragePathSize: vi.fn(),
  androidStorageZipEntrySizes: vi.fn(),
  androidStorageZipEntryExists: vi.fn(),
  archiveAndroidStorageDirectory: vi.fn(),
  clearAndroidStorageRoot: vi.fn(),
  deleteAndroidStoragePath: vi.fn(),
  deleteAndroidStoragePaths: vi.fn(),
  extractAndroidStorageZip: vi.fn(),
  prepareAndroidReaderMediaCache: vi.fn(),
  prepareAndroidChapterMediaRepair: vi.fn().mockResolvedValue(new Map()),
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

import { invoke } from "@tauri-apps/api/core";
import { getChapterById } from "../db/queries/chapter";
import { getNovelById } from "../db/queries/novel";
import {
  cacheHtmlChapterMedia,
  clearChapterMedia,
  getStoredChapterMediaBytes,
  localChapterMediaSources,
  protectRemoteChapterMediaForPartialHtml,
  resolveLocalChapterMedia,
  resolveLocalChapterMediaPatches,
  restoreProtectedRemoteChapterMediaSources,
  storeEmbeddedChapterMedia,
} from "./chapter-media";
import { pluginMediaFetch, takeCapturedMediaHandle } from "./http";
import { storeChapterMedia } from "./chapter-media/storage";
import { SourceAccessRequiredError } from "./plugins/source-access";
import { usePluginVpnStore } from "../store/plugin-vpn";
import { PLUGIN_VPN_READY_TIMEOUT_MS } from "./plugin-vpn-traffic";
import { waitForChapterDownloadWrites } from "./chapter-download-writes";

const invokeMock = vi.mocked(invoke);
const pluginMediaFetchMock = vi.mocked(pluginMediaFetch);
const takeCapturedMediaHandleMock = vi.mocked(takeCapturedMediaHandle);
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

function mockChapterMediaInvoke(
  implementation: Parameters<typeof invokeMock.mockImplementation>[0],
): void {
  invokeMock.mockImplementation(async (command, args) => {
    if (command === "native_stream_create") return nativeStreamInfo("media-1");
    if (command === "native_stream_write_chunk") {
      const { chunk, offset } = args as { chunk: number[]; offset: number };
      return nativeStreamInfo("media-1", offset + chunk.length);
    }
    if (command === "native_stream_finish") return nativeStreamInfo("media-1", 0, true);
    return implementation(command, args);
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
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
  pluginMediaFetchMock.mockReset();
  takeCapturedMediaHandleMock.mockReset();
  takeCapturedMediaHandleMock.mockResolvedValue(null);
  getChapterByIdMock.mockReset();
  getNovelByIdMock.mockReset();
  Object.values(androidStorageMocks).forEach((mock) => mock.mockReset());
  androidStorageMocks.prepareAndroidReaderMediaCache.mockResolvedValue(undefined);
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  installTemplateDocument();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("requires the current native media store command", async () => {
  mockChapterMediaInvoke(async (command) => {
    if (command === "chapter_media_store_handle") {
      throw new Error("unknown command: chapter_media_store_handle");
    }
    return null;
  });
  await expect(storeChapterMedia({
    body: new Uint8Array([1]),
    chapterId: 42,
    fileName: "page.png",
    novelId: 7,
    sourceNovelId: "novel",
    sourceId: "demo",
  })).rejects.toThrow("unknown command: chapter_media_store_handle");
  expect(invokeMock).toHaveBeenCalledWith("native_stream_cancel", { handle: "media-1" });
});

describe("cacheHtmlChapterMedia", () => {
  it("allows deletion while a media response body is still downloading", async () => {
    const body = createDeferred<ArrayBuffer>();
    const bodyStarted = createDeferred<void>();
    const controller = new AbortController();
    const response = new Response();
    vi.spyOn(response, "arrayBuffer").mockImplementation(() => {
      bodyStarted.resolve();
      return body.promise;
    });
    pluginMediaFetchMock.mockResolvedValue(response);
    invokeMock.mockResolvedValue(null);
    const download = cacheHtmlChapterMedia({
      chapterId: 42,
      html: `<img src="https://source.test/page.png">`,
      signal: controller.signal,
    });
    const cancelled = expect(download).rejects.toMatchObject({ name: "AbortError" });

    await bodyStarted.promise;
    controller.abort();
    await waitForChapterDownloadWrites([42]);
    const callsAtDeletion = invokeMock.mock.calls.length;
    body.resolve(new Uint8Array([1, 2, 3]).buffer);

    await cancelled;
    expect(invokeMock.mock.calls).toHaveLength(callsAtDeletion);
  });

  it("drains an active media store before deletion and skips later publication", async () => {
    const localWrite = createDeferred<string>();
    const writeStarted = createDeferred<void>();
    const controller = new AbortController();
    const events: string[] = [];
    pluginMediaFetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    mockChapterMediaInvoke(async (command) => {
      if (command === "chapter_media_store_handle") {
        writeStarted.resolve();
        const src = await localWrite.promise;
        events.push("write");
        return src;
      }
      return null;
    });
    const download = cacheHtmlChapterMedia({
      chapterId: 42,
      html: `<img src="https://source.test/page.png">`,
      signal: controller.signal,
    });
    const cancelled = expect(download).rejects.toMatchObject({ name: "AbortError" });

    await writeStarted.promise;
    controller.abort();
    const deletion = waitForChapterDownloadWrites([42]).then(() => {
      events.push("delete");
    });
    await waitForChapterDownloadWrites([43]);
    expect(events).toEqual([]);
    const callsAtCancellation = invokeMock.mock.calls.length;
    localWrite.resolve("norea-media://reader-asset/page.png");

    await Promise.all([cancelled, deletion]);
    expect(events).toEqual(["write", "delete"]);
    expect(invokeMock.mock.calls).toHaveLength(callsAtCancellation);
  });

  it("does not prepare a workspace for an already cancelled download", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(cacheHtmlChapterMedia({
      chapterId: 42,
      html: `<img src="https://source.test/page.png">`,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(invokeMock).not.toHaveBeenCalledWith(
      "chapter_media_prepare_workspace",
      expect.anything(),
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      "chapter_media_write_manifest",
      expect.anything(),
    );
  });

  it.each(["chapter_media_write_manifest", "chapter_media_archive_cache"])(
    "preserves cancellation during %s finalization",
    async (cancelCommand) => {
      const controller = new AbortController();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      mockChapterMediaInvoke(async (command) => {
        if (command === cancelCommand) controller.abort();
        return command === "chapter_media_archive_cache" ? 0 : null;
      });

      try {
        await expect(cacheHtmlChapterMedia({
          chapterId: 42,
          html: "<p>Chapter</p>",
          repair: true,
          signal: controller.signal,
        })).rejects.toMatchObject({ name: "AbortError" });

        expect(warnSpy).not.toHaveBeenCalled();
        if (cancelCommand === "chapter_media_write_manifest") {
          expect(invokeMock).not.toHaveBeenCalledWith(
            "chapter_media_archive_cache",
            expect.anything(),
          );
        }
      } finally {
        warnSpy.mockRestore();
      }
    },
  );

  it("finishes the current resource without starting another after yield", async () => {
    const activeResponse = createDeferred<Response>();
    let shouldYield = false;
    pluginMediaFetchMock
      .mockImplementationOnce(() => activeResponse.promise)
      .mockResolvedValue(
        new Response(new Uint8Array([3]), {
          headers: { "content-type": "image/png" },
          status: 200,
        }),
      );
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_read_manifest") return null;
      if (command === "chapter_media_archive_cache") return 6;
      if (command === "chapter_media_store_handle") {
        const input = args as { fileName: string };
        return `norea-media://reader-asset/${input.fileName}`;
      }
      return null;
    });

    const resultPromise = cacheHtmlChapterMedia({
      baseUrl: "https://source.test/chapter/",
      chapterId: 42,
      chapterName: "Opening",
      chapterNumber: "1",
      chapterPosition: 1,
      html: [
        `<img src="page-1.png">`,
        `<img src="page-2.png">`,
        `<img src="page-3.png">`,
      ].join(""),
      novelId: 9,
      novelName: "Sample Novel",
      sourceNovelId: "novel",
      shouldYield: () => shouldYield,
      sourceId: "demo",
    });

    await vi.waitFor(() => {
      expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
    });
    shouldYield = true;
    activeResponse.resolve(
      new Response(new Uint8Array([1]), {
        headers: { "content-type": "image/png" },
        status: 200,
      }),
    );

    await expect(resultPromise).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
  });

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
    mockChapterMediaInvoke(async (command, args) => {
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
      sourceNovelId: "novel",
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
      "chapter_media_store_handle",
      expect.objectContaining({
        handle: "media-1",
        chapterId: 42,
        chapterName: "Opening",
        chapterNumber: "1",
        chapterPosition: 1,
        fileName: "0001-page.png",
        novelId: 9,
        novelName: "Sample Novel",
        sourceNovelId: "novel",
        sourceId: "demo",
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "chapter_media_store_handle",
      expect.objectContaining({
        handle: "media-1",
        chapterId: 42,
        chapterName: "Opening",
        chapterNumber: "1",
        chapterPosition: 1,
        fileName: "0002-cover.webp",
        novelId: 9,
        novelName: "Sample Novel",
        sourceNovelId: "novel",
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
        sourceNovelId: "novel",
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

  it("stores desktop media through a native stream handle with the current native protocol", async () => {
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
      sourceNovelId: "novel",
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
      sourceNovelId: "novel",
      sourceId: "demo",
    });
    expect(result.html).toContain(
      'src="norea-media://reader-asset/0001-page.png"',
    );
  });

  it("stores a captured Windows response handle without renderer byte copies", async () => {
    takeCapturedMediaHandleMock.mockResolvedValueOnce({
      bodyBytes: 3,
      bodyHandle: "captured-media-1",
      finalUrl: "https://source.test/page.png",
      headers: { "content-type": "image/png" },
      status: 200,
      statusText: "OK",
    });
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_read_manifest") return null;
      if (command === "chapter_media_store_handle") {
        const input = args as { fileName: string };
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
      sourceNovelId: "novel",
      scraperExecutor: "pool:1",
      sourceId: "demo",
    });

    expect(pluginMediaFetchMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("chapter_media_store_handle", {
      chapterId: 42,
      fileName: "0001-page.png",
      handle: "captured-media-1",
      novelId: 9,
      sourceNovelId: "novel",
      sourceId: "demo",
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "native_stream_create",
      expect.anything(),
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      "native_stream_write_chunk",
      expect.anything(),
    );
    expect(result.mediaBytes).toBe(3);
    expect(result.html).toContain(
      'src="norea-media://reader-asset/0001-page.png"',
    );
  });

  it("stores captured media handles through a bounded parallel window", async () => {
    const mediaCount = 5;
    const storeGates = Array.from({ length: mediaCount }, () =>
      createDeferred<string>(),
    );
    let activeStores = 0;
    let maxActiveStores = 0;
    let startedStores = 0;
    takeCapturedMediaHandleMock.mockImplementation(async (url) => {
      const fileName = new URL(url).pathname.split("/").at(-1) ?? "page.png";
      return {
        bodyBytes: 3,
        bodyHandle: `captured-${fileName}`,
        finalUrl: url,
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      };
    });
    mockChapterMediaInvoke(async (command) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_read_manifest") return null;
      if (command === "chapter_media_store_handle") {
        const gate = storeGates[startedStores];
        startedStores += 1;
        activeStores += 1;
        maxActiveStores = Math.max(maxActiveStores, activeStores);
        return gate.promise.finally(() => {
          activeStores -= 1;
        });
      }
      if (command === "chapter_media_archive_cache") return mediaCount * 3;
      if (command === "chapter_media_write_manifest") return null;
      if (command === "chapter_media_total_size") return 0;
      throw new Error(`unexpected command: ${command}`);
    });

    const resultPromise = cacheHtmlChapterMedia({
      baseUrl: "https://source.test/chapter/1",
      chapterId: 42,
      html: Array.from(
        { length: mediaCount },
        (_, index) => `<img src="/page-${index + 1}.png">`,
      ).join(""),
      novelId: 9,
      sourceNovelId: "novel",
      scraperExecutor: "pool:1",
      sourceId: "demo",
    });

    let storesStartedBeforeRelease = 0;
    try {
      await vi.waitFor(
        () => {
          expect(startedStores).toBeGreaterThan(1);
        },
        { timeout: 100 },
      );
      storesStartedBeforeRelease = startedStores;
    } catch {
      storesStartedBeforeRelease = startedStores;
    } finally {
      storeGates.forEach((gate, index) => {
        gate.resolve(`norea-media://reader-asset/page-${index + 1}.png`);
      });
    }

    const result = await resultPromise;
    expect(storesStartedBeforeRelease).toBeGreaterThan(1);
    expect(maxActiveStores).toBeLessThanOrEqual(4);
    expect(pluginMediaFetchMock).not.toHaveBeenCalled();
    expect(result.storedMediaCount).toBe(mediaCount);
  });

  it("drains active media stores before surfacing a progress callback error", async () => {
    const mediaCount = 4;
    const storeGate = createDeferred<void>();
    const progressError = new Error("progress callback failed");
    let finishedStores = 0;
    let startedStores = 0;
    takeCapturedMediaHandleMock.mockImplementation(async (url) => ({
      bodyBytes: 3,
      bodyHandle: `captured-${new URL(url).pathname}`,
      finalUrl: url,
      headers: { "content-type": "image/png" },
      status: 200,
      statusText: "OK",
    }));
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_read_manifest") return null;
      if (command === "chapter_media_store_handle") {
        startedStores += 1;
        await storeGate.promise;
        finishedStores += 1;
        const input = args as { fileName: string };
        return `norea-media://reader-asset/${input.fileName}`;
      }
      if (command === "chapter_media_write_manifest") return null;
      if (command === "chapter_media_total_size") return 0;
      throw new Error(`unexpected command: ${command}`);
    });

    const resultPromise = cacheHtmlChapterMedia({
      baseUrl: "https://source.test/chapter/1",
      chapterId: 42,
      html: Array.from(
        { length: mediaCount },
        (_, index) => `<img src="/page-${index + 1}.png">`,
      ).join(""),
      novelId: 9,
      sourceNovelId: "novel",
      onProgress: () => {
        throw progressError;
      },
      scraperExecutor: "pool:1",
      sourceId: "demo",
    });

    await vi.waitFor(() => expect(startedStores).toBe(mediaCount));
    storeGate.resolve();

    await expect(resultPromise).rejects.toBe(progressError);
    expect(finishedStores).toBe(mediaCount);
    expect(invokeMock).not.toHaveBeenCalledWith(
      "chapter_media_archive_cache",
      expect.anything(),
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
    mockChapterMediaInvoke(async (command, args) => {
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
    mockChapterMediaInvoke(async (command, args) => {
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
    mockChapterMediaInvoke(async (command, args) => {
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
    mockChapterMediaInvoke(async (command, args) => {
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
      if (String(url).includes("/missing.png")) {
        throw new Error("CDN blocked");
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      });
    });
    mockChapterMediaInvoke(async (command, args) => {
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
        html: `<img src="./ok.png"><img src="https://source.test/signed/path-token/missing.png?token=query-secret">`,
      });

      expect(result.mediaFailures).toEqual([
        expect.objectContaining({
          message: "CDN blocked",
          url: "https://source.test/signed/path-token/missing.png?token=query-secret",
        }),
      ]);
      expect(result.storedMediaCount).toBe(1);
      expect(result.mediaBytes).toBe(3);
      expect(result.html).toContain(
        'src="norea-media://reader-asset/0001-ok.png"',
      );
      expect(result.html).toContain(
        'src="https://source.test/signed/path-token/missing.png?token=query-secret"',
      );
      expect(result.html).not.toContain('src=""');
      expect(result.html).not.toContain("data-norea-media");
      expect(warnSpy).toHaveBeenCalledWith(
        "[chapter-media] media asset using remote fallback",
        expect.objectContaining({ sanitizedUrl: "https://source.test" }),
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toMatch(
        /signed|path-token|query-secret/,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("retries transient network failures before storing media", async () => {
    vi.useFakeTimers();
    pluginMediaFetchMock
      .mockRejectedValueOnce(
        new Error("scraper: browser fetch failed: Failed to fetch"),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
          status: 200,
          statusText: "OK",
        }),
      );
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_archive_cache") return 3;
      if (command === "chapter_media_write_manifest") return null;
      const input = args as { fileName: string };
      return `norea-media://reader-asset/${input.fileName}`;
    });

    try {
      const pending = cacheHtmlChapterMedia({
        baseUrl: "https://source.test/chapter/1",
        chapterId: 42,
        html: `<img src="./page.png">`,
      });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(pluginMediaFetchMock).toHaveBeenCalledTimes(2);
      expect(result.mediaFailures).toEqual([]);
      expect(result.storedMediaCount).toBe(1);
      expect(result.html).toContain(
        'src="norea-media://reader-asset/0001-page.png"',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the remote URL after transient network retries are exhausted", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    pluginMediaFetchMock.mockRejectedValue(new TypeError("network error"));
    mockChapterMediaInvoke(async (command) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_archive_cache") return 0;
      if (command === "chapter_media_write_manifest") return null;
      return null;
    });

    try {
      const pending = cacheHtmlChapterMedia({
        baseUrl: "https://source.test/chapter/1",
        chapterId: 42,
        html: `<img src="./page.png">`,
      });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(pluginMediaFetchMock).toHaveBeenCalledTimes(3);
      expect(result.mediaFailures).toEqual([
        expect.objectContaining({
          message: "network error",
          url: "https://source.test/chapter/page.png",
        }),
      ]);
      expect(result.html).toContain('src="https://source.test/chapter/page.png"');
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not retry media requests that fail with an HTTP status", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    pluginMediaFetchMock.mockResolvedValue(
      new Response("missing", { status: 404, statusText: "Not Found" }),
    );
    mockChapterMediaInvoke(async (command) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_archive_cache") return 0;
      if (command === "chapter_media_write_manifest") return null;
      return null;
    });

    try {
      const result = await cacheHtmlChapterMedia({
        baseUrl: "https://source.test/chapter/1",
        chapterId: 42,
        html: `<img src="./page.png">`,
      });

      expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
      expect(result.mediaFailures).toEqual([
        expect.objectContaining({ status: 404 }),
      ]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  describe("strict offline completion", () => {
    it.each([false, true])("releases captured response streams before automatic retry (cleanup fails: %s)", async cleanupFails => {
      takeCapturedMediaHandleMock.mockResolvedValueOnce({
        bodyBytes: 3, bodyHandle: "retry-response", finalUrl: "https://source.test/page.png",
        headers: { "content-type": "text/plain", "retry-after": "30" }, status: 503, statusText: "Unavailable",
      });
      mockChapterMediaInvoke(async command => {
        if (command === "native_stream_cancel" && cleanupFails) throw new Error("already closed");
        return null;
      });
      await expect(cacheHtmlChapterMedia({
        baseUrl: "https://source.test/", chapterId: 42, scraperExecutor: "pool:1",
        html: '<img src="/page.png">', requireComplete: true,
      })).rejects.toMatchObject({ code: "chapter-media-http-retry", status: 503, retryAfterMs: 30000 });
      expect(invokeMock.mock.calls.filter(([command]) => command === "native_stream_cancel")).toEqual([
        ["native_stream_cancel", { handle: "retry-response" }],
      ]);
      expect(pluginMediaFetchMock).not.toHaveBeenCalled();
      expect(invokeMock).not.toHaveBeenCalledWith("chapter_media_archive_cache", expect.anything());
    });

    it("does not archive or report success when a permanent image is missing", async () => {
      pluginMediaFetchMock.mockResolvedValue(new Response(null, { status: 404 }));
      await expect(cacheHtmlChapterMedia({
        baseUrl: "https://source.test/", chapterId: 42,
        html: '<img src="./missing.png">', requireComplete: true,
      })).rejects.toMatchObject({ code: "chapter-media-incomplete" });
      expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
      expect(invokeMock).not.toHaveBeenCalledWith("chapter_media_archive_cache", expect.anything());
    });

    it.each([408, 429, 502, 503, 504])("propagates temporary HTTP %i to the task retry policy", async status => {
      pluginMediaFetchMock.mockResolvedValue(new Response(null, { status, headers: { "Retry-After": "30" } }));
      await expect(cacheHtmlChapterMedia({
        baseUrl: "https://source.test/", chapterId: 42,
        html: '<img src="./page.png">', requireComplete: true,
      })).rejects.toMatchObject({ code: "chapter-media-http-retry", status, retryAfterMs: 30000 });
      expect(invokeMock).not.toHaveBeenCalledWith("chapter_media_archive_cache", expect.anything());
    });

    it("hands exhausted fast network retries back to the durable task rather than remote fallback", async () => {
      vi.useFakeTimers();
      try {
        pluginMediaFetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
        const checked = expect(cacheHtmlChapterMedia({
          baseUrl: "https://source.test/", chapterId: 42,
          html: '<img src="./page.png">', requireComplete: true,
        })).rejects.toThrow("Failed to fetch");
        await vi.advanceTimersByTimeAsync(4000);
        await checked;
        expect(pluginMediaFetchMock).toHaveBeenCalledTimes(3);
        expect(invokeMock).not.toHaveBeenCalledWith("chapter_media_archive_cache", expect.anything());
      } finally { vi.useRealTimers(); }
    });
  });

  describe("VPN-aware media acquisition", () => {
    let vpnPhase: "connected" | "reconnecting";

    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      usePluginVpnStore.getState().setEnabled(true);
      vpnPhase = "connected";
      mockChapterMediaInvoke(async (command, args) => {
        if (command === "plugin_vpn_status") return {
          phase: vpnPhase, error: null, supported: true, proxyPort: 43127,
          profile: { remoteHost: "203.0.113.1", isVpnGateFinder: true, requiresUsernamePassword: false },
        };
        if (command === "chapter_media_store_handle") {
          return `norea-media://reader-asset/${(args as { fileName: string }).fileName}`;
        }
        if (command === "chapter_media_archive_cache") return 3;
        return null;
      });
      pluginMediaFetchMock.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), {
        status: 200, headers: { "content-type": "image/png" },
      }));
    });

    afterEach(() => {
      usePluginVpnStore.getState().setEnabled(false);
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    const download = (signal?: AbortSignal) => cacheHtmlChapterMedia({
      baseUrl: "https://source.test/chapter/1", chapterId: 42,
      html: '<img src="./page.png">', signal,
    });

    it("does not consume network retries during a 50-second VPN reconnect", async () => {
      pluginMediaFetchMock.mockImplementationOnce(async () => {
        vpnPhase = "reconnecting";
        throw new TypeError("Failed to fetch");
      });
      const pending = download();
      await vi.advanceTimersByTimeAsync(50_000);
      expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
      expect(invokeMock).not.toHaveBeenCalledWith("chapter_media_archive_cache", expect.anything());
      vpnPhase = "connected";
      await vi.advanceTimersByTimeAsync(500);
      const result = await pending;
      expect(pluginMediaFetchMock).toHaveBeenCalledTimes(2);
      expect(result.mediaFailures).toEqual([]);
      expect(result.storedMediaCount).toBe(1);
    });

    it("waits before starting a new request while the VPN is reconnecting", async () => {
      vpnPhase = "reconnecting";
      const pending = download();
      await vi.advanceTimersByTimeAsync(40_000);
      expect(pluginMediaFetchMock).not.toHaveBeenCalled();
      vpnPhase = "connected";
      await vi.advanceTimersByTimeAsync(500);
      expect((await pending).storedMediaCount).toBe(1);
    });

    it("does not publish remote fallback or a completed archive after VPN wait timeout", async () => {
      vpnPhase = "reconnecting";
      const checked = expect(download()).rejects.toMatchObject({ code: "plugin-vpn-unavailable" });
      await vi.advanceTimersByTimeAsync(PLUGIN_VPN_READY_TIMEOUT_MS);
      await checked;
      expect(pluginMediaFetchMock).not.toHaveBeenCalled();
      expect(invokeMock).not.toHaveBeenCalledWith("chapter_media_archive_cache", expect.anything());
      expect(console.warn).not.toHaveBeenCalledWith(
        "[chapter-media] media asset using remote fallback", expect.anything(),
      );
      expect(vi.getTimerCount()).toBe(0);
    });

    it("cancels a waiting image without marking it as remote fallback", async () => {
      vpnPhase = "reconnecting";
      const controller = new AbortController();
      const checked = expect(download(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await checked;
      expect(pluginMediaFetchMock).not.toHaveBeenCalled();
      expect(invokeMock).not.toHaveBeenCalledWith("chapter_media_archive_cache", expect.anything());
      expect(vi.getTimerCount()).toBe(0);
    });

    it("retries a plain-HTTP proxy 502 after a confirmed VPN recovery", async () => {
      pluginMediaFetchMock.mockImplementationOnce(async () => {
        vpnPhase = "reconnecting";
        return new Response(null, { status: 502 });
      });
      const pending = download();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
      vpnPhase = "connected";
      await vi.advanceTimersByTimeAsync(500);
      expect((await pending).mediaFailures).toEqual([]);
      expect(pluginMediaFetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not retry an origin 502 when the VPN remains connected", async () => {
      pluginMediaFetchMock.mockResolvedValue(new Response(null, { status: 502 }));
      const result = await download();
      expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
      expect(result.mediaFailures).toEqual([expect.objectContaining({ status: 502 })]);
    });

    it("retains the ordinary network retry budget across a separate VPN outage", async () => {
      pluginMediaFetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockImplementationOnce(async () => {
          vpnPhase = "reconnecting";
          throw new TypeError("Failed to fetch");
        })
        .mockRejectedValueOnce(new TypeError("network error"));
      const pending = download();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(pluginMediaFetchMock).toHaveBeenCalledTimes(2);
      vpnPhase = "connected";
      await vi.advanceTimersByTimeAsync(500);
      expect(pluginMediaFetchMock).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(3_000);
      expect((await pending).mediaFailures).toEqual([]);
      expect(pluginMediaFetchMock).toHaveBeenCalledTimes(4);
      const deadlines = pluginMediaFetchMock.mock.calls.map(([, request]) => request?.vpnReadyDeadline);
      expect(new Set(deadlines).size).toBe(1);
    });
  });

  it("propagates source access errors without using remote media fallbacks", async () => {
    const accessError = new SourceAccessRequiredError(
      "Complete the Cloudflare challenge.",
      {
        kind: "cloudflare",
        url: "https://source.test/chapter/1",
      },
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    pluginMediaFetchMock.mockRejectedValue(accessError);

    try {
      await expect(
        cacheHtmlChapterMedia({
          baseUrl: "https://cdn.test/assets/",
          chapterId: 42,
          contextUrl: "https://cdn.test/assets/",
          html: `<img src="./one.png"><img src="./two.png">`,
          sourceAccessUrl: "https://source.test/chapter/1",
        }),
      ).rejects.toBe(accessError);

      expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
      expect(pluginMediaFetchMock).toHaveBeenCalledWith(
        "https://cdn.test/assets/one.png",
        expect.objectContaining({
          contextUrl: "https://cdn.test/assets/",
          sourceAccessUrl: "https://source.test/chapter/1",
        }),
      );
      expect(warnSpy).not.toHaveBeenCalled();
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
    mockChapterMediaInvoke(async (command, args) => {
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
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_read_manifest") return null;
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

  it("finalizes the manifest when every media asset falls back to remote", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    pluginMediaFetchMock.mockRejectedValue(new Error("offline"));
    mockChapterMediaInvoke(async (command) => {
      if (command === "chapter_media_archive_cache") return 0;
      return null;
    });

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
      expect(invokeMock).toHaveBeenCalledWith("chapter_media_archive_cache", {
        chapterId: 42,
      });
      const manifestWrites = invokeMock.mock.calls.filter(
        ([command]) => command === "chapter_media_write_manifest",
      );
      expect(manifestWrites.length).toBeGreaterThan(0);
      expect(
        manifestWrites.every(
          ([, args]) =>
            (args as { complete?: boolean } | undefined)?.complete === false,
        ),
      ).toBe(true);
      expect(manifestWrites.at(-1)?.[1]).toEqual(
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

  it("keeps a remote-only manifest incomplete when finalization fails", async () => {
    const archiveError = new Error("manifest finalization failed");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    pluginMediaFetchMock.mockRejectedValue(new Error("offline"));
    mockChapterMediaInvoke(async (command) => {
      if (command === "chapter_media_archive_cache") throw archiveError;
      return null;
    });

    try {
      await expect(
        cacheHtmlChapterMedia({
          baseUrl: "https://source.test/chapter/1",
          chapterId: 42,
          html: `<img src="./one.png">`,
        }),
      ).rejects.toMatchObject({
        cause: archiveError,
        code: "chapter-media-finalization-failed",
        name: "ChapterMediaFinalizationError",
      });

      const manifestWrites = invokeMock.mock.calls.filter(
        ([command]) => command === "chapter_media_write_manifest",
      );
      expect(manifestWrites.length).toBeGreaterThan(0);
      expect(
        manifestWrites.every(
          ([, args]) =>
            (args as { complete?: boolean } | undefined)?.complete === false,
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("keeps the manifest incomplete when archive finalization fails", async () => {
    const archiveError = new Error("archive validation failed");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    pluginMediaFetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
        status: 200,
      }),
    );
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_archive_cache") throw archiveError;
      if (command === "chapter_media_total_size") return 3;
      if (command === "chapter_media_store_handle") {
        const input = args as { fileName: string };
        return `norea-media://reader-asset/${input.fileName}`;
      }
      return null;
    });

    try {
      await expect(
        cacheHtmlChapterMedia({
          baseUrl: "https://source.test/chapter/1",
          chapterId: 42,
          html: `<img src="./one.png">`,
        }),
      ).rejects.toMatchObject({
        cause: archiveError,
        code: "chapter-media-finalization-failed",
        name: "ChapterMediaFinalizationError",
      });

      const manifestWrites = invokeMock.mock.calls.filter(
        ([command]) => command === "chapter_media_write_manifest",
      );
      expect(manifestWrites.length).toBeGreaterThan(0);
      expect(
        manifestWrites.every(
          ([, args]) =>
            (args as { complete?: boolean } | undefined)?.complete === false,
        ),
      ).toBe(true);
      expect(invokeMock).not.toHaveBeenCalledWith(
        "chapter_media_total_size",
        expect.anything(),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("classifies final manifest publication failures as finalization errors", async () => {
    const manifestError = new Error("manifest publication failed");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let manifestWriteCount = 0;
    pluginMediaFetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
        status: 200,
      }),
    );
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_write_manifest") {
        manifestWriteCount += 1;
        if (manifestWriteCount === 3) throw manifestError;
        return null;
      }
      if (command === "chapter_media_archive_cache") return 3;
      if (command === "chapter_media_total_size") return 3;
      if (command === "chapter_media_store_handle") {
        const input = args as { fileName: string };
        return `norea-media://reader-asset/${input.fileName}`;
      }
      return null;
    });

    try {
      await expect(
        cacheHtmlChapterMedia({
          baseUrl: "https://source.test/chapter/1",
          chapterId: 42,
          html: `<img src="./one.png">`,
        }),
      ).rejects.toMatchObject({
        cause: manifestError,
        code: "chapter-media-finalization-failed",
        name: "ChapterMediaFinalizationError",
      });

      expect(manifestWriteCount).toBe(3);
      expect(invokeMock).not.toHaveBeenCalledWith(
        "chapter_media_archive_cache",
        expect.anything(),
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

  it("reuses stored local media and preserves other manifest entries during repair", async () => {
    const manifest = {
      complete: false,
      media: {
        files: [
          {
            bytes: 7,
            fileName: "page-1.png",
            path: "media/page-1.png",
            sourceUrl: "https://source.test/page-1.png",
            status: "stored",
            updatedAt: 1,
          },
          {
            bytes: 9,
            fileName: "author-note.png",
            path: "media/author-note.png",
            sourceUrl: "https://source.test/author-note.png",
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
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return { "page-1.png": 7, "author-note.png": 9 };
      if (command === "chapter_media_total_size") return 7;
      if (command === "chapter_media_archive_cache") return 5;
      if (command === "chapter_media_read_manifest") {
        return JSON.stringify(manifest);
      }
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
      "chapter_media_store_handle",
      expect.objectContaining({
        fileName: "0002-page-2.png",
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith("chapter_media_archive_cache", {
      chapterId: 42,
    });
    const manifestWrites = invokeMock.mock.calls.filter(
      ([command]) => command === "chapter_media_write_manifest",
    );
    expect(manifestWrites.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({
            fileName: "author-note.png",
            sourceUrl: "https://source.test/author-note.png",
            status: "stored",
          }),
        ]),
      }),
    );
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
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return { "0001-page-1.png": 3, "0003-page-3.png": 3 };
      if (command === "chapter_media_read_manifest") {
        return JSON.stringify(manifest);
      }
      if (command === "chapter_media_total_size") {
        const [mediaSrc] = (args as { mediaSrcs: string[] }).mediaSrcs;
        return (mediaSrc ?? "").includes("0002-page-2.png") ? 0 : 3;
      }
      if (command === "chapter_media_archive_cache") return 15;
      if (command === "chapter_media_write_manifest") return null;
      if (command === "chapter_media_store_handle") {
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
      "chapter_media_store_handle",
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

  it("preserves validated files with stale remote status and repairs only the missing asset", async () => {
    const manifest = {
      complete: false,
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
    pluginMediaFetchMock.mockImplementation(async () => {
      return new Response(new Uint8Array([4, 5]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      });
    });
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return { "0001-page-1.png": 3, "0003-page-3.png": 3 };
      if (command === "chapter_media_read_manifest") {
        return JSON.stringify(manifest);
      }
      if (command === "chapter_media_total_size") {
        const [mediaSrc] = (args as { mediaSrcs: string[] }).mediaSrcs;
        return (mediaSrc ?? "").includes("0002-page-2.png") ? 0 : 7;
      }
      if (command === "chapter_media_archive_cache") return 15;
      if (command === "chapter_media_write_manifest") return null;
      if (command === "chapter_media_store_handle") {
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
      repair: true,
    });

    expect(pluginMediaFetchMock.mock.calls.map(([url]) => url)).toEqual(["https://source.test/page-2.png"]);
    expect(result.storedMediaCount).toBe(1);
    expect(result.html).toContain("0001-page-1.png");
    expect(result.html).toContain("0002-page-2.png");
    expect(result.html).toContain("0003-page-3.png");
  });

  it("repairs every missing or corrupt manifest asset even without HTML references", async () => {
    const files = ["valid.png", "corrupt.png", "missing.png"].map(fileName => ({
      bytes: 3, fileName, path: `media/${fileName}`, sourceUrl: `https://source.test/${fileName}`,
      status: "stored", updatedAt: 1,
    }));
    pluginMediaFetchMock.mockImplementation(async () => new Response(new Uint8Array([4, 5, 6])));
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_read_manifest") return JSON.stringify({ version: 1, complete: false, updatedAt: 1, media: { files } });
      if (command === "chapter_media_prepare_workspace") return { "valid.png": 3 };
      if (command === "chapter_media_store_handle") return `norea-media://reader-asset/${(args as { fileName: string }).fileName}`;
      if (command === "chapter_media_archive_cache") return 100;
      return null;
    });
    const result = await cacheHtmlChapterMedia({ chapterId: 42, html: "<p>Unchanged body</p>", repair: true, requireComplete: true });
    expect(pluginMediaFetchMock.mock.calls.map(([url]) => url).sort()).toEqual([
      "https://source.test/corrupt.png", "https://source.test/missing.png",
    ]);
    expect(result.html).toBe("<p>Unchanged body</p>");
    expect(invokeMock).toHaveBeenCalledWith("chapter_media_write_manifest", expect.objectContaining({
      files: expect.arrayContaining([expect.objectContaining({ fileName: "valid.png", bytes: 3, status: "stored" })]),
    }));
  });

  it.each(["{", JSON.stringify({ version: 1, media: { files: [{ fileName: "../lost.png" }] } })])(
    "does not publish or clear artifacts when the repair manifest is invalid: %s", async raw => {
      mockChapterMediaInvoke(async command => command === "chapter_media_read_manifest" ? raw : null);
      await expect(cacheHtmlChapterMedia({ chapterId: 42, html: "<p>Body</p>", repair: true })).rejects.toThrow("repair manifest");
      expect(pluginMediaFetchMock).not.toHaveBeenCalled();
      expect(invokeMock).not.toHaveBeenCalledWith("chapter_media_write_manifest", expect.anything());
      expect(invokeMock).not.toHaveBeenCalledWith("chapter_media_archive_cache", expect.anything());
    },
  );

  it("retries only the failed asset after an incomplete repair preserves completed files", async () => {
    let files = ["good.png", "partial.png", "blocked.png"].map(fileName => ({
      bytes: 3, fileName, path: `media/${fileName}`, sourceUrl: `https://source.test/${fileName}`,
      status: "stored", updatedAt: 1,
    }));
    const staged: Record<string, number> = { "good.png": 3 };
    let blocked = true;
    pluginMediaFetchMock.mockImplementation(async url => new Response(new Uint8Array([4, 5, 6]), {
      status: blocked && url.endsWith("blocked.png") ? 404 : 200,
    }));
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_read_manifest") return JSON.stringify({ version: 1, complete: false, updatedAt: 1, media: { files } });
      if (command === "chapter_media_prepare_workspace") return { ...staged };
      if (command === "chapter_media_store_handle") {
        const { fileName } = args as { fileName: string };
        staged[fileName] = 3;
        return `norea-media://reader-asset/${fileName}`;
      }
      if (command === "chapter_media_write_manifest") files = (args as { files: typeof files }).files;
      if (command === "chapter_media_archive_cache") return 100;
      return null;
    });
    const options = { chapterId: 42, html: '<img src="norea-media://reader-asset/good.png">', repair: true, requireComplete: true };
    await expect(cacheHtmlChapterMedia(options)).rejects.toMatchObject({ code: "chapter-media-incomplete" });
    expect(invokeMock).not.toHaveBeenCalledWith("chapter_media_archive_cache", expect.anything());
    expect(staged).toEqual({ "good.png": 3, "partial.png": 3 });
    blocked = false;
    await cacheHtmlChapterMedia(options);
    expect(pluginMediaFetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://source.test/partial.png", "https://source.test/blocked.png", "https://source.test/blocked.png",
    ]);
    expect(files.every(file => file.status === "stored")).toBe(true);
    expect(invokeMock.mock.calls.filter(([command]) => command === "chapter_media_archive_cache")).toHaveLength(1);
  });

  it("starts chapter downloads without scanning every target file", async () => {
    pluginMediaFetchMock.mockImplementation(async () => {
      return new Response(new Uint8Array([4, 5]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      });
    });
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_read_manifest") return null;
      if (command === "chapter_media_total_size") {
        throw new Error("chapter downloads must not scan every target file");
      }
      if (command === "chapter_media_archive_cache") return 12;
      if (command === "chapter_media_write_manifest") return null;
      if (command === "chapter_media_store_handle") {
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
      "chapter_media_store_handle",
      expect.objectContaining({
        fileName: "0001-page-1.png",
      }),
    );
    expect(result.storedMediaCount).toBe(2);
    expect(result.mediaBytes).toBe(12);
    expect(result.html).toContain("0001-page-1.png");
    expect(result.html).toContain("0002-page-2.png");
  });

  it("reuses only exact stored manifest media during chapter downloads", async () => {
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
    pluginMediaFetchMock.mockImplementation(async () => {
      return new Response(new Uint8Array([4, 5]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      });
    });
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_read_manifest") {
        return JSON.stringify(manifest);
      }
      if (command === "chapter_media_total_size") {
        const [mediaSrc] = (args as { mediaSrcs: string[] }).mediaSrcs;
        if ((mediaSrc ?? "").includes("0001-page-1.png")) return 3;
        if ((mediaSrc ?? "").includes("0002-page-2.png")) return 3;
        return 2;
      }
      if (command === "chapter_media_archive_cache") return 15;
      if (command === "chapter_media_write_manifest") return null;
      if (command === "chapter_media_store_handle") {
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
    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(2);
    expect(pluginMediaFetchMock).toHaveBeenCalledWith(
      "https://source.test/page-2.png",
      expect.anything(),
    );
    expect(pluginMediaFetchMock).toHaveBeenCalledWith(
      "https://source.test/page-3.png",
      expect.anything(),
    );
    expect(pluginMediaFetchMock).not.toHaveBeenCalledWith(
      "https://source.test/page-1.png",
      expect.anything(),
    );
    const measuredMediaSources = invokeMock.mock.calls
      .filter(([command]) => command === "chapter_media_total_size")
      .flatMap(([, args]) => (args as { mediaSrcs: string[] }).mediaSrcs);
    expect(measuredMediaSources).toEqual([
      "norea-media://reader-asset/0001-page-1.png",
      "norea-media://reader-asset/0003-page-3.png",
    ]);
    expect(invokeMock).toHaveBeenCalledWith(
      "chapter_media_store_handle",
      expect.objectContaining({
        fileName: "0002-page-2.png",
      }),
    );
    const manifestWrites = invokeMock.mock.calls.filter(
      ([command]) => command === "chapter_media_write_manifest",
    );
    expect(manifestWrites.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        complete: false,
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
            bytes: 2,
            fileName: "0003-page-3.png",
            status: "stored",
          }),
        ]),
      }),
    );
    expect(result.storedMediaCount).toBe(2);
    expect(result.mediaBytes).toBe(15);
    expect(result.html).toContain("0001-page-1.png");
    expect(result.html).toContain("0002-page-2.png");
    expect(result.html).toContain("0003-page-3.png");
  });

  it("resets stale media when the current chapter HTML removes media", async () => {
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
            bytes: 4,
            fileName: "0002-removed.png",
            path: "media/0002-removed.png",
            sourceUrl: "https://source.test/removed.png",
            status: "stored",
            updatedAt: 1,
          },
        ],
      },
      updatedAt: 1,
      version: 1,
    };
    pluginMediaFetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
        status: 200,
      }),
    );
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_read_manifest") {
        return JSON.stringify(manifest);
      }
      if (command === "chapter_media_total_size") return 3;
      if (command === "chapter_media_archive_cache") return 5;
      if (command === "chapter_media_store_handle") {
        const input = args as { fileName: string };
        return `norea-media://reader-asset/${input.fileName}`;
      }
      return null;
    });

    const result = await cacheHtmlChapterMedia({
      baseUrl: "https://source.test/chapter/1",
      chapterId: 42,
      html: `<img src="https://source.test/page-1.png">`,
    });

    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
    expect(pluginMediaFetchMock).toHaveBeenCalledWith(
      "https://source.test/page-1.png",
      expect.anything(),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "chapter_media_prepare_workspace",
      expect.objectContaining({
        chapterId: 42,
        preserveExisting: false,
        repair: false,
      }),
    );
    const manifestWrites = invokeMock.mock.calls.filter(
      ([command]) => command === "chapter_media_write_manifest",
    );
    expect(manifestWrites.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        complete: false,
        files: [
          expect.objectContaining({
            bytes: 3,
            fileName: "0001-page-1.png",
            sourceUrl: "https://source.test/page-1.png",
            status: "stored",
          }),
        ],
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith("chapter_media_archive_cache", {
      chapterId: 42,
    });
    expect(result.mediaBytes).toBe(5);
  });

  it("removes Android transaction artifacts when changed media resets", async () => {
    vi.stubGlobal("navigator", { userAgent: "Android" });
    const manifest = {
      complete: false,
      media: {
        files: [
          {
            bytes: 3,
            fileName: "old.png",
            path: "media/old.png",
            sourceUrl: "https://source.test/old.png",
            status: "stored",
            updatedAt: 1,
          },
        ],
      },
      updatedAt: 1,
      version: 1,
    };
    pluginMediaFetchMock.mockRejectedValue(new Error("offline"));
    androidStorageMocks.readAndroidStorageText.mockResolvedValue(
      JSON.stringify(manifest),
    );
    androidStorageMocks.writeAndroidStorageText.mockResolvedValue(undefined);
    androidStorageMocks.deleteAndroidStoragePath.mockResolvedValue(undefined);
    androidStorageMocks.deleteAndroidStoragePaths.mockResolvedValue(undefined);
    androidStorageMocks.archiveAndroidStorageDirectory.mockResolvedValue(0);

    const result = await cacheHtmlChapterMedia({
      baseUrl: "https://source.test/chapter/1",
      chapterId: 42,
      chapterName: "Chapter",
      chapterNumber: "1",
      chapterPosition: 1,
      html: `<img src="https://source.test/current.png">`,
      novelId: 7,
      novelName: "Novel",
      sourceNovelId: "novel",
      sourceId: "source-a",
    });

    const preferredDir = "contents/source-a/novel/1";
    const deletedPaths = [
      ...androidStorageMocks.deleteAndroidStoragePath.mock.calls.map(
        ([path]) => path,
      ),
      ...androidStorageMocks.deleteAndroidStoragePaths.mock.calls.flatMap(
        ([paths]) => paths,
      ),
    ];
    expect(deletedPaths).toEqual(
      expect.arrayContaining([
        `${preferredDir}/media`,
        `${preferredDir}/media.zip`,
        `${preferredDir}/media.zip.tmp.zip`,
        `${preferredDir}/media.zip.bak`,
        `${preferredDir}/media.zip.rollback`,
        `${preferredDir}/manifest.json`,
        `${preferredDir}/manifest.json.tmp`,
        `${preferredDir}/manifest.json.bak`,
      ]),
    );
    expect(deletedPaths).not.toContain(`${preferredDir}/media.zip.tmp`);
    expect(deletedPaths.every((path) => path.startsWith(`${preferredDir}/`))).toBe(true);
    expect(
      androidStorageMocks.archiveAndroidStorageDirectory,
    ).toHaveBeenCalledWith(
      `${preferredDir}/media`,
      `${preferredDir}/media.zip`,
    );
    expect(result.mediaBytes).toBe(0);
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
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_read_manifest") {
        return JSON.stringify(manifest);
      }
      if (command === "chapter_media_total_size") {
        const [mediaSrc] = (args as { mediaSrcs: string[] }).mediaSrcs;
        return (mediaSrc ?? "").includes("0001-page-1.png") ? 3 : 0;
      }
      if (command === "chapter_media_archive_cache") return 12;
      if (command === "chapter_media_write_manifest") return null;
      if (command === "chapter_media_store_handle") {
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

  it("does not save a manifest after cancellation during media storage", async () => {
    const controller = new AbortController();
    pluginMediaFetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
        status: 200,
        statusText: "OK",
      }),
    );
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return null;
      if (command === "chapter_media_read_manifest") return null;
      if (command === "chapter_media_write_manifest") return null;
      if (command === "chapter_media_store_handle") {
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
    expect(manifestWrites).toHaveLength(1);
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
  });

  it("refetches Android assets missing from the current archive", async () => {
    vi.stubGlobal("navigator", { userAgent: "Android" });
    androidStorageMocks.androidStorageZipEntrySizes.mockResolvedValue(new Map());
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
    const preferredDir = "contents/source-a/novel/1/media";
    const preferredArchive =
      "contents/source-a/novel/1/media.zip";

    pluginMediaFetchMock.mockImplementation(async (url) => {
      const bytes = String(url).includes("page-1")
        ? new Uint8Array([1, 2, 3])
        : new Uint8Array([1, 2, 3, 4]);
      return new Response(bytes, {
        headers: { "content-type": "image/png" },
        status: 200,
      });
    });
    androidStorageMocks.readAndroidStorageText.mockImplementation(
      async (path: string) =>
        path === preferredArchive.replace("media.zip", "manifest.json")
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
      sourceNovelId: "novel",
      repair: true,
      sourceId: "source-a",
    });

    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(2);
    expect(androidStorageMocks.readAndroidStorageText).toHaveBeenCalledWith(
      preferredArchive.replace("media.zip", "manifest.json"),
    );
    expect(androidStorageMocks.readAndroidStorageText).toHaveBeenCalledTimes(1);
    expect(androidStorageMocks.extractAndroidStorageZip).not.toHaveBeenCalled();
    expect(
      androidStorageMocks.archiveAndroidStorageDirectory,
    ).toHaveBeenCalledWith(preferredDir, preferredArchive);
    expect(result.html).toContain("0001-page-1.png");
    expect(result.html).toContain("0002-page-2.png");
    expect(result.mediaBytes).toBe(14);
  });

  it("reuses matching Android archive entries and fetches only missing repair assets", async () => {
    vi.stubGlobal("navigator", { userAgent: "Android" });
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
    const preferredArchive =
      "contents/source-a/novel/1/media.zip";

    pluginMediaFetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "image/png" },
        status: 200,
      }),
    );
    androidStorageMocks.readAndroidStorageText.mockImplementation(
      async (path: string) =>
        path === preferredArchive.replace("media.zip", "manifest.json")
          ? JSON.stringify(manifest)
          : null,
    );
    androidStorageMocks.androidStoragePathSize.mockImplementation(
      async (path: string) => (path === preferredArchive ? 14 : 0),
    );
    androidStorageMocks.androidStorageZipEntrySizes.mockImplementation(
      async (archivePath: string) =>
        archivePath === preferredArchive
          ? new Map([["0001-page-1.png", 3]])
          : new Map(),
    );
    androidStorageMocks.archiveAndroidStorageDirectory.mockResolvedValue(14);
    androidStorageMocks.writeAndroidStorageBytes.mockResolvedValue(undefined);
    androidStorageMocks.writeAndroidStorageText.mockResolvedValue(undefined);

    androidStorageMocks.prepareAndroidChapterMediaRepair.mockResolvedValueOnce(new Map([["0001-page-1.png", 3]]));
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
      sourceNovelId: "novel",
      repair: true,
      sourceId: "source-a",
    });

    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
    expect(pluginMediaFetchMock).toHaveBeenCalledWith(
      "https://source.test/page-2.png",
      expect.anything(),
    );
    expect(androidStorageMocks.prepareAndroidChapterMediaRepair).toHaveBeenCalledWith("contents/source-a/novel/1");
    expect(result.html).toContain("0001-page-1.png");
    expect(result.html).toContain("0002-page-2.png");
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
      sourceNovelId: "novel",
      sourceId: "source-a",
    });

    expect(androidStorageMocks.writeAndroidStorageBytes).toHaveBeenCalledWith(
      "contents/source-a/novel/1/media/0001-page-1.jpg",
      new Uint8Array([1, 2, 3]),
      "image/jpeg",
    );
    expect(androidStorageMocks.renameAndroidStoragePath).not.toHaveBeenCalled();
    expect(androidStorageMocks.deleteAndroidStoragePath).not.toHaveBeenCalled();
    expect(androidStorageMocks.deleteAndroidStoragePaths).not.toHaveBeenCalled();
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
    mockChapterMediaInvoke(async (command, args) => {
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
      repair: true,
    });

    expect(pluginMediaFetchMock).toHaveBeenCalledWith(
      "https://source.test/page-1.png",
      expect.anything(),
    );
    expect(result.html).toContain("0001-page-1.png");
  });

  it("preserves mixed srcset candidate positions when reusing partial media", async () => {
    const manifest = {
      complete: false,
      media: {
        files: [
          {
            bytes: 7,
            fileName: "large.png",
            path: "media/large.png",
            sourceUrl: "https://source.test/large.png",
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
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_prepare_workspace") return { "large.png": 7 };
      if (command === "chapter_media_total_size") return 7;
      if (command === "chapter_media_archive_cache") return 5;
      if (command === "chapter_media_read_manifest") {
        return JSON.stringify(manifest);
      }
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
    mockChapterMediaInvoke(async (command, args) => {
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
      "chapter_media_store_handle",
      expect.objectContaining({
        fileName: "0001-page-1.png",
      }),
    );
    expect(result.html).toContain("0001-page-1.png");
    expect(result.html).not.toContain("norea-media://reader-asset/page-1.png");
  });

  it("keeps reader asset prefixes in stored repair HTML", async () => {
    mockChapterMediaInvoke(async (command) => {
      if (command === "chapter_media_archive_cache") return 0;
      if (command === "chapter_media_prepare_workspace") return { "page.png": 3, "cover.png": 4 };
      if (command === "chapter_media_read_manifest") return JSON.stringify({ version: 1, complete: false, updatedAt: 1, media: { files: ["page.png", "cover.png"].map(fileName => ({ bytes: 0, fileName, path: `media/${fileName}`, sourceUrl: `https://source.test/${fileName}`, status: "remote", updatedAt: 1 })) } });
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

describe("clearChapterMedia", () => {
  it("removes Android transaction artifacts for contextual chapter media", async () => {
    vi.stubGlobal("navigator", { userAgent: "Android" });
    androidStorageMocks.deleteAndroidStoragePath.mockResolvedValue(undefined);
    androidStorageMocks.deleteAndroidStoragePaths.mockResolvedValue(undefined);

    await clearChapterMedia(42, {
      chapterId: 42,
      chapterName: "Chapter",
      chapterNumber: "1",
      chapterPosition: 1,
      novelId: 7,
      novelName: "Novel",
      sourceNovelId: "novel",
      sourceId: "source-a",
    });

    const preferredDir = "contents/source-a/novel/1";
    const deletedPaths = [
      ...androidStorageMocks.deleteAndroidStoragePath.mock.calls.map(
        ([path]) => path,
      ),
      ...androidStorageMocks.deleteAndroidStoragePaths.mock.calls.flatMap(
        ([paths]) => paths,
      ),
    ];
    expect(deletedPaths).toEqual(
      expect.arrayContaining([
        `${preferredDir}/media`,
        `${preferredDir}/media.zip`,
        `${preferredDir}/media.zip.tmp.zip`,
        `${preferredDir}/media.zip.bak`,
        `${preferredDir}/media.zip.rollback`,
        `${preferredDir}/manifest.json`,
        `${preferredDir}/manifest.json.tmp`,
        `${preferredDir}/manifest.json.bak`,
      ]),
    );
    expect(deletedPaths).not.toContain(`${preferredDir}/media.zip.tmp`);
  });
});

describe("storeEmbeddedChapterMedia", () => {
  it.each(["chapter_media_store_handle", "chapter_media_write_manifest"])(
    "stops embedded media publication when cancelled during %s",
    async (cancelCommand) => {
      const controller = new AbortController();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      mockChapterMediaInvoke(async (command) => {
        if (command === cancelCommand) controller.abort();
        if (command === "chapter_media_store_handle") {
          return "norea-media://reader-asset/page.png";
        }
        return null;
      });

      try {
        await expect(storeEmbeddedChapterMedia({
          chapterId: 42,
          html: `<img src="norea-epub-resource://page.png">`,
          resources: [{
            bytes: new Uint8Array([1, 2, 3]),
            fileName: "page.png",
            placeholder: "norea-epub-resource://page.png",
          }],
          signal: controller.signal,
        })).rejects.toMatchObject({ name: "AbortError" });

        expect(warnSpy).not.toHaveBeenCalled();
        expect(invokeMock).not.toHaveBeenCalledWith(
          "chapter_media_archive_cache",
          expect.anything(),
        );
        if (cancelCommand === "chapter_media_store_handle") {
          expect(invokeMock).not.toHaveBeenCalledWith(
            "chapter_media_write_manifest",
            expect.anything(),
          );
        }
      } finally {
        warnSpy.mockRestore();
      }
    },
  );

  it("keeps the manifest incomplete when archive finalization fails", async () => {
    const archiveError = new Error("archive validation failed");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_archive_cache") throw archiveError;
      if (command === "chapter_media_total_size") return 3;
      if (command === "chapter_media_store_handle") {
        const input = args as { fileName: string };
        return `norea-media://reader-asset/${input.fileName}`;
      }
      return null;
    });

    try {
      await expect(
        storeEmbeddedChapterMedia({
          chapterId: 42,
          html: `<img src="norea-epub-resource://page.png">`,
          resources: [
            {
              bytes: new Uint8Array([1, 2, 3]),
              fileName: "page.png",
              placeholder: "norea-epub-resource://page.png",
            },
          ],
        }),
      ).rejects.toMatchObject({
        cause: archiveError,
        code: "chapter-media-finalization-failed",
        name: "ChapterMediaFinalizationError",
      });

      const manifestWrites = invokeMock.mock.calls.filter(
        ([command]) => command === "chapter_media_write_manifest",
      );
      expect(manifestWrites.length).toBeGreaterThan(0);
      expect(
        manifestWrites.every(
          ([, args]) =>
            (args as { complete?: boolean } | undefined)?.complete === false,
        ),
      ).toBe(true);
      expect(invokeMock).not.toHaveBeenCalledWith(
        "chapter_media_total_size",
        expect.anything(),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("classifies embedded manifest publication failures as finalization errors", async () => {
    const manifestError = new Error("manifest publication failed");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_write_manifest") throw manifestError;
      if (command === "chapter_media_archive_cache") return 3;
      if (command === "chapter_media_store_handle") {
        const input = args as { fileName: string };
        return `norea-media://reader-asset/${input.fileName}`;
      }
      return null;
    });

    try {
      await expect(
        storeEmbeddedChapterMedia({
          chapterId: 42,
          html: `<img src="norea-epub-resource://page.png">`,
          resources: [
            {
              bytes: new Uint8Array([1, 2, 3]),
              fileName: "page.png",
              placeholder: "norea-epub-resource://page.png",
            },
          ],
        }),
      ).rejects.toMatchObject({
        cause: manifestError,
        code: "chapter-media-finalization-failed",
        name: "ChapterMediaFinalizationError",
      });

      expect(invokeMock).not.toHaveBeenCalledWith(
        "chapter_media_archive_cache",
        expect.anything(),
      );
    } finally {
      warnSpy.mockRestore();
    }
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
      { chapterId: 95, chapterNumber: "95", novelId: 7, novelName: "Novel", sourceNovelId: "novel", sourceId: "demo" },
    );

    expect(
      androidStorageMocks.prepareAndroidReaderMediaCache,
    ).toHaveBeenCalledWith(
      "contents/demo/novel/95/media",
      "contents/demo/novel/95/media.zip",
      expect.stringMatching(/^\d+-[a-z0-9]+$/),
    );
    expect(html).toMatch(
      /src="norea-media:\/\/reader-asset\/~cache\/[^/]+\/page\.png"/,
    );
  });

  it("uses data URLs for desktop media outside the asset scope", async () => {
    mockChapterMediaInvoke(async (command, args) => {
      if (command === "chapter_media_data_url") {
        const { mediaSrc } = args as { mediaSrc: string };
        return `data:image/png;base64,${mediaSrc.split("/").pop()}`;
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const html = await resolveLocalChapterMedia(
      `<img src="norea-media://reader-asset/page.png">`,
    );

    expect(invokeMock).toHaveBeenCalledWith("chapter_media_data_url", {
      mediaSrc: "norea-media://reader-asset/page.png",
    });
    expect(html).toContain('src="data:image/png;base64,page.png"');
  });

  it("rewrites cached chapter media to local data URLs", async () => {
    mockChapterMediaInvoke(async (_command, args) => {
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
    mockChapterMediaInvoke(async (_command, args) => {
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
      { chapterId: 42, chapterNumber: "42", novelId: 7, novelName: "Novel", sourceNovelId: "novel", sourceId: "demo" },
    );

    expect(androidStorageMocks.readAndroidStorageDataUrl).not.toHaveBeenCalled();
    expect(
      androidStorageMocks.readAndroidStorageZipEntryDataUrl,
    ).not.toHaveBeenCalled();
    expect(
      androidStorageMocks.prepareAndroidReaderMediaCache,
    ).toHaveBeenCalledWith(
      "contents/demo/novel/42/media",
      "contents/demo/novel/42/media.zip",
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
      { chapterId: 27, chapterNumber: "27", novelId: 7, novelName: "Novel", sourceNovelId: "novel", sourceId: "demo" },
    );

    expect(
      androidStorageMocks.prepareAndroidReaderMediaCache,
    ).toHaveBeenCalledWith(
      "contents/demo/novel/27/media",
      "contents/demo/novel/27/media.zip",
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
        sourceNovelId: "novel",
        sourceId: "source-a",
      },
    );

    expect(
      androidStorageMocks.prepareAndroidReaderMediaCache,
    ).toHaveBeenCalledWith(
      "contents/source-a/novel/7/media",
      "contents/source-a/novel/7/media.zip",
      expect.stringMatching(/^\d+-[a-z0-9]+$/),
    );
    expect(patches[0]?.attributes.src).toMatch(
      /^norea-media:\/\/reader-asset\/~cache\/[^/]+\/page\.png$/,
    );
  });

  it("leaves scoped Android reader media URLs as resolved resources", async () => {
    vi.stubGlobal("navigator", { userAgent: "Android" });

    const scoped = "norea-media://reader-asset/~cache/42/page.png";
    const patches = await resolveLocalChapterMediaPatches(
      [
        {
          attributes: { src: scoped },
          index: 0,
          sourceAttributes: { src: scoped },
        },
      ],
      { chapterId: 42, chapterNumber: "42", novelId: 7, novelName: "Novel", sourceNovelId: "novel", sourceId: "demo" },
    );

    expect(
      androidStorageMocks.prepareAndroidReaderMediaCache,
    ).not.toHaveBeenCalled();
    expect(patches).toEqual([]);
  });

  it("deduplicates repeated cached media sources across a patch batch", async () => {
    mockChapterMediaInvoke(async (_command, args) => {
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
