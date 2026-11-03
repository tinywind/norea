import { describe, expect, it } from "vitest";
import { withRetryPluginId } from "./global-search";

describe("withRetryPluginId", () => {
  it("queues only the requested source for retry", () => {
    expect(withRetryPluginId([], "source-b")).toEqual(["source-b"]);
  });

  it("keeps other pending retries when another source is retried", () => {
    expect(withRetryPluginId(["source-a"], "source-b")).toEqual(["source-a", "source-b"]);
  });

  it("keeps the same list when the source is already queued", () => {
    const current = ["source-a"];
    expect(withRetryPluginId(current, "source-a")).toBe(current);
  });
});
