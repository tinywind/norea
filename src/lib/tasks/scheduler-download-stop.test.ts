import { afterEach, describe, expect, it, vi } from "vitest";
import { ChapterMediaFinalizationError, ChapterMediaIncompleteError } from "../chapter-media/errors";
import { ChapterStorageError } from "../chapter-storage-error";
import { PluginVpnUnavailableError } from "../plugin-vpn-traffic";
import { DownloadRecoveryHoldError } from "./download-recovery";
import { TaskScheduler } from "./scheduler";

const source = {id:"source-a", name:"Source A"};
const schedulers:TaskScheduler[]=[];
afterEach(() => {
  schedulers.forEach(scheduler => scheduler.cancelActiveTasks({discardQueued:true}));
  schedulers.length=0;
  vi.useRealTimers();
});

describe("download error stop policy", () => {
  it.each([
    new Error("HTTP 401 Unauthorized"),
    new Error("HTTP 403 Forbidden"),
    new Error("HTTP 429 Too Many Requests"),
    new Error("webview_extract: timeout after 35000ms; the page moved to https://www.goodtoon012.com, outside the source site https://www.goodtoon011.com"),
    new Error("manual-action-required: Complete site verification."),
    new PluginVpnUnavailableError(),
  ])("stops the source immediately after %s without retrying or starting another chapter", async error => {
    vi.useFakeTimers();
    const scheduler=new TaskScheduler();schedulers.push(scheduler);
    const failed=scheduler.enqueueSource({kind:"chapter.download",title:"Chapter 1",source,run:async()=>{throw error;}});
    void failed.promise.catch(()=>undefined);
    const next=vi.fn(async()=>undefined);
    const sibling=scheduler.enqueueSource({kind:"chapter.download",title:"Chapter 2",source,run:next});
    void sibling.promise.catch(()=>undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.getTask(failed.id)?.status).toBe("failed");
    expect(scheduler.getSnapshot().pausedSourceIds).toContain(source.id);
    expect(next).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(next).not.toHaveBeenCalled();
    scheduler.resumeSourceQueue(source.id);
    await vi.advanceTimersByTimeAsync(0);
    await sibling.promise;expect(next).toHaveBeenCalledOnce();
  });

  it.each([
    new Error("HTTP 503 Service Unavailable"),
    new Error("webview_extract: timeout after 35000ms"),
    new TypeError("Invalid chapter parser result"),
  ])("continues past isolated %s failures and stops only after three consecutive failures", async error => {
    vi.useFakeTimers();
    const scheduler = new TaskScheduler(); schedulers.push(scheduler);
    const ch1 = scheduler.enqueueSource({ kind: "chapter.download", title: "Chapter 1", source, run: async () => { throw error; } });
    const ch2 = scheduler.enqueueSource({ kind: "chapter.download", title: "Chapter 2", source, run: async () => { throw error; } });
    const ok = vi.fn(async () => "recovered");
    const ch3 = scheduler.enqueueSource({ kind: "chapter.download", title: "Chapter 3", source, run: ok });
    void ch1.promise.catch(() => undefined);
    void ch2.promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    await expect(ch3.promise).resolves.toBe("recovered");
    expect(ok).toHaveBeenCalledOnce();
    expect(scheduler.getSnapshot().pausedSourceIds).toEqual([]);

    // Consecutive count reset on success, so two more failures still continue and the third stops the source.
    const f1 = scheduler.enqueueSource({ kind: "chapter.download", title: "Chapter 4", source, run: async () => { throw error; } });
    const f2 = scheduler.enqueueSource({ kind: "chapter.download", title: "Chapter 5", source, run: async () => { throw error; } });
    const f3 = scheduler.enqueueSource({ kind: "chapter.download", title: "Chapter 6", source, run: async () => { throw error; } });
    const heldRun = vi.fn(async () => "later");
    const held = scheduler.enqueueSource({ kind: "chapter.download", title: "Chapter 7", source, run: heldRun });
    void f1.promise.catch(() => undefined);
    void f2.promise.catch(() => undefined);
    void f3.promise.catch(() => undefined);
    void held.promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.getSnapshot().pausedSourceIds).toContain(source.id);
    expect(heldRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(heldRun).not.toHaveBeenCalled();
    scheduler.resumeSourceQueue(source.id);
    await vi.advanceTimersByTimeAsync(0);
    await expect(held.promise).resolves.toBe("later");
    expect(heldRun).toHaveBeenCalledOnce();
  });

  it("does not trigger a global storage stop for single-chapter archive verification mismatches", async () => {
    vi.useFakeTimers();
    const scheduler = new TaskScheduler(); schedulers.push(scheduler);
    const verificationError = new ChapterMediaFinalizationError(
      new ChapterStorageError(
        "archive chapter media",
        "chapter media: media archive finalization incomplete: loose media file '0007-7.jpg' has 0 bytes, expected 183222",
      ),
    );
    const failed = scheduler.enqueueSource({ kind: "chapter.download", title: "Broken archive", source, run: async () => { throw verificationError; } });
    void failed.promise.catch(() => undefined);
    const otherRun = vi.fn(async () => "other-ok");
    const other = scheduler.enqueueSource({ kind: "chapter.download", title: "Naver chapter", source: { id: "naver", name: "Naver" }, run: otherRun });
    await vi.advanceTimersByTimeAsync(0);
    await expect(other.promise).resolves.toBe("other-ok");
    expect(otherRun).toHaveBeenCalledOnce();
    expect(scheduler.getSnapshot().sourceQueuesPaused).toBe(false);
    expect(scheduler.getDownloadFailureStops().globalError).toBeUndefined();
  });
  it("skips only a missing404 chapter and lets the next one proceed", async()=> {
    const scheduler=new TaskScheduler();schedulers.push(scheduler);
    const failed=scheduler.enqueueSource({kind:"chapter.download",title:"Missing",source,run:async()=>{throw new Error("HTTP 404 Not Found");}});
    void failed.promise.catch(()=>undefined);
    const next=scheduler.enqueueSource({kind:"chapter.download",title:"Next",source,run:async()=>"stored"});
    await expect(next.promise).resolves.toBe("stored");
    expect(scheduler.getSnapshot().pausedSourceIds).toEqual([]);
  });
  it("continues the source queue when a chapter fails with per-asset media timeouts or 5xx", async () => {
    const scheduler = new TaskScheduler(); schedulers.push(scheduler);
    const incomplete = new ChapterMediaIncompleteError([
      { fileName: "0009-page.jpg", message: "scraper: browser fetch to https://img.goodtoon9001.top timed out after 30000ms", url: "https://img.goodtoon9001.top/0009.jpg" },
      { fileName: "0010-page.jpg", message: "HTTP 503", status: 503, url: "https://img.goodtoon9001.top/0010.jpg" },
    ]);
    const failed = scheduler.enqueueSource({ kind: "chapter.download", title: "Chapter 2", source, run: async () => { throw incomplete; } });
    const rejected = expect(failed.promise).rejects.toBe(incomplete);
    const next = scheduler.enqueueSource({ kind: "chapter.download", title: "Chapter 3", source, run: async () => "stored" });
    await rejected;
    await expect(next.promise).resolves.toBe("stored");
    expect(scheduler.getSnapshot().pausedSourceIds).toEqual([]);
    expect(scheduler.getDownloadFailureStops()).toEqual({ sourceErrors: {} });
  });
  it.each([
    ["403 media failure", new ChapterMediaIncompleteError([{ status: 403, message: "HTTP 403", url: "https://img.example/a.jpg" }])],
    ["429 rate-limited media", new ChapterMediaIncompleteError([{ status: 429, message: "HTTP 429", url: "https://img.example/a.jpg" }])],
    ["mixed 404 and 429 media", new ChapterMediaIncompleteError([
      { status: 404, message: "HTTP 404", url: "https://img.example/missing.jpg" },
      { status: 429, message: "HTTP 429", url: "https://img.example/limited.jpg" },
    ])],
    ["external CDN challenge", new ChapterMediaIncompleteError([{ status: 503, message: "External resource at cdn.example.net requires Cloudflare verification (HTTP 503).", url: "https://cdn.example.net/a.jpg" }])],
    ["explicit 404 pause hold", new DownloadRecoveryHoldError("HTTP 404", new ChapterMediaIncompleteError([{ status: 404, message: "HTTP 404", url: "https://img.example/a.jpg" }]))],
  ])("still stops the source queue on %s", async (_label, error) => {
    const scheduler = new TaskScheduler(); schedulers.push(scheduler);
    const failed = scheduler.enqueueSource({ kind: "chapter.download", title: "Chapter 2", source, run: async () => { throw error; } });
    void failed.promise.catch(() => undefined);
    const nextRun = vi.fn(async () => "stored");
    const next = scheduler.enqueueSource({ kind: "chapter.download", title: "Chapter 3", source, run: nextRun });
    void next.promise.catch(() => undefined);
    await expect(failed.promise).rejects.toBe(error);
    expect(scheduler.getSnapshot().pausedSourceIds).toContain(source.id);
    expect(nextRun).not.toHaveBeenCalled();
  });
  it("holds every source on storage failures while preserving other queued work", async()=> {
    vi.useFakeTimers();const scheduler=new TaskScheduler();schedulers.push(scheduler);
    const error=Object.assign(new Error("Cannot save chapter"),{code:"chapter-storage-failed"});
    const failed=scheduler.enqueueSource({kind:"chapter.download",title:"Write",source,run:async()=>{throw error;}});
    void failed.promise.catch(()=>undefined);
    const next=vi.fn(async()=>undefined);
    await vi.advanceTimersByTimeAsync(0);
    const other=scheduler.enqueueSource({kind:"chapter.download",title:"Other source",source:{id:"b",name:"B"},run:next});
    void other.promise.catch(()=>undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.getSnapshot().sourceQueuesPaused).toBe(true);
    expect(scheduler.getTask(failed.id)?.status).toBe("failed");
    expect(next).not.toHaveBeenCalled();
    expect(scheduler.getDownloadFailureStops().globalError).toContain("Cannot save chapter");
    scheduler.resumeSourceQueue();await vi.advanceTimersByTimeAsync(0);
    await other.promise;expect(next).toHaveBeenCalledOnce();
  });
  it("restores source and storage holds before any queued download starts", async()=> {
    vi.useFakeTimers();const scheduler=new TaskScheduler();schedulers.push(scheduler);
    scheduler.hydrateDownloadFailureStops({sourceErrors:{"source-a":"HTTP 503"},globalError:"Disk full"});
    const run=vi.fn(async()=>undefined);const job=scheduler.enqueueSource({kind:"chapter.download",title:"Held",source,run});
    void job.promise.catch(()=>undefined);await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();expect(scheduler.getDownloadFailureStops()).toEqual({sourceErrors:{"source-a":"HTTP 503"},globalError:"Disk full"});
    scheduler.resumeSourceQueue();await vi.advanceTimersByTimeAsync(0);await job.promise;
    expect(scheduler.getDownloadFailureStops()).toEqual({sourceErrors:{}});
  });
  it("does not convert cancellation into an error stop", async()=> {
    vi.useFakeTimers();const scheduler=new TaskScheduler();schedulers.push(scheduler);
    const job=scheduler.enqueueSource({kind:"chapter.download",title:"Cancelled",source,run:async()=>{throw new DOMException("Cancelled", "AbortError");}});
    void job.promise.catch(()=>undefined);await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.getSnapshot().pausedSourceIds).toEqual([]);
  });

  it("forgets stale held downloadRecovery episodes for tolerated failures while retaining the stop episode at the consecutive limit", async () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => { store.clear(); },
    };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage });
    vi.resetModules();
    const { downloadRecovery, downloadRecoveryKey } = await import("./download-recovery");
    const { TaskScheduler: FreshTaskScheduler } = await import("./scheduler");
    const scheduler = new FreshTaskScheduler();
    schedulers.push(scheduler);
    const error = new Error("scraper: HTTP 503");

    const runWithRecovery = (chapterId: number) =>
      scheduler.enqueueSource({
        kind: "chapter.download",
        title: `Chapter ${chapterId}`,
        source,
        subject: { chapterId, novelId: 1, pluginId: source.id, path: `/ch-${chapterId}` },
        run: (context) =>
          downloadRecovery.run(
            { job: { id: chapterId, pluginId: source.id, title: `Chapter ${chapterId}` } },
            context,
            async () => {
              throw error;
            },
          ),
      });

    try {
      const first = runWithRecovery(101);
      await expect(first.promise).rejects.toBe(error);
      expect(downloadRecovery.getSnapshot().map((entry) => entry.key)).toEqual([]);

      const second = runWithRecovery(102);
      await expect(second.promise).rejects.toBe(error);
      expect(downloadRecovery.getSnapshot().map((entry) => entry.key)).toEqual([]);

      const third = runWithRecovery(103);
      await expect(third.promise).rejects.toBe(error);
      expect(scheduler.getSnapshot().pausedSourceIds).toContain(source.id);
      expect(downloadRecovery.getSnapshot().map((entry) => entry.key)).toEqual([
        downloadRecoveryKey({ id: 103 }),
      ]);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
