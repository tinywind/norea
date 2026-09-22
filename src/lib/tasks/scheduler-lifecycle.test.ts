import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskScheduler } from "./scheduler";

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("scheduler lifecycle boundaries", () => {
  it("preserves the latest deduped task when an older retained task expires", async () => {
    vi.useFakeTimers();
    const scheduler = new TaskScheduler({ terminalTaskRetentionMs: 100 });
    const first = scheduler.enqueueSource({
      kind: "source.search",
      source: { id: "source-a", name: "Source A" },
      title: "First search",
      dedupeKey: "search",
      run: async () => undefined,
    });
    await first.promise;
    await vi.advanceTimersByTimeAsync(50);
    let finish!: () => void;
    const latest = scheduler.enqueueSource({
      kind: "source.search",
      source: { id: "source-a", name: "Source A" },
      title: "Latest search",
      dedupeKey: "search",
      run: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    await settle();
    await vi.advanceTimersByTimeAsync(51);
    expect(scheduler.getTask(first.id)).toBeUndefined();
    expect(scheduler.getTaskByDedupeKey("search")?.id).toBe(latest.id);
    expect(scheduler.getTask(latest.id)?.status).toBe("running");

    finish();
    await latest.promise;
    await vi.advanceTimersByTimeAsync(100);
    expect(scheduler.getTaskByDedupeKey("search")).toBeUndefined();
    expect(scheduler.getSnapshot().total).toBe(0);
  });

  it("retains failed tasks and keeps cancelled source leases until settlement", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const scheduler = new TaskScheduler({ terminalTaskRetentionMs: 100 });
    const failed = scheduler.enqueueSource({
      kind: "source.search",
      source: { id: "source-a", name: "Source A" },
      title: "Failed search",
      run: async () => {
        throw new Error("Search failed.");
      },
    });
    await expect(failed.promise).rejects.toThrow("Search failed.");
    let finish!: () => void;
    const cancelled = scheduler.enqueueSource({
      kind: "source.search",
      source: { id: "source-a", name: "Source A" },
      title: "Cancelled search",
      run: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    await settle();
    scheduler.cancel(cancelled.id);
    await expect(cancelled.promise).rejects.toMatchObject({
      name: "AbortError",
    });
    const settled = vi.fn();
    void scheduler.waitForSourceTaskSettlement(cancelled.id).then(settled);
    await vi.advanceTimersByTimeAsync(500);
    expect(scheduler.getTask(failed.id)?.status).toBe("failed");
    expect(scheduler.getTask(cancelled.id)?.status).toBe("cancelled");
    expect(settled).not.toHaveBeenCalled();

    finish();
    await settle();
    expect(settled).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(scheduler.getTask(cancelled.id)).toBeUndefined();
    expect(scheduler.getTask(failed.id)?.status).toBe("failed");
    expect(scheduler.clearFailedTasks()).toBe(1);
    expect(scheduler.getSnapshot().total).toBe(0);
  });

  it("retires disabled executor affinity without releasing unsettled source work", async () => {
    const scheduler = new TaskScheduler({
      sourceForegroundConcurrency: 2,
      sourceBackgroundConcurrency: 2,
    });
    const executors: Record<string, string | undefined> = {};
    const finish: Record<string, () => void> = {};
    const enqueue = (id: string, sourceId: string) =>
      scheduler.enqueueSource({
        kind: "chapter.download",
        source: { id: sourceId, name: sourceId },
        title: id,
        priority: "background",
        run: ({ executor }) =>
          new Promise<void>((resolve) => {
            executors[id] = executor;
            finish[id] = resolve;
          }),
      });
    const first = enqueue("first", "source-a");
    const cancelled = enqueue("cancelled", "source-b");
    await settle();
    expect(executors).toEqual({ first: "pool:0", cancelled: "pool:1" });
    scheduler.setSourceForegroundConcurrency(1);
    const sameSource = enqueue("same-source", "source-b");
    const otherSource = enqueue("other-source", "source-c");
    scheduler.cancel(cancelled.id);
    await expect(cancelled.promise).rejects.toMatchObject({
      name: "AbortError",
    });
    finish.first!();
    await first.promise;
    await settle();
    expect(executors["other-source"]).toBe("pool:0");
    expect(executors["same-source"]).toBeUndefined();

    finish.cancelled!();
    await scheduler.waitForSourceTaskSettlement(cancelled.id);
    finish["other-source"]!();
    await otherSource.promise;
    await settle();
    expect(executors["same-source"]).toBe("pool:0");
    finish["same-source"]!();
    await sameSource.promise;
    expect(scheduler.getSnapshot().running).toBe(0);
  });
});
