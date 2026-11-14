import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("./tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(),
  isTauriRuntime: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
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
  isTauriRuntimeMock.mockReturnValue(true);
  isAndroidRuntimeMock.mockReturnValue(false);
});

describe("chapter storage transfer", () => {
  it("accepts a moved source receipt for rollback and finalization", async () => {
    const moved = { ...preparation, entries: preparation.entries.map(entry => ({ ...entry, outcome: "movedSource" })) };
    invokeMock.mockResolvedValue(moved);
    await expect(prepareChapterStorageTransfer(entries, { token: "move-1", moveSource: true })).resolves.toEqual(moved);
  });

  it.each([false, true])("uses the Rust prepare, finalize, rollback, and remove IPC contracts (Android: %s)", async (android) => {
    isAndroidRuntimeMock.mockReturnValue(android);
    invokeMock.mockResolvedValueOnce(preparation).mockResolvedValue(undefined);

    await expect(prepareChapterStorageTransfer(entries)).resolves.toEqual(
      preparation,
    );
    await finalizeChapterStorageTransfer(preparation);
    await rollbackChapterStorageTransfer(preparation);
    await removeChapterStorageDirectory("contents/source-a/Novel-a");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "chapter_storage_prepare_transfer", {
      entries,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "chapter_storage_finalize_transfer",
      { preparation },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      3,
      "chapter_storage_rollback_transfer",
      { preparation },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(4, "chapter_storage_remove_dir", {
      relativeDir: "contents/source-a/Novel-a",
    });
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

it.each([false, true])("passes the persisted token and strict destination checks to native preparation (Android: %s)", async (android) => {
  isTauriRuntimeMock.mockReturnValue(true);
  isAndroidRuntimeMock.mockReturnValue(android);
  invokeMock.mockResolvedValue(preparation);
  const options = { token: preparation.token, requireEmptyTargets: true };
  await prepareChapterStorageTransfer(entries, options);
  expect(invokeMock).toHaveBeenCalledWith("chapter_storage_prepare_transfer", { entries, ...options });
});
