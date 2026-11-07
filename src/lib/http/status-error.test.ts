import { describe, expect, it } from "vitest";
import { errorHttpStatus, HttpStatusError, isHttpNotFoundError } from "./status-error";

describe("HTTP failure status", () => {
  it.each([new HttpStatusError(404, "Missing resource"), "HTTP 404 Not Found", new Error("Request failed with status code 404"), new Error("Failed to fetch novel data: (404)")])("recognizes a missing HTTP resource: %s", error => {
    expect(isHttpNotFoundError(error)).toBe(true);
  });
  it.each([new Error("HTTP 503 at https://source.test/chapter/404"), new Error("Not found at https://source.test/HTTP404"), new Error("database error: (404)"), {code:"chapter-storage-failed", message:"Failed to write file (404)"}, new Error("content-not-found: selector missing"), new Error("HTTP 403"), new Error("request timeout")])("never skips a different failure: %s", error => {
    expect(isHttpNotFoundError(error)).toBe(false);
  });
  it("skips an incomplete chapter only when every missing asset returned404", () => {
    expect(isHttpNotFoundError({code:"chapter-media-incomplete", failures:[{status:404},{status:404}]})).toBe(true);
    expect(isHttpNotFoundError({code:"chapter-media-incomplete", failures:[{status:404},{status:503}]})).toBe(false);
    expect(isHttpNotFoundError({code:"chapter-storage-failed", message:"HTTP 404 while writing"})).toBe(false);
    expect(isHttpNotFoundError(new DOMException("HTTP 404 while cancelling","AbortError"))).toBe(false);
  });
  it("preserves other HTTP statuses", () => {
    expect(errorHttpStatus({status:429, message:"Rate limited"})).toBe(429);
    expect(errorHttpStatus(new Error("HTTP 503 at https://source.test/404"))).toBe(503);
  });
});
