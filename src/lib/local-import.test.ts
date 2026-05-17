import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  LOCAL_IMPORT_LIMITS,
  analyzeLocalImportFile,
  clearLocalImportFileCache,
  convertLocalImportFile,
  sanitizeLocalImportHtml,
} from "./local-import";

const mockedInvoke = vi.mocked(invoke);

function file(parts: BlobPart[], name: string, type = ""): File {
  return new File(parts, name, { type });
}

function bytes(value: string): number[] {
  return Array.from(new TextEncoder().encode(value));
}

function arrayBufferFromText(value: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(value);
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  );
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  mockedInvoke.mockReset();
});

describe("sanitizeLocalImportHtml", () => {
  it("removes scripts, event handlers, styles, and unsafe urls", () => {
    expect(
      sanitizeLocalImportHtml(
        `<section onclick="run()"><script>alert(1)</script><a href="javascript:alert(1)">bad</a><img src="data:image/png;base64,AAAA" onerror="run()" style="width:1px"><span data-extra="x">ok</span></section>`,
      ),
    ).toBe(
      `<section><a>bad</a><img src="data:image/png;base64,AAAA"><span>ok</span></section>`,
    );
  });
});

describe("analyzeLocalImportFile", () => {
  it("rejects oversized files before reading their body", async () => {
    const oversized = file([""], "Huge.pdf", "application/pdf");
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    Object.defineProperty(oversized, "size", {
      configurable: true,
      value: LOCAL_IMPORT_LIMITS.pdfBytes + 1,
    });
    Object.defineProperty(oversized, "arrayBuffer", {
      configurable: true,
      value: arrayBuffer,
    });

    await expect(analyzeLocalImportFile(oversized)).rejects.toThrow(
      /larger than the pdf import limit/,
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("bounds concurrent full-file reads during analysis", async () => {
    const releases: Array<() => void> = [];
    let activeReads = 0;
    let maxActiveReads = 0;
    const files = Array.from(
      { length: LOCAL_IMPORT_LIMITS.fileReadConcurrency + 3 },
      (_, index) => {
        const nextFile = file(
          [`file-${index}`],
          `Book-${index}.txt`,
          "text/plain",
        );
        Object.defineProperty(nextFile, "arrayBuffer", {
          configurable: true,
          value: vi.fn(async () => {
            activeReads += 1;
            maxActiveReads = Math.max(maxActiveReads, activeReads);
            await new Promise<void>((resolve) => releases.push(resolve));
            activeReads -= 1;
            return arrayBufferFromText(`file-${index}`);
          }),
        });
        return nextFile;
      },
    );

    const pending = Promise.all(
      files.map((entry) => analyzeLocalImportFile(entry)),
    );
    await flushMicrotasks();

    expect(activeReads).toBe(LOCAL_IMPORT_LIMITS.fileReadConcurrency);
    while (releases.length > 0) {
      releases.shift()?.();
      await flushMicrotasks();
      expect(activeReads).toBeLessThanOrEqual(
        LOCAL_IMPORT_LIMITS.fileReadConcurrency,
      );
    }
    await pending;

    expect(maxActiveReads).toBeLessThanOrEqual(
      LOCAL_IMPORT_LIMITS.fileReadConcurrency,
    );
  });

  it("emits deterministic hash-backed duplicate metadata", async () => {
    const analysis = await analyzeLocalImportFile(
      file(["hello"], "Example.txt", "text/plain"),
    );

    expect(analysis.format).toBe("txt");
    expect(analysis.title).toBe("Example");
    expect(analysis.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(analysis.pathKey).toBe(`local:txt:${analysis.contentHash}`);
    expect(analysis.duplicate).toEqual({
      strategy: "content-hash",
      key: analysis.contentHash,
      pathKey: analysis.pathKey,
      contentHash: analysis.contentHash,
      fileName: "Example.txt",
      fileSize: 5,
      format: "txt",
    });
  });

  it("reuses bytes from review analysis when converting the same file", async () => {
    const input = file(["cached"], "Cached.txt", "text/plain");
    const arrayBuffer = vi.fn(async () => arrayBufferFromText("cached"));
    Object.defineProperty(input, "arrayBuffer", {
      configurable: true,
      value: arrayBuffer,
    });

    const analysis = await analyzeLocalImportFile(input);
    const result = await convertLocalImportFile(input, { analysis });

    expect(result.analysis.contentHash).toBe(analysis.contentHash);
    expect(arrayBuffer).toHaveBeenCalledTimes(1);

    clearLocalImportFileCache(input);
    await convertLocalImportFile(input, { analysis });
    expect(arrayBuffer).toHaveBeenCalledTimes(2);
  });

  it("recognizes markdown files as hash-backed local imports", async () => {
    const analysis = await analyzeLocalImportFile(
      file(["# Heading"], "Chapter.md", "text/markdown"),
    );

    expect(analysis.format).toBe("markdown");
    expect(analysis.pathKey).toBe(`local:markdown:${analysis.contentHash}`);
    expect(analysis.duplicate.format).toBe("markdown");
  });
});

describe("convertLocalImportFile", () => {
  it("converts txt files to reader-ready html content", async () => {
    const result = await convertLocalImportFile(
      file([`Line <one> & "two" 'three'`], "Plain.txt", "text/plain"),
    );

    expect(result.novel.name).toBe("Plain");
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0]).toMatchObject({
      name: "Plain",
      contentType: "html",
      content: `<article class="reader-text-content" data-source-format="text"><section class="reader-text-section" data-section-index="0"><p class="reader-text-paragraph" data-paragraph-index="0"><span class="reader-text-line" data-line-index="0">Line &lt;one&gt; &amp; &quot;two&quot; &#39;three&#39;</span></p></section></article>`,
    });
  });

  it("converts html files to sanitized html content", async () => {
    const result = await convertLocalImportFile(
      file(
        [
          `<article><h1>Title</h1><p onclick="run()">Safe</p><script>alert(1)</script><a href="https://example.test">link</a><a href="javascript:bad()">bad</a></article>`,
        ],
        "Page.htm",
        "text/html",
      ),
    );

    expect(result.analysis.format).toBe("html");
    expect(result.chapters[0]).toMatchObject({
      contentType: "html",
      content: `<article><h1>Title</h1><p>Safe</p><a href="https://example.test">link</a><a>bad</a></article>`,
    });
  });

  it("converts markdown files to sanitized reader HTML content", async () => {
    const result = await convertLocalImportFile(
      file(
        [
          [
            "# Chapter",
            "",
            "[kept](https://example.test)",
            "![Page](https://cdn.test/page.png)",
            "<script>alert(1)</script>",
          ].join("\n"),
        ],
        "Chapter.markdown",
        "text/x-markdown",
      ),
    );

    expect(result.analysis.format).toBe("markdown");
    expect(result.chapters[0]).toMatchObject({
      contentType: "html",
      content: expect.stringContaining(
        '<section class="reader-markdown-content">',
      ),
    });
    expect(result.chapters[0]?.content).toContain("<h1>Chapter</h1>");
    expect(result.chapters[0]?.content).toContain(
      '<a href="https://example.test">kept</a>',
    );
    expect(result.chapters[0]?.content).toContain(
      '<img src="https://cdn.test/page.png" alt="Page">',
    );
    expect(result.chapters[0]?.content).not.toContain("<script>");
  });

  it("keeps legacy pdf files as data url content", async () => {
    const input = file(["%PDF"], "Manual.pdf", "application/pdf");
    const analysis = await analyzeLocalImportFile(input);
    const result = await convertLocalImportFile(input, { analysis });

    expect(result.analysis.title).toBe("Manual");
    expect(result.analysis.contentHash).toBe(analysis.contentHash);
    expect(result.chapters[0]).toMatchObject({
      name: "Manual",
      contentType: "pdf",
      content: "data:application/pdf;base64,JVBERg==",
    });
    expect(result.chapters[0]?.binaryResource).toMatchObject({
      fileName: "Manual.pdf",
      mediaType: "application/pdf",
      locator: {
        byteLength: 4,
        fileName: "Manual.pdf",
        mediaType: "application/pdf",
        placeholder: "data:application/pdf;base64,JVBERg==",
        sourcePath: `local-import://pdf/${analysis.contentHash}`,
        storage: "chapter-media",
      },
    });
    expect([
      ...(result.chapters[0]?.binaryResource?.bytes ?? []),
    ]).toEqual([37, 80, 68, 70]);
  });

  it("merges epub spine items into one reader html chapter with embedded resources", async () => {
    mockedInvoke.mockImplementation(async (command, args) => {
      if (command === "plugin_zip_list") {
        return [
          {
            name: "META-INF/container.xml",
            compressed_size: 64,
            uncompressed_size: 64,
            is_file: true,
          },
          {
            name: "OEBPS/content.opf",
            compressed_size: 256,
            uncompressed_size: 256,
            is_file: true,
          },
          {
            name: "OEBPS/chapter-1.xhtml",
            compressed_size: 128,
            uncompressed_size: 128,
            is_file: true,
          },
          {
            name: "OEBPS/chapter-2.xhtml",
            compressed_size: 128,
            uncompressed_size: 128,
            is_file: true,
          },
          {
            name: "OEBPS/book.css",
            compressed_size: 64,
            uncompressed_size: 64,
            is_file: true,
          },
          {
            name: "OEBPS/images/page.png",
            compressed_size: 4,
            uncompressed_size: 4,
            is_file: true,
          },
        ];
      }

      const path = (args as { options?: { path?: string } }).options?.path;
      if (path === "META-INF/container.xml") {
        return bytes(
          `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
        );
      }
      if (path === "OEBPS/content.opf") {
        return bytes(
          `<package><metadata><title>EPUB Book</title><creator>Writer</creator><language>en</language></metadata><manifest><item id="c1" href="chapter-1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="chapter-2.xhtml" media-type="application/xhtml+xml"/><item id="css" href="book.css" media-type="text/css"/><item id="page" href="images/page.png" media-type="image/png"/></manifest><spine page-progression-direction="ltr"><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
        );
      }
      if (path === "OEBPS/chapter-1.xhtml") {
        return bytes(
          `<html><head><title>Chapter One</title><link rel="stylesheet" href="book.css"></head><body><h1>Chapter One</h1><p onclick="run()" style="margin:1em !important; background:url('images/page.png')">Body</p><img src="images/page.png" alt="Page"><svg><image href="images/page.png"></image><use xlink:href="images/page.png"></use></svg><a href="https://example.test">link</a><script>alert(1)</script></body></html>`,
        );
      }
      if (path === "OEBPS/chapter-2.xhtml") {
        return bytes(
          `<html><head><title>Chapter Two</title></head><body><h1>Chapter Two</h1><p>More body</p></body></html>`,
        );
      }
      if (path === "OEBPS/book.css") {
        return bytes(`body { color: red !important; background: url("images/page.png"); }`);
      }
      if (path === "OEBPS/images/page.png") {
        return [1, 2, 3, 4];
      }
      throw new Error(`unexpected zip path: ${path ?? ""}`);
    });

    const result = await convertLocalImportFile(
      file(["epub"], "Book.epub", "application/epub+zip"),
    );
    const zipIpcPayloads = mockedInvoke.mock.calls
      .filter(
        ([command]) =>
          command === "plugin_zip_list" || command === "plugin_zip_read_file",
      )
      .map(([, args]) => (args as { bytes: number[] }).bytes);

    expect(result.novel).toMatchObject({
      name: "EPUB Book",
      author: "Writer",
    });
    expect(new Set(zipIpcPayloads).size).toBe(1);
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0]).toMatchObject({
      name: "EPUB Book",
      contentType: "epub",
      content: expect.stringContaining(
        '<article class="reader-epub-content" data-epub-rendered="true" lang="en" dir="ltr">',
      ),
    });
    expect(result.chapters[0]?.content).toContain(
      '<section class="reader-epub-section"',
    );
    expect(result.chapters[0]?.content).toContain("<h1>Chapter One</h1>");
    expect(result.chapters[0]?.content).toContain("<h1>Chapter Two</h1>");
    expect(result.chapters[0]?.content).toContain(
      '<p class="norea-epub-inline-style-1">Body</p>',
    );
    expect(result.chapters[0]?.content).toContain(
      '<a href="https://example.test">link</a>',
    );
    expect(result.chapters[0]?.content).toContain(
      "norea-epub-resource://OEBPS%2Fimages%2Fpage.png",
    );
    expect(result.chapters[0]?.content).toContain(
      '<image href="norea-epub-resource://OEBPS%2Fimages%2Fpage.png">',
    );
    expect(result.chapters[0]?.content).toContain(
      '<use xlink:href="norea-epub-resource://OEBPS%2Fimages%2Fpage.png">',
    );
    expect(result.chapters[0]?.content).toContain(
      "@layer norea-epub-author",
    );
    expect(result.chapters[0]?.content).not.toContain("!important");
    expect(result.chapters[0]?.content).not.toContain('style="');
    expect(result.chapters[0]?.content).not.toContain("<script>");
    expect(result.chapters[0]?.mediaResources).toEqual([
      expect.objectContaining({
        bytes: expect.any(Uint8Array),
        fileName: "0001-page.png",
        mediaType: "image/png",
        placeholder: "norea-epub-resource://OEBPS%2Fimages%2Fpage.png",
        sourcePath: "OEBPS/images/page.png",
      }),
    ]);
    expect([
      ...(result.chapters[0]?.mediaResources?.[0]?.bytes ?? []),
    ]).toEqual([1, 2, 3, 4]);
  });
});
