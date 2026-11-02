import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceAccessRequiredError } from "../plugins/source-access";
import { TaskScheduler, type SourceTaskSpec, type TaskRunContext } from "./scheduler";
import type { VpnDownloadWorkerRef } from "./vpn-download-types";

let scheduler: TaskScheduler;
const source = { id: "same-source", name: "Same source" };
const url = "https://source.test/chapter";
const settle = () => vi.advanceTimersByTimeAsync(0);
function queue(rangeId: string, slot: 0 | 1, run: SourceTaskSpec<void>["run"], generation = 1) {
  const handle = scheduler.enqueueSource({
    kind: "chapter.download", title: rangeId, source, priority: "background",
    resolveSourceAccessUrl: () => url,
    vpnWorker: { rangeId, slot, generation },
    run: (context) => {
      context.setSourceAccessUrl?.(url);
      return run(context);
    },
  });
  void handle.promise.catch(() => undefined);
  return handle;
}
function hold(context: TaskRunContext): Promise<void> {
  return new Promise((_, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
}
beforeEach(() => {
  vi.useFakeTimers();
  scheduler = new TaskScheduler({ sourceForegroundConcurrency: 1 });
});
afterEach(async () => {
  scheduler.cancelActiveTasks({ discardQueued: true });
  await settle();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("dedicated VPN worker scheduling", () => {
  describe.each(["queued", "running"] as const)("%s task deduplication", status => {
    const worker: VpnDownloadWorkerRef = { rangeId: "range-a", slot: 0, generation: 1 };
    it.each([
      { name: "default to VPN", existing: undefined, requested: worker, executor: "pool:0" },
      { name: "VPN to default", existing: worker, requested: undefined, executor: "vpn:0:1" },
      { name: "another slot", existing: worker, requested: { ...worker, slot: 1 as const }, executor: "vpn:0:1" },
      { name: "another range", existing: worker, requested: { ...worker, rangeId: "range-b" }, executor: "vpn:0:1" },
      { name: "another generation", existing: worker, requested: { ...worker, generation: 2 }, executor: "vpn:0:1" },
    ])("rejects $name without adopting or reprioritizing the original task", async value => {
      scheduler.pauseTaskGroup("downloads");
      const started: string[] = [];
      const original = scheduler.enqueueSource({
        kind: "chapter.download", title: "Original", source, priority: "background",
        dedupeKey: "chapter.download:7", vpnWorker: value.existing,
        run: context => { started.push(context.executor!); return hold(context); },
      });
      void original.promise.catch(() => undefined);
      if (status === "running") {
        scheduler.resumeTaskGroup("downloads");
        await settle();
      }
      expect(scheduler.getTask(original.id)?.status).toBe(status);
      expect(() => scheduler.enqueueSource({
        kind: "chapter.download", title: "Conflicting", source, priority: "interactive",
        dedupeKey: "chapter.download:7", vpnWorker: value.requested, run: async () => { started.push("conflicting"); },
      })).toThrow(/VPN.*owner/i);
      expect(scheduler.getSnapshot().total).toBe(1);
      expect(scheduler.getTask(original.id)).toMatchObject({ title: "Original", priority: "background", status });
      expect(scheduler.getTask(original.id)?.vpnWorker).toEqual(value.existing);
      scheduler.resumeTaskGroup("downloads");
      await settle();
      expect(started).toEqual([value.executor]);
    });

    it("coalesces a duplicate from the exact same VPN worker", async () => {
      scheduler.pauseTaskGroup("downloads");
      const run = vi.fn(hold);
      const spec: SourceTaskSpec<void> = {
        kind: "chapter.download", title: "Owned", source, dedupeKey: "chapter.download:7", vpnWorker: worker, run,
      };
      const original = scheduler.enqueueSource(spec);
      void original.promise.catch(() => undefined);
      if (status === "running") { scheduler.resumeTaskGroup("downloads"); await settle(); }
      const duplicate = scheduler.enqueueSource({ ...spec, vpnWorker: { ...worker } });
      expect(duplicate.id).toBe(original.id);
      expect(duplicate.promise).toBe(original.promise);
      scheduler.resumeTaskGroup("downloads");
      await settle();
      expect(run).toHaveBeenCalledOnce();
      expect(scheduler.getTask(original.id)?.vpnWorker).toEqual(worker);
    });
  });

  it("runs two ranges of the same source concurrently on their owning executors", async () => {
    const executors: string[] = [];
    queue("range-a", 0, (context) => { executors.push(context.executor!); return hold(context); });
    queue("range-b", 1, (context) => { executors.push(context.executor!); return hold(context); });
    await settle();
    expect(executors).toEqual(["vpn:0:1", "vpn:1:1"]);
    expect(scheduler.getSnapshot().running).toBe(2);
  });

  it("does not reuse a physical worker slot while an older generation is still settling", async () => {
    const started: string[] = [];
    let finish!: () => void;
    queue("old", 0, async () => { started.push("old"); await new Promise<void>((resolve) => { finish = resolve; }); });
    queue("new", 0, async () => { started.push("new"); }, 2);
    await settle();
    expect(started).toEqual(["old"]);
    finish();
    await settle();
    expect(started).toEqual(["old", "new"]);
  });

  it("keeps ordinary same-source work on the default route while VPN workers are busy", async () => {
    queue("range-a", 0, hold);
    let defaultExecutor: string | undefined;
    const normal = scheduler.enqueueSource({ kind: "source.refreshNovel", title: "Default", source,
      run: async ({ executor }) => { defaultExecutor = executor; } });
    await settle();
    await normal.promise;
    expect(defaultExecutor).toBe("pool:0");
  });

  it("blocks only the challenged range and preserves the sibling and default source", async () => {
    queue("range-a", 0, async () => { throw new SourceAccessRequiredError("CAPTCHA", { kind: "captcha", url }); });
    let siblingSignal!: AbortSignal;
    queue("range-b", 1, (context) => { siblingSignal = context.signal; return hold(context); });
    await settle();
    const blocks = scheduler.getSnapshot().sourceAccessBlocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ sourceId: source.id, rangeId: "range-a", workerGeneration: 1 });
    expect(siblingSignal.aborted).toBe(false);
    let normalRan = false;
    const normal = scheduler.enqueueSource({ kind: "source.refreshNovel", title: "Default", source, run: async () => { normalRan = true; } });
    await settle();
    await normal.promise;
    expect(normalRan).toBe(true);
  });

  it("verifies a VPN challenge on the same worker and retains the block until the whole canary settles", async () => {
    let attempts = 0;
    let finish!: () => void;
    let canary!: TaskRunContext;
    queue("range-a", 0, async (context) => {
      if (++attempts === 1) throw new SourceAccessRequiredError("Cloudflare", { kind: "cloudflare", url });
      canary = context;
      expect(context.confirmSourceAccess?.()).toBe(true);
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    await settle();
    const block = scheduler.getSnapshot().sourceAccessBlocks[0]!;
    expect(scheduler.beginSourceAccessVerification(block.scopeKey)).toBe(true);
    await settle();
    expect(canary.executor).toBe("vpn:0:1");
    expect(scheduler.getSnapshot().sourceAccessBlocks).toHaveLength(1);
    finish();
    await settle();
    expect(scheduler.getSnapshot().sourceAccessBlocks).toEqual([]);
  });

  it("keeps an asset challenge in the same range after a successful body response", async () => {
    let attempts = 0;
    const handle = queue("range-a", 0, async (context) => {
      if (++attempts === 1) throw new SourceAccessRequiredError("Cloudflare", { kind: "cloudflare", url });
      context.confirmSourceAccess?.();
      throw new SourceAccessRequiredError("CAPTCHA asset", { kind: "captcha", url });
    });
    await settle();
    scheduler.beginSourceAccessVerification(scheduler.getSnapshot().sourceAccessBlocks[0]!.scopeKey);
    await settle();
    expect(scheduler.getTask(handle.id)?.status).toBe("queued");
    expect(scheduler.getSnapshot().sourceAccessBlocks[0]).toMatchObject({ rangeId: "range-a", challenge: { kind: "captcha" }, verificationRequested: false });
    expect(attempts).toBe(2);
  });

  it("rejects unsupported worker slots and invalid generations before enqueueing", () => {
    expect(() => queue("range", 0, async () => undefined, 0)).toThrow(/worker/i);
    expect(scheduler.getSnapshot().total).toBe(0);
  });

  it("requires range-level resume instead of retrying a cancelled stale worker task", async () => {
    const handle = queue("range-a", 0, hold);
    await settle();
    scheduler.cancel(handle.id);
    await settle();
    expect(scheduler.getTask(handle.id)).toMatchObject({ status: "cancelled", canRetry: false });
  });

  it("enrolls the exact replacement task as canary without clearing sibling blocks", async () => {
    const original = queue("range-a", 0, async () => { throw new SourceAccessRequiredError("CAPTCHA", { kind: "captcha", url }); });
    queue("range-b", 1, async () => { throw new SourceAccessRequiredError("CAPTCHA", { kind: "captcha", url }); });
    await settle();
    scheduler.cancel(original.id); await settle();
    let finish!: () => void;
    let context: TaskRunContext | undefined;
    const next = queue("range-a", 0, async current => { context = current; current.confirmSourceAccess?.(); await new Promise<void>(resolve => { finish = resolve; }); }, 2);
    expect(scheduler.beginVpnSourceAccessVerification(next.id, { rangeId: "range-a", slot: 0, generation: 1 }, { kind: "captcha", url })).toBe(false);
    expect(scheduler.beginVpnSourceAccessVerification(next.id, { rangeId: "range-b", slot: 0, generation: 2 }, { kind: "captcha", url })).toBe(false);
    expect(scheduler.beginVpnSourceAccessVerification(next.id, { rangeId: "range-a", slot: 0, generation: 2 }, { kind: "captcha", url })).toBe(true);
    await settle();
    expect(context?.executor).toBe("vpn:0:2");
    expect(context?.sourceAccessVerification).toBe(true);
    expect(scheduler.getSnapshot().sourceAccessBlocks).toHaveLength(2);
    finish(); await settle();
    expect(scheduler.getSnapshot().sourceAccessBlocks.map(block => block.rangeId)).toEqual(["range-b"]);
  });

  it("reconstructs a persisted range challenge only for an exact queued worker task", async () => {
    let verified = false;
    const next = queue("range-restored", 0, async context => { verified = context.sourceAccessVerification === true; context.confirmSourceAccess?.(); }, 9);
    expect(scheduler.beginVpnSourceAccessVerification(next.id, { rangeId: "range-restored", slot: 0, generation: 9 }, { kind: "cloudflare", url })).toBe(true);
    await settle(); await next.promise;
    expect(verified).toBe(true);
    expect(scheduler.getSnapshot().sourceAccessBlocks).toEqual([]);
  });
});
