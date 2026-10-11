import { expect, it, vi } from "vitest";
import { runContentStorageOperation, runWorkContentStorageOperation } from "./storage-operation";

it("waits for storage restoration before starting a queued sync", async () => {
  let release: () => void = () => undefined;
  const events: string[] = [];
  const restore = runContentStorageOperation(async () => {
    events.push("restore started");
    await new Promise<void>(resolve => { release = resolve; });
    events.push("restore finished");
  });
  const sync = runContentStorageOperation(async () => { events.push("sync"); });
  await vi.waitFor(() => expect(events).toEqual(["restore started"]));
  expect(events).toEqual(["restore started"]);
  release();
  await Promise.all([restore, sync]);
  expect(events).toEqual(["restore started", "restore finished", "sync"]);
});

it("lets another work finish while a background transfer is pending and makes restore exclusive", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const background = runWorkContentStorageOperation("source", "/background", async () => { events.push("background"); await pending; });
  const foreground = runWorkContentStorageOperation("source", "/foreground", async () => { events.push("foreground"); });
  await foreground;
  expect(events).toEqual(["background", "foreground"]);
  const restore = runContentStorageOperation(async () => { events.push("restore"); });
  const later = runWorkContentStorageOperation("source", "/later", async () => { events.push("later"); });
  await Promise.resolve();
  expect(events).toEqual(["background", "foreground"]);
  release();
  await Promise.all([background, restore, later]);
  expect(events).toEqual(["background", "foreground", "restore", "later"]);
});

it("serializes transfers and metadata publication for the same work", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const transfer = runWorkContentStorageOperation("source", "/book", async () => { events.push("transfer"); await pending; });
  const publication = runWorkContentStorageOperation("source", "/book", async () => { events.push("publication"); });
  await vi.waitFor(() => expect(events).toEqual(["transfer"]));
  release();
  await Promise.all([transfer, publication]);
  expect(events).toEqual(["transfer", "publication"]);
});

it("releases the queue after a failed operation", async () => {
  const failed = runContentStorageOperation(async () => { throw new Error("restore failed"); });
  const next = runContentStorageOperation(async () => "continued");
  await expect(failed).rejects.toThrow("restore failed");
  await expect(next).resolves.toBe("continued");
});
