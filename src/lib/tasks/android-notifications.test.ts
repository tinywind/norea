import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const schedulerMocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  requeueRunningInterruptibleDownloads: vi.fn(),
  subscribe: vi.fn(),
  subscribeEvents: vi.fn(),
  yieldRunningInterruptibleDownloads: vi.fn(),
}));

vi.mock("../tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(() => true),
}));
vi.mock("./scheduler", () => ({
  taskScheduler: schedulerMocks,
}));

import {
  startAndroidBackgroundDownloadRecovery,
  startAndroidTaskNotifications,
} from "./android-notifications";

type BrowserEventTarget = "document" | "window";

const listeners = new Map<string, () => void>();
let visibilityState: DocumentVisibilityState;

function eventKey(target: BrowserEventTarget, type: string): string {
  return `${target}:${type}`;
}

function installBrowserHarness(): void {
  vi.stubGlobal("document", {
    addEventListener: (type: string, listener: () => void) => {
      listeners.set(eventKey("document", type), listener);
    },
    get visibilityState() {
      return visibilityState;
    },
    removeEventListener: (type: string) => {
      listeners.delete(eventKey("document", type));
    },
  });
  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: () => void) => {
      listeners.set(eventKey("window", type), listener);
    },
    removeEventListener: (type: string) => {
      listeners.delete(eventKey("window", type));
    },
  });
}

function dispatch(target: BrowserEventTarget, type: string): void {
  listeners.get(eventKey(target, type))?.();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-04T00:00:00Z"));
  vi.clearAllMocks();
  listeners.clear();
  visibilityState = "visible";
  installBrowserHarness();
  schedulerMocks.subscribe.mockReturnValue(vi.fn());
  schedulerMocks.subscribeEvents.mockReturnValue(vi.fn());
  schedulerMocks.getSnapshot.mockReturnValue({
    records: [
      {
        kind: "chapter.download",
        priority: "background",
        status: "running",
      },
    ],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("startAndroidTaskNotifications", () => {
  it("coalesces task event bursts before rebuilding the notification", () => {
    let eventListener: (() => void) | undefined;
    const update = vi.fn();
    const stopNative = vi.fn();
    Object.assign(window, {
      __NoreaAndroidTasks: { stop: stopNative, update },
    });
    schedulerMocks.subscribeEvents.mockImplementation(
      (listener: () => void) => {
        eventListener = listener;
        return vi.fn();
      },
    );
    schedulerMocks.getSnapshot.mockReturnValue({
      records: [
        {
          canCancel: true,
          canRetry: false,
          createdAt: 1,
          id: "download-1",
          kind: "chapter.download",
          lane: "source",
          priority: "background",
          progress: { current: 0, total: 2 },
          status: "running",
          title: "Chapter 1",
        },
      ],
    });
    const t = ((key: string) => key) as Parameters<
      typeof startAndroidTaskNotifications
    >[0];

    const dispose = startAndroidTaskNotifications(t, "progress");
    expect(update).toHaveBeenCalledTimes(1);

    schedulerMocks.getSnapshot.mockReturnValue({
      records: [
        {
          canCancel: true,
          canRetry: false,
          createdAt: 1,
          id: "download-1",
          kind: "chapter.download",
          lane: "source",
          priority: "background",
          progress: { current: 1, total: 2 },
          status: "running",
          title: "Chapter 1",
        },
        {
          canCancel: true,
          canRetry: false,
          createdAt: 2,
          id: "download-2",
          kind: "chapter.download",
          lane: "source",
          priority: "background",
          status: "queued",
          title: "Chapter 2",
        },
      ],
    });
    for (let index = 0; index < 20; index += 1) eventListener?.();

    vi.advanceTimersByTime(249);
    expect(update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(update).toHaveBeenCalledTimes(2);

    dispose();
    expect(stopNative).toHaveBeenCalledTimes(1);
  });
});

describe("startAndroidBackgroundDownloadRecovery", () => {
  it("asks running background downloads to yield after returning to foreground", () => {
    const stop = startAndroidBackgroundDownloadRecovery();

    visibilityState = "hidden";
    dispatch("document", "visibilitychange");
    vi.advanceTimersByTime(15_000);
    visibilityState = "visible";
    dispatch("document", "visibilitychange");

    expect(
      schedulerMocks.yieldRunningInterruptibleDownloads,
    ).toHaveBeenCalledTimes(1);
    expect(
      schedulerMocks.requeueRunningInterruptibleDownloads,
    ).not.toHaveBeenCalled();

    stop();
  });

  it("also yields a user-started download after app backgrounding", () => {
    schedulerMocks.getSnapshot.mockReturnValue({
      records: [
        {
          kind: "chapter.download",
          priority: "interactive",
          status: "running",
        },
      ],
    });
    const stop = startAndroidBackgroundDownloadRecovery();

    visibilityState = "hidden";
    dispatch("document", "visibilitychange");
    vi.advanceTimersByTime(15_000);
    visibilityState = "visible";
    dispatch("document", "visibilitychange");

    expect(
      schedulerMocks.yieldRunningInterruptibleDownloads,
    ).toHaveBeenCalledTimes(1);

    stop();
  });
});
