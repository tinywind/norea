import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { windowsSiteBrowser } from "./windows";

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
});
