import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceTaskSpec } from "./scheduler";

const schedulerMocks = vi.hoisted(() => ({
  enqueueSource: vi.fn(),
}));

const pluginMocks = vi.hoisted(() => ({
  getPlugin: vi.fn(),
  getPluginForExecutor: vi.fn(),
  loadInstalledFromDb: vi.fn(),
  parseChapter: vi.fn(),
  parseChapterResource: vi.fn(),
}));

const epubMocks = vi.hoisted(() => ({
  convertEpubToHtml: vi.fn(),
  mergeEpubHtmlSections: vi.fn(),
}));

vi.mock("../../db/queries/chapter", () => ({
  getChapterById: vi.fn(),
  saveChapterContent: vi.fn(),
  saveChapterPartialContent: vi.fn(),
}));
vi.mock("../../db/queries/novel", () => ({
  getNovelById: vi.fn(),
}));
vi.mock("../../store/browse", () => ({
  useBrowseStore: {
    getState: vi.fn(() => ({ chapterDownloadCooldownSeconds: 0 })),
  },
}));
vi.mock("../chapter-media", () => ({
  cacheHtmlChapterMedia: vi.fn(),
  clearChapterMedia: vi.fn(),
  getStoredChapterMediaBytes: vi.fn(),
  hasRemoteChapterMedia: vi.fn(),
  localChapterMediaSources: vi.fn(),
  protectRemoteChapterMediaForPartialHtml: vi.fn((html: string) => html),
  storeEmbeddedChapterMedia: vi.fn(),
}));
vi.mock("../epub-html", () => ({
  convertEpubToHtml: epubMocks.convertEpubToHtml,
  mergeEpubHtmlSections: epubMocks.mergeEpubHtmlSections,
}));
vi.mock("../plugins/manager", () => ({
  pluginManager: {
    getPlugin: pluginMocks.getPlugin,
    getPluginForExecutor: pluginMocks.getPluginForExecutor,
    loadInstalledFromDb: pluginMocks.loadInstalledFromDb,
  },
}));
vi.mock("../tauri-runtime", () => ({
  isTauriRuntime: vi.fn(() => false),
}));
vi.mock("./scheduler", () => ({
  sourceBaseDomainKey: vi.fn((baseUrl?: string) =>
    baseUrl ? "source.test" : null,
  ),
  TASK_PAUSE_ABORT_MESSAGE: "Task was paused.",
  taskScheduler: {
    enqueueSource: schedulerMocks.enqueueSource,
    getSnapshot: vi.fn(() => ({ records: [] })),
    getTaskByDedupeKey: vi.fn(),
    subscribeEvents: vi.fn(),
  },
}));

import {
  getChapterById,
  saveChapterContent,
  saveChapterPartialContent,
} from "../../db/queries/chapter";
import { getNovelById } from "../../db/queries/novel";
import {
  cacheHtmlChapterMedia,
  clearChapterMedia,
  getStoredChapterMediaBytes,
  hasRemoteChapterMedia,
  localChapterMediaSources,
  storeEmbeddedChapterMedia,
} from "../chapter-media";
import { convertEpubToHtml, mergeEpubHtmlSections } from "../epub-html";
import {
  enqueueChapterDownloadBatch,
  enqueueChapterDownload,
  enqueueChapterMediaRepair,
  MAX_CHAPTER_DOWNLOAD_BATCH_WINDOW,
  type ChapterDownloadJob,
} from "./chapter-download";

let capturedSpec: SourceTaskSpec<void> | null = null;

interface Deferred<T> {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
}

