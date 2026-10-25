import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ settings: { serverUrl: "http://server", deviceName: "Tablet" }, setLastReadChapter: vi.fn() }));
vi.mock("../../db/queries/reading-state", () => ({ applyReadingStateBatch: vi.fn(), listReadingStatePage: vi.fn(), READING_STATE_BATCH_SIZE: 200 }));
vi.mock("../../store/content-sync", () => ({ useContentSyncStore: { getState: () => mocks.settings } }));
vi.mock("../../store/reader", () => ({ useReaderStore: { getState: () => ({ setLastReadChapter: mocks.setLastReadChapter }) } }));
vi.mock("./client", () => ({ contentServerRequest: vi.fn(), normalizeContentServerUrl: (value: string) => value.replace(/\/+$/, "") }));
vi.mock("./device", () => ({ registerContentDevice: vi.fn(async () => "device-token") }));

import { applyReadingStateBatch, listReadingStatePage } from "../../db/queries/reading-state";
import { contentServerRequest } from "./client";
import { registerContentDevice } from "./device";
import { createReadingSyncKey, readReadingSyncKey, readingStateUploadBatches, saveReadingSyncKey, syncReadingState } from "./reading-state";
import { mergeReadingState, type ReadingStateEntry } from "./reading-state-model";

const syncKey = "a".repeat(64);
const capabilities = { apiVersion: 1, packageVersion: 1, authentication: "device-key", personalStateSync: true, readingStateVersion: 1 };
const entry: ReadingStateEntry = { pluginId: "source", sourceNovelId: "book", novelPath: "/book", chapterPath: "/1", chapterNumber: "1", page: "1", unread: false, progress: 100, bookmark: false, readAt: 200 };
const storage = new Map<string, string>();
beforeEach(() => {
  vi.clearAllMocks(); storage.clear(); mocks.settings.serverUrl = "http://server";
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  saveReadingSyncKey("http://server", syncKey);
  vi.mocked(listReadingStatePage).mockResolvedValue({ entries: [entry], nextId: null });
  vi.mocked(applyReadingStateBatch).mockResolvedValue({ updated: 1, skipped: 0, lastReadChapters: [{ novelId: 3, chapterId: 7 }] });
  vi.mocked(contentServerRequest).mockImplementation(async (_server, path) => {
    if (path === "/capabilities") return capabilities;
    if (path === "/reading-state/merge") return { received: 1, updated: 1, total: 1 };
    if (path === "/reading-state/read") return { entries: [entry], total: 1, nextOffset: null };
    throw new Error(`Unexpected endpoint: ${path}`);
  });
});
afterEach(() => vi.unstubAllGlobals());

it("keeps the private key separate from device credentials and scopes it to the saved server", () => {
  expect(createReadingSyncKey()).toMatch(/^[0-9a-f]{64}$/);
  expect(readReadingSyncKey("http://server/")).toBe(syncKey);
  expect(readReadingSyncKey("http://other-server")).toBe("");
  expect(() => saveReadingSyncKey("http://server", "guessable")).toThrow("invalidKey");
  expect(readReadingSyncKey("http://server")).toBe(syncKey);
});

it("imports without uploading and updates the resume-reading chapter", async () => {
  expect(await syncReadingState("http://server", syncKey, "pull")).toEqual({ uploaded: 0, downloaded: 1, serverUpdated: 0, localUpdated: 1, skipped: 0 });
  expect(listReadingStatePage).not.toHaveBeenCalled();
  expect(applyReadingStateBatch).toHaveBeenCalledWith([entry], expect.any(Function));
  expect(mocks.setLastReadChapter).toHaveBeenCalledWith(3, 7);
  expect(contentServerRequest).toHaveBeenCalledWith("http://server", "/reading-state/read", "device-token", "POST", { syncKey, offset: 0, limit: 200 }, undefined);
});

it("sends without modifying local state, and a two-way merge sends before importing", async () => {
  expect((await syncReadingState("http://server", syncKey, "push")).uploaded).toBe(1);
  expect(applyReadingStateBatch).not.toHaveBeenCalled();
  vi.mocked(contentServerRequest).mockClear();
  const result = await syncReadingState("http://server", syncKey, "merge");
  expect(result).toMatchObject({ uploaded: 1, downloaded: 1, localUpdated: 1 });
  expect(vi.mocked(contentServerRequest).mock.calls.map(call => call[1])).toEqual(["/capabilities", "/reading-state/merge", "/reading-state/read"]);
});

it("does not reveal the private key or register a device on an older server", async () => {
  vi.mocked(contentServerRequest).mockResolvedValue({ ...capabilities, personalStateSync: false });
  await expect(syncReadingState("http://server", syncKey, "merge")).rejects.toThrow("unsupported");
  expect(registerContentDevice).not.toHaveBeenCalled();
  expect(contentServerRequest).toHaveBeenCalledExactlyOnceWith("http://server", "/capabilities", undefined, "GET", undefined, undefined);
  expect(applyReadingStateBatch).not.toHaveBeenCalled();
});

it("stops a pull after the server changes and refuses malformed or non-advancing pages", async () => {
  vi.mocked(contentServerRequest).mockImplementation(async (_server, path) => {
    if (path === "/capabilities") return capabilities;
    mocks.settings.serverUrl = "http://other";
    return { entries: [entry], total: 1, nextOffset: null };
  });
  await expect(syncReadingState("http://server", syncKey, "pull")).rejects.toThrow("changed");
  expect(applyReadingStateBatch).not.toHaveBeenCalled();
  mocks.settings.serverUrl = "http://server";
  vi.mocked(contentServerRequest).mockImplementation(async (_server, path) => path === "/capabilities" ? capabilities : { entries: [entry], total: 2, nextOffset: 0 });
  await expect(syncReadingState("http://server", syncKey, "pull")).rejects.toThrow("invalidResponse");
  expect(applyReadingStateBatch).not.toHaveBeenCalled();
});

it("bounds upload payloads by bytes as well as chapter count", () => {
  const entries = Array.from({ length: 200 }, () => ({ ...entry, novelPath: "/" + "\uAC00".repeat(15000), chapterPath: "/" + "\uAC00".repeat(15000) }));
  const batches = readingStateUploadBatches(entries);
  expect(batches.length).toBeGreaterThan(1);
  expect(batches.flat()).toHaveLength(200);
  for (const batch of batches) expect(new TextEncoder().encode(JSON.stringify({ syncKey, entries: batch })).length).toBeLessThan(512 * 1024);
});

it("uses an idempotent, commutative safe merge rather than metadata modification time", () => {
  const first = { progress: 100, unread: false, bookmark: false, readAt: 100 };
  const second = { progress: 20, unread: true, bookmark: true, readAt: 200 };
  const merged = mergeReadingState(first, second);
  expect(merged).toEqual({ progress: 100, unread: false, bookmark: true, readAt: 200 });
  expect(mergeReadingState(second, first)).toEqual(merged);
  expect(mergeReadingState(merged, second)).toEqual(merged);
});
