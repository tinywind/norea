import { describe, expect, it } from "vitest";

import {
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

  it("uses a normalized hostname as the access scope", () => {
    expect(sourceAccessScopeKey("https://Source.Test:8443/chapter/1")).toBe(
      "site:source.test",
    );
  });
});