function createDeferred<T>(): Deferred<T> {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(count = 20): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedSpec = null;
  schedulerMocks.enqueueSource.mockImplementation(
    (spec: SourceTaskSpec<void>) => {
      capturedSpec = spec;
      return { id: "task-1", promise: new Promise<void>(() => {}) };
    },
  );
  const plugin = {
    id: "source-a",
    imageRequestInit: { headers: { Referer: "https://source.test/" } },
    name: "Source A",
    getBaseUrl: () => "https://source.test",
    parseChapter: pluginMocks.parseChapter,
    parseChapterResource: pluginMocks.parseChapterResource,
  };
  pluginMocks.getPlugin.mockReturnValue(plugin);
  pluginMocks.getPluginForExecutor.mockReturnValue(plugin);
  pluginMocks.parseChapter.mockResolvedValue(`plain <chapter>`);
  pluginMocks.parseChapterResource.mockResolvedValue({
    type: "binary",
    contentType: "pdf",
    mediaType: "application/pdf",
    bytes: new Uint8Array([37, 80, 68, 70]),
    byteLength: 4,
  });
  vi.mocked(cacheHtmlChapterMedia).mockResolvedValue({
    html: "<img>",
    mediaFailures: [],
    mediaBytes: 3,
    storedMediaCount: 1,
  });
  vi.mocked(getChapterById).mockResolvedValue({
    contentType: "text",
    id: 7,
  } as never);
  vi.mocked(getNovelById).mockResolvedValue(null);
  vi.mocked(getStoredChapterMediaBytes).mockResolvedValue(3);
  vi.mocked(hasRemoteChapterMedia).mockReturnValue(true);
  vi.mocked(localChapterMediaSources).mockReturnValue([]);
  vi.mocked(saveChapterContent).mockResolvedValue({ rowsAffected: 1 });
  vi.mocked(saveChapterPartialContent).mockResolvedValue({ rowsAffected: 1 });
  vi.mocked(convertEpubToHtml).mockResolvedValue({
    sections: [],
    title: "EPUB",
  });
  vi.mocked(mergeEpubHtmlSections).mockReturnValue(
    `<article class="reader-epub-content" data-epub-rendered="true"></article>`,
  );
  vi.mocked(storeEmbeddedChapterMedia).mockResolvedValue({
    html: `<article class="reader-epub-content" data-epub-rendered="true"></article>`,
    mediaBytes: 0,
    storedMediaCount: 0,
  });
});

describe("enqueueChapterDownloadBatch", () => {
  it("materializes only a bounded scheduler window for 10k chapter batches", async () => {
    const deferreds: Deferred<void>[] = [];
    schedulerMocks.enqueueSource.mockImplementation(
      (spec: SourceTaskSpec<void>) => {
        capturedSpec = spec;
        const deferred = createDeferred<void>();
        deferreds.push(deferred);
        return {
          id: `task-${deferreds.length}`,
          promise: deferred.promise,
        };
      },
    );
    let yielded = 0;
    function* jobs(): Iterable<ChapterDownloadJob> {
      for (let id = 1; id <= 10_000; id += 1) {
        yielded += 1;
        yield {
          id,
          pluginId: "source-a",
          chapterPath: `/chapter/${id}`,
          title: `Chapter ${id}`,
        };
      }
    }

    const handle = enqueueChapterDownloadBatch({
      jobs: jobs(),
      title: "Download 10k chapters",
      total: 10_000,
    });
    void handle.promise.catch(() => undefined);

    expect(yielded).toBe(MAX_CHAPTER_DOWNLOAD_BATCH_WINDOW);
    await flushMicrotasks();

    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(
      MAX_CHAPTER_DOWNLOAD_BATCH_WINDOW,
    );

    expect(capturedSpec?.subject?.batchTitle).toBe("Download 10k chapters");
  });

  it("refills the bounded batch window after a cancelled task settles", async () => {
    const deferreds: Deferred<void>[] = [];
    schedulerMocks.enqueueSource.mockImplementation(
      (spec: SourceTaskSpec<void>) => {
        capturedSpec = spec;
        const deferred = createDeferred<void>();
        deferreds.push(deferred);
        return {
          id: `task-${deferreds.length}`,
          promise: deferred.promise,
        };
      },
    );

    const handle = enqueueChapterDownloadBatch({
      jobs: [1, 2, 3, 4].map((id) => ({
        id,
        pluginId: "source-a",
        chapterPath: `/chapter/${id}`,
        title: `Chapter ${id}`,
      })),
      title: "Download 4 chapters",
      total: 4,
      windowSize: 2,
    });

    await flushMicrotasks();

    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(2);

    deferreds[0]!.reject(
      new DOMException("Task was cancelled.", "AbortError"),
    );
    await flushMicrotasks();

    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(3);

    deferreds[1]!.resolve();
    await flushMicrotasks();

    expect(schedulerMocks.enqueueSource).toHaveBeenCalledTimes(4);

    deferreds[2]!.resolve();
    deferreds[3]!.resolve();

    await expect(handle.promise).resolves.toEqual({
      cancelled: 1,
      failed: 0,
      succeeded: 3,
      total: 4,
    });
  });
});

