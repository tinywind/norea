import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import ko from "../../strings/languages/ko/app.json";

const recovery = vi.hoisted(() => ({ stopped: false }));

vi.mock("./tauri-runtime", () => ({ isAndroidRuntime: () => true }));
vi.mock("./plugin-vpn", async (importOriginal) => ({
  ...await importOriginal<typeof import("./plugin-vpn")>(),
  getPluginVpnStatus: vi.fn(),
  isPluginVpnRecoveryStopped: () => recovery.stopped,
  startPluginVpnStatusListener: vi.fn(),
}));

import {
  getPluginVpnStatus,
  PLUGIN_VPN_CONNECTION_SETTLED_EVENT,
  PLUGIN_VPN_PROFILE_RELEASED_EVENT,
  startPluginVpnStatusListener,
  type PluginVpnPhase,
  type PluginVpnStatus,
  type PluginVpnStatusEvent,
} from "./plugin-vpn";
import { shouldKeepPluginVpnAlive, startAndroidPluginVpnKeepAlive } from "./plugin-vpn-keep-alive";
import { useAppearanceStore } from "../store/appearance";
import { usePluginVpnStore } from "../store/plugin-vpn";

const statusMock = vi.mocked(getPluginVpnStatus);
const statusListenerMock = vi.mocked(startPluginVpnStatusListener);

const CONNECTED: PluginVpnStatus = {
  error: null,
  phase: "connected",
  profile: { hash: "a".repeat(64), isVpnGateFinder: true, remoteHost: "203.0.113.10", requiresUsernamePassword: false },
  proxyPort: 43127,
  supported: true,
};
const AUTH_FAILED: PluginVpnStatus = { ...CONNECTED, error: "OpenVPN authentication failed (AUTH_FAILED)", phase: "disabled" };
const ACTIVE_PAYLOAD = {
  active: true,
  title: "Plugin VPN connected",
  body: "203.0.113.10",
  channelName: "Plugin VPN",
  channelDescription: "Keeps the plugin VPN connected while Norea is in the background.",
};

describe("plugin VPN keep-alive decision", () => {
  it("keeps every phase of a requested connection alive", () => {
    const phases: PluginVpnPhase[] = ["disabled", "connecting", "connected", "reconnecting", "disconnecting", "waitingForNetwork"];
    for (const phase of phases) {
      expect(shouldKeepPluginVpnAlive(true, false, { ...CONNECTED, phase })).toBe(true);
    }
  });

  it("keeps a retryable failure alive for automatic recovery", () => {
    const status: PluginVpnStatus = { ...CONNECTED, error: "OpenVPN connection failed (CONNECTION_TIMEOUT)", phase: "error" };
    expect(shouldKeepPluginVpnAlive(true, false, status)).toBe(true);
  });

  it("stops when the VPN is off, released, removed, unsupported, or failed terminally", () => {
    expect(shouldKeepPluginVpnAlive(false, false, CONNECTED)).toBe(false);
    expect(shouldKeepPluginVpnAlive(true, true, CONNECTED)).toBe(false);
    expect(shouldKeepPluginVpnAlive(true, false, { ...CONNECTED, profile: null })).toBe(false);
    expect(shouldKeepPluginVpnAlive(true, false, { ...CONNECTED, supported: false })).toBe(false);
    expect(shouldKeepPluginVpnAlive(true, false, AUTH_FAILED)).toBe(false);
    expect(shouldKeepPluginVpnAlive(true, false, { ...AUTH_FAILED, phase: "error" })).toBe(false);
  });
});

describe("Android plugin VPN keep-alive service", () => {
  let update: Mock<(payload: string) => void>;
  let emitStatus: ((event: PluginVpnStatusEvent) => void) | undefined;
  let stop: (() => void) | undefined;

  const published = () => update.mock.calls.map(([payload]) => JSON.parse(payload) as unknown);
  const settle = async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  };

  beforeEach(() => {
    recovery.stopped = false;
    usePluginVpnStore.getState().setEnabled(true);
    useAppearanceStore.setState({ appLocale: "en" });
    update = vi.fn<(payload: string) => void>();
    vi.stubGlobal("window", Object.assign(new EventTarget(), { __NoreaAndroidPluginVpnKeepAlive: { update } }));
    statusMock.mockReset().mockResolvedValue(CONNECTED);
    statusListenerMock.mockReset().mockImplementation(async (onEvent) => {
      emitStatus = onEvent;
      return () => undefined;
    });
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    emitStatus = undefined;
    vi.unstubAllGlobals();
  });

  it("starts with the server host while the VPN is on and publishes each change once", async () => {
    stop = startAndroidPluginVpnKeepAlive();
    await settle();
    expect(published()).toEqual([ACTIVE_PAYLOAD]);

    emitStatus?.({ kind: "reconnected", status: CONNECTED });
    await settle();
    expect(update).toHaveBeenCalledTimes(1);

    usePluginVpnStore.getState().setEnabled(false);
    await settle();
    expect(published()).toEqual([ACTIVE_PAYLOAD, { active: false }]);
  });

  it("stops after a connection attempt fails terminally", async () => {
    stop = startAndroidPluginVpnKeepAlive();
    await settle();
    statusMock.mockResolvedValue(AUTH_FAILED);
    window.dispatchEvent(new Event(PLUGIN_VPN_CONNECTION_SETTLED_EVENT));
    await settle();
    expect(published()).toEqual([ACTIVE_PAYLOAD, { active: false }]);
  });

  it("stops when automatic recovery releases the profile", async () => {
    stop = startAndroidPluginVpnKeepAlive();
    await settle();
    recovery.stopped = true;
    window.dispatchEvent(new Event(PLUGIN_VPN_PROFILE_RELEASED_EVENT));
    await settle();
    expect(published()).toEqual([ACTIVE_PAYLOAD, { active: false }]);
  });

  it("applies only the latest status when checks overlap", async () => {
    let first!: (status: PluginVpnStatus) => void;
    statusMock.mockReturnValueOnce(new Promise((resolve) => { first = resolve; }));
    statusMock.mockResolvedValueOnce(AUTH_FAILED);
    stop = startAndroidPluginVpnKeepAlive();
    window.dispatchEvent(new Event(PLUGIN_VPN_CONNECTION_SETTLED_EVENT));
    await settle();
    first(CONNECTED);
    await settle();
    expect(published()).toEqual([{ active: false }]);
  });

  it("retries the start on resume and stops the service on cleanup", async () => {
    stop = startAndroidPluginVpnKeepAlive();
    await settle();
    window.dispatchEvent(new Event("norea-app-resumed"));
    await settle();
    expect(published()).toEqual([ACTIVE_PAYLOAD, ACTIVE_PAYLOAD]);

    stop();
    stop = undefined;
    expect(published().at(-1)).toEqual({ active: false });
  });

  it("localizes the notification text", async () => {
    useAppearanceStore.setState({ appLocale: "ko" });
    stop = startAndroidPluginVpnKeepAlive();
    await settle();
    expect(published()).toEqual([{
      ...ACTIVE_PAYLOAD,
      title: ko["pluginVpn.notification.title"],
      channelName: ko["pluginVpn.notification.channel"],
      channelDescription: ko["pluginVpn.notification.channelDescription"],
    }]);
  });
});
