import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeState = vi.hoisted(() => ({ tauri: true }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../lib/tauri-runtime", () => ({
  isTauriRuntime: () => runtimeState.tauri,
  isAndroidRuntime: () => false,
}));

import { invoke } from "@tauri-apps/api/core";
import { withChapterDownloadWrite } from "../lib/chapter-download-writes";
import type { UserStateBinding, UserStateOperation } from "../lib/user-state/types";
import type { DbMutationEnvelope } from "./ipc";
import {
  acknowledgeUserStateOperations,
  applyLocalUserStateRetention,
  applyUserStateReadPage,
  assertUserStateAvailable,
  bindUserStateWorkspace,
  getUserStateBinding,
  getUserStateLedgerStatus,
  getUserStateRestorePaused,
  listUserStateConflicts,
  listUserStateDeferred,
  materializePendingUserState,
  prepareUserStateOperations,
  pruneUserStateOperations,
  rebindUserStateWorkspace,
  reconcileUserStateSnapshot,
  recordUserResume,
  recordUserResumeCleared,
  resolveUserStateLedgerConflict,
  resumeUserStateAfterRestore,
  setUserStateActiveServer,
  subscribeUserStateApplied,
  subscribeUserStateChanges,
  subscribeUserStateLedgerChanges,
  USER_STATE_OPERATION_RETENTION_SECS,
} from "./user-state";
import {
  applyUserStateCurrentSnapshot,
  bindUserStateCurrentWorkspace,
  exportUserStateCurrentSnapshot,
  getUserStateCurrentStatus,
  setUserStateCurrentServer,
} from "./user-state-current";
import { waitForUserStateDeferredApply } from "./user-state-core";

const binding: UserStateBinding = {
  serverUrl: "https://sync.example",
  workspaceId: "workspace-a",
  epoch: "epoch-a",
};

