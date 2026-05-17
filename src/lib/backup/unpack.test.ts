import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../performance-budgets", () => {
  const assertByteBudget = (
    byteLength: number,
    maxBytes: number,
    label: string,
  ) => {
    if (byteLength > maxBytes) {
      throw new Error(`${label} exceeds test budget.`);
    }
  };
  return {
    MAX_BACKUP_ARCHIVE_BYTES: 4,
    MAX_ZIP_ENTRY_BYTES: 4,
    MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES: 6,
    assertByteBudget,
  };
});

import { invoke } from "@tauri-apps/api/core";
import {
  BACKUP_FORMAT_VERSION,
  BackupFormatError,
  encodeBackupManifest,
  type BackupManifest,
} from "./format";
import {
  getBackupChapterMediaFiles,
  hasBackupChapterMediaFiles,
  unpackBackup,
  unpackBackupBytes,
} from "./unpack";

const invokeMock = vi.mocked(invoke);

function makeLeanManifest(): BackupManifest {
  return {
    version: BACKUP_FORMAT_VERSION,
    exportedAt: 1_700_000_000,
    novels: [
      {
        id: 1,
        pluginId: "demo",
        path: "/n/1",
        name: "Sample Novel",
        cover: null,
        summary: null,
        author: null,
        artist: null,
        status: null,
        genres: null,
        inLibrary: true,
        isLocal: false,
        createdAt: 1_700_000_000,
        updatedAt: 1_700_000_000,
        libraryAddedAt: 1_700_000_000,
        lastReadAt: null,
      },
    ],
    chapters: [
      {
        id: 10,
        novelId: 1,
        path: "/c/1",
        name: "Chapter 1",
        chapterNumber: "1",
        position: 1,
        page: "1",
        bookmark: false,
        unread: true,
        progress: 0,
        isDownloaded: true,
        content: null,
        releaseTime: null,
        readAt: null,
        createdAt: 1_700_000_000,
        foundAt: 1_700_000_000,
        updatedAt: 1_700_000_000,
      },
      {
        id: 11,
        novelId: 1,
        path: "/c/2",
        name: "Chapter 2",
        chapterNumber: "2",
        position: 2,
        page: "1",
        bookmark: false,
        unread: true,
        progress: 0,
        isDownloaded: false,
        content: null,
        releaseTime: null,
        readAt: null,
        createdAt: 1_700_000_000,
        foundAt: 1_700_000_000,
        updatedAt: 1_700_000_000,
      },
    ],
    categories: [{ id: 1, name: "Default", sort: 0, isSystem: true }],
    novelCategories: [{ id: 1, novelId: 1, categoryId: 1 }],
    repositories: [],
  };
}

describe("unpackBackup", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("re-injects chapter content into matching chapter rows", async () => {
    const lean = makeLeanManifest();
    invokeMock.mockResolvedValue({
      manifest_json: encodeBackupManifest(lean),
      chapters: [{ id: 10, html: "<p>downloaded</p>" }],
    });

    const restored = await unpackBackup("C:\\backup.zip");

    expect(invokeMock).toHaveBeenCalledWith("backup_unpack_staged", {
      inputPath: "C:\\backup.zip",
    });
    expect(restored.chapters[0]?.content).toBe("<p>downloaded</p>");
    expect(restored.chapters[1]?.content).toBeNull();
    expect(restored.novels).toEqual(lean.novels);
  });

  it("leaves chapters with no matching entry untouched", async () => {
    const lean = makeLeanManifest();
    invokeMock.mockResolvedValue({
      manifest_json: encodeBackupManifest(lean),
      chapters: [],
    });

    const restored = await unpackBackup("C:\\empty.zip");
    expect(restored.chapters[0]?.content).toBeNull();
    expect(restored.chapters[1]?.content).toBeNull();
    expect(getBackupChapterMediaFiles(restored)).toEqual([]);
    expect(hasBackupChapterMediaFiles(restored)).toBe(false);
  });

  it("attaches local chapter media entries for restore", async () => {
    const lean = makeLeanManifest();
    invokeMock.mockResolvedValue({
      manifest_json: encodeBackupManifest(lean),
      chapters: [],
      chapter_media: [
        {
          bytes: 3,
          media_src: "norea-media://chapter/10/image.png",
          staged_ref: "media-0.bin",
        },
      ],
      staging_id: "stage-1",
    });

    const restored = await unpackBackup("C:\\backup.zip");

    expect(restored.chapters[0]?.mediaBytes).toBe(3);
    expect(getBackupChapterMediaFiles(restored)).toEqual([
      {
        mediaSrc: "norea-media://chapter/10/image.png",
        bytes: 3,
        stagedRef: "media-0.bin",
        stagingId: "stage-1",
      },
    ]);
    expect(hasBackupChapterMediaFiles(restored)).toBe(true);
  });

  it("falls back to legacy media bodies when the staged command is unavailable", async () => {
    const lean = makeLeanManifest();
    invokeMock
      .mockRejectedValueOnce(new Error("unknown command: backup_unpack_staged"))
      .mockResolvedValueOnce({
        manifest_json: encodeBackupManifest(lean),
        chapters: [],
        chapter_media: [
          {
            media_src: "norea-media://chapter/10/image.png",
            body: [1, 2, 3],
          },
        ],
      });

    const restored = await unpackBackup("C:\\backup.zip");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "backup_unpack_staged", {
      inputPath: "C:\\backup.zip",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "backup_unpack", {
      inputPath: "C:\\backup.zip",
    });
    expect(getBackupChapterMediaFiles(restored)).toEqual([
      {
        mediaSrc: "norea-media://chapter/10/image.png",
        body: [1, 2, 3],
        bytes: 3,
      },
    ]);
  });

  it("rejects staged media entries that exceed the body budget", async () => {
    const lean = makeLeanManifest();
    invokeMock.mockResolvedValue({
      manifest_json: encodeBackupManifest(lean),
      chapters: [],
      chapter_media: [
        {
          bytes: 5,
          media_src: "norea-media://chapter/10/large.png",
          staged_ref: "media-0.bin",
        },
      ],
      staging_id: "stage-1",
    });

    await expect(unpackBackup("C:\\backup.zip")).rejects.toThrow(
      "Backup media entry exceeds test budget.",
    );
    expect(invokeMock).toHaveBeenCalledWith("backup_cleanup_staged_unpack", {
      stagingId: "stage-1",
    });
  });

  it("rejects Android fallback byte imports over the archive budget before IPC", async () => {
    await expect(unpackBackupBytes([1, 2, 3, 4, 5])).rejects.toThrow(
      "Backup archive exceeds test budget.",
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("propagates BackupFormatError on a malformed envelope", async () => {
    invokeMock.mockResolvedValue({
      manifest_json: "{ not valid json",
      chapters: [],
    });

    await expect(unpackBackup("C:\\bad.zip")).rejects.toBeInstanceOf(
      BackupFormatError,
    );
  });
});
