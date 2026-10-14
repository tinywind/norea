import { describe, expect, it } from "vitest";
import { nextVpnGateServerVerdict } from "./VpnGateServerVerdictControl";

describe("VpnGateServerVerdictControl", () => {
  it("cycles through unmarked, works, fails, and back to unmarked", () => {
    expect(nextVpnGateServerVerdict(null)).toBe("works");
    expect(nextVpnGateServerVerdict("works")).toBe("fails");
    expect(nextVpnGateServerVerdict("fails")).toBeNull();
  });
});
