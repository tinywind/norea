import { beforeEach, describe, expect, it, vi } from "vitest";
import { androidScraperResetSiteData } from "../android-scraper";
import { isAndroidRuntime } from "../tauri-runtime";
import { canResetSourceSiteData, canRotateBrowserFingerprint, resetSourceSiteData } from "./session";

vi.mock("../android-scraper", () => ({ androidScraperResetSiteData: vi.fn() }));
vi.mock("../tauri-runtime", () => ({ isAndroidRuntime: vi.fn() }));

describe("shared site browser session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAndroidRuntime).mockReturnValue(true);
    vi.stubGlobal("window", {
      __NoreaAndroidScraper: {
        canResetSiteData: () => true,
        canRotateFingerprint: () => true,
      },
    });
  });

  it("uses the provider capability instead of showing an ineffective setting", () => {
    expect(canResetSourceSiteData()).toBe(true);
    expect(canRotateBrowserFingerprint()).toBe(true);
    vi.stubGlobal("window", { __NoreaAndroidScraper: {} });
    expect(canResetSourceSiteData()).toBe(false);
    expect(canRotateBrowserFingerprint()).toBe(false);
    vi.mocked(isAndroidRuntime).mockReturnValue(false);
    expect(canResetSourceSiteData()).toBe(false);
  });

  it("resets the affected origin with its source owner and waits for native completion", async () => {
    let finish!: () => void;
    vi.mocked(androidScraperResetSiteData).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(undefined); }));
    let completed = false;
    const resetting = resetSourceSiteData("newtoki-novel", "https://example.test/chapter/12?token=private").then(() => { completed = true; });
    expect(androidScraperResetSiteData).toHaveBeenCalledWith("https://example.test", "newtoki-novel");
    expect(completed).toBe(false);
    finish();
    await resetting;
    expect(completed).toBe(true);
  });

  it.each(["file:///secret", "javascript:alert(1)", "https://user:password@example.test/", "not a URL"])(
    "rejects an unsafe or invalid site URL %s",
    async url => {
      await expect(resetSourceSiteData("source", url)).rejects.toThrow();
      expect(androidScraperResetSiteData).not.toHaveBeenCalled();
    },
  );

  it("does not pretend that an unsupported reset succeeded", async () => {
    vi.stubGlobal("window", { __NoreaAndroidScraper: { canResetSiteData: () => false } });
    await expect(resetSourceSiteData("source", "https://example.test")).rejects.toThrow("does not support");
    expect(androidScraperResetSiteData).not.toHaveBeenCalled();
  });

  it("propagates native failure before a recovery can release its hold", async () => {
    vi.mocked(androidScraperResetSiteData).mockRejectedValueOnce(new Error("Browser owner is busy"));
    await expect(resetSourceSiteData("source", "https://example.test")).rejects.toThrow("owner is busy");
  });
});
