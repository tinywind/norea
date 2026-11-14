import { invokeDbMutation, invokeDbQuery } from "./ipc";
import { withGlobalChapterDownloadSnapshotReads } from "../lib/chapter-download-writes";
import {
  emitUserStateApplied,
  emitUserStateLedgerChanged,
} from "./user-state-core";
import type { UserStateLedgerStatus } from "./user-state-ledger";
import {
  parsePortableReaderAnchor,
  parseUserStateOperation,
  parseUserStateRecord,
  type PortableReaderAnchor,
  type UserStateApplyEffects,
  type UserStateBinding,
  type UserStateConflict,
  type UserStateDeferred,
  type UserStateMergeResult,
  type UserStateOperation,
  type UserStateReadResponse,
  type UserStateRecord,
} from "../lib/user-state/types";

export {
  subscribeUserStateApplied,
  subscribeUserStateChanges,
  subscribeUserStateLedgerChanges,
} from "./user-state-core";
export type { UserStateLedgerStatus } from "./user-state-ledger";
export type { UserStateChangePriority } from "./user-state-core";
export { deferUserStateForNovelInDb } from "./user-state-materialize";

let activeServer: string | null = null;
let activeGeneration = 0;

const USER_STATE_BUSY_RETRIES = 3;
const USER_STATE_LOCAL_ACK_CHUNK = 128;
const USER_STATE_LOCAL_ACK_YIELD_MS = 0;
const USER_STATE_PROJECTION_CHUNK = 16;

function isUserStateDatabaseBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:code:\s*(?:5|6)\b|database is (?:locked|busy)|SQLITE_(?:BUSY|LOCKED))/i.test(
    message,
  );
}

