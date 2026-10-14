import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskScheduler, type SourceTaskSpec, type TaskRunContext } from "./scheduler";

const source = { id: "source", name: "Source" };
const cooldownKey = "chapter-download:source";
const interactions = [
  ["source.openSite", "interactive", "immediate"],
  ["source.clearCookies", "user", "immediate"],
  ["source.openNovel", "interactive", "immediate"],
  ["source.previewNovel", "interactive", "immediate"],
  ["source.mergeNovel", "interactive", "immediate"],
  ["source.listPopular", "interactive", "immediate"],
  ["source.listLatest", "interactive", "immediate"],
  ["source.search", "interactive", "immediate"],
  ["source.globalSearch", "user", "search:0"],
  ["source.refreshNovel", "user", "immediate"],
  ["chapter.download", "interactive", "immediate"],
  ["chapter.repairMedia", "interactive", "immediate"],
] as const;

let scheduler: TaskScheduler;

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function enqueue(spec: SourceTaskSpec<void>) {
  const handle = scheduler.enqueueSource(spec);
  void handle.promise.catch(() => undefined);
  return handle;
}

async function finishDownload(): Promise<void> {
  await enqueue({
    kind: "chapter.download", title: "Completed download", priority: "background", source,
    sourceCooldownKey: cooldownKey, sourceCooldownMs: 10_000,
    run: async () => undefined,
  }).promise;
}

beforeEach(() => {
  vi.useFakeTimers();
  scheduler = new TaskScheduler({ sourceForegroundConcurrency: 1, sourceQueuesPaused: false });
});

