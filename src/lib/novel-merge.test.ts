import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./content-sync/sync", () => ({
  runContentSyncOperation: vi.fn(async (operation: () => Promise<unknown>) => operation()),
  syncContentServer: vi.fn(async () => undefined),
}));
vi.mock("./content-sync/deletion-exclusions", () => ({ publishNovelMigrationSourceHold: vi.fn() }));
vi.mock("./content-sync/novel-migration", () => ({ captureNovelMigrationSourceSnapshot: vi.fn(async () => undefined) }));
vi.mock("./chapter-content/storage-platform", async original => ({
  ...await original<typeof import("./chapter-content/storage-platform")>(), inspectChapterPayloadInventory: vi.fn(),
}));

const mergeTaskContext = vi.hoisted(() => ({
  controller: new AbortController(),
}));

vi.mock("../db/queries/novel", () => ({
  getNovelById: vi.fn(),
}));

vi.mock("../db/queries/chapter", () => ({
  listChaptersByNovel: vi.fn(),
}));

vi.mock("../db/queries/novel-merge", () => ({
  applyNovelMergeInDb: vi.fn(),
}));

vi.mock("./chapter-content-storage", () => ({
  reconcileStoredChapterContent: vi.fn(),
}));

vi.mock("./chapter-storage-transfer", () => ({
  finalizeChapterStorageTransfer: vi.fn(),
  prepareChapterStorageTransfer: vi.fn(),
  removeChapterStorageDirectory: vi.fn(),
  rollbackChapterStorageTransfer: vi.fn(),
}));

vi.mock("./plugins/manager", () => ({
  pluginManager: {
    getPlugin: vi.fn(),
    getPluginForExecutor: vi.fn(),
    loadInstalledFromDb: vi.fn(),
  },
}));

vi.mock("./plugins/sync-novel", () => ({
  syncNovelFromSource: vi.fn(),
}));

vi.mock("./novel-cover-storage", () => ({
  saveNovelCoverFromSource: vi.fn(),
}));

vi.mock("./work-metadata", async original => ({
  ...await original<typeof import("./work-metadata")>(),
  readStoredNovelMetadata: vi.fn(),
  readStoredNovelCover: vi.fn(),
  persistNovelCover: vi.fn(),
}));

vi.mock("./tasks/download-cache-delete", () => ({
  cancelNovelChapterDownloadWork: vi.fn(),
}));

vi.mock("./tasks/source-tasks", () => ({
  enqueueSourceTask: vi.fn((spec) => ({
    id: "merge-task",
    promise: spec.run({
      executor: "immediate",
      signal: mergeTaskContext.controller.signal,
    }),
  })),
}));

vi.mock("./updates/update-index-events", () => ({
  markUpdatesIndexDirty: vi.fn(),
}));

vi.mock("./chapter-storage-resolution", () => ({
  resolvedChapterStorageDir: vi.fn(() => null),
  resolvedNovelStorageDir: vi.fn(() => null),
  clearResolvedChapterStorageDirs: vi.fn(),
}));

import { listChaptersByNovel } from "../db/queries/chapter";
import { applyNovelMergeInDb } from "../db/queries/novel-merge";
import { getNovelById } from "../db/queries/novel";
import { reconcileStoredChapterContent } from "./chapter-content-storage";
import {
  finalizeChapterStorageTransfer,
  prepareChapterStorageTransfer,
  removeChapterStorageDirectory,
  rollbackChapterStorageTransfer,
} from "./chapter-storage-transfer";
import { pluginManager } from "./plugins/manager";
import { isSourceAccessRequiredError } from "./plugins/source-access";
import { syncNovelFromSource } from "./plugins/sync-novel";
import { saveNovelCoverFromSource } from "./novel-cover-storage";
import { persistNovelCover, readStoredNovelCover, readStoredNovelMetadata, type NovelMetadataV1 } from "./work-metadata";
import { runExclusiveChapterStorageOperation } from "./tasks/chapter-storage-operation";
import { cancelNovelChapterDownloadWork } from "./tasks/download-cache-delete";
import { executeNovelMerge } from "./novel-merge";
import { useContentSyncStore } from "../store/content-sync";
import { syncContentServer, runContentSyncOperation } from "./content-sync/sync";
import { publishNovelMigrationSourceHold } from "./content-sync/deletion-exclusions";
import { inspectChapterPayloadInventory } from "./chapter-content/storage-platform";
import { captureNovelMigrationSourceSnapshot } from "./content-sync/novel-migration";

