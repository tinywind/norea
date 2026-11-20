import {
  acknowledgeUserStateOperations, applyLocalUserStateRetention, applyUserStateReadPage, assertUserStateAvailable,
  bindUserStateWorkspace, getUserStateBinding, getUserStateLedgerStatus, listUserStateConflicts,
  materializePendingUserState, prepareUserStateOperations, pruneUserStateOperations,
  rebindUserStateWorkspace as rebindUserStateWorkspaceInDb, reconcileUserStateSnapshot,
  resolveUserStateLedgerConflict, resumeUserStateAfterRestore as resumeRestoredLedger, setUserStateActiveServer,
} from "../../db/user-state";
import { waitForUserStateDeferredApply } from "../../db/user-state-core";
import { useContentSyncStore } from "../../store/content-sync";
import { useUserStateStore } from "../../store/user-state";
import { isAbortError, requestAbortedError } from "../abort";
import { isAppActive } from "../app-lifecycle";
import {
  beginUserStateSyncRun,
  clearBackgroundSyncFailure,
  recordBackgroundSyncFailure,
} from "../tasks/sync-runtime";
import { serializeUserStateSynchronization, withUserStateRebind, withUserStateRestore } from "./maintenance";
import {
  ContentServerError, contentServerFetch, contentServerRequest, normalizeContentServerUrl, withContentServerLookup,
} from "../content-sync/client";
import { forgetContentDeviceRegistration, registerContentDevice, type ContentCapabilities } from "../content-sync/device";
import {
  canonicalUserStateJson, parseUserStateMergeResponse, parseUserStateOperation, parseUserStateReadResponse,
  parseUserStateRetentionResponse, parseUserStateSnapshotResponse, parseUserStateWorkspace, userStateEntityKey,
  userStateJsonBytes, UserStateProtocolError, USER_STATE_CLIENT_BATCH_BYTES, USER_STATE_LEGACY_MAX_BATCH,
  USER_STATE_MAX_BYTES, USER_STATE_VERSION, type ResolveUserStateConflictInput, type UserStateBinding,
  type UserStateMergeResponse, type UserStateOperation, type UserStateReadResponse, type UserStateRebindMode,
  type UserStateRecord, type UserStateRetentionResponse, type UserStateStatus, type UserStateWorkspace,
} from "./types";

interface Synchronization {
  promise: Promise<void>;
  controller: AbortController;
  unconditionalWaiters: number;
  signalWaiters: number;
}
const running = new Map<string, Synchronization>();

function selectedServer(): string {
  const value = useContentSyncStore.getState().serverUrl;
  return value ? normalizeContentServerUrl(value) : "";
}
function assertWorkspace(response: UserStateWorkspace, binding: UserStateBinding): void {
  if (response.workspaceId !== binding.workspaceId || response.epoch !== binding.epoch) {
    throw new UserStateProtocolError("the server workspace changed; pending changes were retained");
  }
}

/** Bound the decoded body as well as the declared length, including chunked responses. */
export async function readUserStateResponse(response: Response, maxBytes = USER_STATE_MAX_BYTES): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel();
    throw new UserStateProtocolError("response exceeds the size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new UserStateProtocolError("missing response body");
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new UserStateProtocolError("response exceeds the size limit");
      }
      parts.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let position = 0;
  for (const part of parts) { bytes.set(part, position); position += part.byteLength; }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new UserStateProtocolError("response is not valid JSON");
  }
}

