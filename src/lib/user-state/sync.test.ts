import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserStateOperation, UserStateReadResponse, UserStateRecord } from "./types";

const mocks = vi.hoisted(() => ({
  available: vi.fn(), resumeRestored: vi.fn(), getBinding: vi.fn(), status: vi.fn(), bind: vi.fn(), rebind: vi.fn(), reconcile: vi.fn(), applyRetention: vi.fn(),
  prepare: vi.fn(), apply: vi.fn(), ack: vi.fn(), prune: vi.fn(),
  conflicts: vi.fn(), deferred: vi.fn(), resolve: vi.fn(), active: vi.fn(), register: vi.fn(), forget: vi.fn(), fetch: vi.fn(),
  currentSet: vi.fn(), projection: vi.fn(), recoverProjection: vi.fn(),
}));
vi.mock("../../db/user-state", () => ({
  assertUserStateAvailable: mocks.available, resumeUserStateAfterRestore: mocks.resumeRestored,
  getUserStateBinding: mocks.getBinding, getUserStateLedgerStatus: mocks.status, bindUserStateWorkspace: mocks.bind,
  rebindUserStateWorkspace: mocks.rebind, reconcileUserStateSnapshot: mocks.reconcile, applyLocalUserStateRetention: mocks.applyRetention,
  prepareUserStateOperations: mocks.prepare, applyUserStateReadPage: mocks.apply, acknowledgeUserStateOperations: mocks.ack,
  pruneUserStateOperations: mocks.prune,
  materializePendingUserState: mocks.recoverProjection,
  listUserStateConflicts: mocks.conflicts, listUserStateDeferred: mocks.deferred, resolveUserStateLedgerConflict: mocks.resolve,
  setUserStateActiveServer: mocks.active,
}));
vi.mock("../../db/user-state-core", () => ({ waitForUserStateDeferredApply: mocks.projection }));
vi.mock("../content-sync/device", () => ({ registerContentDevice: mocks.register, forgetContentDeviceRegistration: mocks.forget }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mocks.fetch }));

import { useContentSyncStore } from "../../store/content-sync";
import { useUserStateStore } from "../../store/user-state";
import { getUserStateStatus, readUserStateResponse, rebindUserStateWorkspace, synchronizeUserState, validateUserStateAcknowledgements, validateUserStatePage } from "./sync";
import { USER_STATE_MAX_BYTES, type UserStateMergeResponse } from "./types";

const binding = { serverUrl: "http://server", workspaceId: "workspace", epoch: "epoch" };
const work = { pluginId: "source", sourceNovelId: "book", novelPath: "/book", name: "Book" };
const operation: UserStateOperation = { operationId: "intent-uuid", entity: { kind: "bookmark", work, chapter: { chapterPath: "/chapter/1" } }, value: { bookmarked: false }, baseRevision: 0 };
const published: UserStateRecord = { entity: operation.entity, value: operation.value, revision: 1, operationId: operation.operationId,
  updatedAt: 10, deviceId: "device", deviceName: "Tablet" };
