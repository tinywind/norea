import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("./android-storage", () => ({
  finalizeAndroidChapterStorageTransfer: vi.fn(),
  prepareAndroidChapterStorageTransfer: vi.fn(),
  removeAndroidChapterStorageDirectory: vi.fn(),
  rollbackAndroidChapterStorageTransfer: vi.fn(),
}));

vi.mock("./tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(),
  isTauriRuntime: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  finalizeAndroidChapterStorageTransfer,
  prepareAndroidChapterStorageTransfer,
  removeAndroidChapterStorageDirectory,
  rollbackAndroidChapterStorageTransfer,
} from "./android-storage";
import {
  finalizeChapterStorageTransfer,
  prepareChapterStorageTransfer,
  removeChapterStorageDirectory,
  rollbackChapterStorageTransfer,
  type ChapterStorageTransferEntry,
  type ChapterStorageTransferPreparation,
} from "./chapter-storage-transfer";
import { isAndroidRuntime, isTauriRuntime } from "./tauri-runtime";

const invokeMock = vi.mocked(invoke);
const isAndroidRuntimeMock = vi.mocked(isAndroidRuntime);
const isTauriRuntimeMock = vi.mocked(isTauriRuntime);
const prepareAndroidMock = vi.mocked(prepareAndroidChapterStorageTransfer);
const finalizeAndroidMock = vi.mocked(finalizeAndroidChapterStorageTransfer);
const rollbackAndroidMock = vi.mocked(rollbackAndroidChapterStorageTransfer);
const removeAndroidMock = vi.mocked(removeAndroidChapterStorageDirectory);

const entries: ChapterStorageTransferEntry[] = [
  {
    entryId: "chapter-1",
    sourceRelativeDir: "contents/source-a/Novel-a/1-Opening",
    targetRelativeDir: "contents/source-b/Novel-b/1-Opening",
  },
];

const preparation: ChapterStorageTransferPreparation = {
  entries: [
    {
      ...entries[0]!,
      contentBytes: 12,
      contentFile: "contents/source-b/Novel-b/1-Opening/content.html",
      mediaBytes: 3,
      outcome: "copiedSource",
      replacedTarget: false,
    },
  ],
  token: "transfer-token",
};

beforeEach(() => {
  invokeMock.mockReset();
  prepareAndroidMock.mockReset();
  finalizeAndroidMock.mockReset();
  rollbackAndroidMock.mockReset();
  removeAndroidMock.mockReset();
  isTauriRuntimeMock.mockReturnValue(true);
  isAndroidRuntimeMock.mockReturnValue(false);
});

describe("chapter storage transfer", () => {
  it("uses the desktop prepare IPC contract", async () => {
    invokeMock.mockResolvedValue(preparation);

    await expect(prepareChapterStorageTransfer(entries)).resolves.toEqual(
      preparation,
    );

    expect(invokeMock).toHaveBeenCalledWith("chapter_storage_prepare_transfer", {
      entries,
    });
  });

  it("uses the desktop finalize and rollback IPC contracts", async () => {
    invokeMock.mockResolvedValue(undefined);

    await finalizeChapterStorageTransfer(preparation);
    await rollbackChapterStorageTransfer(preparation);

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "chapter_storage_finalize_transfer",
      { preparation },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "chapter_storage_rollback_transfer",
      { preparation },
    );
  });

  it("removes a desktop novel storage directory through the strict storage IPC", async () => {
    invokeMock.mockResolvedValue(undefined);

    await removeChapterStorageDirectory("contents/source-a/Novel-a");

    expect(invokeMock).toHaveBeenCalledWith("chapter_storage_remove_dir", {
      relativeDir: "contents/source-a/Novel-a",
    });
  });

  it("delegates transfer operations to the Android storage bridge", async () => {
    isAndroidRuntimeMock.mockReturnValue(true);
    prepareAndroidMock.mockResolvedValue(preparation);

    await expect(prepareChapterStorageTransfer(entries)).resolves.toEqual(
      preparation,
    );
    await finalizeChapterStorageTransfer(preparation);
    await rollbackChapterStorageTransfer(preparation);
    await removeChapterStorageDirectory(entries[0]!.sourceRelativeDir);

    expect(prepareAndroidMock).toHaveBeenCalledWith(entries);
    expect(finalizeAndroidMock).toHaveBeenCalledWith(preparation);
    expect(rollbackAndroidMock).toHaveBeenCalledWith(preparation);
    expect(removeAndroidMock).toHaveBeenCalledWith(
      entries[0]!.sourceRelativeDir,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it.each([
    { ...preparation, token: "" },
    {
      ...preparation,
      entries: [{ ...preparation.entries[0]!, outcome: "unknown" }],
    },
    {
      ...preparation,
      entries: [{ ...preparation.entries[0]!, replacedTarget: "false" }],
    },
  ])("rejects malformed transfer preparation responses", async (response) => {
    invokeMock.mockResolvedValue(response);

    await expect(prepareChapterStorageTransfer(entries)).rejects.toThrow(
      "Chapter storage transfer returned",
    );
  });

  it("rejects transfer work outside the Tauri runtime", async () => {
    isTauriRuntimeMock.mockReturnValue(false);

    await expect(prepareChapterStorageTransfer(entries)).rejects.toThrow(
      "Chapter storage transfer requires the Tauri runtime.",
    );
  });
});
