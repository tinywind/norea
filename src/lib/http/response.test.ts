import { describe, expect, it } from "vitest";
import { checkedResponseFromWire } from "./response";

describe("source HTTP 403 responses", () => {
  it.each<Record<string, string>>([{}, { "cf-mitigated": "challenge" }])("preserves 403 as a terminal source access hold for %s", async headers => {
    await expect(checkedResponseFromWire({
      status: 403, statusText: "Forbidden", headers,
      finalUrl: "https://source.test/chapter/1", body: "Access denied",
    }, "https://source.test/chapter/1", "https://source.test/chapter/1"))
      .rejects.toMatchObject({
        code: "source-access-required", message: expect.stringContaining("HTTP 403"),
        challenge: { kind: "forbidden", url: "https://source.test/chapter/1" },
      });
  });

  it("keeps a refused media host scoped to the owning source", async () => {
    await expect(checkedResponseFromWire({
      status: 403, statusText: "Forbidden", headers: {}, finalUrl: "https://cdn.test/page.png", body: "",
    }, "https://cdn.test/page.png", "https://source.test/chapter/1"))
      .rejects.toMatchObject({ challenge: { kind: "forbidden", url: "https://source.test/chapter/1" } });
  });

  it.each([200, 503])("retains Cloudflare verification for a non-403 source response (HTTP %s)", async status => {
    await expect(checkedResponseFromWire({
      status, statusText: status === 200 ? "OK" : "Service Unavailable",
      headers: { "cf-mitigated": "challenge" },
      finalUrl: "https://source.test/challenge", body: "",
    }, "https://source.test/chapter/1", "https://source.test/chapter/1"))
      .rejects.toMatchObject({
        code: "source-access-required",
        challenge: { kind: "cloudflare", url: "https://source.test/challenge" },
      });
  });
});
