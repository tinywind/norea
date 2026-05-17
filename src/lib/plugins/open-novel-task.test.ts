import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRunContext } from "../tasks/scheduler";
import type { ScraperExecutorId } from "../tasks/scraper-queue";
import type { NovelItem, Plugin } from "./types";

vi.mock("../tasks/source-tasks", () => ({
  enqueueSourceTask: vi.fn(() => ({
    id: "task-open",
    promise: Promise.resolve(7),
  })),
}));

vi.mock("./import-novel", () => ({
  importNovelFromSource: vi.fn(() => Promise.resolve(7)),
}));

import { enqueueSourceTask } from "../tasks/source-tasks";
import { importNovelFromSource } from "./import-novel";
import { enqueueOpenNovelFromSourceTask } from "./open-novel-task";

function makePlugin(id = "demo"): Plugin {
  return {
    id,
    name: "Demo",
    lang: "en",
    version: "1.0.0",
    url: "https://demo.test/index.js",
    iconUrl: "https://demo.test/icon.png",
    getBaseUrl: () => "https://demo.test",
    popularNovels: () => Promise.resolve([]),
    parseNovel: () => Promise.resolve({ name: "", path: "", chapters: [] }),
    parseNovelSince: () =>
      Promise.resolve({ name: "", path: "", chapters: [] }),
    parseChapter: () => Promise.resolve(""),
    searchNovels: () => Promise.resolve([]),
  };
}

function makeContext(executor?: ScraperExecutorId): TaskRunContext {
  return {
    executor,
    signal: new AbortController().signal,
    taskId: "task-open",
    setDetail: vi.fn(),
    setProgress: vi.fn(),
  };
}

const novel: NovelItem = {
  name: "Novel",
  path: "/novel",
};

describe("enqueueOpenNovelFromSourceTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enqueues source.openNovel on the source task lane", () => {
    const plugin = makePlugin();

    const handle = enqueueOpenNovelFromSourceTask({
      plugin,
      item: novel,
      title: "Open Novel",
    });

    expect(handle.id).toBe("task-open");
    expect(enqueueSourceTask).toHaveBeenCalledWith(
      expect.objectContaining({
        plugin,
        kind: "source.openNovel",
        priority: "interactive",
        title: "Open Novel",
        subject: {
          novelName: "Novel",
          path: "/novel",
          pluginId: "demo",
        },
        dedupeKey: "source.openNovel:demo:/novel",
      }),
    );
  });

  it("imports through the runtime bound to the assigned source executor", async () => {
    const plugin = makePlugin();
    const runtimePlugin = makePlugin("runtime-demo");
    const manager = {
      getPluginForExecutor: vi.fn(() => runtimePlugin),
    };

    enqueueOpenNovelFromSourceTask({
      plugin,
      item: novel,
      title: "Open Novel",
      manager,
    });

    const options = vi.mocked(enqueueSourceTask).mock.calls[0]![0];
    await options.run(makeContext("pool:1"));

    expect(manager.getPluginForExecutor).toHaveBeenCalledWith("demo", "pool:1");
    expect(importNovelFromSource).toHaveBeenCalledWith(
      runtimePlugin,
      novel,
      undefined,
    );
  });
});
