import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { pickLocalFiles, readLocalPathOrUriAsFile } from "./local-file-picker";

const invokeMock = vi.mocked(invoke);
const openMock = vi.mocked(open);

beforeEach(() => {
  invokeMock.mockReset();
  openMock.mockReset();
});

describe("local-file-picker", () => {
  it("opens native dialog and reads bounded file bytes through Rust commands", async () => {
    openMock.mockResolvedValue(["/books/sample.txt"]);
    invokeMock.mockImplementation(async (command) => {
      if (command === "local_file_describe") {
        return {
          fileName: "sample.txt",
          mimeType: "text/plain",
          size: 5,
        };
      }
      if (command === "local_file_read") {
        return new TextEncoder().encode("hello").buffer;
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const files = await pickLocalFiles({
      extensions: ["txt"],
      filterName: "Books",
      multiple: true,
      maxBytesForFile: () => 1024,
    });

    expect(openMock).toHaveBeenCalledWith({
      filters: [{ extensions: ["txt"], name: "Books" }],
      multiple: true,
    });
    expect(invokeMock).toHaveBeenCalledWith("local_file_describe", {
      pathOrUri: "/books/sample.txt",
    });
    expect(invokeMock).toHaveBeenCalledWith("local_file_read", {
      maxBytes: 1024,
      pathOrUri: "/books/sample.txt",
    });
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("sample.txt");
    expect(await files[0]?.text()).toBe("hello");
  });

  it("skips reading bytes when descriptor size already exceeds maxBytes", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "local_file_describe") {
        return {
          fileName: "huge.png",
          mimeType: "image/png",
          size: 5000,
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const file = await readLocalPathOrUriAsFile("content://media/1", () => 1024);

    expect(file.name).toBe("huge.png");
    expect(file.size).toBe(5000);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("maps unknown-size stream limit errors to an oversized File", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "local_file_describe") {
        return {
          fileName: "stream.png",
          mimeType: "image/png",
          size: null,
        };
      }
      if (command === "local_file_read") {
        throw new Error("content URI read: file exceeds the 1024 byte limit");
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const file = await readLocalPathOrUriAsFile("content://media/2", () => 1024);

    expect(file.size).toBe(1025);
  });
});
