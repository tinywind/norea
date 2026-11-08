import { afterEach, describe, expect, it, vi } from "vitest";
import { useSiteBrowserStore } from "../../store/site-browser";
import { TaskScheduler, taskScheduler, type SourceAccessBlock, type TaskRunContext } from "./scheduler";
import { applySourceAccessBrowserOutcome, openSourceAccessBrowser } from "./source-access-coordinator";

const source = { id: "source-a", name: "Source A" };
const scopeKey = "plugin:source-a:site:source.test";
const schedulers: TaskScheduler[] = [];

function block(overrides: Partial<SourceAccessBlock> = {}): SourceAccessBlock {
  return {
    sourceId: source.id, scopeKey, revision: 7, detectedAt: 10,
    challenge: { kind: "forbidden", url: "https://source.test" },
    challengeUrlRedacted: true, verificationRequested: false, ...overrides,
  };
}

function schedulerWith(blocks = [block()]) {
  const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
  schedulers.push(scheduler);
  scheduler.hydrateSourceAccessBlocks(blocks);
  return scheduler;
}

async function settle() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

async function finishBrowser(outcome: "verify" | "keep-paused") {
  const state = useSiteBrowserStore.getState();
  expect(state.context?.mode).toBe("source-access");
  const context = state.context!;
  if (context.mode !== "source-access") throw new Error("Expected an access browser.");
  state.markReady(state.taskId!);
  expect(useSiteBrowserStore.getState().complete(state.taskId!, context.revision, outcome)).toBe(true);
  await settle();
}

afterEach(async () => {
  for (const scheduler of [...schedulers, taskScheduler]) {
    scheduler.cancelActiveTasks({ discardQueued: true });
    scheduler.hydrateSourceAccessBlocks([]);
    scheduler.hydrateDownloadFailureStops({ sourceErrors: {} });
    scheduler.setNetworkAvailable(true);
    scheduler.setBackgroundExecutionSuspended(false);
  }
  schedulers.length = 0;
  useSiteBrowserStore.getState().hide();
  await settle();
});

