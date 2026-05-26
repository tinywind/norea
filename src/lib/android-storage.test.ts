import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  clearAndroidStorageRoot,
  copyAndroidContentUriToTempFile,
  deleteAndroidContentUriTempFile,
  prepareAndroidReaderMediaCache,
  readAndroidStorageText,
  selectAndroidStorageRoot,
  writeAndroidContentUriFile,
} from "./android-storage";

type TestBridge = {
  deleteRootChildren?: ReturnType<typeof vi.fn>;
  deletePath?: ReturnType<typeof vi.fn>;
  deleteTempFile?: ReturnType<typeof vi.fn>;
  pickMediaStorageRoot?: ReturnType<typeof vi.fn>;
  prepareReaderMediaCache?: ReturnType<typeof vi.fn>;
  readContentUriFile?: ReturnType<typeof vi.fn>;
  readText?: ReturnType<typeof vi.fn>;
  writeBytes?: ReturnType<typeof vi.fn>;
  writeContentUriFile?: ReturnType<typeof vi.fn>;
  writeContentUriFileCapped?: ReturnType<typeof vi.fn>;
};

const invokeMock = vi.mocked(invoke);

function installBridge(bridge: TestBridge): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __NoreaAndroidStorage: bridge,
    },
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  installBridge({});
});

