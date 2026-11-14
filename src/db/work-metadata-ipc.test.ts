import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTauriInvokeRouter } from "../test/mock-tauri-invoke";

const invokeMock = vi.hoisted(() => vi.fn());
const events = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
}));
const covers = vi.hoisted(() => ({
  changed: vi.fn(),
  invalidated: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (
    name: string,
    callback: (event: { payload: unknown }) => void,
  ) => {
    const bucket = events.listeners.get(name) ?? new Set();
    bucket.add(callback);
    events.listeners.set(name, bucket);
    return () => {
      bucket.delete(callback);
    };
  },
}));
vi.mock("../lib/tauri-runtime", () => ({
  isTauriRuntime: () => true,
  isAndroidRuntime: () => false,
}));
vi.mock("../lib/observability", () => ({
  startPerformanceObservation: () => () => undefined,
  recordPerformanceObservation: () => undefined,
}));
vi.mock("../lib/novel-cover-storage", () => ({
  notifyNovelCoverChanged: covers.changed,
  invalidateAllNovelCoverSources: covers.invalidated,
}));
vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    get: () => ({
      path: "sqlite:norea.db",
      execute: vi.fn(async () => ({ rowsAffected: 0, lastInsertId: 0 })),
      select: vi.fn(async () => []),
      close: vi.fn(async () => true),
    }),
  },
}));

import { installUserStateDeferredNovelRecorder } from "./user-state-core";
import {
  hasWorkMetadataConflict,
  knownNovelMetadataDirectory,
  readWorkMetadataSyncFile,
  readWorkMetadataSyncFiles,
  refreshStoredNovelChapterDownloads,
  restoreWorkMetadataDirectoriesFromRust,
  storedNovelMetadataFingerprint,
} from "./work-metadata";
import {
  installStoredNovelMetadata,
  persistNovelCover,
  type NovelMetadataV1,
} from "../lib/work-metadata";
import {
  clearAuthoritativeStorageDirs,
  resolvedChapterStorageDir,
  resolvedNovelStorageDir,
} from "../lib/chapter-storage-resolution";
import { withChapterDownloadWrite } from "../lib/chapter-download-writes";
import { cancelWorkMetadataRecovery, startWorkMetadataRecovery } from "./client";
import { useStorageRecoveryStore } from "../store/storage-recovery";

const sampleMetadata: NovelMetadataV1 = {
  schemaVersion: 1,
  identity: {
    pluginId: "source",
    novelId: "book-1",
    novelPath: "/book-1",
  },
  novel: {
    name: "Book One",
    author: "Author",
    artist: null,
    summary: "Summary",
    status: "Ongoing",
    genres: "Fantasy",
    rating: 4.5,
    isLocal: false,
  },
  cover: {
    fileName: "cover.jpg",
    contentType: "image/jpeg",
  },
  chapters: {
    "1": "Chapter 1",
  },
};

function emitEvent(name: string, payload: unknown): void {
  for (const listener of [...(events.listeners.get(name) ?? [])]) {
    listener({ payload });
  }
}