async function retryUserStateExclusive<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isUserStateDatabaseBusy(error) || attempt >= USER_STATE_BUSY_RETRIES) {
        throw error;
      }
      await new Promise<void>(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

export function setUserStateActiveServer(serverUrl: string | null): void {
  if (activeServer !== serverUrl) {
    activeServer = serverUrl;
    activeGeneration++;
  }
}

export async function getUserStateBinding(
  serverUrl?: string,
): Promise<UserStateBinding | null> {
  const target = serverUrl ?? activeServer;
  if (!target) return null;
  return invokeDbQuery<UserStateBinding | null>("db_user_state_get_binding", {
    serverUrl: target,
  });
}

export async function bindUserStateWorkspace(
  binding: UserStateBinding,
): Promise<void> {
  await invokeDbMutation("db_user_state_bind_workspace", { binding });
}

export async function prepareUserStateOperations(
  binding: UserStateBinding,
  limits?: { limit?: number; maxBytes?: number; allowOpaqueIdentity?: boolean },
): Promise<UserStateOperation[]> {
  const raw = await withGlobalChapterDownloadSnapshotReads(skippedChapterIds =>
    invokeDbMutation<UserStateOperation[]>("db_user_state_prepare_operations", {
      binding,
      limits: {
        ...limits,
        skippedChapterIds,
      },
    }),
  );
  return raw.map(parseUserStateOperation);
}

export async function getUserStateLedgerStatus(
  binding?: UserStateBinding | null,
): Promise<UserStateLedgerStatus> {
  const current =
    binding === undefined ? await getUserStateBinding() : binding;
  return invokeDbQuery<UserStateLedgerStatus>(
    "db_user_state_get_ledger_status",
    { binding: current },
  );
}

export async function listUserStateConflicts(
  binding: UserStateBinding,
): Promise<UserStateConflict[]> {
  return invokeDbQuery<UserStateConflict[]>("db_user_state_list_conflicts", {
    binding,
  });
}

export async function listUserStateDeferred(
  binding: UserStateBinding,
): Promise<UserStateDeferred[]> {
  return invokeDbQuery<UserStateDeferred[]>("db_user_state_list_deferred", {
    binding,
  });
}

async function yieldUserStateAck(): Promise<void> {
  await new Promise<void>(resolve =>
    setTimeout(resolve, USER_STATE_LOCAL_ACK_YIELD_MS),
  );
}

async function yieldUserStateProjection(): Promise<void> {
  // Projection is a convenience view over durable user-state records. Yield a
  // frame between small write transactions so library queries, cover reads and
  // other native bridge work stay responsive while a large history catches up.
  await new Promise<void>(resolve => setTimeout(resolve, 16));
}

async function projectUserStateRecords(
  binding: UserStateBinding,
  records: readonly UserStateRecord[],
): Promise<UserStateApplyEffects> {
  if (!records.length) return { resumes: [] };
  const effects: UserStateApplyEffects = { resumes: [] };
  for (let start = 0; start < records.length; start += USER_STATE_PROJECTION_CHUNK) {
    await yieldUserStateProjection();
    const chunk = records.slice(start, start + USER_STATE_PROJECTION_CHUNK);
    const next = await withGlobalChapterDownloadSnapshotReads(skippedChapterIds =>
      invokeDbMutation<UserStateApplyEffects>(
        "db_user_state_project_records_chunk",
        {
          binding,
          records: chunk,
          skippedChapterIds,
        },
      ),
    );
    effects.resumes.push(...next.resumes);
  }
  emitUserStateApplied(effects);
  emitUserStateLedgerChanged();
  return effects;
}

export async function materializePendingUserState(
  binding: UserStateBinding,
): Promise<UserStateApplyEffects> {
  const generation = activeGeneration;
  const allowed = () =>
    activeGeneration === generation &&
    (activeServer === null || activeServer === binding.serverUrl);
  if (!allowed()) return { resumes: [] };
  const rows = await invokeDbQuery<UserStateRecord[]>(
    "db_user_state_list_pending_projection_records",
    { binding },
  );
  if (!allowed()) return { resumes: [] };
  return projectUserStateRecords(binding, rows.map(parseUserStateRecord));
}

export async function applyUserStateReadPage(
  binding: UserStateBinding,
  page: UserStateReadResponse,
): Promise<UserStateApplyEffects> {
  return invokeDbMutation<UserStateApplyEffects>(
    "db_user_state_apply_read_page",
    { binding, page },
  );
}

export async function acknowledgeUserStateOperations(
  binding: UserStateBinding,
  results: UserStateMergeResult[],
): Promise<UserStateApplyEffects> {
  // Network merge requests remain byte-bounded bulk messages. Only local receipt
  // application is chunked so a large replay cannot monopolize the writer pool
  // for tens of seconds and starve concurrent UI/cover reads.
  //
  // Server receipts are immutable and all ACK writes are idempotent/monotonic, so
  // a crash between chunks is safe: the next synchronization replays the exact
  // receipts and resumes at the remaining local progress rows.
  if (!results.length) {
    emitUserStateLedgerChanged();
    return { resumes: [] };
  }
  for (let start = 0; start < results.length; start += USER_STATE_LOCAL_ACK_CHUNK) {
    if (start > 0) await yieldUserStateAck();
    const batch = results.slice(start, start + USER_STATE_LOCAL_ACK_CHUNK);
    await retryUserStateExclusive(() =>
      invokeDbMutation<UserStateApplyEffects>(
        "db_user_state_acknowledge_operations",
        { binding, results: batch },
      ),
    );
  }
  return { resumes: [] };
}

export async function resolveUserStateLedgerConflict(
  binding: UserStateBinding,
  input: {
    id: string;
    version: string;
    choice: "local" | "shared";
    categoryName?: string;
  },
): Promise<UserStateApplyEffects> {
  return invokeDbMutation<UserStateApplyEffects>(
    "db_user_state_resolve_conflict",
    { binding, input },
  );
}

export async function recordUserResume(
  chapterId: number,
  anchor: PortableReaderAnchor | null,
  openedAt: number,
): Promise<void> {
  if (!Number.isSafeInteger(openedAt) || openedAt < 0) {
    throw new Error("Reader opened time must be in whole seconds.");
  }
  const portable = anchor === null ? null : parsePortableReaderAnchor(anchor);
  await invokeDbMutation("db_user_state_record_resume", {
    chapterId,
    anchor: portable,
    openedAt,
  });
}

export async function recordUserResumeCleared(novelId: number): Promise<void> {
  await invokeDbMutation("db_user_state_record_resume_cleared", { novelId });
}

export async function applyDeferredUserState(): Promise<void> {
  const current = await import("./user-state-current");
  if (current.isUserStateCurrentMode()) {
    if (!(await getUserStateRestorePaused())) {
      await current.applyDeferredUserStateCurrent();
    }
    return;
  }
  const server = activeServer;
  const generation = activeGeneration;
  if (server === null) return;
  const binding = await getUserStateBinding(server);
  if (!binding || generation !== activeGeneration || server !== activeServer) {
    return;
  }
  const paused = await getUserStateRestorePaused();
  if (!paused && generation === activeGeneration && server === activeServer) {
    await materializePendingUserState(binding);
  }
}

export async function getUserStateRestorePaused(): Promise<boolean> {
  return invokeDbQuery<boolean>("db_user_state_get_restore_paused");
}

export async function assertUserStateAvailable(): Promise<void> {
  await invokeDbQuery<void>("db_user_state_assert_available");
}

export async function resumeUserStateAfterRestore(): Promise<void> {
  await invokeDbMutation("db_user_state_resume_after_restore");
}
