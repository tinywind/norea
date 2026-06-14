import { describe, expect, it } from "vitest";
import {
  activeScraperExecutor,
  activeScraperExecutorSignal,
  runWithScraperExecutor,
} from "./scraper-queue";

describe("scraper executor context", () => {
  it("tracks the active scraper executor for a source task", async () => {
    const work = runWithScraperExecutor(
      "source-a",
      "task-a",
      "pool:2",
      undefined,
      async () => {
        expect(activeScraperExecutor("source-a")).toBe("pool:2");
      },
    );

    expect(activeScraperExecutor("source-a")).toBe("pool:2");
    await work;
    expect(activeScraperExecutor("source-a")).toBe("immediate");
  });

  it("falls back to the immediate executor outside a source task", () => {
    expect(activeScraperExecutor(undefined)).toBe("immediate");
    expect(activeScraperExecutor("missing")).toBe("immediate");
  });

  it("exposes the running task abort signal per executor", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;

    const work = runWithScraperExecutor(
      "source-a",
      "task-a",
      "pool:1",
      controller.signal,
      async () => {
        observed = activeScraperExecutorSignal("pool:1");
      },
    );

    expect(activeScraperExecutorSignal("pool:1")).toBe(controller.signal);
    await work;
    expect(observed).toBe(controller.signal);
    expect(activeScraperExecutorSignal("pool:1")).toBeUndefined();
  });

  it("has no executor signal outside a source task", () => {
    expect(activeScraperExecutorSignal("immediate")).toBeUndefined();
    expect(activeScraperExecutorSignal(undefined)).toBeUndefined();
  });
});
