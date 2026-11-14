import { beforeEach, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../lib/observability", () => ({
  startPerformanceObservation: () => () => undefined,
  recordPerformanceObservation: () => undefined,
}));

import { MAX_CHAPTER_BULK_INPUT_ROWS } from "../../lib/performance-budgets";
import {
  restoreChapterReadStates,
  setChaptersReadState,
  setNovelsReadState,
  setRelativeChaptersReadState,
  updateChapterProgress,
} from "./chapter";

beforeEach(() => {
  invokeMock.mockReset();
});

it("deduplicates positive integer chapter IDs before invoking db_chapter_set_read_state", async () => {
  invokeMock.mockResolvedValueOnce({
    value: {
      rowsAffected: 3,
      chunks: 1,
      previous: [
        { id: 1, unread: false, progress: 100 },
        { id: 2, unread: true, progress: 0 },
        { id: 3, unread: true, progress: 40 },
      ],
    },
    effects: {},
  });

  const change = await setChaptersReadState([1, 2, 2, 0, -5, 3], false);
  expect(invokeMock).toHaveBeenCalledWith("db_chapter_set_read_state", {
    input: { chapterIds: [1, 2, 3], unread: false },
  });
  expect(change.previous).toHaveLength(3);

  invokeMock.mockResolvedValueOnce({
    value: { rowsAffected: 3, chunks: 2 },
    effects: {},
  });
  await expect(restoreChapterReadStates(change.previous)).resolves.toEqual({
    rowsAffected: 3,
    chunks: 2,
  });
  expect(invokeMock).toHaveBeenLastCalledWith(
    "db_chapter_restore_read_states",
    { states: change.previous },
  );
});

it("short-circuits empty or invalid read-state inputs without invoking IPC", async () => {
  await expect(setChaptersReadState([0, -1], true)).resolves.toEqual({
    rowsAffected: 0,
    chunks: 0,
    previous: [],
  });
  await expect(setNovelsReadState([], false)).resolves.toEqual({
    rowsAffected: 0,
    chunks: 0,
    previous: [],
  });
  await expect(restoreChapterReadStates([])).resolves.toEqual({
    rowsAffected: 0,
    chunks: 0,
  });
  await expect(
    restoreChapterReadStates([{ id: 0, progress: 0, unread: true }]),
  ).resolves.toEqual({ rowsAffected: 0, chunks: 0 });
  expect(invokeMock).not.toHaveBeenCalled();
});

it("enforces bulk read-state limits before invoking IPC", async () => {
  const oversized = Array.from(
    { length: MAX_CHAPTER_BULK_INPUT_ROWS + 1 },
    (_, index) => index + 1,
  );
  await expect(setChaptersReadState(oversized, true)).rejects.toThrow(
    "exceeds",
  );
  await expect(
    restoreChapterReadStates(
      oversized.map((id) => ({ id, progress: 0, unread: true })),
    ),
  ).rejects.toThrow("exceeds");
  expect(invokeMock).not.toHaveBeenCalled();
});

it("forwards whole-novel, relative, and progress updates to Rust commands", async () => {
  invokeMock
    .mockResolvedValueOnce({
      value: {
        rowsAffected: 4,
        chunks: 1,
        previous: [{ id: 2, unread: true, progress: 0 }],
      },
      effects: {},
    })
    .mockResolvedValueOnce({
      value: {
        rowsAffected: 2,
        previous: [{ id: 5, unread: false, progress: 100 }],
      },
      effects: {},
    })
    .mockResolvedValueOnce({ value: null, effects: {} });

  await expect(setNovelsReadState([1, 2, 1], false)).resolves.toMatchObject({
    rowsAffected: 4,
  });
  expect(invokeMock).toHaveBeenNthCalledWith(
    1,
    "db_chapter_set_novels_read_state",
    { input: { novelIds: [1, 2], unread: false } },
  );

  await expect(
    setRelativeChaptersReadState(4, "after", true),
  ).resolves.toMatchObject({ rowsAffected: 2 });
  expect(invokeMock).toHaveBeenNthCalledWith(
    2,
    "db_chapter_set_relative_read_state",
    { input: { anchorChapterId: 4, direction: "after", unread: true } },
  );

  await updateChapterProgress(1, 49, { recordHistory: false });
  expect(invokeMock).toHaveBeenNthCalledWith(3, "db_chapter_update_progress", {
    input: { chapterId: 1, progress: 49, recordHistory: false },
  });
});
