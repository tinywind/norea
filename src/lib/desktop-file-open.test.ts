import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LOCAL_IMPORT_LIMITS } from "./local-import";
import {
  startDesktopFileOpenListener,
  takePendingDesktopOpenFiles,
  type DesktopOpenFileDescriptor,
} from "./desktop-file-open";

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

function descriptor(
  overrides: Partial<DesktopOpenFileDescriptor> = {},
): DesktopOpenFileDescriptor {
  return {
    fileName: "Book.epub",
    id: "desktop-open-1",
    mimeType: "application/epub+zip",
    size: 4,
    ...overrides,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
});

describe("desktop file open bridge", () => {
  it("loads pending native files as browser File objects", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "desktop_open_file_list") {
        return [descriptor()];
      }
      if (command === "desktop_open_file_take") {
        return new Uint8Array([1, 2, 3, 4]).buffer;
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const files = await takePendingDesktopOpenFiles();

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      name: "Book.epub",
      size: 4,
      type: "application/epub+zip",
    });
    expect(Array.from(new Uint8Array(await files[0].arrayBuffer()))).toEqual([
      1, 2, 3, 4,
    ]);
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "desktop_open_file_take",
      { id: "desktop-open-1" },
    );
  });

  it("discards oversized native content before reading it", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "desktop_open_file_list") {
        return [
          descriptor({
            fileName: "Huge.pdf",
            mimeType: "application/pdf",
            size: LOCAL_IMPORT_LIMITS.pdfBytes + 1,
          }),
        ];
      }
      if (command === "desktop_open_file_discard") {
        return undefined;
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const files = await takePendingDesktopOpenFiles();

    expect(files[0]).toMatchObject({
      name: "Huge.pdf",
      size: LOCAL_IMPORT_LIMITS.pdfBytes + 1,
      type: "application/pdf",
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "desktop_open_file_take",
      expect.anything(),
    );
    expect(invokeMock).toHaveBeenCalledWith("desktop_open_file_discard", {
      id: "desktop-open-1",
    });
  });

  it("subscribes before draining cold-start files", async () => {
    const unlisten = vi.fn();
    const onFiles = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    invokeMock.mockImplementation(async (command) => {
      if (command === "desktop_open_file_list") return [];
      throw new Error(`unexpected command: ${command}`);
    });

    const cleanup = await startDesktopFileOpenListener({ onFiles });

    expect(listenMock).toHaveBeenCalledOnce();
    expect(listenMock.mock.invocationCallOrder[0]).toBeLessThan(
      invokeMock.mock.invocationCallOrder[0],
    );
    expect(onFiles).not.toHaveBeenCalled();

    cleanup();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("drains files received while the app is already running", async () => {
    let emitOpenEvent: (() => void) | undefined;
    let warmOpen = false;
    listenMock.mockImplementation(async (_event, handler) => {
      emitOpenEvent = () =>
        handler({
          event: "desktop-open-files",
          id: 1,
          payload: null,
        } as never);
      return () => undefined;
    });
    invokeMock.mockImplementation(async (command) => {
      if (command === "desktop_open_file_list") {
        return warmOpen ? [descriptor()] : [];
      }
      if (command === "desktop_open_file_take") {
        return new Uint8Array([1, 2, 3, 4]).buffer;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const onFiles = vi.fn();

    await startDesktopFileOpenListener({ onFiles });
    warmOpen = true;
    emitOpenEvent?.();

    await vi.waitFor(() => {
      expect(onFiles).toHaveBeenCalledOnce();
    });
    expect(onFiles.mock.calls[0][0][0]).toMatchObject({
      name: "Book.epub",
      size: 4,
    });
  });
});
