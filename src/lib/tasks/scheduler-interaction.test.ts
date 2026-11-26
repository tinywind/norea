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

  it.each(["source.openNovel", "chapter.download"] as const)("allows explicit %s while a failed download stays stopped", async kind => {
    const events: string[] = [];
    const retry = vi.fn(() => ({ delayMs: 60_000 }));
    const spec: SourceTaskSpec<void> = {
      kind: "chapter.download", title: "Failed chapter", priority: "background", source,
      dedupeKey: "chapter:retry", retry,
      run: async context => {
        events.push(`chapter:${context.executor}`);
        if (events.length === 1) throw new Error("HTTP 429 Too Many Requests");
      },
    };
    const failed = enqueue(spec);
    await expect(failed.promise).rejects.toThrow("HTTP 429 Too Many Requests");
    await settle();
    expect(scheduler.getTask(failed.id)?.status).toBe("failed");
    expect(scheduler.getSnapshot().pausedSourceIds).toContain(source.id);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(events).toEqual(["chapter:pool:0"]);
    expect(retry).not.toHaveBeenCalled();

    const opened = enqueue({ ...spec, kind, priority: "interactive" });
    await settle();
    await opened.promise;
    expect(opened.id).not.toBe(failed.id);
    expect(events).toEqual(["chapter:pool:0", "chapter:immediate"]);
    expect(scheduler.getTask(opened.id)?.status).toBe("succeeded");
    expect(scheduler.getTask(failed.id)?.status).toBe("failed");
    expect(scheduler.getSnapshot().pausedSourceIds).toContain(source.id);
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

describe("serial site dispatch preemption for interactive UI", () => {
  let serialScheduler: TaskScheduler;

  beforeEach(() => {
    serialScheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
      serialSiteDispatch: true,
    });
  });

  afterEach(async () => {
    serialScheduler.cancelActiveTasks({ discardQueued: true });
    await settle();
  });

  it("preempts a running pool download when site browser opens and resumes it after close", async () => {
    const events: string[] = [];
    let downloadRuns = 0;
    let finishResumedDownload!: () => void;
    let closeBrowser!: () => void;

    const download = serialScheduler.enqueueSource({
      kind: "chapter.download",
      title: "Background download",
      priority: "background",
      source: { id: "bookkor-novel", name: "Bookkor" },
      run: (context) => {
        downloadRuns += 1;
        const attempt = downloadRuns;
        events.push(`download:${attempt}:${context.executor}`);
        return new Promise<void>((resolve, reject) => {
          if (attempt === 1) {
            context.signal.addEventListener(
              "abort",
              () => {
                events.push("download:1:aborted");
                reject(new DOMException("Task was paused.", "AbortError"));
              },
              { once: true },
            );
            return;
          }
          finishResumedDownload = resolve;
        });
      },
    });
    void download.promise.catch(() => undefined);
    await settle();
    expect(events).toEqual(["download:1:pool:0"]);

    const browser = serialScheduler.enqueueSource({
      kind: "source.openSite",
      title: "Open GoodToon",
      priority: "interactive",
      exclusive: true,
      source: { id: "goodtoon-webtoon", name: "GoodToon" },
      run: (context) =>
        new Promise<void>((resolve) => {
          events.push(`browser:${context.executor}`);
          closeBrowser = resolve;
        }),
    });
    await settle();

    expect(events).toEqual([
      "download:1:pool:0",
      "download:1:aborted",
      "browser:immediate",
    ]);
    expect(serialScheduler.getTask(download.id)?.status).toBe("queued");
    expect(serialScheduler.getTask(browser.id)?.status).toBe("running");

    closeBrowser();
    await browser.promise;
    await settle();

    expect(events).toEqual([
      "download:1:pool:0",
      "download:1:aborted",
      "browser:immediate",
      "download:2:pool:0",
    ]);
    expect(serialScheduler.getTask(download.id)?.status).toBe("running");

    finishResumedDownload();
    await expect(download.promise).resolves.toBeUndefined();
    expect(serialScheduler.getTask(download.id)?.status).toBe("succeeded");
  });

  it("preempts a running pool download for interactive browsing and keeps server-lane transfers running", async () => {
    const events: string[] = [];
    let poolRuns = 0;
    let finishServer!: () => void;
    let finishResumedPool!: () => void;
    let finishBrowse!: () => void;

    const serverDownload = serialScheduler.enqueueSource({
      kind: "chapter.download",
      title: "Server download",
      priority: "background",
      serverLane: true,
      source: { id: "source-a", name: "Source A" },
      run: (context) =>
        new Promise<void>((resolve) => {
          events.push(`server:${context.executor}`);
          finishServer = resolve;
        }),
    });
    const poolDownload = serialScheduler.enqueueSource({
      kind: "chapter.download",
      title: "Pool download",
      priority: "background",
      source: { id: "source-b", name: "Source B" },
      run: (context) => {
        poolRuns += 1;
        const attempt = poolRuns;
        events.push(`pool:${attempt}:${context.executor}`);
        return new Promise<void>((resolve, reject) => {
          if (attempt === 1) {
            context.signal.addEventListener(
              "abort",
              () => {
                events.push("pool:1:aborted");
                reject(new DOMException("Task was paused.", "AbortError"));
              },
              { once: true },
            );
            return;
          }
          finishResumedPool = resolve;
        });
      },
    });
    void poolDownload.promise.catch(() => undefined);
    await settle();

    const browse = serialScheduler.enqueueSource({
      kind: "source.openNovel",
      title: "Open novel",
      priority: "interactive",
      source: { id: "source-c", name: "Source C" },
      run: (context) =>
        new Promise<void>((resolve) => {
          events.push(`browse:${context.executor}`);
          finishBrowse = resolve;
        }),
    });
    await settle();

    expect(serialScheduler.getTask(serverDownload.id)?.status).toBe("running");
    expect(serialScheduler.getTask(poolDownload.id)?.status).toBe("queued");
    expect(serialScheduler.getTask(browse.id)?.status).toBe("running");

    finishBrowse();
    await browse.promise;
    await settle();
    expect(serialScheduler.getTask(poolDownload.id)?.status).toBe("running");

    finishServer();
    finishResumedPool();
    await Promise.all([serverDownload.promise, poolDownload.promise]);
    expect(events).toEqual([
      "server:server:0",
      "pool:1:pool:0",
      "pool:1:aborted",
      "browse:immediate",
      "pool:2:pool:0",
    ]);
  });
});