const mockedGetNovelById = vi.mocked(getNovelById);
const mockedListChaptersByNovel = vi.mocked(listChaptersByNovel);
const mockedApplyNovelMergeInDb = vi.mocked(applyNovelMergeInDb);
const mockedReconcileStoredChapterContent = vi.mocked(
  reconcileStoredChapterContent,
);
const mockedPrepareChapterStorageTransfer = vi.mocked(
  prepareChapterStorageTransfer,
);
const mockedFinalizeChapterStorageTransfer = vi.mocked(
  finalizeChapterStorageTransfer,
);
const mockedRollbackChapterStorageTransfer = vi.mocked(
  rollbackChapterStorageTransfer,
);
const mockedRemoveChapterStorageDirectory = vi.mocked(
  removeChapterStorageDirectory,
);
const mockedSyncNovelFromSource = vi.mocked(syncNovelFromSource);
const mockedSaveNovelCoverFromSource = vi.mocked(saveNovelCoverFromSource);
const mockedReadStoredNovelMetadata = vi.mocked(readStoredNovelMetadata);
const mockedReadStoredNovelCover = vi.mocked(readStoredNovelCover);
const mockedPersistNovelCover = vi.mocked(persistNovelCover);
const mockedCancelNovelChapterDownloadWork = vi.mocked(
  cancelNovelChapterDownloadWork,
);

const sourceNovel = {
  id: 1,
  pluginId: "source-a",
  sourceNovelId: "a-novel",
  pluginName: "Source A",
  path: "/a-novel",
  name: "Novel A",
  cover: null,
  summary: null,
  author: null,
  artist: null,
  status: null,
  genres: null,
  rating: null,
  inLibrary: true,
  isLocal: false,
  createdAt: 1,
  updatedAt: 1,
  libraryAddedAt: 1,
  lastReadAt: null,
};

const targetNovel = {
  ...sourceNovel,
  id: 2,
  pluginId: "source-b",
  sourceNovelId: "b-novel",
  pluginName: "Source B",
  path: "/b-novel",
  name: "Novel B",
  cover: "https://source-b.test/cover.jpg",
  inLibrary: false,
};

function storedMergeWork(novel: typeof sourceNovel | typeof targetNovel, cover: NovelMetadataV1["cover"] = null) {
  return {
    directory: `contents/${novel.pluginId}/${novel.sourceNovelId}`,
    metadata: {
      schemaVersion: 1 as const,
      identity: { pluginId: novel.pluginId, novelId: novel.sourceNovelId, novelPath: novel.path },
      novel: {
        name: novel.name, author: novel.author, artist: novel.artist, summary: novel.summary,
        status: novel.status, genres: novel.genres, rating: novel.rating, isLocal: novel.isLocal,
      },
      cover,
      chapters: { "1": "Chapter 1" },
    },
  };
}

const sourceChapter = {
  id: 11,
  novelId: 1,
  path: "/a/1",
  name: "A Chapter 1",
  chapterNumber: "1",
  position: 1,
  page: "1",
  bookmark: false,
  unread: true,
  progress: 0,
  isDownloaded: true,
  sourceContentType: "html" as const,
  contentType: "html" as const,
  contentBytes: 100,
  mediaBytes: 20,
  mediaRepairNeeded: false,
  releaseTime: null,
  readAt: null,
  createdAt: 1,
  foundAt: 1,
  updatedAt: 1,
};

const targetChapter = {
  ...sourceChapter,
  id: 21,
  novelId: 2,
  path: "/b/1",
  name: "B Chapter 1",
  isDownloaded: false,
  sourceContentType: "pdf" as const,
  contentType: "pdf" as const,
  contentBytes: 0,
  mediaBytes: 0,
};

const plugin = { id: "source-b", name: "Source B" };

