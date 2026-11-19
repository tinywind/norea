import { invokeDbMutation, invokeDbQuery } from "./ipc";
import { withGlobalChapterDownloadSnapshotReads } from "../lib/chapter-download-writes";
import {
  emitUserStateApplied,
  emitUserStateLedgerChanged,
} from "./user-state-core";
import {
  parsePortableReaderAnchor,
  parseUserStateOperation,
  type PortableReaderAnchor,
  type UserStateApplyEffects,
  type UserStateBinding,
  type UserStateConflict,
  type UserStateDeferred,
  type UserStateMergeResult,
  type UserStateOperation,
  type UserStateReadResponse,
  type UserStateRebindMode,
  type UserStateRecord,
} from "../lib/user-state/types";

export interface UserStateLedgerStatus {
  cursor: number;
  through: number | null;
  pending: number;
  conflicts: number;
  deferred: number;
  projectionPending: number;
  projectionFailed: number;
  lastSuccessAt: number | null;
  pausedAfterRestore: boolean;
}

export {
  subscribeUserStateApplied,
  subscribeUserStateChanges,
  subscribeUserStateLedgerChanges,
} from "./user-state-core";
export type { UserStateChangePriority } from "./user-state-core";

let activeServer: string | null = null;
let activeGeneration = 0;

const USER_STATE_BUSY_RETRIES = 3;
const USER_STATE_LOCAL_ACK_CHUNK = 128;
const USER_STATE_PROJECT_CHUNK = 256;
const USER_STATE_LOCAL_ACK_YIELD_MS = 0;
export const USER_STATE_OPERATION_RETENTION_SECS = 7 * 24 * 60 * 60;

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

export interface WorkCategoryLookup {
  pluginId: string;
  /** The source's work ID; empty when the work is known only by its path. */
  novelId: string;
  novelPath: string;
}

export interface WorkCategories {
  pluginId: string;
  novelPath: string;
  categories: string[];
}

const WORK_CATEGORY_LOOKUP_BATCH = 200;

/** Category names per work, from local library categories or the shared state received from `serverUrl`. */
export async function listUserWorkCategories(
  serverUrl: string,
  works: readonly WorkCategoryLookup[],
): Promise<WorkCategories[]> {
  const result: WorkCategories[] = [];
  for (let start = 0; start < works.length; start += WORK_CATEGORY_LOOKUP_BATCH) {
    result.push(...await invokeDbQuery<WorkCategories[]>("db_user_state_list_work_categories", {
      serverUrl,
      works: works.slice(start, start + WORK_CATEGORY_LOOKUP_BATCH),
      mode: "committed",
    }));
  }
  return result;
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
  options?: { seedAllowed?: boolean; seedCutoffMs?: number | null },
): Promise<void> {
  await invokeDbMutation("db_user_state_bind_workspace", {
    binding,
    ...(options?.seedAllowed !== undefined ? { seedAllowed: options.seedAllowed } : {}),
    ...(options?.seedCutoffMs !== undefined ? { seedCutoffMs: options.seedCutoffMs } : {}),
  });
}

export async function rebindUserStateWorkspace(
  binding: UserStateBinding,
  mode: UserStateRebindMode,
  options?: { headRevision?: number; seedCutoffMs?: number | null; seedAllowed?: boolean },
): Promise<void> {
  await invokeDbMutation("db_user_state_rebind_workspace", {
    binding,
    mode,
    ...(options?.headRevision !== undefined ? { headRevision: options.headRevision } : {}),
    ...(options?.seedCutoffMs !== undefined ? { seedCutoffMs: options.seedCutoffMs } : {}),
    ...(options?.seedAllowed !== undefined ? { seedAllowed: options.seedAllowed } : {}),
  });
}

export async function reconcileUserStateSnapshot(
  binding: UserStateBinding,
  input: {
    records: UserStateRecord[];
    snapshotRevision: number;
    seedAllowed?: boolean;
    seedCutoffMs?: number | null;
  },
): Promise<UserStateApplyEffects> {
  return withGlobalChapterDownloadSnapshotReads(skippedChapterIds =>
    invokeDbMutation<UserStateApplyEffects>("db_user_state_reconcile_snapshot", {
      binding,
      records: input.records,
      snapshotRevision: input.snapshotRevision,
      ...(input.seedAllowed !== undefined ? { seedAllowed: input.seedAllowed } : {}),
      ...(input.seedCutoffMs !== undefined ? { seedCutoffMs: input.seedCutoffMs } : {}),
      skippedChapterIds,
    }),
  );
}

export async function applyLocalUserStateRetention(options: {
  pruneNonLibraryDays?: number | null;
  stripTimestampsDays?: number | null;
  nowMs?: number;
}): Promise<number> {
  return invokeDbMutation<number>("db_user_state_apply_local_retention", {
    ...(options.pruneNonLibraryDays != null ? { pruneNonLibraryDays: options.pruneNonLibraryDays } : {}),
    ...(options.stripTimestampsDays != null ? { stripTimestampsDays: options.stripTimestampsDays } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  });
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

export async function materializePendingUserState(
  binding: UserStateBinding,
): Promise<UserStateApplyEffects> {
  const generation = activeGeneration;
  const allowed = () =>
    activeGeneration === generation &&
    (activeServer === null || activeServer === binding.serverUrl);
  if (!allowed()) return { resumes: [] };
  const resumes: UserStateApplyEffects["resumes"] = [];
  const failedEntityKeys = new Set<string>();
  let chunkIndex = 0;
  for (;;) {
    if (!allowed()) break;
    if (chunkIndex > 0) await yieldUserStateAck();
    if (!allowed()) break;
    const skipEntityKeys = failedEntityKeys.size > 0 ? [...failedEntityKeys] : undefined;
    const chunk = await retryUserStateExclusive(() =>
      withGlobalChapterDownloadSnapshotReads(skippedChapterIds =>
        invokeDbMutation<UserStateApplyEffects>("db_user_state_project_pending", {
          binding,
          skippedChapterIds,
          limit: USER_STATE_PROJECT_CHUNK,
          ...(skipEntityKeys ? { skipEntityKeys } : {}),
        }),
      ),
    );
    resumes.push(...chunk.resumes);
    for (const key of chunk.failedEntityKeys ?? []) {
      failedEntityKeys.add(key);
    }
    chunkIndex += 1;
    if (!chunk.hasMore) break;
  }
  const effects: UserStateApplyEffects = { resumes };
  emitUserStateApplied(effects);
  emitUserStateLedgerChanged();
  return effects;
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

export async function pruneUserStateOperations(
  binding: UserStateBinding,
  olderThanSecs = USER_STATE_OPERATION_RETENTION_SECS,
): Promise<number> {
  if (!Number.isSafeInteger(olderThanSecs) || olderThanSecs < 0) {
    throw new Error("Operation retention age must be a non-negative number of seconds.");
  }
  return invokeDbMutation<number>("db_user_state_prune_operations", {
    binding,
    olderThanSecs,
  });
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
