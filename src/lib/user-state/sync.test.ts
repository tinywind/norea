import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserStateCurrentSnapshot } from "./current-types";

const mocks = vi.hoisted(() => ({
  available: vi.fn(), resumeRestored: vi.fn(), getBinding: vi.fn(), status: vi.fn(), bind: vi.fn(), exportCurrent: vi.fn(), apply: vi.fn(),
  active: vi.fn(), register: vi.fn(), forget: vi.fn(), fetch: vi.fn(),
}));
vi.mock("../../db/user-state", () => ({
  assertUserStateAvailable: mocks.available, resumeUserStateAfterRestore: mocks.resumeRestored, getUserStateBinding: mocks.getBinding,
}));
vi.mock("../../db/user-state-current", () => ({
  getUserStateCurrentStatus: mocks.status, bindUserStateCurrentWorkspace: mocks.bind,
  exportUserStateCurrentSnapshot: mocks.exportCurrent, applyUserStateCurrentSnapshot: mocks.apply, setUserStateCurrentServer: mocks.active,
}));
vi.mock("../content-sync/device", () => ({ registerContentDevice: mocks.register, forgetContentDeviceRegistration: mocks.forget }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mocks.fetch }));

import { useContentSyncStore } from "../../store/content-sync";
import { useUserStateStore } from "../../store/user-state";
import { getUserStateStatus, readUserStateResponse, synchronizeUserState, resumeUserStateAfterRestore } from "./sync";
import { USER_STATE_MAX_BYTES } from "./types";

const binding = { serverUrl: "http://server", workspaceId: "workspace", epoch: "epoch" };
const work = { pluginId: "source", sourceNovelId: "book", novelPath: "/book", name: "Book" };
let local: UserStateCurrentSnapshot;
const posts = () => mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST");
const currentResponse = () => Response.json(local);