beforeEach(() => {
  vi.clearAllMocks();
  useContentSyncStore.setState({ serverUrl: "" });
  vi.mocked(captureNovelMigrationSourceSnapshot).mockResolvedValue(undefined);
  mergeTaskContext.controller = new AbortController();
  vi.mocked(pluginManager.loadInstalledFromDb).mockResolvedValue(undefined);
  vi.mocked(pluginManager.getPlugin).mockReturnValue(plugin as never);
  vi.mocked(pluginManager.getPluginForExecutor).mockReturnValue(plugin as never);
  mockedCancelNovelChapterDownloadWork.mockResolvedValue(undefined);
  mockedSaveNovelCoverFromSource.mockResolvedValue(undefined);
  mockedReadStoredNovelMetadata.mockReset().mockResolvedValue(null);
  mockedReadStoredNovelCover.mockReset().mockResolvedValue(null);
  mockedPersistNovelCover.mockReset().mockResolvedValue(undefined);
  mockedGetNovelById.mockImplementation(async (id) =>
    id === 1 ? sourceNovel : id === 2 ? targetNovel : null,
  );
  mockedSyncNovelFromSource.mockResolvedValue({
    changed: false,
    changedChapters: 0,
    newChapters: 0,
    novelId: 2,
    chapterCount: 1,
    duplicateChapters: [],
  });
  mockedListChaptersByNovel.mockImplementation(async (novelId) =>
    novelId === 1 ? [sourceChapter] : [targetChapter],
  );
  mockedReconcileStoredChapterContent.mockImplementation(async (chapterId) =>
    chapterId === 11
      ? {
          status: "present", mediaComplete: true,
          contentFile: "contents/source-a/a-novel/1/content.html",
          contentBytes: 100,
          mediaBytes: 20,
        }
      : {
          status: "missing",
          contentFile: null,
          contentBytes: 0,
          mediaBytes: 0,
        },
  );
  mockedPrepareChapterStorageTransfer.mockResolvedValue({
    token: "transfer-1",
    entries: [
      {
        entryId: "11",
        outcome: "copiedSource",
        sourceRelativeDir:
          "contents/source-a/a-novel/1",
        targetRelativeDir:
          "contents/source-b/b-novel/1",
        contentFile:
          "contents/source-b/b-novel/1/content.html",
        contentBytes: 100,
        mediaBytes: 20,
        replacedTarget: false,
      },
    ],
  });
  mockedApplyNovelMergeInDb.mockResolvedValue({
    targetNovelId: 2,
    chapterIdMap: { 11: 21 },
    preferredLastReadChapterId: 21,
    transferredDownloads: 1,
  });
  mockedFinalizeChapterStorageTransfer.mockResolvedValue(undefined);
  mockedRollbackChapterStorageTransfer.mockResolvedValue(undefined);
  mockedRemoveChapterStorageDirectory.mockResolvedValue(undefined);
});

