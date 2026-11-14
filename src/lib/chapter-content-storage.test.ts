import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("./observability", () => ({
  startPerformanceObservation: () => () => undefined,
  recordPerformanceObservation: () => undefined,
}));

vi.mock("../db/queries/chapter", () => ({
  adoptStoredChapterContentMetadata: vi.fn(),
  markStoredChapterContentMissing: vi.fn(),
  saveChapterContentMetadata: vi.fn(),
  saveChapterPartialContentMetadata: vi.fn(),
}));

vi.mock("./tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(),
  isTauriRuntime: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  adoptStoredChapterContentMetadata,
  markStoredChapterContentMissing,
  saveChapterContentMetadata,
  saveChapterPartialContentMetadata,
} from "../db/queries/chapter";
import {
  clearStoredChapterContentMirror,
  readStoredChapterContentMirror,
  reconcileStoredChapterContent,
  restoreChapterContentStorageMirror,
  saveStoredChapterContent,
  saveStoredChapterPartialContent,
  writeStoredChapterContentMirror,
} from "./chapter-content-storage";
import { isAndroidRuntime, isTauriRuntime } from "./tauri-runtime";

const invokeMock = vi.mocked(invoke);
const adoptStoredChapterContentMetadataMock = vi.mocked(
  adoptStoredChapterContentMetadata,
);
const markStoredChapterContentMissingMock = vi.mocked(
  markStoredChapterContentMissing,
);
const saveChapterContentMetadataMock = vi.mocked(saveChapterContentMetadata);
const saveChapterPartialContentMetadataMock = vi.mocked(
  saveChapterPartialContentMetadata,
);
const isAndroidRuntimeMock = vi.mocked(isAndroidRuntime);
const isTauriRuntimeMock = vi.mocked(isTauriRuntime);

const storageRowMock = vi.fn<(args?: unknown) => Promise<unknown>>();
const storageRowsListMock = vi.fn<(args?: unknown) => Promise<unknown[]>>();
const mirrorInvokeMock = vi.fn<
  (command: string, args?: unknown) => Promise<unknown>
>();

function chapterRow(overrides: Record<string, unknown> = {}) {
  return {
    chapterId: 10,
    chapterName: "Chapter 1",
    chapterNumber: "1",
    contentBytes: 10,
    sourceContentType: "text",
    storedContentType: "html",
    isDownloaded: true,
    mediaBytes: 0,
    mediaRepairNeeded: false,
    novelId: 1,
    novelName: "Sample Novel",
    sourceNovelId: "1",
    novelPath: "/n/1",
    pluginId: "demo",
    position: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storageRowMock.mockImplementation(async () => chapterRow());
  storageRowsListMock.mockImplementation(async () => [chapterRow()]);
  mirrorInvokeMock.mockImplementation(async (command: string) => {
    if (command === "chapter_content_mirror_inspect") {
      return {
        status: "present",
        mediaComplete: true,
        contentFile: "contents/demo/1/1/content.html",
        contentBytes: 10,
        mediaBytes: 0,
      };
    }
    return undefined;
  });
  isAndroidRuntimeMock.mockReturnValue(false);
  isTauriRuntimeMock.mockReturnValue(true);
  invokeMock.mockImplementation(async (command, args) => {
    if (command === "db_chapter_get_storage_row") {
      return storageRowMock(args);
    }
    if (command === "db_chapter_list_storage_rows") {
      return storageRowsListMock(args);
    }
    return mirrorInvokeMock(command, args);
  });
  adoptStoredChapterContentMetadataMock.mockResolvedValue({ rowsAffected: 1 });
  markStoredChapterContentMissingMock.mockResolvedValue({ rowsAffected: 1 });
  saveChapterContentMetadataMock.mockResolvedValue({ rowsAffected: 1 });
  saveChapterPartialContentMetadataMock.mockResolvedValue({ rowsAffected: 1 });
});

