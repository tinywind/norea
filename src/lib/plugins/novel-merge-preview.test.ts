import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskRunContext } from "../tasks/scheduler";
import { matchNovelMergeChapters } from "../novel-merge-matching";
import type { SourceNovel } from "./types";

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
      novelId: "target",
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
        novelId: "broken",
        path: "/broken",
        chapters: null,
      }),
    ).toThrow("chapter list");
  });

  it("rejects non-finite chapter numbers", () => {
    expect(() =>
      validateNovelMergeTargetPreview({
        name: "Broken target",
        novelId: "broken",
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
        novelId: "broken",
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
        novelId: "broken",
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
        novelId: "broken",
        path: "/broken",
        cover: 42,
        chapters: [],
      }),
    ).toThrow("cover");
  });
});

describe("validateNovelMergeTargetPreview source contract", () => {
  function bookkorTarget(
    chapters: SourceNovel["chapters"] = [
      {
        name: "1화",
        path: "/bookkor-target/2743-ep-5020267",
        chapterNumber: 346378,
        contentType: "html",
      },
    ],
  ): SourceNovel {
    return {
      name: "Bookkor target",
      novelId: "2743",
      path: "/bookkor-target",
      status: "연재중",
      rating: 4.815,
      chapters,
    };
  }

  it("accepts localized status and matches 345 displayed episodes among 346 internal IDs", () => {
    // Representative metadata shape from the Bookkor preview that failed on Y700.
    const latestIds = [5665920, 5669668, 5672461, 5676769, 5677728];
    const chapters = Array.from({ length: 346 }, (_, index) => ({
      name: `${index + 1}화`,
      path: `/bookkor-target/2743-ep-${5020267 + index}`,
      chapterNumber: index < 341 ? 346378 + index : latestIds[index - 341]!,
      contentType: "html" as const,
      releaseTime: "2026-05-12",
    }));
    const target = bookkorTarget(chapters);

    const preview = validateNovelMergeTargetPreview(target);

    expect(preview).toBe(target);
    expect(preview.status).toBe("연재중");
    expect(preview.chapters).toHaveLength(346);
    expect(preview.chapters[0]?.chapterNumber).toBe(346378);
    expect(preview.chapters.at(-1)?.chapterNumber).toBe(5677728);
    const sources = Array.from({ length: 345 }, (_, index) => ({
      id: index + 1,
      name: `Original novel ${index + 1}화`,
      chapterNumber: String(index + 1),
      isDownloaded: true,
    }));

    expect(matchNovelMergeChapters(sources, preview.chapters)).toEqual({
      matched: sources.map((source, index) => ({
        sourceChapterId: source.id,
        targetChapterPath: chapters[index]!.path,
      })),
      ambiguous: [],
      unmatchedSourceChapterIds: [],
    });
  });

  it.each(["완결", "連載中", "Serializing"])(
    "preserves source-owned status %s",
    (status) => {
      const target = { ...bookkorTarget(), status };
      expect(validateNovelMergeTargetPreview(target)).toBe(target);
    },
  );

  it.each([null, 42, {}, ["연재중"]])(
    "rejects a non-string status without coercion: %j",
    (status) => {
      expect(() =>
        validateNovelMergeTargetPreview({ ...bookkorTarget(), status }),
      ).toThrow("field 'status' must be a string");
    },
  );

  it("still rejects string chapter IDs, including a numeric alias of another row", () => {
    const target = bookkorTarget();
    expect(() =>
      validateNovelMergeTargetPreview({
        ...target,
        chapters: [
          { name: "1화", path: "/chapter/1", chapterNumber: 1 },
          { name: "2화", path: "/chapter/2", chapterNumber: "1" },
        ],
      }),
    ).toThrow("finite chapterNumber");
  });

  it("still rejects duplicate paths even when stable chapter IDs differ", () => {
    expect(() =>
      validateNovelMergeTargetPreview(
        bookkorTarget([
          { name: "1화", path: "/chapter/1", chapterNumber: 346378 },
          { name: "2화", path: "/chapter/1", chapterNumber: 346379 },
        ]),
      ),
    ).toThrow("duplicate chapter path");
  });

  it("leaves repeated displayed episodes for manual matching", () => {
    const target = validateNovelMergeTargetPreview(
      bookkorTarget([
        { name: "1화", path: "/chapter/1", chapterNumber: 346378 },
        { name: "1화", path: "/chapter/2", chapterNumber: 346379 },
      ]),
    );
    expect(
      matchNovelMergeChapters(
        [{ id: 1, name: "1화", chapterNumber: "1", isDownloaded: true }],
        target.chapters,
      ),
    ).toEqual({
      matched: [],
      ambiguous: [
        {
          sourceChapterId: 1,
          reason: "repeatedNumber",
          candidateTargetPaths: ["/chapter/1", "/chapter/2"],
        },
      ],
      unmatchedSourceChapterIds: [],
    });
  });
});
