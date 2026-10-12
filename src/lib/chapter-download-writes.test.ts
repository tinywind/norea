import { describe, expect, it, vi } from "vitest";
import {
  waitForChapterDownloadWrites,
  withChapterDownloadDeletion,
  withChapterDownloadWrite,
} from "./chapter-download-writes";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("chapter download writes", () => {
  it("blocks new writes only for chapters being deleted", async () => {
    const remove = deferred<void>();
    const events: string[] = [];
    const deletion = withChapterDownloadDeletion([42], async () => {
      events.push("delete-start");
      await remove.promise;
      events.push("delete-end");
    });
    const selectedWrite = withChapterDownloadWrite(42, undefined, async () => {
      events.push("selected-write");
    });
    const otherWrite = withChapterDownloadWrite(43, undefined, async () => {
      events.push("other-write");
    });

    expect(events).toEqual(["delete-start", "other-write"]);
    await waitForChapterDownloadWrites([42]);
    remove.resolve();

    await Promise.all([deletion, selectedWrite, otherWrite]);
    expect(events).toEqual([
      "delete-start", "other-write", "delete-end", "selected-write",
    ]);
  });

  it("waits for overlapping deletions without serializing their callbacks", async () => {
    const firstRemove = deferred<void>();
    const secondRemove = deferred<void>();
    const events: string[] = [];
    const firstDeletion = withChapterDownloadDeletion([42], async () => {
      events.push("first-delete");
      await firstRemove.promise;
    });
    const write = withChapterDownloadWrite(42, undefined, async () => {
      events.push("write");
    });
    const secondDeletion = withChapterDownloadDeletion([42], async () => {
      events.push("second-delete");
      await secondRemove.promise;
    });

    expect(events).toEqual(["first-delete", "second-delete"]);
    firstRemove.resolve();
    await firstDeletion;
    await withChapterDownloadWrite(43, undefined, async () => undefined);
    expect(events).toEqual(["first-delete", "second-delete"]);

    secondRemove.resolve();
    await Promise.all([secondDeletion, write]);
    expect(events).toEqual(["first-delete", "second-delete", "write"]);
  });

  it("releases blocked writes when deletion fails", async () => {
    const remove = deferred<void>();
    const error = new Error("Deletion failed");
    const deletion = withChapterDownloadDeletion([42, 43], () => remove.promise);
    const failed = expect(deletion).rejects.toBe(error);
    const files: number[] = [];
    const writes = [42, 43].map((chapterId) =>
      withChapterDownloadWrite(chapterId, undefined, async () => {
        files.push(chapterId);
      }),
    );
    expect(files).toEqual([]);

    remove.reject(error);

    await Promise.all([failed, ...writes]);
    expect(files).toEqual([42, 43]);
  });

  it("does not run a blocked write cancelled before deletion completes", async () => {
    const remove = deferred<void>();
    const controller = new AbortController();
    const deletion = withChapterDownloadDeletion([42], () => remove.promise);
    const files: string[] = [];
    const write = withChapterDownloadWrite(42, controller.signal, async () => {
      files.push("chapter");
    });
    const cancelled = expect(write).rejects.toMatchObject({ name: "AbortError" });

    controller.abort();
    remove.resolve();

    await Promise.all([deletion, cancelled]);
    expect(files).toEqual([]);
  });

  it("rejects late download writes without waiting for the network response", async () => {
    const response = deferred<string>();
    const controller = new AbortController();
    const files: string[] = [];
    const download = response.promise.then((body) =>
      withChapterDownloadWrite(42, controller.signal, async () => {
        files.push(body);
      }),
    );
    const cancelled = expect(download).rejects.toMatchObject({ name: "AbortError" });

    controller.abort();
    await waitForChapterDownloadWrites([42]);
    response.resolve("late chapter");

    await cancelled;
    expect(files).toEqual([]);
  });

  it("waits for a cancelled local write before deletion without blocking other chapters", async () => {
    const localWrite = deferred<void>();
    const controller = new AbortController();
    const events: string[] = [];
    const write = withChapterDownloadWrite(42, controller.signal, async () => {
      await localWrite.promise;
      events.push("write");
    });
    const cancelled = expect(write).rejects.toMatchObject({ name: "AbortError" });

    controller.abort();
    const deletion = waitForChapterDownloadWrites([42]).then(() => {
      events.push("delete");
    });
    await waitForChapterDownloadWrites([43]);
    expect(events).toEqual([]);

    localWrite.resolve();
    await Promise.all([cancelled, deletion]);
    expect(events).toEqual(["write", "delete"]);
  });

  it("drains every active write for a selected chapter", async () => {
    const firstWrite = deferred<void>();
    const secondWrite = deferred<void>();
    const first = withChapterDownloadWrite(42, undefined, () => firstWrite.promise);
    const second = withChapterDownloadWrite(42, undefined, () => secondWrite.promise);
    const deletion = vi.fn();
    const waiting = waitForChapterDownloadWrites([42]).then(deletion);

    firstWrite.resolve();
    await first;
    expect(deletion).not.toHaveBeenCalled();

    secondWrite.resolve();
    await Promise.all([second, waiting]);
    expect(deletion).toHaveBeenCalledOnce();
  });

  it("releases failed writes while preserving the write error", async () => {
    const localWrite = deferred<void>();
    const error = new Error("Storage failed");
    const write = withChapterDownloadWrite(42, undefined, () => localWrite.promise);
    const failed = expect(write).rejects.toBe(error);
    const waiting = waitForChapterDownloadWrites([42]);

    localWrite.reject(error);

    await Promise.all([failed, waiting]);
    await waitForChapterDownloadWrites([42]);
  });
});
