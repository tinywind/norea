import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskScheduler, type TaskHandle } from "./scheduler";

afterEach(() => vi.useRealTimers());

describe("download work queue order", () => {
  it.each(["top", "bottom"] as const)(
    "preserves a work moved to the %s while a local check returns to the queue",
    async (target) => {
      vi.useFakeTimers();
      const scheduler = new TaskScheduler({ sourceForegroundConcurrency: 1 });
      const source = { id: "source", name: "Source" };
      const order: string[] = [];
      await scheduler.enqueueSource({
        kind: "chapter.download", title: "Warmup", source,
        sourceCooldownKey: source.id, sourceCooldownMs: 1_000,
        run: async () => undefined,
      }).promise;
      scheduler.pauseSourceQueue();

      let finishLocalCheck!: () => void;
      const localCheck = new Promise<void>((resolve) => { finishLocalCheck = resolve; });
      const handles: TaskHandle<void>[] = [];
      scheduler.batch(() => {
        for (const [novelId, title] of [[1, "A1"], [1, "A2"], [2, "B1"], [2, "B2"]] as const) {
          vi.setSystemTime(Date.now() + 1);
          handles.push(scheduler.enqueueSource({
            kind: "chapter.download", title, source, priority: "background",
            subject: { novelId, novelName: `Novel ${novelId}` },
            canCompleteWithoutSourceAccess: true,
            sourceCooldownKey: source.id,
            run: async (context) => {
              if (title === "A1") await localCheck;
              if (!context.tryStartSourceAccess?.()) return;
              order.push(title);
            },
          }));
        }
      });
      scheduler.resumeSourceQueue();
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.getTask(handles[0]!.id)?.status).toBe("running");
      expect(scheduler.moveSourceWorkQueue(
        source.id, target === "top" ? "novel:2" : "novel:1", target,
      )).toBe(true);
      finishLocalCheck();
      await vi.advanceTimersByTimeAsync(0);
      const queued = scheduler.getSnapshot().records
        .filter((task) => task.status === "queued")
        .sort((left, right) => left.queueIndex! - right.queueIndex!);
      expect(queued.map((task) => task.title)).toEqual(["B1", "B2", "A1", "A2"]);
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.all(handles.map((handle) => handle.promise));
      expect(order).toEqual(["B1", "B2", "A1", "A2"]);
    },
  );

  it("moves a running work below 10,000 pending downloads without interrupting its transfer", async () => {
    vi.useFakeTimers();
    const scheduler = new TaskScheduler({ sourceForegroundConcurrency: 1 });
    const source = { id: "source", name: "Source" };
    let finishTransfer!: () => void;
    let transferSignal!: AbortSignal;
    const active = scheduler.enqueueSource({
      kind: "chapter.download", title: "Active chapter", source,
      subject: { novelId: 1 },
      run: ({ signal }) => {
        transferSignal = signal;
        return new Promise<void>((resolve) => { finishTransfer = resolve; });
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const started: number[] = [];
    scheduler.batch(() => {
      for (let index = 0; index < 10_000; index += 1) {
        const novelId = index < 5_000 ? 1 : 2;
        void scheduler.enqueueSource({
          kind: "chapter.download", title: `Chapter ${index}`, source,
          subject: { novelId },
          run: async () => { started.push(novelId); },
        }).promise.catch(() => undefined);
      }
    });
    expect(scheduler.moveSourceWorkQueue(source.id, "novel:1", "bottom")).toBe(true);
    const reordered = scheduler.getSnapshot().records
      .filter((task) => task.status === "queued" || task.status === "running")
      .sort((left, right) => left.queueIndex! - right.queueIndex!);
    expect(reordered[0]?.subject?.novelId).toBe(2);
    expect(reordered[5_000]?.id).toBe(active.id);
    expect(transferSignal.aborted).toBe(false);
    const unsubscribe = scheduler.subscribeEvents(({ task }) => {
      if (task.status === "succeeded" && task.id !== active.id) scheduler.pauseSourceQueue();
    });
    finishTransfer();
    await active.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([2]);
    unsubscribe();
    scheduler.cancelActiveTasks({ discardQueued: true });
    await vi.advanceTimersByTimeAsync(0);
  });
});
