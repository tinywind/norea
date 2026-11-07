import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskScheduler } from "./scheduler";

const source = {id:"source-a", name:"Source A"};
const schedulers:TaskScheduler[]=[];
afterEach(() => {
  schedulers.forEach(scheduler => scheduler.cancelActiveTasks({discardQueued:true}));
  schedulers.length=0;
  vi.useRealTimers();
});

describe("download error stop policy", () => {
  it.each([new Error("HTTP 401 Unauthorized"), new Error("HTTP 429 Too Many Requests"), new Error("HTTP 503 Service Unavailable"), new Error("webview_extract: timeout after 35000ms"), new TypeError("Invalid chapter parser result")])("stops the source after %s without retrying or starting another chapter", async error => {
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
  it("skips only a missing404 chapter and lets the next one proceed", async()=> {
    const scheduler=new TaskScheduler();schedulers.push(scheduler);
    const failed=scheduler.enqueueSource({kind:"chapter.download",title:"Missing",source,run:async()=>{throw new Error("HTTP 404 Not Found");}});
    void failed.promise.catch(()=>undefined);
    const next=scheduler.enqueueSource({kind:"chapter.download",title:"Next",source,run:async()=>"stored"});
    await expect(next.promise).resolves.toBe("stored");
    expect(scheduler.getSnapshot().pausedSourceIds).toEqual([]);
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
});
