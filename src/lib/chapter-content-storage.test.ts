import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("../db/queries/chapter", () => ({
  adoptStoredChapterContentMetadata: vi.fn(),
  markStoredChapterContentMissing: vi.fn(),
  saveChapterContentMetadata: vi.fn(),
  saveChapterPartialContentMetadata: vi.fn(),
}));

vi.mock("./android-storage", () => ({
  deleteAndroidStoragePath: vi.fn(),
  inspectAndroidChapterArtifacts: vi.fn(),
  readAndroidStorageText: vi.fn(),
  renameAndroidStoragePath: vi.fn(),
  writeAndroidStorageText: vi.fn(),
}));

vi.mock("./tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(),
  isTauriRuntime: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { getDb } from "../db/client";
import {
  adoptStoredChapterContentMetadata,
  markStoredChapterContentMissing,
  saveChapterContentMetadata,
  saveChapterPartialContentMetadata,
} from "../db/queries/chapter";
import {
  deleteAndroidStoragePath,
  inspectAndroidChapterArtifacts,
  readAndroidStorageText,
  renameAndroidStoragePath,
  writeAndroidStorageText,
} from "./android-storage";
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

const getDbMock = vi.mocked(getDb);
const invokeMock = vi.mocked(invoke);
const adoptStoredChapterContentMetadataMock = vi.mocked(
  adoptStoredChapterContentMetadata,
);
const markStoredChapterContentMissingMock = vi.mocked(
  markStoredChapterContentMissing,
);
const saveChapterContentMetadataMock = vi.mocked(saveChapterContentMetadata);
const saveChapterPartialContentMetadataMock = vi.mocked(saveChapterPartialContentMetadata);
const deleteAndroidStoragePathMock = vi.mocked(deleteAndroidStoragePath);
const inspectAndroidChapterArtifactsMock = vi.mocked(
  inspectAndroidChapterArtifacts,
);
const readAndroidStorageTextMock = vi.mocked(readAndroidStorageText);
const renameAndroidStoragePathMock = vi.mocked(renameAndroidStoragePath);
const writeAndroidStorageTextMock = vi.mocked(writeAndroidStorageText);
const isAndroidRuntimeMock = vi.mocked(isAndroidRuntime);
const isTauriRuntimeMock = vi.mocked(isTauriRuntime);
let selectMock: ReturnType<typeof vi.fn>;

function chapterRow(overrides: Record<string, unknown> = {}) {
  return {
    artist: null,
    author: null,
    bookmark: 0,
    chapterCreatedAt: 1_700_000_000,
    chapterFoundAt: 1_700_000_000,
    chapterId: 10,
    chapterName: "Chapter 1",
    chapterNumber: "1",
    chapterPath: "/c/1",
    chapterUpdatedAt: 1_700_000_000,
    contentBytes: 10,
    sourceContentType: "text",
    storedContentType: "html",
    cover: null,
    genres: null,
    inLibrary: 1,
    isDownloaded: 1,
    isLocal: 0,
    lastReadAt: null,
    libraryAddedAt: 1_700_000_000,
    mediaBytes: 0,
    novelCreatedAt: 1_700_000_000,
    novelId: 1,
    novelName: "Sample Novel",
    novelPath: "/n/1",
    novelUpdatedAt: 1_700_000_000,
    page: "1",
    pluginId: "demo",
    position: 1,
    progress: 0,
    readAt: null,
    releaseTime: null,
    status: null,
    summary: null,
    unread: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectMock = vi.fn().mockResolvedValue([chapterRow()]);
  getDbMock.mockResolvedValue({ select: selectMock } as never);
  isAndroidRuntimeMock.mockReturnValue(false);
  isTauriRuntimeMock.mockReturnValue(true);
  invokeMock.mockImplementation(async (command) => {
    if (command === "chapter_content_mirror_inspect") {
      return {
        status: "present",
        contentFile: "contents/demo/Sample-Novel-n-1/1-Chapter-1/content.html",
        contentBytes: 10,
        mediaBytes: 0,
      };
    }
    return undefined;
  });
  inspectAndroidChapterArtifactsMock.mockResolvedValue({
    status: "present",
    contentFile: "contents/demo/Sample-Novel-n-1/1-Chapter-1/content.html",
    contentBytes: 10,
    mediaBytes: 0,
  });
  adoptStoredChapterContentMetadataMock.mockResolvedValue({ rowsAffected: 1 });
  markStoredChapterContentMissingMock.mockResolvedValue({ rowsAffected: 1 });
  saveChapterContentMetadataMock.mockResolvedValue({ rowsAffected: 1 });
  saveChapterPartialContentMetadataMock.mockResolvedValue({ rowsAffected: 1 });
  renameAndroidStoragePathMock.mockResolvedValue(undefined);
});

describe("chapter content storage", () => {
  it("reads chapter content from the storage file", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "chapter_content_mirror_inspect") {
        return {
          status: "present",
          contentFile: "contents/demo/Sample-Novel-n-1/1-Chapter-1/content.html",
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

    expect(selectMock).toHaveBeenCalledWith(expect.stringContaining("FROM chapter c"), [
      10,
    ]);
    expect(invokeMock).toHaveBeenCalledWith("chapter_content_mirror_read_file", {
      contentFile: expect.stringContaining("content.html"),
    });
    expect(adoptStoredChapterContentMetadataMock).toHaveBeenCalledWith(
      10,
      13,
      0,
      "html",
    );
  });

  it("treats an empty final content file as downloaded", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "chapter_content_mirror_inspect") {
        return {
          status: "present",
          contentFile: "contents/demo/Sample-Novel-n-1/1-Chapter-1/content.html",
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
    );
  });

  it("normalizes adopted text metadata to the physical HTML file", async () => {
    selectMock.mockResolvedValueOnce([
      chapterRow({ sourceContentType: "text", storedContentType: null }),
    ]);

    await expect(reconcileStoredChapterContent(10)).resolves.toMatchObject({
      status: "present",
      contentFile: expect.stringContaining("content.html"),
    });
    expect(adoptStoredChapterContentMetadataMock).toHaveBeenCalledWith(
      10,
      10,
      0,
      "html",
    );
  });

  it("adopts final content for fresh download metadata", async () => {
    selectMock.mockResolvedValueOnce([
      chapterRow({
        contentBytes: 0,
        isDownloaded: 0,
        mediaBytes: 0,
        storedContentType: null,
      }),
    ]);

    await expect(reconcileStoredChapterContent(10)).resolves.toMatchObject({
      status: "present",
      contentFile: expect.stringContaining("content.html"),
      contentBytes: 10,
      mediaBytes: 0,
    });
    expect(adoptStoredChapterContentMetadataMock).toHaveBeenCalledWith(
      10,
      10,
      0,
      "html",
    );
  });

  it("marks non-local metadata missing when no final content file exists", async () => {
    invokeMock.mockResolvedValueOnce({
      status: "missing",
      contentFile: null,
      contentBytes: 0,
      mediaBytes: 0,
    });

    await expect(readStoredChapterContentMirror(10)).resolves.toBeNull();
    expect(markStoredChapterContentMissingMock).toHaveBeenCalledWith(10);
  });

  it("writes chapter content to the storage file and saves metadata", async () => {
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
  });

  it("writes partial chapter content to the storage file and saves metadata", async () => {
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

  it("uses Android storage APIs on Android", async () => {
    isAndroidRuntimeMock.mockReturnValue(true);
    readAndroidStorageTextMock.mockResolvedValueOnce("<p>android</p>");

    await expect(readStoredChapterContentMirror(10)).resolves.toBe(
      "<p>android</p>",
    );
    await writeStoredChapterContentMirror(10, "<p>android</p>");
    await clearStoredChapterContentMirror(10);

    expect(readAndroidStorageTextMock).toHaveBeenCalledWith(
      expect.stringContaining("content.html"),
    );
    expect(writeAndroidStorageTextMock).toHaveBeenCalledWith(
      expect.stringContaining("content.html.tmp"),
      "<p>android</p>",
    );
    expect(renameAndroidStoragePathMock).toHaveBeenCalledWith(
      expect.stringContaining("content.html.tmp"),
      "content.html",
    );
    expect(deleteAndroidStoragePathMock).toHaveBeenCalledWith(
      expect.stringContaining("content.html"),
    );
  });

  it("preserves metadata when Android storage is inaccessible", async () => {
    isAndroidRuntimeMock.mockReturnValue(true);
    inspectAndroidChapterArtifactsMock.mockRejectedValueOnce(
      new Error("Android storage folder is not readable."),
    );

    await expect(readStoredChapterContentMirror(10)).rejects.toThrow(
      "Android storage folder is not readable.",
    );
    expect(markStoredChapterContentMissingMock).not.toHaveBeenCalled();
  });

  it("continues startup reconciliation after one chapter inspection fails", async () => {
    selectMock.mockResolvedValueOnce([
      chapterRow(),
      chapterRow({
        chapterId: 11,
        chapterName: "Chapter 2",
        chapterNumber: "2",
        position: 2,
      }),
    ]);
    let inspectionCount = 0;
    invokeMock.mockImplementation(async (command) => {
      if (command !== "chapter_content_mirror_inspect") return undefined;
      inspectionCount += 1;
      if (inspectionCount === 1) throw new Error("interrupted finalization");
      return {
        status: "present",
        contentFile: "contents/demo/Sample-Novel-n-1/2-Chapter-2/content.html",
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
    );
    expect(warn).toHaveBeenCalledWith(
      "[storage] failed to reconcile stored chapter",
      expect.objectContaining({ chapterId: 10 }),
    );
    warn.mockRestore();
  });
});
