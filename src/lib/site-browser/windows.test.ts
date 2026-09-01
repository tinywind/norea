import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { windowsSiteBrowser } from "./windows";
import { invokeDesktopNavigation } from "./desktop-navigation";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../store/user-agent", () => ({
  getScraperUserAgent: () => null,
}));
vi.mock("./desktop-navigation", () => ({
  invokeDesktopNavigation: vi.fn(),
}));

describe("windowsSiteBrowser", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invokeDesktopNavigation).mockReset();
  });

  it("does not cover trusted React chrome when its placeholder is unavailable", () => {
    expect(windowsSiteBrowser.boundsFor(null)).toBeNull();
  });

  it("reads the current origin only for the active source profile", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("https://source.test");

    await expect(windowsSiteBrowser.currentOrigin("source-a")).resolves.toBe(
      "https://source.test",
    );
    expect(invoke).toHaveBeenCalledWith("scraper_current_origin", {
      sourceId: "source-a",
    });
  });

  it("does not request a destructive reset for foreground navigation", async () => {
    vi.mocked(invokeDesktopNavigation).mockResolvedValueOnce();
    const controller = new AbortController();

    await windowsSiteBrowser.navigate("source-a", "https://source.test/", {
      signal: controller.signal,
      timeoutMs: 12_000,
    });

    expect(invokeDesktopNavigation).toHaveBeenCalledWith(
      {
        sourceId: "source-a",
        timeoutMs: 12_000,
        url: "https://source.test/",
        userAgent: null,
      },
      controller.signal,
      expect.any(Function),
    );
  });

  it("waits for a pending hide before reopening the foreground WebView", async () => {
    let finishHide!: () => void;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "scraper_hide") {
        return new Promise<void>((resolve) => {
          finishHide = resolve;
        });
      }
      if (command === "scraper_set_bounds") return Promise.resolve();
      throw new Error(`Unexpected command ${command}`);
    });
    vi.mocked(invokeDesktopNavigation).mockResolvedValueOnce();

    const hiding = windowsSiteBrowser.hide();
    await Promise.resolve();
    const settingBounds = windowsSiteBrowser.setBounds(
      { x: 0, y: 0, width: 360, height: 640 },
      "https://source.test/",
      "source-a",
    );
    const navigating = windowsSiteBrowser.navigate(
      "source-a",
      "https://source.test/",
    );
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invokeDesktopNavigation).not.toHaveBeenCalled();

    finishHide();
    await Promise.all([hiding, settingBounds, navigating]);

    expect(invoke).toHaveBeenCalledWith(
      "scraper_set_bounds",
      expect.objectContaining({
        sourceId: "source-a",
        url: "https://source.test/",
      }),
    );
    expect(invokeDesktopNavigation).toHaveBeenCalledOnce();
  });
});
