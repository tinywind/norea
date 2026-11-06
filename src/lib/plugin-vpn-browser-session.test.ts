import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { isAndroidRuntime } from "./tauri-runtime";
import { androidScraperResetVpnSession } from "./android-scraper";
import { resetPluginVpnBrowserSession } from "./plugin-vpn-browser-session";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("./tauri-runtime", () => ({ isAndroidRuntime: vi.fn(() => false) }));
vi.mock("./android-scraper", () => ({ androidScraperResetVpnSession: vi.fn(async () => undefined) }));

beforeEach(() => vi.clearAllMocks());
describe("VPN browser session changes", () => {
  it("uses the desktop selective session reset instead of deleting all source data", async () => {
    await resetPluginVpnBrowserSession();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("scraper_reset_vpn_session");
    expect(androidScraperResetVpnSession).not.toHaveBeenCalled();
  });

  it("awaits Android selective cleanup before allowing a new route", async () => {
    vi.mocked(isAndroidRuntime).mockReturnValue(true);
    let complete!: () => void;
    vi.mocked(androidScraperResetVpnSession).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    let ready = false;
    const pending = resetPluginVpnBrowserSession().then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    complete(); await pending;
    expect(ready).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });
});