describe("chapter content storage", () => {
  it.each([false, true])(
    "reads matching committed artifacts without adopting unchanged metadata (incomplete: %s)",
    async (incomplete) => {
      const artifacts = {
        status: "present",
        mediaComplete: !incomplete,
        contentFile: "contents/demo/1/1/content.html",
        contentBytes: 10,
        mediaBytes: 0,
      };
      storageRowMock.mockResolvedValue(
        chapterRow({
          isDownloaded: !incomplete,
          mediaRepairNeeded: incomplete,
        }),
      );
      mirrorInvokeMock.mockImplementation(async (command: string) =>
        command === "chapter_content_mirror_inspect" ? artifacts : "<p>stored</p>",
      );
      adoptStoredChapterContentMetadataMock.mockImplementation(() => {
        throw new Error("Reader queued unchanged metadata");
      });

      await expect(
        readStoredChapterContentMirror(10, "committed"),
      ).resolves.toBe("<p>stored</p>");
      expect(storageRowMock).toHaveBeenCalledExactlyOnceWith({
        chapterId: 10,
        readMode: "committed",
      });
      expect(adoptStoredChapterContentMetadataMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { contentBytes: 9 },
    { mediaBytes: 1 },
    { storedContentType: null },
    { isDownloaded: false },
    { mediaRepairNeeded: true },
  ])(
    "reconciles changed artifacts when reading committed metadata: %j",
    async (metadata) => {
      storageRowMock.mockResolvedValue(chapterRow(metadata));
      mirrorInvokeMock.mockImplementation(async (command: string) =>
        command === "chapter_content_mirror_inspect"
          ? {
              status: "present",
              mediaComplete: true,
              contentFile: "contents/demo/1/1/content.html",
              contentBytes: 10,
              mediaBytes: 0,
            }
          : "<p>stored</p>",
      );

      await expect(
        readStoredChapterContentMirror(10, "committed"),
      ).resolves.toBe("<p>stored</p>");
      expect(
        adoptStoredChapterContentMetadataMock,
      ).toHaveBeenCalledExactlyOnceWith(10, 10, 0, "html", false);
    },
  );

  it("reads chapter content from the storage file", async () => {
    mirrorInvokeMock.mockImplementation(async (command: string) => {
      if (command === "chapter_content_mirror_inspect") {
        return {
          status: "present",
          mediaComplete: true,
          contentFile: "contents/demo/1/1/content.html",
          contentBytes: 13,
          mediaBytes: 0,
        };
      }
      if (command === "chapter_content_mirror_read_file") {
        return "<p>stored</p>";
      }
      return undefined;
    });

    await expect(readStoredChapterContentMirror(10)).resolves.toBe(
      "<p>stored</p>",
    );

    expect(storageRowMock).toHaveBeenCalledWith({
      chapterId: 10,
      readMode: "queued",
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "chapter_content_mirror_read_file",
      {
        contentFile: expect.stringContaining("content.html"),
      },
    );
    expect(adoptStoredChapterContentMetadataMock).toHaveBeenCalledWith(
      10,
      13,
      0,
      "html",
      false,
    );
  });

  it("treats an empty final content file as downloaded", async () => {
    mirrorInvokeMock.mockImplementation(async (command: string) => {
      if (command === "chapter_content_mirror_inspect") {
        return {
          status: "present",
          mediaComplete: true,
          contentFile: "contents/demo/1/1/content.html",
          contentBytes: 0,
          mediaBytes: 0,
        };
      }
      if (command === "chapter_content_mirror_read_file") return "";
      return undefined;
    });

    await expect(readStoredChapterContentMirror(10)).resolves.toBe("");
    expect(adoptStoredChapterContentMetadataMock).toHaveBeenCalledWith(
      10,
      0,
      0,
      "html",
      false,
    );
  });

  it("normalizes adopted text metadata to the physical HTML file", async () => {
    storageRowMock.mockResolvedValueOnce(
      chapterRow({ sourceContentType: "text", storedContentType: null }),
    );
    mirrorInvokeMock.mockImplementation(async (command: string) => {
      if (command === "chapter_content_mirror_inspect") {
        return {
          status: "present",
          mediaComplete: true,
          contentFile: "contents/demo/1/1/content.html",
          contentBytes: 10,
          mediaBytes: 0,
        };
      }
      if (command === "chapter_content_mirror_read_file") return "<p>text</p>";
      return undefined;
    });

    await expect(reconcileStoredChapterContent(10)).resolves.toMatchObject({
      status: "present",
      mediaComplete: true,
      contentFile: expect.stringContaining("content.html"),
    });
    expect(adoptStoredChapterContentMetadataMock).toHaveBeenCalledWith(
      10,
      10,
      0,
      "html",
      false,
    );
  });

  it("adopts final content for fresh download metadata", async () => {
    storageRowMock.mockResolvedValueOnce(
      chapterRow({
        contentBytes: 0,
        isDownloaded: false,
        mediaBytes: 0,
        storedContentType: null,
      }),
    );
    mirrorInvokeMock.mockImplementation(async (command: string) => {
      if (command === "chapter_content_mirror_inspect") {
        return {
          status: "present",
          mediaComplete: true,
          contentFile: "contents/demo/1/1/content.html",
          contentBytes: 10,
          mediaBytes: 0,
        };
      }
      if (command === "chapter_content_mirror_read_file") return "<p>fresh</p>";
      return undefined;
    });

    await expect(reconcileStoredChapterContent(10)).resolves.toMatchObject({
      status: "present",
      mediaComplete: true,
      contentFile: expect.stringContaining("content.html"),
      contentBytes: 10,
      mediaBytes: 0,
    });
    expect(adoptStoredChapterContentMetadataMock).toHaveBeenCalledWith(
      10,
      10,
      0,
      "html",
      false,
    );
  });

  it.each([false, true])(
    "restores repair metadata from artifact inspection for downloaded flag %s",
    async (isDownloaded) => {
      const storedHtml =
        '<img src="media/local.webp"><img src="https://cdn.example/panel.webp">';
      storageRowMock.mockResolvedValueOnce(
        chapterRow({ isDownloaded, mediaRepairNeeded: false }),
      );
      mirrorInvokeMock.mockImplementation(async (command: string) => {
        if (command === "chapter_content_mirror_inspect") {
          return {
            status: "present",
            mediaComplete: false,
            contentFile: "contents/demo/1/1/content.html",
            contentBytes: 82,
            mediaBytes: 1024,
          };
        }
        if (command === "chapter_content_mirror_read_file") return storedHtml;
        return undefined;
      });

      await expect(readStoredChapterContentMirror(10)).resolves.toBe(storedHtml);

      expect(adoptStoredChapterContentMetadataMock).toHaveBeenCalledWith(
        10,
        82,
        1024,
        "html",
        true,
      );
      expect(markStoredChapterContentMissingMock).not.toHaveBeenCalled();
      expect(
        mirrorInvokeMock.mock.calls.filter(
          ([command]) => command === "chapter_content_mirror_read_file",
        ),
      ).toHaveLength(1);
    },
  );

  it("clears stale repair metadata when all manifest assets are stored", async () => {
    storageRowMock.mockResolvedValueOnce(
      chapterRow({ mediaRepairNeeded: true }),
    );
    mirrorInvokeMock.mockImplementation(async (command: string) => {
      if (command === "chapter_content_mirror_inspect") {
        return {
          status: "present",
          mediaComplete: true,
          contentFile: "contents/demo/1/1/content.html",
          contentBytes: 48,
          mediaBytes: 1024,
        };
      }
      if (command === "chapter_content_mirror_read_file") {
        return '<img src="media/panel.webp"><img src="data:image/png;base64,AAAA">';
      }
      return undefined;
    });

    await expect(reconcileStoredChapterContent(10)).resolves.toMatchObject({
      status: "present",
      mediaComplete: true,
    });

    expect(adoptStoredChapterContentMetadataMock).toHaveBeenCalledWith(
      10,
      48,
      1024,
      "html",
      false,
    );
  });

  it("preserves metadata when a final HTML file cannot be read", async () => {
    mirrorInvokeMock.mockImplementation(async (command: string) => {
      if (command === "chapter_content_mirror_inspect") {
        return {
          status: "present",
          mediaComplete: true,
          contentFile: "contents/demo/1/1/content.html",
          contentBytes: 48,
          mediaBytes: 1024,
        };
      }
      if (command === "chapter_content_mirror_read_file") {
        throw new Error("Storage access denied.");
      }
      return undefined;
    });

    await expect(reconcileStoredChapterContent(10)).rejects.toThrow(
      "Storage access denied.",
    );
    expect(adoptStoredChapterContentMetadataMock).not.toHaveBeenCalled();
    expect(markStoredChapterContentMissingMock).not.toHaveBeenCalled();
  });

  it("does not load a binary PDF during metadata reconciliation", async () => {
    mirrorInvokeMock.mockResolvedValueOnce({
      status: "present",
      mediaComplete: true,
      contentFile: "contents/demo/1/1/content.pdf",
      contentBytes: 4096,
      mediaBytes: 0,
    });

    await reconcileStoredChapterContent(10);

    expect(mirrorInvokeMock).toHaveBeenCalledTimes(1);
    expect(adoptStoredChapterContentMetadataMock).toHaveBeenCalledWith(
      10,
      4096,
      0,
      "pdf",
      false,
    );
  });

  it("marks HTML missing when it disappears after artifact inspection", async () => {
    mirrorInvokeMock.mockImplementation(async (command: string) => {
      if (command === "chapter_content_mirror_inspect") {
        return {
          status: "present",
          mediaComplete: true,
          contentFile: "contents/demo/1/1/content.html",
          contentBytes: 48,
          mediaBytes: 1024,
        };
      }
      if (command === "chapter_content_mirror_read_file") return null;
      return undefined;
    });

    await expect(reconcileStoredChapterContent(10)).resolves.toMatchObject({
      status: "missing",
    });
    expect(adoptStoredChapterContentMetadataMock).not.toHaveBeenCalled();
    expect(markStoredChapterContentMissingMock).toHaveBeenCalledOnce();
  });

  it("marks non-local metadata missing when no final content file exists", async () => {
    mirrorInvokeMock.mockResolvedValueOnce({
      status: "missing",
      contentFile: null,
      contentBytes: 0,
      mediaBytes: 0,
    });

    await expect(readStoredChapterContentMirror(10)).resolves.toBeNull();
    expect(markStoredChapterContentMissingMock).toHaveBeenCalledWith(10);
  });

  it("writes chapter content and partial chapter content to storage and saves metadata", async () => {
    const result = await saveStoredChapterContent(10, "<p>stored</p>", "html", {
      mediaBytes: 12,
    });

    expect(saveChapterContentMetadataMock).toHaveBeenCalledWith(
      10,
      "<p>stored</p>",
      "html",
      { mediaBytes: 12 },
    );
    expect(invokeMock).toHaveBeenCalledWith("chapter_content_mirror_store", {
      chapterId: 10,
      content: "<p>stored</p>",
      metadata: expect.objectContaining({
        chapter: expect.objectContaining({ id: 10, name: "Chapter 1" }),
        novel: expect.objectContaining({ id: 1, name: "Sample Novel" }),
      }),
    });
    expect(result).toEqual({ rowsAffected: 1 });

    await saveStoredChapterPartialContent(10, "<p>partial</p>", "html");
    expect(saveChapterPartialContentMetadataMock).toHaveBeenCalledWith(
      10,
      "<p>partial</p>",
      "html",
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "chapter_content_mirror_store_partial",
      expect.objectContaining({ content: "<p>partial</p>" }),
    );
  });

  it("uses the Rust mirror IPC commands on Android", async () => {
    isAndroidRuntimeMock.mockReturnValue(true);
    mirrorInvokeMock.mockImplementation(async (command: string) => {
      if (command === "chapter_content_mirror_inspect") {
        return {
          status: "present",
          mediaComplete: true,
          contentFile: "contents/demo/1/1/content.html",
          contentBytes: 12,
          mediaBytes: 0,
        };
      }
      if (command === "chapter_content_mirror_read_file") {
        return "<p>android</p>";
      }
      return undefined;
    });

    await expect(readStoredChapterContentMirror(10)).resolves.toBe(
      "<p>android</p>",
    );
    await writeStoredChapterContentMirror(10, "<p>android</p>");
    await clearStoredChapterContentMirror(10);

    expect(invokeMock).toHaveBeenCalledWith(
      "chapter_content_mirror_read_file",
      { contentFile: expect.stringContaining("content.html") },
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "chapter_content_mirror_store",
      expect.objectContaining({ chapterId: 10, content: "<p>android</p>" }),
    );
    expect(invokeMock).toHaveBeenCalledWith("chapter_content_mirror_clear", {
      chapterDir: expect.stringContaining("contents/demo/1/1"),
    });
  });

  it("preserves metadata when Android storage is inaccessible", async () => {
    isAndroidRuntimeMock.mockReturnValue(true);
    mirrorInvokeMock.mockRejectedValueOnce(
      new Error("Android storage folder is not readable."),
    );

    await expect(readStoredChapterContentMirror(10)).rejects.toThrow(
      "Android storage folder is not readable.",
    );
    expect(markStoredChapterContentMissingMock).not.toHaveBeenCalled();
  });

  it("continues startup reconciliation after one chapter inspection fails", async () => {
    storageRowsListMock.mockResolvedValueOnce([
      chapterRow(),
      chapterRow({
        chapterId: 11,
        chapterName: "Chapter 2",
        chapterNumber: "2",
        position: 2,
      }),
    ]);
    let inspectionCount = 0;
    mirrorInvokeMock.mockImplementation(async (command: string) => {
      if (command === "chapter_content_mirror_read_file") return "<p>ok</p>";
      if (command !== "chapter_content_mirror_inspect") return undefined;
      inspectionCount += 1;
      if (inspectionCount === 1) throw new Error("interrupted finalization");
      return {
        status: "present",
        mediaComplete: true,
        contentFile: "contents/demo/1/2/content.html",
        contentBytes: 12,
        mediaBytes: 8,
      };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(restoreChapterContentStorageMirror()).resolves.toEqual({
      chapters: 1,
      cursorChapterId: 11,
      novels: 0,
      scannedChapters: 2,
    });

    expect(adoptStoredChapterContentMetadataMock).toHaveBeenCalledWith(
      11,
      12,
      8,
      "html",
      false,
    );
    expect(warn).toHaveBeenCalledWith(
      "[storage] failed to reconcile stored chapter",
      expect.objectContaining({ chapterId: 10 }),
    );
    warn.mockRestore();
  });
});
