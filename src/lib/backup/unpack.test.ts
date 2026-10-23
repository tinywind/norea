import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  BACKUP_FORMAT_VERSION,
  BackupFormatError,
  encodeBackupManifest,
  type BackupManifest,
} from "./format";
import {
  unpackBackup,
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
        sourceNovelId: "1",
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
        sourceContentType: "html",
        content: null,
        contentBytes: 0,
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
        sourceContentType: "html",
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
    installedPlugins: [],
    settings: [],
    vpnGateServerVerdicts: [],
  };
}

describe("unpackBackup", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("reads the current manifest without chapter content", async () => {
    const manifest = makeLeanManifest();
    invokeMock.mockResolvedValue({ manifest_json: encodeBackupManifest(manifest) });

    const restored = await unpackBackup("C:\\backup.zip");

    expect(invokeMock).toHaveBeenCalledWith("backup_unpack", {
      inputPath: "C:\\backup.zip",
    });
    expect(restored).toEqual(manifest);
  });

  it("propagates native command failures without retrying an old command", async () => {
    const error = new Error("unknown command: backup_unpack");
    invokeMock.mockRejectedValueOnce(error);

    await expect(unpackBackup("C:\\backup.zip")).rejects.toThrow(error);
    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it("propagates BackupFormatError on a malformed envelope", async () => {
    invokeMock.mockResolvedValue({
      manifest_json: "{ not valid json",
    });

    await expect(unpackBackup("C:\\bad.zip")).rejects.toBeInstanceOf(
      BackupFormatError,
    );
  });
});
