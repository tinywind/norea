import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client", () => ({
  runDatabaseTransaction: vi.fn(),
}));

import { runDatabaseTransaction } from "../client";
import { applyNovelMergeInDb } from "./novel-merge";

const mockedRunDatabaseTransaction = vi.mocked(runDatabaseTransaction);
let mockExecute: ReturnType<typeof vi.fn>;
let mockSelect: ReturnType<typeof vi.fn>;

const sourceNovel = {
  id: 1,
  pluginId: "source-a",
  inLibrary: 1,
  isLocal: 0,
  libraryAddedAt: 10,
  lastReadAt: 40,
};

const targetNovel = {
  id: 2,
  pluginId: "source-b",
  inLibrary: 0,
  isLocal: 0,
  libraryAddedAt: null,
  lastReadAt: 30,
};

function sourceChapter(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    novelId: 1,
    path: "/a/1",
    bookmark: 1,
    unread: 0,
    progress: 70,
    isDownloaded: 1,
    sourceContentType: "html",
    contentType: "html",
    contentBytes: 120,
    mediaBytes: 30,
    mediaRepairNeeded: 0,
    mediaBytesCheckedAt: 50,
    readAt: 40,
    ...overrides,
  };
}

function targetChapter(overrides: Record<string, unknown> = {}) {
  return {
    id: 21,
    novelId: 2,
    path: "/b/1",
    bookmark: 0,
    unread: 1,
    progress: 20,
    isDownloaded: 0,
    sourceContentType: "pdf",
    contentType: "pdf",
    contentBytes: 0,
    mediaBytes: 0,
    mediaRepairNeeded: 0,
    mediaBytesCheckedAt: null,
    readAt: 30,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
  mockSelect = vi
    .fn()
    .mockResolvedValueOnce([sourceNovel, targetNovel])
    .mockResolvedValueOnce([sourceChapter(), targetChapter()]);
  mockedRunDatabaseTransaction.mockImplementation(async (run) =>
    run({ execute: mockExecute, select: mockSelect } as never),
  );
});