async function request(serverUrl: string, path: string, token: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  if (body !== undefined && userStateJsonBytes(body) > USER_STATE_CLIENT_BATCH_BYTES) {
    throw new UserStateProtocolError("request exceeds the client batch limit");
  }
  return withContentServerLookup(async deadline => {
    const response = await contentServerFetch(serverUrl + "/api/v1" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: deadline, connectTimeout: 10_000, maxRedirections: 0,
    });
    if (!response.ok) {
      if (response.status === 401) forgetContentDeviceRegistration(serverUrl, token);
      let serverMessage: string | undefined;
      let serverCode: string | undefined;
      try {
        const payload = await readUserStateResponse(response, 64 * 1024);
        if (payload && typeof payload === "object") {
          if ("message" in payload && typeof payload.message === "string" && payload.message.trim()) {
            serverMessage = payload.message.trim();
          }
          if ("code" in payload && typeof payload.code === "string" && payload.code.trim()) {
            serverCode = payload.code.trim();
          }
        }
      } catch {
        await response.body?.cancel().catch(() => undefined);
      }
      throw new ContentServerError(response.status, serverMessage ?? (response.status === 409
        ? "User state: the workspace or retained cursor changed. Pending changes were retained."
        : undefined), serverCode);
    }
    const result = await readUserStateResponse(response);
    deadline.throwIfAborted();
    return result;
  }, 60, signal);
}

export function validateUserStatePage(
  page: UserStateReadResponse, binding: UserStateBinding, after: number, through: number,
): void {
  assertWorkspace(page, binding);
  if (page.through !== through || page.nextCursor < after ||
    page.records.some(record => record.revision <= after) ||
    (page.hasMore && page.nextCursor === after)) {
    throw new UserStateProtocolError("read page does not match the requested cursor");
  }
}

/** A receipt must acknowledge exactly the immutable submitted operations. */
export function validateUserStateAcknowledgements(
  response: UserStateMergeResponse, binding: UserStateBinding, operations: readonly UserStateOperation[],
): void {
  assertWorkspace(response, binding);
  const submitted = new Map(operations.map(operation => [operation.operationId, operation]));
  if (submitted.size !== operations.length || response.results.length !== operations.length) {
    throw new UserStateProtocolError("incomplete operation acknowledgements");
  }
  for (const result of response.results) {
    const operation = submitted.get(result.operationId);
    if (!operation) throw new UserStateProtocolError("acknowledgement belongs to another operation");
    submitted.delete(result.operationId);
    let entity = operation.entity;
    if (result.categoryAlias) {
      if ((entity.kind !== "category" && entity.kind !== "membership") || entity.categoryId !== result.categoryAlias.from) {
        throw new UserStateProtocolError("category alias does not belong to the submitted change");
      }
      entity = { ...entity, categoryId: result.categoryAlias.to };
    }
    if (result.current && userStateEntityKey(result.current.entity) !== userStateEntityKey(entity)) {
      throw new UserStateProtocolError("acknowledgement belongs to another entity");
    }
    if (result.status === "applied" && result.current?.operationId !== operation.operationId) {
      throw new UserStateProtocolError("applied receipt has another operation ID");
    }
    if ((result.status === "applied" || result.status === "unchanged") &&
      canonicalUserStateJson(result.current?.value) !== canonicalUserStateJson(operation.value)) {
      throw new UserStateProtocolError("acknowledged value differs from the submitted change");
    }
    if (result.status === "applied" || result.status === "unchanged") {
      const originalProof = "chapter" in entity ? entity.chapter.compositionEntryId : undefined;
      const sharedEntity = result.current?.entity;
      const sharedProof = sharedEntity && "chapter" in sharedEntity ? sharedEntity.chapter.compositionEntryId : undefined;
      if (originalProof && sharedProof && originalProof !== sharedProof) {
        throw new UserStateProtocolError("acknowledged chapter ownership differs from the submitted change");
      }
    }
    if (result.status === "seed-skipped" && !operation.seed) {
      throw new UserStateProtocolError("an explicit edit cannot be acknowledged as a seed");
    }
    if (result.status === "aliased" && (entity.kind !== "category" || operation.baseRevision !== 0 ||
      !("name" in operation.value) || !result.current || !("name" in result.current.value) ||
      operation.value.name !== result.current.value.name || operation.value.deleted || result.current.value.deleted)) {
      throw new UserStateProtocolError("category creation alias is inconsistent");
    }
  }
}

