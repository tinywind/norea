import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({
  cancelWorkMetadataRecovery: vi.fn(),
}));
vi.mock("../../db/user-state-core", () => ({
  emitUserStateLedgerChanged: vi.fn(),
  notifyUserStateEffects: vi.fn(),
}));
vi.mock("../../db/work-metadata", () => ({
  restoreWorkMetadataDirectoriesFromRust: vi.fn(),
  forgetNovelMetadataFile: vi.fn(),
  rememberKnownNovelMetadataFile: vi.fn(),
}));
vi.mock("./restore-plan", () => ({ prepareBackupRestore: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../chapter-content-storage", () => ({
  writeStoredChapterContentMirror: vi.fn(),
}));
vi.mock("../../store/download-goals", () => ({
  DOWNLOAD_GOAL_SETTINGS_KEY: "download-goal-settings",
  useDownloadGoalSettingsStore: { persist: { rehydrate: vi.fn() } },
}));
vi.mock("../../store/download-recovery", () => ({
  DOWNLOAD_RECOVERY_SETTINGS_KEY: "download-recovery-settings",
  useDownloadRecoveryStore: { persist: { rehydrate: vi.fn() } },
}));
vi.mock("../../store/reader", () => ({
  useReaderStore: {
    getState: () => ({ lastReadChapterByNovel: {} }),
    persist: { rehydrate: vi.fn() },
  },
}));

import { invoke } from "@tauri-apps/api/core";
import { cancelWorkMetadataRecovery } from "../../db/client";
import { useDownloadRecoveryStore } from "../../store/download-recovery";
import { restoreWorkMetadataDirectoriesFromRust } from "../../db/work-metadata";
import { prepareBackupRestore } from "./restore-plan";
import { writeStoredChapterContentMirror } from "../chapter-content-storage";
import {
  BACKUP_FORMAT_VERSION,
  encodeBackupManifest,
  parseBackupManifest,
} from "./format";
import { applyBackupSnapshot, gatherBackupSnapshot } from "./snapshot";
import { runContentStorageOperation } from "../content-sync/storage-operation";
import { serializeUserStateSynchronization } from "../user-state/maintenance";

const invokeMock = vi.mocked(invoke);
const writeStoredChapterContentMirrorMock = vi.mocked(
  writeStoredChapterContentMirror,
);
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);

const RAW_NOVEL = {
  id: 1,
  pluginId: "demo",
  sourceNovelId: "1",
  path: "/n/1",
  name: "Sample Novel",
  cover: null,
  summary: null,
  author: null,
  artist: null,
  status: null,
  genres: null,
  inLibrary: true,
  isLocal: false,
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
  bookmark: false,
  unread: true,
  progress: 0,
  isDownloaded: false,
  sourceContentType: "text",
  storedContentType: "html",
  contentBytes: 0,
  mediaBytes: 99,
  releaseTime: null,
  readAt: null,
  createdAt: 1_700_000_000,
  foundAt: 1_700_000_000,
  foundByCheck: true,
  updatedAt: 1_700_000_000,
};

const RAW_CATEGORY = { id: 1, name: "Default", sort: 0, isSystem: true };
const NOVEL_CATEGORY = { id: 1, novelId: 1, categoryId: 1 };
const REPOSITORY = {
  id: 1,
  url: "https://example.test/p.json",
  name: "Example",
  addedAt: 1_700_000_000,
  priority: 1,
  enabled: true,
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
  repositoryUrl: "https://example.test/p.json",
};
const VPN_GATE_SERVER_VERDICT = {
  ip: "198.51.100.10",
  verdict: "works" as const,
  updatedAt: 1_700_000_000,
};
const DOWNLOAD_GOAL = { novelId: 1, kind: "keep_ahead" as const, count: 3, updatedAt: 1_700_000_000 };

function gatheredFixture(
  chapterRows: unknown[] = [RAW_CHAPTER],
  categoryRows: unknown[] = [RAW_CATEGORY],
  novelRows: unknown[] = [RAW_NOVEL],
) {
  return {
    novels: novelRows,
    chapters: chapterRows,
    categories: categoryRows,
    novelCategories: [NOVEL_CATEGORY],
    repositories: [REPOSITORY],
    installedPlugins: [INSTALLED_PLUGIN],
    vpnGateServerVerdicts: [VPN_GATE_SERVER_VERDICT],
    downloadGoals: [DOWNLOAD_GOAL],
  };
}

