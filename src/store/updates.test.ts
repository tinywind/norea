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
});
