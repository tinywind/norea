import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { snapshotAndroidContentChapter, installAndroidContentChapter } from "../android-storage";
import { isAndroidRuntime } from "../tauri-runtime";
import { fingerprintContentChapter, uploadContentChapter, withContentChapterStage, withDownloadedContentChapter, type CatalogEntry } from "./native";
import { runWorkContentStorageOperation } from "./storage-operation";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../android-storage", () => ({ snapshotAndroidContentChapter: vi.fn(), installAndroidContentChapter: vi.fn() }));
vi.mock("../tauri-runtime", () => ({ isAndroidRuntime: vi.fn() }));
const identity = { pluginId: "source", novelId: "book", novelPath: "/book" };
const entry: CatalogEntry = {
  id: "chapter", revision: "upload", fileBytes: 18, complete: true, deleted: false, sequence: 1,
  manifest: {
    packageVersion: 1, layout: "chapter-files", identity: { ...identity, chapterPath: "/one" },
    novel: { name: "Book", isLocal: false }, chapter: { name: "One", position: 1, page: "1", contentType: "html" },
    bodyPath: "content.html", files: [{ path: "content.html", size: 18, modifiedAt: 1 }],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(snapshotAndroidContentChapter).mockReset();
  vi.mocked(isAndroidRuntime).mockReturnValue(true);
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "content_sync_create_stage") return "/cache/content-sync/one";
    if (command === "content_sync_fingerprint") return "snapshot-fingerprint";
    return undefined;
  });
});

it("fingerprints and uploads one Android snapshot instead of copying the chapter twice", async () => {
  const storageDir = "contents/source/book/1";
  await withContentChapterStage({ storageDir, identity }, async stagePath => {
    expect(await fingerprintContentChapter({ storageDir, stagePath })).toBe("snapshot-fingerprint");
    await uploadContentChapter({ storageDir, stagePath, serverUrl: "http://server", token: "token", chapterId: 1, conflictPolicy: "replace-server",
      manifest: { packageVersion: 1, identity: { pluginId: "source", novelId: "book", novelPath: "/book", chapterPath: "/one" },
        novel: { name: "Book", isLocal: false }, chapter: { name: "One", position: 1, page: "1", contentType: "html" } } });
  });
  expect(snapshotAndroidContentChapter).toHaveBeenCalledExactlyOnceWith(storageDir, "/cache/content-sync/one");
  expect(invoke).toHaveBeenCalledWith("content_sync_fingerprint", { storageDir, stagePath: "/cache/content-sync/one" });
  expect(invoke).toHaveBeenCalledWith("content_sync_upload", expect.objectContaining({ stagePath: "/cache/content-sync/one", conflictPolicy: "replace-server" }));
  expect(vi.mocked(invoke).mock.calls.at(-1)).toEqual(["content_sync_remove_stage", { stagePath: "/cache/content-sync/one" }]);
});

it("removes the private snapshot after a failed transfer", async () => {
  await expect(withContentChapterStage({ storageDir: "contents/source/book/1", identity }, async () => {
    throw new Error("server offline");
  })).rejects.toThrow("server offline");
  expect(invoke).toHaveBeenCalledWith("content_sync_remove_stage", { stagePath: "/cache/content-sync/one" });
});

it.each([true, false])("discards a snapshot invalidated by a new download before upload (Android: %s)", async android => {
  vi.mocked(isAndroidRuntime).mockReturnValue(android);
  const controller = new AbortController();
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "content_sync_snapshot") controller.abort();
    return original(command, args);
  });
  vi.mocked(snapshotAndroidContentChapter).mockImplementationOnce(async () => { controller.abort(); });
  const upload = vi.fn();
  await expect(withContentChapterStage({ storageDir: "contents/source/book/1", identity, signal: controller.signal }, upload))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(upload).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledWith("content_sync_remove_stage", { stagePath: "/cache/content-sync/one" });
});

it("preserves native HTTP status and server rejection details for sync recovery", async () => {
  vi.mocked(invoke).mockRejectedValue("content sync: server returned 403: Device is blocked");
  await expect(uploadContentChapter({ storageDir: "contents/source/book/1", stagePath: "/stage", serverUrl: "http://server", token: "token", chapterId: 1, conflictPolicy: "replace-server",
    manifest: { packageVersion: 1, identity: { pluginId: "source", novelId: "book", novelPath: "/book", chapterPath: "/one" }, novel: { name: "Book", isLocal: false }, chapter: { name: "One", position: 1, page: "1", contentType: "html" } } }))
    .rejects.toMatchObject({ status: 403, message: "Device is blocked" });
});

it("releases the Windows work lock after the snapshot, before transferring it", async () => {
  vi.mocked(isAndroidRuntime).mockReturnValue(false);
  const storageDir = "contents/source/book/1";
  await withContentChapterStage({ storageDir, identity }, async () => {
    expect(invoke).toHaveBeenCalledWith("content_sync_snapshot", { storageDir, stagePath: "/cache/content-sync/one" });
    await runWorkContentStorageOperation(identity.pluginId, identity.novelPath, async () => undefined);
  });
  expect(snapshotAndroidContentChapter).not.toHaveBeenCalled();
});

it.each([true, false])("stages a download before publishing it and always removes the stage (Android: %s)", async android => {
  vi.mocked(isAndroidRuntime).mockReturnValue(android);
  const storageDir = "contents/source/book/1";
  await withDownloadedContentChapter({ serverUrl: "http://server", entry, storageDir, chapterId: 1 }, async (_sizes, install) => {
    expect(invoke).toHaveBeenCalledWith("content_sync_download", expect.objectContaining({ entry, storageDir, stagePath: "/cache/content-sync/one" }));
    expect(invoke).not.toHaveBeenCalledWith("content_sync_install", expect.anything());
    expect(installAndroidContentChapter).not.toHaveBeenCalled();
    await install(storageDir);
  });
  if (android) expect(installAndroidContentChapter).toHaveBeenCalledExactlyOnceWith(storageDir, "/cache/content-sync/one");
  else expect(invoke).toHaveBeenCalledWith("content_sync_install", { storageDir, stagePath: "/cache/content-sync/one" });
  expect(vi.mocked(invoke).mock.calls.at(-1)).toEqual(["content_sync_remove_stage", { stagePath: "/cache/content-sync/one" }]);
});

it("settles a cancelled transfer immediately and cleans its private files after the native request ends", async () => {
  const controller = new AbortController();
  let release!: () => void;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "content_sync_create_stage") return "/cache/content-sync/one";
    if (command === "content_sync_download") return new Promise(resolve => {
      release = () => resolve({ contentBytes: 10, mediaBytes: 0 });
    });
    return undefined;
  });
  const apply = vi.fn();
  let error: unknown;
  let settled = false;
  const input = { serverUrl: "http://server", entry, storageDir: "contents/source/book/1", chapterId: 1, signal: controller.signal };
  const download = withDownloadedContentChapter(input, apply).catch(reason => { error = reason; }).finally(() => { settled = true; });
  await vi.waitFor(() => expect(release).toEqual(expect.any(Function)));
  controller.abort(new DOMException("Deleted", "AbortError"));
  try {
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 100 });
    expect(error).toBe(controller.signal.reason);
    expect(invoke).not.toHaveBeenCalledWith("content_sync_remove_stage", expect.anything());
  } finally {
    release();
    await download;
  }
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("content_sync_remove_stage", { stagePath: "/cache/content-sync/one" }));
  expect(apply).not.toHaveBeenCalled();
});
