import { expect, it } from "vitest";
import { serializeUserStateSynchronization, withUserStateRestore } from "./maintenance";

it("cancels active sharing, awaits settlement, and prevents a queued publication before restoring", async () => {
  const order: string[] = [];
  const controller = new AbortController();
  const active = serializeUserStateSynchronization(() => new Promise<void>((resolve) => {
    order.push("network-start");
    controller.signal.addEventListener("abort", () => { order.push("network-settled"); resolve(); }, { once: true });
  }), () => controller.abort(), controller.signal);
  await Promise.resolve();
  const queuedController = new AbortController();
  const queued = serializeUserStateSynchronization(async () => { order.push("unexpected-publication"); },
    () => queuedController.abort(), queuedController.signal);
  const rejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
  const restored = withUserStateRestore(async () => { order.push("restore"); });
  await active; await rejected; await restored;
  expect(order).toEqual(["network-start", "network-settled", "restore"]);
});

it("allows later guarded synchronizations after a failed restore releases the queue", async () => {
  await expect(withUserStateRestore(async () => { throw new Error("restore failed"); })).rejects.toThrow("restore failed");
  const controller = new AbortController();
  await expect(serializeUserStateSynchronization(async () => "checked durable fence", () => controller.abort(), controller.signal))
    .resolves.toBe("checked durable fence");
});
