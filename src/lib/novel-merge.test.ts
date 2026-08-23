import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { syncNovelFromSource } from "./plugins/sync-novel";
import { runExclusiveChapterStorageOperation } from "./tasks/chapter-storage-operation";
import { cancelNovelChapterDownloadWork } from "./tasks/download-cache-delete";
import { executeNovelMerge } from "./novel-merge";

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
const mockedCancelNovelChapterDownloadWork = vi.mocked(
  cancelNovelChapterDownloadWork,
);

const sourceNovel = {
  id: 1,
  pluginId: "source-a",
  pluginName: "Source A",
  path: "/a-novel",
  name: "Novel A",
  cover: null,
  summary: null,
  author: null,
  artist: null,
  status: null,
  genres: null,
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
  pluginName: "Source B",
  path: "/b-novel",
  name: "Novel B",
  inLibrary: false,
};

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
  mergeTaskContext.controller = new AbortController();
  vi.mocked(pluginManager.loadInstalledFromDb).mockResolvedValue(undefined);
  vi.mocked(pluginManager.getPlugin).mockReturnValue(plugin as never);
  vi.mocked(pluginManager.getPluginForExecutor).mockReturnValue(plugin as never);
  mockedCancelNovelChapterDownloadWork.mockResolvedValue(undefined);
  mockedGetNovelById.mockImplementation(async (id) =>
    id === 1 ? sourceNovel : id === 2 ? targetNovel : null,
  );
  mockedSyncNovelFromSource.mockResolvedValue({
    changed: false,
    changedChapters: 0,
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
          status: "present",
          contentFile: "contents/source-a/Novel-A-a-novel/1-A-Chapter-1/content.html",
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
          "contents/source-a/Novel-A-a-novel/1-A-Chapter-1",
        targetRelativeDir:
          "contents/source-b/Novel-B-b-novel/1-B-Chapter-1",
        contentFile:
          "contents/source-b/Novel-B-b-novel/1-B-Chapter-1/content.html",
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
          "contents/source-a/Novel-A-a-novel/1-A-Chapter-1",
        targetRelativeDir:
          "contents/source-b/Novel-B-b-novel/1-B-Chapter-1",
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
    expect(mockedFinalizeChapterStorageTransfer).toHaveBeenCalled();
    expect(mockedRemoveChapterStorageDirectory).toHaveBeenCalledWith(
      "contents/source-a/Novel-A-a-novel",
    );
    expect(result).toMatchObject({ targetNovelId: 2, chapterIdMap: { 11: 21 } });
  });

  it("does not overwrite a valid B download", async () => {
    mockedPrepareChapterStorageTransfer.mockResolvedValueOnce({
      token: "transfer-1",
      entries: [
        {
          entryId: "11",
          outcome: "keptTarget",
          sourceRelativeDir:
            "contents/source-a/Novel-A-a-novel/1-A-Chapter-1",
          targetRelativeDir:
            "contents/source-b/Novel-B-b-novel/1-B-Chapter-1",
          contentFile:
            "contents/source-b/Novel-B-b-novel/1-B-Chapter-1/content.pdf",
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
            "contents/source-a/Novel-A-a-novel/1-A-Chapter-1",
          targetRelativeDir:
            "contents/source-b/Novel-B-b-novel/1-B-Chapter-1",
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
            "contents/source-a/Novel-A-a-novel/1-A-Chapter-1",
          targetRelativeDir:
            "contents/source-b/Novel-B-b-novel/1-B-Chapter-1",
          contentFile:
            "contents/source-b/Novel-B-b-novel/1-B-Chapter-1/content.pdf",
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
          "contents/source-a/Novel-A-a-novel/1-A-Chapter-1",
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
                "contents/source-b/Novel-B-b-novel/1-B-Chapter-1/content.html",
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
            "contents/source-a/Novel-A-a-novel/1-A-Chapter-1",
          targetRelativeDir:
            "contents/source-b/Novel-B-b-novel/1-B-Chapter-1",
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
      contentFile: string;
      contentBytes: number;
      mediaBytes: number;
    }>((resolve) => {
      finishSecondReconciliation = () => {
        resolve({
          status: "present",
          contentFile:
            "contents/source-a/Novel-A-a-novel/2-A-Chapter-2/content.html",
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
