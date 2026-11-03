import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterCleanupPreview, ChapterCleanupTarget } from "./chapter-cleanup";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(), protectedIds: vi.fn(), note: vi.fn(), enqueue: vi.fn(), active: vi.fn(),
}));
vi.mock("./chapter-cleanup", async (original) => ({
  ...await original<typeof import("./chapter-cleanup")>(), previewChapterCleanup: mocks.preview,
}));
vi.mock("./download-goals/goal-protection", () => ({ listGoalProtectedChapterIds: mocks.protectedIds }));
vi.mock("./download-goals/goal-service", () => ({ noteDownloadDeletion: mocks.note }));
vi.mock("./tasks/chapter-cleanup", () => ({ enqueueChapterCleanup: mocks.enqueue, isChapterCleanupActive: mocks.active }));

import { useContentSyncStore } from "../store/content-sync";
import { normalizeDownloadGoalSettings, useDownloadGoalSettingsStore } from "../store/download-goals";
import {
  finishedChapterCleanupFilters,
  isFinishedChapterCleanupDue,
  runFinishedChapterCleanup,
  useFinishedChapterCleanupStore,
} from "./finished-chapter-cleanup";

function target(chapterId: number, novelId = 1): ChapterCleanupTarget {
  return {
    candidate: {
      identity: { novel: { id: novelId, pluginId: "source", sourceNovelId: null, path: "/n", name: "N" },
        chapter: { id: chapterId, name: "C", position: chapterId, chapterNumber: null, contentType: "html" } },
      novelPath: "/n", chapterPath: `/${chapterId}`, novelName: "N", chapterName: "C", serverSource: null,
      storageAmbiguous: false, localServerFingerprint: null, unread: false,
    },
    snapshot: { payloadBytes: 10 } as ChapterCleanupTarget["snapshot"],
    server: null,
  };
}

function preview(targets: ChapterCleanupTarget[]): ChapterCleanupPreview {
  return { filters: { reading: "read", categories: { mode: "all" }, server: "any" }, serverSetting: "", targets,
    checked: targets.length, checkedServers: [], workCount: 1, payloadBytes: targets.length * 10, skipped: {} };
}

beforeEach(() => {
  vi.clearAllMocks();
  useDownloadGoalSettingsStore.setState(normalizeDownloadGoalSettings(null));
  useContentSyncStore.setState({ serverUrl: "" });
  useFinishedChapterCleanupStore.setState({ lastRunAt: null, lastRemoval: null });
  mocks.active.mockReturnValue(false);
  mocks.protectedIds.mockResolvedValue(new Set());
});

describe("finished chapter cleanup conditions", () => {
  it("stays off by default and without an accepted no-server warning", () => {
    expect(finishedChapterCleanupFilters()).toBeNull();
    useDownloadGoalSettingsStore.getState().setFinishedChapterCleanup(10, false);
    expect(finishedChapterCleanupFilters()).toBeNull();
  });

  it("removes only chapters the content server fully holds when one is set", () => {
    useDownloadGoalSettingsStore.getState().setFinishedChapterCleanup(10, false);
    useContentSyncStore.setState({ serverUrl: "https://server.test" });
    expect(finishedChapterCleanupFilters()).toEqual({
      reading: "read", categories: { mode: "all" }, server: "server-contains-local", finished: { keepLast: 10 },
    });
  });

  it("ignores server state only after the user accepted that no other copy exists", () => {
    useDownloadGoalSettingsStore.getState().setFinishedChapterCleanup(5, true);
    expect(finishedChapterCleanupFilters()).toMatchObject({ server: "any", finished: { keepLast: 5 } });
  });

  it("is due on first use and once a day after", () => {
    expect(isFinishedChapterCleanupDue(1_000, null)).toBe(true);
    expect(isFinishedChapterCleanupDue(24 * 60 * 60 * 1000, 1)).toBe(false);
    expect(isFinishedChapterCleanupDue(24 * 60 * 60 * 1000 + 1, 1)).toBe(true);
  });
});

describe("runFinishedChapterCleanup", () => {
  beforeEach(() => {
    useDownloadGoalSettingsStore.getState().setFinishedChapterCleanup(5, true);
  });

  it("removes eligible chapters at background priority, keeps goal chapters and records exclusions", async () => {
    mocks.preview.mockResolvedValue(preview([target(1), target(2)]));
    mocks.protectedIds.mockResolvedValue(new Set([2]));
    mocks.enqueue.mockReturnValue({ id: "task", promise: Promise.resolve({
      total: 1, deleted: 1, skipped: 0, failed: 0, cancelled: 0, bytesFreed: 10, results: [{ chapterId: 1, status: "deleted" }],
    }) });

    await runFinishedChapterCleanup();

    expect(mocks.protectedIds).toHaveBeenCalledWith([1]);
    const [approved, , , priority] = mocks.enqueue.mock.calls[0]!;
    expect(approved.targets.map((item: ChapterCleanupTarget) => item.candidate.identity.chapter.id)).toEqual([1]);
    expect(priority).toBe("background");
    expect(mocks.note).toHaveBeenCalledWith("chapter", [1]);
    expect(useFinishedChapterCleanupStore.getState().lastRemoval).toMatchObject({ deleted: 1, bytesFreed: 10 });
  });

  it("skips while another cleanup runs and records a run with nothing to remove", async () => {
    mocks.active.mockReturnValue(true);
    await runFinishedChapterCleanup();
    expect(mocks.preview).not.toHaveBeenCalled();

    mocks.active.mockReturnValue(false);
    mocks.preview.mockResolvedValue(preview([]));
    await runFinishedChapterCleanup();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(useFinishedChapterCleanupStore.getState()).toMatchObject({ lastRemoval: null });
    expect(useFinishedChapterCleanupStore.getState().lastRunAt).not.toBeNull();
  });
});