describe("source verification without queued work", () => {
  it("opens a restored source browser without a download or authentication probe", async () => {
    const current = block();
    taskScheduler.hydrateSourceAccessBlocks([current]);
    expect(taskScheduler.canBeginSourceAccessVerification(scopeKey)).toBe(false);
    expect(taskScheduler.canOpenSourceAccessBrowser(scopeKey)).toBe(true);

    expect(await openSourceAccessBrowser(current, { sourceName: source.name, title: "Verify access" })).toBe(true);
    await settle();

    expect(useSiteBrowserStore.getState()).toMatchObject({
      visible: true, sourceId: source.id, currentUrl: "https://source.test/",
      context: { scopeKey, revision: current.revision },
    });
    expect(taskScheduler.getSnapshot().records.map(record => record.kind)).toEqual(["source.openSite"]);
    expect(taskScheduler.getSourceAccessBlock(scopeKey)).toEqual(current);
    await finishBrowser("keep-paused");
    expect(taskScheduler.getSourceAccessBlock(scopeKey)).toEqual(current);
  });

  it("finishes and reopens a confirmation while waiting for an actual source response", async () => {
    const current = block();
    const sibling = block({ sourceId: "source-b", scopeKey: "plugin:source-b:site:source.test", revision: 8 });
    taskScheduler.hydrateSourceAccessBlocks([current, sibling]);
    expect(await openSourceAccessBrowser(current, { sourceName: source.name, title: "Verify access" })).toBe(true);
    expect(taskScheduler.beginSourceAccessVerification(scopeKey, { waitForTask: true })).toBe(true);
    await finishBrowser("verify");
    expect(taskScheduler.getSourceAccessBlock(scopeKey)).toMatchObject({
      revision: current.revision, verificationRequested: true, challengeUrlRedacted: true,
    });
    expect(taskScheduler.getSourceAccessBlock(scopeKey)?.verificationTaskId).toBeUndefined();
    expect(taskScheduler.getSnapshot().records.every(record => record.kind === "source.openSite")).toBe(true);

    expect(await openSourceAccessBrowser(current, { sourceName: source.name, title: "Verify access" })).toBe(true);
    expect(taskScheduler.beginSourceAccessVerification(scopeKey, { waitForTask: true })).toBe(true);
    await finishBrowser("verify");

    const siblingRun = vi.fn(async () => undefined);
    const siblingTask = taskScheduler.enqueueSource({
      kind: "source.refreshNovel", title: "Other source", source: { id: sibling.sourceId, name: "Source B" },
      sourceAccessScopeKey: sibling.scopeKey, run: siblingRun,
    });
    void siblingTask.promise.catch(() => undefined);
    let finish!: () => void;
    let context!: TaskRunContext;
    const request = taskScheduler.enqueueSource({
      kind: "source.refreshNovel", title: "Read the actual source", source, sourceAccessScopeKey: scopeKey,
      run: async currentContext => {
        context = currentContext;
        await new Promise<void>(resolve => { finish = resolve; });
        expect(currentContext.confirmSourceAccess?.()).toBe(true);
      },
    });
    await settle();
    expect(context.sourceAccessVerification).toBe(true);
    expect(context.executor).toBe("immediate");
    expect(taskScheduler.getSourceAccessBlock(scopeKey)?.verificationTaskId).toBe(request.id);
    expect(siblingRun).not.toHaveBeenCalled();

    finish();
    await request.promise;
    expect(taskScheduler.getSourceAccessBlock(scopeKey)).toBeUndefined();
    expect(taskScheduler.getSourceAccessBlock(sibling.scopeKey)).toEqual(sibling);
  });

  it("does not consume a future confirmation with cookie clearing or site opening", async () => {
    const scheduler = schedulerWith();
    expect(scheduler.beginSourceAccessVerification(scopeKey, { waitForTask: true })).toBe(true);
    for (const kind of ["source.clearCookies", "source.openSite"] as const) {
      const handle = scheduler.enqueueSource({
        kind, title: kind, priority: "user", source, sourceAccessScopeKey: scopeKey,
        canCompleteWithoutSourceAccess: kind === "source.clearCookies",
        run: async context => {
          expect(context.sourceAccessVerification).toBe(false);
        },
      });
      await handle.promise;
      expect(scheduler.getSourceAccessBlock(scopeKey)).toMatchObject({ verificationRequested: true });
      expect(scheduler.getSourceAccessBlock(scopeKey)?.verificationTaskId).toBeUndefined();
    }
  });

  it("withdraws a future confirmation when the browser is closed with keep paused", async () => {
    const current = block();
    taskScheduler.hydrateSourceAccessBlocks([current]);
    expect(taskScheduler.beginSourceAccessVerification(scopeKey, { waitForTask: true })).toBe(true);
    expect(await openSourceAccessBrowser(current, { sourceName: source.name, title: "Verify access" })).toBe(true);
    await finishBrowser("keep-paused");
    expect(taskScheduler.getSourceAccessBlock(scopeKey)).toMatchObject({ verificationRequested: false });
    expect(taskScheduler.getSourceAccessBlock(scopeKey)!.revision).toBeGreaterThan(current.revision);
    expect(applySourceAccessBrowserOutcome(taskScheduler, current, "verify")).toBe(false);

    const run = vi.fn(async () => undefined);
    const future = taskScheduler.enqueueSource({
      kind: "source.refreshNovel", title: "Still held", source, sourceAccessScopeKey: scopeKey, run,
    });
    void future.promise.catch(() => undefined);
    await settle();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not retain a waiting confirmation across a newer challenge revision", async () => {
    const current = block();
    const scheduler = schedulerWith([current]);
    expect(scheduler.beginSourceAccessVerification(scopeKey, { waitForTask: true })).toBe(true);
    const replacement = block({ revision: current.revision + 1 });
    scheduler.hydrateSourceAccessBlocks([replacement]);

    const run = vi.fn(async () => undefined);
    const future = scheduler.enqueueSource({
      kind: "source.refreshNovel", title: "New challenge", source, sourceAccessScopeKey: scopeKey, run,
    });
    void future.promise.catch(() => undefined);
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(applySourceAccessBrowserOutcome(scheduler, current, "verify")).toBe(false);
    expect(scheduler.getSourceAccessBlock(scopeKey)).toEqual(replacement);
  });

  it("prefers the exact queued URL and rejects stale results before using an origin fallback", async () => {
    const current = block();
    const scheduler = schedulerWith([current]);
    let resolveUrl!: (url: string) => void;
    const resolving = new Promise<string>(resolve => { resolveUrl = resolve; });
    const handle = scheduler.enqueueSource({
      kind: "source.refreshNovel", title: "Resolve actual source URL", source, sourceAccessScopeKey: scopeKey,
      resolveSourceAccessUrl: () => resolving, run: async () => undefined,
    });
    void handle.promise.catch(() => undefined);
    const target = scheduler.resolveSourceAccessBrowserUrl(scopeKey, current.revision);
    scheduler.hydrateSourceAccessBlocks([block({ revision: current.revision + 1 })]);
    resolveUrl("https://source.test/protected/chapter");
    await expect(target).resolves.toBeNull();

    await expect(scheduler.resolveSourceAccessBrowserUrl(scopeKey, current.revision + 1)).resolves.toMatchObject({
      revision: current.revision + 1, scopeKey, sourceId: source.id, url: "https://source.test/protected/chapter",
    });
    expect(scheduler.getTask(handle.id)?.status).toBe("queued");
    expect(scheduler.getSourceAccessBlock(scopeKey)?.verificationRequested).toBe(false);
  });

  it.each([1, 2])("never uses the ordinary fallback for VPN worker generation %i", async generation => {
    const current = block({
      rangeId: "range-a", workerGeneration: generation, scopeKey: scopeKey + ":range:range-a",
    });
    const scheduler = schedulerWith([current]);
    expect(scheduler.canOpenSourceAccessBrowser(current.scopeKey)).toBe(false);
    await expect(scheduler.resolveSourceAccessBrowserUrl(current.scopeKey, current.revision)).resolves.toBeNull();
    expect(scheduler.beginSourceAccessVerification(current.scopeKey, { waitForTask: true })).toBe(false);
    expect(scheduler.getSourceAccessBlock(current.scopeKey)).toEqual(current);
  });

  it("still resets a VPN verification when its queued worker is cancelled", async () => {
    const current = block({
      rangeId: "range-a", workerGeneration: 2, scopeKey: scopeKey + ":range:range-a",
    });
    const scheduler = schedulerWith([current]);
    let finish!: () => void;
    const busy = scheduler.enqueueSource({
      kind: "source.openSite", title: "Open another source", priority: "interactive",
      source: { id: "other", name: "Other" }, run: () => new Promise<void>(resolve => { finish = resolve; }),
    });
    await settle();
    const canary = scheduler.enqueueSource({
      kind: "chapter.download", title: "VPN canary", priority: "background", source,
      sourceAccessScopeKey: current.scopeKey, vpnWorker: { rangeId: "range-a", slot: 0, generation: 2 },
      run: async () => undefined,
    });
    void canary.promise.catch(() => undefined);
    expect(scheduler.beginSourceAccessVerification(current.scopeKey)).toBe(true);
    scheduler.cancel(canary.id);
    await Promise.allSettled([canary.promise]);
    finish();
    await busy.promise;
    await settle();
    expect(scheduler.getSourceAccessBlock(current.scopeKey)).toMatchObject({
      verificationRequested: false, workerGeneration: 2,
    });
    expect(scheduler.getSourceAccessBlock(current.scopeKey)?.verificationTaskId).toBeUndefined();
  });
});

