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
import * as pluginShims from "./shims";
import {
  deleteInstalledPlugin,
  listInstalledPlugins,
  upsertInstalledPlugin,
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
const mockedUpsertInstalledPlugin = vi.mocked(upsertInstalledPlugin);

const VALID_ITEM = {
  apiVersion: "0.2" as const,
  id: "demo",
  name: "Demo",
  url: "https://example.test/index.js",
  lang: "en",
  version: "1.0.0",
  iconUrl: "https://example.test/icon.png",
};

const REPO_URL = "https://example.test/plugins.json";
const OTHER_REPO_URL = "https://other.test/plugins.json";

const VALID_PLUGIN_SOURCE = `
  module.exports.default = {
    apiVersion: "0.2",
    id: "demo",
    name: "Demo",
    url: "https://example.test/index.js",
    lang: "en",
    version: "1.0.0",
    iconUrl: "https://example.test/icon.png",
    popularNovels: () => Promise.resolve([]),
    parseNovel: () => Promise.resolve({ name: "", path: "", chapters: [] }),
    parseNovelSince: () => Promise.resolve({ name: "", path: "", chapters: [] }),
    getChapterAcquisitionPlan: () => ({ type: "resource" }),
    searchNovels: () => Promise.resolve([]),
    getBaseUrl: () => "https://example.test",
  };
`;

const LAZY_LOAD_MARKER = "__noreaPluginLazyLoadCount";

const COUNTING_PLUGIN_SOURCE = `
  globalThis.${LAZY_LOAD_MARKER} = (globalThis.${LAZY_LOAD_MARKER} ?? 0) + 1;
  module.exports.default = {
    apiVersion: "0.2",
    id: "demo",
    name: "Demo",
    url: "https://example.test/index.js",
    lang: "en",
    version: "1.0.0",
    iconUrl: "https://example.test/icon.png",
    popularNovels: () => Promise.resolve([{ name: "Novel", path: "/novel" }]),
    parseNovel: () => Promise.resolve({ name: "", path: "", chapters: [] }),
    parseNovelSince: () => Promise.resolve({ name: "", path: "", chapters: [] }),
    getChapterAcquisitionPlan: () => ({ type: "resource" }),
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
    repositoryUrl: REPO_URL as string | null,
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
  mockedUpsertInstalledPlugin.mockResolvedValue(undefined);
});

describe("isValidPluginItem", () => {
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

  it("rejects repository entries from a different plugin API", () => {
    expect(isValidPluginItem({ ...VALID_ITEM, apiVersion: "0.1" })).toBe(false);
    const missing = { ...VALID_ITEM } as Record<string, unknown>;
    delete missing.apiVersion;
    expect(isValidPluginItem(missing)).toBe(false);
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

    const plugin = await manager.installPlugin(VALID_ITEM, REPO_URL);

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

    await manager.installPlugin(VALID_ITEM, REPO_URL);

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

    await expect(manager.installPlugin(VALID_ITEM, REPO_URL)).rejects.toBeInstanceOf(
      PluginValidationError,
    );
    expect(manager.has("demo")).toBe(false);
  });

  it("rejects source code that does not declare API 0.2", async () => {
    const manager = new PluginManager();
    mockedFetchText.mockResolvedValueOnce(
      VALID_PLUGIN_SOURCE.replace('    apiVersion: "0.2",\n', ""),
    );

    await expect(manager.installPlugin(VALID_ITEM, REPO_URL)).rejects.toThrow(
      "apiVersion '0.2'",
    );
  });
});

describe("PluginManager.updatePlugin", () => {
  const NEWER_ITEM = { ...VALID_ITEM, version: "1.1.0" };
  const NEWER_SOURCE = VALID_PLUGIN_SOURCE.replace('version: "1.0.0"', 'version: "1.1.0"');

  async function installedManager(): Promise<PluginManager> {
    const manager = new PluginManager();
    mockedFetchText.mockResolvedValueOnce(VALID_PLUGIN_SOURCE);
    await manager.installPlugin(VALID_ITEM, REPO_URL);
    mockedUpsertInstalledPlugin.mockClear();
    return manager;
  }

  it("stores the new source before swapping the running plugin", async () => {
    const manager = await installedManager();
    const old = manager.getPlugin("demo");
    let runningDuringStore: unknown;
    mockedFetchText.mockResolvedValueOnce(NEWER_SOURCE);
    mockedUpsertInstalledPlugin.mockImplementationOnce(async () => {
      runningDuringStore = manager.getPlugin("demo");
    });

    const updated = await manager.updatePlugin("demo", NEWER_ITEM, REPO_URL);

    expect(runningDuringStore).toBe(old);
    expect(updated.version).toBe("1.1.0");
    expect(manager.getPlugin("demo")).toBe(updated);
    expect(manager.getInstalledPluginMetadata("demo")?.version).toBe("1.1.0");
    expect(mockedUpsertInstalledPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ id: "demo", version: "1.1.0", sourceCode: NEWER_SOURCE }),
    );
  });

  it("keeps the old plugin running when the new source fails validation", async () => {
    const manager = await installedManager();
    const old = manager.getPlugin("demo");
    mockedFetchText.mockResolvedValueOnce(NEWER_SOURCE.replace("searchNovels:", "searchNovelz:"));

    await expect(manager.updatePlugin("demo", NEWER_ITEM, REPO_URL)).rejects.toThrow("searchNovels");

    expect(manager.getPlugin("demo")).toBe(old);
    expect(manager.getInstalledPluginMetadata("demo")?.version).toBe("1.0.0");
    expect(mockedUpsertInstalledPlugin).not.toHaveBeenCalled();
  });

  it("keeps the old plugin running when storing the new source fails", async () => {
    const manager = await installedManager();
    const old = manager.getPlugin("demo");
    mockedFetchText.mockResolvedValueOnce(NEWER_SOURCE);
    mockedUpsertInstalledPlugin.mockRejectedValueOnce(new Error("disk full"));

    await expect(manager.updatePlugin("demo", NEWER_ITEM, REPO_URL)).rejects.toThrow("disk full");

    expect(manager.getPlugin("demo")).toBe(old);
    expect(manager.getInstalledPluginMetadata("demo")?.version).toBe("1.0.0");
  });

  it("keeps the old plugin when the download fails or names another plugin", async () => {
    const manager = await installedManager();
    const old = manager.getPlugin("demo");
    mockedFetchText.mockRejectedValueOnce(new Error("offline"));
    await expect(manager.updatePlugin("demo", NEWER_ITEM, REPO_URL)).rejects.toThrow("offline");
    mockedFetchText.mockResolvedValueOnce(NEWER_SOURCE.replace('"demo"', '"other"'));
    await expect(manager.updatePlugin("demo", NEWER_ITEM, REPO_URL)).rejects.toBeInstanceOf(
      PluginValidationError,
    );

    expect(manager.getPlugin("demo")).toBe(old);
    await expect(manager.updatePlugin("missing", NEWER_ITEM, REPO_URL)).rejects.toThrow("not installed");
  });

  it("updates a source instance from its template and keeps its id, name and inputs", async () => {
    const manager = new PluginManager();
    const template = { ...VALID_ITEM, installMode: "multiSource" as const };
    mockedFetchText.mockResolvedValueOnce(VALID_PLUGIN_SOURCE);
    const instance = await manager.installPluginInstance(template, {
      name: "My shelf",
      inputs: { repository: "owner/shelf" },
    }, REPO_URL);
    mockedFetchText.mockResolvedValueOnce(NEWER_SOURCE);

    const updated = await manager.updatePlugin(instance.id, { ...template, version: "1.1.0" }, REPO_URL);

    expect(updated.id).toBe("demo:owner-shelf");
    expect(updated.name).toBe("My shelf");
    expect(updated.version).toBe("1.1.0");
    expect(manager.getPlugin("demo:owner-shelf")).toBe(updated);
    await expect(manager.updatePlugin(instance.id, NEWER_ITEM, REPO_URL)).rejects.toThrow("cannot be updated");
  });

  it("records the repository a plugin came from and moves it only with an explicit publisher", async () => {
    const manager = await installedManager();
    expect(manager.getPluginRepositoryUrl("demo")).toBe(REPO_URL);
    mockedFetchText.mockResolvedValueOnce(NEWER_SOURCE);

    await manager.updatePlugin("demo", NEWER_ITEM, OTHER_REPO_URL);

    expect(manager.getPluginRepositoryUrl("demo")).toBe(OTHER_REPO_URL);
    expect(mockedUpsertInstalledPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ id: "demo", repositoryUrl: OTHER_REPO_URL }),
    );
    await manager.uninstallPlugin("demo");
    expect(manager.getPluginRepositoryUrl("demo")).toBeNull();
  });

  it("keeps the publisher when an update fails", async () => {
    const manager = await installedManager();
    mockedFetchText.mockRejectedValueOnce(new Error("offline"));

    await expect(manager.updatePlugin("demo", NEWER_ITEM, OTHER_REPO_URL)).rejects.toThrow("offline");

    expect(manager.getPluginRepositoryUrl("demo")).toBe(REPO_URL);
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
      [undefined, "local:demo.js", "immediate"],
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
    expect(manager.getPluginRepositoryUrl("demo")).toBeNull();
    expect(mockedUpsertInstalledPlugin).toHaveBeenLastCalledWith(
      expect.objectContaining({ repositoryUrl: null }),
    );
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
    expect(manager.getPluginRepositoryUrl("demo")).toBe(REPO_URL);
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

  it("releases a disposed VPN executor without replacing other cached runtimes", async () => {
    const manager = new PluginManager();
    mockedListInstalledPlugins.mockResolvedValueOnce([
      installedRow(COUNTING_PLUGIN_SOURCE),
      { ...installedRow(COUNTING_PLUGIN_SOURCE), id: "other" },
    ]);
    await manager.loadInstalledFromDb();

    const immediate = manager.getPluginForExecutor("demo", "immediate");
    await immediate.popularNovels(1);
    const pool = manager.getPluginForExecutor("demo", "pool:0");
    const disposed = manager.getPluginForExecutor("demo", "vpn:0:8");
    const active = manager.getPluginForExecutor("demo", "vpn:1:9");
    manager.getPluginForExecutor("other", "vpn:0:8");
    const otherActive = manager.getPluginForExecutor("other", "vpn:1:9");

    manager.releaseExecutorRuntimes("vpn:0:8");

    expect(manager.getInstalledPluginMetadata("demo")?.loadedExecutors).toEqual([
      "immediate", "pool:0", "vpn:1:9",
    ]);
    expect(manager.getInstalledPluginMetadata("other")?.loadedExecutors).toEqual(["vpn:1:9"]);
    expect(manager.getPluginForExecutor("demo", "immediate")).toBe(immediate);
    expect(manager.getPluginForExecutor("demo", "pool:0")).toBe(pool);
    expect(manager.getPluginForExecutor("demo", "vpn:1:9")).toBe(active);
    expect(manager.getPluginForExecutor("other", "vpn:1:9")).toBe(otherActive);
    expect(lazyLoadCount()).toBe(6);

    manager.releaseExecutorRuntimes("vpn:0:8");
    expect(manager.getPluginForExecutor("demo", "vpn:0:8")).not.toBe(disposed);
    expect(lazyLoadCount()).toBe(7);
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
      ["plugin-v2:demo:url", "https://komga.test/"],
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
    await manager.installPlugin(VALID_ITEM, REPO_URL);

    try {
      await expect(manager.uninstallPlugin("demo")).resolves.toBe(true);
      expect(manager.has("demo")).toBe(false);
      expect(manager.size()).toBe(0);
      expect(values.has("plugin-v2:demo:url")).toBe(false);
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
    await manager.installPlugin(VALID_ITEM, REPO_URL);
    mockedDeleteInstalledPlugin.mockRejectedValueOnce(
      new Error("database is locked"),
    );

    await expect(manager.uninstallPlugin("demo")).rejects.toThrow(
      "Failed to delete installed plugin 'demo' during uninstall.",
    );
    expect(manager.has("demo")).toBe(true);
  });
});

it("keeps an installed plugin when an older host rejects its reconciliation capability module", async () => {
  const manager = new PluginManager();
  mockedFetchText.mockResolvedValue(VALID_PLUGIN_SOURCE);
  const installed = await manager.installPlugin(VALID_ITEM, REPO_URL);
  mockedUpsertInstalledPlugin.mockClear();
  const currentResolver = pluginShims.createShimResolver;
  const legacy = vi.spyOn(pluginShims, "createShimResolver").mockImplementation((...args) => {
    const resolve = currentResolver(...args);
    return id => {
      if (id === "@norea/host-capabilities") throw new Error("Module is not whitelisted in the plugin sandbox.");
      return resolve(id);
    };
  });
  try {
    mockedFetchText.mockResolvedValue('const capabilities = require("@norea/host-capabilities");\n' + VALID_PLUGIN_SOURCE);
    await expect(manager.updatePlugin("demo", { ...VALID_ITEM, version: "1.0.1" }, REPO_URL)).rejects.toThrow("not whitelisted");
    expect(manager.getPlugin("demo")).toBe(installed);
    expect(manager.getPlugin("demo")?.version).toBe("1.0.0");
    expect(mockedUpsertInstalledPlugin).not.toHaveBeenCalled();
  } finally { legacy.mockRestore(); }
});

it("loads a capability-gated plugin on a host that can preserve existing numbered storage", async () => {
  const manager = new PluginManager();
  mockedFetchText.mockResolvedValue('const { sourceChapterNumberReconciliationVersion } = require("@norea/host-capabilities");\n' +
    'if (sourceChapterNumberReconciliationVersion !== 1) throw new Error("Host upgrade required");\n' + VALID_PLUGIN_SOURCE);
  await expect(manager.installPlugin(VALID_ITEM, REPO_URL)).resolves.toMatchObject({ id: "demo" });
  expect(mockedUpsertInstalledPlugin).toHaveBeenCalledOnce();
});