beforeEach(() => {
  vi.clearAllMocks();
  useContentSyncStore.setState({ serverUrl: "http://server", deviceName: "Tablet", deviceKey: null });
  useUserStateStore.setState({ enabledByServer: {}, runtimeByServer: {} });
  local = { version: 2, workspaceId: binding.workspaceId, epoch: binding.epoch,
    items: [{ entity: { kind: "reading", work, chapter: { chapterPath: "/chapter/1" } },
      value: { progress: 100, unread: false, readAt: 10 } }] };
  mocks.available.mockResolvedValue(undefined); mocks.resumeRestored.mockResolvedValue(undefined);
  mocks.getBinding.mockResolvedValue(binding);
  mocks.status.mockResolvedValue({ workspaceId: "workspace", epoch: "epoch", lastSuccessAt: 123, pausedAfterRestore: false });
  mocks.bind.mockResolvedValue(undefined);
  mocks.exportCurrent.mockImplementation(async () => structuredClone(local));
  mocks.apply.mockResolvedValue({ missingMetadataCount: 0, resumes: [] });
  mocks.register.mockResolvedValue("device-token");
  mocks.fetch.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/capabilities")) return Response.json({
      apiVersion: 1, packageVersion: 1, authentication: "device-key", personalStateSync: true,
      userStateVersion: 2, userStateCurrentVersion: 2,
    });
    if (path.endsWith("/user-state/current")) return currentResponse();
    throw new Error("Unexpected network endpoint: " + path);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("bulk current-state transport", () => {
  it("reads a small local summary without registration or network traffic", async () => {
    expect(await getUserStateStatus()).toEqual({ workspaceId: "workspace", epoch: "epoch", lastSuccessAt: 123, pausedAfterRestore: false });
    expect(mocks.status).toHaveBeenCalledExactlyOnceWith("http://server");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("coalesces concurrent calls and sends 5,505 current chapter values in one JSON exchange", async () => {
    local.items = Array.from({ length: 5505 }, (_, index) => ({
      entity: { kind: "reading", work, chapter: { chapterPath: "/chapter/" + index } },
      value: { progress: 100, unread: false, readAt: index + 1 },
    }));
    const first = synchronizeUserState();
    expect(synchronizeUserState()).toBe(first);
    await first;
    expect(mocks.bind).toHaveBeenCalledExactlyOnceWith(binding);
    expect(mocks.exportCurrent).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(binding, local);
    expect(posts()).toHaveLength(1);
    const body = JSON.parse(posts()[0]![1].body);
    expect(body.items).toHaveLength(5505);
    expect(body.items.every((item: object) => Object.keys(item).sort().join(",") === "entity,value")).toBe(true);
    expect(mocks.fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/api/v1/capabilities", "/api/v1/user-state/current",
    ]);
    expect(useUserStateStore.getState().runtimeByServer["http://server"].phase).toBe("idle");
  });

  it("obtains the workspace once on first use without creating per-record operations", async () => {
    mocks.getBinding.mockResolvedValue(null);
    await synchronizeUserState();
    expect(mocks.bind).toHaveBeenCalledExactlyOnceWith(binding);
    const calls = mocks.fetch.mock.calls.filter(([url]) => String(url).endsWith("/current"));
    expect(calls.map(([, init]) => init.method)).toEqual(["GET", "POST"]);
    expect(mocks.apply).toHaveBeenCalledTimes(1);
  });

  it("retries current values after a lost response without an operation journal", async () => {
    const original = mocks.fetch.getMockImplementation()!;
    let lost = false;
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const response = await original(url, init);
      if (init?.method === "POST" && !lost) { lost = true; throw new Error("connection lost after merge"); }
      return response;
    });
    await expect(synchronizeUserState()).rejects.toThrow("connection failed");
    expect(mocks.apply).not.toHaveBeenCalled();
    await synchronizeUserState();
    expect(posts()).toHaveLength(2);
    expect(posts()[0]![1].body).toBe(posts()[1]![1].body);
    expect(mocks.apply).toHaveBeenCalledTimes(1);
  });

  it("does not apply a late response after changing the server, even when changed back", async () => {
    const original = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const response = await original(url, init);
      if (init?.method === "POST") {
        useContentSyncStore.setState({ serverUrl: "http://other" });
        useContentSyncStore.setState({ serverUrl: "http://server" });
      }
      return response;
    });
    await expect(synchronizeUserState()).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(useUserStateStore.getState().runtimeByServer["http://server"].phase).toBe("idle");
  });

  it("rejects the old event protocol before extracting local values", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ userStateVersion: 1 }));
    await expect(synchronizeUserState()).rejects.toThrow("does not support");
    expect(mocks.bind).not.toHaveBeenCalled();
    expect(mocks.exportCurrent).not.toHaveBeenCalled();
  });

  it("rejects a foreign workspace before modifying the receiver", async () => {
    const original = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => init?.method === "POST"
      ? Response.json({ ...local, workspaceId: "another-workspace" }) : original(url, init));
    await expect(synchronizeUserState()).rejects.toThrow("workspace changed");
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("rejects malformed state before applying any partial data", async () => {
    const original = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => init?.method === "POST"
      ? Response.json({ ...local, items: [{ entity: { kind: "reading" }, value: { progress: "bad" } }] }) : original(url, init));
    await expect(synchronizeUserState()).rejects.toThrow();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("retains current data and clears only a rejected authentication cache", async () => {
    const original = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => init?.method === "POST"
      ? new Response(null, { status: 401 }) : original(url, init));
    await expect(synchronizeUserState()).rejects.toThrow();
    expect(mocks.forget).toHaveBeenCalledExactlyOnceWith("http://server", "device-token");
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("reports an oversized payload without reverting to thousands of tiny requests", async () => {
    local.items = [{ entity: { kind: "library", work: { ...work, name: "x".repeat(USER_STATE_MAX_BYTES) } },
      value: { inLibrary: true, addedAt: null } }];
    await expect(synchronizeUserState()).rejects.toThrow("upload size limit");
    expect(posts()).toHaveLength(0);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("honors the existing restore fence and resumes only through explicit reconnection", async () => {
    mocks.available.mockRejectedValueOnce(new Error("Sharing is paused after restore"));
    await expect(synchronizeUserState()).rejects.toThrow("paused after restore");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.exportCurrent).not.toHaveBeenCalled();
    await resumeUserStateAfterRestore();
    expect(mocks.resumeRestored).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledTimes(1);
  });

  it("cancels an exchange before applying the response", async () => {
    const controller = new AbortController();
    const original = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const response = await original(url, init);
      if (init?.method === "POST") controller.abort(new DOMException("Cancelled", "AbortError"));
      return response;
    });
    await expect(synchronizeUserState({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("bounds declared and chunked responses and rejects invalid UTF-8", async () => {
    await expect(readUserStateResponse(new Response("{}", { headers: { "content-length": String(USER_STATE_MAX_BYTES + 1) } }))).rejects.toThrow("size limit");
    const chunk = new Uint8Array(USER_STATE_MAX_BYTES / 2 + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(chunk); controller.enqueue(chunk); controller.close(); },
    });
    await expect(readUserStateResponse(new Response(stream))).rejects.toThrow("size limit");
    await expect(readUserStateResponse(new Response(new Uint8Array([0xff, 0xff])))).rejects.toThrow("valid JSON");
  });
});
