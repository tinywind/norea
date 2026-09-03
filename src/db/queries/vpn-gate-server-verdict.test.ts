import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../client";
import {
  listVpnGateServerVerdicts,
  setVpnGateServerVerdict,
} from "./vpn-gate-server-verdict";

const mockedGetDb = vi.mocked(getDb);
let mockSelect: ReturnType<typeof vi.fn>;
let mockExecute: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
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
  it("upserts one latest verdict per IP address", async () => {
    mockExecute.mockResolvedValueOnce(undefined);

    await setVpnGateServerVerdict("198.51.100.4", "works");

    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain(
      "INSERT INTO vpn_gate_server_verdict (ip, verdict)",
    );
    expect(sql).toContain("ON CONFLICT(ip) DO UPDATE");
    expect(sql).toContain("verdict = excluded.verdict");
    expect(sql).toContain("updated_at = unixepoch()");
    expect(params).toEqual(["198.51.100.4", "works"]);
  });

  it("deletes the persisted verdict when it is cleared", async () => {
    mockExecute.mockResolvedValueOnce(undefined);

    await setVpnGateServerVerdict("203.0.113.9", null);

    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("DELETE FROM vpn_gate_server_verdict");
    expect(sql).toContain("WHERE ip = $1");
    expect(params).toEqual(["203.0.113.9"]);
  });
});
