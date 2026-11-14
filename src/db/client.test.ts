import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ tauri: true }));
const invokeMock = vi.hoisted(() => vi.fn());
const events = vi.hoisted(() => ({
  listeners: new Set<(event: { payload: unknown }) => void>(),
}));

vi.mock("../lib/tauri-runtime", () => ({
  isTauriRuntime: () => runtime.tauri,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (_name: string, callback: (event: { payload: unknown }) => void) => {
      events.listeners.add(callback);
      return () => {
        events.listeners.delete(callback);
      };
    },
  ),
}));

async function loadClient() {
  vi.resetModules();
  return import("./client");
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.tauri = true;
  events.listeners.clear();
  invokeMock.mockImplementation(async (command: string) => {
    if (
      command === "db_source_renumber_list_journals" ||
      command === "db_novel_merge_list_storage_journals"
    ) {
      return [];
    }
    if (command === "db_work_metadata_restore_directories") {
      return { files: [], chapters: [] };
    }
    if (command === "db_startup_recover_work_metadata") {
      return {
        value: {
          recoveredWorks: 0,
          recoveredChapters: 0,
          totalWorks: 0,
          currentWork: null,
        },
        effects: {},
      };
    }
    if (command === "db_work_metadata_cancel_recovery") {
      return null;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
});

describe("initializeDatabaseSession", () => {
  it("skips IPC initialization outside Tauri runtime", async () => {
    runtime.tauri = false;
    const { initializeDatabaseSession } = await loadClient();

    await initializeDatabaseSession();

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("recovers session journals once across concurrent and repeated calls", async () => {
    const { initializeDatabaseSession } = await loadClient();

    await Promise.all([
      initializeDatabaseSession(),
      initializeDatabaseSession(),
    ]);
    await initializeDatabaseSession();

    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "db_startup_recover_work_metadata",
        { rebuild: false },
      );
    });
    expect(
      invokeMock.mock.calls.filter(
        ([cmd]) => cmd === "db_source_renumber_list_journals",
      ),
    ).toHaveLength(1);
    expect(
      invokeMock.mock.calls.filter(
        ([cmd]) => cmd === "db_novel_merge_list_storage_journals",
      ),
    ).toHaveLength(1);
    expect(
      invokeMock.mock.calls.filter(
        ([cmd]) => cmd === "db_work_metadata_restore_directories",
      ),
    ).toHaveLength(1);
  });

  it("resets session recovery state when initial journal recovery fails so retries succeed", async () => {
    let failOnce = true;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "db_source_renumber_list_journals") {
        if (failOnce) {
          failOnce = false;
          throw new Error("temporary startup failure");
        }
        return [];
      }
      if (command === "db_novel_merge_list_storage_journals") {
        return [];
      }
      if (command === "db_work_metadata_restore_directories") {
        return { files: [], chapters: [] };
      }
      if (command === "db_startup_recover_work_metadata") {
        return {
          value: {
            recoveredWorks: 0,
            recoveredChapters: 0,
            totalWorks: 0,
            currentWork: null,
          },
          effects: {},
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { initializeDatabaseSession } = await loadClient();

    await expect(initializeDatabaseSession()).rejects.toThrow(
      "temporary startup failure",
    );
    await expect(initializeDatabaseSession()).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "db_startup_recover_work_metadata",
        { rebuild: false },
      );
    });
  });

  it("cancels active work metadata recovery through Rust IPC", async () => {
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    invokeMock.mockImplementation(async (command: string) => {
      if (
        command === "db_source_renumber_list_journals" ||
        command === "db_novel_merge_list_storage_journals"
      ) {
        return [];
      }
      if (command === "db_work_metadata_restore_directories") {
        return { files: [], chapters: [] };
      }
      if (command === "db_startup_recover_work_metadata") {
        await recoveryGate;
        return {
          value: {
            recoveredWorks: 0,
            recoveredChapters: 0,
            totalWorks: 0,
            currentWork: null,
          },
          effects: {},
        };
      }
      if (command === "db_work_metadata_cancel_recovery") {
        return null;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { initializeDatabaseSession, cancelWorkMetadataRecovery } =
      await loadClient();
    const { useStorageRecoveryStore } = await import(
      "../store/storage-recovery"
    );

    await initializeDatabaseSession();
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "db_startup_recover_work_metadata",
        { rebuild: false },
      );
    });

    cancelWorkMetadataRecovery();
    expect(invokeMock).toHaveBeenCalledWith(
      "db_work_metadata_cancel_recovery",
    );
    expect(useStorageRecoveryStore.getState()).toMatchObject({
      status: "idle",
      progress: null,
      error: null,
    });

    releaseRecovery();
  });
});
