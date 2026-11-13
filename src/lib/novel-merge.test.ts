import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/client", () => ({ getDb: vi.fn(async () => ({})), runDatabaseTransaction: vi.fn(async run => run({})) }));
vi.mock("./novel-merge-storage", () => ({
  createNovelMergeStorageJournal: vi.fn(async () => ({ token: "transfer-1" })),
  saveNovelMergeStoragePreparation: vi.fn(),
  finishNovelMergeStorageInDb: vi.fn(),
  recoverNovelMergeStorageInDb: vi.fn(),
}));
vi.mock("../db/chapter-composition", () => ({ getChapterComposition: vi.fn(async () => null) }));

vi.mock("./content-sync/sync", () => ({
  runContentSyncOperation: vi.fn(async (operation: () => Promise<unknown>) => operation()),
  syncContentServer: vi.fn(async () => undefined),
}));
vi.mock("./content-sync/deletion-exclusions", () => ({ publishNovelMigrationSourceHold: vi.fn() }));
vi.mock("./content-sync/novel-migration", () => ({ captureNovelMigrationSourceSnapshot: vi.fn(async () => undefined), captureNovelMigrationTargetMetadata: vi.fn() }));
vi.mock("./chapter-content/storage-platform", async original => ({
  ...await original<typeof import("./chapter-content/storage-platform")>(), inspectChapterPayloadInventory: vi.fn(),
}));

const mergeTaskContext = vi.hoisted(() => ({
  controller: new AbortController(),
}));

vi.mock("../db/queries/novel", () => ({
  getNovelById: vi.fn(),
}));

vi.mock("../db/queries/chapter", async original => ({
  ...await original<typeof import("../db/queries/chapter")>(), listChaptersByNovel: vi.fn(),
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
  workMetadataOperation: vi.fn(async () => ({ paths: ["contents/source-a/a-novel/1/content.html"] })),
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
  prepareChapterStorageTransfer,
  removeChapterStorageDirectory,
} from "./chapter-storage-transfer";
import { pluginManager } from "./plugins/manager";
import { syncNovelFromSource } from "./plugins/sync-novel";
import { saveNovelCoverFromSource } from "./novel-cover-storage";
import { persistNovelCover, readStoredNovelCover, readStoredNovelMetadata, type NovelMetadataV1 } from "./work-metadata";
import { runExclusiveChapterStorageOperation } from "./tasks/chapter-storage-operation";
import { cancelNovelChapterDownloadWork } from "./tasks/download-cache-delete";
import { executeNovelMerge, executeNovelMergeFromServer } from "./novel-merge";
import { finishNovelMergeStorageInDb } from "./novel-merge-storage";
import { useContentSyncStore } from "../store/content-sync";
import { syncContentServer, runContentSyncOperation } from "./content-sync/sync";
import { publishNovelMigrationSourceHold } from "./content-sync/deletion-exclusions";
import { inspectChapterPayloadInventory } from "./chapter-content/storage-platform";
import { captureNovelMigrationSourceSnapshot, captureNovelMigrationTargetMetadata } from "./content-sync/novel-migration";

const mockedGetNovelById = vi.mocked(getNovelById);
const mockedListChaptersByNovel = vi.mocked(listChaptersByNovel);
const mockedApplyNovelMergeInDb = vi.mocked(applyNovelMergeInDb);
const mockedReconcileStoredChapterContent = vi.mocked(
  reconcileStoredChapterContent,
);
const mockedPrepareChapterStorageTransfer = vi.mocked(
  prepareChapterStorageTransfer,
);
const mockedFinishStorage = vi.mocked(finishNovelMergeStorageInDb);
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
  vi.mocked(captureNovelMigrationSourceSnapshot).mockResolvedValue({
    work: { id: "source-work", revision: "before-merge", identity: storedMergeWork(sourceNovel).metadata.identity }, chapters: [],
  });
  vi.mocked(captureNovelMigrationTargetMetadata).mockResolvedValue({
    novel: storedMergeWork(targetNovel).metadata.novel,
    cover: { fileName: "cover.jpg", contentType: "image/jpeg" }, coverSha256: "a".repeat(64),
  });
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
    authoritativeMetadata: { identity: storedMergeWork(targetNovel).metadata.identity, novel: storedMergeWork(targetNovel).metadata.novel, coverUrl: targetNovel.cover },
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
  mockedFinishStorage.mockReset().mockResolvedValue(undefined);
  mockedRemoveChapterStorageDirectory.mockResolvedValue(undefined);
});

