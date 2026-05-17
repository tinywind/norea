import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../http", () => ({
  appFetchText: vi.fn(),
  createPluginFetch: vi.fn(() => vi.fn()),
  createPluginFetchFile: vi.fn(() => vi.fn()),
  createPluginFetchShim: vi.fn(() => vi.fn()),
  createPluginFetchText: vi.fn(() => vi.fn()),
  pluginFetch: vi.fn(),
  pluginFetchText: vi.fn(),
  pluginFetchShim: vi.fn(),
}));
vi.mock("../../db/queries/installed-plugin", () => ({
  upsertInstalledPlugin: vi.fn().mockResolvedValue(undefined),
  deleteInstalledPlugin: vi.fn().mockResolvedValue(undefined),
  listInstalledPlugins: vi.fn().mockResolvedValue([]),
}));

import { appFetchText, createPluginFetchShim } from "../http";
import {
  deleteInstalledPlugin,
  listInstalledPlugins,
} from "../../db/queries/installed-plugin";
import {
  PluginManager,
  PluginValidationError,
  isValidPluginItem,
} from "./manager";

const mockedFetchText = vi.mocked(appFetchText);
const mockedCreateFetchShim = vi.mocked(createPluginFetchShim);
const mockedDeleteInstalledPlugin = vi.mocked(deleteInstalledPlugin);
const mockedListInstalledPlugins = vi.mocked(listInstalledPlugins);

const VALID_ITEM = {
  id: "demo",
  name: "Demo",
  url: "https://example.test/index.js",
  lang: "en",
  version: "1.0.0",
  iconUrl: "https://example.test/icon.png",
};

const VALID_PLUGIN_SOURCE = `
  module.exports.default = {
    id: "demo",
    name: "Demo",
    url: "https://example.test/index.js",
    lang: "en",
    version: "1.0.0",
    iconUrl: "https://example.test/icon.png",
    popularNovels: () => Promise.resolve([]),
    parseNovel: () => Promise.resolve({ name: "", path: "", chapters: [] }),
    parseNovelSince: () => Promise.resolve({ name: "", path: "", chapters: [] }),
    parseChapter: () => Promise.resolve(""),
    searchNovels: () => Promise.resolve([]),
    getBaseUrl: () => "https://example.test",
  };
`;

const LAZY_LOAD_MARKER = "__noreaPluginLazyLoadCount";

const COUNTING_PLUGIN_SOURCE = `
  globalThis.${LAZY_LOAD_MARKER} = (globalThis.${LAZY_LOAD_MARKER} ?? 0) + 1;
  module.exports.default = {
    id: "demo",
    name: "Demo",
    url: "https://example.test/index.js",
    lang: "en",
    version: "1.0.0",
    iconUrl: "https://example.test/icon.png",
    popularNovels: () => Promise.resolve([{ name: "Novel", path: "/novel" }]),
    parseNovel: () => Promise.resolve({ name: "", path: "", chapters: [] }),
    parseNovelSince: () => Promise.resolve({ name: "", path: "", chapters: [] }),
    parseChapter: () => Promise.resolve(""),
    searchNovels: () => Promise.resolve([]),
    getBaseUrl: () => "https://example.test",
  };
`;

function installedRow(sourceCode = VALID_PLUGIN_SOURCE) {
  return {
    id: VALID_ITEM.id,
    name: VALID_ITEM.name,
    lang: VALID_ITEM.lang,
    version: VALID_ITEM.version,
    iconUrl: VALID_ITEM.iconUrl,
    sourceUrl: VALID_ITEM.url,
    sourceCode,
    installedAt: 1,
  };
}

function lazyLoadCount(): number | undefined {
  const value = (globalThis as Record<string, unknown>)[LAZY_LOAD_MARKER];
  return typeof value === "number" ? value : undefined;
}

function clearLazyLoadCount(): void {
  delete (globalThis as Record<string, unknown>)[LAZY_LOAD_MARKER];
}

beforeEach(() => {
  vi.clearAllMocks();
  clearLazyLoadCount();
  mockedDeleteInstalledPlugin.mockResolvedValue(undefined);
  mockedListInstalledPlugins.mockResolvedValue([]);
});

describe("isValidPluginItem", () => {
  it("accepts a fully-typed PluginItem", () => {
    expect(isValidPluginItem(VALID_ITEM)).toBe(true);
  });

  it("rejects null / non-object inputs", () => {
    expect(isValidPluginItem(null)).toBe(false);
    expect(isValidPluginItem(undefined)).toBe(false);
    expect(isValidPluginItem("string")).toBe(false);
    expect(isValidPluginItem(42)).toBe(false);
  });

  it("rejects when a required string field is missing", () => {
    const broken = { ...VALID_ITEM } as Record<string, unknown>;
    delete broken.lang;
    expect(isValidPluginItem(broken)).toBe(false);
  });

  it("rejects when a required string field is the wrong type", () => {
    expect(isValidPluginItem({ ...VALID_ITEM, version: 1 })).toBe(false);
  });
});

