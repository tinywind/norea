import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterCleanupCandidate } from "../db/queries/chapter-cleanup";

const mocks = vi.hoisted(() => ({
  listCandidates: vi.fn(),
  protectedIds: vi.fn(),
  enqueue: vi.fn(),
  active: vi.fn(),
  uploadSettledListeners: new Set<() => void>(),
}));
vi.mock("../db/queries/chapter-cleanup", () => ({
  listChapterCleanupCandidates: mocks.listCandidates,
}));
vi.mock("./download-goals/goal-protection", () => ({ listGoalProtectedChapterIds: mocks.protectedIds }));
vi.mock("./tasks/chapter-cleanup", () => ({
  enqueueFinishedChapterCleanup: mocks.enqueue,
  isChapterCleanupActive: mocks.active,
}));
vi.mock("./content-sync/sync", () => ({
  subscribeContentSyncUploadSettled: (listener: () => void) => {
    mocks.uploadSettledListeners.add(listener);
    return () => { mocks.uploadSettledListeners.delete(listener); };
  },
}));

import { emitUserStateApplied } from "../db/user-state-core";
import { useContentSyncStore } from "../store/content-sync";
import { useReaderStore } from "../store/reader";
import { normalizeDownloadGoalSettings, useDownloadGoalSettingsStore } from "../store/download-goals";
import { clearActiveReaderChapters, setActiveReaderChapters } from "./reader-active-chapters";
import { markUpdatesIndexDirty } from "./updates/update-index-events";
import {
  finishedChapterCleanupFilters,
  isFinishedChapterCleanupDue,
  runFinishedChapterCleanup,
  resetFinishedChapterCleanupForTests,
  startFinishedChapterCleanup,
  useFinishedChapterCleanupStore,
} from "./finished-chapter-cleanup";

function candidate(chapterId: number, novelId = 1): ChapterCleanupCandidate {
  return {
    identity: {
      novel: { id: novelId, pluginId: "source", sourceNovelId: "work", path: "/n", name: "N" },
      chapter: { id: chapterId, name: "C", position: chapterId, chapterNumber: String(chapterId), contentType: "html" },
    },
    novelPath: "/n",
    chapterPath: `/${chapterId}`,
    novelName: "N",
    chapterName: "C",
    serverSource: null,
    storageAmbiguous: false,
    localServerFingerprint: null,
    progress: 100,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearActiveReaderChapters();
  mocks.uploadSettledListeners.clear();
  useDownloadGoalSettingsStore.setState(normalizeDownloadGoalSettings(null));
  useContentSyncStore.setState({ serverUrl: "", uploadConflictPolicy: "prefer-complete" });
  useFinishedChapterCleanupStore.setState({ lastRunAt: null, lastRemoval: null });
  mocks.active.mockReturnValue(false);
  mocks.protectedIds.mockResolvedValue(new Set());
  mocks.listCandidates.mockResolvedValue([]);
});

describe("finished chapter cleanup conditions", () => {
  it("stays off by default and without an accepted no-server warning", () => {
    expect(finishedChapterCleanupFilters()).toBeNull();
    useDownloadGoalSettingsStore.getState().setFinishedChapterCleanup(10, false);
    expect(finishedChapterCleanupFilters()).toBeNull();
    useDownloadGoalSettingsStore.getState().setFinishedChapterCleanup(0, false);
    expect(finishedChapterCleanupFilters()).toBeNull();
  });

  it("uses server-complete and allows uninstalled plugins when a content server is configured", () => {
    useDownloadGoalSettingsStore.getState().setFinishedChapterCleanup(10, false);
    useContentSyncStore.setState({ serverUrl: "https://server.test" });
    expect(finishedChapterCleanupFilters()).toEqual({
      reading: "read",
      categories: { mode: "all" },
      server: "server-complete",
      finished: { keepLast: 10, requireInstalledPlugin: false },
    });

    useDownloadGoalSettingsStore.getState().setFinishedChapterCleanup(0, false);
    expect(finishedChapterCleanupFilters()).toEqual({
      reading: "read",
      categories: { mode: "all" },
      server: "server-complete",
      finished: { keepLast: 0, requireInstalledPlugin: false },
    });
  });

  it("ignores server state and requires installed plugins without a server only after user acceptance", () => {
    useDownloadGoalSettingsStore.getState().setFinishedChapterCleanup(0, true);
    expect(finishedChapterCleanupFilters()).toEqual({
      reading: "read",
      categories: { mode: "all" },
      server: "any",
      finished: { keepLast: 0, requireInstalledPlugin: true },
    });
  });

  it("is due on first use and once a day after", () => {
    expect(isFinishedChapterCleanupDue(1_000, null)).toBe(true);
    expect(isFinishedChapterCleanupDue(24 * 60 * 60 * 1000, 1)).toBe(false);
    expect(isFinishedChapterCleanupDue(24 * 60 * 60 * 1000 + 1, 1)).toBe(true);
  });
});

