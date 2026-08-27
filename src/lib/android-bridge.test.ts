import { afterEach, describe, expect, it, vi } from "vitest";
import { androidBridgeAuthority } from "./android-bridge";

function installBridgeSession(capabilities: unknown): void {
  vi.stubGlobal("window", {
    __NoreaAndroidBridge: {
      nonce: vi.fn(() => "nonce-123"),
      session: vi.fn(() =>
        JSON.stringify({
          capabilities,
          sessionToken: "session-token",
        }),
      ),
    },
  });
}

describe("androidBridgeAuthority", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns authority only when the string capability list includes the request", () => {
    installBridgeSession(["update.openApk", "vpn.proxy.configure"]);

    expect(androidBridgeAuthority("vpn.proxy.configure")).toEqual({
      capability: "vpn.proxy.configure",
      nonce: "nonce-123",
      sessionToken: "session-token",
    });
  });

  it.each([
    ["missing", undefined],
    ["not an array", "vpn.proxy.configure"],
    ["not a string array", ["vpn.proxy.configure", 1]],
    ["without the requested capability", ["update.openApk"]],
  ])("rejects a capability list that is %s", (_label, capabilities) => {
    installBridgeSession(capabilities);

    expect(() => androidBridgeAuthority("vpn.proxy.configure")).toThrow(
      "Android bridge capability is unavailable.",
    );
  });
});
