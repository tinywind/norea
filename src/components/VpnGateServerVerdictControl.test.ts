import { describe, expect, it } from "vitest";
import {
  nextVpnGateServerVerdict,
  vpnGateServerVerdictSymbol,
} from "./VpnGateServerVerdictControl";

describe("VpnGateServerVerdictControl", () => {
  it("cycles through unmarked, works, fails, and back to unmarked", () => {
    expect(nextVpnGateServerVerdict(null)).toBe("works");
    expect(nextVpnGateServerVerdict("works")).toBe("fails");
    expect(nextVpnGateServerVerdict("fails")).toBeNull();
  });

  it("renders one O, X, or blank mark for the three states", () => {
    expect(vpnGateServerVerdictSymbol(null)).toBe("");
    expect(vpnGateServerVerdictSymbol("works")).toBe("O");
    expect(vpnGateServerVerdictSymbol("fails")).toBe("X");
  });
});