let cursor = 0;
let through: number | null = null;
let head = 0;
let outbox: UserStateOperation[] = [];
let records: UserStateRecord[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  useContentSyncStore.setState({ serverUrl: "http://server", deviceName: "Tablet", deviceKey: null });
  useUserStateStore.setState({ enabledByServer: {}, runtimeByServer: {} });
  cursor = 0; through = null; head = 0; outbox = [operation]; records = [];
  mocks.available.mockResolvedValue(undefined); mocks.resumeRestored.mockResolvedValue(undefined);
  mocks.projection.mockResolvedValue(undefined);
  mocks.recoverProjection.mockResolvedValue({ resumes: [] });
  mocks.getBinding.mockResolvedValue(binding);
  mocks.status.mockImplementation(async () => ({ cursor, through, pending: outbox.length, conflicts: 0, deferred: 0, lastSuccessAt: null }));
  mocks.bind.mockResolvedValue(undefined);
  mocks.rebind.mockResolvedValue(undefined);
  mocks.reconcile.mockResolvedValue({ resumes: [] });
  mocks.applyRetention.mockResolvedValue(0);
  mocks.prepare.mockImplementation(async () => outbox);
  mocks.apply.mockImplementation(async (_binding, page: UserStateReadResponse) => {
    cursor = page.nextCursor; through = page.hasMore ? page.through : null;
    return { resumes: [] };
  });
  mocks.ack.mockImplementation(async (_binding, results: { operationId: string }[]) => {
    outbox = outbox.filter(item => !results.some(result => result.operationId === item.operationId));
    return { resumes: [] };
  });
  mocks.prune.mockResolvedValue(0);
  mocks.conflicts.mockResolvedValue([]); mocks.deferred.mockResolvedValue([]);
  mocks.register.mockResolvedValue("device-token");
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/capabilities")) return Response.json({ apiVersion: 1, packageVersion: 1, authentication: "device-key", personalStateSync: true, userStateVersion: 1, userStateBulkVersion: 1, userStateOpaqueIdentityVersion: 1 });
    if (path.endsWith("/user-state")) return Response.json({ version: 1, ...binding, serverUrl: undefined, headRevision: head });
    const body = JSON.parse(init?.body as string);
    if (path.endsWith("/read")) {
      const found = records.filter(record => record.revision > body.after && record.revision <= body.through);
      return Response.json({ version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: head,
        through: body.through, nextCursor: body.through, hasMore: false, records: found });
    }
    if (path.endsWith("/merge")) {
      head = 1; records = [published];
      return Response.json({ version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: head,
        results: [{ operationId: operation.operationId, status: "applied", current: published }] });
    }
    throw new Error("Unexpected network endpoint: " + path);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("user state transport", () => {
  it("reads status without registration or any network activity", async () => {
    expect(await getUserStateStatus()).toMatchObject({ workspaceId: "workspace", pending: 1 });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("waits for received local projection before sending even an already queued edit", async () => {
    let finish!: () => void;
    mocks.projection.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const run = synchronizeUserState();
    await vi.waitFor(() => expect(mocks.projection).toHaveBeenCalled());
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).endsWith("/merge"))).toBe(false);
    finish();
    await run;
    expect(mocks.prepare).toHaveBeenCalled();
  });

  it("recovers an interrupted applicable projection left behind a committed cursor before upload", async () => {
    let waiting = 1;
    mocks.status.mockImplementation(async () => ({
      cursor, through, pending: outbox.length, conflicts: 0, deferred: 0,
      projectionPending: waiting, projectionFailed: 0, lastSuccessAt: null,
    }));
    mocks.recoverProjection.mockImplementation(async () => { waiting = 0; return { resumes: [] }; });
    await synchronizeUserState();
    expect(mocks.recoverProjection).toHaveBeenCalledExactlyOnceWith(binding);
    expect(mocks.recoverProjection.mock.invocationCallOrder[0]).toBeLessThan(mocks.prepare.mock.invocationCallOrder[0]!);
    expect(outbox).toEqual([]);
  });

  it("retains pending edits if recovery still cannot complete an applicable projection", async () => {
    mocks.status.mockImplementation(async () => ({
      cursor, through, pending: outbox.length, conflicts: 0, deferred: 0,
      projectionPending: 1, projectionFailed: 0, lastSuccessAt: null,
    }));
    await expect(synchronizeUserState()).rejects.toThrow(/projection/);
    expect(mocks.recoverProjection).toHaveBeenCalledOnce();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(outbox).toEqual([operation]);
  });

  it("preserves queued edits when a received applicable projection has failed", async () => {
    mocks.status.mockImplementation(async () => ({
      cursor, through, pending: outbox.length, conflicts: 0, deferred: 0,
      projectionPending: 0, projectionFailed: 1, lastSuccessAt: null,
    }));
    await expect(synchronizeUserState()).rejects.toThrow(/projection/);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(outbox).toEqual([operation]);
  });

  it("retries a failed projection and acknowledges the retained edit without a chapter transfer", async () => {
    let failing = true;
    mocks.status.mockImplementation(async () => ({
      cursor, through, pending: outbox.length, conflicts: 0, deferred: 0,
      projectionPending: 0, projectionFailed: Number(failing), lastSuccessAt: null,
    }));
    await expect(synchronizeUserState()).rejects.toThrow(/projection/);
    expect(outbox).toEqual([operation]);
    mocks.recoverProjection.mockImplementationOnce(async () => { failing = false; return { resumes: [] }; });
    await synchronizeUserState();
    expect(outbox).toEqual([]);
    expect(mocks.ack).toHaveBeenCalledOnce();
    const paths = mocks.fetch.mock.calls.map(([url]) => new URL(url).pathname);
    expect(new Set(paths)).toEqual(new Set(["/api/v1/capabilities", "/api/v1/user-state", "/api/v1/user-state/merge", "/api/v1/user-state/read"]));
  });

  it("coalesces simultaneous calls, drains exact operations, and only contacts user-state endpoints", async () => {
    const first = synchronizeUserState();
    expect(synchronizeUserState()).toBe(first);
    await first;
    expect(mocks.bind).toHaveBeenCalledExactlyOnceWith(binding);
    expect(mocks.ack).toHaveBeenCalledTimes(1);
    expect(outbox).toEqual([]);
    expect(cursor).toBe(1);
    expect(useUserStateStore.getState().runtimeByServer["http://server"].phase).toBe("idle");
    const paths = mocks.fetch.mock.calls.map(([url]) => new URL(url).pathname);
    expect(paths).toEqual(["/api/v1/capabilities", "/api/v1/user-state", "/api/v1/user-state/merge", "/api/v1/user-state/read"]);
    const merge = mocks.fetch.mock.calls.find(([url]) => String(url).endsWith("/merge"))!;
    expect(JSON.parse(merge[1].body).operations).toEqual([operation]);
  });

  it("ignores the current-v2 compatibility endpoint and stays delta-only", async () => {
    outbox = [];
    const original = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/capabilities")) {
        return Response.json({
          apiVersion: 1, packageVersion: 1, authentication: "device-key", personalStateSync: true,
          userStateVersion: 1, userStateBulkVersion: 1, userStateOpaqueIdentityVersion: 1, userStateCurrentVersion: 2,
        });
      }
      return original(url, init);
    });

    await synchronizeUserState();

    const paths = mocks.fetch.mock.calls.map(([url]) => new URL(url).pathname);
    expect(paths.some(path => path.endsWith("/user-state/current"))).toBe(false);
    expect(paths).toEqual(["/api/v1/capabilities", "/api/v1/user-state"]);
  });

  it("uses one byte-bounded bulk request when supported and preserves the 200-item fallback for old servers", async () => {
    head = 1;
    records = [{ ...published, revision: 1 }];
    await synchronizeUserState();
    expect(mocks.prepare.mock.calls[0][1]).toEqual({ maxBytes: 30 * 1024 * 1024 - 2048, allowOpaqueIdentity: true });
    const bulkRead = mocks.fetch.mock.calls.find(([url]) => String(url).endsWith("/read"))!;
    expect(JSON.parse(bulkRead[1].body)).not.toHaveProperty("limit");

    vi.clearAllMocks();
    cursor = 0; through = null; head = 1; outbox = [operation]; records = [{ ...published, revision: 1 }];
    mocks.available.mockResolvedValue(undefined); mocks.getBinding.mockResolvedValue(binding); mocks.bind.mockResolvedValue(undefined);
    mocks.status.mockImplementation(async () => ({ cursor, through, pending: outbox.length, conflicts: 0, deferred: 0, lastSuccessAt: null }));
    mocks.prepare.mockImplementation(async () => outbox);
    mocks.apply.mockImplementation(async (_binding, page: UserStateReadResponse) => { cursor = page.nextCursor; through = page.hasMore ? page.through : null; return { resumes: [] }; });
    mocks.ack.mockImplementation(async (_binding, results: { operationId: string }[]) => { outbox = outbox.filter(item => !results.some(result => result.operationId === item.operationId)); return { resumes: [] }; });
    mocks.prune.mockResolvedValue(0);
    mocks.conflicts.mockResolvedValue([]); mocks.register.mockResolvedValue("device-token");
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/capabilities")) return Response.json({ apiVersion: 1, packageVersion: 1, authentication: "device-key", personalStateSync: true, userStateVersion: 1 });
      if (path.endsWith("/user-state")) return Response.json({ version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: head });
      const body = JSON.parse(init?.body as string);
      if (path.endsWith("/read")) return Response.json({ version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: head, through: body.through, nextCursor: body.through, hasMore: false, records: [] });
      if (path.endsWith("/merge")) {
        head = 1; records = [published];
        return Response.json({ version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: head,
          results: [{ operationId: operation.operationId, status: "applied", current: published }] });
      }
      throw new Error("Unexpected network endpoint: " + path);
    });
    await synchronizeUserState();
    expect(mocks.prepare.mock.calls[0][1]).toEqual({ limit: 200, maxBytes: 30 * 1024 * 1024 - 2048, allowOpaqueIdentity: false });
    const legacyRead = mocks.fetch.mock.calls.find(([url]) => String(url).endsWith("/read"))!;
    expect(JSON.parse(legacyRead[1].body).limit).toBe(200);
  });

  it("retains the attempted payload after a lost response and retries it exactly", async () => {
    const original = mocks.fetch.getMockImplementation()!;
    let lost = false;
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const result = await original(url, init);
      if (url.endsWith("/merge") && !lost) { lost = true; throw new Error("connection lost after commit"); }
      return result;
    });
    await expect(synchronizeUserState()).rejects.toThrow("connection failed");
    expect(mocks.ack).not.toHaveBeenCalled();
    expect(outbox).toEqual([operation]);
    await synchronizeUserState();
    const attempts = mocks.fetch.mock.calls.filter(([url]) => String(url).endsWith("/merge")).map(([, init]) => init.body);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toBe(attempts[1]);
    expect(outbox).toEqual([]);
  });

  it("resumes a durable frozen read boundary before moving to the current head", async () => {
    outbox = []; through = 1; head = 2;
    records = [published, { ...published, revision: 2, operationId: "newer", value: { bookmarked: true } }];
    await synchronizeUserState();
    const reads = mocks.fetch.mock.calls.filter(([url]) => String(url).endsWith("/read")).map(([, init]) => JSON.parse(init.body));
    expect(reads.map(row => [row.after, row.through])).toEqual([[0, 1], [1, 2]]);
    expect(cursor).toBe(2);
  });

  it("does not apply a late read after the selected server changes, even if it changes back", async () => {
    head = 1;
    records = [{ ...published, revision: 1 }];
    const original = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const result = await original(url, init);
      if (url.endsWith("/read")) {
        useContentSyncStore.setState({ serverUrl: "http://other" });
        useContentSyncStore.setState({ serverUrl: "http://server" });
      }
      return result;
    });
    await expect(synchronizeUserState()).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.ack).not.toHaveBeenCalled();
    expect(outbox).toEqual([operation]);
  });

  it("rejects a server without the feature before binding or preparing local data", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ userStateVersion: 2 }));
    await expect(synchronizeUserState()).rejects.toThrow("does not support");
    expect(mocks.bind).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("rejects missing or foreign acknowledgements without dropping the outbox", async () => {
    const original = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => url.endsWith("/merge")
      ? Response.json({ version: 1, workspaceId: "workspace", epoch: "epoch", headRevision: 1, results: [] })
      : original(url, init));
    await expect(synchronizeUserState()).rejects.toThrow("incomplete");
    expect(mocks.ack).not.toHaveBeenCalled();
    expect(outbox).toEqual([operation]);
  });

  it("rejects a changed workspace and a cursor rollback before publishing", async () => {
    head = 0; cursor = 2;
    await expect(synchronizeUserState()).rejects.toThrow("ahead");
    expect(mocks.prepare).not.toHaveBeenCalled();
    const page = { version: 1 as const, workspaceId: "other", epoch: "epoch", headRevision: 2, through: 2, nextCursor: 2, hasMore: false, records: [] };
    expect(() => validateUserStatePage(page, binding, 0, 2)).toThrow("workspace changed");
    expect(() => validateUserStatePage({ ...page, workspaceId: "workspace", through: 1 }, binding, 0, 2)).toThrow("requested cursor");
  });

  it("checks aliases against the actual submitted category and verifies applied values", () => {
    const response: UserStateMergeResponse = { version: 1, workspaceId: "workspace", epoch: "epoch", headRevision: 1,
      results: [{ operationId: operation.operationId, status: "applied", current: { ...published, value: { bookmarked: true } } }] };
    expect(() => validateUserStateAcknowledgements(response, binding, [operation])).toThrow("value differs");
    response.results[0] = { operationId: operation.operationId, status: "conflict", current: null, categoryAlias: { from: "a", to: "b" } };
    expect(() => validateUserStateAcknowledgements(response, binding, [operation])).toThrow("alias does not belong");
  });

  it("bounds declared and chunked response bytes and rejects invalid UTF-8", async () => {
    await expect(readUserStateResponse(new Response("{}", { headers: { "content-length": String(USER_STATE_MAX_BYTES + 1) } }))).rejects.toThrow("size limit");
    const chunk = new Uint8Array(USER_STATE_MAX_BYTES / 2 + 1);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(chunk); controller.enqueue(chunk); controller.close(); } });
    await expect(readUserStateResponse(new Response(stream))).rejects.toThrow("size limit");
    await expect(readUserStateResponse(new Response(new Uint8Array([0xff, 0xff])))).rejects.toThrow("valid JSON");
  });
});


