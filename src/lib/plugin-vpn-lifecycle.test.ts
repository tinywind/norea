import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const recovery = vi.hoisted(() => ({ stopped: false }));

vi.mock("./plugin-vpn", async (importOriginal) => ({
  ...await importOriginal<typeof import("./plugin-vpn")>(),
  getPluginVpnStatus: vi.fn(),
  isPluginVpnRecoveryStopped: () => recovery.stopped,
  releasePluginVpnRecoveryProfile: vi.fn(),
  replacePluginVpnRecoveryProfile: vi.fn(),
  restorePluginVpnConnection: vi.fn(),
  resumePluginVpnRecovery: () => { recovery.stopped = false; },
  startPluginVpnStatusListener: vi.fn(),
}));

vi.mock("./plugin-vpn-profiles", () => ({ listSavedPluginVpnProfiles: vi.fn() }));

import {
  getPluginVpnStatus,
  recordPluginVpnProfileSuccess,
  releasePluginVpnRecoveryProfile,
  replacePluginVpnRecoveryProfile,
  restorePluginVpnConnection,
  startPluginVpnStatusListener,
  type PluginVpnStatus,
  type PluginVpnStatusEvent,
} from "./plugin-vpn";
import { listSavedPluginVpnProfiles, type SavedVpnProfile } from "./plugin-vpn-profiles";
import { requestPluginVpnRecovery, startPluginVpnLifecycle } from "./plugin-vpn-lifecycle";
import { useNetworkStore } from "./network";
import { usePluginVpnStore } from "../store/plugin-vpn";

const restoreMock = vi.mocked(restorePluginVpnConnection);
const statusListenerMock = vi.mocked(startPluginVpnStatusListener);
const statusMock = vi.mocked(getPluginVpnStatus);
const replaceMock = vi.mocked(replacePluginVpnRecoveryProfile);
const releaseMock = vi.mocked(releasePluginVpnRecoveryProfile);
const vaultMock = vi.mocked(listSavedPluginVpnProfiles);
const CONNECTED_STATUS: PluginVpnStatus = {
  error: null,
  phase: "connected",
  profile: { hash: "a".repeat(64), isVpnGateFinder: true, remoteHost: "203.0.113.10", requiresUsernamePassword: false },
  proxyPort: 43127,
  supported: true,
};

const ERROR_STATUS: PluginVpnStatus = {
  ...CONNECTED_STATUS,
  error: "OpenVPN connection failed (CONNECTION_TIMEOUT)",
  phase: "error",
};