describe("user-state Rust IPC wrappers", () => {
  beforeEach(() => {
    runtimeState.tauri = true;
    vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
    setUserStateActiveServer(null);
    setUserStateCurrentServer(null);
    vi.mocked(invoke).mockClear();
  });

  afterEach(async () => {
    vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
    setUserStateActiveServer(null);
    setUserStateCurrentServer(null);
    await waitForUserStateDeferredApply();
  });

  it("routes ledger queries and mutations through typed Rust commands and propagates mutation effects", async () => {
    const ledgerEvents: number[] = [];
    const changePriorities: string[] = [];
    const appliedEvents: unknown[] = [];
    const unsubLedger = subscribeUserStateLedgerChanges(() => {
      ledgerEvents.push(ledgerEvents.length + 1);
    });
    const unsubChanges = subscribeUserStateChanges(priority => {
      changePriorities.push(priority);
    });
    const unsubApplied = subscribeUserStateApplied(effects => {
      appliedEvents.push(effects);
    });

    try {
      setUserStateActiveServer(binding.serverUrl);
      vi.mocked(invoke).mockImplementation(async (command: string) => {
        switch (command) {
          case "db_user_state_get_binding":
            return binding;
          case "db_user_state_bind_workspace":
            return {
              value: null,
              effects: { userStateLedgerChanged: true },
            } satisfies DbMutationEnvelope<null>;
          case "db_user_state_prepare_operations":
            return {
              value: [
                {
                  operationId: "op-1",
                  entity: {
                    kind: "reading",
                    work: {
                      pluginId: "src",
                      sourceNovelId: "novel-1",
                      novelPath: "/novel-1",
                      name: "Novel 1",
                    },
                    chapter: { chapterPath: "/ch/1", name: "Ch 1" },
                  },
                  baseRevision: 0,
                  value: { progress: 50, unread: true, readAt: null },
                },
              ],
              effects: { userStateLedgerChanged: true },
            } satisfies DbMutationEnvelope<UserStateOperation[]>;
          case "db_user_state_get_ledger_status":
            return {
              cursor: 2,
              through: 2,
              pending: 1,
              conflicts: 0,
              deferred: 0,
              projectionPending: 0,
              projectionFailed: 0,
              lastSuccessAt: 1000,
              pausedAfterRestore: false,
            };
          case "db_user_state_list_conflicts":
          case "db_user_state_list_deferred":
            return [];
          case "db_user_state_record_resume":
            return {
              value: null,
              effects: { userStatePriority: "reading" },
            } satisfies DbMutationEnvelope<null>;
          case "db_user_state_record_resume_cleared":
          case "db_user_state_resume_after_restore":
            return {
              value: null,
              effects: { userStateLedgerChanged: true },
            } satisfies DbMutationEnvelope<null>;
          case "db_user_state_get_restore_paused":
            return false;
          case "db_user_state_assert_available":
            return null;
          case "db_user_state_apply_read_page":
          case "db_user_state_resolve_conflict":
            return {
              value: { resumes: [] },
              effects: { userStateLedgerChanged: true },
            };
          case "db_user_state_prune_operations":
            return {
              value: 3,
              effects: { userStateLedgerChanged: true },
            };
          case "db_user_state_project_pending":
            return {
              value: {
                resumes: [
                  { novelId: 7, chapterId: 70, anchor: null, openedAt: 42 },
                ],
              },
              effects: { userStateLedgerChanged: true },
            };
          default:
            throw new Error(`Unexpected command: ${command}`);
        }
      });

      expect(await getUserStateBinding()).toEqual(binding);
      await bindUserStateWorkspace(binding);
      const ops = await prepareUserStateOperations(binding, { limit: 10 });
      expect(ops).toHaveLength(1);
      expect(await getUserStateLedgerStatus(binding)).toMatchObject({
        cursor: 2,
        pending: 1,
      });
      expect(await listUserStateConflicts(binding)).toEqual([]);
      expect(await listUserStateDeferred(binding)).toEqual([]);
      await recordUserResume(70, null, 120);
      expect(changePriorities).toEqual(["reading"]);
      await recordUserResumeCleared(7);
      expect(await getUserStateRestorePaused()).toBe(false);
      await assertUserStateAvailable();
      await resumeUserStateAfterRestore();
      await applyUserStateReadPage(binding, {
        version: 1,
        workspaceId: binding.workspaceId,
        epoch: binding.epoch,
        headRevision: 1,
        through: 1,
        nextCursor: 1,
        hasMore: false,
        records: [],
      });
      await resolveUserStateLedgerConflict(binding, {
        id: "c1",
        version: "v1",
        choice: "local",
      });
      const projected = await materializePendingUserState(binding);
      expect(projected).toEqual({
        resumes: [{ novelId: 7, chapterId: 70, anchor: null, openedAt: 42 }],
      });
      expect(appliedEvents).toEqual([
        {
          resumes: [{ novelId: 7, chapterId: 70, anchor: null, openedAt: 42 }],
        },
      ]);
      expect(await pruneUserStateOperations(binding)).toBe(3);
      expect(invoke).toHaveBeenCalledWith("db_user_state_prune_operations", {
        binding,
        olderThanSecs: USER_STATE_OPERATION_RETENTION_SECS,
      });
      await expect(pruneUserStateOperations(binding, -1)).rejects.toThrow(/non-negative/);
      expect(ledgerEvents.length).toBeGreaterThanOrEqual(7);
    } finally {
      unsubLedger();
      unsubChanges();
      unsubApplied();
    }
  });

  it("chunks acknowledgeUserStateOperations into 128-receipt batches", async () => {
    const batches: number[] = [];
    vi.mocked(invoke).mockImplementation(
      async (command: string, args?: unknown) => {
        if (command === "db_user_state_acknowledge_operations") {
          const payload = args as { results: unknown[] };
          batches.push(payload.results.length);
          return {
            value: { resumes: [] },
            effects: { userStateLedgerChanged: true },
          };
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    );

    const results = Array.from({ length: 260 }, (_, idx) => ({
      operationId: `op-${idx}`,
      status: "applied" as const,
      current: null,
    }));
    await acknowledgeUserStateOperations(binding, results);
    expect(batches).toEqual([128, 128, 4]);
  });

  it("chunks materializePendingUserState while hasMore is true and skips failed entity keys", async () => {
    const calls: unknown[] = [];
    vi.mocked(invoke).mockImplementation(
      async (command: string, args?: unknown) => {
        if (command === "db_user_state_project_pending") {
          calls.push(args);
          if (calls.length === 1) {
            return {
              value: {
                resumes: [{ novelId: 1, chapterId: 10, anchor: null, openedAt: 10 }],
                hasMore: true,
                failedEntityKeys: ["[\"reading\",\"err\"]"],
              },
              effects: { userStateLedgerChanged: true },
            };
          }
          return {
            value: {
              resumes: [{ novelId: 2, chapterId: 20, anchor: null, openedAt: 20 }],
              hasMore: false,
            },
            effects: { userStateLedgerChanged: true },
          };
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    );

    const effects = await materializePendingUserState(binding);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ binding, limit: 256 });
    expect((calls[0] as { skipEntityKeys?: unknown }).skipEntityKeys).toBeUndefined();
    expect(calls[1]).toMatchObject({
      binding,
      limit: 256,
      skipEntityKeys: ["[\"reading\",\"err\"]"],
    });
    expect(effects).toEqual({
      resumes: [
        { novelId: 1, chapterId: 10, anchor: null, openedAt: 10 },
        { novelId: 2, chapterId: 20, anchor: null, openedAt: 20 },
      ],
    });
  });

  it("syncs current-mode state to Rust and coordinates busy chapter writes with snapshot IPC", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    let releaseExport!: () => void;
    const exportPaused = new Promise<void>(resolve => {
      releaseExport = resolve;
    });
    let exportStarted!: () => void;
    const reachedExport = new Promise<void>(resolve => {
      exportStarted = resolve;
    });

    vi.mocked(invoke).mockImplementation(
      async (command: string, args?: unknown) => {
        calls.push({ command, args });
        if (command === "db_user_state_set_current_mode") {
          return null;
        }
        if (command === "db_user_state_bind_current_workspace") {
          return { value: null, effects: { userStateLedgerChanged: true } };
        }
        if (command === "db_user_state_get_current_status") {
          return {
            workspaceId: binding.workspaceId,
            epoch: binding.epoch,
            lastSuccessAt: 500,
            pausedAfterRestore: false,
            missingMetadataCount: 0,
          };
        }
        if (command === "db_user_state_export_current_snapshot") {
          exportStarted();
          await exportPaused;
          return {
            value: {
              version: 2,
              workspaceId: binding.workspaceId,
              epoch: binding.epoch,
              items: [],
            },
            effects: {},
          };
        }
        if (command === "db_user_state_apply_current_snapshot") {
          return {
            value: { resumes: [], missingMetadataCount: 0, changed: true },
            effects: { userStateLedgerChanged: true },
          };
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    );

    setUserStateCurrentServer(binding.serverUrl);
    expect(calls[0]).toEqual({
      command: "db_user_state_set_current_mode",
      args: { enabled: true },
    });

    await bindUserStateCurrentWorkspace(binding);
    expect(await getUserStateCurrentStatus()).toMatchObject({
      workspaceId: binding.workspaceId,
    });

    let activeBusyRelease!: () => void;
    const activeBusyGate = new Promise<void>(resolve => {
      activeBusyRelease = resolve;
    });
    const activeBusyWrite = withChapterDownloadWrite(99, undefined, () => activeBusyGate);

    const exporting = exportUserStateCurrentSnapshot(binding);
    await reachedExport;

    const exportCall = calls.find(
      entry => entry.command === "db_user_state_export_current_snapshot",
    );
    expect(exportCall?.args).toMatchObject({
      binding,
      skippedChapterIds: [99],
    });

    const timeline: string[] = [];
    const blockedNewWrite = withChapterDownloadWrite(55, undefined, async () => {
      timeline.push("new-write");
    });
    expect(timeline).toEqual([]);

    timeline.push("release-export");
    releaseExport();
    await exporting;
    await blockedNewWrite;
    expect(timeline).toEqual(["release-export", "new-write"]);

    activeBusyRelease();
    await activeBusyWrite;

    const applied = await applyUserStateCurrentSnapshot(binding, {
      version: 2,
      workspaceId: binding.workspaceId,
      epoch: binding.epoch,
      items: [],
    });
    expect(applied.changed).toBe(true);
  });

  it("routes rebind, snapshot reconciliation, and local retention commands through typed Rust IPC", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      switch (command) {
        case "db_user_state_rebind_workspace":
          return { value: null, effects: { userStateLedgerChanged: true } };
        case "db_user_state_reconcile_snapshot":
          return {
            value: { resumes: [{ novelId: 3, chapterId: null, anchor: null, openedAt: null }] },
            effects: { userStateLedgerChanged: true },
          };
        case "db_user_state_apply_local_retention":
          return { value: 4, effects: { userStateLedgerChanged: true } };
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    });

    await rebindUserStateWorkspace(binding, "reseed", { seedCutoffMs: 1_700_000_000_000, seedAllowed: true });
    expect(invoke).toHaveBeenCalledWith("db_user_state_rebind_workspace", {
      binding,
      mode: "reseed",
      seedCutoffMs: 1_700_000_000_000,
      seedAllowed: true,
    });

    const effects = await reconcileUserStateSnapshot(binding, {
      records: [],
      snapshotRevision: 9,
      seedAllowed: false,
      seedCutoffMs: null,
    });
    expect(effects.resumes).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith("db_user_state_reconcile_snapshot", {
      binding,
      records: [],
      snapshotRevision: 9,
      seedAllowed: false,
      seedCutoffMs: null,
      skippedChapterIds: [],
    });

    const affected = await applyLocalUserStateRetention({
      pruneNonLibraryDays: 90,
      stripTimestampsDays: 180,
      nowMs: 1_750_000_000_000,
    });
    expect(affected).toBe(4);
    expect(invoke).toHaveBeenCalledWith("db_user_state_apply_local_retention", {
      pruneNonLibraryDays: 90,
      stripTimestampsDays: 180,
      nowMs: 1_750_000_000_000,
    });
  });
});
