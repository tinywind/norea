import { describe, expect, it } from "vitest";
import { isNewerPluginVersion } from "./version";

describe("isNewerPluginVersion", () => {
  it("compares each numeric part instead of the text", () => {
    expect(isNewerPluginVersion("1.10.0", "1.9.3")).toBe(true);
    expect(isNewerPluginVersion("1.9.3", "1.10.0")).toBe(false);
    expect(isNewerPluginVersion("2.0", "1.99.99")).toBe(true);
  });

  it("is never newer for the same version, including missing trailing parts", () => {
    expect(isNewerPluginVersion("1.2.0", "1.2.0")).toBe(false);
    expect(isNewerPluginVersion("1.2", "1.2.0")).toBe(false);
    expect(isNewerPluginVersion("1.2.0.1", "1.2")).toBe(true);
  });

  it("accepts a leading v and surrounding spaces", () => {
    expect(isNewerPluginVersion(" v1.3.0 ", "1.2.9")).toBe(true);
  });

  it("does not claim an update for versions it cannot compare", () => {
    expect(isNewerPluginVersion("1.3.0-beta", "1.2.0")).toBe(false);
    expect(isNewerPluginVersion("latest", "1.2.0")).toBe(false);
    expect(isNewerPluginVersion("1.3.0", "")).toBe(false);
  });
});
