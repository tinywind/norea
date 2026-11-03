import { describe, expect, it } from "vitest";
import { comparePluginVersions, isNewerPluginVersion } from "./version";

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

  it("orders prereleases with semver precedence", () => {
    expect(isNewerPluginVersion("1.3.0-beta", "1.2.0")).toBe(true);
    expect(isNewerPluginVersion("1.3.0", "1.3.0-beta")).toBe(true);
    expect(isNewerPluginVersion("1.3.0-beta", "1.3.0")).toBe(false);
    expect(isNewerPluginVersion("1.3.0-beta.10", "1.3.0-beta.2")).toBe(true);
    expect(isNewerPluginVersion("1.3.0-rc", "1.3.0-beta")).toBe(true);
    expect(isNewerPluginVersion("1.3.0-alpha.1", "1.3.0-alpha")).toBe(true);
    expect(comparePluginVersions("1.3.0+build.5", "1.3.0")).toBe("same");
  });

  it("falls back to a numeric-aware string comparison when neither side is semver", () => {
    expect(isNewerPluginVersion("build-10", "build-9")).toBe(true);
    expect(comparePluginVersions("build-9", "build-10")).toBe("different");
    expect(comparePluginVersions("nightly", "nightly")).toBe("same");
  });

  it("reads a lower or unorderable version as different, never as an update", () => {
    expect(comparePluginVersions("1.0.0", "1.2.0")).toBe("different");
    expect(comparePluginVersions("latest", "1.2.0")).toBe("different");
    expect(comparePluginVersions("1.3.0", "")).toBe("different");
    expect(isNewerPluginVersion("latest", "1.2.0")).toBe(false);
  });
});
