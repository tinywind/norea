import { afterEach, describe, expect, it, vi } from "vitest";
import { useSiteBrowserStore } from "../../store/site-browser";
import { SourceAccessRequiredError } from "../plugins/source-access";
import { taskScheduler, type SourceAccessBlock } from "./scheduler";
import { applyTaskNotificationAction } from "./task-notification-actions";
import { openSourceAccessBrowser } from "./source-access-coordinator";

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe("source access browser profile", () => {
  afterEach(async () => {
    taskScheduler.cancelActiveTasks();
    useSiteBrowserStore.getState().hide();
    await settle();
    taskScheduler.hydrateSourceAccessBlocks([]);
  });

  it("switches verification between plugins without releasing either source gate", async () => {
    const makeDownload = (sourceId: string) => taskScheduler.enqueueSource({
      kind: "source.refreshNovel", title: sourceId, source: { id: sourceId, name: sourceId },
      sourceAccessScopeKey: `plugin:${sourceId}:site:source.test`,
      run: async () => { throw new SourceAccessRequiredError("Verification required", { kind: "captcha", url: "https://source.test/chapter/1" }); },
    });
    const first = makeDownload("notification-a");
    const second = makeDownload("notification-b");
    const completion = Promise.allSettled([first.promise, second.promise]);
    await settle();
    const blocks = taskScheduler.getSnapshot().sourceAccessBlocks;
    const a = blocks.find(block => block.sourceId === "notification-a")!;
    const b = blocks.find(block => block.sourceId === "notification-b")!;
    expect(await openSourceAccessBrowser(a, {sourceName:"A",title:"Verify A"})).toBe(true);
    await settle();
    expect(await openSourceAccessBrowser(b, {sourceName:"B",title:"Verify B"})).toBe(true);
    expect(useSiteBrowserStore.getState().sourceId).toBe("notification-b");
    expect(taskScheduler.getSnapshot().sourceAccessBlocks).toHaveLength(2);
    taskScheduler.cancelActiveTasks();
    useSiteBrowserStore.getState().hide();
    await completion;
  });

  it.each(["verifySource", "openTasks"] as const)("discards a deferred source URL when a newer %s tap arrives", async type => {
    const a: SourceAccessBlock = {
      sourceId: "deferred-a", scopeKey: "plugin:deferred-a:site:source.test", revision: 1, detectedAt: 1,
      challenge: { kind: "captcha", url: "https://source.test" }, challengeUrlRedacted: true,
      verificationRequested: false,
    };
    const b: SourceAccessBlock = { ...a, sourceId: "deferred-b", scopeKey: "plugin:deferred-b:site:source.test" };
    taskScheduler.hydrateSourceAccessBlocks([a, b]);
    let releaseA!: (url: string) => void;
    const targetA = new Promise<string>(resolve => { releaseA = resolve; });
    const resolveA = vi.fn(() => targetA);
    const makeTask = (block: SourceAccessBlock, resolve: () => string | Promise<string>) => taskScheduler.enqueueSource({
      kind: "source.refreshNovel", title: block.sourceId, source: { id: block.sourceId, name: block.sourceId },
      sourceAccessScopeKey: block.scopeKey, resolveSourceAccessUrl: resolve, run: async () => undefined,
    });
    const tasks = [makeTask(a, resolveA), makeTask(b, () => "https://source.test/b/chapter/33")];
    const completion = Promise.allSettled(tasks.map(task => task.promise));
    const shown: string[] = [];
    const unsubscribe = useSiteBrowserStore.subscribe(state => {
      if (state.visible && state.sourceId) shown.push(state.sourceId);
    });
    const t = ((key: string) => key) as Parameters<typeof applyTaskNotificationAction>[2];
    try {
      const older = applyTaskNotificationAction({ type: "verifySource", sourceId: a.sourceId, scopeKey: a.scopeKey, revision: 1 }, vi.fn(), t);
      await vi.waitFor(() => expect(resolveA).toHaveBeenCalledOnce());
      const newer = applyTaskNotificationAction(type === "openTasks" ? { type } : {
        type, sourceId: b.sourceId, scopeKey: b.scopeKey, revision: 1,
      }, vi.fn(), t);
      await settle();
      releaseA("https://source.test/a/chapter/31");
      await Promise.all([older, newer]);
      expect(shown).not.toContain(a.sourceId);
      if (type === "openTasks") expect(useSiteBrowserStore.getState().visible).toBe(false);
      else expect(useSiteBrowserStore.getState()).toMatchObject({ sourceId: b.sourceId, currentUrl: "https://source.test/b/chapter/33", visible: true });
    } finally {
      releaseA("https://source.test/a/chapter/31");
      unsubscribe();
      taskScheduler.cancelActiveTasks();
      useSiteBrowserStore.getState().hide();
      await completion;
    }
  });

  it.each([false, true])("opens and retries the challenged profile on a shared hostname (restored: %s)", async (restored) => {
    const scopeKey = "plugin:newtoki-webtoon:site:source.test";
    let verified = false;
    let webtoonAttempts = 0;
    if (restored) {
      taskScheduler.hydrateSourceAccessBlocks([{
        challenge: { kind: "cloudflare", url: "https://source.test/webtoon/1" },
        detectedAt: 1,
        revision: 1,
        scopeKey,
        sourceId: "newtoki-webtoon",
        verificationRequested: false,
      }]);
    }
    const novel = taskScheduler.enqueueSource({
      kind: "source.refreshNovel",
      title: "Refresh novel",
      source: { id: "newtoki-novel", name: "Novel" },
      sourceAccessScopeKey: "plugin:newtoki-novel:site:source.test",
      run: ({ signal }) => {
        if (verified) return Promise.resolve();
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const webtoon = taskScheduler.enqueueSource({
      kind: "source.refreshNovel",
      title: "Refresh webtoon",
      source: { id: "newtoki-webtoon", name: "Webtoon" },
      sourceAccessScopeKey: scopeKey,
      run: async (context) => {
        webtoonAttempts += 1;
        if (verified) {
          context.confirmSourceAccess?.();
          return;
        }
        throw new SourceAccessRequiredError("Verification required", {
          kind: "cloudflare",
          url: "https://source.test/webtoon/1",
        });
      },
    });
    const completion = Promise.allSettled([novel.promise, webtoon.promise]);
    await settle();
    const [block] = taskScheduler.getSnapshot().sourceAccessBlocks;
    expect(block).toMatchObject({
      sourceId: "newtoki-webtoon",
    });
    if (!restored) expect(block!.originTaskId).toBe(webtoon.id);
    expect(taskScheduler.getTask(novel.id)?.status).toBe("running");

    expect(await openSourceAccessBrowser(block!, {
      sourceName: "Webtoon",
      title: "Verify access",
    })).toBe(true);
    try {
      expect(useSiteBrowserStore.getState()).toMatchObject({
        sourceId: "newtoki-webtoon",
        currentUrl: "https://source.test/webtoon/1",
      });
      verified = true;
      const browserTaskId = useSiteBrowserStore.getState().taskId!;
      useSiteBrowserStore.getState().markReady(browserTaskId);
      useSiteBrowserStore.getState().complete(browserTaskId, block!.revision, "verify");
      await webtoon.promise;
      expect(webtoonAttempts).toBe(restored ? 1 : 2);
      expect(taskScheduler.getSnapshot().sourceAccessBlocks).toEqual([]);
    } finally {
      taskScheduler.cancelActiveTasks();
      await completion;
    }
  });
});
