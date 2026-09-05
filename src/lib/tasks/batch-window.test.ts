import { describe, expect, it } from "vitest";
import {
  runBoundedTaskBatch,
  TASK_BATCH_MATERIALIZATION_WINDOW,
} from "./batch-window";

describe("runBoundedTaskBatch", () => {
  it("materializes every task through a bounded default window", async () => {
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const items = Array.from({ length: 64 }, (_, index) => index);

    await runBoundedTaskBatch({
      items,
      materialize: async () => {
        active += 1;
        started += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
      },
    });

    expect(started).toBe(items.length);
    expect(TASK_BATCH_MATERIALIZATION_WINDOW).toBe(16);
    expect(maxActive).toBe(TASK_BATCH_MATERIALIZATION_WINDOW);
  });

  it("clamps oversized explicit windows", async () => {
    let active = 0;
    let maxActive = 0;

    await runBoundedTaskBatch({
      items: Array.from({ length: 64 }, (_, index) => index),
      materialize: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
      },
      windowSize: 10_000,
    });

    expect(maxActive).toBe(TASK_BATCH_MATERIALIZATION_WINDOW);
  });
});
