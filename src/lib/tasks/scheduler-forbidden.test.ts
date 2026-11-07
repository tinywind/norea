import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskScheduler } from "./scheduler";

const source = { id: "source", name: "Source" };
const url = "https://source.test/chapter/1";
const scopeKey = "plugin:source:site:source.test";
const schedulers: TaskScheduler[] = [];

afterEach(() => {
  schedulers.forEach(scheduler => scheduler.cancelActiveTasks({ discardQueued: true }));
  schedulers.length = 0;
  vi.useRealTimers();
});

describe("HTTP 403 source access hold", () => {
  it("uses the configured source URL when a plugin reports 403 without a URL", async () => {
    vi.useFakeTimers();
    const scheduler = new TaskScheduler();
    schedulers.push(scheduler);
    const handle = scheduler.enqueueSource({
      kind: "chapter.download", title: "Chapter 1", source,
      run: async context => {
        context.setSourceAccessUrl?.(url);
        throw new Error("Forbidden (HTTP 403)");
      },
    });
    void handle.promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.getSnapshot().sourceAccessBlocks).toMatchObject([{
      challenge: { kind: "forbidden", url },
    }]);
    expect(scheduler.getTask(handle.id)?.status).toBe("queued");
  });

  it("holds the forbidden chapter and source siblings until explicit verification", async () => {
    vi.useFakeTimers();
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    schedulers.push(scheduler);
    let requests = 0;
    const first = scheduler.enqueueSource({
      kind: "chapter.download", title: "Chapter 1", source, sourceAccessScopeKey: scopeKey,
      run: async context => {
        requests++;
        if (requests === 1) throw `scraper: navigation failed (HTTP 403): Forbidden at ${url}`;
        context.confirmSourceAccess?.();
      },
    });
    void first.promise.catch(() => undefined);
    const siblingRun = vi.fn(async () => undefined);
    const sibling = scheduler.enqueueSource({
      kind: "chapter.download", title: "Chapter 2", source,
      sourceAccessScopeKey: scopeKey, run: siblingRun,
    });
    void sibling.promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.getTask(first.id)?.status).toBe("queued");
    expect(scheduler.getSnapshot().sourceAccessBlocks).toMatchObject([{
      sourceId: "source", challenge: { kind: "forbidden", url }, verificationRequested: false,
    }]);
    expect(siblingRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(requests).toBe(1);
    expect(siblingRun).not.toHaveBeenCalled();
    scheduler.resumeSourceQueue();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toBe(1);
    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    await first.promise;
    await sibling.promise;
    expect(requests).toBe(2);
    expect(siblingRun).toHaveBeenCalledOnce();
    expect(scheduler.getSnapshot().sourceAccessBlocks).toEqual([]);
  });

  it("does not hold another source when one source refuses access", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    schedulers.push(scheduler);
    const forbidden = scheduler.enqueueSource({
      kind: "chapter.download", title: "Forbidden chapter", source, sourceAccessScopeKey: scopeKey,
      run: async () => { throw new Error(`scraper: navigation failed (HTTP 403): Forbidden at ${url}`); },
    });
    void forbidden.promise.catch(() => undefined);
    const other = scheduler.enqueueSource({
      kind: "chapter.download", title: "Other source", source: { id: "other", name: "Other" },
      run: async () => "downloaded",
    });
    await expect(other.promise).resolves.toBe("downloaded");
    expect(scheduler.getSnapshot().sourceAccessBlocks).toHaveLength(1);
  });
});
