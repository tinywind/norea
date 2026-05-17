import { describe, expect, it } from "vitest";
import { MAX_SCHEDULER_MATERIALIZED_TASKS } from "../performance-budgets";
import {
  runBoundedTaskBatch,
  TASK_BATCH_MATERIALIZATION_WINDOW,
} from "./batch-window";

describe("runBoundedTaskBatch", () => {
  it("keeps 10k materialized tasks within the scheduler budget", async () => {
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
    expect(maxActive).toBe(TASK_BATCH_MATERIALIZATION_WINDOW);
    expect(maxActive).toBeLessThan(MAX_SCHEDULER_MATERIALIZED_TASKS);
  });
});
