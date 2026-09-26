import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
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
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  copyAndroidContentUriToTempFile,
  deleteAndroidContentUriTempFile,
} from "./android-storage";
import { isAndroidRuntime } from "./tauri-runtime";
import { usePluginVpnStore } from "../store/plugin-vpn";
import {
  applyPluginVpnFinderProfile,
  canStartPluginVpnConnection,
  configureAndroidPluginVpnProxy,
  connectPluginVpn,
  disconnectPluginVpn,
  ensureAndroidPluginVpnProxy,
  importPluginVpnProfile,
  loadPluginVpnFinderServers,
  pluginVpnFinderProfileIp,
  removePluginVpnProfile,
  restorePluginVpnConnection,
  PluginVpnConnectionNotEstablishedError,
  shouldShowPluginVpnReconnectedToast,
  startPluginVpnStatusListener,
  switchPluginVpnFinderServer,
  type PluginVpnCredentials,
  type PluginVpnFinderServer,
  type PluginVpnStatus,
} from "./plugin-vpn";

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
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
    isVpnGateFinder: false,
    remoteHost: "vpn.example.test",
    requiresUsernamePassword: true,
  },
  proxyPort: 43127,
  supported: true,
};

const CONNECTED_STATUS: PluginVpnStatus = {
  ...STATUS,
  phase: "connected",
};

const RECONNECTING_STATUS: PluginVpnStatus = {
  ...STATUS,
  error: "OpenVPN transport is reconnecting",
  phase: "reconnecting",
};

const ERROR_STATUS: PluginVpnStatus = {
  ...STATUS,
  error: "OpenVPN session failed",
  phase: "error",
};

const EMPTY_CREDENTIALS: PluginVpnCredentials = {
  challengeResponse: "",
  password: "",
  privateKeyPassword: "",
  username: "",
};

const SESSION_CREDENTIALS: PluginVpnCredentials = {
  challengeResponse: "",
  password: "test-password",
  privateKeyPassword: "test-key",
  username: "reader",
};