it("splits a response-budget rejection without changing attempted operation IDs or payloads", async () => {
  const second: UserStateOperation = { ...operation, operationId: "second-uuid", entity: { kind: "bookmark", work, chapter: { chapterPath: "/chapter/2" } } };
  outbox = [operation, second];
  const original = mocks.fetch.getMockImplementation()!;
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (!url.endsWith("/merge")) return original(url, init);
    const body = JSON.parse(init?.body as string);
    if (body.operations.length > 1) return new Response(null, { status: 413 });
    const item = body.operations[0] as UserStateOperation;
    const next: UserStateRecord = { ...published, entity: item.entity, operationId: item.operationId, revision: ++head };
    records.push(next);
    return Response.json({ version: 1, workspaceId: "workspace", epoch: "epoch", headRevision: head,
      results: [{ operationId: item.operationId, status: "applied", current: next }] });
  });
  await synchronizeUserState();
  const batches = mocks.fetch.mock.calls.filter(([url]) => String(url).endsWith("/merge"))
    .map(([, init]) => JSON.parse(init.body).operations);
  expect(batches).toEqual([[operation, second], [operation], [second]]);
  expect(outbox).toEqual([]);
  expect(mocks.ack).toHaveBeenCalledTimes(2);
});

it("does not make a network request while a restored snapshot is fenced", async () => {
  mocks.available.mockRejectedValue(new Error("Sharing is paused after restore"));
  await expect(synchronizeUserState()).rejects.toThrow("paused after restore");
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(outbox).toEqual([operation]);
});

