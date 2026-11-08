import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceTaskSpec, TaskRunContext } from "./scheduler";

const schedulerMocks = vi.hoisted(() => ({
  enqueueSource: vi.fn(),
}));

vi.mock("./scheduler", async (importOriginal) => ({
  ...await importOriginal<typeof import("./scheduler")>(),
  taskScheduler: { enqueueSource: schedulerMocks.enqueueSource },
}));

import { TaskScheduler } from "./scheduler";
import { enqueueSourceTask } from "./source-tasks";

const source = { id: "source-a", name: "Source A" };
const plugin = { ...source, getBaseUrl: () => "https://source.test/" };
const scopeKey = "plugin:source-a:site:source.test";
const block = {
  challenge: { kind: "forbidden" as const, url: "https://source.test/chapter/1" },
  detectedAt: 10,
  revision: 7,
  scopeKey,
  sourceId: source.id,
  verificationRequested: false,
};

let scheduler: TaskScheduler;

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function enqueueCookieClear(run: (context: TaskRunContext) => Promise<number>) {
  const handle = enqueueSourceTask({
    kind: "source.clearCookies",
    plugin,
    priority: "user",
    title: "Clear source cookies",
    subject: { url: plugin.getBaseUrl() },
    dedupeKey: "source.clearCookies:" + plugin.id,
    run,
  });
  void handle.promise.catch(() => undefined);
  return handle;
}

beforeEach(() => {
  vi.useFakeTimers();
  scheduler = new TaskScheduler({ sourceForegroundConcurrency: 1 });
  schedulerMocks.enqueueSource.mockImplementation(
    (spec: SourceTaskSpec<unknown>) => scheduler.enqueueSource(spec),
  );
});

afterEach(async () => {
  scheduler.cancelActiveTasks({ discardQueued: true });
  await settle();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("cookie clearing during source recovery", () => {
  it.each([true, false])(
    "clears a blocked source without unblocking downloads (network available: %s)",
    async (networkAvailable) => {
      scheduler.setNetworkAvailable(networkAvailable);
      scheduler.hydrateSourceAccessBlocks([block]);
      const confirmed = vi.fn();
      scheduler.subscribeSourceAccessConfirmed(confirmed);
      const downloadRun = vi.fn(async () => undefined);
      const download = scheduler.enqueueSource({
        kind: "chapter.download",
        title: "Blocked chapter",
        source,
        sourceAccessScopeKey: scopeKey,
        run: downloadRun,
      });
      void download.promise.catch(() => undefined);
      const clear = vi.fn(async (_context: TaskRunContext) => 3);
      const clearing = enqueueCookieClear(clear);

      await settle();

      expect(clear).toHaveBeenCalledOnce();
      expect(clear.mock.calls[0]![0]).toMatchObject({
        executor: "immediate",
        sourceAccessVerification: false,
      });
      expect(scheduler.getTask(clearing.id)?.status).toBe("succeeded");
      await expect(clearing.promise).resolves.toBe(3);
      expect(downloadRun).not.toHaveBeenCalled();
      expect(scheduler.getTask(download.id)?.status).toBe("queued");
      expect(scheduler.getSourceAccessBlock(scopeKey)).toMatchObject(block);
      expect(confirmed).not.toHaveBeenCalled();
    },
  );

  it("retains the foreground executor lease and never uses cookie clearing as a canary", async () => {
    let releaseBrowser!: () => void;
    const browser = scheduler.enqueueSource({
      kind: "source.openSite",
      priority: "interactive",
      title: "Open site",
      source,
      exclusive: true,
      run: () => new Promise<void>((resolve) => { releaseBrowser = resolve; }),
    });
    void browser.promise.catch(() => undefined);
    await settle();
    scheduler.hydrateSourceAccessBlocks([block]);
    const clear = vi.fn(async (_context: TaskRunContext) => 2);
    const clearing = enqueueCookieClear(clear);

    try {
      await settle();
      expect(scheduler.getTask(browser.id)?.status).toBe("running");
      expect(scheduler.getTask(clearing.id)?.status).toBe("queued");
      expect(clear).not.toHaveBeenCalled();
      expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(false);
    } finally {
      releaseBrowser();
      await browser.promise;
    }
    await settle();

    expect(clear).toHaveBeenCalledOnce();
    expect(clear.mock.calls[0]![0].executor).toBe("immediate");
    await expect(clearing.promise).resolves.toBe(2);
    expect(scheduler.getSourceAccessBlock(scopeKey)).toMatchObject(block);
  });

  it("finishes local cookie deletion when a source challenge arrives during it", async () => {
    let context!: TaskRunContext;
    let finishClear!: (count: number) => void;
    const clear = vi.fn((current: TaskRunContext) => {
      context = current;
      return new Promise<number>((resolve) => { finishClear = resolve; });
    });
    const clearing = enqueueCookieClear(clear);
    const confirmed = vi.fn();
    scheduler.subscribeSourceAccessConfirmed(confirmed);
    await settle();

    try {
      expect(scheduler.getTask(clearing.id)?.status).toBe("running");
      scheduler.hydrateSourceAccessBlocks([block]);
      expect(context.signal.aborted).toBe(false);
    } finally {
      finishClear(2);
      await settle();
    }

    await expect(clearing.promise).resolves.toBe(2);
    expect(clear).toHaveBeenCalledOnce();
    expect(scheduler.getSourceAccessBlock(scopeKey)).toMatchObject(block);
    expect(confirmed).not.toHaveBeenCalled();
  });
});
