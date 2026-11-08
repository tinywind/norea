import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContentServerError } from "../content-sync/client";
import { TaskScheduler, type SourceTaskSpec } from "./scheduler";

const source = { id: "source-a", name: "Source A" };
let scheduler: TaskScheduler;
const settle = () => vi.advanceTimersByTimeAsync(0);
const server = (run: SourceTaskSpec<void>["run"]): SourceTaskSpec<void> => ({
  kind: "chapter.download", title: "Server chapter", source, serverLane: true,
  serverOnly: true, canCompleteWithoutSourceAccess: true, run,
});

beforeEach(() => {
  vi.useFakeTimers();
  scheduler = new TaskScheduler({ sourceQueuesPaused: false });
});
afterEach(async () => {
  scheduler.cancelActiveTasks({ discardQueued: true });
  await settle();
  vi.useRealTimers();
});

it("downloads from the server without resuming an unrelated source failure hold", async () => {
  scheduler.hydrateDownloadFailureStops({ sourceErrors: { "source-a": "Source parser failed" } });
  const sourceRun = vi.fn(async () => undefined);
  const held = scheduler.enqueueSource({ kind: "chapter.download", title: "Source chapter", source, run: sourceRun });
  void held.promise.catch(() => undefined);
  const executors: string[] = [];
  const copy = scheduler.enqueueSource(server(async ({ executor }) => { executors.push(executor!); }));
  await settle();
  await copy.promise;
  expect(executors).toEqual(["server:0"]);
  expect(sourceRun).not.toHaveBeenCalled();
  expect(scheduler.getDownloadFailureStops().sourceErrors).toEqual({ "source-a": "Source parser failed" });
});

it("does not interrupt a server transfer when the source parser fails beside it", async () => {
  let finish!: () => void;
  let signal!: AbortSignal;
  const copy = scheduler.enqueueSource(server(async context => {
    signal = context.signal;
    await new Promise<void>(resolve => { finish = resolve; });
  }));
  await settle();
  const failed = scheduler.enqueueSource({ kind: "chapter.download", title: "Source chapter", source,
    run: async () => { throw new Error("Source parser failed"); } });
  void failed.promise.catch(() => undefined);
  await settle();
  expect(scheduler.getTask(failed.id)?.status).toBe("failed");
  expect(signal.aborted).toBe(false);
  finish(); await settle(); await copy.promise;
});

it.each([403, 404, 503])("reports server HTTP %i without creating a source failure or access hold", async status => {
  const failure = new ContentServerError(status);
  const copy = scheduler.enqueueSource(server(async () => { throw failure; }));
  const outcome = copy.promise.catch(error => error);
  await settle();
  expect(await outcome).toBe(failure);
  expect(scheduler.getTask(copy.id)?.status).toBe("failed");
  expect(scheduler.getDownloadFailureStops()).toEqual({ sourceErrors: {} });
  expect(scheduler.getSnapshot().sourceAccessBlocks).toEqual([]);
});

it("does not offer a server-only download as a source verification candidate", async () => {
  const scopeKey = "plugin:source-a:site:source.test";
  scheduler.hydrateSourceAccessBlocks([{
    sourceId: source.id, scopeKey, revision: 7, detectedAt: 10,
    challenge: { kind: "forbidden", url: "https://source.test" }, verificationRequested: false,
  }]);
  scheduler.setBackgroundExecutionSuspended(true);
  const resolveSourceAccessUrl = vi.fn(async () => "https://source.test/chapter");
  const contexts: Array<{ executor?: string; sourceAccessVerification?: boolean }> = [];
  const copy = scheduler.enqueueSource({ ...server(async context => { contexts.push(context); }), resolveSourceAccessUrl });
  expect(scheduler.canBeginSourceAccessVerification(scopeKey)).toBe(false);
  await scheduler.resolveSourceAccessBrowserUrl(scopeKey, 7);
  expect(resolveSourceAccessUrl).not.toHaveBeenCalled();
  expect(scheduler.beginSourceAccessVerification(scopeKey, { waitForTask: true })).toBe(true);
  scheduler.setBackgroundExecutionSuspended(false);
  await settle(); await copy.promise;
  expect(contexts).toMatchObject([{ executor: "server:0", sourceAccessVerification: false }]);
  expect(scheduler.getSourceAccessBlock(scopeKey)).toMatchObject({ revision: 7, verificationRequested: true });
  expect(scheduler.getSourceAccessBlock(scopeKey)?.verificationTaskId).toBeUndefined();
});

it("rejects attempts to enter source access from a server-only task", async () => {
  const copy = scheduler.enqueueSource(server(async context => { context.tryStartSourceAccess!(); }));
  const outcome = copy.promise.catch(error => error);
  await settle();
  expect(await outcome).toMatchObject({ message: "Content server downloads cannot access source sites." });
  expect(scheduler.getDownloadFailureStops()).toEqual({ sourceErrors: {} });
});

it.each(["manual", "storage"])("retains the %s pause for server-only downloads", async kind => {
  if (kind === "manual") scheduler.pauseSourceQueue(source.id);
  else scheduler.hydrateDownloadFailureStops({ globalError: "Storage is unavailable", sourceErrors: {} });
  const run = vi.fn(async () => undefined);
  const copy = scheduler.enqueueSource(server(run));
  await settle();
  expect(run).not.toHaveBeenCalled();
  expect(scheduler.getTask(copy.id)?.status).toBe("queued");
  if (kind === "manual") scheduler.resumeSourceQueue(source.id);
  else scheduler.resumeSourceQueue();
  await settle(); await copy.promise;
  expect(run).toHaveBeenCalledOnce();
});

it("retries a server task from the task panel without releasing an unrelated source hold", async () => {
  scheduler.hydrateDownloadFailureStops({ sourceErrors: { "source-a": "Source parser failed" } });
  const sourceRun = vi.fn(async () => undefined);
  const held = scheduler.enqueueSource({ kind: "chapter.download", title: "Source chapter", source, run: sourceRun });
  void held.promise.catch(() => undefined);
  const serverRun = vi.fn().mockRejectedValueOnce(new ContentServerError(503)).mockResolvedValueOnce(undefined);
  const copy = scheduler.enqueueSource({ ...server(serverRun), canRetry: true });
  void copy.promise.catch(() => undefined);
  await settle();
  const retried = scheduler.retry(copy.id);
  expect(retried).not.toBeNull();
  await settle(); await retried!.promise;
  expect(serverRun).toHaveBeenCalledTimes(2);
  expect(sourceRun).not.toHaveBeenCalled();
  expect(scheduler.getDownloadFailureStops().sourceErrors).toEqual({ "source-a": "Source parser failed" });
});

it.each(["queued", "running"])("does not deduplicate a strict request onto a %s source-capable task", async status => {
  let finish!: () => void;
  scheduler.setBackgroundExecutionSuspended(status === "queued");
  const sourceRun = vi.fn(async () => new Promise<void>(resolve => { finish = resolve; }));
  const original = scheduler.enqueueSource({ kind: "chapter.download", title: "Source chapter", source,
    dedupeKey: "chapter.download:7", run: sourceRun });
  void original.promise.catch(() => undefined);
  await settle();
  const serverRun = vi.fn(async () => undefined);
  expect(() => scheduler.enqueueSource({ ...server(serverRun), dedupeKey: "chapter.download:7" }))
    .toThrow("An active source task cannot satisfy a content server-only request.");
  expect(scheduler.getTask(original.id)?.status).toBe(status);
  expect(serverRun).not.toHaveBeenCalled();
  if (status === "running") { finish(); await settle(); await original.promise; }
});
