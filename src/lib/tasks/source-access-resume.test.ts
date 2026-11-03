import { describe, expect, it } from "vitest";
import { SourceAccessRequiredError } from "../plugins/source-access";
import { TaskScheduler, type SourceTaskKind } from "./scheduler";

const SCOPE_KEY = "plugin:source-a:site:source.test";

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

/**
 * A browse request that meets an access check on its first run and succeeds
 * on the next, the way an interactive Source page, search or novel open does.
 */
function enqueueChallengedRequest(scheduler: TaskScheduler, kind: SourceTaskKind) {
  let runs = 0;
  const handle = scheduler.enqueueSource<string>({
    kind,
    priority: "interactive",
    title: kind,
    source: { id: "source-a", name: "Source A" },
    sourceAccessScopeKey: SCOPE_KEY,
    run: async (context) => {
      runs += 1;
      if (runs === 1) {
        throw new SourceAccessRequiredError("Complete the challenge.", {
          kind: "cloudflare",
          url: "https://source.test/list",
        });
      }
      context.confirmSourceAccess?.();
      return `${kind}:page-1`;
    },
  });
  let settled: "resolved" | "rejected" | null = null;
  handle.promise.then(
    () => { settled = "resolved"; },
    () => { settled = "rejected"; },
  );
  return { handle, runs: () => runs, settled: () => settled };
}

describe("verify in place and resume (RD13)", () => {
  it.each(["source.listPopular", "source.search", "source.globalSearch", "source.openNovel"] as const)(
    "holds a challenged %s and resolves that same request after verification",
    async (kind) => {
      const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
      const request = enqueueChallengedRequest(scheduler, kind);

      await settle();
      expect(request.settled()).toBeNull();
      expect(scheduler.getTask(request.handle.id)?.status).toBe("queued");
      expect(scheduler.getSnapshot().sourceAccessBlocks.map((block) => block.sourceId)).toEqual([
        "source-a",
      ]);

      expect(scheduler.beginSourceAccessVerification(SCOPE_KEY)).toBe(true);

      await expect(request.handle.promise).resolves.toBe(`${kind}:page-1`);
      expect(request.runs()).toBe(2);
      expect(scheduler.getSnapshot().sourceAccessBlocks).toEqual([]);
    },
  );

  it("keeps the request held when the browser closes without verification", async () => {
    const scheduler = new TaskScheduler({ sourceQueuesPaused: false });
    const request = enqueueChallengedRequest(scheduler, "source.listPopular");

    await settle();
    expect(scheduler.keepSourceAccessBlocked(SCOPE_KEY)).toBe(true);
    await settle();

    expect(request.settled()).toBeNull();
    expect(request.runs()).toBe(1);
    expect(scheduler.getSnapshot().sourceAccessBlocks).toHaveLength(1);
  });
});
