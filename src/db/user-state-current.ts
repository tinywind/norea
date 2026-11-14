import { invoke } from "@tauri-apps/api/core";
import { invokeDbMutation, invokeDbQuery } from "./ipc";
import { runContentStorageOperation } from "../lib/content-sync/storage-operation";
import { withGlobalChapterDownloadSnapshotReads } from "../lib/chapter-download-writes";
import { isTauriRuntime } from "../lib/tauri-runtime";
import {
  emitUserStateApplied,
  installUserStateDeferredNovelRecorder,
  requestUserStateDeferredApply,
  type UserStateDb,
} from "./user-state-core";
import { setUserStateActiveServer } from "./user-state";
import {
  parseUserStateCurrentSnapshot,
  type UserStateCurrentApplyResult,
  type UserStateCurrentSnapshot,
  type UserStateCurrentStatus,
} from "../lib/user-state/current-types";
import type { UserStateBinding } from "../lib/user-state/types";

interface CurrentSnapshotRetryInput {
  workKeys: string[];
  previousMissing: string[];
}

interface DeferredCurrentRetryPlan {
  binding: UserStateBinding;
  snapshot: unknown;
  missingKeys: string[];
  workKeys: string[];
}

let currentServer: string | null = null;
let generation = 0;
let currentMode = false;
const pendingNovelIds = new Set<number>();
let currentApplyTail: Promise<void> = Promise.resolve();

async function serializeCurrentApply<T>(run: () => Promise<T>): Promise<T> {
  const previous = currentApplyTail;
  let release: () => void = () => undefined;
  currentApplyTail = new Promise<void>(resolve => {
    release = resolve;
  });
  await previous;
  try {
    return await run();
  } finally {
    release();
  }
}

export function isUserStateCurrentMode(): boolean {
  return currentMode;
}

export function setUserStateCurrentServer(serverUrl: string | null): void {
  currentMode = serverUrl !== null;
  if (isTauriRuntime()) {
    void invoke("db_user_state_set_current_mode", { enabled: currentMode }).catch(
      error => {
        console.warn("[user-state] failed to sync current mode with host", error);
      },
    );
  }
  if (currentMode) setUserStateActiveServer(null);
  if (serverUrl !== currentServer) {
    currentServer = serverUrl;
    generation++;
    pendingNovelIds.clear();
  }
}

export async function bindUserStateCurrentWorkspace(
  binding: UserStateBinding,
): Promise<void> {
  await invokeDbMutation("db_user_state_bind_current_workspace", { binding });
}

export async function getUserStateCurrentStatus(
  serverUrl?: string,
): Promise<UserStateCurrentStatus> {
  return invokeDbQuery<UserStateCurrentStatus>(
    "db_user_state_get_current_status",
    { serverUrl: serverUrl ?? currentServer },
  );
}

export async function exportUserStateCurrentSnapshot(
  binding: UserStateBinding,
): Promise<UserStateCurrentSnapshot> {
  return withGlobalChapterDownloadSnapshotReads(skippedChapterIds =>
    runContentStorageOperation(async () =>
      parseUserStateCurrentSnapshot(
        await invokeDbMutation<UserStateCurrentSnapshot>(
          "db_user_state_export_current_snapshot",
          {
            binding,
            skippedChapterIds,
          },
        ),
      ),
    ),
  );
}

async function applyCurrentSnapshot(
  binding: UserStateBinding,
  snapshot: UserStateCurrentSnapshot,
  retry?: CurrentSnapshotRetryInput,
): Promise<UserStateCurrentApplyResult> {
  const captured = generation;
  const allowed = () =>
    captured === generation &&
    (currentServer === null || currentServer === binding.serverUrl);
  const check = () => {
    if (!allowed()) {
      throw new Error(
        "The current personal state workspace changed during synchronization.",
      );
    }
  };
  if (
    snapshot.workspaceId !== binding.workspaceId ||
    snapshot.epoch !== binding.epoch
  ) {
    throw new Error(
      "The current personal state workspace does not match this device.",
    );
  }
  check();
  // Take the file barrier before IPC; nonblocking read leases also cover source/media writes through commit.
  const result = await withGlobalChapterDownloadSnapshotReads(skippedChapterIds =>
    runContentStorageOperation(() => {
      check();
      return invokeDbMutation<UserStateCurrentApplyResult>(
        "db_user_state_apply_current_snapshot",
        {
          binding,
          snapshot,
          retry: retry ?? null,
          skippedChapterIds,
        },
      );
    }),
  );
  check();
  if (result.changed) emitUserStateApplied(result);
  return result;
}

export async function applyUserStateCurrentSnapshot(
  binding: UserStateBinding,
  raw: UserStateCurrentSnapshot,
): Promise<UserStateCurrentApplyResult> {
  const snapshot = parseUserStateCurrentSnapshot(raw);
  const captured = generation;
  return serializeCurrentApply(() => {
    if (captured !== generation) {
      throw new Error(
        "The current personal state workspace changed during synchronization.",
      );
    }
    return applyCurrentSnapshot(binding, snapshot);
  });
}

/** A metadata commit retries only the current snapshot entries for its exact work. */
export function deferUserStateCurrentForNovelInDb(
  db: UserStateDb,
  novelId: number,
): void {
  pendingNovelIds.add(novelId);
  requestUserStateDeferredApply(db);
}

export function recordDeferredUserStateCurrentNovelIds(
  novelIds: readonly number[],
): void {
  if (!currentMode) return;
  for (const novelId of novelIds) {
    pendingNovelIds.add(novelId);
  }
}

installUserStateDeferredNovelRecorder(recordDeferredUserStateCurrentNovelIds);

export async function applyDeferredUserStateCurrent(): Promise<void> {
  const server = currentServer;
  const captured = generation;
  if (!server || !pendingNovelIds.size) return;
  await serializeCurrentApply(async () => {
    if (generation !== captured || currentServer !== server) return;
    while (
      pendingNovelIds.size &&
      generation === captured &&
      currentServer === server
    ) {
      const ids = [...pendingNovelIds];
      pendingNovelIds.clear();
      const plan = await invokeDbQuery<DeferredCurrentRetryPlan | null>(
        "db_user_state_prepare_deferred_current_retry",
        {
          serverUrl: server,
          novelIds: ids,
        },
      );
      if (!plan) return;
      const snapshot = parseUserStateCurrentSnapshot(plan.snapshot);
      if (plan.workKeys.length) {
        await applyCurrentSnapshot(plan.binding, snapshot, {
          workKeys: plan.workKeys,
          previousMissing: plan.missingKeys,
        });
      }
    }
  });
}