describe("android storage bridge facade", () => {
  it("prefers capped file writes when the Android bridge exposes them", async () => {
    const legacyWrite = vi.fn(() => JSON.stringify({ ok: true }));
    const cappedWrite = vi.fn(() =>
      JSON.stringify({ bytes: 12, ok: true }),
    );
    installBridge({
      writeContentUriFile: legacyWrite,
      writeContentUriFileCapped: cappedWrite,
    });

    await writeAndroidContentUriFile(
      "content://backup",
      "/data/user/0/io.github.tinywind.norea/cache/backup/export.zip",
      "application/zip",
      4096,
    );

    expect(cappedWrite).toHaveBeenCalledWith(
      "content://backup",
      "/data/user/0/io.github.tinywind.norea/cache/backup/export.zip",
      "application/zip",
      "4096",
    );
    expect(legacyWrite).not.toHaveBeenCalled();
  });

  it("falls back to legacy content URI file writes", async () => {
    const legacyWrite = vi.fn(() =>
      JSON.stringify({ bytes: 12, ok: true }),
    );
    installBridge({
      writeContentUriFile: legacyWrite,
    });

    await writeAndroidContentUriFile(
      "content://backup",
      "/cache/export.zip",
      "application/zip",
    );

    expect(legacyWrite).toHaveBeenCalledWith(
      "content://backup",
      "/cache/export.zip",
      "application/zip",
    );
  });

  it("copies content URIs into Android temp files when supported", async () => {
    const readContentUriFile = vi.fn(() =>
      JSON.stringify({
        bytes: 3,
        mimeType: "application/zip",
        ok: true,
        path: "/data/user/0/io.github.tinywind.norea/cache/android-storage-bridge/content.tmp",
      }),
    );
    installBridge({ readContentUriFile });

    await expect(
      copyAndroidContentUriToTempFile("content://backup", 8192),
    ).resolves.toEqual({
      bytes: 3,
      mimeType: "application/zip",
      path: "/data/user/0/io.github.tinywind.norea/cache/android-storage-bridge/content.tmp",
    });
    expect(readContentUriFile).toHaveBeenCalledWith("content://backup", "8192");
  });

  it("returns null for temp file reads when the bridge lacks the method", async () => {
    installBridge({});

    await expect(
      copyAndroidContentUriToTempFile("content://backup"),
    ).resolves.toBeNull();
  });

  it("deletes Android temp files when the bridge exposes cleanup", async () => {
    const deleteTempFile = vi.fn(() => JSON.stringify({ ok: true }));
    installBridge({ deleteTempFile });

    await deleteAndroidContentUriTempFile("/cache/android-storage-bridge/a.tmp");

    expect(deleteTempFile).toHaveBeenCalledWith(
      "/cache/android-storage-bridge/a.tmp",
    );
  });

  it("does not create .nomedia while reading from the selected storage root", async () => {
    const root = "content://tree/primary%3ANorea";
    const readText = vi.fn(() =>
      JSON.stringify({ ok: true, text: "<html></html>" }),
    );
    const writeBytes = vi.fn(() => JSON.stringify({ ok: true }));
    invokeMock.mockResolvedValue(root);
    installBridge({ readText, writeBytes });

    await expect(
      readAndroidStorageText("contents/demo/chapter/content.html"),
    ).resolves.toBe("<html></html>");

    expect(invokeMock).toHaveBeenCalledWith("chapter_media_get_storage_root");
    expect(readText).toHaveBeenCalledWith(
      root,
      "contents/demo/chapter/content.html",
    );
    expect(writeBytes).not.toHaveBeenCalled();
  });

  it("does not create .nomedia after selecting a storage root", async () => {
    const root = "content://tree/primary%3ANoreaSelect";
    const deletePath = vi.fn(() => JSON.stringify({ ok: true }));
    const pickMediaStorageRoot = vi.fn((requestId: string) => {
      window.__lnrResolveAndroidStoragePick?.(requestId, { ok: true, root });
    });
    const writeBytes = vi.fn(() => JSON.stringify({ ok: true }));
    invokeMock.mockResolvedValue(root);
    installBridge({ deletePath, pickMediaStorageRoot, writeBytes });

    await expect(selectAndroidStorageRoot()).resolves.toBe(root);

    expect(pickMediaStorageRoot).toHaveBeenCalledWith(expect.any(String));
    expect(invokeMock).toHaveBeenCalledWith("chapter_media_set_storage_root", {
      root,
    });
    expect(writeBytes).not.toHaveBeenCalled();
  });

  it("cleans up legacy .nomedia after selecting a storage root", async () => {
    const root = "content://tree/primary%3ANoreaSelectCleanup";
    const deletePath = vi.fn(() => JSON.stringify({ ok: true }));
    const pickMediaStorageRoot = vi.fn((requestId: string) => {
      window.__lnrResolveAndroidStoragePick?.(requestId, { ok: true, root });
    });
    const writeBytes = vi.fn(() => JSON.stringify({ ok: true }));
    invokeMock.mockResolvedValue(root);
    installBridge({ deletePath, pickMediaStorageRoot, writeBytes });

    await expect(selectAndroidStorageRoot()).resolves.toBe(root);

    expect(deletePath).toHaveBeenCalledWith(root, "contents/.nomedia");
    expect(writeBytes).not.toHaveBeenCalled();
  });

  it("does not recreate .nomedia after clearing the storage root", async () => {
    const root = "content://tree/primary%3ANorea";
    const deleteRootChildren = vi.fn(() => JSON.stringify({ ok: true }));
    const writeBytes = vi.fn(() => JSON.stringify({ ok: true }));
    invokeMock.mockResolvedValue(root);
    installBridge({ deleteRootChildren, writeBytes });

    await clearAndroidStorageRoot();

    expect(deleteRootChildren).toHaveBeenCalledWith(root);
    expect(writeBytes).not.toHaveBeenCalled();
  });

  it("cleans up legacy .nomedia before preparing reader media cache", async () => {
    const root = "content://tree/primary%3ANoreaPrepare";
    const deletePath = vi.fn(() => JSON.stringify({ ok: true }));
    const prepareReaderMediaCache = vi.fn(() =>
      JSON.stringify({ bytes: 12, ok: true }),
    );
    invokeMock.mockResolvedValue(root);
    installBridge({ deletePath, prepareReaderMediaCache });

    await prepareAndroidReaderMediaCache("contents/demo/chapter/media.zip");

    expect(deletePath).toHaveBeenCalledWith(root, "contents/.nomedia");
    expect(prepareReaderMediaCache).toHaveBeenCalledWith(
      root,
      "contents/demo/chapter/media.zip",
    );
  });

  it("keeps preparing reader media when legacy .nomedia cleanup fails", async () => {
    const root = "content://tree/primary%3ANoreaPrepareAfterCleanupFailure";
    const deletePath = vi.fn(() =>
      JSON.stringify({ error: "not found", ok: false }),
    );
    const prepareReaderMediaCache = vi.fn(() =>
      JSON.stringify({ bytes: 12, ok: true }),
    );
    invokeMock.mockResolvedValue(root);
    installBridge({ deletePath, prepareReaderMediaCache });

    await prepareAndroidReaderMediaCache("contents/demo/chapter/media.zip");

    expect(prepareReaderMediaCache).toHaveBeenCalledWith(
      root,
      "contents/demo/chapter/media.zip",
    );
  });
});
