import {
  acknowledgeUserStateOperations, applyUserStateReadPage, assertUserStateAvailable, bindUserStateWorkspace, getUserStateBinding,
  getUserStateLedgerStatus, listUserStateConflicts, prepareUserStateOperations,
  resolveUserStateLedgerConflict, resumeUserStateAfterRestore as resumeRestoredLedger, setUserStateActiveServer,
} from "../../db/user-state";
import { setUserStateCurrentServer } from "../../db/user-state-current";
import { useContentSyncStore } from "../../store/content-sync";
import { useUserStateStore } from "../../store/user-state";
import { isAbortError, requestAbortedError } from "../abort";
import { serializeUserStateSynchronization, withUserStateRestore } from "./maintenance";
import {
  ContentServerError, contentServerFetch, contentServerRequest, normalizeContentServerUrl, withContentServerLookup,
} from "../content-sync/client";
import { forgetContentDeviceRegistration, registerContentDevice, type ContentCapabilities } from "../content-sync/device";
import {
  canonicalUserStateJson, parseUserStateMergeResponse, parseUserStateOperation, parseUserStateReadResponse,
  parseUserStateWorkspace, userStateEntityKey, userStateJsonBytes, UserStateProtocolError,
  USER_STATE_CLIENT_BATCH_BYTES, USER_STATE_LEGACY_MAX_BATCH, USER_STATE_MAX_BYTES, USER_STATE_VERSION,
  type ResolveUserStateConflictInput, type UserStateBinding, type UserStateMergeResponse, type UserStateOperation,
  type UserStateReadResponse, type UserStateStatus, type UserStateWorkspace,
} from "./types";

interface Synchronization { promise: Promise<void>; controller: AbortController }
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
      await response.body?.cancel();
      throw new ContentServerError(response.status, response.status === 409
        ? "User state: the workspace or retained cursor changed. Pending changes were retained."
        : undefined);
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

/** This status query reads only the local ledger; opening settings never publishes data. */
export async function getUserStateStatus(): Promise<UserStateStatus> {
  const serverUrl = selectedServer();
  const binding = serverUrl ? await getUserStateBinding(serverUrl) : null;
  const status = await getUserStateLedgerStatus(binding ?? null);
  const conflicts = binding ? await listUserStateConflicts(binding) : [];
  return {
    workspaceId: binding?.workspaceId ?? null, epoch: binding?.epoch ?? null,
    pending: status.pending, conflicts,
    lastSuccessAt: status.lastSuccessAt, pausedAfterRestore: status.pausedAfterRestore === true,
  };
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
  // Current snapshot v2 is compatibility-only. New clients keep the delta ledger
  // active so normal sync cost is proportional to changed revisions.
  setUserStateCurrentServer(null);
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
    const token = await registerContentDevice(serverUrl, useContentSyncStore.getState().deviceName, signal);
    check();
    const workspace = parseUserStateWorkspace(await request(serverUrl, "/user-state", token, signal));
    check();
    const binding: UserStateBinding = { serverUrl, workspaceId: workspace.workspaceId, epoch: workspace.epoch };
    await bindUserStateWorkspace(binding);
    check();
    let observedHead = workspace.headRevision;

    async function pullThrough(target: number): Promise<void> {
      let status = await getUserStateLedgerStatus(binding);
      check();
      if (status.cursor > target || (status.through !== null && status.through > target)) {
        throw new UserStateProtocolError("the retained cursor is ahead of this server; it was not reset");
      }
      for (;;) {
        const through = status.through ?? target;
        const page = parseUserStateReadResponse(await request(serverUrl, "/user-state/read", token, signal, {
          workspaceId: binding.workspaceId, epoch: binding.epoch, after: status.cursor, through,
          ...(bulk ? {} : { limit: USER_STATE_LEGACY_MAX_BATCH }),
        }));
        check();
        validateUserStatePage(page, binding, status.cursor, through);
        observedHead = Math.max(observedHead, page.headRevision);
        await applyUserStateReadPage(binding, page);
        check();
        if (!page.hasMore && page.nextCursor === target) return;
        status = await getUserStateLedgerStatus(binding);
        check();
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
        throw error;
      }
      check();
      validateUserStateAcknowledgements(response, binding, operations);
      if (response.headRevision < observedHead) throw new UserStateProtocolError("server revision moved backwards; pending changes were retained");
      observedHead = response.headRevision;
      await acknowledgeUserStateOperations(binding, response.results);
      check();
      // This also receives deletion cascades and other changes committed before this receipt.
      await pullThrough(response.headRevision);
    }

    await pullThrough(workspace.headRevision);
    for (;;) {
      check();
      const operations = (await prepareUserStateOperations(binding, {
        ...(bulk ? {} : { limit: USER_STATE_LEGACY_MAX_BATCH }),
        maxBytes: USER_STATE_CLIENT_BATCH_BYTES - 2048,
        allowOpaqueIdentity: opaqueIdentity,
      })).map(parseUserStateOperation);
      check();
      if (!operations.length) break;
      await sendOperations(operations);
    }
    check();
    useUserStateStore.getState().setRuntime(serverUrl, "idle");
  } catch (error) {
    useUserStateStore.getState().setRuntime(serverUrl, isAbortError(error) || signal.aborted ? "idle" : "error",
      isAbortError(error) || signal.aborted ? null : error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    unsubscribe();
  }
}

/** Manual calls and the opt-in scheduler share a single durable drain per server. */
export function synchronizeUserState(options: { signal?: AbortSignal } = {}): Promise<void> {
  const serverUrl = selectedServer();
  if (!serverUrl) return Promise.reject(new Error("Configure the content server before sharing user changes."));
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  const existing = running.get(serverUrl);
  if (existing && !existing.controller.signal.aborted) return existing.promise;
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason ?? requestAbortedError());
  options.signal?.addEventListener("abort", abort, { once: true });
  const current: Synchronization = { controller, promise: Promise.resolve() };
  // Defer one microtask so synchronous store subscribers can join this exact run.
  current.promise = serializeUserStateSynchronization(() => runSynchronization(serverUrl, controller),
    () => controller.abort(requestAbortedError()), controller.signal).finally(() => {
    options.signal?.removeEventListener("abort", abort);
    if (running.get(serverUrl) === current) running.delete(serverUrl);
  });
  running.set(serverUrl, current);
  return current.promise;
}

export async function resolveUserStateConflict(input: ResolveUserStateConflictInput): Promise<void> {
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
}


/** Restored snapshot values are never converted into seeds by this explicit reconnection. */
export async function resumeUserStateAfterRestore(): Promise<void> {
  await withUserStateRestore(() => resumeRestoredLedger());
  await synchronizeUserState();
}
