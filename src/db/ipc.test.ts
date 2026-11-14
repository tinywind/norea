import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  clearAuthoritativeStorageDirs,
  resolvedChapterStorageDir,
  resolvedNovelStorageDir,
} from "../lib/chapter-storage-resolution";
import {
  getNovelCoverSnapshot,
  subscribeNovelCoverChanges,
} from "../lib/novel-cover-storage";
import { subscribeWorkMetadataChanges } from "../lib/work-metadata";
import { createTauriInvokeRouter, dbMutationEnvelope } from "../test/mock-tauri-invoke";
import {
  resetContentSyncJournalNotification,
  subscribeContentSyncChanges,
} from "./content-sync-journal";
import { invokeDbMutation, invokeDbQuery } from "./ipc";
import {
  installUserStateDeferredRunner,
  subscribeUserStateChanges,
  subscribeUserStateLedgerChanges,
  waitForUserStateDeferredApply,
} from "./user-state-core";

const router = createTauriInvokeRouter();

beforeEach(() => {
  vi.clearAllMocks();
  router.reset();
  router.installOn(vi.mocked(invoke));
  clearAuthoritativeStorageDirs();
  resetContentSyncJournalNotification();
});

describe("invokeDbQuery and invokeDbMutation", () => {
  it("routes typed queries and fails fast on unexpected commands", async () => {
    router.mockQuery("db_repo_list", [{ id: 1, url: "https://example.test/plugins.min.json" }]);

    await expect(invokeDbQuery("db_repo_list")).resolves.toEqual([
      { id: 1, url: "https://example.test/plugins.min.json" },
    ]);
    await expect(invokeDbQuery("db_missing_command")).rejects.toThrow(
      "Unexpected Tauri invoke command: db_missing_command",
    );
  });

  it("applies mutation effects synchronously before resolving the command", async () => {
    const priorities: string[] = [];
    let ledgerNotifications = 0;
    let contentSyncNotifications = 0;
    let deferredRuns = 0;
    const coverEvents: number[] = [];
    const metadataIdentities: Array<{ pluginId: string; novelPath: string } | undefined> = [];

    const unsubUserState = subscribeUserStateChanges((priority) => {
      priorities.push(priority);
    });
    const unsubLedger = subscribeUserStateLedgerChanges(() => {
      ledgerNotifications += 1;
    });
    const unsubContentSync = subscribeContentSyncChanges(() => {
      contentSyncNotifications += 1;
    });
    const unsubCovers = subscribeNovelCoverChanges((novelId) => {
      coverEvents.push(novelId);
    });
    const unsubMetadata = subscribeWorkMetadataChanges((identity) => {
      metadataIdentities.push(identity);
    });
    installUserStateDeferredRunner(async () => {
      deferredRuns += 1;
    });

    try {
      const beforeCoverSnapshot = getNovelCoverSnapshot(42);
      router.handle("db_novel_upsert", () =>
        dbMutationEnvelope(
          { id: 42 },
          {
            userStatePriority: "normal",
            userStateDeferredReady: true,
            contentSyncMaxSequence: 9,
            workMetadataChanged: true,
            coverChangedNovelIds: [42],
            workDirectories: [
              {
                novelId: 42,
                pluginId: "source-a",
                novelPath: "/works/42",
                directory: "contents/source-a/Work-42",
              },
            ],
            chapterDirectories: [
              {
                chapterId: 101,
                directory: "contents/source-a/Work-42/1",
              },
            ],
          },
        ),
      );

      const result = await invokeDbMutation<{ id: number }>("db_novel_upsert", {
        name: "Work 42",
      });

      expect(result).toEqual({ id: 42 });
      expect(priorities).toEqual(["normal"]);
      expect(ledgerNotifications).toBe(1);
      expect(contentSyncNotifications).toBe(1);
      expect(coverEvents).toEqual([42]);
      expect(getNovelCoverSnapshot(42)).toBeGreaterThan(beforeCoverSnapshot);
      expect(metadataIdentities).toEqual([
        { pluginId: "source-a", novelPath: "/works/42" },
      ]);
      expect(resolvedNovelStorageDir(42)).toBe("contents/source-a/Work-42");
      expect(resolvedChapterStorageDir(101)).toBe(
        "contents/source-a/Work-42/1",
      );

      await waitForUserStateDeferredApply();
      expect(deferredRuns).toBe(1);

      // Same content sync sequence should deduplicate, while null directories clear caches.
      router.mockMutation("db_novel_delete", true, {
        userStateLedgerChanged: true,
        contentSyncMaxSequence: 9,
        workMetadataChanged: true,
        workDirectories: [
          {
            novelId: 42,
            pluginId: "source-a",
            novelPath: "/works/42",
            directory: null,
          },
        ],
        chapterDirectories: [{ chapterId: 101, directory: null }],
      });

      await expect(invokeDbMutation<boolean>("db_novel_delete")).resolves.toBe(
        true,
      );
      expect(ledgerNotifications).toBe(2);
      expect(contentSyncNotifications).toBe(1);
      expect(resolvedNovelStorageDir(42)).toBeNull();
      expect(resolvedChapterStorageDir(101)).toBeNull();
    } finally {
      unsubUserState();
      unsubLedger();
      unsubContentSync();
      unsubCovers();
      unsubMetadata();
      installUserStateDeferredRunner(async () => undefined);
    }
  });
});
