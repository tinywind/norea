import { describe, expect, it } from "vitest";
import { SourceAccessRequiredError, sourceAccessScopeKey } from "../plugins/source-access";
import { TaskScheduler, type TaskHandle } from "./scheduler";

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

describe("plugin download queue isolation", () => {
  it("keeps another plugin downloading on the same hostname during a challenge", async () => {
    const scheduler = new TaskScheduler({ sourceForegroundConcurrency: 2 });
    const handles: TaskHandle<void>[] = [];
    let otherAborted = false;
    let finishOther!: () => void;
    const first = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Novel chapter",
      source: { id: "novel", name: "Novel" },
      sourceAccessScopeKey: sourceAccessScopeKey("https://shared.test/novel/1", "novel"),
      run: async () => {
        throw new SourceAccessRequiredError("Complete the challenge", {
          kind: "cloudflare", url: "https://shared.test/novel/1",
        });
      },
    });
    const other = scheduler.enqueueSource({
      kind: "chapter.download",
      title: "Webtoon chapter",
      source: { id: "webtoon", name: "Webtoon" },
      sourceAccessScopeKey: sourceAccessScopeKey("https://shared.test/webtoon/1", "webtoon"),
      run: ({ signal }) => new Promise<void>((resolve, reject) => {
        finishOther = resolve;
        signal.addEventListener("abort", () => {
          otherAborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
    });
    handles.push(first, other);
    try {
      await settle();
      expect(scheduler.getTask(first.id)?.status).toBe("queued");
      expect(scheduler.getTask(other.id)?.status).toBe("running");
      expect(otherAborted).toBe(false);
      finishOther();
      await other.promise;

      const next = scheduler.enqueueSource({
        kind: "chapter.download",
        title: "Next webtoon chapter",
        source: { id: "webtoon", name: "Webtoon" },
        sourceAccessScopeKey: sourceAccessScopeKey("https://shared.test/webtoon/2", "webtoon"),
        run: async () => {},
      });
      handles.push(next);
      await next.promise;
      expect(scheduler.getSnapshot().sourceAccessBlocks).toHaveLength(1);
      expect(scheduler.getTask(first.id)?.status).toBe("queued");
    } finally {
      scheduler.cancelActiveTasks();
      await Promise.allSettled(handles.map(handle => handle.promise));
    }
  });

  it("verifies one plugin without releasing another plugin's challenge on the same hostname", async () => {
    const scheduler = new TaskScheduler({ sourceForegroundConcurrency: 2 });
    const verified = new Set<string>();
    const handles = ["novel", "webtoon"].map(sourceId => scheduler.enqueueSource({
      kind: "chapter.download",
      title: sourceId,
      source: { id: sourceId, name: sourceId },
      sourceAccessScopeKey: sourceAccessScopeKey(`https://shared.test/${sourceId}/1`, sourceId),
      run: async ({ confirmSourceAccess }) => {
        if (verified.has(sourceId)) {
          confirmSourceAccess?.();
          return;
        }
        throw new SourceAccessRequiredError("Complete the challenge", {
          kind: "captcha", url: `https://shared.test/${sourceId}/1`,
        });
      },
    }));
    try {
      await settle();
      expect(scheduler.getSnapshot().sourceAccessBlocks).toHaveLength(2);
      const novelBlock = scheduler.getSnapshot().sourceAccessBlocks.find(block => block.sourceId === "novel")!;
      verified.add("novel");
      expect(scheduler.beginSourceAccessVerification(novelBlock.scopeKey)).toBe(true);
      await handles[0]!.promise;
      expect(scheduler.getSnapshot().sourceAccessBlocks.map(block => block.sourceId)).toEqual(["webtoon"]);
      expect(scheduler.getTask(handles[1]!.id)?.status).toBe("queued");
    } finally {
      scheduler.cancelActiveTasks();
      await Promise.allSettled(handles.map(handle => handle.promise));
    }
  });
});