describe("work metadata Rust IPC contracts", () => {
  const router = createTauriInvokeRouter();

  beforeEach(() => {
    router.reset();
    router.installOn(invokeMock);
    events.listeners.clear();
    covers.changed.mockClear();
    covers.invalidated.mockClear();
    clearAuthoritativeStorageDirs();
  });

  it("restores known metadata fingerprints and chapter directories from Rust", async () => {
    const fingerprint = await storedNovelMetadataFingerprint(sampleMetadata);
    router.mockQuery("db_work_metadata_restore_directories", {
      files: [
        {
          pluginId: "source",
          path: "/book-1",
          novelId: 7,
          directory: "contents/source/book-1",
          fingerprint,
        },
      ],
      chapters: [{ id: 101, directory: "contents/source/book-1/1" }],
    });

    await restoreWorkMetadataDirectoriesFromRust(true);

    expect(router.calls).toEqual([
      {
        command: "db_work_metadata_restore_directories",
        args: { registerNative: true, readMode: "queued" },
        options: undefined,
      },
    ]);
    expect(knownNovelMetadataDirectory(sampleMetadata.identity)).toBe(
      "contents/source/book-1",
    );
    expect(resolvedNovelStorageDir(7)).toBe("contents/source/book-1");
    expect(resolvedChapterStorageDir(101)).toBe("contents/source/book-1/1");
    expect(
      await hasWorkMetadataConflict("contents/source/book-1", sampleMetadata),
    ).toBe(false);
    expect(covers.changed).toHaveBeenCalledExactlyOnceWith(7, {
      pluginId: "source",
      path: "/book-1",
    });
  });

  it("passes ineligible locked chapter IDs to db_work_metadata_apply_scanned_downloads", async () => {
    router.mockQuery(
      "db_work_metadata_get_work_directory",
      "contents/source/book-1",
    );
    router.handle("work_metadata_operation", () => ({ paths: [] }));
    router.mockMutation("db_work_metadata_apply_scanned_downloads");

    await withChapterDownloadWrite(42, undefined, async () => {
      await refreshStoredNovelChapterDownloads(7);
    });

    expect(
      router.calls.find(
        (call) => call.command === "db_work_metadata_apply_scanned_downloads",
      )?.args,
    ).toEqual({
      novelId: 7,
      directory: "contents/source/book-1",
      chapters: [],
      skippedChapterIds: [42],
    });
  });

  it("flushes pending metadata before reading sync files and routes single-file reads", async () => {
    const syncFile = {
      pluginId: "source",
      path: "/book-1",
      directory: "contents/source/book-1",
      fingerprint: "a".repeat(64),
      revision: 3,
    };
    router.mockMutation("db_work_metadata_flush_pending");
    router.mockQuery("db_work_metadata_read_sync_files", [syncFile]);
    router.mockQuery("db_work_metadata_read_sync_file", syncFile);

    await expect(readWorkMetadataSyncFiles(false)).resolves.toEqual([syncFile]);
    await expect(
      readWorkMetadataSyncFile({ pluginId: "source", novelPath: "/book-1" }),
    ).resolves.toEqual(syncFile);

    expect(router.calls.map((call) => call.command)).toEqual([
      "db_work_metadata_flush_pending",
      "db_work_metadata_read_sync_files",
      "db_work_metadata_read_sync_file",
    ]);
  });

  it("applies mutation effects for installStoredNovelMetadata and records deferred user-state novels", async () => {
    const deferredSpy = vi.fn();
    installUserStateDeferredNovelRecorder(deferredSpy);
    const fingerprint = await storedNovelMetadataFingerprint(sampleMetadata);
    router.mockMutation(
      "db_work_metadata_install_stored",
      {
        novelId: 11,
        directory: "contents/source/book-1",
        metadata: sampleMetadata,
        syncFile: {
          pluginId: "source",
          path: "/book-1",
          directory: "contents/source/book-1",
          fingerprint,
          revision: 1,
        },
        coverBytes: [1, 2, 3],
      },
      {
        coverChangedNovelIds: [11],
        userStateDeferredNovelIds: [11],
        workDirectories: [
          {
            novelId: 11,
            pluginId: "source",
            novelPath: "/book-1",
            directory: "contents/source/book-1",
            fingerprint,
          },
        ],
      },
    );

    const installed = await installStoredNovelMetadata(
      sampleMetadata,
      new Uint8Array([1, 2, 3]),
    );

    expect(installed?.directory).toBe("contents/source/book-1");
    expect(installed?.coverBytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(knownNovelMetadataDirectory(sampleMetadata.identity)).toBe(
      "contents/source/book-1",
    );
    expect(deferredSpy).toHaveBeenCalledExactlyOnceWith([11]);
    expect(covers.changed).toHaveBeenCalledExactlyOnceWith(11, {
      pluginId: "source",
      path: "/book-1",
    });
  });

  it("invalidates cover sources when persistNovelCover fails both publication and rollback", async () => {
    router.handle("db_work_metadata_persist_cover", () => {
      throw new Error(
        "work metadata: publication and rollback failed (write broke; rollback broke)",
      );
    });

    await expect(
      persistNovelCover(
        "contents/source/book-1",
        {
          body: new Uint8Array([9, 8, 7]),
          fileName: "cover.jpg",
          contentType: "image/jpeg",
        },
        { preserveExisting: false },
      ),
    ).rejects.toThrow("publication and rollback failed");
    expect(covers.invalidated).toHaveBeenCalledOnce();
  });

  it("streams startup recovery events and awaits cancellation before starting a rebuild", async () => {
    router.handle("database_transaction_reset", () => undefined);
    router.mockQuery("db_work_metadata_restore_directories", {
      files: [],
      chapters: [],
    });

    let releaseFirstRun: (() => void) | null = null;
    let cancelResolved = false;
    router.handle("db_work_metadata_cancel_recovery", async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      cancelResolved = true;
      releaseFirstRun?.();
    });

    let recoveryRun = 0;
    router.handle("db_startup_recover_work_metadata", async (args) => {
      recoveryRun += 1;
      if (recoveryRun === 1) {
        emitEvent("norea:storage-recovery-progress", {
          progress: {
            totalWorks: 2,
            completedWorks: 1,
            recoveredWorks: 1,
            recoveredChapters: 3,
            skippedWorks: 0,
            currentWork: "Book One",
          },
          effects: {
            coverChangedNovelIds: [5],
            workDirectories: [
              {
                novelId: 5,
                pluginId: "source",
                novelPath: "/book-1",
                directory: "contents/source/book-1",
                fingerprint: "b".repeat(64),
              },
            ],
          },
        });
        await new Promise<void>((resolve) => {
          releaseFirstRun = resolve;
        });
        throw new Error("Storage recovery cancelled.");
      }
      expect(cancelResolved).toBe(true);
      expect(args).toEqual({ rebuild: true });
      emitEvent("norea:storage-recovery-progress", {
        progress: {
          totalWorks: 1,
          completedWorks: 1,
          recoveredWorks: 1,
          recoveredChapters: 1,
          skippedWorks: 0,
          currentWork: null,
        },
        effects: null,
      });
      return {
        value: {
          totalWorks: 1,
          completedWorks: 1,
          recoveredWorks: 1,
          recoveredChapters: 1,
          skippedWorks: 0,
          currentWork: null,
        },
        effects: {},
      };
    });

    startWorkMetadataRecovery(false);
    await vi.waitFor(() =>
      expect(useStorageRecoveryStore.getState().status).toBe("scanning"),
    );
    expect(covers.changed).toHaveBeenCalledWith(5, {
      pluginId: "source",
      path: "/book-1",
    });

    cancelWorkMetadataRecovery();
    startWorkMetadataRecovery(true);

    await vi.waitFor(() =>
      expect(useStorageRecoveryStore.getState().status).toBe("complete"),
    );
  });
});
