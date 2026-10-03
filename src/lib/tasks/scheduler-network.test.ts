import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskScheduler, type TaskRunContext, type SourceTaskSpec } from "./scheduler";

let scheduler: TaskScheduler;
const spec = (run: SourceTaskSpec<void>["run"]): SourceTaskSpec<void> => ({
  kind: "chapter.download", title: "Download", source: { id: "source", name: "Source" },
  dedupeKey: "download", run,
});
const settle = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
  vi.useFakeTimers();
  scheduler = new TaskScheduler({ sourceForegroundConcurrency: 1 });
});
afterEach(() => vi.useRealTimers());

describe("source work during network loss", () => {
  it("preserves queued work without admitting any source requests", async () => {
    scheduler.setNetworkAvailable(false, "Waiting for internet");
    const run = vi.fn().mockResolvedValue(undefined);
    const handle = scheduler.enqueueSource(spec(run));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run).not.toHaveBeenCalled();
    expect(scheduler.getTask(handle.id)).toMatchObject({
      status: "queued", waitingForNetwork: true, detail: "Waiting for internet",
    });
    expect(scheduler.enqueueSource(spec(run)).id).toBe(handle.id);
    scheduler.setNetworkAvailable(true);
    await settle();
    await handle.promise;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cancels an active transport and resumes the same task without consuming retries", async () => {
    const retry = vi.fn();
    const run = vi.fn().mockImplementationOnce(({ signal }: TaskRunContext) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })).mockResolvedValue(undefined);
    const handle = scheduler.enqueueSource({ ...spec(run), retry });
    await settle();
    scheduler.setNetworkAvailable(false, "Waiting for internet");
    await settle();
    expect(retry).not.toHaveBeenCalled();
    expect(scheduler.getTask(handle.id)?.status).toBe("queued");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.setNetworkAvailable(true);
    await settle();
    await handle.promise;
    expect(run).toHaveBeenCalledTimes(2);
    expect(scheduler.getTask(handle.id)?.waitingForNetwork).toBeUndefined();
  });

  it("freezes backoff during an outage and retains the retry count", async () => {
    const error = new TypeError("Failed to fetch");
    const run = vi.fn().mockRejectedValueOnce(error).mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const retry = vi.fn(() => ({ delayMs: 5_000 }));
    const handle = scheduler.enqueueSource({ ...spec(run), retry });
    await settle();
    scheduler.setNetworkAvailable(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(retry).toHaveBeenCalledTimes(1);
    scheduler.setNetworkAvailable(true);
    await settle();
    expect(retry).toHaveBeenLastCalledWith(error, 2);
    await vi.advanceTimersByTimeAsync(5_000);
    await handle.promise;
  });

  it("does not clear user pause or revive a cancelled task on restoration", async () => {
    scheduler.pauseSourceQueue("source");
    scheduler.setNetworkAvailable(false);
    const run = vi.fn().mockResolvedValue(undefined);
    const handle = scheduler.enqueueSource(spec(run));
    scheduler.setNetworkAvailable(true);
    await settle();
    expect(run).not.toHaveBeenCalled();
    const checked = expect(handle.promise).rejects.toMatchObject({ name: "AbortError", cancelledByUser: true });
    scheduler.cancel(handle.id);
    await checked;
    scheduler.resumeSourceQueue("source");
    await settle();
    expect(run).not.toHaveBeenCalled();
  });

  it("lets local cleanup run while network work is waiting", async () => {
    scheduler.setNetworkAvailable(false);
    const run = vi.fn().mockResolvedValue(undefined);
    const handle = scheduler.enqueueSource({ ...spec(run), kind: "chapter.deleteDownload" });
    await settle();
    await handle.promise;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not abort a local finalization that has not requested source access", async () => {
    let finish!: () => void;
    let signal!: AbortSignal;
    const handle = scheduler.enqueueSource({
      ...spec(context => {
        signal = context.signal;
        return new Promise<void>(resolve => { finish = resolve; });
      }), canCompleteWithoutSourceAccess: true,
    });
    await settle();
    scheduler.setNetworkAvailable(false);
    expect(signal.aborted).toBe(false);
    finish();
    await settle();
    await handle.promise;
    expect(scheduler.getTask(handle.id)?.status).toBe("succeeded");
  });
});