it("keeps a shared sync alive when one caller aborts its signal while another caller awaits, and preserves server 409 messages", async () => {
  let releaseMerge!: () => void;
  const mergeGate = new Promise<void>(resolve => { releaseMerge = resolve; });
  const original = mocks.fetch.getMockImplementation()!;
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/merge")) await mergeGate;
    return original(url, init);
  });

  const abortController = new AbortController();
  const abortableCaller = synchronizeUserState({ signal: abortController.signal });
  const sharedCaller = synchronizeUserState();
  await vi.waitFor(() => expect(mocks.fetch.mock.calls.some(([url]) => String(url).endsWith("/merge"))).toBe(true));

  abortController.abort(new DOMException("Caller cancelled", "AbortError"));
  await expect(abortableCaller).rejects.toMatchObject({ name: "AbortError" });

  releaseMerge();
  await expect(sharedCaller).resolves.toBeUndefined();
  expect(outbox).toEqual([]);

  outbox = [operation];
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/merge")) {
      return Response.json({ message: "Specific workspace epoch mismatch" }, { status: 409 });
    }
    return original(url, init);
  });
  await expect(synchronizeUserState()).rejects.toMatchObject({
    status: 409,
    message: "Specific workspace epoch mismatch",
  });
});

it("prunes acknowledged operations after sync completion including idle pull-only runs", async () => {
  await synchronizeUserState();
  expect(mocks.prune).toHaveBeenCalledExactlyOnceWith(binding);
  expect(mocks.ack.mock.invocationCallOrder[0]!).toBeLessThan(mocks.prune.mock.invocationCallOrder[0]!);

  mocks.prune.mockClear();
  outbox = [];
  await synchronizeUserState();
  expect(mocks.prune).toHaveBeenCalledExactlyOnceWith(binding);
  expect(useUserStateStore.getState().runtimeByServer["http://server"].phase).toBe("idle");
});