describe("enqueueChapterDownload", () => {
  it("carries contentType through the task subject and saveChapterContent", async () => {
    vi.mocked(hasRemoteChapterMedia).mockReturnValueOnce(false);

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      contentType: "text",
      title: "Chapter 7",
    });

    expect(capturedSpec?.subject).toEqual(
      expect.objectContaining({ contentType: "text" }),
    );

    await capturedSpec?.run({
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(saveChapterContent).toHaveBeenCalledWith(
      7,
      `<article class="reader-text-content" data-source-format="text"><section class="reader-text-section" data-section-index="0"><p class="reader-text-paragraph" data-paragraph-index="0"><span class="reader-text-line" data-line-index="0">plain &lt;chapter&gt;</span></p></section></article>`,
      "html",
      { mediaBytes: 0 },
    );
    expect(clearChapterMedia).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ chapterId: 7, sourceId: "source-a" }),
    );
  });

  it("keeps chapter media downloads on the assigned scraper executor", async () => {
    pluginMocks.parseChapter.mockResolvedValueOnce(`<img src="/page.png">`);
    vi.mocked(getChapterById).mockResolvedValueOnce({
      content: `<img src="norea-media://chapter/7/page.png">`,
      contentType: "html",
      id: 7,
    } as never);

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      contentType: "html",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      executor: "pool:1",
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(cacheHtmlChapterMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        previousHtml: `<img src="norea-media://chapter/7/page.png">`,
        requestInit: { headers: { Referer: "https://source.test/" } },
        scraperExecutor: "pool:1",
        sourceId: "source-a",
      }),
    );
    expect(saveChapterContent).toHaveBeenCalledWith(7, "<img>", "html", {
      mediaBytes: 3,
    });
  });

  it("renders markdown chapters before caching rendered media", async () => {
    pluginMocks.parseChapter.mockResolvedValueOnce(
      [
        "# Chapter 7",
        "",
        "[kept](https://source.test/read)",
        "![Page](/page.png)",
      ].join("\n"),
    );
    vi.mocked(getChapterById).mockResolvedValueOnce({
      content: null,
      contentType: "markdown",
      id: 7,
    } as never);
    vi.mocked(cacheHtmlChapterMedia).mockResolvedValueOnce({
      html: `<section class="reader-markdown-content"><h1>Chapter 7</h1><p><a href="https://source.test/read">kept</a><img src="norea-media://chapter/7/page.png" alt="Page"></p></section>`,
      mediaFailures: [],
      mediaBytes: 3,
      storedMediaCount: 1,
    });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      contentType: "markdown",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(cacheHtmlChapterMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringMatching(
          /<section class="reader-markdown-content">[\s\S]*src="\/page\.png"/,
        ),
        sourceId: "source-a",
      }),
    );
    expect(saveChapterContent).toHaveBeenCalledWith(
      7,
      expect.stringContaining("norea-media://chapter/7/page.png"),
      "html",
      { mediaBytes: 3 },
    );
    expect(clearChapterMedia).not.toHaveBeenCalled();
  });

  it("downloads pdf chapters from parseChapterResource without parsing text content", async () => {
    vi.mocked(getChapterById).mockResolvedValueOnce({
      content: null,
      contentType: "pdf",
      id: 7,
    } as never);
    pluginMocks.parseChapterResource.mockResolvedValueOnce({
      type: "binary",
      contentType: "pdf",
      mediaType: "application/pdf",
      bytes: new Uint8Array([37, 80, 68, 70]),
      byteLength: 4,
    });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7.pdf",
      contentType: "pdf",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(pluginMocks.parseChapterResource).toHaveBeenCalledWith(
      "/chapter/7.pdf",
    );
    expect(pluginMocks.parseChapter).not.toHaveBeenCalled();
    expect(saveChapterContent).toHaveBeenCalledWith(
      7,
      "data:application/pdf;base64,JVBERg==",
      "pdf",
      { mediaBytes: 0 },
    );
    expect(clearChapterMedia).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ chapterId: 7, sourceId: "source-a" }),
    );
  });

  it("converts epub resources to reader html and stores embedded media", async () => {
    const section = {
      html: `<section><img src="norea-epub-resource://OEBPS%2Fpage.png"></section>`,
      href: "OEBPS/chapter.xhtml",
      name: "Chapter 7",
      resources: [
        {
          bytes: new Uint8Array([1, 2, 3]),
          fileName: "0001-page.png",
          mediaType: "image/png",
          placeholder: "norea-epub-resource://OEBPS%2Fpage.png",
          sourcePath: "OEBPS/page.png",
        },
      ],
    };
    vi.mocked(getChapterById).mockResolvedValueOnce({
      content: null,
      contentType: "epub",
      id: 7,
      name: "Chapter 7",
    } as never);
    pluginMocks.parseChapterResource.mockResolvedValueOnce({
      type: "binary",
      contentType: "epub",
      mediaType: "application/epub+zip",
      bytes: new Uint8Array([80, 75, 3, 4]),
      byteLength: 4,
    });
    vi.mocked(convertEpubToHtml).mockResolvedValueOnce({
      direction: "rtl",
      language: "en",
      sections: [section],
      title: "Book",
    });
    vi.mocked(mergeEpubHtmlSections).mockReturnValueOnce(
      `<article><img src="norea-epub-resource://OEBPS%2Fpage.png"></article>`,
    );
    vi.mocked(storeEmbeddedChapterMedia).mockResolvedValueOnce({
      html: `<article><img src="norea-media://chapter/7/0001-page.png"></article>`,
      mediaBytes: 3,
      storedMediaCount: 1,
    });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7.epub",
      contentType: "epub",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(pluginMocks.parseChapter).not.toHaveBeenCalled();
    expect(convertEpubToHtml).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      { fallbackTitle: "Chapter 7" },
    );
    expect(mergeEpubHtmlSections).toHaveBeenCalledWith([section], {
      direction: "rtl",
      language: "en",
    });
    expect(storeEmbeddedChapterMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        chapterId: 7,
        resources: [
          expect.objectContaining({
            contentType: "image/png",
            fileName: "0001-page.png",
            placeholder: "norea-epub-resource://OEBPS%2Fpage.png",
            sourcePath: "OEBPS/page.png",
          }),
        ],
        sourceId: "source-a",
      }),
    );
    expect(saveChapterContent).toHaveBeenCalledWith(
      7,
      `<article><img src="norea-media://chapter/7/0001-page.png"></article>`,
      "epub",
      { mediaBytes: 3 },
    );
    expect(clearChapterMedia).not.toHaveBeenCalled();
  });

  it("fails epub downloads when parseChapterResource is unavailable", async () => {
    pluginMocks.getPluginForExecutor.mockReturnValueOnce({
      id: "source-a",
      imageRequestInit: { headers: { Referer: "https://source.test/" } },
      name: "Source A",
      getBaseUrl: () => "https://source.test",
      parseChapter: pluginMocks.parseChapter,
    });
    vi.mocked(getChapterById).mockResolvedValueOnce({
      content: null,
      contentType: "epub",
      id: 7,
    } as never);

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7.epub",
      contentType: "epub",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await expect(
      capturedSpec.run({
        setDetail: vi.fn(),
        setProgress: vi.fn(),
        signal: new AbortController().signal,
        taskId: "task-1",
      }),
    ).rejects.toThrow("parseChapterResource");

    expect(pluginMocks.parseChapter).not.toHaveBeenCalled();
    expect(saveChapterContent).not.toHaveBeenCalled();
  });

  it("fails binary downloads when resource metadata does not match the chapter type", async () => {
    vi.mocked(getChapterById).mockResolvedValueOnce({
      content: null,
      contentType: "epub",
      id: 7,
    } as never);
    pluginMocks.parseChapterResource.mockResolvedValueOnce({
      type: "binary",
      contentType: "epub",
      mediaType: "application/pdf",
      bytes: new Uint8Array([80, 75, 3, 4]),
      byteLength: 4,
    });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7.epub",
      contentType: "epub",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await expect(
      capturedSpec.run({
        setDetail: vi.fn(),
        setProgress: vi.fn(),
        signal: new AbortController().signal,
        taskId: "task-1",
      }),
    ).rejects.toThrow("mediaType");

    expect(pluginMocks.parseChapter).not.toHaveBeenCalled();
    expect(saveChapterContent).not.toHaveBeenCalled();
  });

  it("fails binary downloads when resource bytes are empty", async () => {
    vi.mocked(getChapterById).mockResolvedValueOnce({
      content: null,
      contentType: "pdf",
      id: 7,
    } as never);
    pluginMocks.parseChapterResource.mockResolvedValueOnce({
      type: "binary",
      contentType: "pdf",
      mediaType: "application/pdf",
      bytes: new Uint8Array(),
      byteLength: 0,
    });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7.pdf",
      contentType: "pdf",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await expect(
      capturedSpec.run({
        setDetail: vi.fn(),
        setProgress: vi.fn(),
        signal: new AbortController().signal,
        taskId: "task-1",
      }),
    ).rejects.toThrow("bytes are empty");

    expect(pluginMocks.parseChapter).not.toHaveBeenCalled();
    expect(saveChapterContent).not.toHaveBeenCalled();
  });

  it("fails binary downloads when declared byteLength does not match bytes", async () => {
    vi.mocked(getChapterById).mockResolvedValueOnce({
      content: null,
      contentType: "pdf",
      id: 7,
    } as never);
    pluginMocks.parseChapterResource.mockResolvedValueOnce({
      type: "binary",
      contentType: "pdf",
      mediaType: "application/pdf",
      bytes: new Uint8Array([37, 80, 68, 70]),
      byteLength: 99,
    });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7.pdf",
      contentType: "pdf",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await expect(
      capturedSpec.run({
        setDetail: vi.fn(),
        setProgress: vi.fn(),
        signal: new AbortController().signal,
        taskId: "task-1",
      }),
    ).rejects.toThrow("byteLength");

    expect(pluginMocks.parseChapter).not.toHaveBeenCalled();
    expect(saveChapterContent).not.toHaveBeenCalled();
  });

  it("records media fallback detail without failing the chapter download", async () => {
    const setDetail = vi.fn();
    pluginMocks.parseChapter.mockResolvedValueOnce(`<img src="/page.png">`);
    vi.mocked(getChapterById).mockResolvedValueOnce({
      content: null,
      contentType: "html",
      id: 7,
    } as never);
    vi.mocked(cacheHtmlChapterMedia).mockResolvedValueOnce({
      html: `<img src="https://source.test/page.png">`,
      mediaFailures: [
        {
          message: "Failed to fetch",
          url: "https://source.test/page.png",
        },
      ],
      mediaBytes: 0,
      storedMediaCount: 0,
    });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      contentType: "html",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      setDetail,
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(setDetail).toHaveBeenCalledWith(
      "1 media assets using remote fallback",
    );
    expect(saveChapterContent).toHaveBeenCalledWith(
      7,
      `<img src="https://source.test/page.png">`,
      "html",
      { mediaBytes: 0 },
    );
  });

  it("fails when the local chapter row is missing", async () => {
    vi.mocked(getChapterById).mockResolvedValueOnce(null);

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await expect(
      capturedSpec.run({
        setDetail: vi.fn(),
        setProgress: vi.fn(),
        signal: new AbortController().signal,
        taskId: "task-1",
      }),
    ).rejects.toThrow(
      'chapter-download: local chapter 7 was not found for "Chapter 7" from plugin "source-a" at path "/chapter/7".',
    );

    expect(pluginMocks.parseChapter).not.toHaveBeenCalled();
    expect(saveChapterContent).not.toHaveBeenCalled();
  });

  it("fails when saving downloaded content does not update a chapter row", async () => {
    vi.mocked(saveChapterContent).mockResolvedValueOnce({ rowsAffected: 0 });

    enqueueChapterDownload({
      id: 7,
      pluginId: "source-a",
      chapterPath: "/chapter/7",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await expect(
      capturedSpec.run({
        setDetail: vi.fn(),
        setProgress: vi.fn(),
        signal: new AbortController().signal,
        taskId: "task-1",
      }),
    ).rejects.toThrow(
      'chapter-download: local chapter 7 was not found for "Chapter 7" from plugin "source-a" at path "/chapter/7".',
    );

    expect(clearChapterMedia).not.toHaveBeenCalled();
  });
});

