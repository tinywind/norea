import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => {
  return {
    getDb: vi.fn(),
    runExclusiveDatabaseOperation: vi.fn(
      async (run: () => Promise<unknown>) => run(),
    ),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../chapter-content-storage", () => ({
  readStoredChapterContentMirror: vi.fn(),
  writeStoredChapterContentMirror: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { getDb } from "../../db/client";
import {
  readStoredChapterContentMirror,
  writeStoredChapterContentMirror,
} from "../chapter-content-storage";
import {
  BACKUP_FORMAT_VERSION,
  encodeBackupManifest,
  parseBackupManifest,
} from "./format";
import { applyBackupSnapshot, gatherBackupSnapshot } from "./snapshot";
import { attachBackupChapterMediaFiles } from "./unpack";

const mockedGetDb = vi.mocked(getDb);
const invokeMock = vi.mocked(invoke);
const readStoredChapterContentMirrorMock = vi.mocked(
  readStoredChapterContentMirror,
);
const writeStoredChapterContentMirrorMock = vi.mocked(
  writeStoredChapterContentMirror,
);
let mockSelect: ReturnType<typeof vi.fn>;
let mockExecute: ReturnType<typeof vi.fn>;
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);
const originalTauriInternalsDescriptor =
  typeof window === "undefined"
    ? undefined
    : Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");

beforeEach(() => {
  vi.clearAllMocks();
  mockSelect = vi.fn();
  mockExecute = vi.fn().mockResolvedValue(undefined);
  mockedGetDb.mockResolvedValue({
    select: mockSelect,
    execute: mockExecute,
  } as never);
  invokeMock.mockResolvedValue(undefined);
  readStoredChapterContentMirrorMock.mockResolvedValue("<p>hi</p>");
  writeStoredChapterContentMirrorMock.mockResolvedValue(undefined);
});

afterEach(() => {
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(
      globalThis,
      "localStorage",
      originalLocalStorageDescriptor,
    );
  } else {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
  if (typeof window !== "undefined") {
    if (originalTauriInternalsDescriptor) {
      Object.defineProperty(
        window,
        "__TAURI_INTERNALS__",
        originalTauriInternalsDescriptor,
      );
    } else {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__;
    }
  }
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    delete (globalThis as { window?: Window }).window;
  }
});

function installLocalStorage(initial: Record<string, string>): Storage {
  const values = new Map(Object.entries(initial));
  const storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  } as Storage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  return storage;
}

function installTauriRuntime(): void {
  const runtimeWindow =
    typeof window === "undefined"
      ? ({} as Window & { __TAURI_INTERNALS__?: unknown })
      : window;
  if (typeof window === "undefined") {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: runtimeWindow,
    });
  }
  Object.defineProperty(runtimeWindow, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
}

const RAW_NOVEL = {
  id: 1,
  pluginId: "demo",
  path: "/n/1",
  name: "Sample Novel",
  cover: null,
  summary: null,
  author: null,
  artist: null,
  status: null,
  genres: null,
  inLibrary: 1,
  isLocal: 0,
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_000,
  libraryAddedAt: 1_700_000_000,
  lastReadAt: null,
};

const RAW_CHAPTER = {
  id: 10,
  novelId: 1,
  path: "/c/1",
  name: "Chapter 1",
  chapterNumber: "1",
  position: 1,
  page: "1",
  bookmark: 0,
  unread: 1,
  progress: 0,
  isDownloaded: 1,
  contentType: "html",
  mediaBytes: 5,
  releaseTime: null,
  readAt: null,
  createdAt: 1_700_000_000,
  foundAt: 1_700_000_000,
  updatedAt: 1_700_000_000,
};

const RAW_CATEGORY = { id: 1, name: "Default", sort: 0, isSystem: 1 };
const NOVEL_CATEGORY = { id: 1, novelId: 1, categoryId: 1 };
const REPOSITORY = {
  id: 1,
  url: "https://example.test/p.json",
  name: "Example",
  addedAt: 1_700_000_000,
};
const INSTALLED_PLUGIN = {
  id: "demo",
  name: "Demo",
  lang: "en",
  version: "1.0.0",
  iconUrl: "https://example.test/icon.png",
  sourceUrl: "https://example.test/index.js",
  sourceCode: "module.exports.default = {};",
  installedAt: 1_700_000_000,
};

function primeSelect(): void {
  mockSelect
    .mockResolvedValueOnce([RAW_NOVEL])
    .mockResolvedValueOnce([RAW_CHAPTER])
    .mockResolvedValueOnce([RAW_CATEGORY])
    .mockResolvedValueOnce([NOVEL_CATEGORY])
    .mockResolvedValueOnce([REPOSITORY])
    .mockResolvedValueOnce([INSTALLED_PLUGIN]);
}

