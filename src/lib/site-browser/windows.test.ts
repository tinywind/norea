import { describe, expect, it, vi } from "vitest";
import { windowsSiteBrowser } from "./windows";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../store/user-agent", () => ({
  getScraperUserAgent: () => null,
}));
vi.mock("./desktop-navigation", () => ({
  invokeDesktopNavigation: vi.fn(),
}));

describe("windowsSiteBrowser", () => {
  it("does not cover trusted React chrome when its placeholder is unavailable", () => {
    expect(windowsSiteBrowser.boundsFor(null)).toBeNull();
  });
});
