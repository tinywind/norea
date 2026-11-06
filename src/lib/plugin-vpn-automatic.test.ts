import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../db/client", () => ({ runExclusiveDatabaseOperation: vi.fn() }));
vi.mock("./plugin-vpn-profiles", () => ({ syncStoredPluginVpnProfiles: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { cancelAutomaticPluginVpnCandidateTests, testAutomaticPluginVpnCandidate } from "./plugin-vpn-automatic";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("automatic VPN candidate cancellation", () => {
  it("does not start a probe whose signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.mocked(invoke).mockResolvedValue(true);

    await expect(testAutomaticPluginVpnCandidate("candidate", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("cancels a reservation without opening a tunnel when stopped during preparation", async () => {
    const preparation = deferred<void>();
    const controller = new AbortController();
    vi.mocked(invoke).mockImplementation((command) =>
      (command === "plugin_vpn_prepare_automatic_candidate_test" ? preparation.promise : Promise.resolve(true)) as Promise<never>);
    const result = testAutomaticPluginVpnCandidate("candidate", controller.signal);
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });

    controller.abort();
    preparation.resolve();
    await rejection;

    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
      "plugin_vpn_prepare_automatic_candidate_test", "plugin_vpn_cancel_automatic_candidate_test",
    ]);
  });

  it("waits for native cleanup and discards a late successful probe after cancellation", async () => {
    const test = deferred<boolean>();
    const cleanup = deferred<void>();
    const controller = new AbortController();
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "plugin_vpn_test_automatic_candidate") return test.promise as Promise<never>;
      if (command === "plugin_vpn_cancel_automatic_candidate_test") return cleanup.promise as Promise<never>;
      return Promise.resolve(undefined) as Promise<never>;
    });

    const result = testAutomaticPluginVpnCandidate("candidate", controller.signal);
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("plugin_vpn_test_automatic_candidate", expect.objectContaining({ candidateId: "candidate" })));
    controller.abort();
    test.resolve(true);
    let finished = false;
    void result.then(() => { finished = true; }, () => { finished = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);

    cleanup.resolve();
    await rejection;
    const testArgs = vi.mocked(invoke).mock.calls.find(([command]) => command === "plugin_vpn_test_automatic_candidate")![1];
    expect(invoke).toHaveBeenCalledWith("plugin_vpn_cancel_automatic_candidate_test", { probeId: (testArgs as { probeId: string }).probeId });
  });

  it("reports cancellation when the native start arrives after its reservation was cancelled", async () => {
    let rejectTest!: (error: Error) => void;
    const test = new Promise<boolean>((_resolve, reject) => { rejectTest = reject; });
    const controller = new AbortController();
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "plugin_vpn_test_automatic_candidate") return test as Promise<never>;
      return Promise.resolve(undefined) as Promise<never>;
    });
    const result = testAutomaticPluginVpnCandidate("candidate", controller.signal);
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("plugin_vpn_test_automatic_candidate", expect.anything()));

    controller.abort();
    rejectTest(new Error("automatic VPN candidate test is not registered"));
    await rejection;
  });

  it("cancels every active probe and waits for their cleanup before returning", async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === "plugin_vpn_test_automatic_candidate") return ((args as { candidateId: string }).candidateId === "first" ? first.promise : second.promise) as Promise<never>;
      return Promise.resolve(undefined) as Promise<never>;
    });
    const firstRun = testAutomaticPluginVpnCandidate("first");
    const secondRun = testAutomaticPluginVpnCandidate("second");
    const firstRejection = expect(firstRun).rejects.toMatchObject({ name: "AbortError" });
    const secondRejection = expect(secondRun).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "plugin_vpn_test_automatic_candidate")).toHaveLength(2));

    let stopped = false;
    const stop = cancelAutomaticPluginVpnCandidateTests().then(() => { stopped = true; });
    first.resolve(false);
    await firstRejection;
    expect(stopped).toBe(false);
    second.resolve(false);
    await secondRejection;
    await stop;

    expect(stopped).toBe(true);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "plugin_vpn_cancel_automatic_candidate_test")).toHaveLength(2);
  });

  it("keeps the cleanup error when a cancelled tunnel cannot be confirmed stopped", async () => {
    const test = deferred<boolean>();
    const controller = new AbortController();
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "plugin_vpn_test_automatic_candidate") return test.promise as Promise<never>;
      if (command === "plugin_vpn_cancel_automatic_candidate_test") return Promise.reject(new Error("probe cleanup failed"));
      return Promise.resolve(undefined) as Promise<never>;
    });
    const result = testAutomaticPluginVpnCandidate("candidate", controller.signal);
    const rejection = expect(result).rejects.toThrow("probe cleanup failed");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("plugin_vpn_test_automatic_candidate", expect.anything()));

    controller.abort();
    test.resolve(false);
    await rejection;
  });
});
