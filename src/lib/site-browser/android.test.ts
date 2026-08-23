import { beforeEach, describe, expect, it, vi } from "vitest";
import { androidScraperCurrentOrigin } from "../android-scraper";
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
  });

  it("reads the current origin from the native WebView", async () => {
    vi.mocked(androidScraperCurrentOrigin).mockResolvedValueOnce(
      "https://redirected.example:8443",
    );

    await expect(androidSiteBrowser.currentOrigin()).resolves.toBe(
      "https://redirected.example:8443",
    );
    expect(androidScraperCurrentOrigin).toHaveBeenCalledOnce();
  });
});
