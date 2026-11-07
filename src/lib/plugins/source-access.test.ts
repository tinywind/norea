import { describe, expect, it } from "vitest";

import {
  SourceAccessRequiredError,
  isSourceAccessRequiredError,
  normalizeSourceAccessRequiredError,
  sourceAccessErrorFromEnvelope,
  sourceAccessScopeKey,
} from "./source-access";

describe("source access challenges", () => {
  it("normalizes a recognized CAPTCHA envelope to a structural app error", () => {
    const error = sourceAccessErrorFromEnvelope(
      {
        ok: false,
        code: "manual-action-required",
        error: "Complete the CAPTCHA.",
        challenge: {
          kind: "captcha",
          url: "https://Source.Test/chapter/1?challenge=1",
        },
      },
      "https://source.test/chapter/1",
    );

    expect(isSourceAccessRequiredError(error)).toBe(true);
    expect(error).toMatchObject({
      code: "source-access-required",
      challenge: {
        kind: "captcha",
        url: "https://source.test/chapter/1?challenge=1",
      },
    });
  });

  it("falls back to the host-owned URL for a cross-host challenge URL", () => {
    const error = sourceAccessErrorFromEnvelope(
      {
        ok: false,
        code: "manual-action-required",
        error: "Complete the Cloudflare check.",
        challenge: {
          kind: "cloudflare",
          url: "https://attacker.test/redirect",
        },
      },
      "https://source.test/chapter/1",
    );

    expect(error).toMatchObject({
      code: "source-access-required",
      challenge: {
        kind: "cloudflare",
        url: "https://source.test/chapter/1",
      },
    });
  });

  it("keeps legacy manual actions generic when no challenge kind is supplied", () => {
    const error = sourceAccessErrorFromEnvelope(
      {
        ok: false,
        code: "manual-action-required",
        error: "Sign in to continue.",
      },
      "https://source.test/chapter/1",
    );

    expect(isSourceAccessRequiredError(error)).toBe(false);
    expect(error.message).toBe("manual-action-required: Sign in to continue.");
  });

  it("normalizes a transport Error thrown across the plugin boundary", () => {
    const transportError = Object.assign(new Error("cloudflare challenge"), {
      code: "manual-action-required",
      challenge: {
        kind: "cloudflare",
        url: "https://source.test/cdn-cgi/challenge-platform/",
      },
    });

    expect(
      normalizeSourceAccessRequiredError(
        transportError,
        "https://source.test/",
      ),
    ).toMatchObject({
      code: "source-access-required",
      message: "cloudflare challenge",
      challenge: {
        kind: "cloudflare",
        url: "https://source.test/cdn-cgi/challenge-platform/",
      },
    });
  });

  it("scopes access to a plugin and normalized hostname", () => {
    expect(sourceAccessScopeKey("https://Source.Test:8443/chapter/1", "source-a")).toBe(
      "plugin:source-a:site:source.test",
    );
    expect(sourceAccessScopeKey("https://Source.Test:8443/chapter/1", "source-b")).toBe(
      "plugin:source-b:site:source.test",
    );
  });

  it("retains a forbidden capture envelope as HTTP 403", () => {
    const error = sourceAccessErrorFromEnvelope({
      code: "manual-action-required",
      error: "HTTP 403: Forbidden",
      challenge: { kind: "forbidden", url: "https://source.test/chapter" },
    }, "https://source.test/");
    expect(error).toMatchObject({
      code: "source-access-required",
      message: "HTTP 403: Forbidden",
      challenge: { kind: "forbidden", url: "https://source.test/chapter" },
    });
  });

  it.each([
    "scraper: navigation failed (HTTP 403): Forbidden at https://source.test/chapter",
    new Error("scraper: navigation failed (HTTP 403): Forbidden at https://source.test/chapter"),
  ])("normalizes a native 403 while retaining its actual URL: %s", value => {
    expect(normalizeSourceAccessRequiredError(value)).toMatchObject({
      code: "source-access-required",
      challenge: { kind: "forbidden", url: "https://source.test/chapter" },
    });
  });

  it("uses the configured URL for a 403 without a URL or with an untrusted URL", () => {
    for (const message of [
      "HTTP 403: Forbidden",
      "Request failed: status code 403",
      "Failed to fetch (403)",
      "scraper: navigation failed (HTTP 403): Forbidden at https://other.test/chapter",
    ]) {
      expect(normalizeSourceAccessRequiredError(new Error(message), "https://source.test/trusted"))
        .toMatchObject({ challenge: { kind: "forbidden", url: "https://source.test/trusted" } });
    }
  });

  it("keeps a known HTTP 403 terminal even when a plugin calls it Cloudflare", () => {
    const error = new SourceAccessRequiredError("Cloudflare verification required (HTTP 403)", {
      kind: "cloudflare", url: "https://source.test/chapter",
    });
    expect(normalizeSourceAccessRequiredError(error)?.challenge.kind).toBe("forbidden");
  });

  it.each([
    ["HTTP 403: Forbidden", undefined],
    ["HTTP 403: Forbidden", "javascript:alert(1)"],
    ["HTTP 403: Forbidden", "https://user:secret@source.test/chapter"],
    ["scraper: navigation failed (HTTP 403): Forbidden at https://user:secret@source.test/chapter", undefined],
    ["scraper: navigation failed (HTTP 403): Forbidden at https://source.test/chapter", "file:///source"],
    ["scraper: navigation failed (HTTP 404): Not Found at https://source.test/HTTP403", "https://source.test/chapter"],
    ["scraper: timeout waiting for extraction after 35000ms", "https://source.test/chapter"],
  ])("does not invent a safe 403 challenge for %s and %s", (message, fallback) => {
    expect(normalizeSourceAccessRequiredError(new Error(message), fallback)).toBeNull();
  });

});
