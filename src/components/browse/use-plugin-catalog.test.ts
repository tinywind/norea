import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  cache: new Map<string, { fetchedAt: number; items: unknown[] }>(),
  repos: [] as { id: number; url: string; name: string | null; addedAt: number; priority: number; enabled: boolean }[],
}));

vi.mock("../../db/queries/repository", () => ({
  listRepositories: vi.fn(async () => db.repos),
}));
vi.mock("../../db/queries/repo-index-cache", () => ({
  getCachedRepoIndex: vi.fn(async (url: string) => {
    const row = db.cache.get(url);
    return row ? { repoUrl: url, ...row } : null;
  }),
  setCachedRepoIndex: vi.fn(async (url: string, items: unknown[]) => {
    db.cache.set(url, { fetchedAt: NOW, items });
  }),
}));
const installed = vi.hoisted(() => ({
  plugins: [] as { id: string; name: string; version: string }[],
  publishers: new Map<string, string | null>(),
}));

vi.mock("../../lib/plugins/manager", () => ({
  isPluginSourceInstanceOf: () => false,
  isValidPluginItem: () => true,
  pluginManager: {
    fetchRepository: vi.fn(async () => [ITEM]),
    getPluginRepositoryUrl: (id: string) => installed.publishers.get(id) ?? null,
    list: () => installed.plugins,
    loadInstalledFromDb: vi.fn(async () => undefined),
    updatePlugin: vi.fn(async (id: string) => {
      if (id === "broken") throw new Error("broken source");
    }),
  },
}));
vi.mock("../../lib/tasks/main-tasks", () => ({
  enqueueMainTask: vi.fn(({ run }: { run: () => Promise<unknown> }) => ({ promise: run() })),
}));

import { pluginManager } from "../../lib/plugins/manager";
import { enqueueMainTask } from "../../lib/tasks/main-tasks";
import {
  AVAILABLE_QUERY_KEY,
  applyAutomaticExtensionUpdates,
  refreshStaleRepositoryIndexesAtLaunch,
  resetLaunchRepositoryIndexRefreshForTests,
} from "./use-plugin-catalog";

const NOW = 2_000_000;
const DAY = 24 * 60 * 60;
const REPO_URL = "https://repo.example/plugins.json";
const ITEM = {
  apiVersion: "0.2",
  iconUrl: "",
  id: "demo",
  lang: "en",
  name: "Demo",
  url: "https://repo.example/demo.js",
  version: "1.1.0",
};

describe("refreshStaleRepositoryIndexesAtLaunch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLaunchRepositoryIndexRefreshForTests();
    db.cache.clear();
    db.repos = [{ id: 1, url: REPO_URL, name: null, addedAt: 0, priority: 1, enabled: true }];
  });

  it("refetches an index older than a day and publishes it to the catalog", async () => {
    db.cache.set(REPO_URL, { fetchedAt: NOW - DAY, items: [] });
    const queryClient = new QueryClient();

    await expect(refreshStaleRepositoryIndexesAtLaunch(queryClient, NOW)).resolves.toBe(true);

    expect(pluginManager.fetchRepository).toHaveBeenCalledWith(REPO_URL);
    expect(enqueueMainTask).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "repository.refreshIndex" }),
    );
    expect(queryClient.getQueryData(AVAILABLE_QUERY_KEY)).toEqual({
      entries: [{ item: ITEM, repoUrl: REPO_URL }],
      failures: [],
    });
  });

  it("fetches a repository that has no cached index yet", async () => {
    await expect(refreshStaleRepositoryIndexesAtLaunch(new QueryClient(), NOW)).resolves.toBe(true);
    expect(pluginManager.fetchRepository).toHaveBeenCalledTimes(1);
  });

  it("leaves an index from the last day alone", async () => {
    db.cache.set(REPO_URL, { fetchedAt: NOW - DAY + 60, items: [] });

    await expect(refreshStaleRepositoryIndexesAtLaunch(new QueryClient(), NOW)).resolves.toBe(false);
    expect(pluginManager.fetchRepository).not.toHaveBeenCalled();
  });

  it("does nothing without a repository", async () => {
    db.repos = [];
    await expect(refreshStaleRepositoryIndexesAtLaunch(new QueryClient(), NOW)).resolves.toBe(false);
    expect(enqueueMainTask).not.toHaveBeenCalled();
  });

  it("skips a repository that is turned off", async () => {
    db.repos = [
      { id: 1, url: REPO_URL, name: null, addedAt: 0, priority: 1, enabled: false },
    ];
    await expect(refreshStaleRepositoryIndexesAtLaunch(new QueryClient(), NOW)).resolves.toBe(false);
    expect(pluginManager.fetchRepository).not.toHaveBeenCalled();
  });

  it("runs once per session", async () => {
    const queryClient = new QueryClient();
    await refreshStaleRepositoryIndexesAtLaunch(queryClient, NOW);
    await refreshStaleRepositoryIndexesAtLaunch(queryClient, NOW + 2 * DAY);

    expect(pluginManager.fetchRepository).toHaveBeenCalledTimes(1);
  });
});

describe("applyAutomaticExtensionUpdates", () => {
  const OTHER_URL = "https://other.example/plugins.json";
  const entry = (id: string, version: string) => ({ ...ITEM, id, name: id, version });

  beforeEach(() => {
    vi.clearAllMocks();
    db.cache.clear();
    db.repos = [
      { id: 1, url: REPO_URL, name: null, addedAt: 0, priority: 1, enabled: true },
      { id: 2, url: OTHER_URL, name: null, addedAt: 0, priority: 2, enabled: false },
    ];
    installed.plugins = ["demo", "unknown", "elsewhere", "broken", "current"]
      .map((id) => ({ id, name: id, version: "1.0.0" }));
    installed.publishers = new Map([
      ["demo", REPO_URL], ["unknown", null], ["elsewhere", OTHER_URL], ["broken", REPO_URL], ["current", REPO_URL],
    ]);
    db.cache.set(REPO_URL, { fetchedAt: NOW, items: [
      entry("demo", "1.1.0"), entry("unknown", "2.0.0"), entry("elsewhere", "3.0.0"),
      entry("broken", "1.2.0"), entry("current", "1.0.0"),
    ] });
    db.cache.set(OTHER_URL, { fetchedAt: NOW, items: [entry("elsewhere", "4.0.0")] });
  });

  it("updates only from each plugin's own enabled publisher and reports every outcome", async () => {
    const outcomes = await applyAutomaticExtensionUpdates(new QueryClient());

    expect(vi.mocked(pluginManager.updatePlugin).mock.calls.map(([id, item, repoUrl]) => [id, item.version, repoUrl]))
      .toEqual([["demo", "1.1.0", REPO_URL], ["broken", "1.2.0", REPO_URL]]);
    expect(outcomes.map(({ error, plugin }) => [plugin.id, error === undefined])).toEqual([
      ["demo", true],
      ["broken", false],
    ]);
  });

  it("does nothing when no publisher lists a newer version", async () => {
    db.cache.set(REPO_URL, { fetchedAt: NOW, items: [entry("demo", "1.0.0")] });

    await expect(applyAutomaticExtensionUpdates(new QueryClient())).resolves.toEqual([]);
    expect(enqueueMainTask).not.toHaveBeenCalled();
  });
});
