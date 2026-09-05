import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  clearAndroidStorageRoot,
  copyAndroidContentUriToTempFile,
  deleteAndroidContentUriTempFile,
  describeAndroidContentUri,
  inspectAndroidChapterArtifacts,
  inspectAndroidNovelCover,
  finalizeAndroidChapterStorageTransfer,
  prepareAndroidChapterStorageTransfer,
  prepareAndroidReaderMediaCache,
  readAndroidStorageText,
  removeAndroidChapterStorageDirectory,
  rollbackAndroidChapterStorageTransfer,
  selectAndroidStorageRoot,
  writeAndroidContentUriFile,
  writeAndroidStorageText,
} from "./android-storage";

type TestBridge = {
  deleteRootChildren?: ReturnType<typeof vi.fn>;
  deletePath?: ReturnType<typeof vi.fn>;
  deleteTempFile?: ReturnType<typeof vi.fn>;
  describeContentUri?: ReturnType<typeof vi.fn>;
  ensureNoMedia?: ReturnType<typeof vi.fn>;
  inspectChapterArtifacts?: ReturnType<typeof vi.fn>;
  inspectNovelCover?: ReturnType<typeof vi.fn>;
  finalizeChapterStorageTransfer?: ReturnType<typeof vi.fn>;
  pickMediaStorageRoot?: ReturnType<typeof vi.fn>;
  prepareChapterStorageTransfer?: ReturnType<typeof vi.fn>;
  prepareReaderMediaCache?: ReturnType<typeof vi.fn>;
  readContentUriFile?: ReturnType<typeof vi.fn>;
  readText?: ReturnType<typeof vi.fn>;
  removeChapterStorageDirectory?: ReturnType<typeof vi.fn>;
  rollbackChapterStorageTransfer?: ReturnType<typeof vi.fn>;
  writeBytes?: ReturnType<typeof vi.fn>;
  writeContentUriFile?: ReturnType<typeof vi.fn>;
  writeContentUriFileCapped?: ReturnType<typeof vi.fn>;
  writeText?: ReturnType<typeof vi.fn>;
};

const invokeMock = vi.mocked(invoke);

function installBridge(bridge: TestBridge): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __NoreaAndroidStorage: bridge,
    },
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  installBridge({});
});

