import { describe, expect, it } from "vitest";
import { compareChapterInventories, isChapterPayloadInventory, type ChapterPayloadInventory } from "./inventory";

const digest = (value: string) => value.repeat(64);
const body = { sha256: digest("a"), bytes: 10 };
const asset = (key: string, hash = "b") => ({ key: `media/${key}`, sha256: digest(hash), bytes: 5 });
const inventory = (keys: string[] | null, assets: ReturnType<typeof asset>[], payload = body): ChapterPayloadInventory => ({ body: payload, expectedAssetKeys: keys?.map((key) => `media/${key}`) ?? null, storedAssets: assets });

describe("compareChapterInventories", () => {
  it("distinguishes equal partial coverage from actual containment", () => {
    const local = inventory(["a", "b", "c"], [asset("a"), asset("b")]);
    const remote = inventory(["a", "b", "c"], [asset("a"), asset("c")]);
    expect(compareChapterInventories(local, remote)).toEqual({ coverageEligible: true, containsLocal: false, coverageReason: null, containmentReason: null });
  });
  it("accepts complete and empty matching inventories", () => {
    for (const value of [inventory([], []), inventory(["a"], [asset("a")])]) {
      expect(compareChapterInventories(value, value)).toEqual({ coverageEligible: true, containsLocal: true, coverageReason: null, containmentReason: null });
    }
  });
  it("rejects coverage when the server has fewer valid assets", () => {
    const local = inventory(["a", "b"], [asset("a"), asset("b")]);
    const remote = inventory(["a", "b"], [asset("a")]);
    expect(compareChapterInventories(local, remote).coverageEligible).toBe(false);
    expect(compareChapterInventories(remote, local).containsLocal).toBe(true);
  });
  it("requires matching asset bytes for containment", () => {
    const result = compareChapterInventories(inventory(["a"], [asset("a")]), inventory(["a"], [asset("a", "c")]));
    expect(result.coverageEligible).toBe(true);
    expect(result.containsLocal).toBe(false);
    const differentSize = inventory(["a"], [{ ...asset("a"), bytes: 6 }]);
    expect(compareChapterInventories(inventory(["a"], [asset("a")]), differentSize).containsLocal).toBe(false);
  });
  it("rejects differing bodies and missing or different declarations for coverage", () => {
    const local = inventory(["a"], [asset("a")]);
    expect(compareChapterInventories(local, inventory(["a"], [], { ...body, sha256: digest("c") })).coverageReason).toBe("different-body");
    expect(compareChapterInventories(local, inventory(null, [])).coverageReason).toBe("missing-declarations");
    expect(compareChapterInventories(local, inventory(["b"], [])).coverageReason).toBe("different-declarations");
  });
  it("includes undeclared stored assets in containment but not coverage", () => {
    const local = inventory(["a"], [asset("a"), asset("extra")]);
    const remote = inventory(["a"], [asset("a")]);
    expect(compareChapterInventories(local, remote).coverageEligible).toBe(true);
    expect(compareChapterInventories(local, remote).containsLocal).toBe(false);
  });
  it("rejects untrusted unsafe and case-colliding keys", () => {
    expect(isChapterPayloadInventory({ body, expectedAssetKeys: ["media/../secret"], storedAssets: [] })).toBe(false);
    expect(isChapterPayloadInventory(inventory(["a", "A"], []))).toBe(false);
    expect(isChapterPayloadInventory(null)).toBe(false);
  });
  it("rejects malformed and duplicate inventory evidence", () => {
    const local = inventory(["a"], [asset("a")]);
    expect(compareChapterInventories(local, inventory(["a", "a"], [asset("a")])).coverageReason).toBe("invalid-inventory");
    expect(compareChapterInventories(local, inventory(["a"], [asset("a"), asset("a")])).containmentReason).toBe("invalid-inventory");
  });
});
