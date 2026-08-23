import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { linuxSiteBrowser } from "./linux";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../store/user-agent", () => ({
  getScraperUserAgent: () => null,
}));
vi.mock("./desktop-navigation", () => ({
  invokeDesktopNavigation: vi.fn(),
}));

describe("linuxSiteBrowser", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("keeps trusted React chrome outside the native scraper surface", () => {
    const node = {
      getBoundingClientRect: () => ({
        height: 480,
        left: 12,
        top: 40,
        width: 720,
      }),
    } as HTMLDivElement;

    expect(linuxSiteBrowser.chromeMode).toBe("react");
    expect(linuxSiteBrowser.boundsFor(node)).toEqual({
      x: 12,
      y: 40,
      width: 720,
      height: 480,
    });
  });

  it("reads the current origin from the native WebView", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("https://redirected.test:8443");

    await expect(linuxSiteBrowser.currentOrigin()).resolves.toBe(
      "https://redirected.test:8443",
    );
    expect(invoke).toHaveBeenCalledWith("scraper_current_origin");
  });
});
