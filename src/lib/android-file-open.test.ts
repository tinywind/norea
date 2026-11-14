import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  startAndroidFileOpenListener,
  takePendingAndroidOpenFiles,
} from "./android-file-open";
import { LOCAL_IMPORT_LIMITS } from "./local-import";

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

const CONTENT_URI = "content://documents/Book.epub";

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
});

describe("Android file open bridge", () => {
  it("reads a pending content URI through bounded Rust file commands", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "android_open_file_url_take") return [CONTENT_URI];
      if (command === "local_file_describe") {
        return {
          fileName: "Book.epub",
          mimeType: "application/epub+zip",
          size: 4,
        };
      }
      if (command === "local_file_read") {
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
    expect(invokeMock).toHaveBeenCalledWith("local_file_describe", {
      pathOrUri: CONTENT_URI,
    });
    expect(invokeMock).toHaveBeenCalledWith("local_file_read", {
      maxBytes: LOCAL_IMPORT_LIMITS.fileBytes,
      pathOrUri: CONTENT_URI,
    });
  });

  it("does not read content that already exceeds the import limit", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "android_open_file_url_take") return [CONTENT_URI];
      if (command === "local_file_describe") {
        return {
          fileName: "Huge.pdf",
          mimeType: "application/pdf",
          size: LOCAL_IMPORT_LIMITS.pdfBytes + 1,
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const files = await takePendingAndroidOpenFiles();

    expect(files[0]).toMatchObject({
      name: "Huge.pdf",
      size: LOCAL_IMPORT_LIMITS.pdfBytes + 1,
      type: "application/pdf",
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "local_file_read",
      expect.anything(),
    );
  });

  it("marks unknown-size content that exceeds the stream limit as oversized", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "android_open_file_url_take") return [CONTENT_URI];
      if (command === "local_file_describe") {
        return {
          fileName: "Book.pdf",
          mimeType: "application/pdf",
          size: null,
        };
      }
      if (command === "local_file_read") {
        throw new Error(
          `content URI read: file exceeds the ${LOCAL_IMPORT_LIMITS.pdfBytes} byte limit`,
        );
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const onError = vi.fn();

    const files = await takePendingAndroidOpenFiles(onError);

    expect(files[0]).toMatchObject({
      name: "Book.pdf",
      size: LOCAL_IMPORT_LIMITS.pdfBytes + 1,
      type: "application/pdf",
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("uses the Markdown limit for Android-opened md files", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "android_open_file_url_take") return [CONTENT_URI];
      if (command === "local_file_describe") {
        return {
          fileName: "Chapter.md",
          mimeType: "text/markdown",
          size: 4,
        };
      }
      if (command === "local_file_read") {
        return new TextEncoder().encode("# MD").buffer;
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const files = await takePendingAndroidOpenFiles();

    expect(files[0]).toMatchObject({
      name: "Chapter.md",
      size: 4,
      type: "text/markdown",
    });
    expect(invokeMock).toHaveBeenCalledWith("local_file_read", {
      maxBytes: LOCAL_IMPORT_LIMITS.markdownBytes,
      pathOrUri: CONTENT_URI,
    });
  });

  it("preserves descriptor failures as reviewable file errors", async () => {
    const error = new Error("Content provider denied metadata access.");
    invokeMock.mockImplementation(async (command) => {
      if (command === "android_open_file_url_take") return [CONTENT_URI];
      if (command === "local_file_describe") throw error;
      throw new Error(`unexpected command: ${command}`);
    });
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
    invokeMock.mockImplementation(async (command) => {
      if (command === "android_open_file_url_take") {
        return warmOpen ? [CONTENT_URI] : [];
      }
      if (command === "local_file_describe") {
        return {
          fileName: "Book.txt",
          mimeType: "text/plain",
          size: 4,
        };
      }
      if (command === "local_file_read") {
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
