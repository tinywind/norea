
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskScheduler, type SourceTaskSpec, type TaskSourceRoute } from "./scheduler";

const owner = { id: "source-b", name: "Target B" };
const original = { id: "source-a", name: "Original A" };
const route: TaskSourceRoute = { source: original, sourceCooldownKey: "chapter.download:source-a",
  sourceAccessVerificationKey: "chapter.download:source-a:701" };
const subject = { chapterId: 701, novelId: 22, pluginId: owner.id, path: "norea-composed:entry-a" };
let scheduler: TaskScheduler;
const settle = () => vi.advanceTimersByTimeAsync(0);
const spec = (run: SourceTaskSpec<void>["run"]): SourceTaskSpec<void> => ({
  kind: "chapter.download", title: "Composed chapter", source: owner, subject,
  dedupeKey: "chapter.download:701", canCompleteWithoutSourceAccess: true, serverLane: true, run,
});
beforeEach(() => { vi.useFakeTimers(); scheduler = new TaskScheduler({ sourceQueuesPaused: false, sourceForegroundConcurrency: 2 }); });
afterEach(async () => { scheduler.cancelActiveTasks({ discardQueued: true }); await settle(); vi.clearAllTimers(); vi.useRealTimers(); });

it("hands the same server-first task to the original source while keeping its storage subject", async () => {
  const attempts: Array<[string | undefined, boolean]> = [];
  const task = scheduler.enqueueSource(spec(async context => {
    attempts.push([context.executor, context.tryStartSourceAccess!(route)]);
  }));
  await settle(); await task.promise;
  expect(attempts).toEqual([["server:0", false], ["pool:0", true]]);
  expect(scheduler.getTask(task.id)).toMatchObject({ id: task.id, status: "succeeded", source: original, subject });
});

it("keeps the original source challenge active after a handoff without loading another executor", async () => {
  const scopeKey = "plugin:source-a:site:original.test";
  scheduler.hydrateSourceAccessBlocks([{ sourceId: original.id, scopeKey, revision: 7, detectedAt: 10,
    challenge: { kind: "forbidden", url: "https://original.test" }, verificationRequested: false }]);
  const network = vi.fn();
  const task = scheduler.enqueueSource(spec(async context => { if (context.tryStartSourceAccess!(route)) network(); }));
  void task.promise.catch(() => undefined);
  await settle();
  expect(scheduler.getTask(task.id)).toMatchObject({ status: "queued", source: original, subject });
  expect(scheduler.getTaskByDedupeKey("chapter.download:701")?.id).toBe(task.id);
  expect(network).not.toHaveBeenCalled();
  expect(scheduler.getSourceAccessBlock(scopeKey)).toMatchObject({ revision: 7, verificationRequested: false });
});

it("does not apply the target source failure hold to a different original source", async () => {
  scheduler.hydrateDownloadFailureStops({ sourceErrors: { [owner.id]: "Target source unavailable" } });
  const network = vi.fn();
  const task = scheduler.enqueueSource(spec(async context => { if (context.tryStartSourceAccess!(route)) network(); }));
  await settle(); await task.promise;
  expect(network).toHaveBeenCalledOnce();
  expect(scheduler.getDownloadFailureStops().sourceErrors).toEqual({ [owner.id]: "Target source unavailable" });
});

it("cancels a pending source handoff without resurrecting the task after its old run settles", async () => {
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const network = vi.fn();
  const task = scheduler.enqueueSource(spec(async context => {
    if (context.tryStartSourceAccess!(route)) network();
    else await waiting;
  }));
  const result = task.promise.catch(error => error);
  await settle();
  expect(scheduler.getTask(task.id)).toMatchObject({ status: "running", source: owner });
  expect(scheduler.cancel(task.id)).toBe(true);
  finish(); await settle();
  expect(await result).toMatchObject({ name: "AbortError", cancelledByUser: true });
  expect(scheduler.getTask(task.id)?.status).toBe("cancelled");
  expect(network).not.toHaveBeenCalled();
  expect(scheduler.getSnapshot().records.filter(record => record.status === "running" || record.status === "queued")).toEqual([]);
});

it("waits for an existing original-source lease instead of using a free second executor", async () => {
  let finish!: () => void;
  const active = scheduler.enqueueSource({ kind: "chapter.download", title: "Existing A request", source: original,
    run: () => new Promise<void>(resolve => { finish = resolve; }) });
  await settle();
  const network = vi.fn();
  const task = scheduler.enqueueSource(spec(async context => { if (context.tryStartSourceAccess!(route)) network(context.executor); }));
  await settle();
  expect(scheduler.getTask(task.id)).toMatchObject({ status: "queued", source: original });
  expect(network).not.toHaveBeenCalled();
  finish(); await settle(); await Promise.all([active.promise, task.promise]);
  expect(network).toHaveBeenCalledExactlyOnceWith("pool:0");
});

it("retains the enrolled VPN worker and serializes the original-source handoff on that lease", async () => {
  const worker = { rangeId: "composed-range", slot: 0, generation: 8 } as const;
  const attempts: Array<[string | undefined, boolean]> = [];
  const task = scheduler.enqueueSource({ ...spec(async context => {
    attempts.push([context.executor, context.tryStartSourceAccess!({ ...route, sourceCooldownKey: "chapter.download:composed-range" })]);
  }), vpnWorker: worker });
  await settle(); await task.promise;
  expect(attempts).toEqual([["vpn:0:8", false], ["vpn:0:8", true]]);
  expect(scheduler.getTask(task.id)).toMatchObject({ source: original, subject, vpnWorker: worker, status: "succeeded" });
});
