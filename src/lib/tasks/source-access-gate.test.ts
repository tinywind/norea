import { expect, it } from "vitest";
import { SourceAccessGate } from "./source-access-gate";

it("restores a forbidden block only for its exact plugin and VPN range", () => {
  const gate = new SourceAccessGate();
  gate.recordChallenge(
    "plugin:source-a:site:source.test:range:range-a",
    { kind: "forbidden", url: "https://source.test/chapter" },
    { sourceId: "source-a", rangeId: "range-a", workerGeneration: 3, taskId: "chapter", taskKey: "chapter:1" },
    "HTTP 403",
  );
  const restored = new SourceAccessGate();
  restored.hydrate(JSON.parse(JSON.stringify(gate.snapshot())));
  expect(restored.isBlocked("source-a", "range-a")).toBe(true);
  expect(restored.isBlocked("source-a", "range-b")).toBe(false);
  expect(restored.isBlocked("source-a")).toBe(false);
  expect(restored.isBlocked("source-b", "range-a")).toBe(false);
  expect(restored.snapshot()[0]).toMatchObject({
    challenge: { kind: "forbidden", url: "https://source.test/chapter" },
    rangeId: "range-a", workerGeneration: 3, verificationRequested: false,
  });
});
