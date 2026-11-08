import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => {
  const getDb = vi.fn();
  return {
    getDb,
    runDatabaseTransaction: vi.fn(async (run: (db: unknown) => Promise<unknown>) => run(await getDb())),
    cancelWorkMetadataRecovery: vi.fn(),
    runExclusiveDatabaseOperation: vi.fn(
      async (run: () => Promise<unknown>) => run(),
    ),
  };
});
vi.mock("../../db/user-state-core", () => ({ stableCategoryIdInDb: vi.fn(), emitUserStateLedgerChanged: vi.fn() }));
vi.mock("../../db/work-metadata", () => ({ restoreWorkMetadataDirectories: vi.fn() }));
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
vi.mock("../../store/reader", () => ({ useReaderStore: {
  getState: () => ({ lastReadChapterByNovel: {} }), persist: { rehydrate: vi.fn() },
} }));

import { invoke } from "@tauri-apps/api/core";
import { getDb, runDatabaseTransaction } from "../../db/client";
import { stableCategoryIdInDb } from "../../db/user-state-core";
import { useDownloadRecoveryStore } from "../../store/download-recovery";
import { restoreWorkMetadataDirectories } from "../../db/work-metadata";
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

const mockedGetDb = vi.mocked(getDb);
const invokeMock = vi.mocked(invoke);
const writeStoredChapterContentMirrorMock = vi.mocked(
  writeStoredChapterContentMirror,
);
let mockSelect: ReturnType<typeof vi.fn>;
let mockExecute: ReturnType<typeof vi.fn>;
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
beforeEach(() => {
  vi.clearAllMocks();
  mockSelect = vi.fn();
  mockExecute = vi.fn().mockResolvedValue(undefined);
  mockedGetDb.mockResolvedValue({
    select: mockSelect,
    execute: mockExecute,
  } as never);
  invokeMock.mockResolvedValue(undefined);
  vi.mocked(prepareBackupRestore).mockImplementation(async (_db, manifest) => ({ manifest, cache: { files: [], chapters: [] } }));
  vi.mocked(restoreWorkMetadataDirectories).mockResolvedValue(undefined);
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
  isDownloaded: 0,
  sourceContentType: "text",
  storedContentType: "html",
  contentBytes: 0,
  mediaBytes: 99,
  releaseTime: null,
  readAt: null,
  createdAt: 1_700_000_000,
  foundAt: 1_700_000_000,
  foundByCheck: 1,
  updatedAt: 1_700_000_000,
};

const RAW_CATEGORY = { id: 1, name: "Default", sort: 0, isSystem: 1 };
const NOVEL_CATEGORY = { id: 1, novelId: 1, categoryId: 1 };
const REPOSITORY = {
  id: 1,
  url: "https://example.test/p.json",
  name: "Example",
  addedAt: 1_700_000_000,
  priority: 1,
  enabled: 1,
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
  verdict: "works",
  updatedAt: 1_700_000_000,
};
const DOWNLOAD_GOAL = { novelId: 1, kind: "keep_ahead", count: 3, updatedAt: 1_700_000_000 };

function primeSelect(chapterRows: unknown[] = [RAW_CHAPTER], categoryRows: unknown[] = [RAW_CATEGORY]): void {
  mockSelect
    .mockResolvedValueOnce([RAW_NOVEL])
    .mockResolvedValueOnce(chapterRows)
    .mockResolvedValueOnce(categoryRows)
    .mockResolvedValueOnce([NOVEL_CATEGORY])
    .mockResolvedValueOnce([REPOSITORY])
    .mockResolvedValueOnce([INSTALLED_PLUGIN])
    .mockResolvedValueOnce([VPN_GATE_SERVER_VERDICT])
    .mockResolvedValueOnce([DOWNLOAD_GOAL]);
}

describe("gatherBackupSnapshot", () => {
  it("exports stable category identities from the same database transaction", async () => {
    primeSelect([RAW_CHAPTER], [RAW_CATEGORY, { id: 7, name: "Favorites", sort: 2, isSystem: 0 }]);
    vi.mocked(stableCategoryIdInDb).mockResolvedValueOnce("category:favorites");

    const manifest = await gatherBackupSnapshot();

    expect(manifest.categories).toEqual([
      { ...RAW_CATEGORY, isSystem: true },
      { id: 7, name: "Favorites", sort: 2, isSystem: false, stableId: "category:favorites" },
    ]);
    expect(runDatabaseTransaction).toHaveBeenCalledOnce();
    expect(stableCategoryIdInDb).toHaveBeenCalledExactlyOnceWith(
      { select: mockSelect, execute: mockExecute }, 7,
    );
  });

  it("coerces integer flag columns into strict booleans", async () => {
    primeSelect();
    const manifest = await gatherBackupSnapshot();

    expect(manifest.version).toBe(BACKUP_FORMAT_VERSION);
    expect(manifest.novels[0]?.inLibrary).toBe(true);
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
    expect(manifest.vpnGateServerVerdicts).toEqual([
      VPN_GATE_SERVER_VERDICT,
    ]);
    expect(manifest.downloadGoals).toEqual([DOWNLOAD_GOAL]);
  });

  it("carries download metadata from the chapter row without reading storage", async () => {
    primeSelect([
      {
        ...RAW_CHAPTER,
        isDownloaded: 1,
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
    expect(invokeMock).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("calls one SELECT per backup table", async () => {
    primeSelect();
    await gatherBackupSnapshot();

    const sqls = mockSelect.mock.calls.map((call) => call[0] as string);
    const chapterSql = sqls.find((sql) => /FROM chapter\b/m.test(sql));
    expect(sqls).toHaveLength(8);
    expect(sqls.some((s) => /FROM novel\b\s*$/m.test(s))).toBe(true);
    expect(sqls.some((s) => /FROM chapter\b/m.test(s))).toBe(true);
    expect(chapterSql).toContain("content_type   AS sourceContentType");
    expect(chapterSql).toContain(
      "stored_content_type AS storedContentType",
    );
    expect(chapterSql).toContain("content_bytes  AS contentBytes");
    expect(mockExecute).not.toHaveBeenCalled();
    expect(sqls.some((s) => /FROM category\b/m.test(s))).toBe(true);
    expect(sqls.some((s) => /FROM novel_category\b/m.test(s))).toBe(true);
    expect(sqls.some((s) => /FROM repository\b/m.test(s))).toBe(true);
    expect(sqls.some((s) => /FROM installed_plugin\b/m.test(s))).toBe(true);
    expect(
      sqls.some((s) => /FROM vpn_gate_server_verdict\b/m.test(s)),
    ).toBe(true);
    expect(sqls.some((s) => /FROM novel_download_goal\b/m.test(s))).toBe(true);
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
    primeSelect();

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
    primeSelect();
    return gatherBackupSnapshot();
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
    expect(prepareBackupRestore).toHaveBeenCalledOnce();
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
    expect(writeStoredChapterContentMirrorMock).not.toHaveBeenCalled();
  });

  it("preserves nullable creation times from server metadata through export and restore", async () => {
    primeSelect([{ ...RAW_CHAPTER, path: "norea-folder:1", createdAt: null, foundAt: 0 }]);
    const gathered = await gatherBackupSnapshot();
    const manifest = parseBackupManifest(encodeBackupManifest(gathered));

    expect(manifest.chapters[0]).toMatchObject({ createdAt: null, foundAt: 0 });
    await applyBackupSnapshot(manifest);

    expect(invokeMock).toHaveBeenCalledWith("backup_restore_snapshot", {
      manifestJson: encodeBackupManifest(manifest),
      cacheJson: JSON.stringify({ files: [], chapters: [] }),
    });
    expect(mockExecute).not.toHaveBeenCalled();
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
    expect(restoreWorkMetadataDirectories).not.toHaveBeenCalled();
  });

  it("holds content sync until authoritative directories have been restored", async () => {
    const manifest = await gatherForTest();
    let release!: () => void;
    vi.mocked(restoreWorkMetadataDirectories).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const restore = applyBackupSnapshot(manifest);
    await vi.waitFor(() => expect(restoreWorkMetadataDirectories).toHaveBeenCalledOnce());
    const synchronize = vi.fn(async () => undefined);
    const sync = runContentStorageOperation(synchronize);
    await Promise.resolve();
    expect(synchronize).not.toHaveBeenCalled();
    release();
    await Promise.all([restore, sync]);
    expect(synchronize).toHaveBeenCalledOnce();
  });

});
