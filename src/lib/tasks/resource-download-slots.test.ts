import { describe, expect, it } from "vitest";
import { ResourceDownloadSlotScheduler } from "./resource-download-slots";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

describe("ResourceDownloadSlotScheduler", () => {
  it("moves freed background slots to queued foreground resources first", async () => {
    const scheduler = new ResourceDownloadSlotScheduler(() => 2);
    const order: string[] = [];
    const active = new Set<string>();
    const deferredByName = new Map<string, Deferred>();
    let maxActive = 0;

    const run = async (
      name: string,
      priority: "background" | "foreground",
    ): Promise<void> => {
      const lease = await scheduler.acquire({ priority });
      if (!lease) return;
      order.push(`${name}:start`);
      active.add(name);
      maxActive = Math.max(maxActive, active.size);
      const deferred = createDeferred();
      deferredByName.set(name, deferred);
      try {
        await deferred.promise;
        order.push(`${name}:finish`);
      } finally {
        active.delete(name);
        lease.release();
      }
    };

    const background = [
      run("background-1", "background"),
      run("background-2", "background"),
      run("background-3", "background"),
    ];
    await settle();
    expect(order).toEqual([
      "background-1:start",
      "background-2:start",
    ]);

    const foreground = [
      run("foreground-1", "foreground"),
      run("foreground-2", "foreground"),
    ];
    await settle();

    deferredByName.get("background-1")!.resolve();
    await settle();
    expect(active).toEqual(new Set(["background-2", "foreground-1"]));
    expect(order).not.toContain("background-3:start");

    deferredByName.get("background-2")!.resolve();
    await settle();
    expect(active).toEqual(new Set(["foreground-1", "foreground-2"]));
    expect(order).not.toContain("background-3:start");

    deferredByName.get("foreground-1")!.resolve();
    await settle();
    expect(active).toEqual(new Set(["foreground-2", "background-3"]));

    deferredByName.get("foreground-2")!.resolve();
    deferredByName.get("background-3")!.resolve();
    await Promise.all([...background, ...foreground]);

    expect(maxActive).toBe(2);
  });

  it("drops a queued background resource when its task has yielded", async () => {
    const scheduler = new ResourceDownloadSlotScheduler(() => 1);
    const activeLease = await scheduler.acquire({ priority: "background" });
    let shouldStart = true;
    const queuedLease = scheduler.acquire({
      priority: "background",
      shouldStart: () => shouldStart,
    });

    shouldStart = false;
    activeLease!.release();

    await expect(queuedLease).resolves.toBeNull();
  });
});
