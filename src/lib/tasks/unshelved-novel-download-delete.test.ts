import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("../../db/queries/content-deletion", () => ({
  listNovelDeletionChapterIds: vi.fn(),
  clearNovelDownloadFiles: vi.fn(async (_novel: unknown, remove: () => Promise<void>) => remove()),
}));
vi.mock("../../db/work-metadata", () => ({ forgetNovelMetadataFile: vi.fn() }));
vi.mock("../chapter-storage-transfer", () => ({ removeChapterStorageDirectory: vi.fn(async () => undefined) }));
vi.mock("../novel-cover-storage", () => ({ clearNovelCoverDisplayCache: vi.fn() }));
vi.mock("./chapter-download", () => ({ discardQueuedChapterDownloads: vi.fn(async () => undefined) }));
vi.mock("./scheduler", () => ({ taskScheduler: { getSnapshot: vi.fn(() => ({ records: [] })), cancel: vi.fn() } }));

import { listNovelDeletionChapterIds, clearNovelDownloadFiles } from "../../db/queries/content-deletion";
import type { NovelDetailRecord } from "../../db/queries/novel";
import { forgetNovelMetadataFile } from "../../db/work-metadata";
import { removeChapterStorageDirectory } from "../chapter-storage-transfer";
import { withChapterDownloadWrite } from "../chapter-download-writes";
import { rememberAuthoritativeChapterStorageDir, resolvedChapterStorageDir } from "../chapter-storage-resolution";
import { deleteUnshelvedNovelDownloads } from "./unshelved-novel-download-delete";

const novel = { id: 12, pluginId: "source", sourceNovelId: "42", path: "/book", isLocal: false } as NovelDetailRecord;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listNovelDeletionChapterIds).mockResolvedValue(Array.from({ length: 1500 }, (_, index) => index + 1));
});

it("removes a large work with one folder operation and clears its directory mappings", async () => {
  rememberAuthoritativeChapterStorageDir(1, "contents/source/42/1");
  await deleteUnshelvedNovelDownloads(novel);
  expect(removeChapterStorageDirectory).toHaveBeenCalledExactlyOnceWith("contents/source/42");
  expect(listNovelDeletionChapterIds).toHaveBeenCalledOnce();
  expect(clearNovelDownloadFiles).toHaveBeenCalledOnce();
  expect(forgetNovelMetadataFile).toHaveBeenCalledExactlyOnceWith("source", "/book");
  expect(resolvedChapterStorageDir(1)).toBeNull();
});

it("waits for a target file write before removing its parent folder", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const write = withChapterDownloadWrite(1, undefined, () => pending);
  const deletion = deleteUnshelvedNovelDownloads(novel);
  try {
    await vi.waitFor(() => expect(listNovelDeletionChapterIds).toHaveBeenCalled());
    expect(removeChapterStorageDirectory).not.toHaveBeenCalled();
  } finally {
    release();
    await Promise.all([write, deletion]);
  }
  expect(removeChapterStorageDirectory).toHaveBeenCalledOnce();
});

it("keeps caches when folder removal fails, then clears them after a retry", async () => {
  rememberAuthoritativeChapterStorageDir(1, "contents/source/42/1");
  vi.mocked(removeChapterStorageDirectory).mockRejectedValueOnce(new Error("Storage unavailable"));
  await expect(deleteUnshelvedNovelDownloads(novel)).rejects.toThrow("Storage unavailable");
  expect(resolvedChapterStorageDir(1)).toBe("contents/source/42/1");
  expect(forgetNovelMetadataFile).not.toHaveBeenCalled();
  await deleteUnshelvedNovelDownloads(novel);
  expect(resolvedChapterStorageDir(1)).toBeNull();
});

it("keeps imported local work files", async () => {
  await deleteUnshelvedNovelDownloads({ ...novel, isLocal: true });
  expect(removeChapterStorageDirectory).not.toHaveBeenCalled();
  expect(listNovelDeletionChapterIds).not.toHaveBeenCalled();
});