describe("gatherBackupSnapshot", () => {
  it("coerces integer flag columns into strict booleans", async () => {
    primeSelect();
    const manifest = await gatherBackupSnapshot();

    expect(manifest.version).toBe(BACKUP_FORMAT_VERSION);
    expect(manifest.novels[0]?.inLibrary).toBe(true);
    expect(manifest.novels[0]?.isLocal).toBe(false);
    expect(manifest.chapters[0]?.bookmark).toBe(false);
    expect(manifest.chapters[0]?.unread).toBe(true);
    expect(manifest.chapters[0]?.isDownloaded).toBe(true);
    expect(manifest.chapters[0]?.contentType).toBe("html");
    expect(manifest.chapters[0]?.content).toBe("<p>hi</p>");
    expect(manifest.chapters[0]?.mediaBytes).toBe(5);
    expect(manifest.categories[0]?.isSystem).toBe(true);
  });

  it("calls one SELECT per backup table", async () => {
    primeSelect();
    await gatherBackupSnapshot();

    const sqls = mockSelect.mock.calls.map((call) => call[0] as string);
    expect(sqls).toHaveLength(6);
    expect(sqls.some((s) => /FROM novel\b\s*$/m.test(s))).toBe(true);
    expect(sqls.some((s) => /FROM chapter\b/m.test(s))).toBe(true);
    expect(sqls.some((s) => /FROM category\b/m.test(s))).toBe(true);
    expect(sqls.some((s) => /FROM novel_category\b/m.test(s))).toBe(true);
    expect(sqls.some((s) => /FROM repository\b/m.test(s))).toBe(true);
    expect(sqls.some((s) => /FROM installed_plugin\b/m.test(s))).toBe(true);
  });

  it("survives round-trip through encode + parse", async () => {
    primeSelect();
    const manifest = await gatherBackupSnapshot();
    const restored = parseBackupManifest(encodeBackupManifest(manifest));
    expect(restored).toEqual(manifest);
  });

  it("includes app and plugin settings from localStorage", async () => {
    installLocalStorage({
      "app-appearance-settings": "{\"state\":{\"themeMode\":\"dark\"}}",
      "plugin:demo:token": "secret",
      "source-filters:demo": "{\"filters\":{}}",
      unrelated: "skip",
    });
    primeSelect();

    const manifest = await gatherBackupSnapshot();

    expect(manifest.settings).toEqual([
      {
        key: "app-appearance-settings",
        value: "{\"state\":{\"themeMode\":\"dark\"}}",
      },
      { key: "plugin:demo:token", value: "secret" },
      { key: "source-filters:demo", value: "{\"filters\":{}}" },
    ]);
  });
});