it("negotiates userStateRetentionVersion, handles 410 Gone via paginated snapshot, and performs explicit Mode A/B rebinds", async () => {
  const original = mocks.fetch.getMockImplementation()!;
  let snapshotPage = 0;
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/capabilities")) {
      return Response.json({
        apiVersion: 1, packageVersion: 1, authentication: "device-key", personalStateSync: true,
        userStateVersion: 1, userStateBulkVersion: 1, userStateOpaqueIdentityVersion: 1, userStateRetentionVersion: 1,
      });
    }
    if (path.endsWith("/user-state/retention")) {
      return Response.json({
        version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: 3,
        compactedThrough: 0, seedAllowed: true, seedCutoffAt: 1_700_000_000_000,
      });
    }
    if (path.endsWith("/user-state/read")) {
      return Response.json({ code: "cursor-compacted", message: "Cursor compacted" }, { status: 410 });
    }
    if (path.endsWith("/user-state/snapshot")) {
      snapshotPage += 1;
      if (snapshotPage === 1) {
        return Response.json({
          version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: 3, snapshotRevision: 3,
          nextEntityKey: "k1", hasMore: true, seedAllowed: false, seedCutoffAt: 1_700_000_000_000, records: [published],
        });
      }
      cursor = 3;
      head = 3;
      return Response.json({
        version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: 3, snapshotRevision: 3,
        nextEntityKey: null, hasMore: false, seedAllowed: false, seedCutoffAt: 1_700_000_000_000, records: [],
      });
    }
    if (path.endsWith("/user-state")) {
      return Response.json({ version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: 3 });
    }
    return original(url, init);
  });
  head = 3;
  outbox = [];

  await synchronizeUserState();
  expect(mocks.bind).toHaveBeenCalledWith(binding, { seedAllowed: true, seedCutoffMs: 1_700_000_000_000 });
  expect(mocks.reconcile).toHaveBeenCalledWith(binding, {
    records: [published], snapshotRevision: 3, seedAllowed: false, seedCutoffMs: 1_700_000_000_000,
  });
  expect((await getUserStateStatus()).seedCutoffAt).toBe(1_700_000_000_000);

  // Epoch change sets epochMismatch; Mode B rebind clears it and passes headRevision.
  const nextBinding = { serverUrl: binding.serverUrl, workspaceId: binding.workspaceId, epoch: "epoch-2" };
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/capabilities")) {
      return Response.json({
        apiVersion: 1, packageVersion: 1, authentication: "device-key", personalStateSync: true,
        userStateVersion: 1, userStateRetentionVersion: 1,
      });
    }
    if (path.endsWith("/user-state")) {
      return Response.json({ version: 1, workspaceId: nextBinding.workspaceId, epoch: nextBinding.epoch, headRevision: 5 });
    }
    if (path.endsWith("/user-state/retention")) {
      return Response.json({
        version: 1, workspaceId: nextBinding.workspaceId, epoch: nextBinding.epoch, headRevision: 5,
        compactedThrough: 0, seedAllowed: true, seedCutoffAt: null,
      });
    }
    if (path.endsWith("/user-state/read")) {
      return Response.json({
        version: 1, workspaceId: nextBinding.workspaceId, epoch: nextBinding.epoch, headRevision: 5,
        through: 5, nextCursor: 5, hasMore: false, records: [],
      });
    }
    return original(url, init);
  });

  await expect(synchronizeUserState()).rejects.toThrow(/workspace|epoch/i);
  expect((await getUserStateStatus()).epochMismatch?.serverEpoch).toBe("epoch-2");

  mocks.getBinding.mockResolvedValue(nextBinding);
  cursor = 5;
  await rebindUserStateWorkspace("start_fresh");
  expect(mocks.rebind).toHaveBeenCalledWith(nextBinding, "start_fresh", { headRevision: 5, seedCutoffMs: null });
  expect((await getUserStateStatus()).epochMismatch).toBeUndefined();
});

