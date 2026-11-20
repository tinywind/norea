import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterCleanupCandidate } from "../../db/queries/chapter-cleanup";
import { cleanupServerUrl, fetchCleanupServerInventory, verifyServerCompleteChapter } from "./chapter-inventory";

const mocks = vi.hoisted(() => ({ request: vi.fn(), register: vi.fn(async () => "token"), state: { deviceName: "Device", lookupTimeoutSeconds: 10 } }));
vi.mock("../../store/content-sync", () => ({ useContentSyncStore: { getState: () => mocks.state } }));
vi.mock("./device", () => ({ registerContentDevice: mocks.register }));
vi.mock("./client", () => ({
  normalizeContentServerUrl: (value: string) => value.replace(/\/$/, ""),
  contentServerRequest: mocks.request,
  withContentServerLookup: (fn: (signal: AbortSignal) => unknown, _timeout: number, signal?: AbortSignal) => fn(signal ?? new AbortController().signal),
}));
const candidate = {
  identity: { novel: { id: 1, pluginId: "source", sourceNovelId: "work", path: "/work", name: "Work" }, chapter: { id: 3, name: "Chapter", position: 2, chapterNumber: "2", contentType: "html" } },
  novelPath: "/work", chapterPath: "/chapter", novelName: "Work", chapterName: "Chapter", serverSource: null,
} as ChapterCleanupCandidate;
const identity = { pluginId: "source", novelId: "work", novelPath: "/work", chapterPath: "/chapter" };
const inventory = { body: { sha256: "a".repeat(64), bytes: 3 }, expectedAssetKeys: [], storedAssets: [] };
const entry = { id: "package", revision: "revision-1", deleted: false, manifest: { identity, chapter: { chapterNumber: "2" } } };
const response = { revision: "revision-1", identity, inventory };