describe("applyBackupSnapshot", () => {
  async function gatherForTest() {
    primeSelect();
    return gatherBackupSnapshot();
  }

  it("delegates database restore to the native transaction command", async () => {
    const manifest = parseBackupManifest(
      encodeBackupManifest(await gatherForTest()),
    );

    await applyBackupSnapshot(manifest);

    expect(invokeMock).toHaveBeenCalledWith("backup_restore_snapshot", {
      manifestJson: encodeBackupManifest(manifest),
      mediaBytesByChapterId: {},
    });
    expect(writeStoredChapterContentMirrorMock).toHaveBeenCalledWith(
      10,
      "<p>hi</p>",
    );
  });

  it("restores backed up settings without touching unrelated localStorage", async () => {
    const storage = installLocalStorage({
      "app-appearance-settings": "old",
      "plugin:demo:token": "old-token",
      unrelated: "keep",
    });
    const manifest = parseBackupManifest(
      encodeBackupManifest({
        ...(await gatherForTest()),
        settings: [
          { key: "app-appearance-settings", value: "new" },
          { key: "plugin:demo:token", value: "new-token" },
        ],
      }),
    );

    await applyBackupSnapshot(manifest);

    expect(storage.getItem("app-appearance-settings")).toBe("new");
    expect(storage.getItem("plugin:demo:token")).toBe("new-token");
    expect(storage.getItem("unrelated")).toBe("keep");
  });

  it("leaves settings unchanged when native database restore fails", async () => {
    const storage = installLocalStorage({
      "app-appearance-settings": "old",
      unrelated: "keep",
    });
    const manifest = parseBackupManifest(
      encodeBackupManifest({
        ...(await gatherForTest()),
        settings: [{ key: "app-appearance-settings", value: "new" }],
      }),
    );
    const failure = new Error("restore failed");
    invokeMock.mockImplementation((command: string) => {
      if (command === "backup_restore_snapshot") {
        return Promise.reject(failure);
      }
      return Promise.resolve(undefined);
    });

    await expect(applyBackupSnapshot(manifest)).rejects.toThrow(failure);

    expect(storage.getItem("app-appearance-settings")).toBe("old");
    expect(storage.getItem("unrelated")).toBe("keep");
  });

  it("keeps existing storage media when unpack attached no media files", async () => {
    installTauriRuntime();
    const manifest = attachBackupChapterMediaFiles(
      parseBackupManifest(encodeBackupManifest(await gatherForTest())),
      [],
    );

    await applyBackupSnapshot(manifest);

    expect(invokeMock).not.toHaveBeenCalledWith("chapter_media_begin_restore");
  });

  it("restores chapter media files attached by unpack", async () => {
    installTauriRuntime();
    invokeMock.mockImplementation((command: string) => {
      if (command === "chapter_media_begin_restore") {
        return Promise.resolve("restore-1");
      }
      if (command === "chapter_media_archive_cache") {
        return Promise.resolve(9);
      }
      return Promise.resolve(undefined);
    });
    const manifest = attachBackupChapterMediaFiles(
      parseBackupManifest(encodeBackupManifest(await gatherForTest())),
      [
        {
          chapterId: 10,
          mediaSrc: "norea-media://reader-asset/image.png",
          bytes: 3,
          stagedRef: "media-0.bin",
          stagingId: "stage-1",
        },
      ],
    );

    await applyBackupSnapshot(manifest);

    expect(invokeMock).toHaveBeenCalledWith("chapter_media_begin_restore");
    expect(invokeMock).toHaveBeenCalledWith("backup_restore_staged_media", {
      chapterId: 10,
      chapterName: "Chapter 1",
      chapterNumber: "1",
      chapterPosition: 1,
      fileName: "image.png",
      novelId: 1,
      novelName: "Sample Novel",
      novelPath: "/n/1",
      sourceId: "demo",
      stagedRef: "media-0.bin",
      stagingId: "stage-1",
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "chapter_media_store",
      expect.anything(),
    );
    expect(invokeMock).toHaveBeenCalledWith("chapter_media_write_manifest", {
      chapterId: 10,
      chapterName: "Chapter 1",
      chapterNumber: "1",
      chapterPosition: 1,
      complete: true,
      files: [
        expect.objectContaining({
          bytes: 3,
          fileName: "image.png",
          path: "media/image.png",
          sourceUrl: "norea-media://reader-asset/image.png",
          status: "stored",
        }),
      ],
      novelId: 1,
      novelName: "Sample Novel",
      novelPath: "/n/1",
      sourceId: "demo",
    });
    expect(invokeMock).toHaveBeenCalledWith("chapter_media_archive_cache", {
      chapterId: 10,
      chapterName: "Chapter 1",
      chapterNumber: "1",
      chapterPosition: 1,
      novelId: 1,
      novelName: "Sample Novel",
      novelPath: "/n/1",
      sourceId: "demo",
    });
    expect(invokeMock).toHaveBeenCalledWith("backup_restore_snapshot", {
      manifestJson: encodeBackupManifest(manifest),
      mediaBytesByChapterId: { 10: 9 },
    });
    expect(invokeMock).toHaveBeenCalledWith("chapter_media_commit_restore", {
      token: "restore-1",
    });
    expect(invokeMock).toHaveBeenCalledWith("backup_cleanup_staged_unpack", {
      stagingId: "stage-1",
    });
  });

  it("keeps legacy media body restore as an explicit fallback", async () => {
    installTauriRuntime();
    invokeMock.mockImplementation((command: string) => {
      if (command === "chapter_media_begin_restore") {
        return Promise.resolve("restore-1");
      }
      if (command === "chapter_media_archive_cache") {
        return Promise.resolve(9);
      }
      return Promise.resolve(undefined);
    });
    const manifest = attachBackupChapterMediaFiles(
      parseBackupManifest(encodeBackupManifest(await gatherForTest())),
      [
        {
          chapterId: 10,
          mediaSrc: "norea-media://reader-asset/image.png",
          body: [1, 2, 3],
          bytes: 3,
        },
      ],
    );

    await applyBackupSnapshot(manifest);

    expect(invokeMock).toHaveBeenCalledWith("chapter_media_store", {
      body: [1, 2, 3],
      chapterId: 10,
      chapterName: "Chapter 1",
      chapterNumber: "1",
      chapterPosition: 1,
      fileName: "image.png",
      novelId: 1,
      novelName: "Sample Novel",
      novelPath: "/n/1",
      sourceId: "demo",
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "backup_restore_staged_media",
      expect.anything(),
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      "backup_cleanup_staged_unpack",
      expect.anything(),
    );
  });

  it("rolls back restored media when database restore fails", async () => {
    installTauriRuntime();
    const failure = new Error("restore failed");
    invokeMock.mockImplementation((command: string) => {
      if (command === "chapter_media_begin_restore") {
        return Promise.resolve("restore-1");
      }
      if (command === "chapter_media_archive_cache") {
        return Promise.resolve(9);
      }
      if (command === "backup_restore_snapshot") {
        return Promise.reject(failure);
      }
      return Promise.resolve(undefined);
    });
    const manifest = attachBackupChapterMediaFiles(
      parseBackupManifest(encodeBackupManifest(await gatherForTest())),
      [
        {
          chapterId: 10,
          mediaSrc: "norea-media://reader-asset/image.png",
          bytes: 3,
          stagedRef: "media-0.bin",
          stagingId: "stage-1",
        },
      ],
    );

    await expect(applyBackupSnapshot(manifest)).rejects.toThrow(failure);

    expect(invokeMock).toHaveBeenCalledWith("chapter_media_rollback_restore", {
      token: "restore-1",
    });
    expect(invokeMock).toHaveBeenCalledWith("backup_cleanup_staged_unpack", {
      stagingId: "stage-1",
    });
    expect(invokeMock).not.toHaveBeenCalledWith("chapter_media_commit_restore", {
      token: "restore-1",
    });
  });
});