describe("plugin VPN app lifecycle", () => {
  let visibility: DocumentVisibilityState;
  let stop: (() => void) | undefined;
  let emitStatus: ((event: PluginVpnStatusEvent) => void) | undefined;
  let unlisten: Mock<() => void>;

  beforeEach(() => {
    useNetworkStore.setState({ connectivity: "online", revision: 1 });
    usePluginVpnStore.getState().setEnabled(true);
    visibility = "visible";
    const documentTarget = new EventTarget();
    Object.defineProperty(documentTarget, "visibilityState", { get: () => visibility });
    vi.stubGlobal("document", documentTarget);
    vi.stubGlobal("window", new EventTarget());
    restoreMock.mockReset().mockResolvedValue(null);
    recovery.stopped = false;
    statusMock.mockReset().mockRejectedValue(new Error("status unavailable"));
    replaceMock.mockReset().mockResolvedValue(true);
    releaseMock.mockReset().mockImplementation(async () => { recovery.stopped = true; return true; });
    vaultMock.mockReset().mockResolvedValue({ limit: 20, profiles: [], cleanupError: null });
    unlisten = vi.fn<() => void>();
    statusListenerMock.mockReset().mockImplementation(async (onEvent) => {
      emitStatus = onEvent;
      return unlisten;
    });
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    emitStatus = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("checks startup and visible resume signals but ignores hidden focus events", async () => {
    stop = startPluginVpnLifecycle({ onRestored: vi.fn(), onError: vi.fn() });
    await Promise.resolve();
    expect(restoreMock).toHaveBeenCalledTimes(1);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    expect(restoreMock).toHaveBeenCalledTimes(1);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    window.dispatchEvent(new Event("norea-app-resumed"));
    await Promise.resolve();
    expect(restoreMock).toHaveBeenCalledTimes(4);
  });

  it("coalesces overlapping resume events and reports one confirmed recovery", async () => {
    let complete!: (status: PluginVpnStatus) => void;
    restoreMock.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const onRestored = vi.fn();
    stop = startPluginVpnLifecycle({ onRestored, onError: vi.fn() });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("norea-app-resumed"));
    expect(restoreMock).toHaveBeenCalledTimes(1);

    complete(CONNECTED_STATUS);
    await Promise.resolve();
    expect(onRestored).toHaveBeenCalledExactlyOnceWith(CONNECTED_STATUS);
  });

  it("keeps the recovery backoff when a foreground event arrives", async () => {
    const error = new Error("network unavailable");
    restoreMock.mockRejectedValueOnce(error);
    const onError = vi.fn();
    stop = startPluginVpnLifecycle({ onRestored: vi.fn(), onError });
    await Promise.resolve();
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);

    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(restoreMock).toHaveBeenCalledTimes(1);
  });

  it("retries a failed recovery with backoff and reports the failure once", async () => {
    vi.useFakeTimers();
    const error = new Error("OpenVPN connection failed (CONNECTION_TIMEOUT)");
    restoreMock
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(CONNECTED_STATUS);
    const onError = vi.fn();
    const onRestored = vi.fn();
    stop = startPluginVpnLifecycle({ onRestored, onError });
    await vi.advanceTimersByTimeAsync(0);
    expect(restoreMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(restoreMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(restoreMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(restoreMock).toHaveBeenCalledTimes(3);

    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(onRestored).toHaveBeenCalledExactlyOnceWith(CONNECTED_STATUS);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(restoreMock).toHaveBeenCalledTimes(3);
  });

  it("restores immediately when the running session reports an error", async () => {
    stop = startPluginVpnLifecycle({ onRestored: vi.fn(), onError: vi.fn() });
    await Promise.resolve();
    expect(restoreMock).toHaveBeenCalledTimes(1);

    emitStatus?.({ kind: "reconnecting", status: ERROR_STATUS });
    expect(restoreMock).toHaveBeenCalledTimes(1);
    emitStatus?.({ kind: "error", status: ERROR_STATUS });
    expect(restoreMock).toHaveBeenCalledTimes(2);
  });

  it("stops retrying once there is nothing left to restore", async () => {
    vi.useFakeTimers();
    restoreMock
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(null);
    stop = startPluginVpnLifecycle({ onRestored: vi.fn(), onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(restoreMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(restoreMock).toHaveBeenCalledTimes(2);
  });

  it("cancels scheduled retries and the status listener on teardown", async () => {
    vi.useFakeTimers();
    restoreMock.mockRejectedValue(new Error("network unavailable"));
    stop = startPluginVpnLifecycle({ onRestored: vi.fn(), onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    stop = undefined;

    await vi.advanceTimersByTimeAsync(120_000);
    emitStatus?.({ kind: "error", status: ERROR_STATUS });
    expect(restoreMock).toHaveBeenCalledTimes(1);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("lets background traffic request recovery without bypassing backoff", async () => {
    vi.useFakeTimers();
    visibility = "hidden";
    restoreMock.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(CONNECTED_STATUS);
    stop = startPluginVpnLifecycle({ onRestored: vi.fn(), onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    requestPluginVpnRecovery();
    requestPluginVpnRecovery();
    await vi.advanceTimersByTimeAsync(0);
    expect(restoreMock).toHaveBeenCalledTimes(2);
    for (let count = 0; count < 10; count += 1) requestPluginVpnRecovery();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(restoreMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(restoreMock).toHaveBeenCalledTimes(3);
    stop();
    requestPluginVpnRecovery();
    expect(restoreMock).toHaveBeenCalledTimes(3);
  });

  it("responds only to effective native connectivity while hidden", async () => {
    visibility = "hidden";
    stop = startPluginVpnLifecycle({ onRestored: vi.fn(), onError: vi.fn() });
    await Promise.resolve();
    window.dispatchEvent(new Event("online"));
    expect(restoreMock).toHaveBeenCalledTimes(1);
    useNetworkStore.setState({ connectivity: "offline", revision: 2 });
    useNetworkStore.setState({ connectivity: "online", revision: 3 });
    expect(restoreMock).toHaveBeenCalledTimes(2);
    stop();
    window.dispatchEvent(new Event("online"));
    expect(restoreMock).toHaveBeenCalledTimes(2);
  });

  it("stops recovery timers offline and reconnects once when internet returns", async () => {
    vi.useFakeTimers();
    restoreMock.mockRejectedValueOnce(new Error("CONNECTION_TIMEOUT")).mockResolvedValue(CONNECTED_STATUS);
    stop = startPluginVpnLifecycle({ onRestored: vi.fn(), onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    useNetworkStore.setState({ connectivity: "offline", revision: 2 });
    await vi.advanceTimersByTimeAsync(600_000);
    requestPluginVpnRecovery();
    expect(restoreMock).toHaveBeenCalledTimes(1);
    useNetworkStore.setState({ connectivity: "online", revision: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(restoreMock).toHaveBeenCalledTimes(2);
  });

  it("does not schedule retries for authentication failures", async () => {
    vi.useFakeTimers();
    restoreMock.mockRejectedValue(new Error("AUTH_FAILED"));
    stop = startPluginVpnLifecycle({ onRestored: vi.fn(), onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(restoreMock).toHaveBeenCalledTimes(1);
  });

  describe("profile failover", () => {
    const timeout = new Error("OpenVPN connection failed (CONNECTION_TIMEOUT)");
    const saved = (name: string, approvalSequence: number): SavedVpnProfile => ({
      id: name.repeat(64), hash: name.repeat(64), ip: `198.51.100.${approvalSequence}`, protocol: "tcp", approvedAt: approvalSequence, approvalSequence,
    });
    const failing = saved("a", 1);
    const statusFor = (profile: SavedVpnProfile): PluginVpnStatus => ({
      ...ERROR_STATUS, phase: "disabled", profile: { ...CONNECTED_STATUS.profile!, hash: profile.hash, remoteHost: profile.ip },
    });

    it("switches to the most recently successful retained profile after three failures of the same profile", async () => {
      vi.useFakeTimers();
      const older = saved("b", 2); const succeeded = saved("c", 3); const newest = saved("d", 4);
      recordPluginVpnProfileSuccess(succeeded.hash);
      vaultMock.mockResolvedValue({ limit: 20, profiles: [failing, older, newest, succeeded], cleanupError: null });
      statusMock.mockResolvedValue(statusFor(failing));
      restoreMock.mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout);
      replaceMock.mockImplementationOnce(async () => { statusMock.mockResolvedValue(statusFor(succeeded)); return true; });
      restoreMock.mockRejectedValueOnce(timeout).mockResolvedValueOnce(CONNECTED_STATUS);
      const onError = vi.fn(); const onRestored = vi.fn(); const onStopped = vi.fn();
      stop = startPluginVpnLifecycle({ onRestored, onError, onStopped });
      await vi.advanceTimersByTimeAsync(5_000 + 15_000);
      expect(restoreMock).toHaveBeenCalledTimes(4);
      expect(replaceMock.mock.calls).toEqual([[succeeded]]);
      // The replacement starts its own failure count instead of switching again.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(restoreMock).toHaveBeenCalledTimes(5);
      expect(replaceMock).toHaveBeenCalledTimes(1);
      expect(onRestored).toHaveBeenCalledExactlyOnceWith(CONNECTED_STATUS);
      expect(onError).toHaveBeenCalledOnce();
      expect(onStopped).not.toHaveBeenCalled();
      expect(releaseMock).not.toHaveBeenCalled();
    });

    it("skips a candidate that a download worker leases", async () => {
      vi.useFakeTimers();
      const leased = saved("e", 3); const idle = saved("f", 2);
      vaultMock.mockResolvedValue({ limit: 20, profiles: [failing, leased, idle], cleanupError: null });
      statusMock.mockResolvedValue(statusFor(failing));
      restoreMock.mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout).mockResolvedValueOnce(CONNECTED_STATUS);
      replaceMock.mockRejectedValueOnce(new Error("VPN profile is reserved by a download worker"));
      stop = startPluginVpnLifecycle({ onRestored: vi.fn(), onError: vi.fn(), onStopped: vi.fn() });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(replaceMock.mock.calls).toEqual([[leased], [idle]]);
      expect(restoreMock).toHaveBeenCalledTimes(4);
    });

    it("releases the profile and notifies once when no other retained profile remains", async () => {
      vi.useFakeTimers();
      const other = saved("b", 2);
      vaultMock.mockResolvedValue({ limit: 20, profiles: [failing, other], cleanupError: null });
      statusMock.mockResolvedValue(statusFor(failing));
      restoreMock.mockRejectedValue(timeout);
      replaceMock.mockImplementation(async () => { statusMock.mockResolvedValue(statusFor(other)); return true; });
      const onStopped = vi.fn(); const onError = vi.fn();
      stop = startPluginVpnLifecycle({ onRestored: vi.fn(), onError, onStopped });
      await vi.advanceTimersByTimeAsync(600_000);
      // Three attempts per profile, then the second pass excludes both failed profiles.
      expect(restoreMock).toHaveBeenCalledTimes(6);
      expect(replaceMock.mock.calls).toEqual([[other]]);
      expect(releaseMock).toHaveBeenCalledOnce();
      expect(onStopped).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledOnce();
      window.dispatchEvent(new Event("focus"));
      requestPluginVpnRecovery();
      emitStatus?.({ kind: "error", status: ERROR_STATUS });
      await vi.advanceTimersByTimeAsync(600_000);
      expect(restoreMock).toHaveBeenCalledTimes(6);
    });

    it("resumes stopped recovery on a new network route", async () => {
      vi.useFakeTimers();
      statusMock.mockResolvedValue(statusFor(failing));
      vaultMock.mockResolvedValue({ limit: 20, profiles: [failing], cleanupError: null });
      restoreMock.mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout).mockResolvedValueOnce(CONNECTED_STATUS);
      const onRestored = vi.fn();
      stop = startPluginVpnLifecycle({ onRestored, onError: vi.fn(), onStopped: vi.fn() });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(releaseMock).toHaveBeenCalledOnce();
      expect(restoreMock).toHaveBeenCalledTimes(3);
      useNetworkStore.setState({ connectivity: "online", revision: 2 });
      await vi.advanceTimersByTimeAsync(0);
      expect(restoreMock).toHaveBeenCalledTimes(4);
      expect(onRestored).toHaveBeenCalledExactlyOnceWith(CONNECTED_STATUS);
    });

    it("does not switch profiles after an explicit Off supersedes the failover", async () => {
      vi.useFakeTimers();
      vaultMock.mockResolvedValue({ limit: 20, profiles: [failing, saved("b", 2)], cleanupError: null });
      statusMock.mockResolvedValue(statusFor(failing));
      restoreMock.mockRejectedValue(timeout);
      replaceMock.mockResolvedValue(false);
      const onStopped = vi.fn();
      stop = startPluginVpnLifecycle({ onRestored: vi.fn(), onError: vi.fn(), onStopped });
      await vi.advanceTimersByTimeAsync(600_000);
      expect(restoreMock).toHaveBeenCalledTimes(3);
      expect(releaseMock).not.toHaveBeenCalled();
      expect(onStopped).not.toHaveBeenCalled();
    });
  });

  it("removes resume listeners and ignores completion after teardown", async () => {
    let complete!: (status: PluginVpnStatus) => void;
    restoreMock.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const onRestored = vi.fn();
    stop = startPluginVpnLifecycle({ onRestored, onError: vi.fn() });
    stop();
    complete(CONNECTED_STATUS);
    await Promise.resolve();
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("norea-app-resumed"));
    expect(onRestored).not.toHaveBeenCalled();
    expect(restoreMock).toHaveBeenCalledTimes(1);
  });
});
