import { describe, expect, it } from "vitest";
import type { SourceAccessBlock } from "../lib/tasks/scheduler";
import {
  completeAutoOpenSourceAccessAttempt,
  nextAutoOpenSourceAccessBlock,
} from "./TaskNotifications";

function accessBlock(): SourceAccessBlock {
  return {
    challenge: {
      kind: "captcha",
      url: "https://source.test/chapter/1",
    },
    detectedAt: 1,
    revision: 1,
    scopeKey: "site:source.test",
    sourceIds: ["source-a"],
    verificationRequested: false,
  };
}

describe("nextAutoOpenSourceAccessBlock", () => {
  it("keeps a new block pending until its origin task is queued", () => {
    const block = accessBlock();
    const knownScopes = new Set<string>();
    const pendingScopes = new Set<string>();
    let canBegin = false;

    expect(
      nextAutoOpenSourceAccessBlock(
        [block],
        knownScopes,
        pendingScopes,
        () => canBegin,
      ),
    ).toBeUndefined();
    expect(pendingScopes).toEqual(new Set([block.scopeKey]));

    canBegin = true;
    expect(
      nextAutoOpenSourceAccessBlock(
        [block],
        knownScopes,
        pendingScopes,
        () => canBegin,
      ),
    ).toBe(block);
  });

  it("keeps a block pending after a transient browser open failure", () => {
    const scopeKey = "site:source.test";
    const pendingScopes = new Set([scopeKey]);
    const inFlightScopes = new Set([scopeKey]);

    completeAutoOpenSourceAccessAttempt(
      scopeKey,
      false,
      pendingScopes,
      inFlightScopes,
    );

    expect(pendingScopes).toEqual(new Set([scopeKey]));
    expect(inFlightScopes).toEqual(new Set());

    inFlightScopes.add(scopeKey);
    completeAutoOpenSourceAccessAttempt(
      scopeKey,
      true,
      pendingScopes,
      inFlightScopes,
    );

    expect(pendingScopes).toEqual(new Set());
    expect(inFlightScopes).toEqual(new Set());
  });
});