describe("runFinishedChapterCleanup", () => {
  beforeEach(() => {
    useDownloadGoalSettingsStore.getState().setFinishedChapterCleanup(0, true);
  });

  it("removes eligible chapters via lightweight 1-pass task, skips active/goal-protected chapters, and invalidates caches", async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    startFinishedChapterCleanup({ invalidateQueries });
    mocks.listCandidates.mockImplementation(async (_filters, options) =>
      options?.afterId ? [] : [candidate(1), candidate(2), candidate(3)],
    );
    setActiveReaderChapters([3]);
    mocks.protectedIds.mockResolvedValue(new Set([2]));
    mocks.enqueue.mockReturnValue({
      id: "task",
      promise: Promise.resolve({
        total: 1,
        deleted: 1,
        skipped: 0,
        failed: 0,
        cancelled: 0,
        bytesFreed: 10,
        results: [{ chapterId: 1, status: "deleted" }],
      }),
    });

    await runFinishedChapterCleanup();

    expect(mocks.protectedIds).toHaveBeenCalledWith([1]);
    const [, , eligible, , , priority] = mocks.enqueue.mock.calls[0]!;
    expect(eligible.map((item: ChapterCleanupCandidate) => item.identity.chapter.id)).toEqual([1]);
    expect(priority).toBe("background");
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["novel"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["chapter"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["download-cache"] });
    expect(useFinishedChapterCleanupStore.getState().lastRemoval).toMatchObject({ deleted: 1, bytesFreed: 10 });
    // Chapter 3 was deferred because it is open in the reader, so lastRunAt is not advanced.
    expect(useFinishedChapterCleanupStore.getState().lastRunAt).toBeNull();
  });

  it("does not advance lastRunAt when transient server errors or pending uploads skip candidates", async () => {
    useContentSyncStore.setState({ serverUrl: "https://server.test" });
    mocks.listCandidates.mockImplementation(async (_filters, options) =>
      options?.afterId ? [] : [candidate(1)],
    );
    mocks.enqueue.mockReturnValue({
      id: "task",
      promise: Promise.resolve({
        total: 1,
        deleted: 0,
        skipped: 1,
        failed: 0,
        cancelled: 0,
        bytesFreed: 0,
        results: [{ chapterId: 1, status: "skipped", reason: "server-error" }],
      }),
    });

    await runFinishedChapterCleanup();
    expect(useFinishedChapterCleanupStore.getState().lastRunAt).toBeNull();
  });

  it("skips while another cleanup runs and records a run with nothing to remove", async () => {
    mocks.active.mockReturnValue(true);
    await runFinishedChapterCleanup();
    expect(mocks.listCandidates).not.toHaveBeenCalled();

    mocks.active.mockReturnValue(false);
    mocks.listCandidates.mockResolvedValue([]);
    await runFinishedChapterCleanup();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(useFinishedChapterCleanupStore.getState()).toMatchObject({ lastRemoval: null });
    expect(useFinishedChapterCleanupStore.getState().lastRunAt).not.toBeNull();
  });
});

afterEach(() => {
  resetFinishedChapterCleanupForTests();
  clearActiveReaderChapters();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("triggers cleanup in 60s on shared finished reading, reader exit, updates clear, and local reading (not shared resume alone)", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
  useDownloadGoalSettingsStore.getState().setFinishedChapterCleanup(0, true);
  useFinishedChapterCleanupStore.setState({ lastRunAt: Date.now() });
  mocks.listCandidates.mockResolvedValue([]);
  startFinishedChapterCleanup();

  // Shared resume without finished reading must not trigger cleanup.
  useReaderStore.getState().applySharedResume({ novelId: 1, chapterId: 10, anchor: null, openedAt: 1 });
  await vi.advanceTimersByTimeAsync(61_000);
  expect(mocks.listCandidates).not.toHaveBeenCalled();

  // Shared finished reading from another device triggers cleanup in 60s without 24h wait.
  emitUserStateApplied({ resumes: [], hasFinishedReading: true });
  await vi.advanceTimersByTimeAsync(61_000);
  expect(mocks.listCandidates).toHaveBeenCalledTimes(1);

  // Clearing updates tab triggers cleanup in 60s.
  markUpdatesIndexDirty("updates-cleared");
  await vi.advanceTimersByTimeAsync(61_000);
  expect(mocks.listCandidates).toHaveBeenCalledTimes(2);

  // Leaving active reader chapters triggers cleanup in 60s.
  setActiveReaderChapters([10, 11]);
  setActiveReaderChapters([11]);
  await vi.advanceTimersByTimeAsync(61_000);
  expect(mocks.listCandidates).toHaveBeenCalledTimes(3);

  // Local reading progress continues to trigger cleanup in 60s.
  useReaderStore.getState().setLastReadChapter(1, 11);
  await vi.advanceTimersByTimeAsync(61_000);
  expect(mocks.listCandidates).toHaveBeenCalledTimes(4);
});

it("reschedules when finishedChapterKeep is set to 0 or when content-sync uploads settle", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
  useContentSyncStore.setState({ serverUrl: "https://server.test" });
  useFinishedChapterCleanupStore.setState({ lastRunAt: Date.now() });
  mocks.listCandidates.mockResolvedValue([]);
  startFinishedChapterCleanup();

  useDownloadGoalSettingsStore.getState().setFinishedChapterCleanup(0, false);
  await vi.advanceTimersByTimeAsync(31_000);
  expect(mocks.listCandidates).toHaveBeenCalledTimes(1);

  for (const listener of mocks.uploadSettledListeners) listener();
  await vi.advanceTimersByTimeAsync(31_000);
  expect(mocks.listCandidates).toHaveBeenCalledTimes(2);
});
