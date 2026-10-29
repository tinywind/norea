import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskScheduler, type TaskSpec, type TaskRunContext } from "./scheduler";
import { PluginVpnUnavailableError } from "../plugin-vpn-traffic";
import { ChapterMediaIncompleteError } from "../chapter-media/errors";

let scheduler: TaskScheduler;
const networkError = () => new TypeError("Failed to fetch");
const spec = (run: TaskSpec<void>["run"], id = "a") => ({
  kind: "chapter.download" as const, title: "Download", source: { id, name: id },
  dedupeKey: `download:${id}`, canRetry: true, run,
});
const settle = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  scheduler = new TaskScheduler({ sourceForegroundConcurrency: 1, sourceQueuesPaused: false });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const failures = [
  networkError(),
  new Error("webview_extract: timeout after 30000ms"),
  new Error("manual-action-required: The source page requires manual action."),
  new Error("content-not-found: Captured chapter content is empty."),
  new PluginVpnUnavailableError(),
  new ChapterMediaIncompleteError([
    { fileName: "missing.jpg", message: "Failed to fetch", url: "https://media.test/missing.jpg" },
  ]),
];

describe("manual download retries", () => {
  it.each(failures)("fails immediately and keeps manual retry available for %s", async (error) => {
    const run = vi.fn().mockRejectedValue(error);
    const handle = scheduler.enqueueSource(spec(run));
    const checked = expect(handle.promise).rejects.toBe(error);
    await settle();
    await checked;
    expect(scheduler.getTask(handle.id)).toMatchObject({ status: "failed", canRetry: true });
    expect(scheduler.getTask(handle.id)?.error).toBeTruthy();
    const next = scheduler.enqueueSource({ ...spec(async () => undefined), dedupeKey: "download:next" });
    await settle();
    await expect(next.promise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.getTask(handle.id)).toMatchObject({ status: "failed", canRetry: true });
  });

  it.each([0, 250])("retains a body failure alongside %i queued tasks", async (pendingCount) => {
    scheduler.pauseSourceQueue("pending");
    for (let index = 0; index < pendingCount; index += 1) {
      scheduler.enqueueSource({ ...spec(async () => undefined, "pending"), dedupeKey: `pending:${index}` });
    }
    const error = new Error("webview_extract: timeout after 30000ms");
    const run = vi.fn().mockRejectedValue(error);
    const handle = scheduler.enqueueSource(spec(run));
    const checked = expect(handle.promise).rejects.toBe(error);
    await settle();
    await checked;
    expect(scheduler.getSnapshot()).toMatchObject({ queued: pendingCount, running: 0, failed: 1 });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.getTask(handle.id)).toMatchObject({ status: "failed", error: error.message, canRetry: true });
  });

  it("runs again only when the user retries the failed task", async () => {
    const error = networkError();
    const run = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const handle = scheduler.enqueueSource(spec(run));
    const checked = expect(handle.promise).rejects.toBe(error);
    await settle();
    await checked;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run).toHaveBeenCalledTimes(1);
    const retried = scheduler.retry(handle.id);
    if (!retried) throw new Error("Failed download cannot be retried.");
    await settle();
    await expect(retried.promise).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
    expect(scheduler.getTask(retried.id)?.status).toBe("succeeded");
  });

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
