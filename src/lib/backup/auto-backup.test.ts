import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  BackupFolderUnavailableError: class BackupFolderUnavailableError extends Error {},
  android: false,
  invoke: vi.fn(),
  publishAndroid: vi.fn(),
  packTemp: vi.fn(async () => "/cache/backup/temp.zip"),
  deleteTemp: vi.fn(async () => undefined),
  run: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../tauri-runtime", () => ({ isAndroidRuntime: () => mocks.android }));
vi.mock("../android-storage", () => ({
  BackupFolderUnavailableError: mocks.BackupFolderUnavailableError,
  publishAndroidAutoBackup: mocks.publishAndroid,
}));
vi.mock("./pack", () => ({ packBackupTempFile: mocks.packTemp, deleteBackupTempFile: mocks.deleteTemp }));
vi.mock("./snapshot", () => ({ gatherBackupSnapshot: vi.fn(async () => ({ version: 5 })) }));
vi.mock("./format", () => ({ encodeBackupManifest: () => '{"version":5}' }));
vi.mock("../tasks/main-tasks", () => ({
  enqueueMainTask: vi.fn((spec: { run: () => Promise<unknown> }) => ({ promise: mocks.run(spec) })),
}));

import { useAutoBackupStore } from "../../store/auto-backup";
import { enqueueMainTask } from "../tasks/main-tasks";
import { isAutomaticBackupDue, runAutomaticBackupIfDue, writeAutomaticBackup } from "./auto-backup";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 4, 12);

describe("isAutomaticBackupDue", () => {
  const due = (patch: Partial<Parameters<typeof isAutomaticBackupDue>[0]>, now = NOW) =>
    isAutomaticBackupDue({ schedule: "weekly", lastSuccessAt: null, lastFailureAt: null, ...patch }, now);

  it("runs at once without a previous backup and never when off", () => {
    expect(due({})).toBe(true);
    expect(due({ schedule: "off" })).toBe(false);
  });

  it("waits a day or a week after the last backup, and runs a missed one late", () => {
    expect(due({ schedule: "daily", lastSuccessAt: NOW - DAY + 1 })).toBe(false);
    expect(due({ schedule: "daily", lastSuccessAt: NOW - DAY })).toBe(true);
    expect(due({ lastSuccessAt: NOW - 6 * DAY })).toBe(false);
    expect(due({ lastSuccessAt: NOW - 30 * DAY })).toBe(true);
  });

  it("waits an hour after a failed attempt before trying again", () => {
    expect(due({ lastFailureAt: NOW - HOUR + 1 })).toBe(false);
    expect(due({ lastFailureAt: NOW - HOUR })).toBe(true);
  });
});

describe("writeAutomaticBackup", () => {
  beforeEach(() => vi.clearAllMocks());

  it("publishes into the desktop storage folder with a timestamped name", async () => {
    mocks.android = false;
    const fileName = await writeAutomaticBackup(5, new Date(2026, 10, 4, 9, 8, 7));

    expect(fileName).toBe("norea-auto-backup-20261104090807.zip");
    expect(mocks.invoke).toHaveBeenCalledWith("backup_publish_auto", {
      manifestJson: '{"version":5}', fileName, keep: 5,
    });
  });

  it("reports a desktop storage folder it cannot reach as unavailable", async () => {
    mocks.android = false;
    mocks.invoke.mockRejectedValueOnce("backup_publish_auto: storage folder unavailable: create D:\\Norea\\backups: not found");
    await expect(writeAutomaticBackup(5)).rejects.toBeInstanceOf(mocks.BackupFolderUnavailableError);

    mocks.invoke.mockRejectedValueOnce("backup_publish_auto: sync: disk error");
    const failure = await writeAutomaticBackup(5).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(mocks.BackupFolderUnavailableError);
  });

  it("copies the packed archive through the Android storage bridge and removes the temp file", async () => {
    mocks.android = true;
    mocks.publishAndroid.mockRejectedValueOnce(new Error("Storage folder is not writable."));

    await expect(writeAutomaticBackup(3, new Date(2026, 10, 4, 9, 8, 7))).rejects.toThrow("not writable");

    expect(mocks.publishAndroid).toHaveBeenCalledWith("/cache/backup/temp.zip", "norea-auto-backup-20261104090807.zip", 3);
    expect(mocks.deleteTemp).toHaveBeenCalledWith("/cache/backup/temp.zip");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("runAutomaticBackupIfDue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAutoBackupStore.setState({
      schedule: "weekly", keep: 5, lastSuccessAt: null, lastFileName: null, lastFailureAt: null, lastError: null,
      lastFailureFolderUnavailable: false,
    });
  });

  it("marks a failure that could not reach the folder, and a later success or clear forgets it", async () => {
    mocks.run.mockRejectedValueOnce(new mocks.BackupFolderUnavailableError("Automatic backup folder unavailable"));
    await runAutomaticBackupIfDue(NOW);
    expect(useAutoBackupStore.getState()).toMatchObject({ lastFailureFolderUnavailable: true });

    useAutoBackupStore.getState().clearFailure();
    expect(useAutoBackupStore.getState()).toMatchObject({
      lastFailureAt: null, lastError: null, lastFailureFolderUnavailable: false,
    });
    expect(isAutomaticBackupDue(useAutoBackupStore.getState(), NOW)).toBe(true);
  });

  it("records the published file and clears an earlier failure", async () => {
    useAutoBackupStore.setState({ lastFailureAt: NOW - 2 * HOUR, lastError: "old" });
    mocks.run.mockResolvedValueOnce("norea-auto-backup-20261104120000.zip");

    await runAutomaticBackupIfDue(NOW);

    expect(enqueueMainTask).toHaveBeenCalledWith(expect.objectContaining({ kind: "backup.auto", priority: "background" }));
    expect(useAutoBackupStore.getState()).toMatchObject({
      lastFileName: "norea-auto-backup-20261104120000.zip", lastFailureAt: null, lastError: null,
    });
    expect(useAutoBackupStore.getState().lastSuccessAt).not.toBeNull();
  });

  it("records a failure with its reason and keeps the last success", async () => {
    useAutoBackupStore.setState({ lastSuccessAt: NOW - 8 * DAY, lastFileName: "previous.zip" });
    mocks.run.mockRejectedValueOnce(new Error("Android storage folder is not writable."));

    await runAutomaticBackupIfDue(NOW);

    expect(useAutoBackupStore.getState()).toMatchObject({
      lastSuccessAt: NOW - 8 * DAY, lastFileName: "previous.zip",
      lastError: "Android storage folder is not writable.",
      lastFailureFolderUnavailable: false,
    });
  });

  it("starts nothing when the backup is not due and shares a running one", async () => {
    useAutoBackupStore.setState({ lastSuccessAt: NOW - DAY });
    await runAutomaticBackupIfDue(NOW);
    expect(enqueueMainTask).not.toHaveBeenCalled();

    useAutoBackupStore.setState({ lastSuccessAt: null });
    let finish!: (name: string) => void;
    mocks.run.mockReturnValueOnce(new Promise<string>((resolve) => { finish = resolve; }));
    const first = runAutomaticBackupIfDue(NOW);
    const second = runAutomaticBackupIfDue(NOW);
    finish("norea-auto-backup-20261104120000.zip");
    await Promise.all([first, second]);
    expect(enqueueMainTask).toHaveBeenCalledTimes(1);
  });
});
