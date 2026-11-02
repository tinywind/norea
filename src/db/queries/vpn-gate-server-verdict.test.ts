import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("../client", () => ({
  getDb: vi.fn(),
  runExclusiveDatabaseOperation: vi.fn((run: () => Promise<unknown>) => run()),
}));

import { getDb } from "../client";
import { invoke } from "@tauri-apps/api/core";
import {
  listVpnGateServerVerdicts,
  setVpnGateServerVerdict,
} from "./vpn-gate-server-verdict";

const mockedGetDb = vi.mocked(getDb);
let mockSelect: ReturnType<typeof vi.fn>;
let mockExecute: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockReset();
  mockSelect = vi.fn();
  mockExecute = vi.fn();
  mockedGetDb.mockResolvedValue({
    select: mockSelect,
    execute: mockExecute,
  } as never);
});

describe("listVpnGateServerVerdicts", () => {
  it("returns the latest persisted verdict for each IP address", async () => {
    mockSelect.mockResolvedValueOnce([
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

    const [sql] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("FROM vpn_gate_server_verdict");
    expect(sql).toContain("updated_at AS updatedAt");
    expect(sql).toContain("ORDER BY ip");
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
      verdict: { ip: "198.51.100.4", verdict: "works", updatedAt: 456 },
      savedProfile: { id: "a".repeat(64), hash: "a".repeat(64), ip: "198.51.100.4", protocol: "tcp", approvedAt: 456, approvalSequence: 1 },
      cleanupError: null,
    };
    vi.mocked(invoke).mockResolvedValueOnce(result);
    await expect(setVpnGateServerVerdict("198.51.100.4", "works", {
      kind: "finder", candidateId: "tcp-candidate",
    })).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledWith("plugin_vpn_capture_saved_profile", {
      ip: "198.51.100.4", source: { kind: "finder", candidateId: "tcp-candidate" },
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it.each(["fails", null] as const)("revokes before reporting %s", async (verdict) => {
    const result = { verdict: verdict === null ? null : { ip: "203.0.113.9", verdict, updatedAt: 456 }, savedProfile: null, cleanupError: "file could not be deleted" };
    vi.mocked(invoke).mockResolvedValueOnce(result);
    await expect(setVpnGateServerVerdict("203.0.113.9", verdict)).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledWith("plugin_vpn_revoke_saved_profile", { ip: "203.0.113.9", verdict });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("never fabricates a successful saved O when exact bytes are unavailable", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("candidate is no longer available");
    await expect(setVpnGateServerVerdict("198.51.100.4", "works", { kind: "finder", candidateId: "expired" })).rejects.toBe("candidate is no longer available");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("requires an explicit capture source for O instead of falling back", async () => {
    await expect(setVpnGateServerVerdict("198.51.100.4", "works")).rejects.toThrow("exact profile");
    expect(invoke).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
