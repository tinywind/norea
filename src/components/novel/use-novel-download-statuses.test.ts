import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChapterDownloadEvent,
  ChapterDownloadStatus,
} from "../../lib/tasks/chapter-download";
import type { ChapterListRow } from "../../db/queries/chapter";
import type { StoredChapterDownloadFailure } from "../../db/queries/chapter-download-failure";

const state = vi.hoisted(() => ({
  effects: [] as Array<() => (() => void) | undefined>,
  statuses: new Map<number, ChapterDownloadStatus>(),
  listener: undefined as ((event: ChapterDownloadEvent) => void) | undefined,
  frame: undefined as FrameRequestCallback | undefined,
  cleanup: undefined as (() => void) | undefined,
  current: new Map<number, ChapterDownloadStatus>(),
  failures: [] as StoredChapterDownloadFailure[],
  failuresActive: undefined as boolean | undefined,
  updates: 0,
}));

vi.mock("react", () => ({
  useMemo: <T>(calculate: () => T) => calculate(),
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

vi.mock("../../lib/tasks/hooks", () => ({
  useChapterDownloadFailureSnapshot: (active: boolean) => {
    state.failuresActive = active;
    return state.failures;
  },
}));

import { STATUS_FLUSH_MIN_INTERVAL_MS, useNovelDownloadStatuses } from "./use-novel-download-statuses";

beforeEach(() => {
  vi.useFakeTimers();
  state.effects.length = 0;
  state.statuses = new Map();
  state.current = new Map();
  state.failures = [];
  state.failuresActive = undefined;
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


function storedFailure(overrides: Partial<StoredChapterDownloadFailure> = {}): StoredChapterDownloadFailure {
  return {
    chapterId: 1, pluginId: "source", failureClass: "transient", messageSummary: "Stored source failure",
    challengeUrl: null, attempts: 1, nextRetryAt: null, updatedAt: 1,
    jobJson: JSON.stringify({ id: 1, novelId: 42, pluginId: "source", chapterPath: "/old-path" }),
    ...overrides,
  };
}

const storedRow = { id: 1, novelId: 42, path: "/current-path" } as ChapterListRow;

describe("persisted novel download failures", () => {
  it("shows a saved failure without scheduler history after restart and keeps the current row path", () => {
    state.failures = [storedFailure()];
    const statuses = useNovelDownloadStatuses(42, [storedRow], true, "source");
    expect([...statuses]).toEqual([[1, { kind: "failed", error: "Stored source failure" }]]);
    expect(storedRow.path).toBe("/current-path");
    expect(state.statuses.size).toBe(0);
  });

  it.each<ChapterDownloadStatus>([
    { kind: "queued", phase: "source-download" },
    { kind: "running", phase: "server-download" },
    { kind: "done" },
    { kind: "failed", error: "Current attempt failure" },
  ])("preserves a current $kind status over an older saved failure", current => {
    state.failures = [storedFailure()];
    state.current.set(1, current);
    state.statuses.set(1, current);
    const statuses = useNovelDownloadStatuses(42, [storedRow], true, "source");
    expect(statuses).toBe(state.statuses);
    expect(statuses.get(1)).toEqual(current);
  });

  it.each<ChapterDownloadStatus>([{ kind: "queued" }, { kind: "running" }, { kind: "cancelled" }])(
    "does not revive a saved failure while a newer $kind event is waiting for its UI flush", current => {
      state.failures = [storedFailure()];
      state.current.set(1, current);
      expect(useNovelDownloadStatuses(42, [storedRow], true, "source").has(1)).toBe(false);
    },
  );

  it("drops the fallback as soon as its saved failure is cleared", () => {
    state.failures = [storedFailure()];
    expect(useNovelDownloadStatuses(42, [storedRow], true, "source").get(1)?.kind).toBe("failed");
    state.failures = [];
    expect(useNovelDownloadStatuses(42, [storedRow], true, "source").has(1)).toBe(false);
  });

  it("only merges failures of this source and the current novel's chapter rows", () => {
    state.failures = [
      storedFailure({ pluginId: "other-source" }),
      storedFailure({ chapterId: 2 }),
      storedFailure({ chapterId: 3 }),
    ];
    const rows = [storedRow, { id: 2, novelId: 99 } as ChapterListRow];
    expect(useNovelDownloadStatuses(42, rows, true, "source").size).toBe(0);
    expect(useNovelDownloadStatuses(42, [storedRow], true).size).toBe(0);
  });

  it("does not subscribe to or merge persisted failures while the novel is hidden", () => {
    state.failures = [storedFailure()];
    expect(useNovelDownloadStatuses(42, [storedRow], false, "source").size).toBe(0);
    expect(state.failuresActive).toBe(false);
  });
});
