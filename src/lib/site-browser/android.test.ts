import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  androidScraperCurrentOrigin,
  androidScraperNavigate,
} from "../android-scraper";
import { androidSiteBrowser } from "./android";

vi.mock("../android-scraper", () => ({
  androidScraperCurrentOrigin: vi.fn(),
  androidScraperHide: vi.fn(),
  androidScraperNavigate: vi.fn(),
  androidScraperSetBounds: vi.fn(),
}));
vi.mock("../../store/user-agent", () => ({
  getScraperUserAgent: () => null,
}));

describe("androidSiteBrowser", () => {
  beforeEach(() => {
    vi.mocked(androidScraperCurrentOrigin).mockReset();
    vi.mocked(androidScraperNavigate).mockReset();
  });

  it("reads the current origin from the native WebView", async () => {
    vi.mocked(androidScraperCurrentOrigin).mockResolvedValueOnce(
      "https://redirected.example:8443",
    );

    await expect(androidSiteBrowser.currentOrigin("source-a")).resolves.toBe(
      "https://redirected.example:8443",
    );
    expect(androidScraperCurrentOrigin).toHaveBeenCalledOnce();
    expect(androidScraperCurrentOrigin).toHaveBeenCalledWith("source-a");
  });

  it("does not request a destructive reset for foreground navigation", async () => {
    vi.mocked(androidScraperNavigate).mockResolvedValueOnce(true);
    const controller = new AbortController();

    await androidSiteBrowser.navigate("source-a", "https://source.test/", {
      signal: controller.signal,
      timeoutMs: 12_000,
    });

    expect(androidScraperNavigate).toHaveBeenCalledWith(
      "source-a",
      "https://source.test/",
      null,
      {
        signal: controller.signal,
        timeoutMs: 12_000,
      },
    );
  });
});
