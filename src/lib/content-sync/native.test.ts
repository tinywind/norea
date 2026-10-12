import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { snapshotAndroidContentChapter, installAndroidContentChapter } from "../android-storage";
import { isAndroidRuntime } from "../tauri-runtime";
import { fingerprintContentChapter, uploadContentChapter, withContentChapterStage, withDownloadedContentChapter } from "./native";
import { runWorkContentStorageOperation } from "./storage-operation";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../android-storage", () => ({ snapshotAndroidContentChapter: vi.fn(), installAndroidContentChapter: vi.fn() }));
vi.mock("../tauri-runtime", () => ({ isAndroidRuntime: vi.fn() }));
const identity = { pluginId: "source", novelPath: "/book" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAndroidRuntime).mockReturnValue(true);
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "content_sync_create_stage") return "/cache/content-sync/one";
    if (command === "content_sync_fingerprint") return "snapshot-hash";
    return undefined;
  });
});

it("hashes and uploads one Android snapshot instead of copying the chapter twice", async () => {
  const storageDir = "contents/source/Book/1-One";
  await withContentChapterStage({ storageDir, identity }, async stagePath => {
    expect(await fingerprintContentChapter({ storageDir, stagePath })).toBe("snapshot-hash");
    await uploadContentChapter({ storageDir, stagePath, serverUrl: "http://server", token: "token", chapterId: 1,
      manifest: { packageVersion: 1, identity: { pluginId: "source", novelPath: "/book", chapterPath: "/one" },
        novel: { name: "Book", isLocal: false }, chapter: { name: "One", position: 1, page: "1", contentType: "html" } } });
  });
  expect(snapshotAndroidContentChapter).toHaveBeenCalledExactlyOnceWith(storageDir, "/cache/content-sync/one");
  expect(invoke).toHaveBeenCalledWith("content_sync_fingerprint", { storageDir, stagePath: "/cache/content-sync/one" });
  expect(invoke).toHaveBeenCalledWith("content_sync_upload", expect.objectContaining({ stagePath: "/cache/content-sync/one" }));
  expect(vi.mocked(invoke).mock.calls.at(-1)).toEqual(["content_sync_remove_stage", { stagePath: "/cache/content-sync/one" }]);
});

it("removes the private snapshot after a failed transfer", async () => {
  await expect(withContentChapterStage({ storageDir: "contents/source/Book/1-One", identity }, async () => {
    throw new Error("server offline");
  })).rejects.toThrow("server offline");
  expect(invoke).toHaveBeenCalledWith("content_sync_remove_stage", { stagePath: "/cache/content-sync/one" });
});

it("releases the Windows work lock after the snapshot, before transferring it", async () => {
  vi.mocked(isAndroidRuntime).mockReturnValue(false);
  const storageDir = "contents/source/Book/1-One";
  await withContentChapterStage({ storageDir, identity }, async () => {
    expect(invoke).toHaveBeenCalledWith("content_sync_snapshot", { storageDir, stagePath: "/cache/content-sync/one" });
    await runWorkContentStorageOperation(identity.pluginId, identity.novelPath, async () => undefined);
  });
  expect(snapshotAndroidContentChapter).not.toHaveBeenCalled();
});

it.each([true, false])("stages a download before publishing it and always removes the stage (Android: %s)", async android => {
  vi.mocked(isAndroidRuntime).mockReturnValue(android);
  const storageDir = "contents/source/Book/1-One";
  await withDownloadedContentChapter({ serverUrl: "http://server", entry: {} as never, storageDir, chapterId: 1 }, async (_sizes, install) => {
    expect(invoke).toHaveBeenCalledWith("content_sync_download", expect.objectContaining({ storageDir, stagePath: "/cache/content-sync/one" }));
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
  const input = { serverUrl: "http://server", entry: {} as never, storageDir: "contents/source/Book/1-One", chapterId: 1, signal: controller.signal };
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
