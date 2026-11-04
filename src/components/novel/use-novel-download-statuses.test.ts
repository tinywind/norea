import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChapterDownloadEvent,
  ChapterDownloadStatus,
} from "../../lib/tasks/chapter-download";
import type { ChapterListRow } from "../../db/queries/chapter";

const state = vi.hoisted(() => ({
  effects: [] as Array<() => (() => void) | undefined>,
  statuses: new Map<number, ChapterDownloadStatus>(),
  listener: undefined as ((event: ChapterDownloadEvent) => void) | undefined,
  frame: undefined as FrameRequestCallback | undefined,
  cleanup: undefined as (() => void) | undefined,
  current: new Map<number, ChapterDownloadStatus>(),
  updates: 0,
}));

vi.mock("react", () => ({
  useEffect: (effect: () => (() => void) | undefined) => state.effects.push(effect),
  useState: () => [
    state.statuses,
    (update: (previous: typeof state.statuses) => typeof state.statuses) => {
      state.updates += 1;
      state.statuses = update(state.statuses);
    },
  ],
}));

vi.mock("../../lib/tasks/chapter-download", () => ({
  getChapterDownloadStatus: (id: number) => state.current.get(id),
  subscribeChapterDownloads: (listener: typeof state.listener) => {
    state.listener = listener;
    return () => { state.listener = undefined; };
  },
}));

import { STATUS_FLUSH_MIN_INTERVAL_MS, useNovelDownloadStatuses } from "./use-novel-download-statuses";

beforeEach(() => {
  vi.useFakeTimers();
  state.effects.length = 0;
  state.statuses = new Map();
  state.current = new Map();
  state.frame = undefined;
  state.updates = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    state.frame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => { state.frame = undefined; });
  useNovelDownloadStatuses(42, []);
  state.cleanup = state.effects[0]!();
});

afterEach(() => {
  state.cleanup?.();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function runFrame() {
  const frame = state.frame;
  state.frame = undefined;
  frame?.(0);
}

function sendStatus(status: ChapterDownloadStatus, id = 1) {
  state.listener!({
    job: {
      id,
      novelId: 42,
      pluginId: "source",
      chapterPath: "/chapter/1",
      title: "First chapter",
    },
    status,
    task: {
      id: "chapter.download:1",
      lane: "source",
      kind: "chapter.download",
      priority: "user",
      title: "First chapter",
      status: status.kind === "done" ? "succeeded" : status.kind,
      createdAt: 1,
      canCancel: true,
      canRetry: false,
    },
  });
}

function emitStatus(status: ChapterDownloadStatus) {
  sendStatus(status);
  runFrame();
  vi.advanceTimersByTime(STATUS_FLUSH_MIN_INTERVAL_MS);
}

describe("novel download status updates", () => {
  it("does not subscribe or initialize statuses while hidden", () => {
    state.cleanup?.();
    state.effects = [];
    state.current.set(1, { kind: "running" });
    useNovelDownloadStatuses(42, [{ id: 1 } as ChapterListRow], false);
    state.effects.forEach(effect => effect());
    expect(state.listener).toBeUndefined();
    expect(state.statuses.size).toBe(0);
  });

  it("loads only this novel's statuses on activation and drops obsolete entries", () => {
    state.effects = [];
    state.statuses.set(9, { kind: "running" });
    state.current.set(1, { kind: "queued" });
    state.current.set(2, { kind: "running" });
    useNovelDownloadStatuses(42, [{ id: 1 } as ChapterListRow], true);
    state.effects[1]!();
    expect([...state.statuses]).toEqual([[1, { kind: "queued" }]]);
  });
  it.each(["running", "queued"] as const)(
    "keeps phase changes while the status remains %s",
    (kind) => {
      emitStatus({ kind, phase: "server-download" });
      const previous = state.statuses;

      emitStatus({ kind, phase: "source-download" });

      expect(state.statuses.get(1)).toEqual({ kind, phase: "source-download" });
      expect(state.statuses).not.toBe(previous);
    },
  );

  it("drops a stale phase when a later event does not identify its source", () => {
    emitStatus({ kind: "running", phase: "source-download" });
    emitStatus({ kind: "running" });

    expect(state.statuses.get(1)).toEqual({ kind: "running" });
  });

  it("preserves unchanged phases and clears cancelled downloads", () => {
    emitStatus({ kind: "running", phase: "server-download" });
    const previous = state.statuses;
    emitStatus({ kind: "running", phase: "server-download" });

    expect(state.statuses).toBe(previous);

    emitStatus({ kind: "cancelled" });
    expect(state.statuses.has(1)).toBe(false);
  });

  it("applies 1000 status events at most four times a second and keeps the last status of each chapter", () => {
    const startedAt = performance.now();
    for (let index = 0; index < 1000; index += 1) {
      const chapterId = (index % 100) + 1;
      sendStatus(index >= 900 ? { kind: "done" } : { kind: "running" }, chapterId);
      runFrame();
      vi.advanceTimersByTime(5);
    }
    vi.advanceTimersByTime(STATUS_FLUSH_MIN_INTERVAL_MS);
    const elapsedMs = performance.now() - startedAt;

    expect(state.updates).toBeLessThanOrEqual(Math.ceil(elapsedMs / STATUS_FLUSH_MIN_INTERVAL_MS) + 1);
    expect(state.statuses.size).toBe(100);
    expect([...state.statuses.values()].every((status) => status.kind === "done")).toBe(true);
  });

  it("shows a status after an idle interval on the next frame", () => {
    emitStatus({ kind: "running" });
    vi.advanceTimersByTime(STATUS_FLUSH_MIN_INTERVAL_MS);
    sendStatus({ kind: "queued" }, 2);
    runFrame();

    expect(state.statuses.get(2)).toEqual({ kind: "queued" });
  });
});
