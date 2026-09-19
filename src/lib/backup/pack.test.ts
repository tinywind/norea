import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  BACKUP_FORMAT_VERSION,
  encodeBackupManifest,
  type BackupManifest,
} from "./format";
import { deleteBackupTempFile, packBackup, packBackupTempFile } from "./pack";

const invokeMock = vi.mocked(invoke);

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
        content: null,
        contentBytes: 17,
        mediaBytes: 0,
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
        contentBytes: 0,
        mediaBytes: 0,
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
  });

  it("invokes backup_pack with the manifest only", async () => {
    const manifest = makeManifest();
    await packBackup(manifest, "C:\\backup.zip");

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("backup_pack", {
      manifestJson: encodeBackupManifest(manifest),
      outputPath: "C:\\backup.zip",
    });

    const [, args] = invokeMock.mock.calls[0]!;
    const packedManifest = JSON.parse(
      (args as { manifestJson: string }).manifestJson,
    ) as BackupManifest;
    expect(packedManifest.chapters[0]?.isDownloaded).toBe(true);
    expect(packedManifest.chapters[0]?.content).toBeNull();
    expect(packedManifest.chapters[0]?.contentBytes).toBe(17);
    expect(packedManifest.chapters[1]?.isDownloaded).toBe(false);
    expect(packedManifest.novels).toEqual(manifest.novels);
  });

  it("does not mutate the caller's manifest", async () => {
    const manifest = makeManifest();
    const before = JSON.parse(JSON.stringify(manifest));

    await packBackup(manifest, "C:\\backup.zip");

    expect(manifest).toEqual(before);
  });

  it("invokes backup_pack_temp_file with the manifest only", async () => {
    const manifest = makeManifest();
    invokeMock.mockResolvedValue("C:\\temp\\norea-backup.zip");

    await expect(packBackupTempFile(manifest)).resolves.toBe(
      "C:\\temp\\norea-backup.zip",
    );

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("backup_pack_temp_file", {
      manifestJson: encodeBackupManifest(manifest),
    });
  });

  it("deletes backup temp files through the Rust command", async () => {
    await deleteBackupTempFile("C:\\temp\\norea-backup.zip");

    expect(invokeMock).toHaveBeenCalledWith("backup_delete_temp_file", {
      path: "C:\\temp\\norea-backup.zip",
    });
  });
});
