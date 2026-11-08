import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../../db/client", () => ({ getDb: vi.fn() }));
vi.mock("../../db/queries/content-sync", () => ({ writeContentSyncCache: vi.fn() }));
vi.mock("./client", async original => ({ ...await original<typeof import("./client")>(), contentServerRequest: vi.fn() }));
vi.mock("./works", () => ({ contentWorkId: async () => "work-id" }));

import { getDb } from "../../db/client";
import { writeContentSyncCache } from "../../db/queries/content-sync";
import { ContentServerError, contentServerRequest } from "./client";
import { reconcilePendingChapterNumbers } from "./chapter-number-reconciliation";
import { SERVER_CHAPTER_RENUMBER_PREFIX, type ServerChapterRenumberJob } from "../source-chapter-renumber";

const server = "https://content.test";
const identity = { pluginId: "source", novelId: "book", novelPath: "/book" };
const operationId = "f0efc615-1b66-418e-9445-f0441dbbed67";
const key = SERVER_CHAPTER_RENUMBER_PREFIX + operationId;
const memory = new Map<string, string>();
const initial = (): ServerChapterRenumberJob => ({
  version: 1, operationId, serverUrl: server, identity, createdAt: 100,
  mappings: [{ chapterPath: "/chapter/1000", from: "1000", to: "1" }],
  status: "pending",
});
const saved = () => JSON.parse(memory.get(key)!) as ServerChapterRenumberJob;
const snapshot = { work: { id: "work-id", revision: "before", identity }, chapters: [] };
const receipt = { operationId, work: { id: "work-id", metadata: { identity } }, updatedChapters: 1, updatedReadingStates: 1 };

beforeEach(() => {
  vi.clearAllMocks(); memory.clear(); memory.set(key, JSON.stringify(initial()));
  vi.mocked(getDb).mockResolvedValue({ select: async () => [...memory.values()].filter(payload => JSON.parse(payload).status === "pending").map(payload => ({ payload })) } as never);
  vi.mocked(writeContentSyncCache).mockImplementation(async (cacheKey, payload) => { memory.set(cacheKey, payload); });
  vi.mocked(contentServerRequest).mockImplementation(async (_server, path, _token, method, body) => {
    if (path === "/capabilities") return { chapterNumberReconciliationVersion: 1 };
    if (path.endsWith("/migration-snapshot")) return snapshot;
    if (path.endsWith("/reconcile-chapter-numbers")) {
      expect(method).toBe("POST");
      expect(saved().request).toEqual(body);
      return receipt;
    }
    throw new Error("Unexpected request " + path);
  });
});

it("persists the conditional request before sending and completes only after a matching receipt", async () => {
  await reconcilePendingChapterNumbers(server, "device");
  expect(saved()).toMatchObject({
    status: "completed",
    request: { operationId, expectedWorkRevision: "before", mappings: initial().mappings },
  });
  expect(vi.mocked(contentServerRequest).mock.calls.map(call => call[1])).toEqual([
    "/capabilities", "/works/work-id/migration-snapshot", "/works/work-id/reconcile-chapter-numbers",
  ]);
  await reconcilePendingChapterNumbers(server, "device");
  expect(contentServerRequest).toHaveBeenCalledTimes(3);
});

it("retries the exact saved operation and revision after an ambiguous response", async () => {
  let lostResponse = true;
  vi.mocked(contentServerRequest).mockImplementation(async (_server, path, _token, _method, body) => {
    if (path === "/capabilities") return { chapterNumberReconciliationVersion: 1 };
    if (path.endsWith("/migration-snapshot")) return snapshot;
    expect(body).toEqual(saved().request);
    if (lostResponse) { lostResponse = false; throw new Error("Response lost after server commit"); }
    return receipt;
  });
  await expect(reconcilePendingChapterNumbers(server, "device")).rejects.toThrow("Response lost");
  const request = structuredClone(saved().request);
  expect(saved().status).toBe("pending");
  vi.mocked(contentServerRequest).mockClear();
  await reconcilePendingChapterNumbers(server, "device");
  expect(contentServerRequest).toHaveBeenCalledExactlyOnceWith(
    server, "/works/work-id/reconcile-chapter-numbers", "device", "POST", request,
  );
  expect(saved().status).toBe("completed");
});

it("keeps the hold and original conditional request after a revision conflict", async () => {
  const request = { operationId, expectedWorkRevision: "before", mappings: initial().mappings };
  memory.set(key, JSON.stringify({ ...initial(), request }));
  vi.mocked(contentServerRequest).mockRejectedValue(new ContentServerError(409));
  await expect(reconcilePendingChapterNumbers(server, "device")).rejects.toMatchObject({ status: 409 });
  expect(saved()).toMatchObject({ status: "pending", request });
});

it("does not treat an unsupported endpoint as a missing work", async () => {
  vi.mocked(contentServerRequest).mockResolvedValue({ workMigrationVersion: 1 });
  await expect(reconcilePendingChapterNumbers(server, "device")).rejects.toThrow("Update the content server");
  expect(contentServerRequest).toHaveBeenCalledExactlyOnceWith(server, "/capabilities", "device");
  expect(saved().status).toBe("pending");
  expect(saved().request).toBeUndefined();
});

it("allows ordinary fresh upload when a capable server has no corresponding work", async () => {
  vi.mocked(contentServerRequest).mockImplementation(async (_server, path) => {
    if (path === "/capabilities") return { chapterNumberReconciliationVersion: 1 };
    throw new ContentServerError(404);
  });
  await reconcilePendingChapterNumbers(server, "device");
  expect(saved().status).toBe("completed");
  expect(vi.mocked(contentServerRequest).mock.calls.some(call => call[3] === "POST")).toBe(false);
});

it("holds a metadata-only pull without sending a server mutation", async () => {
  await expect(reconcilePendingChapterNumbers(server, "device", undefined, false)).rejects.toThrow("full content synchronization");
  expect(contentServerRequest).not.toHaveBeenCalled();
  expect(saved().status).toBe("pending");
});

it("rejects a receipt for a different work and retains the retry request", async () => {
  vi.mocked(contentServerRequest).mockImplementation(async (_server, path) => {
    if (path === "/capabilities") return { chapterNumberReconciliationVersion: 1 };
    if (path.endsWith("/migration-snapshot")) return snapshot;
    return { ...receipt, work: { ...receipt.work, metadata: { identity: { ...identity, novelId: "other" } } } };
  });
  await expect(reconcilePendingChapterNumbers(server, "device")).rejects.toThrow("receipt does not match");
  expect(saved().status).toBe("pending");
  expect(saved().request).toBeDefined();
});

it("refuses a stored mapping that would merge distinct old chapter numbers", async () => {
  memory.set(key, JSON.stringify({ ...initial(), mappings: [
    { chapterPath: "/first", from: "1000", to: "1" }, { chapterPath: "/second", from: "2000", to: "1" },
  ] }));
  await expect(reconcilePendingChapterNumbers(server, "device")).rejects.toThrow("mapping is invalid");
  expect(contentServerRequest).not.toHaveBeenCalled();
});
