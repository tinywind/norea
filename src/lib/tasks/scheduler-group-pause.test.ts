import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceAccessRequiredError } from "../plugins/source-access";
import {
  TaskScheduler,
  type SourceTaskSpec,
  type TaskRunContext,
} from "./scheduler";

const source = { id: "source", name: "Source" };
let scheduler: TaskScheduler;
const settle = () => vi.advanceTimersByTimeAsync(0);

function enqueue(kind: SourceTaskSpec<void>["kind"], run: SourceTaskSpec<void>["run"]) {
  const handle = scheduler.enqueueSource({ kind, title: kind, source, priority: "deferred", run });
  void handle.promise.catch(() => undefined);
  return handle;
}

beforeEach(() => {
  vi.useFakeTimers();
  scheduler = new TaskScheduler({ sourceForegroundConcurrency: 2 });
});
afterEach(async () => {
  scheduler.cancelActiveTasks({ discardQueued: true });
  await settle();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("notification task group pause", () => {
  it.each([
    ["downloads", "chapter.download", "source.refreshNovel"],
    ["libraryMetadata", "source.refreshNovel", "chapter.download"],
  ] as const)("pauses %s without stopping the other category on the same source", async (group, pausedKind, otherKind) => {
    let attempts = 0;
    let firstContext!: TaskRunContext;
    const paused = enqueue(pausedKind, context => {
      attempts += 1;
      if (attempts > 1) return Promise.resolve();
      firstContext = context;
      return new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
    });
    await settle();
    scheduler.pauseTaskGroup(group);
    const other = enqueue(otherKind, async () => undefined);
    await settle();

    expect(firstContext.signal.aborted).toBe(true);
    expect(scheduler.getTask(paused.id)?.status).toBe("queued");
    expect(scheduler.getTask(other.id)?.status).toBe("succeeded");
    expect(scheduler.getSnapshot().pausedTaskGroups).toEqual([group]);
    expect(scheduler.getSnapshot().pausedSourceIds).toEqual([]);
    expect(attempts).toBe(1);

    scheduler.resumeTaskGroup(group);
    await settle();
    await paused.promise;
    expect(attempts).toBe(2);
    expect(scheduler.getSnapshot().pausedTaskGroups).toEqual([]);
  });

  it("keeps group pause independent from source and global pause", async () => {
    scheduler.pauseTaskGroup("downloads");
    scheduler.pauseSourceQueue(source.id);
    const completed: string[] = [];
    const handle = enqueue("chapter.download", async () => { completed.push("download"); });
    scheduler.resumeTaskGroup("downloads");
    await settle();
    expect(completed).toEqual([]);

    scheduler.pauseTaskGroup("downloads");
    scheduler.resumeSourceQueue(source.id);
    await settle();
    expect(completed).toEqual([]);

    scheduler.pauseSourceQueue();
    scheduler.resumeTaskGroup("downloads");
    await settle();
    expect(completed).toEqual([]);
    scheduler.resumeSourceQueue();
    await settle();
    await handle.promise;
    expect(completed).toEqual(["download"]);
  });

  it("gates queued main aggregates while unrelated main work can start", async () => {
    scheduler.pauseTaskGroup("libraryUpdates");
    const completed: string[] = [];
    const check = scheduler.enqueueMain({
      kind: "library.checkUpdates", title: "Check for new chapters",
      run: async () => { completed.push("check"); },
    });
    const other = scheduler.enqueueMain({
      kind: "repository.refreshIndex", title: "Refresh repositories",
      run: async () => { completed.push("repository"); },
    });
    await settle();
    await other.promise;
    expect(completed).toEqual(["repository"]);
    expect(scheduler.getTask(check.id)?.status).toBe("queued");
    scheduler.resumeTaskGroup("libraryUpdates");
    await settle();
    await check.promise;
    expect(completed).toEqual(["repository", "check"]);
  });

  it("keeps a running main aggregate waiting for its paused child", async () => {
    let childId = "";
    let attempts = 0;
    const aggregate = scheduler.enqueueMain({
      kind: "library.checkUpdates", title: "Check for new chapters",
      run: async () => {
        const child = enqueue("source.checkLibraryUpdates", context => {
          attempts += 1;
          if (attempts > 1) return Promise.resolve();
          return new Promise<void>((_resolve, reject) => {
            context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
          });
        });
        childId = child.id;
        await child.promise;
      },
    });
    void aggregate.promise.catch(() => undefined);
    await settle();
    scheduler.pauseTaskGroup("libraryUpdates");
    await settle();
    expect(scheduler.getTask(aggregate.id)?.status).toBe("running");
    expect(scheduler.getTask(childId)?.status).toBe("queued");
    const download = enqueue("chapter.download", async () => undefined);
    await settle();
    await download.promise;
    scheduler.resumeTaskGroup("libraryUpdates");
    await settle();
    await aggregate.promise;
    expect(scheduler.getTask(aggregate.id)?.status).toBe("succeeded");
  });

  it("pauses interactive search without preventing other UI browsing", async () => {
    scheduler.pauseTaskGroup("search");
    const completed: string[] = [];
    const search = scheduler.enqueueSource({
      kind: "source.globalSearch", title: "Search", priority: "user", source,
      run: async () => { completed.push("search"); },
    });
    const browse = scheduler.enqueueSource({
      kind: "source.openNovel", title: "Browse", priority: "interactive", source,
      run: async () => { completed.push("browse"); },
    });
    await settle();
    await browse.promise;
    expect(completed).toEqual(["browse"]);
    expect(scheduler.getTask(search.id)?.status).toBe("queued");
    scheduler.resumeTaskGroup("search");
    await settle();
    await search.promise;
    expect(completed).toEqual(["browse", "search"]);
  });

  it("runs only the verification canary through a paused group and keeps it running", async () => {
    const scopeKey = "plugin:source:site:source.test";
    let attempts = 0;
    let verificationContext!: TaskRunContext;
    let finish!: () => void;
    const challenged = scheduler.enqueueSource({
      kind: "chapter.download", title: "Challenged download", source,
      priority: "background", sourceAccessScopeKey: scopeKey,
      canCompleteWithoutSourceAccess: true,
      run: async context => {
        if (!context.tryStartSourceAccess?.()) return;
        attempts += 1;
        if (attempts === 1) {
          throw new SourceAccessRequiredError("Complete the challenge.", {
            kind: "captcha", url: "https://source.test/chapter/1",
          });
        }
        verificationContext = context;
        await new Promise<void>(resolve => { finish = resolve; });
        expect(context.confirmSourceAccess?.()).toBe(true);
      },
    });
    void challenged.promise.catch(() => undefined);
    await settle();
    scheduler.pauseTaskGroup("downloads");
    const sibling = enqueue("chapter.download", async () => undefined);
    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(true);
    await settle();
    expect(verificationContext.sourceAccessVerification).toBe(true);
    scheduler.resumeTaskGroup("downloads");
    scheduler.pauseTaskGroup("downloads");
    expect(verificationContext.signal.aborted).toBe(false);
    finish();
    await challenged.promise;
    await settle();
    expect(scheduler.getSnapshot().sourceAccessBlocks).toEqual([]);
    expect(scheduler.getTask(sibling.id)?.status).toBe("queued");
    scheduler.resumeTaskGroup("downloads");
    await settle();
    await sibling.promise;
  });

  it("preserves interactive site verification while a group is paused", async () => {
    scheduler.pauseTaskGroup("downloads");
    const completed: string[] = [];
    const verification = scheduler.enqueueSource({
      kind: "source.openSite", title: "Verify source", priority: "interactive", source,
      run: async () => { completed.push("verification"); },
    });
    await settle();
    await verification.promise;
    expect(completed).toEqual(["verification"]);
  });
});
