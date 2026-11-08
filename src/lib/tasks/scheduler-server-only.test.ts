import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourceAccessRequiredError } from "../plugins/source-access";
import { ChapterStorageError } from "../chapter-storage-error";
import { ChapterMediaIncompleteError } from "../chapter-media/errors";
import { ContentServerError, ContentServerTransportError } from "../content-sync/client";
import { TaskScheduler, type SourceTaskSpec } from "./scheduler";

const source = { id: "source-a", name: "Source A" };
let scheduler: TaskScheduler;
const settle = () => vi.advanceTimersByTimeAsync(0);
const server = (run: SourceTaskSpec<void>["run"]): SourceTaskSpec<void> => ({
  kind: "chapter.download", title: "Server chapter", source, serverLane: true,
  canCompleteWithoutSourceAccess: true,
  run: async context => {
    context.setChapterDownloadPhase?.("server-lookup");
    await run(context);
    context.setChapterDownloadPhase?.("server-download");
  },
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

it("does not offer a server-first download as a source verification candidate", async () => {
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

it("defers a missing server body to the existing source route before allowing source access", async () => {
  const attempts: Array<{ executor?: string; started: boolean }> = [];
  const copy = scheduler.enqueueSource(server(async context => {
    attempts.push({ executor: context.executor, started: context.tryStartSourceAccess!() });
  }));
  await settle(); await copy.promise;
  expect(attempts).toEqual([{ executor: "server:0", started: false }, { executor: "pool:0", started: true }]);
});

it.each(["manual", "storage"])("retains the %s pause for server-first downloads", async kind => {
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

it.each(["queued", "running"])("shares a %s server-first chapter task without creating another route", async status => {
  let finish!: () => void;
  scheduler.setBackgroundExecutionSuspended(status === "queued");
  const run = vi.fn(async () => new Promise<void>(resolve => { finish = resolve; }));
  const original = scheduler.enqueueSource({ ...server(run), dedupeKey: "chapter.download:7" });
  void original.promise.catch(() => undefined);
  await settle();
  const replacementRun = vi.fn(async () => undefined);
  const duplicate = scheduler.enqueueSource({ ...server(replacementRun), dedupeKey: "chapter.download:7" });
  expect(duplicate.id).toBe(original.id);
  expect(scheduler.getTask(original.id)?.status).toBe(status);
  expect(replacementRun).not.toHaveBeenCalled();
  if (status === "running") { finish(); await settle(); await original.promise; }
});

it("finishes a server hit during source verification without confirming the source challenge", async () => {
  const scopeKey = "plugin:source-a:site:source.test";
  scheduler.hydrateSourceAccessBlocks([{ sourceId: source.id, scopeKey, revision: 7, detectedAt: 10,
    challenge: { kind: "forbidden", url: "https://source.test" }, verificationRequested: false }]);
  let attempts = 0;
  const copy = scheduler.enqueueSource({ ...server(async context => {
    attempts++;
    if (attempts === 1) context.tryStartSourceAccess!();
    else expect(context.sourceAccessVerification).toBe(true);
  }), sourceAccessScopeKey: scopeKey });
  await settle();
  expect(scheduler.getTask(copy.id)?.status).toBe("queued");
  expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(true);
  await settle(); await copy.promise;
  expect(attempts).toBe(2);
  expect(scheduler.getSourceAccessBlock(scopeKey)?.challenge.kind).toBe("forbidden");
  expect(scheduler.getSourceAccessBlock(scopeKey)?.verificationTaskId).toBeUndefined();
});

it.each(["chapter.download", "chapter.repairMedia"] as const)(
  "finishes %s local verification after a server hit without consuming a source challenge",
  async kind => {
    const scopeKey = "plugin:source-a:site:source.test";
    let attempts = 0;
    let serverAvailable = false;
    const copy = scheduler.enqueueSource({
      kind, title: "Local server verification", source, serverLane: true,
      canCompleteWithoutSourceAccess: true, sourceAccessScopeKey: scopeKey,
      run: async context => {
        attempts++;
        context.setChapterDownloadPhase?.("server-lookup");
        if (!serverAvailable) {
          if (!context.tryStartSourceAccess?.()) return;
          context.setChapterDownloadPhase?.("source-download");
          throw new SourceAccessRequiredError("Complete source verification.", {
            kind: "forbidden", url: "https://source.test/chapter",
          });
        }
        expect(context.sourceAccessVerification).toBe(true);
        context.setChapterDownloadPhase?.("local");
      },
    });
    void copy.promise.catch(() => undefined);
    await settle();
    expect(scheduler.getTask(copy.id)?.status).toBe("queued");
    expect(scheduler.getSourceAccessBlock(scopeKey)?.originTaskId).toBe(copy.id);
    const previousAttempts = attempts;
    serverAvailable = true;
    expect(scheduler.beginSourceAccessVerification(scopeKey)).toBe(true);
    await settle();
    expect(attempts).toBe(previousAttempts + 1);
    expect(scheduler.getTask(copy.id)).toMatchObject({ status: "succeeded", chapterDownloadPhase: "local" });
    expect(scheduler.getSourceAccessBlock(scopeKey)?.challenge.kind).toBe("forbidden");
    expect(scheduler.getSourceAccessBlock(scopeKey)?.verificationTaskId).toBeUndefined();
    expect(scheduler.getDownloadFailureStops()).toEqual({ sourceErrors: {} });
  },
);

it.each([
  new ContentServerError(500),
  new ContentServerTransportError(),
  new ChapterMediaIncompleteError([{ status: 404, message: "Content server asset missing (HTTP 404).", url: "https://content.test/asset" }]),
])("keeps a server-origin failure outside source holds after local finalization", async failure => {
  const report = vi.spyOn(scheduler, "reportDownloadFailure");
  const copy = scheduler.enqueueSource({
    kind: "chapter.repairMedia", title: "Server media repair", source, serverLane: true,
    canCompleteWithoutSourceAccess: true,
    run: async context => {
      context.setChapterDownloadPhase?.("server-lookup");
      context.setChapterDownloadPhase?.("server-download");
      context.setChapterDownloadPhase?.("local");
      throw failure;
    },
  });
  const outcome = copy.promise.catch(error => error);
  await settle();
  expect(await outcome).toBe(failure);
  expect(scheduler.getTask(copy.id)?.status).toBe("failed");
  expect(report).not.toHaveBeenCalled();
  expect(scheduler.getDownloadFailureStops()).toEqual({ sourceErrors: {} });
  expect(scheduler.getSnapshot().sourceAccessBlocks).toEqual([]);
});

it("keeps global storage failure protection during local server finalization", async () => {
  const failure = new ChapterStorageError("Finalize media", new Error("Disk is full"));
  const copy = scheduler.enqueueSource({
    kind: "chapter.repairMedia", title: "Server media repair", source, serverLane: true,
    canCompleteWithoutSourceAccess: true,
    run: async context => {
      context.setChapterDownloadPhase?.("server-download");
      context.setChapterDownloadPhase?.("local");
      throw failure;
    },
  });
  const outcome = copy.promise.catch(error => error);
  await settle();
  expect(await outcome).toBe(failure);
  expect(scheduler.getDownloadFailureStops()).toMatchObject({
    globalError: expect.stringContaining("Disk is full"), sourceErrors: {},
  });
});

it.each([false, true])("keeps source failures after actual source admission (display phase: %s)", async displaySource => {
  const failure = new Error("Source parsing failed");
  let attempts = 0;
  const copy = scheduler.enqueueSource({
    kind: "chapter.download", title: "Source fallback", source, serverLane: true,
    canCompleteWithoutSourceAccess: true,
    run: async context => {
      attempts++;
      context.setChapterDownloadPhase?.("server-lookup");
      if (!context.tryStartSourceAccess?.()) return;
      if (displaySource) context.setChapterDownloadPhase?.("source-download");
      context.setChapterDownloadPhase?.("local");
      throw failure;
    },
  });
  const outcome = copy.promise.catch(error => error);
  await settle();
  expect(attempts).toBe(2);
  expect(await outcome).toBe(failure);
  expect(scheduler.getDownloadFailureStops().sourceErrors).toEqual({ "source-a": "Source parsing failed" });
});

it("replaces an earlier source attempt origin when a retry finds server content", async () => {
  const failure = new ContentServerTransportError("Server transfer interrupted after retry");
  const report = vi.spyOn(scheduler, "reportDownloadFailure");
  let attempts = 0;
  const copy = scheduler.enqueueSource({
    kind: "chapter.download", title: "Server content after retry", source, serverLane: true,
    canCompleteWithoutSourceAccess: true,
    run: async context => {
      attempts++;
      context.setChapterDownloadPhase?.("server-lookup");
      if (!context.tryStartSourceAccess?.()) return;
      context.setChapterDownloadPhase?.("source-download");
      context.setChapterDownloadPhase?.("server-lookup");
      context.setChapterDownloadPhase?.("server-download");
      context.setChapterDownloadPhase?.("local");
      throw failure;
    },
  });
  const outcome = copy.promise.catch(error => error);
  await settle();
  expect(attempts).toBe(2);
  expect(await outcome).toBe(failure);
  expect(report).not.toHaveBeenCalled();
  expect(scheduler.getDownloadFailureStops()).toEqual({ sourceErrors: {} });
});