/** True when the configured server has at least one sendable local change waiting to upload. */
export async function hasSendableUserStateChanges(serverUrl = selectedServer()): Promise<boolean> {
  const normalized = serverUrl ? normalizeContentServerUrl(serverUrl) : "";
  if (!normalized) return false;
  const store = useUserStateStore.getState();
  if (
    store.enabledByServer[normalized] !== true ||
    store.runtimeByServer[normalized]?.epochMismatch ||
    store.runtimeByServer[normalized]?.blocked
  ) {
    return false;
  }
  const binding = await getUserStateBinding(normalized);
  const status = await getUserStateLedgerStatus(binding ?? null);
  if (status.pausedAfterRestore) return false;
  const sendable =
    status.sendablePending ??
    Math.max(0, status.pending - status.conflicts - status.deferred);
  return sendable > 0;
}

/** This status query reads only the local ledger; opening settings never publishes data. */
export async function getUserStateStatus(): Promise<UserStateStatus> {
  const serverUrl = selectedServer();
  const binding = serverUrl ? await getUserStateBinding(serverUrl) : null;
  const status = await getUserStateLedgerStatus(binding ?? null);
  const conflicts = binding ? await listUserStateConflicts(binding) : [];
  const store = useUserStateStore.getState();
  const runtimeMismatch = serverUrl ? store.runtimeByServer[serverUrl]?.epochMismatch : undefined;
  const epochMismatch =
    binding &&
    runtimeMismatch &&
    runtimeMismatch.localWorkspaceId === binding.workspaceId &&
    runtimeMismatch.localEpoch === binding.epoch
      ? runtimeMismatch
      : undefined;
  const retentionStatus = serverUrl ? store.retentionStatusByServer?.[serverUrl] : undefined;
  return {
    workspaceId: binding?.workspaceId ?? null, epoch: binding?.epoch ?? null,
    pending: status.pending, conflicts,
    projectionPending: status.projectionPending, projectionFailed: status.projectionFailed,
    lastSuccessAt: status.lastSuccessAt, pausedAfterRestore: status.pausedAfterRestore === true,
    ...(epochMismatch ? { epochMismatch } : {}),
    ...(retentionStatus ? { seedAllowed: retentionStatus.seedAllowed, seedCutoffAt: retentionStatus.seedCutoffAt } : {}),
  };
}

function recordEpochMismatch(
  serverUrl: string,
  localBinding: UserStateBinding,
  serverWorkspace: UserStateWorkspace,
): void {
  useUserStateStore.getState().setEpochMismatch(serverUrl, {
    serverUrl,
    localWorkspaceId: localBinding.workspaceId,
    localEpoch: localBinding.epoch,
    serverWorkspaceId: serverWorkspace.workspaceId,
    serverEpoch: serverWorkspace.epoch,
    headRevision: serverWorkspace.headRevision,
    detectedAt: Date.now(),
  });
}

