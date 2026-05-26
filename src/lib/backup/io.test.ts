import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("./pack", () => ({
  deleteBackupTempFile: vi.fn(),
  packBackup: vi.fn(),
  packBackupTempFile: vi.fn(),
}));

vi.mock("../android-storage", () => ({
  copyAndroidContentUriToTempFile: vi.fn(),
  deleteAndroidContentUriTempFile: vi.fn(),
  readAndroidContentUriBytes: vi.fn(),
  writeAndroidContentUriFile: vi.fn(),
}));

vi.mock("../tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(() => false),
}));

vi.mock("./snapshot", () => ({
  applyBackupSnapshot: vi.fn(),
  gatherBackupSnapshot: vi.fn(),
}));

vi.mock("./unpack", () => ({
  unpackBackup: vi.fn(),
  unpackBackupBytes: vi.fn(),
}));

import { open, save } from "@tauri-apps/plugin-dialog";
import {
  copyAndroidContentUriToTempFile,
  deleteAndroidContentUriTempFile,
  readAndroidContentUriBytes,
  writeAndroidContentUriFile,
} from "../android-storage";
import { MAX_BACKUP_ARCHIVE_BYTES } from "../performance-budgets";
import { isAndroidRuntime } from "../tauri-runtime";
import {
  BACKUP_FORMAT_VERSION,
  type BackupManifest,
} from "./format";
import {
  defaultBackupFilename,
  exportBackupToFile,
  importBackupFromFile,
} from "./io";
import { deleteBackupTempFile, packBackup, packBackupTempFile } from "./pack";
import {
  applyBackupSnapshot,
  gatherBackupSnapshot,
} from "./snapshot";
import { unpackBackup, unpackBackupBytes } from "./unpack";

const openMock = vi.mocked(open);
const saveMock = vi.mocked(save);
const isAndroidRuntimeMock = vi.mocked(isAndroidRuntime);
const deleteBackupTempFileMock = vi.mocked(deleteBackupTempFile);
const packBackupMock = vi.mocked(packBackup);
const packBackupTempFileMock = vi.mocked(packBackupTempFile);
const applyBackupSnapshotMock = vi.mocked(applyBackupSnapshot);
const gatherBackupSnapshotMock = vi.mocked(gatherBackupSnapshot);
const copyAndroidContentUriToTempFileMock = vi.mocked(
  copyAndroidContentUriToTempFile,
);
const deleteAndroidContentUriTempFileMock = vi.mocked(
  deleteAndroidContentUriTempFile,
);
const readAndroidContentUriBytesMock = vi.mocked(readAndroidContentUriBytes);
const unpackBackupMock = vi.mocked(unpackBackup);
const unpackBackupBytesMock = vi.mocked(unpackBackupBytes);
const writeAndroidContentUriFileMock = vi.mocked(writeAndroidContentUriFile);