beforeEach(() => { vi.clearAllMocks(); mocks.request.mockResolvedValueOnce(entry).mockResolvedValueOnce(response); });
describe("server cleanup inventory boundary", () => {
  it("pins server URL, package identity and revision in the inventory request", async () => {
    const result = await fetchCleanupServerInventory(candidate, "https://server");
    expect(result).toMatchObject({ serverUrl: "https://server", id: "package", revision: "revision-1", inventory });
    expect(mocks.request.mock.calls[1]![1]).toBe("/chapters/package/storage-inventory?revision=revision-1");
    expect(cleanupServerUrl({ ...candidate, serverSource: '{"serverUrl":"https://saved/","workId":"work"}' }, "https://fallback")).toBe("https://saved");
  });
  it("uses an unavailable catalog lookup only to obtain a body-only inventory", async () => {
    mocks.request.mockReset().mockResolvedValueOnce(entry).mockResolvedValueOnce({ ...response, inventory: { body: inventory.body, expectedAssetKeys: null, storedAssets: [] } });
    await fetchCleanupServerInventory(candidate, "https://server", undefined, true);
    expect(mocks.request.mock.calls[0]![1]).toContain("includeUnavailable=true");
    expect(mocks.request.mock.calls[1]![1]).toContain("&presenceOnly=true");
  });
  it("does not let unexpected DTO fields replace the catalog identity or server URL", async () => {
    mocks.request.mockReset().mockResolvedValueOnce(entry).mockResolvedValueOnce({ ...response, id: "other-package", serverUrl: "https://other" });
    expect(await fetchCleanupServerInventory(candidate, "https://server")).toMatchObject({ id: "package", serverUrl: "https://server" });
  });
  it.each([
    ["changed revision", { ...response, revision: "revision-2" }],
    ["different identity", { ...response, identity: { ...identity, chapterPath: "/other" } }],
    ["malformed inventory", { ...response, inventory: { ...inventory, storedAssets: [{ key: "../bad", bytes: 1, sha256: "x" }] } }],
  ])("rejects %s", async (_label, invalid) => {
    mocks.request.mockReset().mockResolvedValueOnce(entry).mockResolvedValueOnce(invalid);
    await expect(fetchCleanupServerInventory(candidate, "https://server")).rejects.toThrow();
  });
  it.each([
    ["deleted package", { ...entry, deleted: true }],
    ["wrong work", { ...entry, manifest: { ...entry.manifest, identity: { ...identity, novelId: "other" } } }],
    ["wrong chapter", { ...entry, manifest: { identity: { ...identity, chapterPath: "/other" }, chapter: { chapterNumber: "9" } } }],
  ])("rejects %s before inventory lookup", async (_label, invalid) => {
    mocks.request.mockReset().mockResolvedValueOnce(invalid);
    await expect(fetchCleanupServerInventory(candidate, "https://server")).rejects.toThrow();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("propagates unavailable and missing server failures", async () => {
    const failure = new Error("404 or unavailable");
    mocks.request.mockReset().mockRejectedValueOnce(failure);
    await expect(fetchCleanupServerInventory(candidate, "https://server")).rejects.toBe(failure);
  });
  it("reports noMediaDeclared only when manifest files omit both manifest.json and media.zip", async () => {
    const textEntry = { ...entry, manifest: { ...entry.manifest, bodyPath: "content.html", files: [{ path: "content.html", size: 120, modifiedAt: 1 }] } };
    mocks.request.mockReset().mockResolvedValueOnce(textEntry).mockResolvedValueOnce(response);
    expect((await fetchCleanupServerInventory(candidate, "https://server")).noMediaDeclared).toBe(true);

    const mediaEntry = { ...entry, manifest: { ...entry.manifest, bodyPath: "content.html", files: [{ path: "content.html", size: 120, modifiedAt: 1 }, { path: "manifest.json", size: 50, modifiedAt: 1 }] } };
    mocks.request.mockReset().mockResolvedValueOnce(mediaEntry).mockResolvedValueOnce(response);
    expect((await fetchCleanupServerInventory(candidate, "https://server")).noMediaDeclared).toBe(false);
  });
});

describe("verifyServerCompleteChapter", () => {
  const completeEntry = {
    id: "package",
    revision: "revision-1",
    complete: true,
    deleted: false,
    manifest: {
      identity,
      chapter: { chapterNumber: "2" },
      bodyPath: "content.html",
      files: [{ path: "content.html", size: 42, modifiedAt: 1 }],
    },
  };

  it("verifies complete non-empty catalog chapters with a single /catalog/chapter call", async () => {
    mocks.request.mockReset().mockResolvedValueOnce(completeEntry);
    const result = await verifyServerCompleteChapter(candidate, "https://server");
    expect(result).toEqual({
      ok: true,
      chapter: { serverUrl: "https://server", id: "package", revision: "revision-1" },
    });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls[0]![1]).toMatch(/^\/catalog\/chapter\?/);
  });

  it("allows chapterNumber fallback only for norea-folder:<N> aliases and rejects unrelated paths", async () => {
    const folderEntry = {
      ...completeEntry,
      manifest: {
        ...completeEntry.manifest,
        identity: { ...identity, chapterPath: "norea-folder:2" },
      },
    };
    mocks.request.mockReset().mockResolvedValueOnce(folderEntry);
    expect(await verifyServerCompleteChapter(candidate, "https://server")).toMatchObject({ ok: true });

    const differentRealPath = {
      ...completeEntry,
      manifest: {
        ...completeEntry.manifest,
        identity: { ...identity, chapterPath: "/other-chapter-same-number" },
      },
    };
    mocks.request.mockReset().mockResolvedValueOnce(differentRealPath);
    await expect(verifyServerCompleteChapter(candidate, "https://server")).rejects.toThrow("identity does not match");
  });

  it("returns not-complete when entry.complete is false or body file is missing/empty, and server-missing when deleted", async () => {
    mocks.request.mockReset().mockResolvedValueOnce({ ...completeEntry, complete: false });
    expect(await verifyServerCompleteChapter(candidate, "https://server")).toEqual({ ok: false, reason: "not-complete" });

    mocks.request.mockReset().mockResolvedValueOnce({
      ...completeEntry,
      manifest: { ...completeEntry.manifest, files: [{ path: "content.html", size: 0, modifiedAt: 1 }] },
    });
    expect(await verifyServerCompleteChapter(candidate, "https://server")).toEqual({ ok: false, reason: "not-complete" });

    mocks.request.mockReset().mockResolvedValueOnce({ ...completeEntry, deleted: true });
    expect(await verifyServerCompleteChapter(candidate, "https://server")).toEqual({ ok: false, reason: "server-missing" });
  });
});