async function runSynchronization(serverUrl: string, controller: AbortController): Promise<void> {
  const signal = controller.signal;
  const check = () => {
    signal.throwIfAborted();
    if (selectedServer() !== serverUrl) throw requestAbortedError();
  };
  const unsubscribe = useContentSyncStore.subscribe((state, previous) => {
    if (state.serverUrl !== previous.serverUrl) controller.abort(requestAbortedError());
  });
  const endSyncRun = beginUserStateSyncRun();
  setUserStateActiveServer(serverUrl);
  useUserStateStore.getState().setRuntime(serverUrl, "syncing");
  try {
    check();
    await assertUserStateAvailable();
    check();
    const capabilities = await contentServerRequest<ContentCapabilities>(serverUrl, "/capabilities", undefined, "GET", undefined, signal);
    check();
    if (capabilities.userStateVersion !== USER_STATE_VERSION) {
      throw new Error("This content server does not support shared user changes. Update the server before sharing.");
    }
    const bulk = capabilities.userStateBulkVersion === 1;
    const opaqueIdentity = capabilities.userStateOpaqueIdentityVersion === 1;
    const retentionSupported = capabilities.userStateRetentionVersion === 1;
    const token = await registerContentDevice(serverUrl, useContentSyncStore.getState().deviceName, signal);
    check();
    const existingBinding = await getUserStateBinding(serverUrl);
    check();
    const workspace = parseUserStateWorkspace(await request(serverUrl, "/user-state", token, signal));
    check();
    const binding: UserStateBinding = { serverUrl, workspaceId: workspace.workspaceId, epoch: workspace.epoch };
    if (existingBinding && (existingBinding.workspaceId !== workspace.workspaceId || existingBinding.epoch !== workspace.epoch)) {
      recordEpochMismatch(serverUrl, existingBinding, workspace);
      throw new UserStateProtocolError("the server workspace or epoch changed; pending changes were retained");
    }
    useUserStateStore.getState().setEpochMismatch(serverUrl, null);
    let observedHead = workspace.headRevision;
    let retention: UserStateRetentionResponse | null = null;

    const assertActiveWorkspace = (response: UserStateWorkspace): void => {
      if (response.workspaceId !== binding.workspaceId || response.epoch !== binding.epoch) {
        recordEpochMismatch(serverUrl, binding, response);
        throw new UserStateProtocolError("the server workspace changed; pending changes were retained");
      }
    };

    const probe409Mismatch = async (error: unknown): Promise<never> => {
      if (error instanceof ContentServerError && error.status === 409) {
        try {
          check();
          const probed = parseUserStateWorkspace(await request(serverUrl, "/user-state", token, signal));
          if (probed.workspaceId !== binding.workspaceId || probed.epoch !== binding.epoch) {
            recordEpochMismatch(serverUrl, binding, probed);
          }
        } catch {
          // Best-effort probe must never mask the original 409 error.
        }
      }
      throw error;
    };

    if (retentionSupported) {
      try {
        retention = parseUserStateRetentionResponse(await request(serverUrl, "/user-state/retention", token, signal));
      } catch (error) {
        await probe409Mismatch(error);
      }
      check();
      assertActiveWorkspace(retention!);
      observedHead = Math.max(observedHead, retention!.headRevision);
      useUserStateStore.getState().setRetentionStatus?.(serverUrl, {
        seedAllowed: retention!.seedAllowed,
        seedCutoffAt: retention!.seedCutoffAt,
      });
    }

    await (retention
      ? bindUserStateWorkspace(binding, { seedAllowed: retention.seedAllowed, seedCutoffMs: retention.seedCutoffAt })
      : bindUserStateWorkspace(binding));
    check();

    const MAX_SNAPSHOT_RETRIES = 5;
    let snapshotAttempts = 0;

    async function reconcileFromSnapshot(): Promise<number> {
      const collected: UserStateRecord[] = [];
      let afterEntityKey: string | null = null;
      let snapshotRevision: number | null = null;
      let latestSeedAllowed = retention?.seedAllowed ?? true;
      let latestSeedCutoffMs = retention?.seedCutoffAt ?? null;
      for (;;) {
        check();
        let page;
        try {
          page = parseUserStateSnapshotResponse(
            await request(serverUrl, "/user-state/snapshot", token, signal, {
              workspaceId: binding.workspaceId,
              epoch: binding.epoch,
              ...(afterEntityKey !== null ? { afterEntityKey } : {}),
            }),
          );
        } catch (error) {
          await probe409Mismatch(error);
        }
        check();
        assertActiveWorkspace(page!);
        snapshotRevision = snapshotRevision === null
          ? page!.snapshotRevision
          : Math.min(snapshotRevision, page!.snapshotRevision);
        observedHead = Math.max(observedHead, page!.headRevision, page!.snapshotRevision);
        latestSeedAllowed = page!.seedAllowed;
        latestSeedCutoffMs = page!.seedCutoffAt;
        collected.push(...page!.records);
        if (!page!.hasMore) break;
        afterEntityKey = page!.nextEntityKey;
      }
      await reconcileUserStateSnapshot(binding, {
        records: collected,
        snapshotRevision: snapshotRevision ?? 0,
        seedAllowed: latestSeedAllowed,
        seedCutoffMs: latestSeedCutoffMs,
      });
      check();
      useUserStateStore.getState().setRetentionStatus?.(serverUrl, {
        seedAllowed: latestSeedAllowed,
        seedCutoffAt: latestSeedCutoffMs,
      });
      const latestWorkspace = parseUserStateWorkspace(await request(serverUrl, "/user-state", token, signal));
      check();
      assertActiveWorkspace(latestWorkspace);
      observedHead = Math.max(observedHead, latestWorkspace.headRevision);
      if (retention) {
        retention = {
          ...retention,
          headRevision: observedHead,
          compactedThrough: Math.max(retention.compactedThrough, snapshotRevision ?? 0),
          seedAllowed: latestSeedAllowed,
          seedCutoffAt: latestSeedCutoffMs,
        };
      }
      return observedHead;
    }

    async function pullThrough(initialTarget: number): Promise<void> {
      let target = initialTarget;
      for (;;) {
        const status = await getUserStateLedgerStatus(binding);
        check();
        if (status.cursor === target && status.through === null) return;
        if (status.cursor > target || (status.through !== null && status.through > target)) {
          throw new UserStateProtocolError("the retained cursor is ahead of this server; it was not reset");
        }
        if (retentionSupported && retention !== null && status.cursor < retention.compactedThrough) {
          snapshotAttempts += 1;
          if (snapshotAttempts > MAX_SNAPSHOT_RETRIES) {
            throw new UserStateProtocolError("snapshot reconciliation exceeded retry limit");
          }
          target = await reconcileFromSnapshot();
          continue;
        }
        const through = status.through ?? target;
        try {
          const page = parseUserStateReadResponse(await request(serverUrl, "/user-state/read", token, signal, {
            workspaceId: binding.workspaceId, epoch: binding.epoch, after: status.cursor, through,
            ...(bulk ? {} : { limit: USER_STATE_LEGACY_MAX_BATCH }),
          }));
          check();
          assertActiveWorkspace(page);
          validateUserStatePage(page, binding, status.cursor, through);
          observedHead = Math.max(observedHead, page.headRevision);
          await applyUserStateReadPage(binding, page);
          check();
          if (!page.hasMore && page.nextCursor === target) return;
        } catch (error) {
          if (
            retentionSupported &&
            error instanceof ContentServerError &&
            error.status === 410 &&
            error.serverCode === "cursor-compacted"
          ) {
            snapshotAttempts += 1;
            if (snapshotAttempts > MAX_SNAPSHOT_RETRIES) {
              throw new UserStateProtocolError("snapshot reconciliation exceeded retry limit");
            }
            target = await reconcileFromSnapshot();
            continue;
          }
          await probe409Mismatch(error);
        }
      }
    }

    async function sendOperations(operations: UserStateOperation[]): Promise<void> {
      let response: UserStateMergeResponse;
      try {
        response = parseUserStateMergeResponse(await request(serverUrl, "/user-state/merge", token, signal, {
          workspaceId: binding.workspaceId, epoch: binding.epoch, operations,
        }));
      } catch (error) {
        check();
        // A small request can still return several large retained documents (for example
        // seed receipts). The server rolls back an oversized response; exact immutable
        // sub-batches are safe.
        if (error instanceof ContentServerError && error.status === 413 && operations.length > 1) {
          const middle = Math.ceil(operations.length / 2);
          await sendOperations(operations.slice(0, middle));
          await sendOperations(operations.slice(middle));
          return;
        }
        await probe409Mismatch(error);
      }
      check();
      assertActiveWorkspace(response!);
      validateUserStateAcknowledgements(response!, binding, operations);
      if (response!.headRevision < observedHead) throw new UserStateProtocolError("server revision moved backwards; pending changes were retained");
      observedHead = response!.headRevision;
      await acknowledgeUserStateOperations(binding, response!.results);
      check();
      // This also receives deletion cascades and other changes committed before this receipt.
      await pullThrough(response!.headRevision);
      check();
    }

    await pullThrough(observedHead);
    // The received ledger is durable before its convenience tables are updated.
    // Drain applicable projections before any queued local edit is published.
    await waitForUserStateDeferredApply();
    check();
    let projection = await getUserStateLedgerStatus(binding);
    if (projection.projectionPending || projection.projectionFailed) {
      // A previous process may have stopped after saving the pull cursor but
      // before running its deferred projection. Recover it before any upload.
      await materializePendingUserState(binding);
      check();
      projection = await getUserStateLedgerStatus(binding);
    }
    if (projection.projectionPending || projection.projectionFailed) {
      throw new Error("Received personal state could not finish its applicable local projection. Pending edits were retained.");
    }
    const localRetention = useUserStateStore.getState().retentionByServer?.[serverUrl];
    if (localRetention && (localRetention.pruneNonLibraryEnabled || localRetention.stripTimestampsEnabled)) {
      await applyLocalUserStateRetention({
        pruneNonLibraryDays: localRetention.pruneNonLibraryEnabled ? localRetention.pruneNonLibraryDays : null,
        stripTimestampsDays: localRetention.stripTimestampsEnabled ? localRetention.stripTimestampsDays : null,
      });
      check();
    }
    let sentBatch = false;
    for (;;) {
      check();
      const operations = (await prepareUserStateOperations(binding, {
        ...(bulk ? {} : { limit: USER_STATE_LEGACY_MAX_BATCH }),
        maxBytes: USER_STATE_CLIENT_BATCH_BYTES - 2048,
        allowOpaqueIdentity: opaqueIdentity,
      })).map(parseUserStateOperation);
      check();
      if (!operations.length) break;
      if (sentBatch) {
        await waitForUserStateDeferredApply();
        check();
      }
      await sendOperations(operations);
      sentBatch = true;
    }
    check();
    await pruneUserStateOperations(binding);
    check();
    useUserStateStore.getState().setRuntime(serverUrl, "idle");
    clearBackgroundSyncFailure("userState", serverUrl);
  } catch (error) {
    const aborted = isAbortError(error) || signal.aborted;
    const blocked = !aborted && error instanceof ContentServerError && error.status === 403;
    const message = aborted ? null : (error instanceof Error ? error.message : String(error));
    useUserStateStore.getState().setRuntime(serverUrl, aborted ? "idle" : "error", message, blocked);
    if (!aborted && message && !isAppActive()) {
      recordBackgroundSyncFailure({ kind: "userState", serverUrl, rawError: message, blocked });
    }
    throw error;
  } finally {
    unsubscribe();
    endSyncRun();
  }
}