describe("enqueueChapterMediaRepair", () => {
  it("repairs remote media without parsing chapter content", async () => {
    const setDetail = vi.fn();
    const storedHtml = `<img src="https://cdn.test/page.png">`;
    const repairedHtml = `<img src="norea-media://chapter/7/page.png">`;
    vi.mocked(getChapterById).mockResolvedValueOnce({
      chapterNumber: "7",
      content: storedHtml,
      contentType: "html",
      id: 7,
      isDownloaded: true,
      name: "Chapter 7",
      novelId: 11,
      path: "/chapter/7",
      position: 7,
    } as never);
    vi.mocked(getNovelById).mockResolvedValueOnce({
      id: 11,
      name: "Novel",
      path: "/novel",
    } as never);
    vi.mocked(cacheHtmlChapterMedia).mockResolvedValueOnce({
      html: repairedHtml,
      mediaFailures: [],
      mediaBytes: 8,
      storedMediaCount: 1,
    });
    vi.mocked(getStoredChapterMediaBytes).mockResolvedValueOnce(8);

    enqueueChapterMediaRepair({
      id: 7,
      pluginId: "source-a",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      executor: "pool:1",
      setDetail,
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(pluginMocks.parseChapter).not.toHaveBeenCalled();
    expect(cacheHtmlChapterMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        html: storedHtml,
        previousHtml: storedHtml,
        requestInit: { headers: { Referer: "https://source.test/" } },
        scraperExecutor: "pool:1",
        sourceId: "source-a",
      }),
    );
    expect(saveChapterContent).toHaveBeenCalledWith(7, repairedHtml, "html", {
      mediaBytes: 8,
    });
    expect(setDetail).toHaveBeenCalledWith("1 media assets repaired");
  });

  it("runs media repair when stored HTML only has local media refs", async () => {
    const setDetail = vi.fn();
    const storedHtml = `<img src="norea-media://chapter/7/0001-page.png">`;
    vi.mocked(hasRemoteChapterMedia).mockReturnValueOnce(false);
    vi.mocked(localChapterMediaSources).mockReturnValueOnce([
      "norea-media://chapter/7/0001-page.png",
    ]);
    vi.mocked(getChapterById).mockResolvedValueOnce({
      chapterNumber: "7",
      content: storedHtml,
      contentType: "html",
      id: 7,
      isDownloaded: true,
      name: "Chapter 7",
      novelId: 11,
      path: "/chapter/7",
      position: 7,
    } as never);
    vi.mocked(getNovelById).mockResolvedValueOnce({
      id: 11,
      name: "Novel",
      path: "/novel",
    } as never);
    vi.mocked(cacheHtmlChapterMedia).mockResolvedValueOnce({
      html: storedHtml,
      mediaFailures: [],
      mediaBytes: 8,
      storedMediaCount: 1,
    });
    vi.mocked(getStoredChapterMediaBytes).mockResolvedValueOnce(8);

    enqueueChapterMediaRepair({
      id: 7,
      pluginId: "source-a",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      executor: "pool:1",
      setDetail,
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(cacheHtmlChapterMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        html: storedHtml,
        previousHtml: storedHtml,
        repair: true,
      }),
    );
    expect(saveChapterContent).toHaveBeenCalledWith(7, storedHtml, "html", {
      mediaBytes: 8,
    });
    expect(setDetail).toHaveBeenCalledWith("1 media assets repaired");
  });

  it("succeeds without work when downloaded HTML has no remote media", async () => {
    const setDetail = vi.fn();
    vi.mocked(hasRemoteChapterMedia).mockReturnValueOnce(false);
    vi.mocked(localChapterMediaSources).mockReturnValueOnce([]);
    vi.mocked(getChapterById).mockResolvedValueOnce({
      content: `<p>plain chapter</p>`,
      contentType: "html",
      id: 7,
      isDownloaded: true,
      name: "Chapter 7",
      novelId: 11,
      path: "/chapter/7",
      position: 7,
    } as never);

    enqueueChapterMediaRepair({
      id: 7,
      pluginId: "source-a",
      title: "Chapter 7",
    });

    if (!capturedSpec) throw new Error("Task spec was not captured.");
    await capturedSpec.run({
      setDetail,
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "task-1",
    });

    expect(setDetail).toHaveBeenCalledWith("No remote media to repair");
    expect(pluginMocks.parseChapter).not.toHaveBeenCalled();
    expect(cacheHtmlChapterMedia).not.toHaveBeenCalled();
    expect(saveChapterContent).not.toHaveBeenCalled();
  });
});
