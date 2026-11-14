import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { createTauriInvokeRouter } from "../../test/mock-tauri-invoke";
import {
  listVpnGateServerVerdicts,
  setVpnGateServerVerdict,
} from "./vpn-gate-server-verdict";

const invokeMock = vi.mocked(invoke);
const router = createTauriInvokeRouter();

beforeEach(() => {
  vi.clearAllMocks();
  router.reset();
  router.installOn(invokeMock);
});

describe("listVpnGateServerVerdicts", () => {
  it("returns the latest persisted verdict for each IP address from db_vpn_list_verdicts", async () => {
    router.mockQuery("db_vpn_list_verdicts", [
      {
        ip: "198.51.100.4",
        verdict: "works",
        updatedAt: 123,
      },
      {
        ip: "203.0.113.9",
        verdict: "fails",
        updatedAt: 456,
      },
    ]);

    const rows = await listVpnGateServerVerdicts();

    expect(router.calls).toEqual([
      { command: "db_vpn_list_verdicts", args: undefined, options: undefined },
    ]);
    expect(rows).toEqual([
      {
        ip: "198.51.100.4",
        verdict: "works",
        updatedAt: 123,
      },
      {
        ip: "203.0.113.9",
        verdict: "fails",
        updatedAt: 456,
      },
    ]);
  });
});

describe("setVpnGateServerVerdict", () => {
  it("publishes O only through native capture of the exact Finder candidate", async () => {
    const result = {
      verdict: {
        ip: "198.51.100.4",
        verdict: "works" as const,
        updatedAt: 456,
      },
      savedProfile: {
        id: "a".repeat(64),
        hash: "a".repeat(64),
        ip: "198.51.100.4",
        protocol: "tcp" as const,
        approvedAt: 456,
        approvalSequence: 1,
      },
      cleanupError: null,
    };
    router.handle("plugin_vpn_capture_saved_profile", () => result);

    await expect(
      setVpnGateServerVerdict("198.51.100.4", "works", {
        kind: "finder",
        candidateId: "tcp-candidate",
      }),
    ).resolves.toEqual(result);
    expect(router.calls).toEqual([
      {
        command: "plugin_vpn_capture_saved_profile",
        args: {
          ip: "198.51.100.4",
          source: { kind: "finder", candidateId: "tcp-candidate" },
        },
        options: undefined,
      },
    ]);
  });

  it.each(["fails", null] as const)(
    "revokes before reporting %s",
    async (verdict) => {
      const result = {
        verdict:
          verdict === null
            ? null
            : { ip: "203.0.113.9", verdict, updatedAt: 456 },
        savedProfile: null,
        cleanupError: "file could not be deleted",
      };
      router.handle("plugin_vpn_revoke_saved_profile", () => result);

      await expect(
        setVpnGateServerVerdict("203.0.113.9", verdict),
      ).resolves.toEqual(result);
      expect(router.calls).toEqual([
        {
          command: "plugin_vpn_revoke_saved_profile",
          args: { ip: "203.0.113.9", verdict },
          options: undefined,
        },
      ]);
    },
  );

  it("never fabricates a successful saved O when exact bytes are unavailable", async () => {
    router.handle("plugin_vpn_capture_saved_profile", () =>
      Promise.reject("candidate is no longer available"),
    );

    await expect(
      setVpnGateServerVerdict("198.51.100.4", "works", {
        kind: "finder",
        candidateId: "expired",
      }),
    ).rejects.toBe("candidate is no longer available");
  });

  it("requires an explicit capture source for O instead of falling back", async () => {
    await expect(
      setVpnGateServerVerdict("198.51.100.4", "works"),
    ).rejects.toThrow("exact profile");
    expect(router.calls).toHaveLength(0);
  });
});
