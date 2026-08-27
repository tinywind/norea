import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("./android-storage", () => ({
  copyAndroidContentUriToTempFile: vi.fn(),
  deleteAndroidContentUriTempFile: vi.fn(),
}));

vi.mock("./tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(() => false),
}));

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  copyAndroidContentUriToTempFile,
  deleteAndroidContentUriTempFile,
} from "./android-storage";
import { isAndroidRuntime } from "./tauri-runtime";
import {
  applyAndConnectPluginVpnFinderProfile,
  applyPluginVpnFinderProfile,
  canStartPluginVpnConnection,
  configureAndroidPluginVpnProxy,
  connectPluginVpn,
  ensureAndroidPluginVpnProxy,
  loadPluginVpnFinderServers,
  importPluginVpnProfile,
  isPluginVpnControlStatusReady,
  type PluginVpnCredentials,
  type PluginVpnStatus,
} from "./plugin-vpn";

const invokeMock = vi.mocked(invoke);
const openMock = vi.mocked(open);
const isAndroidRuntimeMock = vi.mocked(isAndroidRuntime);
const copyAndroidContentUriToTempFileMock = vi.mocked(
  copyAndroidContentUriToTempFile,
);
const deleteAndroidContentUriTempFileMock = vi.mocked(
  deleteAndroidContentUriTempFile,
);

const STATUS: PluginVpnStatus = {
  error: null,
  phase: "disabled",
  profile: {
    remoteHost: "vpn.example.test",
    requiresUsernamePassword: true,
  },
  proxyPort: 43127,
  supported: true,
};