afterEach(async () => {
  scheduler.cancelActiveTasks({ discardQueued: true });
  await settle();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("UI interactions independent of download settings", () => {
  it.each(interactions)("starts %s during a paused source and its download cooldown", async (kind, priority, executor) => {
    await finishDownload();
    scheduler.pauseSourceQueue(source.id);
    const events: string[] = [];
    const queued = enqueue({
      kind: "chapter.download", title: "Queued download", priority: "background", source,
      sourceCooldownKey: cooldownKey,
      run: async () => { events.push("queued-download"); },
    });
    const interaction = enqueue({
      kind, priority, title: "UI action", source,
      canCompleteWithoutSourceAccess: true,
      sourceCooldownKey: cooldownKey, sourceCooldownMs: 60_000,
      run: async context => {
        if (context.tryStartSourceAccess?.()) events.push(`ui:${context.executor}`);
      },
    });
    await settle();
    expect(events).toEqual([`ui:${executor}`]);
    expect(scheduler.getTask(interaction.id)?.status).toBe("succeeded");
    expect(scheduler.getTask(queued.id)?.status).toBe("queued");
  });

  it.each([["source.globalSearch", "search:0"], ["source.refreshNovel", "immediate"], ["source.clearCookies", "immediate"]] as const)(
    "runs %s beside a busy same-source download without pausing it", async (kind, executor) => {
      const events: string[] = [];
      let downloadContext!: TaskRunContext;
      let release!: () => void;
      const active = enqueue({
        kind: "chapter.download", title: "Active download", priority: "background", source,
        run: context => new Promise<void>(resolve => {
          downloadContext = context;
          events.push(`download:${context.executor}`);
          release = resolve;
        }),
      });
      await settle();
      const interaction = enqueue({
        kind, title: "UI action", priority: "user", source,
        run: async context => { events.push(`ui:${context.executor}`); },
      });
      try {
        await settle();
        expect(events).toEqual(["download:pool:0", `ui:${executor}`]);
        expect(downloadContext.shouldYield?.()).toBe(false);
        expect(downloadContext.signal.aborted).toBe(false);
        expect(scheduler.getTask(interaction.id)?.status).toBe("succeeded");
      } finally {
        release();
        await active.promise;
      }
    },
  );

  it("keeps the original download deadline when a UI action finishes during cooldown", async () => {
    await finishDownload();
    await vi.advanceTimersByTimeAsync(4_000);
    const events: string[] = [];
    const next = enqueue({
      kind: "chapter.download", title: "Next download", priority: "background", source,
      sourceCooldownKey: cooldownKey,
      run: async () => { events.push("download"); },
    });
    enqueue({
      kind: "chapter.download", title: "Read now", priority: "interactive", source,
      sourceCooldownKey: cooldownKey, sourceCooldownMs: 60_000,
      run: async () => { events.push("read-now"); },
    });
    await settle();
    expect(events).toEqual(["read-now"]);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(events).toEqual(["read-now"]);
    await vi.advanceTimersByTimeAsync(1);
    await next.promise;
    expect(events).toEqual(["read-now", "download"]);
  });

  it.each([undefined, "source"])("keeps an active UI action running when the queue is paused (%s)", async sourceId => {
    let context!: TaskRunContext;
    let release!: () => void;
    const interaction = enqueue({
      kind: "source.search", title: "Search", priority: "interactive", source,
      run: current => new Promise<void>(resolve => { context = current; release = resolve; }),
    });
    await settle();
    try {
      scheduler.pauseSourceQueue(sourceId);
      expect(context.signal.aborted).toBe(false);
      expect(scheduler.getTask(interaction.id)?.status).toBe("running");
    } finally {
      release();
    }
  });

  it("starts a same-source download while a UI request is still running", async () => {
    const events: string[] = [];
    let release!: () => void;
    enqueue({
      kind: "source.search", title: "Search", priority: "interactive", source,
      run: context => new Promise<void>(resolve => { events.push(`ui:${context.executor}`); release = resolve; }),
    });
    await settle();
    enqueue({
      kind: "chapter.download", title: "Download", priority: "background", source,
      run: async context => { events.push(`download:${context.executor}`); },
    });
    try {
      await settle();
      expect(events).toEqual(["ui:immediate", "download:pool:0"]);
    } finally {
      release();
    }
  });

  it("promotes a queued chapter to read-now without waiting for the download cooldown", async () => {
    await finishDownload();
    scheduler.pauseSourceQueue();
    const events: string[] = [];
    const spec: SourceTaskSpec<void> = {
      kind: "chapter.download", title: "Queued chapter", priority: "background", source,
      dedupeKey: "chapter:1", sourceCooldownKey: cooldownKey,
      run: async context => { events.push(`chapter:${context.executor}`); },
    };
    const queued = enqueue(spec);
    const opened = enqueue({ ...spec, priority: "interactive" });
    await settle();
    expect(opened.id).toBe(queued.id);
    expect(events).toEqual(["chapter:immediate"]);
    expect(scheduler.getTask(opened.id)?.status).toBe("succeeded");
  });

  it("starts an explicit read-now attempt while the queued download is waiting to retry", async () => {
    const events: string[] = [];
    const spec: SourceTaskSpec<void> = {
      kind: "chapter.download", title: "Retrying chapter", priority: "background", source,
      dedupeKey: "chapter:retry", retry: () => ({ delayMs: 60_000 }),
      run: async context => {
        events.push(`chapter:${context.executor}`);
        if (events.length === 1) throw new TypeError("Failed to fetch");
      },
    };
    const queued = enqueue(spec);
    await settle();
    expect(scheduler.getTask(queued.id)?.status).toBe("queued");
    const opened = enqueue({ ...spec, priority: "interactive" });
    await settle();
    expect(opened.id).toBe(queued.id);
    expect(events).toEqual(["chapter:pool:0", "chapter:immediate"]);
    expect(scheduler.getTask(opened.id)?.status).toBe("succeeded");
  });

  it("preserves download source order when another source is opened in the UI", async () => {
    scheduler.pauseSourceQueue();
    const events: string[] = [];
    const downloads = ["a", "b"].map(id => enqueue({
      kind: "chapter.download", title: `Download ${id}`, priority: "background", source: { id, name: id },
      run: async () => { events.push(`download:${id}`); },
    }));
    await enqueue({
      kind: "source.search", title: "Search source B", priority: "interactive", source: { id: "b", name: "b" },
      run: async () => { events.push("ui"); },
    }).promise;
    scheduler.resumeSourceQueue();
    await Promise.all(downloads.map(task => task.promise));
    expect(events).toEqual(["ui", "download:a", "download:b"]);
  });

  it("does not run an interaction cancelled before its first callback", async () => {
    const events: string[] = [];
    const task = enqueue({
      kind: "source.search", title: "Superseded search", priority: "interactive", source,
      run: async () => { events.push("source-request"); },
    });
    scheduler.cancel(task.id);
    await settle();
    expect(events).toEqual([]);
  });

  it("keeps UI and download executors available while every search executor is busy", async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const searches = [0, 1, 2].map(index => enqueue({
      kind: "source.globalSearch", priority: "user", title: `Search ${index}`,
      source: { id: `search-${index}`, name: `Search ${index}` },
      run: async context => { events.push(`search:${context.executor}`); await gate; },
    }));
    const download = enqueue({
      kind: "chapter.download", priority: "background", title: "Download", source,
      run: async context => { events.push(`download:${context.executor}`); await gate; },
    });
    const ui = enqueue({
      kind: "source.search", priority: "interactive", title: "Browse source", source,
      run: async context => { events.push(`ui:${context.executor}`); },
    });
    try {
      await settle();
      expect(events).toEqual([
        "search:search:0", "search:search:1", "search:search:2",
        "download:pool:0", "ui:immediate",
      ]);
      expect(scheduler.getTask(ui.id)?.status).toBe("succeeded");
      expect(scheduler.getTask(download.id)?.status).toBe("running");
    } finally {
      release();
      await Promise.all([...searches, download].map(task => task.promise));
    }
  });
});
