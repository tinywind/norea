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
}));

vi.mock("react", () => ({
  useEffect: (effect: () => (() => void) | undefined) => state.effects.push(effect),
  useState: () => [
    state.statuses,
    (update: (previous: typeof state.statuses) => typeof state.statuses) => {
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

import { useNovelDownloadStatuses } from "./use-novel-download-statuses";

beforeEach(() => {
  state.effects.length = 0;
  state.statuses = new Map();
  state.current = new Map();
  state.frame = undefined;
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
});

function emitStatus(status: ChapterDownloadStatus) {
  state.listener!({
    job: {
      id: 1,
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
  const frame = state.frame;
  state.frame = undefined;
  frame?.(0);
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
});
