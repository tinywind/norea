import { expect, it } from "vitest";
import { runContentStorageOperation } from "./storage-operation";

it("waits for storage restoration before starting a queued sync", async () => {
  let release: () => void = () => undefined;
  const events: string[] = [];
  const restore = runContentStorageOperation(async () => {
    events.push("restore started");
    await new Promise<void>(resolve => { release = resolve; });
    events.push("restore finished");
  });
  const sync = runContentStorageOperation(async () => { events.push("sync"); });
  await Promise.resolve();
  await Promise.resolve();
  expect(events).toEqual(["restore started"]);
  release();
  await Promise.all([restore, sync]);
  expect(events).toEqual(["restore started", "restore finished", "sync"]);
});

it("releases the queue after a failed operation", async () => {
  const failed = runContentStorageOperation(async () => { throw new Error("restore failed"); });
  const next = runContentStorageOperation(async () => "continued");
  await expect(failed).rejects.toThrow("restore failed");
  await expect(next).resolves.toBe("continued");
});
