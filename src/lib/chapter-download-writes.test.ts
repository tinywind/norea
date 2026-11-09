import { describe, expect, it, vi } from "vitest";
import {
  canAdoptChapterDownloadSnapshot,
  currentChapterDownloadRevision,
  waitForChapterDownloadWrites,
  withChapterDownloadDeletion,
  withChapterDownloadSnapshotReads,
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
  it("rejects snapshots overlapping a write while allowing unaffected chapters and later scans", async () => {
    const before = currentChapterDownloadRevision();
    const localWrite = deferred<void>();
    const write = withChapterDownloadWrite(42, undefined, () => localWrite.promise);
    const during = currentChapterDownloadRevision();
    expect(canAdoptChapterDownloadSnapshot(42, before)).toBe(false);
    expect(canAdoptChapterDownloadSnapshot(42, during)).toBe(false);
    expect(canAdoptChapterDownloadSnapshot(43, before)).toBe(true);

    localWrite.resolve();
    await write;

    expect(canAdoptChapterDownloadSnapshot(42, before)).toBe(false);
    expect(canAdoptChapterDownloadSnapshot(42, during)).toBe(false);
    expect(canAdoptChapterDownloadSnapshot(42, currentChapterDownloadRevision())).toBe(true);
  });

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
    const failed = expect(write).rejects.toMatchObject({ code: "chapter-storage-failed", cause: error });
    const waiting = waitForChapterDownloadWrites([42]);

    localWrite.reject(error);

    await Promise.all([failed, waiting]);
    await waitForChapterDownloadWrites([42]);
  });

  it("holds a snapshot until its entire callback settles while allowing writes to other chapters", async () => {
    const inspected = deferred<void>();
    const finish = deferred<void>();
    const events: string[] = [];
    const reading = withChapterDownloadSnapshotReads(async hold => {
      expect(hold(42)).toBe(true);
      inspected.resolve();
      await finish.promise;
      events.push("snapshot-settled");
      return "snapshot";
    });
    const selected = withChapterDownloadWrite(42, undefined, async () => { events.push("selected-write"); });
    try {
      await inspected.promise;
      await withChapterDownloadWrite(43, undefined, async () => { events.push("other-write"); });
      expect(events).toEqual(["other-write"]);
      finish.resolve();
      expect(await reading).toBe("snapshot");
      await selected;
      expect(events).toEqual(["other-write", "snapshot-settled", "selected-write"]);
    } finally {
      finish.resolve();
      await Promise.allSettled([reading, selected]);
    }
  });

  it("waits for held snapshots before removing selected chapters without delaying unrelated deletion", async () => {
    const finish = deferred<void>();
    const events: string[] = [];
    const reading = withChapterDownloadSnapshotReads(async hold => {
      expect(hold(42)).toBe(true);
      await finish.promise;
      events.push("snapshot-settled");
    });
    const selected = withChapterDownloadDeletion([42], async () => { events.push("selected-delete"); });
    const other = withChapterDownloadDeletion([43], async () => { events.push("other-delete"); });
    try {
      expect(events).toEqual(["other-delete"]);
      await other;
      expect(events).toEqual(["other-delete"]);
      finish.resolve();
      await Promise.all([reading, selected]);
      expect(events).toEqual(["other-delete", "snapshot-settled", "selected-delete"]);
    } finally {
      finish.resolve();
      await Promise.allSettled([reading, selected, other]);
    }
  });

  it.each(["write", "deletion"])("skips a chapter with an active %s without waiting for it", async activity => {
    const finish = deferred<void>();
    const active = activity === "write"
      ? withChapterDownloadWrite(42, undefined, () => finish.promise)
      : withChapterDownloadDeletion([42], () => finish.promise);
    try {
      const result = await withChapterDownloadSnapshotReads(async hold => {
        expect(hold(42)).toBe(false);
        expect(hold(43)).toBe(true);
        return "unblocked";
      });
      expect(result).toBe("unblocked");
    } finally {
      finish.resolve();
      await active;
    }
  });

  it("releases every held chapter when a snapshot callback rejects without replacing its error", async () => {
    const finish = deferred<void>();
    const failure = new Error("Snapshot transaction failed");
    const reading = withChapterDownloadSnapshotReads(async hold => {
      expect(hold(42)).toBe(true);
      expect(hold(43)).toBe(true);
      await finish.promise;
    });
    const failed = expect(reading).rejects.toBe(failure);
    const written: number[] = [];
    const writes = [42, 43].map(chapterId => withChapterDownloadWrite(chapterId, undefined, async () => { written.push(chapterId); }));
    try {
      expect(written).toEqual([]);
      finish.reject(failure);
      await Promise.all([failed, ...writes]);
      expect(written.sort()).toEqual([42, 43]);
    } finally {
      finish.reject(failure);
      await Promise.allSettled([reading, ...writes]);
    }
  });

  it("treats repeated holds as one lease and releases them when the callback returns", async () => {
    const before = currentChapterDownloadRevision();
    expect(await withChapterDownloadSnapshotReads(async hold => {
      expect(hold(42)).toBe(true);
      expect(hold(42)).toBe(true);
      expect(hold(42)).toBe(true);
      return 17;
    })).toBe(17);
    expect(currentChapterDownloadRevision()).toBe(before);
    const write = vi.fn(async () => "written");
    expect(await withChapterDownloadWrite(42, undefined, write)).toBe("written");
    expect(write).toHaveBeenCalledOnce();
  });

  it("waits for every independent snapshot holding the same chapter", async () => {
    const firstFinish = deferred<void>();
    const secondFinish = deferred<void>();
    const first = withChapterDownloadSnapshotReads(async hold => { expect(hold(42)).toBe(true); await firstFinish.promise; });
    const second = withChapterDownloadSnapshotReads(async hold => { expect(hold(42)).toBe(true); await secondFinish.promise; });
    const write = vi.fn(async () => undefined);
    const writing = withChapterDownloadWrite(42, undefined, write);
    try {
      firstFinish.resolve();
      await first;
      await withChapterDownloadWrite(43, undefined, async () => undefined);
      expect(write).not.toHaveBeenCalled();
      secondFinish.resolve();
      await Promise.all([second, writing]);
      expect(write).toHaveBeenCalledOnce();
    } finally {
      firstFinish.resolve();
      secondFinish.resolve();
      await Promise.allSettled([first, second, writing]);
    }
  });

  it("rechecks deletion after a waiting writer's snapshot lease is released", async () => {
    const readFinish = deferred<void>();
    const deleteStarted = deferred<void>();
    const deleteFinish = deferred<void>();
    const events: string[] = [];
    const reading = withChapterDownloadSnapshotReads(async hold => { expect(hold(42)).toBe(true); await readFinish.promise; });
    const writing = withChapterDownloadWrite(42, undefined, async () => { events.push("write"); });
    const deletion = withChapterDownloadDeletion([42], async () => {
      events.push("delete-start");
      deleteStarted.resolve();
      await deleteFinish.promise;
      events.push("delete-end");
    });
    try {
      expect(events).toEqual([]);
      readFinish.resolve();
      await reading;
      await deleteStarted.promise;
      await withChapterDownloadWrite(43, undefined, async () => undefined);
      expect(events).toEqual(["delete-start"]);
      deleteFinish.resolve();
      await Promise.all([deletion, writing]);
      expect(events).toEqual(["delete-start", "delete-end", "write"]);
    } finally {
      readFinish.resolve();
      deleteFinish.resolve();
      await Promise.allSettled([reading, deletion, writing]);
    }
  });
});