/** Manual calls and the opt-in scheduler share a single durable drain per server. */
export function synchronizeUserState(options: { signal?: AbortSignal } = {}): Promise<void> {
  const serverUrl = selectedServer();
  if (!serverUrl) return Promise.reject(new Error("Configure the content server before sharing user changes."));
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  let current = running.get(serverUrl);
  if (!current || current.controller.signal.aborted) {
    const controller = new AbortController();
    const created: Synchronization = { controller, promise: Promise.resolve(), unconditionalWaiters: 0, signalWaiters: 0 };
    // Defer one microtask so synchronous store subscribers can join this exact run.
    created.promise = serializeUserStateSynchronization(() => runSynchronization(serverUrl, controller),
      () => controller.abort(requestAbortedError()), controller.signal).finally(() => {
      if (running.get(serverUrl) === created) running.delete(serverUrl);
    });
    running.set(serverUrl, created);
    current = created;
  }
  const signal = options.signal;
  if (!signal) {
    current.unconditionalWaiters++;
    return current.promise;
  }
  current.signalWaiters++;
  return new Promise<void>((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      current.signalWaiters = Math.max(0, current.signalWaiters - 1);
    };
    const abort = () => {
      release();
      const reason = signal.reason ?? requestAbortedError();
      if (current.unconditionalWaiters === 0 && current.signalWaiters === 0) current.controller.abort(reason);
      reject(reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      signal.removeEventListener("abort", abort);
      abort();
      return;
    }
    current.promise.then(
      () => { signal.removeEventListener("abort", abort); release(); resolve(); },
      error => { signal.removeEventListener("abort", abort); release(); reject(error); },
    );
  });
}

