import { expect, it } from "vitest";
import { describeError } from "./errors";

it("retains the message from a serialized native worker rejection", () => {
  expect(describeError({
    code: "vpn-worker-runtime-error",
    message: "VPN download connection was cancelled or its profile was revoked",
  })).toBe("VPN download connection was cancelled or its profile was revoked");
});

it("keeps diagnostic fields when an object rejection has no message", () => {
  expect(describeError({ code: "database-error", detail: "Database is locked" }))
    .toBe('{"code":"database-error","detail":"Database is locked"}');
});

it.each([
  [new Error("Native request failed"), "Native request failed"],
  ["Request failed", "Request failed"],
  [null, "null"],
  [undefined, "undefined"],
])("preserves the existing description for %s", (error, expected) => {
  expect(describeError(error)).toBe(expected);
});

it("does not throw while describing a circular rejection", () => {
  const error: { cause?: unknown } = {};
  error.cause = error;
  expect(describeError(error)).toBe("[object Object]");
});