describe("execution limits after a confirmation waits for work", () => {
  it.each(["offline", "background", "storage"] as const)("does not start a future download while %s", async reason => {
    const scheduler = schedulerWith();
    expect(scheduler.beginSourceAccessVerification(scopeKey, { waitForTask: true })).toBe(true);
    if (reason === "offline") scheduler.setNetworkAvailable(false);
    else if (reason === "background") scheduler.setBackgroundExecutionSuspended(true);
    else scheduler.hydrateDownloadFailureStops({ sourceErrors: {}, globalError: "Storage unavailable" });

    const run = vi.fn(async (context: TaskRunContext) => {
      expect(context.sourceAccessVerification).toBe(true);
      expect(context.confirmSourceAccess?.()).toBe(true);
    });
    const handle = scheduler.enqueueSource({
      kind: "chapter.download", title: "Future download", source, sourceAccessScopeKey: scopeKey, run,
    });
    void handle.promise.catch(() => undefined);
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(scheduler.getTask(handle.id)?.status).toBe("queued");
    expect(scheduler.getSourceAccessBlock(scopeKey)?.verificationTaskId).toBeUndefined();

    if (reason === "offline") scheduler.setNetworkAvailable(true);
    else if (reason === "background") scheduler.setBackgroundExecutionSuspended(false);
    else scheduler.resumeSourceQueue();
    await handle.promise;
    expect(run).toHaveBeenCalledOnce();
    expect(scheduler.getSourceAccessBlock(scopeKey)).toBeUndefined();
  });

  it("opens and verifies browsing while a storage failure still holds downloads", async () => {
    const current = block();
    taskScheduler.hydrateSourceAccessBlocks([current]);
    taskScheduler.hydrateDownloadFailureStops({ sourceErrors: {}, globalError: "Storage unavailable" });
    expect(taskScheduler.canOpenSourceAccessBrowser(scopeKey)).toBe(true);
    expect(await openSourceAccessBrowser(current, { sourceName: source.name, title: "Verify access" })).toBe(true);
    expect(taskScheduler.beginSourceAccessVerification(scopeKey, { waitForTask: true })).toBe(true);
    await finishBrowser("verify");

    const browse = taskScheduler.enqueueSource({
      kind: "source.listPopular", title: "Browse source", priority: "interactive", source,
      sourceAccessScopeKey: scopeKey, run: async context => {
        expect(context.sourceAccessVerification).toBe(true);
        expect(context.confirmSourceAccess?.()).toBe(true);
      },
    });
    await browse.promise;
    expect(taskScheduler.getSourceAccessBlock(scopeKey)).toBeUndefined();
    expect(taskScheduler.getDownloadFailureStops().globalError).toBe("Storage unavailable");
    expect(taskScheduler.getSnapshot().sourceQueuesPaused).toBe(true);
  });
});
