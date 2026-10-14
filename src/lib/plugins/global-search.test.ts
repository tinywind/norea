import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelAndroidScraperExecutor } from "../android-scraper";
import { taskScheduler } from "../tasks/scheduler";
import { PluginManager } from "./manager";
import { globalSearch } from "./global-search";
import type { NovelItem, Plugin } from "./types";

vi.mock("../android-scraper", () => ({
  cancelAndroidScraperExecutor: vi.fn(),
}));

function makePlugin(
  id: string,
  searchImpl: (term: string, page: number) => Promise<NovelItem[]>,
): Plugin {
  return {
    apiVersion: "0.2",
    id,
    name: `Plugin ${id}`,
    lang: "en",
    version: "1.0.0",
    url: `https://${id}.test/index.js`,
    iconUrl: `https://${id}.test/icon.png`,
    getBaseUrl: () => `https://${id}.test`,
    popularNovels: () => Promise.resolve([]),
    parseNovel: () =>
      Promise.resolve({ name: "", path: "", chapters: [] }),
    parseNovelSince: () =>
      Promise.resolve({ name: "", path: "", chapters: [] }),
    getChapterAcquisitionPlan: () => ({ type: "resource" }),
    searchNovels: searchImpl,
  };
}

function makeManager(plugins: Plugin[]): PluginManager {
  const manager = new PluginManager();
  // Bypass installPlugin's network path — drop directly into the
  // in-memory map.
  const installed = (
    manager as unknown as { installed: Map<string, Plugin> }
  ).installed;
  for (const plugin of plugins) {
    installed.set(plugin.id, plugin);
  }
  return manager;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe("globalSearch", () => {
  beforeEach(() => {
    vi.mocked(cancelAndroidScraperExecutor).mockClear();
    taskScheduler.resumeSourceQueue();
    taskScheduler.setSourceForegroundConcurrency(3);
  });

  it("returns [] when no plugins are installed", async () => {
    const manager = new PluginManager();
    const results = await globalSearch(manager, "anything");
    expect(results).toEqual([]);
  });

  it("collects results from every plugin", async () => {
    const manager = makeManager([
      makePlugin("a", async () => [{ name: "A1", path: "/a/1" }]),
      makePlugin("b", async () => [{ name: "B1", path: "/b/1" }]),
    ]);

    const results = await globalSearch(manager, "x");

    const ids = results.map((r) => r.pluginId).sort();
    expect(ids).toEqual(["a", "b"]);
    const a = results.find((r) => r.pluginId === "a")!;
    expect(a.novels).toEqual([{ name: "A1", path: "/a/1" }]);
    expect(a.error).toBeUndefined();
  });

  it("captures plugin errors into the per-row error field", async () => {
    const manager = makeManager([
      makePlugin("ok", async () => [{ name: "OK", path: "/ok" }]),
      makePlugin("bad", async () => {
        throw new Error("source unreachable");
      }),
    ]);

    const results = await globalSearch(manager, "x");

    const bad = results.find((r) => r.pluginId === "bad")!;
    expect(bad.error).toBe("source unreachable");
    expect(bad.novels).toEqual([]);
    const ok = results.find((r) => r.pluginId === "ok")!;
    expect(ok.error).toBeUndefined();
  });

  it("searches only the supplied source scope", async () => {
    const excludedSearch = vi.fn(async () => []);
    const selected = makePlugin("selected", async () => []);
    const manager = makeManager([
      makePlugin("excluded", excludedSearch),
      selected,
    ]);

    const results = await globalSearch(manager, "scoped", {
      plugins: [selected],
    });

    expect(results.map((result) => result.pluginId)).toEqual(["selected"]);
    expect(excludedSearch).not.toHaveBeenCalled();
  });

  it("does not fall back to all sources when the scope is empty", async () => {
    const search = vi.fn(async () => []);
    const manager = makeManager([makePlugin("excluded", search)]);

    expect(await globalSearch(manager, "empty", { plugins: [] })).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it("replaces queued searches without running sources outside the new scope", async () => {
    const excludedSearch = vi.fn(async () => []);
    const selectedSearch = vi.fn(async () => []);
    const selected = makePlugin("selected", selectedSearch);
    const manager = makeManager([
      makePlugin("excluded", excludedSearch),
      selected,
    ]);
    const previousController = new AbortController();
    const previousResult = vi.fn();

    taskScheduler.pauseSourceQueue();
    try {
      const previousSearch = globalSearch(manager, "same query", {
        signal: previousController.signal,
        onResult: previousResult,
      });
      previousController.abort();
      const scopedSearch = globalSearch(manager, "same query", {
        plugins: [selected],
      });
      taskScheduler.resumeSourceQueue();

      expect(await previousSearch).toEqual([]);
      expect((await scopedSearch).map((result) => result.pluginId)).toEqual([
        "selected",
      ]);
      expect(previousResult).not.toHaveBeenCalled();
      expect(excludedSearch).not.toHaveBeenCalled();
      expect(selectedSearch).toHaveBeenCalledOnce();
    } finally {
      taskScheduler.resumeSourceQueue();
    }
  });

  it("captures plugin timeouts into the per-row error field", async () => {
    const manager = makeManager([
      makePlugin("slow", async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [{ name: "Late", path: "/late" }];
      }),
    ]);

    const results = await globalSearch(manager, "x", { timeoutMs: 5 });

    expect(results).toHaveLength(1);
    expect(results[0]?.pluginId).toBe("slow");
    expect(results[0]?.novels).toEqual([]);
    expect(results[0]?.error).toContain("Search timed out");
    expect(cancelAndroidScraperExecutor).toHaveBeenCalledWith(
      "scraper: global search timed out",
      "search:0",
    );
  });

  it("searches while download source queues are paused", async () => {
    let started = 0;
    const manager = makeManager([
      makePlugin("queued", async () => {
        started += 1;
        return [{ name: "Ready", path: "/ready" }];
      }),
    ]);

    taskScheduler.pauseSourceQueue();
    try {
      const promise = globalSearch(manager, "x", { timeoutMs: 5 });
      await settle();

      expect(started).toBe(1);

      const results = await promise;

      expect(started).toBe(1);
      expect(results[0]?.novels).toEqual([{ name: "Ready", path: "/ready" }]);
      expect(results[0]?.error).toBeUndefined();
    } finally {
      taskScheduler.resumeSourceQueue();
    }
  });

  it("invokes onResult once per plugin", async () => {
    const manager = makeManager([
      makePlugin("a", async () => []),
      makePlugin("b", async () => []),
      makePlugin("c", async () => []),
    ]);
    const onResult = vi.fn();

    await globalSearch(manager, "x", { onResult });

    expect(onResult).toHaveBeenCalledTimes(3);
  });

  it("searches in parallel when download concurrency is one", async () => {
    taskScheduler.setSourceForegroundConcurrency(1);
    let active = 0;
    let maxActive = 0;
    const slow = (id: string) =>
      makePlugin(id, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return [];
      });

    const manager = makeManager([
      slow("a"),
      slow("b"),
      slow("c"),
      slow("d"),
    ]);

    await globalSearch(manager, "x");

    expect(maxActive).toBe(3);
  });

  it("does not change the concurrency of queued downloads", async () => {
    taskScheduler.setSourceForegroundConcurrency(1);
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const downloads = ["download-a", "download-b"].map(id => taskScheduler.enqueueSource({
      kind: "chapter.download",
      priority: "user",
      title: id,
      source: { id, name: id },
      run: async () => { started.push(id); await gate; },
    }));

    try {
      await settle();
      expect(started).toEqual(["download-a"]);
      const manager = makeManager([makePlugin("search", async () => [])]);
      await globalSearch(manager, "x");
      await settle();
      expect(started).toEqual(["download-a"]);
    } finally {
      release();
      await Promise.all(downloads.map(task => task.promise));
    }
  });

  it("keeps search concurrency independent of a larger download pool", async () => {
    taskScheduler.setSourceForegroundConcurrency(8);
    let active = 0;
    let maxActive = 0;
    const slow = (id: string) =>
      makePlugin(id, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return [];
      });

    const manager = makeManager([
      slow("a"),
      slow("b"),
      slow("c"),
      slow("d"),
      slow("e"),
    ]);

    await globalSearch(manager, "x");

    expect(maxActive).toBe(3);
  });

  it("discards results once the signal is aborted before any task starts", async () => {
    const manager = makeManager([
      makePlugin("a", async () => [{ name: "x", path: "/x" }]),
    ]);
    const controller = new AbortController();
    controller.abort();

    const results = await globalSearch(manager, "x", {
      signal: controller.signal,
    });

    expect(results).toEqual([]);
  });

  it("short-circuits remaining tasks once the signal aborts mid-flight", async () => {
    let started = 0;
    const slow = (id: string) =>
      makePlugin(id, async () => {
        started += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return [];
      });
    const manager = makeManager([
      slow("a"),
      slow("b"),
      slow("c"),
      slow("d"),
      slow("e"),
    ]);
    const controller = new AbortController();

    const promise = globalSearch(manager, "x", {
      signal: controller.signal,
    });
    // Let the first search group start, then abort.
    await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();

    const results = await promise;
    expect(results.length).toBeLessThan(5);
    expect(started).toBeLessThan(5);
  });
});