describe("executeNovelMerge", () => {
  it("aborts before storage transfer if unreviewed A or B chapters appear", async () => {
    mockedListChaptersByNovel.mockImplementation(async novelId => novelId === 1 ? [sourceChapter] : [targetChapter, { ...targetChapter, id: 22, path: "/b/2", chapterNumber: "2", position: 2 }]);
    await expect(executeNovelMerge({ sourceNovelId: 1, target: { pluginId: "source-b", item: { name: "Novel B", path: "/b-novel" } },
      reviewedChapterCatalog: { sourceChapterIds: [11], targetChapterPaths: ["/b/1"] },
      composition: [{ key: "first", sourceChapterIds: [11], targetChapterPath: "/b/1", primary: "source" }],
    })).rejects.toThrow("NOVEL_MERGE_CATALOG_CHANGED");
    expect(mockedPrepareChapterStorageTransfer).not.toHaveBeenCalled();
    expect(mockedApplyNovelMergeInDb).not.toHaveBeenCalled();
    expect(mockedRemoveChapterStorageDirectory).not.toHaveBeenCalled();
  });


  it("composes an A-primary chapter into an empty B package before committing", async () => {
    mockedPrepareChapterStorageTransfer.mockImplementationOnce(async entries => ({
      token: "transfer-1", entries: entries.map(entry => ({ ...entry, outcome: "copiedSource" as const,
        contentFile: entry.targetRelativeDir + "/content.html", contentBytes: 100, mediaBytes: 20, replacedTarget: false })),
    }));
    await executeNovelMerge({ sourceNovelId: 1, target: { pluginId: "source-b", item: { name: "Novel B", path: "/b-novel" } },
      reviewedChapterCatalog: { sourceChapterIds: [11], targetChapterPaths: ["/b/1"] },
      composition: [{ key: "first", sourceChapterIds: [11], targetChapterPath: "/b/1", primary: "source" }] });
    expect(mockedPrepareChapterStorageTransfer.mock.calls[0]?.[0]).toEqual([
      { entryId: "11", sourceRelativeDir: "contents/source-a/a-novel/1", targetRelativeDir: "contents/source-b/b-novel/2" },
    ]);
    const committed = mockedApplyNovelMergeInDb.mock.calls[0]![0];
    const selected = committed.composition!.entries.find(entry => entry.user.included)!;
    expect(selected.path).toMatch(/^norea-composed:/);
    expect(selected.storageChapterNumber).toBe("2");
    expect(committed.readingStateSourcePathByTargetPath?.[selected.path]).toBe("/b/1");
    expect(committed.preparedDownloads[0]).toMatchObject({ sourceChapterId: 11, transferredFromSource: true });
    expect(committed.preparedCompositionCopies).toEqual([{ entry: selected, transfer: {
      entryId: "11", sourceRelativeDir: "contents/source-a/a-novel/1", targetRelativeDir: "contents/source-b/b-novel/2",
      contentFile: "contents/source-b/b-novel/2/content.html", contentBytes: 100, mediaBytes: 20, outcome: "copiedSource", replacedTarget: false,
    } }]);
  });

  it("preserves A to B reading mapping while skipping A file transfer when B body is selected", async () => {
    await executeNovelMerge({ sourceNovelId: 1, target: { pluginId: "source-b", item: { name: "Novel B", path: "/b-novel" } },
      reviewedChapterCatalog: { sourceChapterIds: [11], targetChapterPaths: ["/b/1"] },
      composition: [{ key: "first", sourceChapterIds: [11], targetChapterPath: "/b/1", primary: "target" }] });
    expect(mockedPrepareChapterStorageTransfer).not.toHaveBeenCalled();
    expect(mockedApplyNovelMergeInDb).toHaveBeenCalledWith(expect.objectContaining({
      decisions: [{ sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" }],
      preparedDownloads: [], skipSourceContentChapterIds: [11],
    }));
  });

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
    ], { token: "transfer-1", moveSource: true });
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
    expect(mockedSyncNovelFromSource).toHaveBeenCalledExactlyOnceWith(
      plugin, { name: "Novel B", path: "/b-novel" },
      { chapterRefreshMode: "full", preserveMissingMetadata: false, refreshCover: true, signal: mergeTaskContext.controller.signal },
    );
    expect(mockedSaveNovelCoverFromSource).not.toHaveBeenCalled();
    expect(mockedSyncNovelFromSource.mock.invocationCallOrder[0])
      .toBeLessThan(mockedApplyNovelMergeInDb.mock.invocationCallOrder[0]!);
    expect(mockedFinishStorage).toHaveBeenCalled();
    expect(mockedFinishStorage).toHaveBeenCalledWith(expect.anything(), "transfer-1");
    expect(result).toMatchObject({ targetNovelId: 2, chapterIdMap: { 11: 21 } });
  });

  it("retains A when the fresh target metadata or cover cannot be stored", async () => {
    mockedSyncNovelFromSource.mockRejectedValueOnce(new Error("cover unavailable"));
    await expect(executeNovelMerge({
      sourceNovelId: 1,
      target: { pluginId: "source-b", item: { name: "Novel B", path: "/b-novel" } },
      decisions: [{ sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" }],
    })).rejects.toThrow("cover unavailable");
    expect(mockedApplyNovelMergeInDb).not.toHaveBeenCalled();
    expect(mockedPrepareChapterStorageTransfer).not.toHaveBeenCalled();
    expect(mockedRemoveChapterStorageDirectory).not.toHaveBeenCalled();
  });

  it("does not substitute A's stored cover when the fresh target has no cover", async () => {
    const source = storedMergeWork(sourceNovel, { fileName: "cover.jpg", contentType: "image/jpeg" });
    const target = storedMergeWork(targetNovel);
    mockedReadStoredNovelMetadata.mockImplementation(async directory => directory === source.directory ? source : target);
    mockedReadStoredNovelCover.mockResolvedValue(new Uint8Array([255, 216, 255, 217]));
    mockedGetNovelById.mockImplementation(async id => id === 1 ? sourceNovel : { ...targetNovel, cover: null });
    const refreshed = await mockedSyncNovelFromSource.getMockImplementation()!(plugin as never, { name: "Novel B", path: "/b-novel" });
    mockedSyncNovelFromSource.mockResolvedValue({ ...refreshed, authoritativeMetadata: { ...refreshed.authoritativeMetadata!, coverUrl: null } });
    await executeNovelMerge({
      sourceNovelId: 1,
      target: { pluginId: "source-b", item: { name: "Novel B", path: "/b-novel" } },
      decisions: [{ sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" }],
    });
    expect(mockedReadStoredNovelCover).not.toHaveBeenCalled();
    expect(mockedPersistNovelCover).not.toHaveBeenCalled();
    expect(mockedApplyNovelMergeInDb).toHaveBeenCalled();
  });

  it("propagates a target metadata refresh challenge before changing A", async () => {
    const challenge = Object.assign(new Error("Complete the Cloudflare check."), {
      challenge: { kind: "cloudflare", url: "https://source-b.test/cdn-cgi/challenge-platform/" },
      code: "manual-action-required",
    });
    mockedSyncNovelFromSource.mockRejectedValueOnce(challenge);
    await expect(executeNovelMerge({
      sourceNovelId: 1,
      target: { pluginId: "source-b", item: { name: "Novel B", path: "/b-novel" } },
      decisions: [{ sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" }],
    })).rejects.toBe(challenge);
    expect(mockedApplyNovelMergeInDb).not.toHaveBeenCalled();
    expect(mockedPrepareChapterStorageTransfer).not.toHaveBeenCalled();
    expect(mockedRemoveChapterStorageDirectory).not.toHaveBeenCalled();
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

    expect(mockedFinishStorage).toHaveBeenCalled();
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
    ], { token: "transfer-1", moveSource: true });
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

    expect(mockedFinishStorage).toHaveBeenCalledWith(
      expect.anything(), "transfer-1",
    );
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

    expect(mockedFinishStorage).toHaveBeenCalled();
    expect(mockedApplyNovelMergeInDb).not.toHaveBeenCalled();
  });

  it("merges past an unfinished A download, leaving it undownloaded for removal with A's folder", async () => {
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
    ).resolves.toMatchObject({ targetNovelId: 2 });

    expect(mockedApplyNovelMergeInDb).toHaveBeenCalledWith(expect.objectContaining({ preparedDownloads: [] }));
  });

  it("retains committed recovery state when finalization fails after the DB merge", async () => {
    mockedFinishStorage.mockRejectedValueOnce(
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
      expect.stringContaining("needs recovery"),
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
    mockedFinishStorage.mockImplementationOnce(
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
    contentSyncTargetMetadata: {
      novel: storedMergeWork(targetNovel).metadata.novel,
      cover: { fileName: "cover.jpg", contentType: "image/jpeg" }, coverSha256: "a".repeat(64),
    },
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
  expect(mockedFinishStorage).toHaveBeenCalledOnce();
  expect(mockedApplyNovelMergeInDb).not.toHaveBeenCalled();
  expect(publishNovelMigrationSourceHold).not.toHaveBeenCalled();
  expect(syncContentServer).not.toHaveBeenCalled();
});

it("retains original files and records until the configured server baseline can be verified", async () => {
  useContentSyncStore.setState({ serverUrl: "http://server" });
  vi.mocked(captureNovelMigrationSourceSnapshot).mockResolvedValue(undefined);
  await expect(executeNovelMerge({
    sourceNovelId: 1, target: { pluginId: "source-b", item: { name: "Novel B", path: "/b-novel" } },
    decisions: [{ sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" }],
  })).rejects.toThrow("Synchronize the original work with the server, then retry");
  expect(mockedApplyNovelMergeInDb).not.toHaveBeenCalled();
  expect(mockedPrepareChapterStorageTransfer).not.toHaveBeenCalled();
  expect(mockedRemoveChapterStorageDirectory).not.toHaveBeenCalled();
  expect(publishNovelMigrationSourceHold).not.toHaveBeenCalled();
  expect(syncContentServer).not.toHaveBeenCalled();
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
    expect(mockedFinishStorage).toHaveBeenCalledOnce();
    expect(syncContentServer).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith("[novel-merge] source hold notification failed", expect.any(Error));
  } finally { warning.mockRestore(); }
});


it("retains original records and files when the fresh target proof cannot be captured", async () => {
  useContentSyncStore.setState({ serverUrl: "http://server" });
  vi.mocked(captureNovelMigrationTargetMetadata).mockRejectedValueOnce(new Error("Target metadata changed"));
  await expect(executeNovelMerge({
    sourceNovelId: 1, target: { pluginId: "source-b", item: { name: "Novel B", path: "/b-novel" } },
    decisions: [{ sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" }],
  })).rejects.toThrow("Target metadata changed");
  expect(mockedApplyNovelMergeInDb).not.toHaveBeenCalled();
  expect(mockedPrepareChapterStorageTransfer).not.toHaveBeenCalled();
  expect(mockedRemoveChapterStorageDirectory).not.toHaveBeenCalled();
  expect(syncContentServer).not.toHaveBeenCalled();
});

const incomingInventory = { body: { sha256: "a".repeat(64), bytes: 100 }, expectedAssetKeys: [], storedAssets: [] };
it("applies a received migration without plugins or an outgoing server operation", async () => {
  const recordIncomingMigration = vi.fn(async () => undefined);
  vi.mocked(inspectChapterPayloadInventory).mockResolvedValue({ ...incomingInventory, fingerprint: "inventory", payloadBytes: 100, contentBytes: 100, mediaBytes: 0, mediaComplete: true });
  const result = await executeNovelMergeFromServer({
    sourceNovelId: 1, targetNovelId: 2,
    decisions: [{ sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" }],
  }, { signal: new AbortController().signal, recordIncomingMigration });
  expect(result.targetNovelId).toBe(2);
  expect(result.contentSyncPending).toBeUndefined();
  expect(mockedApplyNovelMergeInDb).toHaveBeenCalledWith(expect.objectContaining({ recordIncomingMigration }));
  expect(mockedApplyNovelMergeInDb.mock.calls[0]![0].contentSyncServerUrl).toBeUndefined();
  expect(pluginManager.loadInstalledFromDb).not.toHaveBeenCalled();
  expect(mockedSyncNovelFromSource).not.toHaveBeenCalled();
  expect(captureNovelMigrationTargetMetadata).not.toHaveBeenCalled();
  expect(captureNovelMigrationSourceSnapshot).not.toHaveBeenCalled();
  expect(syncContentServer).not.toHaveBeenCalled();
});
it("rolls back an incoming move when the destination bytes differ from the original local snapshot", async () => {
  const snapshot = { ...incomingInventory, fingerprint: "inventory", payloadBytes: 100, contentBytes: 100, mediaBytes: 0, mediaComplete: true };
  vi.mocked(inspectChapterPayloadInventory).mockResolvedValueOnce(snapshot).mockResolvedValueOnce({ ...snapshot, body: null })
    .mockResolvedValueOnce({ ...snapshot, body: { sha256: "b".repeat(64), bytes: 100 } });
  await expect(executeNovelMergeFromServer({
    sourceNovelId: 1, targetNovelId: 2, decisions: [{ sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" }],
  }, { signal: new AbortController().signal, recordIncomingMigration: vi.fn() })).rejects.toThrow("changed during the move");
  expect(mockedApplyNovelMergeInDb).not.toHaveBeenCalled();
  expect(mockedFinishStorage).toHaveBeenCalledOnce();
  expect(mockedRemoveChapterStorageDirectory).not.toHaveBeenCalled();
});

it("preserves an occupied directory detected during native preparation", async () => {
  vi.mocked(inspectChapterPayloadInventory).mockResolvedValue({ ...incomingInventory, fingerprint: "inventory", payloadBytes: 100, contentBytes: 100, mediaBytes: 0, mediaComplete: true });
  const original = await mockedPrepareChapterStorageTransfer.getMockImplementation()!([]);
  mockedPrepareChapterStorageTransfer.mockResolvedValue({ ...original, entries: original.entries.map(entry => ({ ...entry, replacedTarget: true })) });
  await expect(executeNovelMergeFromServer({ sourceNovelId: 1, targetNovelId: 2,
    decisions: [{ sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" }],
  }, { signal: new AbortController().signal, recordIncomingMigration: vi.fn() })).rejects.toThrow("changed during the move");
  expect(mockedApplyNovelMergeInDb).not.toHaveBeenCalled();
  expect(mockedFinishStorage).toHaveBeenCalledOnce();
});

it("retains the original when another refresh replaces the confirmed plugin metadata", async () => {
  mockedGetNovelById.mockImplementation(async id => id === 1 ? sourceNovel : { ...targetNovel, author: "Changed after parse" });
  await expect(executeNovelMerge({ sourceNovelId: 1, target: { pluginId: "source-b", item: { name: "Novel B", path: "/b-novel" } },
    decisions: [{ sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" }],
  })).rejects.toThrow("target metadata changed after its source refresh");
  expect(mockedApplyNovelMergeInDb).not.toHaveBeenCalled();
  expect(mockedPrepareChapterStorageTransfer).not.toHaveBeenCalled();
});
