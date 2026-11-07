import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { normalizeDownloadRecoveryPolicy } from "../../store/download-recovery";
import { ChapterStorageError } from "../chapter-storage-error";
import { HttpStatusError } from "../http/status-error";
import { SourceAccessRequiredError } from "../plugins/source-access";
import { DownloadRecoveryController, downloadRecovery } from "./download-recovery";
import { TaskScheduler, type TaskRunContext } from "./scheduler";

vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});

let scheduler: TaskScheduler;
let recovery: DownloadRecoveryController;
const url = "https://example.test/chapter";
const settle = () => vi.advanceTimersByTimeAsync(0);
const policy = (value: Record<string, unknown> = {}) => normalizeDownloadRecoveryPolicy({ retryDelaySeconds: 5, ...value });

function queue(id: number, operation: (context: TaskRunContext) => Promise<void>, options: {
  sourceId?: string; settings?: Record<string, unknown>;
} = {}) {
  const sourceId = options.sourceId ?? "source";
  const job = { id, pluginId: sourceId, title: `Chapter ${id}` };
  const handle = scheduler.enqueueSource({
    kind: "chapter.download", title: job.title, source: { id: sourceId, name: sourceId },
    priority: "background", subject: { chapterId: id }, resolveSourceAccessUrl: () => url,
    run: context => recovery.run({ job, url, policy: policy(options.settings) }, context, async current => {
      current.setSourceAccessUrl?.(url);
      await operation(current);
    }),
  });
  void handle.promise.catch(() => undefined);
  return handle;
}

beforeEach(() => {
  vi.useFakeTimers();
  scheduler = new TaskScheduler({ sourceForegroundConcurrency: 2 });
  const values = new Map<string, string>();
  recovery = new DownloadRecoveryController({
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  });
});

afterEach(async () => {
  scheduler.cancelActiveTasks({ discardQueued: true });
  await settle();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("retains the same task and queued followers during a bounded retry", async () => {
  const operation = vi.fn().mockRejectedValueOnce(new HttpStatusError(503, "Unavailable")).mockResolvedValue(undefined);
  const first = queue(1, operation, { settings: { transientAction: "retry" } });
  const follower = vi.fn(async () => undefined);
  const second = queue(2, follower);
  await settle();
  expect(operation).toHaveBeenCalledOnce();
  expect(follower).not.toHaveBeenCalled();
  expect(scheduler.getTask(first.id)?.status).toBe("running");
  expect(scheduler.getDownloadFailureStops()).toEqual({ sourceErrors: {} });
  await vi.advanceTimersByTimeAsync(5000);
  await first.promise;
  await second.promise;
  expect(operation).toHaveBeenCalledTimes(2);
  expect(follower).toHaveBeenCalledOnce();
  expect(recovery.getSnapshot()).toEqual([]);
});

it("keeps a user-paused queue paused when the automatic deadline passes", async () => {
  const operation = vi.fn().mockRejectedValueOnce(new HttpStatusError(503, "Unavailable")).mockResolvedValue(undefined);
  const first = queue(1, operation, { settings: { transientAction: "retry" } });
  const follower = vi.fn(async () => undefined);
  queue(2, follower);
  await settle();
  scheduler.pauseSourceQueue("source");
  await settle();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(operation).toHaveBeenCalledOnce();
  expect(follower).not.toHaveBeenCalled();
  expect(scheduler.getTask(first.id)?.status).toBe("queued");
  expect(scheduler.getSnapshot().pausedSourceIds).toContain("source");
});

it("aborts a pending recovery when another download reports a storage failure", async () => {
  const operation = vi.fn(async () => { throw new HttpStatusError(503, "Unavailable"); });
  const first = queue(1, operation, { settings: { transientAction: "retry" } });
  await settle();
  const storage = new ChapterStorageError("Write content", new Error("Disk full"));
  const second = queue(2, async () => { throw storage; }, { sourceId: "other" });
  await settle();
  await expect(second.promise).rejects.toBe(storage);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(operation).toHaveBeenCalledOnce();
  expect(scheduler.getTask(first.id)?.status).toBe("queued");
  expect(scheduler.getDownloadFailureStops().globalError).toContain("Disk full");
});

it("does not clear a previously recorded source hold to satisfy an automatic policy", async () => {
  scheduler.reportDownloadFailure(new Error("Previous manual hold"), "source");
  const operation = vi.fn(async () => undefined);
  queue(1, operation, { settings: { forbiddenAction: "resetSite", transientAction: "retry" } });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(operation).not.toHaveBeenCalled();
  expect(scheduler.getDownloadFailureStops().sourceErrors.source).toBe("Previous manual hold");
});

it.each(["skip", "pause"] as const)("honors the 404 %s policy without publishing a failed chapter as complete", async action => {
  const first = queue(1, async () => { throw new HttpStatusError(404, "Missing media"); }, { settings: { notFoundAction: action } });
  const follower = vi.fn(async () => undefined);
  queue(2, follower);
  await settle();
  await expect(first.promise).rejects.toThrow("404");
  expect(scheduler.getTask(first.id)?.status).toBe("failed");
  if (action === "pause") {
    expect(follower).not.toHaveBeenCalled();
    expect(scheduler.getDownloadFailureStops().sourceErrors.source).toContain("404");
  } else {
    expect(follower).toHaveBeenCalledOnce();
    expect(scheduler.getDownloadFailureStops().sourceErrors).toEqual({});
  }
});

it("records the source-access hold only after the selected 403 retry budget is exhausted", async () => {
  const operation = vi.fn(async () => {
    throw new SourceAccessRequiredError("HTTP 403", { kind: "forbidden", url });
  });
  const first = queue(1, operation, { settings: { forbiddenAction: "retry", maxRetries: 1 } });
  const follower = vi.fn(async () => undefined);
  queue(2, follower);
  await settle();
  expect(scheduler.getSnapshot().sourceAccessBlocks).toEqual([]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(operation).toHaveBeenCalledTimes(2);
  expect(follower).not.toHaveBeenCalled();
  expect(scheduler.getTask(first.id)?.status).toBe("queued");
  expect(scheduler.getSnapshot().sourceAccessBlocks).toMatchObject([{ sourceId: "source", challenge: { kind: "forbidden" } }]);
  expect(recovery.getSnapshot()).toMatchObject([{ status: "held", retries: 1 }]);
});


it("reserves one ordinary retry for a connectivity loss and waits for both the network and deadline", async () => {
  recovery = downloadRecovery;
  let attempts = 0;
  const handle = queue(1001, async current => {
    if (++attempts > 1) return;
    await new Promise<void>((_resolve, reject) => {
      current.signal.addEventListener("abort", () => reject(current.signal.reason), { once: true });
    });
  }, { settings: { transientAction: "retry" } });
  await settle();
  scheduler.setNetworkAvailable(false);
  await settle();
  expect(attempts).toBe(1);
  expect(recovery.getSnapshot()).toMatchObject([{ retries: 1, status: "waiting" }]);
  expect(scheduler.getDownloadFailureStops().sourceErrors).toEqual({});
  await vi.advanceTimersByTimeAsync(1000);
  scheduler.setNetworkAvailable(true);
  await settle();
  expect(attempts).toBe(1);
  await vi.advanceTimersByTimeAsync(4000);
  await handle.promise;
  expect(attempts).toBe(2);
  expect(recovery.getSnapshot()).toEqual([]);
});