function primeGather(
  chapterRows: unknown[] = [RAW_CHAPTER],
  categoryRows: unknown[] = [RAW_CATEGORY],
  novelRows: unknown[] = [RAW_NOVEL],
): void {
  invokeMock.mockImplementationOnce(async (command: string) => {
    if (command === "backup_gather_snapshot") {
      return gatheredFixture(chapterRows, categoryRows, novelRows);
    }
    return undefined;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  invokeMock.mockResolvedValue(undefined);
  vi.mocked(prepareBackupRestore).mockImplementation(async (manifest) => ({
    manifest,
    cache: { files: [], chapters: [] },
  }));
  vi.mocked(restoreWorkMetadataDirectoriesFromRust).mockResolvedValue(undefined);
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

describe("gatherBackupSnapshot", () => {
  it("exports stable category identities returned by the native snapshot command", async () => {
    primeGather([RAW_CHAPTER], [
      RAW_CATEGORY,
      { id: 7, name: "Favorites", sort: 2, isSystem: false, stableId: "category:favorites" },
    ]);

    const manifest = await gatherBackupSnapshot();

    expect(manifest.categories).toEqual([
      RAW_CATEGORY,
      { id: 7, name: "Favorites", sort: 2, isSystem: false, stableId: "category:favorites" },
    ]);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("backup_gather_snapshot");
  });

  it("normalizes native snapshot rows into strict manifest fields", async () => {
    primeGather(
      [RAW_CHAPTER],
      [RAW_CATEGORY],
      [{ ...RAW_NOVEL, isLocal: true }],
    );
    const manifest = await gatherBackupSnapshot();

    expect(manifest.version).toBe(BACKUP_FORMAT_VERSION);
    expect(manifest.novels[0]?.inLibrary).toBe(true);
    // Non-local plugin must never report isLocal: true.
    expect(manifest.novels[0]?.isLocal).toBe(false);
    expect(manifest.chapters[0]?.bookmark).toBe(false);
    expect(manifest.chapters[0]?.unread).toBe(true);
    expect(manifest.chapters[0]?.isDownloaded).toBe(false);
    expect(manifest.chapters[0]?.contentType).toBe("html");
    expect(manifest.chapters[0]?.sourceContentType).toBe("text");
    expect(manifest.chapters[0]?.content).toBeNull();
    expect(manifest.chapters[0]?.contentBytes).toBe(0);
    expect(manifest.chapters[0]?.mediaBytes).toBe(99);
    expect(manifest.chapters[0]?.foundByCheck).toBe(true);
    expect(manifest.categories[0]?.isSystem).toBe(true);
    expect(manifest.repositories).toEqual([{ ...REPOSITORY, enabled: true }]);
    expect(manifest.installedPlugins[0]?.repositoryUrl).toBe("https://example.test/p.json");
    expect(manifest.vpnGateServerVerdicts).toEqual([VPN_GATE_SERVER_VERDICT]);
    expect(manifest.downloadGoals).toEqual([DOWNLOAD_GOAL]);
  });

  it("carries download metadata from the chapter row without reading chapter storage", async () => {
    primeGather([
      {
        ...RAW_CHAPTER,
        isDownloaded: true,
        storedContentType: "pdf",
        contentBytes: 4096,
        mediaBytes: 12,
      },
    ]);

    const manifest = await gatherBackupSnapshot();

    expect(manifest.chapters[0]?.isDownloaded).toBe(true);
    expect(manifest.chapters[0]?.contentType).toBe("pdf");
    expect(manifest.chapters[0]?.content).toBeNull();
    expect(manifest.chapters[0]?.contentBytes).toBe(4096);
    expect(manifest.chapters[0]?.mediaBytes).toBe(12);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("backup_gather_snapshot");
  });

  it("survives round-trip through encode + parse", async () => {
    primeGather();
    const manifest = await gatherBackupSnapshot();
    const restored = parseBackupManifest(encodeBackupManifest(manifest));
    expect(restored).toEqual(manifest);
  });

  it("carries each novel's stored override and omits it for novels without one", async () => {
    const legacyOverride = { fields: {
      completed: { value: true, updatedAt: 1_763_350_000_000 },
      futureField: { value: "kept", updatedAt: 5 },
    } };
    const expectedOverride = { fields: {
      futureField: { value: "kept", updatedAt: 5 },
      status: { value: "Completed", updatedAt: 1_763_350_000_000 },
    } };
    primeGather([RAW_CHAPTER], [RAW_CATEGORY], [
      { ...RAW_NOVEL, overridePayload: JSON.stringify(legacyOverride) },
      { ...RAW_NOVEL, id: 2, path: "/n/2" },
    ]);

    const manifest = await gatherBackupSnapshot();

    expect(manifest.novels[0]?.override).toEqual(expectedOverride);
    expect("override" in manifest.novels[1]!).toBe(false);
    expect(parseBackupManifest(encodeBackupManifest(manifest))).toEqual(manifest);
  });

  it("includes app and plugin settings from localStorage", async () => {
    installLocalStorage({
      "app-appearance-settings": "{\"state\":{\"themeMode\":\"dark\"}}",
      "download-goal-settings": "{\"state\":{\"defaultKeepAhead\":5}}",
      "download-recovery-settings": "{\"state\":{\"forbiddenAction\":\"retry\",\"rotateFingerprintOnVpnChange\":true}}",
      "plugin-v2:demo:token": "secret",
      "plugin:demo:token": "obsolete-token",
      "source-filters:demo": "{\"filters\":{}}",
      unrelated: "skip",
      "norea-content-device:http://server": "device-key",
      "norea-user-state": '{"state":{"enabledByServer":{"http://server":true}}}',
      "user-state-ledger": "not-a-portable-setting",
    });
    primeGather();

    const manifest = await gatherBackupSnapshot();

    expect(manifest.settings).toEqual([
      {
        key: "app-appearance-settings",
        value: "{\"state\":{\"themeMode\":\"dark\"}}",
      },
      { key: "download-goal-settings", value: "{\"state\":{\"defaultKeepAhead\":5}}" },
      { key: "download-recovery-settings", value: "{\"state\":{\"forbiddenAction\":\"retry\",\"rotateFingerprintOnVpnChange\":true}}" },
      { key: "plugin-v2:demo:token", value: "secret" },
      { key: "source-filters:demo", value: "{\"filters\":{}}" },
    ]);
  });
});

describe("applyBackupSnapshot", () => {
  async function gatherForTest() {
    primeGather();
    const manifest = await gatherBackupSnapshot();
    invokeMock.mockClear();
    return manifest;
  }

  it("aborts and awaits active sharing before preparing a portable restore", async () => {
    const manifest = await gatherForTest();
    let release: () => void = () => undefined;
    const active = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const controller = new AbortController();
    const cancel = vi.fn(() => controller.abort());
    const sharing = serializeUserStateSynchronization(active, cancel, controller.signal);
    await vi.waitFor(() => expect(active).toHaveBeenCalledOnce());

    const restore = applyBackupSnapshot(manifest);
    expect(cancel).toHaveBeenCalledOnce();
    expect(prepareBackupRestore).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    release();
    await sharing;
    await restore;
    expect(cancelWorkMetadataRecovery).toHaveBeenCalledOnce();
    expect(prepareBackupRestore).toHaveBeenCalledExactlyOnceWith(manifest);
    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it("keeps content sync waiting until the database restore settles", async () => {
    const manifest = await gatherForTest();
    let release: () => void = () => undefined;
    invokeMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const restore = applyBackupSnapshot(manifest);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledOnce());
    const synchronize = vi.fn(async () => undefined);
    const sync = runContentStorageOperation(synchronize);
    await Promise.resolve();
    await Promise.resolve();
    expect(synchronize).not.toHaveBeenCalled();
    release();
    await restore;
    await sync;
    expect(synchronize).toHaveBeenCalledOnce();
  });

  it("delegates database restore to the native transaction command", async () => {
    const manifest = parseBackupManifest(
      encodeBackupManifest(await gatherForTest()),
    );

    await applyBackupSnapshot(manifest);

    expect(invokeMock).toHaveBeenCalledWith("backup_restore_snapshot", {
      manifestJson: encodeBackupManifest(manifest),
      cacheJson: JSON.stringify({ files: [], chapters: [] }),
    });
    expect(restoreWorkMetadataDirectoriesFromRust).toHaveBeenCalledExactlyOnceWith(true);
    expect(writeStoredChapterContentMirrorMock).not.toHaveBeenCalled();
  });

  it("sends a novel override to the native restore upgraded to canonical status", async () => {
    const legacyOverride = { fields: { completed: { value: false, updatedAt: 1_763_350_000_000 } } };
    const canonicalOverride = { fields: { status: { value: "Ongoing", updatedAt: 1_763_350_000_000 } } };
    primeGather([RAW_CHAPTER], [RAW_CATEGORY], [{ ...RAW_NOVEL, overridePayload: JSON.stringify(legacyOverride) }]);
    const manifest = parseBackupManifest(encodeBackupManifest(await gatherBackupSnapshot()));
    invokeMock.mockClear();

    await applyBackupSnapshot(manifest);

    const restore = invokeMock.mock.calls.find(([command]) => command === "backup_restore_snapshot");
    expect(JSON.parse((restore![1] as { manifestJson: string }).manifestJson).novels[0].override).toEqual(canonicalOverride);
  });

  it("preserves nullable creation times from server metadata through export and restore", async () => {
    primeGather([{ ...RAW_CHAPTER, path: "norea-folder:1", createdAt: null, foundAt: 0 }]);
    const gathered = await gatherBackupSnapshot();
    invokeMock.mockClear();
    const manifest = parseBackupManifest(encodeBackupManifest(gathered));

    expect(manifest.chapters[0]).toMatchObject({ createdAt: null, foundAt: 0 });
    await applyBackupSnapshot(manifest);

    expect(invokeMock).toHaveBeenCalledWith("backup_restore_snapshot", {
      manifestJson: encodeBackupManifest(manifest),
      cacheJson: JSON.stringify({ files: [], chapters: [] }),
    });
    expect(writeStoredChapterContentMirrorMock).not.toHaveBeenCalled();
  });

  it("leaves chapter files alone for downloaded chapters without inline bodies", async () => {
    const gathered = await gatherForTest();
    const manifest = parseBackupManifest(
      encodeBackupManifest({
        ...gathered,
        chapters: [
          { ...gathered.chapters[0]!, isDownloaded: true, content: null },
        ],
      }),
    );

    await applyBackupSnapshot(manifest);

    expect(invokeMock).toHaveBeenCalledWith("backup_restore_snapshot", {
      manifestJson: encodeBackupManifest(manifest),
      cacheJson: JSON.stringify({ files: [], chapters: [] }),
    });
    expect(writeStoredChapterContentMirrorMock).not.toHaveBeenCalled();
  });

  it("restores backed up settings without touching unrelated localStorage", async () => {
    const storage = installLocalStorage({
      "app-appearance-settings": "old",
      "plugin-v2:demo:token": "old-token",
      "plugin:demo:token": "obsolete-token",
      "norea-content-device:http://server": "device-key",
      unrelated: "keep",
    });
    const manifest = parseBackupManifest(
      encodeBackupManifest({
        ...(await gatherForTest()),
        settings: [
          { key: "app-appearance-settings", value: "new" },
          { key: "download-recovery-settings", value: "{\"state\":{\"transientAction\":\"retry\"}}" },
          { key: "plugin-v2:demo:token", value: "new-token" },
          { key: "plugin:demo:token", value: "ignored-token" },
          { key: "norea-content-device:http://server", value: "foreign-device-key" },
        ],
      }),
    );

    await applyBackupSnapshot(manifest);

    expect(storage.getItem("app-appearance-settings")).toBe("new");
    expect(storage.getItem("download-recovery-settings")).toBe("{\"state\":{\"transientAction\":\"retry\"}}");
    expect(useDownloadRecoveryStore.persist.rehydrate).toHaveBeenCalledOnce();
    expect(storage.getItem("plugin-v2:demo:token")).toBe("new-token");
    expect(storage.getItem("plugin:demo:token")).toBe("obsolete-token");
    expect(storage.getItem("norea-content-device:http://server")).toBe("device-key");
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

  it("does not enter native restore when original-file inspection fails", async () => {
    const manifest = await gatherForTest();
    vi.mocked(prepareBackupRestore).mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(applyBackupSnapshot(manifest)).rejects.toThrow("Storage unavailable");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(restoreWorkMetadataDirectoriesFromRust).not.toHaveBeenCalled();
  });

  it("holds content sync until authoritative directories have been restored", async () => {
    const manifest = await gatherForTest();
    let release!: () => void;
    vi.mocked(restoreWorkMetadataDirectoriesFromRust).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const restore = applyBackupSnapshot(manifest);
    await vi.waitFor(() => expect(restoreWorkMetadataDirectoriesFromRust).toHaveBeenCalledOnce());
    const synchronize = vi.fn(async () => undefined);
    const sync = runContentStorageOperation(synchronize);
    await Promise.resolve();
    expect(synchronize).not.toHaveBeenCalled();
    release();
    await Promise.all([restore, sync]);
    expect(synchronize).toHaveBeenCalledOnce();
  });
});