describe("plugin VPN", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAndroidRuntimeMock.mockReturnValue(false);
    invokeMock.mockResolvedValue(STATUS);
    vi.unstubAllGlobals();
  });

  it("configures the authenticated Android WebView proxy", async () => {
    isAndroidRuntimeMock.mockReturnValue(true);
    const configure = vi.fn((_payload: string) =>
      JSON.stringify({ ok: true }),
    );
    vi.stubGlobal("window", {
      __NoreaAndroidBridge: {
        nonce: vi.fn(() => "nonce-123"),
        session: vi.fn(() =>
          JSON.stringify({
            capabilities: ["vpn.proxy.configure"],
            sessionToken: "session-token",
          }),
        ),
      },
      __NoreaAndroidVpn: { configure },
    });

    await configureAndroidPluginVpnProxy(STATUS);

    expect(configure).toHaveBeenCalledOnce();
    expect(JSON.parse(configure.mock.calls[0][0])).toEqual({
      _bridge: {
        capability: "vpn.proxy.configure",
        nonce: "nonce-123",
        sessionToken: "session-token",
      },
      port: 43127,
    });
  });

  it("imports Android content profiles through a capped temp file and cleans it", async () => {
    isAndroidRuntimeMock.mockReturnValue(true);
    openMock.mockResolvedValue("content://profiles/client.ovpn");
    copyAndroidContentUriToTempFileMock.mockResolvedValue({
      bytes: 512,
      mimeType: "application/x-openvpn-profile",
      path: "/data/user/0/norea/cache/client.ovpn",
    });

    await expect(importPluginVpnProfile()).resolves.toEqual(STATUS);

    expect(copyAndroidContentUriToTempFileMock).toHaveBeenCalledWith(
      "content://profiles/client.ovpn",
      1024 * 1024,
    );
    expect(invokeMock).toHaveBeenCalledWith("plugin_vpn_import_profile", {
      path: "/data/user/0/norea/cache/client.ovpn",
    });
    expect(deleteAndroidContentUriTempFileMock).toHaveBeenCalledWith({
      bytes: 512,
      mimeType: "application/x-openvpn-profile",
      path: "/data/user/0/norea/cache/client.ovpn",
    });
  });

  it("passes credentials only to the connect command", async () => {
    const credentials = {
      challengeResponse: "challenge",
      password: "password",
      privateKeyPassword: "key-password",
      username: "reader",
    };

    await expect(connectPluginVpn(credentials)).resolves.toEqual(STATUS);

    expect(invokeMock).toHaveBeenCalledWith("plugin_vpn_connect", {
      credentials,
    });
  });

  it("requests the native VPN Gate catalog with an explicit refresh policy", async () => {
    const servers = [
      {
        activeSessions: 4,
        candidateId: "candidate-1",
        countryCode: "JP",
        countryName: "Japan",
        hostName: "public-vpn-1",
        ip: "203.0.113.10",
        logType: "2weeks",
        pingMs: 18,
        protocol: "tcp" as const,
        score: 125_000,
        speedBps: 12_500_000,
        totalUsers: 9_000,
        uptimeMs: 3_600_000,
      },
    ];
    invokeMock.mockResolvedValueOnce(servers);

    await expect(loadPluginVpnFinderServers(true)).resolves.toEqual(servers);

    expect(invokeMock).toHaveBeenCalledWith("plugin_vpn_load_finder_servers", {
      forceRefresh: true,
    });
  });

  it("applies a cached Finder profile by opaque candidate id", async () => {
    await expect(
      applyPluginVpnFinderProfile("candidate-1"),
    ).resolves.toEqual(STATUS);

    expect(invokeMock).toHaveBeenCalledWith(
      "plugin_vpn_apply_finder_profile",
      { candidateId: "candidate-1" },
    );
  });

  it("applies and connects a Finder profile in one user action", async () => {
    await expect(
      applyAndConnectPluginVpnFinderProfile("candidate-1"),
    ).resolves.toEqual(STATUS);

    expect(invokeMock.mock.calls).toEqual([
      ["plugin_vpn_apply_finder_profile", { candidateId: "candidate-1" }],
      [
        "plugin_vpn_connect",
        {
          credentials: {
            challengeResponse: "",
            password: "",
            privateKeyPassword: "",
            username: "",
          },
        },
      ],
    ]);
  });

  it("requires username and password before starting a credentialed profile", () => {
    const credentials: PluginVpnCredentials = {
      challengeResponse: "",
      password: "",
      privateKeyPassword: "",
      username: "",
    };

    expect(canStartPluginVpnConnection(STATUS, credentials)).toBe(false);
    expect(
      canStartPluginVpnConnection(STATUS, {
        ...credentials,
        password: "password",
        username: "   ",
      }),
    ).toBe(false);
    expect(
      canStartPluginVpnConnection(STATUS, {
        ...credentials,
        password: "password",
        username: "reader",
      }),
    ).toBe(true);
  });

  it("allows credential-free profiles only while they are ready to connect", () => {
    const credentials: PluginVpnCredentials = {
      challengeResponse: "",
      password: "",
      privateKeyPassword: "",
      username: "",
    };
    const credentialFree = {
      ...STATUS,
      profile: {
        ...STATUS.profile!,
        requiresUsernamePassword: false,
      },
    };

    expect(canStartPluginVpnConnection(credentialFree, credentials)).toBe(true);
    expect(
      canStartPluginVpnConnection(
        { ...credentialFree, phase: "connecting" },
        credentials,
      ),
    ).toBe(false);
    expect(
      canStartPluginVpnConnection(
        { ...credentialFree, profile: null },
        credentials,
      ),
    ).toBe(false);
  });

  it("keeps controls closed while status is loading or failed", () => {
    expect(isPluginVpnControlStatusReady(undefined, true, false)).toBe(false);
    expect(isPluginVpnControlStatusReady(STATUS, true, false)).toBe(false);
    expect(isPluginVpnControlStatusReady(STATUS, false, true)).toBe(false);
    expect(isPluginVpnControlStatusReady(STATUS, false, false)).toBe(true);
  });

  it("fails closed until the Android proxy is configured and retries failures", async () => {
    isAndroidRuntimeMock.mockReturnValue(true);
    const configure = vi
      .fn()
      .mockReturnValueOnce(
        JSON.stringify({ error: "proxy setup failed", ok: false }),
      )
      .mockReturnValueOnce(JSON.stringify({ ok: true }));
    vi.stubGlobal("window", {
      __NoreaAndroidBridge: {
        nonce: vi.fn(() => "nonce-123"),
        session: vi.fn(() =>
          JSON.stringify({
            capabilities: ["vpn.proxy.configure"],
            sessionToken: "session-token",
          }),
        ),
      },
      __NoreaAndroidVpn: { configure },
    });

    await expect(ensureAndroidPluginVpnProxy()).rejects.toThrow(
      "proxy setup failed",
    );
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "plugin_vpn_status",
    ]);

    const credentials: PluginVpnCredentials = {
      challengeResponse: "",
      password: "password",
      privateKeyPassword: "",
      username: "reader",
    };
    await expect(connectPluginVpn(credentials)).resolves.toEqual(STATUS);

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "plugin_vpn_status",
      "plugin_vpn_status",
      "plugin_vpn_connect",
    ]);
    expect(invokeMock.mock.invocationCallOrder[1]).toBeLessThan(
      configure.mock.invocationCallOrder[1],
    );
    expect(configure.mock.invocationCallOrder[1]).toBeLessThan(
      invokeMock.mock.invocationCallOrder[2],
    );
  });
});
