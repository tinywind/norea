import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("./android-storage", () => ({
  deleteAndroidStoragePath: vi.fn(),
  readAndroidStorageText: vi.fn(),
  writeAndroidStorageText: vi.fn(),
}));

vi.mock("./chapter-media", () => ({
  getStoredChapterMediaBytes: vi.fn(),
}));

vi.mock("./tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(),
  isTauriRuntime: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { getDb } from "../db/client";
import { getStoredChapterMediaBytes } from "./chapter-media";
import {
  mirrorAllStoredChapterContent,
  mirrorStoredNovelChapters,
  restoreChapterContentStorageMirror,
  startChapterContentStorageMirrorSweep,
} from "./chapter-content-storage";
import { isAndroidRuntime, isTauriRuntime } from "./tauri-runtime";

const getDbMock = vi.mocked(getDb);
const invokeMock = vi.mocked(invoke);
const getStoredChapterMediaBytesMock = vi.mocked(getStoredChapterMediaBytes);
const isAndroidRuntimeMock = vi.mocked(isAndroidRuntime);
const isTauriRuntimeMock = vi.mocked(isTauriRuntime);
let executeMock: ReturnType<typeof vi.fn>;
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
    content: "<p>one</p>",
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
  vi.useRealTimers();
  executeMock = vi.fn();
  selectMock = vi.fn();
  getDbMock.mockResolvedValue({
    execute: executeMock,
    select: selectMock,
  } as never);
  isAndroidRuntimeMock.mockReturnValue(false);
  isTauriRuntimeMock.mockReturnValue(true);
  getStoredChapterMediaBytesMock.mockResolvedValue(0);
  invokeMock.mockResolvedValue(undefined);
});

describe("chapter content storage mirror", () => {
  it("mirrors all stored chapters from one full-row query", async () => {
    selectMock.mockResolvedValue([
      chapterRow(),
      chapterRow({
        chapterId: 11,
        chapterName: "Chapter 2",
        chapterNumber: "2",
        chapterPath: "/c/2",
        content: "<p>two</p>",
        position: 2,
      }),
    ]);

    await expect(mirrorAllStoredChapterContent()).resolves.toBe(2);

    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(selectMock.mock.calls[0]?.[0]).toContain(
      "WHERE c.is_downloaded = 1",
    );
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "chapter_content_mirror_store",
      expect.objectContaining({
        chapterId: 10,
        content: "<p>one</p>",
        metadata: expect.objectContaining({
          chapter: expect.objectContaining({ id: 10, name: "Chapter 1" }),
          novel: expect.objectContaining({ id: 1, name: "Sample Novel" }),
        }),
      }),
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "chapter_content_mirror_store",
      expect.objectContaining({
        chapterId: 11,
        content: "<p>two</p>",
      }),
    );
  });

  it("mirrors stored novel chapters from one scoped full-row query", async () => {
    selectMock.mockResolvedValue([
      chapterRow({
        chapterId: 12,
        content: "<p>novel</p>",
      }),
    ]);

    await mirrorStoredNovelChapters(1);

    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(selectMock.mock.calls[0]?.[0]).toContain("WHERE c.novel_id = $1");
    expect(selectMock.mock.calls[0]?.[1]).toEqual([1]);
    expect(invokeMock).toHaveBeenCalledWith(
      "chapter_content_mirror_store",
      expect.objectContaining({
        chapterId: 12,
        content: "<p>novel</p>",
      }),
    );
  });

  it("restores one requested chapter without scanning every restorable row", async () => {
    selectMock.mockResolvedValueOnce([
      chapterRow({
        chapterId: 17,
        chapterName: "Restored",
        content: null,
      }),
    ]);
    invokeMock.mockImplementation(async (command) => {
      if (command === "chapter_content_mirror_read_file") {
        return "<p>restored</p>";
      }
      return undefined;
    });

    await expect(
      restoreChapterContentStorageMirror({
        chapterIds: new Set([17]),
        contentOnly: true,
        limit: 1,
      }),
    ).resolves.toEqual({
      chapters: 1,
      cursorChapterId: 17,
      novels: 0,
      scannedChapters: 1,
    });

    const [sql, params] = selectMock.mock.calls[0]!;
    expect(sql).toContain("c.content IS NULL");
    expect(sql).toContain("c.id IN ($1)");
    expect(sql).toContain("LIMIT $2");
    expect(params).toEqual([17, 1]);
      expect(executeMock).toHaveBeenCalledWith(
        expect.stringContaining("media_bytes_checked_at = unixepoch()"),
        ["<p>restored</p>", 15, 0, 0, "html", 17],
      );
  });

  it("does not fall back to a full sweep for an empty requested chapter set", async () => {
    await expect(
      restoreChapterContentStorageMirror({
        chapterIds: new Set(),
        contentOnly: true,
      }),
    ).resolves.toEqual({
      chapters: 0,
      cursorChapterId: null,
      novels: 0,
      scannedChapters: 0,
    });

    expect(selectMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("runs startup mirror restore as a small cursor sweep", async () => {
    vi.useFakeTimers();
    selectMock
      .mockResolvedValueOnce([chapterRow({ chapterId: 10, content: null })])
      .mockResolvedValueOnce([]);
    invokeMock.mockImplementation(async (command) => {
      if (command === "chapter_content_mirror_read_file") return null;
      return undefined;
    });

    const stop = startChapterContentStorageMirrorSweep({
      batchSize: 1,
      delayMs: 1,
    });

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    stop();

    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(selectMock.mock.calls[0]?.[1]).toEqual([1]);
    expect(selectMock.mock.calls[1]?.[1]).toEqual([10, 1]);
    vi.useRealTimers();
  });
});
