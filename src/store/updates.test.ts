import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibraryUpdateEntry } from "../db/queries/chapter";
import { useUpdatesStore } from "./updates";

const initialState = useUpdatesStore.getInitialState();

afterEach(() => {
  useUpdatesStore.setState(initialState, true);
});

describe("updates store download completion", () => {
  it("does not notify hidden consumers for an unrelated chapter", () => {
    useUpdatesStore.setState({
      updates: [{ chapterId: 11, isDownloaded: false } as LibraryUpdateEntry],
    });
    const listener = vi.fn();
    const unsubscribe = useUpdatesStore.subscribe(listener);

    useUpdatesStore.getState().markChapterDownloaded(99);

    expect(listener).not.toHaveBeenCalled();
    expect(useUpdatesStore.getState().updates[0]?.isDownloaded).toBe(false);
    unsubscribe();
  });

  it("updates the matching chapter once", () => {
    useUpdatesStore.setState({
      updates: [{ chapterId: 11, isDownloaded: false } as LibraryUpdateEntry],
    });
    const listener = vi.fn();
    const unsubscribe = useUpdatesStore.subscribe(listener);

    useUpdatesStore.getState().markChapterDownloaded(11);
    useUpdatesStore.getState().markChapterDownloaded(11);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(useUpdatesStore.getState().updates[0]?.isDownloaded).toBe(true);
    unsubscribe();
  });

  it("updates a batch of matching chapters with one notification", () => {
    useUpdatesStore.setState({
      updates: [
        { chapterId: 11, isDownloaded: false } as LibraryUpdateEntry,
        { chapterId: 12, isDownloaded: false } as LibraryUpdateEntry,
      ],
    });
    const listener = vi.fn();
    const unsubscribe = useUpdatesStore.subscribe(listener);

    useUpdatesStore.getState().markChaptersDownloaded([11, 12]);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(
      useUpdatesStore.getState().updates.map((entry) => entry.isDownloaded),
    ).toEqual([true, true]);
    unsubscribe();
  });
});

describe("updates store check results", () => {
  const result = (failedNovelIds: number[]) => ({
    checkedNovels: 1, newChapters: 0, skippedNovels: 0, hasMoreUpdates: false, nextUpdateCursor: null, updates: [],
    failures: failedNovelIds.map((novelId) => ({
      novelId, novelName: `Novel ${novelId}`, pluginId: "s", reason: { kind: "error" as const, message: "x" },
    })),
  });

  it("keeps the failures of novels a retry did not cover", () => {
    useUpdatesStore.getState().applyCheckResult(result([1, 2, 3]));
    useUpdatesStore.getState().applyCheckResult(result([2]), [1, 2]);
    expect(useUpdatesStore.getState().lastCheckResult?.failures.map((failure) => failure.novelId)).toEqual([3, 2]);
    useUpdatesStore.getState().applyCheckResult(result([]));
    expect(useUpdatesStore.getState().lastCheckResult?.failures).toEqual([]);
  });
});

describe("updates store views", () => {
  const row = (chapterId: number) => ({ chapterId, isDownloaded: false } as LibraryUpdateEntry);

  it("drops the loaded rows when switching lists and keeps the backlog when a check finishes", () => {
    useUpdatesStore.getState().replaceWindow({ hasMore: false, nextCursor: null, updates: [row(1)] });
    useUpdatesStore.getState().setView("backlog");
    expect(useUpdatesStore.getState()).toMatchObject({ view: "backlog", hasLoaded: false, updates: [] });

    useUpdatesStore.getState().replaceWindow({ hasMore: false, nextCursor: null, updates: [row(5), row(6)] });
    useUpdatesStore.getState().applyCheckResult({
      checkedNovels: 1, newChapters: 1, skippedNovels: 0, failures: [], hasMoreUpdates: false, nextUpdateCursor: null, updates: [row(9)],
    });
    expect(useUpdatesStore.getState().updates.map((entry) => entry.chapterId)).toEqual([5, 6]);
    expect(useUpdatesStore.getState().lastCheckResult?.newChapters).toBe(1);
  });
});
