import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserStateOperation, UserStateReadResponse, UserStateRecord } from "./types";

const mocks = vi.hoisted(() => ({
  available: vi.fn(), resumeRestored: vi.fn(), getBinding: vi.fn(), status: vi.fn(), bind: vi.fn(), prepare: vi.fn(), apply: vi.fn(), ack: vi.fn(),
  conflicts: vi.fn(), deferred: vi.fn(), resolve: vi.fn(), active: vi.fn(), register: vi.fn(), forget: vi.fn(), fetch: vi.fn(),
  currentSet: vi.fn(),
}));
vi.mock("../../db/user-state", () => ({
  assertUserStateAvailable: mocks.available, resumeUserStateAfterRestore: mocks.resumeRestored,
  getUserStateBinding: mocks.getBinding, getUserStateLedgerStatus: mocks.status, bindUserStateWorkspace: mocks.bind,
  prepareUserStateOperations: mocks.prepare, applyUserStateReadPage: mocks.apply, acknowledgeUserStateOperations: mocks.ack,
  listUserStateConflicts: mocks.conflicts, listUserStateDeferred: mocks.deferred, resolveUserStateLedgerConflict: mocks.resolve,
  setUserStateActiveServer: mocks.active,
}));
vi.mock("../../db/user-state-current", () => ({
  setUserStateCurrentServer: mocks.currentSet,
}));
vi.mock("../content-sync/device", () => ({ registerContentDevice: mocks.register, forgetContentDeviceRegistration: mocks.forget }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mocks.fetch }));

import { useContentSyncStore } from "../../store/content-sync";
import { useUserStateStore } from "../../store/user-state";
import { getUserStateStatus, readUserStateResponse, synchronizeUserState, validateUserStateAcknowledgements, validateUserStatePage } from "./sync";
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
  mocks.getBinding.mockResolvedValue(binding);
  mocks.status.mockImplementation(async () => ({ cursor, through, pending: outbox.length, conflicts: 0, deferred: 0, lastSuccessAt: null }));
  mocks.bind.mockResolvedValue(undefined);
  mocks.prepare.mockImplementation(async () => outbox);
  mocks.apply.mockImplementation(async (_binding, page: UserStateReadResponse) => {
    cursor = page.nextCursor; through = page.hasMore ? page.through : null;
    return { resumes: [] };
  });
  mocks.ack.mockImplementation(async (_binding, results: { operationId: string }[]) => {
    outbox = outbox.filter(item => !results.some(result => result.operationId === item.operationId));
    return { resumes: [] };
  });
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

    expect(mocks.currentSet).toHaveBeenCalledWith(null);
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
