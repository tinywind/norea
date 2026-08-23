import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskRunContext } from "../tasks/scheduler";

const enqueueSourceTask = vi.hoisted(() => vi.fn());

vi.mock("../tasks/source-tasks", () => ({ enqueueSourceTask }));

const {
  enqueueNovelMergeTargetPreviewTask,
  validateNovelMergeTargetPreview,
} = await import("./novel-merge-preview");

afterEach(() => {
  vi.clearAllMocks();
});

describe("enqueueNovelMergeTargetPreviewTask", () => {
  it("parses the selected target without importing it", async () => {
    const targetNovel = {
      name: "Target novel",
      path: "/novel/target",
      chapters: [
        { name: "Chapter 1", path: "/chapter/1", chapterNumber: 1 },
      ],
    };
    const immediatePlugin = {
      getBaseUrl: vi.fn().mockReturnValue("https://plugin-b.example"),
      id: "plugin-b",
      name: "Plugin B",
    };
    const runtimePlugin = {
      ...immediatePlugin,
      parseNovel: vi.fn().mockResolvedValue(targetNovel),
    };
    const manager = {
      getPlugin: vi.fn().mockReturnValue(immediatePlugin),
      getPluginForExecutor: vi.fn().mockReturnValue(runtimePlugin),
    };
    const runContext: TaskRunContext = {
      executor: "pool:1",
      setDetail: vi.fn(),
      setProgress: vi.fn(),
      signal: new AbortController().signal,
      taskId: "preview-task",
    };
    enqueueSourceTask.mockImplementationOnce(
      (options: { run: (context: TaskRunContext) => Promise<unknown> }) => ({
        id: "preview-task",
        promise: options.run(runContext),
      }),
    );

    const handle = enqueueNovelMergeTargetPreviewTask({
      item: { name: "Target novel", path: "/novel/target" },
      manager,
      pluginId: "plugin-b",
      title: "Preview target",
    });

    await expect(handle.promise).resolves.toEqual(targetNovel);
    expect(manager.getPluginForExecutor).toHaveBeenCalledWith(
      "plugin-b",
      "pool:1",
    );
    expect(runtimePlugin.parseNovel).toHaveBeenCalledWith("/novel/target");
    expect(enqueueSourceTask).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: "source.novelMergePreview:plugin-b:/novel/target",
        kind: "source.previewNovel",
        priority: "interactive",
        subject: {
          novelName: "Target novel",
          novelPath: "/novel/target",
        },
      }),
    );
  });

  it("fails before enqueueing when the target plugin is no longer installed", () => {
    const manager = {
      getPlugin: vi.fn(),
      getPluginForExecutor: vi.fn(),
    };

    expect(() =>
      enqueueNovelMergeTargetPreviewTask({
        item: { name: "Missing", path: "/missing" },
        manager,
        pluginId: "missing-plugin",
        title: "Preview target",
      }),
    ).toThrow("Plugin 'missing-plugin' is not installed.");
    expect(enqueueSourceTask).not.toHaveBeenCalled();
  });

  it("rejects a preview without a chapter array", () => {
    expect(() =>
      validateNovelMergeTargetPreview({
        name: "Broken target",
        path: "/broken",
        chapters: null,
      }),
    ).toThrow("chapter list");
  });

  it("rejects non-finite chapter numbers", () => {
    expect(() =>
      validateNovelMergeTargetPreview({
        name: "Broken target",
        path: "/broken",
        chapters: [
          { name: "Chapter", path: "/chapter", chapterNumber: Infinity },
        ],
      }),
    ).toThrow("finite chapterNumber");
  });

  it("rejects unsupported chapter content types", () => {
    expect(() =>
      validateNovelMergeTargetPreview({
        name: "Broken target",
        path: "/broken",
        chapters: [
          {
            name: "Chapter",
            path: "/chapter",
            chapterNumber: 1,
            contentType: "mobi",
          },
        ],
      }),
    ).toThrow("unsupported contentType");
  });

  it("rejects duplicate chapter numbers that source sync would discard", () => {
    expect(() =>
      validateNovelMergeTargetPreview({
        name: "Broken target",
        path: "/broken",
        chapters: [
          { name: "First", path: "/chapter/1", chapterNumber: 1 },
          { name: "Duplicate", path: "/chapter/2", chapterNumber: 1 },
        ],
      }),
    ).toThrow("duplicate chapterNumber");
  });

  it("rejects malformed optional metadata before the UI renders it", () => {
    expect(() =>
      validateNovelMergeTargetPreview({
        name: "Broken target",
        path: "/broken",
        cover: 42,
        chapters: [],
      }),
    ).toThrow("cover");
  });
});
