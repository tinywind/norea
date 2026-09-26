import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskScheduler, type TaskSpec, type TaskRunContext } from "./scheduler";
import { TaskUserCancelledError } from "./task-errors";
import { downloadRetryDecision } from "./download-retry";
import { PluginVpnUnavailableError } from "../plugin-vpn-traffic";

let scheduler: TaskScheduler;
const networkError = () => new TypeError("Failed to fetch");
const spec = (run: TaskSpec<void>["run"], id = "a") => ({
  kind: "chapter.download" as const, title: "Retry download", source: { id, name: id },
  dedupeKey: `download:${id}`, retry: downloadRetryDecision, run,
});
const settle = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  scheduler = new TaskScheduler({ sourceForegroundConcurrency: 1, sourceQueuesPaused: false });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("automatic download retries", () => {
  it("retains the same task, pending promise and deduplication until recovery", async () => {
    const run = vi.fn().mockRejectedValueOnce(networkError()).mockResolvedValueOnce(undefined);
    const handle = scheduler.enqueueSource(spec(run));
    const completed = vi.fn();
    void handle.promise.then(completed);
    await settle();
    expect(scheduler.getTask(handle.id)).toMatchObject({ status: "queued", canCancel: true });
    expect(scheduler.getSnapshot()).toMatchObject({ queued: 1, running: 0, failed: 0 });
    const duplicate = scheduler.enqueueSource(spec(run));
    expect(duplicate.id).toBe(handle.id);
    await vi.advanceTimersByTimeAsync(4999);
    expect(run).toHaveBeenCalledTimes(1);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await handle.promise;
    expect(run).toHaveBeenCalledTimes(2);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(scheduler.getTask(handle.id)?.status).toBe("succeeded");
  });

  it("releases the physical executor during backoff so another source can finish", async () => {
    const first = scheduler.enqueueSource(spec(vi.fn().mockRejectedValueOnce(networkError()).mockResolvedValue(undefined)));
    await settle();
    const otherRun = vi.fn().mockResolvedValue(undefined);
    const other = scheduler.enqueueSource(spec(otherRun, "b"));
    await settle();
    await other.promise;
    expect(otherRun).toHaveBeenCalledTimes(1);
    expect(scheduler.getTask(first.id)?.status).toBe("queued");
    await vi.advanceTimersByTimeAsync(5000);
    await first.promise;
  });

  it("survives repeated VPN-readiness expiries beyond several minutes without final failure", async () => {
    let available = false;
    const run = vi.fn(async () => {
      if (!available) {
        await new Promise(resolve => setTimeout(resolve, 120_000));
        throw new PluginVpnUnavailableError();
      }
    });
    const handle = scheduler.enqueueSource(spec(run));
    const failures: string[] = [];
    scheduler.subscribeEvents(({ task }) => { if (task.status === "failed") failures.push(task.id); });
    await vi.advanceTimersByTimeAsync(250_000);
    expect(scheduler.getTask(handle.id)?.status).toBe("queued");
    expect(failures).toEqual([]);
    available = true;
    await vi.advanceTimersByTimeAsync(10_000);
    await handle.promise;
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("cannot bypass the retry delay by moving or waking the source queue", async () => {
    const run = vi.fn().mockRejectedValueOnce(networkError()).mockResolvedValue(undefined);
    const handle = scheduler.enqueueSource(spec(run));
    await settle();
    scheduler.pauseSourceQueue("a");
    scheduler.resumeSourceQueue("a");
    scheduler.enqueueMain({ kind: "repository.refreshIndex", title: "Other work", run: async () => undefined });
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    await handle.promise;
  });

  it("keeps a user-paused retry queued until resume even after the timer expires", async () => {
    const run = vi.fn().mockRejectedValueOnce(networkError()).mockResolvedValue(undefined);
    const handle = scheduler.enqueueSource(spec(run));
    await settle();
    scheduler.pauseSourceQueue("a");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.resumeSourceQueue("a");
    await settle();
    await handle.promise;
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("clears cancelled retry timers without resurrection (bulk: %s)", async (bulk) => {
    const run = vi.fn().mockRejectedValue(networkError());
    const handle = scheduler.enqueueSource(spec(run));
    await settle();
    const checked = expect(handle.promise).rejects.toMatchObject({ name: "AbortError", cancelledByUser: true });
    if (bulk) scheduler.cancelActiveTasks({ discardQueued: true });
    else scheduler.cancel(handle.id);
    await checked;
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.getSnapshot()).toMatchObject({ running: 0, queued: 0 });
  });

  it("tags a running user cancellation and does not retry its late network failure", async () => {
    let rejectRun!: (error: unknown) => void;
    let signal: AbortSignal | undefined;
    const run = vi.fn((context: TaskRunContext) => {
      signal = context.signal;
      return new Promise<void>((_resolve, reject) => { rejectRun = reject; });
    });
    const handle = scheduler.enqueueSource(spec(run));
    await settle();
    const checked = expect(handle.promise).rejects.toBeInstanceOf(TaskUserCancelledError);
    scheduler.cancel(handle.id);
    expect(signal?.reason).toBeInstanceOf(TaskUserCancelledError);
    rejectRun(networkError());
    await checked;
    await vi.advanceTimersByTimeAsync(100_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([new Error("HTTP 404 Not Found"), new Error("disk full"), new PluginVpnUnavailableError(false)])(
    "finishes terminal failures instead of retrying forever", async error => {
      const run = vi.fn().mockRejectedValue(error);
      const handle = scheduler.enqueueSource(spec(run));
      const checked = expect(handle.promise).rejects.toBe(error);
      await settle();
      await checked;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(scheduler.getTask(handle.id)?.status).toBe("failed");
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves a running task across platform suspension and resumes only after foreground", async () => {
    const run = vi.fn().mockImplementationOnce(({ signal }: TaskRunContext) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })).mockResolvedValue(undefined);
    const handle = scheduler.enqueueSource(spec(run));
    const completed = vi.fn();
    void handle.promise.then(completed);
    await settle();
    scheduler.setBackgroundExecutionSuspended(true, "Platform paused");
    await settle();
    expect(scheduler.getTask(handle.id)).toMatchObject({ status: "queued", detail: "Platform paused" });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(completed).not.toHaveBeenCalled();
    scheduler.setBackgroundExecutionSuspended(false);
    await settle();
    await handle.promise;
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not clear a user pause when platform suspension ends", async () => {
    scheduler.pauseSourceQueue("a");
    scheduler.setBackgroundExecutionSuspended(true, "Platform paused");
    const run = vi.fn().mockResolvedValue(undefined);
    const handle = scheduler.enqueueSource(spec(run));
    scheduler.setBackgroundExecutionSuspended(false);
    await settle();
    expect(run).not.toHaveBeenCalled();
    scheduler.resumeSourceQueue("a");
    await settle();
    await handle.promise;
  });

  it("lets explicit cancellation remove work while platform execution is suspended", async () => {
    scheduler.setBackgroundExecutionSuspended(true, "Platform paused");
    const run = vi.fn().mockResolvedValue(undefined);
    const handle = scheduler.enqueueSource(spec(run));
    const checked = expect(handle.promise).rejects.toMatchObject({ cancelledByUser: true });
    scheduler.cancel(handle.id);
    await checked;
    scheduler.setBackgroundExecutionSuspended(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not automatically retry a task without an explicit retry policy", async () => {
    const run = vi.fn().mockRejectedValue(networkError());
    const handle = scheduler.enqueueSource({ kind: "source.search", title: "Search", source: { id: "a", name: "a" }, run });
    const checked = expect(handle.promise).rejects.toThrow("Failed to fetch");
    await settle();
    await checked;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