describe("plugin VPN", () => {
  beforeEach(async () => {
    invokeMock.mockResolvedValue(STATUS);
    await disconnectPluginVpn();
    vi.clearAllMocks();
    isAndroidRuntimeMock.mockReturnValue(false);
    invokeMock.mockResolvedValue(STATUS);
    vi.unstubAllGlobals();
  });

  it("restores a saved On setting using the stored profile", async () => {
    usePluginVpnStore.getState().setEnabled(true);
    invokeMock
      .mockResolvedValueOnce({ ...STATUS, profile: { ...STATUS.profile!, isVpnGateFinder: true } })
      .mockResolvedValueOnce(CONNECTED_STATUS);

    await expect(restorePluginVpnConnection()).resolves.toEqual(CONNECTED_STATUS);
    expect(invokeMock.mock.calls).toEqual([
      ["plugin_vpn_status"],
      ["plugin_vpn_connect", { credentials: EMPTY_CREDENTIALS }],
    ]);
    expect(usePluginVpnStore.getState().enabled).toBe(true);
  });

  it("never restores a manually disabled VPN", async () => {
    await expect(restorePluginVpnConnection()).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it.each(["connecting", "connected", "reconnecting", "disconnecting"] as const)(
    "does not replace an existing %s connection",
    async (phase) => {
      usePluginVpnStore.getState().setEnabled(true);
      invokeMock.mockResolvedValueOnce({ ...STATUS, phase });
      await expect(restorePluginVpnConnection()).resolves.toBeNull();
      expect(invokeMock.mock.calls).toEqual([["plugin_vpn_status"]]);
    },
  );

  it("coalesces simultaneous startup and foreground recovery", async () => {
    usePluginVpnStore.getState().setEnabled(true);
    invokeMock.mockResolvedValueOnce(STATUS).mockResolvedValueOnce(CONNECTED_STATUS);
    await Promise.all([restorePluginVpnConnection(), restorePluginVpnConnection()]);
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "plugin_vpn_status", "plugin_vpn_connect",
    ]);
  });

  it("ignores a late status result after manual Off", async () => {
    usePluginVpnStore.getState().setEnabled(true);
    let resolveStatus!: (status: PluginVpnStatus) => void;
    invokeMock.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }));
    const recovery = restorePluginVpnConnection();
    await disconnectPluginVpn();
    resolveStatus(STATUS);
    await expect(recovery).resolves.toBeNull();
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "plugin_vpn_status", "plugin_vpn_disconnect",
    ]);
    expect(usePluginVpnStore.getState().enabled).toBe(false);
  });

  it("keeps On after a failed recovery and retries on the next resume", async () => {
    usePluginVpnStore.getState().setEnabled(true);
    invokeMock.mockResolvedValueOnce(STATUS).mockRejectedValueOnce("network unavailable");
    await expect(restorePluginVpnConnection()).rejects.toBe("network unavailable");
    expect(usePluginVpnStore.getState().enabled).toBe(true);
    expect(invokeMock).toHaveBeenLastCalledWith("plugin_vpn_disconnect", { preserveBlock: true });
    invokeMock.mockResolvedValueOnce(STATUS).mockResolvedValueOnce(CONNECTED_STATUS);
    await expect(restorePluginVpnConnection()).resolves.toEqual(CONNECTED_STATUS);
  });

  it("reuses session credentials and cleans up a failed native tunnel before recovery", async () => {
    invokeMock.mockResolvedValueOnce(CONNECTED_STATUS);
    await connectPluginVpn(SESSION_CREDENTIALS);
    invokeMock.mockClear();
    invokeMock.mockResolvedValueOnce(ERROR_STATUS).mockResolvedValueOnce(STATUS)
      .mockResolvedValueOnce(CONNECTED_STATUS);
    await expect(restorePluginVpnConnection()).resolves.toEqual(CONNECTED_STATUS);
    expect(invokeMock.mock.calls).toEqual([
      ["plugin_vpn_status"],
      ["plugin_vpn_disconnect", { preserveBlock: true }],
      ["plugin_vpn_connect", { credentials: SESSION_CREDENTIALS }],
    ]);
  });

  it("does not restore over a pending manual connection", async () => {
    invokeMock.mockResolvedValueOnce(CONNECTED_STATUS);
    const connection = connectPluginVpn(SESSION_CREDENTIALS);
    await expect(restorePluginVpnConnection()).resolves.toBeNull();
    await expect(connection).resolves.toEqual(CONNECTED_STATUS);
    expect(invokeMock.mock.calls).toEqual([
      ["plugin_vpn_connect", { credentials: SESSION_CREDENTIALS }],
    ]);
  });

  it("lets a manual connection supersede a pending recovery status check", async () => {
    usePluginVpnStore.getState().setEnabled(true);
    let resolveStatus!: (status: PluginVpnStatus) => void;
    invokeMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveStatus = resolve; }))
      .mockResolvedValueOnce(STATUS)
      .mockResolvedValueOnce(CONNECTED_STATUS);
    const recovery = restorePluginVpnConnection();
    await expect(connectPluginVpn(SESSION_CREDENTIALS)).resolves.toEqual(CONNECTED_STATUS);
    resolveStatus(STATUS);
    await expect(recovery).resolves.toBeNull();
    expect(invokeMock.mock.calls).toEqual([
      ["plugin_vpn_status"],
      ["plugin_vpn_disconnect", { preserveBlock: true }],
      ["plugin_vpn_connect", { credentials: SESSION_CREDENTIALS }],
    ]);
    expect(usePluginVpnStore.getState().enabled).toBe(true);
  });

  it.each(["connected", "failed"] as const)(
    "ignores a late %s recovery result after manual Off",
    async (result) => {
      usePluginVpnStore.getState().setEnabled(true);
      let finish!: () => void;
      let started!: () => void;
      const connecting = new Promise<void>((resolve) => { started = resolve; });
      invokeMock.mockResolvedValueOnce(STATUS).mockImplementationOnce(() => {
        started();
        return new Promise((resolve, reject) => {
          finish = () => result === "connected"
            ? resolve(CONNECTED_STATUS)
            : reject(new Error("connection cancelled"));
        });
      });
      const recovery = restorePluginVpnConnection();
      await connecting;
      await disconnectPluginVpn();
      finish();
      await expect(recovery).resolves.toBeNull();
      expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
        "plugin_vpn_status", "plugin_vpn_connect", "plugin_vpn_disconnect",
      ]);
      expect(usePluginVpnStore.getState().enabled).toBe(false);
    },
  );

  it("honors manual Off before connection preparation finishes", async () => {
    const connection = connectPluginVpn(SESSION_CREDENTIALS);
    await disconnectPluginVpn();
    await expect(connection).resolves.toBeNull();
    expect(invokeMock.mock.calls).toEqual([
      ["plugin_vpn_disconnect", { preserveBlock: false }],
    ]);
    expect(usePluginVpnStore.getState().enabled).toBe(false);
  });

  it("forgets session credentials when the user disconnects", async () => {
    invokeMock.mockResolvedValueOnce(CONNECTED_STATUS);
    await connectPluginVpn(SESSION_CREDENTIALS);
    await disconnectPluginVpn();
    usePluginVpnStore.getState().setEnabled(true);
    invokeMock.mockClear();
    invokeMock.mockResolvedValueOnce(STATUS).mockResolvedValueOnce(CONNECTED_STATUS);
    await restorePluginVpnConnection();
    expect(invokeMock.mock.calls).toEqual([
      ["plugin_vpn_status"],
      ["plugin_vpn_connect", { credentials: EMPTY_CREDENTIALS }],
    ]);
  });

  it("cancels recovery when replacing or removing a profile", async () => {
    usePluginVpnStore.getState().setEnabled(true);
    let resolveStatus!: (status: PluginVpnStatus) => void;
    invokeMock.mockReturnValueOnce(new Promise((resolve) => { resolveStatus = resolve; }));
    const recovery = restorePluginVpnConnection();
    await applyPluginVpnFinderProfile("candidate-2");
    resolveStatus(STATUS);
    await expect(recovery).resolves.toBeNull();
    expect(invokeMock.mock.calls).toEqual([
      ["plugin_vpn_status"],
      ["plugin_vpn_disconnect", { preserveBlock: false }],
      ["plugin_vpn_apply_finder_profile", { candidateId: "candidate-2" }],
    ]);
    expect(usePluginVpnStore.getState().enabled).toBe(false);

    usePluginVpnStore.getState().setEnabled(true);
    await removePluginVpnProfile();
    expect(usePluginVpnStore.getState().enabled).toBe(false);
    expect(invokeMock).toHaveBeenLastCalledWith("plugin_vpn_remove_profile");
  });

  it("does not restore without a profile or platform support", async () => {
    usePluginVpnStore.getState().setEnabled(true);
    invokeMock.mockResolvedValueOnce({ ...STATUS, profile: null });
    await expect(restorePluginVpnConnection()).resolves.toBeNull();
    invokeMock.mockResolvedValueOnce({ ...STATUS, supported: false });
    await expect(restorePluginVpnConnection()).resolves.toBeNull();
    expect(invokeMock.mock.calls).toEqual([["plugin_vpn_status"], ["plugin_vpn_status"]]);
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

    invokeMock.mockResolvedValueOnce(CONNECTED_STATUS);

    await expect(connectPluginVpn(credentials)).resolves.toEqual(
      CONNECTED_STATUS,
    );

    expect(invokeMock).toHaveBeenCalledWith("plugin_vpn_connect", {
      credentials,
    });
  });

  it("forwards native VPN lifecycle status events", async () => {
    const onEvent = vi.fn();
    const unlisten = vi.fn();
    listenMock.mockImplementationOnce(async (_event, handler) => {
      handler({
        event: "plugin-vpn-status",
        id: 1,
        payload: { kind: "reconnecting", status: RECONNECTING_STATUS },
      } as never);
      handler({
        event: "plugin-vpn-status",
        id: 1,
        payload: { kind: "reconnected", status: CONNECTED_STATUS },
      } as never);
      handler({
        event: "plugin-vpn-status",
        id: 1,
        payload: { kind: "error", status: ERROR_STATUS },
      } as never);
      return unlisten;
    });

    const cleanup = await startPluginVpnStatusListener(onEvent);

    expect(listenMock).toHaveBeenCalledWith(
      "plugin-vpn-status",
      expect.any(Function),
    );
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { kind: "reconnecting", status: RECONNECTING_STATUS },
      { kind: "reconnected", status: CONNECTED_STATUS },
      { kind: "error", status: ERROR_STATUS },
    ]);
    cleanup();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("shows a recovery toast only for a confirmed connected status", () => {
    expect(
      shouldShowPluginVpnReconnectedToast({
        kind: "reconnected",
        status: CONNECTED_STATUS,
      }),
    ).toBe(true);
    expect(
      shouldShowPluginVpnReconnectedToast({
        kind: "reconnected",
        status: RECONNECTING_STATUS,
      }),
    ).toBe(false);
    expect(
      shouldShowPluginVpnReconnectedToast({
        kind: "error",
        status: ERROR_STATUS,
      }),
    ).toBe(false);
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
      queryId: expect.any(String),
    });
  });

  it("cancels the native VPN Gate query when the catalog query stops", async () => {
    let resolveRequest!: (servers: PluginVpnFinderServer[]) => void;
    invokeMock.mockReturnValueOnce(
      new Promise<PluginVpnFinderServer[]>((resolve) => {
        resolveRequest = resolve;
      }),
    );
    const controller = new AbortController();

    const request = loadPluginVpnFinderServers(true, controller.signal);
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    const loadArguments = invokeMock.mock.calls[0]?.[1] as {
      queryId: string;
    };
    expect(invokeMock.mock.calls[1]).toEqual([
      "plugin_vpn_cancel_finder_query",
      { queryId: loadArguments.queryId },
    ]);
    resolveRequest([]);
    await Promise.resolve();
  });

  it("does not start an already cancelled VPN Gate catalog query", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      loadPluginVpnFinderServers(true, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(invokeMock).not.toHaveBeenCalled();
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

  it("disconnects before replacing and connecting a Finder server", async () => {
    invokeMock
      .mockResolvedValueOnce(STATUS)
      .mockResolvedValueOnce(STATUS)
      .mockResolvedValueOnce(CONNECTED_STATUS);
    const onConnecting = vi.fn();

    await expect(
      switchPluginVpnFinderServer("candidate-1", {
        isCurrent: () => true,
        onConnecting,
      }),
    ).resolves.toEqual(CONNECTED_STATUS);

    expect(invokeMock.mock.calls).toEqual([
      ["plugin_vpn_disconnect", { preserveBlock: true }],
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
    expect(onConnecting).toHaveBeenCalledOnce();
  });

  it("does not turn On or disconnect for an already superseded Finder switch", async () => {
    await expect(switchPluginVpnFinderServer("candidate-1", {
      isCurrent: () => false, onConnecting: vi.fn(),
    })).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(usePluginVpnStore.getState().enabled).toBe(false);
  });

  it("does not let automatic recovery reconnect the old profile during a Finder switch", async () => {
    let releaseProfile!: (status: PluginVpnStatus) => void;
    let profileStarted!: () => void;
    const started = new Promise<void>((resolve) => { profileStarted = resolve; });
    invokeMock.mockResolvedValueOnce(STATUS).mockImplementationOnce(() => {
      profileStarted();
      return new Promise((resolve) => { releaseProfile = resolve; });
    }).mockResolvedValueOnce(CONNECTED_STATUS);
    const switching = switchPluginVpnFinderServer("candidate-2", {
      isCurrent: () => true, onConnecting: vi.fn(),
    });
    await started;
    expect(usePluginVpnStore.getState().enabled).toBe(true);
    await expect(restorePluginVpnConnection()).resolves.toBeNull();
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "plugin_vpn_disconnect", "plugin_vpn_apply_finder_profile",
    ]);
    releaseProfile(STATUS);
    await expect(switching).resolves.toEqual(CONNECTED_STATUS);
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "plugin_vpn_disconnect", "plugin_vpn_apply_finder_profile", "plugin_vpn_connect",
    ]);
    invokeMock.mockResolvedValueOnce(CONNECTED_STATUS);
    await expect(restorePluginVpnConnection()).resolves.toBeNull();
    expect(invokeMock).toHaveBeenLastCalledWith("plugin_vpn_status");
  });

  it("stops a superseded Finder switch before replacing the profile", async () => {
    let current = true;
    invokeMock.mockImplementationOnce(async () => {
      current = false;
      return STATUS;
    });
    const onConnecting = vi.fn();

    await expect(
      switchPluginVpnFinderServer("candidate-1", {
        isCurrent: () => current,
        onConnecting,
      }),
    ).resolves.toBeNull();

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("plugin_vpn_disconnect", {
      preserveBlock: true,
    });
    expect(onConnecting).not.toHaveBeenCalled();
  });

  it("stops a superseded Finder switch before connecting", async () => {
    let current = true;
    invokeMock
      .mockResolvedValueOnce(STATUS)
      .mockImplementationOnce(async () => {
        current = false;
        return STATUS;
      });
    const onConnecting = vi.fn();

    await expect(
      switchPluginVpnFinderServer("candidate-1", {
        isCurrent: () => current,
        onConnecting,
      }),
    ).resolves.toBeNull();

    expect(invokeMock.mock.calls).toEqual([
      ["plugin_vpn_disconnect", { preserveBlock: true }],
      ["plugin_vpn_apply_finder_profile", { candidateId: "candidate-1" }],
    ]);
    expect(onConnecting).not.toHaveBeenCalled();
  });

  it("keeps traffic blocked when applying a Finder profile fails", async () => {
    invokeMock
      .mockResolvedValueOnce(STATUS)
      .mockRejectedValueOnce("invalid Finder profile");

    await expect(
      switchPluginVpnFinderServer("candidate-1", {
        isCurrent: () => true,
        onConnecting: vi.fn(),
      }),
    ).rejects.toBe("invalid Finder profile");

    expect(invokeMock.mock.calls).toEqual([
      ["plugin_vpn_disconnect", { preserveBlock: true }],
      ["plugin_vpn_apply_finder_profile", { candidateId: "candidate-1" }],
      ["plugin_vpn_disconnect", { preserveBlock: true }],
    ]);
    expect(usePluginVpnStore.getState().enabled).toBe(true);
  });

  it("rejects a native connect result that is not connected", async () => {
    invokeMock.mockResolvedValueOnce({
      ...STATUS,
      error: "The OpenVPN username is required",
      phase: "disabled",
    });

    await expect(
      connectPluginVpn({
        challengeResponse: "",
        password: "",
        privateKeyPassword: "",
        username: "",
      }),
    ).rejects.toThrow("The OpenVPN username is required");
    expect(invokeMock.mock.calls).toEqual([
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
      ["plugin_vpn_disconnect", { preserveBlock: true }],
    ]);
  });

  it("uses a typed error when a failed native result has no reason", async () => {
    invokeMock.mockResolvedValueOnce(STATUS);

    await expect(
      connectPluginVpn({
        challengeResponse: "",
        password: "password",
        privateKeyPassword: "",
        username: "reader",
      }),
    ).rejects.toBeInstanceOf(PluginVpnConnectionNotEstablishedError);
  });

  it("cancels a rejected native connection while preserving its error", async () => {
    invokeMock.mockRejectedValueOnce("native connection failed");

    await expect(
      connectPluginVpn({
        challengeResponse: "",
        password: "password",
        privateKeyPassword: "",
        username: "reader",
      }),
    ).rejects.toBe("native connection failed");

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "plugin_vpn_connect",
      "plugin_vpn_disconnect",
    ]);
    expect(usePluginVpnStore.getState().enabled).toBe(true);
    expect(invokeMock).toHaveBeenLastCalledWith("plugin_vpn_disconnect", { preserveBlock: true });
    await disconnectPluginVpn();
    expect(invokeMock).toHaveBeenLastCalledWith("plugin_vpn_disconnect", { preserveBlock: false });
    expect(usePluginVpnStore.getState().enabled).toBe(false);
  });

  it("does not start a superseded connection after proxy preparation", async () => {
    await expect(
      connectPluginVpn(
        {
          challengeResponse: "",
          password: "password",
          privateKeyPassword: "",
          username: "reader",
        },
        () => false,
      ),
    ).resolves.toBeNull();

    expect(invokeMock).not.toHaveBeenCalled();
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

  it("allows a restored Finder profile without stored credentials", () => {
    const credentials: PluginVpnCredentials = {
      challengeResponse: "",
      password: "",
      privateKeyPassword: "",
      username: "",
    };
    const restoredFinder = {
      ...STATUS,
      profile: {
        ...STATUS.profile!,
        isVpnGateFinder: true,
      },
    };

    expect(canStartPluginVpnConnection(restoredFinder, credentials)).toBe(true);
  });

  it("exposes a stored server IP only for Finder profiles", () => {
    expect(pluginVpnFinderProfileIp(STATUS.profile)).toBeNull();
    expect(
      pluginVpnFinderProfileIp({
        ...STATUS.profile!,
        isVpnGateFinder: true,
        remoteHost: "198.51.100.20",
      }),
    ).toBe("198.51.100.20");
    expect(pluginVpnFinderProfileIp(null)).toBeNull();
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
    invokeMock
      .mockResolvedValueOnce(STATUS)
      .mockResolvedValueOnce(CONNECTED_STATUS);
    await expect(connectPluginVpn(credentials)).resolves.toEqual(
      CONNECTED_STATUS,
    );

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