describe("PluginManager.fetchRepository", () => {
  it("returns valid PluginItems and drops malformed entries", async () => {
    const manager = new PluginManager();
    mockedFetchText.mockResolvedValueOnce(
      JSON.stringify([VALID_ITEM, { id: "broken" }, "junk"]),
    );

    const items = await manager.fetchRepository(
      "https://example.test/repo.json",
    );

    expect(items).toEqual([VALID_ITEM]);
    expect(mockedFetchText).toHaveBeenCalledWith(
      "https://example.test/repo.json",
    );
  });

  it("throws PluginValidationError on non-JSON response", async () => {
    const manager = new PluginManager();
    mockedFetchText.mockResolvedValueOnce("not json");

    await expect(
      manager.fetchRepository("https://example.test/repo.json"),
    ).rejects.toBeInstanceOf(PluginValidationError);
  });

  it("throws PluginValidationError when JSON isn't an array", async () => {
    const manager = new PluginManager();
    mockedFetchText.mockResolvedValueOnce(JSON.stringify({ items: [] }));

    await expect(
      manager.fetchRepository("https://example.test/repo.json"),
    ).rejects.toBeInstanceOf(PluginValidationError);
  });
});

describe("PluginManager.installPlugin", () => {
  it("downloads the plugin, sandbox-loads it, and registers under the id", async () => {
    const manager = new PluginManager();
    mockedFetchText.mockResolvedValueOnce(VALID_PLUGIN_SOURCE);

    const plugin = await manager.installPlugin(VALID_ITEM);

    expect(plugin.id).toBe("demo");
    expect(manager.has("demo")).toBe(true);
    expect(manager.size()).toBe(1);
    expect(manager.getPlugin("demo")).toBe(plugin);
    expect(mockedCreateFetchShim).toHaveBeenCalledWith(
      expect.any(Function),
      VALID_ITEM.id,
      "immediate",
    );
  });

  it("compiles source during install validation", async () => {
    const manager = new PluginManager();
    mockedFetchText.mockResolvedValueOnce(COUNTING_PLUGIN_SOURCE);

    await manager.installPlugin(VALID_ITEM);

    expect(lazyLoadCount()).toBe(1);
    expect(manager.getInstalledPluginMetadata("demo")).toEqual(
      expect.objectContaining({
        loadedExecutors: ["immediate"],
      }),
    );
  });

  it("throws PluginValidationError when ids don't match", async () => {
    const manager = new PluginManager();
    mockedFetchText.mockResolvedValueOnce(
      VALID_PLUGIN_SOURCE.replace('"demo"', '"other"'),
    );

    await expect(manager.installPlugin(VALID_ITEM)).rejects.toBeInstanceOf(
      PluginValidationError,
    );
    expect(manager.has("demo")).toBe(false);
  });
});

describe("PluginManager.installPluginFromSource", () => {
  it("sandbox-loads a local source and registers under the exported id", async () => {
    const manager = new PluginManager();

    const plugin = await manager.installPluginFromSource(
      VALID_PLUGIN_SOURCE,
      "local:demo.js",
    );

    expect(plugin.id).toBe("demo");
    expect(manager.has("demo")).toBe(true);
    expect(manager.size()).toBe(1);
    expect(manager.getPlugin("demo")).toBe(plugin);
    expect(mockedCreateFetchShim.mock.calls).toEqual([
      [undefined, undefined, "immediate"],
      [expect.any(Function), VALID_ITEM.id, "immediate"],
    ]);
  });

  it("rejects local sources that omit required contract functions", async () => {
    const manager = new PluginManager();
    const missingIncrementalParser = VALID_PLUGIN_SOURCE.replace(
      "    parseNovelSince: () => Promise.resolve({ name: \"\", path: \"\", chapters: [] }),\n",
      "",
    );

    await expect(
      manager.installPluginFromSource(
        missingIncrementalParser,
        "local:broken.js",
      ),
    ).rejects.toBeInstanceOf(PluginValidationError);
    expect(manager.has("demo")).toBe(false);
  });

  it("rejects local sources with an invalid base URL", async () => {
    const manager = new PluginManager();
    const emptyBaseUrl = VALID_PLUGIN_SOURCE.replace(
      '    getBaseUrl: () => "https://example.test",\n',
      '    getBaseUrl: () => "",\n',
    );

    await expect(
      manager.installPluginFromSource(emptyBaseUrl, "local:broken.js"),
    ).rejects.toBeInstanceOf(PluginValidationError);
    expect(manager.has("demo")).toBe(false);
  });

  it("installs local sources that rely on repository-only metadata", async () => {
    const manager = new PluginManager();
    const repositoryOnlyMetadata = VALID_PLUGIN_SOURCE.replace(
      '    lang: "en",\n',
      "",
    ).replace(
      '    iconUrl: "https://example.test/icon.png",\n',
      "",
    );

    const plugin = await manager.installPluginFromSource(
      repositoryOnlyMetadata,
      "local:demo.js",
    );

    expect(plugin.lang).toBe("multi");
    expect(plugin.iconUrl).toBe("");
    expect(manager.has("demo")).toBe(true);
  });
});