export async function resolveUserStateConflict(input: ResolveUserStateConflictInput): Promise<void> {
  const endSyncRun = beginUserStateSyncRun();
  try {
    const serverUrl = selectedServer();
    const binding = serverUrl ? await getUserStateBinding(serverUrl) : null;
    if (!binding) throw new Error("Share user changes once before resolving a shared conflict.");
    if (selectedServer() !== serverUrl) throw requestAbortedError();
    await resolveUserStateLedgerConflict(binding, {
      id: input.conflictId, version: input.version, choice: input.choice,
      ...(input.categoryName === undefined ? {} : { categoryName: input.categoryName }),
    });
    if (selectedServer() !== serverUrl) throw requestAbortedError();
    await synchronizeUserState();
  } finally {
    endSyncRun();
  }
}


/** Restored snapshot values are never converted into seeds by this explicit reconnection. */
export async function resumeUserStateAfterRestore(): Promise<void> {
  const endSyncRun = beginUserStateSyncRun();
  try {
    await withUserStateRestore(() => resumeRestoredLedger());
    await synchronizeUserState();
  } finally {
    endSyncRun();
  }
}

export async function rebindUserStateWorkspace(mode: UserStateRebindMode): Promise<void> {
  const serverUrl = selectedServer();
  if (!serverUrl) throw new Error("Configure the content server before sharing user changes.");
  const endSyncRun = beginUserStateSyncRun();
  try {
    await withUserStateRebind(async () => {
      await assertUserStateAvailable();
      const capabilities = await contentServerRequest<ContentCapabilities>(serverUrl, "/capabilities", undefined, "GET");
      if (capabilities.userStateVersion !== USER_STATE_VERSION) {
        throw new Error("This content server does not support shared user changes. Update the server before sharing.");
      }
      const token = await registerContentDevice(serverUrl, useContentSyncStore.getState().deviceName);
      const controller = new AbortController();
      const workspace = parseUserStateWorkspace(await request(serverUrl, "/user-state", token, controller.signal));
      let seedCutoffMs: number | null = null;
      let seedAllowed: boolean | undefined;
      if (capabilities.userStateRetentionVersion === 1) {
        const retention = parseUserStateRetentionResponse(
          await request(serverUrl, "/user-state/retention", token, controller.signal),
        );
        assertWorkspace(retention, { serverUrl, workspaceId: workspace.workspaceId, epoch: workspace.epoch });
        seedCutoffMs = retention.seedCutoffAt;
        seedAllowed = retention.seedAllowed;
      }
      const binding: UserStateBinding = {
        serverUrl,
        workspaceId: workspace.workspaceId,
        epoch: workspace.epoch,
      };
      await rebindUserStateWorkspaceInDb(binding, mode, {
        ...(mode === "reseed"
          ? { seedCutoffMs, seedAllowed }
          : { headRevision: workspace.headRevision, seedCutoffMs }),
      });
      useUserStateStore.getState().setEpochMismatch(serverUrl, null);
    });
    await synchronizeUserState();
  } finally {
    endSyncRun();
  }
}
