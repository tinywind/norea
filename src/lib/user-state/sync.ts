import {
  assertUserStateAvailable, getUserStateBinding, resumeUserStateAfterRestore as resumeRestoredState,
} from "../../db/user-state";
import {
  applyUserStateCurrentSnapshot, bindUserStateCurrentWorkspace, exportUserStateCurrentSnapshot,
  getUserStateCurrentStatus, setUserStateCurrentServer,
} from "../../db/user-state-current";
import { useContentSyncStore } from "../../store/content-sync";
import { useUserStateStore } from "../../store/user-state";
import { isAbortError, requestAbortedError } from "../abort";
import { serializeUserStateSynchronization, withUserStateRestore } from "./maintenance";
import {
  ContentServerError, contentServerFetch, contentServerRequest, normalizeContentServerUrl, withContentServerLookup,
} from "../content-sync/client";
import { forgetContentDeviceRegistration, registerContentDevice, type ContentCapabilities } from "../content-sync/device";
import {
  parseUserStateCurrentSnapshot, USER_STATE_CURRENT_VERSION, type UserStateCurrentSnapshot,
} from "./current-types";
import {
  userStateJsonBytes, UserStateProtocolError, USER_STATE_CLIENT_BATCH_BYTES, USER_STATE_MAX_BYTES,
  type UserStateBinding,
} from "./types";

interface Synchronization { promise: Promise<void>; controller: AbortController }
const running = new Map<string, Synchronization>();

function selectedServer(): string {
  const value = useContentSyncStore.getState().serverUrl;
  return value ? normalizeContentServerUrl(value) : "";
}

function assertWorkspace(snapshot: UserStateCurrentSnapshot, binding: UserStateBinding): void {
  if (snapshot.workspaceId !== binding.workspaceId || snapshot.epoch !== binding.epoch) {
    throw new UserStateProtocolError("the server workspace changed; local data were retained");
  }
}

/** Bound the decoded body as well as the declared length, including chunked responses. */
export async function readUserStateResponse(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > USER_STATE_MAX_BYTES)) {
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
      if (length > USER_STATE_MAX_BYTES) {
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

async function request(serverUrl: string, token: string, signal: AbortSignal, snapshot?: UserStateCurrentSnapshot): Promise<unknown> {
  if (snapshot !== undefined && userStateJsonBytes(snapshot) > USER_STATE_CLIENT_BATCH_BYTES) {
    throw new UserStateProtocolError("current state exceeds the upload size limit");
  }
  return withContentServerLookup(async deadline => {
    const response = await contentServerFetch(serverUrl + "/api/v1/user-state/current", {
      method: snapshot === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + token, ...(snapshot === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(snapshot === undefined ? {} : { body: JSON.stringify(snapshot) }),
      signal: deadline, connectTimeout: 10_000, maxRedirections: 0,
    });
    if (!response.ok) {
      if (response.status === 401) forgetContentDeviceRegistration(serverUrl, token);
      await response.body?.cancel();
      throw new ContentServerError(response.status, response.status === 409
        ? "User state: the server workspace changed. Local data were retained."
        : response.status === 426 ? "Update the content server and app before sharing current state." : undefined);
    }
    const result = await readUserStateResponse(response);
    deadline.throwIfAborted();
    return result;
  }, 60, signal);
}

/** Settings read one local summary; they never enumerate shared chapters or contact the server. */
export function getUserStateStatus() {
  return getUserStateCurrentStatus(selectedServer());
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
  setUserStateCurrentServer(serverUrl);
  useUserStateStore.getState().setRuntime(serverUrl, "syncing");
  try {
    check();
    await assertUserStateAvailable();
    check();
    const capabilities = await contentServerRequest<ContentCapabilities>(serverUrl, "/capabilities", undefined, "GET", undefined, signal);
    check();
    if (capabilities.userStateCurrentVersion !== USER_STATE_CURRENT_VERSION) {
      throw new Error("This content server does not support current-state sharing. Update the server before sharing.");
    }
    const token = await registerContentDevice(serverUrl, useContentSyncStore.getState().deviceName, signal);
    check();
    let binding = await getUserStateBinding(serverUrl);
    check();
    if (!binding) {
      const current = parseUserStateCurrentSnapshot(await request(serverUrl, token, signal));
      check();
      binding = { serverUrl, workspaceId: current.workspaceId, epoch: current.epoch };
    }
    // Binding creates only the workspace row. It does not seed or drain a change journal.
    await bindUserStateCurrentWorkspace(binding);
    check();
    const local = await exportUserStateCurrentSnapshot(binding);
    check();
    assertWorkspace(local, binding);
    // A single exchange carries current SQLite values, regardless of chapter count.
    // Repeating it after a lost response is an additive merge, without operation receipts.
    const shared = parseUserStateCurrentSnapshot(await request(serverUrl, token, signal, local));
    check();
    assertWorkspace(shared, binding);
    await applyUserStateCurrentSnapshot(binding, shared);
    check();
    useUserStateStore.getState().setRuntime(serverUrl, "idle");
  } catch (error) {
    const cancelled = isAbortError(error) || signal.aborted;
    useUserStateStore.getState().setRuntime(serverUrl, cancelled ? "idle" : "error",
      cancelled ? null : error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    unsubscribe();
  }
}

/** Manual calls and automatic sharing coalesce into one current-state exchange per server. */
export function synchronizeUserState(options: { signal?: AbortSignal } = {}): Promise<void> {
  const serverUrl = selectedServer();
  if (!serverUrl) return Promise.reject(new Error("Configure the content server before sharing current state."));
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  const existing = running.get(serverUrl);
  if (existing && !existing.controller.signal.aborted) return existing.promise;
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason ?? requestAbortedError());
  options.signal?.addEventListener("abort", abort, { once: true });
  const current: Synchronization = { controller, promise: Promise.resolve() };
  current.promise = serializeUserStateSynchronization(() => runSynchronization(serverUrl, controller),
    () => controller.abort(requestAbortedError()), controller.signal).finally(() => {
    options.signal?.removeEventListener("abort", abort);
    if (running.get(serverUrl) === current) running.delete(serverUrl);
  });
  running.set(serverUrl, current);
  return current.promise;
}

export async function resumeUserStateAfterRestore(): Promise<void> {
  await withUserStateRestore(() => resumeRestoredState());
  await synchronizeUserState();
}
