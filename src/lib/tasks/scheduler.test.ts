import { describe, expect, it, vi } from "vitest";
import { buildSyntheticSourceTasks } from "../../test/fixtures/performance";
import { subscribePerformanceObservations } from "../observability";
import { SourceAccessRequiredError } from "../plugins/source-access";
import {
  taskWorkQueueKey,
  TaskScheduler,
  type TaskRunContext,
} from "./scheduler";
import { activeScraperExecutor } from "./scraper-queue";

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe("TaskScheduler", () => {
  it("runs main and source tasks independently", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const order: string[] = [];

    const main = scheduler.enqueueMain({
      kind: "backup.export",
      title: "Export backup",
      run: async () => {
        order.push("main");
      },
    });
    const source = scheduler.enqueueSource({
      kind: "source.search",
      title: "Search source",
      priority: "interactive",
      source: { id: "p", name: "Plugin" },
      run: async () => {
        order.push("source");
      },
    });

    await Promise.all([main.promise, source.promise]);

    expect(order).toEqual(expect.arrayContaining(["main", "source"]));
    expect(scheduler.getSnapshot().running).toBe(0);
  });

  it("waits for source executors and blocks new source work while clearing WebView cache", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const order: string[] = [];
    let finishImmediate!: () => void;
    let finishPool!: () => void;
    let finishClear!: () => void;

    const pool = scheduler.enqueueSource({
      kind: "source.globalSearch",
      title: "Pool work",
      source: { id: "pool-source", name: "Pool source" },
      run: () =>
        new Promise<void>((resolve) => {
          order.push("pool:start");
          finishPool = resolve;
        }),
    });
    const immediate = scheduler.enqueueSource({
      kind: "source.openNovel",
      title: "Immediate work",
      priority: "interactive",
      source: { id: "immediate-source", name: "Immediate source" },
      run: () =>
        new Promise<void>((resolve) => {
          order.push("immediate:start");
          finishImmediate = resolve;
        }),
    });

    await settle();
    expect(order).toEqual(["pool:start", "immediate:start"]);

    const clearCache = scheduler.enqueueMain({
      kind: "maintenance.clearWebViewCache",
      title: "Clear WebView cache",
      run: async () => {
        order.push("clear:start");
        await new Promise<void>((resolve) => {
          finishClear = resolve;
        });
        order.push("clear:success");
      },
    });
    const laterSource = scheduler.enqueueSource({
      kind: "source.openNovel",
      title: "Later source work",
      priority: "interactive",
      source: { id: "later-source", name: "Later source" },
      run: async () => {
        order.push("later:start");
      },
    });

    await settle();
    expect(scheduler.getTask(clearCache.id)?.status).toBe("queued");
    expect(scheduler.getTask(clearCache.id)?.canCancel).toBe(false);
    expect(scheduler.cancel(clearCache.id)).toBe(false);
    expect(scheduler.getTask(laterSource.id)?.status).toBe("queued");

    finishImmediate();
    await immediate.promise;
    await settle();
    expect(scheduler.getTask(clearCache.id)?.status).toBe("queued");
    expect(scheduler.getTask(laterSource.id)?.status).toBe("queued");

    finishPool();
    await pool.promise;
    await settle();
    expect(scheduler.getTask(clearCache.id)?.status).toBe("running");
    expect(scheduler.getTask(clearCache.id)?.canCancel).toBe(false);
    expect(scheduler.cancel(clearCache.id)).toBe(false);
    expect(scheduler.getTask(laterSource.id)?.status).toBe("queued");
    expect(order).toEqual(["pool:start", "immediate:start", "clear:start"]);

    finishClear();
    await Promise.all([clearCache.promise, laterSource.promise]);
    expect(order).toEqual([
      "pool:start",
      "immediate:start",
      "clear:start",
      "clear:success",
      "later:start",
    ]);
  });

  it("keeps ordinary main work concurrent with source work", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const order: string[] = [];
    let finishMain!: () => void;

    const main = scheduler.enqueueMain({
      kind: "backup.export",
      title: "Export backup",
      run: () =>
        new Promise<void>((resolve) => {
          order.push("main:start");
          finishMain = resolve;
        }),
    });
    const source = scheduler.enqueueSource({
      kind: "source.search",
      title: "Search source",
      source: { id: "source-a", name: "Source A" },
      run: async () => {
        order.push("source:start");
      },
    });

    await source.promise;
    expect(order).toEqual(["main:start", "source:start"]);
    expect(scheduler.getTask(main.id)?.status).toBe("running");

    finishMain();
    await main.promise;
  });

  it("moves queued main work before it starts", async () => {
    const scheduler = new TaskScheduler();
    const order: string[] = [];
    let finishFirst!: () => void;

    const first = scheduler.enqueueMain({
      kind: "backup.export",
      title: "First",
      run: () =>
        new Promise<void>((resolve) => {
          order.push("first:start");
          finishFirst = resolve;
        }),
    });
    const second = scheduler.enqueueMain({
      kind: "repository.refreshIndex",
      title: "Second",
      run: async () => {
        order.push("second:start");
      },
    });
    const third = scheduler.enqueueMain({
      kind: "library.checkUpdates",
      title: "Third",
      run: async () => {
        order.push("third:start");
      },
    });

    await settle();
    expect(scheduler.moveQueuedTask(third.id, "up")).toBe(true);
    expect(
      scheduler.getSnapshot().records.find((task) => task.id === third.id)
        ?.queueIndex,
    ).toBe(0);

    finishFirst();
    await Promise.all([first.promise, second.promise, third.promise]);

    expect(order).toEqual(["first:start", "third:start", "second:start"]);
  });

  it("caps pool source work at the configured executor count", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 2,
      sourceQueuesPaused: false,
    });
    const order: string[] = [];
    const finishers: Array<() => void> = [];

    const tasks = ["a", "b", "c"].map((sourceId) =>
      scheduler.enqueueSource({
        kind: "source.globalSearch",
        title: `Search ${sourceId}`,
        priority: "normal",
        source: { id: sourceId, name: sourceId },
        run: (context) =>
          new Promise<void>((resolve) => {
            order.push(`${sourceId}:${context.executor}:start`);
            finishers.push(resolve);
          }),
      }),
    );

    await settle();
    expect(order).toEqual([
      "a:pool:0:start",
      "b:pool:1:start",
    ]);

    finishers[0]?.();
    await tasks[0]!.promise;
    await settle();

    expect(order).toEqual([
      "a:pool:0:start",
      "b:pool:1:start",
      "c:pool:0:start",
    ]);

    finishers[1]?.();
    finishers[2]?.();
    await Promise.all(tasks.map((task) => task.promise));
  });

  it("dispatches pool source work in source queue order", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 2,
      sourceQueuesPaused: true,
    });
    const order: string[] = [];

    const first = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "First source",
      priority: "background",
      source: { id: "first", name: "First" },
      run: async (context) => {
        order.push(`first:${context.executor}:start`);
      },
    });
    const second = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Second source",
      priority: "user",
      source: { id: "second", name: "Second" },
      run: async (context) => {
        order.push(`second:${context.executor}:start`);
      },
    });
    const third = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Third source",
      priority: "normal",
      source: { id: "third", name: "Third" },
      run: async (context) => {
        order.push(`third:${context.executor}:start`);
      },
    });

    expect(scheduler.moveSourceQueue("third", "top")).toBe(true);
    expect(scheduler.resumeSourceQueue()).toBe(true);

    await Promise.all([first.promise, second.promise, third.promise]);

    expect(order).toEqual([
      "third:pool:0:start",
      "first:pool:1:start",
      "second:pool:0:start",
    ]);
  });

  it("runs different sources that share a base domain concurrently", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 2,
      sourceQueuesPaused: false,
    });
    const order: string[] = [];
    const finishers = new Map<string, () => void>();

    const sharedA = scheduler.enqueueSource({
      kind: "source.globalSearch",
      title: "Shared A",
      priority: "normal",
      source: { id: "shared-a", name: "Shared A" },
      run: (context) =>
        new Promise<void>((resolve) => {
          order.push(`shared-a:${context.executor}:start`);
          finishers.set("shared-a", resolve);
        }),
    });
    const sharedB = scheduler.enqueueSource({
      kind: "source.globalSearch",
      title: "Shared B",
      priority: "normal",
      source: { id: "shared-b", name: "Shared B" },
      run: (context) =>
        new Promise<void>((resolve) => {
          order.push(`shared-b:${context.executor}:start`);
          finishers.set("shared-b", resolve);
        }),
    });
    const other = scheduler.enqueueSource({
      kind: "source.globalSearch",
      title: "Other",
      priority: "normal",
      source: { id: "other", name: "Other" },
      run: (context) =>
        new Promise<void>((resolve) => {
          order.push(`other:${context.executor}:start`);
          finishers.set("other", resolve);
        }),
    });

    await settle();
    expect(order).toEqual([
      "shared-a:pool:0:start",
      "shared-b:pool:1:start",
    ]);

    finishers.get("shared-a")?.();
    await sharedA.promise;
    await settle();

    expect(order).toEqual([
      "shared-a:pool:0:start",
      "shared-b:pool:1:start",
      "other:pool:0:start",
    ]);

    finishers.get("shared-b")?.();
    finishers.get("other")?.();
    await Promise.all([sharedB.promise, other.promise]);
  });

  it("keeps a queued source on its assigned executor when queues are reordered", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 2,
      sourceQueuesPaused: true,
    });
    const order: string[] = [];
    const finishers = new Map<string, () => void>();

    const sharedFirst = scheduler.enqueueSource({
      kind: "source.globalSearch",
      title: "Shared first",
      priority: "normal",
      source: { id: "shared", name: "Shared" },
      run: (context) =>
        new Promise<void>((resolve) => {
          order.push(`shared-first:${context.executor}:start`);
          finishers.set("shared-first", resolve);
        }),
    });
    const sharedSecond = scheduler.enqueueSource({
      kind: "source.globalSearch",
      title: "Shared second",
      priority: "normal",
      source: { id: "shared", name: "Shared" },
      run: (context) =>
        new Promise<void>((resolve) => {
          order.push(`shared-second:${context.executor}:start`);
          finishers.set("shared-second", resolve);
        }),
    });
    const blocker = scheduler.enqueueSource({
      kind: "source.globalSearch",
      title: "Blocker",
      priority: "normal",
      source: { id: "blocker", name: "Blocker" },
      run: (context) =>
        new Promise<void>((resolve) => {
          order.push(`blocker:${context.executor}:start`);
          finishers.set("blocker", resolve);
        }),
    });
    const other = scheduler.enqueueSource({
      kind: "source.globalSearch",
      title: "Other",
      priority: "normal",
      source: { id: "other", name: "Other" },
      run: (context) =>
        new Promise<void>((resolve) => {
          order.push(`other:${context.executor}:start`);
          finishers.set("other", resolve);
        }),
    });

    expect(scheduler.resumeSourceQueue()).toBe(true);
    await settle();

    expect(order).toEqual([
      "shared-first:pool:0:start",
      "blocker:pool:1:start",
    ]);

    expect(scheduler.moveSourceQueue("other", "top")).toBe(true);
    finishers.get("shared-first")?.();
    await sharedFirst.promise;
    await settle();

    expect(order).toEqual([
      "shared-first:pool:0:start",
      "blocker:pool:1:start",
      "shared-second:pool:0:start",
    ]);

    finishers.get("shared-second")?.();
    await sharedSecond.promise;
    await settle();

    expect(order).toEqual([
      "shared-first:pool:0:start",
      "blocker:pool:1:start",
      "shared-second:pool:0:start",
      "other:pool:0:start",
    ]);

    finishers.get("other")?.();
    finishers.get("blocker")?.();
    await Promise.all([blocker.promise, other.promise]);
  });

  it("keeps one active task per source even when later work has higher priority", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 2,
      sourceQueuesPaused: false,
    });
    const order: string[] = [];
    let finishActive!: () => void;

    const active = scheduler.enqueueSource({
      kind: "source.globalSearch",
      title: "Active search",
      priority: "normal",
      source: { id: "p", name: "Plugin" },
      run: () =>
        new Promise<void>((resolve) => {
          order.push("active:start");
          finishActive = resolve;
        }),
    });

    await settle();

    const user = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "User download",
      priority: "user",
      source: { id: "p", name: "Plugin" },
      run: async () => {
        order.push("user:start");
      },
    });

    await settle();
    expect(order).toEqual(["active:start"]);

    finishActive();
    await Promise.all([active.promise, user.promise]);

    expect(order).toEqual(["active:start", "user:start"]);
  });

  it("moves queued source work inside its source queue", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: true,
    });
    const order: string[] = [];
    const source = { id: "p", name: "Plugin" };

    const first = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "First",
      priority: "background",
      source,
      run: async () => {
        order.push("first:start");
      },
    });
    const second = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Second",
      priority: "background",
      source,
      run: async () => {
        order.push("second:start");
      },
    });

    await settle();
    expect(
      scheduler.getSnapshot().records.find((task) => task.id === first.id)
        ?.queueIndex,
    ).toBe(0);
    expect(
      scheduler.getSnapshot().records.find((task) => task.id === second.id)
        ?.queueIndex,
    ).toBe(1);

    expect(scheduler.moveQueuedTask(second.id, "up")).toBe(true);
    expect(
      scheduler.getSnapshot().records.find((task) => task.id === second.id)
        ?.queueIndex,
    ).toBe(0);

    expect(scheduler.resumeSourceQueue()).toBe(true);
    await Promise.all([first.promise, second.promise]);

    expect(order).toEqual(["second:start", "first:start"]);
  });

  it("moves queued source work for the same novel as one block", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: true,
    });
    const order: string[] = [];
    const source = { id: "p", name: "Plugin" };

    const firstNovelFirst = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Novel A 1",
      priority: "background",
      source,
      subject: { novelId: 1, novelName: "Novel A" },
      run: async () => {
        order.push("a1:start");
      },
    });
    const secondNovel = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Novel B",
      priority: "background",
      source,
      subject: { novelId: 2, novelName: "Novel B" },
      run: async () => {
        order.push("b:start");
      },
    });
    const firstNovelSecond = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Novel A 2",
      priority: "background",
      source,
      subject: { novelId: 1, novelName: "Novel A" },
      run: async () => {
        order.push("a2:start");
      },
    });
    const firstNovelKey = taskWorkQueueKey({ novelId: 1, novelName: "Novel A" });

    expect(firstNovelKey).not.toBeNull();
    expect(
      scheduler.moveSourceWorkQueue(source.id, firstNovelKey!, "bottom"),
    ).toBe(true);

    const snapshot = scheduler.getSnapshot();
    expect(
      snapshot.records
        .filter((task) => task.status === "queued")
        .sort((left, right) => (left.queueIndex ?? 0) - (right.queueIndex ?? 0))
        .map((task) => task.id),
    ).toEqual([secondNovel.id, firstNovelFirst.id, firstNovelSecond.id]);

    expect(scheduler.resumeSourceQueue()).toBe(true);
    await Promise.all([
      firstNovelFirst.promise,
      secondNovel.promise,
      firstNovelSecond.promise,
    ]);

    expect(order).toEqual(["b:start", "a1:start", "a2:start"]);
  });

  it("cancels queued and running source work for the same novel", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const order: string[] = [];
    const source = { id: "p", name: "Plugin" };
    let finishRunning!: () => void;

    const running = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Novel A running",
      priority: "background",
      source,
      subject: { novelId: 1, novelName: "Novel A" },
      run: () =>
        new Promise<void>((resolve) => {
          order.push("a1:start");
          finishRunning = resolve;
        }),
    });

    await settle();

    const queuedSameNovel = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Novel A queued",
      priority: "background",
      source,
      subject: { novelId: 1, novelName: "Novel A" },
      run: async () => {
        order.push("a2:start");
      },
    });
    const queuedOtherNovel = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Novel B",
      priority: "background",
      source,
      subject: { novelId: 2, novelName: "Novel B" },
      run: async () => {
        order.push("b:start");
      },
    });
    const firstNovelKey = taskWorkQueueKey({ novelId: 1, novelName: "Novel A" });
    let snapshots = 0;
    scheduler.subscribe(() => {
      snapshots += 1;
    });

    expect(firstNovelKey).not.toBeNull();
    expect(
      scheduler.cancelActiveTasks({
        sourceId: source.id,
        workKey: firstNovelKey!,
      }),
    ).toBe(2);
    expect(snapshots).toBe(1);
    await expect(running.promise).rejects.toThrow("Task was cancelled.");
    await expect(queuedSameNovel.promise).rejects.toThrow(
      "Task was cancelled.",
    );

    finishRunning();
    await queuedOtherNovel.promise;

    expect(order).toEqual(["a1:start", "b:start"]);
  });

  it("does not cancel queued or running tasks that opt out", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const source = { id: "p", name: "Plugin" };
    let finishRunning!: () => void;

    const running = scheduler.enqueueSource({
      kind: "source.mergeNovel",
      title: "Running merge",
      priority: "interactive",
      source,
      canCancel: false,
      run: () =>
        new Promise<void>((resolve) => {
          finishRunning = resolve;
        }),
    });

    await settle();

    const queued = scheduler.enqueueSource({
      kind: "source.mergeNovel",
      title: "Queued merge",
      priority: "interactive",
      source,
      canCancel: false,
      run: async () => undefined,
    });

    expect(scheduler.getTask(running.id)).toMatchObject({
      status: "running",
      canCancel: false,
    });
    expect(scheduler.getTask(queued.id)).toMatchObject({
      status: "queued",
      canCancel: false,
    });
    expect(scheduler.cancel(running.id)).toBe(false);
    expect(scheduler.cancel(queued.id)).toBe(false);
    expect(scheduler.cancelActiveTasks({ sourceId: source.id })).toBe(0);

    finishRunning();
    await Promise.all([running.promise, queued.promise]);
  });

  it("discards queued source tasks with a single snapshot publish", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: true,
    });
    const source = { id: "p", name: "Plugin" };
    const tasks = [1, 2, 3].map((index) =>
      scheduler.enqueueSource({
        kind: "chapter.download",
        title: `Queued ${index}`,
        priority: "background",
        source,
        run: async () => undefined,
      }),
    );
    let snapshots = 0;
    scheduler.subscribe(() => {
      snapshots += 1;
    });

    expect(
      scheduler.cancelActiveTasks({
        discardQueued: true,
        sourceId: source.id,
      }),
    ).toBe(3);
    expect(snapshots).toBe(1);
    expect(scheduler.getSnapshot().queued).toBe(0);
    expect(scheduler.getSnapshot().cancelled).toBe(0);
    expect(scheduler.getSnapshot().total).toBe(0);
    await Promise.all(
      tasks.map((task) =>
        expect(task.promise).rejects.toThrow("Task was cancelled."),
      ),
    );

    const followUp = scheduler.enqueueMain({
      kind: "repository.refreshIndex",
      title: "Follow-up",
      run: async () => undefined,
    });
    await followUp.promise;

    expect(
      scheduler
        .getSnapshot()
        .records.some((task) => task.title.startsWith("Queued ")),
    ).toBe(false);
  });

  it("keeps pool downloads running while interactive browsing uses the immediate executor", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const order: string[] = [];
    let downloadRunCount = 0;
    let finishDownload!: () => void;

    const download = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Background download",
      priority: "background",
      source: { id: "p", name: "Plugin" },
      run: (context) =>
        new Promise<void>((resolve) => {
          downloadRunCount += 1;
          const runNumber = downloadRunCount;
          order.push(`download:${runNumber}:${context.executor}:start`);
          const cleanup = () => {
            context.signal.removeEventListener("abort", handleAbort);
          };
          const handleAbort = () => {
            order.push(`download:${runNumber}:paused`);
            cleanup();
            resolve();
          };
          context.signal.addEventListener("abort", handleAbort, { once: true });
          finishDownload = () => {
            cleanup();
            resolve();
          };
        }),
    });

    await settle();

    const browse = scheduler.enqueueSource({
      kind: "source.listPopular",
      title: "Open source",
      priority: "interactive",
      source: { id: "p", name: "Plugin" },
      run: async (context) => {
        order.push(`browse:${context.executor}:start`);
      },
    });

    await browse.promise;
    await settle();
    expect(order).toEqual([
      "download:1:pool:0:start",
      "browse:immediate:start",
    ]);
    expect(downloadRunCount).toBe(1);

    finishDownload();
    await download.promise;
  });

  it("opens a same-source interactive chapter without yielding the batch download", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const order: string[] = [];
    const backgroundContexts: TaskRunContext[] = [];
    let finishBackground!: () => void;

    const background = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Batch chapter",
      priority: "background",
      source: { id: "p", name: "Plugin" },
      run: (context) =>
        new Promise<void>((resolve) => {
          backgroundContexts.push(context);
          order.push(`background:${context.executor}:start`);
          finishBackground = resolve;
        }),
    });

    await settle();

    const interactive = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Opened chapter",
      priority: "interactive",
      source: { id: "p", name: "Plugin" },
      run: async (context) => {
        order.push(`interactive:${context.executor}:start`);
      },
    });

    await interactive.promise;

    expect(order).toEqual([
      "background:pool:0:start",
      "interactive:immediate:start",
    ]);
    expect(backgroundContexts[0]?.shouldYield?.()).toBe(false);
    expect(scheduler.getTask(background.id)?.status).toBe("running");

    finishBackground();
    await background.promise;
  });

  it("uses a pool executor for same-source browsing while a foreground download continues", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const order: string[] = [];
    let downloadPaused = false;
    let finishDownload!: () => void;

    const download = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Foreground download",
      priority: "background",
      source: { id: "p", name: "Plugin" },
      requiresForegroundExecutor: true,
      run: (context) =>
        new Promise<void>((resolve) => {
          order.push(`download:${context.executor}:start`);
          const cleanup = () => {
            context.signal.removeEventListener("abort", handleAbort);
          };
          const handleAbort = () => {
            downloadPaused = true;
            cleanup();
            resolve();
          };
          context.signal.addEventListener("abort", handleAbort, { once: true });
          finishDownload = () => {
            cleanup();
            resolve();
          };
        }),
    });

    await settle();

    const browse = scheduler.enqueueSource({
      kind: "source.listPopular",
      title: "Open source",
      priority: "interactive",
      source: { id: "p", name: "Plugin" },
      run: async (context) => {
        order.push(`browse:${context.executor}:start`);
      },
    });

    await browse.promise;
    expect(order).toEqual([
      "download:immediate:start",
      "browse:pool:0:start",
    ]);
    expect(downloadPaused).toBe(false);

    finishDownload();
    await download.promise;
  });

  it("runs queued pool UI work after the current background resource yields", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const order: string[] = [];
    let downloadRunCount = 0;
    let finishDownload!: () => void;
    let firstDownloadContext: TaskRunContext | null = null;

    const download = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Background download",
      priority: "background",
      source: { id: "p", name: "Plugin" },
      run: async (context) => {
        downloadRunCount += 1;
        const runNumber = downloadRunCount;
        if (runNumber === 1) firstDownloadContext = context;
        order.push(`download:${runNumber}:${context.executor}:start`);
        await new Promise<void>((resolve) => {
          finishDownload = resolve;
        });
        if (context.shouldYield?.()) {
          order.push(`download:${runNumber}:yielded`);
          throw new DOMException("Task was paused.", "AbortError");
        }
      },
    });

    await settle();

    const search = scheduler.enqueueSource({
      kind: "source.globalSearch",
      title: "Search source",
      priority: "user",
      source: { id: "p", name: "Plugin" },
      run: async (context) => {
        order.push(`search:${context.executor}:start`);
      },
    });

    await settle();

    expect(order).toEqual(["download:1:pool:0:start"]);
    const observedFirstDownloadContext = firstDownloadContext as
      | TaskRunContext
      | null;
    expect(observedFirstDownloadContext?.signal.aborted).toBe(false);
    expect(observedFirstDownloadContext?.shouldYield?.()).toBe(true);

    finishDownload();
    await search.promise;
    await settle();

    expect(order).toEqual([
      "download:1:pool:0:start",
      "download:1:yielded",
      "search:pool:0:start",
      "download:2:pool:0:start",
    ]);

    finishDownload();
    await download.promise;
  });

  it("runs open novel imports on the immediate source executor", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const observations: string[] = [];

    const task = scheduler.enqueueSource({
      kind: "source.openNovel",
      title: "Open novel",
      priority: "interactive",
      source: { id: "p", name: "Plugin" },
      run: async (context) => {
        observations.push(
          `${context.executor}:${activeScraperExecutor("p")}`,
        );
      },
    });

    await task.promise;

    expect(scheduler.getTask(task.id)?.lane).toBe("source");
    expect(observations).toEqual(["immediate:immediate"]);
  });

  it.each(["source.previewNovel", "source.mergeNovel"] as const)(
    "runs %s on the immediate source executor",
    async (kind) => {
      const scheduler = new TaskScheduler({
        sourceForegroundConcurrency: 1,
        sourceQueuesPaused: false,
      });
      const observations: string[] = [];

      const task = scheduler.enqueueSource({
        kind,
        title: "Novel merge interaction",
        priority: "interactive",
        source: { id: "p", name: "Plugin" },
        run: async (context) => {
          observations.push(String(context.executor));
        },
      });

      await task.promise;

      expect(observations).toEqual(["immediate"]);
    },
  );

  it("reserves the immediate executor for open site work without blocking the pool", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const order: string[] = [];
    let closeBrowser!: () => void;
    let finishPool!: () => void;

    const pool = scheduler.enqueueSource({
      kind: "source.globalSearch",
      title: "Pool work",
      priority: "normal",
      source: { id: "a", name: "Source A" },
      run: (context) =>
        new Promise<void>((resolve) => {
          order.push(`pool:${context.executor}:start`);
          finishPool = resolve;
        }),
    });

    await settle();

    const browser = scheduler.enqueueSource({
      kind: "source.openSite",
      title: "Open site",
      priority: "interactive",
      exclusive: true,
      source: { id: "browser", name: "Browser" },
      run: (context) =>
        new Promise<void>((resolve) => {
          order.push(`browser:${context.executor}:start`);
          closeBrowser = resolve;
        }),
    });

    await settle();
    expect(order).toEqual(["pool:pool:0:start", "browser:immediate:start"]);

    closeBrowser();
    finishPool();
    await Promise.all([browser.promise, pool.promise]);
  });

  it("lets same-source pool work start while open site remains running", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const source = { id: "naverwebtoon", name: "Naver Webtoon" };
    const order: string[] = [];
    let closeBrowser!: () => void;
    let finishDownload!: () => void;

    const browser = scheduler.enqueueSource({
      kind: "source.openSite",
      title: "Open source",
      priority: "interactive",
      exclusive: true,
      source,
      run: (context) =>
        new Promise<void>((resolve) => {
          order.push(`open:${context.executor}:start`);
          closeBrowser = resolve;
        }),
    });

    await settle();
    expect(order).toEqual(["open:immediate:start"]);

    const download = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Download chapter",
      priority: "user",
      source,
      run: (context) =>
        new Promise<void>((resolve) => {
          order.push(`download:${context.executor}:start`);
          finishDownload = resolve;
        }),
    });

    await settle();
    expect(order).toEqual([
      "open:immediate:start",
      "download:pool:0:start",
    ]);
    expect(scheduler.getTask(browser.id)?.status).toBe("running");
    expect(scheduler.getTask(download.id)?.status).toBe("running");

    finishDownload();
    closeBrowser();
    await Promise.all([browser.promise, download.promise]);
  });

  it("runs foreground-required downloads on the immediate executor after the site browser closes", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const source = { id: "newtoki-novel", name: "Newtoki Novel" };
    const order: string[] = [];
    let closeBrowser!: () => void;

    const browser = scheduler.enqueueSource({
      kind: "source.openSite",
      title: "Open source",
      priority: "interactive",
      exclusive: true,
      source,
      run: (context) =>
        new Promise<void>((resolve) => {
          order.push(`open:${context.executor}:start`);
          closeBrowser = resolve;
        }),
    });

    await settle();
    expect(order).toEqual(["open:immediate:start"]);

    const download = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Download chapter",
      priority: "user",
      source,
      requiresForegroundExecutor: true,
      run: async (context) => {
        order.push(`download:${context.executor}:start`);
      },
    });

    await settle();
    expect(order).toEqual(["open:immediate:start"]);
    expect(scheduler.getTask(download.id)?.status).toBe("queued");

    closeBrowser();
    await Promise.all([browser.promise, download.promise]);

    expect(order).toEqual([
      "open:immediate:start",
      "download:immediate:start",
    ]);
  });

  it("lets open site work run while source queues are paused", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: true });
    const order: string[] = [];

    const search = scheduler.enqueueSource({
      kind: "source.search",
      title: "Paused search",
      priority: "interactive",
      source: { id: "p", name: "Plugin" },
      run: async () => {
        order.push("search:start");
      },
    });
    const browser = scheduler.enqueueSource({
      kind: "source.openSite",
      title: "Open site",
      priority: "interactive",
      exclusive: true,
      source: { id: "p", name: "Plugin" },
      run: async (context) => {
        order.push(`browser:${context.executor}:start`);
      },
    });

    await browser.promise;
    await settle();

    expect(order).toEqual(["browser:immediate:start"]);
    expect(scheduler.getTask(search.id)?.status).toBe("queued");
  });

  it("pauses running source work and requeues it", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const startedSignals: AbortSignal[] = [];
    let runCount = 0;

    const download = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Download",
      priority: "background",
      source: { id: "p", name: "Plugin" },
      run: (context) => {
        runCount += 1;
        startedSignals.push(context.signal);
        if (runCount > 1) return Promise.resolve();

        return new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () =>
              reject(new DOMException("Task was cancelled.", "AbortError")),
            { once: true },
          );
        });
      },
    });
    let settled = false;
    void download.promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await settle();
    expect(scheduler.getTask(download.id)?.status).toBe("running");

    expect(scheduler.pauseSourceQueue()).toBe(true);
    await settle();

    expect(startedSignals[0]?.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(scheduler.getTask(download.id)?.status).toBe("queued");

    expect(scheduler.resumeSourceQueue()).toBe(true);
    await download.promise;

    expect(runCount).toBe(2);
    expect(scheduler.getTask(download.id)?.status).toBe("succeeded");
  });

  it("blocks and requeues every running task in the challenged access scope", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 3,
      sourceQueuesPaused: false,
    });
    const challengedScope = "site:source.test";
    let sameScopeAborted = false;
    let finishOtherScope!: () => void;
    let challengedSettled = false;
    let siblingSettled = false;

    const challenged = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Challenged download",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: challengedScope,
      run: async () => {
        throw new SourceAccessRequiredError("Complete the CAPTCHA.", {
          kind: "captcha",
          url: "https://source.test/chapter/1",
        });
      },
    });
    const sibling = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Sibling download",
      priority: "background",
      source: { id: "source-b", name: "Source B" },
      sourceAccessScopeKey: challengedScope,
      run: (context) =>
        new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => {
              sameScopeAborted = true;
              reject(new DOMException("Task was paused.", "AbortError"));
            },
            { once: true },
          );
        }),
    });
    const other = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Other download",
      priority: "background",
      source: { id: "source-c", name: "Source C" },
      sourceAccessScopeKey: "site:other.test",
      run: () =>
        new Promise<void>((resolve) => {
          finishOtherScope = resolve;
        }),
    });
    void challenged.promise.then(
      () => {
        challengedSettled = true;
      },
      () => {
        challengedSettled = true;
      },
    );
    void sibling.promise.then(
      () => {
        siblingSettled = true;
      },
      () => {
        siblingSettled = true;
      },
    );

    await settle();
    await scheduler.waitForSourceTaskSettlement(sibling.id);
    await settle();

    expect(sameScopeAborted).toBe(true);
    expect(challengedSettled).toBe(false);
    expect(siblingSettled).toBe(false);
    expect(scheduler.getTask(challenged.id)?.status).toBe("queued");
    expect(scheduler.getTask(sibling.id)?.status).toBe("queued");
    expect(scheduler.getTask(other.id)?.status).toBe("running");
    expect(scheduler.getSnapshot().pausedSourceIds).toEqual([]);
    expect(scheduler.getSnapshot().sourceAccessBlocks).toMatchObject([
      {
        challenge: {
          kind: "captcha",
          url: "https://source.test/chapter/1",
        },
        revision: 1,
        scopeKey: challengedScope,
        sourceIds: ["source-a", "source-b"],
        verificationRequested: false,
      },
    ]);

    finishOtherScope();
    await other.promise;
    scheduler.cancel(challenged.id);
    scheduler.cancel(sibling.id);
    await Promise.allSettled([challenged.promise, sibling.promise]);
  });

  it("increments the block revision when the challenge payload changes", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 2,
      sourceQueuesPaused: false,
    });
    const scopeKey = "site:source.test";
    let rejectFirst!: (error: unknown) => void;
    let rejectSecond!: (error: unknown) => void;

    const first = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "First challenged download",
      priority: "normal",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: scopeKey,
      run: () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    });
    const second = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Second challenged download",
      priority: "normal",
      source: { id: "source-b", name: "Source B" },
      sourceAccessScopeKey: scopeKey,
      run: () =>
        new Promise<void>((_resolve, reject) => {
          rejectSecond = reject;
        }),
    });

    await settle();
    rejectFirst(
      new SourceAccessRequiredError("Complete the CAPTCHA.", {
        kind: "captcha",
        url: "https://source.test/chapter/1",
      }),
    );
    await settle();
    expect(scheduler.getSnapshot().sourceAccessBlocks[0]).toMatchObject({
      challenge: { kind: "captcha", url: "https://source.test/chapter/1" },
      revision: 1,
    });

    rejectSecond(
      new SourceAccessRequiredError("Complete the Cloudflare check.", {
        kind: "cloudflare",
        url: "https://source.test/chapter/2",
      }),
    );
    await settle();
    expect(scheduler.getSnapshot().sourceAccessBlocks[0]).toMatchObject({
      challenge: {
        kind: "cloudflare",
        url: "https://source.test/chapter/2",
      },
      originTaskId: second.id,
      revision: 2,
    });

    scheduler.cancel(first.id);
    scheduler.cancel(second.id);
    await Promise.allSettled([first.promise, second.promise]);
  });

  it("aborts and requeues non-cancellable work when source access is blocked", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 2,
      sourceQueuesPaused: false,
    });
    const scopeKey = "site:source.test";
    let mergeAborted = false;
    let mergeRunCount = 0;
    let rejectFirstMerge!: (error: unknown) => void;

    const merge = scheduler.enqueueSource({
      kind: "source.mergeNovel",
      title: "Merge novel",
      priority: "interactive",
      source: { id: "source-b", name: "Source B" },
      sourceAccessScopeKey: scopeKey,
      canCancel: false,
      run: (context) => {
        mergeRunCount += 1;
        if (mergeRunCount > 1) return Promise.resolve();
        return new Promise<void>((_resolve, reject) => {
          rejectFirstMerge = reject;
          context.signal.addEventListener(
            "abort",
            () => {
              mergeAborted = true;
              reject(new DOMException("Task was paused.", "AbortError"));
            },
            { once: true },
          );
        });
      },
    });
    await settle();

    let challengeRunCount = 0;
    const challenged = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Challenged download",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: scopeKey,
      run: async (context) => {
        challengeRunCount += 1;
        if (challengeRunCount === 1) {
          throw new SourceAccessRequiredError("Complete the challenge.", {
            kind: "cloudflare",
            url: "https://source.test/chapter/1",
          });
        }
        expect(context.confirmSourceAccess?.()).toBe(true);
      },
    });

    await settle();
    if (mergeAborted) {
      await scheduler.waitForSourceTaskSettlement(merge.id);
      await settle();
    }
    const mergeStatusAfterBlock = scheduler.getTask(merge.id)?.status;
    if (!mergeAborted) {
      rejectFirstMerge(new DOMException("Test cleanup.", "AbortError"));
      await Promise.allSettled([merge.promise]);
    } else {
      expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(true);
      await Promise.all([challenged.promise, merge.promise]);
    }
    if (scheduler.getTask(challenged.id)?.status !== "succeeded") {
      scheduler.cancel(challenged.id);
      await Promise.allSettled([challenged.promise]);
    }

    expect(mergeAborted).toBe(true);
    expect(mergeStatusAfterBlock).toBe("queued");
    expect(mergeRunCount).toBe(2);
  });

  it("settles non-cancellable work that completes after a source access abort", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 2,
      sourceQueuesPaused: false,
    });
    const scopeKey = "site:source.test";
    let finishMerge!: () => void;
    let mergeAborted = false;
    let mergeRunCount = 0;

    const merge = scheduler.enqueueSource({
      kind: "source.mergeNovel",
      title: "Atomic merge",
      priority: "interactive",
      source: { id: "source-b", name: "Source B" },
      sourceAccessScopeKey: scopeKey,
      canCancel: false,
      run: (context) => {
        mergeRunCount += 1;
        context.signal.addEventListener(
          "abort",
          () => {
            mergeAborted = true;
          },
          { once: true },
        );
        return new Promise<void>((resolve) => {
          finishMerge = resolve;
        });
      },
    });
    await settle();

    const challenged = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Challenged download",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: scopeKey,
      run: async () => {
        throw new SourceAccessRequiredError("Complete the challenge.", {
          kind: "captcha",
          url: "https://source.test/chapter/1",
        });
      },
    });

    await settle();
    finishMerge();
    await merge.promise;

    expect(mergeAborted).toBe(true);
    expect(mergeRunCount).toBe(1);
    expect(scheduler.getTask(merge.id)?.status).toBe("succeeded");

    scheduler.cancel(challenged.id);
    await Promise.allSettled([challenged.promise]);
  });

  it("blocks dynamically scoped tasks that belong to the challenged source", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 2,
      sourceQueuesPaused: false,
    });
    let siblingRan = false;
    let queuedRan = false;

    const challenged = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Unscoped challenged download",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      run: async (context) => {
        expect(
          context.setSourceAccessUrl?.("https://source.test/chapter/1"),
        ).toBe(true);
        throw new SourceAccessRequiredError("Complete the CAPTCHA.", {
          kind: "captcha",
          url: "https://source.test/chapter/1",
        });
      },
    });
    const sibling = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Unscoped sibling download",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      run: async () => {
        siblingRan = true;
      },
    });
    const queued = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Unscoped queued download",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      run: async () => {
        queuedRan = true;
      },
    });

    await settle();

    expect(siblingRan).toBe(false);
    expect(queuedRan).toBe(false);
    expect(scheduler.getTask(challenged.id)?.status).toBe("queued");
    expect(scheduler.getTask(sibling.id)?.status).toBe("queued");
    expect(scheduler.getTask(queued.id)?.status).toBe("queued");
    expect(scheduler.getSnapshot().sourceAccessBlocks).toMatchObject([
      {
        scopeKey: "site:source.test",
        sourceIds: ["source-a"],
      },
    ]);

    scheduler.cancel(challenged.id);
    scheduler.cancel(sibling.id);
    scheduler.cancel(queued.id);
    await Promise.allSettled([
      challenged.promise,
      sibling.promise,
      queued.promise,
    ]);
  });

  it("rejects an unscoped source challenge instead of trusting its URL", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const task = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Unscoped challenge",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      run: async () => {
        throw new SourceAccessRequiredError("Untrusted challenge URL.", {
          kind: "captcha",
          url: "https://attacker.test/chapter/1",
        });
      },
    });
    void task.promise.catch(() => undefined);

    await settle();
    const status = scheduler.getTask(task.id)?.status;
    const blocks = scheduler.getSnapshot().sourceAccessBlocks;
    scheduler.cancel(task.id);
    await Promise.allSettled([task.promise]);

    expect(status).toBe("failed");
    expect(blocks).toEqual([]);
  });

  it("normalizes a transport manual-action challenge before blocking", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const scopeKey = "site:source.test";
    let settled = false;
    const task = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Transport challenge",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: scopeKey,
      run: async () => {
        throw Object.assign(new Error("Complete the Cloudflare check."), {
          challenge: {
            kind: "cloudflare",
            url: "https://source.test/chapter/1",
          },
          code: "manual-action-required",
        });
      },
    });
    void task.promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await settle();

    expect(settled).toBe(false);
    expect(scheduler.getTask(task.id)?.status).toBe("queued");
    expect(scheduler.getSnapshot().sourceAccessBlocks).toMatchObject([
      {
        challenge: { kind: "cloudflare" },
        scopeKey,
      },
    ]);

    scheduler.cancel(task.id);
    await Promise.allSettled([task.promise]);
  });

  it("fails a challenge whose hostname does not match the task scope", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const task = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Mismatched challenge",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: "site:source.test",
      run: async () => {
        throw new SourceAccessRequiredError("Untrusted challenge URL.", {
          kind: "captcha",
          url: "https://attacker.test/chapter/1",
        });
      },
    });

    await expect(task.promise).rejects.toThrow("Untrusted challenge URL.");

    expect(scheduler.getTask(task.id)?.status).toBe("failed");
    expect(scheduler.getSnapshot().sourceAccessBlocks).toEqual([]);
  });

  it("runs one verification canary without clearing the user pause", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const scopeKey = "site:source.test";
    const observations: string[] = [];
    let runCount = 0;

    const challenged = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Challenged download",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: scopeKey,
      run: async (context) => {
        runCount += 1;
        expect(context.sourceAccessVerification).toBe(runCount === 2);
        observations.push(`challenged:${context.executor}:${runCount}`);
        if (runCount === 1) {
          throw new SourceAccessRequiredError("Complete the challenge.", {
            kind: "cloudflare",
            url: "https://source.test/chapter/1",
          });
        }
        expect(context.confirmSourceAccess?.()).toBe(true);
      },
    });
    const sibling = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Sibling download",
      priority: "background",
      source: { id: "source-b", name: "Source B" },
      sourceAccessScopeKey: scopeKey,
      run: async (context) => {
        observations.push(`sibling:${context.executor}`);
      },
    });

    await settle();
    expect(scheduler.pauseSourceQueue()).toBe(true);
    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(true);
    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(false);

    await challenged.promise;
    await settle();

    expect(observations).toEqual([
      "challenged:pool:0:1",
      "challenged:immediate:2",
    ]);
    expect(scheduler.getSnapshot().sourceAccessBlocks).toEqual([]);
    expect(scheduler.getSnapshot().sourceQueuesPaused).toBe(true);
    expect(scheduler.getTask(sibling.id)?.status).toBe("queued");

    expect(scheduler.resumeSourceQueue()).toBe(true);
    await sibling.promise;
  });

  it("keeps the scope blocked when a canary does not confirm source access", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const scopeKey = "site:source.test";
    let runCount = 0;
    let settled = false;

    const challenged = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Unconfirmed canary",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: scopeKey,
      run: async () => {
        runCount += 1;
        if (runCount === 1) {
          throw new SourceAccessRequiredError("Complete the challenge.", {
            kind: "cloudflare",
            url: "https://source.test/chapter/1",
          });
        }
      },
    });
    void challenged.promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await settle();
    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(true);
    await settle();

    expect(runCount).toBe(2);
    expect(settled).toBe(false);
    expect(scheduler.getTask(challenged.id)?.status).toBe("queued");
    expect(scheduler.getSnapshot().sourceAccessBlocks).toMatchObject([
      {
        scopeKey,
        verificationRequested: false,
      },
    ]);

    scheduler.cancel(challenged.id);
    await Promise.allSettled([challenged.promise]);
  });

  it("does not let a canary rebind an existing block to another hostname", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const scopeKey = "site:source.test";
    const rebindResults: Array<boolean | undefined> = [];
    let runCount = 0;

    const challenged = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Changed host canary",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: scopeKey,
      run: async (context) => {
        runCount += 1;
        if (runCount === 1) {
          throw new SourceAccessRequiredError("Complete the challenge.", {
            kind: "cloudflare",
            url: "https://source.test/chapter/1",
          });
        }
        expect(context.confirmSourceAccess?.()).toBe(true);
        const rebound = context.setSourceAccessUrl?.("https://attacker.test/");
        rebindResults.push(rebound);
        if (!rebound) throw new Error("Source access hostname changed.");
      },
    });

    await settle();
    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(true);
    await settle();

    expect(rebindResults).toEqual([false]);
    expect(scheduler.getTask(challenged.id)?.status).toBe("queued");
    expect(scheduler.getSnapshot().sourceAccessBlocks).toMatchObject([
      { scopeKey, verificationRequested: false },
    ]);

    scheduler.cancel(challenged.id);
    await Promise.allSettled([challenged.promise]);
  });

  it("keeps the scope blocked when a canary reports an untrusted challenge", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const scopeKey = "site:source.test";
    let runCount = 0;
    let settled = false;

    const challenged = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Untrusted challenge canary",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: scopeKey,
      run: async () => {
        runCount += 1;
        throw new SourceAccessRequiredError(
          runCount === 1
            ? "Complete the challenge."
            : "Untrusted challenge URL.",
          {
            kind: "cloudflare",
            url:
              runCount === 1
                ? "https://source.test/chapter/1"
                : "https://attacker.test/chapter/1",
          },
        );
      },
    });
    void challenged.promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await settle();
    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(true);
    await settle();

    const block = scheduler.getSnapshot().sourceAccessBlocks[0];
    expect(runCount).toBe(2);
    expect(settled).toBe(false);
    expect(scheduler.getTask(challenged.id)?.status).toBe("queued");
    expect(block).toMatchObject({
      scopeKey,
      verificationError: "Untrusted challenge URL.",
      verificationRequested: false,
    });
    expect(block?.verificationTaskId).toBeUndefined();

    scheduler.cancel(challenged.id);
    await Promise.allSettled([challenged.promise]);
  });

  it("keeps the scope blocked when a verification canary sees another challenge", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const scopeKey = "site:source.test";
    let currentConfirm!: () => boolean;
    let finishCurrentVerification!: () => void;
    let staleConfirm!: () => boolean;
    let runCount = 0;
    let settled = false;

    const challenged = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Challenged download",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: scopeKey,
      run: (context) => {
        runCount += 1;
        if (runCount === 3) {
          if (!context.confirmSourceAccess) {
            throw new Error("Expected a source access confirmation callback.");
          }
          currentConfirm = context.confirmSourceAccess;
          return new Promise<void>((resolve) => {
            finishCurrentVerification = resolve;
          });
        }
        if (runCount === 2) {
          if (!context.confirmSourceAccess) {
            throw new Error("Expected a source access confirmation callback.");
          }
          staleConfirm = context.confirmSourceAccess;
        }
        return Promise.reject(
          new SourceAccessRequiredError("Challenge is still active.", {
            kind: "cloudflare",
            url: "https://source.test/chapter/1",
          }),
        );
      },
    });
    void challenged.promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await settle();
    const firstRevision = scheduler.getSnapshot().sourceAccessBlocks[0]?.revision;
    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(true);
    await settle();

    const block = scheduler.getSnapshot().sourceAccessBlocks[0];
    expect(runCount).toBe(2);
    expect(settled).toBe(false);
    expect(scheduler.getTask(challenged.id)?.status).toBe("queued");
    expect(block?.revision).toBeGreaterThan(firstRevision ?? 0);
    expect(block?.verificationTaskId).toBeUndefined();
    expect(staleConfirm()).toBe(false);

    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(true);
    await settle();

    expect(runCount).toBe(3);
    expect(staleConfirm()).toBe(false);
    expect(currentConfirm()).toBe(true);
    finishCurrentVerification();
    await challenged.promise;
  });

  it("hydrates source access blocks before dispatching queued work", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const scopeKey = "site:source.test";
    const observations: string[] = [];

    scheduler.hydrateSourceAccessBlocks([
      {
        challenge: {
          kind: "captcha",
          url: "https://source.test/chapter/1",
        },
        detectedAt: 10,
        revision: 7,
        scopeKey,
        sourceIds: ["source-a"],
        verificationRequested: true,
        verificationTaskId: "stale-task",
      },
    ]);
    const task = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Restored download",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: scopeKey,
      run: async (context) => {
        observations.push(String(context.executor));
        context.confirmSourceAccess?.();
      },
    });

    await settle();
    expect(observations).toEqual([]);
    expect(scheduler.getTask(task.id)?.status).toBe("queued");
    expect(scheduler.getSnapshot().sourceAccessBlocks[0]).toMatchObject({
      revision: 7,
      verificationRequested: false,
    });
    expect(
      scheduler.getSnapshot().sourceAccessBlocks[0]?.verificationTaskId,
    ).toBeUndefined();

    expect(scheduler.canBeginSourceAccessVerification(scopeKey)).toBe(true);
    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(true);
    await task.promise;

    expect(observations).toEqual(["immediate"]);
    expect(scheduler.getSnapshot().sourceAccessBlocks).toEqual([]);
  });

  it("does not request source access verification without a queued canary", () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const scopeKey = "site:source.test";

    scheduler.hydrateSourceAccessBlocks([
      {
        challenge: {
          kind: "captcha",
          url: "https://source.test/chapter/1",
        },
        detectedAt: 10,
        revision: 7,
        scopeKey,
        sourceIds: ["source-a"],
        verificationRequested: false,
      },
    ]);

    expect(scheduler.canBeginSourceAccessVerification(scopeKey)).toBe(false);
    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(false);
    expect(scheduler.getSnapshot().sourceAccessBlocks[0]).toMatchObject({
      scopeKey,
      verificationRequested: false,
    });
  });

  it("rebuilds a redacted challenge URL from its queued canary", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const scopeKey = "site:source.test";
    const freshUrl =
      "https://source.test/chapter/1?signed=fresh-proof#challenge";

    scheduler.hydrateSourceAccessBlocks([
      {
        challenge: {
          kind: "captcha",
          url: "https://source.test/chapter/1",
        },
        challengeUrlRedacted: true,
        detectedAt: 10,
        revision: 7,
        scopeKey,
        sourceIds: ["source-a"],
        verificationRequested: false,
      },
    ]);
    const canary = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Restored download",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      resolveSourceAccessUrl: () => freshUrl,
      run: async () => undefined,
    });

    await expect(
      scheduler.resolveSourceAccessVerificationUrl(scopeKey, 7),
    ).resolves.toEqual({ revision: 7, scopeKey, url: freshUrl });
    expect(scheduler.getSnapshot().sourceAccessBlocks[0]).toMatchObject({
      challenge: { url: freshUrl },
      originTaskId: canary.id,
      scopeKey,
    });
    expect(
      scheduler.getSnapshot().sourceAccessBlocks[0],
    ).not.toHaveProperty("challengeUrlRedacted");

    scheduler.cancel(canary.id);
    await Promise.allSettled([canary.promise]);
  });

  it("keeps a restored block when a configured task uses another host", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const oldScopeKey = "site:old-source.test";
    const newScopeKey = "site:new-source.test";

    scheduler.hydrateSourceAccessBlocks([
      {
        challenge: {
          kind: "cloudflare",
          url: "https://old-source.test/chapter/1",
        },
        detectedAt: 10,
        originTaskKey: "source-a:search",
        revision: 7,
        scopeKey: oldScopeKey,
        sourceIds: ["source-a"],
        verificationRequested: false,
      },
    ]);
    const canary = scheduler.enqueueSource({
      kind: "source.search",
      title: "Search replacement host",
      priority: "interactive",
      source: { id: "source-a", name: "Source A" },
      resolveSourceAccessUrl: () => "https://new-source.test/",
      sourceAccessScopeKey: newScopeKey,
      sourceAccessVerificationKey: "source-a:search",
      run: async () => undefined,
    });

    expect(scheduler.canBeginSourceAccessVerification(oldScopeKey)).toBe(false);
    await expect(
      scheduler.resolveSourceAccessVerificationUrl(oldScopeKey, 7),
    ).resolves.toBeNull();
    expect(scheduler.getSnapshot().sourceAccessBlocks).toMatchObject([
      {
        challenge: { url: "https://old-source.test/chapter/1" },
        revision: 7,
        scopeKey: oldScopeKey,
        sourceIds: ["source-a"],
      },
    ]);

    scheduler.cancel(canary.id);
    await Promise.allSettled([canary.promise]);
  });

  it("keeps a restored chapter block when its exact URL changes host", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const oldScopeKey = "site:old-source.test";
    const freshUrl =
      "https://new-source.test/chapter/1?signed=fresh-proof#challenge";

    scheduler.hydrateSourceAccessBlocks([
      {
        challenge: {
          kind: "cloudflare",
          url: "https://old-source.test/chapter/1",
        },
        challengeUrlRedacted: true,
        detectedAt: 10,
        originTaskKey: "chapter.download:source-a:chapter-1",
        revision: 7,
        scopeKey: oldScopeKey,
        sourceIds: ["source-a"],
        verificationRequested: false,
      },
    ]);
    const canary = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Restored chapter download",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      resolveSourceAccessUrl: () => freshUrl,
      sourceAccessVerificationKey: "chapter.download:source-a:chapter-1",
      run: async (context) => {
        expect(context.setSourceAccessUrl?.(freshUrl)).toBe(true);
        expect(context.confirmSourceAccess?.()).toBe(true);
      },
    });

    await expect(
      scheduler.resolveSourceAccessVerificationUrl(oldScopeKey, 7),
    ).resolves.toBeNull();
    expect(scheduler.canBeginSourceAccessVerification(oldScopeKey)).toBe(false);
    expect(scheduler.getSnapshot().sourceAccessBlocks).toMatchObject([
      {
        challenge: { url: "https://old-source.test/chapter/1" },
        originTaskKey: "chapter.download:source-a:chapter-1",
        revision: 7,
        scopeKey: oldScopeKey,
        sourceIds: ["source-a"],
      },
    ]);

    scheduler.cancel(canary.id);
    await Promise.allSettled([canary.promise]);
  });

  it("tries another queued canary after the persisted origin changes host", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const oldScopeKey = "site:old-source.test";
    const sameHostUrl =
      "https://old-source.test/chapter/2?signed=fresh-proof#challenge";

    scheduler.hydrateSourceAccessBlocks([
      {
        challenge: {
          kind: "cloudflare",
          url: "https://old-source.test/chapter/1",
        },
        challengeUrlRedacted: true,
        detectedAt: 10,
        originTaskKey: "chapter.download:source-a:chapter-1",
        revision: 7,
        scopeKey: oldScopeKey,
        sourceIds: ["source-a"],
        verificationRequested: false,
      },
    ]);
    const movedOrigin = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Moved original chapter",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      resolveSourceAccessUrl: () => "https://new-source.test/chapter/1",
      sourceAccessVerificationKey: "chapter.download:source-a:chapter-1",
      run: async () => undefined,
    });
    const sameHost = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Same-host chapter",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      resolveSourceAccessUrl: () => sameHostUrl,
      sourceAccessVerificationKey: "chapter.download:source-a:chapter-2",
      run: async () => undefined,
    });

    await expect(
      scheduler.resolveSourceAccessVerificationUrl(oldScopeKey, 7),
    ).resolves.toBeNull();
    expect(scheduler.canBeginSourceAccessVerification(oldScopeKey)).toBe(true);
    await expect(
      scheduler.resolveSourceAccessVerificationUrl(oldScopeKey, 7),
    ).resolves.toEqual({
      revision: 7,
      scopeKey: oldScopeKey,
      url: sameHostUrl,
    });
    expect(scheduler.getSnapshot().sourceAccessBlocks[0]).toMatchObject({
      originTaskId: sameHost.id,
      originTaskKey: "chapter.download:source-a:chapter-2",
      revision: 7,
      scopeKey: oldScopeKey,
    });

    scheduler.cancel(movedOrigin.id);
    scheduler.cancel(sameHost.id);
    await Promise.allSettled([movedOrigin.promise, sameHost.promise]);
  });

  it("uses persisted origin proof among multiple acquisition hosts", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const scopeKey = "site:source-a.test";
    const freshUrl = "https://source-a.test/chapter/1?signed=fresh-proof";

    scheduler.hydrateSourceAccessBlocks([
      {
        challenge: {
          kind: "captcha",
          url: "https://source-a.test/chapter/1",
        },
        challengeUrlRedacted: true,
        detectedAt: 10,
        originTaskKey: "chapter.download:source-a:chapter-1",
        revision: 7,
        scopeKey,
        sourceIds: ["source-a"],
        verificationRequested: false,
      },
    ]);
    const otherHost = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Other-host chapter",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      resolveSourceAccessUrl: () => "https://source-b.test/chapter/2",
      sourceAccessVerificationKey: "chapter.download:source-a:chapter-2",
      run: async () => undefined,
    });
    const origin = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Original challenged chapter",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      resolveSourceAccessUrl: () => freshUrl,
      sourceAccessVerificationKey: "chapter.download:source-a:chapter-1",
      run: async () => undefined,
    });

    await expect(
      scheduler.resolveSourceAccessVerificationUrl(scopeKey, 7),
    ).resolves.toEqual({ revision: 7, scopeKey, url: freshUrl });
    expect(scheduler.getSnapshot().sourceAccessBlocks[0]).toMatchObject({
      originTaskId: origin.id,
      originTaskKey: "chapter.download:source-a:chapter-1",
      scopeKey,
    });

    scheduler.cancel(otherHost.id);
    scheduler.cancel(origin.id);
    await Promise.allSettled([otherHost.promise, origin.promise]);
  });

  it("does not migrate a restored block without matching origin proof", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const oldScopeKey = "site:source-a.test";

    scheduler.hydrateSourceAccessBlocks([
      {
        challenge: {
          kind: "captcha",
          url: "https://source-a.test/chapter/1",
        },
        challengeUrlRedacted: true,
        detectedAt: 10,
        originTaskKey: "chapter.download:source-a:chapter-1",
        revision: 7,
        scopeKey: oldScopeKey,
        sourceIds: ["source-a"],
        verificationRequested: false,
      },
    ]);
    const otherHost = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Other-host chapter",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      resolveSourceAccessUrl: () => "https://source-b.test/chapter/2",
      sourceAccessVerificationKey: "chapter.download:source-a:chapter-2",
      run: async () => undefined,
    });

    await expect(
      scheduler.resolveSourceAccessVerificationUrl(oldScopeKey, 7),
    ).resolves.toBeNull();
    expect(scheduler.getSnapshot().sourceAccessBlocks).toMatchObject([
      {
        originTaskKey: "chapter.download:source-a:chapter-1",
        revision: 7,
        scopeKey: oldScopeKey,
      },
    ]);

    scheduler.cancel(otherHost.id);
    await Promise.allSettled([otherHost.promise]);
  });

  it("keeps every source in a shared block when one task changes host", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const oldScopeKey = "site:old-source.test";
    const newScopeKey = "site:new-source.test";

    scheduler.hydrateSourceAccessBlocks([
      {
        challenge: {
          kind: "cloudflare",
          url: "https://old-source.test/chapter/1",
        },
        detectedAt: 10,
        originTaskKey: "source-a:search",
        revision: 7,
        scopeKey: oldScopeKey,
        sourceIds: ["source-a", "source-b"],
        verificationRequested: false,
      },
    ]);
    const canary = scheduler.enqueueSource({
      kind: "source.search",
      title: "Search replacement host",
      priority: "interactive",
      source: { id: "source-a", name: "Source A" },
      resolveSourceAccessUrl: () => "https://new-source.test/",
      sourceAccessScopeKey: newScopeKey,
      sourceAccessVerificationKey: "source-a:search",
      run: async () => undefined,
    });

    expect(scheduler.canBeginSourceAccessVerification(oldScopeKey)).toBe(false);
    await expect(
      scheduler.resolveSourceAccessVerificationUrl(oldScopeKey, 7),
    ).resolves.toBeNull();
    expect(scheduler.getSnapshot().sourceAccessBlocks).toMatchObject([
      {
        revision: 7,
        scopeKey: oldScopeKey,
        sourceIds: ["source-a", "source-b"],
      },
    ]);

    scheduler.cancel(canary.id);
    await Promise.allSettled([canary.promise]);
  });

  it("preserves an old-host block when the replacement host is also blocked", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const oldScopeKey = "site:old-source.test";
    const newScopeKey = "site:new-source.test";

    scheduler.hydrateSourceAccessBlocks([
      {
        challenge: {
          kind: "captcha",
          url: "https://old-source.test/chapter/1",
        },
        detectedAt: 10,
        originTaskKey: "source-a:search",
        revision: 7,
        scopeKey: oldScopeKey,
        sourceIds: ["source-a"],
        verificationRequested: false,
      },
      {
        challenge: {
          kind: "cloudflare",
          url: "https://new-source.test/chapter/2",
        },
        detectedAt: 20,
        revision: 8,
        scopeKey: newScopeKey,
        sourceIds: ["source-a"],
        verificationRequested: false,
      },
    ]);
    const canary = scheduler.enqueueSource({
      kind: "source.search",
      title: "Search replacement host",
      priority: "interactive",
      source: { id: "source-a", name: "Source A" },
      resolveSourceAccessUrl: () => "https://new-source.test/",
      sourceAccessScopeKey: newScopeKey,
      sourceAccessVerificationKey: "source-a:search",
      run: async () => undefined,
    });

    await expect(
      scheduler.resolveSourceAccessVerificationUrl(oldScopeKey, 7),
    ).resolves.toBeNull();
    expect(scheduler.getSnapshot().sourceAccessBlocks).toMatchObject([
      { revision: 7, scopeKey: oldScopeKey, sourceIds: ["source-a"] },
      { revision: 8, scopeKey: newScopeKey, sourceIds: ["source-a"] },
    ]);

    scheduler.cancel(canary.id);
    await Promise.allSettled([canary.promise]);
  });

  it("resets a verification request when its queued canary is cancelled", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const scopeKey = "site:source.test";
    let finishImmediate!: () => void;

    const immediate = scheduler.enqueueSource({
      kind: "source.openSite",
      title: "Open another source",
      priority: "interactive",
      source: { id: "source-b", name: "Source B" },
      run: () =>
        new Promise<void>((resolve) => {
          finishImmediate = resolve;
        }),
    });
    await settle();

    scheduler.hydrateSourceAccessBlocks([
      {
        challenge: {
          kind: "captcha",
          url: "https://source.test/chapter/1",
        },
        detectedAt: 10,
        revision: 7,
        scopeKey,
        sourceIds: ["source-a"],
        verificationRequested: false,
      },
    ]);
    const canary = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Queued canary",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: scopeKey,
      run: async () => undefined,
    });

    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(true);
    expect(scheduler.cancel(canary.id)).toBe(true);
    await Promise.allSettled([canary.promise]);
    expect(scheduler.getSnapshot().sourceAccessBlocks[0]).toMatchObject({
      scopeKey,
      verificationRequested: true,
    });

    finishImmediate();
    await immediate.promise;
    await settle();

    expect(scheduler.getSnapshot().sourceAccessBlocks[0]).toMatchObject({
      scopeKey,
      verificationRequested: false,
    });
  });

  it("releases a source access verification when its running canary is cancelled", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const scopeKey = "site:source.test";
    let canaryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      canaryStarted = resolve;
    });

    scheduler.hydrateSourceAccessBlocks([
      {
        challenge: {
          kind: "cloudflare",
          url: "https://source.test/chapter/1",
        },
        detectedAt: 10,
        revision: 7,
        scopeKey,
        sourceIds: ["source-a"],
        verificationRequested: false,
      },
    ]);
    const canary = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Running canary",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: scopeKey,
      run: (context) =>
        new Promise<void>((_resolve, reject) => {
          canaryStarted();
          context.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Task was cancelled.", "AbortError")),
            { once: true },
          );
        }),
    });

    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(true);
    await started;
    expect(scheduler.getSnapshot().sourceAccessBlocks[0]).toMatchObject({
      revision: 7,
      verificationTaskId: canary.id,
    });

    expect(scheduler.cancel(canary.id)).toBe(true);
    await Promise.allSettled([canary.promise]);
    await settle();

    expect(scheduler.getSnapshot().sourceAccessBlocks[0]).toMatchObject({
      scopeKey,
      verificationRequested: false,
    });
    expect(
      scheduler.getSnapshot().sourceAccessBlocks[0]?.verificationTaskId,
    ).toBeUndefined();
    expect(
      scheduler.getSnapshot().sourceAccessBlocks[0]?.revision,
    ).toBeGreaterThan(7);

    const replacement = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Replacement canary",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: scopeKey,
      run: async (context) => {
        expect(context.confirmSourceAccess?.()).toBe(true);
      },
    });

    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(true);
    await replacement.promise;
    expect(scheduler.getSnapshot().sourceAccessBlocks).toEqual([]);
  });

  it("does not use cookie clearing as a source access canary", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const scopeKey = "site:source.test";

    scheduler.hydrateSourceAccessBlocks([
      {
        challenge: {
          kind: "cloudflare",
          url: "https://source.test/chapter/1",
        },
        detectedAt: 10,
        revision: 7,
        scopeKey,
        sourceIds: ["source-a"],
        verificationRequested: false,
      },
    ]);
    const clearCookies = scheduler.enqueueSource({
      kind: "source.clearCookies",
      title: "Clear cookies",
      priority: "user",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: scopeKey,
      run: async () => undefined,
    });

    const started = scheduler.beginSourceAccessVerification(scopeKey);
    await settle();
    scheduler.cancel(clearCookies.id);
    await Promise.allSettled([clearCookies.promise]);

    expect(started).toBe(false);
    expect(scheduler.getSnapshot().sourceAccessBlocks[0]).toMatchObject({
      scopeKey,
      verificationRequested: false,
    });
  });

  it("does not use media repair as a source access canary", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const scopeKey = "site:source.test";

    scheduler.hydrateSourceAccessBlocks([
      {
        challenge: {
          kind: "cloudflare",
          url: "https://source.test/chapter/1",
        },
        detectedAt: 10,
        revision: 7,
        scopeKey,
        sourceIds: ["source-a"],
        verificationRequested: false,
      },
    ]);
    const repair = scheduler.enqueueSource({
      kind: "chapter.repairMedia",
      title: "Repair media",
      priority: "user",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: scopeKey,
      run: async () => undefined,
    });

    const started = scheduler.beginSourceAccessVerification(scopeKey);
    await settle();
    scheduler.cancel(repair.id);
    await Promise.allSettled([repair.promise]);

    expect(started).toBe(false);
    expect(scheduler.getSnapshot().sourceAccessBlocks[0]).toMatchObject({
      scopeKey,
      verificationRequested: false,
    });
  });

  it("reuses media repair only when it created the access block", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const scopeKey = "site:source.test";
    let runCount = 0;

    const repair = scheduler.enqueueSource({
      kind: "chapter.repairMedia",
      title: "Challenged repair",
      priority: "user",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: scopeKey,
      run: async (context) => {
        runCount += 1;
        if (runCount === 1) {
          throw new SourceAccessRequiredError("Complete the challenge.", {
            kind: "captcha",
            url: "https://source.test/chapter/1",
          });
        }
        expect(context.sourceAccessVerification).toBe(true);
        expect(context.confirmSourceAccess?.()).toBe(true);
      },
    });

    await settle();
    expect(scheduler.getSnapshot().sourceAccessBlocks[0]).toMatchObject({
      originTaskId: repair.id,
      scopeKey,
    });
    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(true);
    await repair.promise;

    expect(runCount).toBe(2);
    expect(scheduler.getSnapshot().sourceAccessBlocks).toEqual([]);
  });

  it("does not use non-cancellable work as a source access canary", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const scopeKey = "site:source.test";

    scheduler.hydrateSourceAccessBlocks([
      {
        challenge: {
          kind: "cloudflare",
          url: "https://source.test/chapter/1",
        },
        detectedAt: 10,
        revision: 7,
        scopeKey,
        sourceIds: ["source-a"],
        verificationRequested: false,
      },
    ]);
    const merge = scheduler.enqueueSource({
      kind: "source.mergeNovel",
      title: "Merge novel",
      priority: "interactive",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: scopeKey,
      canCancel: false,
      run: async () => undefined,
    });

    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(false);
    expect(scheduler.getTask(merge.id)).toMatchObject({
      canCancel: false,
      status: "queued",
    });
    expect(scheduler.getSnapshot().sourceAccessBlocks[0]).toMatchObject({
      scopeKey,
      verificationRequested: false,
    });
  });

  it("reuses a non-cancellable task only when it created the access block", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const scopeKey = "site:source.test";
    let runCount = 0;

    const merge = scheduler.enqueueSource({
      kind: "source.mergeNovel",
      title: "Challenged merge",
      priority: "interactive",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: scopeKey,
      canCancel: false,
      run: async (context) => {
        runCount += 1;
        if (runCount === 1) {
          throw new SourceAccessRequiredError("Complete the challenge.", {
            kind: "cloudflare",
            url: "https://source.test/novel/1",
          });
        }
        expect(context.sourceAccessVerification).toBe(true);
        expect(context.confirmSourceAccess?.()).toBe(true);
      },
    });

    await settle();
    expect(scheduler.getSnapshot().sourceAccessBlocks[0]).toMatchObject({
      originTaskId: merge.id,
      scopeKey,
      verificationRequested: false,
    });
    expect(scheduler.getTask(merge.id)).toMatchObject({
      canCancel: false,
      status: "queued",
    });

    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(true);
    await merge.promise;

    expect(runCount).toBe(2);
    expect(scheduler.getSnapshot().sourceAccessBlocks).toEqual([]);
  });

  it("requeues a running non-cancellable origin canary when verification is stopped", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const scopeKey = "site:source.test";
    let canaryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      canaryStarted = resolve;
    });
    let runCount = 0;

    const merge = scheduler.enqueueSource({
      kind: "source.mergeNovel",
      title: "Paused merge canary",
      priority: "interactive",
      source: { id: "source-a", name: "Source A" },
      sourceAccessScopeKey: scopeKey,
      canCancel: false,
      run: (context) => {
        runCount += 1;
        if (runCount === 1) {
          return Promise.reject(
            new SourceAccessRequiredError("Complete the challenge.", {
              kind: "cloudflare",
              url: "https://source.test/novel/1",
            }),
          );
        }
        if (runCount === 2) {
          return new Promise<void>((resolve) => {
            canaryStarted();
            context.signal.addEventListener(
              "abort",
              () => resolve(),
              { once: true },
            );
          });
        }
        expect(context.confirmSourceAccess?.()).toBe(true);
        return Promise.resolve();
      },
    });

    await settle();
    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(true);
    await started;

    const activeRevision =
      scheduler.getSnapshot().sourceAccessBlocks[0]?.revision ?? 0;
    expect(scheduler.keepSourceAccessBlocked(scopeKey)).toBe(true);
    await scheduler.waitForSourceTaskSettlement(merge.id);
    await settle();

    expect(scheduler.getTask(merge.id)).toMatchObject({
      canCancel: false,
      status: "queued",
    });
    expect(scheduler.getSnapshot().sourceAccessBlocks[0]).toMatchObject({
      scopeKey,
      verificationRequested: false,
    });
    expect(
      scheduler.getSnapshot().sourceAccessBlocks[0]?.verificationTaskId,
    ).toBeUndefined();
    expect(
      scheduler.getSnapshot().sourceAccessBlocks[0]?.revision,
    ).toBeGreaterThan(activeRevision);

    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(true);
    await merge.promise;
    expect(runCount).toBe(3);
  });

  it("requeues only running interruptible downloads", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 2,
      sourceQueuesPaused: false,
    });
    let downloadRunCount = 0;
    let finishDownload!: () => void;
    let finishSearch!: () => void;
    let searchAborted = false;

    const download = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Download",
      priority: "background",
      source: { id: "download-source", name: "Download Source" },
      run: (context) => {
        downloadRunCount += 1;
        if (downloadRunCount > 1) {
          return new Promise<void>((resolve) => {
            finishDownload = resolve;
          });
        }

        return new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () =>
              reject(new DOMException("Task was cancelled.", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const search = scheduler.enqueueSource({
      kind: "source.search",
      title: "Search",
      priority: "normal",
      source: { id: "search-source", name: "Search Source" },
      run: (context) =>
        new Promise<void>((resolve) => {
          finishSearch = resolve;
          context.signal.addEventListener("abort", () => {
            searchAborted = true;
          });
        }),
    });

    await settle();

    expect(scheduler.requeueRunningInterruptibleDownloads()).toBe(1);
    await settle();

    expect(downloadRunCount).toBe(2);
    expect(searchAborted).toBe(false);

    finishDownload();
    finishSearch();
    await Promise.all([download.promise, search.promise]);
  });

  it("lets current background resources finish before yielding the task", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    let finishCurrentResource!: () => void;
    let finishResumedDownload!: () => void;
    let firstContext: TaskRunContext | null = null;
    let runCount = 0;

    const download = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Background download",
      priority: "background",
      source: { id: "download-source", name: "Download Source" },
      run: async (context) => {
        runCount += 1;
        if (runCount === 1) {
          firstContext = context;
          await new Promise<void>((resolve) => {
            finishCurrentResource = resolve;
          });
          if (context.shouldYield?.()) {
            throw new DOMException("Task was paused.", "AbortError");
          }
          return;
        }
        await new Promise<void>((resolve) => {
          finishResumedDownload = resolve;
        });
      },
    });

    await settle();

    expect(scheduler.yieldRunningInterruptibleDownloads()).toBe(1);
    const observedFirstContext = firstContext as TaskRunContext | null;
    expect(observedFirstContext?.signal.aborted).toBe(false);
    expect(observedFirstContext?.shouldYield?.()).toBe(true);
    expect(scheduler.getTask(download.id)?.status).toBe("running");

    finishCurrentResource();
    await settle();

    expect(runCount).toBe(2);
    expect(scheduler.getTask(download.id)?.status).toBe("running");

    finishResumedDownload();
    await download.promise;
  });

  it("limits background work inside the shared pool", async () => {
    const scheduler = new TaskScheduler({
      sourceBackgroundConcurrency: 1,
      sourceForegroundConcurrency: 3,
      sourceQueuesPaused: false,
    });
    const order: string[] = [];
    let finishBackground!: () => void;

    const firstBackground = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Background A",
      priority: "background",
      source: { id: "a", name: "A" },
      run: () =>
        new Promise<void>((resolve) => {
          order.push("background-a:start");
          finishBackground = resolve;
        }),
    });
    const secondBackground = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Background B",
      priority: "background",
      source: { id: "b", name: "B" },
      run: async () => {
        order.push("background-b:start");
      },
    });
    const foreground = scheduler.enqueueSource({
      kind: "source.globalSearch",
      title: "Foreground C",
      priority: "normal",
      source: { id: "c", name: "C" },
      run: async () => {
        order.push("foreground-c:start");
      },
    });

    await foreground.promise;
    await settle();

    expect(order).toEqual(["background-a:start", "foreground-c:start"]);

    finishBackground();
    await Promise.all([firstBackground.promise, secondBackground.promise]);

    expect(order).toEqual([
      "background-a:start",
      "foreground-c:start",
      "background-b:start",
    ]);
  });

  it("reserves a pool executor for foreground when background follows concurrency", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: true,
    });
    const order: string[] = [];
    const finishers: Array<() => void> = [];

    const tasks = ["a", "b", "c"].map((sourceId) =>
      scheduler.enqueueSource({
        kind: "chapter.download",
        title: `Background ${sourceId}`,
        priority: "background",
        source: { id: sourceId, name: sourceId.toUpperCase() },
        run: (context) =>
          new Promise<void>((resolve) => {
            order.push(`${sourceId}:${context.executor}:start`);
            finishers.push(resolve);
          }),
      }),
    );

    scheduler.setSourceForegroundConcurrency(3);
    expect(scheduler.resumeSourceQueue()).toBe(true);
    await settle();

    // Background follows foreground (3) but reserves one executor for
    // foreground work, so only two background tasks run concurrently.
    expect(order).toEqual(["a:pool:0:start", "b:pool:1:start"]);

    finishers[0]?.();
    await tasks[0].promise;
    await settle();

    // The freed executor lets the third background task start.
    expect(order).toHaveLength(3);
    expect(order[2]).toMatch(/^c:pool:\d:start$/);

    finishers.slice(1).forEach((finish) => finish());
    await Promise.all(tasks.map((task) => task.promise));
  });

  it("delays tasks with a matching source cooldown", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new TaskScheduler({
        sourceForegroundConcurrency: 1,
        sourceQueuesPaused: false,
      });
      const order: string[] = [];
      const cooldownKey = "source:p";

      const first = scheduler.enqueueSource({
        kind: "chapter.download",
        title: "First",
        priority: "background",
        source: { id: "p", name: "Plugin" },
        sourceCooldownKey: cooldownKey,
        sourceCooldownMs: 1_000,
        run: async () => {
          order.push("first:start");
        },
      });
      await first.promise;

      const second = scheduler.enqueueSource({
        kind: "source.globalSearch",
        title: "Second",
        priority: "user",
        source: { id: "p", name: "Plugin" },
        sourceCooldownKey: cooldownKey,
        run: async () => {
          order.push("second:start");
        },
      });

      await settle();
      expect(order).toEqual(["first:start"]);

      vi.advanceTimersByTime(999);
      await settle();
      expect(order).toEqual(["first:start"]);

      vi.advanceTimersByTime(1);
      await second.promise;

      expect(order).toEqual(["first:start", "second:start"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks local-only work before an existing source cooldown", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new TaskScheduler({
        sourceForegroundConcurrency: 1,
        sourceQueuesPaused: false,
      });
      const order: string[] = [];
      const cooldownKey = "source:p";

      const first = scheduler.enqueueSource({
        kind: "chapter.download",
        title: "Online chapter",
        priority: "background",
        source: { id: "p", name: "Plugin" },
        sourceCooldownKey: cooldownKey,
        sourceCooldownMs: 1_000,
        run: async () => {
          order.push("online:start");
        },
      });
      await first.promise;
      vi.advanceTimersByTime(400);

      const local = scheduler.enqueueSource({
        kind: "chapter.download",
        title: "Stored chapter",
        priority: "background",
        source: { id: "p", name: "Plugin" },
        canCompleteWithoutSourceAccess: true,
        sourceCooldownKey: cooldownKey,
        sourceCooldownMs: 1_000,
        run: async () => {
          order.push("local:complete");
        },
      });
      await local.promise;

      const remote = scheduler.enqueueSource({
        kind: "chapter.download",
        title: "Missing chapter",
        priority: "background",
        source: { id: "p", name: "Plugin" },
        canCompleteWithoutSourceAccess: true,
        sourceCooldownKey: cooldownKey,
        sourceCooldownMs: 1_000,
        run: async (context) => {
          order.push("remote:check");
          if (!context.tryStartSourceAccess?.()) return;
          order.push("remote:start");
        },
      });

      await settle();
      expect(order).toEqual([
        "online:start",
        "local:complete",
        "remote:check",
      ]);
      expect(scheduler.getTask(remote.id)?.status).toBe("queued");

      vi.advanceTimersByTime(599);
      await settle();
      expect(order).not.toContain("remote:start");

      vi.advanceTimersByTime(1);
      await remote.promise;
      expect(order).toEqual([
        "online:start",
        "local:complete",
        "remote:check",
        "remote:check",
        "remote:start",
      ]);

      const afterRemote = scheduler.enqueueSource({
        kind: "source.globalSearch",
        title: "Later online work",
        priority: "user",
        source: { id: "p", name: "Plugin" },
        sourceCooldownKey: cooldownKey,
        run: async () => {
          order.push("later:start");
        },
      });
      await settle();
      expect(order).not.toContain("later:start");

      vi.advanceTimersByTime(999);
      await settle();
      expect(order).not.toContain("later:start");

      vi.advanceTimersByTime(1);
      await afterRemote.promise;
      expect(order.at(-1)).toBe("later:start");
    } finally {
      vi.useRealTimers();
    }
  });

  it("completes local-only work without clearing a source access block", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const scopeKey = "site:source.test";
    let localRuns = 0;

    scheduler.hydrateSourceAccessBlocks([
      {
        challenge: {
          kind: "cloudflare",
          url: "https://source.test/chapter/1",
        },
        detectedAt: 10,
        revision: 7,
        scopeKey,
        sourceIds: ["source-a"],
        verificationRequested: false,
      },
    ]);
    const local = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Stored chapter",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      canCompleteWithoutSourceAccess: true,
      sourceAccessScopeKey: scopeKey,
      run: async () => {
        localRuns += 1;
      },
    });

    await local.promise;

    expect(localRuns).toBe(1);
    expect(scheduler.getSnapshot().sourceAccessBlocks).toMatchObject([
      {
        revision: 7,
        scopeKey,
        verificationRequested: false,
      },
    ]);
  });

  it("requeues source-required work behind an access block", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const scopeKey = "site:source.test";
    let runCount = 0;

    scheduler.hydrateSourceAccessBlocks([
      {
        challenge: {
          kind: "cloudflare",
          url: "https://source.test/chapter/1",
        },
        detectedAt: 10,
        revision: 7,
        scopeKey,
        sourceIds: ["source-a"],
        verificationRequested: false,
      },
    ]);
    const remote = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Missing chapter",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      canCompleteWithoutSourceAccess: true,
      sourceAccessScopeKey: scopeKey,
      run: async (context) => {
        runCount += 1;
        if (!context.tryStartSourceAccess?.()) return;
        expect(context.sourceAccessVerification).toBe(true);
        expect(context.confirmSourceAccess?.()).toBe(true);
      },
    });

    await settle();
    expect(runCount).toBe(1);
    expect(scheduler.getTask(remote.id)?.status).toBe("queued");
    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(true);

    await remote.promise;

    expect(runCount).toBe(2);
    expect(scheduler.getSnapshot().sourceAccessBlocks).toEqual([]);
  });

  it("does not abort a local check when source access becomes blocked", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const scopeKey = "site:source.test";
    let finishLocal!: () => void;
    let localSignal: AbortSignal | undefined;

    const local = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Stored chapter",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      canCompleteWithoutSourceAccess: true,
      sourceAccessScopeKey: scopeKey,
      run: (context) =>
        new Promise<void>((resolve) => {
          localSignal = context.signal;
          finishLocal = resolve;
        }),
    });
    await settle();

    scheduler.hydrateSourceAccessBlocks([
      {
        challenge: {
          kind: "cloudflare",
          url: "https://source.test/chapter/1",
        },
        detectedAt: 10,
        revision: 7,
        scopeKey,
        sourceIds: ["source-a"],
        verificationRequested: false,
      },
    ]);

    expect(localSignal?.aborted).toBe(false);
    finishLocal();
    await local.promise;
    expect(scheduler.getSnapshot().sourceAccessBlocks).toHaveLength(1);
  });

  it("does not reuse a cancelled running executor until the work settles", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const order: string[] = [];
    let settleCancelled!: () => void;

    const cancelled = scheduler.enqueueSource({
      kind: "source.search",
      title: "Cancelled",
      priority: "normal",
      source: { id: "a", name: "A" },
      run: () =>
        new Promise<void>((resolve) => {
          order.push("cancelled:start");
          settleCancelled = resolve;
        }),
    });

    await settle();
    expect(scheduler.cancel(cancelled.id)).toBe(true);
    await expect(cancelled.promise).rejects.toThrow("Task was cancelled.");
    let executionSettled = false;
    const executionSettlement = scheduler
      .waitForSourceTaskSettlement(cancelled.id)
      .then(() => {
        executionSettled = true;
      });

    const next = scheduler.enqueueSource({
      kind: "source.search",
      title: "Next",
      priority: "normal",
      source: { id: "b", name: "B" },
      run: async () => {
        order.push("next:start");
      },
    });

    await settle();
    expect(order).toEqual(["cancelled:start"]);
    expect(executionSettled).toBe(false);

    settleCancelled();
    await executionSettlement;
    await next.promise;

    expect(executionSettled).toBe(true);
    expect(order).toEqual(["cancelled:start", "next:start"]);
  });

  it("queues a fresh deduped retry after cancelling running source work", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const order: string[] = [];
    let settleCancelled!: () => void;

    const cancelled = scheduler.enqueueSource({
      kind: "source.openNovel",
      title: "Open novel",
      priority: "interactive",
      source: { id: "p", name: "Plugin" },
      dedupeKey: "source.openNovel:p:/novel",
      run: () =>
        new Promise<void>((resolve) => {
          order.push("cancelled:start");
          settleCancelled = resolve;
        }),
    });

    await settle();
    expect(scheduler.cancel(cancelled.id)).toBe(true);
    await expect(cancelled.promise).rejects.toThrow("Task was cancelled.");

    const retry = scheduler.enqueueSource({
      kind: "source.openNovel",
      title: "Open novel retry",
      priority: "interactive",
      source: { id: "p", name: "Plugin" },
      dedupeKey: "source.openNovel:p:/novel",
      run: async () => {
        order.push("retry:start");
      },
    });

    await settle();
    expect(retry.id).not.toBe(cancelled.id);
    expect(scheduler.getTask(retry.id)?.status).toBe("queued");
    expect(order).toEqual(["cancelled:start"]);

    settleCancelled();
    await retry.promise;

    expect(order).toEqual(["cancelled:start", "retry:start"]);
  });

  it("passes the assigned scraper executor through the task context", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    let executor: TaskRunContext["executor"];

    const task = scheduler.enqueueSource({
      kind: "source.search",
      title: "Search",
      priority: "normal",
      source: { id: "p", name: "Plugin" },
      run: async (context) => {
        executor = context.executor;
      },
    });

    await task.promise;

    expect(executor).toBe("pool:0");
  });

  it("coalesces snapshot publishes during a scheduler batch", () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: true });
    let snapshots = 0;
    let events = 0;
    let snapshotBuilds = 0;
    const unsubscribeObservations = subscribePerformanceObservations(
      (observation) => {
        if (observation.name === "scheduler.snapshot") snapshotBuilds += 1;
      },
    );
    scheduler.subscribe(() => {
      snapshots += 1;
    });
    scheduler.subscribeEvents(() => {
      events += 1;
    });

    scheduler.batch(() => {
      for (let index = 0; index < 10; index += 1) {
        scheduler.enqueueSource({
          kind: "chapter.download",
          priority: "background",
          source: { id: "source-a", name: "Source A" },
          title: `Chapter ${index}`,
          run: async () => undefined,
        });
      }
      expect(snapshots).toBe(0);
      expect(events).toBe(0);
    });

    expect(snapshots).toBe(1);
    expect(events).toBe(10);
    expect(snapshotBuilds).toBe(1);
    expect(scheduler.getSnapshot().queued).toBe(10);
    unsubscribeObservations();
  });

  it("coalesces multiple non-batched publishes into a single fan-out", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: true });
    let snapshots = 0;
    scheduler.subscribe(() => {
      snapshots += 1;
    });

    for (let index = 0; index < 5; index += 1) {
      scheduler.enqueueSource({
        kind: "chapter.download",
        priority: "background",
        source: { id: "source-a", name: "Source A" },
        title: `Chapter ${index}`,
        run: async () => undefined,
      });
    }

    // Fan-out is deferred and coalesced, so no synchronous notifications fire.
    expect(snapshots).toBe(0);
    // A synchronous read still sees fresh state via rebuild-if-dirty.
    expect(scheduler.getSnapshot().queued).toBe(5);

    await settle();

    expect(snapshots).toBe(1);
  });

  it("publishes progress and detail updates as task events without rebuilding the snapshot", async () => {
    const scheduler = new TaskScheduler();
    let snapshots = 0;
    const events: Array<{ previousStatus: string | null; task: string }> = [];
    let context!: TaskRunContext;
    let finish!: () => void;

    scheduler.subscribe(() => {
      snapshots += 1;
    });
    scheduler.subscribeEvents((event) => {
      events.push({
        previousStatus: event.previousStatus,
        task: event.task.id,
      });
    });

    const task = scheduler.enqueueSource({
      kind: "chapter.download",
      priority: "background",
      source: { id: "source-a", name: "Source A" },
      title: "Chapter",
      run: (runContext) =>
        new Promise<void>((resolve) => {
          context = runContext;
          finish = resolve;
        }),
    });

    await settle();

    const snapshotsAfterStart = snapshots;
    const eventsAfterStart = events.length;
    context.setProgress({ current: 1, total: 4 });
    context.setDetail("Downloading media");

    expect(snapshots).toBe(snapshotsAfterStart);
    expect(events.slice(eventsAfterStart)).toEqual([
      { previousStatus: "running", task: task.id },
      { previousStatus: "running", task: task.id },
    ]);
    expect(
      scheduler.getSnapshot().records.find((record) => record.id === task.id),
    ).toMatchObject({
      detail: "Downloading media",
      progress: { current: 1, total: 4 },
    });

    finish();
    await task.promise;
    expect(snapshots).toBeGreaterThan(snapshotsAfterStart);
  });

  it("materializes every active snapshot record", () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: true });
    const fixtures = buildSyntheticSourceTasks(525);

    for (const fixture of fixtures) {
      scheduler.enqueueSource({
        kind: "chapter.download",
        priority: fixture.priority,
        source: fixture.source,
        title: fixture.title,
        run: async () => undefined,
      });
    }

    const snapshot = scheduler.getSnapshot();
    expect(snapshot.total).toBe(525);
    expect(snapshot.queued).toBe(525);
    expect(snapshot.records).toHaveLength(525);
    expect(snapshot.recordLimit).toBe(525);
    expect(snapshot.recordsTruncated).toBe(false);
    expect(snapshot.sourceQueueOrder).toHaveLength(525);
    expect(snapshot.sourceQueueLimit).toBe(525);
    expect(snapshot.sourceQueuesTotal).toBe(525);
    expect(snapshot.sourceQueuesTruncated).toBe(false);
  }, 15_000);
});