it("preserves epochMismatch when manual synchronizeUserState fails or is aborted", async () => {
  const original = mocks.fetch.getMockImplementation()!;
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname.endsWith("/user-state")) {
      return Response.json({ version: 1, workspaceId: binding.workspaceId, epoch: "epoch-2", headRevision: 4 });
    }
    return original(url, init);
  });
  await expect(synchronizeUserState()).rejects.toThrow(/workspace|epoch/i);
  const mismatch = useUserStateStore.getState().runtimeByServer[binding.serverUrl]?.epochMismatch;
  expect(mismatch?.serverEpoch).toBe("epoch-2");

  // Manual sync failing with 503 must keep epochMismatch intact.
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname.endsWith("/capabilities")) {
      return new Response("Unavailable", { status: 503 });
    }
    return original(url, init);
  });
  await expect(synchronizeUserState()).rejects.toThrow();
  expect(useUserStateStore.getState().runtimeByServer[binding.serverUrl]?.epochMismatch).toEqual(mismatch);

  // Aborting a manual sync during capabilities fetch must also keep epochMismatch intact.
  const controller = new AbortController();
  mocks.fetch.mockImplementation(async () => {
    controller.abort(new DOMException("Cancelled", "AbortError"));
    throw new DOMException("Cancelled", "AbortError");
  });
  await expect(synchronizeUserState({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(useUserStateStore.getState().runtimeByServer[binding.serverUrl]?.epochMismatch).toEqual(mismatch);
});

it("fails after exhausting MAX_SNAPSHOT_RETRIES on persistent 410 cursor-compacted", async () => {
  const original = mocks.fetch.getMockImplementation()!;
  let snapshotCalls = 0;
  head = 3;
  outbox = [];
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/capabilities")) {
      return Response.json({
        apiVersion: 1, packageVersion: 1, authentication: "device-key", personalStateSync: true,
        userStateVersion: 1, userStateBulkVersion: 1, userStateOpaqueIdentityVersion: 1, userStateRetentionVersion: 1,
      });
    }
    if (path.endsWith("/user-state")) {
      return Response.json({ version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: head });
    }
    if (path.endsWith("/user-state/retention")) {
      return Response.json({
        version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: head,
        compactedThrough: 0, seedAllowed: true, seedCutoffAt: null,
      });
    }
    if (path.endsWith("/user-state/read")) {
      return Response.json({ code: "cursor-compacted", message: "Cursor compacted" }, { status: 410 });
    }
    if (path.endsWith("/user-state/snapshot")) {
      snapshotCalls += 1;
      head += 1;
      return Response.json({
        version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: head, snapshotRevision: head - 1,
        nextEntityKey: null, hasMore: false, seedAllowed: false, seedCutoffAt: null, records: [],
      });
    }
    return original(url, init);
  });
  mocks.reconcile.mockImplementation(async (_b, args: { snapshotRevision: number }) => {
    cursor = args.snapshotRevision;
    return { resumes: [] };
  });

  await expect(synchronizeUserState()).rejects.toThrow("snapshot reconciliation exceeded retry limit");
  expect(snapshotCalls).toBe(5);
  expect(useUserStateStore.getState().runtimeByServer[binding.serverUrl]?.phase).toBe("error");
});

