import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/queries/chapter", () => ({
  listChaptersByNovel: vi.fn(),
  saveChapterContent: vi.fn(),
}));
vi.mock("./chapter-media", () => ({
  cacheHtmlChapterMedia: vi.fn(),
  clearChapterMedia: vi.fn(),
  hasRemoteChapterMedia: vi.fn(),
  storeEmbeddedChapterMedia: vi.fn(),
}));

import {
  listChaptersByNovel,
  saveChapterContent,
} from "../db/queries/chapter";
import {
  cacheHtmlChapterMedia,
  clearChapterMedia,
  hasRemoteChapterMedia,
  storeEmbeddedChapterMedia,
} from "./chapter-media";
import { cacheLocalImportedChapterMedia } from "./local-import-media";

const listChaptersByNovelMock = vi.mocked(listChaptersByNovel);
const saveChapterContentMock = vi.mocked(saveChapterContent);
const cacheHtmlChapterMediaMock = vi.mocked(cacheHtmlChapterMedia);
const clearChapterMediaMock = vi.mocked(clearChapterMedia);
const hasRemoteChapterMediaMock = vi.mocked(hasRemoteChapterMedia);
const storeEmbeddedChapterMediaMock = vi.mocked(storeEmbeddedChapterMedia);

beforeEach(() => {
  vi.clearAllMocks();
  listChaptersByNovelMock.mockResolvedValue([
    {
      chapterNumber: "1",
      id: 99,
      name: "Chapter 1",
      path: "local:markdown:hash/chapter-0001",
      position: 1,
    },
  ] as never);
  saveChapterContentMock.mockResolvedValue({ rowsAffected: 1 });
  cacheHtmlChapterMediaMock.mockResolvedValue({
    html: `<img src="norea-media://chapter/99/0001-page.png">`,
    mediaBytes: 12,
    mediaFailures: [],
    storedMediaCount: 1,
  });
  storeEmbeddedChapterMediaMock.mockResolvedValue({
    html: `<img src="norea-media://chapter/99/0001-page.png">`,
    mediaBytes: 4,
    storedMediaCount: 1,
  });
});

describe("cacheLocalImportedChapterMedia", () => {
  it("caches imported markdown media using the persisted chapter id", async () => {
    hasRemoteChapterMediaMock.mockReturnValue(true);

    await cacheLocalImportedChapterMedia({
      chapters: [
        {
          content: `<img src="https://cdn.test/page.png">`,
          contentBytes: 37,
          contentType: "markdown",
          name: "Chapter 1",
          path: "local:markdown:hash/chapter-0001",
          position: 1,
        },
      ],
      novelId: 7,
      novelName: "Local Book",
      novelPath: "local:markdown:hash",
    });

    expect(cacheHtmlChapterMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chapterId: 99,
        html: `<img src="https://cdn.test/page.png">`,
        novelId: 7,
        sourceId: "local",
      }),
    );
    expect(saveChapterContentMock).toHaveBeenCalledWith(
      99,
      `<img src="norea-media://chapter/99/0001-page.png">`,
      "html",
      { mediaBytes: 12 },
    );
  });

  it("clears stale media metadata when imported html-like content has no cacheable media", async () => {
    hasRemoteChapterMediaMock.mockReturnValue(false);

    await cacheLocalImportedChapterMedia({
      chapters: [
        {
          content: `<p>No media</p>`,
          contentBytes: 15,
          contentType: "markdown",
          name: "Chapter 1",
          path: "local:markdown:hash/chapter-0001",
          position: 1,
        },
      ],
      novelId: 7,
      novelName: "Local Book",
      novelPath: "local:markdown:hash",
    });

    expect(cacheHtmlChapterMediaMock).not.toHaveBeenCalled();
    expect(saveChapterContentMock).toHaveBeenCalledWith(
      99,
      `<p>No media</p>`,
      "html",
      { mediaBytes: 0 },
    );
    expect(clearChapterMediaMock).toHaveBeenCalledWith(
      99,
      expect.objectContaining({
        chapterId: 99,
        sourceId: "local",
      }),
    );
  });

  it("stores embedded epub resources using the persisted chapter id", async () => {
    hasRemoteChapterMediaMock.mockReturnValue(false);

    await cacheLocalImportedChapterMedia({
      chapters: [
        {
          content: `<article><img src="norea-epub-resource://OEBPS%2Fpage.png"></article>`,
          contentBytes: 77,
          contentType: "epub",
          mediaResources: [
            {
              bytes: new Uint8Array([1, 2, 3, 4]),
              fileName: "0001-page.png",
              mediaType: "image/png",
              placeholder: "norea-epub-resource://OEBPS%2Fpage.png",
              sourcePath: "OEBPS/page.png",
            },
          ],
          name: "Chapter 1",
          path: "local:markdown:hash/chapter-0001",
          position: 1,
        },
      ],
      novelId: 7,
      novelName: "Local Book",
      novelPath: "local:epub:hash",
    });

    expect(storeEmbeddedChapterMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chapterId: 99,
        resources: [
          expect.objectContaining({
            contentType: "image/png",
            fileName: "0001-page.png",
            placeholder: "norea-epub-resource://OEBPS%2Fpage.png",
            sourcePath: "OEBPS/page.png",
          }),
        ],
        sourceId: "local",
      }),
    );
    expect(cacheHtmlChapterMediaMock).not.toHaveBeenCalled();
    expect(clearChapterMediaMock).not.toHaveBeenCalled();
    expect(saveChapterContentMock).toHaveBeenCalledWith(
      99,
      `<img src="norea-media://chapter/99/0001-page.png">`,
      "epub",
      { mediaBytes: 4 },
    );
  });

  it("stores imported pdf binary resources while keeping legacy content as fallback", async () => {
    hasRemoteChapterMediaMock.mockReturnValue(false);
    storeEmbeddedChapterMediaMock.mockResolvedValue({
      html: "norea-media://chapter/99/Manual.pdf",
      mediaBytes: 4,
      storedMediaCount: 1,
    });

    await cacheLocalImportedChapterMedia({
      chapters: [
        {
          binaryResource: {
            bytes: new Uint8Array([37, 80, 68, 70]),
            fileName: "Manual.pdf",
            locator: {
              byteLength: 4,
              fileName: "Manual.pdf",
              mediaType: "application/pdf",
              placeholder: "data:application/pdf;base64,JVBERg==",
              sourcePath: "local-import://pdf/hash",
              storage: "chapter-media",
            },
            mediaType: "application/pdf",
          },
          content: "data:application/pdf;base64,JVBERg==",
          contentBytes: 36,
          contentType: "pdf",
          name: "Chapter 1",
          path: "local:markdown:hash/chapter-0001",
          position: 1,
        },
      ],
      novelId: 7,
      novelName: "Local Book",
      novelPath: "local:pdf:hash",
    });

    expect(storeEmbeddedChapterMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chapterId: 99,
        html: "data:application/pdf;base64,JVBERg==",
        resources: [
          expect.objectContaining({
            bytes: new Uint8Array([37, 80, 68, 70]),
            contentType: "application/pdf",
            fileName: "Manual.pdf",
            placeholder: "data:application/pdf;base64,JVBERg==",
            sourcePath: "local-import://pdf/hash",
          }),
        ],
        sourceId: "local",
      }),
    );
    expect(cacheHtmlChapterMediaMock).not.toHaveBeenCalled();
    expect(saveChapterContentMock).toHaveBeenCalledWith(
      99,
      "norea-media://chapter/99/Manual.pdf",
      "pdf",
      { mediaBytes: 4 },
    );
  });
});
