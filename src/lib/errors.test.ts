import { expect, it } from "vitest";
import { describeError, userFacingErrorKey } from "./errors";

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

it.each([
  ["scraper: browser fetch failed: Failed to fetch", "errors.network"],
  ["TypeError: NetworkError when attempting to fetch resource.", "errors.network"],
  ["net::ERR_NAME_NOT_RESOLVED", "errors.network"],
  ["content sync: upload stopped after sending 1 of 2 bytes in 120 s (attempt 2 of 2): request or response body error for url (https://server.test/api/v1/chapter-files)", "errors.network"],
  ["scraper: browser navigation timed out", "errors.timeout"],
  ["Cloudflare challenge: Just a moment...", "errors.siteAccess"],
  ["HTTP 403 Forbidden", "errors.siteAccess"],
  ["Plugin returned an invalid novel", "errors.generic"],
])("maps %s to a plain message key", (message, key) => {
  expect(userFacingErrorKey(new Error(message))).toBe(key);
});
