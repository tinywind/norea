import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

vi.mock("./android-storage", () => ({
  copyAndroidContentUriToTempFile: vi.fn(),
  deleteAndroidContentUriTempFile: vi.fn(),
  describeAndroidContentUri: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  copyAndroidContentUriToTempFile,
  deleteAndroidContentUriTempFile,
  describeAndroidContentUri,
} from "./android-storage";
import {
  startAndroidFileOpenListener,
  takePendingAndroidOpenFiles,
} from "./android-file-open";
import { LOCAL_IMPORT_LIMITS } from "./local-import";

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
const copyContentUriMock = vi.mocked(copyAndroidContentUriToTempFile);
const deleteContentUriTempFileMock = vi.mocked(
  deleteAndroidContentUriTempFile,
);
const describeContentUriMock = vi.mocked(describeAndroidContentUri);

const CONTENT_URI = "content://documents/Book.epub";

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  copyContentUriMock.mockReset();
  deleteContentUriTempFileMock.mockReset();
  describeContentUriMock.mockReset();
});

describe("Android file open bridge", () => {
  it("copies a pending content URI through a bounded temp file", async () => {
    describeContentUriMock.mockResolvedValue({
      fileName: "Book.epub",
      mimeType: "application/epub+zip",
      size: 4,
    });
    copyContentUriMock.mockResolvedValue({
      bytes: 4,
      mimeType: "application/epub+zip",
      path: "/data/user/0/norea/cache/android-storage-bridge/content.tmp",
    });
    invokeMock.mockImplementation(async (command) => {
      if (command === "android_open_file_url_take") return [CONTENT_URI];
      if (command === "android_open_file_temp_read") {
        return new Uint8Array([1, 2, 3, 4]).buffer;
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const files = await takePendingAndroidOpenFiles();

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      name: "Book.epub",
      size: 4,
      type: "application/epub+zip",
    });
    expect(copyContentUriMock).toHaveBeenCalledWith(
      CONTENT_URI,
      LOCAL_IMPORT_LIMITS.fileBytes,
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "android_open_file_temp_read",
      {
        path: "/data/user/0/norea/cache/android-storage-bridge/content.tmp",
      },
    );
    expect(deleteContentUriTempFileMock).toHaveBeenCalledOnce();
  });

  it("does not copy content that already exceeds the import limit", async () => {
    describeContentUriMock.mockResolvedValue({
      fileName: "Huge.pdf",
      mimeType: "application/pdf",
      size: LOCAL_IMPORT_LIMITS.pdfBytes + 1,
    });
    invokeMock.mockResolvedValue([CONTENT_URI]);

    const files = await takePendingAndroidOpenFiles();

    expect(files[0]).toMatchObject({
      name: "Huge.pdf",
      size: LOCAL_IMPORT_LIMITS.pdfBytes + 1,
      type: "application/pdf",
    });
    expect(copyContentUriMock).not.toHaveBeenCalled();
  });

  it("keeps readable content when temp-file cleanup fails", async () => {
    const cleanupError = new Error("Temp-file cleanup failed.");
    describeContentUriMock.mockResolvedValue({
      fileName: "Book.pdf",
      mimeType: "application/pdf",
      size: 4,
    });
    copyContentUriMock.mockResolvedValue({
      bytes: 4,
      mimeType: "application/pdf",
      path: "/data/user/0/norea/cache/android-storage-bridge/content.tmp",
    });
    deleteContentUriTempFileMock.mockRejectedValue(cleanupError);
    invokeMock.mockImplementation(async (command) => {
      if (command === "android_open_file_url_take") return [CONTENT_URI];
      if (command === "android_open_file_temp_read") {
        return new Uint8Array([1, 2, 3, 4]).buffer;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const onError = vi.fn();

    const files = await takePendingAndroidOpenFiles(onError);

    expect(files[0]).toMatchObject({
      name: "Book.pdf",
      size: 4,
      type: "application/pdf",
    });
    await expect(files[0].arrayBuffer()).resolves.toBeInstanceOf(ArrayBuffer);
    expect(onError).toHaveBeenCalledWith(cleanupError);
  });

  it("preserves descriptor failures as reviewable file errors", async () => {
    const error = new Error("Content provider denied metadata access.");
    describeContentUriMock.mockRejectedValue(error);
    invokeMock.mockResolvedValue([CONTENT_URI]);
    const onError = vi.fn();

    const files = await takePendingAndroidOpenFiles(onError);

    expect(files[0].name).toBe("Book.epub");
    await expect(files[0].arrayBuffer()).rejects.toThrow(error.message);
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("drains content URIs received while the app is running", async () => {
    let emitOpenEvent: (() => void) | undefined;
    let warmOpen = false;
    listenMock.mockImplementation(async (_event, handler) => {
      emitOpenEvent = () =>
        handler({
          event: "android-open-files",
          id: 1,
          payload: null,
        } as never);
      return () => undefined;
    });
    describeContentUriMock.mockResolvedValue({
      fileName: "Book.txt",
      mimeType: "text/plain",
      size: 4,
    });
    copyContentUriMock.mockResolvedValue({
      bytes: 4,
      mimeType: "text/plain",
      path: "/data/user/0/norea/cache/android-storage-bridge/content.tmp",
    });
    invokeMock.mockImplementation(async (command) => {
      if (command === "android_open_file_url_take") {
        return warmOpen ? [CONTENT_URI] : [];
      }
      if (command === "android_open_file_temp_read") {
        return new TextEncoder().encode("text").buffer;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const onFiles = vi.fn();

    await startAndroidFileOpenListener({ onFiles });
    warmOpen = true;
    emitOpenEvent?.();

    await vi.waitFor(() => {
      expect(onFiles).toHaveBeenCalledOnce();
    });
    expect(onFiles.mock.calls[0][0][0]).toMatchObject({
      name: "Book.txt",
      size: 4,
    });
  });
});
