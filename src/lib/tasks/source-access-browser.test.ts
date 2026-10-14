import { afterEach, describe, expect, it } from "vitest";
import { useSiteBrowserStore } from "../../store/site-browser";
import { SourceAccessRequiredError } from "../plugins/source-access";
import { taskScheduler } from "./scheduler";
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

  it.each([false, true])("opens and retries the challenged profile on a shared hostname (restored: %s)", async (restored) => {
    const scopeKey = "site:source.test";
    let verified = false;
    let webtoonAttempts = 0;
    if (restored) {
      taskScheduler.hydrateSourceAccessBlocks([{
        challenge: { kind: "cloudflare", url: "https://source.test/webtoon/1" },
        detectedAt: 1,
        revision: 1,
        scopeKey,
        sourceId: "newtoki-webtoon",
        sourceIds: ["newtoki-novel", "newtoki-webtoon"],
        verificationRequested: false,
      }]);
    }
    const novel = taskScheduler.enqueueSource({
      kind: "source.refreshNovel",
      title: "Refresh novel",
      source: { id: "newtoki-novel", name: "Novel" },
      sourceAccessScopeKey: scopeKey,
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
      sourceIds: ["newtoki-novel", "newtoki-webtoon"],
    });
    if (!restored) expect(block!.originTaskId).toBe(webtoon.id);

    expect(await openSourceAccessBrowser(block!, {
      sourceName: "Novel, Webtoon",
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
