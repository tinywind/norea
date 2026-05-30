import { describe, expect, it } from "vitest";
import {
  runBoundedTaskBatch,
  TASK_BATCH_MATERIALIZATION_WINDOW,
} from "./batch-window";

describe("runBoundedTaskBatch", () => {
  it("materializes every task by default", async () => {
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const items = Array.from({ length: 10_000 }, (_, index) => index);

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
    expect(TASK_BATCH_MATERIALIZATION_WINDOW).toBe(Number.POSITIVE_INFINITY);
    expect(maxActive).toBe(items.length);
  });
});
