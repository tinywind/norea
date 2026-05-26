import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../chapter-media", () => ({
  localChapterMediaSources: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { localChapterMediaSources } from "../chapter-media";
import { BACKUP_FORMAT_VERSION, type BackupManifest } from "./format";
import { deleteBackupTempFile, packBackup, packBackupTempFile } from "./pack";

const invokeMock = vi.mocked(invoke);
const localChapterMediaSourcesMock = vi.mocked(localChapterMediaSources);

function makeManifest(): BackupManifest {
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
        contentType: "html",
        content: "<p>downloaded</p>",
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
        contentType: "html",
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
    installedPlugins: [
      {
        id: "demo",
        name: "Demo",
        lang: "en",
        version: "1.0.0",
        iconUrl: "https://example.test/icon.png",
        sourceUrl: "https://example.test/index.js",
        sourceCode: "module.exports.default = {};",
        installedAt: 1_700_000_000,
      },
    ],
    settings: [{ key: "reader-settings", value: "{\"state\":{}}" }],
  };
}

describe("packBackup", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    localChapterMediaSourcesMock.mockReset();
    localChapterMediaSourcesMock.mockReturnValue([]);
  });

  it("invokes backup_pack with manifest content and media payloads", async () => {
    const manifest = makeManifest();
    await packBackup(manifest, "C:\\backup.zip");

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, args] = invokeMock.mock.calls[0]!;
    expect(command).toBe("backup_pack");

    const typed = args as {
      chapterMedia: unknown[];
      manifestJson: string;
      outputPath: string;
    };
    expect(typed.outputPath).toBe("C:\\backup.zip");
    expect(args).not.toHaveProperty("chapters");
    expect(typed.chapterMedia).toEqual([]);

    const packedManifest = JSON.parse(typed.manifestJson) as BackupManifest;
    expect(packedManifest.chapters[0]?.content).toBe("<p>downloaded</p>");
    expect(packedManifest.chapters[0]?.isDownloaded).toBe(true);
    expect(packedManifest.chapters[1]?.content).toBeNull();
    expect(packedManifest.chapters[1]?.isDownloaded).toBe(false);
    expect(packedManifest.novels).toEqual(manifest.novels);
  });

  it("does not mutate the caller's manifest", async () => {
    const manifest = makeManifest();
    const before = JSON.parse(JSON.stringify(manifest));

    await packBackup(manifest, "C:\\backup.zip");

    expect(manifest).toEqual(before);
  });

  it("invokes backup_pack_temp_file with manifest content", async () => {
    const manifest = makeManifest();
    invokeMock.mockResolvedValue("C:\\temp\\norea-backup.zip");

    await expect(packBackupTempFile(manifest)).resolves.toBe(
      "C:\\temp\\norea-backup.zip",
    );

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, args] = invokeMock.mock.calls[0]!;
    expect(command).toBe("backup_pack_temp_file");

    const typed = args as { chapterMedia: unknown[]; manifestJson: string };
    expect(typed.chapterMedia).toEqual([]);
    const packedManifest = JSON.parse(typed.manifestJson) as BackupManifest;
    expect(packedManifest.chapters[0]?.content).toBe("<p>downloaded</p>");
    expect(packedManifest.chapters[0]?.isDownloaded).toBe(true);
  });

  it("sends media refs with chapter context without materializing bodies", async () => {
    const manifest = makeManifest();
    manifest.chapters[0] = {
      ...manifest.chapters[0]!,
      content:
        '<img src="norea-media://chapter/image.png"><img src="norea-media://chapter/image.png">',
    };
    localChapterMediaSourcesMock.mockReturnValue([
      "norea-media://chapter/image.png",
      "norea-media://chapter/image.png",
    ]);
    await packBackup(manifest, "C:\\backup.zip");

    const [, args] = invokeMock.mock.calls[0]!;
    expect(args).toMatchObject({
      chapterMedia: [],
      chapterMediaFiles: [
        {
          media_src: "norea-media://chapter/image.png",
          chapter_id: 10,
          novel_id: 1,
          source_id: "demo",
          novel_name: "Sample Novel",
          novel_path: "/n/1",
          chapter_number: "1",
          chapter_name: "Chapter 1",
          chapter_position: 1,
        },
      ],
    });
  });

  it("lets the Rust command enforce media file size budgets", async () => {
    const manifest = makeManifest();
    manifest.chapters[0] = {
      ...manifest.chapters[0]!,
      content: '<img src="norea-media://chapter/large.png">',
    };
    localChapterMediaSourcesMock.mockReturnValue([
      "norea-media://chapter/large.png",
    ]);
    await packBackup(manifest, "C:\\backup.zip");

    const [, args] = invokeMock.mock.calls[0]!;
    expect(args).toMatchObject({
      chapterMedia: [],
      chapterMediaFiles: [
        {
          media_src: "norea-media://chapter/large.png",
          chapter_id: 10,
        },
      ],
    });
  });

  it("deletes backup temp files through the Rust command", async () => {
    await deleteBackupTempFile("C:\\temp\\norea-backup.zip");

    expect(invokeMock).toHaveBeenCalledWith("backup_delete_temp_file", {
      path: "C:\\temp\\norea-backup.zip",
    });
  });
});