describe("PluginManager.loadInstalledFromDb", () => {
  it("loads installed plugin metadata without evaluating stored source", async () => {
    const manager = new PluginManager();
    mockedListInstalledPlugins.mockResolvedValueOnce([
      installedRow(COUNTING_PLUGIN_SOURCE),
    ]);

    await manager.loadInstalledFromDb();

    expect(lazyLoadCount()).toBeUndefined();
    expect(mockedCreateFetchShim).not.toHaveBeenCalled();
    expect(manager.list()).toHaveLength(1);
    expect(manager.getPlugin("demo")).toMatchObject({
      id: "demo",
      name: "Demo",
      lang: "en",
      version: "1.0.0",
      iconUrl: "https://example.test/icon.png",
      url: "https://example.test/index.js",
    });
    expect(manager.listInstalledPluginMetadata()).toEqual([
      expect.objectContaining({
        id: "demo",
        name: "Demo",
        sourceHash: expect.any(String),
        loadedExecutors: [],
      }),
    ]);
  });

  it("compiles an installed plugin on first runtime use", async () => {
    const manager = new PluginManager();
    mockedListInstalledPlugins.mockResolvedValueOnce([
      installedRow(COUNTING_PLUGIN_SOURCE),
    ]);
    await manager.loadInstalledFromDb();

    const plugin = manager.getPlugin("demo");
    expect(plugin).toBeDefined();
    await expect(plugin!.popularNovels(1)).resolves.toEqual([
      { name: "Novel", path: "/novel" },
    ]);

    expect(lazyLoadCount()).toBe(1);
    expect(manager.getInstalledPluginMetadata("demo")).toEqual(
      expect.objectContaining({
        loadedExecutors: ["immediate"],
      }),
    );
    expect(mockedCreateFetchShim).toHaveBeenCalledWith(
      expect.any(Function),
      "demo",
      "immediate",
    );
  });

  it("compiles executor-specific runtimes through the existing fetch shim", async () => {
    const manager = new PluginManager();
    mockedListInstalledPlugins.mockResolvedValueOnce([
      installedRow(COUNTING_PLUGIN_SOURCE),
    ]);
    await manager.loadInstalledFromDb();

    const runtime = manager.getPluginForExecutor("demo", "pool:0");

    expect(runtime.id).toBe("demo");
    expect(lazyLoadCount()).toBe(1);
    expect(manager.getInstalledPluginMetadata("demo")).toEqual(
      expect.objectContaining({
        loadedExecutors: ["pool:0"],
      }),
    );
    expect(mockedCreateFetchShim).toHaveBeenCalledWith(
      expect.any(Function),
      "demo",
      "pool:0",
    );
  });

  it("surfaces broken installed source on use instead of startup", async () => {
    const manager = new PluginManager();
    mockedListInstalledPlugins.mockResolvedValueOnce([
      installedRow("const x = ;"),
    ]);

    await expect(manager.loadInstalledFromDb()).resolves.toBeUndefined();
    expect(manager.has("demo")).toBe(true);
    expect(manager.getInstalledPluginMetadata("demo")).toEqual(
      expect.objectContaining({
        loadedExecutors: [],
      }),
    );

    const plugin = manager.getPlugin("demo");
    expect(plugin).toBeDefined();
    await expect(plugin!.searchNovels("query", 1)).rejects.toThrow(
      "Plugin source failed to compile.",
    );
  });
});

describe("PluginManager.uninstallPlugin", () => {
  it("removes a previously installed plugin and reports false on a miss", async () => {
    const values = new Map<string, string>([
      ["plugin:demo:url", "https://komga.test/"],
    ]);
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return values.size;
        },
        key(index: number) {
          return [...values.keys()][index] ?? null;
        },
        getItem(key: string) {
          return values.get(key) ?? null;
        },
        setItem(key: string, value: string) {
          values.set(key, value);
        },
        removeItem(key: string) {
          values.delete(key);
        },
      } as Storage,
    });
    const manager = new PluginManager();
    mockedFetchText.mockResolvedValueOnce(VALID_PLUGIN_SOURCE);
    await manager.installPlugin(VALID_ITEM);

    try {
      await expect(manager.uninstallPlugin("demo")).resolves.toBe(true);
      expect(manager.has("demo")).toBe(false);
      expect(manager.size()).toBe(0);
      expect(values.has("plugin:demo:url")).toBe(false);
      await expect(manager.uninstallPlugin("demo")).resolves.toBe(false);
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: original,
      });
    }
  });

  it("keeps the plugin installed when persisted deletion fails", async () => {
    const manager = new PluginManager();
    mockedFetchText.mockResolvedValueOnce(VALID_PLUGIN_SOURCE);
    await manager.installPlugin(VALID_ITEM);
    mockedDeleteInstalledPlugin.mockRejectedValueOnce(
      new Error("database is locked"),
    );

    await expect(manager.uninstallPlugin("demo")).rejects.toThrow(
      "Failed to delete installed plugin 'demo' during uninstall.",
    );
    expect(manager.has("demo")).toBe(true);
  });
});

describe("PluginManager.list", () => {
  it("returns an empty array when nothing is installed", () => {
    expect(new PluginManager().list()).toEqual([]);
  });
});
