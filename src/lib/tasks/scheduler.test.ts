import { describe, expect, it, vi } from "vitest";
import { MAX_SCHEDULER_MATERIALIZED_TASKS } from "../performance-budgets";
import { buildSyntheticSourceTasks } from "../../test/fixtures/performance";
import { TaskScheduler, type TaskRunContext } from "./scheduler";
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

  it("lets interactive source browsing use the immediate executor during background downloads", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 1,
      sourceQueuesPaused: false,
    });
    const order: string[] = [];
    let finishDownload!: () => void;

    const download = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Background download",
      priority: "background",
      source: { id: "p", name: "Plugin" },
      run: (context) =>
        new Promise<void>((resolve) => {
          order.push(`download:${context.executor}:start`);
          finishDownload = resolve;
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
      "download:pool:0:start",
      "browse:immediate:start",
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

  it("lets background work follow the source work concurrency setting", async () => {
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

    expect(order).toEqual([
      "a:pool:0:start",
      "b:pool:1:start",
      "c:pool:2:start",
    ]);

    finishers.forEach((finish) => finish());
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

    settleCancelled();
    await next.promise;

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

  it("caps materialized snapshot records at the scheduler budget", () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: true });
    const fixtures = buildSyntheticSourceTasks(
      MAX_SCHEDULER_MATERIALIZED_TASKS + 25,
    );

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
    expect(snapshot.total).toBe(MAX_SCHEDULER_MATERIALIZED_TASKS + 25);
    expect(snapshot.queued).toBe(MAX_SCHEDULER_MATERIALIZED_TASKS + 25);
    expect(snapshot.records).toHaveLength(MAX_SCHEDULER_MATERIALIZED_TASKS);
    expect(snapshot.recordLimit).toBe(MAX_SCHEDULER_MATERIALIZED_TASKS);
    expect(snapshot.recordsTruncated).toBe(true);
    expect(snapshot.sourceQueueOrder).toHaveLength(
      MAX_SCHEDULER_MATERIALIZED_TASKS,
    );
    expect(snapshot.sourceQueueLimit).toBe(MAX_SCHEDULER_MATERIALIZED_TASKS);
    expect(snapshot.sourceQueuesTotal).toBe(
      MAX_SCHEDULER_MATERIALIZED_TASKS + 25,
    );
    expect(snapshot.sourceQueuesTruncated).toBe(true);
  });
});