describe("executeNovelMerge", () => {
  it("publishes A content under the B chapter path before deleting A state", async () => {
    const result = await executeNovelMerge({
      sourceNovelId: 1,
      target: {
        pluginId: "source-b",
        item: { name: "Novel B", path: "/b-novel" },
      },
      decisions: [
        { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
      ],
      artifactSourceChapterIdByTargetPath: { "/b/1": 11 },
    });

    expect(mockedPrepareChapterStorageTransfer).toHaveBeenCalledWith([
      {
        entryId: "11",
        sourceRelativeDir:
          "contents/source-a/a-novel/1",
        targetRelativeDir:
          "contents/source-b/b-novel/1",
      },
    ]);
    expect(mockedApplyNovelMergeInDb).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceNovelId: 1,
        targetNovelId: 2,
        preparedDownloads: [
          {
            sourceChapterId: 11,
            contentType: "html",
            contentBytes: 100,
            mediaBytes: 20,
            transferredFromSource: true,
          },
        ],
      }),
    );
    expect(mockedSaveNovelCoverFromSource).toHaveBeenCalledWith(
      plugin,
      {
        id: 2,
        name: "Novel B",
        path: "/b-novel",
        pluginId: "source-b",
      },
      "https://source-b.test/cover.jpg",
    );
    expect(
      mockedSaveNovelCoverFromSource.mock.invocationCallOrder[0],
    ).toBeLessThan(mockedApplyNovelMergeInDb.mock.invocationCallOrder[0] ?? Infinity);
    expect(mockedFinalizeChapterStorageTransfer).toHaveBeenCalled();
    expect(mockedRemoveChapterStorageDirectory).toHaveBeenCalledWith(
      "contents/source-a/a-novel",
    );
    expect(result).toMatchObject({ targetNovelId: 2, chapterIdMap: { 11: 21 } });
  });

  it("continues the merge when the target library cover cannot be stored", async () => {
    mockedSaveNovelCoverFromSource.mockRejectedValueOnce(
      new Error("cover unavailable"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(
        executeNovelMerge({
          sourceNovelId: 1,
          target: {
            pluginId: "source-b",
            item: { name: "Novel B", path: "/b-novel" },
          },
          decisions: [
            { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
          ],
          artifactSourceChapterIdByTargetPath: { "/b/1": 11 },
        }),
      ).resolves.toMatchObject({ targetNovelId: 2 });
    } finally {
      warn.mockRestore();
    }

    expect(mockedApplyNovelMergeInDb).toHaveBeenCalled();
    expect(mockedPrepareChapterStorageTransfer).toHaveBeenCalled();
    expect(mockedRemoveChapterStorageDirectory).toHaveBeenCalledWith(
      "contents/source-a/a-novel",
    );
  });

  it.each(["missing", "unavailable"])("preserves the stored A cover when the B cover is %s", async condition => {
    const source = storedMergeWork(sourceNovel, { fileName: "cover.jpg", contentType: "image/jpeg" });
    const target = storedMergeWork(targetNovel);
    const cover = new Uint8Array([255, 216, 255, 217]);
    mockedReadStoredNovelMetadata.mockImplementation(async directory => directory === source.directory ? source : target);
    mockedReadStoredNovelCover.mockResolvedValue(cover);
    if (condition === "missing") {
      mockedGetNovelById.mockImplementation(async id => id === 1 ? sourceNovel : { ...targetNovel, cover: null });
    } else {
      mockedSaveNovelCoverFromSource.mockRejectedValueOnce(new Error("cover unavailable"));
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await executeNovelMerge({
        sourceNovelId: 1,
        target: { pluginId: "source-b", item: { name: "Novel B", path: "/b-novel" } },
        decisions: [{ sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" }],
      });
    } finally { warn.mockRestore(); }

    expect(mockedReadStoredNovelCover).toHaveBeenCalledWith(source.directory, source.metadata);
    expect(mockedPersistNovelCover).toHaveBeenCalledWith(target.directory,
      { body: cover, fileName: "cover.jpg", contentType: "image/jpeg" }, { preserveExisting: true });
    expect(mockedPersistNovelCover.mock.invocationCallOrder[0]).toBeLessThan(mockedApplyNovelMergeInDb.mock.invocationCallOrder[0]!);
    expect(mockedPersistNovelCover.mock.invocationCallOrder[0]).toBeLessThan(mockedRemoveChapterStorageDirectory.mock.invocationCallOrder[0]!);
  });

  it("keeps an existing target cover instead of copying the source cover", async () => {
    const target = storedMergeWork(targetNovel, { fileName: "cover.png", contentType: "image/png" });
    mockedReadStoredNovelMetadata.mockResolvedValue(target);

    await executeNovelMerge({
      sourceNovelId: 1,
      target: { pluginId: "source-b", item: { name: "Novel B", path: "/b-novel" } },
      decisions: [{ sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" }],
    });

    expect(mockedReadStoredNovelCover).not.toHaveBeenCalled();
    expect(mockedPersistNovelCover).not.toHaveBeenCalled();
    expect(mockedApplyNovelMergeInDb).toHaveBeenCalled();
  });

  it("retains the source and rolls back prepared chapters when its cover cannot be preserved", async () => {
    const source = storedMergeWork(sourceNovel, { fileName: "cover.jpg", contentType: "image/jpeg" });
    const target = storedMergeWork(targetNovel);
    mockedReadStoredNovelMetadata.mockImplementation(async directory => directory === source.directory ? source : target);
    mockedReadStoredNovelCover.mockResolvedValue(new Uint8Array([255, 216, 255, 217]));
    mockedPersistNovelCover.mockRejectedValueOnce(new Error("cover storage unavailable"));

    await expect(executeNovelMerge({
      sourceNovelId: 1,
      target: { pluginId: "source-b", item: { name: "Novel B", path: "/b-novel" } },
      decisions: [{ sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" }],
    })).rejects.toThrow("cover storage unavailable");

    expect(mockedRollbackChapterStorageTransfer).toHaveBeenCalled();
    expect(mockedApplyNovelMergeInDb).not.toHaveBeenCalled();
    expect(mockedFinalizeChapterStorageTransfer).not.toHaveBeenCalled();
    expect(mockedRemoveChapterStorageDirectory).not.toHaveBeenCalled();
  });

  it.each([null, new Uint8Array()])("retains the source when a discovered source cover cannot be read (%j)", async cover => {
    const source = storedMergeWork(sourceNovel, { fileName: "cover.jpg", contentType: "image/jpeg" });
    const target = storedMergeWork(targetNovel);
    mockedReadStoredNovelMetadata.mockImplementation(async directory => directory === source.directory ? source : target);
    mockedReadStoredNovelCover.mockResolvedValue(cover);

    await expect(executeNovelMerge({
      sourceNovelId: 1,
      target: { pluginId: "source-b", item: { name: "Novel B", path: "/b-novel" } },
      decisions: [{ sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" }],
    })).rejects.toThrow("source cover");

    expect(mockedRollbackChapterStorageTransfer).toHaveBeenCalled();
    expect(mockedPersistNovelCover).not.toHaveBeenCalled();
    expect(mockedApplyNovelMergeInDb).not.toHaveBeenCalled();
    expect(mockedRemoveChapterStorageDirectory).not.toHaveBeenCalled();
  });

  it.each(["source", "target"])("rejects a stored %s cover belonging to another work", async changed => {
    const source = storedMergeWork(sourceNovel, { fileName: "cover.jpg", contentType: "image/jpeg" });
    const target = storedMergeWork(targetNovel);
    (changed === "source" ? source : target).metadata.identity.novelId = "unrelated-work";
    mockedReadStoredNovelMetadata.mockImplementation(async directory => directory === source.directory ? source : target);

    await expect(executeNovelMerge({
      sourceNovelId: 1,
      target: { pluginId: "source-b", item: { name: "Novel B", path: "/b-novel" } },
      decisions: [{ sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" }],
    })).rejects.toThrow("Stored work metadata no longer matches");

    expect(mockedRollbackChapterStorageTransfer).toHaveBeenCalled();
    expect(mockedPersistNovelCover).not.toHaveBeenCalled();
    expect(mockedApplyNovelMergeInDb).not.toHaveBeenCalled();
    expect(mockedRemoveChapterStorageDirectory).not.toHaveBeenCalled();
  });

  it("propagates a source access challenge from target cover storage", async () => {
    mockedSaveNovelCoverFromSource.mockRejectedValueOnce(
      Object.assign(new Error("Complete the Cloudflare check."), {
        challenge: {
          kind: "cloudflare",
          url: "https://source-b.test/cdn-cgi/challenge-platform/",
        },
        code: "manual-action-required",
      }),
    );

    await expect(
      executeNovelMerge({
        sourceNovelId: 1,
        target: {
          pluginId: "source-b",
          item: { name: "Novel B", path: "/b-novel" },
        },
        decisions: [
          { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
        ],
        artifactSourceChapterIdByTargetPath: { "/b/1": 11 },
      }),
    ).rejects.toSatisfy(isSourceAccessRequiredError);
    expect(mockedApplyNovelMergeInDb).not.toHaveBeenCalled();
    expect(mockedPrepareChapterStorageTransfer).not.toHaveBeenCalled();
  });

  it("does not overwrite a valid B download", async () => {
    mockedPrepareChapterStorageTransfer.mockResolvedValueOnce({
      token: "transfer-1",
      entries: [
        {
          entryId: "11",
          outcome: "keptTarget",
          sourceRelativeDir:
            "contents/source-a/a-novel/1",
          targetRelativeDir:
            "contents/source-b/b-novel/1",
          contentFile:
            "contents/source-b/b-novel/1/content.pdf",
          contentBytes: 900,
          mediaBytes: 0,
          replacedTarget: false,
        },
      ],
    });

    await executeNovelMerge({
      sourceNovelId: 1,
      target: {
        pluginId: "source-b",
        item: { name: "Novel B", path: "/b-novel" },
      },
      decisions: [
        { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
      ],
      artifactSourceChapterIdByTargetPath: { "/b/1": 11 },
    });

    expect(mockedPrepareChapterStorageTransfer).toHaveBeenCalled();
    expect(mockedApplyNovelMergeInDb).toHaveBeenCalledWith(
      expect.objectContaining({
        preparedDownloads: [
          {
            sourceChapterId: 11,
            contentType: "pdf",
            contentBytes: 900,
            mediaBytes: 0,
            transferredFromSource: false,
          },
        ],
      }),
    );
  });

  it("rolls back when native storage returns an invalid retained B download", async () => {
    mockedPrepareChapterStorageTransfer.mockResolvedValueOnce({
      token: "transfer-1",
      entries: [
        {
          entryId: "11",
          outcome: "keptTarget",
          sourceRelativeDir:
            "contents/source-a/a-novel/1",
          targetRelativeDir:
            "contents/source-b/b-novel/1",
          contentFile: null,
          contentBytes: 900,
          mediaBytes: 0,
          replacedTarget: false,
        },
      ],
    });

    await expect(
      executeNovelMerge({
        sourceNovelId: 1,
        target: {
          pluginId: "source-b",
          item: { name: "Novel B", path: "/b-novel" },
        },
        decisions: [
          { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
        ],
        artifactSourceChapterIdByTargetPath: { "/b/1": 11 },
      }),
    ).rejects.toThrow("invalid B content path");

    expect(mockedRollbackChapterStorageTransfer).toHaveBeenCalled();
    expect(mockedApplyNovelMergeInDb).not.toHaveBeenCalled();
    expect(mockedRemoveChapterStorageDirectory).not.toHaveBeenCalled();
  });

  it("keeps a valid B download when the mapped A file is missing", async () => {
    mockedReconcileStoredChapterContent.mockResolvedValueOnce({
      status: "missing",
      contentFile: null,
      contentBytes: 0,
      mediaBytes: 0,
    });
    mockedPrepareChapterStorageTransfer.mockResolvedValueOnce({
      token: "transfer-1",
      entries: [
        {
          entryId: "11",
          outcome: "keptTarget",
          sourceRelativeDir:
            "contents/source-a/a-novel/1",
          targetRelativeDir:
            "contents/source-b/b-novel/1",
          contentFile:
            "contents/source-b/b-novel/1/content.pdf",
          contentBytes: 900,
          mediaBytes: 0,
          replacedTarget: false,
        },
      ],
    });

    await executeNovelMerge({
      sourceNovelId: 1,
      target: {
        pluginId: "source-b",
        item: { name: "Novel B", path: "/b-novel" },
      },
      decisions: [
        { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
      ],
      artifactSourceChapterIdByTargetPath: { "/b/1": 11 },
    });

    expect(mockedPrepareChapterStorageTransfer).toHaveBeenCalledWith([
      expect.objectContaining({
        entryId: "11",
        sourceRelativeDir:
          "contents/source-a/a-novel/1",
      }),
    ]);
    expect(mockedApplyNovelMergeInDb).toHaveBeenCalledWith(
      expect.objectContaining({
        preparedDownloads: [
          expect.objectContaining({
            sourceChapterId: 11,
            contentType: "pdf",
            transferredFromSource: false,
          }),
        ],
      }),
    );
  });

  it("rolls back prepared B storage when the DB merge fails", async () => {
    mockedApplyNovelMergeInDb.mockRejectedValueOnce(new Error("DB failed"));

    await expect(
      executeNovelMerge({
        sourceNovelId: 1,
        target: {
          pluginId: "source-b",
          item: { name: "Novel B", path: "/b-novel" },
        },
        decisions: [
          { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
        ],
        artifactSourceChapterIdByTargetPath: { "/b/1": 11 },
      }),
    ).rejects.toThrow("DB failed");

    expect(mockedRollbackChapterStorageTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ token: "transfer-1" }),
    );
    expect(mockedFinalizeChapterStorageTransfer).not.toHaveBeenCalled();
    expect(mockedRemoveChapterStorageDirectory).not.toHaveBeenCalled();
  });

  it("rolls back prepared B storage when the merge task is cancelled", async () => {
    mockedPrepareChapterStorageTransfer.mockImplementationOnce(
      async (entries) => {
        mergeTaskContext.controller.abort();
        return {
          token: "transfer-1",
          entries: [
            {
              ...entries[0]!,
              outcome: "copiedSource",
              contentFile:
                "contents/source-b/b-novel/1/content.html",
              contentBytes: 100,
              mediaBytes: 20,
              replacedTarget: false,
            },
          ],
        };
      },
    );

    await expect(
      executeNovelMerge({
        sourceNovelId: 1,
        target: {
          pluginId: "source-b",
          item: { name: "Novel B", path: "/b-novel" },
        },
        decisions: [
          { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
        ],
        artifactSourceChapterIdByTargetPath: { "/b/1": 11 },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(mockedRollbackChapterStorageTransfer).toHaveBeenCalled();
    expect(mockedApplyNovelMergeInDb).not.toHaveBeenCalled();
  });

  it("rolls back and stops when the selected A download disappears during prepare", async () => {
    mockedPrepareChapterStorageTransfer.mockResolvedValueOnce({
      token: "transfer-1",
      entries: [
        {
          entryId: "11",
          outcome: "sourceNotDownloaded",
          sourceRelativeDir:
            "contents/source-a/a-novel/1",
          targetRelativeDir:
            "contents/source-b/b-novel/1",
          contentFile: null,
          contentBytes: 0,
          mediaBytes: 0,
          replacedTarget: false,
        },
      ],
    });

    await expect(
      executeNovelMerge({
        sourceNovelId: 1,
        target: {
          pluginId: "source-b",
          item: { name: "Novel B", path: "/b-novel" },
        },
        decisions: [
          { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
        ],
        artifactSourceChapterIdByTargetPath: { "/b/1": 11 },
      }),
    ).rejects.toThrow("disappeared");

    expect(mockedRollbackChapterStorageTransfer).toHaveBeenCalled();
    expect(mockedApplyNovelMergeInDb).not.toHaveBeenCalled();
    expect(mockedRemoveChapterStorageDirectory).not.toHaveBeenCalled();
  });

  it("retains A storage when transfer finalization fails after the DB merge", async () => {
    mockedFinalizeChapterStorageTransfer.mockRejectedValueOnce(
      new Error("verification failed"),
    );

    const result = await executeNovelMerge({
      sourceNovelId: 1,
      target: {
        pluginId: "source-b",
        item: { name: "Novel B", path: "/b-novel" },
      },
      decisions: [
        { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
      ],
      artifactSourceChapterIdByTargetPath: { "/b/1": 11 },
    });

    expect(result.cleanupWarnings).toEqual([
      expect.stringContaining("A files were retained"),
    ]);
    expect(mockedRemoveChapterStorageDirectory).not.toHaveBeenCalled();
  });

  it("waits for every started storage reconciliation before releasing the gate", async () => {
    const secondSourceChapter = {
      ...sourceChapter,
      id: 12,
      path: "/a/2",
      name: "A Chapter 2",
      chapterNumber: "2",
      position: 2,
    };
    const secondTargetChapter = {
      ...targetChapter,
      id: 22,
      path: "/b/2",
      name: "B Chapter 2",
      chapterNumber: "2",
      position: 2,
    };
    mockedListChaptersByNovel.mockImplementation(async (novelId) =>
      novelId === 1
        ? [sourceChapter, secondSourceChapter]
        : [targetChapter, secondTargetChapter],
    );
    const reconciliationError = new Error("inspection failed");
    let finishSecondReconciliation!: () => void;
    const secondReconciliation = new Promise<{
      status: "present";
      mediaComplete: boolean;
      contentFile: string;
      contentBytes: number;
      mediaBytes: number;
    }>((resolve) => {
      finishSecondReconciliation = () => {
        resolve({
          status: "present", mediaComplete: true,
          contentFile:
            "contents/source-a/a-novel/2/content.html",
          contentBytes: 100,
          mediaBytes: 20,
        });
      };
    });
    mockedReconcileStoredChapterContent.mockImplementation((chapterId) =>
      chapterId === 11
        ? Promise.reject(reconciliationError)
        : secondReconciliation,
    );

    let mergeSettled = false;
    const observedMerge = executeNovelMerge({
      sourceNovelId: 1,
      target: {
        pluginId: "source-b",
        item: { name: "Novel B", path: "/b-novel" },
      },
      decisions: [
        { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
        { sourceChapterId: 12, kind: "map", targetChapterPath: "/b/2" },
      ],
      artifactSourceChapterIdByTargetPath: {
        "/b/1": 11,
        "/b/2": 12,
      },
    }).then(
      () => {
        mergeSettled = true;
        return null;
      },
      (error: unknown) => {
        mergeSettled = true;
        return error;
      },
    );

    await vi.waitFor(() => {
      expect(mockedReconcileStoredChapterContent).toHaveBeenCalledTimes(2);
    });
    await Promise.resolve();
    expect(mergeSettled).toBe(false);

    finishSecondReconciliation();
    expect(await observedMerge).toBe(reconciliationError);
    expect(mockedPrepareChapterStorageTransfer).not.toHaveBeenCalled();
  });

  it("holds the source storage gate until A cleanup finishes", async () => {
    let finishCleanup!: () => void;
    let cleanupStarted!: () => void;
    const cleanupStartedPromise = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    mockedRemoveChapterStorageDirectory.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
          cleanupStarted();
        }),
    );

    const merge = executeNovelMerge({
      sourceNovelId: 1,
      target: {
        pluginId: "source-b",
        item: { name: "Novel B", path: "/b-novel" },
      },
      decisions: [
        { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
      ],
      artifactSourceChapterIdByTargetPath: { "/b/1": 11 },
    });
    await cleanupStartedPromise;

    let competingStarted = false;
    const competing = runExclusiveChapterStorageOperation(
      { kind: "sources", sourceIds: ["source-a"] },
      undefined,
      async () => {
        competingStarted = true;
      },
    );
    await Promise.resolve();
    expect(competingStarted).toBe(false);

    finishCleanup();
    await Promise.all([merge, competing]);
    expect(competingStarted).toBe(true);
  });
});

it("captures the kept B inventory before the merge commits and schedules server transfer afterward", async () => {
  useContentSyncStore.setState({ serverUrl: "http://server/" });
  const baseline = { work: { id: "source-work", revision: "before-merge", identity: { pluginId: "source-a", novelId: "a-novel", novelPath: "/a-novel" } }, chapters: [] };
  vi.mocked(captureNovelMigrationSourceSnapshot).mockResolvedValue(baseline);
  const prepared = await mockedPrepareChapterStorageTransfer.getMockImplementation()!([]);
  mockedPrepareChapterStorageTransfer.mockResolvedValue({ ...prepared, entries: prepared.entries.map(entry => ({ ...entry, outcome: "keptTarget" })) });
  const inventory = { body: { sha256: "a".repeat(64), bytes: 12 }, expectedAssetKeys: [], storedAssets: [],
    fingerprint: "inventory", payloadBytes: 12, contentBytes: 12, mediaBytes: 0, mediaComplete: true };
  vi.mocked(inspectChapterPayloadInventory).mockResolvedValue(inventory);
  const result = await executeNovelMerge({
    sourceNovelId: 1, target: { pluginId: "source-b", item: { name: "Novel B", path: "/b-novel" } },
    decisions: [{ sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" }],
  });
  expect(result.contentSyncPending).toBe(true);
  expect(runContentSyncOperation).toHaveBeenCalledOnce();
  expect(mockedApplyNovelMergeInDb).toHaveBeenCalledWith(expect.objectContaining({
    contentSyncServerUrl: "http://server",
    contentSyncSourceSnapshot: baseline,
    preparedDownloads: [expect.objectContaining({
      transferredFromSource: false,
      targetInventory: { body: inventory.body, expectedAssetKeys: [], storedAssets: [] },
    })],
  }));
  expect(publishNovelMigrationSourceHold).toHaveBeenCalledWith("http://server", { pluginId: "source-a", novelId: "a-novel" });
  expect(syncContentServer).toHaveBeenCalledOnce();
});

it("rolls back preparation when a kept B inventory is incomplete before source deletion", async () => {
  useContentSyncStore.setState({ serverUrl: "http://server" });
  const prepared = await mockedPrepareChapterStorageTransfer.getMockImplementation()!([]);
  mockedPrepareChapterStorageTransfer.mockResolvedValue({ ...prepared, entries: prepared.entries.map(entry => ({ ...entry, outcome: "keptTarget" })) });
  vi.mocked(inspectChapterPayloadInventory).mockResolvedValue({ mediaComplete: false } as never);
  await expect(executeNovelMerge({
    sourceNovelId: 1, target: { pluginId: "source-b", item: { name: "Novel B", path: "/b-novel" } },
    decisions: [{ sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" }],
  })).rejects.toThrow("incomplete");
  expect(mockedRollbackChapterStorageTransfer).toHaveBeenCalledOnce();
  expect(mockedApplyNovelMergeInDb).not.toHaveBeenCalled();
  expect(publishNovelMigrationSourceHold).not.toHaveBeenCalled();
  expect(syncContentServer).not.toHaveBeenCalled();
});

it("keeps local merge available when its source server baseline could not be captured", async () => {
  useContentSyncStore.setState({ serverUrl: "http://server" });
  vi.mocked(captureNovelMigrationSourceSnapshot).mockResolvedValue(undefined);
  const result = await executeNovelMerge({
    sourceNovelId: 1, target: { pluginId: "source-b", item: { name: "Novel B", path: "/b-novel" } },
    decisions: [{ sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" }],
  });
  expect(result.contentSyncPending).toBe(true);
  expect(mockedApplyNovelMergeInDb).toHaveBeenCalledWith(expect.objectContaining({ contentSyncServerUrl: "http://server" }));
  expect(mockedApplyNovelMergeInDb.mock.calls[0]![0].contentSyncSourceSnapshot).toBeUndefined();
  expect(publishNovelMigrationSourceHold).toHaveBeenCalledOnce();
});

it("does not roll prepared files back when a post-commit source-hold notification fails", async () => {
  useContentSyncStore.setState({ serverUrl: "http://server" });
  vi.mocked(publishNovelMigrationSourceHold).mockImplementationOnce(() => { throw new Error("Observer failed"); });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const result = await executeNovelMerge({
      sourceNovelId: 1, target: { pluginId: "source-b", item: { name: "Novel B", path: "/b-novel" } },
      decisions: [{ sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" }],
    });
    expect(result.contentSyncPending).toBe(true);
    expect(mockedApplyNovelMergeInDb).toHaveBeenCalledOnce();
    expect(mockedRollbackChapterStorageTransfer).not.toHaveBeenCalled();
    expect(mockedFinalizeChapterStorageTransfer).toHaveBeenCalledOnce();
    expect(syncContentServer).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith("[novel-merge] source hold notification failed", expect.any(Error));
  } finally { warning.mockRestore(); }
});