function makeManifest(): BackupManifest {
  return {
    version: BACKUP_FORMAT_VERSION,
    exportedAt: 1_700_000_000,
    novels: [],
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
        isDownloaded: false,
        contentType: "html",
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
        name: "Downloaded Chapter",
        chapterNumber: "2",
        position: 2,
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
    ],
    categories: [],
    novelCategories: [],
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

beforeEach(() => {
  vi.clearAllMocks();
  isAndroidRuntimeMock.mockReturnValue(false);
  deleteBackupTempFileMock.mockResolvedValue(undefined);
  packBackupMock.mockResolvedValue(undefined);
  packBackupTempFileMock.mockResolvedValue("C:\\temp\\norea-backup.zip");
  applyBackupSnapshotMock.mockResolvedValue(undefined);
  copyAndroidContentUriToTempFileMock.mockResolvedValue(null);
  deleteAndroidContentUriTempFileMock.mockResolvedValue(undefined);
  readAndroidContentUriBytesMock.mockResolvedValue([4, 5, 6]);
});

describe("defaultBackupFilename", () => {
  it("uses the local yyyyMMddHHmmss timestamp as a filename suffix", () => {
    const fixed = new Date(2026, 4, 5, 3, 14, 15);
    expect(defaultBackupFilename(fixed)).toBe(
      "norea-backup-20260505031415.zip",
    );
  });
});

describe("backup import/export flow", () => {
  it("exports a gathered snapshot to the selected zip path", async () => {
    const manifest = makeManifest();
    saveMock.mockResolvedValue("C:\\backup.zip");
    gatherBackupSnapshotMock.mockResolvedValue(manifest);

    const path = await exportBackupToFile();

    expect(path).toBe("C:\\backup.zip");
    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: expect.stringMatching(
        /^norea-backup-\d{14}\.zip$/,
      ),
      filters: [{ name: "Norea Backup", extensions: ["zip"] }],
    });
    expect(gatherBackupSnapshotMock).toHaveBeenCalledTimes(1);
    expect(packBackupMock).toHaveBeenCalledWith(manifest, "C:\\backup.zip");
  });

  it("exports Android content URI backups through a temp file stream", async () => {
    const manifest = makeManifest();
    const uri = "content://com.android.externalstorage.documents/document/backup.zip";
    isAndroidRuntimeMock.mockReturnValue(true);
    saveMock.mockResolvedValue(uri);
    gatherBackupSnapshotMock.mockResolvedValue(manifest);

    const path = await exportBackupToFile();

    expect(path).toBe(uri);
    expect(packBackupTempFileMock).toHaveBeenCalledWith(manifest);
    expect(writeAndroidContentUriFileMock).toHaveBeenCalledWith(
      uri,
      "C:\\temp\\norea-backup.zip",
      "application/zip",
    );
    expect(deleteBackupTempFileMock).toHaveBeenCalledWith(
      "C:\\temp\\norea-backup.zip",
    );
    expect(packBackupMock).not.toHaveBeenCalled();
  });

  it("skips export work when the save dialog is cancelled", async () => {
    saveMock.mockResolvedValue(null);

    const path = await exportBackupToFile();

    expect(path).toBeNull();
    expect(gatherBackupSnapshotMock).not.toHaveBeenCalled();
    expect(packBackupMock).not.toHaveBeenCalled();
  });

  it("imports the selected zip path into the backup snapshot", async () => {
    const manifest = makeManifest();
    openMock.mockResolvedValue("C:\\backup.zip");
    unpackBackupMock.mockResolvedValue(manifest);

    const path = await importBackupFromFile();

    expect(path).toBe("C:\\backup.zip");
    expect(openMock).toHaveBeenCalledWith({
      multiple: false,
      filters: [{ name: "Norea Backup", extensions: ["zip"] }],
    });
    expect(unpackBackupMock).toHaveBeenCalledWith("C:\\backup.zip");
    expect(applyBackupSnapshotMock).toHaveBeenCalledWith(manifest);
  });

  it("imports Android content URI backups through the temp file bridge", async () => {
    const manifest = makeManifest();
    const uri = "content://com.android.externalstorage.documents/document/backup.zip";
    const tempFile = {
      bytes: 3,
      mimeType: "application/zip",
      path: "/data/user/0/io.github.tinywind.norea/cache/android-storage-bridge/backup.tmp",
    };
    isAndroidRuntimeMock.mockReturnValue(true);
    openMock.mockResolvedValue(uri);
    copyAndroidContentUriToTempFileMock.mockResolvedValue(tempFile);
    unpackBackupMock.mockResolvedValue(manifest);

    const path = await importBackupFromFile();

    expect(path).toBe(uri);
    expect(copyAndroidContentUriToTempFileMock).toHaveBeenCalledWith(
      uri,
      MAX_BACKUP_ARCHIVE_BYTES,
    );
    expect(unpackBackupMock).toHaveBeenCalledWith(tempFile.path);
    expect(deleteAndroidContentUriTempFileMock).toHaveBeenCalledWith(tempFile);
    expect(readAndroidContentUriBytesMock).not.toHaveBeenCalled();
    expect(unpackBackupBytesMock).not.toHaveBeenCalled();
    expect(applyBackupSnapshotMock).toHaveBeenCalledWith(manifest);
  });

  it("cleans up Android temp file imports when unpack fails", async () => {
    const uri = "content://com.android.externalstorage.documents/document/backup.zip";
    const tempFile = {
      bytes: 3,
      mimeType: "application/zip",
      path: "/data/user/0/io.github.tinywind.norea/cache/android-storage-bridge/backup.tmp",
    };
    const failure = new Error("bad backup");
    isAndroidRuntimeMock.mockReturnValue(true);
    openMock.mockResolvedValue(uri);
    copyAndroidContentUriToTempFileMock.mockResolvedValue(tempFile);
    unpackBackupMock.mockRejectedValue(failure);

    await expect(importBackupFromFile()).rejects.toThrow(failure);

    expect(deleteAndroidContentUriTempFileMock).toHaveBeenCalledWith(tempFile);
    expect(readAndroidContentUriBytesMock).not.toHaveBeenCalled();
    expect(unpackBackupBytesMock).not.toHaveBeenCalled();
    expect(applyBackupSnapshotMock).not.toHaveBeenCalled();
  });

  it("falls back to base64 Android content URI imports when temp files are unavailable", async () => {
    const manifest = makeManifest();
    const uri = "content://com.android.externalstorage.documents/document/backup.zip";
    isAndroidRuntimeMock.mockReturnValue(true);
    openMock.mockResolvedValue(uri);
    copyAndroidContentUriToTempFileMock.mockResolvedValue(null);
    unpackBackupBytesMock.mockResolvedValue(manifest);

    const path = await importBackupFromFile();

    expect(path).toBe(uri);
    expect(copyAndroidContentUriToTempFileMock).toHaveBeenCalledWith(
      uri,
      MAX_BACKUP_ARCHIVE_BYTES,
    );
    expect(readAndroidContentUriBytesMock).toHaveBeenCalledWith(uri);
    expect(unpackBackupBytesMock).toHaveBeenCalledWith([4, 5, 6]);
    expect(deleteAndroidContentUriTempFileMock).not.toHaveBeenCalled();
    expect(unpackBackupMock).not.toHaveBeenCalled();
    expect(applyBackupSnapshotMock).toHaveBeenCalledWith(manifest);
  });

  it("skips import work when the open dialog is cancelled", async () => {
    openMock.mockResolvedValue(null);

    const path = await importBackupFromFile();

    expect(path).toBeNull();
    expect(unpackBackupMock).not.toHaveBeenCalled();
    expect(applyBackupSnapshotMock).not.toHaveBeenCalled();
  });

  it("skips import work when an unexpected array result narrows out", async () => {
    openMock.mockResolvedValue([
      "C:\\unexpected1.zip",
      "C:\\unexpected2.zip",
    ] as never);

    const path = await importBackupFromFile();

    expect(path).toBeNull();
    expect(unpackBackupMock).not.toHaveBeenCalled();
    expect(applyBackupSnapshotMock).not.toHaveBeenCalled();
  });
});
