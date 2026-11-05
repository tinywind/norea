import { describe, expect, it } from "vitest";
import { toggledVpnGateServerVerdict } from "./VpnGateServerVerdictControl";

describe("VpnGateServerVerdictControl", () => {
  it("sets the pressed list entry and clears it when pressed again", () => {
    expect(toggledVpnGateServerVerdict(null, "works")).toBe("works");
    expect(toggledVpnGateServerVerdict("fails", "works")).toBe("works");
    expect(toggledVpnGateServerVerdict("works", "works")).toBeNull();
    expect(toggledVpnGateServerVerdict(null, "fails")).toBe("fails");
    expect(toggledVpnGateServerVerdict("works", "fails")).toBe("fails");
    expect(toggledVpnGateServerVerdict("fails", "fails")).toBeNull();
  });
});
