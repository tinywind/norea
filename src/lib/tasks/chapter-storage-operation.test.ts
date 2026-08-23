import { describe, expect, it } from "vitest";
import {
  runExclusiveChapterStorageOperation,
  waitForChapterStorageOperation,
} from "./chapter-storage-operation";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("chapter storage operation coordination", () => {
  it("blocks only overlapping source storage work", async () => {
    const started = deferred();
    const finish = deferred();
    const exclusive = runExclusiveChapterStorageOperation(
      { kind: "sources", sourceIds: ["source-a"] },
      undefined,
      async () => {
        started.resolve();
        await finish.promise;
      },
    );
    await started.promise;

    let overlappingReady = false;
    const overlapping = waitForChapterStorageOperation("source-a").then(() => {
      overlappingReady = true;
    });

    await waitForChapterStorageOperation("source-b");
    expect(overlappingReady).toBe(false);

    finish.resolve();
    await Promise.all([exclusive, overlapping]);
    expect(overlappingReady).toBe(true);
  });

  it("does not let later work bypass a queued exclusive operation", async () => {
    const finishFirst = deferred();
    const firstStarted = deferred();
    const first = runExclusiveChapterStorageOperation(
      { kind: "all" },
      undefined,
      async () => {
        firstStarted.resolve();
        await finishFirst.promise;
      },
    );
    await firstStarted.promise;

    const finishSecond = deferred();
    const secondStarted = deferred();
    const second = runExclusiveChapterStorageOperation(
      { kind: "sources", sourceIds: ["source-a"] },
      undefined,
      async () => {
        secondStarted.resolve();
        await finishSecond.promise;
      },
    );
    let laterReady = false;
    const later = waitForChapterStorageOperation("source-a").then(() => {
      laterReady = true;
    });

    finishFirst.resolve();
    await first;
    await secondStarted.promise;
    expect(laterReady).toBe(false);

    finishSecond.resolve();
    await Promise.all([second, later]);
    expect(laterReady).toBe(true);
  });

  it("removes an aborted waiter", async () => {
    const finish = deferred();
    const started = deferred();
    const exclusive = runExclusiveChapterStorageOperation(
      { kind: "sources", sourceIds: ["source-a"] },
      undefined,
      async () => {
        started.resolve();
        await finish.promise;
      },
    );
    await started.promise;

    const controller = new AbortController();
    const waiting = waitForChapterStorageOperation(
      "source-a",
      controller.signal,
    );
    controller.abort(new DOMException("Cancelled.", "AbortError"));

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    finish.resolve();
    await exclusive;
    await waitForChapterStorageOperation("source-a");
  });

  it("removes an aborted exclusive request", async () => {
    const finish = deferred();
    const started = deferred();
    const first = runExclusiveChapterStorageOperation(
      { kind: "sources", sourceIds: ["source-a"] },
      undefined,
      async () => {
        started.resolve();
        await finish.promise;
      },
    );
    await started.promise;

    const controller = new AbortController();
    let secondStarted = false;
    const second = runExclusiveChapterStorageOperation(
      { kind: "sources", sourceIds: ["source-a"] },
      controller.signal,
      async () => {
        secondStarted = true;
      },
    );
    controller.abort(new DOMException("Cancelled.", "AbortError"));

    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(secondStarted).toBe(false);
    finish.resolve();
    await first;
    await waitForChapterStorageOperation("source-a");
  });
});
