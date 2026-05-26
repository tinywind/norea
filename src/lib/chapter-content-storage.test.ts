import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("../db/queries/chapter", () => ({
  saveChapterContentMetadata: vi.fn(),
  saveChapterPartialContentMetadata: vi.fn(),
}));

vi.mock("./android-storage", () => ({
  deleteAndroidStoragePath: vi.fn(),
  readAndroidStorageText: vi.fn(),
  writeAndroidStorageText: vi.fn(),
}));

vi.mock("./tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(),
  isTauriRuntime: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { getDb } from "../db/client";
import {
  saveChapterContentMetadata,
  saveChapterPartialContentMetadata,
} from "../db/queries/chapter";
import {
  deleteAndroidStoragePath,
  readAndroidStorageText,
  writeAndroidStorageText,
} from "./android-storage";
import {
  clearStoredChapterContentMirror,
  readStoredChapterContentMirror,
  saveStoredChapterContent,
  saveStoredChapterPartialContent,
  writeStoredChapterContentMirror,
} from "./chapter-content-storage";
import { isAndroidRuntime, isTauriRuntime } from "./tauri-runtime";

const getDbMock = vi.mocked(getDb);
const invokeMock = vi.mocked(invoke);
const saveChapterContentMetadataMock = vi.mocked(saveChapterContentMetadata);
const saveChapterPartialContentMetadataMock = vi.mocked(saveChapterPartialContentMetadata);
const deleteAndroidStoragePathMock = vi.mocked(deleteAndroidStoragePath);
const readAndroidStorageTextMock = vi.mocked(readAndroidStorageText);
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
    contentType: "html",
    cover: null,
    genres: null,
    inLibrary: 1,
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
  invokeMock.mockResolvedValue(undefined);
  saveChapterContentMetadataMock.mockResolvedValue({ rowsAffected: 1 });
  saveChapterPartialContentMetadataMock.mockResolvedValue({ rowsAffected: 1 });
});

describe("chapter content storage", () => {
  it("reads chapter content from the storage file", async () => {
    invokeMock.mockResolvedValueOnce("<p>stored</p>");

    await expect(readStoredChapterContentMirror(10)).resolves.toBe(
      "<p>stored</p>",
    );

    expect(selectMock).toHaveBeenCalledWith(expect.stringContaining("FROM chapter c"), [
      10,
    ]);
    expect(invokeMock).toHaveBeenCalledWith("chapter_content_mirror_read_file", {
      contentFile: expect.stringContaining("content.html"),
    });
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
      "chapter_content_mirror_store",
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
      expect.stringContaining("content.html"),
      "<p>android</p>",
    );
    expect(deleteAndroidStoragePathMock).toHaveBeenCalledWith(
      expect.stringContaining("content.html"),
    );
  });

  it("returns null for optional Android storage read failures", async () => {
    isAndroidRuntimeMock.mockReturnValue(true);
    readAndroidStorageTextMock.mockRejectedValueOnce(
      new Error("Cannot open storage file for reading."),
    );

    await expect(readStoredChapterContentMirror(10)).resolves.toBeNull();
  });
});