describe("android storage bridge facade", () => {
  it("prefers capped file writes when the Android bridge exposes them", async () => {
    const legacyWrite = vi.fn(() => JSON.stringify({ ok: true }));
    const cappedWrite = vi.fn(() =>
      JSON.stringify({ bytes: 12, ok: true }),
    );
    installBridge({
      writeContentUriFile: legacyWrite,
      writeContentUriFileCapped: cappedWrite,
    });

    await writeAndroidContentUriFile(
      "content://backup",
      "/data/user/0/io.github.tinywind.norea/cache/backup/export.zip",
      "application/zip",
      4096,
    );

    expect(cappedWrite).toHaveBeenCalledWith(
      "content://backup",
      "/data/user/0/io.github.tinywind.norea/cache/backup/export.zip",
      "application/zip",
      "4096",
    );
    expect(legacyWrite).not.toHaveBeenCalled();
  });

  it("falls back to legacy content URI file writes", async () => {
    const legacyWrite = vi.fn(() =>
      JSON.stringify({ bytes: 12, ok: true }),
    );
    installBridge({
      writeContentUriFile: legacyWrite,
    });

    await writeAndroidContentUriFile(
      "content://backup",
      "/cache/export.zip",
      "application/zip",
    );

    expect(legacyWrite).toHaveBeenCalledWith(
      "content://backup",
      "/cache/export.zip",
      "application/zip",
    );
  });

  it("copies content URIs into Android temp files when supported", async () => {
    const readContentUriFile = vi.fn(() =>
      JSON.stringify({
        bytes: 3,
        mimeType: "application/zip",
        ok: true,
        path: "/data/user/0/io.github.tinywind.norea/cache/android-storage-bridge/content.tmp",
      }),
    );
    installBridge({ readContentUriFile });

    await expect(
      copyAndroidContentUriToTempFile("content://backup", 8192),
    ).resolves.toEqual({
      bytes: 3,
      mimeType: "application/zip",
      path: "/data/user/0/io.github.tinywind.norea/cache/android-storage-bridge/content.tmp",
    });
    expect(readContentUriFile).toHaveBeenCalledWith("content://backup", "8192");
  });

  it("describes content URIs through the Android storage bridge", async () => {
    const describeContentUri = vi.fn(() =>
      JSON.stringify({
        fileName: "Book.epub",
        mimeType: "application/epub+zip",
        ok: true,
        size: 42,
      }),
    );
    installBridge({ describeContentUri });

    await expect(
      describeAndroidContentUri("content://documents/Book.epub"),
    ).resolves.toEqual({
      fileName: "Book.epub",
      mimeType: "application/epub+zip",
      size: 42,
    });
    expect(describeContentUri).toHaveBeenCalledWith(
      "content://documents/Book.epub",
    );
  });

  it("keeps opened-file methods bound to the injected Android bridge", async () => {
    const bridge: TestBridge = {};
    const describeContentUri = vi.fn(function (
      this: TestBridge,
      _uri: string,
    ) {
      if (this !== bridge) throw new Error("missing injected bridge receiver");
      return JSON.stringify({
        fileName: "Manual.pdf",
        mimeType: "application/pdf",
        ok: true,
        size: 4,
      });
    });
    const readContentUriFile = vi.fn(function (
      this: TestBridge,
      _uri: string,
      _maxBytes: string,
    ) {
      if (this !== bridge) throw new Error("missing injected bridge receiver");
      return JSON.stringify({
        bytes: 4,
        mimeType: "application/pdf",
        ok: true,
        path: "/cache/android-storage-bridge/manual.tmp",
      });
    });
    bridge.describeContentUri = describeContentUri;
    bridge.readContentUriFile = readContentUriFile;
    installBridge(bridge);

    await expect(
      describeAndroidContentUri("content://documents/Manual.pdf"),
    ).resolves.toMatchObject({
      fileName: "Manual.pdf",
      mimeType: "application/pdf",
      size: 4,
    });
    await expect(
      copyAndroidContentUriToTempFile(
        "content://documents/Manual.pdf",
        8192,
      ),
    ).resolves.toMatchObject({
      bytes: 4,
      mimeType: "application/pdf",
    });
  });

  it("returns null for temp file reads when the bridge lacks the method", async () => {
    installBridge({});

    await expect(
      copyAndroidContentUriToTempFile("content://backup"),
    ).resolves.toBeNull();
  });

  it("deletes Android temp files when the bridge exposes cleanup", async () => {
    const deleteTempFile = vi.fn(() => JSON.stringify({ ok: true }));
    installBridge({ deleteTempFile });

    await deleteAndroidContentUriTempFile("/cache/android-storage-bridge/a.tmp");

    expect(deleteTempFile).toHaveBeenCalledWith(
      "/cache/android-storage-bridge/a.tmp",
    );
  });

  it("ensures .nomedia once while reading from the selected storage root", async () => {
    const root = "content://tree/primary%3ANoreaRead";
    const ensureNoMedia = vi.fn(() => JSON.stringify({ ok: true }));
    const readText = vi.fn((requestId: string) => {
      queueMicrotask(() => {
        window.__lnrResolveAndroidStorageOperation?.(
          requestId,
          JSON.stringify({ ok: true, text: "<html></html>" }),
        );
      });
    });
    invokeMock.mockResolvedValue(root);
    installBridge({ ensureNoMedia, readText });

    await expect(
      readAndroidStorageText("contents/demo/chapter/content.html"),
    ).resolves.toBe("<html></html>");
    await expect(
      readAndroidStorageText("contents/demo/chapter/content.html"),
    ).resolves.toBe("<html></html>");

    expect(invokeMock).toHaveBeenCalledWith("chapter_media_get_storage_root");
    expect(ensureNoMedia).toHaveBeenCalledOnce();
    expect(ensureNoMedia).toHaveBeenCalledWith(root);
    expect(readText).toHaveBeenCalledTimes(2);
    expect(readText).toHaveBeenLastCalledWith(
      expect.any(String),
      root,
      "contents/demo/chapter/content.html",
    );
  });

  it("keeps storage writes pending until the asynchronous callback arrives", async () => {
    const root = "content://tree/primary%3ANoreaWrite";
    const ensureNoMedia = vi.fn(() => JSON.stringify({ ok: true }));
    let requestId = "";
    const writeText = vi.fn((candidateRequestId: string) => {
      requestId = candidateRequestId;
    });
    invokeMock.mockResolvedValue(root);
    installBridge({ ensureNoMedia, writeText });

    const write = writeAndroidStorageText(
      "contents/demo/chapter/content.html",
      "<html></html>",
    );

    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    let settled = false;
    void write.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    window.__lnrResolveAndroidStorageOperation?.(
      requestId,
      JSON.stringify({ bytes: 13, ok: true }),
    );

    await expect(write).resolves.toBeUndefined();
  });

  it("resolves chapter artifact inspections through an asynchronous callback", async () => {
    const root = "content://tree/primary%3ANoreaInspect";
    const ensureNoMedia = vi.fn(() => JSON.stringify({ ok: true }));
    let requestId = "";
    const inspectChapterArtifacts = vi.fn((candidateRequestId: string) => {
      requestId = candidateRequestId;
    });
    invokeMock.mockResolvedValue(root);
    installBridge({ ensureNoMedia, inspectChapterArtifacts });

    const inspection = inspectAndroidChapterArtifacts({
      chapterIdentityPrefix: "1-",
      novelIdentitySuffix: "-novel-1",
      preferredChapterDir: "contents/demo/Novel-novel-1/1-Chapter",
      preferredContentFileName: "content.html",
      sourceDir: "contents/demo",
    });

    await vi.waitFor(() => expect(inspectChapterArtifacts).toHaveBeenCalled());
    expect(inspectChapterArtifacts).toHaveBeenCalledWith(
      expect.any(String),
      root,
      "contents/demo/Novel-novel-1/1-Chapter",
      "contents/demo",
      "-novel-1",
      "1-",
      "content.html",
    );

    let settled = false;
    void inspection.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    window.__lnrResolveAndroidChapterArtifacts?.(
      requestId,
      JSON.stringify({
        contentBytes: 12,
        contentFile: "contents/demo/Novel-novel-1/1-Chapter/content.html",
        mediaBytes: 3,
        ok: true,
        status: "present",
      }),
    );

    await expect(inspection).resolves.toEqual({
      contentBytes: 12,
      contentFile: "contents/demo/Novel-novel-1/1-Chapter/content.html",
      mediaBytes: 3,
      status: "present",
    });
  });

  it(
    "resolves and caches identical novel cover inspections through an asynchronous callback",
    async () => {
      const root = "content://tree/primary%3ANoreaCover";
      const ensureNoMedia = vi.fn(() => JSON.stringify({ ok: true }));
      let requestId = "";
      const inspectNovelCover = vi.fn((candidateRequestId: string) => {
        requestId = candidateRequestId;
      });
      const response = JSON.stringify({
        manifest: JSON.stringify({ fileName: "cover.jpg", version: 1 }),
        ok: true,
        relativePath: "contents/demo/Old-title-novel-1/cover.jpg",
        status: "present",
      });
      invokeMock.mockResolvedValue(root);
      installBridge({ ensureNoMedia, inspectNovelCover });

      const input = {
        expectedSourceUrl: "https://source.test/cover.jpg",
        novelPath: "/novel/1",
        novelIdentitySuffix: "-novel-1",
        preferredNovelDir: "contents/demo/New-title-novel-1",
        sourceId: "demo",
        sourceDir: "contents/demo",
      };
      const inspection = inspectAndroidNovelCover(input);
      const duplicateInspection = inspectAndroidNovelCover(input);

      expect(duplicateInspection).toBe(inspection);
      await vi.waitFor(() => expect(inspectNovelCover).toHaveBeenCalled());
      expect(inspectNovelCover).toHaveBeenCalledWith(
        expect.any(String),
        root,
        "contents/demo/New-title-novel-1",
        "contents/demo",
        "-novel-1",
        "demo",
        "/novel/1",
        "https://source.test/cover.jpg",
      );

      let settled = false;
      void inspection.finally(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      window.__lnrResolveAndroidNovelCover?.(requestId, response);

      const expected = {
        manifest: JSON.stringify({ fileName: "cover.jpg", version: 1 }),
        relativePath: "contents/demo/Old-title-novel-1/cover.jpg",
      };
      await expect(inspection).resolves.toEqual(expected);
      await expect(duplicateInspection).resolves.toEqual(expected);
      await expect(inspectAndroidNovelCover(input)).resolves.toEqual(expected);
      expect(inspectNovelCover).toHaveBeenCalledTimes(1);
    },
  );

  it("returns null when the Android bridge finds no stored novel cover", async () => {
    const ensureNoMedia = vi.fn(() => JSON.stringify({ ok: true }));
    let requestId = "";
    const inspectNovelCover = vi.fn((candidateRequestId: string) => {
      requestId = candidateRequestId;
    });
    invokeMock.mockResolvedValue("content://tree/primary%3ANoreaCover");
    installBridge({ ensureNoMedia, inspectNovelCover });

    const inspection = inspectAndroidNovelCover({
      expectedSourceUrl: null,
      novelPath: "/novel/1",
      novelIdentitySuffix: "-novel-1",
      preferredNovelDir: "contents/demo/New-title-novel-1",
      sourceId: "demo",
      sourceDir: "contents/demo",
    });
    await vi.waitFor(() => expect(inspectNovelCover).toHaveBeenCalled());
    window.__lnrResolveAndroidNovelCover?.(
      requestId,
      JSON.stringify({ ok: true, status: "missing" }),
    );

    await expect(inspection).resolves.toBeNull();
  });

  it("propagates Android novel cover inspection failures", async () => {
    const ensureNoMedia = vi.fn(() => JSON.stringify({ ok: true }));
    let requestId = "";
    const inspectNovelCover = vi.fn((candidateRequestId: string) => {
      requestId = candidateRequestId;
    });
    invokeMock.mockResolvedValue("content://tree/primary%3ANoreaCover");
    installBridge({ ensureNoMedia, inspectNovelCover });

    const inspection = inspectAndroidNovelCover({
      expectedSourceUrl: "https://source.test/cover.jpg",
      novelPath: "/novel/1",
      novelIdentitySuffix: "-novel-1",
      preferredNovelDir: "contents/demo/New-title-novel-1",
      sourceId: "demo",
      sourceDir: "contents/demo",
    });
    await vi.waitFor(() => expect(inspectNovelCover).toHaveBeenCalled());
    window.__lnrResolveAndroidNovelCover?.(
      requestId,
      JSON.stringify({
        error: "Multiple stored novel cover folders match -novel-1",
        ok: false,
      }),
    );

    await expect(inspection).rejects.toThrow(
      "Multiple stored novel cover folders match -novel-1",
    );
  });

  it("runs chapter storage transfers through asynchronous bridge callbacks", async () => {
    const root = "content://tree/primary%3ANoreaTransfer";
    const ensureNoMedia = vi.fn(() => JSON.stringify({ ok: true }));
    const requests = new Map<string, string>();
    const prepareChapterStorageTransfer = vi.fn(
      (requestId: string, _rootUri: string, payload: string) => {
        requests.set("prepare", requestId);
        expect(JSON.parse(payload)).toEqual([
          {
            entryId: "chapter-1",
            sourceRelativeDir: "contents/source-a/Novel-a/1-Opening",
            targetRelativeDir: "contents/source-b/Novel-b/1-Opening",
          },
        ]);
      },
    );
    const finalizeChapterStorageTransfer = vi.fn((requestId: string) => {
      requests.set("finalize", requestId);
    });
    const rollbackChapterStorageTransfer = vi.fn((requestId: string) => {
      requests.set("rollback", requestId);
    });
    const removeChapterStorageDirectory = vi.fn((requestId: string) => {
      requests.set("remove", requestId);
    });
    invokeMock.mockResolvedValue(root);
    installBridge({
      ensureNoMedia,
      finalizeChapterStorageTransfer,
      prepareChapterStorageTransfer,
      removeChapterStorageDirectory,
      rollbackChapterStorageTransfer,
    });
    const entries = [
      {
        entryId: "chapter-1",
        sourceRelativeDir: "contents/source-a/Novel-a/1-Opening",
        targetRelativeDir: "contents/source-b/Novel-b/1-Opening",
      },
    ];
    const preparation = {
      entries: [
        {
          ...entries[0]!,
          contentBytes: 12,
          contentFile: "contents/source-b/Novel-b/1-Opening/content.html",
          mediaBytes: 3,
          outcome: "copiedSource" as const,
          replacedTarget: false,
        },
      ],
      token: "transfer-token",
    };

    const prepared = prepareAndroidChapterStorageTransfer(entries);
    await vi.waitFor(() => expect(requests.get("prepare")).toBeTruthy());
    window.__lnrResolveAndroidChapterStorageTransfer?.(
      requests.get("prepare")!,
      JSON.stringify({ ok: true, preparation }),
    );
    await expect(prepared).resolves.toEqual(preparation);

    const finalized = finalizeAndroidChapterStorageTransfer(preparation);
    await vi.waitFor(() => expect(requests.get("finalize")).toBeTruthy());
    window.__lnrResolveAndroidChapterStorageTransfer?.(
      requests.get("finalize")!,
      JSON.stringify({ ok: true }),
    );
    await expect(finalized).resolves.toBeUndefined();

    const rolledBack = rollbackAndroidChapterStorageTransfer(preparation);
    await vi.waitFor(() => expect(requests.get("rollback")).toBeTruthy());
    window.__lnrResolveAndroidChapterStorageTransfer?.(
      requests.get("rollback")!,
      JSON.stringify({ ok: true }),
    );
    await expect(rolledBack).resolves.toBeUndefined();

    const removed = removeAndroidChapterStorageDirectory(
      entries[0]!.sourceRelativeDir,
    );
    await vi.waitFor(() => expect(requests.get("remove")).toBeTruthy());
    window.__lnrResolveAndroidChapterStorageTransfer?.(
      requests.get("remove")!,
      JSON.stringify({ ok: true }),
    );
    await expect(removed).resolves.toBeUndefined();

    expect(prepareChapterStorageTransfer).toHaveBeenCalledWith(
      expect.any(String),
      root,
      expect.any(String),
    );
    expect(finalizeChapterStorageTransfer).toHaveBeenCalledWith(
      expect.any(String),
      root,
      JSON.stringify(preparation),
    );
    expect(rollbackChapterStorageTransfer).toHaveBeenCalledWith(
      expect.any(String),
      root,
      JSON.stringify(preparation),
    );
    expect(removeChapterStorageDirectory).toHaveBeenCalledWith(
      expect.any(String),
      root,
      entries[0]!.sourceRelativeDir,
    );
  });

  it("ensures .nomedia after selecting a storage root", async () => {
    const root = "content://tree/primary%3ANoreaSelect";
    const ensureNoMedia = vi.fn(() => JSON.stringify({ ok: true }));
    const pickMediaStorageRoot = vi.fn((requestId: string) => {
      window.__lnrResolveAndroidStoragePick?.(requestId, { ok: true, root });
    });
    invokeMock.mockResolvedValue(root);
    installBridge({ ensureNoMedia, pickMediaStorageRoot });

    await expect(selectAndroidStorageRoot()).resolves.toBe(root);

    expect(pickMediaStorageRoot).toHaveBeenCalledWith(expect.any(String));
    expect(invokeMock).toHaveBeenCalledWith("chapter_media_set_storage_root", {
      root,
    });
    expect(ensureNoMedia).toHaveBeenCalledOnce();
    expect(ensureNoMedia).toHaveBeenCalledWith(root);
  });

  it("recreates .nomedia after clearing the storage root", async () => {
    const root = "content://tree/primary%3ANoreaClear";
    const deleteRootChildren = vi.fn(() => JSON.stringify({ ok: true }));
    const ensureNoMedia = vi.fn(() => JSON.stringify({ ok: true }));
    invokeMock.mockResolvedValue(root);
    installBridge({ deleteRootChildren, ensureNoMedia });

    await clearAndroidStorageRoot();

    expect(deleteRootChildren).toHaveBeenCalledWith(root);
    expect(ensureNoMedia).toHaveBeenCalledTimes(2);
    expect(ensureNoMedia).toHaveBeenNthCalledWith(1, root);
    expect(ensureNoMedia).toHaveBeenNthCalledWith(2, root);
  });

  it("keeps .nomedia while preparing reader media cache", async () => {
    const root = "content://tree/primary%3ANoreaPrepare";
    const ensureNoMedia = vi.fn(() => JSON.stringify({ ok: true }));
    const prepareReaderMediaCache = vi.fn(() =>
      JSON.stringify({ bytes: 12, ok: true }),
    );
    invokeMock.mockResolvedValue(root);
    installBridge({ ensureNoMedia, prepareReaderMediaCache });

    await prepareAndroidReaderMediaCache(
      "contents/demo/chapter/media",
      "contents/demo/chapter/media.zip",
      "cache-token",
    );

    expect(ensureNoMedia).toHaveBeenCalledWith(root);
    expect(prepareReaderMediaCache).toHaveBeenCalledWith(
      root,
      "contents/demo/chapter/media",
      "contents/demo/chapter/media.zip",
      "cache-token",
    );
  });

  it("stops preparing reader media when .nomedia cannot be ensured", async () => {
    const root = "content://tree/primary%3ANoreaPrepareMarkerFailure";
    const ensureNoMedia = vi.fn(() =>
      JSON.stringify({ error: "marker failed", ok: false }),
    );
    const prepareReaderMediaCache = vi.fn(() =>
      JSON.stringify({ bytes: 12, ok: true }),
    );
    invokeMock.mockResolvedValue(root);
    installBridge({ ensureNoMedia, prepareReaderMediaCache });

    await expect(
      prepareAndroidReaderMediaCache(
        "contents/demo/chapter/media",
        "contents/demo/chapter/media.zip",
        "cache-token",
      ),
    ).rejects.toThrow("marker failed");

    expect(prepareReaderMediaCache).not.toHaveBeenCalled();
  });
});
