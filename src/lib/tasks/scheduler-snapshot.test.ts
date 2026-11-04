import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribePerformanceObservations } from "../observability";
import { SNAPSHOT_FLUSH_MIN_INTERVAL_MS, TaskScheduler } from "./scheduler";

function queuedDownload(scheduler: TaskScheduler) {
  return scheduler.enqueueSource({
    kind: "chapter.download",
    priority: "background",
    source: { id: "source", name: "Source" },
    title: "Chapter",
    run: async () => undefined,
  });
}

function observeFrames() {
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  let builds = 0;
  const unsubscribe = subscribePerformanceObservations((observation) => {
    if (observation.name === "scheduler.snapshot") builds += 1;
  });
  return {
    builds: () => builds,
    unsubscribe,
    flush() {
      const callback = frame;
      frame = undefined;
      callback?.(0);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("scheduler snapshot work", () => {
  it("publishes batched notification pause state when animation frames stop", () => {
    vi.useFakeTimers();
    const scheduler = new TaskScheduler();
    const frames = observeFrames();
    let notificationSnapshot = scheduler.getSnapshot();
    const published = vi.fn(() => {
      notificationSnapshot = scheduler.getSnapshot();
    });
    scheduler.subscribe(published);
    try {
      scheduler.batch(() => {
        scheduler.pauseSourceQueue();
        scheduler.pauseSourceQueue("source");
        scheduler.pauseTaskGroup("downloads");
      });
      expect(notificationSnapshot.sourceQueuesPaused).toBe(false);
      expect(frames.builds()).toBe(0);
      vi.advanceTimersByTime(100);
      expect(notificationSnapshot).toMatchObject({
        sourceQueuesPaused: true,
        pausedSourceIds: ["source"],
        pausedTaskGroups: ["downloads"],
      });
      expect(published).toHaveBeenCalledTimes(1);
      expect(frames.builds()).toBe(1);
      expect(cancelAnimationFrame).toHaveBeenCalledOnce();
      frames.flush();
      expect(published).toHaveBeenCalledTimes(1);

      scheduler.batch(() => {
        scheduler.resumeSourceQueue();
        scheduler.resumeTaskGroup("downloads");
      });
      vi.advanceTimersByTime(SNAPSHOT_FLUSH_MIN_INTERVAL_MS - 1);
      expect(published).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(notificationSnapshot).toMatchObject({
        sourceQueuesPaused: false,
        pausedSourceIds: [],
        pausedTaskGroups: [],
      });
      expect(published).toHaveBeenCalledTimes(2);
      expect(frames.builds()).toBe(2);
    } finally {
      frames.unsubscribe();
    }
  });

  it("cancels the timer fallback when a frame publishes first", () => {
    vi.useFakeTimers();
    const scheduler = new TaskScheduler({ sourceQueuesPaused: true });
    const frames = observeFrames();
    const published = vi.fn();
    scheduler.subscribe(published);
    try {
      queuedDownload(scheduler);
      frames.flush();
      expect(published).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(100);
      expect(published).toHaveBeenCalledTimes(1);
      expect(frames.builds()).toBe(1);
    } finally {
      frames.unsubscribe();
    }
  });

  it("defers full rebuilds while delivering queued task events immediately", () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: true });
    const frames = observeFrames();
    const events = vi.fn();
    scheduler.subscribeEvents(events);
    try {
      for (let index = 0; index < 200; index += 1) {
        queuedDownload(scheduler);
      }
      expect(events).toHaveBeenCalledTimes(200);
      expect(events.mock.lastCall?.[0].task.status).toBe("queued");
      expect(frames.builds()).toBe(0);
      expect(scheduler.getSnapshot().queued).toBe(200);
      expect(frames.builds()).toBe(1);
      frames.flush();
      expect(frames.builds()).toBe(1);
    } finally {
      frames.unsubscribe();
    }
  });

  it("coalesces successive materialization batches into one frame", () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: true });
    const frames = observeFrames();
    const published = vi.fn();
    scheduler.subscribe(published);
    try {
      for (let batch = 0; batch < 8; batch += 1) {
        scheduler.batch(() => {
          for (let index = 0; index < 16; index += 1) {
            queuedDownload(scheduler);
          }
        });
      }
      expect(frames.builds()).toBe(0);
      expect(published).not.toHaveBeenCalled();
      frames.flush();
      expect(frames.builds()).toBe(1);
      expect(published).toHaveBeenCalledTimes(1);
      expect(scheduler.getSnapshot().records).toHaveLength(128);
    } finally {
      frames.unsubscribe();
    }
  });

  it("keeps explicit reads current between a queued transition and its frame", () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: true });
    const frames = observeFrames();
    try {
      const task = queuedDownload(scheduler);
      void task.promise.catch(() => undefined);
      expect(scheduler.getSnapshot().records[0]?.status).toBe("queued");
      expect(frames.builds()).toBe(1);
      scheduler.cancelActiveTasks({ sourceId: "source", discardQueued: true });
      expect(frames.builds()).toBe(1);
      expect(scheduler.getSnapshot()).toMatchObject({ total: 0, queued: 0 });
      expect(frames.builds()).toBe(2);
      frames.flush();
      expect(frames.builds()).toBe(2);
    } finally {
      frames.unsubscribe();
    }
  });

  it("publishes 1000 chapter completions at most four times per second and ends on the exact state", async () => {
    vi.useFakeTimers();
    const scheduler = new TaskScheduler({ terminalTaskRetentionMs: 600_000 });
    const frames = observeFrames();
    const published: ReturnType<TaskScheduler["getSnapshot"]>[] = [];
    scheduler.subscribe(() => published.push(scheduler.getSnapshot()));
    let succeededEvents = 0;
    scheduler.subscribeEvents((event) => {
      if (event.task.status === "succeeded") succeededEvents += 1;
    });
    try {
      const startedAt = performance.now();
      const handles = scheduler.batch(() =>
        Array.from({ length: 1000 }, () =>
          scheduler.enqueueSource({
            kind: "chapter.download",
            priority: "background",
            source: { id: "source", name: "Source" },
            title: "Chapter",
            run: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
          }),
        ),
      );
      const settled = Promise.all(handles.map((handle) => handle.promise));
      let done = false;
      void settled.then(() => { done = true; });
      while (!done) await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_FLUSH_MIN_INTERVAL_MS);
      const elapsedMs = performance.now() - startedAt;

      expect(succeededEvents).toBe(1000);
      expect(published.length).toBeLessThanOrEqual(
        Math.ceil(elapsedMs / SNAPSHOT_FLUSH_MIN_INTERVAL_MS) + 1,
      );
      expect(published.at(-1)).toBe(scheduler.getSnapshot());
      expect(published.at(-1)).toMatchObject({ failed: 0, queued: 0, running: 0 });
    } finally {
      frames.unsubscribe();
    }
  });

  it("publishes a change after an idle interval on the next frame", () => {
    vi.useFakeTimers();
    const scheduler = new TaskScheduler({ sourceQueuesPaused: true });
    const frames = observeFrames();
    const published = vi.fn();
    scheduler.subscribe(published);
    try {
      queuedDownload(scheduler);
      frames.flush();
      expect(published).toHaveBeenCalledTimes(1);

      queuedDownload(scheduler);
      frames.flush();
      expect(published).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(SNAPSHOT_FLUSH_MIN_INTERVAL_MS);
      expect(published).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(SNAPSHOT_FLUSH_MIN_INTERVAL_MS);
      queuedDownload(scheduler);
      frames.flush();
      expect(published).toHaveBeenCalledTimes(3);
      expect(scheduler.getSnapshot().queued).toBe(3);
    } finally {
      frames.unsubscribe();
    }
  });
});
