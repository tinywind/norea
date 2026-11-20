import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("./pack", () => ({
  packBackup: vi.fn(),
}));

vi.mock("./snapshot", () => ({
  applyBackupSnapshot: vi.fn(),
  gatherBackupSnapshot: vi.fn(),
}));

vi.mock("./unpack", () => ({
  unpackBackup: vi.fn(),
}));

import { open, save } from "@tauri-apps/plugin-dialog";
import {
  BACKUP_FORMAT_VERSION,
  type BackupManifest,
} from "./format";
import {
  defaultBackupFilename,
  exportBackupToFile,
  importBackupFromFile,
} from "./io";
import { packBackup } from "./pack";
import {
  applyBackupSnapshot,
  gatherBackupSnapshot,
} from "./snapshot";
import { unpackBackup } from "./unpack";

const openMock = vi.mocked(open);
const saveMock = vi.mocked(save);
const packBackupMock = vi.mocked(packBackup);
const applyBackupSnapshotMock = vi.mocked(applyBackupSnapshot);
const gatherBackupSnapshotMock = vi.mocked(gatherBackupSnapshot);
const unpackBackupMock = vi.mocked(unpackBackup);

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
        foundByCheck: false,
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
        foundByCheck: false,
        updatedAt: 1_700_000_000,
      },
    ],
    categories: [],
    novelCategories: [],
    repositories: [],
    vpnGateServerVerdicts: [],
    downloadGoals: [],
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
        repositoryUrl: null,
      },
    ],
    settings: [{ key: "reader-settings", value: "{\"state\":{}}" }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  packBackupMock.mockResolvedValue(undefined);
  applyBackupSnapshotMock.mockResolvedValue(undefined);
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
  it.each([
    "C:\\backup.zip",
    "content://com.android.externalstorage.documents/document/backup.zip",
  ])("exports a gathered snapshot directly through Rust to %s", async (destination) => {
    const manifest = makeManifest();
    saveMock.mockResolvedValue(destination);
    gatherBackupSnapshotMock.mockResolvedValue(manifest);

    const path = await exportBackupToFile();

    expect(path).toBe(destination);
    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: expect.stringMatching(
        /^norea-backup-\d{14}\.zip$/,
      ),
      filters: [{ name: "Norea Backup", extensions: ["zip"] }],
    });
    expect(gatherBackupSnapshotMock).toHaveBeenCalledTimes(1);
    expect(packBackupMock).toHaveBeenCalledWith(manifest, destination);
  });

  it("skips export work when the save dialog is cancelled", async () => {
    saveMock.mockResolvedValue(null);

    const path = await exportBackupToFile();

    expect(path).toBeNull();
    expect(gatherBackupSnapshotMock).not.toHaveBeenCalled();
    expect(packBackupMock).not.toHaveBeenCalled();
  });

  it.each([
    "C:\\backup.zip",
    "content://com.android.externalstorage.documents/document/backup.zip",
  ])("imports the selected backup directly through Rust from %s", async (source) => {
    const manifest = makeManifest();
    openMock.mockResolvedValue(source);
    unpackBackupMock.mockResolvedValue(manifest);

    const path = await importBackupFromFile();

    expect(path).toBe(source);
    expect(openMock).toHaveBeenCalledWith({
      multiple: false,
      filters: [{ name: "Norea Backup", extensions: ["zip"] }],
    });
    expect(unpackBackupMock).toHaveBeenCalledWith(source);
    expect(applyBackupSnapshotMock).toHaveBeenCalledWith(manifest);
  });

  it("propagates unpack failures before applying a backup", async () => {
    const uri = "content://com.android.externalstorage.documents/document/backup.zip";
    const failure = new Error("bad backup");
    openMock.mockResolvedValue(uri);
    unpackBackupMock.mockRejectedValue(failure);

    await expect(importBackupFromFile()).rejects.toThrow(failure);

    expect(applyBackupSnapshotMock).not.toHaveBeenCalled();
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