it("does not reconcile or mutate retentionStatusByServer if multi-page /snapshot fails mid-pagination", async () => {
  const original = mocks.fetch.getMockImplementation()!;
  let snapshotPage = 0;
  head = 3;
  outbox = [];
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/capabilities")) {
      return Response.json({
        apiVersion: 1, packageVersion: 1, authentication: "device-key", personalStateSync: true,
        userStateVersion: 1, userStateRetentionVersion: 1,
      });
    }
    if (path.endsWith("/user-state")) {
      return Response.json({ version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: 3 });
    }
    if (path.endsWith("/user-state/retention")) {
      return Response.json({
        version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: 3,
        compactedThrough: 2, seedAllowed: true, seedCutoffAt: null,
      });
    }
    if (path.endsWith("/user-state/snapshot")) {
      snapshotPage += 1;
      if (snapshotPage === 1) {
        return Response.json({
          version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: 3, snapshotRevision: 3,
          nextEntityKey: "k1", hasMore: true, seedAllowed: false, seedCutoffAt: 1_700_000_000_000, records: [published],
        });
      }
      return Response.json({ message: "Server failure" }, { status: 500 });
    }
    return original(url, init);
  });

  await expect(synchronizeUserState()).rejects.toMatchObject({ status: 500 });
  expect(mocks.reconcile).not.toHaveBeenCalled();
  expect(cursor).toBe(0);
  expect(useUserStateStore.getState().retentionStatusByServer?.[binding.serverUrl]).toEqual({
    seedAllowed: true,
    seedCutoffAt: null,
  });
});

