import { describe, expect, it } from "vitest";
import { sourceAccessScopeKey } from "../lib/plugins/source-access";
import type { SourceAccessBlock } from "../lib/tasks/source-access-gate";
import { groupSourceAccessBanners } from "./source-access-groups";

function block(sourceId: string, url: string, rangeId?: string): SourceAccessBlock {
  return {
    challenge: { kind: "forbidden", url },
    detectedAt: 1, revision: sourceId === "source-a" ? 3 : 5,
    scopeKey: sourceAccessScopeKey(url, sourceId, rangeId), sourceId,
    verificationRequested: false,
    ...(rangeId ? { rangeId, workerGeneration: 1 } : {}),
  };
}

describe("source access warning groups", () => {
  it("shares an ordinary HTTP 403 warning by normalized origin while preserving both exact scopes", () => {
    const a = block("source-a", "https://SOURCE.test.:443/first?chapter=1");
    const b = block("source-b", "https://source.test/second");
    const blocks = [a, b];
    const before = JSON.stringify(blocks);
    const groups = groupSourceAccessBanners(blocks);

    expect(groups).toHaveLength(1);
    expect(groups[0].blocks).toHaveLength(2);
    expect(groups[0].blocks[0]).toBe(a);
    expect(groups[0].blocks[1]).toBe(b);
    expect(groups[0].blocks.map(value => [value.scopeKey, value.revision])).toEqual([
      [a.scopeKey, 3], [b.scopeKey, 5],
    ]);
    expect(JSON.stringify(blocks)).toBe(before);
  });

  it.each([
    ["protocol", block("source-b", "http://source.test/second")],
    ["port", block("source-b", "https://source.test:8443/second")],
    ["host", block("source-b", "https://other.test/second")],
    ["CAPTCHA", { ...block("source-b", "https://source.test"), challenge: { kind: "captcha" as const, url: "https://source.test" } }],
    ["Cloudflare", { ...block("source-b", "https://source.test"), challenge: { kind: "cloudflare" as const, url: "https://source.test" } }],
    ["VPN range", block("source-b", "https://source.test", "range-b")],
    ["invalid URL", { ...block("source-b", "https://source.test"), challenge: { kind: "forbidden" as const, url: "not-a-url" } }],
    ["non-HTTP URL", { ...block("source-b", "https://source.test"), challenge: { kind: "forbidden" as const, url: "ftp://source.test" } }],
  ])("keeps a different %s outside the ordinary HTTP 403 group", (_, other) => {
    const a = block("source-a", "https://source.test/first");
    expect(groupSourceAccessBanners([a, other]).map(group => group.blocks)).toEqual([[a], [other]]);
  });

  it("keeps VPN workers separate even when they share a plugin and origin", () => {
    const a = block("source-a", "https://source.test", "range-a");
    const b = block("source-a", "https://source.test", "range-b");
    expect(groupSourceAccessBanners([a, b]).map(group => group.blocks)).toEqual([[a], [b]]);
  });

  it("does not merge separate CAPTCHA scopes on the same origin", () => {
    const a = { ...block("source-a", "https://source.test"), challenge: { kind: "captcha" as const, url: "https://source.test" } };
    const b = { ...block("source-b", "https://source.test"), challenge: { kind: "captcha" as const, url: "https://source.test" } };
    expect(groupSourceAccessBanners([a, b]).map(group => group.blocks)).toEqual([[a], [b]]);
  });
});