describe("applyNovelMergeInDb", () => {
  it("keeps B identity while merging mapped A state and prepared content", async () => {
    const result = await applyNovelMergeInDb({
      sourceNovelId: 1,
      targetNovelId: 2,
      decisions: [
        { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
      ],
      preparedDownloads: [
        {
          sourceChapterId: 11,
          contentType: "html",
          contentBytes: 125,
          mediaBytes: 35,
          transferredFromSource: true,
        },
      ],
    });

    expect(result).toEqual({
      targetNovelId: 2,
      chapterIdMap: { 11: 21 },
      preferredLastReadChapterId: 21,
      transferredDownloads: 1,
    });

    const statements = mockExecute.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("DELETE FROM chapter_download_queue"))).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT OR IGNORE INTO novel_category"))).toBe(true);

    const targetUpdateCall = mockExecute.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE chapter") && String(sql).includes("stored_content_type"),
    );
    expect(String(targetUpdateCall?.[0])).not.toMatch(/\n\s*content_type\s*=/);
    expect(targetUpdateCall?.[1]).toEqual([
      21,
      1,
      0,
      70,
      40,
      1,
      "html",
      125,
      35,
    ]);

    const deleteSourceCall = mockExecute.mock.calls.find(([sql]) =>
      String(sql).includes("DELETE FROM novel"),
    );
    expect(deleteSourceCall?.[1]).toEqual([1]);
  });

  it("leaves an existing B download unchanged when native storage kept it", async () => {
    mockSelect
      .mockReset()
      .mockResolvedValueOnce([sourceNovel, targetNovel])
      .mockResolvedValueOnce([
        sourceChapter(),
        targetChapter({
          isDownloaded: 1,
          contentType: "pdf",
          contentBytes: 900,
        }),
      ]);

    await applyNovelMergeInDb({
      sourceNovelId: 1,
      targetNovelId: 2,
      decisions: [
        { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
      ],
      preparedDownloads: [],
    });

    const targetUpdateCall = mockExecute.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE chapter") && String(sql).includes("stored_content_type"),
    );
    expect(targetUpdateCall?.[1]?.[5]).toBe(0);
    expect(targetUpdateCall?.[1]?.[6]).toBeNull();
  });

  it("adopts retained B metadata when its download flag was stale", async () => {
    mockSelect
      .mockReset()
      .mockResolvedValueOnce([sourceNovel, targetNovel])
      .mockResolvedValueOnce([
        sourceChapter({ isDownloaded: 0 }),
        targetChapter(),
      ]);

    const result = await applyNovelMergeInDb({
      sourceNovelId: 1,
      targetNovelId: 2,
      decisions: [
        { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
      ],
      preparedDownloads: [
        {
          sourceChapterId: 11,
          contentType: "pdf",
          contentBytes: 900,
          mediaBytes: 0,
          transferredFromSource: false,
        },
      ],
    });

    const targetUpdateCall = mockExecute.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE chapter") && String(sql).includes("stored_content_type"),
    );
    expect(targetUpdateCall?.[1]?.slice(5, 9)).toEqual([1, "pdf", 900, 0]);
    expect(result.transferredDownloads).toBe(0);
  });

  it("adopts copied A metadata when the B download flag was stale", async () => {
    mockSelect
      .mockReset()
      .mockResolvedValueOnce([sourceNovel, targetNovel])
      .mockResolvedValueOnce([
        sourceChapter(),
        targetChapter({
          isDownloaded: 1,
          contentType: "pdf",
          contentBytes: 900,
        }),
      ]);

    const result = await applyNovelMergeInDb({
      sourceNovelId: 1,
      targetNovelId: 2,
      decisions: [
        { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
      ],
      preparedDownloads: [
        {
          sourceChapterId: 11,
          contentType: "html",
          contentBytes: 125,
          mediaBytes: 35,
          transferredFromSource: true,
        },
      ],
    });

    const targetUpdateCall = mockExecute.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE chapter") && String(sql).includes("stored_content_type"),
    );
    expect(targetUpdateCall?.[1]?.[5]).toBe(1);
    expect(targetUpdateCall?.[1]?.[6]).toBe("html");
    expect(result.transferredDownloads).toBe(1);
  });

  it("updates multiple mapped B chapters in one bulk statement", async () => {
    mockSelect
      .mockReset()
      .mockResolvedValueOnce([sourceNovel, targetNovel])
      .mockResolvedValueOnce([
        sourceChapter(),
        sourceChapter({ id: 12, path: "/a/2" }),
        targetChapter(),
        targetChapter({ id: 22, path: "/b/2" }),
      ]);

    await applyNovelMergeInDb({
      sourceNovelId: 1,
      targetNovelId: 2,
      decisions: [
        { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
        { sourceChapterId: 12, kind: "map", targetChapterPath: "/b/2" },
      ],
      preparedDownloads: [],
    });

    const chapterUpdateCalls = mockExecute.mock.calls.filter(([sql]) =>
      String(sql).includes("UPDATE chapter") && String(sql).includes("merge_updates"),
    );
    expect(chapterUpdateCalls).toHaveLength(1);
    expect(chapterUpdateCalls[0]?.[1]).toHaveLength(18);
  });

  it("requires an explicit decision for every A chapter", async () => {
    mockSelect
      .mockReset()
      .mockResolvedValueOnce([sourceNovel, targetNovel])
      .mockResolvedValueOnce([
        sourceChapter(),
        sourceChapter({ id: 12, path: "/a/greeting" }),
        targetChapter(),
      ]);

    await expect(
      applyNovelMergeInDb({
        sourceNovelId: 1,
        targetNovelId: 2,
        decisions: [
          { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/1" },
        ],
        preparedDownloads: [],
      }),
    ).rejects.toThrow("Every source chapter must have one decision");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("rejects a mapping to a chapter that does not belong to B", async () => {
    await expect(
      applyNovelMergeInDb({
        sourceNovelId: 1,
        targetNovelId: 2,
        decisions: [
          { sourceChapterId: 11, kind: "map", targetChapterPath: "/b/missing" },
        ],
        preparedDownloads: [],
      }),
    ).rejects.toThrow("Target chapter no longer exists");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("allows an A-only author note to be explicitly excluded", async () => {
    const result = await applyNovelMergeInDb({
      sourceNovelId: 1,
      targetNovelId: 2,
      decisions: [{ sourceChapterId: 11, kind: "exclude" }],
      preparedDownloads: [],
    });

    expect(result.chapterIdMap).toEqual({});
    expect(result.transferredDownloads).toBe(0);
    const novelUpdateCall = mockExecute.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE novel"),
    );
    expect(novelUpdateCall?.[1]?.[3]).toBe(30);
    expect(
      mockExecute.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM novel")),
    ).toBe(true);
  });

  it("rejects local novels and same-plugin targets", async () => {
    mockSelect.mockReset().mockResolvedValueOnce([
      { ...sourceNovel, isLocal: 1 },
      targetNovel,
    ]);
    await expect(
      applyNovelMergeInDb({
        sourceNovelId: 1,
        targetNovelId: 2,
        decisions: [{ sourceChapterId: 11, kind: "exclude" }],
        preparedDownloads: [],
      }),
    ).rejects.toThrow("remote novels only");

    mockSelect.mockReset().mockResolvedValueOnce([
      sourceNovel,
      { ...targetNovel, pluginId: sourceNovel.pluginId },
    ]);
    await expect(
      applyNovelMergeInDb({
        sourceNovelId: 1,
        targetNovelId: 2,
        decisions: [{ sourceChapterId: 11, kind: "exclude" }],
        preparedDownloads: [],
      }),
    ).rejects.toThrow("different source plugins");
  });
});