it("reconciles multi-page /snapshot at min(snapshotRevision) and catches up via /read", async () => {
  const original = mocks.fetch.getMockImplementation()!;
  let snapshotPage = 0;
  const readCalls: { after: number; through: number }[] = [];
  head = 5;
  outbox = [];
  const rec7: UserStateRecord = { ...published, revision: 7, operationId: "op-7", value: { bookmarked: true } };
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/capabilities")) {
      return Response.json({
        apiVersion: 1, packageVersion: 1, authentication: "device-key", personalStateSync: true,
        userStateVersion: 1, userStateBulkVersion: 1, userStateRetentionVersion: 1,
      });
    }
    if (path.endsWith("/user-state")) {
      return Response.json({ version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: head });
    }
    if (path.endsWith("/user-state/retention")) {
      return Response.json({
        version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: 5,
        compactedThrough: 2, seedAllowed: false, seedCutoffAt: null,
      });
    }
    if (path.endsWith("/user-state/snapshot")) {
      snapshotPage += 1;
      if (snapshotPage === 1) {
        return Response.json({
          version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: 5, snapshotRevision: 5,
          nextEntityKey: "k1", hasMore: true, seedAllowed: false, seedCutoffAt: null, records: [published],
        });
      }
      head = 7;
      return Response.json({
        version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: 7, snapshotRevision: 7,
        nextEntityKey: null, hasMore: false, seedAllowed: false, seedCutoffAt: null, records: [rec7],
      });
    }
    if (path.endsWith("/user-state/read")) {
      const body = JSON.parse(init?.body as string);
      readCalls.push({ after: body.after, through: body.through });
      return Response.json({
        version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: 7,
        through: body.through, nextCursor: body.through, hasMore: false, records: [rec7],
      });
    }
    return original(url, init);
  });
  mocks.reconcile.mockImplementation(async (_b, args: { snapshotRevision: number }) => {
    cursor = args.snapshotRevision;
    return { resumes: [] };
  });

  await synchronizeUserState();
  expect(mocks.reconcile).toHaveBeenCalledWith(binding, {
    records: [published, rec7], snapshotRevision: 5, seedAllowed: false, seedCutoffMs: null,
  });
  expect(readCalls).toEqual([{ after: 5, through: 7 }]);
  expect(cursor).toBe(7);
});

it("records epochMismatch immediately when epoch rotates mid-sync on /retention or post-snapshot /user-state", async () => {
  const original = mocks.fetch.getMockImplementation()!;
  outbox = [];

  // Case 1: epoch rotates before GET /user-state/retention
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/capabilities")) {
      return Response.json({
        apiVersion: 1, packageVersion: 1, authentication: "device-key", personalStateSync: true,
        userStateVersion: 1, userStateRetentionVersion: 1,
      });
    }
    if (path.endsWith("/user-state")) {
      return Response.json({ version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: 0 });
    }
    if (path.endsWith("/user-state/retention")) {
      return Response.json({
        version: 1, workspaceId: binding.workspaceId, epoch: "epoch-2", headRevision: 0,
        compactedThrough: 0, seedAllowed: true, seedCutoffAt: null,
      });
    }
    return original(url, init);
  });

  await expect(synchronizeUserState()).rejects.toThrow(/workspace changed/i);
  expect((await getUserStateStatus()).epochMismatch?.serverEpoch).toBe("epoch-2");

  // Case 2: epoch rotates between /user-state/snapshot and post-snapshot GET /user-state
  useUserStateStore.getState().setEpochMismatch(binding.serverUrl, null);
  let userStateCalls = 0;
  head = 3;
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/capabilities")) {
      return Response.json({
        apiVersion: 1, packageVersion: 1, authentication: "device-key", personalStateSync: true,
        userStateVersion: 1, userStateRetentionVersion: 1,
      });
    }
    if (path.endsWith("/user-state")) {
      userStateCalls += 1;
      return Response.json({
        version: 1,
        workspaceId: binding.workspaceId,
        epoch: userStateCalls === 1 ? binding.epoch : "epoch-3",
        headRevision: userStateCalls === 1 ? 3 : 0,
      });
    }
    if (path.endsWith("/user-state/retention")) {
      return Response.json({
        version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: 3,
        compactedThrough: 2, seedAllowed: false, seedCutoffAt: null,
      });
    }
    if (path.endsWith("/user-state/snapshot")) {
      return Response.json({
        version: 1, workspaceId: binding.workspaceId, epoch: binding.epoch, headRevision: 3, snapshotRevision: 3,
        nextEntityKey: null, hasMore: false, seedAllowed: false, seedCutoffAt: null, records: [],
      });
    }
    return original(url, init);
  });

  await expect(synchronizeUserState()).rejects.toThrow(/workspace changed/i);
  expect((await getUserStateStatus()).epochMismatch?.serverEpoch).toBe("epoch-3");
});
