import { describe, expect, it } from "vitest";
import { parseTaskNotificationAction, parseTaskNotificationActions } from "./native-notification-actions";

const rangeAction = {
  type: "verifyVpnDownload", planId: "plan-a", sourceId: "source-a", rangeId: "range-a",
  profileId: "profile-a", generation: 7, checkpoint: 3,
};

describe("VPN notification action validation", () => {
  it("preserves the exact range owner but never accepts URLs or executable action data", () => {
    expect(parseTaskNotificationAction({ ...rangeAction, url: "https://untrusted.test", command: "run" }))
      .toEqual(rangeAction);
    expect(parseTaskNotificationActions(JSON.stringify([rangeAction, { type: "runScript", command: "run" }])))
      .toEqual([rangeAction]);
  });

  it.each(["planId", "sourceId", "rangeId", "profileId"])("rejects missing, oversized or control-bearing %s", key => {
    for (const value of [undefined, "", " ", "a".repeat(513), "bad\u0000id", 42]) {
      expect(parseTaskNotificationAction({ ...rangeAction, [key]: value })).toBeNull();
    }
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "7", null])("rejects invalid worker generation %s", generation => {
    expect(parseTaskNotificationAction({ ...rangeAction, generation })).toBeNull();
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3", null])("rejects invalid checkpoint %s", checkpoint => {
    expect(parseTaskNotificationAction({ ...rangeAction, checkpoint })).toBeNull();
  });

  it("bounds ordinary source actions while preserving their established shape", () => {
    const sourceAction = { type: "verifySource", sourceId: "source-a", scopeKey: "plugin:source-a:site:source.test", revision: 2 };
    expect(parseTaskNotificationAction(sourceAction)).toEqual(sourceAction);
    expect(parseTaskNotificationAction({ ...sourceAction, sourceId: "a".repeat(513) })).toBeNull();
    expect(parseTaskNotificationAction({ ...sourceAction, scopeKey: "a".repeat(2049) })).toBeNull();
  });
});
